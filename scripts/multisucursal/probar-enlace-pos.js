'use strict';

/**
 * Punta a punta del enlace de una sucursal, todo real menos Firebase (emulador):
 *   - Sync API (cloud/sync-api) contra el emulador de Firestore.
 *   - Servidor del POS (server.js) en SQLite, en una carpeta temporal.
 *   - La pantalla de Configuración (js/multisucursal-enlace.js) en Chrome.
 *
 *   node cloud/sync-api/scripts/vendor-sync.js
 *   npx -y firebase-tools@13.35.1 emulators:exec --config firebase.emulador.json \
 *     --only firestore --project demo-tecnocaja "node scripts/multisucursal/probar-enlace-pos.js <carpeta-capturas>"
 *
 * Flujo: el contador crea la sucursal y su código → en el POS se escribe el
 * código → la PC adopta la identidad central y manda su latido → el POS ya no
 * deja crear sucursales locales → el contador cambia el nombre y el POS lo
 * toma → tras reiniciar sigue enlazada → Emilio revoca el equipo y el POS lo
 * detecta → desvincular.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-ms-enlace');
const L = require('../e2e-lan/lib');
const express = require('express');
const puppeteer = require('puppeteer');
const admin = require('firebase-admin');
const { createApp: crearSyncApi } = require('../../cloud/sync-api/lib/app');
const { createSucursalesCentral } = require('../../server/multisucursal/central/sucursales');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Correr dentro de firebase emulators:exec (ver encabezado).');
  process.exit(1);
}

const SALIDA = process.argv[2] || path.join(os.tmpdir(), 'tecnocaja-ms-enlace-capturas');
const PORT = 3496;
const USER_DATA = path.join(L.WORK, 'pc-norte');
const HOME = path.join(L.WORK, 'home');
const LIC = 'pos:tecno-caja-supermercado-bravo';
const EMILIO = { tipo: 'super_admin', uid: 'emilio', nombre: 'Emilio' };
const CONTADORA = { tipo: 'contador', uid: 'conta', nombre: 'Pérez & Asociados', contadorId: 'firma-1' };
const ctx = { token: '' };

const db = admin.initializeApp({ projectId: 'demo-tecnocaja' }).firestore();
const central = createSucursalesCentral({ db });

function escuchar(app) {
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}

async function entrar() {
  const r = await L.request(PORT, 'POST', '/api/login', { usuario: 'admin', password: '1234' });
  ctx.token = r.body?.token || '';
  return r;
}

const estadoPos = () => L.request(PORT, 'GET', '/api/multisucursal/estado', null, ctx.token);

(async () => {
  fs.mkdirSync(SALIDA, { recursive: true });
  let pos = null;
  let browser = null;
  const servidores = [];
  try {
    // ── Central: la empresa, el límite (Emilio) y la sucursal con su código (contador)
    await db.collection('licencias').doc(LIC).set({ businessName: 'Supermercado Bravo', status: 'active', contadorId: 'firma-1' });
    await central.fijarLimite(LIC, 2, EMILIO);
    await central.crear(LIC, { nombre: 'Bravo Centro', codigo: 'CEN' }, CONTADORA);
    const norte = await central.crear(LIC, { nombre: 'Bravo Norte', codigo: 'NOR', direccion: 'Av. Hermanas Mirabal 10', telefono: '809-555-1010', encargado: 'Luis' }, CONTADORA);
    const { codigo } = await central.generarCodigo(LIC, norte.branchUuid, CONTADORA);
    L.check('Central: el contador crea "Bravo Norte" y su código de equipo', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(codigo), codigo);

    const syncApi = await escuchar(crearSyncApi({ db }));
    servidores.push(syncApi);
    const SYNC_URL = `http://127.0.0.1:${syncApi.address().port}`;

    // ── POS de la sucursal (SQLite) ───────────────────────────────────────
    L.prepareSandbox();
    for (const dir of [USER_DATA, HOME]) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
    const env = { DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME, TECNO_CAJA_SYNC_URL: SYNC_URL, E2E_PLAN: 'plus' };
    pos = L.startServer('pos-norte', { port: PORT, userData: USER_DATA, env });
    await L.waitHttp(PORT);
    const setup = await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja',
      businessName: 'Bravo (sin enlazar)', adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@bravo.test',
      adminPassword: '1234', openingAmount: 0, currency: 'RD$',
    });
    L.check('POS: negocio configurado en SQLite', setup.status === 201, `HTTP ${setup.status}`);
    await L.stopServer(pos);
    const licencia = L.seedLicense({ port: PORT, userData: USER_DATA, env });
    L.check('POS: licencia activada (plan plus) para poder reiniciar', licencia.ok, licencia.detail);
    pos = L.startServer('pos-norte', { port: PORT, userData: USER_DATA, env });
    await L.waitHttp(PORT);
    await entrar();
    const antes = await estadoPos();
    L.check('POS: sin enlazar todavía', antes.status === 200 && antes.body.enlace.configurado && !antes.body.enlace.tieneToken, JSON.stringify(antes.body.enlace));

    // ── Pantalla de Configuración en Chrome (contra el POS real) ─────────
    const arnes = express().use(express.json());
    arnes.get('/', (_req, res) => res.send(`<!doctype html><html><head><meta charset="utf-8">
      <style>body{font-family:system-ui,Segoe UI,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px}
      .hidden{display:none}.config-section{max-width:760px;padding:1rem 1.25rem;border-radius:12px;background:#1e293b;border:1px solid #334155}
      .form-input{padding:.5rem .7rem;border-radius:8px;border:1px solid #475569;background:#0f172a;color:#e2e8f0}
      .btn-primary,.btn-secondary{padding:.5rem .9rem;border-radius:8px;border:1px solid #475569;background:#334155;color:#fff;cursor:pointer}
      .btn-primary{background:#3b82f6;border-color:#3b82f6}.helper-text{display:block;color:#94a3b8;font-size:.82rem;margin-top:.35rem}
      .config-lock-note{padding:.6rem .8rem;border-radius:8px;background:rgba(245,158,11,.12);color:#fbbf24;font-size:.85rem}
      .form-group{margin:.6rem 0}label{display:block;font-size:.85rem;margin-bottom:.3rem;color:#cbd5e1}</style></head><body>
      <div class="config-section hidden" id="cfg-multisucursal-section"><h3>Sucursal conectada a Tecno Caja</h3><div id="cfg-multisucursal-body"></div></div>
      <div id="cfg-new-branch-group"><label>Nueva sucursal</label><input class="form-input"></div><div id="cfg-new-branch-locked" class="config-lock-note hidden"></div>
      <div id="toast"></div>
      <script>window.getTecnoCajaAuthToken = () => ${JSON.stringify(ctx.token)};
        window.showToast = (m, t) => { document.getElementById('toast').textContent = '[' + t + '] ' + m; };
        window.showDeleteConfirm = async () => true;</script>
      <script src="/js/multisucursal-enlace.js"></script>
      <script>window.MultisucursalEnlace.loadConfigSection();</script></body></html>`));
    arnes.get('/js/multisucursal-enlace.js', (_req, res) => res.sendFile(path.join(L.PROJECT, 'js', 'multisucursal-enlace.js')));
    // Mismo origen que la pantalla: reenvía al POS real con la sesión del admin.
    arnes.all(/^\/api\/multisucursal\/.*/, async (req, res) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${req.originalUrl}`, {
        method: req.method,
        headers: { 'Content-Type': 'application/json', Authorization: req.get('authorization') || '' },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
      });
      res.status(r.status).json(await r.json().catch(() => ({})));
    });
    const sArnes = await escuchar(arnes);
    servidores.push(sArnes);

    browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 560 });
    await page.goto(`http://127.0.0.1:${sArnes.address().port}/`);
    await page.waitForSelector('#cfg-ms-codigo', { timeout: 15000 });
    await page.screenshot({ path: path.join(SALIDA, 'pos-sin-enlazar.png') });
    await page.type('#cfg-ms-codigo', codigo.replace('-', '').toLowerCase());
    const escrito = await page.$eval('#cfg-ms-codigo', (el) => el.value);
    L.check('Pantalla: el código se formatea solo (XXXX-XXXX)', escrito === codigo, escrito);
    await page.click('[data-ms="activar"]');
    await page.waitForFunction(() => document.body.textContent.includes('Sucursal Bravo Norte de Supermercado Bravo'), { timeout: 20000 });
    L.check('Pantalla: conectada como "Bravo Norte" de "Supermercado Bravo"', true, await page.$eval('#toast', (el) => el.textContent));
    L.check('Pantalla: se oculta "Nueva sucursal" y aparece el aviso',
      await page.$eval('#cfg-new-branch-group', (el) => el.classList.contains('hidden')) && await page.$eval('#cfg-new-branch-locked', (el) => !el.classList.contains('hidden')));
    await page.screenshot({ path: path.join(SALIDA, 'pos-enlazado.png') });

    // ── Lo que quedó en el POS y en la central ───────────────────────────
    const despues = await estadoPos();
    const e = despues.body.enlace;
    L.check('POS: enlazado y con la identidad de la central',
      e.vinculado && despues.body.identidad.empresa.uuid === norte.companyUuid && despues.body.identidad.sucursal.uuid === norte.branchUuid,
      `empresa ${despues.body.identidad.empresa.uuid} · sucursal ${despues.body.identidad.sucursal.uuid}`);
    L.check('POS: el estado no expone el token', !JSON.stringify(despues.body).includes('eq_'));
    const appEnv = fs.readFileSync(path.join(USER_DATA, 'config', 'app.env'), 'utf8');
    L.check('POS: el token quedó en config/app.env de esta PC', /^TECNO_CAJA_SYNC_TOKEN=eq_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/m.test(appEnv));
    const login = await entrar();
    const nombreLocal = login.body?.data?.sucursales?.[0]?.nombre;
    L.check('POS: la sucursal local tomó el nombre de la central', nombreLocal === 'Bravo Norte', nombreLocal);

    const equipos = await central.listarEquipos(LIC, EMILIO);
    L.check('Central: Emilio ve la PC activa con su latido', equipos.length === 1 && equipos[0].estado === 'activo' && Boolean(equipos[0].latido?.recibidoEn),
      `${equipos[0]?.hostname} · ${equipos[0]?.latido?.recibidoEn}`);

    const crearLocal = await L.request(PORT, 'POST', '/api/branches', { nombre: 'Sucursal pirata' }, ctx.token);
    L.check('POS: ya no deja crear sucursales locales', crearLocal.status === 403 && /Tecno Caja o tu contador/.test(crearLocal.body?.error || ''), `HTTP ${crearLocal.status} ${crearLocal.body?.error || ''}`);

    // ── El contador cambia el nombre y el POS lo toma ────────────────────
    await central.editar(LIC, norte.branchUuid, { nombre: 'Bravo Norte Plaza' }, CONTADORA);
    await L.request(PORT, 'POST', '/api/multisucursal/sincronizar', {}, ctx.token);
    const login2 = await entrar();
    L.check('POS: toma el nombre nuevo que puso el contador', login2.body?.data?.sucursales?.[0]?.nombre === 'Bravo Norte Plaza', login2.body?.data?.sucursales?.[0]?.nombre);

    // ── Reinicio: sigue enlazada ─────────────────────────────────────────
    await L.stopServer(pos);
    pos = L.startServer('pos-norte-2', { port: PORT, userData: USER_DATA, env });
    await L.waitHttp(PORT);
    await entrar();
    const tras = await estadoPos();
    L.check('POS: después de reiniciar sigue enlazada y arranca el latido',
      tras.body.enlace.vinculado && tras.body.ultimoArranque?.enlaceIniciado === true, JSON.stringify({ vinculado: tras.body.enlace.vinculado, enlaceIniciado: tras.body.ultimoArranque?.enlaceIniciado }));

    // ── Emilio revoca el equipo ──────────────────────────────────────────
    await central.revocarEquipo(LIC, equipos[0].equipoId, EMILIO);
    const sinc = await L.request(PORT, 'POST', '/api/multisucursal/sincronizar', {}, ctx.token);
    L.check('POS: detecta que Tecno Caja revocó el equipo', sinc.body?.enlace?.estado === 'revocado' && !sinc.body.enlace.vinculado, sinc.body?.enlace?.estado);
    const venta = await L.request(PORT, 'GET', '/api/connectivity');
    L.check('POS: sigue funcionando local (la venta no depende de la central)', venta.status === 200 && venta.body?.database?.ok === true, `modo ${venta.body?.mode}`);

    await page.goto(`http://127.0.0.1:${sArnes.address().port}/`);
    await page.waitForFunction(() => document.body.textContent.includes('Tecno Caja desconectó este equipo'), { timeout: 15000 });
    await page.screenshot({ path: path.join(SALIDA, 'pos-revocado.png') });
    L.check('Pantalla: avisa la revocación y ofrece conectar con un código nuevo', Boolean(await page.$('#cfg-ms-codigo')));

    const desv = await L.request(PORT, 'POST', '/api/multisucursal/desvincular', {}, ctx.token);
    L.check('POS: desvincular quita el token', desv.status === 200 && !desv.body.enlace.tieneToken && desv.body.enlace.estado === 'sin_vincular');
  } catch (error) {
    L.check('Sin excepciones', false, error.stack);
  } finally {
    if (browser) await browser.close();
    await L.stopServer(pos);
    servidores.forEach((s) => s.close());
  }
  const fallas = L.results.filter((r) => !r.ok);
  console.log(`\n${L.results.length - fallas.length}/${L.results.length} comprobaciones OK · capturas en ${SALIDA} · registros en ${L.WORK}`);
  process.exit(fallas.length ? 1 : 0);
})();
