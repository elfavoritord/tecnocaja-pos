'use strict';

// Las pantallas de verdad, con clics: Planes y precios del POS y el módulo del panel.
// El panel corre sobre un Firestore en memoria; no se toca la base real.
//   node tests/licensing/ui/probar-pantallas-licencia.js [carpeta-de-capturas]
/* global DB, doLogin, adminContratos, navigateTo -- corren dentro de la página */

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-licencia-ui');
const L = require('../../../scripts/e2e-lan/lib');
const puppeteer = require(path.join(L.PROJECT, 'node_modules', 'puppeteer'));
const { createFakeFirestore } = require('../../helpers/fake-firestore');
const { createContratosRouter } = require('../../../tecno-caja-admin/routes/contratos.routes');

const PORT = 3495;
const USER_DATA = path.join(L.WORK, 'pc-data');
const HOME = path.join(L.WORK, 'home');
const CAPTURAS = process.argv[2] || '';
const ENV = { DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const resultados = [];
function ok(nombre, cond, detalle = '') {
  resultados.push({ nombre, ok: Boolean(cond) });
  console.log(`${cond ? '  ok ' : 'FALLA'} ${nombre}${!cond && detalle ? ` → ${detalle}` : ''}`);
}
async function captura(page, nombre) {
  if (!CAPTURAS) return;
  fs.mkdirSync(CAPTURAS, { recursive: true });
  await page.screenshot({ path: path.join(CAPTURAS, `${nombre}.png`) });
}

async function probarPos(browser) {
  console.log('\nPOS: Planes y precios');
  L.prepareSandbox();
  for (const dir of [USER_DATA, HOME]) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
  const server = L.startServer('licencia-ui', { port: PORT, userData: USER_DATA, env: ENV });
  try {
    await L.waitHttp(PORT);
    await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja', businessName: 'Colmado Prueba',
      adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@prueba.test', adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 860 });
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#login-user', { timeout: 30000 });
    await page.evaluate(() => {
      document.getElementById('login-user').value = 'admin';
      document.getElementById('login-pass').value = '1234';
    });
    await page.evaluate(() => doLogin());
    await sleep(1500);
    ok('el botón está en Configuración', await page.$eval('#cfg-btn-planes', (b) => /planes y precios/i.test(b.textContent)));
    await page.$eval('#cfg-btn-planes', (b) => b.click());
    await page.waitForSelector('.pp-plan', { timeout: 8000 });
    const texto = await page.$eval('.pp-cuerpo', (c) => c.textContent);
    for (const precio of ['RD$800', 'RD$7,200', 'RD$8,000', 'RD$1,400', 'RD$12,600', 'RD$14,000', 'RD$1,800', 'RD$16,200', 'RD$16,000', 'RD$500', 'RD$2,500', 'RD$3,500']) {
      ok(`muestra ${precio}`, texto.includes(precio));
    }
    ok('los tres planes', (await page.$$eval('.pp-plan h3', (l) => l.map((h) => h.textContent))).join() === 'Básico,MultiCaja,MultiSucursal');
    ok('marca el plan actual', (await page.$eval('.pp-plan.es-actual h3', (h) => h.textContent)) === 'Básico');
    ok('lo no definido dice Consultar', /Pago único, sin mensualidad: Consultar/.test(texto));
    ok('explica qué necesita', /Windows 10 u 11/.test(texto));
    ok('aclara la implementación', /una sola vez y no se vuelve a cobrar/.test(texto));
    await captura(page, 'pos-planes');
    await page.keyboard.press('Escape');
    ok('se cierra con Esc', (await page.$$('.pp-fondo')).length === 0);

    const sinSesion = await page.evaluate(async () => (await fetch('/api/planes/mi-licencia')).status);
    ok('mi licencia pide sesión', sinSesion === 401 || sinSesion === 403, String(sinSesion));
    const conSesion = await page.evaluate(async () => (await fetch('/api/planes/mi-licencia', { headers: { Authorization: `Bearer ${DB.authToken}` } })).json());
    ok('mi licencia responde', conSesion.planCode === 'basico', JSON.stringify(conSesion));
    ok('el catálogo es público', await page.evaluate(async () => (await fetch('/api/planes/catalogo')).ok));
    const cambio = await page.evaluate(async () => (await fetch('/api/planes/catalogo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
    ok('los precios no se cambian desde el POS', cambio === 404 || cambio === 405, String(cambio));
    ok('sin errores en el POS', errores.length === 0, errores.join(' | '));
    await page.close();
  } finally {
    L.stopServer(server);
  }
}

async function probarPanel(browser) {
  console.log('\nPanel: precios, cotizador y contrato');
  const ID = 'pos_negocio_ui';
  const db = createFakeFirestore({
    [`licencias/${ID}`]: { businessName: 'Colmado UI', status: 'trial', planCode: 'basico', rnc: '101010101', devices: { a: { deviceId: 'a', hostname: 'CAJA-1' } } },
  });
  const app = express();
  app.use(express.json());
  app.use(createContratosRouter({
    db,
    requireAuth: (req, _res, next) => { req.adminUser = { email: 'emilio@prueba.test' }; next(); },
    audit: async () => {},
  }));
  app.use(express.static(path.join(L.PROJECT, 'tecno-caja-admin', 'public')));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const licencia = async () => (await db.collection('licencias').doc(ID).get()).data();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1360, height: 900 });
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.adminContratos === 'object', { timeout: 20000 });
    await sleep(500);
    // Sin Firebase de por medio: la sesión del panel no es lo que se prueba aquí.
    await page.evaluate(() => {
      window.fetchWithAuth = (ruta, opciones) => fetch(ruta, opciones);
      document.querySelectorAll('.hidden').forEach((el) => {
        if (el.id === 'app' || el.querySelector?.('#mod-precios')) el.classList.remove('hidden');
      });
      document.querySelectorAll('[id*="login"], [id*="auth"]').forEach((el) => { el.style.display = 'none'; });
    });
    await page.evaluate(() => document.querySelector('[data-module="precios"]').click());
    await page.waitForSelector('#cot-plan', { timeout: 8000 });
    const tabla = await page.$eval('#precios-contenido', (c) => c.textContent);
    ok('menú abre Planes y precios con los montos', ['RD$800', 'RD$7,200', 'RD$12,600', 'RD$16,200', 'RD$16,000'].every((x) => tabla.includes(x)));
    ok('lo no definido se ve como tal', tabla.includes('Por definir'));

    await page.select('#cot-plan', 'pro');
    await page.select('#cot-modalidad', 'anual');
    await page.$eval('#cot-pc', (i) => { i.value = '2'; });
    await page.evaluate(() => adminContratos.cotizar());
    await page.waitForSelector('#cot-resultado table', { timeout: 5000 });
    const cot = await page.$eval('#cot-resultado', (c) => c.textContent);
    ok('cotizador: licencia y adicionales al año', cot.includes('RD$12,600') && cot.includes('RD$9,000'), cot.slice(0, 300));
    ok('cotizador: implementación aparte', cot.includes('Una sola vez: RD$19,000') && cot.includes('Se repite cada año: RD$21,600'), cot.slice(-300));
    await captura(page, 'panel-precios');

    await page.$eval('#pre-perm-basico', (i) => { i.value = '25000'; });
    await page.$eval('#pre-ecf-mes', (i) => { i.value = '1500'; });
    await page.evaluate(() => adminContratos.guardarPrecios());
    await page.waitForFunction(() => document.querySelector('#pre-perm-basico')?.value === '25000' && document.body.textContent.includes('RD$25,000'), { timeout: 5000 });
    ok('guardar precios queda', (await page.$eval('#precios-contenido', (c) => c.textContent)).includes('RD$25,000'));

    // Contrato: pago único y, después, e-CF.
    await page.evaluate((id) => adminContratos.abrir(id), ID);
    await page.waitForSelector('#ctr-plan', { timeout: 5000 });
    ok('avisa que aún no tiene contrato', (await page.$eval('#contrato-cuerpo', (c) => c.textContent)).includes('todavía no tiene contrato'));
    await page.select('#ctr-modalidad', 'LIFETIME_NO_SUBSCRIPTION');
    await page.evaluate(() => adminContratos.guardarContrato());
    await page.waitForFunction(() => document.querySelector('#contrato-cuerpo').textContent.includes('Sin vencimiento'), { timeout: 5000 });
    let d = await licencia();
    ok('guardó la permanente en la base', d.modalidad === 'LIFETIME_NO_SUBSCRIPTION' && d.status === 'active' && d.expiresAt === null);
    await captura(page, 'panel-contrato');

    await page.select('#pag-concepto', 'ecf');
    await page.select('#pag-periodo', 'mensual');
    await page.$eval('#pag-monto', (i) => { i.value = '1500'; });
    // Doble clic: un solo pago.
    await page.evaluate(() => { adminContratos.registrarPago(); adminContratos.registrarPago(); });
    await page.waitForFunction(() => document.querySelector('#contrato-cuerpo').textContent.includes('RD$1,500'), { timeout: 5000 });
    const pagos = await db.collection(`licencias/${ID}/pagos`).get();
    ok('doble clic registra un solo pago', pagos.size === 1, String(pagos.size));
    d = await licencia();
    ok('el e-CF queda activo y la licencia sigue permanente', d.servicios.ecf.estado === 'activo' && d.modalidad === 'LIFETIME_NO_SUBSCRIPTION' && d.expiresAt === null);
    const fechaSop = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    await page.$eval('#ctr-vence-soporte', (i, v) => { i.value = v; }, fechaSop);
    await page.evaluate(() => adminContratos.servicio('soporte', 'activar'));
    await page.waitForFunction(() => [...document.querySelectorAll('#contrato-cuerpo tr')].some((tr) => /Soporte/.test(tr.textContent) && /Activo/.test(tr.textContent)), { timeout: 5000 });
    await page.evaluate(() => adminContratos.servicio('soporte', 'suspender'));
    await page.waitForFunction(() => [...document.querySelectorAll('#contrato-cuerpo tr')].some((tr) => /Soporte/.test(tr.textContent) && /Suspendido/.test(tr.textContent)), { timeout: 5000 });
    d = await licencia();
    ok('suspender soporte no toca nada más', d.servicios.soporte.estado === 'suspendido' && d.servicios.ecf.estado === 'activo' && d.status === 'active');
    ok('muestra equipos e historial', await page.$eval('#contrato-cuerpo', (c) => /CAJA-1/.test(c.textContent) && /servicio\.soporte\.suspender/.test(c.textContent)));
    ok('sin errores en el panel', errores.filter((e) => !/firebase|auth/i.test(e)).length === 0, errores.join(' | '));
    await page.close();
  } finally {
    await new Promise((r) => { server.close(r); server.closeAllConnections(); });
  }
}

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    await probarPanel(browser);
    await probarPos(browser);
  } finally {
    await browser.close();
  }
  const fallas = resultados.filter((r) => !r.ok);
  console.log(`\n${resultados.length - fallas.length}/${resultados.length} pasaron`);
  fallas.forEach((f) => console.log(`FALLA ${f.nombre}`));
  process.exit(fallas.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
