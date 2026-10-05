'use strict';

/**
 * factory-reset.service.js — "Formatear" Tecno Caja en una PC: dejarla como si
 * el sistema nunca se hubiera instalado ahí (sin datos, sin licencia y sin la
 * identidad del equipo que Firebase conocía).
 *
 * Se hace en dos tiempos:
 *  1. POST /api/system/reset (factoryReset) vacía la BD, desvincula la licencia
 *     y deja un marcador con scheduleFactoryReset().
 *  2. Al reiniciar, electron/main.js llama runPendingFactoryReset() ANTES de
 *     arrancar el servidor: con la BD, los logs y la sesión de WhatsApp
 *     cerrados se puede borrar todo del disco sin pelear con archivos
 *     bloqueados por Windows.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER_RELATIVE_PATH = path.join('config', 'pending-factory-reset.json');
const USER_ENV_RELATIVE_PATH = path.join('config', 'app.env');

// Todo lo que el uso del sistema crea dentro de userData. app.env NO va aquí:
// se limpia aparte (scrubUserEnvFile) porque también guarda la conexión a la
// BD y las credenciales de Firebase, que una instalación nueva necesita.
const USER_DATA_TARGETS = [
  'data',
  'uploads',
  'secure-backups',
  'facturas',
  'reportes',
  'storage',
  'ecf',
  'Sistema_Data',
  'logs',
  'ecf-sequence-high-watermarks.json',
  path.join('config', 'terminal-config.json'),
  path.join('config', 'peripherals-config.json'),
  path.join('config', 'pending-db-migration.json'),
  path.join('config', 'pending-db-migration.json.failed'),
];

// Claves de app.env que atan la PC al negocio anterior. Las tres generadas
// (STORAGE_SECRET, DB_KEY_SALT, DEVICE_SECRET) las vuelve a crear
// runtime-bootstrap en el arranque — DEVICE_SECRET nuevo = deviceId nuevo, así
// que Firebase ve un equipo que nunca se había registrado.
const ENV_KEYS_TO_CLEAR = [
  'TECNO_CAJA_LICENSE_UID',
  'TECNO_CAJA_BUSINESS_ID',
  'TECNO_CAJA_LICENSE_STORAGE_SECRET',
  'TECNO_CAJA_DB_KEY_SALT',
  'TECNO_CAJA_DEVICE_SECRET',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'POS_PUBLIC_BASE_URL',
];
// Claves de versiones viejas (NovaPOS) que ningún código lee ya, pero que
// siguen guardando el UID de licencia y los secretos del negocio anterior.
const LEGACY_ENV_PREFIX = 'NOVAPOS_';

function getMarkerPath(userDataPath) {
  return path.join(userDataPath, MARKER_RELATIVE_PATH);
}

function hasPendingFactoryReset(userDataPath) {
  return Boolean(userDataPath) && fs.existsSync(getMarkerPath(userDataPath));
}

function scheduleFactoryReset({ userDataPath, dbFile = '' } = {}) {
  if (!userDataPath) throw new Error('scheduleFactoryReset requiere userDataPath.');
  const markerPath = getMarkerPath(userDataPath);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify({
    requestedAt: new Date().toISOString(),
    dbFile: String(dbFile || '').trim(),
  }, null, 2), 'utf8');
  return markerPath;
}

function readMarker(userDataPath) {
  try {
    return JSON.parse(fs.readFileSync(getMarkerPath(userDataPath), 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

// DB_FILE puede apuntar fuera de userData/data. Se borra el archivo y sus
// acompañantes (.fpr, -wal, -journal, .backup_*, .corrupt_*): con DB_KEY_SALT
// nuevo, un .db viejo ya no descifra y el arranque lo trataría como corrupto.
function listDbFileFamily(dbFile) {
  const resolved = String(dbFile || '').trim();
  if (!resolved || !/\.db$/i.test(resolved)) return [];
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.startsWith(base))
      .map((name) => path.join(dir, name));
  } catch (_) {
    return [];
  }
}

function removePath(target, log, summary) {
  if (!fs.existsSync(target)) return;
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    summary.removed.push(target);
  } catch (error) {
    summary.failed.push({ path: target, error: error.message });
    log(`No se pudo borrar ${target}: ${error.message}`);
  }
}

function scrubUserEnvFile(envFile) {
  if (!fs.existsSync(envFile)) return false;
  const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
  const scrubbed = [];
  for (const line of lines) {
    const key = line.split('=')[0].trim();
    if (key.startsWith(LEGACY_ENV_PREFIX)) continue;
    scrubbed.push(ENV_KEYS_TO_CLEAR.includes(key) ? `${key}=` : line);
  }
  fs.writeFileSync(envFile, scrubbed.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8');
  return true;
}

function runPendingFactoryReset({
  userDataPath,
  documentsDir = path.join(os.homedir(), 'Documents'),
  workingDir = process.cwd(),
  log = () => {},
} = {}) {
  const summary = { ran: false, removed: [], failed: [] };
  if (!hasPendingFactoryReset(userDataPath)) return summary;
  summary.ran = true;

  const marker = readMarker(userDataPath);
  const targets = [
    ...USER_DATA_TARGETS.map((relative) => path.join(userDataPath, relative)),
    ...listDbFileFamily(marker.dbFile),
    // Respaldos .tcbak automáticos (backup-core usa ~/Documents; Electron puede
    // tener Documentos redirigido, p. ej. a OneDrive — se cubren ambos).
    path.join(documentsDir, 'TecnoCaja'),
    path.join(os.homedir(), 'Documents', 'TecnoCaja'),
    // Sesión del bot de WhatsApp (LocalAuth en server/integrations/whatsapp-bot.js).
    path.join(workingDir, '.wwebjs_auth_pos'),
  ];
  for (const target of new Set(targets)) {
    removePath(target, log, summary);
  }

  scrubUserEnvFile(path.join(userDataPath, USER_ENV_RELATIVE_PATH));
  // runtime-bootstrap no pisa variables que ya estén en process.env: si quedaran
  // aquí, este arranque seguiría usando el deviceId y la licencia anteriores.
  for (const key of Object.keys(process.env)) {
    if (ENV_KEYS_TO_CLEAR.includes(key) || key.startsWith(LEGACY_ENV_PREFIX)) {
      delete process.env[key];
    }
  }

  // El marcador se quita al final: si algo corta el proceso a mitad, el
  // próximo arranque vuelve a intentarlo completo.
  removePath(getMarkerPath(userDataPath), log, summary);
  log(`Formateo completado: ${summary.removed.length} elemento(s) borrado(s), ${summary.failed.length} con error.`);
  return summary;
}

module.exports = {
  ENV_KEYS_TO_CLEAR,
  hasPendingFactoryReset,
  runPendingFactoryReset,
  scheduleFactoryReset,
  scrubUserEnvFile,
};
