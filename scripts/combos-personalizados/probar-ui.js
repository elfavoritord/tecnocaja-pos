// Prueba de la pantalla real (Chrome) de los Combos personalizados contra un
// servidor de prueba en SQLite:
//   · apagado: no hay botón COMBOS, ni pestaña, ni casilla en Productos;
//   · activar en Configuración → Apariencia;
//   · crear combos y habilitar productos en Promociones → Combos personalizados;
//   · la casilla "Disponible para combos" en la ficha del producto;
//   · Ventas → COMBOS: elegir combo, buscar, filtrar por categoría, cantidades,
//     botón FINALIZAR bloqueado hasta el precio exacto, productos que se pasan;
//   · el carrito: encabezado del combo, líneas bloqueadas, producto suelto
//     aparte, editar y quitar el combo;
//   · cobrar con el payload real de la pantalla y la factura agrupada, con y
//     sin precios individuales (ticket, térmica ESC/POS y A4).
// Uso: node scripts/combos-personalizados/probar-ui.js   (capturas en la carpeta temporal)
/* global DB, doLogin, showModule, switchPromotionsTab, CombosPersonalizados, addProductById, openProductModal,
   closeAllModals, buildSalePayload, getReceiptTemplateData, buildEscposReceiptPayload, ventaToFormalDoc -- corren dentro de la página */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-combosp-ui');
const L = require('../e2e-lan/lib');
const puppeteer = require(path.join(L.PROJECT, 'node_modules', 'puppeteer'));

const PORT = 3501;
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
    server = L.startServer('combosp-ui', { port: PORT, userData: USER_DATA, env: ENV });
    await L.waitHttp(PORT);
    await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja',
      businessName: 'Comida Combos', adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@combosp.test',
      adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });
    const login = await L.request(PORT, 'POST', '/api/login', { usuario: 'admin', password: '1234' });
    const token = login.body?.token;
    const branchId = login.body?.data?.sucursales?.[0]?.id;
    for (const [codigo, nombre, categoria, precio, stock, aplicaItbis, itbisModo, itbisMonto] of [
      ['HAM', 'Hamburguesa', 'Comida', 84.75, 10, true, 'porcentaje', 0],   // 100.00
      ['PAP', 'Papas', 'Comida', 50, 10, false, 'porcentaje', 0],           // 50.00 exento
      ['REF', 'Refresco', 'Bebidas', 42.37, 10, true, 'porcentaje', 0],     // 50.00
      ['CER', 'Cerveza', 'Bebidas', 80, 10, true, 'monto', 20],             // 100.00 (ITBIS fijo)
      ['AGU', 'Agua', 'Bebidas', 25, 10, false, 'porcentaje', 0],
    ]) {
      await L.request(PORT, 'POST', '/api/products', {
        codigo, barcode: codigo, nombre, categoria, unidad: 'Unidad', marca: '', precioVenta: precio, precioCompra: 10,
        stock, stockMin: 0, aplicaItbis, itbisModo, itbisMonto, estado: 'Activo', branchId,
      }, token);
    }

    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 860 });
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

    // ── 1/2. Apagado: nada nuevo a la vista ─────────────────────────────
    await page.evaluate(() => showModule('ventas'));
    await page.waitForFunction(() => CombosPersonalizados.estado.cargado, { timeout: 15000 });
    const apagado = await page.evaluate(() => ({
      boton: !document.getElementById('ccp-ventas-btn')?.classList.contains('hidden'),
      tab: !document.getElementById('promo-tab-btn-combos-personalizados')?.classList.contains('hidden'),
    }));
    await page.evaluate(() => openProductModal(DB.productos.find((p) => p.nombre === 'Hamburguesa').id));
    await sleep(500);
    const casillaApagado = await page.evaluate(() => Boolean(document.getElementById('mp-combo-personalizado')));
    await page.evaluate(() => closeAllModals(true));
    L.check('1. Apagado: sin botón COMBOS, sin pestaña y sin casilla en Productos', !apagado.boton && !apagado.tab && !casillaApagado, JSON.stringify({ ...apagado, casillaApagado }));

    // ── Activar en Configuración → Apariencia ───────────────────────────
    await page.evaluate(() => showModule('configuracion'));
    await page.waitForSelector('#cfg-ccp-activo', { timeout: 15000 });
    await page.evaluate(() => document.getElementById('cfg-ccp-section').scrollIntoView({ block: 'center' }));
    await page.evaluate(() => document.getElementById('cfg-ccp-activo').click());
    await page.waitForFunction(() => CombosPersonalizados.estado.config.activo === true, { timeout: 15000 });
    await sleep(300);
    const opcionesVisibles = await page.evaluate(() => !document.getElementById('cfg-ccp-opciones').classList.contains('hidden'));
    await page.screenshot({ path: path.join(SHOTS, '1-apariencia.png') });
    L.check('1. Se activa en Apariencia y aparecen sus opciones', opcionesVisibles);

    const opciones = await page.evaluate(() => ({
      imagenes: Boolean(document.getElementById('cfg-ccp-imagenes')),
      cantidades: Boolean(document.getElementById('cfg-ccp-cantidades')),
      viejas: Boolean(document.getElementById('cfg-ccp-exacto') || document.getElementById('cfg-ccp-ocultar-precios')),
    }));
    L.check('1. Opciones: imágenes y cantidades; ya no hay "precio exacto" ni "ocultar precios"', opciones.imagenes && opciones.cantidades && !opciones.viejas, JSON.stringify(opciones));

    // ── Promociones → Combos personalizados ─────────────────────────────
    await page.evaluate(() => { showModule('promociones'); });
    await page.waitForFunction(() => !document.getElementById('promo-tab-btn-combos-personalizados').classList.contains('hidden'), { timeout: 15000 });
    await page.evaluate(() => switchPromotionsTab('combos-personalizados'));
    await page.waitForSelector('#ccp-lista', { visible: true });
    await page.evaluate(() => CombosPersonalizados.abrirFormulario());
    await page.waitForSelector('#ccp-nombre', { visible: true });
    await page.type('#ccp-nombre', 'Combo especial');
    await page.type('#ccp-precio', '500');
    await page.click('#ccp-guardar');
    await page.waitForFunction(() => [...document.querySelectorAll('#ccp-lista .combo-card-title')].some((el) => el.textContent === 'Combo especial'), { timeout: 15000 });
    L.check('3. Combo sugerido creado (opcional: nombre + precio de partida)', (await page.$$('#ccp-lista .ccp-card')).length === 1);
    for (const nombre of ['Hamburguesa', 'Papas', 'Refresco', 'Cerveza']) {
      await page.evaluate((n) => {
        const fila = [...document.querySelectorAll('.ccp-prod-row')].find((r) => r.querySelector('.ccp-prod-name')?.firstChild?.textContent.trim() === n);
        fila.querySelector('input').click();
      }, nombre);
      await page.waitForFunction((n) => CombosPersonalizados.estado.productoIds.has(DB.productos.find((p) => p.nombre === n).id), { timeout: 10000 }, nombre);
    }
    await sleep(300);
    await page.screenshot({ path: path.join(SHOTS, '2-promociones.png'), fullPage: true });
    L.check('2. Cuatro productos habilitados desde el panel', await page.evaluate(() => CombosPersonalizados.estado.productoIds.size === 4));

    await page.evaluate(() => openProductModal(DB.productos.find((p) => p.nombre === 'Hamburguesa').id));
    await page.waitForSelector('#mp-combo-personalizado', { timeout: 10000 });
    const casilla = await page.evaluate(() => document.getElementById('mp-combo-personalizado').checked);
    await page.evaluate(() => closeAllModals(true));
    await page.evaluate(() => openProductModal(DB.productos.find((p) => p.nombre === 'Agua').id));
    await page.waitForSelector('#mp-combo-personalizado', { timeout: 10000 });
    const casillaAgua = await page.evaluate(() => document.getElementById('mp-combo-personalizado').checked);
    await page.evaluate(() => closeAllModals(true));
    L.check('2. La ficha del producto muestra "Disponible para combos" (Hamburguesa sí, Agua no)', casilla === true && casillaAgua === false);

    // ── Recargar la app: entra por el auto-login con Ventas ya abierta ──
    // (sin showModule('ventas')). Sin la copia local, solo initApp() puede
    // traer la configuración: el botón COMBOS tiene que seguir ahí.
    await page.evaluate(() => { showModule('ventas'); localStorage.removeItem('tc-combos-personalizados-estado'); });
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForFunction(() => typeof DB !== 'undefined' && Boolean(DB.currentUser), { timeout: 30000 });
    const trasRecargar = await page.waitForFunction(
      () => !document.getElementById('ccp-ventas-btn').classList.contains('hidden'),
      { timeout: 15000 }
    ).then(() => true).catch(() => false);
    const porAutoLogin = await page.evaluate(() => document.getElementById('login-screen')?.style.display === 'none' || document.getElementById('login-screen')?.classList.contains('hidden'));
    await page.screenshot({ path: path.join(SHOTS, '2b-tras-recargar.png') });
    L.check('Recargar la app (auto-login): el botón COMBOS sigue activo', trasRecargar && porAutoLogin,
      JSON.stringify({ trasRecargar, porAutoLogin, activo: await page.evaluate(() => CombosPersonalizados.estado.config.activo) }));
    // Y con la copia local, el botón aparece desde que abre la página.
    await page.reload({ waitUntil: 'domcontentloaded' });
    const alAbrir = await page.evaluate(() => !document.getElementById('ccp-ventas-btn').classList.contains('hidden'));
    await page.waitForFunction(() => typeof DB !== 'undefined' && Boolean(DB.currentUser), { timeout: 30000 });
    L.check('Recargar otra vez: el botón aparece de una vez (copia local) sin esperar al servidor', alAbrir);

    // ── Ventas → COMBOS: precio libre ───────────────────────────────────
    // Que la app termine de arrancar (el botón visible de verdad en pantalla).
    await page.waitForFunction(() => document.getElementById('ccp-ventas-btn')?.offsetParent !== null, { timeout: 30000 });
    await sleep(800);
    await page.click('#ccp-ventas-btn');
    await page.waitForSelector('#ccp-precio-input', { visible: true });
    const pasoPrecio = await page.evaluate(() => ({
      bloqueado: document.getElementById('ccp-continuar').disabled,
      sugeridos: [...document.querySelectorAll('.ccp-combo-card .ccp-combo-name')].map((e) => e.textContent),
    }));
    L.check('Paso 1: se escribe el precio (no hay montos obligatorios) y los sugeridos son atajos',
      pasoPrecio.bloqueado && pasoPrecio.sugeridos.join(',') === 'Combo personalizado,Combo especial', JSON.stringify(pasoPrecio));
    await page.type('#ccp-precio-input', '300');
    await page.screenshot({ path: path.join(SHOTS, '3-precio.png') });
    await page.click('#ccp-continuar');
    await page.waitForSelector('.ccp-prod', { visible: true });
    const tarjetas = await page.evaluate(() => ({
      n: document.querySelectorAll('.ccp-prod').length,
      imagenes: document.querySelectorAll('.ccp-prod img').length,
      conMontos: [...document.querySelectorAll('.ccp-prod')].filter((c) => /RD\$|\d+\.\d{2}/.test(c.textContent)).length,
      bloqueado: document.getElementById('ccp-finalizar').disabled,
    }));
    L.check('Paso 2: tarjetas con la imagen del producto y sin precios ni montos encima',
      tarjetas.n === 4 && tarjetas.imagenes === 4 && tarjetas.conMontos === 0 && tarjetas.bloqueado, JSON.stringify(tarjetas));

    await page.type('#ccp-buscar', 'ham');
    await sleep(200);
    const busqueda = await page.$$eval('.ccp-prod .ccp-prod-title', (els) => els.map((e) => e.textContent));
    L.check('Buscar por nombre', busqueda.length === 1 && busqueda[0] === 'Hamburguesa', busqueda.join(','));
    const tocar = (n) => page.evaluate((x) => [...document.querySelectorAll('.ccp-prod')].find((c) => c.querySelector('.ccp-prod-title').textContent === x).querySelector('.ccp-prod-main').click(), n);
    await tocar('Hamburguesa');
    await tocar('Hamburguesa');
    await page.evaluate(() => CombosPersonalizados.buscar(''));
    await page.evaluate(() => [...document.querySelectorAll('.ccp-chip')].find((c) => c.textContent === 'Comida').click());
    await sleep(150);
    const comida = await page.$$eval('.ccp-prod .ccp-prod-title', (els) => els.map((e) => e.textContent).sort());
    L.check('Filtrar por categoría (Comida)', comida.join(',') === 'Hamburguesa,Papas', comida.join(','));
    await tocar('Papas');
    await page.evaluate(() => [...document.querySelectorAll('.ccp-chip')].find((c) => c.textContent === 'Todas').click());
    await sleep(150);
    const listo = await page.evaluate(() => ({
      pie: document.getElementById('ccp-pie').innerText.replace(/\s+/g, ' '),
      bloqueado: document.getElementById('ccp-finalizar').disabled,
      lista: [...document.querySelectorAll('.ccp-lineas li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
      normal: document.querySelector('.ccp-normal')?.textContent || '',
    }));
    await page.screenshot({ path: path.join(SHOTS, '4-selector.png') });
    L.check('Sin límites: FINALIZAR se habilita con los productos elegidos; el precio dice "ITBIS incluido"',
      !listo.bloqueado && /Precio del combo RD\$ 300\.00 · ITBIS incluido/.test(listo.pie) && listo.lista.join('|') === '2 x Hamburguesa|1 x Papas',
      JSON.stringify(listo));
    L.check('El cajero ve de referencia lo que valdría suelto (RD$250.01)', /250\.01/.test(listo.normal), listo.normal);
    await page.click('#ccp-finalizar');
    await sleep(400);

    // ── Carrito ─────────────────────────────────────────────────────────
    let filas = await page.evaluate(() => ({
      head: document.querySelector('#sale-items tr.sale-combo-head')?.innerText.replace(/\s+/g, ' '),
      qtyInputs: document.querySelectorAll('#sale-items tr.sale-combo-line .qty-input').length,
      total: document.getElementById('s-total').textContent,
      cantidades: DB.saleItems.reduce((acc, i) => ({ ...acc, [i.nombre]: (acc[i.nombre] || 0) + i.qty }), {}),
    }));
    await page.screenshot({ path: path.join(SHOTS, '5-carrito.png') });
    L.check('Carrito: el combo a RD$300 con ITBIS incluido; sus líneas bloqueadas y con las cantidades reales',
      /Combo personalizado/.test(filas.head || '') && /ITBIS incluido/.test(filas.head || '') && /300\.00/.test(filas.total)
        && filas.qtyInputs === 0 && filas.cantidades.Hamburguesa === 2 && filas.cantidades.Papas === 1,
      JSON.stringify(filas));

    // Segundo combo desde el sugerido (trae nombre y precio de partida).
    await page.click('#ccp-ventas-btn');
    await page.waitForSelector('#ccp-precio-input', { visible: true });
    await page.evaluate(() => [...document.querySelectorAll('.ccp-combo-card')].find((b) => /Combo especial/.test(b.textContent)).click());
    await sleep(150);
    const sugerido = await page.evaluate(() => ({ precio: document.getElementById('ccp-precio-input').value, nombre: document.getElementById('ccp-nombre-elegido').textContent }));
    L.check('El combo sugerido llena nombre y precio de partida (se puede cambiar)', sugerido.precio === '500.00' && sugerido.nombre === 'Combo especial', JSON.stringify(sugerido));
    await page.click('#ccp-continuar');
    await page.waitForSelector('.ccp-prod', { visible: true });
    await tocar('Cerveza');
    await tocar('Cerveza');
    await tocar('Refresco');
    await page.click('#ccp-finalizar');
    await sleep(300);
    filas = await page.evaluate(() => ({ combos: document.querySelectorAll('#sale-items tr.sale-combo-head').length, total: document.getElementById('s-total').textContent }));
    L.check('Varios combos en la misma venta (RD$300 + RD$500)', filas.combos === 2 && /800\.00/.test(filas.total), JSON.stringify(filas));

    // Editar el primero: cambiar el precio a RD$250.
    await page.evaluate(() => document.querySelector('#sale-items tr.sale-combo-head .sale-combo-btn').click());
    await page.waitForSelector('.ccp-prod', { visible: true });
    await page.evaluate(() => CombosPersonalizados.cambiarPrecio());
    await page.waitForSelector('#ccp-precio-input', { visible: true });
    await page.click('#ccp-precio-input', { clickCount: 3 });
    await page.type('#ccp-precio-input', '250');
    await page.click('#ccp-continuar');
    await page.waitForSelector('.ccp-prod', { visible: true });
    const editado = await page.evaluate(() => document.getElementById('ccp-finalizar').textContent.trim());
    await page.click('#ccp-finalizar');
    await sleep(300);
    filas = await page.evaluate(() => ({
      primero: document.querySelector('#sale-items tr.sale-combo-head')?.innerText.replace(/\s+/g, ' '),
      total: document.getElementById('s-total').textContent,
    }));
    L.check('Editar el combo: nuevo precio en el mismo lugar', /GUARDAR/.test(editado) && /250\.00/.test(filas.primero || '') && /750\.00/.test(filas.total), JSON.stringify(filas));

    // Quitar el combo especial completo (con la confirmación de la app).
    await page.evaluate(() => [...document.querySelectorAll('#sale-items tr.sale-combo-head')].find((tr) => /Combo especial/.test(tr.textContent)).querySelector('.sale-remove-btn').click());
    await page.waitForSelector('[data-action="ok"]', { visible: true });
    await page.click('[data-action="ok"]');
    await sleep(300);
    await page.evaluate(() => addProductById(DB.productos.find((p) => p.nombre === 'Papas').id));
    await sleep(200);
    filas = await page.evaluate(() => ({
      combos: document.querySelectorAll('#sale-items tr.sale-combo-head').length,
      sueltas: DB.saleItems.filter((i) => !i.comboPersonalizado).map((i) => `${i.qty} ${i.nombre}`),
      total: document.getElementById('s-total').textContent,
    }));
    L.check('Quitar un combo deja lo demás; una papa suelta va en su propia línea', filas.combos === 1 && filas.sueltas.join() === '1 Papas' && /300\.00/.test(filas.total), JSON.stringify(filas));

    // ── Cobrar con el payload real de la pantalla ───────────────────────
    const venta = await page.evaluate(async () => {
      let recibido = document.getElementById('monto-recibido');
      if (!recibido) {
        recibido = document.createElement('input');
        recibido.id = 'monto-recibido';
        recibido.type = 'hidden';
        document.body.appendChild(recibido);
      }
      recibido.value = '300';
      const payload = buildSalePayload();
      if (!payload) return { error: `buildSalePayload devolvió null: ${document.getElementById('toast')?.textContent || ''}` };
      const res = await fetch('/api/sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken}` },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      return { status: res.status, error: body.error, sale: body.sale };
    });
    L.check('La venta se cobra con lo que arma la pantalla (el servidor acepta el reparto)', venta.status === 201 && venta.sale?.total === 300,
      `HTTP ${venta.status} ${venta.error || ''} · total ${venta.sale?.total}`);

    const impresion = await page.evaluate(async (sale) => {
      const data = getReceiptTemplateData(sale);
      const escpos = await buildEscposReceiptPayload(sale, '80mm');
      const a4 = ventaToFormalDoc(sale);
      return {
        ticket: data.itemsMarkup.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' '),
        filas: data.normalizedItems.length,
        escpos: escpos.venta.items.map((i) => ({ d: i.descripcion, t: i.subtotal, iv: i.itbisTexto, c: i.componentes })),
        a4: a4.items.map((i) => ({ d: i.descripcion, total: i.total, nota: i.nota || '' })),
        resumen: escpos.venta.filasResumen,
      };
    }, venta.sale);
    L.check('Factura: el combo es un solo concepto a RD$250.00 con "Impuesto incluido" y lo que lleva, sin precios por producto',
      impresion.filas === 2 && /Combo personalizado 1 250\.00 250\.00/.test(impresion.ticket) && /Impuesto incluido: \d/.test(impresion.ticket)
        && /2 x Hamburguesa/.test(impresion.ticket) && !/Hamburguesa \d/.test(impresion.ticket),
      impresion.ticket.slice(0, 260));
    L.check('Térmica ESC/POS: fila del combo con ITBIS "Incl." y el impuesto incluido debajo',
      impresion.escpos[0].d === 'Combo personalizado' && impresion.escpos[0].t === 250 && impresion.escpos[0].iv === 'Incl.'
        && (impresion.escpos[0].c || []).some((c) => /^Impuesto incluido\s+\d/.test(c)),
      JSON.stringify(impresion.escpos[0]));
    L.check('Factura A4: "Combo personalizado · Impuesto incluido" a RD$250.00 con el ITBIS incluido en la nota',
      /Impuesto incluido/.test(impresion.a4[0].d) && impresion.a4[0].total === 250 && /ITBIS incluido: RD\$ \d/.test(impresion.a4[0].nota),
      JSON.stringify(impresion.a4[0]));
    L.check('Los totales fiscales salen de las líneas reales (ITBIS de la venta)',
      JSON.stringify(impresion.resumen).includes(Number(venta.sale.itbis).toFixed(2)), `${JSON.stringify(impresion.resumen)} · ITBIS venta ${venta.sale.itbis}`);

    // ── Apagar: el botón desaparece ─────────────────────────────────────
    await page.evaluate(() => CombosPersonalizados.guardarOpcion('activo', false));
    await page.waitForFunction(() => document.getElementById('ccp-ventas-btn').classList.contains('hidden'), { timeout: 10000 });
    L.check('Al desactivar, el botón COMBOS desaparece de Ventas', true);
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
