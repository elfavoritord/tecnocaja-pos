'use strict';

/**
 * server/routes/multisucursal.routes.js — Multisucursal en el POS. Solo
 * administrador general.
 *
 *   GET  /api/multisucursal/estado        identidad (uuid), migraciones, bandeja y enlace con la central
 *   POST /api/multisucursal/activar       { codigo } → enlaza esta PC como la sucursal del código
 *                                         (código de equipo generado por Emilio o el contador)
 *   POST /api/multisucursal/sincronizar   identidad + latido ahora (en vez de esperar al temporizador)
 *   POST /api/multisucursal/desvincular   quita el token de esta PC
 *
 * Activar y desvincular solo desde la PC principal: es la que sincroniza.
 */

const express = require('express');

module.exports = function createMultisucursalRoutes({ multisucursal, resolveRequestActorUser, isGlobalAdministratorUser, writeAuditLog = async () => {} }) {
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

  function soloPrincipal(_req, res, next) {
    if (!multisucursal.esServidorPrincipal()) {
      return res.status(409).json({ ok: false, error: 'Hazlo desde la PC principal de la sucursal: es la que se conecta con Tecno Caja.' });
    }
    return next();
  }

  const responder = (fn) => async (req, res) => {
    try {
      res.json({ ok: true, ...(await fn(req)) });
    } catch (error) {
      const status = Number(error.statusCode) || 500;
      res.status(status).json({ ok: false, error: error.message, code: error.code || null });
    }
  };

  const auditar = (req, accion, detalle) => writeAuditLog({
    userId: req.authUser?.id,
    userName: req.authUser?.nombre || req.authUser?.usuario,
    userRole: req.authUser?.rol,
    moduleName: 'Multisucursal',
    actionName: accion,
    detail: detalle,
  }).catch(() => {});

  router.get('/estado', soloAdministradorGeneral, responder(() => multisucursal.estado()));

  router.post('/activar', soloAdministradorGeneral, soloPrincipal, responder(async (req) => {
    const enlace = await multisucursal.enlace.activar(req.body?.codigo);
    await auditar(req, 'Equipo enlazado a la central', `${enlace.empresa?.nombre || ''} · ${enlace.sucursal?.nombre || ''}`);
    return { enlace };
  }));

  router.post('/sincronizar', soloAdministradorGeneral, responder(async () => {
    await multisucursal.enlace.refrescarIdentidad();
    return { enlace: await multisucursal.enlace.latido() };
  }));

  router.post('/desvincular', soloAdministradorGeneral, soloPrincipal, responder(async (req) => {
    const enlace = await multisucursal.enlace.desvincular();
    await auditar(req, 'Equipo desvinculado de la central', '');
    return { enlace };
  }));

  return router;
};
