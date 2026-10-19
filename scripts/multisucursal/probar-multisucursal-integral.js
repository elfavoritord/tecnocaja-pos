'use strict';

/**
 * Prueba integral multisucursal (Fase 8): DOS servidores reales del POS
 * (server.js en SQLite, cada uno con su base) + la Sync API real, sobre el
 * emulador de Firestore. Todo por la API HTTP del POS, como lo usa la pantalla.
 *
 *   node cloud/sync-api/scripts/vendor-sync.js
 *   npx -y firebase-tools@13.35.1 emulators:exec --config firebase.emulador.json \
 *     --only firestore --project demo-tecnocaja "node scripts/multisucursal/probar-multisucursal-integral.js"
 *   (o: npm run test:multisucursal-integral)
 *
 * Recorre las pruebas de aceptación del prompt maestro que necesitan el POS
 * entero: empresa con dos sucursales, PC nueva que carga solo su sucursal,
 * producto global que llega, precio independiente, venta real que descuenta
 * solo en su sucursal, usuario que entra solo donde lo asignaron, sin Internet
 * hacia la central sigue vendiendo y al volver se pone al día, reinicio con
 * cambios pendientes, rangos NCF por sucursal en una venta real con B02.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-ms-integral');
const L = require('../e2e-lan/lib');
const admin = require('firebase-admin');
const { createApp: crearSyncApi } = require('../../cloud/sync-api/lib/app');
const { createSucursalesCentral } = require('../../server/multisucursal/central/sucursales');
const { createSincronizacionCentral } = require('../../server/multisucursal/central/sincronizacion-central');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Correr dentro de firebase emulators:exec (ver encabezado).');
  process.exit(1);
}

const LIC = 'pos:tecno-caja-ferreteria-integral';
const EMILIO = { tipo: 'super_admin', uid: 'emilio', nombre: 'Emilio' };
const CONTADORA = { tipo: 'contador', uid: 'conta', nombre: 'Pérez & Asociados', contadorId: 'firma-1' };
const SYNC_PORT = 3499;
const SYNC_URL = `http://127.0.0.1:${SYNC_PORT}`;

const db = admin.initializeApp({ projectId: 'demo-tecnocaja' }).firestore();
const central = createSucursalesCentral({ db });
const centralSync = createSincronizacionCentral({ db });

let syncApi = null;
function levantarSyncApi() {
  return new Promise((resolve) => { syncApi = crearSyncApi({ db }).listen(SYNC_PORT, '127.0.0.1', () => resolve(syncApi)); });
}
function apagarSyncApi() {
  return new Promise((resolve) => { if (!syncApi) return resolve(); syncApi.closeAllConnections?.(); syncApi.close(() => resolve()); syncApi = null; });
}

// Una PC de sucursal: su carpeta, su base SQLite y su servidor.
function crearPc(nombre, port) {
  const userData = path.join(L.WORK, `pc-${nombre}`);
  const home = path.join(L.WORK, `home-${nombre}`);
  for (const dir of [userData, home]) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
  const env = { DB_CLIENT: 'sqlite', USERPROFILE: home, HOME: home, TECNO_CAJA_SYNC_URL: SYNC_URL, E2E_PLAN: 'plus' };
  return { nombre, port, userData, env, proc: null, token: '', boot: null };
}

async function arrancar(pc) {
  pc.proc = L.startServer(`pos-${pc.nombre}`, { port: pc.port, userData: pc.userData, env: pc.env });
  await L.waitHttp(pc.port);
}

async function entrar(pc, usuario = 'admin', password = '1234') {
  const r = await L.request(pc.port, 'POST', '/api/login', { usuario, password });
  if (usuario === 'admin') { pc.token = r.body?.token || ''; pc.boot = r.body?.data || {}; }
  return r;
}

async function prepararPc(pc, negocio) {
  await arrancar(pc);
  const setup = await L.request(pc.port, 'POST', '/api/setup/complete', {
    language: 'es', businessType: 'ferreteria', businessStructureMode: 'monocaja',
    businessName: negocio, adminName: 'Admin', adminUser: 'admin', adminEmail: `admin@${pc.nombre}.test`,
    adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
  });
  L.check(`${pc.nombre}: negocio configurado (SQLite)`, setup.status === 201, `HTTP ${setup.status}`);
  await L.stopServer(pc.proc);
  const lic = L.seedLicense({ port: pc.port, userData: pc.userData, env: pc.env });
  L.check(`${pc.nombre}: licencia activa para reiniciar`, lic.ok, lic.detail);
  await arrancar(pc);
  await entrar(pc);
}

const api = (pc, method, ruta, body) => L.request(pc.port, method, ruta, body, pc.token);
const sincronizar = (pc) => api(pc, 'POST', '/api/multisucursal/sincronizar?esperar=1', {});
async function productos(pc) {
  const r = await api(pc, 'GET', '/api/products?todasLasSucursales=1');
  return r.body?.products || r.body || [];
}
const producto = async (pc, codigo) => (await productos(pc)).find((p) => p.codigo === codigo);

let intento = 0;
function venta(pc, prod, extra = {}) {
  intento += 1;
  const precio = Number(prod.precioVenta);
  return api(pc, 'POST', '/api/sales', {
    userId: 1, clientId: null, cliente: 'Consumidor Final', tipoComprobante: 'ticket', ncfType: null,
    metodo: 'efectivo', tipoPedido: 'mostrador',
    items: [{ id: prod.id, codigo: prod.codigo, nombre: prod.nombre, qty: 1, precio, descuento: 0, itbis: 0, itbisModo: 'porcentaje', total: precio, subtotal: precio, impuestoMonto: 0, saleMode: 'unidad' }],
    subtotal: precio, descuento: 0, itbis: 0, total: precio, recibido: precio, cambio: 0,
    branchId: pc.boot.sucursales?.[0]?.id, cashRegisterId: pc.boot.cajasSucursal?.[0]?.id,
    clientRequestId: `ms${Date.now().toString(16)}${String(intento).padStart(4, '0')}`,
    ...extra,
  });
}

(async () => {
  const centro = crearPc('centro', 3497);
  const norte = crearPc('norte', 3498);
  try {
    L.prepareSandbox();
    await levantarSyncApi();

    // ── 1. Empresa con dos sucursales; cada PC se activa con su código ───
    await db.collection('licencias').doc(LIC).set({ businessName: 'Ferretería Integral', status: 'active', contadorId: 'firma-1' });
    await central.fijarLimite(LIC, 2, EMILIO);
    const sCentro = await central.crear(LIC, { nombre: 'Centro', codigo: 'CEN' }, CONTADORA);
    const sNorte = await central.crear(LIC, { nombre: 'Norte', codigo: 'NOR' }, CONTADORA);
    await expectRechazo(() => central.crear(LIC, { nombre: 'Tercera' }, CONTADORA), 'LIMITE_SUCURSALES', '19. el límite de sucursales de la licencia se respeta');

    await prepararPc(centro, 'Ferretería (centro sin enlazar)');
    await prepararPc(norte, 'Ferretería (norte sin enlazar)');
    for (const [pc, s] of [[centro, sCentro], [norte, sNorte]]) {
      const { codigo } = await central.generarCodigo(LIC, s.branchUuid, CONTADORA);
      const r = await api(pc, 'POST', '/api/multisucursal/activar', { codigo });
      L.check(`3. ${pc.nombre}: la PC nueva se activa como "${s.nombre}" y carga esa sucursal`, r.status === 200 && r.body?.enlace?.sucursal?.nombre === s.nombre && r.body.enlace.vinculado, `HTTP ${r.status} ${r.body?.error || ''}`);
    }
    await entrar(centro);
    await entrar(norte);
    L.check('Central: la primera sucursal es la principal', (await api(centro, 'GET', '/api/multisucursal/estado')).body?.enlace?.sucursal?.esPrincipal === true);

    // ── 4. Producto global creado en la principal llega a Norte ──────────
    const crear = await api(centro, 'POST', '/api/products', {
      codigo: 'INT-001', barcode: 'INT-001', nombre: 'Taladro 1/2"', categoria: 'Herramientas', unidad: 'Unidad', marca: '',
      precioVenta: 3500, precioCompra: 2500, stock: 12, stockMin: 1, aplicaItbis: false, estado: 'Activo', alcanceEmpresa: 'global',
    });
    L.check('4. Principal: crea un producto de la empresa (alcance global)', crear.status === 201 && crear.body?.alcanceEmpresa === 'global', `HTTP ${crear.status} ${crear.body?.error || crear.body?.alcanceEmpresa}`);
    const c1 = await sincronizar(centro);
    L.check('Principal: sincroniza y sube el producto', c1.body?.ciclo?.resultado === 'ok', JSON.stringify(c1.body?.ciclo || c1.body));
    const n1 = await sincronizar(norte);
    const enNorte = await producto(norte, 'INT-001');
    L.check('4. Norte: recibe el producto con la misma identidad y el precio sugerido', n1.body?.ciclo?.resultado === 'ok' && enNorte && enNorte.precioVenta === 3500 && enNorte.stock === 0 && enNorte.origenCatalogo === 'central',
      JSON.stringify(enNorte && { precio: enNorte.precioVenta, stock: enNorte.stock, origen: enNorte.origenCatalogo }));

    // ── 5. Precio local de Norte; el nombre lo manda la central ──────────
    const editar = await api(norte, 'PUT', `/api/products/${enNorte.id}`, { ...enNorte, nombre: 'Nombre cambiado en Norte', precioVenta: 3300, stock: 5 });
    L.check('5. Norte: cambia su precio (3300) y su existencia; el nombre maestro no cambia', editar.status === 200 && editar.body?.precioVenta === 3300 && editar.body?.nombre === 'Taladro 1/2"',
      `HTTP ${editar.status} ${editar.body?.nombre} ${editar.body?.precioVenta}`);
    await sincronizar(norte);
    await sincronizar(centro);
    L.check('5. Principal: su precio sigue en 3500', (await producto(centro, 'INT-001')).precioVenta === 3500);
    const borrar = await api(norte, 'DELETE', `/api/products/${enNorte.id}`);
    L.check('11. Norte: un producto de la empresa no se borra (se pone inactivo)', borrar.status === 409 && borrar.body?.code === 'PRODUCTO_DE_EMPRESA', `HTTP ${borrar.status} ${borrar.body?.code}`);

    // ── 6. Venta real en Norte: descuenta solo en Norte ──────────────────
    const v1 = await venta(norte, await producto(norte, 'INT-001'));
    L.check('6. Norte: venta real por la API del POS', v1.status === 201 || v1.status === 200, `HTTP ${v1.status} ${v1.body?.error || ''}`);
    L.check('6. Norte: su existencia baja a 4', (await producto(norte, 'INT-001')).stock === 4);
    L.check('6. Principal: su existencia no cambia (12)', (await producto(centro, 'INT-001')).stock === 12);
    await sincronizar(norte);
    const resumen = await centralSync.resumenOperacion(LIC, CONTADORA);
    const filaNorte = resumen.sucursales.find((s) => s.nombre === 'Norte');
    L.check('Central: la venta de Norte llega al resumen de la empresa', filaNorte?.periodo?.ventas === 1 && filaNorte.periodo.total === 3300, JSON.stringify(filaNorte?.periodo));

    // ── 2. Usuario de la empresa asignado solo a Norte ───────────────────
    const usuario = await api(centro, 'POST', '/api/users', {
      nombre: 'Ana Supervisora', usuario: 'ana.norte', password: 'clave-ana-1', roleCode: 'supervisor', billingType: 'mixta', estado: 'Activo',
      branchId: centro.boot.sucursales?.[0]?.id, sucursalesEmpresa: [sNorte.branchUuid],
    });
    L.check('2. Principal: crea un usuario y lo asigna solo a Norte', usuario.status === 201 && JSON.stringify(usuario.body?.sucursalesEmpresa) === JSON.stringify([sNorte.branchUuid]), `HTTP ${usuario.status} ${usuario.body?.error || ''}`);
    await sincronizar(centro);
    await sincronizar(norte);
    const loginAna = await entrar(norte, 'ana.norte', 'clave-ana-1');
    L.check('2-3. Norte: Ana entra con su clave (que nunca viajó en texto)', loginAna.status === 200 && Boolean(loginAna.body?.token), `HTTP ${loginAna.status} ${loginAna.body?.error || ''}`);
    const anaNorte = ((await entrar(norte)).body?.data?.users || []).find((u) => u.usuario === 'ana.norte');
    const editarAna = await api(norte, 'PUT', `/api/users/${anaNorte?.id}`, { nombre: 'Otra' });
    L.check('13. Norte: el usuario de la empresa no se edita en la sucursal (se administra en la principal)', editarAna.status === 403, `HTTP ${editarAna.status} ${editarAna.body?.error || ''}`);
    const usuarioEnCentral = (await db.collection('licencias').doc(LIC).collection('usuarios').get()).docs.map((d) => d.data());
    L.check('14. La central guarda solo la huella de la clave', usuarioEnCentral.length === 1 && /^scrypt:/.test(usuarioEnCentral[0].passwordHash) && !JSON.stringify(usuarioEnCentral).includes('clave-ana-1'));

    // ── 7/14. Sin conexión con la central: Norte vende igual ─────────────
    await apagarSyncApi();
    const v2 = await venta(norte, await producto(norte, 'INT-001'));
    L.check('14. Sin la central: Norte sigue vendiendo', v2.status === 201 || v2.status === 200, `HTTP ${v2.status}`);
    const sinRed = await sincronizar(norte);
    L.check('Sin la central: el ciclo queda "sin conexión", con pendientes', sinRed.body?.ciclo?.resultado === 'sin_conexion' && sinRed.body?.sincronizacion?.pendientes > 0, JSON.stringify({ r: sinRed.body?.ciclo?.resultado, p: sinRed.body?.sincronizacion?.pendientes }));
    const indicador = await api(norte, 'GET', '/api/multisucursal/indicador');
    L.check('Barra de estado: avisa "sin conexión" y que vende normal', indicador.body?.indicador?.nivel === 'sin_conexion' && /vendiendo normal/.test(indicador.body.indicador.texto), indicador.body?.indicador?.texto);
    // Mientras tanto la principal publica otro producto (lo hace con la central arriba).
    await levantarSyncApi();
    await api(centro, 'POST', '/api/products', {
      codigo: 'INT-002', barcode: 'INT-002', nombre: 'Brocas x10', categoria: 'Herramientas', unidad: 'Unidad', marca: '',
      precioVenta: 450, precioCompra: 300, stock: 30, stockMin: 1, aplicaItbis: false, estado: 'Activo', alcanceEmpresa: 'global',
    });
    await sincronizar(centro);
    await apagarSyncApi();

    // ── 9. Reinicio de Norte con cambios pendientes ──────────────────────
    await L.stopServer(norte.proc);
    await arrancar(norte);
    await entrar(norte);
    await levantarSyncApi();
    // Sin tocar nada: al hablar con la central, lo que falló por la red sale
    // en el mismo ciclo (sin esperar la espera creciente).
    const vuelta = await sincronizar(norte);
    const ventasNorte = await db.collection('licencias').doc(LIC).collection('sucursales').doc(sNorte.branchUuid).collection('ventas').get();
    L.check('9. Norte reiniciada: recupera su cola y la venta sin Internet llega a la central', ventasNorte.size === 2, `${ventasNorte.size} ventas en la central · pendientes ${vuelta.body?.sincronizacion?.pendientes}`);
    L.check('7. Norte: al volver la conexión recibe el producto publicado mientras estaba fuera', Boolean(await producto(norte, 'INT-002')));
    const repetir = await sincronizar(norte);
    L.check('8. Repetir la sincronización no duplica nada', repetir.body?.ciclo?.resultado === 'ok' && (await productos(norte)).filter((p) => p.codigo === 'INT-002').length === 1
      && (await db.collection('licencias').doc(LIC).collection('sucursales').doc(sNorte.branchUuid).collection('ventas').get()).size === 2);

    // ── 17. NCF: la central asigna un rango a Norte y una venta B02 lo usa
    const rango = await centralSync.asignarRangoNcf(LIC, sNorte.branchUuid, { tipo: 'B02', desde: 7001, hasta: 7500, vence: '2027-12-31' }, CONTADORA);
    await expectRechazo(() => centralSync.asignarRangoNcf(LIC, sCentro.branchUuid, { tipo: 'B02', desde: 7400, hasta: 8000 }, CONTADORA), 'RANGO_SOLAPADO', '17. un rango que se cruza con el de otra sucursal se rechaza');
    await sincronizar(norte);
    const estadoNcf = (await api(norte, 'GET', '/api/multisucursal/sincronizacion')).body?.sincronizacion?.ncf || [];
    L.check('17. Norte: el rango queda "en uso"', estadoNcf.some((r) => r.rangoUuid === rango.rangoUuid && r.estado === 'en_uso'), JSON.stringify(estadoNcf));
    const conNcf = await venta(norte, await producto(norte, 'INT-001'), { tipoComprobante: 'B02', ncfType: 'B02' });
    const ncf = conNcf.body?.ncf || conNcf.body?.sale?.ncf || conNcf.body?.venta?.ncf || '';
    L.check('17. Norte: una venta B02 real toma su NCF del rango de la central', /^B02/.test(ncf) && Number(ncf.slice(3)) >= 7001 && Number(ncf.slice(3)) <= 7500, `HTTP ${conNcf.status} ncf ${ncf} ${conNcf.body?.error || ''}`);
    await sincronizar(norte);
    await api(norte, 'POST', '/api/multisucursal/sincronizar', {});
    const rangos = await centralSync.listarRangosNcf(LIC, EMILIO);
    const r1 = rangos.find((r) => r.rangoUuid === rango.rangoUuid);
    L.check('17. La central ve el rango en uso y cuántos quedan', r1?.estadoSucursal === 'en_uso' && r1.siguiente === 7002, JSON.stringify({ estado: r1?.estadoSucursal, siguiente: r1?.siguiente }));

    // ── 15/18. Sin conexiones entrantes: cada PC solo llama hacia afuera ─
    const equipos = await central.listarEquipos(LIC, EMILIO);
    L.check('18. Las dos PC se ven en el panel, en línea, solo con conexiones salientes HTTPS',
      equipos.filter((e) => e.estado === 'activo').length === 2 && equipos.every((e) => e.latido?.recibidoEn), equipos.map((e) => `${e.hostname}:${e.estado}`).join(', '));

    const bitacora = await api(norte, 'GET', '/api/multisucursal/bitacora?limite=50');
    L.check('Observabilidad: cada ciclo queda en la bitácora con su resultado, bytes y duración', (bitacora.body?.ciclos || []).length >= 5
      && bitacora.body.ciclos.some((c) => c.resultado === 'sin_conexion') && bitacora.body.ciclos.every((c) => Number.isFinite(Number(c.duracion_ms))));

    await probarPantallas(centro, norte);
  } catch (error) {
    L.check('Sin excepciones', false, error.stack);
  } finally {
    await L.stopServer(centro.proc);
    await L.stopServer(norte.proc);
    await apagarSyncApi();
  }
  const fallas = L.results.filter((r) => !r.ok);
  console.log(`\n${L.results.length - fallas.length}/${L.results.length} comprobaciones OK · registros en ${L.WORK}`);
  process.exit(fallas.length ? 1 : 0);
})();

// ── Pantallas del POS en Chrome ──────────────────────────────────────────
// Un arnés con la sección de Configuración y los bloques de los formularios
// (js/multisucursal-enlace.js) que reenvía /api/multisucursal al POS real.
async function probarPantallas(centro, norte) {
  const express = require('express');
  const puppeteer = require('puppeteer');
  const SALIDA = process.argv[2] || path.join(L.WORK, 'capturas');
  fs.mkdirSync(SALIDA, { recursive: true });

  function arnes(pc) {
    const app = express().use(express.json());
    app.get('/', (_req, res) => res.send(`<!doctype html><html><head><meta charset="utf-8">
      <style>body{font-family:system-ui,Segoe UI,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px}
      .hidden{display:none}.config-section{max-width:820px;padding:1rem 1.25rem;border-radius:12px;background:#1e293b;border:1px solid #334155;margin-bottom:1rem}
      .form-input{padding:.45rem .6rem;border-radius:8px;border:1px solid #475569;background:#0f172a;color:#e2e8f0}
      .btn-primary,.btn-secondary{padding:.45rem .8rem;border-radius:8px;border:1px solid #475569;background:#334155;color:#fff;cursor:pointer}
      .helper-text{display:block;color:#94a3b8;font-size:.82rem;margin-top:.35rem}.data-table td,.data-table th{padding:.3rem .5rem;text-align:left;border-bottom:1px solid #334155}
      .config-lock-note{padding:.6rem .8rem;border-radius:8px;background:rgba(245,158,11,.12);color:#fbbf24;font-size:.85rem}
      .form-group{margin:.6rem 0}label{display:block;font-size:.85rem;margin-bottom:.3rem;color:#cbd5e1}</style></head><body>
      <div class="config-section hidden" id="cfg-multisucursal-section"><h3>Sucursal conectada a Tecno Caja</h3><div id="cfg-multisucursal-body"></div></div>
      <div class="config-section"><h3>Formulario de producto</h3><input id="mp-codigo" class="form-input" value="X"><input id="mp-nombre" class="form-input" value="Y"><div id="mp-empresa-scope"></div></div>
      <div class="config-section" id="eu-panel-config"><h3>Formulario de usuario</h3></div>
      <div id="toast"></div>
      <script>window.getTecnoCajaAuthToken = () => ${JSON.stringify(pc.token)};
        window.showToast = (m, t) => { document.getElementById('toast').textContent = '[' + t + '] ' + m; };
        window.showDeleteConfirm = async () => true;</script>
      <script src="/js/multisucursal-enlace.js"></script>
      <script>window.MultisucursalEnlace.loadConfigSection();</script></body></html>`));
    app.get('/js/multisucursal-enlace.js', (_req, res) => res.sendFile(path.join(L.PROJECT, 'js', 'multisucursal-enlace.js')));
    app.all(/^\/api\/multisucursal\/.*/, async (req, res) => {
      const r = await fetch(`http://127.0.0.1:${pc.port}${req.originalUrl}`, {
        method: req.method,
        headers: { 'Content-Type': 'application/json', Authorization: req.get('authorization') || '' },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
      });
      res.status(r.status).json(await r.json().catch(() => ({})));
    });
    return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  }

  const sCentro = await arnes(centro);
  const sNorte = await arnes(norte);
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 980, height: 900 });
    const texto = () => page.evaluate(() => document.body.textContent);
    const esperar = (t) => page.waitForFunction((x) => document.body.textContent.includes(x), { timeout: 20000 }, t);

    // Principal: sincronización, catálogo y precio en varias sucursales.
    await page.goto(`http://127.0.0.1:${sCentro.address().port}/`);
    await esperar('Sincronización con las demás sucursales');
    await esperar('Cambiar un precio en varias sucursales');
    L.check('Pantalla principal: estado de sincronización, catálogo de la empresa y precio en varias sucursales', (await texto()).includes('Catálogo de la empresa (esta es la sucursal principal)'));
    await page.evaluate(() => window.MultisucursalEnlace.montarEnProducto(document.getElementById('mp-empresa-scope'), null));
    await page.waitForSelector('#mp-alcance-empresa', { timeout: 10000 });
    await page.select('#mp-alcance-empresa', 'sucursales');
    const casillas = await page.$$eval('[data-mp-sucursal]', (els) => els.map((e) => e.parentElement.textContent.trim()));
    L.check('Formulario de producto (principal): elegir a qué sucursales va', casillas.some((c) => c.includes('Norte')), casillas.join(' | '));
    await page.evaluate(() => window.MultisucursalEnlace.montarEnUsuario(document.getElementById('eu-panel-config'), { origenUsuario: 'local', sucursalesEmpresa: [] }));
    await page.waitForSelector('[data-eu-todas]', { timeout: 10000 });
    L.check('Formulario de usuario (principal): sucursales de la empresa donde puede entrar', Boolean(await page.$('[data-eu-sucursal]')));
    await page.screenshot({ path: path.join(SALIDA, 'pos-principal.png'), fullPage: true });

    // Norte: rangos NCF, sin bloque de principal y producto de la empresa bloqueado.
    await page.goto(`http://127.0.0.1:${sNorte.address().port}/`);
    await esperar('Rangos NCF asignados por la central');
    const t = await texto();
    L.check('Pantalla Norte: ve sus rangos NCF y no ve las acciones de la principal', t.includes('7001–7500') && !t.includes('Cambiar un precio en varias sucursales'));
    await page.evaluate(() => window.MultisucursalEnlace.montarEnProducto(document.getElementById('mp-empresa-scope'), { origenCatalogo: 'central' }));
    await esperar('Producto del catálogo de la empresa');
    L.check('Formulario de producto (Norte): datos maestros bloqueados', await page.$eval('#mp-nombre', (el) => el.disabled) && await page.$eval('#mp-codigo', (el) => el.disabled));
    await page.screenshot({ path: path.join(SALIDA, 'pos-norte.png'), fullPage: true });

    // La app real carga sin errores de JavaScript (pantalla de inicio).
    const errores = [];
    const app = await browser.newPage();
    app.on('pageerror', (e) => errores.push(e.message));
    await app.goto(`http://127.0.0.1:${centro.port}/`, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2500));
    const propios = errores.filter((m) => /Multisucursal|multisucursal|_mergeMultisucursal|_fetchMultisucursal|leerDe|montarEn/.test(m));
    L.check('App real: carga sin errores de JavaScript de multisucursal', propios.length === 0, propios.concat(errores.slice(0, 3)).join(' | ') || 'sin errores');
  } finally {
    await browser.close();
    sCentro.close();
    sNorte.close();
  }
}

async function expectRechazo(fn, codigo, nombre) {
  try {
    await fn();
    L.check(nombre, false, 'no se rechazó');
  } catch (error) {
    L.check(nombre, error.code === codigo, `${error.code}: ${error.message}`);
  }
}
