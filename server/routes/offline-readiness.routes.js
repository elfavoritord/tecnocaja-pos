'use strict';
const express = require('express');
module.exports = function createOfflineReadinessRouter({ query, resolveRequestActorUser, licenseService, internetMonitor }) {
  const router = express.Router();
  router.get('/account/offline-readiness', async (req, res) => {
    try {
      const actor = await resolveRequestActorUser(req, { required: true });
      const rows = await query('SELECT id, password_hash, password, auth_provider FROM users WHERE id = ? LIMIT 1', [actor.id]);
      const localPasswordAvailable = Boolean(String(rows[0]?.password_hash || rows[0]?.password || '').trim());
      const estado = await licenseService.resolveState({ allowRemote: false });
      const licencia = estado.license || {};
      const redLocal = String(process.env.DB_CLIENT || '').toLowerCase() === 'mysql' && !['localhost', '127.0.0.1', '::1', ''].includes(String(process.env.DB_HOST || '').trim());
      res.json({ databaseAvailable: true, localPasswordAvailable, lanRequired: redLocal,
        licenseLocallyValid: Boolean(licencia.canEnter), licenseSource: estado.source,
        blockedCode: licencia.blockedCode || null, internet: internetMonitor.getStatus().online,
        ready: localPasswordAvailable && Boolean(licencia.canEnter),
        actions: [!localPasswordAvailable ? 'Crear una contraseña de acceso local en Configuración → Mi cuenta.' : null,
          !licencia.canEnter ? licencia.message || 'Validar la autorización de este equipo con el propietario del sistema.' : null,
          redLocal ? 'Mantener disponible la red LAN y la PC principal; la LAN es independiente de internet.' : null].filter(Boolean),
      });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  return router;
};
