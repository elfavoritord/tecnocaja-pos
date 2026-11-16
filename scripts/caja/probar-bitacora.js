// Bitácora de Movimientos (pedido de Emilio, 2026-11-16) contra un servidor real
// con MariaDB (donde la hora salía 4 horas adelantada) o SQLite (--sqlite):
// la hora del evento es la de la PC, la apertura de caja del asistente, la
// gaveta al cobrar y al probarla, el corte legible y el cierre de sesión.
// Uso: npm run test:bitacora   (y node scripts/caja/probar-bitacora.js --sqlite)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SQLITE = process.argv.includes('--sqlite');
process.env.TC_E2E_DIR = path.join(os.tmpdir(), `tecnocaja-bitacora-${SQLITE ? 'sqlite' : 'mariadb'}`);
process.env.TC_E2E_DB_PORT = process.env.TC_E2E_DB_PORT || '3436';
const L = require('../e2e-lan/lib');

const PORT = Number(process.env.TC_PRUEBA_PORT) || (SQLITE ? 3484 : 3483) + 10;
const DB_NAME = 'tc_bitacora';
const USER_DATA = path.join(L.WORK, 'pc-data');
const HOME = path.join(L.WORK, 'home');

(async () => {
  let server = null;
  try {
    L.prepareSandbox();
    for (const dir of [USER_DATA, HOME]) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
    const env = {
      ...(SQLITE ? { DB_CLIENT: 'sqlite' } : { DB_CLIENT: 'mysql', DB_HOST: '127.0.0.1', DB_PORT: String(L.DB_PORT), DB_USER: 'root', DB_PASSWORD: '', DB_NAME }),
      USERPROFILE: HOME, HOME, TECNO_CAJA_DEMO: '1', TECNO_CAJA_SYNC_URL: 'off',
    };
    if (!SQLITE) {
      await L.startMariaDb({ fresh: true });
      await L.mysqlRoot(`DROP DATABASE IF EXISTS ${DB_NAME}; CREATE DATABASE ${DB_NAME} CHARACTER SET utf8mb4;`);
    }
    server = L.startServer(`bitacora-${SQLITE ? 'sqlite' : 'mariadb'}`, { port: PORT, userData: USER_DATA, env });
    await L.waitHttp(PORT);
    const antes = Date.now();
    await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja',
      businessName: 'Demo Prueba', adminName: 'prueba test', adminUser: 'admin', adminEmail: 'admin@prueba.test',
      adminPassword: '1234', openingAmount: 500, currency: 'RD$',
    });
    const login = await L.request(PORT, 'POST', '/api/login', { usuario: 'admin', password: '1234' });
    const token = login.body?.token;
    if (!token) throw new Error(`No entró: ${JSON.stringify(login.body).slice(0, 200)}`);
    const api = (method, url, body) => L.request(PORT, method, url, body, token);

    // Gaveta al cobrar y al probarla desde Configuración (ya abrieron en la caja).
    const uuid = () => crypto.randomUUID();
    const venta = await api('POST', '/api/caja/gaveta', { eventUuid: uuid(), motivo: 'venta', saleRef: 'FAC-00001001', estadoGaveta: 'abierta' });
    const prueba = await api('POST', '/api/caja/gaveta', { eventUuid: uuid(), motivo: 'prueba', estadoGaveta: 'fallo' });
    L.check('La gaveta al cobrar se registra', venta.status === 201, `HTTP ${venta.status} ${venta.body?.error || ''}`);
    L.check('La prueba de gaveta se registra', prueba.status === 201, `HTTP ${prueba.status} ${prueba.body?.error || ''}`);

    // Corte (ruta de siempre) y cierre de sesión.
    await api('POST', '/api/cash/corte', { cajero: 'prueba test', horaApertura: '12:02 p. m.', horaCorte: '12:05 p. m.', ventas: 0, efectivo: 500, totalEsperado: 500, contadoFisico: 500, diferencia: 0 });
    const salir = await api('POST', '/api/logout', {});
    L.check('Cerrar sesión responde', salir.status === 200, `HTTP ${salir.status}`);
    const sesionVieja = await api('GET', '/api/audit');
    L.check('Después de cerrar sesión el token ya no sirve', sesionVieja.status === 401 || sesionVieja.status === 403, `HTTP ${sesionVieja.status}`);

    const otra = await L.request(PORT, 'POST', '/api/login', { usuario: 'admin', password: '1234' });
    const eventos = (await L.request(PORT, 'GET', '/api/audit', null, otra.body?.token)).body || [];
    const de = (accion) => eventos.find((e) => e.accion === accion);
    const despues = Date.now();

    const setup = de('Configuración inicial completada');
    const t = Date.parse(setup?.fecha || '');
    L.check(`La hora del evento es la real (${SQLITE ? 'SQLite' : 'MariaDB'})`, t >= antes - 120000 && t <= despues + 120000,
      `${setup?.fecha} · ahora ${new Date(despues).toISOString()}`);
    L.check('Apertura de caja del asistente', /monto 500\.00/.test(de('Apertura de caja')?.detalle || ''), JSON.stringify(de('Apertura de caja')));
    L.check('Gaveta al cobrar en la bitácora', /factura FAC-00001001 · gaveta abierta/.test(de('Gaveta: Apertura con venta')?.detalle || ''), JSON.stringify(de('Gaveta: Apertura con venta')));
    L.check('Prueba de gaveta en la bitácora (no respondió)', /no respondió/.test(de('Gaveta: Prueba de gaveta desde Configuración')?.detalle || ''), JSON.stringify(de('Gaveta: Prueba de gaveta desde Configuración')));
    const corte = de('Corte de caja');
    L.check('Corte legible (sin JSON)', corte && !corte.detalle.trim().startsWith('{') && /esperado 500\.00/.test(corte.detalle), corte?.detalle);
    L.check('Cierre de sesión en la bitácora', /Salida del sistema con usuario admin/.test(de('Cierre de sesión')?.detalle || ''), JSON.stringify(de('Cierre de sesión')));

    if (L.results.some((r) => !r.ok)) process.exitCode = 1;
  } catch (error) {
    console.error('FALLÓ:', error.stack || error.message);
    process.exitCode = 1;
  } finally {
    await new Promise((r) => setTimeout(r, 2000));
    if (server) await L.stopServer(server).catch(() => {});
    if (!SQLITE) await L.stopMariaDb().catch(() => {});
  }
})();
