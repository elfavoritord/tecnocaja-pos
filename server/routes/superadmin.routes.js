'use strict';

/**
 * superadmin.routes.js — Panel SuperAdmin de Tecno Caja
 * Solo accesible con role_code = 'superadmin'
 *
 * GET  /api/superadmin/dashboard
 * GET  /api/superadmin/contadores
 * POST /api/superadmin/contadores
 * PUT  /api/superadmin/contadores/:id
 * POST /api/superadmin/contadores/:id/suspender
 * POST /api/superadmin/contadores/:id/reactivar
 * DELETE /api/superadmin/contadores/:id
 * GET  /api/superadmin/negocios
 * POST /api/superadmin/negocios/:id/licencia
 * GET  /api/superadmin/licencias/:businessId
 * GET  /api/superadmin/solicitudes
 * PUT  /api/superadmin/solicitudes/:id
 */

const express = require('express');

function createSuperAdminRouter({ query, resolveRequestActorUser, createLocalPasswordHash }) {
  const router = express.Router();

  async function requireSuperAdmin(req, res, next) {
    try {
      const user = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: false });
      const rc = user.role_code || user.roleCode || '';
      if (!user || rc !== 'superadmin') {
        return res.status(403).json({ error: 'Solo el SuperAdmin puede acceder a este panel.' });
      }
      req.authUser = user;
      next();
    } catch {
      res.status(401).json({ error: 'Sesión inválida o expirada.' });
    }
  }

  // ── Dashboard ──────────────────────────────────────────────────────────────

  router.get('/dashboard', requireSuperAdmin, async (req, res) => {
    try {
      const [[{ total_contadores }], [{ total_negocios }], statusCounts, recent, pendingReqs] = await Promise.all([
        query(`SELECT COUNT(*) AS total_contadores FROM contadores WHERE estado = 'activo'`),
        query(`SELECT COUNT(*) AS total_negocios FROM cloud_businesses`),
        query(`SELECT license_status, COUNT(*) AS cnt FROM cloud_businesses GROUP BY license_status`),
        query(`
          SELECT cb.*, c.nombre_firma AS contador_nombre
          FROM cloud_businesses cb
          LEFT JOIN contadores c ON c.id = cb.contador_id
          ORDER BY cb.created_at DESC LIMIT 10
        `),
        query(`SELECT COUNT(*) AS cnt FROM solicitudes WHERE status = 'pendiente'`)
      ]);

      const licenseMap = {};
      statusCounts.forEach(r => { licenseMap[r.license_status] = Number(r.cnt); });

      res.json({
        totales: {
          contadores: Number(total_contadores),
          negocios: Number(total_negocios),
          activas: licenseMap.active || 0,
          prueba: licenseMap.trial || 0,
          vencidas: (licenseMap.expired || 0) + (licenseMap.cancelled || 0),
          pendientes: licenseMap.pending || 0,
          suspendidas: licenseMap.suspended || 0,
          solicitudesPendientes: Number(pendingReqs[0]?.cnt || 0)
        },
        ultimosNegocios: recent
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Contadores ─────────────────────────────────────────────────────────────

  router.get('/contadores', requireSuperAdmin, async (req, res) => {
    try {
      const rows = await query(`
        SELECT c.*, u.usuario, u.email, u.estado AS user_estado,
          (SELECT COUNT(*) FROM cloud_businesses cb WHERE cb.contador_id = c.id) AS total_clientes,
          (SELECT COUNT(*) FROM cloud_businesses cb WHERE cb.contador_id = c.id AND cb.license_status = 'active') AS clientes_activos
        FROM contadores c
        JOIN users u ON u.id = c.user_id
        ORDER BY c.created_at DESC
      `);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/contadores', requireSuperAdmin, async (req, res) => {
    const { nombre_firma, responsable, rnc, telefono, whatsapp, correo, direccion, usuario, password, logo_url } = req.body;
    if (!nombre_firma || !usuario || !password) {
      return res.status(400).json({ error: 'Nombre de firma, usuario y contraseña son requeridos.' });
    }
    try {
      const existing = await query('SELECT id FROM users WHERE usuario = ? LIMIT 1', [usuario]);
      if (existing.length) return res.status(409).json({ error: 'Ese nombre de usuario ya existe.' });

      const [roleRow] = await query(`SELECT id FROM roles WHERE codigo = 'contador_asociado' LIMIT 1`);
      const roleId = roleRow?.id || 7;
      const hash = createLocalPasswordHash(password);

      const { insertId: userId } = await query(`
        INSERT INTO users (usuario, email, password, password_hash, nombre, rol, role_id, estado, auth_provider)
        VALUES (?, ?, '', ?, ?, 'Contador Asociado', ?, 'Activo', 'local')
      `, [usuario, correo || null, hash, responsable || nombre_firma, roleId]);

      const { insertId: contId } = await query(`
        INSERT INTO contadores (user_id, nombre_firma, responsable, rnc, telefono, whatsapp, correo, direccion, logo_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [userId, nombre_firma, responsable || null, rnc || null, telefono || null, whatsapp || null, correo || null, direccion || null, logo_url || null]);

      const [created] = await query(`
        SELECT c.*, u.usuario, u.email FROM contadores c JOIN users u ON u.id = c.user_id WHERE c.id = ?
      `, [contId]);
      res.status(201).json(created);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/contadores/:id', requireSuperAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const { nombre_firma, responsable, rnc, telefono, whatsapp, correo, direccion, logo_url } = req.body;
    try {
      await query(`
        UPDATE contadores SET nombre_firma=?, responsable=?, rnc=?, telefono=?, whatsapp=?, correo=?, direccion=?, logo_url=?, updated_at=NOW()
        WHERE id=?
      `, [nombre_firma, responsable || null, rnc || null, telefono || null, whatsapp || null, correo || null, direccion || null, logo_url || null, id]);

      if (correo) {
        await query('UPDATE users SET email=? WHERE id=(SELECT user_id FROM contadores WHERE id=?)', [correo, id]);
      }

      const [updated] = await query(`SELECT c.*, u.usuario, u.email FROM contadores c JOIN users u ON u.id = c.user_id WHERE c.id=?`, [id]);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/contadores/:id/suspender', requireSuperAdmin, async (req, res) => {
    const id = Number(req.params.id);
    try {
      const [cont] = await query('SELECT user_id FROM contadores WHERE id=?', [id]);
      if (!cont) return res.status(404).json({ error: 'Contador no encontrado.' });
      await query(`UPDATE contadores SET estado='suspendido', updated_at=NOW() WHERE id=?`, [id]);
      await query(`UPDATE users SET estado='Inactivo' WHERE id=?`, [cont.user_id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/contadores/:id/reactivar', requireSuperAdmin, async (req, res) => {
    const id = Number(req.params.id);
    try {
      const [cont] = await query('SELECT user_id FROM contadores WHERE id=?', [id]);
      if (!cont) return res.status(404).json({ error: 'Contador no encontrado.' });
      await query(`UPDATE contadores SET estado='activo', updated_at=NOW() WHERE id=?`, [id]);
      await query(`UPDATE users SET estado='Activo' WHERE id=?`, [cont.user_id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/contadores/:id', requireSuperAdmin, async (req, res) => {
    const id = Number(req.params.id);
    try {
      const [cont] = await query('SELECT user_id FROM contadores WHERE id=?', [id]);
      if (!cont) return res.status(404).json({ error: 'Contador no encontrado.' });
      await query('DELETE FROM users WHERE id=?', [cont.user_id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Negocios / Cloud Businesses ────────────────────────────────────────────

  router.get('/negocios', requireSuperAdmin, async (req, res) => {
    try {
      const rows = await query(`
        SELECT cb.*,
          c.nombre_firma AS contador_nombre,
          c.responsable AS contador_responsable,
          c.telefono AS contador_telefono,
          DATEDIFF(COALESCE(cb.trial_end_date, cb.license_expires_at), NOW()) AS dias_restantes
        FROM cloud_businesses cb
        LEFT JOIN contadores c ON c.id = cb.contador_id
        ORDER BY cb.created_at DESC
      `);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/negocios/:id/licencia', requireSuperAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const { accion, plan, dias, notas } = req.body;

    const ACCIONES = ['activar', 'suspender', 'cancelar', 'renovar', 'trial', 'pendiente'];
    if (!ACCIONES.includes(accion)) {
      return res.status(400).json({ error: `Acción inválida. Opciones: ${ACCIONES.join(', ')}` });
    }

    try {
      const [biz] = await query('SELECT * FROM cloud_businesses WHERE id=?', [id]);
      if (!biz) return res.status(404).json({ error: 'Negocio no encontrado.' });

      let newStatus = biz.license_status;
      let activatedAt = null;
      let expiresAt = null;
      let trialStart = null;
      let trialEnd = null;

      if (accion === 'activar') {
        newStatus = 'active';
        activatedAt = new Date();
      } else if (accion === 'renovar') {
        newStatus = 'active';
        activatedAt = new Date();
        const d = Math.max(1, Number(dias) || 365);
        expiresAt = new Date(Date.now() + d * 86400000);
      } else if (accion === 'suspender') {
        newStatus = 'suspended';
      } else if (accion === 'cancelar') {
        newStatus = 'cancelled';
      } else if (accion === 'trial') {
        newStatus = 'trial';
        trialStart = new Date();
        trialEnd = new Date(Date.now() + 30 * 86400000);
      } else if (accion === 'pendiente') {
        newStatus = 'pending';
      }

      const newPlan = plan || biz.plan;

      await query(`
        UPDATE cloud_businesses
        SET license_status=?, plan=?,
            license_activated_at=COALESCE(?, license_activated_at),
            license_expires_at=?,
            trial_start_date=COALESCE(?, trial_start_date),
            trial_end_date=COALESCE(?, trial_end_date),
            license_notes=?, updated_at=NOW()
        WHERE id=?
      `, [newStatus, newPlan, activatedAt, expiresAt, trialStart, trialEnd, notas || biz.license_notes, id]);

      await query(`
        INSERT INTO licencias (cloud_business_id, plan, status, activated_at, expires_at, activated_by, notes)
        VALUES (?, ?, ?, NOW(), ?, ?, ?)
      `, [id, newPlan, newStatus, expiresAt, req.authUser.nombre, notas || null]);

      const [updated] = await query('SELECT * FROM cloud_businesses WHERE id=?', [id]);
      res.json({ ok: true, negocio: updated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/licencias/:businessId', requireSuperAdmin, async (req, res) => {
    const id = Number(req.params.businessId);
    try {
      const rows = await query(`
        SELECT * FROM licencias WHERE cloud_business_id=? ORDER BY created_at DESC
      `, [id]);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Solicitudes ────────────────────────────────────────────────────────────

  router.get('/solicitudes', requireSuperAdmin, async (req, res) => {
    const { status } = req.query;
    try {
      const where = status ? `WHERE s.status = ?` : '';
      const params = status ? [status] : [];
      const rows = await query(`
        SELECT s.*, cb.nombre_negocio, c.nombre_firma AS contador_nombre
        FROM solicitudes s
        LEFT JOIN cloud_businesses cb ON cb.id = s.cloud_business_id
        LEFT JOIN contadores c ON c.id = s.contador_id
        ${where}
        ORDER BY s.created_at DESC
        LIMIT 200
      `, params);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/solicitudes/:id', requireSuperAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const { status, respuesta } = req.body;
    const VALID_STATUS = ['pendiente', 'en_revision', 'aprobado', 'rechazado', 'completado'];
    if (!VALID_STATUS.includes(status)) {
      return res.status(400).json({ error: 'Estado inválido.' });
    }
    try {
      await query(`UPDATE solicitudes SET status=?, respuesta=?, updated_at=NOW() WHERE id=?`, [status, respuesta || null, id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createSuperAdminRouter;
