'use strict';

/**
 * proyectos.routes.js — Proyectos con tareas, gastos, avance y rentabilidad.
 * Aplica a Consultoría, Tecnología, Publicidad, Arquitectura.
 *
 *  GET    /api/servicios/proyectos?estado=&clientId=&branchId=
 *  POST   /api/servicios/proyectos
 *  GET    /api/servicios/proyectos/:id           (incluye tareas, gastos, rentabilidad)
 *  PUT    /api/servicios/proyectos/:id
 *  POST   /api/servicios/proyectos/:id/estado    { estado, avancePct? }
 *  DELETE /api/servicios/proyectos/:id
 *  POST   /api/servicios/proyectos/:id/tareas               { titulo, ... }
 *  PUT    /api/servicios/proyectos/:id/tareas/:taskId
 *  POST   /api/servicios/proyectos/:id/tareas/:taskId/estado { estado }
 *  DELETE /api/servicios/proyectos/:id/tareas/:taskId
 *  POST   /api/servicios/proyectos/:id/gastos               { descripcion, monto, fecha }
 *  DELETE /api/servicios/proyectos/:id/gastos/:expId
 */

const express = require('express');
const { httpError, roleCodeOf, actorName, round2, makeServiceGuard, resolveBranch } = require('./_common');

const ESTADOS = ['planificacion', 'en_progreso', 'pausado', 'completado', 'cancelado'];
const TAREA_ESTADOS = ['pendiente', 'en_progreso', 'hecha'];

function mapProject(r) {
  return {
    id: r.id, numero: r.numero,
    clientId: r.client_id || null, clientName: r.client_name || '',
    branchId: r.branch_id || null, sucursal: r.branch_name || '',
    nombre: r.nombre, descripcion: r.descripcion || '',
    presupuesto: Number(r.presupuesto || 0),
    fechaInicio: r.fecha_inicio || null, fechaEntrega: r.fecha_entrega || null,
    responsableId: r.responsable_id || null, responsable: r.responsable_nombre || '',
    estado: r.estado, avancePct: Number(r.avance_pct || 0), notas: r.notas || '',
    creadoPor: r.created_by_user_name || '', createdAt: r.created_at,
  };
}
const mapTask = (t) => ({
  id: t.id, projectId: t.project_id, titulo: t.titulo, descripcion: t.descripcion || '',
  asignadoId: t.asignado_id || null, asignado: t.asignado_nombre || '',
  estado: t.estado, fechaLimite: t.fecha_limite || null, orden: Number(t.orden || 0),
  doneAt: t.done_at || null,
});
const mapExp = (e) => ({
  id: e.id, projectId: e.project_id, descripcion: e.descripcion, categoria: e.categoria || '',
  monto: Number(e.monto || 0), fecha: e.fecha, creadoPor: e.created_by_user_name || '',
});

function createProyectosRouter(deps) {
  const {
    query, writeAuditLog, ensureSchema, nextServiceDocNumber, withTransaction,
    isGlobalAdministratorUser, getUserScopeBranchId,
  } = deps;
  const guard = makeServiceGuard(deps);
  const router = express.Router();
  router.use(guard.requireService());
  router.use(async (_q, _s, next) => { try { await ensureSchema(query); next(); } catch (e) { next(e); } });

  async function readBody(body) {
    const nombre = String(body?.nombre || '').trim();
    if (!nombre) throw httpError('El nombre del proyecto es obligatorio.');
    let clientId = body?.clientId ? Number(body.clientId) : null;
    let clientName = String(body?.clientName || '').trim() || null;
    if (clientId) {
      const [cli] = await query('SELECT nombre FROM clients WHERE id = ? LIMIT 1', [clientId]);
      if (cli) clientName = cli.nombre; else clientId = null;
    }
    return {
      nombre, clientId, clientName,
      descripcion: String(body?.descripcion || '').trim() || null,
      presupuesto: Math.max(0, Number(body?.presupuesto || 0)),
      fechaInicio: String(body?.fechaInicio || '').trim() || null,
      fechaEntrega: String(body?.fechaEntrega || '').trim() || null,
      responsableId: body?.responsableId ? Number(body.responsableId) : null,
      responsableNombre: String(body?.responsableNombre || '').trim() || null,
      notas: String(body?.notas || '').trim() || null,
    };
  }

  async function projectRow(id) {
    const [row] = await query(
      `SELECT p.*, b.nombre AS branch_name FROM svc_projects p
       LEFT JOIN branches b ON b.id = p.branch_id WHERE p.id = ?`, [id]
    );
    return row || null;
  }

  async function fullProject(id) {
    const row = await projectRow(id);
    if (!row) return null;
    const [tareas, gastos, invAgg] = await Promise.all([
      query('SELECT * FROM svc_project_tasks WHERE project_id = ? ORDER BY orden, id', [id]),
      query('SELECT * FROM svc_project_expenses WHERE project_id = ? ORDER BY fecha DESC, id DESC', [id]),
      query(`SELECT COALESCE(SUM(total),0) AS facturado, COALESCE(SUM(pagado),0) AS cobrado
             FROM svc_invoices WHERE origin_type='proyecto' AND origin_id=? AND estado<>'anulada'`, [id]).catch(() => [{ facturado: 0, cobrado: 0 }]),
    ]);
    const gastado = gastos.reduce((s, g) => s + Number(g.monto || 0), 0);
    const facturado = Number(invAgg[0]?.facturado || 0);
    const cobrado = Number(invAgg[0]?.cobrado || 0);
    const presupuesto = Number(row.presupuesto || 0);
    return {
      ...mapProject(row),
      tareas: tareas.map(mapTask),
      gastos: gastos.map(mapExp),
      rentabilidad: {
        presupuesto, gastado: round2(gastado), facturado: round2(facturado), cobrado: round2(cobrado),
        margenPresupuesto: round2(presupuesto - gastado),
        margenFacturado: round2(facturado - gastado),
      },
    };
  }

  // Recalcula avance a partir de tareas (si hay tareas). Manual si no.
  async function recalcAvance(id) {
    const rows = await query('SELECT estado FROM svc_project_tasks WHERE project_id = ?', [id]);
    if (!rows.length) return;
    const done = rows.filter((t) => t.estado === 'hecha').length;
    const pct = Math.round((done / rows.length) * 100);
    await query(`UPDATE svc_projects SET avance_pct=?, updated_at=datetime('now') WHERE id=?`, [pct, id]);
  }

  router.get('/', async (req, res) => {
    try {
      const scope = resolveBranch(req.authUser, req.query.branchId, deps);
      const cond = []; const params = [];
      if (scope) { cond.push('p.branch_id = ?'); params.push(scope); }
      if (req.query.estado) { cond.push('p.estado = ?'); params.push(String(req.query.estado)); }
      if (req.query.clientId) { cond.push('p.client_id = ?'); params.push(Number(req.query.clientId)); }
      const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const rows = await query(
        `SELECT p.*, b.nombre AS branch_name FROM svc_projects p
         LEFT JOIN branches b ON b.id = p.branch_id ${where}
         ORDER BY (p.estado IN ('completado','cancelado')), p.created_at DESC LIMIT 500`, params
      );
      res.json(rows.map(mapProject));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.get('/:id', async (req, res) => {
    try {
      const full = await fullProject(Number(req.params.id));
      if (!full) return res.status(404).json({ error: 'Proyecto no encontrado.' });
      res.json(full);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.post('/', guard.requirePerm('servicios.crear'), async (req, res) => {
    const actor = req.authUser;
    try {
      const p = await readBody(req.body);
      const branchId = resolveBranch(actor, req.body?.branchId, deps) || (req.body?.branchId ? Number(req.body.branchId) : null);
      const saved = await withTransaction(async (conn) => {
        const numero = await nextServiceDocNumber(conn, 'project');
        const r = await conn.query(
          `INSERT INTO svc_projects
            (numero, client_id, client_name, branch_id, nombre, descripcion, presupuesto, fecha_inicio, fecha_entrega,
             responsable_id, responsable_nombre, estado, notas, created_by_user_id, created_by_user_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planificacion', ?, ?, ?)`,
          [numero, p.clientId, p.clientName, branchId, p.nombre, p.descripcion, p.presupuesto, p.fechaInicio, p.fechaEntrega,
           p.responsableId, p.responsableNombre, p.notas, actor.id, actorName(actor)]
        );
        return { id: r.insertId, numero };
      });
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Proyectos', actionName: 'Proyecto creado',
        detail: `${saved.numero} · ${p.nombre}`, branchId, clientId: p.clientId,
        documentType: 'proyecto', documentRef: saved.numero, amount: p.presupuesto,
      });
      res.status(201).json(await fullProject(saved.id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.put('/:id', guard.requirePerm('servicios.crear', 'servicios.editar'), async (req, res) => {
    const actor = req.authUser; const id = Number(req.params.id);
    try {
      const cur = await projectRow(id);
      if (!cur) throw httpError('Proyecto no encontrado.', 404);
      const p = await readBody(req.body);
      await query(
        `UPDATE svc_projects SET client_id=?, client_name=?, nombre=?, descripcion=?, presupuesto=?, fecha_inicio=?, fecha_entrega=?,
           responsable_id=?, responsable_nombre=?, notas=?, updated_at=datetime('now') WHERE id=?`,
        [p.clientId, p.clientName, p.nombre, p.descripcion, p.presupuesto, p.fechaInicio, p.fechaEntrega,
         p.responsableId, p.responsableNombre, p.notas, id]
      );
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Proyectos', actionName: 'Proyecto editado', detail: cur.numero,
        branchId: cur.branch_id, clientId: p.clientId, documentType: 'proyecto', documentRef: cur.numero,
      });
      res.json(await fullProject(id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.post('/:id/estado', guard.requirePerm('servicios.editar'), async (req, res) => {
    const actor = req.authUser; const id = Number(req.params.id);
    const nuevo = String(req.body?.estado || '').toLowerCase();
    try {
      if (!ESTADOS.includes(nuevo)) throw httpError('Estado no válido.');
      const cur = await projectRow(id);
      if (!cur) throw httpError('Proyecto no encontrado.', 404);
      const avance = req.body?.avancePct != null ? Math.max(0, Math.min(100, Number(req.body.avancePct))) : cur.avance_pct;
      await query(`UPDATE svc_projects SET estado=?, avance_pct=?, updated_at=datetime('now') WHERE id=?`, [nuevo, avance, id]);
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Proyectos', actionName: `Proyecto ${nuevo}`, detail: cur.numero,
        branchId: cur.branch_id, clientId: cur.client_id, documentType: 'proyecto', documentRef: cur.numero,
      });
      res.json(await fullProject(id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.delete('/:id', guard.requirePerm('servicios.anular', 'servicios.editar'), async (req, res) => {
    const actor = req.authUser; const id = Number(req.params.id);
    try {
      const cur = await projectRow(id);
      if (!cur) throw httpError('Proyecto no encontrado.', 404);
      await query('DELETE FROM svc_projects WHERE id = ?', [id]);
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Proyectos', actionName: 'Proyecto eliminado', detail: cur.numero,
      });
      res.json({ ok: true });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ── Tareas ───────────────────────────────────────────────────────────────
  router.post('/:id/tareas', guard.requirePerm('servicios.editar', 'servicios.crear'), async (req, res) => {
    const id = Number(req.params.id);
    try {
      const titulo = String(req.body?.titulo || '').trim();
      if (!titulo) throw httpError('El título de la tarea es obligatorio.');
      const [{ n = 0 } = {}] = await query('SELECT COALESCE(MAX(orden),0) AS n FROM svc_project_tasks WHERE project_id = ?', [id]);
      const r = await query(
        `INSERT INTO svc_project_tasks (project_id, titulo, descripcion, asignado_id, asignado_nombre, estado, fecha_limite, orden)
         VALUES (?, ?, ?, ?, ?, 'pendiente', ?, ?)`,
        [id, titulo, String(req.body?.descripcion || '').trim() || null,
         req.body?.asignadoId ? Number(req.body.asignadoId) : null, String(req.body?.asignadoNombre || '').trim() || null,
         String(req.body?.fechaLimite || '').trim() || null, Number(n) + 1]
      );
      await recalcAvance(id);
      const [t] = await query('SELECT * FROM svc_project_tasks WHERE id = ?', [r.insertId]);
      res.status(201).json(mapTask(t));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.put('/:id/tareas/:taskId', guard.requirePerm('servicios.editar'), async (req, res) => {
    const id = Number(req.params.id); const taskId = Number(req.params.taskId);
    try {
      const [t] = await query('SELECT * FROM svc_project_tasks WHERE id = ? AND project_id = ?', [taskId, id]);
      if (!t) throw httpError('Tarea no encontrada.', 404);
      await query(
        `UPDATE svc_project_tasks SET titulo=?, descripcion=?, asignado_id=?, asignado_nombre=?, fecha_limite=? WHERE id=?`,
        [String(req.body?.titulo || t.titulo).trim(), String(req.body?.descripcion || '').trim() || null,
         req.body?.asignadoId ? Number(req.body.asignadoId) : null, String(req.body?.asignadoNombre || '').trim() || null,
         String(req.body?.fechaLimite || '').trim() || null, taskId]
      );
      const [u] = await query('SELECT * FROM svc_project_tasks WHERE id = ?', [taskId]);
      res.json(mapTask(u));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.post('/:id/tareas/:taskId/estado', guard.requirePerm('servicios.editar'), async (req, res) => {
    const id = Number(req.params.id); const taskId = Number(req.params.taskId);
    const nuevo = String(req.body?.estado || '').toLowerCase();
    try {
      if (!TAREA_ESTADOS.includes(nuevo)) throw httpError('Estado no válido.');
      const [t] = await query('SELECT * FROM svc_project_tasks WHERE id = ? AND project_id = ?', [taskId, id]);
      if (!t) throw httpError('Tarea no encontrada.', 404);
      await query(
        `UPDATE svc_project_tasks SET estado=?, done_at=${nuevo === 'hecha' ? "datetime('now')" : 'NULL'} WHERE id=?`,
        [nuevo, taskId]
      );
      await recalcAvance(id);
      res.json(await fullProject(id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.delete('/:id/tareas/:taskId', guard.requirePerm('servicios.editar'), async (req, res) => {
    const id = Number(req.params.id); const taskId = Number(req.params.taskId);
    try {
      await query('DELETE FROM svc_project_tasks WHERE id = ? AND project_id = ?', [taskId, id]);
      await recalcAvance(id);
      res.json({ ok: true });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ── Gastos del proyecto ──────────────────────────────────────────────────
  router.post('/:id/gastos', guard.requirePerm('servicios.editar', 'servicios.crear'), async (req, res) => {
    const actor = req.authUser; const id = Number(req.params.id);
    try {
      const descripcion = String(req.body?.descripcion || '').trim();
      const monto = Number(req.body?.monto || 0);
      if (!descripcion) throw httpError('Describe el gasto.');
      if (!(monto > 0)) throw httpError('El monto debe ser mayor a 0.');
      const r = await query(
        `INSERT INTO svc_project_expenses (project_id, descripcion, categoria, monto, fecha, created_by_user_id, created_by_user_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, descripcion, String(req.body?.categoria || '').trim() || null, monto,
         String(req.body?.fecha || '').trim() || new Date().toISOString().slice(0, 10), actor.id, actorName(actor)]
      );
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Proyectos', actionName: 'Gasto de proyecto',
        detail: `#${id} · ${descripcion} · RD$ ${monto.toFixed(2)}`, documentType: 'proyecto', amount: monto,
      });
      const [e] = await query('SELECT * FROM svc_project_expenses WHERE id = ?', [r.insertId]);
      res.status(201).json(mapExp(e));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.delete('/:id/gastos/:expId', guard.requirePerm('servicios.editar'), async (req, res) => {
    try {
      await query('DELETE FROM svc_project_expenses WHERE id = ? AND project_id = ?', [Number(req.params.expId), Number(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  return router;
}

module.exports = { createProyectosRouter, ESTADOS, TAREA_ESTADOS };
