'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const format = require('../../server/services/backup-format');
const catalog = require('../../server/services/backup-catalog');
const health = require('../../server/services/backup-health');
let dir, files, oldPassword;
const now = Date.now(), cutoff = new Date(now - 60000).toISOString();
beforeEach(async () => {
  oldPassword = process.env.TECNO_CAJA_SECURITY_PASSWORD; process.env.TECNO_CAJA_SECURITY_PASSWORD = 'fixture-clave';
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-backup-health-'));
  const tables = { config: [{ id: 1, business_uuid: 'uuid-a' }], users: [{ id: 1 }] };
  const payload = { formatVersion: '3', companyUuid: 'uuid-a', licenseUid: 'a', exportedAt: cutoff,
    catalogo: { tablas: tables, manifiesto: Object.entries(tables).map(([nombre, r]) => ({ nombre, registros: r.length, sha256: catalog.hash(r) })) } };
  const file = path.join(dir, 'fixture.tcbak'); fs.writeFileSync(file, await format.createTcbakBuffer(payload, 'fixture-clave'));
  files = [{ path: file, name: 'fixture.tcbak' }];
});
afterEach(() => { if (oldPassword === undefined) delete process.env.TECNO_CAJA_SECURITY_PASSWORD; else process.env.TECNO_CAJA_SECURITY_PASSWORD = oldPassword; fs.rmSync(dir, { recursive: true, force: true }); });
function query({ prefix = 'a', pending = 0, cut = cutoff } = {}) {
  return async (sql) => {
    if (/license_cache/.test(sql)) return [{ license_id: 'a' }];
    if (/SELECT \*/.test(sql)) return [{ id: 1, business_uuid: 'uuid-a' }];
    if (/COUNT/.test(sql)) return [{ total: pending }];
    return [{ file_name: 'fixture.tcbak', created_at: cutoff, storage_path: `backups/${prefix}/fixture.tcbak`, sha256: 'fixture', file_size: 10, observacion: JSON.stringify({ capturedAt: cut }) }];
  };
}
test('una copia íntegra local no oculta que B2 necesita configuración', async () => {
  const result = await health.inspect({ query: query(), files, cloudConfigured: false, cloudAvailable: false, now });
  expect(result.local.integral).toBe(true); expect(result.status).toBe('atencion');
  expect(result.messages.join(' ')).toMatch(/llave propia/);
});
test('un historial exitoso no equivale a confirmar el objeto actual en B2', async () => {
  const result = await health.inspect({ query: query(), files, cloudConfigured: true, cloudAvailable: true, verifyCloud: async () => { throw new Error('NoSuchKey'); }, now });
  expect(result.cloudVerified).toBe(false); expect(result.status).toBe('atencion');
});
test('no muestra un respaldo ajeno como protección de esta empresa', async () => {
  const verifyCloud = jest.fn();
  const result = await health.inspect({ query: query({ prefix: 'otra' }), files, cloudConfigured: true, cloudAvailable: true, verifyCloud, now });
  expect(result.cloud).toBeNull(); expect(verifyCloud).not.toHaveBeenCalled();
});
test('solo confirma el estado completo con fecha reciente, integridad y sin pendientes', async () => {
  const result = await health.inspect({ query: query(), files, cloudConfigured: true, cloudAvailable: true, verifyCloud: async () => ({}), now });
  expect(result.status).toBe('verificado'); expect(result.messages).toEqual([]);
  const old = await health.inspect({ query: query({ cut: new Date(now - 72 * 3600000).toISOString() }), files, cloudConfigured: true, cloudAvailable: true, verifyCloud: async () => ({}), now });
  expect(old.status).toBe('atencion');
});
