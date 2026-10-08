'use strict';

// Empresas (tenants) atendidas por el Gateway. Todas registran ante DGII las
// MISMAS 3 URLs; el Gateway sabe de quién es cada documento por el RNC del XML:
//   - Recepción e-CF:        RNCComprador (la empresa que recibe la factura)
//   - Aprobación comercial:  RNCEmisor    (la empresa que emitió la factura)
//
// Firestore:
//   ecf_gateway_tenants/{rnc}             nombre, tokenHash, certificado cifrado
//   ecf_gateway_tenants/{rnc}/received    recepciones de esa empresa
//   ecf_gateway_tenants/{rnc}/approvals   aprobaciones comerciales de esa empresa
//
// La empresa por defecto (GATEWAY_DEFAULT_RNC, la de Emilio) no necesita estar
// registrada y firma con CERT_PATH. Sin GATEWAY_DEFAULT_RNC el Gateway sigue
// en modo de una sola empresa (acepta cualquier RNC), como antes.

const crypto = require('crypto');

const TENANTS = 'ecf_gateway_tenants';
// Colecciones de antes del modo multiempresa: todo lo que hay ahí es de la
// empresa por defecto.
const LEGACY_RECEIVED = 'ecf_gateway_received';
const LEGACY_APPROVALS = 'ecf_gateway_approvals';

function normalizeRnc(value) {
  return String(value || '').replace(/\D/g, '');
}

// RNC de empresa (9 dígitos) o cédula de persona física (11).
function isValidRnc(rnc) {
  return rnc.length === 9 || rnc.length === 11;
}

function receivedCollection(rnc) {
  return `${TENANTS}/${rnc}/received`;
}

function approvalsCollection(rnc) {
  return `${TENANTS}/${rnc}/approvals`;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Lo que se puede devolver por la API: nunca el hash del token ni el
// certificado cifrado.
function publicView(doc) {
  if (!doc) return null;
  const { tokenHash, certificate, ...rest } = doc;
  return {
    ...rest,
    hasToken: Boolean(tokenHash),
    certificate: certificate
      ? {
          subject: certificate.subject,
          issuer: certificate.issuer,
          validFrom: certificate.validFrom,
          validTo: certificate.validTo,
          fingerprintSha256: certificate.fingerprintSha256,
          updatedAt: certificate.updatedAt,
        }
      : null,
  };
}

function createTenantService({ store, defaultRnc = '', defaultBusinessId = null }) {
  async function resolve(rncInput) {
    const rnc = normalizeRnc(rncInput);
    if (!rnc) return null;
    const isDefault = Boolean(defaultRnc) && rnc === defaultRnc;

    const doc = await store.findByKey(TENANTS, rnc);
    if (doc) {
      if (doc.active === false) return null;
      return { ...doc, rnc, isDefault, businessId: doc.businessId || (isDefault ? defaultBusinessId : null) };
    }
    if (isDefault) return { rnc, isDefault: true, businessId: defaultBusinessId };
    if (!defaultRnc) return { rnc, isDefault: false, legacy: true, businessId: defaultBusinessId };
    return null;
  }

  // Token de empresa: "<rnc>.<secreto>". El RNC permite buscar el documento
  // directo; en Firestore solo se guarda el hash.
  async function authenticate(token) {
    const rnc = normalizeRnc(String(token || '').split('.')[0]);
    if (!rnc || !String(token).includes('.')) return null;
    const doc = await store.findByKey(TENANTS, rnc);
    if (!doc || doc.active === false || !doc.tokenHash) return null;
    return safeEqual(hashToken(token), doc.tokenHash) ? { ...doc, rnc } : null;
  }

  async function upsert({ rnc, nombre, businessId, active, rotateToken = false }) {
    const existing = await store.findByKey(TENANTS, rnc);
    const now = new Date().toISOString();
    const doc = {
      ...(existing || {}),
      rnc,
      nombre: String(nombre ?? existing?.nombre ?? '').trim(),
      businessId: businessId ?? existing?.businessId ?? null,
      active: active ?? existing?.active ?? true,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    let token = null;
    if (!existing?.tokenHash || rotateToken) {
      token = `${rnc}.${crypto.randomBytes(24).toString('hex')}`;
      doc.tokenHash = hashToken(token);
    }
    await store.save(TENANTS, rnc, doc);
    return { created: !existing, tenant: publicView(doc), token };
  }

  async function exists(rnc) {
    return Boolean(await store.findByKey(TENANTS, rnc));
  }

  async function saveCertificate(rnc, certificate) {
    const existing = await store.findByKey(TENANTS, rnc);
    if (!existing) return null;
    const doc = { ...existing, certificate, updatedAt: new Date().toISOString() };
    await store.save(TENANTS, rnc, doc);
    return publicView(doc);
  }

  async function list() {
    const docs = await store.list(TENANTS, { limit: 500, orderBy: 'createdAt' });
    return docs.map(publicView);
  }

  return { resolve, authenticate, upsert, exists, saveCertificate, list };
}

module.exports = {
  TENANTS,
  LEGACY_RECEIVED,
  LEGACY_APPROVALS,
  approvalsCollection,
  createTenantService,
  isValidRnc,
  normalizeRnc,
  publicView,
  receivedCollection,
  safeEqual,
};
