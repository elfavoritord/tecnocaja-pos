'use strict';

/**
 * Importar servicios al catálogo de la Empresa de Servicios
 * (server/routes/servicios/catalogo-import.js, POST /api/servicios/catalogo/importar)
 * y productos importados desde el portal (apply-pending-products.js).
 */

const initSqlJs = require('sql.js');
const { importarServicios } = require('../server/routes/servicios/catalogo-import');
const { ensureServiciosSchema } = require('../server/routes/servicios/schema');
const csv = require('../js/catalogo-csv');

async function baseDeDatos() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const query = async (sql, params = []) => {
    const text = String(sql).trim();
    const stmt = db.prepare(text);
    stmt.bind(params.map((value) => (value === undefined ? null : value)));
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    if (/^(INSERT|UPDATE|DELETE)/i.test(text)) {
      return { insertId: db.exec('SELECT last_insert_rowid()')[0].values[0][0], affectedRows: db.getRowsModified() };
    }
    return rows;
  };
  return query;
}

describe('importar servicios (CSV del POS o del portal)', () => {
  test('crea los nuevos, actualiza por código o nombre y solo cambia las columnas del archivo', async () => {
    const query = await baseDeDatos();
    await query('CREATE TABLE config (id INTEGER PRIMARY KEY)');
    await ensureServiciosSchema(query);

    const primero = csv.leerServicios([
      'Código,Nombre,Descripción,Categoría,Unidad,Precio,ITBIS %',
      'MANT-01,Mantenimiento,Limpieza,Soporte,visita,1500,18',
      ',Asesoría,,,hora,2500,0',
    ].join('\n'));
    expect(await importarServicios(query, primero.filas)).toMatchObject({ creados: 2, actualizados: 0, omitidos: 0, errores: [] });

    // Segundo archivo: sube precios por código, reactiva por nombre y trae uno nuevo sin nombre (no se puede crear).
    await query("UPDATE svc_services SET activo = 0 WHERE nombre = 'Asesoría'");
    const segundo = csv.leerServicios('Código,Nombre,Precio\nmant-01,,1800\n,asesoría,2700\nNUEVO-9,,100');
    const r = await importarServicios(query, segundo.filas);
    expect(r).toMatchObject({ creados: 0, actualizados: 2, omitidos: 1 });
    expect(r.errores).toEqual([expect.stringMatching(/Fila 4: el servicio nuevo necesita nombre/)]);

    const filas = await query(`SELECT s.codigo, s.nombre, s.descripcion, s.unidad, s.precio, s.itbis_pct, s.activo, c.nombre AS categoria
                               FROM svc_services s LEFT JOIN svc_service_categories c ON c.id = s.categoria_id ORDER BY s.id`);
    expect(filas).toEqual([
      { codigo: 'MANT-01', nombre: 'Mantenimiento', descripcion: 'Limpieza', unidad: 'visita', precio: 1800, itbis_pct: 18, activo: 1, categoria: 'Soporte' },
      { codigo: null, nombre: 'asesoría', descripcion: null, unidad: 'hora', precio: 2700, itbis_pct: 0, activo: 1, categoria: null },
    ]);
  });
});

describe('productos importados desde el portal', () => {
  function docPendiente(data) {
    return { data: () => data, ref: { update: jest.fn(async () => {}) } };
  }

  test('si el código ya existe en el POS se actualizan solo las columnas del archivo', async () => {
    const query = await baseDeDatos();
    await query(`CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, nombre TEXT, branch_id INT, estado TEXT,
      categoria TEXT, marca TEXT, unidad TEXT, precio_compra REAL, precio_venta REAL, stock REAL, stock_min REAL,
      aplica_itbis INT, tracks_stock INT, image_local TEXT)`);
    await query(`INSERT INTO products (codigo, nombre, estado, categoria, marca, unidad, precio_compra, precio_venta, stock, stock_min, aplica_itbis, tracks_stock)
                 VALUES ('0001', 'Agua 500 ml', 'Activo', 'Bebidas', 'Dasani', 'Unidad', 10, 20, 100, 10, 1, 1)`);

    const pedido = docPendiente({
      accion: 'crear', importado: true, codigo: '0001', nombre: 'Agua 500 ml', precioVenta: 25, campos: ['codigo', 'nombre', 'precioVenta'],
      contadorNombre: 'VICRIS',
    });
    jest.resetModules();
    jest.doMock('../modules/firebase-admin', () => ({
      getFirestore: () => ({
        collection: () => ({ doc: () => ({ collection: () => ({ where: () => ({ get: async () => ({ empty: false, docs: [pedido] }) }) }) }) }),
      }),
    }));
    process.env.TECNO_CAJA_LICENSE_UID = 'pos_demo_1';
    const { createApplyPendingProductsService } = require('../server/sync/apply-pending-products');
    const createProductInTransaction = jest.fn();
    const servicio = createApplyPendingProductsService({
      createProductInTransaction, withTransaction: async (work) => work({ query }), writeAuditLog: jest.fn(async () => {}), query,
      decodeDataUrlImage: () => null, saveProductImageBuffer: async () => ({}),
    });

    expect(await servicio.applyPendingProductRequests()).toEqual({ ok: true, applied: 1, failed: 0 });
    delete process.env.TECNO_CAJA_LICENSE_UID;

    expect(createProductInTransaction).not.toHaveBeenCalled();
    expect(await query('SELECT nombre, categoria, precio_compra, precio_venta, stock, aplica_itbis FROM products')).toEqual([
      { nombre: 'Agua 500 ml', categoria: 'Bebidas', precio_compra: 10, precio_venta: 25, stock: 100, aplica_itbis: 1 },
    ]);
    expect(pedido.ref.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'aplicado', localProductId: 1 }));
  });
});
