'use strict';

/**
 * catalogo.routes.js — Catálogo de servicios del modo Empresas de Servicios.
 * Orientado a SERVICIOS (no productos): código, precio, ITBIS, unidad, duración.
 *
 *  GET    /api/servicios/catalogo/categorias
 *  POST   /api/servicios/catalogo/categorias
 *  GET    /api/servicios/catalogo?buscar=&categoriaId=&activo=
 *  POST   /api/servicios/catalogo
 *  GET    /api/servicios/catalogo/:id
 *  PUT    /api/servicios/catalogo/:id
 *  DELETE /api/servicios/catalogo/:id            (baja lógica: activo = 0)
 */

const express = require('express');
const { httpError, roleCodeOf, actorName, makeServiceGuard } = require('./_common');

function mapService(row) {
  return {
    id: row.id,
    codigo: row.codigo || '',
    nombre: row.nombre,
    descripcion: row.descripcion || '',
    categoriaId: row.categoria_id || null,
    categoria: row.categoria_nombre || '',
    precio: Number(row.precio || 0),
    itbisPct: Number(row.itbis_pct || 0),
    unidad: row.unidad || 'servicio',
    duracionMin: row.duracion_min != null ? Number(row.duracion_min) : null,
    activo: Boolean(row.activo),
    createdAt: row.created_at,
    updatedAt: row.updated_at || null,
  };
}

function createCatalogoRouter(deps) {
  const { query, writeAuditLog, ensureSchema } = deps;
  const guard = makeServiceGuard(deps);
  const router = express.Router();

  router.use(guard.requireService());
  router.use(async (_req, _res, next) => {
    try { await ensureSchema(query); next(); } catch (e) { next(e); }
  });

  // ── Categorías ───────────────────────────────────────────────────────────
  router.get('/categorias', async (_req, res) => {
    const rows = await query('SELECT * FROM svc_service_categories ORDER BY nombre');
    res.json(rows.map((r) => ({ id: r.id, nombre: r.nombre })));
  });

  router.post('/categorias', guard.requirePerm('servicios.crear'), async (req, res) => {
    try {
      const nombre = String(req.body?.nombre || '').trim();
      if (!nombre) throw httpError('Escribe el nombre de la categoría.');
      const existing = await query('SELECT id FROM svc_service_categories WHERE LOWER(nombre) = LOWER(?) LIMIT 1', [nombre]);
      if (existing[0]) return res.status(200).json({ id: existing[0].id, nombre });
      const r = await query('INSERT INTO svc_service_categories (nombre) VALUES (?)', [nombre]);
      res.status(201).json({ id: r.insertId, nombre });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Servicios ────────────────────────────────────────────────────────────
  router.get('/', async (req, res) => {
    try {
      const cond = [];
      const params = [];
      if (req.query.categoriaId) { cond.push('s.categoria_id = ?'); params.push(Number(req.query.categoriaId)); }
      if (req.query.activo === '1' || req.query.activo === '0') { cond.push('s.activo = ?'); params.push(Number(req.query.activo)); }
      if (req.query.buscar) {
        cond.push('(s.nombre LIKE ? OR s.codigo LIKE ? OR s.descripcion LIKE ?)');
        const like = `%${String(req.query.buscar).trim()}%`;
        params.push(like, like, like);
      }
      const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const rows = await query(
        `SELECT s.*, c.nombre AS categoria_nombre
         FROM svc_services s LEFT JOIN svc_service_categories c ON c.id = s.categoria_id
         ${where} ORDER BY s.activo DESC, s.nombre LIMIT 1000`,
        params
      );
      res.json(rows.map(mapService));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  router.get('/:id', async (req, res) => {
    const [row] = await query(
      `SELECT s.*, c.nombre AS categoria_nombre
       FROM svc_services s LEFT JOIN svc_service_categories c ON c.id = s.categoria_id
       WHERE s.id = ?`, [Number(req.params.id)]
    );
    if (!row) return res.status(404).json({ error: 'Servicio no encontrado.' });
    res.json(mapService(row));
  });

  function readServicePayload(body) {
    const nombre = String(body?.nombre || '').trim();
    if (!nombre) throw httpError('El nombre del servicio es obligatorio.');
    const precio = Math.max(0, Number(body?.precio || 0));
    const itbisPct = Math.max(0, Number(body?.itbisPct ?? 0));
    const unidad = String(body?.unidad || 'servicio').trim() || 'servicio';
    const duracion = body?.duracionMin != null && body.duracionMin !== '' ? Math.max(0, Number(body.duracionMin)) : null;
    const categoriaId = body?.categoriaId ? Number(body.categoriaId) : null;
    return {
      codigo: String(body?.codigo || '').trim() || null,
      nombre,
      descripcion: String(body?.descripcion || '').trim() || null,
      categoriaId,
      precio,
      itbisPct,
      unidad,
      duracion,
      activo: body?.activo === false || body?.activo === 0 ? 0 : 1,
    };
  }

  router.post('/', guard.requirePerm('servicios.crear'), async (req, res) => {
    const actor = req.authUser;
    try {
      const p = readServicePayload(req.body);
      const r = await query(
        `INSERT INTO svc_services (codigo, nombre, descripcion, categoria_id, precio, itbis_pct, unidad, duracion_min, activo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [p.codigo, p.nombre, p.descripcion, p.categoriaId, p.precio, p.itbisPct, p.unidad, p.duracion, p.activo]
      );
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Servicios', actionName: 'Servicio creado', detail: `${p.nombre} · RD$ ${p.precio.toFixed(2)}`,
      });
      const [row] = await query(
        `SELECT s.*, c.nombre AS categoria_nombre FROM svc_services s
         LEFT JOIN svc_service_categories c ON c.id = s.categoria_id WHERE s.id = ?`, [r.insertId]
      );
      res.status(201).json(mapService(row));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  router.put('/:id', guard.requirePerm('servicios.crear', 'servicios.editar'), async (req, res) => {
    const actor = req.authUser;
    const id = Number(req.params.id);
    try {
      const [cur] = await query('SELECT id FROM svc_services WHERE id = ?', [id]);
      if (!cur) throw httpError('Servicio no encontrado.', 404);
      const p = readServicePayload(req.body);
      await query(
        `UPDATE svc_services SET codigo=?, nombre=?, descripcion=?, categoria_id=?, precio=?, itbis_pct=?,
           unidad=?, duracion_min=?, activo=?, updated_at=datetime('now') WHERE id=?`,
        [p.codigo, p.nombre, p.descripcion, p.categoriaId, p.precio, p.itbisPct, p.unidad, p.duracion, p.activo, id]
      );
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Servicios', actionName: 'Servicio editado', detail: `${p.nombre} (#${id})`,
      });
      const [row] = await query(
        `SELECT s.*, c.nombre AS categoria_nombre FROM svc_services s
         LEFT JOIN svc_service_categories c ON c.id = s.categoria_id WHERE s.id = ?`, [id]
      );
      res.json(mapService(row));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  router.delete('/:id', guard.requirePerm('servicios.editar', 'servicios.anular'), async (req, res) => {
    const actor = req.authUser;
    const id = Number(req.params.id);
    try {
      const r = await query(`UPDATE svc_services SET activo = 0, updated_at = datetime('now') WHERE id = ?`, [id]);
      if (!r.affectedRows) throw httpError('Servicio no encontrado.', 404);
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Servicios', actionName: 'Servicio desactivado', detail: `Servicio #${id}`,
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createCatalogoRouter, mapService };
