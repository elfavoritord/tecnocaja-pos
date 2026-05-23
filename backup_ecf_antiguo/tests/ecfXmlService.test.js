'use strict';

const crypto = require('crypto');
const forge = require('node-forge');

const { signXml, _internals } = require('../server/fiscal/ecfXmlService');
const {
  buildSeedXmlToSign,
  buildSeedXmlFromResponse,
  extractSeedDate
} = require('../server/fiscal/dgiiAuthService');

function generateTestCertificate() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date('2026-01-01T00:00:00.000Z');
  cert.validity.notAfter = new Date('2027-01-01T00:00:00.000Z');
  cert.setSubject([{ name: 'commonName', value: '101234567' }]);
  cert.setIssuer([{ name: 'commonName', value: '101234567' }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert, privateKey: keys.privateKey };
}

describe('ecfXmlService.signXml', () => {
  test('genera un XMLDSig verificable para la semilla DGII', () => {
    const { cert, privateKey } = generateTestCertificate();
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<SemillaModel xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema-instance">' +
      '<valor>1234567890</valor>' +
      '</SemillaModel>';

    const signedXml = signXml(xml, cert, privateKey);
    const digestValueMatch = signedXml.match(/<DigestValue>([^<]+)<\/DigestValue>/i);
    const signatureValueMatch = signedXml.match(/<SignatureValue>([^<]+)<\/SignatureValue>/i);
    const signedInfoMatch = signedXml.match(/(<SignedInfo[\s\S]*?<\/SignedInfo>)/i);

    expect(digestValueMatch?.[1]).toBeTruthy();
    expect(signatureValueMatch?.[1]).toBeTruthy();
    expect(signedInfoMatch?.[1]).toBeTruthy();
    expect(signedXml).toContain('Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"');
    expect((signedXml.match(/<\?xml/g) || []).length).toBe(1);
    expect(signedXml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);

    const doc = _internals.parseXmlDocument(signedXml);
    const canonicalDocument = _internals.canonicalizeNode(doc.documentElement, { excludeSignature: true });
    const recomputedDigest = crypto.createHash('sha256').update(canonicalDocument, 'utf8').digest('base64');
    expect(digestValueMatch[1]).toBe(recomputedDigest);

    const canonicalSignedInfo = _internals.canonicalizeNode(_internals.parseXmlDocument(signedInfoMatch[1]).documentElement);
    const md = forge.md.sha256.create();
    md.update(canonicalSignedInfo, 'utf8');
    const signatureBytes = forge.util.decode64(signatureValueMatch[1]);
    expect(cert.publicKey.verify(md.digest().bytes(), signatureBytes)).toBe(true);
  });
});

describe('dgiiAuthService semilla helpers', () => {
  test('construye la semilla con fecha para cumplir el XSD oficial de DGII', () => {
    const xml = buildSeedXmlToSign('1234567890', '2026-05-19T08:00:00-04:00');

    expect(xml).toContain('<valor>1234567890</valor>');
    expect(xml).toContain('<fecha>2026-05-19T08:00:00-04:00</fecha>');
    expect(xml).toContain('<SemillaModel');
  });

  test('reutiliza el XML de semilla real cuando DGII lo devuelve escapado dentro de <string>', () => {
    const wrappedResponse =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<string xmlns="http://tempuri.org/">' +
      '&lt;?xml version="1.0" encoding="UTF-8"?&gt;' +
      '&lt;SemillaModel xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"&gt;' +
      '&lt;valor&gt;1234567890&lt;/valor&gt;' +
      '&lt;fecha&gt;2026-05-19T08:00:00-04:00&lt;/fecha&gt;' +
      '&lt;/SemillaModel&gt;' +
      '</string>';

    const seedDate = extractSeedDate(wrappedResponse);
    const xml = buildSeedXmlFromResponse(wrappedResponse, '1234567890', seedDate);

    expect(seedDate).toBe('2026-05-19T08:00:00-04:00');
    expect(xml).toContain('<SemillaModel');
    expect(xml).toContain('<valor>1234567890</valor>');
    expect(xml).toContain('<fecha>2026-05-19T08:00:00-04:00</fecha>');
    expect(xml).not.toContain('&lt;SemillaModel');
  });
});
