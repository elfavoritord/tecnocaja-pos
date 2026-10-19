'use strict';

/**
 * Migraciones multisucursal sobre el esquema real en SQLite (monocaja).
 * La misma batería corre en MariaDB real con
 * scripts/multisucursal/probar-migraciones-mariadb.js.
 */

const { crearBaseSqlite } = require('./sqlite-helper');
const { createMigrationRunner } = require('../../server/migrations/runner');
const migraciones = require('../../server/migrations/multisucursal');
const { TABLAS_CON_UUID } = require('../../server/migrations/multisucursal/0001-uuid-entidades');
const { UUID_PATTERN } = require('../../server/multisucursal/identidad');

const silencioso = { log() {}, warn() {}, error() {} };

async function sembrar(query) {
  await query("INSERT INTO branches (id, business_id, nombre, codigo) VALUES (2, 1, 'Sucursal Norte', 'NORTE')");
  await query(`INSERT INTO users (id, usuario, password, nombre, rol, branch_id, sucursal_id)
               VALUES (1, 'admin', '', 'Admin', 'Administrador', NULL, NULL),
                      (2, 'cajera', '', 'Cajera', 'Cajero', 2, 2),
                      (3, 'viejo', '', 'Viejo', 'Cajero', 1, NULL)`);
  for (let i = 1; i <= 5; i += 1) {
    await query(
      "INSERT INTO products (codigo, nombre, categoria, precio_venta, stock) VALUES (?, ?, 'General', 100, 10)",
      [`P${i}`, `Producto ${i}`]
    );
  }
  await query(`INSERT INTO sales (invoice_number, user_id, payment_method, subtotal, tax, total, sale_status, fiscal_status)
               VALUES ('FAC-1', 2, 'efectivo', 100, 0, 100, 'pagada', 'emitida')`);
}

async function columnas(query, tabla) {
  return (await query(`PRAGMA table_info(${tabla})`)).map((r) => r.name);
}

describe('Migraciones multisucursal (SQLite)', () => {
  let base;
  let respaldos;
  let runner;

  beforeEach(async () => {
    base = await crearBaseSqlite();
    await sembrar(base.query);
    respaldos = [];
    runner = createMigrationRunner({
      query: base.query,
      withTransaction: base.withTransaction,
      dialect: 'sqlite',
      migrations: migraciones,
      logger: silencioso,
      beforeApply: async (ids) => { respaldos.push(ids); return true; },
    });
  });

  afterEach(() => base.close());

  test('aplica todas, una sola vez, con un respaldo previo', async () => {
    const primera = await runner.runPending();
    expect(primera.applied.map((m) => m.id)).toEqual(migraciones.map((m) => m.id));
    expect(respaldos).toEqual([migraciones.map((m) => m.id)]);

    const segunda = await runner.runPending();
    expect(segunda.applied).toEqual([]);
    expect(respaldos).toHaveLength(1);

    const estado = await runner.status();
    expect(estado.every((m) => m.aplicada && m.registrada)).toBe(true);
  });

  test('todas las filas existentes quedan con un uuid válido y distinto', async () => {
    await runner.runPending();
    for (const tabla of TABLAS_CON_UUID) {
      const filas = await base.query(`SELECT uuid FROM ${tabla}`);
      for (const fila of filas) expect(fila.uuid).toMatch(UUID_PATTERN);
      expect(new Set(filas.map((f) => f.uuid)).size).toBe(filas.length);
    }
    const productos = await base.query('SELECT uuid FROM products');
    expect(productos).toHaveLength(5);
  });

  test('el índice único rechaza un uuid repetido pero admite varios NULL', async () => {
    await runner.runPending();
    const [{ uuid }] = await base.query('SELECT uuid FROM products LIMIT 1');
    await expect(base.query(
      "INSERT INTO products (codigo, nombre, categoria, uuid) VALUES ('X1', 'Copia', 'General', ?)", [uuid]
    )).rejects.toThrow(/UNIQUE/i);
    await base.query("INSERT INTO products (codigo, nombre, categoria) VALUES ('N1', 'Nuevo 1', 'General')");
    await base.query("INSERT INTO products (codigo, nombre, categoria) VALUES ('N2', 'Nuevo 2', 'General')");
    const sinUuid = await base.query('SELECT COUNT(*) AS n FROM products WHERE uuid IS NULL');
    expect(sinUuid[0].n).toBe(2);
  });

  test('acceso por sucursal: se llena con la sucursal que ya tenía cada usuario', async () => {
    await runner.runPending();
    const filas = await base.query('SELECT user_id, branch_id FROM user_branch_access ORDER BY user_id');
    // admin sin sucursal (global) no tiene fila; cajera → 2 (sucursal_id); viejo → 1 (branch_id).
    expect(filas).toEqual([{ user_id: 2, branch_id: 2 }, { user_id: 3, branch_id: 1 }]);
  });

  test('reutiliza la user_branch_access que ya crea ensureWizardExtensions', async () => {
    // Como la deja server.js (sin índice único) con una fila vieja repetida.
    await base.query(`CREATE TABLE IF NOT EXISTS user_branch_access (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      branch_id INTEGER NOT NULL, access_type VARCHAR(30) DEFAULT 'operador', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await base.query("INSERT INTO user_branch_access (user_id, branch_id, access_type) VALUES (2, 1, 'supervisor'), (2, 1, 'supervisor')");

    await runner.runPending();

    const filas = await base.query('SELECT user_id, branch_id, access_type, estado, origen FROM user_branch_access ORDER BY user_id, branch_id');
    expect(filas).toEqual([
      { user_id: 2, branch_id: 1, access_type: 'supervisor', estado: 'Activo', origen: 'local' },
      { user_id: 2, branch_id: 2, access_type: 'principal', estado: 'Activo', origen: 'migracion' },
      { user_id: 3, branch_id: 1, access_type: 'principal', estado: 'Activo', origen: 'migracion' },
    ]);
    await expect(base.query('INSERT INTO user_branch_access (user_id, branch_id) VALUES (2, 1)')).rejects.toThrow(/UNIQUE/i);

    // Revertir conserva la fila que ya existía.
    await runner.revert('ms-0004-catalogo-y-sincronizacion');
    await runner.revert('ms-0003-acceso-sucursales');
    const quedan = await base.query('SELECT user_id, branch_id, access_type FROM user_branch_access');
    expect(quedan).toEqual([{ user_id: 2, branch_id: 1, access_type: 'supervisor' }]);
  });

  test('crea las bandejas de salida, entrada y cursores', async () => {
    await runner.runPending();
    expect(await columnas(base.query, 'sync_outbox')).toEqual(expect.arrayContaining([
      'event_id', 'company_uuid', 'branch_uuid', 'entity_type', 'entity_uuid', 'operation',
      'entity_version', 'payload', 'created_at_utc', 'status', 'attempts', 'next_attempt_at_utc',
      'last_error', 'acked_at_utc',
    ]));
    expect(await columnas(base.query, 'sync_inbox')).toEqual(expect.arrayContaining(['event_id', 'status', 'received_at_utc']));
    expect(await columnas(base.query, 'sync_cursors')).toEqual(['stream', 'cursor_value', 'updated_at_utc']);
  });

  test('ms-0004: catálogo, usuarios por sucursal, conflictos, bitácora y rangos NCF', async () => {
    await runner.runPending();
    expect(await columnas(base.query, 'products')).toEqual(expect.arrayContaining([
      'alcance_empresa', 'sucursales_empresa', 'origen_catalogo', 'catalogo_version', 'catalogo_hash', 'sucursal_marca',
    ]));
    expect(await columnas(base.query, 'users')).toEqual(expect.arrayContaining(['sucursales_empresa', 'origen_usuario', 'usuario_version', 'usuario_hash']));
    expect(await columnas(base.query, 'sales')).toContain('sync_marca');
    const [p] = await base.query('SELECT alcance_empresa, origen_catalogo, catalogo_version FROM products LIMIT 1');
    expect(p).toEqual({ alcance_empresa: 'local', origen_catalogo: 'local', catalogo_version: 0 });

    // Un rango NCF asignado no se suelta al revertir.
    await base.query(`INSERT INTO ncf_rangos_central (rango_uuid, tipo, desde, hasta, estado, recibido_at_utc)
                      VALUES ('r1', 'B02', 1, 100, 'en_uso', '2026-10-19T00:00:00.000Z')`);
    await expect(runner.revert('ms-0004-catalogo-y-sincronizacion')).rejects.toThrow(/rango/);
    await base.query("UPDATE ncf_rangos_central SET estado = 'agotado'");
    await runner.revert('ms-0004-catalogo-y-sincronizacion');
    expect(await columnas(base.query, 'products')).not.toContain('alcance_empresa');
  });

  test('si el respaldo previo falla, no migra y la base queda igual', async () => {
    const sinRespaldo = createMigrationRunner({
      query: base.query,
      withTransaction: base.withTransaction,
      dialect: 'sqlite',
      migrations: migraciones,
      logger: silencioso,
      beforeApply: async () => false,
    });
    const r = await sinRespaldo.runPending();
    expect(r.skipped).toBe(true);
    expect(await columnas(base.query, 'products')).not.toContain('uuid');
  });

  test('clave registrada sin esquema (copiada por el migrador) se vuelve a aplicar', async () => {
    await base.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_key VARCHAR(120) PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await base.query("INSERT INTO schema_migrations (migration_key) VALUES ('ms-0001-uuid-entidades')");
    const r = await runner.runPending();
    expect(r.applied.map((m) => m.id)).toContain('ms-0001-uuid-entidades');
    expect(await columnas(base.query, 'products')).toContain('uuid');
  });

  test('una migración que falla en SQLite no deja nada a medias', async () => {
    const rota = {
      id: 'ms-9999-rota',
      async up(ctx) {
        await ctx.query('CREATE TABLE prueba_rota (id INTEGER)');
        throw new Error('falla a propósito');
      },
    };
    const conRota = createMigrationRunner({
      query: base.query,
      withTransaction: base.withTransaction,
      dialect: 'sqlite',
      migrations: [...migraciones, rota],
      logger: silencioso,
    });
    await expect(conRota.runPending()).rejects.toThrow('falla a propósito');
    const tablas = await base.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('prueba_rota', 'sync_outbox')");
    expect(tablas).toEqual([]);
    expect(await columnas(base.query, 'products')).not.toContain('uuid');
  });

  test('revertir: de la última hacia atrás y deja el esquema como estaba', async () => {
    const antes = await columnas(base.query, 'products');
    await runner.runPending();
    await expect(runner.revert('ms-0001-uuid-entidades')).rejects.toThrow(/Primero revierte/);

    await runner.revert('ms-0004-catalogo-y-sincronizacion');
    await runner.revert('ms-0003-acceso-sucursales');
    await runner.revert('ms-0002-tablas-sincronizacion');
    await runner.revert('ms-0001-uuid-entidades');

    expect(await columnas(base.query, 'products')).toEqual(antes);
    const tablas = await base.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sync_outbox', 'sync_inbox', 'sync_cursors')"
    );
    expect(tablas).toEqual([]);
    // user_branch_access no es de esta migración (ensureWizardExtensions): se
    // queda, sin lo que se le agregó ni las filas que se le insertaron.
    expect(await columnas(base.query, 'user_branch_access')).toEqual(['id', 'user_id', 'branch_id', 'access_type', 'created_at']);
    expect((await base.query('SELECT COUNT(*) AS n FROM user_branch_access'))[0].n).toBe(0);
    const productos = await base.query('SELECT COUNT(*) AS n FROM products');
    expect(productos[0].n).toBe(5);

    // Y se puede volver a aplicar.
    const r = await runner.runPending();
    expect(r.applied).toHaveLength(migraciones.length);
  });

  test('no se revierte la bandeja de salida con eventos sin confirmar', async () => {
    await runner.runPending();
    await base.query(`INSERT INTO sync_outbox (event_id, entity_type, entity_uuid, operation, payload, created_at_utc)
                      VALUES ('e1', 'venta', 'u1', 'crear', '{}', '2026-10-18T00:00:00.000Z')`);
    await runner.revert('ms-0004-catalogo-y-sincronizacion');
    await runner.revert('ms-0003-acceso-sucursales');
    await expect(runner.revert('ms-0002-tablas-sincronizacion')).rejects.toThrow(/sin confirmar/);
    const tablas = await base.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_outbox'");
    expect(tablas).toHaveLength(1);
  });
});
