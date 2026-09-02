'use strict';

/**
 * sqlite-to-mysql-migrator.js — núcleo reutilizable de la migración SQLite → MySQL.
 *
 * Lo usan:
 *   - scripts/migrate-sqlite-to-mysql.js  (CLI, soporte remoto manual)
 *   - electron/main.js                    (migración automática en el arranque tras
 *                                          activar multicaja/multisucursal en una
 *                                          instalación que ya tenía datos)
 *
 * `runMigration()` NO llama process.exit ni imprime con colores — devuelve un
 * objeto estructurado y acepta un logger y un callback de progreso inyectados.
 *
 * El .db real de una instalación de escritorio está cifrado en reposo
 * (server/security/local-machine-crypto.js) con una llave atada al hardware, por
 * eso esto sólo funciona corrido en la MISMA PC donde vive el archivo.
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');

// -- Tablas a migrar (orden respeta FK) -------------------------------------------
const TABLES_TO_MIGRATE = [
  'businesses',
  'roles',
  'branches',
  // Secuencias fiscales — NO están en db/schema.sql (el POS las crea en runtime
  // vía ensureNcfExtensions / fiscal-sequences.routes.js). Van aquí, después de
  // branches (ncf_authorized_sequences.branch_id referencia branches) y el audit
  // después de su tabla padre. ensureRuntimeTables() las crea en la MySQL destino
  // antes de migrar; sin eso se saltaban en silencio y la primera venta fiscal
  // fallaba con "No hay secuencia configurada".
  'ncf_sequences',
  'ncf_authorized_sequences',
  'ncf_authorized_sequence_audit',
  'cash_registers',
  'config',
  'users',
  'payment_methods',
  'categories',
  'products',
  'clients',
  'suppliers',
  'supplier_invoices',
  'inventory_by_branch',
  'cash_sessions',
  'cash_movements',
  'cash_openings',
  'cash_closings',
  'sales',
  'sale_items',
  'inventory_movements',
  'branch_transfers',
  'branch_transfer_items',
  'audit_logs',
  'mobile_sessions',
  'mobile_session_items',
  'dining_tables',
  'delivery_locations',
  'suspended_sales',
  'quotations',
];

// Tablas que NO se migran (caché offline, cola de sync — datos efímeros)
const TABLES_TO_SKIP = new Set([
  'offline_terminal_cache',
  'offline_cache_sales',
  'offline_cache_sale_items',
  'offline_cache_products',
  'offline_cache_clients',
  'offline_cache_users',
  'offline_cache_config',
  'offline_cache_payment_methods',
  'pending_sales',
  'pending_sale_items',
  'pending_cash_movements',
  'pending_sync',
  'sync_log',
  'offline_sync_map',
]);

const BATCH_SIZE = 200;

const NOOP_LOGGER = { info() {}, ok() {}, warn() {}, error() {} };

function normalizeLogger(log) {
  if (!log) return NOOP_LOGGER;
  return {
    info: typeof log.info === 'function' ? log.info.bind(log) : NOOP_LOGGER.info,
    ok: typeof log.ok === 'function' ? log.ok.bind(log) : (log.info ? log.info.bind(log) : NOOP_LOGGER.ok),
    warn: typeof log.warn === 'function' ? log.warn.bind(log) : NOOP_LOGGER.warn,
    error: typeof log.error === 'function' ? log.error.bind(log) : NOOP_LOGGER.error,
  };
}

// -- Buscar el archivo SQLite ---------------------------------------------------
function findSqliteFile(customPath) {
  if (customPath) {
    if (fs.existsSync(customPath)) return customPath;
    throw new Error('Archivo SQLite no encontrado en: ' + customPath);
  }

  const candidates = [
    process.env.SQLITE_PATH,
    process.env.DB_PATH,
    process.env.DB_FILE,
    path.join(__dirname, '..', '..', 'tecnocaja.db'),
    path.join(__dirname, '..', '..', 'database.db'),
    path.join(__dirname, '..', '..', 'pos.db'),
    // Ruta real de una instalación de escritorio (runtime-bootstrap.js
    // resolveRuntimePaths): userData/data/tecnocaja.db, bajo cualquiera de los
    // dos nombres de carpeta que existen en instalaciones reales — el rebrand a
    // "Tecno Caja" y el legado "pos-system".
    path.join(os.homedir(), 'AppData', 'Roaming', 'Tecno Caja', 'data', 'tecnocaja.db'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'pos-system', 'data', 'tecnocaja.db'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Tecno Caja', 'tecnocaja.db'),
    path.join(os.homedir(), 'AppData', 'Local',   'Tecno Caja', 'tecnocaja.db'),
    path.join(os.homedir(), '.tecnocaja', 'tecnocaja.db'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'tecnocaja-desktop', 'tecnocaja.db'),
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  throw new Error(
    'No se encontró el archivo SQLite. Pasa la ruta explícita.\n' +
    'Rutas buscadas:\n  ' + candidates.join('\n  ')
  );
}

// -- Cargar SQLite con sql.js (descifrando en reposo si hace falta) ------------
async function loadSqlite(filePath, options = {}) {
  const log = normalizeLogger(options.log);
  log.info('Cargando SQLite desde: ' + filePath);

  let initSqlJs;
  try {
    initSqlJs = require('sql.js');
  } catch (_) {
    throw new Error('Módulo sql.js no encontrado. Ejecuta: npm install sql.js');
  }

  let decryptSqliteBuffer;
  try {
    ({ decryptSqliteBuffer } = require('../../server/security/local-machine-crypto'));
  } catch (_) {
    decryptSqliteBuffer = (buffer) => buffer;
  }

  const SQL = await initSqlJs();
  const raw = fs.readFileSync(filePath);
  const buf = decryptSqliteBuffer(raw);
  const db  = new SQL.Database(buf);
  log.ok('SQLite cargado (' + (buf.length / 1024).toFixed(1) + ' KB)' + (raw !== buf ? ' [descifrado]' : ''));
  return db;
}

// -- Conectar a MySQL ---------------------------------------------------------
async function connectMySQL(mysqlConfig = {}, options = {}) {
  const log = normalizeLogger(options.log);
  let mysql;
  try {
    mysql = require('mysql2/promise');
  } catch (_) {
    throw new Error('Módulo mysql2 no encontrado. Ejecuta: npm install mysql2');
  }

  const cfg = {
    host:               mysqlConfig.host     || process.env.DB_HOST || '127.0.0.1',
    // 3306 = puerto de MariaDB. NO 3399 (ese es el del backend Express).
    port:               parseInt(mysqlConfig.port || process.env.DB_PORT || '3306', 10),
    user:               mysqlConfig.user     || process.env.DB_USER || 'root',
    password:           mysqlConfig.password != null ? mysqlConfig.password : (process.env.DB_PASSWORD || ''),
    database:           mysqlConfig.database || process.env.DB_NAME || 'tecnocaja',
    multipleStatements: true,
    connectTimeout:     10000,
  };

  log.info('Conectando a MySQL ' + cfg.host + ':' + cfg.port + ' / ' + cfg.database + ' ...');

  try {
    const conn = await mysql.createConnection(cfg);
    log.ok('Conexión MySQL establecida');
    return { conn, cfg };
  } catch (err) {
    throw new Error(
      'No se pudo conectar a MySQL: ' + err.message + '\n' +
      'Verifica que MariaDB está corriendo y que las credenciales son correctas.\n' +
      '  DB_HOST=' + cfg.host + '  DB_PORT=' + cfg.port + '  DB_USER=' + cfg.user + '  DB_NAME=' + cfg.database
    );
  }
}

// -- Aplicar schema (sin DROP TABLE) ------------------------------------------
async function applySchema(mysqlConn, options = {}) {
  const log = normalizeLogger(options.log);
  const schemaPath = path.join(__dirname, '..', '..', 'db', 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    log.warn('db/schema.sql no encontrado — se omite creación de tablas.');
    return;
  }

  log.info('Aplicando schema (CREATE TABLE IF NOT EXISTS) ...');
  let sql = fs.readFileSync(schemaPath, 'utf8');
  sql = sql.replace(/DROP\s+TABLE\s+(IF\s+EXISTS\s+)?[^;]+;/gi, '-- DROP eliminado por el migrador --');
  sql = sql.replace(/CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\s)/gi, 'CREATE TABLE IF NOT EXISTS ');
  await mysqlConn.query(sql);
  log.ok('Schema aplicado');
}

// -- Crear tablas que el POS genera en runtime (no en db/schema.sql) ----------
// Ver comentario extenso en la versión previa: sin esto, si la MySQL destino no
// fue tocada por el POS todavía, las secuencias fiscales se saltaban en silencio.
// Se crean sin FOREIGN KEY a propósito (evita abortar por desajuste de
// engine/charset con branches; el POS no depende de esas FK para operar).
async function ensureRuntimeTables(mysqlConn, options = {}) {
  const log = normalizeLogger(options.log);
  const ddls = [
    `CREATE TABLE IF NOT EXISTS ncf_sequences (
       id INT AUTO_INCREMENT PRIMARY KEY,
       business_id INT NOT NULL DEFAULT 1,
       branch_id INT DEFAULT NULL,
       ncf_type VARCHAR(5) NOT NULL,
       siguiente_numero INT NOT NULL DEFAULT 1,
       maximo INT NOT NULL DEFAULT 99999999,
       activa TINYINT(1) NOT NULL DEFAULT 1,
       fecha_vencimiento DATE DEFAULT NULL,
       created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE TABLE IF NOT EXISTS ncf_authorized_sequences (
       id INT AUTO_INCREMENT PRIMARY KEY,
       business_id INT NOT NULL DEFAULT 1,
       branch_id INT DEFAULT NULL,
       series VARCHAR(1) NOT NULL DEFAULT 'B',
       document_type VARCHAR(5) NOT NULL,
       document_name VARCHAR(80) DEFAULT NULL,
       prefix VARCHAR(5) NOT NULL,
       start_number INT NOT NULL,
       end_number INT NOT NULL,
       next_number INT NOT NULL,
       last_used_number INT DEFAULT NULL,
       authorization_date DATE DEFAULT NULL,
       expiration_date DATE DEFAULT NULL,
       authorization_reference VARCHAR(60) DEFAULT NULL,
       environment VARCHAR(10) NOT NULL DEFAULT 'ncf',
       status VARCHAR(20) NOT NULL DEFAULT 'pendiente',
       authorization_file_url VARCHAR(255) DEFAULT NULL,
       notes TEXT DEFAULT NULL,
       created_by INT DEFAULT NULL,
       updated_by INT DEFAULT NULL,
       created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       deleted_at DATETIME DEFAULT NULL,
       deleted_by INT DEFAULT NULL,
       deletion_reason VARCHAR(255) DEFAULT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS ncf_authorized_sequence_audit (
       id INT AUTO_INCREMENT PRIMARY KEY,
       ncf_authorized_sequence_id INT NOT NULL,
       action VARCHAR(30) NOT NULL,
       reason VARCHAR(255) DEFAULT NULL,
       user_id INT DEFAULT NULL,
       user_name VARCHAR(120) DEFAULT NULL,
       ip_address VARCHAR(45) DEFAULT NULL,
       device_info VARCHAR(255) DEFAULT NULL,
       data_before TEXT DEFAULT NULL,
       data_after TEXT DEFAULT NULL,
       created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  ];

  let created = 0;
  for (const ddl of ddls) {
    try {
      await mysqlConn.query(ddl);
      created += 1;
    } catch (err) {
      log.warn('No se pudo asegurar tabla runtime: ' + err.message);
    }
  }
  log.ok('Tablas de runtime aseguradas (' + created + '/' + ddls.length + ')');
}

// -- Introspección ----------------------------------------------------------------
function getSqliteColumns(sqliteDb, table) {
  try {
    const res = sqliteDb.exec('PRAGMA table_info(' + table + ')');
    if (!res.length || !res[0].values.length) return [];
    return res[0].values.map((row) => row[1]); // index 1 = name
  } catch (_) {
    return [];
  }
}

async function getMysqlColumns(mysqlConn, table, dbName) {
  try {
    const [rows] = await mysqlConn.query(
      'SELECT COLUMN_NAME FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [dbName, table]
    );
    return rows.map((r) => r.COLUMN_NAME);
  } catch (_) {
    return [];
  }
}

function countSqliteRows(sqliteDb, table) {
  try {
    const res = sqliteDb.exec('SELECT COUNT(*) FROM `' + table + '`');
    return res.length ? Number(res[0].values[0][0]) : 0;
  } catch (_) {
    return 0;
  }
}

function discoverSqliteTables(sqliteDb) {
  const result = sqliteDb.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  );
  if (!result.length) return [];
  return result[0].values.map((r) => r[0]);
}

// -- Migrar una tabla ---------------------------------------------------------
async function migrateTable(sqliteDb, mysqlConn, table, dbName, opts = {}) {
  const log = normalizeLogger(opts.log);
  const dryRun = Boolean(opts.dryRun);

  const sqliteCols = getSqliteColumns(sqliteDb, table);
  if (!sqliteCols.length) {
    return { table, status: 'skipped', reason: 'no existe en SQLite', count: 0 };
  }

  const mysqlCols = await getMysqlColumns(mysqlConn, table, dbName);
  if (!mysqlCols.length) {
    // Existe en SQLite pero no en la MySQL destino. Con datos => problema real
    // (status 'missing', migración incompleta). Vacía => se ignora en silencio.
    const pending = countSqliteRows(sqliteDb, table);
    if (pending > 0) {
      return { table, status: 'missing', reason: 'no existe en la MySQL destino — ' + pending + ' registros SIN migrar', count: pending };
    }
    return { table, status: 'skipped', reason: 'no existe en MySQL', count: 0 };
  }

  const commonCols = sqliteCols.filter((c) => mysqlCols.includes(c));
  if (!commonCols.length) {
    return { table, status: 'skipped', reason: 'sin columnas en común', count: 0 };
  }

  let rows;
  try {
    const colsSql = commonCols.map((c) => '`' + c + '`').join(', ');
    const result = sqliteDb.exec('SELECT ' + colsSql + ' FROM `' + table + '`');
    if (!result.length || !result[0].values.length) {
      return { table, status: 'empty', reason: 'tabla vacía en SQLite', count: 0 };
    }
    rows = result[0].values;
  } catch (err) {
    return { table, status: 'error', reason: err.message, count: 0 };
  }

  if (dryRun) {
    return { table, status: 'dry-run', count: rows.length };
  }

  const colList = commonCols.map((c) => '`' + c + '`').join(', ');
  const placeholder = '(' + commonCols.map(() => '?').join(', ') + ')';
  // INSERT IGNORE normal; ON DUPLICATE KEY UPDATE cuando opts.upsert
  // (--force-identity para businesses/config id=1, que INSERT IGNORE dejaría con
  // los valores "de fábrica" de db/schema.sql).
  const upsertClause = opts.upsert
    ? ' ON DUPLICATE KEY UPDATE ' + commonCols
        .filter((c) => c !== 'id')
        .map((c) => '`' + c + '`=VALUES(`' + c + '`)')
        .join(', ')
    : '';
  let inserted = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values = batch.map((row) => row.map((v) => {
      if (v instanceof Uint8Array) return null;
      if (v === undefined) return null;
      return v;
    }));

    const placeholderList = values.map(() => placeholder).join(', ');
    const flat = [];
    values.forEach((r) => r.forEach((v) => flat.push(v)));

    try {
      const res = await mysqlConn.query(
        (upsertClause ? 'INSERT INTO `' : 'INSERT IGNORE INTO `') + table + '` (' + colList + ') VALUES ' + placeholderList + upsertClause,
        flat
      );
      inserted += res[0].affectedRows || 0;
    } catch (err) {
      errors += 1;
      log.warn('  Batch ' + i + '-' + (i + batch.length) + ' en ' + table + ': ' + err.message);
    }
  }

  return { table, status: 'ok', count: rows.length, inserted, errors };
}

/**
 * Ejecuta la migración completa.
 *
 * @param {object} opts
 * @param {string}   opts.sqlitePath    Ruta explícita al .db (si falta, se busca).
 * @param {object}   opts.mysqlConfig   { host, port, user, password, database }.
 * @param {boolean}  opts.forceIdentity Upsert de businesses/config id=1.
 * @param {boolean}  opts.dryRun        No inserta nada.
 * @param {Function} opts.onProgress    ({ phase, table, done, total }) => void.
 * @param {object}   opts.log           { info, ok, warn, error }.
 * @returns {Promise<{ ok, incomplete, results, summary }>}
 */
async function runMigration(opts = {}) {
  const log = normalizeLogger(opts.log);
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const dryRun = Boolean(opts.dryRun);
  const forceIdentity = Boolean(opts.forceIdentity);

  onProgress({ phase: 'start' });
  const sqlitePath = findSqliteFile(opts.sqlitePath);
  log.ok('SQLite: ' + sqlitePath);

  const sqliteDb = await loadSqlite(sqlitePath, { log });

  let conn;
  let cfg;
  try {
    ({ conn, cfg } = await connectMySQL(opts.mysqlConfig || {}, { log }));
  } catch (err) {
    sqliteDb.close();
    throw err;
  }

  const dbName = cfg.database;
  const results = [];

  try {
    if (!dryRun) {
      onProgress({ phase: 'schema' });
      try { await applySchema(conn, { log }); } catch (err) { log.warn('Schema parcial: ' + err.message); }
      try { await ensureRuntimeTables(conn, { log }); } catch (err) { log.warn('Tablas de runtime: ' + err.message); }
    }

    const sqliteTables = discoverSqliteTables(sqliteDb);
    const ordered = TABLES_TO_MIGRATE
      .filter((t) => sqliteTables.includes(t))
      .concat(sqliteTables.filter((t) => !TABLES_TO_MIGRATE.includes(t) && !TABLES_TO_SKIP.has(t)));

    log.info('Migrando ' + ordered.length + ' tablas' + (dryRun ? ' (dry-run)' : ''));

    for (let i = 0; i < ordered.length; i += 1) {
      const table = ordered[i];
      onProgress({ phase: 'table', table, done: i, total: ordered.length });

      if (TABLES_TO_SKIP.has(table)) {
        results.push({ table, status: 'skipped', reason: 'caché offline', count: 0 });
        continue;
      }

      const upsert = forceIdentity && (table === 'businesses' || table === 'config');
      const r = await migrateTable(sqliteDb, conn, table, dbName, { dryRun, upsert, log });
      results.push(r);

      if (r.status === 'ok') {
        log.ok(table + ': ' + r.inserted + '/' + r.count + (upsert ? ' (upsert identidad)' : ''));
      } else if (r.status === 'missing') {
        log.error(table + ': FALTA TABLA — ' + r.reason);
      } else if (r.status === 'error') {
        log.error(table + ': ' + r.reason);
      }
    }
    onProgress({ phase: 'table', done: ordered.length, total: ordered.length });
  } finally {
    sqliteDb.close();
    try { await conn.end(); } catch (_) {}
  }

  const summary = {
    ok:        results.filter((r) => r.status === 'ok').length,
    empty:     results.filter((r) => r.status === 'empty').length,
    skipped:   results.filter((r) => r.status === 'skipped').length,
    errors:    results.filter((r) => r.status === 'error'),
    missing:   results.filter((r) => r.status === 'missing'),
    dryRun:    results.filter((r) => r.status === 'dry-run').length,
    totalSrc:      results.reduce((s, r) => s + (r.count || 0), 0),
    totalInserted: results.filter((r) => r.status === 'ok').reduce((s, r) => s + (r.inserted || 0), 0),
  };

  const incomplete = summary.errors.length > 0 || summary.missing.length > 0;
  onProgress({ phase: 'done', incomplete });

  return { ok: !incomplete, incomplete, results, summary };
}

module.exports = {
  runMigration,
  loadSqlite,
  findSqliteFile,
  TABLES_TO_MIGRATE,
  TABLES_TO_SKIP,
};
