const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { prepareRuntimeEnvironment } = require('./scripts/runtime-bootstrap');
const {
  decryptSqliteBuffer,
  encryptSqliteBuffer,
  isPlainSqliteBuffer,
} = require('./server/security/local-machine-crypto');
let getStableMachineFingerprint;
try {
  ({ getStableMachineFingerprint } = require('./server/security/machine-identity'));
} catch (_) {
  getStableMachineFingerprint = () => '';
}

const runtime = prepareRuntimeEnvironment({
  appRoot: __dirname,
  userDataPath: process.env.TECNO_CAJA_USER_DATA || ''
});

const dbFile = runtime.dbFile;

// Cifrado en reposo de la BD SQLite. Se puede desactivar por instalación con
// TECNO_CAJA_DB_PLAINTEXT=1 — pensado para PCs donde el antivirus corrompe la
// escritura atómica una y otra vez: sin la cabecera cifrada NVPDB1, una
// escritura desgarrada deja un SQLite parcial (recuperable) en vez de un
// archivo indescifrable. Además, si el archivo en disco YA está en texto
// plano (p.ej. se restauró una reconstrucción), se mantiene así solo — nunca
// se re-cifra en silencio.
let _dbPlaintext = String(process.env.TECNO_CAJA_DB_PLAINTEXT || '').trim() === '1';
function dbEncryptionDisabled() { return _dbPlaintext; }
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
    .replace(/date\(\s*'now'\s*,\s*'start of month'\s*\)/gi, "DATE_FORMAT(CURDATE(), '%Y-%m-01')")
    .replace(/date\(\s*'now'\s*,\s*'-(\d+)\s*days?'\s*\)/gi, 'DATE_SUB(CURDATE(), INTERVAL $1 DAY)')
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

// Sidecar con la huella de máquina que se usó la última vez que se guardó bien.
// Se relee si la huella viva ya no descifra (actualización de Windows, cambio
// de RAM, etc.) — así la BD no se pierde por algo tan trivial.
const FPR_FILE = dbFile + '.fpr';

function readSavedFingerprint() {
  try {
    const v = fs.readFileSync(FPR_FILE, 'utf8').trim();
    return /^[a-f0-9]{16,128}$/i.test(v) ? v : '';
  } catch (_) { return ''; }
}

function writeSavedFingerprint() {
  try {
    const fp = String(getStableMachineFingerprint() || '').trim();
    if (fp && fp !== readSavedFingerprint()) fs.writeFileSync(FPR_FILE, fp, 'utf8');
  } catch (_) {}
}

// Borra los .tmp-<pid> abandonados por procesos muertos (rename fallido por
// bloqueo de antivirus). Un cliente real acumuló 106 de estos en 2 meses.
function cleanupStaleTmpFiles() {
  try {
    const dir = path.dirname(dbFile);
    const base = path.basename(dbFile);
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(base + '.tmp-')) continue;
      const full = path.join(dir, name);
      try {
        const age = Date.now() - fs.statSync(full).mtimeMs;
        if (age > 5 * 60 * 1000) fs.unlinkSync(full); // > 5 min = huérfano seguro
      } catch (_) {}
    }
  } catch (_) {}
}

// Intenta obtener un buffer SQLite usable de `raw`, probando varias llaves
// antes de rendirse. Devuelve el buffer descifrado o lanza el último error.
function tryDecryptWithFallbacks(raw) {
  if (isPlainSqliteBuffer(raw)) {
    // El archivo en disco ya está sin cifrar → esta instalación se queda en
    // texto plano; no re-cifrar en el próximo guardado.
    if (!_dbPlaintext) {
      _dbPlaintext = true;
      console.warn('[db] BD en texto plano detectada — cifrado en reposo DESACTIVADO para esta instalación.');
    }
    return raw;
  }
  let lastErr;
  try { return decryptSqliteBuffer(raw); } catch (e) { lastErr = e; }
  const savedFp = readSavedFingerprint();
  if (savedFp) {
    try {
      const buf = decryptSqliteBuffer(raw, { fingerprintOverride: savedFp });
      console.warn('[db] BD descifrada con la huella guardada (.fpr) — la huella viva cambió (¿update de Windows?). Se re-cifrará con la nueva al guardar.');
      return buf;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function createSqlitePromise() {
  return initSqlJs().then((SQL) => {
    cleanupStaleTmpFiles();
    const fileExists = fs.existsSync(dbFile);
    if (!fileExists) {
      return new SQL.Database();
    }
    const raw = fs.readFileSync(dbFile);
    let buffer;
    try {
      buffer = tryDecryptWithFallbacks(raw);
    } catch (decryptErr) {
      // Último recurso ANTES de dar la BD por perdida: si hay un .tmp-* reciente
      // y descifrable, usarlo (una escritura atómica que no alcanzó el rename).
      const salvaged = salvageFromTmp(SQL);
      if (salvaged) return salvaged;
      const corruptPath = dbFile + '.corrupt_' + Date.now();
      try { fs.renameSync(dbFile, corruptPath); } catch (_) {}
      console.error(
        '[db] ⚠️ No se pudo descifrar ' + dbFile + ' (' + (decryptErr.code || decryptErr.message) + '). ' +
        'Archivo movido a ' + corruptPath + '. Arrancando con BD nueva en blanco.'
      );
      return new SQL.Database();
    }
    return new SQL.Database(buffer);
  });
}

function salvageFromTmp(SQL) {
  try {
    const dir = path.dirname(dbFile);
    const base = path.basename(dbFile);
    const tmps = fs.readdirSync(dir)
      .filter((n) => n.startsWith(base + '.tmp-'))
      .map((n) => ({ n, p: path.join(dir, n), m: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const t of tmps) {
      try {
        const buf = tryDecryptWithFallbacks(fs.readFileSync(t.p));
        const db = new SQL.Database(buf);
        // sanity: que tenga la tabla sales
        db.exec('SELECT 1 FROM sales LIMIT 1');
        console.warn('[db] BD recuperada desde ' + t.n + ' (escritura atómica sin completar). Se re-guardará al primer cambio.');
        return db;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
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

// Escritura atómica: nunca tocamos dbFile directamente. Se escribe primero a
// un archivo temporal, se fuerza fsync (bytes ya en disco, no solo en el
// buffer del SO) y recién entonces se hace rename sobre dbFile. Si la PC
// pierde energía en cualquier punto antes del rename, dbFile original queda
// intacto — sin esto, un corte de luz a mitad del fs.writeFile truncaba el
// archivo cifrado y el sistema arrancaba con una BD nueva en blanco.
async function _writeToDisk() {
  const db = await getSqlitePromise();
  const plainBuf = Buffer.from(db.export());
  const encrypted = dbEncryptionDisabled() ? plainBuf : encryptSqliteBuffer(plainBuf);
  const tmpFile = dbFile + '.tmp-' + process.pid;

  await new Promise(function(resolve, reject) {
    fs.writeFile(tmpFile, encrypted, function(err) {
      if (err) reject(err); else resolve();
    });
  });

  await new Promise(function(resolve, reject) {
    fs.open(tmpFile, 'r+', function(err, fd) {
      if (err) return reject(err);
      fs.fsync(fd, function(fsyncErr) {
        fs.close(fd, function() {
          if (fsyncErr) reject(fsyncErr); else resolve();
        });
      });
    });
  });

  // El rename sobre un archivo abierto por el antivirus / indexador de Windows
  // falla con EPERM/EBUSY. Reintentar con backoff corto resuelve el 99% de los
  // casos transitorios. Un cliente real perdía guardados y acumulaba .tmp por
  // esto (y terminaba con la BD a medio escribir = "corrupta").
  let renamed = false;
  let lastRenameErr = null;
  for (let i = 0; i < 6 && !renamed; i++) {
    try {
      await new Promise(function(resolve, reject) {
        fs.rename(tmpFile, dbFile, function(err) { if (err) reject(err); else resolve(); });
      });
      renamed = true;
    } catch (err) {
      lastRenameErr = err;
      await new Promise(function(r) { setTimeout(r, 120 * (i + 1)); });
    }
  }

  if (!renamed) {
    // Último recurso: escritura directa NO atómica. Peor que el rename, pero
    // muchísimo mejor que perder el guardado y dejar otro .tmp huérfano.
    try {
      fs.writeFileSync(dbFile, encrypted);
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      console.error('[db] ⚠️ rename bloqueado tras 6 intentos (' + (lastRenameErr && lastRenameErr.code) +
        '). Guardado con escritura directa. Revisar exclusión de antivirus para ' + path.dirname(dbFile));
    } catch (writeErr) {
      throw lastRenameErr || writeErr;
    }
  }

  writeSavedFingerprint();
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
    multipleStatements: false,
    // Sin esto, un DB_HOST inalcanzable (terminal secundaria multicaja con
    // la principal apagada) puede tardar mucho más de lo esperado por
    // intento (timeouts TCP de Windows) antes de fallar. Acota cada intento
    // de conexión para que el arranque degradado a modo offline sea rápido.
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 5000)
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

// Multicaja (varias PC contra un MySQL por LAN/Tailscale): cada venta serializa
// sobre los locks de fila del contador FAC y de ncf_sequences. Con el timeout
// por defecto (50s) un peer colgado congela las otras cajas. Lo bajamos a
// ~8s por conexión física (bandera para no repetir el round-trip) para que
// falle rápido y withTransactionRetry pueda reintentar.
const MYSQL_LOCK_WAIT_TIMEOUT = Number(process.env.DB_LOCK_WAIT_TIMEOUT_SECONDS || 8);
async function ensureSessionTuning(connection) {
  if (connection.__tcTuned) return;
  try {
    await connection.query('SET SESSION innodb_lock_wait_timeout = ?', [MYSQL_LOCK_WAIT_TIMEOUT]);
  } catch (_) {
    // Algunas variantes no permiten cambiarlo por sesión — no es crítico.
  }
  connection.__tcTuned = true;
}

async function withTransaction(work) {
  if (dbClient === 'mysql') {
    const connection = await getMysqlPool().getConnection();
    try {
      await ensureSessionTuning(connection);
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

// Errores transitorios de concurrencia MySQL que SÍ vale la pena reintentar:
//  1205 ER_LOCK_WAIT_TIMEOUT · 1213 ER_LOCK_DEADLOCK · 1062 ER_DUP_ENTRY
// (este último normalmente en invoice_number bajo carrera de varias cajas —
//  al reintentar, el contador FAC asigna el siguiente número libre).
function isTransientTxnError(error) {
  const code = String(error && error.code || '').toUpperCase();
  const errno = Number(error && error.errno || 0);
  if (code === 'ER_LOCK_WAIT_TIMEOUT' || errno === 1205) return { retry: true, kind: 'lock_timeout' };
  if (code === 'ER_LOCK_DEADLOCK' || errno === 1213) return { retry: true, kind: 'deadlock' };
  if (code === 'ER_DUP_ENTRY' || errno === 1062) {
    const msg = String(error && error.message || '').toLowerCase();
    // Solo reintentar duplicados de número de factura / PK de sales; otros
    // UNIQUE (cédula de cliente, etc.) no se resuelven reintentando.
    if (msg.includes('invoice_number') || msg.includes("for key 'sales") || msg.includes('sales.invoice')) {
      return { retry: true, kind: 'dup_invoice' };
    }
  }
  return { retry: false };
}

// Igual que withTransaction pero reintenta ante tranques/deadlocks/duplicado
// de factura. `work` se re-ejecuta desde cero (el rollback deshizo todo), así
// que solo debe contener trabajo idempotente-al-reintento (los sync
// fire-and-forget van FUERA, en el handler). No hace nada especial en SQLite:
// ahí no hay concurrencia entre procesos.
async function withTransactionRetry(work, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 4));
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await withTransaction(work);
    } catch (error) {
      lastError = error;
      const verdict = dbClient === 'mysql' ? isTransientTxnError(error) : { retry: false };
      if (!verdict.retry || attempt === maxAttempts) throw error;
      const backoff = Math.min(400, 40 * attempt) + Math.floor(Math.random() * 60);
      console.warn(`[db] transacción reintentable (${verdict.kind}), intento ${attempt}/${maxAttempts - 1} — reintenta en ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastError;
}

module.exports = {
  query: query,
  withTransaction: withTransaction,
  withTransactionRetry: withTransactionRetry,
  _isTransientTxnError: isTransientTxnError,
  reloadDatabase: reloadDatabase,
  dbFile: dbFile,
  getDbClient: function() { return dbClient; },
  flushPendingSave: _flushOnExit
};
