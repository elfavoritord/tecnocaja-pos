'use strict';

/**
 * contador.routes.js — Panel del Contador Asociado
 * Solo accesible con role_code = 'contador_asociado'
 *
 * GET  /api/contador/perfil
 * PUT  /api/contador/perfil
 * GET  /api/contador/dashboard
 * GET  /api/contador/clientes
 * POST /api/contador/clientes/registrar
 * GET  /api/contador/solicitudes
 * POST /api/contador/solicitudes
 */

const express = require('express');
const crypto  = require('crypto');

function createContadorRouter({ query, resolveRequestActorUser }) {
  const router = express.Router();

  async function requireContador(req, res, next) {
    try {
      const user = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: false });
      const rc = user.role_code || user.roleCode || '';
      if (!user || rc !== 'contador_asociado') {
        return res.status(403).json({ error: 'Solo contadores asociados pueden acceder a este panel.' });
      }
      const [cont] = await query('SELECT * FROM contadores WHERE user_id=? LIMIT 1', [user.id]);
      if (!cont) return res.status(404).json({ error: 'Perfil de contador no encontrado. Contacta al SuperAdmin.' });
      req.authUser = user;
      req.contador = cont;
      next();
    } catch {
      res.status(401).json({ error: 'Sesión inválida o expirada.' });
    }
  }

  // ── Perfil ─────────────────────────────────────────────────────────────────

  router.get('/perfil', requireContador, async (req, res) => {
    const { user_id: _, ...contData } = req.contador;
    res.json({ ...contData, usuario: req.authUser.usuario, email: req.authUser.email });
  });

  router.put('/perfil', requireContador, async (req, res) => {
    const { nombre_firma, responsable, rnc, telefono, whatsapp, correo, direccion, logo_url, datos_fiscales } = req.body;
    const id = req.contador.id;
    try {
      await query(`
        UPDATE contadores SET nombre_firma=?, responsable=?, rnc=?, telefono=?, whatsapp=?, correo=?, direccion=?, logo_url=?,
          datos_fiscales=?, updated_at=NOW()
        WHERE id=?
      `, [nombre_firma, responsable || null, rnc || null, telefono || null, whatsapp || null, correo || null,
          direccion || null, logo_url || null,
          datos_fiscales ? JSON.stringify(datos_fiscales) : null, id]);

      if (correo) await query('UPDATE users SET email=? WHERE id=?', [correo, req.authUser.id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Dashboard ──────────────────────────────────────────────────────────────

  router.get('/dashboard', requireContador, async (req, res) => {
    const cid = req.contador.id;
    try {
      const [[{ total }], statusCounts, expiring, recent] = await Promise.all([
        query('SELECT COUNT(*) AS total FROM cloud_businesses WHERE contador_id=?', [cid]),
        query('SELECT license_status, COUNT(*) AS cnt FROM cloud_businesses WHERE contador_id=? GROUP BY license_status', [cid]),
        query(`
          SELECT * FROM cloud_businesses WHERE contador_id=?
            AND license_status IN ('trial','active')
            AND (
              (license_status = 'trial' AND trial_end_date < DATE_ADD(NOW(), INTERVAL 7 DAY) AND trial_end_date IS NOT NULL)
              OR (license_status = 'active' AND license_expires_at < DATE_ADD(NOW(), INTERVAL 30 DAY) AND license_expires_at IS NOT NULL)
            )
          ORDER BY COALESCE(trial_end_date, license_expires_at) ASC LIMIT 10
        `, [cid]),
        query('SELECT * FROM cloud_businesses WHERE contador_id=? ORDER BY created_at DESC LIMIT 8', [cid])
      ]);

      const lm = {};
      statusCounts.forEach(r => { lm[r.license_status] = Number(r.cnt); });

      res.json({
        totales: {
          clientes: Number(total),
          activos: lm.active || 0,
          prueba: lm.trial || 0,
          vencidos: (lm.expired || 0) + (lm.cancelled || 0),
          pendientes: lm.pending || 0
        },
        proximosVencimientos: expiring,
        recientes: recent
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Clientes ───────────────────────────────────────────────────────────────

  router.get('/clientes', requireContador, async (req, res) => {
    const cid = req.contador.id;
    try {
      const rows = await query(`
        SELECT cb.*,
          DATEDIFF(COALESCE(cb.trial_end_date, cb.license_expires_at), NOW()) AS dias_restantes
        FROM cloud_businesses cb
        WHERE cb.contador_id=?
        ORDER BY cb.created_at DESC
      `, [cid]);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/clientes/registrar', requireContador, async (req, res) => {
    const cid = req.contador.id;
    const { nombre_negocio, rnc, propietario, telefono, correo, plan } = req.body;
    if (!nombre_negocio) return res.status(400).json({ error: 'El nombre del negocio es requerido.' });

    try {
      const cloudId = crypto.randomBytes(16).toString('hex');
      const trialStart = new Date();
      const trialEnd = new Date(Date.now() + 30 * 86400000);

      const { insertId } = await query(`
        INSERT INTO cloud_businesses
          (cloud_id, nombre_negocio, rnc, propietario, telefono, correo, contador_id, plan, license_status, trial_start_date, trial_end_date, business_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'trial', ?, ?, 'accountant_client')
      `, [cloudId, nombre_negocio, rnc || null, propietario || null, telefono || null, correo || null, cid, plan || 'basico', trialStart, trialEnd]);

      await query(`
        INSERT INTO licencias (cloud_business_id, plan, status, activated_at, activated_by, notes)
        VALUES (?, ?, 'trial', NOW(), ?, 'Prueba automática 30 días')
      `, [insertId, plan || 'basico', req.contador.nombre_firma]);

      await query(`
        INSERT INTO solicitudes (cloud_business_id, contador_id, tipo, status, descripcion)
        VALUES (?, ?, 'activar_licencia', 'pendiente', ?)
      `, [insertId, cid, `Nuevo cliente registrado por ${req.contador.nombre_firma}: ${nombre_negocio}. Prueba de 30 días activa.`]);

      const [created] = await query('SELECT * FROM cloud_businesses WHERE id=?', [insertId]);
      res.status(201).json({ ok: true, negocio: created });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Solicitudes ────────────────────────────────────────────────────────────

  router.get('/solicitudes', requireContador, async (req, res) => {
    const cid = req.contador.id;
    try {
      const rows = await query(`
        SELECT s.*, cb.nombre_negocio
        FROM solicitudes s
        LEFT JOIN cloud_businesses cb ON cb.id = s.cloud_business_id
        WHERE s.contador_id=?
        ORDER BY s.created_at DESC LIMIT 100
      `, [cid]);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/solicitudes', requireContador, async (req, res) => {
    const cid = req.contador.id;
    const { cloud_business_id, tipo, descripcion } = req.body;
    const TIPOS = ['activar_licencia', 'renovar_licencia', 'soporte', 'cambio_plan', 'reportar_error', 'solicitar_modulo', 'facturacion_electronica'];
    if (!TIPOS.includes(tipo)) return res.status(400).json({ error: 'Tipo de solicitud inválido.' });

    try {
      const { insertId } = await query(`
        INSERT INTO solicitudes (cloud_business_id, contador_id, tipo, status, descripcion)
        VALUES (?, ?, ?, 'pendiente', ?)
      `, [cloud_business_id || null, cid, tipo, descripcion || null]);
      res.status(201).json({ ok: true, id: insertId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createContadorRouter;
