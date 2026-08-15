'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const CERTIFICATION_STEPS = [
  [1, 'registrado', 'Registrado', 'manual'],
  [2, 'datos_ecf', 'Pruebas de Datos e-CF', 'engine'],
  [3, 'datos_acecf', 'Pruebas Datos Aprobación Comercial', 'engine'],
  [4, 'sim_ecf', 'Pruebas Simulación e-CF', 'engine'],
  [5, 'sim_repr', 'Simulación Representación Impresa', 'engine'],
  [6, 'val_repr', 'Validación Representación Impresa', 'manual'],
  [7, 'url_prueba', 'URL Servicios Prueba', 'urls'],
  [8, 'inicio_recv_ecf', 'Inicio Prueba Recepción e-CF', 'manual'],
  [9, 'recv_ecf', 'Recepción e-CF', 'gateway_received'],
  [10, 'inicio_acecf', 'Inicio Prueba Recepción ACECF', 'manual'],
  [11, 'recv_acecf', 'Recepción Aprobación Comercial', 'gateway_approval'],
  [12, 'url_prod', 'URL Servicios Producción', 'urls'],
  [13, 'decl_jurada', 'Declaración Jurada', 'manual'],
  [14, 'verif_estatus', 'Verificación Estatus', 'manual'],
  [15, 'finalizado', 'Finalizado', 'manual'],
].map(([id, key, label, verification]) => ({ id, key, label, verification }));

const MANUAL_STEPS = new Set([1, 6, 8, 10, 13, 14, 15]);
const URL_STEPS = new Set([7, 12]);
const PORTAL_URL = 'https://ecf.dgii.gov.do/certecf/portalcertificacion';
const RECOMMENDED_SERVICE_BASE_URL = process.env.ECF_GATEWAY_BASE_URL ||
  'https://tecno-caja-ecf-gateway-1052855422372.us-east1.run.app';

async function callerContext(request, { adminOnly = false } = {}) {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');
  const db = admin.firestore();
  const businessId = String(request.data?.businessId || '').trim();
  if (!businessId) throw new HttpsError('invalid-argument', 'Falta businessId.');

  const profileSnap = await db.collection('users').doc(uid).get();
  const profile = profileSnap.exists ? profileSnap.data() : null;
  const businessIds = profile?.businessIds || (profile?.businessId ? [profile.businessId] : []);
  if (!profile || !businessIds.includes(businessId)) {
    throw new HttpsError('permission-denied', 'No perteneces a esta empresa.');
  }
  const role = String(profile.role || '');
  const isAdmin = [
    'superadmin', 'businessOwner', 'admin', 'administrador',
    'Administrador', 'Administrador General',
  ].includes(role);
  if (adminOnly && !isAdmin) {
    throw new HttpsError('permission-denied', 'Solo un administrador puede gestionar la certificación e-CF.');
  }
  return { db, uid, businessId, profile, isAdmin };
}

function processRef(db, businessId) {
  return db.collection('businesses').doc(businessId)
    .collection('fiscalCertification').doc('current');
}

function initialSteps() {
  return Object.fromEntries(CERTIFICATION_STEPS.map((step) => [String(step.id), {
    id: step.id,
    key: step.key,
    label: step.label,
    verification: step.verification,
    status: 'pending',
  }]));
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function serializeValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value.toDate === 'function') return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeValue(item)]));
  }
  return value;
}

function publicProcess(data) {
  if (!data) return null;
  return serializeValue({
    status: data.status,
    environment: data.environment,
    rnc: data.rnc,
    razonSocial: data.razonSocial,
    startedAt: data.startedAt,
    updatedAt: data.updatedAt,
    finishedAt: data.finishedAt,
    progress: Number(data.progress || 0),
    currentStep: Number(data.currentStep || 1),
    certificate: data.certificate || { status: 'not_configured' },
    serviceUrls: data.serviceUrls || {},
    steps: data.steps || initialSteps(),
    portalUrl: PORTAL_URL,
    recommendedServiceBaseUrl: RECOMMENDED_SERVICE_BASE_URL,
  });
}

function completedStepIds(process) {
  return CERTIFICATION_STEPS
    .filter((step) => process.steps?.[String(step.id)]?.status === 'completed')
    .map((step) => step.id);
}

function recalculate(process) {
  const completed = completedStepIds(process);
  const next = CERTIFICATION_STEPS.find((step) => !completed.includes(step.id));
  return {
    progress: Math.round((completed.length / CERTIFICATION_STEPS.length) * 100),
    currentStep: next?.id || 15,
    status: completed.length === CERTIFICATION_STEPS.length ? 'completed' : 'in_progress',
  };
}

function assertPreviousSteps(process, stepId) {
  const pending = CERTIFICATION_STEPS
    .filter((step) => step.id < stepId && process.steps?.[String(step.id)]?.status !== 'completed')
    .map((step) => step.id);
  if (pending.length) {
    throw new HttpsError('failed-precondition', `Antes debes completar los pasos: ${pending.join(', ')}.`);
  }
}

async function audit(db, businessId, uid, action, details = {}) {
  await db.collection('businesses').doc(businessId).collection('auditLogs').add({
    action,
    module: 'ecf_certification',
    actorUid: uid,
    details,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

const startEcfCertification = onCall({ cors: true }, async (request) => {
  const { db, uid, businessId } = await callerContext(request, { adminOnly: true });
  const ref = processRef(db, businessId);
  const existing = await ref.get();
  if (existing.exists && request.data?.restart !== true) {
    return { process: publicProcess(existing.data()), reused: true };
  }

  const businessSnap = await db.collection('businesses').doc(businessId).get();
  if (!businessSnap.exists) throw new HttpsError('not-found', 'La empresa no existe.');
  const business = businessSnap.data();
  const rnc = digitsOnly(business.rncCedula || business.rnc || request.data?.rnc);
  if (![9, 11].includes(rnc.length)) {
    throw new HttpsError('failed-precondition', 'Configura el RNC o cédula fiscal de la empresa antes de iniciar.');
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const process = {
    version: 1,
    status: 'in_progress',
    environment: 'certecf',
    rnc,
    razonSocial: business.razonSocial || business.nombreComercial || business.nombre || '',
    progress: 0,
    currentStep: 1,
    steps: initialSteps(),
    certificate: { status: 'not_configured' },
    serviceUrls: {},
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    startedBy: uid,
  };
  await ref.set(process);
  await audit(db, businessId, uid, existing.exists ? 'certification_restarted' : 'certification_started');
  const saved = await ref.get();
  return { process: publicProcess(saved.data()), reused: false };
});

async function refreshGatewayEvidence(db, businessId, process) {
  const startedAt = process.startedAt?.toDate?.() || new Date(0);
  const rnc = digitsOnly(process.rnc);
  if (!rnc) return process;

  const [receivedSnap, approvalsSnap] = await Promise.all([
    db.collection('ecf_gateway_received').where('rncEmisor', '==', rnc).limit(20).get(),
    db.collection('ecf_gateway_approvals').where('rncEmisor', '==', rnc).limit(20).get(),
  ]);
  const afterStart = (doc) => {
    const value = doc.data()?.receivedAt;
    const date = value?.toDate?.() || new Date(value || 0);
    return !Number.isNaN(date.getTime()) && date >= startedAt;
  };
  const received = receivedSnap.docs.filter(afterStart);
  const approvals = approvalsSnap.docs.filter(afterStart);
  const updates = {};
  const steps = { ...process.steps };
  if (received.length && steps['9']?.status !== 'completed') {
    steps['9'] = { ...steps['9'], status: 'completed', completedAt: new Date(), evidence: { received: received.length } };
    updates.steps = steps;
  }
  if (approvals.length && steps['11']?.status !== 'completed') {
    steps['11'] = { ...steps['11'], status: 'completed', completedAt: new Date(), evidence: { received: approvals.length } };
    updates.steps = steps;
  }
  if (!Object.keys(updates).length) return process;

  const next = recalculate({ ...process, steps });
  await processRef(db, businessId).set({ ...updates, ...next, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  return { ...process, ...updates, ...next };
}

const getEcfCertificationStatus = onCall({ cors: true }, async (request) => {
  const { db, businessId } = await callerContext(request);
  const snap = await processRef(db, businessId).get();
  if (!snap.exists) return {
    process: null,
    portalUrl: PORTAL_URL,
    recommendedServiceBaseUrl: RECOMMENDED_SERVICE_BASE_URL,
  };
  const refreshed = await refreshGatewayEvidence(db, businessId, snap.data());
  return { process: publicProcess(refreshed), portalUrl: PORTAL_URL };
});

const confirmEcfCertificationStep = onCall({ cors: true }, async (request) => {
  const { db, uid, businessId } = await callerContext(request, { adminOnly: true });
  const stepId = Number(request.data?.stepId);
  const reference = String(request.data?.reference || '').trim();
  if (!MANUAL_STEPS.has(stepId)) {
    throw new HttpsError('invalid-argument', 'Este paso debe verificarse automáticamente por el motor fiscal o el gateway.');
  }
  if (reference.length < 3 || reference.length > 500) {
    throw new HttpsError('invalid-argument', 'Indica la referencia o evidencia mostrada por el portal DGII.');
  }

  const ref = processRef(db, businessId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('failed-precondition', 'Primero inicia la certificación.');
  const process = snap.data();
  assertPreviousSteps(process, stepId);
  if (stepId === 1 && process.certificate?.status !== 'valid') {
    throw new HttpsError('failed-precondition', 'Carga y valida el certificado digital antes de confirmar la postulación.');
  }
  const steps = { ...process.steps };
  steps[String(stepId)] = {
    ...steps[String(stepId)],
    status: 'completed',
    completedAt: new Date(),
    completedBy: uid,
    evidence: { source: 'dgii_portal', reference },
  };
  const next = recalculate({ ...process, steps });
  const changes = {
    steps,
    ...next,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...(next.status === 'completed' ? { finishedAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
  };
  await ref.set(changes, { merge: true });

  if (next.status === 'completed') {
    await db.collection('businesses').doc(businessId).collection('settings').doc('fiscal').set({
      eCfValidado: true,
      eCfActivo: false,
      ambiente: 'certificacion',
      certificationCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
      certificationCompletedBy: uid,
    }, { merge: true });
  }
  await audit(db, businessId, uid, 'certification_step_confirmed', { stepId, reference });
  const saved = await ref.get();
  return { process: publicProcess(saved.data()) };
});

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

async function checkServiceUrl(url) {
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(12000) });
    return { url, ok: response.ok, status: response.status };
  } catch (error) {
    return { url, ok: false, error: error?.name === 'TimeoutError' ? 'timeout' : 'unavailable' };
  }
}

const validateEcfServiceUrls = onCall({ cors: true, timeoutSeconds: 60 }, async (request) => {
  const { db, uid, businessId } = await callerContext(request, { adminOnly: true });
  const stepId = Number(request.data?.stepId);
  const baseUrl = normalizeBaseUrl(request.data?.baseUrl);
  if (!URL_STEPS.has(stepId) || !baseUrl.startsWith('https://')) {
    throw new HttpsError('invalid-argument', 'Indica el paso 7 o 12 y una URL base HTTPS válida.');
  }
  const ref = processRef(db, businessId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('failed-precondition', 'Primero inicia la certificación.');
  const process = snap.data();
  assertPreviousSteps(process, stepId);

  const paths = [
    '/fe/autenticacion/api/semilla',
    '/fe/recepcion/api/ecf',
    '/fe/aprobacioncomercial/api/ecf',
  ];
  const checks = await Promise.all(paths.map((item) => checkServiceUrl(`${baseUrl}${item}`)));
  if (!checks.every((item) => item.ok)) {
    throw new HttpsError('failed-precondition', 'Una o más URLs fiscales no respondieron correctamente.', { checks });
  }

  const steps = { ...process.steps };
  steps[String(stepId)] = {
    ...steps[String(stepId)],
    status: 'completed',
    completedAt: new Date(),
    completedBy: uid,
    evidence: { baseUrl, checks },
  };
  const next = recalculate({ ...process, steps });
  const key = stepId === 7 ? 'certification' : 'production';
  await ref.set({
    steps,
    serviceUrls: { ...(process.serviceUrls || {}), [key]: baseUrl },
    ...next,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  await audit(db, businessId, uid, 'certification_urls_validated', { stepId, baseUrl, checks });
  const saved = await ref.get();
  return { process: publicProcess(saved.data()), checks };
});

module.exports = {
  startEcfCertification,
  getEcfCertificationStatus,
  confirmEcfCertificationStep,
  validateEcfServiceUrls,
  CERTIFICATION_STEPS,
  callerContext,
  processRef,
  publicProcess,
};
