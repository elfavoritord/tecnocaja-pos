// Licencia vencida, suspendida o con errores, con la app real (servidor + Chrome)
// y SQLite en una carpeta temporal. Política de Emilio (2026-11-17):
//   - Una licencia PAGADA (alguna vez activa) nunca deja al negocio sin su
//     sistema: vencida, suspendida, equipo no autorizado o sin Internet, sigue
//     vendiendo y solo se detiene la facturación electrónica.
//   - Solo la PRUEBA de 30 días vencida deja sin entrar, y no se pierde nada.
//   - Una licencia activa con la fecha vieja de la prueba no sale "vencida".
// La licencia sale de una nube falsa (nube-falsa-preload.js): nada va a Internet.
// Uso: npm run test:licencia-pagada
/* global DB, doLogin, getConfigLicenseSummaryText, buildNotifications, refreshRemoteLicenseStatus -- corren en la página */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PROJECT = path.resolve(__dirname, '..', '..');
process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-licencia-pagada');
const L = require(path.join(PROJECT, 'scripts', 'e2e-lan', 'lib'));
const puppeteer = require(path.join(PROJECT, 'node_modules', 'puppeteer'));

const OUT = path.join(L.WORK, 'capturas');
const PORT = Number(process.env.TC_PRUEBA_PORT) || 3489;
const USER_DATA = path.join(L.WORK, 'pc-data');
const HOME = path.join(L.WORK, 'home');
const ESCENARIO = path.join(L.WORK, 'licencia-falsa.json');
const DIA = 86400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = L.check;
const fecha = (dias) => new Date(Date.now() + dias * DIA).toISOString();

function escenario(datos) {
  fs.writeFileSync(ESCENARIO, JSON.stringify(datos, null, 2));
}

async function licenciaAhora() {
  const r = await L.request(PORT, 'GET', '/api/license/status?refresh=1');
  return r.body?.license || {};
}

const resumen = (l) => `canEnter ${l.canEnter} · status ${l.status} · ecfBloqueado ${l.ecfBloqueado} · motivo ${l.ecfBloqueoMotivo} · bloqueo ${l.blockedCode}`;

(async () => {
  let server = null;
  let browser = null;
  const problemas = [];
  try {
    L.prepareSandbox();
    for (const dir of [USER_DATA, HOME, OUT]) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
    fs.mkdirSync(OUT, { recursive: true });
    escenario({ status: 'trial', trialStartedAt: fecha(0), issuedAt: fecha(0), trialEndsAt: fecha(30), expiresAt: fecha(30) });

    server = L.startServer('licencia', {
      port: PORT,
      userData: USER_DATA,
      env: {
        DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME, TECNO_CAJA_SYNC_URL: 'off',
        TC_LICENCIA_FALSA: ESCENARIO,
        // La copia del proyecto vive en una ruta sin espacios: NODE_OPTIONS no los admite bien.
        NODE_OPTIONS: `--require ${path.join(L.APP, 'scripts', 'licencia', 'nube-falsa-preload.js').split(path.sep).join('/')}`,
      },
    });
    await L.waitHttp(PORT);
    const setup = await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja',
      businessName: 'Colmado Licencia', adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@prueba.test',
      adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });
    check('Negocio nuevo en prueba', setup.status === 201, `HTTP ${setup.status} ${setup.body?.error || ''}`);

    const entrar = () => L.request(PORT, 'POST', '/api/login', { usuario: 'admin', password: '1234' });
    let login = await entrar();
    let token = login.body?.token;
    const boot = login.body?.data || {};
    check('Prueba al día: entra', login.status === 200 && Boolean(token), `HTTP ${login.status} ${login.body?.error || ''}`);
    const producto = await L.request(PORT, 'POST', '/api/products', {
      codigo: 'LIC-1', barcode: 'LIC-1', nombre: 'Arroz Licencia', categoria: 'GENERAL', unidad: 'Unidad', marca: '',
      precioVenta: 50, precioCompra: 30, stock: 100, stockMin: 1, aplicaItbis: false, estado: 'Activo',
    }, token);
    const productId = producto.body?.id || producto.body?.product?.id || producto.body?.producto?.id;
    check('Producto creado', Boolean(productId), `HTTP ${producto.status}`);
    const vender = (tk) => L.request(PORT, 'POST', '/api/sales', {
      userId: 1, clientId: null, cliente: 'Consumidor Final', tipoComprobante: 'ticket', ncfType: null,
      metodo: 'efectivo', tipoPedido: 'mostrador',
      items: [{ id: productId, codigo: 'LIC-1', nombre: 'Arroz Licencia', qty: 1, precio: 50, descuento: 0, itbis: 0, itbisModo: 'porcentaje', total: 50, subtotal: 50, impuestoMonto: 0, saleMode: 'unidad' }],
      subtotal: 50, descuento: 0, itbis: 0, total: 50, recibido: 50, cambio: 0,
      branchId: boot.sucursales?.[0]?.id, cashRegisterId: boot.cajasSucursal?.[0]?.id,
      clientRequestId: crypto.randomUUID(),
    }, tk);
    const venta1 = await vender(token);
    // `id` de la venta es su número interno (FAC-…), el que usa la reimpresión.
    const factura = venta1.body?.sale?.id;
    check('Venta en la prueba', venta1.status === 201 && Boolean(factura), `HTTP ${venta1.status} ${factura || venta1.body?.error || Object.keys(venta1.body || {}).join(',')}`);

    const datosIntactos = async (tk, cuantasVentas) => {
      const productos = await L.request(PORT, 'GET', '/api/products', null, tk);
      const lista = Array.isArray(productos.body) ? productos.body : (productos.body?.products || productos.body?.productos || []);
      const recibo = await L.request(PORT, 'GET', `/api/sales/${encodeURIComponent(factura)}/receipt`, null, tk);
      const stock = Number(lista.find((p) => p.codigo === 'LIC-1')?.stock);
      return { ok: lista.some((p) => p.codigo === 'LIC-1') && recibo.status === 200 && stock === 100 - cuantasVentas, detalle: `productos ${lista.length}, existencia ${stock}, factura ${factura}: HTTP ${recibo.status}` };
    };

    // ── 1. Prueba vencida (nunca pagó): no entra, pero no se pierde nada ─────
    escenario({ status: 'expired', trialStartedAt: fecha(-40), issuedAt: fecha(-40), trialEndsAt: fecha(-10), expiresAt: fecha(-10) });
    let lic = await licenciaAhora();
    check('1. Prueba vencida: no deja entrar', lic.canEnter === false && !lic.ecfBloqueado, resumen(lic));
    login = await entrar();
    check('1. Prueba vencida: el login lo frena y avisa que los datos siguen guardados',
      login.status === 403 && /prueba/i.test(login.body?.error || '') && /datos siguen guardados/i.test(login.body?.error || ''),
      `HTTP ${login.status} ${login.body?.error || ''}`);

    // ── 2. Pagó: se activa y todo sigue donde estaba ──────────────────────────
    escenario({ status: 'active', modalidad: 'mensual', issuedAt: fecha(-40), expiresAt: fecha(30) });
    lic = await licenciaAhora();
    check('2. Activada: entra, con facturación electrónica', lic.canEnter === true && lic.pagada === true && !lic.ecfBloqueado, resumen(lic));
    login = await entrar();
    token = login.body?.token;
    let intactos = await datosIntactos(token, 1);
    check('2. Activada: los productos y la venta de antes siguen ahí', login.status === 200 && intactos.ok, intactos.detalle);

    // ── 3. Activa con la fecha vieja de la prueba (el falso "vencida") ────────
    escenario({ status: 'active', issuedAt: fecha(-90), expiresAt: null, trialStartedAt: fecha(-90), trialEndsAt: fecha(-60) });
    lic = await licenciaAhora();
    check('3. Activa con la fecha de la prueba vieja: no sale vencida', lic.canEnter === true && lic.status === 'active' && !lic.ecfBloqueado, resumen(lic));

    // ── 4. Pagada y vencida: sigue todo, sin facturación electrónica ──────────
    escenario({ status: 'active', modalidad: 'mensual', issuedAt: fecha(-40), expiresAt: fecha(-2) });
    lic = await licenciaAhora();
    check('4. Pagada y vencida: entra, solo se detiene el e-CF', lic.canEnter === true && lic.ecfBloqueado === true && lic.ecfBloqueoMotivo === 'expired', resumen(lic));
    check('4. Aviso claro', /facturación electrónica/i.test(lic.aviso || '') && /sigue funcionando/i.test(lic.aviso || ''), lic.aviso || '(sin aviso)');
    login = await entrar();
    token = login.body?.token;
    const venta2 = await vender(token);
    check('4. Pagada y vencida: vende con ticket', login.status === 200 && venta2.status === 201, `login ${login.status} · venta HTTP ${venta2.status} ${venta2.body?.error || ''}`);
    intactos = await datosIntactos(token, 2);
    check('4. Pagada y vencida: no se pierde nada', intactos.ok, intactos.detalle);

    // Pantalla real con la licencia pagada vencida.
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    page.on('pageerror', (e) => problemas.push(`error de página: ${e.message}`));
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#login-user', { timeout: 30000 });
    await page.evaluate(() => {
      document.getElementById('login-user').value = 'admin';
      document.getElementById('login-pass').value = '1234';
      return doLogin();
    });
    await page.waitForFunction(() => Boolean(typeof DB !== 'undefined' && DB.currentUser), { timeout: 30000 });
    await sleep(2500);
    // La pantalla de licencia bloqueada se crea solo cuando hace falta.
    const pantallaBloqueada = () => page.evaluate(() => {
      const el = document.getElementById('license-blocked-screen');
      return Boolean(el && !el.classList.contains('hidden') && el.offsetParent !== null);
    });
    const pantalla = await page.evaluate(() => {
      const pill = document.getElementById('license-pill');
      return {
        pill: pill && !pill.classList.contains('hidden') ? pill.textContent.trim() : '',
        configuracion: typeof getConfigLicenseSummaryText === 'function' ? getConfigLicenseSummaryText(DB.config) : '',
        avisos: (typeof buildNotifications === 'function' ? buildNotifications() : []).map((n) => n.title),
        productos: (DB.productos || []).length,
      };
    });
    pantalla.bloqueada = await pantallaBloqueada();
    await page.screenshot({ path: path.join(OUT, '4-pagada-vencida.png') });
    check('4. Pantalla: entra al sistema, sin la pantalla de licencia bloqueada', !pantalla.bloqueada && pantalla.productos >= 1, JSON.stringify(pantalla));
    check('4. Pantalla: avisa "Facturación electrónica detenida"', /Facturación electrónica detenida/.test(pantalla.pill)
      && pantalla.avisos.includes('Facturación electrónica detenida') && !pantalla.avisos.some((t) => /suspendida|vencida/i.test(t)), JSON.stringify(pantalla));
    check('4. Configuración: "Licencia vencida · facturación electrónica detenida"', pantalla.configuracion === 'Licencia vencida · facturación electrónica detenida', pantalla.configuracion);

    // La pantalla abierta se entera sola si la suspenden (cada 5 minutos o por el aviso en vivo).
    // ── 5. Suspendida desde el panel ──────────────────────────────────────────
    escenario({ status: 'suspended', modalidad: 'mensual', issuedAt: fecha(-40), expiresAt: fecha(30) });
    lic = await licenciaAhora();
    check('5. Suspendida: entra, solo se detiene el e-CF', lic.canEnter === true && lic.ecfBloqueado === true && lic.ecfBloqueoMotivo === 'suspended', resumen(lic));
    await page.evaluate(() => (typeof refreshRemoteLicenseStatus === 'function' ? refreshRemoteLicenseStatus({ silent: true }) : null));
    await sleep(1000);
    const trasSuspender = {
      conectado: await page.evaluate(() => Boolean(DB.currentUser)),
      bloqueada: await pantallaBloqueada(),
    };
    check('5. Suspendida: la pantalla abierta no saca al cajero', trasSuspender.conectado && !trasSuspender.bloqueada, JSON.stringify(trasSuspender));

    // ── 6. Equipo no autorizado (otro deviceId) ───────────────────────────────
    escenario({ status: 'active', modalidad: 'mensual', issuedAt: fecha(-40), expiresAt: fecha(30), equipoAutorizado: false });
    lic = await licenciaAhora();
    check('6. Equipo no autorizado: entra, solo se detiene el e-CF', lic.canEnter === true && lic.ecfBloqueado === true && lic.ecfBloqueoMotivo === 'device_limit', resumen(lic));

    // ── 7. Sin Internet (la nube no responde) ─────────────────────────────────
    escenario({ status: 'active', modalidad: 'mensual', issuedAt: fecha(-40), expiresAt: fecha(30), sinRed: true });
    lic = await licenciaAhora();
    login = await entrar();
    check('7. Sin Internet: entra con lo último que sabía', lic.canEnter === true && login.status === 200, `${resumen(lic)} · login ${login.status}`);

    // ── 8. Renovada: vuelve la facturación electrónica ────────────────────────
    escenario({ status: 'active', modalidad: 'mensual', issuedAt: fecha(-40), expiresAt: fecha(30) });
    lic = await licenciaAhora();
    check('8. Renovada: vuelve la facturación electrónica', lic.canEnter === true && !lic.ecfBloqueado, resumen(lic));

    check('Sin errores en la página', problemas.length === 0, problemas.join('\n'));
    if (L.results.some((r) => !r.ok)) process.exitCode = 1;
  } catch (error) {
    console.error('FALLÓ:', error.stack || error.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await sleep(2000);
    if (server) await L.stopServer(server).catch(() => {});
    console.log('Capturas en:', OUT);
    process.exit(process.exitCode || 0);
  }
})();
