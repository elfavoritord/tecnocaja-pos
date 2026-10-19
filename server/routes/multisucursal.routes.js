'use strict';

/**
 * server/routes/multisucursal.routes.js — Multisucursal en el POS.
 *
 *   GET  /api/multisucursal/estado        identidad (uuid), migraciones, bandeja y enlace con la central
 *   GET  /api/multisucursal/indicador     estado corto para la barra (cualquier usuario con sesión)
 *   POST /api/multisucursal/asistente/dueno   { idToken } → empresas y sucursales del dueño   (PC sin configurar)
 *   POST /api/multisucursal/asistente/unirse  { idToken, licenseId, branchUuid, nombre, email, clave, claveRed? }
 *                                         → configura esta PC nueva como esa sucursal          (PC sin configurar)
 *   POST /api/multisucursal/dueno/empresas    { idToken } → lo mismo, desde Configuración
 *   POST /api/multisucursal/dueno/activar     { idToken, licenseId, branchUuid } → enlaza esta PC
 *   POST /api/multisucursal/activar       { codigo } → enlaza esta PC como la sucursal del código
 *                                         (código de equipo generado por Emilio o el contador)
 *   POST /api/multisucursal/sincronizar   identidad + latido + ciclo de sincronización (?esperar=1 lo espera)
 *   POST /api/multisucursal/desvincular   quita el token de esta PC
 *   GET  /api/multisucursal/sincronizacion        pendientes, errores, conflictos, rangos NCF, último ciclo
 *   GET  /api/multisucursal/bitacora              últimos ciclos (sync_bitacora)
 *   GET  /api/multisucursal/sucursales-empresa    sucursales de la empresa (para elegir alcance)
 *   POST /api/multisucursal/conflictos/:id        { accion: vincular|ignorar }
 *   POST /api/multisucursal/conflictos            { accion } todos
 *   POST /api/multisucursal/rechazados/reintentar
 *   POST /api/multisucursal/catalogo/publicar     publica el catálogo activo (solo la principal)
 *   POST /api/multisucursal/precio-sucursales     { productId, precio, sucursales[] } (solo la principal)
 *
 * Todo menos el asistente y el indicador: administrador general. Activar y
 * desvincular solo desde la PC principal de la sucursal (es la que sincroniza).
 */

const express = require('express');

module.exports = function createMultisucursalRoutes({
  multisucursal, asistente = null, resolveRequestActorUser, isGlobalAdministratorUser, writeAuditLog = async () => {},
}) {
  const router = express.Router();

  const responderSinSesion = (fn) => async (req, res) => {
    try {
      res.json({ ok: true, ...(await fn(req)) });
    } catch (error) {
      res.status(Number(error.statusCode) || 500).json({ ok: false, error: error.message, code: error.code || null });
    }
  };

  // Asistente inicial de una PC nueva ("Conectar como sucursal de una
  // empresa", server/multisucursal/asistente-sucursal.js): el dueño entra con
  // su cuenta, elige la sucursal y la PC queda configurada como ella. Sin
  // sesión (la PC todavía no tiene usuarios): el asistente lo permite solo
  // mientras la PC está sin configurar.
  if (asistente) {
    router.post('/asistente/dueno', responderSinSesion((req) => asistente.empresasDelDueno(req.body?.idToken)));
    router.post('/asistente/unirse', responderSinSesion((req) => asistente.unirse(req.body || {})));
  }

  // Configuración de una PC ya configurada: las mismas dos llamadas, con la
  // sesión del administrador general (ver más abajo).

  async function conSesion(req, res, next) {
    try {
      req.authUser = await resolveRequestActorUser(req, { required: true });
      return next();
    } catch (error) {
      return res.status(401).json({ ok: false, error: error.message });
    }
  }

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

  const sync = () => multisucursal.sincronizacion;

  router.get('/estado', soloAdministradorGeneral, responder(() => multisucursal.estado()));

  // Para la barra de estado: lo ve también el cajero (no muestra datos).
  router.get('/indicador', conSesion, responder(async () => {
    const enlace = await multisucursal.enlace.estado();
    if (!enlace.tieneToken) return { visible: false };
    if (!enlace.vinculado) {
      return { visible: true, indicador: { nivel: 'error', texto: 'Esta PC ya no sincroniza con la central' } };
    }
    const e = await sync().estado();
    return { visible: true, indicador: e.indicador, pendientes: e.pendientes, ultimaSincronizacion: e.ultimaSincronizacion };
  }));

  router.post('/activar', soloAdministradorGeneral, soloPrincipal, responder(async (req) => {
    const enlace = await multisucursal.enlace.activar(req.body?.codigo);
    await auditar(req, 'Equipo enlazado a la central', `${enlace.empresa?.nombre || ''} · ${enlace.sucursal?.nombre || ''}`);
    // Primera sincronización ya (catálogo, usuarios y rangos de la sucursal).
    sync().iniciar({ primeraEsperaMs: 1000 });
    return { enlace };
  }));

  // Conectar con la cuenta del dueño (sin código): primero sus sucursales…
  router.post('/dueno/empresas', soloAdministradorGeneral, soloPrincipal, responder(async (req) => {
    const r = await multisucursal.enlace.empresasDelDueno(req.body?.idToken);
    return { dueno: r.dueno || null, empresas: r.empresas || [] };
  }));

  // …y después esta PC como la sucursal que eligió.
  router.post('/dueno/activar', soloAdministradorGeneral, soloPrincipal, responder(async (req) => {
    const b = req.body || {};
    const r = await multisucursal.enlace.activarConDueno({ idToken: b.idToken, licenseId: b.licenseId, branchUuid: b.branchUuid });
    await auditar(req, 'Equipo enlazado a la central (cuenta del dueño)', `${r.empresa?.nombre || ''} · ${r.sucursal?.nombre || ''}`);
    sync().iniciar({ primeraEsperaMs: 1000 });
    return { enlace: await multisucursal.enlace.estado() };
  }));

  router.post('/sincronizar', soloAdministradorGeneral, responder(async (req) => {
    await multisucursal.enlace.refrescarIdentidad();
    const enlace = await multisucursal.enlace.latido();
    let ciclo = null;
    if (enlace.vinculado && multisucursal.esServidorPrincipal()) {
      const promesa = sync().ciclo();
      if (req.query.esperar === '1') ciclo = await promesa;
      else promesa.catch(() => {});
      await multisucursal.enlace.latido();
    }
    return { enlace, ciclo, sincronizacion: await sync().estado() };
  }));

  router.post('/desvincular', soloAdministradorGeneral, soloPrincipal, responder(async (req) => {
    sync().detener();
    const enlace = await multisucursal.enlace.desvincular();
    await auditar(req, 'Equipo desvinculado de la central', '');
    return { enlace };
  }));

  router.get('/sincronizacion', soloAdministradorGeneral, responder(async () => ({ sincronizacion: await sync().estado() })));

  router.get('/bitacora', soloAdministradorGeneral, responder(async (req) => ({ ciclos: await sync().bitacora(req.query.limite) })));

  router.get('/sucursales-empresa', soloAdministradorGeneral, responder(async (req) => ({
    sucursales: await sync().sucursalesEmpresa({ refrescar: req.query.refrescar === '1' }),
  })));

  router.post('/conflictos/:id', soloAdministradorGeneral, responder(async (req) => {
    const accion = req.body?.accion === 'ignorar' ? 'ignorar' : 'vincular';
    const r = await sync().resolverConflicto(req.params.id, accion);
    await auditar(req, `Conflicto de sincronización: ${accion}`, `#${req.params.id} → ${r.resultado || r.motivo}`);
    return r;
  }));

  router.post('/conflictos', soloAdministradorGeneral, responder(async (req) => {
    const accion = req.body?.accion === 'ignorar' ? 'ignorar' : 'vincular';
    const r = await sync().resolverTodos(accion);
    await auditar(req, `Conflictos de sincronización: ${accion} todos`, `${r.resueltos} resuelto(s)`);
    return r;
  }));

  router.post('/rechazados/reintentar', soloAdministradorGeneral, responder(async (req) => {
    const r = await sync().reintentarRechazados();
    await auditar(req, 'Reintentar cambios rechazados', `${r.reintentados} evento(s)`);
    sync().pronto(1000);
    return r;
  }));

  router.post('/catalogo/publicar', soloAdministradorGeneral, soloPrincipal, responder(async (req) => {
    const r = await sync().publicarCatalogo();
    await auditar(req, 'Catálogo publicado a la empresa', `${r.publicados} producto(s)`);
    return r;
  }));

  router.post('/precio-sucursales', soloAdministradorGeneral, soloPrincipal, responder(async (req) => {
    const r = await sync().precioEnSucursales(req.body || {});
    await auditar(req, 'Precio en varias sucursales', `${r.producto.codigo} · ${r.precio}`);
    return r;
  }));

  return router;
};
