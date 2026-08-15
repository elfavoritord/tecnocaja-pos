'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const AdmZip = require('adm-zip');
const { onCall, HttpsError } = require('firebase-functions/v2/https');

const DATASET_URL = 'https://dgii.gov.do/app/WebApps/Consultas/RNC/DGII_RNC.zip';
const DATASET_DIR = path.join('/tmp', 'tecno-caja-dgii');
const DATASET_PATH = path.join(DATASET_DIR, 'DGII_RNC.TXT');
const DATASET_ZIP_PATH = path.join(DATASET_DIR, 'DGII_RNC.zip');
const DATASET_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let datasetReadyPromise = null;
const resultCache = new Map();

const dgiiLookup = onCall(
  { cors: true, memory: '512MiB', timeoutSeconds: 120 },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'Debes iniciar sesión para consultar DGII.');
    }

    const document = String(request.data?.rnc || '').replace(/\D/g, '');
    if (![9, 11].includes(document.length)) {
      throw new HttpsError(
        'invalid-argument',
        'Proporciona un RNC de 9 dígitos o una cédula de 11 dígitos.'
      );
    }

    if (resultCache.has(document)) {
      return resultCache.get(document);
    }

    try {
      await ensureDataset();
      const record = await findRecordInDataset(DATASET_PATH, document);
      const result = record
        ? { found: true, ...record }
        : { found: false, rnc: document };
      resultCache.set(document, result);
      return result;
    } catch (datasetError) {
      console.error('No se pudo consultar el padrón DGII descargable:', datasetError);
      const fallback = await lookupFallbackApis(document);
      if (fallback) return { found: true, ...fallback };

      throw new HttpsError(
        'unavailable',
        'La fuente oficial DGII no está disponible temporalmente. Intenta nuevamente.'
      );
    }
  }
);

async function ensureDataset() {
  if (isDatasetCurrent()) return;
  if (datasetReadyPromise) return datasetReadyPromise;

  datasetReadyPromise = downloadDataset().finally(() => {
    datasetReadyPromise = null;
  });
  return datasetReadyPromise;
}

function isDatasetCurrent() {
  try {
    const stat = fs.statSync(DATASET_PATH);
    return stat.size > 0 && Date.now() - stat.mtimeMs < DATASET_MAX_AGE_MS;
  } catch (_) {
    return false;
  }
}

async function downloadDataset() {
  fs.mkdirSync(DATASET_DIR, { recursive: true });
  const zipTempPath = `${DATASET_ZIP_PATH}.download`;
  const txtTempPath = `${DATASET_PATH}.download`;
  const response = await fetch(DATASET_URL, {
    headers: { 'User-Agent': 'TecnoCajaPOS/1.0' },
    signal: AbortSignal.timeout(90000),
  });

  if (!response.ok || !response.body) {
    throw new Error(`DGII respondió HTTP ${response.status}`);
  }

  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(zipTempPath));
  const zip = new AdmZip(zipTempPath);
  const entry = zip.getEntry('TMP/DGII_RNC.TXT') ||
    zip.getEntries().find((item) => path.basename(item.entryName).toUpperCase() === 'DGII_RNC.TXT');
  if (!entry) throw new Error('El ZIP DGII no contiene DGII_RNC.TXT');

  fs.writeFileSync(txtTempPath, entry.getData());
  fs.renameSync(txtTempPath, DATASET_PATH);
  fs.rmSync(zipTempPath, { force: true });
  resultCache.clear();
}

async function findRecordInDataset(filePath, document) {
  const input = fs.createReadStream(filePath, { encoding: 'latin1' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (line.startsWith(`${document}|`)) return parseDatasetLine(line, document);
    }
    return null;
  } finally {
    lines.close();
    input.destroy();
  }
}

function parseDatasetLine(line, fallbackDocument) {
  const fields = line.split('|').map((field) => field.trim());
  const rnc = fields[0] || fallbackDocument;
  return {
    rnc,
    nombre: fields[1] || '',
    nombreComercial: fields[2] || fields[1] || null,
    categoria: fields[3] || null,
    fechaRegistro: fields[8] || null,
    estado: fields[9] || null,
    regimen: fields[10] || null,
    tipo: rnc.length === 11 ? 'FISICO' : 'JURIDICO',
    direccion: null,
  };
}

async function lookupFallbackApis(document) {
  const urls = [
    `https://api.digital.gob.do/v3/rnc/${document}`,
    `https://api.datos.gob.do/v1/rnc/${document}`,
  ];

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) continue;
      const payload = await response.json();
      const item = Array.isArray(payload) ? payload[0] : payload;
      if (!item?.nombre) continue;
      return normalizeApiRecord(item, document);
    } catch (_) {
      // La siguiente fuente puede seguir disponible.
    }
  }
  return null;
}

function normalizeApiRecord(item, document) {
  const rawType = String(item.tipo || '').toUpperCase();
  const type = rawType.includes('FISIC') || rawType.includes('FÍSIC')
    ? 'FISICO'
    : rawType.includes('JURID') ? 'JURIDICO' : null;
  return {
    rnc: item.rnc || document,
    nombre: item.nombre || '',
    nombreComercial: item.nombre_comercial || item.nombreComercial || null,
    estado: item.estado || null,
    tipo: type,
    categoria: item.categoria || item.actividad_economica || null,
    direccion: item.direccion || item.dirección || item.address || null,
  };
}

module.exports = {
  dgiiLookup,
  findRecordInDataset,
  parseDatasetLine,
};
