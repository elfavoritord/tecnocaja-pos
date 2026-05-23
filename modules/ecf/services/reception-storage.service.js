'use strict';

const fs = require('fs');
const path = require('path');
const { EcfError, assertCondition } = require('../utils/errors');

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

function sanitizeTrackId(trackId) {
  return String(trackId || '')
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'sin-track';
}

function parseJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function normalizeReceptionState(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'ENVIADO';
  if (normalized.includes('aceptado condicional')) return 'ACEPTADO_CONDICIONAL';
  if (normalized.includes('aceptado')) return 'ACEPTADO';
  if (normalized.includes('rechaz')) return 'RECHAZADO';
  if (normalized.includes('proceso') || normalized.includes('procesando') || normalized.includes('pendiente')) return 'PROCESANDO';
  if (normalized.includes('enviado')) return 'ENVIADO';
  return String(value || 'ENVIADO').trim().toUpperCase();
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((message) => {
      if (!message || typeof message !== 'object') return null;
      return {
        valor: message.valor ?? message.Valor ?? null,
        codigo: message.codigo ?? message.Codigo ?? null,
      };
    })
    .filter((message) => message && (message.valor || message.codigo !== null));
}

class ReceptionStorageService {
  constructor({ logger, baseDir = process.cwd(), now = () => new Date() } = {}) {
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.baseDir = path.resolve(baseDir);
    this.now = now;
    this.enviadosDir = path.join(this.baseDir, 'storage', 'ecf', 'enviados');
    this.tracksDir = path.join(this.baseDir, 'storage', 'ecf', 'tracks');
    this.currentSentXmlPath = path.join(this.enviadosDir, 'current-enviado.xml');
    this.currentSentMetaPath = path.join(this.enviadosDir, 'current-enviado.json');
    this.currentTrackPath = path.join(this.tracksDir, 'current-track.json');
    this.currentTrackStatusPath = path.join(this.tracksDir, 'current-track-status.json');
  }

  ensureStorage() {
    fs.mkdirSync(this.enviadosDir, { recursive: true });
    fs.mkdirSync(this.tracksDir, { recursive: true });
  }

  getPaths() {
    return {
      enviadosDir: this.enviadosDir,
      tracksDir: this.tracksDir,
      currentSentXmlPath: this.currentSentXmlPath,
      currentSentMetaPath: this.currentSentMetaPath,
      currentTrackPath: this.currentTrackPath,
      currentTrackStatusPath: this.currentTrackStatusPath,
    };
  }

  saveSentXml({ xmlContent, environment = 'certecf', sourcePath = null, filename = null, dgiiFileName = null } = {}) {
    this.ensureStorage();
    const content = String(xmlContent || '');
    assertCondition(content.trim(), 'El XML a enviar está vacío.', { statusCode: 422 });

    const now = this.now();
    const id = formatTimestampId(now);
    const targetPath = path.join(this.enviadosDir, `ecf-enviado-${id}.xml`);
    const entry = {
      id,
      fecha: now.toISOString(),
      environment,
      estado: 'ENVIADO',
      xmlPath: this.#displayPath(targetPath),
      filename: path.basename(targetPath),
      dgiiFileName: dgiiFileName || null,
      sourcePath: sourcePath ? this.#displayPath(sourcePath) : null,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
    };

    fs.writeFileSync(targetPath, content, 'utf8');
    fs.writeFileSync(this.currentSentXmlPath, content, 'utf8');
    this.#writeJson(this.currentSentMetaPath, entry);
    return entry;
  }

  saveTrack({ trackId, mensaje = null, error = null, codigo = null, descripcion = null, environment = 'certecf', xmlPath = null, httpStatus = null, responseBody = null } = {}) {
    this.ensureStorage();
    const now = this.now();
    const id = formatTimestampId(now);
    const targetPath = path.join(this.tracksDir, `track-${id}.json`);
    const entry = {
      trackId: String(trackId || '').trim(),
      fecha: now.toISOString(),
      estado: 'ENVIADO',
      environment,
      codigo: codigo ? String(codigo) : null,
      descripcion: descripcion || mensaje || null,
      mensaje: mensaje || null,
      error: error || null,
      xmlPath: xmlPath || null,
      httpStatus: httpStatus || null,
      responseBody: responseBody || null,
      trackPath: this.#displayPath(targetPath),
    };

    this.#writeJson(targetPath, entry);
    this.#writeJson(this.currentTrackPath, entry);
    return entry;
  }

  saveTrackStatus({ trackId, payload, environment = 'certecf', httpStatus = null } = {}) {
    this.ensureStorage();
    assertCondition(trackId, 'Debe indicar un TrackId para guardar su estado.', { statusCode: 422 });

    const targetPath = path.join(this.tracksDir, `estado-${sanitizeTrackId(trackId)}.json`);
    const codigo = payload?.codigo || payload?.Codigo || payload?.codigorespuesta || payload?.CodigoRespuesta || null;
    const normalizedState = String(codigo || '').trim() === '4'
      ? 'ACEPTADO_CONDICIONAL'
      : normalizeReceptionState(payload?.estado || payload?.Estado || payload?.status || payload?.mensaje || payload?.message);
    const entry = {
      trackId: String(trackId || '').trim(),
      fecha: this.now().toISOString(),
      estado: normalizedState,
      environment,
      codigo,
      descripcion: payload?.descripcion || payload?.Descripcion || payload?.descripcionMensaje || payload?.DescripcionMensaje || payload?.mensaje || payload?.message || null,
      mensaje: payload?.mensaje || payload?.message || null,
      error: payload?.error || null,
      rnc: payload?.rnc || payload?.RNC || payload?.rncemisor || payload?.RNCEmisor || null,
      encf: payload?.encf || payload?.eNCF || payload?.NCFElectronico || null,
      secuenciaUtilizada: payload?.secuenciaUtilizada ?? payload?.SecuenciaUtilizada ?? null,
      fechaRecepcion: payload?.fechaRecepcion || payload?.FechaRecepcion || null,
      mensajes: normalizeMessages(payload?.mensajes || payload?.Mensajes),
      httpStatus: httpStatus || null,
      raw: payload?.raw || payload?.responseBody || payload || null,
      statusPath: this.#displayPath(targetPath),
    };

    this.#writeJson(targetPath, entry);
    this.#writeJson(this.currentTrackStatusPath, entry);
    return entry;
  }

  getState() {
    this.ensureStorage();
    return {
      latestSent: parseJsonIfExists(this.currentSentMetaPath),
      latestTrack: parseJsonIfExists(this.currentTrackPath),
      latestTrackStatus: parseJsonIfExists(this.currentTrackStatusPath),
      currentSentXmlPath: fs.existsSync(this.currentSentXmlPath) ? this.#displayPath(this.currentSentXmlPath) : null,
      currentSentMetaPath: fs.existsSync(this.currentSentMetaPath) ? this.#displayPath(this.currentSentMetaPath) : null,
      currentTrackPath: fs.existsSync(this.currentTrackPath) ? this.#displayPath(this.currentTrackPath) : null,
      currentTrackStatusPath: fs.existsSync(this.currentTrackStatusPath) ? this.#displayPath(this.currentTrackStatusPath) : null,
    };
  }

  getCurrentSentXml() {
    this.ensureStorage();
    assertCondition(fs.existsSync(this.currentSentXmlPath), 'No hay un XML enviado disponible todavía.', { statusCode: 404 });
    return {
      meta: parseJsonIfExists(this.currentSentMetaPath),
      xml: fs.readFileSync(this.currentSentXmlPath, 'utf8'),
      path: this.#displayPath(this.currentSentXmlPath),
    };
  }

  #writeJson(filePath, payload) {
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  #displayPath(filePath) {
    const absolute = path.resolve(filePath);
    if (absolute.startsWith(this.baseDir)) {
      return toPosix(path.relative(this.baseDir, absolute));
    }
    return toPosix(absolute);
  }
}

module.exports = {
  ReceptionStorageService,
  formatTimestampId,
  normalizeReceptionState,
  sanitizeTrackId,
};
