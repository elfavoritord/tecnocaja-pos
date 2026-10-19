'use strict';

/**
 * server/multisucursal/identidad.js — Quién es esta base: empresa, sucursal y
 * nodo, con identificadores que no dependen de los ids enteros locales.
 *
 *  - Empresa  = businesses.uuid de config.business_id.
 *  - Sucursal = branches.uuid de la sucursal de esta PC (terminal-config) o
 *               de config.active_branch_id.
 *  - Nodo     = TECNO_CAJA_SERVER_ID (server/network/server-identity.js): el
 *               servidor que sube y baja los cambios de esta sucursal.
 */

const crypto = require('crypto');
const { TABLAS_CON_UUID } = require('../migrations/multisucursal/0001-uuid-entidades');
const { uuidSqlExpression } = require('../migrations/runner');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABLAS_PERMITIDAS = new Set(TABLAS_CON_UUID);

function esUuid(valor) {
  return UUID_PATTERN.test(String(valor || ''));
}

function createIdentidad({
  query,
  dialect = 'sqlite',
  getServerId = () => null,
  getBranchIdOverride = () => null,
  randomUUID = () => crypto.randomUUID(),
}) {
  function tablaPermitida(tabla) {
    if (!TABLAS_PERMITIDAS.has(tabla)) throw new Error(`La tabla ${tabla} no lleva uuid`);
    return tabla;
  }

  // Devuelve el uuid de la fila, asignándolo si todavía no tiene. Seguro entre
  // dos PC a la vez: el UPDATE solo pisa NULL y después se relee.
  async function asegurarUuid(executor, tabla, id) {
    tablaPermitida(tabla);
    const run = typeof executor === 'function' ? executor : (executor?.query || query);
    const filaId = Number(id || 0);
    if (!filaId) return null;
    // Primero leer: consultar la identidad no debe escribir en la base (en
    // SQLite cada escritura programa un guardado del archivo).
    const actual = await run(`SELECT \`uuid\` FROM ${tabla} WHERE id = ? LIMIT 1`, [filaId]);
    if (!actual.length) return null;
    if (actual[0].uuid) return actual[0].uuid;
    await run(`UPDATE ${tabla} SET \`uuid\` = ? WHERE id = ? AND \`uuid\` IS NULL`, [randomUUID(), filaId]);
    const rows = await run(`SELECT \`uuid\` FROM ${tabla} WHERE id = ? LIMIT 1`, [filaId]);
    return rows[0]?.uuid || null;
  }

  // Filas creadas por el código actual (que todavía no conoce el uuid). Se
  // llama al arrancar; es una sola sentencia por tabla.
  async function rellenarUuidsFaltantes() {
    const expr = uuidSqlExpression(dialect);
    const resultado = {};
    for (const tabla of TABLAS_CON_UUID) {
      try {
        const r = await query(`UPDATE ${tabla} SET \`uuid\` = ${expr} WHERE \`uuid\` IS NULL`);
        resultado[tabla] = Number(r?.affectedRows || 0);
      } catch (error) {
        // Tabla o columna inexistente (instalación sin la migración): no aplica.
        resultado[tabla] = null;
      }
    }
    return resultado;
  }

  async function obtener() {
    const configRows = await query(
      'SELECT business_id, active_branch_id, business_structure_mode FROM config WHERE id = 1 LIMIT 1'
    ).catch(() => []);
    const cfg = configRows[0] || {};

    let businessId = Number(cfg.business_id || 0);
    if (!businessId) {
      const rows = await query('SELECT id FROM businesses ORDER BY id LIMIT 1').catch(() => []);
      businessId = Number(rows[0]?.id || 0);
    }

    let branchId = Number(getBranchIdOverride() || cfg.active_branch_id || 0);
    if (!branchId) {
      const rows = await query("SELECT id FROM branches WHERE estado <> 'Eliminada' ORDER BY id LIMIT 1").catch(() => []);
      branchId = Number(rows[0]?.id || 0);
    }

    const [empresaUuid, sucursalUuid] = await Promise.all([
      businessId ? asegurarUuid(query, 'businesses', businessId) : null,
      branchId ? asegurarUuid(query, 'branches', branchId) : null,
    ]);

    return {
      empresa: { id: businessId || null, uuid: empresaUuid },
      sucursal: { id: branchId || null, uuid: sucursalUuid },
      nodo: getServerId() || null,
      modo: String(cfg.business_structure_mode || 'monocaja'),
    };
  }

  return { obtener, asegurarUuid, rellenarUuidsFaltantes };
}

module.exports = { createIdentidad, esUuid, UUID_PATTERN };
