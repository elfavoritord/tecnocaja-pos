const crypto = require('crypto');
const https = require('https');
const fs = require('fs');

const key = JSON.parse(fs.readFileSync('./firebase-key.json', 'utf8'));
const PROJECT = key.project_id;
const CLIENT_EMAIL = key.client_email;
const PRIVATE_KEY = key.private_key;

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function makeJWT() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iss: CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })));
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = base64url(sign.sign(PRIVATE_KEY));
  return `${header}.${payload}.${sig}`;
}

function post(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function postAuth(token, path, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: 'firestore.googleapis.com', path, method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  // 1. Obtener access token
  const jwt = makeJWT();
  const tokenRes = await post('oauth2.googleapis.com', '/token',
    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  );
  // Overrride content-type for form
  const tokenData = JSON.parse(tokenRes.body);
  if (!tokenData.access_token) {
    console.error('Error obteniendo token:', tokenRes.body);
    process.exit(1);
  }
  const token = tokenData.access_token;
  console.log('Token obtenido.');

  const base = `/v1/projects/${PROJECT}/databases/(default)/collectionGroups/pedidos_delivery/indexes`;

  const indexes = [
    {
      name: 'Pedidos activos (repartidorId + estado + creadoEn)',
      body: {
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'repartidorId', order: 'ASCENDING' },
          { fieldPath: 'estado',        order: 'ASCENDING' },
          { fieldPath: 'creadoEn',      order: 'DESCENDING' },
        ],
      },
    },
    {
      name: 'Historial (repartidorId + estado + actualizadoEn)',
      body: {
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'repartidorId',  order: 'ASCENDING' },
          { fieldPath: 'estado',         order: 'ASCENDING' },
          { fieldPath: 'actualizadoEn', order: 'DESCENDING' },
        ],
      },
    },
  ];

  for (const idx of indexes) {
    console.log(`\nCreando índice: ${idx.name}`);
    const res = await postAuth(token, base, idx.body);
    const parsed = JSON.parse(res.body);
    if (res.status === 200 || res.status === 201) {
      console.log('  Creado. Estado:', parsed.state ?? 'CREATING');
      console.log('  Nombre:', parsed.name);
    } else if (parsed.error?.status === 'ALREADY_EXISTS') {
      console.log('  Ya existe, omitiendo.');
    } else {
      console.error('  Error HTTP', res.status, res.body);
    }
  }

  console.log('\nListo. Los índices tardan 1-3 minutos en activarse en Firebase.');
}

main().catch(console.error);
