'use strict';

// Base SQLite en memoria con el esquema real (db/schema.sql convertido igual
// que en el primer arranque) y el mismo contrato que db.js: query() y
// withTransaction().
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { normalizeSchema } = require('../../scripts/auto-init-db');

async function crearBaseSqlite() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const schema = normalizeSchema(fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'schema.sql'), 'utf8'));
  for (const statement of schema.split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
    db.run(statement);
  }

  async function query(sql, params = []) {
    const statement = db.prepare(sql);
    statement.bind(params);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) {
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      statement.free();
      return rows;
    }
    statement.run();
    statement.free();
    const affectedRows = db.getRowsModified();
    const insertId = db.exec('SELECT last_insert_rowid() AS id')[0]?.values[0][0] || 0;
    return { insertId, affectedRows, rowsAffected: affectedRows };
  }

  async function withTransaction(work) {
    db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const result = await work({ query, run: query });
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) { /* ya revertida */ }
      throw error;
    }
  }

  return { db, query, withTransaction, close: () => db.close() };
}

module.exports = { crearBaseSqlite };
