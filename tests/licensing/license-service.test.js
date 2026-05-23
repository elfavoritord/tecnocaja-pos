'use strict';

const {
  createLicenseService,
  signLicensePayloadHmac,
} = require('../../server/licensing/license-service');

function createMockQueryState() {
  return {
    configRow: {
      id: 1,
      business_name: 'Demo POS',
      setup_completed: 1,
      plan_code: 'basico',
      business_structure_mode: 'monocaja',
      license_status: 'trial',
      trial_started_at: '2026-04-01 10:00:00',
      trial_ends_at: '2026-05-01 10:00:00',
    },
    licenseCache: null,
    adminUid: 'admin_demo_1',
  };
}

function createMockQuery(state) {
  return async (sql, params = []) => {
    const normalized = String(sql || '').replace(/\s+/g, ' ').trim();

    if (normalized.startsWith('CREATE TABLE IF NOT EXISTS license_cache')) {
      return [];
    }

    if (normalized.includes('SELECT id, business_name, setup_completed, plan_code')) {
      return [state.configRow];
    }

    if (normalized.includes('SELECT firebase_uid')) {
      return state.adminUid ? [{ firebase_uid: state.adminUid }] : [];
    }

    if (normalized.includes('SELECT cache_blob, integrity_hash FROM license_cache')) {
      return state.licenseCache ? [state.licenseCache] : [];
    }

    if (normalized.startsWith('INSERT INTO license_cache')) {
      state.licenseCache = {
        cache_blob: params[1],
        integrity_hash: params[2],
      };
      return { affectedRows: 1 };
    }

    if (normalized.startsWith('UPDATE config SET license_status = ?')) {
      state.configRow.license_status = params[0];
      state.configRow.plan_code = params[1];
      state.configRow.business_structure_mode = params[3];
      state.configRow.trial_started_at = params[4];
      state.configRow.trial_ends_at = params[5];
      return { affectedRows: 1 };
    }

    throw new Error(`SQL inesperado en prueba: ${normalized}`);
  };
}

function buildRemoteLicense({ deviceId, secret, overrides = {} }) {
  const base = {
    id: 'lic_demo_1',
    businessName: 'Demo POS',
    status: 'active',
    planCode: 'plus',
    issuedAt: new Date('2026-04-01T10:00:00.000Z'),
    expiresAt: new Date('2026-05-05T10:00:00.000Z'),
    deviceLimit: 1,
    offlineGraceDays: 3,
    devices: {},
    signatureAlg: 'hmac-sha256',
  };

  const merged = { ...base, ...overrides };
  merged.signature = signLicensePayloadHmac({
    licenseId: merged.id,
    businessName: merged.businessName,
    plan: merged.planCode,
    status: merged.status,
    issuedAt: merged.issuedAt.toISOString(),
    expiresAt: merged.expiresAt.toISOString(),
    deviceId,
    deviceLimit: merged.deviceLimit,
    offlineGraceDays: merged.offlineGraceDays,
  }, secret);

  return merged;
}

describe('server/licensing/license-service', () => {
  let envSnapshot;

  beforeEach(() => {
    envSnapshot = { ...process.env };
    process.env.TECNO_CAJA_LICENSE_HMAC_SECRET = 'license-hmac-secret-test';
    process.env.TECNO_CAJA_LICENSE_REQUIRE_SIGNATURE = 'true';
    process.env.TECNO_CAJA_LICENSE_OFFLINE_GRACE_DAYS = '3';
    process.env.TECNO_CAJA_LICENSE_STORAGE_SECRET = 'license-storage-secret-test';
    process.env.TECNO_CAJA_DB_KEY_SALT = 'db-key-salt-test';
    process.env.TECNO_CAJA_DEVICE_SECRET = 'device-secret-test';
  });

  afterEach(() => {
    process.env = envSnapshot;
  });

  it('sincroniza una licencia válida y luego permite usar el caché offline dentro de la gracia', async () => {
    const state = createMockQueryState();
    const query = createMockQuery(state);
    let now = new Date('2026-04-30T10:00:00.000Z');
    const device = { deviceId: 'npd_test_1', hostname: 'POS-01', platform: 'win32', arch: 'x64' };

    const service = createLicenseService({
      query,
      now: () => now,
      device,
      fetchRemoteLicense: async () => buildRemoteLicense({
        deviceId: device.deviceId,
        secret: process.env.TECNO_CAJA_LICENSE_HMAC_SECRET,
      }),
      updateRemoteDevice: async () => ({ allowed: true, activeCount: 1, limit: 1 }),
    });

    const online = await service.resolveState({ force: true, allowRemote: true });
    expect(online.synced).toBe(true);
    expect(online.license.canEnter).toBe(true);
    expect(online.license.planCode).toBe('plus');

    now = new Date('2026-05-01T10:00:00.000Z');
    const offlineService = createLicenseService({
      query,
      now: () => now,
      device,
      fetchRemoteLicense: async () => {
        throw new Error('offline');
      },
    });

    const offline = await offlineService.resolveState({ force: true, allowRemote: true });
    expect(offline.source).toBe('cache');
    expect(offline.license.canEnter).toBe(true);
    expect(offline.license.offlineDaysRemaining).toBe(2);
  });

  it('bloquea cuando se supera la gracia offline', async () => {
    const state = createMockQueryState();
    const query = createMockQuery(state);
    let now = new Date('2026-04-30T10:00:00.000Z');
    const device = { deviceId: 'npd_test_2', hostname: 'POS-02', platform: 'win32', arch: 'x64' };

    const seedService = createLicenseService({
      query,
      now: () => now,
      device,
      fetchRemoteLicense: async () => buildRemoteLicense({
        deviceId: device.deviceId,
        secret: process.env.TECNO_CAJA_LICENSE_HMAC_SECRET,
        overrides: {
          expiresAt: new Date('2026-05-30T10:00:00.000Z'),
        },
      }),
      updateRemoteDevice: async () => ({ allowed: true, activeCount: 1, limit: 1 }),
    });
    await seedService.resolveState({ force: true, allowRemote: true });

    now = new Date('2026-05-05T12:00:00.000Z');
    const offlineService = createLicenseService({
      query,
      now: () => now,
      device,
      fetchRemoteLicense: async () => {
        throw new Error('offline');
      },
    });

    const result = await offlineService.resolveState({ force: true, allowRemote: true });
    expect(result.license.canEnter).toBe(false);
    expect(result.license.blockedCode).toBe('offline_grace');
  });

  it('bloquea si el caché local fue manipulado', async () => {
    const state = createMockQueryState();
    const query = createMockQuery(state);
    const device = { deviceId: 'npd_test_3', hostname: 'POS-03', platform: 'win32', arch: 'x64' };

    const seedService = createLicenseService({
      query,
      now: () => new Date('2026-04-30T10:00:00.000Z'),
      device,
      fetchRemoteLicense: async () => buildRemoteLicense({
        deviceId: device.deviceId,
        secret: process.env.TECNO_CAJA_LICENSE_HMAC_SECRET,
      }),
      updateRemoteDevice: async () => ({ allowed: true, activeCount: 1, limit: 1 }),
    });
    await seedService.resolveState({ force: true, allowRemote: true });

    state.licenseCache.integrity_hash = 'alterado';

    const offlineService = createLicenseService({
      query,
      now: () => new Date('2026-05-01T10:00:00.000Z'),
      device,
      fetchRemoteLicense: async () => {
        throw new Error('offline');
      },
    });

    const result = await offlineService.resolveState({ force: true, allowRemote: true });
    expect(result.license.canEnter).toBe(false);
    expect(result.license.blockedCode).toBe('tamper');
  });

  it('bloquea si el dispositivo supera el límite autorizado', async () => {
    const state = createMockQueryState();
    const query = createMockQuery(state);
    const device = { deviceId: 'npd_test_4', hostname: 'POS-04', platform: 'win32', arch: 'x64' };

    const service = createLicenseService({
      query,
      now: () => new Date('2026-04-30T10:00:00.000Z'),
      device,
      fetchRemoteLicense: async () => buildRemoteLicense({
        deviceId: device.deviceId,
        secret: process.env.TECNO_CAJA_LICENSE_HMAC_SECRET,
      }),
      updateRemoteDevice: async () => ({ allowed: false, activeCount: 1, limit: 1 }),
    });

    const result = await service.resolveState({ force: true, allowRemote: true });
    expect(result.synced).toBe(true);
    expect(result.license.canEnter).toBe(false);
    expect(result.license.blockedCode).toBe('device_limit');
  });

  it('no marca cambio cuando solo se refresca la validación remota', async () => {
    const state = createMockQueryState();
    const query = createMockQuery(state);
    const device = { deviceId: 'npd_test_5', hostname: 'POS-05', platform: 'win32', arch: 'x64' };
    let now = new Date('2026-04-30T10:00:00.000Z');

    const service = createLicenseService({
      query,
      now: () => now,
      device,
      fetchRemoteLicense: async () => buildRemoteLicense({
        deviceId: device.deviceId,
        secret: process.env.TECNO_CAJA_LICENSE_HMAC_SECRET,
      }),
      updateRemoteDevice: async () => ({ allowed: true, activeCount: 1, limit: 1 }),
    });

    const initial = await service.resolveState({ force: true, allowRemote: true });
    expect(initial.changed).toBe(true);

    now = new Date('2026-04-30T10:05:00.000Z');
    const refreshed = await service.resolveState({ force: true, allowRemote: true });
    expect(refreshed.synced).toBe(true);
    expect(refreshed.changed).toBe(false);
  });

  it('propaga el modo solo lectura para evitar escrituras remotas desde el watcher', async () => {
    const state = createMockQueryState();
    const query = createMockQuery(state);
    const device = { deviceId: 'npd_test_6', hostname: 'POS-06', platform: 'win32', arch: 'x64' };
    const updateRemoteDevice = jest.fn(async () => ({ allowed: true, activeCount: 1, limit: 1, skipped: true }));

    const service = createLicenseService({
      query,
      now: () => new Date('2026-04-30T10:00:00.000Z'),
      device,
      fetchRemoteLicense: async () => buildRemoteLicense({
        deviceId: device.deviceId,
        secret: process.env.TECNO_CAJA_LICENSE_HMAC_SECRET,
      }),
      updateRemoteDevice,
    });

    const result = await service.resolveState({
      force: true,
      allowRemote: true,
      allowRemoteWrite: false,
    });

    expect(result.synced).toBe(true);
    expect(updateRemoteDevice).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ allowRemoteWrite: false })
    );
  });
});
