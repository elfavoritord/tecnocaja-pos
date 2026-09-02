'use strict';

/**
 * calendario.routes.js — Servicios programados / agenda.
 * Aplica a Limpieza y Mantenimiento (visitas recurrentes).
 *
 *  GET    /api/servicios/calendario?desde=&hasta=&estado=&clientId=&branchId=
 *  POST   /api/servicios/calendario
 *  PUT    /api/servicios/calendario/:id
 *  POST   /api/servicios/calendario/:id/estado   { estado }
 *  DELETE /api/servicios/calendario/:id
 */

const express = require('express');
const { httpError, roleCodeOf, actorName, makeServiceGuard, resolveBranch } = require('./_common');

const ESTADOS = ['programado', 'hecho', 'reprogramado', 'cancelado'];
const RECURRENCIAS = ['unica', 'semanal', 'quincenal', 'mensual'];

function mapSched(r) {
  return {
    id: r.id,
    contractId: r.contract_id || null,
    clientId: r.client_id || null, clientName: r.client_name || '',
    branchId: r.branch_id || null, sucursal: r.branch_name || '',
    serviceId: r.service_id || null,
    titulo: r.titulo, fecha: r.fecha, hora: r.hora || '',
    recurrencia: r.recurrencia || 'unica',
    empleadoId: r.empleado_id || null, empleado: r.empleado_nombre || '',
    estado: r.estado, notas: r.notas || '', workOrderId: r.work_order_id || null,
    creadoPor: r.created_by_user_name || '', createdAt: r.created_at,
  };
}

function createCalendarioRouter(deps) {
  const {
    query, writeAuditLog, ensureSchema, isGlobalAdministratorUser, getUserScopeBranchId,
  } = deps;
  const guard = makeServiceGuard(deps);
  const router = express.Router();
  router.use(guard.requireService());
  router.use(async (_q, _s, next) => { try { await ensureSchema(query); next(); } catch (e) { next(e); } });

  async function readBody(body) {
    const titulo = String(body?.titulo || '').trim();
    if (!titulo) throw httpError('El título del servicio programado es obligatorio.');
    const fecha = String(body?.fecha || '').trim();
    if (!fecha) throw httpError('Indica la fecha.');
    let clientId = body?.clientId ? Number(body.clientId) : null;
    let clientName = String(body?.clientName || '').trim() || null;
    if (clientId) {
      const [cli] = await query('SELECT nombre FROM clients WHERE id = ? LIMIT 1', [clientId]);
      if (cli) clientName = cli.nombre; else clientId = null;
    }
    return {
      titulo, fecha, clientId, clientName,
      contractId: body?.contractId ? Number(body.contractId) : null,
      serviceId: body?.serviceId ? Number(body.serviceId) : null,
      hora: String(body?.hora || '').trim() || null,
      recurrencia: RECURRENCIAS.includes(body?.recurrencia) ? body.recurrencia : 'unica',
      empleadoId: body?.empleadoId ? Number(body.empleadoId) : null,
      empleadoNombre: String(body?.empleadoNombre || '').trim() || null,
      notas: String(body?.notas || '').trim() || null,
    };
  }

  async function fetchFull(id) {
    const [row] = await query(
      `SELECT s.*, b.nombre AS branch_name FROM svc_scheduled_services s
       LEFT JOIN branches b ON b.id = s.branch_id WHERE s.id = ?`, [id]
    );
    return row ? mapSched(row) : null;
  }

  router.get('/', async (req, res) => {
    try {
      const scope = resolveBranch(req.authUser, req.query.branchId, deps);
      const cond = []; const params = [];
      if (scope) { cond.push('s.branch_id = ?'); params.push(scope); }
      if (req.query.estado) { cond.push('s.estado = ?'); params.push(String(req.query.estado)); }
      if (req.query.clientId) { cond.push('s.client_id = ?'); params.push(Number(req.query.clientId)); }
      if (req.query.desde) { cond.push('s.fecha >= ?'); params.push(String(req.query.desde)); }
      if (req.query.hasta) { cond.push('s.fecha <= ?'); params.push(String(req.query.hasta)); }
      const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const rows = await query(
        `SELECT s.*, b.nombre AS branch_name FROM svc_scheduled_services s
         LEFT JOIN branches b ON b.id = s.branch_id ${where}
         ORDER BY s.fecha ASC, s.hora ASC LIMIT 1000`, params
      );
      res.json(rows.map(mapSched));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.post('/', guard.requirePerm('servicios.crear'), async (req, res) => {
    const actor = req.authUser;
    try {
      const p = await readBody(req.body);
      const branchId = resolveBranch(actor, req.body?.branchId, deps) || (req.body?.branchId ? Number(req.body.branchId) : null);
      const r = await query(
        `INSERT INTO svc_scheduled_services
          (contract_id, client_id, client_name, branch_id, service_id, titulo, fecha, hora, recurrencia,
           empleado_id, empleado_nombre, estado, notas, created_by_user_id, created_by_user_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'programado', ?, ?, ?)`,
        [p.contractId, p.clientId, p.clientName, branchId, p.serviceId, p.titulo, p.fecha, p.hora, p.recurrencia,
         p.empleadoId, p.empleadoNombre, p.notas, actor.id, actorName(actor)]
      );
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Calendario', actionName: 'Servicio programado',
        detail: `${p.titulo} · ${p.fecha}`, branchId, clientId: p.clientId, documentType: 'agenda',
      });
      res.status(201).json(await fetchFull(r.insertId));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.put('/:id', guard.requirePerm('servicios.editar', 'servicios.crear'), async (req, res) => {
    const id = Number(req.params.id);
    try {
      const [cur] = await query('SELECT * FROM svc_scheduled_services WHERE id = ?', [id]);
      if (!cur) throw httpError('Servicio programado no encontrado.', 404);
      const p = await readBody(req.body);
      await query(
        `UPDATE svc_scheduled_services SET contract_id=?, client_id=?, client_name=?, service_id=?, titulo=?, fecha=?, hora=?,
           recurrencia=?, empleado_id=?, empleado_nombre=?, notas=? WHERE id=?`,
        [p.contractId, p.clientId, p.clientName, p.serviceId, p.titulo, p.fecha, p.hora, p.recurrencia,
         p.empleadoId, p.empleadoNombre, p.notas, id]
      );
      res.json(await fetchFull(id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.post('/:id/estado', guard.requirePerm('servicios.editar'), async (req, res) => {
    const actor = req.authUser; const id = Number(req.params.id);
    const nuevo = String(req.body?.estado || '').toLowerCase();
    try {
      if (!ESTADOS.includes(nuevo)) throw httpError('Estado no válido.');
      const [cur] = await query('SELECT * FROM svc_scheduled_services WHERE id = ?', [id]);
      if (!cur) throw httpError('Servicio programado no encontrado.', 404);
      await query('UPDATE svc_scheduled_services SET estado = ? WHERE id = ?', [nuevo, id]);
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Calendario', actionName: `Programación ${nuevo}`, detail: `${cur.titulo} · ${cur.fecha}`,
        branchId: cur.branch_id, clientId: cur.client_id, documentType: 'agenda',
      });
      res.json(await fetchFull(id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.delete('/:id', guard.requirePerm('servicios.editar', 'servicios.anular'), async (req, res) => {
    try {
      await query('DELETE FROM svc_scheduled_services WHERE id = ?', [Number(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  return router;
}

module.exports = { createCalendarioRouter, ESTADOS, RECURRENCIAS };
