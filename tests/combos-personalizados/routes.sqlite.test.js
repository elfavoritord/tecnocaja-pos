'use strict';

/**
 * Combos personalizados sobre la base SQLite real del POS (db/schema.sql), con
 * el router de verdad y la validación que usa POST /api/sales (prepararVenta):
 * precio libre con ITBIS incluido, repartido entre los productos.
 */

const express = require('express');
const request = require('supertest');
const { createSqlitePos } = require('../helpers/sqlite-pos');
const createRouter = require('../../server/routes/combos-personalizados.routes');
const svc = require('../../server/services/combos-personalizados.service');
const motor = require('../../js/combos-personalizados-motor');

let pos;
let app;
let actor;
const auditoria = [];

const ADMIN = { id: 1, nombre: 'Admin', role_code: 'administrador_general', permisos: ['*'] };
const CAJERO = { id: 2, nombre: 'Cajera Ana', role_code: 'cajero', permisos: [] };

const catalogo = {};
async function producto(clave, codigo, nombre, { precio, stock = 20, itbis = 1, modo = 'porcentaje', monto = 0, saleMode = 'unidad' }) {
  const r = await pos.query(
    `INSERT INTO products (codigo, nombre, categoria, precio_compra, precio_venta, stock, aplica_itbis, itbis_modo, itbis_monto, sale_mode, tracks_stock)
     VALUES (?, ?, 'Comida', 10, ?, ?, ?, ?, ?, ?, 1)`,
    [codigo, nombre, precio, stock, itbis, modo, monto, saleMode]
  );
  const id = Number(r.insertId);
  catalogo[clave] = { id, precio, aplicaItbis: Boolean(itbis), itbisModo: modo, itbisMonto: monto };
  return id;
}

const ids = {};

beforeAll(async () => {
  pos = await createSqlitePos();
  actor = ADMIN;
  app = express();
  app.use(express.json());
  app.use('/api/combos-personalizados', createRouter({
    query: pos.query,
    addColumnIfMissing: pos.addColumnIfMissing,
    resolveRequestActorUser: async () => actor,
    userRoleHasPermission: (user, perm) => (user.permisos || []).includes('*') || (user.permisos || []).includes(perm),
    isGlobalAdministratorUser: (user) => user.role_code === 'administrador_general',
    userCanManageGlobalConfig: (user) => user.role_code === 'administrador_general',
    saveProductImageBuffer: async ({ productId }) => ({ imageLocal: `/uploads/products/${productId}.webp` }),
    decodeDataUrlImage: (data) => Buffer.from(String(data)),
    removeLocalProductImage: async () => {},
    writeAuditLog: async (entry) => { auditoria.push(entry); },
  }));
  // El esquema lo crea el router en la primera petición.
  await request(app).get('/api/combos-personalizados/estado');
  await pos.query('UPDATE config SET tax_rate = 18 WHERE id = 1');
  ids.hamburguesa = await producto('hamburguesa', 'HAM', 'Hamburguesa', { precio: 84.75 });
  ids.refresco = await producto('refresco', 'REF', 'Refresco', { precio: 42.37 });
  ids.papas = await producto('papas', 'PAP', 'Papas', { precio: 50, itbis: 0 });
  ids.cerveza = await producto('cerveza', 'CER', 'Cerveza', { precio: 80, modo: 'monto', monto: 20 });
  ids.queso = await producto('queso', 'QUE', 'Queso por libra', { precio: 200, saleMode: 'peso' });
});

afterAll(() => pos?.close());

afterEach(() => { actor = ADMIN; });

describe('configuración', () => {
  test('arranca apagado, sin combos y sin productos habilitados', async () => {
    const res = await request(app).get('/api/combos-personalizados/estado');
    expect(res.status).toBe(200);
    expect(res.body.config).toEqual({ activo: false, mostrarImagenes: true, permitirCantidades: true });
    expect(res.body.combos).toEqual([]);
    expect(res.body.productoIds).toEqual([]);
    expect(res.body.tasaItbis).toBe(18);
  });

  test('solo el administrador general lo activa', async () => {
    actor = CAJERO;
    expect((await request(app).put('/api/combos-personalizados/config').send({ activo: true })).status).toBe(403);
    actor = ADMIN;
    const res = await request(app).put('/api/combos-personalizados/config').send({ activo: true, mostrarImagenes: false });
    expect(res.status).toBe(200);
    expect(res.body.config).toMatchObject({ activo: true, mostrarImagenes: false, permitirCantidades: true });
    expect(auditoria.at(-1)).toMatchObject({ moduleName: 'Promociones', actionName: 'Combos personalizados activados' });
    await request(app).put('/api/combos-personalizados/config').send({ mostrarImagenes: true });
  });
});

describe('combos sugeridos (opcionales)', () => {
  test('nombre obligatorio; el precio sugerido es opcional; no repetir nombre', async () => {
    expect((await request(app).post('/api/combos-personalizados/combos').send({ nombre: '', precio: 100 })).status).toBe(400);
    expect((await request(app).post('/api/combos-personalizados/combos').send({ nombre: 'Negativo', precio: -1 })).status).toBe(400);
    const libre = await request(app).post('/api/combos-personalizados/combos').send({ nombre: 'Combo libre' });
    expect(libre.status).toBe(201);
    expect(libre.body.combo.precio).toBe(0);
    ids.libre = libre.body.combo.id;
    const especial = await request(app).post('/api/combos-personalizados/combos').send({ nombre: 'Combo especial', precio: 500 });
    expect(especial.body.combo).toMatchObject({ nombre: 'Combo especial', precio: 500, activo: true });
    ids.especial = especial.body.combo.id;
    expect((await request(app).post('/api/combos-personalizados/combos').send({ nombre: 'combo ESPECIAL' })).status).toBe(409);
  });

  test('el cajero no administra, y solo ve los activos', async () => {
    const off = await request(app).post('/api/combos-personalizados/combos').send({ nombre: 'Combo viejo', precio: 120, activo: false });
    ids.viejo = off.body.combo.id;
    actor = CAJERO;
    expect((await request(app).post('/api/combos-personalizados/combos').send({ nombre: 'X' })).status).toBe(403);
    expect((await request(app).put(`/api/combos-personalizados/productos/${ids.papas}`).send({ habilitado: true })).status).toBe(403);
    const estado = await request(app).get('/api/combos-personalizados/estado');
    expect(estado.body.combos.map((c) => c.nombre).sort()).toEqual(['Combo especial', 'Combo libre']);
    expect(estado.body.puedeAdministrar).toBe(false);
  });
});

describe('productos disponibles para combos', () => {
  test('los de peso no se pueden habilitar', async () => {
    const bad = await request(app).put(`/api/combos-personalizados/productos/${ids.queso}`).send({ habilitado: true });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/por unidad/);
  });

  test('habilitar varios a la vez', async () => {
    const varios = await request(app).put('/api/combos-personalizados/productos').send({ ids: [ids.hamburguesa, ids.refresco, ids.papas, ids.cerveza], habilitado: true });
    expect(varios.status).toBe(200);
    expect(varios.body.productoIds.sort()).toEqual([ids.hamburguesa, ids.refresco, ids.papas, ids.cerveza].sort());
  });
});

// Las líneas de un combo tal como las manda la pantalla de Ventas: el reparto
// del motor (precio libre, ITBIS incluido) sobre los productos elegidos.
function lineasDeCombo(precio, elegidos, { clave = 'g1', comboId = null, nombre = 'Combo personalizado' } = {}) {
  const seleccion = elegidos.map(([clave2, qty]) => ({ ...catalogo[clave2], qty }));
  const reparto = motor.repartirCombo({ precio, seleccion, tasa: 18 });
  return reparto.filas.map((f) => ({
    id: f.id, qty: f.qty, precio: f.precio, descuento: 0, itbis: f.tasa,
    comboPersonalizado: { clave, comboId, nombre, precio },
  }));
}

async function config() {
  return (await pos.query('SELECT * FROM config WHERE id = 1'))[0];
}

describe('prepararVenta (lo que valida POST /api/sales)', () => {
  test('una venta sin combos no consulta nada', async () => {
    const espia = jest.fn();
    expect(await svc.prepararVenta(espia, { items: [{ id: 1, qty: 1 }], config: {} })).toBeNull();
    expect(espia).not.toHaveBeenCalled();
  });

  test('precio libre: RD$400 por lo que vale RD$450.01 suelto, con gravado, exento e ITBIS fijo', async () => {
    const items = [
      ...lineasDeCombo(400, [['hamburguesa', 2], ['papas', 3], ['cerveza', 1]], { clave: 'a', comboId: ids.especial }),
      { id: ids.papas, qty: 1, descuento: 0, itbis: 0, precio: 50 }, // suelto
    ];
    const res = await svc.prepararVenta(pos.query, { items, config: await config() });
    expect(res.lineas.size).toBe(items.length - 1);
    expect(res.lineas.get(items.length - 1)).toBeUndefined();
    const primera = res.lineas.get(0);
    expect(primera).toMatchObject({ clave: 'a', comboId: ids.especial, nombre: 'Combo especial', precio: 400, tasa: 18, precioOriginal: 84.75 });
    // Las líneas del combo suman exacto RD$400.00 con el ITBIS incluido.
    let suma = 0;
    res.lineas.forEach((l, idx) => {
      suma += motor.lineaCentavos({ precio: l.precioLinea, aplicaItbis: l.tasa > 0 }, items[idx].qty, { tasa: l.tasa }).total;
    });
    expect(suma).toBe(40000);
    expect(res.grupos).toEqual([{ clave: 'a', nombre: 'Combo especial', precio: 400, normal: 450.01 }]);
    // La cerveza (ITBIS fijo de RD$20 sobre RD$80) va a la tasa de la DGII más cercana: 18 %.
    const cerveza = [...res.lineas.entries()].find(([idx]) => items[idx].id === ids.cerveza)[1];
    expect(cerveza.tasa).toBe(18);
  });

  test('el precio puede ser mayor que el valor normal (sin límites) y sin nombre queda "Combo personalizado"', async () => {
    const items = lineasDeCombo(999, [['refresco', 2]]);
    const res = await svc.prepararVenta(pos.query, { items, config: await config() });
    expect(res.grupos[0]).toMatchObject({ nombre: 'Combo personalizado', precio: 999 });
  });

  test('si la pantalla manda otro reparto (precio manipulado), 409', async () => {
    const items = lineasDeCombo(200, [['hamburguesa', 1], ['papas', 2]]);
    items[0] = { ...items[0], precio: 0.01 };
    await expect(svc.prepararVenta(pos.query, { items, config: await config() }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/no cuadra con los precios actuales/) });
  });

  test('si cambió el precio de catálogo de un producto, 409', async () => {
    const items = lineasDeCombo(200, [['hamburguesa', 1], ['papas', 2]]);
    await pos.query('UPDATE products SET precio_venta = 90 WHERE id = ?', [ids.hamburguesa]);
    try {
      await expect(svc.prepararVenta(pos.query, { items, config: await config() })).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      await pos.query('UPDATE products SET precio_venta = 84.75 WHERE id = ?', [ids.hamburguesa]);
    }
  });

  test('rechaza ITBIS cambiado, descuento propio, producto no habilitado, rápido, cantidad rara o precio inválido', async () => {
    const cfg = await config();
    const base = () => lineasDeCombo(200, [['hamburguesa', 1], ['papas', 2]]);
    const casos = [
      base().map((l, i) => (i === 0 ? { ...l, itbis: 0 } : l)),
      base().map((l, i) => (i === 0 ? { ...l, descuento: 10 } : l)),
      [{ id: ids.queso, qty: 1, precio: 200, descuento: 0, itbis: 18, comboPersonalizado: { clave: 'g1', precio: 200 } }],
      [{ quickSale: true, id: null, qty: 1, precio: 200, comboPersonalizado: { clave: 'g1', precio: 200 } }],
      [{ id: ids.papas, qty: 1.5, precio: 50, descuento: 0, itbis: 0, comboPersonalizado: { clave: 'g1', precio: 75 } }],
      base().map((l) => ({ ...l, comboPersonalizado: { ...l.comboPersonalizado, precio: 0 } })),
      base().map((l, i) => (i === 0 ? { ...l, comboPersonalizado: { ...l.comboPersonalizado, precio: 150 } } : l)),
    ];
    for (const items of casos) {
      await expect(svc.prepararVenta(pos.query, { items, config: cfg })).rejects.toMatchObject({ statusCode: 409 });
    }
  });

  test('función apagada y E44/E46', async () => {
    const cfg = await config();
    const items = lineasDeCombo(200, [['hamburguesa', 1], ['papas', 2]]);
    await expect(svc.prepararVenta(pos.query, { items, config: { ...cfg, custom_combos_enabled: 0 } }))
      .rejects.toMatchObject({ message: expect.stringMatching(/desactivados en este negocio/) });
    await expect(svc.prepararVenta(pos.query, { items, config: cfg, ventaSinItbis: true }))
      .rejects.toMatchObject({ message: expect.stringMatching(/E44 o E46/) });
  });

  test('sin "permitir cantidades" va una unidad de cada producto', async () => {
    const cfg = { ...(await config()), custom_combos_allow_qty: 0 };
    await expect(svc.prepararVenta(pos.query, { items: lineasDeCombo(300, [['hamburguesa', 2]]), config: cfg }))
      .rejects.toMatchObject({ message: expect.stringMatching(/una unidad de cada producto/) });
  });

  test('un combo sugerido que ya no existe deja el nombre que trae la venta', async () => {
    const items = lineasDeCombo(120, [['papas', 2]], { comboId: 99999, nombre: 'Combo del día' });
    const res = await svc.prepararVenta(pos.query, { items, config: await config() });
    expect(res.lineas.get(0)).toMatchObject({ comboId: null, nombre: 'Combo del día', precio: 120 });
  });
});

describe('reporte y borrado', () => {
  async function venta({ invoice, lineas, cancelada = false, cajero = 1 }) {
    const s = await pos.query(
      `INSERT INTO sales (invoice_number, user_id, subtotal, discount, tax, total, payment_method, fiscal_status, created_at)
       VALUES (?, ?, 0, 0, 0, 0, 'efectivo', ?, '2026-11-04 10:00:00')`,
      [invoice, cajero, cancelada ? 'cancelada' : 'emitida']
    );
    const lineIds = [];
    for (const l of lineas) {
      const r = await pos.query(
        `INSERT INTO sale_items (sale_id, product_id, qty, price, line_total, tax_rate, tax_amount, original_price, custom_combo_key, custom_combo_id, custom_combo_name, custom_combo_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [s.insertId, l.id, l.qty, l.precio, l.neto, l.tasa || 0, l.itbis || 0, l.original ?? null, l.clave || null, l.comboId || null, l.nombre || null, l.precioCombo || null]
      );
      lineIds.push(r.insertId);
    }
    return { saleId: s.insertId, lineIds };
  }

  test('combos, cobrado, ITBIS y valor normal; fuera canceladas; resta devoluciones', async () => {
    const especial = { clave: 'k1', comboId: ids.especial, nombre: 'Combo especial', precioCombo: 150 };
    // Combo de RD$150 por 1 hamburguesa (normal 100.00) + 2 papas (normal 100.00).
    const v1 = await venta({
      invoice: 'FAC-R1',
      lineas: [
        { id: ids.hamburguesa, qty: 1, precio: 63.56, neto: 63.56, tasa: 18, itbis: 11.44, original: 84.75, ...especial },
        { id: ids.papas, qty: 2, precio: 37.5, neto: 75, original: 50, ...especial },
        { id: ids.refresco, qty: 1, precio: 42.37, neto: 42.37, tasa: 18, itbis: 7.63 }, // suelto: no cuenta
      ],
    });
    await venta({ invoice: 'FAC-R2', cancelada: true, lineas: [{ id: ids.papas, qty: 4, precio: 50, neto: 200, original: 50, ...especial }] });
    const dev = await pos.query("INSERT INTO sale_returns (original_sale_id, original_invoice_number, returned_amount) VALUES (?, 'FAC-R1', 37.5)", [v1.saleId]);
    await pos.query("INSERT INTO sale_return_items (return_id, sale_item_id, product_id, product_name, qty_returned) VALUES (?, ?, ?, 'Papas', 1)", [dev.insertId, v1.lineIds[1], ids.papas]);

    const res = await request(app).get('/api/combos-personalizados/reporte?desde=2026-11-01&hasta=2026-11-30');
    expect(res.status).toBe(200);
    expect(res.body.combosVendidos).toBe(1);
    expect(res.body.ingresos).toBe(112.5);     // 150 − 37.50 devuelto
    expect(res.body.itbis).toBe(11.44);
    expect(res.body.valorNormal).toBe(150);    // 100 (hamburguesa) + 50 (la papa que quedó)
    expect(res.body.porCombo[0]).toMatchObject({ nombre: 'Combo especial', combos: 1, ingresos: 112.5 });
    expect(res.body.productos.find((p) => p.productoId === ids.papas)).toMatchObject({ cantidad: 1, devueltas: 1 });
  });

  test('un combo sugerido con ventas no se borra; uno sin ventas sí', async () => {
    const vendido = await request(app).delete(`/api/combos-personalizados/combos/${ids.especial}`);
    expect(vendido.status).toBe(409);
    expect(vendido.body.error).toMatch(/desactívalo/);
    const libre = await request(app).delete(`/api/combos-personalizados/combos/${ids.viejo}`);
    expect(libre.status).toBe(200);
  });
});
