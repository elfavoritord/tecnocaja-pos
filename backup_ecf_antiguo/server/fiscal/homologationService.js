'use strict';

const crypto = require('crypto');

const certSvc = require('./fiscalCertificateService');
const { upsertOne, writeFiscalAuditLog } = require('./fiscalExtensions');
const {
  normalizeEnvironment,
  getDgiiAuthUrls,
  getDgiiEcfUrls,
  getDgiiFcUrls
} = require('./dgiiEndpointService');

const MANUAL_CHECK_KEYS = new Set(['print_representation']);

function isTruthy(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'si', 'on'].includes(normalized);
}

function parseJsonSafe(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function truncateText(value, max = 500) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function normalizeCertificateMode(value) {
  const normalized = String(value || 'p12').trim().toLowerCase();
  if (['qscd', 'cloud', 'qscd/cloud'].includes(normalized)) return 'qscd';
  return 'p12';
}

function buildPublicUrls(publicBaseUrl) {
  const baseUrl = String(publicBaseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    return {
      baseUrl: '',
      recepcionUrl: '',
      aprobacionUrl: '',
      semillaUrl: '',
      validacionCertificadoUrl: ''
    };
  }
  return {
    baseUrl,
    recepcionUrl: `${baseUrl}/fe/recepcion/api/ecf`,
    aprobacionUrl: `${baseUrl}/fe/aprobacioncomercial/api/ecf`,
    semillaUrl: `${baseUrl}/fe/autenticacion/api/semilla`,
    validacionCertificadoUrl: `${baseUrl}/fe/autenticacion/api/validacioncertificado`
  };
}

function buildOfficialUrlsByEnvironment() {
  return ['test', 'certificacion', 'produccion'].reduce((acc, environment) => {
    acc[environment] = {
      auth: getDgiiAuthUrls(environment),
      ecf: getDgiiEcfUrls(environment),
      fc: getDgiiFcUrls(environment)
    };
    return acc;
  }, {});
}

function summarizeInternalToken(hashValue, requireInternalToken) {
  const hash = String(hashValue || '').trim().toLowerCase();
  return {
    requireInternalToken: !!Number(requireInternalToken || 0),
    configured: Boolean(hash),
    hashPreview: hash ? `${hash.slice(0, 8)}...${hash.slice(-6)}` : null
  };
}

function maskSecretPreview(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 8) return '********';
  return `${text.slice(0, 3)}********${text.slice(-3)}`;
}

async function loadDgiiSettingsRow(queryFn, businessId) {
  const rows = await queryFn(
    'SELECT * FROM dgii_company_settings WHERE business_id = ? LIMIT 1',
    [businessId]
  );
  return rows[0] || null;
}

async function getRecentTestRuns(queryFn, businessId, limit = 20) {
  return queryFn(
    `SELECT id, business_id, test_key, environment, status, summary, details_json, created_by, source_ip, created_at
     FROM fiscal_test_runs
     WHERE business_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [businessId, Number(limit) || 20]
  );
}

async function getManualChecks(queryFn, businessId) {
  return queryFn(
    `SELECT check_key, status, notes, updated_by, updated_at
     FROM fiscal_manual_checks
     WHERE business_id = ?`,
    [businessId]
  );
}

function normalizeDgiiSettings(rawSettings, fiscalConfig = {}) {
  const environment = normalizeEnvironment(rawSettings?.environment || fiscalConfig?.environment || 'test');
  const publicBaseUrl = String(rawSettings?.public_base_url || process.env.DGII_PUBLIC_BASE_URL || '').trim();
  const publicUrls = buildPublicUrls(publicBaseUrl);
  const certificateMode = normalizeCertificateMode(rawSettings?.certificate_mode || 'p12');

  return {
    environment,
    isActive: !!Number(fiscalConfig?.is_active || 0),
    fiscalStatus: fiscalConfig?.status || 'no_configurado',
    certificateMode,
    rfceEnabled: !!Number(rawSettings?.rfce_enabled || 0),
    qscdProvider: String(rawSettings?.qscd_provider || '').trim(),
    hasQscdConfig: Boolean(String(rawSettings?.qscd_config_json || '').trim()),
    qscdConfigPreview: rawSettings?.qscd_config_json ? '[CONFIGURACION PROTEGIDA]' : '',
    publicBaseUrl,
    publicUrls,
    allowedOrigins: String(rawSettings?.allowed_origins || process.env.DGII_PUBLIC_ALLOWED_ORIGINS || '').trim(),
    notes: String(rawSettings?.notes || '').trim(),
    internalToken: summarizeInternalToken(rawSettings?.internal_token_hash, rawSettings?.require_internal_token),
    authApiBaseUrl: String(rawSettings?.auth_api_base_url || getDgiiAuthUrls(environment).baseUrl).trim(),
    recepcionUrl: String(rawSettings?.recepcion_url || publicUrls.recepcionUrl).trim(),
    aprobacionUrl: String(rawSettings?.aprobacion_url || publicUrls.aprobacionUrl).trim(),
    semillaUrl: String(rawSettings?.semilla_url || publicUrls.semillaUrl).trim(),
    validacionCertificadoUrl: String(rawSettings?.validacion_certificado_url || publicUrls.validacionCertificadoUrl).trim()
  };
}

async function recordTestRun(queryFn, {
  businessId,
  testKey,
  environment = null,
  status = 'pending',
  summary = '',
  details = null,
  createdBy = null,
  sourceIp = null
}) {
  const detailsJson = details == null
    ? null
    : truncateText(JSON.stringify(details), 16000);

  return queryFn(
    `INSERT INTO fiscal_test_runs
       (business_id, test_key, environment, status, summary, details_json, created_by, source_ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      businessId,
      String(testKey || '').trim(),
      environment ? normalizeEnvironment(environment) : null,
      String(status || 'pending').trim(),
      truncateText(summary, 255),
      detailsJson,
      createdBy || null,
      sourceIp || null
    ]
  );
}

async function saveDgiiSettings(queryFn, businessId, payload, context = {}) {
  const fiscalRows = await queryFn(
    'SELECT * FROM fiscal_config WHERE business_id = ? LIMIT 1',
    [businessId]
  );
  const existing = await loadDgiiSettingsRow(queryFn, businessId);
  const fiscalConfig = fiscalRows[0] || {};
  const environment = normalizeEnvironment(payload.environment || existing?.environment || fiscalConfig.environment || 'test');
  const publicBaseUrl = String(payload.publicBaseUrl ?? existing?.public_base_url ?? process.env.DGII_PUBLIC_BASE_URL ?? '').trim();
  const publicUrls = buildPublicUrls(publicBaseUrl);
  const certificateMode = normalizeCertificateMode(payload.certificateMode || existing?.certificate_mode || 'p12');
  const qscdProvider = String(payload.qscdProvider ?? existing?.qscd_provider ?? '').trim();
  const allowedOrigins = String(payload.allowedOrigins ?? existing?.allowed_origins ?? '').trim();
  const notes = String(payload.notes ?? existing?.notes ?? '').trim();
  const rfceEnabled = isTruthy(payload.rfceEnabled) ? 1 : 0;
  const requireInternalToken = isTruthy(
    Object.prototype.hasOwnProperty.call(payload, 'requireInternalToken')
      ? payload.requireInternalToken
      : existing?.require_internal_token
  ) ? 1 : 0;

  let qscdConfigJson = existing?.qscd_config_json || null;
  if (payload.clearQscdConfig) {
    qscdConfigJson = null;
  } else if (Object.prototype.hasOwnProperty.call(payload, 'qscdConfigJson')) {
    const rawConfig = String(payload.qscdConfigJson || '').trim();
    qscdConfigJson = rawConfig || qscdConfigJson;
  }

  await upsertOne(queryFn, 'dgii_company_settings', 'business_id', {
    business_id: businessId,
    rnc: payload.rnc || existing?.rnc || null,
    environment,
    certificate_mode: certificateMode,
    rfce_enabled: rfceEnabled,
    qscd_provider: qscdProvider || null,
    qscd_config_json: qscdConfigJson,
    public_base_url: publicBaseUrl || null,
    recepcion_url: publicUrls.recepcionUrl || null,
    aprobacion_url: publicUrls.aprobacionUrl || null,
    semilla_url: publicUrls.semillaUrl || null,
    validacion_certificado_url: publicUrls.validacionCertificadoUrl || null,
    auth_api_base_url: getDgiiAuthUrls(environment).baseUrl,
    allowed_origins: allowedOrigins || null,
    require_internal_token: requireInternalToken,
    notes: notes || null
  });

  await writeFiscalAuditLog(queryFn, {
    businessId,
    userId: context.userId || null,
    action: 'configuracion_dgii_actualizada',
    description: `Configuracion DGII actualizada. Ambiente ${environment}. Certificado ${certificateMode}. RFCE ${rfceEnabled ? 'activo' : 'inactivo'}.`,
    ipAddress: context.ipAddress || null
  }).catch(() => {});

  return getDgiiConfigBundle(queryFn, businessId);
}

async function rotateInternalToken(queryFn, businessId, options = {}) {
  const token = crypto.randomBytes(24).toString('base64url');
  const tokenHash = sha256(token);
  const requireInternalToken = isTruthy(
    Object.prototype.hasOwnProperty.call(options, 'requireInternalToken')
      ? options.requireInternalToken
      : true
  ) ? 1 : 0;

  await upsertOne(queryFn, 'dgii_company_settings', 'business_id', {
    business_id: businessId,
    internal_token_hash: tokenHash,
    require_internal_token: requireInternalToken
  });

  await writeFiscalAuditLog(queryFn, {
    businessId,
    userId: options.userId || null,
    action: 'token_interno_rotado',
    description: `Token interno DGII rotado. Modo protegido: ${requireInternalToken ? 'activo' : 'inactivo'}.`,
    ipAddress: options.ipAddress || null
  }).catch(() => {});

  return {
    ok: true,
    token,
    maskedToken: maskSecretPreview(token),
    internalToken: summarizeInternalToken(tokenHash, requireInternalToken)
  };
}

async function saveManualCheck(queryFn, businessId, checkKey, payload = {}, context = {}) {
  const normalizedKey = String(checkKey || '').trim().toLowerCase();
  if (!MANUAL_CHECK_KEYS.has(normalizedKey)) {
    const error = new Error(`El check manual ${checkKey} no está permitido.`);
    error.statusCode = 400;
    throw error;
  }

  const status = ['ok', 'pending', 'warning'].includes(String(payload.status || '').trim().toLowerCase())
    ? String(payload.status).trim().toLowerCase()
    : 'pending';
  const notes = String(payload.notes || '').trim();

  const existingId = await resolveManualCheckId(queryFn, businessId, normalizedKey);
  if (existingId) {
    await queryFn(
      `UPDATE fiscal_manual_checks
       SET status = ?,
           notes = ?,
           updated_by = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [status, notes || null, context.userId || null, existingId]
    );
  } else {
    await queryFn(
      `INSERT INTO fiscal_manual_checks
         (business_id, check_key, status, notes, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [businessId, normalizedKey, status, notes || null, context.userId || null]
    );
  }

  await writeFiscalAuditLog(queryFn, {
    businessId,
    userId: context.userId || null,
    action: 'check_manual_homologacion_actualizado',
    description: `Check manual ${normalizedKey} actualizado a ${status}.`,
    ipAddress: context.ipAddress || null
  }).catch(() => {});

  return { ok: true, checkKey: normalizedKey, status, notes };
}

async function resolveManualCheckId(queryFn, businessId, checkKey) {
  const rows = await queryFn(
    'SELECT id FROM fiscal_manual_checks WHERE business_id = ? AND check_key = ? LIMIT 1',
    [businessId, checkKey]
  );
  return rows[0]?.id || null;
}

function buildLatestRunMap(testRuns) {
  const latest = new Map();
  for (const run of testRuns) {
    const key = String(run.test_key || '').trim();
    if (key && !latest.has(key)) {
      latest.set(key, {
        ...run,
        details: parseJsonSafe(run.details_json, null)
      });
    }
  }
  return latest;
}

function buildChecklistItem(key, label, status, message, source, extra = {}) {
  return {
    key,
    label,
    status,
    message,
    source,
    ...extra
  };
}

async function buildChecklist(queryFn, businessId, bundle) {
  const [docsAggRows, seqAggRows, testRuns, manualChecks] = await Promise.all([
    queryFn(
      `SELECT
          COUNT(*) AS total_docs,
          SUM(CASE WHEN xml_content IS NOT NULL AND xml_content <> '' THEN 1 ELSE 0 END) AS xml_docs,
          SUM(CASE WHEN signed_xml_content IS NOT NULL AND signed_xml_content <> '' THEN 1 ELSE 0 END) AS signed_docs,
          SUM(CASE WHEN track_id IS NOT NULL AND track_id <> '' THEN 1 ELSE 0 END) AS track_docs,
          SUM(CASE WHEN qr_url IS NOT NULL AND qr_url <> '' THEN 1 ELSE 0 END) AS qr_docs,
          SUM(CASE WHEN is_sent = 1 THEN 1 ELSE 0 END) AS sent_docs,
          SUM(CASE WHEN estado_dgii IN ('aceptado', 'aceptado_condicional') THEN 1 ELSE 0 END) AS accepted_docs,
          SUM(CASE WHEN submission_mode = 'rfce' THEN 1 ELSE 0 END) AS rfce_docs
       FROM ecf_documents
       WHERE business_id = ?`,
      [businessId]
    ),
    queryFn(
      `SELECT COUNT(*) AS total_active
       FROM fiscal_sequences
       WHERE business_id = ?
         AND activo = 1`,
      [businessId]
    ),
    getRecentTestRuns(queryFn, businessId, 50),
    getManualChecks(queryFn, businessId)
  ]);

  const docsAgg = docsAggRows[0] || {};
  const seqAgg = seqAggRows[0] || {};
  const latestRuns = buildLatestRunMap(testRuns);
  const manualByKey = new Map(
    manualChecks.map((row) => [String(row.check_key || '').trim().toLowerCase(), row])
  );
  const business = bundle.business || {};
  const certificate = bundle.certificate || {};
  const settings = bundle.dgiiSettings || {};

  const xmlRun = latestRuns.get('xml_validation');
  const signatureRun = latestRuns.get('signature_validation');
  const seedRun = latestRuns.get('seed');
  const certValidationRun = latestRuns.get('certificate_validation');
  const sendRun = latestRuns.get('send_ecf');
  const trackRun = latestRuns.get('trackid');
  const rfceRun = latestRuns.get('rfce');
  const printCheck = manualByKey.get('print_representation');

  const items = [
    buildChecklistItem(
      'certificate_loaded',
      'Certificado cargado',
      certificate.hasCertificate ? 'ok' : 'pending',
      certificate.hasCertificate
        ? `Certificado vigente hasta ${certificate.validTo || 'fecha desconocida'}.`
        : 'Aun no se ha cargado un certificado del contribuyente.',
      'local'
    ),
    buildChecklistItem(
      'rnc_configured',
      'RNC configurado',
      String(business.rnc || '').trim() ? 'ok' : 'pending',
      String(business.rnc || '').trim()
        ? `RNC ${business.rnc} configurado en los datos del negocio.`
        : 'Falta configurar el RNC del emisor.',
      'local'
    ),
    buildChecklistItem(
      'sequences_created',
      'Secuencias creadas',
      Number(seqAgg.total_active || 0) > 0 ? 'ok' : 'pending',
      Number(seqAgg.total_active || 0) > 0
        ? `${seqAgg.total_active} secuencia(s) e-NCF activa(s).`
        : 'No hay secuencias e-NCF activas.',
      'local'
    ),
    buildChecklistItem(
      'xml_validated',
      'XML validado',
      xmlRun?.status === 'ok'
        ? 'ok'
        : Number(docsAgg.xml_docs || 0) > 0
          ? 'warning'
          : 'pending',
      xmlRun?.status === 'ok'
        ? xmlRun.summary
        : Number(docsAgg.xml_docs || 0) > 0
          ? 'Hay XML generado localmente. Falta validacion XSD oficial/homologada para marcar OK final.'
          : 'Todavia no hay XML de prueba registrado.',
      xmlRun?.status === 'ok' ? 'test' : 'local'
    ),
    buildChecklistItem(
      'signature_validated',
      'Firma validada',
      signatureRun?.status === 'ok'
        ? 'ok'
        : Number(docsAgg.signed_docs || 0) > 0
          ? 'warning'
          : 'pending',
      signatureRun?.status === 'ok'
        ? signatureRun.summary
        : Number(docsAgg.signed_docs || 0) > 0
          ? 'La firma local se esta generando, pero la validacion criptografica homologada sigue pendiente.'
          : 'Aun no existe XML firmado para verificar.',
      signatureRun?.status === 'ok' ? 'test' : 'local'
    ),
    buildChecklistItem(
      'seed_ok',
      'Semilla OK',
      seedRun?.status === 'ok' ? 'ok' : 'pending',
      seedRun?.summary || 'Ejecuta la prueba de semilla contra DGII.',
      seedRun ? 'test' : 'pending'
    ),
    buildChecklistItem(
      'certificate_validation_ok',
      'Validacion certificado OK',
      certValidationRun?.status === 'ok' ? 'ok' : 'pending',
      certValidationRun?.summary || 'Valida el certificado almacenado para confirmar vigencia y coincidencia de RNC.',
      certValidationRun ? 'test' : 'pending'
    ),
    buildChecklistItem(
      'send_ecf_ok',
      'Envio e-CF OK',
      sendRun?.status === 'ok'
        ? 'ok'
        : Number(docsAgg.sent_docs || 0) > 0
          ? 'warning'
          : 'pending',
      sendRun?.summary
        || (Number(docsAgg.sent_docs || 0) > 0
          ? 'Existen documentos enviados, pero falta una prueba tecnica registrada desde este panel.'
          : 'Todavia no se ha enviado un e-CF de prueba desde el panel.'),
      sendRun?.status === 'ok' ? 'test' : (Number(docsAgg.sent_docs || 0) > 0 ? 'local' : 'pending')
    ),
    buildChecklistItem(
      'trackid_ok',
      'Consulta TrackID OK',
      trackRun?.status === 'ok'
        ? 'ok'
        : Number(docsAgg.track_docs || 0) > 0
          ? 'warning'
          : 'pending',
      trackRun?.summary
        || (Number(docsAgg.track_docs || 0) > 0
          ? 'Hay TrackID registrados, pero falta una consulta tecnica registrada desde este panel.'
          : 'Aun no se ha probado la consulta de TrackID.'),
      trackRun?.status === 'ok' ? 'test' : (Number(docsAgg.track_docs || 0) > 0 ? 'local' : 'pending')
    ),
    buildChecklistItem(
      'qr_generated',
      'QR generado',
      Number(docsAgg.qr_docs || 0) > 0 ? 'ok' : 'pending',
      Number(docsAgg.qr_docs || 0) > 0
        ? `${docsAgg.qr_docs} documento(s) con QR DGII generado.`
        : 'Todavia no hay comprobantes aceptados con QR generado.',
      Number(docsAgg.qr_docs || 0) > 0 ? 'local' : 'pending'
    ),
    buildChecklistItem(
      'rfce_tested',
      'RFCE probado',
      rfceRun?.status === 'ok'
        ? 'ok'
        : settings.rfceEnabled
          ? 'pending'
          : 'warning',
      rfceRun?.summary
        || (settings.rfceEnabled
          ? 'RFCE esta habilitado pero todavia no tiene una prueba homologada registrada.'
          : 'RFCE sigue desactivado o pendiente de implementacion real.'),
      rfceRun?.status === 'ok' ? 'test' : (settings.rfceEnabled ? 'pending' : 'todo')
    ),
    buildChecklistItem(
      'print_representation',
      'Representacion impresa validada',
      printCheck?.status || 'pending',
      printCheck?.notes || 'Marca este punto cuando valides la impresion termica/A4 con el formato homologado del contribuyente.',
      printCheck ? 'manual' : 'manual'
    )
  ];

  const summary = {
    ok: items.filter((item) => item.status === 'ok').length,
    warning: items.filter((item) => item.status === 'warning').length,
    pending: items.filter((item) => item.status === 'pending').length,
    total: items.length
  };

  return { items, summary };
}

async function getDgiiConfigBundle(queryFn, businessId) {
  const [fiscalRows, businessRows, dgiiSettingsRow, certificate, recentTestRuns] = await Promise.all([
    queryFn('SELECT * FROM fiscal_config WHERE business_id = ? LIMIT 1', [businessId]),
    queryFn(
      'SELECT id, nombre, razon_social, nombre_comercial, rnc, direccion, municipio, provincia, telefono, correo FROM businesses WHERE id = ? LIMIT 1',
      [businessId]
    ),
    loadDgiiSettingsRow(queryFn, businessId),
    certSvc.getCertificateStatus(queryFn, businessId).catch(() => ({ hasCertificate: false })),
    getRecentTestRuns(queryFn, businessId, 20)
  ]);

  const fiscalConfig = fiscalRows[0] || {};
  const business = businessRows[0] || {};
  const dgiiSettings = normalizeDgiiSettings(dgiiSettingsRow, fiscalConfig);
  const officialUrlsByEnvironment = buildOfficialUrlsByEnvironment();

  const bundle = {
    business,
    fiscalConfig: {
      isActive: !!Number(fiscalConfig.is_active || 0),
      status: fiscalConfig.status || 'no_configurado',
      environment: normalizeEnvironment(fiscalConfig.environment || dgiiSettings.environment || 'test'),
      lastConnStatus: fiscalConfig.last_conn_status || null,
      lastConnMsg: fiscalConfig.last_conn_msg || null,
      tokenExpiresAt: fiscalConfig.token_expires_at || null
    },
    certificate,
    dgiiSettings,
    officialUrlsByEnvironment,
    recentTestRuns: recentTestRuns.map((row) => ({
      ...row,
      details: parseJsonSafe(row.details_json, null)
    }))
  };

  bundle.checklist = await buildChecklist(queryFn, businessId, bundle);
  return bundle;
}

module.exports = {
  MANUAL_CHECK_KEYS,
  getDgiiConfigBundle,
  saveDgiiSettings,
  rotateInternalToken,
  recordTestRun,
  getRecentTestRuns,
  getManualChecks,
  saveManualCheck,
  buildPublicUrls,
  buildOfficialUrlsByEnvironment
};
