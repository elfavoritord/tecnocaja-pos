'use strict';

/**
 * server/tienda-online/orders-sync.js
 *
 * Pedidos nube ⇄ POS. Corre solo en la PC principal (la de la base de datos)
 * y solo con Internet; sin Internet el POS sigue vendiendo normal y todo esto
 * se pone al día al volver la conexión.
 *
 *   Nube → POS: escucha (y por si acaso revisa cada minuto) los pedidos con
 *               pos.importado = false. Se guardan con INSERT OR IGNORE por
 *               cloud_id y DESPUÉS se marcan importados: si algo se corta en
 *               medio, el reintento no duplica nada.
 *   POS → Nube: los pedidos con cloud_sync_pending = 1 suben su estado,
 *               historial, mensajes al cliente y la venta. La reserva de
 *               existencia se libera en esa misma transacción.
 */

const { ESTADOS_FINALES } = require('./contrato');

const DEFAULTS = {
  pollMs: 60 * 1000,
  pushMs: 15 * 1000,
  dispatchMs: 30 * 1000,
  firstRunDelayMs: 20 * 1000,
};

function esErrorDeDatos(error) {
  const code = Number(error?.statusCode || 0);
  return code === 400 || code === 403;
}

function createOrdersSync({
  nube,
  orders,
  notifier,
  settingsStore,
  getLicenseId,
  isMain = () => true,
  monitor = null,
  getServerId = () => '',
  getStoreStock = async () => ({}),
  sqlDateToIso,
  emit = () => {},
  logger = console,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  options = {},
}) {
  const opts = { ...DEFAULTS, ...options };
  const status = {
    escuchando: false,
    ultimaRecepcion: null,
    ultimoEnvio: null,
    importados: 0,
    ultimoError: null,
  };
  let timers = [];
  let unsubscribe = null;
  let chain = Promise.resolve();
  let pushing = false;
  let polling = false;
  let onConnectivity = null;

  function internetCaido() {
    return monitor?.isKnownOffline?.() === true;
  }

  async function puedeCorrer() {
    if (!isMain() || internetCaido() || !String(getLicenseId() || '').trim()) return false;
    const store = await settingsStore.read().catch(() => null);
    return Boolean(store?.enabled);
  }

  async function importDoc(doc) {
    const licenseId = String(getLicenseId() || '').trim();
    try {
      const result = await orders.importOrder(doc.id, doc.data || {}, { licenseId });
      await nube.markImported(doc.id, { serverId: getServerId() });
      if (result.inserted) {
        status.importados += 1;
        status.ultimaRecepcion = new Date().toISOString();
        const row = await orders.getRow(result.orderId);
        const order = orders.mapOrderRow(row);
        emit('tienda-online:nuevo-pedido', {
          id: order.id,
          numero: order.numero,
          cliente: order.cliente.nombre,
          total: order.totales.total,
          moneda: order.moneda,
          entrega: order.entrega.tipo,
        });
        notifier?.notifyOwnerNewOrder(order).catch(() => {});
      }
      return result;
    } catch (error) {
      if (esErrorDeDatos(error)) {
        // Un pedido mal formado no debe reintentarse para siempre.
        logger.warn?.(`[tienda-online] Pedido ${doc.id} ignorado: ${error.message}`);
        await nube.markImported(doc.id, { serverId: `rechazado: ${error.message}`.slice(0, 120) }).catch(() => {});
        return { inserted: false, rechazado: true };
      }
      status.ultimoError = `Recepción: ${error.message}`;
      throw error;
    }
  }

  /** Procesa los pedidos de uno en uno, en orden de llegada. */
  function handleDocs(docs) {
    chain = chain.then(async () => {
      for (const doc of docs) {
        await importDoc(doc).catch((error) => {
          logger.warn?.(`[tienda-online] No se pudo recibir el pedido ${doc.id}:`, error.message);
        });
      }
    });
    return chain;
  }

  async function pollOnce() {
    if (polling || !(await puedeCorrer())) return { importados: 0 };
    polling = true;
    try {
      const docs = await nube.fetchPendingOrders(50);
      const antes = status.importados;
      await handleDocs(docs);
      return { importados: status.importados - antes };
    } catch (error) {
      status.ultimoError = `Recepción: ${error.message}`;
      return { importados: 0, error: error.message };
    } finally {
      polling = false;
    }
  }

  async function ensureListener() {
    if (!(await puedeCorrer())) {
      if (unsubscribe) {
        try { unsubscribe(); } catch (_error) { /* nada */ }
        unsubscribe = null;
        status.escuchando = false;
      }
      return;
    }
    if (unsubscribe) return;
    try {
      unsubscribe = nube.listenPendingOrders(
        (docs) => { handleDocs(docs); },
        (error) => {
          status.ultimoError = `Escucha: ${error.message}`;
          status.escuchando = false;
          unsubscribe = null;
        },
      );
      status.escuchando = Boolean(unsubscribe);
    } catch (error) {
      status.ultimoError = `Escucha: ${error.message}`;
      unsubscribe = null;
    }
  }

  async function pushOnce() {
    if (pushing || !isMain() || internetCaido() || !String(getLicenseId() || '').trim()) return { enviados: 0 };
    pushing = true;
    let enviados = 0;
    try {
      const rows = await orders.pendingSync(20);
      for (const row of rows) {
        try {
          const conVenta = Boolean(row.sale_id);
          const liberarReserva = conVenta || ['cancelado', 'rechazado'].includes(row.status);
          let stockActual = null;
          if (liberarReserva && conVenta && Number(row.reservation_released || 0) === 0) {
            stockActual = await getStoreStock(await orders.itemProductIds(row.id));
          }
          const mensajes = (await notifier.webMessages(row.id)).map((m) => ({
            en: sqlDateToIso(m.created_at),
            texto: m.message,
          }));
          const result = await nube.pushOrderUpdate(row.cloud_id, {
            estado: row.status,
            historial: await orders.historyForCloud(row.id),
            mensajes,
            venta: row.sale_invoice_number ? { factura: row.sale_invoice_number } : null,
            liberarReserva,
            stockActual,
            final: ESTADOS_FINALES.includes(row.status),
          });
          await orders.markSynced(row, { liberada: result.liberada });
          await notifier.markWebSent(row.id);
          enviados += 1;
        } catch (error) {
          await orders.markSyncError(row, error.message).catch(() => {});
          status.ultimoError = `Envío: ${error.message}`;
        }
      }
      if (enviados) status.ultimoEnvio = new Date().toISOString();
      return { enviados };
    } finally {
      pushing = false;
    }
  }

  async function dispatchOnce() {
    if (!isMain()) return { enviados: 0 };
    return notifier.dispatchPending().catch((error) => ({ enviados: 0, error: error.message }));
  }

  async function runAll() {
    await ensureListener().catch(() => {});
    await pollOnce().catch(() => {});
    await pushOnce().catch(() => {});
    await dispatchOnce().catch(() => {});
  }

  function start() {
    if (timers.length) return;
    timers.push(setTimeoutFn(() => { runAll(); }, opts.firstRunDelayMs));
    timers.push(setIntervalFn(() => { ensureListener().catch(() => {}); pollOnce().catch(() => {}); }, opts.pollMs));
    timers.push(setIntervalFn(() => { pushOnce().catch(() => {}); }, opts.pushMs));
    timers.push(setIntervalFn(() => { dispatchOnce().catch(() => {}); }, opts.dispatchMs));
    for (const t of timers) t?.unref?.();
    if (monitor?.on) {
      onConnectivity = (online) => { if (online) runAll(); };
      monitor.on('change', onConnectivity);
    }
  }

  function stop() {
    for (const t of timers) clearIntervalFn(t);
    timers = [];
    if (unsubscribe) {
      try { unsubscribe(); } catch (_error) { /* nada */ }
      unsubscribe = null;
    }
    if (monitor?.off && onConnectivity) monitor.off('change', onConnectivity);
  }

  return {
    start,
    stop,
    pollOnce,
    pushOnce,
    dispatchOnce,
    runAll,
    handleDocs,
    getStatus: () => ({ ...status }),
  };
}

module.exports = { createOrdersSync };
