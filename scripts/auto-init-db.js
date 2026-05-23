// Script de inicialización automática de base de datos
// Se ejecuta al abrir la app por primera vez

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { prepareRuntimeEnvironment } = require('./runtime-bootstrap');

function normalizeSchema(sql) {
  return sql
    .replace(/CREATE DATABASE IF NOT EXISTS[^;]*;/gi, '')
    .replace(/^\s*USE [^;]*;/gim, '')
    // AUTO_INCREMENT como PRIMARY KEY
    .replace(/\b([a-z_][a-z0-9_]*)\s+INT\s+AUTO_INCREMENT\s+PRIMARY\s+KEY\b/gi, '$1 INTEGER PRIMARY KEY AUTOINCREMENT')
    .replace(/\b([a-z_][a-z0-9_]*)\s+INTEGER\s+AUTO_INCREMENT\s+PRIMARY\s+KEY\b/gi, '$1 INTEGER PRIMARY KEY AUTOINCREMENT')
    // AUTO_INCREMENT suelto (sin PRIMARY KEY) — SQLite no lo soporta fuera de AUTOINCREMENT
    .replace(/\bAUTO_INCREMENT\b/gi, '')
    // Claves e índices MySQL
    .replace(/UNIQUE KEY [^\s]+ \(([^)]+)\)/gi, 'UNIQUE ($1)')
    .replace(/UNIQUE KEY/gi, 'UNIQUE')
    .replace(/,?\s*\bKEY\s+\w+\s*\([^)]*\)/gi, '')
    // COMMENT no soportado en SQLite
    .replace(/\bCOMMENT\s+'(?:[^'\\]|\\.)*'/gi, '')
    .replace(/\bCOMMENT\s+"(?:[^"\\]|\\.)*"/gi, '')
    // Tipos MySQL → SQLite
    .replace(/TINYINT\(1\)/gi, 'INTEGER')
    .replace(/\bINT\s*\(\d+\)/gi, 'INTEGER')
    .replace(/\bBIGINT\s*\(\d+\)/gi, 'INTEGER')
    .replace(/\bSMALLINT\s*\(\d+\)/gi, 'INTEGER')
    .replace(/\bUNSIGNED\b/gi, '')
    .replace(/LONGTEXT/gi, 'TEXT')
    .replace(/MEDIUMTEXT/gi, 'TEXT')
    .replace(/\bVARCHAR\s*\(\d+\)/gi, 'TEXT')
    // DEFAULT CURRENT_TIMESTAMP con ON UPDATE (MySQL)
    .replace(/DEFAULT\s+CURRENT_TIMESTAMP\s+ON\s+UPDATE\s+CURRENT_TIMESTAMP/gi, 'DEFAULT CURRENT_TIMESTAMP')
    .replace(/DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP/gi, 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP')
    // Opciones de tabla MySQL
    .replace(/CHARACTER SET [^\s,);]+(?: COLLATE [^\s,);]+)?/gi, '')
    .replace(/COLLATE [^\s,);]+/gi, '')
    .replace(/ENGINE\s*=\s*[^\s,);]+/gi, '')
    .replace(/DEFAULT CHARSET\s*=\s*[^\s,);]+/gi, '')
    .replace(/ROW_FORMAT\s*=\s*[^\s,);]+/gi, '')
    // Statements MySQL que no aplican a SQLite
    .replace(/SET\s+FOREIGN_KEY_CHECKS\s*=[^;]*;?/gi, '')
    .replace(/SET\s+NAMES\s+[^;]*;?/gi, '')
    .replace(/SET\s+@@[^;]*;?/gi, '')
    // Backticks → sin comillas
    .replace(/`/g, '');
}

async function initializeDatabase() {
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
    .map((statement) => statement.trim())
    .filter(Boolean);

  try {
    for (const statement of statements) {
      try {
        db.run(statement);
      } catch (stmtErr) {
        console.error('[auto-init-db] Error en statement:\n', statement.slice(0, 300));
        throw stmtErr;
      }
    }
    fs.writeFileSync(dbFile, Buffer.from(db.export()));
    console.log('✅ Base de datos inicializada correctamente');
  } finally {
    db.close();
  }
}

module.exports = { initializeDatabase };
