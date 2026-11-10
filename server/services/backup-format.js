'use strict';
// Codec puro: verificar un archivo nunca abre ni migra una base de datos.
const crypto = require('crypto');
const { promisify } = require('util');
const zlib = require('zlib');
const catalog = require('./backup-catalog');
const gzip = promisify(zlib.gzip), gunzip = promisify(zlib.gunzip);
const BACKUP_MAGIC = 'TECNOCAJA_BACKUP_V1';
const BACKUP_MAGIC_V3 = 'TECNOCAJA_BACKUP_V3';
const BACKUP_FORMAT_VERSION = catalog.VERSION;

async function createTcbakBuffer(payload, password) {
  const payloadJson = JSON.stringify(payload);
  const sha256      = crypto.createHash('sha256').update(payloadJson, 'utf8').digest('hex');

  const compressed  = await gzip(Buffer.from(payloadJson, 'utf8'));
  const { encryptBackupPayload } = require('../security/backup-crypto');
  const encContent  = encryptBackupPayload(compressed.toString('base64'), password);

  const tcbak = {
    magic:         String(payload.formatVersion) === '3' ? BACKUP_MAGIC_V3 : BACKUP_MAGIC,
    formatVersion: payload.formatVersion || BACKUP_FORMAT_VERSION,
    sha256,
    createdAt:     payload.exportedAt,
    metadata: {
      businessName:  payload.businessName,
      businessId:    payload.businessId,
      rnc:           payload.rnc,
      systemVersion: payload.systemVersion,
      stats:         payload.stats,
    },
    encrypted: encContent,
  };

  return Buffer.from(JSON.stringify(tcbak), 'utf8');
}

// ─── Parsear y descifrar .tcbak ──────────────────────────────────────────────
async function parseTcbakBuffer(fileBuffer, password) {
  let tcbak;
  try {
    tcbak = JSON.parse(fileBuffer.toString('utf8'));
  } catch (_) {
    throw new Error('El archivo no es un respaldo válido de Tecno Caja (formato inválido).');
  }

  if (![BACKUP_MAGIC, BACKUP_MAGIC_V3].includes(tcbak.magic)) {
    throw new Error('Este archivo no es un respaldo de Tecno Caja.');
  }
  if (!['1', '2', '3'].includes(String(tcbak.formatVersion || '1'))) throw new Error('Versión de respaldo incompatible. Actualiza Tecno Caja antes de restaurar.');

  const { decryptBackupPayload } = require('../security/backup-crypto');
  let decryptedBase64;
  try {
    decryptedBase64 = decryptBackupPayload(tcbak.encrypted, password, { allowLegacyFallback: tcbak.magic !== BACKUP_MAGIC_V3 });
  } catch (_) {
    throw new Error('Contraseña incorrecta o archivo corrupto. No se pudo descifrar el respaldo.');
  }

  let payloadJson;
  try {
    const compressed = Buffer.from(decryptedBase64, 'base64');
    const decompressed = await gunzip(compressed, { maxOutputLength: 768 * 1024 * 1024 });
    payloadJson = decompressed.toString('utf8');
  } catch (_) {
    throw new Error('Error al descomprimir el respaldo. El archivo puede estar dañado.');
  }

  const sha256Actual = crypto.createHash('sha256').update(payloadJson, 'utf8').digest('hex');
  if (sha256Actual !== tcbak.sha256) {
    throw new Error('El respaldo está corrupto o fue modificado (SHA-256 no coincide). Restauración cancelada.');
  }

  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch (_) {
    throw new Error('Error al procesar el contenido del respaldo.');
  }

  if (String(payload.formatVersion) === '3') catalog.validarCatalogo(payload);
  if (!['1', '2', '3'].includes(String(payload.formatVersion || '1'))) throw new Error('Contenido de una versión de respaldo incompatible.');
  return { payload, metadata: { businessName: payload.businessName, businessId: payload.businessId, rnc: payload.rnc, systemVersion: payload.systemVersion, stats: payload.stats }, sha256: tcbak.sha256 };
}


// Prueba varias claves (la de esta PC, la guardada en la nube para ese negocio,
// las anteriores): una PC formateada ya no tiene la suya en app.env.
async function parseTcbakBufferCon(fileBuffer, claves) {
  const lista = [...new Set((claves || []).map((c) => String(c || '')).filter(Boolean))];
  let ultimo = null;
  for (const clave of lista) {
    try {
      const r = await parseTcbakBuffer(fileBuffer, clave);
      return { ...r, claveUsada: clave };
    } catch (e) {
      ultimo = e;
      // Solo se prueba otra clave si esta no descifró; un archivo dañado no mejora.
      if (!/Contraseña incorrecta/.test(e.message)) throw e;
    }
  }
  throw ultimo || new Error('Contraseña incorrecta o archivo corrupto. No se pudo descifrar el respaldo.');
}

module.exports = { createTcbakBuffer, parseTcbakBuffer, parseTcbakBufferCon };
