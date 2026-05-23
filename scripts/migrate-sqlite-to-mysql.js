#!/usr/bin/env node
/**
 * migrate-sqlite-to-mysql.js
 *
 * Migra datos de la base SQLite local de Tecno Caja hacia MySQL (MariaDB embebida).
 * Util cuando se activa el modo multicaja y cada PC necesita sus datos en MySQL.
 *
 * Uso:
 *   node scripts/migrate-sqlite-to-mysql.js [--dry-run] [--sqlite=/ruta/custom.db]
 *
 * Opciones:
 *   --dry-run      Solo muestra cuantos registros migraria, no inserta nada.
 *   --sqlite=PATH  Ruta explicita al archivo .db de SQLite.
 *   --help         Muestra este mensaje.
 */

'use strict';

const path   = require('path');
const fs     = require('fs');
const os     = require('os');

// -- Leer args ----------------------------------------------------------------
const args      = process.argv.slice(2);
const DRY_RUN   = args.includes('--dry-run');
const HELP      = args.includes('--help');
const sqliteArg = args.find(a => a.startsWith('--sqlite='));
const CUSTOM_SQLITE = sqliteArg ? sqliteArg.split('=')[1] : null;

if (HELP) {
  console.log(`
Tecno Caja -- Migracion SQLite -> MySQL
=====================================
Uso: node scripts/migrate-sqlite-to-mysql.js [opciones]

Opciones:
  --dry-run        Solo muestra cuantos registros migraria (no inserta).
  --sqlite=PATH    Ruta explicita al archivo .db de SQLite.
  --help           Muestra este mensaje.

Variables de entorno requeridas (en .env):
  DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME

El script:
  1. Busca el archivo SQLite en rutas conocidas.
  2. Conecta a MySQL con las credenciales del .env.
  3. Aplica el schema (CREATE TABLE IF NOT EXISTS) sin borrar datos.
  4. Inserta registros con INSERT IGNORE (no duplica existentes).
  5. Muestra un resumen al final.
`);
  process.exit(0);
}

// -- Cargar .env --------------------------------------------------------------
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  try { require('dotenv').config(); } catch (_) {}
}

// -- Colores para terminal ----------------------------------------------------
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
};
const log = {
  info:    msg => console.log(C.cyan + 'i' + C.reset + '  ' + msg),
  ok:      msg => console.log(C.green + 'v' + C.reset + '  ' + msg),
  warn:    msg => console.log(C.yellow + '!' + C.reset + '  ' + msg),
  error:   msg => console.log(C.red + 'x' + C.reset + '  ' + msg),
  section: msg => console.log('\n' + C.bold + C.cyan + '== ' + msg + ' ==' + C.reset),
  dry:     msg => console.log(C.yellow + '[DRY]' + C.reset + ' ' + msg),
};

// -- Tablas a migrar (orden respeta FK) ---------------------------------------
const TABLES_TO_MIGRATE = [
  'businesses',
  'roles',
  'branches',
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

// Tablas que NO se migran (cache offline, cola de sync -- datos efimeros)
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

// -- Buscar SQLite -------------------------------------------------------------
function findSqliteFile() {
  if (CUSTOM_SQLITE) {
    if (fs.existsSync(CUSTOM_SQLITE)) return CUSTOM_SQLITE;
    throw new Error('Archivo SQLite no encontrado en: ' + CUSTOM_SQLITE);
  }

  const candidates = [
    process.env.SQLITE_PATH,
    process.env.DB_PATH,
    path.join(__dirname, '..', 'tecnocaja.db'),
    path.join(__dirname, '..', 'database.db'),
    path.join(__dirname, '..', 'pos.db'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Tecno Caja', 'tecnocaja.db'),
    path.join(os.homedir(), 'AppData', 'Local',   'Tecno Caja', 'tecnocaja.db'),
    path.join(os.homedir(), '.tecnocaja', 'tecnocaja.db'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'tecnocaja-desktop', 'tecnocaja.db'),
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  throw new Error(
    'No se encontro el archivo SQLite. Prueba con --sqlite=/ruta/al/archivo.db\n' +
    'Rutas buscadas:\n  ' + candidates.join('\n  ')
  );
}

// -- Leer SQLite con sql.js ---------------------------------------------------
async function loadSqlite(filePath) {
  log.info('Cargando SQLite desde: ' + filePath);
  let initSqlJs;
  try {
    initSqlJs = require('sql.js');
  } catch (_) {
    throw new Error('Modulo sql.js no encontrado. Ejecuta: npm install sql.js');
  }

  const SQL = await initSqlJs();
  const buf = fs.readFileSync(filePath);
  const db  = new SQL.Database(buf);
  log.ok('SQLite cargado (' + (buf.length / 1024).toFixed(1) + ' KB)');
  return db;
}

// -- Conectar a MySQL ---------------------------------------------------------
async function connectMySQL() {
  let mysql;
  try {
    mysql = require('mysql2/promise');
  } catch (_) {
    throw new Error('Modulo mysql2 no encontrado. Ejecuta: npm install mysql2');
  }

  const cfg = {
    host:               process.env.DB_HOST     || '127.0.0.1',
    port:               parseInt(process.env.DB_PORT || '3399'),
    user:               process.env.DB_USER     || 'root',
    password:           process.env.DB_PASSWORD || '',
    database:           process.env.DB_NAME     || 'tecnocaja',
    multipleStatements: true,
    connectTimeout:     10000,
  };

  log.info('Conectando a MySQL ' + cfg.host + ':' + cfg.port + ' / ' + cfg.database + ' ...');

  try {
    const conn = await mysql.createConnection(cfg);
    log.ok('Conexion MySQL establecida');
    return conn;
  } catch (err) {
    throw new Error(
      'No se pudo conectar a MySQL: ' + err.message + '\n' +
      'Verifica que MariaDB esta corriendo y que las credenciales en .env son correctas.\n' +
      '  DB_HOST=' + cfg.host + '  DB_PORT=' + cfg.port + '  DB_USER=' + cfg.user + '  DB_NAME=' + cfg.database
    );
  }
}

// -- Aplicar schema (sin DROP TABLE) ------------------------------------------
async function applySchema(mysqlConn) {
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    log.warn('db/schema.sql no encontrado -- se omite creacion de tablas.');
    return;
  }

  log.info('Aplicando schema (CREATE TABLE IF NOT EXISTS) ...');

  let sql = fs.readFileSync(schemaPath, 'utf8');

  // Eliminar DROP TABLE (por seguridad -- no borrar datos existentes)
  sql = sql.replace(/DROP\s+TABLE\s+(IF\s+EXISTS\s+)?[^;]+;/gi,
    '-- DROP eliminado por migrate-sqlite-to-mysql --');

  // Transformar CREATE TABLE -> CREATE TABLE IF NOT EXISTS
  sql = sql.replace(/CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\s)/gi,
    'CREATE TABLE IF NOT EXISTS ');

  await mysqlConn.query(sql);
  log.ok('Schema aplicado');
}

// -- Obtener columnas de una tabla en SQLite ----------------------------------
function getSqliteColumns(sqliteDb, table) {
  try {
    const res = sqliteDb.exec('PRAGMA table_info(' + table + ')');
    if (!res.length || !res[0].values.length) return [];
    return res[0].values.map(function(row) { return row[1]; }); // index 1 = name
  } catch (_) {
    return [];
  }
}

// -- Obtener columnas de una tabla en MySQL -----------------------------------
async function getMysqlColumns(mysqlConn, table, dbName) {
  try {
    const [rows] = await mysqlConn.query(
      'SELECT COLUMN_NAME FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [dbName, table]
    );
    return rows.map(function(r) { return r.COLUMN_NAME; });
  } catch (_) {
    return [];
  }
}

// -- Migrar una tabla ---------------------------------------------------------
async function migrateTable(sqliteDb, mysqlConn, table, dbName) {
  const sqliteCols = getSqliteColumns(sqliteDb, table);
  if (!sqliteCols.length) {
    return { table: table, status: 'skipped', reason: 'no existe en SQLite', count: 0 };
  }

  const mysqlCols = await getMysqlColumns(mysqlConn, table, dbName);
  if (!mysqlCols.length) {
    return { table: table, status: 'skipped', reason: 'no existe en MySQL', count: 0 };
  }

  const commonCols = sqliteCols.filter(function(c) { return mysqlCols.includes(c); });
  if (!commonCols.length) {
    return { table: table, status: 'skipped', reason: 'sin columnas en comun', count: 0 };
  }

  // Leer todos los registros de SQLite
  var rows;
  try {
    var colsSql = commonCols.map(function(c) { return '`' + c + '`'; }).join(', ');
    var result = sqliteDb.exec('SELECT ' + colsSql + ' FROM `' + table + '`');
    if (!result.length || !result[0].values.length) {
      return { table: table, status: 'empty', reason: 'tabla vacia en SQLite', count: 0 };
    }
    rows = result[0].values;
  } catch (err) {
    return { table: table, status: 'error', reason: err.message, count: 0 };
  }

  if (DRY_RUN) {
    log.dry(table + ': ' + rows.length + ' registros (no insertados)');
    return { table: table, status: 'dry-run', count: rows.length };
  }

  // Insertar en batches con INSERT IGNORE
  var colList      = commonCols.map(function(c) { return '`' + c + '`'; }).join(', ');
  var placeholder  = '(' + commonCols.map(function() { return '?'; }).join(', ') + ')';
  var inserted     = 0;
  var errors       = 0;

  for (var i = 0; i < rows.length; i += BATCH_SIZE) {
    var batch  = rows.slice(i, i + BATCH_SIZE);
    var values = batch.map(function(row) {
      return row.map(function(v) {
        if (v instanceof Uint8Array) return null;
        if (v === undefined)         return null;
        return v;
      });
    });

    var placeholderList = values.map(function() { return placeholder; }).join(', ');
    var flat = [];
    values.forEach(function(r) { r.forEach(function(v) { flat.push(v); }); });

    try {
      var res = await mysqlConn.query(
        'INSERT IGNORE INTO `' + table + '` (' + colList + ') VALUES ' + placeholderList,
        flat
      );
      inserted += res[0].affectedRows || 0;
    } catch (err) {
      errors++;
      log.warn('  Batch ' + i + '-' + (i + batch.length) + ' en ' + table + ': ' + err.message);
    }
  }

  return { table: table, status: 'ok', count: rows.length, inserted: inserted, errors: errors };
}

// -- Descubrir tablas en SQLite -----------------------------------------------
function discoverSqliteTables(sqliteDb) {
  var result = sqliteDb.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  );
  if (!result.length) return [];
  return result[0].values.map(function(r) { return r[0]; });
}

// -- Main ---------------------------------------------------------------------
async function main() {
  console.log('\n' + C.bold + C.cyan + 'Tecno Caja -- Migracion SQLite -> MySQL' + C.reset);
  console.log(C.gray + '-'.repeat(50) + C.reset);
  if (DRY_RUN) log.warn('MODO DRY-RUN: no se escribira nada en MySQL.\n');

  // 1. Encontrar SQLite
  var sqlitePath;
  try {
    sqlitePath = findSqliteFile();
    log.ok('SQLite encontrado: ' + sqlitePath);
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  // 2. Cargar SQLite
  var sqliteDb;
  try {
    sqliteDb = await loadSqlite(sqlitePath);
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  // 3. Conectar MySQL
  var mysqlConn;
  if (!DRY_RUN) {
    try {
      mysqlConn = await connectMySQL();
    } catch (err) {
      log.error(err.message);
      sqliteDb.close();
      process.exit(1);
    }
  } else {
    log.dry('Omitiendo conexion MySQL (dry-run)');
  }

  // 4. Aplicar schema
  if (!DRY_RUN) {
    try {
      await applySchema(mysqlConn);
    } catch (err) {
      log.warn('Schema parcial: ' + err.message);
    }
  }

  // 5. Determinar tablas a procesar
  var sqliteTables = discoverSqliteTables(sqliteDb);
  log.info('Tablas encontradas en SQLite: ' + sqliteTables.length);

  var ordered = TABLES_TO_MIGRATE
    .filter(function(t) { return sqliteTables.includes(t); })
    .concat(sqliteTables.filter(function(t) {
      return !TABLES_TO_MIGRATE.includes(t) && !TABLES_TO_SKIP.has(t);
    }));

  log.section('Migrando ' + ordered.length + ' tablas');

  var results = [];
  for (var ti = 0; ti < ordered.length; ti++) {
    var table = ordered[ti];
    if (TABLES_TO_SKIP.has(table)) {
      log.warn('  Omitiendo ' + table + ' (tabla de cache offline)');
      results.push({ table: table, status: 'skipped', reason: 'cache offline', count: 0 });
      continue;
    }

    process.stdout.write('  ' + C.gray + '->' + C.reset + ' ' + table.padEnd(35));

    var r = await migrateTable(sqliteDb, mysqlConn, table, process.env.DB_NAME || 'tecnocaja');
    results.push(r);

    if (r.status === 'ok') {
      process.stdout.write(C.green + 'v' + C.reset + ' ' + r.inserted + '/' + r.count + ' insertados\n');
    } else if (r.status === 'dry-run') {
      process.stdout.write(C.yellow + '[DRY]' + C.reset + ' ' + r.count + ' registros\n');
    } else if (r.status === 'empty') {
      process.stdout.write(C.gray + 'vacia' + C.reset + '\n');
    } else if (r.status === 'skipped') {
      process.stdout.write(C.yellow + 'omitida' + C.reset + ' (' + r.reason + ')\n');
    } else if (r.status === 'error') {
      process.stdout.write(C.red + 'error' + C.reset + ' -- ' + r.reason + '\n');
    }
  }

  // 6. Resumen
  log.section('Resumen');
  var ok      = results.filter(function(r) { return r.status === 'ok'; });
  var dryRun  = results.filter(function(r) { return r.status === 'dry-run'; });
  var empty   = results.filter(function(r) { return r.status === 'empty'; });
  var skipped = results.filter(function(r) { return r.status === 'skipped'; });
  var errors  = results.filter(function(r) { return r.status === 'error'; });

  var totalSrc      = results.reduce(function(s, r) { return s + (r.count    || 0); }, 0);
  var totalInserted = ok.reduce(function(s, r)       { return s + (r.inserted || 0); }, 0);

  if (DRY_RUN) {
    console.log('  Tablas analizadas : ' + (dryRun.length + empty.length + skipped.length));
    console.log('  Registros a migrar: ' + C.bold + totalSrc + C.reset);
    console.log('  Tablas vacias     : ' + empty.length);
    console.log('  Tablas omitidas   : ' + skipped.length);
  } else {
    console.log('  Tablas migradas   : ' + C.green + ok.length + C.reset);
    console.log('  Registros origen  : ' + totalSrc);
    console.log('  Registros creados : ' + C.bold + C.green + totalInserted + C.reset);
    console.log('  Tablas vacias     : ' + empty.length);
    console.log('  Tablas omitidas   : ' + skipped.length);
    if (errors.length) {
      console.log('  ' + C.red + 'Tablas con error  : ' + errors.length + C.reset);
      errors.forEach(function(r) { log.error('    ' + r.table + ': ' + r.reason); });
    }
  }

  // 7. Cerrar conexiones
  sqliteDb.close();
  if (mysqlConn) await mysqlConn.end();

  if (errors.length) {
    log.warn('\nMigracion completada con errores. Revisa los detalles arriba.');
    process.exit(2);
  } else {
    log.ok(DRY_RUN
      ? '\nDry-run completado. Ejecuta sin --dry-run para migrar.'
      : '\nMigracion completada exitosamente. Los datos estan en MySQL!'
    );
  }
}

main().catch(function(err) {
  console.log('\x1b[31mx\x1b[0m  Error fatal: ' + err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
