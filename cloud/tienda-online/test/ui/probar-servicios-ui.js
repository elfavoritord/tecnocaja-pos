'use strict';

// La tienda con servicios en un navegador real: el servicio de verdad sobre un
// Firestore en memoria. Filtro por tipo, precio oculto, solicitudes y tienda sin carrito.
//   node cloud/tienda-online/test/ui/probar-servicios-ui.js [carpeta-de-capturas]

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { createApp } = require('../../lib/app');
const { createFakeFirestore } = require('../../../../tests/helpers/fake-firestore');

const CAPTURAS = process.argv[2] || '';
const LIC = 'pos_5555666677778888';
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const resultados = [];
function ok(nombre, cond, detalle = '') {
  resultados.push({ nombre, ok: Boolean(cond) });
  console.log(`${cond ? '  ok ' : 'FALLA'} ${nombre}${!cond && detalle ? ` → ${detalle}` : ''}`);
}

const articulo = (id, nombre, categoria, precio, tipo) => ({
  id, nombre, categoria, precio, tipo, modoVenta: 'unidad', unidad: tipo === 'servicio' ? 'servicio' : 'und', controlaStock: tipo !== 'servicio', itbis: true, orden: id,
});

function sembrar(slug, perfil, lista) {
  const stock = {};
  for (const p of lista) if (p.controlaStock) stock[`p${p.id}`] = { s: 8 };
  return {
    [`tienda_slugs/${slug}`]: { licenseId: LIC },
    [`businesses/${LIC}/tiendaOnline/perfil`]: {
      licenseId: LIC, slug, activa: true, nombre: 'Soluciones Caribe', moneda: 'RD$', tasaItbis: 18, whatsapp: '8095550000',
      pagos: [{ codigo: 'efectivo', etiqueta: 'Efectivo' }], retiro: { habilitado: true }, delivery: { habilitado: false }, categorias: ['Limpieza', 'Accesorios'], horario: null,
      ...perfil,
    },
    [`businesses/${LIC}/tiendaOnline/catalogo`]: { paginas: 1, total: lista.length, version: 'v1' },
    [`businesses/${LIC}/tiendaOnline/catalogo_p0`]: { productos: lista },
    [`businesses/${LIC}/tiendaOnline/stock`]: { items: stock, contador: 1001 },
  };
}

const MIXTA = [
  articulo(1, 'Cable HDMI', 'Accesorios', 300, 'producto'),
  articulo(2, 'Mouse inalámbrico', 'Accesorios', 750, 'producto'),
  articulo(3, 'Limpieza de oficina', 'Limpieza', 2500, 'servicio'),
  articulo(4, 'Fumigación', 'Limpieza', 4000, 'servicio'),
];

async function abrir(browser, server, slug, viewport = { width: 1280, height: 860 }) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errores = [];
  page.on('pageerror', (e) => errores.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/t/${slug}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.card', { timeout: 10000 });
  return { page, errores };
}

(async () => {
  const slugMixta = 'mixta';
  const slugOculta = 'oculta';
  const db = createFakeFirestore(sembrar(slugMixta, { modalidad: 'mixta', serviciosTienda: { contratar: false, cotizacion: true, cita: true, whatsapp: true, mostrarPrecio: true } }, MIXTA));
  const dbOculta = createFakeFirestore(sembrar(slugOculta, { modalidad: 'servicios', serviciosTienda: { contratar: false, cotizacion: true, cita: false, whatsapp: false, mostrarPrecio: false } }, MIXTA));
  const servidor = (d) => new Promise((resolve) => {
    const s = createApp({ db: d, FieldValue: d.FieldValue, limits: { pedidos: 1000, cotizar: 1000, lectura: 1000 } }).listen(0, '127.0.0.1', () => resolve(s));
  });
  const s1 = await servidor(db);
  const s2 = await servidor(dbOculta);
  const browser = await puppeteer.launch({ headless: true });
  try {
    // Tienda mixta, servicios sin pago por carrito
    const { page, errores } = await abrir(browser, s1, slugMixta);
    if (CAPTURAS) {
      fs.mkdirSync(CAPTURAS, { recursive: true });
      await page.screenshot({ path: path.join(CAPTURAS, 'servicios-mixta.png'), fullPage: false });
    }
    const textoInicio = await page.evaluate(() => document.body.innerText);
    ok('los servicios llevan su etiqueta', /Servicio/i.test(textoInicio));
    ok('el menú ofrece Servicios', await page.evaluate(() => [...document.querySelectorAll('[data-ir="servicios"]')].length > 0));
    ok('hay carrito porque hay productos', await page.evaluate(() => !document.documentElement.classList.contains('sin-carrito')));
    ok('un servicio dice Solicitar, no Agregar', await page.$$eval('[data-rapida]', (l) => l.some((b) => b.textContent.trim() === 'Solicitar')));

    // Filtro por tipo
    await page.evaluate(() => document.querySelector('[data-ir="servicios"]').click());
    await sleep(500);
    const tituloServicios = await page.evaluate(() => document.querySelector('#cat-titulo')?.textContent || '');
    ok('Servicios abre la lista de servicios', /servicios/i.test(tituloServicios), tituloServicios);
    let visibles = await page.evaluate(() => [...document.querySelectorAll('#productos .card')].filter((c) => c.offsetParent).length);
    ok('cuenta servicios, no productos', /2 servicios/.test(await page.$eval('#cat-n', (e) => e.textContent)));
    ok('solo muestra los dos servicios', visibles === 2, String(visibles));
    ok('el filtro de Tipo sale en la tienda mixta', await page.$$eval('[data-tipo-filtro]', (l) => l.length === 3));
    await page.evaluate(() => document.querySelector('[data-tipo-filtro="productos"]').click());
    await sleep(300);
    visibles = await page.evaluate(() => [...document.querySelectorAll('#productos .card')].filter((c) => c.offsetParent).length);
    ok('Productos muestra los dos productos', visibles === 2, String(visibles));
    await page.evaluate(() => document.querySelector('[data-tipo-filtro="servicios"]').click());
    await sleep(300);

    // Detalle y solicitud
    await page.evaluate(() => [...document.querySelectorAll('[data-rapida]')].find((b) => b.textContent.trim() === 'Solicitar').click());
    await page.waitForSelector('[data-solicitud="cotizacion"]', { timeout: 5000 });
    const acciones = await page.evaluate(() => ({
      cotizacion: Boolean(document.querySelector('.det-acciones [data-solicitud="cotizacion"]')),
      cita: Boolean(document.querySelector('.det-acciones [data-solicitud="cita"]')),
      wa: [...document.querySelectorAll('.det-acciones a')].some((a) => a.href.includes('wa.me')),
      agregar: Boolean(document.querySelector('.det-acciones [data-car]')),
    }));
    ok('el detalle ofrece cotización, cita y WhatsApp', acciones.cotizacion && acciones.cita && acciones.wa, JSON.stringify(acciones));
    ok('el detalle no ofrece agregar al carrito', !acciones.agregar);
    if (CAPTURAS) await page.screenshot({ path: path.join(CAPTURAS, 'servicios-detalle.png') });

    await page.evaluate(() => document.querySelector('.det-acciones [data-solicitud="cotizacion"]').click());
    await page.waitForSelector('#form-solicitud', { timeout: 5000 });
    await page.evaluate(() => document.querySelector('[data-act="enviar-solicitud"]').click());
    await page.waitForSelector('#form-err .alert', { timeout: 5000 });
    ok('sin datos avisa y no envía', /nombre/i.test(await page.$eval('#form-err', (e) => e.textContent)));
    await page.type('#form-solicitud [name="nombre"]', 'Ana Pérez');
    await page.type('#form-solicitud [name="telefono"]', '8095550101');
    await page.type('#form-solicitud [name="mensaje"]', 'Son tres oficinas');
    if (CAPTURAS) await page.screenshot({ path: path.join(CAPTURAS, 'servicios-solicitud.png') });
    await page.evaluate(() => document.querySelector('[data-act="enviar-solicitud"]').click());
    await page.waitForFunction(() => /Recibimos tu solicitud/.test(document.body.innerText), { timeout: 5000 });
    ok('confirma al cliente', true);

    const rutaSol = `businesses/${LIC}/solicitudesOnline`;
    const guardadas = await db.collection(rutaSol).get();
    ok('llega una sola a la nube, sin marcar', guardadas.docs.length === 1 && guardadas.docs[0].data().importada === false, String(guardadas.docs.length));
    const sol = guardadas.docs[0].data();
    ok('lleva el servicio, el cliente y el mensaje', sol.articulo && sol.tipo === 'cotizacion' && sol.cliente.nombre === 'Ana Pérez' && sol.mensaje === 'Son tres oficinas', JSON.stringify(sol));

    // Cita: lleva fecha
    await page.evaluate(() => document.querySelector('[data-act="cerrar"]').click());
    await sleep(300);
    await page.evaluate(() => [...document.querySelectorAll('[data-rapida]')].find((b) => b.textContent.trim() === 'Solicitar').click());
    await page.waitForSelector('.det-acciones [data-solicitud="cita"]', { timeout: 5000 });
    await page.evaluate(() => document.querySelector('.det-acciones [data-solicitud="cita"]').click());
    await page.waitForSelector('#form-solicitud [name="fecha"]', { timeout: 5000 });
    ok('los datos del cliente se recuerdan', (await page.$eval('#form-solicitud [name="nombre"]', (e) => e.value)) === 'Ana Pérez');
    await page.evaluate(() => document.querySelector('[data-act="enviar-solicitud"]').click());
    await page.waitForSelector('#form-err .alert', { timeout: 5000 });
    ok('la cita exige fecha', /fecha/i.test(await page.$eval('#form-err', (e) => e.textContent)));
    await page.$eval('#form-solicitud [name="fecha"]', (e) => { e.value = '2030-01-15'; });
    await page.$eval('#form-solicitud [name="hora"]', (e) => { e.value = '10:30'; });
    await page.evaluate(() => document.querySelector('[data-act="enviar-solicitud"]').click());
    await page.waitForFunction(() => /Recibimos tu solicitud/.test(document.body.innerText), { timeout: 5000 });
    const dos = (await db.collection(rutaSol).get()).docs.map((d) => d.data());
    ok('la cita guarda fecha y hora', dos.some((d) => d.tipo === 'cita' && d.fecha === '2030-01-15' && d.hora === '10:30'));
    ok('sin errores en la pantalla (mixta)', errores.length === 0, errores.join(' | '));

    // Solo servicios, sin precio ni WhatsApp
    const { page: p2, errores: e2 } = await abrir(browser, s2, slugOculta);
    const h = await p2.evaluate(() => ({
      sinCarrito: document.documentElement.classList.contains('sin-carrito'),
      carritoVisible: Boolean(document.querySelector('#cart-btn')?.offsetParent),
      texto: document.body.innerText,
      placeholder: document.querySelector('#buscar')?.placeholder,
      tipo: document.querySelectorAll('[data-tipo-filtro]').length,
    }));
    ok('sin compras no hay carrito', h.sinCarrito && !h.carritoVisible);
    ok('el precio oculto dice Consultar precio', /Consultar precio/.test(h.texto) && !/4,000|2,500/.test(h.texto));
    ok('los productos no aparecen', !/Cable HDMI|Mouse/.test(h.texto));
    ok('el buscador habla de servicios', /servicios/i.test(h.placeholder), h.placeholder);
    ok('sin mezcla no hay filtro de tipo', h.tipo === 0);
    ok('la portada invita a ver servicios', /Ver servicios/.test(h.texto) && !/Ver productos|Compra por/.test(h.texto));
    if (CAPTURAS) await p2.screenshot({ path: path.join(CAPTURAS, 'servicios-solo.png') });

    await p2.evaluate(() => [...document.querySelectorAll('[data-rapida]')].find((b) => b.textContent.trim() === 'Solicitar').click());
    await p2.waitForSelector('.det-acciones', { timeout: 5000 });
    const det = await p2.evaluate(() => ({
      cita: Boolean(document.querySelector('.det-acciones [data-solicitud="cita"]')),
      cotizacion: Boolean(document.querySelector('.det-acciones [data-solicitud="cotizacion"]')),
      wa: document.querySelectorAll('.det-acciones a').length,
    }));
    ok('solo los botones activados', det.cotizacion && !det.cita && det.wa === 0, JSON.stringify(det));
    ok('sin errores en la pantalla (servicios)', e2.length === 0, e2.join(' | '));

    // Móvil
    const { page: p3, errores: e3 } = await abrir(browser, s2, slugOculta, { width: 390, height: 780, isMobile: true, hasTouch: true });
    const movil = await p3.evaluate(() => ({
      ancho: document.documentElement.scrollWidth <= window.innerWidth + 1,
      carrito: getComputedStyle(document.querySelector('.tb-cart') || document.body).display,
    }));
    ok('en el teléfono no se sale de la pantalla', movil.ancho);
    ok('en el teléfono la barra no trae carrito', movil.carrito === 'none', movil.carrito);
    ok('sin errores en la pantalla (móvil)', e3.length === 0, e3.join(' | '));
    if (CAPTURAS) await p3.screenshot({ path: path.join(CAPTURAS, 'servicios-movil.png') });
  } finally {
    await browser.close();
    s1.close();
    s2.close();
  }
  const fallas = resultados.filter((r) => !r.ok);
  console.log(`\n${resultados.length - fallas.length}/${resultados.length} pasaron`);
  process.exit(fallas.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
