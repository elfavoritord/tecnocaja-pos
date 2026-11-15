'use strict';

// Catálogo en vivo entre cajas.
//
// Cuando una caja crea, edita, pausa o borra un producto (o ajusta inventario,
// registra una compra o cambia un combo), las demás cajas conectadas a esta PC
// reciben 'catalogo:actualizado' por Socket.IO y vuelven a leer el catálogo
// (js/app.js → refrescarCatalogoSinTocarLaVenta): la pantalla dividida de
// Ventas muestra el precio nuevo sin reiniciar. La venta en curso no se toca.
//
// Solo avisa: no manda datos del producto. Varios cambios seguidos (una
// importación, una compra con muchas líneas) salen como un solo aviso.

const EVENTO = 'catalogo:actualizado';

const METODOS_DE_LECTURA = new Set(['GET', 'HEAD', 'OPTIONS']);

// Rutas que cambian lo que se ve en el catálogo de Ventas.
function cambiaElCatalogo(method, path) {
  if (METODOS_DE_LECTURA.has(String(method || '').toUpperCase())) return false;
  const ruta = String(path || '').replace(/\/+$/, '');
  if (/^\/api\/products(\/|$)/.test(ruta)) return true;
  if (ruta === '/api/inventory/adjust') return true;
  if (/^\/api\/combos(\/|$)/.test(ruta)) return true;
  // Compras: solo lo que mueve inventario o precios (los borradores no).
  if (ruta === '/api/purchases') return true;
  if (/^\/api\/purchases\/drafts\/[^/]+\/registrar$/.test(ruta)) return true;
  if (/^\/api\/purchases\/[^/]+\/(receipts|void)$/.test(ruta)) return true;
  return false;
}

function createCatalogoEnVivo({ io, esperaMs = 500, logger = console } = {}) {
  let temporizador = null;

  function avisar() {
    if (temporizador) return;
    temporizador = setTimeout(() => {
      temporizador = null;
      try {
        io?.emit?.(EVENTO, { at: new Date().toISOString() });
      } catch (error) {
        logger?.warn?.('[catalogo-en-vivo] No se pudo avisar a las cajas:', error?.message || error);
      }
    }, esperaMs);
    if (typeof temporizador?.unref === 'function') temporizador.unref();
  }

  function middleware(req, res, next) {
    if (cambiaElCatalogo(req.method, req.path)) {
      res.on('finish', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) avisar();
      });
    }
    next();
  }

  return { middleware, avisar, cambiaElCatalogo };
}

module.exports = { createCatalogoEnVivo, cambiaElCatalogo, EVENTO };
