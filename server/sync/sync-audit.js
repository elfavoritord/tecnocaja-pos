/**
 * sync-audit.js
 * Registra acciones críticas en businesses/{businessId}/auditLogs/{logId}.
 * Se ejecuta vía Admin SDK (bypasea reglas Firestore — solo escribe el servidor).
 */

let _admin = null;
function getAdmin() {
  if (!_admin) _admin = require('../../modules/firebase-admin');
  return _admin;
}

/**
 * Escribe una entrada en el log de auditoría de forma fire-and-forget.
 *
 * @param {object} opts
 * @param {string} opts.businessId   - ID del negocio
 * @param {string} opts.action       - Ej: 'sale.create', 'cash_closing.create', 'user.delete'
 * @param {string} [opts.actorUid]   - Firebase UID del usuario que realizó la acción
 * @param {string} [opts.actorName]  - Nombre del actor (para legibilidad)
 * @param {string} [opts.entityType] - Tipo de entidad afectada (ej: 'sale')
 * @param {string} [opts.entityId]   - ID de la entidad afectada
 * @param {object} [opts.before]     - Estado anterior del documento (para updates)
 * @param {object} [opts.after]      - Estado nuevo del documento
 * @param {string} [opts.branchId]   - Sucursal donde ocurrió la acción
 * @param {string} [opts.registerId] - Caja donde ocurrió la acción
 * @param {string} [opts.ip]         - IP del cliente (opcional)
 */
function logAudit(opts) {
  const { getFirestore, admin } = getAdmin();
  const firestore = getFirestore ? getFirestore() : null;
  if (!firestore || !opts.businessId) return;

  const entry = {
    businessId:  opts.businessId,
    action:      opts.action       || 'unknown',
    actorUid:    opts.actorUid     || null,
    actorName:   opts.actorName    || null,
    entityType:  opts.entityType   || null,
    entityId:    opts.entityId     || null,
    branchId:    opts.branchId     || null,
    registerId:  opts.registerId   || null,
    before:      opts.before       || null,
    after:       opts.after        || null,
    ip:          opts.ip           || null,
    serverTs:    true,
    createdAt:   admin.firestore.FieldValue.serverTimestamp(),
  };

  firestore
    .collection('businesses').doc(opts.businessId)
    .collection('auditLogs').add(entry)
    .catch(err => console.error('[audit] Error escribiendo log:', err.message));
}

/**
 * Atajos para acciones frecuentes.
 */
const audit = {
  saleCreated: (businessId, saleId, data, actor) =>
    logAudit({ businessId, action: 'sale.create', entityType: 'sale',
      entityId: saleId, after: data, ...actor }),

  cashClosingCreated: (businessId, closingId, data, actor) =>
    logAudit({ businessId, action: 'cash_closing.create', entityType: 'cash_closing',
      entityId: closingId, after: data, ...actor }),

  userSynced: (businessId, uid, data) =>
    logAudit({ businessId, action: 'user.sync', entityType: 'user',
      entityId: uid, after: data }),

  inventoryUpdated: (businessId, branchId, data) =>
    logAudit({ businessId, action: 'inventory.sync', entityType: 'inventory',
      branchId, after: { itemCount: data?.items?.length } }),

  fileDeleted: (businessId, fileId, fileName, actorUid) =>
    logAudit({ businessId, action: 'file.delete', entityType: 'file',
      entityId: fileId, actorUid, after: { fileName } }),

  custom: logAudit,
};

module.exports = { audit, logAudit };
