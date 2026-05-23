/**
 * sync-sales.js
 * Captura ventas completadas y las encola para sincronización a Firebase.
 * Cada payload incluye los campos obligatorios de aislamiento y auditoría.
 */

const { query }            = require('../../db');
const { FirebaseSyncQueue } = require('./firebase-sync-queue');

/**
 * Sincroniza ventas completadas de los últimos N días (default 7).
 *
 * @param {string} businessId  - ID del negocio (TECNO_CAJA_LICENSE_UID o businessKey)
 * @param {string} branchId    - ID de la sucursal local
 * @param {object} [opts]
 * @param {string} [opts.ownerUid]   - Firebase UID del dueño/admin del negocio
 * @param {number} [opts.daysBack=7] - Ventana temporal a sincronizar
 */
async function syncNewSales(businessId, branchId, opts = {}) {
  const { ownerUid = null, daysBack = 7 } = opts;

  try {
    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');

    const sales = await query(
      `SELECT
         s.id,
         s.invoice_number,
         s.user_id,
         s.cash_register_id,
         s.payment_method,
         s.subtotal,
         s.discount,
         s.tax,
         s.total,
         s.sale_status,
         s.created_at,
         u.nombre      AS user_name,
         u.firebase_uid AS user_firebase_uid,
         cr.nombre     AS register_name
       FROM sales s
       JOIN users u         ON s.user_id = u.id
       LEFT JOIN cash_registers cr ON s.cash_register_id = cr.id
       WHERE s.branch_id = ?
         AND s.sale_status = 'pagada'
         AND s.created_at >= ?
       ORDER BY s.created_at DESC`,
      [branchId, since]
    );

    if (!Array.isArray(sales) || sales.length === 0) {
      console.log(`✓ No hay ventas nuevas para sincronizar en sucursal ${branchId}`);
      return;
    }

    for (const sale of sales) {
      const items = await query(
        `SELECT product_id, qty, price, discount_rate, tax_rate, line_total
         FROM sale_items WHERE sale_id = ?`,
        [sale.id]
      );

      const payload = {
        // ── Identificadores de aislamiento (inmutables) ─────────────────────
        businessId,
        branchId,
        registerId:   sale.cash_register_id?.toString() || null,
        ownerUid,

        // ── Auditoría ────────────────────────────────────────────────────────
        createdBy:    sale.user_firebase_uid || `local:${sale.user_id}`,
        updatedBy:    sale.user_firebase_uid || `local:${sale.user_id}`,
        createdAt:    sale.created_at,
        updatedAt:    sale.created_at,

        // ── Estado ───────────────────────────────────────────────────────────
        status:       'completed',

        // ── Datos de la venta ─────────────────────────────────────────────
        saleId:        sale.id,
        invoiceNumber: sale.invoice_number,
        cashierId:     sale.user_id,
        cashierName:   sale.user_name,
        registerName:  sale.register_name || null,
        paymentMethod: sale.payment_method,
        subtotal:      sale.subtotal,
        discount:      sale.discount,
        tax:           sale.tax,
        total:         sale.total,
        items:         Array.isArray(items) ? items : (items ? [items] : []),
      };

      await FirebaseSyncQueue.enqueue('sale', sale.id.toString(), payload);
    }

    console.log(`✓ ${sales.length} ventas encoladas para sincronización (sucursal ${branchId})`);
  } catch (err) {
    console.error('[sync-sales] Error:', err.message);
  }
}

module.exports = { syncNewSales };
