'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');

setGlobalOptions({ region: 'us-central1' });

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
