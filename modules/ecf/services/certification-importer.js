'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DOMParser } = require('@xmldom/xmldom');
const XLSX = require('xlsx');
const { importTestCases, rowsToTestCases } = require('./test-set-importer');
const { digitsOnly } = require('../models/ecf.repository');
const { EcfError, assertCondition } = require('../utils/errors');

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeUpper(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeExt(filename) {
  return path.extname(String(filename || '')).toLowerCase();
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function walkFiles(dirPath, collector = []) {
  if (!fs.existsSync(dirPath)) return collector;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const absolutePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) walkFiles(absolutePath, collector);
    else collector.push(absolutePath);
  }
  return collector;
}

function extractZip(zipPath) {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgii-cert-zip-'));
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${String(zipPath).replace(/'/g, "''")}' -DestinationPath '${String(targetDir).replace(/'/g, "''")}' -Force`,
      ],
      { stdio: 'ignore' }
    );
    return {
      targetDir,
      files: walkFiles(targetDir),
    };
  } catch (error) {
    throw new EcfError('No se pudo extraer el ZIP del set DGII.', {
      statusCode: 422,
      details: { zipPath, cause: error.message },
    });
  }
}

function getXmlNodeText(node, tagName) {
  if (!node || !tagName) return '';
  const found = node.getElementsByTagName(tagName)?.[0];
  return normalizeText(found?.textContent || '');
}

function parseXmlTestCase(xmlContent, sourceName) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(String(xmlContent || ''), 'application/xml');
  const root = xmlDoc?.documentElement;
  assertCondition(root, `El XML ${sourceName} no es válido.`, { statusCode: 422 });

  const encabezado = root.getElementsByTagName('Encabezado')?.[0] || root;
  const idDoc = encabezado.getElementsByTagName('IdDoc')?.[0] || root;
  const emisor = encabezado.getElementsByTagName('Emisor')?.[0] || root;
  const comprador = encabezado.getElementsByTagName('Comprador')?.[0] || root;
  const totales = encabezado.getElementsByTagName('Totales')?.[0] || root;

  // InformacionReferencia puede estar en el nivel raíz (hijo de ECF) o dentro de Encabezado
  const infoRef = root.getElementsByTagName('InformacionReferencia')?.[0] || null;

  const tipoEcf = normalizeUpper(getXmlNodeText(idDoc, 'TipoeCF'));
  const encf = normalizeUpper(getXmlNodeText(idDoc, 'eNCF'));
  assertCondition(tipoEcf && encf, `El XML ${sourceName} no contiene TipoeCF/eNCF.`, { statusCode: 422 });

  const customerRnc = digitsOnly(
    getXmlNodeText(comprador, 'RNCComprador')
      || getXmlNodeText(comprador, 'IdentificacionExtranjero')
  );
  const totalAmount = Number(getXmlNodeText(totales, 'MontoTotal') || 0);
  const buyerName = getXmlNodeText(comprador, 'RazonSocialComprador') || 'Consumidor Final';
  const filenameLabel = path.basename(sourceName, path.extname(sourceName));

  // Extraer NCFModificado para que dedupeCertificationCases pueda ordenar dependencias
  // (p.ej. E32 debe enviarse antes que E33 que lo referencia)
  const ncfModificado = infoRef ? normalizeUpper(getXmlNodeText(infoRef, 'NCFModificado')) : '';
  const fechaNcfModificado = infoRef ? getXmlNodeText(infoRef, 'FechaNCFModificado') : '';
  const codigoModificacion = infoRef ? getXmlNodeText(infoRef, 'CodigoModificacion') : '';

  return {
    casoPrueba: filenameLabel || encf,
    encf,
    tipoEcf: tipoEcf.startsWith('E') ? tipoEcf : `E${tipoEcf}`,
    numeroSecuencia: Number(String(encf).replace(/^[A-Z]+\d{2}/, '')) || 0,
    fechaVencimiento: getXmlNodeText(idDoc, 'FechaVencimientoSecuencia') || null,
    indicadorMontoGravado: null,
    tipoPago: getXmlNodeText(idDoc, 'TipoPago') || '1',
    tipoIngresos: getXmlNodeText(idDoc, 'TipoIngresos') || null,
    customerRnc,
    customerName: buyerName,
    customerEmail: getXmlNodeText(comprador, 'CorreoComprador') || '',
    customerPhone: getXmlNodeText(comprador, 'TelefonoComprador') || '',
    customerAddress: getXmlNodeText(comprador, 'DireccionComprador') || '',
    totalAmount: Number.isFinite(totalAmount) && totalAmount > 0 ? totalAmount : null,
    buyerMode: customerRnc ? 'emitter' : 'consumer_final',
    testType: filenameLabel,
    sourceKind: 'xml',
    originalXml: String(xmlContent || ''),
    sourceName: sourceName,
    rncEmisor: digitsOnly(getXmlNodeText(emisor, 'RNCEmisor')),
    // rawRow con NCFModificado para que dedupeCertificationCases ordene correctamente
    rawRow: ncfModificado && ncfModificado !== '#E'
      ? { NCFModificado: ncfModificado, FechaNCFModificado: fechaNcfModificado, CodigoModificacion: codigoModificacion }
      : null,
  };
}

function parseJsonCases(jsonText, sourceName) {
  let parsed;
  try {
    parsed = JSON.parse(String(jsonText || 'null'));
  } catch (error) {
    throw new EcfError(`El archivo JSON ${sourceName} no se pudo interpretar.`, {
      statusCode: 422,
      details: { cause: error.message },
    });
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : (Array.isArray(parsed?.pruebas) ? parsed.pruebas
      : Array.isArray(parsed?.casos) ? parsed.casos
        : Array.isArray(parsed?.items) ? parsed.items
          : Array.isArray(parsed?.documents) ? parsed.documents
            : []);
  assertCondition(rows.length > 0, `El archivo JSON ${sourceName} no contiene casos válidos.`, { statusCode: 422 });
  return rowsToTestCases(rows, { preserveRow: true, sourceKind: 'json' }).map((item, index) => ({
    ...item,
    testType: `${path.basename(sourceName, path.extname(sourceName))}-${index + 1}`,
    sourceKind: 'json',
    sourceName,
  }));
}

function parseSpreadsheetCases(buffer, sourceName) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const hasRfceSheet = workbook.SheetNames.some((name) => String(name || '').trim().toUpperCase() === 'RFCE');
  const e32EcfRows = new Map();

  if (hasRfceSheet) {
    for (const sheetName of workbook.SheetNames) {
      const normalizedSheet = String(sheetName || '').trim().toUpperCase();
      if (normalizedSheet !== 'ECF') continue;
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: false });
      for (const row of rows) {
        const encf = normalizeUpper(row.ENCF || row.eNCF || '');
        if (encf.startsWith('E32')) {
          e32EcfRows.set(encf, { ...row });
        }
      }
    }
  }

  const cases = [];

  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: false });
    if (!rows.length) continue;
    const normalizedSheet = String(sheetName || '').trim().toUpperCase();
    const parsed = rowsToTestCases(rows, {
      preserveRow: true,
      sourceSheet: normalizedSheet,
      sourceKind: 'sheet',
      forceSubmissionMode: normalizedSheet === 'RFCE' ? 'rfce' : null,
    })
      .filter((item) => !(hasRfceSheet && normalizedSheet === 'ECF' && item.tipoEcf === 'E32'))
      .map((item, index) => ({
        ...item,
        testType: `${path.basename(sourceName, path.extname(sourceName))}-${normalizedSheet}-${index + 1}`,
        sourceKind: 'sheet',
        sourceName,
        sourceSheet: normalizedSheet,
        linkedRawRow: normalizedSheet === 'RFCE'
          ? (e32EcfRows.get(normalizeUpper(item.encf)) || null)
          : null,
      }));
    cases.push(...parsed);
  }

  return cases;
}

function buildBatchId() {
  return `cert-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
}

function dedupeCertificationCases(cases = []) {
  const unique = [];
  const seen = new Set();

  for (const item of cases) {
    const key = `${String(item.tipoEcf || '').trim().toUpperCase()}::${String(item.encf || '').trim().toUpperCase()}`;
    if (!item?.encf || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  const indexedUnique = unique.map((item, index) => ({ ...item, __originalIndex: index }));
  const byEncf = new Map(
    indexedUnique.map((item) => [String(item.encf || '').trim().toUpperCase(), item])
  );
  const sorted = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(item) {
    const encf = String(item.encf || '').trim().toUpperCase();
    if (!encf || visited.has(encf) || visiting.has(encf)) return;
    visiting.add(encf);

    const referenced = normalizeUpper(item.rawRow?.NCFModificado || '');
    if (referenced && referenced !== '#E' && byEncf.has(referenced)) {
      visit(byEncf.get(referenced));
    }

    visiting.delete(encf);
    visited.add(encf);
    sorted.push(item);
  }

  indexedUnique
    .slice()
    .sort((a, b) => a.__originalIndex - b.__originalIndex)
    .forEach(visit);

  return sorted.map((item, index) => ({
    ...item,
    certificationOrderIndex: index + 1,
  }));
}

function normalizeUploadList(uploadedFiles = []) {
  return uploadedFiles
    .filter((file) => file?.filepath)
    .map((file) => ({
      filepath: path.resolve(file.filepath),
      originalFilename: file.originalFilename || path.basename(file.filepath),
    }));
}

function collectCertificationSources(uploadedFiles) {
  const pending = [...normalizeUploadList(uploadedFiles)];
  const sources = [];
  const cleanupDirs = [];

  while (pending.length) {
    const file = pending.shift();
    const ext = normalizeExt(file.originalFilename || file.filepath);
    if (ext === '.zip') {
      const extracted = extractZip(file.filepath);
      cleanupDirs.push(extracted.targetDir);
      for (const extractedFile of extracted.files) {
        pending.push({
          filepath: extractedFile,
          originalFilename: path.relative(extracted.targetDir, extractedFile),
        });
      }
      continue;
    }
    sources.push(file);
  }

  return { sources, cleanupDirs };
}

function parseCertificationSource(file) {
  const ext = normalizeExt(file.originalFilename || file.filepath);
  const buffer = fs.readFileSync(file.filepath);
  const sourceName = file.originalFilename || path.basename(file.filepath);

  if (['.csv', '.txt', '.xlsx', '.xls', '.ods'].includes(ext)) {
    return parseSpreadsheetCases(buffer, sourceName);
  }
  if (ext === '.json') {
    return parseJsonCases(buffer.toString('utf8'), sourceName);
  }
  if (ext === '.xml') {
    return [parseXmlTestCase(buffer.toString('utf8'), sourceName)];
  }
  return [];
}

async function importCertificationSet({
  repository,
  businessId = 1,
  uploadedFiles = [],
  emitter,
  environment,
  certificateContext = null,
  userId = null,
}) {
  const { sources, cleanupDirs } = collectCertificationSources(uploadedFiles);
  assertCondition(sources.length > 0, 'Debe subir al menos un archivo, carpeta o ZIP del set DGII.', { statusCode: 400 });
  const batchId = buildBatchId();
  const parsedCases = [];
  const ignored = [];

  try {
    for (const source of sources) {
      const cases = parseCertificationSource(source);
      if (!cases.length) {
        ignored.push(source.originalFilename || path.basename(source.filepath));
        continue;
      }
      for (const [index, testCase] of cases.entries()) {
        parsedCases.push({
          ...testCase,
          sourceName: source.originalFilename || path.basename(source.filepath),
          sourceFormat: normalizeExt(source.originalFilename || source.filepath).replace('.', '') || 'file',
          certificationOrderIndex: parsedCases.length + 1,
          certificationSourceIndex: index + 1,
        });
      }
    }

    const normalizedCases = dedupeCertificationCases(parsedCases);
    assertCondition(normalizedCases.length > 0, 'No se detectaron comprobantes válidos en los archivos del set DGII.', { statusCode: 422 });

    const result = await importTestCases({
      repository,
      businessId,
      testCases: normalizedCases,
      emitter,
      environment,
      certificateContext,
      userId,
      certificationMetaResolver: (testCase) => ({
        certificationCaseKey: slugify(testCase.casoPrueba || testCase.encf || `caso-${testCase.certificationOrderIndex}`),
        certificationSourceName: testCase.sourceName || null,
        certificationSourceFormat: testCase.sourceFormat || null,
        certificationTestType: testCase.testType || testCase.casoPrueba || null,
        certificationBatchId: batchId,
        certificationOrderIndex: testCase.certificationOrderIndex ?? null,
        certificationOriginalXml: testCase.originalXml
          || (testCase.rawRow
            ? JSON.stringify({
                kind: 'spreadsheet_row',
                sourceSheet: testCase.sourceSheet || null,
                submissionMode: testCase.submissionMode || null,
                row: testCase.rawRow,
                linkedRawRow: testCase.linkedRawRow || null,
              })
            : null),
      }),
    });

    return {
      ...result,
      batchId,
      ignored,
      importedSources: sources.map((item) => item.originalFilename || path.basename(item.filepath)),
      supportedFormats: ['xml', 'zip', 'txt', 'csv', 'json', 'xlsx', 'xls', 'ods', 'folder'],
    };
  } finally {
    for (const tempDir of cleanupDirs) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

module.exports = {
  importCertificationSet,
  parseCertificationSource,
  parseXmlTestCase,
};
