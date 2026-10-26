'use strict';

const crypto = require('crypto');

// Clave con la que cifra toda instalación sin ECF_SECRET/FISCAL_CERT_SECRET.
// Si la instalación luego recibe su propia clave, lo guardado antes con esta
// se sigue pudiendo leer (ver decryptTextWithLegacyFallback).
const LEGACY_DEFAULT_SECRET = 'tecnocaja-ecf-secret-change-me';
const DEFAULT_SECRET = process.env.ECF_SECRET || process.env.FISCAL_CERT_SECRET || LEGACY_DEFAULT_SECRET;

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

function decryptTextWithLegacyFallback(payload) {
  try {
    return decryptText(payload);
  } catch (error) {
    if (DEFAULT_SECRET === LEGACY_DEFAULT_SECRET) throw error;
    return decryptText(payload, LEGACY_DEFAULT_SECRET);
  }
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
  decryptTextWithLegacyFallback,
  encryptBuffer,
  encryptText,
  maskSecret,
};
