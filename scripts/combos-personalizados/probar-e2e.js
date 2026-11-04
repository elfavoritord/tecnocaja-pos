// Prueba de punta a punta de los Combos personalizados con el servidor real:
// el cajero elige el precio (libre, ITBIS incluido) y los productos; el precio
// se reparte entre las líneas de los productos.
//   función apagada (la venta normal no cambia) · activar · combos sugeridos ·
//   habilitar productos · combo por debajo y por encima del valor normal ·
//   reparto manipulado · producto no habilitado · existencia insuficiente ·
//   reintento sin duplicar · cancelación · devolución de un producto del combo ·
//   pedido pendiente que se cobra · venta de contingencia sincronizada ·
//   reporte · auditoría · recibo · respaldo.
//
// Uso:
//   node scripts/combos-personalizados/probar-e2e.js            (MariaDB temporal)
//   node scripts/combos-personalizados/probar-e2e.js --sqlite   (SQLite, como un cliente monocaja)
// No toca datos reales: todo vive en una carpeta temporal.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SQLITE = process.argv.includes('--sqlite');
process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), SQLITE ? 'tecnocaja-combosp-sqlite' : 'tecnocaja-combosp-mariadb');
process.env.TC_E2E_DB_PORT = process.env.TC_E2E_DB_PORT || '3428';
const L = require('../e2e-lan/lib');
const motor = require('../../js/combos-personalizados-motor');

const PORT = SQLITE ? 3503 : 3502;
const DB_NAME = 'tc_combosp';
const USER_DATA = path.join(L.WORK, 'pc-data');
const HOME = path.join(L.WORK, 'home');
const ENV = SQLITE
  ? { DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME }
  : { DB_CLIENT: 'mysql', DB_HOST: '127.0.0.1', DB_PORT: String(L.DB_PORT), DB_USER: 'root', DB_PASSWORD: '', DB_NAME, USERPROFILE: HOME, HOME };
const ctx = { token: '', branchId: null, cashRegisterId: null, combos: {}, productos: {} };

const api = (method, url, body) => L.request(PORT, method, url, body, ctx.token);
const key = () => `cmp${Date.now().toString(16)}${crypto.randomBytes(3).toString('hex')}`;
const db = (sql) => L.mysqlRoot(sql.replace(/\{db\}/g, DB_NAME));
const TASA = 18;
const centavos = (v) => Math.round(Number(v || 0) * 100);

// Línea suelta como la arma la pantalla (precio de catálogo, ITBIS del producto).
function suelto(nombre, qty) {
  const p = ctx.productos[nombre];
  const calc = motor.lineaCentavos(p, qty, { tasa: TASA });
  return {
    id: p.id, codigo: p.codigo, nombre: p.nombre, qty, precio: p.precio, descuento: 0,
    itbis: p.aplicaItbis && p.itbisModo !== 'monto' ? TASA : 0,
    itbisModo: p.aplicaItbis && p.itbisModo === 'monto' ? 'monto' : 'porcentaje',
    itbisMontoUnit: p.aplicaItbis && p.itbisModo === 'monto' ? p.itbisMonto : 0,
    total: calc.total / 100, subtotal: calc.neto / 100, impuestoMonto: calc.itbis / 100, saleMode: 'unidad',
  };
}

// Las líneas de un combo como las arma la pantalla: el reparto del motor.
function combo(precio, elegidos, { clave = 'g1', sugerido = null } = {}) {
  const seleccion = elegidos.map(([nombre, qty]) => ({ ...ctx.productos[nombre], qty }));
  const reparto = motor.repartirCombo({ precio, seleccion, tasa: TASA });
  const datos = {
    clave,
    comboId: sugerido ? ctx.combos[sugerido].id : null,
    nombre: sugerido || 'Combo personalizado',
    precio,
  };
  return reparto.filas.map((f) => {
    const p = Object.values(ctx.productos).find((x) => x.id === f.id);
    return {
      id: f.id, codigo: p.codigo, nombre: p.nombre, qty: f.qty, precio: f.precio, descuento: 0,
      itbis: f.tasa, itbisModo: 'porcentaje', itbisMontoUnit: 0,
      total: f.total / 100, subtotal: f.neto / 100, impuestoMonto: f.itbis / 100, saleMode: 'unidad',
      comboPersonalizado: datos,
    };
  });
}

function venta(items, extra = {}) {
  const subtotal = items.reduce((a, it) => a + centavos(it.subtotal), 0);
  const itbis = items.reduce((a, it) => a + centavos(it.impuestoMonto), 0);
  const total = (subtotal + itbis) / 100;
  return {
    userId: 1, clientId: null, cliente: 'Consumidor Final', tipoComprobante: 'ticket', ncfType: null,
    metodo: 'efectivo', tipoPedido: 'mostrador', items, subtotal: subtotal / 100, descuento: 0, itbis: itbis / 100, total,
    recibido: total, cambio: 0, branchId: ctx.branchId, cashRegisterId: ctx.cashRegisterId, clientRequestId: key(), ...extra,
  };
}

const NOMBRES = ['hamburguesa', 'refresco', 'papas', 'cerveza', 'agua'];
async function existencias() {
  const boot = await api('GET', '/api/bootstrap');
  const byId = new Map((boot.body?.productos || []).map((p) => [Number(p.id), p]));
  return Object.fromEntries(NOMBRES.map((n) => [n, Number(byId.get(ctx.productos[n]?.id)?.stock ?? NaN)]));
}
const fmtStock = (s) => NOMBRES.map((n) => `${n} ${s[n]}`).join(' · ');
const iguales = (a, b) => Object.keys(b).every((k) => a[k] === b[k]);

async function producto(nombre, codigo, { precio, stock, aplicaItbis, itbisModo = 'porcentaje', itbisMonto = 0 }) {
  const visible = nombre[0].toUpperCase() + nombre.slice(1);
  const r = await api('POST', '/api/products', {
    codigo, barcode: codigo, nombre: visible, categoria: 'COMIDA', unidad: 'Unidad', marca: '',
    precioVenta: precio, precioCompra: 10, stock, stockMin: 0, aplicaItbis, itbisModo, itbisMonto, estado: 'Activo', branchId: ctx.branchId,
  });
  const id = Number(r.body?.id || r.body?.product?.id || 0);
  ctx.productos[nombre] = { id, codigo, nombre: visible, precio, aplicaItbis, itbisModo, itbisMonto };
  return id;
}

(async () => {
  let server = null;
  try {
    L.prepareSandbox();
    for (const dir of [USER_DATA, HOME]) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
    if (!SQLITE) {
      await L.startMariaDb({ fresh: true });
      await L.mysqlRoot(`DROP DATABASE IF EXISTS ${DB_NAME}; CREATE DATABASE ${DB_NAME} CHARACTER SET utf8mb4;`);
    }
    server = L.startServer(SQLITE ? 'combosp-sqlite' : 'combosp-mariadb', { port: PORT, userData: USER_DATA, env: ENV });
    await L.waitHttp(PORT);
    const setup = await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: SQLITE ? 'monocaja' : 'multicaja', networkKey: 'clave-red-combosp',
      businessName: 'Comida Combos', adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@combosp.test',
      adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });
    L.check(`Negocio configurado (${SQLITE ? 'SQLite' : 'MariaDB'})`, setup.status === 201, `HTTP ${setup.status} ${setup.body?.error || ''}`);
    const login = await L.request(PORT, 'POST', '/api/login', { usuario: 'admin', password: '1234' });
    ctx.token = login.body?.token || '';
    ctx.branchId = login.body?.data?.sucursales?.[0]?.id;
    ctx.cashRegisterId = login.body?.data?.cajasSucursal?.[0]?.id;
    L.check('Login y caja abierta', Boolean(ctx.token), `sucursal ${ctx.branchId} · caja ${ctx.cashRegisterId}`);

    await producto('hamburguesa', 'HAM', { precio: 84.75, stock: 10, aplicaItbis: true });                         // 100.00
    await producto('refresco', 'REF', { precio: 42.37, stock: 10, aplicaItbis: true });                             // 50.00
    await producto('papas', 'PAP', { precio: 50, stock: 3, aplicaItbis: false });                                    // exento
    await producto('cerveza', 'CER', { precio: 80, stock: 10, aplicaItbis: true, itbisModo: 'monto', itbisMonto: 20 }); // 100.00
    await producto('agua', 'AGU', { precio: 25, stock: 10, aplicaItbis: false });
    L.check('Productos creados', NOMBRES.every((n) => ctx.productos[n].id > 0));

    // ── Función apagada: la venta normal no cambia ─────────────────────
    const estado = await api('GET', '/api/combos-personalizados/estado');
    L.check('Arranca apagado y sin productos habilitados', estado.status === 200 && estado.body?.config?.activo === false && estado.body?.productoIds?.length === 0,
      `HTTP ${estado.status} ${JSON.stringify(estado.body?.config || estado.body?.error)}`);
    const normal = await api('POST', '/api/sales', venta([suelto('agua', 2), suelto('refresco', 1)]));
    let st = await existencias();
    L.check('Venta tradicional con la función apagada', normal.status === 201 && normal.body?.sale?.total === 100 && iguales(st, { agua: 8, refresco: 9 }),
      `HTTP ${normal.status} ${normal.body?.error || ''} · total ${normal.body?.sale?.total} · ${fmtStock(st)}`);

    // ── Activar, combos sugeridos y productos ───────────────────────────
    const on = await api('PUT', '/api/combos-personalizados/config', { activo: true });
    L.check('Se activa desde Apariencia', on.status === 200 && on.body?.config?.activo === true, `HTTP ${on.status} ${on.body?.error || ''}`);
    const apagadoAntes = await api('POST', '/api/sales', venta(combo(100, [['agua', 1]])));
    L.check('Producto no habilitado dentro de un combo: 409', apagadoAntes.status === 409 && /no está disponible para combos/.test(apagadoAntes.body?.error || ''),
      `HTTP ${apagadoAntes.status} ${apagadoAntes.body?.error || ''}`);
    const sug = await api('POST', '/api/combos-personalizados/combos', { nombre: 'Combo especial', precio: 500 });
    ctx.combos['Combo especial'] = sug.body?.combo || {};
    L.check('Combo sugerido creado (nombre + precio de partida)', sug.status === 201, `HTTP ${sug.status} ${sug.body?.error || ''}`);
    const hab = await api('PUT', '/api/combos-personalizados/productos', { ids: ['hamburguesa', 'refresco', 'papas', 'cerveza'].map((n) => ctx.productos[n].id), habilitado: true });
    L.check('Productos habilitados para combos (agua no)', hab.status === 200 && hab.body?.productoIds?.length === 4, `HTTP ${hab.status} ${hab.body?.error || ''}`);

    // ── Reiniciar el programa: la función sigue activa ──────────────────
    await new Promise((res) => setTimeout(res, 2500)); // SQLite (sql.js) guarda en segundo plano
    await L.stopServer(server);
    // La prueba no tiene Firebase: sin una licencia activada, al reiniciar la
    // prueba gratis se da por vencida (igual que en run-lan-e2e.js).
    const licencia = L.seedLicense({ port: PORT, userData: USER_DATA, env: ENV });
    L.check('Licencia activada para poder reiniciar', licencia.ok, licencia.detail);
    server = L.startServer(SQLITE ? 'combosp-sqlite-2' : 'combosp-mariadb-2', { port: PORT, userData: USER_DATA, env: ENV });
    await L.waitHttp(PORT);
    const relogin = await L.request(PORT, 'POST', '/api/login', { usuario: 'admin', password: '1234' });
    ctx.token = relogin.body?.token || '';
    if (!ctx.token) console.log('[relogin]', relogin.status, JSON.stringify(relogin.body).slice(0, 300));
    const trasReiniciar = await api('GET', '/api/combos-personalizados/estado');
    L.check('Tras reiniciar el programa: sigue activo, con sus productos y su combo sugerido',
      trasReiniciar.status === 200 && trasReiniciar.body?.config?.activo === true
        && trasReiniciar.body?.productoIds?.length === 4 && (trasReiniciar.body?.combos || []).length === 1,
      `HTTP ${trasReiniciar.status} · ${JSON.stringify(trasReiniciar.body?.config || trasReiniciar.body?.error)} · ${trasReiniciar.body?.productoIds?.length} productos`);

    // ── Combo a precio libre + producto suelto ──────────────────────────
    // "Combo especial" a RD$300 por 2 hamburguesas + 1 papa + 1 cerveza (valor normal RD$350.01).
    const lineasA = combo(300, [['hamburguesa', 2], ['papas', 1], ['cerveza', 1]], { clave: 'a', sugerido: 'Combo especial' });
    const ventaA = venta([...lineasA, suelto('refresco', 1)]);
    const a = await api('POST', '/api/sales', ventaA);
    const saleA = a.body?.sale || {};
    const marcadas = (saleA.items || []).filter((i) => i.comboPersonalizado);
    L.check('Combo de RD$300 (ITBIS incluido) + refresco suelto: total RD$350.00', a.status === 201 && saleA.total === 350 && marcadas.length === lineasA.length,
      `HTTP ${a.status} ${a.body?.error || ''} · total ${saleA.total} · ${marcadas.length} líneas de combo`);
    const itbisCombo = lineasA.reduce((acc, l) => acc + centavos(l.impuestoMonto), 0);
    L.check('El ITBIS va dentro del precio del combo (no se suma encima) y la venta lo trae desglosado',
      centavos(saleA.itbis) === itbisCombo + 763 && centavos(saleA.subtotal) + centavos(saleA.itbis) === 35000,
      `subtotal ${saleA.subtotal} · ITBIS ${saleA.itbis}`);
    st = await existencias();
    L.check('Inventario: sale cada producto con su cantidad real', iguales(st, { hamburguesa: 8, papas: 2, cerveza: 9, refresco: 8 }), fmtStock(st));

    const reintento = await api('POST', '/api/sales', ventaA);
    const st2 = await existencias();
    L.check('Reintento de la misma venta: no duplica venta ni descuento', reintento.status === 200 && reintento.body?.sale?.id === saleA.id && iguales(st2, st),
      `HTTP ${reintento.status} · ${fmtStock(st2)}`);

    // ── El servidor no confía en el reparto de la pantalla ──────────────
    const tramposo = combo(300, [['hamburguesa', 1], ['papas', 1]]);
    tramposo[0] = { ...tramposo[0], precio: 1, subtotal: 1 };
    const manipulado = await api('POST', '/api/sales', venta(tramposo));
    L.check('Reparto manipulado (precio de una línea cambiado): 409', manipulado.status === 409 && /no cuadra/.test(manipulado.body?.error || ''),
      `HTTP ${manipulado.status} ${manipulado.body?.error || ''}`);
    const sinStock = await api('POST', '/api/sales', venta(combo(200, [['hamburguesa', 1], ['papas', 3]])));
    const st3 = await existencias();
    L.check('Existencia insuficiente (quedan 2 papas, el combo pide 3): 409 sin descontar nada',
      sinStock.status === 409 && iguales(st3, st), `HTTP ${sinStock.status} ${sinStock.body?.error || ''} · ${fmtStock(st3)}`);

    // ── Recibo y auditoría ──────────────────────────────────────────────
    const recibo = await api('GET', `/api/sales/${encodeURIComponent(saleA.id)}/receipt`);
    const itemsRecibo = recibo.body?.sale?.items || recibo.body?.items || [];
    L.check('El recibo trae a qué combo pertenece cada línea (nombre y precio elegido)',
      itemsRecibo.filter((i) => i.comboPersonalizado?.nombre === 'Combo especial' && i.comboPersonalizado?.precio === 300).length === lineasA.length,
      `HTTP ${recibo.status} · ${itemsRecibo.map((i) => `${i.nombre} ${i.qty}×${i.precio}${i.comboPersonalizado ? '*' : ''}`).join(', ')}`);
    // La auditoría se escribe sin frenar la respuesta: se le da un momento.
    await new Promise((res) => setTimeout(res, 800));
    const movs = await api('GET', '/api/audit');
    const auditoria = (Array.isArray(movs.body) ? movs.body : []).find((row) => row.accion === 'Combo personalizado vendido');
    L.check('Auditoría: el combo vendido queda con el precio elegido y el valor normal',
      Boolean(auditoria) && /Combo especial · RD\$ 300\.00 \(valor normal RD\$ 350\.01\)/.test(auditoria.detalle || ''),
      `HTTP ${movs.status} · ${JSON.stringify(auditoria || {}).slice(0, 200)}`);

    // ── Cancelar la venta reintegra cada producto ───────────────────────
    const cancel = await api('PATCH', `/api/sales/${encodeURIComponent(saleA.id)}/cancel`, { reason: 'Prueba combos personalizados' });
    st = await existencias();
    L.check('Cancelar la venta reintegra cada producto del combo', cancel.status < 300 && iguales(st, { hamburguesa: 10, papas: 3, cerveza: 10, refresco: 9 }),
      `HTTP ${cancel.status} ${cancel.body?.error || ''} · ${fmtStock(st)}`);

    // ── Devolver un producto del combo ──────────────────────────────────
    const lineasB = combo(120, [['cerveza', 1], ['refresco', 1]], { clave: 'b' });
    const b = await api('POST', '/api/sales', venta(lineasB));
    const detalle = await api('GET', `/api/sales/${encodeURIComponent(b.body?.sale?.id)}/return-detail`);
    const itemRef = (detalle.body?.items || []).find((i) => Number(i.productId) === ctx.productos.refresco.id);
    const devol = await api('POST', '/api/sales/return', {
      invoiceNumber: b.body?.sale?.id, reason: 'Prueba combos personalizados', refundCash: true,
      items: [{ saleItemId: itemRef?.id, productId: ctx.productos.refresco.id, qty: 1 }],
      branchId: ctx.branchId, cashRegisterId: ctx.cashRegisterId,
    });
    st = await existencias();
    L.check('Devolver el refresco de un combo de RD$120: reintegra solo el refresco, a su parte del precio',
      b.status === 201 && b.body?.sale?.total === 120 && devol.status < 300 && iguales(st, { cerveza: 9, refresco: 9 }),
      `venta ${b.status} ${b.body?.error || ''} total ${b.body?.sale?.total} · devolución ${devol.status} ${devol.body?.error || ''} · ${fmtStock(st)}`);
    const refrescoB = lineasB.find((l) => l.id === ctx.productos.refresco.id);

    // ── Pedido pendiente (facturación separada) que luego se cobra ──────
    const lineasC = combo(150, [['hamburguesa', 1], ['papas', 2]], { clave: 'c' });
    const c = await api('POST', '/api/sales', venta(lineasC, { saleMode: 'separada', recibido: 0 }));
    const stC = await existencias();
    L.check('Pedido pendiente con combo: no descuenta hasta cobrarse', c.status === 201 && iguales(stC, st), `HTTP ${c.status} ${c.body?.error || ''} · ${fmtStock(stC)}`);
    const cobro = await api('PATCH', `/api/sales/${encodeURIComponent(c.body?.sale?.id)}/collect`, {
      metodo: 'efectivo', recibido: 150, branchId: ctx.branchId, cashRegisterId: ctx.cashRegisterId,
    });
    st = await existencias();
    L.check('Pedido pendiente cobrado: descuenta cada producto del combo', cobro.status < 300 && iguales(st, { hamburguesa: 9, papas: 1 }),
      `HTTP ${cobro.status} ${cobro.body?.error || ''} · ${fmtStock(st)}`);

    // ── Sin límites: por encima del valor normal ────────────────────────
    const lineasD = combo(260, [['cerveza', 2]], { clave: 'd' });
    const caro = await api('POST', '/api/sales', venta(lineasD));
    L.check('Sin límites: 2 cervezas (normal RD$200) en un combo de RD$260', caro.status === 201 && caro.body?.sale?.total === 260,
      `HTTP ${caro.status} ${caro.body?.error || ''} · total ${caro.body?.sale?.total}`);

    // ── Venta de contingencia (caja sin la base) sincronizada ───────────
    const lineasE = combo(99.99, [['cerveza', 1]], { clave: 'off1' });
    const cache = await api('POST', '/api/offline/init-cache', {});
    const offline = await api('POST', '/api/offline/save-sale', venta(lineasE));
    const sync = await api('POST', '/api/offline/sync-pending', {});
    const ventas = (await api('GET', '/api/bootstrap')).body?.ventas || [];
    const sincronizada = ventas.find((s) => (s.items || []).some((i) => i.comboPersonalizado?.clave === 'off1'));
    L.check('Venta offline con combo: al sincronizar conserva la marca del combo',
      cache.status === 200 && offline.status < 300 && Boolean(sincronizada),
      `cache ${cache.status} · guardar ${offline.status} ${offline.body?.error || ''} · sync ${JSON.stringify({ synced: sync.body?.synced, failed: sync.body?.failed, err: (sync.body?.errors || [])[0]?.error })}`);

    // ── Reporte ─────────────────────────────────────────────────────────
    const rep = await api('GET', '/api/combos-personalizados/reporte');
    const r = rep.body || {};
    // Vendidos (no cancelados): b (120, refresco devuelto), c (150), d (260) y la offline (99.99).
    const cobradoEsperado = (12000 - refrescoB.total * 100 + 15000 + 26000 + 9999) / 100;
    L.check('Reporte: 4 combos (cancelada fuera, devolución restada)',
      rep.status === 200 && r.combosVendidos === 4 && centavos(r.ingresos) === centavos(cobradoEsperado),
      `HTTP ${rep.status} · ${r.combosVendidos} combos · RD$${r.ingresos} (esperado ${cobradoEsperado}) · valor normal ${r.valorNormal}`);
    L.check('Reporte: valor normal de lo que llevaron y productos consumidos',
      r.valorNormal > 0 && (r.productos || []).some((p) => p.nombre === 'Cerveza' && p.cantidad === 4),
      `${(r.productos || []).map((p) => `${p.cantidad} ${p.nombre}`).join(', ')}`);

    // ── Un combo sugerido con ventas no se borra ────────────────────────
    const borrar = await api('DELETE', `/api/combos-personalizados/combos/${ctx.combos['Combo especial'].id}`);
    L.check('Un combo sugerido con ventas no se borra (se desactiva)', borrar.status === 409, `HTTP ${borrar.status} ${borrar.body?.error || ''}`);

    // ── Base de datos (solo MariaDB): líneas, movimientos y respaldo ────
    if (!SQLITE) {
      const filas = await db(`SELECT si.price, si.original_price, si.tax_rate, si.tax_mode FROM {db}.sale_items si WHERE si.custom_combo_key = 'a' ORDER BY si.id`);
      L.check('Las líneas del combo guardan su parte del precio y el precio de catálogo (trazabilidad)',
        filas.length === lineasA.length && filas.some((f) => Number(f.original_price) === 84.75 && Number(f.price) < 84.75) && filas.every((f) => f.tax_mode === 'porcentaje'),
        JSON.stringify(filas));
      const notas = await db(`SELECT notes FROM {db}.inventory_movements WHERE notes LIKE '%combo %'`);
      L.check('Los movimientos de inventario dicen de qué combo salió cada producto', notas.length >= 5, `${notas.length} movimientos`);
      const { buildFullPayload } = require(path.join(L.APP, 'server', 'services', 'backup-core.js'));
      const mysql = require(path.join(L.PROJECT, 'node_modules', 'mysql2', 'promise'));
      const conn = await mysql.createConnection({ host: '127.0.0.1', port: L.DB_PORT, user: 'root', password: '', database: DB_NAME });
      const payload = await buildFullPayload(async (sql, params) => (await conn.query(sql, params))[0]);
      await conn.end();
      L.check('Respaldo .tcbak incluye los combos sugeridos y la marca de cada línea',
        (payload.data.customCombos || []).length === 1 && (payload.data.saleItems || []).some((i) => i.custom_combo_key),
        `${(payload.data.customCombos || []).length} combos`);
    }
  } catch (error) {
    L.check('Sin errores inesperados', false, error.stack || error.message);
  } finally {
    await L.stopServer(server);
    if (!SQLITE) await L.stopMariaDb().catch(() => {});
    const fallas = L.results.filter((r) => !r.ok);
    console.log(`\n${L.results.length - fallas.length}/${L.results.length} comprobaciones OK`);
    process.exit(fallas.length ? 1 : 0);
  }
})();
