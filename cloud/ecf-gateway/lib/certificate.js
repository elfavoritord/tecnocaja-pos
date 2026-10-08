'use strict';

// Certificados .p12 con los que el Gateway firma el ARECF de cada empresa.
// Orden de búsqueda para un RNC:
//   1. El certificado subido para esa empresa al Gateway (ecf_gateway_tenants,
//      cifrado con Cloud KMS).
//   2. El certificado subido desde la app Android (businesses/{id}/privateFiscal).
//   3. CERT_PATH (secret file de Cloud Run) — SOLO para la empresa por defecto
//      (GATEWAY_DEFAULT_RNC); nunca se firma a nombre de otra empresa con él.
// Si no hay certificado, el Gateway sigue respondiendo el ARECF sin firmar (se
// loguea) — no debe tumbar el servicio.

const { loadCertificate } = require('../vendor/modules/ecf/signature/signature.service');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_CERTIFICATE_BYTES = 60 * 1024;

let cached = null;
let warned = false;
const tenantCache = new Map();

// El cliente de KMS se carga solo cuando hace falta: la librería es pesada y
// no se usa en la mayoría de las peticiones (ni en los tests).
let defaultKms = null;
function getDefaultKms() {
  if (!defaultKms) {
    const { KeyManagementServiceClient } = require('@google-cloud/kms');
    defaultKms = new KeyManagementServiceClient();
  }
  return defaultKms;
}

// Misma llave que usa la app Android (functions/certificate-vault.js).
function kmsKeyName() {
  if (process.env.ECF_KMS_KEY_NAME) return process.env.ECF_KMS_KEY_NAME;
  const project = process.env.FIRESTORE_PROJECT_ID || 'reporte-sistema-pos';
  return `projects/${project}/locations/global/keyRings/tecno-caja-fiscal/cryptoKeys/certificate-vault`;
}

function getCertificateContext() {
  if (cached) return cached;

  const certPath = String(process.env.CERT_PATH || '').trim();
  const certPassword = String(process.env.CERT_PASSWORD || '').trim();

  if (!certPath) {
    if (!warned) {
      console.warn('[GATEWAY] CERT_PATH no configurado — el ARECF se enviará SIN firmar.');
      warned = true;
    }
    return null;
  }

  try {
    cached = loadCertificate({ certPath, certPassword });
    console.log(`[GATEWAY] Certificado cargado: ${cached.subject} (vence ${cached.validTo})`);
    return cached;
  } catch (err) {
    if (!warned) {
      console.error(`[GATEWAY] No se pudo cargar el certificado: ${err.message}`);
      warned = true;
    }
    return null;
  }
}

async function decryptSecret(kms, keyName, ciphertext) {
  const [response] = await kms.decrypt({
    name: keyName,
    ciphertext: Buffer.from(ciphertext, 'base64'),
  });
  if (!response.plaintext) throw new Error('KMS no devolvió el contenido descifrado.');
  return Buffer.from(response.plaintext);
}

async function encryptSecret(kms, keyName, plaintext) {
  const [response] = await kms.encrypt({ name: keyName, plaintext: Buffer.from(plaintext) });
  if (!response.ciphertext) throw new Error('KMS no devolvió el texto cifrado.');
  return Buffer.from(response.ciphertext).toString('base64');
}

// loadCertificate() solo lee de disco: el .p12 vive en un archivo temporal
// 0600 el tiempo justo para abrirlo.
function loadCertificateFromBuffer(p12Buffer, password, label) {
  const hash = crypto.createHash('sha256').update(String(label)).digest('hex').slice(0, 20);
  const certPath = path.join(os.tmpdir(), `tecno-caja-${hash}-${process.pid}.p12`);
  fs.writeFileSync(certPath, p12Buffer, { mode: 0o600 });
  try {
    return loadCertificate({ certPath, certPassword: password });
  } finally {
    fs.rmSync(certPath, { force: true });
  }
}

async function openEncryptedCertificate(encrypted, cacheKey, kms) {
  if (tenantCache.has(cacheKey)) return tenantCache.get(cacheKey);

  let p12Buffer;
  let passwordBuffer;
  try {
    [p12Buffer, passwordBuffer] = await Promise.all([
      decryptSecret(kms, encrypted.kmsKeyName, encrypted.encryptedP12),
      decryptSecret(kms, encrypted.kmsKeyName, encrypted.encryptedPassword),
    ]);
    const context = loadCertificateFromBuffer(p12Buffer, passwordBuffer.toString('utf8'), cacheKey);
    tenantCache.set(cacheKey, context);
    console.log(`[GATEWAY] Certificado multiempresa cargado (${cacheKey.split(':').slice(0, 2).join(':')})`);
    return context;
  } catch (error) {
    console.error(`[GATEWAY] No se pudo abrir el certificado cifrado (${cacheKey.split(':')[0]}): ${error.message}`);
    return null;
  } finally {
    p12Buffer?.fill(0);
    passwordBuffer?.fill(0);
  }
}

function hasEncryptedFields(doc) {
  return Boolean(doc?.encryptedP12 && doc?.encryptedPassword && doc?.kmsKeyName);
}

async function getCertificateContextForRnc(rnc, store, { tenant = null, allowEnvCert = false, kms } = {}) {
  const normalized = String(rnc || '').replace(/\D/g, '');

  if (normalized && hasEncryptedFields(tenant?.certificate)) {
    const cert = tenant.certificate;
    const context = await openEncryptedCertificate(
      cert,
      `tenant:${normalized}:${cert.fingerprintSha256 || cert.updatedAt || ''}`,
      kms || getDefaultKms()
    );
    if (context) return context;
  }

  if (normalized && typeof store?.findCertificateByRecipientRnc === 'function') {
    const encrypted = await store.findCertificateByRecipientRnc(normalized);
    if (hasEncryptedFields(encrypted)) {
      const context = await openEncryptedCertificate(
        encrypted,
        `business:${encrypted.businessId}:${encrypted.fingerprintSha256 || encrypted.updatedAt || ''}`,
        kms || getDefaultKms()
      );
      if (context) return context;
    }
  }

  if (allowEnvCert) return getCertificateContext();

  console.warn(`[GATEWAY] Sin certificado para RNC ${normalized || '(vacío)'} — el ARECF se enviará SIN firmar.`);
  return null;
}

// Valida el .p12 (contraseña correcta, trae clave privada, vigente) y lo
// devuelve cifrado con KMS listo para guardar en ecf_gateway_tenants/{rnc}.
async function sealCertificate({ p12Buffer, password, kms }) {
  if (!p12Buffer?.length || p12Buffer.length > MAX_CERTIFICATE_BYTES) {
    throw Object.assign(new Error('El certificado debe ser un .p12/.pfx de menos de 60 KB.'), { statusCode: 400 });
  }
  if (!password) {
    throw Object.assign(new Error('Indica la contraseña del certificado.'), { statusCode: 400 });
  }

  let context;
  try {
    context = loadCertificateFromBuffer(p12Buffer, password, `upload:${Date.now()}`);
  } catch (_) {
    throw Object.assign(new Error('El certificado o su contraseña no son válidos.'), { statusCode: 400 });
  }
  const now = new Date();
  if (now < context.validFrom || now > context.validTo) {
    throw Object.assign(new Error('El certificado digital está vencido o todavía no es válido.'), { statusCode: 400 });
  }

  const client = kms || getDefaultKms();
  const keyName = kmsKeyName();
  const [encryptedP12, encryptedPassword] = await Promise.all([
    encryptSecret(client, keyName, p12Buffer),
    encryptSecret(client, keyName, Buffer.from(password, 'utf8')),
  ]);

  return {
    encryptedP12,
    encryptedPassword,
    kmsKeyName: keyName,
    subject: context.subject,
    issuer: context.issuer,
    validFrom: context.validFrom.toISOString(),
    validTo: context.validTo.toISOString(),
    fingerprintSha256: crypto
      .createHash('sha256')
      .update(Buffer.from(context.certificateBase64, 'base64'))
      .digest('hex'),
    updatedAt: now.toISOString(),
  };
}

module.exports = { getCertificateContext, getCertificateContextForRnc, sealCertificate, kmsKeyName };
