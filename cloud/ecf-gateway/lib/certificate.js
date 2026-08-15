'use strict';

// Carga perezosa del certificado .p12 (montado como secret file por Cloud Run)
// usando la misma lógica que ya usa el POS local (vendor/modules/ecf/signature).
// Si no hay certificado configurado, el Gateway sigue funcionando pero responde
// el ARECF sin firmar (se loguea una sola advertencia) — no debe tumbar el servicio.

const { loadCertificate } = require('../vendor/modules/ecf/signature/signature.service');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { KeyManagementServiceClient } = require('@google-cloud/kms');

let cached = null;
let warned = false;
const tenantCache = new Map();
const kmsClient = new KeyManagementServiceClient();

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

async function decryptSecret(kmsKeyName, ciphertext) {
  const [response] = await kmsClient.decrypt({
    name: kmsKeyName,
    ciphertext: Buffer.from(ciphertext, 'base64'),
  });
  if (!response.plaintext) throw new Error('KMS no devolvió el contenido descifrado.');
  return Buffer.from(response.plaintext);
}

async function getCertificateContextForRnc(rnc, store) {
  const normalized = String(rnc || '').replace(/\D/g, '');
  if (!normalized || typeof store?.findCertificateByRecipientRnc !== 'function') {
    return getCertificateContext();
  }

  const encrypted = await store.findCertificateByRecipientRnc(normalized);
  if (!encrypted?.encryptedP12 || !encrypted?.encryptedPassword || !encrypted?.kmsKeyName) {
    return getCertificateContext();
  }
  const cacheKey = `${encrypted.businessId}:${encrypted.fingerprintSha256 || encrypted.updatedAt || ''}`;
  if (tenantCache.has(cacheKey)) return tenantCache.get(cacheKey);

  let p12Buffer;
  let passwordBuffer;
  try {
    [p12Buffer, passwordBuffer] = await Promise.all([
      decryptSecret(encrypted.kmsKeyName, encrypted.encryptedP12),
      decryptSecret(encrypted.kmsKeyName, encrypted.encryptedPassword),
    ]);
    const hash = crypto.createHash('sha256').update(cacheKey).digest('hex').slice(0, 20);
    const certPath = path.join(os.tmpdir(), `tecno-caja-${hash}.p12`);
    fs.writeFileSync(certPath, p12Buffer, { mode: 0o600 });
    const context = loadCertificate({
      certPath,
      certPassword: passwordBuffer.toString('utf8'),
    });
    fs.rmSync(certPath, { force: true });
    tenantCache.set(cacheKey, context);
    console.log(`[GATEWAY] Certificado multiempresa cargado para businessId=${encrypted.businessId}`);
    return context;
  } catch (error) {
    console.error(`[GATEWAY] No se pudo abrir el certificado cifrado para RNC receptor: ${error.message}`);
    return null;
  } finally {
    p12Buffer?.fill(0);
    passwordBuffer?.fill(0);
  }
}

module.exports = { getCertificateContext, getCertificateContextForRnc };
