/**
 * sync-cash-closings.js
 * Encola cierres de caja para sincronización a Firebase.
 * Cada payload incluye los campos obligatorios de aislamiento y auditoría.
 */

const { query }            = require('../../db');
const { FirebaseSyncQueue } = require('./firebase-sync-queue');

/**
 * Sincroniza cierres de caja de los últimos N días.
 *
 * @param {string} businessId
 * @param {string} branchId
 * @param {object} [opts]
 * @param {string} [opts.ownerUid]   - Firebase UID del dueño/admin
 * @param {number} [opts.daysBack=7]
 */
async function syncCashClosings(businessId, branchId, opts = {}) {
  const { ownerUid = null, daysBack = 7 } = opts;

  try {
    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');

    const closings = await query(
      `SELECT
         cc.id,
         cc.cash_session_id,
         cc.cash_register_id,
         cc.expected_amount,
         cc.counted_amount,
         cc.difference_amount,
         cc.opening_amount,
         cc.total_sales,
         cc.total_income,
         cc.total_expenses,
         cc.total_withdrawals,
         cc.notes,
         cc.opened_at,
         cc.closed_at,
         uc.nombre      AS closed_by_name,
         uc.firebase_uid AS closed_by_firebase_uid,
         uo.nombre      AS opened_by_name,
         cr.nombre      AS register_name
       FROM cash_closings cc
       JOIN users uc         ON cc.closed_by_user_id = uc.id
       LEFT JOIN users uo    ON cc.opened_by_user_id = uo.id
       LEFT JOIN cash_registers cr ON cc.cash_register_id = cr.id
       WHERE cc.branch_id = ?
         AND cc.closed_at >= ?
       ORDER BY cc.closed_at DESC`,
      [branchId, since]
    );

    if (!Array.isArray(closings) || closings.length === 0) {
      console.log(`✓ No hay cierres nuevos para sincronizar en sucursal ${branchId}`);
      return;
    }

    for (const c of closings) {
      const payload = {
        // ── Identificadores de aislamiento (inmutables) ─────────────────────
        businessId,
        branchId,
        registerId:  c.cash_register_id?.toString() || null,
        ownerUid,

        // ── Auditoría ────────────────────────────────────────────────────────
        createdBy:   c.closed_by_firebase_uid || `local:${c.id}`,
        updatedBy:   c.closed_by_firebase_uid || `local:${c.id}`,
        createdAt:   c.closed_at,
        updatedAt:   c.closed_at,

        // ── Estado ───────────────────────────────────────────────────────────
        status:      'completed',

        // ── Datos del cierre ────────────────────────────────────────────────
        closingId:        c.id,
        cashSessionId:    c.cash_session_id,
        registerName:     c.register_name     || null,
        openedByName:     c.opened_by_name    || null,
        closedByName:     c.closed_by_name,
        openedAt:         c.opened_at         || null,
        closedAt:         c.closed_at,
        openingAmount:    c.opening_amount    || 0,
        expectedAmount:   c.expected_amount,
        countedAmount:    c.counted_amount,
        differenceAmount: c.difference_amount,
        totalSales:       c.total_sales       || 0,
        totalIncome:      c.total_income      || 0,
        totalExpenses:    c.total_expenses    || 0,
        totalWithdrawals: c.total_withdrawals || 0,
        notes:            c.notes             || null,
      };

      await FirebaseSyncQueue.enqueue('cash_closing', c.id.toString(), payload);
    }

    console.log(`✓ ${closings.length} cierres encolados para sincronización (sucursal ${branchId})`);
  } catch (err) {
    console.error('[sync-cash-closings] Error:', err.message);
  }
}

module.exports = { syncCashClosings };
