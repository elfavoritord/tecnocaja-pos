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

    if (normalized.includes('SELECT trial_started_at, trial_ends_at, license_status, setup_completed')) {
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
    expect(offline.license.offlineDaysRemaining).toBeNull(); // activada: sin límite
  });

  it('una licencia activada sigue funcionando meses sin Internet', async () => {
    const state = createMockQueryState();
    const query = createMockQuery(state);
    let now = new Date('2026-04-30T10:00:00.000Z');
    const device = { deviceId: 'npd_test_2', hostname: 'POS-02', platform: 'win32', arch: 'x64' };

    await createLicenseService({
      query,
      now: () => now,
      device,
      fetchRemoteLicense: async () => buildRemoteLicense({
        deviceId: device.deviceId,
        secret: process.env.TECNO_CAJA_LICENSE_HMAC_SECRET,
        overrides: { expiresAt: new Date('2027-04-30T10:00:00.000Z') },
      }),
      updateRemoteDevice: async () => ({ allowed: true, activeCount: 1, limit: 1 }),
    }).resolveState({ force: true, allowRemote: true });

    now = new Date('2026-08-15T12:00:00.000Z'); // 107 días después, sin Internet
    const result = await createLicenseService({
      query,
      now: () => now,
      device,
      fetchRemoteLicense: async () => { throw new Error('offline'); },
    }).resolveState({ force: true, allowRemote: true });

    expect(result.source).toBe('cache');
    expect(result.license.canEnter).toBe(true);
    expect(result.license.blockedCode).toBeNull();
    expect(result.license.offlineGraceDays).toBeNull();
  });

  it('sin Internet, una licencia activada igual vence en su fecha (renovar sí necesita Internet)', async () => {
    const state = createMockQueryState();
    const query = createMockQuery(state);
    let now = new Date('2026-04-30T10:00:00.000Z');
    const device = { deviceId: 'npd_test_2b', hostname: 'POS-02B', platform: 'win32', arch: 'x64' };

    await createLicenseService({
      query,
      now: () => now,
      device,
      fetchRemoteLicense: async () => buildRemoteLicense({
        deviceId: device.deviceId,
        secret: process.env.TECNO_CAJA_LICENSE_HMAC_SECRET,
        overrides: { expiresAt: new Date('2026-05-30T10:00:00.000Z') },
      }),
      updateRemoteDevice: async () => ({ allowed: true, activeCount: 1, limit: 1 }),
    }).resolveState({ force: true, allowRemote: true });

    now = new Date('2026-06-02T12:00:00.000Z');
    const result = await createLicenseService({
      query,
      now: () => now,
      device,
      fetchRemoteLicense: async () => { throw new Error('offline'); },
    }).resolveState({ force: true, allowRemote: true });

    expect(result.license.canEnter).toBe(false);
    expect(result.license.blockedCode).toBe('expired');
  });

  it('la prueba sí mantiene el límite de días sin Internet', async () => {
    const state = createMockQueryState();
    state.configRow.trial_started_at = '2026-04-10 10:00:00';
    state.configRow.trial_ends_at = '2026-05-10 10:00:00';
    const query = createMockQuery(state);
    let now = new Date('2026-04-15T10:00:00.000Z');
    const device = { deviceId: 'npd_test_2c', hostname: 'POS-02C', platform: 'win32', arch: 'x64' };

    await createLicenseService({
      query,
      now: () => now,
      device,
      fetchRemoteLicense: async () => buildRemoteLicense({
        deviceId: device.deviceId,
        secret: process.env.TECNO_CAJA_LICENSE_HMAC_SECRET,
        overrides: {
          status: 'trial',
          issuedAt: new Date('2026-04-10T10:00:00.000Z'),
          expiresAt: new Date('2026-05-10T10:00:00.000Z'),
        },
      }),
      updateRemoteDevice: async () => ({ allowed: true, activeCount: 1, limit: 1 }),
    }).resolveState({ force: true, allowRemote: true });

    now = new Date('2026-04-20T12:00:00.000Z'); // 5 días sin Internet (límite: 3)
    const result = await createLicenseService({
      query,
      now: () => now,
      device,
      fetchRemoteLicense: async () => { throw new Error('offline'); },
    }).resolveState({ force: true, allowRemote: true });

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

  it('no extiende una prueba local vencida al caer en estado bloqueado', async () => {
    const state = createMockQueryState();
    state.configRow.trial_started_at = '2026-04-01 10:00:00';
    state.configRow.trial_ends_at = '2026-05-01 10:00:00';
    state.configRow.license_status = 'trial';
    const query = createMockQuery(state);
    const device = { deviceId: 'npd_test_7', hostname: 'POS-07', platform: 'win32', arch: 'x64' };

    const service = createLicenseService({
      query,
      now: () => new Date('2026-05-10T10:00:00.000Z'),
      device,
      fetchRemoteLicense: async () => {
        const error = new Error('offline');
        error.code = 'LICENSE_REMOTE_NOT_FOUND';
        throw error;
      },
    });

    const result = await service.resolveState({ force: true, allowRemote: true });
    expect(result.license.canEnter).toBe(false);
    expect(result.license.daysLeft).toBe(0);
    expect(state.configRow.trial_ends_at).toBe('2026-05-01 10:00:00');
  });

  it('no suma 30 días cuando Firebase devuelve una licencia vencida para una instalación existente', async () => {
    const state = createMockQueryState();
    state.configRow.trial_started_at = '2026-04-01 10:00:00';
    state.configRow.trial_ends_at = '2026-05-01 10:00:00';
    state.configRow.license_status = 'trial';
    const query = createMockQuery(state);
    const device = { deviceId: 'npd_test_8', hostname: 'POS-08', platform: 'win32', arch: 'x64' };

    const service = createLicenseService({
      query,
      now: () => new Date('2026-05-10T10:00:00.000Z'),
      device,
      fetchRemoteLicense: async () => buildRemoteLicense({
        deviceId: device.deviceId,
        secret: process.env.TECNO_CAJA_LICENSE_HMAC_SECRET,
        overrides: {
          status: 'trial',
          issuedAt: new Date('2026-04-01T10:00:00.000Z'),
          expiresAt: new Date('2026-05-01T10:00:00.000Z'),
        },
      }),
      updateRemoteDevice: async () => ({ allowed: true, activeCount: 1, limit: 1 }),
    });

    const result = await service.resolveState({ force: true, allowRemote: true });
    expect(result.license.canEnter).toBe(false);
    expect(result.license.daysLeft).toBe(0);
    expect(state.configRow.trial_ends_at).toBe('2026-05-01 10:00:00');
  });

  it('con fechas al estilo MariaDB (Date local) la prueba no crece al reiniciar varias veces', async () => {
    const state = createMockQueryState();
    state.configRow.trial_started_at = '2026-04-20 14:00:00';
    state.configRow.trial_ends_at = '2026-05-20 14:00:00';
    // mysql2 (timezone 'local') devuelve el DATETIME como Date interpretando el
    // texto como hora local — así llegaba a mirrorStateToConfig.
    const toMysqlDate = (value) => {
      if (typeof value !== 'string') return value;
      const [y, m, d, h, mi, s] = value.split(/[- :]/).map(Number);
      return new Date(y, m - 1, d, h, mi, s);
    };
    const baseQuery = createMockQuery(state);
    const mysqlLikeQuery = async (sql, params) => {
      const rows = await baseQuery(sql, params);
      if (!/FROM config/i.test(sql) || !Array.isArray(rows)) return rows;
      return rows.map((row) => ({
        ...row,
        trial_started_at: toMysqlDate(row.trial_started_at),
        trial_ends_at: toMysqlDate(row.trial_ends_at),
      }));
    };
    const device = { deviceId: 'npd_test_11', hostname: 'POS-11', platform: 'win32', arch: 'x64' };

    for (let restart = 0; restart < 8; restart += 1) {
      const service = createLicenseService({
        query: mysqlLikeQuery,
        now: () => new Date('2026-04-25T14:00:00.000Z'),
        device,
        fetchRemoteLicense: async () => buildRemoteLicense({
          deviceId: device.deviceId,
          secret: process.env.TECNO_CAJA_LICENSE_HMAC_SECRET,
          overrides: { status: 'trial', expiresAt: new Date('2026-05-20T18:00:00.000Z') },
        }),
        updateRemoteDevice: async () => ({ allowed: true, activeCount: 1, limit: 1 }),
      });
      const result = await service.resolveState({ force: true, allowRemote: true });
      expect(result.license.daysLeft).toBe(25);
    }

    expect(state.configRow.trial_started_at).toBe('2026-04-20 14:00:00');
    expect(state.configRow.trial_ends_at).toBe('2026-05-20 14:00:00');
  });

  it('la prueba dura 30 días desde su inicio aunque Firebase traiga un vencimiento más tarde', async () => {
    const state = createMockQueryState();
    state.configRow.trial_started_at = '2026-04-01 10:00:00';
    state.configRow.trial_ends_at = '2026-05-09 10:00:00'; // inflado por el bug viejo
    const device = { deviceId: 'npd_test_12', hostname: 'POS-12', platform: 'win32', arch: 'x64' };

    const service = createLicenseService({
      query: createMockQuery(state),
      now: () => new Date('2026-05-05T10:00:00.000Z'),
      device,
      fetchRemoteLicense: async () => buildRemoteLicense({
        deviceId: device.deviceId,
        secret: process.env.TECNO_CAJA_LICENSE_HMAC_SECRET,
        overrides: { status: 'trial', expiresAt: new Date('2026-06-01T10:00:00.000Z') },
      }),
      updateRemoteDevice: async () => ({ allowed: true, activeCount: 1, limit: 1 }),
    });

    const result = await service.resolveState({ force: true, allowRemote: true });
    expect(result.license.canEnter).toBe(false);
    expect(result.license.blockedCode).toBe('expired');
    expect(result.license.trialEndsAt).toBe('2026-05-01T10:00:00.000Z');
    expect(state.configRow.trial_ends_at).toBe('2026-05-01 10:00:00');
    expect(state.configRow.license_status).toBe('expired');
  });

  it('una prueba inflada ya no se reinicia a "hoy + 30 días"', async () => {
    const state = createMockQueryState();
    state.configRow.trial_started_at = '2026-04-25 10:00:00';
    state.configRow.trial_ends_at = '2026-07-01 10:00:00';
    const service = createLicenseService({
      query: createMockQuery(state),
      now: () => new Date('2026-05-01T10:00:00.000Z'),
      device: { deviceId: 'npd_test_13', hostname: 'POS-13', platform: 'win32', arch: 'x64' },
      fetchRemoteLicense: async () => { throw new Error('offline'); },
    });
    state.configRow.setup_completed = 0; // camino bootstrap (sin caché ni Firebase)

    const result = await service.resolveState({ force: true, allowRemote: true });
    expect(result.license.daysLeft).toBe(24);
    expect(state.configRow.trial_started_at).toBe('2026-04-25 10:00:00');
    expect(state.configRow.trial_ends_at).toBe('2026-05-25 10:00:00');
  });

  it('multicaja: cada caja lee su propio caché sin Internet aunque compartan la base', async () => {
    const state = createMockQueryState();
    state.configRow.business_structure_mode = 'multicaja';
    const rows = new Map();
    const baseQuery = createMockQuery(state);
    // Base compartida con una fila de caché por id (como MariaDB en la LAN).
    const sharedQuery = async (sql, params = []) => {
      const normalized = String(sql || '').replace(/\s+/g, ' ').trim();
      if (normalized.includes('SELECT cache_blob, integrity_hash FROM license_cache')) {
        return rows.has(params[0]) ? [rows.get(params[0])] : [];
      }
      if (normalized.startsWith('INSERT INTO license_cache')) {
        rows.set(params[0], { cache_blob: params[1], integrity_hash: params[2] });
        return { affectedRows: 1 };
      }
      return baseQuery(sql, params);
    };
    let now = new Date('2026-04-30T10:00:00.000Z');
    // Cada PC genera su propio secreto local (scripts/runtime-bootstrap.js).
    const machines = [
      { secret: 'secreto-pc-principal', device: { deviceId: 'npd_principal', hostname: 'CAJA-1', platform: 'win32', arch: 'x64' } },
      { secret: 'secreto-pc-caja-2', device: { deviceId: 'npd_caja_2', hostname: 'CAJA-2', platform: 'win32', arch: 'x64' } },
    ];
    const asMachine = async (machine, fn) => {
      process.env.TECNO_CAJA_LICENSE_STORAGE_SECRET = machine.secret;
      return fn();
    };

    for (const machine of machines) {
      await asMachine(machine, () => createLicenseService({
        query: sharedQuery,
        now: () => now,
        device: machine.device,
        fetchRemoteLicense: async () => buildRemoteLicense({
          deviceId: machine.device.deviceId,
          secret: process.env.TECNO_CAJA_LICENSE_HMAC_SECRET,
          overrides: { deviceLimit: 2 },
        }),
        updateRemoteDevice: async () => ({ allowed: true, activeCount: 2, limit: 2 }),
      }).resolveState({ force: true, allowRemote: true }));
    }
    expect(rows.size).toBe(2);

    // Se cae Internet: las dos cajas siguen entrando con su caché.
    now = new Date('2026-05-01T10:00:00.000Z');
    for (const machine of machines) {
      const result = await asMachine(machine, () => createLicenseService({
        query: sharedQuery,
        now: () => now,
        device: machine.device,
        fetchRemoteLicense: async () => { throw new Error('offline'); },
      }).resolveState({ force: true, allowRemote: true }));
      expect(result.source).toBe('cache');
      expect(result.license.canEnter).toBe(true);
      expect(result.license.blockedCode).toBeNull();
    }
  });

  it('lee el caché de la fila única de versiones anteriores y luego usa la suya', async () => {
    const state = createMockQueryState();
    const rows = new Map();
    const baseQuery = createMockQuery(state);
    const sharedQuery = async (sql, params = []) => {
      const normalized = String(sql || '').replace(/\s+/g, ' ').trim();
      if (normalized.includes('SELECT cache_blob, integrity_hash FROM license_cache')) {
        return rows.has(params[0]) ? [rows.get(params[0])] : [];
      }
      if (normalized.startsWith('INSERT INTO license_cache')) {
        rows.set(params[0], { cache_blob: params[1], integrity_hash: params[2] });
        return { affectedRows: 1 };
      }
      return baseQuery(sql, params);
    };
    const device = { deviceId: 'npd_legacy', hostname: 'POS-L', platform: 'win32', arch: 'x64' };
    await createLicenseService({
      query: sharedQuery,
      now: () => new Date('2026-04-30T10:00:00.000Z'),
      device,
      fetchRemoteLicense: async () => buildRemoteLicense({ deviceId: device.deviceId, secret: process.env.TECNO_CAJA_LICENSE_HMAC_SECRET }),
      updateRemoteDevice: async () => ({ allowed: true, activeCount: 1, limit: 1 }),
    }).resolveState({ force: true, allowRemote: true });
    // Simula una instalación vieja: el caché estaba en la fila 1.
    const [ownId, ownRow] = [...rows.entries()][0];
    rows.clear();
    rows.set(1, ownRow);

    const result = await createLicenseService({
      query: sharedQuery,
      now: () => new Date('2026-05-01T10:00:00.000Z'),
      device,
      fetchRemoteLicense: async () => { throw new Error('offline'); },
    }).resolveState({ force: true, allowRemote: true });
    expect(result.source).toBe('cache');
    expect(result.license.canEnter).toBe(true);
    expect(rows.has(ownId)).toBe(true); // se pasó a la fila de este equipo
  });

  it('al formatear libera este equipo de la licencia que tenía en caché', async () => {
    const state = createMockQueryState();
    const query = createMockQuery(state);
    const device = { deviceId: 'npd_test_9', hostname: 'POS-09', platform: 'win32', arch: 'x64' };
    const released = [];

    const service = createLicenseService({
      query,
      now: () => new Date('2026-04-30T10:00:00.000Z'),
      device,
      fetchRemoteLicense: async () => buildRemoteLicense({
        deviceId: device.deviceId,
        secret: process.env.TECNO_CAJA_LICENSE_HMAC_SECRET,
      }),
      updateRemoteDevice: async () => ({ allowed: true, activeCount: 1, limit: 1 }),
      releaseRemoteDevice: async (licenseId, deviceId) => { released.push({ licenseId, deviceId }); },
    });
    await service.resolveState({ force: true, allowRemote: true });

    const result = await service.releaseCurrentDevice('');

    expect(result).toEqual({ released: true, licenseId: 'lic_demo_1' });
    expect(released).toEqual([{ licenseId: 'lic_demo_1', deviceId: 'npd_test_9' }]);
  });

  it('el formateo sigue aunque Firebase no responda al liberar el equipo', async () => {
    const state = createMockQueryState();
    const service = createLicenseService({
      query: createMockQuery(state),
      device: { deviceId: 'npd_test_10', hostname: 'POS-10', platform: 'win32', arch: 'x64' },
      releaseRemoteDevice: async () => { throw new Error('offline'); },
    });

    await expect(service.releaseCurrentDevice('lic_demo_1'))
      .resolves.toEqual({ released: false, licenseId: 'lic_demo_1', reason: 'offline' });
    await expect(service.releaseCurrentDevice('')).resolves.toEqual({ released: false, reason: 'no_license' });
  });
});
