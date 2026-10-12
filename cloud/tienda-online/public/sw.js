/* Service worker de la tienda online de Tecno Caja.
 * Guarda en el teléfono la página, sus archivos (app.js, styles.css…), los
 * íconos y las fotos de los productos: la tienda abre al instante y, sin
 * señal, muestra lo último que se vio. Los datos que importan (precios,
 * existencia, pedidos) siempre se piden al servidor: este archivo NO toca
 * /api/… salvo las fotos, que no cambian (cada versión trae su ?v=). */
'use strict';

// v2: borra las fotos/íconos guardados con la versión equivocada.
const VERSION = 'tc-tienda-v2';
const ESTATICOS = `${VERSION}-estaticos`;
const FOTOS = `${VERSION}-fotos`;
const PAGINAS = `${VERSION}-paginas`;
const MAX_ESTATICOS = 30;
const MAX_FOTOS = 400;
const MAX_PAGINAS = 20;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const claves = await caches.keys();
    await Promise.all(claves.filter((k) => k.startsWith('tc-tienda-') && !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function recortar(nombre, limite) {
  const cache = await caches.open(nombre);
  const claves = await cache.keys();
  for (let i = 0; i < claves.length - limite; i += 1) await cache.delete(claves[i]);
}

/** Lo guardado primero; si no está, de la red y se guarda (archivos que no cambian). */
async function primeroGuardado(request, nombre, limite) {
  const cache = await caches.open(nombre);
  const guardado = await cache.match(request);
  if (guardado) return guardado;
  const respuesta = await fetch(request);
  // Solo lo que el servidor marca como definitivo (immutable): una foto que el
  // POS todavía está subiendo llega con caché corta y no se guarda.
  if (respuesta.ok && /immutable/.test(respuesta.headers.get('Cache-Control') || '')) {
    await cache.put(request, respuesta.clone());
    recortar(nombre, limite);
  }
  return respuesta;
}

/** La red primero (para ver siempre lo nuevo); sin señal, lo último guardado. */
async function primeroRed(request) {
  const cache = await caches.open(PAGINAS);
  try {
    const respuesta = await fetch(request);
    if (respuesta.ok) {
      await cache.put(request, respuesta.clone());
      recortar(PAGINAS, MAX_PAGINAS);
    }
    return respuesta;
  } catch (error) {
    const guardado = await cache.match(request, { ignoreSearch: true });
    if (guardado) return guardado;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const versionado = url.searchParams.has('v');
  if (url.pathname.startsWith('/static/') && versionado) {
    event.respondWith(primeroGuardado(request, ESTATICOS, MAX_ESTATICOS));
  } else if (versionado && (/^\/api\/tiendas\/[^/]+\/img\//.test(url.pathname) || /^\/t\/[^/]+\/iconos\//.test(url.pathname))) {
    event.respondWith(primeroGuardado(request, FOTOS, MAX_FOTOS));
  } else if (request.mode === 'navigate' && url.pathname.startsWith('/t/')) {
    event.respondWith(primeroRed(request));
  }
});
