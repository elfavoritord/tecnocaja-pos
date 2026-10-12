'use strict';

/**
 * server/tienda-online/publisher.js
 *
 * Publica la tienda en Firestore desde la PC principal: perfil, catálogo,
 * imágenes livianas y existencia. Igual que el Centro de Control:
 *   - en segundo plano, nunca dentro de una venta;
 *   - sin Internet no hace nada y se pone al día al volver;
 *   - solo escribe lo que cambió (huella SHA-1 por documento).
 * Cuándo publica:
 *   - al momento (a los pocos segundos) cuando se cambia algo en el POS:
 *     productos, fotos, precios, existencia, ofertas, logo… (notifyCatalogChange,
 *     lo llama server.js después de esas rutas);
 *   - cada 30 s revisa la existencia y una huella liviana del catálogo: si otra
 *     caja de la red cambió un producto, lo nota sin esperar;
 *   - de todas formas, el catálogo completo cada 5 minutos, al guardar la
 *     configuración o con "Publicar ahora".
 */

const crypto = require('crypto');
const { PAGINA_CATALOGO, claveProducto } = require('./contrato');

const DEFAULTS = {
  tickMs: 30 * 1000,
  fullIntervalMs: 5 * 60 * 1000,
  firstRunDelayMs: 25 * 1000,
  cambioDebounceMs: 3000,
  imagesPerRun: 40,
  maxImageBase64: 900 * 1024,
};

const TAMANOS = {
  producto: { width: 480, height: 480 },
  logo: { width: 256, height: 256 },
  banner: { width: 1400, height: 520 },
};

function hash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function decodeDataUrl(dataUrl) {
  const match = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(String(dataUrl || ''));
  return match ? Buffer.from(match[1], 'base64') : null;
}

function createPublisher({
  nube,
  catalogBuilder,
  settingsStore,
  getLicenseId,
  isMain = () => true,
  monitor = null,
  processImage = null,
  readLocalImage = () => null,
  readPublishedIndex = async () => null,
  logger = console,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  options = {},
}) {
  const opts = { ...DEFAULTS, ...options };
  const hashes = new Map();
  const imagenesPublicadas = new Map();
  let ultimoStock = null;
  let slugReservado = null;
  let ultimaCompleta = 0;
  let ultimaHuellaConfig = null;
  let paginasPublicadas = null;
  let indiceLeido = false;
  let publicadaComoActiva = null;
  let desactivadaSeguidas = 0;
  let huellaCatalogo = null; // huella liviana del catálogo vista en el último ciclo
  let otraVueltaForzada = false; // llegó un cambio mientras se publicaba
  let running = null;
  let timers = [];
  let onConnectivity = null;

  const status = {
    ultimaPublicacion: null,
    ultimaExistencia: null,
    productosPublicados: 0,
    imagenesPendientes: 0,
    ultimoError: null,
    errorCodigo: null,
  };

  function internetCaido() {
    return monitor?.isKnownOffline?.() === true;
  }

  async function writeIfChanged(key, data, writer) {
    const h = hash(data);
    if (hashes.get(key) === h) return false;
    await writer();
    hashes.set(key, h);
    return true;
  }

  async function seedFromIndex() {
    if (indiceLeido) return;
    indiceLeido = true;
    const indice = await readPublishedIndex().catch(() => null);
    if (!indice) return;
    for (const [clave, version] of Object.entries(indice.imagenes || {})) imagenesPublicadas.set(clave, version);
    paginasPublicadas = Number(indice.paginas || 0) || null;
  }

  async function publishImages(imagenes) {
    if (!processImage) return 0;
    // El logo y el banner primero: salen en la pestaña, el ícono de la app y la portada.
    const pendientes = imagenes
      .filter((img) => imagenesPublicadas.get(img.clave) !== img.version)
      .sort((a, b) => Number(b.clave.startsWith('_')) - Number(a.clave.startsWith('_')));
    let hechas = 0;
    for (const img of pendientes.slice(0, opts.imagesPerRun)) {
      try {
        let buffer = null;
        if (img.fuente.tipo === 'local') buffer = await readLocalImage(img.fuente.valor);
        else buffer = decodeDataUrl(img.fuente.valor);
        if (!buffer) {
          imagenesPublicadas.set(img.clave, img.version);
          continue;
        }
        const out = await processImage(buffer, TAMANOS[img.tamano || 'producto']);
        if (!out?.data || out.data.length > opts.maxImageBase64) {
          logger.warn?.(`[tienda-online] Imagen ${img.clave} demasiado grande; no se publica.`);
          imagenesPublicadas.set(img.clave, img.version);
          continue;
        }
        await nube.writeImagen(img.clave, { mime: out.mime || 'image/webp', data: out.data, version: img.version });
        imagenesPublicadas.set(img.clave, img.version);
        hechas += 1;
      } catch (error) {
        logger.warn?.(`[tienda-online] No se pudo publicar la imagen ${img.clave}:`, error.message);
      }
    }
    // Imágenes de productos que ya no se publican.
    const vigentes = new Set(imagenes.map((img) => img.clave));
    for (const clave of [...imagenesPublicadas.keys()]) {
      if (!vigentes.has(clave)) {
        await nube.deleteImagen(clave).catch(() => {});
        imagenesPublicadas.delete(clave);
      }
    }
    status.imagenesPendientes = Math.max(0, pendientes.length - hechas);
    return hechas;
  }

  async function publishFull(store, built) {
    await seedFromIndex();
    // Primero las imágenes y después el perfil y el catálogo que las nombran:
    // si se anuncia la versión nueva del logo o de una foto antes de subirla,
    // la nube entregaba la imagen vieja con la dirección nueva y el navegador
    // la guardaba (logo y favicon que "no cambiaban").
    await publishImages(built.imagenes);
    // El perfil nombra solo la versión del logo/banner que ya está arriba.
    const perfil = { ...built.perfil };
    for (const [campo, clave] of [['logo', '_logo'], ['banner', '_banner']]) {
      const campoVersion = `${campo}Version`;
      if (!perfil[campo] || imagenesPublicadas.get(clave) === perfil[campoVersion]) continue;
      const arriba = imagenesPublicadas.get(clave);
      if (arriba) perfil[campoVersion] = arriba;
      else { perfil[campo] = null; perfil[campoVersion] = null; }
    }
    await writeIfChanged('perfil', perfil, () => nube.writePerfil(perfil));
    const paginas = chunk(built.productos, PAGINA_CATALOGO);
    const aEscribir = [];
    paginas.forEach((productos, n) => {
      const h = hash(productos);
      if (hashes.get(`pagina_${n}`) !== h) aEscribir.push([n, productos, h]);
    });
    const indice = {
      paginas: paginas.length,
      total: built.productos.length,
      version: hash(built.productos).slice(0, 12),
      imagenes: Object.fromEntries(imagenesPublicadas),
    };
    if (aEscribir.length || hashes.get('indice') !== hash(indice)) {
      await nube.writeCatalogo(indice, aEscribir.map(([n, productos]) => [n, productos]));
      for (const [n, , h] of aEscribir) hashes.set(`pagina_${n}`, h);
      hashes.set('indice', hash(indice));
    }
    if (paginasPublicadas !== null && paginasPublicadas > paginas.length) {
      for (let n = paginas.length; n < paginasPublicadas; n += 1) {
        await nube.deleteCatalogoPagina(n).catch(() => {});
        hashes.delete(`pagina_${n}`);
      }
    }
    paginasPublicadas = paginas.length;
    status.productosPublicados = built.productos.length;
    await nube.reconcileReservations().catch((error) => {
      logger.warn?.('[tienda-online] No se pudieron recalcular las reservas:', error.message);
    });
    ultimaCompleta = now();
    status.ultimaPublicacion = new Date(ultimaCompleta).toISOString();
  }

  async function publishStock(stock) {
    const cambios = {};
    for (const [clave, s] of Object.entries(stock)) {
      if (!ultimoStock || ultimoStock[clave] !== s) cambios[clave] = s;
    }
    if (Object.keys(cambios).length) await nube.writeStock(cambios);
    ultimoStock = { ...(ultimoStock || {}), ...stock };
    status.ultimaExistencia = new Date(now()).toISOString();
    return Object.keys(cambios).length;
  }

  async function publishDisabled(store) {
    if (publicadaComoActiva === false || !store.slug) return;
    await nube.writePerfil({ licenseId: getLicenseId(), slug: store.slug, activa: false });
    hashes.delete('perfil');
    publicadaComoActiva = false;
  }

  async function run({ force = false } = {}) {
    if (!isMain()) return { omitido: 'no_principal' };
    if (internetCaido()) return { omitido: 'sin_internet' };
    if (!String(getLicenseId() || '').trim()) {
      status.ultimoError = 'Este equipo no tiene licencia vinculada.';
      status.errorCodigo = 'NO_LICENSE';
      return { omitido: 'sin_licencia' };
    }
    const store = await settingsStore.read();
    if (!store.enabled) {
      // Una lectura rara al arrancar (base todavía conectándose, fila que aún no
      // existe) cerraba la tienda en la nube un par de minutos. Sin fila no se
      // toca nada, y en el ciclo automático hay que verla desactivada dos veces
      // seguidas; al desactivarla a mano (guardar / Publicar ahora = force) es
      // inmediato.
      if (store.existe === false) return { omitido: 'sin_configuracion' };
      desactivadaSeguidas += 1;
      if (!force && desactivadaSeguidas < 2) return { omitido: 'desactivada_por_confirmar' };
      await publishDisabled(store).catch((error) => { status.ultimoError = error.message; });
      return { omitido: 'desactivada' };
    }
    desactivadaSeguidas = 0;
    try {
      if (slugReservado !== store.slug) {
        const res = await nube.claimSlug(store.slug, { previousSlug: slugReservado || '', sucursalId: store.branchId });
        if (!res.ok) {
          status.ultimoError = `La dirección "${store.slug}" ya la usa otro negocio. Elige otra en Configuración → Mi Negocio → Tienda online.`;
          status.errorCodigo = 'SLUG_EN_USO';
          return { omitido: 'slug_en_uso' };
        }
        slugReservado = store.slug;
        hashes.delete('perfil');
      }
      const huellaConfig = hash({ s: store.settings, b: store.branchId, h: store.updatedAt });
      let completa = force || !ultimaCompleta || now() - ultimaCompleta >= opts.fullIntervalMs || huellaConfig !== ultimaHuellaConfig;
      if (!completa) {
        // Ciclo liviano: existencia + huella del catálogo. Si un producto, foto,
        // precio o el logo cambió (aunque haya sido en otra caja), se publica ya.
        const { stock, huella } = await catalogBuilder.buildStock({ store });
        const cambioCatalogo = Boolean(huella) && huellaCatalogo !== null && huella !== huellaCatalogo;
        if (huella) huellaCatalogo = huella;
        if (cambioCatalogo) completa = true;
        else await publishStock(stock);
      }
      if (completa) {
        const built = await catalogBuilder.build({ store });
        await publishFull(store, built);
        ultimaHuellaConfig = huellaConfig;
        await publishStock(built.stock);
      }
      publicadaComoActiva = true;
      status.ultimoError = null;
      status.errorCodigo = null;
      return { ok: true, completa };
    } catch (error) {
      status.ultimoError = error.message;
      status.errorCodigo = error.code || null;
      logger.warn?.('[tienda-online] Publicación fallida:', error.message);
      return { ok: false, error: error.message };
    }
  }

  function runSerial(opts2) {
    if (running) {
      // Un cambio que llega a mitad de una publicación no se pierde: otra vuelta al terminar.
      if (opts2?.force) otraVueltaForzada = true;
      return running;
    }
    running = run(opts2).finally(() => {
      running = null;
      if (otraVueltaForzada) {
        otraVueltaForzada = false;
        runSerial({ force: true }).catch(() => {});
      }
    });
    return running;
  }

  /**
   * Algo del catálogo cambió en el POS (producto, foto, precio, existencia,
   * oferta, logo…). Se publica a los pocos segundos; varios cambios seguidos
   * (una importación, editar varios productos) salen en una sola publicación.
   */
  let cambioTimer = null;
  function notifyCatalogChange() {
    if (cambioTimer) clearTimeoutFn(cambioTimer);
    cambioTimer = setTimeoutFn(() => {
      cambioTimer = null;
      runSerial({ force: true }).catch(() => {});
    }, opts.cambioDebounceMs);
    cambioTimer?.unref?.();
  }

  /** Tras una venta: sube la existencia nueva en unos segundos (una sola vez por ráfaga). */
  let stockTimer = null;
  function notifyStockChange() {
    if (stockTimer) return;
    stockTimer = setTimeoutFn(() => {
      stockTimer = null;
      runSerial().catch(() => {});
    }, 3000);
    stockTimer?.unref?.();
  }

  function start() {
    if (timers.length) return;
    timers.push(setTimeoutFn(() => { runSerial().catch(() => {}); }, opts.firstRunDelayMs));
    timers.push(setIntervalFn(() => { runSerial().catch(() => {}); }, opts.tickMs));
    for (const t of timers) t?.unref?.();
    if (monitor?.on) {
      onConnectivity = (online) => { if (online) runSerial().catch(() => {}); };
      monitor.on('change', onConnectivity);
    }
  }

  function stop() {
    for (const t of timers) clearIntervalFn(t);
    timers = [];
    if (cambioTimer) clearTimeoutFn(cambioTimer);
    cambioTimer = null;
    if (monitor?.off && onConnectivity) monitor.off('change', onConnectivity);
  }

  /** Olvida lo publicado (cambio de licencia, formateo, nombre nuevo). */
  function reset() {
    hashes.clear();
    imagenesPublicadas.clear();
    ultimoStock = null;
    slugReservado = null;
    ultimaCompleta = 0;
    paginasPublicadas = null;
    indiceLeido = false;
    huellaCatalogo = null;
  }

  return {
    start,
    stop,
    run: runSerial,
    reset,
    notifyStockChange,
    notifyCatalogChange,
    getStatus: () => ({ ...status, slugReservado }),
    claveProducto,
  };
}

module.exports = { createPublisher, TAMANOS };
