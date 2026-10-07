'use strict';

/**
 * server/sync/control-center/queries.js
 *
 * Consultas de solo lectura para el Centro de Control. Usan las MISMAS reglas
 * de negocio que los reportes avanzados del POS (server.js, "REPORTES
 * AVANZADOS v2.0"), para que la app nunca muestre un número distinto al POS:
 *   - venta válida: fiscal_status <> 'cancelada' y sale_status = 'pagada'
 *   - sucursal / caja / usuario: los "billed_*" con respaldo en los campos viejos
 *   - costo: precio_compra actual del producto (igual que /kpis y /ganancias)
 *
 * SQL portable MariaDB/SQLite (db.js traduce strftime('%H:00', ...)). Todos
 * los valores van con placeholders.
 */

const { OUTFLOW_TYPES } = require('./labels');

const ACTIVE = `COALESCE(s.fiscal_status,'emitida') <> 'cancelada' AND COALESCE(s.sale_status,'pagada') = 'pagada'`;
const BRANCH = 'COALESCE(s.billed_branch_id, s.branch_id)';
const REGISTER = 'COALESCE(s.billed_cash_register_id, s.cash_register_id)';
const USER = 'COALESCE(s.billed_by_user_id, s.user_id)';

function placeholders(list) {
  return list.map(() => '?').join(', ');
}

// ── Hechos diarios de ventas ────────────────────────────────────────────────

function salesTotalsByDay(query, from, to) {
  return query(
    `SELECT DATE(s.created_at) AS d, ${BRANCH} AS b,
            COUNT(*) AS n,
            COALESCE(SUM(s.total), 0) AS total,
            COALESCE(SUM(s.tax), 0) AS tax,
            COALESCE(SUM(s.discount), 0) AS discount
       FROM sales s
      WHERE s.created_at BETWEEN ? AND ? AND ${ACTIVE}
      GROUP BY DATE(s.created_at), ${BRANCH}`,
    [from, to]
  );
}

async function salesDimsByDay(query, from, to) {
  const build = (withNcf) => `
    SELECT DATE(s.created_at) AS d, ${BRANCH} AS b, ${USER} AS u, ${REGISTER} AS r,
           COALESCE(s.payment_method, 'efectivo') AS pm,
           COALESCE(s.order_type, 'mostrador') AS ot,
           COALESCE(s.document_type, 'ticket') AS dt,
           ${withNcf ? 's.ncf_type' : 'NULL'} AS nt,
           COUNT(*) AS n,
           COALESCE(SUM(s.total), 0) AS total
      FROM sales s
     WHERE s.created_at BETWEEN ? AND ? AND ${ACTIVE}
     GROUP BY DATE(s.created_at), ${BRANCH}, ${USER}, ${REGISTER},
              COALESCE(s.payment_method, 'efectivo'), COALESCE(s.order_type, 'mostrador'),
              COALESCE(s.document_type, 'ticket')${withNcf ? ', s.ncf_type' : ''}`;
  try {
    return await query(build(true), [from, to]);
  } catch (_error) {
    // Instalación vieja sin la columna ncf_type todavía.
    return query(build(false), [from, to]);
  }
}

function salesHoursByDay(query, from, to) {
  return query(
    `SELECT DATE(s.created_at) AS d, ${BRANCH} AS b,
            strftime('%H:00', s.created_at) AS h,
            COUNT(*) AS n,
            COALESCE(SUM(s.total), 0) AS total
       FROM sales s
      WHERE s.created_at BETWEEN ? AND ? AND ${ACTIVE}
      GROUP BY DATE(s.created_at), ${BRANCH}, strftime('%H:00', s.created_at)`,
    [from, to]
  );
}

async function itemsByDay(query, from, to) {
  const build = (withItemName) => `
    SELECT DATE(s.created_at) AS d, ${BRANCH} AS b, si.product_id AS pid,
           MAX(COALESCE(${withItemName ? 'si.item_name, ' : ''}p.nombre, '')) AS name,
           MAX(COALESCE(p.categoria, '')) AS cat,
           COALESCE(SUM(si.qty), 0) AS qty,
           COALESCE(SUM(si.line_total), 0) AS rev,
           COALESCE(SUM(CASE WHEN COALESCE(p.precio_compra, 0) > 0 THEN si.line_total ELSE 0 END), 0) AS cov_rev,
           COALESCE(SUM(CASE WHEN COALESCE(p.precio_compra, 0) > 0 THEN si.qty * p.precio_compra ELSE 0 END), 0) AS cov_cost
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      LEFT JOIN products p ON p.id = si.product_id
     WHERE s.created_at BETWEEN ? AND ? AND ${ACTIVE}
     GROUP BY DATE(s.created_at), ${BRANCH}, si.product_id`;
  try {
    return await query(build(true), [from, to]);
  } catch (_error) {
    // Base vieja sin sale_items.item_name (ventas rápidas).
    return query(build(false), [from, to]);
  }
}

function cancelledByDay(query, from, to) {
  return query(
    `SELECT DATE(s.created_at) AS d, ${BRANCH} AS b,
            COALESCE(s.canceled_by_user_id, ${USER}) AS u,
            COUNT(*) AS n,
            COALESCE(SUM(s.total), 0) AS total
       FROM sales s
      WHERE s.created_at BETWEEN ? AND ?
        AND COALESCE(s.fiscal_status, 'emitida') = 'cancelada'
      GROUP BY DATE(s.created_at), ${BRANCH}, COALESCE(s.canceled_by_user_id, ${USER})`,
    [from, to]
  );
}

function returnsByDay(query, from, to) {
  return query(
    `SELECT DATE(sr.returned_at) AS d, sr.branch_id AS b, sr.returned_by_user_id AS u,
            COUNT(*) AS n,
            COALESCE(SUM(sr.returned_amount), 0) AS total
       FROM sale_returns sr
      WHERE sr.returned_at BETWEEN ? AND ?
      GROUP BY DATE(sr.returned_at), sr.branch_id, sr.returned_by_user_id`,
    [from, to]
  );
}

function collectionsByDay(query, from, to) {
  return query(
    `SELECT DATE(ccp.created_at) AS d, ccp.branch_id AS b,
            COALESCE(ccp.payment_method, 'efectivo') AS pm,
            ccp.created_by_user_id AS u, ccp.cash_register_id AS r,
            COUNT(*) AS n,
            COALESCE(SUM(ccp.amount), 0) AS total
       FROM client_credit_payments ccp
      WHERE ccp.created_at BETWEEN ? AND ?
      GROUP BY DATE(ccp.created_at), ccp.branch_id, COALESCE(ccp.payment_method, 'efectivo'),
               ccp.created_by_user_id, ccp.cash_register_id`,
    [from, to]
  );
}

function expensesByDay(query, fromDay, toDay) {
  return query(
    `SELECT DATE(e.fecha) AS d, e.branch_id AS b,
            COALESCE(NULLIF(e.categoria, ''), 'Otros') AS cat,
            COUNT(*) AS n,
            COALESCE(SUM(e.total), 0) AS total
       FROM expenses e
      WHERE DATE(e.fecha) BETWEEN ? AND ?
        AND COALESCE(e.estado, 'pagado') <> 'anulado'
      GROUP BY DATE(e.fecha), e.branch_id, COALESCE(NULLIF(e.categoria, ''), 'Otros')`,
    [fromDay, toDay]
  );
}

function outflowsByDay(query, from, to) {
  return query(
    `SELECT DATE(cm.happened_at) AS d, cm.branch_id AS b, cm.movement_type AS t,
            COUNT(*) AS n,
            COALESCE(SUM(ABS(cm.amount)), 0) AS total
       FROM cash_movements cm
      WHERE cm.happened_at BETWEEN ? AND ?
        AND cm.movement_type IN (${placeholders(OUTFLOW_TYPES)})
      GROUP BY DATE(cm.happened_at), cm.branch_id, cm.movement_type`,
    [from, to, ...OUTFLOW_TYPES]
  );
}

/** Primera compra de cada cliente por sucursal (para "clientes nuevos"). */
function customerFirstPurchases(query) {
  return query(
    `SELECT s.client_id AS c, ${BRANCH} AS b, MIN(s.created_at) AS first_at
       FROM sales s
      WHERE s.client_id IS NOT NULL AND ${ACTIVE}
      GROUP BY s.client_id, ${BRANCH}`
  );
}

/** Totales exactos de un tramo (comparaciones contra el período anterior). */
async function rangeTotals(query, from, to) {
  const [totals, items] = await Promise.all([
    query(
      `SELECT ${BRANCH} AS b, COUNT(*) AS n,
              COALESCE(SUM(s.total), 0) AS total,
              COALESCE(SUM(s.tax), 0) AS tax,
              COALESCE(SUM(s.discount), 0) AS discount
         FROM sales s
        WHERE s.created_at BETWEEN ? AND ? AND ${ACTIVE}
        GROUP BY ${BRANCH}`,
      [from, to]
    ),
    query(
      `SELECT ${BRANCH} AS b,
              COALESCE(SUM(si.line_total), 0) AS rev,
              COALESCE(SUM(CASE WHEN COALESCE(p.precio_compra, 0) > 0 THEN si.line_total ELSE 0 END), 0) AS cov_rev,
              COALESCE(SUM(CASE WHEN COALESCE(p.precio_compra, 0) > 0 THEN si.qty * p.precio_compra ELSE 0 END), 0) AS cov_cost
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         LEFT JOIN products p ON p.id = si.product_id
        WHERE s.created_at BETWEEN ? AND ? AND ${ACTIVE}
        GROUP BY ${BRANCH}`,
      [from, to]
    ),
  ]);
  return { totals, items };
}

/** Ventas por mes (gráfico de 13 meses). Solo la tabla sales: es liviano. */
function salesByMonth(query, from) {
  return query(
    `SELECT SUBSTR(s.created_at, 1, 7) AS m, ${BRANCH} AS b,
            COUNT(*) AS n,
            COALESCE(SUM(s.total), 0) AS total,
            COALESCE(SUM(s.tax), 0) AS tax
       FROM sales s
      WHERE s.created_at >= ? AND ${ACTIVE}
      GROUP BY SUBSTR(s.created_at, 1, 7), ${BRANCH}`,
    [from]
  );
}

/** Ventas guardadas pero todavía sin cobrar (facturación separada / pendiente de cobro). */
function pendingChargeSales(query) {
  return query(
    `SELECT ${BRANCH} AS b, COUNT(*) AS n, COALESCE(SUM(s.total), 0) AS total
       FROM sales s
      WHERE COALESCE(s.sale_status, 'pagada') IN ('pendiente', 'pendiente_cobro')
        AND COALESCE(s.fiscal_status, 'emitida') <> 'cancelada'
      GROUP BY ${BRANCH}`
  );
}

// ── Catálogos ───────────────────────────────────────────────────────────────

function businessConfig(query) {
  return query(
    `SELECT business_name, rnc, currency, business_structure_mode, business_type,
            e_invoice_enabled, license_status, tax_rate
       FROM config WHERE id = 1 LIMIT 1`
  );
}

function branches(query) {
  return query('SELECT * FROM branches ORDER BY id');
}

function cashRegisters(query) {
  return query('SELECT * FROM cash_registers ORDER BY branch_id, id');
}

function staffUsers(query) {
  return query(
    `SELECT id, nombre, usuario, rol, estado, branch_id, sucursal_id, caja_id
       FROM users
      WHERE COALESCE(account_type, 'staff') <> 'customer'
      ORDER BY nombre`
  );
}

function paymentMethods(query) {
  return query('SELECT codigo, nombre, estado FROM payment_methods ORDER BY nombre');
}

// ── Inventario ──────────────────────────────────────────────────────────────

/**
 * Productos para el inventario y el catálogo de la app. La imagen solo va si
 * es una URL corta (las fotos guardadas en base64 pesan demasiado).
 */
async function products(query) {
  try {
    return await query(
      `SELECT id, codigo, barcode, nombre, categoria, marca, unidad, precio_compra, precio_venta,
              stock, stock_min, estado, tracks_stock, aplica_itbis,
              CASE WHEN image_url LIKE 'http%' AND LENGTH(image_url) <= 600 THEN image_url ELSE NULL END AS image_url
         FROM products
        ORDER BY id`
    );
  } catch (_error) {
    // Base vieja sin barcode / marca / aplica_itbis / image_url.
    return query(
      `SELECT id, codigo, nombre, categoria, unidad, precio_compra, precio_venta,
              stock, stock_min, estado, tracks_stock
         FROM products
        ORDER BY id`
    );
  }
}

/** Categorías del POS: el formulario de productos de la app solo usa estas. */
function categories(query) {
  return query('SELECT nombre FROM categories ORDER BY nombre');
}

function branchInventory(query) {
  return query('SELECT branch_id, product_id, stock, stock_min FROM inventory_by_branch');
}

// ── Caja ────────────────────────────────────────────────────────────────────

function openCashSessions(query) {
  return query(`SELECT * FROM cash_sessions WHERE status = 'open' ORDER BY opened_at`);
}

function recentClosedSessions(query, limit = 40) {
  return query(
    `SELECT * FROM cash_sessions WHERE status = 'closed' ORDER BY closed_at DESC, id DESC LIMIT ?`,
    [limit]
  );
}

function sessionSales(query, sessionIds) {
  if (!sessionIds.length) return Promise.resolve([]);
  return query(
    `SELECT s.cash_session_id AS sid, COALESCE(s.payment_method, 'efectivo') AS pm,
            COUNT(*) AS n, COALESCE(SUM(s.total), 0) AS total
       FROM sales s
      WHERE s.cash_session_id IN (${placeholders(sessionIds)}) AND ${ACTIVE}
      GROUP BY s.cash_session_id, COALESCE(s.payment_method, 'efectivo')`,
    sessionIds
  );
}

function sessionMovements(query, sessionIds) {
  if (!sessionIds.length) return Promise.resolve([]);
  return query(
    `SELECT cm.session_id AS sid, cm.movement_type AS t,
            COUNT(*) AS n, COALESCE(SUM(ABS(cm.amount)), 0) AS total
       FROM cash_movements cm
      WHERE cm.session_id IN (${placeholders(sessionIds)})
      GROUP BY cm.session_id, cm.movement_type`,
    sessionIds
  );
}

function sessionCollections(query, sessionIds) {
  if (!sessionIds.length) return Promise.resolve([]);
  return query(
    `SELECT ccp.cash_session_id AS sid, COALESCE(ccp.payment_method, 'efectivo') AS pm,
            COUNT(*) AS n, COALESCE(SUM(ccp.amount), 0) AS total
       FROM client_credit_payments ccp
      WHERE ccp.cash_session_id IN (${placeholders(sessionIds)})
      GROUP BY ccp.cash_session_id, COALESCE(ccp.payment_method, 'efectivo')`,
    sessionIds
  );
}

// ── Clientes y cuentas por cobrar ───────────────────────────────────────────

function openReceivables(query) {
  return query(
    `SELECT s.id, s.invoice_number, s.client_id, ${BRANCH} AS b, s.created_at,
            s.total, COALESCE(s.received_amount, 0) AS paid,
            COALESCE(c.nombre, s.client_name_snapshot, 'Cliente') AS name,
            COALESCE(c.telefono, s.client_phone_snapshot, '') AS phone
       FROM sales s
       LEFT JOIN clients c ON c.id = s.client_id
      WHERE s.payment_method = 'credito'
        AND COALESCE(s.fiscal_status, 'emitida') <> 'cancelada'
        AND COALESCE(s.total, 0) > COALESCE(s.received_amount, 0)
      ORDER BY s.created_at ASC`
  );
}

function recentCollections(query, limit = 30) {
  return query(
    `SELECT ccp.id, ccp.amount, COALESCE(ccp.payment_method, 'efectivo') AS pm,
            ccp.created_at, ccp.created_by_user_name AS user_name, ccp.branch_id AS b,
            COALESCE(c.nombre, 'Cliente') AS name
       FROM client_credit_payments ccp
       LEFT JOIN clients c ON c.id = ccp.client_id
      ORDER BY ccp.created_at DESC, ccp.id DESC
      LIMIT ?`,
    [limit]
  );
}

function clientsCount(query) {
  return query('SELECT COUNT(*) AS n FROM clients');
}

function customerActivity(query, from, to) {
  return query(
    `SELECT s.client_id AS c, ${BRANCH} AS b,
            MAX(COALESCE(c.nombre, s.client_name_snapshot, 'Cliente')) AS name,
            MAX(COALESCE(c.telefono, '')) AS phone,
            COUNT(*) AS n,
            COALESCE(SUM(s.total), 0) AS total,
            MAX(s.created_at) AS last_at
       FROM sales s
       LEFT JOIN clients c ON c.id = s.client_id
      WHERE s.client_id IS NOT NULL AND s.created_at BETWEEN ? AND ? AND ${ACTIVE}
      GROUP BY s.client_id, ${BRANCH}`,
    [from, to]
  );
}

// ── Fiscal (e-CF y NCF) ─────────────────────────────────────────────────────

async function withCertificationFilter(query, buildSql, params) {
  try {
    return await query(buildSql('AND e.certification_case_key IS NULL'), params);
  } catch (_error) {
    return query(buildSql(''), params);
  }
}

/** Conteo de e-CF por estado/tipo/sucursal desde una fecha (sin los de certificación). */
function ecfCounts(query, from) {
  return withCertificationFilter(
    query,
    (cert) => `
      SELECT DATE(e.created_at) AS d, e.branch_id AS b,
             COALESCE(e.estado_dgii, 'pendiente') AS st,
             COALESCE(e.tipo_ecf, '') AS tp,
             COUNT(*) AS n,
             COALESCE(SUM(e.monto_total), 0) AS total
        FROM ecf_documents e
       WHERE e.created_at >= ? ${cert}
       GROUP BY DATE(e.created_at), e.branch_id, COALESCE(e.estado_dgii, 'pendiente'), COALESCE(e.tipo_ecf, '')`,
    [from]
  );
}

/** e-CF todavía sin respuesta final de la DGII (de cualquier fecha). */
function ecfOpenCounts(query) {
  return withCertificationFilter(
    query,
    (cert) => `
      SELECT e.branch_id AS b, COALESCE(e.estado_dgii, 'pendiente') AS st,
             COUNT(*) AS n, MIN(e.created_at) AS oldest
        FROM ecf_documents e
       WHERE COALESCE(e.estado_dgii, 'pendiente') NOT IN ('aceptado', 'aceptado_condicional', 'rechazado', 'anulado', 'anulada')
         ${cert}
       GROUP BY e.branch_id, COALESCE(e.estado_dgii, 'pendiente')`,
    []
  );
}

function ecfRecentDocuments(query, from, limit = 60) {
  return withCertificationFilter(
    query,
    (cert) => `
      SELECT e.id, e.encf, e.tipo_ecf, e.estado_dgii, e.created_at, e.sent_at,
             e.nombre_comprador, e.monto_total, e.error_message, e.branch_id AS b,
             s.invoice_number
        FROM ecf_documents e
        LEFT JOIN sales s ON s.id = e.sale_id
       WHERE (e.created_at >= ?
              OR COALESCE(e.estado_dgii, 'pendiente') NOT IN ('aceptado', 'aceptado_condicional', 'rechazado', 'anulado', 'anulada'))
         ${cert}
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ?`,
    [from, limit]
  );
}

async function ncfUsage(query, from, to) {
  const build = (withNcf) => `
    SELECT ${BRANCH} AS b, ${withNcf ? "COALESCE(s.ncf_type, '')" : "''"} AS nt,
           COALESCE(s.fiscal_status, 'emitida') AS fs,
           COUNT(*) AS n, COALESCE(SUM(s.total), 0) AS total, COALESCE(SUM(s.tax), 0) AS tax
      FROM sales s
     WHERE s.created_at BETWEEN ? AND ?
       AND s.ncf IS NOT NULL AND s.ncf <> ''
     GROUP BY ${BRANCH}${withNcf ? ", COALESCE(s.ncf_type, '')" : ''}, COALESCE(s.fiscal_status, 'emitida')`;
  try {
    return await query(build(true), [from, to]);
  } catch (_error) {
    return query(build(false), [from, to]);
  }
}

function ncfAuthorizedSequences(query) {
  return query(
    `SELECT fs.*, b.nombre AS branch_name
       FROM ncf_authorized_sequences fs
       LEFT JOIN branches b ON b.id = fs.branch_id
      WHERE fs.deleted_at IS NULL
      ORDER BY fs.document_type, fs.branch_id`
  );
}

function ncfLegacySequences(query) {
  return query('SELECT * FROM ncf_sequences WHERE activa = 1 ORDER BY ncf_type, branch_id');
}

// ── Delivery ────────────────────────────────────────────────────────────────

function deliveryByStatus(query, from, to) {
  return query(
    `SELECT DATE(s.created_at) AS d, ${BRANCH} AS b,
            COALESCE(s.delivery_status, 'pendiente') AS st,
            CASE WHEN COALESCE(s.fiscal_status, 'emitida') = 'cancelada' THEN 1 ELSE 0 END AS cancelled,
            COUNT(*) AS n,
            COALESCE(SUM(s.total), 0) AS total
       FROM sales s
      WHERE s.order_type = 'delivery' AND s.created_at BETWEEN ? AND ?
      GROUP BY DATE(s.created_at), ${BRANCH}, COALESCE(s.delivery_status, 'pendiente'),
               CASE WHEN COALESCE(s.fiscal_status, 'emitida') = 'cancelada' THEN 1 ELSE 0 END`,
    [from, to]
  );
}

function deliveryClients(query, from, to) {
  return query(
    `SELECT ${BRANCH} AS b, s.client_id AS c
       FROM sales s
      WHERE s.order_type = 'delivery' AND s.client_id IS NOT NULL
        AND s.created_at BETWEEN ? AND ?
        AND COALESCE(s.fiscal_status, 'emitida') <> 'cancelada'
      GROUP BY ${BRANCH}, s.client_id`,
    [from, to]
  );
}

function deliveryByDriver(query, from, to) {
  return query(
    `SELECT ${BRANCH} AS b, s.delivery_user_id AS u,
            MAX(COALESCE(s.delivery_name_snapshot, '')) AS name,
            COUNT(*) AS n, COALESCE(SUM(s.total), 0) AS total
       FROM sales s
      WHERE s.order_type = 'delivery' AND s.created_at BETWEEN ? AND ?
        AND COALESCE(s.fiscal_status, 'emitida') <> 'cancelada'
      GROUP BY ${BRANCH}, s.delivery_user_id`,
    [from, to]
  );
}

function deliveryActiveOrders(query, from, limit = 40) {
  return query(
    `SELECT s.invoice_number, s.created_at, ${BRANCH} AS b, s.total,
            COALESCE(s.delivery_status, 'pendiente') AS st,
            COALESCE(s.payment_method, 'efectivo') AS pm,
            COALESCE(s.delivery_cash_status, 'na') AS cash_st,
            COALESCE(s.client_name_snapshot, 'Cliente') AS client_name,
            COALESCE(s.delivery_name_snapshot, '') AS driver
       FROM sales s
      WHERE s.order_type = 'delivery' AND s.created_at >= ?
        AND COALESCE(s.delivery_status, 'pendiente') <> 'entregado'
        AND COALESCE(s.fiscal_status, 'emitida') <> 'cancelada'
      ORDER BY s.created_at DESC
      LIMIT ?`,
    [from, limit]
  );
}

function deliveryPendingCash(query) {
  return query(
    `SELECT ${BRANCH} AS b, COUNT(*) AS n, COALESCE(SUM(s.total), 0) AS total
       FROM sales s
      WHERE s.order_type = 'delivery'
        AND COALESCE(s.delivery_cash_status, 'na') = 'pendiente'
        AND COALESCE(s.fiscal_status, 'emitida') <> 'cancelada'
      GROUP BY ${BRANCH}`
  );
}

// ── Red / sincronización ────────────────────────────────────────────────────

function lanTerminals(query) {
  return query(
    `SELECT terminal_id, terminal_name, branch_id, cash_register_id, is_main,
            status, connection_type, last_seen_at
       FROM terminal_registrations
      ORDER BY is_main DESC, terminal_name`
  );
}

module.exports = {
  salesTotalsByDay,
  salesDimsByDay,
  salesHoursByDay,
  itemsByDay,
  cancelledByDay,
  returnsByDay,
  collectionsByDay,
  expensesByDay,
  outflowsByDay,
  customerFirstPurchases,
  rangeTotals,
  salesByMonth,
  pendingChargeSales,
  businessConfig,
  branches,
  cashRegisters,
  staffUsers,
  paymentMethods,
  products,
  categories,
  branchInventory,
  openCashSessions,
  recentClosedSessions,
  sessionSales,
  sessionMovements,
  sessionCollections,
  openReceivables,
  recentCollections,
  clientsCount,
  customerActivity,
  ecfCounts,
  ecfOpenCounts,
  ecfRecentDocuments,
  ncfUsage,
  ncfAuthorizedSequences,
  ncfLegacySequences,
  deliveryByStatus,
  deliveryClients,
  deliveryByDriver,
  deliveryActiveOrders,
  deliveryPendingCash,
  lanTerminals,
};
