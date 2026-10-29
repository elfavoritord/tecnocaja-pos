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
const zlib   = require('zlib');
const { promisify } = require('util');

const { withTransaction: _withDbTransaction, getDbClient } = require('../../db');

const gzip   = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const BACKUP_MAGIC          = 'TECNOCAJA_BACKUP_V1';
const BACKUP_FORMAT_VERSION = '2';

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
async function buildFullPayload(query) {
  // Tablas cuyo fallo de lectura NO debe producir un respaldo "exitoso" con
  // datos vacíos. Si una de estas falla (pool cerrándose, conexión caída al
  // cerrar la app, etc.), abortamos en vez de subir/guardar un .tcbak vacío
  // que luego reemplaza respaldos buenos por rotación (pruneCloudBackups).
  const CRITICAL_TABLES = new Set(['config', 'users', 'products', 'clients']);
  const failedCritical = [];

  const safeQuery = async (sql, params = [], tableLabel = '') => {
    try { return await query(sql, params); }
    catch (e) {
      if (CRITICAL_TABLES.has(tableLabel)) failedCritical.push({ table: tableLabel, error: e.message });
      return [];
    }
  };

  const [
    config, users, categories, products, clients,
    suppliers, supplierInvoices,
    cashSessions, cashMovements,
    sales, saleItems,
    auditLogs, suspendedSales, quotations,
    ncfSequences, pendingSales,
    tables, paymentMethods, branches, cashRegisters,
    inventoryByBranch, inventoryMovements, branchTransfers, branchTransferItems,
    syncOutbox, syncCursors, syncConflictos, ncfRangosCentral,
    productComboItems,
  ] = await Promise.all([
    safeQuery('SELECT * FROM config', [], 'config'),
    safeQuery('SELECT * FROM users', [], 'users'),
    safeQuery('SELECT * FROM categories'),
    safeQuery('SELECT * FROM products', [], 'products'),
    safeQuery('SELECT * FROM clients', [], 'clients'),
    safeQuery('SELECT * FROM suppliers LIMIT 5000'),
    safeQuery('SELECT * FROM supplier_invoices LIMIT 10000'),
    safeQuery('SELECT * FROM cash_sessions LIMIT 3000'),
    safeQuery('SELECT * FROM cash_movements LIMIT 50000'),
    safeQuery('SELECT * FROM sales LIMIT 200000'),
    safeQuery('SELECT * FROM sale_items LIMIT 500000'),
    safeQuery('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 5000'),
    safeQuery('SELECT * FROM suspended_sales LIMIT 1000'),
    safeQuery('SELECT * FROM quotations LIMIT 3000'),
    safeQuery('SELECT * FROM ncf_sequences LIMIT 1000'),
    safeQuery('SELECT * FROM pending_sales LIMIT 2000'),
    safeQuery('SELECT * FROM dining_tables LIMIT 500'),
    safeQuery('SELECT * FROM payment_methods'),
    safeQuery('SELECT * FROM branches'),
    safeQuery('SELECT * FROM cash_registers'),
    safeQuery('SELECT * FROM inventory_by_branch LIMIT 200000'),
    safeQuery('SELECT * FROM inventory_movements LIMIT 500000'),
    safeQuery('SELECT * FROM branch_transfers LIMIT 50000'),
    safeQuery('SELECT * FROM branch_transfer_items LIMIT 200000'),
    // Multisucursal: lo que todavía no confirmó la central, por dónde va cada
    // descarga, lo que espera "Vincular" y los rangos NCF que asignó la central.
    safeQuery("SELECT * FROM sync_outbox WHERE status <> 'sincronizado' LIMIT 200000"),
    safeQuery('SELECT * FROM sync_cursors'),
    safeQuery("SELECT * FROM sync_conflictos WHERE estado = 'pendiente' LIMIT 50000"),
    safeQuery('SELECT * FROM ncf_rangos_central'),
    // Combos promocionales: qué productos lleva cada combo.
    safeQuery('SELECT * FROM product_combo_items'),
  ]);

  if (failedCritical.length) {
    const detail = failedCritical.map(f => `${f.table}: ${f.error}`).join(' | ');
    throw new Error(`Respaldo abortado — no se pudieron leer tablas críticas (${detail}). No se guardó ningún archivo para evitar un respaldo vacío.`);
  }

  // Config como mapa para metadatos
  const cfgMap = {};
  (config || []).forEach(r => {
    const k = r.clave || r.config_key || '';
    const v = r.valor || r.config_value || r.value || '';
    if (k) cfgMap[k] = v;
    // columnas directas del row (tabla config tiene columnas planas)
    Object.keys(r).forEach(col => { if (!cfgMap[col]) cfgMap[col] = r[col]; });
  });

  const businessName = cfgMap.business_name || cfgMap.nombre_negocio || cfgMap.businessName || 'TecnoCaja';
  const businessId   = cfgMap.business_id   || cfgMap.businessId    || '';
  const rnc          = cfgMap.rnc            || '';
  const sysVersion   = process.env.npm_package_version || '1.0.0';

  return {
    magic:          BACKUP_MAGIC,
    formatVersion:  BACKUP_FORMAT_VERSION,
    exportedAt:     new Date().toISOString(),
    timezone:       'America/Santo_Domingo',
    businessName,
    businessId,
    rnc,
    systemVersion:  sysVersion,
    stats: {
      productos:   (products    || []).length,
      clientes:    (clients     || []).length,
      ventas:      (sales       || []).length,
      usuarios:    (users       || []).length,
      categorias:  (categories  || []).length,
      facturas:    (saleItems   || []).length,
      proveedores: (suppliers   || []).length,
      inventario:  (inventoryByBranch || []).length,
      movimientosInventario: (inventoryMovements || []).length,
    },
    data: {
      config, users, categories, products, clients,
      suppliers, supplierInvoices,
      cashSessions, cashMovements,
      sales, saleItems,
      auditLogs, suspendedSales, quotations,
      ncfSequences, pendingSales,
      tables, paymentMethods, branches, cashRegisters,
      inventoryByBranch, inventoryMovements, branchTransfers, branchTransferItems,
      syncOutbox, syncCursors, syncConflictos, ncfRangosCentral,
      productComboItems,
    },
  };
}

// ─── Crear buffer .tcbak cifrado + comprimido ────────────────────────────────
async function createTcbakBuffer(payload, password) {
  const payloadJson = JSON.stringify(payload);
  const sha256      = crypto.createHash('sha256').update(payloadJson, 'utf8').digest('hex');

  const compressed  = await gzip(Buffer.from(payloadJson, 'utf8'));
  const { encryptBackupPayload } = require('../security/backup-crypto');
  const encContent  = encryptBackupPayload(compressed.toString('base64'), password);

  const tcbak = {
    magic:         BACKUP_MAGIC,
    formatVersion: BACKUP_FORMAT_VERSION,
    sha256,
    createdAt:     payload.exportedAt,
    metadata: {
      businessName:  payload.businessName,
      businessId:    payload.businessId,
      rnc:           payload.rnc,
      systemVersion: payload.systemVersion,
      stats:         payload.stats,
    },
    encrypted: encContent,
  };

  return Buffer.from(JSON.stringify(tcbak), 'utf8');
}

// ─── Parsear y descifrar .tcbak ──────────────────────────────────────────────
async function parseTcbakBuffer(fileBuffer, password) {
  let tcbak;
  try {
    tcbak = JSON.parse(fileBuffer.toString('utf8'));
  } catch (_) {
    throw new Error('El archivo no es un respaldo válido de Tecno Caja (formato inválido).');
  }

  if (tcbak.magic !== BACKUP_MAGIC) {
    throw new Error('Este archivo no es un respaldo de Tecno Caja.');
  }

  const { decryptBackupPayload } = require('../security/backup-crypto');
  let decryptedBase64;
  try {
    decryptedBase64 = decryptBackupPayload(tcbak.encrypted, password);
  } catch (_) {
    throw new Error('Contraseña incorrecta o archivo corrupto. No se pudo descifrar el respaldo.');
  }

  let payloadJson;
  try {
    const compressed = Buffer.from(decryptedBase64, 'base64');
    const decompressed = await gunzip(compressed);
    payloadJson = decompressed.toString('utf8');
  } catch (_) {
    throw new Error('Error al descomprimir el respaldo. El archivo puede estar dañado.');
  }

  const sha256Actual = crypto.createHash('sha256').update(payloadJson, 'utf8').digest('hex');
  if (sha256Actual !== tcbak.sha256) {
    throw new Error('El respaldo está corrupto o fue modificado (SHA-256 no coincide). Restauración cancelada.');
  }

  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch (_) {
    throw new Error('Error al procesar el contenido del respaldo.');
  }

  return { payload, metadata: tcbak.metadata, sha256: tcbak.sha256 };
}

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
async function restorePayloadToDb(payload, query) {
  const { data } = payload;
  if (!data) throw new Error('El respaldo no contiene datos.');

  const tableOrder = [
    ['config',            data.config           || []],
    ['categories',        data.categories       || []],
    ['users',             data.users            || []],
    ['products',          data.products         || []],
    ['product_combo_items', data.productComboItems || []],
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
      try {
        return await q(sql, params);
      } catch (e) {
        console.warn(`[respaldos][restore] query omitida: ${String(sql).slice(0, 80)} — ${e.message}`);
      }
    };

    await safeQ('SET FOREIGN_KEY_CHECKS = 0', []);

    // La composición de los combos apunta a ids de productos: si se restauran
    // productos, la vieja se borra aunque el respaldo no traiga combos (uno de
    // antes de los combos), o quedaría apuntando a productos que ya no son.
    const restoringProducts = (data.products || []).length > 0;

    for (const [table, rows] of tableOrder) {
      const alwaysClear = table === 'product_combo_items' && restoringProducts;
      if (!rows.length && !alwaysClear) continue;

      await safeQ(`DELETE FROM \`${table}\``, []);
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
      if (!cols.length) continue;

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
      console.warn('[respaldos][restore] ¡ADVERTENCIA! La tabla users quedó vacía tras restauración.');
      await safeQ('UPDATE `config` SET `setup_completed` = 0 WHERE `id` = 1', []);
      console.warn('[respaldos][restore] setup_completed → 0 para evitar estado "corrompido". El usuario verá el wizard inicial.');
    } else {
      console.log(`[respaldos][restore] ✅ ${userCount} usuario(s) restaurado(s) correctamente.`);
    }
  }

  let restoreResult = { userCount: 0 };
  if (isMySQL) {
    await _withDbTransaction(async ({ query: txQ }) => {
      await _doRestore(txQ);
    });
  } else {
    await _doRestore(query);
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
