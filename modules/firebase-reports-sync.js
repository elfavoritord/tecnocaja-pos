/**
 * modules/firebase-reports-sync.js
 *
 * Sincroniza datos del POS con Firestore en el formato que espera la app Flutter
 * "reporte app" (proyecto Firebase: reporte-sistema-pos).
 *
 * Schema destino:
 *   businesses/{businessId}/sales/{saleId}
 *   businesses/{businessId}/branches/{branchId}
 *   businesses/{businessId}/cashRegisters/{cashRegisterId}
 *   businesses/{businessId}/products/{productId}
 *   businesses/{businessId}/customers/{customerId}
 *   businesses/{businessId}/expenses/{expenseId}
 *   businesses/{businessId}/receivables/{receivableId}
 *   businesses/{businessId}/alerts/{alertId}
 *   users/{uid}                                       (perfil de cada usuario)
 *
 * Principios:
 *   - Fire-and-forget: toda función es safe si falla (log y continúa).
 *   - No-op silencioso si firebase-admin no está configurado.
 *   - Mapeo defensivo: tolera campos faltantes.
 */

'use strict';

const path = require('path');

let firebaseAdminModule = null;
function loadFirebaseAdmin() {
  if (firebaseAdminModule) return firebaseAdminModule;
  try {
    firebaseAdminModule = require('./firebase-admin');
  } catch (err) {
    console.warn('[reports-sync] No se pudo cargar firebase-admin:', err.message);
    firebaseAdminModule = null;
  }
  return firebaseAdminModule;
}

function safeGetFirestore() {
  const mod = loadFirebaseAdmin();
  if (!mod || typeof mod.getFirestore !== 'function') return null;
  try {
    return mod.getFirestore();
  } catch (err) {
    // Silencio — Firebase no configurado todavía
    return null;
  }
}

function safeGetAuth() {
  const mod = loadFirebaseAdmin();
  if (!mod || typeof mod.getFirestore !== 'function') return null;
  try {
    const admin = require('firebase-admin');
    if (!admin.apps || !admin.apps.length) {
      // Obliga inicialización via getFirestore() que retorna la misma app
      mod.getFirestore();
    }
    return admin.auth();
  } catch (err) {
    return null;
  }
}

function safeFieldValue() {
  try {
    const admin = require('firebase-admin');
    return admin.firestore.FieldValue;
  } catch (_) {
    return null;
  }
}

function safeTimestamp() {
  try {
    const admin = require('firebase-admin');
    return admin.firestore.Timestamp;
  } catch (_) {
    return null;
  }
}

// ---------- businessId ----------

// Detecta formato hash legado (pos_XXXXXXXX) — debe ignorarse para usar el legible.
function isLegacyUid(uid) {
  return /^pos_[a-f0-9]{8,}$/i.test(uid);
}

function getBusinessId(config = {}) {
  const licenseUid = String(process.env.TECNO_CAJA_LICENSE_UID || '').trim();
  // Si está configurado y es formato legible (no hash legado) → usarlo
  if (licenseUid && !isLegacyUid(licenseUid)) return licenseUid;

  // Generar ID legible desde el nombre del negocio
  const mod = loadFirebaseAdmin();
  if (mod && typeof mod.buildPosBusinessKey === 'function') {
    return mod.buildPosBusinessKey(config?.nombre || config?.business_name || 'Tecno Caja');
  }
  return 'pos:tecno-caja-negocio';
}

// ---------- helpers de formato ----------

function toTimestamp(value) {
  if (!value) return null;
  const Timestamp = safeTimestamp();
  if (!Timestamp) return null;
  try {
    if (value instanceof Date) return Timestamp.fromDate(value);
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return Timestamp.fromDate(d);
  } catch (_) {
    return null;
  }
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function stripNulls(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function normalizePaymentMethod(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['efectivo', 'cash'].includes(v)) return 'cash';
  if (['tarjeta', 'card'].includes(v)) return 'card';
  if (['credito', 'crédito', 'credit'].includes(v)) return 'credit';
  if (['transferencia', 'transfer'].includes(v)) return 'transfer';
  if (['mixto', 'mixed'].includes(v)) return 'mixed';
  return 'cash';
}

function normalizeSaleStatus(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['cancelada', 'cancelled', 'canceled', 'anulada'].includes(v)) return 'cancelled';
  if (['pendiente', 'pending', 'credito', 'credit'].includes(v)) return 'pending';
  return 'completed';
}

function normalizeInvoiceType(value) {
  const v = String(value || 'ticket').trim().toLowerCase();
  if (['fiscal', 'ecf', 'e-cf'].includes(v)) return 'fiscal';
  return 'ticket';
}

function normalizeBranchId(rawId, fallback = 'default') {
  const id = String(rawId || '').trim();
  return id || fallback;
}

// ---------- collection helpers ----------

function col(firestore, businessId, name) {
  return firestore.collection('businesses').doc(businessId).collection(name);
}

async function ensureBusinessDoc(firestore, businessId, config = {}) {
  try {
    const ref = firestore.collection('businesses').doc(businessId);
    await ref.set(
      stripNulls({
        name: config?.nombre || config?.business_name || 'Tecno Caja',
        rnc: config?.rnc || null,
        address: config?.address || config?.direccion || null,
        phone: config?.phone || config?.telefono || null,
        currency: config?.currency || 'RD$',
        planCode: config?.plan_code || config?.planCode || 'basico',
        licenseStatus: config?.license_status || config?.licenseStatus || 'trial',
        updatedAt: new Date(),
      }),
      { merge: true }
    );
  } catch (err) {
    console.warn('[reports-sync] ensureBusinessDoc falló:', err.message);
  }
}

// ---------- SALES ----------

/**
 * Escribe una venta completa a Firestore.
 * @param {Object} sale  Objeto con formato de `SELECT * FROM sales` + items
 * @param {Object} ctx   { config, branches:Map<id,name>, cashier:String, items:Array }
 */
async function syncSale(sale, ctx = {}) {
  const firestore = safeGetFirestore();
  if (!firestore || !sale) return;

  try {
    const businessId = getBusinessId(ctx.config || {});
    const branchId = normalizeBranchId(sale.branch_id);
    const branches = ctx.branches || new Map();
    const branchName = branches.get(Number(sale.branch_id)) || branches.get(branchId) || '';

    const items = Array.isArray(ctx.items) ? ctx.items : [];
    const mappedItems = items.map((it) => stripNulls({
      productId: String(it.product_id || it.productId || ''),
      productName: String(it.nombre || it.product_name || it.productName || ''),
      category: String(it.categoria || it.category || ''),
      quantity: toNumber(it.qty ?? it.quantity),
      price: toNumber(it.price),
      cost: toNumber(it.precio_compra ?? it.cost),
      discount: toNumber(it.discount ?? (toNumber(it.price) * toNumber(it.qty) * toNumber(it.discount_rate) / 100)),
    }));

    const docId = String(sale.invoice_number || sale.id);
    const createdAt = toTimestamp(sale.created_at || new Date());

    const data = stripNulls({
      branchId,
      branchName,
      cashRegisterId: String(sale.cash_register_id || ''),
      cashierName: String(ctx.cashier || sale.user_name || sale.usuario || ''),
      customerId: sale.client_id ? String(sale.client_id) : null,
      customerName: sale.client_name_snapshot || ctx.customerName || null,
      items: mappedItems,
      subtotal: toNumber(sale.subtotal),
      discount: toNumber(sale.discount),
      tax: toNumber(sale.tax),
      total: toNumber(sale.total),
      paymentMethod: normalizePaymentMethod(sale.payment_method),
      status: normalizeSaleStatus(sale.sale_status),
      invoiceNumber: String(sale.invoice_number || ''),
      invoiceType: normalizeInvoiceType(sale.document_type),
      createdAt,
      updatedAt: new Date(),
    });

    await col(firestore, businessId, 'sales').doc(docId).set(data, { merge: true });
  } catch (err) {
    console.warn('[reports-sync] syncSale falló:', err.message);
  }
}

async function markSaleCancelled(saleId, ctx = {}) {
  const firestore = safeGetFirestore();
  if (!firestore || !saleId) return;
  try {
    const businessId = getBusinessId(ctx.config || {});
    await col(firestore, businessId, 'sales').doc(String(saleId)).set({
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelReason: ctx.reason || null,
      updatedAt: new Date(),
    }, { merge: true });
  } catch (err) {
    console.warn('[reports-sync] markSaleCancelled falló:', err.message);
  }
}

async function deleteSale(saleId, ctx = {}) {
  const firestore = safeGetFirestore();
  if (!firestore || !saleId) return false;
  try {
    const businessId = getBusinessId(ctx.config || {});
    await col(firestore, businessId, 'sales').doc(String(saleId)).delete();
    return true;
  } catch (err) {
    console.warn('[reports-sync] deleteSale falló:', err.message);
    return false;
  }
}

async function pruneMissingSales(validSaleIds = [], ctx = {}) {
  const firestore = safeGetFirestore();
  if (!firestore) return { deleted: 0 };
  try {
    const businessId = getBusinessId(ctx.config || {});
    const validIds = new Set(
      (Array.isArray(validSaleIds) ? validSaleIds : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    );
    const snapshot = await col(firestore, businessId, 'sales').get();
    let deleted = 0;
    for (const finalDoc of snapshot.docs) {
      if (validIds.has(String(finalDoc.id || '').trim())) continue;
      await finalDoc.ref.delete();
      deleted += 1;
    }
    return { deleted };
  } catch (err) {
    console.warn('[reports-sync] pruneMissingSales falló:', err.message);
    return { deleted: 0, error: err.message };
  }
}

// ---------- BRANCHES ----------

async function syncBranch(branch, ctx = {}) {
  const firestore = safeGetFirestore();
  if (!firestore || !branch) return;
  try {
    const businessId = getBusinessId(ctx.config || {});
    const branchId = normalizeBranchId(branch.id);
    const data = stripNulls({
      name: branch.nombre || branch.name || 'Sucursal',
      code: branch.codigo || null,
      address: branch.direccion || null,
      phone: branch.telefono || null,
      manager: branch.encargado || null,
      isActive: String(branch.estado || 'Activa').toLowerCase() === 'activa',
      updatedAt: new Date(),
    });
    await col(firestore, businessId, 'branches').doc(branchId).set(data, { merge: true });
  } catch (err) {
    console.warn('[reports-sync] syncBranch falló:', err.message);
  }
}

// ---------- CASH REGISTERS ----------

async function syncCashRegister(cashRegister, ctx = {}) {
  const firestore = safeGetFirestore();
  if (!firestore || !cashRegister) return;
  try {
    const businessId = getBusinessId(ctx.config || {});
    const cashRegisterId = String(cashRegister.id || '');
    if (!cashRegisterId) return;
    const branches = ctx.branches || new Map();
    const branchId = normalizeBranchId(cashRegister.branch_id);
    const branchName = branches.get(Number(cashRegister.branch_id)) || branches.get(branchId) || '';

    const data = stripNulls({
      name: (cashRegister.nombre || cashRegister.name || '').trim() || 'Caja',
      branchId,
      branchName,
      status: ctx.sessionStatus || 'closed',
      // Datos de sesión si vienen en ctx
      openedAt: toTimestamp(ctx.openedAt),
      closedAt: toTimestamp(ctx.closedAt),
      openedBy: ctx.openedBy || null,
      openingAmount: toNumber(ctx.openingAmount),
      closingAmount: toNumber(ctx.closingAmount),
      expectedAmount: toNumber(ctx.expectedAmount),
      totalIncome: toNumber(ctx.totalIncome),
      totalExpenses: toNumber(ctx.totalExpenses),
      totalWithdrawals: toNumber(ctx.totalWithdrawals),
      updatedAt: new Date(),
    });

    await col(firestore, businessId, 'cashRegisters').doc(cashRegisterId).set(data, { merge: true });
  } catch (err) {
    console.warn('[reports-sync] syncCashRegister falló:', err.message);
  }
}

/**
 * Llamar después de una apertura (POST /api/caja/apertura).
 */
async function syncCashOpening(opening, ctx = {}) {
  if (!opening) return;
  await syncCashRegister(
    { id: opening.cash_register_id, branch_id: opening.branch_id },
    {
      ...ctx,
      sessionStatus: 'open',
      openedAt: opening.opened_at || new Date(),
      closedAt: null,
      openedBy: opening.opened_by_user_name || ctx.openedBy || '',
      openingAmount: toNumber(opening.opened_amount),
      closingAmount: 0,
      expectedAmount: toNumber(opening.opened_amount),
      totalIncome: 0,
      totalExpenses: 0,
      totalWithdrawals: 0,
    }
  );
}

/**
 * Llamar después de un cierre (POST /api/caja/cierre).
 * Actualiza cashRegisters con status 'closed' Y crea un documento histórico en cashClosings.
 */
async function syncCashClosing(closing, ctx = {}) {
  if (!closing) return;

  const closingCtx = {
    ...ctx,
    sessionStatus: 'closed',
    closedAt: closing.closed_at || new Date(),
    openedBy: ctx.openedBy || '',
    openingAmount: toNumber(ctx.openingAmount),
    closingAmount: toNumber(closing.counted_amount),
    expectedAmount: toNumber(closing.expected_amount),
    totalIncome: toNumber(ctx.totalIncome),
    totalExpenses: toNumber(ctx.totalExpenses),
    totalWithdrawals: toNumber(ctx.totalWithdrawals),
  };

  // Actualiza el estado del cashRegister (sesión cerrada)
  await syncCashRegister(
    { id: closing.cash_register_id, branch_id: closing.branch_id },
    closingCtx
  );

  // Crea documento histórico en cashClosings
  const firestore = safeGetFirestore();
  if (!firestore) return;
  try {
    const businessId = getBusinessId(ctx.config || {});
    const closingId = String(closing.id || `${closing.cash_register_id}-${Date.now()}`);
    const branches = ctx.branches || new Map();
    const branchId = normalizeBranchId(closing.branch_id);
    const branchName = branches.get(Number(closing.branch_id)) || branches.get(branchId) || '';

    const diff = toNumber(closing.counted_amount) - toNumber(closing.expected_amount);
    const payload = stripNulls({
      cashRegisterId: String(closing.cash_register_id || ''),
      branchId,
      branchName,
      openedBy: ctx.openedBy || null,
      closedBy: ctx.closedBy || null,
      openedAt: toTimestamp(ctx.openedAt),
      closedAt: toTimestamp(closing.closed_at || new Date()),
      openingAmount: toNumber(ctx.openingAmount),
      closingAmount: toNumber(closing.counted_amount),
      expectedAmount: toNumber(closing.expected_amount),
      difference: diff,
      totalSales: toNumber(ctx.totalSales),
      totalIncome: toNumber(ctx.totalIncome),
      totalExpenses: toNumber(ctx.totalExpenses),
      totalWithdrawals: toNumber(ctx.totalWithdrawals),
      notes: closing.notes || null,
      createdAt: toTimestamp(closing.closed_at || new Date()),
    });

    await col(firestore, businessId, 'cashClosings').doc(closingId).set(payload, {
      merge: true,
    });

    // Copia compatible con reglas mas estrictas: businesses/{businessId}/branches/{branchId}/cash_closings/{closingId}
    await firestore
      .collection('businesses')
      .doc(businessId)
      .collection('branches')
      .doc(branchId)
      .collection('cash_closings')
      .doc(closingId)
      .set(payload, { merge: true });
  } catch (err) {
    console.warn('[reports-sync] syncCashClosing (cashClosings doc) falló:', err.message);
  }
}

/**
 * Llamar después de registrar un movimiento (entrada/salida/etc).
 * Actualiza también `cashRegisters` (increment total*) y escribe a `cashMovements` (colección auxiliar opcional).
 */
async function syncCashMovement(movement, ctx = {}) {
  const firestore = safeGetFirestore();
  if (!firestore || !movement) return;
  try {
    const businessId = getBusinessId(ctx.config || {});
    const branches = ctx.branches || new Map();
    const branchId = normalizeBranchId(movement.branch_id);
    const branchName = branches.get(Number(movement.branch_id)) || '';
    const movementType = String(movement.movement_type || '').toLowerCase();
    const amount = toNumber(movement.amount);

    // Registro individual en cashMovements
    const movId = String(movement.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await col(firestore, businessId, 'cashMovements').doc(movId).set(stripNulls({
      type: movementType,
      amount,
      notes: movement.notes || null,
      branchId,
      branchName,
      cashRegisterId: String(movement.cash_register_id || ''),
      createdBy: movement.created_by_user_name || ctx.createdBy || '',
      createdAt: toTimestamp(movement.happened_at || new Date()),
    }), { merge: true });

    // Gastos: si es salida, duplica en expenses para el reporte dedicado
    if (['salida', 'gasto', 'expense'].includes(movementType) && amount > 0) {
      await col(firestore, businessId, 'expenses').doc(movId).set(stripNulls({
        category: movement.notes ? 'Operativo' : 'Caja',
        description: movement.notes || 'Salida de caja',
        amount,
        branchId,
        branchName,
        createdBy: movement.created_by_user_name || ctx.createdBy || '',
        createdAt: toTimestamp(movement.happened_at || new Date()),
      }), { merge: true });
    }

    // Incrementar totales en cashRegister (fire-and-forget — errores se ignoran)
    const cashRegisterId = String(movement.cash_register_id || '');
    if (cashRegisterId) {
      const FV = safeFieldValue();
      const ref = col(firestore, businessId, 'cashRegisters').doc(cashRegisterId);
      const delta = {};
      if (movementType === 'entrada' || movementType === 'venta' || movementType === 'income') {
        delta.totalIncome = FV ? FV.increment(amount) : amount;
      } else if (movementType === 'salida' || movementType === 'gasto' || movementType === 'expense') {
        delta.totalExpenses = FV ? FV.increment(amount) : amount;
      } else if (movementType === 'retiro' || movementType === 'withdrawal') {
        delta.totalWithdrawals = FV ? FV.increment(amount) : amount;
      }
      delta.updatedAt = new Date();
      await ref.set(delta, { merge: true });
    }
  } catch (err) {
    console.warn('[reports-sync] syncCashMovement falló:', err.message);
  }
}

// ---------- PRODUCTS ----------

async function syncProduct(product, ctx = {}) {
  const firestore = safeGetFirestore();
  if (!firestore || !product) return;
  try {
    const businessId = getBusinessId(ctx.config || {});
    const productId = String(product.id || product.codigo);
    const data = stripNulls({
      name: product.nombre || product.name || '',
      category: product.categoria || product.category || '',
      barcode: product.codigo || null,
      price: toNumber(product.precio_venta ?? product.price),
      cost: toNumber(product.precio_compra ?? product.cost),
      stock: toNumber(product.stock),
      minStock: toNumber(product.stock_min ?? product.minStock),
      imageUrl: product.image_url || null,
      unit: product.unidad || null,
      brand: product.marca || null,
      isActive: String(product.estado || 'Activo').toLowerCase() === 'activo',
      branchId: ctx.branchId ? String(ctx.branchId) : null,
      updatedAt: new Date(),
    });
    await col(firestore, businessId, 'products').doc(productId).set(data, { merge: true });
  } catch (err) {
    console.warn('[reports-sync] syncProduct falló:', err.message);
  }
}

async function deleteProduct(productId, ctx = {}) {
  const firestore = safeGetFirestore();
  if (!firestore || !productId) return false;
  try {
    const businessId = getBusinessId(ctx.config || {});
    await col(firestore, businessId, 'products').doc(String(productId)).delete();
    return true;
  } catch (err) {
    console.warn('[reports-sync] deleteProduct falló:', err.message);
    return false;
  }
}

async function pruneMissingProducts(validProductIds = [], ctx = {}) {
  const firestore = safeGetFirestore();
  if (!firestore) return { deleted: 0 };
  try {
    const businessId = getBusinessId(ctx.config || {});
    const validIds = new Set(
      (Array.isArray(validProductIds) ? validProductIds : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    );
    const snapshot = await col(firestore, businessId, 'products').get();
    let deleted = 0;
    for (const doc of snapshot.docs) {
      if (validIds.has(String(doc.id || '').trim())) continue;
      await doc.ref.delete();
      deleted += 1;
    }
    return { deleted };
  } catch (err) {
    console.warn('[reports-sync] pruneMissingProducts falló:', err.message);
    return { deleted: 0, error: err.message };
  }
}

async function syncInventoryMovement(movement, ctx = {}) {
  const firestore = safeGetFirestore();
  if (!firestore || !movement) return;
  try {
    const businessId = getBusinessId(ctx.config || {});
    const movId = String(movement.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const rawType = String(movement.movement_type || '').toLowerCase();
    let mappedType = 'in';
    if (['salida', 'out', 'venta', 'sale'].includes(rawType)) mappedType = 'out';
    else if (['ajuste', 'adjustment'].includes(rawType)) mappedType = 'adjustment';

    const data = stripNulls({
      productId: String(movement.product_id || ''),
      productName: ctx.productName || '',
      type: mappedType,
      quantity: Math.abs(toNumber(movement.quantity_change)),
      reason: movement.notes || null,
      branchId: movement.branch_id ? String(movement.branch_id) : null,
      createdBy: movement.created_by_user_name || ctx.createdBy || '',
      createdAt: toTimestamp(movement.happened_at || movement.created_at || new Date()),
    });

    await col(firestore, businessId, 'inventoryMovements').doc(movId).set(data, { merge: true });
  } catch (err) {
    console.warn('[reports-sync] syncInventoryMovement falló:', err.message);
  }
}

// ---------- CUSTOMERS ----------

async function syncCustomer(customer, ctx = {}) {
  const firestore = safeGetFirestore();
  if (!firestore || !customer) return;
  try {
    const businessId = getBusinessId(ctx.config || {});
    const customerId = String(customer.id);
    const data = stripNulls({
      name: customer.nombre || customer.name || '',
      email: customer.email || null,
      phone: customer.telefono || null,
      address: customer.direccion || null,
      taxId: customer.cedula || null,
      totalDebt: toNumber(customer.balance),
      creditLimit: toNumber(customer.limite_credito),
      totalPurchases: toNumber(ctx.totalPurchases),
      visitCount: toNumber(ctx.visitCount),
      lastPurchaseAt: toTimestamp(ctx.lastPurchaseAt),
      updatedAt: new Date(),
    });
    await col(firestore, businessId, 'customers').doc(customerId).set(data, { merge: true });
  } catch (err) {
    console.warn('[reports-sync] syncCustomer falló:', err.message);
  }
}

async function deleteCustomer(customerId, ctx = {}) {
  const firestore = safeGetFirestore();
  if (!firestore || !customerId) return;
  try {
    const businessId = getBusinessId(ctx.config || {});
    await col(firestore, businessId, 'customers').doc(String(customerId)).delete();
  } catch (err) {
    console.warn('[reports-sync] deleteCustomer falló:', err.message);
  }
}

// ---------- RECEIVABLES (cuentas por cobrar) ----------

/**
 * Sincroniza una venta a crédito / pendiente como cuenta por cobrar.
 * @param {Object} receivable  { id, customerId, customerName, branchId, branchName,
 *                               total, paid, dueDate, status, createdAt, payments[] }
 */
async function syncReceivable(receivable, ctx = {}) {
  const firestore = safeGetFirestore();
  if (!firestore || !receivable) return;
  try {
    const businessId = getBusinessId(ctx.config || {});
    const id = String(receivable.id);
    const total = toNumber(receivable.total);
    const paid = toNumber(receivable.paid);
    const balance = Math.max(0, total - paid);
    let status = String(receivable.status || '').toLowerCase();
    if (!status) {
      if (balance <= 0) status = 'paid';
      else if (paid > 0) status = 'partial';
      else status = 'pending';
    }

    const payments = Array.isArray(receivable.payments)
      ? receivable.payments.map((p) => stripNulls({
          amount: toNumber(p.amount),
          date: toTimestamp(p.date || p.created_at || new Date()),
          method: p.method || 'Efectivo',
        }))
      : [];

    const data = stripNulls({
      customerId: String(receivable.customerId || receivable.client_id || ''),
      customerName: receivable.customerName || receivable.client_name || '',
      branchId: receivable.branchId ? String(receivable.branchId) : null,
      branchName: receivable.branchName || null,
      total,
      paid,
      dueDate: toTimestamp(receivable.dueDate || receivable.due_at),
      status,
      payments,
      createdAt: toTimestamp(receivable.createdAt || receivable.created_at || new Date()),
      updatedAt: new Date(),
    });

    await col(firestore, businessId, 'receivables').doc(id).set(data, { merge: true });
  } catch (err) {
    console.warn('[reports-sync] syncReceivable falló:', err.message);
  }
}

// ---------- ALERTS ----------

async function pushAlert(alert, ctx = {}) {
  const firestore = safeGetFirestore();
  if (!firestore || !alert) return;
  try {
    const businessId = getBusinessId(ctx.config || {});
    const id = alert.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = stripNulls({
      title: alert.title || '',
      message: alert.message || alert.description || '',
      severity: alert.severity || 'info',
      category: alert.category || 'general',
      branchId: alert.branchId || null,
      read: false,
      createdAt: toTimestamp(alert.createdAt || new Date()),
    });
    await col(firestore, businessId, 'alerts').doc(String(id)).set(data, { merge: true });
  } catch (err) {
    console.warn('[reports-sync] pushAlert falló:', err.message);
  }
}

// ---------- USERS (perfil para auth Flutter) ----------

/**
 * Crea/actualiza usuario Firebase Auth con email+password del POS,
 * y escribe doc users/{uid} con el perfil que consume la app Flutter.
 *
 * @param {Object} user { email, password, nombre, rol, estado, branch_ids, allowed_modules }
 * @returns {Object|null} { uid, email } o null si no se pudo
 */
async function ensureFirebaseUser(user, ctx = {}) {
  const firestore = safeGetFirestore();
  const auth = safeGetAuth();
  if (!firestore || !auth || !user || !user.email) return null;

  try {
    const email = String(user.email).trim().toLowerCase();
    const password = String(user.password || '').trim();
    const displayName = String(user.nombre || user.usuario || email).trim();
    const estado = String(user.estado || 'Activo').trim().toLowerCase();

    let authUser = null;
    try {
      authUser = await auth.getUserByEmail(email);
    } catch (err) {
      if (err?.code !== 'auth/user-not-found') throw err;
    }

    const payload = {
      email,
      displayName,
      disabled: estado !== 'activo',
    };
    if (password && password.length >= 6) payload.password = password;

    if (authUser) {
      authUser = await auth.updateUser(authUser.uid, payload);
    } else {
      if (!payload.password) {
        console.warn('[reports-sync] ensureFirebaseUser: usuario nuevo sin password válida, no se creó:', email);
        return null;
      }
      authUser = await auth.createUser(payload);
    }

    const businessId = getBusinessId(ctx.config || {});
    const role = mapRole(user.rol);
    const posRoleLabel = String(
      user.rol_label || user.role_name || user.rol || 'Supervisor'
    ).trim();
    const posRoleCode = String(
      user.role_code || user.rol || ''
    ).trim().toLowerCase();
    const posUserId = Number(user.id || user.user_id || 0) || null;

    const profilePayload = stripNulls({
      displayName,
      email,
      role,
      posRole: posRoleLabel,
      posRoleCode,
      posUserId,
      isActive: estado === 'activo',
      businessId,
      businessIds: [businessId],
      branchIds: Array.isArray(user.branch_ids) ? user.branch_ids.map(String) : [],
      allowedModules: Array.isArray(user.allowed_modules) ? user.allowed_modules.map(String) : [],
      createdAt: toTimestamp(user.created_at || new Date()),
      updatedAt: new Date(),
    });

    // users/{uid} — routing doc para auth Flutter (necesario para obtener businessId)
    await firestore.collection('users').doc(authUser.uid).set(profilePayload, { merge: true });
    // businesses/{businessId}/users/{uid} — estructura canónica para listado de usuarios
    await firestore.collection('businesses').doc(businessId)
      .collection('users').doc(authUser.uid).set(profilePayload, { merge: true });

    return { uid: authUser.uid, email };
  } catch (err) {
    console.warn('[reports-sync] ensureFirebaseUser falló:', err.message);
    return null;
  }
}

function mapRole(posRole) {
  const v = String(posRole || '').trim().toLowerCase();
  if (['administrador_general', 'administrador', 'admin', 'owner'].includes(v)) {
    return 'admin';
  }
  if ([
    'administrador_sucursal',
    'administrador sucursal',
    'gerente',
    'branch_admin',
    'supervisor_sucursal',
  ].includes(v)) {
    return 'branch_admin';
  }
  if (v === 'supervisor') return 'supervisor';
  return 'supervisor';
}

// ---------- TAX REPORTS (NCF / fiscal) ----------

/**
 * Sincroniza un reporte fiscal/NCF a businesses/{businessId}/taxReports/{reportId}.
 * @param {Object} report  { id, period, rnc, totalInvoices, totalAmount, invoiceType,
 *                           branchId, generatedAt, ncfStart, ncfEnd, status }
 * @param {Object} ctx     { config, branches: Map }
 */
async function syncTaxReport(report, ctx = {}) {
  const firestore = safeGetFirestore();
  if (!firestore || !report) return;
  try {
    const businessId = getBusinessId(ctx.config || {});
    const reportId = String(report.id || `ncf-${report.period || Date.now()}`);
    const branches = ctx.branches || new Map();
    const branchId = report.branch_id ? normalizeBranchId(report.branch_id) : null;
    const branchName = branchId
      ? (branches.get(Number(report.branch_id)) || branches.get(branchId) || '')
      : '';

    const data = stripNulls({
      period: report.period || null,
      rnc: report.rnc || null,
      invoiceType: report.invoice_type || report.invoiceType || null,
      ncfStart: report.ncf_start || report.ncfStart || null,
      ncfEnd: report.ncf_end || report.ncfEnd || null,
      totalInvoices: toNumber(report.total_invoices ?? report.totalInvoices),
      totalAmount: toNumber(report.total_amount ?? report.totalAmount),
      totalTax: toNumber(report.total_tax ?? report.totalTax),
      branchId,
      branchName,
      status: report.status || 'draft',
      generatedAt: toTimestamp(report.generated_at || report.generatedAt || new Date()),
      updatedAt: new Date(),
    });

    await col(firestore, businessId, 'taxReports').doc(reportId).set(data, { merge: true });
  } catch (err) {
    console.warn('[reports-sync] syncTaxReport falló:', err.message);
  }
}

// ---------- DAILY SUMMARY (KPIs pre-agregados por día) ----------

/**
 * Actualiza el resumen KPI diario en Firestore después de cada venta.
 * Path: businesses/{businessId}/dailyReports/YYYY-MM-DD
 *
 * Usa FieldValue.increment para ser seguro con escrituras concurrentes.
 * La app Flutter puede leer estos documentos para el dashboard sin necesitar
 * el servidor HTTP.
 *
 * @param {Object} sale   Fila de la tabla sales del POS
 * @param {Object} ctx    { config }
 */
async function syncDailySummary(sale, ctx = {}) {
  const firestore = safeGetFirestore();
  if (!firestore || !sale) return;
  try {
    const FV = safeFieldValue();
    if (!FV) return;

    const businessId = getBusinessId(ctx.config || {});
    const d = sale.created_at ? new Date(sale.created_at) : new Date();
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const status = normalizeSaleStatus(sale.sale_status);
    const pm = normalizePaymentMethod(sale.payment_method);
    const isCancelled = status === 'cancelled';
    const total = isCancelled ? 0 : toNumber(sale.total);
    const tax = isCancelled ? 0 : toNumber(sale.tax);
    const discount = isCancelled ? 0 : toNumber(sale.discount);

    const docRef = firestore
      .collection('businesses').doc(businessId)
      .collection('dailyReports').doc(dateStr);

    const delta = {
      date: dateStr,
      businessId,
      totalSales: FV.increment(isCancelled ? 0 : 1),
      cancelledCount: FV.increment(isCancelled ? 1 : 0),
      totalRevenue: FV.increment(total),
      totalTax: FV.increment(tax),
      totalDiscount: FV.increment(discount),
      updatedAt: new Date(),
    };
    // Desglose por método de pago (nested field con dot-notation)
    delta[`byPayment.${pm}`] = FV.increment(total);

    await docRef.set(delta, { merge: true });
  } catch (err) {
    console.warn('[reports-sync] syncDailySummary falló:', err.message);
  }
}

// ---------- Utilities ----------

function isEnabled() {
  return Boolean(safeGetFirestore());
}

module.exports = {
  isEnabled,
  getBusinessId,
  ensureBusinessDoc,
  // Sales
  syncSale,
  markSaleCancelled,
  deleteSale,
  pruneMissingSales,
  syncDailySummary,
  // Branches / cash
  syncBranch,
  syncCashRegister,
  syncCashOpening,
  syncCashClosing,
  syncCashMovement,
  // Inventory
  syncProduct,
  deleteProduct,
  pruneMissingProducts,
  syncInventoryMovement,
  // Customers / receivables
  syncCustomer,
  deleteCustomer,
  syncReceivable,
  // Alerts
  pushAlert,
  // Tax / fiscal
  syncTaxReport,
  // Users
  ensureFirebaseUser,
  // Internal for bootstrap
  _internals: { col, safeGetFirestore, toTimestamp, toNumber },
};
