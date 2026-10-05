'use strict';

const ORIGINAL_SECRET = process.env.TECNO_CAJA_DEVICE_SECRET;

function freshModule() {
  jest.resetModules();
  return require('../../server/security/internal-request');
}

function fakeReq({ headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  return {
    headers,
    socket: { remoteAddress },
  };
}

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.TECNO_CAJA_DEVICE_SECRET;
  } else {
    process.env.TECNO_CAJA_DEVICE_SECRET = ORIGINAL_SECRET;
  }
});

describe('server/security/internal-request', () => {
  test('sin TECNO_CAJA_DEVICE_SECRET configurado, no firma ni verifica nada', () => {
    delete process.env.TECNO_CAJA_DEVICE_SECRET;
    const { buildInternalHeaders, verifyInternalRequest } = freshModule();

    expect(buildInternalHeaders()).toEqual({});
    expect(verifyInternalRequest(fakeReq())).toBe(false);
  });

  test('una petición firmada correctamente desde loopback es válida', () => {
    process.env.TECNO_CAJA_DEVICE_SECRET = 'a'.repeat(64);
    const { buildInternalHeaders, verifyInternalRequest } = freshModule();

    const headers = buildInternalHeaders();
    expect(Object.keys(headers).length).toBe(2);

    expect(verifyInternalRequest(fakeReq({ headers }))).toBe(true);
  });

  test('rechaza si la IP no es loopback', () => {
    process.env.TECNO_CAJA_DEVICE_SECRET = 'a'.repeat(64);
    const { buildInternalHeaders, verifyInternalRequest } = freshModule();

    const headers = buildInternalHeaders();
    expect(verifyInternalRequest(fakeReq({ headers, remoteAddress: '192.168.1.50' }))).toBe(false);
  });

  test('rechaza firma incorrecta (secreto equivocado / manipulada)', () => {
    process.env.TECNO_CAJA_DEVICE_SECRET = 'a'.repeat(64);
    const { buildInternalHeaders, verifyInternalRequest, HEADER_SIGNATURE } = freshModule();

    const headers = buildInternalHeaders();
    headers[HEADER_SIGNATURE] = 'f'.repeat(64);
    expect(verifyInternalRequest(fakeReq({ headers }))).toBe(false);
  });

  test('rechaza timestamp fuera de la ventana permitida (replay)', () => {
    process.env.TECNO_CAJA_DEVICE_SECRET = 'a'.repeat(64);
    const internalRequest = freshModule();
    const { verifyInternalRequest, HEADER_SIGNATURE, HEADER_TIMESTAMP } = internalRequest;

    const oldTimestamp = String(Date.now() - 10 * 60 * 1000); // 10 min atrás
    const crypto = require('crypto');
    const signature = crypto
      .createHmac('sha256', process.env.TECNO_CAJA_DEVICE_SECRET)
      .update(`tecno-caja-internal:${oldTimestamp}`)
      .digest('hex');

    expect(
      verifyInternalRequest(
        fakeReq({ headers: { [HEADER_SIGNATURE]: signature, [HEADER_TIMESTAMP]: oldTimestamp } })
      )
    ).toBe(false);
  });

  test('rechaza si faltan las cabeceras', () => {
    process.env.TECNO_CAJA_DEVICE_SECRET = 'a'.repeat(64);
    const { verifyInternalRequest } = freshModule();
    expect(verifyInternalRequest(fakeReq())).toBe(false);
  });

  test('dos secretos distintos no pueden validar la firma del otro', () => {
    process.env.TECNO_CAJA_DEVICE_SECRET = 'a'.repeat(64);
    const moduleA = freshModule();
    const headers = moduleA.buildInternalHeaders();

    process.env.TECNO_CAJA_DEVICE_SECRET = 'b'.repeat(64);
    const moduleB = freshModule();
    expect(moduleB.verifyInternalRequest(fakeReq({ headers }))).toBe(false);
  });
});
