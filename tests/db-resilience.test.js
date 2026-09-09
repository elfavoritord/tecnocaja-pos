/**
 * Resiliencia de la capa SQLite:
 *  - descifra con una huella distinta a la viva (fingerprintOverride) — para
 *    el fallback al sidecar .fpr cuando una actualización de Windows / cambio
 *    de RAM rota la huella de la máquina.
 */
const crypto = require('crypto');
const cryptoMod = require('../server/security/local-machine-crypto');
const machineId = require('../server/security/machine-identity');

// Cabecera SQLite válida ("SQLite format 3\0") + relleno, sin NUL literal en
// el fuente (se arma en runtime).
function fakeSqlite(pad = 200, filler = 'x') {
  return Buffer.concat([
    Buffer.from('SQLite format 3'),
    Buffer.from([0]),
    Buffer.from(filler.repeat(pad)),
  ]);
}

describe('local-machine-crypto — descifrado con huella alterna', () => {
  beforeEach(() => {
    process.env.TECNO_CAJA_DB_KEY_SALT = 'a'.repeat(64);
  });

  test('decryptSqliteBuffer acepta fingerprintOverride', () => {
    const plain = fakeSqlite();
    const liveFp = machineId.getStableMachineFingerprint();
    const enc = cryptoMod.encryptSqliteBuffer(plain); // cifra con la huella viva

    // huella viva: OK
    expect(cryptoMod.decryptSqliteBuffer(enc).equals(plain)).toBe(true);

    // override distinto: falla
    const otraHuella = crypto.createHash('sha256').update('otra-maquina').digest('hex');
    expect(() => cryptoMod.decryptSqliteBuffer(enc, { fingerprintOverride: otraHuella }))
      .toThrow(/descifrar/i);

    // override == huella viva: vuelve a andar
    expect(cryptoMod.decryptSqliteBuffer(enc, { fingerprintOverride: liveFp }).equals(plain)).toBe(true);
  });

  test('escenario real: la huella viva cambió, el sidecar .fpr tiene la vieja', () => {
    const plain = fakeSqlite(300, 'y');
    const oldFp = crypto.createHash('sha256').update('huella-antes-del-update-windows').digest('hex');
    const key = cryptoMod.deriveMachineBoundKey({
      purpose: 'sqlite-at-rest',
      secretEnvKeys: ['TECNO_CAJA_DB_KEY_SALT'],
      fingerprintOverride: oldFp,
    });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    const enc = Buffer.concat([Buffer.from('NVPDB1'), Buffer.from([1]), iv, tag, body]);

    // huella viva NO descifra
    expect(() => cryptoMod.decryptSqliteBuffer(enc)).toThrow();
    // con el override de .fpr sí
    expect(cryptoMod.decryptSqliteBuffer(enc, { fingerprintOverride: oldFp }).equals(plain)).toBe(true);
  });
});
