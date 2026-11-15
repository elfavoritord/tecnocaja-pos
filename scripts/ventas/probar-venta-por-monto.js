// Total editado en productos por peso (Configuración → Facturación →
// "Permitir modificar el total en productos por peso", js/venta-por-monto.js)
// en la app real, con SQLite en una carpeta temporal y sin báscula conectada:
// tocar el Total de la línea, escribir el monto, Enter/Escape, ITBIS, producto
// por unidad, cobro por el flujo del cajero, lo guardado, el inventario y que
// el servidor no acepte trampas ni el total editado con la opción apagada.
// Uso: npm run test:venta-por-monto
/* global DB, doLogin, showModule, addProductById, openBillingModal, setMontoExacto, processSale, buildSalePayload, api, saveConfig, closeReceipt, closeAllModals */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..', '..');
process.env.TC_E2E_DIR = path.join(os.tmpdir(), 'tecnocaja-venta-monto');
const L = require(path.join(PROJECT, 'scripts', 'e2e-lan', 'lib'));
const puppeteer = require(path.join(PROJECT, 'node_modules', 'puppeteer'));

const OUT = path.join(L.WORK, 'capturas');
const PORT = Number(process.env.TC_PRUEBA_PORT) || 3489;
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
    server = L.startServer('venta-monto', { port: PORT, userData: USER_DATA, env: { DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME } });
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

    const entrar = async () => {
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
      await page.waitForSelector('#login-user', { timeout: 30000 });
      await page.evaluate(() => {
        document.getElementById('login-user').value = 'admin';
        document.getElementById('login-pass').value = '1234';
        return doLogin();
      });
      await page.waitForFunction(() => Boolean(typeof DB !== 'undefined' && DB.currentUser), { timeout: 30000 });
      await sleep(1500);
    };
    await entrar();

    const ids = await page.evaluate(async () => {
      const crear = async (p) => {
        const r = await fetch('/api/products', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken}` },
          body: JSON.stringify({ marca: '', estado: 'Activo', stockMin: 0, precioCompra: 1, ...p }) });
        const j = await r.json();
        if (!r.ok) throw new Error(`${p.nombre}: ${j.error}`);
        return j.id || j.product?.id || j.row?.id;
      };
      return {
        chuleta: await crear({ codigo: 'CHULETA', nombre: 'Chuleta ahumada', categoria: 'Carnes', unidad: 'lb', saleMode: 'peso', precioVenta: 160, stock: 50, aplicaItbis: false }),
        papa: await crear({ codigo: 'PAPA', nombre: 'Papa', categoria: 'Víveres', unidad: 'lb', saleMode: 'peso', precioVenta: 50, stock: 50, aplicaItbis: false }),
        res: await crear({ codigo: 'RES', nombre: 'Carne de res', categoria: 'Carnes', unidad: 'lb', saleMode: 'peso', precioVenta: 200, stock: 50, aplicaItbis: false }),
        queso: await crear({ codigo: 'QUESO', nombre: 'Queso de freír', categoria: 'Lácteos', unidad: 'lb', saleMode: 'peso', precioVenta: 300, stock: 20, aplicaItbis: true }),
        pan: await crear({ codigo: 'PAN', nombre: 'Pan de agua', categoria: 'Panadería', unidad: 'Unidad', saleMode: 'unidad', precioVenta: 10, stock: 100, aplicaItbis: false }),
      };
    });
    await entrar();

    const ponerOpcion = (activa) => page.evaluate(async (on) => {
      showModule('configuracion');
      await new Promise((r) => setTimeout(r, 800));
      document.getElementById('cfg-weight-total-edit').checked = on;
      await new Promise((resolve) => { saveConfig(resolve); setTimeout(resolve, 8000); });
      return Boolean(DB.config.weightTotalEditEnabled);
    }, activa);
    const linea = (i) => page.evaluate((idx) => {
      const it = DB.saleItems[idx];
      return it ? { nombre: it.nombre, qty: it.qty, precio: it.precio, total: it.total, montoFinal: it.montoFinal || null } : null;
    }, i);
    // Toca el Total de la línea, escribe y confirma con la tecla dada.
    const escribirTotal = async (idx, texto, tecla = 'Enter') => {
      await page.click(`#sale-item-total-${idx}`);
      await page.waitForSelector(`#sale-item-total-${idx} .sale-total-input`, { timeout: 5000 });
      await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
      await page.keyboard.type(texto);
      await page.keyboard.press(tecla);
      await sleep(400);
    };

    // Opción apagada (por defecto): el Total no se puede editar.
    L.check('La opción viene apagada', await page.evaluate(() => !DB.config.weightTotalEditEnabled));
    L.check('Se activa en Configuración → Facturación', await ponerOpcion(true) === true);
    await page.evaluate(() => showModule('ventas'));
    await sleep(1200);

    // Prueba 1: chuleta a 160/lb entra con 1 lb sin ventanas; total 180 → 1.13 lb.
    await page.evaluate((id) => addProductById(id), ids.chuleta);
    await sleep(600);
    const sinVentana = await page.evaluate(() => !document.querySelector('#sale-scale-modal, .modal-overlay.active #sale-scale-status'));
    const inicial = await linea(0);
    L.check('Sin báscula entra 1 lb sin ventanas', sinVentana && inicial?.qty === 1 && inicial.total === 160, JSON.stringify(inicial));
    await escribirTotal(0, '180');
    const p1 = await linea(0);
    await page.screenshot({ path: path.join(OUT, '1-chuleta-180.png') });
    L.check('Prueba 1: 160/lb, total 180 → 1.13 lb, precio sigue 160', p1.qty === 1.13 && p1.total === 180 && p1.precio === 160, JSON.stringify(p1));

    // Escape deja el valor anterior.
    await escribirTotal(0, '999', 'Escape');
    const esc = await linea(0);
    L.check('Escape cancela y deja 180', esc.total === 180 && esc.qty === 1.13, JSON.stringify(esc));

    // Prueba 6: varias ediciones seguidas.
    for (const t of ['175.50', '200', '99.99', '180']) await escribirTotal(0, t);
    const p6 = await linea(0);
    L.check('Prueba 6: varias ediciones terminan en 180 exacto', p6.total === 180 && p6.qty === 1.13, JSON.stringify(p6));

    // Pruebas 2 y 3.
    await page.evaluate((id) => addProductById(id), ids.papa);
    await sleep(500);
    await escribirTotal(1, '125');
    const p2 = await linea(1);
    L.check('Prueba 2: 50/lb, total 125 → 2.50 lb', p2.qty === 2.5 && p2.total === 125, JSON.stringify(p2));
    await page.evaluate((id) => addProductById(id), ids.res);
    await sleep(500);
    await escribirTotal(2, '100');
    const p3 = await linea(2);
    L.check('Prueba 3: 200/lb, total 100 → 0.50 lb', p3.qty === 0.5 && p3.total === 100, JSON.stringify(p3));

    // Prueba 8: con ITBIS el total ya lo incluye.
    await page.evaluate((id) => addProductById(id), ids.queso);
    await sleep(500);
    await escribirTotal(3, '236');
    const p8 = await linea(3);
    const itbisQueso = await page.evaluate(() => document.getElementById('sale-item-itbis-3')?.textContent);
    L.check('Prueba 8: queso con ITBIS, total 236 (ITBIS 36 incluido)', p8.total === 236 && /36\.00/.test(itbisQueso), JSON.stringify({ ...p8, itbisQueso }));

    // Prueba 5: producto por unidad sin edición especial.
    await page.evaluate((id) => addProductById(id), ids.pan);
    await sleep(500);
    const panEditable = await page.evaluate(() => Boolean(document.querySelector('#sale-item-total-4.sale-total-editable')));
    L.check('Prueba 5: el pan (por unidad) no tiene Total editable', panEditable === false);
    await page.screenshot({ path: path.join(OUT, '2-carrito.png') });

    // Prueba 7: cobrar y revisar lo guardado y el inventario.
    await page.evaluate(() => openBillingModal());
    await sleep(1200);
    await page.evaluate(() => setMontoExacto());
    await sleep(300);
    await page.evaluate(() => processSale('charge'));
    await sleep(3000);
    const factura = ventas.find((v) => v.status < 300)?.cuerpo?.sale?.id;
    const detalle = factura ? await page.evaluate(async (f) => (await fetch(`/api/sales/${encodeURIComponent(f)}/return-detail`, { headers: { Authorization: `Bearer ${DB.authToken}` } })).json(), factura) : null;
    const lineas = (detalle?.items || []).map((i) => ({ nombre: i.productName, qty: i.qty, precio: i.price, importe: i.lineTotal }));
    const stock = await page.evaluate(async () => {
      const j = await (await fetch('/api/products', { headers: { Authorization: `Bearer ${DB.authToken}` } })).json();
      const lista = Array.isArray(j) ? j : (j.products || j.items || []);
      return Object.fromEntries(lista.map((p) => [p.codigo, Number(p.stock)]));
    });
    const chuletaG = lineas.find((l) => l.nombre === 'Chuleta ahumada');
    L.check('La venta se guardó por 651.00 (180+125+100+236+10)', Number(detalle?.sale?.total) === 651, JSON.stringify(detalle?.sale || detalle).slice(0, 200));
    L.check('Chuleta guardada: 1.13 lb a 160 (precio intacto), importe 180', chuletaG && chuletaG.qty === 1.13 && chuletaG.precio === 160 && chuletaG.importe === 180, JSON.stringify(chuletaG));
    L.check('Prueba 7: inventario chuleta 50 → 48.87, papa 47.5, res 49.5', stock.CHULETA === 48.87 && stock.PAPA === 47.5 && stock.RES === 49.5, JSON.stringify(stock));

    // Seguridad: trampas contra el servidor. Primero se cierra el recibo de la
    // venta anterior, que queda encima del carrito.
    await page.evaluate(() => {
      try { if (typeof closeReceipt === 'function') closeReceipt(); } catch (_) { /* ya cerrado */ }
      try { if (typeof closeAllModals === 'function') closeAllModals(); } catch (_) { /* ya cerrado */ }
      DB.saleItems = [];
      showModule('ventas');
    });
    await sleep(800);
    await page.evaluate((id) => addProductById(id), ids.res);
    await sleep(500);
    await escribirTotal(0, '50');
    const enviar = (cambiar) => page.evaluate(async (fn) => {
      openBillingModal();
      await new Promise((r) => setTimeout(r, 800));
      setMontoExacto();
      const payload = buildSalePayload();
      // eslint-disable-next-line no-new-func
      new Function('payload', fn)(payload);
      payload.clientRequestId = `prueba-${Date.now()}-${Math.random()}`;
      try {
        const r = await api.createSale(payload);
        return { ok: true, factura: r?.sale?.id };
      } catch (e) {
        return { ok: false, error: e.message };
      } finally {
        // La venta se mandó a mano: la ventana de cobro sigue abierta encima.
        try { closeAllModals(); } catch (_) { /* ya cerrada */ }
        document.getElementById('modal-overlay')?.classList.add('hidden');
        DB.saleItems = [];
        showModule('ventas');
      }
    }, cambiar);
    const trampa = await enviar('payload.items[0].qty = 5;');
    const lineaTrampa = trampa.factura
      ? (await page.evaluate(async (f) => (await fetch(`/api/sales/${encodeURIComponent(f)}/return-detail`, { headers: { Authorization: `Bearer ${DB.authToken}` } })).json(), trampa.factura)).items[0]
      : null;
    L.check('Trampa: la caja manda 5 lb por RD$50 y el servidor guarda 0.25 lb', trampa.ok && lineaTrampa && lineaTrampa.qty === 0.25 && lineaTrampa.lineTotal === 50, JSON.stringify({ trampa, lineaTrampa }));

    await page.evaluate(() => { DB.saleItems = []; });
    await page.evaluate((id) => addProductById(id), ids.pan);
    await sleep(400);
    const unidad = await enviar('payload.items[0].montoFinal = 5;');
    L.check('Un total editado en un producto por unidad se rechaza', unidad.ok === false && /solo aplica a productos por peso/i.test(unidad.error || ''), JSON.stringify(unidad));

    // Prueba 4: con la opción apagada el Total vuelve a lo normal y el servidor no acepta totales editados.
    await page.evaluate(() => { DB.saleItems = []; });
    await page.evaluate((id) => addProductById(id), ids.res);
    await sleep(400);
    await escribirTotal(0, '60');
    L.check('Se apaga la opción', await ponerOpcion(false) === false);
    await page.evaluate(() => showModule('ventas'));
    await sleep(1000);
    const editableApagada = await page.evaluate(() => Boolean(document.querySelector('.sale-total-editable')));
    L.check('Prueba 4: apagada, el Total ya no se edita', editableApagada === false);
    const apagada = await enviar('');
    L.check('Apagada, el servidor rechaza un total editado', apagada.ok === false && /desactivado/i.test(apagada.error || ''), JSON.stringify(apagada));

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
