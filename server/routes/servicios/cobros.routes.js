'use strict';

/**
 * cobros.routes.js — Pagos y Cuentas por Cobrar del modo Empresas de Servicios.
 *
 *  GET    /api/servicios/cobros/metodos
 *  GET    /api/servicios/cobros?clientId=&branchId=&desde=&hasta=&metodo=
 *  POST   /api/servicios/cobros                 { invoiceId, monto, metodo, fecha?, referencia?, notas?, esAnticipo? }
 *  POST   /api/servicios/cobros/:id/anular      { motivo }
 *  GET    /api/servicios/cobros/cxc?clientId=&branchId=&estado=&vencidas=1
 */

const express = require('express');
const {
  httpError, roleCodeOf, actorName, makeServiceGuard, resolveBranch,
} = require('./_common');

const METODOS = ['efectivo', 'transferencia', 'tarjeta', 'deposito', 'cheque', 'otro'];

function mapPayment(row) {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    factura: row.invoice_numero || '',
    clientName: row.client_name || '',
    fecha: row.fecha,
    monto: Number(row.monto || 0),
    metodo: row.metodo,
    referencia: row.referencia || '',
    notas: row.notas || '',
    esAnticipo: Boolean(row.is_anticipo),
    branchId: row.branch_id || null,
    creadoPor: row.created_by_user_name || '',
    anuladoAt: row.anulado_at || null,
    createdAt: row.created_at,
  };
}

function createCobrosRouter(deps) {
  const {
    query, withTransaction, writeAuditLog, ensureSchema, recalcInvoice,
    isGlobalAdministratorUser, getUserScopeBranchId,
  } = deps;
  const guard = makeServiceGuard(deps);
  const router = express.Router();

  router.use(guard.requireService());
  router.use(async (_req, _res, next) => {
    try { await ensureSchema(query); next(); } catch (e) { next(e); }
  });

  router.get('/metodos', (_req, res) => res.json(METODOS));

  // ── Listar pagos ─────────────────────────────────────────────────────────
  router.get('/', async (req, res) => {
    try {
      const branchScope = resolveBranch(req.authUser, req.query.branchId, deps);
      const cond = [];
      const params = [];
      if (branchScope) { cond.push('p.branch_id = ?'); params.push(branchScope); }
      if (req.query.clientId) { cond.push('i.client_id = ?'); params.push(Number(req.query.clientId)); }
      if (req.query.metodo) { cond.push('p.metodo = ?'); params.push(String(req.query.metodo)); }
      if (req.query.desde) { cond.push('p.fecha >= ?'); params.push(String(req.query.desde)); }
      if (req.query.hasta) { cond.push('p.fecha <= ?'); params.push(String(req.query.hasta)); }
      const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const rows = await query(
        `SELECT p.*, i.numero AS invoice_numero, i.client_name
         FROM svc_invoice_payments p JOIN svc_invoices i ON i.id = p.invoice_id
         ${where} ORDER BY p.fecha DESC, p.id DESC LIMIT 500`, params
      );
      res.json(rows.map(mapPayment));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Registrar pago ───────────────────────────────────────────────────────
  router.post('/', guard.requirePerm('servicios.cobrar'), async (req, res) => {
    const actor = req.authUser;
    const body = req.body || {};
    try {
      const invoiceId = Number(body.invoiceId);
      if (!invoiceId) throw httpError('Indica la factura a cobrar.');
      const monto = Number(body.monto || 0);
      if (!(monto > 0)) throw httpError('El monto debe ser mayor a 0.');
      const metodo = METODOS.includes(String(body.metodo)) ? String(body.metodo) : 'efectivo';
      const fecha = String(body.fecha || '').trim() || new Date().toISOString().slice(0, 10);
      const esAnticipo = Boolean(body.esAnticipo);

      const [inv] = await query('SELECT * FROM svc_invoices WHERE id = ?', [invoiceId]);
      if (!inv) throw httpError('Factura no encontrada.', 404);
      if (inv.estado === 'anulada') throw httpError('No se puede cobrar una factura anulada.', 409);
      const balance = Number(inv.balance || 0);
      if (!esAnticipo && monto - balance > 0.009) {
        throw httpError(`El monto (RD$ ${monto.toFixed(2)}) excede el balance pendiente (RD$ ${balance.toFixed(2)}). Marca "anticipo" si es a cuenta.`, 409);
      }

      await withTransaction(async (conn) => {
        await conn.query(
          `INSERT INTO svc_invoice_payments
            (invoice_id, fecha, monto, metodo, referencia, notas, is_anticipo, branch_id, cash_register_id, created_by_user_id, created_by_user_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [invoiceId, fecha, monto, metodo, String(body.referencia || '').trim() || null, String(body.notas || '').trim() || null,
           esAnticipo ? 1 : 0, inv.branch_id, body.cashRegisterId ? Number(body.cashRegisterId) : inv.cash_register_id,
           actor.id, actorName(actor)]
        );
      });
      await recalcInvoice(query, invoiceId);

      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Cobros', actionName: 'Pago registrado',
        detail: `${inv.numero} · ${metodo} · RD$ ${monto.toFixed(2)}${esAnticipo ? ' (anticipo)' : ''}`,
        branchId: inv.branch_id, clientId: inv.client_id, documentType: 'pago', documentRef: inv.numero,
        amount: monto, paymentMethod: metodo,
      });
      const [full] = await query(
        `SELECT p.*, i.numero AS invoice_numero, i.client_name
         FROM svc_invoice_payments p JOIN svc_invoices i ON i.id = p.invoice_id
         WHERE p.invoice_id = ? ORDER BY p.id DESC LIMIT 1`, [invoiceId]
      );
      const [invNow] = await query('SELECT pagado, balance, estado FROM svc_invoices WHERE id = ?', [invoiceId]);
      res.status(201).json({ pago: mapPayment(full), factura: { id: invoiceId, ...invNow } });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Anular pago ──────────────────────────────────────────────────────────
  router.post('/:id/anular', guard.requirePerm('servicios.anular', 'servicios.cobrar'), async (req, res) => {
    const actor = req.authUser;
    const id = Number(req.params.id);
    const motivo = String(req.body?.motivo || '').trim() || null;
    try {
      const [pago] = await query('SELECT * FROM svc_invoice_payments WHERE id = ?', [id]);
      if (!pago) throw httpError('Pago no encontrado.', 404);
      if (pago.anulado_at) throw httpError('El pago ya está anulado.', 409);
      const r = await query(
        `UPDATE svc_invoice_payments SET anulado_at = datetime('now'), anulado_by_user_name = ?, notas = ?
         WHERE id = ? AND anulado_at IS NULL`,
        [actorName(actor), motivo ? `ANULADO: ${motivo}` : 'ANULADO', id]
      );
      if (!r.affectedRows) throw httpError('El pago ya está anulado.', 409);
      await recalcInvoice(query, pago.invoice_id);
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Cobros', actionName: 'Pago anulado',
        detail: `Pago #${id} · RD$ ${Number(pago.monto || 0).toFixed(2)}${motivo ? ' · ' + motivo : ''}`,
        documentType: 'pago', amount: Number(pago.monto || 0), paymentMethod: pago.metodo,
      });
      const [invNow] = await query('SELECT pagado, balance, estado FROM svc_invoices WHERE id = ?', [pago.invoice_id]);
      res.json({ ok: true, factura: { id: pago.invoice_id, ...invNow } });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Cuentas por cobrar ───────────────────────────────────────────────────
  router.get('/cxc', async (req, res) => {
    try {
      const branchScope = resolveBranch(req.authUser, req.query.branchId, deps);
      const cond = ["i.estado IN ('pendiente','parcial')", 'i.balance > 0.009'];
      const params = [];
      if (branchScope) { cond.push('i.branch_id = ?'); params.push(branchScope); }
      if (req.query.clientId) { cond.push('i.client_id = ?'); params.push(Number(req.query.clientId)); }
      if (req.query.vencidas === '1') { cond.push("i.vencimiento IS NOT NULL AND i.vencimiento < date('now')"); }
      const rows = await query(
        `SELECT i.id, i.numero, i.ncf, i.client_id, i.client_name, i.fecha, i.vencimiento,
                i.total, i.pagado, i.balance, i.estado, b.nombre AS branch_name
         FROM svc_invoices i LEFT JOIN branches b ON b.id = i.branch_id
         WHERE ${cond.join(' AND ')}
         ORDER BY (i.vencimiento IS NULL), i.vencimiento ASC, i.fecha ASC
         LIMIT 1000`, params
      );
      // Días de atraso se calculan en JS (julianday/DATEDIFF no son portables
      // entre sql.js y MariaDB).
      const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
      const items = rows.map((r) => {
        let diasAtraso = 0;
        if (r.vencimiento) {
          const v = new Date(String(r.vencimiento).slice(0, 10) + 'T00:00:00');
          if (!Number.isNaN(v.getTime())) diasAtraso = Math.max(0, Math.floor((hoy - v) / 86400000));
        }
        return {
          id: r.id, numero: r.numero, ncf: r.ncf || '',
          clientId: r.client_id, clientName: r.client_name || '',
          sucursal: r.branch_name || '',
          fecha: r.fecha, vencimiento: r.vencimiento || null,
          total: Number(r.total || 0), pagado: Number(r.pagado || 0), balance: Number(r.balance || 0),
          estado: r.estado,
          diasAtraso,
          vencida: diasAtraso > 0,
        };
      });
      const resumen = items.reduce((a, it) => {
        a.totalPendiente += it.balance;
        if (it.vencida) a.totalVencido += it.balance;
        return a;
      }, { totalPendiente: 0, totalVencido: 0, cantidad: items.length });
      resumen.totalPendiente = Number(resumen.totalPendiente.toFixed(2));
      resumen.totalVencido = Number(resumen.totalVencido.toFixed(2));
      res.json({ resumen, items });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createCobrosRouter, METODOS };
