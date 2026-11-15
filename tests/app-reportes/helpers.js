'use strict';
// Ayudas para las pruebas de lo que manda la app de reportes: un Firestore en
// memoria (lo justo que usan las colas) y la ruta real de compras sobre SQLite.
const initSqlJs = require('sql.js');

function firestoreFalso(datos = {}) {
  const docs = new Map(Object.entries(datos));
  const valor = (x) => (x instanceof Date ? x.getTime() : (x && typeof x.toMillis === 'function' ? x.toMillis() : x));
  const compara = (a, op, b) => {
    if (op === 'in') return b.includes(a);
    const x = valor(a); const y = valor(b);
    if (op === '==') return x === y;
    if (op === '<') return x < y;
    if (op === '<=') return x <= y;
    if (op === '>') return x > y;
    return false;
  };
  const hijos = (ruta) => [...docs.keys()].filter((k) => k.startsWith(`${ruta}/`) && k.split('/').length === ruta.split('/').length + 1);
  // eslint-disable-next-line no-use-before-define
  const snap = (ruta) => ({ exists: docs.has(ruta), id: ruta.split('/').pop(), data: () => docs.get(ruta), ref: ref(ruta) });
  function ref(ruta) {
    return {
      _ruta: ruta,
      id: ruta.split('/').pop(),
      get: async () => snap(ruta),
      set: async (d) => { docs.set(ruta, { ...d }); },
      update: async (c) => {
        if (!docs.has(ruta)) throw new Error(`No existe ${ruta}`);
        docs.set(ruta, { ...docs.get(ruta), ...c });
      },
      delete: async () => { docs.delete(ruta); },
      // eslint-disable-next-line no-use-before-define
      collection: (n) => coleccion(`${ruta}/${n}`),
    };
  }
  function consulta(ruta, filtros = [], tope = Infinity) {
    return {
      where: (c, op, v) => consulta(ruta, [...filtros, [c, op, v]], tope),
      limit: (n) => consulta(ruta, filtros, n),
      get: async () => {
        const lista = hijos(ruta).filter((k) => filtros.every(([c, op, v]) => compara(docs.get(k)[c], op, v))).slice(0, tope).map(snap);
        return { empty: !lista.length, docs: lista, size: lista.length };
      },
      onSnapshot: () => () => {},
    };
  }
  function coleccion(ruta) {
    return { doc: (id) => ref(`${ruta}/${id}`), ...consulta(ruta) };
  }
  return {
    _docs: docs,
    collection: (n) => coleccion(n),
    runTransaction: async (fn) => fn({
      get: (r) => r.get(),
      update: (r, c) => { docs.set(r._ruta, { ...docs.get(r._ruta), ...c }); },
    }),
  };
}

async function sqlite() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const query = async (sql, params = []) => {
    const text = String(sql).trim();
    const stmt = db.prepare(text);
    stmt.bind(params.map((v) => (v === undefined ? null : v)));
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    if (/^(INSERT|UPDATE|DELETE)/i.test(text)) return { affectedRows: db.getRowsModified(), insertId: db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0] };
    return rows;
  };
  const withTransaction = async (work) => {
    db.run('BEGIN');
    try { const r = await work({ query }); db.run('COMMIT'); return r; } catch (e) { db.run('ROLLBACK'); throw e; }
  };
  return { db, query, withTransaction };
}

// Base de compras como la de tests/compras/cola-portal.test.js.
async function baseCompras() {
  const { db, query, withTransaction } = await sqlite();
  const { ensureSchema } = require('../../server/routes/compras.routes');
  const { crearServicioCompras } = require('../../server/services/compras/compras.service');
  db.run('CREATE TABLE config (id INTEGER PRIMARY KEY, tax_rate DECIMAL(5,2) DEFAULT 18)');
  db.run('INSERT INTO config (id) VALUES (1)');
  db.run('CREATE TABLE suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT, rnc TEXT, updated_at TEXT)');
  db.run('CREATE TABLE branches (id INTEGER PRIMARY KEY, nombre TEXT)');
  db.run("INSERT INTO branches VALUES (1, 'Principal'), (2, 'Yamasá')");
  db.run(`CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, barcode TEXT, nombre TEXT, unidad TEXT, estado TEXT DEFAULT 'Activo',
    precio_venta DECIMAL(12,2) DEFAULT 0, precio_compra DECIMAL(12,2) DEFAULT 0, aplica_itbis INT DEFAULT 1, itbis_modo TEXT DEFAULT 'porcentaje',
    tracks_stock INT DEFAULT 1, product_type TEXT DEFAULT 'general', branch_id INT, stock DECIMAL(12,3) DEFAULT 0)`);
  db.run(`CREATE TABLE supplier_invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INT, invoice_number TEXT, issued_at TEXT, due_at TEXT,
    total_amount DECIMAL(12,2), paid_amount DECIMAL(12,2), pending_amount DECIMAL(12,2), status TEXT, notes TEXT, ncf TEXT, tipo_ncf TEXT, itbis_amount DECIMAL(12,2))`);
  db.run(`CREATE TABLE supplier_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INT, invoice_id INT, monto DECIMAL(12,2), metodo_pago TEXT,
    fecha_pago TEXT, notas TEXT, created_by TEXT)`);
  await ensureSchema(query, { withTransaction });
  const servicio = crearServicioCompras({
    query, withTransaction, getDbClient: () => 'sqlite',
    changeBranchInventoryStock: async (conn, { productId, quantityDelta }) => {
      const [p] = await conn.query('SELECT stock FROM products WHERE id = ?', [productId]);
      await conn.query('UPDATE products SET stock = ? WHERE id = ?', [Number(p.stock || 0) + Number(quantityDelta), productId]);
      return { previousStock: Number(p.stock || 0), nextStock: Number(p.stock || 0) + Number(quantityDelta) };
    },
    registerInventoryMovement: async () => {},
    createProductInTransaction: async (conn, { data }) => {
      const ins = await conn.query(`INSERT INTO products (codigo, barcode, nombre, unidad, estado, precio_venta, precio_compra, aplica_itbis, tracks_stock, branch_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`, [data.codigo, data.barcode, data.nombre, data.unidad, data.estado, data.precioVenta, data.precioCompra,
        data.aplicaItbis ? 1 : 0, data.tracksStock === false ? 0 : 1]);
      return { row: (await conn.query('SELECT * FROM products WHERE id = ?', [ins.insertId]))[0] };
    },
    insertSupplierRow: async (conn, data) => (await conn.query('INSERT INTO suppliers (nombre, rnc) VALUES (?, ?)', [data.nombre, data.rnc])).insertId,
    resolveSupplierInvoiceStatus: ({ pending_amount }) => (Number(pending_amount) > 0 ? 'Pendiente' : 'Pagada'),
    getConfig: async () => ({ itbis: 18, rnc: '131000001' }),
  });
  await query("INSERT INTO products (codigo, barcode, nombre, precio_venta, precio_compra, tracks_stock, stock) VALUES ('ARZ', '7501234567893', 'Arroz Selecto 5 lb', 300, 240, 1, 5)");
  return { db, query, servicio };
}

// Usuarios del POS (lo que devuelve getUserWithRoleContextById) y su resolución.
function usuariosPos(lista) {
  const { createUsuarioApp } = require('../../server/services/app-reportes/usuario-app');
  const porId = new Map(lista.map((u) => [Number(u.id), u]));
  return createUsuarioApp({
    getUserWithRoleContextById: async (id) => porId.get(Number(id)) || null,
    isGlobalAdministratorUser: (u) => u?.role_code === 'administrador_general',
    userRoleHasPermission: (u, ...p) => p.some((x) => (u?.role_permissions || []).includes(x)),
    getUserScopeBranchId: (u) => (u?.role_code === 'administrador_sucursal' ? Number(u.branch_id || 0) || null : null),
  });
}

module.exports = { firestoreFalso, sqlite, baseCompras, usuariosPos };
