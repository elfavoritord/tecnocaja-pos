'use strict';

const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { buildQrVerificationUrl } = require('../utils/qr-url.util');

const ECF_TYPE_LABELS = {
  '31': 'Factura de Crédito Fiscal Electrónica',
  '32': 'Factura de Consumo Electrónica',
  '33': 'Nota de Débito Electrónica',
  '34': 'Nota de Crédito Electrónica',
  '41': 'Comprobante para Compras Electrónico',
  '43': 'Comprobante para Gastos Menores Electrónico',
  '44': 'Comprobante para Regímenes Especiales Electrónico',
  '45': 'Comprobante para Gubernamentales Electrónico',
  '46': 'Comprobante para Exportaciones Electrónico',
  '47': 'Comprobante para Pagos al Exterior Electrónico',
};

const UNIDADES_MEDIDA = {
  '1': 'Barril', '2': 'Bolsa', '3': 'Bote', '4': 'Bulto', '5': 'Botella', '6': 'Caja/Cajón',
  '7': 'Cajetilla', '8': 'Centímetro', '9': 'Cilindro', '10': 'Conjunto', '11': 'Contenedor',
  '12': 'Día', '13': 'Docena', '14': 'Fardo', '15': 'Galón', '16': 'Grado', '17': 'Gramo',
  '18': 'Granel', '19': 'Hora', '20': 'Huacal', '21': 'Kilogramo', '22': 'Kilovatio hora',
  '23': 'Libra', '24': 'Litro', '25': 'Lote', '26': 'Metro', '27': 'Metro cuadrado',
  '28': 'Metro cúbico', '29': 'Millones de unidades térmicas', '30': 'Minuto', '31': 'Paquete',
  '32': 'Par', '33': 'Pie', '34': 'Pieza', '35': 'Rollo', '36': 'Sobre', '37': 'Segundo',
  '38': 'Tanque', '39': 'Tonelada', '40': 'Tubo', '41': 'Yarda', '42': 'Yarda cuadrada',
  '43': 'Unidad', '44': 'Elemento', '45': 'Millar', '46': 'Saco', '47': 'Lata', '48': 'Display',
  '49': 'Bidón', '50': 'Ración', '51': 'Quintal', '52': 'Tonelada de registro bruto',
  '53': 'Pie cuadrado', '54': 'Pasajero', '55': 'Pulgada', '56': 'Parqueo de barco en muelle',
  '57': 'Bandeja', '58': 'Hectárea', '59': 'Mililitro', '60': 'Miligramo', '61': 'Onza', '62': 'Onza troy',
};

const OTROS_IMPUESTOS = {
  '001': 'Propina legal', '002': 'CDT', '003': 'Servicios de seguros',
  '004': 'Servicios de telecomunicaciones', '005': 'Impuesto de primera placa',
};

function num(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isSelectivo(code) {
  const n = Number(code);
  return (n >= 6 && n <= 39);
}

function xmlSection(xml, tag) {
  return (String(xml || '').match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')) || [])[1] || '';
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

let provinciaMunicipioCatalog;
function domicilioLabel(value) {
  const raw = String(value || '').trim();
  if (!raw || !/^\d{6}$/.test(raw)) return raw;
  if (!provinciaMunicipioCatalog) {
    provinciaMunicipioCatalog = new Map();
    try {
      const schemaPath = path.resolve(__dirname, '../../../e-CF 31 v.1.0.xsd');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      const section = schema.match(/<xs:simpleType name="ProvinciaMunicipioType">([\s\S]*?)<\/xs:simpleType>/i)?.[1] || '';
      const rows = section.matchAll(/<xs:enumeration value\s*=\s*"([^"]+)"\s*\/>\s*<!--([^>]*)-->/gi);
      for (const row of rows) provinciaMunicipioCatalog.set(row[1], row[2].trim().replace(/\s+/g, ' '));
    } catch (_error) {
      // Mantener el comprobante imprimible si el paquete de despliegue no trae el XSD.
    }
  }
  return (provinciaMunicipioCatalog.get(raw) || raw).replace(/^(?:MUNICIPIO|PROVINCIA)\s+/i, '');
}

function calculateItemTaxes(item, doc) {
  const amount = num(item.monto);
  const quantity = num(item.cantidad) || 1;
  const referenceQuantity = num(item.cantidadReferencia) || 1;
  const facturationRate = num(doc.itbisRates[item.indicadorFacturacion]);
  let iscSpecific = 0;
  let iscAdvalorem = 0;

  for (const code of item.taxCodes) {
    const tax = doc.additionalTaxes.find((entry) => entry.code === code);
    if (!tax) continue;
    const n = Number(code);
    if (n >= 6 && n <= 18 && item.gradosAlcohol) {
      const subquantity = item.subquantities.reduce((sum, value) => sum + value, 0) || 1;
      iscSpecific += tax.rate * (num(item.gradosAlcohol) / 100) * referenceQuantity * subquantity * quantity;
    } else if (n >= 19 && n <= 22) {
      iscSpecific += tax.rate * referenceQuantity * quantity;
    }
  }

  for (const code of item.taxCodes) {
    const tax = doc.additionalTaxes.find((entry) => entry.code === code);
    if (!tax) continue;
    const n = Number(code);
    if (n >= 23 && n <= 35) {
      if (String(item.unidad) === '18') {
        iscAdvalorem += num(item.precioUnit) * 1.3 * (tax.rate / 100) * quantity;
      } else {
        const pvp = num(item.precioReferencia);
        const itbisFactor = 1 + (facturationRate / 100);
        const specificPerUnit = quantity * referenceQuantity ? iscSpecific / (quantity * referenceQuantity) : 0;
        const beforeAdvalorem = (pvp / itbisFactor) - specificPerUnit;
        iscAdvalorem += Math.max(0, (beforeAdvalorem / (1 + tax.rate / 100))
          * quantity * referenceQuantity * (tax.rate / 100));
      }
    } else if (n >= 36 && n <= 39) {
      const pvp = num(item.precioReferencia);
      const itbisFactor = 1 + (facturationRate / 100);
      const specificPerUnit = quantity * referenceQuantity ? iscSpecific / (quantity * referenceQuantity) : 0;
      const beforeAdvalorem = (pvp / itbisFactor) - specificPerUnit;
      iscAdvalorem += Math.max(0, (beforeAdvalorem / (1 + tax.rate / 100))
        * quantity * referenceQuantity * (tax.rate / 100));
    }
  }

  // MontoItem representa el valor antes de ITBIS. El ISC que forma parte de la
  // base gravada también se suma antes de calcular el ITBIS de la línea.
  const hasRate = facturationRate > 0 && Number(item.indicadorFacturacion) >= 1 && Number(item.indicadorFacturacion) <= 3;
  const itbisBase = amount + iscSpecific + iscAdvalorem;
  const itbis = !hasRate
    ? 0
    : (doc.indicadorMontoGravado === '1'
      ? roundMoney(amount - (amount / (1 + facturationRate / 100)))
      : roundMoney(itbisBase * (facturationRate / 100)));
  return {
    iscSpecific: roundMoney(iscSpecific),
    iscAdvalorem: roundMoney(iscAdvalorem),
    itbis,
  };
}

function xmlText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function xmlAll(xml, tag) {
  const results = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1]);
  return results;
}

function parseEcfXml(xml) {
  // El XML firmado siempre trae la declaración <?xml ...?> antes de la raíz,
  // así que hay que quitarla antes de probar si la raíz es <RFCE> — de lo
  // contrario esta prueba nunca coincide y todo RFCE se trata como no-RFCE,
  // generando un QR que apunta al portal equivocado (ecf.dgii.gov.do en vez
  // de fc.dgii.gov.do/ConsultaTimbreFC) y DGII responde "No fue encontrada
  // la factura (e-CF)" al escanearlo.
  const xmlSinDeclaracion = xml.trim().replace(/^<\?xml[^>]*\?>\s*/i, '');
  const isRfce = /^<RFCE[\s>]/i.test(xmlSinDeclaracion);
  const encabezado = xmlSection(xml, 'Encabezado');
  const idDoc = xmlSection(encabezado, 'IdDoc');
  const emisor = xmlSection(encabezado, 'Emisor');
  const comprador = xmlSection(encabezado, 'Comprador');
  const totales = xmlSection(encabezado, 'Totales');
  const impuestosAdicionales = xmlSection(totales, 'ImpuestosAdicionales');
  const referencia = (xml.match(/<InformacionReferencia>([\s\S]*?)<\/InformacionReferencia>/i) || [])[1] || '';
  const itemsSection = (xml.match(/<DetallesItems>([\s\S]*?)<\/DetallesItems>/i) || [])[1] || '';
  const paginacion = xmlSection(xml, 'Paginacion');
  const ajustesGlobales = xmlSection(xml, 'DescuentosORecargos');

  const items = xmlAll(itemsSection, 'Item').map((itemXml) => {
    const taxTable = xmlSection(itemXml, 'TablaImpuestoAdicional');
    const subquantityTable = xmlSection(itemXml, 'TablaSubcantidad');
    return {
      linea: xmlText(itemXml, 'NumeroLinea'),
      nombre: xmlText(itemXml, 'NombreItem'),
      descripcion: xmlText(itemXml, 'DescripcionItem'),
      indicadorFacturacion: xmlText(itemXml, 'IndicadorFacturacion'),
      cantidad: xmlText(itemXml, 'CantidadItem'),
      unidad: xmlText(itemXml, 'UnidadMedida'),
      cantidadReferencia: xmlText(itemXml, 'CantidadReferencia'),
      unidadReferencia: xmlText(itemXml, 'UnidadReferencia'),
      gradosAlcohol: xmlText(itemXml, 'GradosAlcohol'),
      precioReferencia: xmlText(itemXml, 'PrecioUnitarioReferencia'),
      precioUnit: xmlText(itemXml, 'PrecioUnitarioItem'),
      descuento: xmlText(itemXml, 'DescuentoMonto'),
      recargo: xmlText(itemXml, 'RecargoMonto'),
      monto: xmlText(itemXml, 'MontoItem'),
      taxCodes: xmlAll(taxTable, 'ImpuestoAdicional').map((entry) => xmlText(entry, 'TipoImpuesto')),
      subquantities: xmlAll(subquantityTable, 'SubcantidadItem').map((entry) => num(xmlText(entry, 'Subcantidad'))),
    };
  });

  const sigVal = ((xml.match(/<SignatureValue[^>]*>([^<]+)<\/SignatureValue>/i) || [])[1] || '').trim();
  const codigoSeguridadRfce = xmlText(encabezado, 'CodigoSeguridadeCF');
  const additionalTaxes = xmlAll(impuestosAdicionales, 'ImpuestoAdicional').map((entry) => ({
    code: xmlText(entry, 'TipoImpuesto'),
    rate: num(xmlText(entry, 'TasaImpuestoAdicional')),
    specific: num(xmlText(entry, 'MontoImpuestoSelectivoConsumoEspecifico')),
    advalorem: num(xmlText(entry, 'MontoImpuestoSelectivoConsumoAdvalorem')),
    other: num(xmlText(entry, 'OtrosImpuestosAdicionales')),
  }));
  const pages = xmlAll(paginacion, 'Pagina').map((entry) => {
    const pageAdditional = xmlSection(entry, 'SubtotalImpuestoAdicional');
    return {
      number: xmlText(entry, 'PaginaNo'),
      fromLine: xmlText(entry, 'NoLineaDesde'),
      toLine: xmlText(entry, 'NoLineaHasta'),
      taxable: xmlText(entry, 'SubtotalMontoGravadoPagina'),
      taxable1: xmlText(entry, 'SubtotalMontoGravado1Pagina'),
      taxable2: xmlText(entry, 'SubtotalMontoGravado2Pagina'),
      taxable3: xmlText(entry, 'SubtotalMontoGravado3Pagina'),
      exempt: xmlText(entry, 'SubtotalExentoPagina'),
      itbis: xmlText(entry, 'SubtotalItbisPagina'),
      itbis1: xmlText(entry, 'SubtotalItbis1Pagina'),
      itbis2: xmlText(entry, 'SubtotalItbis2Pagina'),
      itbis3: xmlText(entry, 'SubtotalItbis3Pagina'),
      additional: xmlText(entry, 'SubtotalImpuestoAdicionalPagina'),
      specific: xmlText(pageAdditional, 'SubtotalImpuestoSelectivoConsumoEspecificoPagina'),
      other: xmlText(pageAdditional, 'SubtotalOtrosImpuesto'),
      total: xmlText(entry, 'MontoSubtotalPagina'),
    };
  });
  const globalAdjustments = xmlAll(ajustesGlobales, 'DescuentoORecargo').map((entry) => ({
    type: xmlText(entry, 'TipoAjuste'),
    description: xmlText(entry, 'DescripcionDescuentooRecargo'),
    valueType: xmlText(entry, 'TipoValor'),
    value: xmlText(entry, 'ValorDescuentooRecargo'),
    amount: xmlText(entry, 'MontoDescuentooRecargo'),
  }));

  return {
    isRfce,
    tipoEcf: xmlText(idDoc, 'TipoeCF'),
    encf: xmlText(idDoc, 'eNCF'),
    indicadorEnvioDiferido: xmlText(idDoc, 'IndicadorEnvioDiferido'),
    indicadorMontoGravado: xmlText(idDoc, 'IndicadorMontoGravado'),
    totalPaginas: xmlText(idDoc, 'TotalPaginas'),
    pages,
    fechaEmision: xmlText(emisor, 'FechaEmision'),
    fechaVencimiento: xmlText(idDoc, 'FechaVencimientoSecuencia'),
    limitePago: xmlText(idDoc, 'FechaLimitePago'),
    fechaHoraFirma: xmlText(xml, 'FechaHoraFirma'),
    rncEmisor: xmlText(emisor, 'RNCEmisor'),
    razonSocial: xmlText(emisor, 'RazonSocialEmisor'),
    nombreComercial: xmlText(emisor, 'NombreComercial'),
    direccion: xmlText(emisor, 'DireccionEmisor'),
    sucursal: xmlText(emisor, 'Sucursal'),
    municipio: xmlText(emisor, 'Municipio'),
    provincia: xmlText(emisor, 'Provincia'),
    telefonos: xmlAll(emisor, 'TelefonoEmisor'),
    correo: xmlText(emisor, 'CorreoEmisor'),
    web: xmlText(emisor, 'WebSite'),
    numFacturaInterna: xmlText(emisor, 'NumeroFacturaInterna'),
    rncComprador: xmlText(comprador, 'RNCComprador'),
    razonSocialComprador:
      xmlText(comprador, 'RazonSocialComprador') ||
      xmlText(comprador, 'NombreConsumidor') ||
      'Consumidor Final',
    direccionComprador: xmlText(comprador, 'DireccionComprador'),
    contacto: xmlText(comprador, 'ContactoComprador'),
    montoTotal: xmlText(totales, 'MontoTotal'),
    montoExento: xmlText(totales, 'MontoExento'),
    montoGravado1: xmlText(totales, 'MontoGravadoI1'),
    montoGravado2: xmlText(totales, 'MontoGravadoI2'),
    montoGravado3: xmlText(totales, 'MontoGravadoI3'),
    montoGravadoTotal: xmlText(totales, 'MontoGravadoTotal'),
    totalItbis1: xmlText(totales, 'TotalITBIS1'),
    totalItbis2: xmlText(totales, 'TotalITBIS2'),
    totalItbis3: xmlText(totales, 'TotalITBIS3'),
    totalItbis: xmlText(totales, 'TotalITBIS'),
    itbisRates: {
      '1': num(xmlText(totales, 'ITBIS1')),
      '2': num(xmlText(totales, 'ITBIS2')),
      '3': num(xmlText(totales, 'ITBIS3')),
    },
    montoImpuestoAdicional: xmlText(totales, 'MontoImpuestoAdicional'),
    additionalTaxes,
    globalAdjustments,
    ncfModificado: xmlText(referencia, 'NCFModificado'),
    codigoModificacion: xmlText(referencia, 'CodigoModificacion'),
    fechaNcfModificado: xmlText(referencia, 'FechaNCFModificado'),
    items,
    codigoSeguridad: isRfce ? codigoSeguridadRfce : sigVal.slice(0, 6),
  };
}

function fmt(n) {
  const v = parseFloat(String(n || '').replace(',', '.') || '0');
  if (isNaN(v)) return '0.00';
  return v.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatSignatureDate(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  if (match) return `${match[3]}-${match[2]}-${match[1]} ${match[4]}`;
  return raw;
}

function codigoModificacionLabel(code) {
  return ({
    '1': 'Anula el NCF modificado',
    '2': 'Corrige texto del comprobante fiscal modificado',
    '3': 'Corrige montos del NCF modificado',
    '4': 'Reemplazo de NCF emitido en contingencia',
  })[String(code || '').trim()] || String(code || '').trim();
}

async function generateReprImpresaHtml(signedXml, opts = {}) {
  const d = parseEcfXml(signedXml);
  const rfceSummary = opts.rfceSummaryXml ? parseEcfXml(opts.rfceSummaryXml) : null;
  if (rfceSummary) {
    if (!rfceSummary.isRfce) {
      throw new Error('El XML vinculado como RFCE no tiene raíz <RFCE>.');
    }
    if (d.isRfce || d.tipoEcf !== '32') {
      throw new Error('La representación de un RFCE requiere el e-CF completo Tipo 32 vinculado.');
    }
    if (!d.encf || d.encf !== rfceSummary.encf) {
      throw new Error(`El e-NCF del E32 (${d.encf || 'ausente'}) no coincide con el RFCE (${rfceSummary.encf || 'ausente'}).`);
    }
    if (!d.codigoSeguridad || d.codigoSeguridad !== rfceSummary.codigoSeguridad) {
      throw new Error(`El código de seguridad del E32 ${d.encf} no coincide con su RFCE.`);
    }
    if (d.rncEmisor && rfceSummary.rncEmisor && d.rncEmisor !== rfceSummary.rncEmisor) {
      throw new Error(`El RNC emisor del E32 ${d.encf} no coincide con su RFCE.`);
    }
    const fullAmount = Number(d.montoTotal);
    const summaryAmount = Number(rfceSummary.montoTotal);
    if (Number.isFinite(fullAmount) && Number.isFinite(summaryAmount) && Math.abs(fullAmount - summaryAmount) > 0.01) {
      throw new Error(`El monto total del E32 ${d.encf} no coincide con su RFCE.`);
    }
  }
  const isRfceRepresentation = d.isRfce || Boolean(rfceSummary);
  const qrData = rfceSummary || d;
  const typeLabel = ECF_TYPE_LABELS[d.tipoEcf] || `Comprobante Electrónico Tipo ${d.tipoEcf}`;
  const codigoSeguridad = qrData.codigoSeguridad || '------';
  const env = opts.env || 'certecf';

  // opts.emitter permite sobreescribir los datos del emisor del XML con los
  // datos reales configurados (RNC, RazonSocial, NombreComercial, etc.).
  // Requerido por DGII Norma General 06-2018: la RI debe mostrar la razón
  // social tal como figura en el RNC del contribuyente, no datos del set de pruebas.
  const emitterOverride = opts.emitter || null;
  const issuerRnc = emitterOverride?.rnc || d.rncEmisor || '';
  const issuerRazonSocial = emitterOverride?.razon_social || d.razonSocial || '';
  const issuerNombreComercial = emitterOverride
    ? (emitterOverride.nombre_comercial ?? '')
    : d.nombreComercial || '';
  const issuerDireccion = emitterOverride?.direccion || d.direccion || '';
  const issuerTelefonos = emitterOverride?.telefono
    ? [emitterOverride.telefono].filter(Boolean)
    : d.telefonos.filter(Boolean);
  const issuerCorreo = emitterOverride?.correo || d.correo || '';
  const issuerName = issuerNombreComercial || issuerRazonSocial || 'TECNO CAJA';

  // opts.buyer permite sobreescribir la Razón Social del comprador con el
  // nombre REAL registrado en el padrón RNC de DGII (mismo principio de la
  // Norma General 06-2018 aplicado al emisor arriba). El set de pruebas de
  // certificación reutiliza un mismo RNC comprador en varios comprobantes con
  // nombres inconsistentes entre sí (ej. RNC 131880681 aparece como "DE 02",
  // "DE 03", "DE 04" y "ZONA FRANCA LOI" en distintos documentos) — DGII marcó
  // esto en el log del Paso 5 ("revisar la Razón Social... del comprador").
  const buyerRazonSocial = opts.buyer?.razon_social || d.razonSocialComprador;

  const fechaFirma = d.fechaHoraFirma || d.fechaEmision || '';
  const fechaFirmaImpresion = formatSignatureDate(fechaFirma);
  const municipio = domicilioLabel(opts.emitter?.municipio || d.municipio || '');
  const provincia = domicilioLabel(opts.emitter?.provincia || d.provincia || '');
  const deferred = d.indicadorEnvioDiferido === '1' || opts.modality === 'diferido';
  const contingency = opts.modality === 'contingencia';
  const modalityNote = deferred
    ? 'e-CF emitido en modalidad Envío Diferido, podrá ser consultado para su validez fiscal, a partir de las veinticuatro (24) horas.'
    : contingency
      ? 'e-CF emitido en modalidad de Contingencia, el cual podrá ser consultado para su validez fiscal, a partir de las setenta y dos (72) horas.'
      : '';

  // Una sola construcción para la RI, el POS y el QR guardado en ventas.
  // La URL siempre se deriva del XML firmado real; para consumo < RD$250,000
  // el XML resumen RFCE es la fuente oficial del QR.
  const qrSourceXml = rfceSummary ? opts.rfceSummaryXml : signedXml;
  const qrUrl = buildQrVerificationUrl(qrSourceXml, env);
  if (!qrUrl) throw new Error('No se pudo construir la URL DGII del QR desde el XML firmado.');

  const qrDataUrl = await QRCode.toDataURL(qrUrl, {
    width: 512,
    margin: 4,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#FFFFFF' },
  });
  const branchLine = d.sucursal ? `Sucursal: ${d.sucursal}` : (d.numFacturaInterna ? `Punto de emisión: ${d.numFacturaInterna}` : '');
  const referenceBlock = d.ncfModificado
    ? `<div class="reference-line"><strong>e-NCF Modificado:</strong> ${escapeHtml(d.ncfModificado)}${d.codigoModificacion ? ` &nbsp; <strong>Código de Modificación:</strong> ${escapeHtml(codigoModificacionLabel(d.codigoModificacion))}` : ''}${d.fechaNcfModificado ? ` &nbsp; <strong>Fecha:</strong> ${escapeHtml(d.fechaNcfModificado)}` : ''}</div>`
    : '';

  const hasAlcohol = d.items.some((item) => Number(item.gradosAlcohol) > 0);
  const hasPvp = d.items.some((item) => Number(item.precioReferencia) > 0);
  const hasIsc = d.items.some((item) => item.taxCodes.some(isSelectivo));
  const hasDiscount = d.items.some((item) => Number(item.descuento) !== 0);
  const hasSurcharge = d.items.some((item) => Number(item.recargo) !== 0);
  const extraColumns = [
    ...(hasAlcohol ? [{ key: 'gradosAlcohol', label: 'Grados Alcohol<br>en %', width: '45px' }] : []),
    ...(hasPvp ? [{ key: 'precioReferencia', label: 'PVPci', width: '60px' }] : []),
    ...(hasIsc ? [{ key: 'iscSpecific', label: 'ISC e', width: '62px' }, { key: 'iscAdvalorem', label: 'ISCaV', width: '62px' }] : []),
    ...(hasDiscount ? [{ key: 'descuento', label: 'Descuento', width: '62px' }] : []),
    ...(hasSurcharge ? [{ key: 'recargo', label: 'Recargo', width: '62px' }] : []),
  ];
  const itemTaxRows = d.items.map((item) => ({ ...item, taxAmounts: calculateItemTaxes(item, d) }));
  const renderItemsTable = (rows) => rows.length > 0
    ? `<table class="items-table"><thead><tr>
        <th style="width:58px">Cantidad</th><th>Descripción</th><th style="width:74px">Unidad de<br>Medida</th>
        ${extraColumns.map((col) => `<th style="width:${col.width}">${col.label}</th>`).join('')}
        <th style="width:76px">Precio</th><th style="width:70px">ITBIS</th><th style="width:78px">Valor</th>
      </tr></thead><tbody>
        ${rows.map((item) => `<tr>
          <td class="num">${escapeHtml(item.cantidad || '1')}</td>
          <td>${Number(item.indicadorFacturacion) === 4 ? 'E ' : ''}${escapeHtml(item.nombre)}${item.descripcion ? `<div class="item-meta">${escapeHtml(item.descripcion)}</div>` : ''}</td>
          <td class="center">${escapeHtml(UNIDADES_MEDIDA[item.unidad] || item.unidad || '')}</td>
          ${extraColumns.map((col) => {
            const value = col.key === 'iscSpecific' || col.key === 'iscAdvalorem'
              ? item.taxAmounts[col.key]
              : item[col.key];
            return `<td class="num">${col.key === 'gradosAlcohol' ? (value ? `${fmt(value)}%` : '') : (Number(value) ? fmt(value) : '')}</td>`;
          }).join('')}
          <td class="num">${fmt(item.precioUnit)}</td><td class="num">${fmt(item.taxAmounts.itbis)}</td><td class="num">${fmt(item.monto)}</td>
        </tr>`).join('')}
      </tbody></table>`
    : '<div class="empty-items">Sin detalle de ítems en el XML usado para esta representación.</div>';

  const taxableTotal = num(d.montoGravado1) + num(d.montoGravado2) + num(d.montoGravado3)
    || num(d.montoGravadoTotal);
  const totalItbis = num(d.totalItbis) || num(d.totalItbis1) + num(d.totalItbis2) + num(d.totalItbis3);
  const iscTotal = d.additionalTaxes.reduce((sum, tax) => sum + (isSelectivo(tax.code) ? tax.specific + tax.advalorem : 0), 0);
  const otherAdditionalTotal = d.additionalTaxes.reduce((sum, tax) => sum + (!isSelectivo(tax.code) ? tax.other : 0), 0);
  const otherTaxRows = d.additionalTaxes
    .filter((tax) => !isSelectivo(tax.code) && tax.other > 0)
    .map((tax) => `<tr><td class="label">${escapeHtml(OTROS_IMPUESTOS[tax.code] || 'Otro impuesto adicional')}:</td><td class="value">${fmt(tax.other)}</td></tr>`)
    .join('');
  const adjustmentRows = d.globalAdjustments.map((adjustment) => {
    const label = adjustment.type === 'D' ? 'Descuento' : 'Recargo';
    const amount = num(adjustment.amount) * (adjustment.type === 'D' ? -1 : 1);
    const description = adjustment.description ? ` — ${escapeHtml(adjustment.description)}` : '';
    const value = adjustment.value ? ` (${fmt(adjustment.value)}${adjustment.valueType === '%' ? '%' : ''})` : '';
    return `<tr><td class="label">${label}${description}${value}:</td><td class="value">${fmt(amount)}</td></tr>`;
  }).join('');
  const totalsRows = [
    taxableTotal > 0 ? `<tr><td class="label">Subtotal Gravado:</td><td class="value">${fmt(taxableTotal)}</td></tr>` : '',
    num(d.montoExento) > 0 ? `<tr><td class="label">Subtotal Exento:</td><td class="value">${fmt(d.montoExento)}</td></tr>` : '',
    iscTotal > 0 ? `<tr><td class="label">Total ISC:</td><td class="value">${fmt(iscTotal)}</td></tr>` : '',
    otherTaxRows || (otherAdditionalTotal > 0 ? `<tr><td class="label">Otros Impuestos Adicionales:</td><td class="value">${fmt(otherAdditionalTotal)}</td></tr>` : ''),
    (!d.additionalTaxes.length || (iscTotal + otherAdditionalTotal === 0)) && num(d.montoImpuestoAdicional) > 0
      ? `<tr><td class="label">Impuestos Adicionales:</td><td class="value">${fmt(d.montoImpuestoAdicional)}</td></tr>` : '',
    totalItbis > 0 ? `<tr><td class="label">Total ITBIS:</td><td class="value">${fmt(totalItbis)}</td></tr>` : '',
    adjustmentRows,
  ].filter(Boolean).join('');

  const pageInfos = d.pages.length ? d.pages : [{ number: '1', fromLine: '1', toLine: String(Number.MAX_SAFE_INTEGER) }];
  const totalPages = d.pages.length || 1;
  const renderPageSummary = (page) => {
    const pageTaxable = num(page.taxable) || num(page.taxable1) + num(page.taxable2) + num(page.taxable3);
    const pageItbis = num(page.itbis) || num(page.itbis1) + num(page.itbis2) + num(page.itbis3);
    const pageIsc = num(page.specific);
    const pageOther = num(page.other);
    const pageAdditional = num(page.additional) || pageIsc + pageOther;
    return [
      pageTaxable > 0 ? `<tr><td class="label">Subtotal Gravado Página:</td><td class="value">${fmt(pageTaxable)}</td></tr>` : '',
      num(page.exempt) > 0 ? `<tr><td class="label">Subtotal Exento Página:</td><td class="value">${fmt(page.exempt)}</td></tr>` : '',
      pageItbis > 0 ? `<tr><td class="label">Subtotal ITBIS Página:</td><td class="value">${fmt(pageItbis)}</td></tr>` : '',
      pageAdditional > 0 ? `<tr><td class="label">Subtotal Impuesto Adicional Página:</td><td class="value">${fmt(pageAdditional)}</td></tr>` : '',
      num(page.total) > 0 ? `<tr class="grand-total"><td class="label">Monto Total Página:</td><td class="value">${fmt(page.total)}</td></tr>` : '',
    ].filter(Boolean).join('');
  };
  const pagesHtml = pageInfos.map((page, pageIndex) => {
    let rows = itemTaxRows;
    if (d.pages.length) {
      const from = num(page.fromLine);
      const to = num(page.toLine);
      if (from && to) rows = itemTaxRows.filter((item) => num(item.linea) >= from && num(item.linea) <= to);
      else if (d.pages.length > 1) {
        const start = Math.floor((pageIndex * itemTaxRows.length) / d.pages.length);
        const end = Math.floor(((pageIndex + 1) * itemTaxRows.length) / d.pages.length);
        rows = itemTaxRows.slice(start, end);
      }
    }
    const isLast = pageIndex === pageInfos.length - 1;
    const summaryRows = isLast ? totalsRows : renderPageSummary(page);
    const totalRow = isLast
      ? `<tr class="grand-total"><td class="label">Total:</td><td class="value">${fmt(d.montoTotal)}</td></tr>`
      : '';
    return `<section class="page">
      <div class="top">
        <div class="emitter-box">
          <div class="biz-name">${escapeHtml(issuerName)}</div>
          ${issuerNombreComercial && issuerNombreComercial !== issuerRazonSocial && issuerRazonSocial ? `<div class="biz-line">${escapeHtml(issuerRazonSocial)}</div>` : ''}
          <div class="biz-line">RNC: ${escapeHtml(issuerRnc)}</div>
          ${issuerDireccion ? `<div class="biz-line">${escapeHtml(issuerDireccion)}</div>` : ''}
          ${municipio ? `<div class="biz-line">Municipio: ${escapeHtml(municipio)}</div>` : ''}
          ${provincia ? `<div class="biz-line">Provincia: ${escapeHtml(provincia)}</div>` : ''}
          ${issuerTelefonos.length ? `<div class="biz-line">Tel: ${escapeHtml(issuerTelefonos.join(' / '))}</div>` : ''}
          ${issuerCorreo ? `<div class="biz-line">${escapeHtml(issuerCorreo)}</div>` : ''}
          ${branchLine ? `<div class="biz-line">${escapeHtml(branchLine)}</div>` : ''}
          <div class="biz-line">Fecha de Emisión: ${escapeHtml(d.fechaEmision)}</div>
        </div>
        <div class="doc-box">
          <div class="doc-type">${escapeHtml(typeLabel)}</div>
          <div class="doc-meta">e-NCF: ${escapeHtml(d.encf)}</div>
          ${d.fechaVencimiento && !['32', '34'].includes(String(d.tipoEcf)) ? `<div class="doc-meta">Fecha Vencimiento: ${escapeHtml(d.fechaVencimiento)}</div>` : ''}
          ${d.limitePago ? `<div class="doc-meta">Fecha Límite de Pago: ${escapeHtml(d.limitePago)}</div>` : ''}
          ${referenceBlock}
        </div>
      </div>
      <div class="buyer-box${isRfceRepresentation ? ' hidden' : ''}">
        <div>Razón Social Cliente: ${escapeHtml(buyerRazonSocial)}</div>
        ${d.rncComprador ? `<div>RNC Cliente: ${escapeHtml(d.rncComprador)}</div>` : ''}
        ${d.direccionComprador ? `<div>Dirección: ${escapeHtml(d.direccionComprador)}</div>` : ''}
        ${d.contacto ? `<div>Contacto: ${escapeHtml(d.contacto)}</div>` : ''}
      </div>
      ${renderItemsTable(rows)}
      ${modalityNote ? `<div class="modality-note">${escapeHtml(modalityNote)}</div>` : ''}
      <div class="bottom">
        <div class="qr-box">
          <img src="${qrDataUrl}" alt="QR Timbre DGII" />
          <div class="qr-line">Código de Seguridad: ${escapeHtml(codigoSeguridad)}</div>
          <div class="qr-line">Fecha de Firma Digital: ${escapeHtml(fechaFirmaImpresion)}</div>
        </div>
        <div class="totals"><table class="totals-table">${summaryRows}${totalRow}</table></div>
      </div>
      ${totalPages > 1 ? `<div class="page-count">Página No. ${escapeHtml(page.number || pageIndex + 1)} de ${totalPages}</div>` : ''}
    </section>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>${d.encf} — Representación Impresa</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #111; background: #fff; }
  .page { width: 210mm; height: 297mm; margin: 0 auto; padding: 14mm 16mm 12mm; display: flex; flex-direction: column; page-break-after: always; break-after: page; }
  .page:last-child { page-break-after: auto; break-after: auto; }
  .top { display: grid; grid-template-columns: 1fr 0.88fr; gap: 15mm; align-items: start; margin-bottom: 7mm; }
  .emitter-box { min-height: 29mm; padding: 0; }
  .biz-name { font-size: 15px; line-height: 1.12; font-weight: 800; text-transform: uppercase; color: #315e7e; margin-bottom: 1mm; }
  .biz-line { font-size: 10px; line-height: 1.35; }
  .doc-box { padding: 0; text-align: right; margin-top: 2mm; }
  .doc-type { font-size: 15px; line-height: 1.2; font-weight: 700; color: #315e7e; margin-bottom: 1mm; }
  .doc-meta { font-size: 10px; line-height: 1.4; font-weight: 700; }
  .buyer-box { border-top: 1.2px solid #4c8caf; border-bottom: 1.2px solid #4c8caf; padding: 2.5mm 0; margin-bottom: 4mm; font-size: 10px; line-height: 1.45; font-weight: 700; }
  .buyer-box.hidden { display: none; }
  .reference-line { margin-top: 1mm; font-size: 9.5px; line-height: 1.4; }
  .items-table { width: 100%; border-collapse: collapse; border: 1px solid #999; font-size: 9px; margin-top: 0; }
  .items-table thead { display: table-header-group; }
  .items-table tr { break-inside: avoid; page-break-inside: avoid; }
  .items-table th { background: #d9d9d9; color: #111; border: 1px solid #999; padding: 4px 4px; text-align: center; font-weight: 700; }
  .items-table td { border: 1px solid #999; padding: 4px 5px; vertical-align: top; }
  .items-table tbody tr:nth-child(even) { background: #fff; }
  .center { text-align: center; }
  .empty-items { border: 1px solid #999; padding: 8mm; text-align: center; color: #555; }
  td.num { text-align: right; white-space: nowrap; }
  .bottom { border-top: 1.2px solid #4c8caf; margin-top: auto; padding-top: 4mm; display: grid; grid-template-columns: 1fr 72mm; gap: 8mm; align-items: start; page-break-inside: avoid; break-inside: avoid; }
  .qr-box { padding: 0 4mm; width: 100%; text-align: left; page-break-inside: avoid; break-inside: avoid; }
  .qr-box img { width: 22mm; height: 22mm; display: block; margin: 3mm; image-rendering: pixelated; image-rendering: crisp-edges; }
  .qr-line { font-size: 9px; line-height: 1.35; word-break: break-word; }
  .totals { display: flex; justify-content: flex-end; margin-top: 0; }
  .totals-table { width: 100%; border-collapse: collapse; font-size: 9px; }
  .totals-table td { padding: 2px 5px; border: 1px solid #999; }
  .totals-table .label { text-align: right; font-weight: 700; white-space: nowrap; }
  .totals-table .value { text-align: right; white-space: nowrap; }
  .grand-total td { font-weight: 700; }
  .copy-note { display: none; }
  .modality-note { margin-top: 8mm; font-size: 9px; font-weight: 700; line-height: 1.4; page-break-inside: avoid; }
  .page-count { align-self: flex-end; margin-top: 6mm; font-size: 8px; color: #555; }
  .rfce-badge { font-size: 10px; font-weight: 700; }
  @media print {
    body { background: #fff; }
    .page { padding: 14mm 16mm 12mm; width: 210mm; margin: 0; box-shadow: none; }
  }
</style>
</head>
<body>
${pagesHtml}
</body>
</html>`;
}

module.exports = { generateReprImpresaHtml, parseEcfXml };
