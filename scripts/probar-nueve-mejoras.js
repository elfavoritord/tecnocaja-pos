'use strict';
// Prueba de punta a punta de las nueve mejoras financieras con la app real:
// servidor Express + base de laboratorio (SQLite, o MariaDB con --mariadb).
// Nunca lee el .env de producción ni habla con la DGII real.
//   node scripts/probar-nueve-mejoras.js            (SQLite)
//   node scripts/probar-nueve-mejoras.js --mariadb  (MariaDB empaquetada)
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { randomUUID } = require('crypto');
process.env.TC_E2E_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-nueve-mejoras-'));
process.env.TC_E2E_DB_PORT = '3461';
const L = require('./e2e-lan/lib');
const MYSQL = process.argv.includes('--mariadb');
const resultados = [];
const ok = (nombre) => { resultados.push(nombre); console.log('OK', nombre); };

async function main() {
  L.prepareSandbox();
  if (MYSQL) await L.startMariaDb({ fresh: true });
  const port = MYSQL ? 3481 : 3479;
  const userData = path.join(L.WORK, 'pos');
  const home = path.join(userData, 'home'); fs.mkdirSync(home, { recursive: true });
  const env = { ...(MYSQL ? { DB_CLIENT: 'mysql', DB_HOST: '127.0.0.1', DB_PORT: String(L.DB_PORT), DB_USER: 'root', DB_PASSWORD: '', DB_NAME: 'nueve_mejoras' } : { DB_CLIENT: 'sqlite' }),
    TECNO_CAJA_SIMULATE_NO_INTERNET: '1', USERPROFILE: home, HOME: home };
  if (MYSQL) await L.mysqlRoot('CREATE DATABASE nueve_mejoras CHARACTER SET utf8mb4');
  let proc;
  try {
    proc = L.startServer('pos', { port, userData, env });
    await L.waitHttp(port, '/api/setup/status', 180000);
    const setup = await L.request(port, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'restaurante', businessStructureMode: 'monocaja', businessName: 'LAB NUEVE MEJORAS',
      adminName: 'Pruebas', adminUser: 'prueba', adminEmail: 'prueba@example.test', adminPassword: 'SoloLaboratorio2026!', openingAmount: 1000, currency: 'RD$',
    });
    assert.equal(setup.status, 201, JSON.stringify(setup.body));
    await L.stopServer(proc); proc = null;
    assert.ok(L.seedLicense({ port, userData, env }).ok, 'Licencia de laboratorio');
    proc = L.startServer('pos-activado', { port, userData, env });
    await L.waitHttp(port, '/api/setup/status', 180000);
    const login = async (usuario = 'prueba', password = 'SoloLaboratorio2026!') => {
      const r = await L.request(port, 'POST', '/api/login', { usuario, password });
      assert.ok(r.body?.token, JSON.stringify(r.body)); return r.body;
    };
    const session = await login();
    const api = (method, url, body, token = session.token) => L.request(port, method, url, body, token, 90000);
    const branchId = session.data.sucursales[0].id, cashRegisterId = session.data.cajasSucursal[0].id;
    const ctx = { api, session, branchId, cashRegisterId, login, port };
    await probarCaja(ctx);
    await probarMesasPendientes(ctx);
    await probarAnticiposReserva(ctx);
    await probarTelefono(ctx);
    await probarPropina(ctx);
    await probarNotasYCancelaciones(ctx);
    await probarItbisSeparado(ctx);
    await probarSerieB(ctx);
    await probarAuditoriaYPermisos(ctx);
    await probarRespaldo(ctx, { userData, env, proc: () => proc, setProc: (p) => { proc = p; } });
    if (process.argv.includes('--ui')) {
      await require('./probar-nueve-mejoras-ui')({ port, outputDir: path.join(L.WORK, 'capturas'), datos: { ...ctx.ui, mesaProductoId: ctx.mesaProductoId } });
      ok('pantallas sin errores de JavaScript y cierre de caja por la interfaz');
    }
  } finally {
    await L.stopServer(proc);
    if (MYSQL) await L.stopMariaDb();
  }
  fs.writeFileSync(path.join(L.WORK, 'resultado.json'), JSON.stringify({ base: MYSQL ? 'MariaDB' : 'SQLite', resultados }, null, 2));
  console.log(`\n${resultados.length} verificaciones OK (${MYSQL ? 'MariaDB' : 'SQLite'}). Laboratorio: ${L.WORK}`);
}

function linea(p, qty = 1, precio = 100) {
  return { id: p.id, nombre: p.nombre, qty, precio, descuento: 0, itbis: 0, total: precio * qty, subtotal: precio * qty, impuestoMonto: 0, saleMode: 'unidad' };
}
function venta(ctx, items, extra = {}) {
  const total = items.reduce((n, i) => n + i.total, 0);
  return { userId: ctx.session.user.id, cliente: 'Consumidor Final', tipoComprobante: 'ticket', metodo: 'efectivo', tipoPedido: 'mostrador',
    items, subtotal: total, descuento: 0, itbis: 0, total, recibido: total, cambio: 0, branchId: ctx.branchId, cashRegisterId: ctx.cashRegisterId,
    clientRequestId: randomUUID(), ...extra };
}
async function crearProducto(ctx, codigo, nombre, extra = {}) {
  const r = await ctx.api('POST', '/api/products', { codigo, nombre, categoria: 'GENERAL', unidad: 'Unidad', precioVenta: 100, precioCompra: 40, stock: 50, stockMin: 0,
    aplicaItbis: false, estado: 'Activo', branchId: ctx.branchId, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.product || r.body.producto || r.body;
}

// Mejoras 8 y 9 (casos de prueba 7, 8 y 9 del pedido).
async function probarCaja(ctx) {
  const { api, branchId, cashRegisterId } = ctx;
  const estructura = { branchId, cashRegisterId };
  const prod = await crearProducto(ctx, 'CAJA1', 'Producto caja');
  const cliente = await api('POST', '/api/clients', { nombre: 'Cliente caja', telefono: '809-555-0101', limiteCredito: 0 });
  assert.equal(cliente.status, 201, JSON.stringify(cliente.body));
  const clienteId = cliente.body.id;

  const s1 = await api('POST', '/api/sales', venta(ctx, [linea(prod)], { metodo: 'efectivo', recibido: 200, cambio: 100 }));
  assert.equal(s1.status, 201, JSON.stringify(s1.body));
  const s2 = await api('POST', '/api/sales', venta(ctx, [linea(prod)], { metodo: 'tarjeta', paymentDetails: { cardBank: 'Banco Lab', cardReference: 'APR-1' } }));
  assert.equal(s2.status, 201, JSON.stringify(s2.body));
  const s3 = await api('POST', '/api/sales', venta(ctx, [linea(prod)], { metodo: 'transferencia', paymentDetails: { transferBank: 'Banco Lab', transferReference: 'TRF-1' } }));
  assert.equal(s3.status, 201, JSON.stringify(s3.body));
  const s4 = await api('POST', '/api/sales', venta(ctx, [linea(prod)], { metodo: 'mixto', clientId: clienteId, recibido: 60, montoEfectivo: 20, montoTarjeta: 30,
    montoTransferencia: 10, montoCredito: 40, paymentDetails: { creditDueDate: '2026-12-31' } }));
  assert.equal(s4.status, 201, JSON.stringify(s4.body));
  const s5 = await api('POST', '/api/sales', venta(ctx, [linea(prod)], { metodo: 'credito', clientId: clienteId, recibido: 0, paymentDetails: { creditDueDate: '2026-12-15' } }));
  assert.equal(s5.status, 201, JSON.stringify(s5.body));
  ok('ventas en efectivo, tarjeta, transferencia, mixto con 4 métodos y 100% crédito');

  const abono1 = await api('POST', `/api/clients/${clienteId}/credit-payments`, { monto: 15, metodo: 'efectivo', ...estructura, clientRequestId: randomUUID() });
  assert.equal(abono1.status, 200, JSON.stringify(abono1.body));
  const abono2 = await api('POST', `/api/clients/${clienteId}/credit-payments`, { monto: 10, metodo: 'tarjeta', ...estructura, clientRequestId: randomUUID() });
  assert.equal(abono2.status, 200, JSON.stringify(abono2.body));

  // Gaveta: cambio por igual valor (no mueve saldo), retiro, gasto, consumo y otro.
  const cambio = await api('POST', '/api/caja/gaveta', { eventUuid: randomUUID(), motivo: 'cambio', entrada: 500, salida: 500, descripcion: 'billete de 500 por menudo', ...estructura });
  assert.equal(cambio.status, 201, JSON.stringify(cambio.body));
  assert.equal(cambio.body.monto, 0); assert.equal(cambio.body.movimientoCajaId, null); assert.equal(cambio.body.abrirGaveta, true);
  const retiroUuid = randomUUID();
  const retiro = await api('POST', '/api/caja/gaveta', { eventUuid: retiroUuid, motivo: 'retiro', monto: 50, destino: 'Caja fuerte', responsable: 'Gerente', ...estructura });
  assert.equal(retiro.status, 201, JSON.stringify(retiro.body));
  assert.ok(retiro.body.movimientoCajaId);
  const repetido = await api('POST', '/api/caja/gaveta', { eventUuid: retiroUuid, motivo: 'retiro', monto: 50, destino: 'Caja fuerte', ...estructura });
  assert.equal(repetido.status, 200); assert.equal(repetido.body.repetido, true); assert.equal(repetido.body.id, retiro.body.id);
  const sinDestino = await api('POST', '/api/caja/gaveta', { eventUuid: randomUUID(), motivo: 'retiro', monto: 50, ...estructura });
  assert.equal(sinDestino.status, 400, JSON.stringify(sinDestino.body));
  const gasto = await api('POST', '/api/caja/gaveta', { eventUuid: randomUUID(), motivo: 'gasto', monto: 30, descripcion: 'Compra de hielo', ...estructura });
  assert.equal(gasto.status, 201, JSON.stringify(gasto.body));
  const antesConsumo = (await api('GET', '/api/products')).body;
  const stockAntes = Number((Array.isArray(antesConsumo) ? antesConsumo : antesConsumo.products || []).find((p) => p.id === prod.id)?.stock);
  const consumo = await api('POST', '/api/caja/gaveta', { eventUuid: randomUUID(), motivo: 'consumo', items: [{ productId: prod.id, qty: 2 }], responsable: 'Cocina', descripcion: 'almuerzo', ...estructura });
  assert.equal(consumo.status, 201, JSON.stringify(consumo.body));
  assert.equal(consumo.body.abrirGaveta, false); assert.equal(consumo.body.estadoGaveta, 'no_aplica'); assert.equal(consumo.body.monto, 0);
  const despuesConsumo = (await api('GET', '/api/products')).body;
  const stockDespues = Number((Array.isArray(despuesConsumo) ? despuesConsumo : despuesConsumo.products || []).find((p) => p.id === prod.id)?.stock);
  assert.equal(stockAntes - stockDespues, 2, `stock ${stockAntes} → ${stockDespues}`);
  const otro = await api('POST', '/api/caja/gaveta', { eventUuid: randomUUID(), motivo: 'otro', descripcion: 'Revisión del supervisor', ...estructura });
  assert.equal(otro.status, 201, JSON.stringify(otro.body));
  const resultado = await api('PATCH', `/api/caja/gaveta/${otro.body.eventUuid}/resultado`, { estado: 'sin_gaveta' });
  assert.equal(resultado.status, 200); assert.equal(resultado.body.estadoGaveta, 'sin_gaveta');
  ok('gaveta: cambio sin mover saldo, retiro idempotente, gasto, consumo que baja inventario sin tocar efectivo, otro motivo');

  // Esperado: 1000 + 100 + 20 (mixto) + 15 (abono) − 50 (retiro) − 30 (gasto) = 1055
  const arqueo = await api('POST', '/api/caja/arqueos', { countUuid: randomUUID(), denominaciones: { 1000: 1, 50: 1, 5: 1 }, ...estructura });
  assert.equal(arqueo.status, 201, JSON.stringify(arqueo.body));
  assert.equal(arqueo.body.esperado, 1055); assert.equal(arqueo.body.diferencia, 0); assert.equal(arqueo.body.estado, 'cuadrada');
  const malo = await api('POST', '/api/caja/arqueos', { countUuid: randomUUID(), denominaciones: { 3: 1 }, ...estructura });
  assert.equal(malo.status, 400, JSON.stringify(malo.body));
  ok('arqueo durante el turno: esperado 1055 sin contar crédito, tarjeta ni transferencia');

  // Tarjeta reversada y transferencia confirmada (estado real, no capturas).
  const rev = await api('PATCH', `/api/caja/pagos/${s2.body.sale.ventaId || s2.body.saleId || s2.body.sale.id}`, { metodo: 'tarjeta', estado: 'reversada', nota: 'reverso del banco' });
  assert.equal(rev.status, 200, JSON.stringify(rev.body));
  const conf = await api('PATCH', `/api/caja/pagos/${s3.body.sale.ventaId || s3.body.saleId || s3.body.sale.id}`, { metodo: 'transferencia', estado: 'confirmada' });
  assert.equal(conf.status, 200, JSON.stringify(conf.body));

  const cfg = await api('PUT', '/api/caja/config', { cierreSeguro: true });
  assert.equal(cfg.status, 200, JSON.stringify(cfg.body));
  const cfgAdmin = await api('GET', '/api/caja/config');
  assert.equal(cfgAdmin.body.cierreSeguro, true);
  assert.equal(cfgAdmin.body.veTurnoAbierto, true, 'el administrador entra a Reportes con el turno abierto');
  assert.equal(cfgAdmin.body.puedeConfigurar, true);
  // Conteo a ciegas durante el turno: se guarda con su diferencia, pero no la devuelve.
  const ciego = await api('POST', '/api/caja/arqueos', { countUuid: randomUUID(), denominaciones: { 1000: 1 }, ...estructura });
  assert.equal(ciego.status, 201, JSON.stringify(ciego.body));
  assert.equal(ciego.body.ciego, true); assert.equal(ciego.body.contado, 1000);
  assert.ok(!('esperado' in ciego.body) && !('diferencia' in ciego.body) && !('estado' in ciego.body), JSON.stringify(ciego.body));
  ok('cierre seguro: el corte durante el turno no devuelve esperado ni diferencia');
  const sinConteo = await api('POST', '/api/cash/close', { monto: 1055, montoCapturado: true, ...estructura });
  assert.equal(sinConteo.status, 400, JSON.stringify(sinConteo.body));
  const cierre = await api('POST', '/api/cash/close', { denominaciones: { 1000: 1, 50: 1 }, tarjetaVerifon: 40, obs: 'Cierre de laboratorio', ...estructura });
  assert.equal(cierre.status, 200, JSON.stringify(cierre.body));
  const r = cierre.body.reporte;
  assert.equal(r.efectivo.esperado, 1055);
  assert.equal(r.conteo.contado, 1050); assert.equal(r.conteo.diferencia, -5); assert.equal(r.conteo.estado, 'faltante');
  assert.equal(r.tarjeta.cobrado, 40, 'tarjeta: 30 del mixto + 10 de abono; la reversada no cuenta');
  assert.equal(r.tarjeta.reversado, 100);
  assert.equal(r.transferencia.cobrado, 110); assert.equal(r.transferencia.pendienteConfirmar, 10);
  assert.equal(r.credito.pendienteNuevo, 140);
  assert.equal(r.cobrado.total, r.cobrado.efectivo + r.cobrado.tarjeta + r.cobrado.transferencia);
  assert.equal(r.verifon.diferencia, 0);
  assert.equal(r.ventas.facturas.total, 5);
  assert.ok(r.gaveta.some((g) => g.motivo === 'consumo'));
  assert.ok(r.arqueos.some((a) => a.contado === 1000 && a.diferencia === -55), `el conteo a ciegas sale en el reporte: ${JSON.stringify(r.arqueos)}`);
  const guardado = await api('GET', `/api/caja/turnos/${cierre.body.sessionId}/resumen`);
  assert.equal(guardado.status, 200); assert.equal(guardado.body.conteo.diferencia, -5);
  const otraVez = await api('POST', '/api/cash/close', { denominaciones: { 1000: 1 }, ...estructura });
  assert.ok([400, 409].includes(otraVez.status), JSON.stringify(otraVez.body));
  ok('cierre seguro: exige denominaciones, faltante de 5, métodos separados, crédito no es efectivo, reporte guardado');

  const hist = await api('GET', `/api/caja/gaveta?desde=2000-01-01&hasta=2099-12-31`);
  assert.equal(hist.status, 200, JSON.stringify(hist.body));
  assert.equal(hist.body.porMotivo.retiro, 1); assert.equal(hist.body.salidas, 580); // 500 cambio + 50 retiro + 30 gasto
  const audit = await api('GET', '/api/audit');
  assert.ok(audit.body.some((e) => e.accion === 'Cierre de caja' && e.resultado === 'diferencia'), 'auditoría del cierre con diferencia');
  assert.ok(audit.body.some((e) => String(e.accion).startsWith('Gaveta:')), 'auditoría de la gaveta');
  ok('historial de gaveta y auditoría del cierre y las aperturas');

  // Reabrir la caja para las pruebas siguientes.
  const reabrir = await api('POST', '/api/cash/open', { monto: 500, exchangeRate: 60, ...estructura });
  assert.equal(reabrir.status, 201, JSON.stringify(reabrir.body));
  await api('PUT', '/api/caja/config', { cierreSeguro: false });
}

// Línea con ITBIS como la arma el carrito: subtotal ya con el descuento de la
// línea; el descuento de la venta es solo el general.
const r2 = (v) => Math.round(v * 100) / 100;
function lineaItbis(p, { qty = 1, precio = 100, itbis = 18, descuentoPct = 0 } = {}) {
  const neto = r2(precio * qty * (1 - descuentoPct / 100));
  const impuesto = r2(neto * itbis / 100);
  return { id: p.id, nombre: p.nombre, qty, precio, descuento: descuentoPct, itbis, itbisModo: 'porcentaje', subtotal: neto, total: r2(neto + impuesto), impuestoMonto: impuesto, saleMode: 'unidad' };
}
function ventaItbis(ctx, items, extra = {}) {
  const subtotal = r2(items.reduce((n, i) => n + i.subtotal, 0));
  const itbis = r2(items.reduce((n, i) => n + i.impuestoMonto, 0));
  const propina = Number(extra.propinaLegal || 0);
  const total = r2(subtotal + itbis + propina);
  return { userId: ctx.session.user.id, cliente: 'Consumidor Final', tipoComprobante: 'ticket', metodo: 'efectivo', tipoPedido: 'mostrador', items,
    subtotal, descuento: 0, itbis, total, recibido: total, cambio: 0, branchId: ctx.branchId, cashRegisterId: ctx.cashRegisterId, clientRequestId: randomUUID(), ...extra };
}
const facturaDe = (r) => r.body?.sale?.id || r.body?.sale?.invoiceNumber;
async function stockDe(ctx, id) {
  const r = (await ctx.api('GET', '/api/products')).body;
  return Number((Array.isArray(r) ? r : r.products || []).find((p) => p.id === id)?.stock);
}
async function esperadoActual(ctx) {
  const r = await ctx.api('POST', '/api/caja/arqueos', { countUuid: randomUUID(), denominaciones: {}, branchId: ctx.branchId, cashRegisterId: ctx.cashRegisterId });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.esperado;
}

// No se cierra la caja con mesas que tienen consumo sin cobrar.
async function probarMesasPendientes(ctx) {
  const { api, branchId, cashRegisterId } = ctx;
  const estructura = { branchId, cashRegisterId };
  const qs = `?branchId=${branchId}&cashRegisterId=${cashRegisterId}`;
  assert.equal((await api('PUT', '/api/mesas/config', { activo: true })).status, 200);
  const plano = await api('GET', '/api/mesas/plano');
  assert.equal(plano.status, 200, JSON.stringify(plano.body));
  const guardado = await api('PUT', '/api/mesas/plano', { version: plano.body.version, elementos: [
    { id: 'lab-mesa-1', codigo: 'Mesa 1', forma: 'mesa', x: 10, y: 10, ancho: 80, alto: 80, vendible: true }] });
  assert.equal(guardado.status, 200, JSON.stringify(guardado.body));
  const cuentaId = `lab-cuenta-${Date.now()}`;
  assert.equal((await api('POST', '/api/mesas/cuentas', { id: cuentaId, elementoId: 'lab-mesa-1', nombre: 'General' })).status, 200);
  const vacia = await api('GET', `/api/caja/cierre/verificar${qs}`);
  assert.equal(vacia.status, 200, JSON.stringify(vacia.body)); assert.equal(vacia.body.puedeCerrar, true, 'una cuenta vacía no es deuda');

  const prod = await crearProducto(ctx, 'MESA1', 'Plato de mesa');
  ctx.mesaProductoId = prod.id;
  const items = [{ id: prod.id, nombre: prod.nombre, qty: 2, precio: 100, descuento: 0 }];
  const consumo = await api('PUT', `/api/mesas/cuentas/${cuentaId}`, { version: 0, draft: { items, tableLabel: 'Mesa 1' } });
  assert.equal(consumo.status, 200, JSON.stringify(consumo.body));
  const conDeuda = await api('GET', `/api/caja/cierre/verificar${qs}`);
  assert.equal(conDeuda.body.puedeCerrar, false);
  assert.equal(conDeuda.body.mesas[0].mesa, 'Mesa 1'); assert.equal(conDeuda.body.mesas[0].consumo, 200);
  const cierre = await api('POST', '/api/cash/close', { denominaciones: { 1000: 1 }, obs: 'intento con mesa abierta', ...estructura });
  assert.equal(cierre.status, 409, JSON.stringify(cierre.body)); assert.match(cierre.body.error, /Mesa 1/);
  const turno = await api('POST', '/api/caja/arqueos', { countUuid: randomUUID(), denominaciones: {}, ...estructura });
  assert.equal(turno.status, 201, 'la caja sigue abierta después del intento');

  const cobro = await api('POST', '/api/sales', venta(ctx, [linea(prod, 2)], { tipoPedido: 'mesa', mesasCuenta: { id: cuentaId, version: 1 } }));
  assert.equal(cobro.status, 201, JSON.stringify(cobro.body));
  const cobrada = await api('GET', `/api/caja/cierre/verificar${qs}`);
  assert.equal(cobrada.body.puedeCerrar, true, 'cobrada la mesa, ya se puede cerrar');
  await api('PUT', '/api/mesas/config', { activo: false });
  ok('cierre bloqueado con mesas con consumo sin cobrar; cuenta vacía no bloquea; cobrada la mesa se puede cerrar');
}

// Reservas de mesas con anticipo: entra en la caja del turno, el cobro de la
// cuenta del cliente lo descuenta (la factura conserva su total) y lo que no se
// usa se devuelve o queda al negocio, sin descuadrar el efectivo esperado.
async function probarAnticiposReserva(ctx) {
  const { api, branchId, cashRegisterId } = ctx;
  const estructura = { branchId, cashRegisterId };
  assert.equal((await api('PUT', '/api/mesas/config', { activo: true })).status, 200);
  const plano = await api('GET', '/api/mesas/plano');
  const elementosAntes = plano.body.elementos;
  const conDos = await api('PUT', '/api/mesas/plano', { version: plano.body.version, elementos: [
    { id: 'lab-mesa-1', codigo: 'Mesa 1', forma: 'mesa', x: 10, y: 10, ancho: 80, alto: 80, vendible: true },
    { id: 'lab-mesa-2', codigo: 'Mesa 2', forma: 'mesa', x: 120, y: 10, ancho: 80, alto: 80, vendible: true }] });
  assert.equal(conDos.status, 200, JSON.stringify(conDos.body));
  const d = new Date(); d.setDate(d.getDate() + 1);
  const manana = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const resumen = async () => {
    const t = await api('POST', '/api/caja/arqueos', { countUuid: randomUUID(), denominaciones: {}, ...estructura });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    const r = await api('GET', `/api/caja/turnos/${t.body.sesionCajaId}/resumen`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const reservar = (datos) => api('POST', '/api/mesas/reservas', { personas: 2, fecha: manana, ...datos, ...estructura });
  const reserva = async (id) => (await api('GET', `/api/mesas/reservas/${id}`)).body;
  const estado = (id, valor) => api('PATCH', `/api/mesas/reservas/${id}/estado`, { estado: valor });
  const resolver = (id, accion, metodo) => api('PATCH', `/api/mesas/reservas/${id}/anticipo`, { accion, metodo, ...estructura });
  const prod = await crearProducto(ctx, 'RESERVA1', 'Plato de reserva');
  // Cuenta de la mesa abierta al llegar el cliente (como js/mesas.js: draft.reservaId).
  const cuenta = async (elementoId, qty, reservaId) => {
    const id = `lab-cuenta-res-${randomUUID()}`;
    assert.equal((await api('POST', '/api/mesas/cuentas', { id, elementoId, nombre: 'Reserva' })).status, 200);
    const r = await api('PUT', `/api/mesas/cuentas/${id}`, { version: 0, draft: { items: [{ id: prod.id, nombre: prod.nombre, qty, precio: 100, descuento: 0 }], tableLabel: 'Mesa', ...(reservaId ? { reservaId } : {}) } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { id, version: 1 };
  };
  const antes = await resumen();

  const sinAnticipo = await reservar({ elementoId: 'lab-mesa-1', cliente: 'Sin anticipo', hora: '12:00' });
  assert.equal(sinAnticipo.status, 201, JSON.stringify(sinAnticipo.body)); assert.equal(sinAnticipo.body.anticipo, null);
  assert.equal((await reservar({ elementoId: 'lab-mesa-1', cliente: 'Malo', hora: '15:00', anticipoMonto: '12.345', anticipoMetodo: 'efectivo' })).status, 400);
  assert.equal((await reservar({ elementoId: 'lab-mesa-1', cliente: 'Malo', hora: '15:00', anticipoMonto: '100' })).status, 400, 'el anticipo exige su forma de pago');
  assert.equal((await api('PATCH', `/api/mesas/reservas/${sinAnticipo.body.id}/anticipo`, { accion: 'retener', ...estructura })).status, 409, 'una reserva activa no resuelve anticipo');
  const agregado = await api('POST', `/api/mesas/reservas/${sinAnticipo.body.id}/anticipo`, { anticipoMonto: '50', anticipoMetodo: 'efectivo', anticipoConsumible: false, ...estructura });
  assert.equal(agregado.status, 201, JSON.stringify(agregado.body)); assert.equal(agregado.body.anticipo.monto, 50);
  assert.equal((await api('POST', `/api/mesas/reservas/${sinAnticipo.body.id}/anticipo`, { anticipoMonto: '50', anticipoMetodo: 'efectivo', ...estructura })).status, 409, 'un solo anticipo por reserva');

  // A: 300 en efectivo, consumible; consume 400 → paga 100 ahora.
  const a = await reservar({ elementoId: 'lab-mesa-1', cliente: 'Cliente A', hora: '20:00', anticipoMonto: '300', anticipoMetodo: 'efectivo', anticipoConsumible: true });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.deepEqual({ monto: a.body.anticipo.monto, consumible: a.body.anticipo.consumible, estado: a.body.anticipo.estado }, { monto: 300, consumible: true, estado: 'recibido' });
  // La pantalla de Caja lo recibe al instante (saldo, movimiento y anticipos del turno)
  // y al recargar (bootstrap) con la hora local del negocio.
  assert.equal(a.body.caja?.movimiento?.tipo, 'Anticipo de reserva', JSON.stringify(a.body.caja));
  assert.equal(a.body.caja.movimiento.monto, 300);
  assert.equal(a.body.caja.config.cajaAbierta, true);
  const bootstrap = (await api('GET', `/api/bootstrap?branchId=${branchId}&cashRegisterId=${cashRegisterId}`)).body;
  const movBoot = bootstrap.movimientosCaja.find((m) => m.tipo === 'Anticipo de reserva' && /Cliente A/.test(m.obs));
  assert.ok(movBoot, 'el movimiento sale en la lista de Caja');
  assert.equal(bootstrap.caja.activeSession.anticiposReserva.recibidos.efectivo, a.body.caja.anticipos.recibidos.efectivo);
  assert.ok(Math.abs(new Date(String(movBoot.hora).replace(' ', 'T')).getTime() - Date.now()) < 10 * 60000, `hora local del movimiento: ${movBoot.hora}`);
  // B: 150 con tarjeta, no consumible.
  const b = await reservar({ elementoId: 'lab-mesa-2', cliente: 'Cliente B', hora: '20:00', anticipoMonto: '150', anticipoMetodo: 'tarjeta', anticipoReferencia: 'APR-9' });
  assert.equal(b.status, 201, JSON.stringify(b.body)); assert.equal(b.body.anticipo.consumible, false);
  const conAnticipos = await resumen();
  assert.equal(conAnticipos.efectivo.esperado, antes.efectivo.esperado + 350, 'el anticipo en efectivo entra en el esperado');
  assert.equal(conAnticipos.efectivo.anticipos, antes.efectivo.anticipos + 350);
  assert.equal(conAnticipos.tarjeta.cobrado, antes.tarjeta.cobrado + 150, 'el anticipo con tarjeta entra en lo cobrado con tarjeta');

  assert.equal((await estado(a.body.id, 'cumplida')).status, 200);
  const cuentaA = await cuenta('lab-mesa-1', 4, a.body.id);
  const ventaA = (extra) => venta(ctx, [linea(prod, 4)], { tipoPedido: 'mesa', mesasCuenta: cuentaA, recibido: 100, ...extra });
  const sinDescontar = await api('POST', '/api/sales', ventaA({ recibido: 400 }));
  assert.equal(sinDescontar.status, 409, JSON.stringify(sinDescontar.body)); assert.match(sinDescontar.body.error, /anticipo de reserva de RD\$ 300\.00/);
  assert.equal((await api('POST', '/api/sales', ventaA({ anticipoReserva: 250, reservaId: a.body.id }))).status, 409, 'el anticipo debe coincidir con la base');
  const aCredito = await api('POST', '/api/sales', ventaA({ metodo: 'credito', recibido: 0, anticipoReserva: 300, reservaId: a.body.id }));
  assert.equal(aCredito.status, 400, JSON.stringify(aCredito.body)); assert.match(aCredito.body.error, /crédito/);
  assert.equal((await api('POST', '/api/sales', venta(ctx, [linea(prod)], { anticipoReserva: 100 }))).status, 400, 'fuera de Mesas no hay anticipo');
  const cobradaA = await api('POST', '/api/sales', ventaA({ anticipoReserva: 300, reservaId: a.body.id }));
  assert.equal(cobradaA.status, 201, JSON.stringify(cobradaA.body));
  assert.deepEqual({ total: cobradaA.body.sale.total, efectivo: cobradaA.body.sale.montoEfectivo, anticipo: cobradaA.body.sale.anticipoReserva },
    { total: 400, efectivo: 100, anticipo: 300 }, 'la factura conserva su total; el efectivo es lo pagado ahora');
  const aUsada = (await reserva(a.body.id)).anticipo;
  assert.deepEqual({ estado: aUsada.estado, aplicado: aUsada.aplicado, factura: aUsada.factura }, { estado: 'aplicado', aplicado: 300, factura: cobradaA.body.sale.id });
  // Otra cuenta con la misma reserva: el anticipo ya se usó y no se descuenta otra vez.
  const cuentaA2 = await cuenta('lab-mesa-1', 2, a.body.id);
  assert.equal((await api('POST', '/api/sales', venta(ctx, [linea(prod, 2)], { tipoPedido: 'mesa', mesasCuenta: cuentaA2, anticipoReserva: 200, reservaId: a.body.id }))).status, 409);
  const otraA = await api('POST', '/api/sales', venta(ctx, [linea(prod, 2)], { tipoPedido: 'mesa', mesasCuenta: cuentaA2 }));
  assert.equal(otraA.status, 201, JSON.stringify(otraA.body)); assert.equal(otraA.body.sale.anticipoReserva, 0);

  // B llegó (no consumible): se devuelve por tarjeta, fuera de la gaveta.
  assert.equal((await estado(b.body.id, 'cumplida')).status, 200);
  const bDevuelta = await resolver(b.body.id, 'devolver', 'original');
  assert.equal(bDevuelta.status, 200, JSON.stringify(bDevuelta.body));
  assert.deepEqual({ estado: bDevuelta.body.anticipo.estado, metodo: bDevuelta.body.anticipo.resueltoMetodo, monto: bDevuelta.body.anticipo.resueltoMonto }, { estado: 'devuelto', metodo: 'tarjeta', monto: 150 });
  assert.equal((await resolver(b.body.id, 'retener')).status, 409, 'un anticipo se resuelve una sola vez');

  // C: 500 en efectivo, consumible; consume 200 → el anticipo lo cubre y sobran 300 que se devuelven.
  const c = await reservar({ elementoId: 'lab-mesa-2', cliente: 'Cliente C', hora: '22:30', anticipoMonto: '500', anticipoMetodo: 'efectivo', anticipoConsumible: 'true' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal((await estado(c.body.id, 'cumplida')).status, 200);
  const cuentaC = await cuenta('lab-mesa-2', 2, c.body.id);
  const cobradaC = await api('POST', '/api/sales', venta(ctx, [linea(prod, 2)], { tipoPedido: 'mesa', mesasCuenta: cuentaC, recibido: 0, anticipoReserva: 200, reservaId: c.body.id }));
  assert.equal(cobradaC.status, 201, JSON.stringify(cobradaC.body)); assert.equal(cobradaC.body.sale.montoEfectivo, 0);
  const cSobra = (await reserva(c.body.id)).anticipo;
  assert.deepEqual({ estado: cSobra.estado, aplicado: cSobra.aplicado }, { estado: 'recibido', aplicado: 200 }, 'quedan 300 por resolver');
  assert.ok((await api('GET', '/api/mesas/reservas')).body.some((r) => r.id === c.body.id), 'el anticipo pendiente sale en la lista');
  const cDevuelta = await resolver(c.body.id, 'devolver', 'efectivo');
  assert.equal(cDevuelta.status, 200, JSON.stringify(cDevuelta.body)); assert.equal(cDevuelta.body.anticipo.resueltoMonto, 300);

  // D: 100 por transferencia, no vino → queda al negocio. E (el de 50 agregado después): cancelada → queda al negocio.
  const dRes = await reservar({ elementoId: 'lab-mesa-1', cliente: 'Cliente D', hora: '23:00', anticipoMonto: '100', anticipoMetodo: 'transferencia', anticipoConsumible: true });
  assert.equal(dRes.status, 201, JSON.stringify(dRes.body));
  assert.equal((await estado(dRes.body.id, 'no_vino')).status, 200);
  assert.equal((await resolver(dRes.body.id, 'retener')).body.anticipo.estado, 'retenido');
  assert.equal((await estado(sinAnticipo.body.id, 'cancelada')).status, 200);
  assert.equal((await resolver(sinAnticipo.body.id, 'retener')).status, 200);

  const despues = await resumen();
  assert.equal(despues.efectivo.esperado, antes.efectivo.esperado + 50 + 300 + 100 + 200 + 500 - 300,
    'efectivo esperado: anticipos en efectivo + lo pagado ahora en las ventas − lo devuelto en efectivo');
  assert.equal(despues.efectivo.anticiposDevueltos, antes.efectivo.anticiposDevueltos + 300);
  assert.equal(despues.tarjeta.cobrado, antes.tarjeta.cobrado, 'el anticipo con tarjeta devuelto por tarjeta no queda cobrado');
  assert.equal(despues.transferencia.cobrado, antes.transferencia.cobrado + 100);
  assert.equal(despues.ventas.total, antes.ventas.total + 400 + 200 + 200, 'lo vendido es el total de las facturas');
  assert.ok(despues.anticipos.aplicados >= 500 && despues.anticipos.retenidos >= 150, JSON.stringify(despues.anticipos));
  assert.ok(despues.movimientos.some((m) => m.tipo === 'Anticipo de reserva') && despues.movimientos.some((m) => m.tipo === 'Devolución anticipo de reserva'));

  const restaurado = await api('PUT', '/api/mesas/plano', { version: conDos.body.version, elementos: elementosAntes });
  assert.equal(restaurado.status, 200, JSON.stringify(restaurado.body));
  await api('PUT', '/api/mesas/config', { activo: false });
  ok('reservas con anticipo: caja del turno, descuento al cobrar sin cambiar la factura, devolución y retención cuadran el efectivo');
}

// Mejora 6 (caso 6).
async function probarTelefono(ctx) {
  const { api } = ctx;
  const sin = await api('POST', '/api/clients', { nombre: 'Sin teléfono' });
  assert.equal(sin.status, 400, JSON.stringify(sin.body));
  const malo = await api('POST', '/api/clients', { nombre: 'Prefijo malo', telefono: '7185551234' });
  assert.equal(malo.status, 400, JSON.stringify(malo.body));
  const corto = await api('POST', '/api/clients', { nombre: 'Incompleto', telefono: '809-555' });
  assert.equal(corto.status, 400);
  const a = await api('POST', '/api/clients', { nombre: 'Familia A', telefono: '(829) 555-7777' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.telefono, '+18295557777'); assert.equal(a.body.telefonoFormateado, '829-555-7777');
  const b = await api('POST', '/api/clients', { nombre: 'Familia B', telefono: '8295557777' });
  assert.equal(b.status, 201); assert.ok(b.body.warnings?.some((w) => w.code === 'PHONE_SHARED'), 'advierte teléfono compartido sin bloquear');
  const ext = await api('POST', '/api/clients', { nombre: 'Cliente exterior', telefono: '+34 600 123 456', phoneCountry: 'INT' });
  assert.equal(ext.status, 201, JSON.stringify(ext.body)); assert.equal(ext.body.telefono, '+34600123456');
  const editarSin = await api('PUT', `/api/clients/${a.body.id}`, { nombre: 'Familia A', telefono: '' });
  assert.equal(editarSin.status, 400, 'al editar se exige corregir el teléfono');
  ok('teléfono obligatorio: vacío, prefijo y longitud rechazados; +1 normalizado; compartido con advertencia; otro país');
}

// Mejora 1 (caso 1).
async function probarPropina(ctx) {
  const { api } = ctx;
  const cfg = await api('PUT', '/api/config/legal-tip', { enabled: true });
  assert.equal(cfg.status, 200, JSON.stringify(cfg.body));
  const comida = await crearProducto(ctx, 'COMIDA18', 'Plato con ITBIS', { aplicaItbis: true, propinaLegal: true });
  const bebida = await crearProducto(ctx, 'NOPROP', 'Producto sin propina', { aplicaItbis: true });
  // 100 + 18 ITBIS + 10 propina (sobre la base sin ITBIS).
  const mesa = await api('POST', '/api/sales', ventaItbis(ctx, [lineaItbis(comida)], { tipoPedido: 'mesa', propinaLegal: 10 }));
  assert.equal(mesa.status, 201, JSON.stringify(mesa.body));
  assert.equal(mesa.body.sale.propinaLegal, 10); assert.equal(mesa.body.sale.total, 128);
  // Descuento de línea 10 %: base 90, ITBIS 16.20, propina 9.
  const desc = await api('POST', '/api/sales', ventaItbis(ctx, [lineaItbis(comida, { descuentoPct: 10 })], { tipoPedido: 'mesa', propinaLegal: 9 }));
  assert.equal(desc.status, 201, JSON.stringify(desc.body)); assert.equal(desc.body.sale.total, 115.2);
  // Alcance por defecto «todo lo consumido»: un producto sin marcar también la lleva.
  assert.equal(cfg.body.config.legalTipScope, 'todos');
  const sinMarcar = await api('POST', '/api/sales', ventaItbis(ctx, [lineaItbis(bebida)], { tipoPedido: 'mesa', propinaLegal: 10 }));
  assert.equal(sinMarcar.status, 201, JSON.stringify(sinMarcar.body)); assert.equal(sinMarcar.body.sale.propinaLegal, 10);
  // Para llevar: sin propina, y la propina manipulada se rechaza.
  const llevar = await api('POST', '/api/sales', ventaItbis(ctx, [lineaItbis(comida)], { tipoPedido: 'recoger', propinaLegal: 0 }));
  assert.equal(llevar.status, 201); assert.equal(llevar.body.sale.propinaLegal, 0);
  const trampa = await api('POST', '/api/sales', ventaItbis(ctx, [lineaItbis(comida)], { tipoPedido: 'recoger', propinaLegal: 10 }));
  assert.equal(trampa.status, 409, 'propina en para llevar se rechaza');
  // Alcance «solo marcados»: el producto sin marcar ya no la lleva.
  const marcados = await api('PUT', '/api/config/legal-tip', { enabled: true, alcance: 'marcados' });
  assert.equal(marcados.status, 200); assert.equal(marcados.body.config.legalTipScope, 'marcados');
  const noMarcado = await api('POST', '/api/sales', ventaItbis(ctx, [lineaItbis(bebida)], { tipoPedido: 'mesa', propinaLegal: 10 }));
  assert.equal(noMarcado.status, 409, 'con «solo marcados» un producto sin marcar no lleva propina');
  assert.equal((await api('PUT', '/api/config/legal-tip', { enabled: true, alcance: 'nada' })).status, 400);
  await api('PUT', '/api/config/legal-tip', { enabled: true, alcance: 'todos' });

  // Quitar la propina en una venta (botón de Cobrar): queda marcada y se reporta.
  const sinItbis = await crearProducto(ctx, 'PROPSI', 'Plato sin ITBIS');
  const quitada = await api('POST', '/api/sales', venta(ctx, [linea(sinItbis)], { tipoPedido: 'mesa', sinPropina: true, propinaLegal: 0 }));
  assert.equal(quitada.status, 201, JSON.stringify(quitada.body)); assert.equal(quitada.body.sale.propinaLegal, 0);
  const quitadaMal = await api('POST', '/api/sales', venta(ctx, [linea(sinItbis)], { tipoPedido: 'mesa', sinPropina: true, propinaLegal: 10, total: 110, recibido: 110 }));
  assert.equal(quitadaMal.status, 409, 'quitada no puede llevar propina');
  // Monto mínimo de la política del negocio: RD$1,000 de consumo sin ITBIS.
  const conMinimo = await api('PUT', '/api/config/legal-tip', { enabled: true, minimo: 1000 });
  assert.equal(conMinimo.status, 200); assert.equal(conMinimo.body.config.legalTipMinimum, 1000);
  const bajo = await api('POST', '/api/sales', venta(ctx, [linea(sinItbis)], { tipoPedido: 'mesa', propinaLegal: 0 }));
  assert.equal(bajo.status, 201, JSON.stringify(bajo.body)); assert.equal(bajo.body.sale.propinaLegal, 0);
  const bajoMal = await api('POST', '/api/sales', venta(ctx, [linea(sinItbis)], { tipoPedido: 'mesa', propinaLegal: 10, total: 110, recibido: 110 }));
  assert.equal(bajoMal.status, 409, 'debajo del mínimo no lleva propina');
  const alto = await api('POST', '/api/sales', venta(ctx, [linea(sinItbis, 10)], { tipoPedido: 'mesa', propinaLegal: 100, total: 1100, recibido: 1100 }));
  assert.equal(alto.status, 201, JSON.stringify(alto.body)); assert.equal(alto.body.sale.propinaLegal, 100);
  assert.equal((await api('PUT', '/api/config/legal-tip', { enabled: true, minimo: -5 })).status, 400);
  await api('PUT', '/api/config/legal-tip', { enabled: true, minimo: 0 });

  const rep = await api('GET', `/api/reports/legal-tips?desde=2000-01-01&hasta=2099-12-31`);
  assert.equal(rep.status, 200, JSON.stringify(rep.body)); assert.equal(rep.body.totals.propina, 129);
  assert.equal(rep.body.quitadas.ventas, 1); assert.equal(rep.body.quitadas.monto, 10);
  ctx.propina = { comida, mesa };
  await api('PUT', '/api/config/legal-tip', { enabled: false });
  ok('propina legal 10 %: separada del ITBIS, con descuento, alcances, quitada en una venta, mínimo de RD$1,000, nunca para llevar, reporte');
}

// Mejora 4 (caso 4) y estados de cuenta (caso 2).
async function probarNotasYCancelaciones(ctx) {
  const { api, branchId, cashRegisterId } = ctx;
  const estructura = { branchId, cashRegisterId };
  const prod = await crearProducto(ctx, 'NCITBIS', 'Producto con ITBIS', { aplicaItbis: true });
  const venta2 = await api('POST', '/api/sales', ventaItbis(ctx, [lineaItbis(prod, { qty: 2 })]));
  assert.equal(venta2.status, 201, JSON.stringify(venta2.body));
  const factura = facturaDe(venta2);
  const aj = await api('GET', `/api/ventas/${factura}/ajustes`);
  assert.equal(aj.status, 200, JSON.stringify(aj.body));
  assert.equal(aj.body.clasificacion.clase, 'ticket'); assert.equal(aj.body.clasificacion.notaCredito.tipo, 'interna');
  const item = aj.body.items[0];
  const esperado0 = await esperadoActual(ctx);
  const stock0 = await stockDe(ctx, prod.id);
  const reqId = randomUUID();
  const nc1 = await api('POST', '/api/sales/return', { invoiceNumber: factura, reason: 'Producto dañado', items: [{ saleItemId: item.id, qty: 1, restock: false }], clientRequestId: reqId, ...estructura });
  assert.equal(nc1.status, 201, JSON.stringify(nc1.body));
  assert.equal(nc1.body.returnedAmount, 118, 'la nota incluye el ITBIS'); assert.equal(nc1.body.itbis, 18);
  assert.equal(await stockDe(ctx, prod.id), stock0, 'dañado: no vuelve al inventario');
  const repetida = await api('POST', '/api/sales/return', { invoiceNumber: factura, reason: 'Producto dañado', items: [{ saleItemId: item.id, qty: 1, restock: false }], clientRequestId: reqId, ...estructura });
  assert.equal(repetida.status, 200); assert.equal(repetida.body.repetida, true); assert.equal(repetida.body.returnId, nc1.body.returnId);
  assert.equal(await esperadoActual(ctx), r2(esperado0 - 118), 'el reintento no devuelve efectivo otra vez');
  const nc2 = await api('POST', '/api/sales/return', { invoiceNumber: factura, reason: 'Devuelve el otro', items: [{ saleItemId: item.id, qty: 1, restock: true }], clientRequestId: randomUUID(), ...estructura });
  assert.equal(nc2.status, 201, JSON.stringify(nc2.body)); assert.equal(nc2.body.alcance, 'total');
  assert.equal(await stockDe(ctx, prod.id), stock0 + 1, 'el que regresa vendible vuelve al inventario');
  const sinSaldo = await api('POST', '/api/sales/return', { invoiceNumber: factura, reason: 'otra', tipo: 'monto', monto: 1, clientRequestId: randomUUID(), ...estructura });
  assert.equal(sinSaldo.status, 409);
  const nota = await api('GET', `/api/ventas/ajustes/${nc1.body.returnId}`);
  assert.equal(nota.status, 200); assert.equal(nota.body.total, 118); assert.match(nota.body.documento, /^NCI-/);
  ctx.ui = { factura, returnId: nc1.body.returnId };
  ok('nota de crédito interna: con ITBIS, sin reintegrar dañados, idempotente, completa la factura y bloquea el exceso');

  // Cancelación de un ticket en efectivo con reembolso desde la caja.
  const simple = await crearProducto(ctx, 'CANC', 'Producto a cancelar');
  const v = await api('POST', '/api/sales', venta(ctx, [linea(simple)]));
  assert.equal(v.status, 201);
  const antes = await esperadoActual(ctx);
  const stockA = await stockDe(ctx, simple.id);
  const sinMotivo = await api('PATCH', `/api/sales/${facturaDe(v)}/cancel`, { ...estructura });
  assert.equal(sinMotivo.status, 400);
  const canc = await api('PATCH', `/api/sales/${facturaDe(v)}/cancel`, { reason: 'Error de captura', refundCash: true, ...estructura });
  assert.equal(canc.status, 200, JSON.stringify(canc.body)); assert.equal(canc.body.modo, 'interna'); assert.equal(canc.body.modoReembolso, 'efectivo');
  assert.equal(await esperadoActual(ctx), r2(antes - 100)); assert.equal(await stockDe(ctx, simple.id), stockA + 1);
  const otraVez = await api('PATCH', `/api/sales/${facturaDe(v)}/cancel`, { reason: 'otra', ...estructura });
  assert.equal(otraVez.status, 409);
  ok('cancelación interna documentada: devuelve efectivo con movimiento, reintegra inventario, no se cancela dos veces');

  // Crédito: nota por monto rebaja la deuda; el estado de cuenta lo muestra.
  const cli = await api('POST', '/api/clients', { nombre: 'Cliente estado', telefono: '849-555-0303', limiteCredito: 0 });
  assert.equal(cli.status, 201);
  const fiado = await api('POST', '/api/sales', venta(ctx, [linea(simple, 2)], { metodo: 'credito', clientId: cli.body.id, recibido: 0, paymentDetails: { creditDueDate: '2026-01-15' } }));
  assert.equal(fiado.status, 201, JSON.stringify(fiado.body));
  const abono = await api('POST', `/api/clients/${cli.body.id}/credit-payments`, { monto: 30, metodo: 'efectivo', ...estructura, clientRequestId: randomUUID() });
  assert.equal(abono.status, 200, JSON.stringify(abono.body));
  const ajuste = await api('POST', '/api/sales/return', { invoiceNumber: facturaDe(fiado), reason: 'Descuento acordado', tipo: 'monto', monto: 50, itbisTasa: 0, refundCash: false, clientRequestId: randomUUID(), ...estructura });
  assert.equal(ajuste.status, 201, JSON.stringify(ajuste.body)); assert.equal(ajuste.body.reembolso.creditoRebajado, 50);
  const mixto = await api('POST', '/api/sales', venta(ctx, [linea(simple)], { metodo: 'mixto', clientId: cli.body.id, recibido: 60, montoEfectivo: 60, montoCredito: 40, paymentDetails: { creditDueDate: '2027-01-31' } }));
  assert.equal(mixto.status, 201, JSON.stringify(mixto.body));
  const cancMixto = await api('PATCH', `/api/sales/${facturaDe(mixto)}/cancel`, { reason: 'Cliente desistió', refundCash: true, ...estructura });
  assert.equal(cancMixto.status, 200, JSON.stringify(cancMixto.body));
  assert.equal(cancMixto.body.reembolso.efectivoDesdeCaja, 60); assert.equal(cancMixto.body.reembolso.creditoRebajado, 40);
  const ec = await api('GET', `/api/clients/${cli.body.id}/statement`);
  assert.equal(ec.status, 200, JSON.stringify(ec.body));
  assert.equal(ec.body.closingBalance, 120, '200 − 30 abono − 50 nota; el mixto cancelado no deja deuda');
  assert.equal(ec.body.reconciliationDifference, 0);
  const tipos = ec.body.rows.map((r) => r.type);
  assert.ok(tipos.some((t) => t.startsWith('Abono')) && tipos.includes('Ajuste de crédito') && tipos.includes('Cancelación de saldo'), tipos.join(', '));
  const cartera = await api('GET', '/api/clients/receivables-report');
  const fila = cartera.body.clientes.find((c) => c.id === cli.body.id);
  assert.equal(fila.balance, 120); assert.equal(fila.vencido, 120, 'la factura vencida (2026-01-15) cuenta como vencida');
  assert.equal(fila.facturasVencidas, 1); assert.equal(fila.estado, 'vencido'); assert.equal(fila.sinLimite, true);
  assert.ok(cartera.body.totalPorCobrar >= 120 && cartera.body.fechaCorte);
  assert.equal(ec.body.deudaVencida, 120); assert.equal(ec.body.deudaVigente, 0);
  const facturaFiado = ec.body.facturas.find((f) => f.factura === facturaDe(fiado));
  assert.equal(facturaFiado.estado, 'vencida'); assert.ok(facturaFiado.diasAtraso > 0);
  const det = await api('GET', `/api/clients/${cli.body.id}/statement/invoice/${facturaFiado.saleId}`);
  assert.equal(det.status, 200, JSON.stringify(det.body));
  assert.equal(det.body.pendiente, 120); assert.equal(det.body.pagos.length, 1); assert.equal(det.body.notas.length, 1);
  Object.assign(ctx.ui, { clienteId: cli.body.id, saleIdCredito: facturaFiado.saleId });
  ok('crédito: abono, nota por monto que rebaja la deuda, cancelación de pago mixto con crédito; estado de cuenta cuadra');
}

// Mejora 7 (caso 5).
async function probarItbisSeparado(ctx) {
  const r = await ctx.api('GET', '/api/reports/itbis-separado?desde=2000-01-01&hasta=2099-12-31');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = r.body.tickets.ticketsInternos;
  assert.ok(t.operaciones > 0);
  assert.equal(r.body.ecf.operaciones, 0);
  assert.equal(r.body.consolidado.operaciones, r.body.tickets.operaciones + r.body.ecf.operaciones, 'el consolidado no duplica');
  // ITBIS de ventas: 18 + 16.2 + 18 + 18 (propina) + 36 (nota) = 106.20; ajustes por las notas: 36.
  assert.equal(r.body.tickets.itbis, 106.2);
  assert.equal(r.body.tickets.ajustes.itbis, 36);
  assert.equal(r.body.tickets.itbisNeto, 70.2);
  assert.equal(r.body.tickets.propinaLegal, 129, 'la propina va aparte del ITBIS');
  assert.ok(r.body.ajustesDetalle.some((a) => a.tipo === 'anulacion'), 'la cancelación resta como anulación');
  ok('ITBIS separado: tickets, e-CF y consolidado sin duplicar; notas y anulaciones como ajustes; propina aparte');
}

// Comprobante tradicional serie B (caso 4): nota B04 con referencia, anulación
// del NCF (608) y cancelación con B04 por el total.
async function probarSerieB(ctx) {
  const { api, branchId, cashRegisterId } = ctx;
  const estructura = { branchId, cashRegisterId };
  for (const ncfType of ['B02', 'B04']) {
    const s = await api('POST', '/api/ncf/sequences', { ncfType, siguienteNumero: 1, maximo: 500, fechaVencimiento: '2027-12-31', activa: true });
    assert.equal(s.status, 200, JSON.stringify(s.body));
  }
  const prod = await crearProducto(ctx, 'SERIEB', 'Producto serie B');
  const ventaB = async () => {
    const r = await api('POST', '/api/sales', venta(ctx, [linea(prod, 2)], { ncfType: 'B02', tipoComprobante: 'comprobante-fiscal' }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(String(r.body.sale.ncf || ''), /^B02/);
    return r;
  };
  const v1 = await ventaB();
  const aj = await api('GET', `/api/ventas/${facturaDe(v1)}/ajustes`);
  assert.equal(aj.body.clasificacion.clase, 'ncf'); assert.equal(aj.body.clasificacion.notaCredito.tipo, 'B04');
  const nota = await api('POST', '/api/sales/return', { invoiceNumber: facturaDe(v1), reason: 'Devolución parcial', items: [{ saleItemId: aj.body.items[0].id, qty: 1 }], clientRequestId: randomUUID(), ...estructura });
  assert.equal(nota.status, 201, JSON.stringify(nota.body));
  assert.match(nota.body.documento, /^B04/); assert.equal(nota.body.tipo, 'nota_credito_b04');
  const imp = await api('GET', `/api/ventas/ajustes/${nota.body.returnId}`);
  assert.equal(imp.body.original.ncf, v1.body.sale.ncf, 'la nota B04 referencia el NCF original');
  const conNotas = await api('PATCH', `/api/sales/${facturaDe(v1)}/cancel`, { reason: 'Anular', modoFiscal: 'anulacion_608', ...estructura });
  assert.equal(conNotas.status, 409, 'con notas parciales no se anula: se emite otra nota');
  const v2 = await ventaB();
  const anul = await api('PATCH', `/api/sales/${facturaDe(v2)}/cancel`, { reason: 'Impreso con error', modoFiscal: 'anulacion_608', refundCash: true, ...estructura });
  assert.equal(anul.status, 200, JSON.stringify(anul.body)); assert.equal(anul.body.modo, 'anulacion_608'); assert.equal(anul.body.notaId, null);
  const v3 = await ventaB();
  const b04 = await api('PATCH', `/api/sales/${facturaDe(v3)}/cancel`, { reason: 'Cliente devolvió todo', modoFiscal: 'nota_credito_b04', refundCash: true, ...estructura });
  assert.equal(b04.status, 200, JSON.stringify(b04.body)); assert.ok(b04.body.notaId);
  const notaTotal = await api('GET', `/api/ventas/ajustes/${b04.body.notaId}`);
  assert.match(notaTotal.body.documento, /^B04/); assert.equal(notaTotal.body.total, 200);
  ok('serie B: nota de crédito B04 con referencia, anulación 608, no se anula con notas previas, cancelación con B04 total');
}

// Mejora 5 (casos 10 y 11).
async function probarAuditoriaYPermisos(ctx) {
  const { api } = ctx;
  const crit = await api('GET', '/api/auditoria?criticos=1&pageSize=200');
  assert.equal(crit.status, 200, JSON.stringify(crit.body));
  const acciones = crit.body.eventos.map((e) => e.accion);
  for (const a of ['Nota de crédito', 'Factura cancelada', 'Cierre de caja']) assert.ok(acciones.includes(a), `${a} en críticos`);
  const ventas = await api('GET', '/api/auditoria?modulo=Ventas&pageSize=10');
  assert.ok(ventas.body.eventos.every((e) => e.modulo === 'Ventas'));
  const detalle = await api('GET', `/api/auditoria/${ventas.body.eventos[0].eventId}`);
  assert.equal(detalle.status, 200); assert.ok(detalle.body.eventId);
  const ids = new Set(crit.body.eventos.map((e) => e.eventId));
  assert.equal(ids.size, crit.body.eventos.length, 'identificadores únicos');
  const secretos = JSON.stringify(crit.body.eventos);
  assert.ok(!/SoloLaboratorio2026|password_hash|"token"/i.test(secretos), 'la auditoría no guarda secretos');

  const u = await api('POST', '/api/users', { nombre: 'Cajero Lab', usuario: 'cajero1', password: 'CajeroLab2026!', roleCode: 'cajero', estado: 'Activo', sucursalId: ctx.branchId, cajaId: ctx.cashRegisterId });
  assert.equal(u.status, 201, JSON.stringify(u.body));
  const cajero = await ctx.login('cajero1', 'CajeroLab2026!');
  const comoCajero = (m, url, body) => ctx.api(m, url, body, cajero.token);
  assert.equal((await comoCajero('GET', '/api/auditoria')).status, 403);
  const arqueo = await ctx.api('POST', '/api/caja/arqueos', { countUuid: randomUUID(), denominaciones: {}, branchId: ctx.branchId, cashRegisterId: ctx.cashRegisterId });
  assert.ok(arqueo.body.sesionCajaId);
  const abierta = await comoCajero('GET', `/api/caja/turnos/${arqueo.body.sesionCajaId}/resumen`);
  assert.equal(abierta.status, 403, 'el cajero no ve el esperado de un turno abierto');
  assert.equal((await api('GET', `/api/caja/turnos/${arqueo.body.sesionCajaId}/resumen`)).status, 200, 'el administrador sí');
  assert.equal((await comoCajero('GET', '/api/reports/itbis-separado')).status, 403);
  assert.equal((await comoCajero('PUT', '/api/caja/config', { cierreSeguro: true })).status, 403);
  const cfgCajero = await comoCajero('GET', '/api/caja/config');
  assert.equal(cfgCajero.status, 200, JSON.stringify(cfgCajero.body));
  assert.equal(cfgCajero.body.veTurnoAbierto, false, 'con cierre seguro el cajero no entra a Reportes');
  assert.equal(cfgCajero.body.puedeConfigurar, false);
  const fallido = await L.request(ctx.port, 'POST', '/api/login', { usuario: 'cajero1', password: 'incorrecta' });
  assert.equal(fallido.status, 401);
  await new Promise((r) => setTimeout(r, 300));
  const den = await api('GET', '/api/auditoria?resultado=denegado&pageSize=50');
  const accionesDen = den.body.eventos.map((e) => e.accion);
  assert.ok(accionesDen.includes('Inicio de sesión fallido') && accionesDen.includes('Acceso denegado'), accionesDen.join(', '));
  assert.ok(!JSON.stringify(den.body).includes('incorrecta'), 'la contraseña intentada no se guarda');
  ok('auditoría: críticos, filtros, detalle, ids únicos, sin secretos; permisos del cajero y accesos denegados registrados');
}

// Respaldo y restauración conservan las tablas nuevas (caso 10).
async function probarRespaldo(ctx, h) {
  const { api } = ctx;
  const antes = (await api('GET', '/api/caja/gaveta?desde=2000-01-01&hasta=2099-12-31')).body.total;
  const backup = await api('POST', '/api/respaldos/crear-local', { carpetaDestino: path.join(h.userData, 'backups') });
  assert.equal(backup.status, 200, JSON.stringify(backup.body));
  const pre = await api('POST', '/api/respaldos/prevalidar', { filePath: backup.body.filePath });
  assert.equal(pre.status, 200, JSON.stringify(pre.body));
  const restore = await api('POST', '/api/respaldos/restaurar-local', { filePath: backup.body.filePath });
  assert.equal(restore.status, 200, JSON.stringify(restore.body));
  const nueva = await ctx.login();
  const despues = await L.request(ctx.port, 'GET', '/api/caja/gaveta?desde=2000-01-01&hasta=2099-12-31', null, nueva.token);
  assert.equal(despues.status, 200, JSON.stringify(despues.body));
  assert.equal(despues.body.total, antes, 'aperturas de gaveta conservadas tras restaurar');
  const aud = await L.request(ctx.port, 'GET', '/api/auditoria?texto=Nota&pageSize=5', null, nueva.token);
  assert.ok(aud.body.total > 0, 'la auditoría se restauró con el respaldo');
  ok('respaldo V3 y restauración conservan gaveta, arqueos, notas y auditoría');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
