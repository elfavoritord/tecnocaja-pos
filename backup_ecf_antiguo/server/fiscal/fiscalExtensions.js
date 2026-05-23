// ══════════════════════════════════════════════════════════════════════════════
//  fiscalExtensions.js  —  Tecno Caja e-CF / DGII
//  Compatible con SQLite (dev / npm start) y MySQL/MariaDB (npm run desktop).
//  Se llama una vez desde prepareServerRuntime() en server.js.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

function isMySQL() {
  return String(process.env.DB_CLIENT || 'sqlite').trim().toLowerCase() === 'mysql';
}

// En MySQL/MariaDB usamos el tipo nativo; en SQLite todo es compatible con
// INTEGER PRIMARY KEY AUTOINCREMENT + sin ON UPDATE + UNIQUE como constraint.
function pk() {
  return isMySQL()
    ? 'INT AUTO_INCREMENT PRIMARY KEY'
    : 'INTEGER PRIMARY KEY AUTOINCREMENT';
}

function updatedAtCol() {
  return isMySQL()
    ? 'updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
    : 'updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP';
}

function assertSqlIdentifier(name) {
  const normalized = String(name || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
    throw new Error(`Identificador SQL inválido: ${name}`);
  }
  return normalized;
}

function normalizeSqlValue(value) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 19).replace('T', ' ');
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  return value;
}

/**
 * @param {Function} queryFn       — función query de db.js
 * @param {Function} addColFn      — addColumnIfMissing de server.js
 */
async function ensureFiscalExtensions(queryFn, addColFn) {
  // ── 1. fiscal_config ────────────────────────────────────────────────────────
  // UNIQUE (business_id) inline → nuevas instalaciones. El índice CREATE UNIQUE
  // INDEX IF NOT EXISTS lo cubre para instalaciones existentes (ambos motores).
  await queryFn(`
    CREATE TABLE IF NOT EXISTS fiscal_config (
      id               ${pk()},
      business_id      INT NOT NULL DEFAULT 1,
      environment      VARCHAR(20)  NOT NULL DEFAULT 'test',
      is_active        TINYINT(1)   NOT NULL DEFAULT 0,
      status           VARCHAR(40)  NOT NULL DEFAULT 'no_configurado',
      token_encrypted  TEXT         DEFAULT NULL,
      token_expires_at DATETIME     DEFAULT NULL,
      last_conn_status VARCHAR(20)  DEFAULT NULL,
      last_conn_msg    TEXT         DEFAULT NULL,
      activated_at     DATETIME     DEFAULT NULL,
      deactivated_at   DATETIME     DEFAULT NULL,
      created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ${updatedAtCol()},
      UNIQUE (business_id)
    )
  `);
  // Para instalaciones existentes sin UNIQUE ya creado:
  await queryFn(
    'CREATE UNIQUE INDEX IF NOT EXISTS uq_fc_business ON fiscal_config (business_id)'
  ).catch(() => {});

  // ── 2. fiscal_certificate ───────────────────────────────────────────────────
  await queryFn(`
    CREATE TABLE IF NOT EXISTS fiscal_certificate (
      id                      ${pk()},
      business_id             INT NOT NULL DEFAULT 1,
      certificate_encrypted   TEXT DEFAULT NULL,
      password_encrypted      VARCHAR(512) DEFAULT NULL,
      subject                 VARCHAR(255) DEFAULT NULL,
      issuer                  VARCHAR(255) DEFAULT NULL,
      serial_number           VARCHAR(120) DEFAULT NULL,
      valid_from              DATETIME DEFAULT NULL,
      valid_to                DATETIME DEFAULT NULL,
      status                  VARCHAR(30) NOT NULL DEFAULT 'pendiente',
      created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ${updatedAtCol()},
      UNIQUE (business_id)
    )
  `);
  await queryFn(
    'CREATE UNIQUE INDEX IF NOT EXISTS uq_fcert_business ON fiscal_certificate (business_id)'
  ).catch(() => {});

  // ── 3. fiscal_sequences  (e-NCF) ────────────────────────────────────────────
  await queryFn(`
    CREATE TABLE IF NOT EXISTS fiscal_sequences (
      id                   ${pk()},
      business_id          INT NOT NULL DEFAULT 1,
      branch_id            INT DEFAULT NULL,
      cash_register_id     INT DEFAULT NULL,
      tipo_comprobante     VARCHAR(5)  NOT NULL,
      prefijo              VARCHAR(3)  NOT NULL DEFAULT 'E',
      serie                VARCHAR(2)  NOT NULL DEFAULT '31',
      desde                BIGINT NOT NULL DEFAULT 1,
      hasta                BIGINT NOT NULL DEFAULT 9999999999,
      proximo              BIGINT NOT NULL DEFAULT 1,
      fecha_autorizacion   DATE DEFAULT NULL,
      fecha_vencimiento    DATE DEFAULT NULL,
      activo               TINYINT(1) NOT NULL DEFAULT 1,
      created_by           INT DEFAULT NULL,
      created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ${updatedAtCol()}
    )
  `);
  // Migrar INT → BIGINT si la tabla ya existía con el tipo anterior (solo MySQL)
  if (isMySQL()) {
    for (const col of ['desde', 'hasta', 'proximo']) {
      await queryFn(
        `ALTER TABLE fiscal_sequences MODIFY COLUMN \`${col}\` BIGINT NOT NULL DEFAULT ${col === 'hasta' ? 9999999999 : 1}`
      ).catch(() => {});
    }
  }

  // ── 4. ecf_documents ─────────────────────────────────────────────────────────
  await queryFn(`
    CREATE TABLE IF NOT EXISTS ecf_documents (
      id                  ${pk()},
      business_id         INT NOT NULL DEFAULT 1,
      branch_id           INT DEFAULT NULL,
      cash_register_id    INT DEFAULT NULL,
      sale_id             INT DEFAULT NULL,
      customer_id         INT DEFAULT NULL,
      tipo_ecf            VARCHAR(5)  NOT NULL,
      encf                VARCHAR(19) NOT NULL,
      rnc_emisor          VARCHAR(11) DEFAULT NULL,
      rnc_comprador       VARCHAR(11) DEFAULT NULL,
      nombre_comprador    VARCHAR(160) DEFAULT NULL,
      monto_total         DECIMAL(14,2) DEFAULT 0.00,
      itbis_total         DECIMAL(14,2) DEFAULT 0.00,
      fecha_emision       DATETIME DEFAULT NULL,
      fecha_firma         DATETIME DEFAULT NULL,
      codigo_seguridad    VARCHAR(10) DEFAULT NULL,
      qr_url              TEXT DEFAULT NULL,
      xml_path            VARCHAR(500) DEFAULT NULL,
      signed_xml_path     VARCHAR(500) DEFAULT NULL,
      xml_content         TEXT DEFAULT NULL,
      signed_xml_content  TEXT DEFAULT NULL,
      track_id            VARCHAR(100) DEFAULT NULL,
      estado_dgii         VARCHAR(30) NOT NULL DEFAULT 'pendiente',
      mensajes_dgii       TEXT DEFAULT NULL,
      ambiente            VARCHAR(20) NOT NULL DEFAULT 'test',
      is_sent             TINYINT(1) NOT NULL DEFAULT 0,
      retry_count         INT NOT NULL DEFAULT 0,
      last_retry_at       DATETIME DEFAULT NULL,
      encf_referencia     VARCHAR(19) DEFAULT NULL,
      submission_mode     VARCHAR(20) NOT NULL DEFAULT 'ecf',
      created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ${updatedAtCol()}
    )
  `);
  await queryFn(
    'CREATE UNIQUE INDEX IF NOT EXISTS uq_ecf_documents_business_encf ON ecf_documents (business_id, encf)'
  ).catch(() => {});
  await queryFn(
    'CREATE INDEX IF NOT EXISTS idx_ecf_documents_sale ON ecf_documents (sale_id)'
  ).catch(() => {});
  await queryFn(
    'CREATE INDEX IF NOT EXISTS idx_ecf_documents_track ON ecf_documents (track_id)'
  ).catch(() => {});
  await queryFn(
    'CREATE INDEX IF NOT EXISTS idx_ecf_documents_business_status ON ecf_documents (business_id, estado_dgii, created_at)'
  ).catch(() => {});

  // ── 4.1. dgii_company_settings  ────────────────────────────────────────────
  // Snapshot configurable por empresa para la exposición pública del backend
  // e-CF. No guarda secretos en texto plano: el token interno se almacena
  // únicamente como hash SHA-256.
  await queryFn(`
    CREATE TABLE IF NOT EXISTS dgii_company_settings (
      id                           ${pk()},
      business_id                  INT NOT NULL DEFAULT 1,
      branch_id                    INT DEFAULT NULL,
      cash_register_id             INT DEFAULT NULL,
      rnc                          VARCHAR(20) DEFAULT NULL,
      environment                  VARCHAR(20) NOT NULL DEFAULT 'test',
      certificate_mode             VARCHAR(20) NOT NULL DEFAULT 'p12',
      rfce_enabled                 TINYINT(1) NOT NULL DEFAULT 0,
      qscd_provider                VARCHAR(120) DEFAULT NULL,
      qscd_config_json             TEXT DEFAULT NULL,
      public_base_url              VARCHAR(255) DEFAULT NULL,
      recepcion_url                VARCHAR(255) DEFAULT NULL,
      aprobacion_url               VARCHAR(255) DEFAULT NULL,
      semilla_url                  VARCHAR(255) DEFAULT NULL,
      validacion_certificado_url   VARCHAR(255) DEFAULT NULL,
      auth_api_base_url            VARCHAR(255) DEFAULT NULL,
      internal_token_hash          VARCHAR(128) DEFAULT NULL,
      allowed_origins              TEXT DEFAULT NULL,
      require_internal_token       TINYINT(1) NOT NULL DEFAULT 0,
      is_enabled                   TINYINT(1) NOT NULL DEFAULT 1,
      notes                        TEXT DEFAULT NULL,
      last_seed_requested_at       DATETIME DEFAULT NULL,
      last_certificate_check_at    DATETIME DEFAULT NULL,
      created_at                   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ${updatedAtCol()},
      UNIQUE (business_id)
    )
  `);
  await queryFn(
    'CREATE UNIQUE INDEX IF NOT EXISTS uq_dgii_company_business ON dgii_company_settings (business_id)'
  ).catch(() => {});

  // ── 4.1.1 fiscal_test_runs  ───────────────────────────────────────────────
  await queryFn(`
    CREATE TABLE IF NOT EXISTS fiscal_test_runs (
      id                  ${pk()},
      business_id         INT NOT NULL DEFAULT 1,
      test_key            VARCHAR(60) NOT NULL,
      environment         VARCHAR(20) DEFAULT NULL,
      status              VARCHAR(20) NOT NULL DEFAULT 'pending',
      summary             VARCHAR(255) DEFAULT NULL,
      details_json        TEXT DEFAULT NULL,
      created_by          INT DEFAULT NULL,
      source_ip           VARCHAR(45) DEFAULT NULL,
      created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await queryFn(
    'CREATE INDEX IF NOT EXISTS idx_fiscal_test_runs_business_key ON fiscal_test_runs (business_id, test_key, created_at)'
  ).catch(() => {});
  await queryFn(
    'CREATE INDEX IF NOT EXISTS idx_fiscal_test_runs_business_created ON fiscal_test_runs (business_id, created_at)'
  ).catch(() => {});

  // ── 4.1.2 fiscal_manual_checks  ───────────────────────────────────────────
  await queryFn(`
    CREATE TABLE IF NOT EXISTS fiscal_manual_checks (
      id                  ${pk()},
      business_id         INT NOT NULL DEFAULT 1,
      check_key           VARCHAR(60) NOT NULL,
      status              VARCHAR(20) NOT NULL DEFAULT 'pending',
      notes               TEXT DEFAULT NULL,
      updated_by          INT DEFAULT NULL,
      updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (business_id, check_key)
    )
  `);
  await queryFn(
    'CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_manual_checks_business_key ON fiscal_manual_checks (business_id, check_key)'
  ).catch(() => {});

  // ── 4.2. dgii_received_documents  ──────────────────────────────────────────
  // Bandeja local de recepción de XML/JSON expuestos públicamente.
  await queryFn(`
    CREATE TABLE IF NOT EXISTS dgii_received_documents (
      id                  ${pk()},
      request_id          VARCHAR(80) NOT NULL,
      business_id         INT NOT NULL DEFAULT 1,
      branch_id           INT DEFAULT NULL,
      cash_register_id    INT DEFAULT NULL,
      endpoint_type       VARCHAR(40) NOT NULL,
      environment         VARCHAR(20) NOT NULL DEFAULT 'test',
      content_type        VARCHAR(120) DEFAULT NULL,
      payload_format      VARCHAR(20) DEFAULT NULL,
      encf                VARCHAR(19) DEFAULT NULL,
      track_id            VARCHAR(100) DEFAULT NULL,
      rnc_emisor          VARCHAR(20) DEFAULT NULL,
      rnc_receptor        VARCHAR(20) DEFAULT NULL,
      payload_sha256      VARCHAR(64) DEFAULT NULL,
      payload_size        INT DEFAULT NULL,
      file_path           VARCHAR(500) DEFAULT NULL,
      status              VARCHAR(30) NOT NULL DEFAULT 'recibido',
      source_ip           VARCHAR(45) DEFAULT NULL,
      response_code       VARCHAR(80) DEFAULT NULL,
      response_message    TEXT DEFAULT NULL,
      created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ${updatedAtCol()}
    )
  `);
  await queryFn(
    'CREATE INDEX IF NOT EXISTS idx_dgii_received_business_endpoint ON dgii_received_documents (business_id, endpoint_type, created_at)'
  ).catch(() => {});
  await queryFn(
    'CREATE INDEX IF NOT EXISTS idx_dgii_received_request_id ON dgii_received_documents (request_id)'
  ).catch(() => {});

  // ── 4.3. dgii_request_log  ─────────────────────────────────────────────────
  // Log unificado para requests/responses locales y futuras llamadas salientes
  // a la DGII o a un proveedor QSCD/cloud.
  await queryFn(`
    CREATE TABLE IF NOT EXISTS dgii_request_log (
      id                   ${pk()},
      request_id           VARCHAR(80) NOT NULL,
      business_id          INT DEFAULT NULL,
      branch_id            INT DEFAULT NULL,
      cash_register_id     INT DEFAULT NULL,
      endpoint_type        VARCHAR(40) NOT NULL,
      direction            VARCHAR(20) NOT NULL DEFAULT 'inbound',
      http_method          VARCHAR(10) DEFAULT NULL,
      route_path           VARCHAR(255) DEFAULT NULL,
      environment          VARCHAR(20) DEFAULT NULL,
      origin_header        VARCHAR(255) DEFAULT NULL,
      ip_address           VARCHAR(45) DEFAULT NULL,
      content_type         VARCHAR(120) DEFAULT NULL,
      payload_format       VARCHAR(20) DEFAULT NULL,
      payload_sha256       VARCHAR(64) DEFAULT NULL,
      payload_size         INT DEFAULT NULL,
      request_payload      TEXT DEFAULT NULL,
      request_file_path    VARCHAR(500) DEFAULT NULL,
      response_status      INT DEFAULT NULL,
      response_code        VARCHAR(80) DEFAULT NULL,
      response_message     TEXT DEFAULT NULL,
      response_payload     TEXT DEFAULT NULL,
      response_file_path   VARCHAR(500) DEFAULT NULL,
      error_message        TEXT DEFAULT NULL,
      created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ${updatedAtCol()}
    )
  `);
  await queryFn(
    'CREATE INDEX IF NOT EXISTS idx_dgii_request_log_request_id ON dgii_request_log (request_id)'
  ).catch(() => {});
  await queryFn(
    'CREATE INDEX IF NOT EXISTS idx_dgii_request_log_business_created ON dgii_request_log (business_id, created_at)'
  ).catch(() => {});

  // ── 5. fiscal_audit_log ──────────────────────────────────────────────────────
  await queryFn(`
    CREATE TABLE IF NOT EXISTS fiscal_audit_log (
      id          ${pk()},
      business_id INT DEFAULT NULL,
      user_id     INT DEFAULT NULL,
      action      VARCHAR(80) NOT NULL,
      description TEXT DEFAULT NULL,
      old_value   TEXT DEFAULT NULL,
      new_value   TEXT DEFAULT NULL,
      ip_address  VARCHAR(45) DEFAULT NULL,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ── 6. Columnas extra en businesses ─────────────────────────────────────────
  const bizCols = [
    ['razon_social',    'VARCHAR(160) DEFAULT NULL'],
    ['nombre_comercial','VARCHAR(160) DEFAULT NULL'],
    ['municipio',       'VARCHAR(80)  DEFAULT NULL'],
    ['provincia',       'VARCHAR(80)  DEFAULT NULL'],
    ['correo',          'VARCHAR(160) DEFAULT NULL'],
    ['logo',            'TEXT         DEFAULT NULL'],
    ['rnc',             'VARCHAR(40)  DEFAULT NULL'],
    ['direccion',       'VARCHAR(255) DEFAULT NULL'],
    ['telefono',        'VARCHAR(40)  DEFAULT NULL'],
  ];
  for (const [col, def] of bizCols) {
    await addColFn('businesses', col, def);
  }

  // ── 7. Columnas extra en sales para e-CF ─────────────────────────────────────
  const salesCols = [
    ['encf',            'VARCHAR(19) DEFAULT NULL'],
    ['tipo_ecf',        'VARCHAR(5)  DEFAULT NULL'],
    ['ecf_document_id', 'INT         DEFAULT NULL'],
    ['ecf_estado',      'VARCHAR(30) DEFAULT NULL'],
    ['ecf_track_id',    'VARCHAR(100) DEFAULT NULL'],
  ];
  for (const [col, def] of salesCols) {
    await addColFn('sales', col, def);
  }

  const ecfDocCols = [
    ['submission_mode', 'VARCHAR(20) NOT NULL DEFAULT \'ecf\''],
  ];
  for (const [col, def] of ecfDocCols) {
    await addColFn('ecf_documents', col, def);
  }

  const dgiiSettingsCols = [
    ['rfce_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ];
  for (const [col, def] of dgiiSettingsCols) {
    await addColFn('dgii_company_settings', col, def);
  }
}

/**
 * Registra una acción en el audit log fiscal (sin datos sensibles).
 */
async function writeFiscalAuditLog(queryFn, { businessId, userId, action, description, oldValue, newValue, ipAddress } = {}) {
  try {
    await queryFn(
      `INSERT INTO fiscal_audit_log
         (business_id, user_id, action, description, old_value, new_value, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        businessId || null,
        userId     || null,
        action     || null,
        description || null,
        oldValue   != null ? String(oldValue).slice(0, 1000) : null,
        newValue   != null ? String(newValue).slice(0, 1000) : null,
        ipAddress  || null,
      ]
    );
  } catch (_) {
    // El audit log nunca debe interrumpir el flujo principal
  }
}

/**
 * Upsert simple y portable entre SQLite y MySQL/MariaDB.
 * Asume un identificador único (`keyColumn`) y actualiza solo las columnas
 * provistas en `values`.
 */
async function upsertOne(queryFn, tableName, keyColumn, values) {
  const table = assertSqlIdentifier(tableName);
  const key = assertSqlIdentifier(keyColumn);
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('upsertOne requiere un objeto values.');
  }
  if (!Object.prototype.hasOwnProperty.call(values, key)) {
    throw new Error(`upsertOne requiere la columna clave "${key}" en values.`);
  }

  const keyValue = normalizeSqlValue(values[key]);
  const columns = Object.keys(values).map(assertSqlIdentifier);
  const normalizedValues = Object.fromEntries(
    columns.map((column) => [column, normalizeSqlValue(values[column])])
  );

  const existingRows = await queryFn(
    `SELECT \`${key}\` FROM \`${table}\` WHERE \`${key}\` = ? LIMIT 1`,
    [keyValue]
  );

  if (Array.isArray(existingRows) && existingRows.length > 0) {
    const updateColumns = columns.filter((column) => column !== key);
    if (!updateColumns.length) {
      return { action: 'noop', key: keyValue };
    }

    const assignments = updateColumns.map((column) => `\`${column}\` = ?`);
    if (!updateColumns.includes('updated_at')) {
      assignments.push('`updated_at` = CURRENT_TIMESTAMP');
    }

    const params = updateColumns.map((column) => normalizedValues[column]);
    params.push(keyValue);

    await queryFn(
      `UPDATE \`${table}\`
       SET ${assignments.join(', ')}
       WHERE \`${key}\` = ?`,
      params
    );
    return { action: 'update', key: keyValue };
  }

  const insertColumns = columns.map((column) => `\`${column}\``);
  const placeholders = columns.map(() => '?');
  const insertParams = columns.map((column) => normalizedValues[column]);

  await queryFn(
    `INSERT INTO \`${table}\` (${insertColumns.join(', ')})
     VALUES (${placeholders.join(', ')})`,
    insertParams
  );
  return { action: 'insert', key: keyValue };
}

module.exports = {
  ensureFiscalExtensions,
  writeFiscalAuditLog,
  upsertOne,
};
