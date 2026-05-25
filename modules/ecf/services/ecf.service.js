'use strict';

const fs = require('fs');
const path = require('path');
const { formidable } = require('formidable');
const { OFFICIAL_ENVIRONMENTS, buildEcfConfig, normalizeEnvironmentKey, toBoolean } = require('../config/ecf.config');
const { getDocumentTypes, getDocumentType } = require('../config/document-types');
const { DgiiClient } = require('../dgii/client');
const { EcfRepository, digitsOnly, parseJson, parseEncfNumber } = require('../models/ecf.repository');
const signatureService = require('../signature/signature.service');
const { AuthService } = require('./auth.service');
const { buildTotals, generateEcfXml, generateRfceXml, normalizeEcfXmlStructure, normalizeEncfValue } = require('./ecf-generator');
const { importCertificationSet } = require('./certification-importer');
const { buildTransmissionFromSpreadsheetRow, importTestSet: importHomologationTestSet } = require('./test-set-importer');
const { FcService } = require('./fc.service');
const { ReceptionService } = require('./reception.service');
const { ReceptionStorageService } = require('./reception-storage.service');
const { SeedStorageService } = require('./seed-storage.service');
const { StatusService } = require('./status.service');
const { decryptText, encryptText, maskSecret } = require('./crypto-service');
const { EcfError, assertCondition } = require('../utils/errors');
const { createLogger } = require('../utils/logger');
const { parseXml } = require('../utils/xml.util');

const CERT_STORAGE_DIR = path.resolve(__dirname, '..', 'certificates');

function nowIso() {
  return new Date().toISOString();
}

function inferRequestedType(requestedType, buyerTaxId) {
  const normalized = String(requestedType || '').trim().toUpperCase();
  if (getDocumentType(normalized)) return normalized;
  return digitsOnly(buyerTaxId) ? 'E31' : 'E32';
}

function computeSecurityCode(signedXml) {
  const signatureValue = String(
    parseXml(signedXml).getElementsByTagName('SignatureValue')?.[0]?.textContent || ''
  ).trim();
  return require('crypto').createHash('sha256').update(signatureValue).digest('hex').slice(0, 6).toUpperCase();
}

function normalizeManualEncfInput(value, tipoEcf) {
  const raw = String(value || '').trim().toUpperCase();
  assertCondition(raw, 'Debes indicar un e-NCF manual válido.', { statusCode: 422 });
  if (/^\d+$/.test(raw)) {
    return normalizeEncfValue(`${String(tipoEcf || '').trim().toUpperCase()}${raw}`, tipoEcf);
  }
  return normalizeEncfValue(raw, tipoEcf);
}

function firstNodeText(parent, tagName) {
  if (!parent?.getElementsByTagName) return '';
  return String(parent.getElementsByTagName(tagName)?.[0]?.textContent || '').trim();
}

function parseDecimal(value, fallback = 0) {
  const normalized = String(value || '').replace(/,/g, '.').trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFiscalDateInput(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const dmyMatch = text.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dmyMatch) {
    return new Date(`${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}T00:00:00`);
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseOptionalInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCertificationStoredSource(value) {
  const raw = String(value || '').trim();
  if (!raw || !raw.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function normalizeDgiiState(payload) {
  const responseCode = getDgiiResponseCode(payload);
  if (responseCode === '1') return 'aceptado';
  if (responseCode === '2') return 'rechazado';
  if (responseCode === '3') return 'en_proceso';
  if (responseCode === '4') return 'aceptado_condicional';

  const httpStatus = Number(payload?.http?.status || payload?.httpStatus || 0);
  if (httpStatus >= 400) return 'rechazado';

  const candidates = [
    payload?.estado,
    payload?.Estado,
    payload?.status,
    payload?.mensaje,
    payload?.message,
    payload?.error,
    payload?.descripcion,
    payload?.Descripcion,
    payload?.http?.body,
    payload?.raw,
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  if (candidates.some((value) => value.includes('aceptado condicional') || value.includes('aceptado_condicional'))) return 'aceptado_condicional';
  if (candidates.some((value) => value.includes('aceptado'))) return 'aceptado';
  if (candidates.some((value) => value.includes('rechaz'))) return 'rechazado';
  if (candidates.some((value) => value.includes('proceso'))) return 'en_proceso';
  if (candidates.some((value) => value.includes('error'))) return 'error';
  return 'pendiente';
}

function collectDgiiResponseText(payload) {
  if (!payload) return '';
  const values = [];
  const push = (value) => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string' || typeof value === 'number') values.push(String(value));
    else if (Array.isArray(value)) value.forEach(push);
    else if (typeof value === 'object') Object.values(value).forEach(push);
  };
  push(payload);
  return values.join(' ').toLowerCase();
}

function getDgiiResponseCode(payload) {
  const direct = payload?.codigo ?? payload?.Codigo ?? payload?.code ?? payload?.Code ?? payload?.codigoRespuesta ?? payload?.CodigoRespuesta;
  if (direct !== undefined && direct !== null && String(direct).trim()) return String(direct).trim();
  const raw = String(payload?.raw || payload?.http?.body || '').trim();
  const match = raw.match(/(?:<codigo>|"codigo"\s*:)\s*"?(\d+)/i) || raw.match(/(?:<Codigo>|"Codigo"\s*:)\s*"?(\d+)/i);
  return match?.[1] || '';
}

function suggestDgiiSolution(payload) {
  const code = getDgiiResponseCode(payload);
  const text = collectDgiiResponseText(payload);
  if (code === '81') return 'Revisa que el archivo enviado a DGII use el formato RNC + eNCF + .xml sin texto extra.';
  if (code === '1209') return 'La secuencia ya fue utilizada. Usa el siguiente e-NCF autorizado antes de reenviar.';
  if (code === '11170') return 'Verifica Totales y Retención del E47; DGII exige coherencia entre TotalISRRetencion y el bloque Retencion del item.';
  if (text.includes('telefonoemisor')) return 'Corrige TelefonoEmisor al formato xxx-xxx-xxxx dentro de TablaTelefonoEmisor.';
  if (text.includes('nombredelarchivo') || text.includes('nombre del archivo')) return 'Usa como nombre DGII exactamente RNC + eNCF + .xml.';
  if (text.includes('tipo de archivo no válido')) return 'Asegura que el archivo temporal termine exactamente en .xml antes de subirlo.';
  if (text.includes('estructura del archivo xml')) return 'Revisa la estructura del XML frente a la XSD oficial del tipo de e-CF antes de reenviar.';
  return 'Revisa el código y mensaje DGII, compara el XML generado con la XSD oficial y corrige el campo señalado antes de reenviar.';
}

function isDgiiSequenceUsedResponse(payload) {
  const details = payload?.details || payload;
  const code = getDgiiResponseCode(details);
  if (code === '1209') return true;
  const text = collectDgiiResponseText(details);
  return text.includes('1209') || (text.includes('secuencia') && text.includes('utiliz'));
}

function buildPublicUrls(baseUrl) {
  const normalized = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!normalized) return { baseUrl: '' };
  return {
    baseUrl: normalized,
    recepcionUrl: `${normalized}/fe/recepcion/api/ecf`,
    aprobacionUrl: `${normalized}/fe/aprobacioncomercial/api/ecf`,
    semillaUrl: `${normalized}/fe/autenticacion/api/semilla`,
    validacionCertificadoUrl: `${normalized}/fe/autenticacion/api/validacioncertificado`,
  };
}

class EcfService {
  constructor({ query, withTransaction, resolveRequestActorUser }) {
    this.repository = new EcfRepository({ query, withTransaction });
    this.resolveRequestActorUser = resolveRequestActorUser;
    this.runtimeState = {
      lastConnection: null,
    };
    this.config = buildEcfConfig();
    this.logger = createLogger('ecf', { debug: this.config.DEBUG_ECF });
    this.seedStorage = new SeedStorageService({
      logger: createLogger('ecf.seed', { debug: this.config.DEBUG_ECF }),
    });
    this.receptionStorage = new ReceptionStorageService({
      logger: createLogger('ecf.reception.storage', { debug: this.config.DEBUG_ECF }),
    });
    this.dgiiClient = new DgiiClient({ config: this.config, logger: createLogger('ecf.dgii', { debug: this.config.DEBUG_ECF }) });
    this.authService = new AuthService({
      config: this.config,
      dgiiClient: this.dgiiClient,
      signatureService,
      logger: createLogger('ecf.auth', { debug: this.config.DEBUG_ECF }),
      certificateResolver: () => this.resolveCertificate(),
      seedStorage: this.seedStorage,
    });
    this.receptionService = new ReceptionService({
      authService: this.authService,
      dgiiClient: this.dgiiClient,
      logger: createLogger('ecf.reception', { debug: this.config.DEBUG_ECF }),
      config: this.config,
      storageService: this.receptionStorage,
    });
    this.statusService = new StatusService({
      authService: this.authService,
      dgiiClient: this.dgiiClient,
      logger: createLogger('ecf.status', { debug: this.config.DEBUG_ECF }),
      config: this.config,
      storageService: this.receptionStorage,
    });
    this.fcService = new FcService({
      authService: this.authService,
      dgiiClient: this.dgiiClient,
      logger: createLogger('ecf.fc', { debug: this.config.DEBUG_ECF }),
      config: this.config,
      storageService: this.receptionStorage,
    });
    this.certificationDir = path.resolve(process.cwd(), 'storage', 'ecf', 'certification');
    this.certificationSignedDir = path.join(this.certificationDir, 'signed');
  }

  async ensureReady() {
    await this.repository.ensureSchema();
    fs.mkdirSync(CERT_STORAGE_DIR, { recursive: true });
    fs.mkdirSync(this.certificationSignedDir, { recursive: true });
    this.seedStorage.ensureStorage();
    this.receptionStorage.ensureStorage();
  }

  applyRuntimeConfig(environment) {
    this.config = buildEcfConfig({ DGII_ENV: environment });
    this.dgiiClient.config = this.config;
    this.authService.config = this.config;
    this.authService.clearToken();
    this.receptionService.config = this.config;
    this.statusService.config = this.config;
  }

  async getCurrentActor(req, { adminOnly = false } = {}) {
    if (!this.resolveRequestActorUser) {
      return { id: null, usuario: 'Sistema', nombre: 'Sistema', rol: 'Sistema' };
    }
    const actor = await this.resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    const role = String(actor?.role_code || actor?.rol || '').toLowerCase();
    const isAdmin = role.includes('admin');
    if (adminOnly && !isAdmin) {
      throw new EcfError('Solo usuarios administradores pueden modificar la configuración fiscal.', { statusCode: 403 });
    }
    return actor;
  }

  async resolveCertificate() {
    await this.ensureReady();
    const stored = await this.repository.getCertificate(1);
    const certPath = stored?.certificate_path || this.config.CERT_PATH;
    const certPassword = stored?.password_encrypted ? decryptText(stored.password_encrypted) : this.config.CERT_PASSWORD;
    const certificate = signatureService.loadCertificate({
      certPath,
      certPassword,
    });
    const validation = signatureService.validateCertificate(certificate, {
      expectedRnc: (await this.repository.getResolvedEmitter(1)).rnc,
    });
    if (!validation.isValidNow) {
      throw new EcfError('El certificado configurado no está vigente.', { statusCode: 422, details: validation });
    }
    return certificate;
  }

  async getCertificateStatus() {
    const stored = await this.repository.getCertificate(1);
    if (!stored && !this.config.CERT_PATH) {
      return { hasCertificate: false };
    }

    try {
      const certificate = await this.resolveCertificate();
      const validation = signatureService.validateCertificate(certificate, {
        expectedRnc: (await this.repository.getResolvedEmitter(1)).rnc,
      });
      return {
        hasCertificate: true,
        fileName: stored?.file_name || path.basename(certificate.certPath),
        subject: validation.subject,
        issuer: validation.issuer,
        serialNumber: validation.serialNumber,
        validFrom: validation.validFrom,
        validTo: validation.validTo,
        status: validation.isExpired ? 'vencido' : 'valido',
        isExpired: validation.isExpired,
        rncMatch: validation.rncMatch,
      };
    } catch (error) {
      return {
        hasCertificate: Boolean(stored || this.config.CERT_PATH),
        status: 'error',
        error: error.message,
      };
    }
  }

  buildChecklist(emitter, certificate, sequences) {
    const items = [];
    const hasRnc = [9, 11].includes(digitsOnly(emitter.rnc).length);
    items.push({
      key: 'emitter_rnc',
      label: 'RNC del emisor',
      status: hasRnc ? 'ok' : 'error',
      message: hasRnc ? `RNC configurado: ${digitsOnly(emitter.rnc)}` : 'Debe registrar el RNC del emisor.',
    });
    items.push({
      key: 'emitter_profile',
      label: 'Perfil fiscal',
      status: emitter.razon_social && emitter.direccion ? 'ok' : 'error',
      message: emitter.razon_social && emitter.direccion
        ? 'Datos fiscales principales registrados.'
        : 'Faltan datos obligatorios del emisor.',
    });
    items.push({
      key: 'certificate',
      label: 'Certificado digital',
      status: certificate.hasCertificate ? (certificate.isExpired ? 'error' : 'ok') : 'pending',
      message: certificate.hasCertificate
        ? (certificate.isExpired ? 'El certificado está vencido.' : `Certificado válido hasta ${certificate.validTo}.`)
        : 'No hay certificado cargado.',
    });
    items.push({
      key: 'sequences',
      label: 'Secuencias e-NCF',
      status: sequences.some((item) => item.activo && !item.isExpired && !item.isExhausted) ? 'ok' : 'pending',
      message: sequences.some((item) => item.activo && !item.isExpired && !item.isExhausted)
        ? 'Hay secuencias disponibles para emitir.'
        : 'Debe configurar al menos una secuencia e-NCF activa.',
    });
    const summary = items.reduce((acc, item) => {
      acc.total += 1;
      if (item.status === 'ok') acc.ok += 1;
      else if (item.status === 'warning') acc.warning += 1;
      else acc.pending += 1;
      return acc;
    }, { total: 0, ok: 0, warning: 0, pending: 0 });
    return { items, summary };
  }

  async getSystemStatus() {
    await this.ensureReady();
    const emitter = await this.repository.getResolvedEmitter(1);
    const certificate = await this.getCertificateStatus();
    const sequences = await this.repository.listSequences(1);
    const checklist = this.buildChecklist(emitter, certificate, sequences);
    const ready = checklist.items.every((item) => item.status === 'ok');

    return {
      status: ready ? (emitter.is_active ? 'listo' : 'inactivo') : 'no_configurado',
      isActive: Boolean(emitter.is_active),
      environment: emitter.environment,
      hasRnc: [9, 11].includes(digitsOnly(emitter.rnc).length),
      hasCertificate: Boolean(certificate.hasCertificate),
      certificateStatus: certificate.status || 'pendiente',
      hasActiveSequences: sequences.some((item) => item.activo && !item.isExpired && !item.isExhausted),
      checklist,
      tokenExpiresAt: this.runtimeState.lastConnection?.tokenExpiresAt || null,
      lastConnStatus: this.runtimeState.lastConnection?.status || null,
      lastConnMsg: this.runtimeState.lastConnection?.message || null,
    };
  }

  async getBundle() {
    await this.ensureReady();
    const emitter = await this.repository.getResolvedEmitter(1);
    const certificate = await this.getCertificateStatus();
    const status = await this.getSystemStatus();
    return {
      business: {
        rnc: emitter.rnc,
        razon_social: emitter.razon_social,
        nombre_comercial: emitter.nombre_comercial,
        direccion: emitter.direccion,
        provincia: emitter.provincia,
        municipio: emitter.municipio,
        telefono: emitter.telefono,
        correo: emitter.correo,
      },
      fiscalConfig: {
        environment: emitter.environment,
        status: status.status,
        isActive: emitter.is_active,
      },
      dgiiSettings: {
        environment: emitter.environment,
        certificateMode: emitter.certificate_type,
        publicBaseUrl: emitter.public_base_url,
        allowedOrigins: emitter.allowed_origins,
        publicUrls: buildPublicUrls(emitter.public_base_url),
        internalToken: {
          requireInternalToken: emitter.require_internal_token,
          configured: Boolean(emitter.internal_token_hash),
          hashPreview: emitter.internal_token_hash ? `${String(emitter.internal_token_hash).slice(0, 10)}...` : '',
        },
        officialEndpoints: this.config.officialEnvironment,
      },
      certificate,
      checklist: status.checklist,
      officialUrlsByEnvironment: OFFICIAL_ENVIRONMENTS,
      seedStorage: this.seedStorage.getState(),
      receptionStorage: this.receptionStorage.getState(),
      certificationSummary: await this.repository.getCertificationSummary(),
      recentTestRuns: await this.repository.listRecentTestRuns(),
    };
  }

  async saveBusiness(req) {
    await this.ensureReady();
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    const payload = req.body || {};
    const emitter = await this.repository.upsertEmitter(1, {
      rnc: digitsOnly(payload.rnc),
      razon_social: String(payload.razon_social || '').trim(),
      nombre_comercial: String(payload.nombre_comercial || '').trim(),
      direccion: String(payload.direccion || '').trim(),
      provincia: String(payload.provincia || '').trim(),
      municipio: String(payload.municipio || '').trim(),
      telefono: String(payload.telefono || '').trim(),
      correo: String(payload.correo || '').trim(),
    });
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      actionName: 'emitter_updated',
      status: 'ok',
      detail: `Actualizó datos fiscales del emisor ${emitter.rnc || ''}.`,
    });
    return this.getBundle();
  }

  async saveDgiiSettings(req) {
    await this.ensureReady();
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    const body = req.body || {};
    const emitter = await this.repository.upsertEmitter(1, {
      environment: normalizeEnvironmentKey(body.environment || this.config.DGII_ENV),
      certificate_type: String(body.certificateMode || 'p12').trim().toLowerCase(),
      public_base_url: String(body.publicBaseUrl || '').trim(),
      allowed_origins: String(body.allowedOrigins || '').trim(),
      require_internal_token: toBoolean(body.requireInternalToken),
      internal_token_hash: toBoolean(body.requireInternalToken)
        ? (await this.repository.getResolvedEmitter(1)).internal_token_hash || this.repository.hashInternalToken(this.repository.generateInternalToken())
        : null,
      notes: String(body.notes || '').trim(),
    });
    this.applyRuntimeConfig(emitter.environment);
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      actionName: 'dgii_settings_updated',
      status: 'ok',
      detail: `Actualizó ambiente ${emitter.environment}.`,
    });
    return this.getBundle();
  }

  async saveEnvironment(req) {
    return this.saveDgiiSettings({
      ...req,
      body: {
        ...(req.body || {}),
        certificateMode: (await this.repository.getResolvedEmitter(1)).certificate_type,
      },
    });
  }

  async rotateInternalToken(req) {
    await this.ensureReady();
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    const token = this.repository.generateInternalToken();
    await this.repository.upsertEmitter(1, {
      require_internal_token: toBoolean(req.body?.requireInternalToken),
      internal_token_hash: this.repository.hashInternalToken(token),
    });
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      actionName: 'internal_token_rotated',
      status: 'ok',
      detail: 'Rotó el token interno DGII.',
    });
    return {
      ok: true,
      token,
      maskedToken: maskSecret(token),
      internalToken: maskSecret(token),
    };
  }

  async handleCertificateUpload(req) {
    await this.ensureReady();
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    const form = formidable({ multiples: false, maxFileSize: 10 * 1024 * 1024, keepExtensions: true });
    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (error, parsedFields, parsedFiles) => {
        if (error) reject(error);
        else resolve({ fields: parsedFields, files: parsedFiles });
      });
    });

    const rawCertificate = files.certificate || files.file;
    const uploaded = Array.isArray(rawCertificate) ? rawCertificate[0] : rawCertificate;
    const rawPassword = Array.isArray(fields.password) ? fields.password[0] : fields.password;
    assertCondition(uploaded?.filepath, 'No se recibió el archivo del certificado.', { statusCode: 400 });
    assertCondition(rawPassword, 'Debe indicar la contraseña del certificado.', { statusCode: 400 });

    const targetPath = path.join(CERT_STORAGE_DIR, 'business-1-active.p12');
    fs.copyFileSync(path.resolve(uploaded.filepath), targetPath);
    const certificate = signatureService.loadCertificate({
      certPath: targetPath,
      certPassword: String(rawPassword),
    });
    const validation = signatureService.validateCertificate(certificate, {
      expectedRnc: (await this.repository.getResolvedEmitter(1)).rnc,
    });
    await this.repository.saveCertificate(1, {
      fileName: uploaded.originalFilename || 'certificado.p12',
      certificatePath: targetPath,
      passwordEncrypted: encryptText(String(rawPassword)),
      subject: validation.subject,
      issuer: validation.issuer,
      serialNumber: validation.serialNumber,
      validFrom: validation.validFrom,
      validTo: validation.validTo,
      status: validation.isValidNow ? 'valido' : 'observado',
    });
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      actionName: 'certificate_uploaded',
      status: validation.isValidNow ? 'ok' : 'warning',
      detail: `Cargó certificado ${uploaded.originalFilename || 'certificado.p12'}.`,
      responsePayload: validation,
    });
    return {
      ok: validation.isValidNow,
      result: validation,
    };
  }

  async validateStoredCertificate() {
    const certificate = await this.resolveCertificate();
    const validation = signatureService.validateCertificate(certificate, {
      expectedRnc: (await this.repository.getResolvedEmitter(1)).rnc,
    });
    return {
      ok: validation.isValidNow,
      result: validation,
    };
  }

  async validateActivation() {
    const status = await this.getSystemStatus();
    const reasons = (status.checklist?.items || [])
      .filter((item) => item.status !== 'ok')
      .map((item) => item.message);
    return {
      canActivate: reasons.length === 0,
      reasons,
    };
  }

  async activate(req) {
    const validation = await this.validateActivation();
    if (!validation.canActivate) {
      throw new EcfError(`No se puede activar el módulo e-CF: ${validation.reasons.join(' | ')}`, { statusCode: 422 });
    }
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    await this.repository.upsertEmitter(1, { is_active: true });
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      actionName: 'ecf_activated',
      status: 'ok',
      detail: 'Activó la facturación electrónica.',
    });
    return { ok: true };
  }

  async deactivate(req) {
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    await this.repository.upsertEmitter(1, { is_active: false });
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      actionName: 'ecf_deactivated',
      status: 'ok',
      detail: 'Desactivó la facturación electrónica.',
    });
    return { ok: true };
  }

  async listSequences() {
    return this.repository.listSequences(1);
  }

  async generateNextENCF(req = {}) {
    await this.ensureReady();
    const body = {
      ...(req.query || {}),
      ...(req.body || {}),
    };
    const tipoComprobante = String(body.tipoComprobante || body.tipoEcf || body.prefijo || '').trim().toUpperCase();
    return this.repository.generateNextENCF({
      businessId: 1,
      tipoComprobante,
      sequenceId: body.sequenceId || body.sequence_id || null,
    });
  }

  async saveSequence(req) {
    await this.getCurrentActor(req, { adminOnly: true });
    return this.repository.saveSequence(1, req.body || {});
  }

  async updateSequenceNext(req) {
    await this.getCurrentActor(req, { adminOnly: true });
    const sequenceId = Number(req.params.id || 0);
    const nextNumber = Number(req.body?.proximoNumero || req.body?.nextNumber || req.body?.proximo || 0);
    const sequence = await this.repository.updateSequenceNextNumber(sequenceId, nextNumber);
    return {
      ok: true,
      sequence,
      message: `La secuencia ${sequence?.tipo_comprobante || sequenceId} ahora continuará en ${nextNumber}.`,
    };
  }

  async disableSequence(req) {
    await this.getCurrentActor(req, { adminOnly: true });
    await this.repository.disableSequence(Number(req.params.id));
    return { ok: true };
  }

  async buildConnectionTestResult(environmentOverride = null) {
    const emitter = await this.repository.getResolvedEmitter(1);
    const sequences = await this.repository.listSequences(1);
    const certificate = await this.getCertificateStatus();
    const checklist = this.buildChecklist(emitter, certificate, sequences);
    const blockingRequirements = checklist.items.filter((item) => item.status !== 'ok').map((item) => ({
      key: item.key,
      label: item.label,
      message: item.message,
    }));

    if (blockingRequirements.length) {
      return {
        ok: false,
        status: 'no_configurado',
        message: 'La configuración aún no está completa para iniciar pruebas.',
        blockingRequirements,
        checklist,
      };
    }

    if (environmentOverride) {
      this.applyRuntimeConfig(environmentOverride);
    }

    const auth = await this.authService.authenticate({ forceRefresh: true });
    this.runtimeState.lastConnection = {
      status: 'conectado',
      message: 'Autenticación DGII exitosa.',
      tokenExpiresAt: auth.expira,
      checkedAt: nowIso(),
    };

    return {
      ok: true,
      status: 'conectado',
      message: 'Autenticación DGII exitosa.',
      tokenExpiresAt: auth.expira,
      seedHistory: auth.seedHistory || null,
      checklist,
      debug: this.config.DEBUG_ECF ? {
        token: auth.token,
        expedido: auth.expedido,
        expira: auth.expira,
      } : undefined,
    };
  }

  async testConnection(req) {
    const environment = normalizeEnvironmentKey(req.body?.environment || (await this.repository.getResolvedEmitter(1)).environment);
    const result = await this.buildConnectionTestResult(environment);
    await this.repository.saveTestRun('authenticate', result.ok ? 'ok' : 'warning', result.message, result, environment);
    return result;
  }

  async testSeed(req) {
    const environment = normalizeEnvironmentKey(req.body?.environment || (await this.repository.getResolvedEmitter(1)).environment);
    this.applyRuntimeConfig(environment);
    const seed = await this.authService.requestSeed();
    const response = {
      ok: Boolean(seed.value),
      environment,
      seedDetected: Boolean(seed.value),
      seedPreview: seed.value ? `${seed.value.slice(0, 8)}...` : '',
      seedDate: seed.fecha || null,
      estado: seed.storage?.estado || 'obtenida',
      archivo: seed.storage?.xmlPath || null,
      seedUrl: this.config.DGII_SEMILLA_URL,
      rawResponseLength: Buffer.byteLength(seed.raw || '', 'utf8'),
      builtXmlLength: Buffer.byteLength(seed.xml || '', 'utf8'),
      rawResponsePreview: String(seed.raw || '').slice(0, 240),
      seedHistory: seed.storage || null,
    };
    await this.repository.saveTestRun(
      'seed',
      response.ok ? 'ok' : 'warning',
      response.ok
        ? 'Semilla obtenida desde DGII. Debe firmarse con el certificado .p12 antes de validarla.'
        : 'DGII no devolvió una semilla interpretable.',
      response,
      environment
    );
    return response;
  }

  async debugAuth(req) {
    const environment = normalizeEnvironmentKey(req.body?.environment || (await this.repository.getResolvedEmitter(1)).environment);
    this.applyRuntimeConfig(environment);
    const seed = await this.authService.requestSeed();
    const certificate = await this.resolveCertificate();
    const signedXml = signatureService.signXML(seed.xml, certificate);
    const signedSeed = this.seedStorage.markSigned({
      id: seed.storage?.id,
      signedXml,
      estado: 'firmada',
    });
    const verification = signatureService.verifySignature(signedXml);
    let auth;
    try {
      auth = await this.dgiiClient.validateSeed(signedXml);
    } catch (error) {
      this.seedStorage.markFailed({
        id: signedSeed.id,
        error: error.message,
      });
      throw error;
    }
    this.seedStorage.markAuthenticated({
      id: signedSeed.id,
      tokenDetected: Boolean(auth.token),
      issuedAt: auth.expedido || null,
      expiresAt: auth.expira || null,
    });
    const response = {
      ok: Boolean(auth.token),
      environment,
      seedValue: seed.value,
      seedFile: signedSeed.xmlPath || null,
      signedSeedFile: signedSeed.signedPath || null,
      validateSeedUrl: this.config.DGII_VALIDAR_SEMILLA_URL,
      signedXml,
      signatureVerification: verification,
      dgiiHttpStatus: auth.http?.status,
      dgiiResponseHeaders: auth.http?.headers,
      dgiiResponseBody: auth.raw || auth.http?.body || '',
      tokenDetected: Boolean(auth.token),
      issuedAt: auth.expedido,
      expiresAt: auth.expira,
    };
    await this.repository.saveTestRun(
      'debug_auth',
      response.ok ? 'ok' : 'warning',
      response.ok
        ? 'DGII aceptó la semilla firmada con el certificado .p12.'
        : 'DGII no devolvió token al validar la semilla firmada.',
      response,
      environment
    );
    return response;
  }

  async getSeedState() {
    await this.ensureReady();
    return this.seedStorage.getState();
  }

  async getCurrentSeedXml(req) {
    await this.ensureReady();
    const type = String(req.query?.type || 'original').trim().toLowerCase() === 'signed' ? 'signed' : 'original';
    return this.seedStorage.getCurrentXml(type);
  }

  async signCurrentSeed(req) {
    await this.ensureReady();
    await this.getCurrentActor(req, { adminOnly: true });
    const currentSeed = this.seedStorage.getCurrentXml('original');
    const certificate = await this.resolveCertificate();
    const signedXml = signatureService.signXML(currentSeed.xml, certificate);
    const verification = signatureService.verifySignature(signedXml);

    if (!verification.ok) {
      throw new EcfError('La firma local de la semilla actual no pasó la verificación básica.', {
        statusCode: 422,
        details: verification,
      });
    }

    const updated = this.seedStorage.markSigned({
      id: currentSeed.entry?.id || null,
      signedXml,
      estado: 'firmada',
    });

    return {
      ok: true,
      environment: updated.environment,
      estado: updated.estado,
      archivo: updated.xmlPath,
      archivoFirmado: updated.signedPath,
      seedHistory: updated,
      signatureVerification: verification,
      signedXmlPreview: String(signedXml || '').slice(0, 600),
    };
  }

  async clearSeedHistory(req) {
    await this.ensureReady();
    await this.getCurrentActor(req, { adminOnly: true });
    return this.seedStorage.clearHistory();
  }

  async repairStoredDocumentXml(document, certificate) {
    if (!document?.id || !String(document.xml_content || '').trim()) {
      return document;
    }

    const certificationSource = parseCertificationStoredSource(document.certification_original_xml);
    // Quitar BOM UTF-8 del XML almacenado — DGII rechaza con código 1 si hay BOM
    const storedXmlClean = String(document.xml_content || '').replace(/^﻿/, '');
    let normalizedXml = normalizeEcfXmlStructure(storedXmlClean, { removeSignature: true });
    // Cuando el caso de certificación proviene de un XML del set DGII (no de hoja de cálculo),
    // usamos el XML ORIGINAL como fuente de firma. Esto preserva exactamente todos los campos
    // (Municipio, Provincia, WebSite, NumeroFacturaInterna, PrecioUnitarioItem con 4 decimales,
    // ValorPagar, MontoPeriodo, TerminoPago, IdentificadorExtranjero, etc.) que DGII valida
    // contra su set de pruebas. Regenerar con nuestro generador pierde esos valores y causa
    // el rechazo "La propiedad X no es válida debido a que el valor enviado () no coincide...".
    const rawOriginalXml = String(document.certification_original_xml || '').trim();
    const isXmlSourcedCertification = document.certification_case_key
      && rawOriginalXml
      && (rawOriginalXml.startsWith('<') || rawOriginalXml.startsWith('<?'));

    let skipE47Rebuild = false;
    if (isXmlSourcedCertification) {
      const cleanOriginalXml = rawOriginalXml.replace(/^﻿/, '');
      const strippedOriginal = normalizeEcfXmlStructure(cleanOriginalXml, { removeSignature: true });
      if (strippedOriginal.trim()) {
        // El XML original ya tiene todos los valores correctos — no sobrescribir.
        normalizedXml = strippedOriginal;
        skipE47Rebuild = true; // FechaVencimientoSecuencia y demás ya están en el XML original.
      }
    } else if (certificationSource?.kind === 'spreadsheet_row' && certificationSource.row) {
      const rebuilt = buildTransmissionFromSpreadsheetRow({
        testCase: {
          encf: document.encf,
          tipoEcf: document.tipo_ecf,
          rawRow: certificationSource.row,
          linkedRawRow: certificationSource.linkedRawRow || null,
          sourceSheet: certificationSource.sourceSheet || null,
          submissionMode: certificationSource.submissionMode || null,
        },
        issueDate: new Date(),
        certificateContext: certificate,
      });
      normalizedXml = rebuilt.xml;
    }

    if (!skipE47Rebuild && String(document.tipo_ecf || '').trim().toUpperCase() === 'E47') {
      normalizedXml = await this.rebuildExteriorPaymentXml(document, normalizedXml);
    }

    // Forzar re-firma si el XML almacenado tenía BOM, si el contenido cambió (incluye el caso
    // en que normalizedXml proviene del original DGII, que difiere del regenerado), o si no hay firma.
    const storedSignedClean = String(document.signed_xml_content || '').replace(/^﻿/, '');
    const hadBom = document.xml_content !== storedXmlClean || document.signed_xml_content !== storedSignedClean;
    const needsResign = hadBom || normalizedXml !== storedXmlClean || !storedSignedClean.trim();
    if (!needsResign) {
      return document;
    }

    const signedXml = signatureService.signXML(normalizedXml, certificate);
    const verification = signatureService.verifySignature(signedXml);
    if (!verification.ok) {
      throw new EcfError('La reparación automática del XML no pasó la verificación local de firma.', {
        statusCode: 422,
        details: verification,
      });
    }

    await this.repository.updateDocumentPayload(document.id, {
      xml_content: normalizedXml,
      signed_xml_content: signedXml,
      codigo_seguridad: computeSecurityCode(signedXml),
      estado_dgii: 'firmado',
      signed_at: new Date(),
    });

    return {
      ...document,
      xml_content: normalizedXml,
      signed_xml_content: signedXml,
      codigo_seguridad: computeSecurityCode(signedXml),
      estado_dgii: 'firmado',
      signed_at: new Date().toISOString(),
    };
  }

  async rebuildExteriorPaymentXml(document, xmlContent = null) {
    const rawXml = String(xmlContent || document?.xml_content || '').trim();
    if (!rawXml) return rawXml;

    const xmlDoc = parseXml(rawXml.replace(/^\uFEFF/, ''));
    const root = xmlDoc.documentElement;
    if (!root) return rawXml;

    const sequence = document?.sequence_id ? await this.repository.getSequence(document.sequence_id) : null;
    const sequenceExpiry = sequence?.fecha_vencimiento || null;
    assertCondition(
      sequenceExpiry,
      `El documento ${document?.encf || document?.id || ''} requiere FechaVencimientoSecuencia para E47.`,
      { statusCode: 422 }
    );

    const encabezado = root.getElementsByTagName('Encabezado')?.[0];
    const emisorNode = encabezado?.getElementsByTagName('Emisor')?.[0];
    const compradorNode = encabezado?.getElementsByTagName('Comprador')?.[0];
    const idDocNode = encabezado?.getElementsByTagName('IdDoc')?.[0];
    const referenciaNode = root.getElementsByTagName('InformacionReferencia')?.[0];
    const itemNodes = Array.from(root.getElementsByTagName('Item') || []);

    const payload = {
      emitter: {
        rnc: firstNodeText(emisorNode, 'RNCEmisor'),
        razonSocial: firstNodeText(emisorNode, 'RazonSocialEmisor'),
        nombreComercial: firstNodeText(emisorNode, 'NombreComercial'),
        direccion: firstNodeText(emisorNode, 'DireccionEmisor'),
        telefono: Array.from(emisorNode?.getElementsByTagName('TelefonoEmisor') || [])
          .map((node) => String(node.textContent || '').trim())
          .filter(Boolean)
          .join(';'),
        correo: firstNodeText(emisorNode, 'CorreoEmisor'),
      },
      customer: {
        nombre: firstNodeText(compradorNode, 'RazonSocialComprador') || 'Beneficiario Exterior',
      },
      document: {
        eNCF: firstNodeText(idDocNode, 'eNCF') || document.encf,
        tipoeCF: 'E47',
        tipoPago: firstNodeText(idDocNode, 'TipoPago') || '1',
        fechaVencimientoSecuencia: sequenceExpiry,
        retentionIndicator: 1,
      },
      items: itemNodes.map((itemNode, index) => ({
        name: firstNodeText(itemNode, 'NombreItem') || `Item ${index + 1}`,
        quantity: parseDecimal(firstNodeText(itemNode, 'CantidadItem'), 1),
        unitPrice: parseDecimal(firstNodeText(itemNode, 'PrecioUnitarioItem'), parseDecimal(firstNodeText(itemNode, 'MontoItem'), 0)),
        discount: 0,
        taxRate: 0,
        billingIndicator: 4,
        retentionIndicator: 1,
        withholdingAmount: parseDecimal(firstNodeText(itemNode, 'MontoISRRetenido'), 0),
        goodsOrServicesIndicator: 2,
        additionalDescription: firstNodeText(itemNode, 'DescripcionItem'),
        unitMeasure: firstNodeText(itemNode, 'UnidadMedida') || null,
      })),
      issueDate: parseFiscalDateInput(firstNodeText(emisorNode, 'FechaEmision'))
        || parseFiscalDateInput(document.xml_generated_at)
        || parseFiscalDateInput(document.created_at)
        || new Date(),
    };

    assertCondition(payload.items.length > 0, 'El XML E47 no contiene ítems para reconstruirlo.', { statusCode: 422 });

    return generateEcfXml(payload).xml;
  }

  shouldAdvanceSequenceOnSend(document) {
    if (!document) return false;
    const normalizedState = String(document.estado_dgii || '').trim().toLowerCase();
    return Boolean(document.track_id || document.sent_at || ['enviado', 'aceptado', 'aceptado_condicional', 'rechazado', 'procesando', 'en_proceso'].includes(normalizedState));
  }

  extractPayloadFromDocumentXml(document, xmlContent, sequenceExpiry = null, replacementEncf = null) {
    const rawXml = String(xmlContent || '').trim();
    assertCondition(rawXml, 'El documento no tiene XML para regenerar su secuencia.', { statusCode: 422 });

    const xmlDoc = parseXml(rawXml.replace(/^\uFEFF/, ''));
    const root = xmlDoc.documentElement;
    assertCondition(root, 'El XML del documento no es válido.', { statusCode: 422 });

    const encabezado = root.getElementsByTagName('Encabezado')?.[0];
    const emisorNode = encabezado?.getElementsByTagName('Emisor')?.[0];
    const compradorNode = encabezado?.getElementsByTagName('Comprador')?.[0];
    const idDocNode = encabezado?.getElementsByTagName('IdDoc')?.[0];
    const itemNodes = Array.from(root.getElementsByTagName('Item') || []);
    const tipoEcf = String(document?.tipo_ecf || firstNodeText(idDocNode, 'TipoeCF') || '').trim().toUpperCase();

    return {
      emitter: {
        rnc: firstNodeText(emisorNode, 'RNCEmisor'),
        razonSocial: firstNodeText(emisorNode, 'RazonSocialEmisor'),
        nombreComercial: firstNodeText(emisorNode, 'NombreComercial'),
        direccion: firstNodeText(emisorNode, 'DireccionEmisor'),
        telefono: Array.from(emisorNode?.getElementsByTagName('TelefonoEmisor') || [])
          .map((node) => String(node.textContent || '').trim())
          .filter(Boolean)
          .join(';'),
        correo: firstNodeText(emisorNode, 'CorreoEmisor'),
      },
      customer: {
        rnc: firstNodeText(compradorNode, 'RNCComprador'),
        nombre: firstNodeText(compradorNode, 'RazonSocialComprador') || 'Consumidor Final',
        correo: firstNodeText(compradorNode, 'CorreoComprador'),
        telefono: firstNodeText(compradorNode, 'TelefonoComprador'),
        direccion: firstNodeText(compradorNode, 'DireccionComprador'),
      },
      document: {
        eNCF: normalizeEncfValue(
          replacementEncf || firstNodeText(idDocNode, 'eNCF') || document?.encf,
          tipoEcf
        ),
        tipoeCF: tipoEcf,
        tipoIngresos: firstNodeText(idDocNode, 'TipoIngresos') || null,
        tipoPago: firstNodeText(idDocNode, 'TipoPago') || '1',
        indicadorMontoGravado: parseOptionalInt(firstNodeText(idDocNode, 'IndicadorMontoGravado')),
        fechaVencimientoSecuencia: sequenceExpiry || firstNodeText(idDocNode, 'FechaVencimientoSecuencia') || null,
        retentionIndicator: parseOptionalInt(firstNodeText(root, 'IndicadorAgenteRetencionoPercepcion')) || 1,
        referencia: referenciaNode ? {
          ncfModificado: firstNodeText(referenciaNode, 'NCFModificado') || null,
          fechaNcfModificado: firstNodeText(referenciaNode, 'FechaNCFModificado') || null,
          codigoModificacion: firstNodeText(referenciaNode, 'CodigoModificacion') || null,
        } : null,
      },
      items: itemNodes.map((itemNode, index) => ({
        name: firstNodeText(itemNode, 'NombreItem') || `Item ${index + 1}`,
        quantity: parseDecimal(firstNodeText(itemNode, 'CantidadItem'), 1),
        unitPrice: parseDecimal(firstNodeText(itemNode, 'PrecioUnitarioItem'), parseDecimal(firstNodeText(itemNode, 'MontoItem'), 0)),
        discount: parseDecimal(firstNodeText(itemNode, 'DescuentoMonto'), 0),
        taxRate: parseDecimal(firstNodeText(itemNode, 'TasaITBIS'), 0),
        billingIndicator: parseOptionalInt(firstNodeText(itemNode, 'IndicadorFacturacion')),
        retentionIndicator: parseOptionalInt(firstNodeText(itemNode, 'IndicadorAgenteRetencionoPercepcion')) || 1,
        withholdingAmount: parseDecimal(firstNodeText(itemNode, 'MontoISRRetenido'), 0),
        goodsOrServicesIndicator: tipoEcf === 'E47'
          ? 2
          : (parseOptionalInt(firstNodeText(itemNode, 'IndicadorBienoServicio')) || 1),
        additionalDescription: firstNodeText(itemNode, 'DescripcionItem'),
        unitMeasure: firstNodeText(itemNode, 'UnidadMedida') || null,
      })),
      issueDate: parseFiscalDateInput(firstNodeText(emisorNode, 'FechaEmision'))
        || parseFiscalDateInput(document?.xml_generated_at)
        || parseFiscalDateInput(document?.created_at)
        || new Date(),
    };
  }

  async advanceDocumentToNextSequence(document, certificate, options = {}) {
    assertCondition(document?.sequence_id, `El documento ${document?.encf || document?.id || ''} no tiene una secuencia asociada para avanzar al siguiente e-NCF.`, {
      statusCode: 422,
    });

    const manualEncf = String(options.manualEncf || '').trim();
    const currentEncf = normalizeEncfValue(document.encf, document.tipo_ecf);
    let normalizedReservedEncf = currentEncf;
    let sequence = null;

    if (manualEncf) {
      normalizedReservedEncf = normalizeManualEncfInput(manualEncf, document.tipo_ecf);
      const manualNext = parseEncfNumber(normalizedReservedEncf, document.tipo_ecf) + 1;
      sequence = await this.repository.updateSequenceNextNumber(document.sequence_id, manualNext);
    } else {
      await this.repository.advanceSequenceAfterUse(document.sequence_id, document.encf);
      let reserved = await this.repository.reserveNextEncfForSequence(document.sequence_id, document.tipo_ecf);
      normalizedReservedEncf = normalizeEncfValue(reserved.encf, document.tipo_ecf);
      if (normalizedReservedEncf === currentEncf) {
        const forcedNext = parseEncfNumber(currentEncf, document.tipo_ecf) + 1;
        sequence = await this.repository.updateSequenceNextNumber(document.sequence_id, forcedNext);
        reserved = await this.repository.reserveNextEncfForSequence(document.sequence_id, document.tipo_ecf);
        normalizedReservedEncf = normalizeEncfValue(reserved.encf, document.tipo_ecf);
      } else {
        sequence = reserved.sequence || null;
      }
    }

    const normalizedXml = normalizeEcfXmlStructure(document.xml_content || document.signed_xml_content || '', { removeSignature: true });
    const payload = this.extractPayloadFromDocumentXml(document, normalizedXml, sequence?.fecha_vencimiento || null, normalizedReservedEncf);
    const regenerated = generateEcfXml(payload);
    const signedXml = signatureService.signXML(regenerated.xml, certificate);
    const verification = signatureService.verifySignature(signedXml);
    if (!verification.ok) {
      throw new EcfError('La firma del documento regenerado con el siguiente e-NCF no pasó la verificación local.', {
        statusCode: 422,
        details: verification,
      });
    }

    await this.repository.reissueDocument(document.id, {
      sequence_id: document.sequence_id,
      encf: normalizedReservedEncf,
      estado_dgii: 'firmado',
      codigo_seguridad: computeSecurityCode(signedXml),
      nombre_comprador: document.nombre_comprador || payload.customer?.nombre || null,
      rnc_comprador: digitsOnly(document.rnc_comprador || payload.customer?.rnc || ''),
      subtotal: regenerated.totals.subtotal,
      descuento_total: regenerated.totals.totalDiscount,
      monto_exento: regenerated.totals.exemptAmount,
      monto_gravado: regenerated.totals.totalTaxed,
      itbis_total: regenerated.totals.totalTax,
      monto_total: regenerated.totals.total,
      xml_content: regenerated.xml,
      signed_xml_content: signedXml,
      signed_at: new Date(),
    });

    return {
      ...document,
      encf: normalizedReservedEncf,
      estado_dgii: 'firmado',
      track_id: null,
      sent_at: null,
      error_message: null,
      dgii_response_json: null,
      codigo_seguridad: computeSecurityCode(signedXml),
      xml_content: regenerated.xml,
      signed_xml_content: signedXml,
      xml_generated_at: new Date().toISOString(),
      signed_at: new Date().toISOString(),
    };
  }

  async sendPreparedDocument(document) {
    if (String(document.submission_mode || '').toLowerCase() === 'rfce') {
      return this.fcService.sendConsumptionSummary({
        signedXml: document.signed_xml_content,
        filename: `${document.encf || `documento-${document.id}`}-rfce.xml`,
      });
    }

    return this.receptionService.sendSignedEcf({
      signedXml: document.signed_xml_content,
      filename: `${document.encf || `documento-${document.id}`}.xml`,
    });
  }

  async logDgiiSequenceUsed(document, response, context = {}) {
    await this.repository.markDocumentSent(document.id, {
      estado_dgii: 'rechazado',
      track_id: null,
      dgii_response_json: response,
      error_message: response?.mensaje || response?.message || response?.descripcion || 'DGII indicó que la secuencia ya fue utilizada.',
    });
    await this.repository.saveAudit({
      userId: context.userId || null,
      userName: context.userName || null,
      userRole: context.userRole || null,
      saleId: document.sale_id || context.saleId || null,
      branchId: document.branch_id || context.branchId || null,
      cashRegisterId: document.cash_register_id || context.cashRegisterId || null,
      sequenceId: document.sequence_id || null,
      documentId: document.id,
      tipoComprobante: document.tipo_ecf || null,
      encf: document.encf || null,
      actionName: 'sequence_1209_consumed',
      status: 'warning',
      detail: `DGII rechazó ${document.encf || ''} por secuencia utilizada. Se avanzará al siguiente e-NCF.`,
      responsePayload: response,
    });
  }

  async retryDocumentAfterSequenceUsed(document, certificate, context = {}) {
    let currentDocument = document;
    let lastResponse = null;
    let retries = 0;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.logDgiiSequenceUsed(currentDocument, lastResponse || context.response || {}, context);
      currentDocument = await this.advanceDocumentToNextSequence(currentDocument, certificate);
      retries += 1;

      try {
        const response = await this.sendPreparedDocument(currentDocument);
        if (!isDgiiSequenceUsedResponse(response)) {
          return { document: currentDocument, response, retries };
        }
        lastResponse = response;
      } catch (error) {
        if (!isDgiiSequenceUsedResponse(error)) throw error;
        lastResponse = error.details || { error: error.message };
      }
    }

    throw new EcfError('DGII rechazó varios e-NCF consecutivos como ya utilizados. La secuencia fue avanzada; revise el rango autorizado.', {
      statusCode: 502,
      details: lastResponse,
    });
  }

  async finalizeSentDocument(document, response, fallbackMessage = 'Documento enviado a DGII.') {
    const trackId = response.trackId || response.trackid || response.TrackId || null;
    const state = trackId ? 'enviado' : normalizeDgiiState(response);
    if (state !== 'rechazado' && document?.sequence_id) {
      await this.repository.advanceSequenceAfterUse(document.sequence_id, document.encf);
    }

    await this.repository.markDocumentSent(document.id, {
      estado_dgii: state,
      track_id: trackId,
      dgii_response_json: response,
      error_message: state === 'rechazado'
        ? (response.mensaje || response.message || response.descripcion || 'DGII rechazó el documento.')
        : null,
    });

    if (document.sale_id) {
      await this.repository.attachSaleSummary(document.sale_id, {
        encf: document.encf,
        tipoEcf: document.tipo_ecf,
        documentId: document.id,
        estado: state,
        trackId,
        error: response.mensaje || response.message || response.descripcion || null,
      });
    }

    return {
      ok: state !== 'rechazado',
      estado: state,
      mensaje: response.mensaje || response.message || response.descripcion || fallbackMessage,
      trackId,
      encf: document.encf,
      documentId: document.id,
      dgiiResponse: response,
    };
  }

  async retryDocumentRejectedByTrackStatus(document, dgiiStatus, context = {}) {
    if (!isDgiiSequenceUsedResponse(dgiiStatus) || !document?.sequence_id) return null;

    const certificate = await this.resolveCertificate();
    const repairedDocument = await this.repairStoredDocumentXml(document, certificate);
    const retryResult = await this.retryDocumentAfterSequenceUsed(repairedDocument, certificate, {
      ...context,
      response: dgiiStatus,
    });
    const finalized = await this.finalizeSentDocument(
      retryResult.document,
      retryResult.response,
      'Documento regenerado y reenviado por secuencia ya utilizada.'
    );

    await this.repository.saveAudit({
      userId: context.userId || null,
      userName: context.userName || null,
      userRole: context.userRole || null,
      saleId: retryResult.document.sale_id || null,
      branchId: retryResult.document.branch_id || null,
      cashRegisterId: retryResult.document.cash_register_id || null,
      sequenceId: retryResult.document.sequence_id || null,
      documentId: retryResult.document.id,
      tipoComprobante: retryResult.document.tipo_ecf || null,
      encf: retryResult.document.encf || null,
      actionName: 'track_1209_auto_retry',
      status: finalized.ok ? 'ok' : 'warning',
      detail: `Consulta TrackID devolvió 1209; documento reenviado con ${retryResult.document.encf}.`,
      responsePayload: {
        previousTrackId: dgiiStatus.trackId || context.trackId || null,
        newTrackId: finalized.trackId,
        retries: retryResult.retries,
      },
    });

    return {
      ...finalized,
      autoRetry: true,
      previousTrackId: dgiiStatus.trackId || context.trackId || null,
      previousEncf: document.encf,
      retries: retryResult.retries,
    };
  }

  buildSignedXmlForManualSend(xmlContent, certificate) {
    const normalizedXml = normalizeEcfXmlStructure(xmlContent, { removeSignature: true });
    const signedXml = signatureService.signXML(normalizedXml, certificate);
    const verification = signatureService.verifySignature(signedXml);
    if (!verification.ok) {
      throw new EcfError('El XML indicado no pasó la verificación local después de normalizarse y firmarse.', {
        statusCode: 422,
        details: verification,
      });
    }
    return {
      normalizedXml,
      signedXml,
      verification,
    };
  }

  async enviarDocumento(req) {
    await this.ensureReady();
    await this.getCurrentActor(req, { adminOnly: true });

    const emitter = await this.repository.getResolvedEmitter(1);
    const environment = normalizeEnvironmentKey(req.body?.environment || emitter.environment);
    this.applyRuntimeConfig(environment);

    const xmlPathRaw = String(req.body?.xmlPath || req.body?.rutaXml || '').trim();
    const manualEncfRaw = String(req.body?.manualEncf || req.body?.encfManual || req.body?.encf || '').trim();
    const documentId = Number(req.body?.documentId || 0) || null;
    let result;
    let resolvedXmlPath = null;
    let sourceDocument = null;

    if (xmlPathRaw) {
      resolvedXmlPath = path.isAbsolute(xmlPathRaw)
        ? path.resolve(xmlPathRaw)
        : path.resolve(process.cwd(), xmlPathRaw);
      assertCondition(fs.existsSync(resolvedXmlPath), `El XML indicado no existe: ${resolvedXmlPath}`, { statusCode: 404 });
      assertCondition(!manualEncfRaw, 'El e-NCF manual solo puede aplicarse cuando el sistema envía un documento interno, no al usar una ruta XML manual.', { statusCode: 422 });
      const certificate = await this.resolveCertificate();
      const manualXml = fs.readFileSync(resolvedXmlPath, 'utf8');
      const preparedXml = this.buildSignedXmlForManualSend(manualXml, certificate);

      result = await this.receptionService.sendSignedEcf({
        signedXml: preparedXml.signedXml,
        filename: path.basename(resolvedXmlPath),
      });
    } else {
      sourceDocument = documentId
        ? await this.repository.getDocument(documentId)
        : await this.repository.getLatestDocument();

      assertCondition(sourceDocument, 'No hay documentos e-CF disponibles para enviar.', { statusCode: 404 });
      const certificate = await this.resolveCertificate();
      sourceDocument = await this.repairStoredDocumentXml(sourceDocument, certificate);
      if (manualEncfRaw) {
        sourceDocument = await this.advanceDocumentToNextSequence(sourceDocument, certificate, { manualEncf: manualEncfRaw });
      } else if (this.shouldAdvanceSequenceOnSend(sourceDocument)) {
        sourceDocument = await this.advanceDocumentToNextSequence(sourceDocument, certificate);
      }
      assertCondition(
        String(sourceDocument.signed_xml_content || '').trim(),
        'El último documento e-CF no tiene XML firmado para enviar. Indica una ruta XML o firma un documento primero.',
        { statusCode: 422 }
      );

      try {
        result = await this.sendPreparedDocument(sourceDocument);
      } catch (error) {
        if (!isDgiiSequenceUsedResponse(error)) throw error;
        const retryResult = await this.retryDocumentAfterSequenceUsed(sourceDocument, certificate, {
          response: error.details || { error: error.message },
        });
        sourceDocument = retryResult.document;
        result = retryResult.response;
      }
      if (isDgiiSequenceUsedResponse(result)) {
        const retryResult = await this.retryDocumentAfterSequenceUsed(sourceDocument, certificate, {
          response: result,
        });
        sourceDocument = retryResult.document;
        result = retryResult.response;
      }
      if (normalizeDgiiState(result) !== 'rechazado' && sourceDocument.sequence_id) {
        await this.repository.advanceSequenceAfterUse(sourceDocument.sequence_id, sourceDocument.encf);
      }
    }

    await this.repository.saveTestRun(
      'send_ecf',
      result.trackId ? 'ok' : 'warning',
      result.trackId
        ? `Documento enviado a DGII. TrackID ${result.trackId}.`
        : (result.descripcion || result.mensaje || 'DGII respondió al envío sin TrackID.'),
      {
        ...result,
        environment,
        archivo: result.archivoEnviado,
        rutaXml: resolvedXmlPath,
        documentId: sourceDocument?.id || documentId || null,
        encf: sourceDocument?.encf || null,
        recepcionUrl: this.config.DGII_RECEPCION_URL,
      },
      environment
    );

    return {
      trackId: result.trackId,
      mensaje: result.mensaje || result.descripcion || 'Documento enviado a DGII.',
      error: result.error || null,
      codigo: result.codigo || null,
      descripcion: result.descripcion || null,
      fecha: result.fecha || null,
      estado: result.estado || 'ENVIADO',
      environment,
      archivo: result.archivoEnviado || null,
      trackFile: result.trackPath || null,
      documentId: sourceDocument?.id || documentId || null,
      encf: sourceDocument?.encf || null,
      dgiiStatus: result.http?.status || null,
      dgiiResponseBody: result.raw || '',
    };
  }

  async consultarTrackId(trackId, req) {
    await this.ensureReady();
    const actor = await this.getCurrentActor(req, { adminOnly: true });

    const emitter = await this.repository.getResolvedEmitter(1);
    const environment = normalizeEnvironmentKey(req.query?.environment || req.body?.environment || emitter.environment);
    this.applyRuntimeConfig(environment);

    const normalizedTrackId = String(trackId || '').trim();
    assertCondition(normalizedTrackId, 'Debes indicar un TrackId para consultar.', { statusCode: 422 });
    const shouldAutoRetry = toBoolean(req.query?.autoRetry ?? req.body?.autoRetry ?? false);

    const result = await this.receptionService.getTrackStatus(normalizedTrackId);
    const linkedDocument = await this.repository.getDocumentByTrackId(normalizedTrackId)
      || await this.repository.getDocumentByEncf(result.encf);
    const autoRetry = shouldAutoRetry && linkedDocument
      ? await this.retryDocumentRejectedByTrackStatus(linkedDocument, result, {
          userId: actor.id,
          userName: actor.nombre || actor.usuario,
          userRole: actor.rol || actor.role_code,
          trackId: normalizedTrackId,
        })
      : null;

    await this.repository.saveTestRun(
      'trackid',
      autoRetry?.ok ? 'ok' : result.estado === 'RECHAZADO' ? 'warning' : 'ok',
      autoRetry
        ? `Consulta TrackID ${normalizedTrackId}: 1209 detectado; reenviado con ${autoRetry.encf}.`
        : `Consulta TrackID ${normalizedTrackId}: ${result.estado}.`,
      {
        ...result,
        environment,
        consultaUrl: this.config.DGII_CONSULTA_URL,
        autoRetry,
      },
      environment
    );

    if (autoRetry) {
      return {
        trackId: autoRetry.trackId,
        previousTrackId: autoRetry.previousTrackId,
        mensaje: autoRetry.mensaje,
        error: null,
        codigo: null,
        descripcion: 'DGII devolvió 1209 en la consulta TrackID; se regeneró y reenvió automáticamente.',
        fecha: result.fecha || null,
        estado: autoRetry.estado,
        rnc: result.rnc || null,
        encf: autoRetry.encf,
        previousEncf: autoRetry.previousEncf,
        secuenciaUtilizada: result.secuenciaUtilizada ?? null,
        fechaRecepcion: result.fechaRecepcion || null,
        mensajes: result.mensajes || [],
        environment,
        archivoEstado: result.statusPath || null,
        documentId: autoRetry.documentId,
        autoRetry: true,
        retries: autoRetry.retries,
        dgiiStatus: autoRetry.dgiiResponse?.http?.status || null,
        dgiiResponseBody: autoRetry.dgiiResponse?.raw || '',
      };
    }

    return {
      trackId: result.trackId,
      mensaje: result.mensaje || result.descripcion || 'Consulta completada.',
      error: result.error || null,
      codigo: result.codigo || null,
      descripcion: result.descripcion || null,
      fecha: result.fecha || null,
      estado: normalizeDgiiState(result),
      rnc: result.rnc || null,
      encf: result.encf || null,
      secuenciaUtilizada: result.secuenciaUtilizada ?? null,
      fechaRecepcion: result.fechaRecepcion || null,
      mensajes: result.mensajes || [],
      environment,
      archivoEstado: result.statusPath || null,
      autoRetryAvailable: Boolean(!shouldAutoRetry && linkedDocument && isDgiiSequenceUsedResponse(result)),
      dgiiStatus: result.http?.status || null,
      dgiiResponseBody: result.raw || '',
    };
  }

  async getCurrentSentXml() {
    await this.ensureReady();
    return this.receptionStorage.getCurrentSentXml();
  }

  async buildPayloadForSale(saleId, requestedType) {
    const emitter = await this.repository.getResolvedEmitter(1);
    const { sale, items } = await this.repository.getSaleWithItems(saleId);
    const buyerTaxId = sale.client_tax_id || sale.client_tax_id_snapshot || '';
    const tipoEcf = inferRequestedType(requestedType, buyerTaxId);
    const reservation = await this.repository.createDocumentFromSale({
      saleId,
      userId: sale.user_id || null,
      tipoEcf,
      environment: emitter.environment,
    });

    const preparedItems = items.map((item) => ({
      name: item.product_name || item.nombre || 'Producto',
      quantity: Number(item.qty || 0),
      unitPrice: Number(item.price || 0),
      discount: Number(item.discount_amount || 0) > 0
        ? Number(item.discount_amount || 0)
        : Number(item.discount_rate || 0) > 0
          ? Number(item.qty || 0) * Number(item.price || 0) * (Number(item.discount_rate || 0) / 100)
          : 0,
      taxRate: Number(item.tax_rate || item.itbis || 0),
    }));

    const totals = buildTotals(preparedItems);
    const generated = generateEcfXml({
      emitter: {
        rnc: emitter.rnc,
        razonSocial: emitter.razon_social,
        nombreComercial: emitter.nombre_comercial,
        direccion: emitter.direccion,
        telefono: emitter.telefono,
        correo: emitter.correo,
      },
      customer: {
        rnc: buyerTaxId,
        nombre: sale.client_name || 'Consumidor Final',
        correo: sale.client_email || '',
        telefono: sale.client_phone || '',
        direccion: sale.client_address || '',
      },
      document: {
        eNCF: reservation.encf,
        tipoeCF: tipoEcf,
        tipoIngresos: '01',
        tipoPago: String(sale.payment_method || '').toLowerCase() === 'credito' ? '2' : '1',
        fechaVencimientoSecuencia: reservation.sequence?.fecha_vencimiento || null,
      },
      items: preparedItems.map((item) => (
        tipoEcf === 'E47'
          ? {
              ...item,
              billingIndicator: 4,
              retentionIndicator: 1,
              withholdingAmount: 0,
              goodsOrServicesIndicator: 2,
            }
          : item
      )),
      issueDate: sale.created_at || new Date(),
    });

    return {
      emitter,
      sale,
      items,
      preparedItems,
      totals,
      generated,
      reservation,
      tipoEcf,
      buyerTaxId,
    };
  }

  async processSaleForElectronicInvoicing(saleId, context = {}) {
    await this.ensureReady();
    const status = await this.getSystemStatus();
    if (!status.isActive) {
      throw new EcfError('La facturación electrónica está desactivada.', { statusCode: 422 });
    }

    const payload = await this.buildPayloadForSale(saleId, context.requestedType);
    const certificate = await this.resolveCertificate();
    const signedXml = signatureService.signXML(payload.generated.xml, certificate);
    const verification = signatureService.verifySignature(signedXml);
    if (!verification.ok) {
      throw new EcfError('La verificación local de la firma digital falló.', { statusCode: 422, details: verification });
    }

    const codigoSeguridad = computeSecurityCode(signedXml);
    let submissionMode = 'normal';
    if (
      payload.tipoEcf === 'E32' &&
      payload.generated.totals.total < this.config.DGII_RFCE_THRESHOLD_DOP &&
      !this.config.DGII_ALLOW_E32_FULL_RECEPTION
    ) {
      submissionMode = 'rfce';
    }
    await this.repository.updateDocumentPayload(payload.reservation.documentId, {
      nombre_comprador: payload.sale.client_name || 'Consumidor Final',
      rnc_comprador: digitsOnly(payload.buyerTaxId),
      subtotal: payload.generated.totals.subtotal,
      descuento_total: payload.generated.totals.totalDiscount,
      monto_exento: payload.generated.totals.exemptAmount,
      monto_gravado: payload.generated.totals.totalTaxed,
      itbis_total: payload.generated.totals.totalTax,
      monto_total: payload.generated.totals.total,
      codigo_seguridad: codigoSeguridad,
      xml_content: payload.generated.xml,
      signed_xml_content: signedXml,
      submission_mode: submissionMode,
      estado_dgii: 'firmado',
      signed_at: new Date(),
    });

    await this.repository.attachSaleSummary(saleId, {
      encf: payload.reservation.encf,
      tipoEcf: payload.tipoEcf,
      documentId: payload.reservation.documentId,
      estado: 'firmado',
      trackId: null,
      error: null,
    });

    let dgiiResponse;
    let finalDocument = await this.repository.getDocument(payload.reservation.documentId);
    try {
      if (submissionMode === 'rfce') {
        const rfceXml = generateRfceXml({
          emitter: {
            rnc: payload.emitter.rnc,
            razonSocial: payload.emitter.razon_social,
        },
        customer: {
          rnc: payload.buyerTaxId,
          nombre: payload.sale.client_name || 'Consumidor Final',
        },
        document: {
          eNCF: payload.reservation.encf,
          tipoeCF: 'E32',
          tipoIngresos: '01',
          tipoPago: String(payload.sale.payment_method || '').toLowerCase() === 'credito' ? '2' : '1',
          codigoSeguridad,
        },
        totals: payload.generated.totals,
        paymentForms: [
          {
            formaPago: String(payload.sale.payment_method || '').toLowerCase() === 'cash' ? '1' : '8',
            montoPago: payload.generated.totals.total,
          },
        ],
        issueDate: payload.sale.created_at || new Date(),
        });
        const signedRfce = signatureService.signXML(rfceXml, certificate);
        dgiiResponse = await this.fcService.sendConsumptionSummary({
          signedXml: signedRfce,
          filename: `${payload.reservation.encf}-rfce.xml`,
        });
      } else {
        dgiiResponse = await this.receptionService.sendSignedEcf({
          signedXml,
          filename: `${payload.reservation.encf}.xml`,
        });
      }
    } catch (error) {
      if (isDgiiSequenceUsedResponse(error)) {
        const retryResult = await this.retryDocumentAfterSequenceUsed(finalDocument, certificate, {
          ...context,
          response: error.details || { error: error.message },
          saleId,
          branchId: payload.sale.branch_id || null,
          cashRegisterId: payload.sale.cash_register_id || null,
        });
        finalDocument = retryResult.document;
        dgiiResponse = retryResult.response;
      } else {
        await this.repository.markDocumentSent(payload.reservation.documentId, {
          estado_dgii: 'error',
          track_id: null,
          dgii_response_json: { error: error.message },
          error_message: error.message,
        });
        await this.repository.attachSaleSummary(saleId, {
          encf: payload.reservation.encf,
          tipoEcf: payload.tipoEcf,
          documentId: payload.reservation.documentId,
          estado: 'error',
          trackId: null,
          error: error.message,
        });
        throw error;
      }
    }

    if (isDgiiSequenceUsedResponse(dgiiResponse)) {
      const retryResult = await this.retryDocumentAfterSequenceUsed(finalDocument, certificate, {
        ...context,
        response: dgiiResponse,
        saleId,
        branchId: payload.sale.branch_id || null,
        cashRegisterId: payload.sale.cash_register_id || null,
      });
      finalDocument = retryResult.document;
      dgiiResponse = retryResult.response;
    }

    const trackId = dgiiResponse.trackId || dgiiResponse.trackid || dgiiResponse.TrackId || null;
    const state = normalizeDgiiState(dgiiResponse);
    if (state !== 'rechazado' && finalDocument?.sequence_id) {
      await this.repository.advanceSequenceAfterUse(finalDocument.sequence_id, finalDocument.encf);
    }
    await this.repository.markDocumentSent(finalDocument.id, {
      estado_dgii: state,
      track_id: trackId,
      dgii_response_json: dgiiResponse,
      error_message: state === 'rechazado' ? (dgiiResponse.mensaje || dgiiResponse.message || 'DGII rechazó el documento.') : null,
    });
    await this.repository.attachSaleSummary(saleId, {
      encf: finalDocument.encf,
      tipoEcf: finalDocument.tipo_ecf || payload.tipoEcf,
      documentId: finalDocument.id,
      estado: state,
      trackId,
      error: dgiiResponse.mensaje || dgiiResponse.message || null,
    });
    await this.repository.saveAudit({
      userId: context.userId || null,
      userName: context.userName || null,
      userRole: context.userRole || null,
      saleId,
      branchId: payload.sale.branch_id || null,
      cashRegisterId: payload.sale.cash_register_id || null,
      sequenceId: finalDocument.sequence_id || payload.reservation.sequence.id,
      documentId: finalDocument.id,
      tipoComprobante: finalDocument.tipo_ecf || payload.tipoEcf,
      encf: finalDocument.encf,
      actionName: 'document_emitted',
      status: state === 'rechazado' ? 'warning' : 'ok',
      detail: `Documento ${finalDocument.encf} emitido vía ${submissionMode}.`,
      responsePayload: {
        trackId,
        state,
      },
    });

    return {
      ok: state !== 'rechazado',
      documentId: finalDocument.id,
      encf: finalDocument.encf,
      tipoEcf: finalDocument.tipo_ecf || payload.tipoEcf,
      estado: state,
      trackId,
      submissionMode,
      xml: this.config.DEBUG_ECF ? payload.generated.xml : undefined,
      signedXml: this.config.DEBUG_ECF ? signedXml : undefined,
      dgiiResponse: this.config.DEBUG_ECF ? dgiiResponse : undefined,
    };
  }

  async listDocuments(filters = {}) {
    return this.repository.listDocuments(filters);
  }

  async getDocumentXml(id) {
    const document = await this.repository.getDocument(id);
    if (!document) throw new EcfError('Documento e-CF no encontrado.', { statusCode: 404 });
    return document.signed_xml_content || document.xml_content || '';
  }

  async resendDocument(id) {
    const document = await this.repository.getDocument(id);
    if (!document) throw new EcfError('Documento e-CF no encontrado.', { statusCode: 404 });
    const certificate = await this.resolveCertificate();
    const repairedDocument = await this.repairStoredDocumentXml(document, certificate);
    let preparedDocument = this.shouldAdvanceSequenceOnSend(repairedDocument)
      ? await this.advanceDocumentToNextSequence(repairedDocument, certificate)
      : repairedDocument;
    assertCondition(preparedDocument.signed_xml_content, 'El documento no tiene XML firmado para reenviar.', { statusCode: 422 });

    let response;
    try {
      response = await this.sendPreparedDocument(preparedDocument);
    } catch (error) {
      if (!isDgiiSequenceUsedResponse(error)) throw error;
      const retryResult = await this.retryDocumentAfterSequenceUsed(preparedDocument, certificate, {
        response: error.details || { error: error.message },
      });
      preparedDocument = retryResult.document;
      response = retryResult.response;
    }
    if (isDgiiSequenceUsedResponse(response)) {
      const retryResult = await this.retryDocumentAfterSequenceUsed(preparedDocument, certificate, {
        response,
      });
      preparedDocument = retryResult.document;
      response = retryResult.response;
    }
    const trackId = response.trackId || response.trackid || response.TrackId || null;
    const state = normalizeDgiiState(response);
    if (state !== 'rechazado' && preparedDocument.sequence_id) {
      await this.repository.advanceSequenceAfterUse(preparedDocument.sequence_id, preparedDocument.encf);
    }
    await this.repository.markDocumentSent(id, {
      estado_dgii: state,
      track_id: trackId,
      dgii_response_json: response,
      error_message: state === 'rechazado' ? (response.mensaje || response.message || 'DGII rechazó el documento.') : null,
    });
    if (document.sale_id) {
      await this.repository.attachSaleSummary(document.sale_id, {
        encf: preparedDocument.encf,
        tipoEcf: preparedDocument.tipo_ecf,
        documentId: document.id,
        estado: state,
        trackId,
        error: response.mensaje || response.message || null,
      });
    }
    return {
      ok: state !== 'rechazado',
      estado: state,
      mensaje: response.mensaje || response.message || 'Documento reenviado.',
      trackId,
      encf: preparedDocument.encf,
    };
  }

  async queryDocumentStatus(id) {
    const document = await this.repository.getDocument(id);
    if (!document) throw new EcfError('Documento e-CF no encontrado.', { statusCode: 404 });
    if (!document.track_id) {
      return {
        estado: document.estado_dgii,
        mensaje: document.error_message || 'El documento aún no tiene TrackId asignado.',
        trackId: null,
        environment: document.environment,
      };
    }

    const dgii = await this.statusService.getTrackStatus(document.track_id);
    const state = normalizeDgiiState(dgii);

    await this.repository.markDocumentStatus(id, {
      estado_dgii: state,
      dgii_response_json: dgii,
      error_message: dgii.mensaje || dgii.message || null,
    });
    if (document.sale_id) {
      await this.repository.attachSaleSummary(document.sale_id, {
        encf: document.encf,
        tipoEcf: document.tipo_ecf,
        documentId: document.id,
        estado: state,
        trackId: document.track_id,
        error: dgii.mensaje || dgii.message || null,
      });
    }
    return {
      estado: state,
      mensaje: dgii.mensaje || dgii.message || 'Consulta completada.',
      trackId: document.track_id,
      encf: document.encf,
      environment: document.environment,
      autoRetryAvailable: Boolean(isDgiiSequenceUsedResponse(dgii) && document?.sequence_id),
      dgiiResponse: this.config.DEBUG_ECF ? dgii : undefined,
    };
  }

  buildCertificationCasePayload(document, extra = {}) {
    const dgiiResponse = extra.dgiiResponse || null;
    const storedResponse = dgiiResponse || parseJson(document.dgii_response_json, null);
    const mensajes = Array.isArray(storedResponse?.mensajes)
      ? storedResponse.mensajes
      : Array.isArray(storedResponse?.Mensajes) ? storedResponse.Mensajes : [];
    return {
      id: document.id,
      testKey: document.certification_case_key || document.encf,
      tipo: document.tipo_ecf,
      encf: document.encf,
      cliente: document.nombre_comprador || 'Consumidor Final',
      rncReceptor: document.rnc_comprador || '',
      total: Number(document.monto_total || 0),
      tipoPrueba: document.certification_test_type || document.certification_source_name || document.tipo_ecf,
      estado: extra.estado || normalizeDgiiState(dgiiResponse || { estado: document.estado_dgii }),
      trackId: extra.trackId ?? document.track_id ?? null,
      dgiiCode: extra.codigo || getDgiiResponseCode(dgiiResponse || {}) || null,
      dgiiMessage: extra.mensaje || document.error_message || storedResponse?.mensaje || storedResponse?.message || null,
      dgiiFileName: document.certification_dgii_file_name || null,
      xmlPath: document.certification_sent_xml_path || null,
      signedXmlPath: document.certification_signed_xml_path || null,
      responsePath: document.certification_response_path || null,
      suggestedSolution: suggestDgiiSolution(storedResponse || { codigo: extra.codigo, mensaje: extra.mensaje }),
      mensajes,
      environment: document.environment,
    };
  }

  async snapshotCertificationSignedXml(document) {
    if (!String(document?.signed_xml_content || '').trim() || !String(document?.encf || '').trim()) return null;
    const targetPath = path.join(this.certificationSignedDir, `${document.encf}.xml`);
    // Quitar BOM UTF-8 antes de guardar — DGII rechaza XMLs con BOM (código 1)
    const cleanXml = String(document.signed_xml_content || '').replace(/^﻿/, '');
    fs.writeFileSync(targetPath, cleanXml, 'utf8');
    return path.relative(process.cwd(), targetPath).replace(/\\/g, '/');
  }

  async syncCertificationArtifacts(document, overrides = {}) {
    const receptionState = this.receptionStorage.getState();
    const signedXmlPath = await this.snapshotCertificationSignedXml(document);
    await this.repository.updateCertificationTracking(document.id, {
      sentXmlPath: overrides.sentXmlPath
        || receptionState?.latestSent?.xmlPath
        || null,
      signedXmlPath,
      responsePath: overrides.responsePath
        || receptionState?.latestTrackStatus?.statusPath
        || receptionState?.latestTrack?.trackPath
        || null,
      dgiiFileName: overrides.dgiiFileName
        || receptionState?.latestSent?.dgiiFileName
        || null,
    });
  }

  async listCertificationCases(filters = {}) {
    await this.ensureReady();
    const data = await this.repository.listCertificationCases(filters);
    const summary = await this.repository.getCertificationSummary();
    return {
      ...data,
      summary,
      cases: (data.cases || []).map((document) => this.buildCertificationCasePayload(document)),
    };
  }

  async getCertificationSummary() {
    await this.ensureReady();
    return this.repository.getCertificationSummary();
  }

  async importCertificationSet(req) {
    await this.ensureReady();
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    const form = formidable({ multiples: true, maxFileSize: 50 * 1024 * 1024, keepExtensions: true });
    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (error, parsedFields, parsedFiles) => {
        if (error) reject(error);
        else resolve({ fields: parsedFields, files: parsedFiles });
      });
    });

    const flattenedFiles = Object.values(files || {})
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .filter((item) => item?.filepath);
    assertCondition(flattenedFiles.length > 0, 'Debe subir XML, ZIP, TXT, JSON, Excel o una carpeta del set DGII.', { statusCode: 400 });

    const environmentField = Array.isArray(fields.ambiente) ? fields.ambiente[0] : fields.ambiente;
    const environmentFallback = Array.isArray(fields.environment) ? fields.environment[0] : fields.environment;
    const environment = normalizeEnvironmentKey(environmentField || environmentFallback || (await this.repository.getResolvedEmitter(1)).environment);
    const emitter = await this.repository.getResolvedEmitter(1);
    assertCondition(digitsOnly(emitter.rnc), 'Debes guardar el RNC del negocio antes de importar el set DGII.', { statusCode: 422 });

    let certificateContext = null;
    let certificateWarning = null;
    try {
      certificateContext = await this.resolveCertificate();
    } catch (error) {
      certificateWarning = error.message;
      this.logger.warn('Set de certificación importado sin certificado activo.', { error: error.message });
    }

    const result = await importCertificationSet({
      repository: this.repository,
      businessId: 1,
      uploadedFiles: flattenedFiles,
      emitter,
      environment,
      certificateContext,
      userId: actor.id || null,
    });

    await this.repository.saveTestRun(
      'certification_import',
      result.errors > 0 ? 'warning' : 'ok',
      `Certificación DGII importada: ${result.ok}/${result.total} casos listos.`,
      { ...result, certificateWarning },
      environment
    );
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      actionName: 'certification_test_set_imported',
      status: result.errors > 0 ? 'warning' : 'ok',
      detail: `Importó set DGII de certificación: ${result.ok}/${result.total} casos.`,
      responsePayload: { total: result.total, ok: result.ok, errors: result.errors, ignored: result.ignored || [] },
    });

    return {
      ...result,
      message: certificateWarning
        ? `Set importado sin firma digital activa. ${certificateWarning}`
        : `Set importado: ${result.ok}/${result.total} pruebas preparadas.`,
      certificateWarning,
      summary: await this.repository.getCertificationSummary(),
    };
  }

  // Marca los casos ENVIADO/EN_PROCESO como FIRMADO para poder reenviarlos inmediatamente
  // sin esperar que DGII los rechace (útil cuando el portal DGII reinicia las pruebas).
  async resetSentCertificationCases(req) {
    await this.ensureReady();
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    const result = await this.repository.resetSentCertificationCasesToFirmado();
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      documentId: null,
      sequenceId: null,
      tipoComprobante: null,
      encf: null,
      actionName: 'certification_reset_sent',
      status: 'ok',
      detail: `Se reestablecieron ${result.reset} caso(s) enviados a estado "firmado" para reenvío.`,
      responsePayload: result,
    });
    return {
      ok: true,
      message: `${result.reset} caso(s) reestablecido(s) a "firmado". Ahora ejecuta las pruebas secuenciales para reenviar con el XML correcto.`,
      reset: result.reset,
      batchId: result.batchId,
    };
  }

  async resetCertificationData(req) {
    await this.ensureReady();
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    const result = await this.repository.deleteCurrentBatchCertificationCases();
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      documentId: null,
      sequenceId: null,
      tipoComprobante: null,
      encf: null,
      actionName: 'certification_reset',
      status: 'ok',
      detail: `Se eliminaron ${result.deleted} caso(s) de certificación del batch ${result.batchId || '—'}.`,
      responsePayload: result,
    });
    return {
      ok: true,
      message: `Se eliminaron ${result.deleted} caso(s) de certificación. Importa el set nuevamente para empezar de cero.`,
      deleted: result.deleted,
      batchId: result.batchId,
    };
  }

  async sendCertificationCase(documentId, req, options = {}) {
    await this.ensureReady();
    const actor = req ? await this.getCurrentActor(req, { adminOnly: true }) : { id: null, nombre: 'Sistema', usuario: 'Sistema', rol: 'Sistema' };
    const document = await this.repository.getDocument(Number(documentId));
    if (!document || !document.certification_case_key) {
      throw new EcfError('Caso de certificación DGII no encontrado.', { statusCode: 404 });
    }

    const certificate = await this.resolveCertificate();
    const preparedDocument = await this.repairStoredDocumentXml(document, certificate);
    let response;
    try {
      response = await this.sendPreparedDocument(preparedDocument);
    } catch (error) {
      const dgiiResponse = error?.details && typeof error.details === 'object'
        ? error.details
        : { error: error.message };
      const failedState = normalizeDgiiState(dgiiResponse);
      const finalFailedState = failedState === 'pendiente' ? 'error' : failedState;

      await this.repository.markDocumentSent(preparedDocument.id, {
        estado_dgii: finalFailedState,
        track_id: dgiiResponse.trackId || dgiiResponse.trackid || dgiiResponse.TrackId || null,
        dgii_response_json: dgiiResponse,
        error_message: dgiiResponse.error || dgiiResponse.descripcion || dgiiResponse.mensaje || error.message,
      });
      await this.syncCertificationArtifacts(preparedDocument, {
        sentXmlPath: dgiiResponse.xmlPath || dgiiResponse.archivoEnviado || null,
        responsePath: dgiiResponse.trackPath || null,
        dgiiFileName: dgiiResponse.dgiiFileName || null,
      });

      const refreshedFailed = await this.repository.getDocument(preparedDocument.id);
      await this.repository.saveTestRun(
        'certification_case_send',
        'warning',
        `Prueba ${preparedDocument.encf} rechazada por DGII.`,
        {
          documentId: preparedDocument.id,
          encf: preparedDocument.encf,
          dgiiResponse,
        },
        preparedDocument.environment
      );
      await this.repository.saveAudit({
        userId: actor.id,
        userName: actor.nombre || actor.usuario,
        userRole: actor.rol || actor.role_code,
        documentId: preparedDocument.id,
        sequenceId: preparedDocument.sequence_id || null,
        tipoComprobante: preparedDocument.tipo_ecf,
        encf: preparedDocument.encf,
        actionName: 'certification_case_rejected',
        status: 'warning',
        detail: `Prueba de certificación rechazada: ${preparedDocument.encf}.`,
        responsePayload: dgiiResponse,
      });
      return {
        ok: false,
        message: dgiiResponse.error || dgiiResponse.descripcion || dgiiResponse.mensaje || error.message,
        case: this.buildCertificationCasePayload(refreshedFailed || preparedDocument, {
          estado: finalFailedState,
          trackId: dgiiResponse.trackId || dgiiResponse.trackid || dgiiResponse.TrackId || null,
          codigo: getDgiiResponseCode(dgiiResponse),
          mensaje: dgiiResponse.error || dgiiResponse.descripcion || dgiiResponse.mensaje || error.message,
          dgiiResponse,
        }),
        dgiiResponse,
      };
    }

    const sent = await this.finalizeSentDocument(preparedDocument, response, 'Documento de certificación enviado a DGII.');

    // En modo secuencial (skipStatusQuery=true) no consultamos el TrackID inmediatamente
    // para no bloquear el envío de los siguientes casos. El estado queda como 'enviado'
    // y el usuario puede usar "Consultar estados" al finalizar la ráfaga.
    let statusPayload = null;
    if (sent.trackId && !options.skipStatusQuery) {
      statusPayload = await this.queryDocumentStatus(preparedDocument.id);
    }
    const finalCertificationState = String(statusPayload?.estado || sent.estado || '').trim().toLowerCase();

    await this.syncCertificationArtifacts(preparedDocument, {
      sentXmlPath: response.xmlPath || response.archivoEnviado || null,
      responsePath: statusPayload?.archivoEstado || response.trackPath || null,
      dgiiFileName: response.dgiiFileName || null,
    });
    await this.repository.saveTestRun(
      'certification_case_send',
      ['rechazado', 'error'].includes(finalCertificationState) ? 'warning' : 'ok',
      ['rechazado', 'error'].includes(finalCertificationState)
        ? `Prueba ${preparedDocument.encf} rechazada por DGII.`
        : `Prueba ${preparedDocument.encf} enviada a DGII.`,
      {
        documentId: preparedDocument.id,
        encf: preparedDocument.encf,
        trackId: sent.trackId,
        dgiiResponse: response,
        statusPayload,
      },
      preparedDocument.environment
    );
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      documentId: preparedDocument.id,
      sequenceId: preparedDocument.sequence_id || null,
      tipoComprobante: preparedDocument.tipo_ecf,
      encf: preparedDocument.encf,
      actionName: 'certification_case_sent',
      status: ['rechazado', 'error'].includes(finalCertificationState) ? 'warning' : 'ok',
      detail: `Prueba de certificación enviada: ${preparedDocument.encf}.`,
      responsePayload: { sent, statusPayload },
    });

    const refreshed = await this.repository.getDocument(preparedDocument.id);
    const certificationSummary = await this.repository.getCertificationSummary();
    console.log('===== DGII CERTIFICACIÓN =====');
    console.log(`Prueba: ${preparedDocument.certification_order_index || '?'} / ${certificationSummary.total || '?'}`);
    console.log(`Tipo: ${preparedDocument.tipo_ecf || '—'}`);
    console.log(`eNCF: ${preparedDocument.encf || '—'}`);
    console.log(`Archivo: ${this.receptionStorage.getState()?.latestSent?.dgiiFileName || '—'}`);
    console.log(`TrackID: ${sent.trackId || '—'}`);
    console.log(`Estado: ${(finalCertificationState || 'pendiente').toString().toUpperCase()}`);
    console.log('=============================');
    return {
      ok: !['rechazado', 'error'].includes(finalCertificationState),
      message: statusPayload?.mensaje || sent.mensaje,
      case: this.buildCertificationCasePayload(refreshed || preparedDocument, {
        estado: finalCertificationState,
        trackId: sent.trackId,
        codigo: getDgiiResponseCode(statusPayload?.dgiiResponse || response),
        mensaje: statusPayload?.mensaje || sent.mensaje,
        dgiiResponse: statusPayload?.dgiiResponse || response,
      }),
      dgiiResponse: this.config.DEBUG_ECF ? (statusPayload?.dgiiResponse || response) : undefined,
    };
  }

  async queryCertificationCase(documentId) {
    await this.ensureReady();
    const document = await this.repository.getDocument(Number(documentId));
    if (!document || !document.certification_case_key) {
      throw new EcfError('Caso de certificación DGII no encontrado.', { statusCode: 404 });
    }
    const result = await this.queryDocumentStatus(document.id);
    const refreshed = await this.repository.getDocument(document.id);
    await this.syncCertificationArtifacts(refreshed || document, {
      responsePath: result.archivoEstado || null,
    });
    return {
      ...result,
      case: this.buildCertificationCasePayload(refreshed || document, {
        estado: result.estado,
        trackId: result.trackId,
        mensaje: result.mensaje,
        dgiiResponse: result.dgiiResponse,
      }),
      suggestedSolution: suggestDgiiSolution(result.dgiiResponse || { codigo: getDgiiResponseCode(result), mensaje: result.mensaje }),
    };
  }

  async sendNextCertificationCase(req) {
    await this.ensureReady();
    const activeDocument = await this.repository.getActiveCertificationDocument();
    if (activeDocument) {
      const activeStatus = activeDocument.track_id
        ? await this.queryCertificationCase(activeDocument.id)
        : { case: this.buildCertificationCasePayload(activeDocument) };
      const activeState = String(activeStatus?.case?.estado || '').trim().toLowerCase();

      if (['enviado', 'procesando', 'en_proceso'].includes(activeState)) {
        return {
          ok: false,
          blocked: true,
          message: `La prueba ${activeDocument.encf} sigue en proceso en DGII. Consulta su TrackID antes de continuar con la siguiente.`,
          case: activeStatus.case || this.buildCertificationCasePayload(activeDocument, { estado: activeState }),
        };
      }

      if (['rechazado', 'error'].includes(activeState)) {
        return {
          ok: false,
          blocked: true,
          message: `La prueba ${activeDocument.encf} fue rechazada por DGII. Corrige ese caso antes de avanzar al siguiente.`,
          case: activeStatus.case || this.buildCertificationCasePayload(activeDocument, { estado: activeState }),
        };
      }
    }

    const nextDocument = await this.repository.getNextPendingCertificationDocument();
    assertCondition(nextDocument, 'No hay pruebas pendientes de certificación DGII por enviar.', { statusCode: 404 });
    return this.sendCertificationCase(nextDocument.id, req);
  }

  async runCertificationSequence(req) {
    await this.ensureReady();
    await this.getCurrentActor(req, { adminOnly: true });
    // Límite generoso — un set DGII típico tiene 21-30 casos.
    const limit = Math.max(1, Math.min(Number(req.body?.limit || 50), 200));
    // Retardo entre envíos (ms) para no saturar DGII ni expirar el token.
    const delayMs = Math.max(0, Math.min(Number(req.body?.delayMs || 400), 3000));
    const results = [];
    let consecutiveErrors = 0;
    // Guard para no reintentar el mismo documento más de una vez en la misma ráfaga.
    // Si DGII lo rechaza en este pase, queda en 'rechazado' para revisión manual.
    const processedInThisRun = new Set();

    for (let index = 0; index < limit; index += 1) {
      // Obtener el siguiente documento no resuelto del batch.
      // includeRejected=true: reintenta rechazados de corridas ANTERIORES sin reset manual.
      // Los documentos en 'enviado'/'en_proceso'/'aceptado' se saltan automáticamente.
      let nextDocument;
      try {
        nextDocument = await this.repository.getNextPendingCertificationDocument({ includeRejected: true });
      } catch (_) {
        break;
      }
      if (!nextDocument) break; // No quedan pendientes → todos enviados o set vacío.
      if (processedInThisRun.has(nextDocument.id)) break; // Ya procesamos todos los elegibles.
      processedInThisRun.add(nextDocument.id);

      let step;
      try {
        // skipStatusQuery=true: no esperamos respuesta de DGII tras el envío.
        // El documento queda en estado 'enviado' con su TrackID registrado.
        // El usuario puede consultar los estados con "Actualizar estados" al finalizar.
        step = await this.sendCertificationCase(nextDocument.id, req, { skipStatusQuery: true });
        consecutiveErrors = 0;
      } catch (error) {
        consecutiveErrors += 1;
        const isFatal = consecutiveErrors >= 3
          || (error.statusCode != null && error.statusCode >= 500);
        results.push({
          ok: false,
          message: error.message,
          encf: nextDocument.encf,
          fatalStop: isFatal,
        });
        if (isFatal) break; // Error de red / auth grave: detener la ráfaga.
        // Error puntual (firma, XML): registrar y continuar con el siguiente caso.
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      results.push(step);

      // Pausa entre envíos para respetar la tasa de DGII y mantener vivo el token.
      if (index < limit - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    return {
      ok: true,
      totalProcessed: results.length,
      results,
      summary: await this.repository.getCertificationSummary(),
    };
  }

  // Consulta masiva de TrackIDs para todos los casos de certificación que están en
  // estado 'enviado' o 'en_proceso'. Se llama tras la ráfaga de envíos para actualizar
  // los estados sin bloquear el bucle de envío.
  async pollCertificationStatuses() {
    await this.ensureReady();
    const batchId = await this.repository.getLatestCertificationBatchId();
    const params = [];
    let batchClause = '';
    if (batchId) {
      batchClause = ' AND certification_batch_id = ?';
      params.push(batchId);
    }
    const rows = await this.repository.query(
      `SELECT *
       FROM ecf_documents
       WHERE business_id = 1
         AND certification_case_key IS NOT NULL
         ${batchClause}
         AND estado_dgii IN ('enviado', 'en_proceso', 'procesando')
         AND track_id IS NOT NULL
       ORDER BY COALESCE(certification_order_index, id) ASC, id ASC
       LIMIT 60`,
      params
    );

    const results = [];
    for (const document of rows) {
      try {
        const status = await this.queryDocumentStatus(document.id);
        results.push({
          id: document.id,
          encf: document.encf,
          estado: status.estado,
          trackId: status.trackId,
          mensaje: status.mensaje,
        });
        // Pequeña pausa entre consultas para no saturar DGII.
        await new Promise((resolve) => setTimeout(resolve, 250));
      } catch (error) {
        results.push({ id: document.id, encf: document.encf, error: error.message });
      }
    }

    return {
      ok: true,
      polled: results.length,
      results,
      summary: await this.repository.getCertificationSummary(),
    };
  }

  async retryPendingDocuments() {
    const documents = await this.repository.getRetryableDocuments();
    const results = [];
    for (const document of documents) {
      try {
        results.push(await this.resendDocument(document.id));
      } catch (error) {
        results.push({ ok: false, id: document.id, error: error.message });
      }
    }
    return { ok: true, results };
  }

  async testSend(documentId) {
    if (documentId) return this.resendDocument(documentId);
    const latest = await this.repository.getLatestDocument();
    if (!latest) {
      return { ok: false, message: 'Todavía no hay documentos e-CF generados para probar el envío.' };
    }
    return this.resendDocument(latest.id);
  }

  async testTrackId({ documentId, trackId }) {
    if (documentId) return this.queryDocumentStatus(documentId);
    if (trackId) {
      const dgii = await this.statusService.getTrackStatus(trackId);
      return {
        estado: normalizeDgiiState(dgii),
        mensaje: dgii.mensaje || dgii.message || 'Consulta completada.',
        trackId,
        dgiiResponse: this.config.DEBUG_ECF ? dgii : undefined,
      };
    }
    return { ok: false, message: 'Debes indicar un documento o un TrackId para consultar estado.' };
  }

  async importTestSet(req) {
    await this.ensureReady();
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    const form = formidable({ multiples: false, maxFileSize: 15 * 1024 * 1024, keepExtensions: true });
    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (error, parsedFields, parsedFiles) => {
        if (error) reject(error);
        else resolve({ fields: parsedFields, files: parsedFiles });
      });
    });

    const rawFile = files.csv || files.file || files.testset;
    const uploaded = Array.isArray(rawFile) ? rawFile[0] : rawFile;
    assertCondition(uploaded?.filepath, 'Debe subir el archivo oficial del set de homologación DGII.', { statusCode: 400 });

    const environmentField = Array.isArray(fields.ambiente) ? fields.ambiente[0] : fields.ambiente;
    const environmentFallback = Array.isArray(fields.environment) ? fields.environment[0] : fields.environment;
    const environment = normalizeEnvironmentKey(environmentField || environmentFallback || (await this.repository.getResolvedEmitter(1)).environment);
    const emitter = await this.repository.getResolvedEmitter(1);
    assertCondition(digitsOnly(emitter.rnc), 'Debes guardar el RNC del negocio antes de importar el set de homologación.', { statusCode: 422 });

    const fileBuffer = fs.readFileSync(path.resolve(uploaded.filepath));
    let certificateContext = null;
    let certificateWarning = null;
    try {
      certificateContext = await this.resolveCertificate();
    } catch (error) {
      certificateWarning = error.message;
      this.logger.warn('Set de homologación importado sin certificado activo.', {
        error: error.message,
      });
    }

    const result = await importHomologationTestSet({
      repository: this.repository,
      businessId: 1,
      buffer: fileBuffer,
      filename: uploaded.originalFilename || 'set-dgii.csv',
      emitter,
      environment,
      certificateContext,
      userId: actor.id || null,
    });

    await this.repository.saveTestRun(
      'homologation_import',
      result.errors > 0 ? 'warning' : 'ok',
      `Set DGII importado: ${result.ok}/${result.total} casos listos.`,
      {
        ...result,
        certificateWarning,
      },
      environment
    );
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      actionName: 'homologation_test_set_imported',
      status: result.errors > 0 ? 'warning' : 'ok',
      detail: `Importó set DGII: ${result.ok}/${result.total} casos.`,
      responsePayload: {
        total: result.total,
        ok: result.ok,
        errors: result.errors,
        hasCert: result.hasCert,
        certificateWarning,
      },
    });

    return {
      ...result,
      message: certificateWarning
        ? `Set importado sin firma digital activa. ${certificateWarning}`
        : `Set importado: ${result.ok}/${result.total} casos preparados.`,
      certificateWarning,
    };
  }

  async saveManualChecklist(req) {
    await this.getCurrentActor(req, { adminOnly: true });
    const key = String(req.params.key || 'manual_check').trim();
    const status = String(req.body?.status || 'pending').trim();
    const notes = String(req.body?.notes || '').trim() || 'Sin notas';
    await this.repository.saveTestRun(key, status, notes, { notes, savedAt: nowIso() });
    return { ok: true, key, status, notes };
  }

  async resignPendingDocuments(req) {
    await this.getCurrentActor(req, { adminOnly: true });
    const documents = await this.repository.getRetryableDocuments();
    const certificate = await this.resolveCertificate();
    const results = [];
    for (const document of documents) {
      if (!document.xml_content) continue;
      const normalizedXml = normalizeEcfXmlStructure(document.xml_content);
      const signedXml = signatureService.signXML(normalizedXml, certificate);
      const verification = signatureService.verifySignature(signedXml);
      if (!verification.ok) {
        results.push({ ok: false, id: document.id, error: 'La firma regenerada no pasó la verificación local.' });
        continue;
      }
      await this.repository.updateDocumentPayload(document.id, {
        xml_content: normalizedXml,
        signed_xml_content: signedXml,
        codigo_seguridad: computeSecurityCode(signedXml),
        estado_dgii: 'firmado',
        signed_at: new Date(),
      });
      results.push({ ok: true, id: document.id, encf: document.encf, status: 'firmado' });
    }
    return { ok: true, results };
  }

  async getSummaryReport() {
    return this.repository.getSummaryReport();
  }
}

function createEcfService(deps) {
  return new EcfService(deps);
}

module.exports = {
  createEcfService,
};
