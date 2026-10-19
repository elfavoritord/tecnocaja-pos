'use strict';

const { crearBaseSqlite } = require('./sqlite-helper');
const { createMigrationRunner } = require('../../server/migrations/runner');
const migraciones = require('../../server/migrations/multisucursal');
const { createIdentidad, UUID_PATTERN } = require('../../server/multisucursal/identidad');
const { createAccesoSucursales } = require('../../server/multisucursal/acceso-sucursales');

async function baseMigrada() {
  const base = await crearBaseSqlite();
  await base.query("INSERT INTO branches (id, business_id, nombre, codigo) VALUES (2, 1, 'Sucursal Norte', 'NORTE')");
  // db/schema.sql ya siembra config id 1.
  await base.query("UPDATE config SET business_id = 1, active_branch_id = 2, business_structure_mode = 'monocaja' WHERE id = 1");
  await createMigrationRunner({
    query: base.query, withTransaction: base.withTransaction, dialect: 'sqlite',
    migrations: migraciones, logger: { log() {} },
  }).runPending();
  return base;
}

describe('Identidad de la base', () => {
  let base;
  beforeEach(async () => { base = await baseMigrada(); });
  afterEach(() => base.close());

  test('empresa y sucursal con uuid estable entre llamadas', async () => {
    const identidad = createIdentidad({ query: base.query, getServerId: () => 'srv_0123456789abcdef' });
    const a = await identidad.obtener();
    expect(a.empresa.id).toBe(1);
    expect(a.sucursal.id).toBe(2);
    expect(a.empresa.uuid).toMatch(UUID_PATTERN);
    expect(a.sucursal.uuid).toMatch(UUID_PATTERN);
    expect(a.nodo).toBe('srv_0123456789abcdef');
    const b = await identidad.obtener();
    expect(b.empresa.uuid).toBe(a.empresa.uuid);
    expect(b.sucursal.uuid).toBe(a.sucursal.uuid);
  });

  test('la sucursal de la terminal manda sobre la de config', async () => {
    const identidad = createIdentidad({ query: base.query, getBranchIdOverride: () => 1 });
    expect((await identidad.obtener()).sucursal.id).toBe(1);
  });

  test('asegurarUuid asigna una sola vez a filas creadas por el código actual', async () => {
    const identidad = createIdentidad({ query: base.query });
    const r = await base.query("INSERT INTO products (codigo, nombre, categoria) VALUES ('Z1', 'Nuevo', 'General')");
    const [uno, dos] = await Promise.all([
      identidad.asegurarUuid(base.query, 'products', r.insertId),
      identidad.asegurarUuid(base.query, 'products', r.insertId),
    ]);
    expect(uno).toMatch(UUID_PATTERN);
    expect(dos).toBe(uno);
  });

  test('rellenarUuidsFaltantes completa las filas nuevas y no toca las que ya tienen', async () => {
    const identidad = createIdentidad({ query: base.query });
    const [{ uuid: antes }] = await base.query('SELECT uuid FROM branches WHERE id = 2');
    await base.query("INSERT INTO products (codigo, nombre, categoria) VALUES ('Z2', 'Otro', 'General')");
    const r = await identidad.rellenarUuidsFaltantes();
    expect(r.products).toBe(1);
    const faltan = await base.query('SELECT COUNT(*) AS n FROM products WHERE uuid IS NULL');
    expect(faltan[0].n).toBe(0);
    const [{ uuid: despues }] = await base.query('SELECT uuid FROM branches WHERE id = 2');
    expect(despues).toBe(antes);
  });

  test('solo acepta tablas que llevan uuid', async () => {
    const identidad = createIdentidad({ query: base.query });
    await expect(identidad.asegurarUuid(base.query, 'config', 1)).rejects.toThrow(/no lleva uuid/);
  });
});

describe('Acceso de usuarios a sucursales', () => {
  let base;
  let acceso;
  beforeEach(async () => {
    base = await baseMigrada();
    await base.query("INSERT INTO branches (id, business_id, nombre, codigo) VALUES (3, 1, 'Sucursal Sur', 'SUR')");
    await base.query(`INSERT INTO users (id, usuario, password, nombre, rol, branch_id, sucursal_id)
                      VALUES (10, 'cajera', '', 'Cajera', 'Cajero', 2, 2),
                             (11, 'dueno', '', 'Dueño', 'Administrador', NULL, NULL)`);
    acceso = createAccesoSucursales({ query: base.query, esAdministradorGeneral: (u) => u.rol === 'Administrador' });
  });
  afterEach(() => base.close());

  test('un usuario asignado a una sola sucursal no entra a otra', async () => {
    const cajera = (await base.query('SELECT * FROM users WHERE id = 10'))[0];
    expect(await acceso.puedeEntrarASucursal(cajera, 2)).toBe(true);
    expect(await acceso.puedeEntrarASucursal(cajera, 3)).toBe(false);
  });

  test('se le puede dar una segunda sucursal y luego revocarla', async () => {
    const cajera = (await base.query('SELECT * FROM users WHERE id = 10'))[0];
    await acceso.asignar(10, 3);
    expect((await acceso.sucursalesDelUsuario(cajera)).ids).toEqual([2, 3]);
    expect(await acceso.revocar(10, 3)).toBe(true);
    expect(await acceso.puedeEntrarASucursal(cajera, 3)).toBe(false);
    const fila = await base.query('SELECT estado FROM user_branch_access WHERE user_id = 10 AND branch_id = 3');
    expect(fila[0].estado).toBe('Revocado');
  });

  test('la sucursal principal no se revoca desde aquí', async () => {
    await expect(acceso.revocar(10, 2)).rejects.toThrow(/principal/);
  });

  test('el administrador general entra a todas', async () => {
    const dueno = (await base.query('SELECT * FROM users WHERE id = 11'))[0];
    expect(await acceso.sucursalesDelUsuario(dueno)).toEqual({ todas: true, ids: [] });
    expect(await acceso.puedeEntrarASucursal(dueno, 3)).toBe(true);
  });
});
