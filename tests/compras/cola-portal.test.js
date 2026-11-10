'use strict';
// Compras que el contador registra desde su portal (server/services/compras/cola-portal.js):
// la cola de Firestore (en memoria) y la ruta real de compras sobre SQLite en memoria.
const initSqlJs = require('sql.js');

jest.mock('../../db', () => ({ getDbClient: () => 'sqlite' }));
const { ensureSchema } = require('../../server/routes/compras.routes');
const { crearServicioCompras } = require('../../server/services/compras/compras.service');
const { createColaComprasPortal } = require('../../server/services/compras/cola-portal');

const LIC = 'pos_negocio1';

async function base() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE config (id INTEGER PRIMARY KEY, tax_rate DECIMAL(5,2) DEFAULT 18)');
  db.run('INSERT INTO config (id) VALUES (1)');
  db.run('CREATE TABLE suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT, rnc TEXT, updated_at TEXT)');
  db.run('CREATE TABLE branches (id INTEGER PRIMARY KEY, nombre TEXT)');
  db.run("INSERT INTO branches VALUES (1, 'Principal')");
  db.run(`CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, barcode TEXT, nombre TEXT, unidad TEXT, estado TEXT DEFAULT 'Activo',
    precio_venta DECIMAL(12,2) DEFAULT 0, precio_compra DECIMAL(12,2) DEFAULT 0, aplica_itbis INT DEFAULT 1, itbis_modo TEXT DEFAULT 'porcentaje',
    tracks_stock INT DEFAULT 1, product_type TEXT DEFAULT 'general', branch_id INT, stock DECIMAL(12,3) DEFAULT 0)`);
  db.run(`CREATE TABLE supplier_invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INT, invoice_number TEXT, issued_at TEXT, due_at TEXT,
    total_amount DECIMAL(12,2), paid_amount DECIMAL(12,2), pending_amount DECIMAL(12,2), status TEXT, notes TEXT, ncf TEXT, tipo_ncf TEXT, itbis_amount DECIMAL(12,2))`);
  db.run(`CREATE TABLE supplier_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INT, invoice_id INT, monto DECIMAL(12,2), metodo_pago TEXT,
    fecha_pago TEXT, notas TEXT, created_by TEXT)`);
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
  const withTransaction = async (work) => { db.run('BEGIN'); try { const r = await work({ query }); db.run('COMMIT'); return r; } catch (e) { db.run('ROLLBACK'); throw e; } };
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
  return { query, servicio };
}

// Firestore en memoria: lo justo que usa la cola.
function firestoreFalso(datos) {
  const docs = new Map(Object.entries(datos));
  const ref = (ruta) => ({
    _ruta: ruta,
    get: async () => ({ exists: docs.has(ruta), id: ruta.split('/').pop(), data: () => docs.get(ruta), ref: ref(ruta) }),
    update: async (c) => { docs.set(ruta, { ...docs.get(ruta), ...c }); },
    collection: (n) => coleccion(`${ruta}/${n}`),
  });
  const coleccion = (ruta) => ({
    doc: (id) => ref(`${ruta}/${id}`),
    where: (campo, op, valor) => ({
      limit: () => ({
        get: async () => {
          const lista = [...docs.keys()].filter((k) => k.startsWith(`${ruta}/`) && k.split('/').length === ruta.split('/').length + 1)
            .filter((k) => (op === 'in' ? valor.includes(docs.get(k)[campo]) : docs.get(k)[campo] === valor))
            .map((k) => ({ id: k.split('/').pop(), data: () => docs.get(k), ref: ref(k) }));
          return { empty: !lista.length, docs: lista };
        },
      }),
    }),
  });
  return {
    _docs: docs,
    collection: (n) => coleccion(n),
    runTransaction: async (fn) => fn({ get: (r) => r.get(), update: (r, c) => { docs.set(r._ruta, { ...docs.get(r._ruta), ...c }); } }),
  };
}

const compra = (extra = {}) => ({
  status: 'pendiente', contadorId: 'firma-1', contadorNombre: 'Firma Contable', createdAt: '2026-11-10T10:00:00Z',
  encabezado: { proveedor: { nombre: 'Distribuidora Uno', rnc: '101000002' }, ncf: 'B0100000077', fechaComprobante: '2026-11-09', condicionPago: 'contado' },
  lineas: [
    { productoId: 1, accion: 'existente', decision: 'usuario', descripcion: 'Arroz Selecto 5 lb', cantidad: 10, costoUnitario: 250, itbisPct: 18 },
    { accion: 'nuevo', decision: 'usuario', descripcion: 'Habichuelas Rojas 1 lb', cantidad: 6, costoUnitario: 60, itbisPct: 18, precio: { modo: 'incluido', valor: 90 } },
  ],
  ...extra,
});

async function montar(colaDocs, { licencia = { contadorId: 'firma-1' } } = {}) {
  const { query, servicio } = await base();
  const db = firestoreFalso({ [`licencias/${LIC}`]: licencia, ...Object.fromEntries(Object.entries(colaDocs).map(([id, d]) => [`licencias/${LIC}/compras_pendientes/${id}`, d])) });
  const auditoria = [];
  const cola = createColaComprasPortal({
    servicio, query, getDb: () => db, getLicenseUid: () => LIC, getBranchId: async () => 1,
    writeAuditLog: async (a) => auditoria.push(a), logger: { warn: () => {} },
  });
  const estado = (id) => db._docs.get(`licencias/${LIC}/compras_pendientes/${id}`);
  return { query, servicio, db, cola, estado, auditoria };
}

describe('Compras del contador desde su portal', () => {
  test('la registra sola: inventario, producto nuevo con precio, cuenta pagada y auditoría', async () => {
    const { query, cola, estado, auditoria } = await montar({ 'a1b2c3d4-0001': compra() });
    const r = await cola.procesar();
    expect(r).toMatchObject({ registradas: 1 });
    const e = estado('a1b2c3d4-0001');
    expect(e).toMatchObject({ status: 'registrada', productosCreados: 1 });
    expect(e.totalRegistrado).toBeCloseTo(10 * 250 * 1.18 + 6 * 60 * 1.18, 2);
    const [arroz] = await query("SELECT stock, precio_compra, precio_venta FROM products WHERE codigo = 'ARZ'");
    expect(Number(arroz.stock)).toBe(15);
    expect(Number(arroz.precio_venta)).toBe(300); // el contador no cambia el precio de lo existente
    const [nuevo] = await query("SELECT stock, estado, precio_venta FROM products WHERE nombre = 'Habichuelas Rojas 1 lb'");
    expect(nuevo).toMatchObject({ estado: 'Activo' });
    expect(Number(nuevo.stock)).toBe(6);
    expect(Number(nuevo.precio_venta)).toBeCloseTo(76.27, 2); // 90 con ITBIS incluido
    const [p] = await query('SELECT uuid, notas FROM purchases');
    expect(p.uuid).toBe('a1b2c3d4-0001');
    expect(p.notas).toMatch(/contador Firma Contable/);
    expect(auditoria[0]).toMatchObject({ userRole: 'Contador', actionName: 'Compra registrada por el contador' });
  });

  test('reintentada (otra PC o un corte a medias) no se duplica', async () => {
    const { query, cola, db, estado } = await montar({ 'a1b2c3d4-0002': compra() });
    await cola.procesar();
    db._docs.set(`licencias/${LIC}/compras_pendientes/a1b2c3d4-0002`, { ...estado('a1b2c3d4-0002'), status: 'pendiente' });
    await cola.procesar();
    expect(estado('a1b2c3d4-0002')).toMatchObject({ status: 'registrada', repetida: true });
    expect((await query('SELECT COUNT(*) AS n FROM purchases'))[0].n).toBe(1);
    expect(Number((await query("SELECT stock FROM products WHERE codigo = 'ARZ'"))[0].stock)).toBe(15);
  });

  test('vuelve al contador para corregir: nombre parecido a uno existente o precio de un producto existente', async () => {
    const { cola, estado, query } = await montar({
      'a1b2c3d4-0003': compra({ lineas: [{ descripcion: 'Arroz 5 lb Selecto Premium', cantidad: 2, costoUnitario: 250, itbisPct: 18 }] }),
      'a1b2c3d4-0004': compra({ encabezado: { ...compra().encabezado, ncf: 'B0100000078' }, lineas: [{ productoId: 1, accion: 'existente', decision: 'usuario', descripcion: 'Arroz', cantidad: 1, costoUnitario: 250, itbisPct: 18, precio: { modo: 'incluido', valor: 400 } }] }),
    });
    const r = await cola.procesar();
    expect(r.correcciones).toBe(2);
    expect(estado('a1b2c3d4-0003').status).toBe('requiere_correccion');
    expect(estado('a1b2c3d4-0003').bloqueos.join(' ')).toMatch(/elige el producto/i);
    expect(estado('a1b2c3d4-0004').status).toBe('requiere_correccion');
    expect((await query('SELECT COUNT(*) AS n FROM purchases'))[0].n).toBe(0);
  });

  test('la misma factura del mismo proveedor no entra dos veces', async () => {
    const { cola, estado } = await montar({ 'a1b2c3d4-0005': compra(), 'a1b2c3d4-0006': compra() });
    await cola.procesar();
    expect([estado('a1b2c3d4-0005').status, estado('a1b2c3d4-0006').status].sort()).toEqual(['registrada', 'requiere_correccion']);
  });

  test('otro contador o el negocio con la opción apagada: rechazada sin tocar nada', async () => {
    const otro = await montar({ 'a1b2c3d4-0007': compra() }, { licencia: { contadorId: 'otra-firma' } });
    await otro.cola.procesar();
    expect(otro.estado('a1b2c3d4-0007')).toMatchObject({ status: 'rechazada' });
    expect((await otro.query('SELECT COUNT(*) AS n FROM purchases'))[0].n).toBe(0);

    const apagado = await montar({ 'a1b2c3d4-0008': compra() });
    await apagado.servicio.guardarConfig({ modoRecepcion: 'automatica', contadorRegistra: false });
    await apagado.cola.procesar();
    expect(apagado.estado('a1b2c3d4-0008').status).toBe('rechazada');
    expect(apagado.estado('a1b2c3d4-0008').mensaje).toMatch(/desactivó/);
  });

  test('una cancelada o ya registrada no se toca', async () => {
    const { cola, estado } = await montar({ 'a1b2c3d4-0009': compra({ status: 'cancelada' }) });
    await cola.procesar();
    expect(estado('a1b2c3d4-0009').status).toBe('cancelada');
  });
});
