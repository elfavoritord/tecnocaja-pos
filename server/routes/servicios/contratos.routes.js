'use strict';

/**
 * contratos.routes.js — Contratos de servicios (recurrentes o por período).
 *
 *  GET    /api/servicios/contratos?estado=&clientId=&branchId=
 *  POST   /api/servicios/contratos
 *  GET    /api/servicios/contratos/:id
 *  PUT    /api/servicios/contratos/:id
 *  POST   /api/servicios/contratos/:id/estado   { estado }
 *  DELETE /api/servicios/contratos/:id
 */

const express = require('express');
const { httpError, roleCodeOf, actorName, makeServiceGuard, resolveBranch } = require('./_common');

const ESTADOS = ['activo', 'suspendido', 'vencido', 'cancelado'];
const FRECUENCIAS = ['unica', 'semanal', 'quincenal', 'mensual', 'trimestral', 'anual'];

function mapContract(r) {
  return {
    id: r.id, numero: r.numero,
    clientId: r.client_id || null, clientName: r.client_name || '',
    branchId: r.branch_id || null, sucursal: r.branch_name || '',
    titulo: r.titulo, descripcion: r.descripcion || '',
    fechaInicio: r.fecha_inicio || null, fechaFin: r.fecha_fin || null,
    monto: Number(r.monto || 0), frecuencia: r.frecuencia || 'mensual',
    estado: r.estado, notas: r.notas || '',
    creadoPor: r.created_by_user_name || '', createdAt: r.created_at,
  };
}

function createContratosRouter(deps) {
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
      `SELECT c.*, b.nombre AS branch_name FROM svc_contracts c
       LEFT JOIN branches b ON b.id = c.branch_id WHERE c.id = ?`, [id]
    );
    return row ? mapContract(row) : null;
  }

  async function readBody(body) {
    const titulo = String(body?.titulo || '').trim();
    if (!titulo) throw httpError('El título del contrato es obligatorio.');
    let clientId = body?.clientId ? Number(body.clientId) : null;
    let clientName = String(body?.clientName || '').trim() || null;
    if (clientId) {
      const [cli] = await query('SELECT nombre FROM clients WHERE id = ? LIMIT 1', [clientId]);
      if (cli) clientName = cli.nombre; else clientId = null;
    }
    return {
      titulo, clientId, clientName,
      descripcion: String(body?.descripcion || '').trim() || null,
      fechaInicio: String(body?.fechaInicio || '').trim() || null,
      fechaFin: String(body?.fechaFin || '').trim() || null,
      monto: Math.max(0, Number(body?.monto || 0)),
      frecuencia: FRECUENCIAS.includes(body?.frecuencia) ? body.frecuencia : 'mensual',
      notas: String(body?.notas || '').trim() || null,
    };
  }

  router.get('/', async (req, res) => {
    try {
      const scope = resolveBranch(req.authUser, req.query.branchId, deps);
      const cond = []; const params = [];
      if (scope) { cond.push('c.branch_id = ?'); params.push(scope); }
      if (req.query.estado) { cond.push('c.estado = ?'); params.push(String(req.query.estado)); }
      if (req.query.clientId) { cond.push('c.client_id = ?'); params.push(Number(req.query.clientId)); }
      const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const rows = await query(
        `SELECT c.*, b.nombre AS branch_name FROM svc_contracts c
         LEFT JOIN branches b ON b.id = c.branch_id ${where}
         ORDER BY c.created_at DESC LIMIT 500`, params
      );
      res.json(rows.map(mapContract));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.get('/:id', async (req, res) => {
    try {
      const full = await fetchFull(Number(req.params.id));
      if (!full) return res.status(404).json({ error: 'Contrato no encontrado.' });
      res.json(full);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.post('/', guard.requirePerm('servicios.crear'), async (req, res) => {
    const actor = req.authUser;
    try {
      const p = await readBody(req.body);
      const branchId = resolveBranch(actor, req.body?.branchId, deps) || (req.body?.branchId ? Number(req.body.branchId) : null);
      const saved = await withTransaction(async (conn) => {
        const numero = await nextServiceDocNumber(conn, 'contract');
        const r = await conn.query(
          `INSERT INTO svc_contracts
            (numero, client_id, client_name, branch_id, titulo, descripcion, fecha_inicio, fecha_fin,
             monto, frecuencia, estado, notas, created_by_user_id, created_by_user_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'activo', ?, ?, ?)`,
          [numero, p.clientId, p.clientName, branchId, p.titulo, p.descripcion, p.fechaInicio, p.fechaFin,
           p.monto, p.frecuencia, p.notas, actor.id, actorName(actor)]
        );
        return { id: r.insertId, numero };
      });
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Contratos', actionName: 'Contrato creado',
        detail: `${saved.numero} · ${p.titulo}`, branchId, clientId: p.clientId,
        documentType: 'contrato', documentRef: saved.numero, amount: p.monto,
      });
      res.status(201).json(await fetchFull(saved.id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.put('/:id', guard.requirePerm('servicios.crear', 'servicios.editar'), async (req, res) => {
    const actor = req.authUser; const id = Number(req.params.id);
    try {
      const [cur] = await query('SELECT * FROM svc_contracts WHERE id = ?', [id]);
      if (!cur) throw httpError('Contrato no encontrado.', 404);
      const p = await readBody(req.body);
      await query(
        `UPDATE svc_contracts SET client_id=?, client_name=?, titulo=?, descripcion=?, fecha_inicio=?, fecha_fin=?,
           monto=?, frecuencia=?, notas=?, updated_at=datetime('now') WHERE id=?`,
        [p.clientId, p.clientName, p.titulo, p.descripcion, p.fechaInicio, p.fechaFin, p.monto, p.frecuencia, p.notas, id]
      );
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Contratos', actionName: 'Contrato editado', detail: `${cur.numero}`,
        branchId: cur.branch_id, clientId: p.clientId, documentType: 'contrato', documentRef: cur.numero,
      });
      res.json(await fetchFull(id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.post('/:id/estado', guard.requirePerm('servicios.editar'), async (req, res) => {
    const actor = req.authUser; const id = Number(req.params.id);
    const nuevo = String(req.body?.estado || '').toLowerCase();
    try {
      if (!ESTADOS.includes(nuevo)) throw httpError('Estado no válido.');
      const [cur] = await query('SELECT * FROM svc_contracts WHERE id = ?', [id]);
      if (!cur) throw httpError('Contrato no encontrado.', 404);
      await query(`UPDATE svc_contracts SET estado=?, updated_at=datetime('now') WHERE id=?`, [nuevo, id]);
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Contratos', actionName: `Contrato ${nuevo}`, detail: cur.numero,
        branchId: cur.branch_id, clientId: cur.client_id, documentType: 'contrato', documentRef: cur.numero,
      });
      res.json(await fetchFull(id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.delete('/:id', guard.requirePerm('servicios.anular', 'servicios.editar'), async (req, res) => {
    const actor = req.authUser; const id = Number(req.params.id);
    try {
      const [cur] = await query('SELECT * FROM svc_contracts WHERE id = ?', [id]);
      if (!cur) throw httpError('Contrato no encontrado.', 404);
      await query('DELETE FROM svc_contracts WHERE id = ?', [id]);
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Contratos', actionName: 'Contrato eliminado', detail: cur.numero,
      });
      res.json({ ok: true });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  return router;
}

module.exports = { createContratosRouter, ESTADOS, FRECUENCIAS };
