'use strict';

const express = require('express');

let handler = null;
let scheduleUpdates = null;
let rncReady = false;
let rncError = null;

function getRncHandler() {
  if (handler) return handler;
  try {
    const mod = require('dgii-rnc');
    handler = new mod.RNCHandler();
    scheduleUpdates = mod.scheduleUpdates;
    // Arrancar actualización diaria silenciosa
    scheduleUpdates({ handler, intervalMs: 24 * 60 * 60 * 1000 });
    // Pre-cargar dataset en background
    handler.checkFile()
      .then(() => { rncReady = true; })
      .catch((err) => { rncError = err.message; });
  } catch (err) {
    rncError = 'Paquete dgii-rnc no disponible: ' + err.message;
  }
  return handler;
}

// Iniciar carga al importar el módulo (no esperar el primer request)
getRncHandler();

function createRncRouter() {
  const router = express.Router();

  // GET /api/rnc/lookup?id=130000000
  router.get('/api/rnc/lookup', async (req, res) => {
    const id = String(req.query.id || '').replace(/\D/g, '').slice(0, 11);
    if (!id || id.length < 9) {
      return res.status(400).json({ error: 'Proporciona un RNC válido (9-11 dígitos).' });
    }
    const h = getRncHandler();
    if (!h) return res.status(503).json({ error: rncError || 'Servicio RNC no disponible.' });
    try {
      const results = await h.search({ ID: id });
      if (!results || results.length === 0) {
        return res.status(404).json({ found: false, rnc: id });
      }
      const r = results[0];
      return res.json({
        found: true,
        rnc: r.ID || r.RNC || id,
        nombre: r.NOMBRE || r.nombre || '',
        nombreComercial: r.NOMBRE_COMERCIAL || r.nombre_comercial || '',
        estado: r.ESTADO || r.estado || '',
        tipo: r.TIPO || r.tipo || ''
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/rnc/search?q=banco+popular&limit=10
  router.get('/api/rnc/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    if (!q || q.length < 3) {
      return res.status(400).json({ error: 'Escribe al menos 3 caracteres para buscar.' });
    }
    const h = getRncHandler();
    if (!h) return res.status(503).json({ error: rncError || 'Servicio RNC no disponible.' });
    try {
      const results = await h.search({ NOMBRE: q });
      const mapped = (results || []).slice(0, limit).map((r) => ({
        rnc: r.ID || r.RNC || '',
        nombre: r.NOMBRE || r.nombre || '',
        nombreComercial: r.NOMBRE_COMERCIAL || r.nombre_comercial || '',
        estado: r.ESTADO || r.estado || '',
        tipo: r.TIPO || r.tipo || ''
      }));
      return res.json({ results: mapped, total: results.length });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/rnc/status — estado del dataset
  router.get('/api/rnc/status', (_req, res) => {
    res.json({ ready: rncReady, error: rncError });
  });

  return router;
}

module.exports = createRncRouter;
