// "¿Salir sin cobrar?" en la pantalla de cobro, con la app real (Chrome) y SQLite
// en una carpeta temporal: al salir NO debe registrarse ninguna venta, ni con el
// ratón ni con el teclado (Esc → Enter, Esc → Esc, Cancelar → clic).
// Uso: node scripts/ventas/probar-salir-sin-cobrar.js
// También: la serie B que se apaga en Configuración → Facturación y la tarjeta
// "Facturas" de Reportes.
/* global DB, doLogin, showModule, openBillingModal, closeAllModals, closeReceipt, renderSaleTable, openQuickSaleModal, openProductModal, repV2LoadAll, openCashCierreModal, CajaSegura, CierreObligatorio */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..', '..');
process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-salir-sin-cobrar');
const L = require(path.join(PROJECT, 'scripts', 'e2e-lan', 'lib'));
const puppeteer = require(path.join(PROJECT, 'node_modules', 'puppeteer'));

const OUT = path.join(L.WORK, 'capturas');
const PORT = Number(process.env.TC_PRUEBA_PORT) || 3488;
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
    server = L.startServer('salir', { port: PORT, userData: USER_DATA, env: { DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME, TECNO_CAJA_DEMO: '1', TECNO_CAJA_SYNC_URL: 'off' } });
    await L.waitHttp(PORT);
    await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja',
      businessName: 'Colmado Salir', adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@prueba.test',
      adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });
    const token = (await L.request(PORT, 'POST', '/api/login', { usuario: 'admin', password: '1234' })).body?.token;
    const p = await L.request(PORT, 'POST', '/api/products', {
      codigo: 'PRUEBA', nombre: 'prueba', precioVenta: 250, precioCompra: 100, stock: 100, stockMin: 0,
      categoria: 'General', unidad: 'Unidad', marca: '', estado: 'Activo', aplicaItbis: false,
    }, token);
    check('Producto creado', p.status < 300, `HTTP ${p.status}`);

    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    page.on('pageerror', (e) => problemas.push(`error de página: ${e.message}`));
    const ventas = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/sales') ventas.push(req.url());
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

    const abrirCobro = async () => {
      await page.click('#product-search', { clickCount: 3 });
      await page.keyboard.type('PRUEBA');
      await page.keyboard.press('Enter');
      await sleep(700);
      await page.evaluate(() => openBillingModal());
      await sleep(1200);
      // El cajero escribe con cuánto paga (queda "Cambios pendientes").
      await page.evaluate(() => {
        const input = document.getElementById('monto-recibido');
        if (input) { input.focus(); }
      });
      await page.keyboard.type('300');
      await sleep(400);
    };
    const estado = () => page.evaluate(() => ({
      cobroAbierto: Boolean(document.getElementById('cobro-shell')) && !document.getElementById('modal-overlay')?.classList.contains('hidden'),
      pregunta: Boolean(document.getElementById('billing-discard-guard') && !document.getElementById('billing-discard-guard').classList.contains('hidden')),
      carrito: (DB.saleItems || []).length,
    }));

    const escenarios = [
      ['Cancelar → clic en "Salir sin cobrar"', async () => {
        await page.evaluate(() => [...document.querySelectorAll('.cobro-footer button')].find((b) => /Cancelar/.test(b.textContent)).click());
        await sleep(400);
        await page.click('#billing-discard-guard .tc-btn--danger');
      }],
      ['Esc → clic en "Salir sin cobrar"', async () => {
        await page.keyboard.press('Escape');
        await sleep(400);
        await page.click('#billing-discard-guard .tc-btn--danger');
      }],
      ['Esc → Enter', async () => {
        await page.keyboard.press('Escape');
        await sleep(400);
        await page.keyboard.press('Enter');
      }],
      ['Esc → Esc', async () => {
        await page.keyboard.press('Escape');
        await sleep(400);
        await page.keyboard.press('Escape');
      }],
      ['Esc → Tab hasta "Salir sin cobrar" → Enter', async () => {
        await page.keyboard.press('Escape');
        await sleep(400);
        await page.focus('#billing-discard-guard .tc-btn--danger');
        await page.keyboard.press('Enter');
      }],
    ];
    for (const [nombre, accion] of escenarios) {
      await abrirCobro();
      const antes = ventas.length;
      await accion();
      await sleep(1500);
      const e = await estado();
      await page.screenshot({ path: path.join(OUT, `${nombre.replace(/[^a-z0-9]+/gi, '-')}.png`) });
      check(`${nombre}: no registra venta`, ventas.length === antes, `ventas enviadas: ${ventas.length - antes} · ${JSON.stringify(e)}`);
      if (nombre === 'Esc → Enter') {
        // Enter queda en "Seguir cobrando": el cobro sigue abierto con su producto.
        check('Esc → Enter: sigue en el cobro, con el producto', e.cobroAbierto && !e.pregunta && e.carrito === 1, JSON.stringify(e));
      }
      // Cerrar lo que haya quedado para el siguiente escenario.
      await page.evaluate(() => {
        if (typeof closeReceipt === 'function') { try { closeReceipt(); } catch (_) { /* nada */ } }
        if (typeof closeAllModals === 'function') closeAllModals(true, 'force');
        DB.saleItems = []; if (typeof renderSaleTable === 'function') renderSaleTable();
        showModule('ventas');
      });
      await sleep(600);
    }

    let final = await L.request(PORT, 'GET', '/api/products', null, token);
    let lista = Array.isArray(final.body) ? final.body : (final.body?.products || final.body?.productos || []);
    let stock = Number(lista.find((x) => x.codigo === 'PRUEBA')?.stock);
    check('La existencia no bajó', stock === 100, `existencia ${stock}`);

    // Lo normal sigue igual: Enter en el monto cobra.
    await abrirCobro();
    // Sin facturación electrónica en el negocio no sale el aviso de E32/E31.
    const aviso = await page.evaluate(() => {
      const el = document.getElementById('cobro-ecf-hint');
      return el ? { existe: true, oculto: el.classList.contains('hidden') } : { existe: false };
    });
    check('Cobro sin e-CF en el negocio: el aviso de E32/E31 queda oculto', aviso.existe && aviso.oculto, JSON.stringify(aviso));
    const antes = ventas.length;
    await page.keyboard.press('Enter');
    for (let i = 0; i < 40 && ventas.length === antes; i += 1) await sleep(250);
    await sleep(1500);
    final = await L.request(PORT, 'GET', '/api/products', null, token);
    lista = Array.isArray(final.body) ? final.body : (final.body?.products || final.body?.productos || []);
    stock = Number(lista.find((x) => x.codigo === 'PRUEBA')?.stock);
    check('Enter en el cobro (sin la pregunta) sigue cobrando', ventas.length === antes + 1 && stock === 99, `ventas ${ventas.length - antes}, existencia ${stock}`);
    // Producto rápido: el ITBIS viene apagado (lo marca el cajero si aplica).
    await page.evaluate(() => {
      if (typeof closeReceipt === 'function') { try { closeReceipt(); } catch (_) { /* nada */ } }
      closeAllModals(true, 'force');
      showModule('ventas');
      openQuickSaleModal();
    });
    await sleep(500);
    const rapido = await page.evaluate(() => ({
      itbis: document.getElementById('quick-sale-itbis')?.checked,
      foco: document.activeElement?.id,
    }));
    check('Producto rápido: "Aplicar ITBIS" viene apagado', rapido.itbis === false, JSON.stringify(rapido));
    await page.type('#quick-sale-name', 'Cable especial');
    await page.type('#quick-sale-price', '100');
    await page.evaluate(() => document.querySelector('#modal-footer .btn-primary').click());
    await sleep(500);
    const lineaRapida = await page.evaluate(() => DB.saleItems.map((i) => ({ nombre: i.nombre, total: Number(i.total) })));
    check('Producto rápido sin ITBIS: se cobra justo el precio escrito', lineaRapida.length === 1 && lineaRapida[0].total === 100, JSON.stringify(lineaRapida));
    await page.evaluate(() => { DB.saleItems = []; renderSaleTable(); });

    // Nuevo producto: el cursor empieza en el código de barras.
    await page.evaluate(() => { showModule('productos'); });
    await sleep(800);
    await page.evaluate(() => openProductModal());
    await sleep(800);
    const fichaFoco = await page.evaluate(() => document.activeElement?.id);
    check('Nuevo producto: el cursor empieza en el código', fichaFoco === 'mp-codigo', fichaFoco);
    await page.keyboard.type('7501234567890');
    await page.keyboard.press('Enter');
    await sleep(300);
    const trasEnter = await page.evaluate(() => document.activeElement?.id);
    check('Nuevo producto: Enter en el código pasa al nombre', trasEnter === 'mp-nombre', trasEnter);
    await page.evaluate(() => closeAllModals(true, 'force'));

    // Serie B: encendida sale en «Más»; apagada en Configuración → Facturación, no.
    const serieBEnCobro = async () => {
      await page.evaluate(() => { showModule('ventas'); });
      await sleep(500);
      await abrirCobro();
      const b = await page.evaluate(() => [...document.querySelectorAll('#cobro-doc-menu [data-preset]')].map((x) => x.dataset.preset));
      await page.evaluate(() => { closeAllModals(true, 'force'); DB.saleItems = []; renderSaleTable(); });
      await sleep(400);
      return b;
    };
    const conB = await serieBEnCobro();
    check('Serie B encendida (como siempre): B01/B02 salen en «Más»', conB.includes('B02') && conB.includes('B01'), conB.join(','));
    await page.evaluate(async () => {
      const r = await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken}` },
        body: JSON.stringify({ ...DB.config, cobroSerieB: false }) });
      DB.config = { ...DB.config, ...(await r.json()) };
    });
    const sinB = await serieBEnCobro();
    check('Serie B apagada: no sale ningún B en Cobrar (los E sí)', !sinB.some((t) => /^B/.test(t)) && sinB.includes('E44'), sinB.join(','));
    const guardado = await page.evaluate(() => DB.config.cobroSerieB);
    check('La opción queda guardada', guardado === false, String(guardado));

    // Reportes: la tarjeta "Facturas" da cuántas se hicieron (ticket, NCF y e-CF).
    await page.evaluate(() => {
      showModule('reportes', document.querySelector('.nav-item[data-module="reportes"]'));
      const periodo = document.getElementById('repv2-periodo'); if (periodo) periodo.value = 'hoy';
      repV2LoadAll();
    });
    await page.waitForFunction(() => Number((document.getElementById('kpi-num-facturas')?.textContent || '0').replace(/\D/g, '')) > 0, { timeout: 20000 }).catch(() => {});
    const tarjeta = await page.evaluate(() => ({ valor: document.getElementById('kpi-num-facturas')?.textContent, detalle: document.getElementById('kpi-facturas-detalle')?.textContent }));
    check('Reportes: la tarjeta "Facturas" dice cuántas se hicieron hoy', tarjeta.valor === '1' && /1 ticket/.test(tarjeta.detalle || '') && /Promedio/.test(tarjeta.detalle || ''), JSON.stringify(tarjeta));

    // Cerrar caja: primero avisa que termina el turno y se cierra la sesión.
    const avisoCierre = async (boton) => {
      await page.evaluate(() => { openCashCierreModal(); });
      await page.waitForSelector('.tc-form-modal-fondo', { timeout: 10000 });
      const texto = await page.evaluate(() => document.querySelector('.tc-form-modal-fondo')?.innerText || '');
      await page.click(`.tc-form-modal-fondo [data-action="${boton}"]`);
      await sleep(800);
      const modalCierre = await page.evaluate(() => !document.getElementById('cash-cierre-modal')?.classList.contains('hidden'));
      return { texto, modalCierre };
    };
    const cancelado = await avisoCierre('cancel');
    check('Cerrar caja: avisa que termina el turno y se cierra la sesión', /¿Cerrar la caja\?/.test(cancelado.texto) && /sesión se cerrará/.test(cancelado.texto), cancelado.texto.replace(/\s+/g, ' '));
    check('Cerrar caja → Cancelar: no abre el cierre', !cancelado.modalCierre);
    const aceptado = await avisoCierre('ok');
    check('Cerrar caja → "Sí, cerrar la caja": sigue al cierre', aceptado.modalCierre);
    // Ya es obligatorio: el cierre no tiene "Cancelar" ni X, y Esc no lo cierra.
    const sinSalida = await page.evaluate(() => {
      const modal = document.getElementById('cash-cierre-modal');
      return {
        cancelar: [...modal.querySelectorAll('button')].some((b) => /Cancelar/.test(b.textContent)),
        x: Boolean(modal.querySelector('.modal-card-close')),
      };
    });
    check('El cierre ya no tiene "Cancelar" ni X', !sinSalida.cancelar && !sinSalida.x, JSON.stringify(sinSalida));
    // Arqueo por denominaciones (desde el cierre): sin "Cancelar", sin X y Esc no lo cierra.
    await page.evaluate(() => { CajaSegura.abrirCierre(); });
    await page.waitForSelector('#cs-den-2000', { timeout: 15000 });
    await page.keyboard.press('Escape');
    await sleep(500);
    const arqueo = await page.evaluate(() => ({
      abierto: !document.getElementById('modal-overlay').classList.contains('hidden') && Boolean(document.getElementById('cs-den-2000')),
      botones: [...document.querySelectorAll('#modal-footer button')].map((b) => b.textContent.trim()),
      x: getComputedStyle(document.querySelector('#modal-box .modal-close')).display,
      ancho: Math.round(document.getElementById('modal-box').getBoundingClientRect().width),
      scroll: document.getElementById('modal-body').scrollHeight - document.getElementById('modal-body').clientHeight,
    }));
    check('Arqueo: Esc no lo cierra, sin "Cancelar" y sin X', arqueo.abierto && arqueo.botones.join('|') === 'Guardar conteo y cerrar la caja' && arqueo.x === 'none', JSON.stringify(arqueo));
    check('Arqueo: más angosto (≤ 760 px)', arqueo.ancho <= 760, `${arqueo.ancho} px · scroll ${arqueo.scroll} px`);
    await page.screenshot({ path: path.join(OUT, 'arqueo-cierre.png') });
    await page.evaluate(() => { CierreObligatorio.terminar(); closeAllModals(true, 'cierre-caja'); });

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
