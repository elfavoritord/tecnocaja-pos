'use strict';

// Conexión automática de una empresa desde su POS (POST /self-service/connect):
// sin el token de administrador, probando que tiene el certificado.
process.env.NODE_ENV = 'test';

const fs = require('fs');
const request = require('supertest');
const { SignedXml } = require('xml-crypto');
const { createTestP12 } = require('./helpers/test-cert');
const { loadCertificate } = require('../vendor/modules/ecf/signature/signature.service');

const ADMIN_TOKEN = 'admin-token-123';
const RNC_EMILIO = '40211932609';
const RNC_CLIENTE = '133607336';

function createFakeKms() {
  return {
    async encrypt({ plaintext }) { return [{ ciphertext: Buffer.from(plaintext) }]; },
    async decrypt({ ciphertext }) { return [{ plaintext: Buffer.from(ciphertext) }]; },
  };
}

function buildApp() {
  jest.resetModules();
  process.env.GATEWAY_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.GATEWAY_DEFAULT_RNC = RNC_EMILIO;
  const { createApp } = require('../lib/app');
  const { createMemoryStore } = require('../lib/store');
  const store = createMemoryStore();
  return { app: createApp({ store, kms: createFakeKms() }), store };
}

const ecfPara = (rncComprador, encf) => [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<ECF><Encabezado>',
  `<IdDoc><eNCF>${encf}</eNCF></IdDoc>`,
  '<Emisor><RNCEmisor>130000001</RNCEmisor></Emisor>',
  `<Comprador><RNCComprador>${rncComprador}</RNCComprador></Comprador>`,
  '</Encabezado></ECF>',
].join('');

describe('Conexión automática (Paso 9 sin soporte)', () => {
  const temporales = [];
  afterAll(() => temporales.forEach((f) => { try { fs.unlinkSync(f); } catch (_) { /* ya no está */ } }));
  const certificado = () => { const c = createTestP12(); temporales.push(c.certPath); return c; };
  const cuerpo = (cert, extra = {}) => ({
    rnc: RNC_CLIENTE, nombre: 'Vicris & Asociados SRL',
    certificateBase64: fs.readFileSync(cert.certPath).toString('base64'), password: cert.certPassword, ...extra,
  });

  it('una empresa nueva queda registrada con su certificado y el acuse sale firmado', async () => {
    const { app, store } = buildApp();
    const cert = certificado();
    const r = await request(app).post('/self-service/connect').send(cuerpo(cert)).expect(201);
    expect(r.body.token).toMatch(new RegExp(`^${RNC_CLIENTE}\\.`));
    expect(r.body.tenant.certificate).toBeTruthy();
    expect((await store.findByKey('ecf_gateway_tenants', RNC_CLIENTE)).certificate).toBeTruthy();

    // DGII manda un e-CF a esa empresa: el acuse sale firmado con su certificado.
    const acuse = await request(app).post('/fe/recepcion/api/ecf').set('Content-Type', 'application/xml')
      .send(ecfPara(RNC_CLIENTE, 'E310000000002')).expect(200);
    const context = loadCertificate(cert);
    const verificador = new SignedXml({ publicCert: context.certificatePem, getCertFromKeyInfo: () => context.certificatePem });
    verificador.loadSignature(acuse.text.match(/<Signature[\s\S]*<\/Signature>/)[0]);
    expect(verificador.checkSignature(acuse.text)).toBe(true);

    // Con el código que recibió, el POS ve lo recibido de su empresa.
    const recibidos = await request(app).get('/admin/received').set('Authorization', `Bearer ${r.body.token}`).expect(200);
    expect(recibidos.body.received.map((d) => d.encf || d.eNCF)).toContain('E310000000002');
  }, 60000);

  it('con el mismo certificado se puede volver a conectar (código nuevo; el viejo deja de servir)', async () => {
    const { app } = buildApp();
    const cert = certificado();
    const primera = await request(app).post('/self-service/connect').send(cuerpo(cert)).expect(201);
    const segunda = await request(app).post('/self-service/connect').send(cuerpo(cert)).expect(200);
    expect(segunda.body.token).not.toBe(primera.body.token);
    await request(app).get('/admin/received').set('Authorization', `Bearer ${primera.body.token}`).expect(401);
    await request(app).get('/admin/received').set('Authorization', `Bearer ${segunda.body.token}`).expect(200);
  }, 60000);

  it('una empresa ya conectada con otro certificado no se puede tomar', async () => {
    const { app } = buildApp();
    await request(app).post('/self-service/connect').send(cuerpo(certificado())).expect(201);
    const intento = await request(app).post('/self-service/connect').send(cuerpo(certificado())).expect(409);
    expect(intento.body.code).toBe('OTRO_CERTIFICADO');
    expect(intento.body.token).toBeUndefined();
  }, 60000);

  it('registrada por soporte sin certificado: la conexión automática la completa', async () => {
    const { app } = buildApp();
    await request(app).post('/admin/tenants').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send({ rnc: RNC_CLIENTE }).expect(201);
    await request(app).post('/self-service/connect').send(cuerpo(certificado())).expect(200);
  }, 60000);

  it('no acepta clave mala, RNC inválido ni la empresa por defecto', async () => {
    const { app } = buildApp();
    const cert = certificado();
    await request(app).post('/self-service/connect').send(cuerpo(cert, { password: 'mala' })).expect(400);
    await request(app).post('/self-service/connect').send(cuerpo(cert, { rnc: '123' })).expect(400);
    await request(app).post('/self-service/connect').send(cuerpo(cert, { rnc: RNC_EMILIO })).expect(403);
  }, 60000);
});
