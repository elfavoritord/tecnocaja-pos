const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { prepareRuntimeEnvironment } = require('./scripts/runtime-bootstrap');
const {
  decryptSqliteBuffer,
  encryptSqliteBuffer,
} = require('./server/security/local-machine-crypto');

const runtime = prepareRuntimeEnvironment({
  appRoot: __dirname,
  userDataPath: process.env.TECNO_CAJA_USER_DATA || ''
});

const dbFile = runtime.dbFile;
const dbClient = String(process.env.DB_CLIENT || 'sqlite').trim().toLowerCase() === 'mysql'
  ? 'mysql'
  : 'sqlite';

let mysqlLib = null;
let mysqlPool = null;
let sqlitePromise = null;

function ensureMysqlLib() {
  if (!mysqlLib) {
    mysqlLib = require('mysql2/promise');
  }
  return mysqlLib;
}

function normalizeMySqlSql(sql) {
  let normalized = String(sql || '').trim();

  normalized = normalized
    .replace(/\bINTEGER PRIMARY KEY AUTOINCREMENT\b/gi, 'INT AUTO_INCREMENT PRIMARY KEY')
    .replace(/datetime\(\s*'now'\s*,\s*'\s*\+30 days'\s*\)/gi, 'DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 30 DAY)')
    .replace(/datetime\(\s*'now'\s*\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/date\(\s*'now'\s*\)/gi, 'CURRENT_DATE')
    .replace(/\bstrftime\('%H:00',\s*([^)]+)\)/gi, "DATE_FORMAT($1, '%H:00')")
    .replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT IGNORE INTO')
    .replace(/MAX\(COALESCE\(([^)]+)\),\s*([^)]+)\)/gi, 'GREATEST(COALESCE($1), $2)');

  if (/^PRAGMA\s+foreign_keys\s*=\s*(ON|OFF)\s*;?$/i.test(normalized)) {
    return { type: 'noop', sql: normalized, params: [] };
  }

  const pragmaMatch = normalized.match(/^PRAGMA\s+table_info\(([^)]+)\)\s*;?$/i);
  if (pragmaMatch) {
    const tableName = String(pragmaMatch[1] || '').trim().replace(/["'`]/g, '');
    return {
      type: 'table_info',
      sql: 'SHOW COLUMNS FROM `' + tableName + '`',
      params: []
    };
  }

  if (/SELECT\s+name\s*,\s*sql\s+FROM\s+sqlite_master\s+WHERE\s+type\s*=\s*['"]table['"]/i.test(normalized)) {
    return { type: 'sqlite_master', sql: normalized, params: [] };
  }

  if (/ON\s+CONFLICT\s*\(([^)]+)\)\s*DO\s+UPDATE\s+SET/i.test(normalized)) {
    normalized = normalized
      .replace(/ON\s+CONFLICT\s*\(([^)]+)\)\s*DO\s+UPDATE\s+SET/gi, 'ON DUPLICATE KEY UPDATE')
      .replace(/\bexcluded\.([a-zA-Z0-9_]+)/g, 'VALUES($1)');
  }

  return { type: 'sql', sql: normalized, params: [] };
}

function createSqlitePromise() {
  return initSqlJs().then((SQL) => {
    const fileExists = fs.existsSync(dbFile);
    if (!fileExists) {
      return new SQL.Database();
    }
    let buffer;
    try {
      buffer = decryptSqliteBuffer(fs.readFileSync(dbFile));
    } catch (decryptErr) {
      const corruptPath = dbFile + '.corrupt_' + Date.now();
      try { fs.renameSync(dbFile, corruptPath); } catch (_) {}
      console.warn(
        '[db] No se pudo descifrar ' + dbFile + ' (' + (decryptErr.code || decryptErr.message) + '). ' +
        'Archivo movido a ' + corruptPath + '. Arrancando con BD nueva en blanco.'
      );
      return new SQL.Database();
    }
    return new SQL.Database(buffer);
  });
}

function getSqlitePromise() {
  if (!sqlitePromise) {
    sqlitePromise = createSqlitePromise();
  }
  return sqlitePromise;
}

// ─── Guardado diferido (debounce) ────────────────────────────────────────────
// En lugar de escribir el archivo en cada INSERT/UPDATE, se acumulan los cambios
// en memoria y se persisten al disco una sola vez tras 80ms de inactividad.
// Esto convierte 5 escrituras seguidas (ej. cerrar caja) en 1 sola llamada I/O.
let _savePending = false;
let _saveTimer = null;
const _SAVE_DEBOUNCE_MS = 80;

async function _writeToDisk() {
  const db = await getSqlitePromise();
  const encrypted = encryptSqliteBuffer(Buffer.from(db.export()));
  return new Promise(function(resolve, reject) {
    fs.writeFile(dbFile, encrypted, function(err) {
      if (err) reject(err); else resolve();
    });
  });
}

async function saveSqliteDb() {
  _savePending = false;
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  await _writeToDisk();
}

function _scheduleSave() {
  _savePending = true;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async function() {
    _saveTimer = null;
    if (_savePending) {
      _savePending = false;
      try { await _writeToDisk(); } catch (e) { console.error('[db] Error guardando SQLite:', e.message); }
    }
  }, _SAVE_DEBOUNCE_MS);
}

async function _flushOnExit() {
  if (_savePending) {
    _savePending = false;
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    try { await _writeToDisk(); } catch (_) {}
  }
}
process.on('SIGTERM', function() { _flushOnExit().finally(function() { process.exit(0); }); });
process.on('SIGINT',  function() { _flushOnExit().finally(function() { process.exit(0); }); });
// ─────────────────────────────────────────────────────────────────────────────

async function runSqliteStatement(sql, params, save) {
  if (params === undefined) params = [];
  if (save === undefined) save = true;
  const db = await getSqlitePromise();
  const trimmed = String(sql || '').trim();
  const isSelect = /^(SELECT|PRAGMA|WITH)/i.test(trimmed);
  const statement = db.prepare(sql);
  statement.bind(params);

  if (isSelect) {
    const rows = [];
    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
    statement.free();
    return rows;
  }

  statement.run();
  statement.free();
  const rowsAffected = Number(db.getRowsModified ? db.getRowsModified() : 0);

  if (save) {
    _scheduleSave();
  }

  const resultRows = db.exec('SELECT last_insert_rowid() AS id;');
  const insertId = (resultRows && resultRows[0] && resultRows[0].values && resultRows[0].values[0] && resultRows[0].values[0][0]) || 0;
  return { insertId: insertId, rowsAffected: rowsAffected, affectedRows: rowsAffected };
}

function getMysqlConfig() {
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'tecnocaja',
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_LIMIT || 10),
    queueLimit: 0,
    charset: 'utf8mb4',
    multipleStatements: false
  };
}

function getMysqlPool() {
  if (!mysqlPool) {
    const mysql = ensureMysqlLib();
    mysqlPool = mysql.createPool(getMysqlConfig());
    mysqlPool.on('error', function(err) {
      if (err.code === 'ENETUNREACH' || err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' ||
          err.code === 'ETIMEDOUT' || err.code === 'PROTOCOL_CONNECTION_LOST') {
        return;
      }
      console.error('[db] MySQL pool error:', err.code, err.message);
    });
  }
  return mysqlPool;
}

async function runMysqlSpecial(connection, normalized) {
  if (normalized.type === 'noop') {
    return [];
  }

  if (normalized.type === 'table_info') {
    const rows_result = await connection.query(normalized.sql);
    const rows = rows_result[0];
    return rows.map(function(row) {
      return {
        cid: null,
        name: row.Field,
        type: row.Type,
        notnull: row.Null === 'NO' ? 1 : 0,
        dflt_value: row.Default,
        pk: row.Key === 'PRI' ? 1 : 0
      };
    });
  }

  if (normalized.type === 'sqlite_master') {
    const tableResult = await connection.query('SHOW TABLES');
    const tableRows = tableResult[0];
    const rows = [];
    for (const tableRow of tableRows) {
      const tableName = Object.values(tableRow || {})[0];
      if (!tableName) continue;
      const createResult = await connection.query('SHOW CREATE TABLE `' + tableName + '`');
      const createRows = createResult[0];
      const createRow = createRows[0] || {};
      const createSql = createRow['Create Table'] || createRow['Create View'] || '';
      rows.push({ name: tableName, sql: createSql });
    }
    return rows;
  }

  return null;
}

async function runMysqlQueryWith(connection, sql, params) {
  if (params === undefined) params = [];
  const normalized = normalizeMySqlSql(sql);
  const specialResult = await runMysqlSpecial(connection, normalized);
  if (specialResult !== null) {
    return specialResult;
  }

  const result = await connection.query(normalized.sql, params);
  const rows = result[0];
  if (Array.isArray(rows)) {
    return rows;
  }

  return {
    insertId: Number(rows.insertId || 0),
    rowsAffected: Number(rows.affectedRows || 0),
    affectedRows: Number(rows.affectedRows || 0)
  };
}

async function reloadDatabase() {
  if (dbClient === 'mysql') {
    if (mysqlPool) {
      await mysqlPool.end();
      mysqlPool = null;
    }
    return getMysqlPool();
  }

  const previousDb = await getSqlitePromise().catch(function() { return null; });
  try {
    if (previousDb && previousDb.close) previousDb.close();
  } catch (_error) {
    // ignore close failures
  }
  sqlitePromise = createSqlitePromise();
  return sqlitePromise;
}

async function query(sql, params) {
  if (params === undefined) params = [];
  if (dbClient === 'mysql') {
    return runMysqlQueryWith(getMysqlPool(), sql, params);
  }
  return runSqliteStatement(sql, params, true);
}

async function withTransaction(work) {
  if (dbClient === 'mysql') {
    const connection = await getMysqlPool().getConnection();
    try {
      await connection.beginTransaction();
      const result = await work({
        query: function(sql, params) { return runMysqlQueryWith(connection, sql, params); },
        run: function(sql, params) { return runMysqlQueryWith(connection, sql, params); }
      });
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch (_rollbackError) {
        // ignore rollback failures
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  const db = await getSqlitePromise();
  try {
    db.exec('BEGIN IMMEDIATE TRANSACTION');
    const transactionalQuery = function(sql, params) { return runSqliteStatement(sql, params, false); };
    const result = await work({
      query: transactionalQuery,
      run: transactionalQuery
    });
    db.exec('COMMIT');
    await saveSqliteDb();
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (_rollbackError) {
      // ignore rollback failures
    }
    throw error;
  }
}

module.exports = {
  query: query,
  withTransaction: withTransaction,
  reloadDatabase: reloadDatabase,
  dbFile: dbFile,
  getDbClient: function() { return dbClient; },
  flushPendingSave: _flushOnExit
};
