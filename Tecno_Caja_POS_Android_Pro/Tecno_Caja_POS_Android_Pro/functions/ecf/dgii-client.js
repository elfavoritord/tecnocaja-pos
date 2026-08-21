'use strict';

/**
 * Cliente HTTP contra los endpoints reales de DGII, con `fetch`/`FormData`
 * nativos de Node 20 (mismo patrón ya usado en certification.js) en vez de
 * axios/form-data -- evita dos dependencias nuevas. Formas de request
 * portadas de modules/ecf/dgii/client.js y
 * modules/ecf/services/reception.service.js (Desktop, solo lectura de
 * referencia): multipart con campo `xml`, `Authorization: Bearer {token}`.
 */

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractTagValue(source, tagName) {
  const match = String(source || '').match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i'));
  return match?.[1] ? match[1].trim() : '';
}

function parseAuthResponse(body) {
  const raw = String(body || '').trim();
  try {
    const json = JSON.parse(raw);
    return {
      token: String(json.token || json.Token || '').trim(),
      expedido: json.expedido || json.Expedido || null,
      expira: json.expira || json.Expira || null,
      raw,
    };
  } catch (_) {
    return {
      token: extractTagValue(raw, 'token'),
      expedido: extractTagValue(raw, 'expedido') || null,
      expira: extractTagValue(raw, 'expira') || null,
      raw,
    };
  }
}

function parseSeedResponse(body) {
  const raw = String(body || '').trim();
  const directXml = /<SemillaModel\b/i.test(raw) ? raw : decodeXmlEntities(extractTagValue(raw, 'string'));
  const seedXml = directXml && /<SemillaModel\b/i.test(directXml) ? directXml : raw;
  return {
    raw,
    xml: seedXml,
    value: extractTagValue(seedXml, 'valor') || extractTagValue(raw, 'valor'),
    fecha: extractTagValue(seedXml, 'fecha') || extractTagValue(raw, 'fecha'),
  };
}

function parseTrackResponse(body) {
  const raw = String(body || '').trim();
  try {
    const json = JSON.parse(raw) || {};
    return {
      ...json,
      fecha: json.fechaRecepcion || json.FechaRecepcion || json.fecha || json.Fecha || null,
      mensajes: Array.isArray(json.mensajes || json.Mensajes) ? (json.mensajes || json.Mensajes) : [],
      rnc: json.rnc || json.RNC || json.rncemisor || json.RNCEmisor || null,
      encf: json.encf || json.eNCF || json.NCFElectronico || null,
      secuenciaUtilizada: json.secuenciaUtilizada ?? json.SecuenciaUtilizada ?? null,
      fechaRecepcion: json.fechaRecepcion || json.FechaRecepcion || null,
      raw,
    };
  } catch (_) {
    return {
      estado: extractTagValue(raw, 'estado') || extractTagValue(raw, 'Estado'),
      mensaje: extractTagValue(raw, 'mensaje') || extractTagValue(raw, 'Message'),
      trackId: extractTagValue(raw, 'trackId') || extractTagValue(raw, 'TrackId'),
      fecha: extractTagValue(raw, 'fechaRecepcion') || extractTagValue(raw, 'FechaRecepcion') || null,
      rnc: extractTagValue(raw, 'rnc') || extractTagValue(raw, 'RNC') || null,
      encf: extractTagValue(raw, 'encf') || extractTagValue(raw, 'eNCF') || null,
      secuenciaUtilizada: extractTagValue(raw, 'secuenciaUtilizada') || extractTagValue(raw, 'SecuenciaUtilizada') || null,
      fechaRecepcion: extractTagValue(raw, 'fechaRecepcion') || extractTagValue(raw, 'FechaRecepcion') || null,
      mensajes: [],
      raw,
    };
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.text();
  return { status: response.status, body };
}

async function getSeed(semillaUrl) {
  const { status, body } = await fetchWithTimeout(semillaUrl, {
    method: 'GET',
    headers: { Accept: 'application/xml, text/xml, */*' },
  }, 30000);
  if (status !== 200) {
    throw new Error(`DGII no entregó la semilla. HTTP ${status}`);
  }
  return parseSeedResponse(body);
}

async function validateSeed(validarSemillaUrl, signedXml) {
  if (!String(signedXml || '').trim()) throw new Error('No hay semilla firmada para enviar a DGII.');
  const form = new FormData();
  form.append('xml', new Blob([signedXml], { type: 'text/xml' }), `semilla-${Date.now()}.xml`);
  const { status, body } = await fetchWithTimeout(validarSemillaUrl, { method: 'POST', body: form }, 30000);
  const parsed = parseAuthResponse(body);
  return { ...parsed, httpStatus: status };
}

async function submitXml(url, token, signedXml, { fieldFileName = null } = {}) {
  if (!token) throw new Error('No hay token DGII disponible para enviar el documento.');
  const form = new FormData();
  form.append('xml', new Blob([signedXml], { type: 'text/xml' }), fieldFileName || `documento-${Date.now()}.xml`);
  const { status, body } = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
    body: form,
  }, 45000);
  const parsed = parseTrackResponse(body);
  if (status >= 400) {
    const error = new Error(parsed.error || parsed.descripcion || parsed.mensaje || `DGII rechazó el envío. HTTP ${status}`);
    error.httpStatus = status;
    error.dgiiResponse = parsed;
    throw error;
  }
  return { ...parsed, httpStatus: status };
}

async function sendEcf(recepcionUrl, token, signedXml) {
  return submitXml(recepcionUrl, token, signedXml, { fieldFileName: `ecf-${Date.now()}.xml` });
}

async function sendRfce(facturaConsumoUrl, token, signedXml) {
  return submitXml(facturaConsumoUrl, token, signedXml, { fieldFileName: `rfce-${Date.now()}.xml` });
}

async function queryTrackStatus(consultaTrackIdUrl, token, trackId) {
  if (!trackId) throw new Error('Debe indicar un TrackId para consultar estado.');
  const url = `${consultaTrackIdUrl}?trackid=${encodeURIComponent(trackId)}`;
  const { status, body } = await fetchWithTimeout(url, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }, 30000);
  const parsed = parseTrackResponse(body);
  if (status >= 400) {
    const error = new Error(parsed.error || parsed.descripcion || parsed.mensaje || `DGII rechazó la consulta. HTTP ${status}`);
    error.httpStatus = status;
    error.dgiiResponse = parsed;
    throw error;
  }
  return { ...parsed, httpStatus: status };
}

module.exports = { getSeed, validateSeed, sendEcf, sendRfce, queryTrackStatus };
