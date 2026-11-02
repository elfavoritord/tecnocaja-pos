'use strict';

// La tienda en un navegador real, sobre un Firestore en memoria. La de un negocio con POS
// sigue como siempre; solo la de una Empresa de Servicios lleva servicios y solicitudes.
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

const LISTA = [
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

const solicitar = (page) => page.evaluate(() => [...document.querySelectorAll('[data-rapida]')].find((b) => b.textContent.trim() === 'Solicitar').click());

(async () => {
  // Negocio con POS que tiene un artículo tipo Servicio; y datos que pudo guardar la 1.6.11.
  const dbPos = createFakeFirestore(sembrar('colmado', { modalidad: 'mixta', serviciosTienda: { contratar: true, cotizacion: true, cita: true, whatsapp: true, mostrarPrecio: true } }, LISTA));
  const dbServicios = createFakeFirestore(sembrar('limpieza', { modalidad: 'servicios', serviciosTienda: { cotizacion: true, cita: true, whatsapp: true, mostrarPrecio: true } }, LISTA));
  const dbOculta = createFakeFirestore(sembrar('oculta', { modalidad: 'servicios', serviciosTienda: { cotizacion: true, cita: false, whatsapp: false, mostrarPrecio: false } }, LISTA));
  const servidor = (d) => new Promise((resolve) => {
    const s = createApp({ db: d, FieldValue: d.FieldValue, limits: { pedidos: 1000, cotizar: 1000, lectura: 1000 } }).listen(0, '127.0.0.1', () => resolve(s));
  });
  const s0 = await servidor(dbPos);
  const s1 = await servidor(dbServicios);
  const s2 = await servidor(dbOculta);
  const browser = await puppeteer.launch({ headless: true });
  try {
    // ── Negocio con POS ──────────────────────────────────────────────────────
    const { page: p0, errores: e0 } = await abrir(browser, s0, 'colmado');
    const pos = await p0.evaluate(() => ({
      texto: document.body.innerText,
      sinCarrito: document.documentElement.classList.contains('sin-carrito'),
      solicitudes: document.querySelectorAll('[data-solicitud]').length,
      solicitar: [...document.querySelectorAll('[data-rapida]')].filter((b) => b.textContent.trim() === 'Solicitar').length,
      etiquetas: document.querySelectorAll('.tag.serv').length,
      menuServicios: document.querySelectorAll('[data-ir="servicios"]').length,
      placeholder: document.querySelector('#buscar')?.placeholder,
    }));
    ok('POS: tiene carrito', !pos.sinCarrito);
    ok('POS: sin botones de solicitud ni "Solicitar"', pos.solicitudes === 0 && pos.solicitar === 0, JSON.stringify(pos.solicitudes));
    ok('POS: sin etiqueta de Servicio ni entrada en el menú', pos.etiquetas === 0 && pos.menuServicios === 0);
    ok('POS: muestra todo lo publicado', /Cable HDMI/.test(pos.texto) && /Limpieza de oficina/.test(pos.texto));
    ok('POS: textos de siempre', /Todos los productos/.test(pos.texto) && /Ver productos/.test(pos.texto) && !/Nuestros servicios/.test(pos.texto) && pos.placeholder === 'Buscar…', pos.placeholder);
    ok('POS: sin filtro de tipo', await p0.$$eval('[data-tipo-filtro]', (l) => l.length === 0));
    if (CAPTURAS) {
      fs.mkdirSync(CAPTURAS, { recursive: true });
      await p0.screenshot({ path: path.join(CAPTURAS, 'tienda-pos.png') });
    }
    const carrito = await p0.evaluate(() => {
      const b = document.querySelector('[data-add], .add');
      b?.click();
      return Boolean(b);
    });
    await sleep(300);
    ok('POS: agregar al carrito funciona', carrito);
    ok('POS: sin errores en la pantalla', e0.length === 0, e0.join(' | '));

    // ── Empresa de Servicios ─────────────────────────────────────────────────
    const { page, errores } = await abrir(browser, s1, 'limpieza');
    if (CAPTURAS) await page.screenshot({ path: path.join(CAPTURAS, 'servicios-tienda.png') });
    const inicio = await page.evaluate(() => ({
      texto: document.body.innerText,
      sinCarrito: document.documentElement.classList.contains('sin-carrito'),
      solicitar: [...document.querySelectorAll('[data-rapida]')].filter((b) => b.textContent.trim() === 'Solicitar').length,
    }));
    ok('Servicios: sin carrito y con Solicitar', inicio.sinCarrito && inicio.solicitar >= 2);
    ok('Servicios: solo sus servicios, con etiqueta', /Limpieza de oficina/.test(inicio.texto) && !/Cable HDMI/.test(inicio.texto) && /Servicio/.test(inicio.texto));
    ok('Servicios: textos de servicios', /Nuestros servicios/.test(inicio.texto) && /Ver servicios/.test(inicio.texto) && !/Ver productos|Compra por/.test(inicio.texto));

    await page.evaluate(() => document.querySelector('[data-ir="catalogo"]').click());
    await sleep(400);
    ok('Servicios: cuenta servicios', /2 servicios/.test(await page.$eval('#cat-n', (e) => e.textContent)));

    await solicitar(page);
    await page.waitForSelector('[data-solicitud="cotizacion"]', { timeout: 5000 });
    const acciones = await page.evaluate(() => ({
      cotizacion: Boolean(document.querySelector('.det-acciones [data-solicitud="cotizacion"]')),
      cita: Boolean(document.querySelector('.det-acciones [data-solicitud="cita"]')),
      wa: [...document.querySelectorAll('.det-acciones a')].some((a) => a.href.includes('wa.me')),
      agregar: Boolean(document.querySelector('.det-acciones [data-car]')),
    }));
    ok('Servicios: el detalle ofrece cotización, cita y WhatsApp', acciones.cotizacion && acciones.cita && acciones.wa, JSON.stringify(acciones));
    ok('Servicios: el detalle no ofrece carrito', !acciones.agregar);

    await page.evaluate(() => document.querySelector('.det-acciones [data-solicitud="cotizacion"]').click());
    await page.waitForSelector('#form-solicitud', { timeout: 5000 });
    await page.evaluate(() => document.querySelector('[data-act="enviar-solicitud"]').click());
    await page.waitForSelector('#form-err .alert', { timeout: 5000 });
    ok('Servicios: sin datos avisa y no envía', /nombre/i.test(await page.$eval('#form-err', (e) => e.textContent)));
    await page.type('#form-solicitud [name="nombre"]', 'Ana Pérez');
    await page.type('#form-solicitud [name="telefono"]', '8095550101');
    await page.type('#form-solicitud [name="mensaje"]', 'Son tres oficinas');
    await page.evaluate(() => document.querySelector('[data-act="enviar-solicitud"]').click());
    await page.waitForFunction(() => /Recibimos tu solicitud/.test(document.body.innerText), { timeout: 5000 });
    ok('Servicios: confirma al cliente', true);

    const rutaSol = `businesses/${LIC}/solicitudesOnline`;
    const guardadas = await dbServicios.collection(rutaSol).get();
    ok('Servicios: llega una sola a la nube, sin marcar', guardadas.docs.length === 1 && guardadas.docs[0].data().importada === false, String(guardadas.docs.length));
    const sol = guardadas.docs[0].data();
    ok('Servicios: lleva el servicio, el cliente y el mensaje', sol.articulo && sol.tipo === 'cotizacion' && sol.cliente.nombre === 'Ana Pérez' && sol.mensaje === 'Son tres oficinas', JSON.stringify(sol));

    await page.evaluate(() => document.querySelector('[data-act="cerrar"]').click());
    await sleep(300);
    await solicitar(page);
    await page.waitForSelector('.det-acciones [data-solicitud="cita"]', { timeout: 5000 });
    await page.evaluate(() => document.querySelector('.det-acciones [data-solicitud="cita"]').click());
    await page.waitForSelector('#form-solicitud [name="fecha"]', { timeout: 5000 });
    ok('Servicios: los datos del cliente se recuerdan', (await page.$eval('#form-solicitud [name="nombre"]', (e) => e.value)) === 'Ana Pérez');
    await page.evaluate(() => document.querySelector('[data-act="enviar-solicitud"]').click());
    await page.waitForSelector('#form-err .alert', { timeout: 5000 });
    ok('Servicios: la cita exige fecha', /fecha/i.test(await page.$eval('#form-err', (e) => e.textContent)));
    await page.$eval('#form-solicitud [name="fecha"]', (e) => { e.value = '2030-01-15'; });
    await page.$eval('#form-solicitud [name="hora"]', (e) => { e.value = '10:30'; });
    await page.evaluate(() => document.querySelector('[data-act="enviar-solicitud"]').click());
    await page.waitForFunction(() => /Recibimos tu solicitud/.test(document.body.innerText), { timeout: 5000 });
    const dos = (await dbServicios.collection(rutaSol).get()).docs.map((d) => d.data());
    ok('Servicios: la cita guarda fecha y hora', dos.some((d) => d.tipo === 'cita' && d.fecha === '2030-01-15' && d.hora === '10:30'));
    ok('Servicios: sin errores en la pantalla', errores.length === 0, errores.join(' | '));

    // Sin precio ni WhatsApp
    const { page: p2, errores: e2 } = await abrir(browser, s2, 'oculta');
    const h = await p2.evaluate(() => ({ texto: document.body.innerText, placeholder: document.querySelector('#buscar')?.placeholder }));
    ok('Precio oculto: dice Consultar precio', /Consultar precio/.test(h.texto) && !/4,000|2,500/.test(h.texto));
    ok('Precio oculto: el buscador habla de servicios', /servicios/i.test(h.placeholder), h.placeholder);
    await solicitar(p2);
    await p2.waitForSelector('.det-acciones', { timeout: 5000 });
    const det = await p2.evaluate(() => ({
      cita: Boolean(document.querySelector('.det-acciones [data-solicitud="cita"]')),
      cotizacion: Boolean(document.querySelector('.det-acciones [data-solicitud="cotizacion"]')),
      wa: document.querySelectorAll('.det-acciones a').length,
    }));
    ok('Precio oculto: solo los botones activados', det.cotizacion && !det.cita && det.wa === 0, JSON.stringify(det));
    ok('Precio oculto: sin errores en la pantalla', e2.length === 0, e2.join(' | '));

    // Móvil
    const { page: p3, errores: e3 } = await abrir(browser, s2, 'oculta', { width: 390, height: 780, isMobile: true, hasTouch: true });
    const movil = await p3.evaluate(() => ({
      ancho: document.documentElement.scrollWidth <= window.innerWidth + 1,
      carrito: getComputedStyle(document.querySelector('.tb-cart') || document.body).display,
    }));
    ok('Teléfono: no se sale de la pantalla', movil.ancho);
    ok('Teléfono: la barra no trae carrito', movil.carrito === 'none', movil.carrito);
    ok('Teléfono: sin errores en la pantalla', e3.length === 0, e3.join(' | '));
    if (CAPTURAS) await p3.screenshot({ path: path.join(CAPTURAS, 'servicios-movil.png') });
  } finally {
    await browser.close();
    s0.close();
    s1.close();
    s2.close();
  }
  const fallas = resultados.filter((r) => !r.ok);
  console.log(`\n${resultados.length - fallas.length}/${resultados.length} pasaron`);
  process.exit(fallas.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
