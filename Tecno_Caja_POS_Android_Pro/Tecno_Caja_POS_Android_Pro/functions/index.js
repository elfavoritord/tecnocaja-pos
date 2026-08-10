'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

setGlobalOptions({ region: 'us-central1' });

// Una sola app de Admin SDK para todas las funciones de este proyecto.
// companies.js y fiscal.js llaman admin.firestore() asumiendo que esto ya
// corrió — por eso se inicializa acá, antes de requerirlos.
admin.initializeApp();

// ── Empresa 100% móvil (sin depender de Tecno Caja POS Windows) ────────────
const { createMobileCompany } = require('./companies');
exports.createMobileCompany = createMobileCompany;

// ── Apertura móvil de una empresa POS ya sincronizada en la nube ─────────
const { getMyCompanyBootstrap } = require('./mobile-bootstrap');
exports.getMyCompanyBootstrap = getMyCompanyBootstrap;

const { createBusinessUser, updateBusinessUser } = require('./users');
exports.createBusinessUser = createBusinessUser;
exports.updateBusinessUser = updateBusinessUser;

const {
  acquireCashRegister,
  releaseCashRegister,
  getMyOpenCashRegister,
} = require('./cash-registers');
exports.acquireCashRegister = acquireCashRegister;
exports.releaseCashRegister = releaseCashRegister;
exports.getMyOpenCashRegister = getMyOpenCashRegister;

const { syncSales } = require('./sales-sync');
exports.syncSales = syncSales;

const { getMyBusinessLicense } = require('./licenses');
exports.getMyBusinessLicense = getMyBusinessLicense;

// ── Servicio fiscal central: único árbitro de NCF/e-CF ─────────────────────
const { requestNcf, configureNcfSequence, listNcfSequences } = require('./fiscal');
exports.requestNcf = requestNcf;
exports.configureNcfSequence = configureNcfSequence;
exports.listNcfSequences = listNcfSequences;

/**
 * dgiiLookup — Consulta RNC/Cédula en el registro DGII
 *
 * Callable desde Flutter (web y mobile) sin problemas de CORS.
 * Llama a api.digital.gob.do desde el servidor (sin restricciones de origen).
 *
 * Input:  { rnc: "40211932609" }
 * Output: { found: bool, rnc, nombre, nombreComercial, estado, tipo, categoria }
 */
exports.dgiiLookup = onCall({ cors: true }, async (request) => {
  const raw = String(request.data?.rnc || '').replace(/\D/g, '');

  if (!raw || raw.length < 9) {
    throw new HttpsError('invalid-argument', 'Proporciona un RNC o cédula válida (9-11 dígitos).');
  }

  // Intentar con api.digital.gob.do (fuente primaria OGTIC)
  const result = await _fetchDigital(raw)
    ?? await _fetchDatos(raw);

  if (!result) {
    return { found: false, rnc: raw };
  }

  return { found: true, ...result };
});

async function _fetchDigital(rnc) {
  try {
    const { default: fetch } = await import('node-fetch');
    const res = await fetch(`https://api.digital.gob.do/v3/rnc/${rnc}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || !json.nombre) return null;
    return _normalizar(json, rnc);
  } catch {
    return null;
  }
}

async function _fetchDatos(rnc) {
  try {
    const { default: fetch } = await import('node-fetch');
    const res = await fetch(`https://api.datos.gob.do/v1/rnc/${rnc}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const item = Array.isArray(json) ? json[0] : json;
    if (!item || !item.nombre) return null;
    return _normalizar(item, rnc);
  } catch {
    return null;
  }
}

function _normalizar(json, rnc) {
  const tipo = (json.tipo || '').toUpperCase();
  return {
    rnc: json.rnc || rnc,
    nombre: json.nombre || '',
    nombreComercial: json.nombre_comercial || json.nombreComercial || null,
    estado: json.estado || 'ACTIVO',
    tipo: tipo.includes('FISICA') || tipo.includes('FÍSICA') || tipo.includes('PERSONA FÍSICA')
      ? 'FISICO' : 'JURIDICO',
    categoria: json.categoria || json.actividad_economica || null,
  };
}
