'use strict';

/**
 * Comprobantes fiscales de compras y gastos (E41, E43, E47): aprobación y estados.
 * Ver server/services/comprobantes-compra.service.js.
 *
 *   GET  /api/comprobantes-compra?estado=&tipo=      lista (estado=abiertos: lo que falta resolver)
 *   GET  /api/comprobantes-compra/resumen            cuántos hay por estado (aviso y pestaña)
 *   GET  /api/comprobantes-compra/config             { modalidad, puedeAprobar }
 *   PUT  /api/comprobantes-compra/config             { modalidad: 'directa' | 'aprobacion' } (administrador)
 *   GET  /api/comprobantes-compra/:id                detalle con su historial
 *   POST /api/comprobantes-compra/:id/aprobar        firma y envía
 *   POST /api/comprobantes-compra/:id/no-aprobar     { motivo }
 *   POST /api/comprobantes-compra/:id/reintentar     autorizado que no salió o rechazado
 *   POST /api/comprobantes-compra/:id/anular         { motivo } (nunca uno aceptado)
 *   POST /api/comprobantes-compra/solicitar          { origen: { tipo, id }, tipoEcf, identificadorExtranjero? }
 *   POST /api/comprobantes-compra/sincronizar        trae ya las respuestas de la DGII
 */

const express = require('express');

function createComprobantesCompraRouter({
  servicio, resolveRequestActorUser, userRoleHasPermission, getUserScopeBranchId,
}) {
  const router = express.Router();
  const rol = (a) => String(a?.role_code || a?.rol || '').trim().toLowerCase();
  const esAdminGeneral = (a) => rol(a) === 'administrador_general';
  const tiene = (a, ...permisos) => esAdminGeneral(a) || permisos.some((p) => userRoleHasPermission(a, p));
  const puedeAprobar = (a) => tiene(a, 'comprobantes_compra.aprobar');
  const responderError = (res, e) => res.status(e.statusCode || 500).json({ error: e.message, ...(e.errores ? { errores: e.errores } : {}) });

  router.use(async (req, res, next) => {
    try {
      const actor = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
      if (!tiene(actor, 'compras.ver', 'gastos.ver', 'comprobantes_compra.aprobar')) {
        return res.status(403).json({ error: 'No tienes permiso para ver los comprobantes de compras.' });
      }
      req.authUser = actor;
      next();
    } catch (e) {
      res.status(e.statusCode || 401).json({ error: e.message || 'Sesión inválida o expirada.' });
    }
  });

  // Quien trabaja en una sucursal solo ve y toca los de su sucursal.
  const sucursalDe = (actor) => (esAdminGeneral(actor) ? null : Number(getUserScopeBranchId(actor) || 0) || null);
  async function propio(req) {
    const c = await servicio.detalle(Number(req.params.id));
    const sucursal = sucursalDe(req.authUser);
    if (sucursal && Number(c.branchId) !== sucursal) throw Object.assign(new Error('Este comprobante es de otra sucursal.'), { statusCode: 403 });
    return c;
  }
  const exigir = (...permisos) => (req, res, next) => (tiene(req.authUser, ...permisos)
    ? next() : res.status(403).json({ error: 'No tienes permiso para esta acción.' }));

  router.get('/', async (req, res) => {
    try {
      const sucursal = sucursalDe(req.authUser);
      res.json(await servicio.listar({ estado: req.query.estado || null, tipo: req.query.tipo || null, branchId: sucursal || (req.query.branchId ? Number(req.query.branchId) : null) }));
    } catch (e) { responderError(res, e); }
  });

  router.get('/resumen', async (req, res) => {
    try {
      res.json({ ...(await servicio.resumen({ branchId: sucursalDe(req.authUser) })), puedeAprobar: puedeAprobar(req.authUser) });
    } catch (e) { responderError(res, e); }
  });

  router.get('/config', async (req, res) => {
    try {
      res.json({ modalidad: await servicio.leerModalidad(), puedeAprobar: puedeAprobar(req.authUser), puedeConfigurar: tiene(req.authUser, 'gestionar_configuracion_global') });
    } catch (e) { responderError(res, e); }
  });

  router.put('/config', exigir('gestionar_configuracion_global'), async (req, res) => {
    try {
      res.json({ modalidad: await servicio.guardarModalidad(String(req.body?.modalidad || ''), req.authUser) });
    } catch (e) { responderError(res, e); }
  });

  router.post('/sincronizar', async (req, res) => {
    try { res.json(await servicio.sincronizar({ consultar: true, limite: 10 })); } catch (e) { responderError(res, e); }
  });

  router.post('/solicitar', exigir('compras.crear', 'gastos.crear'), async (req, res) => {
    try {
      const origen = req.body?.origen || {};
      const tipo = origen.tipo === 'compra' ? 'compra' : origen.tipo === 'gasto' ? 'gasto' : null;
      if (!tipo) throw Object.assign(new Error('Indica la compra o el gasto.'), { statusCode: 400 });
      if (tipo === 'compra' && !tiene(req.authUser, 'compras.crear')) throw Object.assign(new Error('No tienes permiso para compras.'), { statusCode: 403 });
      if (tipo === 'gasto' && !tiene(req.authUser, 'gastos.crear')) throw Object.assign(new Error('No tienes permiso para gastos.'), { statusCode: 403 });
      const r = await servicio.solicitarDe({
        tipo, id: Number(origen.id), tipoEcf: String(req.body?.tipoEcf || (tipo === 'compra' ? 'E41' : '')).toUpperCase(),
        actor: req.authUser, puedeAprobar: puedeAprobar(req.authUser),
        extra: { identificadorExtranjero: req.body?.identificadorExtranjero || '' },
      });
      if (!r.comprobante) return res.status(422).json({ error: r.ecf?.error || 'No se pudo pedir el comprobante.' });
      const sucursal = sucursalDe(req.authUser);
      if (sucursal && Number(r.comprobante.branchId) !== sucursal) return res.status(403).json({ error: 'Esa operación es de otra sucursal.' });
      res.status(r.repetido ? 200 : 201).json(r);
    } catch (e) { responderError(res, e); }
  });

  router.get('/:id', async (req, res) => {
    try { res.json(await propio(req)); } catch (e) { responderError(res, e); }
  });

  router.post('/:id/aprobar', exigir('comprobantes_compra.aprobar'), async (req, res) => {
    try { await propio(req); res.json(await servicio.aprobar(Number(req.params.id), req.authUser)); } catch (e) { responderError(res, e); }
  });

  router.post('/:id/no-aprobar', exigir('comprobantes_compra.aprobar'), async (req, res) => {
    try { await propio(req); res.json(await servicio.noAprobar(Number(req.params.id), req.body?.motivo, req.authUser)); } catch (e) { responderError(res, e); }
  });

  router.post('/:id/reintentar', exigir('compras.crear', 'gastos.crear', 'comprobantes_compra.aprobar'), async (req, res) => {
    try {
      const c = await propio(req);
      // Con aprobación, reenviar uno rechazado es volver a emitir: lo decide quien aprueba.
      if (c.estado === 'rechazado' && (await servicio.leerModalidad()) === 'aprobacion' && !puedeAprobar(req.authUser)) {
        return res.status(403).json({ error: 'Con la modalidad «con aprobación», reenviar un rechazado lo hace quien aprueba.' });
      }
      res.json(await servicio.reintentar(Number(req.params.id), req.authUser));
    } catch (e) { responderError(res, e); }
  });

  router.post('/:id/anular', exigir('comprobantes_compra.aprobar', 'compras.anular', 'gastos.anular'), async (req, res) => {
    try { await propio(req); res.json(await servicio.anular(Number(req.params.id), req.body?.motivo, req.authUser)); } catch (e) { responderError(res, e); }
  });

  return router;
}

module.exports = { createComprobantesCompraRouter };
