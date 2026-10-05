'use strict';

/**
 * server/sales/sale-idempotency.js
 *
 * Evita ventas duplicadas en multicaja/LAN.
 *
 * Cada intento de cobro trae un identificador propio (clientRequestId) que la
 * caja genera y REPITE si el cajero reintenta la misma venta (respuesta
 * perdida en la red, tiempo agotado, doble clic). El servidor lo guarda en
 * sales.client_request_id con índice ÚNICO:
 *   - si ya existe una venta con ese identificador, devuelve esa venta en vez
 *     de crear otra;
 *   - si dos peticiones iguales llegan a la vez, la segunda choca con el índice
 *     dentro de su transacción (se deshace completa: ni factura, ni NCF, ni
 *     inventario) y también recibe la venta ya creada.
 * La misma columna protege la venta guardada en modo contingencia que luego
 * se sincroniza (server/routes/offline.routes.js).
 */

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function normalizeClientRequestId(value) {
  const text = String(value || '').trim();
  return CLIENT_REQUEST_ID_PATTERN.test(text) ? text : null;
}

function isDuplicateClientRequestError(error) {
  const text = [error?.code, error?.message, error?.sqlMessage].filter(Boolean).join(' ');
  if (!/client_request_id/i.test(text)) return false;
  return /ER_DUP_ENTRY|Duplicate entry|UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(text);
}

function createSaleIdempotency({ query, addColumnIfMissing, mapSaleRows, getConfig } = {}) {
  let ensured = null;

  function ensureSchema() {
    if (!ensured) {
      ensured = (async () => {
        await addColumnIfMissing('sales', 'client_request_id', 'VARCHAR(64) DEFAULT NULL');
        await query('CREATE UNIQUE INDEX idx_sales_client_request_id ON sales (client_request_id)').catch(() => {});
      })().catch((error) => {
        ensured = null;
        throw error;
      });
    }
    return ensured;
  }

  async function findSaleIdByClientRequestId(clientRequestId) {
    if (!clientRequestId) return null;
    await ensureSchema();
    const rows = await query('SELECT id FROM sales WHERE client_request_id = ? LIMIT 1', [clientRequestId]);
    return rows[0] ? Number(rows[0].id) : null;
  }

  // Misma forma de respuesta que POST /api/sales al crear la venta.
  async function buildExistingSaleResponse(saleId) {
    const rows = await query(
      'SELECT s.*, u.nombre AS cashier_name, COALESCE(c.nombre, "Consumidor Final") AS client_name, COALESCE(c.telefono, "") AS client_phone FROM sales s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN clients c ON c.id = s.client_id WHERE s.id = ?',
      [saleId]
    );
    if (!rows.length) return null;
    const items = await query(
      `SELECT si.*, COALESCE(si.item_name, p.nombre, 'Producto') AS product_name,
              p.codigo AS product_code, p.categoria, p.precio_compra
       FROM sale_items si
       LEFT JOIN products p ON p.id = si.product_id
       WHERE sale_id = ?`,
      [saleId]
    );
    return {
      sale: mapSaleRows(rows, items)[0],
      ecf: null,
      config: await getConfig({ syncRemote: false }),
      updatedClient: null,
      duplicate: true,
    };
  }

  async function findExistingSaleResponse(clientRequestId) {
    const saleId = await findSaleIdByClientRequestId(clientRequestId);
    return saleId ? buildExistingSaleResponse(saleId) : null;
  }

  return {
    ensureSchema,
    findSaleIdByClientRequestId,
    findExistingSaleResponse,
    buildExistingSaleResponse,
  };
}

module.exports = {
  createSaleIdempotency,
  normalizeClientRequestId,
  isDuplicateClientRequestError,
};
