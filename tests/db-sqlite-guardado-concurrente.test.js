'use strict';

/**
 * db.js en SQLite guarda el archivo con escritura atómica a
 * `<db>.tmp-<pid>`. Dos guardados a la vez (el de una transacción y el
 * diferido de una consulta suelta) usaban el MISMO temporal: el primero lo
 * renombraba y el segundo fallaba con ENOENT. La venta quedaba confirmada en
 * memoria pero el cajero recibía un error 500 (pasó en la prueba de arranque
 * SQLite de la Fase 2 multisucursal).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-db-guardado-'));
process.env.TECNO_CAJA_USER_DATA = userData;
process.env.DB_CLIENT = 'sqlite';
process.env.DB_FILE = path.join(userData, 'data', 'tecnocaja.db');
process.env.TECNO_CAJA_DB_PLAINTEXT = '1';

const db = require('../db');

afterAll(async () => {
  await db.flushPendingSave();
  fs.rmSync(userData, { recursive: true, force: true });
});

test('transacciones y consultas sueltas a la vez no rompen el guardado', async () => {
  await db.query('CREATE TABLE IF NOT EXISTS prueba_guardado (id INTEGER PRIMARY KEY AUTOINCREMENT, valor TEXT)');
  // Como en el servidor: una transacción a la vez (la venta) mientras otras
  // partes hacen escrituras sueltas cuyo guardado diferido cae encima.
  const fallas = [];
  const sueltas = [];
  for (let i = 0; i < 40; i += 1) {
    sueltas.push(db.query('INSERT INTO prueba_guardado (valor) VALUES (?)', [`suelta-${i}`]).catch((e) => fallas.push(e.message)));
    await new Promise((r) => setTimeout(r, 70 + (i % 5) * 5));
    await db.withTransaction(async (conn) => {
      await conn.query('INSERT INTO prueba_guardado (valor) VALUES (?)', [`tx-${i}`]);
    }).catch((e) => fallas.push(e.message));
  }
  await Promise.all(sueltas);
  expect(fallas).toEqual([]);

  await db.flushPendingSave();
  const filas = await db.query('SELECT COUNT(*) AS n FROM prueba_guardado');
  expect(Number(filas[0].n)).toBe(80);
  const temporales = fs.readdirSync(path.dirname(process.env.DB_FILE)).filter((n) => n.includes('.tmp-'));
  expect(temporales).toEqual([]);
}, 30000);
