'use strict';

const https = require('https');
const http = require('http');
const crypto = require('crypto');

const { writeFiscalAuditLog, upsertOne } = require('./fiscalExtensions');
const { signXmlWithBusinessCertificate } = require('./ecfSigningService');
const { getCertificateForSigning } = require('./fiscalCertificateService');
const { getDgiiAuthUrls, normalizeEnvironment, AUTH_BASES } = require('./dgiiEndpointService');
const { createDgiiRequestLog, finalizeDgiiRequestLog, truncateText } = require('./dgiiRequestLogService');

const TOKEN_SECRET = process.env.FISCAL_TOKEN_SECRET || process.env.FISCAL_CERT_SECRET || 'tecnocaja-token-default-secret';

function getBaseUrl(environment) {
  return getDgiiAuthUrls(environment).baseUrl;
}

function encryptToken(token) {
  const key  = crypto.scryptSync(TOKEN_SECRET, 'tecnocaja-token-salt-v1', 32);
  const iv   = crypto.randomBytes(16);
  const ciph = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc  = Buffer.concat([ciph.update(Buffer.from(token, 'utf8')), ciph.final()]);
  const tag  = ciph.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('base64')}`;
}

function decryptToken(stored) {
  const [ivHex, tagHex, encB64] = String(stored || '').split(':');
  const key   = crypto.scryptSync(TOKEN_SECRET, 'tecnocaja-token-salt-v1', 32);
  const iv    = Buffer.from(ivHex, 'hex');
  const tag   = Buffer.from(tagHex, 'hex');
  const enc   = Buffer.from(encB64, 'base64');
  const deciph = crypto.createDecipheriv('aes-256-gcm', key, iv);
  deciph.setAuthTag(tag);
  return deciph.update(enc).toString('utf8') + deciph.final().toString('utf8');
}

function httpRequest(method, url, { headers = {}, body = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      },
      timeout: timeoutMs,
      rejectUnauthorized: true
    };

    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: Number(res.statusCode || 0),
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Tiempo de espera agotado al conectar con DGII (${method} ${url}).`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function httpGet(url, headers = {}, timeoutMs = 30000) {
  return httpRequest('GET', url, { headers, timeoutMs });
}

function httpPost(url, body, headers = {}, timeoutMs = 30000) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return httpRequest('POST', url, {
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: payload,
    timeoutMs
  });
}

function buildMultipartPayload(fields) {
  const boundary = `----TecnoCajaBoundary${crypto.randomBytes(12).toString('hex')}`;
  const buffers = [];

  for (const field of fields) {
    const headerLines = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="${field.name}"${field.filename ? `; filename="${field.filename}"` : ''}`
    ];
    if (field.contentType) {
      headerLines.push(`Content-Type: ${field.contentType}`);
    }
    headerLines.push('', '');

    buffers.push(Buffer.from(headerLines.join('\r\n'), 'utf8'));
    buffers.push(Buffer.isBuffer(field.value) ? field.value : Buffer.from(String(field.value || ''), 'utf8'));
    buffers.push(Buffer.from('\r\n', 'utf8'));
  }

  buffers.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    boundary,
    body: Buffer.concat(buffers),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

function httpPostMultipart(url, fields, headers = {}, timeoutMs = 30000) {
  const multipart = buildMultipartPayload(fields);
  return httpRequest('POST', url, {
    headers: {
      'Content-Type': multipart.contentType,
      ...headers
    },
    body: multipart.body,
    timeoutMs
  });
}

function extractSeedValue(responseBody) {
  const body = String(responseBody || '');
  // WCF <string xmlns="...">VALUE</string>
  const stringMatch = body.match(/<string[^>]*>([^<]+)<\/string>/i);
  if (stringMatch?.[1]) return stringMatch[1].trim();
  // <valor>VALUE</valor>
  const valorMatch = body.match(/<valor>([^<]+)<\/valor>/i);
  if (valorMatch?.[1]) return valorMatch[1].trim();
  // <Semilla>VALUE</Semilla>
  const semillaMatch = body.match(/<Semilla>([^<]+)<\/Semilla>/i);
  if (semillaMatch?.[1]) return semillaMatch[1].trim();
  // JSON: { semilla, valor, value, token, seed }
  try {
    const json = JSON.parse(body);
    const val = json.semilla || json.Semilla || json.valor || json.value || json.token || json.seed;
    if (val) return String(val).trim();
  } catch (_) {}
  throw new Error(
    `No se pudo extraer el valor de la semilla DGII (${body.length} bytes). Inicio: ${body.slice(0, 200)}`
  );
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&amp;/g, '&');
}

function extractSeedXmlCandidate(responseBody) {
  const body = String(responseBody || '').trim();
  if (!body) return '';

  if (/<SemillaModel\b/i.test(body)) {
    return body;
  }

  const stringMatch = body.match(/<string[^>]*>([\s\S]*?)<\/string>/i);
  if (!stringMatch?.[1]) return '';

  const decoded = decodeXmlEntities(stringMatch[1]).trim();
  return /<SemillaModel\b/i.test(decoded) ? decoded : '';
}

function extractSeedDate(responseBody) {
  const directXml = extractSeedXmlCandidate(responseBody);
  if (directXml) {
    const directMatch = directXml.match(/<fecha>([\s\S]*?)<\/fecha>/i);
    if (directMatch?.[1]) return directMatch[1].trim();
  }

  const body = String(responseBody || '');
  const fechaMatch = body.match(/<fecha>([\s\S]*?)<\/fecha>/i);
  if (fechaMatch?.[1]) return fechaMatch[1].trim();

  try {
    const json = JSON.parse(body);
    const value = json.fecha || json.Fecha || json.date || json.Date;
    if (value) return String(value).trim();
  } catch (_) {}

  return '';
}

function escapeXmlText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSeedXmlToSign(seedValue, seedDate = null) {
  const normalizedDate = String(seedDate || '').trim() || new Date().toISOString();
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<SemillaModel xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n' +
    `  <valor>${escapeXmlText(seedValue)}</valor>\n` +
    `  <fecha>${escapeXmlText(normalizedDate)}</fecha>\n` +
    '</SemillaModel>'
  );
}

async function fetchSeedXml(environment) {
  const authUrls = getDgiiAuthUrls(environment);
  const response = await httpGet(authUrls.seedUrl, { Accept: 'application/xml, text/xml, */*' });
  if (response.status !== 200) {
    throw new Error(`DGII no entregó la semilla. HTTP ${response.status}`);
  }
  const rawBody = String(response.body || '');
  const seedValue = extractSeedValue(rawBody);
  const seedDate = extractSeedDate(rawBody);
  const seedXml = buildSeedXmlFromResponse(rawBody, seedValue, seedDate);
  return { environment: authUrls.environment, authUrls, seedXml, rawSeedResponse: rawBody, seedValue, seedDate };
}

function buildSeedXmlFromResponse(rawBody, seedValue, seedDate = null) {
  const body = extractSeedXmlCandidate(rawBody);
  if (body) {
    return body;
  }
  return buildSeedXmlToSign(seedValue, seedDate);
}

async function authenticateDGII(queryFn, businessId, environment = 'test') {
  const authUrls = getDgiiAuthUrls(environment);
  const requestId = `dgii-auth-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  let logId = null;

  try {
    const { info } = await getCertificateForSigning(queryFn, businessId);
    const rnc = extractRncFromCertInfo(info);
    const seedResult = await fetchSeedXml(authUrls.environment);
    const signedSeed = await signXmlWithBusinessCertificate(queryFn, businessId, seedResult.seedXml);

    logId = await createDgiiRequestLog(queryFn, {
      requestId,
      businessId,
      endpointType: 'dgii_autenticacion',
      direction: 'outbound',
      httpMethod: 'POST',
      routePath: authUrls.validateSeedUrl,
      environment: authUrls.environment,
      contentType: 'text/xml',
      payloadFormat: 'xml',
      payloadSha256: sha256(signedSeed.signedXml),
      payloadSize: Buffer.byteLength(signedSeed.signedXml, 'utf8'),
      requestPayload: truncateText(signedSeed.signedXml, 4000)
    }).catch(() => null);

    const response = await httpPostMultipart(
      authUrls.validateSeedUrl,
      [
        {
          name: 'xml',
          filename: `semilla-${Date.now()}.xml`,
          contentType: 'text/xml',
          value: signedSeed.signedXml
        }
      ],
      {
        Accept: 'application/json, application/xml, text/xml, */*'
      }
    );

    const parsed = parseAuthResponse(response.body);
    if (response.status !== 200 || !parsed.token) {
      const dgiiMsg = String(response.body || '').slice(0, 300);
      const message = parsed.error || parsed.message || `HTTP ${response.status}`;
      throw new Error(`DGII rechazó la validación de semilla: ${message} | Respuesta: ${dgiiMsg}`);
    }

    const expiresAt = parsed.expiresAt || new Date(Date.now() + 55 * 60 * 1000);
    const tokenEncrypted = encryptToken(parsed.token);
    await upsertOne(queryFn, 'fiscal_config', 'business_id', {
      business_id: businessId,
      environment: authUrls.environment,
      token_encrypted: tokenEncrypted,
      token_expires_at: expiresAt,
      status: 'conectado',
      last_conn_status: 'conectado',
      last_conn_msg: `Autenticación exitosa vía semilla DGII (${authUrls.environment}).`
    });

    await writeFiscalAuditLog(queryFn, {
      businessId,
      action: 'dgii_autenticado',
      description: `Autenticación exitosa con DGII ambiente ${authUrls.environment}. Token expira: ${expiresAt.toISOString()}`
    }).catch(() => {});

    await finalizeDgiiRequestLog(queryFn, logId, {
      responseStatus: response.status,
      responseCode: 'DGII-AUTH-OK',
      responseMessage: 'Semilla validada correctamente.',
      responsePayload: truncateText(String(response.body || ''), 4000)
    });

    return {
      token: parsed.token,
      expiresAt,
      issuedAt: parsed.issuedAt || new Date(),
      environment: authUrls.environment
    };
  } catch (error) {
    await updateConnectionStatus(queryFn, businessId, 'error', error.message).catch(() => {});
    await finalizeDgiiRequestLog(queryFn, logId, {
      responseStatus: 500,
      responseCode: 'DGII-AUTH-ERR',
      responseMessage: 'Error autenticando contra DGII.',
      errorMessage: error.message
    });
    throw error;
  }
}

async function getActiveToken(queryFn, businessId) {
  const rows = await queryFn(
    'SELECT token_encrypted, token_expires_at, environment FROM fiscal_config WHERE business_id = ? LIMIT 1',
    [businessId]
  );
  const config = rows[0];
  if (!config) throw new Error('No hay configuración fiscal para esta empresa.');

  const now = new Date();
  const bufferMs = 5 * 60 * 1000;
  if (config.token_encrypted && config.token_expires_at) {
    const expiresAt = new Date(config.token_expires_at);
    if ((expiresAt - now) > bufferMs) {
      return {
        token: decryptToken(config.token_encrypted),
        expiresAt,
        environment: normalizeEnvironment(config.environment)
      };
    }
  }

  return authenticateDGII(queryFn, businessId, config.environment || 'test');
}

async function testConnection(queryFn, businessId, environment) {
  try {
    const result = await authenticateDGII(queryFn, businessId, environment || 'test');
    return {
      ok: true,
      environment: result.environment,
      expiresAt: result.expiresAt,
      issuedAt: result.issuedAt
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function updateConnectionStatus(queryFn, businessId, status, message) {
  await upsertOne(queryFn, 'fiscal_config', 'business_id', {
    business_id: businessId,
    last_conn_status: status,
    last_conn_msg: String(message || '').slice(0, 500)
  });
}

function extractRncFromCertInfo(info) {
  const cn = info?.cn || '';
  const digits = cn.replace(/\D/g, '');
  if (digits.length >= 9) return digits.slice(0, 11);
  const subjectDigits = String(info?.subject || '').replace(/\D/g, '');
  if (subjectDigits.length >= 9) return subjectDigits.slice(0, 11);
  throw new Error('No se pudo extraer el RNC del certificado.');
}

function parseAuthResponse(rawBody) {
  const json = parseJsonSafe(rawBody);
  if (json.token || json.Token) {
    return {
      token: json.token || json.Token,
      expiresAt: parseDateSafe(json.expira || json.Expira || json.expiresAt || json.expiration || null),
      issuedAt: parseDateSafe(json.expedido || json.Expedido || json.issuedAt || null)
    };
  }

  const xmlBody = String(rawBody || '');
  return {
    token: extractXmlValue(xmlBody, 'token'),
    expiresAt: parseDateSafe(extractXmlValue(xmlBody, 'expira')),
    issuedAt: parseDateSafe(extractXmlValue(xmlBody, 'expedido')),
    error: extractXmlValue(xmlBody, 'mensaje') || extractXmlValue(xmlBody, 'Message') || null,
    message: extractXmlValue(xmlBody, 'error') || null
  };
}

function parseJsonSafe(str) {
  try {
    return JSON.parse(str);
  } catch (_) {
    return {};
  }
}

function parseDateSafe(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function extractXmlValue(xml, tagName) {
  const match = String(xml || '').match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match?.[1] ? match[1].trim() : '';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

module.exports = {
  AUTH_BASES,
  authenticateDGII,
  getActiveToken,
  testConnection,
  getBaseUrl,
  httpRequest,
  httpPost,
  httpGet,
  httpPostMultipart,
  buildMultipartPayload,
  fetchSeedXml,
  extractSeedValue,
  extractSeedDate,
  buildSeedXmlToSign,
  buildSeedXmlFromResponse,
  extractRncFromCertInfo
};
