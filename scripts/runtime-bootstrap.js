const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');

const USER_ENV_RELATIVE_PATH = path.join('config', 'app.env');
const BUNDLED_FIREBASE_KEY_CANDIDATES = [
  'firebase-key.json',
  path.join('config', 'firebase-key.json'),
];
const GENERATED_SECRET_KEYS = [
  'TECNO_CAJA_LICENSE_STORAGE_SECRET',
  'TECNO_CAJA_DB_KEY_SALT',
  'TECNO_CAJA_DEVICE_SECRET',
];

function loadEnvFile(filePath, override = false) {
  if (!filePath || !fs.existsSync(filePath)) return;
  dotenv.config({ path: filePath, override });
}

// Igual que loadEnvFile con override, pero ignora valores vacíos para no sobreescribir
// variables ya configuradas en el .env principal con blancos del template auto-generado.
function loadEnvFileSkipEmpty(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = dotenv.parse(raw);
    for (const [key, value] of Object.entries(parsed)) {
      if (String(value).trim() !== '') {
        process.env[key] = value;
      }
    }
  } catch (_e) {}
}

function getDefaultUserDataPath() {
  if (process.env.TECNO_CAJA_USER_DATA) {
    return path.resolve(process.env.TECNO_CAJA_USER_DATA);
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Tecno Caja');
  }

  return path.join(os.homedir(), '.tecnocaja');
}

function ensureUserEnvTemplate(userDataPath) {
  const envFile = path.join(userDataPath, USER_ENV_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(envFile), { recursive: true });

  if (!fs.existsSync(envFile)) {
    fs.writeFileSync(envFile, [
      '# Configuracion local de Tecno Caja',
      '# Este archivo se crea automaticamente en el primer arranque.',
      '# Puedes editarlo si mas adelante quieres activar integraciones opcionales.',
      '',
      'PORT=',
      'DB_CLIENT=sqlite',
      'DB_FILE=',
      'DB_HOST=127.0.0.1',
      'DB_PORT=3306',
      'DB_USER=root',
      'DB_PASSWORD=',
      'DB_NAME=tecnocaja',
      'TECNO_CAJA_MYSQL_ALLOW_LAN=false',
      'TECNO_CAJA_MYSQL_BIND_HOST=127.0.0.1',
      'TECNO_CAJA_LAN_DB_USER=',
      'TECNO_CAJA_LAN_DB_PASSWORD=',
      'SQLITE_SOURCE_FILE=',
      'PRODUCT_UPLOAD_DIR=',
      'SECURE_BACKUP_DIR=',
      'FIREBASE_PROJECT_ID=',
      'FIREBASE_SERVICE_ACCOUNT_PATH=',
      'FIREBASE_SERVICE_ACCOUNT_JSON=',
      'GOOGLE_APPLICATION_CREDENTIALS=',
      'TECNO_CAJA_LICENSE_UID=',
      'TECNO_CAJA_LICENSE_PUBLIC_KEY=',
      'TECNO_CAJA_LICENSE_HMAC_SECRET=',
      'TECNO_CAJA_LICENSE_REQUIRE_SIGNATURE=',
      'TECNO_CAJA_LICENSE_OFFLINE_GRACE_DAYS=3',
      'TECNO_CAJA_LICENSE_STORAGE_SECRET=',
      'TECNO_CAJA_DB_KEY_SALT=',
      'TECNO_CAJA_DEVICE_SECRET=',
      'POS_PUBLIC_BASE_URL=',
      'PEXELS_API_KEY=',
      ''
    ].join('\n'), 'utf8');
  }

  return envFile;
}

function ensureAbsolutePath(candidate, baseDir) {
  if (!candidate) return '';
  return path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(baseDir, candidate);
}

function sanitizeOptionalFileEnv(envKey, baseDir, warnings) {
  const rawValue = String(process.env[envKey] || '').trim();
  if (!rawValue) return '';

  const absolutePath = ensureAbsolutePath(rawValue, baseDir);
  if (!fs.existsSync(absolutePath)) {
    warnings.push(`${envKey} apunta a un archivo inexistente y sera ignorado: ${absolutePath}`);
    delete process.env[envKey];
    return '';
  }

  process.env[envKey] = absolutePath;
  return absolutePath;
}

function resolvePackagedFallbackPath(appRoot, relativePath) {
  const normalized = String(relativePath || '').trim();
  if (!normalized) return '';

  const candidateRoots = [appRoot];
  const parentRoot = path.dirname(appRoot);
  if (parentRoot && parentRoot !== appRoot) {
    candidateRoots.push(parentRoot);
  }

  for (const rootDir of candidateRoots) {
    const absolutePath = path.resolve(rootDir, normalized);
    if (fs.existsSync(absolutePath)) {
      return absolutePath;
    }
  }
  return '';
}

function findBundledServiceAccountPath(appRoot) {
  for (const candidate of BUNDLED_FIREBASE_KEY_CANDIDATES) {
    const resolved = resolvePackagedFallbackPath(appRoot, candidate);
    if (resolved) return resolved;
  }
  return '';
}

function serializeEnvValue(value) {
  return String(value == null ? '' : value)
    .replace(/\r?\n/g, ' ')
    .trim();
}

function persistEnvFileValues(filePath, values = {}) {
  if (!filePath || !values || typeof values !== 'object') return false;

  const normalizedEntries = Object.entries(values)
    .filter(([key]) => String(key || '').trim())
    .map(([key, value]) => [String(key).trim(), serializeEnvValue(value)]);

  if (!normalizedEntries.length) return false;

  const envFile = path.resolve(filePath);
  const existingLines = fs.existsSync(envFile)
    ? fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
    : [];
  const updatedLines = [...existingLines];

  for (const [key, value] of normalizedEntries) {
    const nextLine = `${key}=${value}`;
    const lineIndex = updatedLines.findIndex((line) => line.startsWith(`${key}=`));
    if (lineIndex >= 0) {
      updatedLines[lineIndex] = nextLine;
      continue;
    }

    if (updatedLines.length && updatedLines[updatedLines.length - 1] !== '') {
      updatedLines.push('');
    }
    updatedLines.push(nextLine);
  }

  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, updatedLines.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8');
  return true;
}

function persistUserEnvValues(userDataPath, values = {}) {
  if (!userDataPath) return false;
  const envFile = ensureUserEnvTemplate(path.resolve(userDataPath));
  return persistEnvFileValues(envFile, values);
}

function ensureGeneratedRuntimeSecrets(userEnvFile, warnings = []) {
  const generated = {};
  for (const envKey of GENERATED_SECRET_KEYS) {
    const currentValue = String(process.env[envKey] || '').trim();
    if (currentValue) continue;
    const nextValue = crypto.randomBytes(32).toString('hex');
    process.env[envKey] = nextValue;
    generated[envKey] = nextValue;
  }

  if (!Object.keys(generated).length) return;
  persistEnvFileValues(userEnvFile, generated);
  warnings.push(
    `Se generaron secretos locales de endurecimiento (${Object.keys(generated).join(', ')}).`
  );
}

function resolveRuntimePaths({ appRoot, userDataPath }) {
  const runtimeRoot = userDataPath || path.join(appRoot, 'runtime-data');
  const dbFile = ensureAbsolutePath(process.env.DB_FILE, appRoot) || path.join(runtimeRoot, 'data', 'tecnocaja.db');
  const productUploadDir = ensureAbsolutePath(process.env.PRODUCT_UPLOAD_DIR, appRoot) || path.join(runtimeRoot, 'uploads', 'productos');
  const secureBackupDir = ensureAbsolutePath(process.env.SECURE_BACKUP_DIR, appRoot) || path.join(runtimeRoot, 'secure-backups');
  return { runtimeRoot, dbFile, productUploadDir, secureBackupDir };
}

function prepareRuntimeEnvironment(options = {}) {
  const appRoot = path.resolve(options.appRoot || path.join(__dirname, '..'));
  const userDataPath = path.resolve(options.userDataPath || getDefaultUserDataPath());
  const warnings = [];

  process.env.TECNO_CAJA_APP_ROOT = appRoot;
  process.env.TECNO_CAJA_USER_DATA = userDataPath;

  loadEnvFile(path.join(appRoot, '.env'), false);
  const userEnvFile = ensureUserEnvTemplate(userDataPath);
  loadEnvFileSkipEmpty(userEnvFile); // no sobreescribe con valores vacíos del template

  // ── Guardia anti-LAN-stale: si el config/app.env de AppData dejó DB_HOST
  // apuntando a una IP remota (vinculación LAN anterior) pero el .env del
  // proyecto especifica localhost, revertir todo a la config local embebida.
  // Esto evita el error "connect ENETUNREACH <IP>:3306" al reiniciar sin red.
  {
    const LOOPBACK_HOSTS = new Set(['', '127.0.0.1', 'localhost', '::1', '0.0.0.0']);
    const projectEnvRaw  = (() => {
      try { return fs.readFileSync(path.join(appRoot, '.env'), 'utf8'); } catch (_) { return ''; }
    })();

    function parseProjectEnvKey(key) {
      const m = projectEnvRaw.match(new RegExp(`^${key}=(.*)$`, 'm'));
      return m ? String(m[1]).trim() : null;
    }

    const projectDbHost   = parseProjectEnvKey('DB_HOST');
    const currentDbHost   = String(process.env.DB_HOST || '').trim();
    const hostIsStale     = projectDbHost !== null &&
                            LOOPBACK_HOSTS.has(projectDbHost) &&
                            !LOOPBACK_HOSTS.has(currentDbHost);

    if (hostIsStale) {
      // AppData sobreescribió DB_HOST con IP remota → revertir a valores del proyecto
      const resetValues = {};

      for (const key of ['DB_CLIENT', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
                         'POS_ALLOW_LAN', 'POS_BIND_HOST',
                         'TECNO_CAJA_MYSQL_ALLOW_LAN', 'TECNO_CAJA_MYSQL_BIND_HOST']) {
        const projectVal = parseProjectEnvKey(key);
        if (projectVal !== null) {
          process.env[key] = projectVal;
          resetValues[key] = projectVal;
        }
      }

      // Corregir el userEnvFile para que no vuelva a ocurrir
      try {
        persistEnvFileValues(userEnvFile, resetValues);
      } catch (_) { /* no crítico */ }

      warnings.push(
        `[anti-LAN-stale] DB_HOST estaba apuntando a ${currentDbHost} (servidor LAN anterior no disponible). ` +
        `Configuración revertida a valores locales del .env del proyecto.`
      );
    }
  }

  const { runtimeRoot, dbFile, productUploadDir, secureBackupDir } = resolveRuntimePaths({
    appRoot,
    userDataPath
  });

  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  fs.mkdirSync(productUploadDir, { recursive: true });
  fs.mkdirSync(secureBackupDir, { recursive: true });
  fs.mkdirSync(path.join(userDataPath, 'logs'), { recursive: true });

  process.env.DB_FILE = dbFile;
  process.env.PRODUCT_UPLOAD_DIR = productUploadDir;
  process.env.SECURE_BACKUP_DIR = secureBackupDir;
  ensureGeneratedRuntimeSecrets(userEnvFile, warnings);

  const resolvedServiceAccountPath = sanitizeOptionalFileEnv('FIREBASE_SERVICE_ACCOUNT_PATH', appRoot, warnings);
  if (!resolvedServiceAccountPath) {
    const bundledServiceAccountPath = findBundledServiceAccountPath(appRoot);
    if (bundledServiceAccountPath) {
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH = bundledServiceAccountPath;
      persistEnvFileValues(userEnvFile, {
        FIREBASE_SERVICE_ACCOUNT_PATH: bundledServiceAccountPath,
      });
      warnings.push(`Usando credencial Firebase incluida con la app: ${bundledServiceAccountPath}`);
    }
  }
  sanitizeOptionalFileEnv('FIREBASE_SERVICE_ACCOUNT_PATH', appRoot, warnings);
  sanitizeOptionalFileEnv('GOOGLE_APPLICATION_CREDENTIALS', appRoot, warnings);

  return {
    appRoot,
    userDataPath,
    userEnvFile,
    runtimeRoot,
    dbFile,
    productUploadDir,
    secureBackupDir,
    warnings
  };
}

module.exports = {
  findBundledServiceAccountPath,
  persistEnvFileValues,
  persistUserEnvValues,
  prepareRuntimeEnvironment
};
