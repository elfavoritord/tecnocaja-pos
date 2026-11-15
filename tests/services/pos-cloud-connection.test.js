'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const { createPosRouter } = require('../../cloud/sync-api/lib/pos-installations');
const { createPosCloudConnection } = require('../../server/services/pos-cloud-connection');

function memoryDb() {
  const data = new Map();
  const snapshot = (key) => ({ id: key.split('/').pop(), exists: data.has(key), data: () => data.get(key) });
  const doc = key => ({ key, get: async () => snapshot(key) });
  return { data,
    collection: col => ({ doc: id => doc(`${col}/${id}`), where: (field, op, value) => ({ limit: () => ({ get: async () => ({ docs: [...data.keys()].filter(k => k.startsWith(`${col}/`) && data.get(k)[field] === value).map(snapshot) }) }) }) }),
    runTransaction: async fn => {
      const writes = [];
      await fn({ get: ref => ref.get(), set: (ref, value, options) => writes.push([ref.key, value, options]) });
      for (const [key, value, options] of writes) data.set(key, options?.merge ? { ...data.get(key), ...value } : value);
    },
  };
}

describe('Alta y licencia del POS sin Firebase Admin en la PC', () => {
  let directory, db, app, client, owner, device, calls, body;
  const now = new Date('2026-11-15T04:00:00Z');
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-pos-cloud-'));
    db = memoryDb();
    owner = { uid: 'owner-one', email: 'owner@example.test', email_verified: true };
    device = { deviceId: 'npd_' + '1'.repeat(32), hostname: 'Equipo Elena' };
    calls = [];
    app = express();
    app.use(createPosRouter({ db, now: () => now, verificarIdToken: async token => { if (token !== 'valid-owner') throw Error(); return owner; } }));
    client = createPosCloudConnection({ directory, now: () => now.getTime(), fetchImpl: async (url, options) => {
      calls.push({ url, options });
      body = JSON.parse(options.body);
      const r = await request(app).post(new URL(url).pathname).send(body);
      return { ok: r.status < 400, status: r.status, json: async () => r.body };
    } });
    client.selectBusiness('elena-uuid');
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
  const register = function () { return client.register({ business: { name: 'Super Mercado Elena', trialStartedAt: '2026-11-15T03:22:52Z' }, device, idToken: 'valid-owner' }); };

  test('crea el negocio en administración y su licencia, y valida el equipo con prueba criptográfica', async () => {
    const result = await register();
    const id = result.license.id;
    expect(db.data.get(`usuarios/${id}`).businessName).toBe('Super Mercado Elena');
    expect(result.license.docData.status).toBe('trial');
    expect(result.license.docData.trialEndsAt).toBe('2026-12-15T03:22:52.000Z');
    expect((await client.request('license')).license.id).toBe(id);
    expect(client.connected()).toBe(true);
    const saved = fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8');
    expect(saved).not.toContain('PRIVATE KEY');
    expect(saved).not.toContain('valid-owner');
  });
  test('reinicio y reintento conservan la licencia, las fechas y el estado decidido por administración', async () => {
    const { license } = await register();
    const stored = db.data.get(`licencias/${license.id}`);
    stored.status = 'active'; stored.planCode = 'plus'; stored.deviceLimit = 4;
    const result = await register();
    expect(result.license.docData.status).toBe('active');
    expect(result.license.docData.planCode).toBe('plus');
    expect([...db.data.keys()].filter(k => k.startsWith('licencias/'))).toHaveLength(1);
    expect(result.license.docData.trialEndsAt).toBe(license.docData.trialEndsAt);
  });
  test('rechaza firmas alteradas y no deja leer otra licencia', async () => {
    await register(); await client.request('license');
    const tampered = { ...body, payload: body.payload.replace('license', 'register') };
    await request(app).post('/v1/pos/license').send(tampered).expect(401);
    await expect(client.request('license', { licenseId: 'pos_someoneelse' })).rejects.toThrow('vinculado');
  });
  test('equipo revocado no obtiene autorización con su clave antigua', async () => {
    const { license } = await register();
    db.data.get(`licencias/${license.id}`).devices[device.deviceId].status = 'released';
    await expect(client.request('license')).rejects.toThrow('liberado');
  });
  test('no reclama una licencia ajena ni siquiera indicando su ID', async () => {
    db.data.set('licencias/pos_other', { ownerEmail: 'other@example.test', ownerUid: 'other', status: 'active' });
    await expect(client.register({ business: { name: 'Elena' }, device, idToken: 'valid-owner', licenseId: 'pos_other' })).rejects.toThrow('pertenece');
    expect(db.data.get('licencias/pos_other').posInstallations).toBeUndefined();
  });
  test('el RNC de una licencia ajena no crea un negocio duplicado por cambiarle el nombre', async () => {
    db.data.set('licencias/pos_existing', { ownerEmail: 'other@example.test', ownerUid: 'other', businessName: 'Nombre original', rnc: '132-96716-1', status: 'active' });
    await expect(client.register({ business: { name: 'Nombre diferente', rnc: '132967161' }, device, idToken: 'valid-owner' })).rejects.toThrow('pertenece');
    expect([...db.data.keys()].filter(k => k.startsWith('licencias/'))).toHaveLength(1);
  });
  test('no concede una segunda PC por encima del límite ni reinicia una prueba existente', async () => {
    db.data.set('licencias/pos_full', { ownerEmail: owner.email, ownerUid: owner.uid, businessName: 'Elena', status: 'trial', trialEndsAt: new Date('2026-11-01Z'), deviceLimit: 1, devices: { old: { status: 'active' } } });
    await expect(client.register({ business: { name: 'Elena' }, device, idToken: 'valid-owner', licenseId: 'pos_full' })).rejects.toThrow('límite');
    expect(db.data.get('licencias/pos_full').trialEndsAt).toEqual(new Date('2026-11-01Z'));
  });
  test('un correo sin verificar no reclama licencias antiguas sin propietario vinculado', async () => {
    owner.email_verified = false;
    db.data.set('licencias/pos_old', { ownerEmail: owner.email, status: 'active', businessName: 'Elena' });
    await expect(client.register({ business: { name: 'Elena' }, device, idToken: 'valid-owner', licenseId: 'pos_old' })).rejects.toThrow('Verifica');
  });
  test('la recepción no permite seleccionar el RNC ni el certificado de otra licencia', async () => {
    const { license } = await register();
    await expect(client.request('reception-received', { rnc: '132967161' })).rejects.toThrow('RNC');
    db.data.get(`licencias/${license.id}`).rnc = '132967161';
    db.data.set('ecf_gateway_tenants/132967161', { businessId: 'pos_other' });
    await expect(client.request('reception-received')).rejects.toThrow('no está conectada');
  });
  test('una prueba con fecha futura queda anclada al servidor y no se puede elegir estado activo', async () => {
    const { license } = await client.register({ business: { name: 'Nuevo', trialStartedAt: '2030-01-01Z', status: 'active', deviceLimit: 999 }, device, idToken: 'valid-owner' });
    expect(license.docData.status).toBe('trial');
    expect(license.docData.deviceLimit).toBe(1);
    expect(license.docData.trialStartedAt).toBe(now.toISOString());
  });
  test('la licencia del intermediario abre el POS y conserva autorización cifrada para el siguiente inicio offline', async () => {
    const { crearBaseSqlite } = require('../multisucursal/sqlite-helper');
    const { createLicenseService } = require('../../server/licensing/license-service');
    const base = await crearBaseSqlite();
    try {
      await base.query("ALTER TABLE config ADD COLUMN plan_code TEXT DEFAULT 'basico'");
      await base.query('ALTER TABLE config ADD COLUMN plan_name TEXT');
      await base.query('ALTER TABLE config ADD COLUMN license_last_remote_check_at TEXT');
      await base.query("UPDATE config SET setup_completed=1, business_name='Super Mercado Elena', trial_started_at='2026-11-15 03:22:52', trial_ends_at='2026-12-15 03:22:52', license_status='expired' WHERE id=1");
      const { license } = await register();
      const options = { query: base.query, now: () => now, device,
        fetchRemoteLicense: async () => (await client.request('license')).license,
        updateRemoteDevice: async () => ({ allowed: true }), logger: { warn() {}, log() {}, error() {} },
      };
      const state = await createLicenseService(options).resolveState({ force: true, allowRemote: true });
      expect(state.license.canEnter).toBe(true);
      expect(state.license.licenseId).toBe(license.id);
      const offline = await createLicenseService({ ...options, fetchRemoteLicense: async () => { throw Error('Sin internet'); } }).resolveState({ allowRemote: false });
      expect(offline.source).toBe('cache');
      expect(offline.license.canEnter).toBe(true);
    } finally { base.close(); }
  });
});
