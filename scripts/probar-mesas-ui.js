'use strict';
const puppeteer = require('puppeteer');
const path = require('path');
(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.on('dialog', (dialog) => dialog.accept());
    page.on('pageerror', (e) => console.log('Error de página:', e.message));
    await page.setViewport({ width: 1366, height: 860 });
    await page.goto('http://127.0.0.1:3405', { waitUntil: 'networkidle2', timeout: 60000 });
    await page.evaluate(async () => {
      document.getElementById('login-user').value = 'demo';
      document.getElementById('login-pass').value = 'DemoMesas2026!';
      await doLogin();
    });
    await page.waitForFunction(() => typeof DB !== 'undefined' && DB.currentUser && document.getElementById('mesas-abrir') && !document.getElementById('mesas-abrir').classList.contains('hidden'), { timeout: 60000 });
    const carritoOriginal = await page.evaluate(() => JSON.stringify(DB.saleItems));
    await page.evaluate(() => Mesas.abrir());
    await page.waitForSelector('.mesas-figura');
    const mesaPrueba = await page.$$eval('.mesas-figura.is-available, .mesas-figura.is-occupied', (nodes) => nodes.find((n) => n.textContent.includes('PRUEBA-'))?.dataset.id);
    if (!mesaPrueba) throw new Error('Falta la mesa de prueba comercial; no se usará una mesa del usuario.');
    await page.click(`[data-id="${mesaPrueba}"]`);
    await page.waitForSelector('#mesas-cuenta-barra');
    if (await page.$$('#module-ventas').then((nodes) => nodes.length) !== 1) throw new Error('El POS se duplicó.');
    if (!await page.$('#mesas-consumo-ventana #module-ventas')) throw new Error('Falta la ventana independiente.');
    const filtrosOcultos = await page.$eval('#mesas-consumo-ventana .sales-catalog-filters', (el) => getComputedStyle(el).display === 'none');
    if (!filtrosOcultos) throw new Error('Siguen visibles los desplegables de filtros.');
    if (await page.$('#mesas-categorias button')) {
      await page.click('#mesas-categorias button');
      if (!await page.$('#mesas-categorias button[aria-pressed="true"]')) throw new Error('La categoría no se seleccionó.');
      await page.click('#mesas-categorias button[aria-pressed="true"]');
      if (await page.$('#mesas-categorias button[aria-pressed="true"]')) throw new Error('La categoría no se deseleccionó.');
    }
    await page.evaluate(() => addProductById(DB.productos[0].id));
    const versionEscritura = await page.evaluate(() => Mesas.cuentaActiva().version);
    await page.focus('#product-search');
    await page.keyboard.type('gpc');
    if (await page.evaluate(() => Mesas.cuentaActiva()?.version) !== versionEscritura) throw new Error('Se guardó la cuenta al escribir en el buscador.');
    if (await page.$eval('#receipt-overlay', (el) => !el.classList.contains('hidden'))) throw new Error('Se abrió la precuenta al escribir.');
    if (!await page.$eval('#product-search', (el) => el.value.includes('gpc'))) throw new Error('Los atajos interceptaron la escritura.');
    await page.evaluate(() => { document.getElementById('product-search').value = ''; renderSalesCatalog(); });
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('p');
    await page.waitForFunction(() => !document.getElementById('receipt-overlay').classList.contains('hidden'));
    const text = await page.$eval('#receipt-content', (e) => e.innerText);
    if (!text.includes('PENDIENTE DE PAGO')) throw new Error('Falta título de precuenta.');
    await page.screenshot({ path: path.resolve('runtime-data/demo-pos/precuenta-ui.png') });
    await page.evaluate(() => closeReceipt());
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('g');
    await page.waitForSelector('.mesas-pantalla');
    if (await page.$('#mesas-consumo-ventana')) throw new Error('La ventana no se cerró tras guardar.');
    if (!await page.$('#module-ventas .ventas-workspace .sale-order-panel')) throw new Error('No se restauró la venta normal.');
    if (await page.evaluate(() => JSON.stringify(DB.saleItems)) !== carritoOriginal) throw new Error('Cambió el carrito original.');
    await page.screenshot({ path: path.resolve('runtime-data/demo-pos/plano-ui.png') });
    await page.click(`[data-id="${mesaPrueba}"]`);
    await page.waitForSelector('#mesas-cuenta-barra');
    await page.screenshot({ path: path.resolve('runtime-data/demo-pos/consumo-ui.png') });
    await page.setViewport({ width: 1280, height: 720 });
    await page.evaluate(() => setTheme('light'));
    const centro = await page.$eval('.mesas-acciones-centrales', (el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; });
    if (Math.abs(centro - 640) > 2) throw new Error('Los botones no están centrados.');
    for (const id of ['mesas-guardar-consumo', 'mesas-precuenta', 'mesas-cobrar']) {
      const bounds = await page.$eval(`#${id}`, (el) => { const r = el.getBoundingClientRect(); return { bottom: r.bottom, right: r.right, top: r.top }; });
      if (bounds.bottom > 720 || bounds.right > 1280 || bounds.top < 0) throw new Error(`Botón fuera de pantalla: ${id}`);
    }
    await page.screenshot({ path: path.resolve('runtime-data/demo-pos/consumo-claro-ui.png') });
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('c');
    await page.waitForSelector('#monto-recibido', { visible: true });
    const versionAntes = await page.evaluate(() => Mesas.cuentaActiva().version);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('g');
    if (await page.evaluate(() => Mesas.cuentaActiva()?.version) !== versionAntes) throw new Error('El atajo de guardar actuó dentro del cobro.');
    await page.evaluate(async () => {
      document.getElementById('monto-recibido').value = '100000';
      await processSale('charge');
    });
    await page.waitForSelector('.mesas-pantalla');
    console.log('OK UI: cobro en panel existente y regreso al plano.');
    console.log('OK UI: login, abrir mesa, agregar producto, precuenta y guardar con regreso al plano.');
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
