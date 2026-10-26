'use strict';

function createPendingDoc(data) {
  return {
    data: () => data,
    ref: {
      update: jest.fn(async () => {}),
    },
  };
}

describe('apply-pending-products', () => {
  let pendingDoc;

  beforeEach(() => {
    jest.resetModules();
    process.env.TECNO_CAJA_LICENSE_UID = 'pos_demo_1';
    pendingDoc = createPendingDoc({
      codigo: '008',
      nombre: 'prueba 8',
      categoria: 'General',
      precioCompra: 100,
      precioVenta: 350,
      stock: 1,
      branchId: 2,
      contadorNombre: 'VICRIS',
    });

    jest.doMock('../../modules/firebase-admin', () => ({
      getFirestore: () => ({
        collection: () => ({
          doc: () => ({
            collection: () => ({
              where: () => ({
                get: async () => ({ empty: false, docs: [pendingDoc] }),
              }),
            }),
          }),
        }),
      }),
    }));
  });

  afterEach(() => {
    delete process.env.TECNO_CAJA_LICENSE_UID;
    jest.dontMock('../../modules/firebase-admin');
  });

  it('marca como aplicado un producto pendiente que ya existe en la sucursal', async () => {
    const { createApplyPendingProductsService } = require('../../server/sync/apply-pending-products');
    const query = jest.fn(async (sql) => {
      const text = String(sql || '');
      if (text.includes('FROM branches')) return [{ id: 2 }];
      if (text.includes('FROM products')) return [{ id: 44, codigo: '008', nombre: 'prueba 8', branch_id: 2 }];
      return [];
    });
    const createProductInTransaction = jest.fn();

    const service = createApplyPendingProductsService({
      createProductInTransaction,
      withTransaction: jest.fn(),
      writeAuditLog: jest.fn(),
      query,
      decodeDataUrlImage: jest.fn(),
      saveProductImageBuffer: jest.fn(),
    });

    const result = await service.applyPendingProductRequests();

    expect(result).toEqual({ ok: true, applied: 1, failed: 0 });
    expect(createProductInTransaction).not.toHaveBeenCalled();
    expect(pendingDoc.ref.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'aplicado',
      localProductId: 44,
      duplicateResolved: true,
    }));
  });

  it('crea el producto sin control de inventario si el Portal lo pidió así', async () => {
    pendingDoc = createPendingDoc({
      codigo: '009', nombre: 'Servicio de envío', precioVenta: 150, stock: 0, tracksStock: false, contadorNombre: 'VICRIS',
    });
    const { createApplyPendingProductsService } = require('../../server/sync/apply-pending-products');
    const query = jest.fn(async () => []);
    const createProductInTransaction = jest.fn(async () => ({ row: { id: 77 } }));
    const service = createApplyPendingProductsService({
      createProductInTransaction,
      withTransaction: jest.fn(async (fn) => fn({ query: jest.fn() })),
      writeAuditLog: jest.fn(),
      query,
      decodeDataUrlImage: jest.fn(),
      saveProductImageBuffer: jest.fn(),
    });

    const result = await service.applyPendingProductRequests();

    expect(result).toEqual({ ok: true, applied: 1, failed: 0 });
    expect(createProductInTransaction.mock.calls[0][1].data.tracksStock).toBe(false);
  });

  it('una solicitud vieja (sin el dato) sigue controlando inventario', async () => {
    const { createApplyPendingProductsService } = require('../../server/sync/apply-pending-products');
    const query = jest.fn(async (sql) => (String(sql).includes('FROM branches') ? [{ id: 2 }] : []));
    const createProductInTransaction = jest.fn(async () => ({ row: { id: 78 } }));
    const service = createApplyPendingProductsService({
      createProductInTransaction,
      withTransaction: jest.fn(async (fn) => fn({ query: jest.fn() })),
      writeAuditLog: jest.fn(),
      query,
      decodeDataUrlImage: jest.fn(),
      saveProductImageBuffer: jest.fn(),
    });

    await service.applyPendingProductRequests();

    expect(createProductInTransaction.mock.calls[0][1].data.tracksStock).toBe(true);
  });

  it('al editar sin control de inventario no pisa el stock que tiene el POS', async () => {
    pendingDoc = createPendingDoc({
      accion: 'editar', productoId: 44, codigo: '008', nombre: 'prueba 8', precioVenta: 350, stock: 0, stockMin: 0,
      tracksStock: false, contadorNombre: 'VICRIS',
    });
    const { createApplyPendingProductsService } = require('../../server/sync/apply-pending-products');
    const query = jest.fn(async (sql) => {
      const text = String(sql || '');
      if (text.includes('SELECT id FROM products WHERE id')) return [{ id: 44 }];
      return [];
    });
    const conn = { query: jest.fn() };
    const service = createApplyPendingProductsService({
      createProductInTransaction: jest.fn(),
      withTransaction: jest.fn(async (fn) => fn(conn)),
      writeAuditLog: jest.fn(),
      query,
      decodeDataUrlImage: jest.fn(),
      saveProductImageBuffer: jest.fn(),
    });

    const result = await service.applyPendingProductRequests();

    expect(result).toEqual({ ok: true, applied: 1, failed: 0 });
    const [sql, params] = conn.query.mock.calls[0];
    expect(sql).toMatch(/stock = CASE WHEN \? = 1 THEN \? ELSE stock END/);
    expect(sql).toMatch(/tracks_stock = \?/);
    // controla=0 en el CASE del stock, del mínimo y en tracks_stock.
    expect(params.slice(7, 12)).toEqual([0, 0, 0, 0, 0]);
  });

  it('rechaza un producto local si la sucursal indicada ya no existe', async () => {
    const { createApplyPendingProductsService } = require('../../server/sync/apply-pending-products');
    const query = jest.fn(async (sql) => {
      const text = String(sql || '');
      if (text.includes('FROM branches')) return [];
      if (text.includes('FROM products')) return [];
      return [];
    });
    const createProductInTransaction = jest.fn();

    const service = createApplyPendingProductsService({
      createProductInTransaction,
      withTransaction: jest.fn(),
      writeAuditLog: jest.fn(),
      query,
      decodeDataUrlImage: jest.fn(),
      saveProductImageBuffer: jest.fn(),
    });

    const result = await service.applyPendingProductRequests();

    expect(result).toEqual({ ok: true, applied: 0, failed: 1 });
    expect(createProductInTransaction).not.toHaveBeenCalled();
    expect(pendingDoc.ref.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      errorMessage: expect.stringContaining('La sucursal seleccionada (2)'),
    }));
  });
});
