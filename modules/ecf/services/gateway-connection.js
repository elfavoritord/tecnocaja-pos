'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { ecfWorkPath } = require('../utils/work-dir.util');
const { encryptText, decryptTextWithLegacyFallback } = require('./crypto-service');

const GATEWAY_URL = 'https://tecno-caja-ecf-gateway-1052855422372.us-east1.run.app';
const connectionPath = () => ecfWorkPath('storage', 'ecf', 'gateway-connection.json');

function readConnection() {
  const file = connectionPath();
  if (!fs.existsSync(file)) return null;
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (saved.mode === 'broker') return { rnc: saved.rnc, mode: 'broker', fingerprintSha256: saved.fingerprintSha256, p12Sha256: saved.p12Sha256 };
  return { rnc: saved.rnc, base: GATEWAY_URL, token: decryptTextWithLegacyFallback(saved.token) };
}

async function connectGateway({ certificate, rnc, token, cloudConnection, fetchImpl = fetch }) {
  rnc = String(rnc || '').replace(/\D/g, '');
  token = String(token || '').trim();
  if (!token && cloudConnection) {
    const p12Sha256 = crypto.createHash('sha256').update(fs.readFileSync(certificate.certPath)).digest('hex');
    const saved = readConnection();
    if (saved?.mode === 'broker' && saved.rnc === rnc && saved.p12Sha256 === p12Sha256) return { ok: true, rnc, alreadyConnected: true };
    const result = await cloudConnection.request('reception-connect', {
      certificateBase64: fs.readFileSync(certificate.certPath).toString('base64'), password: certificate.certPassword,
    });
    if (result.rnc !== rnc || !result.fingerprintSha256) throw new Error('El receptor no confirmó el certificado de este negocio.');
    const file = connectionPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ mode: 'broker', rnc, fingerprintSha256: result.fingerprintSha256, p12Sha256 }), { mode: 0o600 });
    fs.renameSync(temporary, file);
    return result;
  }
  if (!/^(\d{9}|\d{11})$/.test(rnc) || !token.startsWith(`${rnc}.`)) {
    throw new Error('El código de conexión debe pertenecer al RNC de este negocio.');
  }
  const response = await fetchImpl(`${GATEWAY_URL}/admin/tenants/${rnc}/certificate`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      certificateBase64: fs.readFileSync(certificate.certPath).toString('base64'),
      password: certificate.certPassword,
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `No se pudo conectar la recepción (${response.status}).`);
  if (result.tenant?.rnc !== rnc || !result.tenant?.certificate) {
    throw new Error('El servicio no confirmó el certificado de esta empresa.');
  }
  const file = connectionPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ rnc, token: encryptText(token) }), { mode: 0o600 });
  fs.renameSync(temporary, file);
  return { ok: true, rnc, validTo: result.tenant.certificate.validTo };
}

module.exports = { connectGateway, readConnection, GATEWAY_URL };
