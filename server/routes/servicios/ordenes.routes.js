'use strict';

/**
 * ordenes.routes.js — Órdenes de servicio / trabajo.
 * Aplica a Limpieza, Mantenimiento, Tecnología (soporte), etc.
 *
 *  GET    /api/servicios/ordenes?estado=&clientId=&branchId=&tipo=&responsableId=
 *  POST   /api/servicios/ordenes
 *  GET    /api/servicios/ordenes/:id
 *  PUT    /api/servicios/ordenes/:id
 *  POST   /api/servicios/ordenes/:id/estado    { estado, observaciones? }
 *  POST   /api/servicios/ordenes/:id/asignar   { asignados:[{employeeId,employeeName,rol}] }
 *  DELETE /api/servicios/ordenes/:id
 */

const express = require('express');
const { httpError, roleCodeOf, actorName, makeServiceGuard, resolveBranch } = require('./_common');

const ESTADOS = ['pendiente', 'asignada', 'en_proceso', 'completada', 'cancelada'];
const TIPOS = ['servicio', 'soporte', 'mantenimiento', 'instalacion', 'trabajo'];
const PRIORIDADES = ['baja', 'normal', 'alta', 'urgente'];

function mapOrder(r, asignados = []) {
  return {
    id: r.id, numero: r.numero,
    clientId: r.client_id || null, clientName: r.client_name || '',
    branchId: r.branch_id || null, sucursal: r.branch_name || '',
    contractId: r.contract_id || null,
    titulo: r.titulo, descripcion: r.descripcion || '',
    tipo: r.tipo, estado: r.estado, prioridad: r.prioridad || 'normal',
    responsableId: r.responsable_id || null, responsable: r.responsable_nombre || '',
    fechaProgramada: r.fecha_programada || null, hora: r.hora || '',
    ubicacion: r.ubicacion || '', materiales: r.materiales || '',
    observaciones: r.observaciones || '', evidencias: r.evidencias || '',
    firmaCliente: r.firma_cliente || '',
    completadaAt: r.completada_at || null, invoiceId: r.invoice_id || null,
    creadoPor: r.created_by_user_name || '', createdAt: r.created_at,
    asignados: asignados.map((a) => ({ id: a.id, employeeId: a.employee_id, employeeName: a.employee_name, rol: a.rol || '' })),
  };
}

function createOrdenesRouter(deps) {
  const {
    query, writeAuditLog, ensureSchema, nextServiceDocNumber, withTransaction,
    isGlobalAdministratorUser, getUserScopeBranchId,
  } = deps;
  const guard = makeServiceGuard(deps);
  const router = express.Router();
  router.use(guard.requireService());
  router.use(async (_q, _s, next) => { try { await ensureSchema(query); next(); } catch (e) { next(e); } });

  async function fetchFull(id) {
    const [row] = await query(
      `SELECT o.*, b.nombre AS branch_name FROM svc_work_orders o
       LEFT JOIN branches b ON b.id = o.branch_id WHERE o.id = ?`, [id]
    );
    if (!row) return null;
    const asg = await query('SELECT * FROM svc_work_order_assignees WHERE order_id = ? ORDER BY id', [id]);
    return mapOrder(row, asg);
  }

  async function readBody(body) {
    const titulo = String(body?.titulo || '').trim();
    if (!titulo) throw httpError('El título de la orden es obligatorio.');
    let clientId = body?.clientId ? Number(body.clientId) : null;
    let clientName = String(body?.clientName || '').trim() || null;
    if (clientId) {
      const [cli] = await query('SELECT nombre FROM clients WHERE id = ? LIMIT 1', [clientId]);
      if (cli) clientName = cli.nombre; else clientId = null;
    }
    return {
      titulo, clientId, clientName,
      contractId: body?.contractId ? Number(body.contractId) : null,
      descripcion: String(body?.descripcion || '').trim() || null,
      tipo: TIPOS.includes(body?.tipo) ? body.tipo : 'servicio',
      prioridad: PRIORIDADES.includes(body?.prioridad) ? body.prioridad : 'normal',
      responsableId: body?.responsableId ? Number(body.responsableId) : null,
      responsableNombre: String(body?.responsableNombre || '').trim() || null,
      fechaProgramada: String(body?.fechaProgramada || '').trim() || null,
      hora: String(body?.hora || '').trim() || null,
      ubicacion: String(body?.ubicacion || '').trim() || null,
      materiales: String(body?.materiales || '').trim() || null,
      observaciones: String(body?.observaciones || '').trim() || null,
    };
  }

  router.get('/', async (req, res) => {
    try {
      const scope = resolveBranch(req.authUser, req.query.branchId, deps);
      const cond = []; const params = [];
      if (scope) { cond.push('o.branch_id = ?'); params.push(scope); }
      if (req.query.estado) { cond.push('o.estado = ?'); params.push(String(req.query.estado)); }
      if (req.query.tipo) { cond.push('o.tipo = ?'); params.push(String(req.query.tipo)); }
      if (req.query.clientId) { cond.push('o.client_id = ?'); params.push(Number(req.query.clientId)); }
      if (req.query.responsableId) { cond.push('o.responsable_id = ?'); params.push(Number(req.query.responsableId)); }
      const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const rows = await query(
        `SELECT o.*, b.nombre AS branch_name FROM svc_work_orders o
         LEFT JOIN branches b ON b.id = o.branch_id ${where}
         ORDER BY (o.estado IN ('completada','cancelada')), COALESCE(o.fecha_programada, o.created_at) DESC
         LIMIT 500`, params
      );
      res.json(rows.map((r) => mapOrder(r)));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.get('/:id', async (req, res) => {
    try {
      const full = await fetchFull(Number(req.params.id));
      if (!full) return res.status(404).json({ error: 'Orden no encontrada.' });
      res.json(full);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.post('/', guard.requirePerm('servicios.crear'), async (req, res) => {
    const actor = req.authUser;
    try {
      const p = await readBody(req.body);
      const branchId = resolveBranch(actor, req.body?.branchId, deps) || (req.body?.branchId ? Number(req.body.branchId) : null);
      const estado = p.responsableId ? 'asignada' : 'pendiente';
      const saved = await withTransaction(async (conn) => {
        const numero = await nextServiceDocNumber(conn, 'workorder');
        const r = await conn.query(
          `INSERT INTO svc_work_orders
            (numero, client_id, client_name, branch_id, contract_id, titulo, descripcion, tipo, estado, prioridad,
             responsable_id, responsable_nombre, fecha_programada, hora, ubicacion, materiales, observaciones,
             created_by_user_id, created_by_user_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [numero, p.clientId, p.clientName, branchId, p.contractId, p.titulo, p.descripcion, p.tipo, estado, p.prioridad,
           p.responsableId, p.responsableNombre, p.fechaProgramada, p.hora, p.ubicacion, p.materiales, p.observaciones,
           actor.id, actorName(actor)]
        );
        return { id: r.insertId, numero };
      });
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Órdenes de servicio', actionName: 'Orden creada',
        detail: `${saved.numero} · ${p.titulo}`, branchId, clientId: p.clientId,
        documentType: 'orden', documentRef: saved.numero,
      });
      res.status(201).json(await fetchFull(saved.id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.put('/:id', guard.requirePerm('servicios.crear', 'servicios.editar'), async (req, res) => {
    const actor = req.authUser; const id = Number(req.params.id);
    try {
      const [cur] = await query('SELECT * FROM svc_work_orders WHERE id = ?', [id]);
      if (!cur) throw httpError('Orden no encontrada.', 404);
      const p = await readBody(req.body);
      await query(
        `UPDATE svc_work_orders SET client_id=?, client_name=?, contract_id=?, titulo=?, descripcion=?, tipo=?, prioridad=?,
           responsable_id=?, responsable_nombre=?, fecha_programada=?, hora=?, ubicacion=?, materiales=?, observaciones=?,
           updated_at=datetime('now') WHERE id=?`,
        [p.clientId, p.clientName, p.contractId, p.titulo, p.descripcion, p.tipo, p.prioridad,
         p.responsableId, p.responsableNombre, p.fechaProgramada, p.hora, p.ubicacion, p.materiales, p.observaciones, id]
      );
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Órdenes de servicio', actionName: 'Orden editada', detail: cur.numero,
        branchId: cur.branch_id, clientId: p.clientId, documentType: 'orden', documentRef: cur.numero,
      });
      res.json(await fetchFull(id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.post('/:id/estado', guard.requirePerm('servicios.editar'), async (req, res) => {
    const actor = req.authUser; const id = Number(req.params.id);
    const nuevo = String(req.body?.estado || '').toLowerCase();
    try {
      if (!ESTADOS.includes(nuevo)) throw httpError('Estado no válido.');
      const [cur] = await query('SELECT * FROM svc_work_orders WHERE id = ?', [id]);
      if (!cur) throw httpError('Orden no encontrada.', 404);
      const obs = String(req.body?.observaciones || '').trim();
      await query(
        `UPDATE svc_work_orders SET estado=?, observaciones=COALESCE(NULLIF(?, ''), observaciones),
           completada_at=${nuevo === 'completada' ? "datetime('now')" : 'completada_at'}, updated_at=datetime('now') WHERE id=?`,
        [nuevo, obs, id]
      );
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Órdenes de servicio', actionName: `Orden ${nuevo}`, detail: cur.numero,
        branchId: cur.branch_id, clientId: cur.client_id, documentType: 'orden', documentRef: cur.numero,
      });
      res.json(await fetchFull(id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.post('/:id/asignar', guard.requirePerm('servicios.editar'), async (req, res) => {
    const actor = req.authUser; const id = Number(req.params.id);
    try {
      const [cur] = await query('SELECT * FROM svc_work_orders WHERE id = ?', [id]);
      if (!cur) throw httpError('Orden no encontrada.', 404);
      const asignados = Array.isArray(req.body?.asignados) ? req.body.asignados : [];
      await withTransaction(async (conn) => {
        await conn.query('DELETE FROM svc_work_order_assignees WHERE order_id = ?', [id]);
        for (const a of asignados) {
          const nombre = String(a.employeeName || '').trim();
          if (!nombre) continue;
          await conn.query(
            'INSERT INTO svc_work_order_assignees (order_id, employee_id, employee_name, rol) VALUES (?, ?, ?, ?)',
            [id, a.employeeId ? Number(a.employeeId) : null, nombre, String(a.rol || '').trim() || null]
          );
        }
        const primary = asignados[0];
        if (primary) {
          await conn.query(
            `UPDATE svc_work_orders SET responsable_id=?, responsable_nombre=?,
               estado=CASE WHEN estado='pendiente' THEN 'asignada' ELSE estado END, updated_at=datetime('now') WHERE id=?`,
            [primary.employeeId ? Number(primary.employeeId) : null, String(primary.employeeName || '').trim() || null, id]
          );
        }
      });
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Órdenes de servicio', actionName: 'Orden asignada',
        detail: `${cur.numero} → ${asignados.map((a) => a.employeeName).join(', ')}`,
        branchId: cur.branch_id, clientId: cur.client_id, documentType: 'orden', documentRef: cur.numero,
      });
      res.json(await fetchFull(id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.delete('/:id', guard.requirePerm('servicios.anular', 'servicios.editar'), async (req, res) => {
    const actor = req.authUser; const id = Number(req.params.id);
    try {
      const [cur] = await query('SELECT * FROM svc_work_orders WHERE id = ?', [id]);
      if (!cur) throw httpError('Orden no encontrada.', 404);
      await query('DELETE FROM svc_work_orders WHERE id = ?', [id]);
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Órdenes de servicio', actionName: 'Orden eliminada', detail: cur.numero,
      });
      res.json({ ok: true });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  return router;
}

module.exports = { createOrdenesRouter, ESTADOS, TIPOS, PRIORIDADES };
