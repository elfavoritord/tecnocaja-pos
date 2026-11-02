'use strict';

// Prueba de la tienda en un navegador real: el servicio de verdad (con su CSP)
// sobre un Firestore en memoria, con fotos generadas. Nada sale a Internet.
//
//   node cloud/tienda-online/test/ui/probar-tienda-ui.js [carpeta-de-capturas]
//
// Con `--demo` deja el servidor abierto para mirarla a mano.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const { createApp } = require('../../lib/app');
const { createFakeFirestore } = require('../../../../tests/helpers/fake-firestore');

const args = process.argv.slice(2);
const DEMO = args.includes('--demo');
const CAPTURAS = args.find((a) => !a.startsWith('--')) || '';
const LIC = 'pos_1111222233334444';
const resultados = [];
function ok(nombre, cond, detalle = '') {
  resultados.push({ nombre, ok: Boolean(cond) });
  console.log(`${cond ? '  ok ' : 'FALLA'} ${nombre}${!cond && detalle ? ` → ${detalle}` : ''}`);
}

const CATALOGO = [
  ['Bebidas', ['Agua Planeta 1L', 'Refresco Rojo 2L', 'Jugo de Naranja', 'Malta Morena', 'Café Santo Domingo', 'Té Verde']],
  ['Despensa', ['Arroz Selecto 10 lb', 'Habichuelas Rojas', 'Aceite de Soya', 'Pasta Larga', 'Harina de Trigo', 'Sazón Completo']],
  ['Lácteos', ['Leche Entera', 'Queso de Freír', 'Yogur Natural', 'Mantequilla']],
  ['Limpieza', ['Detergente Líquido', 'Cloro 1 Galón', 'Jabón de Cuaba', 'Desinfectante Lavanda']],
  ['Farmacia', ['Vitamina C', 'Acetaminofén', 'Alcohol 70%', 'Curitas']],
];
const MARCAS = ['La Famosa', 'Rica', 'Induveca', 'Bon'];

async function foto(ancho, alto, color, texto) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ancho}" height="${alto}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <rect x="${ancho * 0.18}" y="${alto * 0.12}" width="${ancho * 0.64}" height="${alto * 0.76}" rx="18" fill="${color}"/>
    <text x="50%" y="52%" font-family="Arial" font-size="${Math.min(ancho, alto) * 0.09}" font-weight="700" text-anchor="middle" fill="#ffffff">${texto}</text>
  </svg>`;
  return (await sharp(Buffer.from(svg)).webp({ quality: 80 }).toBuffer()).toString('base64');
}

async function portada(ancho, alto) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ancho}" height="${alto}">
    <defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#14532d"/><stop offset="1" stop-color="#84cc16"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    ${Array.from({ length: 14 }, (_, i) => `<circle cx="${(i * 137) % ancho}" cy="${(i * 89) % alto}" r="${40 + (i % 5) * 26}" fill="#ffffff" fill-opacity=".08"/>`).join('')}
  </svg>`;
  return (await sharp(Buffer.from(svg)).webp({ quality: 80 }).toBuffer()).toString('base64');
}

async function sembrar({ diseno, perfilExtra = {}, ajustar = null } = {}) {
  const docs = {};
  const colores = ['#2563eb', '#dc2626', '#ca8a04', '#7c3aed', '#0891b2', '#db2777'];
  const productos = [];
  const stock = {};
  let id = 100;
  for (const [cat, nombres] of CATALOGO) {
    for (const nombre of nombres) {
      id += 1;
      const n = id - 100;
      const p = {
        id, nombre, categoria: cat, precio: 45 + n * 17.5, modoVenta: 'unidad', unidad: 'und',
        descripcion: n % 2 ? `${nombre} de primera calidad, directo de nuestra tienda. Se entrega bien empacado y listo para usar en tu casa o negocio.` : '',
        controlaStock: true, itbis: n % 3 === 0, destacado: n % 5 === 0, orden: n, descuentoPct: n % 4 === 0 ? 15 : 0,
        marca: MARCAS[n % MARCAS.length],
        // Los últimos se registraron hace poco, y el más nuevo es el de mayor n.
        creadoEn: n > 12 ? new Date(Date.now() - (24 - n + 1) * 3600000).toISOString() : null,
      };
      // Fotos de formas distintas (una alta, una ancha): no se pueden deformar.
      if (n % 7 !== 0) {
        const [w, h] = n % 3 === 0 ? [300, 480] : n % 3 === 1 ? [480, 300] : [480, 480];
        p.imagen = `p${id}`;
        p.imagenVersion = 'v1';
        docs[`businesses/${LIC}/tiendaImagenes/p${id}`] = { mime: 'image/webp', version: 'v1', data: await foto(w, h, colores[n % colores.length], nombre.split(' ')[0]) };
        if (n % 6 === 1) {
          p.fotosExtra = [{ clave: `p${id}_1`, version: 'v1' }];
          docs[`businesses/${LIC}/tiendaImagenes/p${id}_1`] = { mime: 'image/webp', version: 'v1', data: await foto(480, 480, '#0f766e', 'Foto 2') };
        }
      }
      if (ajustar) ajustar(p, n);
      productos.push(p);
      stock[`p${id}`] = { s: n % 11 === 0 ? 0 : n % 9 === 0 ? 3 : 40 };
    }
  }
  docs[`businesses/${LIC}/tiendaImagenes/_banner`] = { mime: 'image/webp', version: 'b1', data: await portada(1400, 520) };
  docs[`businesses/${LIC}/tiendaImagenes/_logo`] = { mime: 'image/webp', version: 'l1', data: await foto(256, 256, '#15803d', 'C') };
  docs['tienda_slugs/colmado-prueba'] = { licenseId: LIC };
  docs[`businesses/${LIC}/tiendaOnline/perfil`] = {
    licenseId: LIC, slug: 'colmado-prueba', activa: true, nombre: 'Colmado La Bendición', moneda: 'RD$',
    descripcion: 'Tu colmado de siempre, ahora en línea. Pide desde tu casa y te lo llevamos.',
    telefono: '809-555-1234', whatsapp: '8095551234', direccion: 'Calle Duarte 25, Santo Domingo', email: 'ventas@colmado.do',
    colorPrimario: '#047857', logo: '_logo', logoVersion: 'l1', banner: '_banner', bannerVersion: 'b1',
    pagos: [{ codigo: 'efectivo', etiqueta: 'Efectivo' }, { codigo: 'transferencia', etiqueta: 'Transferencia' }],
    retiro: { habilitado: true },
    delivery: { habilitado: true, zonas: [{ id: 'z1', nombre: 'Centro', costo: 100 }, { id: 'z2', nombre: 'Naco', costo: 150 }] },
    categorias: CATALOGO.map(([c]) => c),
    horario: null, comprobanteFiscal: true, pedidoMinimo: 0, masVendidos: [103, 107, 110, 112, 115, 116, 118],
    ...(diseno ? { diseno } : {}),
    ...perfilExtra,
  };
  docs[`businesses/${LIC}/tiendaOnline/catalogo`] = { paginas: 1, total: productos.length, version: 'v1' };
  docs[`businesses/${LIC}/tiendaOnline/catalogo_p0`] = { productos };
  docs[`businesses/${LIC}/tiendaOnline/stock`] = { items: stock, contador: 1001 };
  return createFakeFirestore(docs);
}

async function levantar(opciones, puerto = 0) {
  const db = await sembrar(opciones);
  const app = createApp({ db, FieldValue: db.FieldValue, limits: { pedidos: 500, cotizar: 5000, lectura: 5000 } });
  return new Promise((resolve) => {
    const server = app.listen(puerto, '127.0.0.1', () => resolve({ server, db, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

const PORTADA = { titulo: 'Todo para tu casa, sin salir de ella', subtitulo: 'Haz tu pedido en línea y te lo llevamos el mismo día.' };
const espera = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Cierra el servidor sin esperar las conexiones que el navegador deja abiertas. */
function cerrar(server) {
  return new Promise((r) => {
    server.close(r);
    server.closeAllConnections();
  });
}

async function abrir(browser, base, { ancho = 1366, alto = 900, tacto = false, oscuro = false, sinMovimiento = true } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: ancho, height: alto, isMobile: tacto, hasTouch: tacto, deviceScaleFactor: 1 });
  if (sinMovimiento) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  page.errores = [];
  page.on('pageerror', (e) => page.errores.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404|manifest/.test(m.text())) page.errores.push(`consola: ${m.text()}`); });
  if (oscuro) await page.evaluateOnNewDocument(() => localStorage.setItem('tc-tema', 'dark'));
  await page.goto(`${base}/t/colmado-prueba`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#sec-catalogo, .cat-vista');
  return page;
}

async function captura(page, nombre, { completa = false } = {}) {
  if (!CAPTURAS) return;
  fs.mkdirSync(CAPTURAS, { recursive: true });
  if (completa) {
    // Las fotos cargan al acercarse: se recorre la página antes de la captura.
    const alto = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < alto; y += 500) {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      await espera(70);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForNetworkIdle({ idleTime: 150, timeout: 5000 }).catch(() => {});
  }
  await page.screenshot({ path: path.join(CAPTURAS, `${nombre}.png`), fullPage: completa });
}

const clic = (page, sel) => page.$eval(sel, (el) => el.click());
const texto = (page, sel) => page.$eval(sel, (el) => el.textContent.trim());
const cuantos = (page, sel) => page.$$eval(sel, (l) => l.length);
const ordenSecciones = (page) => page.$$eval('#app > section', (l) => l.map((s) => s.id.replace('sec-', '')));
const sinDesborde = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

async function probarTiendaSinDiseno(browser) {
  console.log('\nTienda de hoy (sin personalizar, POS viejo)');
  const { server, base } = await levantar();
  const page = await abrir(browser, base);
  ok('se ve con su color de siempre', (await page.evaluate(() => document.documentElement.style.getPropertyValue('--c'))) === '#047857');
  ok('estilo Moderno por defecto', (await page.evaluate(() => document.documentElement.dataset.boton)) === 'pastilla');
  const orden = await ordenSecciones(page);
  ok('salen las secciones', ['hero', 'categorias', 'destacados', 'ofertas', 'nuevos', 'masVendidos', 'marcas', 'catalogo', 'informacion', 'contacto'].every((s) => orden.includes(s)), orden.join());
  ok('banners sin imagen no se pintan', !orden.includes('banners'));
  ok('el nombre es de la tienda', (await texto(page, '#brand h1')) === 'Colmado La Bendición');
  ok('banner de antes: se ve solo, sin letras encima', (await cuantos(page, '.solo-foto')) === 1 && (await cuantos(page, '.hero h2')) === 0);
  const banner = await page.$eval('.solo-foto-img img', (i) => ({ ajuste: getComputedStyle(i).objectFit, alto: i.getBoundingClientRect().height, ancho: i.getBoundingClientRect().width }));
  ok('banner de antes: completo, sin recortar', banner.ajuste === 'contain');
  ok('banner de antes: alto medido, no llena la pantalla', banner.alto <= 340, String(banner.alto));
  ok('banner de antes: dentro del ancho de la página', banner.ancho <= 1240, String(banner.ancho));
  await captura(page, 'sin-personalizar-pc', { completa: true });
  ok('sin errores en la página', page.errores.length === 0, page.errores.join(' | '));
  await page.close();

  const tel = await abrir(browser, base, { ancho: 390, alto: 844, tacto: true });
  await captura(tel, 'sin-personalizar-telefono', { completa: true });
  ok('teléfono: barra de abajo a la vista', await tel.$eval('#tabbar', (e) => getComputedStyle(e).display !== 'none'));
  ok('teléfono: sin scroll de lado', await sinDesborde(tel));
  ok('teléfono: banner de 240 px como mucho', (await tel.$eval('.solo-foto-caja', (c) => c.getBoundingClientRect().height)) <= 240);
  await tel.close();

  await cerrar(server);
}

async function probarEstilos(browser) {
  console.log('\nLos tres estilos y el orden de las secciones');
  const { aplicarEstilo, normalizarDiseno } = require('../../vendor/tienda-online/diseno');
  const BOTON = { moderno: 'pastilla', comercial: 'redondeado', premium: 'recto' };
  for (const estilo of Object.keys(BOTON)) {
    const { server, base } = await levantar({ diseno: aplicarEstilo(estilo, { hero: PORTADA }) });
    const page = await abrir(browser, base);
    ok(`${estilo}: se aplica`, (await page.evaluate(() => document.documentElement.dataset.boton)) === BOTON[estilo]);
    await captura(page, `${estilo}-pc`, { completa: true });
    const tel = await abrir(browser, base, { ancho: 390, alto: 844, tacto: true });
    await captura(tel, `${estilo}-telefono-arriba`);
    await captura(tel, `${estilo}-telefono`, { completa: true });
    ok(`${estilo}: sin scroll de lado en teléfono`, await sinDesborde(tel));
    await tel.close();
    await page.close();
    await cerrar(server);
  }

  // Colores y orden propios: el negocio apaga "Marcas" y sube el catálogo.
  const propio = normalizarDiseno({
    estilo: 'moderno',
    colores: { principal: '#7c3aed', fondo: '#fdf4ff', texto: '#3b0764', botones: '#be123c', encabezado: '#581c87', pie: '#3b0764', tarjetas: '#ffffff', destacados: '#ea580c', secundario: '#0369a1' },
    apariencia: { temaOscuro: false, tamanoTexto: 'grande', esquinas: 'rectas', sombras: 'marcadas', estiloBotones: 'contorno', estiloTarjetas: 'borde', espaciado: 'amplio', tipografia: 'nunito', tipografiaTitulos: 'montserrat' },
    encabezado: { mostrarBuscador: false, tamanoLogo: 'grande' },
    hero: { titulo: 'Todo para tu casa', subtitulo: 'Delivery el mismo día', textoBoton: 'Ver ofertas', enlaceBoton: 'ofertas', textoBoton2: 'Escríbenos', enlaceBoton2: 'whatsapp', alineacion: 'derecha', altura: 'alta' },
    redes: { instagram: 'https://instagram.com/colmado', facebook: 'javascript:alert(1)' },
    secciones: [{ id: 'catalogo' }, { id: 'hero' }, { id: 'marcas', activa: false }, { id: 'ofertas', titulo: 'Solo esta semana' }],
  });
  const { server, base } = await levantar({ diseno: propio });
  const page = await abrir(browser, base);
  const orden = await ordenSecciones(page);
  ok('el orden elegido manda', orden[0] === 'catalogo' && orden.indexOf('hero') > 0, orden.join());
  ok('sección apagada no sale', !orden.includes('marcas'));
  ok('título propio de una sección', (await texto(page, '#tit-ofertas')) === 'Solo esta semana');
  const css = await page.evaluate(() => {
    const r = getComputedStyle(document.documentElement);
    return { fondo: getComputedStyle(document.body).backgroundColor, pie: getComputedStyle(document.querySelector('.foot')).backgroundColor, head: getComputedStyle(document.querySelector('#top')).backgroundColor, btn: r.getPropertyValue('--btn').trim(), letra: getComputedStyle(document.body).fontFamily };
  });
  ok('color de fondo', css.fondo === 'rgb(253, 244, 255)', css.fondo);
  ok('color del pie', css.pie === 'rgb(59, 7, 100)', css.pie);
  ok('color del encabezado', css.head === 'rgb(88, 28, 135)', css.head);
  ok('color de botones', css.btn === '#be123c', css.btn);
  ok('tipografía', /Nunito/.test(css.letra), css.letra);
  ok('la letra elegida carga sin que la CSP la frene', await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('16px Nunito'); }));
  ok('buscador apagado', await page.$eval('#search-box', (e) => getComputedStyle(e).display === 'none'));
  ok('tema oscuro apagado: sin botón', await page.$eval('#tema-btn', (e) => getComputedStyle(e).display === 'none'));
  ok('red con enlace peligroso se descarta', (await page.$$eval('.cto', (l) => l.map((a) => a.getAttribute('href')))).every((h) => !/^javascript/i.test(h)));
  ok('título del banner', (await texto(page, '.hero h2')) === 'Todo para tu casa');
  await captura(page, 'colores-propios-pc', { completa: true });
  await clic(page, '.hero-b1');
  await espera(100);
  ok('botón de la portada lleva a ofertas', (await texto(page, '#cat-titulo')) === 'Ofertas y promociones');
  await page.close();

  // Sin encabezado: el carrito sigue a mano.
  const secciones = propio.secciones.map((s) => (s.id === 'encabezado' ? { ...s, activa: false } : s));
  const sinCab = await levantar({ diseno: { ...propio, secciones } });
  const p2 = await abrir(browser, sinCab.base);
  ok('encabezado apagado', await p2.$eval('#top', (e) => getComputedStyle(e).display === 'none'));
  ok('carrito flotante cuando no hay encabezado', await p2.$eval('#cart-flota', (e) => getComputedStyle(e).display !== 'none'));
  await p2.close();
  await cerrar(sinCab.server);
  await cerrar(server);
}

async function probarCatalogoYCarrito(browser) {
  console.log('\nCatálogo, detalle y carrito (computadora)');
  const { server, base, db } = await levantar();
  const page = await abrir(browser, base);

  // Fotos sin deformar
  const deformadas = await page.$$eval('.card .img img', (l) => l.filter((i) => i.complete && i.naturalWidth).filter((i) => {
    const r = i.getBoundingClientRect();
    return Math.abs(r.width / r.height - i.naturalWidth / i.naturalHeight) > 0.03;
  }).length);
  ok('ninguna foto deformada', deformadas === 0, String(deformadas));

  // Catálogo
  await page.evaluate(() => document.querySelector('[data-ir="categoria:Lácteos"]').click());
  await espera(80);
  ok('categoría abre el catálogo', (await texto(page, '#cat-titulo')) === 'Lácteos');
  ok('solo esa categoría', (await cuantos(page, '#productos .card')) === 4);
  await captura(page, 'catalogo-pc');
  await page.goBack();
  await espera(80);
  ok('atrás vuelve al inicio', (await cuantos(page, '#sec-hero')) === 1);

  await clic(page, '[data-ir="catalogo"]');
  await espera(80);
  ok('24 productos en total', (await texto(page, '#cat-n')) === '24 productos');
  await page.type('#pmin', '300');
  await espera(80);
  const conPrecio = Number((await texto(page, '#cat-n')).split(' ')[0]);
  ok('filtro por precio', conPrecio > 0 && conPrecio < 24, String(conPrecio));
  await clic(page, '[data-quitar-filtro="precio"]');
  await espera(50);
  await clic(page, '#f-disp');
  await espera(50);
  ok('filtro de disponibilidad quita agotados', (await texto(page, '#cat-n')) === '22 productos', await texto(page, '#cat-n'));
  ok('filtro activo se ve como chip', (await cuantos(page, '#chips button')) === 2);
  await clic(page, '[data-quitar-filtro="todo"]');
  await espera(50);
  await clic(page, '[data-marca="Rica"]');
  await espera(50);
  ok('filtro por marca', (await texto(page, '#cat-titulo')) === 'Rica');
  await clic(page, '[data-quitar-filtro="todo"]');
  await espera(50);

  // Búsqueda sin acentos y por palabras sueltas
  await page.type('#buscar', 'cafe santo');
  await espera(220);
  ok('búsqueda sin acentos', (await cuantos(page, '#productos .card')) === 1);
  await page.$eval('#buscar', (e) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await espera(220);
  await page.evaluate(() => document.querySelector('.brand').click());
  await espera(80);

  // Vista rápida y detalle
  await page.evaluate(() => document.querySelector('#sec-catalogo .card:not(.agotado) [data-rapida]').click());
  await espera(80);
  ok('vista rápida abre', await page.$eval('#modal', (m) => m.classList.contains('open') && m.classList.contains('rapida')));
  ok('vista rápida sin similares', (await cuantos(page, '#modal .sim-grid')) === 0);
  await clic(page, '[data-act="detalle-completo"]');
  await espera(80);
  ok('pasa al detalle completo', (await cuantos(page, '#modal .acc')) === 1 && (await cuantos(page, '#modal .sim-card')) > 0);
  ok('el enlace del producto queda en la dirección', /\?p=\d+$/.test(page.url()), page.url());
  const enlaceProducto = page.url();
  await captura(page, 'detalle-pc');
  await page.keyboard.press('Escape');
  await espera(500);
  ok('al cerrar se limpia la dirección', !/\?p=/.test(page.url()), page.url());
  const compartido = await browser.createBrowserContext();
  const p3 = await compartido.newPage();
  await p3.goto(enlaceProducto, { waitUntil: 'networkidle0' });
  ok('el enlace compartido abre ese producto', await p3.$eval('#modal', (m) => m.classList.contains('open')));
  await p3.close();

  // Carrito
  const idProd = await page.$eval('#sec-catalogo .card:not(.agotado) [data-agregar]', (b) => Number(b.dataset.agregar));
  await clic(page, `#sec-catalogo [data-agregar="${idProd}"]`);
  await espera(120);
  ok('agregar cambia a − 1 +', (await cuantos(page, `#sec-catalogo .card[data-id="${idProd}"] .qty-pill`)) === 1);
  ok('contador del carrito', (await texto(page, '#cart-count')) === '1');
  ok('aviso visual al agregar', (await cuantos(page, '.toast')) >= 1);
  await clic(page, `#sec-catalogo [data-mas="${idProd}"]`);
  await espera(80);
  ok('sube la cantidad desde la tarjeta', (await texto(page, '#cart-count')) === '2');
  await page.$$eval('#sec-catalogo .card:not(.agotado) [data-agregar]', (l) => l[1].click());
  await espera(80);
  await clic(page, '#cart-btn');
  await page.waitForSelector('.ci-price');
  await espera(250);
  ok('carrito lista los dos', (await cuantos(page, '.ci')) === 2);
  ok('subtotal y total del servidor', /Total/.test(await texto(page, '#panel-foot .totals')));
  await captura(page, 'carrito-pc');
  const antes = await texto(page, '#panel-foot .totals .g:last-child');
  await clic(page, `#panel [data-mas="${idProd}"]`);
  await espera(250);
  ok('cambiar cantidad recalcula', (await texto(page, '#panel-foot .totals .g:last-child')) !== antes);
  const otro = await page.$$eval('#panel [data-quitar]', (l) => l.map((b) => b.dataset.quitar)[1]);
  await clic(page, `#panel [data-quitar="${otro}"]`);
  await espera(250);
  ok('eliminar del carrito', (await cuantos(page, '.ci')) === 1);
  await clic(page, '#panel-foot [data-act="cerrar"]');
  await espera(50);
  ok('seguir comprando cierra el panel', !(await page.$eval('#panel', (p) => p.classList.contains('open'))));

  // Pedido de punta a punta: el precio lo calcula el servidor y descuenta como siempre.
  await clic(page, '#cart-btn');
  await page.waitForSelector('[data-act="datos"]:not([disabled])');
  await clic(page, '[data-act="datos"]');
  await page.waitForSelector('#form');
  await page.type('[name="nombre"]', 'Cliente de Prueba');
  await page.type('[name="telefono"]', '8095550000');
  await clic(page, '[data-act="confirmar"]');
  await page.waitForFunction(() => document.querySelector('#panel-title').textContent.includes('recibido'), { timeout: 5000 }).catch(async (e) => { console.log('panel:', await texto(page, '#panel-content').catch(() => ''), '| errores:', page.errores.join(' | ')); throw e; });
  ok('pedido enviado', /#\d+/.test(await texto(page, '#panel-content .alert')));
  const pedidos = await db.collection(`businesses/${LIC}/pedidosOnline`).get().catch(() => null);
  if (pedidos) ok('el pedido llegó a la nube', pedidos.size === 1, String(pedidos.size));
  ok('el carrito queda vacío', (await page.$eval('#cart-count', (e) => e.classList.contains('hidden'))));

  // Favoritos
  await clic(page, '[data-act="cerrar"]');
  await page.$$eval('#sec-catalogo .fav', (l) => l[0].click());
  await espera(80);
  ok('favorito marcado', (await texto(page, '#fav-count')) === '1');

  ok('sin errores en la página', page.errores.length === 0, page.errores.join(' | '));
  await page.close();

  console.log('\nTeléfono');
  const tel = await abrir(browser, base, { ancho: 390, alto: 844, tacto: true });
  await clic(tel, '#menu-btn');
  await espera(50);
  ok('menú del teléfono abre', await tel.$eval('#menu', (m) => m.classList.contains('open')));
  await captura(tel, 'menu-telefono');
  await clic(tel, '#menu-cuerpo [data-ir="categoria:Bebidas"]');
  await espera(80);
  ok('menú lleva a la categoría', (await texto(tel, '#cat-titulo')) === 'Bebidas');
  ok('menú se cierra', !(await tel.$eval('#menu', (m) => m.classList.contains('open'))));
  await clic(tel, '[data-act="abrir-filtros"]');
  await espera(50);
  ok('filtros en hoja de abajo', await tel.$eval('#filtros', (m) => m.classList.contains('open')));
  await captura(tel, 'filtros-telefono');
  await clic(tel, '#f-ver');
  await espera(50);
  ok('filtros se cierran', !(await tel.$eval('#filtros', (m) => m.classList.contains('open'))));
  await captura(tel, 'catalogo-telefono');
  const id = await tel.$eval('#productos .card:not(.agotado) [data-agregar]', (b) => b.dataset.agregar);
  await clic(tel, `#productos [data-agregar="${id}"]`);
  await espera(80);
  ok('contador en la barra de abajo', (await texto(tel, '#tb-cart-count')) === '1');
  await clic(tel, '#tb-cart');
  await espera(350);
  await captura(tel, 'carrito-telefono');
  ok('carrito a pantalla completa', await tel.$eval('#panel', (p) => p.getBoundingClientRect().width === 390));
  await clic(tel, '[data-act="cerrar"]');
  await espera(50);
  await clic(tel, '#productos .card:not(.agotado) .ver');
  await espera(80);
  await captura(tel, 'detalle-telefono');
  ok('detalle sube desde abajo', await tel.$eval('#modal', (m) => m.classList.contains('open')));
  for (const ancho of [320, 360, 414, 768, 1024, 1366, 1920]) {
    await tel.setViewport({ width: ancho, height: 800, isMobile: ancho < 900, hasTouch: ancho < 900 });
    await espera(60);
    ok(`sin scroll de lado a ${ancho}px`, await sinDesborde(tel));
  }
  ok('sin errores en el teléfono', tel.errores.length === 0, tel.errores.join(' | '));
  await tel.close();

  console.log('\nModo oscuro y animaciones');
  const oscuro = await abrir(browser, base, { oscuro: true });
  ok('modo oscuro del cliente', (await oscuro.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark');
  await captura(oscuro, 'oscuro-pc', { completa: true });
  await clic(oscuro, '#tema-btn');
  ok('se puede volver a claro', (await oscuro.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'light');
  await oscuro.close();

  const anim = await abrir(browser, base, { sinMovimiento: false });
  ok('con movimiento: aparecen al bajar', (await cuantos(anim, '.rv')) > 0);
  await anim.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await espera(1200);
  const vistos = await anim.$$eval('#sec-contacto .cto', (l) => l.every((e) => getComputedStyle(e).opacity === '1'));
  ok('lo de abajo termina visible', vistos);
  await anim.evaluate(() => { window.scrollTo(0, 0); });
  await espera(900);
  const antesVuelo = await cuantos(anim, '.vuela');
  await anim.$$eval('#sec-catalogo [data-agregar]', (l) => l[0].click());
  await espera(60);
  ok('el producto vuela al carrito', (await cuantos(anim, '.vuela')) === antesVuelo + 1);
  await espera(800);
  ok('y desaparece al llegar', (await cuantos(anim, '.vuela')) === 0);
  await anim.close();

  const quieto = await abrir(browser, base);
  ok('reducir movimiento: nada queda oculto', (await cuantos(quieto, '.rv')) === 0);
  await quieto.$$eval('#sec-catalogo [data-agregar]', (l) => l[0].click());
  ok('reducir movimiento: sin vuelo', (await cuantos(quieto, '.vuela')) === 0);
  await quieto.close();
  await cerrar(server);
}

const pos = (page, sel) => page.$eval(sel, (el) => new DOMMatrix(getComputedStyle(el).transform).m41);

async function probarVitrinas(browser) {
  console.log('\nVitrinas con movimiento continuo');
  const { normalizarDiseno } = require('../../vendor/tienda-online/diseno');
  const diseno = normalizarDiseno({
    secciones: [{ id: 'ofertas', titulo: 'Solo por hoy' }, { id: 'hero' }, { id: 'nuevos' }, { id: 'catalogo' }],
    vitrinas: {
      ofertas: { velocidad: 60, direccion: 'izquierda', cantidad: 6, colorFondo: '#fef3c7', colorEtiqueta: '#7c3aed', estiloTarjeta: 'borde' },
      nuevos: { velocidad: 120, direccion: 'derecha', cantidad: 6 },
    },
  });
  const { server, base } = await levantar({ diseno });
  const page = await abrir(browser, base, { sinMovimiento: false, ancho: 1366 });
  const O = '#sec-ofertas .mq-pista';
  const N = '#sec-nuevos .mq-pista';

  ok('título propio', (await texto(page, '#tit-ofertas')) === 'Solo por hoy');
  ok('título por defecto', (await texto(page, '#tit-nuevos')) === 'Nuevos productos');
  ok('cantidad configurada', (await cuantos(page, '#sec-ofertas .mq-grupo:not([data-copia]) .card')) === 6);
  ok('hay copias para el giro infinito', (await cuantos(page, '#sec-ofertas .mq-grupo[data-copia]')) >= 1);
  ok('las copias no son para el teclado ni el lector', await page.$$eval('#sec-ofertas [data-copia]', (l) => l.every((g) => g.getAttribute('aria-hidden') === 'true' && [...g.querySelectorAll('button')].every((b) => b.tabIndex === -1))));
  const totalAntes = await page.evaluate(async () => (await (await fetch(`/api/tiendas/colmado-prueba`)).json()).productos.length);
  ok('las copias no agregan productos', totalAntes === 24);

  // Oferta: todo lo que pide la tarjeta
  const tarjetaOferta = await page.$eval('#sec-ofertas .mq-grupo .card', (c) => ({ img: Boolean(c.querySelector('img, .emoji')), nombre: c.querySelector('.name')?.textContent, antes: c.querySelector('.price s')?.textContent, ahora: c.querySelector('.price .now')?.textContent, pct: c.querySelector('.tag.oferta')?.textContent, boton: Boolean(c.querySelector('[data-agregar], [data-mas]')) }));
  ok('oferta: imagen, nombre, precios, % y botón', tarjetaOferta.img && tarjetaOferta.nombre && tarjetaOferta.antes && tarjetaOferta.ahora && /-\d+%/.test(tarjetaOferta.pct) && tarjetaOferta.boton, JSON.stringify(tarjetaOferta));
  const tarjetaNuevo = await page.$eval('#sec-nuevos .mq-grupo .card', (c) => ({ tag: getComputedStyle(c.querySelector('.tag.nuevo')).textTransform, nombre: c.querySelector('.name')?.textContent, ahora: c.querySelector('.price .now')?.textContent, boton: Boolean(c.querySelector('[data-agregar], [data-mas]')) }));
  ok('nuevo: etiqueta NUEVO, nombre, precio y botón', tarjetaNuevo.tag === 'uppercase' && tarjetaNuevo.nombre && tarjetaNuevo.ahora && tarjetaNuevo.boton, JSON.stringify(tarjetaNuevo));
  ok('nuevos: el más reciente primero', tarjetaNuevo.nombre === 'Curitas', tarjetaNuevo.nombre);

  // Colores y estilos por sección
  const est = await page.evaluate(() => {
    const s = document.querySelector('#sec-ofertas');
    return { fondo: getComputedStyle(s).backgroundColor, borde: getComputedStyle(s.querySelector('.card')).borderTopWidth, etiqueta: getComputedStyle(s.querySelector('.tag.oferta')).backgroundColor, otra: getComputedStyle(document.querySelector('#sec-nuevos')).backgroundColor };
  });
  ok('color de fondo solo en esa sección', est.fondo === 'rgb(254, 243, 199)' && est.otra === 'rgba(0, 0, 0, 0)', JSON.stringify(est));
  ok('color de etiqueta', est.etiqueta === 'rgb(124, 58, 237)', est.etiqueta);
  ok('estilo de tarjeta propio', est.borde === '1px', est.borde);

  // Movimiento y dirección: se mira cuando la vitrina está a la vista.
  await page.mouse.move(2, 2);
  const medirVel = async (sec, sel) => {
    await page.$eval(sec, (s) => s.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await espera(200);
    const a = await pos(page, sel);
    const t0 = Date.now();
    await espera(1000);
    const b = await pos(page, sel);
    return { dif: a - b, seg: (Date.now() - t0) / 1000 };
  };
  const vo = await medirVel('#sec-ofertas', O);
  ok('ofertas se mueven a la izquierda', vo.dif > 0, JSON.stringify(vo));
  const pxO = vo.dif / vo.seg;
  ok('velocidad configurada (60)', pxO > 40 && pxO < 75, String(pxO));
  const vn = await medirVel('#sec-nuevos', N);
  ok('nuevos se mueven a la derecha', vn.dif < 0, JSON.stringify(vn));
  ok('velocidad independiente (120)', Math.abs(vn.dif / vn.seg) > 85, String(vn.dif / vn.seg));

  // Sin saltos: al dar la vuelta, la imagen en pantalla es la misma.
  const sinSalto = await page.evaluate(() => {
    const pista = document.querySelector('#sec-ofertas .mq-pista');
    const g = pista.querySelector('.mq-grupo');
    const c = pista.querySelector('[data-copia]');
    const a = g.querySelector('.card').getBoundingClientRect().left;
    const b = c.querySelector('.card').getBoundingClientRect().left;
    const hueco = parseFloat(getComputedStyle(pista).columnGap);
    return Math.abs((b - a) - (g.getBoundingClientRect().width + hueco));
  });
  ok('la copia queda justo un grupo después (sin saltos)', sinSalto < 1, String(sinSalto));
  let maximoSalto = 0;
  maximoSalto = await page.evaluate(() => new Promise((res) => {
    const pista = document.querySelector('#sec-nuevos .mq-pista');
    const g = pista.querySelector('.mq-grupo');
    const hueco = parseFloat(getComputedStyle(pista).columnGap);
    const ciclo = g.getBoundingClientRect().width + hueco;
    let prev = new DOMMatrix(getComputedStyle(pista).transform).m41;
    let max = 0;
    const fin = performance.now() + 2500;
    (function paso() {
      const x = new DOMMatrix(getComputedStyle(pista).transform).m41;
      const d = Math.abs(x - prev);
      max = Math.max(max, Math.min(d, Math.abs(d - ciclo)));
      prev = x;
      if (performance.now() < fin) requestAnimationFrame(paso); else res(max);
    })();
  }));
  ok('cuadro a cuadro el movimiento es continuo', maximoSalto < 25, String(maximoSalto));

  // Pausa con el mouse
  await page.$eval('#sec-ofertas', (s) => s.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await espera(150);
  const rect = await page.$eval('#sec-ofertas .mq-caja', (c) => { const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 60 }; });
  await page.mouse.move(rect.x, rect.y);
  await espera(120);
  const p1 = await pos(page, O);
  await espera(500);
  ok('se pausa con el mouse encima', Math.abs((await pos(page, O)) - p1) < 1);
  await page.mouse.move(2, 2);
  await espera(400);
  ok('sigue al quitar el mouse', Math.abs((await pos(page, O)) - p1) > 3);

  // Agregar desde una tarjeta en movimiento: sale en el original y en las copias.
  const idAgregar = await page.$eval('#sec-ofertas [data-agregar]', (b) => Number(b.dataset.agregar));
  await page.$eval(`#sec-ofertas [data-agregar="${idAgregar}"]`, (b) => b.click());
  await espera(100);
  const estados = await page.$$eval(`#sec-ofertas .card[data-id="${idAgregar}"]`, (l) => l.map((c) => Boolean(c.querySelector('.qty-pill'))));
  ok('agregar actualiza original y copias', estados.length >= 2 && estados.every(Boolean), String(estados));
  ok('la copia repintada sigue fuera del teclado', await page.$$eval(`#sec-ofertas [data-copia] .card[data-id="${idAgregar}"] button`, (l) => l.every((b) => b.tabIndex === -1)));
  ok('contador del carrito', (await texto(page, '#cart-count')) === '1');
  ok('sin errores en la página', page.errores.length === 0, page.errores.join(' | '));
  await page.close();

  // Táctil: deslizar mueve y no agrega; un toque sí abre.
  const tel = await abrir(browser, base, { ancho: 390, alto: 844, tacto: true, sinMovimiento: false });
  await tel.$eval('#sec-nuevos', (s) => s.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await espera(300);
  const c = await tel.$eval('#sec-nuevos .mq-caja', (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 80 }; });
  const antes = await pos(tel, N);
  await tel.touchscreen.touchStart(c.x, c.y);
  for (let i = 1; i <= 6; i += 1) { await tel.touchscreen.touchMove(c.x - i * 15, c.y); await espera(16); }
  const durante = await pos(tel, N);
  await tel.touchscreen.touchEnd();
  ok('teléfono: se desliza con el dedo', Math.abs(durante - antes) > 40, `${antes} → ${durante}`);
  ok('teléfono: deslizar no abre ni agrega', !(await tel.$eval('#modal', (m) => m.classList.contains('open'))) && (await tel.$eval('#tb-cart-count', (e) => e.classList.contains('hidden'))));
  const quieto = await pos(tel, N);
  await espera(500);
  ok('teléfono: espera un momento tras soltar', Math.abs((await pos(tel, N)) - quieto) < 2);
  await espera(1500);
  ok('teléfono: luego sigue solo', Math.abs((await pos(tel, N)) - quieto) > 5);
  ok('teléfono: sin scroll de lado', await sinDesborde(tel));
  await captura(tel, 'vitrinas-telefono');
  await tel.close();

  // Movimiento reducido: fila a mano, sin copias.
  const red = await abrir(browser, base);
  ok('reducir movimiento: sin animación ni copias', (await cuantos(red, '.mq-caja')) === 0 && (await cuantos(red, '#sec-ofertas .fila')) === 1);
  ok('reducir movimiento: conserva la etiqueta NUEVO', (await cuantos(red, '#sec-nuevos .tag.nuevo')) >= 1);
  await red.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  await espera(150);
  ok('cambiar la preferencia con la página abierta la activa', (await cuantos(red, '.mq-caja')) === 2);
  await red.close();
  await cerrar(server);

  // Pocos productos: se duplican los necesarios para llenar la pantalla y seguir sin cortes.
  const pocos = await levantar({ diseno, ajustar: (p, n) => { p.creadoEn = null; p.descuentoPct = n <= 3 ? 20 : 0; } });
  const pc = await abrir(browser, pocos.base, { sinMovimiento: false });
  ok('pocos productos: se copian hasta llenar la pantalla', await pc.$eval('#sec-ofertas .mq-caja', (c) => c.querySelector('.mq-pista').getBoundingClientRect().width >= c.clientWidth + c.querySelector('.mq-grupo').getBoundingClientRect().width));
  await pc.$eval('#sec-ofertas', (s) => s.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await pc.mouse.move(2, 2);
  await espera(200);
  const ini = await pos(pc, O);
  await espera(500);
  ok('pocos productos: también se mueven', Math.abs((await pos(pc, O)) - ini) > 5);
  ok('pocos productos: siguen siendo 3 de verdad', (await cuantos(pc, '#sec-ofertas .mq-grupo:not([data-copia]) .card')) === 3);
  ok('sin productos nuevos: la sección no aparece', (await cuantos(pc, '#sec-nuevos')) === 0);
  await pc.close();
  await cerrar(pocos.server);

  const uno = await levantar({ diseno, ajustar: (p, n) => { p.creadoEn = null; p.descuentoPct = n === 1 ? 20 : 0; } });
  const u = await abrir(browser, uno.base, { sinMovimiento: false });
  ok('un solo producto: quieto y sin copias', (await cuantos(u, '#sec-ofertas .mq-caja.quieta')) === 1 && (await cuantos(u, '#sec-ofertas [data-copia]')) === 0);
  await u.close();
  await cerrar(uno.server);

  const sinOfertas = await levantar({ ajustar: (p) => { p.descuentoPct = 0; } });
  const so = await abrir(browser, sinOfertas.base, { sinMovimiento: false });
  ok('sin ofertas: la sección no aparece', (await cuantos(so, '#sec-ofertas')) === 0);
  await so.close();
  await cerrar(sinOfertas.server);

  // Apagadas por el administrador.
  const apagadas = await levantar({ diseno: normalizarDiseno({ secciones: [{ id: 'ofertas', activa: false }, { id: 'nuevos', activa: false }] }) });
  const ap = await abrir(browser, apagadas.base, { sinMovimiento: false });
  ok('apagadas: no aparecen', (await cuantos(ap, '#sec-ofertas, #sec-nuevos')) === 0);
  await ap.close();
  await cerrar(apagadas.server);
}

async function probarNombrePeligroso(browser) {
  console.log('\nDatos con código del negocio');
  const { server, base } = await levantar({
    perfilExtra: { nombre: 'Tienda <img src=x onerror="window.__hack=1">', descripcion: '<script>window.__hack=1</script>' },
    diseno: { hero: { titulo: '"><img src=x onerror="window.__hack=1">', enlaceBoton: 'javascript:window.__hack=1' } },
  });
  const page = await abrir(browser, base);
  await espera(150);
  ok('no se ejecuta código del nombre o la portada', !(await page.evaluate(() => window.__hack)));
  ok('botón con enlace peligroso va al catálogo', (await page.$eval('.hero-b1', (b) => b.dataset.ir)) === 'catalogo');
  await page.close();
  await cerrar(server);
}

async function demo() {
  const { aplicarEstilo } = require('../../vendor/tienda-online/diseno');
  // --puerto=N por si esos puertos están ocupados.
  let puerto = Number((args.find((x) => x.startsWith('--puerto=')) || '').split('=')[1]) || 3410;
  for (const estilo of ['moderno', 'comercial', 'premium']) {
    const { base } = await levantar({ diseno: aplicarEstilo(estilo, { hero: PORTADA }) }, puerto);
    console.log(`${estilo}: ${base}/t/colmado-prueba`);
    puerto += 1;
  }
}

(async function main() {
  if (DEMO) { await demo(); return; }
  const browser = await puppeteer.launch({ headless: true });
  try {
    await probarTiendaSinDiseno(browser);
    await probarEstilos(browser);
    await probarCatalogoYCarrito(browser);
    await probarVitrinas(browser);
    await probarNombrePeligroso(browser);
  } finally {
    await browser.close();
  }
  const fallas = resultados.filter((r) => !r.ok);
  console.log(`\n${resultados.length - fallas.length}/${resultados.length} pasaron`);
  if (fallas.length) { fallas.forEach((f) => console.log(`FALLA ${f.nombre}`)); process.exitCode = 1; }
})().catch((e) => { console.error(e); process.exit(1); });
