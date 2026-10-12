'use strict';

/**
 * Base SQLite (sql.js) con el esquema real del POS (db/schema.sql convertido
 * igual que en el primer arranque) y el mismo contrato de query() /
 * withTransaction() que db.js en modo SQLite. Así las pruebas corren el SQL
 * real en el dialecto de los clientes nuevos (monocaja).
 */

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { normalizeSchema } = require('../../scripts/auto-init-db');

async function createSqlitePos() {
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
    const id = db.exec('SELECT last_insert_rowid() AS id;')[0]?.values?.[0]?.[0] || 0;
    return { insertId: id, affectedRows, rowsAffected: affectedRows };
  }

  let txChain = Promise.resolve();
  function withTransaction(work) {
    const run = async () => {
      db.run('BEGIN IMMEDIATE TRANSACTION');
      try {
        const result = await work({ query, run: query });
        db.run('COMMIT');
        return result;
      } catch (error) {
        try { db.run('ROLLBACK'); } catch (_e) { /* nada */ }
        throw error;
      }
    };
    const next = txChain.then(run, run);
    txChain = next.catch(() => {});
    return next;
  }

  async function addColumnIfMissing(table, column, definition) {
    const cols = await query(`PRAGMA table_info(${table})`);
    if (cols.some((c) => c.name === column)) return;
    await query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  return { db, query, withTransaction, addColumnIfMissing, close: () => db.close() };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function sqlDate(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

module.exports = { createSqlitePos, sqlDate };
