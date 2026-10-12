'use strict';

/**
 * server/tienda-online/index.js
 *
 * Módulo opcional Tienda Online (se activa en Configuración → Mi Negocio).
 * La tienda es solo otro canal de pedidos: el catálogo, el inventario, los
 * clientes, la venta, la caja, el NCF/e-CF, el delivery y los reportes son
 * los del POS. Ver docs/TIENDA-ONLINE.md.
 *
 * server.js crea UNA instancia con sus dependencias (factory + DI) y:
 *   - monta createTiendaOnlineRouter en /api/tienda-online;
 *   - llama a los hooks dentro de POST /api/sales, de la anulación de
 *     facturas y del estado de entrega;
 *   - arranca publicador y sincronización en startHttpServer.
 */

const { ensureTiendaOnlineSchema } = require('./schema');
const { createSettingsStore } = require('./settings');
const { createCatalogBuilder } = require('./catalog');
const { createNube } = require('./nube');
const { createOrdersService, sqlDateToIso } = require('./orders');
const { createNotifier } = require('./notifier');
const { createOrdersSync } = require('./orders-sync');
const { createPublisher } = require('./publisher');
const { createFotos } = require('./fotos');

// Servicio Cloud Run "tecno-caja-tienda" en el mismo proyecto que el gateway
// e-CF (us-east1). TECNO_CAJA_TIENDA_URL lo cambia (dominio propio, pruebas).
const DEFAULT_PUBLIC_BASE_URL = 'https://tecno-caja-tienda-1052855422372.us-east1.run.app';

function createTiendaOnline(deps) {
  const {
    query,
    withTransaction,
    addColumnIfMissing,
    nowSql,
    formatSqlDate,
    getLicenseId,
    getFirestore,
    getFieldValue,
    isMain = () => true,
    monitor = null,
    getIo = () => null,
    getServerId = () => '',
    mapClientRow,
    getWaBot = () => null,
    processImage = null,
    readLocalImage = () => null,
    // Fotos adicionales para la tienda: mismo guardado que la foto del producto.
    saveProductImage = null,
    removeProductImage = async () => {},
    logger = console,
  } = deps;

  let ready = null;
  function ensureReady() {
    if (!ready) {
      ready = ensureTiendaOnlineSchema({ query, addColumnIfMissing }).catch((error) => {
        ready = null;
        throw error;
      });
    }
    return ready;
  }

  function emit(event, payload) {
    try {
      getIo()?.emit(event, payload);
    } catch (_error) {
      // Un aviso de pantalla nunca rompe la operación.
    }
  }

  const settingsStore = createSettingsStore({ query, nowSql });
  const catalogBuilder = createCatalogBuilder({ query, getLicenseId, readBanner: settingsStore.readBanner });
  const nube = createNube({ getFirestore, getFieldValue, getLicenseId });
  const notifier = createNotifier({ query, nowSql, getWaBot, logger });
  const orders = createOrdersService({ query, withTransaction, nowSql, formatSqlDate, mapClientRow, notifier, emit, logger });
  const fotos = createFotos({ query, saveImage: saveProductImage, removeImage: removeProductImage });
  const publisher = createPublisher({
    nube,
    catalogBuilder,
    settingsStore,
    getLicenseId,
    isMain,
    monitor,
    processImage,
    readLocalImage,
    readPublishedIndex: () => nube.readCatalogIndex(),
    logger,
  });
  const sync = createOrdersSync({
    nube,
    orders,
    notifier,
    settingsStore,
    getLicenseId,
    isMain,
    monitor,
    getServerId,
    sqlDateToIso,
    getStoreStock: async (productIds) => catalogBuilder.stockOf(await settingsStore.read(), productIds),
    emit,
    logger,
  });

  function publicBaseUrl() {
    return String(process.env.TECNO_CAJA_TIENDA_URL || DEFAULT_PUBLIC_BASE_URL).trim().replace(/\/+$/, '');
  }

  function publicUrl(slug) {
    return slug ? `${publicBaseUrl()}/t/${slug}` : '';
  }

  // Cada servidor (principal o caja terminal con su propio servidor) avisa a
  // SUS pantallas cuando cambia algo en la base compartida: así la caja 2 ve
  // al momento que la caja 1 ya cobró el pedido.
  let watcherTimer = null;
  let lastSignature = null;
  let lastMaxId = null;
  async function watchLocalChanges() {
    try {
      const store = await settingsStore.read();
      if (!store.enabled) return;
      const rows = await query(
        `SELECT COUNT(*) AS n, MAX(id) AS max_id, MAX(change_seq) AS seq,
                SUM(CASE WHEN status = 'nuevo' THEN 1 ELSE 0 END) AS nuevos
           FROM online_orders`,
      );
      const r = rows[0] || {};
      const signature = `${r.n}|${r.max_id}|${r.seq}|${r.nuevos}`;
      const maxId = Number(r.max_id || 0);
      if (lastSignature !== null && signature !== lastSignature) {
        emit('tienda-online:cambio', { nuevos: Number(r.nuevos || 0) });
        if (lastMaxId !== null && maxId > lastMaxId) {
          const nuevos = await query(
            `SELECT id, order_number, customer_name, total, currency, delivery_type
               FROM online_orders WHERE id > ? ORDER BY id LIMIT 10`,
            [lastMaxId],
          );
          for (const o of nuevos) {
            emit('tienda-online:nuevo-pedido', {
              id: Number(o.id),
              numero: Number(o.order_number),
              cliente: o.customer_name,
              total: Number(o.total || 0),
              moneda: o.currency || 'RD$',
              entrega: o.delivery_type,
            });
          }
        }
      }
      lastSignature = signature;
      lastMaxId = maxId;
    } catch (_error) {
      // La tabla puede no existir todavía o la base estar caída: se reintenta.
    }
  }

  async function start() {
    await ensureReady().catch((error) => {
      logger.warn?.('[tienda-online] No se pudo preparar el esquema:', error.message);
    });
    publisher.start();
    sync.start();
    // Pedidos que llegaron antes de guardar clientes automáticamente (solo la PC principal).
    if (isMain()) {
      orders.vincularClientesPendientes().catch((error) => {
        logger.warn?.('[tienda-online] No se pudieron ligar los clientes de pedidos anteriores:', error.message);
      });
    }
    if (!watcherTimer) {
      watcherTimer = setInterval(() => { watchLocalChanges(); }, 8000);
      watcherTimer.unref?.();
    }
  }

  function stop() {
    publisher.stop();
    sync.stop();
    if (watcherTimer) clearInterval(watcherTimer);
    watcherTimer = null;
  }

  async function getStatus() {
    const store = await settingsStore.read();
    const licenseId = String(getLicenseId() || '').trim();
    let firebase = false;
    try { firebase = Boolean(getFirestore()); } catch (_error) { firebase = false; }
    const resumen = await orders.summary().catch(() => null);
    return {
      activa: store.enabled,
      slug: store.slug,
      url: publicUrl(store.slug),
      licencia: Boolean(licenseId),
      firebase,
      principal: Boolean(isMain()),
      internet: monitor?.isKnownOffline?.() === true ? false : (monitor?.getStatus?.().online ?? null),
      publicacion: publisher.getStatus(),
      pedidos: sync.getStatus(),
      resumen,
    };
  }

  const hooks = {
    /** Dentro de POST /api/sales, antes de las líneas: precios del pedido. */
    agreedPricesInTx: (conn, orderId) => orders.agreedPricesInTx(conn, orderId),
    /** Dentro de POST /api/sales, después de insertar la venta. */
    claimForSaleInTx: (conn, args) => orders.claimForSaleInTx(conn, args),
    /** Después del commit de la venta (en segundo plano). */
    afterSaleCommitted(orderId) {
      emit('tienda-online:cambio', { id: Number(orderId), venta: true });
      publisher.notifyStockChange();
      sync.pushOnce().catch(() => {});
    },
    /** Dentro de la anulación de una factura. */
    onSaleCancelledInTx: (conn, sale, actor) => orders.onSaleCancelledInTx(conn, sale, actor),
    afterSaleCancelled(orderId) {
      if (!orderId) return;
      emit('tienda-online:cambio', { id: Number(orderId) });
      sync.pushOnce().catch(() => {});
    },
    /** Estado de entrega de una venta delivery (panel Delivery). */
    onSaleDeliveryStatus: (saleId, estado, actor) => orders.onSaleDeliveryStatus(saleId, estado, actor),
    /** Tras cualquier venta: la existencia publicada se refresca sola. */
    afterAnySale() {
      publisher.notifyStockChange();
    },
    /**
     * Tras cambiar algo del catálogo en el POS (producto, foto, precio,
     * existencia, oferta, categoría, logo/configuración): se publica en
     * segundos. Varios cambios seguidos salen en una sola publicación.
     */
    afterCatalogChange() {
      publisher.notifyCatalogChange();
    },
  };

  // Rutas del POS que cambian lo que se ve en la tienda. Después de que
  // respondan bien, se publica en segundos (sin tocar cada ruta de server.js).
  const RUTAS_CATALOGO = /^\/api\/(products|categories|inventory|purchases|promotions|config|branches|transfers)(\/|$)/;
  function vigilarCambiosCatalogo() {
    return (req, res, next) => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && RUTAS_CATALOGO.test(req.path)) {
        res.on('finish', () => {
          if (res.statusCode < 400) hooks.afterCatalogChange();
        });
      }
      next();
    };
  }

  return {
    ensureReady,
    start,
    vigilarCambiosCatalogo,
    stop,
    getStatus,
    publicUrl,
    settingsStore,
    catalogBuilder,
    nube,
    orders,
    notifier,
    publisher,
    sync,
    fotos,
    hooks,
  };
}

module.exports = { createTiendaOnline, DEFAULT_PUBLIC_BASE_URL };
