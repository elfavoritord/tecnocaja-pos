'use strict';

/**
 * clientes-creditos.routes.js — Cobro de crédito a clientes.
 * Factory pattern con inyección de dependencias, igual que compras.routes.js/tesoreria.routes.js.
 *
 * Extraído de server.js junto con un fix: el cobro de crédito ahora queda
 * registrado en `client_credit_payments` (fecha y método propios del cobro,
 * no de la venta original) para que caja/reportes/factura dejen de perder el
 * dinero cobrado. Ver plan en .claude/plans (fix cobro de crédito, 2026-08-01).
 *
 * Rutas:
 *  GET  /api/clients/:id/credit-sales
 *  POST /api/clients/:id/credit-payments
 */

const express = require('express');
const reportsSync = require('../../modules/firebase-reports-sync');

async function ensureSchema(query) {
  await query(`
    CREATE TABLE IF NOT EXISTS client_credit_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INT NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      payment_method VARCHAR(20) NOT NULL DEFAULT 'efectivo',
      notes VARCHAR(255) DEFAULT NULL,
      cash_session_id INT DEFAULT NULL,
      branch_id INT DEFAULT NULL,
      cash_register_id INT DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_ccp_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS client_credit_payment_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INT NOT NULL,
      sale_id INT NOT NULL,
      applied_amount DECIMAL(12,2) NOT NULL,
      CONSTRAINT fk_ccpa_payment FOREIGN KEY (payment_id) REFERENCES client_credit_payments(id) ON DELETE CASCADE
    )
  `);

  await query('CREATE INDEX idx_ccp_client ON client_credit_payments (client_id)').catch(() => {});
  await query('CREATE INDEX idx_ccp_created_at ON client_credit_payments (created_at)').catch(() => {});
  await query('CREATE INDEX idx_ccpa_payment ON client_credit_payment_allocations (payment_id)').catch(() => {});
  await query('CREATE INDEX idx_ccpa_sale ON client_credit_payment_allocations (sale_id)').catch(() => {});
}

function createClientesCreditosRouter({
  query, withTransaction, getActor, resolveScopedBusinessStructureSelection,
  normalizeCurrencyAmount, mapClientRow, getClientRowWithComputedBalance,
  writeAuditLog, getConfig, ensureClientExtensions, ensureSalesExtensions,
  ensureCashMovementExtensions, fireReportSync, getReportSyncConfig, getReportSyncBranchesMap,
  resolveRequestActorUser,
}) {
  const router = express.Router();

  // Estas dos rutas manejan dinero (cobros de crédito) y no tenían NINGÚN
  // chequeo de sesión: llamaban getActor(req) directo, que si no hay
  // req.authUser cae a confiar en actorUserId/actorUserName del body TAL
  // CUAL, sin verificar nada. Cualquiera sin sesión podía registrar un cobro
  // falso y hacerlo pasar por cualquier usuario en la auditoría.
  router.use(async (req, res, next) => {
    try {
      req.authUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
      next();
    } catch (e) {
      res.status(e.statusCode || 401).json({ error: e.message || 'Sesión inválida o expirada.' });
    }
  });

  // Reimpresión del recibo de un cobro ya registrado — usado desde Reportes
  // > Detallados > Facturas, donde el cobro aparece como su propia fila.
  router.get('/credit-payments/:paymentId/receipt', async (req, res) => {
    const paymentId = Number(req.params.paymentId || 0);
    if (!paymentId) {
      return res.status(400).json({ error: 'Cobro no válido.' });
    }

    const payments = await query(
      `SELECT ccp.*, cl.nombre AS client_name, cl.cedula AS client_cedula
       FROM client_credit_payments ccp
       LEFT JOIN clients cl ON cl.id = ccp.client_id
       WHERE ccp.id = ?
       LIMIT 1`,
      [paymentId]
    );
    const payment = payments[0];
    if (!payment) {
      return res.status(404).json({ error: 'Cobro no encontrado.' });
    }

    const allocations = await query(
      `SELECT ccpa.applied_amount, s.invoice_number
       FROM client_credit_payment_allocations ccpa
       LEFT JOIN sales s ON s.id = ccpa.sale_id
       WHERE ccpa.payment_id = ?`,
      [paymentId]
    );

    const amount = normalizeCurrencyAmount(payment.amount || 0);
    res.json({
      sale: {
        id: allocations.map((a) => a.invoice_number).filter(Boolean).join(', ') || `Cobro #${paymentId}`,
        tipoComprobante: 'ticket',
        fecha: payment.created_at,
        cliente: payment.client_name || '',
        clienteRncCedula: payment.client_cedula || '',
        cajero: payment.created_by_user_name || 'Sistema',
        metodo: payment.payment_method,
        recibido: amount,
        cambio: 0,
        total: amount,
        subtotal: amount,
        itbis: 0,
        descuento: 0,
        estadoFiscal: 'pagada',
        tipoPedido: 'mostrador',
        items: allocations.map((a) => ({
          nombre: `Abono: ${a.invoice_number || ''}`,
          qty: 1,
          precio: normalizeCurrencyAmount(a.applied_amount || 0),
          subtotal: normalizeCurrencyAmount(a.applied_amount || 0),
          total: normalizeCurrencyAmount(a.applied_amount || 0),
          itbisRate: 0,
          itbisMonto: 0,
        }))
      }
    });
  });

  router.get('/:id/credit-sales', async (req, res) => {
    await ensureClientExtensions();
    await ensureSalesExtensions();

    const clientId = Number(req.params.id || 0);
    if (!clientId) {
      return res.status(400).json({ error: 'Cliente no válido.' });
    }

    const clientRow = await getClientRowWithComputedBalance(clientId);
    if (!clientRow) {
      return res.status(404).json({ error: 'Cliente no encontrado.' });
    }

    const sales = await query(
      `SELECT id, invoice_number, document_type, created_at, total, received_amount
       FROM sales
       WHERE client_id = ?
         AND payment_method = 'credito'
         AND COALESCE(fiscal_status, 'emitida') <> 'cancelada'
         AND COALESCE(total, 0) > COALESCE(received_amount, 0)
       ORDER BY created_at ASC, id ASC`,
      [clientId]
    );

    const mappedSales = sales.map((sale) => {
      const total = normalizeCurrencyAmount(sale.total || 0);
      const receivedAmount = normalizeCurrencyAmount(sale.received_amount || 0);
      const pendingAmount = normalizeCurrencyAmount(Math.max(0, total - receivedAmount));
      return {
        id: Number(sale.id || 0),
        invoiceNumber: sale.invoice_number,
        documentType: sale.document_type || 'ticket',
        fecha: sale.created_at,
        total,
        recibido: receivedAmount,
        pendiente: pendingAmount
      };
    });

    res.json({
      client: mapClientRow(clientRow),
      sales: mappedSales,
      totalPending: normalizeCurrencyAmount(mappedSales.reduce((sum, sale) => sum + Number(sale.pendiente || 0), 0))
    });
  });

  router.post('/:id/credit-payments', async (req, res) => {
    await ensureClientExtensions();
    await ensureSalesExtensions();
    await ensureCashMovementExtensions();

    const clientId = Number(req.params.id || 0);
    const amount = normalizeCurrencyAmount(req.body?.monto || 0);
    const paymentMethod = ['efectivo', 'tarjeta', 'transferencia'].includes(String(req.body?.metodo || '').trim())
      ? String(req.body.metodo).trim()
      : 'efectivo';
    const notes = String(req.body?.obs || '').trim() || 'Cobro de crédito a cliente';
    const actor = getActor(req);

    if (!clientId) {
      return res.status(400).json({ error: 'Cliente no válido.' });
    }
    if (amount <= 0) {
      return res.status(400).json({ error: 'El monto del cobro debe ser mayor que cero.' });
    }

    let structure;
    try {
      structure = await resolveScopedBusinessStructureSelection(req, null, req.body?.branchId, req.body?.cashRegisterId);
    } catch (structureError) {
      return res.status(structureError.statusCode || 400).json({ error: structureError.message });
    }

    const result = await withTransaction(async (conn) => {
      const clientRow = await getClientRowWithComputedBalance(clientId, conn);
      if (!clientRow) {
        const error = new Error('Cliente no encontrado.');
        error.statusCode = 404;
        throw error;
      }

      const pendingSales = await conn.query(
        `SELECT id, invoice_number, total, received_amount, created_at, client_id, branch_id
         FROM sales
         WHERE client_id = ?
           AND payment_method = 'credito'
           AND COALESCE(fiscal_status, 'emitida') <> 'cancelada'
           AND COALESCE(total, 0) > COALESCE(received_amount, 0)
         ORDER BY created_at ASC, id ASC`,
        [clientId]
      );

      if (!pendingSales.length) {
        const error = new Error('Este cliente no tiene facturas a crédito pendientes.');
        error.statusCode = 409;
        throw error;
      }

      const totalPending = normalizeCurrencyAmount(
        pendingSales.reduce((sum, sale) => sum + Math.max(0, Number(sale.total || 0) - Number(sale.received_amount || 0)), 0)
      );
      if (amount > totalPending) {
        const error = new Error('El monto supera el balance pendiente del cliente.');
        error.statusCode = 409;
        throw error;
      }

      let sessionId = null;
      if (paymentMethod === 'efectivo') {
        const sessions = await conn.query(
          'SELECT * FROM cash_sessions WHERE status = "open" AND cash_register_id = ? ORDER BY id DESC LIMIT 1',
          [structure.cashRegisterId]
        );
        const session = sessions[0];
        if (!session) {
          const error = new Error('Debes tener una caja abierta para registrar cobros en efectivo.');
          error.statusCode = 409;
          throw error;
        }
        sessionId = Number(session.id || 0);
      }

      let remaining = amount;
      const appliedSales = [];
      const allocations = [];
      const updatedSales = [];

      for (const sale of pendingSales) {
        if (remaining <= 0) break;
        const total = normalizeCurrencyAmount(sale.total || 0);
        const receivedAmount = normalizeCurrencyAmount(sale.received_amount || 0);
        const pendingAmount = normalizeCurrencyAmount(Math.max(0, total - receivedAmount));
        const appliedAmount = normalizeCurrencyAmount(Math.min(remaining, pendingAmount));
        if (appliedAmount <= 0) continue;

        const newReceivedAmount = normalizeCurrencyAmount(receivedAmount + appliedAmount);
        await conn.query(
          'UPDATE sales SET received_amount = ?, change_amount = 0 WHERE id = ?',
          [newReceivedAmount, sale.id]
        );

        appliedSales.push({
          invoiceNumber: sale.invoice_number,
          appliedAmount,
          pendienteAnterior: pendingAmount,
          pendienteActual: normalizeCurrencyAmount(Math.max(0, pendingAmount - appliedAmount))
        });
        allocations.push({ saleId: Number(sale.id), appliedAmount });
        updatedSales.push({
          id: Number(sale.id),
          invoiceNumber: sale.invoice_number,
          total,
          receivedAmount: newReceivedAmount,
          branchId: sale.branch_id === null || sale.branch_id === undefined ? null : Number(sale.branch_id),
          createdAt: sale.created_at
        });
        remaining = normalizeCurrencyAmount(Math.max(0, remaining - appliedAmount));
      }

      const updatedPendingTotal = normalizeCurrencyAmount(Math.max(0, totalPending - amount));
      await conn.query('UPDATE clients SET balance = ? WHERE id = ?', [updatedPendingTotal, clientId]);

      if (paymentMethod === 'efectivo') {
        await conn.query(
          `INSERT INTO cash_movements
            (session_id, movement_type, amount, notes, created_by_user_id, created_by_user_name, happened_at, branch_id, cash_register_id)
           VALUES (?, "Cobro crédito cliente", ?, ?, ?, ?, datetime('now'), ?, ?)`,
          [sessionId, amount, notes, actor.userId || null, actor.userName || 'Sistema', structure.branchId, structure.cashRegisterId]
        );
        await conn.query('UPDATE cash_sessions SET current_amount = current_amount + ? WHERE id = ?', [amount, sessionId]);
        await conn.query('UPDATE config SET cash_amount = cash_amount + ? WHERE id = 1', [amount]);
      }

      const paymentInsert = await conn.query(
        `INSERT INTO client_credit_payments
          (client_id, amount, payment_method, notes, cash_session_id, branch_id, cash_register_id, created_by_user_id, created_by_user_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [clientId, amount, paymentMethod, notes, sessionId, structure.branchId, structure.cashRegisterId, actor.userId || null, actor.userName || 'Sistema']
      );
      const paymentId = paymentInsert.insertId;

      for (const allocation of allocations) {
        await conn.query(
          'INSERT INTO client_credit_payment_allocations (payment_id, sale_id, applied_amount) VALUES (?, ?, ?)',
          [paymentId, allocation.saleId, allocation.appliedAmount]
        );
      }

      return {
        client: mapClientRow(await getClientRowWithComputedBalance(clientId, conn)),
        appliedSales,
        updatedSales,
        totalPaid: amount,
        totalPending: updatedPendingTotal,
        paymentId,
        sessionId
      };
    });

    await writeAuditLog({
      ...actor,
      moduleName: 'Clientes',
      actionName: 'Cobro de crédito registrado',
      detail: `${result.client.nombre} · ${paymentMethod} · abono ${amount.toFixed(2)} · ${structure.branch.nombre} · ${structure.cashRegister.nombre}`
    });

    // ── Sync reporte-sistema-pos: refrescar cuentas por cobrar + movimiento de caja ──
    fireReportSync(async () => {
      const cfg = await getReportSyncConfig();
      const branches = await getReportSyncBranchesMap();
      for (const sale of result.updatedSales) {
        await reportsSync.syncReceivable({
          id: sale.id,
          customerId: clientId,
          customerName: result.client.nombre,
          branchId: sale.branchId,
          branchName: sale.branchId ? branches.get(Number(sale.branchId)) : null,
          total: sale.total,
          paid: sale.receivedAmount,
          createdAt: sale.createdAt,
        }, { config: cfg });
      }
      if (paymentMethod === 'efectivo') {
        await reportsSync.syncCashMovement({
          id: `credpay-${result.paymentId}`,
          movement_type: 'entrada',
          amount,
          notes,
          branch_id: structure.branchId,
          cash_register_id: structure.cashRegisterId,
          created_by_user_name: actor.userName || 'Sistema',
          happened_at: new Date(),
        }, { config: cfg, branches });
      }
    });

    res.json({
      client: result.client,
      appliedSales: result.appliedSales,
      totalPaid: result.totalPaid,
      totalPending: result.totalPending,
      config: await getConfig(),
      movement: paymentMethod === 'efectivo' ? {
        tipo: 'Cobro crédito cliente',
        monto: amount,
        hora: new Date().toISOString(),
        obs: notes,
        usuarioId: actor.userId || null,
        usuarioNombre: actor.userName || 'Sistema'
      } : null,
      payment: {
        id: result.paymentId,
        tipo: 'Cobro crédito cliente',
        metodo: paymentMethod,
        monto: amount,
        hora: new Date().toISOString(),
        obs: notes,
        usuarioId: actor.userId || null,
        usuarioNombre: actor.userName || 'Sistema'
      }
    });
  });

  return router;
}

module.exports = { createClientesCreditosRouter, ensureSchema };
