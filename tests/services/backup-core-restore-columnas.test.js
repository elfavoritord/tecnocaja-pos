'use strict';

/**
 * Restaurar un respaldo que trae columnas que esta versión no tiene (hecho con
 * una versión más nueva). Antes, el INSERT fallaba entero, safeQ se tragaba el
 * error y la tabla quedaba VACÍA sin avisar.
 */

jest.mock('../../db', () => ({
  getDbClient: () => 'sqlite',
  withTransaction: async (work) => work({ query: () => [] }),
}));

const { crearBaseSqlite } = require('../multisucursal/sqlite-helper');
const { restorePayloadToDb } = require('../../server/services/backup-core');

describe('restorePayloadToDb con columnas desconocidas', () => {
  let base;
  let avisos;
  let warnOriginal;

  beforeEach(async () => {
    base = await crearBaseSqlite();
    avisos = [];
    warnOriginal = console.warn;
    console.warn = (...args) => avisos.push(args.join(' '));
  });

  afterEach(() => {
    console.warn = warnOriginal;
    base.close();
  });

  test('restaura los datos y solo omite las columnas que no existen aquí', async () => {
    const producto = (id, nombre) => ({
      id, codigo: `C${id}`, nombre, categoria: 'General', precio_venta: 50, stock: 3,
      columna_del_futuro: 'x',
    });
    const payload = {
      data: {
        users: [{ id: 1, usuario: 'admin', password: '', nombre: 'Admin', rol: 'Administrador', estado: 'Activo' }],
        products: [producto(1, 'Ron'), producto(2, 'Cerveza')],
      },
    };

    const resultado = await restorePayloadToDb(payload, base.query);

    const productos = await base.query('SELECT id, nombre, stock FROM products ORDER BY id');
    expect(productos).toEqual([
      { id: 1, nombre: 'Ron', stock: 3 },
      { id: 2, nombre: 'Cerveza', stock: 3 },
    ]);
    expect(resultado.userCount).toBe(1);
    expect(avisos.some((a) => a.includes('products') && a.includes('columna_del_futuro'))).toBe(true);
  });
});
