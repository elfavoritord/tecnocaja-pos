/**
 * tests/security/backup-crypto.test.js
 *
 * Valida el contrato público del módulo de cifrado de respaldos.
 */

'use strict';

const {
  encryptBackupPayload,
  decryptBackupPayload,
  LEGACY_DEFAULT_SECURITY_PASSWORD
} = require('../../server/security/backup-crypto');

describe('backup-crypto', () => {
  const samplePayload = {
    version: 1,
    exportedAt: '2026-04-23T12:00:00Z',
    data: {
      users: [{ id: 1, name: 'Emilio' }],
      sales: [{ id: 10, total: 1250.5 }]
    }
  };

  describe('encryptBackupPayload', () => {
    it('produce JSON válido con los campos esperados', () => {
      const out = encryptBackupPayload(samplePayload, 'clave-fuerte-123');
      const parsed = JSON.parse(out);

      expect(parsed.version).toBe(1);
      expect(parsed.algorithm).toBe('aes-256-gcm');
      expect(typeof parsed.createdAt).toBe('string');
      expect(typeof parsed.salt).toBe('string');
      expect(typeof parsed.iv).toBe('string');
      expect(typeof parsed.tag).toBe('string');
      expect(typeof parsed.content).toBe('string');
    });

    it('lanza si no se provee password', () => {
      expect(() => encryptBackupPayload(samplePayload, '')).toThrow();
      expect(() => encryptBackupPayload(samplePayload)).toThrow();
    });

    it('genera salts/IVs distintos en cada cifrado (no determinista)', () => {
      const a = JSON.parse(encryptBackupPayload(samplePayload, 'abc'));
      const b = JSON.parse(encryptBackupPayload(samplePayload, 'abc'));
      expect(a.salt).not.toBe(b.salt);
      expect(a.iv).not.toBe(b.iv);
      expect(a.content).not.toBe(b.content);
    });
  });

  describe('decryptBackupPayload', () => {
    it('round-trip: descifra lo que se cifró', () => {
      const encrypted = encryptBackupPayload(samplePayload, 'password-de-prueba');
      const decrypted = decryptBackupPayload(encrypted, 'password-de-prueba');
      expect(decrypted).toEqual(samplePayload);
    });

    it('acepta objeto ya parseado (no solo string)', () => {
      const encrypted = JSON.parse(encryptBackupPayload(samplePayload, 'abc'));
      const decrypted = decryptBackupPayload(encrypted, 'abc');
      expect(decrypted).toEqual(samplePayload);
    });

    it('lanza si se provee password incorrecto', () => {
      const encrypted = encryptBackupPayload(samplePayload, 'correcta');
      expect(() => decryptBackupPayload(encrypted, 'incorrecta')).toThrow();
    });

    it('fallback: respaldo creado con LEGACY se descifra al pasar password nuevo', () => {
      // Simula un respaldo antiguo creado con la clave legada.
      const encryptedLegacy = encryptBackupPayload(samplePayload, LEGACY_DEFAULT_SECURITY_PASSWORD);

      // Usuario ya rotó a una clave nueva — el decrypt debe hacer fallback.
      const decrypted = decryptBackupPayload(encryptedLegacy, 'clave-rotada-nueva');
      expect(decrypted).toEqual(samplePayload);
    });

    it('lanza si no se provee password', () => {
      const encrypted = encryptBackupPayload(samplePayload, 'abc');
      expect(() => decryptBackupPayload(encrypted, '')).toThrow();
      expect(() => decryptBackupPayload(encrypted)).toThrow();
    });
  });
});
