'use strict';

const path = require('path');

const ENVIRONMENT_ALIASES = {
  test: 'testecf',
  testecf: 'testecf',
  pre: 'testecf',
  precertificacion: 'testecf',
  precertificación: 'testecf',

  cert: 'certecf',
  certecf: 'certecf',
  certificacion: 'certecf',
  certificación: 'certecf',

  prod: 'ecf',
  production: 'ecf',
  produccion: 'ecf',
  producción: 'ecf',
  ecf: 'ecf',
};

const OFFICIAL_ENVIRONMENTS = Object.freeze({

  testecf: {
    key: 'testecf',
    label: 'Pre-certificación',

    baseUrl: 'https://ecf.dgii.gov.do/TesteCF',
    authUrl: 'https://ecf.dgii.gov.do/TesteCF/Autenticacion',

    semillaUrl:
      'https://ecf.dgii.gov.do/TesteCF/Autenticacion/api/Autenticacion/Semilla',

    validarSemillaUrl:
      'https://ecf.dgii.gov.do/TesteCF/Autenticacion/api/Autenticacion/ValidarSemilla',

    recepcionUrl:
      'https://ecf.dgii.gov.do/TesteCF/Recepcion/api/FacturasElectronicas',

    consultaTrackIdUrl:
      'https://ecf.dgii.gov.do/TesteCF/ConsultaResultado/api/Consultas/Estado',

    consultaEstadoUrl:
      'https://ecf.dgii.gov.do/TesteCF/ConsultaResultado/api/Consultas/Estado',

    facturaConsumoUrl:
      'https://fc.dgii.gov.do/TesteCF/RecepcionFC/api/Recepcion/ecf'
  },

  certecf: {
    key: 'certecf',
    label: 'Certificación',

    baseUrl: 'https://ecf.dgii.gov.do/CerteCF',
    authUrl: 'https://ecf.dgii.gov.do/CerteCF/Autenticacion',

    semillaUrl:
      'https://ecf.dgii.gov.do/CerteCF/Autenticacion/api/Autenticacion/Semilla',

    validarSemillaUrl:
      'https://ecf.dgii.gov.do/CerteCF/Autenticacion/api/Autenticacion/ValidarSemilla',

    recepcionUrl:
      'https://ecf.dgii.gov.do/CerteCF/Recepcion/api/FacturasElectronicas',

    consultaTrackIdUrl:
      'https://ecf.dgii.gov.do/CerteCF/ConsultaResultado/api/Consultas/Estado',

    consultaEstadoUrl:
      'https://ecf.dgii.gov.do/CerteCF/ConsultaResultado/api/Consultas/Estado',

    facturaConsumoUrl:
      'https://fc.dgii.gov.do/CerteCF/RecepcionFC/api/Recepcion/ecf'
  },

  ecf: {
    key: 'ecf',
    label: 'Producción',

    baseUrl: 'https://ecf.dgii.gov.do/eCF',
    authUrl: 'https://ecf.dgii.gov.do/eCF/Autenticacion',

    semillaUrl:
      'https://ecf.dgii.gov.do/eCF/Autenticacion/api/Autenticacion/Semilla',

    validarSemillaUrl:
      'https://ecf.dgii.gov.do/eCF/Autenticacion/api/Autenticacion/ValidarSemilla',

    recepcionUrl:
      'https://ecf.dgii.gov.do/eCF/Recepcion/api/FacturasElectronicas',

    consultaTrackIdUrl:
      'https://ecf.dgii.gov.do/eCF/ConsultaResultado/api/Consultas/Estado',

    consultaEstadoUrl:
      'https://ecf.dgii.gov.do/eCF/ConsultaResultado/api/Consultas/Estado',

    facturaConsumoUrl:
      'https://fc.dgii.gov.do/eCF/RecepcionFC/api/Recepcion/ecf'
  }
});

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on']
    .includes(String(value).trim().toLowerCase());
}

function normalizeEnvironmentKey(value) {
  const normalized =
    String(value || 'testecf')
      .trim()
      .toLowerCase();

  return ENVIRONMENT_ALIASES[normalized] || 'testecf';
}

function resolveEnvironmentConfig(environment) {
  const key = normalizeEnvironmentKey(environment);
  return { ...OFFICIAL_ENVIRONMENTS[key] };
}

function safeUrl(value, fallback = '') {
  const url = String(value || fallback).trim();

  if (!url) {
    return '';
  }

  try {
    return new URL(url).toString();
  } catch {
    return fallback || '';
  }
}

function buildEcfConfig(overrides = {}) {

  const environmentKey =
    normalizeEnvironmentKey(
      overrides.DGII_ENV ||
      process.env.DGII_ENV ||
      'testecf'
    );

  const official =
    resolveEnvironmentConfig(environmentKey);

  const certPath = String(
    overrides.CERT_PATH ||
    process.env.CERT_PATH ||
    ''
  ).trim();

  return {

    DGII_ENV: environmentKey,

    DGII_BASE_URL:
      safeUrl(
        overrides.DGII_BASE_URL ||
        process.env.DGII_BASE_URL,
        official.baseUrl
      ),

    DGII_AUTH_URL:
      safeUrl(
        overrides.DGII_AUTH_URL ||
        process.env.DGII_AUTH_URL,
        official.authUrl
      ),

    DGII_RECEPCION_URL:
      safeUrl(
        overrides.DGII_RECEPCION_URL ||
        process.env.DGII_RECEPCION_URL,
        official.recepcionUrl
      ),

    DGII_CONSULTA_URL:
      safeUrl(
        overrides.DGII_CONSULTA_URL ||
        process.env.DGII_CONSULTA_URL,
        official.consultaTrackIdUrl
      ),

    DGII_CONSULTA_ESTADO_URL:
      safeUrl(
        overrides.DGII_CONSULTA_ESTADO_URL ||
        process.env.DGII_CONSULTA_ESTADO_URL,
        official.consultaEstadoUrl
      ),

    DGII_FC_URL:
      safeUrl(
        overrides.DGII_FC_URL ||
        process.env.DGII_FC_URL,
        official.facturaConsumoUrl
      ),

    DGII_SEMILLA_URL:
      safeUrl(
        overrides.DGII_SEMILLA_URL ||
        process.env.DGII_SEMILLA_URL,
        official.semillaUrl
      ),

    DGII_VALIDAR_SEMILLA_URL:
      safeUrl(
        overrides.DGII_VALIDAR_SEMILLA_URL ||
        process.env.DGII_VALIDAR_SEMILLA_URL,
        official.validarSemillaUrl
      ),

    DGII_RNC:
      String(
        overrides.DGII_RNC ||
        process.env.DGII_RNC ||
        ''
      ).trim(),

    DGII_USER:
      String(
        overrides.DGII_USER ||
        process.env.DGII_USER ||
        ''
      ).trim(),

    DGII_PASSWORD:
      String(
        overrides.DGII_PASSWORD ||
        process.env.DGII_PASSWORD ||
        ''
      ).trim(),

    CERT_PATH:
      certPath
        ? path.resolve(certPath)
        : '',

    CERT_PASSWORD:
      String(
        overrides.CERT_PASSWORD ||
        process.env.CERT_PASSWORD ||
        ''
      ).trim(),

    TOKEN_DURATION:
      Number(
        overrides.TOKEN_DURATION ||
        process.env.TOKEN_DURATION ||
        3600
      ) || 3600,

    DEBUG_ECF:
      toBoolean(
        overrides.DEBUG_ECF ||
        process.env.DEBUG_ECF,
        true
      ),

    DGII_RFCE_THRESHOLD_DOP:
      Number(
        overrides.DGII_RFCE_THRESHOLD_DOP ||
        process.env.DGII_RFCE_THRESHOLD_DOP ||
        250000
      ) || 250000,

    DGII_ALLOW_E32_FULL_RECEPTION:
      toBoolean(
        overrides.DGII_ALLOW_E32_FULL_RECEPTION ||
        process.env.DGII_ALLOW_E32_FULL_RECEPTION,
        false
      ),

    officialEnvironment: official
  };
}

module.exports = {
  ENVIRONMENT_ALIASES,
  OFFICIAL_ENVIRONMENTS,
  buildEcfConfig,
  normalizeEnvironmentKey,
  resolveEnvironmentConfig,
  toBoolean
};