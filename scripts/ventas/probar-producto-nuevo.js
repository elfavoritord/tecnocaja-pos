// Producto nuevo desde la venta (js/ventas.js → suggestRegisterProduct): al
// escanear un código que no está en el sistema sale una ventana corta con el
// código puesto; nombre + precio con Enter y el producto se crea y entra a la
// venta. En la app real, con SQLite en una carpeta temporal.
// Uso: npm run test:producto-nuevo
/* global DB, doLogin, showModule, openBillingModal, setMontoExacto, processSale */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..', '..');
process.env.TC_E2E_DIR = path.join(os.tmpdir(), 'tecnocaja-producto-nuevo');
const L = require(path.join(PROJECT, 'scripts', 'e2e-lan', 'lib'));
const puppeteer = require(path.join(PROJECT, 'node_modules', 'puppeteer'));

const OUT = path.join(L.WORK, 'capturas');
const PORT = Number(process.env.TC_PRUEBA_PORT) || 3485;
const USER_DATA = path.join(L.WORK, 'pc-data');
const HOME = path.join(L.WORK, 'home');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let server = null;
  let browser = null;
  const problemas = [];
  try {
    L.prepareSandbox();
    for (const dir of [USER_DATA, HOME, OUT]) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
    fs.mkdirSync(OUT, { recursive: true });
    server = L.startServer('producto-nuevo', { port: PORT, userData: USER_DATA, env: { DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME, TECNO_CAJA_DEMO: '1', TECNO_CAJA_SYNC_URL: 'off' } });
    await L.waitHttp(PORT);
    await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja',
      businessName: 'Colmado La Esquina', adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@prueba.test',
      adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });

    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    page.on('pageerror', (e) => problemas.push(`error de página: ${e.message}`));
    const ventas = [];
    page.on('response', async (res) => {
      if (res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/sales') {
        let cuerpo = null;
        try { cuerpo = await res.json(); } catch (_) { /* sin cuerpo */ }
        ventas.push({ status: res.status(), cuerpo });
      }
    });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#login-user', { timeout: 30000 });
    await page.evaluate(() => {
      document.getElementById('login-user').value = 'admin';
      document.getElementById('login-pass').value = '1234';
      return doLogin();
    });
    await page.waitForFunction(() => Boolean(typeof DB !== 'undefined' && DB.currentUser), { timeout: 30000 });
    await sleep(1500);
    await page.evaluate(() => showModule('ventas'));
    await sleep(800);

    // Escanear = escribir en el buscador y Enter (así manda el lector USB).
    const escanear = async (texto) => {
      await page.click('#product-search', { clickCount: 3 });
      await page.keyboard.type(texto);
      await page.keyboard.press('Enter');
      await sleep(700);
    };
    const ventanaAbierta = () => page.evaluate(() => Boolean(document.getElementById('venta-producto-nuevo'))
      && !document.getElementById('modal-overlay')?.classList.contains('hidden'));
    const carrito = () => page.evaluate(() => DB.saleItems.map((i) => ({ nombre: i.nombre, codigo: i.codigo, qty: i.qty, precio: i.precio, total: i.total })));
    const CODIGO = '7460001234567';

    // 1. Código desconocido → ventana corta con el código ya puesto y el foco en Nombre.
    await escanear(CODIGO);
    const ventana = await page.evaluate(() => ({
      titulo: document.getElementById('modal-title')?.textContent,
      codigo: document.getElementById('vpn-codigo')?.value,
      foco: document.activeElement?.id,
    }));
    await page.screenshot({ path: path.join(OUT, '1-producto-nuevo.png') });
    L.check('Código desconocido: sale "Producto nuevo" con el código puesto', (await ventanaAbierta()) && ventana.codigo === CODIGO && ventana.titulo === 'Producto nuevo', JSON.stringify(ventana));
    L.check('El cursor queda en Nombre', ventana.foco === 'vpn-nombre', String(ventana.foco));

    // 2. Sin precio no guarda.
    await page.keyboard.type('Galletas de soda');
    await page.keyboard.press('Enter');
    await sleep(200);
    const focoPrecio = await page.evaluate(() => document.activeElement?.id);
    L.check('Enter en Nombre pasa a Precio', focoPrecio === 'vpn-precio', String(focoPrecio));
    await page.keyboard.press('Enter');
    await sleep(500);
    L.check('Sin precio no se guarda', (await ventanaAbierta()) && (await carrito()).length === 0);

    // 3. Precio + Enter → se crea y entra a la venta.
    await page.keyboard.type('65.50');
    await page.keyboard.press('Enter');
    await sleep(1500);
    const c1 = await carrito();
    L.check('Enter en Precio: se guarda y entra a la venta (1 a 65.50)', !(await ventanaAbierta()) && c1.length === 1
      && c1[0].nombre === 'Galletas de soda' && c1[0].qty === 1 && c1[0].precio === 65.5 && c1[0].total === 65.5, JSON.stringify(c1));
    const producto = await page.evaluate(async (codigo) => {
      const j = await (await fetch('/api/products', { headers: { Authorization: `Bearer ${DB.authToken}` } })).json();
      return (Array.isArray(j) ? j : j.products).find((p) => p.codigo === codigo) || null;
    }, CODIGO);
    L.check('Quedó en el catálogo: General, por unidad, sin ITBIS y sin control de existencia', producto && producto.precioVenta === 65.5
      && producto.categoria === 'General' && producto.aplicaItbis === false && producto.tracksStock === false && producto.saleMode === 'unidad', JSON.stringify(producto).slice(0, 220));

    // 4. Volver a escanearlo suma uno, sin ventana.
    await escanear(CODIGO);
    const c2 = await carrito();
    L.check('Escanearlo otra vez suma uno sin ventana', !(await ventanaAbierta()) && c2.length === 1 && c2[0].qty === 2, JSON.stringify(c2));

    // 5. Escape cierra la ventana y la venta sigue.
    await escanear('9990001112223');
    L.check('Otro código desconocido abre la ventana', await ventanaAbierta());
    await page.keyboard.press('Escape');
    await sleep(600);
    const c3 = await carrito();
    L.check('Escape cierra la ventana y la venta sigue', !(await ventanaAbierta()) && c3.length === 1 && c3[0].qty === 2, JSON.stringify(c3));

    // 6. Si escribieron un nombre (con espacios), va en Nombre y el cursor en Código.
    await escanear('pan dulce');
    const porNombre = await page.evaluate(() => ({
      codigo: document.getElementById('vpn-codigo')?.value,
      nombre: document.getElementById('vpn-nombre')?.value,
      foco: document.activeElement?.id,
    }));
    L.check('Búsqueda por nombre: el nombre queda puesto y el cursor en Código', porNombre.codigo === '' && porNombre.nombre === 'pan dulce' && porNombre.foco === 'vpn-codigo', JSON.stringify(porNombre));
    await page.keyboard.press('Escape');
    await sleep(500);

    // 7. Cobrar.
    await page.evaluate(() => openBillingModal());
    await sleep(1200);
    await page.evaluate(() => setMontoExacto());
    await sleep(300);
    await page.evaluate(() => processSale('charge'));
    await sleep(3000);
    const venta = ventas.find((v) => v.status < 300)?.cuerpo?.sale;
    L.check('La venta se cobra: 2 × 65.50 = 131.00', Number(venta?.total) === 131, JSON.stringify(venta || ventas).slice(0, 200));

    L.check('Sin errores en la página', problemas.length === 0, problemas.join('\n'));
    if (L.results.some((r) => !r.ok)) process.exitCode = 1;
  } catch (error) {
    console.error('FALLÓ:', error.stack || error.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await sleep(2000);
    if (server) await L.stopServer(server).catch(() => {});
    console.log('Capturas en:', OUT);
  }
})();
