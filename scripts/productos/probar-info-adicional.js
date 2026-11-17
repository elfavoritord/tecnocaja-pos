// Información adicional del producto en la factura, con la app real (Chrome) y
// SQLite en una carpeta temporal:
//   1. la ficha del producto en pestañas y la pestaña Detalles con su vista previa;
//   2. Configuración → Facturación → "Descripciones adicionales en facturas";
//   3. vender: la línea guarda la copia, y el ticket (58/80 mm, ESC/POS) y la
//      factura A4 la muestran debajo del nombre;
//   4. cambiar el producto: la factura vieja se reimprime igual;
//   5. apagar la función: las ventas nuevas salen como siempre.
// Uso: npm run test:info-adicional
/* global DB, doLogin, showModule, openBillingModal, setMontoExacto, processSale, openProductModal,
   saveProduct, switchProductTab, setProductTaxMethod, syncConfigForm, saveConfig, buildThermalItemLines, getReceiptTemplateData,
   ventaToFormalDoc, buildEscposReceiptPayload -- corren en la página */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..', '..');
process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-info-adicional');
const L = require(path.join(PROJECT, 'scripts', 'e2e-lan', 'lib'));
const puppeteer = require(path.join(PROJECT, 'node_modules', 'puppeteer'));

const OUT = path.join(L.WORK, 'capturas');
const PORT = Number(process.env.TC_PRUEBA_PORT) || 3486;
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
    server = L.startServer('info-adicional', { port: PORT, userData: USER_DATA, env: { DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME, TECNO_CAJA_DEMO: '1', TECNO_CAJA_SYNC_URL: 'off' } });
    await L.waitHttp(PORT);
    await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'ferreteria', businessStructureMode: 'monocaja',
      businessName: 'Ferretería La Prueba', adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@prueba.test',
      adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });

    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    page.on('pageerror', (e) => problemas.push(`error de página: ${e.message}`));
    page.on('dialog', (d) => d.accept());
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
    const api = (url, opciones = {}) => page.evaluate(async (u, o) => {
      const r = await fetch(u, { ...o, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken}` } });
      return r.json();
    }, url, opciones);
    const productoPorCodigo = async (codigo) => {
      const j = await api('/api/products');
      return (Array.isArray(j) ? j : j.products).find((p) => p.codigo === codigo) || null;
    };

    // ── 1. Configuración: activar la función ─────────────────────────────────
    await page.evaluate(() => showModule('configuracion'));
    await sleep(1200);
    const configInicial = await page.evaluate(() => ({
      activo: document.getElementById('cfg-info-adicional-activo')?.checked,
      opcionesBloqueadas: document.getElementById('cfg-info-adicional-descripcion')?.disabled,
    }));
    check('Configuración: viene apagada y con las opciones bloqueadas', configInicial.activo === false && configInicial.opcionesBloqueadas === true, JSON.stringify(configInicial));
    await page.evaluate(async () => {
      const activo = document.getElementById('cfg-info-adicional-activo');
      activo.checked = true;
      activo.dispatchEvent(new Event('change'));
      await Promise.race([new Promise((resolve) => saveConfig(resolve)), new Promise((resolve) => setTimeout(resolve, 15000))]);
    });
    await sleep(1500);
    // Lo que devolvió el servidor al guardar (DB.config = respuesta de PUT /api/config).
    const infoCfg = await page.evaluate(() => DB.config?.infoAdicionalFactura || {});
    check('Configuración guardada: activa, con descripción, especificaciones y procedencia', infoCfg.activo === true && infoCfg.descripcion && infoCfg.especificaciones && infoCfg.procedencia && infoCfg.observaciones === false, JSON.stringify(infoCfg));

    // ── 2. La ficha del producto en pestañas ─────────────────────────────────
    await page.evaluate(() => showModule('productos'));
    await sleep(800);
    await page.evaluate(() => openProductModal());
    await sleep(800);
    const pestanas = await page.evaluate(() => [...document.querySelectorAll('.product-tab-btn')]
      .filter((b) => !b.classList.contains('hidden')).map((b) => b.textContent.trim()));
    check('Tres pestañas: General, Detalles y Opciones', pestanas.length === 3 && ['General', 'Detalles', 'Opciones'].every((p) => pestanas.some((tab) => tab.startsWith(p))), pestanas.join(' · '));
    const arriba = await page.evaluate(() => ['mp-codigo', 'mp-nombre', 'mp-categoria', 'mp-pcompra', 'mp-pventa', 'mp-stock', 'mp-stockmin', 'mp-unidad', 'mp-tax-method'].every((id) => {
      const el = document.getElementById(id);
      return el && el.closest('.product-tab-panel')?.id === 'product-tab-0';
    }));
    check('General reúne información, precio, impuestos e inventario', arriba);
    const taxModes = await page.evaluate(() => {
      document.getElementById('mp-pcompra').value = '85';
      document.getElementById('mp-pventa').value = '125';
      document.getElementById('mp-stock').value = '24';
      const result = {};
      for (const mode of ['exento', 'adicional', 'incluido', 'fijo']) {
        document.getElementById('mp-itbis-monto').value = '4';
        setProductTaxMethod(mode);
        result[mode] = document.getElementById('mp-final-preview').textContent;
      }
      setProductTaxMethod('incluido');
      result.base = document.getElementById('mp-base-preview').textContent;
      result.tax = document.getElementById('mp-tax-preview').textContent;
      result.unique = [...document.querySelectorAll('#modal-body [id]')].every((el, i, els) => els.findIndex((other) => other.id === el.id) === i);
      return result;
    });
    check('ITBIS: exento, adicional, incluido y fijo calculan el precio final', /125[.,]00/.test(taxModes.exento) && /147[.,]50/.test(taxModes.adicional) && /125[.,]00/.test(taxModes.incluido) && /129[.,]00/.test(taxModes.fijo), JSON.stringify(taxModes));
    check('ITBIS incluido: base 105.93 e impuesto 19.07', /105[.,]93/.test(taxModes.base) && /19[.,]07/.test(taxModes.tax));
    check('Campos sin identificadores duplicados', taxModes.unique);
    await page.screenshot({ path: path.join(OUT, '1-ficha-general.png') });
    await page.evaluate(() => {
      document.getElementById('mp-pcompra').value = '';
      document.getElementById('mp-pventa').value = '';
      document.getElementById('mp-stock').value = '0';
      document.getElementById('mp-itbis-monto').value = '';
      setProductTaxMethod('exento');
    });

    await page.type('#mp-codigo', 'MRT115');
    await page.type('#mp-nombre', 'Disco 115mm ultra fino porcelanato');
    await page.evaluate(() => switchProductTab(1));
    await page.type('#mp-pcompra', '500');
    await page.type('#mp-pventa', '850');
    await page.evaluate(() => { switchProductTab(2); document.getElementById('mp-stock').value = '20'; });
    await page.evaluate(() => switchProductTab(3));
    await sleep(300);
    const mostrarPorDefecto = await page.evaluate(() => document.getElementById('mp-info-mostrar')?.checked);
    check('Producto nuevo: "Mostrar en la factura" marcado (lo pide la configuración)', mostrarPorDefecto === true);
    await page.type('#mp-info-descripcion', 'Corte de porcelanato, Dekton, Neolith e Infinity.');
    await page.type('#mp-info-especificaciones', 'Corte de materiales de ingeniería.');
    await page.type('#mp-info-procedencia', 'China');
    await page.type('#mp-info-observaciones', 'Usar con protección.');
    await sleep(300);
    const vista = await page.evaluate(() => document.getElementById('mp-info-preview')?.innerText || '');
    check('Vista previa como en la factura', /Disco 115mm ultra fino porcelanato\s+MRT115\s+Corte de porcelanato[\s\S]*PROCEDENCIA: CHINA/.test(vista) && !/Usar con protección/.test(vista), vista.replace(/\n/g, ' | '));
    await page.screenshot({ path: path.join(OUT, '2-ficha-detalles.png') });
    await page.evaluate(() => saveProduct(null));
    await sleep(1500);
    let producto = await productoPorCodigo('MRT115');
    check('Producto guardado con su información adicional', producto?.infoAdicional?.procedencia === 'China'
      && producto.infoAdicional.descripcion === 'Corte de porcelanato, Dekton, Neolith e Infinity.'
      && producto.infoAdicional.mostrarEnFactura === true && producto.precioVenta === 850, JSON.stringify(producto?.infoAdicional));

    // Un producto sin información adicional, para la misma venta.
    await page.evaluate(() => openProductModal());
    await sleep(600);
    await page.type('#mp-codigo', 'TOR001');
    await page.type('#mp-nombre', 'Tornillo galvanizado');
    await page.evaluate(() => switchProductTab(1));
    await page.type('#mp-pventa', '15');
    await page.evaluate(() => { switchProductTab(2); document.getElementById('mp-stock').value = '100'; });
    await page.evaluate(() => saveProduct(null));
    await sleep(1500);

    // ── 2b. Tipo de ITBIS y descuento con la ficha nueva ─────────────────────
    const fichaItbis = async (codigo, metodo, precio, extra = async () => {}) => {
      await page.evaluate(() => openProductModal());
      await sleep(600);
      await page.type('#mp-nombre', `Prueba ITBIS ${metodo}`);
      await page.type('#mp-codigo', codigo);
      await page.type('#mp-pventa', String(precio));
      await page.select('#mp-tax-method', metodo);
      await extra();
      await sleep(200);
      const vista = await page.evaluate(() => ({
        base: document.getElementById('mp-base-preview')?.textContent.trim(),
        itbis: document.getElementById('mp-tax-preview')?.textContent.trim(),
        final: document.getElementById('mp-final-preview')?.textContent.trim(),
        tasa: document.getElementById('mp-tax-rate')?.value,
      }));
      await page.evaluate(() => saveProduct(null));
      await sleep(1300);
      return { vista, producto: await productoPorCodigo(codigo) };
    };
    const incluido = await fichaItbis('IT-INC', 'incluido', 118);
    check('ITBIS incluido: 118 se ve como 100 + 18 y se guarda como método 3', incluido.vista.base.includes('100.00') && incluido.vista.itbis.includes('18.00')
      && incluido.vista.final.includes('118.00') && incluido.producto?.aplicaItbis === true && incluido.producto?.itbisIncluido === true,
      `${JSON.stringify(incluido.vista)} · ${JSON.stringify({ aplica: incluido.producto?.aplicaItbis, incluido: incluido.producto?.itbisIncluido })}`);
    const sumado = await fichaItbis('IT-ADI', 'adicional', 100);
    check('ITBIS que se suma: 100 + 18 = 118 y se guarda como %', sumado.vista.final.includes('118.00') && sumado.producto?.aplicaItbis === true
      && sumado.producto?.itbisIncluido === false && sumado.producto?.itbisModo === 'porcentaje', `${JSON.stringify(sumado.vista)}`);
    const fijo = await fichaItbis('IT-FIJ', 'fijo', 150, async () => {
      await page.click('#mp-itbis-monto', { clickCount: 3 });
      await page.keyboard.type('20');
    });
    check('ITBIS fijo: RD$20 por unidad', fijo.producto?.aplicaItbis === true && fijo.producto?.itbisModo === 'monto' && fijo.producto?.itbisMonto === 20, JSON.stringify(fijo.producto && { modo: fijo.producto.itbisModo, monto: fijo.producto.itbisMonto }));
    const exento = await fichaItbis('IT-EXE', 'exento', 50, async () => {
      await page.evaluate(() => switchProductTab(4));
      await page.type('#mp-descuento', '10');
    });
    check('Sin ITBIS y con 10% de descuento (en Opciones)', exento.producto?.aplicaItbis === false && exento.producto?.descuentoPct === 10, JSON.stringify(exento.producto && { aplica: exento.producto.aplicaItbis, desc: exento.producto.descuentoPct }));
    const reabierto = await page.evaluate((id) => {
      openProductModal(id);
      return document.getElementById('mp-tax-method')?.value;
    }, incluido.producto?.id);
    check('Al abrir otra vez el producto, la ficha muestra "ITBIS incluido"', reabierto === 'incluido', String(reabierto));
    await page.keyboard.press('Escape');
    await sleep(500);

    // ── 3. Vender ────────────────────────────────────────────────────────────
    const vender = async (codigos) => {
      await page.evaluate(() => showModule('ventas'));
      await sleep(800);
      for (const codigo of codigos) {
        await page.click('#product-search', { clickCount: 3 });
        await page.keyboard.type(codigo);
        await page.keyboard.press('Enter');
        await sleep(700);
      }
      const antes = ventas.length;
      await page.evaluate(() => openBillingModal());
      await sleep(1200);
      await page.evaluate(() => setMontoExacto());
      await sleep(300);
      await page.evaluate(() => processSale('charge'));
      for (let i = 0; i < 40 && ventas.length === antes; i += 1) await sleep(250);
      await sleep(1000);
      const ultima = ventas[ventas.length - 1];
      if (ventas.length === antes || !ultima?.cuerpo?.sale) {
        const estado = await page.evaluate(() => ({
          carrito: (DB.saleItems || []).map((i) => i.codigo),
          avisos: [...document.querySelectorAll('.toast, [class*="toast"]')].map((t) => t.innerText).join(' | '),
        }));
        console.log(`[info-adicional] la venta no salió: ${JSON.stringify({ estado, respuesta: ultima })}`.slice(0, 800));
        await page.screenshot({ path: path.join(OUT, `venta-fallida-${ventas.length}.png`) });
      }
      return ultima?.cuerpo?.sale || null;
    };
    const venta1 = await vender(['MRT115', 'TOR001']);
    const disco1 = venta1?.items?.find((i) => i.codigo === 'MRT115');
    const tornillo1 = venta1?.items?.find((i) => i.codigo === 'TOR001');
    check('La línea del disco guarda la copia (sin observaciones, que están apagadas)', disco1?.infoAdicional?.procedencia === 'China'
      && disco1.infoAdicional.especificaciones === 'Corte de materiales de ingeniería.' && !disco1.infoAdicional.observaciones, JSON.stringify(disco1?.infoAdicional));
    check('La línea del tornillo (sin información) sale como siempre', tornillo1 && !tornillo1.infoAdicional, JSON.stringify(tornillo1));
    check('Totales sin cambios: 850 + 15', Number(venta1?.total) === 865, String(venta1?.total));

    const impreso = await page.evaluate(async (venta) => {
      const td = getReceiptTemplateData(venta);
      const ticket80 = buildThermalItemLines(td.normalizedItems, 48, '80mm');
      const ticket58 = buildThermalItemLines(td.normalizedItems, 32, '58mm');
      const a4 = window.FacturaPlantillas.render(ventaToFormalDoc(venta), { plantilla: 'clasica' });
      const escpos = await buildEscposReceiptPayload(venta, '80mm');
      const itemsEscpos = escpos.venta?.items || [];
      return { ticket80, ticket58, a4, escposDisco: itemsEscpos.find((i) => /Disco/.test(i.descripcion)), escposTornillo: itemsEscpos.find((i) => /Tornillo/.test(i.descripcion)) };
    }, venta1);
    const lineas80 = impreso.ticket80.map((l) => l.trim());
    check('Ticket 80 mm: código, descripción y PROCEDENCIA debajo del nombre', lineas80.includes('MRT115') && lineas80.includes('PROCEDENCIA: CHINA')
      && impreso.ticket80.every((l) => l.length <= 48), impreso.ticket80.join(' | '));
    check('Ticket 58 mm: partido al ancho, sin pasarse', impreso.ticket58.every((l) => l.length <= 32) && impreso.ticket58.some((l) => l.trim() === 'PROCEDENCIA: CHINA'), impreso.ticket58.join(' | '));
    check('Impresora térmica (ESC/POS): las líneas van con el disco y no con el tornillo', Array.isArray(impreso.escposDisco?.infoAdicional)
      && impreso.escposDisco.infoAdicional.includes('PROCEDENCIA: CHINA') && !(impreso.escposTornillo?.infoAdicional || []).length, JSON.stringify(impreso.escposDisco?.infoAdicional));
    check('Factura A4: las líneas debajo del nombre', impreso.a4.includes('MRT115<br>Corte de porcelanato, Dekton, Neolith e Infinity.<br>Corte de materiales de ingeniería.<br>PROCEDENCIA: CHINA'));
    fs.writeFileSync(path.join(OUT, '3-factura-a4.html'), `<!doctype html><meta charset="utf-8">${impreso.a4}`);
    await page.evaluate((venta) => window.showReceipt?.(venta), venta1);
    await sleep(1000);
    const reciboTexto = await page.evaluate(() => document.querySelector('#receipt-modal, .receipt-sheet, #modal-receipt')?.innerText || document.body.innerText);
    check('Recibo en pantalla: muestra la procedencia', /PROCEDENCIA: CHINA/.test(reciboTexto));
    await page.screenshot({ path: path.join(OUT, '3-recibo.png') });
    await page.keyboard.press('Escape');
    await sleep(500);

    // ── 4. Cambiar el producto: la factura vieja se reimprime igual ──────────
    await page.evaluate(() => showModule('productos'));
    await sleep(600);
    await page.evaluate((id) => openProductModal(id), producto.id);
    await sleep(700);
    await page.evaluate(() => switchProductTab(3));
    await page.click('#mp-info-procedencia', { clickCount: 3 });
    await page.keyboard.type('México');
    await page.evaluate((id) => saveProduct(id), producto.id);
    await sleep(1500);
    producto = await productoPorCodigo('MRT115');
    check('El producto ahora dice México', producto?.infoAdicional?.procedencia === 'México', JSON.stringify(producto?.infoAdicional));
    const reimpresion = await api(`/api/sales/${encodeURIComponent(venta1.id)}/receipt`);
    const ventaVieja = reimpresion.sale || reimpresion.venta || reimpresion;
    const discoViejo = (ventaVieja.items || []).find((i) => i.codigo === 'MRT115');
    check('Reimpresión de la factura vieja: sigue diciendo China', discoViejo?.infoAdicional?.procedencia === 'China', JSON.stringify(discoViejo?.infoAdicional));

    // ── 5. Apagar la función: las ventas nuevas salen como siempre ───────────
    await page.evaluate(() => showModule('configuracion'));
    await sleep(1000);
    await page.evaluate(async () => {
      const activo = document.getElementById('cfg-info-adicional-activo');
      activo.checked = false;
      activo.dispatchEvent(new Event('change'));
      await Promise.race([new Promise((resolve) => saveConfig(resolve)), new Promise((resolve) => setTimeout(resolve, 15000))]);
    });
    await sleep(1500);
    const venta2 = await vender(['MRT115']);
    const disco2 = venta2?.items?.find((i) => i.codigo === 'MRT115');
    const ticketApagado = await page.evaluate((venta) => buildThermalItemLines(getReceiptTemplateData(venta).normalizedItems, 48, '80mm'), venta2);
    check('Función apagada: la venta nueva no guarda copia y el ticket sale como siempre', disco2 && !disco2.infoAdicional
      && !ticketApagado.some((l) => /PROCEDENCIA|MRT115/.test(l)), ticketApagado.join(' | '));
    const reimpresion2 = await api(`/api/sales/${encodeURIComponent(venta1.id)}/receipt`);
    check('Apagada, la factura vieja igual se reimprime con lo que tenía', ((reimpresion2.sale || reimpresion2.venta || reimpresion2).items || [])
      .find((i) => i.codigo === 'MRT115')?.infoAdicional?.procedencia === 'China');

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
