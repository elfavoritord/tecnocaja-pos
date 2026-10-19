'use strict';

/**
 * Prueba las migraciones multisucursal contra MariaDB REAL (el mismo
 * mariadbd que trae el instalador), en una carpeta temporal. No toca la base,
 * el .env ni el userData reales.
 *
 *   node scripts/multisucursal/probar-migraciones-mariadb.js
 *
 * Qué comprueba:
 *  1. Aplicar las migraciones sobre db/schema.sql con datos: uuid en todas
 *     las filas, índices únicos, bandejas y acceso por sucursal.
 *  2. Dos servidores migrando la misma base a la vez (principal + terminal):
 *     GET_LOCK hace que cada migración se aplique una sola vez y sin errores.
 *  3. Bandejas en MariaDB: transacción revertida, INSERT IGNORE de entrada.
 *  4. Revertir todo y volver a aplicar.
 *  5. Migrador SQLite→MySQL (paso a multicaja): conserva los uuid del SQLite,
 *     incluida la sucursal 1 que la MySQL ya traía sembrada.
 *  6. Ciclo de sincronización (sincronizacion.js) sobre MariaDB con una
 *     central simulada: el SQL propio de MariaDB (CONCAT) detecta ventas y
 *     productos, sube, aplica lo que baja y no repite.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-ms-mariadb');
process.env.TC_E2E_DB_PORT = process.env.TC_E2E_DB_PORT || '3419';

const lib = require('../e2e-lan/lib');
const mysql = require('mysql2/promise');
const initSqlJs = require('sql.js');
const { createMigrationRunner } = require('../../server/migrations/runner');
const migraciones = require('../../server/migrations/multisucursal');
const { TABLAS_CON_UUID } = require('../../server/migrations/multisucursal/0001-uuid-entidades');
const { createBandejas } = require('../../server/multisucursal/bandejas');
const { UUID_PATTERN } = require('../../server/multisucursal/identidad');
const { normalizeSchema } = require('../auto-init-db');
const { runMigration } = require('../lib/sqlite-to-mysql-migrator');

const PROJECT = lib.PROJECT;
const silencioso = { log() {}, warn() {}, error() {} };

// db/schema.sql trae BOM, CREATE DATABASE y USE tecnocaja al inicio: se quitan
// para crear las tablas en la base de prueba (igual que scripts/auto-init-db.js).
function schemaMysql() {
  let sql = fs.readFileSync(path.join(PROJECT, 'db', 'schema.sql'), 'utf8');
  if (sql.charCodeAt(0) === 0xfeff) sql = sql.slice(1); // BOM
  sql = sql.replace(/CREATE DATABASE IF NOT EXISTS[^;]*;/gi, '').replace(/^\s*USE [^;]*;/gim, '');
  sql = sql.replace(/DROP\s+TABLE\s+(IF\s+EXISTS\s+)?[^;]+;/gi, '');
  return sql.replace(/CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\s)/gi, 'CREATE TABLE IF NOT EXISTS ');
}

async function crearBase(nombre) {
  await lib.mysqlRoot(`DROP DATABASE IF EXISTS ${nombre}; CREATE DATABASE ${nombre} CHARACTER SET utf8mb4;`);
  const conn = await mysql.createConnection({
    host: '127.0.0.1', port: lib.DB_PORT, user: 'root', password: '', database: nombre, multipleStatements: true,
  });
  await conn.query(schemaMysql());
  await conn.end();
}

// Mismo contrato que db.js (query/withTransaction) sobre un pool propio.
function adaptador(nombre) {
  const pool = mysql.createPool({
    host: '127.0.0.1', port: lib.DB_PORT, user: 'root', password: '', database: nombre, connectionLimit: 4,
  });
  const forma = ([rows]) => (Array.isArray(rows) ? rows : { affectedRows: rows.affectedRows, insertId: rows.insertId });
  const query = (sql, params = []) => pool.query(sql, params).then(forma);
  async function withTransaction(work) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const q = (sql, params = []) => conn.query(sql, params).then(forma);
      const r = await work({ query: q, run: q });
      await conn.commit();
      return r;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }
  return { query, withTransaction, end: () => pool.end() };
}

async function sembrar(query) {
  await query("INSERT INTO branches (id, business_id, nombre, codigo) VALUES (2, 1, 'Sucursal Norte', 'NORTE')");
  await query(`INSERT INTO users (id, usuario, password, nombre, rol, branch_id, sucursal_id)
               VALUES (1, 'admin', '', 'Admin', 'Administrador', NULL, NULL),
                      (2, 'cajera', '', 'Cajera', 'Cajero', 2, 2)`);
  for (let i = 1; i <= 50; i += 1) {
    await query("INSERT INTO products (codigo, nombre, categoria, precio_venta, stock) VALUES (?, ?, 'General', 100, 10)", [`P${i}`, `Producto ${i}`]);
  }
}

const runner = (db, extra = {}) => createMigrationRunner({
  query: db.query, withTransaction: db.withTransaction, dialect: 'mysql', migrations: migraciones, logger: silencioso, ...extra,
});

// Como la deja ensureWizardExtensions (server.js) antes de estas migraciones.
async function tablaAccesoExistente(query) {
  await query(`CREATE TABLE IF NOT EXISTS user_branch_access (id INT AUTO_INCREMENT PRIMARY KEY, user_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL, access_type VARCHAR(30) DEFAULT 'operador', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
}

async function prueba1Aplicar() {
  await crearBase('tc_ms_1');
  const db = adaptador('tc_ms_1');
  try {
    await sembrar(db.query);
    await tablaAccesoExistente(db.query);
    const r = await runner(db).runPending();
    lib.check(`MariaDB: aplica las ${migraciones.length} migraciones`, r.applied.length === migraciones.length, r.applied.map((m) => m.id).join(', '));

    let todosConUuid = true;
    for (const tabla of TABLAS_CON_UUID) {
      const filas = await db.query(`SELECT uuid FROM ${tabla}`);
      const validos = filas.every((f) => UUID_PATTERN.test(f.uuid || ''));
      const unicos = new Set(filas.map((f) => f.uuid)).size === filas.length;
      if (!validos || !unicos) { todosConUuid = false; lib.check(`  uuid en ${tabla}`, false); }
    }
    lib.check('MariaDB: todas las filas con uuid válido y único', todosConUuid);

    let rechazaRepetido = false;
    const [{ uuid }] = await db.query('SELECT uuid FROM products LIMIT 1');
    try { await db.query("INSERT INTO products (codigo, nombre, categoria, uuid) VALUES ('X', 'X', 'G', ?)", [uuid]); } catch (e) { rechazaRepetido = /Duplicate/i.test(e.message); }
    lib.check('MariaDB: índice único rechaza uuid repetido', rechazaRepetido);

    const acceso = await db.query('SELECT user_id, branch_id FROM user_branch_access ORDER BY user_id');
    lib.check('MariaDB: acceso por sucursal llenado', acceso.length === 1 && acceso[0].user_id === 2 && acceso[0].branch_id === 2, JSON.stringify(acceso));

    const otra = await runner(db).runPending();
    lib.check('MariaDB: segunda corrida no aplica nada', otra.applied.length === 0);

    // Bandejas
    const bandejas = createBandejas({ dialect: 'mysql' });
    try {
      await db.withTransaction(async (conn) => {
        await bandejas.registrarSalida(conn, { entityType: 'venta', entityUuid: uuid, operation: 'crear', payload: { a: 1 } });
        throw new Error('revertir');
      });
    } catch (_) { /* esperado */ }
    lib.check('MariaDB: evento de transacción revertida no queda', (await bandejas.pendientes(db.query)).length === 0);
    const id = await db.withTransaction((conn) => bandejas.registrarSalida(conn, { entityType: 'venta', entityUuid: uuid, operation: 'crear', payload: { a: 2 } }));
    await bandejas.marcarError(db.query, id, 'red');
    const conError = await db.query('SELECT status, attempts, next_attempt_at_utc FROM sync_outbox WHERE event_id = ?', [id]);
    lib.check('MariaDB: error queda con reintento programado', conError[0].status === 'error' && conError[0].attempts === 1 && Boolean(conError[0].next_attempt_at_utc));
    const evento = { eventId: '33333333-3333-4333-8333-333333333333', companyUuid: '11111111-1111-4111-8111-111111111111', entityType: 'producto', entityUuid: uuid, version: 1 };
    const a = await bandejas.registrarEntrada(db.query, evento);
    const b = await bandejas.registrarEntrada(db.query, evento);
    lib.check('MariaDB: entrada idempotente (nuevo, duplicado)', a === 'nuevo' && b === 'duplicado', `${a}, ${b}`);
    await bandejas.guardarCursor(db.query, 'catalogo', 'v1');
    await bandejas.guardarCursor(db.query, 'catalogo', 'v2');
    lib.check('MariaDB: cursor guardado', (await bandejas.leerCursor(db.query, 'catalogo')) === 'v2');
    await bandejas.confirmar(db.query, [id]);

    // Revertir todo y volver a aplicar
    const r1 = runner(db);
    await r1.revert('ms-0004-catalogo-y-sincronizacion');
    await r1.revert('ms-0003-acceso-sucursales');
    await r1.revert('ms-0002-tablas-sincronizacion');
    await r1.revert('ms-0001-uuid-entidades');
    const cols = await db.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND column_name = 'uuid'");
    const tablas = await db.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('sync_outbox','sync_inbox','sync_cursors')");
    const accesoCols = await db.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'user_branch_access' AND column_name IN ('estado','origen','updated_at')");
    const productos = await db.query('SELECT COUNT(*) AS n FROM products');
    lib.check(
      'MariaDB: revertir deja el esquema original y los datos',
      Number(cols[0].n) === 0 && Number(tablas[0].n) === 0 && Number(accesoCols[0].n) === 0 && Number(productos[0].n) === 50
    );
    const otraVez = await r1.runPending();
    lib.check('MariaDB: se vuelve a aplicar después de revertir', otraVez.applied.length === migraciones.length);
  } finally {
    await db.end();
  }
}

async function prueba2Concurrencia() {
  await crearBase('tc_ms_2');
  const principal = adaptador('tc_ms_2');
  const terminal = adaptador('tc_ms_2');
  try {
    await sembrar(principal.query);
    await tablaAccesoExistente(principal.query);
    const [a, b] = await Promise.all([runner(principal).runPending(), runner(terminal).runPending()]);
    const total = a.applied.length + b.applied.length;
    const claves = await principal.query("SELECT migration_key FROM schema_migrations WHERE migration_key LIKE 'ms-%'");
    lib.check('MariaDB: dos servidores a la vez → cada migración una sola vez', total === migraciones.length && claves.length === migraciones.length, `principal ${a.applied.length}, terminal ${b.applied.length}`);
  } finally {
    await principal.end();
    await terminal.end();
  }
}

async function prueba3Migrador() {
  // SQLite de origen con las migraciones ya aplicadas (como queda una PC monocaja).
  const SQL = await initSqlJs();
  const sqlite = new SQL.Database();
  const schema = normalizeSchema(fs.readFileSync(path.join(PROJECT, 'db', 'schema.sql'), 'utf8'));
  for (const st of schema.split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) sqlite.run(st);
  const q = async (sql, params = []) => {
    const stmt = sqlite.prepare(sql);
    stmt.bind(params);
    if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) { const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); stmt.free(); return rows; }
    stmt.run(); stmt.free(); return { affectedRows: sqlite.getRowsModified() };
  };
  await sembrar(q);
  await createMigrationRunner({ query: q, dialect: 'sqlite', migrations: migraciones, logger: silencioso }).runPending();
  await q(`INSERT INTO sync_outbox (event_id, entity_type, entity_uuid, operation, payload, created_at_utc)
           VALUES ('ev-1', 'venta', 'u-1', 'crear', '{}', '2026-10-18T00:00:00.000Z')`);
  const uuidsOrigen = Object.fromEntries((await q('SELECT id, uuid FROM branches')).map((r) => [r.id, r.uuid]));
  const productoOrigen = (await q('SELECT uuid FROM products WHERE codigo = ?', ['P7']))[0].uuid;
  const archivo = path.join(process.env.TC_E2E_DIR, 'origen.db');
  fs.writeFileSync(archivo, Buffer.from(sqlite.export()));
  sqlite.close();

  // Como en producción: el servidor ya arrancó en MySQL (esquema + migraciones
  // con relleno, así la sucursal 1 sembrada tiene OTRO uuid) y después
  // electron/main.js corre el migrador.
  await crearBase('tc_ms_3');
  const servidor = adaptador('tc_ms_3');
  await runner(servidor).runPending();
  await servidor.end();
  const resultado = await runMigration({
    sqlitePath: archivo,
    forceIdentity: true,
    mysqlConfig: { host: '127.0.0.1', port: lib.DB_PORT, user: 'root', password: '', database: 'tc_ms_3' },
  });
  lib.check('Migrador: SQLite → MySQL completo', resultado.ok, JSON.stringify((resultado.summary.missing || []).concat(resultado.summary.errors || [])));

  const db = adaptador('tc_ms_3');
  try {
    const sucursales = Object.fromEntries((await db.query('SELECT id, uuid FROM branches')).map((r) => [r.id, r.uuid]));
    lib.check('Migrador: conserva el uuid de la sucursal 1 sembrada', sucursales[1] === uuidsOrigen[1], `${sucursales[1]} vs ${uuidsOrigen[1]}`);
    lib.check('Migrador: conserva el uuid de la sucursal 2', sucursales[2] === uuidsOrigen[2]);
    const producto = (await db.query('SELECT uuid FROM products WHERE codigo = ?', ['P7']))[0];
    lib.check('Migrador: conserva el uuid de los productos', producto && producto.uuid === productoOrigen);
    const outbox = await db.query('SELECT event_id FROM sync_outbox');
    lib.check('Migrador: copia la bandeja de salida', outbox.length === 1 && outbox[0].event_id === 'ev-1');
    const estado = await runner(db).status();
    lib.check('Migrador: el servidor ve las migraciones aplicadas', estado.every((m) => m.aplicada), JSON.stringify(estado.map((m) => [m.id, m.aplicada])));
  } finally {
    await db.end();
  }
}

async function prueba4Sincronizacion() {
  const { createIdentidad } = require('../../server/multisucursal/identidad');
  const { createNcfCentral } = require('../../server/multisucursal/ncf-central');
  const { createSincronizacion } = require('../../server/multisucursal/sincronizacion');
  await crearBase('tc_ms_4');
  const db = adaptador('tc_ms_4');
  try {
    await sembrar(db.query);
    await runner(db).runPending();
    await db.query(`INSERT INTO sales (invoice_number, user_id, payment_method, subtotal, tax, total, sale_status, fiscal_status, created_at)
                    VALUES ('FAC-9', 1, 'efectivo', 100, 0, 100, 'pagada', 'emitida', NOW())`);
    await db.query("UPDATE products SET alcance_empresa = 'global' WHERE codigo = 'P1'");

    // Central simulada: acepta todo y manda un producto del catálogo de la empresa.
    const recibidos = [];
    const productoCentral = {
      uuid: '99999999-9999-4999-8999-999999999999', seq: 1, version: 1, asignado: true,
      datos: { codigo: 'C-1', barcode: 'C-1', nombre: 'Producto de la central', categoria: 'General', unidad: 'Unidad', saleMode: 'unidad', productType: 'general', aplicaItbis: false, itbisModo: 'porcentaje', itbisMonto: 0, tracksStock: true, estado: 'Activo', precioSugerido: 75, costoSugerido: 50 },
    };
    const enlace = {
      estado: async () => ({ vinculado: true, tieneToken: true, sucursal: { esPrincipal: true } }),
      llamarSync: async (method, ruta, body) => {
        if (ruta === '/v1/eventos') {
          recibidos.push(...body.eventos);
          return { resultados: body.eventos.map((e) => ({ eventId: e.eventId, resultado: 'ok' })) };
        }
        const desde = Number(/desde=(\d+)/.exec(ruta)[1]);
        return ruta.includes('tipo=catalogo') && desde < 1 ? { items: [productoCentral], siguiente: 1, hayMas: false } : { items: [], siguiente: desde, hayMas: false };
      },
    };
    const identidad = createIdentidad({ query: db.query, dialect: 'mysql' });
    const bandejas = createBandejas({ dialect: 'mysql' });
    const ncf = createNcfCentral({ query: db.query, withTransaction: db.withTransaction, bandejas, identidad, logger: silencioso });
    const sync = createSincronizacion({ query: db.query, withTransaction: db.withTransaction, dialect: 'mysql', identidad, bandejas, enlace, ncf, logger: silencioso });

    const c1 = await sync.ciclo();
    const tipos = recibidos.reduce((a, e) => ({ ...a, [e.entityType]: (a[e.entityType] || 0) + 1 }), {});
    lib.check('MariaDB sync: detecta venta, productos y catálogo publicado con su SQL (CONCAT)', c1.resultado === 'ok' && tipos.venta === 1 && tipos.producto_sucursal === 50 && tipos.producto === 1,
      JSON.stringify({ r: c1.resultado, tipos, error: c1.detalles }));
    const [central] = await db.query("SELECT precio_venta, stock, origen_catalogo, uuid FROM products WHERE codigo = 'C-1'");
    lib.check('MariaDB sync: aplica el producto de la central (precio sugerido, existencia 0)', central && Number(central.precio_venta) === 75 && Number(central.stock) === 0 && central.origen_catalogo === 'central');
    const antes = recibidos.length;
    const c2 = await sync.ciclo();
    lib.check('MariaDB sync: el segundo ciclo solo sube el producto que llegó (nada repetido)', c2.resultado === 'ok' && recibidos.length - antes === 1 && recibidos[recibidos.length - 1].entityType === 'producto_sucursal',
      `${recibidos.length - antes} evento(s)`);
    await db.query("UPDATE sales SET sale_status = 'anulada', canceled_at = NOW() WHERE invoice_number = 'FAC-9'");
    await sync.ciclo();
    const ultima = recibidos[recibidos.length - 1];
    lib.check('MariaDB sync: una venta anulada vuelve a subir con su estado', ultima.entityType === 'venta' && ultima.payload.anulada === true && ultima.payload.estado === 'anulada');
    const bitacora = await db.query('SELECT COUNT(*) AS n FROM sync_bitacora');
    lib.check('MariaDB sync: cada ciclo queda en sync_bitacora', Number(bitacora[0].n) === 3);
  } finally {
    await db.end();
  }
}

(async () => {
  fs.mkdirSync(process.env.TC_E2E_DIR, { recursive: true });
  await lib.startMariaDb({ fresh: true });
  try {
    await prueba1Aplicar();
    await prueba2Concurrencia();
    await prueba3Migrador();
    await prueba4Sincronizacion();
  } catch (error) {
    lib.check('Sin excepciones', false, error.stack);
  } finally {
    await lib.stopMariaDb();
  }
  const fallas = lib.results.filter((r) => !r.ok);
  console.log(`\n${lib.results.length - fallas.length}/${lib.results.length} comprobaciones OK`);
  process.exit(fallas.length ? 1 : 0);
})();
