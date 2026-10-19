'use strict';

/**
 * Prueba la pantalla de sucursales (js/sucursales-central-ui.js) en un
 * navegador real contra las rutas y reglas reales, sobre el emulador de
 * Firestore. Simula el panel de Emilio y el portal del contador (con su
 * hoja de estilos, en modo noche y día) y guarda capturas.
 *
 *   npx -y firebase-tools@13.35.1 emulators:exec --config firebase.emulador.json \
 *     --only firestore --project demo-tecnocaja "node scripts/multisucursal/probar-pantalla-sucursales.js <carpeta>"
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const puppeteer = require('puppeteer');
const admin = require('firebase-admin');
const { createSucursalesCentral } = require('../../server/multisucursal/central/sucursales');
const { createSucursalesRouter } = require('../../server/multisucursal/central/sucursales.routes');
const { createSincronizacionCentral } = require('../../server/multisucursal/central/sincronizacion-central');
const crypto = require('crypto');

const RAIZ = path.join(__dirname, '..', '..');
const SALIDA = process.argv[2] || path.join(os.tmpdir(), 'tecnocaja-pantalla-sucursales');
const LIC = 'pos:tecno-caja-farmacia-del-pueblo';
const resultados = [];
const check = (nombre, ok, detalle = '') => {
  resultados.push(ok);
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
};

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Correr dentro de firebase emulators:exec (ver encabezado).');
  process.exit(1);
}

const db = admin.initializeApp({ projectId: 'demo-tecnocaja' }).firestore();

function servidor({ actorDe, permisos, conEstilosDelPortal, tema }) {
  const app = express().use(express.json());
  app.use('/api/sucursales', createSucursalesRouter({
    requireAuth: (_req, _res, next) => next(),
    getCentral: () => createSucursalesCentral({ db }),
    actorDe,
  }));
  app.get('/js/sucursales-central-ui.js', (_req, res) => res.sendFile(path.join(RAIZ, 'js', 'sucursales-central-ui.js')));
  app.get('/contadores.css', (_req, res) => res.sendFile(path.join(RAIZ, 'tecno-caja-contadores', 'public', 'css', 'contadores.css')));
  app.get('/', (_req, res) => res.send(`<!doctype html><html${tema ? ` data-theme="${tema}"` : ''}><head><meta charset="utf-8">
    ${conEstilosDelPortal ? '<link rel="stylesheet" href="/contadores.css">' : ''}
    <style>body{margin:0;padding:24px;font-family:system-ui,Segoe UI,sans-serif;${conEstilosDelPortal ? 'background:var(--bg)' : 'background:#0f172a'}}
    .caja{max-width:980px;padding:1rem;border-radius:12px;${conEstilosDelPortal ? 'background:var(--surface);border:1px solid var(--border)' : 'background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08)'}}</style>
    </head><body><div class="caja"><div id="suc"></div></div><div id="toast" style="font:13px system-ui;color:#94a3b8;margin-top:8px"></div>
    <script src="/js/sucursales-central-ui.js"></script>
    <script>
      window.confirm = () => true;
      const api = async (method, ruta, body) => {
        const r = await fetch(ruta, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        const data = await r.json(); if (!r.ok) throw new Error(data.error); return data;
      };
      SucursalesUI.montar(document.getElementById('suc'), { api, licenseId: ${JSON.stringify(LIC)}, permisos: ${JSON.stringify(permisos)},
        avisar: (m, t) => { document.getElementById('toast').textContent = '[' + t + '] ' + m; } });
    </script></body></html>`));
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}

async function esperar(page, texto) {
  try {
    // textContent (no innerText): el título lleva text-transform en mayúsculas.
    await page.waitForFunction((t) => document.body.textContent.includes(t), { timeout: 15000 }, texto);
  } catch (error) {
    const visto = await page.evaluate(() => document.body.textContent).catch(() => '');
    throw new Error(`No apareció "${texto}". En pantalla: ${visto.slice(0, 400)}`);
  }
}

async function escribir(page, form, datos) {
  for (const [campo, valor] of Object.entries(datos)) {
    const sel = `form[data-form="${form}"] input[name="${campo}"]`;
    await page.$eval(sel, (el) => { el.value = ''; });
    await page.type(sel, valor);
  }
  await page.click(`form[data-form="${form}"] button[type="submit"]`);
}

(async () => {
  fs.mkdirSync(SALIDA, { recursive: true });
  await db.collection('licencias').doc(LIC).set({ businessName: 'Farmacia del Pueblo', status: 'active', contadorId: 'firma-1' });

  const sAdmin = await servidor({
    actorDe: () => ({ tipo: 'super_admin', uid: 'emilio', nombre: 'Emilio' }),
    permisos: { limite: true, estado: true, revocar: true },
  });
  const sConta = await servidor({
    actorDe: () => ({ tipo: 'contador', uid: 'conta', nombre: 'Pérez & Asociados', contadorId: 'firma-1' }),
    permisos: { limite: false, estado: false },
    conEstilosDelPortal: true,
  });
  const sContaDia = await servidor({
    actorDe: () => ({ tipo: 'contador', uid: 'conta', nombre: 'Pérez & Asociados', contadorId: 'firma-1' }),
    permisos: { limite: false, estado: false },
    conEstilosDelPortal: true,
    tema: 'light',
  });
  const url = (s) => `http://127.0.0.1:${s.address().port}/`;
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 760 });

    // ── Panel de Emilio ─────────────────────────────────────────────────
    await page.goto(url(sAdmin));
    await esperar(page, 'Sucursales (0 de 1 permitidas)');
    check('Emilio: ve el límite y el formulario', Boolean(await page.$('#suc-limite')) && Boolean(await page.$('form[data-form="crear"]')));
    await page.$eval('#suc-limite', (el) => { el.value = '3'; });
    await page.click('button[data-accion="limite"]');
    await esperar(page, 'Sucursales (0 de 3 permitidas)');
    check('Emilio: sube el límite a 3', true);
    await escribir(page, 'crear', { nombre: 'Principal', codigo: 'suc-01', direccion: 'Calle Duarte 10', telefono: '809-555-0101', encargado: 'Ana' });
    await esperar(page, 'Sucursales (1 de 3 permitidas)');
    check('Emilio: crea la sucursal principal', (await page.content()).includes('Principal</span>'));

    // ── Portal del contador (noche) ─────────────────────────────────────
    await page.goto(url(sConta));
    await esperar(page, 'Sucursales (1 de 3 permitidas)');
    check('Contador: no ve el límite ni activar/desactivar', !(await page.$('#suc-limite')) && !(await page.$('button[data-accion="desactivar"]')));
    await escribir(page, 'crear', { nombre: 'Los Alcarrizos', codigo: 'SUC-02', direccion: 'Av. Duarte km 14', telefono: '809-555-0202', encargado: 'Luis' });
    await esperar(page, 'Sucursales (2 de 3 permitidas)');
    await escribir(page, 'crear', { nombre: '<b>Villa Mella</b>', codigo: 'SUC-03', direccion: '', telefono: '', encargado: '' });
    await esperar(page, 'Sucursales (3 de 3 permitidas)');
    check('Contador: el nombre con HTML se muestra como texto', (await page.$$eval('td strong', (els) => els.map((e) => e.textContent))).includes('<b>Villa Mella</b>'));
    check('Contador: con el límite lleno no hay formulario y ve el aviso',
      !(await page.$('form[data-form="crear"]')) && (await page.content()).includes('Solo el administrador de Tecno Caja puede ampliarlo'));
    await page.click('button[data-accion="codigo"]');
    await page.waitForSelector('.suc-codigo', { timeout: 15000 });
    const codigo = await page.$eval('.suc-codigo', (el) => el.textContent);
    check('Contador: genera el código de equipo', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(codigo), codigo);
    await page.screenshot({ path: path.join(SALIDA, 'contador-noche.png'), fullPage: true });

    // Editar desde el portal.
    await page.click('button[data-accion="cerrar-codigo"]');
    const botonesEditar = await page.$$('button[data-accion="editar"]');
    await botonesEditar[1].click();
    await escribir(page, 'editar', { telefono: '809-555-9999' });
    await esperar(page, '809-555-9999');
    check('Contador: edita los datos', true);

    // ── PC autorizadas (como si la Sync API las hubiera activado) ───────
    // Con el código que generó el contador se activa una PC; luego otra la
    // reemplaza (con pendientes por enviar) y otra sucursal tiene una PC que
    // dejó de conectarse hace 2 horas.
    const central = createSucursalesCentral({ db });
    const emilio = { tipo: 'super_admin', uid: 'emilio', nombre: 'Emilio' };
    const hash = (c) => c.repeat(64);
    await central.activarEquipo(codigo, { hostname: 'CAJA-VIEJA', appVersion: '1.4.5' }, { equipoId: 'eq-vieja', tokenHash: hash('a') });
    const suc1 = (await db.collection('equipos_sync').doc('eq-vieja').get()).data().branchUuid;
    const cod2 = await central.generarCodigo(LIC, suc1, emilio);
    await central.activarEquipo(cod2.codigo, { hostname: 'CAJA-NUEVA', appVersion: '1.4.6' }, { equipoId: 'eq-nueva', tokenHash: hash('b') });
    await db.collection('equipos_sync').doc('eq-nueva').update({ ultimaConexion: new Date(), latido: { modo: 'normal', pendientes: { salida: 3, errores: 0 } } });
    const sucs = await db.collection('licencias').doc(LIC).collection('sucursales').get();
    const suc2 = sucs.docs.find((d) => d.id !== suc1);
    const cod3 = await central.generarCodigo(LIC, suc2.id, emilio);
    await central.activarEquipo(cod3.codigo, { hostname: 'CAJA-ALCARRIZOS', appVersion: '1.4.6' }, { equipoId: 'eq-otra', tokenHash: hash('c') });
    await db.collection('equipos_sync').doc('eq-otra').update({ ultimaConexion: new Date(Date.now() - 2 * 3600 * 1000) });

    await page.goto(url(sConta));
    await esperar(page, 'PC autorizadas');
    const fila = (id) => page.$eval(`tr[data-equipo="${id}"]`, (tr) => tr.textContent).catch(() => null);
    const nueva = await fila('eq-nueva');
    check('Contador: ve la PC en línea con sus pendientes', Boolean(nueva) && nueva.includes('En línea') && nueva.includes('3 por enviar') && nueva.includes('v1.4.6'), nueva);
    const otra = await fila('eq-otra');
    check('Contador: la PC que no se conecta sale "Sin conexión"', Boolean(otra) && otra.includes('Sin conexión') && otra.includes('hace 2 h'), otra);
    check('Contador: la reemplazada queda oculta y no hay botón revocar',
      !(await fila('eq-vieja')) && !(await page.$('button[data-accion="revocar"]')));
    check('Contador: la fila de la sucursal resume su PC', (await page.content()).includes('PC: <span class="suc-badge suc-activa">En línea</span>'));
    await page.click('button[data-accion="ver-anteriores"]');
    const vieja = await fila('eq-vieja');
    check('Contador: "Ver anteriores" muestra la reemplazada', Boolean(vieja) && vieja.includes('Reemplazada'), vieja);
    await page.screenshot({ path: path.join(SALIDA, 'contador-equipos.png'), fullPage: true });

    // ── Portal del contador (día) ───────────────────────────────────────
    await page.goto(url(sContaDia));
    await esperar(page, 'Sucursales (3 de 3 permitidas)');
    await page.screenshot({ path: path.join(SALIDA, 'contador-dia.png'), fullPage: true });
    check('Contador (día): se ve con el tema claro', await page.$eval('html', (h) => h.getAttribute('data-theme') === 'light'));

    // ── Emilio desactiva una y el contador recupera el cupo ─────────────
    await page.goto(url(sAdmin));
    await esperar(page, 'Sucursales (3 de 3 permitidas)');
    const desactivar = await page.$$('button[data-accion="desactivar"]');
    await desactivar[desactivar.length - 1].click();
    await esperar(page, 'Sucursales (2 de 3 permitidas)');
    check('Emilio: desactiva una sucursal y se libera un cupo', Boolean(await page.$('form[data-form="crear"]')));

    check('Emilio: tiene "Revocar" en las dos PC activas', (await page.$$('button[data-accion="revocar"]')).length === 2);
    await page.click('tr[data-equipo="eq-otra"] button[data-accion="revocar"]');
    await esperar(page, 'Ver anteriores (2)');
    const revocada = (await db.collection('equipos_sync').doc('eq-otra').get()).data();
    check('Emilio: revoca la PC y queda registrado quién lo hizo', revocada.estado === 'revocado' && revocada.revocadoPor?.uid === 'emilio');
    await page.click('button[data-accion="ver-anteriores"]');
    await page.waitForSelector('tr[data-equipo="eq-otra"]', { timeout: 15000 });
    check('Emilio: la revocada se ve como "Revocada"', (await page.$eval('tr[data-equipo="eq-otra"]', (tr) => tr.textContent)).includes('Revocada'));
    check('Emilio: alerta de PC que todavía no sincroniza', (await page.$eval('tr[data-equipo="eq-nueva"]', (tr) => tr.textContent)).includes('sin sincronizar'));

    // ── Ventas por sucursal (lo que ya sincronizó cada una) ─────────────
    const sync = createSincronizacionCentral({ db });
    const hoyRd = new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10);
    const venta = (total) => ({ eventId: crypto.randomUUID(), entityType: 'venta', entityUuid: crypto.randomUUID(), operation: 'registrar', payload: { fechaOperativa: hoyRd, total, estado: 'pagada' } });
    await sync.procesarEventos({ licenseId: LIC, branchUuid: suc1, esPrincipal: true }, [venta(1500), venta(250.5)]);
    await page.click('button[data-accion="recargar"]');
    await esperar(page, 'Ventas por sucursal');
    const filaVentas = await page.$eval(`tr[data-ventas="${suc1}"]`, (tr) => tr.textContent);
    check('Emilio: ventas de hoy por sucursal', filaVentas.includes('1,750.50') && filaVentas.includes('2 venta(s)'), filaVentas);

    // ── Rangos NCF desde el portal del contador ─────────────────────────
    await page.goto(url(sConta));
    await esperar(page, 'Comprobantes fiscales (NCF) por sucursal');
    const asignar = async (desde, hasta) => {
      await page.$eval('form[data-form="ncf"] select[name="branchUuid"]', (s, v) => { s.value = v; }, suc1);
      await page.$eval('form[data-form="ncf"] input[name="desde"]', (i, v) => { i.value = v; }, String(desde));
      await page.$eval('form[data-form="ncf"] input[name="hasta"]', (i, v) => { i.value = v; }, String(hasta));
      await page.click('form[data-form="ncf"] button[type="submit"]');
    };
    await asignar(1, 500);
    await esperar(page, 'Asignado, sin recibir');
    check('Contador: asigna un rango B02 a una sucursal', (await page.$$('tr[data-rango]')).length === 1);
    await asignar(400, 900);
    await esperar(page, 'chocan con el rango');
    check('Contador: un rango que se cruza se rechaza con aviso', (await page.$$('tr[data-rango]')).length === 1);
    await page.screenshot({ path: path.join(SALIDA, 'contador-ncf.png'), fullPage: true });
    await page.click('button[data-accion="ncf-anular"]');
    await esperar(page, 'Anulado');
    check('Contador: anula un rango que la sucursal no usó', !(await page.$('button[data-accion="ncf-anular"]')));

    await page.goto(url(sAdmin));
    await esperar(page, 'Comprobantes fiscales (NCF) por sucursal');
    await page.screenshot({ path: path.join(SALIDA, 'emilio.png'), fullPage: true });

    const hist = await db.collection('licencias').doc(LIC).collection('sucursales_historial').get();
    check('Historial con cada acción y quién la hizo', hist.size >= 7, `${hist.size} registros`);
  } catch (error) {
    check('Sin excepciones', false, error.stack);
  } finally {
    await browser.close();
    sAdmin.close(); sConta.close(); sContaDia.close();
  }
  const fallas = resultados.filter((ok) => !ok).length;
  console.log(`\n${resultados.length - fallas}/${resultados.length} comprobaciones OK · capturas en ${SALIDA}`);
  process.exit(fallas ? 1 : 0);
})();
