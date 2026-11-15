'use strict';

/**
 * Prueba las reglas de Firestore de lo que escribe la app de reportes
 * (businesses/{id}/appCompras y businesses/{id}/appSolicitudes) contra el
 * EMULADOR local. No toca el proyecto real.
 *
 *   java -jar cloud-firestore-emulator-v1.19.8.jar --host=127.0.0.1 --port=8089
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8089 node scripts/app-reportes/check-reglas-app.js [archivo.rules]
 */
const fs = require('fs');
const path = require('path');

const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8089';
const PROJECT = 'demo-tc';
const DB = `projects/${PROJECT}/databases/(default)`;
const BASE = `http://${HOST}/v1/${DB}/documents`;

function b64(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function token(uid) {
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: uid, user_id: uid,
    iat: now, exp: now + 3600, auth_time: now, firebase: { sign_in_provider: 'password', identities: {} },
  })}.`;
}
function value(v) {
  if (v === null) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(value) } };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'object') return { mapValue: { fields: campos(v) } };
  return { stringValue: String(v) };
}
function campos(obj) { return Object.fromEntries(Object.entries(obj).map(([k, x]) => [k, value(x)])); }

async function http(method, url, auth, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.status;
}
const seed = (ruta, data) => http('PATCH', `${BASE}/${ruta}`, 'owner', { fields: campos(data) });
const get = (ruta, uid) => http('GET', `${BASE}/${ruta}`, uid ? token(uid) : null);

// Crear (o cambiar campos) con createdAt = hora del servidor, como hace la app.
// Los documentos nuevos llevan un sufijo por corrida: el emulador guarda lo de la anterior.
const CORRIDA = Date.now().toString(36);
function escribir(ruta, uid, data, { horaServidor = true, mascara = null, nuevo = true } = {}) {
  const destino = nuevo ? `${ruta}-${CORRIDA}` : ruta;
  const write = { update: { name: `${DB}/documents/${destino}`, fields: campos(data) } };
  if (mascara) write.updateMask = { fieldPaths: mascara };
  if (horaServidor) write.updateTransforms = [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }];
  if (nuevo) write.currentDocument = { exists: false };
  return http('POST', `${BASE}:commit`, uid ? token(uid) : null, { writes: [write] });
}
function borrar(ruta, uid) { return http('DELETE', `${BASE}/${ruta}`, token(uid)); }
function consultaPropia(coleccion, uid, filtrar = true) {
  const structuredQuery = {
    from: [{ collectionId: coleccion }],
    ...(filtrar ? { where: { fieldFilter: { field: { fieldPath: 'createdBy' }, op: 'EQUAL', value: { stringValue: uid } } } } : {}),
  };
  return http('POST', `${BASE}/businesses/b1:runQuery`, token(uid), { structuredQuery });
}

async function cargarReglas(archivo) {
  const content = fs.readFileSync(archivo, 'utf8');
  const res = await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}:securityRules`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content }] } }),
  });
  if (!res.ok) throw new Error(`Reglas rechazadas por el emulador (${res.status}): ${await res.text()}`);
  console.log(`Reglas cargadas: ${archivo}`);
}

const compra = (uid, extra = {}) => ({
  status: 'pendiente', createdBy: uid, createdByName: 'Prueba', branchId: '1', appVersion: '1.5.0',
  encabezado: { proveedor: { nombre: 'Distribuidora', rnc: '101000002' }, ncf: 'B0100000077', fechaComprobante: '2026-11-09', condicionPago: 'contado' },
  lineas: [{ descripcion: 'Arroz', cantidad: 2, costoUnitario: 100, itbisPct: 18 }],
  ...extra,
});
const solicitud = (uid, extra = {}) => ({
  tipo: 'factura', parametros: { factura: 'FAC-1' }, status: 'pendiente', createdBy: uid, appVersion: '1.5.0', ...extra,
});

async function main() {
  await cargarReglas(process.argv[2] || path.join(__dirname, '..', '..', 'firestore.rules'));
  await seed('users/uOwner', { role: 'admin', businessId: 'b1', businessIds: ['b1'], branchIds: [] });
  await seed('users/uBranch', { role: 'branch_admin', businessId: 'b1', businessIds: ['b1'], branchIds: ['2'] });
  await seed('users/uSup', { role: 'supervisor', businessId: 'b1', businessIds: ['b1'], branchIds: ['2'] });
  await seed('users/uOther', { role: 'admin', businessId: 'b2', businessIds: ['b2'], branchIds: [] });
  await seed('businesses/b1/appSolicitudes/lista1', { ...solicitud('uOwner'), status: 'lista', createdAt: new Date() });
  await seed('businesses/b1/appSolicitudes/lista1/partes/0', { i: 0, data: 'abc' });
  await seed('businesses/b1/appCompras/corr1', { ...compra('uBranch'), status: 'requiere_correccion', createdAt: new Date(), bloqueos: ['x'] });
  await seed('businesses/b1/appCompras/pend1', { ...compra('uBranch'), createdAt: new Date() });
  await seed('businesses/b1/appCompras/reg1', { ...compra('uBranch'), status: 'registrada', createdAt: new Date(), purchaseId: 9 });

  const muchas = Array.from({ length: 201 }, (_, i) => ({ descripcion: `L${i}`, cantidad: 1, costoUnitario: 1 }));
  const cases = [
    // Pedidos de documentos
    ['dueño pide una factura', () => escribir('businesses/b1/appSolicitudes/s1', 'uOwner', solicitud('uOwner')), 200],
    ['admin de sucursal pide un estado de cuenta', () => escribir('businesses/b1/appSolicitudes/s2', 'uBranch', solicitud('uBranch', { tipo: 'estado_cuenta', parametros: { clienteId: 5 } })), 200],
    ['pedido a nombre de otro', () => escribir('businesses/b1/appSolicitudes/s3', 'uOwner', solicitud('uBranch')), 403],
    ['pedido ya marcado como lista', () => escribir('businesses/b1/appSolicitudes/s4', 'uOwner', solicitud('uOwner', { status: 'lista' })), 403],
    ['pedido con un PDF metido por la app', () => escribir('businesses/b1/appSolicitudes/s5', 'uOwner', solicitud('uOwner', { pdf: 'xx' })), 403],
    ['pedido con fecha puesta por la app', () => escribir('businesses/b1/appSolicitudes/s6', 'uOwner', { ...solicitud('uOwner'), createdAt: new Date('2020-01-01') }, { horaServidor: false }), 403],
    ['supervisor NO pide', () => escribir('businesses/b1/appSolicitudes/s7', 'uSup', solicitud('uSup')), 403],
    ['admin de otro negocio NO pide', () => escribir('businesses/b1/appSolicitudes/s8', 'uOther', solicitud('uOther')), 403],
    ['sin sesión NO pide', () => escribir('businesses/b1/appSolicitudes/s9', null, solicitud('x')), 403],
    ['dueño lee su pedido', () => get('businesses/b1/appSolicitudes/lista1', 'uOwner'), 200],
    ['dueño lee las partes de su PDF', () => get('businesses/b1/appSolicitudes/lista1/partes/0', 'uOwner'), 200],
    ['otro admin NO lee el pedido del dueño', () => get('businesses/b1/appSolicitudes/lista1', 'uBranch'), 403],
    ['otro admin NO lee las partes', () => get('businesses/b1/appSolicitudes/lista1/partes/0', 'uBranch'), 403],
    ['la app NO cambia un pedido', () => escribir('businesses/b1/appSolicitudes/lista1', 'uOwner', { status: 'pendiente' }, { horaServidor: false, mascara: ['status'], nuevo: false }), 403],
    ['la app NO borra un pedido', () => borrar('businesses/b1/appSolicitudes/lista1', 'uOwner'), 403],
    ['lista sus pedidos (filtrando por su uid)', () => consultaPropia('appSolicitudes', 'uOwner'), 200],
    ['NO lista todos los pedidos', () => consultaPropia('appSolicitudes', 'uOwner', false), 403],
    // Compras
    ['admin de sucursal manda una compra', () => escribir('businesses/b1/appCompras/c1', 'uBranch', compra('uBranch')), 200],
    ['dueño manda una compra', () => escribir('businesses/b1/appCompras/c2', 'uOwner', compra('uOwner')), 200],
    ['compra a nombre de otro', () => escribir('businesses/b1/appCompras/c3', 'uOwner', compra('uBranch')), 403],
    ['compra ya «registrada» desde la app', () => escribir('businesses/b1/appCompras/c4', 'uOwner', compra('uOwner', { status: 'registrada' })), 403],
    ['compra con el resultado inventado', () => escribir('businesses/b1/appCompras/c5', 'uOwner', compra('uOwner', { purchaseId: 3 })), 403],
    ['compra de 201 líneas', () => escribir('businesses/b1/appCompras/c6', 'uOwner', compra('uOwner', { lineas: muchas })), 403],
    ['compra con fecha puesta por la app', () => escribir('businesses/b1/appCompras/c7', 'uOwner', { ...compra('uOwner'), createdAt: new Date('2020-01-01') }, { horaServidor: false }), 403],
    ['supervisor NO manda compras', () => escribir('businesses/b1/appCompras/c8', 'uSup', compra('uSup')), 403],
    ['admin de otro negocio NO manda compras', () => escribir('businesses/b1/appCompras/c9', 'uOther', compra('uOther')), 403],
    ['reenvía corregida la que volvió', () => escribir('businesses/b1/appCompras/corr1', 'uBranch', { status: 'pendiente', lineas: [{ descripcion: 'Arroz 5 lb', cantidad: 2, costoUnitario: 100 }] }, { horaServidor: false, mascara: ['status', 'lineas'], nuevo: false }), 200],
    ['NO cambia una pendiente (salvo cancelarla)', () => escribir('businesses/b1/appCompras/pend1', 'uBranch', { lineas: [] }, { horaServidor: false, mascara: ['lineas'], nuevo: false }), 403],
    ['cancela su compra pendiente', () => escribir('businesses/b1/appCompras/pend1', 'uBranch', { status: 'cancelada' }, { horaServidor: false, mascara: ['status'], nuevo: false }), 200],
    ['NO marca una compra como registrada', () => escribir('businesses/b1/appCompras/corr1', 'uBranch', { status: 'registrada' }, { horaServidor: false, mascara: ['status'], nuevo: false }), 403],
    ['NO toca una ya registrada', () => escribir('businesses/b1/appCompras/reg1', 'uBranch', { status: 'cancelada' }, { horaServidor: false, mascara: ['status'], nuevo: false }), 403],
    ['el dueño NO cambia la compra de otro', () => escribir('businesses/b1/appCompras/reg1', 'uOwner', { status: 'cancelada' }, { horaServidor: false, mascara: ['status'], nuevo: false }), 403],
    ['NO cambia quién la mandó', () => escribir('businesses/b1/appCompras/corr1', 'uBranch', { createdBy: 'uOwner' }, { horaServidor: false, mascara: ['createdBy'], nuevo: false }), 403],
    ['NO borra compras', () => borrar('businesses/b1/appCompras/reg1', 'uBranch'), 403],
    ['lee su compra', () => get('businesses/b1/appCompras/reg1', 'uBranch'), 200],
    ['otro NO lee esa compra', () => get('businesses/b1/appCompras/reg1', 'uOwner'), 403],
    ['lista sus compras (filtrando por su uid)', () => consultaPropia('appCompras', 'uBranch'), 200],
    ['NO lista las compras de todos', () => consultaPropia('appCompras', 'uBranch', false), 403],
  ];
  let fallas = 0;
  for (const [nombre, hacer, esperado] of cases) {
    let status = await hacer();
    if (status === 401) status = 403;
    // El emulador (v1.19.8 con Java en español) se cae armando el mensaje de una
    // consulta negada (MessageBundle → 500 UNKNOWN). En producción es PERMISSION_DENIED.
    if (status === 500 && /^NO lista/.test(nombre)) status = 403;
    const ok = status === esperado;
    if (!ok) fallas += 1;
    console.log(`${ok ? 'OK   ' : 'FALLA'} ${nombre} — esperado ${esperado}, obtuvo ${status}`);
  }
  console.log(fallas ? `\n${fallas} caso(s) fallaron` : `\n${cases.length}/${cases.length} casos OK`);
  process.exit(fallas ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
