// Vender productos por peso SIN báscula conectada, con la app real (Chrome) y
// SQLite en una carpeta temporal:
//   A. sin báscula configurada: la ventana "Venta por peso" pide el peso a mano;
//   B. báscula por puerto COM configurada pero desconectada: falla la lectura y
//      igual se escribe el peso a mano;
//   C. báscula USB configurada pero desconectada: igual se escribe a mano;
//   D. "Permitir modificar el total en productos por peso": entra 1 lb sin
//      ventana y se escribe el monto en el Total;
//   E. se cobra cada venta y el servidor guarda la cantidad con decimales.
// Uso: npm run test:peso-sin-bascula
/* global DB, doLogin, showModule, openBillingModal, setMontoExacto, processSale, startSaleLineTotalEdit, closeReceipt, renderSaleTable -- corren en la página */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..', '..');
process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-peso-sin-bascula');
const L = require(path.join(PROJECT, 'scripts', 'e2e-lan', 'lib'));
const puppeteer = require(path.join(PROJECT, 'node_modules', 'puppeteer'));

const OUT = path.join(L.WORK, 'capturas');
const PORT = Number(process.env.TC_PRUEBA_PORT) || 3487;
const USER_DATA = path.join(L.WORK, 'pc-data');
const HOME = path.join(L.WORK, 'home');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = L.check;

(async () => {
  let server = null;
  let browser = null;
  const problemas = [];
  try {
    L.prepareSandbox();
    for (const dir of [USER_DATA, HOME, OUT]) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
    fs.mkdirSync(OUT, { recursive: true });
    server = L.startServer('peso', { port: PORT, userData: USER_DATA, env: { DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME, TECNO_CAJA_DEMO: '1', TECNO_CAJA_SYNC_URL: 'off' } });
    await L.waitHttp(PORT);
    await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja',
      businessName: 'Colmado Peso', adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@prueba.test',
      adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });
    const token = (await L.request(PORT, 'POST', '/api/login', { usuario: 'admin', password: '1234' })).body?.token;
    for (const p of [
      { codigo: 'POLLO', nombre: 'Pollo', precioVenta: 100, stock: 100, aplicaItbis: false },
      { codigo: 'QUESO', nombre: 'Queso de freír', precioVenta: 300, stock: 40, aplicaItbis: true, itbisIncluido: true },
    ]) {
      const r = await L.request(PORT, 'POST', '/api/products', {
        marca: '', estado: 'Activo', stockMin: 0, categoria: 'Carnes', unidad: 'Libra (lb)', saleMode: 'peso', precioCompra: 50, ...p,
      }, token);
      check(`Producto por peso creado: ${p.nombre}`, r.status < 300, `HTTP ${r.status} ${r.body?.error || ''}`);
    }

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

    // La báscula de esta caja (en la app de escritorio sale de los periféricos de la PC).
    const bascula = (cambios) => page.evaluate((c) => {
      window.LocalPeripheralsFlat = { ...(window.LocalPeripheralsFlat || {}), ...c };
      DB.config = { ...DB.config, ...c };
    }, cambios);
    const escanear = async (texto) => {
      await page.click('#product-search', { clickCount: 3 });
      await page.keyboard.type(texto);
      await page.keyboard.press('Enter');
      await sleep(800);
    };
    const ventana = () => page.evaluate(() => {
      const caja = document.querySelector('.sale-scale-dialog');
      return caja ? {
        foco: document.activeElement?.id || '',
        estado: document.getElementById('sale-scale-status')?.textContent.trim() || '',
        leerPeso: Boolean(document.getElementById('sale-scale-read-btn') && !document.getElementById('sale-scale-read-btn').hidden),
        texto: caja.innerText.replace(/\s+/g, ' ').slice(0, 160),
      } : null;
    });
    const escribirPeso = async (peso) => {
      await page.click('#sale-scale-manual-weight', { clickCount: 3 });
      await page.keyboard.type(String(peso));
      await sleep(200);
      await page.keyboard.press('Enter');
      await sleep(700);
    };
    const carrito = () => page.evaluate(() => DB.saleItems.map((i) => ({ codigo: i.codigo, qty: Number(i.qty), total: Number(i.total), fuente: i.scaleSource || '' })));
    const cobrar = async () => {
      const antes = ventas.length;
      await page.evaluate(() => openBillingModal());
      await sleep(1200);
      await page.evaluate(() => setMontoExacto());
      await sleep(300);
      await page.evaluate(() => processSale('charge'));
      for (let i = 0; i < 40 && ventas.length === antes; i += 1) await sleep(250);
      await sleep(800);
      return ventas.length > antes ? ventas[ventas.length - 1] : null;
    };

    // ── 0. Lo normal (2026-11-17): sin ventana, se escribe el monto ─────────
    const porDefecto = await page.evaluate(() => DB.config?.weightTotalEditEnabled);
    check('Instalación nueva: "modificar el total en productos por peso" viene encendido', porDefecto === true, String(porDefecto));
    await bascula({ scaleType: 'none' });
    await escanear('POLLO');
    const sinVentana = await carrito();
    check('Sin báscula: el producto por peso entra directo (1 lb), sin la ventana', !(await ventana()) && sinVentana.length === 1 && sinVentana[0].qty === 1, JSON.stringify(sinVentana));
    const botonPeso = () => page.evaluate(() => Boolean(document.querySelector('#module-ventas .sale-weight-btn')));
    check('Sin báscula: la línea no trae el botón "Ingresar peso" (se escribe el Total)', !(await botonPeso()));
    await page.evaluate(() => { DB.saleItems = []; renderSaleTable(); });
    await sleep(300);

    // ── A. Sin báscula y con la opción apagada: la ventana pide el peso ──────
    await bascula({ scaleType: 'none', weightTotalEditEnabled: false });
    await escanear('POLLO');
    const vA = await ventana();
    await page.screenshot({ path: path.join(OUT, 'a-sin-bascula.png') });
    check('A. Sin báscula: sale la ventana para escribir el peso, con el cursor en el peso y sin "Leer peso"',
      vA && vA.foco === 'sale-scale-manual-weight' && !vA.leerPeso, JSON.stringify(vA));
    await escribirPeso('0.75');
    let c = await carrito();
    check('A. Enter con 0.75 lb: entra 0.75 lb de pollo (RD$75.00)', !(await ventana()) && c.length === 1 && c[0].qty === 0.75 && c[0].total === 75 && c[0].fuente === 'manual', JSON.stringify(c));
    check('A. Con la opción apagada la línea sí trae "Ingresar peso" (única forma de corregir el peso)', await botonPeso());

    // ── B. Báscula COM configurada pero desconectada ─────────────────────────
    await bascula({ scaleType: 'serial', scaleSerialPort: 'COM99', scaleAutoRead: true });
    await escanear('QUESO');
    await sleep(800);
    const vB = await ventana();
    await page.screenshot({ path: path.join(OUT, 'b-com-desconectada.png') });
    check('B. Báscula COM sin conectar: la ventana avisa que no leyó y deja el cursor en el peso', vB && /no|solo|lectura/i.test(vB.estado) && vB.foco === 'sale-scale-manual-weight', JSON.stringify(vB));
    await escribirPeso('1.25');
    c = await carrito();
    const queso = c.find((i) => i.codigo === 'QUESO');
    check('B. Se escribe 1.25 lb a mano y entra (RD$375.00, ITBIS incluido)', !(await ventana()) && queso?.qty === 1.25 && queso.total === 375, JSON.stringify(c));

    // ── C. Báscula USB configurada pero desconectada ─────────────────────────
    await bascula({ scaleType: 'usb' });
    await escanear('POLLO');
    const vC = await ventana();
    check('C. Báscula USB sin conectar: igual sale la ventana', Boolean(vC), JSON.stringify(vC));
    await escribirPeso('0.5');
    c = await carrito();
    const pollos = c.filter((i) => i.codigo === 'POLLO');
    const totalPollo = pollos.reduce((a, i) => a + i.qty, 0);
    check('C. Se escribe 0.5 lb a mano y suma (pollo: 1.25 lb en total)', !(await ventana()) && Math.abs(totalPollo - 1.25) < 0.001, JSON.stringify(c));

    // ── E1. Cobrar ───────────────────────────────────────────────────────────
    const r1 = await cobrar();
    const v1 = r1?.cuerpo?.sale;
    const items1 = (v1?.items || []).map((i) => `${i.codigo}:${i.qty}:${i.total}`).join(' ');
    check('Cobrar: el servidor acepta la venta con los pesos escritos a mano', r1?.status === 201 && Math.abs(Number(v1?.total) - 500) < 0.01, `HTTP ${r1?.status} total ${v1?.total} · ${items1} ${r1?.cuerpo?.error || ''}`);

    // ── D. "Modificar el total" activo, sin báscula ──────────────────────────
    // Después de cobrar queda abierto el comprobante: se cierra y se vuelve a Ventas.
    await page.keyboard.press('Escape');
    await sleep(500);
    await page.evaluate(() => { if (typeof closeReceipt === 'function') closeReceipt(); showModule('ventas'); });
    await sleep(800);
    // La opción se guarda en el negocio (el servidor la vuelve a revisar al cobrar).
    await page.evaluate(async () => {
      const r = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken}` },
        body: JSON.stringify({ ...DB.config, weightTotalEditEnabled: true }),
      });
      DB.config = { ...DB.config, ...(await r.json()) };
    });
    await bascula({ scaleType: 'none', weightTotalEditEnabled: true });
    await escanear('POLLO');
    c = await carrito();
    check('D. Con "modificar el total": entra 1 lb sin ventana', !(await ventana()) && c.length === 1 && c[0].qty === 1 && c[0].total === 100, JSON.stringify(c));
    await page.evaluate(() => startSaleLineTotalEdit(0));
    await sleep(300);
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.type('180');
    await page.keyboard.press('Enter');
    await sleep(600);
    c = await carrito();
    check('D. Total escrito RD$180: 1.8 lb y cobra exacto 180', c.length === 1 && Math.abs(c[0].qty - 1.8) < 0.001 && c[0].total === 180, JSON.stringify(c));
    const r2 = await cobrar();
    const v2 = r2?.cuerpo?.sale;
    check('D. Cobrar: el servidor guarda 1.8 lb y RD$180', r2?.status === 201 && Number(v2?.total) === 180 && Number(v2?.items?.[0]?.qty) === 1.8,
      `HTTP ${r2?.status} total ${v2?.total} qty ${v2?.items?.[0]?.qty} ${r2?.cuerpo?.error || ''}`);

    check('Sin errores en la página', problemas.length === 0, problemas.join('\n'));
    if (L.results.some((r) => !r.ok)) process.exitCode = 1;
  } catch (error) {
    console.error('FALLÓ:', error.stack || error.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await sleep(2000);
    if (server) await L.stopServer(server).catch(() => {});
    console.log('Capturas en:', OUT);
    process.exit(process.exitCode || 0);
  }
})();
