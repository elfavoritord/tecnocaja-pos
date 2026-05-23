'use strict';

const forge = require('node-forge');
const signatureService = require('../modules/ecf/signature/signature.service');

function createSelfSignedCertificate() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const attrs = [
    { name: 'commonName', value: 'Tecno Caja 101010101' },
    { name: 'organizationName', value: 'Tecno Caja SRL' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    certificate: cert,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    subject: 'CN=Tecno Caja 101010101,O=Tecno Caja SRL',
    issuer: 'CN=Tecno Caja 101010101,O=Tecno Caja SRL',
    serialNumber: cert.serialNumber,
    validFrom: cert.validity.notBefore,
    validTo: cert.validity.notAfter,
    certificateBase64: forge.pki.certificateToPem(cert)
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s+/g, ''),
  };
}

describe('signature.service', () => {
  test('firma y verifica un XML compatible con XMLDSig', () => {
    const cert = createSelfSignedCertificate();
    const xml = '<?xml version="1.0" encoding="UTF-8"?><ECF xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><Encabezado><IdDoc><eNCF>E310000000001</eNCF></IdDoc></Encabezado></ECF>';
    const signedXml = signatureService.signXML(xml, cert);
    const verification = signatureService.verifySignature(signedXml);

    expect(signedXml).toContain('<Signature ');
    expect(signedXml).toContain('<SignedInfo');
    expect(verification.ok).toBe(true);
    expect(verification.signatureValid).toBe(true);
    expect(verification.digestValid).toBe(true);
  });
});
