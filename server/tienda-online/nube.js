'use strict';

/**
 * server/tienda-online/nube.js
 *
 * Todo lo que el POS lee y escribe en Firestore para la tienda online. Las
 * rutas salen de contrato.js; las mismas las usa el servicio de la nube.
 *
 * Reglas:
 *   - Solo bajo businesses/{licencia} (y la reserva del nombre en tienda_slugs).
 *   - Las reservas de existencia (items.pX.r) solo bajan dentro de una
 *     transacción que apaga reservaActiva en el pedido: así se liberan una
 *     sola vez aunque el envío se reintente.
 */

const { rutas, claveProducto } = require('./contrato');

function createNube({ getFirestore, getFieldValue, getLicenseId }) {
  function db() {
    const firestore = getFirestore();
    if (!firestore) {
      const error = new Error('Firebase no está disponible en este equipo.');
      error.code = 'NO_FIREBASE';
      throw error;
    }
    return firestore;
  }

  function lic() {
    const id = String(getLicenseId() || '').trim();
    if (!id) {
      const error = new Error('Este equipo no tiene licencia vinculada; la tienda online necesita la licencia del negocio.');
      error.code = 'NO_LICENSE';
      throw error;
    }
    return id;
  }

  function fv() {
    return getFieldValue();
  }

  /**
   * Reserva el nombre público de la tienda para esta licencia.
   * @returns {{ ok: boolean, conflict?: boolean }}
   */
  async function claimSlug(slug, { previousSlug = '', sucursalId = null } = {}) {
    const firestore = db();
    const licenseId = lic();
    const ref = firestore.doc(rutas.slug(slug));
    const result = await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const prevRef = previousSlug && previousSlug !== slug ? firestore.doc(rutas.slug(previousSlug)) : null;
      const prevSnap = prevRef ? await tx.get(prevRef) : null;
      if (snap.exists && snap.data().licenseId !== licenseId) return { ok: false, conflict: true };
      tx.set(ref, { licenseId, sucursalId: sucursalId || null, actualizadoEn: fv().serverTimestamp() }, { merge: true });
      if (prevSnap?.exists && prevSnap.data().licenseId === licenseId) tx.delete(prevRef);
      return { ok: true };
    });
    return result;
  }

  async function releaseSlug(slug) {
    if (!slug) return;
    const firestore = db();
    const licenseId = lic();
    const ref = firestore.doc(rutas.slug(slug));
    const snap = await ref.get();
    if (snap.exists && snap.data().licenseId === licenseId) await ref.delete();
  }

  async function writeDoc(path, data) {
    await db().doc(path).set(data);
  }

  async function deleteDoc(path) {
    await db().doc(path).delete();
  }

  async function writePerfil(perfil) {
    await writeDoc(rutas.perfil(lic()), { ...perfil, actualizadoEn: fv().serverTimestamp() });
  }

  async function writeCatalogo(indice, paginas) {
    const licenseId = lic();
    for (const [n, productos] of paginas) {
      await writeDoc(rutas.catalogoPagina(licenseId, n), { pagina: n, productos, version: indice.version });
    }
    await writeDoc(rutas.catalogo(licenseId), { ...indice, actualizadoEn: fv().serverTimestamp() });
  }

  async function readCatalogIndex() {
    const snap = await db().doc(rutas.catalogo(lic())).get();
    return snap.exists ? snap.data() : null;
  }

  async function deleteCatalogoPagina(n) {
    await deleteDoc(rutas.catalogoPagina(lic(), n));
  }

  /**
   * Publica existencias: { p12: 4, p13: 0 }. Solo toca "s" de cada producto;
   * la reserva "r" y el contador de pedidos los maneja la nube.
   */
  async function writeStock(cambios) {
    const entries = Object.entries(cambios || {});
    if (!entries.length) return;
    const items = {};
    for (const [clave, s] of entries) items[clave] = { s: Number(s) || 0 };
    await db().doc(rutas.stock(lic())).set({ items, actualizadoEn: fv().serverTimestamp() }, { merge: true });
  }

  async function writeImagen(clave, imagen) {
    await writeDoc(rutas.imagen(lic(), clave), { ...imagen, actualizadoEn: fv().serverTimestamp() });
  }

  async function deleteImagen(clave) {
    await deleteDoc(rutas.imagen(lic(), clave));
  }

  function pendingOrdersQuery(limit = 50) {
    return db().collection(rutas.pedidos(lic())).where('pos.importado', '==', false).limit(limit);
  }

  async function fetchPendingOrders(limit = 50) {
    const snap = await pendingOrdersQuery(limit).get();
    return snap.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
  }

  /** Escucha pedidos nuevos en tiempo real. Devuelve la función para dejar de escuchar. */
  function listenPendingOrders(onDocs, onError) {
    const q = pendingOrdersQuery(50);
    if (typeof q.onSnapshot !== 'function') return null;
    return q.onSnapshot(
      (snap) => onDocs(snap.docs.map((doc) => ({ id: doc.id, data: doc.data() }))),
      (error) => onError?.(error),
    );
  }

  async function markImported(orderId, { serverId = '' } = {}) {
    await db().doc(rutas.pedido(lic(), orderId)).update({
      'pos.importado': true,
      'pos.importadoEn': fv().serverTimestamp(),
      'pos.servidor': serverId || null,
    });
  }

  /**
   * Envía el estado del pedido (y libera su reserva si toca) en una sola
   * transacción.
   * @param {string} orderId
   * @param {object} cambio { estado, historial, mensajes, venta, liberarReserva, stockActual }
   * @returns {{ liberada: boolean, existe: boolean }}
   */
  async function pushOrderUpdate(orderId, cambio) {
    const firestore = db();
    const licenseId = lic();
    const orderRef = firestore.doc(rutas.pedido(licenseId, orderId));
    const stockRef = firestore.doc(rutas.stock(licenseId));
    return firestore.runTransaction(async (tx) => {
      const orderSnap = await tx.get(orderRef);
      const stockSnap = await tx.get(stockRef);
      if (!orderSnap.exists) return { liberada: false, existe: false };
      const order = orderSnap.data();
      const update = {
        estado: cambio.estado,
        actualizadoEn: fv().serverTimestamp(),
        historial: cambio.historial || [],
        mensajes: cambio.mensajes || [],
        'pos.venta': cambio.venta || null,
      };
      const stockUpdate = {};
      let liberada = false;
      if (cambio.liberarReserva && order.reservaActiva) {
        for (const [clave, cantidad] of Object.entries(order.reservas || {})) {
          stockUpdate[`items.${clave}.r`] = fv().increment(-Math.abs(Number(cantidad) || 0));
        }
        update.reservaActiva = false;
        liberada = true;
      }
      if (liberada && cambio.stockActual) {
        for (const [clave, s] of Object.entries(cambio.stockActual)) {
          stockUpdate[`items.${clave}.s`] = Number(s) || 0;
        }
      }
      tx.update(orderRef, update);
      if (Object.keys(stockUpdate).length && stockSnap.exists) tx.update(stockRef, stockUpdate);
      return { liberada, existe: true };
    });
  }

  /**
   * Recalcula la reserva de cada producto con los pedidos que aún la tienen
   * activa. Corrige cualquier desfase (un pedido borrado a mano, etc.).
   */
  async function reconcileReservations() {
    const firestore = db();
    const licenseId = lic();
    const stockRef = firestore.doc(rutas.stock(licenseId));
    const openQuery = firestore.collection(rutas.pedidos(licenseId)).where('reservaActiva', '==', true).limit(500);
    return firestore.runTransaction(async (tx) => {
      const stockSnap = await tx.get(stockRef);
      const open = await tx.get(openQuery);
      if (!stockSnap.exists) return { ajustados: 0 };
      const reservado = {};
      for (const doc of open.docs) {
        for (const [clave, cantidad] of Object.entries(doc.data().reservas || {})) {
          reservado[clave] = (reservado[clave] || 0) + (Number(cantidad) || 0);
        }
      }
      const items = stockSnap.data().items || {};
      const update = {};
      for (const clave of new Set([...Object.keys(items), ...Object.keys(reservado)])) {
        const actual = Number(items[clave]?.r || 0);
        const correcto = Math.round((reservado[clave] || 0) * 100) / 100;
        if (Math.abs(actual - correcto) > 0.001) update[`items.${clave}.r`] = correcto;
      }
      if (Object.keys(update).length) tx.update(stockRef, update);
      return { ajustados: Object.keys(update).length };
    });
  }

  return {
    claimSlug,
    releaseSlug,
    writePerfil,
    writeCatalogo,
    readCatalogIndex,
    deleteCatalogoPagina,
    writeStock,
    writeImagen,
    deleteImagen,
    fetchPendingOrders,
    listenPendingOrders,
    markImported,
    pushOrderUpdate,
    reconcileReservations,
    claveProducto,
  };
}

module.exports = { createNube };
