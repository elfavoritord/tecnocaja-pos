'use strict';
// Registrar compras (server/services/compras/compras.service.js) sobre una base
// SQLite real en memoria: productos nuevos y conocidos, una sola entrada de
// inventario, sin facturas duplicadas, recepción con confirmación (parcial) y
// anulación que solo revierte lo recibido.
const initSqlJs = require('sql.js');

jest.mock('../../db', () => ({ getDbClient: () => 'sqlite' }));
const { ensureSchema } = require('../../server/routes/compras.routes');
const { crearServicioCompras } = require('../../server/services/compras/compras.service');

async function preparar({ modo = 'automatica', viejo = false } = {}) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE config (id INTEGER PRIMARY KEY, tax_rate DECIMAL(5,2) DEFAULT 18)`);
  db.run('INSERT INTO config (id) VALUES (1)');
  db.run(`CREATE TABLE suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT, rnc TEXT, updated_at TEXT)`);
  db.run(`CREATE TABLE branches (id INTEGER PRIMARY KEY, nombre TEXT)`);
  db.run("INSERT INTO branches VALUES (1, 'Principal')");
  db.run(`CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, barcode TEXT, nombre TEXT, unidad TEXT, estado TEXT DEFAULT 'Activo',
    precio_venta DECIMAL(12,2) DEFAULT 0, precio_compra DECIMAL(12,2) DEFAULT 0, aplica_itbis INT DEFAULT 1, itbis_modo TEXT DEFAULT 'porcentaje',
    tracks_stock INT DEFAULT 1, product_type TEXT DEFAULT 'general', branch_id INT, stock DECIMAL(12,3) DEFAULT 0)`);
  db.run(`CREATE TABLE supplier_invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INT, invoice_number TEXT, issued_at TEXT, due_at TEXT,
    total_amount DECIMAL(12,2), paid_amount DECIMAL(12,2), pending_amount DECIMAL(12,2), status TEXT, notes TEXT, ncf TEXT, tipo_ncf TEXT, itbis_amount DECIMAL(12,2))`);
  db.run(`CREATE TABLE supplier_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INT, invoice_id INT, monto DECIMAL(12,2), metodo_pago TEXT,
    fecha_pago TEXT, notas TEXT, created_by TEXT)`);
  db.run('CREATE TABLE movimientos (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INT, tipo TEXT, cantidad DECIMAL(12,3), referencia TEXT)');
  if (viejo) {
    // Instalación anterior: product_id obligatorio y una compra vieja ya guardada.
    db.run(`CREATE TABLE purchase_items (id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_id INT NOT NULL, product_id INT NOT NULL, codigo VARCHAR(60) NOT NULL,
      nombre VARCHAR(160) NOT NULL, cantidad DECIMAL(10,2) NOT NULL, costo_unitario DECIMAL(12,2) NOT NULL, itbis_pct DECIMAL(5,2) NOT NULL DEFAULT 0.00,
      subtotal DECIMAL(12,2) NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    db.run("INSERT INTO purchase_items (purchase_id, product_id, codigo, nombre, cantidad, costo_unitario, subtotal) VALUES (1, 1, 'A', 'Viejo', 2, 10, 20)");
  }

  const query = async (sql, params = []) => {
    const text = String(sql).trim();
    const stmt = db.prepare(text);
    stmt.bind(params.map((v) => (v === undefined ? null : v)));
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    if (/^(INSERT|UPDATE|DELETE)/i.test(text)) {
      const insertId = db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
      return { affectedRows: db.getRowsModified(), insertId };
    }
    return rows;
  };
  const withTransaction = async (work) => {
    db.run('BEGIN');
    try { const r = await work({ query }); db.run('COMMIT'); return r; } catch (e) { db.run('ROLLBACK'); throw e; }
  };
  await ensureSchema(query, { withTransaction });
  await query('UPDATE config SET compras_modo_recepcion = ? WHERE id = 1', [modo]);

  const stock = async (id) => Number((await query('SELECT stock FROM products WHERE id = ?', [id]))[0]?.stock || 0);
  const servicio = crearServicioCompras({
    query, withTransaction, getDbClient: () => 'sqlite',
    changeBranchInventoryStock: async (conn, { productId, quantityDelta }) => {
      const [p] = await conn.query('SELECT stock FROM products WHERE id = ?', [productId]);
      const previousStock = Number(p.stock || 0);
      await conn.query('UPDATE products SET stock = ? WHERE id = ?', [previousStock + Number(quantityDelta), productId]);
      return { previousStock, nextStock: previousStock + Number(quantityDelta) };
    },
    registerInventoryMovement: (conn, m) => conn.query('INSERT INTO movimientos (product_id, tipo, cantidad, referencia) VALUES (?, ?, ?, ?)',
      [m.productId, m.tipo, m.cantidad, m.referenciaId]),
    createProductInTransaction: async (conn, { data }) => {
      const ins = await conn.query(`INSERT INTO products (codigo, barcode, nombre, unidad, estado, precio_venta, precio_compra, aplica_itbis, tracks_stock, branch_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`, [data.codigo, data.barcode, data.nombre, data.unidad, data.estado, data.precioVenta, data.precioCompra,
        data.aplicaItbis ? 1 : 0, data.tracksStock === false ? 0 : 1]);
      return { row: (await conn.query('SELECT * FROM products WHERE id = ?', [ins.insertId]))[0] };
    },
    insertSupplierRow: async (conn, data) => (await conn.query('INSERT INTO suppliers (nombre, rnc) VALUES (?, ?)', [data.nombre, data.rnc])).insertId,
    resolveSupplierInvoiceStatus: ({ pending_amount }) => (Number(pending_amount) > 0 ? 'Pendiente' : 'Pagada'),
    getConfig: async () => ({ itbis: 18, rnc: '131000001' }),
    getNextNcf: async (conn, tipo) => {
      const [c] = await conn.query('SELECT COUNT(*) AS n FROM purchases WHERE tipo_ncf = ?', [tipo]);
      return { ncf: `${tipo}${String(Number(c.n) + 1).padStart(8, '0')}` };
    },
  });
  await query("INSERT INTO suppliers (nombre, rnc) VALUES ('Distribuidora Ejemplo', '101-00000-2')");
  await query("INSERT INTO products (codigo, barcode, nombre, precio_venta, precio_compra, tracks_stock, stock) VALUES ('ARZ', '7501234567893', 'Arroz Selecto 5 lb', 300, 240, 1, 5)");
  await query("INSERT INTO products (codigo, barcode, nombre, precio_venta, precio_compra, tracks_stock, stock) VALUES ('BOL', 'BOL', 'Fundas plásticas', 0, 1, 0, 0)");
  const actor = { id: 1, nombre: 'Admin', role_code: 'administrador_general' };
  const ctx = (extra = {}) => ({ actor, branchId: 1, puedeCrearProductos: true, puedeCambiarProductos: true, ...extra });
  return { db, query, servicio, stock, ctx };
}

const encabezado = (extra = {}) => ({ proveedor: { rnc: '101000002' }, ncf: 'B0100000050', numeroDocumento: 'FAC-50', fechaComprobante: '2026-11-09', condicionPago: 'contado', ...extra });

describe('registrar una compra', () => {
  test('conocidos + 10 nuevos: reutiliza los conocidos, crea los 10 y entra una sola vez al inventario', async () => {
    const { query, servicio, stock, ctx } = await preparar();
    const nuevos = Array.from({ length: 10 }, (_, i) => ({ descripcion: `Producto nuevo ${i + 1} 500 g`, cantidad: 2, costoUnitario: 50 + i, itbisPct: 18, precio: { modo: 'incluido', valor: 118 } }));
    const payload = { uuid: 'compra-prueba-0001', encabezado: encabezado(), lineas: [
      { codigoBarras: '7501234567893', descripcion: 'ARROZ SELECTO 5LB', cantidad: 10, costoUnitario: 250, itbisPct: 18 },
      { descripcion: 'Fundas plásticas', cantidad: 100, costoUnitario: 1.5, itbisPct: 18 },
      ...nuevos,
    ] };
    const r = await servicio.registrar(payload, ctx());
    expect(r.repetida).toBe(false);
    expect(r.productosCreados).toHaveLength(10);
    expect(await stock(1)).toBe(15); // 5 + 10
    expect(await stock(2)).toBe(0); // no controla inventario
    const creados = await query('SELECT * FROM products WHERE id > 2 ORDER BY id');
    expect(creados).toHaveLength(10);
    expect(creados[0]).toMatchObject({ codigo: 'P000003', precio_venta: 100, estado: 'Activo', aplica_itbis: 1 });
    expect(await stock(creados[0].id)).toBe(2);
    const [arroz] = await query('SELECT precio_compra FROM products WHERE id = 1');
    expect(arroz.precio_compra).toBe(250);
    expect((await query('SELECT * FROM product_cost_history WHERE product_id = 1'))[0]).toMatchObject({ costo_anterior: 240, costo_nuevo: 250 });
    const [inv] = await query('SELECT * FROM supplier_invoices');
    expect(inv).toMatchObject({ pending_amount: 0, ncf: 'B0100000050' });

    // Reintento con el mismo uuid (respuesta perdida): misma compra, sin duplicar inventario ni productos.
    const otra = await servicio.registrar(payload, ctx());
    expect(otra).toMatchObject({ purchaseId: r.purchaseId, repetida: true });
    expect(await stock(1)).toBe(15);
    expect((await query('SELECT COUNT(*) AS n FROM purchases'))[0].n).toBe(1);
    expect((await query('SELECT COUNT(*) AS n FROM products'))[0].n).toBe(12);
  });

  test('la misma factura con otro intento se rechaza (proveedor + NCF)', async () => {
    const { servicio, ctx } = await preparar();
    await servicio.registrar({ uuid: 'compra-a-000001', encabezado: encabezado(), lineas: [{ productoId: 1, cantidad: 1, costoUnitario: 250, itbisPct: 18 }] }, ctx());
    await expect(servicio.registrar({ uuid: 'compra-b-000002', encabezado: encabezado(), lineas: [{ productoId: 1, cantidad: 1, costoUnitario: 250, itbisPct: 18 }] }, ctx()))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/ya está registrada en la compra/) });
  });

  test('cambiar precio o control de inventario de un producto existente exige permiso de Productos', async () => {
    const { query, servicio, ctx } = await preparar();
    const payload = (uuid) => ({ uuid, encabezado: encabezado({ ncf: '' , numeroDocumento: uuid }), lineas: [{ productoId: 1, cantidad: 1, costoUnitario: 250, itbisPct: 18, precio: { modo: 'base', valor: 320 } }] });
    await expect(servicio.registrar(payload('sin-permiso-01'), ctx({ puedeCambiarProductos: false }))).rejects.toMatchObject({ statusCode: 403 });
    await servicio.registrar(payload('con-permiso-01'), ctx());
    expect((await query('SELECT precio_venta FROM products WHERE id = 1'))[0].precio_venta).toBe(320);
  });

  test('sin precio de venta el producto nuevo queda inactivo; exento exige confirmación', async () => {
    const { query, servicio, ctx } = await preparar();
    await servicio.registrar({ uuid: 'sin-precio-0001', encabezado: encabezado(), lineas: [{ descripcion: 'Escoba plástica', cantidad: 3, costoUnitario: 80, itbisPct: 18 }] }, ctx());
    expect((await query("SELECT estado, precio_venta FROM products WHERE nombre = 'Escoba plástica'"))[0]).toEqual({ estado: 'Inactivo', precio_venta: 0 });
    const exento = (confirmado) => ({ uuid: `exento-${confirmado}-01`, encabezado: encabezado({ ncf: `B010000009${confirmado ? 1 : 0}` }),
      lineas: [{ descripcion: 'Libro escolar', cantidad: 1, costoUnitario: 100, itbisPct: 0, precio: { modo: 'exento', valor: 150, exentoConfirmado: confirmado } }] });
    await expect(servicio.registrar(exento(false), ctx())).rejects.toMatchObject({ message: expect.stringMatching(/exento de ITBIS por ley/) });
    await servicio.registrar(exento(true), ctx());
    expect((await query("SELECT aplica_itbis, precio_venta FROM products WHERE nombre = 'Libro escolar'"))[0]).toEqual({ aplica_itbis: 0, precio_venta: 150 });
  });

  test('una línea de servicio no crea producto ni mueve inventario', async () => {
    const { query, servicio, ctx } = await preparar();
    const r = await servicio.registrar({ uuid: 'servicio-00001', encabezado: encabezado(), lineas: [
      { productoId: 1, cantidad: 2, costoUnitario: 250, itbisPct: 18 },
      { tipoLinea: 'servicio_gasto', descripcion: 'Flete', cantidad: 1, costoUnitario: 500, itbisPct: 18 },
    ] }, ctx());
    const items = await query('SELECT product_id, tipo_linea, cantidad_recibida FROM purchase_items WHERE purchase_id = ? ORDER BY id', [r.purchaseId]);
    expect(items).toEqual([{ product_id: 1, tipo_linea: 'inventario', cantidad_recibida: 2 }, { product_id: null, tipo_linea: 'servicio_gasto', cantidad_recibida: null }]);
    expect((await query('SELECT COUNT(*) AS n FROM products'))[0].n).toBe(2);
  });

  test('totales contra la factura: más de RD$ 1 bloquea; centavos de redondeo usan el total de la factura', async () => {
    const { query, servicio, ctx } = await preparar();
    const lineas = [{ productoId: 1, cantidad: 3, costoUnitario: 33.33, itbisPct: 18 }]; // 99.99 + 18.00 = 117.99
    await expect(servicio.registrar({ uuid: 'totales-mal-01', encabezado: encabezado({ totalesDocumento: { itbis: 18, total: 125 } }), lineas }, ctx()))
      .rejects.toMatchObject({ message: expect.stringMatching(/no cuadran/) });
    const r = await servicio.registrar({ uuid: 'totales-ok-001', encabezado: encabezado({ totalesDocumento: { itbis: 18, total: 118 } }), lineas }, ctx());
    expect((await query('SELECT total, ajuste_redondeo FROM purchases WHERE id = ?', [r.purchaseId]))[0]).toEqual({ total: 118, ajuste_redondeo: 0.01 });
  });

  test('proveedor nuevo por RNC se crea una vez; la siguiente factura lo reconoce', async () => {
    const { query, servicio, ctx } = await preparar();
    const lineas = [{ productoId: 1, cantidad: 1, costoUnitario: 10, itbisPct: 0 }];
    await servicio.registrar({ uuid: 'prov-nuevo-001', encabezado: encabezado({ proveedor: { nombre: 'Agro Nuevo', rnc: '131555555' }, ncf: 'B0100000001' }), lineas }, ctx());
    await servicio.registrar({ uuid: 'prov-nuevo-002', encabezado: encabezado({ proveedor: { rnc: '131-55555-5' }, ncf: 'B0100000002' }), lineas }, ctx());
    expect((await query("SELECT COUNT(*) AS n FROM suppliers WHERE rnc = '131555555'"))[0].n).toBe(1);
  });
});

describe('comprobante de la compra', () => {
  const linea = [{ productoId: 1, cantidad: 1, costoUnitario: 100, itbisPct: 18 }];
  test('el tipo sale del NCF del proveedor; un formato inválido o un tipo que no es de compra bloquea', async () => {
    const { query, servicio, ctx } = await preparar();
    const r = await servicio.registrar({ uuid: 'ncf-e31-00001', encabezado: encabezado({ ncf: 'e31-0000000045', tipoComprobante: 'B01' }), lineas: linea }, ctx());
    expect((await query('SELECT ncf, tipo_ncf FROM purchases WHERE id = ?', [r.purchaseId]))[0]).toEqual({ ncf: 'E310000000045', tipo_ncf: 'E31' });
    await expect(servicio.registrar({ uuid: 'ncf-malo-0001', encabezado: encabezado({ ncf: 'FAC123' }), lineas: linea }, ctx()))
      .rejects.toMatchObject({ message: expect.stringMatching(/formato de la DGII/) });
    await expect(servicio.registrar({ uuid: 'ncf-b11-prov-1', encabezado: encabezado({ ncf: 'B1100000009' }), lineas: linea }, ctx()))
      .rejects.toMatchObject({ message: expect.stringMatching(/B11 no es un comprobante que un proveedor/) });
  });
  test('el proveedor no da comprobante: el negocio emite B11 con su secuencia (exige RNC o cédula)', async () => {
    const { query, servicio, ctx } = await preparar();
    const sinCedula = { uuid: 'b11-sin-ced-01', encabezado: encabezado({ ncf: '', numeroDocumento: '', proveedor: { nombre: 'Juan Vendedor' }, comprobanteNegocio: 'B11' }), lineas: linea };
    await expect(servicio.registrar(sinCedula, ctx())).rejects.toMatchObject({ message: expect.stringMatching(/B11 el proveedor debe tener RNC o cédula/) });
    const r = await servicio.registrar({ ...sinCedula, uuid: 'b11-con-ced-01', encabezado: { ...sinCedula.encabezado, proveedor: { nombre: 'Juan Vendedor', rnc: '402-1193260-9' } } }, ctx());
    expect(r).toMatchObject({ ncf: 'B1100000001', tipoNcf: 'B11' });
    expect((await query('SELECT ncf, tipo_ncf, numero_documento FROM purchases WHERE id = ?', [r.purchaseId]))[0])
      .toEqual({ ncf: 'B1100000001', tipo_ncf: 'B11', numero_documento: 'B1100000001' });
    expect((await query('SELECT ncf FROM supplier_invoices ORDER BY id DESC LIMIT 1'))[0].ncf).toBe('B1100000001');
  });
  test('nunca los dos: con NCF del proveedor no se emite comprobante de compra', async () => {
    const { servicio, ctx } = await preparar();
    await expect(servicio.registrar({ uuid: 'ambos-000001', encabezado: encabezado({ comprobanteNegocio: 'E41' }), lineas: linea }, ctx()))
      .rejects.toMatchObject({ message: expect.stringMatching(/ya te dio comprobante/) });
    await expect(servicio.registrar({ uuid: 'otro-tipo-0001', encabezado: encabezado({ ncf: '', comprobanteNegocio: 'E31' }), lineas: linea }, ctx()))
      .rejects.toMatchObject({ message: expect.stringMatching(/no es un comprobante de compra que emita el negocio/) });
  });
});

describe('recepción con confirmación de mercancía', () => {
  test('la compra queda registrada; el inventario sube al recibir (parcial y luego el resto), una sola vez', async () => {
    const { query, servicio, stock, ctx } = await preparar({ modo: 'confirmacion' });
    const r = await servicio.registrar({ uuid: 'recepcion-0001', encabezado: encabezado({ condicionPago: 'credito', fechaVencimiento: '2026-12-09' }),
      lineas: [{ productoId: 1, cantidad: 10, costoUnitario: 250, itbisPct: 18 }] }, ctx());
    expect(await stock(1)).toBe(5);
    expect((await query('SELECT estado_inventario FROM purchases WHERE id = ?', [r.purchaseId]))[0].estado_inventario).toBe('pendiente_recepcion');
    expect((await query('SELECT pending_amount FROM supplier_invoices'))[0].pending_amount).toBe(2950);
    const [item] = await query('SELECT id FROM purchase_items WHERE purchase_id = ?', [r.purchaseId]);
    const actor = { id: 1, nombre: 'Encargado' };
    await servicio.confirmarRecepcion(r.purchaseId, { uuid: 'recibo-0000001', lineas: [{ itemId: item.id, cantidad: 6 }] }, { actor });
    expect(await stock(1)).toBe(11);
    expect((await query('SELECT estado_inventario FROM purchases WHERE id = ?', [r.purchaseId]))[0].estado_inventario).toBe('recibido_parcial');
    // El mismo recibo otra vez (doble clic / reintento) no suma de nuevo.
    expect(await servicio.confirmarRecepcion(r.purchaseId, { uuid: 'recibo-0000001', lineas: [{ itemId: item.id, cantidad: 6 }] }, { actor })).toEqual({ repetida: true });
    expect(await stock(1)).toBe(11);
    await expect(servicio.confirmarRecepcion(r.purchaseId, { uuid: 'recibo-0000002', lineas: [{ itemId: item.id, cantidad: 5 }] }, { actor }))
      .rejects.toMatchObject({ message: expect.stringMatching(/Llegó más de lo facturado/) });
    await servicio.confirmarRecepcion(r.purchaseId, { uuid: 'recibo-0000003', lineas: [{ itemId: item.id, cantidad: 4 }] }, { actor });
    expect(await stock(1)).toBe(15);
    expect((await query('SELECT estado_inventario FROM purchases WHERE id = ?', [r.purchaseId]))[0].estado_inventario).toBe('recibido_total');
    await expect(servicio.confirmarRecepcion(r.purchaseId, { uuid: 'recibo-0000004', lineas: [{ itemId: item.id, cantidad: 1 }] }, { actor }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  test('cerrar con faltante y anular revierte solo lo recibido', async () => {
    const { query, servicio, ctx } = await preparar({ modo: 'confirmacion' });
    const r = await servicio.registrar({ uuid: 'faltante-0001', encabezado: encabezado(), lineas: [{ productoId: 1, cantidad: 10, costoUnitario: 250, itbisPct: 18 }] }, ctx());
    const [item] = await query('SELECT id FROM purchase_items WHERE purchase_id = ?', [r.purchaseId]);
    await servicio.confirmarRecepcion(r.purchaseId, { uuid: 'faltante-rec1', lineas: [{ itemId: item.id, cantidad: 7 }], cerrar: true, notas: 'faltaron 3' }, { actor: { id: 1 } });
    expect((await query('SELECT estado_inventario FROM purchases WHERE id = ?', [r.purchaseId]))[0].estado_inventario).toBe('recibido_total');
    const [linea] = await query('SELECT * FROM purchase_items WHERE id = ?', [item.id]);
    expect(servicio.cantidadARevertir(linea)).toBe(7);
    expect(servicio.cantidadARevertir({ tipo_linea: null, cantidad: 4 })).toBe(4); // compra de antes de esta versión
    expect(servicio.cantidadARevertir({ tipo_linea: 'sin_inventario', cantidad: 4 })).toBe(0);
  });
});

describe('instalación existente', () => {
  test('purchase_items pasa a product_id opcional sin perder las compras viejas', async () => {
    const { query } = await preparar({ viejo: true });
    const cols = await query('PRAGMA table_info(purchase_items)');
    expect(cols.find((c) => c.name === 'product_id').notnull).toBe(0);
    expect(cols.some((c) => c.name === 'tipo_linea')).toBe(true);
    expect((await query('SELECT nombre, cantidad FROM purchase_items'))[0]).toEqual({ nombre: 'Viejo', cantidad: 2 });
  });
});
