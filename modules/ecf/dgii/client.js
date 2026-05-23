'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { EcfError, assertCondition } = require('../utils/errors');

function buildMultipartBody(fields) {
  const boundary = `----TecnoCajaECF${crypto.randomBytes(12).toString('hex')}`;
  const parts = [];

  for (const field of fields) {
    const headers = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="${field.name}"${field.filename ? `; filename="${field.filename}"` : ''}`,
    ];
    if (field.contentType) headers.push(`Content-Type: ${field.contentType}`);
    headers.push('', '');
    parts.push(Buffer.from(headers.join('\r\n'), 'utf8'));
    parts.push(Buffer.isBuffer(field.value) ? field.value : Buffer.from(String(field.value ?? ''), 'utf8'));
    parts.push(Buffer.from('\r\n', 'utf8'));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return {
    boundary,
    body: Buffer.concat(parts),
  };
}

function request(method, url, { headers = {}, body = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;

    const requestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      timeout: timeoutMs,
      rejectUnauthorized: true,
      headers: {
        Accept: 'application/json, application/xml, text/xml, */*',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    };

    const startedAt = Date.now();
    const req = transport.request(requestOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: Number(res.statusCode || 0),
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          elapsedMs: Date.now() - startedAt,
          url,
          method,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Tiempo de espera agotado al consumir DGII: ${method} ${url}`));
    });
    req.on('error', (error) => {
      reject(new EcfError(`Fallo de red con DGII: ${error.message}`, {
        statusCode: 502,
        code: 'ECF_DGII_NETWORK_ERROR',
        cause: error,
      }));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&amp;/g, '&');
}

function extractTagValue(source, tagName) {
  const match = String(source || '').match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
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

class DgiiClient {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
  }

  async getSeed() {
    const response = await request('GET', this.config.DGII_SEMILLA_URL, {
      headers: { Accept: 'application/xml, text/xml, */*' },
    });
    if (response.status !== 200) {
      throw new EcfError(`DGII no entregó la semilla. HTTP ${response.status}`, { statusCode: 502 });
    }
    const parsed = parseSeedResponse(response.body);
    this.logger.info('Semilla obtenida desde DGII.', {
      environment: this.config.DGII_ENV,
      status: response.status,
      elapsedMs: response.elapsedMs,
      semillaUrl: this.config.DGII_SEMILLA_URL,
    });
    return {
      ...parsed,
      http: response,
    };
  }

  async validateSeed(signedXml) {
    assertCondition(String(signedXml || '').trim(), 'No hay semilla firmada para enviar a DGII.', { statusCode: 422 });
    const multipart = buildMultipartBody([
      {
        name: 'xml',
        filename: `semilla-${Date.now()}.xml`,
        contentType: 'text/xml',
        value: signedXml,
      },
    ]);

    const response = await request('POST', this.config.DGII_VALIDAR_SEMILLA_URL, {
      headers: {
        'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
      },
      body: multipart.body,
    });

    const parsed = parseAuthResponse(response.body);
    const logPayload = {
      environment: this.config.DGII_ENV,
      status: response.status,
      elapsedMs: response.elapsedMs,
      tokenDetected: Boolean(parsed.token),
      validarSemillaUrl: this.config.DGII_VALIDAR_SEMILLA_URL,
    };

    if (response.status >= 200 && response.status < 300 && parsed.token) {
      this.logger.info('Validacion de semilla firmada en DGII completada.', logPayload);
    } else {
      this.logger.warn('Validacion de semilla firmada en DGII rechazada.', {
        ...logPayload,
        responsePreview: String(response.body || '').slice(0, 240),
      });
    }

    return {
      ...parsed,
      http: response,
    };
  }

  async submitEcf({ token, signedXml, filename }) {
    assertCondition(token, 'No hay token DGII disponible para enviar el e-CF.', { statusCode: 422 });
    const multipart = buildMultipartBody([
      {
        name: 'xml',
        filename: filename || `ecf-${Date.now()}.xml`,
        contentType: 'text/xml',
        value: signedXml,
      },
    ]);
    const response = await request('POST', this.config.DGII_RECEPCION_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
      },
      body: multipart.body,
      timeoutMs: 45000,
    });

    const parsed = parseTrackResponse(response.body);
    return {
      ...parsed,
      http: response,
    };
  }

  async getTrackStatus({ token, trackId }) {
    assertCondition(trackId, 'Debe indicar un TrackId para consultar estado.', { statusCode: 422 });
    const url = `${this.config.DGII_CONSULTA_URL}?trackid=${encodeURIComponent(trackId)}`;
    const response = await request('GET', url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return {
      ...parseTrackResponse(response.body),
      http: response,
    };
  }

  async getEcfStatus({ token, rncemisor, ncfelectronico, rnccomprador, codigoseguridad }) {
    assertCondition(rncemisor && ncfelectronico && codigoseguridad, 'Faltan parámetros para consultar el estado del e-CF.', {
      statusCode: 422,
    });
    const params = new URLSearchParams({
      rncemisor: String(rncemisor),
      ncfelectronico: String(ncfelectronico),
      rnccomprador: String(rnccomprador || ''),
      codigoseguridad: String(codigoseguridad),
    });
    const response = await request('GET', `${this.config.DGII_CONSULTA_ESTADO_URL}?${params.toString()}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return {
      ...parseTrackResponse(response.body),
      http: response,
    };
  }

  async submitRfce({ token, signedXml, filename }) {
    assertCondition(token, 'No hay token DGII disponible para enviar el resumen RFCE.', { statusCode: 422 });
    const multipart = buildMultipartBody([
      {
        name: 'xml',
        filename: filename || `rfce-${Date.now()}.xml`,
        contentType: 'text/xml',
        value: signedXml,
      },
    ]);
    const response = await request('POST', this.config.DGII_FC_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
      },
      body: multipart.body,
      timeoutMs: 45000,
    });
    return {
      ...parseTrackResponse(response.body),
      http: response,
    };
  }
}

module.exports = {
  DgiiClient,
};
