'use strict';

/**
 * Configuración DGII portada literal de modules/ecf/config/ecf.config.js
 * (Desktop, solo lectura de referencia). Son URLs oficiales públicas de la
 * DGII, no secretas — se pueden copiar tal cual.
 */

const OFFICIAL_ENVIRONMENTS = Object.freeze({
  testecf: {
    key: 'testecf',
    label: 'Pre-certificación',
    baseUrl: 'https://ecf.dgii.gov.do/TesteCF',
    semillaUrl: 'https://ecf.dgii.gov.do/TesteCF/Autenticacion/api/Autenticacion/Semilla',
    validarSemillaUrl: 'https://ecf.dgii.gov.do/TesteCF/Autenticacion/api/Autenticacion/ValidarSemilla',
    recepcionUrl: 'https://ecf.dgii.gov.do/TesteCF/Recepcion/api/FacturasElectronicas',
    consultaTrackIdUrl: 'https://ecf.dgii.gov.do/TesteCF/ConsultaResultado/api/Consultas/Estado',
    facturaConsumoUrl: 'https://fc.dgii.gov.do/TesteCF/RecepcionFC/api/Recepcion/ecf',
    aprobacionComercialUrl: 'https://ecf.dgii.gov.do/TesteCF/AprobacionComercial/api/AprobacionComercial',
  },
  certecf: {
    key: 'certecf',
    label: 'Certificación',
    baseUrl: 'https://ecf.dgii.gov.do/CerteCF',
    semillaUrl: 'https://ecf.dgii.gov.do/CerteCF/Autenticacion/api/Autenticacion/Semilla',
    validarSemillaUrl: 'https://ecf.dgii.gov.do/CerteCF/Autenticacion/api/Autenticacion/ValidarSemilla',
    recepcionUrl: 'https://ecf.dgii.gov.do/CerteCF/Recepcion/api/FacturasElectronicas',
    consultaTrackIdUrl: 'https://ecf.dgii.gov.do/CerteCF/ConsultaResultado/api/Consultas/Estado',
    facturaConsumoUrl: 'https://fc.dgii.gov.do/CerteCF/RecepcionFC/api/Recepcion/ecf',
    aprobacionComercialUrl: 'https://ecf.dgii.gov.do/CerteCF/AprobacionComercial/api/AprobacionComercial',
  },
  ecf: {
    key: 'ecf',
    label: 'Producción',
    baseUrl: 'https://ecf.dgii.gov.do/eCF',
    semillaUrl: 'https://ecf.dgii.gov.do/eCF/Autenticacion/api/Autenticacion/Semilla',
    validarSemillaUrl: 'https://ecf.dgii.gov.do/eCF/Autenticacion/api/Autenticacion/ValidarSemilla',
    recepcionUrl: 'https://ecf.dgii.gov.do/eCF/Recepcion/api/FacturasElectronicas',
    consultaTrackIdUrl: 'https://ecf.dgii.gov.do/eCF/ConsultaResultado/api/Consultas/Estado',
    facturaConsumoUrl: 'https://fc.dgii.gov.do/eCF/RecepcionFC/api/Recepcion/ecf',
    aprobacionComercialUrl: 'https://ecf.dgii.gov.do/eCF/AprobacionComercial/api/AprobacionComercial',
  },
});

// ambiente en Firestore ('certificacion'/'produccion', ver fiscal.js) -> clave DGII.
const AMBIENTE_TO_DGII_ENV = {
  certificacion: 'certecf',
  produccion: 'ecf',
};

function resolveEnvironmentConfig(ambiente) {
  const key = AMBIENTE_TO_DGII_ENV[String(ambiente || '').toLowerCase()] || 'certecf';
  return { ...OFFICIAL_ENVIRONMENTS[key], dgiiEnvKey: key };
}

const E_CF_TYPES = new Set(['E31', 'E32', 'E33', 'E34', 'E41', 'E43', 'E44', 'E45']);

// Tipos soportados por signAndSend en esta primera entrega (ver plan de
// implementación) -- el resto queda reservado por requestNcf pero
// signAndSend los rechaza con un error claro en vez de intentar un XML que
// nunca se validó contra DGII real.
const SUPPORTED_ECF_TYPES = new Set(['E31', 'E32']);

const RFCE_THRESHOLD_DOP = Number(process.env.DGII_RFCE_THRESHOLD_DOP || 250000) || 250000;
const ALLOW_E32_FULL_RECEPTION = String(process.env.DGII_ALLOW_E32_FULL_RECEPTION || '').trim() === 'true';

module.exports = {
  OFFICIAL_ENVIRONMENTS,
  AMBIENTE_TO_DGII_ENV,
  resolveEnvironmentConfig,
  E_CF_TYPES,
  SUPPORTED_ECF_TYPES,
  RFCE_THRESHOLD_DOP,
  ALLOW_E32_FULL_RECEPTION,
};
