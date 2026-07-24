/**
 * db-local.js
 *
 * Base de datos SQLite LOCAL siempre disponible en el disco del equipo.
 * Se usa para almacenar datos offline: caché de productos/clientes/usuarios
 * y ventas pendientes de sincronización.
 *
 * En modo standalone (DB_CLIENT=sqlite), usa la misma BD que el sistema.
 * En modo multicaja (DB_CLIENT=mysql), usa un SQLite separado local para
 * que los datos offline persistan aunque MySQL no esté disponible.
 */

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const { prepareRuntimeEnvironment } = require('./scripts/runtime-bootstrap');
const { getDbClient, query: mainQuery } = require('./db');

const runtime = prepareRuntimeEnvironment({
  appRoot: __dirname,
  userDataPath: process.env.TECNO_CAJA_USER_DATA || ''
});

// Archivo SQLite local para datos offline (solo se usa en modo mysql)
const LOCAL_OFFLINE_DB_FILE = path.join(
  path.dirname(runtime.dbFile),
  'tecnocaja-offline-local.db'
);

let _localDb = null;
let _localDbPromise = null;

const LOCAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS offline_terminal_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal_id VARCHAR(40) NOT NULL UNIQUE,
  principal_host VARCHAR(255) NOT NULL DEFAULT '',
  principal_base_url VARCHAR(255) NOT NULL DEFAULT '',
  branch_id INTEGER DEFAULT NULL,
  cash_register_id INTEGER DEFAULT NULL,
  is_online INTEGER NOT NULL DEFAULT 0,
  sync_status VARCHAR(20) NOT NULL DEFAULT 'offline',
  last_full_sync DATETIME DEFAULT NULL,
  last_health_check DATETIME DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS offline_cache_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL UNIQUE,
  codigo VARCHAR(60) NOT NULL,
  nombre VARCHAR(255) NOT NULL,
  categoria VARCHAR(100) DEFAULT NULL,
  precio_venta DECIMAL(12,2) NOT NULL DEFAULT 0,
  stock_cached DECIMAL(12,3) NOT NULL DEFAULT 0,
  stock_min DECIMAL(12,3) NOT NULL DEFAULT 0,
  estado VARCHAR(20) NOT NULL DEFAULT 'Activo',
  last_updated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS offline_cache_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL UNIQUE,
  nombre VARCHAR(255) NOT NULL,
  cedula VARCHAR(30) DEFAULT NULL,
  telefono VARCHAR(30) DEFAULT NULL,
  email VARCHAR(120) DEFAULT NULL,
  direccion VARCHAR(255) DEFAULT NULL,
  limite_credito DECIMAL(12,2) NOT NULL DEFAULT 0,
  balance DECIMAL(12,2) NOT NULL DEFAULT 0,
  last_updated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS offline_cache_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  usuario VARCHAR(60) NOT NULL,
  nombre VARCHAR(120) NOT NULL,
  rol VARCHAR(40) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  puede_vender INTEGER NOT NULL DEFAULT 1,
  puede_cobrar INTEGER NOT NULL DEFAULT 1,
  puede_ver_reportes INTEGER NOT NULL DEFAULT 1,
  last_updated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS offline_cache_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_key VARCHAR(80) NOT NULL UNIQUE,
  config_value TEXT DEFAULT NULL,
  last_updated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS offline_cache_payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_method_id INTEGER NOT NULL UNIQUE,
  codigo VARCHAR(40) NOT NULL,
  nombre VARCHAR(120) NOT NULL,
  last_updated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 📢 Centro de Promociones — solo lectura offline (ver server/routes/promotions.routes.js)
CREATE TABLE IF NOT EXISTS offline_cache_promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL UNIQUE,
  promotion_id INTEGER NOT NULL,
  nombre VARCHAR(255) NOT NULL,
  precio_promocion DECIMAL(12,2) NOT NULL,
  precio_original DECIMAL(12,2) NOT NULL,
  texto_promocion VARCHAR(80) DEFAULT NULL,
  color VARCHAR(7) DEFAULT NULL,
  last_updated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Espejo de offline_cache_promotions para "descuento_por_cantidad" (precio
-- especial por unidad condicionado a una cantidad mínima en el carrito).
CREATE TABLE IF NOT EXISTS offline_cache_quantity_promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL UNIQUE,
  promotion_id INTEGER NOT NULL,
  nombre VARCHAR(255) NOT NULL,
  precio_promocion DECIMAL(12,2) NOT NULL,
  precio_original DECIMAL(12,2) NOT NULL,
  cantidad_minima INTEGER NOT NULL,
  texto_promocion VARCHAR(80) DEFAULT NULL,
  color VARCHAR(7) DEFAULT NULL,
  last_updated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pending_sales (
  id VARCHAR(80) PRIMARY KEY,
  terminal_id VARCHAR(40) NOT NULL,
  offline_invoice_id VARCHAR(80) NOT NULL UNIQUE,
  branch_id INTEGER NOT NULL,
  cash_register_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  client_id INTEGER DEFAULT NULL,
  sale_data TEXT NOT NULL,
  total REAL NOT NULL DEFAULT 0,
  payment_method VARCHAR(30) DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  error_message VARCHAR(500) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synced_at DATETIME DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS pending_sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pending_sale_id VARCHAR(80) NOT NULL,
  item_sequence INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  item_data TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pending_sale_id) REFERENCES pending_sales(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pending_cash_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal_id VARCHAR(40) NOT NULL,
  movement_type VARCHAR(40) NOT NULL,
  amount REAL NOT NULL,
  notes VARCHAR(255) DEFAULT NULL,
  reference_sale_id VARCHAR(80) DEFAULT NULL,
  reference_client_id INTEGER DEFAULT NULL,
  reference_payment_id VARCHAR(80) DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  error_message VARCHAR(500) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synced_at DATETIME DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal_id VARCHAR(40) NOT NULL,
  sync_phase VARCHAR(30) NOT NULL,
  items_uploaded INTEGER NOT NULL DEFAULT 0,
  items_downloaded INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  started_at DATETIME NOT NULL,
  completed_at DATETIME DEFAULT NULL,
  result VARCHAR(20) NOT NULL DEFAULT 'pending',
  error_detail VARCHAR(500) DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS offline_sync_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offline_id VARCHAR(80) NOT NULL UNIQUE,
  real_invoice_id VARCHAR(40) DEFAULT NULL,
  terminal_id VARCHAR(40) NOT NULL,
  branch_id INTEGER NOT NULL,
  cash_register_id INTEGER NOT NULL,
  synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Caché local de proveedores (modo offline, Fase 1 de la extensión offline)
CREATE TABLE IF NOT EXISTS offline_cache_suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL UNIQUE,
  nombre VARCHAR(160) NOT NULL,
  data_json TEXT NOT NULL,
  updated_at DATETIME DEFAULT NULL,
  last_cached DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Cambios a proveedores hechos offline, en espera de sincronizar
CREATE TABLE IF NOT EXISTS pending_supplier_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal_id VARCHAR(40) NOT NULL,
  change_type VARCHAR(20) NOT NULL,
  supplier_id INTEGER DEFAULT NULL,
  offline_ref VARCHAR(80) NOT NULL UNIQUE,
  base_updated_at DATETIME DEFAULT NULL,
  payload_json TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  error_message VARCHAR(500) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synced_at DATETIME DEFAULT NULL
);

-- Caché local de inventario por sucursal (Fase 2 de la extensión offline).
-- Acotado a la sucursal de esta terminal — solo se usa para detectar
-- conflictos y mostrar "stock al último sync" en el ajuste offline.
CREATE TABLE IF NOT EXISTS offline_cache_inventory_by_branch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  stock DECIMAL(12,2) NOT NULL DEFAULT 0,
  stock_min DECIMAL(12,2) NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT NULL,
  last_cached DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(branch_id, product_id)
);

-- Ajustes de stock (entrada/salida/ajuste) hechos offline, pendientes de sincronizar
CREATE TABLE IF NOT EXISTS pending_inventory_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal_id VARCHAR(40) NOT NULL,
  offline_ref VARCHAR(80) NOT NULL UNIQUE,
  product_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  tipo VARCHAR(20) NOT NULL,
  qty DECIMAL(12,3) NOT NULL,
  notes VARCHAR(255) DEFAULT NULL,
  base_updated_at DATETIME DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  error_message VARCHAR(500) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synced_at DATETIME DEFAULT NULL
);

-- Caché de solo lectura del log de auditoría (Fase 4 de la extensión offline).
-- id refleja el id real de audit_logs (no autoincrement local) para que el
-- upsert sea estable entre sincronizaciones repetidas.
CREATE TABLE IF NOT EXISTS offline_cache_audit_logs (
  id INTEGER PRIMARY KEY,
  user_name VARCHAR(120) NOT NULL,
  user_role VARCHAR(40) NOT NULL,
  module_name VARCHAR(60) NOT NULL,
  action_name VARCHAR(120) NOT NULL,
  detail TEXT,
  created_at DATETIME NOT NULL,
  last_cached DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

// CREATE TABLE IF NOT EXISTS no agrega columnas nuevas a una BD local que ya
// existía en disco de una versión anterior — a diferencia de la BD principal
// (que tiene addColumnIfMissing en server.js), este archivo SQLite no pasa por
// ningún runner de migraciones, así que necesita su propio guard idempotente.
function _addLocalColumnIfMissing(db, table, column, definition) {
  try {
    const info = db.exec(`PRAGMA table_info(${table})`);
    const columns = info?.[0]?.values?.map((row) => row[1]) || [];
    if (columns.includes(column)) return;
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    console.error(`[db-local] Error agregando columna ${column} a ${table}:`, err.message);
  }
}

async function _initLocalDb() {
  const SQL = await initSqlJs();
  const fileExists = fs.existsSync(LOCAL_OFFLINE_DB_FILE);
  const buffer = fileExists ? fs.readFileSync(LOCAL_OFFLINE_DB_FILE) : undefined;
  const db = new SQL.Database(buffer);
  // Ejecutar el esquema (CREATE TABLE IF NOT EXISTS es idempotente)
  db.run(LOCAL_SCHEMA);

  // Fase 3 de la extensión offline: pending_cash_movements ya existía para
  // movimientos ligados a ventas; se le agregan columnas para soportar
  // movimientos de caja standalone (retiro/gasto/ingreso sin venta asociada).
  _addLocalColumnIfMissing(db, 'pending_cash_movements', 'expense_type', 'VARCHAR(30) DEFAULT NULL');
  _addLocalColumnIfMissing(db, 'pending_cash_movements', 'supplier_invoice_id', 'INTEGER DEFAULT NULL');
  _addLocalColumnIfMissing(db, 'pending_cash_movements', 'branch_id', 'INTEGER DEFAULT NULL');
  _addLocalColumnIfMissing(db, 'pending_cash_movements', 'cash_register_id', 'INTEGER DEFAULT NULL');

  _saveLocalDb(db);
  return db;
}

function _saveLocalDb(db) {
  try {
    const data = db.export();
    fs.mkdirSync(path.dirname(LOCAL_OFFLINE_DB_FILE), { recursive: true });
    fs.writeFileSync(LOCAL_OFFLINE_DB_FILE, Buffer.from(data));
  } catch (err) {
    console.error('[db-local] Error guardando BD local:', err.message);
  }
}

function _getLocalDbPromise() {
  if (!_localDbPromise) {
    _localDbPromise = _initLocalDb().then(db => {
      _localDb = db;
      return db;
    });
  }
  return _localDbPromise;
}

async function _runLocalQuery(sql, params = []) {
  const db = await _getLocalDbPromise();
  const trimmed = String(sql || '').trim();
  const isSelect = /^(SELECT|PRAGMA|WITH)/i.test(trimmed);

  const stmt = db.prepare(sql);
  stmt.bind(params.map(p => p === undefined ? null : p));

  if (isSelect) {
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  stmt.run();
  stmt.free();
  const rowsAffected = Number(db.getRowsModified?.() || 0);
  _saveLocalDb(db);

  const seqResult = db.exec('SELECT last_insert_rowid() AS id;');
  const insertId = seqResult?.[0]?.values?.[0]?.[0] || 0;
  return { insertId, rowsAffected, affectedRows: rowsAffected };
}

/**
 * Ejecuta una query en la BD local offline.
 *
 * En modo sqlite (standalone), usa la BD principal para evitar duplicar datos.
 * En modo mysql (multicaja), usa el SQLite local separado.
 */
async function localQuery(sql, params = []) {
  if (getDbClient() === 'sqlite') {
    return mainQuery(sql, params);
  }
  return _runLocalQuery(sql, params);
}

/**
 * Genera un ID único para venta offline.
 * Formato: {terminalId}#{secuencial}#{timestamp}
 */
async function generateOfflineInvoiceId(terminalId) {
  try {
    const lastResult = await localQuery(
      `SELECT offline_invoice_id FROM pending_sales WHERE terminal_id = ? ORDER BY created_at DESC LIMIT 1`,
      [terminalId]
    );

    let seq = 1;
    if (Array.isArray(lastResult) && lastResult.length > 0) {
      const lastId = lastResult[0]?.offline_invoice_id || '';
      const parts = lastId.split('#');
      if (parts.length >= 2) {
        const lastSeq = parseInt(parts[1], 10);
        if (!isNaN(lastSeq)) seq = lastSeq + 1;
      }
    }

    return `${terminalId}#${seq}#${Date.now()}`;
  } catch (err) {
    console.error('[db-local] Error generando ID offline:', err.message);
    return `${terminalId}#1#${Date.now()}`;
  }
}

/**
 * Genera una referencia única para una cola offline genérica (proveedores,
 * ajustes de inventario, movimientos de caja standalone). A diferencia de
 * generateOfflineInvoiceId, no necesita ser secuencial/legible para el
 * usuario — solo única — así que combina timestamp + aleatorio en vez de
 * consultar la última fila (evita acoplar este helper a una tabla concreta).
 * Formato: {prefix}{terminalId}#{timestamp}#{random}
 */
function generateOfflineRef(terminalId, prefix) {
  const rand = Math.floor(Math.random() * 100000);
  return `${prefix}${terminalId}#${Date.now()}#${rand}`;
}

/**
 * Registra evento de sync en el log local.
 */
async function logLocalSyncEvent(terminalId, phase, uploaded = 0, downloaded = 0, result = 'ok', errorDetail = null) {
  try {
    await localQuery(
      `INSERT INTO sync_log (terminal_id, sync_phase, items_uploaded, items_downloaded, error_count, started_at, completed_at, result, error_detail)
       VALUES (?, ?, ?, ?, 0, datetime('now'), datetime('now'), ?, ?)`,
      [terminalId, phase, uploaded, downloaded, result, errorDetail]
    );
  } catch (err) {
    console.error('[db-local] Error en sync log:', err.message);
  }
}

/**
 * Obtiene el estado actual del caché local.
 */
async function getLocalCacheStatus(terminalId) {
  try {
    const terminal = await localQuery(
      'SELECT * FROM offline_terminal_cache WHERE terminal_id = ? LIMIT 1',
      [terminalId]
    );

    const products = await localQuery('SELECT COUNT(*) as cnt FROM offline_cache_products');
    const clients = await localQuery('SELECT COUNT(*) as cnt FROM offline_cache_clients');
    const users = await localQuery('SELECT COUNT(*) as cnt FROM offline_cache_users');
    const pending = await localQuery(
      `SELECT COUNT(*) as cnt, SUM(total) as total_amount FROM pending_sales WHERE status IN ('pending', 'syncing')`
    );

    const tc = Array.isArray(terminal) && terminal[0] ? terminal[0] : {};

    return {
      initialized: Array.isArray(terminal) && terminal.length > 0,
      isOnline: Boolean(tc.is_online),
      syncStatus: tc.sync_status || 'unknown',
      lastFullSync: tc.last_full_sync || null,
      productsCached: Number(products[0]?.cnt || 0),
      clientsCached: Number(clients[0]?.cnt || 0),
      usersCached: Number(users[0]?.cnt || 0),
      pendingSalesCount: Number(pending[0]?.cnt || 0),
      pendingSalesTotalAmount: Number(pending[0]?.total_amount || 0)
    };
  } catch (err) {
    console.error('[db-local] Error obteniendo estado:', err.message);
    return { error: err.message, pendingSalesCount: 0, pendingSalesTotalAmount: 0 };
  }
}

module.exports = {
  localQuery,
  generateOfflineInvoiceId,
  generateOfflineRef,
  logLocalSyncEvent,
  getLocalCacheStatus,
  LOCAL_OFFLINE_DB_FILE
};
