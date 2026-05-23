'use strict';

const crypto = require('crypto');

const DEFAULT_SECRET = process.env.ECF_SECRET || process.env.FISCAL_CERT_SECRET || 'tecnocaja-ecf-secret-change-me';

function deriveKey(secret = DEFAULT_SECRET) {
  return crypto.scryptSync(String(secret), 'tecnocaja-ecf-salt-v2', 32);
}

function encryptBuffer(buffer, secret = DEFAULT_SECRET) {
  const iv = crypto.randomBytes(16);
  const key = deriveKey(secret);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(buffer || [])), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('base64')}`;
}

function decryptBuffer(payload, secret = DEFAULT_SECRET) {
  const [ivHex, tagHex, encrypted] = String(payload || '').split(':');
  if (!ivHex || !tagHex || !encrypted) {
    throw new Error('El dato cifrado no tiene un formato válido.');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const key = deriveKey(secret);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]);
}

function encryptText(value, secret = DEFAULT_SECRET) {
  return encryptBuffer(Buffer.from(String(value || ''), 'utf8'), secret);
}

function decryptText(payload, secret = DEFAULT_SECRET) {
  return decryptBuffer(payload, secret).toString('utf8');
}

function maskSecret(value, keep = 4) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= keep) return '*'.repeat(text.length);
  return `${'*'.repeat(Math.max(0, text.length - keep))}${text.slice(-keep)}`;
}

module.exports = {
  decryptBuffer,
  decryptText,
  encryptBuffer,
  encryptText,
  maskSecret,
};
