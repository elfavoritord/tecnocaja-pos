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

  it('revierte un DB_HOST remoto obsoleto a loopback aunque no exista .env de proyecto (build empaquetado)', () => {
    const appRoot = makeTempDir('tecnocaja-app-'); // sin .env — simula el instalador real
    const userDataPath = makeTempDir('tecnocaja-user-');
    const envFile = path.join(userDataPath, 'config', 'app.env');
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, [
      'DB_CLIENT=mysql',
      'DB_HOST=100.64.1.5',
      'DB_PORT=3306',
      'POS_BIND_HOST=0.0.0.0',
      ''
    ].join('\n'), 'utf8');

    const { prepareRuntimeEnvironment } = require('../../scripts/runtime-bootstrap');
    const runtime = prepareRuntimeEnvironment({ appRoot, userDataPath });

    expect(process.env.DB_HOST).toBe('127.0.0.1');
    expect(process.env.POS_BIND_HOST).toBe('127.0.0.1');
    expect(runtime.warnings.some((w) => w.includes('anti-LAN-stale'))).toBe(true);

    const stored = fs.readFileSync(envFile, 'utf8');
    expect(stored).toContain('DB_HOST=127.0.0.1');
  });

  it('NO revierte DB_HOST remoto cuando terminal-config.json marca esta PC como secundaria deliberada (isMain:false)', () => {
    const appRoot = makeTempDir('tecnocaja-app-'); // sin .env — simula el instalador real
    const userDataPath = makeTempDir('tecnocaja-user-');
    const envFile = path.join(userDataPath, 'config', 'app.env');
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, [
      'DB_CLIENT=mysql',
      'DB_HOST=192.168.100.62',
      'DB_PORT=3306',
      ''
    ].join('\n'), 'utf8');

    fs.mkdirSync(path.join(appRoot, 'config'), { recursive: true });
    fs.writeFileSync(path.join(appRoot, 'config', 'terminal-config.json'), JSON.stringify({
      terminalId: 'abc123', setupMode: 'multisucursal', isMain: false
    }), 'utf8');

    const { prepareRuntimeEnvironment } = require('../../scripts/runtime-bootstrap');
    const runtime = prepareRuntimeEnvironment({ appRoot, userDataPath });

    expect(process.env.DB_HOST).toBe('192.168.100.62');
    expect(runtime.warnings.some((w) => w.includes('anti-LAN-stale'))).toBe(false);
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
