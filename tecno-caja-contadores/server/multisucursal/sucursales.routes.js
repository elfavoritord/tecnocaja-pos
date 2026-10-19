'use strict';

/**
 * Rutas HTTP de sucursales centrales, compartidas por el panel de Emilio
 * (tecno-caja-admin) y el portal del contador (tecno-caja-contadores, copia
 * por vendor-sync). Cada panel pone su `requireAuth` y dice quién es el
 * usuario con `actorDe(req)`. Los permisos los decide sucursales.js, no la
 * pantalla: un contador recibe 403 aunque llame a la ruta del límite.
 *
 *   GET  /:licenseId                          resumen (límite, activas, sucursales)
 *   PUT  /:licenseId/limite        {maximo}   solo super administrador
 *   POST /:licenseId                {datos}   crear
 *   PUT  /:licenseId/:branchUuid    {datos}   editar
 *   POST /:licenseId/:branchUuid/estado {estado: activa|inactiva}   solo super administrador
 *   POST /:licenseId/:branchUuid/codigo       código de equipo (se muestra una vez)
 *   GET  /:licenseId/equipos                  PC de cada sucursal: en línea, último latido, pendientes
 *   POST /:licenseId/equipos/:equipoId/revocar   solo super administrador
 *   GET  /:licenseId/ncf                      rangos NCF de todas las sucursales
 *   POST /:licenseId/:branchUuid/ncf          { tipo, desde, hasta, vence, autorizacion } asignar sub-rango
 *   POST /:licenseId/:branchUuid/ncf/:rangoUuid/anular   (si la sucursal no lo empezó a usar)
 *   GET  /:licenseId/resumen?dias=30          ventas por sucursal (lo que ya sincronizó)
 */

const express = require('express');

function createSucursalesRouter({
  requireAuth,
  getCentral,
  actorDe,
  alCambiar = async () => {},
  getSincronizacion = () => getCentral().sincronizacion,
}) {
  const router = express.Router();

  const responder = (fn) => async (req, res) => {
    try {
      const actor = actorDe(req);
      const resultado = await fn(req, actor);
      res.json({ ok: true, ...resultado });
    } catch (error) {
      const status = Number(error.statusCode) || 500;
      if (status >= 500) console.error('[sucursales]', error);
      res.status(status).json({ ok: false, error: error.message, code: error.code || null });
    }
  };

  const avisar = (req, accion, detalle) => alCambiar(req, accion, req.params.licenseId, detalle).catch(() => {});

  router.get('/:licenseId', requireAuth, responder((req, actor) => getCentral().resumen(req.params.licenseId, actor)));

  router.get('/:licenseId/equipos', requireAuth, responder(async (req, actor) => ({
    equipos: await getCentral().listarEquipos(req.params.licenseId, actor),
  })));

  router.post('/:licenseId/equipos/:equipoId/revocar', requireAuth, responder(async (req, actor) => {
    const r = await getCentral().revocarEquipo(req.params.licenseId, req.params.equipoId, actor);
    await avisar(req, 'sucursales.revocar_equipo', req.params.equipoId);
    return r;
  }));

  router.get('/:licenseId/ncf', requireAuth, responder(async (req, actor) => ({
    rangos: await getSincronizacion().listarRangosNcf(req.params.licenseId, actor),
  })));

  router.get('/:licenseId/resumen', requireAuth, responder((req, actor) => (
    getSincronizacion().resumenOperacion(req.params.licenseId, actor, { dias: Number(req.query.dias) || 30 })
  )));

  router.post('/:licenseId/:branchUuid/ncf', requireAuth, responder(async (req, actor) => {
    const r = await getSincronizacion().asignarRangoNcf(req.params.licenseId, req.params.branchUuid, req.body || {}, actor);
    await avisar(req, 'sucursales.ncf_asignar', `${r.tipo} ${r.desde}-${r.hasta} → ${req.params.branchUuid}`);
    return { rango: r };
  }));

  router.post('/:licenseId/:branchUuid/ncf/:rangoUuid/anular', requireAuth, responder(async (req, actor) => {
    const r = await getSincronizacion().anularRangoNcf(req.params.licenseId, req.params.branchUuid, req.params.rangoUuid, actor);
    await avisar(req, 'sucursales.ncf_anular', req.params.rangoUuid);
    return r;
  }));

  router.put('/:licenseId/limite', requireAuth, responder(async (req, actor) => {
    const r = await getCentral().fijarLimite(req.params.licenseId, req.body?.maximo, actor);
    await avisar(req, 'sucursales.limite', `Límite: ${r.maxSucursales}`);
    return r;
  }));

  router.post('/:licenseId', requireAuth, responder(async (req, actor) => {
    const r = await getCentral().crear(req.params.licenseId, req.body || {}, actor);
    await avisar(req, 'sucursales.crear', `${r.nombre} (${r.branchUuid})`);
    return { sucursal: r };
  }));

  router.put('/:licenseId/:branchUuid', requireAuth, responder(async (req, actor) => {
    const r = await getCentral().editar(req.params.licenseId, req.params.branchUuid, req.body || {}, actor);
    await avisar(req, 'sucursales.editar', req.params.branchUuid);
    return r;
  }));

  router.post('/:licenseId/:branchUuid/estado', requireAuth, responder(async (req, actor) => {
    const r = await getCentral().cambiarEstado(req.params.licenseId, req.params.branchUuid, req.body?.estado, actor);
    await avisar(req, `sucursales.${r.estado === 'activa' ? 'activar' : 'desactivar'}`, req.params.branchUuid);
    return r;
  }));

  router.post('/:licenseId/:branchUuid/codigo', requireAuth, responder(async (req, actor) => {
    const r = await getCentral().generarCodigo(req.params.licenseId, req.params.branchUuid, actor);
    await avisar(req, 'sucursales.codigo_equipo', req.params.branchUuid);
    return r;
  }));

  return router;
}

module.exports = { createSucursalesRouter };
