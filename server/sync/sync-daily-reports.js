/**
 * sync-daily-reports.js
 *
 * Genera y sincroniza reportes diarios resumidos.
 */

const { query } = require('../../db');
const { FirebaseSyncQueue } = require('./firebase-sync-queue');

/**
 * Genera un reporte diario resumido para una sucursal.
 * @param {string} businessId
 * @param {string} branchId
 * @param {Date|string} reportDate
 * @param {object} [opts]
 * @param {string} [opts.ownerUid] - Firebase UID del dueño/admin
 */
async function generateAndSyncDailyReport(businessId, branchId, reportDate, opts = {}) {
  const { ownerUid = null } = opts;
  try {
    const dateStr = reportDate instanceof Date
      ? reportDate.toISOString().split('T')[0]
      : reportDate;

    console.log(`📊 Generando reporte diario para ${dateStr}...`);

    // Obtener totales del día
    const dailySummary = await query(
      `SELECT
        COUNT(*) as total_sales,
        SUM(total) as total_amount,
        SUM(discount) as total_discount,
        SUM(tax) as total_tax,
        SUM(subtotal) as subtotal
      FROM sales
      WHERE branch_id = ? AND sale_status = 'pagada'
        AND DATE(created_at) = ?`,
      [branchId, dateStr]
    );

    const summary = (Array.isArray(dailySummary) ? dailySummary[0] : dailySummary) || {
      total_sales: 0,
      total_amount: 0,
      total_discount: 0,
      total_tax: 0,
      subtotal: 0
    };

    // Ventas por método de pago
    const byPayment = await query(
      `SELECT
        payment_method,
        COUNT(*) as count,
        SUM(total) as amount
      FROM sales
      WHERE branch_id = ? AND sale_status = 'pagada'
        AND DATE(created_at) = ?
      GROUP BY payment_method`,
      [branchId, dateStr]
    );

    // Ventas por cajero
    const byCashier = await query(
      `SELECT
        u.nombre as cashier_name,
        COUNT(*) as count,
        SUM(s.total) as amount
      FROM sales s
      JOIN users u ON s.user_id = u.id
      WHERE s.branch_id = ? AND s.sale_status = 'pagada'
        AND DATE(s.created_at) = ?
      GROUP BY s.user_id, u.nombre`,
      [branchId, dateStr]
    );

    // Cierres de caja del día
    const cashClosings = await query(
      `SELECT COUNT(*) as count, SUM(expected_amount) as expected, SUM(counted_amount) as counted
       FROM cash_closings
       WHERE branch_id = ? AND DATE(closed_at) = ?`,
      [branchId, dateStr]
    );

    const closing = (Array.isArray(cashClosings) ? cashClosings[0] : cashClosings) || {
      count: 0,
      expected: 0,
      counted: 0
    };

    const now = new Date();

    // Construir payload
    const payload = {
      // ── Identificadores de aislamiento (inmutables) ─────────────────────
      businessId,
      branchId,
      ownerUid,

      // ── Auditoría ────────────────────────────────────────────────────────
      createdBy:  'server',
      updatedBy:  'server',
      createdAt:  now,
      updatedAt:  now,

      // ── Estado ───────────────────────────────────────────────────────────
      status:     'completed',

      // ── Datos del reporte ────────────────────────────────────────────────
      date:       dateStr,
      reportDate: dateStr,
      summary: {
        totalSales:    summary.total_sales    || 0,
        totalAmount:   summary.total_amount   || 0,
        totalDiscount: summary.total_discount || 0,
        totalTax:      summary.total_tax      || 0,
        subtotal:      summary.subtotal       || 0,
      },
      byPayment:   Array.isArray(byPayment) ? byPayment : (byPayment ? [byPayment] : []),
      byCashier:   Array.isArray(byCashier) ? byCashier : (byCashier ? [byCashier] : []),
      cashClosings: {
        count:          closing.count    || 0,
        expectedAmount: closing.expected || 0,
        countedAmount:  closing.counted  || 0,
      },
      generatedAt: now,
    };

    // Agregar a cola
    await FirebaseSyncQueue.enqueue('daily_report', dateStr, payload);
    console.log(`✓ Reporte diario agregado a cola de sincronización`);

    return payload;
  } catch (err) {
    console.error('Error generando reporte diario:', err);
  }
}

/**
 * Genera reportes para los últimos N días.
 */
async function syncLastNDays(businessId, branchId, days = 7, opts = {}) {
  try {
    const today = new Date();
    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      await generateAndSyncDailyReport(businessId, branchId, date, opts);
    }
  } catch (err) {
    console.error('Error sincronizando últimos días:', err);
  }
}

module.exports = {
  generateAndSyncDailyReport,
  syncLastNDays
};
