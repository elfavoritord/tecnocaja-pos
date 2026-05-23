/**
 * sync-inventory.js
 * Encola el inventario actual de una sucursal para sincronización a Firebase.
 * Cada payload incluye los campos obligatorios de aislamiento y auditoría.
 */

const { query }            = require('../../db');
const { FirebaseSyncQueue } = require('./firebase-sync-queue');

/**
 * Sincroniza el inventario activo de una sucursal.
 *
 * @param {string} businessId
 * @param {string} branchId
 * @param {object} [opts]
 * @param {string} [opts.ownerUid] - Firebase UID del dueño/admin
 */
async function syncBranchInventory(businessId, branchId, opts = {}) {
  const { ownerUid = null } = opts;

  try {
    console.log(`📦 Sincronizando inventario para sucursal ${branchId}...`);

    const inventory = await query(
      `SELECT
         ib.product_id,
         p.codigo,
         p.nombre,
         p.categoria,
         p.costo,
         p.precio,
         ib.stock,
         ib.stock_min,
         ib.updated_at
       FROM inventory_by_branch ib
       JOIN products p ON ib.product_id = p.id
       WHERE ib.branch_id = ? AND p.estado = 'Activo'
       ORDER BY p.nombre`,
      [branchId]
    );

    if (!Array.isArray(inventory) || inventory.length === 0) {
      console.log(`✓ No hay inventario para sincronizar en sucursal ${branchId}`);
      return;
    }

    const now = new Date();

    const items = inventory.map(item => ({
      productId:  item.product_id,
      codigo:     item.codigo,
      nombre:     item.nombre,
      categoria:  item.categoria,
      costo:      item.costo     || 0,
      precio:     item.precio    || 0,
      stock:      item.stock,
      stockMin:   item.stock_min,
      updatedAt:  item.updated_at,
    }));

    const payload = {
      // ── Identificadores de aislamiento (inmutables) ─────────────────────
      businessId,
      branchId,
      ownerUid,

      // ── Auditoría ────────────────────────────────────────────────────────
      createdBy:  `server`,
      updatedBy:  `server`,
      createdAt:  now,
      updatedAt:  now,

      // ── Estado ───────────────────────────────────────────────────────────
      status:     'active',

      // ── Datos ────────────────────────────────────────────────────────────
      items,
      itemCount:  items.length,
      syncedAt:   now,
    };

    // ID: fecha actual — se sobreescribe en cada sync (snapshot del día)
    const today = now.toISOString().split('T')[0];
    await FirebaseSyncQueue.enqueue('inventory', `${branchId}_${today}`, payload);

    console.log(`✓ Inventario de ${items.length} productos encolado (sucursal ${branchId})`);
  } catch (err) {
    console.error('[sync-inventory] Error:', err.message);
  }
}

module.exports = { syncBranchInventory };
