'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Conexión MySQL falsa: registra las queries y responde information_schema con
// las mismas columnas que tenga la tabla en SQLite (para que commonCols != []).
const executed = [];
const tableColumns = {
  businesses: ['id', 'nombre', 'rnc'],
  config: ['id', 'business_structure_mode', 'rnc'],
  ncf_authorized_sequences: ['id', 'document_type', 'start_number', 'end_number', 'next_number', 'prefix'],
  ncf_sequences: ['id', 'ncf_type', 'siguiente_numero', 'maximo'],
};

jest.mock('mysql2/promise', () => ({
  createConnection: jest.fn(async () => ({
    async query(sql, params) {
      executed.push({ sql: String(sql), params });
      const m = /information_schema\.COLUMNS/i.test(sql)
        ? String(params && params[1] || '')
        : null;
      if (m) {
        return [(tableColumns[m] || []).map((c) => ({ COLUMN_NAME: c })), []];
      }
      return [{ affectedRows: (params ? params.length : 0) }, []];
    },
    async end() {},
  })),
}));

const { runMigration } = require('../../scripts/lib/sqlite-to-mysql-migrator');

function buildFixtureSqlite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-migrator-'));
  const file = path.join(dir, 'tecnocaja.db');
  const initSqlJs = require('sql.js');
  return initSqlJs().then((SQL) => {
    const db = new SQL.Database();
    db.run("CREATE TABLE businesses (id INTEGER PRIMARY KEY, nombre TEXT, rnc TEXT)");
    db.run("INSERT INTO businesses VALUES (1, 'Colmado Real', '131000001')");
    db.run("CREATE TABLE config (id INTEGER PRIMARY KEY, business_structure_mode TEXT, rnc TEXT)");
    db.run("INSERT INTO config VALUES (1, 'monocaja', '131000001')");
    db.run("CREATE TABLE ncf_sequences (id INTEGER PRIMARY KEY, ncf_type TEXT, siguiente_numero INT, maximo INT)");
    db.run("INSERT INTO ncf_sequences VALUES (1, 'B02', 5, 99999999)");
    db.run("CREATE TABLE ncf_authorized_sequences (id INTEGER PRIMARY KEY, document_type TEXT, start_number INT, end_number INT, next_number INT, prefix TEXT)");
    db.run("INSERT INTO ncf_authorized_sequences VALUES (1, 'B02', 1, 100, 5, 'B02')");
    fs.writeFileSync(file, Buffer.from(db.export()));
    db.close();
    return file;
  });
}

describe('sqlite-to-mysql-migrator · runMigration', () => {
  beforeEach(() => { executed.length = 0; });

  it('migra las secuencias fiscales y hace upsert de identidad con forceIdentity', async () => {
    const sqlitePath = await buildFixtureSqlite();

    const result = await runMigration({
      sqlitePath,
      forceIdentity: true,
      mysqlConfig: { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'tecnocaja' },
    });

    expect(result.ok).toBe(true);
    expect(result.incomplete).toBe(false);
    expect(result.summary.missing).toHaveLength(0);

    const inserts = executed.filter((e) => /INSERT/i.test(e.sql));
    const bySql = (re) => inserts.find((e) => re.test(e.sql));

    // Las secuencias fiscales (que NO están en db/schema.sql) se migran.
    expect(bySql(/INSERT IGNORE INTO `ncf_authorized_sequences`/i)).toBeTruthy();
    expect(bySql(/INSERT IGNORE INTO `ncf_sequences`/i)).toBeTruthy();

    // businesses/config van con ON DUPLICATE KEY UPDATE (no INSERT IGNORE).
    const configInsert = bySql(/INSERT INTO `config`/i);
    expect(configInsert).toBeTruthy();
    expect(configInsert.sql).toMatch(/ON DUPLICATE KEY UPDATE/i);
    expect(bySql(/INSERT INTO `businesses`.*ON DUPLICATE KEY UPDATE/is)).toBeTruthy();

    fs.rmSync(path.dirname(sqlitePath), { recursive: true, force: true });
  });

  it('sin forceIdentity, config va con INSERT IGNORE', async () => {
    const sqlitePath = await buildFixtureSqlite();

    await runMigration({
      sqlitePath,
      forceIdentity: false,
      mysqlConfig: { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'tecnocaja' },
    });

    const configInsert = executed.find((e) => /INSERT (IGNORE )?INTO `config`/i.test(e.sql));
    expect(configInsert.sql).toMatch(/INSERT IGNORE INTO `config`/i);
    expect(configInsert.sql).not.toMatch(/ON DUPLICATE KEY UPDATE/i);

    fs.rmSync(path.dirname(sqlitePath), { recursive: true, force: true });
  });
});
