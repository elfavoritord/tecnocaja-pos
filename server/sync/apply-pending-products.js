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
function createApplyPendingProductsService({ createProductInTransaction, withTransaction, writeAuditLog, query, decodeDataUrlImage, saveProductImageBuffer, removeLocalProductImage }) {
  async function findConflictingProductForRequest(data, catalogBranchId, excludeId = null) {
    const rows = await query(
      `SELECT id, codigo, nombre, branch_id
       FROM products
       WHERE estado <> 'Eliminado'
         AND (LOWER(codigo) = LOWER(?) OR LOWER(nombre) = LOWER(?))
         AND (branch_id IS NULL OR ? IS NULL OR branch_id = ?)
         AND (? IS NULL OR id <> ?)
       ORDER BY CASE WHEN LOWER(codigo) = LOWER(?) THEN 0 ELSE 1 END, id
       LIMIT 1`,
      [data.codigo, data.nombre, catalogBranchId, catalogBranchId, excludeId, excludeId, data.codigo]
    ).catch(() => []);
    return rows[0] || null;
  }

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
      const accion = ['editar', 'eliminar'].includes(request.accion) ? request.accion : 'crear';

      const actorForRequest = {
        userId: null,
        userName: `Contador: ${request.contadorNombre || 'sin nombre'}`,
      };

      if (accion === 'eliminar') {
        const productoId = Number(request.productoId || 0) || null;
        if (!productoId) {
          await doc.ref.update({ status: 'error', errorMessage: 'Falta el producto a eliminar.', appliedAt: new Date().toISOString() }).catch(() => {});
          failed += 1;
          continue;
        }
        try {
          const rows = await query('SELECT id, codigo, nombre, stock, image_local FROM products WHERE id = ?', [productoId]);
          const product = rows[0];
          if (!product) {
            // Ya no existe — el objetivo (que desaparezca) ya se cumplió.
            await doc.ref.update({ status: 'aplicado', duplicateResolved: true, duplicateMessage: 'El producto ya no existía en el POS.', appliedAt: new Date().toISOString() });
            applied += 1;
            continue;
          }
          if (Number(product.stock || 0) > 0) {
            await doc.ref.update({ status: 'error', errorMessage: 'No se puede eliminar: el producto tiene stock pendiente en el POS.', appliedAt: new Date().toISOString() }).catch(() => {});
            failed += 1;
            continue;
          }
          const saleHistoryRows = await query('SELECT 1 FROM sale_items WHERE product_id = ? LIMIT 1', [productoId]);
          if (saleHistoryRows.length) {
            await doc.ref.update({ status: 'error', errorMessage: 'No se puede eliminar: ya tiene historial de ventas. Márcalo inactivo en su lugar.', appliedAt: new Date().toISOString() }).catch(() => {});
            failed += 1;
            continue;
          }

          await withTransaction((conn) => conn.query('DELETE FROM products WHERE id = ?', [productoId]));
          if (typeof removeLocalProductImage === 'function') {
            await removeLocalProductImage(product.image_local).catch(() => {});
          }
          await doc.ref.update({ status: 'aplicado', appliedAt: new Date().toISOString() });

          try {
            await writeAuditLog({
              ...actorForRequest,
              userRole: 'Contador',
              moduleName: 'Productos',
              actionName: 'Producto eliminado por contador',
              detail: `${product.codigo} · ${product.nombre} (vía Portal del Contador)`,
            });
          } catch (auditError) {
            console.warn('[apply-pending-products] No se pudo registrar auditoría:', auditError.message);
          }
          applied += 1;
        } catch (error) {
          await doc.ref.update({ status: 'error', errorMessage: error.message || 'No se pudo eliminar el producto.', appliedAt: new Date().toISOString() }).catch(() => {});
          failed += 1;
        }
        continue;
      }

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
        itbisModo: request.itbisModo === 'monto' ? 'monto' : 'porcentaje',
        itbisMonto: Math.max(0, Number(request.itbisMonto || 0)),
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

      const actor = actorForRequest;

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

      if (accion === 'editar') {
        const productoId = Number(request.productoId || 0) || null;
        if (!productoId) {
          await doc.ref.update({ status: 'error', errorMessage: 'Falta el producto a editar.', appliedAt: new Date().toISOString() }).catch(() => {});
          failed += 1;
          continue;
        }
        try {
          const existingRows = await query('SELECT id FROM products WHERE id = ?', [productoId]);
          if (!existingRows.length) {
            await doc.ref.update({ status: 'error', errorMessage: 'El producto ya no existe en el POS — puede que se haya eliminado.', appliedAt: new Date().toISOString() }).catch(() => {});
            failed += 1;
            continue;
          }
          const conflict = await findConflictingProductForRequest(data, catalogBranchId, productoId);
          if (conflict) {
            await doc.ref.update({ status: 'error', errorMessage: `Ya existe otro producto con ese código o nombre (${conflict.codigo} · ${conflict.nombre}).`, appliedAt: new Date().toISOString() }).catch(() => {});
            failed += 1;
            continue;
          }

          await withTransaction((conn) => conn.query(
            `UPDATE products
             SET codigo = ?, nombre = ?, categoria = ?, marca = ?, unidad = ?,
                 precio_compra = ?, precio_venta = ?, stock = ?, stock_min = ?,
                 aplica_itbis = ?, itbis_modo = ?, itbis_monto = ?, branch_id = ?
             WHERE id = ?`,
            [data.codigo, data.nombre, data.categoria, data.marca, data.unidad,
             data.precioCompra, data.precioVenta, data.stock, data.stockMin,
             data.aplicaItbis ? 1 : 0, data.itbisModo, data.itbisMonto, catalogBranchId, productoId]
          ));

          if (request.imagenData) {
            try {
              const buffer = decodeDataUrlImage(request.imagenData);
              const saved = await saveProductImageBuffer({ productId: productoId, productName: data.nombre, buffer });
              await query('UPDATE products SET image_local = ? WHERE id = ?', [saved.imageLocal, productoId]);
            } catch (imgError) {
              console.warn('[apply-pending-products] No se pudo guardar la imagen:', imgError.message);
            }
          }

          await doc.ref.update({ status: 'aplicado', localProductId: productoId, appliedAt: new Date().toISOString() });

          try {
            await writeAuditLog({
              ...actor,
              userRole: 'Contador',
              moduleName: 'Productos',
              actionName: 'Producto editado por contador',
              detail: `${data.codigo} · ${data.nombre} (vía Portal del Contador)`,
            });
          } catch (auditError) {
            console.warn('[apply-pending-products] No se pudo registrar auditoría:', auditError.message);
          }
          applied += 1;
        } catch (error) {
          await doc.ref.update({ status: 'error', errorMessage: error.message || 'No se pudo editar el producto.', appliedAt: new Date().toISOString() }).catch(() => {});
          failed += 1;
        }
        continue;
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
