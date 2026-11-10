'use strict';
// Servidores y datos de laboratorio; nunca lee el .env de producción.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { randomUUID } = require('crypto');
process.env.TC_E2E_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-offline-negocios-'));
process.env.TC_E2E_DB_PORT = '3459';
const L = require('./e2e-lan/lib');
const MYSQL = process.argv.includes('--mariadb');
const report = [];
async function negocio(tipo, port) {
  const userData = path.join(L.WORK, tipo);
  const home = path.join(userData, 'home'); fs.mkdirSync(home, { recursive: true });
  const env = { ...(MYSQL ? { DB_CLIENT: 'mysql', DB_HOST: '127.0.0.1', DB_PORT: String(L.DB_PORT), DB_USER: 'root', DB_PASSWORD: '', DB_NAME: `offline_${tipo}` } : { DB_CLIENT: 'sqlite' }),
    TECNO_CAJA_SIMULATE_NO_INTERNET: '1', USERPROFILE: home, HOME: home };
  if (MYSQL) await L.mysqlRoot(`CREATE DATABASE offline_${tipo} CHARACTER SET utf8mb4`);
  let proc;
  try {
    proc = L.startServer(tipo, { port, userData, env });
    await L.waitHttp(port, '/api/setup/status', 180000);
    const setup = await L.request(port, 'POST', '/api/setup/complete', {
      language: 'es', businessType: tipo === 'servicios' ? 'srv_tecnologia' : 'colmado', businessStructureMode: 'monocaja',
      businessName: `LAB OFFLINE ${tipo}`, adminName: 'Pruebas', adminUser: 'prueba',
      adminEmail: 'prueba@example.test', adminPassword: 'SoloLaboratorio2026!', openingAmount: 1000, currency: 'RD$',
    });
    assert.equal(setup.status, 201, JSON.stringify(setup.body));
    // Preparar autorización después del esquema completo: sembrarla antes
    // crearía una base con una sola tabla que el arranque debe reparar.
    await L.stopServer(proc); proc = null;
    assert.ok(L.seedLicense({ port, userData, env }).ok, 'Fixture local de licencia');
    proc = L.startServer(tipo + '-activado', { port, userData, env });
    await L.waitHttp(port, '/api/setup/status', 180000);
    async function login() {
      const result = await L.request(port, 'POST', '/api/login', { usuario: 'prueba', password: 'SoloLaboratorio2026!' });
      assert.ok(result.body?.token, JSON.stringify(result.body)); return result.body;
    }
    let session = await login();
    const api = (method, url, body) => L.request(port, method, url, body, session.token, 90000);
    const ready = await api('GET', '/api/account/offline-readiness');
    assert.equal(ready.status, 200, JSON.stringify(ready.body));
    assert.equal(ready.body.internet, false);
    assert.equal(ready.body.ready, true, JSON.stringify(ready.body));
    const branchId = session.data.sucursales[0].id, cashRegisterId = session.data.cajasSucursal[0].id;
    if (tipo === 'pos') {
      const product = await api('POST', '/api/products', { codigo: 'OFFLINE', nombre: 'Producto local', categoria: 'GENERAL', unidad: 'Unidad', precioVenta: 100, precioCompra: 40, stock: 20, stockMin: 0, aplicaItbis: false, estado: 'Activo', branchId });
      assert.equal(product.status, 201, JSON.stringify(product.body));
      const p = product.body.product || product.body.producto || product.body;
      const sale = await api('POST', '/api/sales', { userId: session.user.id, cliente: 'Consumidor Final', tipoComprobante: 'ticket', metodo: 'efectivo', tipoPedido: 'mostrador',
        items: [{ id: p.id, nombre: 'Producto local', qty: 1, precio: 100, descuento: 0, itbis: 0, total: 100, subtotal: 100, impuestoMonto: 0, saleMode: 'unidad' }],
        subtotal: 100, descuento: 0, itbis: 0, total: 100, recibido: 100, cambio: 0, branchId, cashRegisterId, clientRequestId: randomUUID() });
      assert.equal(sale.status, 201, JSON.stringify(sale.body));
    } else {
      const invoice = await api('POST', '/api/servicios/facturas', { fiscalMode: 'consumidor', clientName: 'Cliente de prueba', branchId, condicionPago: 'contado', metodoPago: 'efectivo',
        items: [{ descripcion: 'Reparación local', cantidad: 1, precio: 100, descuentoPct: 0, itbisPct: 0 }] });
      assert.equal(invoice.status, 201, JSON.stringify(invoice.body));
      const list = await api('GET', '/api/servicios/facturas?todas=1');
      assert.equal(list.status, 200);
    }
    const automatic = await api('POST', '/api/respaldos/auto', { trigger: 'manual', deferCloud: true });
    assert.equal(automatic.status, 200, JSON.stringify(automatic.body));
    assert.equal(automatic.body.estado, 'pendiente_configuracion');
    const health = await api('GET', '/api/respaldos/estado');
    assert.equal(health.status, 200, JSON.stringify(health.body));
    assert.equal(health.body.verification.local.formatVersion, '3');
    assert.equal(health.body.verification.cloudConfigured, false);
    assert.equal(health.body.verification.status, 'atencion');
    const backup = await api('POST', '/api/respaldos/crear-local', { carpetaDestino: path.join(userData, 'backups') });
    assert.equal(backup.status, 200, JSON.stringify(backup.body));
    const preflight = await api('POST', '/api/respaldos/prevalidar', { filePath: backup.body.filePath });
    assert.equal(preflight.status, 200, JSON.stringify(preflight.body));
    assert.equal(String(preflight.body.formatVersion), '3');
    assert.ok(preflight.body.tables > 30);
    const recovery = await api('POST', '/api/respaldos/restaurar-local', { filePath: backup.body.filePath });
    assert.equal(recovery.status, 200, JSON.stringify(recovery.body));
    session = await login();
    // Verifica que una sesión anterior no sea lo único que permite trabajar.
    await L.stopServer(proc); proc = null;
    proc = L.startServer(tipo + '-reinicio', { port, userData, env });
    await L.waitHttp(port, '/api/setup/status', 180000);
    await login();
    report.push({ negocio: tipo, base: MYSQL ? 'MariaDB' : 'SQLite', internet: false, loginLocal: true, operacionGuardada: true, respaldoYRestauracionV3: true, loginTrasReinicio: true });
    console.log('OK sin internet:', tipo, '(incluye reinicio y nuevo inicio de sesión)');
  } finally { await L.stopServer(proc); }
}
(async () => {
  L.prepareSandbox();
  try {
    if (MYSQL) await L.startMariaDb({ fresh: true });
    await negocio('pos', MYSQL ? 3469 : 3467);
    await negocio('servicios', MYSQL ? 3470 : 3468);
  } finally { if (MYSQL) await L.stopMariaDb(); }
  fs.writeFileSync(path.join(L.WORK, 'resultado.json'), JSON.stringify(report, null, 2));
  console.log('Laboratorio:', L.WORK);
})().catch((e) => { console.error(e); process.exitCode = 1; });
