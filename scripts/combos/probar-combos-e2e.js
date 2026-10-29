// Prueba de punta a punta de los combos promocionales con el servidor real:
// crear combo, verlo en el catálogo, venderlo, reintento sin duplicar, falta de
// existencia sumando todo el carrito, editar sin tocar ventas viejas, devolver,
// cancelar, pedido pendiente que se cobra, desactivar, no borrar componentes,
// reporte y respaldo.
//
// Uso:
//   node scripts/combos/probar-combos-e2e.js            (MariaDB temporal)
//   node scripts/combos/probar-combos-e2e.js --sqlite   (SQLite, como un cliente monocaja)
// No toca datos reales: todo vive en una carpeta temporal.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SQLITE = process.argv.includes('--sqlite');
process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), SQLITE ? 'tecnocaja-combos-sqlite' : 'tecnocaja-combos-mariadb');
process.env.TC_E2E_DB_PORT = process.env.TC_E2E_DB_PORT || '3427';
const L = require('../e2e-lan/lib');

const PORT = SQLITE ? 3497 : 3496;
const DB_NAME = 'tc_combos';
const USER_DATA = path.join(L.WORK, 'pc-data');
const HOME = path.join(L.WORK, 'home');
const ENV = SQLITE
  ? { DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME }
  : { DB_CLIENT: 'mysql', DB_HOST: '127.0.0.1', DB_PORT: String(L.DB_PORT), DB_USER: 'root', DB_PASSWORD: '', DB_NAME, USERPROFILE: HOME, HOME };
const ctx = { token: '', branchId: null, cashRegisterId: null, ids: {} };

const api = (method, url, body) => L.request(PORT, method, url, body, ctx.token);
const key = () => `cmb${Date.now().toString(16)}${crypto.randomBytes(3).toString('hex')}`;
const db = (sql) => L.mysqlRoot(sql.replace(/\{db\}/g, DB_NAME));

function venta(lineas, extra = {}) {
  let subtotal = 0;
  let itbis = 0;
  const items = lineas.map((l) => {
    const neto = l.precio * l.qty;
    const imp = +(neto * (l.itbis || 0) / 100).toFixed(2);
    subtotal += neto;
    itbis += imp;
    return {
      id: l.id, codigo: l.codigo, nombre: l.nombre, qty: l.qty, precio: l.precio, descuento: 0,
      itbis: l.itbis || 0, itbisModo: 'porcentaje', total: +(neto + imp).toFixed(2), subtotal: neto, impuestoMonto: imp, saleMode: 'unidad',
    };
  });
  const total = +(subtotal + itbis).toFixed(2);
  return {
    userId: 1, clientId: null, cliente: 'Consumidor Final', tipoComprobante: 'ticket', ncfType: null,
    metodo: 'efectivo', tipoPedido: 'mostrador', items, subtotal, descuento: 0, itbis: +itbis.toFixed(2), total,
    recibido: total, cambio: 0, branchId: ctx.branchId, cashRegisterId: ctx.cashRegisterId, clientRequestId: key(), ...extra,
  };
}

async function existencias() {
  const boot = await api('GET', '/api/bootstrap');
  const byId = new Map((boot.body?.productos || []).map((p) => [Number(p.id), p]));
  const s = (name) => Number(byId.get(ctx.ids[name])?.stock ?? NaN);
  return { pollo: s('pollo'), refresco: s('refresco'), papas: s('papas'), agua: s('agua'), byId };
}

// Solo las existencias (no el mapa byId, que es otro objeto en cada lectura).
const iguales = (a, b) => ['pollo', 'refresco', 'papas', 'agua'].filter((k) => k in b).every((k) => a[k] === b[k]);
const fmtStock = (s) => `pollo ${s.pollo} · refresco ${s.refresco} · papas ${s.papas} · agua ${s.agua}`;

async function producto(codigo, nombre, { precio, costo, stock, itbis }) {
  const r = await api('POST', '/api/products', {
    codigo, barcode: codigo, nombre, categoria: 'GENERAL', unidad: 'Unidad', marca: '', precioVenta: precio, precioCompra: costo,
    stock, stockMin: 0, aplicaItbis: itbis, estado: 'Activo', branchId: ctx.branchId,
  });
  return Number(r.body?.id || r.body?.product?.id || r.body?.producto?.id || 0);
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
    server = L.startServer(SQLITE ? 'combos-sqlite' : 'combos-mariadb', { port: PORT, userData: USER_DATA, env: ENV });
    await L.waitHttp(PORT);
    const setup = await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: SQLITE ? 'monocaja' : 'multicaja', networkKey: 'clave-red-combos',
      businessName: 'Colmado Combos', adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@combos.test',
      adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });
    L.check(`Negocio configurado (${SQLITE ? 'SQLite' : 'MariaDB'})`, setup.status === 201, `HTTP ${setup.status} ${setup.body?.error || ''}`);
    const login = await L.request(PORT, 'POST', '/api/login', { usuario: 'admin', password: '1234' });
    ctx.token = login.body?.token || '';
    ctx.branchId = login.body?.data?.sucursales?.[0]?.id;
    ctx.cashRegisterId = login.body?.data?.cajasSucursal?.[0]?.id;
    L.check('Login y caja abierta', Boolean(ctx.token), `sucursal ${ctx.branchId} · caja ${ctx.cashRegisterId}`);

    ctx.ids.pollo = await producto('POL', 'Pollo', { precio: 400, costo: 250, stock: 10, itbis: false });
    ctx.ids.refresco = await producto('REF', 'Refresco', { precio: 100, costo: 60, stock: 7, itbis: true });
    ctx.ids.papas = await producto('PAP', 'Papas', { precio: 150, costo: 80, stock: 50, itbis: true });
    ctx.ids.agua = await producto('AGU', 'Agua', { precio: 50, costo: 20, stock: 5, itbis: true });
    L.check('Productos de inventario creados', Object.values(ctx.ids).every((id) => id > 0), JSON.stringify(ctx.ids));

    // ── 1. Crear el combo ────────────────────────────────────────────────
    const crear = await api('POST', '/api/combos', {
      nombre: 'Combo Familiar', codigo: 'COMBO-FAM', precio: 600, aplicaItbis: false,
      componentes: [{ id: ctx.ids.pollo, cantidad: 1 }, { id: ctx.ids.refresco, cantidad: 2 }, { id: ctx.ids.papas, cantidad: 1 }],
    });
    const combo = crear.body?.combo || {};
    ctx.ids.combo = Number(combo.id || 0);
    L.check('1. Combo creado con 3 productos', crear.status === 201 && combo.componentes?.length === 3,
      `HTTP ${crear.status} ${crear.body?.error || ''}`);
    L.check('1. Precio normal 750, costo 450, ahorro 150, margen 25%',
      iguales(combo.totales || {}, { precioNormal: 750, costo: 450, ahorro: 150, margenPct: 25 }), JSON.stringify(combo.totales));

    // ── 2. Imagen ────────────────────────────────────────────────────────
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const img = await api('POST', `/api/combos/${ctx.ids.combo}/imagen`, { imageData: png });
    L.check('2. Imagen del combo guardada como archivo', img.status === 200 && /\.webp$/.test(img.body?.combo?.imagenLocal || ''),
      `HTTP ${img.status} ${img.body?.combo?.imagenLocal || img.body?.error || ''}`);

    // ── 3. Catálogo de Ventas ───────────────────────────────────────────
    let st = await existencias();
    const enCatalogo = st.byId.get(ctx.ids.combo);
    L.check('3. El combo aparece en el catálogo de Ventas con sus componentes',
      Boolean(enCatalogo) && enCatalogo.componentes?.length === 3 && enCatalogo.comboDisponible === 3 && enCatalogo.tracksStock === false && Boolean(enCatalogo.imagenLocal),
      `disponible ${enCatalogo?.comboDisponible} · componentes ${enCatalogo?.componentes?.length}`);
    const total0 = (await api('GET', '/api/products')).body?.products?.length;
    L.check('3. Los productos no se duplicaron (4 + 1 combo)', total0 === 5, `${total0} productos`);

    // ── 4 y 5. Vender 2 combos + 1 refresco suelto ──────────────────────
    const lineaCombo = (qty, precio = 600) => ({ id: ctx.ids.combo, codigo: 'COMBO-FAM', nombre: 'Combo Familiar', qty, precio, itbis: 0 });
    const ventaA = venta([lineaCombo(2), { id: ctx.ids.refresco, codigo: 'REF', nombre: 'Refresco', qty: 1, precio: 100, itbis: 18 }]);
    const a = await api('POST', '/api/sales', ventaA);
    const saleA = a.body?.sale || {};
    const lineaA = (saleA.items || []).find((i) => Number(i.id) === ctx.ids.combo);
    L.check('4. Venta con combo registrada al precio del combo', a.status === 201 && lineaA?.precio === 600 && lineaA?.total === 1200,
      `HTTP ${a.status} ${a.body?.error || ''} · línea ${JSON.stringify(lineaA && { qty: lineaA.qty, precio: lineaA.precio, total: lineaA.total })}`);
    L.check('4. La respuesta trae lo que llevaba el combo (para imprimir)', lineaA?.combo?.componentes?.length === 3, lineaA?.combo?.nombre || '');
    st = await existencias();
    L.check('5/6. Inventario: 2 combos = 2 pollos, 4 refrescos (+1 suelto), 2 papas', iguales(st, { pollo: 8, refresco: 2, papas: 48, agua: 5 }), fmtStock(st));

    const reintento = await api('POST', '/api/sales', ventaA);
    const st2 = await existencias();
    L.check('6. Reintento de la misma venta: no duplica venta ni descuento', reintento.status === 200 && reintento.body?.sale?.id === saleA.id && iguales(st2, st),
      `HTTP ${reintento.status} · ${fmtStock(st2)}`);

    // ── 7. Existencia insuficiente sumando combo + producto suelto ──────
    const sinStock = await api('POST', '/api/sales', venta([lineaCombo(1), { id: ctx.ids.refresco, codigo: 'REF', nombre: 'Refresco', qty: 1, precio: 100, itbis: 18 }]));
    const st3 = await existencias();
    L.check('7. Falta de existencia: se rechaza contando todo el carrito', sinStock.status === 409 && /Refresco/.test(sinStock.body?.error || '') && iguales(st3, st),
      `HTTP ${sinStock.status} ${sinStock.body?.error || ''}`);

    // ── 15. Productos normales siguen igual ─────────────────────────────
    const normal = await api('POST', '/api/sales', venta([{ id: ctx.ids.agua, codigo: 'AGU', nombre: 'Agua', qty: 1, precio: 50, itbis: 18 }]));
    st = await existencias();
    L.check('15. Venta de un producto normal sin cambios', normal.status === 201 && st.agua === 4, `HTTP ${normal.status} · agua ${st.agua}`);

    // ── 12. Editar el combo: la venta vieja no cambia ───────────────────
    const editar = await api('PUT', `/api/combos/${ctx.ids.combo}`, {
      nombre: 'Combo Familiar Plus', codigo: 'COMBO-FAM', precio: 650, aplicaItbis: false,
      componentes: [{ id: ctx.ids.pollo, cantidad: 1 }, { id: ctx.ids.agua, cantidad: 1 }, { id: ctx.ids.papas, cantidad: 1 }],
    });
    L.check('12. Combo editado (refresco → agua, precio 650)', editar.status === 200 && editar.body?.combo?.precio === 650, `HTTP ${editar.status} ${editar.body?.error || ''}`);
    const recibo = await api('GET', `/api/sales/${encodeURIComponent(saleA.id)}/receipt`);
    const lineaRecibo = (recibo.body?.sale?.items || recibo.body?.items || []).find((i) => Number(i.id) === ctx.ids.combo);
    L.check('12. El recibo de la venta vieja conserva nombre y composición originales',
      lineaRecibo?.nombre === 'Combo Familiar' && (lineaRecibo?.combo?.componentes || []).some((c) => c.nombre === 'Refresco'),
      `HTTP ${recibo.status} · ${lineaRecibo?.nombre} · ${(lineaRecibo?.combo?.componentes || []).map((c) => c.nombre).join(', ')}`);

    // ── Devolución de 1 combo de la venta vieja ─────────────────────────
    const detalle = await api('GET', `/api/sales/${encodeURIComponent(saleA.id)}/return-detail`);
    const itemCombo = (detalle.body?.items || []).find((i) => Number(i.productId) === ctx.ids.combo);
    const devol = await api('POST', '/api/sales/return', {
      invoiceNumber: saleA.id, reason: 'Prueba combos', refundCash: true,
      items: [{ saleItemId: itemCombo?.id, productId: ctx.ids.combo, qty: 1 }],
      branchId: ctx.branchId, cashRegisterId: ctx.cashRegisterId,
    });
    st = await existencias();
    L.check('13. Devolver 1 combo reintegra lo que llevaba ESE día (refresco, no agua)',
      devol.status < 300 && iguales(st, { pollo: 9, refresco: 4, papas: 49, agua: 4 }), `HTTP ${devol.status} ${devol.body?.error || ''} · ${fmtStock(st)}`);

    // ── 13. Cancelar una venta con el combo nuevo ───────────────────────
    const b = await api('POST', '/api/sales', venta([lineaCombo(1, 650)]));
    const stB = await existencias();
    L.check('5. Venta del combo editado descuenta pollo, agua y papas', b.status === 201 && iguales(stB, { pollo: 8, refresco: 4, papas: 48, agua: 3 }),
      `HTTP ${b.status} ${b.body?.error || ''} · ${fmtStock(stB)}`);
    const cancel = await api('PATCH', `/api/sales/${encodeURIComponent(b.body?.sale?.id)}/cancel`, { reason: 'Prueba combos' });
    st = await existencias();
    L.check('13. Cancelar la venta reintegra los componentes', cancel.status < 300 && iguales(st, { pollo: 9, refresco: 4, papas: 49, agua: 4 }),
      `HTTP ${cancel.status} ${cancel.body?.error || ''} · ${fmtStock(st)}`);

    // ── Pedido pendiente (facturación separada) que luego se cobra ──────
    const c = await api('POST', '/api/sales', venta([lineaCombo(1, 650)], { saleMode: 'separada', recibido: 0 }));
    const stC = await existencias();
    L.check('Pedido pendiente: no descuenta hasta cobrarse', c.status === 201 && iguales(stC, st), `HTTP ${c.status} ${c.body?.error || ''} · ${fmtStock(stC)}`);
    const cobro = await api('PATCH', `/api/sales/${encodeURIComponent(c.body?.sale?.id)}/collect`, {
      metodo: 'efectivo', recibido: 650, branchId: ctx.branchId, cashRegisterId: ctx.cashRegisterId,
    });
    st = await existencias();
    L.check('Pedido pendiente cobrado: descuenta los componentes del combo', cobro.status < 300 && iguales(st, { pollo: 8, refresco: 4, papas: 48, agua: 3 }),
      `HTTP ${cobro.status} ${cobro.body?.error || ''} · ${fmtStock(st)}`);

    // ── Desactivar y proteger componentes ───────────────────────────────
    await api('POST', `/api/combos/${ctx.ids.combo}/estado`, { activo: false });
    const inactivo = await api('POST', '/api/sales', venta([lineaCombo(1, 650)]));
    L.check('Combo desactivado: ya no se puede vender', inactivo.status === 409 && /desactivado/.test(inactivo.body?.error || ''), `HTTP ${inactivo.status} ${inactivo.body?.error || ''}`);
    const borrar = await api('DELETE', `/api/products/${ctx.ids.papas}`);
    L.check('No se puede borrar un producto que está en un combo', borrar.status === 409 && /combo/.test(borrar.body?.error || ''), `HTTP ${borrar.status} ${borrar.body?.error || ''}`);
    const editarProducto = await api('PUT', `/api/products/${ctx.ids.combo}`, {
      codigo: 'COMBO-FAM', barcode: 'COMBO-FAM', nombre: 'Combo Familiar Plus', categoria: 'Combos', unidad: 'Unidad', marca: '', precioVenta: 650, precioCompra: 0,
      stock: 99, stockMin: 0, estado: 'Inactivo', tipoProducto: 'general', tracksStock: true, aplicaItbis: false,
    });
    const filaCombo = (await existencias()).byId.get(ctx.ids.combo);
    L.check('Editarlo desde Productos no le quita lo de combo', editarProducto.status < 300 && filaCombo?.tipoProducto === 'combo' && filaCombo?.tracksStock === false,
      `HTTP ${editarProducto.status} ${editarProducto.body?.error || ''} · tipo ${filaCombo?.tipoProducto} · controla ${filaCombo?.tracksStock}`);

    // ── Reporte ─────────────────────────────────────────────────────────
    const rep = await api('GET', '/api/combos/reportes/resumen');
    const fila = (rep.body?.combos || [])[0] || {};
    // A: 2 combos - 1 devuelto = 1 (RD$600, costo 250+2×60+80 = 450) · B cancelada ·
    // C cobrada: 1 (RD$650, costo 250+20+80 = 350, la composición nueva).
    L.check('10. Reporte: 2 combos netos, RD$1,250, costo histórico y componentes',
      rep.status === 200 && fila.unidades === 2 && fila.ingresos === 1250 && fila.costo === 800,
      `${fila.unidades} u · RD$${fila.ingresos} · costo ${fila.costo} · ${(fila.componentes || []).map((x) => `${x.cantidad} ${x.nombre}`).join(', ')}`);

    // ── Base de datos (solo MariaDB): foto, movimientos, respaldo ───────
    if (!SQLITE) {
      const lineas = await db(`SELECT si.item_name, si.combo_snapshot FROM {db}.sale_items si WHERE si.product_id = ${ctx.ids.combo} ORDER BY si.id`);
      L.check('9. Cada línea de combo guarda su foto', lineas.length === 3 && lineas.every((l) => l.combo_snapshot && JSON.parse(l.combo_snapshot).componentes.length === 3),
        lineas.map((l) => l.item_name).join(' · '));
      const movs = await db(`SELECT movement_type AS tipo, COUNT(*) AS n FROM {db}.inventory_movements WHERE sale_id IS NOT NULL GROUP BY movement_type ORDER BY movement_type`);
      const porTipo = Object.fromEntries(movs.map((m) => [m.tipo, Number(m.n)]));
      // venta: A (3 comp. + 1 refresco suelto) + agua suelta + B (3) + C cobrada (3) = 11
      L.check('6. Movimientos de inventario sin duplicados', porTipo.venta === 11 && porTipo.devolucion === 3 && porTipo.cancelacion_venta === 3,
        JSON.stringify(porTipo));
      const { buildFullPayload } = require(path.join(L.APP, 'server', 'services', 'backup-core.js'));
      const mysql = require(path.join(L.PROJECT, 'node_modules', 'mysql2', 'promise'));
      const conn = await mysql.createConnection({ host: '127.0.0.1', port: L.DB_PORT, user: 'root', password: '', database: DB_NAME });
      const payload = await buildFullPayload(async (sql, params) => (await conn.query(sql, params))[0]);
      await conn.end();
      L.check('Respaldo .tcbak incluye la composición de los combos', (payload.data.productComboItems || []).length === 3,
        `${(payload.data.productComboItems || []).length} filas`);
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
