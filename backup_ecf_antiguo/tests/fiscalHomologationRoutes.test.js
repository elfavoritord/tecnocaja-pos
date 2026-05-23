'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../server/fiscal/fiscalExtensions', () => ({
  ensureFiscalExtensions: jest.fn(async () => {}),
  writeFiscalAuditLog: jest.fn(async () => {})
}));

jest.mock('../server/fiscal/fiscalCertificateService', () => ({
  getCertificateStatus: jest.fn(async () => ({ hasCertificate: true })),
  validateStoredCertificate: jest.fn(),
  validateCertificate: jest.fn(),
  saveCertificateSecurely: jest.fn()
}));

jest.mock('../server/fiscal/dgiiAuthService', () => ({
  testConnection: jest.fn(),
  authenticateDGII: jest.fn(),
  fetchSeedXml: jest.fn()
}));

jest.mock('../server/fiscal/ncfSequenceService', () => ({
  ECF_TYPES: {
    E31: { label: 'Credito Fiscal', code: '31' },
    E32: { label: 'Consumidor Final', code: '32' }
  },
  listSequences: jest.fn(async () => []),
  createSequence: jest.fn(),
  updateSequence: jest.fn(),
  disableSequence: jest.fn()
}));

jest.mock('../server/fiscal/fiscalModeService', () => ({
  getFiscalMode: jest.fn(async () => ({
    isActive: false,
    status: 'no_configurado',
    environment: 'test',
    hasCertificate: true,
    certificateStatus: 'valido',
    hasRnc: true,
    hasActiveSequences: true
  })),
  setEnvironment: jest.fn(async (_, __, environment) => ({ ok: true, environment })),
  activateFiscalMode: jest.fn(async () => ({ ok: true })),
  deactivateFiscalMode: jest.fn(async () => ({ ok: true })),
  validateCanActivate: jest.fn(async () => ({ canActivate: true, reasons: [] }))
}));

jest.mock('../server/fiscal/ecfSenderService', () => ({
  sendElectronicDocument: jest.fn(),
  getStatusByTrackId: jest.fn(),
  getDocumentState: jest.fn(),
  retryPendingDocuments: jest.fn(async () => [])
}));

jest.mock('../server/fiscal/homologationService', () => ({
  MANUAL_CHECK_KEYS: new Set(['print_representation']),
  getDgiiConfigBundle: jest.fn(),
  saveDgiiSettings: jest.fn(),
  rotateInternalToken: jest.fn(),
  recordTestRun: jest.fn(async () => {}),
  getRecentTestRuns: jest.fn(),
  getManualChecks: jest.fn(async () => []),
  saveManualCheck: jest.fn(),
  buildPublicUrls: jest.fn(),
  buildOfficialUrlsByEnvironment: jest.fn()
}));

const certSvc = require('../server/fiscal/fiscalCertificateService');
const authSvc = require('../server/fiscal/dgiiAuthService');
const homologationSvc = require('../server/fiscal/homologationService');
const createFiscalRouter = require('../server/routes/fiscal.routes');

function createQueryStub() {
  const calls = [];

  async function query(sql, params = []) {
    calls.push({ sql, params });

    if (sql.includes('FROM config WHERE id = 1')) {
      return [{ business_id: 1 }];
    }
    if (sql.includes('SELECT rnc FROM businesses WHERE id = ? LIMIT 1')) {
      return [{ rnc: '101234567' }];
    }
    if (sql.includes('SELECT environment FROM fiscal_config WHERE business_id = ? LIMIT 1')) {
      return [{ environment: 'test' }];
    }

    return [];
  }

  return { query, calls };
}

function createActor(overrides = {}) {
  return {
    id: 1,
    rol: 'Administrador',
    role_code: 'administrador_general',
    role_permissions: ['*'],
    ...overrides
  };
}

function createApp({ query, actor } = {}) {
  const stub = query || createQueryStub();
  const app = express();
  app.use(express.json());
  app.use('/api/fiscal', createFiscalRouter({
    query: stub.query,
    withTransaction: async (handler) => handler({ query: stub.query }),
    resolveRequestActorUser: async () => actor || createActor()
  }));
  return { app, stub };
}

describe('fiscal.routes homologation panel', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    homologationSvc.getDgiiConfigBundle.mockResolvedValue({
      business: { id: 1, rnc: '101234567', razon_social: 'Tecno Caja POS SRL' },
      fiscalConfig: {
        isActive: true,
        status: 'listo',
        environment: 'test',
        lastConnStatus: 'conectado',
        lastConnMsg: null,
        tokenExpiresAt: '2026-05-16T10:00:00.000Z'
      },
      certificate: {
        hasCertificate: true,
        subject: 'CN=101234567',
        issuer: 'DGII TEST',
        serialNumber: 'ABC123',
        validTo: '2027-05-16T00:00:00.000Z',
        isExpired: false,
        daysRemaining: 365
      },
      dgiiSettings: {
        environment: 'test',
        certificateMode: 'p12',
        rfceEnabled: false,
        publicBaseUrl: 'https://api.midominio.com',
        publicUrls: {
          recepcionUrl: 'https://api.midominio.com/fe/recepcion/api/ecf'
        },
        internalToken: {
          requireInternalToken: true,
          configured: true,
          hashPreview: 'abc123...zzz999'
        }
      },
      officialUrlsByEnvironment: {
        test: {
          auth: { baseUrl: 'https://ecf.dgii.gov.do/testecf/autenticacion' },
          ecf: { recepcionUrl: 'https://ecf.dgii.gov.do/testecf/recepcion/api/facturaselectronicas' },
          fc: { baseUrl: 'https://fc.dgii.gov.do/testecf' }
        }
      },
      recentTestRuns: [],
      checklist: {
        items: [
          { key: 'certificate_loaded', label: 'Certificado cargado', status: 'ok', message: 'Listo', source: 'local' }
        ],
        summary: { ok: 1, warning: 0, pending: 0, total: 1 }
      }
    });

    homologationSvc.rotateInternalToken.mockResolvedValue({
      ok: true,
      token: 'nuevo-token-seguro',
      maskedToken: 'nue********uro',
      internalToken: {
        requireInternalToken: true,
        configured: true,
        hashPreview: '12345678...abcdef'
      }
    });

    homologationSvc.saveManualCheck.mockResolvedValue({
      ok: true,
      checkKey: 'print_representation',
      status: 'ok',
      notes: 'Factura A4 validada'
    });

    certSvc.validateStoredCertificate.mockResolvedValue({
      valid: true,
      validTo: '2027-05-16T00:00:00.000Z',
      rncMatch: true
    });

    authSvc.fetchSeedXml.mockResolvedValue({
      environment: 'test',
      seedXml: '<Semilla>1234567890</Semilla>'
    });
  });

  test('devuelve el bundle DGII completo para la pantalla administrativa', async () => {
    const { app } = createApp();

    const response = await request(app).get('/api/fiscal/config/dgii');

    expect(response.status).toBe(200);
    expect(response.body.business.rnc).toBe('101234567');
    expect(response.body.dgiiSettings.publicBaseUrl).toBe('https://api.midominio.com');
    expect(response.body.checklist.summary.ok).toBe(1);
    expect(homologationSvc.getDgiiConfigBundle).toHaveBeenCalledWith(expect.any(Function), 1);
  });

  test('rota el token interno y devuelve el nuevo valor una sola vez', async () => {
    const { app } = createApp();

    const response = await request(app)
      .post('/api/fiscal/security/internal-token/rotate')
      .send({ requireInternalToken: true });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.token).toBe('nuevo-token-seguro');
    expect(homologationSvc.rotateInternalToken).toHaveBeenCalledWith(
      expect.any(Function),
      1,
      expect.objectContaining({ requireInternalToken: true, userId: 1 })
    );
  });

  test('valida el certificado almacenado y registra la prueba técnica', async () => {
    const { app } = createApp();

    const response = await request(app)
      .post('/api/fiscal/certificate/validate-stored')
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(certSvc.validateStoredCertificate).toHaveBeenCalledWith(expect.any(Function), 1, '101234567');
    expect(homologationSvc.recordTestRun).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        businessId: 1,
        testKey: 'certificate_validation',
        status: 'ok'
      })
    );
  });

  test('ejecuta la prueba de semilla y detecta el valor devuelto por DGII', async () => {
    const { app } = createApp();

    const response = await request(app)
      .post('/api/fiscal/dgii/test-seed')
      .send({ environment: 'test' });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.seedDetected).toBe(true);
    expect(response.body.seedPreview).toContain('12345678');
    expect(authSvc.fetchSeedXml).toHaveBeenCalledWith('test');
    expect(homologationSvc.recordTestRun).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        businessId: 1,
        testKey: 'seed',
        status: 'ok'
      })
    );
  });

  test('guarda el check manual de representación impresa', async () => {
    const { app } = createApp();

    const response = await request(app)
      .post('/api/fiscal/homologation/checklist/print_representation')
      .send({ status: 'ok', notes: 'Factura A4 validada' });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(homologationSvc.saveManualCheck).toHaveBeenCalledWith(
      expect.any(Function),
      1,
      'print_representation',
      { status: 'ok', notes: 'Factura A4 validada' },
      expect.objectContaining({ userId: 1 })
    );
  });

  test('bloquea la configuración fiscal a usuarios sin permiso', async () => {
    const { app } = createApp({
      actor: createActor({
        role_code: 'cajero',
        rol: 'Cajero',
        role_permissions: []
      })
    });

    const response = await request(app).get('/api/fiscal/config/dgii');

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/Sin permiso/i);
  });
});
