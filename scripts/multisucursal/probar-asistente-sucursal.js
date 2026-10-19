'use strict';

/**
 * Punta a punta: una PC NUEVA se configura como sucursal entrando con la
 * cuenta del dueño (sin código). Todo real menos Firebase: emulador de
 * Firestore y un Firebase Auth falso en la Sync API.
 *
 *   npm run test:multisucursal-asistente
 *
 * Flujo:
 *   1. Central: la empresa del dueño con dos sucursales (Centro principal y
 *      Norte), creadas por el contador.
 *   2. PC principal (ya vende): Configuración → entra con la cuenta del dueño
 *      y elige "Centro". Publica un producto de la empresa y crea el usuario
 *      "caja.norte" asignado a Norte.
 *   3. PC nueva, en la pantalla real del asistente (Chrome): multisucursal →
 *      "Conectar como sucursal" → correo y contraseña del dueño → elige
 *      "Norte" → queda en la pantalla de entrada con los usuarios de Norte.
 *   4. caja.norte entra, abre su caja y vende; la venta llega a la central.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-ms-asistente');
const L = require('../e2e-lan/lib');
const admin = require('firebase-admin');
const { createApp: crearSyncApi } = require('../../cloud/sync-api/lib/app');
const { createSucursalesCentral } = require('../../server/multisucursal/central/sucursales');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Correr dentro de firebase emulators:exec (ver package.json → test:multisucursal-asistente).');
  process.exit(1);
}

const SALIDA = process.argv[2] || path.join(L.WORK, 'capturas');
const LIC = 'pos:tecno-caja-supermercado-bravo';
const DUENO = 'dueno@bravo.test';
const CLAVE_DUENO = 'clave-del-dueno';
const CONTADORA = { tipo: 'contador', uid: 'conta', nombre: 'Pérez & Asociados', contadorId: 'firma-1' };
const EMILIO = { tipo: 'super_admin', uid: 'emilio', nombre: 'Emilio' };

const db = admin.initializeApp({ projectId: 'demo-tecnocaja' }).firestore();
const central = createSucursalesCentral({ db });

// Firebase Auth falso: "prueba:<correo>" con inicio de sesión de ahora mismo.
const tokenDe = (email) => `prueba:${email}`;
const verificarIdToken = async (t) => {
  const [tipo, email] = String(t).split(':');
  if (tipo !== 'prueba' || !email) throw new Error('token inválido');
  return { uid: `uid-${email}`, email, auth_time: Math.floor(Date.now() / 1000) };
};

function crearPc(nombre, port, syncUrl) {
  const userData = path.join(L.WORK, `pc-${nombre}`);
  const home = path.join(L.WORK, `home-${nombre}`);
  for (const dir of [userData, home]) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
  const env = { DB_CLIENT: 'sqlite', USERPROFILE: home, HOME: home, TECNO_CAJA_SYNC_URL: syncUrl, E2E_PLAN: 'plus' };
  return { nombre, port, userData, env, proc: null, token: '', boot: null };
}

async function arrancar(pc) {
  pc.proc = L.startServer(`pos-${pc.nombre}`, { port: pc.port, userData: pc.userData, env: pc.env });
  await L.waitHttp(pc.port);
}

async function entrar(pc, usuario, password) {
  const r = await L.request(pc.port, 'POST', '/api/login', { usuario, password });
  return r;
}

const api = (pc, method, ruta, body, token = pc.token) => L.request(pc.port, method, ruta, body, token);

(async () => {
  fs.mkdirSync(SALIDA, { recursive: true });
  const servidores = [];
  let principal = null;
  let norte = null;
  let browser = null;
  try {
    L.prepareSandbox();
    const syncApi = await new Promise((resolve) => {
      const s = crearSyncApi({ db, verificarIdToken }).listen(0, '127.0.0.1', () => resolve(s));
    });
    servidores.push(syncApi);
    const SYNC_URL = `http://127.0.0.1:${syncApi.address().port}`;

    // ── 1. Central ───────────────────────────────────────────────────────
    await db.collection('licencias').doc(LIC).set({ businessName: 'Supermercado Bravo', status: 'active', contadorId: 'firma-1', ownerEmail: DUENO, email: DUENO });
    await central.fijarLimite(LIC, 3, EMILIO);
    const sCentro = await central.crear(LIC, { nombre: 'Centro', codigo: 'CEN' }, CONTADORA);
    const sNorte = await central.crear(LIC, { nombre: 'Norte', codigo: 'NOR', direccion: 'Av. Hermanas Mirabal 10', telefono: '809-555-1010' }, CONTADORA);
    L.check('Central: empresa del dueño con Centro (principal) y Norte', sCentro.esPrincipal && !sNorte.esPrincipal);

    // ── 2. PC principal: ya vende; se conecta con la cuenta del dueño ────
    principal = crearPc('centro', 3493, SYNC_URL);
    await arrancar(principal);
    const setup = await L.request(principal.port, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'ferreteria', businessStructureMode: 'monocaja', businessRnc: '131000001',
      businessName: 'Supermercado Bravo', adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@centro.test',
      adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });
    L.check('Principal: negocio configurado (SQLite)', setup.status === 201, `HTTP ${setup.status}`);
    await L.stopServer(principal.proc);
    L.check('Principal: licencia activa para reiniciar', L.seedLicense({ port: principal.port, userData: principal.userData, env: principal.env }).ok);
    await arrancar(principal);
    const loginPrincipal = await entrar(principal, 'admin', '1234');
    principal.token = loginPrincipal.body?.token || '';
    principal.boot = loginPrincipal.body?.data || {};

    const otraCuenta = await api(principal, 'POST', '/api/multisucursal/dueno/empresas', { idToken: tokenDe('otro@correo.test') });
    L.check('Principal: otra cuenta no ve ninguna empresa', otraCuenta.status === 404 && otraCuenta.body?.code === 'SIN_EMPRESA', `HTTP ${otraCuenta.status} ${otraCuenta.body?.code}`);
    const lista = await api(principal, 'POST', '/api/multisucursal/dueno/empresas', { idToken: tokenDe(DUENO) });
    const sucursales = lista.body?.empresas?.[0]?.sucursales || [];
    L.check('Principal: el dueño ve sus dos sucursales', lista.status === 200 && sucursales.map((s) => s.nombre).join(',') === 'Centro,Norte', `HTTP ${lista.status} ${JSON.stringify(sucursales.map((s) => s.nombre))}`);
    const conectar = await api(principal, 'POST', '/api/multisucursal/dueno/activar', { idToken: tokenDe(DUENO), licenseId: LIC, branchUuid: sCentro.branchUuid });
    L.check('Principal: queda conectada como "Centro" (principal)', conectar.status === 200 && conectar.body?.enlace?.vinculado && conectar.body.enlace.sucursal?.esPrincipal,
      `HTTP ${conectar.status} ${conectar.body?.error || conectar.body?.enlace?.sucursal?.nombre}`);
    const perfil = (await db.collection('licencias').doc(LIC).get()).data().perfilNegocio;
    L.check('Central: la principal publicó el perfil del negocio', perfil?.tipoNegocio === 'ferreteria' && perfil.rnc === '131000001', JSON.stringify(perfil));

    const prod = await api(principal, 'POST', '/api/products', {
      codigo: 'BRV-001', barcode: 'BRV-001', nombre: 'Arroz 5 lb', categoria: 'Granos', unidad: 'Unidad', marca: '',
      precioVenta: 250, precioCompra: 200, stock: 40, stockMin: 1, aplicaItbis: false, estado: 'Activo', alcanceEmpresa: 'global',
    });
    L.check('Principal: producto de la empresa', prod.status === 201, `HTTP ${prod.status} ${prod.body?.error || ''}`);
    const cajero = await api(principal, 'POST', '/api/users', {
      nombre: 'Caja Norte', usuario: 'caja.norte', password: 'clave-caja-1', roleCode: 'cajero', billingType: 'mixta', estado: 'Activo',
      branchId: principal.boot.sucursales?.[0]?.id, sucursalesEmpresa: [sNorte.branchUuid],
    });
    L.check('Principal: crea el usuario "caja.norte" para Norte', cajero.status === 201, `HTTP ${cajero.status} ${cajero.body?.error || ''}`);
    const ciclo = await api(principal, 'POST', '/api/multisucursal/sincronizar?esperar=1', {});
    L.check('Principal: sube el producto y el usuario', ciclo.body?.ciclo?.resultado === 'ok', JSON.stringify(ciclo.body?.ciclo?.resultado || ciclo.body));

    // ── 3. PC nueva: el asistente ────────────────────────────────────────
    norte = crearPc('norte', 3494, SYNC_URL);
    await arrancar(norte);
    const estado0 = await L.request(norte.port, 'GET', '/api/setup/status');
    L.check('PC nueva: sin configurar', estado0.body?.setupRequired === true);
    const conPrincipal = await L.request(norte.port, 'POST', '/api/multisucursal/asistente/unirse', {
      idToken: tokenDe(DUENO), licenseId: LIC, branchUuid: sCentro.branchUuid, email: DUENO, clave: CLAVE_DUENO,
    });
    L.check('PC nueva: no se puede configurar como la principal', conPrincipal.status === 409 && conPrincipal.body?.code === 'ES_PRINCIPAL', `HTTP ${conPrincipal.status} ${conPrincipal.body?.code}`);
    L.check('PC nueva: ese intento no la enlazó ni la configuró',
      (await L.request(norte.port, 'GET', '/api/setup/status')).body?.setupRequired === true
      && (await central.listarEquipos(LIC, EMILIO)).filter((e) => e.estado === 'activo').length === 1);

    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await page.setViewport({ width: 1100, height: 820 });
    await page.goto(`http://127.0.0.1:${norte.port}/`, { waitUntil: 'networkidle2', timeout: 90000 });
    await page.waitForFunction(() => typeof window.wzScenarioSelect === 'function', { timeout: 30000 });
    // Firebase Auth del navegador, falso (igual forma que js/firebase-web-auth.js).
    await page.evaluate((correo) => {
      window.firebaseWebAuth = {
        async signInWithEmail(email, clave) {
          if (email !== correo || clave !== 'clave-del-dueno') throw new Error('Correo o contraseña incorrectos.');
          return { idToken: `prueba:${email}`, email, name: 'Dueño Bravo' };
        },
        async signInWithGoogle() { throw new Error('sin Google en la prueba'); },
        async signOut() {},
      };
      document.getElementById('platform-init-screen')?.classList.add('hidden');
      document.getElementById('setup-screen')?.classList.remove('hidden');
      // eslint-disable-next-line no-undef
      setupWizard.businessStructureMode = 'multisucursal';
      window.wzScenarioSelect('sucursal');
    }, DUENO);
    await page.waitForSelector('#wzs-email', { visible: true, timeout: 15000 });
    await page.type('#wzs-email', DUENO);
    await page.type('#wzs-clave', 'mala');
    await page.click('#wzs-btn-entrar');
    await page.waitForFunction(() => /incorrectos/.test(document.getElementById('wzs-error')?.textContent || ''), { timeout: 15000 });
    L.check('Asistente: contraseña equivocada → avisa y no sigue', true);
    await page.$eval('#wzs-clave', (el) => { el.value = ''; });
    await page.type('#wzs-clave', CLAVE_DUENO);
    await page.screenshot({ path: path.join(SALIDA, 'asistente-1-cuenta.png') });
    await page.click('#wzs-btn-entrar');
    await page.waitForSelector('[data-wzs-suc]', { visible: true, timeout: 20000 });
    const opciones = await page.$$eval('[data-wzs-suc]', (els) => els.map((e) => ({ texto: e.textContent.replace(/\s+/g, ' ').trim(), activa: !e.disabled })));
    L.check('Asistente: muestra Centro (no se puede elegir) y Norte', opciones.length === 2 && !opciones[0].activa && /Principal/.test(opciones[0].texto) && opciones[1].activa && /Norte/.test(opciones[1].texto),
      opciones.map((o) => `${o.texto} [${o.activa ? 'elegible' : 'no'}]`).join(' | '));
    await page.click(`[data-wzs-suc="${sNorte.branchUuid}"]`);
    await page.screenshot({ path: path.join(SALIDA, 'asistente-2-sucursal.png') });
    await page.click('#wzs-btn-conectar');
    await page.waitForFunction(() => {
      const login = document.getElementById('login-screen');
      return login && !login.classList.contains('hidden') && login.style.display !== 'none';
    }, { timeout: 120000 });
    await page.waitForFunction(() => /Caja Norte/.test(document.getElementById('login-screen')?.textContent || ''), { timeout: 60000 }).catch(() => {});
    const loginTexto = await page.$eval('#login-screen', (el) => el.textContent.replace(/\s+/g, ' '));
    await page.screenshot({ path: path.join(SALIDA, 'asistente-3-entrada.png') });
    L.check('Asistente: termina en la pantalla de entrada con el usuario de Norte', /Caja Norte/.test(loginTexto), loginTexto.slice(0, 160));
    const propios = errores.filter((m) => /wzs|Sucursal|sucursal|multisucursal/.test(m));
    L.check('Asistente: sin errores de JavaScript', propios.length === 0, propios.join(' | ') || 'sin errores');

    // ── Lo que quedó en la PC nueva ──────────────────────────────────────
    const estado1 = await L.request(norte.port, 'GET', '/api/setup/status');
    const cfg = estado1.body?.config || {};
    L.check('PC nueva: configurada con el perfil de la principal', estado1.body?.setupRequired === false && cfg.tipoNegocio === 'ferreteria' && cfg.rnc === '131000001',
      JSON.stringify({ tipo: cfg.tipoNegocio, rnc: cfg.rnc, nombre: cfg.nombre || cfg.businessName }));
    const usuarios = (await L.request(norte.port, 'GET', '/api/public/users-list')).body?.users || [];
    L.check('PC nueva: en la entrada están caja.norte y el dueño', usuarios.some((u) => u.usuario === 'caja.norte') && usuarios.some((u) => u.usuario === 'dueno'),
      usuarios.map((u) => u.usuario).join(', '));
    const otraVez = await L.request(norte.port, 'POST', '/api/multisucursal/asistente/unirse', { idToken: tokenDe(DUENO), licenseId: LIC, branchUuid: sNorte.branchUuid, email: DUENO, clave: CLAVE_DUENO });
    L.check('PC nueva: el asistente ya no se puede volver a usar', otraVez.status === 409 && otraVez.body?.code === 'YA_CONFIGURADA', `HTTP ${otraVez.status} ${otraVez.body?.code}`);

    const dueno = await entrar(norte, 'dueno', CLAVE_DUENO);
    L.check('PC nueva: el dueño entra con su misma contraseña (administrador general)', dueno.status === 200 && /admin/i.test(dueno.body?.user?.rol || dueno.body?.user?.roleCode || ''),
      `HTTP ${dueno.status} ${dueno.body?.user?.rol || dueno.body?.error || ''}`);
    norte.token = dueno.body?.token || '';
    const est = await api(norte, 'GET', '/api/multisucursal/estado');
    L.check('PC nueva: enlazada como Norte con la identidad de la central',
      est.body?.enlace?.vinculado && est.body.enlace.sucursal?.nombre === 'Norte'
      && est.body.identidad?.sucursal?.uuid === sNorte.branchUuid && est.body.identidad?.empresa?.uuid === sNorte.companyUuid,
      JSON.stringify({ suc: est.body?.identidad?.sucursal?.uuid, emp: est.body?.identidad?.empresa?.uuid }));
    const appEnv = fs.readFileSync(path.join(norte.userData, 'config', 'app.env'), 'utf8');
    L.check('PC nueva: el token quedó en config/app.env y no en la pantalla', /^TECNO_CAJA_SYNC_TOKEN=eq_/m.test(appEnv) && !JSON.stringify(est.body).includes('eq_'));

    // ── 4. El cajero de Norte entra, abre su caja y vende ────────────────
    const caja = await entrar(norte, 'caja.norte', 'clave-caja-1');
    L.check('Norte: caja.norte entra con la clave que le pusieron en la principal', caja.status === 200 && Boolean(caja.body?.token), `HTTP ${caja.status} ${caja.body?.error || ''}`);
    const tCaja = caja.body?.token || '';
    const boot = caja.body?.data || {};
    const abrir = await api(norte, 'POST', '/api/cash/open', { monto: 500, obs: 'Apertura', exchangeRate: 60 }, tCaja);
    L.check('Norte: abre su caja', abrir.status === 200 || abrir.status === 201, `HTTP ${abrir.status} ${abrir.body?.error || ''}`);
    const productos = (await api(norte, 'GET', '/api/products', null, tCaja)).body;
    const arroz = (productos?.products || productos || []).find((p) => p.codigo === 'BRV-001');
    L.check('Norte: tiene el producto de la empresa', Boolean(arroz) && arroz.origenCatalogo === 'central', JSON.stringify(arroz && { precio: arroz.precioVenta, origen: arroz.origenCatalogo }));
    if (arroz) {
      await api(norte, 'PUT', `/api/products/${arroz.id}`, { ...arroz, stock: 10 }, norte.token);
      const precio = Number(arroz.precioVenta);
      const venta = await api(norte, 'POST', '/api/sales', {
        userId: caja.body?.user?.id, clientId: null, cliente: 'Consumidor Final', tipoComprobante: 'ticket', ncfType: null,
        metodo: 'efectivo', tipoPedido: 'mostrador',
        items: [{ id: arroz.id, codigo: arroz.codigo, nombre: arroz.nombre, qty: 1, precio, descuento: 0, itbis: 0, itbisModo: 'porcentaje', total: precio, subtotal: precio, impuestoMonto: 0, saleMode: 'unidad' }],
        subtotal: precio, descuento: 0, itbis: 0, total: precio, recibido: precio, cambio: 0,
        branchId: boot.sucursales?.[0]?.id, cashRegisterId: boot.cajasSucursal?.[0]?.id,
        clientRequestId: `asist${Date.now().toString(16)}`,
      }, tCaja);
      L.check('Norte: caja.norte vende', venta.status === 201 || venta.status === 200, `HTTP ${venta.status} ${venta.body?.error || ''}`);
    }
    await api(norte, 'POST', '/api/multisucursal/sincronizar?esperar=1', {});
    const ventas = await db.collection('licencias').doc(LIC).collection('sucursales').doc(sNorte.branchUuid).collection('ventas').get();
    L.check('Central: la venta de Norte llegó', ventas.size === 1, `${ventas.size} venta(s)`);
    const equipos = await central.listarEquipos(LIC, EMILIO);
    L.check('Central: dos PC activas (Centro y Norte)', equipos.filter((e) => e.estado === 'activo').length === 2, equipos.map((e) => `${e.hostname}:${e.estado}`).join(', '));
  } catch (error) {
    L.check('Sin excepciones', false, error.stack);
  } finally {
    if (browser) await browser.close();
    await L.stopServer(principal?.proc);
    await L.stopServer(norte?.proc);
    servidores.forEach((s) => { s.closeAllConnections?.(); s.close(); });
  }
  const fallas = L.results.filter((r) => !r.ok);
  console.log(`\n${L.results.length - fallas.length}/${L.results.length} comprobaciones OK · capturas en ${SALIDA} · registros en ${L.WORK}`);
  process.exit(fallas.length ? 1 : 0);
})();
