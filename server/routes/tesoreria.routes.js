'use strict';

/**
 * tesoreria.routes.js — Caja General / Tesorería (Fase 1 + Fase 2)
 * Factory pattern con inyección de dependencias, igual que rrhh.routes.js.
 *
 * NO reemplaza la caja operativa (apertura/cierre/arqueo de turnos, que sigue
 * en server.js sin cambios). Este módulo solo concentra el dinero que la caja
 * operativa entrega al cerrar, más ingresos/gastos generales de la empresa.
 *
 * Fase 1: fondos + movimientos + balances, transferencia MANUAL desde un
 * cierre de caja, ingresos/gastos manuales con categorías, y anulación con
 * reverso (nunca se reescribe el historial).
 *
 * Fase 2 (agregado sobre lo anterior, sin tocar el comportamiento de Fase 1):
 * transferencias entre fondos y entre sucursales, transferencia automática
 * opcional desde cierres, pagos a suplidores/empleados integrados, aprobación
 * de movimientos por monto configurable, y distribución de un gasto
 * corporativo entre varias sucursales.
 *
 * Rutas:
 *  GET    /api/tesoreria/settings
 *  PUT    /api/tesoreria/settings
 *  GET    /api/tesoreria/dashboard?scope=consolidado|sucursal&branchId=
 *  GET    /api/tesoreria/funds?branchId=
 *  POST   /api/tesoreria/funds
 *  GET    /api/tesoreria/categories?kind=
 *  POST   /api/tesoreria/categories
 *  GET    /api/tesoreria/movements?desde=&hasta=&branchId=&fundId=&type=&categoryId=&status=&page=
 *  POST   /api/tesoreria/income
 *  POST   /api/tesoreria/expense               (soporta distribution[] entre sucursales)
 *  POST   /api/tesoreria/movements/:id/void
 *  POST   /api/tesoreria/movements/:id/approve
 *  POST   /api/tesoreria/movements/:id/reject
 *  GET    /api/tesoreria/closings/pending?branchId=
 *  POST   /api/tesoreria/closings/:cashSessionId/transfer
 *  POST   /api/tesoreria/fund-transfers
 *  POST   /api/tesoreria/branch-transfers
 *  GET    /api/tesoreria/branch-transfers/pending?branchId=
 *  POST   /api/tesoreria/branch-transfers/:id/confirm
 *  POST   /api/tesoreria/branch-transfers/:id/reject
 *  GET    /api/tesoreria/supplier-invoices/pending?supplierId=
 *  POST   /api/tesoreria/supplier-payments
 *  GET    /api/tesoreria/employees
 *  POST   /api/tesoreria/employee-payments
 *  POST   /api/tesoreria/movements/:id/attachment
 *  GET    /api/tesoreria/daily-closings?branchId=&desde=&hasta=
 *  GET    /api/tesoreria/daily-closings/:id
 *  GET    /api/tesoreria/reports/por-sucursal?branchId=&desde=&hasta=
 *  GET    /api/tesoreria/reports/gastos-por-categoria?branchId=&desde=&hasta=
 *  GET    /api/tesoreria/audit
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ATTACHMENT_MIME_EXTENSIONS = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf',
};
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

const FUND_TYPES = [
  'efectivo', 'banco', 'transferencias', 'tarjetas_pendientes', 'tarjetas_liquidadas',
  'cuentas_por_cobrar', 'caja_fuerte', 'fondo_operativo', 'otro'
];
const EXPENSE_MOVEMENT_TYPES = ['gasto', 'retiro_propietario'];
const DISTRIBUTION_METHODS = ['porcentaje', 'monto', 'igual'];
const EMPLOYEE_PAYMENT_CONCEPTS = ['salario', 'adelanto', 'bono', 'comision', 'viaticos', 'otro'];
// Todo movimiento que representa salida de dinero de la empresa (para reportes agregados).
const ALL_EXPENSE_MOVEMENT_TYPES = ['gasto', 'retiro_propietario', 'pago_suplidor', 'pago_empleado'];
const ALL_EXPENSE_TYPES_SQL = ALL_EXPENSE_MOVEMENT_TYPES.map((t) => `'${t}'`).join(',');

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
    CREATE TABLE IF NOT EXISTS treasury_funds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INT DEFAULT NULL,
      name VARCHAR(120) NOT NULL,
      fund_type VARCHAR(30) NOT NULL DEFAULT 'efectivo',
      currency VARCHAR(10) NOT NULL DEFAULT 'DOP',
      current_balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      status VARCHAR(20) NOT NULL DEFAULT 'activo',
      responsible_user_id INT DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT NULL,
      CONSTRAINT fk_treasury_funds_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL,
      CONSTRAINT fk_treasury_funds_user FOREIGN KEY (responsible_user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS treasury_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name VARCHAR(120) NOT NULL,
      kind VARCHAR(10) NOT NULL,
      scope VARCHAR(20) NOT NULL DEFAULT 'ambos',
      status VARCHAR(20) NOT NULL DEFAULT 'activo',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS treasury_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INT DEFAULT NULL,
      movement_type VARCHAR(30) NOT NULL,
      category_id INT DEFAULT NULL,
      description VARCHAR(255) DEFAULT NULL,
      amount DECIMAL(12,2) NOT NULL,
      payment_method VARCHAR(30) DEFAULT NULL,
      fund_origin_id INT DEFAULT NULL,
      fund_destination_id INT DEFAULT NULL,
      balance_anterior DECIMAL(12,2) DEFAULT NULL,
      balance_posterior DECIMAL(12,2) DEFAULT NULL,
      beneficiario_tipo VARCHAR(30) DEFAULT NULL,
      beneficiario_nombre VARCHAR(160) DEFAULT NULL,
      related_cash_session_id INT DEFAULT NULL,
      related_movement_id INT DEFAULT NULL,
      transfer_group_id VARCHAR(60) DEFAULT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'confirmado',
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      authorized_by_user_id INT DEFAULT NULL,
      authorized_by_user_name VARCHAR(120) DEFAULT NULL,
      document_reference VARCHAR(255) DEFAULT NULL,
      observaciones VARCHAR(255) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT NULL,
      CONSTRAINT fk_treasury_movements_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL,
      CONSTRAINT fk_treasury_movements_category FOREIGN KEY (category_id) REFERENCES treasury_categories(id) ON DELETE SET NULL,
      CONSTRAINT fk_treasury_movements_fund_origin FOREIGN KEY (fund_origin_id) REFERENCES treasury_funds(id) ON DELETE SET NULL,
      CONSTRAINT fk_treasury_movements_fund_dest FOREIGN KEY (fund_destination_id) REFERENCES treasury_funds(id) ON DELETE SET NULL,
      CONSTRAINT fk_treasury_movements_session FOREIGN KEY (related_cash_session_id) REFERENCES cash_sessions(id) ON DELETE SET NULL,
      CONSTRAINT fk_treasury_movements_related FOREIGN KEY (related_movement_id) REFERENCES treasury_movements(id) ON DELETE SET NULL,
      CONSTRAINT fk_treasury_movements_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT fk_treasury_movements_authorizer FOREIGN KEY (authorized_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS treasury_closing_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cash_session_id INT NOT NULL UNIQUE,
      branch_id INT DEFAULT NULL,
      cash_register_id INT DEFAULT NULL,
      expected_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      counted_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      difference_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      retained_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      transferred_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      status VARCHAR(30) NOT NULL DEFAULT 'transferido',
      transferred_by_user_id INT DEFAULT NULL,
      transferred_by_user_name VARCHAR(120) DEFAULT NULL,
      received_by_user_id INT DEFAULT NULL,
      received_by_user_name VARCHAR(120) DEFAULT NULL,
      observaciones VARCHAR(255) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_treasury_closing_session FOREIGN KEY (cash_session_id) REFERENCES cash_sessions(id) ON DELETE CASCADE,
      CONSTRAINT fk_treasury_closing_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS treasury_settings (
      id INTEGER PRIMARY KEY,
      enabled TINYINT(1) NOT NULL DEFAULT 0,
      show_button TINYINT(1) NOT NULL DEFAULT 1,
      allow_negative_balance TINYINT(1) NOT NULL DEFAULT 0,
      require_password_expenses TINYINT(1) NOT NULL DEFAULT 1,
      require_password_withdrawals TINYINT(1) NOT NULL DEFAULT 1,
      updated_at DATETIME DEFAULT NULL
    )
  `);
  await query(`
    INSERT OR IGNORE INTO treasury_settings (id, enabled, show_button, allow_negative_balance, require_password_expenses, require_password_withdrawals)
    VALUES (1, 0, 1, 0, 1, 1)
  `);

  // ── Fase 2 ────────────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS treasury_branch_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_branch_id INT NOT NULL,
      to_branch_id INT NOT NULL,
      from_fund_id INT NOT NULL,
      to_fund_id INT DEFAULT NULL,
      amount DECIMAL(12,2) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pendiente',
      transfer_group_id VARCHAR(60) DEFAULT NULL,
      outgoing_movement_id INT DEFAULT NULL,
      incoming_movement_id INT DEFAULT NULL,
      sent_by_user_id INT DEFAULT NULL,
      sent_by_user_name VARCHAR(120) DEFAULT NULL,
      received_by_user_id INT DEFAULT NULL,
      received_by_user_name VARCHAR(120) DEFAULT NULL,
      observaciones VARCHAR(255) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME DEFAULT NULL,
      CONSTRAINT fk_tbt_from_branch FOREIGN KEY (from_branch_id) REFERENCES branches(id) ON DELETE CASCADE,
      CONSTRAINT fk_tbt_to_branch FOREIGN KEY (to_branch_id) REFERENCES branches(id) ON DELETE CASCADE,
      CONSTRAINT fk_tbt_from_fund FOREIGN KEY (from_fund_id) REFERENCES treasury_funds(id) ON DELETE RESTRICT,
      CONSTRAINT fk_tbt_to_fund FOREIGN KEY (to_fund_id) REFERENCES treasury_funds(id) ON DELETE SET NULL,
      CONSTRAINT fk_tbt_outgoing FOREIGN KEY (outgoing_movement_id) REFERENCES treasury_movements(id) ON DELETE SET NULL,
      CONSTRAINT fk_tbt_incoming FOREIGN KEY (incoming_movement_id) REFERENCES treasury_movements(id) ON DELETE SET NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS treasury_movement_distributions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      movement_id INT NOT NULL,
      branch_id INT NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      percentage DECIMAL(6,2) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_tmd_movement FOREIGN KEY (movement_id) REFERENCES treasury_movements(id) ON DELETE CASCADE,
      CONSTRAINT fk_tmd_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
    )
  `);

  // Snapshot informativo (no mueve dinero) generado automáticamente cuando
  // cierra el ÚLTIMO turno abierto de una sucursal en un día operativo —
  // agrega ventas por vendedor + gastos de todos los turnos/cajas de ese día.
  await query(`
    CREATE TABLE IF NOT EXISTS treasury_daily_closings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INT NOT NULL,
      operative_date DATE NOT NULL,
      total_facturas INT NOT NULL DEFAULT 0,
      total_ventas DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      total_efectivo DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      total_tarjeta DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      total_transferencia DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      total_credito DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      total_gastos DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      cash_sessions_count INT NOT NULL DEFAULT 0,
      vendor_breakdown LONGTEXT DEFAULT NULL,
      generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (branch_id, operative_date),
      CONSTRAINT fk_tdc_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
    )
  `);

  await addColumnIfMissing(query, 'treasury_settings', 'approval_threshold_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
  await addColumnIfMissing(query, 'treasury_settings', 'auto_transfer_enabled', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing(query, 'treasury_settings', 'auto_transfer_deduct_change_fund', 'TINYINT(1) NOT NULL DEFAULT 1');
  await addColumnIfMissing(query, 'treasury_funds', 'is_default_for_type', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing(query, 'treasury_movements', 'beneficiario_id', 'INT DEFAULT NULL');

  await grantTesoreriaPermission(query);
}

const ALL_TESORERIA_PERMISSIONS = [
  'ver_caja_general', 'ver_todas_sucursales_caja_general', 'registrar_ingresos_caja_general',
  'registrar_gastos_caja_general', 'transferir_cierres_caja_general', 'anular_movimientos_caja_general',
  'exportar_caja_general', 'modificar_configuracion_caja_general', 'ver_auditoria_caja_general',
  'transferir_fondos_caja_general', 'transferir_entre_sucursales_caja_general', 'recibir_transferencias_caja_general',
  'pagar_suplidores_caja_general', 'pagar_empleados_caja_general',
  'aprobar_movimientos_caja_general', 'rechazar_movimientos_caja_general',
];

// Otorga todos los permisos de Caja General al rol administrador_general si
// aún no los tiene explícitos (en la práctica ya tiene acceso total vía '*',
// esto solo mantiene el patrón consistente con rrhh.routes.js). Idempotente.
async function grantTesoreriaPermission(query) {
  const roles = await query(
    "SELECT id, codigo, permisos FROM roles WHERE codigo = 'administrador_general'"
  ).catch(() => []);
  for (const role of roles) {
    let perms = [];
    try { perms = JSON.parse(role.permisos || '[]'); } catch (_) { perms = []; }
    if (!Array.isArray(perms)) perms = [];
    if (perms.includes('*')) continue;
    const missing = ALL_TESORERIA_PERMISSIONS.filter((p) => !perms.includes(p));
    if (!missing.length) continue;
    await query('UPDATE roles SET permisos = ? WHERE id = ?', [JSON.stringify([...perms, ...missing]), role.id]).catch(() => {});
  }
}

function mapFund(row) {
  return {
    id: row.id,
    branchId: row.branch_id,
    name: row.name,
    fundType: row.fund_type,
    currency: row.currency,
    currentBalance: Number(row.current_balance || 0),
    status: row.status,
    isDefaultForType: Boolean(row.is_default_for_type),
    responsibleUserId: row.responsible_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCategory(row) {
  return { id: row.id, name: row.name, kind: row.kind, scope: row.scope, status: row.status };
}

function mapMovement(row) {
  return {
    id: row.id,
    branchId: row.branch_id,
    movementType: row.movement_type,
    categoryId: row.category_id,
    description: row.description || '',
    amount: Number(row.amount || 0),
    paymentMethod: row.payment_method,
    fundOriginId: row.fund_origin_id,
    fundDestinationId: row.fund_destination_id,
    balanceAnterior: row.balance_anterior === null ? null : Number(row.balance_anterior),
    balancePosterior: row.balance_posterior === null ? null : Number(row.balance_posterior),
    beneficiarioTipo: row.beneficiario_tipo,
    beneficiarioId: row.beneficiario_id,
    beneficiarioNombre: row.beneficiario_nombre,
    relatedCashSessionId: row.related_cash_session_id,
    relatedMovementId: row.related_movement_id,
    transferGroupId: row.transfer_group_id,
    status: row.status,
    createdByUserName: row.created_by_user_name,
    authorizedByUserName: row.authorized_by_user_name,
    documentReference: row.document_reference || '',
    observaciones: row.observaciones || '',
    createdAt: row.created_at,
  };
}

function mapClosingTransfer(row) {
  return {
    id: row.id,
    cashSessionId: row.cash_session_id,
    branchId: row.branch_id,
    cashRegisterId: row.cash_register_id,
    expectedAmount: Number(row.expected_amount || 0),
    countedAmount: Number(row.counted_amount || 0),
    differenceAmount: Number(row.difference_amount || 0),
    retainedAmount: Number(row.retained_amount || 0),
    transferredAmount: Number(row.transferred_amount || 0),
    status: row.status,
    transferredByUserName: row.transferred_by_user_name,
    observaciones: row.observaciones || '',
    createdAt: row.created_at,
  };
}

function mapBranchTransfer(row) {
  return {
    id: row.id,
    fromBranchId: row.from_branch_id,
    toBranchId: row.to_branch_id,
    fromFundId: row.from_fund_id,
    toFundId: row.to_fund_id,
    amount: Number(row.amount || 0),
    status: row.status,
    sentByUserName: row.sent_by_user_name,
    receivedByUserName: row.received_by_user_name,
    observaciones: row.observaciones || '',
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createTesoreriaRouter({
  query, resolveRequestActorUser, userRoleHasPermission, writeAuditLog, withTransaction, verifyUserPassword, getUserScopeBranchId,
  attachmentsDir, attachmentsWebPath = '/uploads/comprobantes', isMysqlDeployment,
}) {
  const router = express.Router();

  function roleCodeOf(actor) {
    return String(actor?.role_code || actor?.rol || '').trim().toLowerCase();
  }

  function isAdminGeneral(actor) {
    return roleCodeOf(actor) === 'administrador_general';
  }

  function canView(actor) {
    return isAdminGeneral(actor) || userRoleHasPermission(actor, 'ver_caja_general');
  }

  function canViewAllBranches(actor) {
    return isAdminGeneral(actor) || userRoleHasPermission(actor, 'ver_todas_sucursales_caja_general');
  }

  function actorName(actor) {
    return actor?.usuario || actor?.nombre || null;
  }

  // Resuelve a qué sucursal debe quedar limitada la consulta/acción.
  // Devuelve null cuando el actor puede ver todas las sucursales (consolidado).
  function resolveBranchScope(actor, requestedBranchId) {
    if (canViewAllBranches(actor)) {
      return requestedBranchId ? Number(requestedBranchId) : null;
    }
    const scopedBranchId = getUserScopeBranchId(actor);
    if (!scopedBranchId) {
      throw httpError('Tu usuario no tiene una sucursal asignada para Caja General.', 403);
    }
    if (requestedBranchId && Number(requestedBranchId) !== Number(scopedBranchId)) {
      throw httpError('No puedes ver la información de otra sucursal.', 403);
    }
    return Number(scopedBranchId);
  }

  async function getSettings(executor = { query }) {
    const [row] = await executor.query('SELECT * FROM treasury_settings WHERE id = 1 LIMIT 1');
    return row || {
      enabled: 0, show_button: 1, allow_negative_balance: 0, require_password_expenses: 1, require_password_withdrawals: 1,
      approval_threshold_amount: 0, auto_transfer_enabled: 0, auto_transfer_deduct_change_fund: 1,
    };
  }

  async function requireEnabled(res) {
    const settings = await getSettings();
    if (!Number(settings.enabled)) {
      res.status(403).json({ error: 'Caja General está desactivada en Configuración.' });
      return null;
    }
    return settings;
  }

  // Verifica la propia contraseña de inicio de sesión del actor que hace la
  // acción (no una clave maestra aparte) — cada administrador confirma con su
  // propia cuenta.
  async function verifyAdminPassword(actor, password) {
    if (!password) return false;
    return verifyUserPassword(actor?.id, password);
  }

  async function requireTesoreria(req, res, next) {
    try {
      const actor = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
      if (!canView(actor)) {
        return res.status(403).json({ error: 'No tienes permiso para acceder a Caja General.' });
      }
      req.authUser = actor;
      next();
    } catch (e) {
      res.status(e.statusCode || 401).json({ error: e.message || 'Sesión inválida o expirada.' });
    }
  }

  router.use(requireTesoreria);

  function requirePermission(permission) {
    return (req, res, next) => {
      if (isAdminGeneral(req.authUser) || userRoleHasPermission(req.authUser, permission)) return next();
      res.status(403).json({ error: 'No tienes permiso para realizar esta acción en Caja General.' });
    };
  }

  // Actualiza el balance de un fondo dentro de la transacción actual y
  // devuelve balance_anterior/balance_posterior para dejarlos en el ledger.
  // FOR UPDATE (solo MySQL): esta función la comparten gasto, void, approve y
  // transferencias — sin el lock, dos operaciones concurrentes sobre el MISMO
  // fondo (ej. aprobar un gasto mientras se confirma una transferencia) leen
  // el mismo current_balance y la segunda UPDATE pisa el delta de la primera.
  async function applyFundDelta(conn, fundId, delta, settings) {
    const [fund] = await conn.query(
      `SELECT id, current_balance FROM treasury_funds WHERE id = ?${isMysqlDeployment() ? ' FOR UPDATE' : ''}`,
      [fundId]
    );
    if (!fund) throw httpError('El fondo indicado no existe.', 404);
    const balanceAnterior = Number(fund.current_balance || 0);
    const balancePosterior = Number((balanceAnterior + delta).toFixed(2));
    if (delta < 0 && balancePosterior < 0 && !Number(settings?.allow_negative_balance)) {
      throw httpError('Saldo insuficiente en el fondo. Actívalo en Configuración si necesitas permitir balance negativo.', 400);
    }
    await conn.query("UPDATE treasury_funds SET current_balance = ?, updated_at = datetime('now') WHERE id = ?", [balancePosterior, fundId]);
    return { balanceAnterior, balancePosterior };
  }

  // Si el monto supera el umbral configurado, el movimiento queda 'pendiente_aprobacion'
  // y el fondo NO se toca todavía (se aplica recién cuando alguien lo aprueba).
  function needsApproval(amount, settings) {
    const threshold = Number(settings?.approval_threshold_amount || 0);
    return threshold > 0 && Number(amount) >= threshold;
  }

  async function applyOrDeferFundDelta(conn, fundId, delta, settings, deferred) {
    if (!deferred) return applyFundDelta(conn, fundId, delta, settings);
    const [fund] = await conn.query('SELECT current_balance FROM treasury_funds WHERE id = ?', [fundId]);
    if (!fund) throw httpError('El fondo indicado no existe.', 404);
    const balance = Number(fund.current_balance || 0);
    return { balanceAnterior: balance, balancePosterior: balance };
  }

  // ── Configuración ────────────────────────────────────────────────────────

  router.get('/settings', async (req, res) => {
    try {
      const settings = await getSettings();
      res.json({
        enabled: Boolean(settings.enabled),
        showButton: Boolean(settings.show_button),
        allowNegativeBalance: Boolean(settings.allow_negative_balance),
        requirePasswordExpenses: Boolean(settings.require_password_expenses),
        requirePasswordWithdrawals: Boolean(settings.require_password_withdrawals),
        approvalThresholdAmount: Number(settings.approval_threshold_amount || 0),
        autoTransferEnabled: Boolean(settings.auto_transfer_enabled),
        autoTransferDeductChangeFund: Boolean(settings.auto_transfer_deduct_change_fund),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/settings', requirePermission('modificar_configuracion_caja_general'), async (req, res) => {
    const b = req.body || {};
    try {
      await query(`
        UPDATE treasury_settings SET enabled=?, show_button=?, allow_negative_balance=?, require_password_expenses=?, require_password_withdrawals=?,
          approval_threshold_amount=?, auto_transfer_enabled=?, auto_transfer_deduct_change_fund=?, updated_at=datetime('now')
        WHERE id = 1
      `, [
        b.enabled ? 1 : 0,
        b.showButton === false ? 0 : 1,
        b.allowNegativeBalance ? 1 : 0,
        b.requirePasswordExpenses === false ? 0 : 1,
        b.requirePasswordWithdrawals === false ? 0 : 1,
        Number(b.approvalThresholdAmount || 0),
        b.autoTransferEnabled ? 1 : 0,
        b.autoTransferDeductChangeFund === false ? 0 : 1,
      ]);
      await writeAuditLog({
        userId: req.authUser.id, userName: actorName(req.authUser), userRole: roleCodeOf(req.authUser),
        moduleName: 'Tesoreria', actionName: 'Cambio de configuración', detail: JSON.stringify(b),
      });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Fondos ───────────────────────────────────────────────────────────────

  router.get('/funds', async (req, res) => {
    try {
      const branchScope = resolveBranchScope(req.authUser, req.query.branchId ? Number(req.query.branchId) : null);
      let sql = 'SELECT * FROM treasury_funds WHERE 1=1';
      const params = [];
      if (branchScope !== null) { sql += ' AND (branch_id = ? OR branch_id IS NULL)'; params.push(branchScope); }
      sql += ' ORDER BY branch_id IS NULL DESC, name ASC';
      const rows = await query(sql, params);
      res.json(rows.map(mapFund));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.post('/funds', requirePermission('modificar_configuracion_caja_general'), async (req, res) => {
    const { name, fundType, branchId, currency, isDefaultForType } = req.body || {};
    if (!name) return res.status(400).json({ error: 'El nombre del fondo es requerido.' });
    if (!FUND_TYPES.includes(fundType)) return res.status(400).json({ error: 'Tipo de fondo inválido.' });
    try {
      if (isDefaultForType && branchId) {
        // Solo puede haber un fondo default por tipo y sucursal (para la transferencia automática).
        await query('UPDATE treasury_funds SET is_default_for_type = 0 WHERE branch_id = ? AND fund_type = ?', [branchId, fundType]);
      }
      const { insertId } = await query(`
        INSERT INTO treasury_funds (branch_id, name, fund_type, currency, responsible_user_id, is_default_for_type)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [branchId || null, name, fundType, currency || 'DOP', req.authUser.id, isDefaultForType ? 1 : 0]);
      const [created] = await query('SELECT * FROM treasury_funds WHERE id=?', [insertId]);
      res.status(201).json(mapFund(created));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Categorías ───────────────────────────────────────────────────────────

  router.get('/categories', async (req, res) => {
    try {
      let sql = 'SELECT * FROM treasury_categories WHERE status = "activo"';
      const params = [];
      if (req.query.kind) { sql += ' AND kind = ?'; params.push(req.query.kind); }
      sql += ' ORDER BY name ASC';
      const rows = await query(sql, params);
      res.json(rows.map(mapCategory));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/categories', requirePermission('modificar_configuracion_caja_general'), async (req, res) => {
    const { name, kind, scope } = req.body || {};
    if (!name) return res.status(400).json({ error: 'El nombre de la categoría es requerido.' });
    if (!['ingreso', 'gasto'].includes(kind)) return res.status(400).json({ error: 'kind debe ser "ingreso" o "gasto".' });
    try {
      const { insertId } = await query(`
        INSERT INTO treasury_categories (name, kind, scope) VALUES (?, ?, ?)
      `, [name, kind, ['corporativo', 'sucursal', 'ambos'].includes(scope) ? scope : 'ambos']);
      const [created] = await query('SELECT * FROM treasury_categories WHERE id=?', [insertId]);
      res.status(201).json(mapCategory(created));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Dashboard ────────────────────────────────────────────────────────────

  router.get('/dashboard', async (req, res) => {
    try {
      const branchScope = resolveBranchScope(req.authUser, req.query.branchId ? Number(req.query.branchId) : null);
      let fundsSql = 'SELECT * FROM treasury_funds WHERE status = "activo"';
      const fundsParams = [];
      if (branchScope !== null) { fundsSql += ' AND (branch_id = ? OR branch_id IS NULL)'; fundsParams.push(branchScope); }
      const funds = await query(fundsSql, fundsParams);

      let movementsSql = `
        SELECT movement_type, amount, created_at FROM treasury_movements
        WHERE status = 'confirmado' AND created_at >= date('now', 'start of month')
      `;
      const movementsParams = [];
      if (branchScope !== null) { movementsSql += ' AND (branch_id = ? OR branch_id IS NULL)'; movementsParams.push(branchScope); }
      const monthMovements = await query(movementsSql, movementsParams);

      const todayStr = new Date().toISOString().slice(0, 10);
      let incomeToday = 0, incomeMonth = 0, expenseToday = 0, expenseMonth = 0;
      for (const m of monthMovements) {
        const amount = Number(m.amount || 0);
        const isToday = String(m.created_at || '').slice(0, 10) === todayStr;
        const isIncome = m.movement_type === 'ingreso' || m.movement_type === 'transferencia_cierre';
        const isExpense = ALL_EXPENSE_MOVEMENT_TYPES.includes(m.movement_type);
        if (isIncome) { incomeMonth += amount; if (isToday) incomeToday += amount; }
        if (isExpense) { expenseMonth += amount; if (isToday) expenseToday += amount; }
      }

      const recentSql = branchScope !== null
        ? 'SELECT * FROM treasury_movements WHERE (branch_id = ? OR branch_id IS NULL) ORDER BY created_at DESC LIMIT 10'
        : 'SELECT * FROM treasury_movements ORDER BY created_at DESC LIMIT 10';
      const recentMovements = await query(recentSql, branchScope !== null ? [branchScope] : []);

      const pendingSql = branchScope !== null
        ? "SELECT COUNT(*) AS total, COALESCE(SUM(amount),0) AS amount FROM treasury_movements WHERE status = 'pendiente_aprobacion' AND (branch_id = ? OR branch_id IS NULL)"
        : "SELECT COUNT(*) AS total, COALESCE(SUM(amount),0) AS amount FROM treasury_movements WHERE status = 'pendiente_aprobacion'";
      const [pending] = await query(pendingSql, branchScope !== null ? [branchScope] : []);

      // Últimos 30 días para los gráficos (ingresos vs gastos por día, gastos por categoría).
      let last30Sql = `
        SELECT tm.movement_type, tm.amount, tm.created_at, c.name AS category_name
        FROM treasury_movements tm LEFT JOIN treasury_categories c ON c.id = tm.category_id
        WHERE tm.status = 'confirmado' AND tm.created_at >= date('now', '-29 days')
      `;
      const last30Params = [];
      if (branchScope !== null) { last30Sql += ' AND (tm.branch_id = ? OR tm.branch_id IS NULL)'; last30Params.push(branchScope); }
      const last30Rows = await query(last30Sql, last30Params);

      const dailyMap = new Map();
      const categoryMap = new Map();
      for (let i = 29; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        dailyMap.set(d.toISOString().slice(0, 10), { date: d.toISOString().slice(0, 10), income: 0, expense: 0 });
      }
      for (const row of last30Rows) {
        const day = String(row.created_at || '').slice(0, 10);
        const amount = Number(row.amount || 0);
        const isIncome = row.movement_type === 'ingreso' || row.movement_type === 'transferencia_cierre';
        const isExpense = ALL_EXPENSE_MOVEMENT_TYPES.includes(row.movement_type);
        if (dailyMap.has(day)) {
          if (isIncome) dailyMap.get(day).income += amount;
          if (isExpense) dailyMap.get(day).expense += amount;
        }
        if (isExpense) {
          const catName = row.category_name || 'Sin categoría';
          categoryMap.set(catName, (categoryMap.get(catName) || 0) + amount);
        }
      }

      // Dinero por tipo de fondo (para el gráfico "Dinero por Fondo").
      const byFundTypeMap = new Map();
      for (const f of funds) {
        byFundTypeMap.set(f.fund_type, (byFundTypeMap.get(f.fund_type) || 0) + Number(f.current_balance || 0));
      }

      // Evolución del balance total (últimos 30 días) — se reconstruye desde el
      // historial completo de movimientos confirmados (los fondos siempre
      // empiezan en 0, así que la suma acumulada de deltas = balance real).
      let historySql = 'SELECT created_at, amount, fund_origin_id, fund_destination_id FROM treasury_movements WHERE status = \'confirmado\'';
      const historyParams = [];
      if (branchScope !== null) { historySql += ' AND (branch_id = ? OR branch_id IS NULL)'; historyParams.push(branchScope); }
      historySql += ' ORDER BY created_at ASC';
      const historyRows = await query(historySql, historyParams);
      const checkpoints = [];
      let running = 0;
      let lastDay = null;
      for (const m of historyRows) {
        const delta = (m.fund_destination_id ? Number(m.amount) : 0) - (m.fund_origin_id ? Number(m.amount) : 0);
        running = Number((running + delta).toFixed(2));
        const day = String(m.created_at || '').slice(0, 10);
        if (day === lastDay) { checkpoints[checkpoints.length - 1][1] = running; }
        else { checkpoints.push([day, running]); lastDay = day; }
      }
      const balanceEvolution = [];
      let checkpointIdx = 0;
      let carryBalance = 0;
      for (let i = 29; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const dayStr = d.toISOString().slice(0, 10);
        while (checkpointIdx < checkpoints.length && checkpoints[checkpointIdx][0] <= dayStr) {
          carryBalance = checkpoints[checkpointIdx][1];
          checkpointIdx++;
        }
        balanceEvolution.push({ date: dayStr, balance: carryBalance });
      }

      res.json({
        scope: branchScope !== null ? 'sucursal' : 'consolidado',
        branchId: branchScope,
        funds: funds.map(mapFund),
        totalBalance: funds.reduce((sum, f) => sum + Number(f.current_balance || 0), 0),
        incomeToday, incomeMonth, expenseToday, expenseMonth,
        pendingApprovalCount: Number(pending?.total || 0),
        pendingApprovalAmount: Number(pending?.amount || 0),
        dailySeries: Array.from(dailyMap.values()),
        byCategory: Array.from(categoryMap.entries()).map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total),
        byFundType: Array.from(byFundTypeMap.entries()).map(([type, total]) => ({ type, total })).sort((a, b) => b.total - a.total),
        balanceEvolution,
        recentMovements: recentMovements.map(mapMovement),
      });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ── Reportes agregados (gastos/ingresos/rentabilidad por sucursal, por categoría) ──

  // Ingresos, gastos (directos + distribuidos) y rentabilidad de cada sucursal
  // en un rango de fechas. "Gastos por sucursal" y "Rentabilidad por sucursal"
  // del pedido original son la misma agregación vista desde distintas columnas.
  router.get('/reports/por-sucursal', async (req, res) => {
    try {
      const branchScope = resolveBranchScope(req.authUser, req.query.branchId ? Number(req.query.branchId) : null);
      const desde = req.query.desde ? `${req.query.desde} 00:00:00` : '1970-01-01 00:00:00';
      const hasta = req.query.hasta ? `${req.query.hasta} 23:59:59` : '2999-12-31 23:59:59';

      const branches = await query(
        branchScope !== null ? 'SELECT id, nombre FROM branches WHERE id = ?' : 'SELECT id, nombre FROM branches ORDER BY nombre',
        branchScope !== null ? [branchScope] : []
      );

      const incomeRows = await query(`
        SELECT branch_id, COALESCE(SUM(amount), 0) AS total FROM treasury_movements
        WHERE status = 'confirmado' AND movement_type IN ('ingreso', 'transferencia_cierre')
          AND created_at BETWEEN ? AND ? AND branch_id IS NOT NULL
        GROUP BY branch_id
      `, [desde, hasta]);
      const directExpenseRows = await query(`
        SELECT branch_id, COALESCE(SUM(amount), 0) AS total FROM treasury_movements
        WHERE status = 'confirmado' AND movement_type IN (${ALL_EXPENSE_TYPES_SQL})
          AND created_at BETWEEN ? AND ? AND branch_id IS NOT NULL
        GROUP BY branch_id
      `, [desde, hasta]);
      const distributedExpenseRows = await query(`
        SELECT tmd.branch_id, COALESCE(SUM(tmd.amount), 0) AS total
        FROM treasury_movement_distributions tmd JOIN treasury_movements tm ON tm.id = tmd.movement_id
        WHERE tm.status = 'confirmado' AND tm.created_at BETWEEN ? AND ?
        GROUP BY tmd.branch_id
      `, [desde, hasta]);

      const incomeMap = new Map(incomeRows.map((r) => [Number(r.branch_id), Number(r.total)]));
      const directMap = new Map(directExpenseRows.map((r) => [Number(r.branch_id), Number(r.total)]));
      const distMap = new Map(distributedExpenseRows.map((r) => [Number(r.branch_id), Number(r.total)]));

      const result = branches.map((b) => {
        const ingresos = incomeMap.get(b.id) || 0;
        const gastosDirectos = directMap.get(b.id) || 0;
        const gastosDistribuidos = distMap.get(b.id) || 0;
        const gastosTotal = Number((gastosDirectos + gastosDistribuidos).toFixed(2));
        return {
          branchId: b.id, branchName: b.nombre, ingresos,
          gastosDirectos, gastosDistribuidos, gastosTotal,
          rentabilidad: Number((ingresos - gastosTotal).toFixed(2)),
        };
      });
      res.json(result);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // Gastos por categoría con rango de fechas libre (el dashboard solo cubre los últimos 30 días).
  router.get('/reports/gastos-por-categoria', async (req, res) => {
    try {
      const branchScope = resolveBranchScope(req.authUser, req.query.branchId ? Number(req.query.branchId) : null);
      const desde = req.query.desde ? `${req.query.desde} 00:00:00` : '1970-01-01 00:00:00';
      const hasta = req.query.hasta ? `${req.query.hasta} 23:59:59` : '2999-12-31 23:59:59';
      let sql = `
        SELECT COALESCE(c.name, 'Sin categoría') AS name, COALESCE(SUM(tm.amount), 0) AS total
        FROM treasury_movements tm LEFT JOIN treasury_categories c ON c.id = tm.category_id
        WHERE tm.status = 'confirmado' AND tm.movement_type IN (${ALL_EXPENSE_TYPES_SQL})
          AND tm.created_at BETWEEN ? AND ?
      `;
      const params = [desde, hasta];
      if (branchScope !== null) { sql += ' AND (tm.branch_id = ? OR tm.branch_id IS NULL)'; params.push(branchScope); }
      sql += ' GROUP BY name ORDER BY total DESC';
      const rows = await query(sql, params);
      res.json(rows.map((r) => ({ name: r.name, total: Number(r.total || 0) })));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ── Historial de movimientos ─────────────────────────────────────────────

  router.get('/movements', async (req, res) => {
    try {
      const branchScope = resolveBranchScope(req.authUser, req.query.branchId ? Number(req.query.branchId) : null);
      const q = req.query || {};
      let sql = 'SELECT * FROM treasury_movements WHERE 1=1';
      const params = [];
      if (branchScope !== null) { sql += ' AND (branch_id = ? OR branch_id IS NULL)'; params.push(branchScope); }
      if (q.desde) { sql += ' AND created_at >= ?'; params.push(q.desde); }
      if (q.hasta) { sql += ' AND created_at <= ?'; params.push(`${q.hasta} 23:59:59`); }
      if (q.fundId) { sql += ' AND (fund_origin_id = ? OR fund_destination_id = ?)'; params.push(q.fundId, q.fundId); }
      if (q.type) { sql += ' AND movement_type = ?'; params.push(q.type); }
      if (q.categoryId) { sql += ' AND category_id = ?'; params.push(q.categoryId); }
      if (q.status) { sql += ' AND status = ?'; params.push(q.status); }
      sql += ' ORDER BY created_at DESC, id DESC';
      const page = Math.max(1, Number(q.page || 1));
      const pageSize = Math.min(200, Math.max(1, Number(q.pageSize || 50)));
      sql += ' LIMIT ? OFFSET ?';
      params.push(pageSize, (page - 1) * pageSize);
      const rows = await query(sql, params);
      res.json(rows.map(mapMovement));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ── Ingresos ─────────────────────────────────────────────────────────────

  router.post('/income', requirePermission('registrar_ingresos_caja_general'), async (req, res) => {
    const enabledSettings = await requireEnabled(res);
    if (!enabledSettings) return;
    const b = req.body || {};
    const amount = Number(b.amount || 0);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });
    if (!b.fundDestinationId) return res.status(400).json({ error: 'Debes indicar el fondo de destino.' });
    try {
      const branchScope = resolveBranchScope(req.authUser, b.branchId ? Number(b.branchId) : null);
      const actor = req.authUser;
      const deferred = needsApproval(amount, enabledSettings);
      const status = deferred ? 'pendiente_aprobacion' : 'confirmado';
      const result = await withTransaction(async (conn) => {
        const { balanceAnterior, balancePosterior } = await applyOrDeferFundDelta(conn, b.fundDestinationId, amount, enabledSettings, deferred);
        const { insertId } = await conn.query(`
          INSERT INTO treasury_movements (
            branch_id, movement_type, category_id, description, amount, payment_method,
            fund_destination_id, balance_anterior, balance_posterior, beneficiario_tipo, beneficiario_nombre,
            document_reference, observaciones, status, created_by_user_id, created_by_user_name, created_at
          ) VALUES (?, 'ingreso', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `, [
          branchScope, b.categoryId || null, b.description || null, amount, b.paymentMethod || null,
          b.fundDestinationId, balanceAnterior, balancePosterior, b.beneficiarioTipo || null, b.beneficiarioNombre || null,
          b.documentReference || null, b.observaciones || null, status, actor.id, actorName(actor),
        ]);
        return { insertId, balancePosterior };
      });
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Tesoreria', actionName: deferred ? 'Ingreso pendiente de aprobación' : 'Registrar ingreso',
        detail: JSON.stringify({ movementId: result.insertId, amount }),
      });
      const [created] = await query('SELECT * FROM treasury_movements WHERE id=?', [result.insertId]);
      res.status(201).json(mapMovement(created));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ── Gastos y retiros del propietario ────────────────────────────────────

  // Calcula el desglose por sucursal de un gasto compartido. Devuelve filas
  // {branchId, amount, percentage} cuya suma siempre es exactamente `amount`
  // (el redondeo se absorbe en la última fila).
  function computeDistribution(amount, distribution, method) {
    if (!Array.isArray(distribution) || !distribution.length) return null;
    if (!DISTRIBUTION_METHODS.includes(method)) throw httpError('Método de distribución inválido.', 400);
    const rows = [];
    let assigned = 0;
    if (method === 'igual') {
      const share = Number((amount / distribution.length).toFixed(2));
      distribution.forEach((d, i) => {
        const isLast = i === distribution.length - 1;
        const amt = isLast ? Number((amount - assigned).toFixed(2)) : share;
        assigned += amt;
        rows.push({ branchId: d.branchId, amount: amt, percentage: Number(((amt / amount) * 100).toFixed(2)) });
      });
    } else if (method === 'porcentaje') {
      const totalPct = distribution.reduce((s, d) => s + Number(d.percentage || 0), 0);
      if (Math.abs(totalPct - 100) > 0.5) throw httpError('Los porcentajes de distribución deben sumar 100%.', 400);
      distribution.forEach((d, i) => {
        const isLast = i === distribution.length - 1;
        const amt = isLast ? Number((amount - assigned).toFixed(2)) : Number(((Number(d.percentage || 0) / 100) * amount).toFixed(2));
        assigned += amt;
        rows.push({ branchId: d.branchId, amount: amt, percentage: Number(d.percentage || 0) });
      });
    } else {
      const totalAmt = distribution.reduce((s, d) => s + Number(d.amount || 0), 0);
      if (Math.abs(totalAmt - amount) > 0.05) throw httpError('La suma de los montos de distribución no coincide con el total del gasto.', 400);
      distribution.forEach((d) => {
        const amt = Number(d.amount || 0);
        rows.push({ branchId: d.branchId, amount: amt, percentage: Number(((amt / amount) * 100).toFixed(2)) });
      });
    }
    return rows;
  }

  router.post('/expense', requirePermission('registrar_gastos_caja_general'), async (req, res) => {
    const enabledSettings = await requireEnabled(res);
    if (!enabledSettings) return;
    const b = req.body || {};
    const amount = Number(b.amount || 0);
    const movementType = EXPENSE_MOVEMENT_TYPES.includes(b.movementType) ? b.movementType : 'gasto';
    if (!amount || amount <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });
    if (!b.fundOriginId) return res.status(400).json({ error: 'Debes indicar el fondo de origen.' });

    const passwordRequired = movementType === 'retiro_propietario'
      ? Number(enabledSettings.require_password_withdrawals)
      : Number(enabledSettings.require_password_expenses);
    if (passwordRequired && !(await verifyAdminPassword(req.authUser, b.password))) {
      return res.status(403).json({ error: 'Tu contraseña de inicio de sesión es incorrecta o falta.' });
    }

    const hasDistribution = Array.isArray(b.distribution) && b.distribution.length > 0;
    if (hasDistribution && !canViewAllBranches(req.authUser)) {
      return res.status(403).json({ error: 'No tienes permiso para distribuir un gasto entre varias sucursales.' });
    }

    try {
      let distributionRows = null;
      if (hasDistribution) distributionRows = computeDistribution(amount, b.distribution, b.distributionMethod);
      // Un gasto distribuido es corporativo (branch_id NULL); uno normal respeta el scope del actor.
      const branchScope = hasDistribution ? null : resolveBranchScope(req.authUser, b.branchId ? Number(b.branchId) : null);
      const actor = req.authUser;
      const deferred = needsApproval(amount, enabledSettings);
      const status = deferred ? 'pendiente_aprobacion' : 'confirmado';
      const result = await withTransaction(async (conn) => {
        const { balanceAnterior, balancePosterior } = await applyOrDeferFundDelta(conn, b.fundOriginId, -amount, enabledSettings, deferred);
        const { insertId } = await conn.query(`
          INSERT INTO treasury_movements (
            branch_id, movement_type, category_id, description, amount, payment_method,
            fund_origin_id, balance_anterior, balance_posterior, beneficiario_tipo, beneficiario_nombre,
            document_reference, observaciones, status, created_by_user_id, created_by_user_name,
            authorized_by_user_id, authorized_by_user_name, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `, [
          branchScope, movementType, b.categoryId || null, b.description || null, amount, b.paymentMethod || null,
          b.fundOriginId, balanceAnterior, balancePosterior, b.beneficiarioTipo || null, b.beneficiarioNombre || null,
          b.documentReference || null, b.observaciones || null, status, actor.id, actorName(actor),
          passwordRequired ? actor.id : null, passwordRequired ? actorName(actor) : null,
        ]);
        if (distributionRows) {
          for (const row of distributionRows) {
            await conn.query(
              'INSERT INTO treasury_movement_distributions (movement_id, branch_id, amount, percentage) VALUES (?, ?, ?, ?)',
              [insertId, row.branchId, row.amount, row.percentage]
            );
          }
        }
        return { insertId, balancePosterior };
      });
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Tesoreria',
        actionName: deferred ? 'Gasto pendiente de aprobación' : (movementType === 'retiro_propietario' ? 'Registrar retiro del propietario' : 'Registrar gasto'),
        detail: JSON.stringify({ movementId: result.insertId, amount, distributed: hasDistribution }),
      });
      const [created] = await query('SELECT * FROM treasury_movements WHERE id=?', [result.insertId]);
      res.status(201).json(mapMovement(created));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ── Anulación (reverso, nunca se borra ni se reescribe historial) ───────

  router.post('/movements/:id/void', requirePermission('anular_movimientos_caja_general'), async (req, res) => {
    const { reason, password } = req.body || {};
    if (!reason) return res.status(400).json({ error: 'El motivo de la anulación es requerido.' });
    if (!(await verifyAdminPassword(req.authUser, password))) {
      return res.status(403).json({ error: 'Tu contraseña de inicio de sesión es incorrecta o falta.' });
    }
    try {
      const actor = req.authUser;
      const settings = await getSettings();
      const result = await withTransaction(async (conn) => {
        // FOR UPDATE (solo MySQL): doble clic en "Anular" disparaba dos
        // transacciones que leían status='confirmado' antes de que la primera
        // confirmara, generando dos reversos del mismo movimiento.
        const [original] = await conn.query(
          `SELECT * FROM treasury_movements WHERE id=?${isMysqlDeployment() ? ' FOR UPDATE' : ''}`,
          [req.params.id]
        );
        if (!original) throw httpError('Movimiento no encontrado.', 404);
        if (original.status !== 'confirmado') throw httpError('Solo se pueden anular movimientos confirmados (este está anulado, rechazado o pendiente de aprobación).', 400);
        // A diferencia de approve/reject, esta ruta no validaba la sucursal
        // del actor contra la del movimiento — un usuario con permiso de
        // anular pero restringido a su sucursal podía anular movimientos de
        // OTRA sucursal solo conociendo el id.
        if (original.branch_id) resolveBranchScope(actor, original.branch_id);
        else if (!isAdminGeneral(actor)) throw httpError('Solo el administrador general puede anular movimientos corporativos.', 403);

        let reverseFundId = null;
        let reverseDelta = 0;
        if (original.fund_destination_id) { reverseFundId = original.fund_destination_id; reverseDelta = -Number(original.amount); }
        else if (original.fund_origin_id) { reverseFundId = original.fund_origin_id; reverseDelta = Number(original.amount); }
        if (!reverseFundId) throw httpError('Este movimiento no tiene un fondo asociado y no puede anularse automáticamente.', 400);

        const { balanceAnterior, balancePosterior } = await applyFundDelta(conn, reverseFundId, reverseDelta, settings);
        const isReversalDestination = reverseDelta > 0;
        const { insertId } = await conn.query(`
          INSERT INTO treasury_movements (
            branch_id, movement_type, category_id, description, amount,
            fund_origin_id, fund_destination_id, balance_anterior, balance_posterior,
            related_movement_id, observaciones, status, created_by_user_id, created_by_user_name, created_at
          ) VALUES (?, 'ajuste_anulacion', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmado', ?, ?, datetime('now'))
        `, [
          original.branch_id, original.category_id, `Reverso de movimiento #${original.id}: ${reason}`, Math.abs(reverseDelta),
          isReversalDestination ? null : reverseFundId, isReversalDestination ? reverseFundId : null,
          balanceAnterior, balancePosterior, original.id, reason, actor.id, actorName(actor),
        ]);
        await conn.query("UPDATE treasury_movements SET status='anulado', updated_at=datetime('now') WHERE id=?", [original.id]);
        return { reversalMovementId: insertId };
      });
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Tesoreria', actionName: 'Anular movimiento', detail: JSON.stringify({ movementId: req.params.id, reason }),
      });
      res.json({ ok: true, ...result });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ── Aprobación de movimientos por monto configurable ────────────────────

  router.post('/movements/:id/approve', requirePermission('aprobar_movimientos_caja_general'), async (req, res) => {
    try {
      const actor = req.authUser;
      const result = await withTransaction(async (conn) => {
        // FOR UPDATE (solo MySQL): doble aprobación simultánea del mismo
        // movimiento aplicaba el delta al fondo dos veces.
        const [m] = await conn.query(
          `SELECT * FROM treasury_movements WHERE id=?${isMysqlDeployment() ? ' FOR UPDATE' : ''}`,
          [req.params.id]
        );
        if (!m) throw httpError('Movimiento no encontrado.', 404);
        if (m.status !== 'pendiente_aprobacion') throw httpError('Este movimiento no está pendiente de aprobación.', 400);
        if (m.branch_id) resolveBranchScope(actor, m.branch_id);
        else if (!isAdminGeneral(actor)) throw httpError('Solo el administrador general puede aprobar movimientos corporativos.', 403);

        const settings = await getSettings({ query: conn.query });
        let fundId = null;
        let delta = 0;
        if (m.fund_destination_id) { fundId = m.fund_destination_id; delta = Number(m.amount); }
        else if (m.fund_origin_id) { fundId = m.fund_origin_id; delta = -Number(m.amount); }
        if (!fundId) throw httpError('Este movimiento no tiene un fondo asociado.', 400);

        const { balanceAnterior, balancePosterior } = await applyFundDelta(conn, fundId, delta, settings);
        await conn.query(`
          UPDATE treasury_movements SET status='confirmado', balance_anterior=?, balance_posterior=?,
            authorized_by_user_id=?, authorized_by_user_name=?, updated_at=datetime('now') WHERE id=?
        `, [balanceAnterior, balancePosterior, actor.id, actorName(actor), m.id]);
        return { balancePosterior };
      });
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Tesoreria', actionName: 'Aprobar movimiento', detail: JSON.stringify({ movementId: req.params.id }),
      });
      res.json({ ok: true, ...result });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.post('/movements/:id/reject', requirePermission('rechazar_movimientos_caja_general'), async (req, res) => {
    const { reason } = req.body || {};
    if (!reason) return res.status(400).json({ error: 'El motivo del rechazo es requerido.' });
    try {
      const actor = req.authUser;
      const [m] = await query('SELECT * FROM treasury_movements WHERE id=?', [req.params.id]);
      if (!m) return res.status(404).json({ error: 'Movimiento no encontrado.' });
      if (m.status !== 'pendiente_aprobacion') return res.status(400).json({ error: 'Este movimiento no está pendiente de aprobación.' });
      if (m.branch_id) resolveBranchScope(actor, m.branch_id);
      else if (!isAdminGeneral(actor)) return res.status(403).json({ error: 'Solo el administrador general puede rechazar movimientos corporativos.' });

      // WHERE status='pendiente_aprobacion' hace el check-then-act atómico:
      // si dos rechazos llegan casi juntos, solo uno actualiza filas.
      const updateResult = await query(
        "UPDATE treasury_movements SET status='rechazado', observaciones=?, updated_at=datetime('now') WHERE id=? AND status='pendiente_aprobacion'",
        [reason, req.params.id]
      );
      if (!updateResult.affectedRows) {
        return res.status(400).json({ error: 'Este movimiento no está pendiente de aprobación.' });
      }
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Tesoreria', actionName: 'Rechazar movimiento', detail: JSON.stringify({ movementId: req.params.id, reason }),
      });
      res.json({ ok: true });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ── Transferencia manual desde cierre de caja ───────────────────────────

  router.get('/closings/pending', requirePermission('transferir_cierres_caja_general'), async (req, res) => {
    try {
      const branchScope = resolveBranchScope(req.authUser, req.query.branchId ? Number(req.query.branchId) : null);
      let sql = `
        SELECT cs.* FROM cash_sessions cs
        LEFT JOIN treasury_closing_transfers tct ON tct.cash_session_id = cs.id
        WHERE cs.status = 'closed' AND tct.id IS NULL
      `;
      const params = [];
      if (branchScope !== null) { sql += ' AND cs.branch_id = ?'; params.push(branchScope); }
      sql += ' ORDER BY cs.closed_at DESC LIMIT 100';
      const rows = await query(sql, params);
      res.json(rows);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.post('/closings/:cashSessionId/transfer', requirePermission('transferir_cierres_caja_general'), async (req, res) => {
    const enabledSettings = await requireEnabled(res);
    if (!enabledSettings) return;
    const b = req.body || {};
    if (!(await verifyAdminPassword(req.authUser, b.password))) {
      return res.status(403).json({ error: 'Tu contraseña de inicio de sesión es incorrecta o falta.' });
    }
    const cashSessionId = Number(req.params.cashSessionId);
    const actor = req.authUser;
    try {
      resolveBranchScope(actor, (await query('SELECT branch_id FROM cash_sessions WHERE id = ?', [cashSessionId]))[0]?.branch_id);
      const legs = [
        { amount: Number(b.efectivoEntregado || 0), fundId: b.fundEfectivoId, paymentMethod: 'efectivo' },
        { amount: Number(b.tarjeta || 0), fundId: b.fundTarjetaId, paymentMethod: 'tarjeta' },
        { amount: Number(b.transferencia || 0), fundId: b.fundTransferenciaId, paymentMethod: 'transferencia' },
      ];
      const result = await performClosingTransferLegs(cashSessionId, legs, Number(b.fondoRetenido || 0), actor, b.observaciones || null, enabledSettings);
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Tesoreria', actionName: 'Transferir cierre a Caja General',
        detail: JSON.stringify({ cashSessionId, ...result }),
      });
      res.status(201).json({ ok: true, ...result });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // Núcleo reutilizable de la transferencia de un cierre — usado tanto por el
  // endpoint manual de arriba como por el enganche automático que server.js
  // llama después de /api/cash/close (ver módulo.exports.autoTransferClosing).
  async function performClosingTransferLegs(cashSessionId, legs, retainedAmount, actor, observaciones, settings) {
    return withTransaction(async (conn) => {
      const [existing] = await conn.query('SELECT id FROM treasury_closing_transfers WHERE cash_session_id = ?', [cashSessionId]);
      if (existing) throw httpError('Este cierre ya fue transferido a Caja General.', 409);
      const [session] = await conn.query('SELECT * FROM cash_sessions WHERE id = ?', [cashSessionId]);
      if (!session || session.status !== 'closed') throw httpError('El cierre no existe o no está cerrado.', 400);

      const transferGroupId = `close-${cashSessionId}-${Date.now()}`;
      let transferredTotal = 0;
      const movementIds = [];
      for (const leg of legs) {
        if (leg.amount <= 0) continue;
        if (!leg.fundId) throw httpError(`Debes indicar el fondo destino para ${leg.paymentMethod}.`, 400);
        const { balanceAnterior, balancePosterior } = await applyFundDelta(conn, leg.fundId, leg.amount, settings);
        const { insertId } = await conn.query(`
          INSERT INTO treasury_movements (
            branch_id, movement_type, description, amount, payment_method, fund_destination_id,
            balance_anterior, balance_posterior, related_cash_session_id, transfer_group_id,
            status, created_by_user_id, created_by_user_name, observaciones, created_at
          ) VALUES (?, 'transferencia_cierre', ?, ?, ?, ?, ?, ?, ?, ?, 'confirmado', ?, ?, ?, datetime('now'))
        `, [
          session.branch_id, `Transferencia de cierre #${cashSessionId}`, leg.amount, leg.paymentMethod, leg.fundId,
          balanceAnterior, balancePosterior, cashSessionId, transferGroupId, actor.id, actorName(actor), observaciones,
        ]);
        movementIds.push(insertId);
        transferredTotal += leg.amount;
      }
      if (!movementIds.length) throw httpError('Debes transferir al menos un monto mayor a 0.', 400);

      const status = Number(session.difference_amount || 0) !== 0 ? 'con_diferencia' : 'transferido';
      await conn.query(`
        INSERT INTO treasury_closing_transfers (
          cash_session_id, branch_id, cash_register_id, expected_amount, counted_amount, difference_amount,
          retained_amount, transferred_amount, status, transferred_by_user_id, transferred_by_user_name, observaciones, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `, [
        cashSessionId, session.branch_id, session.cash_register_id, session.expected_amount, session.counted_amount,
        session.difference_amount, retainedAmount, transferredTotal, status, actor.id, actorName(actor), observaciones,
      ]);
      return { movementIds, transferredTotal, status };
    });
  }

  // Arma las líneas de transferencia (efectivo/tarjeta/transferencia) usando
  // los fondos marcados como predeterminados de la sucursal — sin esto, ni el
  // modo automático ni el de "preguntar y confirmar" pueden hacer nada porque
  // ninguno le pide al cajero que elija fondos.
  async function resolveDefaultFundLegs(branchId, { efectivo, tarjeta, transferencia }) {
    const funds = await query('SELECT * FROM treasury_funds WHERE branch_id = ? AND is_default_for_type = 1', [branchId]);
    const findFund = (type) => funds.find((f) => f.fund_type === type)?.id || null;
    return [
      { amount: Number(efectivo || 0), fundId: findFund('efectivo'), paymentMethod: 'efectivo' },
      { amount: Number(tarjeta || 0), fundId: findFund('tarjetas_pendientes'), paymentMethod: 'tarjeta' },
      { amount: Number(transferencia || 0), fundId: findFund('transferencias'), paymentMethod: 'transferencia' },
    ].filter((leg) => leg.amount > 0 && leg.fundId);
  }

  // Llamado por server.js (fire-and-forget, envuelto en try/catch por el
  // caller) justo después de que un cierre de caja ya se confirmó, SOLO si
  // treasury_settings.auto_transfer_enabled está activo (modo silencioso, sin
  // preguntarle nada al cajero). Nunca lanza — si falta un fondo default o
  // algo no cuadra, devuelve {ok:false, reason}.
  async function autoTransferClosing({ cashSessionId, branchId, efectivo, tarjeta, transferencia, actorId, actorName: actorNameStr }) {
    const settings = await getSettings();
    if (!Number(settings.enabled) || !Number(settings.auto_transfer_enabled)) return { ok: false, reason: 'auto_transfer_disabled' };
    const legs = await resolveDefaultFundLegs(branchId, { efectivo, tarjeta, transferencia });
    if (!legs.length) return { ok: false, reason: 'no_default_funds' };
    try {
      const actor = { id: actorId, usuario: actorNameStr };
      const result = await performClosingTransferLegs(cashSessionId, legs, 0, actor, 'Transferencia automática', settings);
      await writeAuditLog({
        userId: actorId, userName: actorNameStr, userRole: 'Sistema',
        moduleName: 'Tesoreria', actionName: 'Transferencia automática de cierre', detail: JSON.stringify({ cashSessionId, ...result }),
      });
      return { ok: true, ...result };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }
  router.autoTransferClosing = autoTransferClosing;

  // Igual que autoTransferClosing pero SIN password ni selección manual de
  // fondos — usado cuando el cajero confirma "sí, transferir" en el resumen
  // post-cierre (modo "preguntar", treasury_settings.auto_transfer_enabled en
  // false). A diferencia del modo automático, SÍ lanza — el endpoint que la
  // llama en server.js necesita el error real para mostrarle algo al usuario.
  async function quickTransferClosing({ cashSessionId, branchId, efectivo, tarjeta, transferencia, actor }) {
    const settings = await getSettings();
    if (!Number(settings.enabled)) throw httpError('Caja General está desactivada.', 403);
    const legs = await resolveDefaultFundLegs(branchId, { efectivo, tarjeta, transferencia });
    if (!legs.length) {
      throw httpError('No hay un fondo predeterminado de efectivo configurado para esta sucursal. Pídele a un administrador que lo configure en Caja General.', 400);
    }
    const result = await performClosingTransferLegs(cashSessionId, legs, 0, actor, 'Transferencia confirmada al cierre', settings);
    await writeAuditLog({
      userId: actor.id, userName: actorName(actor), userRole: 'Cajero',
      moduleName: 'Tesoreria', actionName: 'Transferencia confirmada al cierre', detail: JSON.stringify({ cashSessionId, ...result }),
    });
    return result;
  }
  router.quickTransferClosing = quickTransferClosing;

  // Para que server.js sepa, sin exponer todo el módulo, si Tesorería está
  // activa y en qué modo (para decidir si preguntar al cajero o no).
  router.getPublicSettingsSnapshot = async function () {
    const settings = await getSettings();
    return { enabled: Boolean(settings.enabled), autoTransferEnabled: Boolean(settings.auto_transfer_enabled) };
  };

  // ── Reporte de cierre completo del día (informativo, no mueve dinero) ──

  const SALE_ACTIVE_CLAUSE = "COALESCE(s.fiscal_status,'emitida') <> 'cancelada' AND COALESCE(s.sale_status,'pagada') = 'pagada'";
  const EXPENSE_MOVEMENT_TYPES_CASH = "'Gasto','Pago suplidor','Devolución','Retiro de efectivo'";

  // Llamado por server.js cuando detecta que ya no queda ninguna caja abierta
  // de la sucursal para ese día operativo (fire-and-forget, nunca lanza).
  // Agrega TODAS las ventas y gastos de la sucursal en ese operative_date
  // (cruza los turnos/cajas que hayan cerrado ese día) y guarda un snapshot.
  async function generateDailyClosingReport({ branchId, operativeDate }) {
    try {
      const settings = await getSettings();
      if (!Number(settings.enabled)) return { ok: false, reason: 'tesoreria_disabled' };

      const sellerRows = await query(`
        SELECT u.id AS user_id, COALESCE(u.nombre, u.usuario, 'Sin cajero') AS nombre, u.usuario,
          COUNT(s.id) AS facturas, COALESCE(SUM(s.total), 0) AS total,
          COALESCE(SUM(CASE WHEN s.payment_method = 'efectivo' THEN s.total ELSE 0 END), 0) AS efectivo,
          COALESCE(SUM(CASE WHEN s.payment_method = 'tarjeta' THEN s.total ELSE 0 END), 0) AS tarjeta,
          COALESCE(SUM(CASE WHEN s.payment_method = 'transferencia' THEN s.total ELSE 0 END), 0) AS transferencia,
          COALESCE(SUM(CASE WHEN s.payment_method = 'credito' THEN s.total ELSE 0 END), 0) AS credito
        FROM sales s LEFT JOIN users u ON s.billed_by_user_id = u.id
        WHERE COALESCE(s.billed_branch_id, s.branch_id) = ? AND s.operative_date = ? AND ${SALE_ACTIVE_CLAUSE}
        GROUP BY u.id, nombre, u.usuario
        ORDER BY total DESC
      `, [branchId, operativeDate]);

      const totals = sellerRows.reduce((acc, r) => {
        acc.facturas += Number(r.facturas || 0);
        acc.total += Number(r.total || 0);
        acc.efectivo += Number(r.efectivo || 0);
        acc.tarjeta += Number(r.tarjeta || 0);
        acc.transferencia += Number(r.transferencia || 0);
        acc.credito += Number(r.credito || 0);
        return acc;
      }, { facturas: 0, total: 0, efectivo: 0, tarjeta: 0, transferencia: 0, credito: 0 });

      const [expenseRow] = await query(`
        SELECT COALESCE(SUM(ABS(cm.amount)), 0) AS total_gastos
        FROM cash_movements cm JOIN cash_sessions cs ON cs.id = cm.session_id
        WHERE cs.branch_id = ? AND cs.operative_date = ? AND cm.movement_type IN (${EXPENSE_MOVEMENT_TYPES_CASH})
      `, [branchId, operativeDate]);

      const [sessionCountRow] = await query(`
        SELECT COUNT(*) AS total FROM cash_sessions WHERE branch_id = ? AND operative_date = ? AND status = 'closed'
      `, [branchId, operativeDate]);

      const vendorBreakdown = JSON.stringify(sellerRows.map((r) => ({
        userId: r.user_id, nombre: r.nombre, usuario: r.usuario, facturas: Number(r.facturas || 0), total: Number(r.total || 0),
        efectivo: Number(r.efectivo || 0), tarjeta: Number(r.tarjeta || 0), transferencia: Number(r.transferencia || 0), credito: Number(r.credito || 0),
      })));

      const totalGastos = Number(expenseRow?.total_gastos || 0);
      const sessionsCount = Number(sessionCountRow?.total || 0);
      const existing = await query('SELECT id FROM treasury_daily_closings WHERE branch_id = ? AND operative_date = ?', [branchId, operativeDate]);

      if (existing.length) {
        await query(`
          UPDATE treasury_daily_closings SET total_facturas=?, total_ventas=?, total_efectivo=?, total_tarjeta=?,
            total_transferencia=?, total_credito=?, total_gastos=?, cash_sessions_count=?, vendor_breakdown=?, generated_at=datetime('now')
          WHERE id=?
        `, [totals.facturas, totals.total, totals.efectivo, totals.tarjeta, totals.transferencia, totals.credito, totalGastos, sessionsCount, vendorBreakdown, existing[0].id]);
        return { ok: true, id: existing[0].id, updated: true };
      }
      const { insertId } = await query(`
        INSERT INTO treasury_daily_closings (
          branch_id, operative_date, total_facturas, total_ventas, total_efectivo, total_tarjeta,
          total_transferencia, total_credito, total_gastos, cash_sessions_count, vendor_breakdown, generated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `, [branchId, operativeDate, totals.facturas, totals.total, totals.efectivo, totals.tarjeta, totals.transferencia, totals.credito, totalGastos, sessionsCount, vendorBreakdown]);
      await writeAuditLog({
        userId: null, userName: 'Sistema', userRole: 'Sistema', moduleName: 'Tesoreria',
        actionName: 'Generar reporte de cierre del día', detail: JSON.stringify({ branchId, operativeDate, ...totals, totalGastos }),
      });
      return { ok: true, id: insertId, updated: false };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }
  router.generateDailyClosingReport = generateDailyClosingReport;

  function mapDailyClosing(row) {
    let vendorBreakdown = [];
    try { vendorBreakdown = JSON.parse(row.vendor_breakdown || '[]'); } catch (_) { vendorBreakdown = []; }
    return {
      id: row.id,
      branchId: row.branch_id,
      operativeDate: row.operative_date,
      totalFacturas: Number(row.total_facturas || 0),
      totalVentas: Number(row.total_ventas || 0),
      totalEfectivo: Number(row.total_efectivo || 0),
      totalTarjeta: Number(row.total_tarjeta || 0),
      totalTransferencia: Number(row.total_transferencia || 0),
      totalCredito: Number(row.total_credito || 0),
      totalGastos: Number(row.total_gastos || 0),
      cashSessionsCount: Number(row.cash_sessions_count || 0),
      vendorBreakdown,
      generatedAt: row.generated_at,
    };
  }

  router.get('/daily-closings', async (req, res) => {
    try {
      const branchScope = resolveBranchScope(req.authUser, req.query.branchId ? Number(req.query.branchId) : null);
      let sql = 'SELECT * FROM treasury_daily_closings WHERE 1=1';
      const params = [];
      if (branchScope !== null) { sql += ' AND branch_id = ?'; params.push(branchScope); }
      if (req.query.desde) { sql += ' AND operative_date >= ?'; params.push(req.query.desde); }
      if (req.query.hasta) { sql += ' AND operative_date <= ?'; params.push(req.query.hasta); }
      sql += ' ORDER BY operative_date DESC LIMIT 60';
      const rows = await query(sql, params);
      res.json(rows.map(mapDailyClosing));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.get('/daily-closings/:id', async (req, res) => {
    try {
      const [row] = await query('SELECT * FROM treasury_daily_closings WHERE id = ?', [req.params.id]);
      if (!row) return res.status(404).json({ error: 'Reporte no encontrado.' });
      resolveBranchScope(req.authUser, row.branch_id);
      res.json(mapDailyClosing(row));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ── Transferencias entre fondos (misma sucursal, instantáneas) ──────────

  router.post('/fund-transfers', requirePermission('transferir_fondos_caja_general'), async (req, res) => {
    const enabledSettings = await requireEnabled(res);
    if (!enabledSettings) return;
    const b = req.body || {};
    const amount = Number(b.amount || 0);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });
    if (!b.fundOriginId || !b.fundDestinationId) return res.status(400).json({ error: 'Debes indicar el fondo de origen y el de destino.' });
    if (Number(b.fundOriginId) === Number(b.fundDestinationId)) return res.status(400).json({ error: 'El fondo de origen y el de destino no pueden ser el mismo.' });
    try {
      const actor = req.authUser;
      const transferGroupId = `fund-${Date.now()}`;
      const result = await withTransaction(async (conn) => {
        const origin = await applyFundDelta(conn, b.fundOriginId, -amount, enabledSettings);
        const { insertId: outId } = await conn.query(`
          INSERT INTO treasury_movements (
            movement_type, description, amount, fund_origin_id, balance_anterior, balance_posterior,
            transfer_group_id, status, created_by_user_id, created_by_user_name, observaciones, created_at
          ) VALUES ('transferencia_fondo', ?, ?, ?, ?, ?, ?, 'confirmado', ?, ?, ?, datetime('now'))
        `, [b.description || 'Transferencia entre fondos', amount, b.fundOriginId, origin.balanceAnterior, origin.balancePosterior, transferGroupId, actor.id, actorName(actor), b.observaciones || null]);
        const dest = await applyFundDelta(conn, b.fundDestinationId, amount, enabledSettings);
        const { insertId: inId } = await conn.query(`
          INSERT INTO treasury_movements (
            movement_type, description, amount, fund_destination_id, balance_anterior, balance_posterior,
            transfer_group_id, related_movement_id, status, created_by_user_id, created_by_user_name, observaciones, created_at
          ) VALUES ('transferencia_fondo', ?, ?, ?, ?, ?, ?, ?, 'confirmado', ?, ?, ?, datetime('now'))
        `, [b.description || 'Transferencia entre fondos', amount, b.fundDestinationId, dest.balanceAnterior, dest.balancePosterior, transferGroupId, outId, actor.id, actorName(actor), b.observaciones || null]);
        await conn.query('UPDATE treasury_movements SET related_movement_id = ? WHERE id = ?', [inId, outId]);
        return { outMovementId: outId, inMovementId: inId };
      });
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Tesoreria', actionName: 'Transferencia entre fondos', detail: JSON.stringify({ amount, ...result }),
      });
      res.status(201).json({ ok: true, ...result });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ── Transferencias entre sucursales (con confirmación de recepción) ─────

  router.get('/branch-transfers/pending', requirePermission('recibir_transferencias_caja_general'), async (req, res) => {
    try {
      const branchScope = resolveBranchScope(req.authUser, req.query.branchId ? Number(req.query.branchId) : null);
      let sql = "SELECT * FROM treasury_branch_transfers WHERE status = 'pendiente'";
      const params = [];
      if (branchScope !== null) { sql += ' AND to_branch_id = ?'; params.push(branchScope); }
      sql += ' ORDER BY created_at DESC';
      const rows = await query(sql, params);
      res.json(rows.map(mapBranchTransfer));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.post('/branch-transfers', requirePermission('transferir_entre_sucursales_caja_general'), async (req, res) => {
    const enabledSettings = await requireEnabled(res);
    if (!enabledSettings) return;
    const b = req.body || {};
    const amount = Number(b.amount || 0);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });
    if (!b.fromBranchId || !b.toBranchId) return res.status(400).json({ error: 'Debes indicar sucursal de origen y de destino.' });
    if (Number(b.fromBranchId) === Number(b.toBranchId)) return res.status(400).json({ error: 'La sucursal de origen y destino no pueden ser la misma.' });
    if (!b.fromFundId) return res.status(400).json({ error: 'Debes indicar el fondo de origen.' });
    if (!(await verifyAdminPassword(req.authUser, b.password))) {
      return res.status(403).json({ error: 'Tu contraseña de inicio de sesión es incorrecta o falta.' });
    }
    try {
      resolveBranchScope(req.authUser, Number(b.fromBranchId));
      const actor = req.authUser;
      const transferGroupId = `branch-${Date.now()}`;
      const result = await withTransaction(async (conn) => {
        const { balanceAnterior, balancePosterior } = await applyFundDelta(conn, b.fromFundId, -amount, enabledSettings);
        const { insertId: outId } = await conn.query(`
          INSERT INTO treasury_movements (
            branch_id, movement_type, description, amount, fund_origin_id, balance_anterior, balance_posterior,
            transfer_group_id, status, created_by_user_id, created_by_user_name, observaciones, created_at
          ) VALUES (?, 'transferencia_sucursal_salida', ?, ?, ?, ?, ?, ?, 'confirmado', ?, ?, ?, datetime('now'))
        `, [b.fromBranchId, `Transferencia enviada a sucursal #${b.toBranchId}`, amount, b.fromFundId, balanceAnterior, balancePosterior, transferGroupId, actor.id, actorName(actor), b.observaciones || null]);
        const { insertId: transferId } = await conn.query(`
          INSERT INTO treasury_branch_transfers (
            from_branch_id, to_branch_id, from_fund_id, to_fund_id, amount, status, transfer_group_id,
            outgoing_movement_id, sent_by_user_id, sent_by_user_name, observaciones, created_at
          ) VALUES (?, ?, ?, ?, ?, 'pendiente', ?, ?, ?, ?, ?, datetime('now'))
        `, [b.fromBranchId, b.toBranchId, b.fromFundId, b.toFundId || null, amount, transferGroupId, outId, actor.id, actorName(actor), b.observaciones || null]);
        return { transferId, outgoingMovementId: outId };
      });
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Tesoreria', actionName: 'Enviar transferencia entre sucursales', detail: JSON.stringify({ amount, ...result }),
      });
      res.status(201).json({ ok: true, ...result });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.post('/branch-transfers/:id/confirm', requirePermission('recibir_transferencias_caja_general'), async (req, res) => {
    const b = req.body || {};
    try {
      const actor = req.authUser;
      const result = await withTransaction(async (conn) => {
        // FOR UPDATE (solo MySQL): doble confirmación simultánea desde dos
        // pestañas podía acreditar dos veces el fondo destino.
        const [t] = await conn.query(
          `SELECT * FROM treasury_branch_transfers WHERE id = ?${isMysqlDeployment() ? ' FOR UPDATE' : ''}`,
          [req.params.id]
        );
        if (!t) throw httpError('Transferencia no encontrada.', 404);
        if (t.status !== 'pendiente') throw httpError('Esta transferencia ya fue resuelta.', 400);
        resolveBranchScope(actor, t.to_branch_id);
        const toFundId = b.toFundId || t.to_fund_id;
        if (!toFundId) throw httpError('Debes indicar el fondo de destino.', 400);
        const settings = await getSettings({ query: conn.query });
        const { balanceAnterior, balancePosterior } = await applyFundDelta(conn, toFundId, Number(t.amount), settings);
        const { insertId } = await conn.query(`
          INSERT INTO treasury_movements (
            branch_id, movement_type, description, amount, fund_destination_id, balance_anterior, balance_posterior,
            transfer_group_id, related_movement_id, status, created_by_user_id, created_by_user_name, created_at
          ) VALUES (?, 'transferencia_sucursal_entrada', ?, ?, ?, ?, ?, ?, ?, 'confirmado', ?, ?, datetime('now'))
        `, [t.to_branch_id, `Transferencia recibida de sucursal #${t.from_branch_id}`, t.amount, toFundId, balanceAnterior, balancePosterior, t.transfer_group_id, t.outgoing_movement_id, actor.id, actorName(actor)]);
        await conn.query(`
          UPDATE treasury_branch_transfers SET status='recibida', to_fund_id=?, incoming_movement_id=?,
            received_by_user_id=?, received_by_user_name=?, resolved_at=datetime('now') WHERE id=?
        `, [toFundId, insertId, actor.id, actorName(actor), t.id]);
        await conn.query('UPDATE treasury_movements SET related_movement_id = ? WHERE id = ?', [insertId, t.outgoing_movement_id]);
        return { incomingMovementId: insertId };
      });
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Tesoreria', actionName: 'Confirmar recepción de transferencia', detail: JSON.stringify({ transferId: req.params.id, ...result }),
      });
      res.json({ ok: true, ...result });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.post('/branch-transfers/:id/reject', requirePermission('recibir_transferencias_caja_general'), async (req, res) => {
    const { reason } = req.body || {};
    if (!reason) return res.status(400).json({ error: 'El motivo del rechazo es requerido.' });
    try {
      const actor = req.authUser;
      const result = await withTransaction(async (conn) => {
        // FOR UPDATE (solo MySQL) — misma razón que en /confirm.
        const [t] = await conn.query(
          `SELECT * FROM treasury_branch_transfers WHERE id = ?${isMysqlDeployment() ? ' FOR UPDATE' : ''}`,
          [req.params.id]
        );
        if (!t) throw httpError('Transferencia no encontrada.', 404);
        if (t.status !== 'pendiente') throw httpError('Esta transferencia ya fue resuelta.', 400);
        resolveBranchScope(actor, t.to_branch_id);
        const settings = await getSettings({ query: conn.query });
        // Reversar el débito en la sucursal de origen.
        const { balanceAnterior, balancePosterior } = await applyFundDelta(conn, t.from_fund_id, Number(t.amount), settings);
        const { insertId } = await conn.query(`
          INSERT INTO treasury_movements (
            branch_id, movement_type, description, amount, fund_destination_id, balance_anterior, balance_posterior,
            transfer_group_id, related_movement_id, observaciones, status, created_by_user_id, created_by_user_name, created_at
          ) VALUES (?, 'ajuste_anulacion', ?, ?, ?, ?, ?, ?, ?, ?, 'confirmado', ?, ?, datetime('now'))
        `, [t.from_branch_id, `Transferencia rechazada: ${reason}`, t.amount, t.from_fund_id, balanceAnterior, balancePosterior, t.transfer_group_id, t.outgoing_movement_id, reason, actor.id, actorName(actor)]);
        await conn.query(`
          UPDATE treasury_branch_transfers SET status='rechazada', received_by_user_id=?, received_by_user_name=?,
            observaciones=?, resolved_at=datetime('now') WHERE id=?
        `, [actor.id, actorName(actor), reason, t.id]);
        return { reversalMovementId: insertId };
      });
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Tesoreria', actionName: 'Rechazar transferencia entre sucursales', detail: JSON.stringify({ transferId: req.params.id, reason }),
      });
      res.json({ ok: true, ...result });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ── Pagos a suplidores integrados ────────────────────────────────────────

  router.get('/supplier-invoices/pending', requirePermission('pagar_suplidores_caja_general'), async (req, res) => {
    try {
      let sql = `
        SELECT si.*, s.nombre AS supplier_name FROM supplier_invoices si
        LEFT JOIN suppliers s ON s.id = si.supplier_id
        WHERE si.pending_amount > 0
      `;
      const params = [];
      if (req.query.supplierId) { sql += ' AND si.supplier_id = ?'; params.push(req.query.supplierId); }
      sql += ' ORDER BY si.due_at ASC';
      const rows = await query(sql, params);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/supplier-payments', requirePermission('pagar_suplidores_caja_general'), async (req, res) => {
    const enabledSettings = await requireEnabled(res);
    if (!enabledSettings) return;
    const b = req.body || {};
    const amount = Number(b.amount || 0);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });
    if (!b.supplierInvoiceId || !b.fundOriginId) return res.status(400).json({ error: 'Debes indicar la factura y el fondo de origen.' });
    if (Number(enabledSettings.require_password_expenses) && !(await verifyAdminPassword(req.authUser, b.password))) {
      return res.status(403).json({ error: 'Tu contraseña de inicio de sesión es incorrecta o falta.' });
    }
    try {
      const branchScope = resolveBranchScope(req.authUser, b.branchId ? Number(b.branchId) : null);
      const actor = req.authUser;
      const result = await withTransaction(async (conn) => {
        const [invoice] = await conn.query('SELECT * FROM supplier_invoices WHERE id = ?', [b.supplierInvoiceId]);
        if (!invoice) throw httpError('Factura de suplidor no encontrada.', 404);
        const pending = Number(invoice.pending_amount || 0);
        if (amount > pending + 0.01) throw httpError('El monto supera lo pendiente de esta factura.', 400);

        const { balanceAnterior, balancePosterior } = await applyFundDelta(conn, b.fundOriginId, -amount, enabledSettings);

        const newPaid = Number((Number(invoice.paid_amount || 0) + amount).toFixed(2));
        const newPending = Number(Math.max(0, Number(invoice.total_amount || 0) - newPaid).toFixed(2));
        const newStatus = newPending <= 0.01 ? 'pagada' : 'parcial';
        await conn.query('UPDATE supplier_invoices SET paid_amount = ?, pending_amount = ?, status = ? WHERE id = ?', [newPaid, newPending, newStatus, invoice.id]);
        await conn.query(
          'INSERT INTO supplier_payments (supplier_id, invoice_id, monto, metodo_pago, fecha_pago, notas, created_by) VALUES (?, ?, ?, ?, datetime(\'now\'), ?, ?)',
          [invoice.supplier_id, invoice.id, amount, b.paymentMethod || 'efectivo', b.observaciones || null, actor.id]
        ).catch(() => {});

        const { insertId } = await conn.query(`
          INSERT INTO treasury_movements (
            branch_id, movement_type, category_id, description, amount, payment_method, fund_origin_id,
            balance_anterior, balance_posterior, beneficiario_tipo, beneficiario_id, beneficiario_nombre,
            observaciones, status, created_by_user_id, created_by_user_name, created_at
          ) VALUES (?, 'pago_suplidor', ?, ?, ?, ?, ?, ?, ?, 'suplidor', ?, ?, ?, 'confirmado', ?, ?, datetime('now'))
        `, [
          branchScope, b.categoryId || null, b.description || `Pago factura #${invoice.invoice_number || invoice.id}`, amount, b.paymentMethod || null,
          b.fundOriginId, balanceAnterior, balancePosterior, invoice.supplier_id, b.supplierName || null, b.observaciones || null, actor.id, actorName(actor),
        ]);
        return { insertId, balancePosterior, invoicePendingAmount: newPending };
      });
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Tesoreria', actionName: 'Pago a suplidor', detail: JSON.stringify({ movementId: result.insertId, amount, supplierInvoiceId: b.supplierInvoiceId }),
      });
      const [created] = await query('SELECT * FROM treasury_movements WHERE id=?', [result.insertId]);
      res.status(201).json(mapMovement(created));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ── Pagos a empleados (ledger simple, sin nómina) ───────────────────────

  // Lista simple para el selector del modal de pago (evita depender del
  // permiso 'rrhh' de RRHH, que es un módulo distinto con su propio scope).
  router.get('/employees', requirePermission('pagar_empleados_caja_general'), async (req, res) => {
    try {
      const rows = await query("SELECT id, nombre, cargo, departamento FROM hr_employees WHERE estado = 'activo' ORDER BY nombre ASC");
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/employee-payments', requirePermission('pagar_empleados_caja_general'), async (req, res) => {
    const enabledSettings = await requireEnabled(res);
    if (!enabledSettings) return;
    const b = req.body || {};
    const amount = Number(b.amount || 0);
    const concept = EMPLOYEE_PAYMENT_CONCEPTS.includes(b.concept) ? b.concept : 'otro';
    if (!amount || amount <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });
    if (!b.employeeId || !b.fundOriginId) return res.status(400).json({ error: 'Debes indicar el empleado y el fondo de origen.' });
    if (Number(enabledSettings.require_password_expenses) && !(await verifyAdminPassword(req.authUser, b.password))) {
      return res.status(403).json({ error: 'Tu contraseña de inicio de sesión es incorrecta o falta.' });
    }
    try {
      const [employee] = await query('SELECT * FROM hr_employees WHERE id = ?', [b.employeeId]);
      if (!employee) return res.status(404).json({ error: 'Empleado no encontrado.' });
      const branchScope = resolveBranchScope(req.authUser, b.branchId ? Number(b.branchId) : null);
      const actor = req.authUser;
      const result = await withTransaction(async (conn) => {
        const { balanceAnterior, balancePosterior } = await applyFundDelta(conn, b.fundOriginId, -amount, enabledSettings);
        const { insertId } = await conn.query(`
          INSERT INTO treasury_movements (
            branch_id, movement_type, category_id, description, amount, payment_method, fund_origin_id,
            balance_anterior, balance_posterior, beneficiario_tipo, beneficiario_id, beneficiario_nombre,
            observaciones, status, created_by_user_id, created_by_user_name, created_at
          ) VALUES (?, 'pago_empleado', ?, ?, ?, ?, ?, ?, ?, 'empleado', ?, ?, ?, 'confirmado', ?, ?, datetime('now'))
        `, [
          branchScope, b.categoryId || null, b.description || `Pago (${concept}) a ${employee.nombre}`, amount, b.paymentMethod || null,
          b.fundOriginId, balanceAnterior, balancePosterior, employee.id, employee.nombre, b.observaciones || null, actor.id, actorName(actor),
        ]);
        return { insertId, balancePosterior };
      });
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Tesoreria', actionName: 'Pago a empleado', detail: JSON.stringify({ movementId: result.insertId, amount, employeeId: b.employeeId, concept }),
      });
      const [created] = await query('SELECT * FROM treasury_movements WHERE id=?', [result.insertId]);
      res.status(201).json(mapMovement(created));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ── Adjuntar comprobante real (imagen o PDF, como dataURL) ──────────────

  router.post('/movements/:id/attachment', async (req, res) => {
    const { fileData } = req.body || {};
    if (!fileData) return res.status(400).json({ error: 'No se recibió ningún archivo.' });
    if (!attachmentsDir) return res.status(500).json({ error: 'El directorio de comprobantes no está configurado.' });
    try {
      const [m] = await query('SELECT * FROM treasury_movements WHERE id = ?', [req.params.id]);
      if (!m) return res.status(404).json({ error: 'Movimiento no encontrado.' });
      if (m.branch_id) resolveBranchScope(req.authUser, m.branch_id);

      const match = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/.exec(String(fileData));
      if (!match) return res.status(400).json({ error: 'El archivo debe ser una imagen o PDF válido.' });
      const ext = ATTACHMENT_MIME_EXTENSIONS[match[1].toLowerCase()];
      if (!ext) return res.status(400).json({ error: 'Tipo de archivo no permitido. Solo imágenes (PNG/JPG/WEBP) o PDF.' });
      const buffer = Buffer.from(match[2], 'base64');
      if (buffer.length > MAX_ATTACHMENT_BYTES) return res.status(400).json({ error: 'El archivo no puede superar 15 MB.' });

      const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12);
      const fileName = `mov-${m.id}-${hash}.${ext}`;
      fs.mkdirSync(attachmentsDir, { recursive: true });
      fs.writeFileSync(path.join(attachmentsDir, fileName), buffer);
      const documentReference = `${attachmentsWebPath}/${fileName}`.replace(/\\/g, '/');
      await query('UPDATE treasury_movements SET document_reference = ?, updated_at = datetime(\'now\') WHERE id = ?', [documentReference, m.id]);

      await writeAuditLog({
        userId: req.authUser.id, userName: actorName(req.authUser), userRole: roleCodeOf(req.authUser),
        moduleName: 'Tesoreria', actionName: 'Adjuntar comprobante', detail: JSON.stringify({ movementId: m.id, fileName }),
      });
      res.json({ ok: true, documentReference });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ── Auditoría ────────────────────────────────────────────────────────────

  router.get('/audit', requirePermission('ver_auditoria_caja_general'), async (req, res) => {
    try {
      const rows = await query(`
        SELECT * FROM audit_logs WHERE module_name = 'Tesoreria' ORDER BY created_at DESC LIMIT 200
      `);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

module.exports = { createTesoreriaRouter, ensureSchema };
