'use strict';

/**
 * Arranque real de server.js en SQLite (monocaja, lo que usan la mayoría de
 * los clientes) con la Fase 2 multisucursal. Todo en una carpeta temporal:
 * userData y "Documentos" falsos (USERPROFILE), sin .env ni Firebase reales.
 *
 *   node scripts/multisucursal/probar-arranque-sqlite.js
 *
 *  A. "Versión anterior" (TECNO_CAJA_MULTISUCURSAL_DESACTIVAR=1): configurar
 *     negocio, crear producto y vender. No se migra nada.
 *  B. Actualización: arranca con la Fase 2 → respaldo previo verificable en
 *     Documentos\TecnoCaja\Backups, migraciones aplicadas, identidad con uuid,
 *     y el POS sigue funcionando (login, productos, venta).
 *  C. Segundo arranque: no migra otra vez ni hace otro respaldo.
 *  D. Interruptor de soporte: con la base ya migrada y la Fase 2 apagada, el
 *     POS sigue vendiendo.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-ms-sqlite');
const L = require('../e2e-lan/lib');
const { decryptBackupPayload } = require('../../server/security/backup-crypto');

const PORT = 3495;
const USER_DATA = path.join(L.WORK, 'pc-data');
const HOME = path.join(L.WORK, 'home');
const BACKUPS = path.join(HOME, 'Documents', 'TecnoCaja', 'Backups');
const CLAVE_E2E = 'e2e-clave-segura'; // la que pone lib.serverEnv
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ctx = { token: '', productId: null, branchId: null, cashRegisterId: null };

const env = (extra = {}) => ({ DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME, ...extra });

function venta() {
  const precio = 100;
  return {
    userId: 1, clientId: null, cliente: 'Consumidor Final', tipoComprobante: 'ticket', ncfType: null,
    metodo: 'efectivo', tipoPedido: 'mostrador',
    items: [{ id: ctx.productId, codigo: 'MS-1', nombre: 'Ron prueba', qty: 1, precio, descuento: 0, itbis: 0, itbisModo: 'porcentaje', total: precio, subtotal: precio, impuestoMonto: 0, saleMode: 'unidad' }],
    subtotal: precio, descuento: 0, itbis: 0, total: precio, recibido: precio, cambio: 0,
    branchId: ctx.branchId, cashRegisterId: ctx.cashRegisterId,
    clientRequestId: `ms${Date.now().toString(16)}${crypto.randomBytes(3).toString('hex')}`,
  };
}

async function arrancar(nombre, extra) {
  const proc = L.startServer(nombre, { port: PORT, userData: USER_DATA, env: env(extra) });
  await L.waitHttp(PORT);
  return proc;
}

async function entrar() {
  const login = await L.request(PORT, 'POST', '/api/login', { usuario: 'admin', password: '1234' });
  ctx.token = login.body?.token || '';
  const boot = login.body?.data || {};
  ctx.branchId = boot.sucursales?.[0]?.id || ctx.branchId;
  ctx.cashRegisterId = boot.cajasSucursal?.[0]?.id || ctx.cashRegisterId;
  return login;
}

const respaldosPreMigracion = () => (fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).filter((f) => f.includes('PRE-MIGRACION')) : []);

(async () => {
  let server = null;
  try {
    L.prepareSandbox();
    for (const dir of [USER_DATA, HOME]) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });

    // ── A. Versión anterior ───────────────────────────────────────────────
    server = await arrancar('sqlite-a', { TECNO_CAJA_MULTISUCURSAL_DESACTIVAR: '1' });
    const setup = await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja',
      businessName: 'Colmado SQLite', adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@ms.test',
      adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });
    L.check('A: negocio monocaja configurado en SQLite', setup.status === 201, `HTTP ${setup.status}`);
    await entrar();
    const producto = await L.request(PORT, 'POST', '/api/products', {
      codigo: 'MS-1', barcode: 'MS-1', nombre: 'Ron prueba', categoria: 'GENERAL', unidad: 'Unidad', marca: '',
      precioVenta: 100, precioCompra: 60, stock: 50, stockMin: 1, aplicaItbis: false, estado: 'Activo', branchId: ctx.branchId,
    }, ctx.token);
    ctx.productId = producto.body?.id || producto.body?.product?.id || producto.body?.producto?.id;
    const ventaA = await L.request(PORT, 'POST', '/api/sales', venta(), ctx.token);
    L.check('A: producto y venta con la Fase 2 apagada', Boolean(ctx.productId) && ventaA.status === 201, `producto ${ctx.productId} · venta HTTP ${ventaA.status} ${ventaA.body?.error || ''}`);
    const estadoA = await L.request(PORT, 'GET', '/api/multisucursal/estado', null, ctx.token);
    L.check('A: no se migró nada', estadoA.status === 200 && estadoA.body.migraciones.every((m) => !m.aplicada) && respaldosPreMigracion().length === 0,
      JSON.stringify(estadoA.body?.ultimoArranque));
    await L.stopServer(server);
    // La prueba no tiene Firebase: sin una licencia activada, al reiniciar la
    // prueba gratis se da por vencida (igual que en run-lan-e2e.js).
    const licencia = L.seedLicense({ port: PORT, userData: USER_DATA, env: env({ TECNO_CAJA_MULTISUCURSAL_DESACTIVAR: '1' }) });
    L.check('A: licencia activada para poder reiniciar', licencia.ok, licencia.detail);

    // ── B. Actualización ──────────────────────────────────────────────────
    server = await arrancar('sqlite-b');
    const login = await entrar();
    L.check('B: el usuario de antes entra', login.status === 200 && Boolean(ctx.token), `HTTP ${login.status} ${login.body?.error || login.body?.message || ''} ${login.body?.code || ''}`);
    const estado = await L.request(PORT, 'GET', '/api/multisucursal/estado', null, ctx.token);
    const ident = estado.body?.identidad || {};
    L.check('B: migraciones aplicadas al arrancar', estado.status === 200 && (estado.body.ultimoArranque?.applied || []).length === require('../../server/migrations/multisucursal').length && estado.body.migraciones.every((m) => m.aplicada),
      JSON.stringify(estado.body?.ultimoArranque));
    L.check('B: empresa y sucursal con uuid', UUID.test(ident.empresa?.uuid || '') && UUID.test(ident.sucursal?.uuid || ''), `${ident.empresa?.uuid} · ${ident.sucursal?.uuid}`);

    const archivos = respaldosPreMigracion();
    let respaldoOk = false;
    let detalle = archivos.join(', ') || 'ninguno';
    if (archivos.length === 1) {
      const tcbak = JSON.parse(fs.readFileSync(path.join(BACKUPS, archivos[0]), 'utf8'));
      const json = zlib.gunzipSync(Buffer.from(decryptBackupPayload(tcbak.encrypted, CLAVE_E2E), 'base64')).toString('utf8');
      const payload = JSON.parse(json);
      const shaOk = crypto.createHash('sha256').update(json, 'utf8').digest('hex') === tcbak.sha256;
      respaldoOk = shaOk && payload.data.products.some((p) => p.codigo === 'MS-1') && payload.data.sales.length >= 1 && !('uuid' in payload.data.products[0]);
      detalle = `${archivos[0]} · ${payload.data.products.length} productos · ${payload.data.sales.length} ventas · sha ${shaOk ? 'OK' : 'MAL'}`;
    }
    L.check('B: respaldo previo verificable, con los datos de ANTES de migrar', respaldoOk, detalle);

    const productos = await L.request(PORT, 'GET', '/api/products', null, ctx.token);
    const lista = Array.isArray(productos.body) ? productos.body : (productos.body?.products || productos.body?.productos || []);
    L.check('B: el catálogo sigue igual', productos.status === 200 && lista.some((p) => (p.codigo || p.code) === 'MS-1'), `${lista.length} productos`);
    const ventaB = await L.request(PORT, 'POST', '/api/sales', venta(), ctx.token);
    L.check('B: se sigue vendiendo después de migrar', ventaB.status === 201, `HTTP ${ventaB.status} ${ventaB.body?.sale?.id || ventaB.body?.error || ''}`);
    await L.stopServer(server);

    // ── C. Segundo arranque ───────────────────────────────────────────────
    server = await arrancar('sqlite-c');
    await entrar();
    const estadoC = await L.request(PORT, 'GET', '/api/multisucursal/estado', null, ctx.token);
    L.check('C: no migra otra vez ni hace otro respaldo', (estadoC.body?.ultimoArranque?.applied || ['x']).length === 0 && respaldosPreMigracion().length === 1,
      JSON.stringify(estadoC.body?.ultimoArranque));
    L.check('C: la identidad no cambia entre arranques', estadoC.body?.identidad?.empresa?.uuid === ident.empresa?.uuid && estadoC.body?.identidad?.sucursal?.uuid === ident.sucursal?.uuid);
    await L.stopServer(server);

    // ── D. Interruptor de soporte con la base ya migrada ──────────────────
    server = await arrancar('sqlite-d', { TECNO_CAJA_MULTISUCURSAL_DESACTIVAR: '1' });
    await entrar();
    const ventaD = await L.request(PORT, 'POST', '/api/sales', venta(), ctx.token);
    L.check('D: con la Fase 2 apagada sobre la base migrada se sigue vendiendo', ventaD.status === 201, `HTTP ${ventaD.status} ${ventaD.body?.error || ''}`);
  } catch (error) {
    L.check('Sin excepciones', false, error.stack);
  } finally {
    await L.stopServer(server);
  }
  const fallas = L.results.filter((r) => !r.ok);
  console.log(`\n${L.results.length - fallas.length}/${L.results.length} comprobaciones OK · registros en ${L.WORK}`);
  process.exit(fallas.length ? 1 : 0);
})();
