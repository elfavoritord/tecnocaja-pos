'use strict';

const builder = require('xmlbuilder');
const XLSX = require('xlsx');
const { getDocumentType } = require('../config/document-types');
const { generateEcfXml, generateRfceXml, round2 } = require('./ecf-generator');
const signatureService = require('../signature/signature.service');
const { EcfError, assertCondition } = require('../utils/errors');

const TYPE_DEFAULTS = Object.freeze({
  E31: { montoBase: 5000, itbisRate: 18, tipoPago: '1', tipoIngresos: '01', buyerMode: 'emitter', submissionMode: 'normal' },
  E32: { montoBase: 1000, itbisRate: 18, tipoPago: '1', tipoIngresos: '01', buyerMode: 'consumer_final', submissionMode: 'rfce' },
  E33: { montoBase: 500, itbisRate: 0, tipoPago: '1', tipoIngresos: '01', buyerMode: 'emitter', submissionMode: 'normal' },
  E34: { montoBase: 500, itbisRate: 0, tipoPago: '1', tipoIngresos: '01', buyerMode: 'emitter', submissionMode: 'normal' },
  E41: { montoBase: 2000, itbisRate: 18, tipoPago: '1', tipoIngresos: '01', buyerMode: 'emitter', submissionMode: 'normal' },
  E43: { montoBase: 500, itbisRate: 0, tipoPago: '1', tipoIngresos: '01', buyerMode: 'consumer_final', submissionMode: 'normal' },
  E44: { montoBase: 3000, itbisRate: 18, tipoPago: '1', tipoIngresos: '01', buyerMode: 'emitter', submissionMode: 'normal' },
  E45: { montoBase: 2000, itbisRate: 0, tipoPago: '1', tipoIngresos: '01', buyerMode: 'emitter', submissionMode: 'normal' },
  E46: { montoBase: 5000, itbisRate: 0, tipoPago: '1', tipoIngresos: '01', buyerMode: 'consumer_final', submissionMode: 'normal' },
  E47: { montoBase: 3000, itbisRate: 0, tipoPago: '1', tipoIngresos: null, buyerMode: 'consumer_final', submissionMode: 'normal' },
});

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function isSpecialValue(value) {
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  return normalized === '' || normalized === '#e' || normalized === 'n/a' || normalized === 'na' || normalized === '#n/a' || normalized === '#ref!';
}

function normalizeHeader(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^\w]/g, '');
}

function splitCsvLine(line, separator) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (const char of String(line || '')) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === separator && !inQuotes) {
      result.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  result.push(current);
  return result.map((value) => value.trim());
}

function parseDgiiDate(value) {
  if (!value || isSpecialValue(value)) return null;
  const text = String(value).trim();

  if (/^\d+$/.test(text)) {
    const parsed = XLSX.SSF.parse_date_code(Number(text));
    if (parsed) {
      return `${String(parsed.y).padStart(4, '0')}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
    }
  }

  const dmyMatch = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmyMatch) {
    return `${dmyMatch[3]}-${dmyMatch[2].padStart(2, '0')}-${dmyMatch[1].padStart(2, '0')}`;
  }

  const ymdMatch = text.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (ymdMatch) {
    return `${ymdMatch[1]}-${ymdMatch[2]}-${ymdMatch[3]}`;
  }

  return null;
}

function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  assertCondition(!Number.isNaN(date.getTime()), 'Fecha y hora inválida para el set DGII.');
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear());
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${day}-${month}-${year} ${hour}:${minute}:${second}`;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeRowValue(value) {
  return isSpecialValue(value) ? '' : String(value ?? '').trim();
}

function rowHasValue(row, key) {
  return Boolean(normalizeRowValue(row?.[key]));
}

function rowText(row, key) {
  return normalizeRowValue(row?.[key]);
}

function rowNumber(row, key) {
  const raw = rowText(row, key).replace(/,/g, '.');
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMoney(value) {
  return (Math.round((Number(value) + Number.EPSILON) * 100) / 100).toFixed(2);
}

function calculatedItbisTotal(row, bucket) {
  const taxableAmount = rowNumber(row, `MontoGravadoI${bucket}`);
  const taxRate = rowNumber(row, `ITBIS${bucket}`);
  if (taxableAmount === null || taxRate === null) return null;
  return formatMoney(taxableAmount * taxRate / 100);
}

function totalFieldValue(row, field) {
  if (rowHasValue(row, field)) return row[field];

  const match = String(field || '').match(/^TotalITBIS([123])$/);
  if (match) {
    const calculated = calculatedItbisTotal(row, match[1]);
    if (calculated !== null) return calculated;
  }
  if (field === 'TotalITBIS') {
    const values = [1, 2, 3]
      .map((bucket) => calculatedItbisTotal(row, bucket))
      .filter((value) => value !== null)
      .map(Number);
    if (values.length) return formatMoney(values.reduce((sum, value) => sum + value, 0));
  }
  return row[field];
}

function appendSimple(node, tagName, value) {
  const text = normalizeRowValue(value);
  if (!text) return;
  node.ele(tagName).txt(text);
}

function normalizeEmitterOverrideValue(value) {
  return normalizeRowValue(value);
}

function applyEmitterOverridesToRow(row, emitter = null) {
  const next = { ...(row || {}) };
  if (!emitter) return next;

  const rnc = digitsOnly(
    normalizeEmitterOverrideValue(emitter.rnc)
      || normalizeEmitterOverrideValue(emitter.rncEmisor)
      || normalizeEmitterOverrideValue(emitter.RNCEmisor)
  );
  const razonSocial = normalizeEmitterOverrideValue(emitter.razonSocial)
    || normalizeEmitterOverrideValue(emitter.razon_social)
    || normalizeEmitterOverrideValue(emitter.nombre)
    || normalizeEmitterOverrideValue(emitter.name);

  if (rnc && !rowHasValue(next, 'RNCEmisor')) next.RNCEmisor = rnc;
  if (razonSocial && !rowHasValue(next, 'RazonSocialEmisor')) {
    next.RazonSocialEmisor = razonSocial;
  }

  if (
    !rowHasValue(next, 'NombreComercial')
    && (
      Object.prototype.hasOwnProperty.call(emitter, 'nombreComercial')
      || Object.prototype.hasOwnProperty.call(emitter, 'nombre_comercial')
    )
  ) {
    next.NombreComercial = normalizeEmitterOverrideValue(
      emitter.nombreComercial ?? emitter.nombre_comercial
    );
  }

  return next;
}

// NOTA sobre PrecioUnitarioItem y PrecioUnitarioReferencia:
// DGII valida los campos contra el valor EXACTO del set de pruebas que ellos definieron.
// Si el set DGII tiene "220.00" (2 decimales) y enviamos "220.0000" (4 decimales), rechazan.
// Si el set DGII tiene "115000.0000" (4 decimales) y enviamos "115000.00", también rechazan.
// Por eso usamos appendSimple (valor tal cual viene de la hoja) — el spreadsheet DGII ya
// contiene el formato exacto que DGII espera. No convertir decimales.

function collectIndexedSubGroups(row, prefix) {
  const groups = new Map();
  const pattern = new RegExp(`^${escapeRegExp(prefix)}\\[(\\d+)\\]\\[(\\d+)\\]$`, 'i');
  for (const key of Object.keys(row || {})) {
    const match = String(key || '').trim().match(pattern);
    if (!match) continue;
    const line = Number(match[1]);
    const subIndex = Number(match[2]);
    const value = normalizeRowValue(row[key]);
    if (!groups.has(line)) groups.set(line, new Map());
    groups.get(line).set(subIndex, value);
  }
  return groups;
}

function appendItemAdjustmentTable({
  itemNode,
  row,
  lineIndex,
  amountField,
  typePrefix,
  percentPrefix,
  amountPrefix,
  tableTag,
  rowTag,
  typeTag,
  percentTag,
  amountTag,
}) {
  appendSimple(itemNode, amountField, row[`${amountField}[${lineIndex}]`]);

  const types = collectIndexedSubGroups(row, typePrefix).get(lineIndex) || new Map();
  const percents = collectIndexedSubGroups(row, percentPrefix).get(lineIndex) || new Map();
  const amounts = collectIndexedSubGroups(row, amountPrefix).get(lineIndex) || new Map();
  const subIndexes = Array.from(new Set([
    ...types.keys(),
    ...percents.keys(),
    ...amounts.keys(),
  ])).sort((a, b) => a - b);

  const validIndexes = subIndexes.filter((subIndex) => (
    normalizeRowValue(types.get(subIndex))
    || normalizeRowValue(percents.get(subIndex))
    || normalizeRowValue(amounts.get(subIndex))
  ));

  if (!validIndexes.length) return;

  const table = itemNode.ele(tableTag);
  for (const subIndex of validIndexes) {
    const rowNode = table.ele(rowTag);
    appendSimple(rowNode, typeTag, types.get(subIndex));
    appendSimple(rowNode, percentTag, percents.get(subIndex));
    appendSimple(rowNode, amountTag, amounts.get(subIndex));
  }
}

function computeSecurityCodeFromSignedXml(signedXml) {
  const signatureValue = String(
    (String(signedXml || '').match(/<SignatureValue[^>]*>([^<]+)<\/SignatureValue>/i) || [])[1] || ''
  ).trim();
  if (!signatureValue) return null;
  return signatureValue.slice(0, 6);
}

function collectIndexedEntries(row, prefix) {
  const entries = [];
  const pattern = new RegExp(`^${escapeRegExp(prefix)}\\[(\\d+)\\]$`, 'i');
  for (const key of Object.keys(row || {})) {
    const match = String(key || '').trim().match(pattern);
    if (!match) continue;
    const index = Number(match[1]);
    const value = normalizeRowValue(row[key]);
    if (!value) continue;
    entries.push({ index, key, value });
  }
  return entries.sort((a, b) => a.index - b.index);
}

function collectIndexedGroups(row, prefix) {
  const groups = new Map();
  const pattern = new RegExp(`^${escapeRegExp(prefix)}\\[(\\d+)\\]\\[(\\d+)\\]$`, 'i');
  for (const key of Object.keys(row || {})) {
    const match = String(key || '').trim().match(pattern);
    if (!match) continue;
    const line = Number(match[1]);
    const subIndex = Number(match[2]);
    const value = normalizeRowValue(row[key]);
    if (!value) continue;
    if (!groups.has(line)) groups.set(line, new Map());
    groups.get(line).set(subIndex, value);
  }
  return groups;
}

function summarizeTotalsFromRow(row) {
  const total = rowNumber(row, 'MontoTotal') ?? 0;
  const totalTaxed = rowNumber(row, 'MontoGravadoTotal') ?? 0;
  const exemptAmount = rowNumber(row, 'MontoExento') ?? 0;
  const totalTax = rowNumber(row, 'TotalITBIS') ?? 0;
  const totalDiscount = 0;
  const subtotal = round2(totalTaxed + exemptAmount);
  return {
    items: [],
    subtotal,
    totalDiscount,
    exemptAmount,
    taxed18: rowNumber(row, 'MontoGravadoI1') ?? 0,
    taxed16: rowNumber(row, 'MontoGravadoI2') ?? 0,
    taxed0: rowNumber(row, 'MontoGravadoI3') ?? 0,
    totalTax,
    total,
    totalTaxed,
    totalIsrRetenido: rowNumber(row, 'TotalISRRetencion') ?? 0,
  };
}

function buildDeferredTotals(testCase, defaults = {}) {
  if (testCase?.rawRow) return summarizeTotalsFromRow(testCase.rawRow);
  const total = round2(Number(testCase?.totalAmount || defaults.montoBase || 0));
  const taxRate = Number(defaults.itbisRate || 0);
  const totalTaxed = taxRate > 0 ? round2(total / (1 + (taxRate / 100))) : total;
  const totalTax = taxRate > 0 ? round2(total - totalTaxed) : 0;
  return {
    items: [],
    subtotal: totalTaxed,
    totalDiscount: 0,
    exemptAmount: taxRate > 0 ? 0 : total,
    taxed18: taxRate === 18 ? totalTaxed : 0,
    taxed16: taxRate === 16 ? totalTaxed : 0,
    taxed0: taxRate > 0 ? 0 : total,
    totalTax,
    total,
    totalTaxed: taxRate > 0 ? totalTaxed : 0,
    totalIsrRetenido: 0,
  };
}

function inferSubmissionModeForImport(testCase, defaults = {}) {
  const explicitMode = String(testCase?.submissionMode || '').trim().toLowerCase();
  if (explicitMode === 'rfce') return 'rfce';
  if (explicitMode === 'normal') return 'normal';

  const sourceSheet = String(testCase?.sourceSheet || '').trim().toUpperCase();
  if (sourceSheet === 'RFCE') return 'rfce';
  if (sourceSheet === 'ECF') return 'normal';

  const originalXml = String(testCase?.originalXml || '').trim();
  if (/^<\?xml[\s\S]*<RFCE[\s>]/i.test(originalXml) || /^<RFCE[\s>]/i.test(originalXml)) return 'rfce';
  if (/^<\?xml[\s\S]*<ECF[\s>]/i.test(originalXml) || /^<ECF[\s>]/i.test(originalXml)) return 'normal';

  return defaults.submissionMode || 'normal';
}

function buildCertificationCaseCustomer(testCase, defaults, emitter) {
  if (testCase.rawRow) {
    return {
      rnc: digitsOnly(rowText(testCase.rawRow, 'RNCComprador')),
      nombre: rowText(testCase.rawRow, 'RazonSocialComprador') || 'Consumidor Final',
      correo: rowText(testCase.rawRow, 'CorreoComprador'),
      telefono: rowText(testCase.rawRow, 'TelefonoAdicional'),
      direccion: rowText(testCase.rawRow, 'DireccionComprador'),
    };
  }
  return buildCustomer(testCase, defaults, emitter);
}

function buildCertificationEcfXml(testCase, issueDate) {
  const row = testCase.rawRow || {};
  const xml = builder
    .create('ECF', { encoding: 'UTF-8' })
    .att('xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance')
    .att('xmlns:xsd', 'http://www.w3.org/2001/XMLSchema');

  const encabezado = xml.ele('Encabezado');
  encabezado.ele('Version').txt(rowText(row, 'Version') || '1.0');

  const idDoc = encabezado.ele('IdDoc');
  idDoc.ele('TipoeCF').txt(String(testCase.tipoEcf || rowText(row, 'TipoeCF')).replace(/^E/i, ''));
  idDoc.ele('eNCF').txt(testCase.encf);
  [
    'FechaVencimientoSecuencia',
    'IndicadorNotaCredito',
    'IndicadorEnvioDiferido',
    'IndicadorMontoGravado',
    'IndicadorServicioTodoIncluido',
    'TipoIngresos',
    'TipoPago',
    'FechaLimitePago',
    'TerminoPago',
  ].forEach((field) => appendSimple(idDoc, field, row[field]));

  const paymentForms = collectIndexedEntries(row, 'FormaPago');
  if (paymentForms.length) {
    const table = idDoc.ele('TablaFormasPago');
    for (const entry of paymentForms) {
      const amount = rowText(row, `MontoPago[${entry.index}]`);
      const form = table.ele('FormaDePago');
      form.ele('FormaPago').txt(entry.value);
      appendSimple(form, 'MontoPago', amount);
    }
  }

  ['TipoCuentaPago', 'NumeroCuentaPago', 'BancoPago', 'FechaDesde', 'FechaHasta', 'TotalPaginas']
    .forEach((field) => appendSimple(idDoc, field, row[field]));

  const emisor = encabezado.ele('Emisor');
  [
    'RNCEmisor',
    'RazonSocialEmisor',
  ].forEach((field) => appendSimple(emisor, field, row[field]));

  // NombreComercial del emisor: DGII valida este campo contra el valor registrado en su BD para el RNC.
  // Si el Excel del set de pruebas tiene un valor diferente al registrado en DGII, la validación falla.
  // Por eso usamos el valor del emisor LOCAL (que el usuario controla). Si está vacío, no se incluye.
  // El usuario debe asegurarse de que 'nombre_comercial' en la configuración coincida con lo que
  // tiene registrado en DGII (o dejarlo vacío si el RNC no tiene NombreComercial en DGII).
  const emitterNombreComercial = ('emitterNombreComercial' in testCase)
    ? testCase.emitterNombreComercial
    : rowText(row, 'NombreComercial');
  appendSimple(emisor, 'NombreComercial', emitterNombreComercial);

  [
    'Sucursal',
    'DireccionEmisor',
    'Municipio',
    'Provincia',
  ].forEach((field) => appendSimple(emisor, field, row[field]));
  const emitterPhones = collectIndexedEntries(row, 'TelefonoEmisor');
  if (emitterPhones.length) {
    const table = emisor.ele('TablaTelefonoEmisor');
    for (const entry of emitterPhones) {
      table.ele('TelefonoEmisor').txt(entry.value);
    }
  }
  [
    'CorreoEmisor',
    'WebSite',
    'ActividadEconomica',
    'CodigoVendedor',
    'NumeroFacturaInterna',
    'NumeroPedidoInterno',
    'ZonaVenta',
    'RutaVenta',
    'InformacionAdicionalEmisor',
    'FechaEmision',
  ].forEach((field) => appendSimple(emisor, field, row[field]));

  // E43 (Gastos Menores) y otros tipos sin comprador formal no tienen datos en el Comprador.
  // Si todos los campos están vacíos NO se debe crear <Comprador /> vacío porque el XSD DGII
  // requiere RNCComprador dentro de Comprador cuando el elemento existe.
  // Solución: solo crear <Comprador> cuando al menos un campo tiene valor.
  const compradorFields = [
    'RNCComprador',
    'IdentificadorExtranjero',
    'RazonSocialComprador',
    'ContactoComprador',
    'CorreoComprador',
    'DireccionComprador',
    'MunicipioComprador',
    'ProvinciaComprador',
    'PaisComprador',
    'FechaEntrega',
    'ContactoEntrega',
    'DireccionEntrega',
    'TelefonoAdicional',
    'FechaOrdenCompra',
    'NumeroOrdenCompra',
    'CodigoInternoComprador',
    'ResponsablePago',
    'InformacionAdicionalComprador',
  ];
  const hasCompradorData = compradorFields.some((f) => rowHasValue(row, f));
  if (hasCompradorData) {
    const comprador = encabezado.ele('Comprador');
    compradorFields.forEach((field) => appendSimple(comprador, field, row[field]));
  }

  const informacionAdicionalFields = [
    'FechaEmbarque',
    'NumeroEmbarque',
    'NumeroContenedor',
    'NumeroContenedor ',
    'NumeroReferencia',
    'PesoBruto',
    'PesoNeto',
    'UnidadPesoBruto',
    'UnidadPesoNeto',
    'CantidadBulto',
    'UnidadBulto',
    'VolumenBulto',
    'UnidadVolumen',
  ];
  if (informacionAdicionalFields.some((field) => rowHasValue(row, field))) {
    const info = encabezado.ele('InformacionesAdicionales');
    informacionAdicionalFields.forEach((field) => appendSimple(info, field.trim(), row[field]));
  }

  const transporteFields = [
    'Conductor',
    'DocumentoTransporte',
    'Ficha',
    'Placa',
    'RutaTransporte',
    'ZonaTransporte',
    'NumeroAlbaran',
  ];
  if (transporteFields.some((field) => rowHasValue(row, field))) {
    const transporte = encabezado.ele('Transporte');
    transporteFields.forEach((field) => appendSimple(transporte, field.trim(), row[field]));
  }

  const totalsNode = encabezado.ele('Totales');
  [
    'MontoGravadoTotal',
    'MontoGravadoI1',
    'MontoGravadoI2',
    'MontoGravadoI3',
    'MontoExento',
    'ITBIS1',
    'ITBIS2',
    'ITBIS3',
    'TotalITBIS',
    'TotalITBIS1',
    'TotalITBIS2',
    'TotalITBIS3',
    'MontoImpuestoAdicional',
  ].forEach((field) => appendSimple(totalsNode, field, totalFieldValue(row, field)));

  // ImpuestosAdicionales: tabla de ISC/impuestos selectivos al consumo.
  // Requerida por el XSD cuando MontoImpuestoAdicional > 0 (e.g. bebidas alcohólicas E31).
  // Sin esta tabla, DGII no puede reconciliar TotalITBIS1 cuando la base ITBIS incluye ISC.
  // Fields: TipoImpuesto[i], TasaImpuestoAdicional[i], MontoImpuestoSelectivoConsumoEspecifico[i],
  //         MontoImpuestoSelectivoConsumoAdvalorem[i], OtrosImpuestosAdicionales[i]
  const additionalTaxIndexes = [];
  for (let i = 1; i <= 20; i++) {
    if (rowHasValue(row, `TipoImpuesto[${i}]`)) {
      additionalTaxIndexes.push(i);
    }
  }
  if (additionalTaxIndexes.length) {
    const impuestosAdicionalesNode = totalsNode.ele('ImpuestosAdicionales');
    for (const i of additionalTaxIndexes) {
      const impuestoNode = impuestosAdicionalesNode.ele('ImpuestoAdicional');
      appendSimple(impuestoNode, 'TipoImpuesto', row[`TipoImpuesto[${i}]`]);
      appendSimple(impuestoNode, 'TasaImpuestoAdicional', row[`TasaImpuestoAdicional[${i}]`]);
      appendSimple(impuestoNode, 'MontoImpuestoSelectivoConsumoEspecifico', row[`MontoImpuestoSelectivoConsumoEspecifico[${i}]`]);
      appendSimple(impuestoNode, 'MontoImpuestoSelectivoConsumoAdvalorem', row[`MontoImpuestoSelectivoConsumoAdvalorem[${i}]`]);
      appendSimple(impuestoNode, 'OtrosImpuestosAdicionales', row[`OtrosImpuestosAdicionales[${i}]`]);
    }
  }

  [
    'MontoTotal',
    'MontoNoFacturable',
    'MontoPeriodo',
    'SaldoAnterior',
    'MontoAvancePago',
    'ValorPagar',
    'TotalITBISRetenido',
    'TotalISRRetencion',
    'TotalITBISPercepcion',
    'TotalISRPercepcion',
  ].forEach((field) => appendSimple(totalsNode, field, row[field]));

  const otherCurrencyFields = [
    'TipoMoneda',
    'TipoCambio',
    'MontoGravadoTotalOtraMoneda',
    'MontoGravado1OtraMoneda',
    'MontoGravado2OtraMoneda',
    'MontoGravado3OtraMoneda',
    'MontoExentoOtraMoneda',
    'TotalITBISOtraMoneda',
    'TotalITBIS1OtraMoneda',
    'TotalITBIS2OtraMoneda',
    'TotalITBIS3OtraMoneda',
    'MontoImpuestoAdicionalOtraMoneda',
    'MontoTotalOtraMoneda',
  ];
  if (otherCurrencyFields.some((field) => rowHasValue(row, field))) {
    const otherCurrency = encabezado.ele('OtraMoneda');
    otherCurrencyFields.forEach((field) => appendSimple(otherCurrency, field, row[field]));
  }

  const detallesItems = xml.ele('DetallesItems');
  const itemIndexes = new Set();
  for (const key of Object.keys(row)) {
    const match = String(key || '').trim().match(/^(NumeroLinea|NombreItem|CantidadItem|PrecioUnitarioItem|MontoItem|IndicadorFacturacion|IndicadorBienoServicio|DescripcionItem|MontoItemMasITBIS|TasaITBIS|ITBISItem|UnidadMedida|CantidadReferencia|UnidadReferencia|PrecioUnitarioReferencia|FechaElaboracion|FechaVencimientoItem|PesoNetoKilogramo|PesoNetoMineria|TipoAfiliacion|Liquidacion|DescuentoMonto|RecargoMonto)\[(\d+)\]$/i);
    if (match && rowHasValue(row, key)) {
      itemIndexes.add(Number(match[2]));
    }
  }

  const codeTypes = collectIndexedGroups(row, 'TipoCodigo');
  const codeItems = collectIndexedGroups(row, 'CodigoItem');

  for (const lineIndex of Array.from(itemIndexes).sort((a, b) => a - b)) {
    const item = detallesItems.ele('Item');
    appendSimple(item, 'NumeroLinea', row[`NumeroLinea[${lineIndex}]`] || String(lineIndex));

    const codesForLine = new Set([
      ...Array.from(codeTypes.get(lineIndex)?.keys() || []),
      ...Array.from(codeItems.get(lineIndex)?.keys() || []),
    ]);
    if (codesForLine.size) {
      const table = item.ele('TablaCodigosItem');
      for (const subIndex of Array.from(codesForLine).sort((a, b) => a - b)) {
        const rowNode = table.ele('CodigosItem');
        appendSimple(rowNode, 'TipoCodigo', codeTypes.get(lineIndex)?.get(subIndex) || '');
        appendSimple(rowNode, 'CodigoItem', codeItems.get(lineIndex)?.get(subIndex) || '');
      }
    }

    appendSimple(item, 'IndicadorFacturacion', row[`IndicadorFacturacion[${lineIndex}]`]);

    const hasRetention = [
      `IndicadorAgenteRetencionoPercepcion[${lineIndex}]`,
      `MontoITBISRetenido[${lineIndex}]`,
      `MontoISRRetenido[${lineIndex}]`,
    ].some((field) => rowHasValue(row, field));
    if (hasRetention) {
      const retention = item.ele('Retencion');
      appendSimple(retention, 'IndicadorAgenteRetencionoPercepcion', row[`IndicadorAgenteRetencionoPercepcion[${lineIndex}]`]);
      appendSimple(retention, 'MontoITBISRetenido', row[`MontoITBISRetenido[${lineIndex}]`]);
      appendSimple(retention, 'MontoISRRetenido', row[`MontoISRRetenido[${lineIndex}]`]);
    }

    [
      'NombreItem',
      'IndicadorBienoServicio',
      'DescripcionItem',
      'CantidadItem',
      'UnidadMedida',
      'CantidadReferencia',
      'UnidadReferencia',
    ].forEach((field) => appendSimple(item, field, row[`${field}[${lineIndex}]`]));

    // TablaSubcantidad: sub-cantidades del ítem (e.g. volumen por unidad para bebidas).
    // Debe ir DESPUÉS de UnidadReferencia y ANTES de GradosAlcohol según el XSD.
    // Fields: Subcantidad[lineIndex][subIndex], CodigoSubcantidad[lineIndex][subIndex] (hasta 5)
    const subcantidadSubIndexes = [];
    for (let j = 1; j <= 5; j++) {
      if (rowHasValue(row, `Subcantidad[${lineIndex}][${j}]`) || rowHasValue(row, `CodigoSubcantidad[${lineIndex}][${j}]`)) {
        subcantidadSubIndexes.push(j);
      }
    }
    if (subcantidadSubIndexes.length) {
      const tablaSubcantidad = item.ele('TablaSubcantidad');
      for (const j of subcantidadSubIndexes) {
        const subcantidadItem = tablaSubcantidad.ele('SubcantidadItem');
        appendSimple(subcantidadItem, 'Subcantidad', row[`Subcantidad[${lineIndex}][${j}]`]);
        appendSimple(subcantidadItem, 'CodigoSubcantidad', row[`CodigoSubcantidad[${lineIndex}][${j}]`]);
      }
    }

    [
      'GradosAlcohol',
      'PrecioUnitarioReferencia',
      'FechaElaboracion',
      'FechaVencimientoItem',
      'PesoNetoKilogramo',
      'PesoNetoMineria',
      'TipoAfiliacion',
      'Liquidacion',
      'PrecioUnitarioItem',
      'MontoItemMasITBIS',
      'TasaITBIS',
      'ITBISItem',
    ].forEach((field) => appendSimple(item, field, row[`${field}[${lineIndex}]`]));

    appendItemAdjustmentTable({
      itemNode: item,
      row,
      lineIndex,
      amountField: 'DescuentoMonto',
      typePrefix: 'TipoSubDescuento',
      percentPrefix: 'SubDescuentoPorcentaje',
      amountPrefix: 'MontoSubDescuento',
      tableTag: 'TablaSubDescuento',
      rowTag: 'SubDescuento',
      typeTag: 'TipoSubDescuento',
      percentTag: 'SubDescuentoPorcentaje',
      amountTag: 'MontoSubDescuento',
    });

    appendItemAdjustmentTable({
      itemNode: item,
      row,
      lineIndex,
      amountField: 'RecargoMonto',
      typePrefix: 'TipoSubRecargo',
      percentPrefix: 'SubRecargoPorcentaje',
      amountPrefix: 'MontoSubRecargo',
      tableTag: 'TablaSubRecargo',
      rowTag: 'SubRecargo',
      typeTag: 'TipoSubRecargo',
      percentTag: 'SubRecargoPorcentaje',
      amountTag: 'MontoSubRecargo',
    });

    // TablaImpuestoAdicional: tipos de ISC del ítem (e.g. cerveza/alcohol).
    // Requerida para que DGII pueda incluir el ISC en la base del ITBIS al validar TotalITBIS1.
    // Solo incluye TipoImpuesto[lineIndex][subIndex] — los montos van en la tabla global de Totales.
    const itemTaxSubIndexes = [];
    for (let j = 1; j <= 2; j++) {
      if (rowHasValue(row, `TipoImpuesto[${lineIndex}][${j}]`)) {
        itemTaxSubIndexes.push(j);
      }
    }
    if (itemTaxSubIndexes.length) {
      const tablaImpuestoAdicional = item.ele('TablaImpuestoAdicional');
      for (const j of itemTaxSubIndexes) {
        const impuestoItem = tablaImpuestoAdicional.ele('ImpuestoAdicional');
        appendSimple(impuestoItem, 'TipoImpuesto', row[`TipoImpuesto[${lineIndex}][${j}]`]);
      }
    }

    appendSimple(item, 'MontoItem', row[`MontoItem[${lineIndex}]`]);
  }

  const adjustmentIndexes = new Set();
  for (const key of Object.keys(row)) {
    const match = String(key || '').trim().match(/^(TipoAjuste|IndicadorNorma1007|DescripcionDescuentooRecargo|TipoValor|ValorDescuentooRecargo|MontoDescuentooRecargo|MontoDescuentooRecargoOtraMoneda|IndicadorFacturacionDescuentooRecargo)\[(\d+)\]$/i);
    if (match && rowHasValue(row, key)) {
      adjustmentIndexes.add(Number(match[2]));
    }
  }
  if (adjustmentIndexes.size) {
    const adjustments = xml.ele('DescuentosORecargos');
    for (const index of Array.from(adjustmentIndexes).sort((a, b) => a - b)) {
      const rowNode = adjustments.ele('DescuentoORecargo');
      appendSimple(rowNode, 'NumeroLinea', row[`NumeroLineaDR[${index}]`] || String(index));
      appendSimple(rowNode, 'TipoAjuste', row[`TipoAjuste[${index}]`]);
      appendSimple(rowNode, 'IndicadorNorma1007', row[`IndicadorNorma1007[${index}]`]);
      appendSimple(rowNode, 'DescripcionDescuentooRecargo', row[`DescripcionDescuentooRecargo[${index}]`]);
      appendSimple(rowNode, 'TipoValor', row[`TipoValor[${index}]`]);
      appendSimple(rowNode, 'ValorDescuentooRecargo', row[`ValorDescuentooRecargo[${index}]`]);
      appendSimple(rowNode, 'MontoDescuentooRecargo', row[`MontoDescuentooRecargo[${index}]`]);
      appendSimple(rowNode, 'MontoDescuentooRecargoOtraMoneda', row[`MontoDescuentooRecargoOtraMoneda[${index}]`]);
      appendSimple(rowNode, 'IndicadorFacturacionDescuentooRecargo', row[`IndicadorFacturacionDescuentooRecargo[${index}]`]);
    }
  }

  const hasReference = ['NCFModificado', 'RNCOtroContribuyente', 'FechaNCFModificado', 'CodigoModificacion', 'RazonModificacion']
    .some((field) => rowHasValue(row, field));
  if (hasReference) {
    const ref = xml.ele('InformacionReferencia');
    ['NCFModificado', 'RNCOtroContribuyente', 'FechaNCFModificado', 'CodigoModificacion', 'RazonModificacion']
      .forEach((field) => appendSimple(ref, field, row[field]));
  }

  xml.ele('FechaHoraFirma').txt(formatDateTime(issueDate));

  return {
    submissionMode: 'normal',
    xml: xml.end({ pretty: true }),
    totals: summarizeTotalsFromRow(row),
  };
}

function buildCertificationRfceXml(testCase, issueDate) {
  const row = testCase.rawRow || {};
  const xml = builder
    .create('RFCE', { encoding: 'UTF-8' })
    .att('xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance')
    .att('xmlns:xsd', 'http://www.w3.org/2001/XMLSchema');

  const encabezado = xml.ele('Encabezado');
  encabezado.ele('Version').txt(rowText(row, 'Version') || '1.0');

  const idDoc = encabezado.ele('IdDoc');
  idDoc.ele('TipoeCF').txt(String(testCase.tipoEcf || rowText(row, 'TipoeCF')).replace(/^E/i, ''));
  idDoc.ele('eNCF').txt(testCase.encf);
  ['TipoIngresos', 'TipoPago'].forEach((field) => appendSimple(idDoc, field, row[field]));

  const paymentForms = collectIndexedEntries(row, 'FormaPago');
  if (paymentForms.length) {
    const table = idDoc.ele('TablaFormasPago');
    for (const entry of paymentForms) {
      const amount = rowText(row, `MontoPago[${entry.index}]`);
      const form = table.ele('FormaDePago');
      form.ele('FormaPago').txt(entry.value);
      appendSimple(form, 'MontoPago', amount);
    }
  }

  const emisor = encabezado.ele('Emisor');
  ['RNCEmisor', 'RazonSocialEmisor', 'FechaEmision'].forEach((field) => appendSimple(emisor, field, row[field]));

  const comprador = encabezado.ele('Comprador');
  ['RNCComprador', 'IdentificadorExtranjero', 'RazonSocialComprador'].forEach((field) => appendSimple(comprador, field, row[field]));

  const totalsNode = encabezado.ele('Totales');
  [
    'MontoGravadoTotal',
    'MontoGravadoI1',
    'MontoGravadoI2',
    'MontoGravadoI3',
    'MontoExento',
    'TotalITBIS',
    'TotalITBIS1',
    'TotalITBIS2',
    'TotalITBIS3',
    'MontoImpuestoAdicional',
    'MontoTotal',
    'MontoNoFacturable',
    'MontoPeriodo',
  ].forEach((field) => appendSimple(totalsNode, field, totalFieldValue(row, field)));

  const additionalTaxes = collectIndexedEntries(row, 'TipoImpuesto').filter((entry) => (
    normalizeRowValue(row[`MontoImpuestoSelectivoConsumoEspecifico[${entry.index}]`])
    || normalizeRowValue(row[`MontoImpuestoSelectivoConsumoAdvalorem[${entry.index}]`])
    || normalizeRowValue(row[`OtrosImpuestosAdicionales[${entry.index}]`])
  ));
  if (additionalTaxes.length) {
    const table = totalsNode.ele('ImpuestosAdicionales');
    for (const entry of additionalTaxes) {
      const item = table.ele('ImpuestoAdicional');
      item.ele('TipoImpuesto').txt(entry.value);
      appendSimple(item, 'MontoImpuestoSelectivoConsumoEspecifico', row[`MontoImpuestoSelectivoConsumoEspecifico[${entry.index}]`]);
      appendSimple(item, 'MontoImpuestoSelectivoConsumoAdvalorem', row[`MontoImpuestoSelectivoConsumoAdvalorem[${entry.index}]`]);
      appendSimple(item, 'OtrosImpuestosAdicionales', row[`OtrosImpuestosAdicionales[${entry.index}]`]);
    }
  }

  appendSimple(encabezado, 'CodigoSeguridadeCF', testCase.computedCodigoSeguridadeCF || row.CodigoSeguridadeCF);

  return {
    submissionMode: 'rfce',
    xml: xml.end({ pretty: true }),
    totals: summarizeTotalsFromRow(row),
  };
}

function buildTransmissionFromSpreadsheetRow({
  testCase,
  issueDate,
  certificateContext = null,
  emitter = null,
  overrideEmitterFromConfig = false,
}) {
  const normalizedTestCase = overrideEmitterFromConfig
    ? {
        ...testCase,
        rawRow: testCase?.rawRow ? applyEmitterOverridesToRow(testCase.rawRow, emitter) : testCase?.rawRow,
        linkedRawRow: testCase?.linkedRawRow ? applyEmitterOverridesToRow(testCase.linkedRawRow, emitter) : testCase?.linkedRawRow,
      }
    : { ...(testCase || {}) };

  if (
    overrideEmitterFromConfig
    && emitter
    && !Object.prototype.hasOwnProperty.call(normalizedTestCase, 'emitterNombreComercial')
    && (
      Object.prototype.hasOwnProperty.call(emitter, 'nombreComercial')
      || Object.prototype.hasOwnProperty.call(emitter, 'nombre_comercial')
    )
  ) {
    normalizedTestCase.emitterNombreComercial = normalizeEmitterOverrideValue(
      emitter.nombreComercial ?? emitter.nombre_comercial
    );
  }

  if (String(normalizedTestCase.sourceSheet || '').trim().toUpperCase() === 'RFCE'
    || String(normalizedTestCase.submissionMode || '').trim().toLowerCase() === 'rfce') {
    let computedCodigoSeguridadeCF = null;
    if (normalizedTestCase.linkedRawRow && certificateContext) {
      const linkedTransmission = buildCertificationEcfXml({
        ...normalizedTestCase,
        rawRow: normalizedTestCase.linkedRawRow,
        sourceSheet: 'ECF',
        submissionMode: 'normal',
      }, issueDate);
      const linkedSignature = signIfPossible(linkedTransmission.xml, certificateContext);
      computedCodigoSeguridadeCF = computeSecurityCodeFromSignedXml(linkedSignature.signedXml);
    }
    if (!computedCodigoSeguridadeCF) {
      computedCodigoSeguridadeCF = rowText(normalizedTestCase.rawRow, 'CodigoSeguridadeCF');
    }
    return buildCertificationRfceXml({
      ...normalizedTestCase,
      computedCodigoSeguridadeCF,
    }, issueDate);
  }
  return buildCertificationEcfXml(normalizedTestCase, issueDate);
}

function findColumn(sample, aliases) {
  const keys = Object.keys(sample || {});
  const normalized = keys.map(normalizeHeader);
  return aliases
    .map((alias) => normalizeHeader(alias))
    .map((alias) => keys[normalized.findIndex((key) => key.includes(alias))])
    .find(Boolean) || null;
}

function rowsToTestCases(rows, metadata = {}) {
  assertCondition(Array.isArray(rows) && rows.length > 0, 'El archivo del set DGII no contiene filas de datos.', { statusCode: 422 });

  const sample = rows[0];
  const keyCase = Object.keys(sample)[0] || null;
  const keyEncf = findColumn(sample, ['encf', 'ncf', 'encfelectronico']);
  const keyTipo = findColumn(sample, ['tipoecf', 'tipoe_cf', 'tipo_ecf', 'tipo']);
  const keyFecha = findColumn(sample, ['fechavencimiento', 'fecha_vencimiento', 'fechaexpiracion']);
  const keyMonto = findColumn(sample, ['montogravado', 'monto_gravado', 'indicadormontogravado']);
  const keyPago = findColumn(sample, ['tipopago', 'tipo_pago']);
  const keyIngresos = findColumn(sample, ['tipoingresos', 'tipo_ingresos']);

  assertCondition(keyEncf || keyTipo, `No se encontraron columnas compatibles con e-NCF en el archivo. Columnas detectadas: ${Object.keys(sample).join(', ')}`, {
    statusCode: 422,
  });

  const cases = [];

  for (const row of rows) {
    const rawEncf = keyEncf ? String(row[keyEncf] || '').trim().toUpperCase() : '';
    const rawTipo = keyTipo ? String(row[keyTipo] || '').trim().toUpperCase() : '';
    if (!rawEncf && !rawTipo) continue;

    const normalizedEncf = rawEncf || String(rawTipo || '').trim();
    const match = normalizedEncf.match(/^(E\d{2})(\d{10,11})$/);
    if (!match) continue;

    const tipoEcf = match[1];
    const documentType = getDocumentType(tipoEcf);
    if (!documentType) continue;

    const sequenceNumber = Number(match[2]);
    const montoMarker = keyMonto ? row[keyMonto] : null;
    const amountFlag = isSpecialValue(montoMarker) ? null : Number(montoMarker);

    cases.push({
      casoPrueba: String((keyCase && row[keyCase]) || normalizedEncf).trim() || normalizedEncf,
      encf: normalizedEncf,
      tipoEcf,
      numeroSecuencia: sequenceNumber,
      fechaVencimiento: parseDgiiDate(keyFecha ? row[keyFecha] : null),
      indicadorMontoGravado: Number.isFinite(amountFlag) ? amountFlag : null,
      tipoPago: isSpecialValue(keyPago ? row[keyPago] : null) ? null : String(row[keyPago]).trim(),
      tipoIngresos: isSpecialValue(keyIngresos ? row[keyIngresos] : null) ? null : String(row[keyIngresos]).trim(),
      rawRow: metadata.preserveRow ? { ...row } : null,
      sourceSheet: metadata.preserveRow ? (metadata.sourceSheet || null) : null,
      sourceKind: metadata.preserveRow ? (metadata.sourceKind || null) : null,
      submissionMode: metadata.forceSubmissionMode || null,
    });
  }

  assertCondition(cases.length > 0, 'No se detectaron e-NCF válidos en el archivo del set DGII.', { statusCode: 422 });
  return cases;
}

function parseTestSetBuffer(buffer, filename = 'data.csv') {
  const extension = String(filename || '').trim().toLowerCase().split('.').pop();
  let rows = [];

  if (['xlsx', 'xls', 'ods'].includes(extension)) {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  } else {
    const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    assertCondition(lines.length >= 2, 'El archivo plano del set DGII debe tener encabezados y al menos una fila.', { statusCode: 422 });
    const separator = lines[0].split(';').length > lines[0].split(',').length ? ';' : ',';
    const headers = splitCsvLine(lines[0], separator);
    rows = lines.slice(1).map((line) => {
      const values = splitCsvLine(line, separator);
      return headers.reduce((acc, header, index) => {
        acc[header] = values[index] ?? '';
        return acc;
      }, {});
    });
  }

  return rowsToTestCases(rows);
}

function buildCustomer(testCase, defaults, emitter) {
  const buyerMode = testCase.buyerMode || defaults.buyerMode;
  if (buyerMode === 'consumer_final') {
    return {
      rnc: digitsOnly(testCase.customerRnc || ''),
      nombre: testCase.customerName || 'Consumidor Final',
      correo: testCase.customerEmail || '',
      telefono: testCase.customerPhone || '',
      direccion: testCase.customerAddress || '',
    };
  }

  return {
    rnc: digitsOnly(testCase.customerRnc || emitter.rnc),
    nombre: testCase.customerName || emitter.razon_social || emitter.nombre_comercial || 'Cliente de prueba DGII',
    correo: testCase.customerEmail || emitter.correo || '',
    telefono: testCase.customerPhone || emitter.telefono || '',
    direccion: testCase.customerAddress || emitter.direccion || '',
  };
}

function buildTestItems(testCase, defaults) {
  const taxable = testCase.indicadorMontoGravado === null ? defaults.itbisRate > 0 : Number(testCase.indicadorMontoGravado) > 0;
  const unitPrice = round2(Number(testCase.totalAmount || defaults.montoBase || 0));
  const taxRate = taxable ? Number(defaults.itbisRate || 0) : 0;

  return [
    {
      name: `Producto de prueba DGII ${testCase.tipoEcf}`,
      quantity: 1,
      unitPrice,
      discount: 0,
      taxRate,
    },
  ];
}

function buildTransmissionXml({ testCase, emitter, customer, defaults, issueDate, certificateContext = null }) {
  if (testCase.rawRow) {
    return buildTransmissionFromSpreadsheetRow({ testCase, issueDate, certificateContext, emitter });
  }

  const baseDocument = {
    emitter: {
      rnc: emitter.rnc,
      razonSocial: emitter.razon_social,
      nombreComercial: emitter.nombre_comercial,
      direccion: emitter.direccion,
      telefono: emitter.telefono,
      correo: emitter.correo,
    },
    customer,
      document: {
        eNCF: testCase.encf,
        tipoeCF: testCase.tipoEcf,
        tipoIngresos: testCase.tipoIngresos || defaults.tipoIngresos,
        tipoPago: testCase.tipoPago || defaults.tipoPago,
        fechaVencimientoSecuencia: testCase.fechaVencimiento || null,
      },
    items: buildTestItems(testCase, defaults).map((item) => (
      testCase.tipoEcf === 'E47'
        ? {
            ...item,
            billingIndicator: 4,
            retentionIndicator: 1,
            withholdingAmount: 0,
            goodsOrServicesIndicator: 2,
          }
        : item
    )),
    issueDate,
  };

  if (testCase.tipoEcf === 'E33' || testCase.tipoEcf === 'E34') {
    baseDocument.document.referencia = {
      ncfModificado: 'E310000000001',
      fechaNcfModificado: '01-01-2026',
      codigoModificacion: testCase.tipoEcf === 'E33' ? '1' : '2',
    };
  }

  let generated = generateEcfXml(baseDocument);
  if (testCase.indicadorMontoGravado !== null) {
    baseDocument.document.indicadorMontoGravado = generated.totals.totalTax > 0 ? 1 : 0;
    generated = generateEcfXml(baseDocument);
  }

  if (defaults.submissionMode !== 'rfce') {
    if (testCase.submissionMode === 'rfce') {
      // Sigue al bloque RFCE debajo.
    } else {
      return {
        submissionMode: 'normal',
        xml: generated.xml,
        totals: generated.totals,
      };
    }
  }

  if ((testCase.submissionMode || defaults.submissionMode) !== 'rfce') {
    return {
      submissionMode: 'normal',
      xml: generated.xml,
      totals: generated.totals,
    };
  }

  const rfceXml = generateRfceXml({
    emitter: {
      rnc: emitter.rnc,
      razonSocial: emitter.razon_social,
    },
    customer,
    document: baseDocument.document,
    securityCode: testCase.codigoSeguridad || '000000',
    totals: generated.totals,
    paymentForms: [
      {
        formaPago: '1',
        montoPago: generated.totals.total,
      },
    ],
    issueDate,
  });

  return {
    submissionMode: 'rfce',
    xml: rfceXml,
    totals: generated.totals,
  };
}

function signIfPossible(xml, certificateContext) {
  if (!certificateContext) {
    return { signedXml: null, verification: null };
  }

  const signedXml = signatureService.signXML(xml, certificateContext);
  const verification = signatureService.verifySignature(signedXml);
  if (!verification.ok) {
    throw new EcfError('La firma generada para el set de homologación no pasó la verificación local.', {
      statusCode: 422,
      details: verification,
    });
  }
  return { signedXml, verification };
}

async function importTestCases({
  repository,
  businessId = 1,
  testCases,
  emitter,
  environment,
  certificateContext = null,
  signOnImport = true,
  buildXmlOnImport = true,
  userId = null,
  certificationMetaResolver = null,
}) {
  assertCondition(Array.isArray(testCases) && testCases.length > 0, 'No hay casos de prueba DGII para importar.', { statusCode: 422 });
  const groupedRanges = new Map();

  for (const testCase of testCases) {
    const current = groupedRanges.get(testCase.tipoEcf) || {
      min: testCase.numeroSecuencia,
      max: testCase.numeroSecuencia,
      fechaVencimiento: testCase.fechaVencimiento || null,
    };
    current.min = Math.min(current.min, testCase.numeroSecuencia);
    current.max = Math.max(current.max, testCase.numeroSecuencia);
    current.fechaVencimiento = current.fechaVencimiento || testCase.fechaVencimiento || null;
    groupedRanges.set(testCase.tipoEcf, current);
  }

  return repository.withTransaction(async (conn) => {
    const sequenceMap = new Map();

    for (const [tipoEcf, range] of groupedRanges.entries()) {
      const sequence = await repository.ensureSequenceCoverage(conn, businessId, {
        tipoComprobante: tipoEcf,
        numeroInicial: range.min,
        numeroFinal: range.max,
        fechaVencimiento: range.fechaVencimiento,
      });
      sequenceMap.set(tipoEcf, sequence);
    }

    const results = [];

    for (const testCase of testCases) {
      try {
        const defaults = TYPE_DEFAULTS[testCase.tipoEcf];
        assertCondition(defaults, `No hay defaults configurados para ${testCase.tipoEcf}.`, { statusCode: 422 });
        const sequence = sequenceMap.get(testCase.tipoEcf);
        const issueDate = new Date();
        const customer = buildCertificationCaseCustomer(testCase, defaults, emitter);
        const transmission = buildXmlOnImport
          ? buildTransmissionXml({
              testCase,
              emitter,
              customer,
              defaults,
              issueDate,
              certificateContext: signOnImport ? certificateContext : null,
            })
          : {
              submissionMode: inferSubmissionModeForImport(testCase, defaults),
              xml: testCase.originalXml || null,
              totals: buildDeferredTotals(testCase, defaults),
            };
        const signature = signOnImport && transmission.xml
          ? signIfPossible(transmission.xml, certificateContext)
          : { signedXml: null, verification: null };
        const codigoSeguridad = signature.signedXml
          ? require('crypto').createHash('sha256').update(String(signature.verification.signatureValue || '')).digest('hex').slice(0, 6).toUpperCase()
          : null;
        const certificationMeta = typeof certificationMetaResolver === 'function'
          ? (certificationMetaResolver(testCase, results.length) || {})
          : {};

        const saved = await repository.saveImportedDocument(conn, businessId, {
          sequenceId: sequence?.id || null,
          userId,
          tipoEcf: testCase.tipoEcf,
          encf: testCase.encf,
          environment,
          estadoDgii: signature.signedXml ? 'firmado' : 'pendiente',
          submissionMode: transmission.submissionMode,
          codigoSeguridad,
          nombreComprador: transmission.customer?.nombre || customer.nombre,
          rncComprador: transmission.customer?.rnc || customer.rnc,
          subtotal: transmission.totals.subtotal,
          descuentoTotal: transmission.totals.totalDiscount,
          montoExento: transmission.totals.exemptAmount,
          montoGravado: transmission.totals.totalTaxed,
          itbisTotal: transmission.totals.totalTax,
          montoTotal: transmission.totals.total,
          xmlContent: transmission.xml,
          signedXml: signature.signedXml || null,
          signedAt: signature.signedXml ? issueDate : null,
          certificationCaseKey: certificationMeta.certificationCaseKey || null,
          certificationSourceName: certificationMeta.certificationSourceName || null,
          certificationSourceFormat: certificationMeta.certificationSourceFormat || null,
          certificationTestType: certificationMeta.certificationTestType || null,
          certificationBatchId: certificationMeta.certificationBatchId || null,
          certificationOrderIndex: certificationMeta.certificationOrderIndex ?? null,
          certificationOriginalXml: certificationMeta.certificationOriginalXml || null,
        });

        results.push({
          ok: true,
          casoPrueba: testCase.casoPrueba,
          encf: testCase.encf,
          tipoEcf: testCase.tipoEcf,
          documentId: saved.documentId,
          updated: saved.updated,
          montoTotal: transmission.totals.total,
          itbisTotal: transmission.totals.totalTax,
          submissionMode: transmission.submissionMode,
          signed: Boolean(signature.signedXml),
        });
      } catch (error) {
        results.push({
          ok: false,
          casoPrueba: testCase.casoPrueba,
          encf: testCase.encf,
          tipoEcf: testCase.tipoEcf,
          error: error.message || 'No se pudo procesar el caso del set DGII.',
        });
      }
    }

    return {
      total: testCases.length,
      ok: results.filter((item) => item.ok).length,
      errors: results.filter((item) => !item.ok).length,
      hasCert: Boolean(certificateContext),
      signingDeferred: !signOnImport,
      xmlBuildDeferred: !buildXmlOnImport,
      results,
    };
  });
}

async function importTestSet({
  repository,
  businessId = 1,
  buffer,
  filename,
  emitter,
  environment,
  certificateContext = null,
  userId = null,
}) {
  const testCases = parseTestSetBuffer(buffer, filename);
  return importTestCases({
    repository,
    businessId,
    testCases,
    emitter,
    environment,
    certificateContext,
    userId,
  });
}

module.exports = {
  buildTransmissionFromSpreadsheetRow,
  importTestCases,
  importTestSet,
  parseTestSetBuffer,
  rowsToTestCases,
};
