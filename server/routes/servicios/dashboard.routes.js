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

// Fecha LOCAL del servidor (toISOString es UTC: en RD, después de las 8 p. m.
// daba mañana y el último día del mes ya contaba como el mes siguiente).
function fechaLocal(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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
      const hoy = fechaLocal();
      const esFecha = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim());
      const desde = esFecha(req.query.desde) ? String(req.query.desde).trim() : hoy.slice(0, 8) + '01';
      const hasta = esFecha(req.query.hasta) ? String(req.query.hasta).trim() : hoy;

      const invBranch = branchScope ? ' AND i.branch_id = ?' : '';
      const payBranch = branchScope ? ' AND p.branch_id = ?' : '';
      const expBranch = branchScope ? ' AND e.branch_id = ?' : '';
      const bp = branchScope ? [branchScope] : [];

      const [
        [fact = {}], [cobros = {}], [cxc = {}], [pend = {}], [venc = {}],
        cotEstados, [gastos = {}], porSucursal, topServicios, porCobrarLista, gastosPorCategoria,
        [cotAbiertas = {}],
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
        // Fecha como parámetro: date('now') solo existe en SQLite; en MariaDB
        // daba NULL y las vencidas salían siempre en 0.
        query(
          `SELECT COUNT(*) AS cant FROM svc_invoices i
           WHERE i.estado IN ('pendiente','parcial') AND i.vencimiento IS NOT NULL AND i.vencimiento < ?${invBranch}`,
          [hoy, ...bp]
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
        // Desde las facturas (no desde branches): las facturas sin sucursal
        // también cuentan (antes el total salía 4,720 y la sucursal en 0).
        query(
          `SELECT i.branch_id AS id, b.nombre,
             COALESCE(SUM(CASE WHEN i.estado <> 'anulada' AND i.fecha BETWEEN ? AND ? THEN i.total ELSE 0 END),0) AS facturado,
             COALESCE(SUM(CASE WHEN i.estado IN ('pendiente','parcial') THEN i.balance ELSE 0 END),0) AS por_cobrar
           FROM svc_invoices i LEFT JOIN branches b ON b.id = i.branch_id
           WHERE 1 = 1${invBranch}
           GROUP BY i.branch_id, b.nombre ORDER BY facturado DESC`, [desde, hasta, ...bp]
        ).catch(() => []),
        query(
          `SELECT it.descripcion AS nombre, COUNT(*) AS veces, COALESCE(SUM(it.total),0) AS monto
           FROM svc_invoice_items it JOIN svc_invoices i ON i.id = it.invoice_id
           WHERE i.estado <> 'anulada' AND i.fecha BETWEEN ? AND ?${invBranch}
           GROUP BY it.descripcion ORDER BY monto DESC LIMIT 5`, [desde, hasta, ...bp]
        ).catch(() => []),
        // Las que más tiempo llevan pendientes primero (por vencimiento o fecha).
        query(
          `SELECT i.id, i.numero, i.client_name, i.fecha, i.vencimiento, i.balance
           FROM svc_invoices i
           WHERE i.estado IN ('pendiente','parcial') AND i.balance > 0.009${invBranch}
           ORDER BY COALESCE(i.vencimiento, i.fecha), i.id LIMIT 6`, [...bp]
        ).catch(() => []),
        // Gastos por categoría: las líneas cuentan con su propia categoría; los
        // gastos de un solo monto (sin líneas), con la del gasto.
        query(
          `SELECT categoria, SUM(monto) AS monto FROM (
             SELECT COALESCE(ei.categoria, e.categoria) AS categoria, ei.total AS monto
             FROM expense_items ei JOIN expenses e ON e.id = ei.expense_id
             WHERE e.estado <> 'anulado' AND e.fecha BETWEEN ? AND ?${expBranch}
             UNION ALL
             SELECT e.categoria, e.total AS monto FROM expenses e
             WHERE e.estado <> 'anulado' AND e.fecha BETWEEN ? AND ?${expBranch}
               AND NOT EXISTS (SELECT 1 FROM expense_items x WHERE x.expense_id = e.id)
           ) t GROUP BY categoria ORDER BY monto DESC LIMIT 6`,
          [desde, hasta, ...bp, desde, hasta, ...bp]
        ).catch(() => []),
        // Abiertas de cualquier fecha: una cotización de otro mes sigue pendiente.
        query(
          `SELECT COUNT(*) AS cant, COALESCE(SUM(total),0) AS monto FROM svc_quotations q
           WHERE q.estado IN ('borrador','enviada','aprobada')${branchScope ? ' AND q.branch_id = ?' : ''}`,
          [...bp]
        ).catch(() => [{ cant: 0, monto: 0 }]),
      ]);

      const cot = {};
      (cotEstados || []).forEach((r) => { cot[r.estado] = Number(r.cant || 0); });
      const cfg = await getConfig().catch(() => ({}));
      const facturado = Number(fact.monto || 0);
      const gastosMonto = Number(gastos.monto || 0);
      const n = (k) => cot[k] || 0;

      res.json({
        vertical: cfg.serviceVertical || cfg.tipoNegocio || null,
        rango: { desde, hasta },
        serviciosFacturados: { monto: facturado, cantidad: Number(fact.cant || 0) },
        cobrosPeriodo: { monto: Number(cobros.monto || 0), cantidad: Number(cobros.cant || 0) },
        cuentasPorCobrar: Number(cxc.monto || 0),
        facturasPendientes: Number(pend.cant || 0),
        facturasVencidas: Number(venc.cant || 0),
        // Cada estado del período por separado; "abiertas" = las que aún pueden
        // facturarse, de cualquier fecha. (Antes "aprobada" ya sumaba borrador y
        // enviada, y el panel volvía a sumar campos que no venían: salía NaN.)
        cotizaciones: {
          borrador: n('borrador'), enviada: n('enviada'), aprobada: n('aprobada'),
          rechazada: n('rechazada'), vencida: n('vencida'), convertida: n('convertida'),
          abiertas: Number(cotAbiertas.cant || 0),
          montoAbiertas: Number(cotAbiertas.monto || 0),
        },
        gastosPeriodo: gastosMonto,
        gananciaEstimada: Number((facturado - gastosMonto).toFixed(2)),
        porSucursal: (porSucursal || []).map((r) => ({
          branchId: r.id || null, sucursal: r.nombre || 'Sin sucursal asignada',
          facturado: Number(r.facturado || 0), porCobrar: Number(r.por_cobrar || 0),
        })),
        topServicios: (topServicios || []).map((r) => ({
          nombre: r.nombre, veces: Number(r.veces || 0), monto: Number(r.monto || 0),
        })),
        porCobrar: (porCobrarLista || []).map((r) => ({
          id: r.id, numero: r.numero, cliente: r.client_name || '', fecha: r.fecha,
          vencimiento: r.vencimiento || null, balance: Number(r.balance || 0),
          vencida: Boolean(r.vencimiento)
            && (r.vencimiento instanceof Date ? fechaLocal(r.vencimiento) : String(r.vencimiento).slice(0, 10)) < hoy,
        })),
        gastosPorCategoria: (gastosPorCategoria || []).map((r) => ({
          categoria: r.categoria || 'Sin categoría', monto: Number(r.monto || 0),
        })),
      });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createDashboardRouter };
