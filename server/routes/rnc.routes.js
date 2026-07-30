'use strict';

const express = require('express');

let handler = null;
let rncReady = false;
let rncError = null;
let warmedUp = false;

function getRncHandler() {
  if (handler) return handler;
  try {
    const mod = require('dgii-rnc');
    handler = new mod.RNCHandler();
  } catch (err) {
    rncError = 'Paquete dgii-rnc no disponible: ' + err.message;
  }
  return handler;
}

// Pre-cargar el dataset en background al iniciar. IMPORTANTE: no usar
// scheduleUpdates() del paquete dgii-rnc — esa función llama a checkFile()
// de inmediato al programarse (además de su propio setInterval diario), y
// checkFile() SIEMPRE re-lee y re-parsea el archivo completo (~784k líneas,
// fs.readFileSync síncrono y bloqueante) sin importar si cambió o no. Eso
// duplicaba el bloqueo del event loop en cada arranque de la app (dos
// congelamientos seguidos en vez de uno). Aquí se programa un solo chequeo
// diario propio, sin la llamada inmediata extra.
function warmupRncDataset() {
  if (warmedUp) return;
  warmedUp = true;
  const h = getRncHandler();
  if (!h) return;
  h.checkFile()
    .then(() => {
      rncReady = true;
      const dailyTimer = setInterval(() => {
        h.checkFile().catch((err) => { rncError = err.message; });
      }, 24 * 60 * 60 * 1000);
      dailyTimer.unref?.();
    })
    .catch((err) => { rncError = err.message; });
}

function createRncRouter() {
  const router = express.Router();
  // El paquete puede descargar y procesar el dataset completo de la DGII.
  // Calentarlo al importar server.js añadía varios segundos al arranque. Se
  // difiere hasta que la interfaz ya tuvo tiempo de abrir; una consulta hecha
  // antes igualmente lo inicializa bajo demanda mediante getRncHandler().
  const warmupTimer = setTimeout(() => {
    warmupRncDataset();
  }, 15_000);
  warmupTimer.unref?.();

  // GET /api/rnc/lookup?id=130000000
  router.get('/api/rnc/lookup', async (req, res) => {
    const raw = String(req.query.id || '').replace(/\D/g, '');
    if (!raw || raw.length < 9) {
      return res.status(400).json({ error: 'Proporciona un RNC válido (9-11 dígitos).' });
    }

    const h = getRncHandler();
    if (!h) return res.status(503).json({ error: rncError || 'Servicio RNC no disponible.' });

    try {
      // Construir lista de candidatos a buscar:
      // El dataset guarda cédulas con ceros a la izquierda (11 dígitos).
      // Si el usuario escribe solo 10 dígitos (falta el cero inicial), probamos
      // también con el padding. Para RNCs de empresa (9 dígitos) no se hace padding.
      const candidates = [raw.slice(0, 11)];
      if (raw.length === 10) {
        candidates.push('0' + raw);   // cédula sin el cero inicial
      } else if (raw.length === 9) {
        // RNC de empresa — también probar como los primeros 9 dígitos de una cédula de 11
        // (raro, pero cubre errores de tipeo)
      }

      // Si el dataset ya está en memoria, buscar directo para evitar checkFile() en cada request
      let record = null;
      const df = rncReady && h.df && h.df.length > 0 ? h.df : null;
      if (df) {
        for (const id of candidates) {
          record = df.find(r => r.ID === id) || null;
          if (record) break;
        }
      } else {
        for (const id of candidates) {
          const results = await h.search({ ID: id });
          if (results && results.length > 0) { record = results[0]; break; }
        }
        rncReady = handler && handler.df && handler.df.length > 0;
      }

      if (!record) {
        return res.json({ found: false, rnc: raw });
      }

      return res.json({
        found: true,
        rnc: record.ID || raw,
        nombre: record.NOMBRE || '',
        nombreComercial: record.NOMBRE_COMERCIAL || record.NOMBRE || '',
        estado: record.ESTADO || '',
        tipo: (record.ID || '').length === 11 ? 'Persona Física' : 'Persona Jurídica',
        categoria: record.CATEGORIA || '',
        regimen: record.REGIMEN_PAGO || '',
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
      const qUpper = q.toUpperCase();
      let rows;
      // Búsqueda directa en memoria si el dataset ya cargó
      if (rncReady && h.df && h.df.length > 0) {
        rows = [];
        for (const r of h.df) {
          if (r.NOMBRE.includes(qUpper) || (r.NOMBRE_COMERCIAL && r.NOMBRE_COMERCIAL.includes(qUpper))) {
            rows.push(r);
            if (rows.length >= limit) break;
          }
        }
      } else {
        const results = await h.search({ NOMBRE: q });
        rows = (results || []).slice(0, limit);
      }
      return res.json({
        results: rows.map(r => ({
          rnc:             r.ID || '',
          nombre:          r.NOMBRE || '',
          nombreComercial: r.NOMBRE_COMERCIAL || r.NOMBRE || '',
          estado:          r.ESTADO || '',
          tipo:            (r.ID || '').length === 11 ? 'Persona Física' : 'Persona Jurídica',
          categoria:       r.CATEGORIA || '',
        }))
      });
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
