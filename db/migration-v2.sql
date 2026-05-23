-- ============================================================
-- Tecno Caja v2.0 — Migración de arquitectura híbrida
-- Ejecutar sobre base de datos existente. No rompe nada.
-- Todas las sentencias usan IF NOT EXISTS / IF EXISTS.
-- ============================================================

-- 1. Tipo de caja para multicaja flexible
ALTER TABLE cash_registers
  ADD COLUMN IF NOT EXISTS register_type VARCHAR(30) NOT NULL DEFAULT 'mixta'
    COMMENT 'facturacion | cobro | mixta | centralizadora';

ALTER TABLE cash_registers
  ADD COLUMN IF NOT EXISTS can_invoice TINYINT(1) NOT NULL DEFAULT 1;

ALTER TABLE cash_registers
  ADD COLUMN IF NOT EXISTS can_charge TINYINT(1) NOT NULL DEFAULT 1;

-- 2. Permiso de autorizar instalación en usuarios
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS puede_autorizar_instalacion TINYINT(1) NOT NULL DEFAULT 0;

-- 3. Sincronización en ventas
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS sync_id VARCHAR(64) DEFAULT NULL
    COMMENT 'UUID global único para deduplicación en sync';

-- 3.1 Configuración tributaria por desglose
ALTER TABLE config
  ADD COLUMN IF NOT EXISTS tax_calculate_at_invoice_end TINYINT(1) NOT NULL DEFAULT 1;

ALTER TABLE config
  ADD COLUMN IF NOT EXISTS tax_include_in_product_price TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE config
  ADD COLUMN IF NOT EXISTS tax_show_breakdown_on_receipts TINYINT(1) NOT NULL DEFAULT 1;

ALTER TABLE config
  ADD COLUMN IF NOT EXISTS tax_separate_taxable_and_exempt TINYINT(1) NOT NULL DEFAULT 1;

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS sync_status VARCHAR(20) NOT NULL DEFAULT 'local'
    COMMENT 'local | pending | synced | conflict';

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS synced_at DATETIME DEFAULT NULL;

-- Añadir estado extendido de venta (la columna sale_status ya existe, expandir valores vía app)
-- Estados: borrador | facturada | pendiente_cobro | cobrada | anulada

-- 4. Login offline — usuarios locales cacheados
CREATE TABLE IF NOT EXISTS local_users (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT NOT NULL,
  usuario         VARCHAR(60) NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  nombre          VARCHAR(120) NOT NULL,
  rol             VARCHAR(40) NOT NULL,
  permisos        TEXT DEFAULT NULL,
  branch_id       INT DEFAULT NULL,
  cash_register_id INT DEFAULT NULL,
  estado          VARCHAR(20) NOT NULL DEFAULT 'Activo',
  synced_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at      DATETIME DEFAULT NULL,
  UNIQUE KEY uq_local_users_usuario (usuario),
  KEY idx_local_users_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5. Sesiones activas
CREATE TABLE IF NOT EXISTS active_sessions (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT NOT NULL,
  session_token   VARCHAR(255) NOT NULL,
  device_id       VARCHAR(120) DEFAULT NULL,
  ip_address      VARCHAR(60) DEFAULT NULL,
  user_agent      TEXT DEFAULT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at      DATETIME NOT NULL,
  last_seen_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_offline      TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE KEY uq_sessions_token (session_token),
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 6. Intentos de login (rate limiting)
CREATE TABLE IF NOT EXISTS login_attempts (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  usuario       VARCHAR(60) NOT NULL,
  ip_address    VARCHAR(60) DEFAULT NULL,
  success       TINYINT(1) NOT NULL DEFAULT 0,
  attempted_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_attempts_usuario_at (usuario, attempted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 7. Cola de sincronización local → central
CREATE TABLE IF NOT EXISTS sync_queue (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  sync_id       VARCHAR(64) NOT NULL UNIQUE,
  table_name    VARCHAR(60) NOT NULL,
  record_id     INT NOT NULL,
  operation     VARCHAR(20) NOT NULL DEFAULT 'upsert',
  payload       LONGTEXT NOT NULL,
  priority      INT NOT NULL DEFAULT 5,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts      INT NOT NULL DEFAULT 0,
  last_error    TEXT DEFAULT NULL,
  last_attempt_at DATETIME DEFAULT NULL,
  synced_at     DATETIME DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_sync_queue_status (status),
  KEY idx_sync_queue_priority (priority, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 8. Log de sesiones de sincronización
CREATE TABLE IF NOT EXISTS sync_logs (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  session_id          VARCHAR(64) DEFAULT NULL,
  direction           VARCHAR(20) NOT NULL DEFAULT 'push',
  table_name          VARCHAR(60) DEFAULT NULL,
  records_processed   INT NOT NULL DEFAULT 0,
  records_success     INT NOT NULL DEFAULT 0,
  records_failed      INT NOT NULL DEFAULT 0,
  started_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at         DATETIME DEFAULT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'running',
  error_detail        TEXT DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 9. Configuración de instalación por terminal
CREATE TABLE IF NOT EXISTS installation_config (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  config_key  VARCHAR(100) NOT NULL UNIQUE,
  config_value TEXT,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 10. Acceso usuario → sucursal
CREATE TABLE IF NOT EXISTS user_branch_access (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  branch_id   INT NOT NULL,
  access_type VARCHAR(30) NOT NULL DEFAULT 'operador',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_branch (user_id, branch_id),
  KEY idx_uba_user (user_id),
  KEY idx_uba_branch (branch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 11. Acceso usuario → caja
CREATE TABLE IF NOT EXISTS user_cash_register_access (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT NOT NULL,
  cash_register_id INT NOT NULL,
  access_type     VARCHAR(30) NOT NULL DEFAULT 'operador',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_register (user_id, cash_register_id),
  KEY idx_ucra_user (user_id),
  KEY idx_ucra_register (cash_register_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 12. Índice de sync_id en sales (para deduplicación rápida)
CREATE INDEX IF NOT EXISTS idx_sales_sync_id ON sales (sync_id);
CREATE INDEX IF NOT EXISTS idx_sales_sync_status ON sales (sync_status);

-- ============================================================
-- Datos iniciales para installation_config
-- ============================================================
INSERT IGNORE INTO installation_config (config_key, config_value) VALUES
  ('schema_version', '2.0'),
  ('migration_date', NOW()),
  ('hybrid_mode_enabled', '0'),
  ('sync_enabled', '0'),
  ('offline_login_enabled', '1');
