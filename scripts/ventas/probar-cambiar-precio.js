// Cambiar el precio de una línea con F3 (js/ventas.js → startSaleLinePriceEdit)
// en la app real, con SQLite en una carpeta temporal: elegir la fila, F3,
// escribir, Enter/Escape, la cantidad no cambia, se queda con ese precio al
// sumar más, ITBIS incluido, productos por peso intocables, cobro, lo guardado,
// la auditoría, que el precio quede en el producto (desde el 2026-11-23, también
// para el cajero) y que el servidor no acepte trampas.
// Uso: npm run test:cambiar-precio
/* global DB, doLogin, showModule, addProductById, openBillingModal, setMontoExacto, processSale,
   closeReceipt, closeAllModals, renderSalesCatalog, calculateCurrentSaleTotals, buildSalePayload, api */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..', '..');
process.env.TC_E2E_DIR = path.join(os.tmpdir(), 'tecnocaja-cambiar-precio');
const L = require(path.join(PROJECT, 'scripts', 'e2e-lan', 'lib'));
const puppeteer = require(path.join(PROJECT, 'node_modules', 'puppeteer'));

const OUT = path.join(L.WORK, 'capturas');
const PORT = Number(process.env.TC_PRUEBA_PORT) || 3486;
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
    server = L.startServer('cambiar-precio', { port: PORT, userData: USER_DATA, env: { DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME } });
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
          body: JSON.stringify({ marca: '', estado: 'Activo', stockMin: 0, precioCompra: 50, unidad: 'Unidad', saleMode: 'unidad', categoria: 'General', stock: 100, ...p }) });
        const j = await r.json();
        if (!r.ok) throw new Error(`${p.nombre}: ${j.error}`);
        return j.id || j.product?.id;
      };
      return {
        galletas: await crear({ codigo: 'GALLETAS', nombre: 'Galletas', precioVenta: 100, aplicaItbis: true }),
        refresco: await crear({ codigo: 'REFRESCO', nombre: 'Refresco', precioVenta: 118, aplicaItbis: true, itbisIncluido: true }),
        pollo: await crear({ codigo: 'POLLO', nombre: 'Pollo', precioVenta: 100, aplicaItbis: false, unidad: 'lb', saleMode: 'peso' }),
      };
    });
    // Sin báscula, el producto por peso entra con 1 lb si está encendido el
    // total editado (Configuración → Facturación).
    await page.evaluate(async () => {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken}` };
      const cfg = (await (await fetch('/api/bootstrap', { headers })).json()).config || {};
      await fetch('/api/config', { method: 'PUT', headers, body: JSON.stringify({ ...cfg, weightTotalEditEnabled: true }) });
    });
    await entrar();
    await page.evaluate(async () => {
      showModule('ventas');
      await new Promise((r) => setTimeout(r, 800));
    });

    const linea = (i) => page.evaluate((idx) => {
      const it = DB.saleItems[idx];
      return it ? { nombre: it.nombre, qty: it.qty, precio: it.precio, total: it.total, precioManual: it.precioManual ?? null } : null;
    }, i);
    const totales = () => page.evaluate(() => { const t = calculateCurrentSaleTotals(); return { itbis: t.itbis, total: t.total }; });
    const elegirFila = (idx) => page.click(`#sale-items tr[data-sale-row="${idx}"] .col-name`);
    // F3 sobre la fila elegida, escribe y confirma con la tecla dada.
    const cambiarPrecio = async (texto, tecla = 'Enter') => {
      await page.keyboard.press('F3');
      await page.waitForSelector('.sale-price-input', { timeout: 5000 });
      await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
      await page.keyboard.type(texto);
      await page.keyboard.press(tecla);
      await sleep(400);
    };

    // 1. Galletas x3, F3 → 90: la cantidad no cambia.
    await page.evaluate((id) => { addProductById(id); addProductById(id); addProductById(id); }, ids.galletas);
    await sleep(500);
    await elegirFila(0);
    await cambiarPrecio('90');
    const g1 = await linea(0);
    const tag = await page.evaluate(() => document.querySelector('#sale-items tr[data-sale-row="0"]')?.textContent.includes('Precio cambiado'));
    await page.screenshot({ path: path.join(OUT, '1-precio-cambiado.png') });
    L.check('F3: Galletas 3 a 90, la cantidad sigue en 3', g1.qty === 3 && g1.precio === 90 && g1.total === 318.6, JSON.stringify(g1));
    L.check('La línea dice "Precio cambiado"', tag === true);

    // 2. Escape deja el precio como estaba y no cancela la venta.
    await cambiarPrecio('50', 'Escape');
    const g2 = await linea(0);
    L.check('Escape deja 90 y la venta sigue', g2 && g2.precio === 90, JSON.stringify(g2));

    // 3. Sumar otra galleta conserva el precio cambiado.
    await page.evaluate((id) => addProductById(id), ids.galletas);
    await sleep(400);
    const g3 = await linea(0);
    L.check('Al sumar otra queda con ese precio: 4 a 90', g3.qty === 4 && g3.precio === 90, JSON.stringify(g3));

    // 4. ITBIS incluido: se escribe el precio final (118 → 100).
    await page.evaluate((id) => addProductById(id), ids.refresco);
    await sleep(400);
    await elegirFila(1);
    const valorInicial = await page.evaluate(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      const v = document.querySelector('.sale-price-input')?.value;
      document.querySelector('.sale-price-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return v;
    });
    await sleep(300);
    L.check('Con ITBIS incluido el campo trae el precio final (118.00)', valorInicial === '118.00', String(valorInicial));
    await elegirFila(1);
    await cambiarPrecio('100');
    const r1 = await linea(1);
    L.check('Refresco a 100 con ITBIS incluido: cobra 100', r1.total === 100 && r1.precioManual === 100, JSON.stringify(r1));

    // 5. Producto por peso: F3 no lo toca.
    await page.evaluate((id) => addProductById(id), ids.pollo);
    await sleep(600);
    await page.evaluate(() => {
      try { closeAllModals(); } catch (_) { /* sin ventana */ }
      document.getElementById('sale-scale-overlay')?.remove();
    });
    const idxPollo = await page.evaluate(() => DB.saleItems.findIndex((i) => i.nombre === 'Pollo'));
    if (idxPollo >= 0) {
      await elegirFila(idxPollo);
      await page.keyboard.press('F3');
      await sleep(400);
      const abierto = await page.evaluate(() => Boolean(document.querySelector('.sale-price-input')));
      const pollo = await linea(idxPollo);
      L.check('Producto por peso: F3 no abre el precio', !abierto && pollo.precio === 100, JSON.stringify(pollo));
      await page.evaluate((i) => { DB.saleItems.splice(i, 1); }, idxPollo);
      await page.evaluate(() => { renderSalesCatalog(); });
    } else {
      L.check('Producto por peso: entró al carrito', false, 'no entró');
    }

    const t = await totales();
    L.check('Total de la venta: 4×90×1.18 + 100 = 524.80', t.total === 524.8, JSON.stringify(t));

    // 6. Cobrar: el servidor guarda 90 (antes 100) y deja la auditoría.
    await page.evaluate(() => openBillingModal());
    await sleep(1200);
    await page.evaluate(() => setMontoExacto());
    await sleep(300);
    await page.evaluate(() => processSale('charge'));
    await sleep(3000);
    const venta = ventas.find((v) => v.status < 300)?.cuerpo?.sale;
    L.check('Venta guardada por 524.80', Number(venta?.total) === 524.8, JSON.stringify(venta || ventas).slice(0, 220));
    const detalle = venta ? await page.evaluate(async (f) => (await fetch(`/api/sales/${encodeURIComponent(f)}/return-detail`, { headers: { Authorization: `Bearer ${DB.authToken}` } })).json(), venta.id) : null;
    const gGuardada = (detalle?.items || []).find((i) => i.productName === 'Galletas');
    L.check('Galletas guardadas: 4 a 90', gGuardada && Number(gGuardada.qty) === 4 && Number(gGuardada.price) === 90, JSON.stringify(gGuardada));
    const auditoria = await page.evaluate(async () => (await (await fetch('/api/auditoria?pageSize=50', { headers: { Authorization: `Bearer ${DB.authToken}` } })).json()).eventos || []);
    // El cambio queda una vez, en el producto ("desde la venta", con el precio
    // de antes); la venta ya no lo repite porque el producto ya vale eso.
    const cambios = auditoria.filter((e) => /Precio cambiado (en|desde) la venta/.test(JSON.stringify(e)));
    L.check('Auditoría: 2 precios cambiados (Galletas y Refresco), una vez cada uno', cambios.length === 2
      && cambios.every((e) => /desde la venta/.test(JSON.stringify(e))), JSON.stringify(cambios.map((c) => c.accion || c.detalle || c.detail)).slice(0, 300));

    // 7. El precio quedó en el producto (Emilio, 2026-11-23): la próxima venta
    // ya sale con él, y el catálogo y la auditoría lo dicen.
    const enCatalogo = await page.evaluate(async (i) => {
      const j = await (await fetch('/api/products', { headers: { Authorization: `Bearer ${DB.authToken}` } })).json();
      const lista = Array.isArray(j) ? j : j.products;
      return { galletas: lista.find((p) => p.id === i.galletas)?.precioVenta, refresco: lista.find((p) => p.id === i.refresco)?.precioVenta };
    }, ids);
    L.check('El precio quedó en el producto: Galletas 90, Refresco 100 (precio final)', enCatalogo.galletas === 90 && enCatalogo.refresco === 100, JSON.stringify(enCatalogo));
    const guardados = await page.evaluate(async () => (await (await fetch('/api/auditoria?pageSize=50', { headers: { Authorization: `Bearer ${DB.authToken}` } })).json()).eventos || []);
    L.check('Auditoría: "Precio cambiado desde la venta" con el de antes', guardados.filter((e) => /Precio cambiado desde la venta/.test(JSON.stringify(e)) && /antes 100\.00/.test(JSON.stringify(e))).length === 1,
      JSON.stringify(guardados.filter((e) => /desde la venta/.test(JSON.stringify(e))).map((c) => c.detalle || c.detail)).slice(0, 300));
    await page.evaluate(() => {
      try { if (typeof closeReceipt === 'function') closeReceipt(); } catch (_) { /* ya cerrado */ }
      try { if (typeof closeAllModals === 'function') closeAllModals(); } catch (_) { /* ya cerrado */ }
      DB.saleItems = [];
      showModule('ventas');
    });
    await sleep(800);
    await page.evaluate((id) => addProductById(id), ids.galletas);
    await sleep(400);
    const nueva = await linea(0);
    L.check('Venta nueva: Galletas sale a 90, sin "precio cambiado"', nueva.precio === 90 && nueva.precioManual === null, JSON.stringify(nueva));

    // 8. Trampas contra el servidor.
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
        return { ok: true, factura: r?.sale?.id, total: r?.sale?.total };
      } catch (e) {
        return { ok: false, error: e.message };
      } finally {
        try { closeAllModals(); } catch (_) { /* ya cerrada */ }
        document.getElementById('modal-overlay')?.classList.add('hidden');
      }
    }, cambiar);
    const cero = await enviar('payload.items[0].precioManual = 0;');
    L.check('Precio 0 → el servidor lo rechaza', cero.ok === false && /no es válido/i.test(cero.error || ''), JSON.stringify(cero));
    const pollo = await page.evaluate((id) => ({ id }), ids.pollo);
    const peso = await enviar(`payload.items[0].id = ${pollo.id}; payload.items[0].nombre = 'Pollo'; payload.items[0].saleMode = 'peso'; payload.items[0].precioManual = 1;`);
    L.check('Precio cambiado en un producto por peso → rechazado', peso.ok === false && /no se puede cambiar/i.test(peso.error || ''), JSON.stringify(peso));

    // 9. El cajero también deja el precio en el producto y guarda productos
    // rápidos, aunque no pueda entrar a Productos.
    const sesionAdmin = await L.request(PORT, 'POST', '/api/login', { usuario: 'admin', password: '1234' });
    const adminToken = sesionAdmin.body?.token;
    const branchId = sesionAdmin.body?.data?.sucursales?.[0]?.id;
    const cashRegisterId = sesionAdmin.body?.data?.cajasSucursal?.[0]?.id;
    const alta = await L.request(PORT, 'POST', '/api/users', { nombre: 'Cajera Precio', usuario: 'cajera.precio', password: 'Cajera2026!', roleCode: 'cajero', estado: 'Activo', branchId, cashRegisterId }, adminToken);
    L.check('Cajera creada', alta.status === 201 || alta.status === 200, JSON.stringify(alta.body).slice(0, 200));
    const sesionCajera = await L.request(PORT, 'POST', '/api/login', { usuario: 'cajera.precio', password: 'Cajera2026!' });
    const tCajera = sesionCajera.body?.token;
    const precioCajera = await L.request(PORT, 'POST', `/api/products/venta/${ids.galletas}/precio`, { precio: 95 }, tCajera);
    L.check('Cajera: F3 deja Galletas en 95', precioCajera.status === 200 && precioCajera.body?.product?.precioVenta === 95, JSON.stringify(precioCajera.body).slice(0, 200));
    const pesoCajera = await L.request(PORT, 'POST', `/api/products/venta/${ids.pollo}/precio`, { precio: 1 }, tCajera);
    L.check('Cajera: un producto por peso no cambia de precio', pesoCajera.status === 400, JSON.stringify(pesoCajera.body));
    const rapido = await L.request(PORT, 'POST', '/api/products/venta/rapido', { nombre: 'Plátanos', precio: 25, aplicaItbis: false }, tCajera);
    L.check('Cajera: el producto rápido queda guardado (RAP-0001, sin existencia)', rapido.status === 201 && rapido.body?.product?.codigo === 'RAP-0001'
      && rapido.body.product.tracksStock === false && rapido.body.product.estado === 'Activo', JSON.stringify(rapido.body).slice(0, 220));
    const otraVez = await L.request(PORT, 'POST', '/api/products/venta/rapido', { nombre: 'plátanos', precio: 30 }, tCajera);
    L.check('Cajera: el mismo nombre otra vez usa el que ya está', otraVez.status === 200 && otraVez.body?.creado === false && otraVez.body.product?.id === rapido.body?.product?.id, JSON.stringify(otraVez.body).slice(0, 200));
    const directo = await L.request(PORT, 'POST', '/api/products', { codigo: 'X1', nombre: 'Por Productos', precioVenta: 5, categoria: 'General' }, tCajera);
    L.check('Cajera: Productos sigue cerrado para ella', directo.status === 403, String(directo.status));

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
