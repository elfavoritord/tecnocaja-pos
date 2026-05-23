'use strict';

const {
  computeIntegrityHash,
  decryptJsonEnvelope,
  decryptSqliteBuffer,
  encryptJsonEnvelope,
  encryptSqliteBuffer,
  isEncryptedSqliteBuffer,
  isPlainSqliteBuffer,
} = require('../../server/security/local-machine-crypto');

describe('server/security/local-machine-crypto', () => {
  let envSnapshot;

  beforeEach(() => {
    envSnapshot = { ...process.env };
    process.env.TECNO_CAJA_LICENSE_STORAGE_SECRET = 'license-storage-secret-test';
    process.env.TECNO_CAJA_DB_KEY_SALT = 'db-key-salt-test';
    process.env.TECNO_CAJA_DEVICE_SECRET = 'device-secret-test';
  });

  afterEach(() => {
    process.env = envSnapshot;
  });

  it('cifra y descifra el archivo SQLite en reposo', () => {
    const plain = Buffer.concat([
      Buffer.from('SQLite format 3\u0000', 'utf8'),
      Buffer.from('demo-local-db', 'utf8'),
    ]);

    expect(isPlainSqliteBuffer(plain)).toBe(true);

    const encrypted = encryptSqliteBuffer(plain);
    expect(isEncryptedSqliteBuffer(encrypted)).toBe(true);

    const decrypted = decryptSqliteBuffer(encrypted);
    expect(Buffer.compare(decrypted, plain)).toBe(0);
  });

  it('cifra y valida sobres JSON ligados a la máquina', () => {
    const payload = {
      licenseId: 'lic_test_1',
      status: 'active',
      expiresAt: '2026-05-05T12:00:00.000Z',
    };

    const envelope = encryptJsonEnvelope(payload, { purpose: 'license-cache' });
    const hash = computeIntegrityHash(envelope, { purpose: 'license-cache' });

    expect(typeof envelope).toBe('string');
    expect(typeof hash).toBe('string');
    expect(decryptJsonEnvelope(envelope, { purpose: 'license-cache' })).toEqual(payload);
  });

  it('lanza si el sobre JSON fue manipulado', () => {
    const payload = { hello: 'world' };
    const envelope = JSON.parse(encryptJsonEnvelope(payload, { purpose: 'license-cache' }));
    envelope.content = envelope.content.slice(0, -2) + 'ab';

    expect(() => decryptJsonEnvelope(JSON.stringify(envelope), { purpose: 'license-cache' })).toThrow();
  });
});
