'use strict';

/**
 * platform.routes.js — Endpoints públicos de plataforma
 * Usados en la pantalla de inicio y al completar el wizard
 *
 * GET  /api/platform/contadores/buscar?q=term
 * POST /api/platform/registrar-negocio
 * GET  /api/platform/mi-negocio           — estado del negocio actual
 */

const express = require('express');
const crypto  = require('crypto');

function createPlatformRouter({ query }) {
  const router = express.Router();

  // Buscar contadores (sin autenticación — se usa en el wizard)
  router.get('/contadores/buscar', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q || q.length < 2) return res.json([]);
    try {
      const like = `%${q}%`;
      const rows = await query(`
        SELECT id, nombre_firma, responsable, rnc, telefono, correo, logo_url
        FROM contadores WHERE estado = 'activo'
          AND (nombre_firma LIKE ? OR rnc LIKE ? OR correo LIKE ? OR telefono LIKE ?)
        LIMIT 20
      `, [like, like, like, like]);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Registrar/actualizar negocio en la plataforma (llamado al completar wizard)
  router.post('/registrar-negocio', async (req, res) => {
    const { nombre_negocio, rnc, propietario, telefono, correo, contador_id, business_mode, plan } = req.body;
    if (!nombre_negocio) return res.status(400).json({ error: 'nombre_negocio es requerido.' });

    try {
      const isAccountantClient = business_mode === 'accountant_client' && contador_id;
      const trialStart = isAccountantClient ? new Date() : null;
      const trialEnd   = isAccountantClient ? new Date(Date.now() + 30 * 86400000) : null;
      const licStatus  = isAccountantClient ? 'trial' : 'pending';

      // Si ya hay un cloud_business_id en config, actualizar ese registro
      const [configRow] = await query('SELECT cloud_business_id FROM config WHERE id=1');
      const existingCloudId = configRow?.cloud_business_id;

      if (existingCloudId) {
        await query(`
          UPDATE cloud_businesses SET nombre_negocio=?, rnc=?, propietario=?, telefono=?, correo=?,
            contador_id=COALESCE(?, contador_id), business_mode=?, last_sync_at=NOW(), updated_at=NOW()
          WHERE cloud_id=?
        `, [nombre_negocio, rnc || null, propietario || null, telefono || null, correo || null,
            contador_id || null, business_mode || 'independent', existingCloudId]);

        if (contador_id) {
          const [cont] = await query('SELECT nombre_firma FROM contadores WHERE id=?', [contador_id]);
          await query('UPDATE config SET business_mode=?, accountant_id=?, accountant_name=? WHERE id=1',
            [business_mode, contador_id, cont?.nombre_firma || null]);
        }

        return res.json({ ok: true, cloudId: existingCloudId, new: false });
      }

      // Crear nuevo cloud business
      const cloudId = crypto.randomBytes(16).toString('hex');

      const { insertId } = await query(`
        INSERT INTO cloud_businesses
          (cloud_id, nombre_negocio, rnc, propietario, telefono, correo, contador_id, plan, license_status, trial_start_date, trial_end_date, business_mode, last_sync_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
      `, [cloudId, nombre_negocio, rnc || null, propietario || null, telefono || null, correo || null,
          isAccountantClient ? Number(contador_id) : null,
          plan || 'basico', licStatus, trialStart, trialEnd,
          business_mode || 'independent']);

      // Registrar en historial de licencias si trial
      if (isAccountantClient) {
        await query(`
          INSERT INTO licencias (cloud_business_id, plan, status, activated_at, activated_by, notes)
          VALUES (?, ?, 'trial', NOW(), 'sistema', 'Prueba automática 30 días — contador asociado')
        `, [insertId, plan || 'basico']);

        const [cont] = await query('SELECT nombre_firma FROM contadores WHERE id=?', [contador_id]);

        await query(`
          INSERT INTO solicitudes (cloud_business_id, contador_id, tipo, status, descripcion)
          VALUES (?, ?, 'activar_licencia', 'pendiente', ?)
        `, [insertId, contador_id, `Nuevo negocio bajo contador ${cont?.nombre_firma || ''}: ${nombre_negocio}. Prueba 30 días activa.`]);

        await query('UPDATE config SET business_mode=?, accountant_id=?, accountant_name=?, cloud_business_id=? WHERE id=1',
          [business_mode, contador_id, cont?.nombre_firma || null, cloudId]);
      } else {
        await query('UPDATE config SET business_mode=?, cloud_business_id=? WHERE id=1',
          [business_mode || 'independent', cloudId]);
      }

      res.json({ ok: true, cloudId, new: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Estado del negocio actual (para la UI post-setup)
  router.get('/mi-negocio', async (req, res) => {
    try {
      const [cfg] = await query('SELECT business_mode, cloud_business_id, accountant_id, accountant_name FROM config WHERE id=1');
      if (!cfg?.cloud_business_id) return res.json({ registrado: false });

      const [biz] = await query(`
        SELECT cb.*, c.nombre_firma AS contador_nombre, c.telefono AS contador_telefono, c.correo AS contador_correo
        FROM cloud_businesses cb
        LEFT JOIN contadores c ON c.id = cb.contador_id
        WHERE cb.cloud_id=?
      `, [cfg.cloud_business_id]);

      res.json({ registrado: true, negocio: biz || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createPlatformRouter;
