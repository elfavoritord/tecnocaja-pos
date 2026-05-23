'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');

const createDgiiRouter = require('../server/routes/dgiiRoutes');

function createQueryStub() {
  const calls = [];
  const state = {
    settings: [],
    logs: [],
    documents: []
  };

  async function query(sql, params = []) {
    calls.push({ sql, params });

    if (sql.includes('FROM config WHERE id = 1')) {
      return [{ business_id: 1, active_branch_id: 7, active_cash_register_id: 3 }];
    }
    if (sql.includes('FROM businesses WHERE id = ?')) {
      return [{
        id: 1,
        nombre: 'Tecno Caja POS',
        razon_social: 'Tecno Caja POS SRL',
        nombre_comercial: 'Tecno Caja',
        rnc: '101234567',
        direccion: 'Santo Domingo',
        telefono: '809-000-0000',
        correo: 'demo@tecnocaja.do'
      }];
    }
    if (sql.includes('FROM dgii_company_settings WHERE business_id = ?')) {
      return state.settings;
    }
    if (sql.includes('FROM fiscal_config WHERE business_id = ?')) {
      return [{ environment: 'test' }];
    }
    if (sql.includes('INSERT INTO dgii_request_log')) {
      state.logs.push(params);
      return { insertId: state.logs.length, rowsAffected: 1 };
    }
    if (sql.includes('UPDATE dgii_request_log')) {
      return { rowsAffected: 1 };
    }
    if (sql.includes('INSERT INTO dgii_received_documents')) {
      state.documents.push(params);
      return { insertId: state.documents.length, rowsAffected: 1 };
    }
    if (sql.includes('INSERT INTO fiscal_audit_log')) {
      return { insertId: 1, rowsAffected: 1 };
    }
    if (sql.includes('INSERT INTO `dgii_company_settings`')) {
      state.settings = [{
        business_id: 1,
        internal_token_hash: null,
        require_internal_token: 0
      }];
      return { insertId: 1, rowsAffected: 1 };
    }
    if (sql.includes('UPDATE `dgii_company_settings`')) {
      return { rowsAffected: 1 };
    }
    if (sql.includes('UPDATE dgii_company_settings')) {
      return { rowsAffected: 1 };
    }

    return [];
  }

  return { query, calls, state };
}

describe('dgiiRoutes', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tecnocaja-dgii-'));
    process.env.DGII_STORAGE_DIR = tempDir;
    process.env.DGII_REQUIRE_INTERNAL_TOKEN = 'false';
    delete process.env.DGII_INTERNAL_TOKEN;
    delete process.env.DGII_INTERNAL_TOKEN_HASH;
    delete process.env.DGII_FORWARD_SEMILLA_URL_TEST;
    delete process.env.DGII_FORWARD_SEMILLA_URL_CERTIFICACION;
    delete process.env.DGII_FORWARD_SEMILLA_URL_PRODUCCION;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('recibe XML de e-CF, lo archiva y responde estado recibido', async () => {
    const stub = createQueryStub();
    const app = express();
    app.use(createDgiiRouter({ query: stub.query }));

    const xml = '<ECF><Encabezado><IdDoc><eNCF>E310000000001</eNCF></IdDoc><Emisor><RNCEmisor>101234567</RNCEmisor></Emisor></Encabezado></ECF>';
    const response = await request(app)
      .post('/fe/recepcion/api/ecf')
      .set('Content-Type', 'application/xml')
      .send(xml);

    expect(response.status).toBe(200);
    expect(response.body.estado).toBe('recibido');
    expect(response.body.encf).toBe('E310000000001');
    expect(response.body.archivo).toContain(path.join('recepcion'));
    expect(fs.existsSync(response.body.archivo)).toBe(true);
    expect(stub.state.documents).toHaveLength(1);
  });

  test('bloquea acceso si el token interno es obligatorio y no se envía', async () => {
    const stub = createQueryStub();
    process.env.DGII_REQUIRE_INTERNAL_TOKEN = 'true';
    process.env.DGII_INTERNAL_TOKEN = 'secreto-interno';

    const app = express();
    app.use(createDgiiRouter({ query: stub.query }));

    const response = await request(app)
      .get('/fe/autenticacion/api/semilla');

    expect(response.status).toBe(401);
    expect(response.body.codigo).toBe('TC-DGII-4001');
  });

  test('redacta datos sensibles al validar certificado por JSON', async () => {
    const stub = createQueryStub();
    const app = express();
    app.use(express.json());
    app.use(createDgiiRouter({
      query: stub.query,
      certificateService: {
        validateCertificate: jest.fn(() => ({
          valid: true,
          subject: 'CN=101234567',
          issuer: 'DGII Test',
          serialNumber: 'ABC123',
          validFrom: '2026-01-01T00:00:00.000Z',
          validTo: '2027-01-01T00:00:00.000Z',
          daysRemaining: 200,
          rncMatch: true,
          isExpired: false
        })),
        getCertificateStatus: jest.fn(async () => ({ hasCertificate: false }))
      }
    }));

    const response = await request(app)
      .post('/fe/autenticacion/api/validacioncertificado')
      .set('Content-Type', 'application/json')
      .send({
        certificateMode: 'p12',
        certificateBase64: Buffer.from('fake-p12-binary').toString('base64'),
        certificatePassword: 'super-clave'
      });

    expect(response.status).toBe(200);
    expect(response.body.estado).toBe('validado_localmente');

    const insertedLog = stub.state.logs.find((params) => params[4] === 'validacion_certificado');
    expect(insertedLog).toBeDefined();
    expect(insertedLog[15]).toContain('[REDACTED]');
    expect(insertedLog[15]).not.toContain('super-clave');
    expect(insertedLog[15]).not.toContain('ZmFrZS1wMTItYmluYXJ5');
  });
});
