'use strict';

process.env.NODE_ENV = 'test';

const fs = require('fs');
const request = require('supertest');
const { SignedXml } = require('xml-crypto');
const { createTestP12 } = require('./helpers/test-cert');
const { loadCertificate } = require('../vendor/modules/ecf/signature/signature.service');

const ADMIN_TOKEN = 'admin-token-123';
const RNC_EMILIO = '40211932609';
const RNC_CLIENTE = '131000001';
const RNC_OTRO = '132000002';

function sampleEcfXml({ rncEmisor = '130000001', rncComprador, encf }) {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ECF><Encabezado>',
    `<IdDoc><eNCF>${encf}</eNCF></IdDoc>`,
    `<Emisor><RNCEmisor>${rncEmisor}</RNCEmisor></Emisor>`,
    `<Comprador><RNCComprador>${rncComprador}</RNCComprador></Comprador>`,
    '</Encabezado></ECF>',
  ].join('');
}

function sampleAcecfXml({ rncEmisor, rncComprador = '101000001', encf }) {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ACECF><DetalleAprobacionComercial>',
    '<Version>1.0</Version>',
    `<RNCEmisor>${rncEmisor}</RNCEmisor>`,
    `<eNCF>${encf}</eNCF>`,
    `<RNCComprador>${rncComprador}</RNCComprador>`,
    '<Estado>1</Estado>',
    '</DetalleAprobacionComercial></ACECF>',
  ].join('');
}

// KMS falso: "cifra" dejando los bytes igual. Solo prueba el flujo.
function createFakeKms() {
  return {
    async encrypt({ plaintext }) {
      return [{ ciphertext: Buffer.from(plaintext) }];
    },
    async decrypt({ ciphertext }) {
      return [{ plaintext: Buffer.from(ciphertext) }];
    },
  };
}

function buildApp({ store, kms = createFakeKms() } = {}) {
  jest.resetModules();
  const { createApp } = require('../lib/app');
  const { createMemoryStore } = require('../lib/store');
  const usedStore = store || createMemoryStore();
  return { app: createApp({ store: usedStore, kms }), store: usedStore };
}

async function registrar(app, body) {
  return request(app)
    .post('/admin/tenants')
    .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
    .send(body);
}

function signedCertificate(xml) {
  const m = xml.match(/<X509Certificate>([^<]+)<\/X509Certificate>/);
  return m ? m[1].replace(/\s+/g, '') : null;
}

describe('Gateway multiempresa (misma URL, datos por empresa)', () => {
  const tempFiles = [];

  beforeEach(() => {
    process.env.GATEWAY_ADMIN_TOKEN = ADMIN_TOKEN;
    process.env.GATEWAY_DEFAULT_RNC = RNC_EMILIO;
    delete process.env.CERT_PATH;
    delete process.env.CERT_PASSWORD;
  });

  afterAll(() => {
    for (const file of tempFiles) fs.rmSync(file, { force: true });
    delete process.env.GATEWAY_DEFAULT_RNC;
    delete process.env.CERT_PATH;
    delete process.env.CERT_PASSWORD;
  });

  it('la empresa por defecto recibe sin registrarse y el admin la ve sin ?rnc=', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/fe/recepcion/api/ecf')
      .set('Content-Type', 'application/xml')
      .send(sampleEcfXml({ rncComprador: RNC_EMILIO, encf: 'E310000000001' }));
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Estado>0</Estado>');

    const list = await request(app).get('/admin/received').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(list.status).toBe(200);
    expect(list.body.rnc).toBe(RNC_EMILIO);
    expect(list.body.received.map((r) => r.encf)).toEqual(['E310000000001']);
    expect(list.body.received[0].tenantRnc).toBe(RNC_EMILIO);
  });

  it('rechaza con motivo 4 un e-CF para un RNC que no es cliente, y no lo guarda', async () => {
    const { app, store } = buildApp();
    const res = await request(app)
      .post('/fe/recepcion/api/ecf')
      .set('Content-Type', 'application/xml')
      .send(sampleEcfXml({ rncComprador: RNC_OTRO, encf: 'E310000000002' }));
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Estado>1</Estado>');
    expect(res.text).toContain('<CodigoMotivoNoRecibido>4</CodigoMotivoNoRecibido>');
    expect(await store.list(`ecf_gateway_tenants/${RNC_OTRO}/received`)).toEqual([]);
  });

  it('cada empresa solo ve sus documentos con su token', async () => {
    const { app } = buildApp();
    const alta = await registrar(app, { rnc: RNC_CLIENTE, nombre: 'Colmado Prueba' });
    expect(alta.status).toBe(201);
    expect(alta.body.token).toMatch(new RegExp(`^${RNC_CLIENTE}\\.[0-9a-f]{48}$`));
    expect(alta.body.tenant.tokenHash).toBeUndefined();
    const tokenCliente = alta.body.token;

    await request(app)
      .post('/fe/recepcion/api/ecf')
      .set('Content-Type', 'application/xml')
      .send(sampleEcfXml({ rncComprador: RNC_CLIENTE, encf: 'E310000000010' }));
    await request(app)
      .post('/fe/recepcion/api/ecf')
      .set('Content-Type', 'application/xml')
      .send(sampleEcfXml({ rncComprador: RNC_EMILIO, encf: 'E310000000011' }));

    const propia = await request(app).get('/admin/received').set('Authorization', `Bearer ${tokenCliente}`);
    expect(propia.status).toBe(200);
    expect(propia.body.rnc).toBe(RNC_CLIENTE);
    expect(propia.body.received.map((r) => r.encf)).toEqual(['E310000000010']);

    const ajena = await request(app)
      .get(`/admin/received?rnc=${RNC_EMILIO}`)
      .set('Authorization', `Bearer ${tokenCliente}`);
    expect(ajena.status).toBe(403);

    const deEmilio = await request(app).get('/admin/received').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(deEmilio.body.received.map((r) => r.encf)).toEqual(['E310000000011']);

    const delCliente = await request(app)
      .get(`/admin/received?rnc=${RNC_CLIENTE}`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(delCliente.body.received.map((r) => r.encf)).toEqual(['E310000000010']);
  });

  it('el token de empresa no administra empresas, y un token falso no entra', async () => {
    const { app } = buildApp();
    const { body } = await registrar(app, { rnc: RNC_CLIENTE, nombre: 'Colmado Prueba' });

    const lista = await request(app).get('/admin/tenants').set('Authorization', `Bearer ${body.token}`);
    expect(lista.status).toBe(403);

    const falso = await request(app)
      .get('/admin/received')
      .set('Authorization', `Bearer ${RNC_CLIENTE}.${'0'.repeat(48)}`);
    expect(falso.status).toBe(401);

    const admin = await request(app).get('/admin/tenants').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(admin.status).toBe(200);
    expect(admin.body.tenants).toHaveLength(1);
    expect(admin.body.tenants[0]).toMatchObject({ rnc: RNC_CLIENTE, nombre: 'Colmado Prueba', active: true, hasToken: true });
    expect(admin.body.tenants[0].tokenHash).toBeUndefined();
  });

  it('actualizar una empresa no cambia su token salvo con rotateToken', async () => {
    const { app } = buildApp();
    const alta = await registrar(app, { rnc: RNC_CLIENTE, nombre: 'Colmado Prueba' });
    const cambio = await registrar(app, { rnc: RNC_CLIENTE, nombre: 'Colmado Nuevo' });
    expect(cambio.status).toBe(200);
    expect(cambio.body.token).toBeNull();
    expect(cambio.body.tenant.nombre).toBe('Colmado Nuevo');

    const sigue = await request(app).get('/admin/received').set('Authorization', `Bearer ${alta.body.token}`);
    expect(sigue.status).toBe(200);

    const rotado = await registrar(app, { rnc: RNC_CLIENTE, rotateToken: true });
    expect(rotado.body.token).not.toBe(alta.body.token);
    const viejo = await request(app).get('/admin/received').set('Authorization', `Bearer ${alta.body.token}`);
    expect(viejo.status).toBe(401);
  });

  it('una empresa desactivada deja de recibir', async () => {
    const { app } = buildApp();
    await registrar(app, { rnc: RNC_CLIENTE, nombre: 'Colmado Prueba' });
    await registrar(app, { rnc: RNC_CLIENTE, active: false });
    const res = await request(app)
      .post('/fe/recepcion/api/ecf')
      .set('Content-Type', 'application/xml')
      .send(sampleEcfXml({ rncComprador: RNC_CLIENTE, encf: 'E310000000020' }));
    expect(res.text).toContain('<CodigoMotivoNoRecibido>4</CodigoMotivoNoRecibido>');
  });

  it('la aprobación comercial va a la empresa que emitió la factura', async () => {
    const { app } = buildApp();
    const { body } = await registrar(app, { rnc: RNC_CLIENTE, nombre: 'Colmado Prueba' });

    const ok = await request(app)
      .post('/fe/aprobacioncomercial/api/ecf')
      .set('Content-Type', 'application/xml')
      .send(sampleAcecfXml({ rncEmisor: RNC_CLIENTE, encf: 'E310000000030' }));
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('recibido');

    const ajena = await request(app)
      .post('/fe/aprobacioncomercial/api/ecf')
      .set('Content-Type', 'application/xml')
      .send(sampleAcecfXml({ rncEmisor: RNC_OTRO, encf: 'E310000000031' }));
    expect(ajena.status).toBe(400);

    const list = await request(app).get('/admin/received').set('Authorization', `Bearer ${body.token}`);
    expect(list.body.approvals.map((a) => a.encf)).toEqual(['E310000000030']);
    expect(list.body.approvals[0].rncComprador).toBe('101000001');
  });

  it('lo recibido antes del modo multiempresa sigue apareciendo para la empresa por defecto', async () => {
    jest.resetModules();
    const { createMemoryStore } = require('../lib/store');
    const store = createMemoryStore();
    await store.save('ecf_gateway_received', '130000001_E310000000040', {
      businessId: 'tecnocaja-emilio',
      rncEmisor: '130000001',
      rncComprador: RNC_EMILIO,
      encf: 'E310000000040',
      receivedAt: '2026-09-01T10:00:00.000Z',
    });
    const { app } = buildApp({ store });
    const { body } = await registrar(app, { rnc: RNC_CLIENTE, nombre: 'Colmado Prueba' });

    const deEmilio = await request(app).get('/admin/received').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(deEmilio.body.received.map((r) => r.encf)).toEqual(['E310000000040']);

    const delCliente = await request(app).get('/admin/received').set('Authorization', `Bearer ${body.token}`);
    expect(delCliente.body.received).toEqual([]);
  });

  it('firma el ARECF con el certificado de cada empresa, nunca con el de Emilio', async () => {
    const certEmilio = createTestP12();
    const certCliente = createTestP12();
    tempFiles.push(certEmilio.certPath, certCliente.certPath);
    process.env.CERT_PATH = certEmilio.certPath;
    process.env.CERT_PASSWORD = certEmilio.certPassword;

    const { app } = buildApp();
    const { body } = await registrar(app, { rnc: RNC_CLIENTE, nombre: 'Colmado Prueba' });

    // Sin certificado propio: sale SIN firmar, no con el de Emilio.
    const sinCert = await request(app)
      .post('/fe/recepcion/api/ecf')
      .set('Content-Type', 'application/xml')
      .send(sampleEcfXml({ rncComprador: RNC_CLIENTE, encf: 'E310000000050' }));
    expect(sinCert.status).toBe(200);
    expect(sinCert.text).not.toContain('<Signature');

    const malaClave = await request(app)
      .put(`/admin/tenants/${RNC_CLIENTE}/certificate`)
      .set('Authorization', `Bearer ${body.token}`)
      .field('password', 'clave-incorrecta')
      .attach('certificado', fs.readFileSync(certCliente.certPath), 'cliente.p12');
    expect(malaClave.status).toBe(400);

    // El POS del cliente sube su propio .p12 con su token.
    const subida = await request(app)
      .put(`/admin/tenants/${RNC_CLIENTE}/certificate`)
      .set('Authorization', `Bearer ${body.token}`)
      .field('password', certCliente.certPassword)
      .attach('certificado', fs.readFileSync(certCliente.certPath), 'cliente.p12');
    expect(subida.status).toBe(200);
    expect(subida.body.tenant.certificate.subject).toContain('Gateway Test Cert');
    expect(subida.body.tenant.certificate.encryptedP12).toBeUndefined();

    const contextoCliente = loadCertificate(certCliente);
    const contextoEmilio = loadCertificate(certEmilio);

    const cliente = await request(app)
      .post('/fe/recepcion/api/ecf')
      .set('Content-Type', 'application/xml')
      .send(sampleEcfXml({ rncComprador: RNC_CLIENTE, encf: 'E310000000051' }));
    expect(signedCertificate(cliente.text)).toBe(contextoCliente.certificateBase64);
    const verifier = new SignedXml({ publicCert: contextoCliente.certificatePem });
    verifier.loadSignature(cliente.text.match(/<Signature[\s\S]*<\/Signature>/)[0]);
    expect(verifier.checkSignature(cliente.text)).toBe(true);

    const emilio = await request(app)
      .post('/fe/recepcion/api/ecf')
      .set('Content-Type', 'application/xml')
      .send(sampleEcfXml({ rncComprador: RNC_EMILIO, encf: 'E310000000052' }));
    expect(signedCertificate(emilio.text)).toBe(contextoEmilio.certificateBase64);

    // Un cliente no puede subir certificado a nombre de otra empresa.
    const ajeno = await request(app)
      .put(`/admin/tenants/${RNC_EMILIO}/certificate`)
      .set('Authorization', `Bearer ${body.token}`)
      .field('password', certCliente.certPassword)
      .attach('certificado', fs.readFileSync(certCliente.certPath), 'cliente.p12');
    expect(ajeno.status).toBe(403);
  }, 60000);
});
