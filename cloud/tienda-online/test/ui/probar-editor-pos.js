'use strict';

// Personalizar tienda en la app real, con clics y la vista previa de verdad.
// Con SQLite en una carpeta temporal; la tienda de los clientes no se toca.
//   node cloud/tienda-online/test/ui/probar-editor-pos.js [carpeta-de-capturas]
/* global DB, doLogin, TiendaEditor -- corren dentro de la página */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-editor-ui');
const L = require('../../../../scripts/e2e-lan/lib');
const puppeteer = require(path.join(L.PROJECT, 'node_modules', 'puppeteer'));

const PORT = 3494;
const USER_DATA = path.join(L.WORK, 'pc-data');
const HOME = path.join(L.WORK, 'home');
const CAPTURAS = process.argv[2] || '';
const ENV = { DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const resultados = [];
function ok(nombre, cond, detalle = '') {
  resultados.push({ nombre, ok: Boolean(cond) });
  console.log(`${cond ? '  ok ' : 'FALLA'} ${nombre}${!cond && detalle ? ` → ${detalle}` : ''}`);
}

(async () => {
  let server = null;
  let browser = null;
  try {
    L.prepareSandbox();
    for (const dir of [USER_DATA, HOME]) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
    server = L.startServer('editor-ui', { port: PORT, userData: USER_DATA, env: ENV });
    await L.waitHttp(PORT);
    await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja', businessName: 'Colmado Editor',
      adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@prueba.test', adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });

    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    const errores = [];
    page.on('pageerror', (e) => errores.push(`pos: ${e.message}`));
    page.on('dialog', (d) => d.accept());
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#login-user', { timeout: 30000 });
    await page.evaluate(() => {
      document.getElementById('login-user').value = 'admin';
      document.getElementById('login-pass').value = '1234';
    });
    await page.evaluate(() => doLogin());
    await sleep(1500);

    const api = (metodo, ruta, cuerpo) => page.evaluate(async (m, r, c) => {
      const res = await fetch(r, {
        method: m,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken}` },
        body: c ? JSON.stringify(c) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }, metodo, ruta, cuerpo);
    const config = async () => (await api('GET', '/api/tienda-online/config')).body;

    // Productos publicados para ver algo en la vista previa
    const ids = [];
    for (let i = 1; i <= 8; i += 1) {
      const r = await api('POST', '/api/products', {
        codigo: `P${i}`, barcode: `P${i}`, nombre: `Producto ${i}`, categoria: i % 2 ? 'BEBIDAS' : 'DESPENSA', unidad: 'Unidad', marca: '', precioVenta: 100 + i, precioCompra: 1, stock: 50, stockMin: 0, aplicaItbis: false, estado: 'Activo',
      });
      ids.push(Number(r.body?.product?.id || r.body?.producto?.id || r.body?.id || 0));
    }
    ok('productos creados', ids.every(Boolean), ids.join());
    await api('POST', '/api/tienda-online/productos/masivo', { accion: 'publicar', ids });

    await page.evaluate(() => TiendaEditor.abrir());
    await page.waitForSelector('#te-filas', { timeout: 10000 });
    const marco = async () => (await page.$('#te-marco')).contentFrame();
    let f = await marco();
    await f.waitForSelector('#sec-catalogo', { timeout: 15000 });
    ok('la vista previa carga dentro de la ventana', (await f.$$eval('#sec-catalogo .card', (l) => l.length)) === 8);
    ok('sale el nombre del negocio', (await f.$eval('#brand h1', (e) => e.textContent)) === 'Colmado Editor');
    const errMarco = [];
    f.page().on('pageerror', (e) => errMarco.push(e.message));
    ok('empieza igual a lo publicado', (await page.$eval('#te-estado', (e) => e.textContent)) === 'Igual a lo publicado');

    // Color: se ve al instante y sin publicar
    await page.$eval('[data-color="fondo"]', (c) => { c.value = '#fef3c7'; c.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForFunction(async () => true);
    await sleep(350);
    f = await marco();
    ok('cambiar un color se ve en la vista previa', (await f.$eval('body', (b) => getComputedStyle(b).backgroundColor)) === 'rgb(254, 243, 199)');
    ok('avisa que hay cambios', (await page.$eval('#te-estado', (e) => e.textContent)) === 'Cambios sin guardar');
    ok('sin guardar, no queda nada en la base', (await config()).settings.diseno === null);

    // Color automático
    await page.$eval('[data-color-auto="botones"]', (c) => c.click());
    ok('quitar "color del negocio" habilita el color', !(await page.$eval('[data-color="botones"]', (c) => c.disabled)));

    // Apariencia
    await page.select('[data-ruta="apariencia.tipografia"]', 'nunito');
    await page.select('[data-ruta="apariencia.estiloBotones"]', 'recto');
    await page.select('[data-ruta="apariencia.esquinas"]', 'rectas');
    await sleep(300);
    f = await marco();
    const estilo = await f.evaluate(() => ({ boton: document.documentElement.dataset.boton, esquinas: document.documentElement.dataset.esquinas, letra: getComputedStyle(document.body).fontFamily }));
    ok('letra, botones y esquinas', estilo.boton === 'recto' && estilo.esquinas === 'rectas' && /Nunito/.test(estilo.letra), JSON.stringify(estilo));

    // Encabezado
    await page.$eval('[data-ruta="encabezado.mostrarBuscador"]', (c) => c.click());
    await sleep(300);
    f = await marco();
    ok('apagar el buscador', await f.$eval('#search-box', (e) => getComputedStyle(e).display === 'none'));

    // Banner
    await page.evaluate(() => { document.querySelectorAll('.te-sec').forEach((d) => { d.open = true; }); });
    await page.type('[data-ruta="hero.titulo"]', 'Bienvenidos');
    await page.select('[data-ruta="hero.altura"]', 'alta');
    await page.select('[data-destino="hero.enlaceBoton"]', 'ofertas');
    await sleep(300);
    f = await marco();
    ok('título del banner', (await f.$eval('.hero h2', (e) => e.textContent)) === 'Bienvenidos');
    ok('altura del banner', (await f.evaluate(() => document.documentElement.dataset.hero)) === 'alta');

    // Orden: botones y arrastre
    const ordenMarco = async () => (await marco()).$$eval('#app > section', (l) => l.map((s) => s.id.replace('sec-', '')));
    const ordenLista = () => page.$$eval('#te-filas .te-fila', (l) => l.map((x) => x.dataset.sec));
    const antes = await ordenLista();
    ok('encabezado y pie en sus puntas', antes[0] === 'encabezado' && antes[antes.length - 1] === 'pie');
    await page.$eval('.te-fila[data-sec="catalogo"] [data-mover="-1"]', (b) => b.click());
    const despues = await ordenLista();
    ok('subir con el botón', despues.indexOf('catalogo') === antes.indexOf('catalogo') - 1);
    // Arrastre: el navegador de prueba no genera estos eventos con el mouse simulado,
    // así que se disparan los mismos que produce arrastrar de verdad.
    await page.evaluate(() => {
      const fila = document.querySelector('.te-fila[data-sec="catalogo"]');
      const destino = document.querySelector('.te-fila[data-sec="hero"]');
      const r = destino.getBoundingClientRect();
      const dt = new DataTransfer();
      const evento = (tipo, y) => new DragEvent(tipo, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 5, clientY: y });
      fila.dispatchEvent(evento('dragstart', r.top));
      destino.dispatchEvent(evento('dragover', r.top + 2));
      destino.dispatchEvent(evento('drop', r.top + 2));
      fila.dispatchEvent(evento('dragend', r.top + 2));
    });
    await sleep(400);
    const arrastrado = await ordenLista();
    ok('arrastrar cambia el orden', arrastrado.indexOf('catalogo') < arrastrado.indexOf('hero'), arrastrado.join());
    ok('la vista previa sigue el orden', (await ordenMarco())[0] === 'catalogo', (await ordenMarco()).join());

    // Apagar una sección
    await page.$eval('[data-sec-activa="informacion"]', (c) => c.click());
    await sleep(300);
    ok('apagar una sección', !(await ordenMarco()).includes('informacion'));
    ok('todos los productos no se apaga', await page.$eval('[data-sec-activa="catalogo"]', (c) => c.disabled));

    // Tamaños
    await page.$eval('[data-ancho="telefono"]', (b) => b.click());
    await sleep(500);
    ok('vista de teléfono', (await page.$eval('#te-marco', (m) => m.getBoundingClientRect().width)) === 390);
    f = await marco();
    ok('en teléfono se ve la barra de abajo', await f.$eval('#tabbar', (e) => getComputedStyle(e).display !== 'none'));
    if (CAPTURAS) {
      fs.mkdirSync(CAPTURAS, { recursive: true });
      await page.screenshot({ path: path.join(CAPTURAS, 'editor-telefono.png') });
    }
    await page.$eval('[data-ancho="computadora"]', (b) => b.click());
    await sleep(400);
    if (CAPTURAS) await page.screenshot({ path: path.join(CAPTURAS, 'editor-pc.png') });

    // Guardar borrador: no se publica
    await page.$eval('[data-accion="borrador"]', (b) => b.click());
    await sleep(500);
    let c = await config();
    ok('guardar deja un borrador', c.settings.disenoBorrador?.colores?.fondo === '#fef3c7');
    ok('lo publicado no cambia', c.settings.diseno === null);
    ok('el estado lo dice', (await page.$eval('#te-estado', (e) => e.textContent)).startsWith('Borrador guardado'));

    // Cerrar y volver: el borrador sigue
    await page.$eval('[data-accion="cerrar"]', (b) => b.click());
    ok('cierra', (await page.$$('.te-raiz')).length === 0);
    await page.evaluate(() => TiendaEditor.abrir());
    await page.waitForSelector('#te-filas');
    ok('al volver sigue el borrador', (await page.$eval('[data-color="fondo"]', (e) => e.value)) === '#fef3c7');

    // Publicar
    await page.$eval('[data-accion="publicar"]', (b) => b.click());
    await sleep(600);
    c = await config();
    ok('publicar guarda el diseño', c.settings.diseno?.colores?.fondo === '#fef3c7' && c.settings.disenoBorrador === null);
    ok('publicó el orden', c.settings.diseno.secciones.findIndex((s) => s.id === 'catalogo') < c.settings.diseno.secciones.findIndex((s) => s.id === 'hero'));
    ok('el estado lo dice', (await page.$eval('#te-estado', (e) => e.textContent)) === 'Igual a lo publicado');

    // Descartar
    await page.$eval('[data-color="fondo"]', (x) => { x.value = '#000000'; x.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(250);
    await page.$eval('[data-accion="descartar"]', (b) => b.click());
    await sleep(500);
    ok('descartar vuelve a lo publicado', (await page.$eval('[data-color="fondo"]', (e) => e.value)) === '#fef3c7');
    f = await marco();
    ok('la vista previa también', (await f.$eval('body', (b) => getComputedStyle(b).backgroundColor)) === 'rgb(254, 243, 199)');

    // Estilo inicial: cambia el aspecto y conserva los textos
    await page.evaluate(() => { document.querySelectorAll('.te-sec').forEach((d) => { d.open = true; }); });
    await page.$eval('[data-estilo="premium"]', (b) => b.click());
    await sleep(500);
    ok('estilo Premium', (await page.$eval('[data-color="fondo"]', (e) => e.value)) === '#faf8f5');
    ok('conserva el título del banner', (await page.$eval('[data-ruta="hero.titulo"]', (e) => e.value)) === 'Bienvenidos');
    f = await marco();
    ok('se ve en la vista previa', (await f.evaluate(() => document.documentElement.dataset.esquinas)) === 'rectas');

    // Restaurar: no publica hasta indicarlo
    await page.$eval('[data-accion="restaurar"]', (b) => b.click());
    await sleep(500);
    ok('restaurar borra los textos', (await page.$eval('[data-ruta="hero.titulo"]', (e) => e.value)) === '');
    ok('restaurar no publica', (await config()).settings.diseno.hero.titulo === 'Bienvenidos');
    await page.$eval('[data-accion="borrador"]', (b) => b.click());
    await sleep(400);
    await page.$eval('[data-accion="descartar"]', (b) => b.click());
    await sleep(400);

    // Validación en el servidor
    const malo = await api('PUT', '/api/tienda-online/config/diseno', { publicar: false, diseno: { colores: { fondo: 'url(x)' }, hero: { enlaceBoton: 'javascript:alert(1)', titulo: 'x'.repeat(500) } } });
    ok('lo inválido no entra', malo.body.diseno.colores.fondo === '#ffffff' && malo.body.diseno.hero.enlaceBoton === 'catalogo' && malo.body.diseno.hero.titulo.length === 90);
    await api('DELETE', '/api/tienda-online/config/diseno/borrador');

    // Imágenes
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const img = await api('POST', '/api/tienda-online/config/imagen/anuncio_1', { dataUrl: png });
    ok('sube un banner publicitario', img.body.imagenes?.includes('anuncio_1'), JSON.stringify(img.body));
    ok('una clave rara se rechaza', (await api('POST', '/api/tienda-online/config/imagen/otra', { dataUrl: png })).status === 400);
    const vista = await page.evaluate(async () => (await fetch('/api/tiendas/vista-previa')).json());
    ok('la vista previa lo muestra', vista.tienda.anuncios.length === 1 && vista.tienda.anuncios[0].imagen.includes('_anuncio_1'), JSON.stringify(vista.tienda.anuncios));
    const respuesta = await page.evaluate(async (u) => (await fetch(u)).status, vista.tienda.anuncios[0].imagen);
    ok('la imagen se sirve', respuesta === 200, String(respuesta));
    ok('se puede quitar', !(await api('DELETE', '/api/tienda-online/config/imagen/anuncio_1')).body.imagenes.includes('anuncio_1'));

    // Permisos y pedidos
    const sinSesion = await page.evaluate(async () => (await fetch('/api/tienda-online/config/diseno', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"publicar":true,"diseno":{}}' })).status);
    ok('sin sesión no se publica', sinSesion === 401 || sinSesion === 403, String(sinSesion));
    const pedido = await page.evaluate(async () => (await fetch('/api/tiendas/vista-previa/pedidos', { method: 'POST' })).status);
    ok('la vista previa no recibe pedidos', pedido === 400, String(pedido));

    // Vitrinas: guardar aquí no se pierde al publicar un borrador viejo
    await api('PUT', '/api/tienda-online/config/diseno', { publicar: false, diseno: c.settings.diseno });
    const cfgAntes = await config();
    const conVitrina = { ...cfgAntes.disenoBase, vitrinas: { ...cfgAntes.disenoBase.vitrinas, ofertas: { ...cfgAntes.disenoBase.vitrinas.ofertas, velocidad: 99 } } };
    await api('PUT', '/api/tienda-online/config', { settings: { diseno: conVitrina } });
    ok('las vitrinas pasan al borrador abierto', (await config()).settings.disenoBorrador.vitrinas.ofertas.velocidad === 99);
    await api('DELETE', '/api/tienda-online/config/diseno/borrador');

    ok('sin errores en el POS', errores.length === 0, errores.join(' | '));
    ok('sin errores en la vista previa', errMarco.length === 0, errMarco.join(' | '));
  } finally {
    if (browser) await browser.close();
    if (server) L.stopServer(server);
  }
  const fallas = resultados.filter((r) => !r.ok);
  console.log(`\n${resultados.length - fallas.length}/${resultados.length} pasaron`);
  fallas.forEach((x) => console.log(`FALLA ${x.nombre}`));
  process.exit(fallas.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
