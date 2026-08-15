'use strict';

const crypto = require('crypto');
const forge = require('node-forge');
const { KeyManagementServiceClient } = require('@google-cloud/kms');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const {
  callerContext,
  processRef,
  publicProcess,
} = require('./certification');

const MAX_CERTIFICATE_BYTES = 60 * 1024;
const kmsClient = new KeyManagementServiceClient();

function kmsKeyName() {
  if (process.env.ECF_KMS_KEY_NAME) return process.env.ECF_KMS_KEY_NAME;
  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'reporte-sistema-pos';
  return kmsClient.cryptoKeyPath(project, 'global', 'tecno-caja-fiscal', 'certificate-vault');
}

function parseAndValidateP12(buffer, password) {
  let p12;
  try {
    const der = forge.util.createBuffer(buffer.toString('binary'));
    const asn1 = forge.asn1.fromDer(der);
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch (_) {
    throw new HttpsError('invalid-argument', 'El certificado o su contraseña no son válidos.');
  }

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
  ];
  const certificate = certBags.find((bag) => bag.cert)?.cert;
  const privateKey = keyBags.find((bag) => bag.key)?.key;
  if (!certificate || !privateKey) {
    throw new HttpsError('invalid-argument', 'El archivo debe contener el certificado y su clave privada.');
  }

  const now = new Date();
  if (now < certificate.validity.notBefore || now > certificate.validity.notAfter) {
    throw new HttpsError('failed-precondition', 'El certificado digital está vencido o todavía no es válido.');
  }

  const attributes = Object.fromEntries(
    certificate.subject.attributes.map((item) => [item.shortName || item.name, item.value])
  );
  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes();
  const fingerprint = crypto.createHash('sha256').update(Buffer.from(certDer, 'binary')).digest('hex');
  return {
    subject: attributes.CN || certificate.subject.attributes.map((item) => item.value).join(', '),
    issuer: certificate.issuer.attributes.map((item) => item.value).join(', '),
    serialNumber: certificate.serialNumber,
    validFrom: certificate.validity.notBefore.toISOString(),
    validTo: certificate.validity.notAfter.toISOString(),
    fingerprintSha256: fingerprint,
  };
}

async function encrypt(plaintext) {
  const [response] = await kmsClient.encrypt({
    name: kmsKeyName(),
    plaintext: Buffer.from(plaintext),
  });
  if (!response.ciphertext) throw new Error('KMS no devolvió el texto cifrado.');
  return Buffer.from(response.ciphertext).toString('base64');
}

const uploadEcfCertificate = onCall(
  { cors: true, memory: '512MiB', timeoutSeconds: 60 },
  async (request) => {
    const { db, uid, businessId } = await callerContext(request, { adminOnly: true });
    const fileName = String(request.data?.fileName || 'certificado.p12').trim();
    const password = String(request.data?.password || '');
    const base64 = String(request.data?.certificateBase64 || '');
    if (!password || !base64 || !/\.(p12|pfx)$/i.test(fileName)) {
      throw new HttpsError('invalid-argument', 'Selecciona un certificado .p12/.pfx e indica su contraseña.');
    }

    let certificateBuffer;
    try {
      certificateBuffer = Buffer.from(base64, 'base64');
    } catch (_) {
      throw new HttpsError('invalid-argument', 'El contenido del certificado no es válido.');
    }
    if (!certificateBuffer.length || certificateBuffer.length > MAX_CERTIFICATE_BYTES) {
      throw new HttpsError('invalid-argument', 'El certificado debe pesar menos de 60 KB.');
    }

    const processSnap = await processRef(db, businessId).get();
    if (!processSnap.exists) {
      throw new HttpsError('failed-precondition', 'Primero inicia el proceso de certificación e-CF.');
    }
    const metadata = parseAndValidateP12(certificateBuffer, password);
    const [encryptedP12, encryptedPassword] = await Promise.all([
      encrypt(certificateBuffer),
      encrypt(Buffer.from(password, 'utf8')),
    ]);

    const now = admin.firestore.FieldValue.serverTimestamp();
    const privateRef = db.collection('businesses').doc(businessId)
      .collection('privateFiscal').doc('certificate');
    const publicMetadata = {
      status: 'valid',
      fileName,
      subject: metadata.subject,
      issuer: metadata.issuer,
      serialNumber: metadata.serialNumber,
      validFrom: metadata.validFrom,
      validTo: metadata.validTo,
      fingerprintSha256: metadata.fingerprintSha256,
      updatedAt: now,
      updatedBy: uid,
    };
    const batch = db.batch();
    batch.set(privateRef, {
      encryptedP12,
      encryptedPassword,
      kmsKeyName: kmsKeyName(),
      ...publicMetadata,
    });
    batch.set(processRef(db, businessId), { certificate: publicMetadata, updatedAt: now }, { merge: true });
    batch.set(db.collection('businesses').doc(businessId).collection('auditLogs').doc(), {
      action: 'ecf_certificate_uploaded',
      module: 'ecf_certification',
      actorUid: uid,
      details: {
        fileName,
        subject: metadata.subject,
        validTo: metadata.validTo,
        fingerprintSha256: metadata.fingerprintSha256,
      },
      createdAt: now,
    });
    await batch.commit();

    certificateBuffer.fill(0);
    const saved = await processRef(db, businessId).get();
    return { ok: true, certificate: metadata, process: publicProcess(saved.data()) };
  }
);

module.exports = { uploadEcfCertificate, parseAndValidateP12, kmsKeyName };
