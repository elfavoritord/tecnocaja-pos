'use strict';

/**
 * crm.routes.js — Seguimientos, tareas y recordatorios de clientes (CRM)
 * Factory pattern con inyección de dependencias.
 *
 * Rutas:
 *  GET    /api/crm/seguimientos?clienteId=
 *  POST   /api/crm/seguimientos
 *  PUT    /api/crm/seguimientos/:id/completar
 *  PUT    /api/crm/seguimientos/:id/reabrir
 *  DELETE /api/crm/seguimientos/:id
 *  GET    /api/crm/agenda?desde=&hasta=&soloPendientes=
 */

const express = require('express');

const TIPOS = ['nota', 'llamada', 'visita', 'tarea', 'recordatorio'];

async function ensureSchema(query) {
  await query(`
    CREATE TABLE IF NOT EXISTS client_followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INT NOT NULL,
      tipo VARCHAR(20) NOT NULL DEFAULT 'nota',
      titulo VARCHAR(160) NOT NULL,
      descripcion VARCHAR(500) DEFAULT NULL,
      fecha_programada DATE DEFAULT NULL,
      completado TINYINT(1) NOT NULL DEFAULT 0,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME DEFAULT NULL,
      CONSTRAINT fk_client_followups_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    )
  `);
}

function mapFollowup(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    tipo: row.tipo,
    titulo: row.titulo,
    descripcion: row.descripcion || '',
    fechaProgramada: row.fecha_programada,
    completado: !!row.completado,
    createdByUserName: row.created_by_user_name,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function createCrmRouter({ query, resolveRequestActorUser }) {
  const router = express.Router();

  async function requireAuth(req, res, next) {
    try {
      req.authUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
      next();
    } catch (e) {
      res.status(401).json({ error: e.message || 'Sesión inválida o expirada.' });
    }
  }

  router.use(requireAuth);

  router.get('/seguimientos', async (req, res) => {
    const clienteId = Number(req.query.clienteId || 0);
    if (!clienteId) return res.status(400).json({ error: 'clienteId es requerido.' });
    try {
      const rows = await query(
        'SELECT * FROM client_followups WHERE client_id=? ORDER BY completado ASC, COALESCE(fecha_programada, created_at) ASC',
        [clienteId]
      );
      res.json(rows.map(mapFollowup));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/seguimientos', async (req, res) => {
    const { clientId, tipo, titulo, descripcion, fechaProgramada } = req.body || {};
    if (!clientId || !titulo) return res.status(400).json({ error: 'clientId y título son requeridos.' });
    if (!TIPOS.includes(tipo)) return res.status(400).json({ error: 'Tipo inválido.' });
    try {
      const actor = req.authUser;
      const { insertId } = await query(`
        INSERT INTO client_followups (client_id, tipo, titulo, descripcion, fecha_programada, created_by_user_id, created_by_user_name)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [clientId, tipo, titulo, descripcion || null, fechaProgramada || null, actor?.id || null, actor?.usuario || actor?.nombre || null]);
      const [created] = await query('SELECT * FROM client_followups WHERE id=?', [insertId]);
      res.status(201).json(mapFollowup(created));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/seguimientos/:id/completar', async (req, res) => {
    try {
      await query(
        "UPDATE client_followups SET completado=1, completed_at=CURRENT_TIMESTAMP WHERE id=?",
        [req.params.id]
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/seguimientos/:id/reabrir', async (req, res) => {
    try {
      await query("UPDATE client_followups SET completado=0, completed_at=NULL WHERE id=?", [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/seguimientos/:id', async (req, res) => {
    try {
      await query('DELETE FROM client_followups WHERE id=?', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Agenda: pendientes de todos los clientes, para la vista de Agenda y la campanita.
  router.get('/agenda', async (req, res) => {
    const { desde, hasta } = req.query;
    const soloPendientes = req.query.soloPendientes !== '0';
    try {
      let where = 'WHERE 1=1';
      const params = [];
      if (soloPendientes) where += ' AND f.completado = 0';
      if (desde) { where += ' AND f.fecha_programada >= ?'; params.push(desde); }
      if (hasta) { where += ' AND f.fecha_programada <= ?'; params.push(hasta); }
      const rows = await query(`
        SELECT f.*, c.nombre AS client_name, c.telefono AS client_telefono
        FROM client_followups f
        JOIN clients c ON c.id = f.client_id
        ${where}
        ORDER BY (f.fecha_programada IS NULL) ASC, f.fecha_programada ASC, f.created_at ASC
      `, params);
      res.json(rows.map((r) => ({ ...mapFollowup(r), clientName: r.client_name, clientTelefono: r.client_telefono })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

module.exports = { createCrmRouter, ensureSchema };
