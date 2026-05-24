'use strict';

/**
 * r2-storage.js — Almacenamiento en nube para respaldos Tecno Caja
 * Compatible con AWS S3 SDK v3.  Soporta Cloudflare R2 y Backblaze B2.
 *
 * Para Cloudflare R2:
 *   R2_ACCOUNT_ID       — Account ID (32 chars hex)
 *   R2_ACCESS_KEY_ID    — API Token con permisos Object Read/Write
 *   R2_SECRET_ACCESS_KEY
 *   R2_BUCKET
 *
 * Para Backblaze B2 (gratis sin tarjeta):
 *   R2_ACCESS_KEY_ID    — keyID del Application Key de B2
 *   R2_SECRET_ACCESS_KEY— applicationKey de B2
 *   R2_BUCKET           — nombre del bucket
 *   R2_ENDPOINT         — https://s3.{region}.backblazeb2.com
 *                         (ej: https://s3.us-west-004.backblazeb2.com)
 */

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');

const crypto = require('crypto');

// ─── Singleton del cliente ────────────────────────────────────────────────────
let _client = null;

function getClient() {
  if (_client) return _client;

  const accountId        = (process.env.R2_ACCOUNT_ID        || '').trim();
  const accessKeyId      = (process.env.R2_ACCESS_KEY_ID     || '').trim();
  const secretAccessKey  = (process.env.R2_SECRET_ACCESS_KEY || '').trim();
  const endpointOverride = (process.env.R2_ENDPOINT          || '').trim();

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'Almacenamiento en nube no configurado. ' +
      'Agrega R2_ACCESS_KEY_ID y R2_SECRET_ACCESS_KEY en .env'
    );
  }

  if (!endpointOverride && !accountId) {
    throw new Error(
      'Agrega R2_ACCOUNT_ID (para Cloudflare R2) ' +
      'o R2_ENDPOINT (para Backblaze B2 u otros) en .env'
    );
  }

  const endpoint = endpointOverride || `https://${accountId}.r2.cloudflarestorage.com`;

  // Detectar region según proveedor
  let region = 'auto'; // valor para Cloudflare R2
  if (endpointOverride) {
    // Backblaze B2: https://s3.us-west-004.backblazeb2.com
    const b2Match = endpointOverride.match(/s3\.([^.]+)\.backblazeb2\.com/);
    if (b2Match) region = b2Match[1];
    else region = 'us-east-1'; // fallback para S3 genérico
  }

  // forcePathStyle: requerido para Backblaze B2 (y no rompe Cloudflare R2).
  // Sin esto, el SDK construye URLs tipo "https://{bucket}.{endpoint}" que B2 rechaza.
  const isB2 = endpointOverride.includes('backblazeb2.com');

  _client = new S3Client({
    region,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: isB2 || Boolean(process.env.R2_FORCE_PATH_STYLE),
    // Deshabilitar checksums automáticos (compatibilidad con R2 y B2)
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation:  'WHEN_REQUIRED',
  });

  return _client;
}

function getBucket() {
  const bucket = (process.env.R2_BUCKET || '').trim();
  if (!bucket) throw new Error('R2_BUCKET no configurado en .env');
  return bucket;
}

// ─── Verificar si R2/B2 está disponible (con caché 60 s) ─────────────────────
let _availCache    = null;   // { ok: bool, ts: Date.now() }
const AVAIL_TTL_MS = 60_000; // 60 segundos

async function isR2Available(force = false) {
  const now = Date.now();
  if (!force && _availCache && (now - _availCache.ts) < AVAIL_TTL_MS) {
    if (!_availCache.ok) throw new Error(_availCache.err || 'No disponible (caché)');
    return true;
  }
  try {
    const client = getClient();
    const bucket = getBucket();
    // ListObjectsV2 con MaxKeys=1 funciona en R2, B2 y S3 genérico
    // HeadBucket a veces falla en B2 con permisos de app key
    await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
    _availCache = { ok: true, ts: now };
    return true;
  } catch (e) {
    _availCache = { ok: false, ts: now, err: e.message };
    throw e;
  }
}

// ─── Subir archivo ────────────────────────────────────────────────────────────
async function upload(key, buffer, metadata = {}) {
  const client = getClient();
  const bucket = getBucket();
  await client.send(new PutObjectCommand({
    Bucket:      bucket,
    Key:         key,
    Body:        buffer,
    ContentType: 'application/octet-stream',
    Metadata:    Object.fromEntries(
      Object.entries(metadata).map(([k, v]) => [k, String(v)])
    ),
  }));
}

// ─── Descargar archivo ────────────────────────────────────────────────────────
async function download(key) {
  const client = getClient();
  const bucket = getBucket();
  const resp   = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

  // Convertir ReadableStream → Buffer
  const chunks = [];
  for await (const chunk of resp.Body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ─── Listar objetos bajo un prefijo ──────────────────────────────────────────
async function listObjects(prefix) {
  const client  = getClient();
  const bucket  = getBucket();
  const results = [];
  let token;

  do {
    const resp = await client.send(new ListObjectsV2Command({
      Bucket:            bucket,
      Prefix:            prefix,
      MaxKeys:           100,
      ContinuationToken: token,
    }));
    (resp.Contents || []).forEach(obj => results.push(obj));
    token = resp.IsTruncated ? resp.NextContinuationToken : null;
  } while (token);

  return results;
}

// ─── Eliminar objeto ──────────────────────────────────────────────────────────
async function remove(key) {
  const client = getClient();
  const bucket = getBucket();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

// ─── Verificar si un objeto existe ───────────────────────────────────────────
async function exists(key) {
  try {
    const client = getClient();
    const bucket = getBucket();
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (_) {
    return false;
  }
}

// ─── Guardar/leer JSON en R2 (para índices) ──────────────────────────────────
async function putJson(key, obj) {
  const client = getClient();
  const bucket = getBucket();
  await client.send(new PutObjectCommand({
    Bucket:      bucket,
    Key:         key,
    Body:        Buffer.from(JSON.stringify(obj), 'utf8'),
    ContentType: 'application/json',
  }));
}

async function getJson(key) {
  try {
    const buf = await download(key);
    return JSON.parse(buf.toString('utf8'));
  } catch (_) {
    return null;
  }
}

// ─── Derivar clave de índice desde email ─────────────────────────────────────
function emailIndexKey(email) {
  const hash = crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
  return `idx/email/${hash}.json`;
}

// ─── Ruta del negocio ─────────────────────────────────────────────────────────
function backupPrefix(businessId) {
  return `backups/${businessId}/`;
}

function backupKey(businessId, fileName) {
  return `backups/${businessId}/${fileName}`;
}

/** Fuerza re-creación del cliente (útil si cambian vars en caliente) */
function resetClient() {
  _client      = null;
  _availCache  = null;
}

module.exports = {
  isR2Available,
  upload,
  download,
  listObjects,
  remove,
  exists,
  putJson,
  getJson,
  emailIndexKey,
  backupPrefix,
  backupKey,
  getBucket,
  resetClient,
};
