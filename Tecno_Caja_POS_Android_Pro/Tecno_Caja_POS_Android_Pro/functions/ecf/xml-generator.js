'use strict';

/**
 * Generación de XML e-CF/RFCE, portada literal de
 * modules/ecf/services/ecf-generator.js (Desktop, solo lectura de
 * referencia) -- mismo motor `xmlbuilder`, mismo orden de campos XSD (ya
 * verificado en una certificación DGII real). No se reescribe con
 * concatenación de strings a propósito: el orden de elementos por tipo de
 * comprobante es el resultado de bugs reales ya corregidos, y una reescritura
 * manual arriesgaría reintroducirlos.
 */

const builder = require('xmlbuilder');

class EcfXmlError extends Error {
  constructor(message, { statusCode = 422 } = {}) {
    super(message);
    this.name = 'EcfXmlError';
    this.statusCode = statusCode;
  }
}

function assertCondition(condition, message, options = {}) {
  if (!condition) throw new EcfXmlError(message, options);
}

function stripInvalidXmlChars(value) {
  const text = String(value ?? '');
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const isControl = (code <= 0x08) || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f);
    const isNonCharacter = code === 0xfffe || code === 0xffff;
    if (!isControl && !isNonCharacter) out += text[i];
  }
  return out;
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function normalizeDocumentTypeCode(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) return '';
  return normalized.startsWith('E') ? normalized : `E${normalized}`;
}

function normalizeEncfValue(value, tipoeCF = '') {
  const raw = String(value || '').trim().toUpperCase();
  const prefix = normalizeDocumentTypeCode(tipoeCF) || (raw.match(/^E\d{2}/)?.[0] || '');
  assertCondition(prefix, 'No se pudo determinar el prefijo del e-NCF.');

  let numericPart = raw;
  if (raw.startsWith(prefix)) {
    numericPart = raw.slice(prefix.length);
  } else {
    numericPart = raw.replace(/^[A-Z]+/, '');
  }
  numericPart = String(numericPart || '').replace(/\D/g, '');
  assertCondition(numericPart, 'El e-NCF no contiene una parte numérica válida.');

  const normalizedNumber = String(Number(numericPart));
  assertCondition(normalizedNumber !== 'NaN', 'El e-NCF no contiene una secuencia numérica válida.');

  return `${prefix}${normalizedNumber.padStart(10, '0')}`;
}

function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  assertCondition(!Number.isNaN(date.getTime()), 'Fecha inválida para el e-CF.');
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear());
  return `${day}-${month}-${year}`;
}

function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  assertCondition(!Number.isNaN(date.getTime()), 'Fecha y hora inválida para el e-CF.');
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear());
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${day}-${month}-${year} ${hour}:${minute}:${second}`;
}

function sanitizeText(value, { allowEmpty = false } = {}) {
  const text = stripInvalidXmlChars(String(value ?? '').trim());
  if (!allowEmpty) {
    assertCondition(text, 'Se encontró un campo de texto obligatorio vacío en el e-CF.');
  }
  return text;
}

function normalizeBuyerTaxId(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeEmitterPhones(value) {
  function normalizePhoneEntry(entry) {
    const normalized = stripInvalidXmlChars(entry).trim();
    const digits = normalized.replace(/\D/g, '');
    if (digits.length === 10) {
      return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    return normalized;
  }
  return String(value || '')
    .split(/[;,|]+/)
    .map(normalizePhoneEntry)
    .filter(Boolean);
}

function buildTotals(items) {
  const normalizedItems = items.map((item, index) => {
    const quantity = Number(item.quantity ?? item.qty ?? 0);
    const unitPrice = Number(item.unitPrice ?? item.price ?? 0);
    const discount = Number(item.discount ?? item.lineDiscount ?? 0);
    const taxRate = Number(item.taxRate ?? item.itbisRate ?? item.tax_rate ?? item.itbis ?? 0);
    const withholdingAmount = Number(item.isrRetenido ?? item.withholdingAmount ?? item.isrWithholding ?? 0);
    const billingIndicator = item.billingIndicator ?? item.indicadorFacturacion ?? null;
    const retentionIndicator = item.retentionIndicator ?? item.indicadorAgenteRetencionoPercepcion ?? null;
    const goodsOrServicesIndicator = Number(
      item.goodsOrServicesIndicator ?? item.indicadorBienoServicio ?? (item.isService ? 2 : 1)
    ) || 1;
    const additionalDescription = sanitizeText(
      item.additionalDescription ?? item.descripcion ?? '',
      { allowEmpty: true }
    );
    const unitMeasure = item.unitMeasure ?? item.unidadMedida ?? item.unit ?? null;

    assertCondition(quantity > 0, `La cantidad del item ${index + 1} debe ser mayor que cero.`);
    assertCondition(unitPrice >= 0, `El precio del item ${index + 1} no puede ser negativo.`);
    assertCondition(discount >= 0, `El descuento del item ${index + 1} no puede ser negativo.`);
    assertCondition(withholdingAmount >= 0, `La retención ISR del item ${index + 1} no puede ser negativa.`);

    const lineSubtotal = round2(quantity * unitPrice);
    const taxableBase = round2(Math.max(lineSubtotal - discount, 0));
    const taxAmount = round2(taxableBase * (taxRate / 100));
    const lineTotal = round2(taxableBase + taxAmount);

    return {
      lineNumber: index + 1,
      name: sanitizeText(item.name || item.description || item.product_name || 'Producto'),
      quantity,
      unitPrice,
      discount,
      taxRate,
      taxableBase,
      taxAmount,
      lineTotal,
      exempt: taxRate <= 0,
      withholdingAmount,
      billingIndicator,
      retentionIndicator,
      goodsOrServicesIndicator,
      additionalDescription,
      unitMeasure: unitMeasure == null || unitMeasure === '' ? null : String(unitMeasure).trim(),
    };
  });

  const subtotal = round2(normalizedItems.reduce((sum, item) => sum + round2(item.quantity * item.unitPrice), 0));
  const totalDiscount = round2(normalizedItems.reduce((sum, item) => sum + item.discount, 0));
  const exemptAmount = round2(normalizedItems.filter((item) => item.exempt).reduce((sum, item) => sum + item.taxableBase, 0));
  const taxed18 = round2(normalizedItems.filter((item) => item.taxRate === 18).reduce((sum, item) => sum + item.taxableBase, 0));
  const taxed16 = round2(normalizedItems.filter((item) => item.taxRate === 16).reduce((sum, item) => sum + item.taxableBase, 0));
  const taxed0 = round2(normalizedItems.filter((item) => item.taxRate === 0).reduce((sum, item) => sum + item.taxableBase, 0));
  const totalTax = round2(normalizedItems.reduce((sum, item) => sum + item.taxAmount, 0));
  const total = round2(normalizedItems.reduce((sum, item) => sum + item.lineTotal, 0));
  const totalIsrRetenido = round2(normalizedItems.reduce((sum, item) => sum + item.withholdingAmount, 0));

  return {
    items: normalizedItems,
    subtotal,
    totalDiscount,
    exemptAmount,
    taxed18,
    taxed16,
    taxed0,
    totalTax,
    total,
    totalTaxed: round2(taxed18 + taxed16 + taxed0),
    totalIsrRetenido,
  };
}

function appendIfValue(node, key, value) {
  if (value === undefined || value === null || value === '') return;
  node.ele(key).txt(String(value));
}

const TIPOS_NOTA_CREDITO = new Set(['E34']);
const TIPOS_SIN_TIPO_INGRESOS = new Set(['E34', 'E43', 'E47']);
const TIPOS_CON_FECHA_VENCIMIENTO = new Set(['E33', 'E41', 'E43', 'E44', 'E45', 'E46', 'E47']);
const TIPOS_SIN_TIPO_PAGO = new Set(['E43']);
const TIPOS_TOTALES_EXENTO = new Set(['E43', 'E47']);
const TIPO_EXTERIOR = 'E47';

function generateEcfXml(payload) {
  const emitter = payload?.emitter || {};
  const customer = payload?.customer || {};
  const document = payload?.document || {};
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const issueDate = payload?.issueDate || new Date();
  const totals = buildTotals(items);
  const documentTypeCode = normalizeDocumentTypeCode(document.tipoeCF);
  const normalizedEncf = normalizeEncfValue(document.eNCF, documentTypeCode);
  const isExteriorPayment = documentTypeCode === TIPO_EXTERIOR;
  const isExentoTotal = TIPOS_TOTALES_EXENTO.has(documentTypeCode);
  const isNotaCredito = TIPOS_NOTA_CREDITO.has(documentTypeCode);
  const hasFechaVencimiento = TIPOS_CON_FECHA_VENCIMIENTO.has(documentTypeCode);
  const hasTipoIngresos = !TIPOS_SIN_TIPO_INGRESOS.has(documentTypeCode);
  const hasTipoPago = !TIPOS_SIN_TIPO_PAGO.has(documentTypeCode);

  assertCondition(items.length > 0, 'No se puede generar un XML e-CF sin productos.');
  assertCondition(totals.total >= 0, 'El monto total del e-CF no puede ser negativo.');
  assertCondition(document.eNCF, 'Debe indicar el eNCF del documento.');
  assertCondition(document.tipoeCF, 'Debe indicar el tipo de e-CF.');

  const xml = builder
    .create('ECF', { encoding: 'UTF-8' })
    .att('xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance')
    .att('xmlns:xsd', 'http://www.w3.org/2001/XMLSchema');

  const encabezado = xml.ele('Encabezado');
  encabezado.ele('Version').txt('1.0');

  const idDoc = encabezado.ele('IdDoc');
  idDoc.ele('TipoeCF').txt(String(document.tipoeCF).replace(/^E/i, ''));
  idDoc.ele('eNCF').txt(sanitizeText(normalizedEncf));

  if (hasFechaVencimiento && document.fechaVencimientoSecuencia) {
    idDoc.ele('FechaVencimientoSecuencia').txt(formatDate(document.fechaVencimientoSecuencia));
  }
  if (isNotaCredito) {
    const indicador = document.indicadorNotaCredito ?? 1;
    idDoc.ele('IndicadorNotaCredito').txt(String(indicador));
  }
  if (hasTipoIngresos) {
    appendIfValue(idDoc, 'TipoIngresos', document.tipoIngresos || '01');
  }
  if (!isExteriorPayment && !isExentoTotal) {
    appendIfValue(idDoc, 'IndicadorMontoGravado', document.indicadorMontoGravado);
  }
  if (hasTipoPago) {
    appendIfValue(idDoc, 'TipoPago', document.tipoPago || '1');
  }

  const emisor = encabezado.ele('Emisor');
  emisor.ele('RNCEmisor').txt(sanitizeText(emitter.rnc));
  emisor.ele('RazonSocialEmisor').txt(sanitizeText(emitter.razonSocial));
  appendIfValue(emisor, 'NombreComercial', sanitizeText(emitter.nombreComercial, { allowEmpty: true }));
  appendIfValue(emisor, 'DireccionEmisor', sanitizeText(emitter.direccion, { allowEmpty: true }));
  const emitterPhones = normalizeEmitterPhones(emitter.telefono);
  if (emitterPhones.length) {
    const table = emisor.ele('TablaTelefonoEmisor');
    for (const phone of emitterPhones) {
      table.ele('TelefonoEmisor').txt(phone);
    }
  }
  appendIfValue(emisor, 'CorreoEmisor', sanitizeText(emitter.correo, { allowEmpty: true }));
  emisor.ele('FechaEmision').txt(formatDate(issueDate));

  const buyerTaxId = normalizeBuyerTaxId(customer.rnc || customer.taxId || customer.cedula);
  const comprador = encabezado.ele('Comprador');
  appendIfValue(comprador, 'RNCComprador', buyerTaxId);
  appendIfValue(comprador, 'RazonSocialComprador', sanitizeText(customer.nombre || 'Consumidor Final', { allowEmpty: true }));
  appendIfValue(comprador, 'CorreoComprador', sanitizeText(customer.correo, { allowEmpty: true }));
  appendIfValue(comprador, 'TelefonoAdicional', sanitizeText(customer.telefono, { allowEmpty: true }));
  appendIfValue(comprador, 'DireccionComprador', sanitizeText(customer.direccion, { allowEmpty: true }));

  const totalsNode = encabezado.ele('Totales');
  if (isExentoTotal) {
    appendIfValue(totalsNode, 'MontoExento', totals.total > 0 ? totals.total.toFixed(2) : null);
    totalsNode.ele('MontoTotal').txt(totals.total.toFixed(2));
    if (isExteriorPayment) {
      totalsNode.ele('TotalISRRetencion').txt(round2(document.totalIsrRetencion ?? totals.totalIsrRetenido).toFixed(2));
    }
  } else {
    appendIfValue(totalsNode, 'MontoGravadoTotal', totals.totalTaxed ? totals.totalTaxed.toFixed(2) : null);
    appendIfValue(totalsNode, 'MontoGravadoI1', totals.taxed18 ? totals.taxed18.toFixed(2) : null);
    appendIfValue(totalsNode, 'MontoGravadoI2', totals.taxed16 ? totals.taxed16.toFixed(2) : null);
    appendIfValue(totalsNode, 'MontoExento', totals.exemptAmount ? totals.exemptAmount.toFixed(2) : null);
    appendIfValue(totalsNode, 'ITBIS1', totals.taxed18 ? '18' : null);
    appendIfValue(totalsNode, 'ITBIS2', totals.taxed16 ? '16' : null);
    appendIfValue(totalsNode, 'TotalITBIS', totals.totalTax ? totals.totalTax.toFixed(2) : null);
    appendIfValue(totalsNode, 'TotalITBIS1', totals.taxed18 ? round2(totals.taxed18 * 0.18).toFixed(2) : null);
    appendIfValue(totalsNode, 'TotalITBIS2', totals.taxed16 ? round2(totals.taxed16 * 0.16).toFixed(2) : null);
    totalsNode.ele('MontoTotal').txt(totals.total.toFixed(2));
  }

  const detallesItems = xml.ele('DetallesItems');
  for (const item of totals.items) {
    const detalle = detallesItems.ele('Item');
    detalle.ele('NumeroLinea').txt(String(item.lineNumber));

    if (isExteriorPayment) {
      detalle.ele('IndicadorFacturacion').txt(String(item.billingIndicator ?? 4));
      const retencion = detalle.ele('Retencion');
      retencion.ele('IndicadorAgenteRetencionoPercepcion').txt(String(item.retentionIndicator ?? 1));
      retencion.ele('MontoISRRetenido').txt(round2(item.withholdingAmount ?? 0).toFixed(2));
      detalle.ele('NombreItem').txt(item.name);
      detalle.ele('IndicadorBienoServicio').txt('2');
      appendIfValue(detalle, 'DescripcionItem', item.additionalDescription || null);
      detalle.ele('CantidadItem').txt(item.quantity.toFixed(2));
      appendIfValue(detalle, 'UnidadMedida', item.unitMeasure || null);
      detalle.ele('PrecioUnitarioItem').txt(item.unitPrice.toFixed(2));
      detalle.ele('MontoItem').txt(item.taxableBase.toFixed(2));
    } else {
      const billingInd = item.billingIndicator ?? (item.taxRate === 16 ? 3 : item.exempt ? 4 : 1);
      detalle.ele('IndicadorFacturacion').txt(String(billingInd));
      detalle.ele('NombreItem').txt(item.name);
      detalle.ele('IndicadorBienoServicio').txt(String(item.goodsOrServicesIndicator || 1));
      appendIfValue(detalle, 'DescripcionItem', item.additionalDescription || null);
      detalle.ele('CantidadItem').txt(item.quantity.toFixed(2));
      appendIfValue(detalle, 'UnidadMedida', item.unitMeasure || null);
      detalle.ele('PrecioUnitarioItem').txt(item.unitPrice.toFixed(2));
      appendIfValue(detalle, 'MontoItemMasITBIS', !item.exempt ? item.lineTotal.toFixed(2) : null);
      appendIfValue(detalle, 'TasaITBIS', !item.exempt && item.taxRate ? String(item.taxRate) : null);
      appendIfValue(detalle, 'ITBISItem', item.taxAmount ? item.taxAmount.toFixed(2) : null);
      appendIfValue(detalle, 'DescuentoMonto', item.discount ? item.discount.toFixed(2) : null);
      detalle.ele('MontoItem').txt(item.taxableBase.toFixed(2));
    }
  }

  if (document.referencia) {
    const referencia = xml.ele('InformacionReferencia');
    appendIfValue(referencia, 'NCFModificado', sanitizeText(document.referencia.ncfModificado, { allowEmpty: true }));
    appendIfValue(referencia, 'FechaNCFModificado', sanitizeText(document.referencia.fechaNcfModificado, { allowEmpty: true }));
    appendIfValue(referencia, 'CodigoModificacion', sanitizeText(document.referencia.codigoModificacion, { allowEmpty: true }));
  }

  xml.ele('FechaHoraFirma').txt(formatDateTime(new Date()));

  return { xml: xml.end({ pretty: true }), totals };
}

function generateRfceXml(payload) {
  const emitter = payload?.emitter || {};
  const document = payload?.document || {};
  const totals = payload?.totals || {};
  const issueDate = payload?.issueDate || new Date();
  const paymentForms = Array.isArray(payload?.paymentForms) ? payload.paymentForms : [];
  const codigoSeguridad = sanitizeText(payload?.document?.codigoSeguridad || payload?.securityCode, { allowEmpty: true });

  assertCondition(
    String(document.tipoeCF || '').replace(/^E/i, '') === '32',
    'El resumen RFCE solo aplica para documentos E32.'
  );
  assertCondition(codigoSeguridad, 'El RFCE requiere CodigoSeguridadeCF para ser enviado a DGII.');

  const xml = builder
    .create('RFCE', { encoding: 'UTF-8' })
    .att('xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance')
    .att('xmlns:xsd', 'http://www.w3.org/2001/XMLSchema');

  const encabezado = xml.ele('Encabezado');
  encabezado.ele('Version').txt('1.0');

  const idDoc = encabezado.ele('IdDoc');
  idDoc.ele('TipoeCF').txt('32');
  idDoc.ele('eNCF').txt(sanitizeText(document.eNCF));
  idDoc.ele('TipoIngresos').txt(String(document.tipoIngresos || '01'));
  idDoc.ele('TipoPago').txt(String(document.tipoPago || '1'));

  if (paymentForms.length) {
    const table = idDoc.ele('TablaFormasPago');
    for (const form of paymentForms) {
      const row = table.ele('FormaDePago');
      row.ele('FormaPago').txt(String(form.formaPago || form.code || '1'));
      row.ele('MontoPago').txt(Number(form.montoPago || form.amount || 0).toFixed(2));
    }
  }

  const emisor = encabezado.ele('Emisor');
  emisor.ele('RNCEmisor').txt(sanitizeText(emitter.rnc));
  emisor.ele('RazonSocialEmisor').txt(sanitizeText(emitter.razonSocial));
  emisor.ele('FechaEmision').txt(formatDate(issueDate));

  const comprador = encabezado.ele('Comprador');
  appendIfValue(comprador, 'RNCComprador', normalizeBuyerTaxId(payload?.customer?.rnc));
  appendIfValue(comprador, 'RazonSocialComprador', sanitizeText(payload?.customer?.nombre || 'Consumidor Final', { allowEmpty: true }));

  const totalNode = encabezado.ele('Totales');
  const rfceTaxed18 = Number(totals.taxed18 || 0);
  const rfceTaxed16 = Number(totals.taxed16 || 0);
  const rfceTotalTaxed = Number(totals.totalTaxed || 0);
  const rfceExempt = Number(totals.exemptAmount || 0);
  const rfceTotalTax = Number(totals.totalTax || 0);
  if (rfceTotalTaxed > 0) totalNode.ele('MontoGravadoTotal').txt(rfceTotalTaxed.toFixed(2));
  if (rfceTaxed18 > 0) totalNode.ele('MontoGravadoI1').txt(rfceTaxed18.toFixed(2));
  if (rfceTaxed16 > 0) totalNode.ele('MontoGravadoI2').txt(rfceTaxed16.toFixed(2));
  if (rfceExempt > 0) totalNode.ele('MontoExento').txt(rfceExempt.toFixed(2));
  if (rfceTotalTax > 0) totalNode.ele('TotalITBIS').txt(rfceTotalTax.toFixed(2));
  const rfceItbis1 = rfceTaxed18 > 0 ? round2(rfceTaxed18 * 0.18) : 0;
  if (rfceItbis1 > 0) totalNode.ele('TotalITBIS1').txt(rfceItbis1.toFixed(2));
  const rfceItbis2 = rfceTaxed16 > 0 ? round2(rfceTaxed16 * 0.16) : 0;
  if (rfceItbis2 > 0) totalNode.ele('TotalITBIS2').txt(rfceItbis2.toFixed(2));
  totalNode.ele('MontoTotal').txt(Number(totals.total || 0).toFixed(2));
  encabezado.ele('CodigoSeguridadeCF').txt(codigoSeguridad);

  return xml.end({ pretty: true });
}

module.exports = {
  EcfXmlError,
  buildTotals,
  generateEcfXml,
  generateRfceXml,
  normalizeEncfValue,
  round2,
};
