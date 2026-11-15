'use strict';
const { crearBaseSqlite } = require('../multisucursal/sqlite-helper');
const { repairTrialDates } = require('../../server/licensing/trial-repair');
let base;
beforeEach(async () => {
  base = await crearBaseSqlite();
  await base.query('CREATE TABLE license_cache (id INTEGER PRIMARY KEY, cache_blob TEXT)');
  await base.query("INSERT INTO license_cache VALUES (1, 'autorizacion-original-del-equipo')");
  await base.query("UPDATE config SET setup_completed_at='2026-11-01 10:00:00', trial_started_at='2026-11-02 10:00:00', trial_ends_at='2027-01-01 10:00:00', license_status='trial' WHERE id=1");
});
afterEach(() => base.close());

test('corrige fechas de una copia antigua sin eliminar la autorización del mismo equipo', async () => {
  const result = await repairTrialDates({ query: base.query, now: new Date('2026-11-14T10:00:00Z') });
  expect(result.repaired).toBe(true);
  expect(await base.query('SELECT cache_blob FROM license_cache')).toEqual([{ cache_blob: 'autorizacion-original-del-equipo' }]);
  const [config] = await base.query('SELECT trial_started_at, trial_ends_at FROM config WHERE id=1');
  expect(config).toEqual({ trial_started_at: '2026-11-01 10:00:00', trial_ends_at: '2026-12-01 10:00:00' });
});
test('repetir la recuperación de fechas no prolonga el período ni borra la caché', async () => {
  await repairTrialDates({ query: base.query, now: new Date('2026-12-03T10:00:00Z') });
  const result = await repairTrialDates({ query: base.query, now: new Date('2026-12-04T10:00:00Z') });
  expect(result.repaired).toBe(false);
  expect((await base.query('SELECT trial_ends_at FROM config'))[0].trial_ends_at).toBe('2026-12-01 10:00:00');
  expect((await base.query('SELECT COUNT(*) AS total FROM license_cache'))[0].total).toBe(1);
});
test('si no existe una autorización previa no genera una al reparar fechas', async () => {
  await base.query('DELETE FROM license_cache');
  await repairTrialDates({ query: base.query });
  expect((await base.query('SELECT COUNT(*) AS total FROM license_cache'))[0].total).toBe(0);
});
test('una licencia activa no se modifica por la reparación de pruebas', async () => {
  await base.query("UPDATE config SET license_status='active'");
  expect((await repairTrialDates({ query: base.query })).repaired).toBe(false);
  expect((await base.query('SELECT trial_ends_at FROM config'))[0].trial_ends_at).toBe('2027-01-01 10:00:00');
});
