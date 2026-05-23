'use strict';

const crypto = require('crypto');
const { getMachineFingerprint } = require('./machine-identity');

const DB_MAGIC = Buffer.from('NVPDB1', 'utf8');
const DB_VERSION = 1;
const DB_IV_LENGTH = 12;
const DB_TAG_LENGTH = 16;
const JSON_MAGIC = 'TECNO_CAJA_LOCAL_ENVELOPE_V1';
const JSON_VERSION = 1;
const JSON_ALGORITHM = 'aes-256-gcm';

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value) {
  return Buffer.from(String(value || ''), 'base64url');
}

function resolveSecret(secretEnvKeys = []) {
  const keys = Array.isArray(secretEnvKeys) ? secretEnvKeys : [secretEnvKeys];
  for (const key of keys) {
    const value = String(process.env[key] || '').trim();
    if (value) return value;
  }
  return String(
    process.env.TECNO_CAJA_LICENSE_STORAGE_SECRET
      || process.env.TECNO_CAJA_DB_KEY_SALT
      || `${process.env.TECNO_CAJA_USER_DATA || ''}:${process.env.TECNO_CAJA_APP_ROOT || ''}`
  ).trim() || getMachineFingerprint();
}

function deriveMachineBoundKey({ purpose, secretEnvKeys }) {
  const fingerprint = getMachineFingerprint();
  const secret = resolveSecret(secretEnvKeys);
  return crypto.scryptSync(`${fingerprint}:${String(purpose || 'tecnocaja-local')}`, secret, 32);
}

function isPlainSqliteBuffer(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= 16
    && buffer.subarray(0, 16).toString('utf8') === 'SQLite format 3\u0000';
}

function isEncryptedSqliteBuffer(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length > DB_MAGIC.length + 1 + DB_IV_LENGTH + DB_TAG_LENGTH
    && buffer.subarray(0, DB_MAGIC.length).equals(DB_MAGIC);
}

function encryptSqliteBuffer(buffer, options = {}) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const key = deriveMachineBoundKey({
    purpose: 'sqlite-at-rest',
    secretEnvKeys: options.secretEnvKeys || ['TECNO_CAJA_DB_KEY_SALT', 'TECNO_CAJA_LICENSE_STORAGE_SECRET'],
  });
  const iv = crypto.randomBytes(DB_IV_LENGTH);
  const cipher = crypto.createCipheriv(JSON_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(source), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([DB_MAGIC, Buffer.from([DB_VERSION]), iv, tag, encrypted]);
}

function decryptSqliteBuffer(buffer, options = {}) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!source.length) return source;
  if (isPlainSqliteBuffer(source)) return source;
  if (!isEncryptedSqliteBuffer(source)) {
    const error = new Error('La base de datos local tiene un formato inválido o fue manipulada.');
    error.code = 'LOCAL_DB_TAMPERED';
    throw error;
  }

  const version = source[DB_MAGIC.length];
  if (version !== DB_VERSION) {
    const error = new Error('La versión del cifrado local no es compatible con esta instalación.');
    error.code = 'LOCAL_DB_VERSION_UNSUPPORTED';
    throw error;
  }

  const ivStart = DB_MAGIC.length + 1;
  const tagStart = ivStart + DB_IV_LENGTH;
  const contentStart = tagStart + DB_TAG_LENGTH;
  const iv = source.subarray(ivStart, tagStart);
  const tag = source.subarray(tagStart, contentStart);
  const encrypted = source.subarray(contentStart);
  const key = deriveMachineBoundKey({
    purpose: 'sqlite-at-rest',
    secretEnvKeys: options.secretEnvKeys || ['TECNO_CAJA_DB_KEY_SALT', 'TECNO_CAJA_LICENSE_STORAGE_SECRET'],
  });

  try {
    const decipher = crypto.createDecipheriv(JSON_ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch (error) {
    const wrapped = new Error('No se pudo descifrar la base local. Puede pertenecer a otro equipo o haber sido alterada.');
    wrapped.code = 'LOCAL_DB_DECRYPT_FAILED';
    wrapped.cause = error;
    throw wrapped;
  }
}

function encryptJsonEnvelope(payload, options = {}) {
  const key = deriveMachineBoundKey({
    purpose: options.purpose || 'license-cache',
    secretEnvKeys: options.secretEnvKeys || ['TECNO_CAJA_LICENSE_STORAGE_SECRET'],
  });
  const iv = crypto.randomBytes(DB_IV_LENGTH);
  const cipher = crypto.createCipheriv(JSON_ALGORITHM, key, iv);
  const content = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(content), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    magic: JSON_MAGIC,
    version: JSON_VERSION,
    alg: JSON_ALGORITHM,
    iv: encodeBase64Url(iv),
    tag: encodeBase64Url(tag),
    content: encodeBase64Url(encrypted),
  });
}

function decryptJsonEnvelope(payload, options = {}) {
  const envelope = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (!envelope || envelope.magic !== JSON_MAGIC) {
    const error = new Error('El caché local de licencia tiene un formato inválido.');
    error.code = 'LICENSE_CACHE_INVALID_FORMAT';
    throw error;
  }

  const key = deriveMachineBoundKey({
    purpose: options.purpose || 'license-cache',
    secretEnvKeys: options.secretEnvKeys || ['TECNO_CAJA_LICENSE_STORAGE_SECRET'],
  });

  try {
    const decipher = crypto.createDecipheriv(
      envelope.alg || JSON_ALGORITHM,
      key,
      decodeBase64Url(envelope.iv)
    );
    decipher.setAuthTag(decodeBase64Url(envelope.tag));
    const decrypted = Buffer.concat([
      decipher.update(decodeBase64Url(envelope.content)),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (error) {
    const wrapped = new Error('No se pudo validar el caché local de licencia. Puede haber sido manipulado.');
    wrapped.code = 'LICENSE_CACHE_TAMPERED';
    wrapped.cause = error;
    throw wrapped;
  }
}

function computeIntegrityHash(value, options = {}) {
  const key = deriveMachineBoundKey({
    purpose: `${options.purpose || 'license-cache'}:integrity`,
    secretEnvKeys: options.secretEnvKeys || ['TECNO_CAJA_LICENSE_STORAGE_SECRET'],
  });
  return crypto
    .createHmac('sha256', key)
    .update(String(value || ''), 'utf8')
    .digest('base64url');
}

module.exports = {
  computeIntegrityHash,
  decryptJsonEnvelope,
  decryptSqliteBuffer,
  deriveMachineBoundKey,
  encryptJsonEnvelope,
  encryptSqliteBuffer,
  isEncryptedSqliteBuffer,
  isPlainSqliteBuffer,
};
