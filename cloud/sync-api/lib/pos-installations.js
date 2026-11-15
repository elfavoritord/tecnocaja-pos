'use strict';

const crypto = require('crypto');
const express = require('express');
const { createRateLimiter } = require('./rate-limit');
const fail = (message, statusCode, code) => Object.assign(new Error(message), { statusCode, code });
const clean = (v, max = 200) => String(v || '').trim().slice(0, max);
const emailOf = (v) => clean(v).toLowerCase();
const iso = (v) => v?.toDate ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : v;
const serializable = value => {
  if (value?.toDate || value instanceof Date) return iso(value);
  if (Array.isArray(value)) return value.map(serializable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serializable(v)]));
  return value;
};

function createPosRouter({ db, verificarIdToken, now = () => new Date(), gatewayFetch = fetch, gatewayToken = process.env.GATEWAY_ADMIN_TOKEN }) {
  const router = express.Router();
  const limit = createRateLimiter({ windowMs: 15 * 60000, max: 90, now: () => now().getTime() });
  router.use('/v1/pos', express.json({ limit: '160kb' }), (req, res, next) => {
    if (!limit(req.ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
    res.set('Cache-Control', 'no-store');
    next();
  });
  function proof(req, action) {
    const { payload, publicKey, signature } = req.body || {};
    try {
      if (typeof payload !== 'string' || payload.length > 150000 || typeof publicKey !== 'string' || publicKey.length > 200) throw Error();
      const key = crypto.createPublicKey(publicKey);
      if (key.asymmetricKeyType !== 'ed25519' || !crypto.verify(null, Buffer.from(payload), key, Buffer.from(signature || '', 'base64'))) throw Error();
      const data = JSON.parse(payload);
      if (data.action !== action || Math.abs(now().getTime() - Number(data.at)) > 5 * 60000 || !/^npd_[a-f0-9]{32}$/.test(data.deviceId || '')) throw Error();
      return { data, publicKey, keyId: crypto.createHash('sha256').update(publicKey).digest('hex') };
    } catch (_) { throw fail('La identidad del equipo no es válida. Comprueba también la fecha del sistema.', 401, 'IDENTIDAD_INVALIDA'); }
  }
  function wrap(action, fn) {
    router.post(`/v1/pos/${action}`, async (req, res) => {
      try { res.json(await fn(proof(req, action))); }
      catch (e) {
        const status = e.statusCode || 500;
        if (status >= 500) console.error('[POS-CLOUD]', e.message);
        res.status(status).json({ error: status >= 500 ? 'No se pudo completar la conexión del negocio.' : e.message, code: e.code || 'ERROR_NUBE' });
      }
    });
  }
  function view(id, lic) {
    const docData = { ...lic };
    delete docData.posInstallations;
    for (const field of ['issuedAt', 'expiresAt', 'trialStartedAt', 'trialEndsAt', 'createdAt', 'updatedAt']) docData[field] = iso(docData[field]) || null;
    return { id, docData: serializable(docData), businessName: lic.businessName };
  }
  async function authorized(p) {
    const id = clean(p.data.licenseId, 120);
    if (!/^pos_[a-zA-Z0-9_-]+$/.test(id)) throw fail('Licencia no válida.', 403, 'SIN_LICENCIA');
    const snap = await db.collection('licencias').doc(id).get();
    const lic = snap.exists ? snap.data() : null;
    if (!lic || lic.deleted || lic.posInstallations?.[p.keyId]?.deviceId !== p.data.deviceId) throw fail('Este equipo no está vinculado a la licencia.', 403, 'EQUIPO_NO_REGISTRADO');
    const device = lic.devices?.[p.data.deviceId];
    if (!device || ['released', 'blocked', 'liberado', 'bloqueado'].includes(device.status)) throw fail('Este equipo fue liberado o bloqueado.', 403, 'EQUIPO_REVOCADO');
    return { id, lic };
  }
  wrap('register', async (p) => {
    let owner;
    try { owner = await verificarIdToken(p.data.idToken); } catch (_) { throw fail('La cuenta del dueño no es válida.', 401, 'CUENTA_INVALIDA'); }
    const email = emailOf(owner?.email);
    if (!email || !owner?.uid) throw fail('La cuenta del dueño debe tener correo.', 401, 'CUENTA_INVALIDA');
    const b = p.data.business || {};
    const name = clean(b.name);
    if (!name) throw fail('Indica el nombre del negocio.', 400, 'DATOS_INCOMPLETOS');
    let id = clean(p.data.requestedLicenseId, 120);
    // Sin UID local, recuperar solo un negocio de ESTE dueño con el mismo nombre.
    if (!id) {
      const matches = new Map();
      for (const field of ['ownerEmail', 'email', 'correo']) {
        const s = await db.collection('licencias').where(field, '==', email).limit(50).get();
        s.docs.filter(d => !d.data().deleted && clean(d.data().businessName).toLowerCase() === name.toLowerCase()).forEach(d => matches.set(d.id, d));
      }
      // El RNC identifica al negocio aunque se haya escrito el nombre de otra
      // manera. Nunca crear una segunda licencia para esquivar su propietario.
      const digits = clean(b.rnc, 20).replace(/\D/g, '');
      if (/^(\d{9}|\d{11})$/.test(digits)) {
        const formatted = `${digits.slice(0, 3)}-${digits.slice(3, -1)}-${digits.slice(-1)}`;
        for (const value of new Set([clean(b.rnc, 20), digits, formatted])) {
          const s = await db.collection('licencias').where('rnc', '==', value).limit(10).get();
          s.docs.filter(d => !d.data().deleted).forEach(d => matches.set(d.id, d));
        }
      }
      if (matches.size > 1) throw fail('Hay varios negocios de esa cuenta con el mismo nombre. Soporte debe seleccionar la licencia.', 409, 'LICENCIA_AMBIGUA');
      id = matches.size ? [...matches.keys()][0] : `pos_${p.keyId.slice(0, 32)}`;
    }
    if (!/^pos_[a-zA-Z0-9_-]+$/.test(id)) throw fail('Licencia no válida.', 400, 'LICENCIA_INVALIDA');
    const ref = db.collection('licencias').doc(id);
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const lic = snap.exists ? snap.data() : null;
      if (lic && (lic.deleted || !['ownerEmail', 'email', 'correo'].some(f => emailOf(lic[f]) === email))) throw fail('La licencia no pertenece a esta cuenta.', 403, 'OTRO_NEGOCIO');
      if (lic && (lic.ownerUid ? lic.ownerUid !== owner.uid : owner.email_verified !== true)) throw fail('Verifica el correo del dueño o solicita a soporte vincular su cuenta a esta licencia.', 403, 'DUENO_NO_VERIFICADO');
      if (lic && ['suspended','blocked','cancelled','suspendido'].includes(String(lic.status).toLowerCase())) throw fail('La licencia está suspendida.', 403, 'LICENCIA_SUSPENDIDA');
      const devices = lic?.devices || {};
      const oldDevice = devices[p.data.deviceId];
      if (oldDevice && ['released','blocked','liberado','bloqueado'].includes(oldDevice.status)) throw fail('El propietario debe autorizar nuevamente este equipo.', 403, 'EQUIPO_REVOCADO');
      const active = Object.values(devices).filter(d => !['released','blocked','liberado','bloqueado'].includes(d.status));
      const max = lic ? Number(lic.deviceLimit ?? 1) : 1;
      if (!oldDevice && max > 0 && active.length >= max) throw fail('La licencia alcanzó su límite de equipos. Solicita autorización al propietario.', 403, 'DEVICE_LIMIT');
      const date = now();
      const starts = new Date(b.trialStartedAt);
      const start = Number.isFinite(starts.getTime()) && starts < date ? starts : date;
      const end = new Date(start.getTime() + 30 * 86400000);
      const fresh = {
        source: 'pos', systemAssignment: 'pos', licenseId: id, principalUid: id, businessName: name,
        ownerEmail: email, email, ownerUid: owner.uid, rnc: clean(b.rnc, 20), status: 'trial',
        planCode: ({ monocaja: 'basico', multicaja: 'pro', multisucursal: 'plus' })[b.structure] || 'basico',
        trialStartedAt: start, issuedAt: start, trialEndsAt: end, expiresAt: end, createdAt: date,
        deviceLimit: 1, offlineGraceDays: 3,
      };
      const result = { ...(lic || fresh),
        devices: { ...devices, [p.data.deviceId]: { ...(oldDevice || {}), deviceId: p.data.deviceId, hostname: clean(p.data.device?.hostname, 100), status: 'active', firstSeenAt: oldDevice?.firstSeenAt || date, lastSeenAt: date } },
        posInstallations: { ...(lic?.posInstallations || {}), [p.keyId]: { deviceId: p.data.deviceId, ownerUid: owner.uid } },
      };
      tx.set(ref, result);
      tx.set(db.collection('usuarios').doc(id), { recordKind: 'account', source: 'pos', systemAssignment: 'pos', principalUid: id, licenseId: id, nombre: result.businessName, businessName: result.businessName, email, ownerEmail: email, status: result.status, planCode: result.planCode, trialEndsAt: result.trialEndsAt || null }, { merge: true });
    });
    return { license: view(id, (await ref.get()).data()) };
  });
  wrap('license', async p => { const { id, lic } = await authorized(p); return { license: view(id, lic) }; });
  const gateway = async (route, method, body) => {
    if (!gatewayToken) throw fail('El receptor automático no está configurado en el servidor.', 503, 'RECEPTOR_NO_CONFIGURADO');
    const r = await gatewayFetch(`https://tecno-caja-ecf-gateway-1052855422372.us-east1.run.app${route}`, { method, headers: { Authorization: `Bearer ${gatewayToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000), redirect: 'error' });
    const result = await r.json();
    if (!r.ok) throw fail(result.error || 'El receptor rechazó la conexión.', r.status, 'ERROR_RECEPTOR');
    return result;
  };
  async function fiscalScope(p) {
    const scope = await authorized(p);
    if (['suspended','blocked','cancelled','suspendido'].includes(String(scope.lic.status).toLowerCase())) throw fail('La licencia está suspendida.', 403, 'LICENCIA_SUSPENDIDA');
    const rnc = clean(scope.lic.ecfGatewayRnc || scope.lic.rnc).replace(/\D/g, '');
    if (!/^(\d{9}|\d{11})$/.test(rnc)) throw fail('Configura el RNC del negocio antes de conectar la recepción.', 422, 'SIN_RNC');
    return { ...scope, rnc };
  }
  wrap('reception-connect', async p => {
    const { id, lic, rnc } = await fiscalScope(p);
    // El Gateway valida la pertenencia o la autorización previa del administrador.
    return gateway('/admin/automatic-connection', 'POST', { licenseId: id, rnc, name: lic.businessName, authorizedRnc: clean(lic.ecfGatewayRnc).replace(/\D/g, '') === rnc, certificateBase64: p.data.certificateBase64, password: p.data.password });
  });
  wrap('reception-received', async p => {
    const { id, rnc } = await fiscalScope(p);
    const tenant = await db.collection('ecf_gateway_tenants').doc(rnc).get();
    if (!tenant.exists || tenant.data().businessId !== id) throw fail('La recepción de este negocio todavía no está conectada.', 409, 'RECEPCION_NO_CONECTADA');
    return gateway(`/admin/received?rnc=${rnc}&limit=50`, 'GET');
  });
  return router;
}

module.exports = { createPosRouter };
