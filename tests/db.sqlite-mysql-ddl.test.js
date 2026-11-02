'use strict';

/**
 * Los CREATE TABLE escritos para MariaDB deben correr en SQLite, que es lo que usan
 * los negocios de una sola caja. Fallaban en silencio: "no such table" al usar la tabla.
 */

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const { adaptarCreateTableSqlite } = require('../db');

const RAIZ = path.join(__dirname, '..');
const tablaDe = async (ddl, nombre) => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE suppliers (id INTEGER PRIMARY KEY)');
  db.run('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  db.run(adaptarCreateTableSqlite(ddl));
  return db.exec(`SELECT sql FROM sqlite_master WHERE name = '${nombre}'`)[0]?.values[0][0] || '';
};

describe('CREATE TABLE de MariaDB en SQLite', () => {
  test('KEY e índices se quitan; UNIQUE KEY queda como UNIQUE', async () => {
    const sql = await tablaDe(`CREATE TABLE t (
      id INT AUTO_INCREMENT PRIMARY KEY,
      a INT NOT NULL,
      b VARCHAR(10),
      UNIQUE KEY uq_t (a, b),
      KEY idx_t (b),
      INDEX idx_prefijo (b(5))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, 't');
    expect(sql).toMatch(/INTEGER PRIMARY KEY AUTOINCREMENT/);
    expect(sql).toMatch(/UNIQUE \(a, b\)/);
    expect(sql).not.toMatch(/idx_|ENGINE|uq_t/);
  });

  test('una columna llamada key no se toca, ni la llave primaria compuesta', async () => {
    const sql = await tablaDe(`CREATE TABLE t (
      key VARCHAR(100) NOT NULL,
      valor TEXT,
      PRIMARY KEY (key, valor)
    )`.replace(/\bkey VARCHAR/, '"key" VARCHAR').replace('(key, valor)', '("key", valor)'), 't');
    expect(sql).toMatch(/"key" VARCHAR\(100\)/);
    expect(sql).toMatch(/PRIMARY KEY \("key", valor\)/);
  });

  test('ON UPDATE y ENUM', async () => {
    const sql = await tablaDe(`CREATE TABLE t (
      id INT AUTO_INCREMENT PRIMARY KEY,
      estado ENUM('a', 'b') DEFAULT 'a',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`, 't');
    expect(sql).not.toMatch(/ON UPDATE|ENUM/);
  });

  test('lo que no es CREATE TABLE no cambia', () => {
    const consulta = "SELECT 'KEY x (y)' FROM t";
    expect(adaptarCreateTableSqlite(consulta)).toBe(consulta);
  });

  // Los CREATE TABLE reales del código, como texto: ninguno debe fallar en SQLite.
  test('todos los CREATE TABLE sin datos variables del código corren', async () => {
    const SQL = await initSqlJs();
    const archivos = [];
    const recorrer = (carpeta) => {
      for (const e of fs.readdirSync(carpeta, { withFileTypes: true })) {
        if (['node_modules', 'backups', 'vendor'].includes(e.name)) continue;
        const ruta = path.join(carpeta, e.name);
        if (e.isDirectory()) recorrer(ruta);
        else if (e.name.endsWith('.js')) archivos.push(ruta);
      }
    };
    recorrer(path.join(RAIZ, 'server'));
    recorrer(path.join(RAIZ, 'modules'));
    archivos.push(path.join(RAIZ, 'server.js'));

    const fallos = [];
    let revisados = 0;
    for (const archivo of archivos) {
      const texto = fs.readFileSync(archivo, 'utf8');
      for (const m of texto.matchAll(/[`'"]\s*(CREATE TABLE IF NOT EXISTS [^`]*?)\s*[`]/g)) {
        if (m[1].includes('${')) continue;
        revisados += 1;
        const db = new SQL.Database();
        try {
          db.run(adaptarCreateTableSqlite(m[1]));
        } catch (error) {
          fallos.push(`${path.relative(RAIZ, archivo)}: ${m[1].slice(0, 60).replace(/\s+/g, ' ')} → ${error.message}`);
        }
        db.close();
      }
    }
    expect(revisados).toBeGreaterThan(50);
    expect(fallos).toEqual([]);
  });
});
