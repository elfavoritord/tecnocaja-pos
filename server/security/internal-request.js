'use strict';

/**
 * server/security/internal-request.js
 *
 * Canal firmado para las pocas llamadas que el propio proceso de Electron
 * (electron/main.js) hace contra su servidor Express interno SIN que haya
 * una sesión de usuario disponible (p. ej. el respaldo automático al cerrar
 * la app cuando la ventana ya no existe). Reemplaza al viejo fallback
 * `actorUserId` en body/query — que cualquiera podía mandar sin credencial
 * — por una firma HMAC calculada con un secreto que solo vive en esta
 * instalación (TECNO_CAJA_DEVICE_SECRET, generado una vez por
 * scripts/runtime-bootstrap.js y jamás sale de esta PC).
 *
 * server.js y electron/main.js corren en el MISMO proceso Node (main.js
 * hace `require('./server.js')`), así que ambos ven el mismo
 * `process.env.TECNO_CAJA_DEVICE_SECRET` sin necesidad de IPC ni de leer
 * ningún archivo aparte.
 *
 * No autentica "quién" hizo la petición (no es un usuario) — autentica
 * "qué proceso" la hizo: el propio backend local, corriendo en esta misma
 * máquina. Por eso además se exige que la conexión sea loopback
 * (127.0.0.1/::1): un secreto de proceso sin ese chequeo seguiría siendo
 * válido si alguien lo reenvía desde otra IP.
 */

const crypto = require('crypto');

const HEADER_SIGNATURE = 'x-tecno-caja-internal';
const HEADER_TIMESTAMP = 'x-tecno-caja-internal-ts';
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 minutos — margen generoso, un solo proceso/reloj

function getDeviceSecret() {
  return String(process.env.TECNO_CAJA_DEVICE_SECRET || '').trim();
}

function isLoopbackAddress(address) {
  const normalized = String(address || '').trim().replace('::ffff:', '');
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

function signTimestamp(timestamp) {
  const secret = getDeviceSecret();
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(`tecno-caja-internal:${timestamp}`).digest('hex');
}

/**
 * Cabeceras a adjuntar en una petición HTTP saliente del propio proceso.
 * Devuelve {} si no hay TECNO_CAJA_DEVICE_SECRET configurado (instalación
 * muy vieja que aún no pasó por runtime-bootstrap) — en ese caso la llamada
 * queda sin este respaldo y depende solo del token de sesión si lo hay.
 */
function buildInternalHeaders() {
  const timestamp = String(Date.now());
  const signature = signTimestamp(timestamp);
  if (!signature) return {};
  return {
    [HEADER_SIGNATURE]: signature,
    [HEADER_TIMESTAMP]: timestamp,
  };
}

/**
 * Verifica que `req` traiga una firma interna válida, reciente y desde
 * loopback. No lanza — devuelve boolean para que el llamador decida qué
 * hacer (401, o degradar a "sin actor conocido" según el endpoint).
 */
function verifyInternalRequest(req) {
  const secret = getDeviceSecret();
  if (!secret) return false;

  const remoteAddress = req?.socket?.remoteAddress || req?.connection?.remoteAddress || req?.ip || '';
  if (!isLoopbackAddress(remoteAddress)) return false;

  const timestamp = String(req?.headers?.[HEADER_TIMESTAMP] || '').trim();
  const signature = String(req?.headers?.[HEADER_SIGNATURE] || '').trim();
  if (!timestamp || !signature) return false;

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_CLOCK_SKEW_MS) {
    return false;
  }

  const expected = signTimestamp(timestamp);
  if (!expected) return false;

  try {
    const provided = Buffer.from(signature, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (provided.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(provided, expectedBuf);
  } catch (_error) {
    return false;
  }
}

module.exports = {
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  getDeviceSecret,
  isLoopbackAddress,
  buildInternalHeaders,
  verifyInternalRequest,
};
