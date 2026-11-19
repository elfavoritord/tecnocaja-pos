// ITBIS incluido en el precio final (método 3) en la app real, con SQLite en
// una carpeta temporal: Configuración → Impuestos (método para productos
// nuevos), la ficha del producto (vista previa base + ITBIS), la pantalla
// dividida de Ventas (precio final y refresco en vivo en otra caja), el carrito
// (118 → base 100 + ITBIS 18, cantidades, descuento), el cobro, lo guardado, la
// devolución y que los productos que ya existían no cambien.
// Uso: npm run test:itbis-incluido
/* global DB, doLogin, showModule, addProductById, openBillingModal, setMontoExacto, processSale, saveConfig,
   closeReceipt, closeAllModals, openProductModal, saveProduct, syncProductItbisFields, renderSalesCatalog,
   calculateCurrentSaleTotals, renderSaleTable, updateTotals */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..', '..');
process.env.TC_E2E_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tecnocaja-itbis-incluido-'));
const L = require(path.join(PROJECT, 'scripts', 'e2e-lan', 'lib'));
const puppeteer = require(path.join(PROJECT, 'node_modules', 'puppeteer'));

const OUT = path.join(L.WORK, 'capturas');
const PORT = Number(process.env.TC_PRUEBA_PORT) || 3487;
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
    server = L.startServer('itbis-incluido', { port: PORT, userData: USER_DATA, env: { DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME, TECNO_CAJA_DEMO: '1', TECNO_CAJA_SYNC_URL: 'off' } });
    await L.waitHttp(PORT);
    await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja',
      businessName: 'Colmado La Esquina', adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@prueba.test',
      adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });

    browser = await puppeteer.launch({ headless: true });
    // Dos cajas: A (donde se trabaja) y B (otra pantalla abierta en Ventas).
    const abrirCaja = async (nombre) => {
      const contexto = await browser.createBrowserContext();
      const page = await contexto.newPage();
      await page.setViewport({ width: 1366, height: 900 });
      page.on('pageerror', (e) => problemas.push(`${nombre}: error de página: ${e.message}`));
      return page;
    };
    const page = await abrirCaja('caja A');
    const ventas = [];
    page.on('response', async (res) => {
      if (res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/sales') {
        let cuerpo = null;
        try { cuerpo = await res.json(); } catch (_) { /* sin cuerpo */ }
        ventas.push({ status: res.status(), cuerpo });
      }
    });

    const entrar = async (p) => {
      await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
      await p.waitForSelector('#login-user', { timeout: 30000 });
      await p.evaluate(() => {
        document.getElementById('login-user').value = 'admin';
        document.getElementById('login-pass').value = '1234';
        return doLogin();
      });
      await p.waitForFunction(() => Boolean(typeof DB !== 'undefined' && DB.currentUser), { timeout: 30000 });
      await sleep(1500);
    };
    await entrar(page);

    // Productos que ya existían: ITBIS sumado al precio y sin ITBIS.
    const ids = await page.evaluate(async () => {
      const crear = async (p) => {
        const r = await fetch('/api/products', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken}` },
          body: JSON.stringify({ marca: '', estado: 'Activo', stockMin: 0, precioCompra: 1, unidad: 'Unidad', saleMode: 'unidad', categoria: 'General', ...p }) });
        const j = await r.json();
        if (!r.ok) throw new Error(`${p.nombre}: ${j.error}`);
        return j.id || j.product?.id;
      };
      return {
        viejo: await crear({ codigo: 'VIEJO', nombre: 'Galletas', precioVenta: 100, stock: 50, aplicaItbis: true }),
        exento: await crear({ codigo: 'ARROZ', nombre: 'Arroz', precioVenta: 40, stock: 50, aplicaItbis: false }),
      };
    });
    await entrar(page);

    // 1. Configuración → Impuestos: método para productos nuevos.
    const metodo = await page.evaluate(async () => {
      showModule('configuracion');
      await new Promise((r) => setTimeout(r, 800));
      const select = document.getElementById('cfg-itbis-metodo');
      const opciones = select ? [...select.options].map((o) => o.value) : [];
      select.value = 'incluido';
      await new Promise((resolve) => { saveConfig(resolve); setTimeout(resolve, 8000); });
      return { opciones, guardado: DB.config.itbisMetodoPredeterminado };
    });
    L.check('Configuración trae los 3 métodos', metodo.opciones.join() === 'adicional,fijo,incluido', metodo.opciones.join());
    L.check('Se guarda "Ya incluido" como método de productos nuevos', metodo.guardado === 'incluido', String(metodo.guardado));
    const bootstrapCfg = await page.evaluate(async () => (await (await fetch('/api/bootstrap', { headers: { Authorization: `Bearer ${DB.authToken}` } })).json()).config?.itbisMetodoPredeterminado);
    L.check('El servidor lo devuelve al volver a entrar', bootstrapCfg === 'incluido', String(bootstrapCfg));

    // 2. Ficha de un producto nuevo: viene con "Ya incluido" y muestra base + ITBIS.
    const ficha = await page.evaluate(async () => {
      showModule('productos');
      await new Promise((r) => setTimeout(r, 600));
      openProductModal();
      await new Promise((r) => setTimeout(r, 600));
      const marcadoInicial = document.getElementById('mp-itbis-modo-incluido')?.checked === true;
      document.getElementById('mp-codigo').value = 'REFRESCO';
      document.getElementById('mp-nombre').value = 'Refresco de uva';
      document.getElementById('mp-pcompra').value = '60';
      document.getElementById('mp-pventa').value = '118';
      document.getElementById('mp-stock').value = '50';
      document.getElementById('mp-aplica-itbis').checked = true;
      syncProductItbisFields();
      return {
        marcadoInicial,
        precio: document.getElementById('product-sale-price-preview')?.textContent,
        nota: document.getElementById('product-sale-price-note')?.textContent,
        aviso: getComputedStyle(document.getElementById('mp-itbis-incluido-hint')).display !== 'none',
      };
    });
    await page.screenshot({ path: path.join(OUT, '1-ficha-producto.png') });
    L.check('Producto nuevo viene con "Ya incluido en el precio"', ficha.marcadoInicial);
    L.check('Vista previa: se venderá en RD$118.00', /118\.00/.test(ficha.precio || ''), ficha.precio);
    L.check('Vista previa: base RD$100.00 + ITBIS RD$18.00', /Base RD\$100\.00 \+ ITBIS RD\$18\.00/.test(ficha.nota || ''), ficha.nota);
    L.check('Se ve el aviso del cálculo inverso', ficha.aviso);
    await page.evaluate(() => saveProduct(null));
    await page.waitForFunction(() => DB.productos.some((p) => p.codigo === 'REFRESCO'), { timeout: 15000 });
    await sleep(800);
    const guardado = await page.evaluate(async () => {
      const j = await (await fetch('/api/products', { headers: { Authorization: `Bearer ${DB.authToken}` } })).json();
      const lista = Array.isArray(j) ? j : (j.products || []);
      const de = (c) => lista.find((p) => p.codigo === c);
      return { refresco: de('REFRESCO'), viejo: de('VIEJO'), arroz: de('ARROZ') };
    });
    ids.refresco = guardado.refresco?.id;
    L.check('Refresco guardado con ITBIS incluido y precio 118', guardado.refresco?.itbisIncluido === true && Number(guardado.refresco?.precioVenta) === 118, JSON.stringify(guardado.refresco || {}).slice(0, 200));
    L.check('Los productos que ya existían no cambian', guardado.viejo?.itbisIncluido === false && guardado.arroz?.itbisIncluido === false && Number(guardado.viejo?.precioVenta) === 100);

    // Abrir y guardar la ficha de un producto viejo conserva su método.
    await page.evaluate((id) => openProductModal(id), ids.viejo);
    await page.waitForSelector('#mp-itbis-modo-pct', { timeout: 15000 });
    const editarViejo = page.waitForResponse((res) => res.request().method() === 'PUT'
      && new URL(res.url()).pathname === `/api/products/${ids.viejo}`, { timeout: 20000 });
    await page.evaluate((id) => { void saveProduct(id); }, ids.viejo);
    const respuestaViejo = await editarViejo;
    L.check('La ficha del producto existente se guarda', respuestaViejo.ok(), String(respuestaViejo.status()));
    await page.waitForSelector('#mp-itbis-modo-pct', { hidden: true, timeout: 15000 });
    const viejoTrasEditar = await page.evaluate((id) => DB.productos.find((p) => p.id === id), ids.viejo);
    L.check('Guardar la ficha de Galletas la deja con ITBIS sumado', viejoTrasEditar?.itbisIncluido === false && viejoTrasEditar?.aplicaItbis === true, JSON.stringify(viejoTrasEditar || {}).slice(0, 160));

    // 3. Precio de catálogo antes de agregar los productos al carrito.
    const precioTarjeta = (p, id) => p.evaluate((pid) => document.querySelector(`.sales-product-card[data-product-id="${pid}"] .sales-product-price`)?.textContent || null, id);
    const abrirVentasDividida = (p) => p.evaluate(async () => {
      showModule('ventas');
      await new Promise((r) => setTimeout(r, 800));
      DB.config.salesSplitViewEnabled = true;
      renderSalesCatalog();
      await new Promise((r) => setTimeout(r, 500));
    });
    await abrirVentasDividida(page);
    const tarjetas = {
      refresco: await precioTarjeta(page, ids.refresco),
      viejo: await precioTarjeta(page, ids.viejo),
      arroz: await precioTarjeta(page, ids.exento),
    };
    await page.screenshot({ path: path.join(OUT, '2-pantalla-dividida.png') });
    L.check('Pantalla dividida: Refresco (incluido) RD$118, no 139.24', /118\.00/.test(tarjetas.refresco || ''), JSON.stringify(tarjetas));
    L.check('Pantalla dividida: Galletas muestra el precio registrado de RD$100', /100\.00/.test(tarjetas.viejo || ''), JSON.stringify(tarjetas));
    L.check('Pantalla dividida: Arroz exento RD$40', /40\.00/.test(tarjetas.arroz || ''), JSON.stringify(tarjetas));

    const preciosCatalogo = () => page.evaluate((id) => {
      const gridPrice = document.querySelector(`.sales-product-card[data-product-id="${id}"] .sales-product-price`)?.textContent;
      _doSearchProduct('VIEJO');
      const searchPrice = document.querySelector('#search-dropdown .sri-price')?.textContent;
      _doSearchProduct('');
      const row = [...document.querySelectorAll('#products-tbody tr')]
        .find((item) => item.querySelector('.tc-cell-sub')?.textContent === 'VIEJO');
      return [gridPrice, searchPrice, row?.cells[2]?.textContent];
    }, ids.viejo);
    const guardarPrecioConItbis = (checked) => page.evaluate(async (enabled) => {
      const toggle = document.getElementById('cfg-tax-include-in-catalog-price');
      if (toggle.checked !== enabled) toggle.click();
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('No se guardó la opción de ITBIS del catálogo')), 10000);
        saveConfig(() => { clearTimeout(timeout); resolve(); });
      });
      const response = await fetch('/api/bootstrap', { headers: { Authorization: `Bearer ${DB.authToken}` } });
      return (await response.json()).config?.taxIncludeInCatalogPrice;
    }, checked);
    await page.evaluate(() => setProductsView('tabla'));
    const conItbis = await guardarPrecioConItbis(true);
    const preciosConItbis = await preciosCatalogo();
    L.check('La casilla activada se guarda y muestra RD$118 en tarjeta, buscador y tabla',
      conItbis === true && preciosConItbis.every((price) => /118\.00/.test(price || '')), JSON.stringify(preciosConItbis));
    const sinItbis = await guardarPrecioConItbis(false);
    const preciosSinItbis = await preciosCatalogo();
    L.check('La casilla desactivada se guarda y vuelve a mostrar RD$100',
      sinItbis === false && preciosSinItbis.every((price) => /100\.00/.test(price || '')), JSON.stringify(preciosSinItbis));

    // 4. Carrito: 118 → base 100 + ITBIS 18; cantidades y descuento.
    const carrito = () => page.evaluate(() => {
      const t = calculateCurrentSaleTotals();
      return { subtotal: t.subtotal, itbis: t.itbis, total: t.total, lineas: DB.saleItems.map((i) => ({ nombre: i.nombre, qty: i.qty, precio: i.precio, total: i.total })) };
    });
    await page.evaluate((id) => addProductById(id), ids.refresco);
    await sleep(500);
    const c1 = await carrito();
    L.check('Carrito: Refresco cobra 118 (base 100 + ITBIS 18)', c1.total === 118 && c1.itbis === 18 && c1.subtotal === 100, JSON.stringify(c1));
    await page.evaluate((id) => { addProductById(id); addProductById(id); }, ids.refresco);
    await sleep(500);
    const c3 = await carrito();
    L.check('Carrito: 3 refrescos = 354 (ITBIS 54, no se duplica)', c3.total === 354 && c3.itbis === 54, JSON.stringify(c3));
    await page.evaluate(() => {
      DB.saleItems[0].descuento = 10;
      if (typeof renderSaleTable === 'function') renderSaleTable();
      if (typeof updateTotals === 'function') updateTotals();
    });
    await sleep(300);
    const cDesc = await carrito();
    L.check('Carrito: 10% de descuento → 318.60 (nunca más que el precio)', cDesc.total === 318.6 && cDesc.itbis === 48.6, JSON.stringify(cDesc));
    await page.evaluate((id) => addProductById(id), ids.viejo);
    await sleep(400);
    const cMix = await carrito();
    L.check('Carrito: con Galletas (100 + 18%) suma 436.60', cMix.total === 436.6 && cMix.itbis === 66.6, JSON.stringify(cMix));
    await page.screenshot({ path: path.join(OUT, '3-carrito.png') });

    // 4b. "Mostrar los precios con ITBIS incluido en la venta": solo cambia lo
    //     que se ve (precio con ITBIS, sin columna ITBIS, resumen con el total).
    //     Se deja encendida para cobrar: la venta debe salir igual (paso 5).
    const pantalla = () => page.evaluate(() => {
      const visible = (n) => Boolean(n) && getComputedStyle(n).display !== 'none' && !n.closest('.hidden');
      const fila = (id) => document.getElementById(id)?.closest('.ventas-sum-row');
      const precios = {};
      document.querySelectorAll('#sale-items tr[data-sale-row]').forEach((tr) => {
        precios[tr.querySelector('.sale-item-name')?.textContent.trim()] = tr.querySelector('.sale-item-price')?.textContent.trim();
      });
      return {
        precios,
        columnaItbis: visible(document.querySelector('#module-ventas .sale-table th.col-itbis')),
        subtotal: visible(fila('ventas-sum-subtotal')),
        itbis: visible(fila('ventas-sum-itbis')),
        descuento: visible(fila('ventas-sum-descuento')) ? document.getElementById('ventas-sum-descuento').textContent : null,
        total: document.getElementById('ventas-total-value')?.textContent,
      };
    });
    const sinOpcion = await pantalla();
    L.check('Como siempre: Galletas a 100.00 con la columna ITBIS, subtotal e ITBIS en el resumen',
      sinOpcion.precios.Galletas === '100.00' && sinOpcion.columnaItbis && sinOpcion.subtotal && sinOpcion.itbis, JSON.stringify(sinOpcion));
    await page.evaluate(() => {
      DB.config.taxIncludeInProductPrice = true;
      DB.config.taxCalculateAtInvoiceEnd = false;
      renderSaleTable();
      updateTotals();
    });
    await sleep(300);
    const conOpcion = await pantalla();
    L.check('Precios con ITBIS: Refresco y Galletas a 118.00 en la línea', conOpcion.precios['Refresco de uva'] === '118.00' && conOpcion.precios.Galletas === '118.00', JSON.stringify(conOpcion.precios));
    L.check('Precios con ITBIS: sin la columna ITBIS ni subtotal/ITBIS en el resumen', !conOpcion.columnaItbis && !conOpcion.subtotal && !conOpcion.itbis, JSON.stringify(conOpcion));
    L.check('Precios con ITBIS: descuento 35.40 sobre los precios con ITBIS y el total sigue en 436.60',
      conOpcion.descuento === '-35.40' && conOpcion.total === '436.60', JSON.stringify({ descuento: conOpcion.descuento, total: conOpcion.total }));
    const cCon = await carrito();
    L.check('Precios con ITBIS: lo que se cobra no cambia (436.60, ITBIS 66.60)', cCon.total === 436.6 && cCon.itbis === 66.6, JSON.stringify(cCon));
    await page.screenshot({ path: path.join(OUT, '3b-carrito-precios-con-itbis.png') });

    // 5. Cobrar y revisar lo guardado.
    await page.evaluate(() => openBillingModal());
    await sleep(1200);
    await page.evaluate(() => setMontoExacto());
    await sleep(300);
    await page.evaluate(() => processSale('charge'));
    await sleep(3000);
    const venta = ventas.find((v) => v.status < 300)?.cuerpo?.sale;
    const factura = venta?.id;
    L.check('La venta se guardó por 436.60 con ITBIS 66.60', Number(venta?.total) === 436.6 && Number(venta?.itbis) === 66.6, JSON.stringify(venta || ventas).slice(0, 220));
    const detalle = factura ? await page.evaluate(async (f) => (await fetch(`/api/sales/${encodeURIComponent(f)}/return-detail`, { headers: { Authorization: `Bearer ${DB.authToken}` } })).json(), factura) : null;
    const lineaRefresco = (detalle?.items || []).find((i) => i.productName === 'Refresco de uva');
    L.check('Línea guardada: 3 a precio base 100, importe 300', lineaRefresco && Number(lineaRefresco.qty) === 3 && Number(lineaRefresco.price) === 100 && Number(lineaRefresco.lineTotal) === 300, JSON.stringify(lineaRefresco));

    // 6. Devolver 1 refresco: vuelve lo que pagó por él (118 − 10% = 106.20).
    const devolucion = await page.evaluate(async ({ f, item, pid }) => {
      const r = await fetch('/api/sales/return', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken}` },
        body: JSON.stringify({ invoiceNumber: f, reason: 'Prueba', refundCash: true, items: [{ saleItemId: item, productId: pid, qty: 1 }] }) });
      return { status: r.status, body: await r.json() };
    }, { f: factura, item: lineaRefresco?.id, pid: ids.refresco });
    const devuelto = Number(devolucion.body?.returnedAmount ?? NaN);
    L.check('Devolución de 1 refresco: 106.20 (ITBIS 16.20)', devolucion.status === 201 && Math.abs(devuelto - 106.2) < 0.005
      && Math.abs(Number(devolucion.body?.itbis) - 16.2) < 0.005, JSON.stringify(devolucion).slice(0, 260));

    // 7. Otra caja con la pantalla dividida abierta ve el precio nuevo sola.
    await page.evaluate(() => {
      try { if (typeof closeReceipt === 'function') closeReceipt(); } catch (_) { /* ya cerrado */ }
      try { if (typeof closeAllModals === 'function') closeAllModals(); } catch (_) { /* ya cerrado */ }
    });
    const cajaB = await abrirCaja('caja B');
    await entrar(cajaB);
    await abrirVentasDividida(cajaB);
    const antesB = await precioTarjeta(cajaB, ids.refresco);
    await page.evaluate(async (id) => {
      showModule('productos');
      await new Promise((r) => setTimeout(r, 500));
      openProductModal(id);
      await new Promise((r) => setTimeout(r, 600));
      document.getElementById('mp-pventa').value = '150';
      syncProductItbisFields();
      return saveProduct(id);
    }, ids.refresco);
    let despuesB = null;
    for (let i = 0; i < 20 && !/150\.00/.test(despuesB || ''); i += 1) {
      await sleep(250);
      despuesB = await precioTarjeta(cajaB, ids.refresco);
    }
    await cajaB.screenshot({ path: path.join(OUT, '4-caja-b-precio-nuevo.png') });
    L.check('Otra caja: la pantalla dividida pasa de 118 a 150 sin reiniciar', /118\.00/.test(antesB || '') && /150\.00/.test(despuesB || ''), JSON.stringify({ antesB, despuesB }));
    await page.evaluate(() => showModule('ventas'));
    await sleep(500);
    const precioA = await precioTarjeta(page, ids.refresco);
    L.check('La caja que lo cambió también lo ve', /150\.00/.test(precioA || ''), String(precioA));

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
