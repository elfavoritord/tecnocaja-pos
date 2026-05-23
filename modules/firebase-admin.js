const fs = require('fs');
const path = require('path');

let firebaseIdentity = null;
try {
  firebaseIdentity = require('../server/sync/firebase-identity');
} catch (_e) {
  firebaseIdentity = null;
}

let firebaseAdminLib = null;

try {
  firebaseAdminLib = require('firebase-admin');
} catch (_error) {
  firebaseAdminLib = null;
}

let initializedApp = null;
let initError = null;
let joseLibPromise = null;
let publicCertCache = {
  expiresAt: 0,
  certs: null,
};

function getFirebaseProjectId() {
  return String(process.env.FIREBASE_PROJECT_ID || '').trim();
}

function resolveConfiguredFilePath(candidate) {
  const rawPath = String(candidate || '').trim();
  if (!rawPath) return '';

  const appRoot = String(process.env.TECNO_CAJA_APP_ROOT || process.cwd()).trim() || process.cwd();
  return path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.resolve(appRoot, rawPath);
}

function readServiceAccountFromEnv() {
  const inlineJson = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (inlineJson) {
    return JSON.parse(inlineJson);
  }

  const configuredPath = String(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '').trim();
  if (!configuredPath) return null;

  const absolutePath = resolveConfiguredFilePath(configuredPath);
  if (!fs.existsSync(absolutePath)) {
    return null;
  }
  const raw = fs.readFileSync(absolutePath, 'utf8');
  return JSON.parse(raw);
}

function hasAdminCredentialConfig() {
  const serviceAccountJson = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  const configuredPath = resolveConfiguredFilePath(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '');
  const applicationDefaultPath = resolveConfiguredFilePath(process.env.GOOGLE_APPLICATION_CREDENTIALS || '');

  return Boolean(
    serviceAccountJson ||
      (configuredPath && fs.existsSync(configuredPath)) ||
      (applicationDefaultPath && fs.existsSync(applicationDefaultPath))
  );
}

function canVerifyTokensWithoutAdmin() {
  return Boolean(getFirebaseProjectId());
}

function getFirebaseApp() {
  if (initializedApp) return initializedApp;
  if (initError) throw initError;
  if (!firebaseAdminLib) {
    const error = new Error(
      'firebase-admin no esta instalado. Ejecuta npm install antes de usar la sincronizacion con Firebase.'
    );
    error.statusCode = 500;
    initError = error;
    throw error;
  }

  try {
    if (firebaseAdminLib.apps.length) {
      initializedApp = firebaseAdminLib.app();
      return initializedApp;
    }

    const serviceAccount = readServiceAccountFromEnv();
    if (serviceAccount) {
      initializedApp = firebaseAdminLib.initializeApp({
        credential: firebaseAdminLib.credential.cert(serviceAccount),
      });
      return initializedApp;
    }

    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      initializedApp = firebaseAdminLib.initializeApp({
        credential: firebaseAdminLib.credential.applicationDefault(),
      });
      return initializedApp;
    }

    const error = new Error(
      'Firebase Admin no esta configurado. Define FIREBASE_SERVICE_ACCOUNT_PATH o FIREBASE_SERVICE_ACCOUNT_JSON.'
    );
    error.statusCode = 503;
    initError = error;
    throw error;
  } catch (error) {
    initError = error;
    throw error;
  }
}

function getFirestore() {
  return getFirebaseApp().firestore();
}

function getFirebaseAuth() {
  return getFirebaseApp().auth();
}

function getPosClientsCollectionName() {
  return String(process.env.FIREBASE_POS_CLIENTS_COLLECTION || 'pos_clientes').trim() || 'pos_clientes';
}

function getAdminUsersCollectionName() {
  return String(process.env.FIREBASE_ADMIN_USERS_COLLECTION || 'usuarios').trim() || 'usuarios';
}

function getAdminLicensesCollectionName() {
  return String(process.env.FIREBASE_ADMIN_LICENSES_COLLECTION || 'licencias').trim() || 'licencias';
}

function getPublicCodesCollectionName() {
  return String(process.env.FIREBASE_PUBLIC_CODES_COLLECTION || 'codigos').trim() || 'codigos';
}

// Colección que la app móvil de reportes lee (esquema en inglés con
// displayName / businessIds / branchIds / allowedModules / isActive).
// El POS sigue escribiendo a `usuarios` (es legacy y otras integraciones lo
// usan); esta segunda escritura mantiene los dos esquemas en paralelo.
function getReportsAppUsersCollectionName() {
  return String(process.env.FIREBASE_REPORTS_USERS_COLLECTION || 'users').trim() || 'users';
}

// Detecta si el TECNO_CAJA_LICENSE_UID usa el formato hash legado (pos_XXXXXXXX)
// que debe ser reemplazado por el formato legible pos:tecno-caja-{nombre}.
function isLegacyLicenseUid(uid) {
  return /^pos_[a-f0-9]{8,}$/i.test(uid);
}

// Devuelve el businessId canónico que usa la app de reportes.
// Prioridad: TECNO_CAJA_LICENSE_UID (si es legible) > buildPosBusinessKey(businessName).
// Debe coincidir con getBusinessId() en firebase-reports-sync.js.
function getReportsBusinessId(config = {}) {
  const licenseUid = String(process.env.TECNO_CAJA_LICENSE_UID || '').trim();
  // Si está configurado Y no es el formato hash legado → usarlo directamente
  if (licenseUid && !isLegacyLicenseUid(licenseUid)) return licenseUid;
  // Generar desde el nombre del negocio (legible y único por nombre)
  const businessName = String(config?.nombre || config?.business_name || 'Tecno Caja').trim() || 'Tecno Caja';
  return buildPosBusinessKey(businessName);
}

function getConfiguredPosMobileAccessUrl() {
  return String(
    process.env.POS_PUBLIC_BASE_URL ||
      process.env.MOBILE_POS_PUBLIC_URL ||
      ''
  ).trim().replace(/\/$/, '');
}

function normalizeMobileConnectionCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function buildPosBusinessKey(businessName) {
  const normalized = String(businessName || 'mi-negocio')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Formato: pos:tecno-caja-{nombre}
  // Ejemplo: "Colmado La Fe" → "pos:tecno-caja-colmado-la-fe"
  // Si el nombre ya empieza con "tecno-caja", no duplicar el prefijo
  const key = normalized.startsWith('tecno-caja')
    ? `pos:${normalized}`
    : `pos:tecno-caja-${normalized || 'negocio'}`;
  return key;
}

function normalizeFirebaseIdentityValue(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeLicenseStatus(value) {
  const normalized = String(value || 'trial').trim().toLowerCase();
  if (['active', 'activo', 'activo_pro', 'active_pro', 'activepro', 'activo pro'].includes(normalized)) return 'active';
  if (['expired', 'expirado', 'vencido'].includes(normalized)) return 'expired';
  if (['suspended', 'suspendido', 'bloqueado', 'blocked'].includes(normalized)) return 'suspended';
  return 'trial';
}

function asJsDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value?.toDate === 'function') return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getLicenseCandidateTimestampMs(data = {}) {
  const candidates = [
    data.updatedAt,
    data.syncedAt,
    data.lastValidatedAt,
    data.last_validation,
    data.expiresAt,
    data.expires_at,
    data.trialEndsAt,
    data.issuedAt,
    data.issued_at,
    data.createdAt,
  ];
  for (const candidate of candidates) {
    const parsed = asJsDate(candidate);
    if (parsed) return parsed.getTime();
  }
  return 0;
}

function scoreLicenseCandidate(doc, options = {}) {
  const data = doc?.data?.() || {};
  const preferredUid = String(options.preferredUid || '').trim();
  const docId = String(doc?.id || '').trim();
  const licenseId = String(data.licenseId || data.license_id || '').trim();
  const principalUid = String(data.principalUid || '').trim();
  const status = normalizeLicenseStatus(data.status);
  const planCode = String(data.planCode || data.plan_code || '').trim().toLowerCase();

  let score = 0;
  if (preferredUid) {
    if (docId === preferredUid) score += 1000;
    if (licenseId === preferredUid) score += 900;
    if (principalUid === preferredUid) score += 800;
  }

  if (status === 'active') score += 400;
  else if (status === 'suspended') score += 320;
  else if (status === 'expired') score += 220;
  else score += 100;

  if (String(data.signature || '').trim()) score += 80;
  if (String(data.deviceId || '').trim()) score += 40;
  if (String(data.ownerEmail || data.email || '').trim()) score += 25;
  if (String(data.mobileConnectionCodeNormalized || data.mobileConnectionCode || '').trim()) score += 15;
  if (planCode && planCode !== 'basico') score += 20;
  if (String(data.source || '').trim().toLowerCase() !== 'pos') score += 5;

  return {
    score,
    timestampMs: getLicenseCandidateTimestampMs(data),
  };
}

function chooseBestLicenseDocument(docs = [], options = {}) {
  const normalizedDocs = Array.isArray(docs) ? docs.filter(Boolean) : [];
  if (!normalizedDocs.length) return null;

  return normalizedDocs
    .map((doc) => ({ doc, ...scoreLicenseCandidate(doc, options) }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.timestampMs !== left.timestampMs) return right.timestampMs - left.timestampMs;
      return String(left.doc?.id || '').localeCompare(String(right.doc?.id || ''));
    })[0]?.doc || null;
}

function describeLicenseSelection(doc) {
  const data = doc?.data?.() || {};
  return {
    id: String(doc?.id || '').trim(),
    status: normalizeLicenseStatus(data.status),
    planCode: String(data.planCode || data.plan_code || '').trim().toLowerCase() || null,
    updatedAt: asJsDate(data.updatedAt || data.syncedAt || data.lastValidatedAt || data.issuedAt || data.createdAt)?.toISOString?.() || null,
  };
}

function findLicenseDocByUid(docs = [], licenseUid = '') {
  const normalizedUid = String(licenseUid || '').trim();
  if (!normalizedUid) return null;
  return (Array.isArray(docs) ? docs : []).find((doc) => {
    const data = doc?.data?.() || {};
    return String(doc?.id || '').trim() === normalizedUid
      || String(data.licenseId || data.license_id || '').trim() === normalizedUid
      || String(data.principalUid || '').trim() === normalizedUid;
  }) || null;
}

function shouldPromoteCanonicalLicenseDoc(currentDoc, candidateDoc) {
  if (!candidateDoc) return false;
  if (!currentDoc) return true;
  const current = scoreLicenseCandidate(currentDoc, {});
  const candidate = scoreLicenseCandidate(candidateDoc, {});
  if (candidate.score !== current.score) return candidate.score > current.score;
  return candidate.timestampMs > current.timestampMs;
}

function createFirebaseConflictError(message) {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = 'FIREBASE_IDENTITY_CONFLICT';
  return error;
}

function isSameFirebaseUserRecord(doc, options = {}) {
  const data = doc?.data?.() || {};
  const currentLocalUserId = Number(options.currentLocalUserId || 0) || null;
  const currentFirebaseUid = String(options.currentFirebaseUid || '').trim();
  if (currentLocalUserId && Number(data.localUserId || 0) === currentLocalUserId) {
    return true;
  }
  if (currentFirebaseUid && String(data.firebaseUid || '').trim() === currentFirebaseUid) {
    return true;
  }
  return false;
}

async function assertNoFirebaseIdentityConflicts(options = {}) {
  if (!hasAdminCredentialConfig()) {
    return { checked: false, skipped: true, reason: 'firebase_admin_not_configured' };
  }

  const firestore = getFirestore();
  const usersCollection = firestore.collection(getAdminUsersCollectionName());
  const licensesCollection = firestore.collection(getAdminLicensesCollectionName());
  const businessName = String(options.businessName || '').trim();
  const businessKey = businessName ? buildPosBusinessKey(businessName) : '';
  const username = String(options.username || '').trim();
  const usernameNormalized = normalizeFirebaseIdentityValue(username);
  const email = String(options.email || '').trim().toLowerCase();
  const currentLicenseUid = String(options.currentLicenseUid || '').trim();
  const currentFirebaseUid = String(options.currentFirebaseUid || '').trim();
  const currentLocalUserId = Number(options.currentLocalUserId || 0) || null;

  if (businessKey && options.skipBusinessConflictCheck !== true) {
    // Si TECNO_CAJA_LICENSE_UID está configurado, esa instalación ya tiene su propia
    // licencia — no debe bloquearse aunque otro negocio tenga el mismo nombre comercial.
    // El aislamiento se garantiza por el UID único, no por el nombre del negocio.
    if (!currentLicenseUid) {
      const licenseSnapshot = await licensesCollection.where('businessKey', '==', businessKey).get().catch(() => null);
      const canonicalLicenseDoc = chooseBestLicenseDocument(licenseSnapshot?.docs || [], {
        preferredUid: currentLicenseUid,
      });
      if (canonicalLicenseDoc && !findLicenseDocByUid([canonicalLicenseDoc], currentLicenseUid)) {
        throw createFirebaseConflictError(
          `Ya existe en Firebase un negocio con ese nombre comercial (${businessName}). Usa otro nombre o vincula esta instalación a la licencia existente.`
        );
      }
    }
  }

  if (email) {
    try {
      const authUser = await getFirebaseAuth().getUserByEmail(email);
      if (authUser?.uid && authUser.uid !== currentFirebaseUid) {
        throw createFirebaseConflictError(`El correo ${email} ya está registrado en Firebase para otro usuario.`);
      }
    } catch (error) {
      if (error?.code !== 'auth/user-not-found') throw error;
    }

    const emailSnapshot = await usersCollection.where('emailNormalized', '==', email).get().catch(() => null);
    const conflictingEmailDoc = (emailSnapshot?.docs || []).find((doc) => !isSameFirebaseUserRecord(doc, {
      currentLocalUserId,
      currentFirebaseUid,
    }));
    if (conflictingEmailDoc) {
      throw createFirebaseConflictError(`El correo ${email} ya está vinculado en Firebase a otra cuenta del POS.`);
    }
  }

  if (usernameNormalized && businessKey) {
    const usernameSnapshot = await usersCollection.where('usernameNormalized', '==', usernameNormalized).get().catch(() => null);
    const conflictingUsernameDoc = (usernameSnapshot?.docs || []).find((doc) => {
      const data = doc?.data?.() || {};
      if (String(data.businessKey || '').trim() !== businessKey) return false;
      return !isSameFirebaseUserRecord(doc, {
        currentLocalUserId,
        currentFirebaseUid,
      });
    });
    if (conflictingUsernameDoc) {
      throw createFirebaseConflictError(
        `Ya existe en Firebase un usuario del negocio ${businessName} con el nombre de acceso ${username}.`
      );
    }
  }

  return {
    checked: true,
    businessKey: businessKey || null,
  };
}

async function loadJose() {
  if (!joseLibPromise) {
    joseLibPromise = import('jose');
  }
  return joseLibPromise;
}

function parseCacheControlMaxAge(headerValue) {
  const match = String(headerValue || '').match(/max-age=(\d+)/i);
  return match ? Number(match[1]) : 3600;
}

async function getSecureTokenPublicCerts() {
  const now = Date.now();
  if (publicCertCache.certs && publicCertCache.expiresAt > now) {
    return publicCertCache.certs;
  }

  const response = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
  );
  if (!response.ok) {
    const error = new Error('No se pudieron descargar las llaves públicas de Firebase.');
    error.statusCode = 503;
    throw error;
  }

  const certs = await response.json();
  const maxAge = parseCacheControlMaxAge(response.headers.get('cache-control'));
  publicCertCache = {
    certs,
    expiresAt: now + maxAge * 1000,
  };
  return certs;
}

async function verifyFirebaseIdTokenWithoutAdmin(idToken) {
  const projectId = getFirebaseProjectId();
  if (!projectId) {
    const error = new Error(
      'FIREBASE_PROJECT_ID no esta configurado. No se puede validar el token de Google.'
    );
    error.statusCode = 503;
    throw error;
  }

  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) {
    const error = new Error('El token de Firebase no tiene un formato válido.');
    error.statusCode = 400;
    throw error;
  }

  let header = null;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch (_error) {
    const error = new Error('No se pudo leer la cabecera del token de Firebase.');
    error.statusCode = 400;
    throw error;
  }

  const certs = await getSecureTokenPublicCerts();
  const cert = certs?.[header?.kid];
  if (!cert) {
    const error = new Error('No se encontró la llave pública necesaria para validar el token.');
    error.statusCode = 401;
    throw error;
  }

  const { importX509, jwtVerify } = await loadJose();
  const key = await importX509(cert, 'RS256');
  const issuer = `https://securetoken.google.com/${projectId}`;
  const { payload } = await jwtVerify(idToken, key, {
    issuer,
    audience: projectId,
  });

  return payload;
}

async function verifyFirebaseIdToken(idToken) {
  if (!idToken) {
    const error = new Error('El token de Firebase es requerido.');
    error.statusCode = 400;
    throw error;
  }

  if (hasAdminCredentialConfig()) {
    return getFirebaseApp().auth().verifyIdToken(idToken);
  }

  return verifyFirebaseIdTokenWithoutAdmin(idToken);
}

/**
 * Mapea el rol del POS (texto libre en español) al enum estricto que la app
 * móvil de reportes espera ('admin' | 'branch_admin' | 'supervisor').
 */
function mapPosRoleToReportsRole(rawRole) {
  const r = String(rawRole || '').trim().toLowerCase();
  if (!r) return 'supervisor';
  if (r.includes('administrador') && r.includes('sucursal')) return 'branch_admin';
  if (r === 'branch_admin' || r === 'branch admin') return 'branch_admin';
  if (r.includes('administrador') || r === 'admin') return 'admin';
  if (r === 'supervisor') return 'supervisor';
  return 'supervisor';
}

const DEFAULT_REPORTS_MODULES = Object.freeze([
  'dashboard',
  'sales',
  'cash',
  'inventory',
  'reports',
  'expenses',
  'customers',
  'fiscal',
  'receivables',
  'branches',
  'notifications',
  'settings',
]);

/**
 * Escribe (o actualiza) el documento que la app móvil de reportes consume.
 * Path: users/{firebaseUid}.
 *
 * Requiere `user.firebase_uid` (lo llena `syncPosStaffAuthUser`). Si no está,
 * no escribe nada — devuelve { synced: false, reason }.
 *
 * Hace merge: respeta cambios manuales en branchIds / allowedModules salvo
 * los campos que el POS sí debe controlar (email, displayName, role,
 * isActive, businessId/businessIds).
 */
async function syncStaffToReportsApp(user, config = {}) {
  const firebaseUid = String(user?.firebase_uid || '').trim();
  if (!firebaseUid) {
    return { synced: false, reason: 'missing_firebase_uid' };
  }

  const accountType = String(user?.account_type || 'staff').trim().toLowerCase();
  if (accountType === 'customer') {
    return { synced: false, reason: 'customer_account', skipped: true };
  }

  const businessKey = getReportsBusinessId(config);

  const role = mapPosRoleToReportsRole(user?.rol);
  const estado = String(user?.estado || 'Activo').trim().toLowerCase();
  const isActive = estado === 'activo' || estado === 'active';

  const branchIds = [];
  if (user?.branch_id) branchIds.push(String(user.branch_id));
  if (user?.sucursal_id && !branchIds.includes(String(user.sucursal_id))) {
    branchIds.push(String(user.sucursal_id));
  }

  const allowedModules = role === 'admin' || role === 'branch_admin'
    ? Array.from(DEFAULT_REPORTS_MODULES)
    : ['dashboard', 'reports', 'notifications', 'settings'];

  const firestore = getFirestore();
  const topLevelDocRef = firestore.collection(getReportsAppUsersCollectionName()).doc(firebaseUid);
  const businessDocRef = firestore
    .collection('businesses').doc(businessKey)
    .collection('users').doc(firebaseUid);

  const payload = {
    // Campos que la app reads (UserModel.fromFirestore)
    displayName: String(user?.nombre || user?.usuario || user?.email || 'Usuario POS').trim(),
    email: String(user?.email || '').trim().toLowerCase(),
    role,
    isActive,
    businessId: businessKey,
    businessIds: [businessKey],
    branchIds,
    allowedModules,
    // Campos auxiliares útiles para soporte/diagnóstico
    posRole: String(user?.rol || '').trim() || null,
    posUserId: Number(user?.id) || null,
    source: 'pos',
    syncedAt: new Date(),
    updatedAt: new Date(),
  };

  // createdAt solo se setea si el doc no existe
  const existing = await topLevelDocRef.get().catch(() => null);
  if (!existing || !existing.exists) {
    payload.createdAt = new Date();
  }

  // Escribe en users/{uid} (routing para auth de la app Flutter)
  await topLevelDocRef.set(payload, { merge: true });
  // Escribe también en businesses/{businessId}/users/{uid} (estructura canónica)
  await businessDocRef.set(payload, { merge: true });

  return {
    synced: true,
    uid: firebaseUid,
    collection: getReportsAppUsersCollectionName(),
  };
}

async function syncPosStaffAuthUser(user) {
  const accountType = String(user?.account_type || 'staff').trim().toLowerCase();
  if (accountType === 'customer') {
    return { synced: false, skipped: true, reason: 'customer_account' };
  }

  const email = String(user?.email || '').trim().toLowerCase();
  const password = String(user?.password || '').trim();
  const displayName = String(user?.nombre || user?.usuario || email || 'Usuario POS').trim();
  const estado = String(user?.estado || 'Activo').trim().toLowerCase();
  let firebaseUid = String(user?.firebase_uid || '').trim();

  if (!email) {
    return { synced: false, skipped: true, reason: 'missing_email' };
  }

  const auth = getFirebaseAuth();
  let existingUser = null;

  if (firebaseUid) {
    try {
      existingUser = await auth.getUser(firebaseUid);
    } catch (error) {
      if (error?.code !== 'auth/user-not-found') throw error;
      firebaseUid = '';
    }
  }

  if (!existingUser) {
    try {
      existingUser = await auth.getUserByEmail(email);
      firebaseUid = existingUser.uid;
    } catch (error) {
      if (error?.code !== 'auth/user-not-found') throw error;
    }
  }

  const payload = {
    email,
    displayName,
    disabled: estado !== 'activo',
  };

  if (password && password.length < 6) {
    return {
      synced: false,
      skipped: true,
      reason: 'password_too_short',
    };
  }

  if (password) {
    payload.password = password;
  }

  let authUser = existingUser;
  if (authUser) {
    authUser = await auth.updateUser(firebaseUid, payload);
  } else {
    if (!password) {
      return {
        synced: false,
        skipped: true,
        reason: 'missing_password_for_new_account',
      };
    }
    authUser = await auth.createUser(payload);
    firebaseUid = authUser.uid;
  }

  return {
    synced: true,
    uid: authUser.uid,
    email: authUser.email || email,
    authProvider: 'password',
    disabled: Boolean(authUser.disabled),
  };
}

async function syncPosClientsToFirestore(clients, config) {
  const firestore = getFirestore();
  const collection = firestore.collection(getPosClientsCollectionName());
  const batch = firestore.batch();
  const syncedAt = new Date().toISOString();
  const businessName = String(config?.nombre || 'Tecno Caja').trim() || 'Tecno Caja';

  for (const client of clients) {
    const localId = String(client.id || '').trim();
    if (!localId) continue;
    const docRef = collection.doc(`pos_${localId}`);
    batch.set(
      docRef,
      {
        source: 'pos',
        localClientId: localId,
        businessName,
        systemAssignment: 'pos',
        nombre: client.nombre || '',
        telefono: client.telefono || '',
        email: client.email || '',
        documento: client.cedula || '',
        direccion: client.direccion || '',
        notas: client.reference_note || '',
        locationLink: client.location_link || '',
        latitud: client.latitude === undefined ? null : client.latitude,
        longitud: client.longitude === undefined ? null : client.longitude,
        balance: Number(client.balance || 0),
        limiteCredito: Number(client.limite_credito || 0),
        syncedAt,
      },
      { merge: true }
    );
  }

  await batch.commit();
  return {
    collection: getPosClientsCollectionName(),
    total: clients.length,
    syncedAt,
  };
}

async function deletePosClientFromFirestore(localClientId) {
  const firestore = getFirestore();
  await firestore
    .collection(getPosClientsCollectionName())
    .doc(`pos_${localClientId}`)
    .delete();
}

function normalizePosUserStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'activo' || normalized === 'active') return 'active';
  if (normalized === 'suspendido' || normalized === 'suspended') return 'suspended';
  if (normalized === 'vencido' || normalized === 'expired') return 'expired';
  return 'active';
}

async function syncPosAccountsToFirestore(users, config) {
  const firestore = getFirestore();
  const usersCollection = firestore.collection(getAdminUsersCollectionName());
  const licensesCollection = firestore.collection(getAdminLicensesCollectionName());
  const publicCodesCollection = firestore.collection(getPublicCodesCollectionName());
  const syncedAt = new Date().toISOString();
  const businessName = String(config?.nombre || config?.business_name || 'Tecno Caja').trim() || 'Tecno Caja';
  const businessKey = buildPosBusinessKey(businessName);
  const mobileAccessUrl = getConfiguredPosMobileAccessUrl();
  const mobileConnectionCode = String(config?.mobileConnectionCode || config?.mobile_connection_code || '').trim().toUpperCase();
  const mobileConnectionCodeNormalized = normalizeMobileConnectionCode(mobileConnectionCode);
  const activeUsers = Array.isArray(users)
    ? users.filter((user) => String(user?.account_type || 'staff').trim().toLowerCase() !== 'customer')
    : [];

  if (!activeUsers.length) {
    return {
      usersCollection: getAdminUsersCollectionName(),
      licensesCollection: getAdminLicensesCollectionName(),
      total: 0,
      syncedAt,
    };
  }

  const ownerUser = activeUsers.find((user) => String(user?.rol || '').trim().toLowerCase() === 'administrador') || activeUsers[0];
  const ownerDocId = `pos_user_${ownerUser.id}`;
  const configuredLicenseUid = String(process.env.TECNO_CAJA_LICENSE_UID || '').trim();

  // SEGURIDAD: usar TECNO_CAJA_LICENSE_UID solo si NO es un hash legado (pos_XXXXXXXX).
  // Si es legado, usar el businessKey canónico (pos:tecno-caja-nombre) como licenseDocId.
  // Así evitamos escribir en un doc con ID ilegible y podemos migrar el doc antiguo.
  const configuredIsLegacy = configuredLicenseUid ? isLegacyLicenseUid(configuredLicenseUid) : false;

  let licenseDocId;
  if (configuredLicenseUid && !configuredIsLegacy) {
    // UID configurado y canónico → usarlo directamente
    licenseDocId = configuredLicenseUid;
  } else if (businessKey) {
    // Sin UID canónico configurado (o es hash legado) → usar el businessKey como doc ID
    licenseDocId = businessKey;
  } else {
    // Fallback absoluto (no debería ocurrir)
    const existingLicenseDocs = await licensesCollection
      .where('businessKey', '==', businessKey)
      .where('source', '==', 'pos')
      .get().catch(() => null);
    const ownDoc = findLicenseDocByUid(existingLicenseDocs?.docs || [], ownerDocId)
               || existingLicenseDocs?.docs?.[0]
               || null;
    licenseDocId = ownDoc?.id || ownerDocId;
  }
  const desiredUserIds = new Set(activeUsers.map((user) => `pos_user_${user.id}`));
  const userBatch = firestore.batch();

  for (const user of activeUsers) {
    const docId = `pos_user_${user.id}`;
    const docRef = usersCollection.doc(docId);
    userBatch.set(
      docRef,
      {
        source: 'pos',
        recordKind: 'account',
        systemAssignment: 'pos',
        businessKey,
        businessName,
        mobileAccessUrl: mobileAccessUrl || null,
        mobileAccessConfigured: Boolean(mobileAccessUrl),
        mobileConnectionCode: mobileConnectionCode || null,
        mobileConnectionCodeNormalized: mobileConnectionCodeNormalized || null,
        localUserId: String(user.id),
        usuario: user.usuario || '',
        username: user.usuario || '',
        usernameNormalized: normalizeFirebaseIdentityValue(user.usuario),
        nombreCompleto: user.nombre || user.usuario || '',
        nombreCompletoNormalized: normalizeFirebaseIdentityValue(user.nombre || user.usuario || ''),
        email: user.email || '',
        emailNormalized: normalizeFirebaseIdentityValue(user.email),
        role: user.rol || '',
        status: normalizePosUserStatus(user.estado),
        principalUid: licenseDocId,
        authProvider: user.auth_provider || 'local',
        firebaseUid: user.firebase_uid || null,
        createdAt: new Date(),
        updatedAt: new Date(),
        syncedAt,
      },
      { merge: true }
    );
  }

  const existingUserDocs = await usersCollection.where('source', '==', 'pos').where('businessKey', '==', businessKey).get();
  for (const doc of existingUserDocs.docs) {
    if (!desiredUserIds.has(doc.id)) {
      userBatch.delete(doc.ref);
    }
  }

  const rawStatus = String(config?.licenseStatus || config?.license_status || 'trial').trim().toLowerCase();
  const effectiveStatus = normalizeLicenseStatus(rawStatus);
  const trialStartsAt = config?.trialStartedAt ? new Date(config.trialStartedAt) : (config?.trial_started_at ? new Date(config.trial_started_at) : null);
  const trialEndsAt = config?.trialEndsAt ? new Date(config.trialEndsAt) : (config?.trial_ends_at ? new Date(config.trial_ends_at) : null);
  const localPlanCode = String(config?.planCode || config?.plan_code || '').trim().toLowerCase();
  const localPlanName = String(config?.planName || config?.plan_name || '').trim();
  const localBusinessStructureMode = String(config?.businessStructureMode || config?.business_structure_mode || '').trim().toLowerCase();
  const licenseDocRef = licensesCollection.doc(licenseDocId);

  // Read current Firestore status to avoid overwriting admin-set 'active' or 'suspended'
  const existingLicDoc = await licenseDocRef.get().catch(() => null);
  let remoteStatus = existingLicDoc?.exists ? normalizeLicenseStatus(existingLicDoc.data()?.status) : null;

  // Migración: si el doc canónico no existe aún pero hay un doc hash legado, heredar su status
  if (!remoteStatus && configuredIsLegacy && configuredLicenseUid) {
    const legacyDoc = await licensesCollection.doc(configuredLicenseUid).get().catch(() => null);
    if (legacyDoc?.exists) {
      const legacyStatus = normalizeLicenseStatus(legacyDoc.data()?.status);
      if (legacyStatus === 'active' || legacyStatus === 'suspended') {
        remoteStatus = legacyStatus;
        console.log(`[firebase-admin] Status heredado del doc legado (${configuredLicenseUid}): ${remoteStatus}`);
      }
    }
  }

  const statusToWrite = (remoteStatus === 'active' || remoteStatus === 'suspended') ? remoteStatus : effectiveStatus;

  userBatch.set(
    licenseDocRef,
    {
      source: 'pos',
      systemAssignment: 'pos',
      businessKey,
      businessName,
      mobileAccessUrl: mobileAccessUrl || null,
      mobileAccessConfigured: Boolean(mobileAccessUrl),
      mobileConnectionCode: mobileConnectionCode || null,
      mobileConnectionCodeNormalized: mobileConnectionCodeNormalized || null,
      principalUid: licenseDocId,
      licenseId: licenseDocId,
      status: statusToWrite,
      planCode: localPlanCode || null,
      plan_code: localPlanCode || null,
      planName: localPlanName || null,
      plan_name: localPlanName || null,
      businessStructureMode: localBusinessStructureMode || null,
      business_structure_mode: localBusinessStructureMode || null,
      trialStartedAt: trialStartsAt && !Number.isNaN(trialStartsAt.getTime()) ? trialStartsAt : null,
      trialEndsAt: trialEndsAt && !Number.isNaN(trialEndsAt.getTime()) ? trialEndsAt : null,
      syncedAt,
    },
    { merge: true }
  );

  const existingPosLicenseDocs = await licensesCollection.where('source', '==', 'pos').where('businessKey', '==', businessKey).get();
  for (const doc of existingPosLicenseDocs.docs) {
    if (doc.id !== licenseDocId) {
      userBatch.delete(doc.ref);
    }
  }

  if (mobileConnectionCodeNormalized) {
    const publicCodeDocRef = publicCodesCollection.doc(mobileConnectionCodeNormalized);
    userBatch.set(
      publicCodeDocRef,
      {
        source: 'pos',
        recordKind: 'mobile_code',
        businessKey,
        businessName,
        principalUid: licenseDocId,
        code: mobileConnectionCode || null,
        codeNormalized: mobileConnectionCodeNormalized,
        mobileAccessUrl: mobileAccessUrl || null,
        mobileAccessConfigured: Boolean(mobileAccessUrl),
        status: effectiveStatus,
        syncedAt,
        updatedAt: new Date(),
      },
      { merge: true }
    );

    const existingCodeDocs = await publicCodesCollection
      .where('source', '==', 'pos')
      .where('businessKey', '==', businessKey)
      .get();
    for (const doc of existingCodeDocs.docs) {
      if (doc.id !== mobileConnectionCodeNormalized) {
        userBatch.delete(doc.ref);
      }
    }
  }

  await userBatch.commit();

  // Post-commit: migrar doc de licencia legado → canónico (fire-and-forget)
  if (firebaseIdentity && configuredIsLegacy && configuredLicenseUid && licenseDocId !== configuredLicenseUid) {
    firebaseIdentity.migrateLegacyLicenseDoc(licensesCollection, configuredLicenseUid, licenseDocId)
      .catch((err) => console.warn('[firebase-admin] migrateLegacyLicenseDoc:', err.message));
  }

  // Post-commit: actualizar contador businesses/{businessId}/counters/users (fire-and-forget)
  if (firebaseIdentity) {
    firebaseIdentity.syncUserCounter(firestore, licenseDocId, usersCollection)
      .catch((err) => console.warn('[firebase-admin] syncUserCounter:', err.message));
  }

  return {
    usersCollection: getAdminUsersCollectionName(),
    licensesCollection: getAdminLicensesCollectionName(),
    publicCodesCollection: getPublicCodesCollectionName(),
    total: activeUsers.length,
    ownerDocId,
    licenseDocId,
    syncedAt,
  };
}

async function fetchRemotePosLicenseState(config) {
  const firestore = getFirestore();
  const licensesCollection = firestore.collection(getAdminLicensesCollectionName());
  const businessName = String(config?.nombre || config?.business_name || 'Tecno Caja').trim() || 'Tecno Caja';
  const businessKey = buildPosBusinessKey(businessName);
  const preferredUid = String(process.env.TECNO_CAJA_LICENSE_UID || config?.preferredLicenseUid || '').trim();

  let doc = null;

  // 1. Fetch por TECNO_CAJA_LICENSE_UID (máxima prioridad — configurado en .env)
  // IMPORTANTE: si el documento existe, se usa SIN búsqueda adicional por businessKey.
  // La promoción a "licencia canónica" causaba que el sistema usara la licencia de otro
  // negocio con el mismo nombre, mezclando datos entre cuentas.
  const licenseUid = String(process.env.TECNO_CAJA_LICENSE_UID || '').trim();
  if (licenseUid) {
    try {
      const directDoc = await licensesCollection.doc(licenseUid).get();
      if (directDoc.exists) {
        doc = directDoc;
        console.log('[firebase-admin] Licencia obtenida por TECNO_CAJA_LICENSE_UID:', licenseUid);
        // STOP — TECNO_CAJA_LICENSE_UID es autoritativo, no buscar alternativas.
      }
    } catch (err) {
      console.warn('[firebase-admin] Fetch por TECNO_CAJA_LICENSE_UID falló:', err.message);
    }
  }

  // 2. Fetch por firebase_uid del administrador principal (almacenado en tabla users del POS)
  if (!doc) {
    const principalUid = String(config?.principalFirebaseUid || '').trim();
    if (principalUid) {
      try {
        const directDoc = await licensesCollection.doc(principalUid).get();
        if (directDoc.exists) {
          doc = directDoc;
          console.log('[firebase-admin] Licencia obtenida por firebase_uid del admin:', principalUid, '— agrega TECNO_CAJA_LICENSE_UID=' + principalUid + ' a .env');
        }
      } catch (err) {
        console.warn('[firebase-admin] Fetch por principalFirebaseUid falló:', err.message);
      }
    }
  }

  // 3. Query por businessKey (sin filtro de source — funciona aunque el doc lo creó el admin app)
  if (!doc) {
    try {
      const snapshot = await licensesCollection
        .where('businessKey', '==', businessKey)
        .get();
      if (!snapshot.empty) {
        doc = chooseBestLicenseDocument(snapshot.docs, { preferredUid });
        if (snapshot.docs.length > 1 && doc) {
          console.warn('[firebase-admin] Varias licencias para businessKey:', businessKey, '— usando', describeLicenseSelection(doc));
        }
      }
    } catch (err) {
      console.warn('[firebase-admin] Query por businessKey falló:', err.message);
    }
  }

  // 4. Fallback: query por businessName
  if (!doc) {
    try {
      const snapshot = await licensesCollection
        .where('businessName', '==', businessName)
        .get();
      if (!snapshot.empty) {
        doc = chooseBestLicenseDocument(snapshot.docs, { preferredUid });
        if (snapshot.docs.length > 1 && doc) {
          console.warn('[firebase-admin] Varias licencias para businessName:', businessName, '— usando', describeLicenseSelection(doc));
        }
      }
    } catch (err) {
      console.warn('[firebase-admin] Query por businessName falló:', err.message);
    }
  }

  if (!doc) {
    console.warn('[firebase-admin] No se encontró documento de licencia para businessKey:', businessKey, '— configura TECNO_CAJA_LICENSE_UID en .env');
    return null;
  }

  const data = doc.data() || {};
  const remotePlanCode = String(data.planCode || data.plan_code || '').trim().toLowerCase();
  return {
    id: doc.id,
    businessKey,
    businessName,
    principalUid: String(data.principalUid || doc.id).trim() || doc.id,
    status: normalizeLicenseStatus(data.status),
    planCode: remotePlanCode || null,
    licenseId: String(data.licenseId || data.license_id || doc.id).trim() || doc.id,
    businessNameRemote: String(data.businessName || data.business_name || businessName).trim() || businessName,
    issuedAt: asJsDate(data.issuedAt || data.issued_at || data.trialStartedAt || data.createdAt || data.syncedAt),
    expiresAt: asJsDate(data.expiresAt || data.expires_at || data.trialEndsAt),
    deviceLimit: Number(data.deviceLimit || data.device_limit || 1) || 1,
    offlineGraceDays: Number(data.offlineGraceDays || data.offline_grace_days || 3) || 3,
    signature: String(data.signature || '').trim() || null,
    signatureAlg: String(data.signatureAlg || data.signature_alg || '').trim().toLowerCase() || null,
    devices: data.devices || data.deviceRegistry || data.registeredDevices || {},
    lastValidationAt: asJsDate(data.lastValidatedAt || data.last_validation || data.updatedAt || data.syncedAt),
    trialStartedAt: asJsDate(data.trialStartedAt),
    trialEndsAt: asJsDate(data.trialEndsAt),
    syncedAt: asJsDate(data.syncedAt),
    updatedAt: asJsDate(data.updatedAt),
    docData: data,
  };
}

async function deleteDocRefs(refs = [], result = {}, bucket = 'deleted') {
  const uniqueRefs = Array.from(new Map(
    (Array.isArray(refs) ? refs : [])
      .filter(Boolean)
      .map((ref) => [`${ref.path || `${ref.parent?.id || ''}/${ref.id || ''}`}`, ref])
  ).values());

  for (const ref of uniqueRefs) {
    await ref.delete().catch(() => {});
    result[bucket] = Number(result[bucket] || 0) + 1;
  }
}

async function collectDocRefsFromQuery(queryRef) {
  if (!queryRef || typeof queryRef.get !== 'function') return [];
  const snapshot = await queryRef.get().catch(() => null);
  return snapshot?.docs?.map((doc) => doc.ref).filter(Boolean) || [];
}

async function deleteCollectionRecursive(collectionRef, result = {}) {
  if (!collectionRef || typeof collectionRef.get !== 'function') return;
  const snapshot = await collectionRef.get().catch(() => null);
  for (const doc of snapshot?.docs || []) {
    const subcollections = typeof doc.ref?.listCollections === 'function'
      ? await doc.ref.listCollections().catch(() => [])
      : [];
    for (const subcollection of subcollections || []) {
      await deleteCollectionRecursive(subcollection, result);
    }
    await doc.ref.delete().catch(() => {});
    result.deleted = Number(result.deleted || 0) + 1;
  }
}

async function purgePosBusinessFromFirebase(options = {}) {
  if (!hasAdminCredentialConfig()) {
    const error = new Error('Firebase Admin no está configurado para borrar datos remotos.');
    error.statusCode = 503;
    throw error;
  }

  const firestore = getFirestore();
  const auth = getFirebaseAuth();
  const result = {
    businessKey: null,
    businessId: null,
    deleted: 0,
    authDeleted: 0,
    skippedLegacyNegocio: false,
  };

  const businessName = String(options.businessName || '').trim() || 'Tecno Caja';
  const businessKey = String(options.businessKey || buildPosBusinessKey(businessName)).trim() || buildPosBusinessKey(businessName);
  const businessId = String(options.businessId || options.licenseUid || process.env.TECNO_CAJA_LICENSE_UID || businessKey).trim() || businessKey;
  const licenseUid = String(options.licenseUid || process.env.TECNO_CAJA_LICENSE_UID || '').trim();
  const authUids = new Set((Array.isArray(options.authUids) ? options.authUids : []).map((uid) => String(uid || '').trim()).filter(Boolean));
  result.businessKey = businessKey;
  result.businessId = businessId;

  const licenseRefs = [];
  if (licenseUid) {
    licenseRefs.push(firestore.collection(getAdminLicensesCollectionName()).doc(licenseUid));
  }
  licenseRefs.push(...await collectDocRefsFromQuery(
    firestore.collection(getAdminLicensesCollectionName()).where('businessKey', '==', businessKey)
  ));
  licenseRefs.push(...await collectDocRefsFromQuery(
    firestore.collection(getAdminLicensesCollectionName()).where('businessName', '==', businessName)
  ));
  await deleteDocRefs(licenseRefs, result);

  const userRefs = await collectDocRefsFromQuery(
    firestore.collection(getAdminUsersCollectionName()).where('businessKey', '==', businessKey)
  );
  for (const ref of userRefs) {
    const snapshot = await ref.get().catch(() => null);
    const data = snapshot?.data?.() || {};
    if (String(data.firebaseUid || '').trim()) {
      authUids.add(String(data.firebaseUid).trim());
    }
  }
  await deleteDocRefs(userRefs, result);

  const publicCodeRefs = await collectDocRefsFromQuery(
    firestore.collection(getPublicCodesCollectionName()).where('businessKey', '==', businessKey)
  );
  await deleteDocRefs(publicCodeRefs, result);

  const clientRefsByName = await collectDocRefsFromQuery(
    firestore.collection(getPosClientsCollectionName()).where('businessName', '==', businessName)
  );
  await deleteDocRefs(clientRefsByName, result);

  const reportsUsersCollection = firestore.collection(getReportsAppUsersCollectionName());
  const reportsUserRefs = [];
  reportsUserRefs.push(...await collectDocRefsFromQuery(reportsUsersCollection.where('businessId', '==', businessId)));
  reportsUserRefs.push(...await collectDocRefsFromQuery(reportsUsersCollection.where('businessIds', 'array-contains', businessId)));
  for (const ref of reportsUserRefs) {
    const snapshot = await ref.get().catch(() => null);
    if (snapshot?.id) authUids.add(String(snapshot.id).trim());
  }
  await deleteDocRefs(reportsUserRefs, result);

  const businessDocRef = firestore.collection('businesses').doc(businessId);
  const businessSubcollections = typeof businessDocRef.listCollections === 'function'
    ? await businessDocRef.listCollections().catch(() => [])
    : [];
  for (const subcollection of businessSubcollections || []) {
    await deleteCollectionRecursive(subcollection, result);
  }
  await businessDocRef.delete().catch(() => {});

  const legacyNegocioId = String(process.env.TECNO_CAJA_BUSINESS_ID || '').trim();
  if (legacyNegocioId) {
    const legacyDocRef = firestore.collection('negocios').doc(legacyNegocioId);
    const legacySubcollections = typeof legacyDocRef.listCollections === 'function'
      ? await legacyDocRef.listCollections().catch(() => [])
      : [];
    for (const subcollection of legacySubcollections || []) {
      await deleteCollectionRecursive(subcollection, result);
    }
    await legacyDocRef.delete().catch(() => {});
  } else {
    result.skippedLegacyNegocio = true;
  }

  for (const uid of authUids) {
    await auth.deleteUser(uid).catch((error) => {
      if (error?.code !== 'auth/user-not-found') throw error;
    });
    result.authDeleted += 1;
  }

  return result;
}

function getFirebaseConfigStatus() {
  const authEnabled = canVerifyTokensWithoutAdmin();
  const adminEnabled = hasAdminCredentialConfig();
  const status = {
    enabled: authEnabled,
    adminEnabled,
    collection: getPosClientsCollectionName(),
  };

  if (!authEnabled) {
    status.reason =
      'FIREBASE_PROJECT_ID no esta configurado. No se puede validar Google.';
    return status;
  }

  if (!adminEnabled) {
    status.reason =
      'Firebase Auth ya puede validar Google, pero Firestore sync sigue requiriendo FIREBASE_SERVICE_ACCOUNT_PATH o FIREBASE_SERVICE_ACCOUNT_JSON.';
    status.adminReason =
      'Firebase Admin no esta configurado para escribir en Firestore.';
    if (String(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '').trim()) {
      status.adminReason =
        'La ruta FIREBASE_SERVICE_ACCOUNT_PATH no existe en esta PC o Firebase Admin no esta configurado para escribir en Firestore.';
    }
  }

  return status;
}

module.exports = {
  assertNoFirebaseIdentityConflicts,
  buildPosBusinessKey,
  chooseBestLicenseDocument,
  deletePosClientFromFirestore,
  describeLicenseSelection,
  fetchRemotePosLicenseState,
  getAdminLicensesCollectionName,
  getAdminUsersCollectionName,
  getFirebaseConfigStatus,
  getFirestore,
  getPosClientsCollectionName,
  getPublicCodesCollectionName,
  getReportsBusinessId,
  purgePosBusinessFromFirebase,
  syncPosStaffAuthUser,
  syncPosAccountsToFirestore,
  syncPosClientsToFirestore,
  syncStaffToReportsApp,
  getReportsAppUsersCollectionName,
  verifyFirebaseIdToken,
};
