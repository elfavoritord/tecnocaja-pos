'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { AuthService } = require('../modules/ecf/services/auth.service');
const { SeedStorageService } = require('../modules/ecf/services/seed-storage.service');

describe('auth.service', () => {
  let tempDir;
  let currentTime;
  let authService;
  let dgiiClient;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tecnocaja-auth-'));
    currentTime = new Date('2026-05-20T22:08:47.000Z');

    dgiiClient = {
      getSeed: jest.fn(async () => ({
        xml: '<SemillaModel><valor>ABC123</valor><fecha>2026-05-20T22:08:47</fecha></SemillaModel>',
        value: 'ABC123',
        fecha: '2026-05-20T22:08:47',
        raw: '<SemillaModel><valor>ABC123</valor></SemillaModel>',
      })),
      validateSeed: jest.fn(async () => ({
        token: 'TOKEN-123',
        expedido: '2026-05-20T22:09:00.000Z',
        expira: '2026-05-20T23:09:00.000Z',
        raw: '{"token":"TOKEN-123"}',
        http: { status: 200, body: '{"token":"TOKEN-123"}' },
      })),
    };

    const seedStorage = new SeedStorageService({
      baseDir: tempDir,
      now: () => new Date(currentTime),
    });

    authService = new AuthService({
      config: {
        DGII_ENV: 'testecf',
        DGII_SEMILLA_URL: 'https://dgii.local/semilla',
        DGII_VALIDAR_SEMILLA_URL: 'https://dgii.local/validar',
        TOKEN_DURATION: 3600,
      },
      dgiiClient,
      signatureService: {
        signXML: jest.fn(() => '<SemillaModel><valor>ABC123</valor><Signature/></SemillaModel>'),
        verifySignature: jest.fn(() => ({ ok: true, signatureValid: true })),
      },
      logger: { info() {}, warn() {}, error() {} },
      certificateResolver: jest.fn(async () => ({ certPath: 'fake-cert.p12', certPassword: '1234' })),
      seedStorage,
    });

    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    console.log.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('solicita una semilla nueva, la guarda y marca la autenticacion', async () => {
    const auth = await authService.authenticate({ forceRefresh: true });
    const state = authService.seedStorage.getState();
    const currentSeedPath = path.join(tempDir, 'storage', 'ecf', 'seeds', 'current-semilla.xml');

    expect(dgiiClient.getSeed).toHaveBeenCalledTimes(1);
    expect(dgiiClient.validateSeed).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(currentSeedPath)).toBe(true);
    expect(state.current).toMatchObject({
      environment: 'testecf',
      estado: 'autenticada',
      seedDetected: true,
      tokenDetected: true,
      hasSignedXml: true,
    });
    expect(auth.seedHistory).toMatchObject({
      estado: 'autenticada',
      tokenDetected: true,
    });
  });

  test('lanza error claro cuando DGII no devuelve xml de semilla', async () => {
    dgiiClient.getSeed.mockResolvedValueOnce({
      xml: '',
      value: '',
      fecha: null,
      raw: '',
    });

    await expect(authService.requestSeed()).rejects.toThrow('No se pudo obtener una nueva semilla desde DGII');
  });
});
