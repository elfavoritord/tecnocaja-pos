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
});
