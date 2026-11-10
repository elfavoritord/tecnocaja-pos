'use strict';

/**
 * Operaciones en curso en este servidor, para no reiniciarlo en medio de una venta de otra caja.
 * Toda petición que cambia datos cuenta mientras no termine. Solo devuelve cantidades:
 * no hace falta sesión para leerlas y el proceso principal de Electron las consulta sin ella.
 */

const express = require('express');

const METODOS_DE_ESCRITURA = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// El respaldo previo a instalar lo pide la propia actualización.
const NO_CUENTAN = /^\/api\/(system\/|respaldos\/auto)/;
const CAJA_ACTIVA_MS = 5 * 60 * 1000;

function createOperacionesActivas({ query, ahora = Date.now }) {
  let enCurso = 0;
  let mantenimiento = null;

  function middleware(req, res, next) {
    const ruta = String(req.originalUrl || req.url || '').split('?')[0];
    if (mantenimiento && ruta.startsWith('/api/') && !ruta.startsWith('/api/system/')) {
      res.status(503).json({ error: 'Restauración en curso. Espera a que termine antes de continuar.', code: 'RESTORE_IN_PROGRESS' }); return;
    }
    if (!METODOS_DE_ESCRITURA.has(req.method) || !ruta.startsWith('/api/') || NO_CUENTAN.test(ruta)) {
      next();
      return;
    }
    enCurso += 1;
    res.once('close', () => { enCurso -= 1; });
    next();
  }

  // Cajas terminales que hablaron con esta PC hace poco: al reiniciarla se quedan sin ella.
  async function otrasCajasConectadas() {
    const filas = await query(
      'SELECT last_seen_at FROM terminal_registrations WHERE COALESCE(is_main, 0) = 0'
    ).catch(() => []);
    return filas.filter((f) => {
      const visto = new Date(String(f.last_seen_at || '').replace(' ', 'T')).getTime();
      return Number.isFinite(visto) && ahora() - visto < CAJA_ACTIVA_MS;
    }).length;
  }

  const router = express.Router();
  router.get('/operaciones-activas', async (_req, res) => {
    res.json({ activas: enCurso, otrasCajas: await otrasCajasConectadas() });
  });

  async function withExclusive(work, { currentRequests = 1, timeoutMs = 15000 } = {}) {
    if (mantenimiento) throw Object.assign(new Error('Ya hay una restauración en curso.'), { statusCode: 409 });
    mantenimiento = 'restore';
    try {
      const limite = Date.now() + timeoutMs;
      while (enCurso > currentRequests) {
        if (Date.now() > limite) throw Object.assign(new Error('Hay operaciones activas. Reintenta la restauración al terminar los cobros.'), { statusCode: 409 });
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return await work();
    } finally { mantenimiento = null; }
  }
  return { middleware, router, activas: () => enCurso, withExclusive };
}

module.exports = { createOperacionesActivas };
