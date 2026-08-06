'use strict';

const express = require('express');
const request = require('supertest');

const createOfflineRouter = require('../../server/routes/offline.routes');

function buildRouter({ query, localQuery, terminalConfig } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/offline', createOfflineRouter({
    query: query || (async () => []),
    localQuery,
    localCacheStatus: async () => ({}),
    generateOfflineId: async () => 'OFF-1',
    generateOfflineRef: () => 'PROD-term-1#1',
    logSyncEvent: async () => {},
    resolveUser: async () => ({ id: 7, usuario: 'admin' }),
    getTerminalConfig: () => terminalConfig || {
      terminalId: 'term-1',
      branchId: 2,
      cashRegisterId: 5,
      principalHost: '100.64.0.1',
      principalBaseUrl: 'http://100.64.0.1:3399',
      isMain: false
    },
    ensurePromotionsExtensions: async () => {},
    resolveInventoryBranchId: async (_conn, branchId) => branchId,
    changeBranchInventoryStock: async () => ({ previousStock: 0, nextStock: 4 }),
    getNextNcfFromSequence: async () => null,
    isInvoiceNumberCollisionError: () => false
  }));
  return app;
}

describe('offline product sync', () => {
  it('crea un producto local de sucursal y lo deja pendiente de sincronizar', async () => {
    const cache = new Map();
    const pending = [];
    const localQuery = jest.fn(async (sql, params = []) => {
      if (/INSERT INTO pending_product_changes/i.test(sql)) {
        pending.push({
          terminal_id: params[0],
          change_type: params[1],
          offline_product_id: params[2],
          product_id: params[3],
          branch_id: params[4],
          offline_ref: params[5],
          payload_json: params[6],
          status: 'pending'
        });
        return { insertId: 1, rowsAffected: 1 };
      }
      if (/INSERT INTO offline_cache_products/i.test(sql)) {
        cache.set(Number(params[0]), {
          product_id: Number(params[0]),
          codigo: params[1],
          nombre: params[2],
          categoria: params[3],
          precio_venta: params[4],
          stock_cached: params[5],
          stock_min: params[6],
          estado: params[7]
        });
        return { rowsAffected: 1 };
      }
      if (/SELECT \* FROM offline_cache_products/i.test(sql)) {
        return [cache.get(Number(params[0]))].filter(Boolean);
      }
      return [];
    });

    const app = buildRouter({ localQuery });
    const res = await request(app)
      .post('/api/offline/product-save')
      .send({ codigo: 'YAM-1', nombre: 'Producto Yamasa', precioVenta: 120, stock: 4 })
      .expect(201);

    expect(res.body.id).toBeLessThan(0);
    expect(res.body.branchId).toBe(2);
    expect(res.body.pendingSync).toBe(true);
    expect(pending).toHaveLength(1);
    expect(JSON.parse(pending[0].payload_json)).toMatchObject({
      codigo: 'YAM-1',
      nombre: 'Producto Yamasa',
      branchId: 2
    });
  });

  it('sincroniza productos locales antes de procesar ventas pendientes', async () => {
    const pending = [{
      id: 1,
      terminal_id: 'term-1',
      change_type: 'create',
      offline_product_id: -123,
      product_id: null,
      branch_id: 2,
      offline_ref: 'PROD-term-1#1',
      payload_json: JSON.stringify({
        codigo: 'YAM-2',
        barcode: 'YAM-2',
        nombre: 'Producto Sync',
        categoria: 'GENERAL',
        precioVenta: 150,
        stock: 3,
        branchId: 2
      }),
      status: 'pending'
    }];
    const mapped = [];
    const statusById = new Map([[1, 'pending']]);
    const insertedProducts = [];

    const localQuery = jest.fn(async (sql, params = []) => {
      if (/SELECT \* FROM pending_product_changes/i.test(sql)) {
        return pending.filter((row) => statusById.get(row.id) === 'pending');
      }
      if (/UPDATE pending_product_changes SET status = \?/i.test(sql)) {
        statusById.set(Number(params[1]), params[0]);
        return { rowsAffected: 1 };
      }
      if (/INSERT OR IGNORE INTO offline_product_sync_map/i.test(sql)) {
        mapped.push({ offlineProductId: params[0], realProductId: params[1], branchId: params[3] });
        return { rowsAffected: 1 };
      }
      if (/SELECT product_id FROM offline_cache_products WHERE product_id = \?/i.test(sql)) return [];
      if (/UPDATE offline_cache_products SET product_id = \?/i.test(sql)) return { rowsAffected: 1 };
      if (/UPDATE pending_sale_items SET product_id = \?/i.test(sql)) return { rowsAffected: 0 };
      if (/UPDATE pending_product_changes SET status = 'synced'/i.test(sql)) {
        statusById.set(Number(params[1]), 'synced');
        return { rowsAffected: 1 };
      }
      if (/SELECT \* FROM pending_sales/i.test(sql)) return [];
      if (/INSERT INTO offline_cache_products/i.test(sql)) return { rowsAffected: 1 };
      if (/UPDATE offline_terminal_cache/i.test(sql)) return { rowsAffected: 1 };
      return [];
    });

    const query = jest.fn(async (sql, params = []) => {
      if (/SELECT \* FROM products/i.test(sql) && /LOWER\(codigo\)/i.test(sql)) return [];
      if (/INSERT INTO products/i.test(sql)) {
        insertedProducts.push(params);
        return { insertId: 42 };
      }
      if (/SELECT \* FROM products WHERE id = \?/i.test(sql)) {
        return [{ id: Number(params[0]), codigo: 'YAM-2', nombre: 'Producto Sync', branch_id: 2 }];
      }
      if (/SELECT id, codigo, nombre/i.test(sql)) return [];
      return [];
    });

    const app = buildRouter({ query, localQuery });
    const res = await request(app).post('/api/offline/sync-pending').send({}).expect(200);

    expect(res.body.ok).toBe(true);
    expect(insertedProducts).toHaveLength(1);
    expect(mapped).toEqual([{ offlineProductId: -123, realProductId: 42, branchId: 2 }]);
    expect(statusById.get(1)).toBe('synced');
  });
});
