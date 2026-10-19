'use strict';

/**
 * server/routes/multisucursal.routes.js — Diagnóstico del módulo
 * multisucursal. Solo administrador general.
 *
 *   GET /api/multisucursal/estado → identidad (empresa/sucursal/nodo con
 *       uuid), migraciones aplicadas y conteo de la bandeja de salida.
 */

const express = require('express');

module.exports = function createMultisucursalRoutes({ multisucursal, resolveRequestActorUser, isGlobalAdministratorUser }) {
  const router = express.Router();

  async function soloAdministradorGeneral(req, res, next) {
    try {
      const user = await resolveRequestActorUser(req, { required: true });
      if (!isGlobalAdministratorUser(user)) {
        return res.status(403).json({ ok: false, error: 'Solo el administrador general puede ver esto.' });
      }
      req.authUser = user;
      return next();
    } catch (error) {
      return res.status(401).json({ ok: false, error: error.message });
    }
  }

  router.get('/estado', soloAdministradorGeneral, async (_req, res) => {
    try {
      res.json({ ok: true, ...(await multisucursal.estado()) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  return router;
};
