'use strict';
// Lee el XML e-CF que manda el proveedor (E31, E32, E44, E45) y lo convierte
// en el borrador de «Preparar compra». Nada se registra aquí. Una compra que
// trae su e-CF del proveedor ya está documentada: nunca se emite un E41 por ella.

const { parseXml } = require('./xml.util');
const { codigoBarrasValido } = require('./emparejar-productos');

const VERSION = 'xml-ecf-1';
const TIPOS_COMPRA = { 31: 'Crédito fiscal', 32: 'Consumo', 44: 'Regímenes especiales', 45: 'Gubernamental' };

const textoDe = (nodo, etiqueta) => {
  const el = nodo?.getElementsByTagName?.(etiqueta)?.[0];
  return el ? String(el.textContent || '').trim() : '';
};
const numeroDe = (nodo, etiqueta) => {
  const t = textoDe(nodo, etiqueta);
  return t === '' ? null : Number(t);
};
// dd-mm-aaaa (formato DGII) → aaaa-mm-dd
function fechaIso(texto) {
  const m = /^(\d{2})-(\d{2})-(\d{4})/.exec(String(texto || '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}
const soloDigitos = (v) => String(v || '').replace(/\D/g, '');

// Lee el XML. `rncNegocio`: para avisar si la factura no está a nombre del negocio.
// `verificarFirma(xml)`: { ok, validationError } (signatureService.verifySignature).
function leerXmlEcf(xml, { rncNegocio = '', verificarFirma = null } = {}) {
  const BOM = String.fromCharCode(0xfeff);
  const texto = String(xml || '').split(BOM).join('').trim();
  if (!texto.startsWith('<')) throw Object.assign(new Error('El archivo no es un XML.'), { statusCode: 400 });
  let doc;
  try { doc = parseXml(texto); } catch (_) { throw Object.assign(new Error('El XML está dañado y no se puede leer.'), { statusCode: 400 }); }
  const raiz = doc?.documentElement;
  if (!raiz || String(raiz.nodeName).replace(/^.*:/, '') !== 'ECF') {
    throw Object.assign(new Error('Este XML no es un comprobante electrónico (e-CF) de la DGII.'), { statusCode: 400 });
  }
  const idDoc = raiz.getElementsByTagName('IdDoc')[0];
  const emisor = raiz.getElementsByTagName('Emisor')[0];
  const comprador = raiz.getElementsByTagName('Comprador')[0];
  const totales = raiz.getElementsByTagName('Totales')[0];
  const tipo = Number(textoDe(idDoc, 'TipoeCF'));
  const encf = textoDe(idDoc, 'eNCF').toUpperCase();
  if (tipo === 33 || tipo === 34) {
    throw Object.assign(new Error('Las notas de débito y crédito del proveedor se registran aparte (todavía no desde aquí).'), { statusCode: 400 });
  }
  if (!TIPOS_COMPRA[tipo]) {
    throw Object.assign(new Error(`El e-CF tipo ${tipo || '?'} no es una factura de compra de un proveedor.`), { statusCode: 400 });
  }
  const avisos = [];
  const aviso = (nivel, texto) => avisos.push({ nivel, texto });

  const rncEmisor = soloDigitos(textoDe(emisor, 'RNCEmisor'));
  const rncComprador = soloDigitos(textoDe(comprador, 'RNCComprador'));
  if (!rncEmisor) aviso('error', 'El XML no trae el RNC del proveedor.');
  if (!/^E\d{2}\d{10}$/.test(encf)) aviso('error', `El e-NCF «${encf || 'vacío'}» no tiene el formato de la DGII.`);
  const negocio = soloDigitos(rncNegocio);
  if (negocio && rncComprador && rncComprador !== negocio) aviso('aviso', `La factura está a nombre del RNC ${rncComprador}, no del negocio (${negocio}): no da crédito fiscal al negocio.`);
  if (negocio && !rncComprador) aviso('aviso', 'La factura no trae el RNC del comprador (factura de consumo).');
  if (tipo === 32) aviso('aviso', 'Factura de consumo (E32): no da crédito fiscal de ITBIS.');

  // Tasas del documento (Totales: ITBIS1/2/3); si no vienen, las de ley vigentes en el XSD.
  const tasas = { 1: numeroDe(totales, 'ITBIS1') ?? 18, 2: numeroDe(totales, 'ITBIS2') ?? 16, 3: numeroDe(totales, 'ITBIS3') ?? 0, 4: 0 };
  const items = Array.from(raiz.getElementsByTagName('Item'));
  if (!items.length) aviso('error', 'El XML no trae líneas de productos o servicios.');
  const lineas = items.map((item, i) => {
    const indicador = Number(textoDe(item, 'IndicadorFacturacion') || 4);
    const codigos = Array.from(item.getElementsByTagName('CodigosItem')).map((n) => ({ tipo: textoDe(n, 'TipoCodigo'), codigo: textoDe(n, 'CodigoItem') }))
      .filter((x) => x.codigo);
    const barras = codigos.find((x) => /ean|upc|gtin|barra/i.test(x.tipo) || codigoBarrasValido(x.codigo));
    const otro = codigos.find((x) => x !== barras);
    const cantidad = numeroDe(item, 'CantidadItem') ?? 0;
    const precio = numeroDe(item, 'PrecioUnitarioItem') ?? 0;
    const descuento = numeroDe(item, 'DescuentoMonto') ?? 0;
    const servicio = textoDe(item, 'IndicadorBienoServicio') === '2';
    const nombre = textoDe(item, 'NombreItem') || textoDe(item, 'DescripcionItem');
    if (!(cantidad > 0)) aviso('error', `Línea ${i + 1}: cantidad no válida.`);
    if (!nombre) aviso('error', `Línea ${i + 1}: sin descripción.`);
    return {
      numero: Number(textoDe(item, 'NumeroLinea')) || i + 1,
      descripcion: nombre,
      codigoBarras: barras ? barras.codigo : '',
      codigoProveedor: otro ? otro.codigo : '',
      unidadCodigo: textoDe(item, 'UnidadMedida'),
      cantidad, costoUnitario: precio, descuento,
      montoXml: numeroDe(item, 'MontoItem'),
      itbisPct: indicador === 4 ? 0 : Number(tasas[indicador] ?? 0),
      exento: indicador === 4,
      tipoLinea: servicio ? 'servicio_gasto' : 'inventario',
    };
  });

  const moneda = textoDe(raiz.getElementsByTagName('OtraMoneda')[0], 'TipoMoneda');
  if (moneda && moneda !== 'DOP') aviso('aviso', `La factura también trae montos en ${moneda}; se registran los montos en pesos.`);

  let firma = { verificada: false, valida: false, error: null };
  if (!/<SignatureValue[\s>]/.test(texto)) {
    aviso('aviso', 'El XML no está firmado: verifica el comprobante con el proveedor o en la DGII.');
  } else if (typeof verificarFirma === 'function') {
    try {
      const r = verificarFirma(texto);
      firma = { verificada: true, valida: Boolean(r?.ok), error: r?.ok ? null : String(r?.validationError || 'firma no válida') };
      if (!firma.valida) aviso('error', 'La firma digital no es válida: el XML pudo ser modificado después de firmado.');
    } catch (e) {
      firma = { verificada: false, valida: false, error: e.message };
      aviso('aviso', 'No se pudo comprobar la firma digital del XML.');
    }
  }
  const signatureValue = String(doc.getElementsByTagName('SignatureValue')?.[0]?.textContent || '').trim();

  const fecha = fechaIso(textoDe(emisor, 'FechaEmision'));
  if (!fecha) aviso('error', 'El XML no trae la fecha de emisión.');
  const tipoPago = textoDe(idDoc, 'TipoPago');
  return {
    version: VERSION,
    origen: 'xml',
    tipoEcf: `E${tipo}`,
    encabezado: {
      proveedor: { nombre: textoDe(emisor, 'RazonSocialEmisor') || textoDe(emisor, 'NombreComercial'), rnc: rncEmisor },
      compradorRnc: rncComprador,
      compradorNombre: textoDe(comprador, 'RazonSocialComprador'),
      tipoComprobante: `E${tipo}`,
      ncf: encf,
      encfProveedor: encf,
      numeroDocumento: encf,
      fechaComprobante: fecha,
      condicionPago: tipoPago === '2' ? 'credito' : 'contado',
      fechaVencimiento: fechaIso(textoDe(idDoc, 'FechaLimitePago')) || '',
      codigoSeguridad: signatureValue.slice(0, 6),
      documentoOrigen: 'xml_ecf',
      tipoBienesServicios: lineas.length && lineas.every((l) => l.tipoLinea === 'servicio_gasto') ? 2 : 9,
      totalesDocumento: {
        subtotal: (numeroDe(totales, 'MontoGravadoTotal') ?? 0) + (numeroDe(totales, 'MontoExento') ?? 0),
        itbis: numeroDe(totales, 'TotalITBIS') ?? 0,
        total: numeroDe(totales, 'MontoTotal') ?? 0,
        itbisRetenido: numeroDe(totales, 'TotalITBISRetenido') ?? 0,
        isrRetenido: numeroDe(totales, 'TotalISRRetencion') ?? 0,
      },
    },
    lineas,
    firma,
    avisos,
  };
}

module.exports = { leerXmlEcf, VERSION, TIPOS_COMPRA, fechaIso };
