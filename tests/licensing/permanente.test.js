'use strict';

// Licencia permanente y servicios separados, con el servicio real de licencias del POS.

const { createLicenseService, normalizeLicenseStatus } = require('../../server/licensing/license-service');
const { createLicenciaSucursal } = (() => {
  try { return require('../../server/multisucursal/licencia-sucursal'); } catch (_e) { return {}; }
})();

const PERMANENTE = 'LIFETIME_NO_SUBSCRIPTION';
const device = { deviceId: 'npd_perm_1', hostname: 'POS-01', platform: 'win32', arch: 'x64' };

function basePos() {
  const estado = {
    config: {
      id: 1, business_name: 'Demo', setup_completed: 1, plan_code: 'basico', business_structure_mode: 'monocaja',
      license_status: 'active', trial_started_at: null, trial_ends_at: null,
    },
    cache: null,
  };
  const query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s.startsWith('CREATE TABLE IF NOT EXISTS license_cache')) return [];
    if (s.includes('SELECT id, business_name, setup_completed, plan_code')) return [estado.config];
    if (s.includes('SELECT trial_started_at, trial_ends_at, license_status, setup')) return [estado.config];
    if (s.includes('SELECT firebase_uid')) return [];
    if (s.includes('SELECT cache_blob, integrity_hash FROM license_cache')) return estado.cache ? [estado.cache] : [];
    if (s.startsWith('INSERT INTO license_cache')) { estado.cache = { cache_blob: params[1], integrity_hash: params[2] }; return {}; }
    if (s.startsWith('UPDATE config SET license_status = ?')) { estado.config.license_status = params[0]; return {}; }
    throw new Error(`SQL inesperado: ${s}`);
  };
  return { estado, query };
}

function remota(extra = {}) {
  const docData = {
    modalidad: PERMANENTE,
    servicios: {
      ecf: { estado: 'inactivo', venceEn: null },
      soporte: { estado: 'inactivo', venceEn: null },
      respaldoLocal: { estado: 'activo', venceEn: null },
      respaldoNube: { estado: 'activo', venceEn: null },
      actualizaciones: { estado: 'activo', venceEn: null },
    },
    ...extra.docData,
  };
  return {
    id: 'lic_perm', businessName: 'Demo', status: 'active', planCode: 'basico', issuedAt: new Date('2024-01-01T00:00:00Z'),
    expiresAt: null, deviceLimit: 1, devices: {}, docData, ...extra.campos,
  };
}

function servicio(pos, { now, remote, updateRemoteDevice }) {
  return createLicenseService({
    query: pos.query,
    now: () => now.valor,
    device,
    fetchRemoteLicense: remote,
    updateRemoteDevice: updateRemoteDevice || (async () => ({ allowed: true, activeCount: 1, limit: 1 })),
    persistRemoteUid() {},
    logger: { warn() {}, error() {}, log() {} },
  });
}

let entorno;
beforeEach(() => {
  entorno = { ...process.env };
  process.env.TECNO_CAJA_LICENSE_REQUIRE_SIGNATURE = 'false';
  process.env.TECNO_CAJA_LICENSE_STORAGE_SECRET = 'storage-secret-test';
  process.env.TECNO_CAJA_DB_KEY_SALT = 'salt-test';
  process.env.TECNO_CAJA_DEVICE_SECRET = 'device-secret-test';
});
afterEach(() => { process.env = entorno; });

describe('licencia permanente', () => {
  test('activa, sin vencer ni pedir renovación', async () => {
    const pos = basePos();
    const now = { valor: new Date('2031-05-05T00:00:00Z') };
    const { license } = await servicio(pos, { now, remote: async () => remota() }).resolveState({ force: true });
    expect(license).toMatchObject({ canEnter: true, status: 'active', modalidad: PERMANENTE, expired: false, blockedCode: null, expiresAt: null });
    expect(license.servicios.ecf.permitido).toBe(false);
    expect(license.servicios.respaldoNube.permitido).toBe(true);
    expect(license.servicios.actualizaciones.permitido).toBe(true);
  });

  test('aunque le quede una fecha vieja de cuando era prueba, no vence', async () => {
    const pos = basePos();
    const now = { valor: new Date('2031-05-05T00:00:00Z') };
    const { license } = await servicio(pos, {
      now,
      remote: async () => remota({ campos: { expiresAt: new Date('2025-01-01T00:00:00Z') } }),
    }).resolveState({ force: true });
    expect(license.canEnter).toBe(true);
    expect(license.status).toBe('active');
  });

  test('funciona años sin Internet y con el reloj atrasado', async () => {
    const pos = basePos();
    const now = { valor: new Date('2026-11-02T00:00:00Z') };
    await servicio(pos, { now, remote: async () => remota() }).resolveState({ force: true });

    now.valor = new Date('2035-01-01T00:00:00Z');
    const sinRed = await servicio(pos, { now, remote: async () => { throw new Error('sin red'); } }).resolveState({ force: true });
    expect(sinRed.license.canEnter).toBe(true);
    expect(sinRed.license.modalidad).toBe(PERMANENTE);

    now.valor = new Date('2020-01-01T00:00:00Z');
    const atrasado = await servicio(pos, { now, remote: async () => { throw new Error('sin red'); } }).resolveState({ force: true });
    expect(atrasado.license.canEnter).toBe(true);
  });

  test('en un equipo no autorizado no entra, pero no aparece como vencida', async () => {
    const pos = basePos();
    const now = { valor: new Date('2026-11-02T00:00:00Z') };
    const { license } = await servicio(pos, {
      now,
      remote: async () => remota(),
      updateRemoteDevice: async () => ({ allowed: false, activeCount: 1, limit: 1 }),
    }).resolveState({ force: true });
    expect(license.canEnter).toBe(false);
    expect(license.blockedCode).toBe('device_limit');
    expect(license.expired).toBe(false);
  });

  test('el caché alterado se detecta', async () => {
    const pos = basePos();
    const now = { valor: new Date('2026-11-02T00:00:00Z') };
    await servicio(pos, { now, remote: async () => remota() }).resolveState({ force: true });
    pos.estado.cache.cache_blob = `${pos.estado.cache.cache_blob}x`;
    const { license } = await servicio(pos, { now, remote: async () => { throw new Error('sin red'); } }).resolveState({ force: true });
    expect(license.canEnter).toBe(false);
    expect(license.blockedCode).toBe('tamper');
  });
});

describe('suscripción: las reglas de siempre', () => {
  const mensual = (expiresAt) => remota({ campos: { expiresAt }, docData: { modalidad: 'mensual' } });

  test('vence en su fecha', async () => {
    const pos = basePos();
    const now = { valor: new Date('2026-12-05T00:00:00Z') };
    const { license } = await servicio(pos, { now, remote: async () => mensual(new Date('2026-12-02T00:00:00Z')) }).resolveState({ force: true });
    expect(license.canEnter).toBe(false);
    expect(license.blockedCode).toBe('expired');
  });

  test('atrasar el reloj no recupera una licencia vencida', async () => {
    const pos = basePos();
    const now = { valor: new Date('2026-12-05T00:00:00Z') };
    await servicio(pos, { now, remote: async () => mensual(new Date('2026-12-02T00:00:00Z')) }).resolveState({ force: true });
    now.valor = new Date('2026-11-20T00:00:00Z');
    const { license } = await servicio(pos, { now, remote: async () => { throw new Error('sin red'); } }).resolveState({ force: true });
    expect(license.canEnter).toBe(false);
    expect(license.blockedCode).toBe('clock_rollback');
  });

  test('al volver Internet con el pago hecho, entra', async () => {
    const pos = basePos();
    const now = { valor: new Date('2026-12-05T00:00:00Z') };
    await servicio(pos, { now, remote: async () => mensual(new Date('2026-12-02T00:00:00Z')) }).resolveState({ force: true });
    const { license } = await servicio(pos, { now, remote: async () => mensual(new Date('2027-01-02T00:00:00Z')) }).resolveState({ force: true });
    expect(license.canEnter).toBe(true);
  });
});

test('una licencia cancelada desde el panel ya no pasa por prueba', () => {
  expect(normalizeLicenseStatus('cancelled')).toBe('suspended');
  expect(normalizeLicenseStatus('active')).toBe('active');
  expect(normalizeLicenseStatus('algo')).toBe('trial');
});

describe('e-CF', () => {
  async function conServicio(ecf, nowIso) {
    const pos = basePos();
    const now = { valor: new Date(nowIso) };
    const s = servicio(pos, { now, remote: async () => remota({ docData: { servicios: ecf ? { ecf } : null } }) });
    await s.resolveState({ force: true });
    return { s, now };
  }

  test('licencia sin contrato: sigue emitiendo como hasta hoy', async () => {
    const { s } = await conServicio(null, '2026-11-02T00:00:00Z');
    expect(s.ecfPermitido()).toBe(true);
  });

  test('sin datos en memoria todavía: no frena la venta', () => {
    const pos = basePos();
    expect(servicio(pos, { now: { valor: new Date() }, remote: async () => null }).ecfPermitido()).toBe(true);
  });

  test('contratado: emite hasta su fecha, sin consultar nada', async () => {
    const { s, now } = await conServicio({ estado: 'activo', venceEn: '2026-12-01T00:00:00Z' }, '2026-11-02T00:00:00Z');
    expect(s.ecfPermitido()).toBe(true);
    now.valor = new Date('2026-12-02T00:00:00Z');
    expect(s.ecfPermitido()).toBe(false);
  });

  test('suspendido o no contratado: no emite y la licencia sigue activa', async () => {
    const { s } = await conServicio({ estado: 'suspendido', venceEn: null }, '2026-11-02T00:00:00Z');
    expect(s.ecfPermitido()).toBe(false);
    const { license } = await s.resolveState();
    expect(license.canEnter).toBe(true);
  });
});

test('la venta se frena con un mensaje claro cuando el e-CF no está activo', async () => {
  const { createEcfService } = require('../../modules/ecf/services/ecf.service');
  const svc = createEcfService({ query: async () => [], addColumnIfMissing: async () => {}, writeAuditLog: async () => {} });
  svc.repository = { usableSequences: async () => [] };
  svc.servicioPermitido = () => false;
  await expect(svc.assertSaleHasSequence({ requestedType: 'E32', buyerTaxId: '' })).rejects.toMatchObject({ code: 'ECF_SERVICIO_INACTIVO' });
  // Permitido: sigue a la revisión normal de secuencias.
  svc.servicioPermitido = () => true;
  await expect(svc.assertSaleHasSequence({ requestedType: 'E32', buyerTaxId: '' })).rejects.toMatchObject({ code: 'ECF_SIN_SECUENCIA' });
});

if (createLicenciaSucursal) {
  test('la PC de sucursal se rige por el contrato de la empresa', async () => {
    const sucursal = createLicenciaSucursal({
      getEnlace: () => ({ estado: async () => ({ tieneToken: true, estado: 'activo', sucursal: { esPrincipal: false }, empresa: { licenseId: 'empresa' } }) }),
      leerLicencia: async () => ({
        status: 'active', planCode: 'plus', modalidad: PERMANENTE, servicios: { ecf: { estado: 'activo', venceEn: null } },
      }),
      getLicenciaPropia: () => 'propia',
      logger: { warn() {} },
    });
    const r = await sucursal.combinar({ id: 'propia', devices: {}, docData: {} });
    expect(r.docData.modalidad).toBe(PERMANENTE);
    expect(r.docData.servicios.ecf.estado).toBe('activo');
  });
}
