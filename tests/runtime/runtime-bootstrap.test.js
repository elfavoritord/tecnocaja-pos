'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('scripts/runtime-bootstrap', () => {
  let envSnapshot;

  beforeEach(() => {
    envSnapshot = { ...process.env };
    jest.resetModules();
  });

  afterEach(() => {
    process.env = envSnapshot;
  });

  it('usa la credencial Firebase empaquetada cuando la ruta configurada no existe', () => {
    const appRoot = makeTempDir('tecnocaja-app-');
    const userDataPath = makeTempDir('tecnocaja-user-');
    const bundledKeyPath = path.join(appRoot, 'firebase-key.json');

    fs.writeFileSync(path.join(appRoot, '.env'), [
      'FIREBASE_PROJECT_ID=reporte-sistema-pos',
      'FIREBASE_SERVICE_ACCOUNT_PATH=C:\\inexistente\\firebase-key.json',
      ''
    ].join('\n'), 'utf8');
    fs.writeFileSync(bundledKeyPath, '{"project_id":"demo"}', 'utf8');

    delete process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

    const { prepareRuntimeEnvironment } = require('../../scripts/runtime-bootstrap');
    const runtime = prepareRuntimeEnvironment({ appRoot, userDataPath });

    expect(process.env.FIREBASE_SERVICE_ACCOUNT_PATH).toBe(bundledKeyPath);
    expect(runtime.userEnvFile).toBe(path.join(userDataPath, 'config', 'app.env'));
    expect(fs.readFileSync(runtime.userEnvFile, 'utf8')).toContain(`FIREBASE_SERVICE_ACCOUNT_PATH=${bundledKeyPath}`);
  });

  it('persiste variables en el app.env del usuario sin duplicar claves', () => {
    const userDataPath = makeTempDir('tecnocaja-user-');
    const envFile = path.join(userDataPath, 'config', 'app.env');
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, 'TECNO_CAJA_LICENSE_UID=viejo\n', 'utf8');

    const { persistUserEnvValues } = require('../../scripts/runtime-bootstrap');

    expect(persistUserEnvValues(userDataPath, {
      TECNO_CAJA_LICENSE_UID: 'pos_nuevo',
      FIREBASE_SERVICE_ACCOUNT_PATH: 'C:\\TecnoCaja\\firebase-key.json',
    })).toBe(true);

    const stored = fs.readFileSync(envFile, 'utf8');
    expect(stored.match(/TECNO_CAJA_LICENSE_UID=/g)).toHaveLength(1);
    expect(stored).toContain('TECNO_CAJA_LICENSE_UID=pos_nuevo');
    expect(stored).toContain('FIREBASE_SERVICE_ACCOUNT_PATH=C:\\TecnoCaja\\firebase-key.json');
  });
});
