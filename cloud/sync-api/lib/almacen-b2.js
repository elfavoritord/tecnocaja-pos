'use strict';

// Bucket de respaldos (Backblaze B2 por su API compatible con S3). La llave vive
// solo en este servicio (variables de Cloud Run); las PC reciben enlaces
// firmados de 5 minutos para un archivo de su carpeta.
//   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ENDPOINT
// (mismos nombres que usa el POS en r2-storage.js).

const VIGENCIA_ENLACE_S = 5 * 60;

function crearAlmacenB2(env = process.env) {
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || '').trim();
  const bucket = String(env.R2_BUCKET || '').trim();
  const endpoint = String(env.R2_ENDPOINT || '').trim();
  // Sin llave (pruebas, o el servicio sin configurar): las rutas responden 503.
  if (!accessKeyId || !secretAccessKey || !bucket || !endpoint) return null;
  const {
    S3Client, ListObjectsV2Command, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand,
  } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const region = (endpoint.match(/s3\.([^.]+)\.backblazeb2\.com/) || [])[1] || 'us-east-1';
  const s3 = new S3Client({
    region, endpoint, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });

  async function listar(prefijo) {
    const objetos = [];
    let token;
    do {
      const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefijo, MaxKeys: 1000, ContinuationToken: token }));
      (r.Contents || []).forEach((o) => objetos.push({ key: o.Key, size: Number(o.Size || 0), lastModified: o.LastModified ? new Date(o.LastModified).toISOString() : null }));
      token = r.IsTruncated ? r.NextContinuationToken : null;
    } while (token && objetos.length < 5000);
    return objetos;
  }

  // La huella va como metadato firmado: la PC tiene que mandar ese mismo
  // encabezado, y después se comprueba con verificar().
  async function urlSubida(key, sha256) {
    const comando = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: 'application/octet-stream', Metadata: { sha256 } });
    const url = await getSignedUrl(s3, comando, {
      expiresIn: VIGENCIA_ENLACE_S,
      signableHeaders: new Set(['content-type', 'x-amz-meta-sha256']),
      unhoistableHeaders: new Set(['x-amz-meta-sha256']),
    });
    return {
      url, metodo: 'PUT', expira: new Date(Date.now() + VIGENCIA_ENLACE_S * 1000).toISOString(),
      headers: { 'Content-Type': 'application/octet-stream', 'x-amz-meta-sha256': sha256 },
    };
  }

  async function urlBajada(key) {
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: VIGENCIA_ENLACE_S });
    return { url, expira: new Date(Date.now() + VIGENCIA_ENLACE_S * 1000).toISOString() };
  }

  async function verificar(key) {
    const r = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { size: Number(r.ContentLength || 0), sha256: r.Metadata?.sha256 || null };
  }

  async function borrar(key) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  return { listar, urlSubida, urlBajada, verificar, borrar };
}

module.exports = { crearAlmacenB2 };
