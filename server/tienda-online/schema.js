'use strict';

/**
 * server/tienda-online/schema.js
 *
 * Tablas locales de la Tienda Online. SQL en dialecto SQLite: db.js lo traduce
 * a MariaDB (las instalaciones nuevas monocaja corren SQLite).
 *
 * No hay catálogo, clientes, ventas ni inventario aparte: el pedido apunta a
 * products / clients / sales del POS. Solo se agrega:
 *   - products.online_*         qué se publica y cómo (y sus fotos extra)
 *   - sales.online_order_id      de qué pedido salió la venta
 *   - online_orders / _items     el pedido tal como lo hizo el cliente
 *   - online_order_events        historial (estados, venta, notas)
 *   - online_order_notifications avisos al cliente (WhatsApp, etc.)
 *   - online_store_settings      configuración de la tienda (1 fila)
 */

const TABLES = [
  `CREATE TABLE IF NOT EXISTS online_store_settings (
    id INT PRIMARY KEY,
    enabled TINYINT(1) NOT NULL DEFAULT 0,
    slug VARCHAR(80) DEFAULT NULL,
    branch_id INT DEFAULT NULL,
    settings_json LONGTEXT DEFAULT NULL,
    banner_data LONGTEXT DEFAULT NULL,
    updated_at DATETIME DEFAULT NULL,
    updated_by VARCHAR(160) DEFAULT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS online_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cloud_id VARCHAR(64) NOT NULL UNIQUE,
    order_number INT NOT NULL,
    license_id VARCHAR(64) DEFAULT NULL,
    store_slug VARCHAR(80) DEFAULT NULL,
    branch_id INT DEFAULT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'nuevo',
    customer_name VARCHAR(160) NOT NULL,
    customer_phone VARCHAR(40) DEFAULT NULL,
    customer_whatsapp VARCHAR(40) DEFAULT NULL,
    customer_email VARCHAR(160) DEFAULT NULL,
    client_id INT DEFAULT NULL,
    delivery_type VARCHAR(20) NOT NULL DEFAULT 'retiro',
    delivery_zone VARCHAR(120) DEFAULT NULL,
    delivery_address VARCHAR(255) DEFAULT NULL,
    delivery_sector VARCHAR(120) DEFAULT NULL,
    delivery_reference VARCHAR(255) DEFAULT NULL,
    delivery_municipio VARCHAR(120) DEFAULT NULL,
    delivery_provincia VARCHAR(120) DEFAULT NULL,
    delivery_fee DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    delivery_fee_tax DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    payment_method VARCHAR(40) DEFAULT NULL,
    payment_label VARCHAR(120) DEFAULT NULL,
    invoice_requested TINYINT(1) NOT NULL DEFAULT 0,
    invoice_rnc VARCHAR(20) DEFAULT NULL,
    invoice_name VARCHAR(160) DEFAULT NULL,
    notes TEXT DEFAULT NULL,
    subtotal DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    discount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    tax DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    promo_savings DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    currency VARCHAR(10) NOT NULL DEFAULT 'RD$',
    sale_id INT DEFAULT NULL,
    sale_invoice_number VARCHAR(40) DEFAULT NULL,
    converted_at DATETIME DEFAULT NULL,
    converted_by_user_id INT DEFAULT NULL,
    converted_by_user_name VARCHAR(160) DEFAULT NULL,
    processing_by_user_id INT DEFAULT NULL,
    processing_by_name VARCHAR(160) DEFAULT NULL,
    processing_until DATETIME DEFAULT NULL,
    dispatched_at DATETIME DEFAULT NULL,
    delivered_at DATETIME DEFAULT NULL,
    cancel_reason VARCHAR(255) DEFAULT NULL,
    cloud_created_at DATETIME DEFAULT NULL,
    received_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    cloud_sync_pending TINYINT(1) NOT NULL DEFAULT 0,
    change_seq INT NOT NULL DEFAULT 0,
    cloud_sync_attempts INT NOT NULL DEFAULT 0,
    cloud_sync_error VARCHAR(255) DEFAULT NULL,
    cloud_synced_at DATETIME DEFAULT NULL,
    reservation_released TINYINT(1) NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS online_order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INT NOT NULL,
    product_id INT DEFAULT NULL,
    product_code VARCHAR(60) DEFAULT NULL,
    product_name VARCHAR(255) NOT NULL,
    unit_label VARCHAR(40) DEFAULT NULL,
    sale_mode VARCHAR(20) NOT NULL DEFAULT 'unidad',
    qty DECIMAL(12,2) NOT NULL,
    unit_price DECIMAL(12,2) NOT NULL,
    original_price DECIMAL(12,2) DEFAULT NULL,
    promotion_id INT DEFAULT NULL,
    promotion_name VARCHAR(150) DEFAULT NULL,
    discount_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    tax_mode VARCHAR(20) DEFAULT NULL,
    tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    tax_unit_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    subtotal DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    discount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    tax DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    line_total DECIMAL(12,2) NOT NULL DEFAULT 0.00
  )`,
  `CREATE TABLE IF NOT EXISTS online_order_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INT NOT NULL,
    event_type VARCHAR(40) NOT NULL,
    from_status VARCHAR(30) DEFAULT NULL,
    to_status VARCHAR(30) DEFAULT NULL,
    detail VARCHAR(500) DEFAULT NULL,
    user_id INT DEFAULT NULL,
    user_name VARCHAR(160) DEFAULT NULL,
    created_at DATETIME NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS online_order_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INT NOT NULL,
    channel VARCHAR(20) NOT NULL,
    recipient VARCHAR(160) DEFAULT NULL,
    message TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pendiente',
    attempts INT NOT NULL DEFAULT 0,
    last_error VARCHAR(255) DEFAULT NULL,
    created_at DATETIME NOT NULL,
    sent_at DATETIME DEFAULT NULL
  )`,
];

const INDEXES = [
  'CREATE INDEX idx_online_orders_status ON online_orders (status)',
  'CREATE INDEX idx_online_orders_sale ON online_orders (sale_id)',
  'CREATE INDEX idx_online_orders_sync ON online_orders (cloud_sync_pending)',
  'CREATE INDEX idx_online_orders_received ON online_orders (received_at)',
  'CREATE INDEX idx_online_orders_branch ON online_orders (branch_id)',
  'CREATE INDEX idx_online_order_items_order ON online_order_items (order_id)',
  'CREATE INDEX idx_online_order_events_order ON online_order_events (order_id)',
  'CREATE INDEX idx_online_order_notif_status ON online_order_notifications (status)',
  'CREATE INDEX idx_sales_online_order ON sales (online_order_id)',
  'CREATE INDEX idx_products_online ON products (online_enabled)',
];

const COLUMNS = [
  ['products', 'online_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['products', 'online_description', 'VARCHAR(500) DEFAULT NULL'],
  ['products', 'online_featured', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['products', 'online_order', 'INT NOT NULL DEFAULT 0'],
  // 'inventario' = respeta la existencia de la sucursal de la tienda;
  // 'ilimitado' = siempre disponible (servicios, comida preparada…).
  ['products', 'online_stock_mode', `VARCHAR(20) NOT NULL DEFAULT 'inventario'`],
  // Fotos adicionales para la tienda (JSON con rutas locales, hasta 5); la
  // principal sigue siendo image_local / image_url del producto.
  ['products', 'online_images', 'TEXT DEFAULT NULL'],
  ['sales', 'online_order_id', 'INT DEFAULT NULL'],
  ['sales', 'sync_origin', 'VARCHAR(40) DEFAULT NULL'],
  ['clients', 'sync_origin', 'VARCHAR(40) DEFAULT NULL'],
];

/**
 * @param {object} deps
 * @param {Function} deps.query
 * @param {Function} deps.addColumnIfMissing  (tabla, columna, definición)
 */
async function ensureTiendaOnlineSchema({ query, addColumnIfMissing }) {
  for (const sql of TABLES) {
    await query(sql);
  }
  for (const [table, column, definition] of COLUMNS) {
    await addColumnIfMissing(table, column, definition);
  }
  for (const sql of INDEXES) {
    await query(sql).catch(() => {});
  }
  await query(
    `INSERT OR IGNORE INTO online_store_settings (id, enabled, settings_json) VALUES (1, 0, '{}')`,
  );
}

module.exports = { ensureTiendaOnlineSchema, TABLES, INDEXES, COLUMNS };
