'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  hasPendingFactoryReset,
  runPendingFactoryReset,
  scheduleFactoryReset,
} = require('../../server/services/factory-reset.service');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, content = 'x') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

describe('server/services/factory-reset.service', () => {
  let envSnapshot;
  let userDataPath;
  let documentsDir;
  let workingDir;

  beforeEach(() => {
    envSnapshot = { ...process.env };
    userDataPath = makeTempDir('tecnocaja-user-');
    documentsDir = makeTempDir('tecnocaja-docs-');
    workingDir = makeTempDir('tecnocaja-cwd-');
  });

  afterEach(() => {
    process.env = envSnapshot;
  });

  it('no hace nada si no hay formateo pendiente', () => {
    writeFile(path.join(userDataPath, 'facturas', 'f1.pdf'));

    const summary = runPendingFactoryReset({ userDataPath, documentsDir, workingDir });

    expect(summary.ran).toBe(false);
    expect(fs.existsSync(path.join(userDataPath, 'facturas', 'f1.pdf'))).toBe(true);
  });

  it('borra datos, respaldos e identidad del equipo y conserva la config de infraestructura', () => {
    const outsideDb = path.join(makeTempDir('tecnocaja-db-'), 'negocio.db');
    writeFile(outsideDb);
    writeFile(`${outsideDb}.fpr`);
    writeFile(`${outsideDb}.corrupt_123`);
    const unrelatedFile = path.join(path.dirname(outsideDb), 'otro-programa.db');
    writeFile(unrelatedFile);

    for (const relative of [
      'data/tecnocaja.db', 'uploads/productos/p1.jpg', 'secure-backups/tecnocaja-secure-backup.novaseguro',
      'facturas/negocio/f1.pdf', 'reportes/2026-04/r.json', 'storage/ecf/enviados/e.xml',
      'ecf/certificates/business-1-active.p12', 'Sistema_Data/Backups_Base_Datos/a.tcbak', 'logs/server.log',
      'ecf-sequence-high-watermarks.json', 'config/terminal-config.json', 'config/peripherals-config.json',
    ]) {
      writeFile(path.join(userDataPath, relative));
    }
    writeFile(path.join(documentsDir, 'TecnoCaja', 'Backups', 'auto.tcbak'));
    writeFile(path.join(workingDir, '.wwebjs_auth_pos', 'session-tecno-caja-pos-bot', 'Default', 'Cookies'));
    writeFile(path.join(userDataPath, 'config', 'app.env'), [
      '# Configuracion local de Tecno Caja',
      'DB_CLIENT=mysql',
      'DB_PASSWORD=clave-bd',
      'FIREBASE_SERVICE_ACCOUNT_PATH=C:\\app\\firebase-key.json',
      'TECNO_CAJA_LICENSE_UID=lic_negocio_viejo',
      'TECNO_CAJA_BUSINESS_ID=negocio_viejo',
      'TECNO_CAJA_DEVICE_SECRET=secreto-viejo',
      'TECNO_CAJA_DB_KEY_SALT=sal-vieja',
      'R2_SECRET_ACCESS_KEY=llave-r2',
      'R2_BUCKET=tecnocaja-backups',
      'NOVAPOS_LICENSE_UID=lic_legacy',
      '',
    ].join('\n'));
    process.env.TECNO_CAJA_DEVICE_SECRET = 'secreto-viejo';
    process.env.TECNO_CAJA_LICENSE_UID = 'lic_negocio_viejo';
    process.env.NOVAPOS_LICENSE_UID = 'lic_legacy';
    process.env.DB_PASSWORD = 'clave-bd';

    scheduleFactoryReset({ userDataPath, dbFile: outsideDb });
    expect(hasPendingFactoryReset(userDataPath)).toBe(true);

    const summary = runPendingFactoryReset({ userDataPath, documentsDir, workingDir });

    expect(summary.ran).toBe(true);
    expect(summary.failed).toEqual([]);
    for (const relative of [
      'data', 'uploads', 'secure-backups', 'facturas', 'reportes', 'storage', 'ecf', 'Sistema_Data', 'logs',
      'ecf-sequence-high-watermarks.json', 'config/terminal-config.json', 'config/peripherals-config.json',
    ]) {
      expect(fs.existsSync(path.join(userDataPath, relative))).toBe(false);
    }
    expect(fs.existsSync(path.join(documentsDir, 'TecnoCaja'))).toBe(false);
    expect(fs.existsSync(path.join(workingDir, '.wwebjs_auth_pos'))).toBe(false);
    expect(fs.existsSync(outsideDb)).toBe(false);
    expect(fs.existsSync(`${outsideDb}.fpr`)).toBe(false);
    expect(fs.existsSync(`${outsideDb}.corrupt_123`)).toBe(false);
    expect(fs.existsSync(unrelatedFile)).toBe(true);
    expect(hasPendingFactoryReset(userDataPath)).toBe(false);

    const env = fs.readFileSync(path.join(userDataPath, 'config', 'app.env'), 'utf8');
    expect(env).toContain('DB_CLIENT=mysql');
    expect(env).toContain('DB_PASSWORD=clave-bd');
    expect(env).toContain('FIREBASE_SERVICE_ACCOUNT_PATH=C:\\app\\firebase-key.json');
    expect(env).toContain('R2_BUCKET=tecnocaja-backups');
    expect(env).toMatch(/^TECNO_CAJA_LICENSE_UID=$/m);
    expect(env).toMatch(/^TECNO_CAJA_BUSINESS_ID=$/m);
    expect(env).toMatch(/^TECNO_CAJA_DEVICE_SECRET=$/m);
    expect(env).toMatch(/^TECNO_CAJA_DB_KEY_SALT=$/m);
    expect(env).toMatch(/^R2_SECRET_ACCESS_KEY=$/m);
    expect(env).not.toContain('NOVAPOS_');
    expect(env).not.toContain('lic_negocio_viejo');

    expect(process.env.TECNO_CAJA_DEVICE_SECRET).toBeUndefined();
    expect(process.env.TECNO_CAJA_LICENSE_UID).toBeUndefined();
    expect(process.env.NOVAPOS_LICENSE_UID).toBeUndefined();
    expect(process.env.DB_PASSWORD).toBe('clave-bd');
  });

  it('ignora un dbFile del marcador que no sea un archivo .db', () => {
    const notADb = path.join(makeTempDir('tecnocaja-misc-'), 'documento.txt');
    writeFile(notADb);

    scheduleFactoryReset({ userDataPath, dbFile: notADb });
    runPendingFactoryReset({ userDataPath, documentsDir, workingDir });

    expect(fs.existsSync(notADb)).toBe(true);
  });
});
