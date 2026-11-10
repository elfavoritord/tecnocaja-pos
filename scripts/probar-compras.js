'use strict';
// Compras de proveedores (fase A) de punta a punta con la app real: servidor
// Express + base de laboratorio (SQLite, o MariaDB con --mariadb). Nunca toca el
// .env ni la base reales y no habla con la DGII.
//   node scripts/probar-compras.js            (SQLite)
//   node scripts/probar-compras.js --mariadb  (MariaDB empaquetada)
//   ... --ui                                   (además, la pantalla en Chrome con capturas)
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { randomUUID } = require('crypto');
process.env.TC_E2E_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-compras-'));
process.env.TC_E2E_DB_PORT = '3465';
const L = require('./e2e-lan/lib');
const XLSX = require('xlsx');
const { generateEcfXml } = require('../modules/ecf/services/ecf-generator');

const MYSQL = process.argv.includes('--mariadb');
const UI = process.argv.includes('--ui');
const resultados = [];
const ok = (nombre) => { resultados.push(nombre); console.log('OK', nombre); };

function xmlProveedor({ encf, comprador, items }) {
  return generateEcfXml({
    emitter: { rnc: '101000002', razonSocial: 'Distribuidora Lab SRL', nombreComercial: 'Dist Lab', direccion: 'Calle 1', telefono: '8090000001' },
    customer: { rnc: comprador, nombre: 'Colmado Lab' },
    document: { eNCF: encf, tipoeCF: 'E31', tipoIngresos: '01', tipoPago: '1', fechaVencimientoSecuencia: '2027-12-31' },
    items, issueDate: new Date(),
  }).xml;
}
const b64 = (texto) => Buffer.from(texto, 'utf8').toString('base64');

async function main() {
  L.prepareSandbox();
  if (MYSQL) await L.startMariaDb({ fresh: true });
  const port = MYSQL ? 3493 : 3491;
  const userData = path.join(L.WORK, 'pos');
  const home = path.join(userData, 'home'); fs.mkdirSync(home, { recursive: true });
  const env = { ...(MYSQL ? { DB_CLIENT: 'mysql', DB_HOST: '127.0.0.1', DB_PORT: String(L.DB_PORT), DB_USER: 'root', DB_PASSWORD: '', DB_NAME: 'compras_lab' } : { DB_CLIENT: 'sqlite' }),
    TECNO_CAJA_SIMULATE_NO_INTERNET: '1', USERPROFILE: home, HOME: home };
  if (MYSQL) await L.mysqlRoot('CREATE DATABASE compras_lab CHARACTER SET utf8mb4');
  let proc;
  try {
    proc = L.startServer('pos', { port, userData, env });
    await L.waitHttp(port, '/api/setup/status', 180000);
    const setup = await L.request(port, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja', businessName: 'LAB COMPRAS', rnc: '131000001',
      adminName: 'Pruebas', adminUser: 'prueba', adminEmail: 'prueba@example.test', adminPassword: 'SoloLaboratorio2026!', openingAmount: 5000, currency: 'RD$',
    });
    assert.equal(setup.status, 201, JSON.stringify(setup.body));
    await L.stopServer(proc); proc = null;
    assert.ok(L.seedLicense({ port, userData, env }).ok, 'Licencia de laboratorio');
    proc = L.startServer('pos-activado', { port, userData, env });
    await L.waitHttp(port, '/api/setup/status', 180000);
    const login = await L.request(port, 'POST', '/api/login', { usuario: 'prueba', password: 'SoloLaboratorio2026!' });
    assert.ok(login.body?.token, JSON.stringify(login.body));
    const token = login.body.token;
    const api = (method, url, body, t = token) => L.request(port, method, url, body, t, 120000);
    const branchId = login.body.data.sucursales[0].id, cashRegisterId = login.body.data.cajasSucursal[0].id;
    const estructura = { branchId, cashRegisterId };
    const ctx = { api, estructura, branchId, port, token };

    await probarSeguridadSuplidores(ctx);
    const base = await catalogoBase(ctx);
    await probarXml(ctx, base);
    await probarExcel(ctx, base);
    await probarManualDiezNuevos(ctx, base);
    await probarParecidos(ctx, base);
    await probarConfirmacion(ctx, base);
    await probarConcurrencia(ctx, base);
    await probarPagoDesdeCaja(ctx, base);
    await probarCompraClasica(ctx, base);
    await probarComprobanteNegocio(ctx, base);
    if (UI) {
      await require('./probar-compras-ui')({ port, outputDir: path.join(L.WORK, 'capturas'), base });
      ok('pantallas de compras sin errores de JavaScript (subir XML, preparar, registrar, recepción, configuración)');
    }
  } finally {
    await L.stopServer(proc);
    if (MYSQL) await L.stopMariaDb();
  }
  fs.writeFileSync(path.join(L.WORK, 'resultado.json'), JSON.stringify({ base: MYSQL ? 'MariaDB' : 'SQLite', resultados }, null, 2));
  console.log(`\n${resultados.length} verificaciones OK (${MYSQL ? 'MariaDB' : 'SQLite'}). Laboratorio: ${L.WORK}`);
}

async function stockDe(ctx, id) {
  const r = await ctx.api('GET', '/api/products');
  const lista = Array.isArray(r.body) ? r.body : (r.body.products || []);
  return Number(lista.find((p) => Number(p.id) === Number(id))?.stock ?? NaN);
}
async function producto(ctx, codigo, nombre, extra = {}) {
  const r = await ctx.api('POST', '/api/products', { codigo, nombre, categoria: 'GENERAL', unidad: 'Unidad', precioVenta: 100, precioCompra: 60, stock: 0, stockMin: 0,
    aplicaItbis: true, estado: 'Activo', branchId: ctx.branchId, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.product || r.body.producto || r.body;
}
async function borrador(ctx, id) {
  const r = await ctx.api('GET', `/api/purchases/drafts/${id}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function guardar(ctx, d, payload) {
  const r = await ctx.api('PUT', `/api/purchases/drafts/${d.id}`, { version: d.version, payload });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...d, ...r.body };
}

// Suplidores: ya no se crean, borran ni abonan sin sesión y permiso.
async function probarSeguridadSuplidores(ctx) {
  const sinSesion = await L.request(ctx.port, 'POST', '/api/suppliers', { nombre: 'Intruso' });
  assert.equal(sinSesion.status, 401, JSON.stringify(sinSesion.body));
  const pago = await L.request(ctx.port, 'POST', '/api/supplier-invoices/1/payment', { monto: 10 });
  assert.equal(pago.status, 401);
  ok('suplidores y sus facturas exigen sesión (antes cualquiera en la red podía crear, borrar o abonar)');
}

async function catalogoBase(ctx) {
  const arroz = await producto(ctx, 'ARZ5', 'Arroz Selecto 5 lb', { barcode: '7501234567893' });
  const coca2 = await producto(ctx, 'CC2', 'Coca Cola 2 L');
  const fundas = await producto(ctx, 'FUN', 'Fundas plásticas', { tracksStock: false });
  return { arroz, coca2, fundas };
}

// Caso 2: XML E31 del proveedor → borrador → registrar sin E41; el mismo XML otra vez no duplica.
async function probarXml(ctx, { arroz }) {
  const xml = xmlProveedor({ encf: 'E310000000777', comprador: '131000001', items: [
    { name: 'Arroz Selecto 5 lb', quantity: 10, unitPrice: 250, taxRate: 18 },
    { name: 'Salami Induveca 1 lb', quantity: 6, unitPrice: 140, taxRate: 18 },
    { name: 'Flete', quantity: 1, unitPrice: 300, taxRate: 18, isService: true },
  ] });
  const imp = await ctx.api('POST', '/api/purchases/import', { nombre: 'E310000000777.xml', contenido: b64(xml), ...ctx.estructura });
  assert.equal(imp.status, 201, JSON.stringify(imp.body));
  assert.equal(imp.body.borradores.length, 1);
  let d = await borrador(ctx, imp.body.borradores[0].id);
  assert.equal(d.origen, 'xml');
  assert.equal(d.payload.encabezado.ncf, 'E310000000777');
  const [l1, l2, l3] = d.payload.lineas;
  assert.equal(l1.accion, 'existente'); assert.equal(l1.productoId, Number(arroz.id));
  assert.equal(l2.accion, 'nuevo');
  assert.equal(l3.tipoLinea, 'servicio_gasto');
  assert.equal(d.resumen.diferencia, 0, 'los totales calculados cuadran con los del XML');
  // Caso 1 (corregir antes de registrar): el nombre del producto nuevo y su precio con ITBIS incluido.
  l2.descripcion = 'Salami Induveca 1 lb'; l2.precio = { modo: 'incluido', valor: 236 };
  d = await guardar(ctx, d, d.payload);
  assert.deepEqual(d.bloqueos, []);
  const antes = await stockDe(ctx, arroz.id);
  const reg = await ctx.api('POST', `/api/purchases/drafts/${d.id}/registrar`, { version: d.version });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  assert.equal(reg.body.ecf, null, 'no se emite E41 por una compra con e-CF del proveedor');
  assert.equal(reg.body.documentoOrigen, 'xml_ecf');
  assert.equal(reg.body.productosCreados, 1);
  assert.equal(await stockDe(ctx, arroz.id), antes + 10);
  const productos = (await ctx.api('GET', '/api/products')).body;
  const salami = (Array.isArray(productos) ? productos : productos.products).find((p) => p.nombre === 'Salami Induveca 1 lb');
  assert.equal(Number(salami.precioVenta), 200, 'precio base 200 + 18 % = 236 que paga el cliente');
  const otra = await ctx.api('POST', '/api/purchases/import', { nombre: 'copia.xml', contenido: b64(xml), ...ctx.estructura });
  assert.equal(otra.status, 409, JSON.stringify(otra.body));
  assert.match(otra.body.error, /ya se registró en la compra/);
  const e41 = await ctx.api('POST', '/api/purchases', { uuid: randomUUID(), encabezado: { proveedor: { rnc: '101000002' }, ncf: 'E310000000778', fechaComprobante: '2026-11-09',
    emitirE41: true, documentoOrigen: 'xml_ecf' }, lineas: [{ productoId: Number(arroz.id), cantidad: 1, costoUnitario: 250, itbisPct: 18 }], ...ctx.estructura });
  assert.equal(e41.status, 409); assert.match(e41.body.error, /no se emite comprobante de compra/);
  ok('XML e-CF del proveedor: borrador, corrección, registro sin E41, producto nuevo con ITBIS incluido y sin duplicar el mismo XML');
}

// Excel/CSV con varias facturas → un borrador por factura; filas con error marcadas.
async function probarExcel(ctx) {
  const filas = [
    ['rnc_proveedor', 'nombre_proveedor', 'ncf', 'fecha', 'descripcion', 'cantidad', 'costo_unitario', 'itbis_pct', 'precio_venta', 'modo_itbis'],
    ['130000003', 'Agro Lab', 'B0100000201', '09/11/2026', 'Plátanos (unidad)', '50', '12', '0', '20', 'exento'],
    ['130000003', 'Agro Lab', 'B0100000202', '09/11/2026', 'Yuca lb', '20', '25', '0', '', ''],
    ['130000003', 'Agro Lab', 'B0100000202', '09/11/2026', '', '0', '25', '0', '', ''],
  ];
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet(filas), 'Compras');
  const buffer = XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' });
  const imp = await ctx.api('POST', '/api/purchases/import', { nombre: 'compras.xlsx', contenido: buffer.toString('base64'), ...ctx.estructura });
  assert.equal(imp.status, 201, JSON.stringify(imp.body));
  assert.equal(imp.body.borradores.length, 2);
  const [a, b] = imp.body.borradores;
  assert.equal(b.estado, 'requiere_revision', 'la factura con una fila mala queda por revisar');
  let d = await borrador(ctx, a.id);
  assert.match(d.bloqueos.join(' '), /exento de ITBIS por ley/, 'exento exige confirmación');
  d.payload.lineas[0].precio.exentoConfirmado = true;
  d = await guardar(ctx, d, d.payload);
  assert.deepEqual(d.bloqueos, []);
  const reg = await ctx.api('POST', `/api/purchases/drafts/${d.id}/registrar`, { version: d.version });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const desc = await ctx.api('DELETE', `/api/purchases/drafts/${b.id}`);
  assert.equal(desc.status, 200);
  ok('Excel con dos facturas: un borrador por factura, la fila mala bloquea la suya, exento con confirmación');
}

// Caso 4: productos conocidos + 10 nuevos creados automáticamente al registrar.
async function probarManualDiezNuevos(ctx, { arroz, fundas }) {
  const nuevo = await ctx.api('POST', '/api/purchases/drafts', { ...ctx.estructura });
  assert.equal(nuevo.status, 201, JSON.stringify(nuevo.body));
  let d = await borrador(ctx, nuevo.body.id);
  d.payload.encabezado = { ...d.payload.encabezado, proveedor: { nombre: 'Distribuidora Lab SRL', rnc: '101000002' }, ncf: 'B0100000300', numeroDocumento: 'F-300' };
  d.payload.lineas = [
    { productoId: Number(arroz.id), decision: 'usuario', cantidad: 5, costoUnitario: 255, itbisPct: 18 },
    { productoId: Number(fundas.id), decision: 'usuario', cantidad: 200, costoUnitario: 1, itbisPct: 18 },
    ...Array.from({ length: 10 }, (_, i) => ({ accion: 'nuevo', decision: 'usuario', descripcion: `Galleta Lab sabor ${i + 1}`, cantidad: 12, costoUnitario: 20 + i, itbisPct: 18,
      precio: { modo: 'base', valor: 35 + i } })),
  ];
  d = await guardar(ctx, d, d.payload);
  assert.deepEqual(d.bloqueos, []);
  const stockFundas = await stockDe(ctx, fundas.id);
  const reg = await ctx.api('POST', `/api/purchases/drafts/${d.id}/registrar`, { version: d.version });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  assert.equal(reg.body.productosCreados, 10);
  assert.equal(await stockDe(ctx, fundas.id), stockFundas, 'un producto sin control de inventario no sube existencias');
  const lista = (await ctx.api('GET', '/api/products')).body;
  const galletas = (Array.isArray(lista) ? lista : lista.products).filter((p) => /^Galleta Lab sabor/.test(p.nombre));
  assert.equal(galletas.length, 10);
  assert.ok(galletas.every((g) => Number(g.stock) === 12 && g.estado === 'Activo'), JSON.stringify(galletas.map((g) => [g.nombre, g.stock, g.estado])));
  ok('compra manual con 2 conocidos y 10 nuevos: crea los 10 con su precio y existencia; sin control de inventario no suma');
}

// Caso 5: nombres parecidos que no son el mismo producto no se unen.
async function probarParecidos(ctx, { coca2 }) {
  const nuevo = await ctx.api('POST', '/api/purchases/drafts', { ...ctx.estructura });
  let d = await borrador(ctx, nuevo.body.id);
  d.payload.encabezado = { ...d.payload.encabezado, proveedor: { nombre: 'Distribuidora Lab SRL', rnc: '101000002' }, ncf: 'B0100000400' };
  d.payload.lineas = [
    { descripcion: 'Coca Cola 3 L', cantidad: 6, costoUnitario: 90, itbisPct: 18 },
    { descripcion: 'Arroz Selecto Premium 5 lb', cantidad: 2, costoUnitario: 260, itbisPct: 18 },
  ];
  d = await guardar(ctx, d, d.payload);
  const [coca3, arroz] = d.payload.lineas;
  assert.equal(coca3.accion, 'nuevo', 'Coca Cola 3 L no se une con Coca Cola 2 L');
  assert.notEqual(coca3.productoId, Number(coca2.id));
  assert.equal(arroz.accion, 'elegir', 'un parecido con la misma medida pide elegir');
  assert.ok(d.bloqueos.some((t) => /elige el producto/.test(t)));
  const reg = await ctx.api('POST', `/api/purchases/drafts/${d.id}/registrar`, { version: d.version });
  assert.equal(reg.status, 409, 'no se registra con una línea sin decidir');
  await ctx.api('DELETE', `/api/purchases/drafts/${d.id}`);
  ok('nombres parecidos: otra medida no se une; misma medida se sugiere y bloquea hasta elegir');
}

// Casos 8 y 9: modalidad con confirmación de mercancía, recepción parcial y anulación.
async function probarConfirmacion(ctx, { arroz }) {
  const cfg = await ctx.api('PUT', '/api/purchases/config', { modoRecepcion: 'confirmacion', margenDefecto: 30, tipoMargen: 'costo', precioModo: 'incluido' });
  assert.equal(cfg.status, 200, JSON.stringify(cfg.body));
  const antes = await stockDe(ctx, arroz.id);
  const reg = await ctx.api('POST', '/api/purchases', { uuid: randomUUID(), encabezado: { proveedor: { rnc: '101000002' }, ncf: 'B0100000500', fechaComprobante: '2026-11-09',
    condicionPago: 'credito', fechaVencimiento: '2026-12-09' }, lineas: [{ productoId: Number(arroz.id), cantidad: 10, costoUnitario: 250, itbisPct: 18 }], ...ctx.estructura });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  assert.equal(reg.body.estadoInventario, 'pendiente_recepcion');
  assert.equal(await stockDe(ctx, arroz.id), antes, 'el inventario espera a la recepción');
  const pend = await ctx.api('GET', '/api/purchases/receipts/pending');
  const compra = pend.body.find((p) => p.id === reg.body.id);
  assert.ok(compra, 'aparece en Recepciones');
  const itemId = compra.items[0].id;
  const r1 = await ctx.api('POST', `/api/purchases/${reg.body.id}/receipts`, { uuid: randomUUID(), lineas: [{ itemId, cantidad: 4 }] });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal(r1.body.estadoInventario, 'recibido_parcial');
  assert.equal(await stockDe(ctx, arroz.id), antes + 4);
  const anular = await ctx.api('POST', `/api/purchases/${reg.body.id}/void`, { motivo: 'prueba' });
  assert.equal(anular.status, 200, JSON.stringify(anular.body));
  assert.equal(await stockDe(ctx, arroz.id), antes, 'al anular se revierte solo lo recibido (4)');
  // Margen por defecto: un producto nuevo sin precio toma costo + 30 % con ITBIS incluido.
  const nuevo = await ctx.api('POST', '/api/purchases/drafts', { ...ctx.estructura });
  let d = await borrador(ctx, nuevo.body.id);
  d.payload.lineas = [{ accion: 'nuevo', decision: 'usuario', descripcion: 'Avena Lab 400 g', cantidad: 1, costoUnitario: 100, itbisPct: 18 }];
  d.payload.encabezado = { ...d.payload.encabezado, proveedor: { rnc: '101000002' }, numeroDocumento: 'N-1' };
  d = await guardar(ctx, d, d.payload);
  assert.ok(d.payload.lineas[0].precio?.sugerido && d.payload.lineas[0].precio.valor === 153.4, JSON.stringify(d.payload.lineas[0].precio));
  await ctx.api('DELETE', `/api/purchases/drafts/${d.id}`);
  await ctx.api('PUT', '/api/purchases/config', { modoRecepcion: 'automatica', margenDefecto: null, tipoMargen: 'costo', precioModo: 'base' });
  ok('con confirmación: compra registrada sin tocar inventario, recepción parcial, anulación revierte solo lo recibido; margen sugerido');
}

// Caso 15: reintentos simultáneos no duplican compra, inventario ni saldo.
async function probarConcurrencia(ctx, { arroz }) {
  const nuevo = await ctx.api('POST', '/api/purchases/drafts', { ...ctx.estructura });
  let d = await borrador(ctx, nuevo.body.id);
  d.payload.encabezado = { ...d.payload.encabezado, proveedor: { rnc: '101000002' }, ncf: 'B0100000600', condicionPago: 'credito', fechaVencimiento: '2026-12-31' };
  d.payload.lineas = [{ productoId: Number(arroz.id), decision: 'usuario', cantidad: 3, costoUnitario: 250, itbisPct: 18 }];
  d = await guardar(ctx, d, d.payload);
  const antes = await stockDe(ctx, arroz.id);
  const respuestas = await Promise.all(Array.from({ length: 5 }, () => ctx.api('POST', `/api/purchases/drafts/${d.id}/registrar`, { version: d.version })));
  const ids = new Set(respuestas.filter((r) => r.status < 300).map((r) => r.body.id));
  assert.equal(ids.size, 1, JSON.stringify(respuestas.map((r) => [r.status, r.body.id || r.body.error])));
  assert.equal(await stockDe(ctx, arroz.id), antes + 3, 'una sola entrada de inventario');
  const lista = await ctx.api('GET', '/api/purchases');
  assert.equal(lista.body.filter((p) => p.ncf === 'B0100000600').length, 1);
  const cxp = await ctx.api('GET', '/api/purchases/accounts-payable');
  assert.equal(cxp.body.cuentas.filter((c) => c.ncf === 'B0100000600').length, 1, 'una sola cuenta por pagar');
  const uuid = randomUUID();
  const directo = await Promise.all(Array.from({ length: 4 }, () => ctx.api('POST', '/api/purchases', { uuid, encabezado: { proveedor: { rnc: '101000002' }, ncf: 'B0100000601',
    fechaComprobante: '2026-11-09' }, lineas: [{ productoId: Number(arroz.id), cantidad: 1, costoUnitario: 250, itbisPct: 18 }], ...ctx.estructura })));
  assert.equal(new Set(directo.filter((r) => r.status < 300).map((r) => r.body.id)).size, 1, JSON.stringify(directo.map((r) => r.status)));
  ok('5 registros simultáneos del mismo borrador y 4 del mismo uuid: una compra, una entrada de inventario, una cuenta por pagar');
}

// Pago a suplidor desde la gaveta: ahora sale en los pagos del suplidor.
async function probarPagoDesdeCaja(ctx) {
  const cxp = await ctx.api('GET', '/api/purchases/accounts-payable');
  const factura = cxp.body.cuentas.find((c) => c.ncf === 'B0100000600');
  const pago = await ctx.api('POST', '/api/cash/expense', { tipo: 'pago_suplidor', monto: 100, supplierInvoiceId: factura.id, obs: 'abono lab', ...ctx.estructura });
  assert.equal(pago.status, 201, JSON.stringify(pago.body));
  const detalle = await ctx.api('GET', `/api/suppliers/${factura.supplierId}/detail`);
  assert.ok(detalle.body.pagos.some((p) => /Pago desde caja/.test(p.notas || '') && Number(p.monto) === 100), JSON.stringify(detalle.body.pagos));
  ok('pago a suplidor desde la gaveta queda en los pagos del suplidor');
}

// El formulario clásico sigue funcionando y una compra anulada no vuelve a «Pagada» al recargar.
async function probarCompraClasica(ctx, { arroz, fundas }) {
  const prov = (await ctx.api('GET', '/api/purchases')).body.find((p) => p.ncf === 'B0100000300').supplierId;
  const antes = await stockDe(ctx, fundas.id);
  const reg = await ctx.api('POST', '/api/purchases', { supplierId: prov, numeroDocumento: 'CL-1', fechaComprobante: '2026-11-09', condicionPago: 'contado',
    items: [{ productId: arroz.id, nombre: 'Arroz', cantidad: 1, costoUnitario: 250, itbisPct: 18 }, { productId: fundas.id, nombre: 'Fundas', cantidad: 50, costoUnitario: 1, itbisPct: 18 }],
    ...ctx.estructura });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  assert.equal(await stockDe(ctx, fundas.id), antes, 'antes las fundas (sin inventario) subían existencias');
  await ctx.api('POST', `/api/purchases/${reg.body.id}/void`, { motivo: 'prueba' });
  await ctx.api('GET', '/api/bootstrap');
  const detalle = await ctx.api('GET', `/api/suppliers/${prov}/detail`);
  const factura = detalle.body.facturas.find((f) => f.numeroFactura === 'CL-1' || f.invoiceNumber === 'CL-1' || f.numero === 'CL-1');
  assert.ok(factura, JSON.stringify(detalle.body.facturas.slice(0, 3)));
  assert.equal(factura.estado || factura.status, 'Anulada', 'la factura de una compra anulada sigue anulada tras recargar');
  ok('formulario clásico: compra sin inventario para lo que no lo controla; factura anulada sigue anulada tras recargar');
}

// El proveedor no da comprobante: solo se ofrecen los comprobantes de compra con
// secuencia (aquí B11, sin e-CF configurado no hay E41) y el B11 sale de su secuencia.
async function probarComprobanteNegocio(ctx, { arroz }) {
  const antes = await ctx.api('GET', `/api/fiscal-sequences/available?branchId=${ctx.branchId}`);
  assert.ok(!antes.body.some((s) => ['B11', 'E41'].includes(s.documentType)), 'sin secuencias no hay comprobante de compra que ofrecer');
  const seq = await ctx.api('POST', '/api/ncf/sequences', { ncfType: 'B11', siguienteNumero: 1, maximo: 100, fechaVencimiento: '2027-12-31', activa: true });
  assert.ok(seq.status < 300, JSON.stringify(seq.body));
  const disp = await ctx.api('GET', `/api/fiscal-sequences/available?branchId=${ctx.branchId}`);
  assert.ok(disp.body.some((s) => s.documentType === 'B11'), JSON.stringify(disp.body));
  assert.ok(!disp.body.some((s) => s.documentType === 'E41'), 'E41 no aparece sin secuencia e-CF');
  const malo = await ctx.api('POST', '/api/purchases', { uuid: randomUUID(), encabezado: { proveedor: { rnc: '101000002' }, ncf: 'FAC-123', fechaComprobante: '2026-11-09' },
    lineas: [{ productoId: Number(arroz.id), cantidad: 1, costoUnitario: 250, itbisPct: 18 }], ...ctx.estructura });
  assert.equal(malo.status, 409); assert.match(malo.body.error, /formato de la DGII/);
  const r = await ctx.api('POST', '/api/purchases', { uuid: randomUUID(), encabezado: { proveedor: { nombre: 'Pedro Agricultor', rnc: '402-1193260-9' }, fechaComprobante: '2026-11-09',
    comprobanteNegocio: 'B11' }, lineas: [{ productoId: Number(arroz.id), cantidad: 2, costoUnitario: 240, itbisPct: 0 }], ...ctx.estructura });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.ncf, r.body.tipoNcf], ['B1100000001', 'B11']);
  const despues = await ctx.api('GET', `/api/fiscal-sequences/available?branchId=${ctx.branchId}`);
  assert.equal(Number(despues.body.find((s) => s.documentType === 'B11').nextNumber), 2, 'la secuencia B11 avanzó');
  ok('comprobante de compra: solo los tipos con secuencia; B11 tomado de su secuencia; NCF con formato inválido se rechaza');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
