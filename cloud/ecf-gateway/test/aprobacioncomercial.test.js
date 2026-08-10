'use strict';

process.env.NODE_ENV = 'test';
process.env.GATEWAY_ADMIN_TOKEN = 'test-token-123';

const request = require('supertest');
const { createApp } = require('../lib/app');
const { createMemoryStore } = require('../lib/store');

function sampleAcecfXml({ rncEmisor = '130000001', encf = 'E320000000001', estado = '1' } = {}) {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ACECF>',
    '  <DetalleAprobacionComercial>',
    '    <Version>1.0</Version>',
    `    <RNCEmisor>${rncEmisor}</RNCEmisor>`,
    `    <eNCF>${encf}</eNCF>`,
    `    <Estado>${estado}</Estado>`,
    '  </DetalleAprobacionComercial>',
    '</ACECF>',
  ].join('\n');
}

describe('POST /fe/aprobacioncomercial/api/ecf', () => {
  let app;
  let store;

  beforeEach(() => {
    store = createMemoryStore();
    app = createApp({ store });
  });

  it('acepta una aprobación comercial válida', async () => {
    const res = await request(app)
      .post('/fe/aprobacioncomercial/api/ecf')
      .set('Content-Type', 'application/xml')
      .send(sampleAcecfXml());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('recibido');
    expect(res.body.encf).toBe('E320000000001');
  });

  it('rechaza cuando falta RNCEmisor o eNCF', async () => {
    const res = await request(app)
      .post('/fe/aprobacioncomercial/api/ecf')
      .set('Content-Type', 'application/xml')
      .send('<?xml version="1.0"?><ACECF></ACECF>');

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('error');
  });

  it('GET /admin/received requiere el bearer token correcto', async () => {
    await request(app)
      .post('/fe/aprobacioncomercial/api/ecf')
      .set('Content-Type', 'application/xml')
      .send(sampleAcecfXml({ encf: 'E320000000003' }));

    const unauthorized = await request(app).get('/admin/received');
    expect(unauthorized.status).toBe(401);

    const authorized = await request(app)
      .get('/admin/received')
      .set('Authorization', 'Bearer test-token-123');
    expect(authorized.status).toBe(200);
    expect(authorized.body.approvals.length).toBe(1);
    expect(authorized.body.approvals[0].encf).toBe('E320000000003');
  });
});
