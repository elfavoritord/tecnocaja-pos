'use strict';
/**
 * apply-pending-products.js
 *
 * Consume la cola de productos que un contador agregó desde el Portal del
 * Contador (tecno-caja-contadores) para este negocio. El Portal no tiene
 * acceso directo a la base de datos local del POS — solo puede dejar una
 * "solicitud pendiente" en Firestore. Este módulo es quien realmente la
 * aplica, la próxima vez que este POS sincroniza (mismos disparadores que
 * sync-pos-stats.js: abrir caja, cerrar caja, crear venta).
 *
 * Firestore: licencias/{licenseUid}/productos_pendientes/{autoId}
 *   status: 'pendiente' | 'aplicado' | 'error'
 *   branchId: número | null — null/vacío = producto global (todas las
 *   sucursales). El Portal solo deja elegir entre las sucursales que este
 *   mismo POS ya sincronizó (ver sync-pos-stats.js → profile.sucursales),
 *   pero igual se revalida aquí contra la base local por si esa sucursal
 *   se eliminó entre que el contador la eligió y que este POS sincronizó.
 */

function getLicenseUid() {
  return String(process.env.TECNO_CAJA_LICENSE_UID || '').trim();
}

function getDb() {
  const { getFirestore } = require('../../modules/firebase-admin');
  return getFirestore();
}

/**
 * @param {Function} createProductInTransaction — (conn, {data, catalogBranchId, actor}) => {row, branchId}, definida en server.js
 * @param {Function} withTransaction — de db.js
 * @param {Function} writeAuditLog — de server.js
 * @param {Function} query — de db.js, para validar que la sucursal elegida siga existiendo
 * @param {Function} decodeDataUrlImage — de server.js, decodifica un data:image/...;base64,... a Buffer
 * @param {Function} saveProductImageBuffer — de server.js, redimensiona/optimiza y guarda el archivo
 */
function createApplyPendingProductsService({ createProductInTransaction, withTransaction, writeAuditLog, query, decodeDataUrlImage, saveProductImageBuffer }) {
  async function findExistingProductForRequest(data, catalogBranchId) {
    const rows = await query(
      `SELECT id, codigo, nombre, branch_id
       FROM products
       WHERE estado <> 'Eliminado'
         AND (LOWER(codigo) = LOWER(?) OR LOWER(nombre) = LOWER(?))
         AND (branch_id IS NULL OR ? IS NULL OR branch_id = ?)
       ORDER BY CASE WHEN LOWER(codigo) = LOWER(?) THEN 0 ELSE 1 END, id
       LIMIT 1`,
      [data.codigo, data.nombre, catalogBranchId, catalogBranchId, data.codigo]
    ).catch(() => []);
    return rows[0] || null;
  }

  async function markRequestAppliedFromExisting(doc, existingProduct, message = '') {
    await doc.ref.update({
      status: 'aplicado',
      localProductId: Number(existingProduct.id || 0) || null,
      duplicateResolved: true,
      duplicateMessage: message || 'El producto ya existía en el POS; solicitud vinculada automáticamente.',
      appliedAt: new Date().toISOString(),
    });
  }

  async function applyPendingProductRequests() {
    const licenseUid = getLicenseUid();
    if (!licenseUid) {
      return { ok: false, reason: 'TECNO_CAJA_LICENSE_UID no configurado' };
    }

    let db;
    try {
      db = getDb();
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    if (!db) return { ok: false, reason: 'Firebase no disponible' };

    const pendingCol = db.collection('licencias').doc(licenseUid).collection('productos_pendientes');

    let snapshot;
    try {
      snapshot = await pendingCol.where('status', '==', 'pendiente').get();
    } catch (e) {
      console.warn('[apply-pending-products] No se pudo leer la cola:', e.message);
      return { ok: false, reason: e.message };
    }

    if (snapshot.empty) return { ok: true, applied: 0, failed: 0 };

    let applied = 0;
    let failed = 0;

    for (const doc of snapshot.docs) {
      const request = doc.data() || {};
      const data = {
        codigo: String(request.codigo || '').trim(),
        nombre: String(request.nombre || '').trim(),
        categoria: String(request.categoria || '').trim() || 'General',
        marca: String(request.marca || '').trim(),
        unidad: String(request.unidad || '').trim() || 'Unidad',
        saleMode: request.saleMode || 'unidad',
        precioCompra: Number(request.precioCompra || 0),
        precioVenta: Number(request.precioVenta || 0),
        stock: Number(request.stock || 0),
        stockMin: Number(request.stockMin || 0),
        estado: 'Activo',
        tipoProducto: 'general',
        aplicaItbis: Boolean(request.aplicaItbis),
        tracksStock: true,
      };

      if (!data.codigo || !data.nombre) {
        await doc.ref.update({
          status: 'error',
          errorMessage: 'Código y nombre son obligatorios.',
          appliedAt: new Date().toISOString(),
        }).catch(() => {});
        failed += 1;
        continue;
      }

      const actor = {
        userId: null,
        userName: `Contador: ${request.contadorNombre || 'sin nombre'}`,
      };

      // Revalidar la sucursal elegida contra la base local. Si ya no existe,
      // no convertir a global: eso duplicaría/contaminaría el catálogo de
      // todas las sucursales con un producto que el contador pidió local.
      let catalogBranchId = null;
      const requestedBranchId = Number(request.branchId || 0) || null;
      if (requestedBranchId) {
        const branchRows = await query(
          `SELECT id FROM branches WHERE id = ? AND estado <> 'Eliminada' LIMIT 1`,
          [requestedBranchId]
        ).catch(() => []);
        if (!branchRows.length) {
          await doc.ref.update({
            status: 'error',
            errorMessage: `La sucursal seleccionada (${requestedBranchId}) ya no existe o fue eliminada.`,
            appliedAt: new Date().toISOString(),
          }).catch(() => {});
          failed += 1;
          continue;
        }
        catalogBranchId = requestedBranchId;
      }

      try {
        const existingBeforeCreate = await findExistingProductForRequest(data, catalogBranchId);
        if (existingBeforeCreate) {
          await markRequestAppliedFromExisting(doc, existingBeforeCreate);
          applied += 1;
          continue;
        }

        const result = await withTransaction((conn) => createProductInTransaction(conn, {
          data,
          catalogBranchId,
          actor,
        }));

        const productId = result?.row?.id || null;

        // Imagen opcional — ya viene redimensionada/comprimida desde el
        // Portal (900px, JPEG). Si falla, no revertir el producto ya creado,
        // solo dejarlo sin imagen y seguir.
        if (productId && request.imagenData) {
          try {
            const buffer = decodeDataUrlImage(request.imagenData);
            const saved = await saveProductImageBuffer({ productId, productName: data.nombre, buffer });
            await query('UPDATE products SET image_local = ? WHERE id = ?', [saved.imageLocal, productId]);
          } catch (imgError) {
            console.warn('[apply-pending-products] No se pudo guardar la imagen:', imgError.message);
          }
        }

        await doc.ref.update({
          status: 'aplicado',
          localProductId: productId,
          appliedAt: new Date().toISOString(),
        });

        try {
          await writeAuditLog({
            ...actor,
            userRole: 'Contador',
            moduleName: 'Productos',
            actionName: 'Producto creado por contador',
            detail: `${data.codigo} · ${data.nombre} (vía Portal del Contador)`,
          });
        } catch (auditError) {
          console.warn('[apply-pending-products] No se pudo registrar auditoría:', auditError.message);
        }

        applied += 1;
      } catch (error) {
        const isDuplicate = /Ya existe un producto/i.test(String(error?.message || ''));
        if (isDuplicate) {
          const existingAfterError = await findExistingProductForRequest(data, catalogBranchId);
          if (existingAfterError) {
            await markRequestAppliedFromExisting(doc, existingAfterError, error.message);
            applied += 1;
            continue;
          }
        }
        await doc.ref.update({
          status: 'error',
          errorMessage: error.message || 'No se pudo crear el producto.',
          appliedAt: new Date().toISOString(),
        }).catch(() => {});
        failed += 1;
      }
    }

    console.log(`[apply-pending-products] ${licenseUid}: ${applied} aplicado(s), ${failed} con error.`);
    return { ok: true, applied, failed };
  }

  return { applyPendingProductRequests };
}

module.exports = { createApplyPendingProductsService };
