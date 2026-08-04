'use strict';

/**
 * fiscal-sequences.routes.js — Administración de NCF (Fase 1)
 * Factory pattern con inyección de dependencias, igual que tesoreria.routes.js.
 *
 * Registro manual y auditable de rangos NCF (serie B) autorizados por la
 * DGII. Reemplaza la fuente de verdad que usaba `ncf_sequences` (que queda
 * intacta en paralelo — ver ensureLegacyMigration) para que ningún rango se
 * pueda usar sin una autorización real registrada (referencia + documento
 * adjunto). No toca modules/ecf/ (e-CF ya certificado con DGII) salvo
 * columnas aditivas de autorización sobre ecf_sequences.
 *
 * Rutas:
 *  GET    /api/fiscal-sequences?series=&status=&branchId=
 *  GET    /api/fiscal-sequences/available?branchId=
 *  POST   /api/fiscal-sequences
 *  PUT    /api/fiscal-sequences/:id
 *  POST   /api/fiscal-sequences/:id/activate
 *  POST   /api/fiscal-sequences/:id/suspend
 *  POST   /api/fiscal-sequences/:id/change-next-number
 *  POST   /api/fiscal-sequences/:id/attachment
 *  GET    /api/fiscal-sequences/:id/history
 *  DELETE /api/fiscal-sequences/:id
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ATTACHMENT_MIME_EXTENSIONS = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/xml': 'xml', 'text/xml': 'xml',
  'text/csv': 'csv', 'application/csv': 'csv',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

const VALID_DOCUMENT_TYPES = ['B01', 'B02', 'B03', 'B04', 'B11', 'B12', 'B13', 'B14', 'B15', 'B16', 'B17'];
const DOCUMENT_LABELS = {
  B01: 'Crédito Fiscal', B02: 'Consumidor Final', B03: 'Nota de Débito', B04: 'Nota de Crédito',
  B11: 'Comprobante de Compras', B12: 'Registro Único de Ingresos', B13: 'Gastos Menores',
  B14: 'Régimen Especial', B15: 'Gubernamental', B16: 'Comprobante para Exportaciones',
  B17: 'Comprobante para Pagos al Exterior',
};
const ACTIVATABLE_STATUSES = ['pendiente', 'legacy_unverified'];
// Umbral por debajo del cual una secuencia 'activo' se muestra como
// "próxima a agotarse" en el panel (no se persiste, se calcula al listar).
const LOW_STOCK_THRESHOLD = 50;

async function hasColumn(query, tableName, columnName) {
  const rows = await query(`PRAGMA table_info(${tableName})`).catch(() => []);
  return rows.some((row) => String(row.name || row.Field || '').toLowerCase() === String(columnName).toLowerCase());
}

async function addColumnIfMissing(query, tableName, columnName, definition) {
  try {
    if (await hasColumn(query, tableName, columnName)) return;
    await query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  } catch (error) {
    const message = String(error?.message || '').toLowerCase();
    const isMissingTable = message.includes('no such table') || message.includes("doesn't exist");
    if (!isMissingTable) throw error;
  }
}

async function ensureSchema(query) {
  await query(`
    CREATE TABLE IF NOT EXISTS ncf_authorized_sequences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INT NOT NULL DEFAULT 1,
      branch_id INT DEFAULT NULL,
      series VARCHAR(1) NOT NULL DEFAULT 'B',
      document_type VARCHAR(5) NOT NULL,
      document_name VARCHAR(80) DEFAULT NULL,
      prefix VARCHAR(5) NOT NULL,
      start_number INT NOT NULL,
      end_number INT NOT NULL,
      next_number INT NOT NULL,
      last_used_number INT DEFAULT NULL,
      authorization_date DATE DEFAULT NULL,
      expiration_date DATE DEFAULT NULL,
      authorization_reference VARCHAR(60) DEFAULT NULL,
      environment VARCHAR(10) NOT NULL DEFAULT 'ncf',
      status VARCHAR(20) NOT NULL DEFAULT 'pendiente',
      authorization_file_url VARCHAR(255) DEFAULT NULL,
      notes TEXT DEFAULT NULL,
      created_by INT DEFAULT NULL,
      updated_by INT DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at DATETIME DEFAULT NULL,
      deleted_by INT DEFAULT NULL,
      deletion_reason VARCHAR(255) DEFAULT NULL,
      CONSTRAINT fk_ncf_authorized_sequences_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS ncf_authorized_sequence_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ncf_authorized_sequence_id INT NOT NULL,
      action VARCHAR(30) NOT NULL,
      reason VARCHAR(255) DEFAULT NULL,
      user_id INT DEFAULT NULL,
      user_name VARCHAR(120) DEFAULT NULL,
      ip_address VARCHAR(45) DEFAULT NULL,
      device_info VARCHAR(255) DEFAULT NULL,
      data_before TEXT DEFAULT NULL,
      data_after TEXT DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_fsa_sequence FOREIGN KEY (ncf_authorized_sequence_id) REFERENCES ncf_authorized_sequences(id) ON DELETE CASCADE
    )
  `);

  // Salvaguarda de reversión: mientras esté en 0, getNextNcfFromSequence
  // sigue leyendo ncf_sequences (comportamiento actual) aunque este módulo
  // ya esté desplegado. Se activa manualmente desde Configuración una vez
  // confirmado que las secuencias migradas están correctas.
  await addColumnIfMissing(query, 'config', 'ncf_authorized_sequences_v2_enabled', 'TINYINT(1) NOT NULL DEFAULT 0');

  await migrateLegacyNcfSequences(query);
}

// Copia una sola vez los rangos activos de ncf_sequences (sistema legacy)
// hacia ncf_authorized_sequences, marcados como 'legacy_unverified' porque nunca
// tuvieron una referencia de autorización DGII real asociada — el admin debe
// completarla y activarlos manualmente antes de poder usarlos (ver rechazo
// en el endpoint /activate). ncf_sequences NO se toca ni se borra.
// Idempotente: si ncf_authorized_sequences ya tiene filas, no vuelve a correr.
async function migrateLegacyNcfSequences(query) {
  const existing = await query('SELECT COUNT(*) AS c FROM ncf_authorized_sequences').catch(() => [{ c: 0 }]);
  if (Number(existing?.[0]?.c || 0) > 0) return;

  const legacyRows = await query('SELECT * FROM ncf_sequences WHERE activa = 1').catch(() => []);
  for (const row of legacyRows) {
    await query(
      `INSERT INTO ncf_authorized_sequences
         (business_id, branch_id, series, document_type, document_name, prefix,
          start_number, end_number, next_number, expiration_date, environment, status, notes, created_at, updated_at)
       VALUES (?, ?, 'B', ?, ?, ?, 1, ?, ?, ?, 'ncf', 'legacy_unverified', ?, ?, ?)`,
      [
        row.business_id || 1, row.branch_id || null, row.ncf_type, DOCUMENT_LABELS[row.ncf_type] || row.ncf_type, row.ncf_type,
        row.maximo, row.siguiente_numero, row.fecha_vencimiento || null,
        'Migrado automáticamente desde ncf_sequences — pendiente de confirmar autorización DGII real.',
        row.created_at, row.updated_at,
      ]
    );
  }
}

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function mapSequence(row) {
  const totalAuthorized = row.end_number - row.start_number + 1;
  const totalUsed = Math.max(0, row.next_number - row.start_number);
  const totalAvailable = Math.max(0, row.end_number - row.next_number + 1);
  const percentUsed = totalAuthorized > 0 ? Math.min(100, Math.round((totalUsed / totalAuthorized) * 100)) : 0;
  let effectiveStatus = row.status;
  if (row.status === 'activo') {
    if (row.expiration_date && String(row.expiration_date) < new Date().toISOString().slice(0, 10)) {
      effectiveStatus = 'vencido';
    } else if (totalAvailable <= 0) {
      effectiveStatus = 'agotado';
    } else if (totalAvailable <= LOW_STOCK_THRESHOLD) {
      effectiveStatus = 'proximo_agotarse';
    }
  }
  return {
    id: row.id,
    businessId: row.business_id,
    branchId: row.branch_id,
    branchName: row.branch_name || (row.branch_id ? null : 'Global'),
    series: row.series,
    documentType: row.document_type,
    documentName: row.document_name || DOCUMENT_LABELS[row.document_type] || row.document_type,
    prefix: row.prefix,
    startNumber: row.start_number,
    endNumber: row.end_number,
    nextNumber: row.next_number,
    lastUsedNumber: row.last_used_number,
    totalAuthorized, totalUsed, totalAvailable, percentUsed,
    authorizationDate: row.authorization_date,
    expirationDate: row.expiration_date,
    authorizationReference: row.authorization_reference,
    environment: row.environment,
    status: row.status,
    effectiveStatus,
    authorizationFileUrl: row.authorization_file_url,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readOnly: false,
  };
}

// Mapea una fila de ecf_sequences (módulo e-CF certificado) al mismo shape
// que mapSequence, marcada readOnly — el panel unificado la muestra pero no
// ofrece editar/activar/suspender sobre ella (eso sigue en js/fiscal-ecf.js).
function mapEcfSequenceReadOnly(row) {
  const totalAuthorized = Number(row.numero_final) - Number(row.numero_inicial) + 1;
  const totalUsed = Math.max(0, Number(row.proximo_numero) - Number(row.numero_inicial));
  const totalAvailable = Math.max(0, Number(row.numero_final) - Number(row.proximo_numero) + 1);
  const percentUsed = totalAuthorized > 0 ? Math.min(100, Math.round((totalUsed / totalAuthorized) * 100)) : 0;
  return {
    id: `ecf-${row.id}`,
    businessId: row.business_id,
    branchId: row.branch_id,
    branchName: row.branch_name || (row.branch_id ? null : 'Global'),
    series: 'E',
    documentType: row.tipo_comprobante,
    documentName: row.tipo_comprobante,
    prefix: row.tipo_comprobante,
    startNumber: Number(row.numero_inicial),
    endNumber: Number(row.numero_final),
    nextNumber: Number(row.proximo_numero),
    lastUsedNumber: null,
    totalAuthorized, totalUsed, totalAvailable, percentUsed,
    authorizationDate: row.fecha_autorizacion,
    expirationDate: row.fecha_vencimiento,
    authorizationReference: row.authorization_reference || null,
    environment: 'e-cf',
    status: row.activo ? 'activo' : 'suspendido',
    effectiveStatus: row.activo ? 'activo' : 'suspendido',
    authorizationFileUrl: row.authorization_file_url || null,
    notes: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readOnly: true,
  };
}

// Dos rangos del mismo tipo de comprobante se cruzan si comparten sucursal
// (o si cualquiera de los dos es global, ya que un rango global cubre todas
// las sucursales) y sus intervalos numéricos se solapan. A nivel de módulo
// (no dentro del factory del router) para que server/sync/apply-pending-ncf.js
// también la reuse sin duplicar el SQL.
async function findOverlappingSequence(query, { documentType, branchId, startNumber, endNumber, excludeId }) {
  const params = [documentType, branchId, branchId, endNumber, startNumber];
  let sql = `
    SELECT * FROM ncf_authorized_sequences
    WHERE document_type = ? AND deleted_at IS NULL AND status IN ('activo', 'pendiente', 'legacy_unverified')
      AND (? IS NULL OR branch_id IS NULL OR branch_id = ?)
      AND NOT (end_number < ? OR start_number > ?)
  `;
  if (excludeId) { sql += ' AND id <> ?'; params.push(excludeId); }
  const rows = await query(sql, params);
  return rows[0] || null;
}

function createFiscalSequencesRouter({
  query, withTransaction, resolveRequestActorUser, userRoleHasPermission, writeAuditLog, verifyUserPassword, getUserScopeBranchId,
  isGlobalAdministratorUser, isBranchAdministratorUser,
  attachmentsDir, attachmentsWebPath = '/uploads/comprobantes-fiscales', isMysqlDeployment,
}) {
  const router = express.Router();

  function actorName(actor) {
    return actor?.usuario || actor?.nombre || null;
  }

  function roleCodeOf(actor) {
    return String(actor?.role_code || actor?.rol || '').trim().toLowerCase();
  }

  function isAdmin(actor) {
    return isGlobalAdministratorUser(actor) || isBranchAdministratorUser(actor);
  }

  async function verifyAdminPassword(actor, password) {
    if (!password) return false;
    return verifyUserPassword(actor?.id, password);
  }

  async function requireActor(req, res, next) {
    try {
      const actor = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
      req.authUser = actor;
      next();
    } catch (e) {
      res.status(e.statusCode || 401).json({ error: e.message || 'Sesión inválida o expirada.' });
    }
  }
  router.use(requireActor);

  function requirePermission(permission) {
    return (req, res, next) => {
      if (isAdmin(req.authUser) || userRoleHasPermission(req.authUser, permission)) return next();
      res.status(403).json({ error: 'No tienes permiso para realizar esta acción sobre secuencias fiscales.' });
    };
  }

  // Los administradores de sucursal quedan limitados a su propia sucursal;
  // el administrador general y quienes tengan permiso explícito ven todo.
  function resolveBranchFilter(actor, requestedBranchId) {
    if (isGlobalAdministratorUser(actor) || userRoleHasPermission(actor, 'ncf.assign_branch')) {
      return requestedBranchId ? Number(requestedBranchId) : null;
    }
    const scopedBranchId = getUserScopeBranchId(actor);
    if (!scopedBranchId) return requestedBranchId ? Number(requestedBranchId) : null;
    if (requestedBranchId && Number(requestedBranchId) !== Number(scopedBranchId)) {
      throw httpError('No puedes operar fuera de tu sucursal.', 403);
    }
    return Number(scopedBranchId);
  }

  async function recordAudit(query, { fiscalSequenceId, action, reason, actor, req, dataBefore, dataAfter }) {
    await query(
      `INSERT INTO ncf_authorized_sequence_audit
         (ncf_authorized_sequence_id, action, reason, user_id, user_name, ip_address, device_info, data_before, data_after)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fiscalSequenceId, action, reason || null, actor?.id || null, actorName(actor),
        req?.ip || null, req?.headers?.['user-agent'] || null,
        dataBefore ? JSON.stringify(dataBefore) : null, dataAfter ? JSON.stringify(dataAfter) : null,
      ]
    );
    await writeAuditLog({
      userId: actor?.id, userName: actorName(actor), userRole: roleCodeOf(actor),
      moduleName: 'Secuencias Fiscales', actionName: action, detail: JSON.stringify({ fiscalSequenceId, reason: reason || '' }),
    });
  }

  // ── Listado ────────────────────────────────────────────────────────────

  // Mientras config.ncf_authorized_sequences_v2_enabled esté en 0 (salvaguarda de
  // reversión de getNextNcfFromSequence, ver server.js), el cajero debe
  // seguir viendo los tipos activos del sistema LEGACY (ncf_sequences) —
  // si no, el panel mostraría "sin comprobantes disponibles" aunque el
  // backend todavía esté facturando con normalidad contra ncf_sequences.
  router.get('/available', async (req, res) => {
    try {
      const actor = req.authUser;
      const requestedBranchId = req.query.branchId ? Number(req.query.branchId) : null;
      const branchId = getUserScopeBranchId(actor) || requestedBranchId;

      const [cfg] = await query('SELECT ncf_authorized_sequences_v2_enabled FROM config WHERE id = 1 LIMIT 1');
      if (!cfg || !Number(cfg.ncf_authorized_sequences_v2_enabled)) {
        const legacyRows = await query(
          `SELECT ncf_type FROM ncf_sequences
           WHERE activa = 1 AND siguiente_numero <= maximo
             AND (? IS NULL OR branch_id IS NULL OR branch_id = ?)
           ORDER BY ncf_type`,
          [branchId, branchId]
        );
        return res.json(legacyRows.map((r) => ({ documentType: r.ncf_type, documentName: DOCUMENT_LABELS[r.ncf_type] || r.ncf_type })));
      }

      const rows = await query(
        `SELECT document_type, document_name FROM ncf_authorized_sequences
         WHERE series = 'B' AND status = 'activo' AND deleted_at IS NULL
           AND next_number <= end_number
           AND (expiration_date IS NULL OR expiration_date >= date('now'))
           AND (? IS NULL OR branch_id IS NULL OR branch_id = ?)
         ORDER BY document_type`,
        [branchId, branchId]
      );
      res.json(rows.map((r) => ({
        documentType: r.document_type,
        documentName: r.document_name || DOCUMENT_LABELS[r.document_type] || r.document_type,
      })));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // Aplica ahora mismo la cola de secuencias NCF que el contador haya
  // registrado desde su Portal (normalmente se aplica sola en el próximo
  // abrir/cerrar caja o venta — esto es solo para no tener que esperar).
  router.post('/sync-contador', requirePermission('ncf.create'), async (req, res) => {
    try {
      const result = await require('../sync/apply-pending-ncf')
        .createApplyPendingNcfService({ query, withTransaction, writeAuditLog, isMysqlDeployment, attachmentsDir, attachmentsWebPath })
        .applyPendingNcfRequests();
      if (!result.ok) return res.status(502).json({ error: result.reason || 'No se pudo sincronizar.' });
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/', requirePermission('ncf.view'), async (req, res) => {
    try {
      const branchId = resolveBranchFilter(req.authUser, req.query.branchId ? Number(req.query.branchId) : null);
      const series = req.query.series ? String(req.query.series).toUpperCase() : null;
      const status = req.query.status || null;

      // Serie E (e-CF) es de SOLO LECTURA en este panel — se lee directo de
      // ecf_sequences (módulo ya certificado con DGII, modules/ecf/) sin que
      // este router escriba ahí. Solo da visibilidad unificada; editar,
      // activar o suspender una secuencia e-CF sigue haciéndose desde
      // js/fiscal-ecf.js como hoy.
      if (series === 'E') {
        const ecfConditions = ['1=1'];
        const ecfParams = [];
        if (branchId !== null) { ecfConditions.push('(es.branch_id = ? OR es.branch_id IS NULL)'); ecfParams.push(branchId); }
        const ecfRows = await query(
          `SELECT es.*, b.nombre AS branch_name FROM ecf_sequences es
           LEFT JOIN branches b ON b.id = es.branch_id
           WHERE ${ecfConditions.join(' AND ')}
           ORDER BY es.tipo_comprobante, es.branch_id`,
          ecfParams
        );
        return res.json(ecfRows.map(mapEcfSequenceReadOnly));
      }

      const conditions = ['fs.deleted_at IS NULL'];
      const params = [];
      if (branchId !== null) { conditions.push('(fs.branch_id = ? OR fs.branch_id IS NULL)'); params.push(branchId); }
      if (series) { conditions.push('fs.series = ?'); params.push(series); }
      if (status) { conditions.push('fs.status = ?'); params.push(status); }
      const rows = await query(
        `SELECT fs.*, b.nombre AS branch_name FROM ncf_authorized_sequences fs
         LEFT JOIN branches b ON b.id = fs.branch_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY fs.document_type, fs.branch_id`,
        params
      );
      res.json(rows.map(mapSequence));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.get('/:id/history', requirePermission('ncf.view_history'), async (req, res) => {
    try {
      const rows = await query('SELECT * FROM ncf_authorized_sequence_audit WHERE ncf_authorized_sequence_id = ? ORDER BY created_at DESC', [req.params.id]);
      res.json(rows.map((r) => ({
        id: r.id, action: r.action, reason: r.reason, userName: r.user_name,
        ipAddress: r.ip_address, deviceInfo: r.device_info,
        dataBefore: r.data_before ? JSON.parse(r.data_before) : null,
        dataAfter: r.data_after ? JSON.parse(r.data_after) : null,
        createdAt: r.created_at,
      })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Crear / editar ─────────────────────────────────────────────────────

  router.post('/', requirePermission('ncf.create'), async (req, res) => {
    try {
      const actor = req.authUser;
      const b = req.body || {};
      const documentType = String(b.documentType || '').toUpperCase().trim();
      if (!VALID_DOCUMENT_TYPES.includes(documentType)) return res.status(400).json({ error: 'Tipo de comprobante inválido.' });

      const branchId = resolveBranchFilter(actor, b.branchId ? Number(b.branchId) : null);
      const startNumber = Number(b.startNumber);
      const endNumber = Number(b.endNumber);
      if (!Number.isFinite(startNumber) || !Number.isFinite(endNumber) || startNumber < 1) {
        return res.status(400).json({ error: 'El número inicial y final deben ser válidos.' });
      }
      if (startNumber > endNumber) {
        return res.status(400).json({ error: 'El número inicial no puede ser mayor que el número final.' });
      }
      const nextNumber = b.nextNumber ? Number(b.nextNumber) : startNumber;
      if (!Number.isFinite(nextNumber) || nextNumber < startNumber || nextNumber > endNumber + 1) {
        return res.status(400).json({ error: 'El próximo número debe estar dentro del rango autorizado.' });
      }

      const duplicate = await query(
        `SELECT id FROM ncf_authorized_sequences
         WHERE document_type = ? AND ((branch_id = ?) OR (branch_id IS NULL AND ? IS NULL))
           AND start_number = ? AND end_number = ? AND deleted_at IS NULL`,
        [documentType, branchId, branchId, startNumber, endNumber]
      );
      if (duplicate[0]) return res.status(409).json({ error: 'Ya existe una secuencia registrada con este mismo rango.' });

      const overlap = await findOverlappingSequence(query, { documentType, branchId, startNumber, endNumber });
      if (overlap) {
        const fmt = (n) => `${documentType}${String(n).padStart(8, '0')}`;
        return res.status(409).json({
          error: `No se puede guardar este rango porque se cruza con la autorización ${fmt(overlap.start_number)}–${fmt(overlap.end_number)}.`,
        });
      }

      const authDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.authorizationDate || '')) ? b.authorizationDate : null;
      const expDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.expirationDate || '')) ? b.expirationDate : null;

      const result = await query(
        `INSERT INTO ncf_authorized_sequences
           (branch_id, series, document_type, document_name, prefix, start_number, end_number, next_number,
            authorization_date, expiration_date, authorization_reference, status, notes, created_by, updated_by)
         VALUES (?, 'B', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?)`,
        [
          branchId, documentType, b.documentName || DOCUMENT_LABELS[documentType] || documentType, documentType,
          startNumber, endNumber, nextNumber, authDate, expDate, String(b.authorizationReference || '').trim() || null,
          String(b.notes || '').trim() || null, actor.id, actor.id,
        ]
      );

      await recordAudit(query, { fiscalSequenceId: result.insertId, action: 'create', reason: 'Registro de nueva secuencia', actor, req, dataAfter: b });
      res.status(201).json({ ok: true, id: result.insertId });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.put('/:id', requirePermission('ncf.edit'), async (req, res) => {
    try {
      const actor = req.authUser;
      const [seq] = await query('SELECT * FROM ncf_authorized_sequences WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
      if (!seq) return res.status(404).json({ error: 'Secuencia no encontrada.' });
      resolveBranchFilter(actor, seq.branch_id);

      const b = req.body || {};
      const wasUsed = seq.next_number > seq.start_number;
      const startNumber = wasUsed ? seq.start_number : (b.startNumber !== undefined ? Number(b.startNumber) : seq.start_number);
      const endNumber = b.endNumber !== undefined ? Number(b.endNumber) : seq.end_number;
      if (wasUsed && b.endNumber !== undefined && Number(b.endNumber) < seq.next_number - 1) {
        return res.status(400).json({ error: 'No puedes reducir el rango por debajo de los números ya utilizados.' });
      }
      if (startNumber > endNumber) return res.status(400).json({ error: 'El número inicial no puede ser mayor que el número final.' });

      const authDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.authorizationDate || '')) ? b.authorizationDate : seq.authorization_date;
      const expDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.expirationDate || '')) ? b.expirationDate : seq.expiration_date;
      const dataBefore = { ...seq };

      await query(
        `UPDATE ncf_authorized_sequences SET
           document_name = ?, start_number = ?, end_number = ?, authorization_date = ?, expiration_date = ?,
           authorization_reference = ?, notes = ?, updated_by = ?, updated_at = datetime('now')
         WHERE id = ?`,
        [
          b.documentName || seq.document_name, startNumber, endNumber, authDate, expDate,
          b.authorizationReference !== undefined ? (String(b.authorizationReference || '').trim() || null) : seq.authorization_reference,
          b.notes !== undefined ? (String(b.notes || '').trim() || null) : seq.notes,
          actor.id, seq.id,
        ]
      );
      await recordAudit(query, { fiscalSequenceId: seq.id, action: 'edit', reason: b.reason || 'Edición de secuencia', actor, req, dataBefore, dataAfter: b });
      res.json({ ok: true });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ── Acciones ───────────────────────────────────────────────────────────

  router.post('/:id/activate', requirePermission('ncf.activate'), async (req, res) => {
    try {
      const actor = req.authUser;
      const [seq] = await query('SELECT * FROM ncf_authorized_sequences WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
      if (!seq) return res.status(404).json({ error: 'Secuencia no encontrada.' });
      if (!ACTIVATABLE_STATUSES.includes(seq.status)) {
        return res.status(409).json({ error: `No se puede activar una secuencia en estado "${seq.status}".` });
      }
      if (!seq.authorization_reference || !seq.authorization_file_url) {
        return res.status(400).json({ error: 'Debes registrar la referencia de autorización DGII y adjuntar el documento antes de activar esta secuencia.' });
      }
      await query("UPDATE ncf_authorized_sequences SET status = 'activo', updated_by = ?, updated_at = datetime('now') WHERE id = ?", [actor.id, seq.id]);
      await recordAudit(query, { fiscalSequenceId: seq.id, action: 'activate', reason: req.body?.reason, actor, req, dataBefore: { status: seq.status }, dataAfter: { status: 'activo' } });
      res.json({ ok: true });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.post('/:id/suspend', requirePermission('ncf.suspend'), async (req, res) => {
    try {
      const actor = req.authUser;
      const reason = String(req.body?.reason || '').trim();
      if (!reason) return res.status(400).json({ error: 'Debes indicar el motivo de la suspensión.' });
      const [seq] = await query('SELECT * FROM ncf_authorized_sequences WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
      if (!seq) return res.status(404).json({ error: 'Secuencia no encontrada.' });
      await query("UPDATE ncf_authorized_sequences SET status = 'suspendido', updated_by = ?, updated_at = datetime('now') WHERE id = ?", [actor.id, seq.id]);
      await recordAudit(query, { fiscalSequenceId: seq.id, action: 'suspend', reason, actor, req, dataBefore: { status: seq.status }, dataAfter: { status: 'suspendido' } });
      res.json({ ok: true });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.post('/:id/change-next-number', requirePermission('ncf.change_next_number'), async (req, res) => {
    try {
      const actor = req.authUser;
      const { password, reason, newNumber } = req.body || {};
      if (!password) return res.status(400).json({ error: 'Debes confirmar tu contraseña.' });
      if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'Debes indicar el motivo del cambio.' });
      if (!(await verifyAdminPassword(actor, password))) return res.status(403).json({ error: 'Contraseña incorrecta.' });

      const [seq] = await query('SELECT * FROM ncf_authorized_sequences WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
      if (!seq) return res.status(404).json({ error: 'Secuencia no encontrada.' });
      const nn = Number(newNumber);
      if (!Number.isFinite(nn) || nn < seq.start_number || nn > seq.end_number + 1) {
        return res.status(400).json({ error: 'El nuevo número debe estar dentro del rango autorizado.' });
      }

      await query("UPDATE ncf_authorized_sequences SET next_number = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?", [nn, actor.id, seq.id]);
      await recordAudit(query, {
        fiscalSequenceId: seq.id, action: 'change_next_number', reason: String(reason).trim(), actor, req,
        dataBefore: { next_number: seq.next_number }, dataAfter: { next_number: nn },
      });
      res.json({ ok: true });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.post('/:id/attachment', requirePermission('ncf.upload_authorization'), async (req, res) => {
    const { fileData } = req.body || {};
    if (!fileData) return res.status(400).json({ error: 'No se recibió ningún archivo.' });
    if (!attachmentsDir) return res.status(500).json({ error: 'El directorio de comprobantes no está configurado.' });
    try {
      const actor = req.authUser;
      const [seq] = await query('SELECT * FROM ncf_authorized_sequences WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
      if (!seq) return res.status(404).json({ error: 'Secuencia no encontrada.' });

      const match = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/.exec(String(fileData));
      if (!match) return res.status(400).json({ error: 'El archivo debe ser un PDF, XML, CSV, XLS/XLSX o imagen válido.' });
      const ext = ATTACHMENT_MIME_EXTENSIONS[match[1].toLowerCase()];
      if (!ext) return res.status(400).json({ error: 'Tipo de archivo no permitido. Usa PDF, XML, CSV, XLS/XLSX o imagen.' });
      const buffer = Buffer.from(match[2], 'base64');
      if (buffer.length > MAX_ATTACHMENT_BYTES) return res.status(400).json({ error: 'El archivo no puede superar 15 MB.' });

      const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12);
      const fileName = `ncf-${seq.id}-${hash}.${ext}`;
      fs.mkdirSync(attachmentsDir, { recursive: true });
      fs.writeFileSync(path.join(attachmentsDir, fileName), buffer);
      const authorizationFileUrl = `${attachmentsWebPath}/${fileName}`.replace(/\\/g, '/');

      await query("UPDATE ncf_authorized_sequences SET authorization_file_url = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?", [authorizationFileUrl, actor.id, seq.id]);
      await recordAudit(query, { fiscalSequenceId: seq.id, action: 'upload_document', reason: fileName, actor, req });
      res.json({ ok: true, authorizationFileUrl });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.delete('/:id', requirePermission('ncf.edit'), async (req, res) => {
    try {
      const actor = req.authUser;
      const [seq] = await query('SELECT * FROM ncf_authorized_sequences WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
      if (!seq) return res.status(404).json({ error: 'Secuencia no encontrada.' });
      if (seq.next_number !== seq.start_number) {
        return res.status(409).json({ error: 'Esta secuencia ya fue utilizada. Suspéndela en vez de eliminarla.' });
      }
      const reason = String(req.body?.reason || '').trim() || 'Eliminada sin uso previo.';
      await query("UPDATE ncf_authorized_sequences SET deleted_at = datetime('now'), deleted_by = ?, deletion_reason = ? WHERE id = ?", [actor.id, reason, seq.id]);
      await recordAudit(query, { fiscalSequenceId: seq.id, action: 'delete', reason, actor, req });
      res.json({ ok: true });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  return router;
}

const ALL_FISCAL_SEQUENCE_PERMISSIONS = [
  'ncf.view', 'ncf.create', 'ncf.edit', 'ncf.activate', 'ncf.suspend',
  'ncf.change_next_number', 'ncf.view_history', 'ncf.upload_authorization',
];

// Otorga los permisos nuevos al rol administrador_general si aún no los
// tiene explícitos (en la práctica ya tiene acceso total vía '*'; esto solo
// mantiene el patrón consistente con tesoreria.routes.js/rrhh.routes.js).
async function grantFiscalSequencesPermission(query) {
  const roles = await query("SELECT id, codigo, permisos FROM roles WHERE codigo = 'administrador_general'").catch(() => []);
  for (const role of roles) {
    let perms = [];
    try { perms = JSON.parse(role.permisos || '[]'); } catch (_) { perms = []; }
    if (!Array.isArray(perms)) perms = [];
    if (perms.includes('*')) continue;
    const missing = ALL_FISCAL_SEQUENCE_PERMISSIONS.filter((p) => !perms.includes(p));
    if (!missing.length) continue;
    await query('UPDATE roles SET permisos = ? WHERE id = ?', [JSON.stringify([...perms, ...missing]), role.id]).catch(() => {});
  }
}

async function ensureSchemaAndPermissions(query) {
  await ensureSchema(query);
  await grantFiscalSequencesPermission(query);
}

module.exports = {
  createFiscalSequencesRouter, ensureSchema: ensureSchemaAndPermissions,
  findOverlappingSequence, VALID_DOCUMENT_TYPES, ACTIVATABLE_STATUSES,
  ATTACHMENT_MIME_EXTENSIONS, MAX_ATTACHMENT_BYTES, mapSequence,
};
