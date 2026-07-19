#!/usr/bin/env node
'use strict';

/**
 * create-business-b2-key.js — Genera una Application Key de Backblaze B2
 * restringida ÚNICAMENTE al prefijo backups/<businessId>/ de un solo negocio.
 *
 * Con esto, la .env de cada instalación nueva tiene una llave que solo puede
 * leer/escribir/borrar los respaldos de SU PROPIO negocio — no los de otros
 * clientes, aunque todos compartan el mismo bucket "tecnocaja-backups".
 *
 * Requiere en tu .env (de este repo, nunca en el de un cliente) la Master
 * Application Key de tu cuenta de Backblaze, u otra key con capacidad
 * "writeKeys" para poder crear llaves nuevas:
 *   B2_MASTER_KEY_ID=...
 *   B2_MASTER_APPLICATION_KEY=...
 *
 * Uso:
 *   node scripts/create-business-b2-key.js --businessId <uid> --name "A & F Liquor Store"
 */

require('dotenv').config();

const B2_API_BASE = 'https://api.backblazeb2.com';
const BUCKET_NAME = process.env.R2_BUCKET || 'tecnocaja-backups';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const hasValue = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--');
      args[key] = hasValue ? argv[++i] : true;
    }
  }
  return args;
}

async function b2Fetch(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${url} → ${res.status}: ${data.message || JSON.stringify(data)}`);
  }
  return data;
}

async function authorizeAccount(keyId, appKey) {
  const auth = Buffer.from(`${keyId}:${appKey}`).toString('base64');
  return b2Fetch(`${B2_API_BASE}/b2api/v2/b2_authorize_account`, {
    headers: { Authorization: `Basic ${auth}` },
  });
}

async function findBucketId(apiUrl, authToken, accountId, bucketName) {
  const data = await b2Fetch(`${apiUrl}/b2api/v2/b2_list_buckets`, {
    method: 'POST',
    headers: { Authorization: authToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId, bucketName }),
  });
  const bucket = (data.buckets || [])[0];
  if (!bucket) throw new Error(`No se encontró el bucket "${bucketName}" en esta cuenta de B2.`);
  return bucket.bucketId;
}

async function createRestrictedKey({ apiUrl, authToken, accountId, bucketId, businessId, keyName }) {
  const namePrefix = `backups/${businessId}/`;
  return b2Fetch(`${apiUrl}/b2api/v2/b2_create_key`, {
    method: 'POST',
    headers: { Authorization: authToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId,
      // Capacidades de archivo únicamente — B2 no permite combinar bucketId
      // con capacidades de cuenta (listBuckets, writeKeys, etc.).
      capabilities: ['listFiles', 'readFiles', 'writeFiles', 'deleteFiles'],
      keyName,
      bucketId,
      namePrefix,
    }),
  });
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const businessId = String(args.businessId || '').trim();
  const businessName = String(args.name || businessId).trim();

  if (!businessId) {
    console.error('Uso: node scripts/create-business-b2-key.js --businessId <uid> --name "<Nombre del negocio>"');
    process.exit(1);
  }

  const masterKeyId  = process.env.B2_MASTER_KEY_ID;
  const masterAppKey = process.env.B2_MASTER_APPLICATION_KEY;
  if (!masterKeyId || !masterAppKey) {
    console.error(
      'Faltan B2_MASTER_KEY_ID / B2_MASTER_APPLICATION_KEY en tu .env.\n' +
      'Agrega la Master Application Key de tu cuenta de Backblaze (Account → App Keys)\n' +
      'o una key con capacidad "writeKeys" para poder generar llaves restringidas.'
    );
    process.exit(1);
  }

  console.log('Autorizando con la llave maestra de B2...');
  const auth = await authorizeAccount(masterKeyId, masterAppKey);
  const apiUrl     = auth.apiInfo?.storageApi?.apiUrl     || auth.apiUrl;
  const s3Endpoint = auth.apiInfo?.storageApi?.s3ApiUrl   || auth.s3ApiUrl || process.env.R2_ENDPOINT;
  const accountId  = auth.accountId;

  console.log(`Buscando el bucket "${BUCKET_NAME}"...`);
  const bucketId = await findBucketId(apiUrl, auth.authorizationToken, accountId, BUCKET_NAME);

  const keyName = `tecnocaja-${businessId}`.slice(0, 100).replace(/[^a-zA-Z0-9-]/g, '-');
  console.log(`Creando llave restringida a backups/${businessId}/ ...`);
  const key = await createRestrictedKey({
    apiUrl, authToken: auth.authorizationToken, accountId, bucketId, businessId, keyName,
  });

  console.log('\n✅ Llave creada correctamente para:', businessName, `(businessId: ${businessId})`);
  console.log('\nAgrega esto al .env de esa instalación (config/app.env en su carpeta de AppData):\n');
  console.log(`R2_ACCESS_KEY_ID=${key.applicationKeyId}`);
  console.log(`R2_SECRET_ACCESS_KEY=${key.applicationKey}`);
  console.log(`R2_BUCKET=${BUCKET_NAME}`);
  console.log(`R2_ENDPOINT=${s3Endpoint}`);
  console.log(`TECNO_CAJA_LICENSE_UID=${businessId}`);
  console.log('\n⚠️  Guarda "applicationKey" ahora — Backblaze no la vuelve a mostrar después de este momento.');
})().catch(e => {
  console.error('\n❌ Error:', e.message);
  process.exit(1);
});
