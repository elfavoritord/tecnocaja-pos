'use strict';

/**
 * Permiso temporal para reemplazar el negocio de una instalación que ya está
 * configurada, desde la pantalla de inicio ("Reinstalar una app existente"):
 * restaurar un respaldo encima (local o de la nube) o crear un negocio nuevo.
 *
 * Lo emite POST /api/setup/autorizar-reemplazo (server/routes/setup-reemplazo.routes.js)
 * después de validar la clave de seguridad o un administrador general. Las
 * rutas de setup (respaldos.routes.js → setupOnly, /api/setup/complete) lo
 * exigen cuando el sistema ya tiene negocio y usuarios.
 *
 * El secreto es aleatorio por proceso: un reinicio invalida los permisos ya
 * emitidos (hay que volver a escribir la clave), y no hay ningún valor fijo
 * que alguien pueda sacar del instalador.
 */

const crypto = require('crypto');

const DURACION_MS = 20 * 60 * 1000;
const SECRETO = crypto.randomBytes(32);
const CABECERA = 'x-tc-reemplazo';

function firmar(datos) {
  return crypto.createHmac('sha256', SECRETO).update(datos).digest('base64url');
}

function emitirAutorizacionReemplazo(ahora = Date.now()) {
  const datos = Buffer.from(JSON.stringify({
    exp: ahora + DURACION_MS,
    n: crypto.randomBytes(8).toString('hex')
  })).toString('base64url');
  return `${datos}.${firmar(datos)}`;
}

function verificarAutorizacionReemplazo(token, ahora = Date.now()) {
  const [datos, firma] = String(token || '').split('.');
  if (!datos || !firma) return false;
  const recibida = Buffer.from(firma);
  const esperada = Buffer.from(firmar(datos));
  if (recibida.length !== esperada.length || !crypto.timingSafeEqual(recibida, esperada)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(datos, 'base64url').toString('utf8'));
    return Number(exp) > ahora;
  } catch (_error) {
    return false;
  }
}

function leerAutorizacionReemplazo(req) {
  return String(req?.headers?.[CABECERA] || req?.body?.reemplazoToken || '');
}

module.exports = {
  DURACION_MS,
  CABECERA,
  emitirAutorizacionReemplazo,
  verificarAutorizacionReemplazo,
  leerAutorizacionReemplazo
};
