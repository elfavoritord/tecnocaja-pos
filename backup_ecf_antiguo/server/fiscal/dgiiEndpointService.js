'use strict';

const AUTH_BASES = {
  test: 'https://ecf.dgii.gov.do/testecf/autenticacion',
  certificacion: 'https://ecf.dgii.gov.do/certecf/autenticacion',
  produccion: 'https://ecf.dgii.gov.do/ecf/autenticacion'
};

const ECF_BASES = {
  test: 'https://ecf.dgii.gov.do/testecf',
  certificacion: 'https://ecf.dgii.gov.do/certecf',
  produccion: 'https://ecf.dgii.gov.do/ecf'
};

const FC_BASES = {
  test: 'https://fc.dgii.gov.do/testecf',
  produccion: 'https://fc.dgii.gov.do/ecf'
};

function normalizeEnvironment(environment) {
  const normalized = String(environment || 'test').trim().toLowerCase();
  if (normalized === 'produccion' || normalized === 'prod' || normalized === 'production') return 'produccion';
  if (normalized === 'certificacion' || normalized === 'certification') return 'certificacion';
  return 'test';
}

function getDgiiAuthUrls(environment) {
  const env = normalizeEnvironment(environment);
  const baseUrl = String(process.env[`DGII_AUTH_BASE_URL_${env.toUpperCase()}`] || AUTH_BASES[env] || AUTH_BASES.test).trim().replace(/\/+$/, '');
  return {
    environment: env,
    baseUrl,
    seedUrl: `${baseUrl}/api/autenticacion/semilla`,
    validateSeedUrl: `${baseUrl}/api/autenticacion/validarsemilla`
  };
}

function getDgiiEcfUrls(environment) {
  const env = normalizeEnvironment(environment);
  const baseUrl = String(process.env[`DGII_ECF_BASE_URL_${env.toUpperCase()}`] || ECF_BASES[env] || ECF_BASES.test).trim().replace(/\/+$/, '');
  return {
    environment: env,
    baseUrl,
    recepcionUrl: `${baseUrl}/recepcion/api/facturaselectronicas`,
    consultaResultadoUrl: `${baseUrl}/consultaresultado/api/consultas/estado`,
    consultaEstadoUrl: `${baseUrl}/consultaestado/api/consultas/estado`,
    consultaTrackIdsUrl: `${baseUrl}/consultatrackids/api/trackids/consulta`,
    aprobacionComercialUrl: `${baseUrl}/aprobacioncomercial/api/aprobacioncomercial`
  };
}

function getDgiiFcUrls(environment) {
  const env = normalizeEnvironment(environment);
  const configured = process.env[`DGII_FC_BASE_URL_${env.toUpperCase()}`];
  const fallbackBase = configured || FC_BASES[env] || (env === 'certificacion' ? '' : FC_BASES.test);
  const baseUrl = String(fallbackBase || '').trim().replace(/\/+$/, '');
  return {
    environment: env,
    available: Boolean(baseUrl),
    baseUrl,
    recepcionResumenUrl: baseUrl ? `${baseUrl}/recepcionfc/api/recepcion/ecf` : null,
    consultaResumenUrl: baseUrl ? `${baseUrl}/consultarfce/api/Consultas/Consulta` : null
  };
}

module.exports = {
  AUTH_BASES,
  ECF_BASES,
  FC_BASES,
  normalizeEnvironment,
  getDgiiAuthUrls,
  getDgiiEcfUrls,
  getDgiiFcUrls
};
