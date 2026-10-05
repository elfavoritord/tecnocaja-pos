// Prueba de punta a punta LAN-first con MariaDB real y dos servidores:
//   PRINCIPAL  (puerto 3490) — la PC administración
//   TERMINAL   (puerto 3491) — una caja que trabaja con la base de la principal
// Escenarios: Internet ON, Internet OFF + LAN ON, Internet vuelve, cajas
// vendiendo a la vez, reintentos sin duplicados, principal caída
// (contingencia) y recuperación.
//
// Uso: npm run test:e2e-lan   (requiere build/mariadb-runtime; no toca datos reales)
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const P = 3490;
const T = 3491;
const DB_ENV = { DB_CLIENT: 'mysql', DB_HOST: '127.0.0.1', DB_PORT: String(L.DB_PORT), DB_USER: 'root', DB_PASSWORD: '', DB_NAME: 'tc_e2e' };
// La caja terminal llega a la base por 127.0.0.2 (= otra PC para el servidor; ver lib.js).
const TERMINAL_DB_ENV = { ...DB_ENV, DB_HOST: '127.0.0.2' };
const PRINCIPAL_DATA = path.join(L.WORK, 'principal-data');
const TERMINAL_DATA = path.join(L.WORK, 'terminal-data');
const ctx = { token: '', productId: null, branchId: null, cashRegisterId: null };
let attemptSeq = 0;

function newAttemptKey() {
  attemptSeq += 1;
  return `e2e${Date.now().toString(16)}${String(attemptSeq).padStart(4, '0')}`;
}

function salePayload(extra = {}) {
  const precio = 100;
  const qty = 1;
  const subtotal = precio * qty;
  const itbis = +(subtotal * 0.18).toFixed(2);
  const total = +(subtotal + itbis).toFixed(2);
  return {
    userId: 1,
    clientId: null,
    cliente: 'Consumidor Final',
    tipoComprobante: 'ticket',
    ncfType: null,
    metodo: 'efectivo',
    tipoPedido: 'mostrador',
    items: [{ id: ctx.productId, codigo: 'E2E-1', nombre: 'Producto E2E', qty, precio, descuento: 0, itbis: 18, itbisModo: 'porcentaje', total, subtotal, impuestoMonto: itbis, saleMode: 'unidad' }],
    subtotal,
    descuento: 0,
    itbis,
    total,
    recibido: total,
    cambio: 0,
    branchId: ctx.branchId,
    cashRegisterId: ctx.cashRegisterId,
    clientRequestId: newAttemptKey(),
    ...extra,
  };
}

async function countSales() {
  const rows = await L.mysqlRoot('SELECT COUNT(*) AS n, COUNT(DISTINCT invoice_number) AS u FROM tc_e2e.sales');
  return { total: Number(rows[0].n), unique: Number(rows[0].u) };
}

async function setInternet(port, offline) {
  return L.request(port, 'POST', '/api/connectivity/simulate', { offline });
}

(async () => {
  let principal = null;
  let terminal = null;
  try {
    L.prepareSandbox();
    for (const dir of [PRINCIPAL_DATA, TERMINAL_DATA]) fs.rmSync(dir, { recursive: true, force: true });
    await L.startMariaDb({ fresh: true });
    await L.mysqlRoot('DROP DATABASE IF EXISTS tc_e2e; CREATE DATABASE tc_e2e CHARACTER SET utf8mb4;');

    // ── PC principal ────────────────────────────────────────────────────
    principal = L.startServer('principal', { port: P, userData: PRINCIPAL_DATA, env: DB_ENV });
    await L.waitHttp(P);
    const setup = await L.request(P, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'multicaja', networkKey: 'clave-red-e2e',
      businessName: 'Colmado E2E', adminName: 'Admin E2E', adminUser: 'admin', adminEmail: 'admin@e2e.test',
      adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });
    L.check('Principal: negocio multicaja configurado sobre MariaDB', setup.status === 201, `HTTP ${setup.status}`);
    const login = await L.request(P, 'POST', '/api/login', { usuario: 'admin', password: '1234' });
    ctx.token = login.body?.token;
    const boot = login.body?.data || {};
    ctx.branchId = boot.sucursales?.[0]?.id;
    ctx.cashRegisterId = boot.cajasSucursal?.[0]?.id;
    L.check('Principal: login local y caja abierta', Boolean(ctx.token && boot.caja?.abierta), `sucursal ${ctx.branchId}, caja ${ctx.cashRegisterId}`);

    const product = await L.request(P, 'POST', '/api/products', {
      codigo: 'E2E-1', barcode: 'E2E-1', nombre: 'Producto E2E', categoria: 'GENERAL', unidad: 'Unidad', marca: '', precioVenta: 100, precioCompra: 60,
      stock: 1000, stockMin: 1, aplicaItbis: true, estado: 'Activo', branchId: ctx.branchId,
    }, ctx.token);
    ctx.productId = product.body?.id || product.body?.product?.id || product.body?.producto?.id;
    if (!ctx.productId) {
      const rows = await L.mysqlRoot("SELECT id FROM tc_e2e.products WHERE codigo = 'E2E-1' LIMIT 1");
      ctx.productId = rows[0]?.id;
    }
    L.check('Principal: producto creado', Boolean(ctx.productId), `HTTP ${product.status}, id ${ctx.productId}`);

    const identify = await L.request(P, 'GET', '/api/network/identify');
    L.check('Principal: se identifica con serverId y nombre de equipo', /^srv_[a-f0-9]{16}$/.test(identify.body?.serverId || '') && Boolean(identify.body?.hostname), `${identify.body?.serverId} · ${identify.body?.hostname}`);

    // ── Prueba 1: Internet conectado ────────────────────────────────────
    let conn = await L.request(P, 'GET', '/api/connectivity');
    L.check('Internet ON: estado normal (base + Internet)', conn.body?.mode === 'normal' && conn.body?.internet?.online === true, `modo ${conn.body?.mode}`);
    const saleOn = await L.request(P, 'POST', '/api/sales', salePayload(), ctx.token);
    L.check('Internet ON: venta registrada', saleOn.status === 201, `${saleOn.body?.sale?.id || saleOn.body?.error} en ${saleOn.ms} ms`);

    // ── Prueba 2: Internet caído, LAN y base funcionando ───────────────
    await setInternet(P, true);
    conn = await L.request(P, 'GET', '/api/connectivity');
    L.check('Internet OFF: modo local (base OK, sin Internet)', conn.body?.mode === 'local' && conn.body?.database?.ok === true, `modo ${conn.body?.mode}`);
    const loginOff = await L.request(P, 'POST', '/api/login', { usuario: 'admin', password: '1234' });
    L.check('Internet OFF: login local', loginOff.status === 200 && Boolean(loginOff.body?.token), `${loginOff.ms} ms`);
    const productsOff = await L.request(P, 'GET', '/api/products', null, ctx.token);
    L.check('Internet OFF: consultar productos', productsOff.status === 200, `${Array.isArray(productsOff.body) ? productsOff.body.length : '?'} productos en ${productsOff.ms} ms`);
    const salesOff = [];
    for (let i = 0; i < 3; i += 1) salesOff.push(await L.request(P, 'POST', '/api/sales', salePayload(), ctx.token));
    L.check('Internet OFF: ventas y cobro', salesOff.every((r) => r.status === 201), salesOff.map((r) => `${r.body?.sale?.id || r.status} ${r.ms}ms`).join(', '));
    L.check('Internet OFF: la venta no espera a Internet (< 3 s)', salesOff.every((r) => r.ms < 3000), `máx ${Math.max(...salesOff.map((r) => r.ms))} ms`);
    const expense = await L.request(P, 'POST', '/api/cash/expense', { tipo: 'gasto', monto: 50, obs: 'Prueba sin Internet', branchId: ctx.branchId, cashRegisterId: ctx.cashRegisterId }, ctx.token);
    L.check('Internet OFF: movimiento de caja', expense.status < 300, `HTTP ${expense.status}`);
    const report = await L.request(P, 'GET', '/api/reports/sales-by-cashier', null, ctx.token);
    L.check('Internet OFF: reportes locales', report.status === 200, `HTTP ${report.status}`);
    const clients = await L.request(P, 'POST', '/api/clients', { nombre: 'Cliente Sin Internet', telefono: '809-555-0000' }, ctx.token);
    L.check('Internet OFF: registrar cliente', clients.status < 300, `HTTP ${clients.status}`);

    // ── Prueba 3: vuelve Internet ───────────────────────────────────────
    await setInternet(P, false);
    conn = await L.request(P, 'GET', '/api/connectivity');
    L.check('Internet vuelve: estado normal otra vez', conn.body?.mode === 'normal', `modo ${conn.body?.mode}`);

    // ── Caja terminal (otra PC de la LAN con la base de la principal) ──
    fs.mkdirSync(path.join(TERMINAL_DATA, 'config'), { recursive: true });
    fs.writeFileSync(path.join(TERMINAL_DATA, 'config', 'terminal-config.json'), JSON.stringify({
      isMain: false, setupMode: 'multicaja', terminalId: 'e2eterminal2', terminalName: 'Caja 2',
      branchId: ctx.branchId, cashRegisterId: ctx.cashRegisterId,
      principalHost: '127.0.0.1', principalBaseUrl: `http://127.0.0.1:${P}`,
      principalServerId: identify.body?.serverId, principalHostname: identify.body?.hostname,
    }, null, 2));
    // Cada PC activa su licencia una vez con Internet (aquí simulado). La
    // principal valida DESPUÉS que la caja: con el caché de una sola fila eso
    // dejaba a la caja sin poder leer su licencia.
    const seedT = L.seedLicense({ port: T, userData: TERMINAL_DATA, env: TERMINAL_DB_ENV });
    const seedP = L.seedLicense({ port: P, userData: PRINCIPAL_DATA, env: DB_ENV });
    const rowT = JSON.parse(seedT.detail || '{}').rowId;
    const rowP = JSON.parse(seedP.detail || '{}').rowId;
    L.check('Licencia: cada PC guarda su caché en su propia fila', seedT.ok && seedP.ok && rowT && rowP && rowT !== rowP, `caja ${seedT.detail} · principal ${seedP.detail}`);
    terminal = L.startServer('terminal', { port: T, userData: TERMINAL_DATA, env: TERMINAL_DB_ENV });
    await L.waitHttp(T);
    const tLogin = await L.request(T, 'POST', '/api/login', { usuario: 'admin', password: '1234' });
    const tToken = tLogin.body?.token;
    L.check('Terminal: login contra la base de la principal', Boolean(tToken), `HTTP ${tLogin.status} ${tLogin.body?.error || ''}`);
    conn = await L.request(T, 'GET', '/api/connectivity');
    L.check('Terminal: se reconoce como terminal', conn.body?.role === 'terminal' && conn.body?.mode === 'normal', `${conn.body?.role}/${conn.body?.mode}`);
    const cache = await L.request(T, 'POST', '/api/offline/init-cache', {}, tToken);
    L.check('Terminal: copia local para contingencia', cache.status === 200, `HTTP ${cache.status} ${cache.body?.error || ''}`);

    // ── Varias cajas vendiendo a la vez ────────────────────────────────
    const before = await countSales();
    const branchStockSql = `SELECT stock FROM tc_e2e.inventory_by_branch WHERE product_id = ${Number(ctx.productId)} AND branch_id = ${Number(ctx.branchId)}`;
    const stockBefore = Number((await L.mysqlRoot(branchStockSql))[0]?.stock);
    const parallel = await Promise.all(Array.from({ length: 20 }, (_, i) => L.request(i % 2 ? T : P, 'POST', '/api/sales', salePayload(), i % 2 ? tToken : ctx.token)));
    const after = await countSales();
    const okParallel = parallel.filter((r) => r.status === 201);
    const invoices = new Set(okParallel.map((r) => r.body?.sale?.id));
    L.check('Multicaja: 20 ventas simultáneas (2 cajas) registradas', okParallel.length === 20, `${okParallel.length}/20 · errores: ${parallel.filter((r) => r.status !== 201).map((r) => r.body?.error).slice(0, 2).join(' | ')}`);
    L.check('Multicaja: números de factura únicos', invoices.size === okParallel.length && after.unique === after.total, `${invoices.size} distintos · BD ${after.total} ventas / ${after.unique} números`);
    L.check('Multicaja: ninguna venta de más ni de menos', after.total - before.total === 20, `+${after.total - before.total}`);
    const stockAfter = Number((await L.mysqlRoot(branchStockSql))[0]?.stock);
    const aggregate = await L.mysqlRoot(`SELECT p.stock AS total, (SELECT SUM(stock) FROM tc_e2e.inventory_by_branch WHERE product_id = p.id) AS suma FROM tc_e2e.products p WHERE p.id = ${Number(ctx.productId)}`);
    L.check('Multicaja: inventario descontado exactamente 1 por venta (sin pisarse)', stockBefore - stockAfter === 20, `sucursal ${stockBefore} → ${stockAfter} (esperado −20)`);
    L.check('Multicaja: total del producto = suma de sucursales', Number(aggregate[0]?.total) === Number(aggregate[0]?.suma), `${aggregate[0]?.total} / ${aggregate[0]?.suma}`);

    // ── Reintentos de la misma venta: sin duplicados ───────────────────
    const repeated = salePayload();
    const dupBefore = await countSales();
    const dupResults = await Promise.all([
      L.request(P, 'POST', '/api/sales', repeated, ctx.token),
      L.request(T, 'POST', '/api/sales', repeated, tToken),
      L.request(P, 'POST', '/api/sales', repeated, ctx.token),
    ]);
    const late = await L.request(T, 'POST', '/api/sales', repeated, tToken);
    const dupAfter = await countSales();
    const dupInvoices = new Set([...dupResults, late].map((r) => r.body?.sale?.id).filter(Boolean));
    L.check('Sin duplicados: 4 envíos del mismo cobro → 1 venta', dupAfter.total - dupBefore.total === 1, `+${dupAfter.total - dupBefore.total} · respuestas ${[...dupResults, late].map((r) => r.status).join(',')}`);
    L.check('Sin duplicados: todos reciben la misma factura', dupInvoices.size === 1, [...dupInvoices].join(','));
    L.check('Sin duplicados: el reintento avisa que ya estaba', late.body?.duplicate === true, `duplicate=${late.body?.duplicate}`);

    // ── PC principal sin base (servidor LAN caído) → contingencia ──────
    const onlineSale = salePayload();
    const onlineResult = await L.request(T, 'POST', '/api/sales', onlineSale, tToken);
    L.check('Terminal: venta en línea antes del corte', onlineResult.status === 201, onlineResult.body?.sale?.id);
    await L.stopMariaDb();
    await new Promise((r) => setTimeout(r, 1500));
    conn = await L.request(T, 'GET', '/api/connectivity');
    L.check('Principal caída: la terminal pasa a contingencia', conn.body?.mode === 'contingencia', `modo ${conn.body?.mode}`);
    const health = await L.request(T, 'GET', '/api/health');
    L.check('Principal caída: /api/health avisa base no disponible', health.status === 503, `HTTP ${health.status}`);
    const offA = await L.request(T, 'POST', '/api/offline/save-sale', salePayload(), tToken);
    // Otro cajero entra con la principal caída (login contra la copia local):
    const offLogin = await L.request(T, 'POST', '/api/auth/offline-login', { usuario: 'admin', password: '1234' });
    L.check('Contingencia: login local sin la principal', offLogin.status === 200 && Boolean(offLogin.body?.token), `HTTP ${offLogin.status} ${offLogin.body?.error || ''} en ${offLogin.ms} ms`);
    const offB = await L.request(T, 'POST', '/api/offline/save-sale', salePayload(), offLogin.body?.token || tToken);
    // La caja creyó que la venta en línea falló y la guardó otra vez en contingencia:
    const offDup = await L.request(T, 'POST', '/api/offline/save-sale', onlineSale, tToken);
    L.check('Contingencia: la terminal sigue vendiendo con su copia local', [offA, offB, offDup].every((r) => r.status < 300), [offA, offB, offDup].map((r) => `${r.status} ${r.body?.error || r.body?.sale?.id || ''}`).join(' | '));
    conn = await L.request(T, 'GET', '/api/connectivity');
    L.check('Contingencia: ventas pendientes visibles', Number(conn.body?.pending?.contingencySales) >= 3, `${conn.body?.pending?.contingencySales} pendientes`);

    // La caja intenta subir con la principal todavía caída (como si se
    // apagara en plena subida): esas ventas quedan con error de red y deben
    // volver solas a la cola, no quedarse atascadas.
    const syncWhileDown = await L.request(T, 'POST', '/api/offline/sync-pending', {}, tToken);
    const failedWhileDown = Number(syncWhileDown.body?.failed || 0);
    L.check('Subida con la principal caída: falla sin perder nada', failedWhileDown >= 1 || syncWhileDown.status >= 500, `HTTP ${syncWhileDown.status} · failed=${failedWhileDown} ${String(syncWhileDown.body?.errors?.[0]?.error || syncWhileDown.body?.details || '').slice(0, 80)}`);

    // La caja 2 se enciende (p. ej. por la mañana) con la principal todavía
    // apagada: debe abrir, dejar entrar con la copia local y vender.
    await L.stopServer(terminal);
    const bootStarted = Date.now();
    terminal = L.startServer('terminal-sin-principal', { port: T, userData: TERMINAL_DATA, env: TERMINAL_DB_ENV });
    await L.waitHttp(T);
    conn = await L.request(T, 'GET', '/api/connectivity');
    L.check('Caja 2 arranca con la principal apagada', conn.body?.mode === 'contingencia', `modo ${conn.body?.mode} · respondió en ${Math.round((Date.now() - bootStarted) / 1000)} s`);
    // La pantalla intenta el login normal y, si falla por la base (no por
    // clave o licencia: ver js/app.js), pasa al login local.
    const morningLogin = await L.request(T, 'POST', '/api/login', { usuario: 'admin', password: '1234' });
    const fallsBackToLocal = morningLogin.status !== 200 && !/contraseña|licencia|suspendida|expiró|clave de red/i.test(String(morningLogin.body?.error || ''));
    const morningOffline = await L.request(T, 'POST', '/api/auth/offline-login', { usuario: 'admin', password: '1234' });
    const offC = await L.request(T, 'POST', '/api/offline/save-sale', salePayload(), morningOffline.body?.token);
    L.check('Caja 2 sin principal: entra con login local y vende', fallsBackToLocal && morningOffline.status === 200 && offC.status === 200, `login normal HTTP ${morningLogin.status} "${String(morningLogin.body?.error || '').slice(0, 60)}" → local HTTP ${morningOffline.status} · venta ${offC.status} ${offC.body?.sale?.id || offC.body?.error || ''}`);

    // ── La principal vuelve: sincronizar sin duplicar ───────────────────
    await L.startMariaDb();
    await new Promise((r) => setTimeout(r, 2000));
    const syncBefore = await countSales();
    const sync1 = await L.request(T, 'POST', '/api/offline/sync-pending', {}, tToken);
    const syncAfter1 = await countSales();
    const sync2 = await L.request(T, 'POST', '/api/offline/sync-pending', {}, tToken);
    const syncAfter2 = await countSales();
    L.check('Recuperación: las 3 ventas de contingencia entran a la principal', syncAfter1.total - syncBefore.total === 3, `+${syncAfter1.total - syncBefore.total} · ${JSON.stringify({ synced: sync1.body?.synced, skipped: sync1.body?.skipped, failed: sync1.body?.failed, errors: (sync1.body?.errors || []).slice(0, 1) })}`);
    L.check('Recuperación: la venta que ya había entrado en línea NO se duplica', Number(sync1.body?.skipped || 0) >= 1, `skipped=${sync1.body?.skipped}`);
    L.check('Recuperación: sincronizar otra vez no agrega nada', syncAfter2.total === syncAfter1.total, `${JSON.stringify({ synced: sync2.body?.synced, skipped: sync2.body?.skipped })}`);
    L.check('Recuperación: números de factura siguen únicos', syncAfter2.unique === syncAfter2.total, `${syncAfter2.total}/${syncAfter2.unique}`);
    conn = await L.request(T, 'GET', '/api/connectivity');
    L.check('Recuperación: terminal vuelve a modo normal', conn.body?.mode === 'normal', `modo ${conn.body?.mode}`);
  } catch (error) {
    console.error('ERROR en la prueba:', error);
    L.check('La prueba terminó sin excepciones', false, error.message);
  } finally {
    await L.stopServer(terminal);
    await L.stopServer(principal);
    await L.stopMariaDb();
    const failed = L.results.filter((r) => !r.ok).length;
    console.log(`\n${L.results.length - failed}/${L.results.length} comprobaciones OK · registros en ${L.WORK}`);
    process.exit(failed ? 1 : 0);
  }
})();
