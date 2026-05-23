CREATE DATABASE IF NOT EXISTS tecnocaja CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE tecnocaja;

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS sync_log;
DROP TABLE IF EXISTS pending_cash_movements;
DROP TABLE IF EXISTS pending_sale_items;
DROP TABLE IF EXISTS pending_sales;
DROP TABLE IF EXISTS offline_cache_payment_methods;
DROP TABLE IF EXISTS offline_cache_config;
DROP TABLE IF EXISTS offline_cache_users;
DROP TABLE IF EXISTS offline_cache_clients;
DROP TABLE IF EXISTS offline_cache_products;
DROP TABLE IF EXISTS offline_terminal_cache;
DROP TABLE IF EXISTS branch_transfer_items;
DROP TABLE IF EXISTS branch_transfers;
DROP TABLE IF EXISTS cash_closings;
DROP TABLE IF EXISTS cash_openings;
DROP TABLE IF EXISTS sale_items;
DROP TABLE IF EXISTS sales;
DROP TABLE IF EXISTS inventory_movements;
DROP TABLE IF EXISTS inventory_by_branch;
DROP TABLE IF EXISTS cash_movements;
DROP TABLE IF EXISTS cash_sessions;
DROP TABLE IF EXISTS supplier_invoices;
DROP TABLE IF EXISTS delivery_locations;
DROP TABLE IF EXISTS dining_tables;
DROP TABLE IF EXISTS mobile_session_items;
DROP TABLE IF EXISTS mobile_sessions;
DROP TABLE IF EXISTS suspended_sales;
DROP TABLE IF EXISTS quotations;
DROP TABLE IF EXISTS suppliers;
DROP TABLE IF EXISTS clients;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS payment_methods;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS cash_registers;
DROP TABLE IF EXISTS branches;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS config;
DROP TABLE IF EXISTS businesses;
SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE businesses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(160) NOT NULL,
  rnc VARCHAR(40) DEFAULT NULL,
  direccion VARCHAR(255) DEFAULT NULL,
  telefono VARCHAR(40) DEFAULT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'Activo',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_businesses_estado (estado)
);

CREATE TABLE roles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  codigo VARCHAR(60) NOT NULL UNIQUE,
  nombre VARCHAR(120) NOT NULL,
  permisos LONGTEXT DEFAULT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'Activo',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_roles_estado (estado)
);

CREATE TABLE branches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT DEFAULT NULL,
  nombre VARCHAR(160) NOT NULL,
  codigo VARCHAR(40) DEFAULT NULL,
  direccion VARCHAR(255) DEFAULT NULL,
  telefono VARCHAR(40) DEFAULT NULL,
  encargado VARCHAR(160) DEFAULT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'Activa',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_branches_codigo (codigo),
  KEY idx_branches_business (business_id),
  KEY idx_branches_estado (estado),
  CONSTRAINT fk_branches_business FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE SET NULL
);

CREATE TABLE cash_registers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  branch_id INT NOT NULL,
  nombre VARCHAR(120) NOT NULL,
  codigo VARCHAR(40) DEFAULT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'Activa',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cash_registers_branch_codigo (branch_id, codigo),
  KEY idx_cash_registers_branch (branch_id),
  KEY idx_cash_registers_estado (estado),
  CONSTRAINT fk_cash_registers_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
);

CREATE TABLE config (
  id INT PRIMARY KEY,
  business_id INT DEFAULT NULL,
  active_branch_id INT DEFAULT NULL,
  active_cash_register_id INT DEFAULT NULL,
  business_name VARCHAR(120) NOT NULL,
  rnc VARCHAR(40) NOT NULL,
  address VARCHAR(255) NOT NULL,
  phone VARCHAR(40) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'RD$',
  tax_rate DECIMAL(5,2) NOT NULL DEFAULT 18.00,
  tax_calculate_at_invoice_end TINYINT(1) NOT NULL DEFAULT 1,
  tax_include_in_product_price TINYINT(1) NOT NULL DEFAULT 0,
  tax_show_breakdown_on_receipts TINYINT(1) NOT NULL DEFAULT 1,
  tax_separate_taxable_and_exempt TINYINT(1) NOT NULL DEFAULT 1,
  invoice_prefix VARCHAR(20) NOT NULL DEFAULT 'FAC-',
  invoice_next_number INT NOT NULL DEFAULT 1001,
  e_invoice_enabled TINYINT(1) NOT NULL DEFAULT 1,
  e_invoice_prefix VARCHAR(20) NOT NULL DEFAULT 'ECF-',
  e_invoice_next_number INT NOT NULL DEFAULT 1,
  receipt_message VARCHAR(255) NOT NULL,
  receipt_print_mode VARCHAR(20) NOT NULL DEFAULT 'dialog',
  receipt_printer_name VARCHAR(160) DEFAULT NULL,
  receipt_paper_size VARCHAR(20) NOT NULL DEFAULT '80mm',
  cash_drawer_enabled TINYINT(1) NOT NULL DEFAULT 0,
  cash_drawer_method VARCHAR(20) NOT NULL DEFAULT 'escpos',
  cash_drawer_printer_name VARCHAR(160) DEFAULT NULL,
  cash_drawer_pin TINYINT(1) NOT NULL DEFAULT 0,
  cash_drawer_network_host VARCHAR(160) DEFAULT NULL,
  cash_drawer_network_port INT NOT NULL DEFAULT 9100,
  cash_drawer_serial_port VARCHAR(40) NOT NULL DEFAULT 'COM1',
  scale_type VARCHAR(20) NOT NULL DEFAULT 'none',
  scale_serial_port VARCHAR(40) DEFAULT NULL,
  scale_serial_baud_rate INT NOT NULL DEFAULT 9600,
  scale_default_unit VARCHAR(10) NOT NULL DEFAULT 'kg',
  scale_read_pattern VARCHAR(255) DEFAULT NULL,
  scale_rounding_decimals INT NOT NULL DEFAULT 2,
  scale_auto_read TINYINT(1) NOT NULL DEFAULT 1,
  whatsapp_web_enabled TINYINT(1) NOT NULL DEFAULT 0,
  whatsapp_paste_guide_enabled TINYINT(1) NOT NULL DEFAULT 1,
  sales_split_view_enabled TINYINT(1) NOT NULL DEFAULT 0,
  app_logo LONGTEXT DEFAULT NULL,
  security_password VARCHAR(120) NOT NULL DEFAULT '6888939502182025',
  language VARCHAR(10) NOT NULL DEFAULT 'es',
  business_type VARCHAR(30) NOT NULL DEFAULT 'pizzeria',
  setup_completed TINYINT(1) NOT NULL DEFAULT 0,
  setup_completed_at DATETIME DEFAULT NULL,
  trial_started_at DATETIME DEFAULT NULL,
  trial_ends_at DATETIME DEFAULT NULL,
  license_status VARCHAR(20) NOT NULL DEFAULT 'trial',
  license_activated_at DATETIME DEFAULT NULL,
  license_activated_by VARCHAR(160) DEFAULT NULL,
  require_cash_open_before_use TINYINT(1) NOT NULL DEFAULT 1,
  business_structure_mode VARCHAR(30) NOT NULL DEFAULT 'monocaja',
  sales_operation_mode VARCHAR(30) NOT NULL DEFAULT 'directa',
  starter_catalog_seeded TINYINT(1) NOT NULL DEFAULT 1,
  mobile_connection_code VARCHAR(120) DEFAULT NULL,
  cash_open TINYINT(1) NOT NULL DEFAULT 0,
  cash_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  cashier_register_required TINYINT(1) NOT NULL DEFAULT 1,
  exclusive_cashier_per_register TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT fk_config_business FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE SET NULL,
  CONSTRAINT fk_config_active_branch FOREIGN KEY (active_branch_id) REFERENCES branches(id) ON DELETE SET NULL,
  CONSTRAINT fk_config_active_cash_register FOREIGN KEY (active_cash_register_id) REFERENCES cash_registers(id) ON DELETE SET NULL
);

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  role_id INT DEFAULT NULL,
  branch_id INT DEFAULT NULL,
  sucursal_id INT DEFAULT NULL,
  caja_id INT DEFAULT NULL,
  usuario VARCHAR(60) NOT NULL UNIQUE,
  email VARCHAR(160) DEFAULT NULL,
  password VARCHAR(120) NOT NULL,
  password_hash VARCHAR(255) DEFAULT NULL,
  nombre VARCHAR(120) NOT NULL,
  rol VARCHAR(40) NOT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'Activo',
  last_login VARCHAR(40) NOT NULL DEFAULT '—',
  telefono VARCHAR(40) DEFAULT NULL,
  observacion TEXT DEFAULT NULL,
  creado_por INT DEFAULT NULL,
  fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP,
  linked_client_id INT DEFAULT NULL,
  account_type VARCHAR(40) NOT NULL DEFAULT 'staff',
  auth_provider VARCHAR(40) NOT NULL DEFAULT 'local',
  firebase_uid VARCHAR(191) DEFAULT NULL,
  UNIQUE KEY idx_users_email_unique (email),
  UNIQUE KEY idx_users_firebase_uid (firebase_uid),
  KEY idx_users_role (role_id),
  KEY idx_users_branch (branch_id),
  KEY idx_users_sucursal (sucursal_id),
  KEY idx_users_caja (caja_id),
  KEY idx_users_estado (estado),
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE SET NULL,
  CONSTRAINT fk_users_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL,
  CONSTRAINT fk_users_sucursal FOREIGN KEY (sucursal_id) REFERENCES branches(id) ON DELETE SET NULL,
  CONSTRAINT fk_users_caja FOREIGN KEY (caja_id) REFERENCES cash_registers(id) ON DELETE SET NULL,
  CONSTRAINT fk_users_creado_por FOREIGN KEY (creado_por) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE payment_methods (
  id INT AUTO_INCREMENT PRIMARY KEY,
  codigo VARCHAR(40) NOT NULL UNIQUE,
  nombre VARCHAR(120) NOT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'Activo',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(80) NOT NULL UNIQUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  codigo VARCHAR(40) NOT NULL UNIQUE,
  nombre VARCHAR(160) NOT NULL,
  categoria VARCHAR(60) NOT NULL,
  marca VARCHAR(80) DEFAULT NULL,
  unidad VARCHAR(40) NOT NULL DEFAULT 'Unidad',
  sale_mode VARCHAR(20) NOT NULL DEFAULT 'unidad',
  precio_compra DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  precio_venta DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  stock DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  stock_min DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  estado VARCHAR(20) NOT NULL DEFAULT 'Activo',
  image_url LONGTEXT DEFAULT NULL,
  image_local VARCHAR(255) DEFAULT NULL,
  product_type VARCHAR(30) NOT NULL DEFAULT 'general',
  size_options LONGTEXT DEFAULT NULL,
  dough_options LONGTEXT DEFAULT NULL,
  border_options LONGTEXT DEFAULT NULL,
  extra_options LONGTEXT DEFAULT NULL,
  allow_half_and_half TINYINT(1) NOT NULL DEFAULT 0,
  is_combo TINYINT(1) NOT NULL DEFAULT 0,
  aplica_itbis TINYINT(1) NOT NULL DEFAULT 0,
  preparation_time_minutes INT NOT NULL DEFAULT 15,
  business_metadata LONGTEXT DEFAULT NULL,
  tracks_stock TINYINT(1) NOT NULL DEFAULT 1,
  KEY idx_products_categoria (categoria),
  KEY idx_products_estado (estado)
);

CREATE TABLE clients (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(160) NOT NULL,
  telefono VARCHAR(40) DEFAULT NULL,
  email VARCHAR(160) DEFAULT NULL,
  direccion VARCHAR(255) DEFAULT NULL,
  cedula VARCHAR(40) DEFAULT NULL,
  reference_note VARCHAR(255) DEFAULT NULL,
  location_link VARCHAR(500) DEFAULT NULL,
  latitude DECIMAL(10,7) DEFAULT NULL,
  longitude DECIMAL(10,7) DEFAULT NULL,
  limite_credito DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  balance DECIMAL(12,2) NOT NULL DEFAULT 0.00
);

CREATE TABLE suppliers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(160) NOT NULL,
  empresa VARCHAR(160) DEFAULT NULL,
  telefono VARCHAR(40) DEFAULT NULL,
  email VARCHAR(160) DEFAULT NULL,
  rnc VARCHAR(40) DEFAULT NULL,
  contacto VARCHAR(120) DEFAULT NULL,
  direccion VARCHAR(255) DEFAULT NULL,
  visit_days VARCHAR(120) DEFAULT NULL,
  payment_terms_days INT NOT NULL DEFAULT 30,
  estado VARCHAR(20) NOT NULL DEFAULT 'Activo',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE supplier_invoices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  supplier_id INT NOT NULL,
  invoice_number VARCHAR(60) NOT NULL,
  issued_at DATE NOT NULL,
  due_at DATE DEFAULT NULL,
  total_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  paid_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  pending_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  status VARCHAR(20) NOT NULL DEFAULT 'Pendiente',
  notes VARCHAR(255) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_supplier_invoices_supplier (supplier_id),
  CONSTRAINT fk_supplier_invoices_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
);

CREATE TABLE inventory_by_branch (
  id INT AUTO_INCREMENT PRIMARY KEY,
  branch_id INT NOT NULL,
  product_id INT NOT NULL,
  stock DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  stock_min DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_inventory_by_branch (branch_id, product_id),
  KEY idx_inventory_by_branch_product (product_id),
  CONSTRAINT fk_inventory_by_branch_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE,
  CONSTRAINT fk_inventory_by_branch_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE cash_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  branch_id INT DEFAULT NULL,
  cash_register_id INT DEFAULT NULL,
  opened_by_user_id INT DEFAULT NULL,
  opened_by_user_name VARCHAR(120) DEFAULT NULL,
  opened_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  current_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  expected_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  counted_amount DECIMAL(12,2) DEFAULT NULL,
  difference_amount DECIMAL(12,2) DEFAULT NULL,
  closed_amount DECIMAL(12,2) DEFAULT NULL,
  opened_at DATETIME NOT NULL,
  closed_at DATETIME DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  KEY idx_cash_sessions_register_status (cash_register_id, status),
  KEY idx_cash_sessions_branch (branch_id),
  CONSTRAINT fk_cash_sessions_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL,
  CONSTRAINT fk_cash_sessions_register FOREIGN KEY (cash_register_id) REFERENCES cash_registers(id) ON DELETE SET NULL,
  CONSTRAINT fk_cash_sessions_user FOREIGN KEY (opened_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE cash_movements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT DEFAULT NULL,
  branch_id INT DEFAULT NULL,
  cash_register_id INT DEFAULT NULL,
  movement_type VARCHAR(40) NOT NULL,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  notes VARCHAR(255) DEFAULT NULL,
  created_by_user_id INT DEFAULT NULL,
  created_by_user_name VARCHAR(120) DEFAULT NULL,
  happened_at DATETIME NOT NULL,
  KEY idx_cash_movements_session (session_id),
  KEY idx_cash_movements_register (cash_register_id),
  CONSTRAINT fk_cash_movements_session FOREIGN KEY (session_id) REFERENCES cash_sessions(id) ON DELETE SET NULL,
  CONSTRAINT fk_cash_movements_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL,
  CONSTRAINT fk_cash_movements_register FOREIGN KEY (cash_register_id) REFERENCES cash_registers(id) ON DELETE SET NULL,
  CONSTRAINT fk_cash_movements_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE cash_openings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cash_session_id INT NOT NULL,
  branch_id INT NOT NULL,
  cash_register_id INT NOT NULL,
  opened_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  notes VARCHAR(255) DEFAULT NULL,
  opened_by_user_id INT DEFAULT NULL,
  opened_by_user_name VARCHAR(120) DEFAULT NULL,
  opened_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_cash_openings_session (cash_session_id),
  CONSTRAINT fk_cash_openings_session FOREIGN KEY (cash_session_id) REFERENCES cash_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_cash_openings_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE,
  CONSTRAINT fk_cash_openings_register FOREIGN KEY (cash_register_id) REFERENCES cash_registers(id) ON DELETE CASCADE,
  CONSTRAINT fk_cash_openings_user FOREIGN KEY (opened_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE cash_closings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cash_session_id INT NOT NULL,
  branch_id INT NOT NULL,
  cash_register_id INT NOT NULL,
  expected_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  counted_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  difference_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  notes VARCHAR(255) DEFAULT NULL,
  closed_by_user_id INT DEFAULT NULL,
  closed_by_user_name VARCHAR(120) DEFAULT NULL,
  closed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_cash_closings_session (cash_session_id),
  CONSTRAINT fk_cash_closings_session FOREIGN KEY (cash_session_id) REFERENCES cash_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_cash_closings_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE,
  CONSTRAINT fk_cash_closings_register FOREIGN KEY (cash_register_id) REFERENCES cash_registers(id) ON DELETE CASCADE,
  CONSTRAINT fk_cash_closings_user FOREIGN KEY (closed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE sales (
  id INT AUTO_INCREMENT PRIMARY KEY,
  invoice_number VARCHAR(40) NOT NULL UNIQUE,
  user_id INT NOT NULL,
  client_id INT DEFAULT NULL,
  branch_id INT DEFAULT NULL,
  cash_register_id INT DEFAULT NULL,
  billed_branch_id INT DEFAULT NULL,
  billed_cash_register_id INT DEFAULT NULL,
  billed_by_user_id INT DEFAULT NULL,
  charged_branch_id INT DEFAULT NULL,
  charged_cash_register_id INT DEFAULT NULL,
  charged_by_user_id INT DEFAULT NULL,
  inventory_branch_id INT DEFAULT NULL,
  document_type VARCHAR(30) NOT NULL DEFAULT 'ticket',
  sale_status VARCHAR(20) NOT NULL DEFAULT 'pagada',
  sale_mode VARCHAR(30) NOT NULL DEFAULT 'directa',
  client_name_snapshot VARCHAR(160) DEFAULT NULL,
  client_phone_snapshot VARCHAR(40) DEFAULT NULL,
  client_tax_id_snapshot VARCHAR(40) DEFAULT NULL,
  payment_method VARCHAR(20) NOT NULL,
  subtotal DECIMAL(12,2) NOT NULL,
  discount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  tax DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  total DECIMAL(12,2) NOT NULL,
  received_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  change_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  fiscal_status VARCHAR(30) NOT NULL DEFAULT 'emitida',
  fiscal_payload LONGTEXT DEFAULT NULL,
  order_type VARCHAR(30) NOT NULL DEFAULT 'mostrador',
  kitchen_status VARCHAR(30) NOT NULL DEFAULT 'pendiente',
  delivery_user_id INT DEFAULT NULL,
  delivery_name_snapshot VARCHAR(160) DEFAULT NULL,
  delivery_email_snapshot VARCHAR(160) DEFAULT NULL,
  delivery_phone_snapshot VARCHAR(40) DEFAULT NULL,
  delivery_address_snapshot VARCHAR(255) DEFAULT NULL,
  delivery_reference_snapshot VARCHAR(255) DEFAULT NULL,
  delivery_location_link_snapshot VARCHAR(500) DEFAULT NULL,
  delivery_cash_status VARCHAR(20) NOT NULL DEFAULT 'na',
  delivery_cash_received_at DATETIME DEFAULT NULL,
  delivery_cash_received_by_user_id INT DEFAULT NULL,
  delivery_cash_received_by_user_name VARCHAR(120) DEFAULT NULL,
  table_label VARCHAR(40) DEFAULT NULL,
  order_notes TEXT DEFAULT NULL,
  canceled_at DATETIME DEFAULT NULL,
  canceled_by_user_id INT DEFAULT NULL,
  canceled_by_user_name VARCHAR(120) DEFAULT NULL,
  cancel_reason VARCHAR(255) DEFAULT NULL,
  charged_at DATETIME DEFAULT NULL,
  inventory_discounted_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_sales_branch (branch_id),
  KEY idx_sales_cash_register (cash_register_id),
  KEY idx_sales_status (sale_status),
  KEY idx_sales_mode (sale_mode),
  KEY idx_sales_inventory_branch (inventory_branch_id),
  KEY idx_sales_created_at (created_at),
  CONSTRAINT fk_sales_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_sales_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
  CONSTRAINT fk_sales_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL,
  CONSTRAINT fk_sales_cash_register FOREIGN KEY (cash_register_id) REFERENCES cash_registers(id) ON DELETE SET NULL,
  CONSTRAINT fk_sales_billed_branch FOREIGN KEY (billed_branch_id) REFERENCES branches(id) ON DELETE SET NULL,
  CONSTRAINT fk_sales_billed_cash_register FOREIGN KEY (billed_cash_register_id) REFERENCES cash_registers(id) ON DELETE SET NULL,
  CONSTRAINT fk_sales_billed_user FOREIGN KEY (billed_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_sales_charged_branch FOREIGN KEY (charged_branch_id) REFERENCES branches(id) ON DELETE SET NULL,
  CONSTRAINT fk_sales_charged_cash_register FOREIGN KEY (charged_cash_register_id) REFERENCES cash_registers(id) ON DELETE SET NULL,
  CONSTRAINT fk_sales_charged_user FOREIGN KEY (charged_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_sales_inventory_branch FOREIGN KEY (inventory_branch_id) REFERENCES branches(id) ON DELETE SET NULL,
  CONSTRAINT fk_sales_delivery_user FOREIGN KEY (delivery_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_sales_delivery_cash_user FOREIGN KEY (delivery_cash_received_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_sales_cancel_user FOREIGN KEY (canceled_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE sale_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sale_id INT NOT NULL,
  product_id INT NOT NULL,
  qty DECIMAL(10,2) NOT NULL,
  price DECIMAL(12,2) NOT NULL,
  discount_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  sale_mode VARCHAR(20) NOT NULL DEFAULT 'unidad',
  unit_label VARCHAR(40) DEFAULT NULL,
  weight_unit VARCHAR(10) DEFAULT NULL,
  scale_weight DECIMAL(12,2) DEFAULT NULL,
  scale_measured_value DECIMAL(12,2) DEFAULT NULL,
  scale_measured_unit VARCHAR(10) DEFAULT NULL,
  scale_source VARCHAR(20) DEFAULT NULL,
  scale_raw_reading VARCHAR(255) DEFAULT NULL,
  line_total DECIMAL(12,2) NOT NULL,
  KEY idx_sale_items_sale (sale_id),
  KEY idx_sale_items_product (product_id),
  CONSTRAINT fk_sale_items_sale FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
  CONSTRAINT fk_sale_items_product FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE inventory_movements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  branch_id INT DEFAULT NULL,
  source_branch_id INT DEFAULT NULL,
  destination_branch_id INT DEFAULT NULL,
  cash_register_id INT DEFAULT NULL,
  sale_id INT DEFAULT NULL,
  transfer_id INT DEFAULT NULL,
  movement_type VARCHAR(30) NOT NULL,
  quantity_change DECIMAL(10,2) NOT NULL,
  previous_stock DECIMAL(10,2) NOT NULL DEFAULT 0,
  new_stock DECIMAL(10,2) NOT NULL DEFAULT 0,
  unit_cost DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  reference_type VARCHAR(30) DEFAULT NULL,
  reference_id VARCHAR(80) DEFAULT NULL,
  notes VARCHAR(255) DEFAULT NULL,
  created_by_user_id INT DEFAULT NULL,
  created_by_user_name VARCHAR(120) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_inventory_movements_product (product_id),
  KEY idx_inventory_movements_branch (branch_id),
  KEY idx_inventory_movements_transfer (transfer_id),
  KEY idx_inventory_movements_sale (sale_id),
  CONSTRAINT fk_inventory_movements_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_inventory_movements_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL,
  CONSTRAINT fk_inventory_movements_source_branch FOREIGN KEY (source_branch_id) REFERENCES branches(id) ON DELETE SET NULL,
  CONSTRAINT fk_inventory_movements_destination_branch FOREIGN KEY (destination_branch_id) REFERENCES branches(id) ON DELETE SET NULL,
  CONSTRAINT fk_inventory_movements_cash_register FOREIGN KEY (cash_register_id) REFERENCES cash_registers(id) ON DELETE SET NULL,
  CONSTRAINT fk_inventory_movements_sale FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL,
  CONSTRAINT fk_inventory_movements_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE branch_transfers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  from_branch_id INT NOT NULL,
  to_branch_id INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'completada',
  notes VARCHAR(255) DEFAULT NULL,
  created_by_user_id INT DEFAULT NULL,
  created_by_user_name VARCHAR(120) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_branch_transfers_from_branch (from_branch_id),
  KEY idx_branch_transfers_to_branch (to_branch_id),
  CONSTRAINT fk_branch_transfers_from_branch FOREIGN KEY (from_branch_id) REFERENCES branches(id) ON DELETE CASCADE,
  CONSTRAINT fk_branch_transfers_to_branch FOREIGN KEY (to_branch_id) REFERENCES branches(id) ON DELETE CASCADE,
  CONSTRAINT fk_branch_transfers_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE branch_transfer_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  transfer_id INT NOT NULL,
  product_id INT NOT NULL,
  qty DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  unit_cost DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  notes VARCHAR(255) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_branch_transfer_items_transfer (transfer_id),
  KEY idx_branch_transfer_items_product (product_id),
  CONSTRAINT fk_branch_transfer_items_transfer FOREIGN KEY (transfer_id) REFERENCES branch_transfers(id) ON DELETE CASCADE,
  CONSTRAINT fk_branch_transfer_items_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE audit_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT DEFAULT NULL,
  user_name VARCHAR(120) NOT NULL,
  user_role VARCHAR(40) NOT NULL,
  module_name VARCHAR(60) NOT NULL,
  action_name VARCHAR(120) NOT NULL,
  detail TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_logs_created_at (created_at),
  CONSTRAINT fk_audit_logs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE mobile_sessions (
  id VARCHAR(40) PRIMARY KEY,
  device_id VARCHAR(120) NOT NULL,
  device_name VARCHAR(160) NOT NULL,
  user_id INT NULL,
  user_name VARCHAR(160) NULL,
  user_role VARCHAR(80) NULL,
  current_latitude DECIMAL(10,7) NULL,
  current_longitude DECIMAL(10,7) NULL,
  location_accuracy_meters DECIMAL(10,2) NULL,
  last_location_at DATETIME NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_mobile_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE mobile_session_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(40) NOT NULL,
  product_id INT NOT NULL,
  qty DECIMAL(10,2) NOT NULL DEFAULT 1,
  line_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY idx_mobile_session_product (session_id, product_id),
  CONSTRAINT fk_mobile_session_items_session FOREIGN KEY (session_id) REFERENCES mobile_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_mobile_session_items_product FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE dining_tables (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(40) NOT NULL UNIQUE,
  capacidad INT NOT NULL DEFAULT 4,
  estado VARCHAR(20) NOT NULL DEFAULT 'Libre',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE delivery_locations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(40) DEFAULT NULL,
  user_id INT DEFAULT NULL,
  user_name VARCHAR(160) DEFAULT NULL,
  latitude DECIMAL(10,7) NOT NULL,
  longitude DECIMAL(10,7) NOT NULL,
  accuracy_meters DECIMAL(10,2) DEFAULT NULL,
  source VARCHAR(40) NOT NULL DEFAULT 'mobile',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_delivery_locations_session FOREIGN KEY (session_id) REFERENCES mobile_sessions(id) ON DELETE SET NULL,
  CONSTRAINT fk_delivery_locations_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE suspended_sales (
  id VARCHAR(40) PRIMARY KEY,
  sale_name VARCHAR(160) NOT NULL,
  draft_payload LONGTEXT NOT NULL,
  total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  item_count INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE quotations (
  id VARCHAR(40) PRIMARY KEY,
  quotation_name VARCHAR(160) NOT NULL,
  client_name VARCHAR(160) DEFAULT NULL,
  draft_payload LONGTEXT NOT NULL,
  total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  item_count INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLAS OFFLINE-FIRST PARA MULTICAJA/MULTISUCURSAL
-- ═══════════════════════════════════════════════════════════════════════════

-- Terminal secundaria: estado de conexión y caché
CREATE TABLE offline_terminal_cache (
  id INT PRIMARY KEY DEFAULT 1,
  terminal_id VARCHAR(40) NOT NULL UNIQUE,
  principal_host VARCHAR(255) NOT NULL,
  principal_base_url VARCHAR(500) NOT NULL,
  branch_id INT NOT NULL,
  branch_name VARCHAR(160) DEFAULT NULL,
  cash_register_id INT NOT NULL,
  cash_register_name VARCHAR(120) DEFAULT NULL,
  is_online TINYINT(1) NOT NULL DEFAULT 1,
  sync_status VARCHAR(20) NOT NULL DEFAULT 'online',
  last_full_sync DATETIME DEFAULT NULL,
  last_health_check DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_terminal_id (terminal_id),
  KEY idx_sync_status (sync_status)
);

-- Caché local de productos
CREATE TABLE offline_cache_products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL UNIQUE,
  codigo VARCHAR(40) NOT NULL,
  nombre VARCHAR(160) NOT NULL,
  categoria VARCHAR(60) DEFAULT NULL,
  precio_venta DECIMAL(12,2) NOT NULL,
  stock_cached DECIMAL(12,2) NOT NULL DEFAULT 0,
  stock_min DECIMAL(12,2) NOT NULL DEFAULT 0,
  estado VARCHAR(20) NOT NULL DEFAULT 'Activo',
  last_updated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_producto_id (product_id),
  KEY idx_codigo (codigo)
);

-- Caché local de clientes
CREATE TABLE offline_cache_clients (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id INT NOT NULL UNIQUE,
  nombre VARCHAR(160) NOT NULL,
  cedula VARCHAR(40) DEFAULT NULL,
  telefono VARCHAR(40) DEFAULT NULL,
  email VARCHAR(160) DEFAULT NULL,
  direccion VARCHAR(255) DEFAULT NULL,
  limite_credito DECIMAL(12,2) NOT NULL DEFAULT 0,
  balance DECIMAL(12,2) NOT NULL DEFAULT 0,
  last_updated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_client_id (client_id),
  KEY idx_cedula (cedula)
);

-- Caché local de usuarios autorizados
CREATE TABLE offline_cache_users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL UNIQUE,
  usuario VARCHAR(60) NOT NULL,
  nombre VARCHAR(160) NOT NULL,
  rol VARCHAR(30) NOT NULL,
  password_hash VARCHAR(255) DEFAULT NULL,
  puede_vender TINYINT(1) NOT NULL DEFAULT 0,
  puede_cobrar TINYINT(1) NOT NULL DEFAULT 0,
  puede_ver_reportes TINYINT(1) NOT NULL DEFAULT 0,
  last_updated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_user_id (user_id),
  KEY idx_usuario (usuario)
);

-- Caché local de configuración
CREATE TABLE offline_cache_config (
  id INT AUTO_INCREMENT PRIMARY KEY,
  config_key VARCHAR(100) NOT NULL UNIQUE,
  config_value TEXT DEFAULT NULL,
  last_updated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_config_key (config_key)
);

-- Caché local de métodos de pago
CREATE TABLE offline_cache_payment_methods (
  id INT AUTO_INCREMENT PRIMARY KEY,
  payment_method_id INT NOT NULL UNIQUE,
  codigo VARCHAR(40) NOT NULL,
  nombre VARCHAR(120) NOT NULL,
  last_updated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_method_id (payment_method_id),
  KEY idx_codigo (codigo)
);

-- Ventas realizadas en modo offline
CREATE TABLE pending_sales (
  id VARCHAR(80) PRIMARY KEY,
  terminal_id VARCHAR(40) NOT NULL,
  offline_invoice_id VARCHAR(80) NOT NULL UNIQUE,
  branch_id INT NOT NULL,
  cash_register_id INT NOT NULL,
  user_id INT NOT NULL,
  client_id INT DEFAULT NULL,
  sale_data LONGTEXT NOT NULL COMMENT 'JSON serializado de venta completa',
  total DECIMAL(12,2) NOT NULL DEFAULT 0,
  payment_method VARCHAR(30) DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending/syncing/synced/error',
  error_message VARCHAR(500) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synced_at DATETIME DEFAULT NULL,
  KEY idx_terminal_id (terminal_id),
  KEY idx_status (status),
  KEY idx_offline_invoice_id (offline_invoice_id),
  KEY idx_created_at (created_at)
);

-- Items de ventas offline
CREATE TABLE pending_sale_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  pending_sale_id VARCHAR(80) NOT NULL,
  item_sequence INT NOT NULL,
  product_id INT NOT NULL,
  item_data LONGTEXT NOT NULL COMMENT 'JSON serializado del item',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pending_sale_id (pending_sale_id),
  FOREIGN KEY (pending_sale_id) REFERENCES pending_sales(id) ON DELETE CASCADE
);

-- Movimientos de caja en modo offline
CREATE TABLE pending_cash_movements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  terminal_id VARCHAR(40) NOT NULL,
  movement_type VARCHAR(40) NOT NULL COMMENT 'venta_offline/cobro_pendiente_offline/movimiento_manual',
  amount DECIMAL(12,2) NOT NULL,
  notes VARCHAR(255) DEFAULT NULL,
  reference_sale_id VARCHAR(80) DEFAULT NULL,
  reference_client_id INT DEFAULT NULL,
  reference_payment_id VARCHAR(80) DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending/synced/error',
  error_message VARCHAR(500) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synced_at DATETIME DEFAULT NULL,
  KEY idx_terminal_id (terminal_id),
  KEY idx_status (status),
  KEY idx_movement_type (movement_type),
  KEY idx_created_at (created_at)
);

-- Histórico de sincronizaciones
CREATE TABLE sync_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  terminal_id VARCHAR(40) NOT NULL,
  sync_phase VARCHAR(30) NOT NULL COMMENT 'upload/download/confirm/full',
  items_uploaded INT NOT NULL DEFAULT 0,
  items_downloaded INT NOT NULL DEFAULT 0,
  error_count INT NOT NULL DEFAULT 0,
  started_at DATETIME NOT NULL,
  completed_at DATETIME DEFAULT NULL,
  result VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'ok/partial/error',
  error_detail VARCHAR(500) DEFAULT NULL,
  KEY idx_terminal_id (terminal_id),
  KEY idx_started_at (started_at),
  KEY idx_result (result)
);

-- Mapeo de IDs offline a reales (para evitar duplicados)
CREATE TABLE offline_sync_map (
  id INT AUTO_INCREMENT PRIMARY KEY,
  offline_id VARCHAR(80) NOT NULL UNIQUE,
  real_invoice_id VARCHAR(40) DEFAULT NULL,
  terminal_id VARCHAR(40) NOT NULL,
  branch_id INT NOT NULL,
  cash_register_id INT NOT NULL,
  synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_offline_id (offline_id),
  KEY idx_terminal_id (terminal_id),
  KEY idx_synced_at (synced_at)
);

INSERT INTO businesses (id, nombre, rnc, direccion, telefono, estado)
VALUES (1, 'Tecno Caja', '', '', '', 'Activo');

INSERT INTO branches (id, business_id, nombre, codigo, direccion, telefono, encargado, estado)
VALUES (1, 1, 'Sucursal Principal', 'PRINCIPAL', '', '', 'Administrador', 'Activa');

INSERT INTO cash_registers (id, branch_id, nombre, codigo, estado)
VALUES (1, 1, 'Caja Principal', 'CAJA-01', 'Activa');

INSERT INTO roles (id, codigo, nombre, permisos, estado) VALUES
(1, 'administrador_general', 'Administrador general', '["*"]', 'Activo'),
(2, 'administrador_sucursal', 'Administrador de sucursal', '["dashboard_sucursal","ver_dashboard_sucursal","caja","cajas","ver_cajas_sucursal","crear_cajas_sucursal","editar_cajas_sucursal","activar_cajas_sucursal","asignar_cajeros_sucursal","usuarios","usuarios_crear","usuarios_editar","ver_usuarios_sucursal","crear_cajeros_sucursal","crear_supervisores_sucursal","editar_usuarios_sucursal","activar_usuarios_sucursal","resetear_password_usuarios_sucursal","ventas","ver_ventas_sucursal","ver_cierres_caja_sucursal","ver_aperturas_caja_sucursal","reportes_sucursal","ver_reportes_sucursal","inventario","ver_inventario_sucursal","registrar_movimientos_internos_sucursal","ver_productos_sucursal","consultar_stock_sucursal","ver_arqueos_caja_sucursal","ver_historial_inventario_sucursal"]', 'Activo'),
(3, 'cajero', 'Cajero', '["ventas","caja","clientes","abrir_caja","cerrar_caja","hacer_corte_caja","abrir_gaveta"]', 'Activo'),
(4, 'supervisor', 'Supervisor', '["ventas","caja","reportes_sucursal","inventario","abrir_caja","cerrar_caja","hacer_corte_caja","abrir_gaveta","anular_ventas","devolver_ventas","ver_reportes_caja","ver_cierres_caja","ver_ganancias"]', 'Activo'),
(5, 'repartidor', 'Repartidor (Delivery)', '[]', 'Activo');

INSERT INTO payment_methods (id, codigo, nombre, estado) VALUES
(1, 'efectivo', 'Efectivo', 'Activo'),
(2, 'tarjeta', 'Tarjeta', 'Activo'),
(3, 'transferencia', 'Transferencia', 'Activo'),
(4, 'credito', 'Crédito', 'Activo'),
(5, 'contra_entrega', 'Contra entrega', 'Activo');

INSERT INTO config (
  id, business_id, active_branch_id, active_cash_register_id, business_name, rnc, address, phone, currency, tax_rate,
  invoice_prefix, invoice_next_number, e_invoice_enabled, e_invoice_prefix, e_invoice_next_number, receipt_message,
  receipt_print_mode, receipt_printer_name, receipt_paper_size,
  cash_drawer_enabled, cash_drawer_method, cash_drawer_printer_name, cash_drawer_pin, cash_drawer_network_host, cash_drawer_network_port, cash_drawer_serial_port,
  scale_type, scale_serial_port, scale_serial_baud_rate, scale_default_unit, scale_read_pattern, scale_rounding_decimals, scale_auto_read,
  whatsapp_web_enabled, whatsapp_paste_guide_enabled,
  app_logo, security_password, language, business_type, setup_completed, license_status, require_cash_open_before_use,
  business_structure_mode, sales_operation_mode, starter_catalog_seeded, cash_open, cash_amount,
  cashier_register_required, exclusive_cashier_per_register
) VALUES (
  1, 1, 1, 1, 'Tecno Caja', '', '', '', 'RD$', 18.00,
  'FAC-', 1001, 1, 'ECF-', 1, '¡Gracias por su compra!',
  'dialog', NULL, '80mm', 0, 'escpos', NULL, 0, NULL, 9100, 'COM1', 'none', NULL, 9600, 'kg', NULL, 2, 1, 0, 1,
  NULL, '6888939502182025', 'es', 'pizzeria', 0, 'trial', 1,
  'monocaja', 'directa', 1, 0, 0.00, 1, 1
);
