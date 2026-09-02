'use strict';

/**
 * reportes.routes.js — Reportes del modo Empresas de Servicios (M4).
 * Comparativos por sucursal / usuario / servicio / cliente / método de pago,
 * en un rango de fechas. Un solo endpoint que devuelve todas las tablas.
 *
 *  GET /api/servicios/reportes?desde=&hasta=&branchId=
 */

const express = require('express');
const { makeServiceGuard, resolveBranch } = require('./_common');

function createReportesRouter(deps) {
  const { query, ensureSchema, isGlobalAdministratorUser, getUserScopeBranchId } = deps;
  const guard = makeServiceGuard(deps);
  const router = express.Router();
  router.use(guard.requireService());
  router.use(async (_q, _s, n) => { try { await ensureSchema(query); n(); } catch (e) { n(e); } });

  router.get('/', async (req, res) => {
    try {
      const scope = resolveBranch(req.authUser, req.query.branchId, deps);
      const hoy = new Date().toISOString().slice(0, 10);
      const desde = String(req.query.desde || '').trim() || (hoy.slice(0, 8) + '01');
      const hasta = String(req.query.hasta || '').trim() || hoy;
      const bScope = scope ? scope : null;
      const invB = bScope ? ' AND i.branch_id = ?' : '';
      const payB = bScope ? ' AND p.branch_id = ?' : '';
      const bp = bScope ? [bScope] : [];

      const [
        porSucursal, porUsuario, porServicio, porCliente, porMetodo, cotizaciones, cxc,
      ] = await Promise.all([
        query(
          `SELECT COALESCE(b.nombre,'(sin sucursal)') AS grupo,
                  COUNT(*) AS facturas,
                  COALESCE(SUM(i.total),0) AS facturado,
                  COALESCE(SUM(i.pagado),0) AS cobrado,
                  COALESCE(SUM(i.balance),0) AS por_cobrar
           FROM svc_invoices i LEFT JOIN branches b ON b.id = i.branch_id
           WHERE i.estado <> 'anulada' AND i.fecha BETWEEN ? AND ?${invB}
           GROUP BY grupo ORDER BY facturado DESC`, [desde, hasta, ...bp]
        ).catch(() => []),
        query(
          `SELECT COALESCE(i.created_by_user_name,'(desconocido)') AS grupo,
                  COUNT(*) AS facturas, COALESCE(SUM(i.total),0) AS facturado
           FROM svc_invoices i
           WHERE i.estado <> 'anulada' AND i.fecha BETWEEN ? AND ?${invB}
           GROUP BY grupo ORDER BY facturado DESC`, [desde, hasta, ...bp]
        ).catch(() => []),
        query(
          `SELECT it.descripcion AS grupo, SUM(it.cantidad) AS cantidad,
                  COALESCE(SUM(it.total),0) AS monto
           FROM svc_invoice_items it JOIN svc_invoices i ON i.id = it.invoice_id
           WHERE i.estado <> 'anulada' AND i.fecha BETWEEN ? AND ?${invB}
           GROUP BY it.descripcion ORDER BY monto DESC LIMIT 50`, [desde, hasta, ...bp]
        ).catch(() => []),
        query(
          `SELECT COALESCE(i.client_name,'Consumidor final') AS grupo,
                  COUNT(*) AS facturas, COALESCE(SUM(i.total),0) AS facturado,
                  COALESCE(SUM(i.balance),0) AS por_cobrar
           FROM svc_invoices i
           WHERE i.estado <> 'anulada' AND i.fecha BETWEEN ? AND ?${invB}
           GROUP BY grupo ORDER BY facturado DESC LIMIT 50`, [desde, hasta, ...bp]
        ).catch(() => []),
        query(
          `SELECT p.metodo AS grupo, COUNT(*) AS pagos, COALESCE(SUM(p.monto),0) AS monto
           FROM svc_invoice_payments p
           WHERE p.anulado_at IS NULL AND p.fecha BETWEEN ? AND ?${payB}
           GROUP BY p.metodo ORDER BY monto DESC`, [desde, hasta, ...bp]
        ).catch(() => []),
        query(
          `SELECT estado AS grupo, COUNT(*) AS cantidad, COALESCE(SUM(total),0) AS monto
           FROM svc_quotations WHERE fecha BETWEEN ? AND ?${bScope ? ' AND branch_id = ?' : ''}
           GROUP BY estado`, [desde, hasta, ...bp]
        ).catch(() => []),
        query(
          `SELECT COALESCE(b.nombre,'(sin sucursal)') AS grupo,
                  COUNT(*) AS facturas, COALESCE(SUM(i.balance),0) AS balance,
                  COALESCE(SUM(CASE WHEN i.vencimiento IS NOT NULL AND i.vencimiento < date('now') THEN i.balance ELSE 0 END),0) AS vencido
           FROM svc_invoices i LEFT JOIN branches b ON b.id = i.branch_id
           WHERE i.estado IN ('pendiente','parcial') AND i.balance > 0.009${invB}
           GROUP BY grupo ORDER BY balance DESC`, [...bp]
        ).catch(() => []),
      ]);

      const num = (rows, keys) => rows.map((r) => {
        const o = { grupo: r.grupo };
        keys.forEach((k) => { o[k] = Number(r[k] || 0); });
        return o;
      });

      res.json({
        rango: { desde, hasta },
        porSucursal: num(porSucursal, ['facturas', 'facturado', 'cobrado', 'por_cobrar']),
        porUsuario: num(porUsuario, ['facturas', 'facturado']),
        porServicio: num(porServicio, ['cantidad', 'monto']),
        porCliente: num(porCliente, ['facturas', 'facturado', 'por_cobrar']),
        porMetodoPago: num(porMetodo, ['pagos', 'monto']),
        cotizaciones: num(cotizaciones, ['cantidad', 'monto']),
        cuentasPorCobrar: num(cxc, ['facturas', 'balance', 'vencido']),
      });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createReportesRouter };
