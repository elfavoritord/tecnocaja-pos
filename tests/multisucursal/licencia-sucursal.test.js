'use strict';

/**
 * Una PC de sucursal enlazada trabaja con la licencia de la EMPRESA
 * (server/multisucursal/licencia-sucursal.js) a través del servicio de
 * licencias real (server/licensing/license-service.js), con Firestore simulado.
 */

const { createLicenseService } = require('../../server/licensing/license-service');
const { createLicenciaSucursal } = require('../../server/multisucursal/licencia-sucursal');

const PROPIA = 'pos_pc_norte';
const EMPRESA = 'pos_empresa_bravo';

function baseLocal() {
  const state = {
    configRow: {
      id: 1, business_name: 'Bravo · Norte', setup_completed: 1, plan_code: 'basico', business_structure_mode: 'monocaja',
      license_status: 'trial', trial_started_at: '2026-10-19 10:00:00', trial_ends_at: '2026-11-18 10:00:00',
    },
    licenseCache: null,
  };
  const query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s.startsWith('CREATE TABLE IF NOT EXISTS license_cache')) return [];
    if (s.includes('SELECT id, business_name, setup_completed, plan_code')) return [state.configRow];
    if (s.includes('SELECT trial_started_at, trial_ends_at, license_status, setup_completed')) return [state.configRow];
    if (s.includes('SELECT firebase_uid')) return [];
    if (s.includes('SELECT cache_blob, integrity_hash FROM license_cache')) return state.licenseCache ? [state.licenseCache] : [];
    if (s.startsWith('INSERT INTO license_cache')) { state.licenseCache = { cache_blob: params[1], integrity_hash: params[2] }; return { affectedRows: 1 }; }
    if (s.startsWith('UPDATE config SET license_status = ?')) {
      Object.assign(state.configRow, { license_status: params[0], plan_code: params[1], business_structure_mode: params[3] });
      return { affectedRows: 1 };
    }
    throw new Error(`SQL inesperado: ${s}`);
  };
  return { state, query };
}

// Lo que devuelve fetchRemotePosLicenseState para el documento propio de la PC.
function licenciaPropia() {
  return {
    id: PROPIA, licenseId: PROPIA, status: 'trial', planCode: 'pro',
    expiresAt: new Date('2026-11-18T10:00:00.000Z'), trialEndsAt: new Date('2026-11-18T10:00:00.000Z'),
    deviceLimit: 1, devices: {},
    docData: { status: 'trial', planCode: 'pro', trialEndsAt: new Date('2026-11-18T10:00:00.000Z'), deviceLimit: 1, sucursalDe: { licenseId: EMPRESA } },
  };
}

describe('Licencia de una PC de sucursal', () => {
  let envAntes;
  let enlace;
  let empresa;
  let leer;

  beforeEach(() => {
    envAntes = { ...process.env };
    for (const k of ['TECNO_CAJA_LICENSE_HMAC_SECRET', 'TECNO_CAJA_LICENSE_PUBLIC_KEY', 'TECNO_CAJA_LICENSE_REQUIRE_SIGNATURE']) delete process.env[k];
    process.env.TECNO_CAJA_LICENSE_STORAGE_SECRET = 'storage-secret-test';
    process.env.TECNO_CAJA_DEVICE_SECRET = 'device-secret-test';
    process.env.TECNO_CAJA_DB_KEY_SALT = 'salt-test';
    enlace = {
      tieneToken: true, estado: 'vinculado',
      empresa: { licenseId: EMPRESA, nombre: 'Bravo' }, sucursal: { nombre: 'Norte', esPrincipal: false },
    };
    empresa = { status: 'active', planCode: 'plus', expiresAt: null, trialEndsAt: null, deviceLimit: 1, devices: { npd_principal: {} } };
    leer = jest.fn(async (id) => (id === EMPRESA ? empresa : null));
  });

  afterEach(() => { process.env = envAntes; });

  function crear({ query, now = () => new Date('2026-10-20T12:00:00.000Z'), fallaLectura = false } = {}) {
    const licencia = createLicenciaSucursal({
      getEnlace: () => ({ estado: async () => enlace }),
      leerLicencia: fallaLectura ? async () => { throw new Error('sin red'); } : leer,
      getLicenciaPropia: () => PROPIA,
      logger: { warn() {} },
    });
    const persistidos = [];
    const registros = [];
    const service = createLicenseService({
      query,
      now,
      device: { deviceId: 'npd_norte', hostname: 'CAJA-NORTE', platform: 'win32', arch: 'x64' },
      fetchRemoteLicense: async () => licencia.combinar(licenciaPropia()),
      updateRemoteDevice: async (remota) => { registros.push(remota); return { allowed: true, activeCount: 1, limit: 0 }; },
      persistRemoteUid: (uid) => persistidos.push(uid),
    });
    return { licencia, service, persistidos, registros };
  }

  test('trabaja con el plan y el estado de la empresa, sin vencimiento ni límite de equipos', async () => {
    const { query, state } = baseLocal();
    const { service, persistidos, registros } = crear({ query });
    const r = await service.resolveState({ force: true });
    expect(r.license).toMatchObject({ status: 'active', planCode: 'plus', canEnter: true, expiresAt: null, licenseId: PROPIA });
    expect(leer).toHaveBeenCalledWith(EMPRESA);
    // El id que se guarda sigue siendo el de la PC (nunca el de la empresa).
    expect(persistidos).toEqual([PROPIA]);
    expect(registros[0]).toMatchObject({ licenseId: PROPIA, deviceLimit: 0 });
    expect(state.configRow).toMatchObject({ license_status: 'active', plan_code: 'plus' });
  });

  test('si Emilio suspende la empresa, la sucursal también queda suspendida', async () => {
    empresa = { ...empresa, status: 'suspended' };
    const { query } = baseLocal();
    const r = await crear({ query }).service.resolveState({ force: true });
    expect(r.license).toMatchObject({ status: 'suspended', canEnter: false, blockedCode: 'suspended' });
  });

  test('sin poder leer la licencia de la empresa usa la copia guardada (no la prueba propia)', async () => {
    const { query } = baseLocal();
    await crear({ query }).service.resolveState({ force: true });
    const r = await crear({ query, fallaLectura: true }).service.resolveState({ force: true });
    expect(r.source).toBe('cache');
    expect(r.license).toMatchObject({ status: 'active', planCode: 'plus', canEnter: true });
  });

  test.each([
    ['la principal', () => { enlace.sucursal.esPrincipal = true; }],
    ['sin enlazar', () => { enlace.tieneToken = false; }],
    ['reemplazada', () => { enlace.estado = 'reemplazado'; }],
    ['revocada', () => { enlace.estado = 'revocado'; }],
    ['la empresa es su propia licencia', () => { enlace.empresa.licenseId = PROPIA; }],
  ])('%s: usa su propia licencia', async (_nombre, preparar) => {
    preparar();
    const { query } = baseLocal();
    const r = await crear({ query }).service.resolveState({ force: true });
    expect(r.license).toMatchObject({ status: 'trial', licenseId: PROPIA });
    expect(leer).not.toHaveBeenCalled();
  });

  test('vigila la licencia de la empresa una sola vez y suelta al desvincular', async () => {
    const { licencia } = crear(baseLocal());
    const cancelar = jest.fn();
    const suscribir = jest.fn(() => cancelar);
    expect(await licencia.vigilar(suscribir, () => {})).toBe(true);
    expect(await licencia.vigilar(suscribir, () => {})).toBe(true);
    expect(suscribir).toHaveBeenCalledTimes(1);
    expect(suscribir).toHaveBeenCalledWith(EMPRESA, expect.any(Function));
    enlace.tieneToken = false;
    expect(await licencia.vigilar(suscribir, () => {})).toBe(false);
    expect(cancelar).toHaveBeenCalledTimes(1);
  });
});
