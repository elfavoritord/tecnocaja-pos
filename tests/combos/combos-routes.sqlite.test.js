'use strict';

/**
 * Combos promocionales sobre la base SQLite real del POS (db/schema.sql), con
 * el router de verdad (server/routes/combos.routes.js).
 */

const express = require('express');
const request = require('supertest');
const { createSqlitePos } = require('../helpers/sqlite-pos');
const createCombosRouter = require('../../server/routes/combos.routes');
const combos = require('../../server/services/combos.service');

let pos;
let app;
let actor;
const auditoria = [];
const cambios = [];

async function unico(columna, valor, ignoreId, conn) {
  const run = conn?.query ? conn.query.bind(conn) : pos.query;
  const rows = await run(
    `SELECT id FROM products WHERE LOWER(${columna}) = LOWER(?)${ignoreId ? ' AND id <> ?' : ''} LIMIT 1`,
    ignoreId ? [valor, ignoreId] : [valor]
  );
  if (rows.length) throw Object.assign(new Error(`Ya existe un producto con ese ${columna}.`), { statusCode: 409 });
}

async function producto(codigo, nombre, { precio, costo, stock, itbis = 1 }) {
  const r = await pos.query(
    `INSERT INTO products (codigo, barcode, nombre, categoria, precio_compra, precio_venta, stock, aplica_itbis, tracks_stock)
     VALUES (?, ?, ?, 'General', ?, ?, ?, ?, 1)`,
    [codigo, codigo, nombre, costo, precio, stock, itbis]
  );
  return Number(r.insertId);
}

let pollo;
let refresco;
let papas;

beforeAll(async () => {
  pos = await createSqlitePos();
  await pos.addColumnIfMissing('products', 'barcode', 'VARCHAR(80) DEFAULT NULL');
  actor = { id: 1, nombre: 'Admin', role_code: 'administrador_general', permisos: ['promociones'] };
  app = express();
  app.use(express.json());
  app.use('/api/combos', createCombosRouter({
    query: pos.query,
    withTransaction: pos.withTransaction,
    addColumnIfMissing: pos.addColumnIfMissing,
    resolveRequestActorUser: async () => actor,
    userRoleHasPermission: (user, perm) => (user.permisos || []).includes(perm),
    isGlobalAdministratorUser: (user) => user.role_code === 'administrador_general',
    getProductCatalogBranchScope: () => null,
    resolveStockBranchId: async () => null,
    ensureUniqueProductCode: (codigo, ignoreId, conn) => unico('codigo', codigo, ignoreId, conn),
    ensureUniqueProductBarcode: (codigo, ignoreId, conn) => unico('barcode', codigo, ignoreId, conn),
    ensureUniqueProductName: (nombre, ignoreId, conn) => unico('nombre', nombre, ignoreId, conn),
    saveProductImageBuffer: async ({ productId }) => ({ imageLocal: `/uploads/products/combo-${productId}.webp` }),
    decodeDataUrlImage: (data) => Buffer.from(String(data)),
    removeLocalProductImage: async () => {},
    writeAuditLog: async (entry) => { auditoria.push(entry); },
    afterCombosChanged: async (ids, opts) => { cambios.push({ ids, ...opts }); },
  }));
  pollo = await producto('POL', 'Pollo', { precio: 400, costo: 250, stock: 10, itbis: 0 });
  refresco = await producto('REF', 'Refresco', { precio: 100, costo: 60, stock: 7 });
  papas = await producto('PAP', 'Papas', { precio: 150, costo: 80, stock: 50 });
});

afterAll(() => pos?.close());

const familiar = () => ({
  nombre: 'Combo Familiar',
  codigo: 'COMBO-FAM',
  descripcion: 'Para compartir',
  precio: 600,
  componentes: [{ id: pollo, cantidad: 1 }, { id: refresco, cantidad: 2 }, { id: papas, cantidad: 1 }],
});

describe('crear combos', () => {
  let comboId;

  test('se guarda con sus 3 productos sin duplicar productos de inventario', async () => {
    const antes = (await pos.query('SELECT COUNT(*) AS n FROM products'))[0].n;
    const res = await request(app).post('/api/combos').send(familiar());
    expect(res.status).toBe(201);
    comboId = res.body.combo.id;
    expect(res.body.combo).toMatchObject({
      nombre: 'Combo Familiar', codigo: 'COMBO-FAM', precio: 600, activo: true, descripcion: 'Para compartir',
      totales: expect.objectContaining({ precioNormal: 750, costo: 450, ahorro: 150, margenPct: 25, itbisMixto: true }),
      disponible: 3,
    });
    expect(res.body.combo.componentes.map((c) => [c.id, c.cantidad])).toEqual([[pollo, 1], [refresco, 2], [papas, 1]]);
    // Solo se agrega la fila del combo: los productos no se duplican.
    expect((await pos.query('SELECT COUNT(*) AS n FROM products'))[0].n).toBe(antes + 1);
    const row = (await pos.query('SELECT * FROM products WHERE id = ?', [comboId]))[0];
    expect(row).toMatchObject({ product_type: 'combo', is_combo: 1, tracks_stock: 0, stock: 0, precio_venta: 600, precio_compra: 450 });
    expect((await pos.query('SELECT COUNT(*) AS n FROM product_combo_items WHERE combo_product_id = ?', [comboId]))[0].n).toBe(3);
    expect(cambios.at(-1)).toEqual({ ids: [comboId] });
    expect(auditoria.at(-1)).toMatchObject({ moduleName: 'Promociones', actionName: 'Combo creado' });
  });

  test('no deja repetir el código ni meter un combo dentro de otro', async () => {
    const dup = await request(app).post('/api/combos').send({ ...familiar(), nombre: 'Otro' });
    expect(dup.status).toBe(409);
    const anidado = await request(app).post('/api/combos').send({
      nombre: 'Mega', codigo: 'MEGA', precio: 900, componentes: [{ id: comboId, cantidad: 1 }],
    });
    expect(anidado.status).toBe(400);
    expect(anidado.body.error).toMatch(/no puede llevar otro combo/);
  });

  test('valida cantidades y precio', async () => {
    const cero = await request(app).post('/api/combos').send({ ...familiar(), codigo: 'X1', nombre: 'X1', componentes: [{ id: pollo, cantidad: 0 }] });
    expect(cero.status).toBe(400);
    const sinPrecio = await request(app).post('/api/combos').send({ ...familiar(), codigo: 'X2', nombre: 'X2', precio: 0 });
    expect(sinPrecio.status).toBe(400);
  });

  test('editar cambia el combo pero no las ventas guardadas', async () => {
    // Una venta guardada con la foto de hoy.
    const comboRow = (await pos.query('SELECT * FROM products WHERE id = ?', [comboId]))[0];
    const comps = (await combos.loadComponentsByCombo(pos.query, [comboId])).get(comboId);
    const snapshot = combos.buildSaleSnapshot(comboRow, comps);
    const sale = await pos.query(
      `INSERT INTO sales (invoice_number, user_id, subtotal, discount, tax, total, payment_method, created_at)
       VALUES ('FAC-1', 1, 600, 0, 0, 600, 'efectivo', datetime('now'))`
    );
    await pos.query(
      `INSERT INTO sale_items (sale_id, product_id, item_name, qty, price, line_total, combo_snapshot)
       VALUES (?, ?, ?, 2, 600, 1200, ?)`,
      [sale.insertId, comboId, snapshot.nombre, JSON.stringify(snapshot)]
    );

    const res = await request(app).put(`/api/combos/${comboId}`).send({
      ...familiar(), nombre: 'Combo Familiar Plus', precio: 650,
      componentes: [{ id: pollo, cantidad: 1 }, { id: papas, cantidad: 2 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.combo.componentes.map((c) => c.id)).toEqual([pollo, papas]);

    const guardada = (await pos.query('SELECT item_name, combo_snapshot FROM sale_items WHERE sale_id = ?', [sale.insertId]))[0];
    expect(guardada.item_name).toBe('Combo Familiar');
    expect(JSON.parse(guardada.combo_snapshot).componentes.map((c) => c.nombre)).toEqual(['Pollo', 'Refresco', 'Papas']);

    const ventas = await request(app).get(`/api/combos/${comboId}/ventas`);
    expect(ventas.body.ventas[0]).toMatchObject({ cantidad: 2, total: 1200, nombre: 'Combo Familiar' });

    const reporte = await request(app).get('/api/combos/reportes/resumen');
    expect(reporte.body.combos[0]).toMatchObject({ unidades: 2, ingresos: 1200, costo: 900, ganancia: 300 });
    expect(reporte.body.combos[0].componentes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nombre: 'Refresco', cantidad: 4 }),
    ]));
  });

  test('activar, desactivar, imagen y presentación en facturas', async () => {
    const off = await request(app).post(`/api/combos/${comboId}/estado`).send({ activo: false });
    expect(off.body.combo.activo).toBe(false);
    expect((await pos.query('SELECT estado FROM products WHERE id = ?', [comboId]))[0].estado).toBe('Inactivo');
    const on = await request(app).post(`/api/combos/${comboId}/estado`).send({ activo: true });
    expect(on.body.combo.activo).toBe(true);

    const img = await request(app).post(`/api/combos/${comboId}/imagen`).send({ imageData: 'data:image/png;base64,AAAA' });
    expect(img.body.combo.imagenLocal).toBe(`/uploads/products/combo-${comboId}.webp`);
    const sinImg = await request(app).delete(`/api/combos/${comboId}/imagen`);
    expect(sinImg.body.combo.imagenLocal).toBe('');

    const cfg = await request(app).put('/api/combos/config').send({ presentacionFactura: 'desglosado' });
    expect(cfg.body.presentacionFactura).toBe('desglosado');
    expect((await request(app).get('/api/combos/config')).body.presentacionFactura).toBe('desglosado');
    expect((await request(app).put('/api/combos/config').send({ presentacionFactura: 'otro' })).status).toBe(400);
  });

  test('sin el permiso de Promociones no se administra', async () => {
    const previo = actor;
    actor = { id: 2, nombre: 'Cajero', role_code: 'cajero', permisos: ['ventas'] };
    try {
      expect((await request(app).get('/api/combos')).status).toBe(403);
      expect((await request(app).post('/api/combos').send({ ...familiar(), codigo: 'Z', nombre: 'Z' })).status).toBe(403);
    } finally {
      actor = previo;
    }
  });
});
