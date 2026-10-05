'use strict';

/**
 * tests/services/sale-idempotency.test.js
 *
 * La misma venta reenviada (respuesta perdida en la red, doble clic,
 * reintento) no se registra dos veces.
 */

const fs = require('fs');
const path = require('path');
const {
  createSaleIdempotency,
  normalizeClientRequestId,
  isDuplicateClientRequestError,
} = require('../../server/sales/sale-idempotency');

describe('normalizeClientRequestId', () => {
  test('acepta identificadores seguros y rechaza el resto', () => {
    expect(normalizeClientRequestId('v0123456789abcdef0123456789abcdef')).toBe('v0123456789abcdef0123456789abcdef');
    expect(normalizeClientRequestId('  abc12345  ')).toBe('abc12345');
    expect(normalizeClientRequestId('corto')).toBeNull();
    expect(normalizeClientRequestId("x'; DROP TABLE sales;--")).toBeNull();
    expect(normalizeClientRequestId(null)).toBeNull();
    expect(normalizeClientRequestId('a'.repeat(65))).toBeNull();
  });
});

describe('isDuplicateClientRequestError', () => {
  test('reconoce el duplicado del intento en MariaDB/MySQL y SQLite', () => {
    expect(isDuplicateClientRequestError({ code: 'ER_DUP_ENTRY', message: "Duplicate entry 'v1' for key 'idx_sales_client_request_id'" })).toBe(true);
    expect(isDuplicateClientRequestError({ message: 'UNIQUE constraint failed: sales.client_request_id' })).toBe(true);
  });

  test('no confunde otros duplicados (número de factura, cédula)', () => {
    expect(isDuplicateClientRequestError({ code: 'ER_DUP_ENTRY', message: "Duplicate entry 'FAC-1' for key 'invoice_number'" })).toBe(false);
    expect(isDuplicateClientRequestError({ message: 'connect ECONNREFUSED' })).toBe(false);
  });
});

describe('createSaleIdempotency', () => {
  function build(rowsBySql) {
    const calls = [];
    const query = jest.fn(async (sql, params) => {
      calls.push({ sql, params });
      for (const [pattern, rows] of rowsBySql) {
        if (pattern.test(sql)) return typeof rows === 'function' ? rows(params) : rows;
      }
      return [];
    });
    const addColumnIfMissing = jest.fn(async () => {});
    const mapSaleRows = jest.fn((rows, items) => rows.map((row) => ({ id: row.invoice_number, items: items.length })));
    const getConfig = jest.fn(async () => ({ moneda: 'RD$' }));
    const service = createSaleIdempotency({ query, addColumnIfMissing, mapSaleRows, getConfig });
    return { service, query, addColumnIfMissing, calls, getConfig };
  }

  test('crea la columna y el índice único una sola vez', async () => {
    const { service, addColumnIfMissing, calls } = build([]);
    await service.ensureSchema();
    await service.ensureSchema();
    expect(addColumnIfMissing).toHaveBeenCalledTimes(1);
    expect(addColumnIfMissing).toHaveBeenCalledWith('sales', 'client_request_id', 'VARCHAR(64) DEFAULT NULL');
    expect(calls.filter((c) => /CREATE UNIQUE INDEX idx_sales_client_request_id/.test(c.sql))).toHaveLength(1);
  });

  test('si el intento ya existe, devuelve la venta registrada (misma forma que al crearla)', async () => {
    const { service, getConfig } = build([
      [/WHERE client_request_id = \?/, [{ id: 41 }]],
      [/FROM sales s/, [{ id: 41, invoice_number: 'FAC-00000041' }]],
      [/FROM sale_items/, [{ id: 1 }, { id: 2 }]],
    ]);
    const response = await service.findExistingSaleResponse('v0123456789abcdef');
    expect(response.duplicate).toBe(true);
    expect(response.sale).toEqual({ id: 'FAC-00000041', items: 2 });
    expect(getConfig).toHaveBeenCalledWith({ syncRemote: false });
  });

  test('si el intento es nuevo, no hay venta previa', async () => {
    const { service } = build([[/WHERE client_request_id = \?/, []]]);
    await expect(service.findExistingSaleResponse('v0123456789abcdef')).resolves.toBeNull();
  });
});

describe('cableado en el servidor y en la caja', () => {
  const root = path.resolve(__dirname, '..', '..');
  const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const ventasSrc = fs.readFileSync(path.join(root, 'js', 'ventas.js'), 'utf8');
  const offlineSrc = fs.readFileSync(path.join(root, 'server', 'routes', 'offline.routes.js'), 'utf8');

  test('POST /api/sales revisa el intento antes y marca la venta dentro de la transacción', () => {
    const start = serverSrc.indexOf("app.post('/api/sales', async (req, res) => {");
    const block = serverSrc.slice(start, start + 120000);
    expect(block.indexOf('saleIdempotency.findExistingSaleResponse(clientRequestId)')).toBeLessThan(block.indexOf('withTransactionRetry(async (conn)'));
    expect(block).toContain("await conn.query('UPDATE sales SET client_request_id = ? WHERE id = ?', [clientRequestId, result.insertId]);");
    expect(block).toContain('isDuplicateClientRequestError(error)');
  });

  test('la caja manda el mismo identificador al reintentar la misma venta', () => {
    expect(ventasSrc).toContain('venta.clientRequestId = _resolveSaleAttemptKey(venta);');
    expect(ventasSrc).toContain('_saleAttempt = null;');
    expect(ventasSrc).toContain('getRandomValues');
  });

  test('la venta de contingencia se deduplica dentro de su transacción', () => {
    const tx = offlineSrc.indexOf('const result = await withTransaction(async (conn) => {');
    const mapInsert = offlineSrc.indexOf('INSERT INTO offline_sync_map (offline_id, real_invoice_id', tx);
    const saleInsert = offlineSrc.indexOf('const insertSql = `INSERT INTO sales', tx);
    expect(mapInsert).toBeGreaterThan(tx);
    expect(mapInsert).toBeLessThan(saleInsert);
    expect(offlineSrc).toContain("UPDATE sales SET client_request_id = ? WHERE id = ?");
    expect(offlineSrc).toContain('if (saleErr.alreadySynced) {');
  });
});
