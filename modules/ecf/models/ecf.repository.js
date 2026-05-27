'use strict';

const crypto = require('crypto');
const { normalizeEnvironmentKey } = require('../config/ecf.config');
const { EcfError, assertCondition } = require('../utils/errors');

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function toSqlDateTime(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function parseEncfNumber(encf, prefijo = '') {
  const normalizedEncf = String(encf || '').trim().toUpperCase();
  const normalizedPrefix = String(prefijo || '').trim().toUpperCase();
  const numericPart = normalizedPrefix && normalizedEncf.startsWith(normalizedPrefix)
    ? normalizedEncf.slice(normalizedPrefix.length)
    : normalizedEncf.replace(/^[A-Z]+/, '');
  const parsed = Number(String(numericPart || '').replace(/\D/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function getTableColumns(query, tableName) {
  const rows = await query(`PRAGMA table_info(${tableName})`).catch(() => []);
  return rows.map((row) => String(row.name || '').trim()).filter(Boolean);
}

async function addColumnIfMissing(query, tableName, columnName, definitionSql) {
  const columns = await getTableColumns(query, tableName);
  if (columns.includes(columnName)) return false;
  await query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definitionSql}`);
  return true;
}

class EcfRepository {
  constructor({ query, withTransaction }) {
    this.query = query;
    this.withTransaction = withTransaction;
  }

  async ensureSchema() {
    await this.query(`
      CREATE TABLE IF NOT EXISTS ecf_emitters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_id INT NOT NULL DEFAULT 1,
        rnc VARCHAR(20) DEFAULT NULL,
        razon_social VARCHAR(255) DEFAULT NULL,
        nombre_comercial VARCHAR(255) DEFAULT NULL,
        direccion TEXT DEFAULT NULL,
        provincia VARCHAR(120) DEFAULT NULL,
        municipio VARCHAR(120) DEFAULT NULL,
        telefono VARCHAR(50) DEFAULT NULL,
        correo VARCHAR(150) DEFAULT NULL,
        environment VARCHAR(20) NOT NULL DEFAULT 'testecf',
        certificate_type VARCHAR(20) NOT NULL DEFAULT 'p12',
        certificate_expires_at DATETIME DEFAULT NULL,
        validation_status VARCHAR(30) NOT NULL DEFAULT 'pendiente',
        public_base_url TEXT DEFAULT NULL,
        allowed_origins TEXT DEFAULT NULL,
        require_internal_token TINYINT(1) NOT NULL DEFAULT 0,
        internal_token_hash VARCHAR(255) DEFAULT NULL,
        notes TEXT DEFAULT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS ecf_certificates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_id INT NOT NULL DEFAULT 1,
        file_name VARCHAR(255) DEFAULT NULL,
        certificate_path TEXT DEFAULT NULL,
        password_encrypted TEXT DEFAULT NULL,
        subject TEXT DEFAULT NULL,
        issuer TEXT DEFAULT NULL,
        serial_number VARCHAR(120) DEFAULT NULL,
        valid_from DATETIME DEFAULT NULL,
        valid_to DATETIME DEFAULT NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'valido',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS ecf_sequences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_id INT NOT NULL DEFAULT 1,
        branch_id INT DEFAULT NULL,
        cash_register_id INT DEFAULT NULL,
        tipo_comprobante VARCHAR(5) NOT NULL,
        numero_inicial BIGINT NOT NULL,
        numero_final BIGINT NOT NULL,
        proximo_numero BIGINT NOT NULL,
        fecha_autorizacion DATE DEFAULT NULL,
        fecha_vencimiento DATE DEFAULT NULL,
        activo TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS ecf_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_id INT NOT NULL DEFAULT 1,
        sale_id INT DEFAULT NULL,
        sequence_id INT DEFAULT NULL,
        branch_id INT DEFAULT NULL,
        cash_register_id INT DEFAULT NULL,
        created_by_user_id INT DEFAULT NULL,
        tipo_ecf VARCHAR(5) NOT NULL,
        encf VARCHAR(30) DEFAULT NULL,
        environment VARCHAR(20) NOT NULL DEFAULT 'testecf',
        estado_dgii VARCHAR(40) NOT NULL DEFAULT 'pendiente',
        submission_mode VARCHAR(30) NOT NULL DEFAULT 'normal',
        track_id VARCHAR(120) DEFAULT NULL,
        codigo_seguridad VARCHAR(20) DEFAULT NULL,
        nombre_comprador VARCHAR(255) DEFAULT NULL,
        rnc_comprador VARCHAR(20) DEFAULT NULL,
        subtotal DECIMAL(18,2) NOT NULL DEFAULT 0,
        descuento_total DECIMAL(18,2) NOT NULL DEFAULT 0,
        monto_exento DECIMAL(18,2) NOT NULL DEFAULT 0,
        monto_gravado DECIMAL(18,2) NOT NULL DEFAULT 0,
        itbis_total DECIMAL(18,2) NOT NULL DEFAULT 0,
        monto_total DECIMAL(18,2) NOT NULL DEFAULT 0,
        xml_content LONGTEXT DEFAULT NULL,
        signed_xml_content LONGTEXT DEFAULT NULL,
        dgii_response_json LONGTEXT DEFAULT NULL,
        xml_generated_at DATETIME DEFAULT NULL,
        signed_at DATETIME DEFAULT NULL,
        sent_at DATETIME DEFAULT NULL,
        last_checked_at DATETIME DEFAULT NULL,
        error_message TEXT DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS ecf_test_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_id INT NOT NULL DEFAULT 1,
        test_key VARCHAR(80) NOT NULL,
        environment VARCHAR(20) NOT NULL DEFAULT 'testecf',
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        summary TEXT DEFAULT NULL,
        payload_json LONGTEXT DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS ecf_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_id INT NOT NULL DEFAULT 1,
        user_id INT DEFAULT NULL,
        user_name VARCHAR(150) DEFAULT NULL,
        user_role VARCHAR(100) DEFAULT NULL,
        branch_id INT DEFAULT NULL,
        cash_register_id INT DEFAULT NULL,
        sale_id INT DEFAULT NULL,
        sequence_id INT DEFAULT NULL,
        ecf_document_id INT DEFAULT NULL,
        tipo_comprobante VARCHAR(5) DEFAULT NULL,
        encf VARCHAR(30) DEFAULT NULL,
        action_name VARCHAR(80) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'info',
        detail TEXT DEFAULT NULL,
        response_payload LONGTEXT DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await addColumnIfMissing(this.query, 'sales', 'encf', 'VARCHAR(30) DEFAULT NULL').catch(() => {});
    await addColumnIfMissing(this.query, 'sales', 'tipo_ecf', 'VARCHAR(5) DEFAULT NULL').catch(() => {});
    await addColumnIfMissing(this.query, 'sales', 'ecf_document_id', 'INT DEFAULT NULL').catch(() => {});
    await addColumnIfMissing(this.query, 'sales', 'ecf_estado', 'VARCHAR(40) DEFAULT NULL').catch(() => {});
    await addColumnIfMissing(this.query, 'sales', 'ecf_track_id', 'VARCHAR(120) DEFAULT NULL').catch(() => {});
    await addColumnIfMissing(this.query, 'sales', 'ecf_error', 'TEXT DEFAULT NULL').catch(() => {});
    await addColumnIfMissing(this.query, 'sales', 'ecf_xml_generado_at', 'DATETIME DEFAULT NULL').catch(() => {});
    await addColumnIfMissing(this.query, 'sales', 'ecf_enviado_at', 'DATETIME DEFAULT NULL').catch(() => {});

    const emitterColumns = [
      ['certificate_expires_at', 'DATETIME DEFAULT NULL'],
      ['validation_status', "VARCHAR(30) NOT NULL DEFAULT 'pendiente'"],
      ['public_base_url', 'TEXT DEFAULT NULL'],
      ['allowed_origins', 'TEXT DEFAULT NULL'],
      ['require_internal_token', 'TINYINT(1) NOT NULL DEFAULT 0'],
      ['internal_token_hash', 'VARCHAR(255) DEFAULT NULL'],
      ['notes', 'TEXT DEFAULT NULL'],
      ['is_active', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ];
    for (const [columnName, definitionSql] of emitterColumns) {
      await addColumnIfMissing(this.query, 'ecf_emitters', columnName, definitionSql).catch(() => {});
    }

    const certificateColumns = [
      ['certificate_path', 'TEXT DEFAULT NULL'],
      ['password_encrypted', 'TEXT DEFAULT NULL'],
      ['subject', 'TEXT DEFAULT NULL'],
      ['issuer', 'TEXT DEFAULT NULL'],
      ['serial_number', 'VARCHAR(120) DEFAULT NULL'],
      ['valid_from', 'DATETIME DEFAULT NULL'],
      ['valid_to', 'DATETIME DEFAULT NULL'],
      ['status', "VARCHAR(30) NOT NULL DEFAULT 'valido'"],
      ['created_at', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP'],
      ['updated_at', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP'],
    ];
    for (const [columnName, definitionSql] of certificateColumns) {
      await addColumnIfMissing(this.query, 'ecf_certificates', columnName, definitionSql).catch(() => {});
    }

    const sequenceColumns = [
      ['fecha_autorizacion', 'DATE DEFAULT NULL'],
      ['updated_at', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP'],
    ];
    for (const [columnName, definitionSql] of sequenceColumns) {
      await addColumnIfMissing(this.query, 'ecf_sequences', columnName, definitionSql).catch(() => {});
    }

    const documentColumns = [
      // Columnas añadidas después de la creación inicial de la tabla
      ['sequence_id', 'INT DEFAULT NULL'],
      ['submission_mode', "VARCHAR(30) NOT NULL DEFAULT 'normal'"],
      ['codigo_seguridad', 'VARCHAR(20) DEFAULT NULL'],
      ['dgii_response_json', 'LONGTEXT DEFAULT NULL'],
      ['updated_at', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP'],
      ['certification_case_key', 'VARCHAR(150) DEFAULT NULL'],
      ['certification_source_name', 'TEXT DEFAULT NULL'],
      ['certification_source_format', 'VARCHAR(30) DEFAULT NULL'],
      ['certification_test_type', 'VARCHAR(150) DEFAULT NULL'],
      ['certification_batch_id', 'VARCHAR(80) DEFAULT NULL'],
      ['certification_order_index', 'INT DEFAULT NULL'],
      ['certification_original_xml', 'LONGTEXT DEFAULT NULL'],
      ['certification_sent_xml_path', 'TEXT DEFAULT NULL'],
      ['certification_signed_xml_path', 'TEXT DEFAULT NULL'],
      ['certification_response_path', 'TEXT DEFAULT NULL'],
      ['certification_dgii_file_name', 'VARCHAR(255) DEFAULT NULL'],
    ];
    for (const [columnName, definitionSql] of documentColumns) {
      await addColumnIfMissing(this.query, 'ecf_documents', columnName, definitionSql).catch(() => {});
    }

    // Tabla de auditoría: registra el origen de los datos del emisor usados en cada XML enviado.
    await this.query(`
      CREATE TABLE IF NOT EXISTS ecf_emitter_xml_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_id INT NOT NULL DEFAULT 1,
        fecha DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        encf VARCHAR(30) DEFAULT NULL,
        tipo_ecf VARCHAR(5) DEFAULT NULL,
        rnc VARCHAR(20) DEFAULT NULL,
        razon_social VARCHAR(255) DEFAULT NULL,
        nombre_comercial VARCHAR(255) DEFAULT NULL,
        direccion TEXT DEFAULT NULL,
        origen_datos VARCHAR(80) NOT NULL DEFAULT 'ecf_emitters',
        accion VARCHAR(60) NOT NULL DEFAULT 'xml_generado',
        detalle TEXT DEFAULT NULL
      )
    `).catch(() => {});
  }

  async saveEmitterXmlLog({ businessId = 1, encf = null, tipoEcf = null, emitterData = {}, origen = 'ecf_emitters', accion = 'xml_generado', detalle = null } = {}) {
    try {
      await this.query(
        `INSERT INTO ecf_emitter_xml_log (business_id, encf, tipo_ecf, rnc, razon_social, nombre_comercial, direccion, origen_datos, accion, detalle)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [businessId, encf || null, tipoEcf || null,
          emitterData.rnc || null,
          emitterData.razon_social || null,
          emitterData.nombre_comercial ?? null,
          emitterData.direccion || null,
          origen, accion, detalle || null,
        ]
      );
    } catch (_) { /* log failure nunca debe interrumpir el flujo */ }
  }

  async getEmitterXmlLogs(businessId = 1, limit = 50) {
    return this.query(
      'SELECT * FROM ecf_emitter_xml_log WHERE business_id = ? ORDER BY id DESC LIMIT ?',
      [businessId, limit]
    ).catch(() => []);
  }

  async getEmitter(businessId = 1) {
    const rows = await this.query('SELECT * FROM ecf_emitters WHERE business_id = ? ORDER BY id DESC LIMIT 1', [businessId]);
    const emitter = rows[0] || null;
    if (!emitter) return null;
    return {
      ...emitter,
      environment: normalizeEnvironmentKey(emitter.environment || 'testecf'),
      require_internal_token: Boolean(Number(emitter.require_internal_token || 0)),
      is_active: Boolean(Number(emitter.is_active || 0)),
    };
  }

  async getBusinessFallbackConfig(businessId = 1) {
    const rows = await this.query('SELECT * FROM config WHERE id = ? LIMIT 1', [businessId]).catch(() => []);
    return rows[0] || {};
  }

  async getResolvedEmitter(businessId = 1) {
    const emitter = await this.getEmitter(businessId);
    const fallback = await this.getBusinessFallbackConfig(businessId);
    return {
      business_id: businessId,
      rnc: emitter?.rnc || fallback.rnc || '',
      razon_social: emitter?.razon_social || fallback.business_name || '',
      // IMPORTANTE: nombre_comercial NO debe hacer fallback a business_name.
      // NombreComercial es un campo INDEPENDIENTE de RazonSocial. Si el emisor
      // no tiene nombre comercial configurado (null) o lo dejó en blanco (''),
      // debe quedar vacío — así appendIfValue/appendSimple omiten el tag XML.
      // Usar ?? (nullish coalescing) en lugar de || para que '' (cadena vacía
      // guardada explícitamente) no sea tratada como falsy y no haga fallback.
      nombre_comercial: emitter?.nombre_comercial ?? '',
      direccion: emitter?.direccion || fallback.address || '',
      provincia: emitter?.provincia || '',
      municipio: emitter?.municipio || '',
      telefono: emitter?.telefono || fallback.phone || '',
      correo: emitter?.correo || '',
      environment: normalizeEnvironmentKey(emitter?.environment || 'testecf'),
      certificate_type: emitter?.certificate_type || 'p12',
      certificate_expires_at: emitter?.certificate_expires_at || null,
      validation_status: emitter?.validation_status || 'pendiente',
      public_base_url: emitter?.public_base_url || '',
      allowed_origins: emitter?.allowed_origins || '',
      require_internal_token: Boolean(Number(emitter?.require_internal_token || 0)),
      internal_token_hash: emitter?.internal_token_hash || '',
      notes: emitter?.notes || '',
      is_active: Boolean(Number(emitter?.is_active || 0)),
    };
  }

  async upsertEmitter(businessId, payload) {
    const current = await this.getEmitter(businessId);
    const data = {
      rnc: payload.rnc ?? current?.rnc ?? null,
      razon_social: payload.razon_social ?? current?.razon_social ?? null,
      nombre_comercial: payload.nombre_comercial ?? current?.nombre_comercial ?? null,
      direccion: payload.direccion ?? current?.direccion ?? null,
      provincia: payload.provincia ?? current?.provincia ?? null,
      municipio: payload.municipio ?? current?.municipio ?? null,
      telefono: payload.telefono ?? current?.telefono ?? null,
      correo: payload.correo ?? current?.correo ?? null,
      environment: normalizeEnvironmentKey(payload.environment ?? current?.environment ?? 'testecf'),
      certificate_type: payload.certificate_type ?? current?.certificate_type ?? 'p12',
      certificate_expires_at: payload.certificate_expires_at ?? current?.certificate_expires_at ?? null,
      validation_status: payload.validation_status ?? current?.validation_status ?? 'pendiente',
      public_base_url: payload.public_base_url ?? current?.public_base_url ?? null,
      allowed_origins: payload.allowed_origins ?? current?.allowed_origins ?? null,
      require_internal_token: payload.require_internal_token === undefined
        ? Number(current?.require_internal_token || 0)
        : (payload.require_internal_token ? 1 : 0),
      internal_token_hash: payload.internal_token_hash ?? current?.internal_token_hash ?? null,
      notes: payload.notes ?? current?.notes ?? null,
      is_active: payload.is_active === undefined ? Number(current?.is_active || 0) : (payload.is_active ? 1 : 0),
    };

    if (current) {
      await this.query(
        `UPDATE ecf_emitters
         SET rnc=?, razon_social=?, nombre_comercial=?, direccion=?, provincia=?, municipio=?, telefono=?, correo=?,
             environment=?, certificate_type=?, certificate_expires_at=?, validation_status=?, public_base_url=?, allowed_origins=?,
             require_internal_token=?, internal_token_hash=?, notes=?, is_active=?, updated_at=CURRENT_TIMESTAMP
         WHERE id=?`,
        [
          data.rnc,
          data.razon_social,
          data.nombre_comercial,
          data.direccion,
          data.provincia,
          data.municipio,
          data.telefono,
          data.correo,
          data.environment,
          data.certificate_type,
          data.certificate_expires_at,
          data.validation_status,
          data.public_base_url,
          data.allowed_origins,
          data.require_internal_token,
          data.internal_token_hash,
          data.notes,
          data.is_active,
          current.id,
        ]
      );
    } else {
      await this.query(
        `INSERT INTO ecf_emitters
        (business_id, rnc, razon_social, nombre_comercial, direccion, provincia, municipio, telefono, correo,
         environment, certificate_type, certificate_expires_at, validation_status, public_base_url, allowed_origins,
         require_internal_token, internal_token_hash, notes, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          businessId,
          data.rnc,
          data.razon_social,
          data.nombre_comercial,
          data.direccion,
          data.provincia,
          data.municipio,
          data.telefono,
          data.correo,
          data.environment,
          data.certificate_type,
          data.certificate_expires_at,
          data.validation_status,
          data.public_base_url,
          data.allowed_origins,
          data.require_internal_token,
          data.internal_token_hash,
          data.notes,
          data.is_active,
        ]
      );
    }

    return this.getResolvedEmitter(businessId);
  }

  async saveCertificate(businessId, certificate) {
    const current = await this.getCertificate(businessId);
    const data = {
      file_name: certificate.fileName,
      certificate_path: certificate.certificatePath,
      password_encrypted: certificate.passwordEncrypted,
      subject: certificate.subject,
      issuer: certificate.issuer,
      serial_number: certificate.serialNumber,
      valid_from: toSqlDateTime(certificate.validFrom),
      valid_to: toSqlDateTime(certificate.validTo),
      status: certificate.status || 'valido',
    };

    if (current) {
      await this.query(
        `UPDATE ecf_certificates
         SET file_name=?, certificate_path=?, password_encrypted=?, subject=?, issuer=?, serial_number=?, valid_from=?, valid_to=?, status=?, updated_at=CURRENT_TIMESTAMP
         WHERE id=?`,
        [
          data.file_name,
          data.certificate_path,
          data.password_encrypted,
          data.subject,
          data.issuer,
          data.serial_number,
          data.valid_from,
          data.valid_to,
          data.status,
          current.id,
        ]
      );
    } else {
      await this.query(
        `INSERT INTO ecf_certificates
         (business_id, file_name, certificate_path, password_encrypted, subject, issuer, serial_number, valid_from, valid_to, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          businessId,
          data.file_name,
          data.certificate_path,
          data.password_encrypted,
          data.subject,
          data.issuer,
          data.serial_number,
          data.valid_from,
          data.valid_to,
          data.status,
        ]
      );
    }

    await this.upsertEmitter(businessId, {
      certificate_expires_at: data.valid_to,
      validation_status: data.status === 'valido' ? 'valido' : 'observado',
    });
  }

  async getCertificate(businessId = 1) {
    const rows = await this.query('SELECT * FROM ecf_certificates WHERE business_id = ? ORDER BY id DESC LIMIT 1', [businessId]);
    return rows[0] || null;
  }

  async listSequences(businessId = 1) {
    const rows = await this.query(
      `SELECT s.*,
              COALESCE(b.nombre, 'Global') AS branch_name,
              COALESCE(c.nombre, '') AS cash_register_name
       FROM ecf_sequences s
       LEFT JOIN branches b ON b.id = s.branch_id
       LEFT JOIN cash_registers c ON c.id = s.cash_register_id
       WHERE s.business_id = ?
       ORDER BY s.tipo_comprobante, s.branch_id, s.cash_register_id, s.id DESC`,
      [businessId]
    ).catch(() => this.query(
      'SELECT * FROM ecf_sequences WHERE business_id = ? ORDER BY tipo_comprobante, branch_id, cash_register_id, id DESC',
      [businessId]
    ));

    return rows.map((row) => {
      const current = Number(row.proximo_numero || 0);
      const end = Number(row.numero_final || 0);
      const expired = row.fecha_vencimiento ? new Date(row.fecha_vencimiento).getTime() < Date.now() : false;
      return {
        id: row.id,
        tipoComprobante: row.tipo_comprobante,
        label: row.tipo_comprobante,
        branchId: row.branch_id || null,
        cashRegisterId: row.cash_register_id || null,
        branchName: row.branch_name || 'Global',
        cashRegisterName: row.cash_register_name || '',
        prefijo: row.tipo_comprobante || '',
        serie: '',
        desde: Number(row.numero_inicial || 0),
        hasta: end,
        proximo: current,
        remaining: Math.max(end - current + 1, 0),
        fechaAutorizacion: row.fecha_autorizacion || null,
        fechaVencimiento: row.fecha_vencimiento || null,
        activo: Boolean(Number(row.activo || 0)),
        isExpired: expired,
        isExhausted: current > end,
      };
    });
  }

  async saveSequence(businessId, payload) {
    assertCondition(payload.tipoComprobante, 'Debe indicar el tipo de comprobante.', { statusCode: 422 });
    assertCondition(Number(payload.desde || 0) > 0, 'La secuencia inicial debe ser mayor que cero.', { statusCode: 422 });
    assertCondition(Number(payload.hasta || 0) >= Number(payload.desde || 0), 'El rango final debe ser mayor o igual al inicial.', {
      statusCode: 422,
    });

    await this.query(
      `INSERT INTO ecf_sequences
       (business_id, branch_id, cash_register_id, tipo_comprobante, numero_inicial, numero_final, proximo_numero, fecha_autorizacion, fecha_vencimiento, activo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        businessId,
        payload.branchId || null,
        payload.cashRegisterId || null,
        String(payload.tipoComprobante).trim().toUpperCase(),
        Number(payload.desde),
        Number(payload.hasta),
        Number(payload.desde),
        payload.fechaAutorizacion || null,
        payload.fechaVencimiento || null,
      ]
    );
    return this.listSequences(businessId);
  }

  async ensureSequenceCoverage(conn, businessId, payload) {
    const tipoComprobante = String(payload.tipoComprobante || '').trim().toUpperCase();
    const numeroInicial = Number(payload.numeroInicial || 0);
    const numeroFinal = Number(payload.numeroFinal || 0);
    assertCondition(tipoComprobante, 'Debe indicar el tipo de comprobante para asegurar la secuencia.', { statusCode: 422 });
    assertCondition(numeroInicial > 0, 'La secuencia importada debe iniciar en un número mayor que cero.', { statusCode: 422 });
    assertCondition(numeroFinal >= numeroInicial, 'La secuencia importada tiene un rango inválido.', { statusCode: 422 });

    const rows = await conn.query(
      `SELECT *
       FROM ecf_sequences
       WHERE business_id = ?
         AND tipo_comprobante = ?
       ORDER BY activo DESC, id DESC`,
      [businessId, tipoComprobante]
    );

    const active = rows.find((row) => Number(row.activo || 0) === 1) || rows[0] || null;
    const bufferedEnd = numeroFinal + 200;
    const nextNumber = numeroFinal + 1;

    if (active) {
      const mergedStart = Math.min(Number(active.numero_inicial || numeroInicial), numeroInicial);
      const mergedEnd = Math.max(Number(active.numero_final || 0), bufferedEnd);
      const mergedNext = Math.max(Number(active.proximo_numero || 0), nextNumber);
      const fechaAutorizacion = payload.fechaAutorizacion || active.fecha_autorizacion || null;
      const fechaVencimiento = payload.fechaVencimiento || active.fecha_vencimiento || null;

      await conn.query(
        `UPDATE ecf_sequences
         SET numero_inicial = ?,
             numero_final = ?,
             proximo_numero = ?,
             fecha_autorizacion = COALESCE(?, fecha_autorizacion),
             fecha_vencimiento = COALESCE(?, fecha_vencimiento),
             activo = 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [mergedStart, mergedEnd, mergedNext, fechaAutorizacion, fechaVencimiento, active.id]
      );

      return {
        ...active,
        numero_inicial: mergedStart,
        numero_final: mergedEnd,
        proximo_numero: mergedNext,
        fecha_autorizacion: fechaAutorizacion,
        fecha_vencimiento: fechaVencimiento,
        activo: 1,
      };
    }

    const insertResult = await conn.query(
      `INSERT INTO ecf_sequences
       (business_id, branch_id, cash_register_id, tipo_comprobante, numero_inicial, numero_final, proximo_numero, fecha_autorizacion, fecha_vencimiento, activo, created_at, updated_at)
       VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        businessId,
        tipoComprobante,
        numeroInicial,
        bufferedEnd,
        nextNumber,
        payload.fechaAutorizacion || null,
        payload.fechaVencimiento || null,
      ]
    );
    const createdRows = await conn.query('SELECT * FROM ecf_sequences WHERE id = ? LIMIT 1', [Number(insertResult.insertId || 0)]);
    return createdRows[0] || {
      id: Number(insertResult.insertId || 0),
      business_id: businessId,
      tipo_comprobante: tipoComprobante,
      numero_inicial: numeroInicial,
      numero_final: bufferedEnd,
      proximo_numero: nextNumber,
      fecha_autorizacion: payload.fechaAutorizacion || null,
      fecha_vencimiento: payload.fechaVencimiento || null,
      activo: 1,
    };
  }

  async disableSequence(id) {
    await this.query('UPDATE ecf_sequences SET activo = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  }

  async updateSequenceNextNumber(sequenceId, nextNumber) {
    const normalizedSequenceId = Number(sequenceId || 0);
    const normalizedNext = Number(nextNumber || 0);
    assertCondition(normalizedSequenceId > 0, 'Debe indicar la secuencia a actualizar.', { statusCode: 422 });
    assertCondition(normalizedNext > 0, 'El próximo número debe ser mayor que cero.', { statusCode: 422 });

    await this.query(
      `UPDATE ecf_sequences
       SET proximo_numero = ?,
           activo = CASE WHEN ? <= numero_final THEN 1 ELSE 0 END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [normalizedNext, normalizedNext, normalizedSequenceId]
    );

    return this.getSequence(normalizedSequenceId);
  }

  async getNextAvailableSequence(conn, businessId, sale, tipoComprobante) {
    const rows = await conn.query(
      `SELECT * FROM ecf_sequences
       WHERE business_id = ?
         AND tipo_comprobante = ?
         AND activo = 1
         AND (branch_id IS NULL OR branch_id = ?)
         AND (cash_register_id IS NULL OR cash_register_id = ?)
       ORDER BY
         CASE WHEN cash_register_id = ? THEN 0 WHEN cash_register_id IS NULL THEN 1 ELSE 2 END,
         CASE WHEN branch_id = ? THEN 0 WHEN branch_id IS NULL THEN 1 ELSE 2 END,
         id DESC`,
      [
        businessId,
        tipoComprobante,
        sale.branch_id || null,
        sale.cash_register_id || null,
        sale.cash_register_id || null,
        sale.branch_id || null,
      ]
    );

    const currentDate = Date.now();
    return rows.find((row) => {
      const expired = row.fecha_vencimiento ? new Date(row.fecha_vencimiento).getTime() < currentDate : false;
      const exhausted = Number(row.proximo_numero || 0) > Number(row.numero_final || 0);
      return !expired && !exhausted;
    }) || null;
  }

  formatEncf(tipoComprobante, nextNumber) {
    return `${String(tipoComprobante).trim().toUpperCase()}${String(nextNumber).padStart(10, '0')}`;
  }

  async localEncfExists(conn, businessId, encf, excludeDocumentId = null) {
    const normalizedEncf = String(encf || '').trim().toUpperCase();
    if (!normalizedEncf) return false;

    const documentRows = await conn.query(
      `SELECT id
       FROM ecf_documents
       WHERE business_id = ?
         AND UPPER(encf) = ?
         AND (? IS NULL OR id <> ?)
       LIMIT 1`,
      [businessId, normalizedEncf, excludeDocumentId || null, excludeDocumentId || null]
    );
    if (documentRows.length > 0) return true;

    const saleRows = await conn.query(
      `SELECT id
       FROM sales
       WHERE UPPER(encf) = ?
         AND (? IS NULL OR ecf_document_id IS NULL OR ecf_document_id <> ?)
       LIMIT 1`,
      [normalizedEncf, excludeDocumentId || null, excludeDocumentId || null]
    ).catch(() => []);
    return saleRows.length > 0;
  }

  async generateNextENCF(options = {}) {
    const runner = async (conn) => this.generateNextENCFInConnection(conn, options);
    if (options.conn) return runner(options.conn);
    return this.withTransaction(runner);
  }

  async generateNextENCFInConnection(conn, options = {}) {
    const businessId = Number(options.businessId || 1);
    const normalizedType = String(options.tipoComprobante || options.tipoEcf || '').trim().toUpperCase();
    const excludeDocumentId = options.excludeDocumentId ? Number(options.excludeDocumentId) : null;
    assertCondition(normalizedType, 'Debe indicar el tipo de comprobante para generar el siguiente e-NCF.', { statusCode: 422 });

    let sequence = null;
    if (options.sequenceId) {
      const rows = await conn.query('SELECT * FROM ecf_sequences WHERE id = ? AND business_id = ? LIMIT 1', [
        Number(options.sequenceId),
        businessId,
      ]);
      sequence = rows[0] || null;
      assertCondition(sequence, `No se encontró la secuencia ${options.sequenceId}.`, { statusCode: 404 });
      assertCondition(
        String(sequence.tipo_comprobante || '').trim().toUpperCase() === normalizedType,
        `La secuencia ${options.sequenceId} no corresponde al tipo ${normalizedType}.`,
        { statusCode: 422 }
      );
    } else {
      sequence = await this.getNextAvailableSequence(conn, businessId, options.sale || {}, normalizedType);
    }

    assertCondition(sequence, `No existe una secuencia e-CF activa para ${normalizedType}.`, { statusCode: 422 });
    assertCondition(Number(sequence.activo || 0) === 1, `La secuencia ${normalizedType} no está activa.`, { statusCode: 422 });

    const prefijo = String(sequence.tipo_comprobante || normalizedType).trim().toUpperCase();
    const initialNumber = Number(sequence.numero_inicial || 0);
    const finalNumber = Number(sequence.numero_final || 0);
    let candidateNumber = Number(sequence.proximo_numero || 0);
    assertCondition(initialNumber > 0, `La secuencia ${prefijo} no tiene rango inicial válido.`, { statusCode: 422 });
    assertCondition(finalNumber >= initialNumber, `La secuencia ${prefijo} tiene un rango inválido.`, { statusCode: 422 });
    assertCondition(candidateNumber > 0, `La secuencia ${prefijo} no tiene próximo número válido.`, { statusCode: 422 });
    if (candidateNumber < initialNumber) candidateNumber = initialNumber;

    const expired = sequence.fecha_vencimiento ? new Date(sequence.fecha_vencimiento).getTime() < Date.now() : false;
    assertCondition(!expired, `La secuencia ${prefijo} está vencida.`, { statusCode: 422 });

    let encf = this.formatEncf(prefijo, candidateNumber);
    while (candidateNumber <= finalNumber && await this.localEncfExists(conn, businessId, encf, excludeDocumentId)) {
      candidateNumber += 1;
      encf = this.formatEncf(prefijo, candidateNumber);
    }

    if (candidateNumber > finalNumber) {
      await conn.query(
        'UPDATE ecf_sequences SET proximo_numero = ?, activo = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [candidateNumber, sequence.id]
      );
      throw new EcfError(`La secuencia ${prefijo} no tiene números disponibles.`, { statusCode: 422 });
    }

    if (candidateNumber !== Number(sequence.proximo_numero || 0)) {
      await conn.query(
        'UPDATE ecf_sequences SET proximo_numero = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [candidateNumber, sequence.id]
      );
    }

    return {
      encf,
      numero: candidateNumber,
      prefijo,
      reservedNumber: candidateNumber,
      sequence: {
        ...sequence,
        proximo_numero: candidateNumber,
      },
    };
  }

  async advanceSequenceAfterUse(sequenceId, encfOrNumber) {
    assertCondition(sequenceId, 'Debe indicar la secuencia a consumir.', { statusCode: 422 });
    return this.withTransaction(async (conn) => {
      const rows = await conn.query('SELECT * FROM ecf_sequences WHERE id = ? LIMIT 1', [Number(sequenceId)]);
      const sequence = rows[0] || null;
      assertCondition(sequence, `No se encontró la secuencia ${sequenceId}.`, { statusCode: 404 });

      const usedNumber = typeof encfOrNumber === 'number'
        ? Number(encfOrNumber)
        : parseEncfNumber(encfOrNumber, sequence.tipo_comprobante);
      assertCondition(usedNumber > 0, 'No se pudo determinar el número e-NCF consumido.', { statusCode: 422 });

      const currentNext = Number(sequence.proximo_numero || 0);
      const nextNumber = Math.max(currentNext, usedNumber + 1);
      const finalNumber = Number(sequence.numero_final || 0);
      const active = nextNumber <= finalNumber ? Number(sequence.activo || 0) : 0;
      await conn.query(
        'UPDATE ecf_sequences SET proximo_numero = ?, activo = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [nextNumber, active, sequence.id]
      );

      return {
        sequence: {
          ...sequence,
          proximo_numero: nextNumber,
          activo: active,
        },
        prefijo: String(sequence.tipo_comprobante || '').trim().toUpperCase(),
        numero: usedNumber,
        proximo: nextNumber,
      };
    });
  }

  async getSaleWithItems(saleId) {
    const saleRows = await this.query(
      `SELECT s.*,
              COALESCE(c.nombre, s.client_name_snapshot, 'Consumidor Final') AS client_name,
              COALESCE(c.rnc, c.cedula, s.client_tax_id_snapshot, '') AS client_tax_id,
              COALESCE(c.telefono, s.client_phone_snapshot, '') AS client_phone,
              COALESCE(c.email, '') AS client_email,
              COALESCE(c.direccion, s.delivery_address_snapshot, '') AS client_address
       FROM sales s
       LEFT JOIN clients c ON c.id = s.client_id
       WHERE s.id = ?
       LIMIT 1`,
      [saleId]
    );
    const sale = saleRows[0];
    if (!sale) {
      throw new EcfError('Venta no encontrada para emitir e-CF.', { statusCode: 404 });
    }

    const items = await this.query(
      `SELECT si.*, p.nombre AS product_name
       FROM sale_items si
       LEFT JOIN products p ON p.id = si.product_id
       WHERE si.sale_id = ?
       ORDER BY si.id ASC`,
      [saleId]
    );
    return { sale, items };
  }

  async createDocumentFromSale({ saleId, userId, tipoEcf, environment }) {
    return this.withTransaction(async (conn) => {
      const saleRows = await conn.query('SELECT * FROM sales WHERE id = ? LIMIT 1', [saleId]);
      const sale = saleRows[0];
      if (!sale) {
        throw new EcfError('Venta no encontrada para emitir e-CF.', { statusCode: 404 });
      }

      const generated = await this.generateNextENCF({
        conn,
        businessId: 1,
        sale,
        tipoComprobante: tipoEcf,
      });
      const sequence = generated.sequence;
      const encf = generated.encf;

      const result = await conn.query(
        `INSERT INTO ecf_documents
         (business_id, sale_id, sequence_id, branch_id, cash_register_id, created_by_user_id, tipo_ecf, encf, environment, estado_dgii, xml_generated_at, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          saleId,
          sequence.id,
          sale.branch_id || null,
          sale.cash_register_id || null,
          userId || null,
          tipoEcf,
          encf,
          normalizeEnvironmentKey(environment),
        ]
      );

      return {
        documentId: Number(result.insertId || 0),
        sequence,
        encf,
        sale,
      };
    });
  }

  async updateDocumentPayload(documentId, payload) {
    await this.query(
      `UPDATE ecf_documents
       SET nombre_comprador = COALESCE(?, nombre_comprador),
           rnc_comprador = COALESCE(?, rnc_comprador),
           subtotal = COALESCE(?, subtotal),
           descuento_total = COALESCE(?, descuento_total),
           monto_exento = COALESCE(?, monto_exento),
           monto_gravado = COALESCE(?, monto_gravado),
           itbis_total = COALESCE(?, itbis_total),
           monto_total = COALESCE(?, monto_total),
           codigo_seguridad = COALESCE(?, codigo_seguridad),
           xml_content = COALESCE(?, xml_content),
           signed_xml_content = COALESCE(?, signed_xml_content),
           submission_mode = COALESCE(?, submission_mode),
           estado_dgii = COALESCE(?, estado_dgii),
           signed_at = COALESCE(?, signed_at),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        payload.nombre_comprador ?? null,
        payload.rnc_comprador ?? null,
        payload.subtotal ?? null,
        payload.descuento_total ?? null,
        payload.monto_exento ?? null,
        payload.monto_gravado ?? null,
        payload.itbis_total ?? null,
        payload.monto_total ?? null,
        payload.codigo_seguridad ?? null,
        payload.xml_content ?? null,
        payload.signed_xml_content ?? null,
        payload.submission_mode ?? null,
        payload.estado_dgii ?? null,
        payload.signed_at ? toSqlDateTime(payload.signed_at) : null,
        documentId,
      ]
    );
  }

  async saveImportedDocument(conn, businessId, payload) {
    const tipoEcf = String(payload.tipoEcf || '').trim().toUpperCase();
    const encf = String(payload.encf || '').trim().toUpperCase();
    assertCondition(tipoEcf, 'Debe indicar el tipo de e-CF del documento importado.', { statusCode: 422 });
    assertCondition(encf, 'Debe indicar el e-NCF del documento importado.', { statusCode: 422 });

    const existingRows = await conn.query(
      'SELECT * FROM ecf_documents WHERE business_id = ? AND encf = ? ORDER BY id DESC LIMIT 1',
      [businessId, encf]
    );
    const existing = existingRows[0] || null;
    const protectedStatuses = new Set(['aceptado', 'aceptado_condicional', 'en_proceso', 'enviado', 'procesando']);
    const normalizedStatus = String(existing?.estado_dgii || '').trim().toLowerCase();

    if (existing && (existing.track_id || existing.sent_at || protectedStatuses.has(normalizedStatus))) {
      throw new EcfError(`El e-NCF ${encf} ya fue enviado a DGII y no puede ser reemplazado.`, { statusCode: 409 });
    }

    const state = String(payload.estadoDgii || (payload.signedXml ? 'firmado' : 'pendiente')).trim();
    const signedAt = payload.signedAt ? toSqlDateTime(payload.signedAt) : null;
    const environment = normalizeEnvironmentKey(payload.environment || 'testecf');

    if (existing) {
      await conn.query(
        `UPDATE ecf_documents
         SET sequence_id = ?,
             branch_id = NULL,
             cash_register_id = NULL,
             created_by_user_id = ?,
             tipo_ecf = ?,
             environment = ?,
             estado_dgii = ?,
             submission_mode = ?,
             track_id = NULL,
             codigo_seguridad = ?,
             nombre_comprador = ?,
             rnc_comprador = ?,
             subtotal = ?,
             descuento_total = ?,
             monto_exento = ?,
             monto_gravado = ?,
             itbis_total = ?,
             monto_total = ?,
             xml_content = ?,
             signed_xml_content = ?,
             certification_case_key = ?,
             certification_source_name = ?,
             certification_source_format = ?,
             certification_test_type = ?,
             certification_batch_id = ?,
             certification_order_index = ?,
             certification_original_xml = ?,
             dgii_response_json = NULL,
             xml_generated_at = CURRENT_TIMESTAMP,
             signed_at = ?,
             sent_at = NULL,
             last_checked_at = NULL,
             error_message = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          payload.sequenceId || null,
          payload.userId || null,
          tipoEcf,
          environment,
          state,
          payload.submissionMode || 'normal',
          payload.codigoSeguridad || null,
          payload.nombreComprador || null,
          digitsOnly(payload.rncComprador),
          payload.subtotal ?? 0,
          payload.descuentoTotal ?? 0,
          payload.montoExento ?? 0,
          payload.montoGravado ?? 0,
          payload.itbisTotal ?? 0,
          payload.montoTotal ?? 0,
          payload.xmlContent || null,
          payload.signedXml || null,
          payload.certificationCaseKey || null,
          payload.certificationSourceName || null,
          payload.certificationSourceFormat || null,
          payload.certificationTestType || null,
          payload.certificationBatchId || null,
          payload.certificationOrderIndex ?? null,
          payload.certificationOriginalXml || null,
          signedAt,
          existing.id,
        ]
      );
      return { documentId: Number(existing.id), updated: true };
    }

    const insertResult = await conn.query(
      `INSERT INTO ecf_documents
       (business_id, sale_id, sequence_id, branch_id, cash_register_id, created_by_user_id, tipo_ecf, encf, environment, estado_dgii, submission_mode, track_id, codigo_seguridad, nombre_comprador, rnc_comprador, subtotal, descuento_total, monto_exento, monto_gravado, itbis_total, monto_total, xml_content, signed_xml_content, certification_case_key, certification_source_name, certification_source_format, certification_test_type, certification_batch_id, certification_order_index, certification_original_xml, dgii_response_json, xml_generated_at, signed_at, sent_at, last_checked_at, error_message, created_at, updated_at)
       VALUES (?, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP, ?, NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        businessId,
        payload.sequenceId || null,
        payload.userId || null,
        tipoEcf,
        encf,
        environment,
        state,
        payload.submissionMode || 'normal',
        payload.codigoSeguridad || null,
        payload.nombreComprador || null,
        digitsOnly(payload.rncComprador),
        payload.subtotal ?? 0,
        payload.descuentoTotal ?? 0,
        payload.montoExento ?? 0,
        payload.montoGravado ?? 0,
        payload.itbisTotal ?? 0,
        payload.montoTotal ?? 0,
        payload.xmlContent || null,
        payload.signedXml || null,
        payload.certificationCaseKey || null,
        payload.certificationSourceName || null,
        payload.certificationSourceFormat || null,
        payload.certificationTestType || null,
        payload.certificationBatchId || null,
        payload.certificationOrderIndex ?? null,
        payload.certificationOriginalXml || null,
        signedAt,
      ]
    );

    return { documentId: Number(insertResult.insertId || 0), updated: false };
  }

  async markDocumentSent(documentId, payload = {}) {
    await this.query(
      `UPDATE ecf_documents
       SET estado_dgii = ?, track_id = ?, dgii_response_json = ?, sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, error_message = ?
       WHERE id = ?`,
      [
        payload.estado_dgii || 'enviado',
        payload.track_id || null,
        payload.dgii_response_json ? JSON.stringify(payload.dgii_response_json) : null,
        payload.error_message || null,
        documentId,
      ]
    );
  }

  async markDocumentStatus(documentId, payload = {}) {
    await this.query(
      `UPDATE ecf_documents
       SET estado_dgii = COALESCE(?, estado_dgii),
           dgii_response_json = COALESCE(?, dgii_response_json),
           last_checked_at = CURRENT_TIMESTAMP,
           error_message = COALESCE(?, error_message),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        payload.estado_dgii ?? null,
        payload.dgii_response_json ? JSON.stringify(payload.dgii_response_json) : null,
        payload.error_message ?? null,
        documentId,
      ]
    );
  }

  async attachSaleSummary(saleId, payload) {
    await this.query(
      `UPDATE sales
       SET encf = ?, tipo_ecf = ?, ecf_document_id = ?, ecf_estado = ?, ecf_track_id = ?, ecf_error = ?, ecf_xml_generado_at = COALESCE(ecf_xml_generado_at, CURRENT_TIMESTAMP),
           ecf_enviado_at = CASE WHEN ? IS NOT NULL THEN CURRENT_TIMESTAMP ELSE ecf_enviado_at END
       WHERE id = ?`,
      [
        payload.encf || null,
        payload.tipoEcf || null,
        payload.documentId || null,
        payload.estado || null,
        payload.trackId || null,
        payload.error || null,
        payload.trackId || null,
        saleId,
      ]
    ).catch(() => {});
  }

  async getDocument(documentId) {
    const rows = await this.query('SELECT * FROM ecf_documents WHERE id = ? LIMIT 1', [documentId]);
    return rows[0] || null;
  }

  async getDocumentByTrackId(trackId) {
    const normalizedTrackId = String(trackId || '').trim();
    if (!normalizedTrackId) return null;
    const rows = await this.query(
      'SELECT * FROM ecf_documents WHERE business_id = 1 AND track_id = ? ORDER BY id DESC LIMIT 1',
      [normalizedTrackId]
    );
    return rows[0] || null;
  }

  async getDocumentByEncf(encf) {
    const normalizedEncf = String(encf || '').trim().toUpperCase();
    if (!normalizedEncf) return null;
    const rows = await this.query(
      'SELECT * FROM ecf_documents WHERE business_id = 1 AND UPPER(encf) = ? ORDER BY id DESC LIMIT 1',
      [normalizedEncf]
    );
    return rows[0] || null;
  }

  async getSequence(sequenceId) {
    if (!sequenceId) return null;
    const rows = await this.query('SELECT * FROM ecf_sequences WHERE id = ? LIMIT 1', [sequenceId]);
    return rows[0] || null;
  }

  async reserveNextEncfForSequence(sequenceId, tipoComprobante) {
    assertCondition(sequenceId, 'Debe indicar la secuencia para reservar el siguiente e-NCF.', { statusCode: 422 });
    const normalizedType = String(tipoComprobante || '').trim().toUpperCase();
    assertCondition(normalizedType, 'Debe indicar el tipo de comprobante para reservar el siguiente e-NCF.', { statusCode: 422 });

    return this.generateNextENCF({
      sequenceId,
      tipoComprobante: normalizedType,
    });
  }

  async reissueDocument(documentId, payload = {}) {
    await this.query(
      `UPDATE ecf_documents
       SET sequence_id = COALESCE(?, sequence_id),
           encf = COALESCE(?, encf),
           estado_dgii = COALESCE(?, estado_dgii),
           codigo_seguridad = COALESCE(?, codigo_seguridad),
           nombre_comprador = COALESCE(?, nombre_comprador),
           rnc_comprador = COALESCE(?, rnc_comprador),
           subtotal = COALESCE(?, subtotal),
           descuento_total = COALESCE(?, descuento_total),
           monto_exento = COALESCE(?, monto_exento),
           monto_gravado = COALESCE(?, monto_gravado),
           itbis_total = COALESCE(?, itbis_total),
           monto_total = COALESCE(?, monto_total),
           xml_content = COALESCE(?, xml_content),
           signed_xml_content = COALESCE(?, signed_xml_content),
           dgii_response_json = NULL,
           track_id = NULL,
           sent_at = NULL,
           last_checked_at = NULL,
           error_message = NULL,
           xml_generated_at = CURRENT_TIMESTAMP,
           signed_at = COALESCE(?, signed_at),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        payload.sequence_id ?? null,
        payload.encf ?? null,
        payload.estado_dgii ?? null,
        payload.codigo_seguridad ?? null,
        payload.nombre_comprador ?? null,
        payload.rnc_comprador ?? null,
        payload.subtotal ?? null,
        payload.descuento_total ?? null,
        payload.monto_exento ?? null,
        payload.monto_gravado ?? null,
        payload.itbis_total ?? null,
        payload.monto_total ?? null,
        payload.xml_content ?? null,
        payload.signed_xml_content ?? null,
        payload.signed_at ? toSqlDateTime(payload.signed_at) : null,
        documentId,
      ]
    );
  }

  async listDocuments(filters = {}) {
    const clauses = ['business_id = 1'];
    const params = [];
    if (String(filters.certification || '').trim() === '1') {
      clauses.push('certification_case_key IS NOT NULL');
    }
    if (filters.estado) {
      clauses.push('estado_dgii = ?');
      params.push(filters.estado);
    }
    if (filters.desde) {
      clauses.push('date(created_at) >= date(?)');
      params.push(filters.desde);
    }
    if (filters.hasta) {
      clauses.push('date(created_at) <= date(?)');
      params.push(filters.hasta);
    }
    const rows = await this.query(
      `SELECT *
       FROM ecf_documents
       WHERE ${clauses.join(' AND ')}
       ORDER BY id DESC
       LIMIT 200`,
      params
    );
    return {
      total: rows.length,
      documents: rows.map((row) => ({
        ...row,
        fecha_emision: row.xml_generated_at || row.created_at,
        mensajes_dgii: row.error_message || '',
      })),
    };
  }

  async listCertificationCases(filters = {}) {
    const clauses = ['business_id = 1', 'certification_case_key IS NOT NULL'];
    const params = [];
    const batchId = filters.batchId || await this.getLatestCertificationBatchId();
    if (batchId) {
      clauses.push('certification_batch_id = ?');
      params.push(batchId);
    }
    if (filters.estado) {
      clauses.push('estado_dgii = ?');
      params.push(filters.estado);
    }
    if (filters.desde) {
      clauses.push('date(created_at) >= date(?)');
      params.push(filters.desde);
    }
    if (filters.hasta) {
      clauses.push('date(created_at) <= date(?)');
      params.push(filters.hasta);
    }
    const rows = await this.query(
      `SELECT *
       FROM ecf_documents
       WHERE ${clauses.join(' AND ')}
       ORDER BY COALESCE(certification_order_index, id) ASC, id ASC
       LIMIT 500`,
      params
    );
    return {
      total: rows.length,
      cases: rows.map((row) => ({
        ...row,
        fecha_emision: row.xml_generated_at || row.created_at,
        mensajes_dgii: row.error_message || '',
      })),
    };
  }

  async getNextPendingCertificationDocument({ includeRejected = false } = {}) {
    const batchId = await this.getLatestCertificationBatchId();
    const params = [];
    let batchClause = '';
    if (batchId) {
      batchClause = ' AND certification_batch_id = ?';
      params.push(batchId);
    }
    // Estados base: no evaluados por DGII o errores transitorios de red/auth.
    // Con includeRejected=true (ráfaga secuencial) se incluyen también los rechazados
    // para permitir reenviarlos en el mismo pase sin intervención manual.
    const estados = includeRejected
      ? "'pendiente','firmado','error_auth','error_consulta','rechazado','error'"
      : "'pendiente','firmado','error_auth','error_consulta'";
    const rows = await this.query(
      `SELECT *
       FROM ecf_documents
       WHERE business_id = 1
         AND certification_case_key IS NOT NULL
         ${batchClause}
         AND estado_dgii IN (${estados})
       ORDER BY COALESCE(certification_order_index, id) ASC, id ASC
       LIMIT 1`,
      params
    );
    return rows[0] || null;
  }

  async deleteCurrentBatchCertificationCases() {
    const batchId = await this.getLatestCertificationBatchId();
    let whereClause = 'business_id = 1 AND certification_case_key IS NOT NULL';
    const params = [];
    if (batchId) {
      whereClause += ' AND certification_batch_id = ?';
      params.push(batchId);
    }
    const result = await this.query(
      `DELETE FROM ecf_documents WHERE ${whereClause}`,
      params
    );
    return { deleted: result.affectedRows || 0, batchId };
  }

  async getActiveCertificationDocument() {
    const batchId = await this.getLatestCertificationBatchId();
    const params = [];
    let batchClause = '';
    if (batchId) {
      batchClause = ' AND certification_batch_id = ?';
      params.push(batchId);
    }
    const rows = await this.query(
      `SELECT *
       FROM ecf_documents
       WHERE business_id = 1
         AND certification_case_key IS NOT NULL
         ${batchClause}
         AND estado_dgii IN ('enviado', 'procesando', 'en_proceso')
       ORDER BY COALESCE(certification_order_index, id) ASC, id ASC
       LIMIT 1`,
      params
    );
    return rows[0] || null;
  }

  // Marca los casos "en vuelo" del batch actual (enviado/en_proceso/procesando) de vuelta a
  // 'firmado', limpiando el TrackID. Se llama automáticamente antes de la ráfaga secuencial
  // para recoger docs que quedaron pendientes de respuesta DGII en corridas anteriores.
  //
  // IMPORTANTE: NO resetea 'aceptado', 'aceptado_condicional', 'rechazado' ni 'error':
  //   - 'aceptado'/'aceptado_condicional': ya fueron validados por DGII — resetearlos
  //     haría que se reenvíen y DGII rechazaría con "secuencia ya utilizada".
  //   - 'rechazado'/'error': necesitan corrección manual y reenvío individual.
  //     La ráfaga secuencial los salta (includeRejected: false).
  //   Cuando DGII reinicia el conteo de pruebas por un rechazo, usar rotateBurnedEncfs(force=true)
  //   para asignar nuevas secuencias a TODOS los docs antes de reenviar.
  async resetSentCertificationCasesToFirmado() {
    const batchId = await this.getLatestCertificationBatchId();
    const params = [];
    let batchClause = '';
    if (batchId) {
      batchClause = ' AND certification_batch_id = ?';
      params.push(batchId);
    }
    const result = await this.query(
      `UPDATE ecf_documents
       SET estado_dgii = 'firmado',
           track_id    = NULL,
           error_message = NULL,
           updated_at  = CURRENT_TIMESTAMP
       WHERE business_id = 1
         AND certification_case_key IS NOT NULL
         ${batchClause}
         AND estado_dgii IN ('enviado', 'en_proceso', 'procesando')
         AND (submission_mode IS NULL OR submission_mode != 'rfce')`,
      params
    );
    return { reset: result.affectedRows || 0, batchId };
  }

  /**
   * Resetea documentos en estado 'rechazado' o 'error' de vuelta a 'firmado'
   * para que la ráfaga secuencial los reintente.
   * NO toca 'aceptado', 'aceptado_condicional', 'enviado', 'en_proceso', 'procesando'.
   * NO toca docs RFCE (ya aceptados en el portal).
   */
  async resetRejectedCertificationCasesToFirmado() {
    const batchId = await this.getLatestCertificationBatchId();
    const params = [];
    let batchClause = '';
    if (batchId) {
      batchClause = ' AND certification_batch_id = ?';
      params.push(batchId);
    }
    const result = await this.query(
      `UPDATE ecf_documents
       SET estado_dgii  = 'firmado',
           track_id     = NULL,
           error_message = NULL,
           updated_at   = CURRENT_TIMESTAMP
       WHERE business_id = 1
         AND certification_case_key IS NOT NULL
         ${batchClause}
         AND estado_dgii IN ('rechazado', 'error')
         AND (submission_mode IS NULL OR submission_mode != 'rfce')`,
      params
    );
    return { reset: result.affectedRows || 0, batchId };
  }

  async updateCertificationTracking(documentId, payload = {}) {
    await this.query(
      `UPDATE ecf_documents
       SET certification_sent_xml_path = COALESCE(?, certification_sent_xml_path),
           certification_signed_xml_path = COALESCE(?, certification_signed_xml_path),
           certification_response_path = COALESCE(?, certification_response_path),
           certification_dgii_file_name = COALESCE(?, certification_dgii_file_name),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        payload.sentXmlPath || null,
        payload.signedXmlPath || null,
        payload.responsePath || null,
        payload.dgiiFileName || null,
        documentId,
      ]
    );
  }

  async getCertificationSummary() {
    const batchId = await this.getLatestCertificationBatchId();
    const params = [];
    let batchClause = '';
    if (batchId) {
      batchClause = ' AND certification_batch_id = ?';
      params.push(batchId);
    }
    const rows = await this.query(
      `SELECT *
       FROM ecf_documents
       WHERE business_id = 1
         AND certification_case_key IS NOT NULL
         ${batchClause}
       ORDER BY COALESCE(certification_order_index, id) ASC, id ASC`
      ,
      params
    );
    const summary = {
      total: rows.length,
      aceptadas: 0,
      aceptadasCondicionales: 0,
      rechazadas: 0,
      pendientes: 0,
      enviadas: 0,
      ultimoEnvio: null,
      averageResponseSeconds: 0,
    };
    let totalResponseSeconds = 0;
    let responseSamples = 0;
    for (const row of rows) {
      const status = String(row.estado_dgii || '').trim().toLowerCase();
      if (status === 'aceptado') summary.aceptadas += 1;
      else if (status === 'aceptado_condicional') summary.aceptadasCondicionales += 1;
      else if (status === 'rechazado') summary.rechazadas += 1;
      else if (['enviado', 'procesando', 'en_proceso'].includes(status)) summary.enviadas += 1;
      else summary.pendientes += 1;

      if (row.sent_at && (!summary.ultimoEnvio || String(row.sent_at) > String(summary.ultimoEnvio.sent_at || ''))) {
        summary.ultimoEnvio = {
          id: row.id,
          encf: row.encf,
          estado: row.estado_dgii,
          sent_at: row.sent_at,
          track_id: row.track_id,
        };
      }

      if (row.sent_at && row.last_checked_at) {
        const sentAt = new Date(row.sent_at);
        const checkedAt = new Date(row.last_checked_at);
        const diff = Math.round((checkedAt.getTime() - sentAt.getTime()) / 1000);
        if (Number.isFinite(diff) && diff >= 0) {
          totalResponseSeconds += diff;
          responseSamples += 1;
        }
      }
    }
    summary.progress = summary.total > 0
      ? Math.round(((summary.aceptadas + summary.aceptadasCondicionales) / summary.total) * 100)
      : 0;
    summary.averageResponseSeconds = responseSamples > 0
      ? Math.round(totalResponseSeconds / responseSamples)
      : 0;
    return summary;
  }

  async getLatestCertificationBatchId() {
    const rows = await this.query(
      `SELECT certification_batch_id
       FROM ecf_documents
       WHERE business_id = 1
         AND certification_case_key IS NOT NULL
         AND certification_batch_id IS NOT NULL
         AND TRIM(certification_batch_id) <> ''
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    );
    return rows[0]?.certification_batch_id || null;
  }

  async getLatestDocument() {
    const rows = await this.query('SELECT * FROM ecf_documents WHERE business_id = 1 ORDER BY id DESC LIMIT 1');
    return rows[0] || null;
  }

  async getRetryableDocuments() {
    return this.query(
      `SELECT * FROM ecf_documents
       WHERE business_id = 1
         AND estado_dgii IN ('pendiente', 'error', 'error_auth', 'rechazado', 'error_xml', 'error_firma', 'error_consulta')
       ORDER BY id DESC
       LIMIT 100`
    );
  }

  async saveTestRun(testKey, status, summary, payload, environment = 'testecf') {
    await this.query(
      `INSERT INTO ecf_test_runs (business_id, test_key, environment, status, summary, payload_json, created_at)
       VALUES (1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [testKey, normalizeEnvironmentKey(environment), status, summary || '', payload ? JSON.stringify(payload) : null]
    );
  }

  async listRecentTestRuns(limit = 8) {
    return this.query('SELECT * FROM ecf_test_runs WHERE business_id = 1 ORDER BY id DESC LIMIT ?', [Number(limit || 8)]);
  }

  async saveAudit(entry) {
    await this.query(
      `INSERT INTO ecf_audit_log
       (business_id, user_id, user_name, user_role, branch_id, cash_register_id, sale_id, sequence_id, ecf_document_id, tipo_comprobante, encf, action_name, status, detail, response_payload, created_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        entry.userId || null,
        entry.userName || null,
        entry.userRole || null,
        entry.branchId || null,
        entry.cashRegisterId || null,
        entry.saleId || null,
        entry.sequenceId || null,
        entry.documentId || null,
        entry.tipoComprobante || null,
        entry.encf || null,
        entry.actionName,
        entry.status || 'info',
        entry.detail || null,
        entry.responsePayload ? JSON.stringify(entry.responsePayload) : null,
      ]
    ).catch(() => {});
  }

  async getSummaryReport() {
    return this.query(
      `SELECT estado_dgii, COUNT(*) AS total
       FROM ecf_documents
       WHERE business_id = 1
       GROUP BY estado_dgii
       ORDER BY estado_dgii`
    );
  }

  generateInternalToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  hashInternalToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
  }
}

module.exports = {
  EcfRepository,
  digitsOnly,
  parseEncfNumber,
  parseJson,
  toSqlDateTime,
};
