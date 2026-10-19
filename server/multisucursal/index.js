'use strict';

/**
 * server/multisucursal/index.js — Punto de entrada del módulo multisucursal
 * (factory con dependencias inyectadas, ver docs/ARCHITECTURE.md).
 *
 * Fase 2: identidad (uuid), bandejas de sincronización, acceso por sucursal
 * y migraciones numeradas. Fase 3: enlace con la Sync API. Fases 4, 5 y 7:
 * catálogo y usuarios de la empresa, sincronización y rangos NCF.
 * Ver docs/MULTISUCURSAL-*.md.
 */

const migraciones = require('../migrations/multisucursal');
const { createMigrationRunner } = require('../migrations/runner');
const { createIdentidad } = require('./identidad');
const { createBandejas } = require('./bandejas');
const { createAccesoSucursales } = require('./acceso-sucursales');
const { createEnlaceCentral } = require('./enlace');
const { createCatalogoLocal } = require('./catalogo-local');
const { createNcfCentral } = require('./ncf-central');
const { createSincronizacion } = require('./sincronizacion');

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
  // Bitácora de auditoría del POS (writeAuditLog) y aviso de que llegaron
  // productos/usuarios de la central (para refrescar cachés).
  auditar = async () => {},
  alAplicar = () => {},
  // Perfil del negocio que la principal publica (tipo, moneda, ITBIS, RNC).
  getPerfilNegocio = async () => null,
  cicloMs,
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
  let sincronizacion = null;
  const enlace = createEnlaceCentral({
    query, identidad, bandejas, env, persistEnv, getEquipo, getModo, logger,
    ...(fetchImpl ? { fetchImpl } : {}),
    extrasLatido: () => (sincronizacion ? sincronizacion.extrasLatido() : Promise.resolve({})),
    alCambiarIdentidad: () => alAplicar(),
    getPerfilNegocio,
  });
  const ncf = createNcfCentral({ query, withTransaction, bandejas, identidad, auditar, logger });
  sincronizacion = createSincronizacion({
    query, withTransaction, dialect, identidad, bandejas, enlace, ncf, logger, auditar, alAplicar,
    ...(cicloMs ? { cicloMs } : {}),
  });
  const catalogo = createCatalogoLocal({ query, enlace, alCambiar: () => sincronizacion.pronto() });

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
      // Solo la PC principal habla con la central (latido, identidad y
      // sincronización).
      const enlaceIniciado = resultado.skipped ? false : enlace.iniciar();
      if (enlaceIniciado) sincronizacion.iniciar();
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

  return {
    prepararAlArrancar, estado, runner, identidad, bandejas, acceso, enlace, sincronizacion, catalogo, ncf,
    esServidorPrincipal, dialect,
  };
}

module.exports = { createMultisucursal };
