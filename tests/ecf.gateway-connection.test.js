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
  it('conecta automáticamente sin pedir un código y no vuelve a subir el mismo certificado', async () => {
    const cloudConnection = { request: jest.fn().mockResolvedValue({ ok: true, rnc, fingerprintSha256: 'leaf-fingerprint', validTo: '2027-01-01' }) };
    await connection.connectGateway({ certificate, rnc, cloudConnection });
    await connection.connectGateway({ certificate, rnc, cloudConnection });
    expect(cloudConnection.request).toHaveBeenCalledTimes(1);
    expect(connection.readConnection()).toMatchObject({ mode: 'broker', rnc });
    const saved = fs.readFileSync(path.join(directory, 'storage/ecf/gateway-connection.json'), 'utf8');
    expect(saved).not.toContain(certificate.certPassword);
    expect(saved).not.toContain('certificate-test');
  });
});
