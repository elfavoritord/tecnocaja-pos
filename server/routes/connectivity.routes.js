'use strict';

/**
 * server/routes/connectivity.routes.js  —  montado en /api/connectivity
 *
 * Estado de conexión en TRES partes separadas, para que la caja nunca diga
 * "Sin Internet" cuando el problema es el servidor local (o al revés):
 *
 *   database  ¿Responde la base de datos de la que vende esta caja?
 *             (MariaDB/SQLite local en la principal; la de la PC principal
 *             por la LAN en una terminal).
 *   internet  ¿Hay salida a Internet? (server/network/internet-monitor.js)
 *   pending   Qué está esperando a Internet o al servidor: cola de la nube,
 *             e-CF firmados sin enviar y ventas de contingencia de la caja.
 *
 * Si esta petición ni siquiera llega, el problema es el servidor local (la
 * caja lo muestra como "Servidor local no disponible").
 *
 * GET  /             → estado (público: solo contadores, sin datos del negocio)
 * POST /simulate     → { offline: true|false } SOLO con
 *                      TECNO_CAJA_ALLOW_CONNECTIVITY_SIMULATION=1 y desde este
 *                      mismo equipo (pruebas de "sin Internet").
 */

const express = require('express');

const DB_CHECK_TIMEOUT_MS = 3000;

function isLoopbackRequest(req) {
  const ip = String(req.socket?.remoteAddress || req.ip || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function createConnectivityRouter({
  query,
  monitor,
  getRole = () => 'principal',
  getCloudStatus = async () => null,
  countDeferredEcf = async () => 0,
  countContingencySales = async () => 0,
  allowSimulation = String(process.env.TECNO_CAJA_ALLOW_CONNECTIVITY_SIMULATION || '') === '1',
} = {}) {
  const router = express.Router();

  async function checkDatabase() {
    const startedAt = Date.now();
    let timer = null;
    try {
      await Promise.race([
        query('SELECT 1 AS ok'),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('La base de datos no respondió a tiempo.')), DB_CHECK_TIMEOUT_MS);
        }),
      ]);
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - startedAt, error: error.message };
    } finally {
      clearTimeout(timer);
    }
  }

  async function safe(fn, fallback) {
    try { return await fn(); } catch (_) { return fallback; }
  }

  router.get('/', async (_req, res) => {
    const role = getRole();
    const [database, cloud, deferredEcf, contingencySales] = await Promise.all([
      checkDatabase(),
      safe(getCloudStatus, null),
      safe(countDeferredEcf, 0),
      safe(countContingencySales, 0),
    ]);
    const internet = monitor.getStatus();

    // Modo de trabajo, en palabras de la caja:
    //   normal       → base de datos e Internet OK
    //   local        → base de datos OK, sin Internet (se vende igual)
    //   contingencia → terminal sin la base de la principal: vende en su
    //                  copia local y sube todo al volver
    //   sin_bd       → la principal/monocaja no tiene su base de datos
    let mode = 'normal';
    if (!database.ok) mode = role === 'terminal' ? 'contingencia' : 'sin_bd';
    else if (internet.online === false) mode = 'local';

    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      role,
      mode,
      server: { ok: true },
      database,
      internet,
      cloud: {
        // null = no se pudo consultar; false = sin Firebase configurado/listo
        ready: cloud ? Boolean(cloud.firebaseReady) : null,
        lastSyncAt: cloud?.lastSyncAt || null,
      },
      pending: {
        cloud: Number(cloud?.queue?.pending || 0),
        cloudErrors: Number(cloud?.queue?.errors || 0),
        ecf: Number(deferredEcf || 0),
        contingencySales: Number(contingencySales || 0),
      },
      checkedAt: new Date().toISOString(),
    });
  });

  router.post('/simulate', express.json(), async (req, res) => {
    if (!allowSimulation || !isLoopbackRequest(req)) {
      return res.status(404).json({ error: 'No disponible.' });
    }
    const online = await monitor.setSimulatedOffline(Boolean(req.body?.offline));
    return res.json({ ok: true, internet: monitor.getStatus(), online });
  });

  return router;
}

module.exports = createConnectivityRouter;
