'use strict';

/**
 * Negocio de ejemplo del Centro de Control (2 sucursales, 3 cajas) sobre
 * SQLite en memoria (sql.js). Lo usan las pruebas (control-center.test.js) y
 * scripts/control-center/export-app-fixtures.js, que genera los JSON con los
 * que la app de reportes prueba que entiende lo que publica el POS.
 *
 * "Ahora" fijo: lunes 5-oct-2026 14:30 hora RD (18:30 UTC).
 */

const NOW = new Date('2026-10-05T18:30:00Z');

const SCHEMA = `
  CREATE TABLE config (id INTEGER PRIMARY KEY, business_name TEXT, rnc TEXT, currency TEXT,
    business_structure_mode TEXT, business_type TEXT, e_invoice_enabled INT, license_status TEXT, tax_rate REAL);
  CREATE TABLE branches (id INTEGER PRIMARY KEY, nombre TEXT, codigo TEXT, estado TEXT DEFAULT 'Activa');
  CREATE TABLE cash_registers (id INTEGER PRIMARY KEY, branch_id INT, nombre TEXT, codigo TEXT,
    estado TEXT DEFAULT 'Activa', tipo_caja TEXT);
  CREATE TABLE users (id INTEGER PRIMARY KEY, nombre TEXT, usuario TEXT, rol TEXT, estado TEXT DEFAULT 'Activo',
    branch_id INT, sucursal_id INT, caja_id INT, account_type TEXT DEFAULT 'staff');
  CREATE TABLE payment_methods (id INTEGER PRIMARY KEY, codigo TEXT, nombre TEXT, estado TEXT DEFAULT 'Activo');
  CREATE TABLE products (id INTEGER PRIMARY KEY, codigo TEXT, nombre TEXT, categoria TEXT, unidad TEXT,
    precio_compra REAL, precio_venta REAL, stock REAL, stock_min REAL, estado TEXT DEFAULT 'Activo', tracks_stock INT DEFAULT 1,
    barcode TEXT, marca TEXT, aplica_itbis INT DEFAULT 0, image_url TEXT, image_local TEXT);
  CREATE TABLE categories (id INTEGER PRIMARY KEY, nombre TEXT);
  CREATE TABLE inventory_by_branch (id INTEGER PRIMARY KEY, branch_id INT, product_id INT, stock REAL, stock_min REAL);
  CREATE TABLE clients (id INTEGER PRIMARY KEY, nombre TEXT, telefono TEXT);
  CREATE TABLE sales (id INTEGER PRIMARY KEY, invoice_number TEXT, user_id INT, client_id INT, branch_id INT,
    cash_register_id INT, billed_branch_id INT, billed_cash_register_id INT, billed_by_user_id INT,
    document_type TEXT DEFAULT 'ticket', sale_status TEXT DEFAULT 'pagada', client_name_snapshot TEXT,
    client_phone_snapshot TEXT, payment_method TEXT, subtotal REAL, discount REAL DEFAULT 0, tax REAL DEFAULT 0,
    total REAL, received_amount REAL DEFAULT 0, fiscal_status TEXT DEFAULT 'emitida', order_type TEXT DEFAULT 'mostrador',
    delivery_user_id INT, delivery_status TEXT DEFAULT 'pendiente', delivery_name_snapshot TEXT,
    delivery_cash_status TEXT DEFAULT 'na', canceled_by_user_id INT, created_at TEXT, cash_session_id INT,
    ncf TEXT, ncf_type TEXT);
  CREATE TABLE sale_items (id INTEGER PRIMARY KEY, sale_id INT, product_id INT, item_name TEXT, qty REAL, price REAL, line_total REAL);
  CREATE TABLE sale_returns (id INTEGER PRIMARY KEY, original_sale_id INT, original_invoice_number TEXT,
    returned_amount REAL, returned_by_user_id INT, branch_id INT, cash_register_id INT, returned_at TEXT);
  CREATE TABLE client_credit_payments (id INTEGER PRIMARY KEY, client_id INT, amount REAL, payment_method TEXT,
    cash_session_id INT, branch_id INT, cash_register_id INT, created_by_user_id INT, created_by_user_name TEXT, created_at TEXT);
  CREATE TABLE expenses (id INTEGER PRIMARY KEY, fecha TEXT, branch_id INT, categoria TEXT, total REAL, estado TEXT DEFAULT 'pagado');
  CREATE TABLE cash_movements (id INTEGER PRIMARY KEY, session_id INT, branch_id INT, cash_register_id INT,
    movement_type TEXT, amount REAL, happened_at TEXT);
  CREATE TABLE cash_sessions (id INTEGER PRIMARY KEY, branch_id INT, cash_register_id INT, opened_by_user_name TEXT,
    opened_amount REAL, current_amount REAL, expected_amount REAL, counted_amount REAL, difference_amount REAL,
    opened_at TEXT, closed_at TEXT, status TEXT, operative_date TEXT, closed_by_user_name TEXT, duration_hours REAL);
  CREATE TABLE ecf_documents (id INTEGER PRIMARY KEY, sale_id INT, branch_id INT, tipo_ecf TEXT, encf TEXT,
    estado_dgii TEXT, nombre_comprador TEXT, monto_total REAL, error_message TEXT, created_at TEXT, sent_at TEXT,
    certification_case_key TEXT);
  CREATE TABLE ncf_authorized_sequences (id INTEGER PRIMARY KEY, business_id INT, branch_id INT, series TEXT,
    document_type TEXT, document_name TEXT, prefix TEXT, start_number INT, end_number INT, next_number INT,
    last_used_number INT, authorization_date TEXT, expiration_date TEXT, authorization_reference TEXT,
    environment TEXT, status TEXT, authorization_file_url TEXT, notes TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
  CREATE TABLE ecf_sequences (id INTEGER PRIMARY KEY, business_id INT, branch_id INT, tipo_comprobante TEXT,
    numero_inicial INT, numero_final INT, proximo_numero INT, fecha_autorizacion TEXT, fecha_vencimiento TEXT,
    activo INT DEFAULT 1, environment TEXT, authorization_reference TEXT, created_at TEXT, updated_at TEXT);
  CREATE TABLE terminal_registrations (terminal_id TEXT, terminal_name TEXT, branch_id INT, cash_register_id INT,
    is_main INT, status TEXT, connection_type TEXT, last_seen_at TEXT);
`;

function seed(db) {
  const run = (sql, params = []) => db.run(sql, params);
  run(`INSERT INTO config VALUES (1, 'Colmado La Fe', '131000000', 'RD$', 'multisucursal', 'colmado', 1, 'active', 18)`);
  run(`INSERT INTO branches (id, nombre) VALUES (1, 'Principal'), (2, 'Norte')`);
  run(`INSERT INTO cash_registers (id, branch_id, nombre) VALUES (1, 1, 'Caja 1'), (2, 1, 'Caja 2'), (3, 2, 'Caja Norte')`);
  run(`INSERT INTO users (id, nombre, usuario, rol) VALUES (1, 'Ana', 'ana', 'administrador_general'),
       (2, 'Luis', 'luis', 'cajero'), (3, 'Marta', 'marta', 'cajero')`);
  run(`INSERT INTO users (id, nombre, usuario, rol, account_type) VALUES (9, 'Cliente Web', 'web', 'cliente', 'customer')`);
  run(`INSERT INTO payment_methods (codigo, nombre) VALUES ('efectivo', 'Efectivo'), ('tarjeta', 'Tarjeta'),
       ('subsidio', 'Tarjeta de Subsidio')`);
  run(`INSERT INTO products (id, codigo, nombre, categoria, unidad, precio_compra, precio_venta, stock, stock_min,
         estado, tracks_stock, barcode, marca, aplica_itbis, image_url) VALUES
       (1, 'A1', 'Arroz', 'Granos', 'Libra', 30, 50, 8, 10, 'Activo', 1, NULL, NULL, 0, NULL),
       (2, 'A2', 'Aceite', 'Aceites', 'Botella', 100, 150, 13, 5, 'Activo', 1, '7460001000022', 'Crisol', 1, 'https://img.example/aceite.jpg'),
       (3, 'J1', 'Jabón', 'Limpieza', 'Unidad', 0, 40, 20, 2, 'Activo', 1, NULL, NULL, 1, 'data:image/png;base64,AAAA'),
       (4, 'V1', 'Velas', 'Hogar', 'Unidad', 10, 20, 50, 5, 'Activo', 1, NULL, NULL, 0, NULL),
       (5, 'S1', 'Recarga', 'Servicios', 'Unidad', 0, 100, 0, 0, 'Activo', 0, NULL, NULL, 0, NULL),
       (6, 'X1', 'Galletas viejas', 'Granos', 'Unidad', 5, 10, 0, 0, 'Inactivo', 1, NULL, NULL, 0, NULL)`);
  run(`INSERT INTO categories (nombre) VALUES ('Granos'), ('Aceites'), ('Limpieza'), ('Hogar'), ('Servicios')`);
  run(`INSERT INTO inventory_by_branch (branch_id, product_id, stock, stock_min) VALUES
       (1, 1, 0, 10), (1, 2, 3, 5), (1, 3, 15, 2), (1, 4, 50, 5),
       (2, 1, 8, 10), (2, 2, 10, 5), (2, 3, 5, 2)`);
  run(`INSERT INTO clients VALUES (1, 'Juan Pérez', '809-555-0001'), (2, 'Pedro Gómez', '809-555-0002')`);

  const sale = (id, o) => run(
    `INSERT INTO sales (id, invoice_number, user_id, client_id, branch_id, cash_register_id, billed_branch_id,
       billed_cash_register_id, billed_by_user_id, payment_method, subtotal, tax, total, received_amount,
       fiscal_status, order_type, delivery_status, delivery_cash_status, delivery_name_snapshot,
       canceled_by_user_id, created_at, cash_session_id, client_name_snapshot, document_type, ncf, ncf_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, `FAC-${String(id).padStart(8, '0')}`, o.user, o.client || null, o.branch, o.reg, o.branch, o.reg, o.user,
      o.pm, o.subtotal ?? o.total, o.tax || 0, o.total, o.received ?? o.total, o.fiscal || 'emitida',
      o.orderType || 'mostrador', o.delivery || 'pendiente', o.cash || 'na', o.driver || null,
      o.canceledBy || null, o.at, o.session || null, o.clientName || null, o.docType || 'ticket', o.ncf || null, o.ncfType || null]
  );
  const item = (saleId, productId, qty, line) => run(
    'INSERT INTO sale_items (sale_id, product_id, qty, price, line_total) VALUES (?, ?, ?, ?, ?)',
    [saleId, productId, qty, line / qty, line]
  );

  // Hoy
  sale(1, { branch: 1, reg: 1, user: 2, pm: 'efectivo', subtotal: 100, tax: 18, total: 118, at: '2026-10-05 09:15:00', session: 1, docType: 'comprobante-fiscal', ncf: 'B0200000079', ncfType: 'B02' });
  item(1, 1, 2, 100);
  sale(2, { branch: 1, reg: 2, user: 2, pm: 'subsidio', total: 150, at: '2026-10-05 10:05:00' });
  item(2, 2, 1, 150);
  sale(3, { branch: 2, reg: 3, user: 3, pm: 'tarjeta', total: 40, at: '2026-10-05 11:20:00', session: 2 });
  item(3, 3, 1, 40);
  sale(4, { branch: 1, reg: 1, user: 2, pm: 'credito', client: 1, total: 500, received: 200, at: '2026-10-05 12:00:00', session: 1 });
  item(4, 2, 3, 450);
  item(4, 1, 1, 50);
  sale(5, { branch: 1, reg: 1, user: 1, pm: 'efectivo', total: 100, fiscal: 'cancelada', canceledBy: 1, at: '2026-10-05 12:30:00' });
  item(5, 4, 5, 100);
  sale(6, { branch: 1, reg: 1, user: 2, pm: 'efectivo', client: 2, total: 80, at: '2026-10-05 13:00:00', orderType: 'delivery', delivery: 'en_camino', cash: 'pendiente', driver: 'Moto 1', clientName: 'Pedro Gómez', session: 1 });
  item(6, 3, 2, 80);
  // Ayer: una venta antes de las 14:30 y otra después
  sale(7, { branch: 1, reg: 1, user: 2, pm: 'efectivo', total: 200, at: '2026-10-04 10:00:00' });
  item(7, 1, 4, 200);
  sale(8, { branch: 1, reg: 2, user: 2, pm: 'tarjeta', total: 100, at: '2026-10-04 18:00:00' });
  item(8, 2, 1, 100);
  // Crédito viejo (46 días)
  sale(9, { branch: 1, reg: 1, user: 2, pm: 'credito', client: 1, total: 300, received: 0, at: '2026-08-20 09:00:00' });
  item(9, 1, 6, 300);

  run(`INSERT INTO sale_returns (original_sale_id, original_invoice_number, returned_amount, returned_by_user_id, branch_id, cash_register_id, returned_at)
       VALUES (1, 'FAC-00000001', 50, 2, 1, 1, '2026-10-05 13:30:00')`);
  run(`INSERT INTO client_credit_payments (client_id, amount, payment_method, cash_session_id, branch_id, cash_register_id, created_by_user_id, created_by_user_name, created_at)
       VALUES (1, 200, 'efectivo', 1, 1, 1, 2, 'Luis', '2026-10-05 12:45:00')`);
  run(`INSERT INTO expenses (fecha, branch_id, categoria, total) VALUES ('2026-10-05', 1, 'Electricidad', 1000)`);
  run(`INSERT INTO expenses (fecha, branch_id, categoria, total, estado) VALUES ('2026-10-05', 1, 'Agua', 300, 'anulado')`);
  run(`INSERT INTO cash_movements (session_id, branch_id, cash_register_id, movement_type, amount, happened_at) VALUES
       (1, 1, 1, 'Gasto', 150, '2026-10-05 11:00:00'),
       (1, 1, 1, 'Retiro de efectivo', 500, '2026-10-05 12:10:00')`);
  run(`INSERT INTO cash_sessions VALUES
       (1, 1, 1, 'Luis', 1000, 1500, 0, NULL, NULL, '2026-10-05 08:00:00', NULL, 'open', '2026-10-05', NULL, NULL),
       (2, 2, 3, 'Marta', 500, 540, 0, NULL, NULL, '2026-10-04 08:00:00', NULL, 'open', '2026-10-04', NULL, NULL),
       (3, 1, 2, 'Luis', 800, 900, 900, 850, -50, '2026-10-05 07:00:00', '2026-10-05 12:00:00', 'closed', '2026-10-05', 'Ana', 5)`);
  run(`INSERT INTO ecf_documents (sale_id, branch_id, tipo_ecf, encf, estado_dgii, nombre_comprador, monto_total, error_message, created_at, sent_at, certification_case_key) VALUES
       (1, 1, 'E32', 'E320000000001', 'aceptado', 'Consumidor', 118, NULL, '2026-10-05 09:16:00', '2026-10-05 09:16:30', NULL),
       (4, 1, 'E31', 'E310000000002', 'rechazado', 'Juan Pérez', 500, 'RNC del comprador inválido', '2026-10-05 12:01:00', '2026-10-05 12:01:20', NULL),
       (3, 2, 'E32', 'E320000000003', 'pendiente', 'Consumidor', 40, NULL, '2026-10-05 08:00:00', NULL, NULL),
       (NULL, 1, 'E31', 'E310000000099', 'rechazado', 'Prueba DGII', 1, 'caso de certificación', '2026-10-05 08:00:00', NULL, 'CASO-1')`);
  run(`INSERT INTO ncf_authorized_sequences (id, business_id, branch_id, series, document_type, prefix, start_number, end_number, next_number, expiration_date, status, created_at)
       VALUES (1, 1, 1, 'B', 'B02', 'B02', 1, 100, 80, '2027-12-31', 'activo', '2026-09-01 08:00:00')`);
  // e-NCF: uno de producción cargado hace 2 días (nuevo) y uno de pruebas que no cuenta.
  run(`INSERT INTO ecf_sequences (id, business_id, branch_id, tipo_comprobante, numero_inicial, numero_final, proximo_numero,
         fecha_autorizacion, fecha_vencimiento, activo, environment, authorization_reference, created_at) VALUES
       (1, 1, NULL, 'E32', 1, 500, 4, '2026-10-03', '2028-12-31', 1, 'ecf', 'AUT-2026-1', '2026-10-03 10:00:00'),
       (2, 1, NULL, 'E31', 1, 100, 1, '2026-01-10', '2027-12-31', 1, 'certecf', 'PRUEBA', '2026-01-10 10:00:00')`);
  // Foto de Arroz subida en la PC (archivo local con la huella en el nombre).
  run(`UPDATE products SET image_local = '/uploads/productos/arroz-1-abc123def456.webp' WHERE id = 1`);
  run(`INSERT INTO terminal_registrations VALUES
       ('T-MAIN', 'PC Principal', 1, 1, 1, 'online', 'lan', '2026-10-05 14:29:00'),
       ('T-2', 'Caja Norte', 2, 3, 0, 'offline', 'lan', '2026-10-05 11:00:00')`);
}

function queryFor(db) {
  return async (sql, params = []) => {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params.map((p) => (p === undefined ? null : p)));
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  };
}

async function createDb() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(SCHEMA);
  seed(db);
  return { db, query: queryFor(db) };
}

/**
 * Empresa de servicios de ejemplo (Tecnología, 2 sucursales) con el esquema
 * real de las tablas svc_*. `withServiceTables: false` = todavía sin tablas.
 */
async function createServiceDb({ withServiceTables = true } = {}) {
  const { ensureServiciosSchema } = require('../../server/routes/servicios/schema');
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(SCHEMA);
  db.run('ALTER TABLE config ADD COLUMN service_company INT DEFAULT 0');
  db.run('ALTER TABLE config ADD COLUMN service_vertical TEXT');
  const query = queryFor(db);
  const run = (sql, params = []) => db.run(sql, params);
  run(`INSERT INTO config (id, business_name, rnc, currency, business_structure_mode, business_type, e_invoice_enabled, license_status, tax_rate, service_company, service_vertical)
       VALUES (1, 'Emilio Digital Solutions', '40211932609', 'RD$', 'multisucursal', 'srv_tecnologia', 1, 'active', 18, 1, 'srv_tecnologia')`);
  run(`INSERT INTO branches (id, nombre) VALUES (1, 'Principal'), (2, 'Santiago')`);
  run(`INSERT INTO cash_registers (id, branch_id, nombre) VALUES (1, 1, 'Puesto 1')`);
  run(`INSERT INTO users (id, nombre, usuario, rol) VALUES (1, 'Emilio', 'emilio', 'administrador_general')`);
  run(`INSERT INTO payment_methods (codigo, nombre) VALUES ('efectivo', 'Efectivo'), ('transferencia', 'Transferencia')`);
  run(`INSERT INTO clients VALUES (1, 'Farmacia Central', '809-555-0101'), (2, 'Colegio Luz', '809-555-0202')`);
  // Facturas de servicios espejadas en ventas (así las ve "Facturación").
  run(`INSERT INTO sales (id, invoice_number, user_id, client_id, branch_id, billed_branch_id, billed_by_user_id, payment_method,
         subtotal, tax, total, received_amount, created_at, client_name_snapshot, document_type) VALUES
       (1, 'FS-0003', 1, 1, 1, 1, 1, 'efectivo', 1016.95, 183.05, 1200, 1200, '2026-10-02 09:00:00', 'Farmacia Central', 'B01'),
       (2, 'FS-0005', 1, 2, 1, 1, 1, 'transferencia', 847.46, 152.54, 1000, 1000, '2026-10-05 10:00:00', 'Colegio Luz', 'B01')`);
  run(`INSERT INTO sale_items (sale_id, product_id, item_name, qty, price, line_total) VALUES
       (1, NULL, 'Soporte técnico', 1, 1200, 1200), (2, NULL, 'Instalación de red', 1, 1000, 1000)`);
  if (withServiceTables) {
    await ensureServiciosSchema(query);
    // Facturas: una vencida, una que vence después, una pagada y una anulada.
    run(`INSERT INTO svc_invoices (id, numero, client_id, client_name, branch_id, fecha, vencimiento, total, pagado, balance, estado) VALUES
         (1, 'FS-0001', 1, 'Farmacia Central', 1, '2026-09-10', '2026-09-25', 5000, 1000, 4000, 'parcial'),
         (2, 'FS-0002', 2, 'Colegio Luz', 2, '2026-10-01', '2026-10-31', 2500, 0, 2500, 'pendiente'),
         (3, 'FS-0003', 1, 'Farmacia Central', 1, '2026-10-02', NULL, 1200, 1200, 0, 'pagada'),
         (4, 'FS-0004', 2, 'Colegio Luz', 1, '2026-10-03', '2026-10-04', 900, 0, 900, 'anulada')`);
    // Cobros: hoy, ayer (domingo, semana pasada), este mes y el mes pasado; uno anulado.
    run(`INSERT INTO svc_invoice_payments (invoice_id, fecha, monto, metodo, branch_id, created_by_user_name, anulado_at) VALUES
         (1, '2026-10-05', 1000, 'transferencia', 1, 'Emilio', NULL),
         (3, '2026-10-04', 1200, 'efectivo', 1, 'Emilio', NULL),
         (3, '2026-10-02', 300, 'efectivo', 2, 'Emilio', NULL),
         (1, '2026-09-20', 700, 'efectivo', 1, 'Emilio', NULL),
         (1, '2026-10-05', 999, 'efectivo', 1, 'Emilio', '2026-10-05 10:00:00')`);
    run(`INSERT INTO svc_quotations (numero, client_name, branch_id, fecha, validez_dias, estado, total) VALUES
         ('COT-0001', 'Farmacia Central', 1, '2026-10-01', 15, 'aprobada', 8000),
         ('COT-0002', 'Colegio Luz', 1, '2026-09-01', 15, 'aprobada', 3000),
         ('COT-0003', 'Colegio Luz', 1, '2026-09-15', 15, 'convertida', 4000)`);
    run(`INSERT INTO svc_work_orders (numero, titulo, client_name, branch_id, estado, prioridad, responsable_nombre, fecha_programada) VALUES
         ('OT-0001', 'Instalar red', 'Colegio Luz', 1, 'asignada', 'alta', 'Carlos', '2026-10-01'),
         ('OT-0002', 'Revisar servidor', 'Farmacia Central', 2, 'pendiente', 'normal', NULL, '2026-10-09'),
         ('OT-0003', 'Cambiar disco', 'Farmacia Central', 1, 'completada', 'normal', 'Carlos', '2026-09-20')`);
    run(`INSERT INTO svc_projects (numero, nombre, client_name, branch_id, estado, avance_pct, fecha_entrega, presupuesto) VALUES
         ('PRY-0001', 'Sistema de citas', 'Farmacia Central', 1, 'en_progreso', 40, '2026-09-30', 60000),
         ('PRY-0002', 'Página web', 'Colegio Luz', 1, 'planificacion', 0, '2026-12-15', 25000),
         ('PRY-0003', 'App vieja', 'Colegio Luz', 1, 'completado', 100, '2026-08-01', 10000)`);
    run(`INSERT INTO svc_contracts (numero, titulo, client_name, branch_id, estado, monto, frecuencia, fecha_fin) VALUES
         ('CTR-0001', 'Soporte mensual', 'Farmacia Central', 1, 'activo', 3500, 'mensual', '2026-10-20'),
         ('CTR-0002', 'Hosting', 'Colegio Luz', 1, 'activo', 1500, 'mensual', '2027-06-30')`);
    // Tabla de otro tipo de servicio: no debe aparecer en Tecnología.
    run(`INSERT INTO svc_campaigns (numero, nombre, client_name, branch_id, estado, fecha_fin, presupuesto) VALUES
         ('CMP-0001', 'No va', 'X', 1, 'activa', '2026-01-01', 1)`);
  }
  return { db, query };
}

function fakeFirestore() {
  const store = new Map();
  let commits = 0;
  const docRef = (path) => ({
    path,
    collection: (name) => colRef(`${path}/${name}`),
    async set(data, options) {
      store.set(path, options?.merge ? { ...(store.get(path) || {}), ...data } : data);
    },
    async get() {
      const data = store.get(path);
      return { exists: Boolean(data), data: () => data };
    },
    async delete() {
      store.delete(path);
    },
  });
  const colRef = (path) => ({ path, doc: (id) => docRef(`${path}/${id}`) });
  return {
    store,
    get commits() { return commits; },
    collection: (name) => colRef(name),
    batch() {
      const ops = [];
      return {
        set(ref, data) { ops.push([ref.path, data]); },
        async commit() {
          commits += 1;
          for (const [path, data] of ops) store.set(path, data);
        },
      };
    },
  };
}

module.exports = { NOW, SCHEMA, seed, createDb, createServiceDb, fakeFirestore };
