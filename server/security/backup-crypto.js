/**
 * server/security/backup-crypto.js
 *
 * Cifrado y descifrado de respaldos .novaseguro de Tecno Caja.
 *
 * Algoritmo: AES-256-GCM con scrypt como KDF.
 *
 * Política de rotación:
 *   - Al cifrar siempre usa la contraseña activa (DEFAULT_SECURITY_PASSWORD de server.js).
 *   - Al descifrar intenta primero con la contraseña provista, y si falla, cae al
 *     LEGACY_DEFAULT_SECURITY_PASSWORD. Esto garantiza que rotar credenciales
 *     no rompe respaldos existentes.
 *
 * No depende de Express ni de la BD. Puro crypto.
 */

'use strict';

const crypto = require('crypto');

// Password legado de instalaciones anteriores a la rotación por env var.
// Solo se usa como fallback de lectura. NO cifrar nuevos respaldos con él.
const LEGACY_DEFAULT_SECURITY_PASSWORD = 'Seguridad2026';

const PAYLOAD_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const KEY_LEN_BYTES = 32;
const SALT_LEN_BYTES = 16;
const IV_LEN_BYTES = 12;

/**
 * Cifra un objeto JSON y devuelve un string JSON (ya estructurado).
 * @param {object} payload
 * @param {string} password
 * @returns {string}
 */
function encryptBackupPayload(payload, password) {
  if (!password) throw new Error('encryptBackupPayload requiere password');

  const salt = crypto.randomBytes(SALT_LEN_BYTES);
  const iv = crypto.randomBytes(IV_LEN_BYTES);
  const key = crypto.scryptSync(password, salt, KEY_LEN_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const content = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify(
    {
      version: PAYLOAD_VERSION,
      algorithm: ALGORITHM,
      createdAt: new Date().toISOString(),
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      content: encrypted.toString('base64')
    },
    null,
    2
  );
}

/**
 * Descifra un string o objeto producido por encryptBackupPayload.
 * Intenta primero con `password`. Si falla y `password` != LEGACY, reintenta con LEGACY.
 *
 * @param {string | object} encryptedContent
 * @param {string} password
 * @returns {object} payload original
 */
function decryptBackupPayload(encryptedContent, password) {
  if (!password) throw new Error('decryptBackupPayload requiere password');

  let parsed = encryptedContent;
  if (typeof encryptedContent === 'string') {
    parsed = JSON.parse(encryptedContent);
  }

  const salt = Buffer.from(parsed.salt, 'base64');
  const iv = Buffer.from(parsed.iv, 'base64');
  const tag = Buffer.from(parsed.tag, 'base64');
  const content = Buffer.from(parsed.content, 'base64');

  const candidates = [password];
  if (password !== LEGACY_DEFAULT_SECURITY_PASSWORD) {
    candidates.push(LEGACY_DEFAULT_SECURITY_PASSWORD);
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const key = crypto.scryptSync(candidate, salt, KEY_LEN_BYTES);
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(content), decipher.final()]).toString('utf8');
      return JSON.parse(decrypted);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('No se pudo descifrar el respaldo.');
}

module.exports = {
  encryptBackupPayload,
  decryptBackupPayload,
  LEGACY_DEFAULT_SECURITY_PASSWORD,
  PAYLOAD_VERSION,
  ALGORITHM
};
