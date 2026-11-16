'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Conexión del certificado local al gateway', () => {
  let directory;
  let original;
  let connection;
  let certificate;
  const rnc = '132967161';
  const token = `${rnc}.codigo-exclusivo`;
  beforeEach(() => {
    original = process.env.TECNO_CAJA_USER_DATA;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-connect-'));
    process.env.TECNO_CAJA_USER_DATA = directory;
    connection = require('../modules/ecf/services/gateway-connection');
    const certPath = path.join(directory, 'test.p12');
    fs.writeFileSync(certPath, 'certificate-test');
    certificate = { certPath, certPassword: 'private-password' };
  });
  afterEach(() => {
    if (original === undefined) delete process.env.TECNO_CAJA_USER_DATA;
    else process.env.TECNO_CAJA_USER_DATA = original;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  it('usa solo la URL de confianza y conserva el token cifrado fuera del programa', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ tenant: { rnc, certificate: { validTo: '2027-01-01' } } }) });
    await connection.connectGateway({ certificate, rnc, token, fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe(`${connection.GATEWAY_URL}/admin/tenants/${rnc}/certificate`);
    const options = fetchImpl.mock.calls[0][1];
    expect(options.redirect).toBe('error');
    expect(JSON.parse(options.body).password).toBe(certificate.certPassword);
    expect(connection.readConnection()).toEqual({ rnc, token, base: connection.GATEWAY_URL });
    const saved = fs.readFileSync(path.join(directory, 'storage/ecf/gateway-connection.json'), 'utf8');
    expect(saved).not.toContain(token);
    expect(saved).not.toContain(certificate.certPassword);
  });
  it('rechaza un código de otra empresa antes de enviar el certificado', async () => {
    const fetchImpl = jest.fn();
    await expect(connection.connectGateway({ certificate, rnc, token: '101000001.other', fetchImpl })).rejects.toThrow('RNC');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('no guarda una conexión si el gateway rechaza el certificado', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'No autorizado' }) });
    await expect(connection.connectGateway({ certificate, rnc, token, fetchImpl })).rejects.toThrow('No autorizado');
    expect(connection.readConnection()).toBeNull();
  });
  it('Paso 9 automático: sin código, registra la empresa con su certificado y guarda el código cifrado', async () => {
    const nuevo = `${rnc}.codigo-automatico`;
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ ok: true, rnc, created: true, token: nuevo, tenant: { rnc, certificate: { validTo: '2027-05-11' } } }) });
    const result = await connection.connectGateway({ certificate, rnc, nombre: 'Vicris & Asociados SRL', fetchImpl });
    expect(result).toMatchObject({ ok: true, automatic: true, created: true });
    expect(fetchImpl.mock.calls[0][0]).toBe(`${connection.GATEWAY_URL}/self-service/connect`);
    const enviado = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(enviado).toMatchObject({ rnc, nombre: 'Vicris & Asociados SRL', password: certificate.certPassword });
    expect(connection.readConnection()).toEqual({ rnc, token: nuevo, base: connection.GATEWAY_URL });
    const saved = fs.readFileSync(path.join(directory, 'storage/ecf/gateway-connection.json'), 'utf8');
    expect(saved).not.toContain(nuevo);
    expect(saved).not.toContain(certificate.certPassword);
  });
  it('si la empresa ya está con otro certificado, muestra el error del receptor', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'Esta empresa ya está conectada con otro certificado.', code: 'OTRO_CERTIFICADO' }) });
    await expect(connection.connectGateway({ certificate, rnc, fetchImpl })).rejects.toThrow('otro certificado');
    expect(connection.readConnection()).toBeNull();
  });
  it('si el receptor no responde, intenta por la nube (1.6.25–1.6.26) y no vuelve a subir el mismo certificado', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('sin red'));
    const cloudConnection = { request: jest.fn().mockResolvedValue({ ok: true, rnc, fingerprintSha256: 'leaf-fingerprint', validTo: '2027-01-01' }) };
    await connection.connectGateway({ certificate, rnc, cloudConnection, fetchImpl });
    await connection.connectGateway({ certificate, rnc, cloudConnection, fetchImpl });
    expect(cloudConnection.request).toHaveBeenCalledTimes(1);
    expect(connection.readConnection()).toMatchObject({ mode: 'broker', rnc });
    const saved = fs.readFileSync(path.join(directory, 'storage/ecf/gateway-connection.json'), 'utf8');
    expect(saved).not.toContain(certificate.certPassword);
    expect(saved).not.toContain('certificate-test');
  });
  it('la lista de recepción no se cae si la nube no responde', async () => {
    const file = path.join(directory, 'storage/ecf/gateway-connection.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mode: 'broker', rnc, fingerprintSha256: 'x', p12Sha256: 'y' }));
    const envBefore = { base: process.env.ECF_GATEWAY_BASE_URL, token: process.env.ECF_GATEWAY_TOKEN, admin: process.env.ECF_GATEWAY_ADMIN_TOKEN };
    delete process.env.ECF_GATEWAY_BASE_URL; delete process.env.ECF_GATEWAY_TOKEN; delete process.env.ECF_GATEWAY_ADMIN_TOKEN;
    try {
      const { fetchGatewayReceived } = require('../server/routes/dgii-public.routes');
      // Sin negocio elegido, la conexión de la nube lanza: debe volver vacío, no tumbar la lista.
      await expect(fetchGatewayReceived()).resolves.toEqual({ received: [], approvals: [] });
      fs.writeFileSync(file, '{ dañado');
      await expect(fetchGatewayReceived()).resolves.toEqual({ received: [], approvals: [] });
    } finally {
      for (const [k, v] of [['ECF_GATEWAY_BASE_URL', envBefore.base], ['ECF_GATEWAY_TOKEN', envBefore.token], ['ECF_GATEWAY_ADMIN_TOKEN', envBefore.admin]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});
