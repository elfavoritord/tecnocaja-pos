'use strict';

/**
 * backup-core.js — Lógica compartida para construir, cifrar, leer y restaurar
 * respaldos .tcbak de Tecno Caja.
 *
 * Extraído de server/routes/respaldos.routes.js para que tanto las rutas de
 * respaldo manual como la recuperación automática al arrancar (ver
 * server/services/auto-recovery.js) usen exactamente la misma lógica de
 * construcción/lectura de .tcbak, sin duplicar código.
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const crypto = require('crypto');

const { query: _dbQuery, withTransaction: _withDbTransaction, withReadSnapshot, getDbClient } = require('../../db');
const catalog = require('./backup-catalog');

const BACKUP_MAGIC          = 'TECNOCAJA_BACKUP_V1';
const BACKUP_FORMAT_VERSION = catalog.VERSION;

function getDefaultBackupDir() {
  return path.join(os.homedir(), 'Documents', 'TecnoCaja', 'Backups');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Escritura atómica de un .tcbak: escribe a un temporal, fuerza fsync (bytes
// ya en disco) y recién entonces hace rename sobre el archivo final. Si la
// PC pierde energía en cualquier punto antes del rename, el .tcbak nunca
// queda truncado/corrupto a medias — o el archivo final no existe todavía,
// o existe completo. Mismo patrón que la escritura de la BD en db.js.
function writeFileAtomic(filePath, buffer) {
  const tmpFile = filePath + '.tmp-' + process.pid;
  fs.writeFileSync(tmpFile, buffer);
  const fd = fs.openSync(tmpFile, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpFile, filePath);
}

function generateFilename(businessName, version) {
  const tz  = 'America/Santo_Domingo';
  const now = new Date();
  const fecha = now.toLocaleDateString('es-DO', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz })
                   .replace(/\//g, '-');
  const hora  = now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
                   .replace(':', 'h');
  const safe  = (businessName || 'TecnoCaja')
                  .normalize('NFD').replace(/[̀-ͯ]/g, '') // quitar acentos
                  .replace(/[^a-zA-Z0-9\-_]/g, '_')
                  .replace(/_+/g, '_')
                  .slice(0, 30);
  const ver   = String(version || '1.0.0').replace(/[^0-9.]/g, '');
  return `TecnoCaja_Backup_${safe}_${fecha}_${hora}_v${ver}.tcbak`;
}

// ─── Listar archivos .tcbak en carpeta local ─────────────────────────────────
function listLocalBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.tcbak') || f.endsWith('.novaseguro'))
    .map(f => {
      const fp    = path.join(dir, f);
      const stats = fs.statSync(fp);
      return { name: f, path: fp, size: stats.size, mtime: stats.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// ─── Construir payload completo ──────────────────────────────────────────────
async function buildFullPayload(query, options = {}) {
  if (query === _dbQuery && typeof withReadSnapshot === 'function' && !options.inSnapshot) {
    return withReadSnapshot(({ query: q }) => buildFullPayload(q, { ...options, inSnapshot: true }));
  }
  return require('./backup-builder').buildFullPayload(query, options);
}

// ─── Crear buffer .tcbak cifrado + comprimido ────────────────────────────────
const { createTcbakBuffer, parseTcbakBuffer } = require('./backup-format');

/**
 * Normaliza un valor datetime al formato que acepta MariaDB/MySQL: 'YYYY-MM-DD HH:MM:SS'.
 * Los backups almacenan fechas como ISO 8601 ('2026-05-24T21:00:40.000Z') que MariaDB rechaza.
 */
function _normalizeDbDateTime(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 19).replace('T', ' ');
  }
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (text.includes('T')) return text.slice(0, 19).replace('T', ' ');
  return text;
}

function _normalizeDateTimesInRow(row) {
  const normalized = {};
  for (const [key, val] of Object.entries(row)) {
    if (val instanceof Date) {
      normalized[key] = _normalizeDbDateTime(val);
    } else if (typeof val === 'string' && val.length >= 10 && (
      /^\d{4}-\d{2}-\d{2}[T ]/.test(val) ||
      /^\d{4}-\d{2}-\d{2}$/.test(val)
    )) {
      normalized[key] = _normalizeDbDateTime(val);
    } else {
      normalized[key] = val;
    }
  }
  return normalized;
}

// ─── Restaurar payload en la base de datos ───────────────────────────────────
async function restorePayloadToDb(payload, query, options = {}) {
  if (String(payload.formatVersion) === '3') {
    const transaction = options.withTransaction || (query === _dbQuery ? _withDbTransaction : async (work) => {
      await query('BEGIN IMMEDIATE TRANSACTION');
      try { const result = await work({ query }); await query('COMMIT'); return result; }
      catch (e) { await query('ROLLBACK'); throw e; }
    });
    return require('./backup-restore-integral').restaurar(payload, query, { ...options, withTransaction: transaction, dialect: options.dialect || getDbClient(), expectedLicenseUid: options.expectedLicenseUid ?? process.env.TECNO_CAJA_LICENSE_UID ?? '' });
  }
  const { data } = payload;
  if (!data) throw new Error('El respaldo no contiene datos.');

  const tableOrder = [
    ['config',            data.config           || []],
    ['categories',        data.categories       || []],
    ['users',             data.users            || []],
    ['products',          data.products         || []],
    ['product_combo_items', data.productComboItems || []],
    ['custom_combos',     data.customCombos     || []],
    ['clients',           data.clients          || []],
    ['suppliers',         data.suppliers        || []],
    ['payment_methods',   data.paymentMethods   || []],
    ['branches',          data.branches         || []],
    ['cash_registers',    data.cashRegisters    || []],
    ['inventory_by_branch', data.inventoryByBranch || []],
    ['cash_sessions',     data.cashSessions     || []],
    ['cash_movements',    data.cashMovements    || []],
    ['sales',             data.sales            || []],
    ['sale_items',        data.saleItems        || []],
    ['inventory_movements', data.inventoryMovements || []],
    ['branch_transfers',  data.branchTransfers  || []],
    ['branch_transfer_items', data.branchTransferItems || []],
    ['supplier_invoices', data.supplierInvoices || []],
    ['suspended_sales',   data.suspendedSales   || []],
    ['quotations',        data.quotations       || []],
    ['ncf_sequences',     data.ncfSequences     || []],
    ['pending_sales',     data.pendingSales     || []],
    ['dining_tables',     data.tables           || []],
    // Multisucursal (respaldos nuevos; los viejos no los traen y no se tocan).
    ['sync_outbox',       data.syncOutbox       || []],
    ['sync_cursors',      data.syncCursors      || []],
    ['sync_conflictos',   data.syncConflictos   || []],
    ['ncf_rangos_central', data.ncfRangosCentral || []],
  ];

  const isMySQL = getDbClient() === 'mysql';

  // Columnas que existen en ESTA base. Un respaldo hecho con una versión más
  // nueva puede traer columnas que aquí no hay; antes se armaba el INSERT con
  // todas, fallaba entero y la tabla quedaba vacía sin avisar (safeQ). Ahora
  // se omiten esas columnas y el resto de los datos entra.
  async function _columnasDestino(q, table) {
    try {
      const rows = await q(`PRAGMA table_info(${table})`, []);
      return Array.isArray(rows) ? rows.map((r) => String(r.name || r.Field || '')).filter(Boolean) : [];
    } catch (_) {
      return [];
    }
  }

  async function _doRestore(q) {
    const safeQ = async (sql, params) => {
      if (!isMySQL && /^SET FOREIGN_KEY_CHECKS/i.test(sql)) return [];
      try {
        return await q(sql, params);
      } catch (e) {
        throw new Error(`Restauración cancelada: ${e.message}`);
      }
    };

    await safeQ('SET FOREIGN_KEY_CHECKS = 0', []);
    if (!isMySQL) await q('PRAGMA defer_foreign_keys = ON');

    // La composición de los combos apunta a ids de productos: si se restauran
    // productos, la vieja se borra aunque el respaldo no traiga combos (uno de
    // antes de los combos), o quedaría apuntando a productos que ya no son.
    const restoringProducts = (data.products || []).length > 0;

    const presentes = tableOrder.filter(([table, rows]) => rows.length || Object.values(data).includes(rows) || (table === 'product_combo_items' && restoringProducts));
    for (const [table] of [...presentes].reverse()) await safeQ(`DELETE FROM \`${table}\``, []);
    for (const [table, rows] of presentes) {
      const alwaysClear = table === 'product_combo_items' && restoringProducts;
      if (!rows.length && !alwaysClear) continue;

      if (!rows.length) continue;

      const normalizedRows = rows.map(_normalizeDateTimesInRow);
      const colsRespaldo = Object.keys(normalizedRows[0]);
      const colsDestino = await _columnasDestino(q, table);
      const destinoMin = new Set(colsDestino.map((c) => c.toLowerCase()));
      const cols = colsDestino.length
        ? colsRespaldo.filter((c) => destinoMin.has(c.toLowerCase()))
        : colsRespaldo;
      const omitidas = colsRespaldo.filter((c) => !cols.includes(c));
      if (omitidas.length) {
        console.warn(`[respaldos][restore] ${table}: el respaldo trae columnas que esta versión no tiene; se omiten: ${omitidas.join(', ')}`);
      }
      if (!cols.length) throw new Error(`No hay columnas compatibles para ${table}.`);

      if (isMySQL) {
        const insert = `INSERT INTO \`${table}\` (${cols.map(c => `\`${c}\``).join(',')}) VALUES ?`;
        for (let i = 0; i < normalizedRows.length; i += 200) {
          const chunk = normalizedRows.slice(i, i + 200).map(r => cols.map(c => r[c] !== undefined ? r[c] : null));
          await safeQ(insert, [chunk]);
        }
      } else {
        const placeholders = `(${cols.map(() => '?').join(',')})`;
        const insert = `INSERT INTO \`${table}\` (${cols.map(c => `\`${c}\``).join(',')}) VALUES ${placeholders}`;
        for (const row of normalizedRows) {
          const values = cols.map(c => row[c] !== undefined ? row[c] : null);
          await safeQ(insert, values);
        }
      }
    }

    await safeQ('SET FOREIGN_KEY_CHECKS = 1', []);

    await safeQ('UPDATE `config` SET `setup_completed` = 1 WHERE `id` = 1', []);

    const cfgCheck = await safeQ('SELECT id FROM `config` WHERE id = 1 LIMIT 1');
    if (!cfgCheck || !cfgCheck.length) {
      console.warn('[respaldos][restore] config quedó vacía tras restauración; insertando fila mínima.');
      await safeQ("INSERT IGNORE INTO `config` (id, setup_completed) VALUES (1, 1)", []);
    }

    const userCheck = await safeQ('SELECT COUNT(*) AS total FROM `users`');
    const userCount = Number(userCheck?.[0]?.total || 0);
    if (userCount === 0) {
      throw new Error('El respaldo no permite recuperar usuarios. Se conserva la base anterior.');
    } else {
      console.log(`[respaldos][restore] ✅ ${userCount} usuario(s) restaurado(s) correctamente.`);
    }
  }

  let restoreResult = { userCount: 0 };
  if (options.withTransaction || query === _dbQuery) {
    await (options.withTransaction || _withDbTransaction)(async ({ query: txQ }) => {
      try { await _doRestore(txQ); }
      finally { if (isMySQL) await txQ('SET FOREIGN_KEY_CHECKS = 1'); }
      if (!isMySQL && (await txQ('PRAGMA foreign_key_check')).length) throw new Error('El respaldo contiene relaciones incompletas.');
    });
  } else {
    if (isMySQL) throw new Error('Se requiere una transacción dedicada para restaurar MariaDB.');
    await query('BEGIN IMMEDIATE TRANSACTION');
    try {
      await _doRestore(query);
      if ((await query('PRAGMA foreign_key_check')).length) throw new Error('El respaldo contiene relaciones incompletas.');
      await query('COMMIT');
    } catch (e) { await query('ROLLBACK'); throw e; }
  }

  try {
    const finalCheck = await query('SELECT COUNT(*) AS total FROM users');
    restoreResult.userCount = Number(finalCheck?.[0]?.total || 0);
  } catch (_) {}

  return restoreResult;
}

module.exports = {
  BACKUP_MAGIC,
  BACKUP_FORMAT_VERSION,
  getDefaultBackupDir,
  ensureDir,
  writeFileAtomic,
  generateFilename,
  listLocalBackups,
  buildFullPayload,
  createTcbakBuffer,
  parseTcbakBuffer,
  restorePayloadToDb,
};
