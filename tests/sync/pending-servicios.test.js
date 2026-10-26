'use strict';

/**
 * Servicios (Empresa de Servicios, svc_services) que el contador agrega,
 * edita o da de baja desde su portal: viajan en la cola de productos con
 * tipo 'servicio' y el POS los aplica en su Catálogo de servicios.
 */

const initSqlJs = require('sql.js');

function docPendiente(data) {
  return { data: () => data, ref: { update: jest.fn(async () => {}) } };
}

let mockCola = [];
jest.mock('../../modules/firebase-admin', () => ({
  getFirestore: () => ({
    collection: () => ({
      doc: () => ({
        collection: () => ({
          where: () => ({ get: async () => ({ empty: !mockCola.length, docs: mockCola }) }),
        }),
      }),
    }),
  }),
}));

const { createApplyPendingProductsService } = require('../../server/sync/apply-pending-products');

async function crearPos({ empresaDeServicios = true } = {}) {
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
  await query('CREATE TABLE config (id INTEGER PRIMARY KEY, service_company TINYINT DEFAULT 0)');
  await query('INSERT INTO config (id, service_company) VALUES (1, ?)', [empresaDeServicios ? 1 : 0]);
  const writeAuditLog = jest.fn(async () => {});
  const createProductInTransaction = jest.fn(async () => ({ row: { id: 99 } }));
  const servicio = createApplyPendingProductsService({
    createProductInTransaction,
    withTransaction: async (work) => work({ query }),
    writeAuditLog,
    query,
    decodeDataUrlImage: () => null,
    saveProductImageBuffer: async () => ({}),
  });
  return { query, servicio, writeAuditLog, createProductInTransaction };
}

const NUEVO = {
  tipo: 'servicio', accion: 'crear', nombre: 'Mantenimiento de computadora', codigo: 'MANT-01',
  descripcion: 'Limpieza y revisión', categoria: 'Soporte', unidad: 'visita', precioVenta: 1500, itbisPct: 18,
  contadorNombre: 'VICRIS',
};

beforeEach(() => {
  process.env.TECNO_CAJA_LICENSE_UID = 'pos_demo_1';
  mockCola = [];
});
afterEach(() => { delete process.env.TECNO_CAJA_LICENSE_UID; });

describe('cola del contador: servicios', () => {
  test('crea el servicio en el Catálogo de servicios (con su categoría), no un producto', async () => {
    const { query, servicio, writeAuditLog, createProductInTransaction } = await crearPos();
    const pedido = docPendiente(NUEVO);
    mockCola = [pedido];

    expect(await servicio.applyPendingProductRequests()).toEqual({ ok: true, applied: 1, failed: 0 });

    const [s] = await query(`SELECT s.id, s.codigo, s.nombre, s.descripcion, s.precio, s.itbis_pct, s.unidad, s.activo, c.nombre AS categoria
                             FROM svc_services s LEFT JOIN svc_service_categories c ON c.id = s.categoria_id`);
    expect(s).toMatchObject({
      codigo: 'MANT-01', nombre: 'Mantenimiento de computadora', descripcion: 'Limpieza y revisión',
      precio: 1500, itbis_pct: 18, unidad: 'visita', activo: 1, categoria: 'Soporte',
    });
    expect(createProductInTransaction).not.toHaveBeenCalled();
    expect(pedido.ref.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'aplicado', localServiceId: s.id, duplicateResolved: false }));
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ moduleName: 'Servicios', actionName: 'Servicio creado por contador' }));
  });

  test('el mismo servicio otra vez se liga sin duplicar', async () => {
    const { query, servicio } = await crearPos();
    mockCola = [docPendiente(NUEVO)];
    await servicio.applyPendingProductRequests();
    const repetido = docPendiente({ ...NUEVO, codigo: '' });
    mockCola = [repetido];

    await servicio.applyPendingProductRequests();

    expect(repetido.ref.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'aplicado', duplicateResolved: true }));
    expect(await query('SELECT COUNT(*) AS n FROM svc_services')).toEqual([{ n: 1 }]);
  });

  test('editar cambia precio e ITBIS; dar de baja lo deja inactivo', async () => {
    const { query, servicio } = await crearPos();
    mockCola = [docPendiente(NUEVO)];
    await servicio.applyPendingProductRequests();
    const [{ id }] = await query('SELECT id FROM svc_services');

    mockCola = [docPendiente({ ...NUEVO, accion: 'editar', servicioId: id, precioVenta: 1800, itbisPct: 0, categoria: 'General' })];
    await servicio.applyPendingProductRequests();
    expect((await query('SELECT precio, itbis_pct, categoria_id FROM svc_services'))[0]).toEqual({ precio: 1800, itbis_pct: 0, categoria_id: null });

    const baja = docPendiente({ tipo: 'servicio', accion: 'eliminar', servicioId: id, nombre: NUEVO.nombre });
    mockCola = [baja];
    await servicio.applyPendingProductRequests();
    expect((await query('SELECT activo FROM svc_services'))[0].activo).toBe(0);
    expect(baja.ref.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'aplicado' }));
  });

  test('editar con el nombre de otro servicio queda en error con el motivo', async () => {
    const { query, servicio } = await crearPos();
    mockCola = [docPendiente(NUEVO), docPendiente({ ...NUEVO, nombre: 'Instalación de red', codigo: 'RED-01' })];
    await servicio.applyPendingProductRequests();
    const [{ id }] = await query("SELECT id FROM svc_services WHERE codigo = 'RED-01'");
    const choque = docPendiente({ ...NUEVO, accion: 'editar', servicioId: id, codigo: 'RED-01' });
    mockCola = [choque];

    await servicio.applyPendingProductRequests();

    expect(choque.ref.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error', errorMessage: expect.stringMatching(/Ya existe otro servicio/),
    }));
  });

  test('importado de un CSV en el portal: actualiza solo las columnas que traía el archivo', async () => {
    const { query, servicio } = await crearPos();
    mockCola = [docPendiente(NUEVO)];
    await servicio.applyPendingProductRequests();

    // CSV con Código y Precio: sube el precio, no toca nombre, ITBIS ni categoría.
    const subida = docPendiente({ tipo: 'servicio', accion: 'crear', importado: true, codigo: 'mant-01', nombre: '', precioVenta: 1800, campos: ['codigo', 'precio'] });
    const nuevo = docPendiente({ tipo: 'servicio', accion: 'crear', importado: true, nombre: 'Asesoría', precioVenta: 2500, itbisPct: 0, campos: ['nombre', 'precio', 'itbisPct'] });
    mockCola = [subida, nuevo];
    expect(await servicio.applyPendingProductRequests()).toEqual({ ok: true, applied: 2, failed: 0 });

    const filas = await query(`SELECT s.codigo, s.nombre, s.precio, s.itbis_pct, c.nombre AS categoria FROM svc_services s
                               LEFT JOIN svc_service_categories c ON c.id = s.categoria_id ORDER BY s.id`);
    expect(filas).toEqual([
      { codigo: 'MANT-01', nombre: 'Mantenimiento de computadora', precio: 1800, itbis_pct: 18, categoria: 'Soporte' },
      { codigo: null, nombre: 'Asesoría', precio: 2500, itbis_pct: 0, categoria: null },
    ]);
  });

  test('un negocio que no es Empresa de Servicios lo rechaza (ahí el servicio es un producto sin inventario)', async () => {
    const { servicio, createProductInTransaction } = await crearPos({ empresaDeServicios: false });
    const pedido = docPendiente(NUEVO);
    mockCola = [pedido];

    expect(await servicio.applyPendingProductRequests()).toEqual({ ok: true, applied: 0, failed: 1 });
    expect(pedido.ref.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error', errorMessage: expect.stringMatching(/no es Empresa de Servicios/),
    }));
    expect(createProductInTransaction).not.toHaveBeenCalled();
  });
});
