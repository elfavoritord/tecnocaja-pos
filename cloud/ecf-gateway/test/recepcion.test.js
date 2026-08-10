'use strict';

process.env.NODE_ENV = 'test';

const request = require('supertest');
const { createApp } = require('../lib/app');
const { createMemoryStore } = require('../lib/store');

function sampleEcfXml({ rncEmisor = '130000001', rncComprador = '101000001', encf = 'E320000000001' } = {}) {
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

describe('POST /fe/recepcion/api/ecf', () => {
  let app;

  beforeEach(() => {
    app = createApp({ store: createMemoryStore() });
  });

  it('acepta un e-CF válido y responde un ARECF con Estado 0', async () => {
    const res = await request(app)
      .post('/fe/recepcion/api/ecf')
      .set('Content-Type', 'application/xml')
      .send(sampleEcfXml());

    expect(res.status).toBe(200);
    expect(res.type).toBe('application/xml');
    expect(res.text).toContain('<ARECF>');
    expect(res.text).toContain('<Estado>0</Estado>');
    expect(res.text).toContain('<eNCF>E320000000001</eNCF>');
    expect(res.text).toContain('<RNCEmisor>130000001</RNCEmisor>');
  });

  it('rechaza un XML sin eNCF con Estado 1 y motivo de especificación', async () => {
    const badXml = '<?xml version="1.0"?><ECF><Encabezado></Encabezado></ECF>';
    const res = await request(app)
      .post('/fe/recepcion/api/ecf')
      .set('Content-Type', 'application/xml')
      .send(badXml);

    expect(res.status).toBe(400);
    expect(res.text).toContain('<Estado>1</Estado>');
    expect(res.text).toContain('<CodigoMotivoNoRecibido>1</CodigoMotivoNoRecibido>');
  });

  it('no duplica un mismo eNCF recibido dos veces y regenera el ARECF', async () => {
    const xml = sampleEcfXml({ encf: 'E320000000002' });

    const first = await request(app)
      .post('/fe/recepcion/api/ecf')
      .set('Content-Type', 'application/xml')
      .send(xml);

    const second = await request(app)
      .post('/fe/recepcion/api/ecf')
      .set('Content-Type', 'application/xml')
      .send(xml);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.text).toContain('<ARECF>');
    expect(second.text).toContain('<Estado>0</Estado>');
  });

  it('en duplicados no devuelve un ARECF legado guardado antes del fix', async () => {
    const store = createMemoryStore();
    app = createApp({ store });
    const xml = sampleEcfXml({ encf: 'E310000000003' });
    await store.save('ecf_gateway_received', '130000001_E310000000003', {
      businessId: 'test',
      rncEmisor: '130000001',
      rncComprador: '101000001',
      encf: 'E310000000003',
      receivedAt: new Date().toISOString(),
      xml,
      arecf: '<ARECF><legacy>sin-firma-vieja</legacy></ARECF>',
    });

    const res = await request(app)
      .post('/fe/recepcion/api/ecf')
      .set('Content-Type', 'application/xml')
      .send(xml);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('sin-firma-vieja');
    expect(res.text).toContain('<eNCF>E310000000003</eNCF>');
    expect(res.text).toContain('<Estado>0</Estado>');
  });

  it('acepta el mismo e-CF enviado como multipart/form-data (archivo adjunto)', async () => {
    const xml = sampleEcfXml({ encf: 'E320000000004' });
    const res = await request(app)
      .post('/fe/recepcion/api/ecf')
      .attach('xml', Buffer.from(xml, 'utf8'), 'documento.xml');

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Estado>0</Estado>');
    expect(res.text).toContain('<eNCF>E320000000004</eNCF>');
  });
});

describe('GET /fe/recepcion/api/ecf y /fe/aprobacioncomercial/api/ecf', () => {
  it('responden 200 en vez de 404 (chequeo de disponibilidad de DGII)', async () => {
    const app = createApp({ store: createMemoryStore() });
    const recepcion = await request(app).get('/fe/recepcion/api/ecf');
    const aprobacion = await request(app).get('/fe/aprobacioncomercial/api/ecf');
    expect(recepcion.status).toBe(200);
    expect(aprobacion.status).toBe(200);
  });
});
