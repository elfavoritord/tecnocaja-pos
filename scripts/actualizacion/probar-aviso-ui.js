// La app real en Chrome con el aviso de actualización: el proceso principal de Electron se
// simula (no se instala nada). Uso: node scripts/actualizacion/probar-aviso-ui.js
/* global DB, addProductById, doLogin, openBillingModal, showModule -- corren en la página */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-aviso-ui');
const L = require('../e2e-lan/lib');
const puppeteer = require(path.join(L.PROJECT, 'node_modules', 'puppeteer'));

const PORT = 3461;
const USER_DATA = path.join(L.WORK, 'pc-data');
const HOME = path.join(L.WORK, 'home');
const CAPTURAS = path.join(L.WORK, 'capturas');
const check = L.check;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lo que hace el proceso principal, sin Electron. Los 10 minutos sin respuesta se acortan.
const simularEscritorio = `
  (() => {
    let oyente = null;
    window.simulado = { respuestas: [], instalaciones: [], resultadoInstalar: { ok: true } };
    window.novaDesktop = {
      updaterCheck: async () => ({ devMode: true }),
      updaterDownload: async () => ({ devMode: true }),
      updaterGetVersion: async () => ({ version: '1.6.8', isPackaged: true }),
      updaterOnEvent(cb) { const previo = oyente; oyente = (e, d) => { previo && previo(e, d); cb(e, d); }; return () => {}; },
      updaterPromptRespuesta: async (accion) => { window.simulado.respuestas.push(accion); return { ok: true }; },
      updaterInstall: async (o) => { window.simulado.instalaciones.push(o); return window.simulado.resultadoInstalar; },
    };
    window.simulado.emitir = (carga = {}) => oyente && oyente('prompt', { version: '1.6.9', ...carga });
    const setTimeoutReal = window.setTimeout;
    window.setTimeout = (fn, ms, ...resto) => setTimeoutReal(fn, ms === 600000 ? (window.simulado.tiempoSinRespuesta || 600000) : ms, ...resto);
  })();
`;

(async () => {
  let server = null;
  let browser = null;
  try {
    L.prepareSandbox();
    for (const dir of [USER_DATA, HOME, CAPTURAS]) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
    fs.mkdirSync(CAPTURAS, { recursive: true });
    server = L.startServer('aviso-ui', { port: PORT, userData: USER_DATA, env: { DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME } });
    await L.waitHttp(PORT);
    await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja',
      businessName: 'Colmado Prueba', adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@prueba.test',
      adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });
    const login = await L.request(PORT, 'POST', '/api/login', { usuario: 'admin', password: '1234' });
    const prod = await L.request(PORT, 'POST', '/api/products', {
      codigo: 'AGU', barcode: 'AGU', nombre: 'Agua', categoria: 'GENERAL', unidad: 'Unidad', marca: '', precioVenta: 100, precioCompra: 50,
      stock: 100, stockMin: 0, aplicaItbis: false, estado: 'Activo', branchId: login.body?.data?.sucursales?.[0]?.id,
    }, login.body?.token);
    const productoId = Number(prod.body?.product?.id || prod.body?.producto?.id || prod.body?.id || 0);

    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 820 });
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await page.evaluateOnNewDocument(simularEscritorio);
    await page.setRequestInterception(true);
    let operacionesServidor = { activas: 0, otrasCajas: 0 };
    let simularServidor = false;
    page.on('request', (req) => {
      if (simularServidor && new URL(req.url()).pathname === '/api/system/operaciones-activas') {
        return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(operacionesServidor) });
      }
      return req.continue();
    });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#login-user', { timeout: 30000 });
    await page.evaluate(() => { document.getElementById('login-user').value = 'admin'; document.getElementById('login-pass').value = '1234'; });
    await page.evaluate(() => doLogin());
    await sleep(1500);
    await page.evaluate(() => {
      const pass = document.getElementById('login-pass');
      if (pass && !pass.value) pass.value = '1234';
      if (!(typeof DB !== 'undefined' && DB.currentUser)) return doLogin();
      return null;
    });
    await page.waitForFunction(() => Boolean(typeof DB !== 'undefined' && DB.currentUser), { timeout: 30000 });
    await page.evaluate(() => showModule('ventas'));
    await sleep(1000);

    const emitir = (carga) => page.evaluate((c) => window.simulado.emitir(c), carga || {});
    const hayAviso = () => page.evaluate(() => Boolean(document.getElementById('upd-aviso')));
    const texto = () => page.evaluate(() => document.getElementById('upd-aviso')?.innerText || '');
    const respuestas = () => page.evaluate(() => window.simulado.respuestas.slice());
    const instalaciones = () => page.evaluate(() => window.simulado.instalaciones.slice());
    const limpiar = () => page.evaluate(() => { window.simulado.respuestas.length = 0; window.simulado.instalaciones.length = 0; });
    const vaciarVenta = () => page.evaluate(() => { DB.saleItems = []; });
    const conVenta = (id) => page.evaluate((p) => addProductById(p), id);

    // Mensaje tal cual, sin tapar la venta ni quitar el foco.
    await page.evaluate(() => document.getElementById('sales-search')?.focus?.());
    const focoAntes = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
    await emitir();
    await sleep(400);
    const mensaje = await texto();
    check('Título del aviso', mensaje.includes('¡Nueva actualización disponible!'), mensaje.slice(0, 80));
    check('Texto del aviso', mensaje.includes('Se ha descargado y preparado una nueva versión de Tecno Caja POS. Para aplicar las mejoras y correcciones, es necesario reiniciar el sistema.') && mensaje.includes('¿Desea reiniciar ahora?'));
    check('Los dos botones', mensaje.includes('Instalar y reiniciar') && mensaje.includes('Recordármelo más tarde'));
    check('No le quita el foco a la venta (lector de códigos)', (await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName)) === focoAntes);
    check('No tapa la pantalla', !(await page.$('#upd-aviso-fondo')));
    check('Avisa que se mostró', (await respuestas()).includes('mostrado'));
    await page.screenshot({ path: path.join(CAPTURAS, '1-aviso.png') });

    // Más tarde.
    await limpiar();
    await page.click('[data-upd="luego"]');
    await sleep(200);
    check('"Más tarde" lo quita y no reinicia', !(await hayAviso()) && (await instalaciones()).length === 0);
    check('"Más tarde" se lo dice al proceso principal', (await respuestas()).includes('posponer'));

    // Sin respuesta: se retira solo, sin reiniciar.
    await limpiar();
    await page.evaluate(() => { window.simulado.tiempoSinRespuesta = 300; });
    await emitir();
    await sleep(800);
    check('Sin respuesta se retira solo', !(await hayAviso()));
    check('Sin respuesta no reinicia', (await instalaciones()).length === 0);
    check('Sin respuesta queda para dentro de una hora', JSON.stringify(await respuestas()) === '["mostrado"]', JSON.stringify(await respuestas()));
    await page.evaluate(() => { window.simulado.tiempoSinRespuesta = 0; });

    // Con una venta en curso no se muestra.
    await limpiar();
    await conVenta(productoId);
    await sleep(200);
    await emitir();
    await sleep(400);
    check('Con una venta en curso no aparece', !(await hayAviso()) && (await respuestas()).length === 0);
    await page.evaluate(() => openBillingModal());
    await sleep(500);
    await emitir();
    await sleep(400);
    check('Con el cobro abierto no aparece', !(await hayAviso()));
    await page.evaluate(() => { document.querySelector('#modal-overlay').classList.add('hidden'); document.getElementById('modal-box').classList.remove('billing-modal'); });
    await vaciarVenta();

    // Aparece, empieza una venta: se retira y vuelve al quedar libre.
    await limpiar();
    await emitir();
    await sleep(300);
    check('Libre: aparece', await hayAviso());
    await conVenta(productoId);
    await sleep(2500);
    check('Empieza una venta: se retira solo', !(await hayAviso()) && (await respuestas()).includes('aplazar'), JSON.stringify(await respuestas()));
    await vaciarVenta();

    // Otra caja guardando en esta PC principal: no aparece.
    simularServidor = true;
    operacionesServidor = { activas: 1, otrasCajas: 2 };
    await emitir();
    await sleep(400);
    check('Otra caja guardando: no aparece', !(await hayAviso()));
    await emitir({ esTerminal: true });
    await sleep(400);
    check('En una terminal las ventas de otras cajas no la frenan', await hayAviso());
    await page.click('[data-upd="luego"]');

    // En la principal avisa que atiende otras cajas.
    operacionesServidor = { activas: 0, otrasCajas: 2 };
    await emitir();
    await sleep(400);
    check('La principal avisa de las otras cajas', /atiende a 2 cajas más/.test(await texto()), (await texto()).slice(0, 200));
    await page.screenshot({ path: path.join(CAPTURAS, '2-principal.png') });

    // Reiniciar con una venta: espera y reinicia sola al terminar, sin bloquear.
    await limpiar();
    await page.evaluate(() => { const b = document.querySelector('[data-upd="reiniciar"]'); DB.saleItems = [{ id: 1, qty: 1 }]; b.click(); });
    await sleep(400);
    check('Reiniciar con venta: espera', /Se reiniciará al terminar/.test(await texto()) && (await instalaciones()).length === 0, (await texto()).slice(0, 120));
    check('Mientras espera no tapa la pantalla', !(await page.$('#upd-aviso-fondo')));
    await page.screenshot({ path: path.join(CAPTURAS, '3-esperando.png') });
    await vaciarVenta();
    await sleep(2500);
    const hechas = await instalaciones();
    check('Al terminar la venta reinicia sola', hechas.length === 1 && hechas[0].comprobarOperaciones === true, JSON.stringify(hechas));
    check('Durante el cierre no se puede empezar otra venta', Boolean(await page.$('#upd-aviso-fondo')));
    await page.screenshot({ path: path.join(CAPTURAS, '4-reiniciando.png') });
    await page.evaluate(() => { document.getElementById('upd-aviso')?.remove(); document.getElementById('upd-aviso-fondo')?.remove(); });
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForFunction(() => Boolean(window.simulado));
    await sleep(1500);

    // Si no se pudo instalar: dice por qué y se puede seguir trabajando.
    await page.evaluate(() => { window.simulado.resultadoInstalar = { ok: false, error: 'No se pudo abrir el instalador.' }; window.simulado.emitir(); });
    await sleep(400);
    await page.click('[data-upd="reiniciar"]');
    await sleep(500);
    check('Si falla, dice el motivo', /No se pudo abrir el instalador/.test(await texto()), (await texto()).slice(0, 120));
    await page.click('[data-upd="cerrar"]');
    await sleep(200);
    check('Y se puede seguir trabajando', !(await hayAviso()) && !(await page.$('#upd-aviso-fondo')));

    // Otra caja entró justo antes de cerrar: vuelve a esperar.
    await page.evaluate(() => { window.simulado.resultadoInstalar = { ok: false, ocupado: true, error: 'x' }; window.simulado.emitir(); });
    await sleep(400);
    await page.click('[data-upd="reiniciar"]');
    await sleep(400);
    check('Otra caja entró a última hora: vuelve a esperar', /Se reiniciará al terminar/.test(await texto()) && !(await page.$('#upd-aviso-fondo')), (await texto()).slice(0, 100));
    await page.click('[data-upd="cancelar"]');
    await sleep(200);
    check('"No reiniciar todavía" lo cancela', !(await hayAviso()));

    // Noche y teléfono.
    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); window.simulado.emitir(); });
    await sleep(300);
    await page.screenshot({ path: path.join(CAPTURAS, '5-noche.png') });

    const propios = errores.filter((e) => /upd|actualiz|updater/i.test(e));
    check('Sin errores de página del aviso', propios.length === 0, JSON.stringify(propios));
    L.log(`Capturas: ${CAPTURAS}`);
  } catch (e) {
    check('Prueba completa', false, e.stack || e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await L.stopServer(server).catch(() => {});
  }
  const fallas = L.results.filter((r) => !r.ok);
  console.log(`\n${L.results.length - fallas.length}/${L.results.length} comprobaciones OK`);
  process.exit(fallas.length ? 1 : 0);
})();
