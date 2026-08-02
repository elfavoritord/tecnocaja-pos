'use strict';

/**
 * compras.routes.js — Compras (Fase 1: Compras + Cuentas por pagar)
 * Factory pattern con inyección de dependencias, igual que tesoreria.routes.js/rrhh.routes.js.
 *
 * Registra compras de mercancía con renglones de producto: actualiza inventario
 * y último costo, y genera automáticamente su cuenta por pagar reutilizando
 * supplier_invoices/supplier_payments (NO se duplica ese cálculo — las alertas
 * y el detalle de proveedor en server.js siguen siendo dueños de ese cómputo).
 *
 * La contabilidad (asientos automáticos, mapa de cuentas, Diario/Mayor/Balance/
 * Estados Financieros) NO vive aquí — corresponde a tecno-caja-contadores,
 * explícitamente fuera de alcance de esta fase.
 *
 * Una compra "al contado" solo se marca como pagada (genera su propio
 * supplier_payments automático) — NO descuenta ningún fondo de Tesorería/Caja
 * General. Conectar con caja real queda para una fase posterior.
 *
 * Rutas:
 *  POST   /api/purchases
 *  GET    /api/purchases?supplierId=&branchId=&desde=&hasta=&estado=
 *  GET    /api/purchases/accounts-payable?supplierId=
 *  GET    /api/purchases/:id
 *  POST   /api/purchases/:id/void
 */

const express = require('express');

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
    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INT NOT NULL,
      supplier_invoice_id INT DEFAULT NULL,
      branch_id INT NOT NULL,
      numero_documento VARCHAR(60) NOT NULL,
      ncf VARCHAR(30) DEFAULT NULL,
      tipo_ncf VARCHAR(10) DEFAULT NULL,
      fecha_comprobante DATE NOT NULL,
      fecha_recepcion DATE NOT NULL,
      condicion_pago VARCHAR(20) NOT NULL DEFAULT 'contado',
      fecha_vencimiento DATE DEFAULT NULL,
      subtotal DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      descuento DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      itbis DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      estado VARCHAR(20) NOT NULL DEFAULT 'activa',
      notas VARCHAR(255) DEFAULT NULL,
      motivo_anulacion VARCHAR(255) DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      anulada_at DATETIME DEFAULT NULL,
      anulada_by_user_id INT DEFAULT NULL,
      anulada_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_purchases_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT,
      CONSTRAINT fk_purchases_invoice FOREIGN KEY (supplier_invoice_id) REFERENCES supplier_invoices(id) ON DELETE SET NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS purchase_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id INT NOT NULL,
      product_id INT NOT NULL,
      codigo VARCHAR(60) NOT NULL,
      nombre VARCHAR(160) NOT NULL,
      cantidad DECIMAL(10,2) NOT NULL,
      costo_unitario DECIMAL(12,2) NOT NULL,
      itbis_pct DECIMAL(5,2) NOT NULL DEFAULT 0.00,
      subtotal DECIMAL(12,2) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_purchase_items_purchase FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE,
      CONSTRAINT fk_purchase_items_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
    )
  `);

  // Enlace de vuelta desde la cuenta por pagar/pago hacia la compra que los generó.
  await addColumnIfMissing(query, 'supplier_invoices', 'purchase_id', 'INT DEFAULT NULL');
  await addColumnIfMissing(query, 'supplier_payments', 'purchase_id', 'INT DEFAULT NULL');
}

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function mapPurchaseRow(row) {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    proveedor: row.supplier_name || '',
    supplierInvoiceId: row.supplier_invoice_id,
    branchId: row.branch_id,
    sucursal: row.branch_name || '',
    numeroDocumento: row.numero_documento,
    ncf: row.ncf || '',
    tipoNcf: row.tipo_ncf || '',
    fechaComprobante: row.fecha_comprobante,
    fechaRecepcion: row.fecha_recepcion,
    condicionPago: row.condicion_pago,
    fechaVencimiento: row.fecha_vencimiento,
    subtotal: Number(row.subtotal || 0),
    descuento: Number(row.descuento || 0),
    itbis: Number(row.itbis || 0),
    total: Number(row.total || 0),
    estado: row.estado,
    notas: row.notas || '',
    motivoAnulacion: row.motivo_anulacion || '',
    creadoPor: row.created_by_user_name || '',
    createdAt: row.created_at,
  };
}

function mapPurchaseItemRow(row) {
  return {
    id: row.id,
    productId: row.product_id,
    codigo: row.codigo,
    nombre: row.nombre,
    cantidad: Number(row.cantidad || 0),
    costoUnitario: Number(row.costo_unitario || 0),
    itbisPct: Number(row.itbis_pct || 0),
    subtotal: Number(row.subtotal || 0),
  };
}

function createComprasRouter({
  query, withTransaction, resolveRequestActorUser, userRoleHasPermission, writeAuditLog, getUserScopeBranchId,
  changeBranchInventoryStock, registerInventoryMovement, mapSupplierInvoiceRow, resolveSupplierInvoiceStatus,
  isMysqlDeployment,
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

  // Resuelve a qué sucursal debe quedar limitada la consulta/acción. Devuelve
  // null cuando el actor puede ver todas las sucursales (consolidado) — mismo
  // patrón que tesoreria.routes.js.
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

  // Verifica que un recurso YA CARGADO (por id) pertenezca a la sucursal del
  // actor. Los listados (GET /) sí filtran por sucursal vía resolveBranchScope,
  // pero las rutas por :id no volvían a validar esto — un cajero de la
  // Sucursal A podía ver/anular una compra de la Sucursal B solo adivinando
  // el id, ya que los ids son autoincrementales.
  function assertBranchAccess(actor, branchId) {
    resolveBranchScope(actor, branchId ? Number(branchId) : null);
  }

  async function requireCompras(req, res, next) {
    try {
      const actor = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
      if (!isAdminGeneral(actor) && !userRoleHasPermission(actor, 'compras.ver')) {
        return res.status(403).json({ error: 'No tienes permiso para acceder a Compras.' });
      }
      req.authUser = actor;
      next();
    } catch (e) {
      res.status(e.statusCode || 401).json({ error: e.message || 'Sesión inválida o expirada.' });
    }
  }
  router.use(requireCompras);

  function requirePermission(permission) {
    return (req, res, next) => {
      if (isAdminGeneral(req.authUser) || userRoleHasPermission(req.authUser, permission)) return next();
      res.status(403).json({ error: 'No tienes permiso para realizar esta acción en Compras.' });
    };
  }

  // ── Crear compra ─────────────────────────────────────────────────────────
  router.post('/', requirePermission('compras.crear'), async (req, res) => {
    const data = req.body || {};
    const actor = req.authUser;
    try {
      const supplierId = Number(data.supplierId || 0);
      if (!supplierId) throw httpError('Selecciona un proveedor.');
      const numeroDocumento = String(data.numeroDocumento || '').trim();
      if (!numeroDocumento) throw httpError('El número de documento del proveedor es obligatorio.');
      const fechaComprobante = String(data.fechaComprobante || '').trim();
      if (!fechaComprobante) throw httpError('La fecha del comprobante es obligatoria.');
      const fechaRecepcion = String(data.fechaRecepcion || fechaComprobante || '').trim();
      const condicionPago = data.condicionPago === 'credito' ? 'credito' : 'contado';
      const fechaVencimiento = condicionPago === 'credito' ? (String(data.fechaVencimiento || '').trim() || null) : null;
      if (condicionPago === 'credito' && !fechaVencimiento) {
        throw httpError('Indica la fecha de vencimiento para una compra a crédito.');
      }

      const items = Array.isArray(data.items) ? data.items : [];
      if (!items.length) throw httpError('Agrega al menos un producto a la compra.');
      for (const it of items) {
        if (!it.productId) throw httpError('Todos los renglones deben tener un producto seleccionado.');
        if (!(Number(it.cantidad) > 0)) throw httpError(`Cantidad inválida para "${it.nombre || it.codigo || 'producto'}".`);
        if (!(Number(it.costoUnitario) >= 0)) throw httpError(`Costo inválido para "${it.nombre || it.codigo || 'producto'}".`);
      }

      const branchId = resolveBranchScope(actor, data.branchId ? Number(data.branchId) : null);
      if (!branchId) throw httpError('Indica la sucursal de la compra.');

      const [supplier] = await query('SELECT * FROM suppliers WHERE id = ? LIMIT 1', [supplierId]);
      if (!supplier) throw httpError('Proveedor no encontrado.', 404);

      // Recalcular SIEMPRE server-side — nunca confiar en los totales que manda el cliente.
      let subtotal = 0;
      let itbisTotal = 0;
      const lines = items.map((it) => {
        const cantidad = Number(it.cantidad);
        const costoUnitario = Number(it.costoUnitario);
        const itbisPct = Number(it.itbisPct || 0);
        const lineSubtotal = Number((cantidad * costoUnitario).toFixed(2));
        const lineItbis = Number((lineSubtotal * itbisPct / 100).toFixed(2));
        subtotal += lineSubtotal;
        itbisTotal += lineItbis;
        return {
          productId: Number(it.productId),
          codigo: String(it.codigo || '').trim(),
          nombre: String(it.nombre || '').trim(),
          cantidad, costoUnitario, itbisPct, subtotal: lineSubtotal,
        };
      });
      const descuento = Math.max(0, Number(data.descuento || 0));
      const total = Number((subtotal - descuento + itbisTotal).toFixed(2));
      if (!Number.isFinite(total)) throw httpError('Revisa los montos ingresados: hay un valor no numérico en la compra.');
      if (total <= 0) throw httpError('El total de la compra debe ser mayor a 0.');

      const result = await withTransaction(async (conn) => {
        const purchaseInsert = await conn.query(
          `INSERT INTO purchases
            (supplier_id, branch_id, numero_documento, ncf, tipo_ncf, fecha_comprobante, fecha_recepcion,
             condicion_pago, fecha_vencimiento, subtotal, descuento, itbis, total, estado, notas,
             created_by_user_id, created_by_user_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'activa', ?, ?, ?)`,
          [supplierId, branchId, numeroDocumento, data.ncf || null, data.tipoNcf || null, fechaComprobante, fechaRecepcion,
           condicionPago, fechaVencimiento, subtotal, descuento, itbisTotal, total, data.notas || null,
           actor.id, actorName(actor)]
        );
        const purchaseId = purchaseInsert.insertId;

        for (const line of lines) {
          await conn.query(
            `INSERT INTO purchase_items (purchase_id, product_id, codigo, nombre, cantidad, costo_unitario, itbis_pct, subtotal)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [purchaseId, line.productId, line.codigo, line.nombre, line.cantidad, line.costoUnitario, line.itbisPct, line.subtotal]
          );

          const stockChange = await changeBranchInventoryStock(conn, {
            productId: line.productId, branchId, quantityDelta: Math.abs(line.cantidad), preventNegative: false,
          });
          await registerInventoryMovement(conn, {
            productId: line.productId, branchId, tipo: 'compra', cantidad: Math.abs(line.cantidad),
            stockAnterior: stockChange.previousStock, stockNuevo: stockChange.nextStock, costoUnitario: line.costoUnitario,
            referenciaTipo: 'compra', referenciaId: String(purchaseId),
            notas: `Entrada por compra #${purchaseId} · ${numeroDocumento}`,
            usuarioId: actor.id, usuarioNombre: actorName(actor),
          });
          // Overwrite simple del último costo — sin promedio ponderado (sin precedente en el proyecto).
          await conn.query('UPDATE products SET precio_compra = ? WHERE id = ?', [line.costoUnitario, line.productId]);
        }

        const isContado = condicionPago === 'contado';
        const paidAmount = isContado ? total : 0;
        const pendingAmount = isContado ? 0 : total;
        const status = resolveSupplierInvoiceStatus({ pending_amount: pendingAmount, due_at: fechaVencimiento });

        const invoiceInsert = await conn.query(
          `INSERT INTO supplier_invoices
            (supplier_id, invoice_number, issued_at, due_at, total_amount, paid_amount, pending_amount, status, notes, ncf, tipo_ncf, itbis_amount, purchase_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [supplierId, numeroDocumento, fechaComprobante, fechaVencimiento, total, paidAmount, pendingAmount, status,
           `Generada automáticamente por Compra #${purchaseId}`, data.ncf || null, data.tipoNcf || null, itbisTotal, purchaseId]
        );
        const invoiceId = invoiceInsert.insertId;
        await conn.query('UPDATE purchases SET supplier_invoice_id = ? WHERE id = ?', [invoiceId, purchaseId]);

        // Compra al contado: solo se marca pagada — NO se descuenta ningún
        // fondo de Tesorería/Caja General (decisión confirmada con Emilio).
        if (isContado) {
          await conn.query(
            `INSERT INTO supplier_payments (supplier_id, invoice_id, monto, metodo_pago, fecha_pago, notas, created_by, purchase_id)
             VALUES (?, ?, ?, 'Efectivo', ?, ?, ?, ?)`,
            [supplierId, invoiceId, total, fechaComprobante,
             `Pago automático al registrar Compra #${purchaseId} (contado)`, actorName(actor), purchaseId]
          );
        }

        return { purchaseId, invoiceId };
      });

      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Compras', actionName: 'Compra registrada',
        detail: `${supplier.nombre} · ${numeroDocumento} · RD$ ${total.toFixed(2)} · ${condicionPago}`,
      });

      const [row] = await query(
        `SELECT p.*, s.nombre AS supplier_name FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?`,
        [result.purchaseId]
      );
      res.status(201).json(mapPurchaseRow(row));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Listar compras ───────────────────────────────────────────────────────
  router.get('/', requirePermission('compras.ver'), async (req, res) => {
    try {
      const branchScope = resolveBranchScope(req.authUser, req.query.branchId ? Number(req.query.branchId) : null);
      const conditions = [];
      const params = [];
      if (branchScope) { conditions.push('p.branch_id = ?'); params.push(branchScope); }
      if (req.query.supplierId) { conditions.push('p.supplier_id = ?'); params.push(Number(req.query.supplierId)); }
      if (req.query.estado) { conditions.push('p.estado = ?'); params.push(String(req.query.estado)); }
      if (req.query.desde) { conditions.push('p.fecha_comprobante >= ?'); params.push(String(req.query.desde)); }
      if (req.query.hasta) { conditions.push('p.fecha_comprobante <= ?'); params.push(String(req.query.hasta)); }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = await query(
        `SELECT p.*, s.nombre AS supplier_name, b.nombre AS branch_name
         FROM purchases p
         LEFT JOIN suppliers s ON s.id = p.supplier_id
         LEFT JOIN branches b ON b.id = p.branch_id
         ${where}
         ORDER BY p.fecha_comprobante DESC, p.id DESC
         LIMIT 500`,
        params
      );
      res.json(rows.map(mapPurchaseRow));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Cuentas por pagar (vista global cross-proveedor) ────────────────────
  // Filtra por pending_amount > 0 en vez de `status` porque Tesorería
  // (POST /api/tesoreria/supplier-payments) escribe 'pagada'/'parcial' en
  // minúscula sobre la misma tabla, mientras este flujo usa
  // 'Pendiente'/'Vencida'/'Pagada' — pending_amount es la fuente de verdad
  // robusta a ambos orígenes.
  router.get('/accounts-payable', requirePermission('cuentas_por_pagar.ver'), async (req, res) => {
    try {
      const conditions = ['si.pending_amount > 0'];
      const params = [];
      if (req.query.supplierId) { conditions.push('si.supplier_id = ?'); params.push(Number(req.query.supplierId)); }
      const rows = await query(
        `SELECT si.*, s.nombre AS supplier_name, s.telefono, s.limite_credito
         FROM supplier_invoices si
         INNER JOIN suppliers s ON s.id = si.supplier_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY si.due_at ASC, si.id DESC`,
        params
      );
      const today = new Date().toISOString().slice(0, 10);
      let totalPendiente = 0;
      let totalVencido = 0;
      let totalPorVencer7dias = 0;
      const cuentas = rows.map((row) => {
        const mapped = mapSupplierInvoiceRow(row);
        const dueAt = String(row.due_at || '').slice(0, 10);
        const vencida = Boolean(dueAt) && dueAt < today;
        const diasVencido = vencida ? Math.floor((new Date(today) - new Date(dueAt)) / 86400000) : 0;
        const diasParaVencer = dueAt && !vencida ? Math.ceil((new Date(dueAt) - new Date(today)) / 86400000) : null;
        totalPendiente += mapped.montoPendiente;
        if (vencida) totalVencido += mapped.montoPendiente;
        if (diasParaVencer !== null && diasParaVencer <= 7) totalPorVencer7dias += mapped.montoPendiente;
        return { ...mapped, vencida, diasVencido, diasParaVencer };
      });
      res.json({
        cuentas,
        resumen: {
          totalPendiente: Number(totalPendiente.toFixed(2)),
          totalVencido: Number(totalVencido.toFixed(2)),
          totalPorVencer7dias: Number(totalPorVencer7dias.toFixed(2)),
          cantidadFacturas: cuentas.length,
        },
      });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Detalle de compra (con renglones) ───────────────────────────────────
  router.get('/:id', requirePermission('compras.ver'), async (req, res) => {
    try {
      const purchaseId = Number(req.params.id);
      const [row] = await query(
        `SELECT p.*, s.nombre AS supplier_name, b.nombre AS branch_name
         FROM purchases p
         LEFT JOIN suppliers s ON s.id = p.supplier_id
         LEFT JOIN branches b ON b.id = p.branch_id
         WHERE p.id = ?`,
        [purchaseId]
      );
      if (!row) return res.status(404).json({ error: 'Compra no encontrada.' });
      assertBranchAccess(req.authUser, row.branch_id);
      const items = await query('SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY id', [purchaseId]);
      res.json({ ...mapPurchaseRow(row), items: items.map(mapPurchaseItemRow) });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Anular compra ────────────────────────────────────────────────────────
  router.post('/:id/void', requirePermission('compras.anular'), async (req, res) => {
    const actor = req.authUser;
    const purchaseId = Number(req.params.id);
    const motivo = String(req.body?.motivo || '').trim() || null;
    try {
      await withTransaction(async (conn) => {
        // FOR UPDATE (solo MySQL) evita que dos clics/anulaciones simultáneas
        // de la misma compra lean ambas estado='activa' antes de que la
        // primera confirme y terminen revirtiendo el inventario dos veces.
        const [purchase] = await conn.query(
          `SELECT * FROM purchases WHERE id = ?${isMysqlDeployment() ? ' FOR UPDATE' : ''}`,
          [purchaseId]
        );
        if (!purchase) throw httpError('Compra no encontrada.', 404);
        assertBranchAccess(actor, purchase.branch_id);
        if (purchase.estado !== 'activa') throw httpError('Esta compra ya fue anulada.', 409);

        const [invoice] = purchase.supplier_invoice_id
          ? await conn.query('SELECT * FROM supplier_invoices WHERE id = ?', [purchase.supplier_invoice_id])
          : [null];

        // Si es crédito y ya tiene abonos manuales aplicados, anular dejaría
        // el balance del proveedor inconsistente — hay que reversar los
        // abonos primero desde Proveedores.
        if (invoice && purchase.condicion_pago === 'credito' && Number(invoice.paid_amount) > 0) {
          throw httpError('No se puede anular: la factura vinculada ya tiene abonos registrados. Reversa los abonos primero.', 409);
        }

        const items = await conn.query('SELECT * FROM purchase_items WHERE purchase_id = ?', [purchaseId]);
        for (const item of items) {
          const stockChange = await changeBranchInventoryStock(conn, {
            productId: item.product_id, branchId: purchase.branch_id,
            quantityDelta: -Math.abs(Number(item.cantidad)), preventNegative: false,
          });
          await registerInventoryMovement(conn, {
            productId: item.product_id, branchId: purchase.branch_id, tipo: 'compra_anulada',
            cantidad: -Math.abs(Number(item.cantidad)),
            stockAnterior: stockChange.previousStock, stockNuevo: stockChange.nextStock, costoUnitario: item.costo_unitario,
            referenciaTipo: 'compra_anulada', referenciaId: String(purchaseId),
            notas: `Reverso por anulación de Compra #${purchaseId}`,
            usuarioId: actor.id, usuarioNombre: actorName(actor),
          });
        }

        if (invoice) {
          await conn.query(
            `UPDATE supplier_invoices SET status = 'Anulada', pending_amount = 0, paid_amount = 0 WHERE id = ?`,
            [invoice.id]
          );
          // Borra solo el pago automático que la propia compra generó
          // (contado) — los abonos manuales ya bloquearon la anulación arriba.
          await conn.query('DELETE FROM supplier_payments WHERE purchase_id = ?', [purchaseId]);
        }

        await conn.query(
          `UPDATE purchases SET estado = 'anulada', motivo_anulacion = ?, anulada_at = CURRENT_TIMESTAMP,
             anulada_by_user_id = ?, anulada_by_user_name = ? WHERE id = ?`,
          [motivo, actor.id, actorName(actor), purchaseId]
        );
      });

      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Compras', actionName: 'Compra anulada',
        detail: `Compra #${purchaseId}${motivo ? ' · ' + motivo : ''}`,
      });

      res.json({ ok: true, message: `Compra #${purchaseId} anulada.` });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createComprasRouter, ensureSchema };
