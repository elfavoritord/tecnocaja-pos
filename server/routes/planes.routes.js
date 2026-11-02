'use strict';

// Planes y precios para la pantalla del POS. Solo lectura: un cliente no puede
// cambiar aquí ni su plan ni sus precios (eso se hace en el panel del administrador).

const express = require('express');
const { catalogo } = require('../licensing/precios');

function createPlanesRouter({ resolveRequestActorUser, secureLicenseService }) {
  const router = express.Router();

  // Los precios son públicos: también salen en la página web.
  router.get('/catalogo', (_req, res) => {
    res.json(catalogo());
  });

  router.get('/mi-licencia', async (req, res) => {
    try {
      await resolveRequestActorUser(req, { required: true });
      const { license = {} } = await secureLicenseService.resolveState({ allowRemote: false });
      res.json({
        planCode: license.planCode || 'basico',
        modalidad: license.modalidad || null,
        status: license.status || 'trial',
        expiresAt: license.expiresAt || null,
        computadoras: license.deviceLimit || null,
        servicios: license.servicios || null,
      });
    } catch (error) {
      res.status(Number(error.statusCode) || 500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { createPlanesRouter };
