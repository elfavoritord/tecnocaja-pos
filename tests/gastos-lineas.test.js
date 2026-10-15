'use strict';

/**
 * Gastos con varias líneas (server/routes/gastos.routes.js): un gasto puede
 * traer varios conceptos; la cabecera guarda los totales calculados de ellas.
 */

jest.mock('../server/sync/sync-pos-stats', () => ({ syncPosStatsToFirestore: () => Promise.resolve() }));

const express = require('express');
const request = require('supertest');
const { createGastosRouter, normalizarLineasGasto } = require('../server/routes/gastos.routes');

describe('normalizarLineasGasto', () => {
  test('calcula subtotal, ITBIS y total por línea e ignora filas vacías', () => {
    const lineas = normalizarLineasGasto([
      { descripcion: 'Cemento', cantidad: 10, precio: 450, itbisPct: 18 },
      { descripcion: '', cantidad: 1, precio: '' },
      { descripcion: 'Transporte', cantidad: 1, precio: 1500, itbisPct: 0 },
    ]);
    expect(lineas).toEqual([
      { descripcion: 'Cemento', categoria: null, cantidad: 10, precio: 450, itbisPct: 18, subtotal: 4500, itbis: 810, total: 5310 },
      { descripcion: 'Transporte', categoria: null, cantidad: 1, precio: 1500, itbisPct: 0, subtotal: 1500, itbis: 0, total: 1500 },
    ]);
  });

  test('cada línea puede tener su categoría; sin ella toma la del gasto', () => {
    const lineas = normalizarLineasGasto([
      { descripcion: 'Gasolina', precio: 2000, categoria: 'Combustible' },
      { descripcion: 'Cambio de aceite', precio: 1500 },
    ], 'Mantenimiento');
    expect(lineas.map((l) => l.categoria)).toEqual(['Combustible', 'Mantenimiento']);
  });

  test('unirCategorias: las de siempre primero y las propias sin repetir', () => {
    const { unirCategorias, EXPENSE_CATEGORIES } = require('../server/routes/gastos.routes');
    const lista = unirCategorias(['Viáticos', 'nómina', 'Alquiler de equipos', 'Viáticos']);
    expect(lista.slice(0, EXPENSE_CATEGORIES.length)).toEqual(EXPENSE_CATEGORIES);
    expect(lista.slice(EXPENSE_CATEGORIES.length)).toEqual(['Alquiler de equipos', 'Viáticos']);
  });

  test('una línea a medias es un error, no se descarta', () => {
    expect(() => normalizarLineasGasto([{ descripcion: '', precio: 100 }])).toThrow('Línea 1: falta la descripción.');
    expect(() => normalizarLineasGasto([{ descripcion: 'Algo', precio: 0 }])).toThrow('Línea 1: el precio debe ser mayor que cero.');
    expect(() => normalizarLineasGasto([{ descripcion: 'Algo', precio: 10, itbisPct: 150 }])).toThrow('Línea 1: el ITBIS');
  });
});

describe('POST /api/expenses con líneas', () => {
  function armar() {
    const sqls = [];
    const fakeQuery = async (sql, params = []) => {
      sqls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/^\s*INSERT INTO expenses\b/.test(sql)) return { insertId: 7 };
      if (/FROM expenses e/.test(sql)) {
        return [{ id: 7, branch_id: 1, categoria: 'Mantenimiento', descripcion: params.length ? 'x' : '', subtotal: 6000, itbis: 810, total: 6810, estado: 'pagado' }];
      }
      return [];
    };
    const app = express();
    app.use(express.json());
    app.use('/api/expenses', createGastosRouter({
      query: fakeQuery,
      withTransaction: async (work) => work({ query: fakeQuery }),
      resolveRequestActorUser: async () => ({ id: 1, nombre: 'Admin', role_code: 'administrador_general' }),
      userRoleHasPermission: () => true,
      writeAuditLog: async () => {},
      getUserScopeBranchId: () => 1,
    }));
    return { app, sqls };
  }

  test('guarda la cabecera con los totales de las líneas y una fila por línea', async () => {
    const { app, sqls } = armar();
    const res = await request(app).post('/api/expenses').send({
      categoria: 'Mantenimiento', branchId: 1, fecha: '2026-10-14', estado: 'pagado',
      subtotal: 1, itbis: 999, // el servidor no confía en estos: los recalcula
      items: [
        { descripcion: 'Cemento', cantidad: 10, precio: 450, itbisPct: 18 },
        { descripcion: 'Transporte', cantidad: 1, precio: 1500, itbisPct: 0 },
      ],
    });
    expect(res.status).toBe(201);
    const cabecera = sqls.find((s) => s.sql.startsWith('INSERT INTO expenses '));
    // descripcion derivada de la primera línea; subtotal 6000, itbis 810, total 6810
    expect(cabecera.params[2]).toBe('Cemento y 1 más');
    expect(cabecera.params.slice(9, 14)).toEqual([6000, 810, 0, 0, 6810]);
    const lineas = sqls.filter((s) => s.sql.startsWith('INSERT INTO expense_items'));
    expect(lineas).toHaveLength(2);
    expect(lineas[0].params).toEqual([7, 0, 'Cemento', 'Mantenimiento', 10, 450, 18, 4500, 810, 5310]);
  });

  test('sin líneas válidas responde 400', async () => {
    const { app } = armar();
    const res = await request(app).post('/api/expenses').send({
      categoria: 'Otros', branchId: 1, fecha: '2026-10-14', items: [{ descripcion: '', precio: '' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/al menos una línea/);
  });

  test('con SQLite real: crea la tabla, guarda y devuelve las líneas', async () => {
    const { createSqlitePos } = require('./helpers/sqlite-pos');
    const { ensureSchema } = require('../server/routes/gastos.routes');
    const pos = await createSqlitePos();
    await ensureSchema(pos.query);
    const [branch] = await pos.query('SELECT id FROM branches ORDER BY id LIMIT 1');
    const app = express();
    app.use(express.json());
    app.use('/api/expenses', createGastosRouter({
      query: pos.query,
      withTransaction: pos.withTransaction,
      resolveRequestActorUser: async () => ({ id: 1, nombre: 'Admin', role_code: 'administrador_general' }),
      userRoleHasPermission: () => true,
      writeAuditLog: async () => {},
      getUserScopeBranchId: () => branch.id,
    }));
    const creado = await request(app).post('/api/expenses').send({
      categoria: 'Mantenimiento', descripcion: 'Factura Ferretería', branchId: branch.id, fecha: '2026-10-14',
      retencionIsr: 100,
      items: [
        { descripcion: 'Cemento', cantidad: 10, precio: 450, itbisPct: 18 },
        { descripcion: 'Transporte', cantidad: 1, precio: 1500, itbisPct: 0 },
      ],
    });
    expect(creado.status).toBe(201);
    expect(creado.body).toMatchObject({ subtotal: 6000, itbis: 810, total: 6810, montoNetoBeneficiario: 6710 });
    const detalle = await request(app).get(`/api/expenses/${creado.body.id}`);
    expect(detalle.status).toBe(200);
    expect(detalle.body.items.map((i) => [i.descripcion, i.total])).toEqual([['Cemento', 5310], ['Transporte', 1500]]);

    // Editar: cambia una línea a otra categoría (propia) y quita la otra.
    const editado = await request(app).put(`/api/expenses/${creado.body.id}`).send({
      categoria: 'Mantenimiento', descripcion: 'Factura Ferretería (corregida)', branchId: branch.id, fecha: '2026-10-15',
      items: [{ descripcion: 'Cemento', cantidad: 12, precio: 450, itbisPct: 18, categoria: 'Materiales de obra' }],
    });
    expect(editado.status).toBe(200);
    expect(editado.body).toMatchObject({ descripcion: 'Factura Ferretería (corregida)', subtotal: 5400, itbis: 972, total: 6372 });
    expect(editado.body.items).toHaveLength(1);
    expect(editado.body.categorias).toEqual(['Mantenimiento', 'Materiales de obra']);

    // El listado junta las categorías de las líneas; la propia sale en /categories.
    const lista = await request(app).get('/api/expenses');
    expect(lista.body[0].categorias).toEqual(['Mantenimiento', 'Materiales de obra']);
    const cats = await request(app).get('/api/expenses/categories');
    expect(cats.body).toContain('Materiales de obra');

    // Anulado: ya no se edita.
    await request(app).post(`/api/expenses/${creado.body.id}/void`).send({ motivo: 'prueba' });
    const tarde = await request(app).put(`/api/expenses/${creado.body.id}`).send({
      categoria: 'Otros', branchId: branch.id, fecha: '2026-10-15', items: [{ descripcion: 'X', precio: 1 }],
    });
    expect(tarde.status).toBe(409);
  });

  test('un gasto de un solo monto (sin líneas) sigue funcionando', async () => {
    const { app, sqls } = armar();
    const res = await request(app).post('/api/expenses').send({
      categoria: 'Alquiler', descripcion: 'Local', branchId: 1, fecha: '2026-10-14', subtotal: 25000, itbis: 0,
    });
    expect(res.status).toBe(201);
    expect(sqls.filter((s) => s.sql.startsWith('INSERT INTO expense_items'))).toHaveLength(0);
  });
});
