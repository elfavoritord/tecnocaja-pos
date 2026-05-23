'use strict';

const crypto = require('crypto');

const { getActiveToken, httpGet, httpPostMultipart } = require('./dgiiAuthService');
const xmlSvc = require('./ecfXmlService');
const { writeFiscalAuditLog } = require('./fiscalExtensions');
const { getDgiiEcfUrls, getDgiiFcUrls, normalizeEnvironment } = require('./dgiiEndpointService');
const { createDgiiRequestLog, finalizeDgiiRequestLog, truncateText } = require('./dgiiRequestLogService');

const MAX_AUTO_RETRIES = 3;
const RFCE_THRESHOLD_DOP = Number(process.env.DGII_RFCE_THRESHOLD_DOP || 250000);
const ALLOW_E32_FULL_RECEPTION = String(process.env.DGII_ALLOW_E32_FULL_RECEPTION || '').trim().toLowerCase() === 'true';

async function sendElectronicDocument(queryFn, ecfDocumentId) {
  const rows = await queryFn('SELECT * FROM ecf_documents WHERE id = ? LIMIT 1', [ecfDocumentId]);
  const doc = rows[0];
  if (!doc) throw Object.assign(new Error('Documento e-CF no encontrado.'), { statusCode: 404 });

  if (doc.estado_dgii === 'aceptado') {
    return { ok: true, trackId: doc.track_id, estado: 'aceptado', mensaje: 'Ya fue aceptado por DGII.' };
  }

  const businessId = Number(doc.business_id || 0) || 1;
  const environment = normalizeEnvironment(doc.ambiente || 'test');
  const signedXml = doc.signed_xml_content;
  if (!signedXml) {
    await markDocumentError(queryFn, doc, 'error_xml', 'No hay XML firmado disponible.');
    throw new Error('No hay XML firmado disponible para este documento.');
  }

  const submission = resolveSubmissionTarget(doc, environment);
  if (submission.blocked) {
    await markDocumentPending(queryFn, doc, submission.reason, 'pendiente_rfce');
    return { ok: false, estado: 'pendiente_rfce', mensaje: submission.reason };
  }

  let auth;
  try {
    auth = await getActiveToken(queryFn, businessId);
  } catch (authErr) {
    await markDocumentError(queryFn, doc, 'error_auth', authErr.message);
    throw authErr;
  }

  const requestId = `dgii-send-${ecfDocumentId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const logId = await createDgiiRequestLog(queryFn, {
    requestId,
    businessId,
    endpointType: 'dgii_recepcion_ecf',
    direction: 'outbound',
    httpMethod: 'POST',
    routePath: submission.url,
    environment,
    contentType: 'multipart/form-data',
    payloadFormat: 'xml',
    payloadSha256: sha256(signedXml),
    payloadSize: Buffer.byteLength(signedXml, 'utf8'),
    requestPayload: truncateText(signedXml, 4000)
  }).catch(() => null);

  try {
    const response = await httpPostMultipart(
      submission.url,
      [
        {
          name: 'xml',
          filename: `${doc.encf || `ecf-${ecfDocumentId}`}.xml`,
          contentType: 'text/xml',
          value: signedXml
        }
      ],
      {
        Authorization: `Bearer ${auth.token}`,
        Accept: 'application/json, application/xml, text/xml'
      }
    );

    const parsed = parseReceptionResponse(response.body);
    const trackId = parsed.trackId || doc.track_id || null;
    const externalState = mapDGIIStatus(parsed.estado || parsed.state || parsed.status || '');
    const responseMessage = buildMessage(parsed);

    if (response.status === 401 || response.status === 403) {
      await markDocumentError(queryFn, doc, 'error_auth', `DGII rechazó el token: HTTP ${response.status}`);
      throw new Error('DGII rechazó el token. Vuelve a autenticar la empresa.');
    }

    if (response.status < 200 || response.status >= 300 || (!trackId && !['aceptado', 'aceptado_condicional'].includes(externalState))) {
      await markDocumentPending(queryFn, doc, responseMessage || `DGII respondió HTTP ${response.status}`, 'pendiente');
      await finalizeDgiiRequestLog(queryFn, logId, {
        responseStatus: response.status,
        responseCode: 'DGII-RECEPCION-PEND',
        responseMessage,
        responsePayload: truncateText(String(response.body || ''), 4000)
      });
      return { ok: false, estado: 'pendiente', mensaje: responseMessage || `HTTP ${response.status}` };
    }

    await queryFn(
      `UPDATE ecf_documents
       SET track_id = COALESCE(?, track_id),
           is_sent = 1,
           estado_dgii = ?,
           mensajes_dgii = ?,
           retry_count = retry_count + 1,
           last_retry_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        trackId,
        trackId ? 'enviado' : (externalState || 'enviado'),
        truncateText(responseMessage, 500),
        ecfDocumentId
      ]
    );
    await syncSaleSummary(queryFn, doc.sale_id, {
      ecfEstado: trackId ? 'enviado' : (externalState || 'enviado'),
      ecfTrackId: trackId
    });

    await writeFiscalAuditLog(queryFn, {
      businessId,
      action: 'ecf_enviado',
      description: `e-CF ${doc.encf} enviado a DGII. TrackId: ${trackId || 'sin TrackID en respuesta'}`
    }).catch(() => {});

    await finalizeDgiiRequestLog(queryFn, logId, {
      responseStatus: response.status,
      responseCode: 'DGII-RECEPCION-OK',
      responseMessage,
      responsePayload: truncateText(String(response.body || ''), 4000)
    });

    if (trackId) {
      const status = await getStatusByTrackId(queryFn, ecfDocumentId, trackId);
      return { ok: true, trackId, estado: status.estado, mensaje: status.mensaje };
    }

    if (['aceptado', 'aceptado_condicional'].includes(externalState)) {
      await ensureAcceptedQr(queryFn, { ...doc, track_id: trackId, estado_dgii: externalState });
    }

    return {
      ok: true,
      trackId: null,
      estado: externalState || 'enviado',
      mensaje: responseMessage || 'Documento enviado a DGII.'
    };
  } catch (error) {
    await markDocumentPending(queryFn, doc, `Error de red o transporte: ${error.message}`, 'pendiente_red');
    await finalizeDgiiRequestLog(queryFn, logId, {
      responseStatus: 500,
      responseCode: 'DGII-RECEPCION-ERR',
      responseMessage: 'Error enviando XML a DGII.',
      errorMessage: error.message
    });
    return { ok: false, estado: 'pendiente_red', mensaje: error.message };
  }
}

async function getStatusByTrackId(queryFn, ecfDocumentId, trackId) {
  const rows = await queryFn('SELECT * FROM ecf_documents WHERE id = ? LIMIT 1', [ecfDocumentId]);
  const doc = rows[0];
  if (!doc) return { estado: 'desconocido', mensaje: 'Documento no encontrado.' };
  if (!trackId) return { estado: 'pendiente', mensaje: 'No hay TrackID disponible.' };

  let auth;
  try {
    auth = await getActiveToken(queryFn, doc.business_id);
  } catch (_) {
    return { estado: 'error_auth', mensaje: 'No se pudo obtener token para consultar estado.' };
  }

  const urls = getDgiiEcfUrls(doc.ambiente || auth.environment || 'test');
  const requestUrl = `${urls.consultaResultadoUrl}?trackid=${encodeURIComponent(trackId)}`;
  const requestId = `dgii-status-${ecfDocumentId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const logId = await createDgiiRequestLog(queryFn, {
    requestId,
    businessId: doc.business_id,
    endpointType: 'dgii_consulta_resultado',
    direction: 'outbound',
    httpMethod: 'GET',
    routePath: requestUrl,
    environment: urls.environment,
    contentType: 'application/json'
  }).catch(() => null);

  try {
    const response = await httpGet(requestUrl, {
      Authorization: `Bearer ${auth.token}`,
      Accept: 'application/json, application/xml, text/xml'
    });

    const parsed = parseStatusResponse(response.body);
    const estado = mapDGIIStatus(parsed.estado || parsed.state || parsed.status || '');
    const mensaje = buildMessage(parsed);

    await queryFn(
      `UPDATE ecf_documents
       SET estado_dgii = ?,
           mensajes_dgii = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [estado, truncateText(mensaje, 500), ecfDocumentId]
    );
    await syncSaleSummary(queryFn, doc.sale_id, { ecfEstado: estado, ecfTrackId: trackId });
    if (['aceptado', 'aceptado_condicional'].includes(estado)) {
      await ensureAcceptedQr(queryFn, { ...doc, track_id: trackId, estado_dgii: estado });
    }

    await finalizeDgiiRequestLog(queryFn, logId, {
      responseStatus: response.status,
      responseCode: 'DGII-CONSULTA-TRACKID',
      responseMessage: mensaje,
      responsePayload: truncateText(String(response.body || ''), 4000)
    });

    return { estado, mensaje, raw: parsed };
  } catch (error) {
    await finalizeDgiiRequestLog(queryFn, logId, {
      responseStatus: 500,
      responseCode: 'DGII-CONSULTA-ERR',
      responseMessage: 'Error consultando TrackID.',
      errorMessage: error.message
    });
    return { estado: 'error_consulta', mensaje: error.message };
  }
}

async function lookupTrackIdsByENCF(queryFn, { businessId, environment, rncEmisor, encf }) {
  const auth = await getActiveToken(queryFn, businessId);
  const urls = getDgiiEcfUrls(environment || auth.environment || 'test');
  const requestUrl = `${urls.consultaTrackIdsUrl}?rncemisor=${encodeURIComponent(rncEmisor)}&encf=${encodeURIComponent(encf)}`;
  const response = await httpGet(requestUrl, {
    Authorization: `Bearer ${auth.token}`,
    Accept: 'application/json, application/xml, text/xml'
  });
  return parseTrackIdsResponse(response.body);
}

async function getDocumentState(queryFn, ecfDocumentId) {
  const rows = await queryFn('SELECT * FROM ecf_documents WHERE id = ? LIMIT 1', [ecfDocumentId]);
  const doc = rows[0];
  if (!doc) throw Object.assign(new Error('Documento e-CF no encontrado.'), { statusCode: 404 });

  const auth = await getActiveToken(queryFn, doc.business_id);
  const urls = getDgiiEcfUrls(doc.ambiente || auth.environment || 'test');
  const rncComprador = doc.rnc_comprador ? `&rnccomprador=${encodeURIComponent(doc.rnc_comprador)}` : '';
  const requestUrl = `${urls.consultaEstadoUrl}?rncemisor=${encodeURIComponent(doc.rnc_emisor || '')}&ncfelectronico=${encodeURIComponent(doc.encf || '')}${rncComprador}&codigoseguridad=${encodeURIComponent(doc.codigo_seguridad || '')}`;
  const response = await httpGet(requestUrl, {
    Authorization: `Bearer ${auth.token}`,
    Accept: 'application/json, application/xml, text/xml'
  });
  const parsed = parseStatusResponse(response.body);
  const estado = mapDGIIStatus(parsed.estado || parsed.state || parsed.status || '');
  const mensaje = buildMessage(parsed);

  await queryFn(
    `UPDATE ecf_documents
     SET estado_dgii = ?,
         mensajes_dgii = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [estado, truncateText(mensaje, 500), ecfDocumentId]
  );
  await syncSaleSummary(queryFn, doc.sale_id, { ecfEstado: estado });
  if (['aceptado', 'aceptado_condicional'].includes(estado)) {
    await ensureAcceptedQr(queryFn, { ...doc, estado_dgii: estado });
  }
  return { estado, mensaje, raw: parsed };
}

async function retryPendingDocuments(queryFn, businessId) {
  const pending = await queryFn(
    `SELECT id FROM ecf_documents
     WHERE business_id = ?
       AND estado_dgii IN ('pendiente', 'pendiente_red', 'error_red', 'pendiente_rfce', 'error')
       AND retry_count < ?
       AND COALESCE(is_sent, 0) = 0
     ORDER BY created_at ASC
     LIMIT 20`,
    [businessId, MAX_AUTO_RETRIES]
  );

  const results = [];
  for (const row of pending) {
    try {
      const result = await sendElectronicDocument(queryFn, row.id);
      results.push({ id: row.id, ...result });
    } catch (error) {
      results.push({ id: row.id, ok: false, error: error.message });
    }
  }
  return results;
}

async function trackStatuses(queryFn, businessId) {
  const docs = await queryFn(
    `SELECT id, track_id
     FROM ecf_documents
     WHERE business_id = ?
       AND is_sent = 1
       AND estado_dgii IN ('enviado', 'procesando', 'pendiente')
       AND track_id IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 50`,
    [businessId]
  );

  for (const doc of docs) {
    await getStatusByTrackId(queryFn, doc.id, doc.track_id).catch(() => {});
  }
  return { tracked: docs.length };
}

function resolveSubmissionTarget(doc, environment) {
  const env = normalizeEnvironment(environment);
  const submissionMode = String(doc.submission_mode || '').trim().toLowerCase();
  const ecfUrls = getDgiiEcfUrls(env);
  const fcUrls = getDgiiFcUrls(env);
  const isLowValueE32 = String(doc.tipo_ecf || '').toUpperCase() === 'E32'
    && Number(doc.monto_total || 0) < RFCE_THRESHOLD_DOP;

  if (submissionMode === 'rfce' || (isLowValueE32 && !ALLOW_E32_FULL_RECEPTION)) {
    return {
      mode: 'rfce',
      url: fcUrls.recepcionResumenUrl,
      blocked: true,
      reason: fcUrls.available
        ? 'TODO profesional: implementar XML RFCE firmado y envío al servicio DGII de resumen de factura de consumo para E32 menores a RD$250,000.'
        : 'TODO profesional: la DGII maneja las E32 menores a RD$250,000 mediante RFCE. Falta configurar e implementar ese flujo.'
    };
  }

  return {
    mode: 'ecf',
    url: ecfUrls.recepcionUrl,
    blocked: false,
    reason: null
  };
}

function parseReceptionResponse(rawBody) {
  const json = parseJsonSafe(rawBody);
  if (Object.keys(json).length) {
    return {
      trackId: json.trackId || json.TrackId || null,
      estado: json.estado || json.Estado || null,
      codigo: json.codigo || json.Codigo || null,
      error: json.error || json.Error || null,
      mensaje: json.mensaje || json.Mensaje || flattenMessages(json.mensajes || json.Mensajes)
    };
  }

  return {
    trackId: extractXmlValue(rawBody, 'trackId'),
    estado: extractXmlValue(rawBody, 'estado'),
    codigo: extractXmlValue(rawBody, 'codigo'),
    error: extractXmlValue(rawBody, 'error'),
    mensaje: extractXmlMessages(rawBody)
  };
}

function parseStatusResponse(rawBody) {
  const json = parseJsonSafe(rawBody);
  if (Object.keys(json).length) {
    return {
      trackId: json.trackId || null,
      estado: json.estado || json.Estado || null,
      codigo: json.codigo || json.Codigo || null,
      mensajes: json.mensajes || json.Mensajes || []
    };
  }
  return {
    trackId: extractXmlValue(rawBody, 'trackId'),
    estado: extractXmlValue(rawBody, 'estado'),
    codigo: extractXmlValue(rawBody, 'codigo'),
    mensajes: extractXmlMessages(rawBody)
  };
}

function parseTrackIdsResponse(rawBody) {
  const json = parseJsonSafe(rawBody);
  if (Array.isArray(json)) return json;
  if (json.trackId || json.estado) return [json];
  const matches = Array.from(String(rawBody || '').matchAll(/<TrackingDetalle>([\s\S]*?)<\/TrackingDetalle>/gi));
  return matches.map((match) => ({
    trackId: extractXmlValue(match[1], 'trackId'),
    estado: extractXmlValue(match[1], 'estado'),
    fechaRecepcion: extractXmlValue(match[1], 'fechaRecepcion')
  }));
}

function mapDGIIStatus(dgiiStatus) {
  const status = String(dgiiStatus || '').trim().toLowerCase();
  if (status.includes('aceptado condicional')) return 'aceptado_condicional';
  if (status.includes('aceptad')) return 'aceptado';
  if (status.includes('rechazad')) return 'rechazado';
  if (status.includes('proceso')) return 'procesando';
  if (status.includes('proces')) return 'procesando';
  if (status.includes('pending')) return 'procesando';
  if (status.includes('error')) return 'error';
  return 'pendiente';
}

async function markDocumentError(queryFn, doc, estado, mensaje) {
  await queryFn(
    `UPDATE ecf_documents
     SET estado_dgii = ?,
         mensajes_dgii = ?,
         retry_count = retry_count + 1,
         last_retry_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [estado, truncateText(mensaje, 500), doc.id]
  );
  await syncSaleSummary(queryFn, doc.sale_id, { ecfEstado: estado });
}

async function markDocumentPending(queryFn, doc, mensaje, estado = 'pendiente') {
  await queryFn(
    `UPDATE ecf_documents
     SET estado_dgii = ?,
         mensajes_dgii = ?,
         retry_count = retry_count + 1,
         last_retry_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [estado, truncateText(mensaje, 500), doc.id]
  );
  await syncSaleSummary(queryFn, doc.sale_id, { ecfEstado: estado });
}

async function syncSaleSummary(queryFn, saleId, values) {
  if (!saleId) return;
  const fields = [];
  const params = [];

  if (values.ecfEstado !== undefined) {
    fields.push('ecf_estado = ?');
    params.push(values.ecfEstado);
  }
  if (values.ecfTrackId !== undefined) {
    fields.push('ecf_track_id = ?');
    params.push(values.ecfTrackId);
  }
  if (values.qrUrl !== undefined) {
    fields.push('qr_data = ?');
    params.push(values.qrUrl);
  }
  if (!fields.length) return;

  params.push(saleId);
  await queryFn(`UPDATE sales SET ${fields.join(', ')} WHERE id = ?`, params).catch(() => {});
}

async function ensureAcceptedQr(queryFn, doc) {
  if (!doc?.id || !doc?.sale_id) return null;
  if (!doc.codigo_seguridad || !doc.rnc_emisor || !doc.encf) return null;

  const qr = await xmlSvc.generateQrDataUrl(
    doc.rnc_emisor,
    doc.encf,
    doc.codigo_seguridad,
    normalizeEnvironment(doc.ambiente || 'test')
  );

  await queryFn(
    `UPDATE ecf_documents
     SET qr_url = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [qr.qrUrl, doc.id]
  ).catch(() => {});
  await syncSaleSummary(queryFn, doc.sale_id, { qrUrl: qr.qrUrl, ecfEstado: doc.estado_dgii });
  return qr;
}

function buildMessage(parsed) {
  return truncateText(
    parsed?.mensaje
      || parsed?.error
      || flattenMessages(parsed?.mensajes)
      || JSON.stringify(parsed || {}),
    500
  );
}

function flattenMessages(messages) {
  if (!messages) return '';
  if (typeof messages === 'string') return messages;
  if (!Array.isArray(messages)) return '';
  return messages.map((message) => {
    if (typeof message === 'string') return message;
    return `${message.codigo != null ? `[${message.codigo}] ` : ''}${message.valor || message.mensaje || ''}`.trim();
  }).filter(Boolean).join(' | ');
}

function parseJsonSafe(rawBody) {
  try {
    return JSON.parse(rawBody);
  } catch (_) {
    return {};
  }
}

function extractXmlValue(xml, tagName) {
  const match = String(xml || '').match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match?.[1] ? match[1].trim() : '';
}

function extractXmlMessages(xml) {
  const matches = Array.from(String(xml || '').matchAll(/<mensajes>([\s\S]*?)<\/mensajes>/gi));
  if (!matches.length) return extractXmlValue(xml, 'mensaje');
  return matches.map((match) => {
    const code = extractXmlValue(match[1], 'codigo');
    const value = extractXmlValue(match[1], 'valor');
    return `${code ? `[${code}] ` : ''}${value}`.trim();
  }).filter(Boolean).join(' | ');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

module.exports = {
  sendElectronicDocument,
  getStatusByTrackId,
  getDocumentState,
  lookupTrackIdsByENCF,
  retryPendingDocuments,
  trackStatuses,
  mapDGIIStatus,
  resolveSubmissionTarget
};
