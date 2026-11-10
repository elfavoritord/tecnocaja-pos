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
const money = require('../../js/pos-money');
const { createHash } = require('crypto');

async function ensureSchema(query) {
  await query(`CREATE TABLE IF NOT EXISTS client_credit_payment_requests (
    request_id VARCHAR(100) PRIMARY KEY, client_id INT NOT NULL, payload_hash VARCHAR(64) NOT NULL,
    response_json TEXT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
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
  resolveRequestActorUser, ensureReturnTables, getClientRowsWithComputedBalance, nowSql,
  canViewReceivables, getUserScopeBranchId,
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

  // Reporte general de clientes: solo saldos abiertos reales (después de
  // abonos, notas de crédito y cancelaciones), nunca el histórico de compras.
  router.get('/receivables-report', async (req, res) => {
    const actorUser = await resolveRequestActorUser(req, { required: true });
    if (typeof canViewReceivables === 'function' && !canViewReceivables(actorUser)) return res.status(403).json({ error: 'No tienes permiso para ver las cuentas por cobrar.' });
    const scope = typeof getUserScopeBranchId === 'function' ? getUserScopeBranchId(actorUser) : null;
    const branchId = Number(scope || req.query.branchId || 0) || null;
    const clients = await getClientRowsWithComputedBalance();
    const rows = await query(`SELECT s.client_id, s.created_at, s.credit_due_date, s.total, s.received_amount, s.credit_adjustment, COALESCE(s.billed_branch_id, s.branch_id) AS branch_id
      FROM sales s WHERE (s.payment_method = 'credito' OR s.credit_amount > 0) AND COALESCE(s.fiscal_status,'emitida') <> 'cancelada'
        AND COALESCE(s.total, 0) > COALESCE(s.received_amount, 0) + COALESCE(s.credit_adjustment, 0)`);
    const movements = await query(`SELECT client_id, MAX(happened_at) AS latest FROM (
      SELECT client_id, created_at AS happened_at FROM sales WHERE client_id IS NOT NULL
      UNION ALL SELECT client_id, created_at AS happened_at FROM client_credit_payments
    ) history GROUP BY client_id`);
    const dateString = d => d instanceof Date ? d.toISOString().slice(0,19).replace('T',' ') : String(d || '');
    const today = require('../services/client-statement').hoyRD();
    const cfg = await getConfig({ syncRemote: false }).catch(() => ({}));
    const result = clients.map(c => {
      const sales = rows.filter(s => Number(s.client_id) === Number(c.id) && (!branchId || Number(s.branch_id) === branchId));
      let pendiente = 0n, vencido = 0n, vencidas = 0;
      for (const s of sales) {
        const p = money.cents(s.total || 0) - money.cents(s.received_amount || 0) - money.cents(s.credit_adjustment || 0);
        if (p <= 0n) continue;
        pendiente += p;
        if (s.credit_due_date && dateString(s.credit_due_date).slice(0,10) < today) { vencido += p; vencidas += 1; }
      }
      const mapped = mapClientRow(c);
      const saldo = branchId ? money.number(pendiente) : Number(mapped.balance || 0);
      const limite = Number(mapped.limiteCredito || 0);
      return { ...mapped, balance: saldo, vencido: money.number(vencido), facturasPendientes: sales.length, facturasVencidas: vencidas,
        limiteUtilizado: saldo, limiteDisponible: limite > 0 ? Math.max(0, money.number(money.cents(limite) - money.cents(saldo))) : null, sinLimite: !(limite > 0),
        estado: saldo <= 0 ? 'sin_deuda' : (limite > 0 && saldo > limite ? 'sobre_limite' : (vencidas ? 'vencido' : 'al_dia')),
        ultimoMovimiento: dateString(movements.find(m => Number(m.client_id) === Number(c.id))?.latest) || null };
    });
    const total = result.reduce((n, c) => n + money.cents(c.balance || 0), 0n);
    res.json({ clientes: result, totalClientes: result.length, totalPorCobrar: money.number(total), fechaCorte: today, branchId,
      negocio: { nombre: cfg.nombre || cfg.businessName || '', rnc: cfg.rnc || '' } });
  });

  // Detalle de una factura del estado de cuenta: conceptos, pagos aplicados,
  // notas de crédito, saldo y días de atraso.
  router.get('/:id/statement/invoice/:saleId', async (req, res) => {
    await resolveRequestActorUser(req, { required: true });
    await ensureReturnTables();
    const clientId = Number(req.params.id), saleId = Number(req.params.saleId);
    const [sale] = await query('SELECT * FROM sales WHERE id = ? AND client_id = ? LIMIT 1', [saleId, clientId]);
    if (!sale) return res.status(404).json({ error: 'Factura no encontrada para este cliente.' });
    const items = await query(`SELECT si.qty, si.price, si.discount_rate, si.tax_rate, si.tax_amount, si.general_discount_amount, si.legal_tip_amount, si.line_total,
        COALESCE(si.item_name, p.nombre, 'Producto') AS nombre FROM sale_items si LEFT JOIN products p ON p.id = si.product_id WHERE si.sale_id = ? ORDER BY si.id`, [saleId]);
    const pagos = await query(`SELECT a.applied_amount, p.payment_method, p.created_at, p.id FROM client_credit_payment_allocations a
        JOIN client_credit_payments p ON p.id = a.payment_id WHERE a.sale_id = ? ORDER BY p.created_at, p.id`, [saleId]);
    const notas = await query('SELECT id, returned_at, returned_amount, credit_reduction, fiscal_document, return_reason, adjustment_kind FROM sale_returns WHERE original_sale_id = ? ORDER BY id', [saleId]);
    const pendiente = Math.max(0, money.number(money.cents(sale.total || 0) - money.cents(sale.received_amount || 0) - money.cents(sale.credit_adjustment || 0)));
    const today = require('../services/client-statement').hoyRD();
    const vence = sale.credit_due_date ? dateOnly(sale.credit_due_date) : null;
    const atraso = vence && pendiente > 0 && vence < today ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${vence}T00:00:00Z`)) / 86400000) : 0;
    res.json({
      factura: sale.invoice_number, documento: sale.ncf || sale.invoice_number, fecha: dateOnly(sale.created_at, true), vence,
      subtotal: Number(sale.subtotal || 0), descuento: Number(sale.discount || 0), itbis: Number(sale.tax || 0), propinaLegal: Number(sale.legal_tip_amount || 0),
      total: Number(sale.total || 0), cobradoAlVender: Number(sale.financial_version) > 0 ? money.number(money.cents(sale.total || 0) - money.cents(sale.credit_amount || 0)) : null,
      estado: sale.fiscal_status === 'cancelada' ? 'cancelada' : (pendiente <= 0 ? 'pagada' : (atraso ? 'vencida' : 'abierta')), pendiente, diasAtraso: atraso,
      conceptos: items.map((i) => ({ nombre: i.nombre, cantidad: Number(i.qty || 0), precio: Number(i.price || 0), descuentoPct: Number(i.discount_rate || 0),
        itbisPct: Number(i.tax_rate || 0), itbis: Number(i.tax_amount || 0), total: Number(i.line_total || 0) })),
      pagos: pagos.map((p) => ({ id: Number(p.id), fecha: dateOnly(p.created_at, true), metodo: p.payment_method, monto: Number(p.applied_amount || 0) })),
      notas: notas.map((r) => ({ id: Number(r.id), fecha: dateOnly(r.returned_at, true), documento: r.fiscal_document || '', motivo: r.return_reason || '', monto: Number(r.returned_amount || 0), rebajaCredito: Number(r.credit_reduction || 0) })),
    });
  });
  function dateOnly(d, conHora = false) {
    const s = d instanceof Date ? d.toISOString().slice(0, 19).replace('T', ' ') : String(d || '');
    return conHora ? s : s.slice(0, 10);
  }

  router.get('/:id/statement', async (req, res) => {
    await ensureReturnTables();
    await resolveRequestActorUser(req, { required: true });
    const clientId = Number(req.params.id);
    const from = String(req.query.from || ''), to = String(req.query.to || '');
    if ([from,to].some(d => d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) || (from && to && from > to)) return res.status(400).json({ error: 'Período no válido.' });
    const result = await withTransaction(async conn => {
      const client = await getClientRowWithComputedBalance(clientId, conn);
      if (!client) throw Object.assign(new Error('Cliente no encontrado.'), { statusCode: 404 });
      const sales = await conn.query(`SELECT * FROM sales WHERE client_id = ? AND (payment_method = 'credito' OR credit_amount > 0) ORDER BY created_at, id`, [clientId]);
      const payments = await conn.query(`SELECT a.sale_id, a.payment_id, a.applied_amount, p.payment_method, p.created_at, s.invoice_number, s.ncf
        FROM client_credit_payment_allocations a JOIN client_credit_payments p ON p.id = a.payment_id JOIN sales s ON s.id = a.sale_id WHERE p.client_id = ?`, [clientId]);
      const returns = await conn.query('SELECT r.* FROM sale_returns r JOIN sales s ON s.id = r.original_sale_id WHERE s.client_id = ?', [clientId]);
      return require('../services/client-statement').build({ client: mapClientRow(client), sales, payments, returns, from, to });
    });
    res.json(result);
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
      `SELECT id, invoice_number, document_type, created_at, total, received_amount, credit_adjustment, credit_due_date
       FROM sales
       WHERE client_id = ?
         AND (payment_method = 'credito' OR credit_amount > 0)
         AND COALESCE(fiscal_status, 'emitida') <> 'cancelada'
         AND COALESCE(total, 0) > COALESCE(received_amount, 0) + COALESCE(credit_adjustment, 0)
       ORDER BY created_at ASC, id ASC`,
      [clientId]
    );

    const mappedSales = sales.map((sale) => {
      const total = normalizeCurrencyAmount(sale.total || 0);
      const receivedAmount = normalizeCurrencyAmount(sale.received_amount || 0);
      const pendingAmount = normalizeCurrencyAmount(Math.max(0, total - receivedAmount - Number(sale.credit_adjustment || 0)));
      return {
        id: Number(sale.id || 0),
        invoiceNumber: sale.invoice_number,
        documentType: sale.document_type || 'ticket',
        fecha: sale.created_at,
        total,
        recibido: receivedAmount,
        ajusteCredito: Number(sale.credit_adjustment || 0), vencimiento: sale.credit_due_date || null,
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
    const requestId = String(req.body?.clientRequestId || '').trim();
    if (requestId && !/^[\w-]{16,100}$/.test(requestId)) return res.status(400).json({ error: 'Identificador de cobro no válido.' });
    const payloadHash = createHash('sha256').update(JSON.stringify([clientId, amount, paymentMethod, notes, req.body?.branchId || null, req.body?.cashRegisterId || null])).digest('hex');
    const actor = getActor(req);
    const happenedAt = nowSql();

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
      await conn.query(`SELECT id FROM clients WHERE id = ?${require('../../db').getDbClient() === 'mysql' ? ' FOR UPDATE' : ''}`, [clientId]);
      if (requestId) {
        const old = (await conn.query('SELECT * FROM client_credit_payment_requests WHERE request_id = ?', [requestId]))[0];
        if (old) {
          if (old.payload_hash !== payloadHash || Number(old.client_id) !== clientId) throw Object.assign(new Error('El identificador ya corresponde a otro cobro.'), { statusCode: 409 });
          return { ...JSON.parse(old.response_json), replayed: true };
        }
      }
      const clientRow = await getClientRowWithComputedBalance(clientId, conn);
      if (!clientRow) {
        const error = new Error('Cliente no encontrado.');
        error.statusCode = 404;
        throw error;
      }

      const pendingSales = await conn.query(
        `SELECT id, invoice_number, total, received_amount, credit_adjustment, created_at, client_id, branch_id
         FROM sales
         WHERE client_id = ?
           AND (payment_method = 'credito' OR credit_amount > 0)
           AND COALESCE(fiscal_status, 'emitida') <> 'cancelada'
           AND COALESCE(total, 0) > COALESCE(received_amount, 0) + COALESCE(credit_adjustment, 0)
         ORDER BY created_at ASC, id ASC`,
        [clientId]
      );

      if (!pendingSales.length) {
        const error = new Error('Este cliente no tiene facturas a crédito pendientes.');
        error.statusCode = 409;
        throw error;
      }

      const totalPending = money.number(pendingSales.reduce((sum, sale) => sum + money.cents(sale.total || 0) - money.cents(sale.received_amount || 0) - money.cents(sale.credit_adjustment || 0), 0n));
      if (amount > totalPending) {
        const error = new Error('El monto supera el balance pendiente del cliente.');
        error.statusCode = 409;
        throw error;
      }

      // El abono queda en el turno abierto de la caja, sea cual sea el método,
      // para que el cierre lo muestre en su bloque (efectivo, tarjeta o
      // transferencia). Solo el efectivo exige caja abierta.
      const sessions = await conn.query(
        'SELECT * FROM cash_sessions WHERE status = "open" AND cash_register_id = ? ORDER BY id DESC LIMIT 1',
        [structure.cashRegisterId]
      );
      const session = sessions[0];
      if (paymentMethod === 'efectivo' && !session) {
        const error = new Error('Debes tener una caja abierta para registrar cobros en efectivo.');
        error.statusCode = 409;
        throw error;
      }
      const sessionId = session ? Number(session.id || 0) : null;

      let remaining = amount;
      const appliedSales = [];
      const allocations = [];
      const updatedSales = [];

      for (const sale of pendingSales) {
        if (remaining <= 0) break;
        const total = normalizeCurrencyAmount(sale.total || 0);
        const receivedAmount = normalizeCurrencyAmount(sale.received_amount || 0);
        const pendingAmount = normalizeCurrencyAmount(Math.max(0, total - receivedAmount - Number(sale.credit_adjustment || 0)));
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
           VALUES (?, "Cobro crédito cliente", ?, ?, ?, ?, ?, ?, ?)`,
          [sessionId, amount, notes, actor.userId || null, actor.userName || 'Sistema', happenedAt, structure.branchId, structure.cashRegisterId]
        );
        await conn.query('UPDATE cash_sessions SET current_amount = current_amount + ? WHERE id = ?', [amount, sessionId]);
        await conn.query('UPDATE config SET cash_amount = cash_amount + ? WHERE id = 1', [amount]);
      }

      const paymentInsert = await conn.query(
        `INSERT INTO client_credit_payments
          (client_id, amount, payment_method, notes, cash_session_id, branch_id, cash_register_id, created_by_user_id, created_by_user_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [clientId, amount, paymentMethod, notes, sessionId, structure.branchId, structure.cashRegisterId, actor.userId || null, actor.userName || 'Sistema', happenedAt]
      );
      const paymentId = paymentInsert.insertId;

      for (const allocation of allocations) {
        await conn.query(
          'INSERT INTO client_credit_payment_allocations (payment_id, sale_id, applied_amount) VALUES (?, ?, ?)',
          [paymentId, allocation.saleId, allocation.appliedAmount]
        );
      }

      const response = {
        client: mapClientRow(await getClientRowWithComputedBalance(clientId, conn)),
        appliedSales,
        updatedSales,
        totalPaid: amount,
        totalPending: updatedPendingTotal,
        paymentId,
        sessionId
      };
      await writeAuditLog({ ...actor, moduleName: 'Clientes', actionName: 'Cobro de crédito registrado',
        branchId: structure.branchId, cashRegisterId: structure.cashRegisterId, cashSessionId: sessionId, clientId,
        documentRef: String(paymentId), amount, paymentMethod,
        before: { balance: totalPending }, after: { balance: updatedPendingTotal, paymentId, allocations },
        detail: `${clientRow.nombre} · ${paymentMethod} · abono ${amount.toFixed(2)}` }, conn);
      if (requestId) await conn.query('INSERT INTO client_credit_payment_requests (request_id, client_id, payload_hash, response_json) VALUES (?, ?, ?, ?)', [requestId, clientId, payloadHash, JSON.stringify(response)]);
      return response;
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
