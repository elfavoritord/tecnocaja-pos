'use strict';

/**
 * Punta a punta de lo que manda la app de reportes, con el POS real (server.js
 * del proyecto, SQLite, en una carpeta temporal) y el EMULADOR de Firestore.
 * No toca el .env, la base ni el Firebase reales.
 *
 *   java -jar cloud-firestore-emulator-v1.19.8.jar --host=127.0.0.1 --port=8089
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8089 node scripts/app-reportes/probar-app-reportes.js
 *
 * Lo que hace la app (escribir en businesses/{id}/appSolicitudes y appCompras)
 * se hace aquí con el SDK de administrador contra el emulador; la PC principal
 * (el POS) lo atiende como en producción: factura A4 y estado de cuenta en PDF
 * con el Chrome/Edge de la PC, y la compra por la ruta real de compras.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-e2e-app-reportes');
const L = require('../e2e-lan/lib');
const admin = require('firebase-admin');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Falta FIRESTORE_EMULATOR_HOST (arranca el emulador de Firestore, ver encabezado).');
  process.exit(1);
}

const PROYECTO = 'demo-tc';
const NEGOCIO = 'lic_e2e_colmado'; // el id de la licencia que siembra seed-license.js
const PORT = Number(process.env.TC_E2E_PORT || 3591);
const db = admin.initializeApp({ projectId: PROYECTO }, 'prueba-app-reportes').firestore();

// Llave de servicio inventada: el SDK del POS necesita una para arrancar, pero
// con FIRESTORE_EMULATOR_HOST todo Firestore va al emulador. Auth apunta a un
// puerto muerto: nada sale a Google.
function cuentaDeServicioFalsa(dir) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const archivo = path.join(dir, 'cuenta-falsa.json');
  fs.writeFileSync(archivo, JSON.stringify({
    type: 'service_account', project_id: PROYECTO, private_key_id: 'e2e',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: `e2e@${PROYECTO}.iam.gserviceaccount.com`,
    client_id: '1', token_uri: 'https://oauth2.googleapis.com/token',
  }));
  return archivo;
}

async function esperar(ref, condicion, ms = 120000) {
  const inicio = Date.now();
  while (Date.now() - inicio < ms) {
    const snap = await ref.get();
    if (snap.exists && condicion(snap.data())) return snap.data();
    await new Promise((r) => setTimeout(r, 1000));
  }
  const snap = await ref.get();
  throw new Error(`Tiempo agotado esperando ${ref.path}: ${JSON.stringify(snap.data() || null).slice(0, 400)}`);
}

async function pdfDe(ref, d) {
  if (d.pdf) return Buffer.from(d.pdf);
  const partes = [];
  for (let i = 0; i < Number(d.partes || 0); i += 1) partes.push(Buffer.from((await ref.collection('partes').doc(String(i)).get()).data().data));
  return Buffer.concat(partes);
}

(async () => {
  let proc = null;
  const userData = path.join(L.WORK, 'pc-principal');
  const home = path.join(L.WORK, 'home');
  try {
    L.prepareSandbox();
    for (const dir of [userData, home]) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
    // El asistente inicial crea el usuario en Firebase Auth: se configura el
    // negocio sin Firebase y después se arranca con el emulador.
    // USERPROFILE va a una carpeta de prueba (respaldos, Documentos). El Chrome
    // instalado en Windows no arranca con otro USERPROFILE: se usa el de
    // puppeteer desde su carpeta real (en una PC normal usa el instalado).
    const envSinFirebase = {
      DB_CLIENT: 'sqlite', USERPROFILE: home, HOME: home,
      PUPPETEER_CACHE_DIR: process.env.PUPPETEER_CACHE_DIR || path.join(os.homedir(), '.cache', 'puppeteer'),
    };
    const env = {
      ...envSinFirebase,
      FIREBASE_SERVICE_ACCOUNT_PATH: cuentaDeServicioFalsa(L.WORK), FIREBASE_PROJECT_ID: PROYECTO,
      FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9',
      TECNO_CAJA_LICENSE_UID: NEGOCIO,
    };
    const ahora = new Date();
    await db.collection('licencias').doc(NEGOCIO).set({
      businessName: 'Colmado E2E', status: 'active', planCode: 'pro', issuedAt: ahora,
      expiresAt: new Date(ahora.getTime() + 365 * 86400000), deviceLimit: 5, offlineGraceDays: 3, devices: {},
    });

    // ── POS nuevo: negocio, licencia y sesión ─────────────────────────────
    proc = L.startServer('pos', { port: PORT, userData, env: envSinFirebase });
    await L.waitHttp(PORT, '/api/setup/status', 180000);
    const setup = await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja', businessName: 'Colmado E2E',
      adminName: 'Emilio', adminUser: 'emilio', adminEmail: 'emilio@example.test', adminPassword: 'SoloLaboratorio2026!', openingAmount: 1000, currency: 'RD$',
    });
    L.check('negocio configurado', setup.status === 201, `HTTP ${setup.status} ${setup.status === 201 ? '' : JSON.stringify(setup.body).slice(0, 300)}`);
    await L.stopServer(proc);
    L.check('licencia de laboratorio', L.seedLicense({ port: PORT, userData, env: envSinFirebase }).ok);
    proc = L.startServer('pos-activado', { port: PORT, userData, env });
    await L.waitHttp(PORT, '/api/setup/status', 180000);
    const login = await L.request(PORT, 'POST', '/api/login', { usuario: 'emilio', password: 'SoloLaboratorio2026!' });
    const token = login.body?.token;
    L.check('sesión del administrador', Boolean(token), JSON.stringify(login.body || {}).slice(0, 200));
    const api = (method, url, body) => L.request(PORT, method, url, body, token, 90000);
    const branchId = login.body.data.sucursales[0].id;
    const cashRegisterId = login.body.data.cajasSucursal[0].id;
    const userId = login.body.user.id;

    // ── Datos del POS: producto, cliente con crédito, venta a crédito y abono ──
    const prod = await api('POST', '/api/products', { codigo: 'ARZ5', nombre: 'Arroz Selecto 5 lb', categoria: 'GENERAL', unidad: 'Unidad',
      precioVenta: 300, precioCompra: 240, stock: 5, stockMin: 0, aplicaItbis: true, estado: 'Activo', branchId });
    const producto = prod.body.product || prod.body.producto || prod.body;
    L.check('producto creado', prod.status === 201, `HTTP ${prod.status}`);
    const cli = await api('POST', '/api/clients', { nombre: 'Juana Pérez', telefono: '809-555-0101', cedula: '00100000001', limiteCredito: 5000 });
    L.check('cliente creado', cli.status === 201, `HTTP ${cli.status}`);
    const precio = 354;
    const venta = await api('POST', '/api/sales', {
      userId, clientId: cli.body.id, cliente: 'Juana Pérez', tipoComprobante: 'ticket', metodo: 'credito', tipoPedido: 'mostrador',
      items: [{ id: producto.id, nombre: producto.nombre, qty: 2, precio: 300, descuento: 0, itbis: 18, total: 600, subtotal: 600, impuestoMonto: 0, saleMode: 'unidad' }],
      subtotal: 600, descuento: 0, itbis: 108, total: 708, recibido: 0, cambio: 0, branchId, cashRegisterId,
      paymentDetails: { creditDueDate: '2026-12-15' }, clientRequestId: crypto.randomUUID(),
    });
    const factura = venta.body?.sale?.id || venta.body?.sale?.invoiceNumber;
    L.check('venta a crédito', venta.status === 201 && Boolean(factura), `HTTP ${venta.status} ${factura || JSON.stringify(venta.body).slice(0, 200)}`);
    const abono = await api('POST', `/api/clients/${cli.body.id}/credit-payments`, { monto: 200, metodo: 'efectivo', branchId, cashRegisterId, clientRequestId: crypto.randomUUID() });
    L.check('abono del cliente', abono.status === 200, `HTTP ${abono.status}`);
    void precio;

    // ── Lo que escribe la app ─────────────────────────────────────────────
    await db.collection('users').doc('uEmilio').set({ role: 'admin', posUserId: userId, businessId: NEGOCIO, businessIds: [NEGOCIO], displayName: 'Emilio' });
    await db.collection('users').doc('uOtro').set({ role: 'admin', posUserId: userId, businessId: 'otro', businessIds: ['otro'] });
    const negocio = db.collection('businesses').doc(NEGOCIO);
    const pedido = (tipo, parametros, createdBy = 'uEmilio') => ({ tipo, parametros, status: 'pendiente', createdBy, createdAt: admin.firestore.FieldValue.serverTimestamp(), appVersion: '1.5.0' });
    const rFactura = negocio.collection('appSolicitudes').doc(crypto.randomUUID());
    const rEstado = negocio.collection('appSolicitudes').doc(crypto.randomUUID());
    const rAjeno = negocio.collection('appSolicitudes').doc(crypto.randomUUID());
    const rNoExiste = negocio.collection('appSolicitudes').doc(crypto.randomUUID());
    await rFactura.set(pedido('factura', { factura }));
    await rEstado.set(pedido('estado_cuenta', { clienteId: cli.body.id }));
    await rAjeno.set(pedido('factura', { factura }, 'uOtro'));
    await rNoExiste.set(pedido('factura', { factura: 'FAC-NO-EXISTE' }));

    const contrato = JSON.parse(fs.readFileSync(path.join(L.PROJECT, 'reporte app', 'test', 'fixtures', 'app_requests', 'compra_app.json'), 'utf8'));
    contrato.lineas[0].productoId = Number(producto.id);
    const rCompra = negocio.collection('appCompras').doc(crypto.randomUUID());
    await rCompra.set({ ...contrato, status: 'pendiente', createdBy: 'uEmilio', createdByName: 'Emilio', createdAt: admin.firestore.FieldValue.serverTimestamp(), appVersion: '1.5.0' });

    // ── La PC principal los atiende ───────────────────────────────────────
    const listo = (d) => ['lista', 'error'].includes(d.status);
    const dFactura = await esperar(rFactura, listo);
    const pdfFactura = await pdfDe(rFactura, dFactura);
    fs.writeFileSync(path.join(L.WORK, 'factura.pdf'), pdfFactura);
    L.check('factura A4 en PDF', dFactura.status === 'lista' && pdfFactura.subarray(0, 5).toString() === '%PDF-' && dFactura.resumen?.total === 708,
      `${dFactura.status} ${dFactura.mensaje || ''} · ${pdfFactura.length} bytes · ${dFactura.archivo}`);

    const dEstado = await esperar(rEstado, listo);
    const pdfEstado = await pdfDe(rEstado, dEstado);
    fs.writeFileSync(path.join(L.WORK, 'estado-de-cuenta.pdf'), pdfEstado);
    L.check('estado de cuenta en PDF con el saldo del POS', dEstado.status === 'lista' && dEstado.resumen?.saldoActual === 508
      && dEstado.resumen?.facturasAbiertas?.[0]?.pendiente === 508 && pdfEstado.subarray(0, 5).toString() === '%PDF-',
    `${dEstado.status} ${dEstado.mensaje || ''} saldo ${dEstado.resumen?.saldoActual}`);

    const dAjeno = await esperar(rAjeno, listo);
    L.check('usuario de otro negocio: no se le prepara nada', dAjeno.status === 'error' && /no pertenece/.test(dAjeno.mensaje), dAjeno.mensaje);
    const dNoExiste = await esperar(rNoExiste, listo);
    L.check('factura que no existe: error claro', dNoExiste.status === 'error' && /no está en el POS/.test(dNoExiste.mensaje), dNoExiste.mensaje);

    const dCompra = await esperar(rCompra, (d) => ['registrada', 'requiere_correccion', 'rechazada'].includes(d.status));
    L.check('compra de la app registrada en el POS', dCompra.status === 'registrada' && Math.abs(dCompra.totalRegistrado - 3374.8) < 0.01,
      `${dCompra.status} ${dCompra.mensaje || ''} ${(dCompra.bloqueos || []).join(' | ')}`);
    const productos = await api('GET', '/api/products');
    const lista = Array.isArray(productos.body) ? productos.body : (productos.body?.products || []);
    const arroz = lista.find((p) => Number(p.id) === Number(producto.id));
    L.check('la compra subió la existencia (5 + 10 − 2 vendidos)', Number(arroz?.stock) === 13, `existencia ${arroz?.stock}`);
    L.check('producto nuevo de la compra creado', lista.some((p) => p.nombre === 'Habichuelas Rojas 1 lb'));
    const compras = await api('GET', '/api/purchases');
    const filas = Array.isArray(compras.body) ? compras.body : (compras.body?.purchases || compras.body?.compras || []);
    L.check('la compra aparece en Compras del POS', filas.length >= 1, `HTTP ${compras.status} · ${filas.length} compra(s)`);
  } catch (error) {
    L.check('sin errores inesperados', false, error.stack || error.message);
  } finally {
    await L.stopServer(proc);
  }
  const fallas = L.results.filter((r) => !r.ok).length;
  console.log(fallas ? `\n${fallas} verificación(es) fallaron. Registro: ${L.WORK}` : `\n${L.results.length} verificaciones OK. PDF en ${L.WORK}`);
  process.exit(fallas ? 1 : 0);
})();
