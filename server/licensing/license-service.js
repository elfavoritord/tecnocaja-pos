'use strict';

const crypto = require('crypto');
const plans = require('../../modules/plans');
const {
  fetchRemotePosLicenseState,
  getAdminLicensesCollectionName,
  getFirestore,
} = require('../../modules/firebase-admin');
const { getDeviceDescriptor } = require('../security/machine-identity');
const {
  computeIntegrityHash,
  decryptJsonEnvelope,
  encryptJsonEnvelope,
} = require('../security/local-machine-crypto');

const CACHE_ROW_ID = 1;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STATE_CACHE_TTL_MS = 10 * 1000;
const DEFAULT_REMOTE_HEARTBEAT_MS = 15 * 60 * 1000;
// Si Firebase no responde (o responde muy lento) en este tiempo, resolveState
// debe caer al snapshot local en vez de dejar el arranque/login colgado
// esperando una red lenta o caída. syncWithRemote() ya maneja errores duros de
// Firebase (los captura resolveState más abajo); esto cubre el caso de que la
// llamada simplemente tarde mucho sin llegar a fallar.
// getSetupStatus() (que llama resolveState) se ejecuta en CADA /api/login, y
// el frontend le da solo 8s en total a esa llamada (api.js: login() usa
// _timeoutMs: 8000) — con un margen corto aquí, una Firebase lenta ya no se
// come ese presupuesto y hace que el login "parezca offline" sin estarlo.
const REMOTE_SYNC_TIMEOUT_MS = 2500;

function withTimeout(promise, ms, timeoutMessage) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(timeoutMessage || `Tiempo de espera agotado (${ms}ms).`);
      error.code = 'REMOTE_SYNC_TIMEOUT';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function normalizeLicenseStatus(value) {
  const normalized = String(value || 'trial').trim().toLowerCase();
  if (['active', 'activo', 'activo_pro', 'active_pro', 'activepro', 'activo pro'].includes(normalized)) return 'active';
  if (['expired', 'expirado', 'vencido'].includes(normalized)) return 'expired';
  if (['suspended', 'suspendido', 'bloqueado', 'blocked'].includes(normalized)) return 'suspended';
  return 'trial';
}

function asDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value?.toDate === 'function') return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toIsoString(value) {
  const date = asDate(value);
  return date ? date.toISOString() : null;
}

function toSqlDateTime(value) {
  const date = asDate(value);
  if (!date) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function safePositiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function resolveRemoteHeartbeatMs(value) {
  return Math.max(60 * 1000, safePositiveInteger(value, DEFAULT_REMOTE_HEARTBEAT_MS));
}

function signatureBuffer(value) {
  const text = String(value || '').trim();
  if (!text) return Buffer.alloc(0);
  if (/^[a-f0-9]{64}$/i.test(text)) {
    return Buffer.from(text, 'hex');
  }
  return Buffer.from(text, 'base64url');
}

function buildLicenseSignaturePayload(license = {}) {
  return [
    String(license.licenseId || '').trim(),
    String(license.businessName || '').trim(),
    String(license.plan || license.planCode || '').trim().toLowerCase(),
    String(license.status || '').trim().toLowerCase(),
    String(license.issuedAt || '').trim(),
    String(license.expiresAt || '').trim(),
    String(license.deviceId || '').trim(),
    String(safePositiveInteger(license.deviceLimit, 1)),
    String(safePositiveInteger(license.offlineGraceDays, 3)),
  ].join('|');
}

function signLicensePayloadHmac(license = {}, secret) {
  if (!secret) throw new Error('signLicensePayloadHmac requiere un secret.');
  return crypto
    .createHmac('sha256', secret)
    .update(buildLicenseSignaturePayload(license), 'utf8')
    .digest('base64url');
}

function signLicensePayloadHmacHex(license = {}, secret) {
  if (!secret) throw new Error('signLicensePayloadHmacHex requiere un secret.');
  return crypto
    .createHmac('sha256', secret)
    .update(buildLicenseSignaturePayload(license), 'utf8')
    .digest('hex');
}

function normalizePublicKeyPem(value) {
  const pem = String(value || '').trim();
  return pem ? pem.replace(/\\n/g, '\n') : '';
}

function verifyLicenseSignature(license = {}, options = {}) {
  const signature = String(license.signature || '').trim();
  const algorithm = String(
    options.signatureAlg
      || license.signatureAlg
      || process.env.TECNO_CAJA_LICENSE_SIGNATURE_ALG
      || 'hmac-sha256'
  ).trim().toLowerCase();
  const requireSignature = typeof options.requireSignature === 'boolean'
    ? options.requireSignature
    : false;

  if (!signature) {
    return {
      valid: !requireSignature,
      algorithm,
      reason: requireSignature ? 'missing_signature' : 'signature_not_required',
      verificationMode: requireSignature ? 'missing_signature' : 'legacy_unsigned',
    };
  }

  const payload = Buffer.from(buildLicenseSignaturePayload(license), 'utf8');

  try {
    if (algorithm === 'ed25519') {
      const publicKeyPem = normalizePublicKeyPem(options.publicKey || process.env.TECNO_CAJA_LICENSE_PUBLIC_KEY);
      if (!publicKeyPem) {
        return {
          valid: false,
          algorithm,
          reason: 'missing_public_key',
          verificationMode: 'ed25519',
        };
      }
      const valid = crypto.verify(
        null,
        payload,
        crypto.createPublicKey(publicKeyPem),
        signatureBuffer(signature)
      );
      return {
        valid,
        algorithm,
        reason: valid ? null : 'invalid_signature',
        verificationMode: 'ed25519',
      };
    }

    const hmacSecret = String(options.hmacSecret || process.env.TECNO_CAJA_LICENSE_HMAC_SECRET || '').trim();
    if (!hmacSecret) {
      return {
        valid: false,
        algorithm: 'hmac-sha256',
        reason: 'missing_hmac_secret',
        verificationMode: 'hmac-sha256',
      };
    }

    const expected = crypto
      .createHmac('sha256', hmacSecret)
      .update(payload)
      .digest();
    const provided = signatureBuffer(signature);
    const valid = provided.length === expected.length && crypto.timingSafeEqual(expected, provided);
    return {
      valid,
      algorithm: 'hmac-sha256',
      reason: valid ? null : 'invalid_signature',
      verificationMode: 'hmac-sha256',
    };
  } catch (error) {
    return {
      valid: false,
      algorithm,
      reason: error.message || 'signature_verification_failed',
      verificationMode: algorithm,
    };
  }
}

function normalizeRegisteredDevices(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => ({
        deviceId: String(entry?.deviceId || entry?.id || '').trim(),
        hostname: String(entry?.hostname || entry?.name || '').trim(),
        firstSeenAt: toIsoString(entry?.firstSeenAt || entry?.first_seen_at),
        lastSeenAt: toIsoString(entry?.lastSeenAt || entry?.last_seen_at),
      }))
      .filter((entry) => entry.deviceId);
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).map(([deviceId, entry]) => ({
      deviceId: String(deviceId || entry?.deviceId || '').trim(),
      hostname: String(entry?.hostname || entry?.name || '').trim(),
      firstSeenAt: toIsoString(entry?.firstSeenAt || entry?.first_seen_at),
      lastSeenAt: toIsoString(entry?.lastSeenAt || entry?.last_seen_at),
    })).filter((entry) => entry.deviceId);
  }

  return [];
}

function daysBetweenDates(newer, older) {
  const a = asDate(newer);
  const b = asDate(older);
  if (!a || !b) return 0;
  return Math.floor((a.getTime() - b.getTime()) / DAY_MS);
}

function buildBlockedMessage(state = {}) {
  switch (state.blockedCode) {
    case 'tamper':
      return 'Se detectó manipulación local de la licencia o del almacenamiento seguro. La aplicación se bloqueó hasta revalidar con Firebase.';
    case 'clock_rollback':
      return 'Se detectó un retroceso en la fecha del sistema. Corrige el reloj del equipo y vuelve a validar la licencia.';
    case 'offline_grace':
      return 'Se agotó el tiempo offline permitido. Conéctate a internet para revalidar la licencia en Firebase.';
    case 'device_limit':
      return 'Esta licencia excedió el límite de dispositivos autorizados. Debes liberar un equipo o aprobar este dispositivo desde el panel administrador.';
    case 'invalid_signature':
    case 'missing_signature':
      return 'La firma digital de la licencia no es válida. Debes regenerarla desde el backend antes de usar el sistema.';
    case 'missing_remote':
      return 'No se encontró la licencia en Firebase. Verifica el ID de licencia y el panel administrador.';
    case 'suspended':
      return 'La licencia del sistema está suspendida desde tu app de administrador. Comunícate con soporte o reactívala para seguir usando la aplicación.';
    case 'expired':
      return 'La licencia expiró o la prueba terminó. Debes renovarla para seguir usando el sistema.';
    default:
      return 'No se pudo validar la licencia del sistema.';
  }
}

function compareStateFields(a = {}, b = {}) {
  return [
    'status',
    'planCode',
    'planName',
    'licenseId',
    'expiresAt',
    'canEnter',
    'blockedCode',
  ].some((field) => String(a[field] || '') !== String(b[field] || ''));
}

class LicenseService {
  constructor(options = {}) {
    this.query = options.query;
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.fetchRemoteLicense = options.fetchRemoteLicense || this.defaultFetchRemoteLicense.bind(this);
    this.updateRemoteDevice = options.updateRemoteDevice || this.defaultUpdateRemoteDevice.bind(this);
    this.persistRemoteUid = options.persistRemoteUid || (() => {});
    this.logger = options.logger || console;
    this.stateCacheTtlMs = Number(options.stateCacheTtlMs || DEFAULT_STATE_CACHE_TTL_MS);
    this.device = options.device || getDeviceDescriptor();
    this.stateMemo = { at: 0, value: null };
    this.ensureCacheTablePromise = null;
    this.syncPromise = null;
  }

  signatureVerificationConfigured() {
    return Boolean(
      String(process.env.TECNO_CAJA_LICENSE_PUBLIC_KEY || '').trim()
        || String(process.env.TECNO_CAJA_LICENSE_HMAC_SECRET || '').trim()
    );
  }

  isSignatureRequired() {
    const raw = String(process.env.TECNO_CAJA_LICENSE_REQUIRE_SIGNATURE || '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    return this.signatureVerificationConfigured();
  }

  defaultOfflineGraceDays() {
    return safePositiveInteger(process.env.TECNO_CAJA_LICENSE_OFFLINE_GRACE_DAYS, 3);
  }

  async ensureCacheTable() {
    if (!this.ensureCacheTablePromise) {
      this.ensureCacheTablePromise = Promise.resolve().then(async () => {
        await this.query(`
          CREATE TABLE IF NOT EXISTS license_cache (
            id INTEGER PRIMARY KEY,
            cache_blob TEXT NOT NULL,
            integrity_hash VARCHAR(255) NOT NULL,
            license_id VARCHAR(160) DEFAULT NULL,
            status VARCHAR(20) DEFAULT NULL,
            plan_code VARCHAR(20) DEFAULT NULL,
            last_validated_at DATETIME DEFAULT NULL,
            last_seen_at DATETIME DEFAULT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);
      }).catch((error) => {
        this.ensureCacheTablePromise = null;
        throw error;
      });
    }
    return this.ensureCacheTablePromise;
  }

  async loadBusinessContext() {
    const [configRows, adminRows] = await Promise.all([
      this.query(
        `SELECT id, business_name, setup_completed, plan_code, business_structure_mode,
                license_status, trial_started_at, trial_ends_at
         FROM config WHERE id = 1 LIMIT 1`
      ).catch(() => []),
      this.query(
        `SELECT firebase_uid
         FROM users
         WHERE rol IN ('admin','super_admin','administrador')
           AND firebase_uid IS NOT NULL
           AND firebase_uid != ''
         ORDER BY id ASC
         LIMIT 1`
      ).catch(() => []),
    ]);

    const configRow = configRows[0] || {};
    return {
      configRow,
      businessName: String(configRow.business_name || 'Tecno Caja').trim() || 'Tecno Caja',
      setupCompleted: Boolean(configRow.setup_completed),
      principalFirebaseUid: String(adminRows[0]?.firebase_uid || '').trim() || null,
    };
  }

  async defaultFetchRemoteLicense(context = {}) {
    return fetchRemotePosLicenseState({
      business_name: context.businessName,
      principalFirebaseUid: context.principalFirebaseUid,
    });
  }

  normalizeRemoteLicense(remote = {}, context = {}) {
    const raw = remote.docData || remote.rawData || {};
    const licenseId = String(remote.id || raw.licenseId || raw.license_id || '').trim();
    const businessName = String(remote.businessName || raw.businessName || raw.business_name || context.businessName || '').trim() || 'Tecno Caja';
    const planCode = String(remote.planCode || raw.planCode || raw.plan_code || context.configRow?.plan_code || 'basico').trim().toLowerCase() || 'basico';
    const status = normalizeLicenseStatus(
      raw.forceBlocked ? 'suspended' : (remote.status || raw.status || context.configRow?.license_status || 'trial')
    );
    const issuedAt = toIsoString(remote.issuedAt || raw.issuedAt || raw.issued_at || raw.trialStartedAt || remote.trialStartedAt || raw.createdAt || raw.syncedAt || remote.syncedAt);
    const expiresAt = toIsoString(remote.expiresAt || raw.expiresAt || raw.expires_at || raw.trialEndsAt || remote.trialEndsAt);
    const deviceLimit = safePositiveInteger(remote.deviceLimit || raw.deviceLimit || raw.device_limit, 0);
    const offlineGraceDays = safePositiveInteger(remote.offlineGraceDays || raw.offlineGraceDays || raw.offline_grace_days, this.defaultOfflineGraceDays());
    const devices = normalizeRegisteredDevices(remote.devices || raw.devices || raw.deviceRegistry || raw.registeredDevices);
    const deviceSignatureMap = raw.deviceSignatures || raw.device_signatures || {};
    const signature = String(
      deviceSignatureMap?.[this.device.deviceId]
        || remote.signature
        || raw.signature
        || ''
    ).trim();
    const signatureAlg = String(
      remote.signatureAlg
        || raw.signatureAlg
        || raw.signature_alg
        || process.env.TECNO_CAJA_LICENSE_SIGNATURE_ALG
        || 'hmac-sha256'
    ).trim().toLowerCase();

    return {
      licenseId,
      businessKey: String(remote.businessKey || raw.businessKey || '').trim() || null,
      businessName,
      planCode,
      planName: plans.PLAN_NAMES[planCode] || planCode,
      status,
      issuedAt,
      expiresAt,
      deviceId: this.device.deviceId,
      deviceLimit,
      offlineGraceDays,
      signature,
      signatureAlg,
      devices,
      remoteUpdatedAt: toIsoString(remote.updatedAt || raw.updatedAt || raw.lastValidatedAt || raw.last_validation || remote.lastValidatedAt),
      lastValidationAt: toIsoString(remote.lastValidationAt || raw.lastValidatedAt || raw.last_validation || raw.updatedAt || remote.updatedAt),
    };
  }

  buildBootstrapState(context = {}) {
    const planCode = String(context.configRow?.plan_code || 'basico').trim().toLowerCase() || 'basico';
    const now = asDate(this.now()) || new Date();

    // Si el DB ya tiene fechas de trial válidas, usarlas. Si no, asignar 30 días desde hoy.
    let trialEndsAt = asDate(context.configRow?.trial_ends_at);
    let trialStartedAt = asDate(context.configRow?.trial_started_at);
    if (!trialEndsAt || trialEndsAt < now) {
      trialStartedAt = now;
      trialEndsAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    }

    const daysLeft = Math.max(0, Math.ceil((trialEndsAt.getTime() - now.getTime()) / DAY_MS));

    return {
      source: 'bootstrap',
      licenseId: null,
      businessName: context.businessName || 'Tecno Caja',
      status: 'trial',
      planCode,
      planName: plans.PLAN_NAMES[planCode] || 'Tecno Caja Básico',
      deviceId: this.device.deviceId,
      deviceLimit: 0,
      issuedAt: toIsoString(trialStartedAt),
      expiresAt: toIsoString(trialEndsAt),
      trialStartedAt: toIsoString(trialStartedAt),
      trialEndsAt: toIsoString(trialEndsAt),
      lastValidatedAt: null,
      offlineGraceDays: this.defaultOfflineGraceDays(),
      offlineDaysRemaining: this.defaultOfflineGraceDays(),
      daysLeft,
      expired: false,
      suspended: false,
      canEnter: true,
      blockedCode: null,
      message: null,
      clockRollbackDetected: false,
      validationMode: 'bootstrap',
    };
  }

  buildStateFromSnapshot(snapshot = {}, options = {}) {
    const now = asDate(options.now || this.now()) || new Date();
    const license = snapshot.license || {};
    const signatureRequired = this.isSignatureRequired();
    const verification = verifyLicenseSignature(license, {
      requireSignature: signatureRequired,
      publicKey: options.publicKey,
      hmacSecret: options.hmacSecret,
      signatureAlg: license.signatureAlg,
    });

    const issuedAt = asDate(license.issuedAt);
    const expiresAt = asDate(license.expiresAt);
    const lastValidatedAt = asDate(snapshot.lastValidatedAt || license.lastValidationAt);
    const lastSeenSystemAt = asDate(snapshot.lastSeenSystemAt);
    const offlineGraceDays = safePositiveInteger(license.offlineGraceDays, this.defaultOfflineGraceDays());
    const rollbackReference = lastSeenSystemAt && lastValidatedAt
      ? new Date(Math.max(lastSeenSystemAt.getTime(), lastValidatedAt.getTime()))
      : (lastSeenSystemAt || lastValidatedAt);
    const clockRollbackDetected = Boolean(
      rollbackReference && now.getTime() < rollbackReference.getTime() - CLOCK_SKEW_MS
    );
    const offlineDaysSinceLastValidation = lastValidatedAt ? daysBetweenDates(now, lastValidatedAt) : Number.MAX_SAFE_INTEGER;
    const offlineGraceExceeded = options.enforceOfflineGrace !== false
      && lastValidatedAt
      && offlineDaysSinceLastValidation > offlineGraceDays;

    let status = normalizeLicenseStatus(license.status);
    let blockedCode = null;
    let message = null;

    if (verification.valid === false) {
      blockedCode = verification.reason === 'missing_signature' ? 'missing_signature' : 'invalid_signature';
      status = 'expired';
    } else if (clockRollbackDetected) {
      blockedCode = 'clock_rollback';
      status = 'expired';
    } else if (options.deviceLimitExceeded) {
      blockedCode = 'device_limit';
      status = 'expired';
    } else if (status === 'suspended') {
      blockedCode = 'suspended';
    } else if ((status === 'trial' && (!expiresAt || now.getTime() > expiresAt.getTime()))
      || (status === 'active' && expiresAt && now.getTime() > expiresAt.getTime())) {
      blockedCode = 'expired';
      status = 'expired';
    } else if (offlineGraceExceeded) {
      blockedCode = 'offline_grace';
      status = 'expired';
    }

    const canEnter = !blockedCode && (status === 'active' || status === 'trial');
    const daysLeft = expiresAt
      ? Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS))
      : 0;

    if (!canEnter) {
      message = buildBlockedMessage({ blockedCode, status });
    }

    return {
      source: options.source || 'cache',
      licenseId: String(license.licenseId || '').trim() || null,
      businessName: String(license.businessName || '').trim() || null,
      status,
      planCode: String(license.planCode || 'basico').trim().toLowerCase() || 'basico',
      planName: plans.PLAN_NAMES[String(license.planCode || 'basico').trim().toLowerCase() || 'basico'] || 'Tecno Caja Básico',
      deviceId: String(license.deviceId || this.device.deviceId).trim(),
      deviceLimit: safePositiveInteger(license.deviceLimit, 1),
      issuedAt: issuedAt ? issuedAt.toISOString() : null,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      trialStartedAt: issuedAt ? issuedAt.toISOString() : null,
      trialEndsAt: expiresAt ? expiresAt.toISOString() : null,
      planExpiresAt: expiresAt ? expiresAt.toISOString() : null,
      lastValidatedAt: lastValidatedAt ? lastValidatedAt.toISOString() : null,
      offlineGraceDays,
      offlineDaysRemaining: Math.max(0, offlineGraceDays - Math.max(0, offlineDaysSinceLastValidation)),
      offlineDaysSinceLastValidation: Number.isFinite(offlineDaysSinceLastValidation) ? offlineDaysSinceLastValidation : null,
      daysLeft,
      expired: status === 'expired',
      suspended: status === 'suspended',
      canEnter,
      blockedCode,
      message,
      clockRollbackDetected,
      validationMode: verification.verificationMode,
      signatureValid: verification.valid,
      remoteUpdatedAt: toIsoString(snapshot.remoteUpdatedAt || license.remoteUpdatedAt),
    };
  }

  async readCacheSnapshot() {
    await this.ensureCacheTable();
    const rows = await this.query(
      `SELECT cache_blob, integrity_hash
       FROM license_cache
       WHERE id = ?
       LIMIT 1`,
      [CACHE_ROW_ID]
    ).catch(() => []);
    const row = rows[0];
    if (!row?.cache_blob) return null;

    const expectedHash = computeIntegrityHash(row.cache_blob, { purpose: 'license-cache' });
    if (String(expectedHash) !== String(row.integrity_hash || '')) {
      const error = new Error('Se detectó un cambio no autorizado en el caché local de licencia.');
      error.code = 'LICENSE_CACHE_HASH_MISMATCH';
      throw error;
    }

    return decryptJsonEnvelope(row.cache_blob, { purpose: 'license-cache' });
  }

  async writeCacheSnapshot(snapshot) {
    await this.ensureCacheTable();
    const cacheBlob = encryptJsonEnvelope(snapshot, { purpose: 'license-cache' });
    const integrityHash = computeIntegrityHash(cacheBlob, { purpose: 'license-cache' });
    const nowSql = toSqlDateTime(this.now());

    await this.query(
      `INSERT INTO license_cache
         (id, cache_blob, integrity_hash, license_id, status, plan_code, last_validated_at, last_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         cache_blob = excluded.cache_blob,
         integrity_hash = excluded.integrity_hash,
         license_id = excluded.license_id,
         status = excluded.status,
         plan_code = excluded.plan_code,
         last_validated_at = excluded.last_validated_at,
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at`,
      [
        CACHE_ROW_ID,
        cacheBlob,
        integrityHash,
        snapshot.license?.licenseId || null,
        snapshot.license?.status || null,
        snapshot.license?.planCode || null,
        toSqlDateTime(snapshot.lastValidatedAt),
        toSqlDateTime(snapshot.lastSeenSystemAt),
        nowSql,
      ]
    );
  }

  async mirrorStateToConfig(state) {
    const planCode = String(state.planCode || 'basico').trim().toLowerCase() || 'basico';
    const now = asDate(this.now()) || new Date();
    const incomingEndsAt = asDate(state.trialEndsAt);

    let statusToWrite = state.status;
    let trialStartedAt = toSqlDateTime(state.trialStartedAt);
    let trialEndsAt = toSqlDateTime(state.trialEndsAt);

    // Si Firebase devuelve fechas vencidas o nulas, verificar el DB local.
    // Si el local tiene fechas futuras (recién instalado o restaurado de backup), conservarlas.
    // Si el local tampoco tiene fechas (instalación nueva sin setup completo), dar 30 días.
    if (!incomingEndsAt || incomingEndsAt < now) {
      const localRows = await this.query(
        'SELECT trial_started_at, trial_ends_at, license_status, setup_completed FROM config WHERE id = 1 LIMIT 1'
      ).catch(() => []);
      const cfg = localRows[0] || {};
      const localEndsAt = asDate(cfg.trial_ends_at);
      if (localEndsAt && localEndsAt >= now) {
        statusToWrite = String(cfg.license_status || 'trial');
        trialStartedAt = toSqlDateTime(asDate(cfg.trial_started_at));
        trialEndsAt = toSqlDateTime(localEndsAt);
      } else if (statusToWrite === 'expired' || statusToWrite === 'trial') {
        // Instalación nueva (sin fechas locales ni en Firebase): dar 30 días gratis
        const freshStart = now;
        const freshEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        statusToWrite = 'trial';
        trialStartedAt = toSqlDateTime(freshStart);
        trialEndsAt = toSqlDateTime(freshEnd);
      }
    }

    await this.query(
      `UPDATE config
       SET license_status = ?,
           plan_code = ?,
           plan_name = ?,
           business_structure_mode = ?,
           trial_started_at = ?,
           trial_ends_at = ?,
           license_last_remote_check_at = ?
       WHERE id = 1`,
      [
        statusToWrite,
        planCode,
        plans.PLAN_NAMES[planCode] || planCode,
        plans.modeForPlan(planCode),
        trialStartedAt,
        trialEndsAt,
        toSqlDateTime(state.lastValidatedAt || this.now()),
      ]
    ).catch(() => {});

    // Devolver los valores reales que se escribieron, para que el estado que se
    // devuelve al frontend refleje lo que hay en el DB (no los datos de Firebase
    // que pueden ser distintos si se aplicó la protección de 30 días).
    const correctedEndsAt = asDate(trialEndsAt);
    const correctedDaysLeft = correctedEndsAt
      ? Math.max(0, Math.ceil((correctedEndsAt.getTime() - now.getTime()) / DAY_MS))
      : 0;
    return {
      status: statusToWrite,
      trialStartedAt: trialStartedAt ? new Date(trialStartedAt).toISOString() : null,
      trialEndsAt: trialEndsAt ? new Date(trialEndsAt).toISOString() : null,
      daysLeft: correctedDaysLeft,
    };
  }

  async defaultUpdateRemoteDevice(remoteLicense, _context = {}, options = {}) {
    if (!remoteLicense?.licenseId) {
      return { allowed: true, activeCount: 0, limit: 0 };
    }

    const existingDevices = normalizeRegisteredDevices(remoteLicense.devices);
    const currentDevice = existingDevices.find((entry) => entry.deviceId === this.device.deviceId);
    // deviceLimit=0 significa ilimitado. Solo bloquear si el límite es explícito y > 0.
    const limit = safePositiveInteger(remoteLicense.deviceLimit, 0);
    if (!currentDevice && limit > 0 && existingDevices.length >= limit) {
      return { allowed: false, activeCount: existingDevices.length, limit };
    }

    const activeCount = currentDevice ? existingDevices.length : existingDevices.length + 1;
    if (options.allowRemoteWrite === false) {
      return { allowed: true, activeCount, limit, skipped: true, reason: 'read_only_sync' };
    }

    const now = this.now();
    const heartbeatMs = resolveRemoteHeartbeatMs(
      options.remoteHeartbeatMs || process.env.TECNO_CAJA_LICENSE_HEARTBEAT_MS
    );
    const currentDeviceLastSeenAt = asDate(currentDevice?.lastSeenAt || currentDevice?.firstSeenAt);
    if (
      currentDevice
      && currentDeviceLastSeenAt
      && (now.getTime() - currentDeviceLastSeenAt.getTime()) < heartbeatMs
    ) {
      return { allowed: true, activeCount, limit, skipped: true, reason: 'heartbeat_throttled' };
    }

    const firestore = getFirestore();
    const docRef = firestore.collection(getAdminLicensesCollectionName()).doc(remoteLicense.licenseId);
    const payload = {
      lastValidatedAt: now,
      lastValidationDeviceId: this.device.deviceId,
      updatedAt: now,
    };

    payload[`devices.${this.device.deviceId}`] = {
      deviceId: this.device.deviceId,
      hostname: this.device.hostname,
      platform: this.device.platform,
      arch: this.device.arch,
      firstSeenAt: currentDevice?.firstSeenAt ? asDate(currentDevice.firstSeenAt) : now,
      lastSeenAt: now,
      status: 'active',
    };

    await docRef.update(payload).catch(async () => {
      await docRef.set({
        devices: {
          [this.device.deviceId]: payload[`devices.${this.device.deviceId}`],
        },
        lastValidatedAt: now,
        lastValidationDeviceId: this.device.deviceId,
        updatedAt: now,
      }, { merge: true });
    });

    return {
      allowed: true,
      activeCount,
      limit,
    };
  }

  async syncWithRemote(options = {}) {
    if (this.syncPromise) return this.syncPromise;

    this.syncPromise = (async () => {
      const context = await this.loadBusinessContext();
      const remote = await this.fetchRemoteLicense(context);
      if (!remote) {
        const error = new Error('No se encontró la licencia remota en Firebase.');
        error.code = 'LICENSE_REMOTE_NOT_FOUND';
        throw error;
      }

      const previousSnapshot = await this.readCacheSnapshot().catch(() => null);
      const normalizedRemote = this.normalizeRemoteLicense(remote, context);
      if (normalizedRemote.licenseId) {
        this.persistRemoteUid(normalizedRemote.licenseId);
      }

      const registration = await this.updateRemoteDevice(normalizedRemote, context, options);
      if (registration.allowed === false) {
        normalizedRemote.deviceLimitExceeded = true;
      } else if (!normalizedRemote.devices.some((entry) => entry.deviceId === this.device.deviceId)) {
        normalizedRemote.devices = normalizedRemote.devices.concat([{
          deviceId: this.device.deviceId,
          hostname: this.device.hostname,
          firstSeenAt: toIsoString(this.now()),
          lastSeenAt: toIsoString(this.now()),
        }]);
      }

      const nowIso = toIsoString(this.now());
      const snapshot = {
        version: 1,
        cachedAt: nowIso,
        lastValidatedAt: nowIso,
        lastSeenSystemAt: nowIso,
        remoteUpdatedAt: normalizedRemote.remoteUpdatedAt || nowIso,
        license: {
          ...normalizedRemote,
          lastValidationAt: nowIso,
        },
      };

      const state = this.buildStateFromSnapshot(snapshot, {
        source: 'firebase',
        now: this.now(),
        enforceOfflineGrace: false,
        deviceLimitExceeded: Boolean(normalizedRemote.deviceLimitExceeded),
      });

      await this.writeCacheSnapshot(snapshot);
      const mirrored = await this.mirrorStateToConfig(state);
      // Si Firebase devolvió "expired" pero el DB local tiene fechas frescas
      // (protección de 30 días activada en mirrorStateToConfig), parchear el
      // estado para que el frontend muestre los días reales. Solo aplica cuando
      // el único bloqueo es 'expired'; no tocar device_limit, clock_rollback, etc.
      if (mirrored && mirrored.daysLeft > 0 && state.blockedCode === 'expired') {
        state.status        = mirrored.status;
        state.trialEndsAt   = mirrored.trialEndsAt;
        state.expiresAt     = mirrored.trialEndsAt;
        state.planExpiresAt = mirrored.trialEndsAt;
        state.daysLeft      = mirrored.daysLeft;
        state.expired       = false;
        state.canEnter      = true;
        state.blockedCode   = null;
        state.message       = null;
      }

      return {
        synced: true,
        changed: compareStateFields(
          previousSnapshot ? this.buildStateFromSnapshot(previousSnapshot, { source: 'cache', now: this.now() }) : {},
          state
        ),
        source: 'firebase',
        license: state,
        remote: normalizedRemote,
        licenseUid: normalizedRemote.licenseId || null,
      };
    })();

    try {
      return await this.syncPromise;
    } finally {
      this.syncPromise = null;
    }
  }

  async resolveState(options = {}) {
    const nowMs = Date.now();
    if (!options.force && this.stateMemo.value && (nowMs - this.stateMemo.at) < this.stateCacheTtlMs) {
      return this.stateMemo.value;
    }

    const context = await this.loadBusinessContext();
    let result = null;
    let remoteError = null;

    if (options.allowRemote !== false) {
      try {
        result = await withTimeout(
          this.syncWithRemote(options),
          REMOTE_SYNC_TIMEOUT_MS,
          'La verificación de licencia con Firebase tardó demasiado.'
        );
        // En instalación nueva (wizard aún no se ha ejecutado) ignorar una licencia
        // expirada en Firebase: puede ser un doc antiguo del mismo negocio.
        // El wizard se encarga de crear una licencia fresca cuando se complete.
        if (result && !context.setupCompleted && result.license?.canEnter === false) {
          result = null;
        }
      } catch (error) {
        remoteError = error;
      }
    }

    if (!result) {
      try {
        const snapshot = await this.readCacheSnapshot();
        if (snapshot) {
          const state = this.buildStateFromSnapshot(snapshot, {
            source: 'cache',
            now: this.now(),
            enforceOfflineGrace: true,
          });

          if (
            state.canEnter
            && (!snapshot.lastSeenSystemAt || (asDate(this.now()).getTime() - asDate(snapshot.lastSeenSystemAt).getTime()) > CLOCK_SKEW_MS)
          ) {
            snapshot.lastSeenSystemAt = toIsoString(this.now());
            await this.writeCacheSnapshot(snapshot).catch(() => {});
          }

          await this.mirrorStateToConfig(state);
          result = {
            synced: false,
            changed: false,
            source: 'cache',
            usedCache: true,
            reason: remoteError?.message || null,
            license: state,
            licenseUid: state.licenseId || null,
          };
        }
      } catch (cacheError) {
        remoteError = cacheError;
      }
    }

    if (!result) {
      const bootstrapAllowed = !context.setupCompleted;
      const fallbackState = bootstrapAllowed
        ? this.buildBootstrapState(context)
        : {
            ...this.buildBootstrapState(context),
            source: 'blocked',
            status: 'expired',
            canEnter: false,
            expired: true,
            blockedCode: remoteError?.code === 'LICENSE_CACHE_HASH_MISMATCH'
              || remoteError?.code === 'LICENSE_CACHE_TAMPERED'
              || remoteError?.code === 'LICENSE_CACHE_INVALID_FORMAT'
              ? 'tamper'
              : (remoteError?.code === 'LICENSE_REMOTE_NOT_FOUND' ? 'missing_remote' : 'expired'),
          };
      fallbackState.message = fallbackState.canEnter ? null : buildBlockedMessage(fallbackState);
      await this.mirrorStateToConfig(fallbackState).catch(() => {});
      result = {
        synced: false,
        changed: false,
        source: fallbackState.source,
        reason: remoteError?.message || null,
        license: fallbackState,
        licenseUid: fallbackState.licenseId || null,
      };
    }

    this.stateMemo = { at: nowMs, value: result };
    return result;
  }
}

function createLicenseService(options = {}) {
  if (typeof options.query !== 'function') {
    throw new Error('createLicenseService requiere query.');
  }
  return new LicenseService(options);
}

module.exports = {
  buildLicenseSignaturePayload,
  createLicenseService,
  normalizeLicenseStatus,
  signLicensePayloadHmac,
  signLicensePayloadHmacHex,
  verifyLicenseSignature,
};
