'use strict';

/**
 * Cuando la DGII no entrega el token al validar la semilla, el error debe traer
 * su motivo (HTTP + mensaje) en vez de solo "no devolvió un token", y quedar
 * guardado en el historial de semillas.
 */

const { AuthService } = require('../modules/ecf/services/auth.service');

function buildAuth(respuesta) {
  const fallas = [];
  const auth = new AuthService({
    config: { DGII_ENV: 'ecf', DGII_SEMILLA_URL: 'https://x/semilla', DGII_VALIDAR_SEMILLA_URL: 'https://x/validar', TOKEN_DURATION: 3600 },
    dgiiClient: { validateSeed: async () => respuesta },
    signatureService: { signXML: () => '<SemillaModel/>', verifySignature: () => ({ ok: true }) },
    logger: { info() {}, warn() {}, error() {} },
    certificateResolver: async () => ({}),
    seedStorage: {
      markSigned: () => ({ id: 's1' }),
      markFailed: (entry) => { fallas.push(entry); },
      markAuthenticated: () => ({ id: 's1' }),
    },
  });
  auth.requestSeed = async () => ({ xml: '<SemillaModel/>', value: 'v', storage: { id: 's1' } });
  return { auth, fallas };
}

describe('motivo de la DGII al fallar la autenticación', () => {
  const log = console.log;
  beforeAll(() => { console.log = () => {}; });
  afterAll(() => { console.log = log; });

  test('JSON con errors: muestra HTTP y el mensaje de la DGII', async () => {
    const { auth, fallas } = buildAuth({
      token: '',
      raw: JSON.stringify({ title: 'Unauthorized', status: 401, errors: { Certificado: ['El certificado no está autorizado para este RNC'] } }),
      http: { status: 401 },
    });
    await expect(auth.authenticate({ forceRefresh: true }))
      .rejects.toThrow(/HTTP 401: Unauthorized · El certificado no está autorizado para este RNC/);
    expect(fallas[0].error).toMatch(/HTTP 401/);
  });

  test('texto o HTML: se limpia y se recorta', async () => {
    const { auth } = buildAuth({ token: '', raw: '<html><body><h1>403 Forbidden</h1></body></html>', http: { status: 403 } });
    await expect(auth.authenticate({ forceRefresh: true })).rejects.toThrow(/HTTP 403: 403 Forbidden\)/);
  });

  test('respuesta vacía', async () => {
    const { auth } = buildAuth({ token: '', raw: '', http: { status: 200 } });
    await expect(auth.authenticate({ forceRefresh: true })).rejects.toThrow(/HTTP 200, respuesta vacía/);
  });
});
