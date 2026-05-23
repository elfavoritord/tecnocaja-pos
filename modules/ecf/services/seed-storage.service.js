'use strict';

const fs = require('fs');
const path = require('path');
const { EcfError } = require('../utils/errors');

const MAX_SEED_HISTORY = 20;
const MAX_SEED_AGE_MS = 60 * 60 * 1000;

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

function formatTimestampId(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function sortHistory(history) {
  return [...history].sort((left, right) => {
    const leftTime = new Date(left?.fecha || 0).getTime();
    const rightTime = new Date(right?.fecha || 0).getTime();
    return rightTime - leftTime;
  });
}

function parseHistory(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

class SeedStorageService {
  constructor({ logger, baseDir = process.cwd(), now = () => new Date() } = {}) {
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.baseDir = path.resolve(baseDir);
    this.now = now;
    this.seedDir = path.join(this.baseDir, 'storage', 'ecf', 'seeds');
    this.historyPath = path.join(this.seedDir, 'history.json');
    this.currentSeedPath = path.join(this.seedDir, 'current-semilla.xml');
    this.currentSignedSeedPath = path.join(this.seedDir, 'current-semilla-firmada.xml');
  }

  ensureStorage() {
    fs.mkdirSync(this.seedDir, { recursive: true });
    if (!fs.existsSync(this.historyPath)) {
      fs.writeFileSync(this.historyPath, '[]\n', 'utf8');
    }
  }

  getPaths() {
    return {
      seedDir: this.seedDir,
      historyPath: this.historyPath,
      currentSeedPath: this.currentSeedPath,
      currentSignedSeedPath: this.currentSignedSeedPath,
    };
  }

  getState() {
    this.ensureStorage();
    const history = this.#readAndPruneHistory();
    return {
      current: this.#serializeEntry(history[0] || null),
      history: history.map((entry) => this.#serializeEntry(entry)),
      currentSeedPath: this.#relativePath(this.currentSeedPath),
      currentSignedSeedPath: this.#relativePath(this.currentSignedSeedPath),
      historyPath: this.#relativePath(this.historyPath),
    };
  }

  saveSeed({ seedXml, seedValue = null, seedDate = null, environment = 'testecf', estado = 'obtenida' }) {
    this.ensureStorage();
    const seedXmlContent = String(seedXml || '');
    if (!seedXmlContent.trim()) {
      throw new EcfError('No se pudo obtener una nueva semilla desde DGII', {
        statusCode: 502,
        details: {
          environment,
        },
      });
    }

    const now = this.now();
    const id = formatTimestampId(now);
    const seedFilePath = path.join(this.seedDir, `semilla-${id}.xml`);
    const entry = {
      id,
      environment,
      fecha: now.toISOString(),
      seedDetected: Boolean(seedValue),
      seedValue: seedValue ? String(seedValue) : null,
      seedDate: seedDate ? String(seedDate) : null,
      estado,
      xmlPath: this.#relativePath(seedFilePath),
      signedPath: null,
      xmlOriginal: seedXmlContent,
      xmlSigned: null,
      tokenDetected: false,
      issuedAt: null,
      expiresAt: null,
      error: null,
    };

    const history = this.#readAndPruneHistory();
    fs.writeFileSync(seedFilePath, seedXmlContent, 'utf8');
    fs.writeFileSync(this.currentSeedPath, seedXmlContent, 'utf8');

    const nextHistory = this.#pruneHistory([entry, ...history]);
    this.#writeHistory(nextHistory);
    this.#syncCurrentSeed(nextHistory);
    return this.#serializeEntry(entry);
  }

  markSigned({ id, signedXml, estado = 'firmada' }) {
    return this.#updateEntry(id, (entry) => {
      const signedXmlContent = String(signedXml || '');
      if (!signedXmlContent.trim()) {
        throw new EcfError('La semilla firmada no contiene XML válido.', {
          statusCode: 422,
        });
      }

      const signedPath = path.join(this.seedDir, `semilla-firmada-${entry.id}.xml`);
      fs.writeFileSync(signedPath, signedXmlContent, 'utf8');
      fs.writeFileSync(this.currentSignedSeedPath, signedXmlContent, 'utf8');
      return {
        ...entry,
        estado,
        signedPath: this.#relativePath(signedPath),
        xmlSigned: signedXmlContent,
        error: null,
      };
    });
  }

  markAuthenticated({ id, tokenDetected, issuedAt = null, expiresAt = null }) {
    return this.#updateEntry(id, (entry) => ({
      ...entry,
      estado: tokenDetected ? 'autenticada' : entry.estado,
      tokenDetected: Boolean(tokenDetected),
      issuedAt: issuedAt || null,
      expiresAt: expiresAt || null,
      error: tokenDetected ? null : entry.error,
    }));
  }

  markFailed({ id, error, estado = 'error' }) {
    return this.#updateEntry(id, (entry) => ({
      ...entry,
      estado,
      error: error ? String(error) : 'Error desconocido al procesar la semilla.',
    }));
  }

  getCurrentXml(type = 'original') {
    this.ensureStorage();
    const history = this.#readAndPruneHistory();
    const current = history[0];
    if (!current) {
      throw new EcfError('No hay semilla disponible en el historial.', {
        statusCode: 404,
      });
    }

    if (type === 'signed') {
      if (!current.xmlSigned) {
        throw new EcfError('La semilla actual todavía no tiene XML firmado.', {
          statusCode: 404,
        });
      }
      return {
        entry: this.#serializeEntry(current),
        xml: current.xmlSigned,
      };
    }

    return {
      entry: this.#serializeEntry(current),
      xml: current.xmlOriginal,
    };
  }

  clearHistory() {
    this.ensureStorage();
    const history = this.#readHistory();
    for (const entry of history) {
      this.#removeEntryFiles(entry);
    }
    if (fs.existsSync(this.currentSeedPath)) {
      fs.rmSync(this.currentSeedPath, { force: true });
    }
    if (fs.existsSync(this.currentSignedSeedPath)) {
      fs.rmSync(this.currentSignedSeedPath, { force: true });
    }
    this.#writeHistory([]);
    return {
      ok: true,
      removed: history.length,
    };
  }

  #updateEntry(id, updater) {
    this.ensureStorage();
    const history = this.#readAndPruneHistory();
    const targetId = id || history[0]?.id || null;
    if (!targetId) {
      throw new EcfError('No hay una semilla actual para procesar.', {
        statusCode: 404,
      });
    }

    const nextHistory = history.map((entry) => {
      if (entry.id !== targetId) return entry;
      return updater({ ...entry });
    });

    if (!nextHistory.some((entry) => entry.id === targetId)) {
      throw new EcfError('La semilla solicitada ya no está disponible.', {
        statusCode: 404,
      });
    }

    const prunedHistory = this.#pruneHistory(nextHistory);
    this.#writeHistory(prunedHistory);
    this.#syncCurrentSeed(prunedHistory);
    const updated = prunedHistory.find((entry) => entry.id === targetId) || null;
    return this.#serializeEntry(updated);
  }

  #readHistory() {
    this.ensureStorage();
    return sortHistory(parseHistory(fs.readFileSync(this.historyPath, 'utf8')));
  }

  #readAndPruneHistory() {
    const history = this.#pruneHistory(this.#readHistory());
    this.#writeHistory(history);
    this.#syncCurrentSeed(history);
    return history;
  }

  #pruneHistory(history) {
    const nowMs = this.now().getTime();
    const sorted = sortHistory(history);
    const kept = [];

    for (const entry of sorted) {
      const createdAtMs = new Date(entry?.fecha || 0).getTime();
      const isExpired = !Number.isFinite(createdAtMs) || nowMs - createdAtMs > MAX_SEED_AGE_MS;
      if (isExpired) {
        this.#removeEntryFiles(entry);
        continue;
      }
      kept.push(entry);
    }

    const trimmed = kept.slice(0, MAX_SEED_HISTORY);
    for (const entry of kept.slice(MAX_SEED_HISTORY)) {
      this.#removeEntryFiles(entry);
    }

    return trimmed;
  }

  #writeHistory(history) {
    this.ensureStorage();
    fs.writeFileSync(this.historyPath, `${JSON.stringify(sortHistory(history), null, 2)}\n`, 'utf8');
  }

  #syncCurrentSeed(history) {
    const current = sortHistory(history)[0] || null;
    if (!current?.xmlOriginal) {
      if (fs.existsSync(this.currentSeedPath)) {
        fs.rmSync(this.currentSeedPath, { force: true });
      }
      if (fs.existsSync(this.currentSignedSeedPath)) {
        fs.rmSync(this.currentSignedSeedPath, { force: true });
      }
      return;
    }
    fs.writeFileSync(this.currentSeedPath, String(current.xmlOriginal || ''), 'utf8');
    if (current.xmlSigned) {
      fs.writeFileSync(this.currentSignedSeedPath, String(current.xmlSigned || ''), 'utf8');
    } else if (fs.existsSync(this.currentSignedSeedPath)) {
      fs.rmSync(this.currentSignedSeedPath, { force: true });
    }
  }

  #removeEntryFiles(entry) {
    const files = [entry?.xmlPath, entry?.signedPath]
      .filter(Boolean)
      .map((relativePath) => path.resolve(this.baseDir, relativePath));

    for (const filePath of files) {
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
      }
    }
  }

  #serializeEntry(entry) {
    if (!entry) return null;
    return {
      id: entry.id,
      environment: entry.environment,
      fecha: entry.fecha,
      seedDetected: Boolean(entry.seedDetected),
      seedValue: entry.seedValue || null,
      seedDate: entry.seedDate || null,
      estado: entry.estado || 'obtenida',
      xmlPath: entry.xmlPath || null,
      signedPath: entry.signedPath || null,
      hasSignedXml: Boolean(entry.xmlSigned),
      tokenDetected: Boolean(entry.tokenDetected),
      issuedAt: entry.issuedAt || null,
      expiresAt: entry.expiresAt || null,
      error: entry.error || null,
    };
  }

  #relativePath(filePath) {
    return toPosix(path.relative(this.baseDir, filePath));
  }
}

module.exports = {
  MAX_SEED_AGE_MS,
  MAX_SEED_HISTORY,
  SeedStorageService,
  formatTimestampId,
};
