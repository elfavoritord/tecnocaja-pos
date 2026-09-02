'use strict';

/**
 * server/routes/servicios/index.js — Router raíz del modo "Empresa de Servicios".
 *
 * Se monta UNA sola vez en server.js:
 *   app.use('/api/servicios', createServiciosRouter({ ...deps }));
 *
 * Cada sub-módulo sigue el patrón factory + ensureSchema (ver rrhh/gastos).
 * `ensureServiciosSchema` también se llama desde runCoreSchemaMigrations en
 * server.js; aquí se vuelve a invocar de forma perezosa por si la migración
 * aún no corrió cuando entra el primer request.
 */

const express = require('express');
const { ensureServiciosSchema, nextServiceDocNumber } = require('./schema');
const { createCatalogoRouter } = require('./catalogo.routes');
const { createCotizacionesRouter } = require('./cotizaciones.routes');
const { createFacturacionRouter, recalcInvoice, backfillInvoiceMirror } = require('./facturacion.routes');
const { createCobrosRouter } = require('./cobros.routes');
const { createDashboardRouter } = require('./dashboard.routes');
const { createAuditoriaRouter } = require('./auditoria.routes');
const { createConfigRouter } = require('./config.routes');
const { createRecursosRouter } = require('./recursos.routes');
const { createReportesRouter } = require('./reportes.routes');
const { createContratosRouter } = require('./contratos.routes');
const { createOrdenesRouter } = require('./ordenes.routes');
const { createProyectosRouter } = require('./proyectos.routes');
const { createCalendarioRouter } = require('./calendario.routes');
const {
  createSeguridadRouter, createMantenimientoRouter, createViajesRouter,
  createCampanasRouter, createObrasRouter,
} = require('./verticales.routes');

function createServiciosRouter(baseDeps) {
  const router = express.Router();

  // ensureSchema se corre una sola vez (perezoso), no por request. La migración
  // de server.js ya lo llama en el arranque; esto cubre el primer request si la
  // migración aún no terminó.
  let schemaReady = null;
  let backfillDone = false;
  const ensureSchemaOnce = () => {
    if (!schemaReady) {
      schemaReady = ensureServiciosSchema(baseDeps.query)
        .then(async () => {
          if (!backfillDone) {
            backfillDone = true;
            await backfillInvoiceMirror(baseDeps.query, baseDeps.withTransaction).catch((e) =>
              console.warn('[servicios] backfill de espejo falló:', e.message));
          }
        })
        .catch((e) => {
          schemaReady = null; // reintenta en el próximo request si falló
          throw e;
        });
    }
    return schemaReady;
  };

  const deps = {
    ...baseDeps,
    ensureSchema: ensureSchemaOnce,
    nextServiceDocNumber,
    recalcInvoice,
  };

  // Bloquea el módulo completo si la instalación no es "empresa de servicios",
  // y garantiza el esquema antes del primer request real.
  router.use(async (req, res, next) => {
    try {
      const cfg = await baseDeps.getConfig().catch(() => ({}));
      if (!cfg || !cfg.serviceCompany) {
        return res.status(404).json({ error: 'Este módulo solo está disponible en instalaciones de Empresa de Servicios.' });
      }
      await ensureSchemaOnce();
      next();
    } catch (e) {
      next(e);
    }
  });

  router.use('/catalogo', createCatalogoRouter(deps));
  router.use('/cotizaciones', createCotizacionesRouter(deps));
  router.use('/facturas', createFacturacionRouter(deps));
  router.use('/cobros', createCobrosRouter(deps));
  router.use('/dashboard', createDashboardRouter(deps));
  router.use('/auditoria', createAuditoriaRouter(deps));
  router.use('/config', createConfigRouter(deps));
  router.use('/recursos', createRecursosRouter(deps));
  router.use('/reportes', createReportesRouter(deps));
  // M2 — órdenes, proyectos, contratos, calendario
  router.use('/contratos', createContratosRouter(deps));
  router.use('/ordenes', createOrdenesRouter(deps));
  router.use('/proyectos', createProyectosRouter(deps));
  router.use('/calendario', createCalendarioRouter(deps));
  // M3 — verticales especializados
  router.use('/seguridad', createSeguridadRouter(deps));
  router.use('/mantenimiento', createMantenimientoRouter(deps));
  router.use('/viajes', createViajesRouter(deps));
  router.use('/campanas', createCampanasRouter(deps));
  router.use('/obras', createObrasRouter(deps));

  return router;
}

module.exports = { createServiciosRouter, ensureServiciosSchema };
