'use strict';
const crypto = require('crypto');
const VERSION = '3';
const IDENTIFICADOR = /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/;
// Autorizaciones de equipo, sesiones y tokens se recuperan por su flujo seguro,
// nunca por copiar un archivo de otro ordenador.
const EXCLUIDAS = /^(sqlite_|license_cache$|auth_sessions$|sesiones_activas$|backup_upload_retry$|mobile_access_tokens$|login_attempts$|offline_cache_users$|offline_users_cache$|offline_auth_cache$)/i;
const SECRETO = /(^|_)(password|secret|token|private_key|api_key|access_key|application_key|client_secret)(_|$)/i;
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function esTablaValida(name) { return IDENTIFICADOR.test(name) && !EXCLUIDAS.test(name); }
function limpiarFila(table, original, pendientes) {
  const row = { ...original };
  if (table === 'installation_config' && SECRETO.test(String(row.config_key || ''))) { pendientes.add(`installation_config.${row.config_key}`); return null; }
  if (table === 'users' && row.password && !row.password_hash) {
    const salt = crypto.randomBytes(16).toString('hex');
    row.password_hash = `scrypt:${salt}:${crypto.scryptSync(String(row.password), salt, 64).toString('hex')}`;
  }
  for (const [key, value] of Object.entries(row)) {
    if (table === 'users' && key === 'password') { row.password = ''; continue; }
    if (key === 'password_hash') continue;
    if (SECRETO.test(key)) { delete row[key]; if (value) pendientes.add(`${table}.${key}`); }
    else if (Buffer.isBuffer(value) || value instanceof Uint8Array) row[key] = { __tcbak_binary: Buffer.from(value).toString('base64') };
  }
  return row;
}
async function capturarCatalogo(query) {
  const descubiertas = await query("SELECT name, sql FROM sqlite_master WHERE type = 'table'");
  const pendientes = new Set(), tablas = {}, manifiesto = [];
  for (const entrada of descubiertas) {
    const tabla = String(entrada.name || '');
    if (!esTablaValida(tabla)) continue;
    if (entrada.sql && !/^CREATE\s+TABLE\b/i.test(entrada.sql)) { pendientes.add(`reconstruir:${tabla}`); continue; }
    // Si falla UNA tabla existente, no se produce un respaldo aparentemente completo.
    const rows = (await query(`SELECT * FROM \`${tabla}\``)).map((r) => limpiarFila(tabla, r, pendientes)).filter(Boolean);
    tablas[tabla] = rows;
    manifiesto.push({ nombre: tabla, registros: rows.length, sha256: hash(rows) });
  }
  return { tablas, manifiesto, requiereReconfiguracion: [...pendientes].sort() };
}
function validarCatalogo(payload) {
  const catalogo = payload.catalogo;
  if (!catalogo || !catalogo.tablas || !Array.isArray(catalogo.manifiesto)) throw new Error('El respaldo integral no contiene un manifiesto válido.');
  const vistas = new Set();
  for (const entrada of catalogo.manifiesto) {
    const tabla = entrada.nombre;
    if (!esTablaValida(tabla) || vistas.has(tabla) || !Array.isArray(catalogo.tablas[tabla])) throw new Error('Tabla de respaldo inválida o repetida.');
    vistas.add(tabla);
    const rows = catalogo.tablas[tabla];
    if (rows.length !== entrada.registros || hash(rows) !== entrada.sha256) throw new Error(`Integridad incorrecta en ${tabla}.`);
    for (const row of rows) if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some((k) => !IDENTIFICADOR.test(k))) throw new Error('Fila o columna de respaldo inválida.');
  }
  if (Object.keys(catalogo.tablas).some((tabla) => !vistas.has(tabla))) throw new Error('Hay tablas fuera del manifiesto.');
  return catalogo;
}
module.exports = { VERSION, esTablaValida, capturarCatalogo, validarCatalogo, limpiarFila, hash };
