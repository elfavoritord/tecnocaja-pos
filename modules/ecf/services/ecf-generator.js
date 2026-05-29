'use strict';

const builder = require('xmlbuilder');
const { assertCondition, EcfError } = require('../utils/errors');
const { parseXml, serializeXml, stripInvalidXmlChars } = require('../utils/xml.util');

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
  assertCondition(prefix, 'No se pudo determinar el prefijo del e-NCF.', { statusCode: 422 });

  let numericPart = raw;
  if (raw.startsWith(prefix)) {
    numericPart = raw.slice(prefix.length);
  } else {
    numericPart = raw.replace(/^[A-Z]+/, '');
  }

  numericPart = String(numericPart || '').replace(/\D/g, '');
  assertCondition(numericPart, 'El e-NCF no contiene una parte numérica válida.', { statusCode: 422 });

  // Algunos documentos viejos quedaron con un cero adicional en la parte numérica.
  // Se normaliza al valor entero antes de completar a 10 dígitos.
  const normalizedNumber = String(Number(numericPart));
  assertCondition(normalizedNumber !== 'NaN', 'El e-NCF no contiene una secuencia numérica válida.', { statusCode: 422 });

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

function buildTotals(items) {
  const normalizedItems = items.map((item, index) => {
    const quantity = Number(item.quantity ?? item.qty ?? 0);
    const unitPrice = Number(item.unitPrice ?? item.price ?? 0);
    const discount = Number(item.discount ?? item.lineDiscount ?? 0);
    const taxRate = Number(item.taxRate ?? item.itbisRate ?? item.tax_rate ?? item.itbis ?? 0);
    const withholdingAmount = Number(item.isrRetenido ?? item.withholdingAmount ?? item.isrWithholding ?? 0);
    const billingIndicator = item.billingIndicator ?? item.indicadorFacturacion ?? item.indicador_facturacion ?? null;
    const retentionIndicator = item.retentionIndicator ?? item.indicadorAgenteRetencionoPercepcion ?? item.indicador_agente_retencion ?? null;
    const goodsOrServicesIndicator = Number(
      item.goodsOrServicesIndicator
      ?? item.indicadorBienoServicio
      ?? item.indicador_bien_servicio
      ?? (item.isService ? 2 : 1)
    ) || 1;
    const additionalDescription = sanitizeText(
      item.additionalDescription ?? item.descripcion ?? item.descriptionExtra ?? '',
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

function isSignatureNode(node) {
  return node?.nodeType === 1
    && String(node.localName || node.nodeName || '').toLowerCase() === 'signature'
    && (!node.namespaceURI || node.namespaceURI === 'http://www.w3.org/2000/09/xmldsig#');
}

function normalizeEcfXmlStructure(xmlContent, options = {}) {
  const raw = String(xmlContent || '');
  if (!raw.trim()) return raw;

  const doc = parseXml(raw.replace(/^\uFEFF/, ''));
  let changed = false;
  const root = doc.documentElement;
  if (!root) return raw;

  if (options.removeSignature) {
    const signatureNodes = [];
    for (let child = root.firstChild; child; child = child.nextSibling) {
      if (isSignatureNode(child)) {
        signatureNodes.push(child);
      }
    }
    for (const signatureNode of signatureNodes) {
      root.removeChild(signatureNode);
      changed = true;
    }
  }

  const idDocNode = doc.getElementsByTagName('IdDoc')?.[0] || null;
  if (idDocNode) {
    const removableNoteIndicators = [];
    for (let child = idDocNode.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1 && child.nodeName === 'IndicadorNotaCredito') {
        const noteValue = String(child.textContent || '').trim();
        if (!noteValue || noteValue === '0') {
          removableNoteIndicators.push(child);
        }
      }
    }
    for (const noteIndicatorNode of removableNoteIndicators) {
      idDocNode.removeChild(noteIndicatorNode);
      changed = true;
    }
  }

  const emisor = doc.getElementsByTagName('Emisor')?.[0];
  if (!emisor) return raw;

  const encabezado = doc.getElementsByTagName('Encabezado')?.[0] || null;
  if (encabezado) {
    const misplacedReferences = [];
    for (let child = encabezado.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1 && child.nodeName === 'InformacionReferencia') {
        misplacedReferences.push(child);
      }
    }
    if (misplacedReferences.length) {
      const detallesItemsNode = Array.from(root.childNodes || []).find(
        (child) => child?.nodeType === 1 && child.nodeName === 'DetallesItems'
      ) || null;
      const insertReference = detallesItemsNode?.nextSibling || Array.from(root.childNodes || []).find(
        (child) => child?.nodeType === 1 && child.nodeName === 'FechaHoraFirma'
      ) || null;
      for (const refNode of misplacedReferences) {
        encabezado.removeChild(refNode);
        root.insertBefore(refNode, insertReference);
        changed = true;
      }
    }
  }

  const directPhoneNodes = [];
  for (let child = emisor.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && child.nodeName === 'TelefonoEmisor') {
      directPhoneNodes.push(child);
    }
  }

  let phoneTable = null;
  for (let child = emisor.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && child.nodeName === 'TablaTelefonoEmisor') {
      phoneTable = child;
      break;
    }
  }

  if (directPhoneNodes.length && !phoneTable) {
    phoneTable = doc.createElement('TablaTelefonoEmisor');
    let insertBeforeNode = null;
    for (let child = emisor.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      if (child.nodeName === 'CorreoEmisor' || child.nodeName === 'WebSite' || child.nodeName === 'ActividadEconomica' || child.nodeName === 'FechaEmision') {
        insertBeforeNode = child;
        break;
      }
    }
    emisor.insertBefore(phoneTable, insertBeforeNode);
    changed = true;
  }

  for (const phoneNode of directPhoneNodes) {
    const clone = doc.createElement('TelefonoEmisor');
    const normalizedPhone = normalizeEmitterPhones(String(phoneNode.textContent || '').trim()).join('');
    clone.appendChild(doc.createTextNode(normalizedPhone));
    phoneTable.appendChild(clone);
    emisor.removeChild(phoneNode);
    changed = true;
  }

  if (phoneTable) {
    for (let child = phoneTable.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1 || child.nodeName !== 'TelefonoEmisor') continue;
      const normalizedPhone = normalizeEmitterPhones(String(child.textContent || '').trim()).join('');
      if (normalizedPhone && normalizedPhone !== String(child.textContent || '').trim()) {
        child.textContent = normalizedPhone;
        changed = true;
      }
    }
  }

  if (!changed) return raw;

  const serialized = serializeXml(doc).replace(/^\s*<\?xml[\s\S]*?\?>\s*/i, '');
  return `<?xml version="1.0" encoding="UTF-8"?>\n${serialized}`;
}

// ---------------------------------------------------------------------------
// Clasificación de tipos de e-CF según reglas XSD DGII verificadas en campo
// ---------------------------------------------------------------------------

/** Tipos que usan IndicadorNotaCredito en IdDoc (sin TipoIngresos). */
const TIPOS_NOTA_CREDITO = new Set(['E34']);

/** Tipos que NUNCA llevan TipoIngresos en IdDoc. */
const TIPOS_SIN_TIPO_INGRESOS = new Set(['E34', 'E43', 'E47']);

/** Tipos que llevan FechaVencimientoSecuencia en IdDoc. */
const TIPOS_CON_FECHA_VENCIMIENTO = new Set(['E33', 'E41', 'E43', 'E44', 'E45', 'E46', 'E47']);

/** Tipos que NO llevan TipoPago en IdDoc. */
const TIPOS_SIN_TIPO_PAGO = new Set(['E43']);

/** Tipos "gastos/exterior" donde Totales sólo lleva MontoExento + MontoTotal (+ TotalISRRetencion para E47). */
const TIPOS_TOTALES_EXENTO = new Set(['E43', 'E47']);

/** E47: pago al exterior, tiene bloque Retencion por ítem y IndicadorBienoServicio=2 forzado. */
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

  assertCondition(items.length > 0, 'No se puede generar un XML e-CF sin productos.', { statusCode: 422 });
  assertCondition(totals.total >= 0, 'El monto total del e-CF no puede ser negativo.', { statusCode: 422 });
  assertCondition(document.eNCF, 'Debe indicar el eNCF del documento.', { statusCode: 422 });
  assertCondition(document.tipoeCF, 'Debe indicar el tipo de e-CF.', { statusCode: 422 });
  if (hasFechaVencimiento && isExteriorPayment) {
    assertCondition(
      document.fechaVencimientoSecuencia,
      'El e-CF E47 requiere FechaVencimientoSecuencia en IdDoc.',
      { statusCode: 422 }
    );
  }

  const xml = builder
    .create('ECF', { encoding: 'UTF-8' })
    .att('xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance')
    .att('xmlns:xsd', 'http://www.w3.org/2001/XMLSchema');

  // ── Encabezado ──────────────────────────────────────────────────────────
  const encabezado = xml.ele('Encabezado');
  encabezado.ele('Version').txt('1.0');

  // ── IdDoc ────────────────────────────────────────────────────────────────
  const idDoc = encabezado.ele('IdDoc');
  idDoc.ele('TipoeCF').txt(String(document.tipoeCF).replace(/^E/i, ''));
  idDoc.ele('eNCF').txt(sanitizeText(normalizedEncf));

  // FechaVencimientoSecuencia: E33, E41, E43, E44, E45, E46, E47
  if (hasFechaVencimiento && document.fechaVencimientoSecuencia) {
    idDoc.ele('FechaVencimientoSecuencia').txt(formatDate(document.fechaVencimientoSecuencia));
  }

  // E34: IndicadorNotaCredito en lugar de TipoIngresos
  if (isNotaCredito) {
    const indicador = document.indicadorNotaCredito ?? document.indicadorNotaDebito ?? 1;
    idDoc.ele('IndicadorNotaCredito').txt(String(indicador));
  }

  // TipoIngresos: E31, E32, E33, E41, E44, E45, E46 (NO en E34, E43, E47)
  if (hasTipoIngresos) {
    appendIfValue(idDoc, 'TipoIngresos', document.tipoIngresos || '01');
  }

  // IndicadorMontoGravado: opcional para tipos que lo admiten (E41, E31...)
  if (!isExteriorPayment && !isExentoTotal) {
    appendIfValue(idDoc, 'IndicadorMontoGravado', document.indicadorMontoGravado);
  }

  // TipoPago: todos excepto E43
  if (hasTipoPago) {
    appendIfValue(idDoc, 'TipoPago', document.tipoPago || '1');
  }

  // ── Emisor ───────────────────────────────────────────────────────────────
  const emisor = encabezado.ele('Emisor');
  emisor.ele('RNCEmisor').txt(sanitizeText(emitter.rnc));
  emisor.ele('RazonSocialEmisor').txt(sanitizeText(emitter.razonSocial || emitter.razon_social));
  appendIfValue(emisor, 'NombreComercial', sanitizeText(emitter.nombreComercial || emitter.nombre_comercial, { allowEmpty: true }));
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

  // ── Comprador ────────────────────────────────────────────────────────────
  const buyerTaxId = normalizeBuyerTaxId(customer.rnc || customer.taxId || customer.cedula);
  const comprador = encabezado.ele('Comprador');
  appendIfValue(comprador, 'RNCComprador', buyerTaxId);
  appendIfValue(comprador, 'RazonSocialComprador', sanitizeText(customer.nombre || customer.razonSocial || 'Consumidor Final', { allowEmpty: true }));
  appendIfValue(comprador, 'CorreoComprador', sanitizeText(customer.correo, { allowEmpty: true }));
  appendIfValue(comprador, 'TelefonoAdicional', sanitizeText(customer.telefono, { allowEmpty: true }));
  appendIfValue(comprador, 'DireccionComprador', sanitizeText(customer.direccion, { allowEmpty: true }));

  // ── Totales ──────────────────────────────────────────────────────────────
  const totalsNode = encabezado.ele('Totales');
  if (isExentoTotal) {
    // E43 y E47: sólo MontoExento + MontoTotal (+ TotalISRRetencion para E47)
    appendIfValue(totalsNode, 'MontoExento', totals.total > 0 ? totals.total.toFixed(2) : null);
    totalsNode.ele('MontoTotal').txt(totals.total.toFixed(2));
    if (isExteriorPayment) {
      // E47: TotalISRRetencion es obligatorio incluso si es 0.00
      totalsNode.ele('TotalISRRetencion').txt(
        round2(document.totalIsrRetencion ?? totals.totalIsrRetenido).toFixed(2)
      );
    }
  } else {
    // Tipos con ITBIS (E31, E32, E33, E34, E41, E44, E45, E46)
    appendIfValue(totalsNode, 'MontoGravadoTotal', totals.totalTaxed ? totals.totalTaxed.toFixed(2) : null);
    appendIfValue(totalsNode, 'MontoGravadoI1', totals.taxed18 ? totals.taxed18.toFixed(2) : null);
    appendIfValue(totalsNode, 'MontoGravadoI2', totals.taxed16 ? totals.taxed16.toFixed(2) : null);
    appendIfValue(totalsNode, 'MontoGravadoI3', totals.taxed0 ? totals.taxed0.toFixed(2) : null);
    appendIfValue(totalsNode, 'MontoExento', totals.exemptAmount ? totals.exemptAmount.toFixed(2) : null);
    appendIfValue(totalsNode, 'TotalITBIS', totals.totalTax ? totals.totalTax.toFixed(2) : null);
    appendIfValue(totalsNode, 'DescuentoMonto', totals.totalDiscount ? totals.totalDiscount.toFixed(2) : null);
    totalsNode.ele('MontoTotal').txt(totals.total.toFixed(2));
  }

  // ── DetallesItems ────────────────────────────────────────────────────────
  const detallesItems = xml.ele('DetallesItems');
  for (const item of totals.items) {
    const detalle = detallesItems.ele('Item');
    detalle.ele('NumeroLinea').txt(String(item.lineNumber));

    if (isExteriorPayment) {
      // E47: orden XSD → NumeroLinea, IndicadorFacturacion, Retencion, NombreItem,
      //                   IndicadorBienoServicio(=2), DescripcionItem, CantidadItem,
      //                   UnidadMedida, PrecioUnitarioItem, MontoItem
      detalle.ele('IndicadorFacturacion').txt(String(item.billingIndicator ?? 4));
      const retencion = detalle.ele('Retencion');
      retencion.ele('IndicadorAgenteRetencionoPercepcion').txt(
        String(item.retentionIndicator ?? document.retentionIndicator ?? 1)
      );
      retencion.ele('MontoISRRetenido').txt(round2(item.withholdingAmount ?? 0).toFixed(2));
      detalle.ele('NombreItem').txt(item.name);
      // E47 exige IndicadorBienoServicio=2 (servicio) siempre
      detalle.ele('IndicadorBienoServicio').txt('2');
      appendIfValue(detalle, 'DescripcionItem', item.additionalDescription || null);
      detalle.ele('CantidadItem').txt(item.quantity.toFixed(2));
      appendIfValue(detalle, 'UnidadMedida', item.unitMeasure || null);
      detalle.ele('PrecioUnitarioItem').txt(item.unitPrice.toFixed(2));
      detalle.ele('MontoItem').txt(item.taxableBase.toFixed(2));
    } else {
      // Tipos normales: orden XSD → NumeroLinea, NombreItem, CantidadItem,
      //                 PrecioUnitarioItem, DescuentoMonto, MontoItem, TasaITBIS, ITBISItem
      detalle.ele('NombreItem').txt(item.name);
      detalle.ele('CantidadItem').txt(item.quantity.toFixed(2));
      detalle.ele('PrecioUnitarioItem').txt(item.unitPrice.toFixed(2));
      appendIfValue(detalle, 'DescuentoMonto', item.discount ? item.discount.toFixed(2) : null);
      appendIfValue(detalle, 'MontoItem', item.taxableBase.toFixed(2));
      appendIfValue(detalle, 'TasaITBIS', item.taxRate ? item.taxRate.toFixed(2) : null);
      appendIfValue(detalle, 'ITBISItem', item.taxAmount ? item.taxAmount.toFixed(2) : null);
      appendIfValue(detalle, 'MontoItemMasITBIS', item.lineTotal.toFixed(2));
    }
  }

  // ── InformacionReferencia (notas de crédito/débito) ──────────────────────
  if (document.referencia) {
    const referencia = xml.ele('InformacionReferencia');
    appendIfValue(referencia, 'NCFModificado', sanitizeText(document.referencia.ncfModificado, { allowEmpty: true }));
    appendIfValue(referencia, 'FechaNCFModificado', sanitizeText(document.referencia.fechaNcfModificado, { allowEmpty: true }));
    appendIfValue(referencia, 'CodigoModificacion', sanitizeText(document.referencia.codigoModificacion, { allowEmpty: true }));
  }

  xml.ele('FechaHoraFirma').txt(formatDateTime(new Date()));

  return {
    xml: xml.end({ pretty: true }),
    totals,
  };
}

function generateRfceXml(payload) {
  const emitter = payload?.emitter || {};
  const document = payload?.document || {};
  const totals = payload?.totals || {};
  const issueDate = payload?.issueDate || new Date();
  const paymentForms = Array.isArray(payload?.paymentForms) ? payload.paymentForms : [];
  const codigoSeguridad = sanitizeText(payload?.document?.codigoSeguridad || payload?.securityCode, { allowEmpty: true });

  if (String(document.tipoeCF || '').replace(/^E/i, '') !== '32') {
    throw new EcfError('El resumen RFCE solo aplica para documentos E32.', { statusCode: 422 });
  }
  if (!codigoSeguridad) {
    throw new EcfError('El RFCE requiere CodigoSeguridadeCF para ser enviado a DGII.', { statusCode: 422 });
  }

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
  emisor.ele('RazonSocialEmisor').txt(sanitizeText(emitter.razonSocial || emitter.razon_social));
  emisor.ele('FechaEmision').txt(formatDate(issueDate));

  const comprador = encabezado.ele('Comprador');
  appendIfValue(comprador, 'RNCComprador', normalizeBuyerTaxId(payload?.customer?.rnc));
  appendIfValue(comprador, 'RazonSocialComprador', sanitizeText(payload?.customer?.nombre || 'Consumidor Final', { allowEmpty: true }));

  const totalNode = encabezado.ele('Totales');
  appendIfValue(totalNode, 'MontoGravadoTotal', Number(totals.totalTaxed || 0).toFixed(2));
  appendIfValue(totalNode, 'MontoGravadoI1', Number(totals.taxed18 || 0).toFixed(2));
  appendIfValue(totalNode, 'MontoGravadoI2', Number(totals.taxed16 || 0).toFixed(2));
  appendIfValue(totalNode, 'MontoGravadoI3', Number(totals.taxed0 || 0).toFixed(2));
  appendIfValue(totalNode, 'MontoExento', Number(totals.exemptAmount || 0).toFixed(2));
  appendIfValue(totalNode, 'TotalITBIS', Number(totals.totalTax || 0).toFixed(2));
  appendIfValue(totalNode, 'TotalITBIS1', Number(totals.totalTax || 0).toFixed(2));
  totalNode.ele('MontoTotal').txt(Number(totals.total || 0).toFixed(2));
  encabezado.ele('CodigoSeguridadeCF').txt(codigoSeguridad);

  return xml.end({ pretty: true });
}

module.exports = {
  buildTotals,
  generateEcfXml,
  generateRfceXml,
  normalizeEncfValue,
  normalizeEcfXmlStructure,
  round2,
};
