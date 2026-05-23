'use strict';

const XLSX = require('xlsx');
const { getCertificateForSigning } = require('./fiscalCertificateService');
const {
  buildEcfJsonFromSale,
  convertJsonToXml,
  signXml,
  generateSecurityCodeFromSignedXml
} = require('./ecfXmlService');
const { writeFiscalAuditLog } = require('./fiscalExtensions');

const RFCE_THRESHOLD = 250000;

// Defaults de montos y comportamiento por tipo de e-CF
const TYPE_DEFAULTS = {
  '31': { montoBase: 5000,  itbisRate: 18, tipoPago: '01', tipoIngresos: '01', requiresRnc: true,  submissionMode: 'ecf',  isNota: false },
  '32': { montoBase: 1000,  itbisRate: 0,  tipoPago: '01', tipoIngresos: '01', requiresRnc: false, submissionMode: 'rfce', isNota: false },
  '33': { montoBase: 500,   itbisRate: 0,  tipoPago: '01', tipoIngresos: '01', requiresRnc: false, submissionMode: 'ecf',  isNota: true  },
  '34': { montoBase: 500,   itbisRate: 0,  tipoPago: '01', tipoIngresos: '01', requiresRnc: false, submissionMode: 'ecf',  isNota: true  },
  '41': { montoBase: 2000,  itbisRate: 18, tipoPago: '01', tipoIngresos: '01', requiresRnc: true,  submissionMode: 'ecf',  isNota: false },
  '43': { montoBase: 500,   itbisRate: 0,  tipoPago: '01', tipoIngresos: '01', requiresRnc: false, submissionMode: 'ecf',  isNota: false },
  '44': { montoBase: 3000,  itbisRate: 18, tipoPago: '01', tipoIngresos: '01', requiresRnc: false, submissionMode: 'ecf',  isNota: false },
  '45': { montoBase: 2000,  itbisRate: 0,  tipoPago: '01', tipoIngresos: '01', requiresRnc: false, submissionMode: 'ecf',  isNota: false },
  '46': { montoBase: 5000,  itbisRate: 0,  tipoPago: '01', tipoIngresos: '01', requiresRnc: false, submissionMode: 'ecf',  isNota: false },
  '47': { montoBase: 3000,  itbisRate: 0,  tipoPago: '01', tipoIngresos: '01', requiresRnc: false, submissionMode: 'ecf',  isNota: false },
};

// ── Parser (CSV y XLSX) ───────────────────────────────────────────────────────

function isSpecialValue(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '' || s === '#e' || s === 'n/a' || s === 'na' || s === '#n/a' || s === '#ref!';
}

function parseDateDGII(dateStr) {
  if (!dateStr || isSpecialValue(dateStr)) return null;
  const s = String(dateStr).trim();
  // Excel puede entregar un número serial de fecha
  if (/^\d+$/.test(s)) {
    const d = XLSX.SSF.parse_date_code(Number(s));
    if (d) return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
  }
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

function splitCsvLine(line, sep) {
  const result = [];
  let cur = '';
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === sep && !inQ) { result.push(cur); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur);
  return result.map(v => v.trim().replace(/^"|"$/g, ''));
}

// Convierte cualquier fila de objetos (XLSX o CSV) a un array normalizado de casos
function rowsToTestCases(rows) {
  if (!rows.length) throw new Error('El archivo no tiene filas de datos.');

  // Normalizar claves: minúsculas, sin tildes, sin espacios
  const normalize = k => String(k || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '_');

  const findCol = (obj, ...names) => {
    const keys = Object.keys(obj).map(normalize);
    for (const name of names) {
      const idx = keys.findIndex(k => k.includes(name));
      if (idx >= 0) return Object.keys(obj)[idx];
    }
    return null;
  };

  // Detectar columnas usando la primera fila
  const sample = rows[0];
  const kENCF    = findCol(sample, 'encf');
  const kTipo    = findCol(sample, 'tipoecf', 'tipoe_cf', 'tipo_ecf', 'tipo');
  const kFecha   = findCol(sample, 'fechavencimiento', 'fecha_vencimiento');
  const kGravado = findCol(sample, 'montogravado', 'monto_gravado');
  const kPago    = findCol(sample, 'tipopago', 'tipo_pago');
  const kIng     = findCol(sample, 'tipoingresos', 'tipo_ingresos');

  if (!kENCF && !kTipo) {
    throw new Error(
      'No se encontraron las columnas ENCF o TipoeCF en el archivo. ' +
      `Columnas detectadas: ${Object.keys(sample).join(', ')}`
    );
  }

  const cases = [];
  for (const row of rows) {
    const encfRaw = kENCF ? String(row[kENCF] || '').trim().toUpperCase() : '';
    const tipoRaw = kTipo ? String(row[kTipo] || '').trim() : '';

    if (!encfRaw && !tipoRaw) continue;

    const encf = encfRaw || `E${tipoRaw.replace(/^E/, '')}`;
    const encfMatch = encf.match(/^E(\d{2})(\d{10})$/);
    if (!encfMatch) continue;

    const tipo      = encfMatch[1];
    const numeroSeq = parseInt(encfMatch[2], 10);

    const fechaRaw    = kFecha   ? row[kFecha]   : null;
    const gravadoRaw  = kGravado ? row[kGravado] : null;
    const tipoPagoRaw = kPago    ? row[kPago]    : null;
    const tipoIngRaw  = kIng     ? row[kIng]     : null;

    const casoPrueba = String(Object.values(row)[0] || encf);

    cases.push({
      casoPrueba,
      tipo,
      encf,
      numeroSeq,
      fechaVencimiento: parseDateDGII(fechaRaw),
      indMontoGravado:  isSpecialValue(gravadoRaw) ? null : Number(gravadoRaw),
      tipoPago:         isSpecialValue(tipoPagoRaw) ? null : String(tipoPagoRaw).padStart(2, '0'),
      tipoIngresos:     isSpecialValue(tipoIngRaw)  ? null : String(tipoIngRaw),
    });
  }

  if (!cases.length) {
    throw new Error('No se encontraron filas válidas con formato de e-NCF (Exx + 10 dígitos) en el archivo.');
  }
  return cases;
}

// Parsea un Buffer (xlsx/xls/csv/txt) y devuelve los casos
function parseTestSetBuffer(buffer, filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  let rows;

  if (ext === 'xlsx' || ext === 'xls' || ext === 'ods') {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  } else {
    // CSV / TXT
    const text = buffer.toString('utf8').replace(/^﻿/, ''); // quitar BOM
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error('El CSV tiene menos de 2 filas.');
    const sep = lines[0].split(';').length > lines[0].split(',').length ? ';' : ',';
    const headers = splitCsvLine(lines[0], sep);
    rows = lines.slice(1).map(line => {
      const vals = splitCsvLine(line, sep);
      const obj = {};
      headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
      return obj;
    });
  }

  return rowsToTestCases(rows);
}

// Mantener compatibilidad con llamadas que pasen texto plano
function parseTestSetCsv(csvText) {
  return parseTestSetBuffer(Buffer.from(csvText, 'utf8'), 'data.csv');
}

// ── Secuencias ────────────────────────────────────────────────────────────────

async function ensureSequencesForCases(queryFn, businessId, cases) {
  // Agrupar números por tipo
  const byTipo = {};
  for (const c of cases) {
    if (!byTipo[c.tipo]) byTipo[c.tipo] = { nums: [], fechaVen: null };
    byTipo[c.tipo].nums.push(c.numeroSeq);
    if (c.fechaVencimiento && !byTipo[c.tipo].fechaVen) {
      byTipo[c.tipo].fechaVen = c.fechaVencimiento;
    }
  }

  for (const [tipo, { nums, fechaVen }] of Object.entries(byTipo)) {
    const tipoKey = `E${tipo}`;
    const minNum  = Math.min(...nums);
    const maxNum  = Math.max(...nums);
    const newHasta = maxNum + 500; // buffer generoso

    const existing = await queryFn(
      'SELECT id, desde, hasta FROM fiscal_sequences WHERE business_id = ? AND tipo_comprobante = ? AND activo = 1 LIMIT 1',
      [businessId, tipoKey]
    );

    if (existing[0]) {
      const seq = existing[0];
      // Extender si hace falta para cubrir el set
      if (Number(seq.hasta) < maxNum) {
        await queryFn(
          'UPDATE fiscal_sequences SET hasta = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [newHasta, seq.id]
        );
      }
    } else {
      // Crear secuencia desde cero con el rango del set
      await queryFn(`
        INSERT INTO fiscal_sequences
          (business_id, tipo_comprobante, prefijo, serie, desde, hasta, proximo,
           fecha_vencimiento, activo, created_by)
        VALUES (?, ?, 'E', ?, ?, ?, ?, ?, 1, NULL)
      `, [businessId, tipoKey, tipo, minNum, newHasta, minNum, fechaVen]);
    }
  }
}

// ── Generar documento de prueba ───────────────────────────────────────────────

async function processTestCase(queryFn, businessId, business, caso, certData, ambiente) {
  const { tipo, encf, fechaVencimiento, indMontoGravado, tipoPago: csvTipoPago, tipoIngresos: csvTipoIng } = caso;
  const defaults = TYPE_DEFAULTS[tipo];
  if (!defaults) throw new Error(`Tipo de e-CF no reconocido: ${tipo}`);

  // Montos
  const gravado     = indMontoGravado !== null ? indMontoGravado : (defaults.itbisRate > 0 ? 1 : 0);
  const montoBase   = defaults.montoBase;
  const itbisAmount = gravado ? Math.round(montoBase * defaults.itbisRate) / 100 : 0;
  const montoTotal  = montoBase + itbisAmount;

  // submission_mode: E32 < 250k → rfce, resto → ecf
  const submissionMode = tipo === '32' && montoTotal < RFCE_THRESHOLD
    ? 'rfce'
    : (tipo === '32' ? 'ecf' : defaults.submissionMode);

  const tipoPago    = csvTipoPago    || defaults.tipoPago;
  const tipoIngresos = csvTipoIng   || defaults.tipoIngresos;
  const requiresRnc  = defaults.requiresRnc;

  const rncComprador    = requiresRnc ? business.rnc : null;
  const nombreComprador = requiresRnc
    ? (business.razon_social || business.nombre || 'EMPRESA DE PRUEBA')
    : 'CONSUMIDOR FINAL';

  const customer = requiresRnc
    ? { rnc: rncComprador, razon_social: nombreComprador, nombre: nombreComprador }
    : null;

  const testSale = {
    total:          montoTotal,
    payment_method: tipoPago === '02' ? 'tarjeta' : 'efectivo',
    descuento:      0,
  };

  const testItems = [{
    nombre:            `Producto de Prueba DGII - Tipo ${tipo}`,
    codigo:            `TEST-E${tipo}`,
    cantidad:          1,
    precio_unitario:   montoBase,
    itbis:             gravado ? defaults.itbisRate : 0,
    descuento:         0,
  }];

  const sequence = {
    fechaVencimiento: fechaVencimiento || '2028-12-31',
  };

  // Construir JSON del e-CF reutilizando la función existente
  const ecfJson = buildEcfJsonFromSale({
    sale:     testSale,
    items:    testItems,
    business,
    customer,
    sequence,
    tipoEcf:  `E${tipo}`,
    encf,
    ambiente,
  });

  // Ajustes específicos que buildEcfJsonFromSale no maneja
  const idDoc = ecfJson.ECF.Encabezado.IdDoc;
  idDoc.IndicadorMontoGravado = gravado;
  idDoc.TipoIngresos          = tipoIngresos;
  idDoc.TipoPago              = tipoPago;
  if (defaults.isNota) {
    // Nota de débito/crédito: agregar indicador y referencia ficticia de prueba
    idDoc.IndicadorNotaCredito = tipo === '34' ? 1 : 0;
    ecfJson.ECF.Encabezado.InformacionReferencia = {
      NCFModificado:       `E31${String(1).padStart(10, '0')}`,
      FechaNCFModificado:  '2026-01-01',
      CodigoModificacion:  tipo === '33' ? '1' : '2',
    };
  }

  const xmlString = convertJsonToXml(ecfJson);

  // Firmar si hay certificado disponible
  let signedXml       = null;
  let codigoSeguridad = null;
  if (certData) {
    try {
      signedXml       = signXml(xmlString, certData.cert, certData.privateKey);
      codigoSeguridad = generateSecurityCodeFromSignedXml(signedXml, 6);
    } catch (_) {
      signedXml = null;
    }
  }

  const now = new Date();

  // Si ya existe y no fue enviado → actualizar (permite re-importar con firma corregida)
  const dup = await queryFn(
    'SELECT id, is_sent FROM ecf_documents WHERE business_id = ? AND encf = ? LIMIT 1',
    [businessId, encf]
  );
  if (dup[0]) {
    if (Number(dup[0].is_sent) === 1) {
      throw new Error(`El e-NCF ${encf} ya fue enviado a DGII y no se puede reemplazar.`);
    }
    await queryFn(`
      UPDATE ecf_documents SET
        tipo_ecf=?, rnc_emisor=?, rnc_comprador=?, nombre_comprador=?,
        monto_total=?, itbis_total=?, fecha_emision=?, fecha_firma=?,
        codigo_seguridad=?, xml_content=?, signed_xml_content=?,
        estado_dgii='pendiente', ambiente=?, submission_mode=?,
        retry_count=0, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `, [
      `E${tipo}`, business.rnc, rncComprador, nombreComprador,
      montoTotal, itbisAmount, now, signedXml ? now : null,
      codigoSeguridad, xmlString, signedXml,
      ambiente, submissionMode,
      dup[0].id,
    ]);
    return {
      documentId:     dup[0].id,
      tipo:           `E${tipo}`,
      encf,
      montoTotal,
      itbis:          itbisAmount,
      submissionMode,
      signed:         Boolean(signedXml),
      updated:        true,
    };
  }

  const result = await queryFn(`
    INSERT INTO ecf_documents
      (business_id, tipo_ecf, encf, rnc_emisor, rnc_comprador, nombre_comprador,
       monto_total, itbis_total, fecha_emision, fecha_firma, codigo_seguridad,
       xml_content, signed_xml_content, estado_dgii, ambiente, submission_mode,
       is_sent, retry_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, 0, 0, CURRENT_TIMESTAMP)
  `, [
    businessId,
    `E${tipo}`,
    encf,
    business.rnc,
    rncComprador,
    nombreComprador,
    montoTotal,
    itbisAmount,
    now,
    signedXml ? now : null,
    codigoSeguridad,
    xmlString,
    signedXml,
    ambiente,
    submissionMode,
  ]);

  return {
    documentId:     result.insertId,
    tipo:           `E${tipo}`,
    encf,
    montoTotal,
    itbis:          itbisAmount,
    submissionMode,
    signed:         Boolean(signedXml),
  };
}

// ── API pública ───────────────────────────────────────────────────────────────

async function importTestSet(queryFn, businessId, fileBufferOrText, { ambiente = 'test', userId, ipAddress, filename = 'data.csv' } = {}) {
  const buffer = Buffer.isBuffer(fileBufferOrText)
    ? fileBufferOrText
    : Buffer.from(String(fileBufferOrText), 'utf8');
  const cases = parseTestSetBuffer(buffer, filename);

  const bizRows = await queryFn(
    'SELECT id, nombre, razon_social, nombre_comercial, rnc, direccion, telefono, correo FROM businesses WHERE id = ? LIMIT 1',
    [businessId]
  );
  const business = bizRows[0];
  if (!business)   throw Object.assign(new Error('No se encontró el negocio.'), { statusCode: 404 });
  if (!business.rnc) throw Object.assign(new Error('El negocio no tiene RNC configurado. Ve a Datos Negocio y guarda el RNC.'), { statusCode: 422 });

  // Certificado (opcional — si no hay, se crea el doc sin firma)
  let certData = null;
  try { certData = await getCertificateForSigning(queryFn, businessId); } catch (_) {}

  // Crear secuencias necesarias
  await ensureSequencesForCases(queryFn, businessId, cases);

  // Procesar cada caso
  const results = [];
  for (const caso of cases) {
    try {
      const r = await processTestCase(queryFn, businessId, business, caso, certData, ambiente);
      results.push({ casoPrueba: caso.casoPrueba, encf: caso.encf, ok: true, ...r });
    } catch (err) {
      results.push({ casoPrueba: caso.casoPrueba, encf: caso.encf, ok: false, error: err.message });
    }
  }

  const okCount  = results.filter(r => r.ok).length;
  const errCount = results.filter(r => !r.ok).length;

  await writeFiscalAuditLog(queryFn, {
    businessId, userId, ipAddress,
    action:      'test_set_importado',
    description: `Set de prueba DGII importado: ${okCount}/${cases.length} docs creados. Amb: ${ambiente}. Sin cert: ${!certData}.`,
  }).catch(() => {});

  return { total: cases.length, ok: okCount, errors: errCount, hasCert: Boolean(certData), results };
}

module.exports = { importTestSet, parseTestSetCsv };
