'use strict';

/**
 * La llave de Backblaze de cada cliente (scripts/create-business-b2-key.js)
 * solo puede listar dentro de backups/<licencia>/. La comprobación de "nube
 * disponible" listaba el bucket entero sin prefijo: con esa llave daba acceso
 * denegado y la pantalla de Respaldos escondía la nube (solo se veía lo local),
 * aunque los respaldos sí se subían.
 */

const fs = require('fs');
const path = require('path');

jest.mock('@aws-sdk/client-s3', () => {
  class Command { constructor(input) { this.input = input; } }
  return {
    S3Client: class {
      async send(command) {
        // Igual que una llave restringida a backups/pos_cliente/.
        const prefix = command.input?.Prefix || '';
        if (!prefix.startsWith('backups/pos_cliente/')) {
          throw Object.assign(new Error('not entitled'), { name: 'AccessDenied' });
        }
        return { Contents: [{ Key: `${prefix}TecnoCaja_Diario_x.tcbak`, Size: 10 }] };
      }
    },
    PutObjectCommand: Command,
    GetObjectCommand: Command,
    ListObjectsV2Command: Command,
    DeleteObjectCommand: Command,
    HeadBucketCommand: Command,
    HeadObjectCommand: Command,
  };
});

describe('nube con la llave restringida de un cliente', () => {
  let r2;
  beforeAll(() => {
    Object.assign(process.env, {
      R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secreto', R2_BUCKET: 'tecnocaja',
      R2_ENDPOINT: 'https://s3.us-east-005.backblazeb2.com',
    });
    r2 = require('../../server/services/r2-storage');
  });

  test('sin prefijo (como antes) la llave del cliente da acceso denegado', async () => {
    await expect(r2.isR2Available(true)).rejects.toThrow('not entitled');
  });

  test('dentro de la carpeta del negocio sí está disponible y lista sus respaldos', async () => {
    const prefix = r2.backupPrefix('pos_cliente');
    await expect(r2.isR2Available(true, prefix)).resolves.toBe(true);
    expect((await r2.listObjects(prefix)).map((o) => o.Key)).toEqual(['backups/pos_cliente/TecnoCaja_Diario_x.tcbak']);
    expect(r2.isConfigured()).toBe(true);
  });

  test('la pantalla de Respaldos comprueba la nube con la carpeta del negocio', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'routes', 'respaldos.routes.js'), 'utf8');
    expect(src).toContain('r2.isR2Available(false, r2.backupPrefix(await resolveBusinessId(query)))');
    expect(src).not.toMatch(/r2\.isR2Available\(\)/);
  });
});
