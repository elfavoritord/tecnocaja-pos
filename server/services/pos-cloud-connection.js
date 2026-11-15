'use strict';

// La PC conserva su clave privada; Cloud Run conserva solo la pública.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { encryptJsonEnvelope, decryptJsonEnvelope } = require('../security/local-machine-crypto');
const API = 'https://tecno-caja-sync-api-1052855422372.us-east1.run.app';
const WEB_KEY = 'AIzaSyBLWv3KZeNBtAr9eo3totVfZtp0Mz_Ha2k';

function createPosCloudConnection({ directory, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const root = directory || path.join(process.env.TECNO_CAJA_USER_DATA || process.cwd(), 'config', 'pos-cloud');
  let businessId = null;
  let registering = null;
  const verificationSent = new Set();
  const selectBusiness = (id) => { businessId = String(id || 'principal'); };
  function file() {
    if (!businessId) throw new Error('No se ha seleccionado el negocio para conectar la nube.');
    return path.join(root, crypto.createHash('sha256').update(businessId).digest('hex') + '.json');
  }
  function read() {
    if (!fs.existsSync(file())) return null;
    return decryptJsonEnvelope(fs.readFileSync(file(), 'utf8'), { purpose: 'pos-cloud-identity' });
  }
  function save(value) {
    fs.mkdirSync(root, { recursive: true });
    const temporary = file() + '.tmp';
    const encrypted = encryptJsonEnvelope(value, { purpose: 'pos-cloud-identity' });
    fs.writeFileSync(temporary, typeof encrypted === 'string' ? encrypted : JSON.stringify(encrypted), { mode: 0o600 });
    fs.renameSync(temporary, file());
  }
  async function request(action, data = {}, identity = read()) {
    if (!identity) throw Object.assign(new Error('El negocio aún no se ha registrado en la nube. Inicia sesión con su administrador.'), { code: 'CLOUD_REGISTRATION_REQUIRED' });
    const payload = JSON.stringify({ action, at: now(), licenseId: identity.licenseId || null, deviceId: identity.deviceId, ...data });
    const signature = crypto.sign(null, Buffer.from(payload), identity.privateKey).toString('base64');
    const r = await fetchImpl(`${API}/v1/pos/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, signature, publicKey: identity.publicKey }),
      signal: AbortSignal.timeout(action === 'reception-connect' ? 75000 : 25000), redirect: 'error',
    });
    const result = await r.json();
    if (!r.ok) throw Object.assign(new Error(result.error || 'No se pudo conectar con la nube de Tecno Caja.'), { code: result.code, statusCode: r.status });
    return result;
  }
  async function ownerToken(email, password) {
    async function call(method) {
      const r = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${WEB_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }), signal: AbortSignal.timeout(15000), redirect: 'error',
      });
      const result = await r.json();
      return { ok: r.ok, result };
    }
    let signed = await call('signInWithPassword');
    if (!signed.ok && /EMAIL_NOT_FOUND|INVALID_LOGIN_CREDENTIALS/.test(signed.result.error?.message || '')) {
      const created = await call('signUp');
      if (created.ok) signed = created;
    }
    if (!signed.ok || !signed.result.idToken) throw new Error('No se pudo validar la cuenta del dueño en la nube. Comprueba su correo y contraseña de Tecno Caja.');
    return signed.result.idToken;
  }
  async function registerOnce({ business, device, email, password, idToken, licenseId, notifyOwner = false }) {
    let identity = read();
    if (identity?.licenseId) return request('license');
    if (!identity) {
      const keys = crypto.generateKeyPairSync('ed25519');
      identity = { deviceId: device.deviceId,
        privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
        publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) };
      save(identity); // Permite reintentar sin duplicar el negocio.
    }
    const token = idToken || await ownerToken(email, password);
    let result;
    try { result = await request('register', { idToken: token, business, device, requestedLicenseId: licenseId || null }, identity); }
    catch (error) {
      if (error.code === 'DUENO_NO_VERIFICADO' && notifyOwner && !verificationSent.has(email)) {
        const r = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${WEB_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestType: 'VERIFY_EMAIL', idToken: token }), signal: AbortSignal.timeout(15000), redirect: 'error',
        });
        if (r.ok) { verificationSent.add(email); error.message = 'Confirma el correo de verificación de la cuenta del dueño y vuelve a iniciar sesión para vincular su licencia existente.'; }
      }
      throw error;
    }
    identity.licenseId = result.license.id;
    save(identity);
    return result;
  }
  function register(options) {
    if (!registering) registering = registerOnce(options).finally(() => { registering = null; });
    return registering;
  }
  return { selectBusiness, connected: () => Boolean(read()?.licenseId), request, register };
}

module.exports = { createPosCloudConnection };
