'use strict';

/**
 * gastos.routes.js — Gastos operativos (Fase 2 de Compras y Gastos)
 * Factory pattern con inyección de dependencias, igual que compras.routes.js.
 *
 * Registro FISCAL de gastos (categoría, NCF, ITBIS, retenciones ISR/ITBIS)
 * para efectos de reporte (ej. futuro Formato 606) — NO descuenta ningún
 * fondo de Tesorería/Caja General (decisión confirmada con Emilio, mismo
 * criterio que Compras al contado). Si el negocio quiere que un gasto salga
 * de una caja real, sigue usando POST /api/tesoreria/expense por separado;
 * ambos flujos son independientes a propósito en esta fase.
 *
 * La contabilidad (asientos, mapa de cuentas, estados financieros) NO vive
 * aquí — corresponde a tecno-caja-contadores.
 *
 * Rutas:
 *  POST   /api/expenses
 *  GET    /api/expenses?categoria=&branchId=&desde=&hasta=&estado=
 *  GET    /api/expenses/:id
 *  POST   /api/expenses/:id/void
 */

const express = require('express');

const EXPENSE_CATEGORIES = [
  'Alquiler', 'Electricidad', 'Internet', 'Agua', 'Combustible', 'Publicidad',
  'Papelería', 'Nómina', 'Seguridad', 'Limpieza', 'Mantenimiento', 'Honorarios',
  'Impuestos', 'Servicios', 'Caja Chica', 'Otros',
];

// Default del campo 3 ("Tipo de Bienes y Servicios Comprados", código 1-11)
// del Formato 606 DGII por categoría de gasto — editable por el usuario al
// capturar el gasto, ver server.js GET /api/reports/advanced/dgii/exportar-contador.
const EXPENSE_CATEGORY_TO_DGII_CODE = {
  'Alquiler': 3,       // Arrendamientos
  'Electricidad': 2, 'Internet': 2, 'Agua': 2, 'Servicios': 2, 'Mantenimiento': 2, 'Seguridad': 2, 'Limpieza': 2,
  'Combustible': 2,
  'Publicidad': 5,     // Gastos de representación
  'Papelería': 6,      // Otras deducciones admitidas
  'Nómina': 1,         // Gastos de personal
  'Honorarios': 2,     // Gastos por trabajos, suministros y servicios
  'Impuestos': 6,
  'Caja Chica': 6,
  'Otros': 6,
};

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
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INT NOT NULL,
      categoria VARCHAR(50) NOT NULL,
      descripcion VARCHAR(255) NOT NULL,
      supplier_id INT DEFAULT NULL,
      beneficiario VARCHAR(160) DEFAULT NULL,
      ncf VARCHAR(30) DEFAULT NULL,
      tipo_ncf VARCHAR(10) DEFAULT NULL,
      fecha DATE NOT NULL,
      fecha_pago DATE DEFAULT NULL,
      subtotal DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      itbis DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      retencion_isr DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      retencion_itbis DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      estado VARCHAR(20) NOT NULL DEFAULT 'pagado',
      notas VARCHAR(255) DEFAULT NULL,
      motivo_anulacion VARCHAR(255) DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      anulado_at DATETIME DEFAULT NULL,
      anulado_by_user_id INT DEFAULT NULL,
      anulado_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_expenses_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL
    )
  `);

  // Campos que faltaban para el Formato 606 DGII (ver EXPENSE_CATEGORY_TO_DGII_CODE
  // arriba y server.js GET /api/reports/advanced/dgii/exportar-contador).
  await addColumnIfMissing(query, 'expenses', 'forma_pago', 'INT DEFAULT NULL');
  await addColumnIfMissing(query, 'expenses', 'isr_tipo_retencion', 'INT DEFAULT NULL');
  await addColumnIfMissing(query, 'expenses', 'ncf_modificado', 'VARCHAR(30) DEFAULT NULL');
}

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function mapExpenseRow(row) {
  const total = Number(row.total || 0);
  const retenciones = Number(row.retencion_isr || 0) + Number(row.retencion_itbis || 0);
  return {
    id: row.id,
    branchId: row.branch_id,
    sucursal: row.branch_name || '',
    categoria: row.categoria,
    descripcion: row.descripcion,
    supplierId: row.supplier_id,
    proveedor: row.supplier_name || '',
    beneficiario: row.beneficiario || '',
    ncf: row.ncf || '',
    tipoNcf: row.tipo_ncf || '',
    fecha: row.fecha,
    fechaPago: row.fecha_pago,
    subtotal: Number(row.subtotal || 0),
    itbis: Number(row.itbis || 0),
    retencionIsr: Number(row.retencion_isr || 0),
    retencionItbis: Number(row.retencion_itbis || 0),
    formaPago: row.forma_pago != null ? Number(row.forma_pago) : null,
    isrTipoRetencion: row.isr_tipo_retencion != null ? Number(row.isr_tipo_retencion) : null,
    ncfModificado: row.ncf_modificado || '',
    tipoBienesServicios: EXPENSE_CATEGORY_TO_DGII_CODE[row.categoria] || 6,
    total,
    montoNetoBeneficiario: Number((total - retenciones).toFixed(2)),
    estado: row.estado,
    notas: row.notas || '',
    motivoAnulacion: row.motivo_anulacion || '',
    creadoPor: row.created_by_user_name || '',
    createdAt: row.created_at,
  };
}

function createGastosRouter({
  query, resolveRequestActorUser, userRoleHasPermission, writeAuditLog, getUserScopeBranchId,
}) {
  const router = express.Router();

  function roleCodeOf(actor) {
    return String(actor?.role_code || actor?.rol || '').trim().toLowerCase();
  }
  function isAdminGeneral(actor) {
    return roleCodeOf(actor) === 'administrador_general';
  }
  function actorName(actor) {
    return actor?.nombre || actor?.usuario || 'Sistema';
  }

  function resolveBranchScope(actor, requestedBranchId) {
    if (isAdminGeneral(actor)) {
      return requestedBranchId ? Number(requestedBranchId) : null;
    }
    const scopedBranchId = getUserScopeBranchId(actor);
    if (!scopedBranchId) {
      throw httpError('Tu usuario no tiene una sucursal asignada.', 403);
    }
    if (requestedBranchId && Number(requestedBranchId) !== Number(scopedBranchId)) {
      throw httpError('No puedes operar con otra sucursal.', 403);
    }
    return Number(scopedBranchId);
  }

  // Ver comentario equivalente en compras.routes.js: los listados sí filtran
  // por sucursal, pero las rutas por :id no volvían a validar esto.
  function assertBranchAccess(actor, branchId) {
    resolveBranchScope(actor, branchId ? Number(branchId) : null);
  }

  async function requireGastos(req, res, next) {
    try {
      const actor = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
      if (!isAdminGeneral(actor) && !userRoleHasPermission(actor, 'gastos.ver')) {
        return res.status(403).json({ error: 'No tienes permiso para acceder a Gastos.' });
      }
      req.authUser = actor;
      next();
    } catch (e) {
      res.status(e.statusCode || 401).json({ error: e.message || 'Sesión inválida o expirada.' });
    }
  }
  router.use(requireGastos);

  function requirePermission(permission) {
    return (req, res, next) => {
      if (isAdminGeneral(req.authUser) || userRoleHasPermission(req.authUser, permission)) return next();
      res.status(403).json({ error: 'No tienes permiso para realizar esta acción en Gastos.' });
    };
  }

  router.get('/categories', (req, res) => {
    res.json(EXPENSE_CATEGORIES);
  });

  // ── Crear gasto ───────────────────────────────────────────────────────────
  router.post('/', requirePermission('gastos.crear'), async (req, res) => {
    const data = req.body || {};
    const actor = req.authUser;
    try {
      const categoria = String(data.categoria || '').trim();
      if (!categoria) throw httpError('Selecciona una categoría.');
      const descripcion = String(data.descripcion || '').trim();
      if (!descripcion) throw httpError('La descripción es obligatoria.');
      const fecha = String(data.fecha || '').trim();
      if (!fecha) throw httpError('Indica la fecha del gasto.');
      const subtotal = Number(data.subtotal || 0);
      if (!(subtotal > 0)) throw httpError('El monto debe ser mayor a 0.');
      const itbis = Math.max(0, Number(data.itbis || 0));
      const retencionIsr = Math.max(0, Number(data.retencionIsr || 0)) || 0;
      const retencionItbis = Math.max(0, Number(data.retencionItbis || 0)) || 0;
      const total = Number((subtotal + itbis).toFixed(2));
      if (!Number.isFinite(total)) throw httpError('Revisa los montos ingresados: hay un valor no numérico en el gasto.');
      const estado = data.estado === 'pendiente' ? 'pendiente' : 'pagado';
      const supplierId = data.supplierId ? Number(data.supplierId) : null;

      const branchId = resolveBranchScope(actor, data.branchId ? Number(data.branchId) : null);
      if (!branchId) throw httpError('Indica la sucursal del gasto.');

      if (supplierId) {
        const [supplier] = await query('SELECT id FROM suppliers WHERE id = ? LIMIT 1', [supplierId]);
        if (!supplier) throw httpError('Proveedor no encontrado.', 404);
      }

      // Formato 606 DGII — opcionales, no bloquean el registro rápido del gasto.
      const formaPago = Number.isInteger(Number(data.formaPago)) && Number(data.formaPago) >= 1 && Number(data.formaPago) <= 7
        ? Number(data.formaPago) : null;
      const isrTipoRetencion = Number.isInteger(Number(data.isrTipoRetencion)) && Number(data.isrTipoRetencion) >= 1 && Number(data.isrTipoRetencion) <= 9
        ? Number(data.isrTipoRetencion) : null;
      const ncfModificado = String(data.ncfModificado || '').trim() || null;

      const result = await query(
        `INSERT INTO expenses
          (branch_id, categoria, descripcion, supplier_id, beneficiario, ncf, tipo_ncf, fecha, fecha_pago,
           subtotal, itbis, retencion_isr, retencion_itbis, total, estado, notas,
           created_by_user_id, created_by_user_name, forma_pago, isr_tipo_retencion, ncf_modificado)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [branchId, categoria, descripcion, supplierId, String(data.beneficiario || '').trim() || null,
         data.ncf || null, data.tipoNcf || null, fecha, estado === 'pagado' ? (data.fechaPago || fecha) : (data.fechaPago || null),
         subtotal, itbis, retencionIsr, retencionItbis, total, estado, data.notas || null,
         actor.id, actorName(actor), formaPago, isrTipoRetencion, ncfModificado]
      );

      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Gastos', actionName: 'Gasto registrado',
        detail: `${categoria} · ${descripcion} · RD$ ${total.toFixed(2)}`,
      });

      const [row] = await query(
        `SELECT e.*, s.nombre AS supplier_name, b.nombre AS branch_name
         FROM expenses e LEFT JOIN suppliers s ON s.id = e.supplier_id LEFT JOIN branches b ON b.id = e.branch_id
         WHERE e.id = ?`,
        [result.insertId]
      );
      res.status(201).json(mapExpenseRow(row));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Listar gastos ─────────────────────────────────────────────────────────
  router.get('/', requirePermission('gastos.ver'), async (req, res) => {
    try {
      const branchScope = resolveBranchScope(req.authUser, req.query.branchId ? Number(req.query.branchId) : null);
      const conditions = [];
      const params = [];
      if (branchScope) { conditions.push('e.branch_id = ?'); params.push(branchScope); }
      if (req.query.categoria) { conditions.push('e.categoria = ?'); params.push(String(req.query.categoria)); }
      if (req.query.estado) { conditions.push('e.estado = ?'); params.push(String(req.query.estado)); }
      if (req.query.desde) { conditions.push('e.fecha >= ?'); params.push(String(req.query.desde)); }
      if (req.query.hasta) { conditions.push('e.fecha <= ?'); params.push(String(req.query.hasta)); }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = await query(
        `SELECT e.*, s.nombre AS supplier_name, b.nombre AS branch_name
         FROM expenses e
         LEFT JOIN suppliers s ON s.id = e.supplier_id
         LEFT JOIN branches b ON b.id = e.branch_id
         ${where}
         ORDER BY e.fecha DESC, e.id DESC
         LIMIT 500`,
        params
      );
      res.json(rows.map(mapExpenseRow));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Detalle ───────────────────────────────────────────────────────────────
  router.get('/:id', requirePermission('gastos.ver'), async (req, res) => {
    try {
      const [row] = await query(
        `SELECT e.*, s.nombre AS supplier_name, b.nombre AS branch_name
         FROM expenses e LEFT JOIN suppliers s ON s.id = e.supplier_id LEFT JOIN branches b ON b.id = e.branch_id
         WHERE e.id = ?`,
        [Number(req.params.id)]
      );
      if (!row) return res.status(404).json({ error: 'Gasto no encontrado.' });
      assertBranchAccess(req.authUser, row.branch_id);
      res.json(mapExpenseRow(row));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Anular ────────────────────────────────────────────────────────────────
  router.post('/:id/void', requirePermission('gastos.anular'), async (req, res) => {
    const actor = req.authUser;
    const expenseId = Number(req.params.id);
    const motivo = String(req.body?.motivo || '').trim() || null;
    try {
      const [expense] = await query('SELECT * FROM expenses WHERE id = ?', [expenseId]);
      if (!expense) throw httpError('Gasto no encontrado.', 404);
      assertBranchAccess(actor, expense.branch_id);
      if (expense.estado === 'anulado') throw httpError('Este gasto ya fue anulado.', 409);

      // WHERE estado <> 'anulado' hace el check-then-act atómico a nivel de
      // fila: si dos anulaciones llegan casi juntas, solo una actualiza filas
      // y genera un registro de auditoría (sin esto, ambas pasaban el chequeo
      // de arriba antes de que la primera terminara).
      const updateResult = await query(
        `UPDATE expenses SET estado = 'anulado', motivo_anulacion = ?, anulado_at = CURRENT_TIMESTAMP,
           anulado_by_user_id = ?, anulado_by_user_name = ? WHERE id = ? AND estado <> 'anulado'`,
        [motivo, actor.id, actorName(actor), expenseId]
      );
      if (!updateResult.affectedRows) throw httpError('Este gasto ya fue anulado.', 409);

      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Gastos', actionName: 'Gasto anulado',
        detail: `Gasto #${expenseId}${motivo ? ' · ' + motivo : ''}`,
      });

      res.json({ ok: true, message: `Gasto #${expenseId} anulado.` });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createGastosRouter, ensureSchema, EXPENSE_CATEGORIES };
