// ══════════════════════════════════════════════════════════════════════════════
//  fiscalCertificateService.js  —  Tecno Caja e-CF / DGII
//  Gestión segura de certificados .p12 / PKCS#12 por empresa.
//  REGLAS DE SEGURIDAD:
//    - El .p12 NUNCA sale al frontend
//    - La contraseña NUNCA se muestra en logs ni en respuesta después de guardarse
//    - Se cifra con AES-256-GCM usando la clave derivada de FISCAL_CERT_SECRET
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const crypto  = require('crypto');
const forge   = require('node-forge');
const { writeFiscalAuditLog, upsertOne } = require('./fiscalExtensions');

// ── Cifrado ──────────────────────────────────────────────────────────────────
const CERT_SECRET = process.env.FISCAL_CERT_SECRET || 'tecnocaja-fiscal-cert-default-secret-change-in-prod';

function deriveKey(secret) {
  return crypto.scryptSync(secret, 'tecnocaja-fiscal-salt-v1', 32);
}

function encryptData(plaintext) {
  const key   = deriveKey(CERT_SECRET);
  const iv    = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc   = Buffer.concat([cipher.update(Buffer.from(plaintext, 'base64')), cipher.final()]);
  const tag   = cipher.getAuthTag();
  // Format: iv(hex):tag(hex):ciphertext(base64)
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('base64')}`;
}

function decryptData(stored) {
  const [ivHex, tagHex, encB64] = stored.split(':');
  const key     = deriveKey(CERT_SECRET);
  const iv      = Buffer.from(ivHex, 'hex');
  const tag     = Buffer.from(tagHex, 'hex');
  const enc     = Buffer.from(encB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

function encryptPassword(password) {
  const key   = deriveKey(CERT_SECRET);
  const iv    = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc   = Buffer.concat([cipher.update(Buffer.from(password, 'utf8')), cipher.final()]);
  const tag   = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('base64')}`;
}

function decryptPassword(stored) {
  const [ivHex, tagHex, encB64] = stored.split(':');
  const key     = deriveKey(CERT_SECRET);
  const iv      = Buffer.from(ivHex, 'hex');
  const tag     = Buffer.from(tagHex, 'hex');
  const enc     = Buffer.from(encB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc).toString('utf8') + decipher.final().toString('utf8');
}

// ── Leer y analizar el .p12 ───────────────────────────────────────────────────
/**
 * Lee un buffer .p12 con la contraseña dada y extrae info del certificado.
 * @returns {{ cert, privateKey, info }} o lanza error si falla
 */
function readP12Certificate(p12Buffer, password) {
  const p12Asn1   = forge.asn1.fromDer(forge.util.createBuffer(p12Buffer));
  const p12       = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);
  const certBags  = p12.getBags({ bagType: forge.pki.oids.certBag });
  const keyBags   = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });

  const certBag   = (certBags[forge.pki.oids.certBag] || [])[0];
  const keyBag    = (keyBags[forge.pki.oids.pkcs8ShroudedKeyBag] || [])[0];

  if (!certBag) throw new Error('No se encontró certificado dentro del archivo .p12.');
  if (!keyBag)  throw new Error('No se encontró clave privada dentro del archivo .p12.');

  const cert       = certBag.cert;
  const privateKey = keyBag.key;

  const subject    = cert.subject.attributes.map(a => `${a.shortName}=${a.value}`).join(', ');
  const issuer     = cert.issuer.attributes.map(a => `${a.shortName}=${a.value}`).join(', ');
  const serialNum  = cert.serialNumber;
  const validFrom  = cert.validity.notBefore;
  const validTo    = cert.validity.notAfter;

  // Intentar extraer RNC del CN del subject
  const cnMatch = subject.match(/CN=([^,]+)/i);
  const cnValue = cnMatch ? cnMatch[1].trim() : '';

  return { cert, privateKey, info: { subject, issuer, serialNumber: serialNum, validFrom, validTo, cn: cnValue } };
}

// ── API pública del servicio ──────────────────────────────────────────────────

/**
 * Valida el certificado .p12 sin guardarlo.
 * @param {Buffer} p12Buffer
 * @param {string} password
 * @param {string|null} expectedRnc  — RNC del negocio para validar coincidencia
 */
function validateCertificate(p12Buffer, password, expectedRnc = null) {
  const { info } = readP12Certificate(p12Buffer, password);
  const now = new Date();

  const isExpired = info.validTo < now;
  const isNotYetValid = info.validFrom > now;

  let rncMatch = null;
  if (expectedRnc) {
    const cleanRnc = String(expectedRnc).replace(/\D/g, '');
    rncMatch = info.cn.replace(/\D/g, '').includes(cleanRnc) ||
               info.subject.replace(/\D/g, '').includes(cleanRnc);
  }

  return {
    valid: !isExpired && !isNotYetValid,
    isExpired,
    isNotYetValid,
    subject: info.subject,
    issuer: info.issuer,
    serialNumber: info.serialNumber,
    validFrom: info.validFrom.toISOString(),
    validTo: info.validTo.toISOString(),
    daysRemaining: Math.floor((info.validTo - now) / (1000 * 60 * 60 * 24)),
    rncMatch,
    cn: info.cn
  };
}

/**
 * Guarda el certificado cifrado en BD para un business_id.
 */
async function saveCertificateSecurely(query, { businessId, p12Buffer, password, certInfo, userId, ipAddress }) {
  const certB64       = p12Buffer.toString('base64');
  const certEncrypted = encryptData(certB64);
  const passEncrypted = encryptPassword(password);

  // Upsert compatible SQLite + MySQL
  await upsertOne(query, 'fiscal_certificate', 'business_id', {
    business_id:            businessId,
    certificate_encrypted:  certEncrypted,
    password_encrypted:     passEncrypted,
    subject:                certInfo.subject,
    issuer:                 certInfo.issuer,
    serial_number:          certInfo.serialNumber,
    valid_from:             new Date(certInfo.validFrom),
    valid_to:               new Date(certInfo.validTo),
    status:                 'valido'
  });

  await writeFiscalAuditLog(query, {
    businessId,
    userId,
    action: 'certificado_subido',
    description: `Certificado digital subido. Subject: ${certInfo.subject}. Vence: ${certInfo.validTo}`,
    ipAddress
  });

  // Marcar en fiscal_config que hay certificado cargado
  await upsertOne(query, 'fiscal_config', 'business_id', {
    business_id: businessId,
    status:      'certificado_cargado'
  });
}

/**
 * Obtiene el estado del certificado para una empresa.
 */
async function getCertificateStatus(query, businessId) {
  const rows = await query(
    'SELECT id, business_id, subject, issuer, serial_number, valid_from, valid_to, status, updated_at FROM fiscal_certificate WHERE business_id = ? LIMIT 1',
    [businessId]
  );
  if (!rows[0]) return { hasCertificate: false };
  const cert = rows[0];
  const now  = new Date();
  const isExpired = cert.valid_to && new Date(cert.valid_to) < now;
  return {
    hasCertificate: true,
    subject: cert.subject,
    issuer:  cert.issuer,
    serialNumber: cert.serial_number,
    validFrom: cert.valid_from,
    validTo:   cert.valid_to,
    status: isExpired ? 'vencido' : (cert.status || 'valido'),
    isExpired,
    daysRemaining: cert.valid_to
      ? Math.floor((new Date(cert.valid_to) - now) / (1000 * 60 * 60 * 24))
      : null,
    updatedAt: cert.updated_at
  };
}

/**
 * Recupera el p12 Buffer y password descifrados para uso interno del backend.
 * ¡NUNCA enviar esto al frontend!
 */
async function getDecryptedCertificate(query, businessId) {
  const rows = await query(
    'SELECT certificate_encrypted, password_encrypted FROM fiscal_certificate WHERE business_id = ? LIMIT 1',
    [businessId]
  );
  if (!rows[0]) throw new Error('No hay certificado configurado para esta empresa.');
  const { certificate_encrypted, password_encrypted } = rows[0];
  if (!certificate_encrypted || !password_encrypted) throw new Error('Datos de certificado incompletos.');

  const p12Buffer  = decryptData(certificate_encrypted);
  const password   = decryptPassword(password_encrypted);
  return { p12Buffer, password };
}

/**
 * Obtiene el objeto forge.cert + privateKey para firmar XMLs.
 */
async function getCertificateForSigning(query, businessId) {
  const { p12Buffer, password } = await getDecryptedCertificate(query, businessId);
  return readP12Certificate(p12Buffer, password);
}

async function validateStoredCertificate(query, businessId, expectedRnc = null) {
  const { p12Buffer, password } = await getDecryptedCertificate(query, businessId);
  return validateCertificate(p12Buffer, password, expectedRnc);
}

module.exports = {
  validateCertificate,
  validateStoredCertificate,
  saveCertificateSecurely,
  getCertificateStatus,
  getDecryptedCertificate,
  getCertificateForSigning
};
