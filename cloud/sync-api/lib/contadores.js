'use strict';

// Búsqueda de contadores para el asistente del POS ("Cliente de un contador").
// Pública: el asistente corre antes de que la PC esté vinculada, así que no
// hay identidad que pedir. Solo devuelve los datos de contacto de la firma
// (los mismos que muestra el asistente), nunca el resto del documento, y con
// límite de búsquedas por IP.

const express = require('express');
const { createRateLimiter } = require('./rate-limit');

const BUSCAR_EN = ['nombre_firma', 'responsable', 'rnc', 'telefono', 'correo'];
const texto = (v, max = 200) => String(v ?? '').trim().slice(0, max);

function publico(id, c = {}) {
  const logo = texto(c.logo_url, 1000);
  return {
    id,
    nombre_firma: texto(c.nombre_firma),
    responsable: texto(c.responsable),
    rnc: texto(c.rnc, 20),
    telefono: texto(c.telefono, 40),
    correo: texto(c.correo),
    logo_url: /^https:\/\//i.test(logo) ? logo : null,
  };
}

function createContadoresRouter({ db, now = () => new Date(), cacheMs = 60000, maxPorMinuto = 40 }) {
  const router = express.Router();
  const limit = createRateLimiter({ windowMs: 60000, max: maxPorMinuto, now: () => now().getTime() });
  let cache = null;

  async function contadores() {
    const t = now().getTime();
    if (cache && t - cache.at < cacheMs) return cache.lista;
    const snap = await db.collection('contadores').get();
    const lista = snap.docs
      .map((d) => ({ id: d.id, datos: d.data() || {} }))
      .filter(({ datos }) => String(datos.estado || '').toLowerCase() !== 'suspendido')
      .map(({ id, datos }) => publico(id, datos))
      .filter((c) => c.nombre_firma);
    cache = { at: t, lista };
    return lista;
  }

  router.get('/v1/contadores/buscar', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!limit(req.ip)) return res.status(429).json({ error: 'Demasiadas búsquedas. Espera un minuto.' });
    const q = texto(req.query.q, 80).toLowerCase();
    if (q.length < 2) return res.json({ contadores: [] });
    try {
      const encontrados = (await contadores())
        .filter((c) => BUSCAR_EN.some((campo) => c[campo].toLowerCase().includes(q)))
        .slice(0, 20);
      return res.json({ contadores: encontrados });
    } catch (e) {
      console.error('[CONTADORES]', e.message);
      return res.status(500).json({ error: 'No se pudo buscar contadores.' });
    }
  });

  return router;
}

module.exports = { createContadoresRouter };
