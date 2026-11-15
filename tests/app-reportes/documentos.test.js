'use strict';
// Documentos que pide la app de reportes (server/services/app-reportes):
// factura A4 de una venta, estado de cuenta (POS y Empresa de Servicios) y la
// cola de pedidos en Firestore (partes del PDF, errores, limpieza).
const { firestoreFalso, sqlite, usuariosPos } = require('./helpers');
const { createDocumentosApp } = require('../../server/services/app-reportes/documentos');
const { ventaAFactura, htmlFactura, fechaPapel } = require('../../server/services/app-reportes/factura-de-venta');
const { createSolicitudesApp, PARTE_BYTES } = require('../../server/services/app-reportes/solicitudes-app');
const { pdfEstadoCuenta } = require('../../server/services/app-reportes/estado-cuenta-pdf');
const statement = require('../../server/services/client-statement');

const NEG = 'pos_negocio1';
const QR = 'https://ecf.dgii.gov.do/ecf/ConsultaTimbre?RncEmisor=131000001&RncComprador=101000002&ENCF=E310000000045&FechaEmision=10-11-2026&MontoTotal=1180.00&FechaFirma=10-11-2026%2008:15:02&CodigoSeguridad=Ab12Cd';

const ventaEcf = () => ({
  id: 'FAC-000045', ventaId: 45, documentoFiscal: 'E310000000045', fecha: '2026-11-10 08:15:00', cajero: 'Ana',
  cliente: 'Ferretería Los Primos', clienteRncCedula: '101000002', clienteTelefono: '809-555-0101', razonSocialCliente: 'Ferretería Los Primos SRL',
  metodo: 'credito', montoCredito: 1180, recibido: 200, tipoComprobante: 'factura-electronica', estadoFiscal: 'emitida', estadoDgii: 'aceptado',
  ncf: 'E310000000045', encf: 'E310000000045', ncfType: 'E31', ncfLabel: 'Factura de Crédito Fiscal Electrónica', ncfVencimiento: '2027-12-31',
  tipoEcf: 'E31', esElectronica: true, qrUrl: QR, sucursalId: 1, sucursalInventarioId: 1,
  items: [
    { id: 1, nombre: 'Cemento gris 42.5 kg', qty: 2, precio: 400, itbis: 18, total: 800 },
    { id: 2, nombre: 'Varilla 3/8', qty: 1, precio: 200, itbis: 18, total: 200 },
  ],
  subtotal: 1000, descuento: 0, itbis: 180, total: 1180, propinaLegal: 0,
});

const CFG = { nombre: 'Materiales Emilio', rnc: '131000001', direccion: 'Calle 1', telefono: '809-000-0000', logo: '', mensaje: 'Gracias', invoiceTemplate: 'clasica', moneda: 'RD$' };

const DUENO = { esDueno: true, sucursal: null, usuarioPos: null, puede: () => true };
const SUPERVISOR = { esDueno: false, sucursal: 2, usuarioPos: { id: 3 }, puede: () => false };
const ADMIN_SUC = { esDueno: false, sucursal: 2, usuarioPos: { id: 2 }, puede: () => true };

describe('Factura A4 de una venta', () => {
  test('e-CF: e-NCF, crédito pendiente, código de seguridad y QR, con la plantilla del negocio', () => {
    const d = ventaAFactura(ventaEcf(), CFG, { qrDataUrl: 'data:image/png;base64,QQ==' });
    expect(d).toMatchObject({
      numero: 'FAC-000045', ncf: 'E310000000045', fiscalMode: 'ecf', condicionPago: 'crédito', estadoLabel: 'PAGO PARCIAL',
      pagado: 200, balance: 980, codigoSeguridad: 'Ab12Cd', fechaFirma: '10/11/2026 08:15', qrDataUrl: 'data:image/png;base64,QQ==',
      ncfTipoLabel: 'E31 — Factura de Crédito Fiscal Electrónica', vencimientoTexto: '31/12/2027', fechaTexto: '10/11/2026 08:15',
      cliente: { nombre: 'Ferretería Los Primos SRL', rnc: '101000002' }, empresa: { nombre: 'Materiales Emilio', rnc: '131000001' },
    });
    expect(d.items.map((i) => [i.descripcion, i.itbisMonto])).toEqual([['Cemento gris 42.5 kg', 144], ['Varilla 3/8', 36]]);
    const html = htmlFactura(ventaEcf(), CFG, { qrDataUrl: 'data:image/png;base64,QQ==' });
    expect(html).toContain('E310000000045');
    expect(html).toContain('Ab12Cd');
    expect(html).toContain('data:image/png;base64,QQ==');
  });

  test('ticket sin NCF y con el ITBIS solo en la venta: se reparte por línea; anulada se marca', () => {
    const v = { ...ventaEcf(), metodo: 'efectivo', montoCredito: 0, recibido: 1200, ncf: '', encf: '', ncfType: '', tipoEcf: '', esElectronica: false,
      tipoComprobante: 'ticket', qrUrl: '', items: ventaEcf().items.map((i) => ({ ...i, itbis: 0 })), cancelada: true, estadoFiscal: 'cancelada' };
    const d = ventaAFactura(v, CFG, { qrDataUrl: 'data:image/png;base64,QQ==' });
    expect(d).toMatchObject({ fiscalMode: 'ncf', ncf: '', estadoLabel: 'ANULADA', qrDataUrl: '', codigoSeguridad: '' });
    expect(d.items.reduce((n, i) => n + i.itbisMonto, 0)).toBeCloseTo(180, 2);
  });

  test('combo personalizado: una sola línea con el ITBIS incluido', () => {
    const combo = { clave: 'k1', nombre: 'Combo almuerzo', precio: 236 };
    const v = { ...ventaEcf(), items: [
      { nombre: 'Pollo', qty: 1, precio: 100, itbis: 18, total: 100, comboPersonalizado: combo },
      { nombre: 'Refresco', qty: 2, precio: 50, itbis: 18, total: 100, comboPersonalizado: combo },
    ] };
    const d = ventaAFactura(v, CFG);
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({ descripcion: 'Combo almuerzo · Impuesto incluido', precio: 236, total: 236 });
    expect(d.items[0].nota).toMatch(/1 x Pollo, 2 x Refresco/);
  });

  test('fechas: hora de RD guardada, Date de MariaDB e ISO con zona', () => {
    expect(fechaPapel('2026-11-10 21:05:00')).toBe('10/11/2026 21:05');
    expect(fechaPapel(new Date(2026, 10, 10, 21, 5))).toBe('10/11/2026 21:05');
    expect(fechaPapel('2027-12-31')).toBe('31/12/2027');
    expect(fechaPapel('10-11-2026 08:15:02')).toBe('10/11/2026 08:15');
  });
});

describe('Generadores de documentos', () => {
  function montar({ venta = ventaEcf(), estado, cfg = CFG, query = async () => [] } = {}) {
    const htmls = [];
    const gen = createDocumentosApp({
      query, getConfig: async () => cfg, obtenerVentaImprimible: async (n) => (n === venta?.id ? venta : null),
      estadoDeCuenta: async () => estado, facturaServicioHtml: async (id) => `<html>servicio ${id}</html>`, mapClientRow: (r) => r,
      puedeVerCuentas: (u) => u?.id === 2,
      htmlAPdf: async (html) => { htmls.push(html); return Buffer.from(`%PDF-${html.length}`); },
    });
    return { gen, htmls };
  }

  test('factura: PDF, nombre de archivo y resumen; respeta permisos y sucursal', async () => {
    const { gen, htmls } = montar();
    const r = await gen.factura({ factura: 'FAC-000045' }, DUENO);
    expect(r.archivo).toBe('Factura_E310000000045.pdf');
    expect(r.pdf.toString()).toMatch(/^%PDF-/);
    expect(r.resumen).toMatchObject({ documento: 'E310000000045', total: 1180, cliente: 'Ferretería Los Primos SRL' });
    expect(htmls[0]).toContain('data:image/png;base64,'); // QR del e-CF hecho en la PC
    await expect(gen.factura({ factura: 'FAC-999' }, DUENO)).rejects.toMatchObject({ statusCode: 404 });
    await expect(gen.factura({ factura: 'FAC-000045' }, SUPERVISOR)).rejects.toMatchObject({ statusCode: 403 });
    await expect(gen.factura({ factura: 'FAC-000045' }, ADMIN_SUC)).rejects.toThrow(/otra sucursal/);
  });

  test('Empresa de Servicios: la factura es la de Facturación', async () => {
    const { gen, htmls } = montar({ cfg: { ...CFG, serviceCompany: true }, query: async (sql) => (/svc_invoices/.test(sql) ? [{ id: 12 }] : []) });
    await gen.factura({ factura: 'FAC-000045' }, DUENO);
    expect(htmls[0]).toBe('<html>servicio 12</html>');
  });

  test('estado de cuenta: resumen con las facturas abiertas y el PDF del POS', async () => {
    const report = statement.build({
      client: { id: 5, nombre: 'Juana Pérez', cedula: '00100000001', balance: 600, limiteCredito: 1000 },
      sales: [
        { id: 1, invoice_number: 'FAC-1', financial_version: 1, credit_amount: 500, total: 500, received_amount: 0, created_at: '2026-10-01 09:00:00', credit_due_date: '2026-10-31' },
        { id: 2, invoice_number: 'FAC-2', financial_version: 1, credit_amount: 300, total: 300, received_amount: 0, created_at: '2026-11-05 10:00:00', credit_due_date: '2026-12-05' },
      ],
      payments: [{ sale_id: 1, payment_id: 1, applied_amount: 200, payment_method: 'efectivo', created_at: '2026-10-15 16:00:00', invoice_number: 'FAC-1' }],
      today: '2026-11-10',
    });
    const { gen } = montar({ estado: report });
    const r = await gen.estado_cuenta({ clienteId: 5 }, DUENO);
    expect(r.resumen).toMatchObject({ cliente: 'Juana Pérez', saldoActual: 600, deudaVencida: 300, deudaVigente: 300, limiteCredito: 1000, disponible: 400 });
    expect(r.resumen.facturasAbiertas.map((f) => [f.documento, f.estado, f.pendiente])).toEqual([['FAC-1', 'vencida', 300], ['FAC-2', 'abierta', 300]]);
    expect(r.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(r.archivo).toMatch(/^Estado_de_cuenta_Juana_Perez_2026-11-10\.pdf$/);
    await expect(gen.estado_cuenta({ clienteId: 5 }, SUPERVISOR)).rejects.toMatchObject({ statusCode: 403 });
    await expect(gen.estado_cuenta({}, DUENO)).rejects.toThrow(/Falta el cliente/);
  });

  test('estado de cuenta de la Empresa de Servicios: facturas y cobros de Facturación', async () => {
    const { db, query } = await sqlite();
    db.run('CREATE TABLE clients (id INTEGER PRIMARY KEY, nombre TEXT, cedula TEXT, balance DECIMAL(12,2) DEFAULT 0, limite_credito DECIMAL(12,2) DEFAULT 0)');
    db.run("INSERT INTO clients VALUES (7, 'Clínica Sol', '130000001', 0, 0)");
    db.run(`CREATE TABLE svc_invoices (id INTEGER PRIMARY KEY, numero TEXT, ncf TEXT, client_id INT, fecha TEXT, vencimiento TEXT, total DECIMAL(12,2),
      balance DECIMAL(12,2), estado TEXT, anulada_at TEXT, created_at TEXT)`);
    db.run(`CREATE TABLE svc_invoice_payments (id INTEGER PRIMARY KEY, invoice_id INT, monto DECIMAL(12,2), metodo TEXT, fecha TEXT, created_at TEXT, anulado_at TEXT)`);
    db.run(`INSERT INTO svc_invoices VALUES
      (1, 'SVC-1', 'E310000000001', 7, '2026-10-01', '2026-10-31', 1000, 400, 'parcial', NULL, '2026-10-01 09:00:00'),
      (2, 'SVC-2', 'E310000000002', 7, '2026-11-01', '2026-12-01', 500, 500, 'pendiente', NULL, '2026-11-01 11:00:00'),
      (3, 'SVC-3', 'E310000000003', 7, '2026-11-02', NULL, 300, 0, 'anulada', '2026-11-03 10:00:00', '2026-11-02 08:00:00')`);
    db.run(`INSERT INTO svc_invoice_payments VALUES
      (1, 1, 600, 'transferencia', '2026-10-10', '2026-10-10 15:00:00', NULL),
      (2, 2, 50, 'efectivo', '2026-11-02', '2026-11-02 09:00:00', '2026-11-02 09:30:00')`);
    const { gen } = montar({ cfg: { ...CFG, serviceCompany: true }, query });
    const r = await gen.estado_cuenta({ clienteId: 7 }, DUENO);
    // Lo que debe: 400 de SVC-1 (vencida) + 500 de SVC-2; la anulada y el cobro anulado no cuentan.
    expect(r.resumen.saldoActual).toBe(900);
    expect(r.resumen.deudaVencida).toBe(400);
    expect(r.resumen.deudaVigente).toBe(500);
    expect(r.resumen.facturasAbiertas.map((f) => f.documento)).toEqual(['E310000000001', 'E310000000002']);
  });

  test('el PDF del estado de cuenta aguanta muchas páginas', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ id: `sale-${i}`, date: '2026-11-01 10:00:00', type: 'Factura a crédito', reference: `FAC-${i}`, debit: 10, credit: 0, balance: 10 * (i + 1), status: 'abierta' }));
    const pdf = pdfEstadoCuenta({ client: { nombre: 'Cliente largo' }, rows, openingBalance: 0, closingBalance: 1200, fechaCorte: '2026-11-10', sinLimite: true }, CFG);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length).toBeGreaterThan(2);
  });
});

describe('Cola de pedidos de la app', () => {
  const PERFIL = { 'users/uEmilio': { role: 'admin', posUserId: 1, businessId: NEG, businessIds: [NEG] } };
  const USUARIOS = [{ id: 1, nombre: 'Emilio', estado: 'Activo', role_code: 'administrador_general' }];
  const pedido = (extra = {}) => ({ tipo: 'factura', parametros: { factura: 'FAC-1' }, status: 'pendiente', createdBy: 'uEmilio', createdAt: new Date(), ...extra });

  function montar(pedidos, generadores) {
    const db = firestoreFalso({ ...PERFIL, ...Object.fromEntries(Object.entries(pedidos).map(([id, d]) => [`businesses/${NEG}/appSolicitudes/${id}`, d])) });
    const cola = createSolicitudesApp({ getDb: () => db, getBusinessId: async () => NEG, usuarioApp: usuariosPos(USUARIOS), generadores, logger: { warn: () => {} } });
    const doc = (id) => db._docs.get(`businesses/${NEG}/appSolicitudes/${id}`);
    return { db, cola, doc };
  }

  test('lista: PDF pequeño en el documento; grande partido en /partes', async () => {
    const grande = Buffer.alloc(PARTE_BYTES * 2 + 10, 7);
    const { db, cola, doc } = montar({ p1: pedido(), p2: pedido({ parametros: { factura: 'FAC-2' } }) }, {
      factura: async (p) => ({ titulo: 'F', archivo: `${p.factura}.pdf`, resumen: { total: 1 }, pdf: p.factura === 'FAC-1' ? Buffer.from('%PDF-1') : grande }),
    });
    expect(await cola.procesar()).toMatchObject({ listas: 2 });
    expect(doc('p1')).toMatchObject({ status: 'lista', archivo: 'FAC-1.pdf', partes: 0, tamano: 6 });
    expect(Buffer.from(doc('p1').pdf).toString()).toBe('%PDF-1');
    expect(doc('p2')).toMatchObject({ status: 'lista', partes: 3, tamano: grande.length });
    expect(doc('p2').pdf).toBeUndefined();
    const partes = [0, 1, 2].map((i) => db._docs.get(`businesses/${NEG}/appSolicitudes/p2/partes/${i}`).data);
    expect(Buffer.concat(partes).equals(grande)).toBe(true);
  });

  test('errores: tipo que esta versión no conoce, error del usuario y usuario ajeno', async () => {
    const { cola, doc } = montar({
      e1: pedido({ tipo: 'nomina' }), e2: pedido(), e3: pedido({ createdBy: 'uNadie' }),
    }, { factura: async () => { throw Object.assign(new Error('Esa factura no está en el POS.'), { statusCode: 404 }); } });
    await cola.procesar();
    expect(doc('e1')).toMatchObject({ status: 'error', mensaje: expect.stringMatching(/Actualiza el POS/) });
    expect(doc('e2')).toMatchObject({ status: 'error', mensaje: 'Esa factura no está en el POS.' });
    expect(doc('e3')).toMatchObject({ status: 'error', mensaje: expect.stringMatching(/no pertenece/) });
  });

  test('ya atendida no se repite; a los 3 días se borra con sus partes', async () => {
    let llamadas = 0;
    const vieja = new Date(Date.now() - 4 * 24 * 3600 * 1000);
    const { db, cola, doc } = montar({
      hecha: pedido({ status: 'lista' }), vieja: pedido({ status: 'lista', createdAt: vieja, partes: 1 }),
    }, { factura: async () => { llamadas += 1; return { pdf: Buffer.from('x') }; } });
    db._docs.set(`businesses/${NEG}/appSolicitudes/vieja/partes/0`, { i: 0, data: Buffer.from('x') });
    await cola.procesar();
    expect(llamadas).toBe(0);
    expect(doc('hecha').status).toBe('lista');
    expect(doc('vieja')).toBeUndefined();
    expect(db._docs.has(`businesses/${NEG}/appSolicitudes/vieja/partes/0`)).toBe(false);
  });
});
