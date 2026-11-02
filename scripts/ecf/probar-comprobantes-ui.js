// Prueba la app real en Chrome: Configuración → Ventas y Facturación → Comprobantes enviados
// a la DGII, dentro de la ventana de Configuración y con clics de verdad. Los comprobantes
// y las respuestas de la DGII son simulados. Nada se envía a la DGII.
// Uso: node scripts/ecf/probar-comprobantes-ui.js   (capturas en la carpeta temporal)
/* global DB, doLogin, showModule -- corren dentro de la página */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-comprobantes-ui');
const L = require('../e2e-lan/lib');
const puppeteer = require(path.join(L.PROJECT, 'node_modules', 'puppeteer'));

const PORT = 3497;
const USER_DATA = path.join(L.WORK, 'pc-data');
const HOME = path.join(L.WORK, 'home');
const SHOTS = path.join(L.WORK, 'capturas');
const ENV = { DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME };
const ENLACE = 'https://ecf.dgii.gov.do/eCF/ConsultaTimbre?ENCF=E310000000005';
const XML = '<?xml version="1.0"?><ECF><Encabezado><IdDoc><eNCF>E310000000005</eNCF></IdDoc></Encabezado></ECF>';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const base = { tipoNombre: 'Factura de Crédito Fiscal Electrónica', tipoEcf: 'E31', comprador: 'Cliente SRL', rncComprador: '131880681', montoTotal: 1.18, fecha: '2026-11-01 15:28:58', ambiente: 'ecf', tieneXml: true, mensajes: [] };
const DOCUMENTOS = [
  { ...base, id: 214, encf: 'E310000000005', estado: 'aceptado', grupo: 'aceptado', trackId: 'track-214', factura: 'FAC-000036', enlace: ENLACE },
  { ...base, id: 213, encf: 'E310000000003', estado: 'rechazado', grupo: 'rechazado', trackId: 'track-213', factura: 'FAC-000035', enlace: '', mensajes: [{ codigo: '176', texto: 'Campo no válido' }] },
];

(async () => {
  let server = null;
  let browser = null;
  try {
    L.prepareSandbox();
    for (const dir of [USER_DATA, HOME, SHOTS]) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
    fs.mkdirSync(SHOTS, { recursive: true });
    server = L.startServer('comprobantes-ui', { port: PORT, userData: USER_DATA, env: ENV });
    await L.waitHttp(PORT);
    await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja',
      businessName: 'Colmado Prueba', adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@prueba.test',
      adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });

    browser = await puppeteer.launch({ headless: true });
    await browser.defaultBrowserContext().overridePermissions(`http://127.0.0.1:${PORT}`, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 760 });
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));

    const pedidos = [];
    let simular = false;
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const { pathname, search } = new URL(req.url());
      const responder = (body, contentType = 'application/json') => req.respond({ status: 200, contentType, body: typeof body === 'string' ? body : JSON.stringify(body) });
      if (simular && pathname.startsWith('/api/ecf/')) pedidos.push(`${req.method()} ${pathname}${search}`);
      if (simular && pathname === '/api/ecf/comprobantes') {
        return responder({ total: 2, pagina: 1, paginas: 2, documents: DOCUMENTOS, resumen: { total: 2, aceptado: 1, condicional: 0, rechazado: 1, proceso: 0, sinEnviar: 0 } });
      }
      if (simular && pathname.endsWith('/status')) return responder({ estado: 'aceptado' });
      if (simular && pathname.endsWith('/xml')) return responder(XML, 'application/xml');
      if (simular && pathname.endsWith('/resend')) return responder({ ok: true, estado: 'enviado', encf: 'E310000000006' });
      return req.continue();
    });

    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#login-user', { timeout: 30000 });
    await page.evaluate(() => {
      document.getElementById('login-user').value = 'admin';
      document.getElementById('login-pass').value = '1234';
    });
    await page.evaluate(() => doLogin());
    await sleep(1500);
    await page.evaluate(() => {
      const pass = document.getElementById('login-pass');
      if (pass && !pass.value) pass.value = '1234';
      if (!(typeof DB !== 'undefined' && DB.currentUser)) return doLogin();
      return null;
    });
    await page.waitForFunction(() => Boolean(typeof DB !== 'undefined' && DB.currentUser), { timeout: 30000 });
    await page.evaluate(() => {
      window.enlacesAbiertos = [];
      window.novaDesktop = { ...(window.novaDesktop || {}), openExternal: async (url) => { window.enlacesAbiertos.push(url); return { ok: true }; } };
    });
    simular = true;

    const clicTexto = async (texto, raiz = 'body') => {
      const manejador = await page.evaluateHandle((t, r) => {
        const visibles = [...document.querySelector(r).querySelectorAll('button, [class*="card"], [class*="item"], [class*="row"]')]
          .filter((el) => el.offsetParent !== null && el.innerText && el.innerText.trim().startsWith(t));
        return visibles[visibles.length - 1] || null;
      }, texto, raiz);
      const el = manejador.asElement();
      if (!el) throw new Error(`No encontré "${texto}" en ${raiz}`);
      await el.click();
    };

    await page.evaluate(() => showModule('configuracion'));
    await sleep(1500);
    await clicTexto('Ventas y Facturación');
    await sleep(500);
    await clicTexto('Comprobantes enviados a la DGII');
    await page.waitForSelector('#cfg-group-modal-body .ecfd-fila', { visible: true, timeout: 15000 });
    await page.screenshot({ path: path.join(SHOTS, '1-lista.png') });
    L.check('La lista está dentro de la ventana de Configuración', true);

    await clicTexto('Ver en la DGII', '[data-id="214"]');
    await sleep(200);
    L.check('Ver en la DGII abre el enlace', (await page.evaluate(() => window.enlacesAbiertos))[0] === ENLACE);

    await clicTexto('Copiar enlace', '[data-id="214"]');
    await sleep(200);
    L.check('Copiar enlace lo copia', (await page.evaluate(() => navigator.clipboard.readText())) === ENLACE);

    await clicTexto('Ver XML', '[data-id="214"]');
    await page.waitForSelector('#ecfd-xml[open]', { timeout: 5000 });
    await sleep(200);
    const xml = await page.$eval('#ecfd-xml-texto', (e) => e.textContent);
    L.check('Ver XML muestra el XML', xml.includes('<eNCF>E310000000005</eNCF>'), xml.slice(0, 120));
    await page.screenshot({ path: path.join(SHOTS, '2-xml.png') });
    await page.click('#ecfd-xml-copiar');
    await sleep(150);
    L.check('Copiar el XML avisa en el botón', (await page.$eval('#ecfd-xml-copiar', (e) => e.textContent)) === 'Copiado');
    L.check('Copia el XML sin la sangría', (await page.evaluate(() => navigator.clipboard.readText())) === XML);
    await page.click('#ecfd-xml-cerrar');
    await sleep(150);
    L.check('Cerrar el XML', !(await page.$('#ecfd-xml[open]')));

    await clicTexto('Consultar DGII', '[data-id="214"]');
    await sleep(300);
    L.check('Consultar DGII pregunta el estado', pedidos.some((p) => p.startsWith('GET /api/ecf/documents/214/status')), pedidos.slice(-3).join(' | '));
    await page.waitForSelector('#cfg-group-modal-body .ecfd-fila', { visible: true });

    await page.evaluate(() => { document.querySelector('#cfg-group-modal-body').scrollTop = 0; });
    await page.click('[data-grupo="rechazado"]');
    await sleep(300);
    L.check('El botón de estado filtra', pedidos.some((p) => p.includes('estado=rechazado')), pedidos.slice(-2).join(' | '));
    await page.waitForSelector('[data-id="213"]', { visible: true });

    await clicTexto('Siguiente', '#ecfd-paginas');
    await sleep(300);
    L.check('Siguiente cambia de página', pedidos.some((p) => p.includes('pagina=2')), pedidos.slice(-2).join(' | '));
    await page.waitForSelector('[data-id="213"]', { visible: true });

    await clicTexto('Reenviar', '[data-id="213"]');
    await page.waitForSelector('button[data-action="ok"]', { visible: true, timeout: 5000 });
    await page.screenshot({ path: path.join(SHOTS, '3-reenviar.png') });
    L.check('Reenviar pide confirmar antes de enviar', !pedidos.some((p) => p.startsWith('POST /api/ecf/documents/213/resend')));
    await page.click('button[data-action="ok"]');
    await sleep(300);
    L.check('Confirmado, reenvía', pedidos.some((p) => p.startsWith('POST /api/ecf/documents/213/resend')), pedidos.slice(-3).join(' | '));

    const propios = errores.filter((e) => /ecfd|comprobantes/i.test(e));
    L.check('Sin errores de la sección', propios.length === 0, JSON.stringify(propios));
    L.log(`Capturas: ${SHOTS}`);
  } catch (e) {
    L.check('Prueba completa', false, e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await L.stopServer(server).catch(() => {});
  }
  const fallas = L.results.filter((r) => !r.ok);
  console.log(`\n${L.results.length - fallas.length}/${L.results.length} comprobaciones OK`);
  process.exit(fallas.length ? 1 : 0);
})();
