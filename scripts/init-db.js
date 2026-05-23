const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { prepareRuntimeEnvironment } = require('./runtime-bootstrap');

function normalizeSchema(sql) {
  return sql
    .replace(/CREATE DATABASE IF NOT EXISTS[^;]*;/gi, '')
    .replace(/^\s*USE [^;]*;/gim, '')
    .replace(/\b([a-z_][a-z0-9_]*)\s+INT\s+AUTO_INCREMENT\s+PRIMARY\s+KEY\b/gi, '$1 INTEGER PRIMARY KEY AUTOINCREMENT')
    .replace(/\b([a-z_][a-z0-9_]*)\s+INTEGER\s+AUTO_INCREMENT\s+PRIMARY\s+KEY\b/gi, '$1 INTEGER PRIMARY KEY AUTOINCREMENT')
    .replace(/UNIQUE KEY [^\s]+ \(([^)]+)\)/gi, 'UNIQUE ($1)')
    .replace(/UNIQUE KEY/gi, 'UNIQUE')
    .replace(/TINYINT\(1\)/gi, 'INTEGER')
    .replace(/LONGTEXT/gi, 'TEXT')
    .replace(/DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP/gi, 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP')
    .replace(/CHARACTER SET [^\s;]+ COLLATE [^;]+/gi, '')
    .replace(/ENGINE=[^;]+/gi, '')
    .replace(/`/g, '');
}

async function main() {
  const { dbFile } = prepareRuntimeEnvironment({
    appRoot: path.join(__dirname, '..'),
    userDataPath: process.env.TECNO_CAJA_USER_DATA || ''
  });
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });

  let sql = fs.readFileSync(schemaPath, 'utf8');
  sql = normalizeSchema(sql);

  const SQL = await initSqlJs();
  const db = new SQL.Database();

  const statements = sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((stmt) => stmt.trim())
    .filter(Boolean);

  try {
    for (const statement of statements) {
      db.run(statement);
    }
    fs.writeFileSync(dbFile, Buffer.from(db.export()));
    console.log('Base de datos SQLite inicializada correctamente.');
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error('No se pudo inicializar la base de datos SQLite.');
  console.error(error.message);
  process.exit(1);
});
