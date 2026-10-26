'use strict';

const mockFirestoreState = {
  writes: [],
  commitCalls: 0,
  failCommitNumber: null,
};

function mockMakeDocRef(path) {
  return {
    path,
    set: jest.fn((data, options) => {
      mockFirestoreState.writes.push({ op: 'directSet', path, data, options });
      return Promise.resolve();
    }),
    collection(name) {
      return mockMakeCollectionRef(`${path}/${name}`);
    },
  };
}

function mockMakeCollectionRef(path) {
  return {
    path,
    doc(id) {
      return mockMakeDocRef(`${path}/${id}`);
    },
    async get() {
      return { docs: [] };
    },
  };
}

jest.mock('../../modules/firebase-admin', () => ({
  getFirestore: () => ({
    collection(name) {
      return mockMakeCollectionRef(name);
    },
    batch() {
      return {
        set(ref, data) {
          mockFirestoreState.writes.push({ op: 'batchSet', path: ref.path, data });
        },
        delete(ref) {
          mockFirestoreState.writes.push({ op: 'batchDelete', path: ref.path });
        },
        async commit() {
          mockFirestoreState.commitCalls += 1;
          if (mockFirestoreState.failCommitNumber === mockFirestoreState.commitCalls) {
            throw new Error('fallo escribiendo Firestore');
          }
        },
      };
    },
  }),
}));

jest.mock('../../db', () => ({
  query: jest.fn(async (sql) => {
    const text = String(sql || '');

    if (text.includes('SELECT business_name, rnc')) {
      return [{
        business_name: 'Demo POS',
        rnc: '131880681',
        phone: '809-000-0000',
        business_type: 'colmado',
        trial_started_at: '2026-08-01 00:00:00',
        trial_ends_at: '2026-08-31 00:00:00',
      }];
    }
    if (text.includes('administrador_general')) return [{ nombre: 'Admin Demo', email: 'admin@demo.test' }];
    if (text.includes('FROM cash_registers cr')) return [{ id: 7, branch_id: 1, nombre: 'Caja Principal', codigo: 'CP-1', estado: 'Activa', tipo_caja: 'mixta' }];
    if (text.includes('FROM branches')) return [{ id: 1, nombre: 'Principal' }];
    if (text.includes('FROM ncf_authorized_sequences')) return [];
    if (text.includes('FROM svc_services s')) {
      return [{ id: 5, codigo: 'MANT-01', nombre: 'Mantenimiento', descripcion: 'Limpieza', categoria: 'Soporte', precio: 1500, itbisPct: 18, unidad: 'visita', vendidos: 3 }];
    }
    if (text.includes('FROM ecf_sequences es')) {
      return [{
        id: 13, business_id: 1, branch_id: null, tipo_comprobante: 'E32', numero_inicial: 1, numero_final: 100,
        proximo_numero: 2, activo: 1, environment: 'ecf', authorization_reference: '6005604697',
        fecha_autorizacion: '2026-10-25', fecha_vencimiento: null, created_at: '2026-10-25 12:00:00', updated_at: '2026-10-25 12:00:00',
      }];
    }

    if (text.includes('SUM(total)') || text.includes('COUNT(*) AS cnt') || text.includes('SUM(tax)')) {
      return [{ total: 100, cnt: 1 }];
    }
    if (text.includes('FROM products WHERE LOWER')) return [{ cnt: 2 }];
    if (text.includes('stock_min > 0')) return [{ cnt: 0 }];

    if (text.includes('s.invoice_number') && text.includes('AS factura') && !text.includes('AS costo_venta')) {
      return [{
        fecha: '2026-08-06 10:00:00',
        factura: 'FAC-10',
        branch_id: 1,
        branchId: 1,
        sucursal: 'Principal',
        cajero: 'Admin Demo',
        cliente: 'Consumidor Final',
        metodo_pago: 'efectivo',
        total: 118,
        itbis: 18,
      }];
    }
    if (text.includes('FROM sales s') && text.includes('AS costo_venta')) {
      return [{ id: 10, fecha: '2026-08-06 10:00:00', factura: 'FAC-10', metodo_pago: 'efectivo', subtotal: 100, itbis: 18, total: 118, cliente: 'Consumidor Final', costo_venta: 60 }];
    }
    if (text.includes('FROM supplier_invoices')) {
      return [{ id: 20, fecha: '2026-08-06', numero: 'SUP-20', ncf: 'B0100000001', total: 500, itbis: 76.27, proveedor: 'Proveedor Demo', metodo_pago: 'Efectivo' }];
    }
    if (text.includes('FROM cash_movements cm')) return [];
    if (text.includes('FROM expenses e')) {
      return [{ id: 30, fecha: '2026-08-06', categoria: 'Servicios', descripcion: 'Internet', monto: 1500, registrado_por: 'Admin Demo', origen: 'gastos_fiscal', ncf: 'B0100000002', itbis: 228.81 }];
    }
    if (text.includes('FROM cash_sessions cs') && text.includes('total_metodo')) {
      return [{ session_id: 40, opened_at: '2026-08-06 09:00:00', closed_at: '2026-08-06 18:00:00', status: 'closed', expected_amount: 118, counted_amount: 118, difference_amount: 0, metodo_pago: 'efectivo', total_metodo: 118 }];
    }

    return [];
  }),
}));

describe('sync-pos-stats contabilidad', () => {
  beforeEach(() => {
    jest.resetModules();
    mockFirestoreState.writes = [];
    mockFirestoreState.commitCalls = 0;
    mockFirestoreState.failCommitNumber = null;
    process.env.TECNO_CAJA_LICENSE_UID = 'pos_demo_1';
  });

  afterEach(() => {
    delete process.env.TECNO_CAJA_LICENSE_UID;
  });

  it('escribe el feed contable crudo para el Portal del Contador', async () => {
    const { syncPosStatsToFirestore } = require('../../server/sync/sync-pos-stats');

    const result = await syncPosStatsToFirestore();

    expect(result.ok).toBe(true);
    expect(mockFirestoreState.writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'licencias/pos_demo_1/contabilidad_raw/ventas' }),
      expect.objectContaining({ path: 'licencias/pos_demo_1/contabilidad_raw/compras' }),
      expect.objectContaining({ path: 'licencias/pos_demo_1/contabilidad_raw/gastos' }),
      expect.objectContaining({ path: 'licencias/pos_demo_1/contabilidad_raw/cierres' }),
    ]));
    expect(mockFirestoreState.writes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'licencias/pos_demo_1',
        data: expect.objectContaining({
          sucursales: [expect.objectContaining({
            id: 1,
            nombre: 'Principal',
            cajas: [expect.objectContaining({ id: 7, branchId: 1, nombre: 'Caja Principal' })],
          })],
        }),
      }),
      expect.objectContaining({
        path: 'licencias/pos_demo_1/reportes/ventas',
        data: expect.objectContaining({
          rows: [expect.objectContaining({ branch_id: 1, branchId: 1, sucursal: 'Principal' })],
        }),
      }),
    ]));
  });

  it('el espejo de secuencias del portal trae las e-NCF de producción (con lo usado) y avisa que las trae', async () => {
    const { syncPosStatsToFirestore } = require('../../server/sync/sync-pos-stats');

    await syncPosStatsToFirestore();

    expect(mockFirestoreState.writes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        op: 'batchSet',
        path: 'licencias/pos_demo_1/ncf_aplicadas/ecf-13',
        data: expect.objectContaining({
          series: 'E', documentType: 'E32', startNumber: 1, endNumber: 100, nextNumber: 2, totalUsed: 1, totalAvailable: 99, readOnly: true,
        }),
      }),
      expect.objectContaining({ op: 'directSet', path: 'licencias/pos_demo_1', data: expect.objectContaining({ ncfEspejoVersion: 2 }) }),
    ]));
  });

  it('la pestaña Productos del portal trae también los servicios de la Empresa de Servicios', async () => {
    const { syncPosStatsToFirestore } = require('../../server/sync/sync-pos-stats');

    await syncPosStatsToFirestore();

    const productos = mockFirestoreState.writes.find((w) => w.path === 'licencias/pos_demo_1/reportes/productos');
    expect(productos.data.rows).toEqual(expect.arrayContaining([expect.objectContaining({
      id: 'svc-5', tipo: 'servicio', codigo: 'MANT-01', nombre: 'Mantenimiento', categoria: 'Soporte',
      precio: 1500, itbisPct: 18, unidad: 'visita', vendidos: 3, stock: null,
    })]));
    expect(mockFirestoreState.writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'directSet', path: 'licencias/pos_demo_1', data: expect.objectContaining({ serviciosPortalVersion: 1 }) }),
    ]));
  });

  it('reporta error si falla la escritura del feed contable', async () => {
    mockFirestoreState.failCommitNumber = 2;
    const { syncPosStatsToFirestore } = require('../../server/sync/sync-pos-stats');

    const result = await syncPosStatsToFirestore();

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/fallo escribiendo Firestore/);
  });
});
