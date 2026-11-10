// Prueba con el servidor real y MariaDB temporal: una venta con e-CF sin rango
// vigente se frena antes de cobrar y no deja rastro; con rango sigue su camino.
//
// Uso: node scripts/ecf/probar-venta-sin-rango.js
// No toca datos reales: todo vive en una carpeta temporal.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-venta-sin-rango');
process.env.TC_E2E_DB_PORT = process.env.TC_E2E_DB_PORT || '3428';
const L = require('../e2e-lan/lib');

const PORT = 3498;
const DB_NAME = 'tc_venta_rango';
const USER_DATA = path.join(L.WORK, 'pc-data');
const HOME = path.join(L.WORK, 'home');
const ENV = { DB_CLIENT: 'mysql', DB_HOST: '127.0.0.1', DB_PORT: String(L.DB_PORT), DB_USER: 'root', DB_PASSWORD: '', DB_NAME, USERPROFILE: HOME, HOME };
const ctx = { token: '', branchId: null, cashRegisterId: null, productId: null };

const api = (method, url, body) => L.request(PORT, method, url, body, ctx.token);
const db = (sql) => L.mysqlRoot(sql.replace(/\{db\}/g, DB_NAME));

function venta(tipoComprobante) {
  return {
    userId: 1, clientId: null, cliente: 'Consumidor Final', tipoComprobante, ncfType: null,
    metodo: 'efectivo', tipoPedido: 'mostrador',
    items: [{
      id: ctx.productId, codigo: 'AGU', nombre: 'Agua', qty: 1, precio: 100, descuento: 0,
      itbis: 0, itbisModo: 'porcentaje', total: 100, subtotal: 100, impuestoMonto: 0,
    }],
    subtotal: 100, descuento: 0, itbis: 0, total: 100, recibido: 100, cambio: 0,
    branchId: ctx.branchId, cashRegisterId: ctx.cashRegisterId,
    clientRequestId: `rng${Date.now().toString(16)}${crypto.randomBytes(3).toString('hex')}`,
  };
}

async function estado() {
  const [{ n }] = await db('SELECT COUNT(*) AS n FROM {db}.sales');
  const boot = await api('GET', '/api/bootstrap');
  const prod = (boot.body?.productos || []).find((p) => Number(p.id) === ctx.productId);
  return { ventas: Number(n), stock: Number(prod?.stock) };
}

(async () => {
  let server = null;
  try {
    L.prepareSandbox();
    for (const dir of [USER_DATA, HOME]) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
    await L.startMariaDb({ fresh: true });
    await L.mysqlRoot(`DROP DATABASE IF EXISTS ${DB_NAME}; CREATE DATABASE ${DB_NAME} CHARACTER SET utf8mb4;`);
    server = L.startServer('venta-sin-rango', { port: PORT, userData: USER_DATA, env: ENV });
    await L.waitHttp(PORT);
    const setup = await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'multicaja', networkKey: 'clave-red-rango',
      businessName: 'Colmado Rango', adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@rango.test',
      adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });
    L.check('Negocio configurado', setup.status === 201, `HTTP ${setup.status} ${setup.body?.error || ''}`);
    const login = await L.request(PORT, 'POST', '/api/login', { usuario: 'admin', password: '1234' });
    ctx.token = login.body?.token || '';
    ctx.branchId = login.body?.data?.sucursales?.[0]?.id;
    ctx.cashRegisterId = login.body?.data?.cajasSucursal?.[0]?.id;
    const prod = await api('POST', '/api/products', {
      codigo: 'AGU', barcode: 'AGU', nombre: 'Agua', categoria: 'GENERAL', unidad: 'Unidad', marca: '', precioVenta: 100, precioCompra: 50,
      stock: 20, stockMin: 0, aplicaItbis: false, estado: 'Activo', branchId: ctx.branchId,
    });
    ctx.productId = Number(prod.body?.product?.id || prod.body?.producto?.id || prod.body?.id || 0);
    L.check('Producto creado', ctx.productId > 0, `HTTP ${prod.status} ${prod.body?.error || ''}`);

    // e-CF apagado: crea las tablas y la venta con e-CF se frena (solo se
    // factura con Ticket, serie B con secuencia o e-CF con el emisor activo).
    const apagado = await api('POST', '/api/sales', venta('factura-electronica'));
    L.check('Con e-CF inactivo la venta con e-CF se frena (422)', apagado.status === 422 && /no está activa/.test(apagado.body?.error || ''),
      `HTTP ${apagado.status} ${apagado.body?.error || ''}`);
    const ofrecidosApagado = await api('GET', '/api/fiscal-sequences/available');
    L.check('Con e-CF inactivo Cobrar no ofrece E31/E32', ofrecidosApagado.status === 200
      && !(ofrecidosApagado.body || []).some((r) => /^E/.test(r.documentType)), `HTTP ${ofrecidosApagado.status} ${JSON.stringify(ofrecidosApagado.body)}`.slice(0, 200));

    await db("UPDATE {db}.ecf_emitters SET is_active = 1, environment = 'certecf' WHERE business_id = 1");
    await db(`INSERT INTO {db}.ecf_emitters (business_id, rnc, environment, is_active)
      SELECT 1, '132839676', 'certecf', 1 FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM {db}.ecf_emitters WHERE business_id = 1)`);
    await db('DELETE FROM {db}.ecf_sequences');

    const antes = await estado();
    const sinRango = await api('POST', '/api/sales', venta('factura-electronica'));
    const despues = await estado();
    L.check('Sin rango la venta se frena (422)', sinRango.status === 422, `HTTP ${sinRango.status} ${sinRango.body?.error || ''}`);
    L.check('El mensaje dice qué falta', /E32/.test(sinRango.body?.error || '') && /no se cobró/.test(sinRango.body?.error || ''), sinRango.body?.error || '');
    L.check('No queda venta ni se descuenta inventario', despues.ventas === antes.ventas && despues.stock === antes.stock,
      `ventas ${antes.ventas}→${despues.ventas} · stock ${antes.stock}→${despues.stock}`);

    const ticket = await api('POST', '/api/sales', venta('ticket'));
    L.check('Un ticket no se afecta', ticket.status === 201 || ticket.status === 200, `HTTP ${ticket.status} ${ticket.body?.error || ''}`);

    await db(`INSERT INTO {db}.ecf_sequences (business_id, tipo_comprobante, environment, numero_inicial, numero_final, proximo_numero, activo)
      VALUES (1, 'E32', 'certecf', 1, 100, 1, 1)`);
    const conRango = await api('POST', '/api/sales', venta('factura-electronica'));
    L.check('Con rango la venta pasa', conRango.status === 201 || conRango.status === 200, `HTTP ${conRango.status} ${conRango.body?.error || ''}`);
    const ofrecidos = await api('GET', '/api/fiscal-sequences/available');
    const tiposE = (ofrecidos.body || []).filter((r) => /^E/.test(r.documentType)).map((r) => r.documentType);
    L.check('Cobrar ofrece solo el e-CF con rango (E32 sí, E31 no)', tiposE.includes('E32') && !tiposE.includes('E31'), JSON.stringify(tiposE));
    L.check('Si el e-CF falla después, la respuesta trae el motivo para avisarle al cajero (aquí falta el certificado)',
      Boolean(conRango.body?.ecf?.error), conRango.body?.ecf?.error || JSON.stringify(conRango.body?.ecf));

    await db('UPDATE {db}.ecf_sequences SET proximo_numero = 101');
    const agotado = await api('POST', '/api/sales', venta('factura-electronica'));
    L.check('Con el rango agotado se frena otra vez', agotado.status === 422, `HTTP ${agotado.status} ${agotado.body?.error || ''}`);

    // Desactivar y volver a activar por las rutas reales (con un e-CF ya emitido).
    await db('UPDATE {db}.ecf_sequences SET proximo_numero = 50');
    const [{ id: seqId }] = await db('SELECT id FROM {db}.ecf_sequences LIMIT 1');
    await db(`INSERT INTO {db}.ecf_documents (business_id, sequence_id, tipo_ecf, encf, environment, estado_dgii) VALUES (1, ${Number(seqId)}, 'E32', 'E320000000001', 'certecf', 'aceptado')`).catch(() => {});
    const desactivar = await api('DELETE', `/api/ecf/sequences/${seqId}`);
    L.check('La secuencia se desactiva', desactivar.status === 200, `HTTP ${desactivar.status} ${desactivar.body?.error || ''}`);
    const desactivada = await api('POST', '/api/sales', venta('factura-electronica'));
    L.check('Desactivada, la venta se frena', desactivada.status === 422, `HTTP ${desactivada.status}`);
    const activar = await api('POST', `/api/ecf/sequences/${seqId}/enable`, {});
    L.check('La secuencia se activa de nuevo', activar.status === 200, `HTTP ${activar.status} ${activar.body?.error || ''}`);
    const lista = await api('GET', '/api/ecf/sequences?environment=certecf');
    const fila = (Array.isArray(lista.body) ? lista.body : lista.body?.sequences || []).find((s) => Number(s.id) === Number(seqId));
    L.check('El listado la muestra activa', Boolean(fila?.activo), JSON.stringify({ activo: fila?.activo }));
    const reactivada = await api('POST', '/api/sales', venta('factura-electronica'));
    L.check('Activada, la venta pasa', reactivada.status === 201 || reactivada.status === 200, `HTTP ${reactivada.status} ${reactivada.body?.error || ''}`);

    // Modo sencillo en producción: marcar E32 y facturar, sin rango ni fechas.
    await db('DELETE FROM {db}.ecf_sequences');
    await db('DELETE FROM {db}.ecf_documents');
    await db('DELETE FROM {db}.ecf_sequence_usage');
    await db("UPDATE {db}.ecf_emitters SET environment = 'ecf' WHERE business_id = 1");
    const sinMarcar = await api('POST', '/api/sales', venta('factura-electronica'));
    L.check('Producción sin marcar nada: la venta se frena', sinMarcar.status === 422, `HTTP ${sinMarcar.status}`);
    const marcar = await api('POST', '/api/ecf/sequences/simple', { tipoComprobante: 'E32' });
    L.check('Marcar E32 no pide nada más y empieza en 1', marcar.status === 200 && Number(marcar.body?.sequence?.proximo_numero) === 1,
      `HTTP ${marcar.status} ${marcar.body?.error || JSON.stringify(marcar.body?.sequence?.proximo_numero)}`);
    const sinFecha = await api('POST', '/api/ecf/sequences/simple', { tipoComprobante: 'E31' });
    L.check('Marcar E31 sin fecha se rechaza, porque el XML la exige', sinFecha.status === 422, `HTTP ${sinFecha.status} ${sinFecha.body?.error || ''}`);
    const marcada = await api('POST', '/api/sales', venta('factura-electronica'));
    L.check('Con E32 marcado la venta pasa', marcada.status === 201 || marcada.status === 200, `HTTP ${marcada.status} ${marcada.body?.error || ''}`);

    await api('POST', '/api/ecf/sequences/simple', { tipoComprobante: 'E34' });
    await db('UPDATE {db}.config SET service_company = 1 WHERE id = 1');
    const opciones = await api('GET', `/api/servicios/facturas/comprobantes?branchId=${ctx.branchId}`);

    // Factura a crédito con un RNC escrito a mano: queda en Clientes y no se repite.
    const facturaCliente = (clientRnc) => api('POST', '/api/servicios/facturas', {
      fiscalMode: 'consumidor', condicionPago: 'credito', clientName: 'Cliente Automatico SRL', clientRnc, branchId: ctx.branchId,
      items: [{ descripcion: 'Servicio', cantidad: 1, precio: 100, itbisPct: 18 }],
    });
    const conCliente = await facturaCliente('131-88068-1');
    L.check('Factura con RNC nuevo: agrega el cliente', conCliente.status === 201 && conCliente.body?.clienteNuevo?.cedula === '131880681',
      `HTTP ${conCliente.status} ${JSON.stringify(conCliente.body?.clienteNuevo || conCliente.body?.error)}`);
    const otraCliente = await facturaCliente('131880681');
    L.check('La segunda factura no lo repite', otraCliente.status === 201 && !otraCliente.body?.clienteNuevo && otraCliente.body?.clientId === conCliente.body?.clientId,
      `HTTP ${otraCliente.status} cliente ${otraCliente.body?.clientId}`);
    const clientes = await db("SELECT id FROM {db}.clients WHERE cedula = '131880681'");
    L.check('Queda un solo cliente con ese RNC', clientes.length === 1, JSON.stringify(clientes));
    const ventaCliente = await db(`SELECT client_id FROM {db}.sales WHERE invoice_number = '${String(conCliente.body?.numero).replace(/'/g, '')}'`);
    L.check('La venta a crédito queda a nombre del cliente', Number(ventaCliente[0]?.client_id) === Number(clientes[0]?.id), JSON.stringify(ventaCliente));

    await db('UPDATE {db}.config SET service_company = 0 WHERE id = 1');

    // Comprobantes enviados a la DGII: pide sesión y separa producción de pruebas.
    const sinSesion = await L.request(PORT, 'GET', '/api/ecf/comprobantes');
    L.check('Comprobantes: sin sesión no se ven', sinSesion.status === 401, `HTTP ${sinSesion.status}`);
    const comprobantes = await api('GET', '/api/ecf/comprobantes?estado=rechazado&buscar=E&pagina=1');
    L.check('Comprobantes: la consulta corre en MariaDB', comprobantes.status === 200 && Boolean(comprobantes.body?.resumen),
      `HTTP ${comprobantes.status} ${comprobantes.body?.error || ''}`);
    const pruebasEcf = await api('GET', '/api/ecf/comprobantes?ambiente=pruebas&estado=sin_enviar');
    L.check('Comprobantes: filtro de pruebas y sin enviar', pruebasEcf.status === 200, `HTTP ${pruebasEcf.status} ${pruebasEcf.body?.error || ''}`);

    L.check('Nueva factura de servicios: E32 marcada sale para elegir', (opciones.body?.electronicos || []).some((e) => e.tipo === 'E32' && e.sinCantidad),
      `HTTP ${opciones.status} ${JSON.stringify(opciones.body?.electronicos || opciones.body)}`.slice(0, 160));
    L.check('Nueva factura de servicios: E34 se informa aparte', (opciones.body?.ecfOtros || []).some((e) => e.tipo === 'E34'),
      JSON.stringify(opciones.body?.ecfOtros));

    await db("UPDATE {db}.ecf_sequences SET proximo_numero = 8 WHERE tipo_comprobante = 'E32'");
    const real = await api('POST', '/api/ecf/sequences', {
      tipoComprobante: 'E32', environment: 'ecf', desde: 1, hasta: 100, authorizationReference: '6005604697', fechaAutorizacion: '2026-10-25',
    });
    L.check('Cargar luego el rango de la DGII no choca con el modo sencillo', real.status === 200, `HTTP ${real.status} ${real.body?.error || ''}`);
    const filas = await db("SELECT modo_simple, activo, proximo_numero FROM {db}.ecf_sequences WHERE tipo_comprobante = 'E32' ORDER BY id");
    L.check('El rango real manda y sigue donde iba', filas.length === 2 && Number(filas[0].activo) === 0 && Number(filas[1].activo) === 1 && Number(filas[1].proximo_numero) === 8,
      JSON.stringify(filas));

    // Eliminar un rango con e-CF emitidos: pide confirmar, se quita de la lista y se puede recargar.
    const [{ id: realId }] = await db(`SELECT id FROM {db}.ecf_sequences WHERE tipo_comprobante = 'E32' AND modo_simple = 0 LIMIT 1`);
    await db(`INSERT INTO {db}.ecf_documents (business_id, sequence_id, tipo_ecf, encf, environment, estado_dgii) VALUES (1, ${Number(realId)}, 'E32', 'E320000000050', 'ecf', 'aceptado')`);
    const pedir = await api('DELETE', `/api/ecf/sequences/${realId}/permanent`);
    L.check('Con e-CF emitidos pide confirmación', pedir.status === 409 && pedir.body?.details?.usada === true, `HTTP ${pedir.status} ${pedir.body?.error || ''}`);
    const forzar = await api('DELETE', `/api/ecf/sequences/${realId}/permanent?force=1`);
    L.check('Confirmado, se elimina', forzar.status === 200 && forzar.body?.ok === true, `HTTP ${forzar.status} ${forzar.body?.error || ''}`);
    const quedan = await api('GET', '/api/ecf/sequences?environment=ecf');
    const listadas = Array.isArray(quedan.body) ? quedan.body : quedan.body?.sequences || [];
    L.check('Ya no sale en la lista', !listadas.some((s) => Number(s.id) === Number(realId)), `${listadas.length} en la lista`);
    const [guardada] = await db(`SELECT id, activo FROM {db}.ecf_sequences WHERE id = ${Number(realId)}`);
    L.check('La fila queda para esos e-CF', Boolean(guardada) && Number(guardada.activo) === 0, JSON.stringify(guardada));
    const [doc] = await db("SELECT sequence_id FROM {db}.ecf_documents WHERE encf = 'E320000000050'");
    L.check('El e-CF emitido sigue ligado', Number(doc?.sequence_id) === Number(realId), JSON.stringify(doc));
    const recargar = await api('POST', '/api/ecf/sequences', {
      tipoComprobante: 'E32', environment: 'ecf', desde: 1, hasta: 100, authorizationReference: '6005604697', fechaAutorizacion: '2026-10-25',
    });
    L.check('Su rango se puede cargar otra vez', recargar.status === 200, `HTTP ${recargar.status} ${recargar.body?.error || ''}`);

    // Compras, gastos, devoluciones y cancelaciones: sin certificado el e-CF no sale,
    // pero la operación queda hecha y la respuesta trae el motivo.
    await api('POST', '/api/ecf/sequences/simple', { tipoComprobante: 'E41', fechaVencimiento: `${new Date().getFullYear() + 1}-12-31` });
    await api('POST', '/api/ecf/sequences/simple', { tipoComprobante: 'E43', fechaVencimiento: `${new Date().getFullYear() + 1}-12-31` });
    const proveedor = await api('POST', '/api/suppliers', { nombre: 'Proveedor Informal', rnc: '131880681', telefono: '', email: '', direccion: '' });
    const supplierId = Number(proveedor.body?.id || proveedor.body?.supplier?.id || 0);
    L.check('Proveedor creado', supplierId > 0, `HTTP ${proveedor.status} ${proveedor.body?.error || ''}`);
    const compra = await api('POST', '/api/purchases', {
      supplierId, branchId: ctx.branchId, emitirE41: true, fechaComprobante: '2026-11-01', condicionPago: 'contado',
      items: [{ productId: ctx.productId, codigo: 'AGU', nombre: 'Agua', cantidad: 1, costoUnitario: 50, itbisPct: 18 }],
    });
    L.check('Compra con E41: queda registrada aunque falle el e-CF', compra.status === 201 && /certificado/i.test(compra.body?.ecf?.error || ''),
      `HTTP ${compra.status} ${compra.body?.error || compra.body?.ecf?.error || ''}`);
    const gasto = await api('POST', '/api/expenses', {
      categoria: 'OTROS', branchId: ctx.branchId, descripcion: 'Taxi', fecha: '2026-11-01', estado: 'pagado', emitirEcf: 'E43',
      items: [{ descripcion: 'Taxi', cantidad: 1, precio: 300, itbisPct: 0 }],
    });
    L.check('Gasto con E43: queda registrado aunque falle el e-CF', gasto.status === 201 && /certificado/i.test(gasto.body?.ecf?.error || ''),
      `HTTP ${gasto.status} ${gasto.body?.error || gasto.body?.ecf?.error || ''}`);

    const gastoE41SinRnc = await api('POST', '/api/expenses', {
      categoria: 'OTROS', branchId: ctx.branchId, descripcion: 'Compra', fecha: '2026-11-01', estado: 'pagado', emitirEcf: 'E41',
      items: [{ descripcion: 'Compra', cantidad: 1, precio: 300, itbisPct: 0 }],
    });
    L.check('Gasto con E41 sin proveedor: queda registrado y pide un proveedor con RNC', gastoE41SinRnc.status === 201 && /proveedor/i.test(gastoE41SinRnc.body?.ecf?.error || ''),
      `HTTP ${gastoE41SinRnc.status} ${gastoE41SinRnc.body?.ecf?.error || ''}`);
    const gastoE41 = await api('POST', '/api/expenses', {
      categoria: 'OTROS', branchId: ctx.branchId, descripcion: 'Compra', fecha: '2026-11-01', estado: 'pagado', emitirEcf: 'E41', supplierId,
      items: [{ descripcion: 'Compra', cantidad: 1, precio: 300, itbisPct: 18 }],
    });
    L.check('Gasto con E41 y proveedor: intenta emitirlo', gastoE41.status === 201 && /certificado/i.test(gastoE41.body?.ecf?.error || ''),
      `HTTP ${gastoE41.status} ${gastoE41.body?.ecf?.error || ''}`);

    const aDevolver = await api('POST', '/api/sales', venta('ticket'));
    const factura = aDevolver.body?.sale?.invoiceNumber || aDevolver.body?.sale?.id;
    const [fv] = await db(`SELECT id FROM {db}.sales WHERE invoice_number = '${factura}'`);
    const [linea] = await db(`SELECT id FROM {db}.sale_items WHERE sale_id = ${Number(fv.id)}`);
    await db(`INSERT INTO {db}.ecf_documents (business_id, sale_id, tipo_ecf, encf, environment, estado_dgii) VALUES (1, ${Number(fv.id)}, 'E32', 'E320000000077', 'ecf', 'aceptado')`);
    await api('POST', '/api/ecf/sequences/simple', { tipoComprobante: 'E34' });
    const devolucion = await api('POST', '/api/sales/return', {
      invoiceNumber: factura, reason: 'No sirvió', refundCash: true, branchId: ctx.branchId, cashRegisterId: ctx.cashRegisterId,
      items: [{ saleItemId: Number(linea.id), productId: ctx.productId, qty: 1 }],
    });
    L.check('Devolución de factura e-CF: queda hecha y la respuesta trae la nota', devolucion.status === 201 && /certificado/i.test(devolucion.body?.ecfNota?.error || ''),
      `HTTP ${devolucion.status} ${devolucion.body?.error || JSON.stringify(devolucion.body?.ecfNota)}`.slice(0, 180));
    const aTicket = await api('POST', '/api/sales', venta('ticket'));
    const sinEcf = await api('POST', '/api/sales/return', {
      invoiceNumber: aTicket.body?.sale?.invoiceNumber || aTicket.body?.sale?.id, reason: 'x', refundCash: true, branchId: ctx.branchId, cashRegisterId: ctx.cashRegisterId,
      items: [{ saleItemId: Number((await db(`SELECT si.id FROM {db}.sale_items si JOIN {db}.sales s ON s.id = si.sale_id ORDER BY si.id DESC LIMIT 1`))[0].id), productId: ctx.productId, qty: 1 }],
    });
    L.check('Devolución de un ticket: no hay nota', sinEcf.status === 201 && !sinEcf.body?.ecfNota, `HTTP ${sinEcf.status} ${JSON.stringify(sinEcf.body?.ecfNota)}`);
    const ventaMovida = await api('POST', '/api/sales', venta('ticket'));
    const facturaMovida = ventaMovida.body?.sale?.invoiceNumber || ventaMovida.body?.sale?.id;
    const cancelada = await api('PATCH', `/api/sales/${facturaMovida}/cancel`, { reason: 'Error' });
    L.check('Cancelar un ticket sigue igual', cancelada.status === 200 && !cancelada.body?.ecfNota, `HTTP ${cancelada.status} ${cancelada.body?.error || ''}`);
  } catch (error) {
    L.check('Sin errores inesperados', false, error.stack || error.message);
  } finally {
    await L.stopServer(server);
    await L.stopMariaDb().catch(() => {});
    const fallas = L.results.filter((r) => !r.ok);
    console.log(`\n${L.results.length - fallas.length}/${L.results.length} comprobaciones OK`);
    process.exit(fallas.length ? 1 : 0);
  }
})();
