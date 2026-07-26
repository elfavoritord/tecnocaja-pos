'use strict';

jest.mock('../../modules/firebase-admin', () => {
  const set = jest.fn();
  const node = {};
  const doc = jest.fn(() => node);
  const collection = jest.fn(() => node);
  Object.assign(node, { set, doc, collection });
  return {
    getFirestore: () => ({ collection }),
    getAuth: () => null,
    __syncMocks: { set, doc, collection },
  };
});

describe('firebase reports product contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('incluye businessId y el contrato que consume la app móvil', async () => {
    const reportsSync = require('../../modules/firebase-reports-sync');
    const { __syncMocks } = require('../../modules/firebase-admin');

    await reportsSync.syncProduct({
      id: 42,
      codigo: 'SKU-42',
      nombre: 'Producto móvil',
      categoria: 'General',
      precio_venta: 125,
      precio_compra: 80,
      stock: 7,
      stock_min: 2,
      estado: 'Activo',
    }, {
      config: {
        license_uid: 'pos:empresa-demo',
        nombre: 'Empresa Demo',
      },
      branchId: 3,
    });

    expect(__syncMocks.collection).toHaveBeenCalledWith('businesses');
    expect(__syncMocks.doc).toHaveBeenCalledWith('42');
    expect(__syncMocks.set).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: expect.any(String),
        name: 'Producto móvil',
        sku: 'SKU-42',
        price: 125,
        stock: 7,
        branchId: '3',
        origin: 'pos',
        syncStatus: 'synced',
      }),
      { merge: true }
    );
  });

  it('incluye businessId al publicar clientes del POS', async () => {
    const reportsSync = require('../../modules/firebase-reports-sync');
    const { __syncMocks } = require('../../modules/firebase-admin');

    await reportsSync.syncCustomer({
      id: 9,
      nombre: 'Cliente compartido',
      telefono: '8095550000',
      balance: 25,
      limite_credito: 100,
    }, {
      config: { license_uid: 'pos:empresa-demo' },
    });

    expect(__syncMocks.set).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: expect.any(String),
        name: 'Cliente compartido',
        phone: '8095550000',
        totalDebt: 25,
        creditLimit: 100,
      }),
      { merge: true }
    );
  });
});
