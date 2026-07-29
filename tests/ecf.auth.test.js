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

  test('un token cacheado de otro ambiente nunca se considera válido, aunque no haya expirado', async () => {
    await authService.authenticate({ forceRefresh: true });
    // El fixture de dgiiClient.validateSeed trae una fecha de expiración fija — se sobreescribe
    // aquí con una fecha futura real para que la prueba no dependa de cuándo se ejecute.
    authService.tokenCache.expiresAt = new Date(Date.now() + 3600000);
    expect(authService.isTokenValid()).toBe(true);

    // Simula un cambio de ambiente sin pasar por clearToken() (defensa en profundidad:
    // applyRuntimeConfig() en ecf.service.js ya llama clearToken(), pero el token cacheado
    // por sí solo nunca debe validarse contra un ambiente distinto al que fue emitido).
    authService.config = { ...authService.config, DGII_ENV: 'ecf' };
    expect(authService.isTokenValid()).toBe(false);
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
