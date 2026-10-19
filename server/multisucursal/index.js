'use strict';

/**
 * server/multisucursal/index.js — Punto de entrada del módulo multisucursal
 * (factory con dependencias inyectadas, ver docs/ARCHITECTURE.md).
 *
 * Fase 2: identidad (uuid), bandejas de sincronización, acceso por sucursal
 * y migraciones numeradas. Todavía no envía ni recibe nada de la nube.
 * Ver docs/MULTISUCURSAL-DIAGNOSTICO.md.
 */

const migraciones = require('../migrations/multisucursal');
const { createMigrationRunner } = require('../migrations/runner');
const { createIdentidad } = require('./identidad');
const { createBandejas } = require('./bandejas');
const { createAccesoSucursales } = require('./acceso-sucursales');
const { createEnlaceCentral } = require('./enlace');

function createMultisucursal({
  query,
  withTransaction,
  getDbClient,
  getServerId = () => null,
  getBranchIdOverride = () => null,
  esServidorPrincipal = () => true,
  esAdministradorGeneral = () => false,
  crearRespaldoPrevio = null,
  // Interruptor de soporte (TECNO_CAJA_MULTISUCURSAL_DESACTIVAR=1): el
  // arranque queda exactamente como antes de la Fase 2.
  estaDesactivado = () => false,
  // Enlace con la Sync API (Fase 3c).
  env = process.env,
  persistEnv = () => {},
  getEquipo = () => ({}),
  getModo = () => 'normal',
  fetchImpl,
  logger = console,
}) {
  const dialect = String(getDbClient?.() || 'sqlite').toLowerCase() === 'mysql' ? 'mysql' : 'sqlite';

  const runner = createMigrationRunner({
    query,
    withTransaction,
    dialect,
    migrations: migraciones,
    logger,
    beforeApply: async (ids) => {
      if (typeof crearRespaldoPrevio !== 'function') return true;
      try {
        await crearRespaldoPrevio({ query, migraciones: ids, logger });
        return true;
      } catch (error) {
        logger.warn?.(`[migraciones] No se migra en este arranque: falló el respaldo previo (${error.message}).`);
        return false;
      }
    },
  });

  const identidad = createIdentidad({ query, dialect, getServerId, getBranchIdOverride });
  const bandejas = createBandejas({ dialect });
  const acceso = createAccesoSucursales({ query, esAdministradorGeneral });
  const enlace = createEnlaceCentral({
    query, identidad, bandejas, env, persistEnv, getEquipo, getModo, logger,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  let ultimoArranque = null;

  // Se llama al arrancar, después de las migraciones del núcleo y ANTES de la
  // recuperación automática: un respaldo nuevo trae la columna uuid y la base
  // tiene que tenerla para poder restaurarlo.
  async function prepararAlArrancar() {
    const at = new Date().toISOString();
    if (estaDesactivado()) {
      ultimoArranque = { at, omitido: 'desactivado por TECNO_CAJA_MULTISUCURSAL_DESACTIVAR' };
      return ultimoArranque;
    }
    if (!esServidorPrincipal()) {
      ultimoArranque = { at, omitido: 'terminal secundaria: migra la PC principal' };
      return ultimoArranque;
    }
    try {
      const resultado = await runner.runPending();
      const uuids = resultado.skipped ? null : await identidad.rellenarUuidsFaltantes();
      // Solo la PC principal habla con la central (latido e identidad).
      const enlaceIniciado = resultado.skipped ? false : enlace.iniciar();
      ultimoArranque = { at, ...resultado, uuidsAsignados: uuids, enlaceIniciado };
    } catch (error) {
      ultimoArranque = { at, error: error.message };
      logger.error?.('[multisucursal] Falló la preparación del esquema:', error.message);
    }
    return ultimoArranque;
  }

  async function estado() {
    const [ident, migr, resumen, enl] = await Promise.all([
      identidad.obtener().catch((error) => ({ error: error.message })),
      runner.status().catch((error) => ({ error: error.message })),
      bandejas.resumen(query).catch(() => null),
      enlace.estado().catch((error) => ({ error: error.message })),
    ]);
    return { identidad: ident, migraciones: migr, bandejas: resumen, enlace: enl, ultimoArranque };
  }

  return { prepararAlArrancar, estado, runner, identidad, bandejas, acceso, enlace, esServidorPrincipal, dialect };
}

module.exports = { createMultisucursal };
