'use strict';
const policy = require('../../server/services/backup-policy');
const fs = require('fs');
const path = require('path');
const os = require('os');
function queryFor(config, ids = [], custom = null) {
  return async (sql) => /license_cache/.test(sql) ? ids.map((license_id) => ({ license_id })) : /installation_config/.test(sql) ? custom ? [{ config_value: custom }] : [] : [config];
}
test('un ID configurado de otra empresa bloquea la nube y conserva el ID local', async () => {
  const c = await policy.context(queryFor({ business_name: 'Empresa', business_uuid: 'uuid-a' }, ['licencia-a']), { TECNO_CAJA_LICENSE_UID: 'licencia-b' });
  expect(c.licenseUid).toBe('licencia-a');
  expect(c.conflict).toBe(true);
  expect(() => policy.assertCloudIdentity(c)).toThrow(/no coinciden/);
});
test('no atribuye un respaldo a una empresa solo por compartir el nombre', () => {
  expect(() => policy.assertPayload({ businessName: 'Empresa', data: { config: [{ id: 1 }] } }, { licenseUid: 'a', config: {} })).toThrow(/No se comprobó/);
  expect(() => policy.assertPayload({ licenseUid: 'b' }, { licenseUid: 'a', config: {} })).toThrow();
  expect(() => policy.assertPayload({ rnc: '123456789' }, { licenseUid: 'a', config: { rnc: '123456789' } })).toThrow();
});
test('respeta la carpeta elegida y separa empresas con igual nombre', async () => {
  const first = await policy.directory(queryFor({ business_name: 'Empresa', business_uuid: 'a' }, [], path.join(os.tmpdir(), 'backups-prueba')));
  const second = await policy.directory(queryFor({ business_name: 'Empresa', business_uuid: 'b' }, [], path.join(os.tmpdir(), 'backups-prueba')));
  expect(first).not.toBe(second);
  expect(first.startsWith(path.join(os.tmpdir(), 'backups-prueba', 'Empresas'))).toBe(true);
});
test('el registro de ubicación conserva identidad y ruta sin copiar credenciales', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-backup-location-'));
  try {
    const metadata = path.join(root, 'config', 'backup-location.json');
    policy.remember(path.join(root, 'respaldo.tcbak'), metadata, { licenseUid: 'a', password: 'no-copiar', secret: 'no-copiar' });
    const saved = JSON.parse(fs.readFileSync(metadata));
    expect(saved.licenseUid).toBe('a'); expect(saved.directory).toBe(root);
    expect(saved.password).toBeUndefined(); expect(saved.secret).toBeUndefined();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
