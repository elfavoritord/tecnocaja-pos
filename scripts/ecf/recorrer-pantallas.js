// Abre la app real en Chrome y recorre todas las pantallas: menú completo y cada sección de
// Configuración. Reporta errores de la página y llamadas al servidor que fallen.
// Uso: node scripts/ecf/recorrer-pantallas.js [--mariadb] [--servicios]
/* global DB, doLogin, showModule -- corren dentro de la página */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARIADB = process.argv.includes('--mariadb');
const SERVICIOS = process.argv.includes('--servicios');
const NOMBRE = `${SERVICIOS ? 'servicios' : 'pos'}-${MARIADB ? 'mariadb' : 'sqlite'}`;
process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), `tecnocaja-pantallas-${NOMBRE}`);
process.env.TC_E2E_DB_PORT = process.env.TC_E2E_DB_PORT || '3433';
const L = require('../e2e-lan/lib');
const puppeteer = require(path.join(L.PROJECT, 'node_modules', 'puppeteer'));

const PORT = 3471 + (MARIADB ? 1 : 0) + (SERVICIOS ? 2 : 0);
const DB_NAME = 'tc_pantallas';
const USER_DATA = path.join(L.WORK, 'pc-data');
const HOME = path.join(L.WORK, 'home');
const CAPTURAS = path.join(L.WORK, 'capturas');
const ENV = {
  ...(MARIADB ? { DB_CLIENT: 'mysql', DB_HOST: '127.0.0.1', DB_PORT: String(L.DB_PORT), DB_USER: 'root', DB_PASSWORD: '', DB_NAME } : { DB_CLIENT: 'sqlite' }),
  USERPROFILE: HOME, HOME,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let server = null;
  let browser = null;
  const problemas = [];
  try {
    L.prepareSandbox();
    for (const dir of [USER_DATA, HOME, CAPTURAS]) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
    fs.mkdirSync(CAPTURAS, { recursive: true });
    if (MARIADB) {
      await L.startMariaDb({ fresh: true });
      await L.mysqlRoot(`DROP DATABASE IF EXISTS ${DB_NAME}; CREATE DATABASE ${DB_NAME} CHARACTER SET utf8mb4;`);
    }
    server = L.startServer(`pantallas-${NOMBRE}`, { port: PORT, userData: USER_DATA, env: ENV });
    await L.waitHttp(PORT);
    await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: SERVICIOS ? 'srv_tecnologia' : 'colmado', businessStructureMode: 'monocaja',
      businessName: 'Negocio Prueba', adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@prueba.test',
      adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });

    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 820 });
    let donde = 'inicio';
    page.on('pageerror', (e) => problemas.push(`[${donde}] error de página: ${e.message}`));
    page.on('response', async (res) => {
      const url = new URL(res.url());
      if (!url.pathname.startsWith('/api/') || res.status() < 400) return;
      if (res.status() === 404 && /\/(uploads|favicon)/.test(url.pathname)) return;
      let detalle = '';
      try { detalle = (await res.text()).slice(0, 160); } catch (_) { /* sin cuerpo */ }
      // La prueba corre sin Firebase, a propósito: Delivery lo avisa y sigue.
      if (res.status() === 503 && /Firebase no disponible/.test(detalle)) return;
      problemas.push(`[${donde}] ${res.request().method()} ${url.pathname} → ${res.status()} ${detalle}`);
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
    await sleep(1500);

    const modulos = await page.evaluate(() => {
      const nombres = new Set();
      document.querySelectorAll('[onclick*="showModule("]').forEach((el) => {
        const m = String(el.getAttribute('onclick')).match(/showModule\(['"]([\w-]+)['"]/);
        if (m) nombres.add(m[1]);
      });
      document.querySelectorAll('[data-module]').forEach((el) => nombres.add(el.dataset.module));
      document.querySelectorAll('[id^="module-"]').forEach((el) => nombres.add(el.id.replace('module-', '')));
      return [...nombres].filter(Boolean);
    });
    L.check(`Se encontraron pantallas (${modulos.length})`, modulos.length > 5, modulos.join(', '));

    for (const modulo of modulos) {
      donde = modulo;
      await page.evaluate((m) => { try { showModule(m); } catch (e) { window.__errorModulo = e.message; } }, modulo);
      await sleep(1200);
      const errorDirecto = await page.evaluate(() => { const e = window.__errorModulo; window.__errorModulo = null; return e; });
      if (errorDirecto) problemas.push(`[${modulo}] showModule: ${errorDirecto}`);
      const textoError = await page.evaluate(() => {
        const visibles = [...document.querySelectorAll('.error-text, .srv-err')].filter((el) => el.offsetParent !== null);
        return visibles.map((el) => el.innerText.trim()).join(' | ');
      });
      if (textoError) problemas.push(`[${modulo}] la pantalla muestra: ${textoError.slice(0, 200)}`);
      await page.screenshot({ path: path.join(CAPTURAS, `${modulo}.png`) }).catch(() => {});
    }

    // Empresa de servicios: las pestañas del módulo, que son sus propias pantallas.
    if (SERVICIOS) {
      const pestanas = await page.evaluate(() => [...document.querySelectorAll('[data-srv-tab], [data-tab^="srv"], .srv-tab')].map((el) => el.dataset.srvTab || el.dataset.tab).filter(Boolean));
      for (const pestana of pestanas) {
        donde = `servicios:${pestana}`;
        await page.evaluate((p) => { document.querySelector(`[data-srv-tab="${p}"], [data-tab="${p}"]`)?.click(); }, pestana);
        await sleep(800);
      }
    }

    // Configuración: cada categoría y cada sección dentro de su ventana.
    donde = 'configuracion';
    await page.evaluate(() => showModule('configuracion'));
    await sleep(1500);
    const categorias = await page.evaluate(() => [...document.querySelectorAll('#module-configuracion [class*="cfg-group"], #module-configuracion [class*="cfg-card"]')]
      .filter((el) => el.offsetParent !== null).map((el) => el.innerText.split('\n')[0].trim()).filter(Boolean));
    const unicas = [...new Set(categorias)];
    L.check(`Categorías de Configuración (${unicas.length})`, unicas.length >= 3, unicas.join(', '));
    for (const categoria of unicas) {
      donde = `config:${categoria}`;
      const abierta = await page.evaluate((c) => {
        const el = [...document.querySelectorAll('#module-configuracion [class*="cfg-group"], #module-configuracion [class*="cfg-card"]')]
          .find((x) => x.offsetParent !== null && x.innerText.trim().startsWith(c));
        if (!el) return false;
        el.click();
        return true;
      }, categoria);
      if (!abierta) continue;
      await sleep(500);
      const secciones = await page.evaluate(() => {
        const cuerpo = document.getElementById('cfg-group-modal-body');
        if (!cuerpo || cuerpo.offsetParent === null) return [];
        return [...cuerpo.children].filter((el) => el.offsetParent !== null).map((el) => el.innerText.split('\n')[0].trim()).filter(Boolean);
      });
      for (const seccion of secciones) {
        donde = `config:${categoria} → ${seccion}`;
        await page.evaluate((s) => { [...document.getElementById('cfg-group-modal-body').children].find((x) => x.innerText.trim().startsWith(s))?.click(); }, seccion);
        await sleep(900);
        const textoError = await page.evaluate(() => [...document.querySelectorAll('#cfg-group-modal-body .error-text')].filter((el) => el.offsetParent !== null).map((el) => el.innerText.trim()).join(' | '));
        if (textoError) problemas.push(`[${donde}] la pantalla muestra: ${textoError.slice(0, 200)}`);
        await page.screenshot({ path: path.join(CAPTURAS, `cfg-${categoria}-${seccion}`.replace(/[^\w-]+/g, '_').slice(0, 80) + '.png') }).catch(() => {});
        await page.evaluate(() => document.querySelector('#cfg-group-modal-title .cfg-group-back')?.click());
        await sleep(300);
      }
      await page.evaluate(() => {
        const modal = document.getElementById('cfg-group-modal');
        modal?.querySelector('[class*="close"], [aria-label="Cerrar"]')?.click();
      });
      await sleep(300);
      await page.keyboard.press('Escape');
      await sleep(200);
    }
  } catch (e) {
    L.check('Recorrido completo', false, e.stack || e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await sleep(2000);
    if (server) await L.stopServer(server).catch(() => {});
    if (MARIADB) await L.stopMariaDb().catch(() => {});
  }
  const unicos = [...new Set(problemas)];
  unicos.forEach((p) => console.log(`PROBLEMA ${p}`));
  L.check(`Sin problemas en las pantallas [${NOMBRE}]`, unicos.length === 0, `${unicos.length} problemas`);
  const fallas = L.results.filter((r) => !r.ok);
  console.log(`\n[${NOMBRE}] ${L.results.length - fallas.length}/${L.results.length} comprobaciones OK · capturas en ${CAPTURAS}`);
  process.exit(fallas.length ? 1 : 0);
})();
