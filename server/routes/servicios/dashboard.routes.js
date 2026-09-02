'use strict';

/**
 * dashboard.routes.js — Indicadores del modo Empresas de Servicios.
 * Se adapta al vertical vía config.service_vertical (el frontend decide qué
 * tarjetas mostrar; aquí devolvemos todos los números disponibles).
 *
 *  GET /api/servicios/dashboard?desde=&hasta=&branchId=
 */

const express = require('express');
const { makeServiceGuard, resolveBranch } = require('./_common');

function createDashboardRouter(deps) {
  const { query, ensureSchema, getConfig, isGlobalAdministratorUser, getUserScopeBranchId } = deps;
  const guard = makeServiceGuard(deps);
  const router = express.Router();

  router.use(guard.requireService());
  router.use(async (_req, _res, next) => {
    try { await ensureSchema(query); next(); } catch (e) { next(e); }
  });

  router.get('/', async (req, res) => {
    try {
      const branchScope = resolveBranch(req.authUser, req.query.branchId, deps);
      const hoy = new Date().toISOString().slice(0, 10);
      const desde = String(req.query.desde || '').trim() || hoy.slice(0, 8) + '01';
      const hasta = String(req.query.hasta || '').trim() || hoy;

      const invBranch = branchScope ? ' AND i.branch_id = ?' : '';
      const payBranch = branchScope ? ' AND p.branch_id = ?' : '';
      const bp = branchScope ? [branchScope] : [];

      const [
        [fact = {}], [cobros = {}], [cxc = {}], [pend = {}], [venc = {}],
        cotEstados, [gastos = {}], porSucursal, topServicios,
      ] = await Promise.all([
        query(
          `SELECT COALESCE(SUM(total),0) AS monto, COUNT(*) AS cant
           FROM svc_invoices i WHERE i.estado <> 'anulada' AND i.fecha BETWEEN ? AND ?${invBranch}`,
          [desde, hasta, ...bp]
        ),
        query(
          `SELECT COALESCE(SUM(p.monto),0) AS monto, COUNT(*) AS cant
           FROM svc_invoice_payments p WHERE p.anulado_at IS NULL AND p.fecha BETWEEN ? AND ?${payBranch}`,
          [desde, hasta, ...bp]
        ),
        query(
          `SELECT COALESCE(SUM(balance),0) AS monto FROM svc_invoices i
           WHERE i.estado IN ('pendiente','parcial') AND i.balance > 0.009${invBranch}`,
          [...bp]
        ),
        query(
          `SELECT COUNT(*) AS cant FROM svc_invoices i
           WHERE i.estado IN ('pendiente','parcial')${invBranch}`, [...bp]
        ),
        query(
          `SELECT COUNT(*) AS cant FROM svc_invoices i
           WHERE i.estado IN ('pendiente','parcial') AND i.vencimiento IS NOT NULL AND i.vencimiento < date('now')${invBranch}`,
          [...bp]
        ),
        query(
          `SELECT estado, COUNT(*) AS cant FROM svc_quotations q
           WHERE q.fecha BETWEEN ? AND ?${branchScope ? ' AND q.branch_id = ?' : ''}
           GROUP BY estado`, [desde, hasta, ...bp]
        ),
        query(
          `SELECT COALESCE(SUM(total),0) AS monto FROM expenses
           WHERE estado <> 'anulado' AND fecha BETWEEN ? AND ?${branchScope ? ' AND branch_id = ?' : ''}`,
          [desde, hasta, ...bp]
        ).catch(() => [{ monto: 0 }]),
        query(
          `SELECT b.id, b.nombre,
             COALESCE(SUM(CASE WHEN i.estado <> 'anulada' AND i.fecha BETWEEN ? AND ? THEN i.total ELSE 0 END),0) AS facturado,
             COALESCE(SUM(CASE WHEN i.estado IN ('pendiente','parcial') THEN i.balance ELSE 0 END),0) AS por_cobrar
           FROM branches b LEFT JOIN svc_invoices i ON i.branch_id = b.id
           GROUP BY b.id, b.nombre ORDER BY facturado DESC`, [desde, hasta]
        ).catch(() => []),
        query(
          `SELECT it.descripcion AS nombre, COUNT(*) AS veces, COALESCE(SUM(it.total),0) AS monto
           FROM svc_invoice_items it JOIN svc_invoices i ON i.id = it.invoice_id
           WHERE i.estado <> 'anulada' AND i.fecha BETWEEN ? AND ?${branchScope ? ' AND i.branch_id = ?' : ''}
           GROUP BY it.descripcion ORDER BY monto DESC LIMIT 5`, [desde, hasta, ...bp]
        ).catch(() => []),
      ]);

      const cot = {};
      (cotEstados || []).forEach((r) => { cot[r.estado] = Number(r.cant || 0); });
      const cfg = await getConfig().catch(() => ({}));
      const facturado = Number(fact.monto || 0);
      const gastosMonto = Number(gastos.monto || 0);

      res.json({
        vertical: cfg.serviceVertical || cfg.tipoNegocio || null,
        rango: { desde, hasta },
        serviciosFacturados: { monto: facturado, cantidad: Number(fact.cant || 0) },
        cobrosPeriodo: { monto: Number(cobros.monto || 0), cantidad: Number(cobros.cant || 0) },
        cuentasPorCobrar: Number(cxc.monto || 0),
        facturasPendientes: Number(pend.cant || 0),
        facturasVencidas: Number(venc.cant || 0),
        cotizaciones: {
          borrador: cot.borrador || 0, enviada: cot.enviada || 0, aprobada: cot.aprobada || 0,
          rechazada: cot.rechazada || 0, convertida: cot.convertida || 0,
        },
        gastosPeriodo: gastosMonto,
        gananciaEstimada: Number((facturado - gastosMonto).toFixed(2)),
        porSucursal: (porSucursal || []).map((r) => ({
          branchId: r.id, sucursal: r.nombre,
          facturado: Number(r.facturado || 0), porCobrar: Number(r.por_cobrar || 0),
        })),
        topServicios: (topServicios || []).map((r) => ({
          nombre: r.nombre, veces: Number(r.veces || 0), monto: Number(r.monto || 0),
        })),
      });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createDashboardRouter };
