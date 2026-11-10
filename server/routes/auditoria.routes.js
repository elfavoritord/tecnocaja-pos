'use strict';
// /api/auditoria — consulta de la auditoría global (mejora 5). Solo lectura:
// desde la aplicación la auditoría es append-only (una corrección es otro
// evento). Alcance: el administrador general (o permiso auditoria_global) ve
// todo el negocio; un administrador de sucursal, solo su sucursal.
const express = require('express');

// Eventos que se consideran críticos para el filtro "solo críticos".
const PATRON_CRITICO = /cancel|anul|nota de cr[eé]dito|devoluci|cierre|arqueo|restaur|respaldo|permiso|rol|usuario|contrase|licencia|descuento|elimin|borr|precio|gaveta|retiro|reset|e-cf|ecf|dgii|ncf|l[ií]mite|cr[eé]dito/i;
const RESULTADOS_CRITICOS = ['denegado', 'fallido', 'error', 'diferencia', 'rechazado'];

// RD no tiene horario de verano: UTC−4 todo el año. Los eventos nuevos se
// guardan en UTC; los viejos, en la hora que tenía el motor.
function rangoUtc(desde, hasta) {
  const inicio = new Date(`${desde}T00:00:00-04:00`).toISOString().slice(0, 19).replace('T', ' ');
  const fin = new Date(`${hasta}T23:59:59-04:00`).toISOString().slice(0, 19).replace('T', ' ');
  return [inicio, fin];
}

function createAuditoriaRouter({ query, resolveRequestActorUser, ensureAuditTable, mapAuditRow, userCanAccessGlobalAudit, isBranchAdministratorUser, getUserScopeBranchId }) {
  const router = express.Router();

  async function alcance(req) {
    const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: false });
    if (userCanAccessGlobalAudit(actorUser)) return { actorUser, branchId: null };
    if (isBranchAdministratorUser(actorUser)) return { actorUser, branchId: Number(getUserScopeBranchId(actorUser) || 0) || -1 };
    throw Object.assign(new Error('La auditoría solo está disponible para administradores.'), { statusCode: 403 });
  }

  function construirFiltro(q, branchScope) {
    const where = [], params = [];
    const desde = String(q.desde || ''), hasta = String(q.hasta || '');
    if (desde || hasta) {
      if (![desde, hasta].every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) || desde > hasta) throw Object.assign(new Error('Período no válido.'), { statusCode: 400 });
      const [ui, uf] = rangoUtc(desde, hasta);
      where.push('((a.event_id IS NOT NULL AND a.created_at BETWEEN ? AND ?) OR (a.event_id IS NULL AND a.created_at BETWEEN ? AND ?))');
      params.push(ui, uf, `${desde} 00:00:00`, `${hasta} 23:59:59`);
    }
    const branchId = branchScope || Number(q.branchId || 0);
    if (branchId) { where.push('a.branch_id = ?'); params.push(branchId); }
    for (const [campo, columna] of [['userId', 'a.user_id'], ['cashRegisterId', 'a.cash_register_id'], ['clientId', 'a.client_id'], ['cashSessionId', 'a.cash_session_id']]) {
      if (Number(q[campo])) { where.push(`${columna} = ?`); params.push(Number(q[campo])); }
    }
    if (String(q.modulo || '').trim()) { where.push('a.module_name = ?'); params.push(String(q.modulo).trim().slice(0, 120)); }
    if (String(q.resultado || '').trim()) { where.push('a.result = ?'); params.push(String(q.resultado).trim().slice(0, 30)); }
    if (String(q.usuario || '').trim()) { where.push('LOWER(a.user_name) LIKE ?'); params.push(`%${String(q.usuario).trim().toLowerCase().slice(0, 80)}%`); }
    if (String(q.documento || '').trim()) {
      const doc = `%${String(q.documento).trim().slice(0, 80)}%`;
      where.push('(a.document_ref LIKE ? OR a.detail LIKE ?)'); params.push(doc, doc);
    }
    if (String(q.texto || '').trim()) {
      const t = `%${String(q.texto).trim().toLowerCase().slice(0, 120)}%`;
      where.push('(LOWER(a.action_name) LIKE ? OR LOWER(a.detail) LIKE ? OR LOWER(COALESCE(a.reason, \'\')) LIKE ?)'); params.push(t, t, t);
    }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  const esCritico = (row) => RESULTADOS_CRITICOS.includes(String(row.result || '')) || PATRON_CRITICO.test(`${row.module_name} ${row.action_name}`);

  router.get('/', async (req, res) => {
    const { branchId } = await alcance(req);
    await ensureAuditTable();
    const { sql, params } = construirFiltro(req.query, branchId);
    const pageSize = Math.min(500, Math.max(10, Number(req.query.pageSize || 100)));
    const page = Math.max(1, Number(req.query.page || 1));
    const soloCriticos = String(req.query.criticos || '') === '1';
    // Los críticos se filtran después de leer (el patrón no es SQL portable):
    // se lee un bloque mayor y se pagina sobre el resultado.
    const limite = soloCriticos ? 5000 : pageSize;
    const offset = soloCriticos ? 0 : (page - 1) * pageSize;
    const rows = await query(`SELECT a.* FROM audit_logs a ${sql} ORDER BY a.id DESC LIMIT ${limite} OFFSET ${offset}`, params);
    let total;
    let lista = rows;
    if (soloCriticos) {
      const criticos = rows.filter(esCritico);
      total = criticos.length;
      lista = criticos.slice((page - 1) * pageSize, page * pageSize);
    } else {
      total = Number((await query(`SELECT COUNT(*) AS total FROM audit_logs a ${sql}`, params))[0]?.total || 0);
    }
    const modulos = await query(`SELECT DISTINCT module_name FROM audit_logs ORDER BY module_name`).catch(() => []);
    res.json({
      page, pageSize, total, paginas: Math.max(1, Math.ceil(total / pageSize)),
      modulos: modulos.map((m) => m.module_name).filter(Boolean),
      eventos: lista.map((row) => ({ ...mapAuditRow(row), critico: esCritico(row), clienteId: row.client_id || null, documento: row.document_type || '', monto: row.amount === null || row.amount === undefined ? null : Number(row.amount), metodoPago: row.payment_method || '' })),
    });
  });

  router.get('/:id', async (req, res) => {
    const { branchId } = await alcance(req);
    await ensureAuditTable();
    const id = String(req.params.id || '');
    const [row] = /^\d+$/.test(id)
      ? await query('SELECT * FROM audit_logs WHERE id = ? LIMIT 1', [Number(id)])
      : await query('SELECT * FROM audit_logs WHERE event_id = ? LIMIT 1', [id.slice(0, 100)]);
    if (!row) return res.status(404).json({ error: 'Evento no encontrado.' });
    if (branchId && Number(row.branch_id || 0) !== branchId) return res.status(403).json({ error: 'Ese evento es de otra sucursal.' });
    res.json({ ...mapAuditRow(row), critico: esCritico(row), clienteId: row.client_id || null, documento: row.document_type || '', monto: row.amount === null || row.amount === undefined ? null : Number(row.amount), metodoPago: row.payment_method || '' });
  });

  return router;
}

// Intentos denegados y logins fallidos (sin cuerpo de la petición: nunca se
// guardan contraseñas, tokens ni PIN). Se escribe al terminar la respuesta,
// fuera del camino del cobro.
const RUTAS_RUIDOSAS = /^\/api\/(connectivity|system|setup\/status|network|offline\/status|notifications)/;
function createAuditDeniedMiddleware({ writeAuditLog }) {
  return function auditDenied(req, res, next) {
    res.on('finish', () => {
      const status = res.statusCode;
      if (status !== 401 && status !== 403) return;
      const ruta = String(req.originalUrl || req.url || '').split('?')[0];
      if (!ruta.startsWith('/api/') || RUTAS_RUIDOSAS.test(ruta)) return;
      const esLogin = ruta === '/api/login' || ruta.startsWith('/api/login/');
      if (!esLogin && req.method === 'GET' && !/audit|auditoria|reports|caja|clients\/.+\/statement/.test(ruta)) return;
      const user = req.authUser || null;
      const intento = esLogin ? String(req.body?.usuario || req.body?.email || '').trim().slice(0, 80) : '';
      writeAuditLog({
        userId: user?.id || null, userName: user?.nombre || user?.usuario || intento || 'Desconocido', userRole: user?.role_name || user?.rol || 'Sin sesión',
        moduleName: esLogin ? 'Seguridad' : (ruta.split('/')[2] || 'Sistema'), actionName: esLogin ? 'Inicio de sesión fallido' : 'Acceso denegado',
        result: 'denegado', detail: `${req.method} ${ruta} · HTTP ${status}`.slice(0, 400),
      }).catch(() => {});
    });
    next();
  };
}

module.exports = { createAuditoriaRouter, createAuditDeniedMiddleware, PATRON_CRITICO };
