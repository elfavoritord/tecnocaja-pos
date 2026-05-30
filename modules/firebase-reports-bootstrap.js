/**
 * modules/firebase-reports-bootstrap.js
 *
 * Backfill inicial: toma el estado actual de MariaDB y lo empuja completo a Firestore.
 * Se usa la primera vez que el POS se conecta al proyecto reporte-sistema-pos
 * para poblar la app Flutter con data histórica.
 *
 * Expone: bootstrapAll(db, config)
 * Debe llamarse desde un endpoint dedicado (POST /api/firebase-reports/bootstrap)
 * para no ejecutarlo en cada arranque.
 */

'use strict';

const sync = require('./firebase-reports-sync');

function chunked(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchBranchesMap(db) {
  const rows = await db.query('SELECT id, nombre FROM branches').catch(() => []);
  const data = Array.isArray(rows) ? rows : (rows?.[0] || []);
  const map = new Map();
  for (const b of data) map.set(Number(b.id), b.nombre);
  return { map, rows: data };
}

async function bootstrapAll(db, config = {}) {
  if (!sync.isEnabled()) {
    return { ok: false, reason: 'firebase_not_configured' };
  }

  const report = {
    ok: true,
    businessId: sync.getBusinessId(config),
    users: 0,
    branches: 0,
    cashRegisters: 0,
    cashClosings: 0,
    categories: 0,
    products: 0,
    customers: 0,
    sales: 0,
    receivables: 0,
    expenses: 0,
    errors: [],
  };

  try {
    await sync.ensureBusinessDoc(await sync._internals.safeGetFirestore(), report.businessId, config);
  } catch (err) {
    // ya loggeado dentro
  }

  // --- Users (Firebase Auth + users/{uid} para la app Flutter) ---
  // Solo crea/actualiza el perfil Firestore. Si el usuario ya existe en Firebase Auth
  // (tiene contraseña válida), el perfil se escribe sin necesitar la contraseña de nuevo.
  const userRows = await db.query(
    `SELECT id, email, nombre, usuario, rol, estado, fecha_creacion, sucursal_id
     FROM users
     WHERE email IS NOT NULL AND email != ''
     ORDER BY id`
  ).catch(() => []);
  const usersData = Array.isArray(userRows) ? userRows : (userRows?.[0] || []);
  for (const u of usersData) {
    if (!u.email) continue;
    try {
      const result = await sync.ensureFirebaseUser({
        id: u.id,
        email: u.email,
        password: '',
        nombre: u.nombre || u.usuario || '',
        usuario: u.usuario || '',
        rol: u.rol || 'supervisor',
        rol_label: u.rol || 'Supervisor',
        role_code: u.rol || 'supervisor',
        estado: u.estado || 'Activo',
        branch_ids: u.sucursal_id ? [String(u.sucursal_id)] : [],
        allowed_modules: [],
        created_at: u.fecha_creacion || new Date(),
      }, { config });
      if (result) report.users += 1;
    } catch (err) {
      report.errors.push(`user ${u.id}: ${err.message}`);
    }
  }

  // --- Branches ---
  const { map: branchesMap, rows: branches } = await fetchBranchesMap(db);
  for (const b of branches) {
    try { await sync.syncBranch(b, { config }); report.branches += 1; }
    catch (err) { report.errors.push(`branch ${b.id}: ${err.message}`); }
  }

  // --- Cash registers ---
  const cashRows = await db.query(`
    SELECT cr.*, cs.opened_at, cs.closed_at, cs.status AS session_status,
           cs.opened_by_user_name, cs.opened_amount, cs.expected_amount,
           cs.counted_amount AS closed_amount
    FROM cash_registers cr
    LEFT JOIN (
      SELECT cs1.*
      FROM cash_sessions cs1
      INNER JOIN (
        SELECT cash_register_id, MAX(opened_at) AS max_opened
        FROM cash_sessions GROUP BY cash_register_id
      ) last ON last.cash_register_id = cs1.cash_register_id AND last.max_opened = cs1.opened_at
    ) cs ON cs.cash_register_id = cr.id
  `).catch(() => []);
  const cashData = Array.isArray(cashRows) ? cashRows : (cashRows?.[0] || []);
  for (const c of cashData) {
    try {
      await sync.syncCashRegister(c, {
        config,
        branches: branchesMap,
        sessionStatus: c.session_status === 'open' ? 'open' : 'closed',
        openedAt: c.opened_at,
        closedAt: c.closed_at,
        openedBy: c.opened_by_user_name || '',
        openingAmount: c.opened_amount || 0,
        closingAmount: c.closed_amount || 0,
        expectedAmount: c.expected_amount || 0,
      });
      report.cashRegisters += 1;
    } catch (err) { report.errors.push(`cashRegister ${c.id}: ${err.message}`); }
  }

  // --- Products (último snapshot) ---
  const catRows = await db.query('SELECT * FROM categories ORDER BY nombre').catch(() => []);
  const categories = Array.isArray(catRows) ? catRows : (catRows?.[0] || []);
  for (const c of categories) {
    try {
      await sync.syncCategory(c, { config });
      report.categories += 1;
    } catch (err) {
      report.errors.push(`category ${c.id}: ${err.message}`);
    }
  }

  const prodRows = await db.query('SELECT * FROM products').catch(() => []);
  const products = Array.isArray(prodRows) ? prodRows : (prodRows?.[0] || []);
  try {
    await sync.pruneMissingProducts(
      products.map((product) => product.id),
      { config }
    );
  } catch (err) {
    report.errors.push(`products prune: ${err.message}`);
  }
  for (const chunk of chunked(products, 200)) {
    await Promise.all(chunk.map((p) =>
      sync.syncProduct(p, { config })
        .then(() => { report.products += 1; })
        .catch((err) => report.errors.push(`product ${p.id}: ${err.message}`))
    ));
  }

  // --- Customers ---
  const custRows = await db.query('SELECT * FROM clients').catch(() => []);
  const customers = Array.isArray(custRows) ? custRows : (custRows?.[0] || []);
  for (const chunk of chunked(customers, 200)) {
    await Promise.all(chunk.map((c) =>
      sync.syncCustomer(c, { config })
        .then(() => { report.customers += 1; })
        .catch((err) => report.errors.push(`customer ${c.id}: ${err.message}`))
    ));
  }

  // --- Sales (últimos 90 días para no inundar) ---
  const saleIdentityRows = await db.query(
    `SELECT invoice_number
     FROM sales
     WHERE invoice_number IS NOT NULL AND invoice_number != ''`
  ).catch(() => []);
  const saleIdentities = Array.isArray(saleIdentityRows)
    ? saleIdentityRows
    : (saleIdentityRows?.[0] || []);
  try {
    await sync.pruneMissingSales(
      saleIdentities.map((sale) => sale.invoice_number),
      { config }
    );
  } catch (err) {
    report.errors.push(`sales prune: ${err.message}`);
  }

  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const saleRows = await db.query(
    `SELECT s.*, u.nombre AS user_name
     FROM sales s
     LEFT JOIN users u ON u.id = s.user_id
     WHERE s.created_at >= ? ORDER BY s.created_at DESC`,
    [ninetyDaysAgo]
  ).catch(() => []);
  const sales = Array.isArray(saleRows) ? saleRows : (saleRows?.[0] || []);

  for (const sale of sales) {
    try {
      const itemsRows = await db.query(
        `SELECT si.*, p.nombre, p.categoria, p.precio_compra
         FROM sale_items si
         LEFT JOIN products p ON p.id = si.product_id
         WHERE si.sale_id = ?`,
        [sale.id]
      ).catch(() => []);
      const items = Array.isArray(itemsRows) ? itemsRows : (itemsRows?.[0] || []);

      await sync.syncSale(sale, {
        config,
        branches: branchesMap,
        cashier: sale.user_name || '',
        items,
      });
      report.sales += 1;

      // Si la venta está pendiente (crédito), duplicar como receivable
      const status = String(sale.sale_status || '').toLowerCase();
      if (status === 'pendiente' || status === 'credito' || sale.payment_method === 'credito') {
        await sync.syncReceivable({
          id: sale.id,
          customerId: sale.client_id,
          customerName: sale.client_name_snapshot,
          branchId: sale.branch_id,
          total: sale.total,
          paid: sale.received_amount || 0,
          createdAt: sale.created_at,
        }, { config });
        report.receivables += 1;
      }
    } catch (err) { report.errors.push(`sale ${sale.id}: ${err.message}`); }
  }

  // --- Cash closings (histórico completo) ---
  const closingRows = await db.query(`
    SELECT
      cc.*,
      cs.opened_at,
      cs.opened_amount,
      cs.opened_by_user_name,
      b.nombre AS branch_name
    FROM cash_closings cc
    LEFT JOIN cash_sessions cs ON cs.id = cc.cash_session_id
    LEFT JOIN branches b ON b.id = cc.branch_id
    ORDER BY cc.closed_at DESC
  `).catch(() => []);
  const closings = Array.isArray(closingRows) ? closingRows : (closingRows?.[0] || []);
  report.cashClosings = 0;
  for (const c of closings) {
    try {
      const diff = (Number(c.counted_amount || 0) - Number(c.expected_amount || 0));
      const branchId = String(c.branch_id || 'default');
      const branchName = branchesMap.get(Number(c.branch_id)) || c.branch_name || 'Principal';
      const closingId = String(c.id);
      const firestore = sync._internals.safeGetFirestore();
      if (!firestore) break;
      const businessId = sync.getBusinessId(config);
      const payload = {
        cashRegisterId: String(c.cash_register_id || ''),
        branchId,
        branchName,
        openedBy: c.opened_by_user_name || '',
        closedBy: c.closed_by_user_name || '',
        openedAt: sync._internals.toTimestamp(c.opened_at),
        closedAt: sync._internals.toTimestamp(c.closed_at),
        openingAmount: Number(c.opened_amount || 0),
        closingAmount: Number(c.counted_amount || 0),
        expectedAmount: Number(c.expected_amount || 0),
        difference: diff,
        totalSales: 0,
        totalIncome: 0,
        totalExpenses: 0,
        totalWithdrawals: 0,
        notes: c.notes || null,
        createdAt: sync._internals.toTimestamp(c.closed_at),
      };
      await firestore.collection('businesses').doc(businessId)
        .collection('cashClosings').doc(closingId).set(payload, { merge: true });
      await firestore.collection('businesses').doc(businessId)
        .collection('branches').doc(branchId)
        .collection('cash_closings').doc(closingId).set(payload, { merge: true });
      report.cashClosings += 1;
    } catch (err) { report.errors.push(`cashClosing ${c.id}: ${err.message}`); }
  }

  // --- Cash movements (últimos 90 días) = también poblar expenses ---
  const movRows = await db.query(
    `SELECT * FROM cash_movements WHERE happened_at >= ? ORDER BY happened_at DESC`,
    [ninetyDaysAgo]
  ).catch(() => []);
  const movements = Array.isArray(movRows) ? movRows : (movRows?.[0] || []);
  for (const mov of movements) {
    try {
      await sync.syncCashMovement(mov, { config, branches: branchesMap });
      if (['salida', 'gasto', 'expense'].includes(String(mov.movement_type || '').toLowerCase())) {
        report.expenses += 1;
      }
    } catch (err) { report.errors.push(`cashMovement ${mov.id}: ${err.message}`); }
  }

  return report;
}

module.exports = { bootstrapAll };
