// Prueba de la pantalla real (Chrome) de los combos promocionales contra un
// servidor de prueba en SQLite: crear el combo desde Promociones → Combos con
// imagen, verlo en el catálogo de Ventas, agregarlo al carrito (composición fija),
// tope de existencia, y factura agrupada / desglosada.
// Uso: node scripts/combos/probar-combos-ui.js   (capturas en la carpeta temporal)
/* global DB, _comboModal, addProductById, doLogin, getReceiptTemplateData, openComboModal,
   renderSalesCatalog, showModule, switchPromotionsTab, ventaToFormalDoc -- corren dentro de la página */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-combos-ui');
const L = require('../e2e-lan/lib');
const puppeteer = require(path.join(L.PROJECT, 'node_modules', 'puppeteer'));

const PORT = 3498;
const USER_DATA = path.join(L.WORK, 'pc-data');
const HOME = path.join(L.WORK, 'home');
const SHOTS = path.join(L.WORK, 'capturas');
const ENV = { DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let server = null;
  let browser = null;
  try {
    L.prepareSandbox();
    for (const dir of [USER_DATA, HOME, SHOTS]) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
    fs.mkdirSync(SHOTS, { recursive: true });
    server = L.startServer('combos-ui', { port: PORT, userData: USER_DATA, env: ENV });
    await L.waitHttp(PORT);
    await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja',
      businessName: 'Colmado Combos', adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@combos.test',
      adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });
    const login = await L.request(PORT, 'POST', '/api/login', { usuario: 'admin', password: '1234' });
    const token = login.body?.token;
    const branchId = login.body?.data?.sucursales?.[0]?.id;
    for (const [codigo, nombre, precio, costo, stock, itbis] of [
      ['POL', 'Pollo', 400, 250, 10, false], ['REF', 'Refresco', 100, 60, 7, true], ['PAP', 'Papas', 150, 80, 50, true],
    ]) {
      await L.request(PORT, 'POST', '/api/products', {
        codigo, barcode: codigo, nombre, categoria: 'GENERAL', unidad: 'Unidad', marca: '', precioVenta: precio, precioCompra: costo,
        stock, stockMin: 0, aplicaItbis: itbis, estado: 'Activo', branchId,
      }, token);
    }

    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 820 });
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#login-user', { timeout: 30000 });
    await page.evaluate(() => {
      document.getElementById('login-user').value = 'admin';
      const pass = document.getElementById('login-pass');
      if (pass) pass.value = '1234';
    });
    await page.evaluate(() => doLogin());
    await sleep(1500);
    await page.evaluate(() => {
      const pass = document.getElementById('login-pass');
      if (pass && !pass.value) pass.value = '1234';
      if (!(typeof DB !== 'undefined' && DB.currentUser)) return doLogin();
      return null;
    });
    await page.waitForFunction(() => Boolean((typeof DB !== 'undefined' && DB.currentUser)), { timeout: 30000 });
    L.check('UI: sesión iniciada', true);

    // ── Promociones → Combos promocionales ─────────────────────────────
    await page.evaluate(() => { showModule('promociones'); switchPromotionsTab('combos'); });
    await page.waitForSelector('#combos-list', { visible: true });
    await sleep(800);
    await page.screenshot({ path: path.join(SHOTS, '1-combos-vacio.png') });
    await page.evaluate(() => openComboModal());
    await page.waitForSelector('#combo-nombre', { visible: true });
    await page.type('#combo-nombre', 'Combo Familiar');
    await page.type('#combo-codigo', 'COMBO-FAM');
    for (const [buscar, veces] of [['Pollo', 1], ['Refresco', 2], ['Papas', 1]]) {
      await page.click('#combo-product-search', { clickCount: 3 });
      await page.type('#combo-product-search', buscar);
      await page.waitForSelector('.combo-picker-item');
      for (let i = 0; i < veces; i += 1) {
        await page.click('.combo-picker-item');
        if (i < veces - 1) { await page.type('#combo-product-search', buscar); await page.waitForSelector('.combo-picker-item'); }
      }
    }
    await page.type('#combo-precio', '600');
    const fileInput = await page.$('#combo-image-file');
    const pngPath = path.join(L.WORK, 'combo.png');
    fs.writeFileSync(pngPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAGklEQVR42mP8z8Dwn4EIwDiqkL4KGQYVAgAyswgB4hpiIwAAAABJRU5ErkJggg==', 'base64'));
    await fileInput.uploadFile(pngPath);
    await page.waitForFunction(() => Boolean((typeof _comboModal !== 'undefined' && _comboModal?.imageData)) || document.getElementById('combo-image-preview')?.src?.startsWith('data:'), { timeout: 10000 }).catch(() => {});
    await sleep(400);
    const totales = await page.$eval('#combo-totals', (el) => el.innerText.replace(/\s+/g, ' '));
    await page.screenshot({ path: path.join(SHOTS, '2-combo-formulario.png') });
    L.check('UI: el formulario calcula precio normal 750, ahorro 150 y avisa ITBIS mixto',
      /750/.test(totales) && /150/.test(totales) && /mezcla productos con ITBIS/.test(totales), totales.slice(0, 160));
    await page.click('#combo-save-btn');
    await page.waitForFunction(() => document.querySelectorAll('.combo-card').length === 1, { timeout: 15000 });
    await sleep(600);
    await page.screenshot({ path: path.join(SHOTS, '3-combo-creado.png') });
    const tarjeta = await page.$eval('.combo-card', (el) => el.innerText.replace(/\s+/g, ' '));
    L.check('UI: el combo queda en la lista con sus productos', /Combo Familiar/.test(tarjeta) && /2 × Refresco/.test(tarjeta), tarjeta.slice(0, 160));
    const conImagen = await page.$eval('.combo-card img', (img) => /\/uploads\//.test(img.getAttribute('src') || ''));
    L.check('UI: la imagen subida se ve en el módulo de combos', conImagen);

    // ── Ventas: catálogo y carrito ──────────────────────────────────────
    await page.evaluate(() => showModule('ventas'));
    await sleep(800);
    // Catálogo visual (vista dividida), donde se ven las tarjetas de productos.
    await page.evaluate(() => { const s = document.getElementById('product-search'); s.value = 'combo'; renderSalesCatalog(true); });
    await page.screenshot({ path: path.join(SHOTS, '4a-ventas.png') });
    const diag = await page.evaluate(() => ({
      tarjetas: document.querySelectorAll('.sales-product-card').length,
      resumen: document.getElementById('sales-catalog-summary')?.textContent,
      moduloVisible: !document.getElementById('module-ventas')?.classList.contains('hidden'),
      gridVisible: Boolean(document.getElementById('sales-catalog-grid')?.offsetParent),
      combos: DB.productos.filter((p) => p.tipoProducto === 'combo').map((p) => ({ id: p.id, estado: p.estado, comps: p.componentes?.length })),
    }));
    console.log('[diag]', JSON.stringify(diag));
    await page.waitForSelector('.sales-product-card', { timeout: 15000 });
    await sleep(500);
    const card = await page.$$eval('.sales-product-card', (cards) => cards.map((c) => c.innerText.replace(/\s+/g, ' ')).join(' | '));
    L.check('UI: el combo aparece en Ventas con la marca Combo, precio y disponibles', /Combo/.test(card) && /Disp: 3/.test(card) && /600/.test(card), card.slice(0, 160));
    const imgVentas = await page.$eval('.sales-product-card img', (img) => /\/uploads\//.test(img.getAttribute('src') || ''));
    L.check('UI: la imagen del combo se ve en la tarjeta de Ventas', imgVentas);
    await page.screenshot({ path: path.join(SHOTS, '4-ventas-catalogo.png') });
    for (let i = 0; i < 4; i += 1) await page.evaluate(() => { const c = DB.productos.find((p) => p.tipoProducto === 'combo'); return addProductById(c.id); });
    await sleep(400);
    const carrito = await page.evaluate(() => DB.saleItems.map((i) => ({ nombre: i.nombre, qty: i.qty, precio: i.precio })));
    L.check('UI: el combo entra como una sola línea y el tope es 3 (refrescos)', carrito.length === 1 && carrito[0].qty === 3 && carrito[0].precio === 600, JSON.stringify(carrito));
    const fila = await page.$eval('#sale-items tr', (tr) => tr.innerText.replace(/\s+/g, ' '));
    L.check('UI: la línea muestra lo que lleva el combo, sin controles para cambiarlo', /1 × Pollo/.test(fila) && /2 × Refresco/.test(fila), fila.slice(0, 160));
    await page.screenshot({ path: path.join(SHOTS, '5-ventas-carrito.png') });

    // ── Factura: agrupado y desglosado ──────────────────────────────────
    const ticket = async (modo) => page.evaluate((m) => {
      DB.config.comboInvoiceDisplay = m;
      const combo = DB.productos.find((p) => p.tipoProducto === 'combo');
      const venta = { id: 'FAC-PRUEBA', fecha: new Date().toISOString(), cajero: 'Admin', cliente: 'Consumidor Final', metodo: 'efectivo',
        items: [{ id: combo.id, codigo: combo.codigo, nombre: combo.nombre, qty: 2, precio: 600, total: 1200, itbis: 0,
          combo: { componentes: combo.componentes } }], subtotal: 1200, descuento: 0, itbis: 0, total: 1200, recibido: 1200, cambio: 0 };
      const data = getReceiptTemplateData(venta);
      const a4 = ventaToFormalDoc(venta).items[0];
      return { html: data.itemsMarkup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), a4 };
    }, modo);
    const agrupado = await ticket('agrupado');
    L.check('Factura agrupada: una sola línea, sin componentes', !/Refresco/.test(agrupado.html) && !agrupado.a4.nota, agrupado.html.slice(0, 120));
    const desglosado = await ticket('desglosado');
    L.check('Factura desglosada: componentes debajo sin precio (2 combos → 4 refrescos) y total 1,200',
      /4 x Refresco/.test(desglosado.html) && /2 x Pollo/.test(desglosado.html) && /Incluye: 2 x Pollo, 4 x Refresco, 2 x Papas/.test(desglosado.a4.nota || '') && desglosado.a4.total === 1200,
      `${desglosado.html.slice(0, 140)} · A4: ${desglosado.a4.nota}`);
    L.check('UI: sin errores de JavaScript', errores.length === 0, errores.join(' | '));
  } catch (error) {
    L.check('Sin errores inesperados', false, error.stack || error.message);
  } finally {
    if (browser) await browser.close();
    await L.stopServer(server);
    const fallas = L.results.filter((r) => !r.ok);
    console.log(`\nCapturas: ${SHOTS}`);
    console.log(`${L.results.length - fallas.length}/${L.results.length} comprobaciones OK`);
    process.exit(fallas.length ? 1 : 0);
  }
})();
