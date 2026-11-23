'use strict';
// Catálogo desde la venta (2026-11-23): el producto rápido queda en Productos y
// el precio de F3 queda en el producto, también para el cajero.
const express = require('express');
const request = require('supertest');
const { createVentaCatalogoRouter, siguienteCodigo } = require('../server/routes/venta-catalogo.routes');

function servidor({ permisos = ['ventas'], productos = [] } = {}) {
  const filas = productos.map((p) => ({ estado: 'Activo', sale_mode: 'unidad', product_type: 'general', is_combo: 0, ...p }));
  const query = jest.fn(async (sql, params = []) => {
    if (/FROM categories/.test(sql)) return [{ nombre: 'General' }];
    if (/SELECT codigo FROM products WHERE UPPER\(codigo\) LIKE 'RAP-%'/.test(sql)) return filas.filter((f) => /^RAP-/i.test(f.codigo));
    if (/WHERE LOWER\(codigo\) = LOWER\(\?\) OR/.test(sql)) {
      const [codigo, , nombre] = params.map((v) => String(v).toLowerCase());
      return filas.filter((f) => String(f.codigo).toLowerCase() === codigo || String(f.barcode || '').toLowerCase() === codigo || String(f.nombre).toLowerCase() === nombre);
    }
    if (/WHERE LOWER\(nombre\) = LOWER\(\?\)/.test(sql)) return filas.filter((f) => String(f.nombre).toLowerCase() === String(params[0]).toLowerCase());
    if (/^UPDATE products SET precio_venta/.test(sql)) { filas.find((f) => f.id === params[1]).precio_venta = params[0]; return { affectedRows: 1 }; }
    if (/SELECT \* FROM products WHERE id = \?/.test(sql)) return filas.filter((f) => f.id === Number(params[0]));
    return [];
  });
  const creados = [];
  const createProductInTransaction = jest.fn(async (conn, { data }) => {
    const row = { id: 100 + creados.length, codigo: data.codigo, barcode: data.barcode, nombre: data.nombre, categoria: data.categoria,
      precio_venta: data.precioVenta, tracks_stock: data.tracksStock === false ? 0 : 1, aplica_itbis: data.aplicaItbis ? 1 : 0,
      sale_mode: data.saleMode, estado: data.estado, stock: 0 };
    creados.push(data); filas.push(row);
    return { row, branchId: 1 };
  });
  const writeAuditLog = jest.fn(async () => {});
  const alGuardarProducto = jest.fn();
  const router = createVentaCatalogoRouter({
    query, withTransaction: (work) => work({ query }),
    resolveRequestActorUser: async () => ({ id: 3, rol: 'cajero' }), getActor: () => ({ userId: 3, userName: 'Cajera' }),
    writeAuditLog, userRoleHasPermission: (_u, ...p) => p.some((x) => permisos.includes(x)),
    getProductCatalogBranchScope: () => null, createProductInTransaction,
    mapProductRow: (r) => ({ id: r.id, codigo: r.codigo, nombre: r.nombre, precioVenta: Number(r.precio_venta), tracksStock: Number(r.tracks_stock) !== 0, aplicaItbis: Boolean(r.aplica_itbis), estado: r.estado }),
    alGuardarProducto,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/products/venta', router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) }));
  return { app, query, creados, filas, writeAuditLog, alGuardarProducto };
}

test('siguienteCodigo arma RAP-0001, RAP-0002…', () => {
  expect(siguienteCodigo([])).toBe('RAP-0001');
  expect(siguienteCodigo(['RAP-0009', 'rap-0002', 'X-77', 'RAP-ABC'])).toBe('RAP-0010');
});

describe('producto rápido', () => {
  test('el cajero lo guarda: activo, General, por unidad, sin control de existencia', async () => {
    const s = servidor({ productos: [{ id: 1, codigo: 'RAP-0001', nombre: 'Hielo', precio_venta: 50 }] });
    const r = await request(s.app).post('/api/products/venta/rapido').send({ nombre: '  Plátanos   verdes ', precio: 25.555, aplicaItbis: true });
    expect(r.status).toBe(201);
    expect(r.body.creado).toBe(true);
    expect(s.creados[0]).toMatchObject({ codigo: 'RAP-0002', barcode: 'RAP-0002', nombre: 'Plátanos verdes', categoria: 'General', precioVenta: 25.56,
      estado: 'Activo', saleMode: 'unidad', tracksStock: false, stock: 0, aplicaItbis: true });
    expect(s.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actionName: 'Producto creado desde la venta' }));
    expect(s.alGuardarProducto).toHaveBeenCalledTimes(1);
  });

  test('con el código escaneado lo usa como código', async () => {
    const s = servidor();
    const r = await request(s.app).post('/api/products/venta/rapido').send({ codigo: '7460001', nombre: 'Galletas', precio: 65.5 });
    expect(r.status).toBe(201);
    expect(s.creados[0]).toMatchObject({ codigo: '7460001', aplicaItbis: false });
  });

  test('si ya hay uno con ese nombre, se usa ese con su precio (no se duplica)', async () => {
    const s = servidor({ productos: [{ id: 5, codigo: 'AGUA', nombre: 'Agua', precio_venta: 25 }] });
    const r = await request(s.app).post('/api/products/venta/rapido').send({ nombre: 'agua', precio: 30 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ creado: false, product: { id: 5, precioVenta: 25 } });
    expect(s.creados).toHaveLength(0);
  });

  test('uno inactivo con ese nombre: 409 y no se crea otro', async () => {
    const s = servidor({ productos: [{ id: 6, codigo: 'VIEJO', nombre: 'Pan', precio_venta: 10, estado: 'Inactivo' }] });
    const r = await request(s.app).post('/api/products/venta/rapido').send({ nombre: 'Pan', precio: 12 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PRODUCTO_INACTIVO');
    expect(s.creados).toHaveLength(0);
  });

  test('sin nombre, sin precio o sin permiso de vender: no se guarda', async () => {
    expect((await request(servidor().app).post('/api/products/venta/rapido').send({ nombre: ' ', precio: 5 })).status).toBe(400);
    expect((await request(servidor().app).post('/api/products/venta/rapido').send({ nombre: 'Algo', precio: 0 })).status).toBe(400);
    expect((await request(servidor({ permisos: ['caja'] }).app).post('/api/products/venta/rapido').send({ nombre: 'Algo', precio: 5 })).status).toBe(403);
  });
});

describe('precio de F3 en el producto', () => {
  const productos = [
    { id: 1, codigo: 'GALLETAS', nombre: 'Galletas', precio_venta: 100 },
    { id: 2, codigo: 'POLLO', nombre: 'Pollo', precio_venta: 100, sale_mode: 'peso' },
    { id: 3, codigo: 'COMBO1', nombre: 'Combo', precio_venta: 300, product_type: 'combo' },
  ];

  test('el cajero lo deja guardado y queda en la auditoría con el precio de antes', async () => {
    const s = servidor({ productos });
    const r = await request(s.app).post('/api/products/venta/1/precio').send({ precio: 90 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ cambiado: true, product: { id: 1, precioVenta: 90 } });
    expect(s.filas.find((f) => f.id === 1).precio_venta).toBe(90);
    expect(s.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      actionName: 'Precio cambiado desde la venta', before: { precio: 100 }, after: { precio: 90 },
    }));
    expect(s.alGuardarProducto).toHaveBeenCalledTimes(1);
  });

  test('el mismo precio no cambia nada', async () => {
    const s = servidor({ productos });
    const r = await request(s.app).post('/api/products/venta/1/precio').send({ precio: 100 });
    expect(r.body.cambiado).toBe(false);
    expect(s.query.mock.calls.some(([sql]) => /^UPDATE/.test(sql))).toBe(false);
  });

  test('nunca en productos por peso ni combos; precio inválido o producto que no existe', async () => {
    const s = servidor({ productos });
    expect((await request(s.app).post('/api/products/venta/2/precio').send({ precio: 90 })).status).toBe(400);
    expect((await request(s.app).post('/api/products/venta/3/precio').send({ precio: 90 })).status).toBe(400);
    expect((await request(s.app).post('/api/products/venta/1/precio').send({ precio: -1 })).status).toBe(400);
    expect((await request(s.app).post('/api/products/venta/99/precio').send({ precio: 5 })).status).toBe(404);
    expect(s.query.mock.calls.some(([sql]) => /^UPDATE/.test(sql))).toBe(false);
  });

  test('sin permiso de vender: 403', async () => {
    const s = servidor({ productos, permisos: [] });
    expect((await request(s.app).post('/api/products/venta/1/precio').send({ precio: 90 })).status).toBe(403);
  });
});
