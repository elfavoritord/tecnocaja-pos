'use strict';

/**
 * verticales.routes.js — Módulos especializados por tipo de empresa (M3):
 *   /seguridad      puestos + turnos + incidencias        (Empresa de Seguridad)
 *   /mantenimiento  equipos + planes + historial          (Empresa de Mantenimiento)
 *   /viajes         reservaciones + items + viajeros + comisiones (Agencia de Viajes)
 *   /campanas       campañas + gastos de campaña          (Agencia de Publicidad)
 *   /obras          obras + avances + materiales          (Arquitectura e Ingeniería)
 *
 * Cada uno es un router factory que recibe `deps` del aggregator (index.js).
 */

const express = require('express');
const { httpError, roleCodeOf, actorName, round2, makeServiceGuard, resolveBranch } = require('./_common');

// Resuelve nombre de cliente desde clientId (opcional).
async function withClient(query, body) {
  let clientId = body?.clientId ? Number(body.clientId) : null;
  let clientName = String(body?.clientName || '').trim() || null;
  if (clientId) {
    const [cli] = await query('SELECT nombre FROM clients WHERE id = ? LIMIT 1', [clientId]);
    if (cli) clientName = cli.nombre; else clientId = null;
  }
  return { clientId, clientName };
}

const S = (v) => (String(v ?? '').trim() || null);
const N = (v) => Math.max(0, Number(v || 0));

// ═══════════════════════════════════════════════════════════════════════════
// SEGURIDAD
// ═══════════════════════════════════════════════════════════════════════════
function createSeguridadRouter(deps) {
  const { query, writeAuditLog, ensureSchema, nextServiceDocNumber, withTransaction } = deps;
  const guard = makeServiceGuard(deps);
  const r = express.Router();
  r.use(guard.requireService());
  r.use(async (_q, _s, n) => { try { await ensureSchema(query); n(); } catch (e) { n(e); } });

  const mapPost = (p, shifts = [], incs = []) => ({
    id: p.id, numero: p.numero, contractId: p.contract_id || null,
    clientId: p.client_id || null, clientName: p.client_name || '',
    branchId: p.branch_id || null, sucursal: p.branch_name || '',
    nombre: p.nombre, ubicacion: p.ubicacion || '', tipo: p.tipo || 'fijo',
    turnosPorDia: Number(p.turnos_por_dia || 1), guardiasRequeridos: Number(p.guardias_requeridos || 1),
    tarifaMensual: Number(p.tarifa_mensual || 0), estado: p.estado, notas: p.notas || '',
    createdAt: p.created_at,
    turnos: shifts.map((s) => ({ id: s.id, employeeId: s.employee_id, empleado: s.employee_name, fecha: s.fecha, turno: s.turno, horaInicio: s.hora_inicio || '', horaFin: s.hora_fin || '', estado: s.estado, notas: s.notas || '' })),
    incidencias: incs.map((i) => ({ id: i.id, fecha: i.fecha, hora: i.hora || '', tipo: i.tipo || '', gravedad: i.gravedad, descripcion: i.descripcion, reportadoPor: i.reportado_por || '', acciones: i.acciones || '' })),
  });

  async function full(id) {
    const [p] = await query(`SELECT p.*, b.nombre AS branch_name FROM svc_security_posts p LEFT JOIN branches b ON b.id=p.branch_id WHERE p.id=?`, [id]);
    if (!p) return null;
    const [shifts, incs] = await Promise.all([
      query('SELECT * FROM svc_guard_shifts WHERE post_id=? ORDER BY fecha DESC, id DESC LIMIT 200', [id]),
      query('SELECT * FROM svc_security_incidents WHERE post_id=? ORDER BY fecha DESC, id DESC LIMIT 200', [id]),
    ]);
    return mapPost(p, shifts, incs);
  }

  r.get('/puestos', async (req, res) => {
    try {
      const scope = resolveBranch(req.authUser, req.query.branchId, deps);
      const cond = []; const params = [];
      if (scope) { cond.push('p.branch_id=?'); params.push(scope); }
      if (req.query.estado) { cond.push('p.estado=?'); params.push(String(req.query.estado)); }
      if (req.query.clientId) { cond.push('p.client_id=?'); params.push(Number(req.query.clientId)); }
      const w = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const rows = await query(`SELECT p.*, b.nombre AS branch_name FROM svc_security_posts p LEFT JOIN branches b ON b.id=p.branch_id ${w} ORDER BY p.created_at DESC LIMIT 500`, params);
      res.json(rows.map((x) => mapPost(x)));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  r.get('/puestos/:id', async (req, res) => {
    try { const f = await full(Number(req.params.id)); if (!f) return res.status(404).json({ error: 'Puesto no encontrado.' }); res.json(f); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  r.post('/puestos', guard.requirePerm('servicios.crear'), async (req, res) => {
    const actor = req.authUser; const b = req.body || {};
    try {
      const nombre = S(b.nombre); if (!nombre) throw httpError('El nombre del puesto es obligatorio.');
      const { clientId, clientName } = await withClient(query, b);
      const branchId = resolveBranch(actor, b.branchId, deps) || (b.branchId ? Number(b.branchId) : null);
      const saved = await withTransaction(async (conn) => {
        const numero = await nextServiceDocNumber(conn, 'post');
        const ins = await conn.query(
          `INSERT INTO svc_security_posts (numero, contract_id, client_id, client_name, branch_id, nombre, ubicacion, tipo,
             turnos_por_dia, guardias_requeridos, tarifa_mensual, estado, notas, created_by_user_id, created_by_user_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'activo', ?, ?, ?)`,
          [numero, b.contractId ? Number(b.contractId) : null, clientId, clientName, branchId, nombre, S(b.ubicacion),
           ['fijo', 'movil'].includes(b.tipo) ? b.tipo : 'fijo', Math.max(1, Number(b.turnosPorDia || 1)),
           Math.max(1, Number(b.guardiasRequeridos || 1)), N(b.tarifaMensual), S(b.notas), actor.id, actorName(actor)]
        );
        return { id: ins.insertId, numero };
      });
      await writeAuditLog({ userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor), moduleName: 'Seguridad', actionName: 'Puesto creado', detail: `${saved.numero} · ${nombre}`, branchId, clientId, documentType: 'puesto', documentRef: saved.numero });
      res.status(201).json(await full(saved.id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  r.put('/puestos/:id', guard.requirePerm('servicios.editar', 'servicios.crear'), async (req, res) => {
    const id = Number(req.params.id); const b = req.body || {};
    try {
      const [cur] = await query('SELECT * FROM svc_security_posts WHERE id=?', [id]);
      if (!cur) throw httpError('Puesto no encontrado.', 404);
      const { clientId, clientName } = await withClient(query, b);
      await query(
        `UPDATE svc_security_posts SET client_id=?, client_name=?, nombre=?, ubicacion=?, tipo=?, turnos_por_dia=?,
           guardias_requeridos=?, tarifa_mensual=?, estado=?, notas=?, updated_at=datetime('now') WHERE id=?`,
        [clientId, clientName, S(b.nombre) || cur.nombre, S(b.ubicacion), ['fijo', 'movil'].includes(b.tipo) ? b.tipo : cur.tipo,
         Math.max(1, Number(b.turnosPorDia || cur.turnos_por_dia)), Math.max(1, Number(b.guardiasRequeridos || cur.guardias_requeridos)),
         N(b.tarifaMensual), ['activo', 'suspendido', 'cerrado'].includes(b.estado) ? b.estado : cur.estado, S(b.notas), id]
      );
      res.json(await full(id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  r.delete('/puestos/:id', guard.requirePerm('servicios.anular', 'servicios.editar'), async (req, res) => {
    try { await query('DELETE FROM svc_security_posts WHERE id=?', [Number(req.params.id)]); res.json({ ok: true }); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // Turnos de guardia
  r.post('/puestos/:id/turnos', guard.requirePerm('servicios.editar', 'servicios.crear'), async (req, res) => {
    const id = Number(req.params.id); const b = req.body || {};
    try {
      const nombre = S(b.employeeName); if (!nombre) throw httpError('Indica el guardia.');
      if (!S(b.fecha)) throw httpError('Indica la fecha.');
      const ins = await query(
        `INSERT INTO svc_guard_shifts (post_id, employee_id, employee_name, fecha, turno, hora_inicio, hora_fin, estado, notas)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'programado', ?)`,
        [id, b.employeeId ? Number(b.employeeId) : null, nombre, b.fecha,
         ['diurno', 'nocturno', 'rotativo'].includes(b.turno) ? b.turno : 'diurno', S(b.horaInicio), S(b.horaFin), S(b.notas)]
      );
      const [row] = await query('SELECT * FROM svc_guard_shifts WHERE id=?', [ins.insertId]);
      res.status(201).json(row);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.post('/turnos/:shiftId/estado', guard.requirePerm('servicios.editar'), async (req, res) => {
    try {
      const est = String(req.body?.estado || '').toLowerCase();
      if (!['programado', 'cumplido', 'ausente', 'relevo'].includes(est)) throw httpError('Estado no válido.');
      await query('UPDATE svc_guard_shifts SET estado=? WHERE id=?', [est, Number(req.params.shiftId)]);
      res.json({ ok: true });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.delete('/turnos/:shiftId', guard.requirePerm('servicios.editar'), async (req, res) => {
    try { await query('DELETE FROM svc_guard_shifts WHERE id=?', [Number(req.params.shiftId)]); res.json({ ok: true }); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // Incidencias
  r.post('/puestos/:id/incidencias', guard.requirePerm('servicios.editar', 'servicios.crear'), async (req, res) => {
    const actor = req.authUser; const id = Number(req.params.id); const b = req.body || {};
    try {
      if (!S(b.descripcion)) throw httpError('Describe la incidencia.');
      const ins = await query(
        `INSERT INTO svc_security_incidents (post_id, client_id, fecha, hora, tipo, gravedad, descripcion, reportado_por, acciones, created_by_user_id, created_by_user_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, b.clientId ? Number(b.clientId) : null, S(b.fecha) || new Date().toISOString().slice(0, 10), S(b.hora),
         S(b.tipo), ['baja', 'media', 'alta', 'critica'].includes(b.gravedad) ? b.gravedad : 'media', S(b.descripcion),
         S(b.reportadoPor) || actorName(actor), S(b.acciones), actor.id, actorName(actor)]
      );
      await writeAuditLog({ userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor), moduleName: 'Seguridad', actionName: 'Incidencia reportada', detail: `Puesto #${id} · ${S(b.tipo) || 'incidencia'}`, documentType: 'incidencia' });
      const [row] = await query('SELECT * FROM svc_security_incidents WHERE id=?', [ins.insertId]);
      res.status(201).json(row);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.delete('/incidencias/:incId', guard.requirePerm('servicios.editar'), async (req, res) => {
    try { await query('DELETE FROM svc_security_incidents WHERE id=?', [Number(req.params.incId)]); res.json({ ok: true }); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  return r;
}

// ═══════════════════════════════════════════════════════════════════════════
// MANTENIMIENTO
// ═══════════════════════════════════════════════════════════════════════════
function createMantenimientoRouter(deps) {
  const { query, writeAuditLog, ensureSchema } = deps;
  const guard = makeServiceGuard(deps);
  const r = express.Router();
  r.use(guard.requireService());
  r.use(async (_q, _s, n) => { try { await ensureSchema(query); n(); } catch (e) { n(e); } });

  const mapEq = (e, planes = [], hist = []) => ({
    id: e.id, clientId: e.client_id || null, clientName: e.client_name || '',
    branchId: e.branch_id || null, sucursal: e.branch_name || '',
    nombre: e.nombre, tipo: e.tipo || '', marca: e.marca || '', modelo: e.modelo || '', serie: e.serie || '',
    ubicacion: e.ubicacion || '', estado: e.estado, ultimaRevision: e.ultima_revision || null,
    proximaRevision: e.proxima_revision || null, notas: e.notas || '', createdAt: e.created_at,
    planes: planes.map((p) => ({ id: p.id, titulo: p.titulo, tipo: p.tipo, frecuencia: p.frecuencia, proximaFecha: p.proxima_fecha || null, responsable: p.responsable_nombre || '', estado: p.estado, checklist: p.checklist || '' })),
    historial: hist.map((h) => ({ id: h.id, fecha: h.fecha, tipo: h.tipo, descripcion: h.descripcion, tecnico: h.tecnico || '', materiales: h.materiales || '', costo: Number(h.costo || 0) })),
  });

  async function full(id) {
    const [e] = await query(`SELECT e.*, b.nombre AS branch_name FROM svc_equipment e LEFT JOIN branches b ON b.id=e.branch_id WHERE e.id=?`, [id]);
    if (!e) return null;
    const [planes, hist] = await Promise.all([
      query('SELECT * FROM svc_maintenance_plans WHERE equipment_id=? ORDER BY id', [id]),
      query('SELECT * FROM svc_equipment_history WHERE equipment_id=? ORDER BY fecha DESC, id DESC LIMIT 200', [id]),
    ]);
    return mapEq(e, planes, hist);
  }

  r.get('/equipos', async (req, res) => {
    try {
      const scope = resolveBranch(req.authUser, req.query.branchId, deps);
      const cond = []; const params = [];
      if (scope) { cond.push('e.branch_id=?'); params.push(scope); }
      if (req.query.clientId) { cond.push('e.client_id=?'); params.push(Number(req.query.clientId)); }
      if (req.query.estado) { cond.push('e.estado=?'); params.push(String(req.query.estado)); }
      const w = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const rows = await query(`SELECT e.*, b.nombre AS branch_name FROM svc_equipment e LEFT JOIN branches b ON b.id=e.branch_id ${w} ORDER BY e.nombre LIMIT 500`, params);
      res.json(rows.map((x) => mapEq(x)));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.get('/equipos/:id', async (req, res) => {
    try { const f = await full(Number(req.params.id)); if (!f) return res.status(404).json({ error: 'Equipo no encontrado.' }); res.json(f); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.post('/equipos', guard.requirePerm('servicios.crear'), async (req, res) => {
    const actor = req.authUser; const b = req.body || {};
    try {
      if (!S(b.nombre)) throw httpError('El nombre del equipo es obligatorio.');
      const { clientId, clientName } = await withClient(query, b);
      const branchId = resolveBranch(actor, b.branchId, deps) || (b.branchId ? Number(b.branchId) : null);
      const ins = await query(
        `INSERT INTO svc_equipment (client_id, client_name, branch_id, nombre, tipo, marca, modelo, serie, ubicacion, estado,
           ultima_revision, proxima_revision, notas, created_by_user_id, created_by_user_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [clientId, clientName, branchId, S(b.nombre), S(b.tipo), S(b.marca), S(b.modelo), S(b.serie), S(b.ubicacion),
         ['operativo', 'en_reparacion', 'fuera_servicio'].includes(b.estado) ? b.estado : 'operativo',
         S(b.ultimaRevision), S(b.proximaRevision), S(b.notas), actor.id, actorName(actor)]
      );
      await writeAuditLog({ userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor), moduleName: 'Mantenimiento', actionName: 'Equipo registrado', detail: S(b.nombre), branchId, clientId, documentType: 'equipo' });
      res.status(201).json(await full(ins.insertId));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.put('/equipos/:id', guard.requirePerm('servicios.editar', 'servicios.crear'), async (req, res) => {
    const id = Number(req.params.id); const b = req.body || {};
    try {
      const [cur] = await query('SELECT * FROM svc_equipment WHERE id=?', [id]);
      if (!cur) throw httpError('Equipo no encontrado.', 404);
      const { clientId, clientName } = await withClient(query, b);
      await query(
        `UPDATE svc_equipment SET client_id=?, client_name=?, nombre=?, tipo=?, marca=?, modelo=?, serie=?, ubicacion=?, estado=?,
           ultima_revision=?, proxima_revision=?, notas=?, updated_at=datetime('now') WHERE id=?`,
        [clientId, clientName, S(b.nombre) || cur.nombre, S(b.tipo), S(b.marca), S(b.modelo), S(b.serie), S(b.ubicacion),
         ['operativo', 'en_reparacion', 'fuera_servicio'].includes(b.estado) ? b.estado : cur.estado,
         S(b.ultimaRevision), S(b.proximaRevision), S(b.notas), id]
      );
      res.json(await full(id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.delete('/equipos/:id', guard.requirePerm('servicios.anular', 'servicios.editar'), async (req, res) => {
    try { await query('DELETE FROM svc_equipment WHERE id=?', [Number(req.params.id)]); res.json({ ok: true }); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  r.post('/equipos/:id/planes', guard.requirePerm('servicios.editar', 'servicios.crear'), async (req, res) => {
    const id = Number(req.params.id); const b = req.body || {};
    try {
      if (!S(b.titulo)) throw httpError('Indica el título del plan.');
      const ins = await query(
        `INSERT INTO svc_maintenance_plans (equipment_id, client_id, titulo, tipo, frecuencia, proxima_fecha, checklist, responsable_id, responsable_nombre, estado, notas)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'activo', ?)`,
        [id, b.clientId ? Number(b.clientId) : null, S(b.titulo),
         ['preventivo', 'correctivo'].includes(b.tipo) ? b.tipo : 'preventivo',
         ['semanal', 'quincenal', 'mensual', 'trimestral', 'semestral', 'anual'].includes(b.frecuencia) ? b.frecuencia : 'mensual',
         S(b.proximaFecha), S(b.checklist), b.responsableId ? Number(b.responsableId) : null, S(b.responsableNombre), S(b.notas)]
      );
      const [row] = await query('SELECT * FROM svc_maintenance_plans WHERE id=?', [ins.insertId]);
      res.status(201).json(row);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.delete('/planes/:planId', guard.requirePerm('servicios.editar'), async (req, res) => {
    try { await query('DELETE FROM svc_maintenance_plans WHERE id=?', [Number(req.params.planId)]); res.json({ ok: true }); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  r.post('/equipos/:id/historial', guard.requirePerm('servicios.editar', 'servicios.crear'), async (req, res) => {
    const actor = req.authUser; const id = Number(req.params.id); const b = req.body || {};
    try {
      if (!S(b.descripcion)) throw httpError('Describe la intervención.');
      const ins = await query(
        `INSERT INTO svc_equipment_history (equipment_id, fecha, tipo, descripcion, work_order_id, tecnico, materiales, costo, created_by_user_id, created_by_user_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, S(b.fecha) || new Date().toISOString().slice(0, 10),
         ['preventivo', 'correctivo', 'inspeccion'].includes(b.tipo) ? b.tipo : 'preventivo', S(b.descripcion),
         b.workOrderId ? Number(b.workOrderId) : null, S(b.tecnico), S(b.materiales), N(b.costo), actor.id, actorName(actor)]
      );
      await query(`UPDATE svc_equipment SET ultima_revision=?, updated_at=datetime('now') WHERE id=?`, [S(b.fecha) || new Date().toISOString().slice(0, 10), id]);
      await writeAuditLog({ userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor), moduleName: 'Mantenimiento', actionName: 'Intervención registrada', detail: `Equipo #${id} · ${S(b.tipo)}`, amount: N(b.costo), documentType: 'mantenimiento' });
      const [row] = await query('SELECT * FROM svc_equipment_history WHERE id=?', [ins.insertId]);
      res.status(201).json(row);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  return r;
}

// ═══════════════════════════════════════════════════════════════════════════
// VIAJES
// ═══════════════════════════════════════════════════════════════════════════
function createViajesRouter(deps) {
  const { query, writeAuditLog, ensureSchema, nextServiceDocNumber, withTransaction } = deps;
  const guard = makeServiceGuard(deps);
  const r = express.Router();
  r.use(guard.requireService());
  r.use(async (_q, _s, n) => { try { await ensureSchema(query); n(); } catch (e) { n(e); } });

  function recalc(res) {
    const total = Number(res.total || 0);
    const anticipo = Number(res.anticipo || 0);
    return { saldo: round2(total - anticipo) };
  }
  const mapRes = (x, items = [], trav = [], com = []) => ({
    id: x.id, numero: x.numero, clientId: x.client_id || null, clientName: x.client_name || '',
    branchId: x.branch_id || null, sucursal: x.branch_name || '',
    titulo: x.titulo, destino: x.destino || '', fechaSalida: x.fecha_salida || null, fechaRegreso: x.fecha_regreso || null,
    estado: x.estado, costo: Number(x.costo || 0), total: Number(x.total || 0), anticipo: Number(x.anticipo || 0), saldo: Number(x.saldo || 0),
    proveedorPrincipal: x.proveedor_principal || '', notas: x.notas || '', invoiceId: x.invoice_id || null, createdAt: x.created_at,
    items: items.map((i) => ({ id: i.id, tipo: i.tipo, descripcion: i.descripcion, proveedor: i.proveedor || '', fechaInicio: i.fecha_inicio || null, fechaFin: i.fecha_fin || null, costo: Number(i.costo || 0), precio: Number(i.precio || 0), confirmacion: i.confirmacion || '' })),
    viajeros: trav.map((t) => ({ id: t.id, travelerId: t.traveler_id, nombre: t.traveler_name })),
    comisiones: com.map((c) => ({ id: c.id, descripcion: c.descripcion, base: Number(c.base || 0), pct: Number(c.pct || 0), monto: Number(c.monto || 0), estado: c.estado, fecha: c.fecha || null })),
  });

  async function full(id) {
    const [x] = await query(`SELECT r.*, b.nombre AS branch_name FROM svc_reservations r LEFT JOIN branches b ON b.id=r.branch_id WHERE r.id=?`, [id]);
    if (!x) return null;
    const [items, trav, com] = await Promise.all([
      query('SELECT * FROM svc_reservation_items WHERE reservation_id=? ORDER BY fecha_inicio, id', [id]),
      query('SELECT * FROM svc_reservation_travelers WHERE reservation_id=? ORDER BY id', [id]),
      query('SELECT * FROM svc_commissions WHERE reservation_id=? ORDER BY id', [id]),
    ]);
    return mapRes(x, items, trav, com);
  }

  // Viajeros (catálogo)
  r.get('/viajeros', async (req, res) => {
    try {
      const cond = []; const params = [];
      if (req.query.clientId) { cond.push('client_id=?'); params.push(Number(req.query.clientId)); }
      if (req.query.buscar) { cond.push('(nombre LIKE ? OR documento_numero LIKE ?)'); const l = `%${req.query.buscar}%`; params.push(l, l); }
      const w = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const rows = await query(`SELECT * FROM svc_travelers ${w} ORDER BY nombre LIMIT 500`, params);
      res.json(rows.map((t) => ({ id: t.id, clientId: t.client_id, nombre: t.nombre, documentoTipo: t.documento_tipo, documentoNumero: t.documento_numero || '', nacionalidad: t.nacionalidad || '', telefono: t.telefono || '', email: t.email || '' })));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.post('/viajeros', guard.requirePerm('servicios.crear', 'servicios.editar'), async (req, res) => {
    const b = req.body || {};
    try {
      if (!S(b.nombre)) throw httpError('El nombre del viajero es obligatorio.');
      const ins = await query(
        `INSERT INTO svc_travelers (client_id, nombre, documento_tipo, documento_numero, nacionalidad, fecha_nacimiento, telefono, email, notas)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [b.clientId ? Number(b.clientId) : null, S(b.nombre),
         ['pasaporte', 'cedula', 'otro'].includes(b.documentoTipo) ? b.documentoTipo : 'pasaporte',
         S(b.documentoNumero), S(b.nacionalidad), S(b.fechaNacimiento), S(b.telefono), S(b.email), S(b.notas)]
      );
      const [row] = await query('SELECT * FROM svc_travelers WHERE id=?', [ins.insertId]);
      res.status(201).json(row);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // Reservaciones
  r.get('/reservaciones', async (req, res) => {
    try {
      const scope = resolveBranch(req.authUser, req.query.branchId, deps);
      const cond = []; const params = [];
      if (scope) { cond.push('r.branch_id=?'); params.push(scope); }
      if (req.query.estado) { cond.push('r.estado=?'); params.push(String(req.query.estado)); }
      if (req.query.clientId) { cond.push('r.client_id=?'); params.push(Number(req.query.clientId)); }
      const w = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const rows = await query(`SELECT r.*, b.nombre AS branch_name FROM svc_reservations r LEFT JOIN branches b ON b.id=r.branch_id ${w} ORDER BY r.created_at DESC LIMIT 500`, params);
      res.json(rows.map((x) => mapRes(x)));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.get('/reservaciones/:id', async (req, res) => {
    try { const f = await full(Number(req.params.id)); if (!f) return res.status(404).json({ error: 'Reservación no encontrada.' }); res.json(f); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.post('/reservaciones', guard.requirePerm('servicios.crear'), async (req, res) => {
    const actor = req.authUser; const b = req.body || {};
    try {
      if (!S(b.titulo)) throw httpError('El título de la reservación es obligatorio.');
      const { clientId, clientName } = await withClient(query, b);
      const branchId = resolveBranch(actor, b.branchId, deps) || (b.branchId ? Number(b.branchId) : null);
      const total = N(b.total); const anticipo = N(b.anticipo);
      const saved = await withTransaction(async (conn) => {
        const numero = await nextServiceDocNumber(conn, 'reservation');
        const ins = await conn.query(
          `INSERT INTO svc_reservations (numero, client_id, client_name, branch_id, titulo, destino, fecha_salida, fecha_regreso,
             estado, costo, total, anticipo, saldo, proveedor_principal, notas, created_by_user_id, created_by_user_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'cotizada', ?, ?, ?, ?, ?, ?, ?, ?)`,
          [numero, clientId, clientName, branchId, S(b.titulo), S(b.destino), S(b.fechaSalida), S(b.fechaRegreso),
           N(b.costo), total, anticipo, round2(total - anticipo), S(b.proveedorPrincipal), S(b.notas), actor.id, actorName(actor)]
        );
        return { id: ins.insertId, numero };
      });
      await writeAuditLog({ userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor), moduleName: 'Reservaciones', actionName: 'Reservación creada', detail: `${saved.numero} · ${S(b.titulo)}`, branchId, clientId, documentType: 'reservacion', documentRef: saved.numero, amount: total });
      res.status(201).json(await full(saved.id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.put('/reservaciones/:id', guard.requirePerm('servicios.editar', 'servicios.crear'), async (req, res) => {
    const id = Number(req.params.id); const b = req.body || {};
    try {
      const [cur] = await query('SELECT * FROM svc_reservations WHERE id=?', [id]);
      if (!cur) throw httpError('Reservación no encontrada.', 404);
      const { clientId, clientName } = await withClient(query, b);
      const total = b.total != null ? N(b.total) : Number(cur.total);
      const anticipo = b.anticipo != null ? N(b.anticipo) : Number(cur.anticipo);
      await query(
        `UPDATE svc_reservations SET client_id=?, client_name=?, titulo=?, destino=?, fecha_salida=?, fecha_regreso=?,
           costo=?, total=?, anticipo=?, saldo=?, proveedor_principal=?, notas=?, updated_at=datetime('now') WHERE id=?`,
        [clientId, clientName, S(b.titulo) || cur.titulo, S(b.destino), S(b.fechaSalida), S(b.fechaRegreso),
         b.costo != null ? N(b.costo) : Number(cur.costo), total, anticipo, round2(total - anticipo),
         S(b.proveedorPrincipal), S(b.notas), id]
      );
      res.json(await full(id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.post('/reservaciones/:id/estado', guard.requirePerm('servicios.editar'), async (req, res) => {
    const actor = req.authUser; const id = Number(req.params.id);
    const est = String(req.body?.estado || '').toLowerCase();
    try {
      if (!['cotizada', 'confirmada', 'en_curso', 'completada', 'cancelada'].includes(est)) throw httpError('Estado no válido.');
      const [cur] = await query('SELECT * FROM svc_reservations WHERE id=?', [id]);
      if (!cur) throw httpError('Reservación no encontrada.', 404);
      await query(`UPDATE svc_reservations SET estado=?, updated_at=datetime('now') WHERE id=?`, [est, id]);
      await writeAuditLog({ userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor), moduleName: 'Reservaciones', actionName: `Reservación ${est}`, detail: cur.numero, branchId: cur.branch_id, clientId: cur.client_id, documentType: 'reservacion', documentRef: cur.numero });
      res.json(await full(id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.delete('/reservaciones/:id', guard.requirePerm('servicios.anular', 'servicios.editar'), async (req, res) => {
    try { await query('DELETE FROM svc_reservations WHERE id=?', [Number(req.params.id)]); res.json({ ok: true }); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // Sub-recursos de una reservación
  r.post('/reservaciones/:id/items', guard.requirePerm('servicios.editar', 'servicios.crear'), async (req, res) => {
    const id = Number(req.params.id); const b = req.body || {};
    try {
      if (!S(b.descripcion)) throw httpError('Describe el servicio (vuelo, hotel, etc.).');
      const ins = await query(
        `INSERT INTO svc_reservation_items (reservation_id, tipo, descripcion, proveedor, fecha_inicio, fecha_fin, costo, precio, confirmacion, notas)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, ['vuelo', 'hotel', 'excursion', 'traslado', 'seguro', 'paquete', 'otro'].includes(b.tipo) ? b.tipo : 'vuelo',
         S(b.descripcion), S(b.proveedor), S(b.fechaInicio), S(b.fechaFin), N(b.costo), N(b.precio), S(b.confirmacion), S(b.notas)]
      );
      const [row] = await query('SELECT * FROM svc_reservation_items WHERE id=?', [ins.insertId]);
      res.status(201).json(row);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.delete('/items/:itemId', guard.requirePerm('servicios.editar'), async (req, res) => {
    try { await query('DELETE FROM svc_reservation_items WHERE id=?', [Number(req.params.itemId)]); res.json({ ok: true }); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.post('/reservaciones/:id/viajeros', guard.requirePerm('servicios.editar', 'servicios.crear'), async (req, res) => {
    const id = Number(req.params.id); const b = req.body || {};
    try {
      const nombre = S(b.travelerName);
      if (!nombre) throw httpError('Indica el viajero.');
      const ins = await query('INSERT INTO svc_reservation_travelers (reservation_id, traveler_id, traveler_name) VALUES (?, ?, ?)',
        [id, b.travelerId ? Number(b.travelerId) : null, nombre]);
      res.status(201).json({ id: ins.insertId, travelerId: b.travelerId || null, nombre });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.delete('/viajeros-reserva/:linkId', guard.requirePerm('servicios.editar'), async (req, res) => {
    try { await query('DELETE FROM svc_reservation_travelers WHERE id=?', [Number(req.params.linkId)]); res.json({ ok: true }); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.post('/reservaciones/:id/comisiones', guard.requirePerm('servicios.editar', 'servicios.crear'), async (req, res) => {
    const actor = req.authUser; const id = Number(req.params.id); const b = req.body || {};
    try {
      const base = N(b.base); const pct = N(b.pct);
      const monto = b.monto != null ? N(b.monto) : round2(base * pct / 100);
      const ins = await query(
        `INSERT INTO svc_commissions (reservation_id, item_id, descripcion, base, pct, monto, estado, fecha, created_by_user_id, created_by_user_name)
         VALUES (?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?)`,
        [id, b.itemId ? Number(b.itemId) : null, S(b.descripcion) || 'Comisión', base, pct, monto,
         S(b.fecha) || new Date().toISOString().slice(0, 10), actor.id, actorName(actor)]
      );
      const [row] = await query('SELECT * FROM svc_commissions WHERE id=?', [ins.insertId]);
      res.status(201).json(row);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.post('/comisiones/:comId/estado', guard.requirePerm('servicios.editar', 'servicios.cobrar'), async (req, res) => {
    try {
      const est = String(req.body?.estado || '').toLowerCase();
      if (!['pendiente', 'cobrada', 'anulada'].includes(est)) throw httpError('Estado no válido.');
      await query('UPDATE svc_commissions SET estado=? WHERE id=?', [est, Number(req.params.comId)]);
      res.json({ ok: true });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  return r;
}

// ═══════════════════════════════════════════════════════════════════════════
// CAMPAÑAS
// ═══════════════════════════════════════════════════════════════════════════
function createCampanasRouter(deps) {
  const { query, writeAuditLog, ensureSchema, nextServiceDocNumber, withTransaction } = deps;
  const guard = makeServiceGuard(deps);
  const r = express.Router();
  r.use(guard.requireService());
  r.use(async (_q, _s, n) => { try { await ensureSchema(query); n(); } catch (e) { n(e); } });

  const mapC = (c, gastos = []) => {
    const gastado = gastos.reduce((s, g) => s + Number(g.monto || 0), 0);
    return {
      id: c.id, numero: c.numero, clientId: c.client_id || null, clientName: c.client_name || '',
      branchId: c.branch_id || null, sucursal: c.branch_name || '', projectId: c.project_id || null,
      nombre: c.nombre, objetivo: c.objetivo || '', canal: c.canal || 'mixto',
      fechaInicio: c.fecha_inicio || null, fechaFin: c.fecha_fin || null,
      presupuesto: Number(c.presupuesto || 0), gastado: round2(gastado),
      disponible: round2(Number(c.presupuesto || 0) - gastado),
      estado: c.estado, notas: c.notas || '', createdAt: c.created_at,
      gastos: gastos.map((g) => ({ id: g.id, descripcion: g.descripcion, categoria: g.categoria, monto: Number(g.monto || 0), fecha: g.fecha, proveedor: g.proveedor || '' })),
    };
  };
  async function full(id) {
    const [c] = await query(`SELECT c.*, b.nombre AS branch_name FROM svc_campaigns c LEFT JOIN branches b ON b.id=c.branch_id WHERE c.id=?`, [id]);
    if (!c) return null;
    const gastos = await query('SELECT * FROM svc_campaign_expenses WHERE campaign_id=? ORDER BY fecha DESC, id DESC', [id]);
    return mapC(c, gastos);
  }

  r.get('/', async (req, res) => {
    try {
      const scope = resolveBranch(req.authUser, req.query.branchId, deps);
      const cond = []; const params = [];
      if (scope) { cond.push('c.branch_id=?'); params.push(scope); }
      if (req.query.estado) { cond.push('c.estado=?'); params.push(String(req.query.estado)); }
      if (req.query.clientId) { cond.push('c.client_id=?'); params.push(Number(req.query.clientId)); }
      const w = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const rows = await query(`SELECT c.*, b.nombre AS branch_name FROM svc_campaigns c LEFT JOIN branches b ON b.id=c.branch_id ${w} ORDER BY c.created_at DESC LIMIT 500`, params);
      res.json(rows.map((x) => mapC(x)));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.get('/:id', async (req, res) => {
    try { const f = await full(Number(req.params.id)); if (!f) return res.status(404).json({ error: 'Campaña no encontrada.' }); res.json(f); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.post('/', guard.requirePerm('servicios.crear'), async (req, res) => {
    const actor = req.authUser; const b = req.body || {};
    try {
      if (!S(b.nombre)) throw httpError('El nombre de la campaña es obligatorio.');
      const { clientId, clientName } = await withClient(query, b);
      const branchId = resolveBranch(actor, b.branchId, deps) || (b.branchId ? Number(b.branchId) : null);
      const saved = await withTransaction(async (conn) => {
        const numero = await nextServiceDocNumber(conn, 'campaign');
        const ins = await conn.query(
          `INSERT INTO svc_campaigns (numero, client_id, client_name, branch_id, project_id, nombre, objetivo, canal,
             fecha_inicio, fecha_fin, presupuesto, estado, notas, created_by_user_id, created_by_user_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planificacion', ?, ?, ?)`,
          [numero, clientId, clientName, branchId, b.projectId ? Number(b.projectId) : null, S(b.nombre), S(b.objetivo),
           ['redes', 'tv', 'radio', 'exterior', 'digital', 'mixto'].includes(b.canal) ? b.canal : 'mixto',
           S(b.fechaInicio), S(b.fechaFin), N(b.presupuesto), S(b.notas), actor.id, actorName(actor)]
        );
        return { id: ins.insertId, numero };
      });
      await writeAuditLog({ userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor), moduleName: 'Campañas', actionName: 'Campaña creada', detail: `${saved.numero} · ${S(b.nombre)}`, branchId, clientId, documentType: 'campana', documentRef: saved.numero, amount: N(b.presupuesto) });
      res.status(201).json(await full(saved.id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.put('/:id', guard.requirePerm('servicios.editar', 'servicios.crear'), async (req, res) => {
    const id = Number(req.params.id); const b = req.body || {};
    try {
      const [cur] = await query('SELECT * FROM svc_campaigns WHERE id=?', [id]);
      if (!cur) throw httpError('Campaña no encontrada.', 404);
      const { clientId, clientName } = await withClient(query, b);
      await query(
        `UPDATE svc_campaigns SET client_id=?, client_name=?, nombre=?, objetivo=?, canal=?, fecha_inicio=?, fecha_fin=?,
           presupuesto=?, estado=?, notas=?, updated_at=datetime('now') WHERE id=?`,
        [clientId, clientName, S(b.nombre) || cur.nombre, S(b.objetivo),
         ['redes', 'tv', 'radio', 'exterior', 'digital', 'mixto'].includes(b.canal) ? b.canal : cur.canal,
         S(b.fechaInicio), S(b.fechaFin), b.presupuesto != null ? N(b.presupuesto) : Number(cur.presupuesto),
         ['planificacion', 'activa', 'pausada', 'finalizada', 'cancelada'].includes(b.estado) ? b.estado : cur.estado, S(b.notas), id]
      );
      res.json(await full(id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.delete('/:id', guard.requirePerm('servicios.anular', 'servicios.editar'), async (req, res) => {
    try { await query('DELETE FROM svc_campaigns WHERE id=?', [Number(req.params.id)]); res.json({ ok: true }); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.post('/:id/gastos', guard.requirePerm('servicios.editar', 'servicios.crear'), async (req, res) => {
    const actor = req.authUser; const id = Number(req.params.id); const b = req.body || {};
    try {
      if (!S(b.descripcion)) throw httpError('Describe el gasto.');
      if (!(N(b.monto) > 0)) throw httpError('El monto debe ser mayor a 0.');
      const ins = await query(
        `INSERT INTO svc_campaign_expenses (campaign_id, descripcion, categoria, monto, fecha, proveedor, created_by_user_id, created_by_user_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, S(b.descripcion), ['pauta', 'produccion', 'creativo', 'influencers', 'otro'].includes(b.categoria) ? b.categoria : 'pauta',
         N(b.monto), S(b.fecha) || new Date().toISOString().slice(0, 10), S(b.proveedor), actor.id, actorName(actor)]
      );
      await writeAuditLog({ userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor), moduleName: 'Campañas', actionName: 'Gasto de campaña', detail: `#${id} · ${S(b.descripcion)}`, amount: N(b.monto), documentType: 'campana' });
      const [row] = await query('SELECT * FROM svc_campaign_expenses WHERE id=?', [ins.insertId]);
      res.status(201).json(row);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.delete('/gastos/:expId', guard.requirePerm('servicios.editar'), async (req, res) => {
    try { await query('DELETE FROM svc_campaign_expenses WHERE id=?', [Number(req.params.expId)]); res.json({ ok: true }); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  return r;
}

// ═══════════════════════════════════════════════════════════════════════════
// OBRAS
// ═══════════════════════════════════════════════════════════════════════════
function createObrasRouter(deps) {
  const { query, writeAuditLog, ensureSchema, nextServiceDocNumber, withTransaction } = deps;
  const guard = makeServiceGuard(deps);
  const r = express.Router();
  r.use(guard.requireService());
  r.use(async (_q, _s, n) => { try { await ensureSchema(query); n(); } catch (e) { n(e); } });

  const mapS = (s, prog = [], mats = []) => {
    const gastoMateriales = mats.reduce((a, m) => a + Number(m.costo_total || 0), 0);
    return {
      id: s.id, numero: s.numero, projectId: s.project_id || null,
      clientId: s.client_id || null, clientName: s.client_name || '',
      branchId: s.branch_id || null, sucursal: s.branch_name || '',
      nombre: s.nombre, direccion: s.direccion || '', tipo: s.tipo || 'residencial',
      fechaInicio: s.fecha_inicio || null, fechaFinEstimada: s.fecha_fin_estimada || null,
      presupuesto: Number(s.presupuesto || 0), avancePct: Number(s.avance_pct || 0), estado: s.estado,
      responsable: s.responsable_nombre || '', notas: s.notas || '', createdAt: s.created_at,
      gastoMateriales: round2(gastoMateriales),
      avances: prog.map((p) => ({ id: p.id, fecha: p.fecha, avancePct: Number(p.avance_pct || 0), descripcion: p.descripcion || '', hitos: p.hitos || '', reportadoPor: p.reportado_por || '' })),
      materiales: mats.map((m) => ({ id: m.id, descripcion: m.descripcion, cantidad: Number(m.cantidad || 0), unidad: m.unidad || '', costoUnit: Number(m.costo_unit || 0), costoTotal: Number(m.costo_total || 0), proveedor: m.proveedor || '', fecha: m.fecha })),
    };
  };
  async function full(id) {
    const [s] = await query(`SELECT s.*, b.nombre AS branch_name FROM svc_construction_sites s LEFT JOIN branches b ON b.id=s.branch_id WHERE s.id=?`, [id]);
    if (!s) return null;
    const [prog, mats] = await Promise.all([
      query('SELECT * FROM svc_site_progress WHERE site_id=? ORDER BY fecha DESC, id DESC', [id]),
      query('SELECT * FROM svc_site_materials WHERE site_id=? ORDER BY fecha DESC, id DESC', [id]),
    ]);
    return mapS(s, prog, mats);
  }

  r.get('/', async (req, res) => {
    try {
      const scope = resolveBranch(req.authUser, req.query.branchId, deps);
      const cond = []; const params = [];
      if (scope) { cond.push('s.branch_id=?'); params.push(scope); }
      if (req.query.estado) { cond.push('s.estado=?'); params.push(String(req.query.estado)); }
      if (req.query.clientId) { cond.push('s.client_id=?'); params.push(Number(req.query.clientId)); }
      const w = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const rows = await query(`SELECT s.*, b.nombre AS branch_name FROM svc_construction_sites s LEFT JOIN branches b ON b.id=s.branch_id ${w} ORDER BY s.created_at DESC LIMIT 500`, params);
      res.json(rows.map((x) => mapS(x)));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.get('/:id', async (req, res) => {
    try { const f = await full(Number(req.params.id)); if (!f) return res.status(404).json({ error: 'Obra no encontrada.' }); res.json(f); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.post('/', guard.requirePerm('servicios.crear'), async (req, res) => {
    const actor = req.authUser; const b = req.body || {};
    try {
      if (!S(b.nombre)) throw httpError('El nombre de la obra es obligatorio.');
      const { clientId, clientName } = await withClient(query, b);
      const branchId = resolveBranch(actor, b.branchId, deps) || (b.branchId ? Number(b.branchId) : null);
      const saved = await withTransaction(async (conn) => {
        const numero = await nextServiceDocNumber(conn, 'site');
        const ins = await conn.query(
          `INSERT INTO svc_construction_sites (numero, project_id, client_id, client_name, branch_id, nombre, direccion, tipo,
             fecha_inicio, fecha_fin_estimada, presupuesto, estado, responsable_id, responsable_nombre, notas, created_by_user_id, created_by_user_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'en_curso', ?, ?, ?, ?, ?)`,
          [numero, b.projectId ? Number(b.projectId) : null, clientId, clientName, branchId, S(b.nombre), S(b.direccion),
           ['residencial', 'comercial', 'industrial', 'remodelacion'].includes(b.tipo) ? b.tipo : 'residencial',
           S(b.fechaInicio), S(b.fechaFinEstimada), N(b.presupuesto),
           b.responsableId ? Number(b.responsableId) : null, S(b.responsableNombre), S(b.notas), actor.id, actorName(actor)]
        );
        return { id: ins.insertId, numero };
      });
      await writeAuditLog({ userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor), moduleName: 'Obras', actionName: 'Obra creada', detail: `${saved.numero} · ${S(b.nombre)}`, branchId, clientId, documentType: 'obra', documentRef: saved.numero, amount: N(b.presupuesto) });
      res.status(201).json(await full(saved.id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.put('/:id', guard.requirePerm('servicios.editar', 'servicios.crear'), async (req, res) => {
    const id = Number(req.params.id); const b = req.body || {};
    try {
      const [cur] = await query('SELECT * FROM svc_construction_sites WHERE id=?', [id]);
      if (!cur) throw httpError('Obra no encontrada.', 404);
      const { clientId, clientName } = await withClient(query, b);
      await query(
        `UPDATE svc_construction_sites SET client_id=?, client_name=?, nombre=?, direccion=?, tipo=?, fecha_inicio=?, fecha_fin_estimada=?,
           presupuesto=?, estado=?, responsable_id=?, responsable_nombre=?, notas=?, updated_at=datetime('now') WHERE id=?`,
        [clientId, clientName, S(b.nombre) || cur.nombre, S(b.direccion),
         ['residencial', 'comercial', 'industrial', 'remodelacion'].includes(b.tipo) ? b.tipo : cur.tipo,
         S(b.fechaInicio), S(b.fechaFinEstimada), b.presupuesto != null ? N(b.presupuesto) : Number(cur.presupuesto),
         ['en_curso', 'pausada', 'entregada', 'cancelada'].includes(b.estado) ? b.estado : cur.estado,
         b.responsableId ? Number(b.responsableId) : null, S(b.responsableNombre), S(b.notas), id]
      );
      res.json(await full(id));
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.delete('/:id', guard.requirePerm('servicios.anular', 'servicios.editar'), async (req, res) => {
    try { await query('DELETE FROM svc_construction_sites WHERE id=?', [Number(req.params.id)]); res.json({ ok: true }); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.post('/:id/avances', guard.requirePerm('servicios.editar', 'servicios.crear'), async (req, res) => {
    const actor = req.authUser; const id = Number(req.params.id); const b = req.body || {};
    try {
      const pct = Math.max(0, Math.min(100, Number(b.avancePct || 0)));
      const ins = await query(
        `INSERT INTO svc_site_progress (site_id, fecha, avance_pct, descripcion, hitos, reportado_por, created_by_user_id, created_by_user_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, S(b.fecha) || new Date().toISOString().slice(0, 10), pct, S(b.descripcion), S(b.hitos),
         S(b.reportadoPor) || actorName(actor), actor.id, actorName(actor)]
      );
      await query(`UPDATE svc_construction_sites SET avance_pct=?, updated_at=datetime('now') WHERE id=?`, [pct, id]);
      const [row] = await query('SELECT * FROM svc_site_progress WHERE id=?', [ins.insertId]);
      res.status(201).json(row);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.post('/:id/materiales', guard.requirePerm('servicios.editar', 'servicios.crear'), async (req, res) => {
    const actor = req.authUser; const id = Number(req.params.id); const b = req.body || {};
    try {
      if (!S(b.descripcion)) throw httpError('Describe el material.');
      const cantidad = Number(b.cantidad || 1); const costoUnit = N(b.costoUnit);
      const ins = await query(
        `INSERT INTO svc_site_materials (site_id, descripcion, cantidad, unidad, costo_unit, costo_total, proveedor, fecha, created_by_user_id, created_by_user_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, S(b.descripcion), cantidad, S(b.unidad), costoUnit, round2(cantidad * costoUnit), S(b.proveedor),
         S(b.fecha) || new Date().toISOString().slice(0, 10), actor.id, actorName(actor)]
      );
      const [row] = await query('SELECT * FROM svc_site_materials WHERE id=?', [ins.insertId]);
      res.status(201).json(row);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.delete('/avances/:pid', guard.requirePerm('servicios.editar'), async (req, res) => {
    try { await query('DELETE FROM svc_site_progress WHERE id=?', [Number(req.params.pid)]); res.json({ ok: true }); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  r.delete('/materiales/:mid', guard.requirePerm('servicios.editar'), async (req, res) => {
    try { await query('DELETE FROM svc_site_materials WHERE id=?', [Number(req.params.mid)]); res.json({ ok: true }); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  return r;
}

module.exports = {
  createSeguridadRouter, createMantenimientoRouter, createViajesRouter,
  createCampanasRouter, createObrasRouter,
};
