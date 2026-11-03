// Todos los e-CF de punta a punta contra un servidor real y un DGII FALSO (scripts/ecf/dgii-falso.js):
// certificado, secuencias, venta/factura, firma, envío, resultado, notas, reenvío, lista y XML.
// Nada sale a la DGII real: dgii-falso-preload.js desvía y bloquea esas salidas.
// Uso: node scripts/ecf/probar-ecf-punta-a-punta.js [--sqlite] [--servicios]
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SQLITE = process.argv.includes('--sqlite');
const SERVICIOS = process.argv.includes('--servicios');
const NOMBRE = `${SERVICIOS ? 'servicios' : 'pos'}-${SQLITE ? 'sqlite' : 'mariadb'}`;
process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), `tecnocaja-ecf-${NOMBRE}`);
process.env.TC_E2E_DB_PORT = process.env.TC_E2E_DB_PORT || '3431';
const L = require('../e2e-lan/lib');
const forge = require(path.join(L.PROJECT, 'node_modules', 'node-forge'));
const { crearDgiiFalso } = require('./dgii-falso');

const PORT = 3481 + (SQLITE ? 1 : 0) + (SERVICIOS ? 2 : 0);
const DB_NAME = 'tc_ecf_pap';
const USER_DATA = path.join(L.WORK, 'pc-data');
const HOME = path.join(L.WORK, 'home');
const XMLS = path.join(L.WORK, 'xml-recibidos');
const RNC = '40211932609';
const VENCE = `${new Date().getFullYear() + 1}-12-31`;
const ctx = { token: '', branchId: null, cashRegisterId: null, productos: {} };
const api = (method, url, body) => L.request(PORT, method, url, body, ctx.token, 90000);
const check = L.check;
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const redondear = (n) => Math.round(Number(n) * 100) / 100;

function crearCertificado(destino, clave) {
  const llaves = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = llaves.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 3 * 365 * 86400000);
  const atributos = [
    { name: 'commonName', value: 'EMILIO MANAURYS CABRERA' },
    { name: 'countryName', value: 'DO' },
    { type: '2.5.4.5', value: `IDCDO-${RNC}` },
  ];
  cert.setSubject(atributos);
  cert.setIssuer(atributos);
  cert.sign(llaves.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(llaves.privateKey, [cert], clave, { algorithm: '3des' });
  fs.writeFileSync(destino, Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'));
}

async function subirCertificado(ruta, clave) {
  const form = new FormData();
  form.append('password', clave);
  form.append('certificate', new Blob([fs.readFileSync(ruta)]), 'prueba.p12');
  const res = await fetch(`http://127.0.0.1:${PORT}/api/ecf/production/reactivar-certificado`, {
    method: 'POST', headers: { Authorization: `Bearer ${ctx.token}` }, body: form,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const dgii = crearDgiiFalso({ carpeta: XMLS });
const ultimoRecibido = () => dgii.estado.recibidos[dgii.estado.recibidos.length - 1];
const recibidoDe = (encf) => [...dgii.estado.recibidos].reverse().find((r) => r.encf === encf);
const tag = (xml, nombre) => (String(xml).match(new RegExp(`<${nombre}>([^<]*)</${nombre}>`)) || [])[1] ?? null;

// Espera el resultado por TrackID a través de la lista, como lo hace la pantalla.
async function documentoDe(encf) {
  const r = await api('GET', `/api/ecf/comprobantes?buscar=${encf}`);
  return r.body?.documents?.find((d) => d.encf === encf) || null;
}
async function resultado(encf) {
  for (let i = 0; i < 12; i += 1) {
    const doc = await documentoDe(encf);
    if (doc && !['enviado', 'en_proceso', 'procesando'].includes(doc.estado)) return doc;
    if (doc) await api('GET', `/api/ecf/documents/${doc.id}/status`);
    await pausa(300);
  }
  return documentoDe(encf);
}

async function comprobarEmitido(nombre, encf, { tipo, total, itbis, indicador, tipoPago, comprador } = {}) {
  check(`${nombre}: salió con número`, Boolean(encf) && (!tipo || encf.startsWith(tipo)), String(encf));
  if (!encf) return null;
  const doc = await resultado(encf);
  check(`${nombre}: aceptado`, doc?.estado === 'aceptado', `${doc?.estado} ${JSON.stringify(doc?.mensajes || [])}`.slice(0, 220));
  const r = recibidoDe(encf);
  check(`${nombre}: llegó a la DGII sin reclamos`, Boolean(r) && !r.errores.length && !r.repetido, JSON.stringify(r?.errores || 'no llegó').slice(0, 220));
  if (r && r.raiz === 'ECF') {
    if (total !== undefined) check(`${nombre}: total ${total}`, Number(tag(r.xml, 'MontoTotal')) === total, String(tag(r.xml, 'MontoTotal')));
    if (itbis !== undefined) check(`${nombre}: ITBIS ${itbis}`, Number(tag(r.xml, 'TotalITBIS') || 0) === itbis, String(tag(r.xml, 'TotalITBIS')));
    if (indicador !== undefined) check(`${nombre}: IndicadorMontoGravado ${indicador}`, tag(r.xml, 'IndicadorMontoGravado') === indicador, String(tag(r.xml, 'IndicadorMontoGravado')));
    if (tipoPago) check(`${nombre}: TipoPago ${tipoPago}`, tag(r.xml, 'TipoPago') === tipoPago, String(tag(r.xml, 'TipoPago')));
    if (comprador) check(`${nombre}: RNC del comprador`, tag(r.xml, 'RNCComprador') === comprador, String(tag(r.xml, 'RNCComprador')));
  }
  check(`${nombre}: tiene enlace de la DGII`, Boolean(doc?.enlace), '');
  const res = await fetch(`http://127.0.0.1:${PORT}/api/ecf/documents/${doc?.id}/xml`, { headers: { Authorization: `Bearer ${ctx.token}` } });
  const xml = await res.text();
  check(`${nombre}: su XML se puede ver`, res.status === 200 && xml.includes(encf) && /<Signature[\s>]/.test(xml), `HTTP ${res.status}`);
  return doc;
}

// ── POS: venta normal ────────────────────────────────────────────────────────
// El precio lo pone el catálogo del servidor: cada producto de prueba tiene el suyo.
const PRECIOS = { GRAV: 100, EXEN: 100, MEDIO: 50, DEC: 33.33, CARO: 300000, SERV: 100 };
function linea(prod, { qty = 1, itbis = 18, descuento = 0 } = {}) {
  const precio = PRECIOS[prod];
  const bruto = redondear(qty * precio);
  const rebaja = redondear(bruto * descuento / 100);
  const impuesto = redondear((bruto - rebaja) * itbis / 100);
  return {
    id: ctx.productos[prod], codigo: prod, nombre: prod, qty, precio, descuento, itbis, itbisModo: 'porcentaje',
    subtotal: bruto, rebaja, total: redondear(bruto - rebaja + impuesto), impuestoMonto: impuesto,
  };
}
function venta(items, extras = {}) {
  const subtotal = redondear(items.reduce((s, i) => s + i.subtotal, 0));
  const descuento = redondear(items.reduce((s, i) => s + i.rebaja, 0));
  const itbis = redondear(items.reduce((s, i) => s + i.impuestoMonto, 0));
  const total = redondear(subtotal - descuento + itbis);
  return {
    userId: 1, clientId: null, cliente: 'Consumidor Final', tipoComprobante: 'factura-electronica', ncfType: null,
    metodo: 'efectivo', tipoPedido: 'mostrador', items, subtotal, descuento, itbis, total, recibido: total, cambio: 0,
    branchId: ctx.branchId, cashRegisterId: ctx.cashRegisterId,
    clientRequestId: `pap${Date.now().toString(16)}${crypto.randomBytes(3).toString('hex')}`,
    ...extras,
  };
}
const encfVenta = (r) => r.body?.sale?.ecf?.encf || r.body?.ecf?.encf || r.body?.sale?.encf || r.body?.encf || null;

async function pruebasPos() {
  const conRnc = { rncCliente: '131880681', razonSocialCliente: 'Cliente Fiscal SRL', cliente: 'Cliente Fiscal SRL' };
  const casos = [
    ['E32 gravada', venta([linea('GRAV')]), { tipo: 'E32' }],
    ['E32 exenta', venta([linea('EXEN', { itbis: 0 })]), { tipo: 'E32' }],
    ['E31 gravada', venta([linea('GRAV')], { ...conRnc, ecfType: 'E31' }), { tipo: 'E31', total: 118, itbis: 18, indicador: '0', comprador: '131880681' }],
    ['E31 exenta', venta([linea('EXEN', { itbis: 0 })], { ...conRnc, ecfType: 'E31' }), { tipo: 'E31', total: 100, itbis: 0, indicador: null }],
    ['E31 mixta', venta([linea('GRAV'), linea('MEDIO', { itbis: 0 })], { ...conRnc, ecfType: 'E31' }), { tipo: 'E31', total: 168, itbis: 18, indicador: '0' }],
    ['E31 con 16%', venta([linea('GRAV', { itbis: 16 })], { ...conRnc, ecfType: 'E31' }), { tipo: 'E31', total: 116, itbis: 16, indicador: '0' }],
    ['E31 con descuento', venta([linea('GRAV', { qty: 2, descuento: 10 })], { ...conRnc, ecfType: 'E31' }), { tipo: 'E31', total: 212.4, itbis: 32.4 }],
    ['E31 con cantidad decimal', venta([linea('DEC', { qty: 1.5 })], { ...conRnc, ecfType: 'E31' }), { tipo: 'E31' }],
    ['E44 régimen especial', venta([linea('EXEN', { itbis: 0 })], { ...conRnc, ecfType: 'E44' }), { tipo: 'E44', itbis: 0 }],
    ['E45 gubernamental', venta([linea('GRAV')], { ...conRnc, ecfType: 'E45' }), { tipo: 'E45', indicador: '0' }],
    ['E46 exportación', venta([linea('GRAV', { itbis: 0 })], { ecfType: 'E46', cliente: 'Foreign Buyer LLC', razonSocialCliente: 'Foreign Buyer LLC' }), { tipo: 'E46' }],
    ['E32 de 250 mil o más con comprador', venta([linea('CARO', { itbis: 0 })], { ...conRnc, ecfType: 'E32' }), { tipo: 'E32', total: 300000 }],
  ];
  const emitidos = {};
  for (const [nombre, cuerpo, esperado] of casos) {
    const r = await api('POST', '/api/sales', cuerpo);
    check(`${nombre}: venta guardada`, r.status === 201, `HTTP ${r.status} ${r.body?.error || ''}`.slice(0, 200));
    const encf = encfVenta(r);
    await comprobarEmitido(nombre, encf, esperado);
    emitidos[nombre] = { encf, factura: r.body?.sale?.invoiceNumber || r.body?.sale?.id, saleId: r.body?.sale?.dbId || r.body?.sale?.saleId };
  }

  // Cliente registrado con todos sus datos: teléfono sin guiones, correo y dirección.
  const conDatos = await api('POST', '/api/clients', { nombre: 'Cliente Completo SRL', cedula: '131880681', telefono: '8095551234', email: 'cliente@correo.com', direccion: 'Av. Duarte 12' });
  const ventaConDatos = await api('POST', '/api/sales', venta([linea('GRAV')], { clientId: conDatos.body?.id, cliente: 'Cliente Completo SRL', ecfType: 'E31' }));
  check('E31 a cliente con todos sus datos: venta guardada', ventaConDatos.status === 201, `HTTP ${ventaConDatos.status} ${ventaConDatos.body?.error || ''}`.slice(0, 200));
  await comprobarEmitido('E31 a cliente con todos sus datos', encfVenta(ventaConDatos), { tipo: 'E31', total: 118 });
  const xmlConDatos = recibidoDe(encfVenta(ventaConDatos))?.xml;
  check('E31 a cliente: teléfono con formato de la DGII', tag(xmlConDatos, 'TelefonoAdicional') === '809-555-1234', String(tag(xmlConDatos, 'TelefonoAdicional')));

  // Bien o servicio: el indicador de cada línea sale del tipo del artículo.
  const indicadores = (xml) => [...String(xml || '').matchAll(/<IndicadorBienoServicio>(\d)<\/IndicadorBienoServicio>/g)].map((m) => m[1]);
  const ventaServicio = await api('POST', '/api/sales', venta([linea('SERV')], { ...conRnc, ecfType: 'E31' }));
  check('E31 de un servicio: venta guardada', ventaServicio.status === 201, `HTTP ${ventaServicio.status} ${ventaServicio.body?.error || ''}`.slice(0, 200));
  await comprobarEmitido('E31 de un servicio', encfVenta(ventaServicio), { tipo: 'E31', total: 118, itbis: 18 });
  const xmlServicio = indicadores(recibidoDe(encfVenta(ventaServicio))?.xml);
  check('E31 de un servicio: indicador 2', xmlServicio.length === 1 && xmlServicio[0] === '2', xmlServicio.join());
  const ventaMixta = await api('POST', '/api/sales', venta([linea('GRAV'), linea('SERV')], { ...conRnc, ecfType: 'E31' }));
  await comprobarEmitido('E31 de producto y servicio', encfVenta(ventaMixta), { tipo: 'E31', total: 236, itbis: 36 });
  const xmlMixta = indicadores(recibidoDe(encfVenta(ventaMixta))?.xml);
  check('E31 de producto y servicio: 1 y 2', xmlMixta.join() === '1,2', xmlMixta.join());

  // E44 y E46 no aceptan una venta que todavía traiga ITBIS.
  const conItbis = await api('POST', '/api/sales', venta([linea('GRAV')], { ...conRnc, ecfType: 'E44' }));
  check('E44 con ITBIS: se frena antes de cobrar', conItbis.status === 422 && conItbis.body?.code !== undefined || conItbis.status === 422, `HTTP ${conItbis.status} ${conItbis.body?.error || ''}`.slice(0, 200));

  // Fiado: con cliente registrado.
  const cliente = await api('POST', '/api/clients', { nombre: 'Cliente a Crédito SRL', cedula: '101010101', limiteCredito: 100000 });
  const fiado = await api('POST', '/api/sales', venta([linea('GRAV')], {
    clientId: cliente.body?.id, cliente: 'Cliente a Crédito SRL', metodo: 'credito', recibido: 0, ecfType: 'E31',
    rncCliente: '101010101', razonSocialCliente: 'Cliente a Crédito SRL',
  }));
  check('E31 fiada: venta guardada', fiado.status === 201, `HTTP ${fiado.status} ${fiado.body?.error || ''}`.slice(0, 200));
  await comprobarEmitido('E31 fiada', encfVenta(fiado), { tipo: 'E31', total: 118, tipoPago: '2' });

  // Comprador faltante: se frena antes de gastar número.
  const antes = dgii.estado.recibidos.length;
  const sinComprador = await api('POST', '/api/sales', venta([linea('GRAV')], { ecfType: 'E31', cliente: '', rncCliente: '' }));
  const encfSin = encfVenta(sinComprador);
  check('E31 sin RNC: no llega a la DGII', dgii.estado.recibidos.length === antes && !encfSin, `HTTP ${sinComprador.status} ${JSON.stringify(sinComprador.body?.sale?.ecf || sinComprador.body?.error || '').slice(0, 170)}`);

  return emitidos;
}

async function pruebasOperaciones() {
  const proveedor = await api('POST', '/api/suppliers', { nombre: 'Proveedor Informal', rnc: '131880681', telefono: '', email: '', direccion: '' });
  const supplierId = Number(proveedor.body?.id || proveedor.body?.supplier?.id || 0);
  check('Proveedor creado', supplierId > 0, `HTTP ${proveedor.status} ${proveedor.body?.error || ''}`);

  const g41 = await api('POST', '/api/expenses', {
    categoria: 'OTROS', branchId: ctx.branchId, descripcion: 'Servicio informal', fecha: new Date().toISOString().slice(0, 10), estado: 'pagado', emitirEcf: 'E41', supplierId,
    items: [{ descripcion: 'Servicio informal', cantidad: 1, precio: 1000, itbisPct: 18 }],
  });
  check('Gasto E41: guardado', g41.status === 201, `HTTP ${g41.status} ${g41.body?.error || ''}`.slice(0, 200));
  await comprobarEmitido('Gasto E41', g41.body?.ecf?.encf, { tipo: 'E41' });

  const g43 = await api('POST', '/api/expenses', {
    categoria: 'OTROS', branchId: ctx.branchId, descripcion: 'Taxi', fecha: new Date().toISOString().slice(0, 10), estado: 'pagado', emitirEcf: 'E43',
    items: [{ descripcion: 'Taxi', cantidad: 1, precio: 300, itbisPct: 0 }],
  });
  check('Gasto E43: guardado', g43.status === 201, `HTTP ${g43.status} ${g43.body?.error || ''}`.slice(0, 200));
  await comprobarEmitido('Gasto E43', g43.body?.ecf?.encf, { tipo: 'E43', total: 300 });

  const g47 = await api('POST', '/api/expenses', {
    categoria: 'OTROS', branchId: ctx.branchId, descripcion: 'Software del exterior', beneficiario: 'Foreign Provider', identificadorExtranjero: 'US-350555123', fecha: new Date().toISOString().slice(0, 10), estado: 'pagado', emitirEcf: 'E47',
    items: [{ descripcion: 'Licencia', cantidad: 1, precio: 500, itbisPct: 0 }],
  });
  check('Gasto E47: guardado', g47.status === 201, `HTTP ${g47.status} ${g47.body?.error || ''}`.slice(0, 200));
  await comprobarEmitido('Gasto E47', g47.body?.ecf?.encf, { tipo: 'E47', total: 500 });
  check('Gasto E47: lleva la identificación del extranjero', tag(recibidoDe(g47.body?.ecf?.encf)?.xml, 'IdentificadorExtranjero') === 'US-350555123');
}

// Notas a mano sobre un comprobante aceptado.
async function pruebasNotas(encfOrigen, nombre) {
  const e34 = await api('POST', '/api/ecf/notas', { encf: encfOrigen, tipoEcf: 'E34', anular: true, razon: 'Se anula la factura' });
  check(`${nombre} E34 que anula: respuesta`, e34.status === 200 && e34.body?.encf, `HTTP ${e34.status} ${JSON.stringify(e34.body).slice(0, 180)}`);
  const docE34 = await comprobarEmitido(`${nombre} E34 que anula`, e34.body?.encf, { tipo: 'E34' });
  if (docE34) {
    const r = recibidoDe(e34.body.encf);
    check(`${nombre} E34: referencia al original`, tag(r?.xml, 'NCFModificado') === encfOrigen, String(tag(r?.xml, 'NCFModificado')));
    check(`${nombre} E34: código 1 (anula)`, tag(r?.xml, 'CodigoModificacion') === '1', String(tag(r?.xml, 'CodigoModificacion')));
  }
  const e33 = await api('POST', '/api/ecf/notas', { encf: encfOrigen, tipoEcf: 'E33', monto: 100, itbis: 18, razon: 'Cargo adicional' });
  check(`${nombre} E33: respuesta`, e33.status === 200 && e33.body?.encf, `HTTP ${e33.status} ${JSON.stringify(e33.body).slice(0, 180)}`);
  await comprobarEmitido(`${nombre} E33`, e33.body?.encf, { tipo: 'E33', total: 118, itbis: 18, indicador: '0' });
}

// ── Empresa de servicios ─────────────────────────────────────────────────────
const lineaServicio = (extra = {}) => ({ descripcion: 'Consultoría', cantidad: 1, precio: 1000, descuentoPct: 0, itbisPct: 18, ...extra });
function factura(ncfTipo, extra = {}) {
  return { fiscalMode: 'ecf', ncfTipo, branchId: ctx.branchId, condicionPago: 'contado', metodoPago: 'efectivo', items: [lineaServicio()], ...extra };
}

async function pruebasServicios() {
  const casos = [
    ['Servicios E32 a consumidor', factura('E32'), { tipo: 'E32' }],
    ['Servicios E32 exenta', factura('E32', { items: [lineaServicio({ itbisPct: 0 })] }), { tipo: 'E32' }],
    ['Servicios E31 con RNC nuevo', factura('E31', { clientName: 'Empresa Nueva SRL', clientRnc: '131-88068-1' }), { tipo: 'E31', total: 1180, itbis: 180, indicador: '0', comprador: '131880681' }],
    ['Servicios E31 a crédito', factura('E31', { clientName: 'Empresa Nueva SRL', clientRnc: '131880681', condicionPago: 'credito' }), { tipo: 'E31', total: 1180, tipoPago: '2' }],
    ['Servicios E31 con descuento', factura('E31', { clientName: 'Empresa Nueva SRL', clientRnc: '131880681', items: [lineaServicio({ cantidad: 2, descuentoPct: 10 })] }), { tipo: 'E31', total: 2124, itbis: 324 }],
    ['Servicios E44', factura('E44', { clientName: 'Zona Franca SRL', clientRnc: '101010102', items: [lineaServicio({ itbisPct: 0 })] }), { tipo: 'E44' }],
    ['Servicios E44 con ITBIS en la línea', factura('E44', { clientName: 'Zona Franca SRL', clientRnc: '101010102' }), { tipo: 'E44', total: 1000, itbis: 0 }],
    ['Servicios E46 con ITBIS en la línea', factura('E46', { clientName: 'Foreign Buyer LLC' }), { tipo: 'E46', total: 1000, itbis: 0 }],
    ['Servicios E45', factura('E45', { clientName: 'Ministerio', clientRnc: '401000000' }), { tipo: 'E45', indicador: '0' }],
    ['Servicios E46', factura('E46', { clientName: 'Foreign Buyer LLC', items: [lineaServicio({ itbisPct: 0 })] }), { tipo: 'E46' }],
  ];
  const emitidas = {};
  for (const [nombre, cuerpo, esperado] of casos) {
    const r = await api('POST', '/api/servicios/facturas', cuerpo);
    check(`${nombre}: factura guardada`, r.status === 201, `HTTP ${r.status} ${r.body?.error || ''}`.slice(0, 200));
    check(`${nombre}: sin error de e-CF`, !r.body?.ecf?.error, String(r.body?.ecf?.error || ''));
    await comprobarEmitido(nombre, r.body?.ecf?.encf || r.body?.ncf, esperado);
    emitidas[nombre] = r.body;
  }
  const nueva = emitidas['Servicios E31 con RNC nuevo'];
  check('Servicios: el RNC nuevo quedó en Clientes', Boolean(nueva?.clienteNuevo?.id), JSON.stringify(nueva?.clienteNuevo));
  check('Servicios: no repite el cliente', !emitidas['Servicios E31 a crédito']?.clienteNuevo && emitidas['Servicios E31 a crédito']?.clientId === nueva?.clientId);

  // El badge de la lista refleja el resultado de la DGII.
  const lista = await api('GET', '/api/servicios/facturas?todas=1');
  const fila = lista.body?.find?.((f) => f.id === nueva?.id);
  check('Servicios: la lista dice Aceptado', fila?.ecfStatus === 'aceptado', String(fila?.ecfStatus));
  const consultar = await api('POST', '/api/servicios/facturas/consultar-ecf', {});
  check('Servicios: consultar pendientes corre', consultar.status === 200, `HTTP ${consultar.status} ${consultar.body?.error || ''}`);

  // Bien o servicio en una factura de servicios: sin producto es servicio.
  const indicadores = (xml) => [...String(xml || '').matchAll(/<IndicadorBienoServicio>(\d)<\/IndicadorBienoServicio>/g)].map((m) => m[1]);
  const conRncServicios = { clientName: 'Empresa Nueva SRL', clientRnc: '131880681' };
  const soloServicio = await api('POST', '/api/servicios/facturas', factura('E31', conRncServicios));
  check('Servicios: una línea de servicio lleva indicador 2', indicadores(recibidoDe(soloServicio.body?.ncf)?.xml).join() === '2', indicadores(recibidoDe(soloServicio.body?.ncf)?.xml).join());
  const activar = await api('PUT', '/api/servicios/config', { productos: true });
  check('Servicios: activar la venta de productos', activar.status === 200, `HTTP ${activar.status} ${activar.body?.error || ''}`);
  const articulo = await api('POST', '/api/products', {
    codigo: 'PROD-S', barcode: 'PROD-S', nombre: 'Producto de la empresa', categoria: 'GENERAL', unidad: 'Unidad', marca: '', precioVenta: 500, precioCompra: 100,
    stock: 10, stockMin: 0, aplicaItbis: true, estado: 'Activo', branchId: ctx.branchId,
  });
  const articuloId = Number(articulo.body?.product?.id || articulo.body?.id || 0);
  check('Servicios: crear un producto', articuloId > 0, `HTTP ${articulo.status} ${articulo.body?.error || ''}`);
  const mixta = await api('POST', '/api/servicios/facturas', factura('E31', {
    ...conRncServicios,
    items: [{ productId: articuloId, descripcion: 'Producto de la empresa', cantidad: 2, precio: 500, descuentoPct: 0, itbisPct: 18 }, lineaServicio()],
  }));
  check('Servicios: factura con producto y servicio', mixta.status === 201, `HTTP ${mixta.status} ${mixta.body?.error || ''}`);
  await comprobarEmitido('Servicios: producto y servicio', mixta.body?.ncf, { tipo: 'E31', total: 2360, itbis: 360 });
  check('Servicios: producto 1 y servicio 2', indicadores(recibidoDe(mixta.body?.ncf)?.xml).join() === '1,2', indicadores(recibidoDe(mixta.body?.ncf)?.xml).join());

  // Documento impreso en cada formato.
  for (const formato of ['a4', '80mm', '58mm']) {
    const doc = await api('GET', `/api/servicios/facturas/${nueva?.id}/documento?formato=${formato}`);
    check(`Servicios: documento ${formato}`, doc.status === 200 && /E31/.test(doc.body?.html || ''), `HTTP ${doc.status} ${doc.body?.error || ''}`);
  }

  // Cobrar lo fiado: no se emite otro comprobante.
  const fiada = emitidas['Servicios E31 a crédito'];
  check('Servicios: la fiada queda con balance', Number(fiada?.balance) === 1180, String(fiada?.balance));
  const recibidosAntes = dgii.estado.recibidos.length;
  const cobro = await api('POST', '/api/servicios/cobros', { invoiceId: fiada?.id, monto: 1180, metodo: 'efectivo' });
  check('Servicios: cobro de la fiada', [200, 201].includes(cobro.status), `HTTP ${cobro.status} ${cobro.body?.error || ''}`);
  check('Servicios: cobrar no emite otro e-CF', dgii.estado.recibidos.length === recibidosAntes);

  // Cotización → factura.
  const cot = await api('POST', '/api/servicios/cotizaciones', { clientName: 'Cotizado SRL', clientRnc: '101010103', items: [lineaServicio()] });
  check('Servicios: cotización con RNC nuevo', cot.status === 201 && Boolean(cot.body?.clienteNuevo), `HTTP ${cot.status} ${cot.body?.error || ''}`);
  const convertir = await api('POST', `/api/servicios/facturas/desde-cotizacion/${cot.body?.id}`, { fiscalMode: 'ecf', ncfTipo: 'E31', condicionPago: 'contado', metodoPago: 'efectivo' });
  check('Servicios: cotización a factura', [200, 201].includes(convertir.status), `HTTP ${convertir.status} ${convertir.body?.error || ''}`.slice(0, 180));
  if (convertir.body?.ecf?.encf) await comprobarEmitido('Servicios cotización a factura', convertir.body.ecf.encf, { tipo: 'E31', total: 1180 });

  // Anular una factura aceptada: E34 sola.
  const aAnular = emitidas['Servicios E31 con descuento'];
  const anulada = await api('POST', `/api/servicios/facturas/${aAnular?.id}/anular`, { motivo: 'Error de digitación', forzar: true });
  check('Servicios: anular', anulada.status === 200, `HTTP ${anulada.status} ${anulada.body?.error || ''}`);
  const encfNota = anulada.body?.ecfNota?.encf;
  check('Servicios: anular emite la E34', Boolean(encfNota), JSON.stringify(anulada.body?.ecfNota).slice(0, 180));
  if (encfNota) await comprobarEmitido('Servicios E34 al anular', encfNota, { tipo: 'E34' });

  // Rechazo y reintento desde la lista: sale con otro número y la lista se pone al día.
  dgii.estado.rechazarSiguiente = 1;
  const rechazada = await api('POST', '/api/servicios/facturas', factura('E31', { clientName: 'Empresa Nueva SRL', clientRnc: '131880681' }));
  const encfRechazado = rechazada.body?.ecf?.encf;
  const docRechazado = await resultado(encfRechazado);
  check('Servicios: rechazo con motivo', docRechazado?.estado === 'rechazado' && docRechazado?.mensajes?.[0]?.codigo === '8000', JSON.stringify(docRechazado?.mensajes));
  check('Servicios: rechazado sin enlace', !docRechazado?.enlace);
  const reintento = await api('POST', `/api/servicios/facturas/${rechazada.body?.id}/reintentar-ecf`, {});
  check('Servicios: reintentar', reintento.status === 200, `HTTP ${reintento.status} ${reintento.body?.error || ''}`.slice(0, 200));
  const encfNuevo = reintento.body?.ecf?.encf;
  check('Servicios: el reintento usa otro número', Boolean(encfNuevo) && encfNuevo !== encfRechazado, `${encfRechazado} → ${encfNuevo}`);
  await comprobarEmitido('Servicios reintento', encfNuevo, { tipo: 'E31', total: 1180, itbis: 180, indicador: '0' });
  await pausa(300);
  await api('POST', '/api/servicios/facturas/consultar-ecf', {});
  const trasReintento = await api('GET', `/api/servicios/facturas/${rechazada.body?.id}`);
  check('Servicios: la factura muestra el número nuevo y aceptado', trasReintento.body?.ncf === encfNuevo && trasReintento.body?.ecfStatus === 'aceptado', `${trasReintento.body?.ncf} ${trasReintento.body?.ecfStatus}`);
  return emitidas['Servicios E31 con RNC nuevo']?.ncf;
}

(async () => {
  let server = null;
  try {
    L.prepareSandbox();
    for (const dir of [USER_DATA, HOME, XMLS]) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
    fs.mkdirSync(XMLS, { recursive: true });
    const puertoDgii = await dgii.escuchar();
    const ENV = {
      ...(SQLITE ? { DB_CLIENT: 'sqlite' } : { DB_CLIENT: 'mysql', DB_HOST: '127.0.0.1', DB_PORT: String(L.DB_PORT), DB_USER: 'root', DB_PASSWORD: '', DB_NAME }),
      USERPROFILE: HOME, HOME,
      TC_DGII_FALSO_PUERTO: String(puertoDgii),
      // La copia del proyecto vive en una ruta sin espacios: NODE_OPTIONS no los admite bien.
      NODE_OPTIONS: `--require ${path.join(L.APP, 'scripts', 'ecf', 'dgii-falso-preload.js').split(path.sep).join('/')}`,
    };
    if (!SQLITE) {
      await L.startMariaDb({ fresh: true });
      await L.mysqlRoot(`DROP DATABASE IF EXISTS ${DB_NAME}; CREATE DATABASE ${DB_NAME} CHARACTER SET utf8mb4;`);
    }
    server = L.startServer(`ecf-${NOMBRE}`, { port: PORT, userData: USER_DATA, env: ENV });
    await L.waitHttp(PORT);
    const setup = await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: SERVICIOS ? 'srv_tecnologia' : 'colmado', businessStructureMode: 'monocaja',
      businessName: 'Negocio Prueba', adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@prueba.test',
      adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });
    check('Negocio configurado', setup.status === 201, `HTTP ${setup.status} ${setup.body?.error || ''}`);
    const login = await L.request(PORT, 'POST', '/api/login', { usuario: 'admin', password: '1234' });
    ctx.token = login.body?.token || '';
    ctx.branchId = login.body?.data?.sucursales?.[0]?.id;
    ctx.cashRegisterId = login.body?.data?.cajasSucursal?.[0]?.id;

    const negocio = await api('POST', '/api/ecf/config/business', {
      rnc: RNC, razon_social: 'EMILIO MANAURYS CABRERA', nombre_comercial: 'Negocio Prueba', direccion: 'Calle 1 No. 2',
      provincia: '', municipio: '', telefono: '809-555-1234', correo: 'negocio@prueba.test',
    });
    check('Datos del emisor', negocio.status === 200, `HTTP ${negocio.status} ${negocio.body?.error || ''}`);

    const rutaP12 = path.join(L.WORK, 'prueba.p12');
    crearCertificado(rutaP12, 'clave-prueba');
    const cert = await subirCertificado(rutaP12, 'clave-prueba');
    check('Certificado y producción', cert.status === 200 && cert.body?.ok !== false, `HTTP ${cert.status} ${JSON.stringify(cert.body).slice(0, 260)}`);
    const estado = await api('GET', '/api/ecf/status');
    check('Quedó en producción', estado.body?.environment === 'ecf', JSON.stringify({ env: estado.body?.environment, activo: estado.body?.isActive }));

    for (const tipo of ['E31', 'E32', 'E33', 'E34', 'E41', 'E43', 'E44', 'E45', 'E46', 'E47']) {
      const sinFecha = ['E32', 'E34'].includes(tipo);
      const r = await api('POST', '/api/ecf/sequences/simple', { tipoComprobante: tipo, ...(sinFecha ? {} : { fechaVencimiento: VENCE }) });
      if (r.status !== 200) check(`Activar ${tipo}`, false, `HTTP ${r.status} ${r.body?.error || ''}`);
    }
    check('Secuencias activadas', true);

    let encfOrigen = null;
    if (SERVICIOS) {
      encfOrigen = await pruebasServicios();
    } else {
      for (const [codigo, itbis] of [['GRAV', true], ['EXEN', false], ['MEDIO', false], ['DEC', true], ['CARO', false]]) {
        const prod = await api('POST', '/api/products', {
          codigo, barcode: codigo, nombre: codigo, categoria: 'GENERAL', unidad: 'Unidad', marca: '', precioVenta: PRECIOS[codigo], precioCompra: 1,
          stock: 1000, stockMin: 0, aplicaItbis: itbis, estado: 'Activo', branchId: ctx.branchId,
        });
        ctx.productos[codigo] = Number(prod.body?.product?.id || prod.body?.producto?.id || prod.body?.id || 0);
      }
      const servicio = await api('POST', '/api/products', {
        codigo: 'SERV', barcode: 'SERV', nombre: 'Servicio tecnico', categoria: 'GENERAL', unidad: 'Unidad', marca: '', precioVenta: 100, precioCompra: 0,
        stock: 0, stockMin: 0, aplicaItbis: true, estado: 'Activo', branchId: ctx.branchId, tipoProducto: 'servicio', tracksStock: false,
      });
      ctx.productos.SERV = Number(servicio.body?.product?.id || servicio.body?.producto?.id || servicio.body?.id || 0);
      const emitidos = await pruebasPos();
      encfOrigen = emitidos['E31 mixta']?.encf;

      // Rechazo y reenvío desde la lista de comprobantes.
      dgii.estado.rechazarSiguiente = 1;
      const rechazada = await api('POST', '/api/sales', venta([linea('GRAV')], { rncCliente: '131880681', razonSocialCliente: 'Cliente Fiscal SRL', cliente: 'Cliente Fiscal SRL', ecfType: 'E31' }));
      const encfRechazado = encfVenta(rechazada);
      const docRechazado = await resultado(encfRechazado);
      check('POS: rechazo con motivo', docRechazado?.estado === 'rechazado' && docRechazado?.mensajes?.[0]?.codigo === '8000', JSON.stringify(docRechazado?.mensajes));
      const reenvio = await api('POST', `/api/ecf/documents/${docRechazado?.id}/resend`, {});
      check('POS: reenviar', reenvio.status === 200 && reenvio.body?.encf && reenvio.body.encf !== encfRechazado, `HTTP ${reenvio.status} ${JSON.stringify(reenvio.body).slice(0, 200)}`);
      await comprobarEmitido('POS reenvío', reenvio.body?.encf, { tipo: 'E31', total: 118, itbis: 18, indicador: '0' });

      // Devoluciones y cancelación: E34 sola.
      const aDevolver = await api('POST', '/api/sales', venta([linea('GRAV', { qty: 2 })], { rncCliente: '131880681', razonSocialCliente: 'Cliente Fiscal SRL', cliente: 'Cliente Fiscal SRL', ecfType: 'E31' }));
      const encfDevuelto = encfVenta(aDevolver);
      await comprobarEmitido('POS venta a devolver', encfDevuelto, { tipo: 'E31', total: 236 });
      const facturaDevuelta = aDevolver.body?.sale?.invoiceNumber || aDevolver.body?.sale?.id;
      const detalleDevolucion = await api('GET', `/api/sales/${encodeURIComponent(facturaDevuelta)}/return-detail`);
      const devolucion = await api('POST', '/api/sales/return', {
        invoiceNumber: facturaDevuelta, reason: 'No sirvió', refundCash: true, branchId: ctx.branchId, cashRegisterId: ctx.cashRegisterId,
        items: [{ saleItemId: detalleDevolucion.body?.items?.[0]?.id, productId: ctx.productos.GRAV, qty: 1 }],
      });
      check('POS devolución parcial: hecha', devolucion.status === 201, `HTTP ${devolucion.status} ${devolucion.body?.error || ''}`.slice(0, 200));
      const encfDev = devolucion.body?.ecfNota?.encf;
      check('POS devolución parcial: trae la E34', Boolean(encfDev), JSON.stringify(devolucion.body?.ecfNota).slice(0, 200));
      if (encfDev) {
        await comprobarEmitido('POS E34 de devolución', encfDev, { tipo: 'E34', total: 118, itbis: 18 });
        const r = recibidoDe(encfDev);
        check('POS E34 de devolución: referencia y código 3', tag(r?.xml, 'NCFModificado') === encfDevuelto && tag(r?.xml, 'CodigoModificacion') === '3', `${tag(r?.xml, 'NCFModificado')} ${tag(r?.xml, 'CodigoModificacion')}`);
      }
      const aCancelar = await api('POST', '/api/sales', venta([linea('GRAV')], { rncCliente: '131880681', razonSocialCliente: 'Cliente Fiscal SRL', cliente: 'Cliente Fiscal SRL', ecfType: 'E31' }));
      const encfCancelado = encfVenta(aCancelar);
      await comprobarEmitido('POS venta a cancelar', encfCancelado, { tipo: 'E31' });
      const cancelada = await api('PATCH', `/api/sales/${aCancelar.body?.sale?.invoiceNumber || aCancelar.body?.sale?.id}/cancel`, { reason: 'Error' });
      check('POS cancelar: hecha', cancelada.status === 200, `HTTP ${cancelada.status} ${cancelada.body?.error || ''}`.slice(0, 200));
      const encfCan = cancelada.body?.ecfNota?.encf;
      check('POS cancelar: trae la E34', Boolean(encfCan), JSON.stringify(cancelada.body?.ecfNota).slice(0, 200));
      if (encfCan) await comprobarEmitido('POS E34 de cancelación', encfCan, { tipo: 'E34', total: 118 });

      // Compra con E41.
      const proveedor = await api('POST', '/api/suppliers', { nombre: 'Proveedor Compra', rnc: '131880681', telefono: '', email: '', direccion: '' });
      const compra = await api('POST', '/api/purchases', {
        supplierId: Number(proveedor.body?.id || proveedor.body?.supplier?.id || 0), branchId: ctx.branchId, emitirE41: true, fechaComprobante: new Date().toISOString().slice(0, 10), condicionPago: 'contado',
        items: [{ productId: ctx.productos.GRAV, codigo: 'GRAV', nombre: 'GRAV', cantidad: 2, costoUnitario: 50, itbisPct: 18 }],
      });
      check('Compra E41: guardada', compra.status === 201, `HTTP ${compra.status} ${compra.body?.error || ''}`.slice(0, 200));
      await comprobarEmitido('Compra E41', compra.body?.ecf?.encf, { tipo: 'E41', total: 118, itbis: 18, indicador: '0' });
    }

    await pruebasOperaciones();
    if (encfOrigen) await pruebasNotas(encfOrigen, SERVICIOS ? 'Servicios' : 'POS');

    // Tipo sin autorización en la DGII: rechazo 135 visible.
    dgii.estado.tiposSinRango.add('E33');
    const sinRango = await api('POST', '/api/ecf/notas', { encf: encfOrigen, tipoEcf: 'E33', monto: 10, itbis: 0, razon: 'Sin rango' });
    const docSinRango = await resultado(sinRango.body?.encf);
    check('Sin autorización: rechazo 135 visible', docSinRango?.mensajes?.some((m) => m.codigo === '135'), JSON.stringify(docSinRango?.mensajes));
    dgii.estado.tiposSinRango.clear();

    // Los comprobantes y su XML piden sesión.
    const lista0 = await api('GET', '/api/ecf/comprobantes');
    const idDoc = lista0.body?.documents?.[0]?.id;
    for (const [metodo, ruta] of [['GET', '/api/ecf/documents'], ['GET', `/api/ecf/documents/${idDoc}/xml`], ['GET', `/api/ecf/documents/${idDoc}/status`], ['POST', `/api/ecf/documents/${idDoc}/resend`], ['GET', '/api/ecf/print/step5-docs'], ['GET', '/api/ecf/print/step5-xml-bundle'], ['GET', '/api/ecf/print/repr-impresa/E310000000001'], ['GET', '/api/ecf/print/qr-diagnostics'], ['GET', '/api/ecf/enviados/current/xml']]) {
      const sinSesion = await L.request(PORT, metodo, ruta);
      check(`Sin sesión: ${metodo} ${ruta.replace(String(idDoc), ':id')}`, sinSesion.status === 401, `HTTP ${sinSesion.status}`);
    }

    // Resumen de la lista y números sin repetir.
    const lista = await api('GET', '/api/ecf/comprobantes');
    const resumen = lista.body?.resumen || {};
    check('Lista: cuadra con lo recibido', resumen.total >= dgii.estado.recibidos.filter((r) => !r.repetido).length - 2 && resumen.proceso === 0, JSON.stringify(resumen));
    const encfs = dgii.estado.recibidos.map((r) => `${r.raiz}:${r.encf}`);
    const repetidos = encfs.filter((e, i) => encfs.indexOf(e) !== i);
    check('Ningún e-NCF se envió dos veces', repetidos.length === 0, repetidos.join(', '));
    const noSimuladas = dgii.estado.rutas.filter((r) => !/Semilla|Validacion|Validar|Recepcion|Consulta/i.test(r));
    check('Todo lo enviado pasó por el DGII falso', dgii.estado.recibidos.length > 0 && noSimuladas.length === 0, noSimuladas.join(' | ').slice(0, 200));

    const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    const xsd = spawnSync(pwsh, ['-NoProfile', '-File', path.join(__dirname, 'validar-xsd.ps1'), XMLS], { encoding: 'utf8' });
    check('Todos los XML pasan el XSD de la DGII', xsd.status === 0, (xsd.stdout || xsd.stderr || '').trim().slice(-900));
  } catch (error) {
    check('Sin errores inesperados', false, error.stack || error.message);
  } finally {
    await L.stopServer(server);
    if (!SQLITE) await L.stopMariaDb().catch(() => {});
    await dgii.cerrar();
    const fallas = L.results.filter((r) => !r.ok);
    console.log(`\n[${NOMBRE}] ${L.results.length - fallas.length}/${L.results.length} comprobaciones OK · registros en ${L.WORK}`);
    process.exit(fallas.length ? 1 : 0);
  }
})();
