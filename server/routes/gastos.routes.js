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
 *  POST   /api/expenses            { ..., items?: [{ descripcion, cantidad, precio, itbisPct }] }
 *  GET    /api/expenses?categoria=&branchId=&desde=&hasta=&estado=
 *  GET    /api/expenses/:id        (incluye items; [] en gastos de un solo monto)
 *  PUT    /api/expenses/:id        (editar: mismo cuerpo que POST; reemplaza las líneas)
 *  GET    /api/expenses/categories (las de siempre + las propias que ya se usaron)
 *  POST   /api/expenses/:id/void
 */

const express = require('express');

function syncContabilidadFireAndForget(reason) {
  try {
    require('../sync/sync-pos-stats').syncPosStatsToFirestore()
      .catch((error) => console.warn(`[gastos][sync-contable] ${reason}:`, error.message));
  } catch (error) {
    console.warn(`[gastos][sync-contable] ${reason}:`, error.message);
  }
}

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

  // Líneas de un gasto (varios conceptos en una misma factura). La cabecera
  // (expenses) sigue guardando los totales: reportes, 606 y sync no cambian.
  // Un gasto sin líneas es uno de antes: una sola línea implícita.
  await query(`
    CREATE TABLE IF NOT EXISTS expense_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_id INT NOT NULL,
      orden INT NOT NULL DEFAULT 0,
      descripcion VARCHAR(255) NOT NULL,
      cantidad DECIMAL(12,2) NOT NULL DEFAULT 1.00,
      precio DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      itbis_pct DECIMAL(5,2) NOT NULL DEFAULT 0.00,
      subtotal DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      itbis DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      CONSTRAINT fk_expense_items_expense FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE
    )
  `);
  // Categoría por línea (una factura puede tener conceptos de varias categorías).
  await addColumnIfMissing(query, 'expense_items', 'categoria', 'VARCHAR(50) DEFAULT NULL');
}

// Sin comas: el listado junta las categorías de las líneas con GROUP_CONCAT.
function limpiarCategoria(valor) {
  return String(valor || '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
}

// Las de siempre primero, luego las propias del negocio en orden alfabético.
function unirCategorias(propias = []) {
  const vistas = new Set(EXPENSE_CATEGORIES.map((c) => c.toLowerCase()));
  const extra = [];
  propias.forEach((c) => {
    const limpia = String(c || '').trim().slice(0, 50);
    if (limpia && !vistas.has(limpia.toLowerCase())) { vistas.add(limpia.toLowerCase()); extra.push(limpia); }
  });
  return [...EXPENSE_CATEGORIES, ...extra.sort((a, b) => a.localeCompare(b, 'es'))];
}

const MAX_LINEAS_GASTO = 200;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Valida y calcula las líneas que manda el formulario. Lanza httpError con un
// mensaje para el usuario si una línea está incompleta. Una línea sin
// categoría toma la del gasto (categoriaPorDefecto).
function normalizarLineasGasto(raw, categoriaPorDefecto = null) {
  if (!Array.isArray(raw)) return [];
  if (raw.length > MAX_LINEAS_GASTO) throw httpError(`Un gasto admite hasta ${MAX_LINEAS_GASTO} líneas.`);
  const lineas = [];
  raw.forEach((it, i) => {
    const descripcion = String(it?.descripcion || '').trim().slice(0, 255);
    const cantidad = Number(it?.cantidad ?? 1);
    const precio = Number(it?.precio ?? 0);
    const itbisPct = Number(it?.itbisPct ?? 0);
    if (!descripcion && !(precio > 0)) return; // fila vacía: se ignora
    if (![cantidad, precio, itbisPct].every(Number.isFinite)) throw httpError(`Línea ${i + 1}: hay un monto no numérico.`);
    if (!descripcion) throw httpError(`Línea ${i + 1}: falta la descripción.`);
    if (!(cantidad > 0)) throw httpError(`Línea ${i + 1}: la cantidad debe ser mayor que cero.`);
    if (!(precio > 0)) throw httpError(`Línea ${i + 1}: el precio debe ser mayor que cero.`);
    if (itbisPct < 0 || itbisPct > 100) throw httpError(`Línea ${i + 1}: el ITBIS debe estar entre 0% y 100%.`);
    const subtotal = r2(cantidad * precio);
    const itbis = r2(subtotal * itbisPct / 100);
    const categoria = limpiarCategoria(it?.categoria) || categoriaPorDefecto || null;
    lineas.push({ descripcion, categoria, cantidad: r2(cantidad), precio: r2(precio), itbisPct: r2(itbisPct), subtotal, itbis, total: r2(subtotal + itbis) });
  });
  return lineas;
}

function mapExpenseItemRow(row) {
  return {
    id: row.id,
    descripcion: row.descripcion,
    categoria: row.categoria || '',
    cantidad: Number(row.cantidad || 0),
    precio: Number(row.precio || 0),
    itbisPct: Number(row.itbis_pct || 0),
    subtotal: Number(row.subtotal || 0),
    itbis: Number(row.itbis || 0),
    total: Number(row.total || 0),
  };
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
    // Todas las categorías del gasto (la principal + las de sus líneas).
    categorias: [...new Set([row.categoria, ...String(row.categorias_lineas || '').split(',')]
      .map((c) => String(c || '').trim()).filter(Boolean))],
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
  query, withTransaction, resolveRequestActorUser, userRoleHasPermission, writeAuditLog, getUserScopeBranchId,
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

  // El arranque solo migra cuando cambia CORE_SCHEMA_VERSION (server.js): por
  // si esta versión ya estaba marcada, el esquema de gastos se asegura aquí una
  // vez antes del primer pedido (CREATE TABLE IF NOT EXISTS, barato).
  let esquemaListo = null;
  router.use(async (_req, res, next) => {
    try {
      esquemaListo = esquemaListo || ensureSchema(query);
      await esquemaListo;
      next();
    } catch (e) {
      esquemaListo = null;
      res.status(500).json({ error: `No se pudo preparar la tabla de gastos: ${e.message}` });
    }
  });

  function requirePermission(permission) {
    return (req, res, next) => {
      if (isAdminGeneral(req.authUser) || userRoleHasPermission(req.authUser, permission)) return next();
      res.status(403).json({ error: 'No tienes permiso para realizar esta acción en Gastos.' });
    };
  }

  // Las de siempre + las que el negocio ya usó (categorías propias que se
  // escribieron en un gasto o en una línea), sin repetir.
  router.get('/categories', async (req, res) => {
    let propias = [];
    try {
      const rows = await query(
        `SELECT DISTINCT categoria FROM expenses WHERE categoria IS NOT NULL
         UNION SELECT DISTINCT categoria FROM expense_items WHERE categoria IS NOT NULL`
      );
      propias = rows.map((r) => String(r.categoria || '').trim()).filter(Boolean);
    } catch (_) { /* tabla aún sin migrar: solo las de siempre */ }
    res.json(unirCategorias(propias));
  });

  // Valida el cuerpo de POST/PUT y calcula los montos. Con líneas, los de la
  // cabecera salen de ellas (no se confía en los que mande el cliente); sin
  // líneas es un gasto de un solo monto, como antes.
  async function leerGasto(data, actor) {
    const categoria = limpiarCategoria(data.categoria);
    if (!categoria) throw httpError('Selecciona una categoría.');
    const lineas = normalizarLineasGasto(data.items, categoria);
    if (Array.isArray(data.items) && data.items.length && !lineas.length) {
      throw httpError('Agrega al menos una línea con descripción y monto.');
    }
    let descripcion = String(data.descripcion || '').trim().slice(0, 255);
    if (!descripcion && lineas.length) {
      descripcion = (lineas[0].descripcion + (lineas.length > 1 ? ` y ${lineas.length - 1} más` : '')).slice(0, 255);
    }
    if (!descripcion) throw httpError('La descripción es obligatoria.');
    const fecha = String(data.fecha || '').trim();
    if (!fecha) throw httpError('Indica la fecha del gasto.');
    const subtotal = lineas.length ? r2(lineas.reduce((t, l) => t + l.subtotal, 0)) : Number(data.subtotal || 0);
    if (!(subtotal > 0)) throw httpError('El monto debe ser mayor a 0.');
    const itbis = lineas.length ? r2(lineas.reduce((t, l) => t + l.itbis, 0)) : Math.max(0, Number(data.itbis || 0));
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

    return {
      lineas, branchId, categoria, descripcion, supplierId,
      beneficiario: String(data.beneficiario || '').trim() || null,
      ncf: data.ncf || null, tipoNcf: data.tipoNcf || null, fecha,
      fechaPago: estado === 'pagado' ? (data.fechaPago || fecha) : (data.fechaPago || null),
      subtotal, itbis, retencionIsr, retencionItbis, total, estado, notas: data.notas || null,
      formaPago, isrTipoRetencion, ncfModificado: String(data.ncfModificado || '').trim() || null,
    };
  }

  // Cabecera y líneas en una sola transacción: o queda todo o nada.
  function enTransaccion(trabajo) {
    return typeof withTransaction === 'function'
      ? withTransaction((conn) => trabajo((sql, params) => conn.query(sql, params)))
      : trabajo(query);
  }

  async function insertarLineas(run, expenseId, lineas) {
    for (let i = 0; i < lineas.length; i += 1) {
      const l = lineas[i];
      await run(
        `INSERT INTO expense_items (expense_id, orden, descripcion, categoria, cantidad, precio, itbis_pct, subtotal, itbis, total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [expenseId, i, l.descripcion, l.categoria, l.cantidad, l.precio, l.itbisPct, l.subtotal, l.itbis, l.total]
      );
    }
  }

  async function gastoConLineas(expenseId) {
    const [row] = await query(
      `SELECT e.*, s.nombre AS supplier_name, b.nombre AS branch_name
       FROM expenses e LEFT JOIN suppliers s ON s.id = e.supplier_id LEFT JOIN branches b ON b.id = e.branch_id
       WHERE e.id = ?`,
      [expenseId]
    );
    if (!row) return null;
    const items = (await query(
      'SELECT * FROM expense_items WHERE expense_id = ? ORDER BY orden, id', [row.id]
    ).catch(() => [])).map(mapExpenseItemRow);
    const categorias_lineas = items.map((i) => i.categoria).filter(Boolean).join(',');
    return { row, gasto: { ...mapExpenseRow({ ...row, categorias_lineas }), items } };
  }

  // ── Crear gasto ───────────────────────────────────────────────────────────
  router.post('/', requirePermission('gastos.crear'), async (req, res) => {
    const actor = req.authUser;
    try {
      const g = await leerGasto(req.body || {}, actor);
      const expenseId = await enTransaccion(async (run) => {
        const result = await run(
          `INSERT INTO expenses
            (branch_id, categoria, descripcion, supplier_id, beneficiario, ncf, tipo_ncf, fecha, fecha_pago,
             subtotal, itbis, retencion_isr, retencion_itbis, total, estado, notas,
             created_by_user_id, created_by_user_name, forma_pago, isr_tipo_retencion, ncf_modificado)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [g.branchId, g.categoria, g.descripcion, g.supplierId, g.beneficiario, g.ncf, g.tipoNcf, g.fecha, g.fechaPago,
           g.subtotal, g.itbis, g.retencionIsr, g.retencionItbis, g.total, g.estado, g.notas,
           actor.id, actorName(actor), g.formaPago, g.isrTipoRetencion, g.ncfModificado]
        );
        const id = Number(result.insertId);
        await insertarLineas(run, id, g.lineas);
        return id;
      });

      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Gastos', actionName: 'Gasto registrado',
        detail: `${g.categoria} · ${g.descripcion}${g.lineas.length > 1 ? ` (${g.lineas.length} líneas)` : ''} · RD$ ${g.total.toFixed(2)}`,
      });

      const creado = await gastoConLineas(expenseId);
      syncContabilidadFireAndForget('gasto registrado');
      res.status(201).json(creado ? creado.gasto : { id: expenseId, items: g.lineas });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Editar gasto ──────────────────────────────────────────────────────────
  // Mismo permiso que registrar. Reemplaza la cabecera y TODAS las líneas.
  // Un gasto anulado no se edita. Queda en la auditoría con el total de antes.
  router.put('/:id', requirePermission('gastos.crear'), async (req, res) => {
    const actor = req.authUser;
    const expenseId = Number(req.params.id);
    try {
      const [actual] = await query('SELECT * FROM expenses WHERE id = ?', [expenseId]);
      if (!actual) throw httpError('Gasto no encontrado.', 404);
      assertBranchAccess(actor, actual.branch_id);
      if (actual.estado === 'anulado') throw httpError('Un gasto anulado no se puede editar.', 409);
      const data = req.body || {};
      const g = await leerGasto({ ...data, tipoNcf: data.tipoNcf ?? actual.tipo_ncf }, actor);

      await enTransaccion(async (run) => {
        // Se vuelve a mirar dentro de la transacción por si lo anularon mientras
        // se editaba (no se usa affectedRows: un UPDATE sin cambios da 0 en
        // algunos drivers y parecería un error).
        const [fila] = await run('SELECT estado FROM expenses WHERE id = ?', [expenseId]);
        if (!fila || fila.estado === 'anulado') throw httpError('Este gasto fue anulado mientras lo editabas.', 409);
        await run(
          `UPDATE expenses SET branch_id = ?, categoria = ?, descripcion = ?, supplier_id = ?, beneficiario = ?,
             ncf = ?, tipo_ncf = ?, fecha = ?, fecha_pago = ?, subtotal = ?, itbis = ?, retencion_isr = ?,
             retencion_itbis = ?, total = ?, estado = ?, notas = ?, forma_pago = ?, isr_tipo_retencion = ?,
             ncf_modificado = ?
           WHERE id = ? AND estado <> 'anulado'`,
          [g.branchId, g.categoria, g.descripcion, g.supplierId, g.beneficiario, g.ncf, g.tipoNcf, g.fecha, g.fechaPago,
           g.subtotal, g.itbis, g.retencionIsr, g.retencionItbis, g.total, g.estado, g.notas,
           g.formaPago, g.isrTipoRetencion, g.ncfModificado, expenseId]
        );
        await run('DELETE FROM expense_items WHERE expense_id = ?', [expenseId]);
        await insertarLineas(run, expenseId, g.lineas);
      });

      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Gastos', actionName: 'Gasto editado',
        detail: `Gasto #${expenseId} · ${g.descripcion} · antes RD$ ${Number(actual.total || 0).toFixed(2)} → ahora RD$ ${g.total.toFixed(2)}`,
      });

      const editado = await gastoConLineas(expenseId);
      syncContabilidadFireAndForget('gasto editado');
      res.json(editado ? editado.gasto : { id: expenseId });
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
        `SELECT e.*, s.nombre AS supplier_name, b.nombre AS branch_name,
           (SELECT GROUP_CONCAT(DISTINCT ei.categoria) FROM expense_items ei WHERE ei.expense_id = e.id) AS categorias_lineas
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
      const encontrado = await gastoConLineas(Number(req.params.id));
      if (!encontrado) return res.status(404).json({ error: 'Gasto no encontrado.' });
      assertBranchAccess(req.authUser, encontrado.row.branch_id);
      res.json(encontrado.gasto);
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

      syncContabilidadFireAndForget('gasto anulado');
      res.json({ ok: true, message: `Gasto #${expenseId} anulado.` });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createGastosRouter, ensureSchema, EXPENSE_CATEGORIES, normalizarLineasGasto, unirCategorias };
