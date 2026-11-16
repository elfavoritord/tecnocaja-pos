'use strict';
// Modo demostración del servidor de prueba (TECNO_CAJA_DEMO=1 desde el código
// fuente): siempre deja entrar y nunca consulta la nube. Sin él, una PC sin
// autorización sigue bloqueada como siempre.
const fs = require('fs');
const path = require('path');
const { createLicenseService } = require('../../server/licensing/license-service');

function queryFalsa() {
  const config = {
    id: 1, business_name: 'Colmado de Prueba', setup_completed: 1, plan_code: 'basico',
    business_structure_mode: 'monocaja', license_status: 'trial',
    trial_started_at: '2026-11-15 10:00:00', trial_ends_at: '2026-12-15 10:00:00',
  };
  return async (sql) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s.startsWith('CREATE TABLE IF NOT EXISTS license_cache')) return [];
    if (s.includes('FROM config')) return [config];
    if (s.includes('SELECT firebase_uid')) return [];
    if (s.includes('FROM license_cache')) return [];
    if (s.startsWith('UPDATE config')) return { affectedRows: 1 };
    if (s.startsWith('INSERT INTO license_cache')) return { affectedRows: 1 };
    throw new Error(`SQL inesperado: ${s}`);
  };
}

const ahora = () => new Date('2026-11-16T12:00:00Z');

test('modo demo: entra sin nube y nunca la consulta', async () => {
  const fetchRemoteLicense = jest.fn(async () => { throw new Error('no debía consultar la nube'); });
  const servicio = createLicenseService({ query: queryFalsa(), now: ahora, demoMode: true, fetchRemoteLicense });
  const { license, source } = await servicio.resolveState({ force: true });
  expect(source).toBe('demo');
  expect(license).toMatchObject({ canEnter: true, blockedCode: null, status: 'trial', message: null });
  expect(fetchRemoteLicense).not.toHaveBeenCalled();
});

test('sin modo demo, una PC sin autorización sigue bloqueada', async () => {
  const fetchRemoteLicense = jest.fn(async () => { throw Object.assign(new Error('sin nube'), { code: 'CLOUD_REGISTRATION_REQUIRED' }); });
  const servicio = createLicenseService({ query: queryFalsa(), now: ahora, fetchRemoteLicense });
  const { license } = await servicio.resolveState({ force: true });
  expect(license.canEnter).toBe(false);
  expect(license.blockedCode).toBe('activation_required');
});

test('server.js solo enciende el modo demo fuera del instalador (app.asar)', () => {
  const fuente = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  expect(fuente).toMatch(/const LICENCIA_DEMO = process\.env\.TECNO_CAJA_DEMO === '1' && !\/app\\\.asar\/i\.test\(__dirname\);/);
  expect(fuente).toMatch(/demoMode: LICENCIA_DEMO/);
});
