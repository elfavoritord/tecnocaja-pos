-- ═══════════════════════════════════════════════════════════════
-- Migración 001: Sistema Multiempresa — Contadores + Licencias
-- Aplicar en instancias existentes (fresh install usa schema.sql)
-- ═══════════════════════════════════════════════════════════════

-- 1. Extender tabla config con campos de plataforma
ALTER TABLE config
  ADD COLUMN IF NOT EXISTS business_mode VARCHAR(30) NOT NULL DEFAULT 'independent' COMMENT 'independent | accountant_client',
  ADD COLUMN IF NOT EXISTS cloud_business_id VARCHAR(64) DEFAULT NULL COMMENT 'ID en cloud_businesses',
  ADD COLUMN IF NOT EXISTS accountant_id INT DEFAULT NULL COMMENT 'FK a contadores.id',
  ADD COLUMN IF NOT EXISTS accountant_name VARCHAR(200) DEFAULT NULL COMMENT 'Nombre cached del contador';

-- 2. Nuevos roles: superadmin y contador_asociado
INSERT IGNORE INTO roles (id, codigo, nombre, permisos, estado) VALUES
(6, 'superadmin', 'Super Administrador', '["*"]', 'Activo'),
(7, 'contador_asociado', 'Contador Asociado', '["contador.ver_clientes","contador.registrar_negocio","contador.ver_reportes","contador.config","contador.solicitudes"]', 'Activo');

-- 3. Tabla de Contadores Asociados
CREATE TABLE IF NOT EXISTS contadores (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL UNIQUE COMMENT 'FK a users.id',
  nombre_firma VARCHAR(200) NOT NULL,
  responsable VARCHAR(150) DEFAULT NULL,
  rnc VARCHAR(40) DEFAULT NULL,
  telefono VARCHAR(40) DEFAULT NULL,
  whatsapp VARCHAR(40) DEFAULT NULL,
  correo VARCHAR(160) DEFAULT NULL,
  direccion VARCHAR(255) DEFAULT NULL,
  logo_url TEXT DEFAULT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'activo',
  datos_fiscales LONGTEXT DEFAULT NULL COMMENT 'JSON config fiscal e-CF',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_contadores_estado (estado),
  CONSTRAINT fk_contadores_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 4. Negocios registrados en la plataforma
CREATE TABLE IF NOT EXISTS cloud_businesses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cloud_id VARCHAR(64) NOT NULL UNIQUE COMMENT 'UUID generado en código',
  nombre_negocio VARCHAR(200) NOT NULL,
  rnc VARCHAR(40) DEFAULT NULL,
  propietario VARCHAR(150) DEFAULT NULL,
  telefono VARCHAR(40) DEFAULT NULL,
  correo VARCHAR(160) DEFAULT NULL,
  contador_id INT DEFAULT NULL,
  plan VARCHAR(30) NOT NULL DEFAULT 'basico' COMMENT 'basico | pro | plus',
  license_status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'trial|pending|active|expired|suspended|cancelled',
  trial_start_date DATETIME DEFAULT NULL,
  trial_end_date DATETIME DEFAULT NULL,
  license_activated_at DATETIME DEFAULT NULL,
  license_expires_at DATETIME DEFAULT NULL,
  license_notes TEXT DEFAULT NULL,
  last_sync_at DATETIME DEFAULT NULL,
  business_mode VARCHAR(30) NOT NULL DEFAULT 'independent' COMMENT 'independent | accountant_client',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_cloud_businesses_contador (contador_id),
  KEY idx_cloud_businesses_status (license_status),
  CONSTRAINT fk_cloud_businesses_contador FOREIGN KEY (contador_id) REFERENCES contadores(id) ON DELETE SET NULL
);

-- 5. Historial de licencias
CREATE TABLE IF NOT EXISTS licencias (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cloud_business_id INT DEFAULT NULL,
  plan VARCHAR(30) DEFAULT NULL,
  status VARCHAR(20) NOT NULL,
  activated_at DATETIME DEFAULT NULL,
  expires_at DATETIME DEFAULT NULL,
  activated_by VARCHAR(160) DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_licencias_business (cloud_business_id),
  CONSTRAINT fk_licencias_business FOREIGN KEY (cloud_business_id) REFERENCES cloud_businesses(id) ON DELETE CASCADE
);

-- 6. Solicitudes de servicio
CREATE TABLE IF NOT EXISTS solicitudes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cloud_business_id INT DEFAULT NULL,
  contador_id INT DEFAULT NULL,
  tipo VARCHAR(60) NOT NULL COMMENT 'activar_licencia|renovar_licencia|soporte|cambio_plan|reportar_error|solicitar_modulo',
  status VARCHAR(30) NOT NULL DEFAULT 'pendiente' COMMENT 'pendiente|en_revision|aprobado|rechazado|completado',
  descripcion TEXT DEFAULT NULL,
  respuesta TEXT DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_solicitudes_business (cloud_business_id),
  KEY idx_solicitudes_contador (contador_id),
  KEY idx_solicitudes_status (status),
  CONSTRAINT fk_solicitudes_business FOREIGN KEY (cloud_business_id) REFERENCES cloud_businesses(id) ON DELETE SET NULL,
  CONSTRAINT fk_solicitudes_contador FOREIGN KEY (contador_id) REFERENCES contadores(id) ON DELETE SET NULL
);

-- 7. Cola de sincronización global
CREATE TABLE IF NOT EXISTS sync_queue (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entity_type VARCHAR(60) NOT NULL COMMENT 'sale|product|client|config|user|etc',
  entity_id VARCHAR(80) DEFAULT NULL,
  operation VARCHAR(20) NOT NULL COMMENT 'insert|update|delete',
  payload LONGTEXT DEFAULT NULL COMMENT 'JSON del cambio',
  status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending|syncing|synced|failed',
  attempts INT NOT NULL DEFAULT 0,
  last_attempt_at DATETIME DEFAULT NULL,
  error_message TEXT DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_sync_queue_status (status),
  KEY idx_sync_queue_entity (entity_type, entity_id),
  KEY idx_sync_queue_created (created_at)
);
