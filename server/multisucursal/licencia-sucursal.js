'use strict';

/**
 * server/multisucursal/licencia-sucursal.js — Una PC de sucursal trabaja con
 * la LICENCIA DE LA EMPRESA (plan, estado y vencimiento de la principal).
 *
 * La PC conserva su propio documento en `licencias` (TECNO_CAJA_LICENSE_UID,
 * marcado `sucursalDe`) para que las sincronizaciones viejas de la nube, que
 * van atadas a ese id y a los ids locales, nunca escriban sobre los datos de
 * la principal. Pero lo que decide si puede trabajar es la licencia de la
 * empresa: si Emilio la activa, la renueva o la suspende, la sucursal la sigue.
 *
 * Cuándo aplica: la PC está enlazada con la central (token), no es la
 * principal, no fue reemplazada ni revocada y la empresa es otra licencia.
 * Si no, se usa la licencia propia como siempre.
 *
 * El límite de equipos de la licencia no se aplica a las PC de sucursal: las
 * limitan el número de sucursales (maxSucursales) y una PC por sucursal.
 */

const ENLACE_CERRADO = new Set(['reemplazado', 'revocado']);

function texto(valor) {
  return String(valor == null ? '' : valor).trim();
}

function createLicenciaSucursal({
  // () => enlace de multisucursal (puede no existir todavía al arrancar).
  getEnlace = () => null,
  // (licenseId) => datos del documento licencias/{id} o null si no existe.
  leerLicencia,
  getLicenciaPropia = () => process.env.TECNO_CAJA_LICENSE_UID,
  logger = console,
}) {
  let suscripcion = null;

  // La licencia de la empresa si esta PC es una sucursal enlazada; si no, null.
  async function empresaDeEstaPc() {
    const enlace = getEnlace();
    if (!enlace) return null;
    const e = await enlace.estado().catch(() => null);
    if (!e?.tieneToken || ENLACE_CERRADO.has(e.estado)) return null;
    if (e.sucursal?.esPrincipal) return null;
    const empresa = texto(e.empresa?.licenseId);
    if (!empresa || empresa === texto(getLicenciaPropia())) return null;
    return empresa;
  }

  // `propia`: lo que devolvió fetchRemotePosLicenseState para esta PC (o null).
  // Devuelve el mismo formato, con el estado de la empresa y el id PROPIO (el
  // servicio de licencias guarda ese id como TECNO_CAJA_LICENSE_UID: nunca
  // debe quedar el de la empresa).
  async function combinar(propia) {
    const empresaId = await empresaDeEstaPc();
    if (!empresaId) return propia;
    // Si no se puede leer, que falle: el servicio usa la copia guardada (la
    // de la empresa de la vez anterior) en vez de la prueba propia.
    const empresa = await leerLicencia(empresaId);
    if (!empresa || empresa.deleted) {
      logger.warn?.(`[licencia-sucursal] La licencia de la empresa (${empresaId}) no existe o está en la papelera: se usa la de esta PC.`);
      return propia;
    }
    const propioId = texto(getLicenciaPropia()) || texto(propia?.id);
    const fechas = {
      issuedAt: empresa.issuedAt || empresa.trialStartedAt || null,
      expiresAt: empresa.expiresAt ?? null,
      trialStartedAt: empresa.trialStartedAt ?? null,
      trialEndsAt: empresa.trialEndsAt ?? null,
    };
    const planCode = texto(empresa.planCode || empresa.plan_code).toLowerCase() || null;
    return {
      ...(propia || {}),
      id: propioId,
      licenseId: propioId,
      status: empresa.status || 'trial',
      planCode,
      ...fechas,
      deviceLimit: 0,
      signature: null,
      signatureAlg: null,
      devices: propia?.devices || {},
      docData: {
        ...(propia?.docData || {}),
        ...fechas,
        expires_at: null,
        status: empresa.status || 'trial',
        forceBlocked: Boolean(empresa.forceBlocked),
        planCode,
        plan_code: planCode,
        deviceLimit: 0,
        device_limit: 0,
        signature: null,
        deviceSignatures: null,
        licenciaDeLaEmpresa: empresaId,
      },
    };
  }

  // Avisos en tiempo real cuando Emilio cambia la licencia de la empresa.
  // `suscribir(id, alCambiar)` devuelve la función para cancelar.
  async function vigilar(suscribir, alCambiar) {
    const empresaId = await empresaDeEstaPc().catch(() => null);
    if (suscripcion?.empresaId === empresaId) return Boolean(empresaId);
    try { suscripcion?.cancelar?.(); } catch (_) { /* ya estaba cerrada */ }
    suscripcion = null;
    if (!empresaId) return false;
    try {
      suscripcion = { empresaId, cancelar: suscribir(empresaId, alCambiar) };
      return true;
    } catch (error) {
      logger.warn?.('[licencia-sucursal] No se pudo vigilar la licencia de la empresa:', error.message);
      return false;
    }
  }

  return { empresaDeEstaPc, combinar, vigilar };
}

module.exports = { createLicenciaSucursal };
