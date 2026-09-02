'use strict';

/**
 * auditoria.routes.js — Historial de auditoría del modo Empresas de Servicios.
 * Lee audit_logs con las columnas de contexto (branch_id, cash_register_id,
 * client_id, document_type/ref, amount, payment_method) que agrega
 * ensureServiciosCoreExtensions() en server.js.
 *
 *  GET /api/servicios/auditoria?usuario=&branchId=&modulo=&accion=&desde=&hasta=&docTipo=
 */

const express = require('express');
const { makeServiceGuard, resolveBranch } = require('./_common');

function createAuditoriaRouter(deps) {
  const { query, isGlobalAdministratorUser, getUserScopeBranchId } = deps;
  const guard = makeServiceGuard(deps);
  const router = express.Router();

  router.use(guard.requireService());

  router.get('/', async (req, res) => {
    try {
      const branchScope = resolveBranch(req.authUser, req.query.branchId, deps);
      const cond = [];
      const params = [];
      if (branchScope) { cond.push('a.branch_id = ?'); params.push(branchScope); }
      if (req.query.usuario) { cond.push('(a.user_name LIKE ? OR a.user_id = ?)'); params.push(`%${req.query.usuario}%`, Number(req.query.usuario) || -1); }
      if (req.query.modulo) { cond.push('a.module_name = ?'); params.push(String(req.query.modulo)); }
      if (req.query.accion) { cond.push('a.action_name LIKE ?'); params.push(`%${req.query.accion}%`); }
      if (req.query.docTipo) { cond.push('a.document_type = ?'); params.push(String(req.query.docTipo)); }
      if (req.query.desde) { cond.push("a.created_at >= ?"); params.push(String(req.query.desde)); }
      if (req.query.hasta) { cond.push("a.created_at <= ?"); params.push(String(req.query.hasta) + ' 23:59:59'); }
      const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const rows = await query(
        `SELECT a.*, b.nombre AS branch_name, cr.nombre AS register_name, c.nombre AS client_nombre
         FROM audit_logs a
         LEFT JOIN branches b ON b.id = a.branch_id
         LEFT JOIN cash_registers cr ON cr.id = a.cash_register_id
         LEFT JOIN clients c ON c.id = a.client_id
         ${where}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT 1000`, params
      ).catch(async (e) => {
        // Fallback si las columnas de contexto aún no existen.
        if (!String(e.message || '').toLowerCase().includes('column')) throw e;
        return query(
          `SELECT a.* FROM audit_logs a ${where.replace(/a\.(branch_id|cash_register_id|client_id|document_type)[^)]*/g, '1=1')}
           ORDER BY a.created_at DESC, a.id DESC LIMIT 1000`, []
        );
      });
      res.json(rows.map((r) => ({
        id: r.id,
        fecha: r.created_at,
        usuario: r.user_name,
        usuarioId: r.user_id || null,
        rol: r.user_role || '',
        modulo: r.module_name,
        accion: r.action_name,
        detalle: r.detail || '',
        sucursal: r.branch_name || '',
        terminal: r.register_name || '',
        cliente: r.client_nombre || '',
        documentoTipo: r.document_type || '',
        documento: r.document_ref || '',
        monto: r.amount != null ? Number(r.amount) : null,
        metodoPago: r.payment_method || '',
      })));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createAuditoriaRouter };
