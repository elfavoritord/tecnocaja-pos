'use strict';

/**
 * Laboratorio multisucursal: todo en esta PC, sin tocar Firebase real, la
 * base real ni el .env real. Para probar a mano antes de publicar versiones.
 *
 *   npm run lab:multisucursal                                (dos sucursales)
 *   PowerShell: $env:LAB_TRES='1'; npm run lab:multisucursal (tres sucursales)
 *   PowerShell: $env:LAB_RAPIDO='1'; npm run lab:multisucursal (ya enlazadas)
 *
 * Levanta:
 *   - Firestore del emulador (se borra al cerrar).
 *   - La Sync API real (cloud/sync-api) en http://127.0.0.1:3509.
 *   - Un panel de laboratorio en http://127.0.0.1:3500 con la pantalla de
 *     sucursales como la ve Emilio y como la ve el contador, y un botón para
 *     apagar/encender la central (simula que se cae Internet).
 *   - Dos (o tres) POS reales (server.js del proyecto, SQLite, cada uno con su
 *     carpeta) en http://127.0.0.1:3501, :3502 (y :3503). Usuario admin / 1234.
 *
 * Ctrl+C lo cierra todo. Cada vez arranca de cero.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-laboratorio');
const L = require('../e2e-lan/lib');
const express = require('express');
const admin = require('firebase-admin');
const { createApp: crearSyncApi } = require('../../cloud/sync-api/lib/app');
const { createSucursalesCentral } = require('../../server/multisucursal/central/sucursales');
const { createSucursalesRouter } = require('../../server/multisucursal/central/sucursales.routes');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Usa: npm run lab:multisucursal   (arranca el emulador de Firestore)');
  process.exit(1);
}

const LIC = 'pos:tecno-caja-ferreteria-laboratorio';
const NEGOCIO = 'Ferretería Laboratorio';
// LAB_PUERTO cambia la base de puertos (por defecto 3500: panel 3500, POS
// 3501-3503, central 3509), para tener dos laboratorios a la vez.
const BASE_PUERTO = Number(process.env.LAB_PUERTO || 3500);
const PANEL_PORT = BASE_PUERTO;
const SYNC_PORT = BASE_PUERTO + 9;
// Opciones por variable de entorno (lo que va después de "--" en npm le
// llegaría a la CLI de Firebase): LAB_TRES=1 tres sucursales; LAB_RAPIDO=1
// deja las sucursales creadas y las PC ya enlazadas.
const RAPIDO = process.env.LAB_RAPIDO === '1';
const PCS = [
  { nombre: 'PC-1', port: BASE_PUERTO + 1, sucursal: 'Principal' },
  { nombre: 'PC-2', port: BASE_PUERTO + 2, sucursal: 'Norte' },
  ...(process.env.LAB_TRES === '1' ? [{ nombre: 'PC-3', port: BASE_PUERTO + 3, sucursal: 'Sur' }] : []),
];

const db = admin.initializeApp({ projectId: 'demo-tecnocaja' }).firestore();
const central = createSucursalesCentral({ db });
let syncApi = null;
const procesos = [];

function encenderCentral() {
  if (syncApi) return Promise.resolve(false);
  return new Promise((resolve) => { syncApi = crearSyncApi({ db }).listen(SYNC_PORT, '127.0.0.1', () => resolve(true)); });
}
function apagarCentral() {
  if (!syncApi) return Promise.resolve(false);
  const s = syncApi;
  syncApi = null;
  return new Promise((resolve) => { s.closeAllConnections?.(); s.close(() => resolve(true)); });
}

function paginaPanel(quien) {
  const contador = quien === 'contador';
  return `<!doctype html><html${contador ? ' data-theme="light"' : ''}><head><meta charset="utf-8"><title>${contador ? 'Portal del contador' : 'Panel de Emilio'} · laboratorio</title>
    ${contador ? '<link rel="stylesheet" href="/contadores.css">' : ''}
    <style>body{margin:0;padding:24px;font-family:system-ui,Segoe UI,sans-serif;${contador ? 'background:var(--bg)' : 'background:#0f172a;color:#e2e8f0'}}
    .caja{max-width:1100px;margin:auto;padding:1rem 1.25rem;border-radius:12px;${contador ? 'background:var(--surface);border:1px solid var(--border)' : 'background:#111827;border:1px solid #1f2937'}}
    a{color:#60a5fa}#toast{font:13px system-ui;margin:10px auto;max-width:1100px;color:#94a3b8}</style></head>
    <body><div class="caja"><p style="margin:0 0 1rem"><a href="/">← Laboratorio</a> · <strong>${contador ? 'Portal del contador (Pérez & Asociados)' : 'Panel de Emilio (super administrador)'}</strong> · empresa ${NEGOCIO}</p>
    <div id="suc"></div></div><div id="toast"></div>
    <script src="/js/sucursales-central-ui.js"></script>
    <script>
      const api = async (method, ruta, body) => {
        const r = await fetch('/${quien}' + ruta, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        const data = await r.json(); if (!r.ok) throw new Error(data.error); return data;
      };
      SucursalesUI.montar(document.getElementById('suc'), { api, licenseId: ${JSON.stringify(LIC)},
        permisos: ${JSON.stringify(contador ? { limite: false, estado: false, revocar: false } : { limite: true, estado: true, revocar: true })},
        avisar: (m, t) => { document.getElementById('toast').textContent = (t === 'error' ? '⚠ ' : '✓ ') + m; } });
    </script></body></html>`;
}

function paginaInicio() {
  const pcs = PCS.map((pc) => `<li><a href="http://127.0.0.1:${pc.port}/" target="_blank">POS ${pc.nombre}</a> → http://127.0.0.1:${pc.port} (se enlaza como "${pc.sucursal}") · usuario <code>admin</code> clave <code>1234</code></li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Laboratorio multisucursal</title>
    <style>body{font-family:system-ui,Segoe UI,sans-serif;background:#0f172a;color:#e2e8f0;max-width:980px;margin:auto;padding:24px;line-height:1.5}
    a{color:#60a5fa}code{background:#1e293b;padding:.1rem .35rem;border-radius:4px}h2{margin-top:1.6rem;color:#93c5fd}
    button{padding:.5rem .9rem;border-radius:8px;border:1px solid #475569;background:#334155;color:#fff;cursor:pointer;margin-right:.4rem}
    .estado{display:inline-block;padding:.2rem .6rem;border-radius:99px;font-weight:600}.on{background:#064e3b;color:#6ee7b7}.off{background:#7f1d1d;color:#fca5a5}
    li{margin:.35rem 0}</style></head><body>
    <h1>Laboratorio multisucursal</h1>
    <p>Todo corre en esta PC: Firestore del emulador, la Sync API y los POS con sus propias bases. <strong>No toca Firebase real ni tus datos.</strong> Se borra al cerrar (Ctrl+C en la terminal).</p>
    <h2>Abrir</h2><ul>
      <li><a href="/emilio" target="_blank">Panel de Emilio</a> (límite, crear sucursales, códigos, PC, revocar, NCF, ventas)</li>
      <li><a href="/contador" target="_blank">Portal del contador</a> (crea y edita sucursales, códigos, NCF; no cambia el límite ni revoca)</li>
      ${pcs}
    </ul>
    <p style="color:#fbbf24">Al abrirlas, <b>las dos PC dicen "Sucursal Principal"</b>: así queda toda instalación nueva. Cada una toma el nombre de su sucursal ("Principal", "Norte") cuando le escribes su código de equipo (paso 2).</p>
    <h2>La central (simula Internet)</h2>
    <p>Central: <span id="estado" class="estado">…</span> <button onclick="central('apagar')">Apagar (sin Internet)</button><button onclick="central('encender')">Encender</button>
      <button onclick="if (confirm('¿Cerrar el laboratorio? Se borra todo.')) fetch('/laboratorio/cerrar', { method: 'POST' }).then(() => document.body.innerHTML = '<h1>Laboratorio cerrado</h1>')" style="float:right">Cerrar laboratorio</button></p>
    <p style="color:#94a3b8">Nota: el POS deja entrar hasta 10 veces cada 15 minutos por PC (protección contra adivinar claves). Si sale "Demasiados intentos", espera o cierra y vuelve a abrir el laboratorio.</p>
    <h2>Guía de prueba</h2><ol>
      <li><b>Panel de Emilio:</b> sube el límite a ${PCS.length}. Crea ${PCS.map((p) => `"${p.sucursal}"`).join(', ')} (la primera es la principal). Prueba que el contador no puede pasar del límite.</li>
      <li><b>Código de equipo</b> de "Principal" → en el POS PC-1: <i>Configuración</i> (menú izquierdo, o dentro de <i>Más</i>) → tarjeta <i>Mi Negocio</i> → <i>Sucursal conectada a Tecno Caja</i> → escribe el código y pulsa <i>Conectar esta PC</i>. Después genera el de <b>"Norte"</b> y escríbelo en <b>PC-2</b> (no en PC-1). En la pantalla de Caja, cada PC pasa a mostrar su sucursal.</li>
      <li><b>PC-1 (principal):</b> crea un producto y en <i>Catálogo de la empresa</i> elige "Todas las sucursales". O usa <i>Publicar todo el catálogo activo</i>.</li>
      <li><b>PC-2:</b> Configuración → <i>Sincronizar ahora</i>. El producto llega con el precio de la principal y existencia 0. Ábrelo: el nombre y el código están bloqueados; el precio no.</li>
      <li><b>PC-2:</b> cambia su precio, registra una compra o ajusta existencia y <b>haz una venta</b>. En PC-1 el precio y la existencia no cambian.</li>
      <li><b>Panel:</b> mira "PC autorizadas" (en línea, pendientes) y "Ventas por sucursal" después de sincronizar.</li>
      <li><b>PC-1:</b> crea un usuario y en <i>Sucursales de la empresa</i> marca solo "Norte". Sincroniza las dos PC → entra en PC-2 con ese usuario. En PC-2 no se puede editar.</li>
      <li><b>Sin Internet:</b> apaga la central aquí arriba → en PC-2 vende igual; la barra superior dice "Central sin conexión". En PC-1 publica otro producto con la central encendida, vuelve a apagarla, y al encender: PC-2 sube sus ventas y recibe el producto sola (o con <i>Sincronizar ahora</i>).</li>
      <li><b>Precio en varias sucursales:</b> en PC-1, Configuración → código del producto, precio y marca "Norte" → aplicar → sincroniza las dos.</li>
      <li><b>NCF:</b> en el panel, asigna a "Norte" un rango B02 (por ejemplo 1–500) → PC-2 sincroniza → en PC-2 haz una venta con comprobante B02: el NCF sale del rango. Prueba asignar un rango que se cruce: se rechaza.</li>
      <li><b>Conflicto:</b> en PC-2 crea un producto local con un código; en PC-1 publica uno con el mismo código → PC-2 lo marca "para revisar" → <i>Vincular</i>.</li>
      <li><b>Revocar:</b> en el panel de Emilio revoca la PC de Norte → PC-2 sincroniza: avisa que fue desconectada y sigue vendiendo.</li>
    </ol>
    <p>Registros de cada POS: <code>${L.WORK.replace(/\\/g, '\\\\')}</code></p>
    <script>
      async function pintar() { const r = await fetch('/laboratorio/central').then((x) => x.json()); const e = document.getElementById('estado'); e.textContent = r.encendida ? 'encendida' : 'apagada'; e.className = 'estado ' + (r.encendida ? 'on' : 'off'); }
      async function central(accion) { await fetch('/laboratorio/central/' + accion, { method: 'POST' }); pintar(); }
      pintar();
    </script></body></html>`;
}

function panel() {
  const app = express().use(express.json());
  const getCentral = () => createSucursalesCentral({ db });
  const sinAuth = (_req, _res, next) => next();
  app.use('/emilio/api/sucursales', createSucursalesRouter({ requireAuth: sinAuth, getCentral, actorDe: () => ({ tipo: 'super_admin', uid: 'emilio', nombre: 'Emilio' }) }));
  app.use('/contador/api/sucursales', createSucursalesRouter({ requireAuth: sinAuth, getCentral, actorDe: () => ({ tipo: 'contador', uid: 'conta', nombre: 'Pérez & Asociados', contadorId: 'firma-1' }) }));
  app.get('/js/sucursales-central-ui.js', (_req, res) => res.sendFile(path.join(L.PROJECT, 'js', 'sucursales-central-ui.js')));
  app.get('/contadores.css', (_req, res) => res.sendFile(path.join(L.PROJECT, 'tecno-caja-contadores', 'public', 'css', 'contadores.css')));
  app.get('/emilio', (_req, res) => res.send(paginaPanel('emilio')));
  app.get('/contador', (_req, res) => res.send(paginaPanel('contador')));
  app.get('/laboratorio/central', (_req, res) => res.json({ encendida: Boolean(syncApi) }));
  app.post('/laboratorio/central/apagar', async (_req, res) => { await apagarCentral(); res.json({ encendida: false }); });
  app.post('/laboratorio/central/encender', async (_req, res) => { await encenderCentral(); res.json({ encendida: true }); });
  app.post('/laboratorio/cerrar', (_req, res) => { res.json({ ok: true }); setTimeout(cerrar, 200); });
  app.get('/', (_req, res) => res.send(paginaInicio()));
  return new Promise((resolve) => { const s = app.listen(PANEL_PORT, '127.0.0.1', () => resolve(s)); });
}

async function prepararPos(pc) {
  const userData = path.join(L.WORK, `datos-${pc.nombre}`);
  const home = path.join(L.WORK, `home-${pc.nombre}`);
  for (const dir of [userData, home]) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
  const env = { DB_CLIENT: 'sqlite', USERPROFILE: home, HOME: home, TECNO_CAJA_SYNC_URL: `http://127.0.0.1:${SYNC_PORT}`, E2E_PLAN: 'plus' };
  let proc = L.startServer(`lab-${pc.nombre}`, { port: pc.port, userData, env });
  procesos.push(proc);
  await L.waitHttp(pc.port);
  const setup = await L.request(pc.port, 'POST', '/api/setup/complete', {
    language: 'es', businessType: 'ferreteria', businessStructureMode: 'monocaja', businessName: NEGOCIO,
    adminName: 'Admin', adminUser: 'admin', adminEmail: `admin@${pc.nombre.toLowerCase()}.lab`, adminPassword: '1234',
    openingAmount: 1000, currency: 'RD$',
  });
  if (setup.status !== 201) throw new Error(`${pc.nombre}: el asistente inicial falló (HTTP ${setup.status} ${setup.body?.error || ''})`);
  await L.stopServer(proc);
  const lic = L.seedLicense({ port: pc.port, userData, env });
  if (!lic.ok) throw new Error(`${pc.nombre}: no se pudo activar la licencia de prueba (${lic.detail})`);
  proc = L.startServer(`lab-${pc.nombre}`, { port: pc.port, userData, env });
  procesos.push(proc);
  await L.waitHttp(pc.port);
  pc.userData = userData;
  console.log(`  ✓ POS ${pc.nombre} listo en http://127.0.0.1:${pc.port}`);
}

// --rapido: deja ya creadas las sucursales y las PC enlazadas.
async function enlazarTodo() {
  await central.fijarLimite(LIC, PCS.length, { tipo: 'super_admin', uid: 'emilio', nombre: 'Emilio' });
  for (const pc of PCS) {
    const s = await central.crear(LIC, { nombre: pc.sucursal }, { tipo: 'super_admin', uid: 'emilio', nombre: 'Emilio' });
    const { codigo } = await central.generarCodigo(LIC, s.branchUuid, { tipo: 'super_admin', uid: 'emilio', nombre: 'Emilio' });
    const login = await L.request(pc.port, 'POST', '/api/login', { usuario: 'admin', password: '1234' });
    const r = await L.request(pc.port, 'POST', '/api/multisucursal/activar', { codigo }, login.body?.token);
    console.log(`  ✓ ${pc.nombre} enlazada como "${pc.sucursal}" (${r.status === 200 ? 'ok' : r.body?.error})`);
  }
}

async function cerrar() {
  console.log('\nCerrando el laboratorio…');
  for (const p of procesos) await L.stopServer(p);
  await apagarCentral();
  process.exit(0);
}

(async () => {
  console.log('Preparando el laboratorio multisucursal (tarda 1-2 minutos)…');
  L.prepareSandbox();
  await db.collection('licencias').doc(LIC).set({ businessName: NEGOCIO, status: 'active', contadorId: 'firma-1' });
  await encenderCentral();
  await panel();
  for (const pc of PCS) await prepararPos(pc);
  if (RAPIDO) await enlazarTodo();
  console.log(`
════════════════════════════════════════════════════════════════
  Laboratorio listo. Abre en Chrome:  http://127.0.0.1:${PANEL_PORT}
  (ahí están el panel de Emilio, el del contador, los POS y la guía)
  POS: ${PCS.map((pc) => `http://127.0.0.1:${pc.port}`).join('  ')}   usuario admin / 1234
  Para cerrar: Ctrl+C
════════════════════════════════════════════════════════════════`);
  process.on('SIGINT', cerrar);
  process.on('SIGTERM', cerrar);
  setInterval(() => {}, 60000);
})().catch(async (error) => {
  console.error('No se pudo preparar el laboratorio:', error.message);
  for (const p of procesos) await L.stopServer(p);
  process.exit(1);
});
