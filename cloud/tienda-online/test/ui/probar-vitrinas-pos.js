'use strict';

// La pantalla del POS: Configurar tienda → Vitrinas, en la app real con clics de
// verdad, y lo que queda guardado. Con SQLite en una carpeta temporal.
//   node cloud/tienda-online/test/ui/probar-vitrinas-pos.js [carpeta-de-capturas]
/* global DB, doLogin -- corren dentro de la página */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-vitrinas-ui');
const L = require('../../../../scripts/e2e-lan/lib');
const puppeteer = require(path.join(L.PROJECT, 'node_modules', 'puppeteer'));

const PORT = 3496;
const USER_DATA = path.join(L.WORK, 'pc-data');
const HOME = path.join(L.WORK, 'home');
const CAPTURAS = process.argv[2] || '';
const ENV = { DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME, TECNO_CAJA_TIENDA_ONLINE_URL: 'https://tienda.prueba.test' };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

const resultados = [];
function ok(nombre, cond, detalle = '') {
  resultados.push({ nombre, ok: Boolean(cond) });
  console.log(`${cond ? '  ok ' : 'FALLA'} ${nombre}${!cond && detalle ? ` → ${detalle}` : ''}`);
}

(async () => {
  let server = null;
  let browser = null;
  try {
    L.prepareSandbox();
    for (const dir of [USER_DATA, HOME]) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
    server = L.startServer('vitrinas-ui', { port: PORT, userData: USER_DATA, env: ENV });
    await L.waitHttp(PORT);
    await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja',
      businessName: 'Colmado Prueba', adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@prueba.test',
      adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });

    browser = await puppeteer.launch({ headless: true });
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

    const api = (metodo, ruta, cuerpo) => page.evaluate(async (m, r, c) => {
      const res = await fetch(`/api/tienda-online${r}`, {
        method: m,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken}` },
        body: c ? JSON.stringify(c) : undefined,
      });
      return res.json();
    }, metodo, ruta, cuerpo);

    const inicial = await api('GET', '/config');
    ok('el POS entrega el diseño base y los límites', inicial.disenoBase?.vitrinas?.ofertas?.velocidad === 40 && inicial.limitesVitrina?.cantidad?.max === 40, JSON.stringify(inicial).slice(0, 200));
    ok('sin personalizar se guarda como null', inicial.settings.diseno === null);

    const abrir = await page.evaluate(() => {
      const f = window.TiendaOnline?.openConfig || window.TIENDA_ONLINE?.openConfig;
      if (!f) return Object.keys(window).filter((k) => /tienda/i.test(k)).join();
      f();
      return 'ok';
    });
    ok('abre Configurar tienda', abrir === 'ok', abrir);
    await page.waitForSelector('[data-cfg-tab="5"]', { timeout: 8000 });
    await page.click('[data-cfg-tab="5"]');
    await sleep(150);
    ok('la pestaña Vitrinas muestra las dos', await page.$$eval('.to-vitrina', (l) => l.length === 2 && l.every((f) => f.offsetHeight > 0)));
    if (CAPTURAS) {
      fs.mkdirSync(CAPTURAS, { recursive: true });
      await page.screenshot({ path: path.join(CAPTURAS, 'pos-vitrinas.png') });
    }

    // Lo que hace el administrador
    await page.$eval('[data-vit-activa="nuevos"]', (c) => c.click());
    await page.type('[data-vit-titulo="ofertas"]', 'Solo por hoy');
    await page.$eval('[data-vit-rango="ofertas-velocidad"]', (r) => { r.value = '90'; r.dispatchEvent(new Event('input', { bubbles: true })); });
    ok('el número de velocidad cambia al mover', (await page.$eval('[data-vit-valor="ofertas-velocidad"]', (e) => e.textContent)) === '90');
    await page.$eval('[data-vit-rango="ofertas-cantidad"]', (r) => { r.value = '10'; r.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.select('[data-vit="ofertas"][data-campo="direccion"]', 'derecha');
    await page.select('[data-vit="ofertas"][data-campo="estiloTarjeta"]', 'borde');
    await page.$eval('[data-vit-auto="ofertas-colorFondo"]', (c) => c.click());
    ok('quitar "El de la tienda" habilita el color', !(await page.$eval('[data-vit-color="ofertas-colorFondo"]', (c) => c.disabled)));
    await page.$eval('[data-vit-color="ofertas-colorFondo"]', (c) => { c.value = '#fef3c7'; });
    ok('el otro color sigue automático', await page.$eval('[data-vit-color="ofertas-colorTitulo"]', (c) => c.disabled));

    await page.$eval('#tocfg-slug', (e) => { e.value = 'colmado-prueba'; });
    await page.$$eval('[data-pago]', (l) => { if (!l.some((c) => c.checked)) l[0].click(); });
    const botones = await page.$$('.modal-overlay button, .to-modal button, [data-btn]');
    const guardar = await page.evaluateHandle(() => [...document.querySelectorAll('[data-btn]')].find((b) => /^Guardar/.test(b.textContent.trim())));
    ok('hay botón Guardar', botones.length > 0 && Boolean(guardar.asElement()));
    await guardar.asElement().click();
    await sleep(800);

    const guardado = await api('GET', '/config');
    const d = guardado.settings.diseno;
    ok('guardó la velocidad, cantidad y dirección', d?.vitrinas?.ofertas?.velocidad === 90 && d.vitrinas.ofertas.cantidad === 10 && d.vitrinas.ofertas.direccion === 'derecha', JSON.stringify(d?.vitrinas?.ofertas));
    ok('guardó estilo y color', d.vitrinas.ofertas.estiloTarjeta === 'borde' && d.vitrinas.ofertas.colorFondo === '#fef3c7' && d.vitrinas.ofertas.colorTitulo === null);
    ok('guardó el título', d.secciones.find((s) => s.id === 'ofertas').titulo === 'Solo por hoy');
    ok('apagó Nuevos productos sin tocar Ofertas', d.secciones.find((s) => s.id === 'nuevos').activa === false && d.secciones.find((s) => s.id === 'ofertas').activa === true);
    ok('la otra vitrina queda igual', d.vitrinas.nuevos.velocidad === 40 && d.vitrinas.nuevos.direccion === 'derecha');
    ok('no toca lo demás de la configuración', guardado.settings.pagos && guardado.settings.horario && guardado.slug === 'colmado-prueba');

    // Reabrir: se ve lo guardado.
    await page.evaluate(() => (window.TiendaOnline?.openConfig || window.TIENDA_ONLINE?.openConfig)());
    await page.waitForSelector('[data-vit-rango="ofertas-velocidad"]', { timeout: 8000 });
    const reabierta = await page.evaluate(() => {
      const ultimo = [...document.querySelectorAll('[data-vit-rango="ofertas-velocidad"]')].pop();
      const caja = ultimo.closest('fieldset').parentElement;
      return { vel: ultimo.value, nuevos: caja.querySelector('[data-vit-activa="nuevos"]').checked };
    });
    ok('al reabrir se ve lo guardado', reabierta.vel === '90' && reabierta.nuevos === false, JSON.stringify(reabierta));
    ok('sin errores en la pantalla', errores.length === 0, errores.join(' | '));

    // Solo el administrador: la ruta exige permiso de configuración.
    const sinSesion = await page.evaluate(async () => (await fetch('/api/tienda-online/config')).status);
    ok('sin sesión no se puede leer ni cambiar', sinSesion === 401 || sinSesion === 403, String(sinSesion));
  } finally {
    if (browser) await browser.close();
    if (server) L.stopServer(server);
  }
  const fallas = resultados.filter((r) => !r.ok);
  console.log(`\n${resultados.length - fallas.length}/${resultados.length} pasaron`);
  process.exit(fallas.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
