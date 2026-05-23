'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

const certSvc = require('../fiscal/fiscalCertificateService');
const authSvc = require('../fiscal/dgiiAuthService');
const { writeFiscalAuditLog, upsertOne } = require('../fiscal/fiscalExtensions');
const { dgiiInternalAuth } = require('../middleware/dgii-auth');

const XML_CONTENT_TYPES = [
  'application/xml',
  'text/xml',
  'application/soap+xml',
  'application/*+xml',
  'text/*+xml'
];
const JSON_CONTENT_TYPES = ['application/json', 'application/*+json'];
const DEFAULT_MAX_BODY_MB = Number(process.env.DGII_MAX_BODY_MB || 20);
const SENSITIVE_KEYS = new Set([
  'certificate',
  'certificatebase64',
  'certbase64',
  'certificado',
  'certificadobase64',
  'p12',
  'p12base64',
  'password',
  'clave',
  'clavecertificado',
  'certificatepassword',
  'token',
  'authorization',
  'privatekey'
]);
const RESPONSE_CODES = {
  received: 'TC-DGII-2000',
  pendingIntegration: 'TC-DGII-2001',
  invalidToken: 'TC-DGII-4001',
  invalidPayload: 'TC-DGII-4002',
  certificateValidated: 'TC-DGII-2100',
  certificatePending: 'TC-DGII-2101',
  upstreamError: 'TC-DGII-5001',
  internalError: 'TC-DGII-5000'
};

function createDgiiRouter(deps) {
  const {
    query,
    certificateService = certSvc,
    authService = authSvc,
    upsertHelper = upsertOne,
    auditLogger = writeFiscalAuditLog
  } = deps || {};

  if (typeof query !== 'function') {
    throw new Error('createDgiiRouter requiere query.');
  }

  const router = express.Router();
  const maxBodyBytes = `${DEFAULT_MAX_BODY_MB}mb`;
  const xmlParser = express.text({ type: XML_CONTENT_TYPES, limit: maxBodyBytes });
  const jsonParser = express.json({ type: JSON_CONTENT_TYPES, limit: maxBodyBytes });

  // Protección de rutas públicas DGII con token interno (DGII_REQUIRE_INTERNAL_TOKEN)
  router.use('/fe', dgiiInternalAuth);

  router.use('/fe', (req, res, next) => {
    if (req.method === 'GET' || req.body !== undefined) return next();
    if (isXmlRequest(req)) return xmlParser(req, res, next);
    if (isJsonRequest(req)) return jsonParser(req, res, next);
    return next();
  });

  router.post('/fe/recepcion/api/ecf', async (req, res) => {
    await handleInboundDocument(req, res, {
      query,
      upsertHelper,
      auditLogger,
      endpointType: 'recepcion',
      routePath: '/fe/recepcion/api/ecf'
    });
  });

  router.post('/fe/aprobacioncomercial/api/ecf', async (req, res) => {
    await handleInboundDocument(req, res, {
      query,
      upsertHelper,
      auditLogger,
      endpointType: 'aprobacion_comercial',
      routePath: '/fe/aprobacioncomercial/api/ecf'
    });
  });

  router.get('/fe/autenticacion/api/semilla', async (req, res) => {
    const requestId = createRequestId('semilla');
    let requestLogId = null;

    try {
      const context = await resolveCompanyContext(query, req);
      await ensureCompanySettingsSnapshot(query, upsertHelper, context);
      validateInternalToken(req, context.settings);

      requestLogId = await createRequestLog(query, {
        requestId,
        businessId: context.businessId,
        branchId: context.branchId,
        cashRegisterId: context.cashRegisterId,
        endpointType: 'semilla',
        direction: 'inbound',
        routePath: '/fe/autenticacion/api/semilla',
        environment: context.environment,
        requestMethod: req.method,
        originHeader: req.get('origin'),
        ipAddress: getRequestIp(req),
        contentType: null,
        payloadFormat: null,
        payloadSha256: null,
        payloadSize: 0,
        requestPayload: null,
        requestFilePath: null
      });

      const upstreamUrl = getSemillaUpstreamUrl(context.environment);
      if (!upstreamUrl) {
        const responseBody = buildResponse('pendiente_integracion', 'La ruta de semilla está lista, pero todavía no tiene un upstream DGII configurado para esta empresa.', RESPONSE_CODES.pendingIntegration, {
          requestId,
          businessId: context.businessId,
          environment: context.environment,
          rutas: context.publicUrls,
          siguientePaso: 'Configura DGII_FORWARD_SEMILLA_URL_TEST o DGII_FORWARD_SEMILLA_URL_PRODUCCION cuando tengas la integración real del contribuyente.'
        });
        await finalizeRequestLog(query, requestLogId, responseBody, 200, null);
        return res.status(200).json(responseBody);
      }

      // Punto de integración real: cuando exista el endpoint oficial o el proxy
      // del contribuyente, se consulta aquí y se conserva evidencia completa.
      const upstreamResponse = await authService.httpGet(upstreamUrl, {
        Accept: 'application/json, application/xml, text/xml'
      });
      const upstreamBodyText = String(upstreamResponse.body || '');
      const archivedResponse = await archivePayload({
        businessId: context.businessId,
        environment: context.environment,
        endpointType: 'semilla_upstream',
        requestId,
        extension: looksLikeXml(upstreamBodyText) ? 'xml' : 'json',
        payloadText: upstreamBodyText
      });

      await query(
        `UPDATE dgii_company_settings
         SET last_seed_requested_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE business_id = ?`,
        [context.businessId]
      ).catch(() => {});

      const responseBody = buildResponse('completado', 'Semilla consultada en el upstream configurado.', RESPONSE_CODES.received, {
        requestId,
        businessId: context.businessId,
        environment: context.environment,
        upstreamStatus: Number(upstreamResponse.status || 0),
        upstreamContentType: String(upstreamResponse.headers?.['content-type'] || ''),
        archivoRespuesta: archivedResponse.filePath,
        semillaDetectada: extractFirstMatch(upstreamBodyText, [
          /<Semilla>([^<]+)<\/Semilla>/i,
          /<Seed>([^<]+)<\/Seed>/i,
          /"semilla"\s*:\s*"([^"]+)"/i,
          /"seed"\s*:\s*"([^"]+)"/i
        ])
      });

      await createRequestLog(query, {
        requestId,
        businessId: context.businessId,
        branchId: context.branchId,
        cashRegisterId: context.cashRegisterId,
        endpointType: 'semilla',
        direction: 'outbound',
        routePath: upstreamUrl,
        environment: context.environment,
        requestMethod: 'GET',
        originHeader: null,
        ipAddress: null,
        contentType: String(upstreamResponse.headers?.['content-type'] || ''),
        payloadFormat: inferPayloadFormat(upstreamBodyText, String(upstreamResponse.headers?.['content-type'] || '')),
        payloadSha256: sha256(upstreamBodyText),
        payloadSize: Buffer.byteLength(upstreamBodyText, 'utf8'),
        requestPayload: null,
        requestFilePath: archivedResponse.filePath,
        responseStatus: Number(upstreamResponse.status || 0),
        responseCode: RESPONSE_CODES.received,
        responseMessage: 'Respuesta upstream archivada.',
        responsePayload: truncateText(upstreamBodyText, 2000)
      }).catch(() => {});

      await finalizeRequestLog(query, requestLogId, responseBody, 200, null);
      return res.status(200).json(responseBody);
    } catch (error) {
      return handleRouteError({
        error,
        res,
        query,
        requestId,
        requestLogId,
        endpointType: 'semilla'
      });
    }
  });

  router.post('/fe/autenticacion/api/validacioncertificado', async (req, res) => {
    const requestId = createRequestId('cert');
    let requestLogId = null;

    try {
      const context = await resolveCompanyContext(query, req);
      await ensureCompanySettingsSnapshot(query, upsertHelper, context);
      validateInternalToken(req, context.settings);

      const payload = getPayloadDescriptor(req, 'validacion_certificado');
      if (!payload.serializedBody) {
        throw buildHttpError(400, 'No se recibió payload para validar el certificado.', RESPONSE_CODES.invalidPayload);
      }

      const archivedPayload = await archivePayload({
        businessId: context.businessId,
        environment: context.environment,
        endpointType: 'validacion_certificado',
        requestId,
        extension: payload.fileExtension,
        payloadText: payload.sanitizedBody
      });

      requestLogId = await createRequestLog(query, {
        requestId,
        businessId: context.businessId,
        branchId: context.branchId,
        cashRegisterId: context.cashRegisterId,
        endpointType: 'validacion_certificado',
        direction: 'inbound',
        routePath: '/fe/autenticacion/api/validacioncertificado',
        environment: context.environment,
        requestMethod: req.method,
        originHeader: req.get('origin'),
        ipAddress: getRequestIp(req),
        contentType: payload.contentType,
        payloadFormat: payload.format,
        payloadSha256: payload.sha256,
        payloadSize: payload.size,
        requestPayload: truncateText(payload.sanitizedBody, 4000),
        requestFilePath: archivedPayload.filePath
      });

      const validationResult = await validateCertificatePayload({
        query,
        context,
        payload,
        certificateService
      });

      await query(
        `UPDATE dgii_company_settings
         SET last_certificate_check_at = CURRENT_TIMESTAMP,
             certificate_mode = COALESCE(?, certificate_mode),
             updated_at = CURRENT_TIMESTAMP
         WHERE business_id = ?`,
        [validationResult.certificateMode || null, context.businessId]
      ).catch(() => {});

      const responseBody = buildResponse(
        validationResult.status,
        validationResult.message,
        validationResult.code,
        {
          requestId,
          businessId: context.businessId,
          environment: context.environment,
          detalle: validationResult.detail
        }
      );

      await finalizeRequestLog(query, requestLogId, responseBody, 200, null);
      return res.status(200).json(responseBody);
    } catch (error) {
      return handleRouteError({
        error,
        res,
        query,
        requestId,
        requestLogId,
        endpointType: 'validacion_certificado'
      });
    }
  });

  return router;
}

async function handleInboundDocument(req, res, deps) {
  const { query, upsertHelper, auditLogger, endpointType, routePath } = deps;
  const requestId = createRequestId(endpointType);
  let requestLogId = null;

  try {
    const context = await resolveCompanyContext(query, req);
    await ensureCompanySettingsSnapshot(query, upsertHelper, context);
    validateInternalToken(req, context.settings);

    const payload = getPayloadDescriptor(req, endpointType);
    if (!payload.serializedBody) {
      throw buildHttpError(400, 'No se recibió contenido XML o JSON.', RESPONSE_CODES.invalidPayload);
    }

    const metadata = extractPayloadMetadata(payload.serializedBody, payload.objectBody);
    const archivedPayload = await archivePayload({
      businessId: context.businessId,
      environment: context.environment,
      endpointType,
      requestId,
      extension: payload.fileExtension,
      encf: metadata.encf,
      payloadText: payload.sanitizedBody
    });

    requestLogId = await createRequestLog(query, {
      requestId,
      businessId: context.businessId,
      branchId: context.branchId,
      cashRegisterId: context.cashRegisterId,
      endpointType,
      direction: 'inbound',
      routePath,
      environment: context.environment,
      requestMethod: req.method,
      originHeader: req.get('origin'),
      ipAddress: getRequestIp(req),
      contentType: payload.contentType,
      payloadFormat: payload.format,
      payloadSha256: payload.sha256,
      payloadSize: payload.size,
      requestPayload: truncateText(payload.sanitizedBody, 4000),
      requestFilePath: archivedPayload.filePath
    });

    const insertResult = await query(
      `INSERT INTO dgii_received_documents
         (request_id, business_id, branch_id, cash_register_id, endpoint_type, environment,
          content_type, payload_format, encf, track_id, rnc_emisor, rnc_receptor,
          payload_sha256, payload_size, file_path, status, source_ip, response_code, response_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        requestId,
        context.businessId,
        context.branchId,
        context.cashRegisterId,
        endpointType,
        context.environment,
        payload.contentType,
        payload.format,
        metadata.encf || null,
        metadata.trackId || null,
        metadata.rncEmisor || context.business?.rnc || null,
        metadata.rncReceptor || null,
        payload.sha256,
        payload.size,
        archivedPayload.filePath,
        'recibido',
        getRequestIp(req),
        RESPONSE_CODES.received,
        `Payload ${endpointType} archivado localmente.`
      ]
    );

    await auditLogger(query, {
      businessId: context.businessId,
      action: `dgii_${endpointType}_recibido`,
      description: `Request ${requestId} archivado para ${endpointType}. eNCF: ${metadata.encf || 'n/d'}.`,
      ipAddress: getRequestIp(req)
    }).catch(() => {});

    const responseBody = buildResponse('recibido', `Solicitud ${endpointType} recibida y archivada localmente.`, RESPONSE_CODES.received, {
      requestId,
      businessId: context.businessId,
      branchId: context.branchId,
      cashRegisterId: context.cashRegisterId,
      environment: context.environment,
      endpoint: routePath,
      documentId: Number(insertResult?.insertId || 0) || null,
      encf: metadata.encf || null,
      trackId: metadata.trackId || null,
      formato: payload.format,
      archivo: archivedPayload.filePath,
      siguientePaso: endpointType === 'recepcion'
        ? 'Completar la firma, envío real a DGII y persistencia del TrackID usando ecfXmlService.js y ecfSenderService.js.'
        : 'Completar la homologación de la respuesta comercial real según el flujo del contribuyente.'
    });

    await finalizeRequestLog(query, requestLogId, responseBody, 200, null);
    return res.status(200).json(responseBody);
  } catch (error) {
    return handleRouteError({
      error,
      res,
      query,
      requestId,
      requestLogId,
      endpointType
    });
  }
}

async function resolveCompanyContext(query, req) {
  const configRows = await query(
    'SELECT business_id, active_branch_id, active_cash_register_id FROM config WHERE id = 1 LIMIT 1'
  );
  const config = configRows[0] || {};
  const requestedBusinessId = normalizeNullableNumber(req.get('x-business-id'))
    || normalizeNullableNumber(req.query.businessId)
    || Number(config.business_id || 1)
    || 1;

  const businessRows = await query(
    'SELECT id, nombre, razon_social, nombre_comercial, rnc, direccion, telefono, correo FROM businesses WHERE id = ? LIMIT 1',
    [requestedBusinessId]
  );
  const business = businessRows[0];
  if (!business) {
    throw buildHttpError(404, `No se encontró la empresa ${requestedBusinessId}.`, RESPONSE_CODES.invalidPayload);
  }

  const settingsRows = await query(
    'SELECT * FROM dgii_company_settings WHERE business_id = ? LIMIT 1',
    [requestedBusinessId]
  );
  const fiscalRows = await query(
    'SELECT environment FROM fiscal_config WHERE business_id = ? LIMIT 1',
    [requestedBusinessId]
  );
  const settings = settingsRows[0] || {};
  const fiscalConfig = fiscalRows[0] || {};
  const environment = sanitizeEnvironment(
    req.get('x-dgii-environment')
    || req.query.environment
    || settings.environment
    || fiscalConfig.environment
    || process.env.DGII_DEFAULT_ENVIRONMENT
    || 'test'
  );
  const publicBaseUrl = String(
    settings.public_base_url
    || process.env.DGII_PUBLIC_BASE_URL
    || process.env.POS_PUBLIC_BASE_URL
    || ''
  ).trim().replace(/\/+$/, '');

  const branchId = normalizeNullableNumber(req.get('x-branch-id'))
    || normalizeNullableNumber(req.query.branchId)
    || normalizeNullableNumber(settings.branch_id)
    || normalizeNullableNumber(config.active_branch_id);
  const cashRegisterId = normalizeNullableNumber(req.get('x-cash-register-id'))
    || normalizeNullableNumber(req.query.cashRegisterId)
    || normalizeNullableNumber(settings.cash_register_id)
    || normalizeNullableNumber(config.active_cash_register_id);

  const publicUrls = {
    recepcion: buildPublicUrl(publicBaseUrl, '/fe/recepcion/api/ecf'),
    aprobacionComercial: buildPublicUrl(publicBaseUrl, '/fe/aprobacioncomercial/api/ecf'),
    semilla: buildPublicUrl(publicBaseUrl, '/fe/autenticacion/api/semilla'),
    validacionCertificado: buildPublicUrl(publicBaseUrl, '/fe/autenticacion/api/validacioncertificado')
  };

  return {
    businessId: requestedBusinessId,
    branchId,
    cashRegisterId,
    business,
    settings,
    environment,
    publicBaseUrl,
    publicUrls
  };
}

async function ensureCompanySettingsSnapshot(query, upsertHelper, context) {
  const settings = context.settings || {};
  const business = context.business || {};
  return upsertHelper(query, 'dgii_company_settings', 'business_id', {
    business_id: context.businessId,
    branch_id: context.branchId,
    cash_register_id: context.cashRegisterId,
    rnc: business.rnc || settings.rnc || null,
    environment: context.environment,
    certificate_mode: settings.certificate_mode || 'p12',
    qscd_provider: settings.qscd_provider || null,
    qscd_config_json: settings.qscd_config_json || null,
    public_base_url: context.publicBaseUrl || null,
    recepcion_url: context.publicUrls.recepcion,
    aprobacion_url: context.publicUrls.aprobacionComercial,
    semilla_url: context.publicUrls.semilla,
    validacion_certificado_url: context.publicUrls.validacionCertificado,
    auth_api_base_url: settings.auth_api_base_url || null,
    internal_token_hash: settings.internal_token_hash || getConfiguredTokenHash() || null,
    allowed_origins: settings.allowed_origins || process.env.DGII_PUBLIC_ALLOWED_ORIGINS || null,
    require_internal_token: settings.require_internal_token != null
      ? Number(settings.require_internal_token)
      : (isTruthy(process.env.DGII_REQUIRE_INTERNAL_TOKEN) ? 1 : 0),
    is_enabled: settings.is_enabled != null ? Number(settings.is_enabled) : 1
  });
}

function validateInternalToken(req, settings) {
  const providedToken = extractInternalToken(req);
  const configuredHash = String(settings?.internal_token_hash || getConfiguredTokenHash() || '').trim().toLowerCase();
  const requireToken = settings?.require_internal_token != null
    ? Number(settings.require_internal_token) === 1
    : isTruthy(process.env.DGII_REQUIRE_INTERNAL_TOKEN);

  if (!requireToken) return;
  if (!configuredHash) {
    throw buildHttpError(503, 'La validación de token interno está activa, pero no hay token configurado.', RESPONSE_CODES.invalidToken);
  }
  if (!providedToken) {
    throw buildHttpError(401, 'Falta el token interno para acceder al endpoint público.', RESPONSE_CODES.invalidToken);
  }

  const providedHash = sha256(providedToken);
  if (!safeHashEquals(providedHash, configuredHash)) {
    throw buildHttpError(401, 'El token interno no es válido.', RESPONSE_CODES.invalidToken);
  }
}

function getPayloadDescriptor(req, endpointType) {
  const contentType = String(req.get('content-type') || '').toLowerCase();
  const format = inferPayloadFormat(req.body, contentType);
  const objectBody = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : null;
  let serializedBody = '';

  if (typeof req.body === 'string') {
    serializedBody = req.body.trim();
  } else if (Buffer.isBuffer(req.body)) {
    serializedBody = req.body.toString('utf8').trim();
  } else if (objectBody) {
    serializedBody = JSON.stringify(objectBody, null, 2);
  }

  const sanitizedBody = sanitizePayloadForStorage(serializedBody, objectBody, endpointType, format);
  return {
    contentType,
    format,
    serializedBody,
    sanitizedBody,
    objectBody,
    sha256: sha256(sanitizedBody),
    size: Buffer.byteLength(sanitizedBody || '', 'utf8'),
    fileExtension: format === 'xml' ? 'xml' : 'json'
  };
}

async function validateCertificatePayload({ query, context, payload, certificateService }) {
  if (payload.format === 'xml') {
    return {
      status: 'pendiente_integracion',
      code: RESPONSE_CODES.certificatePending,
      message: 'Se aceptó el XML de validación, pero aún falta implementar el parser XML específico del certificado del contribuyente.',
      certificateMode: 'xml',
      detail: {
        environment: context.environment,
        nota: 'Para validación real hoy usa JSON con certificateBase64 y certificatePassword, o integra tu proveedor QSCD/cloud.'
      }
    };
  }

  const body = payload.objectBody || {};
  const certificateMode = String(
    extractFirstDefined(body, ['certificateMode', 'modoCertificado', 'metodoCertificado']) || 'p12'
  ).trim().toLowerCase();

  if (certificateMode === 'qscd' || certificateMode === 'cloud') {
    return {
      status: 'pendiente_integracion',
      code: RESPONSE_CODES.certificatePending,
      message: 'El flujo QSCD/cloud quedó reservado, pero no se implementó una validación falsa. Debes conectar aquí el proveedor real del contribuyente.',
      certificateMode,
      detail: {
        proveedor: extractFirstDefined(body, ['provider', 'qscdProvider', 'proveedor']) || null,
        environment: context.environment
      }
    };
  }

  const certificateBase64 = extractFirstDefined(body, [
    'certificateBase64',
    'certificadoBase64',
    'p12Base64',
    'certificate',
    'certificado'
  ]);
  const certificatePassword = extractFirstDefined(body, [
    'certificatePassword',
    'claveCertificado',
    'password',
    'clave'
  ]);
  const requestedRnc = extractFirstDefined(body, ['rnc', 'RNC']) || context.business?.rnc || null;

  if (certificateBase64 && certificatePassword) {
    const validation = certificateService.validateCertificate(
      Buffer.from(String(certificateBase64), 'base64'),
      String(certificatePassword),
      requestedRnc
    );
    return {
      status: validation.valid ? 'validado_localmente' : 'rechazado_localmente',
      code: RESPONSE_CODES.certificateValidated,
      message: validation.valid
        ? 'El certificado fue validado localmente con node-forge. Aún falta la validación remota si el contribuyente usa QSCD o un proveedor cloud.'
        : 'El certificado fue leído, pero no pasó la validación local.',
      certificateMode,
      detail: validation
    };
  }

  const storedStatus = await certificateService.getCertificateStatus(query, context.businessId);
  if (!storedStatus?.hasCertificate) {
    return {
      status: 'pendiente_configuracion',
      code: RESPONSE_CODES.certificatePending,
      message: 'La empresa todavía no tiene un certificado .p12 almacenado ni se recibió uno en este request.',
      certificateMode,
      detail: {
        businessId: context.businessId,
        rnc: context.business?.rnc || null
      }
    };
  }

  return {
    status: storedStatus.isExpired ? 'rechazado_localmente' : 'validado_localmente',
    code: RESPONSE_CODES.certificateValidated,
    message: storedStatus.isExpired
      ? 'Existe un certificado cargado, pero está vencido.'
      : 'Se validó el certificado ya almacenado para la empresa.',
    certificateMode,
    detail: storedStatus
  };
}

async function createRequestLog(query, data) {
  const result = await query(
    `INSERT INTO dgii_request_log
       (request_id, business_id, branch_id, cash_register_id, endpoint_type, direction,
        http_method, route_path, environment, origin_header, ip_address, content_type,
        payload_format, payload_sha256, payload_size, request_payload, request_file_path,
        response_status, response_code, response_message, response_payload, response_file_path,
        error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      data.requestId,
      data.businessId || null,
      data.branchId || null,
      data.cashRegisterId || null,
      data.endpointType,
      data.direction || 'inbound',
      data.requestMethod || null,
      data.routePath || null,
      data.environment || null,
      data.originHeader || null,
      data.ipAddress || null,
      data.contentType || null,
      data.payloadFormat || null,
      data.payloadSha256 || null,
      data.payloadSize || 0,
      data.requestPayload || null,
      data.requestFilePath || null,
      data.responseStatus || null,
      data.responseCode || null,
      data.responseMessage || null,
      data.responsePayload || null,
      data.responseFilePath || null,
      data.errorMessage || null
    ]
  );
  return Number(result?.insertId || 0) || null;
}

async function finalizeRequestLog(query, requestLogId, responseBody, httpStatus, errorMessage) {
  if (!requestLogId) return;
  await query(
    `UPDATE dgii_request_log
     SET response_status = ?,
         response_code = ?,
         response_message = ?,
         response_payload = ?,
         error_message = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      httpStatus,
      responseBody?.codigo || null,
      responseBody?.mensaje || null,
      truncateText(JSON.stringify(responseBody || {}), 4000),
      errorMessage ? truncateText(String(errorMessage), 2000) : null,
      requestLogId
    ]
  ).catch(() => {});
}

async function archivePayload({ businessId, environment, endpointType, requestId, extension, encf, payloadText }) {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const dir = path.join(resolveStorageDir(), String(businessId), sanitizeEnvironment(environment), year, month, endpointType);
  fs.mkdirSync(dir, { recursive: true });

  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const safeEncf = sanitizeFilename(encf || '');
  const suffix = safeEncf ? `_${safeEncf}` : '';
  const fileName = `${stamp}_${requestId}${suffix}.${extension || 'json'}`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, payloadText || '', 'utf8');
  return { filePath };
}

function buildResponse(status, message, code, extra) {
  return {
    estado: status,
    mensaje: message,
    fecha: new Date().toISOString(),
    codigo: code,
    ...extra
  };
}

function buildHttpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.internalCode = code;
  return error;
}

function handleRouteError({ error, res, query, requestId, requestLogId, endpointType }) {
  const statusCode = Number(error?.statusCode || 500);
  const responseBody = buildResponse(
    statusCode >= 500 ? 'error' : 'rechazado',
    error?.message || 'Error interno al procesar la solicitud DGII.',
    error?.internalCode || RESPONSE_CODES.internalError,
    {
      requestId,
      endpoint: endpointType
    }
  );

  finalizeRequestLog(query, requestLogId, responseBody, statusCode, error?.message || null).catch(() => {});
  return res.status(statusCode).json(responseBody);
}

function getConfiguredTokenHash() {
  const rawToken = String(process.env.DGII_INTERNAL_TOKEN || '').trim();
  const rawHash = String(process.env.DGII_INTERNAL_TOKEN_HASH || '').trim().toLowerCase();
  if (rawHash) return rawHash;
  if (rawToken) return sha256(rawToken);
  return '';
}

function extractInternalToken(req) {
  const authHeader = String(req.get('authorization') || '').trim();
  if (/^bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^bearer\s+/i, '').trim();
  }
  return String(req.get('x-internal-token') || req.get('x-tecnocaja-token') || '').trim();
}

function safeHashEquals(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function sanitizePayloadForStorage(serializedBody, objectBody, endpointType, format) {
  if (!serializedBody) return '';
  if (format === 'json' && objectBody) {
    return JSON.stringify(sanitizeJsonValue(objectBody), null, 2);
  }
  let sanitized = String(serializedBody);
  if (endpointType === 'validacion_certificado') {
    sanitized = sanitized
      .replace(/<(password|clave|certificatePassword|claveCertificado)>([\s\S]*?)<\/\1>/gi, '<$1>[REDACTED]</$1>')
      .replace(/<(certificate|certificado|p12|p12Base64)>([\s\S]*?)<\/\1>/gi, '<$1>[REDACTED]</$1>');
  }
  return sanitized;
}

function sanitizeJsonValue(value, parentKey) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item, parentKey));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const sanitized = {};
  for (const [key, rawVal] of Object.entries(value)) {
    const normalizedKey = String(key).toLowerCase();
    if (SENSITIVE_KEYS.has(normalizedKey)) {
      if (normalizedKey.includes('certificate') || normalizedKey.includes('certificado') || normalizedKey.includes('p12')) {
        sanitized[`${key}Sha256`] = sha256(String(rawVal || ''));
      }
      sanitized[key] = '[REDACTED]';
      continue;
    }
    sanitized[key] = sanitizeJsonValue(rawVal, normalizedKey);
  }
  return sanitized;
}

function extractPayloadMetadata(text, objectBody) {
  const sourceText = String(text || '');
  const sourceObject = objectBody || {};
  return {
    encf: extractFirstDefined(sourceObject, ['encf', 'eNCF', 'ncf']) || extractFirstMatch(sourceText, [
      /<eNCF>([^<]+)<\/eNCF>/i,
      /<encf>([^<]+)<\/encf>/i,
      /"eNCF"\s*:\s*"([^"]+)"/i,
      /"encf"\s*:\s*"([^"]+)"/i
    ]),
    trackId: extractFirstDefined(sourceObject, ['trackId', 'TrackId', 'track_id']) || extractFirstMatch(sourceText, [
      /<TrackId>([^<]+)<\/TrackId>/i,
      /<trackId>([^<]+)<\/trackId>/i,
      /"trackId"\s*:\s*"([^"]+)"/i
    ]),
    rncEmisor: extractFirstDefined(sourceObject, ['rncEmisor', 'RNCEmisor', 'rnc']) || extractFirstMatch(sourceText, [
      /<RNCEmisor>([^<]+)<\/RNCEmisor>/i,
      /<rncEmisor>([^<]+)<\/rncEmisor>/i
    ]),
    rncReceptor: extractFirstDefined(sourceObject, ['rncComprador', 'RNCComprador', 'rncReceptor']) || extractFirstMatch(sourceText, [
      /<RNCComprador>([^<]+)<\/RNCComprador>/i,
      /<rncComprador>([^<]+)<\/rncComprador>/i
    ])
  };
}

function extractFirstDefined(source, keys) {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] != null && source[key] !== '') {
      return source[key];
    }
  }
  for (const value of Object.values(source)) {
    if (value && typeof value === 'object') {
      const nested = extractFirstDefined(value, keys);
      if (nested != null && nested !== '') return nested;
    }
  }
  return null;
}

function extractFirstMatch(text, patterns) {
  const source = String(text || '');
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function inferPayloadFormat(bodyOrText, contentType) {
  if (typeof bodyOrText === 'string' && looksLikeXml(bodyOrText)) return 'xml';
  if (Buffer.isBuffer(bodyOrText) && looksLikeXml(bodyOrText.toString('utf8'))) return 'xml';
  if (contentType.includes('xml')) return 'xml';
  if (bodyOrText && typeof bodyOrText === 'object') return 'json';
  if (contentType.includes('json')) return 'json';
  return 'json';
}

function isXmlRequest(req) {
  return String(req.get('content-type') || '').toLowerCase().includes('xml');
}

function isJsonRequest(req) {
  return String(req.get('content-type') || '').toLowerCase().includes('json');
}

function looksLikeXml(value) {
  return /^\s*</.test(String(value || ''));
}

function sanitizeEnvironment(environment) {
  const normalized = String(environment || 'test').trim().toLowerCase();
  if (normalized === 'produccion' || normalized === 'production' || normalized === 'prod') {
    return 'produccion';
  }
  if (normalized === 'certificacion' || normalized === 'certification') {
    return 'certificacion';
  }
  return 'test';
}

function buildPublicUrl(baseUrl, routePath) {
  if (!baseUrl) return null;
  return `${baseUrl}${routePath}`;
}

function getSemillaUpstreamUrl(environment) {
  const env = sanitizeEnvironment(environment);
  if (env === 'produccion') return String(process.env.DGII_FORWARD_SEMILLA_URL_PRODUCCION || '').trim();
  if (env === 'certificacion') return String(process.env.DGII_FORWARD_SEMILLA_URL_CERTIFICACION || '').trim();
  return String(process.env.DGII_FORWARD_SEMILLA_URL_TEST || '').trim();
}

function resolveStorageDir() {
  return process.env.DGII_STORAGE_DIR
    || path.join(process.env.TECNO_CAJA_USER_DATA || process.cwd(), 'runtime-data', 'dgii');
}

function createRequestId(prefix) {
  const safePrefix = sanitizeFilename(prefix || 'dgii');
  return `${safePrefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function sanitizeFilename(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function truncateText(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function normalizeNullableNumber(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function getRequestIp(req) {
  const forwarded = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || null;
}

module.exports = createDgiiRouter;
