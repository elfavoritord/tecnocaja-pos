'use strict';

// Genera un certificado autofirmado desechable SOLO para pruebas — nunca el
// certificado real de Emilio. Empaqueta un .p12 temporal y devuelve su ruta.

const fs = require('fs');
const os = require('os');
const path = require('path');
const forge = require('node-forge');

function createTestP12() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const attrs = [{ name: 'commonName', value: 'Gateway Test Cert' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const password = 'test-password';
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, {
    algorithm: '3des',
  });
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes();

  const certPath = path.join(os.tmpdir(), `ecf-gateway-test-cert-${Date.now()}.p12`);
  fs.writeFileSync(certPath, Buffer.from(p12Der, 'binary'));

  return { certPath, certPassword: password };
}

// Igual que createTestP12(), pero con una CA intermedia real en el .p12 —
// para probar que loadCertificate() arma la cadena completa (hoja + CA), no
// solo la hoja. Ver el bug real: DGII rechazó el ARECF con "Error de Firma
// Digital" porque el .p12 de Emilio trae hoja+intermedia+raíz pero solo se
// firmaba con la hoja, dejando al verificador de DGII sin forma de construir
// la cadena de confianza.
function createTestP12Chain() {
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = '01';
  caCert.validity.notBefore = new Date();
  caCert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const caAttrs = [{ name: 'commonName', value: 'Gateway Test CA' }];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([{ name: 'basicConstraints', cA: true }]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const leafKeys = forge.pki.rsa.generateKeyPair(2048);
  const leafCert = forge.pki.createCertificate();
  leafCert.publicKey = leafKeys.publicKey;
  leafCert.serialNumber = '02';
  leafCert.validity.notBefore = new Date();
  leafCert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  leafCert.setSubject([{ name: 'commonName', value: 'Gateway Test Leaf' }]);
  leafCert.setIssuer(caAttrs);
  leafCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const password = 'test-password';
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(leafKeys.privateKey, [leafCert, caCert], password, {
    algorithm: '3des',
  });
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes();

  const certPath = path.join(os.tmpdir(), `ecf-gateway-test-chain-${Date.now()}.p12`);
  fs.writeFileSync(certPath, Buffer.from(p12Der, 'binary'));

  return { certPath, certPassword: password };
}

module.exports = { createTestP12, createTestP12Chain };
