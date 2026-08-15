'use strict';

process.env.NODE_ENV = 'test';

const fs = require('fs');
const request = require('supertest');
const { SignedXml } = require('xml-crypto');
const { createTestP12, createTestP12Chain } = require('./helpers/test-cert');
const { loadCertificate } = require('../vendor/modules/ecf/signature/signature.service');

function sampleEcfXml({ rncEmisor = '130000001', rncComprador = '101000001', encf = 'E320000000005' } = {}) {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ECF>',
    '  <Encabezado>',
    '    <IdDoc><eNCF>' + encf + '</eNCF></IdDoc>',
    '    <Emisor><RNCEmisor>' + rncEmisor + '</RNCEmisor></Emisor>',
    '    <Comprador><RNCComprador>' + rncComprador + '</RNCComprador></Comprador>',
    '  </Encabezado>',
    '</ECF>',
  ].join('\n');
}

describe('Firma del ARECF', () => {
  let certPath;

  afterAll(() => {
    if (certPath && fs.existsSync(certPath)) fs.unlinkSync(certPath);
  });

  it('sin CERT_PATH configurado, responde el ARECF sin firmar (no se cae el servicio)', async () => {
    delete process.env.CERT_PATH;
    delete process.env.CERT_PASSWORD;
    jest.resetModules();
    const { createApp } = require('../lib/app');
    const { createMemoryStore } = require('../lib/store');
    const app = createApp({ store: createMemoryStore() });

    const res = await request(app)
      .post('/fe/recepcion/api/ecf')
      .set('Content-Type', 'application/xml')
      .send(sampleEcfXml({ encf: 'E320000000006' }));

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<Signature');
  });

  it('con CERT_PATH configurado, el ARECF viene firmado (XMLDSig enveloped)', async () => {
    const testCert = createTestP12();
    certPath = testCert.certPath;
    process.env.CERT_PATH = testCert.certPath;
    process.env.CERT_PASSWORD = testCert.certPassword;
    jest.resetModules();
    const { createApp } = require('../lib/app');
    const { createMemoryStore } = require('../lib/store');
    const app = createApp({ store: createMemoryStore() });

    const res = await request(app)
      .post('/fe/recepcion/api/ecf')
      .set('Content-Type', 'application/xml')
      .send(sampleEcfXml({ encf: 'E320000000007' }));

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Signature');
    expect(res.text).toContain('<SignatureValue>');
    expect(res.text).toContain('<X509Certificate>');
    expect(res.text).toContain('<Estado>0</Estado>');
    expect(res.text).toContain('<Reference URI="">');
    expect(res.text).not.toMatch(/<ARECF[^>]*\bId=/);

    // No basta con que existan las etiquetas — hay que confirmar que el
    // digest/firma son criptográficamente válidos con un verificador
    // independiente (esto fue justo lo que detectó el bug original: la
    // canonicalización propia generaba un digest que no coincidía).
    const testCertContext = loadCertificate({ certPath, certPassword: testCert.certPassword });
    const verifier = new SignedXml({ publicCert: testCertContext.certificatePem });
    verifier.loadSignature(res.text.match(/<Signature[\s\S]*<\/Signature>/)[0]);
    expect(verifier.checkSignature(res.text)).toBe(true);

    delete process.env.CERT_PATH;
    delete process.env.CERT_PASSWORD;
  }, 20000);

  it('con un .p12 que trae CA intermedia, el ARECF firma con el certificado hoja en KeyInfo', async () => {
    const testCert = createTestP12Chain();
    certPath = testCert.certPath;
    process.env.CERT_PATH = testCert.certPath;
    process.env.CERT_PASSWORD = testCert.certPassword;
    jest.resetModules();
    const { createApp } = require('../lib/app');
    const { createMemoryStore } = require('../lib/store');
    const app = createApp({ store: createMemoryStore() });

    const res = await request(app)
      .post('/fe/recepcion/api/ecf')
      .set('Content-Type', 'application/xml')
      .send(sampleEcfXml({ encf: 'E320000000008' }));

    expect(res.status).toBe(200);
    const certCount = (res.text.match(/<X509Certificate>/g) || []).length;
    expect(certCount).toBe(1);

    const testCertContext = loadCertificate({ certPath, certPassword: testCert.certPassword });
    const verifier = new SignedXml({ publicCert: testCertContext.certificatePem });
    verifier.loadSignature(res.text.match(/<Signature[\s\S]*<\/Signature>/)[0]);
    expect(verifier.checkSignature(res.text)).toBe(true);

    delete process.env.CERT_PATH;
    delete process.env.CERT_PASSWORD;
  }, 20000);
});
