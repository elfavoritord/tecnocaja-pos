'use strict';

/**
 * Descifrado del certificado .p12 subido por certificate-vault.js y
 * extracción de {certificatePem, privateKeyPem} listos para firmar --
 * mismo parseo forge que modules/ecf/signature/signature.service.js:
 * loadCertificate (Desktop, solo lectura de referencia), pero partiendo de
 * un Buffer ya descifrado con KMS en vez de un archivo en disco. El .p12
 * descifrado nunca se persiste, solo vive en memoria de esta invocación.
 */

const forge = require('node-forge');
const { KeyManagementServiceClient } = require('@google-cloud/kms');
const { HttpsError } = require('firebase-functions/v2/https');
const { kmsKeyName } = require('../certificate-vault');

const kmsClient = new KeyManagementServiceClient();

async function kmsDecrypt(ciphertextBase64, keyName) {
  const [response] = await kmsClient.decrypt({
    name: keyName || kmsKeyName(),
    ciphertext: Buffer.from(ciphertextBase64, 'base64'),
  });
  if (!response.plaintext) throw new Error('KMS no devolvió el texto plano.');
  return Buffer.from(response.plaintext);
}

function extractPemsFromP12(p12Buffer, password) {
  const der = forge.util.createBuffer(p12Buffer.toString('binary'));
  const asn1 = forge.asn1.fromDer(der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
  ];
  const certificate = certBags.find((bag) => bag.cert)?.cert;
  const privateKey = keyBags.find((bag) => bag.key)?.key;
  if (!certificate || !privateKey) {
    throw new Error('El certificado descifrado no contiene certificado y clave privada.');
  }

  return {
    certificatePem: forge.pki.certificateToPem(certificate),
    privateKeyPem: forge.pki.privateKeyToPem(privateKey),
    validFrom: certificate.validity.notBefore,
    validTo: certificate.validity.notAfter,
  };
}

/** getCertificateForSigning(businessId) -> {certificatePem, privateKeyPem} */
async function getCertificateForSigning(businessId) {
  const admin = require('firebase-admin');
  const db = admin.firestore();
  const ref = db.collection('businesses').doc(businessId).collection('privateFiscal').doc('certificate');
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('failed-precondition', 'Esta empresa no tiene un certificado digital cargado (Certificación DGII).');
  }
  const data = snap.data();
  if (data.status !== 'valid') {
    throw new HttpsError('failed-precondition', 'El certificado digital de esta empresa no está válido.');
  }

  let p12Buffer;
  let password;
  try {
    [p12Buffer, password] = await Promise.all([
      kmsDecrypt(data.encryptedP12, data.kmsKeyName),
      kmsDecrypt(data.encryptedPassword, data.kmsKeyName),
    ]);
  } catch (error) {
    throw new HttpsError('internal', `No se pudo descifrar el certificado digital: ${error.message}`);
  }

  let pems;
  try {
    pems = extractPemsFromP12(p12Buffer, password.toString('utf8'));
  } catch (error) {
    throw new HttpsError('internal', `El certificado digital no se pudo leer: ${error.message}`);
  } finally {
    p12Buffer.fill(0);
    password.fill(0);
  }

  const now = new Date();
  if (now < pems.validFrom || now > pems.validTo) {
    throw new HttpsError('failed-precondition', 'El certificado digital está vencido o todavía no es válido.');
  }

  return { certificatePem: pems.certificatePem, privateKeyPem: pems.privateKeyPem };
}

module.exports = { getCertificateForSigning };
