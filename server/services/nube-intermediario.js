'use strict';

/**
 * Respaldos en la nube a través del servicio de Tecno Caja (Sync API), sin
 * llave de Backblaze en esta PC. Ver cloud/sync-api/lib/respaldos.js.
 *
 * - La PC se presenta con su licencia y su equipo (registrado en la licencia)
 *   y recibe un permiso de 1 hora para su carpeta backups/<licencia>/.
 * - En una PC recién instalada o formateada, el dueño entra con su cuenta y
 *   recibe un permiso de 30 minutos para leer los respaldos de sus negocios.
 * - Subir y bajar van directo a Backblaze con enlaces firmados de 5 minutos.
 *
 * r2-storage.js lo usa cuando esta PC no tiene llave propia en su app.env.
 */

const crypto = require('crypto');

// Mismo servicio que la multisucursal (server/multisucursal/enlace.js).
const URL_POR_DEFECTO = 'https://tecno-caja-sync-api-1052855422372.us-east1.run.app';

function baseUrl() {
  const propia = String(process.env.TECNO_CAJA_SYNC_URL || '').trim();
  if (propia.toLowerCase() === 'off') return '';
  // Las pruebas nunca hablan con el servicio real sin pedirlo.
  if (!propia && process.env.NODE_ENV === 'test') return '';
  return String(propia || URL_POR_DEFECTO).replace(/\/+$/, '');
}

let deviceIdCache = null;
function deviceId() {
  if (!deviceIdCache) {
    try { deviceIdCache = require('../security/machine-identity').getDeviceDescriptor().deviceId; } catch (_) { deviceIdCache = ''; }
  }
  return deviceIdCache;
}

const licencia = () => String(process.env.TECNO_CAJA_LICENSE_UID || '').trim();

let sesionEquipo = null; // { token, exp, licenseId }
let sesionDueno = null;  // { token, exp, licencias: [...] }

function error(mensaje, code, status) {
  return Object.assign(new Error(mensaje), { code, statusCode: status });
}

async function llamar(ruta, cuerpo, token, { timeoutMs = 20000 } = {}) {
  const base = baseUrl();
  if (!base) throw error('La nube de Tecno Caja está apagada en esta PC (TECNO_CAJA_SYNC_URL=off).', 'NUBE_APAGADA');
  let r;
  try {
    r = await fetch(`${base}${ruta}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(cuerpo || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw error(`No se pudo conectar con la nube de Tecno Caja: ${e.message}`, 'SIN_CONEXION');
  }
  const datos = await r.json().catch(() => ({}));
  if (!r.ok || datos.ok === false) throw error(datos.error || `La nube de Tecno Caja respondió ${r.status}.`, datos.code || 'ERROR_NUBE', r.status);
  return datos;
}

// ¿Puede esta PC usar la nube por el servicio? (tiene licencia o hay dueño adentro)
function disponible() {
  return Boolean(baseUrl()) && (Boolean(licencia() && deviceId()) || Boolean(sesionDueno && sesionDueno.exp > Date.now()));
}

async function tokenEquipo() {
  const lic = licencia();
  if (sesionEquipo && sesionEquipo.licenseId === lic && sesionEquipo.exp - 60000 > Date.now()) return sesionEquipo.token;
  if (!lic) throw error('Esta PC todavía no tiene licencia.', 'SIN_LICENCIA');
  const r = await llamar('/v1/respaldos/sesion', { licenseId: lic, deviceId: deviceId() });
  sesionEquipo = { token: r.token, exp: new Date(r.expira).getTime(), licenseId: lic };
  return r.token;
}

// El dueño entró con su cuenta (asistente o restaurar en una PC sin licencia).
async function entrarComoDueno(idToken) {
  const r = await llamar('/v1/respaldos/sesion', { idToken: String(idToken || '') });
  sesionDueno = { token: r.token, exp: new Date(r.expira).getTime(), licencias: (r.licencias || []).map((l) => l.licenseId), email: r.email };
  return r;
}

function salirDueno() { sesionDueno = null; }

// Permiso para una licencia: el de la PC si es la suya; si no, el del dueño.
async function tokenPara(licenseId) {
  if (licenseId && licenseId === licencia() && deviceId()) {
    try { return await tokenEquipo(); } catch (e) {
      if (!(sesionDueno && sesionDueno.licencias.includes(licenseId))) throw e;
    }
  }
  if (sesionDueno && sesionDueno.exp > Date.now() && (!licenseId || sesionDueno.licencias.includes(licenseId))) return sesionDueno.token;
  if (!licenseId || licenseId === licencia()) return tokenEquipo();
  throw error('Ese negocio no es de esta PC. Entra con la cuenta del dueño.', 'OTRO_NEGOCIO', 403);
}

const licenciaDeLlave = (key) => (String(key || '').match(/^backups\/([^/]+)\//) || [])[1] || '';

async function listar(prefijo) {
  const licenseId = licenciaDeLlave(prefijo) || licencia();
  const r = await llamar('/v1/respaldos/listar', { licenseId }, await tokenPara(licenseId));
  // Mismo formato que ListObjectsV2 del SDK (Key, Size, LastModified).
  return (r.objetos || [])
    .filter((o) => String(o.key).startsWith(prefijo || ''))
    .map((o) => ({ Key: o.key, Size: o.size, LastModified: o.lastModified ? new Date(o.lastModified) : null }));
}

async function subir(key, buffer) {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const p = await llamar('/v1/respaldos/subir', { key, sha256, tamano: buffer.length }, await tokenPara(licenciaDeLlave(key)));
  let r;
  try {
    r = await fetch(p.url, { method: 'PUT', headers: p.headers || {}, body: buffer, signal: AbortSignal.timeout(180000) });
  } catch (e) {
    throw error(`No se pudo subir el respaldo: ${e.message}`, 'SIN_CONEXION');
  }
  if (!r.ok) throw error(`La nube rechazó el respaldo (${r.status}).`, 'SUBIDA_RECHAZADA', r.status);
  await verificar(key, { size: buffer.length, sha256 });
  return { sha256, verifiedAt: new Date().toISOString() };
}

async function verificar(key, { size, sha256 }) {
  const r = await llamar('/v1/respaldos/verificar', { key }, await tokenPara(licenciaDeLlave(key)));
  if (Number(r.size) !== Number(size) || r.sha256 !== sha256) {
    throw error('La nube no confirmó tamaño y huella del respaldo. Permanece pendiente de envío.', 'NO_CONFIRMADO');
  }
  return { verifiedAt: new Date().toISOString() };
}

async function bajar(key) {
  const p = await llamar('/v1/respaldos/bajar', { key }, await tokenPara(licenciaDeLlave(key)));
  let r;
  try {
    r = await fetch(p.url, { signal: AbortSignal.timeout(180000) });
  } catch (e) {
    throw error(`No se pudo bajar el respaldo: ${e.message}`, 'SIN_CONEXION');
  }
  if (!r.ok) throw error(`La nube no entregó el respaldo (${r.status}).`, 'BAJADA_RECHAZADA', r.status);
  return Buffer.from(await r.arrayBuffer());
}

async function borrar(key) {
  await llamar('/v1/respaldos/borrar', { key }, await tokenPara(licenciaDeLlave(key)));
}

// Clave con que se cifran los respaldos del negocio. La PC manda la suya si
// tiene una propia (TECNO_CAJA_SECURITY_PASSWORD) para que quede guardada; si no
// la tiene (formateada), recibe la guardada.
async function clave(licenseId = licencia(), { propia = '' } = {}) {
  return llamar('/v1/respaldos/clave', { licenseId, ...(propia ? { propia } : {}) }, await tokenPara(licenseId));
}

// Deja guardada en el servicio la clave de los respaldos de esta PC (o la
// recupera si la PC se formateó y ya no la tiene). Corre en segundo plano al
// arrancar y cada 12 h; sin Internet o sin licencia no hace nada.
async function sincronizarClave({ persistEnv = null } = {}) {
  if (!baseUrl() || !licencia() || !deviceId()) return { omitido: true };
  const propia = String(process.env.TECNO_CAJA_SECURITY_PASSWORD || '').trim();
  const r = await clave(licencia(), { propia });
  // Formateada: vuelve la clave con que se cifraron sus respaldos de antes.
  if (!propia && r.clave && r.clave !== 'Seguridad2026' && typeof persistEnv === 'function') {
    persistEnv({ TECNO_CAJA_SECURITY_PASSWORD: r.clave });
    return { recuperada: true };
  }
  return { guardada: Boolean(r.guardada) };
}

function _reiniciar() { sesionEquipo = null; sesionDueno = null; deviceIdCache = null; }

module.exports = {
  disponible, entrarComoDueno, salirDueno, listar, subir, verificar, bajar, borrar, clave, sincronizarClave, baseUrl, _reiniciar,
  _sesionDueno: () => sesionDueno,
};
