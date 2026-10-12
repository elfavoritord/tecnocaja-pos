'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { createTiendas } = require('./tiendas');
const { createIconos, colorValido } = require('./iconos');
const { createEstaticos, comprimirJson } = require('./estaticos');
const { cotizar, crearPedido, verPedido } = require('./pedidos');
const { validarPedido, validarItems } = require('./validacion');
const { createRateLimiter } = require('./rate-limit');
const { estaAbierta } = require('./horario');
const { slugValido } = require('../vendor/tienda-online/contrato');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createRouter({ db, FieldValue, now = () => new Date(), limits = {} }) {
  const router = express.Router();
  const tiendas = createTiendas({ db });
  const limitPedidos = createRateLimiter({ windowMs: 10 * 60 * 1000, max: limits.pedidos || 8 });
  const limitCotizar = createRateLimiter({ windowMs: 60 * 1000, max: limits.cotizar || 90 });
  const limitLectura = createRateLimiter({ windowMs: 60 * 1000, max: limits.lectura || 240 });

  function ipDe(req) {
    return String(req.ip || '').trim();
  }

  function wrap(handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        const status = Number(error.statusCode || 500);
        if (status >= 500) console.error('[tienda]', error);
        res.status(status).json({
          error: status >= 500 && !error.statusCode ? 'Ocurrió un error. Intenta de nuevo.' : error.message,
          code: error.code || undefined,
          campo: error.campo || undefined,
          errores: error.errores || undefined,
        });
      }
    };
  }

  function noEncontrada(res) {
    res.status(404).json({ error: 'Esta tienda no existe.' });
  }

  async function tiendaAbierta(req, res, { fresca = false } = {}) {
    const slug = String(req.params.slug || '');
    if (!slugValido(slug)) { noEncontrada(res); return null; }
    const tienda = await tiendas.cargar(slug, { fresca });
    if (!tienda) { noEncontrada(res); return null; }
    if (tienda.cerrada) {
      res.status(410).json({ error: `${tienda.perfil?.nombre || 'Esta tienda'} no está recibiendo pedidos en línea por ahora.`, code: 'TIENDA_CERRADA' });
      return null;
    }
    return tienda;
  }

  // Ninguna respuesta de la API se guarda en el navegador salvo que la ruta
  // diga otra cosa (catálogo: no-cache con ETag; fotos: caché larga). Sin
  // esto, un "tienda cerrada" (410) quedaba guardado y la PC del cliente
  // seguía viéndolo después de que la tienda volvía a abrir.
  router.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  }, comprimirJson);

  router.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'tecno-caja-tienda-online' });
  });

  // ── Páginas (una sola app: catálogo, carrito, checkout y seguimiento) ────
  // La página lleva el nombre, el color y los íconos de cada tienda: así la
  // pestaña muestra el logo y "Agregar a pantalla de inicio" la instala como
  // una app con el logo del negocio.
  const PLANTILLA = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const iconos = createIconos({ tiendas });
  const escHtml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const sendApp = wrap(async (req, res) => {
    const slug = String(req.params.slug || '');
    let html = PLANTILLA;
    if (slugValido(slug)) {
      const tienda = await tiendas.cargar(slug).catch(() => null);
      const perfil = tienda?.perfil;
      if (perfil) {
        const nombre = escHtml(String(perfil.nombre || 'Tienda').slice(0, 60));
        const color = colorValido(perfil.colorPrimario);
        const v = await iconos.version(slug);
        const base = `/t/${slug}`;
        html = html
          .replace('<title>Tienda en línea</title>', `<title>${nombre}</title>`)
          .replace('content="#10b981"', `content="${color}"`)
          .replace('<!--PWA-->', [
            `<link rel="manifest" href="${base}/manifest.webmanifest?v=${v}">`,
            `<link rel="icon" type="image/png" sizes="32x32" href="${base}/iconos/32.png?v=${v}">`,
            `<link rel="icon" type="image/png" sizes="64x64" href="${base}/iconos/64.png?v=${v}">`,
            `<link rel="apple-touch-icon" href="${base}/iconos/180.png?v=${v}">`,
            `<meta name="apple-mobile-web-app-title" content="${nombre}">`,
            `<meta name="application-name" content="${nombre}">`,
          ].join('\n  '));
      }
    }
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(html);
  });
  router.get('/t/:slug', sendApp);
  router.get('/t/:slug/pedido/:id', sendApp);

  router.get('/t/:slug/manifest.webmanifest', wrap(async (req, res) => {
    const slug = String(req.params.slug || '');
    const m = slugValido(slug) ? await iconos.manifiesto(slug) : null;
    if (!m) return noEncontrada(res);
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('application/manifest+json').send(JSON.stringify(m));
  }));

  router.get('/t/:slug/iconos/:archivo', wrap(async (req, res) => {
    const slug = String(req.params.slug || '');
    const match = /^(\d{2,3})(-m)?\.png$/.exec(String(req.params.archivo || ''));
    if (!slugValido(slug) || !match) return res.status(404).end();
    const r = await iconos.icono(slug, Number(match[1]), { maskable: Boolean(match[2]) });
    if (!r) return res.status(404).end();
    res.set('Content-Type', 'image/png');
    // Con el logo aún subiéndose (no exacto) se guarda solo 30 s.
    res.set('Cache-Control', !r.exacto ? 'public, max-age=30' : req.query.v ? 'public, max-age=604800, immutable' : 'public, max-age=300');
    res.send(r.png);
  }));
  router.use('/static', createEstaticos(PUBLIC_DIR), express.static(PUBLIC_DIR, { maxAge: '1h', index: false }));
  // Service worker: guarda la página, los archivos y las fotos en el teléfono
  // (abre al instante y sin señal muestra lo último). Va en la raíz para que
  // cubra /t/… y /static/…; nunca se guarda en caché él mismo.
  router.get('/sw.js', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.set('Service-Worker-Allowed', '/');
    res.type('application/javascript; charset=utf-8');
    res.sendFile(path.join(PUBLIC_DIR, 'sw.js'));
  });
  router.get('/', (req, res) => {
    res.type('html').send('<!doctype html><meta charset="utf-8"><title>Tecno Caja</title><p style="font-family:sans-serif">Tiendas en línea de Tecno Caja.</p>');
  });

  // ── API pública ──────────────────────────────────────────────────────────
  router.get('/api/tiendas/:slug', wrap(async (req, res) => {
    if (!limitLectura(`l:${ipDe(req)}`)) return res.status(429).json({ error: 'Demasiadas solicitudes. Espera un momento.' });
    const tienda = await tiendaAbierta(req, res);
    if (!tienda) return;
    const vista = tiendas.vistaPublica(req.params.slug, tienda, now());
    vista.tienda.abierta = estaAbierta(tienda.perfil.horario, now());
    vista.tienda.aceptaFueraDeHorario = tienda.perfil.horario?.aceptarFueraDeHorario !== false;
    res.set('Cache-Control', 'no-cache');
    res.json(vista);
  }));

  router.get('/api/tiendas/:slug/img/:clave', wrap(async (req, res) => {
    const pedida = String(req.query.v || '');
    const img = await tiendas.imagen(String(req.params.slug || ''), String(req.params.clave || ''), { version: pedida });
    if (!img) return res.status(404).end();
    res.set('Content-Type', img.mime);
    // "Guárdala un año" solo si es exactamente la versión pedida. Si el POS
    // todavía la está subiendo (llegó la versión nueva y la imagen no), se
    // entrega la que hay por 30 s y el navegador la vuelve a pedir.
    const exacta = Boolean(pedida) && img.version === pedida;
    res.set('Cache-Control', exacta ? 'public, max-age=31536000, immutable' : pedida ? 'public, max-age=30' : 'public, max-age=600');
    res.send(img.data);
  }));

  router.post('/api/tiendas/:slug/cotizar', express.json({ limit: '32kb' }), wrap(async (req, res) => {
    if (!limitCotizar(`c:${ipDe(req)}`)) return res.status(429).json({ error: 'Demasiadas solicitudes. Espera un momento.' });
    const tienda = await tiendaAbierta(req, res);
    if (!tienda) return;
    const entrega = req.body?.entrega?.tipo === 'delivery'
      ? { tipo: 'delivery', zonaId: String(req.body.entrega.zonaId || '').slice(0, 40) }
      : { tipo: 'retiro' };
    const r = cotizar(tienda, { items: validarItems(req.body), entrega }, now(), tiendas);
    res.json({
      lineas: r.lineas.map((l) => ({
        productoId: l.productoId, nombre: l.nombre, cantidad: l.cantidad, precioUnitario: l.precioUnitario,
        precioOriginal: l.precioOriginal, promocion: l.promocionNombre, subtotal: l.subtotal, descuento: l.descuento,
        itbis: l.itbis, total: l.total, disponible: r.disponibles[l.productoId],
      })),
      totales: r.totales,
      errores: r.errores,
    });
  }));

  router.post('/api/tiendas/:slug/pedidos', express.json({ limit: '32kb' }), wrap(async (req, res) => {
    const ip = ipDe(req);
    if (!limitPedidos(`p:${ip}:${req.params.slug}`)) {
      return res.status(429).json({ error: 'Has enviado varios pedidos seguidos. Espera unos minutos o llama a la tienda.' });
    }
    const datos = validarPedido(req.body);
    // Para crear el pedido se lee el catálogo fresco (sin caché).
    const tienda = await tiendaAbierta(req, res, { fresca: true });
    if (!tienda) return;
    const r = await crearPedido({ db, FieldValue, tienda, datos, nowDate: now(), origen: { ip, agente: req.headers['user-agent'] } });
    tiendas.invalidar(req.params.slug);
    res.status(r.repetido ? 200 : 201).json({
      pedidoId: r.pedidoId,
      numero: r.numero,
      token: r.token,
      total: r.total,
      repetido: r.repetido,
      seguimiento: `/t/${req.params.slug}/pedido/${r.pedidoId}?k=${r.token}`,
    });
  }));

  router.get('/api/tiendas/:slug/pedidos/:id', wrap(async (req, res) => {
    if (!limitLectura(`l:${ipDe(req)}`)) return res.status(429).json({ error: 'Demasiadas solicitudes. Espera un momento.' });
    const slug = String(req.params.slug || '');
    const licenseId = await tiendas.licenciaDe(slug);
    if (!licenseId) return noEncontrada(res);
    const tienda = await tiendas.cargar(slug).catch(() => null);
    const pedido = await verPedido({
      db, licenseId, pedidoId: req.params.id, token: String(req.query.k || ''), perfil: tienda?.perfil,
    });
    if (!pedido) return res.status(404).json({ error: 'No encontramos ese pedido.' });
    res.set('Cache-Control', 'no-store');
    res.json(pedido);
  }));

  return router;
}

module.exports = { createRouter };
