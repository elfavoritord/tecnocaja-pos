const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const os = require('os');
const { spawnSync } = require('child_process');
const express = require('express');
const cors = require('cors');
const { formidable } = require('formidable');
const QRCode = require('qrcode');
const sharp = require('sharp');
const { prepareRuntimeEnvironment, persistEnvFileValues } = require('./scripts/runtime-bootstrap');
const { query, withTransaction, reloadDatabase, getDbClient } = require('./db');
const productsCache = require('./server/cache/products-cache');
const {
  PRODUCTS_CSV_CURRENT_FILE,
  parseProductsCsvBuffer,
  writeProductsCsvSnapshot,
} = require('./server/services/products-csv.service');
const { Server } = require('socket.io');
const { initializeDatabase } = require('./scripts/auto-init-db');
const { initializeMySqlDatabase } = require('./scripts/init-db-mysql');
const { registerMobilePos, ensureMobileTables } = require('./modules/mobile-pos');
const firebaseSync = require('./modules/firebase-sync');
const reportsSync = require('./modules/firebase-reports-sync');
const plans = require('./modules/plans');
const { createLicenseService } = require('./server/licensing/license-service');
const packageJson = require('./package.json');

// ✅ Sincronización con Firebase (NUEVA)
const { getInstance: getSyncService } = require('./server/sync/firebase-sync-service');
const syncRoutes = require('./server/routes/sync.routes');

// ✅ Gestor de archivos Sistema_Data
const { createFileManagerService } = require('./server/services/file-manager.service');
const { createFileManagerRouter }  = require('./server/routes/file-manager.routes');
const { ensureInitialReportsBootstrap } = require('./server/services/firebase-initial-sync');
const createDeliveryRouter = require('./server/routes/delivery.routes');

// ✅ Respaldo local + nube
const createRespaldosRouter = require('./server/routes/respaldos.routes');

// ✅ Báscula TCP
const bascula = require('./server/devices/bascula');

// ✅ Módulo Fiscal e-CF / DGII
const { createEcfModule } = require('./modules/ecf');
const createRncRouter  = require('./server/routes/rnc.routes');

// ✅ Red de Terminales — multicaja LAN + sucursales remotas
const createNetworkRouter = require('./server/routes/network.routes');
const { ensureNetworkExtensions, markOfflineBySocket, registerTerminal, getLocalIPs } = require('./server/network/terminalRegistry');

// ✅ Modo offline multicaja
const createOfflineRouter = require('./server/routes/offline.routes');
const {
  localQuery,
  generateOfflineInvoiceId: generateOfflineId,
  logLocalSyncEvent: logLocalSync,
  getLocalCacheStatus
} = require('./db-local');

const ecfModule = createEcfModule({ query, withTransaction, resolveRequestActorUser });

/**
 * Ejecuta una función de sync con Firestore en fire-and-forget.
 * Nunca rompe el flujo del endpoint ni lanza errores al caller.
 */
function fireReportSync(fn) {
  if (typeof fn !== 'function') return;
  try {
    const result = fn();
    if (result && typeof result.catch === 'function') {
      result.catch((err) => {
        console.warn('[reports-sync] hook falló:', err?.message || err);
      });
    }
  } catch (err) {
    console.warn('[reports-sync] hook síncrono falló:', err?.message || err);
  }
}

/**
 * Carga el config desde la BD (cached por 30s) para pasárselo a reports-sync.
 * Necesita business_name y license info para armar el businessId.
 */
let _reportSyncConfigCache = { data: null, at: 0 };
async function getReportSyncConfig() {
  const now = Date.now();
  if (_reportSyncConfigCache.data && (now - _reportSyncConfigCache.at) < 30000) {
    return _reportSyncConfigCache.data;
  }
  try {
    const rows = await query(
      `SELECT business_name AS nombre, rnc, address, phone AS telefono, currency,
              plan_code, license_status
       FROM config WHERE id = 1 LIMIT 1`
    );
    const cfg = Array.isArray(rows) ? rows[0] : rows;
    _reportSyncConfigCache = { data: cfg || {}, at: now };
    return cfg || {};
  } catch (_) {
    return {};
  }
}

/**
 * Carga mapa de branches id→nombre (cached por 30s).
 */
let _reportSyncBranchesCache = { data: null, at: 0 };
async function getReportSyncBranchesMap() {
  const now = Date.now();
  if (_reportSyncBranchesCache.data && (now - _reportSyncBranchesCache.at) < 30000) {
    return _reportSyncBranchesCache.data;
  }
  try {
    const rows = await query('SELECT id, nombre FROM branches');
    const list = Array.isArray(rows) ? rows : [];
    const map = new Map();
    for (const b of list) map.set(Number(b.id), b.nombre);
    _reportSyncBranchesCache = { data: map, at: now };
    return map;
  } catch (_) {
    return new Map();
  }
}

function invalidateReportSyncCaches() {
  _reportSyncConfigCache = { data: null, at: 0 };
  _reportSyncBranchesCache = { data: null, at: 0 };
}

function normalizeReportSyncIds(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => Number(value || 0) || 0)
      .filter((value) => value > 0)
  )];
}

async function syncProductsToReportsByIds(productIds, options = {}) {
  const normalizedIds = normalizeReportSyncIds(productIds);
  if (!normalizedIds.length) return { synced: 0 };

  const placeholders = normalizedIds.map(() => '?').join(', ');
  const rows = await query(
    `SELECT * FROM products WHERE id IN (${placeholders}) ORDER BY id ASC`,
    normalizedIds
  ).catch(() => []);

  if (!rows.length) return { synced: 0 };

  const cfg = await getReportSyncConfig();
  let synced = 0;
  for (const row of rows) {
    await reportsSync.syncProduct(row, {
      config: cfg,
      branchId: options.branchId || null,
    });
    synced += 1;
  }
  return { synced };
}

async function deleteProductsFromReportsByIds(productIds) {
  const normalizedIds = normalizeReportSyncIds(productIds);
  if (!normalizedIds.length) return { deleted: 0 };

  const cfg = await getReportSyncConfig();
  let deleted = 0;
  for (const productId of normalizedIds) {
    const removed = await reportsSync.deleteProduct(productId, { config: cfg });
    if (removed) deleted += 1;
  }
  return { deleted };
}

const {
  assertNoFirebaseIdentityConflicts,
  fetchRemotePosLicenseState,
  deletePosClientFromFirestore,
  getFirebaseConfigStatus,
  purgePosBusinessFromFirebase,
  syncPosStaffAuthUser,
  syncPosAccountsToFirestore,
  syncStaffToReportsApp,
  syncPosClientsToFirestore,
  verifyFirebaseIdToken
} = require('./modules/firebase-admin');

const runtime = prepareRuntimeEnvironment({
  appRoot: __dirname,
  userDataPath: process.env.TECNO_CAJA_USER_DATA || ''
});
for (const warning of runtime.warnings) {
  console.warn('[runtime-bootstrap]', warning);
}

function persistRuntimeEnvValues(values = {}) {
  const persistedTargets = [];

  if (runtime.userEnvFile) {
    try {
      if (persistEnvFileValues(runtime.userEnvFile, values)) {
        persistedTargets.push(runtime.userEnvFile);
      }
    } catch (error) {
      console.warn('[runtime-bootstrap] No se pudo actualizar config/app.env del usuario:', error.message);
    }
  }

  const appEnvPath = path.join(__dirname, '.env');
  if (fs.existsSync(appEnvPath)) {
    try {
      if (persistEnvFileValues(appEnvPath, values)) {
        persistedTargets.push(appEnvPath);
      }
    } catch (error) {
      console.warn('[runtime-bootstrap] No se pudo actualizar el .env de la app:', error.message);
    }
  }

  for (const [key, value] of Object.entries(values || {})) {
    process.env[key] = String(value == null ? '' : value).trim();
  }

  return persistedTargets;
}

const PRIVATE_LAN_HOST_REGEX = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/;

function isLoopbackHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  return normalized === ''
    || normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0.0.0.0';
}

function getLanIpv4Addresses() {
  const interfaces = os.networkInterfaces() || {};
  const addresses = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue;
      if (entry.family !== 'IPv4' && entry.family !== 4) continue;
      const address = String(entry.address || '').trim();
      if (!address || !PRIVATE_LAN_HOST_REGEX.test(address)) continue;
      addresses.push(address);
    }
  }
  return [...new Set(addresses)];
}

function parseHostPortCandidate(value, defaultPort = Number(process.env.PORT || 3000)) {
  const rawValue = String(value || '').trim();
  if (!rawValue) return { host: '', port: defaultPort, protocol: 'http:' };

  try {
    const candidate = /^https?:\/\//i.test(rawValue)
      ? new URL(rawValue)
      : new URL(`http://${rawValue}`);
    return {
      host: candidate.hostname || '',
      port: Number(candidate.port || defaultPort) || defaultPort,
      protocol: candidate.protocol || 'http:'
    };
  } catch (_error) {
    return { host: '', port: defaultPort, protocol: 'http:' };
  }
}

function isPrivateLanIpv4(host) {
  return PRIVATE_LAN_HOST_REGEX.test(String(host || '').trim());
}

function isLikelyGatewayHost(host) {
  const normalized = String(host || '').trim();
  if (!isPrivateLanIpv4(normalized)) return false;
  const parts = normalized.split('.');
  return parts.length === 4 && parts[3] === '1';
}

function buildGatewayWarning(host) {
  if (!isLikelyGatewayHost(host)) return '';
  return `La IP ${host} parece ser la puerta de enlace del router. Verifica la IP real de la PC principal con ipconfig.`;
}

function getWizardPrincipalConnectionMeta(value, defaultPort = Number(process.env.PORT || 3000)) {
  const parsed = parseHostPortCandidate(value, defaultPort);
  if (!parsed.host) {
    const error = new Error('La dirección del equipo principal no es válida.');
    error.statusCode = 400;
    throw error;
  }
  return {
    host: parsed.host,
    port: Number(parsed.port || defaultPort) || defaultPort,
    protocol: parsed.protocol || 'http:',
    baseUrl: `${parsed.protocol || 'http:'}//${parsed.host}:${Number(parsed.port || defaultPort) || defaultPort}`,
    warning: buildGatewayWarning(parsed.host)
  };
}

function normalizeWizardBaseUrl(value, defaultPort = Number(process.env.PORT || 3000)) {
  return getWizardPrincipalConnectionMeta(value, defaultPort).baseUrl;
}

function resolveRequestHostCandidate(req) {
  const headerHost = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim();
  const parsed = parseHostPortCandidate(headerHost, Number(process.env.PORT || 3000));
  if (parsed.host && !isLoopbackHost(parsed.host)) {
    return parsed.host;
  }
  return getLanIpv4Addresses()[0] || '';
}

function escapeSqlString(value) {
  return String(value == null ? '' : value).replace(/'/g, "''");
}

function escapeSqlIdentifier(value) {
  return String(value == null ? '' : value).replace(/`/g, '``');
}

function sanitizeMysqlUserName(value, fallback = 'tecnocaja_terminal') {
  const normalized = String(value || '').trim().replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function findLocalMysqlAdminClient() {
  const candidateRoots = [
    String(process.env.TECNO_CAJA_MARIADB_BUNDLE_DIR || '').trim(),
    process.resourcesPath ? path.join(process.resourcesPath, 'mariadb-runtime') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Tecno Caja', 'resources', 'mariadb-runtime') : '',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'MariaDB 11.8', '') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'MariaDB 11.8', '') : ''
  ].filter(Boolean);

  for (const rootDir of candidateRoots) {
    for (const executableName of ['mysql.exe', 'mariadb.exe']) {
      const candidatePath = path.join(rootDir, 'bin', executableName);
      if (fs.existsSync(candidatePath)) {
        return candidatePath;
      }
    }
  }

  return process.platform === 'win32' ? 'mysql.exe' : 'mysql';
}

function runLocalMysqlAdminStatements(statements = [], options = {}) {
  const clientExecutable = findLocalMysqlAdminClient();
  const host = String(options.host || '127.0.0.1').trim() || '127.0.0.1';
  const port = Number(options.port || process.env.DB_PORT || 3306) || 3306;

  for (const sql of statements.filter(Boolean)) {
    const result = spawnSync(clientExecutable, [
      '-h', host,
      '-P', String(port),
      '-u', 'root',
      '-e', sql
    ], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 12000
    });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      const stderr = String(result.stderr || '').trim();
      const stdout = String(result.stdout || '').trim();
      throw new Error(stderr || stdout || `El cliente MySQL devolvió código ${result.status}.`);
    }
  }
}

function mapWizardNetworkError(error, options = {}) {
  const host = String(options.host || '').trim();
  const port = Number(options.port || process.env.PORT || 3000) || 3000;
  const message = String(error?.message || '').trim();
  const statusCode = Number(error?.statusCode || 0) || 0;
  const code = String(error?.code || '').trim().toUpperCase();
  const genericExamples = `192.168.1.25:${port}, 10.0.0.25:${port} o 172.16.0.25:${port}`;

  if (statusCode >= 400 && statusCode < 500 && message) {
    return message;
  }
  if (/equipo principal no es válida/i.test(message)) {
    return `La dirección del equipo principal no es válida. Usa la IP real de la PC principal, por ejemplo ${genericExamples}.`;
  }
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(message)) {
    return `No se pudo conectar con la PC principal en ${host || 'la dirección indicada'}:${port}. Verifica que Tecno Caja esté abierto, que la IP sea correcta y que el Firewall permita el puerto 3399.`;
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || /tardó demasiado en responder/i.test(message) || /ETIMEDOUT/i.test(message)) {
    return 'La PC principal tardó demasiado en responder. Revisa que ambas PCs estén en la misma red y que el Firewall no esté bloqueando el puerto 3399.';
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || /EHOSTUNREACH|ENETUNREACH/i.test(message)) {
    return 'La PC principal no es alcanzable desde esta red. Verifica la IP, el cable o Wi-Fi, y confirma que ambas PCs estén en la misma red local.';
  }
  if (code === 'ENOTFOUND' || /ENOTFOUND/i.test(message)) {
    return `No se encontró la dirección indicada. Escribe la IP real de la PC principal, por ejemplo ${genericExamples}.`;
  }
  if (/CORS|Origin no permitido/i.test(message)) {
    return 'La PC principal rechazó la conexión por seguridad. Verifica que el modo multicaja esté habilitado en el equipo principal.';
  }
  if (/No se pudo interpretar la respuesta/i.test(message)) {
    return 'La PC principal respondió de forma inesperada. Verifica que Tecno Caja esté actualizado y funcionando correctamente en el equipo principal.';
  }
  return message || 'No se pudo conectar con la PC principal. Verifica la IP correcta, que Tecno Caja esté abierto y que el puerto 3399 esté permitido en el Firewall.';
}

function isMysqlDeployment() {
  return String(getDbClient?.() || process.env.DB_CLIENT || 'sqlite').trim().toLowerCase() === 'mysql';
}

function testTcpReachability(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new (require('net').Socket)();
    let settled = false;

    const finalize = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finalize(true));
    socket.once('timeout', () => finalize(false));
    socket.once('error', () => finalize(false));
    socket.connect(Number(port || 0), host);
  });
}

function postJsonToPeer(url, payload = {}, method = 'POST') {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_error) {
      reject(new Error('La URL del equipo principal no es válida.'));
      return;
    }

    const normalizedMethod = String(method || 'POST').trim().toUpperCase() || 'POST';
    const shouldSendBody = !['GET', 'HEAD'].includes(normalizedMethod);
    const data = shouldSendBody ? JSON.stringify(payload || {}) : '';
    const transport = parsed.protocol === 'https:' ? https : http;
    const headers = {
      Accept: 'application/json'
    };
    if (shouldSendBody) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: normalizedMethod,
      timeout: 8000,
      headers
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let parsedBody = null;
        try {
          parsedBody = body ? JSON.parse(body) : null;
        } catch (_error) {
          parsedBody = body;
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsedBody);
          return;
        }
        const error = new Error(parsedBody?.error || parsedBody || `Error ${res.statusCode}`);
        error.statusCode = res.statusCode;
        reject(error);
      });
    });

    req.on('timeout', () => req.destroy(new Error('El equipo principal tardó demasiado en responder.')));
    req.on('error', reject);
    if (shouldSendBody && data) req.write(data);
    req.end();
  });
}

async function probePrincipalHealth(baseUrl) {
  const data = await postJsonToPeer(`${baseUrl}/api/health`, null, 'GET');
  if (!data?.ok) {
    const error = new Error('El equipo principal respondió, pero el servicio de salud no confirmó disponibilidad.');
    error.statusCode = 502;
    throw error;
  }
  return data;
}

async function loadWizardAssignableResources() {
  const branches = await query(`SELECT id, nombre, codigo FROM branches WHERE estado = 'Activa' ORDER BY nombre`);
  const cashRegisters = await query(`
    SELECT cr.id, cr.nombre, cr.codigo, cr.branch_id, b.nombre as sucursal_nombre
    FROM cash_registers cr
    LEFT JOIN branches b ON b.id = cr.branch_id
    WHERE cr.estado = 'Activa'
    ORDER BY b.nombre, cr.nombre
  `);
  return { branches, cashRegisters };
}

async function authorizeWizardInstallationAccess(payload = {}) {
  const usuario = String(payload.usuario || '').trim();
  const password = String(payload.password || '').trim();
  const networkKey = String(payload.networkKey || '').trim();

  if (!usuario || !password) {
    const error = new Error('Usuario y contraseña son obligatorios.');
    error.statusCode = 400;
    throw error;
  }

  const countRows = await query('SELECT COUNT(*) as cnt FROM users');
  if (!Number(countRows[0]?.cnt || 0)) {
    const error = new Error('No hay administradores configurados. Instala el sistema principal primero.');
    error.statusCode = 404;
    throw error;
  }

  const rows = await query('SELECT * FROM users WHERE usuario = ? LIMIT 1', [usuario]);
  if (!rows.length) {
    const error = new Error('Usuario o contraseña incorrectos.');
    error.statusCode = 401;
    throw error;
  }

  const user = rows[0];
  if (String(user.estado || '').trim().toLowerCase() !== 'activo') {
    const error = new Error('Este usuario está inactivo. Comunícate con el administrador.');
    error.statusCode = 401;
    throw error;
  }
  if (!userPasswordMatches(user, password)) {
    const error = new Error('Usuario o contraseña incorrectos.');
    error.statusCode = 401;
    throw error;
  }

  const rolLower = String(user.rol || '').toLowerCase();
  const isAuthorized = rolLower.includes('admin') || Number(user.puede_autorizar_instalacion || 0);
  if (!isAuthorized) {
    const error = new Error('Este usuario no tiene autorización para vincular instalaciones.');
    error.statusCode = 403;
    throw error;
  }

  const configNetRows = await query('SELECT install_network_key FROM config WHERE id = 1 LIMIT 1');
  const storedNetKey = String(configNetRows[0]?.install_network_key || '').trim();
  if (storedNetKey) {
    if (!networkKey) {
      const error = new Error('Se requiere la clave de red del sistema principal para continuar.');
      error.statusCode = 400;
      throw error;
    }
    const netKeyValid = userPasswordMatches({ password_hash: storedNetKey }, networkKey);
    if (!netKeyValid) {
      const error = new Error('La clave de red es incorrecta.');
      error.statusCode = 401;
      throw error;
    }
  }

  const resources = await loadWizardAssignableResources();
  return {
    user,
    userPayload: { id: user.id, nombre: user.nombre, usuario: user.usuario, rol: user.rol },
    branches: resources.branches,
    cashRegisters: resources.cashRegisters
  };
}

async function ensureLanMysqlAccessProfile() {
  if (!isMysqlDeployment()) {
    const error = new Error('Esta instalación no está usando MySQL centralizado.');
    error.statusCode = 409;
    throw error;
  }

  const currentDbHost = String(process.env.DB_HOST || '127.0.0.1').trim() || '127.0.0.1';
  const dbPort = Number(process.env.DB_PORT || 3306);
  const dbName = String(process.env.DB_NAME || 'tecnocaja').trim() || 'tecnocaja';
  persistRuntimeEnvValues({
    POS_ALLOW_LAN: 'true',
    POS_BIND_HOST: '0.0.0.0'
  });

  if (!isLoopbackHost(currentDbHost)) {
    return {
      host: currentDbHost,
      port: dbPort,
      user: String(process.env.DB_USER || '').trim(),
      password: String(process.env.DB_PASSWORD || '').trim(),
      name: dbName,
      localManaged: false
    };
  }

  const valuesToPersist = {
    TECNO_CAJA_MYSQL_ALLOW_LAN: 'true',
    TECNO_CAJA_MYSQL_BIND_HOST: '0.0.0.0'
  };

  const lanUser = sanitizeMysqlUserName(process.env.TECNO_CAJA_LAN_DB_USER || 'tecnocaja_terminal');
  let lanPassword = String(process.env.TECNO_CAJA_LAN_DB_PASSWORD || '').trim();
  if (!lanPassword) {
    lanPassword = crypto.randomBytes(24).toString('base64url');
    valuesToPersist.TECNO_CAJA_LAN_DB_PASSWORD = lanPassword;
  }
  if (String(process.env.TECNO_CAJA_LAN_DB_USER || '').trim() !== lanUser) {
    valuesToPersist.TECNO_CAJA_LAN_DB_USER = lanUser;
  }

  persistRuntimeEnvValues(valuesToPersist);

  const mysqlLanStatements = [
    `CREATE USER IF NOT EXISTS '${lanUser}'@'%' IDENTIFIED BY '${escapeSqlString(lanPassword)}'`,
    `ALTER USER '${lanUser}'@'%' IDENTIFIED BY '${escapeSqlString(lanPassword)}'`,
    `GRANT ALL PRIVILEGES ON \`${escapeSqlIdentifier(dbName)}\`.* TO '${lanUser}'@'%'`,
    'FLUSH PRIVILEGES'
  ];

  try {
    for (const sql of mysqlLanStatements) {
      await query(sql);
    }
  } catch (error) {
    try {
      runLocalMysqlAdminStatements(mysqlLanStatements, { host: '127.0.0.1', port: dbPort });
    } catch (adminError) {
      const details = adminError?.message || error?.message || error;
      const fallbackHint = /CREATE USER privilege|ALTER USER command denied|Access denied/i.test(String(error?.message || ''))
        ? 'El usuario actual de la app no tiene permisos para crear usuarios MySQL; también falló el acceso administrativo local.'
        : 'No se pudo provisionar el acceso MySQL para terminales usando ni la app ni el cliente administrador local.';
      const wrappedError = new Error(`No se pudo preparar el usuario MySQL para terminales: ${details}. ${fallbackHint}`);
      wrappedError.statusCode = error.statusCode || 500;
      throw wrappedError;
    }
  }

  return {
    host: '',
    port: dbPort,
    user: lanUser,
    password: lanPassword,
    name: dbName,
    localManaged: true
  };
}

async function buildPrimaryNetworkProfile(req) {
  const configRows = await query('SELECT business_name, business_structure_mode, plan_code FROM config WHERE id = 1 LIMIT 1');
  const config = configRows[0] || {};
  const mode = normalizeBusinessStructureMode(config.business_structure_mode) || 'monocaja';

  if (!['multicaja', 'multisucursal', 'sucursal'].includes(mode)) {
    const error = new Error('El equipo principal todavía no está configurado para trabajar en red.');
    error.statusCode = 409;
    throw error;
  }

  const profile = await ensureLanMysqlAccessProfile();
  const principalHost = resolveRequestHostCandidate(req);
  const principalPort = Number(process.env.PORT || 3000);
  const principalBaseUrl = principalHost ? `http://${principalHost}:${principalPort}` : '';

  if (profile.localManaged) {
    if (!principalHost) {
      const error = new Error('No se pudo detectar la IP LAN del equipo principal.');
      error.statusCode = 500;
      throw error;
    }
    const mysqlReachable = await testTcpReachability(principalHost, profile.port);
    if (!mysqlReachable) {
      const error = new Error('La base MySQL del equipo principal aún no está publicada en la LAN. Reinicia la PC principal para aplicar el modo multicaja y vuelve a intentar.');
      error.statusCode = 409;
      throw error;
    }
  }

  return {
    businessName: String(config.business_name || 'Tecno Caja').trim() || 'Tecno Caja',
    structureMode: mode,
    planCode: String(config.plan_code || plans.planForMode(mode) || 'basico').trim().toLowerCase(),
    principalHost,
    principalPort,
    principalBaseUrl,
    licenseUid: String(process.env.TECNO_CAJA_LICENSE_UID || '').trim(),
    db: {
      host: profile.localManaged ? principalHost : profile.host,
      port: Number(profile.port || 3306),
      user: String(profile.user || '').trim(),
      password: String(profile.password || '').trim(),
      name: String(profile.name || 'tecnocaja').trim() || 'tecnocaja',
      localManaged: Boolean(profile.localManaged)
    }
  };
}

function buildRemoteTerminalConfig(data = {}) {
  return {
    terminalId: crypto.randomBytes(8).toString('hex'),
    terminalName: String(data.terminalName || data.cashRegisterName || 'Terminal').trim() || 'Terminal',
    branchId: Number(data.branchId || 0) || null,
    branchName: String(data.branchName || '').trim(),
    cashRegisterId: Number(data.cashRegisterId || 0) || null,
    cashRegisterName: String(data.cashRegisterName || '').trim(),
    setupMode: normalizeBusinessStructureMode(data.setupMode || data.structureMode || 'multicaja') || 'multicaja',
    language: String(data.language || 'es').trim().toLowerCase() || 'es',
    linkedAt: new Date().toISOString(),
    linkedBy: String(data.linkedBy || '').trim() || 'remote-admin',
    linkedUserId: Number(data.linkedUserId || 0) || null,
    principalHost: String(data.principalHost || '').trim(),
    principalBaseUrl: String(data.principalBaseUrl || '').trim(),
    isMain: false
  };
}

const secureLicenseService = createLicenseService({
  query,
  persistRemoteUid: (licenseUid) => {
    if (!licenseUid) return;
    const currentUid = String(process.env.TECNO_CAJA_LICENSE_UID || '').trim();
    if (currentUid === String(licenseUid).trim()) return;
    persistRuntimeEnvValues({ TECNO_CAJA_LICENSE_UID: licenseUid });
  },
  logger: console,
});

const app = express();
const PORT = Number(process.env.PORT || 3000);
// Password maestro legado (solo para descifrar backups antiguos creados antes
// de que existiera la rotación por env var). No usar como default activo.
const LEGACY_DEFAULT_SECURITY_PASSWORD = 'Seguridad2026';
// Password activo: prioridad env var > legado. En producción SIEMPRE definir
// TECNO_CAJA_SECURITY_PASSWORD (o cambiarlo desde el wizard tras primer arranque).
const DEFAULT_SECURITY_PASSWORD = process.env.TECNO_CAJA_SECURITY_PASSWORD
  || LEGACY_DEFAULT_SECURITY_PASSWORD;
if (DEFAULT_SECURITY_PASSWORD === LEGACY_DEFAULT_SECURITY_PASSWORD) {
  console.warn('[security] ADVERTENCIA: estás usando la contraseña maestra por defecto.');
  console.warn('[security] Define TECNO_CAJA_SECURITY_PASSWORD en el .env o cámbiala desde el wizard.');
}
const DEFAULT_LICENSE_ACTIVATION_KEY = process.env.ADMIN_LICENSE_KEY || 'NOVA-LIC-2026';
const SECURE_BACKUP_DIR = runtime.secureBackupDir;
const SECURE_BACKUP_FILE = 'tecnocaja-secure-backup.novaseguro';
const PRODUCT_UPLOAD_DIR = runtime.productUploadDir;
const PRODUCT_UPLOAD_WEB_PATH = '/uploads/productos';
const PEXELS_API_KEY = process.env.PEXELS_API_KEY || '';
const PIZZERIA_CATEGORY_LIST = [
  'Pizzas',
  'Bebidas',
  'Ingredientes',
  'Complementos',
  'Postres',
  'Combos',
  'Pastas',
  'Entradas',
  'Salsas'
];
const DEFAULT_PIZZERIA_PRODUCTS = [
  { codigo: 'PIZZA-12', nombre: 'Pizza 12 pedazos', categoria: 'Pizzas', precioCompra: 320, precioVenta: 600, stock: 30, stockMin: 5, tipoProducto: 'pizza', tamanos: ['12 pedazos'], masas: ['Clásica'], bordes: ['Normal', 'Queso'], extras: ['Pepperoni', 'Pollo', 'Maíz', 'Salchicha', 'Tocineta', 'Jamón', 'Aceitunas negras', 'Champiñones'], permiteMitades: true, esCombo: false, tiempoPreparacion: 20 },
  { codigo: 'PIZZA-8', nombre: 'Pizza 8 pedazos', categoria: 'Pizzas', precioCompra: 240, precioVenta: 450, stock: 32, stockMin: 5, tipoProducto: 'pizza', tamanos: ['8 pedazos'], masas: ['Clásica'], bordes: ['Normal', 'Queso'], extras: ['Pepperoni', 'Pollo', 'Maíz', 'Salchicha', 'Tocineta', 'Jamón', 'Aceitunas negras', 'Champiñones'], permiteMitades: true, esCombo: false, tiempoPreparacion: 18 },
  { codigo: 'PIZZA-6', nombre: 'Pizza 6 pedazos', categoria: 'Pizzas', precioCompra: 190, precioVenta: 350, stock: 35, stockMin: 5, tipoProducto: 'pizza', tamanos: ['6 pedazos'], masas: ['Clásica'], bordes: ['Normal', 'Queso'], extras: ['Pepperoni', 'Pollo', 'Maíz', 'Salchicha', 'Tocineta', 'Jamón', 'Aceitunas negras', 'Champiñones'], permiteMitades: true, esCombo: false, tiempoPreparacion: 16 },
  { codigo: 'PIZZA-4', nombre: 'Pizza 4 pedazos', categoria: 'Pizzas', precioCompra: 130, precioVenta: 225, stock: 40, stockMin: 5, tipoProducto: 'pizza', tamanos: ['4 pedazos'], masas: ['Clásica'], bordes: ['Normal', 'Queso'], extras: ['Pepperoni', 'Pollo', 'Maíz', 'Salchicha', 'Tocineta', 'Jamón', 'Aceitunas negras', 'Champiñones'], permiteMitades: false, esCombo: false, tiempoPreparacion: 14 },
  { codigo: 'EXTRA-ING', nombre: 'Ingrediente adicional / Pizza mixta', categoria: 'Ingredientes', precioCompra: 30, precioVenta: 75, stock: 999, stockMin: 0, tipoProducto: 'ingrediente', tamanos: [], masas: [], bordes: [], extras: [], permiteMitades: false, esCombo: false, tiempoPreparacion: 1 },
  { codigo: 'ING-PEPPERONI', nombre: 'Pepperoni adicional', categoria: 'Ingredientes', precioCompra: 28, precioVenta: 75, stock: 999, stockMin: 0, tipoProducto: 'ingrediente', tamanos: [], masas: [], bordes: [], extras: [], permiteMitades: false, esCombo: false, tiempoPreparacion: 1 },
  { codigo: 'ING-POLLO', nombre: 'Pollo adicional', categoria: 'Ingredientes', precioCompra: 30, precioVenta: 75, stock: 999, stockMin: 0, tipoProducto: 'ingrediente', tamanos: [], masas: [], bordes: [], extras: [], permiteMitades: false, esCombo: false, tiempoPreparacion: 1 },
  { codigo: 'ING-MAIZ', nombre: 'Maíz adicional', categoria: 'Ingredientes', precioCompra: 18, precioVenta: 75, stock: 999, stockMin: 0, tipoProducto: 'ingrediente', tamanos: [], masas: [], bordes: [], extras: [], permiteMitades: false, esCombo: false, tiempoPreparacion: 1 },
  { codigo: 'ING-SALCHICHA', nombre: 'Salchicha adicional', categoria: 'Ingredientes', precioCompra: 22, precioVenta: 75, stock: 999, stockMin: 0, tipoProducto: 'ingrediente', tamanos: [], masas: [], bordes: [], extras: [], permiteMitades: false, esCombo: false, tiempoPreparacion: 1 },
  { codigo: 'ING-TOCINETA', nombre: 'Tocineta adicional', categoria: 'Ingredientes', precioCompra: 32, precioVenta: 75, stock: 999, stockMin: 0, tipoProducto: 'ingrediente', tamanos: [], masas: [], bordes: [], extras: [], permiteMitades: false, esCombo: false, tiempoPreparacion: 1 },
  { codigo: 'ING-JAMON', nombre: 'Jamón adicional', categoria: 'Ingredientes', precioCompra: 24, precioVenta: 75, stock: 999, stockMin: 0, tipoProducto: 'ingrediente', tamanos: [], masas: [], bordes: [], extras: [], permiteMitades: false, esCombo: false, tiempoPreparacion: 1 },
  { codigo: 'ING-ACEITUNAS', nombre: 'Aceitunas negras adicionales', categoria: 'Ingredientes', precioCompra: 26, precioVenta: 75, stock: 999, stockMin: 0, tipoProducto: 'ingrediente', tamanos: [], masas: [], bordes: [], extras: [], permiteMitades: false, esCombo: false, tiempoPreparacion: 1 },
  { codigo: 'ING-CHAMPI', nombre: 'Champiñones adicionales', categoria: 'Ingredientes', precioCompra: 26, precioVenta: 75, stock: 999, stockMin: 0, tipoProducto: 'ingrediente', tamanos: [], masas: [], bordes: [], extras: [], permiteMitades: false, esCombo: false, tiempoPreparacion: 1 }
];
const LANGUAGE_OPTIONS = [
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'Français' },
  { value: 'pt', label: 'Português' },
  { value: 'de', label: 'Deutsch' },
  { value: 'it', label: 'Italiano' },
  { value: 'nl', label: 'Nederlands' },
  { value: 'ru', label: 'Русский' },
  { value: 'zh', label: '中文' },
  { value: 'ar', label: 'العربية' }
];
const CURRENCY_OPTIONS = [
  { value: 'RD$', label: 'RD$ (Pesos dominicanos)' },
  { value: 'US$', label: 'US$ (Dólares)' },
  { value: 'EUR', label: 'EUR (Euros)' },
  { value: 'MX$', label: 'MX$ (Pesos mexicanos)' }
];
const BUSINESS_TEMPLATES = {
  pizzeria: {
    key: 'pizzeria',
    label: 'Pizzería',
    accent: '#FF7A18',
    accentLight: '#FF4D6D',
    loginSubtitle: 'Pedidos rápidos, cocina y delivery en una sola app.',
    salesTitle: 'Menú rápido',
    salesSubtitle: 'Controla pizzas, delivery y cocina sin perder velocidad en caja.',
    searchPlaceholder: 'Buscar pizza, bebida o ingrediente...',
    quickMenuTitle: 'Menú rápido de la pizzería',
    quickMenuItems: [
      '12 pedazos: RD$ 600',
      '8 pedazos: RD$ 450',
      '6 pedazos: RD$ 350',
      '4 pedazos: RD$ 225',
      'Extra o mixta: RD$ 75'
    ],
    quickMenuNote: 'Envíos a domicilio: desde RD$ 25 hasta RD$ 100 según ubicación.',
    categories: PIZZERIA_CATEGORY_LIST,
    products: DEFAULT_PIZZERIA_PRODUCTS
  },
  colmado: {
    key: 'colmado',
    label: 'Colmado / Supermercado',
    accent: '#16A34A',
    accentLight: '#22C55E',
    loginSubtitle: 'Ventas rápidas, inventario diario y caja para colmados y mini markets.',
    salesTitle: 'Venta rápida',
    salesSubtitle: 'Ideal para artículos de consumo diario, recargas y caja constante.',
    searchPlaceholder: 'Buscar producto, código o artículo de góndola...',
    quickMenuTitle: 'Operación rápida del colmado',
    quickMenuItems: [
      'Usa códigos o búsqueda rápida para vender al instante',
      'Controla stock bajo, suplidores y reposición',
      'Separa cobros en efectivo, tarjeta y transferencias'
    ],
    quickMenuNote: 'Perfecto para caja continua, clientes frecuentes y ventas por unidad.',
    categories: ['Granos', 'Bebidas', 'Snacks', 'Limpieza', 'Hogar', 'Lácteos'],
    products: [
      { codigo: 'ARROZ-125', nombre: 'Arroz Selecto 125g', categoria: 'Granos', precioCompra: 38, precioVenta: 55, stock: 120, stockMin: 20, tipoProducto: 'general', tiempoPreparacion: 0 },
      { codigo: 'ACEITE-1L', nombre: 'Aceite vegetal 1L', categoria: 'Hogar', precioCompra: 110, precioVenta: 145, stock: 48, stockMin: 8, tipoProducto: 'general', tiempoPreparacion: 0 },
      { codigo: 'REFRESCO-2L', nombre: 'Refresco cola 2L', categoria: 'Bebidas', precioCompra: 70, precioVenta: 95, stock: 60, stockMin: 10, tipoProducto: 'general', tiempoPreparacion: 0 },
      { codigo: 'GALLETAS', nombre: 'Galletas surtidas', categoria: 'Snacks', precioCompra: 18, precioVenta: 30, stock: 90, stockMin: 15, tipoProducto: 'general', tiempoPreparacion: 0 },
      { codigo: 'DETERGENTE', nombre: 'Detergente en polvo', categoria: 'Limpieza', precioCompra: 55, precioVenta: 80, stock: 44, stockMin: 10, tipoProducto: 'general', tiempoPreparacion: 0 }
    ]
  },
  restaurante: {
    key: 'restaurante',
    label: 'Restaurante',
    accent: '#F97316',
    accentLight: '#FB7185',
    loginSubtitle: 'Toma pedidos, controla mesas y cocina con un flujo pensado para restaurante.',
    salesTitle: 'Servicio del restaurante',
    salesSubtitle: 'Organiza mostrador, mesas, delivery y cocina con un menú adaptable.',
    searchPlaceholder: 'Buscar plato, bebida o entrada...',
    quickMenuTitle: 'Operación del restaurante',
    quickMenuItems: [
      'Toma pedidos por mesa, para llevar o delivery',
      'Controla cocina con estados y tiempos',
      'Lleva entradas, platos fuertes y postres separados'
    ],
    quickMenuNote: 'La caja puede convivir con salón, cocina y delivery sin duplicar trabajo.',
    categories: ['Entradas', 'Platos fuertes', 'Bebidas', 'Postres', 'Combos', 'Ingredientes'],
    products: [
      { codigo: 'HAMB-CLAS', nombre: 'Hamburguesa clásica', categoria: 'Platos fuertes', precioCompra: 120, precioVenta: 250, stock: 35, stockMin: 6, tipoProducto: 'general', tiempoPreparacion: 12 },
      { codigo: 'PASTA-ALF', nombre: 'Pasta Alfredo', categoria: 'Platos fuertes', precioCompra: 140, precioVenta: 290, stock: 24, stockMin: 4, tipoProducto: 'general', tiempoPreparacion: 16 },
      { codigo: 'JUGO-NAT', nombre: 'Jugo natural', categoria: 'Bebidas', precioCompra: 28, precioVenta: 85, stock: 50, stockMin: 8, tipoProducto: 'general', tiempoPreparacion: 4 },
      { codigo: 'BROWNIE', nombre: 'Brownie de chocolate', categoria: 'Postres', precioCompra: 35, precioVenta: 95, stock: 28, stockMin: 5, tipoProducto: 'general', tiempoPreparacion: 2 }
    ]
  },
  farmacia: {
    key: 'farmacia',
    label: 'Farmacia',
    accent: '#06B6D4',
    accentLight: '#38BDF8',
    loginSubtitle: 'Controla medicamentos, cuidado personal y ventas con rapidez.',
    salesTitle: 'Atención farmacéutica',
    salesSubtitle: 'Catálogo claro, cobro rápido y control básico de inventario por producto.',
    searchPlaceholder: 'Buscar medicamento, marca o código...',
    quickMenuTitle: 'Operación de farmacia',
    quickMenuItems: [
      'Organiza medicamentos, vitaminas y cuidado personal',
      'Mantén visibles los artículos agotados o críticos',
      'Trabaja caja, clientes y reportes desde una sola base'
    ],
    quickMenuNote: 'Base lista para expandir luego a lotes y vencimientos si lo necesitas.',
    categories: ['Medicamentos', 'Vitaminas', 'Cuidado personal', 'Bebés', 'Botiquín'],
    products: [
      { codigo: 'ACETA-500', nombre: 'Acetaminofén 500mg', categoria: 'Medicamentos', precioCompra: 18, precioVenta: 35, stock: 140, stockMin: 25, tipoProducto: 'general', tiempoPreparacion: 0 },
      { codigo: 'ALCOHOL-70', nombre: 'Alcohol 70%', categoria: 'Botiquín', precioCompra: 32, precioVenta: 55, stock: 70, stockMin: 12, tipoProducto: 'general', tiempoPreparacion: 0 },
      { codigo: 'VIT-C', nombre: 'Vitamina C', categoria: 'Vitaminas', precioCompra: 45, precioVenta: 85, stock: 66, stockMin: 10, tipoProducto: 'general', tiempoPreparacion: 0 },
      { codigo: 'PANALES-M', nombre: 'Pañales talla M', categoria: 'Bebés', precioCompra: 280, precioVenta: 365, stock: 24, stockMin: 4, tipoProducto: 'general', tiempoPreparacion: 0 }
    ]
  },
  ferreteria: {
    key: 'ferreteria',
    label: 'Ferretería',
    accent: '#F59E0B',
    accentLight: '#FBBF24',
    loginSubtitle: 'Ventas, inventario y suplidores para herramientas y materiales.',
    salesTitle: 'Mostrador de ferretería',
    salesSubtitle: 'Gestiona artículos técnicos con mejor control de stock y suplidores.',
    searchPlaceholder: 'Buscar herramienta, tornillo o material...',
    quickMenuTitle: 'Operación de ferretería',
    quickMenuItems: [
      'Trabaja con códigos, marcas y múltiples categorías',
      'Mantén mínimo de inventario visible en tiempo real',
      'Lleva suplidores y cuentas por pagar con claridad'
    ],
    quickMenuNote: 'Pensado para mostrador rápido y control de inventario pesado.',
    categories: ['Herramientas', 'Electricidad', 'Plomería', 'Pinturas', 'Tornillería'],
    products: [
      { codigo: 'MARTILLO', nombre: 'Martillo estándar', categoria: 'Herramientas', precioCompra: 180, precioVenta: 260, stock: 32, stockMin: 6, tipoProducto: 'general', tiempoPreparacion: 0 },
      { codigo: 'CABLE-ROLLO', nombre: 'Cable eléctrico por rollo', categoria: 'Electricidad', precioCompra: 520, precioVenta: 690, stock: 16, stockMin: 3, tipoProducto: 'general', tiempoPreparacion: 0 },
      { codigo: 'LLAVE-TUBO', nombre: 'Llave de tubo', categoria: 'Plomería', precioCompra: 140, precioVenta: 220, stock: 22, stockMin: 4, tipoProducto: 'general', tiempoPreparacion: 0 },
      { codigo: 'PINTURA-BLAN', nombre: 'Pintura blanca 1 galón', categoria: 'Pinturas', precioCompra: 480, precioVenta: 650, stock: 18, stockMin: 4, tipoProducto: 'general', tiempoPreparacion: 0 }
    ]
  },
  boutique: {
    key: 'boutique',
    label: 'Boutique / Tienda',
    accent: '#EC4899',
    accentLight: '#F472B6',
    loginSubtitle: 'Catálogo visual, clientes y caja para ropa, accesorios y ventas detalladas.',
    salesTitle: 'Colección destacada',
    salesSubtitle: 'Vende por estilo, temporada y categorías con una presentación más visual.',
    searchPlaceholder: 'Buscar prenda, accesorio o referencia...',
    quickMenuTitle: 'Operación de boutique',
    quickMenuItems: [
      'Usa imágenes, categorías y marcas para vender mejor',
      'Controla prendas, accesorios y promociones',
      'Lleva ventas rápidas sin perder la vista estética'
    ],
    quickMenuNote: 'Buena base para ropa, accesorios, belleza o regalos.',
    categories: ['Ropa', 'Calzado', 'Accesorios', 'Belleza', 'Promociones'],
    products: [
      { codigo: 'BLUSA-01', nombre: 'Blusa casual', categoria: 'Ropa', precioCompra: 280, precioVenta: 450, stock: 20, stockMin: 4, tipoProducto: 'general', tiempoPreparacion: 0 },
      { codigo: 'JEANS-02', nombre: 'Jeans slim', categoria: 'Ropa', precioCompra: 420, precioVenta: 650, stock: 18, stockMin: 4, tipoProducto: 'general', tiempoPreparacion: 0 },
      { codigo: 'BOLSO-03', nombre: 'Bolso de mano', categoria: 'Accesorios', precioCompra: 350, precioVenta: 540, stock: 14, stockMin: 3, tipoProducto: 'general', tiempoPreparacion: 0 },
      { codigo: 'ZAPATO-04', nombre: 'Zapato casual', categoria: 'Calzado', precioCompra: 520, precioVenta: 780, stock: 12, stockMin: 3, tipoProducto: 'general', tiempoPreparacion: 0 }
    ]
  },
  panaderia: {
    key: 'panaderia',
    label: 'Panadería / Repostería',
    accent: '#D97706',
    accentLight: '#F59E0B',
    loginSubtitle: 'Controla panes, repostería, bebidas y mostrador con rapidez.',
    salesTitle: 'Mostrador de panadería',
    salesSubtitle: 'Pensado para ventas ágiles, vitrinas, combos y producción diaria.',
    searchPlaceholder: 'Buscar pan, postre o bebida...',
    quickMenuTitle: 'Operación de panadería',
    quickMenuItems: [
      'Separa panes, repostería, bebidas y combos',
      'Controla productos de producción rápida y stock diario',
      'Ideal para mostrador, pedidos y encargos'
    ],
    quickMenuNote: 'Base adaptable para panes, bizcochos, empanadas y dulces.',
    categories: ['Panes', 'Repostería', 'Bebidas', 'Desayunos', 'Combos'],
    products: [
      { codigo: 'PAN-AGUA', nombre: 'Pan de agua', categoria: 'Panes', precioCompra: 6, precioVenta: 10, stock: 180, stockMin: 25, tipoProducto: 'general', tiempoPreparacion: 0 },
      { codigo: 'DONA-CHO', nombre: 'Dona de chocolate', categoria: 'Repostería', precioCompra: 18, precioVenta: 35, stock: 70, stockMin: 10, tipoProducto: 'general', tiempoPreparacion: 0 },
      { codigo: 'JUGO-NAR', nombre: 'Jugo de naranja', categoria: 'Bebidas', precioCompra: 25, precioVenta: 55, stock: 40, stockMin: 8, tipoProducto: 'general', tiempoPreparacion: 0 }
    ]
  },
  tecnologia: {
    key: 'tecnologia',
    label: 'Tecnología / Electrónica',
    accent: '#2563EB',
    accentLight: '#60A5FA',
    loginSubtitle: 'Ventas, inventario y catálogo para equipos, accesorios y repuestos.',
    salesTitle: 'Catálogo tecnológico',
    salesSubtitle: 'Perfecto para accesorios, equipos, repuestos y ventas por referencia.',
    searchPlaceholder: 'Buscar equipo, accesorio o referencia...',
    quickMenuTitle: 'Operación de tecnología',
    quickMenuItems: [
      'Trabaja por marca, referencia y categorías técnicas',
      'Controla accesorios, equipos y stock mínimo',
      'Ideal para tiendas de celulares, computadoras o electrónica'
    ],
    quickMenuNote: 'Base lista para accesorios, periféricos, cables y equipos.',
    categories: ['Celulares', 'Accesorios', 'Computadoras', 'Audio', 'Gaming'],
    products: [
      { codigo: 'CARGA-C', nombre: 'Cargador USB-C', categoria: 'Accesorios', precioCompra: 180, precioVenta: 320, stock: 45, stockMin: 8, tipoProducto: 'general', tiempoPreparacion: 0 },
      { codigo: 'AUR-BT', nombre: 'Audífonos Bluetooth', categoria: 'Audio', precioCompra: 650, precioVenta: 990, stock: 20, stockMin: 4, tipoProducto: 'general', tiempoPreparacion: 0 },
      { codigo: 'MOUSE-RGB', nombre: 'Mouse RGB', categoria: 'Gaming', precioCompra: 320, precioVenta: 520, stock: 26, stockMin: 5, tipoProducto: 'general', tiempoPreparacion: 0 }
    ]
  },
  salon: {
    key: 'salon',
    label: 'Salón / Spa',
    accent: '#A855F7',
    accentLight: '#C084FC',
    loginSubtitle: 'Organiza servicios, productos y caja para belleza y cuidado personal.',
    salesTitle: 'Servicios y productos',
    salesSubtitle: 'Vende servicios, cosméticos y paquetes con una presentación más limpia.',
    searchPlaceholder: 'Buscar servicio, producto o paquete...',
    quickMenuTitle: 'Operación de salón',
    quickMenuItems: [
      'Separa servicios, productos y promociones',
      'Ideal para belleza, barbería, uñas o spa',
      'Controla caja, clientes y ventas desde un mismo flujo'
    ],
    quickMenuNote: 'Buena base para servicios de belleza y venta de productos complementarios.',
    categories: ['Servicios', 'Cabello', 'Uñas', 'Cuidado personal', 'Promociones'],
    products: [
      { codigo: 'CORTE-DAM', nombre: 'Corte de dama', categoria: 'Servicios', precioCompra: 0, precioVenta: 450, stock: 999, stockMin: 0, tipoProducto: 'servicio', tiempoPreparacion: 45 },
      { codigo: 'SECADO', nombre: 'Secado', categoria: 'Servicios', precioCompra: 0, precioVenta: 300, stock: 999, stockMin: 0, tipoProducto: 'servicio', tiempoPreparacion: 25 },
      { codigo: 'SHAMPOO', nombre: 'Shampoo profesional', categoria: 'Cabello', precioCompra: 220, precioVenta: 380, stock: 22, stockMin: 4, tipoProducto: 'general', tiempoPreparacion: 0 }
    ]
  },
  cafeteria: {
    key: 'cafeteria',
    label: 'Cafetería',
    accent: '#B45309',
    accentLight: '#F59E0B',
    loginSubtitle: 'Atiende bebidas, desayunos y repostería con un flujo rápido y visual.',
    salesTitle: 'Mostrador de cafetería',
    salesSubtitle: 'Café, bebidas frías, postres y combos listos para venta rápida o para llevar.',
    searchPlaceholder: 'Buscar café, bebida, postre o combo...',
    quickMenuTitle: 'Operación de cafetería',
    quickMenuItems: [
      'Separa bebidas, desayunos, postres y combos',
      'Ideal para mostrador, take out y delivery',
      'Controla tiempos de preparación y productos del día'
    ],
    quickMenuNote: 'Perfecto para coffee shops, cafeterías y desayunos rápidos.',
    categories: ['Cafés', 'Bebidas frías', 'Postres', 'Desayunos', 'Combos'],
    products: [
      { codigo: 'CAF-ESP', nombre: 'Espresso', categoria: 'Cafés', precioCompra: 18, precioVenta: 80, stock: 120, stockMin: 20, tipoProducto: 'bebida', tiempoPreparacion: 3 },
      { codigo: 'CAF-LAT', nombre: 'Latte', categoria: 'Cafés', precioCompra: 35, precioVenta: 145, stock: 80, stockMin: 12, tipoProducto: 'bebida', tiempoPreparacion: 5 },
      { codigo: 'FRA-CHO', nombre: 'Frappé de chocolate', categoria: 'Bebidas frías', precioCompra: 55, precioVenta: 185, stock: 40, stockMin: 6, tipoProducto: 'bebida', tiempoPreparacion: 6 },
      { codigo: 'CROISSANT', nombre: 'Croissant de mantequilla', categoria: 'Desayunos', precioCompra: 28, precioVenta: 75, stock: 55, stockMin: 10, tipoProducto: 'general', tiempoPreparacion: 1 }
    ]
  },
  licoreria: {
    key: 'licoreria',
    label: 'Licorería',
    accent: '#7C3AED',
    accentLight: '#A78BFA',
    loginSubtitle: 'Maneja botellas, cervezas, combos y caja nocturna con rapidez.',
    salesTitle: 'Mostrador de licorería',
    salesSubtitle: 'Controla bebidas, combos y stock por marca o presentación.',
    searchPlaceholder: 'Buscar ron, whisky, cerveza o combo...',
    quickMenuTitle: 'Operación de licorería',
    quickMenuItems: [
      'Organiza bebidas por marca, presentación y categoría',
      'Ideal para ventas rápidas, combos y caja nocturna',
      'Mantén visibles los artículos agotados o premium'
    ],
    quickMenuNote: 'Buena base para licorerías, drinks stores y tiendas de bebidas.',
    categories: ['Whisky', 'Ron', 'Vodka', 'Cervezas', 'Vinos', 'Combos'],
    products: [
      { codigo: 'RON-700', nombre: 'Ron añejo 700ml', categoria: 'Ron', precioCompra: 420, precioVenta: 650, stock: 24, stockMin: 4, tipoProducto: 'bebida', tiempoPreparacion: 0 },
      { codigo: 'WHIS-750', nombre: 'Whisky 750ml', categoria: 'Whisky', precioCompra: 980, precioVenta: 1350, stock: 18, stockMin: 3, tipoProducto: 'bebida', tiempoPreparacion: 0 },
      { codigo: 'CERV-LAT', nombre: 'Cerveza lata', categoria: 'Cervezas', precioCompra: 58, precioVenta: 95, stock: 110, stockMin: 20, tipoProducto: 'bebida', tiempoPreparacion: 0 },
      { codigo: 'COMBO-FIE', nombre: 'Combo fiesta', categoria: 'Combos', precioCompra: 950, precioVenta: 1490, stock: 10, stockMin: 2, tipoProducto: 'combo', tiempoPreparacion: 0 }
    ]
  },
  repuestos: {
    key: 'repuestos',
    label: 'Repuestos / Autopartes',
    accent: '#DC2626',
    accentLight: '#F87171',
    loginSubtitle: 'Vende piezas, lubricantes y accesorios con mejor orden por referencia.',
    salesTitle: 'Mostrador de repuestos',
    salesSubtitle: 'Organiza autopartes, aceites y accesorios con enfoque en referencia y marca.',
    searchPlaceholder: 'Buscar pieza, referencia o marca...',
    quickMenuTitle: 'Operación de repuestos',
    quickMenuItems: [
      'Controla piezas por referencia y compatibilidad',
      'Separa lubricantes, filtros y accesorios',
      'Ideal para mostrador técnico y ventas por código'
    ],
    quickMenuNote: 'Base pensada para repuestos automotrices, motos y accesorios.',
    categories: ['Filtros', 'Aceites', 'Frenos', 'Baterías', 'Accesorios'],
    products: [
      { codigo: 'FILT-ACE', nombre: 'Filtro de aceite', categoria: 'Filtros', precioCompra: 180, precioVenta: 280, stock: 32, stockMin: 6, tipoProducto: 'repuesto', tiempoPreparacion: 0 },
      { codigo: 'ACEI-20W', nombre: 'Aceite 20W50', categoria: 'Aceites', precioCompra: 240, precioVenta: 360, stock: 46, stockMin: 8, tipoProducto: 'general', tiempoPreparacion: 0 },
      { codigo: 'PAST-FRE', nombre: 'Pastillas de freno', categoria: 'Frenos', precioCompra: 520, precioVenta: 760, stock: 18, stockMin: 3, tipoProducto: 'repuesto', tiempoPreparacion: 0 },
      { codigo: 'BAT-NS40', nombre: 'Batería NS40', categoria: 'Baterías', precioCompra: 2450, precioVenta: 3150, stock: 9, stockMin: 2, tipoProducto: 'repuesto', tiempoPreparacion: 0 }
    ]
  },
  veterinaria: {
    key: 'veterinaria',
    label: 'Veterinaria / Mascotas',
    accent: '#0EA5A4',
    accentLight: '#2DD4BF',
    loginSubtitle: 'Controla consultas, alimentos, medicamentos y productos para mascotas.',
    salesTitle: 'Atención veterinaria',
    salesSubtitle: 'Mezcla servicios, medicinas y accesorios en una sola caja.',
    searchPlaceholder: 'Buscar alimento, medicina o servicio...',
    quickMenuTitle: 'Operación veterinaria',
    quickMenuItems: [
      'Separa servicios, alimentos y medicamentos',
      'Ideal para clínicas, pet shops y consultas',
      'Controla productos y atención desde un mismo sistema'
    ],
    quickMenuNote: 'Buena base para veterinarias, pet shops y grooming.',
    categories: ['Consultas', 'Medicamentos', 'Alimentos', 'Accesorios', 'Higiene'],
    products: [
      { codigo: 'CONS-GEN', nombre: 'Consulta general', categoria: 'Consultas', precioCompra: 0, precioVenta: 900, stock: 999, stockMin: 0, tipoProducto: 'servicio', tiempoPreparacion: 30 },
      { codigo: 'ALIM-CAN', nombre: 'Alimento para perro 2kg', categoria: 'Alimentos', precioCompra: 420, precioVenta: 620, stock: 20, stockMin: 4, tipoProducto: 'general', tiempoPreparacion: 0 },
      { codigo: 'ANTIPUL', nombre: 'Antipulgas', categoria: 'Medicamentos', precioCompra: 180, precioVenta: 295, stock: 28, stockMin: 5, tipoProducto: 'medicamento', tiempoPreparacion: 0 },
      { codigo: 'SHAM-MAS', nombre: 'Shampoo para mascota', categoria: 'Higiene', precioCompra: 140, precioVenta: 240, stock: 26, stockMin: 4, tipoProducto: 'general', tiempoPreparacion: 0 }
    ]
  },
  papeleria: {
    key: 'papeleria',
    label: 'Papelería / Librería',
    accent: '#0369A1',
    accentLight: '#38BDF8',
    loginSubtitle: 'Controla útiles, impresión, artículos de oficina y librería.',
    salesTitle: 'Mostrador de papelería',
    salesSubtitle: 'Vende útiles, artículos de oficina y servicios de impresión con orden.',
    searchPlaceholder: 'Buscar útil, artículo o servicio...',
    quickMenuTitle: 'Operación de papelería',
    quickMenuItems: [
      'Organiza útiles, cuadernos, bolígrafos y artículos de oficina',
      'Ofrece servicios de impresión y fotocopiado',
      'Controla stock de artículos de temporada'
    ],
    quickMenuNote: 'Ideal para papelerías, librerías y tiendas de artículos de oficina.',
    categories: ['Útiles', 'Papelería', 'Oficina', 'Impresión', 'Libros'],
    products: [
      { codigo: 'CUAD-100', nombre: 'Cuaderno 100 hojas', categoria: 'Útiles', precioCompra: 35, precioVenta: 60, stock: 80, stockMin: 15, tipoProducto: 'general', tiempoPreparacion: 0 },
      { codigo: 'BOLIG-AZU', nombre: 'Bolígrafo azul', categoria: 'Útiles', precioCompra: 8, precioVenta: 15, stock: 200, stockMin: 30, tipoProducto: 'general', tiempoPreparacion: 0 },
      { codigo: 'PAPEL-CARTA', nombre: 'Resma papel carta', categoria: 'Papelería', precioCompra: 220, precioVenta: 320, stock: 30, stockMin: 5, tipoProducto: 'general', tiempoPreparacion: 0 },
      { codigo: 'IMP-PAGINA', nombre: 'Impresión por página', categoria: 'Impresión', precioCompra: 2, precioVenta: 10, stock: 9999, stockMin: 0, tipoProducto: 'servicio', tiempoPreparacion: 1 }
    ]
  },
  otro: {
    key: 'otro',
    label: 'Otro tipo de negocio',
    accent: '#6B7280',
    accentLight: '#9CA3AF',
    loginSubtitle: 'Configura Tecno Caja para cualquier tipo de negocio.',
    salesTitle: 'Punto de venta',
    salesSubtitle: 'Catálogo general listo para adaptar a cualquier rubro.',
    searchPlaceholder: 'Buscar producto o servicio...',
    quickMenuTitle: 'Operación general',
    quickMenuItems: [
      'Crea categorías y productos según tu negocio',
      'Controla inventario, caja y ventas desde un solo lugar',
      'Agrega clientes, suplidores y reportes según necesites'
    ],
    quickMenuNote: 'Configura el catálogo a tu medida desde el módulo de productos.',
    categories: ['General', 'Servicios', 'Productos', 'Otros'],
    products: []
  }
};
// === CORS: allowlist segura (extraído a server/config/cors.js) ===
const { corsOptions: CORS_OPTIONS } = require('./server/config/cors');

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: CORS_OPTIONS
});

// === Helmet + rate limiter (extraído a server/config/security.js) ===
const { helmetMiddleware, loginLimiter, bindHost: DEFAULT_BIND_HOST } = require('./server/config/security');
app.set('trust proxy', 1);
if (helmetMiddleware) app.use(helmetMiddleware);

app.use(cors(CORS_OPTIONS));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));
app.use(PRODUCT_UPLOAD_WEB_PATH, express.static(PRODUCT_UPLOAD_DIR));

// ✅ Rutas de sincronización Firebase
app.use('/api/sync', syncRoutes);

// ✅ Gestor de archivos Sistema_Data
const fileManagerService = createFileManagerService({
  query,
  userDataPath: process.env.TECNO_CAJA_USER_DATA || os.homedir(),
});
app.use('/api/files', createFileManagerRouter({ fileManagerService, query }));

// ✅ Rutas de Delivery — app repartidores Tecno Caja
app.use('/api/delivery', createDeliveryRouter({ query }));

// ✅ Nuevo módulo e-CF limpio
app.use('/api/ecf', ecfModule.apiRouter);

// ✅ Rutas fiscales anteriores desactivadas para evitar mezclar legado con v2
app.use('/api/fiscal', ecfModule.legacyApiRouter);
app.use(ecfModule.legacyPublicRouter);

// ✅ Consulta RNC — dataset DGII local (dgii-rnc)
app.use(createRncRouter());

// ✅ Rutas Red de Terminales — multicaja LAN + sucursales remotas
app.use('/api/network', createNetworkRouter({ query, resolveRequestActorUser }));

// ✅ Báscula TCP — inyectar instancia io y cargar config guardada
bascula.setIo(io);
(async () => {
  try {
    const rows = await query(
      `SELECT config_value FROM installation_config WHERE config_key = 'bascula_config' LIMIT 1`
    );
    if (rows.length) {
      const cfg = JSON.parse(rows[0].config_value || '{}');
      if (cfg.ip && cfg.port && cfg.autoconnect !== false) {
        bascula.connect(cfg.ip, cfg.port);
      }
    }
  } catch (_) { /* tabla puede no existir aún */ }
})();

// ── Socket.IO: tracking de presencia de terminales ────────────────────────────
io.on('connection', (socket) => {
  // Cuando un terminal anuncia su identidad al conectar
  socket.on('terminal:announce', async (data) => {
    try {
      if (!data?.terminalId) return;
      const configRows = await query('SELECT business_id FROM config WHERE id = 1 LIMIT 1');
      const businessId = Number(configRows[0]?.business_id || 1);
      const ipRaw      = socket.handshake?.address || socket.request?.connection?.remoteAddress || null;
      const ipAddress  = ipRaw ? ipRaw.replace('::ffff:', '') : null;

      await registerTerminal(query, {
        terminalId:    data.terminalId,
        terminalName:  data.terminalName   || data.terminalId,
        branchId:      data.branchId       || null,
        cashRegisterId: data.cashRegisterId || null,
        businessId,
        ipAddress,
        connectionType: data.connectionType || (ipAddress === '127.0.0.1' ? 'local' : 'lan'),
        isMain:         !!data.isMain,
        registeredBy:  'socket',
        socketId:      socket.id
      });
    } catch (_) {}
  });

  // Al desconectarse, marcar offline
  socket.on('disconnect', async () => {
    try {
      await markOfflineBySocket(query, socket.id);
    } catch (_) {}
  });
});

// ✅ Rutas offline multicaja — se registra después de que getTerminalConfig esté definida
// El router se crea en un setter diferido para poder pasar la referencia a resolveRequestActorUser
let _offlineRouter = null;
function getOfflineRouter() {
  if (!_offlineRouter) {
    _offlineRouter = createOfflineRouter({
      query,
      localQuery,
      localCacheStatus: getLocalCacheStatus,
      generateOfflineId,
      logSyncEvent: logLocalSync,
      resolveUser: resolveRequestActorUser,
      getTerminalConfig
    });
  }
  return _offlineRouter;
}
app.use('/api/offline', (req, res, next) => getOfflineRouter()(req, res, next));

// Caché en memoria para sesiones autenticadas — permite que los tokens válidos
// sigan funcionando cuando MySQL no está disponible (modo offline multicaja).
const _authSessionCache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _authSessionCache.entries()) {
    if (v.expiresAt <= now) _authSessionCache.delete(k);
  }
}, 10 * 60 * 1000).unref();

app.use(async (req, _res, next) => {
  try {
    const token = readAuthToken(req);
    if (!token) { next(); return; }

    const sessionRow = await getDbSession(token);
    if (!sessionRow) {
      // MySQL caído o sesión no encontrada — intentar caché offline
      const cached = _authSessionCache.get(token);
      if (cached && cached.expiresAt > Date.now()) {
        req.authToken = token;
        req.authUser = cached.user;
      }
      next(); return;
    }

    const user = await getUserWithRoleContextById(sessionRow.user_id);
    if (!user || String(user.estado || '').trim().toLowerCase() !== 'activo') {
      _authSessionCache.delete(token);
      await destroyAuthSession(token);
      next();
      return;
    }
    await touchAuthSession(token);
    // Guardar en caché para fallback offline
    _authSessionCache.set(token, { user, expiresAt: Date.now() + TECNO_CAJA_AUTH_SESSION_TTL_MS });
    req.authToken = token;
    req.authUser = user;
    next();
  } catch (error) {
    // Error inesperado — intentar caché antes de propagar
    try {
      const token = readAuthToken(req);
      if (token) {
        const cached = _authSessionCache.get(token);
        if (cached && cached.expiresAt > Date.now()) {
          req.authToken = token;
          req.authUser = cached.user;
          next(); return;
        }
      }
    } catch (_) {}
    next(error);
  }
});

// ✅ Respaldo local + nube — registrado DESPUÉS del middleware de auth para que
//    req.authUser esté disponible en las rutas de respaldo.
createRespaldosRouter({
  app,
  query,
  getActor,
  writeAuditLog,
  ensureAdministrator,
  isGlobalAdministratorUser,
  resolveRequestActorUser,
});

const LOCAL_PASSWORD_HASH_PREFIX = 'scrypt';
const TECNO_CAJA_AUTH_SCHEME = 'Bearer';
const TECNO_CAJA_AUTH_SESSION_TTL_MS = 1000 * 60 * 60 * 16;
// ── Rate limiting en memoria para login ──────────────────────────────────
const _loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = 6;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function checkLoginRateLimit(identifier) {
  const now = Date.now();
  const rec = _loginAttempts.get(identifier) || { count: 0, since: now };
  if (now - rec.since > LOGIN_WINDOW_MS) {
    _loginAttempts.set(identifier, { count: 1, since: now });
    return { allowed: true, remaining: LOGIN_MAX_ATTEMPTS - 1 };
  }
  if (rec.count >= LOGIN_MAX_ATTEMPTS) {
    const retryAfter = Math.ceil((LOGIN_WINDOW_MS - (now - rec.since)) / 1000);
    return { allowed: false, retryAfter };
  }
  rec.count++;
  _loginAttempts.set(identifier, rec);
  return { allowed: true, remaining: LOGIN_MAX_ATTEMPTS - rec.count };
}

function resetLoginRateLimit(identifier) {
  _loginAttempts.delete(identifier);
}

// ── Sesiones en base de datos (reemplaza Map en memoria) ─────────────────
async function ensureSessionTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS sesiones_activas (
      id VARCHAR(64) PRIMARY KEY,
      user_id INT NOT NULL,
      ip_address VARCHAR(45) DEFAULT NULL,
      user_agent TEXT DEFAULT NULL,
      session_type VARCHAR(20) NOT NULL DEFAULT 'desktop',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_active INTEGER NOT NULL DEFAULT 1
    )
  `);
  // Migración: agregar session_type si la tabla ya existía sin esa columna
  try {
    await query(`ALTER TABLE sesiones_activas ADD COLUMN session_type VARCHAR(20) NOT NULL DEFAULT 'desktop'`);
  } catch (_migErr) { /* columna ya existe — ignorar */ }
  await query(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario VARCHAR(100) DEFAULT NULL,
      ip_address VARCHAR(45) DEFAULT NULL,
      success INTEGER NOT NULL DEFAULT 0,
      attempted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function getDbSession(token) {
  if (!token) return null;
  try {
    const rows = await query(
      `SELECT * FROM sesiones_activas WHERE id = ? AND is_active = 1 AND expires_at > datetime('now') LIMIT 1`,
      [token]
    );
    return rows[0] || null;
  } catch (_e) {
    return null;
  }
}

async function createAuthSession(user, ip = null, ua = null, sessionType = 'desktop') {
  const token = crypto.randomBytes(32).toString('hex');
  const userId = Number(user?.id || 0);
  const safeType = ['desktop', 'reports', 'mobile'].includes(sessionType) ? sessionType : 'desktop';
  const expiresAt = new Date(Date.now() + TECNO_CAJA_AUTH_SESSION_TTL_MS)
    .toISOString().replace('T', ' ').slice(0, 19);
  const shouldInvalidatePreviousSessions = safeType !== 'reports';
  try {
    // Reportes puede abrir varias peticiones/tablas a la vez; no conviene matar
    // la sesión anterior mientras otra solicitud sigue en curso.
    if (shouldInvalidatePreviousSessions) {
      await query(
        `UPDATE sesiones_activas SET is_active = 0 WHERE user_id = ? AND session_type = ? AND is_active = 1`,
        [userId, safeType]
      );
    }
    await query(
      `INSERT INTO sesiones_activas (id, user_id, ip_address, user_agent, session_type, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [token, userId, ip, ua ? String(ua).slice(0, 500) : null, safeType, expiresAt]
    );
  } catch (_e) {
    // Fallback en memoria si la tabla aún no existe
    if (shouldInvalidatePreviousSessions) {
      for (const [k, v] of _sessionFallback.entries()) {
        if (v.user_id === userId && (v.session_type || 'desktop') === safeType) _sessionFallback.delete(k);
      }
    }
    _sessionFallback.set(token, { user_id: userId, session_type: safeType, expires_at: Date.now() + TECNO_CAJA_AUTH_SESSION_TTL_MS });
  }
  return token;
}

async function destroyAuthSession(token) {
  if (!token) return;
  try {
    await query(`UPDATE sesiones_activas SET is_active = 0 WHERE id = ?`, [token]);
  } catch (_e) {
    _sessionFallback.delete(token);
  }
}

async function touchAuthSession(token) {
  if (!token) return;
  try {
    const newExpires = new Date(Date.now() + TECNO_CAJA_AUTH_SESSION_TTL_MS)
      .toISOString().replace('T', ' ').slice(0, 19);
    await query(
      `UPDATE sesiones_activas SET last_seen_at = datetime('now'), expires_at = ? WHERE id = ?`,
      [newExpires, token]
    );
  } catch (_e) { /* ignore */ }
}

async function pruneExpiredAuthSessions() {
  try {
    await query(`UPDATE sesiones_activas SET is_active = 0 WHERE expires_at <= datetime('now') AND is_active = 1`);
  } catch (_e) { /* ignore */ }
}

const _sessionFallback = new Map();
const BRANCH_ADMIN_ALLOWED_PERMISSIONS = [
  'dashboard_sucursal',
  'ver_dashboard_sucursal',
  'caja',
  'cajas',
  'ver_cajas_sucursal',
  'crear_cajas_sucursal',
  'editar_cajas_sucursal',
  'activar_cajas_sucursal',
  'asignar_cajeros_sucursal',
  // Operaciones de caja (admin sucursal tiene control completo de caja)
  'abrir_caja',
  'cerrar_caja',
  'hacer_corte_caja',
  'abrir_gaveta',
  'devolver_ventas',
  'anular_ventas',
  'ver_reportes_caja',
  'ver_cierres_caja',
  'ver_ganancias',
  'usuarios',
  'usuarios_crear',
  'usuarios_editar',
  'ver_usuarios_sucursal',
  'crear_cajeros_sucursal',
  'crear_supervisores_sucursal',
  'editar_usuarios_sucursal',
  'activar_usuarios_sucursal',
  'resetear_password_usuarios_sucursal',
  'ventas',
  'ver_ventas_sucursal',
  'ver_cierres_caja_sucursal',
  'ver_aperturas_caja_sucursal',
  'reportes_sucursal',
  'ver_reportes_sucursal',
  'inventario',
  'ver_inventario_sucursal',
  'registrar_movimientos_internos_sucursal',
  'ver_productos_sucursal',
  'consultar_stock_sucursal',
  'ver_arqueos_caja_sucursal',
  'ver_historial_inventario_sucursal',
  'clientes'
];
const BRANCH_ADMIN_DENIED_PERMISSIONS = [
  'crear_sucursales',
  'editar_otras_sucursales',
  'ver_otras_sucursales',
  'ver_reportes_globales',
  'gestionar_licencia',
  'gestionar_configuracion_global',
  'ver_usuarios_globales',
  'crear_admin_general',
  'editar_roles_globales',
  'cambiar_precios_globales',
  'borrar_ventas',
  'anular_cierres_caja',
  'eliminar_movimientos_inventario',
  'exportar_base_datos',
  'ver_ganancias_otras_sucursales',
  'gestionar_configuracion_fiscal',
  'gestionar_ecf',
  'crear_productos_globales',
  'editar_productos_globales',
  'transferir_productos_entre_sucursales',
  'aprobar_movimientos_otras_sucursales',
  'auditoria_global',
  'ver_respaldos_globales'
];

function normalizeLegacyUserRoleCode(roleLabel) {
  const normalized = String(roleLabel || '').trim().toLowerCase();
  if (normalized === 'administrador_general' || normalized === 'administrador general') return 'administrador_general';
  if (normalized === 'administrador_sucursal' || normalized === 'administrador sucursal') return 'administrador_sucursal';
  if (normalized === 'administrador' || normalized === 'admin' || normalized === 'admin general' || normalized === 'admin_general') return 'administrador_general';
  if (normalized === 'supervisor') return 'supervisor';
  if (normalized === 'cajero' || normalized === 'delivery') return 'cajero';
  return normalized || 'cajero';
}

function getUserBranchIdValue(row) {
  const value = row?.sucursal_id ?? row?.branch_id;
  return value === null || value === undefined ? null : Number(value);
}

function getUserCashRegisterIdValue(row) {
  const value = row?.caja_id ?? row?.cash_register_id;
  return value === null || value === undefined ? null : Number(value);
}

function normalizeBillingFunctionType(value, fallback = 'mixta') {
  const normalized = String(value || '').trim().toLowerCase();
  if (['mixta', 'facturacion', 'cobro', 'centralizadora'].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function getBillingFunctionLabel(value) {
  const normalized = normalizeBillingFunctionType(value);
  return {
    mixta: 'Mixta',
    facturacion: 'Facturación',
    cobro: 'Cobro',
    centralizadora: 'Centralizadora'
  }[normalized] || 'Mixta';
}

function getBillingFunctionCapabilities(value) {
  const type = normalizeBillingFunctionType(value);
  if (type === 'facturacion') {
    return { type, canCreateSales: true, canChargePending: false, forcePendingCharge: true };
  }
  if (type === 'cobro') {
    return { type, canCreateSales: false, canChargePending: true, forcePendingCharge: false };
  }
  return { type, canCreateSales: true, canChargePending: true, forcePendingCharge: false };
}

function buildEffectiveBillingCapabilities(userType, cashRegisterType) {
  const normalizedUserType = normalizeBillingFunctionType(userType);
  const normalizedCashRegisterType = normalizeBillingFunctionType(cashRegisterType);
  const userCaps = getBillingFunctionCapabilities(normalizedUserType);
  const cashRegisterCaps = getBillingFunctionCapabilities(normalizedCashRegisterType);

  return {
    userType: normalizedUserType,
    userTypeLabel: getBillingFunctionLabel(normalizedUserType),
    cashRegisterType: normalizedCashRegisterType,
    cashRegisterTypeLabel: getBillingFunctionLabel(normalizedCashRegisterType),
    canCreateSales: Boolean(userCaps.canCreateSales && cashRegisterCaps.canCreateSales),
    canChargePending: Boolean(userCaps.canChargePending && cashRegisterCaps.canChargePending),
    forcePendingCharge: Boolean(
      userCaps.canCreateSales
      && cashRegisterCaps.canCreateSales
      && (userCaps.forcePendingCharge || cashRegisterCaps.forcePendingCharge)
    )
  };
}

async function resolveEffectiveBillingAccess(conn, actorUser, cashRegisterId = null) {
  let cashRegisterType = 'mixta';
  const normalizedCashRegisterId = Number(cashRegisterId || 0) || null;

  if (normalizedCashRegisterId) {
    const cashRegisterRows = await conn.query(
      'SELECT tipo_caja FROM cash_registers WHERE id = ? LIMIT 1',
      [normalizedCashRegisterId]
    ).catch(() => []);
    cashRegisterType = normalizeBillingFunctionType(cashRegisterRows[0]?.tipo_caja || 'mixta');
  }

  return buildEffectiveBillingCapabilities(
    actorUser?.tipo_facturacion || actorUser?.tipoFacturacion || 'mixta',
    cashRegisterType
  );
}

function createHttpError(message, statusCode = 403) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isGlobalAdministratorUser(user) {
  return normalizeLegacyUserRoleCode(user?.role_code || user?.rol) === 'administrador_general';
}

function isBranchAdministratorUser(user) {
  return normalizeLegacyUserRoleCode(user?.role_code || user?.rol) === 'administrador_sucursal';
}

function isSupervisorUser(user) {
  return normalizeLegacyUserRoleCode(user?.role_code || user?.rol) === 'supervisor';
}

function isCashierUser(user) {
  return normalizeLegacyUserRoleCode(user?.role_code || user?.rol) === 'cajero';
}

function getUserScopeBranchId(user) {
  if (!user) return null;
  const roleCode = normalizeLegacyUserRoleCode(user?.role_code || user?.rol);
  if (['administrador_sucursal', 'supervisor', 'cajero'].includes(roleCode)) {
    return getUserBranchIdValue(user);
  }
  return null;
}

function getUserScopeCashRegisterId(user) {
  if (!user) return null;
  return isCashierUser(user) ? getUserCashRegisterIdValue(user) : null;
}

function getRequestRoleCode(req) {
  return normalizeLegacyUserRoleCode(
    req.authUser?.role_code
    || req.authUser?.rol
    || req.body?.actorUserRole
    || req.query?.actorUserRole
  );
}

function getRequestActorFallbackId(req) {
  return Number(req.body?.actorUserId || req.query?.actorUserId || 0) || null;
}

function userCanManageGlobalConfig(user) {
  return isGlobalAdministratorUser(user) || userRoleHasPermission(user, 'gestionar_configuracion_global');
}

function userCanAccessGlobalAudit(user) {
  return isGlobalAdministratorUser(user) || userRoleHasPermission(user, 'auditoria_global');
}

function userCanManageGlobalProductCatalog(user) {
  return isGlobalAdministratorUser(user) || userRoleHasPermission(user, 'crear_productos_globales', 'editar_productos_globales');
}

function userCanManageCashRegisters(user) {
  return isGlobalAdministratorUser(user)
    || isBranchAdministratorUser(user)
    || userRoleHasPermission(user, 'ver_cajas_sucursal', 'crear_cajas_sucursal', 'editar_cajas_sucursal');
}

function userCanManageTransfers(user) {
  return isGlobalAdministratorUser(user) || userRoleHasPermission(user, 'transferir_productos_entre_sucursales');
}

function userCanResetScopedPasswords(user) {
  return isGlobalAdministratorUser(user) || userRoleHasPermission(user, 'resetear_password_usuarios_sucursal');
}

// ─── Permisos de caja y turnos ────────────────────────────────────────────────

function userCanOpenCash(user) {
  if (!user) return false;
  if (isGlobalAdministratorUser(user) || isBranchAdministratorUser(user) || isSupervisorUser(user)) return true;
  if (isCashierUser(user)) return true;
  return userRoleHasPermission(user, 'abrir_caja');
}

function userCanCloseCash(user) {
  if (!user) return false;
  if (isGlobalAdministratorUser(user) || isBranchAdministratorUser(user) || isSupervisorUser(user)) return true;
  if (isCashierUser(user)) return true;
  return userRoleHasPermission(user, 'cerrar_caja');
}

function userCanMakeCorte(user) {
  if (!user) return false;
  if (isGlobalAdministratorUser(user) || isBranchAdministratorUser(user) || isSupervisorUser(user)) return true;
  if (isCashierUser(user)) return true;
  return userRoleHasPermission(user, 'hacer_corte_caja');
}

function userCanOpenDrawer(user) {
  if (!user) return false;
  if (isGlobalAdministratorUser(user) || isBranchAdministratorUser(user) || isSupervisorUser(user)) return true;
  if (isCashierUser(user)) return true;
  return userRoleHasPermission(user, 'abrir_gaveta');
}

function userCanVoidSales(user) {
  if (!user) return false;
  if (isGlobalAdministratorUser(user) || isBranchAdministratorUser(user) || isSupervisorUser(user)) return true;
  return userRoleHasPermission(user, 'anular_ventas');
}

function userCanReturnSales(user) {
  if (!user) return false;
  if (isGlobalAdministratorUser(user) || isBranchAdministratorUser(user) || isSupervisorUser(user)) return true;
  return userRoleHasPermission(user, 'devolver_ventas');
}

function userCanViewCashReports(user) {
  if (!user) return false;
  if (isGlobalAdministratorUser(user) || isBranchAdministratorUser(user) || isSupervisorUser(user)) return true;
  return userRoleHasPermission(user, 'ver_reportes_caja');
}

function userCanViewProfits(user) {
  if (!user) return false;
  if (isGlobalAdministratorUser(user)) return true;
  return userRoleHasPermission(user, 'ver_ganancias');
}

// ─────────────────────────────────────────────────────────────────────────────
// Timezone de República Dominicana
// ─────────────────────────────────────────────────────────────────────────────
const RD_TIMEZONE = 'America/Santo_Domingo';

/**
 * Devuelve fecha y hora local en zona RD como strings.
 * @returns {{ fecha_local: string, hora_local: string, datetime_local: string }}
 */
function getLocalDateTimeRD(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  // Crear fecha en zona RD usando el método recomendado
  const rdStr = date.toLocaleString('sv-SE', { timeZone: RD_TIMEZONE });
  // sv-SE da formato YYYY-MM-DD HH:MM:SS
  const [fechaPart, horaPart] = rdStr.split(' ');
  return {
    fecha_local: fechaPart || '',
    hora_local: horaPart || '',
    datetime_local: rdStr.replace(' ', 'T'),
  };
}

/**
 * Devuelve `datetime('now')` en formato MariaDB/SQLite para zona RD.
 * Usa el offset fijo de RD (-04:00) ya que no observa DST.
 */
function nowRD() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: RD_TIMEZONE }));
}

function nowRDString() {
  const { datetime_local } = getLocalDateTimeRD();
  return datetime_local.replace('T', ' ');
}

function toLocalDateKeyRD(value = new Date()) {
  const date = value instanceof Date ? value : parseStoredDateTime(value);
  return getLocalDateTimeRD(date || new Date()).fecha_local;
}

// ─────────────────────────────────────────────────────────────────────────────

function readAuthToken(req) {
  const authorization = String(req.headers?.authorization || '').trim();
  if (authorization.toLowerCase().startsWith(`${TECNO_CAJA_AUTH_SCHEME.toLowerCase()} `)) {
    return authorization.slice(TECNO_CAJA_AUTH_SCHEME.length + 1).trim();
  }
  return String(req.headers?.['x-auth-token'] || '').trim();
}

function roleNeedsBranchAssignment(roleCode) {
  return normalizeLegacyUserRoleCode(roleCode) !== 'administrador_general';
}

function roleNeedsCashRegisterAssignment(roleCode) {
  return normalizeLegacyUserRoleCode(roleCode) === 'cajero';
}

function isGlobalUserManagementRole(roleCode) {
  return normalizeLegacyUserRoleCode(roleCode) === 'administrador_general';
}

function canUseGoogleStaffAccess(roleCode) {
  const normalized = normalizeLegacyUserRoleCode(roleCode);
  return ['administrador_general', 'administrador_sucursal', 'supervisor'].includes(normalized);
}

function createLocalPasswordHash(password) {
  const rawPassword = String(password ?? '');
  if (!rawPassword) return null;
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(rawPassword, salt, 64).toString('hex');
  return `${LOCAL_PASSWORD_HASH_PREFIX}:${salt}:${derived}`;
}

function verifyLocalPasswordHash(password, passwordHash) {
  const rawPassword = String(password ?? '');
  const storedHash = String(passwordHash || '').trim();
  if (!rawPassword || !storedHash) return false;

  const [prefix, salt, expectedHex] = storedHash.split(':');
  if (prefix !== LOCAL_PASSWORD_HASH_PREFIX || !salt || !expectedHex) {
    return false;
  }

  try {
    const expected = Buffer.from(expectedHex, 'hex');
    const derived = crypto.scryptSync(rawPassword, salt, expected.length);
    return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
  } catch (_error) {
    return false;
  }
}

function userPasswordMatches(user, password) {
  const storedHash = String(user?.password_hash || '').trim();
  if (storedHash) {
    return verifyLocalPasswordHash(password, storedHash);
  }
  return String(user?.password || '') === String(password ?? '');
}

function mapUserRow(row) {
  const roleCode = String(row.role_code || '').trim() || normalizeLegacyUserRoleCode(row.rol);
  const tipoFacturacion = normalizeBillingFunctionType(row.tipo_facturacion || row.tipoFacturacion || 'mixta');
  const firebaseUid = String(row.firebase_uid || row.firebaseUid || '').trim();
  return {
    id: row.id,
    usuario: row.usuario,
    email: row.email || '',
    nombre: row.nombre,
    rol: row.rol,
    roleCode,
    roleName: row.role_name || row.rol,
    roleId: row.role_id === null || row.role_id === undefined ? null : Number(row.role_id),
    sucursalId: getUserBranchIdValue(row),
    cajaId: getUserCashRegisterIdValue(row),
    estado: row.estado,
    lastLogin: row.last_login,
    telefono: row.telefono || '',
    observacion: row.observacion || '',
    tipoFacturacion,
    tipoFacturacionLabel: getBillingFunctionLabel(tipoFacturacion),
    creadoPor: row.creado_por === null || row.creado_por === undefined ? null : Number(row.creado_por),
    fechaCreacion: row.fecha_creacion || row.created_at || null,
    linkedClientId: row.linked_client_id === null || row.linked_client_id === undefined ? null : Number(row.linked_client_id),
    accountType: row.account_type || 'staff',
    authProvider: row.auth_provider || 'local',
    firebaseUid,
    userNumber: String(row.user_number || `pos_user_${row.id || ''}`).trim(),
    localPasswordSet: Boolean(String(row.password_hash || row.password || '').trim()),
    googleLinked: Boolean(firebaseUid),
    rolePermissions: parseJsonArrayField(row.role_permissions)
  };
}

function parseJsonArrayField(value, fallback = []) {
  if (!value) return fallback;
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (_error) {
    return fallback;
  }
}

function parseJsonObjectField(value, fallback = {}) {
  if (!value) return fallback;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch (_error) {
    return fallback;
  }
}

function getDefaultProductImage(productName = 'Producto') {
  const label = encodeURIComponent(String(productName || 'Producto').slice(0, 18));
  return `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='320' height='320' viewBox='0 0 320 320'><defs><linearGradient id='g' x1='0' x2='1' y1='0' y2='1'><stop stop-color='%23f97316'/><stop offset='1' stop-color='%23fb7185'/></linearGradient></defs><rect width='320' height='320' rx='32' fill='url(%23g)'/><g fill='none' stroke='rgba(255,255,255,0.82)' stroke-linecap='round' stroke-linejoin='round' stroke-width='12'><path d='M86 98h20l16 82h88l18-58H116'/><circle cx='138' cy='214' r='12' fill='rgba(255,255,255,0.82)' stroke='none'/><circle cx='222' cy='214' r='12' fill='rgba(255,255,255,0.82)' stroke='none'/></g><path d='M164 88h32' stroke='rgba(255,255,255,0.7)' stroke-width='10' stroke-linecap='round'/><path d='M180 72v32' stroke='rgba(255,255,255,0.7)' stroke-width='10' stroke-linecap='round'/><text x='160' y='290' text-anchor='middle' font-family='Arial' font-size='24' fill='white'>${label}</text></svg>`;
}

function slugifyFileName(value) {
  return String(value || 'producto')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'producto';
}

function ensureProductUploadDir() {
  fs.mkdirSync(PRODUCT_UPLOAD_DIR, { recursive: true });
}

async function removeLocalProductImage(imageLocal) {
  if (!imageLocal) return;
  const fileName = path.basename(String(imageLocal));
  const filePath = path.join(PRODUCT_UPLOAD_DIR, fileName);
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

async function downloadAndSaveProductImage({ productId, productName, imageUrl }) {
  if (!imageUrl) {
    const error = new Error('La URL de imagen es obligatoria.');
    error.statusCode = 400;
    throw error;
  }

  ensureProductUploadDir();
  const response = await fetch(imageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Tecno Caja/1.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Referer': imageUrl,
      'Origin': new URL(imageUrl).origin
    }
  });
  if (!response.ok) {
    const error = new Error('No se pudo descargar la imagen seleccionada.');
    error.statusCode = 502;
    throw error;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const optimized = await sharp(buffer)
    .rotate()
    .resize(900, 900, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  const digest = crypto.createHash('sha1').update(optimized).digest('hex').slice(0, 12);
  const safeName = slugifyFileName(`${productName}-${productId}`);
  const fileName = `${safeName}-${digest}.webp`;
  const filePath = path.join(PRODUCT_UPLOAD_DIR, fileName);

  fs.writeFileSync(filePath, optimized);

  return {
    imageLocal: `${PRODUCT_UPLOAD_WEB_PATH}/${fileName}`.replace(/\\/g, '/'),
    fileName,
    bytes: optimized.length
  };
}

function decodeDataUrlImage(imageData) {
  const match = String(imageData || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    const error = new Error('El archivo seleccionado no tiene un formato válido.');
    error.statusCode = 400;
    throw error;
  }
  return Buffer.from(match[2], 'base64');
}

async function saveProductImageBuffer({ productId, productName, buffer }) {
  ensureProductUploadDir();
  const optimized = await sharp(buffer)
    .rotate()
    .resize(900, 900, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  const digest = crypto.createHash('sha1').update(optimized).digest('hex').slice(0, 12);
  const safeName = slugifyFileName(`${productName}-${productId}`);
  const fileName = `${safeName}-${digest}.webp`;
  const filePath = path.join(PRODUCT_UPLOAD_DIR, fileName);
  fs.writeFileSync(filePath, optimized);
  return {
    imageLocal: `${PRODUCT_UPLOAD_WEB_PATH}/${fileName}`.replace(/\\/g, '/'),
    fileName,
    bytes: optimized.length
  };
}

function mapProductRow(row) {
  return {
    id: row.id,
    codigo: row.codigo,
    nombre: row.nombre,
    categoria: row.categoria,
    marca: row.marca,
    precioCompra: Number(row.precio_compra || 0),
    precioVenta: Number(row.precio_venta || 0),
    stock: Number(row.stock_in_branch ?? row.stock ?? 0),
    stockMin: Number(row.stock_min_in_branch ?? row.stock_min ?? 0),
    stockGlobal: Number(row.stock || 0),
    inventarioSucursalId: row.inventory_branch_id === null || row.inventory_branch_id === undefined ? null : Number(row.inventory_branch_id),
    sucursalInventarioId: row.branch_id === null || row.branch_id === undefined ? null : Number(row.branch_id),
    unidad: row.unidad,
    estado: row.estado,
    imagenUrl: row.image_url || '',
    imagenLocal: row.image_local || '',
    imagen: row.image_local || row.image_url || getDefaultProductImage(row.nombre),
    tipoProducto: row.product_type || 'general',
    tamanos: parseJsonArrayField(row.size_options),
    masas: parseJsonArrayField(row.dough_options),
    bordes: parseJsonArrayField(row.border_options),
    extras: parseJsonArrayField(row.extra_options),
    permiteMitades: Boolean(row.allow_half_and_half),
    esCombo: Boolean(row.is_combo),
    aplicaItbis: Boolean(row.aplica_itbis),
    tiempoPreparacion: Number(row.preparation_time_minutes || 15),
    saleMode: normalizeProductSaleMode(row.sale_mode),
    metaNegocio: parseJsonObjectField(row.business_metadata, {}),
    tracksStock: Boolean(row.tracks_stock ?? 1)
  };
}

async function persistProductsCsvBackup(reason = 'auto') {
  try {
    const rows = await query('SELECT * FROM products ORDER BY nombre, id');
    const snapshot = writeProductsCsvSnapshot(rows, { reason });
    return {
      currentFilePath: snapshot.currentFilePath,
      backupFilePath: snapshot.backupFilePath,
      backupFileName: snapshot.backupFileName,
    };
  } catch (error) {
    console.warn(`[products-csv] No se pudo generar el respaldo CSV (${reason}):`, error.message);
    return null;
  }
}

let _silentProductBackupTimer = null;
function scheduleSilentProductBackup(trigger = 'producto_cambiado') {
  if (_silentProductBackupTimer) clearTimeout(_silentProductBackupTimer);
  _silentProductBackupTimer = setTimeout(() => {
    _silentProductBackupTimer = null;
    const createBackup = app.locals && app.locals.createAutomaticBackup;
    if (typeof createBackup !== 'function') return;
    createBackup({ trigger, forceCloud: true }).catch((error) => {
      console.warn(`[respaldos-auto] No se pudo completar respaldo silencioso (${trigger}):`, error.message);
    });
  }, 2500);
}

function importedProductFieldProvided(record, fieldName) {
  return Array.isArray(record?.providedFields) && record.providedFields.includes(fieldName);
}

function resolveImportedProductString(record, fieldName, fallback = '', defaultValue = '') {
  if (importedProductFieldProvided(record, fieldName)) {
    return String(record?.[fieldName] ?? '').trim();
  }
  return String(fallback ?? defaultValue ?? '').trim();
}

function resolveImportedProductNumber(record, fieldName, fallback = 0, defaultValue = 0) {
  if (importedProductFieldProvided(record, fieldName)) {
    const numeric = Number(record?.[fieldName]);
    return Number.isFinite(numeric) ? numeric : Number(defaultValue || 0);
  }
  const fallbackNumeric = Number(fallback);
  return Number.isFinite(fallbackNumeric) ? fallbackNumeric : Number(defaultValue || 0);
}

function resolveImportedProductBoolean(record, fieldName, fallback = false, defaultValue = false) {
  if (importedProductFieldProvided(record, fieldName)) {
    return Boolean(record?.[fieldName]);
  }
  return Boolean(fallback ?? defaultValue);
}

function normalizeProductSaleMode(value) {
  const normalized = String(value || 'unidad').trim().toLowerCase();
  if (['peso', 'weight'].includes(normalized)) return 'peso';
  if (['medida', 'measure'].includes(normalized)) return 'medida';
  return 'unidad';
}

function normalizeScaleType(value) {
  const normalized = String(value || 'none').trim().toLowerCase();
  if (['usb', 'serial'].includes(normalized)) return normalized;
  return 'none';
}

function normalizeScaleDefaultUnit(value) {
  const normalized = String(value || 'kg').trim().toLowerCase();
  if (['kg', 'lb', 'g'].includes(normalized)) return normalized;
  return 'kg';
}

function sanitizeScaleRoundingDecimals(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 2;
  return Math.max(0, Math.min(2, Math.floor(numeric)));
}

function mapClientRow(row) {
  return {
    id: row.id,
    nombre: row.nombre,
    telefono: row.telefono,
    email: row.email || '',
    direccion: row.direccion,
    cedula: row.cedula,
    referencia: row.reference_note || '',
    linkUbicacion: row.location_link || '',
    latitud: row.latitude === null ? null : Number(row.latitude),
    longitud: row.longitude === null ? null : Number(row.longitude),
    limiteCredito: Number(row.limite_credito || 0),
    balance: Number(row.balance || 0)
  };
}

function normalizeCurrencyAmount(value) {
  return Number(Number(value || 0).toFixed(2));
}

async function getClientRowsWithComputedBalance(clientId = null, executor = query) {
  const runner = typeof executor === 'function' ? executor : executor.query.bind(executor);
  const normalizedId = Number(clientId || 0);
  const where = normalizedId > 0 ? 'WHERE c.id = ?' : '';
  const params = normalizedId > 0 ? [normalizedId] : [];

  return runner(
    `SELECT c.id,
            c.nombre,
            c.telefono,
            c.email,
            c.direccion,
            c.cedula,
            c.reference_note,
            c.location_link,
            c.latitude,
            c.longitude,
            c.limite_credito,
            COALESCE(credit.pending_balance, COALESCE(c.balance, 0), 0) AS balance
     FROM clients c
     LEFT JOIN (
       SELECT client_id,
              ROUND(SUM(
                CASE
                  WHEN payment_method = 'credito'
                   AND COALESCE(fiscal_status, 'emitida') <> 'cancelada'
                   AND COALESCE(total, 0) > COALESCE(received_amount, 0)
                  THEN COALESCE(total, 0) - COALESCE(received_amount, 0)
                  ELSE 0
                END
              ), 2) AS pending_balance
       FROM sales
       WHERE client_id IS NOT NULL
       GROUP BY client_id
     ) credit ON credit.client_id = c.id
     ${where}
     ORDER BY c.nombre`,
    params
  );
}

async function getClientRowWithComputedBalance(clientId, executor = query) {
  const rows = await getClientRowsWithComputedBalance(clientId, executor);
  return rows[0] || null;
}

function buildClientPendingCreditMapFromSaleRows(saleRows = []) {
  const pendingByClient = new Map();

  for (const sale of saleRows || []) {
    const clientId = Number(sale?.client_id || 0);
    if (!clientId) continue;
    if (String(sale?.payment_method || '').trim() !== 'credito') continue;
    if (String(sale?.fiscal_status || 'emitida').trim() === 'cancelada') continue;

    const total = normalizeCurrencyAmount(sale?.total || 0);
    const receivedAmount = normalizeCurrencyAmount(sale?.received_amount || 0);
    const pendingAmount = normalizeCurrencyAmount(Math.max(0, total - receivedAmount));
    if (pendingAmount <= 0) continue;

    pendingByClient.set(
      clientId,
      normalizeCurrencyAmount((pendingByClient.get(clientId) || 0) + pendingAmount)
    );
  }

  return pendingByClient;
}

function normalizeOptionalText(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeNullableCoordinate(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function extractCoordinatesFromLocationLink(link) {
  const raw = String(link || '').trim();
  if (!raw) return { latitud: null, longitud: null };

  const normalized = decodeURIComponent(raw.replace(/\+/g, ' '));
  const patterns = [
    /[?&]q=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i,
    /[?&]query=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i,
    /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i,
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/i,
    /ll=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;

    const latitud = normalizeNullableCoordinate(match[1]);
    const longitud = normalizeNullableCoordinate(match[2]);
    if (latitud !== null && longitud !== null) {
      return { latitud, longitud };
    }
  }

  return { latitud: null, longitud: null };
}

function sanitizeClientPayload(data = {}) {
  return {
    nombre: String(data.nombre || '').trim(),
    telefono: String(data.telefono || '').trim(),
    email: String(data.email || '').trim().toLowerCase(),
    direccion: String(data.direccion || '').trim(),
    cedula: String(data.cedula || '').trim(),
    rnc: String(data.rnc || '').trim(),
    referencia: String(data.referencia || '').trim(),
    linkUbicacion: String(data.linkUbicacion || '').trim(),
    latitud: data.latitud === undefined || data.latitud === null || data.latitud === '' ? null : Number(data.latitud),
    longitud: data.longitud === undefined || data.longitud === null || data.longitud === '' ? null : Number(data.longitud),
    limiteCredito: Number(data.limiteCredito || 0),
    balance: Number(data.balance || 0)
  };
}

async function resolveClientRowAfterInsert(clientId, data = {}) {
  const normalizedId = Number(clientId || 0);
  if (normalizedId > 0) {
    const row = await getClientRowWithComputedBalance(normalizedId);
    if (row) return row;
  }

  const rows = await query(
    `SELECT * FROM clients
     WHERE nombre = ?
       AND COALESCE(telefono, '') = COALESCE(?, '')
       AND COALESCE(cedula, '') = COALESCE(?, '')
     ORDER BY rowid DESC
     LIMIT 1`,
    [
      String(data.nombre || '').trim(),
      normalizeOptionalText(data.telefono),
      normalizeOptionalText(data.cedula)
    ]
  );
  if (!rows[0]?.id) return null;
  return getClientRowWithComputedBalance(rows[0].id);
}

function buildCustomerUsername(email, firebaseUid, clientId) {
  const emailAlias = String(email || '')
    .split('@')[0]
    .replace(/[^a-zA-Z0-9]+/g, '')
    .toLowerCase()
    .slice(0, 18);
  const uidAlias = String(firebaseUid || '')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .toLowerCase()
    .slice(0, 10);
  const base = emailAlias || uidAlias || `cliente${clientId || ''}`;
  return `cliente_${base || 'pos'}`;
}

function createRandomLocalPassword() {
  return crypto.randomBytes(18).toString('hex');
}

function generateMobileConnectionCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let token = '';
  for (let index = 0; index < 8; index += 1) {
    token += chars[bytes[index] % chars.length];
  }
  return `POS-${token.slice(0, 4)}-${token.slice(4)}`;
}

function normalizeMobileConnectionCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

async function trySyncAllPosClientsToFirebase() {
  const status = getFirebaseConfigStatus();
  if (!status.adminEnabled) return { synced: false, reason: status.adminReason || status.reason, collection: status.collection };
  const [clientRows, config] = await Promise.all([
    query('SELECT * FROM clients ORDER BY id'),
    getConfig()
  ]);
  const result = await syncPosClientsToFirestore(clientRows, config);
  return { synced: true, ...result };
}

async function trySyncAllPosAccountsToFirebase() {
  const status = getFirebaseConfigStatus();
  if (!status.adminEnabled) {
    return { synced: false, reason: status.adminReason || status.reason, collection: status.collection };
  }
  const [userRows, config] = await Promise.all([
    query('SELECT * FROM users ORDER BY rol = "Administrador" DESC, id ASC'),
    getConfig({ syncRemote: false })
  ]);
  const result = await syncPosAccountsToFirestore(userRows, config);
  const canonicalLicenseUid = String(result?.licenseDocId || '').trim();
  if (canonicalLicenseUid && canonicalLicenseUid !== String(process.env.TECNO_CAJA_LICENSE_UID || '').trim()) {
    persistRuntimeEnvValues({ TECNO_CAJA_LICENSE_UID: canonicalLicenseUid });
    console.log(`[firebase-admin] UID canónico de licencia detectado: ${canonicalLicenseUid}. Guardado en config/app.env del usuario.`);
  }

  // Sync paralelo a la colección `users` que consume la app móvil de reportes.
  // Solo aplica a users que ya tengan firebase_uid (los que nunca se
  // sincronizaron con Auth se ignoran — no hay UID al cual asociar el doc).
  const reportsResults = { synced: 0, skipped: 0, errors: 0 };
  for (const u of userRows) {
    if (!u?.firebase_uid) { reportsResults.skipped++; continue; }
    try {
      const r = await syncStaffToReportsApp(u, config);
      if (r?.synced) reportsResults.synced++;
      else reportsResults.skipped++;
    } catch (err) {
      console.warn(`Error sincronizando user ${u.id} a app reportes:`, err.message);
      reportsResults.errors++;
    }
  }

  return { synced: true, ...result, reportsApp: reportsResults };
}

/**
 * Sincroniza TODOS los usuarios staff al Firebase Authentication.
 * Crea la cuenta Firebase Auth de los usuarios que aún no tienen firebase_uid,
 * y actualiza la de los que ya la tienen.  Se llama al arranque del servidor
 * y desde POST /api/firebase-sync/auth-all.
 */
async function trySyncAllStaffToFirebaseAuth() {
  const status = getFirebaseConfigStatus();
  if (!status.adminEnabled) {
    return { synced: false, reason: status.adminReason || status.reason };
  }
  await ensureUserExtensions();
  const rows = await query(
    `SELECT * FROM users
     WHERE (account_type IS NULL OR account_type != 'customer')
     ORDER BY id ASC`
  );
  const results = { total: rows.length, synced: 0, skipped: 0, failed: 0, errors: [] };
  for (const user of rows) {
    if (!user.email || !user.password) {
      results.skipped++;
      continue;
    }
    try {
      const result = await trySyncStaffFirebaseAuthForLocalUser(user.id);
      if (result?.synced) {
        results.synced++;
      } else {
        results.skipped++;
      }
    } catch (err) {
      results.failed++;
      results.errors.push({ userId: user.id, email: user.email, error: err.message });
      console.warn(`[firebase-auth-sync] falló usuario ${user.id} (${user.email}): ${err.message}`);
    }
  }
  console.log(`[firebase-auth-sync] Resultado: ${results.synced} sincronizados, ${results.skipped} omitidos, ${results.failed} fallidos de ${results.total} usuarios.`);
  return results;
}

async function tryRepairPendingDeliveryOrdersInFirebase() {
  const status = getFirebaseConfigStatus();
  if (!status.adminEnabled) {
    return { repaired: false, reason: status.adminReason || status.reason, collection: status.collection, count: 0 };
  }

  const rows = await query(
    `SELECT s.invoice_number,
            s.client_name_snapshot,
            s.client_phone_snapshot,
            s.delivery_phone_snapshot,
            s.delivery_address_snapshot,
            s.delivery_reference_snapshot,
            s.delivery_location_link_snapshot,
            b.nombre AS branch_name,
            c.latitude,
            c.longitude
       FROM sales s
       LEFT JOIN branches b ON b.id = s.branch_id
       LEFT JOIN clients c ON c.id = s.client_id
      WHERE s.order_type = 'delivery'
      ORDER BY s.id DESC
      LIMIT 250`
  );

  let patched = 0;
  for (const row of rows) {
    const locationLink = String(row.delivery_location_link_snapshot || '').trim();
    const coordsFromLink = extractCoordinatesFromLocationLink(locationLink);
    const ok = await firebaseSync.patchPedidoDeliveryMetadata({
      invoiceNumber: row.invoice_number,
      clienteNombre: row.client_name_snapshot || 'Consumidor Final',
      clienteTelefono: row.delivery_phone_snapshot || row.client_phone_snapshot || '',
      clienteDireccion: row.delivery_address_snapshot || '',
      clienteReferencia: row.delivery_reference_snapshot || '',
      clienteLocationLink: locationLink,
      clienteLat: normalizeNullableCoordinate(row.latitude) ?? coordsFromLink.latitud,
      clienteLng: normalizeNullableCoordinate(row.longitude) ?? coordsFromLink.longitud,
      negocioNombre: row.branch_name || '',
    });
    if (ok) patched++;
  }

  return { repaired: true, count: patched };
}

async function tryEnsureInitialFirebaseReportsBootstrap() {
  return ensureInitialReportsBootstrap({
    query,
    getConfig: getReportSyncConfig,
    isEnabled: () => reportsSync.isEnabled(),
    bootstrapAll: async (db, config) => {
      const bootstrap = require('./modules/firebase-reports-bootstrap');
      return bootstrap.bootstrapAll(db, config);
    },
    logger: console,
  });
}

async function trySyncStaffFirebaseAuthForLocalUser(userId) {
  const status = getFirebaseConfigStatus();
  if (!status.adminEnabled) {
    return {
      synced: false,
      reason: status.adminReason || status.reason,
      collection: status.collection,
    };
  }

  await ensureUserExtensions();
  const rows = await query('SELECT * FROM users WHERE id = ? LIMIT 1', [userId]);
  const user = rows[0];
  if (!user) {
    return { synced: false, reason: 'Usuario no encontrado.' };
  }

  const result = await syncPosStaffAuthUser(user);
  if (!result?.synced || !result?.uid) {
    return result || { synced: false, reason: 'No se pudo sincronizar con Firebase Auth.' };
  }

  await query(
    `UPDATE users
     SET email = ?, firebase_uid = ?, auth_provider = ?
     WHERE id = ?`,
    [result.email || user.email || null, result.uid, result.authProvider || 'password', userId]
  );

  // Además del doc legacy en `usuarios/pos_user_X`, escribimos el doc que la
  // app móvil de reportes consume: users/{firebaseUid} con esquema en inglés
  // (displayName, businessIds, branchIds, allowedModules, isActive, role).
  let reportsAppSync = { synced: false };
  try {
    const config = await getConfig();
    reportsAppSync = await syncStaffToReportsApp(
      { ...user, firebase_uid: result.uid, email: result.email || user.email || null },
      config
    );
  } catch (err) {
    console.warn('No se pudo sincronizar usuario a coleccion users (app reportes):', err.message);
    reportsAppSync = { synced: false, error: err.message };
  }

  return { synced: true, ...result, reportsApp: reportsAppSync };
}

async function trySyncPosClientToFirebaseById(clientId) {
  const status = getFirebaseConfigStatus();
  if (!status.adminEnabled) return { synced: false, reason: status.adminReason || status.reason, collection: status.collection };
  const [clientRows, config] = await Promise.all([
    query('SELECT * FROM clients WHERE id = ? LIMIT 1', [clientId]),
    getConfig()
  ]);
  if (!clientRows.length) {
    return { synced: false, reason: 'Cliente no encontrado en base local.', collection: status.collection };
  }
  const result = await syncPosClientsToFirestore(clientRows, config);
  return { synced: true, ...result };
}

async function tryDeletePosClientSync(clientId) {
  const status = getFirebaseConfigStatus();
  if (!status.adminEnabled) return { synced: false, reason: status.adminReason || status.reason, collection: status.collection };
  await deletePosClientFromFirestore(clientId);
  return { synced: true, deleted: true, collection: status.collection };
}

function mapSupplierRow(row) {
  return {
    id: row.id,
    nombre: row.nombre,
    empresa: row.empresa,
    telefono: row.telefono,
    email: row.email,
    rnc: row.rnc,
    contacto: row.contacto,
    direccion: row.direccion,
    diasVisita: row.visit_days || '',
    terminosPagoDias: Number(row.payment_terms_days || 30),
    estado: row.estado
  };
}

function mapSupplierInvoiceRow(row) {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    proveedor: row.supplier_name,
    numeroFactura: row.invoice_number,
    fechaEmision: row.issued_at,
    fechaVencimiento: row.due_at,
    montoTotal: Number(row.total_amount || 0),
    montoPagado: Number(row.paid_amount || 0),
    montoPendiente: Number(row.pending_amount || 0),
    estado: row.status,
    notas: row.notes || ''
  };
}

function getBusinessTemplate(type = 'pizzeria') {
  return BUSINESS_TEMPLATES[type] || BUSINESS_TEMPLATES.pizzeria;
}

function listBusinessTypes() {
  return Object.values(BUSINESS_TEMPLATES).map((template) => ({
    value: template.key,
    label: template.label,
    accent: template.accent,
    accentLight: template.accentLight,
    subtitle: template.salesSubtitle
  }));
}

function buildBusinessProfile(type = 'pizzeria') {
  const template = getBusinessTemplate(type);
  return {
    key: template.key,
    label: template.label,
    accent: template.accent,
    accentLight: template.accentLight,
    loginSubtitle: template.loginSubtitle,
    salesTitle: template.salesTitle,
    salesSubtitle: template.salesSubtitle,
    searchPlaceholder: template.searchPlaceholder,
    quickMenuTitle: template.quickMenuTitle,
    quickMenuItems: template.quickMenuItems,
    quickMenuNote: template.quickMenuNote
  };
}

function mapBusinessTemplatePreviewProduct(product = {}, index = 0, businessType = 'pizzeria') {
  const businessIndex = Math.max(1, Object.keys(BUSINESS_TEMPLATES).indexOf(businessType) + 1);
  const previewId = -((businessIndex * 1000) + index + 1);

  return {
    id: previewId,
    codigo: String(product.codigo || `DEMO-${businessIndex}-${index + 1}`).trim(),
    nombre: String(product.nombre || `Producto demo ${index + 1}`).trim(),
    categoria: String(product.categoria || 'General').trim(),
    marca: String(product.marca || '').trim(),
    precioCompra: Number(product.precioCompra || 0),
    precioVenta: Number(product.precioVenta || 0),
    stock: Number(product.stock ?? 999),
    stockMin: Number(product.stockMin ?? 0),
    unidad: String(product.unidad || 'Unidad').trim(),
    estado: 'Activo',
    imagenUrl: '',
    imagenLocal: '',
    imagen: getDefaultProductImage(product.nombre || `Producto ${index + 1}`),
    tipoProducto: String(product.tipoProducto || 'general').trim(),
    tamanos: Array.isArray(product.tamanos) ? product.tamanos : [],
    masas: Array.isArray(product.masas) ? product.masas : [],
    bordes: Array.isArray(product.bordes) ? product.bordes : [],
    extras: Array.isArray(product.extras) ? product.extras : [],
    permiteMitades: Boolean(product.permiteMitades),
    esCombo: Boolean(product.esCombo),
    tiempoPreparacion: Number(product.tiempoPreparacion || 0),
    metaNegocio: product.metaNegocio && typeof product.metaNegocio === 'object' ? product.metaNegocio : {}
  };
}

function buildBusinessTemplatePreview(type = 'pizzeria') {
  const template = getBusinessTemplate(type);
  const categories = Array.isArray(template.categories) ? template.categories.filter(Boolean) : [];
  const products = Array.isArray(template.products) ? template.products : [];

  return {
    businessType: template.key,
    label: template.label,
    profile: buildBusinessProfile(template.key),
    categories: [...new Set(categories)],
    products: products.map((product, index) => mapBusinessTemplatePreviewProduct(product, index, template.key))
  };
}

function normalizeLicenseStatus(value) {
  const normalized = String(value || 'trial').trim().toLowerCase();
  if (['active', 'activo', 'activo_pro', 'active_pro', 'activepro', 'activo pro'].includes(normalized)) return 'active';
  if (['expired', 'expirado', 'vencido'].includes(normalized)) return 'expired';
  if (['suspended', 'suspendido', 'bloqueado', 'blocked'].includes(normalized)) return 'suspended';
  return 'trial';
}

function parseStoredDateTime(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value).trim();
  if (!text) return null;
  const normalized = text.includes(' ')
    ? text.replace(' ', 'T')
    : text;
  const utcCandidate = /Z$/i.test(normalized) ? normalized : `${normalized}Z`;
  const parsed = new Date(utcCandidate);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  const fallback = new Date(text);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function formatSqlDateTimeLocal(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  const seconds = String(value.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function getLicenseSummary(row) {
  const status = normalizeLicenseStatus(row.license_status);
  const now = new Date();
  const endsAt = parseStoredDateTime(row.trial_ends_at);
  const startedAt = parseStoredDateTime(row.trial_started_at);
  const checkedAt = parseStoredDateTime(row.license_last_remote_check_at);
  const msLeft = endsAt ? endsAt.getTime() - now.getTime() : 0;
  const daysLeft = endsAt ? Math.max(0, Math.ceil(msLeft / 86400000)) : 0;
  const clockRollbackDetected = Boolean(
    status === 'trial'
      && checkedAt
      && !Number.isNaN(checkedAt.getTime())
      && now.getTime() < checkedAt.getTime() - (5 * 60 * 1000)
  );
  const expired = status === 'trial' && (clockRollbackDetected || !endsAt || msLeft <= 0);
  const effectiveStatus = status === 'active'
    ? 'active'
    : status === 'suspended'
      ? 'suspended'
      : expired
        ? 'expired'
        : status;

  return {
    status: effectiveStatus,
    trialStartedAt: startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt.toISOString() : null,
    trialEndsAt: endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt.toISOString() : null,
    checkedAt: checkedAt && !Number.isNaN(checkedAt.getTime()) ? checkedAt.toISOString() : null,
    daysLeft,
    expired,
    suspended: effectiveStatus === 'suspended',
    canEnter: effectiveStatus === 'active' || effectiveStatus === 'trial',
    clockRollbackDetected
  };
}

function getLicenseDeniedMessage(license = {}) {
  if (license?.message) {
    return String(license.message);
  }
  if (license?.blockedCode === 'tamper') {
    return 'Se detectó manipulación local de la licencia o del almacenamiento seguro. Debes revalidar el sistema con soporte.';
  }
  if (license?.blockedCode === 'clock_rollback') {
    return 'Se detectó un cambio no válido en la fecha del sistema. Corrige el reloj del equipo y vuelve a validar la licencia.';
  }
  if (license?.blockedCode === 'offline_grace') {
    return 'Se agotó el tiempo offline permitido. Conéctate a internet para validar nuevamente la licencia.';
  }
  if (license?.blockedCode === 'device_limit') {
    return 'La licencia excedió el límite de dispositivos autorizados. Debes aprobar este equipo desde tu panel administrador.';
  }
  if (license?.status === 'suspended') {
    return 'La licencia del sistema está suspendida desde tu app de administrador. Comunícate con soporte o reactívala para seguir usando la aplicación.';
  }
  return 'La prueba del sistema expiró. Activa la licencia para seguir usando la aplicación.';
}

function normalizeJsonValue(value) {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeJsonValue(entry)]));
  }
  return value;
}

async function hasColumn(tableName, columnName) {
  const client = getDbClient();
  const rows = client === 'mysql'
    ? await query(`SHOW COLUMNS FROM \`${tableName}\``)
    : await query(`PRAGMA table_info(${tableName})`);
  return rows.some((row) => String(row.name || row.Field || '').toLowerCase() === String(columnName).toLowerCase());
}

/**
 * Memoiza una función async para que solo se ejecute una vez.
 * Si falla, limpia el caché para permitir reintentos.
 * Usado para migraciones de schema que son idempotentes pero costosas
 * (evita disparar ensureX() en cada request del hot-path de ventas).
 */
function memoizeOnceAsync(fn) {
  let promise = null;
  return function memoizedOnce(...args) {
    if (promise) return promise;
    promise = Promise.resolve()
      .then(() => fn.apply(this, args))
      .catch((err) => {
        promise = null;
        throw err;
      });
    return promise;
  };
}

async function addColumnIfMissing(tableName, columnName, definition) {
  try {
    if (await hasColumn(tableName, columnName)) return;
    await query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  } catch (error) {
    const message = String(error?.message || '').toLowerCase();
    const isMissingTable = message.includes('no such table') || message.includes("doesn't exist");
    if (!isMissingTable) {
      throw error;
    }
  }
}

async function ensureConfigExtensions() {
  await addColumnIfMissing('config', 'tax_calculate_at_invoice_end', 'TINYINT(1) NOT NULL DEFAULT 1');
  await addColumnIfMissing('config', 'tax_include_in_product_price', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing('config', 'tax_show_breakdown_on_receipts', 'TINYINT(1) NOT NULL DEFAULT 1');
  await addColumnIfMissing('config', 'tax_separate_taxable_and_exempt', 'TINYINT(1) NOT NULL DEFAULT 1');
  await addColumnIfMissing('config', 'invoice_next_number', 'INT NOT NULL DEFAULT 1001');
  await addColumnIfMissing('config', 'e_invoice_enabled', 'TINYINT(1) NOT NULL DEFAULT 1');
  await addColumnIfMissing('config', 'e_invoice_prefix', `VARCHAR(20) NOT NULL DEFAULT 'ECF-'`);
  await addColumnIfMissing('config', 'e_invoice_next_number', 'INT NOT NULL DEFAULT 1');
  await addColumnIfMissing('config', 'receipt_print_mode', `VARCHAR(20) NOT NULL DEFAULT 'dialog'`);
  await addColumnIfMissing('config', 'receipt_printer_name', 'VARCHAR(160) DEFAULT NULL');
  await addColumnIfMissing('config', 'receipt_paper_size', `VARCHAR(20) NOT NULL DEFAULT '80mm'`);
  await addColumnIfMissing('config', 'cash_drawer_enabled', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing('config', 'cash_drawer_method', `VARCHAR(20) NOT NULL DEFAULT 'escpos'`);
  await addColumnIfMissing('config', 'cash_drawer_printer_name', 'VARCHAR(160) DEFAULT NULL');
  await addColumnIfMissing('config', 'cash_drawer_pin', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing('config', 'cash_drawer_network_host', 'VARCHAR(160) DEFAULT NULL');
  await addColumnIfMissing('config', 'cash_drawer_network_port', 'INT NOT NULL DEFAULT 9100');
  await addColumnIfMissing('config', 'cash_drawer_serial_port', `VARCHAR(40) NOT NULL DEFAULT 'COM1'`);
  await addColumnIfMissing('config', 'scale_type', `VARCHAR(20) NOT NULL DEFAULT 'none'`);
  await addColumnIfMissing('config', 'scale_serial_port', 'VARCHAR(40) DEFAULT NULL');
  await addColumnIfMissing('config', 'scale_serial_baud_rate', 'INT NOT NULL DEFAULT 9600');
  await addColumnIfMissing('config', 'scale_default_unit', `VARCHAR(10) NOT NULL DEFAULT 'kg'`);
  await addColumnIfMissing('config', 'scale_read_pattern', 'VARCHAR(255) DEFAULT NULL');
  await addColumnIfMissing('config', 'scale_rounding_decimals', 'INT NOT NULL DEFAULT 2');
  await addColumnIfMissing('config', 'scale_auto_read', 'TINYINT(1) NOT NULL DEFAULT 1');
  await addColumnIfMissing('config', 'whatsapp_web_enabled', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing('config', 'whatsapp_paste_guide_enabled', 'TINYINT(1) NOT NULL DEFAULT 1');
  await addColumnIfMissing('config', 'sales_split_view_enabled', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing('config', 'app_logo', 'LONGTEXT DEFAULT NULL');
  await addColumnIfMissing('config', 'security_password', `VARCHAR(120) NOT NULL DEFAULT '${DEFAULT_SECURITY_PASSWORD}'`);
  await addColumnIfMissing('config', 'language', `VARCHAR(10) NOT NULL DEFAULT 'es'`);
  await addColumnIfMissing('config', 'business_type', `VARCHAR(30) NOT NULL DEFAULT 'pizzeria'`);
  await addColumnIfMissing('config', 'starter_catalog_seeded', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing('config', 'setup_completed', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing('config', 'setup_completed_at', 'DATETIME DEFAULT NULL');
  await addColumnIfMissing('config', 'trial_started_at', 'DATETIME DEFAULT NULL');
  await addColumnIfMissing('config', 'trial_ends_at', 'DATETIME DEFAULT NULL');
  await addColumnIfMissing('config', 'license_status', `VARCHAR(20) NOT NULL DEFAULT 'trial'`);
  await addColumnIfMissing('config', 'license_activated_at', 'DATETIME DEFAULT NULL');
  await addColumnIfMissing('config', 'license_activated_by', 'VARCHAR(160) DEFAULT NULL');
  await addColumnIfMissing('config', 'license_last_remote_check_at', 'DATETIME DEFAULT NULL');
  await addColumnIfMissing('config', 'plan_code', `VARCHAR(40) NOT NULL DEFAULT 'basico'`);
  await addColumnIfMissing('config', 'plan_name', `VARCHAR(120) NOT NULL DEFAULT 'Tecno Caja Básico'`);
  await addColumnIfMissing('config', 'plan_expires_at', 'DATETIME DEFAULT NULL');
  await addColumnIfMissing('config', 'require_cash_open_before_use', 'TINYINT(1) NOT NULL DEFAULT 1');
  await addColumnIfMissing('config', 'mobile_connection_code', 'VARCHAR(32) DEFAULT NULL');
  await addColumnIfMissing('config', 'active_branch_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('config', 'active_cash_register_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('config', 'business_structure_mode', `VARCHAR(30) NOT NULL DEFAULT 'monocaja'`);
  await addColumnIfMissing('config', 'cashier_register_required', 'TINYINT(1) NOT NULL DEFAULT 1');
  await addColumnIfMissing('config', 'exclusive_cashier_per_register', 'TINYINT(1) NOT NULL DEFAULT 1');
  await addColumnIfMissing('config', 'install_network_key', 'VARCHAR(255) DEFAULT NULL');
  await query(
    `INSERT OR IGNORE INTO config
      (id, business_name, rnc, address, phone, currency, tax_rate, invoice_prefix, invoice_next_number, e_invoice_enabled, e_invoice_prefix, e_invoice_next_number, receipt_message, receipt_print_mode, receipt_printer_name, receipt_paper_size, cash_drawer_enabled, cash_drawer_method, cash_drawer_printer_name, cash_drawer_pin, cash_drawer_network_host, cash_drawer_network_port, cash_drawer_serial_port, app_logo, security_password, cash_open, cash_amount, language, business_type, business_structure_mode, cashier_register_required, exclusive_cashier_per_register, starter_catalog_seeded, setup_completed, setup_completed_at, trial_started_at, trial_ends_at, license_status, license_activated_at, license_activated_by, require_cash_open_before_use)
     VALUES
      (1, 'Tecno Caja', '', '', '', 'RD$', 18.00, 'FAC-', 1001, 1, 'ECF-', 1, '¡Gracias por su compra!', 'dialog', NULL, '80mm', 0, 'escpos', NULL, 0, NULL, 9100, 'COM1', NULL, ?, 0, 0.00, 'es', 'pizzeria', 'monocaja', 1, 1, 0, 0, NULL, NULL, NULL, 'trial', NULL, NULL, 1)`,
    [DEFAULT_SECURITY_PASSWORD]
  );
  await query('UPDATE config SET invoice_next_number = MAX(COALESCE(invoice_next_number, 1001), 1) WHERE id = 1');
  await query('UPDATE config SET e_invoice_next_number = MAX(COALESCE(e_invoice_next_number, 1), 1) WHERE id = 1');
  await query('UPDATE config SET tax_calculate_at_invoice_end = 1 WHERE id = 1 AND tax_calculate_at_invoice_end IS NULL');
  await query('UPDATE config SET tax_include_in_product_price = 0 WHERE id = 1 AND tax_include_in_product_price IS NULL');
  await query('UPDATE config SET tax_show_breakdown_on_receipts = 1 WHERE id = 1 AND tax_show_breakdown_on_receipts IS NULL');
  await query('UPDATE config SET tax_separate_taxable_and_exempt = 1 WHERE id = 1 AND tax_separate_taxable_and_exempt IS NULL');
  await query(`UPDATE config SET receipt_print_mode = 'dialog' WHERE id = 1 AND (receipt_print_mode IS NULL OR receipt_print_mode = '')`);
  await query(`UPDATE config SET receipt_paper_size = '80mm' WHERE id = 1 AND (receipt_paper_size IS NULL OR receipt_paper_size = '')`);
  await query('UPDATE config SET cash_drawer_enabled = 0 WHERE id = 1 AND cash_drawer_enabled IS NULL');
  await query(`UPDATE config SET cash_drawer_method = 'escpos' WHERE id = 1 AND (cash_drawer_method IS NULL OR cash_drawer_method = '')`);
  await query('UPDATE config SET cash_drawer_pin = 0 WHERE id = 1 AND cash_drawer_pin IS NULL');
  await query('UPDATE config SET cash_drawer_network_port = 9100 WHERE id = 1 AND cash_drawer_network_port IS NULL');
  await query(`UPDATE config SET cash_drawer_serial_port = 'COM1' WHERE id = 1 AND (cash_drawer_serial_port IS NULL OR cash_drawer_serial_port = '')`);
  await query(`UPDATE config SET scale_type = 'none' WHERE id = 1 AND (scale_type IS NULL OR scale_type = '')`);
  await query(`UPDATE config SET scale_default_unit = 'kg' WHERE id = 1 AND (scale_default_unit IS NULL OR scale_default_unit = '')`);
  await query('UPDATE config SET scale_serial_baud_rate = 9600 WHERE id = 1 AND scale_serial_baud_rate IS NULL');
  await query('UPDATE config SET scale_rounding_decimals = 2 WHERE id = 1 AND scale_rounding_decimals IS NULL');
  await query('UPDATE config SET scale_auto_read = 1 WHERE id = 1 AND scale_auto_read IS NULL');
  await query('UPDATE config SET sales_split_view_enabled = 0 WHERE id = 1 AND sales_split_view_enabled IS NULL');
  await query('UPDATE config SET security_password = ? WHERE id = 1 AND (security_password IS NULL OR security_password = "")', [DEFAULT_SECURITY_PASSWORD]);
  if (DEFAULT_SECURITY_PASSWORD !== LEGACY_DEFAULT_SECURITY_PASSWORD) {
    await query('UPDATE config SET security_password = ? WHERE id = 1 AND security_password = ?', [DEFAULT_SECURITY_PASSWORD, LEGACY_DEFAULT_SECURITY_PASSWORD]);
  }
  await query(`UPDATE config SET language = 'es' WHERE id = 1 AND (language IS NULL OR language = '')`);
  await query(`UPDATE config SET business_type = 'pizzeria' WHERE id = 1 AND (business_type IS NULL OR business_type = '')`);
  await query(`UPDATE config SET business_structure_mode = 'monocaja' WHERE id = 1 AND (business_structure_mode IS NULL OR business_structure_mode = '')`);
  await query('UPDATE config SET cashier_register_required = 1 WHERE id = 1 AND cashier_register_required IS NULL');
  await query('UPDATE config SET exclusive_cashier_per_register = 1 WHERE id = 1 AND exclusive_cashier_per_register IS NULL');
  await query('UPDATE config SET starter_catalog_seeded = 0 WHERE id = 1 AND starter_catalog_seeded IS NULL');
  await query(`UPDATE config SET license_status = 'trial' WHERE id = 1 AND (license_status IS NULL OR license_status = '')`);
  await query(`UPDATE config SET require_cash_open_before_use = 1 WHERE id = 1 AND require_cash_open_before_use IS NULL`);
  const codeRows = await query('SELECT mobile_connection_code FROM config WHERE id = 1 LIMIT 1');
  const currentCode = String(codeRows[0]?.mobile_connection_code || '').trim();
  if (!normalizeMobileConnectionCode(currentCode)) {
    await query('UPDATE config SET mobile_connection_code = ? WHERE id = 1', [generateMobileConnectionCode()]);
  }

  const [userCountRows, productCountRows, configRows] = await Promise.all([
    query('SELECT COUNT(*) AS total FROM users'),
    query('SELECT COUNT(*) AS total FROM products'),
    query('SELECT setup_completed, trial_started_at, trial_ends_at, license_status, business_type, starter_catalog_seeded FROM config WHERE id = 1 LIMIT 1')
  ]);
  const hasLegacyData = Number(userCountRows[0]?.total || 0) > 0 || Number(productCountRows[0]?.total || 0) > 0;
  const currentConfig = configRows[0] || {};

  if (hasLegacyData && !Number(currentConfig.setup_completed || 0)) {
    await query(
      `UPDATE config
       SET setup_completed = 1,
           setup_completed_at = COALESCE(setup_completed_at, datetime('now')),
           business_type = CASE WHEN business_type IS NULL OR business_type = '' THEN 'pizzeria' ELSE business_type END,
           starter_catalog_seeded = 1,
           trial_started_at = COALESCE(trial_started_at, datetime('now')),
           trial_ends_at = COALESCE(trial_ends_at, datetime('now', ' +30 days')),
           license_status = CASE WHEN license_status IS NULL OR license_status = '' OR license_status = 'trial' THEN 'active' ELSE license_status END
       WHERE id = 1`
    );
  }

  if (Number(productCountRows[0]?.total || 0) > 0 && !Number(currentConfig.starter_catalog_seeded || 0)) {
    await query('UPDATE config SET starter_catalog_seeded = 1 WHERE id = 1');
  }
}

async function ensureBranchesTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre VARCHAR(160) NOT NULL,
      codigo VARCHAR(40) DEFAULT NULL,
      direccion VARCHAR(255) DEFAULT NULL,
      telefono VARCHAR(40) DEFAULT NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'Activa',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function ensureCashRegistersTable() {
  await ensureBranchesTable();
  await query(`
    CREATE TABLE IF NOT EXISTS cash_registers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INT NOT NULL,
      nombre VARCHAR(160) NOT NULL,
      codigo VARCHAR(40) DEFAULT NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'Activa',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_cash_registers_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
    )
  `);
}

async function ensureCashRegisterTypeExtension() {
  await addColumnIfMissing('cash_registers', 'tipo_caja', `VARCHAR(30) NOT NULL DEFAULT 'mixta'`);
  await addColumnIfMissing('cash_registers', 'puede_cobrar_otras_cajas', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing('cash_registers', 'descripcion', 'VARCHAR(200) DEFAULT NULL');
  // Una caja centralizadora puede cobrar ventas de otras cajas
  await query(`UPDATE cash_registers SET tipo_caja = 'mixta' WHERE tipo_caja IS NULL OR tipo_caja = ''`);
}

// ─── Terminal config — identificador local por máquina ────────────────────
const TERMINAL_CONFIG_PATH = path.join(__dirname, 'config', 'terminal-config.json');

function getTerminalConfig() {
  try {
    if (fs.existsSync(TERMINAL_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(TERMINAL_CONFIG_PATH, 'utf8'));
    }
  } catch (_e) {}
  return null;
}

function saveTerminalConfig(data) {
  try {
    const dir = path.dirname(TERMINAL_CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      TERMINAL_CONFIG_PATH,
      JSON.stringify({ ...data, savedAt: new Date().toISOString() }, null, 2)
    );
    return true;
  } catch (_e) {
    return false;
  }
}

function getFirstPrivateIpv4() {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const iface of list) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(iface.address)) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function getDiscoveryHosts() {
  const ifaces = os.networkInterfaces();
  const hosts = new Set();

  for (const list of Object.values(ifaces)) {
    for (const iface of list) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const address = String(iface.address || '').trim();
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(address)) continue;
      const parts = address.split('.');
      if (parts.length !== 4) continue;
      const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
      for (let last = 2; last <= 254; last += 1) {
        if (last === 1) continue;
        hosts.add(`${prefix}.${last}`);
      }
    }
  }

  return Array.from(hosts).slice(0, 254);
}

function probeIdentify(host, port, timeoutMs = 900) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: host, port, path: '/api/network/identify', timeout: timeoutMs, headers: { Accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          const data = JSON.parse(body || '{}');
          if (data && data.app === 'Tecno Caja' && data.isMain) {
            return resolve({
              host,
              port,
              baseUrl: `http://${host}:${port}`,
              localIp: data.localIp || host,
              app: data.app,
              role: data.role || 'principal',
              isMain: Boolean(data.isMain),
              businessName: data.businessName || '',
              branchName: data.branchName || '',
              version: data.version || ''
            });
          }
        } catch (_e) {
          // ignore parse errors
        }
        return resolve(null);
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function getDiscoveryCandidates(port = Number(process.env.PORT || 3000)) {
  const hosts = getDiscoveryHosts();
  const results = [];
  const concurrency = 18;
  const queue = [...hosts];

  return new Promise(async (resolve) => {
    const workers = new Array(concurrency).fill(null).map(async () => {
      while (queue.length) {
        const host = queue.shift();
        const candidate = await probeIdentify(host, port);
        if (candidate) results.push(candidate);
      }
    });
    await Promise.all(workers);
    resolve(results);
  });
}

function isMainTerminalConfig(terminalConfig = null) {
  if (!terminalConfig) return true;
  return terminalConfig.isMain !== false;
}

function getTerminalScopeSelection() {
  const terminalConfig = getTerminalConfig();
  return {
    terminalConfig,
    branchId: Number(terminalConfig?.branchId || 0) || null,
    cashRegisterId: Number(terminalConfig?.cashRegisterId || 0) || null
  };
}

// ─── Wizard DB extensions ─────────────────────────────────────────────────
async function ensureWizardExtensions() {
  await addColumnIfMissing('users', 'puede_autorizar_instalacion', 'TINYINT(1) NOT NULL DEFAULT 0');
  await query(`CREATE TABLE IF NOT EXISTS installation_config (id INTEGER PRIMARY KEY AUTOINCREMENT, config_key VARCHAR(100) NOT NULL, config_value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await query(`CREATE TABLE IF NOT EXISTS user_branch_access (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, branch_id INTEGER NOT NULL, access_type VARCHAR(30) DEFAULT 'operador', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await query(`CREATE TABLE IF NOT EXISTS user_cash_register_access (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, cash_register_id INTEGER NOT NULL, access_type VARCHAR(30) DEFAULT 'operador', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
}

async function ensureBusinessStructureExtensions() {
  await ensureConfigExtensions();
  await ensureBranchesTable();
  await ensureCashRegistersTable();
  await ensureCashRegisterTypeExtension();
  await addColumnIfMissing('cash_sessions', 'current_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00');
  await addColumnIfMissing('cash_sessions', 'branch_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('cash_sessions', 'cash_register_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('cash_sessions', 'opened_by_user_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('cash_sessions', 'opened_by_user_name', 'VARCHAR(120) DEFAULT NULL');
  await addColumnIfMissing('cash_movements', 'branch_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('cash_movements', 'cash_register_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('sales', 'branch_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('sales', 'cash_register_id', 'INT DEFAULT NULL');

  const configRows = await query('SELECT business_name, address, phone, active_branch_id, active_cash_register_id FROM config WHERE id = 1 LIMIT 1');
  const config = configRows[0] || {};
  const branchRows = await query('SELECT * FROM branches ORDER BY id');
  let activeBranchId = Number(config.active_branch_id || 0) || null;

  if (!branchRows.length) {
    const branchName = String(config.business_name || 'Sucursal Principal').trim() || 'Sucursal Principal';
    const branchCode = 'SUC-001';
    const result = await query(
      `INSERT INTO branches (nombre, codigo, direccion, telefono, estado, created_at)
       VALUES (?, ?, ?, ?, 'Activa', datetime('now'))`,
      [branchName, branchCode, config.address || '', config.phone || '']
    );
    activeBranchId = Number(result.insertId || 0) || 1;
  } else if (!activeBranchId || !branchRows.some((row) => Number(row.id) === activeBranchId)) {
    activeBranchId = Number(branchRows[0].id);
  }

  const registerRows = await query('SELECT * FROM cash_registers ORDER BY id');
  let activeCashRegisterId = Number(config.active_cash_register_id || 0) || null;
  const activeBranchRegisters = registerRows.filter((row) => Number(row.branch_id || 0) === Number(activeBranchId || 0));

  if (!registerRows.length || !activeBranchRegisters.length) {
    const result = await query(
      `INSERT INTO cash_registers (branch_id, nombre, codigo, estado, created_at)
       VALUES (?, ?, ?, 'Activa', datetime('now'))`,
      [activeBranchId, 'Caja Principal', 'CAJ-001']
    );
    activeCashRegisterId = Number(result.insertId || 0) || 1;
  } else if (!activeCashRegisterId || !registerRows.some((row) => Number(row.id) === activeCashRegisterId && Number(row.branch_id || 0) === Number(activeBranchId || 0))) {
    activeCashRegisterId = Number(activeBranchRegisters[0].id);
  }

  await query(
    'UPDATE config SET active_branch_id = ?, active_cash_register_id = ? WHERE id = 1',
    [activeBranchId, activeCashRegisterId]
  );

  await query('UPDATE cash_sessions SET current_amount = COALESCE(closed_amount, opened_amount) WHERE current_amount IS NULL');
  await query('UPDATE cash_sessions SET branch_id = ? WHERE branch_id IS NULL', [activeBranchId]);
  await query('UPDATE cash_sessions SET cash_register_id = ? WHERE cash_register_id IS NULL', [activeCashRegisterId]);
  await query('UPDATE cash_movements SET branch_id = ? WHERE branch_id IS NULL', [activeBranchId]);
  await query('UPDATE cash_movements SET cash_register_id = ? WHERE cash_register_id IS NULL', [activeCashRegisterId]);
  await query('UPDATE sales SET branch_id = ? WHERE branch_id IS NULL', [activeBranchId]);
  await query('UPDATE sales SET cash_register_id = ? WHERE cash_register_id IS NULL', [activeCashRegisterId]);
}

const DEFAULT_ROLE_DEFINITIONS = [
  {
    codigo: 'administrador_general',
    nombre: 'Administrador General',
    permisos: ['*']
  },
  {
    codigo: 'administrador_sucursal',
    nombre: 'Administrador de Sucursal',
    permisos: BRANCH_ADMIN_ALLOWED_PERMISSIONS
  },
  {
    codigo: 'cajero',
    nombre: 'Cajero',
    permisos: ['ventas', 'caja', 'clientes', 'abrir_caja', 'cerrar_caja', 'hacer_corte_caja', 'abrir_gaveta']
  },
  {
    codigo: 'supervisor',
    nombre: 'Supervisor',
    permisos: ['ventas', 'caja', 'reportes_sucursal', 'inventario', 'abrir_caja', 'cerrar_caja', 'hacer_corte_caja', 'abrir_gaveta', 'anular_ventas', 'devolver_ventas', 'ver_reportes_caja', 'ver_cierres_caja', 'ver_ganancias']
  },
  {
    codigo: 'repartidor',
    nombre: 'Repartidor (Delivery)',
    permisos: []
  }
];

const DEFAULT_PAYMENT_METHODS = [
  { codigo: 'efectivo', nombre: 'Efectivo' },
  { codigo: 'tarjeta', nombre: 'Tarjeta' },
  { codigo: 'transferencia', nombre: 'Transferencia' },
  { codigo: 'credito', nombre: 'Crédito' },
  { codigo: 'contra_entrega', nombre: 'Contra entrega' }
];

async function ensureBusinessesTable() {
  await ensureConfigExtensions();
  await query(`
    CREATE TABLE IF NOT EXISTS businesses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre VARCHAR(160) NOT NULL,
      rnc VARCHAR(40) DEFAULT NULL,
      direccion VARCHAR(255) DEFAULT NULL,
      telefono VARCHAR(40) DEFAULT NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'Activo',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await addColumnIfMissing('config', 'business_id', 'INT DEFAULT NULL');

  const configRows = await query('SELECT business_id, business_name, rnc, address, phone FROM config WHERE id = 1 LIMIT 1');
  const config = configRows[0] || {};
  let businessId = Number(config.business_id || 0) || 0;
  if (!businessId) {
    const existingRows = await query('SELECT id FROM businesses ORDER BY id LIMIT 1');
    if (existingRows[0]?.id) {
      businessId = Number(existingRows[0].id);
    } else {
      const result = await query(
        `INSERT INTO businesses (nombre, rnc, direccion, telefono, estado, created_at)
         VALUES (?, ?, ?, ?, 'Activo', datetime('now'))`,
        [
          String(config.business_name || 'Tecno Caja').trim() || 'Tecno Caja',
          config.rnc || null,
          config.address || null,
          config.phone || null
        ]
      );
      businessId = Number(result.insertId || 0);
    }
    if (businessId) {
      await query('UPDATE config SET business_id = ? WHERE id = 1', [businessId]);
    }
  }
}

async function ensureRolesTable() {
  await ensureUserExtensions();
  await query(`
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo VARCHAR(60) NOT NULL UNIQUE,
      nombre VARCHAR(120) NOT NULL,
      permisos LONGTEXT DEFAULT NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'Activo',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await addColumnIfMissing('users', 'role_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('users', 'branch_id', 'INT DEFAULT NULL');

  for (const role of DEFAULT_ROLE_DEFINITIONS) {
    await query(
      `INSERT OR IGNORE INTO roles (codigo, nombre, permisos, estado, created_at)
       VALUES (?, ?, ?, 'Activo', datetime('now'))`,
      [role.codigo, role.nombre, JSON.stringify(role.permisos || [])]
    );
    await query(
      'UPDATE roles SET nombre = ?, permisos = ?, estado = "Activo" WHERE codigo = ?',
      [role.nombre, JSON.stringify(role.permisos || []), role.codigo]
    );
  }

  const roleRows = await query('SELECT id, codigo FROM roles');
  const roleMap = new Map(roleRows.map((row) => [String(row.codigo || '').trim(), Number(row.id)]));
  const legacyUsers = await query('SELECT id, rol, role_id FROM users ORDER BY id');
  for (const user of legacyUsers) {
    if (Number(user.role_id || 0)) continue;
    const legacyRole = String(user.rol || '').trim().toLowerCase();
    // Normalizar rol heredado al código de rol correcto
    const normalizedRoleCode =
      (legacyRole === 'administrador' || legacyRole === 'administrador_general' ||
       legacyRole === 'administrador general' || legacyRole === 'admin' || legacyRole === 'admin general')
        ? 'administrador_general'
      : (legacyRole === 'administrador_sucursal' || legacyRole === 'administrador sucursal')
        ? 'administrador_sucursal'
      : legacyRole === 'cajero'
        ? 'cajero'
      : legacyRole === 'supervisor'
        ? 'supervisor'
      : legacyRole === 'delivery'
        ? 'cajero'
      : 'cajero'; // fallback conservador: nunca escalar a admin desconocido
    const roleId = roleMap.get(normalizedRoleCode) || null;
    if (roleId) {
      await query('UPDATE users SET role_id = ? WHERE id = ?', [roleId, user.id]);
    }
  }
}

async function ensureReturnTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS sale_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_sale_id INT NOT NULL,
      original_invoice_number VARCHAR(40) NOT NULL,
      return_type VARCHAR(20) NOT NULL DEFAULT 'parcial',
      return_reason VARCHAR(255) DEFAULT NULL,
      returned_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      returned_by_user_id INT DEFAULT NULL,
      returned_by_user_name VARCHAR(120) DEFAULT NULL,
      branch_id INT DEFAULT NULL,
      cash_register_id INT DEFAULT NULL,
      cash_movement_id INT DEFAULT NULL,
      returned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS sale_return_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_id INT NOT NULL,
      product_id INT NOT NULL,
      product_name VARCHAR(255) NOT NULL DEFAULT '',
      qty_returned DECIMAL(10,2) NOT NULL,
      price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      line_total DECIMAL(12,2) NOT NULL DEFAULT 0.00
    )
  `);
}

async function ensurePaymentMethodsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS payment_methods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo VARCHAR(40) NOT NULL UNIQUE,
      nombre VARCHAR(120) NOT NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'Activo',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  for (const method of DEFAULT_PAYMENT_METHODS) {
    await query(
      `INSERT OR IGNORE INTO payment_methods (codigo, nombre, estado, created_at)
       VALUES (?, ?, 'Activo', datetime('now'))`,
      [method.codigo, method.nombre]
    );
  }
}

async function ensureBranchInventoryTable() {
  await ensureBusinessStructureExtensions();
  await ensureProductExtensions();
  await query(`
    CREATE TABLE IF NOT EXISTS inventory_by_branch (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INT NOT NULL,
      product_id INT NOT NULL,
      stock DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      stock_min DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_inventory_by_branch_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE,
      CONSTRAINT fk_inventory_by_branch_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      CONSTRAINT uq_inventory_by_branch UNIQUE (branch_id, product_id)
    )
  `);
}

async function ensureTransferTables() {
  await ensureBusinessStructureExtensions();
  await query(`
    CREATE TABLE IF NOT EXISTS branch_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_branch_id INT NOT NULL,
      to_branch_id INT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'completada',
      notes VARCHAR(255) DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_branch_transfers_from_branch FOREIGN KEY (from_branch_id) REFERENCES branches(id) ON DELETE CASCADE,
      CONSTRAINT fk_branch_transfers_to_branch FOREIGN KEY (to_branch_id) REFERENCES branches(id) ON DELETE CASCADE
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS branch_transfer_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transfer_id INT NOT NULL,
      product_id INT NOT NULL,
      qty DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      unit_cost DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      notes VARCHAR(255) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_branch_transfer_items_transfer FOREIGN KEY (transfer_id) REFERENCES branch_transfers(id) ON DELETE CASCADE,
      CONSTRAINT fk_branch_transfer_items_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )
  `);
}

async function ensureCashAuditTables() {
  await ensureBusinessStructureExtensions();
  await query(`
    CREATE TABLE IF NOT EXISTS cash_openings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cash_session_id INT NOT NULL,
      branch_id INT NOT NULL,
      cash_register_id INT NOT NULL,
      opened_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      notes VARCHAR(255) DEFAULT NULL,
      opened_by_user_id INT DEFAULT NULL,
      opened_by_user_name VARCHAR(120) DEFAULT NULL,
      opened_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_cash_openings_session FOREIGN KEY (cash_session_id) REFERENCES cash_sessions(id) ON DELETE CASCADE
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS cash_closings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cash_session_id INT NOT NULL,
      branch_id INT NOT NULL,
      cash_register_id INT NOT NULL,
      expected_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      counted_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      difference_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      notes VARCHAR(255) DEFAULT NULL,
      closed_by_user_id INT DEFAULT NULL,
      closed_by_user_name VARCHAR(120) DEFAULT NULL,
      closed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_cash_closings_session FOREIGN KEY (cash_session_id) REFERENCES cash_sessions(id) ON DELETE CASCADE
    )
  `);
  await addColumnIfMissing('cash_sessions', 'expected_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00');
  await addColumnIfMissing('cash_sessions', 'counted_amount', 'DECIMAL(12,2) DEFAULT NULL');
  await addColumnIfMissing('cash_sessions', 'difference_amount', 'DECIMAL(12,2) DEFAULT NULL');
}

async function ensureBusinessRulesExtensions() {
  await ensureBusinessesTable();
  await ensureBusinessStructureExtensions();
  await ensureRolesTable();
  await ensurePaymentMethodsTable();
  await ensureBranchInventoryTable();
  await ensureTransferTables();
  await ensureCashAuditTables();
  await ensureSalesExtensions();
  await ensureInventoryMovementsTable();
  await ensureNcfExtensions();

  await addColumnIfMissing('branches', 'business_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('branches', 'encargado', 'VARCHAR(160) DEFAULT NULL');
  await addColumnIfMissing('sales', 'sale_status', `VARCHAR(20) NOT NULL DEFAULT 'pagada'`);
  await addColumnIfMissing('sales', 'sale_mode', `VARCHAR(30) NOT NULL DEFAULT 'directa'`);
  await addColumnIfMissing('sales', 'billed_branch_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('sales', 'billed_cash_register_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('sales', 'billed_by_user_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('sales', 'charged_branch_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('sales', 'charged_cash_register_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('sales', 'charged_by_user_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('sales', 'charged_at', 'DATETIME DEFAULT NULL');
  await addColumnIfMissing('sales', 'inventory_branch_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('sales', 'inventory_discounted_at', 'DATETIME DEFAULT NULL');
  await addColumnIfMissing('config', 'sales_operation_mode', `VARCHAR(30) NOT NULL DEFAULT 'directa'`);
  await addColumnIfMissing('inventory_movements', 'branch_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('inventory_movements', 'source_branch_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('inventory_movements', 'destination_branch_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('inventory_movements', 'cash_register_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('inventory_movements', 'sale_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('inventory_movements', 'transfer_id', 'INT DEFAULT NULL');

  const businessRows = await query('SELECT business_id FROM config WHERE id = 1 LIMIT 1');
  const businessId = Number(businessRows[0]?.business_id || 0) || null;
  if (businessId) {
    await query('UPDATE branches SET business_id = ? WHERE business_id IS NULL', [businessId]);
  }

  await syncBranchInventoryCatalog();
}

async function syncBranchInventoryCatalog() {
  await ensureBranchInventoryTable();
  const branchRows = await query('SELECT id FROM branches WHERE estado <> "Eliminada" ORDER BY id');
  const productRows = await query('SELECT id, stock, stock_min FROM products ORDER BY id');
  const existingRows = await query('SELECT branch_id, product_id FROM inventory_by_branch');
  const existing = new Set(existingRows.map((row) => `${row.branch_id}:${row.product_id}`));
  const primaryBranchId = Number(branchRows[0]?.id || 0) || null;

  for (const product of productRows) {
    const existingCountForProduct = existingRows.filter((row) => Number(row.product_id) === Number(product.id)).length;
    for (const branch of branchRows) {
      const key = `${branch.id}:${product.id}`;
      if (existing.has(key)) continue;
      const seedStock = !existingCountForProduct && primaryBranchId && Number(branch.id) === primaryBranchId
        ? Number(product.stock || 0)
        : 0;
      await query(
        `INSERT OR IGNORE INTO inventory_by_branch (branch_id, product_id, stock, stock_min, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
        [branch.id, product.id, seedStock, Number(product.stock_min || 0)]
      );
    }
  }
}

async function ensureBranchInventoryCoverageForProduct(executor, { productId, branchId = null, stock = 0, stockMin = 0 }) {
  const runQuery = typeof executor?.query === 'function'
    ? executor.query.bind(executor)
    : query;

  if (runQuery === query) {
    await ensureBranchInventoryTable();
  }

  const branchRows = await runQuery('SELECT id FROM branches WHERE estado <> "Eliminada" ORDER BY id');
  if (!branchRows.length) return;

  const existingRows = await runQuery('SELECT branch_id FROM inventory_by_branch WHERE product_id = ?', [productId]);
  const existing = new Set(existingRows.map((row) => Number(row.branch_id || 0)).filter(Boolean));
  const targetBranchId = Number(branchId || 0) || null;

  for (const branch of branchRows) {
    const currentBranchId = Number(branch.id || 0) || 0;
    if (!currentBranchId || existing.has(currentBranchId)) continue;

    await runQuery(
      `INSERT OR IGNORE INTO inventory_by_branch (branch_id, product_id, stock, stock_min, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [currentBranchId, productId, 0, Number(stockMin || 0)]
    );
  }
}

async function resolveInventoryBranchId(executor, preferredBranchId = null) {
  const runQuery = typeof executor?.query === 'function'
    ? executor.query.bind(executor)
    : query;
  const branchRows = await runQuery('SELECT id FROM branches WHERE estado <> "Eliminada" ORDER BY id');
  if (!branchRows.length) return null;
  const normalizedPreferred = Number(preferredBranchId || 0) || null;
  if (normalizedPreferred && branchRows.some((row) => Number(row.id) === normalizedPreferred)) {
    return normalizedPreferred;
  }
  return Number(branchRows[0]?.id || 0) || null;
}

async function ensureBranchInventoryRecord(executor, productId, branchId) {
  const runQuery = typeof executor?.query === 'function'
    ? executor.query.bind(executor)
    : query;

  // Si ya estamos dentro de withTransaction, evitamos lanzar aseguramientos
  // globales que escriben fuera del executor transaccional de SQLite.
  if (runQuery === query) {
    await ensureBranchInventoryTable();
  }
  const rows = await runQuery(
    `SELECT ib.*, p.precio_compra, p.stock AS legacy_stock, p.stock_min AS legacy_stock_min
     FROM inventory_by_branch ib
     INNER JOIN products p ON p.id = ib.product_id
     WHERE ib.product_id = ? AND ib.branch_id = ?
     LIMIT 1`,
    [productId, branchId]
  );
  if (rows[0]) return rows[0];

  const productRows = await runQuery('SELECT id, stock, stock_min, precio_compra FROM products WHERE id = ? LIMIT 1', [productId]);
  const product = productRows[0];
  if (!product) return null;

  const existingRows = await runQuery('SELECT COUNT(*) AS total FROM inventory_by_branch WHERE product_id = ?', [productId]);
  const branchRows = await runQuery('SELECT id FROM branches ORDER BY id LIMIT 1');
  const primaryBranchId = Number(branchRows[0]?.id || 0) || null;
  const seedStock = Number(existingRows[0]?.total || 0) === 0 && primaryBranchId && Number(branchId) === primaryBranchId
    ? Number(product.stock || 0)
    : 0;

  await runQuery(
    `INSERT OR IGNORE INTO inventory_by_branch (branch_id, product_id, stock, stock_min, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
    [branchId, productId, seedStock, Number(product.stock_min || 0)]
  );

  const reloadedRows = await runQuery(
    `SELECT ib.*, p.precio_compra, p.stock AS legacy_stock, p.stock_min AS legacy_stock_min
     FROM inventory_by_branch ib
     INNER JOIN products p ON p.id = ib.product_id
     WHERE ib.product_id = ? AND ib.branch_id = ?
     LIMIT 1`,
    [productId, branchId]
  );
  return reloadedRows[0] || null;
}

async function updateProductAggregateStock(executor, productId) {
  const runQuery = typeof executor?.query === 'function'
    ? executor.query.bind(executor)
    : query;
  const rows = await runQuery('SELECT COALESCE(SUM(stock), 0) AS total_stock FROM inventory_by_branch WHERE product_id = ?', [productId]);
  await runQuery('UPDATE products SET stock = ? WHERE id = ?', [Number(rows[0]?.total_stock || 0), productId]);
}

async function changeBranchInventoryStock(executor, { productId, branchId, quantityDelta = 0, absoluteStock = null, stockMin = null, preventNegative = false }) {
  const runQuery = typeof executor?.query === 'function'
    ? executor.query.bind(executor)
    : query;

  const resolvedBranchId = await resolveInventoryBranchId({ query: runQuery }, branchId);
  if (!resolvedBranchId) {
    const error = new Error('No hay sucursales activas para preparar inventario.');
    error.statusCode = 404;
    throw error;
  }

  const inventoryRow = await ensureBranchInventoryRecord({ query: runQuery }, productId, resolvedBranchId);
  if (!inventoryRow) {
    const error = new Error('No se pudo preparar el inventario de la sucursal para este producto.');
    error.statusCode = 404;
    throw error;
  }

  const previousStock = Number(inventoryRow.stock || 0);
  const computedStock = absoluteStock === null || absoluteStock === undefined
    ? previousStock + Number(quantityDelta || 0)
    : Number(absoluteStock || 0);
  if (preventNegative && computedStock < 0) {
    const error = new Error(`Stock insuficiente en la sucursal para ${inventoryRow.product_name || 'el producto'}.`);
    error.statusCode = 409;
    throw error;
  }
  const nextStock = Math.max(0, computedStock);
  const resolvedStockMin = stockMin === null || stockMin === undefined
    ? Number(inventoryRow.stock_min || inventoryRow.legacy_stock_min || 0)
    : Number(stockMin || 0);

  await runQuery(
    'UPDATE inventory_by_branch SET stock = ?, stock_min = ?, updated_at = datetime(\'now\') WHERE id = ?',
    [nextStock, resolvedStockMin, inventoryRow.id]
  );
  await updateProductAggregateStock({ query: runQuery }, productId);

  return {
    branchId: Number(resolvedBranchId),
    inventoryBranchId: Number(inventoryRow.id),
    previousStock,
    nextStock,
    stockMin: resolvedStockMin,
    unitCost: Number(inventoryRow.precio_compra || 0)
  };
}

let remoteLicenseSyncPromise = null;
let remoteLicenseSyncAt = 0;
const DEFAULT_LICENSE_FALLBACK_POLL_MS = 5 * 60 * 1000;
let licenseWatcherUnsubscribe = null;
let licenseFallbackPollTimer = null;

function buildLicenseSocketPayload(license = {}, licenseUid = null) {
  return {
    status: license.status,
    planCode: license.planCode || 'basico',
    planName: license.planName || 'Tecno Caja Básico',
    canEnter: Boolean(license.canEnter),
    suspended: Boolean(license.suspended),
    expired: Boolean(license.expired),
    trialEndsAt: license.trialEndsAt || null,
    blockedCode: license.blockedCode || null,
    message: license.message || null,
    licenseUid: licenseUid || license.licenseId || null,
  };
}

function getLicenseFallbackPollMs() {
  const raw = Number(
    process.env.TECNO_CAJA_LICENSE_POLL_MS
    || process.env.TECNO_CAJA_LICENSE_POLL_INTERVAL_MS
    || DEFAULT_LICENSE_FALLBACK_POLL_MS
  );
  if (!Number.isFinite(raw) || raw < 60 * 1000) {
    return DEFAULT_LICENSE_FALLBACK_POLL_MS;
  }
  return Math.floor(raw);
}

function ensureLicenseFallbackPoller(reason = '') {
  if (licenseFallbackPollTimer) return;
  const pollMs = getLicenseFallbackPollMs();
  licenseFallbackPollTimer = setInterval(() => {
    syncRemoteLicenseToLocalConfig({ allowRemoteWrite: false }).catch(() => {});
  }, pollMs);
  const everyMinutes = Math.max(1, Math.round(pollMs / 60000));
  if (reason) {
    console.warn(`[license-sync] ${reason}. Activando polling de respaldo cada ${everyMinutes} min.`);
  } else {
    console.log(`[license-sync] Polling de respaldo activo cada ${everyMinutes} min.`);
  }
}

async function syncRemoteLicenseToLocalConfig({ force = false, allowRemoteWrite = true } = {}) {
  const nowMs = Date.now();
  if (!force && remoteLicenseSyncPromise) {
    return remoteLicenseSyncPromise;
  }
  if (!force && remoteLicenseSyncAt && nowMs - remoteLicenseSyncAt < 2500) {
    return { synced: false, skipped: true };
  }

  remoteLicenseSyncPromise = (async () => {
    try {
      await ensureConfigExtensions();
      const result = await secureLicenseService.resolveState({
        force,
        allowRemote: true,
        allowRemoteWrite,
      });

      if (result.changed && result.license) {
        console.log(
          `[license-sync] Cambio detectado: ${result.license.status} / ${result.license.planCode} (${result.source})`
        );
        io.emit('license:status-changed', buildLicenseSocketPayload(result.license, result.licenseUid));
      } else if (result.reason) {
        console.warn('[license-sync] Usando caché endurecido:', result.reason);
      }

      return result;
    } catch (error) {
      console.warn('[license-sync] Error al sincronizar licencia:', error.message);
      return {
        synced: false,
        reason: error.message,
        license: {
          status: 'expired',
          canEnter: false,
          blockedCode: 'tamper',
          message: error.message,
        },
      };
    }
  })();

  try {
    return await remoteLicenseSyncPromise;
  } finally {
    remoteLicenseSyncAt = Date.now();
    remoteLicenseSyncPromise = null;
  }
}

async function ensureLicenseBackgroundSync() {
  if (licenseWatcherUnsubscribe || licenseFallbackPollTimer) return;
  const watcherStarted = await startFirestoreLicenseWatcher().catch(() => false);
  if (!watcherStarted) {
    ensureLicenseFallbackPoller('Listener en tiempo real no disponible');
  }
}

async function ensureUserExtensions() {
  await addColumnIfMissing('users', 'email', 'VARCHAR(160) DEFAULT NULL');
  await addColumnIfMissing('users', 'password_hash', 'VARCHAR(255) DEFAULT NULL');
  await addColumnIfMissing('users', 'sucursal_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('users', 'caja_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('users', 'tipo_facturacion', `VARCHAR(30) NOT NULL DEFAULT 'mixta'`);
  await addColumnIfMissing('users', 'telefono', 'VARCHAR(40) DEFAULT NULL');
  await addColumnIfMissing('users', 'observacion', 'TEXT DEFAULT NULL');
  await addColumnIfMissing('users', 'creado_por', 'INT DEFAULT NULL');
  await addColumnIfMissing('users', 'fecha_creacion', 'DATETIME DEFAULT NULL');
  await addColumnIfMissing('users', 'linked_client_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('users', 'account_type', `VARCHAR(40) NOT NULL DEFAULT 'staff'`);
  await addColumnIfMissing('users', 'auth_provider', `VARCHAR(40) NOT NULL DEFAULT 'local'`);
  await addColumnIfMissing('users', 'firebase_uid', 'VARCHAR(191) DEFAULT NULL');
  await query('CREATE UNIQUE INDEX idx_users_firebase_uid ON users (firebase_uid)').catch(() => {});
  await query('CREATE UNIQUE INDEX idx_users_email_unique ON users (email)').catch(() => {});
  await query('CREATE INDEX idx_users_sucursal_id ON users (sucursal_id)').catch(() => {});
  await query('CREATE INDEX idx_users_caja_id ON users (caja_id)').catch(() => {});
  await query('UPDATE users SET sucursal_id = branch_id WHERE sucursal_id IS NULL AND branch_id IS NOT NULL').catch(() => {});
  await query('UPDATE users SET branch_id = sucursal_id WHERE branch_id IS NULL AND sucursal_id IS NOT NULL').catch(() => {});
  await query(`UPDATE users SET tipo_facturacion = 'mixta' WHERE tipo_facturacion IS NULL OR tipo_facturacion = ''`).catch(() => {});
  await query(`UPDATE users SET fecha_creacion = datetime('now') WHERE fecha_creacion IS NULL`).catch(() => {});

  const pendingHashRows = await query(
    `SELECT id, password
     FROM users
     WHERE (password_hash IS NULL OR password_hash = '')
       AND password IS NOT NULL
       AND password <> ''`
  ).catch(() => []);
  for (const row of pendingHashRows) {
    await query('UPDATE users SET password_hash = ? WHERE id = ?', [createLocalPasswordHash(row.password), row.id]).catch(() => {});
  }
}

async function ensureProductExtensions() {
  await addColumnIfMissing('products', 'image_url', 'LONGTEXT DEFAULT NULL');
  await addColumnIfMissing('products', 'image_local', 'VARCHAR(255) DEFAULT NULL');
  await addColumnIfMissing('products', 'sale_mode', `VARCHAR(20) NOT NULL DEFAULT 'unidad'`);
  await addColumnIfMissing('products', 'product_type', `VARCHAR(30) NOT NULL DEFAULT 'general'`);
  await addColumnIfMissing('products', 'size_options', 'LONGTEXT DEFAULT NULL');
  await addColumnIfMissing('products', 'dough_options', 'LONGTEXT DEFAULT NULL');
  await addColumnIfMissing('products', 'border_options', 'LONGTEXT DEFAULT NULL');
  await addColumnIfMissing('products', 'extra_options', 'LONGTEXT DEFAULT NULL');
  await addColumnIfMissing('products', 'allow_half_and_half', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing('products', 'is_combo', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing('products', 'aplica_itbis', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing('products', 'preparation_time_minutes', 'INT NOT NULL DEFAULT 15');
  await addColumnIfMissing('products', 'business_metadata', 'LONGTEXT DEFAULT NULL');
  await addColumnIfMissing('products', 'tracks_stock', 'TINYINT(1) NOT NULL DEFAULT 1');
  await query(`UPDATE products SET sale_mode = 'unidad' WHERE sale_mode IS NULL OR sale_mode = ''`).catch(() => {});
}

async function ensureClientExtensions() {
  await addColumnIfMissing('clients', 'email', 'VARCHAR(160) DEFAULT NULL');
  await addColumnIfMissing('clients', 'reference_note', 'VARCHAR(255) DEFAULT NULL');
  await addColumnIfMissing('clients', 'location_link', 'VARCHAR(500) DEFAULT NULL');
  await addColumnIfMissing('clients', 'latitude', 'DECIMAL(10,7) DEFAULT NULL');
  await addColumnIfMissing('clients', 'longitude', 'DECIMAL(10,7) DEFAULT NULL');
}

async function ensureSalesExtensions() {
  await addColumnIfMissing('sale_items', 'sale_mode', `VARCHAR(20) NOT NULL DEFAULT 'unidad'`);
  await addColumnIfMissing('sale_items', 'unit_label', 'VARCHAR(40) DEFAULT NULL');
  await addColumnIfMissing('sale_items', 'weight_unit', 'VARCHAR(10) DEFAULT NULL');
  await addColumnIfMissing('sale_items', 'scale_weight', 'DECIMAL(12,2) DEFAULT NULL');
  await addColumnIfMissing('sale_items', 'scale_measured_value', 'DECIMAL(12,2) DEFAULT NULL');
  await addColumnIfMissing('sale_items', 'scale_measured_unit', 'VARCHAR(10) DEFAULT NULL');
  await addColumnIfMissing('sale_items', 'scale_source', 'VARCHAR(20) DEFAULT NULL');
  await addColumnIfMissing('sale_items', 'scale_raw_reading', 'VARCHAR(255) DEFAULT NULL');
  await query(`UPDATE sale_items SET sale_mode = 'unidad' WHERE sale_mode IS NULL OR sale_mode = ''`).catch(() => {});
  await addColumnIfMissing('sales', 'document_type', `VARCHAR(30) NOT NULL DEFAULT 'ticket'`);
  await addColumnIfMissing('sales', 'client_name_snapshot', 'VARCHAR(160) DEFAULT NULL');
  await addColumnIfMissing('sales', 'client_phone_snapshot', 'VARCHAR(40) DEFAULT NULL');
  await addColumnIfMissing('sales', 'client_tax_id_snapshot', 'VARCHAR(40) DEFAULT NULL');
  await addColumnIfMissing('sales', 'fiscal_status', `VARCHAR(30) NOT NULL DEFAULT 'emitida'`);
  await addColumnIfMissing('sales', 'fiscal_payload', 'LONGTEXT DEFAULT NULL');
  await addColumnIfMissing('sales', 'order_type', `VARCHAR(30) NOT NULL DEFAULT 'mostrador'`);
  await addColumnIfMissing('sales', 'kitchen_status', `VARCHAR(30) NOT NULL DEFAULT 'pendiente'`);
  await addColumnIfMissing('sales', 'delivery_user_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('sales', 'delivery_name_snapshot', 'VARCHAR(160) DEFAULT NULL');
  await addColumnIfMissing('sales', 'delivery_email_snapshot', 'VARCHAR(160) DEFAULT NULL');
  await addColumnIfMissing('sales', 'delivery_phone_snapshot', 'VARCHAR(40) DEFAULT NULL');
  await addColumnIfMissing('sales', 'delivery_address_snapshot', 'VARCHAR(255) DEFAULT NULL');
  await addColumnIfMissing('sales', 'delivery_reference_snapshot', 'VARCHAR(255) DEFAULT NULL');
  await addColumnIfMissing('sales', 'delivery_location_link_snapshot', 'VARCHAR(500) DEFAULT NULL');
  await addColumnIfMissing('sales', 'table_label', 'VARCHAR(40) DEFAULT NULL');
  await addColumnIfMissing('sales', 'order_notes', 'TEXT DEFAULT NULL');
  await addColumnIfMissing('sales', 'canceled_at', 'DATETIME DEFAULT NULL');
  await addColumnIfMissing('sales', 'canceled_by_user_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('sales', 'canceled_by_user_name', 'VARCHAR(120) DEFAULT NULL');
  await addColumnIfMissing('sales', 'cancel_reason', 'VARCHAR(255) DEFAULT NULL');
  await addColumnIfMissing('sales', 'delivery_cash_status', `VARCHAR(30) NOT NULL DEFAULT 'na'`);
  await addColumnIfMissing('sales', 'delivery_cash_received_at', 'DATETIME DEFAULT NULL');
  await addColumnIfMissing('sales', 'delivery_cash_received_by_user_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('sales', 'delivery_cash_received_by_user_name', 'VARCHAR(120) DEFAULT NULL');
  await addColumnIfMissing('sales', 'pdf_path', 'VARCHAR(512) DEFAULT NULL');
}

// ── NCF / Comprobantes fiscales ────────────────────────────────────────────────
async function ensureNcfExtensions() {
  await query(`
    CREATE TABLE IF NOT EXISTS ncf_sequences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INT NOT NULL DEFAULT 1,
      branch_id INT DEFAULT NULL,
      ncf_type VARCHAR(5) NOT NULL,
      siguiente_numero INT NOT NULL DEFAULT 1,
      maximo INT NOT NULL DEFAULT 99999999,
      activa TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // NCF columns on sales
  await addColumnIfMissing('sales', 'ncf', 'VARCHAR(19) DEFAULT NULL');
  await addColumnIfMissing('sales', 'ncf_type', 'VARCHAR(5) DEFAULT NULL');
  await addColumnIfMissing('sales', 'ncf_referencia', 'VARCHAR(19) DEFAULT NULL');
  await addColumnIfMissing('sales', 'factura_referencia_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('sales', 'razon_social_cliente', 'VARCHAR(150) DEFAULT NULL');
  await addColumnIfMissing('sales', 'es_electronica', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing('sales', 'qr_data', 'TEXT DEFAULT NULL');
  await addColumnIfMissing('sales', 'fecha_emision_fiscal', 'DATETIME DEFAULT NULL');
  // Fiscal fields on clients
  await addColumnIfMissing('clients', 'rnc', 'VARCHAR(11) DEFAULT NULL');
  await addColumnIfMissing('clients', 'razon_social', 'VARCHAR(150) DEFAULT NULL');
  await addColumnIfMissing('clients', 'tipo_cliente', `VARCHAR(20) NOT NULL DEFAULT 'persona'`);
}

// Generate the next NCF for a given type, respecting branch sequences
async function getNextNcfFromSequence(conn, ncfType, branchId) {
  const seqs = await conn.query(
    `SELECT * FROM ncf_sequences WHERE ncf_type = ? AND activa = 1
     AND (branch_id = ? OR branch_id IS NULL)
     ORDER BY branch_id DESC LIMIT 1`,
    [ncfType, branchId || null]
  );
  if (!seqs[0]) {
    const err = new Error(`No hay secuencia configurada para ${ncfType}. Créala en Configuración → Comprobantes.`);
    err.statusCode = 409;
    throw err;
  }
  const seq = seqs[0];
  if (seq.siguiente_numero > seq.maximo) {
    const err = new Error(`La secuencia ${ncfType} ha alcanzado su límite (${seq.maximo}). Solicita nuevas secuencias a la DGII.`);
    err.statusCode = 409;
    throw err;
  }
  const ncfNumber = seq.siguiente_numero;
  const ncf = `${ncfType}${String(ncfNumber).padStart(8, '0')}`;
  await conn.query(
    'UPDATE ncf_sequences SET siguiente_numero = siguiente_numero + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [seq.id]
  );
  return ncf;
}

const NCF_LABELS = {
  B01: 'Crédito Fiscal',
  B02: 'Consumidor Final',
  B03: 'Nota de Débito',
  B04: 'Nota de Crédito',
  B14: 'Régimen Especial',
  B15: 'Gubernamental'
};

async function ensureSuspendedSalesTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS suspended_sales (
      id VARCHAR(48) PRIMARY KEY,
      sale_name VARCHAR(160) NOT NULL,
      draft_payload LONGTEXT NOT NULL,
      total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      item_count INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP 
    )
  `);
}

async function ensureQuotationsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS quotations (
      id VARCHAR(48) PRIMARY KEY,
      quotation_name VARCHAR(160) NOT NULL,
      client_name VARCHAR(160) NOT NULL,
      draft_payload LONGTEXT NOT NULL,
      total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      item_count INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function ensureSuppliersTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre VARCHAR(160) NOT NULL,
      empresa VARCHAR(160) DEFAULT NULL,
      telefono VARCHAR(40) DEFAULT NULL,
      email VARCHAR(160) DEFAULT NULL,
      rnc VARCHAR(40) DEFAULT NULL,
      contacto VARCHAR(120) DEFAULT NULL,
      direccion VARCHAR(255) DEFAULT NULL,
      visit_days VARCHAR(120) DEFAULT NULL,
      payment_terms_days INT NOT NULL DEFAULT 30,
      estado VARCHAR(20) NOT NULL DEFAULT 'Activo',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await addColumnIfMissing('suppliers', 'visit_days', 'VARCHAR(120) DEFAULT NULL');
  await addColumnIfMissing('suppliers', 'payment_terms_days', 'INT NOT NULL DEFAULT 30');
  await query(`UPDATE suppliers SET visit_days = 'Lunes,Miércoles,Viernes', payment_terms_days = 15 WHERE nombre = 'Distribuidora Central' AND (visit_days IS NULL OR visit_days = '')`);
  await query(`UPDATE suppliers SET visit_days = 'Martes,Jueves', payment_terms_days = 30 WHERE nombre = 'Almacenes del Caribe' AND (visit_days IS NULL OR visit_days = '')`);
  await query(`UPDATE suppliers SET visit_days = 'Sábado', payment_terms_days = 21 WHERE nombre = 'Suplidora La Nacional' AND (visit_days IS NULL OR visit_days = '')`);
}

async function ensureInventoryMovementsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INT NOT NULL,
      branch_id INT DEFAULT NULL,
      source_branch_id INT DEFAULT NULL,
      destination_branch_id INT DEFAULT NULL,
      cash_register_id INT DEFAULT NULL,
      sale_id INT DEFAULT NULL,
      transfer_id INT DEFAULT NULL,
      movement_type VARCHAR(30) NOT NULL,
      quantity_change DECIMAL(10,2) NOT NULL,
      previous_stock DECIMAL(10,2) NOT NULL DEFAULT 0,
      new_stock DECIMAL(10,2) NOT NULL DEFAULT 0,
      unit_cost DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      reference_type VARCHAR(30) DEFAULT NULL,
      reference_id VARCHAR(80) DEFAULT NULL,
      notes VARCHAR(255) DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_inventory_movements_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      CONSTRAINT fk_inventory_movements_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);
}

async function ensureCashMovementExtensions() {
  await addColumnIfMissing('cash_movements', 'created_by_user_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('cash_movements', 'created_by_user_name', 'VARCHAR(120) DEFAULT NULL');
}

/**
 * Migraciones para el sistema de turnos con fecha operativa.
 *
 * operative_date en cash_sessions:
 *   Fecha del día en que se ABRIÓ la sesión (fecha operativa del turno).
 *   No cambia si el turno cruza medianoche.
 *   Ejemplo: turno abierto el 24/05 a las 8h sigue siendo operative_date='2026-05-24'
 *   aunque cierre a las 2h del día 25.
 *
 * cash_session_id en sales:
 *   Liga cada venta al turno activo cuando fue creada.
 *   Permite filtrar "ventas del turno" sin depender de la fecha del reloj.
 *
 * operative_date en sales:
 *   Copia la fecha operativa del turno en cada venta.
 *   Permite reportes históricos por "día operativo" sin hacer JOIN.
 */
async function ensureOperativeDateExtensions() {
  // cash_sessions: fecha operativa (día de apertura del turno)
  await addColumnIfMissing('cash_sessions', 'operative_date', 'DATE DEFAULT NULL');
  // cash_sessions: quién cerró
  await addColumnIfMissing('cash_sessions', 'closed_by_user_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('cash_sessions', 'closed_by_user_name', 'VARCHAR(120) DEFAULT NULL');
  // cash_sessions: duración en horas (calculada al cerrar)
  await addColumnIfMissing('cash_sessions', 'duration_hours', 'DECIMAL(8,2) DEFAULT NULL');

  // sales: FK al turno activo cuando se creó la venta
  await addColumnIfMissing('sales', 'cash_session_id', 'INT DEFAULT NULL');
  // sales: fecha operativa del turno (copia desnormalizada para consultas rápidas)
  await addColumnIfMissing('sales', 'operative_date', 'DATE DEFAULT NULL');

  // Backfill: asignar operative_date a sesiones existentes que no la tienen
  // (usa la fecha de apertura como referencia)
  await query(`
    UPDATE cash_sessions
    SET operative_date = DATE(opened_at)
    WHERE operative_date IS NULL AND opened_at IS NOT NULL
  `).catch(() => {});

  // Backfill: asignar operative_date a ventas existentes sin ella
  // (usa la fecha de creación como fallback)
  await query(`
    UPDATE sales
    SET operative_date = DATE(created_at)
    WHERE operative_date IS NULL AND created_at IS NOT NULL
  `).catch(() => {});

  // Backfill: ligar ventas a su sesión cuando cash_register_id coincide
  // (solo las ventas que ocurrieron durante una sesión abierta de esa caja)
  await query(`
    UPDATE sales s
    SET s.cash_session_id = (
      SELECT cs.id
      FROM cash_sessions cs
      WHERE cs.cash_register_id = s.cash_register_id
        AND cs.opened_at <= s.created_at
        AND (cs.closed_at IS NULL OR cs.closed_at >= s.created_at)
      ORDER BY cs.id DESC
      LIMIT 1
    )
    WHERE s.cash_session_id IS NULL AND s.cash_register_id IS NOT NULL
  `).catch(() => {}); // no-fatal: puede fallar en SQLite por sintaxis
}

// ─── Memoización de migraciones de schema ─────────────────────────────────────
// Estas funciones son idempotentes pero caras (SHOW COLUMNS + ALTER TABLE).
// Se llaman desde muchos endpoints (sobre todo el hot-path de ventas), por lo
// que memoizarlas ahorra decenas de queries por request después del arranque.
// Si el schema falla, la memo se limpia para permitir retry en el siguiente call.
ensureBusinessRulesExtensions     = memoizeOnceAsync(ensureBusinessRulesExtensions);
ensureBusinessStructureExtensions = memoizeOnceAsync(ensureBusinessStructureExtensions);
ensureSalesExtensions             = memoizeOnceAsync(ensureSalesExtensions);
ensureClientExtensions            = memoizeOnceAsync(ensureClientExtensions);
ensureInventoryMovementsTable     = memoizeOnceAsync(ensureInventoryMovementsTable);
ensureNcfExtensions               = memoizeOnceAsync(ensureNcfExtensions);

function mapInventoryMovementRow(row) {
  return {
    id: Number(row.id),
    productId: Number(row.product_id),
    productName: row.product_name || row.nombre || 'Producto',
    productCode: row.product_code || row.codigo || '',
    sucursalId: row.branch_id === null || row.branch_id === undefined ? null : Number(row.branch_id),
    sucursalOrigenId: row.source_branch_id === null || row.source_branch_id === undefined ? null : Number(row.source_branch_id),
    sucursalDestinoId: row.destination_branch_id === null || row.destination_branch_id === undefined ? null : Number(row.destination_branch_id),
    cajaId: row.cash_register_id === null || row.cash_register_id === undefined ? null : Number(row.cash_register_id),
    ventaId: row.sale_id === null || row.sale_id === undefined ? null : Number(row.sale_id),
    transferenciaId: row.transfer_id === null || row.transfer_id === undefined ? null : Number(row.transfer_id),
    tipo: row.movement_type || 'ajuste',
    cantidad: Number(row.quantity_change || 0),
    stockAnterior: Number(row.previous_stock || 0),
    stockNuevo: Number(row.new_stock || 0),
    costoUnitario: Number(row.unit_cost || 0),
    referenciaTipo: row.reference_type || '',
    referenciaId: row.reference_id || '',
    notas: row.notes || '',
    usuarioId: row.created_by_user_id === null ? null : Number(row.created_by_user_id),
    usuarioNombre: row.created_by_user_name || 'Sistema',
    fecha: row.created_at
  };
}

async function registerInventoryMovement(executor, payload) {
  const runQuery = typeof executor?.query === 'function'
    ? executor.query.bind(executor)
    : query;

  // Validate userId against the FK constraint: created_by_user_id REFERENCES users(id).
  // An invalid (non-existent) userId would cause a FK violation in MariaDB, so we verify
  // existence and fall back to NULL — the name column preserves the audit trail.
  const rawUserId = Number(payload.usuarioId || 0);
  let safeUserId = null;
  if (rawUserId > 0) {
    const userCheck = await runQuery('SELECT id FROM users WHERE id = ? LIMIT 1', [rawUserId]).catch(() => []);
    safeUserId = userCheck.length > 0 ? rawUserId : null;
  }

  await runQuery(
    `INSERT INTO inventory_movements
      (product_id, branch_id, source_branch_id, destination_branch_id, cash_register_id, sale_id, transfer_id, movement_type, quantity_change, previous_stock, new_stock, unit_cost, reference_type, reference_id, notes, created_by_user_id, created_by_user_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.productId,
      payload.branchId || null,
      payload.sourceBranchId || null,
      payload.destinationBranchId || null,
      payload.cashRegisterId || null,
      payload.saleId || null,
      payload.transferId || null,
      payload.tipo,
      payload.cantidad,
      payload.stockAnterior,
      payload.stockNuevo,
      payload.costoUnitario || 0,
      payload.referenciaTipo || null,
      payload.referenciaId || null,
      payload.notas || null,
      safeUserId,
      payload.usuarioNombre || 'Sistema'
    ]
  );
}

async function ensureSupplierInvoicesTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS supplier_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INT NOT NULL,
      invoice_number VARCHAR(60) NOT NULL,
      issued_at DATE NOT NULL,
      due_at DATE DEFAULT NULL,
      total_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      paid_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      pending_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      status VARCHAR(20) NOT NULL DEFAULT 'Pendiente',
      notes VARCHAR(255) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_supplier_invoices_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
    )
  `);

  await query(`
    DELETE FROM supplier_invoices
    WHERE id IN (
      SELECT si1.id
      FROM supplier_invoices si1
      INNER JOIN supplier_invoices si2
        ON si1.id > si2.id
       AND si1.supplier_id = si2.supplier_id
       AND si1.invoice_number = si2.invoice_number
       AND si1.issued_at = si2.issued_at
       AND COALESCE(si1.due_at, '1900-01-01') = COALESCE(si2.due_at, '1900-01-01')
       AND si1.total_amount = si2.total_amount
       AND si1.paid_amount = si2.paid_amount
       AND si1.pending_amount = si2.pending_amount
       AND si1.status = si2.status
       AND COALESCE(si1.notes, '') = COALESCE(si2.notes, '')
    )
  `);
}

async function getBranchRows() {
  await ensureBusinessStructureExtensions();
  return query('SELECT * FROM branches WHERE estado <> "Eliminada" ORDER BY nombre, id');
}

async function getCashRegisterRows(branchId = null) {
  await ensureBusinessStructureExtensions();
  if (branchId) {
    return query(
      'SELECT * FROM cash_registers WHERE estado <> "Eliminada" AND branch_id = ? ORDER BY nombre, id',
      [Number(branchId)]
    );
  }
  return query('SELECT * FROM cash_registers WHERE estado <> "Eliminada" ORDER BY branch_id, nombre, id');
}

async function getActiveBusinessStructure(configRow = null) {
  await ensureBusinessStructureExtensions();
  const row = configRow || (await query('SELECT active_branch_id, active_cash_register_id FROM config WHERE id = 1 LIMIT 1'))[0] || {};
  const terminalScope = getTerminalScopeSelection();
  const branches = await getBranchRows();
  const activeBranchId = Number(terminalScope.branchId || row.active_branch_id || 0) || Number(branches[0]?.id || 0) || null;
  const cashRegisters = await getCashRegisterRows(activeBranchId);
  const activeCashRegisterId = Number(terminalScope.cashRegisterId || row.active_cash_register_id || 0) || Number(cashRegisters[0]?.id || 0) || null;
  const activeBranch = branches.find((item) => Number(item.id) === Number(activeBranchId || 0)) || null;
  const activeCashRegister = cashRegisters.find((item) => Number(item.id) === Number(activeCashRegisterId || 0)) || null;

  return {
    branches,
    cashRegisters,
    activeBranch,
    activeCashRegister,
    activeBranchId: activeBranch ? Number(activeBranch.id) : null,
    activeCashRegisterId: activeCashRegister ? Number(activeCashRegister.id) : null
  };
}

async function resolveBusinessStructureSelection(executor = null, branchId = null, cashRegisterId = null) {
  const runner = executor && typeof executor.query === 'function'
    ? executor.query.bind(executor)
    : query;
  const terminalScope = getTerminalScopeSelection();

  // En transacciones SQLite, re-ejecutar estos "ensure" por fuera del executor
  // puede dejar el COMMIT final sin una transacción activa.
  if (runner === query) {
    await ensureBusinessStructureExtensions();
  }
  const configRows = await runner('SELECT active_branch_id, active_cash_register_id FROM config WHERE id = 1 LIMIT 1');
  const config = configRows[0] || {};
  const requestedBranchId = Number(branchId || 0) || null;
  const requestedCashRegisterId = Number(cashRegisterId || 0) || null;

  const availableBranches = await runner('SELECT * FROM branches WHERE estado <> "Eliminada" ORDER BY id');
  if (!availableBranches.length) {
    const error = new Error('No hay sucursales activas configuradas.');
    error.statusCode = 404;
    throw error;
  }

  const candidateBranchIds = requestedBranchId
    ? [requestedBranchId]
    : [
      Number(terminalScope.branchId || 0) || null,
      Number(config.active_branch_id || 0) || null,
      Number(availableBranches[0]?.id || 0) || null
    ].filter(Boolean);
  const selectedBranchId = candidateBranchIds.find((idValue) =>
    availableBranches.some((row) => Number(row.id) === Number(idValue))
  ) || null;
  const branch = availableBranches.find((row) => Number(row.id) === Number(selectedBranchId || 0)) || null;
  if (!branch) {
    const error = new Error('La sucursal seleccionada no existe.');
    error.statusCode = 404;
    throw error;
  }

  const branchRegisters = await runner(
    'SELECT * FROM cash_registers WHERE branch_id = ? AND estado <> "Eliminada" ORDER BY id',
    [Number(branch.id)]
  );
  if (!branchRegisters.length) {
    const error = new Error('No hay cajas activas configuradas para la sucursal seleccionada.');
    error.statusCode = 404;
    throw error;
  }

  const candidateRegisterIds = requestedCashRegisterId
    ? [requestedCashRegisterId]
    : [
      Number(terminalScope.cashRegisterId || 0) || null,
      Number(config.active_cash_register_id || 0) || null,
      Number(branchRegisters[0]?.id || 0) || null
    ].filter(Boolean);
  const selectedCashRegisterId = candidateRegisterIds.find((idValue) =>
    branchRegisters.some((row) => Number(row.id) === Number(idValue))
  ) || null;
  const cashRegister = branchRegisters.find((row) => Number(row.id) === Number(selectedCashRegisterId || 0)) || null;
  if (!cashRegister) {
    const error = new Error('La caja seleccionada no existe para esa sucursal.');
    error.statusCode = 404;
    throw error;
  }

  if (!requestedBranchId && !requestedCashRegisterId && runner === query) {
    const configBranchId = Number(config.active_branch_id || 0) || null;
    const configCashRegisterId = Number(config.active_cash_register_id || 0) || null;
    if (configBranchId !== Number(branch.id) || configCashRegisterId !== Number(cashRegister.id)) {
      await query(
        'UPDATE config SET active_branch_id = ?, active_cash_register_id = ? WHERE id = 1',
        [Number(branch.id), Number(cashRegister.id)]
      );
    }
  }

  return {
    branchId: Number(branch.id),
    cashRegisterId: Number(cashRegister.id),
    branch,
    cashRegister
  };
}

async function ensureDiningTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS dining_tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre VARCHAR(40) NOT NULL UNIQUE,
      capacidad INT NOT NULL DEFAULT 4,
      estado VARCHAR(20) NOT NULL DEFAULT 'Libre',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const countRows = await query('SELECT COUNT(*) AS total FROM dining_tables');
  if (!Number(countRows[0]?.total || 0)) {
    for (let index = 1; index <= 8; index += 1) {
      await query('INSERT INTO dining_tables (nombre, capacidad, estado) VALUES (?, ?, "Libre")', [`Mesa ${index}`, index <= 4 ? 4 : 6]);
    }
  }
}

async function ensureBusinessStarterCatalog(type = 'pizzeria') {
  const template = getBusinessTemplate(type);
  await ensureCategoriesTable();
  // Solo precargamos categorías base. El inventario ahora inicia vacío para evitar datos demo.
  for (const category of template.categories || []) {
    await query('INSERT OR IGNORE INTO categories (nombre) VALUES (?)', [category]);
  }
}

async function ensureDefaultPizzeriaCatalog() {
  await ensureBusinessStarterCatalog('pizzeria');
}

function normalizeBusinessStructureMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'monocaja';
  if (['monocaja', 'mono-caja', 'mono_caja', 'single-register', 'single_register', 'singleregister',
       'mononegocio', 'mononegocios', 'mono-negocio', 'mono-negocios', 'singlebusiness',
       'single-business', 'single_business'].includes(normalized)) {
    return 'monocaja';
  }
  // Sucursal: terminal secundaria vinculada (requiere auth, pero no multicaja)
  if (['sucursal', 'sucursal-secundaria', 'branch', 'branch-terminal'].includes(normalized)) {
    return 'sucursal';
  }
  if (['multicaja', 'multi-caja', 'multi_caja', 'multiregister', 'multi-register', 'multi_register'].includes(normalized)) {
    return 'multicaja';
  }
  if (['multisucursal', 'multi-sucursal', 'multi_sucursal', 'multibranch', 'multi-branch', 'multi_branch'].includes(normalized)) {
    return 'multisucursal';
  }
  return null;
}

function getBusinessStructureCapabilities(modeValue) {
  const mode = normalizeBusinessStructureMode(modeValue) || 'monocaja';
  return {
    mode,
    allowsMultipleBranches: mode === 'multisucursal',
    allowsMultipleRegisters: mode === 'multicaja' || mode === 'multisucursal',
    requiresAuth: ['multicaja', 'sucursal', 'multisucursal'].includes(mode),
    isSecondaryTerminal: ['multicaja', 'sucursal', 'multisucursal'].includes(mode)
  };
}

async function getConfiguredBusinessStructureMode() {
  const rows = await query('SELECT business_structure_mode FROM config WHERE id = 1 LIMIT 1');
  return normalizeBusinessStructureMode(rows[0]?.business_structure_mode) || 'monocaja';
}

async function ensureBusinessStructureModeCompatibility(modeValue, runner = query) {
  const mode = normalizeBusinessStructureMode(modeValue);
  if (!mode) {
    const error = new Error('La estructura del negocio no es válida.');
    error.statusCode = 400;
    throw error;
  }

  const [branchCountRows, registerCountRows] = await Promise.all([
    runner('SELECT COUNT(*) AS total FROM branches WHERE estado <> "Eliminada"'),
    runner('SELECT COUNT(*) AS total FROM cash_registers WHERE estado <> "Eliminada"')
  ]);

  const branchCount = Number(branchCountRows[0]?.total || 0);
  const registerCount = Number(registerCountRows[0]?.total || 0);

  if (mode === 'monocaja' && (branchCount > 1 || registerCount > 1)) {
    const error = new Error('No puedes cambiar a Monocaja mientras existan varias sucursales o varias cajas.');
    error.statusCode = 409;
    throw error;
  }
  if (mode === 'multicaja' && branchCount > 1) {
    const error = new Error('No puedes cambiar a Multicaja mientras existan varias sucursales.');
    error.statusCode = 409;
    throw error;
  }

  return mode;
}

async function resolveUserBranchAssignment(requestedBranchId = null) {
  const [configRows, branchRows] = await Promise.all([
    query('SELECT active_branch_id, business_structure_mode FROM config WHERE id = 1 LIMIT 1'),
    query('SELECT id FROM branches WHERE estado <> "Eliminada" ORDER BY id LIMIT 1')
  ]);
  const config = configRows[0] || {};
  const terminalScope = getTerminalScopeSelection();
  const mode = normalizeBusinessStructureMode(config.business_structure_mode) || 'monocaja';
  const activeBranchId = Number(terminalScope.branchId || config.active_branch_id || 0) || Number(branchRows[0]?.id || 0) || null;
  if (mode === 'multisucursal') {
    return Number(requestedBranchId || activeBranchId || 0) || null;
  }
  return activeBranchId;
}

async function ensureStarterCatalogSeededIfNeeded(config) {
  if (!config?.setupCompleted || config?.starterCatalogSeeded) {
    return config;
  }

  await ensureBusinessStarterCatalog(config.tipoNegocio || 'pizzeria');
  await query('UPDATE config SET starter_catalog_seeded = 1 WHERE id = 1');
  return getConfig();
}

async function ensureDeliveryTrackingTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS delivery_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id VARCHAR(40) DEFAULT NULL,
      user_id INT DEFAULT NULL,
      user_name VARCHAR(160) DEFAULT NULL,
      latitude DECIMAL(10,7) NOT NULL,
      longitude DECIMAL(10,7) NOT NULL,
      accuracy_meters DECIMAL(10,2) DEFAULT NULL,
      source VARCHAR(40) NOT NULL DEFAULT 'mobile',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function resolveSupplierInvoiceStatus(invoice) {
  const pending = Number(invoice.pending_amount || invoice.pendingAmount || 0);
  const dueAt = String(invoice.due_at || invoice.dueAt || '').slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  if (pending <= 0) return 'Pagada';
  if (dueAt && dueAt < today) return 'Vencida';
  return 'Pendiente';
}

function mapCategoryRow(row) {
  return {
    id: row.id,
    nombre: row.nombre
  };
}

function mapBranchRow(row) {
  return {
    id: Number(row.id),
    negocioId: row.business_id === null || row.business_id === undefined ? null : Number(row.business_id),
    nombre: row.nombre,
    codigo: row.codigo || '',
    direccion: row.direccion || '',
    telefono: row.telefono || '',
    encargado: row.encargado || '',
    estado: row.estado || 'Activa',
    createdAt: row.created_at
  };
}

function mapCashRegisterRow(row) {
  return {
    id: Number(row.id),
    sucursalId: Number(row.branch_id || 0),
    nombre: row.nombre,
    codigo: row.codigo || '',
    estado: row.estado || 'Activa',
    tipoCaja: row.tipo_caja || 'mixta',
    puedeCobrarOtrasCajas: Boolean(Number(row.puede_cobrar_otras_cajas || 0)),
    descripcion: row.descripcion || '',
    createdAt: row.created_at
  };
}

function mapAuditRow(row) {
  return {
    id: row.id,
    fecha: row.created_at,
    usuario: row.user_name,
    rol: row.user_role,
    modulo: row.module_name,
    accion: row.action_name,
    detalle: row.detail
  };
}

function mapSuspendedSaleRow(row) {
  const draft = parseJsonObjectField(row.draft_payload, {});
  const items = Array.isArray(draft.items) ? draft.items : [];

  return {
    id: row.id,
    nombre: row.sale_name || draft.nombre || 'Venta suspendida',
    hora: row.created_at,
    updatedAt: row.updated_at,
    total: Number(row.total || draft.total || 0),
    itemCount: Number(row.item_count || draft.itemCount || items.length || 0),
    clientId: draft.clientId || null,
    clientName: draft.clientName || 'Consumidor Final',
    documentType: draft.documentType || 'ticket',
    payMethod: draft.payMethod || 'efectivo',
    deliveryUserId: draft.deliveryUserId || null,
    orderType: draft.orderType || 'mostrador',
    kitchenStatus: draft.kitchenStatus || 'pendiente',
    generalDiscount: Number(draft.generalDiscount || 0) || 0,
    tableLabel: draft.tableLabel || '',
    deliveryPhone: draft.deliveryPhone || '',
    deliveryAddress: draft.deliveryAddress || '',
    deliveryReference: draft.deliveryReference || '',
    deliveryLink: draft.deliveryLink || '',
    orderNotes: draft.orderNotes || '',
    items
  };
}

function mapQuotationRow(row) {
  const draft = parseJsonObjectField(row.draft_payload, {});
  const items = Array.isArray(draft.items) ? draft.items : [];

  return {
    id: row.id,
    nombre: row.quotation_name || draft.nombre || 'Cotización',
    hora: row.created_at,
    updatedAt: row.updated_at,
    total: Number(row.total || draft.total || 0),
    itemCount: Number(row.item_count || draft.itemCount || items.length || 0),
    clientId: draft.clientId || null,
    clientName: row.client_name || draft.clientName || 'Cliente no definido',
    documentType: draft.documentType || 'ticket',
    payMethod: draft.payMethod || 'efectivo',
    deliveryUserId: draft.deliveryUserId || null,
    orderType: draft.orderType || 'mostrador',
    kitchenStatus: draft.kitchenStatus || 'pendiente',
    generalDiscount: Number(draft.generalDiscount || 0) || 0,
    tableLabel: draft.tableLabel || '',
    deliveryPhone: draft.deliveryPhone || '',
    deliveryAddress: draft.deliveryAddress || '',
    deliveryReference: draft.deliveryReference || '',
    deliveryLink: draft.deliveryLink || '',
    orderNotes: draft.orderNotes || '',
    items
  };
}

async function ensureAuditTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INT DEFAULT NULL,
      user_name VARCHAR(120) NOT NULL,
      user_role VARCHAR(40) NOT NULL,
      module_name VARCHAR(60) NOT NULL,
      action_name VARCHAR(120) NOT NULL,
      detail TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_audit_logs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);
}

async function ensureCategoriesTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre VARCHAR(80) NOT NULL UNIQUE,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const productCategories = await query('SELECT DISTINCT categoria FROM products WHERE categoria IS NOT NULL AND categoria <> ""');
  for (const row of productCategories) {
    await query('INSERT OR IGNORE INTO categories (nombre) VALUES (?)', [row.categoria]);
  }
}

async function getCategories() {
  await ensureCategoriesTable();
  const rows = await query('SELECT * FROM categories ORDER BY nombre');
  return rows.map(mapCategoryRow);
}

async function writeAuditLog({ userId = null, userName = 'Sistema', userRole = 'Sistema', moduleName, actionName, detail = '' }) {
  await ensureAuditTable();
  let safeUserId = userId;
  if (safeUserId !== null && safeUserId !== undefined && safeUserId !== '') {
    try {
      const rows = await query('SELECT id FROM users WHERE id = ? LIMIT 1', [safeUserId]);
      if (!rows[0]) {
        safeUserId = null;
      }
    } catch (_error) {
      safeUserId = null;
    }
  } else {
    safeUserId = null;
  }
  await query(
    `INSERT INTO audit_logs (user_id, user_name, user_role, module_name, action_name, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    [safeUserId, userName, userRole, moduleName, actionName, detail]
  );
}

async function logWizardNetworkAttempt({
  phase = 'prueba',
  result = 'pendiente',
  principalHost = '',
  normalizedBaseUrl = '',
  requestedBy = '',
  actor = {},
  sourceIp = '',
  detail = ''
} = {}) {
  const safeRequestedBy = String(requestedBy || actor?.userName || 'Terminal').trim() || 'Terminal';
  const baseDetail = [
    `Fase: ${phase}`,
    `Resultado: ${result}`,
    principalHost ? `Destino: ${principalHost}` : '',
    normalizedBaseUrl ? `URL: ${normalizedBaseUrl}` : '',
    sourceIp ? `IP origen: ${sourceIp}` : '',
    detail ? `Detalle: ${detail}` : ''
  ].filter(Boolean).join(' | ');

  try {
    await writeAuditLog({
      userId: actor?.userId ?? null,
      userName: safeRequestedBy,
      userRole: actor?.userRole || 'Wizard',
      moduleName: 'Sistema',
      actionName: 'Intento de enlace terminal',
      detail: baseDetail
    });
  } catch (_error) {
    // No interrumpir el flujo del wizard por fallos de auditoría.
  }
}

function getActor(req) {
  if (req.authUser) {
    return {
      userId: Number(req.authUser.id || 0) || null,
      userName: req.authUser.nombre || req.authUser.usuario || 'Sistema',
      userRole: req.authUser.role_name || req.authUser.rol || 'Sistema'
    };
  }
  return {
    userId: req.body?.actorUserId || null,
    userName: req.body?.actorUserName || 'Sistema',
    userRole: req.body?.actorUserRole || 'Sistema'
  };
}

async function getUserWithRoleContextById(userId) {
  const normalizedUserId = Number(userId || 0) || 0;
  if (!normalizedUserId) return null;
  await ensureRolesTable();
  await ensureUserExtensions();
  const rows = await query(
    `SELECT u.*, r.codigo AS role_code, r.nombre AS role_name, r.permisos AS role_permissions
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.id = ?
     LIMIT 1`,
    [normalizedUserId]
  );
  if (!rows[0]) return null;
  return {
    ...rows[0],
    role_code: String(rows[0].role_code || '').trim() || normalizeLegacyUserRoleCode(rows[0].rol),
    role_name: rows[0].role_name || rows[0].rol,
    role_permissions: parseJsonArrayField(rows[0].role_permissions)
  };
}

async function resolveRequestActorUser(req, options = {}) {
  const { required = true, allowPayloadFallback = true } = options;
  if (req.authUser) {
    return req.authUser;
  }

  const fallbackId = allowPayloadFallback ? getRequestActorFallbackId(req) : null;
  if (fallbackId) {
    const user = await getUserWithRoleContextById(fallbackId);
    if (user && String(user.estado || '').trim().toLowerCase() === 'activo') {
      req.authUser = user;
      return user;
    }
  }

  if (!required) return null;
  throw createHttpError('Debes iniciar sesión para realizar esta acción.', 401);
}

function assertActorCanAccessBranch(actorUser, branchId, message = 'No puedes operar fuera de tu sucursal.') {
  const scopedBranchId = getUserScopeBranchId(actorUser);
  if (!scopedBranchId) return;
  if (Number(branchId || 0) !== Number(scopedBranchId || 0)) {
    throw createHttpError(message, 403);
  }
}

function assertActorCanAccessCashRegister(actorUser, cashRegisterId, message = 'No puedes operar fuera de tu caja asignada.') {
  const scopedCashRegisterId = getUserScopeCashRegisterId(actorUser);
  if (!scopedCashRegisterId) return;
  if (Number(cashRegisterId || 0) !== Number(scopedCashRegisterId || 0)) {
    throw createHttpError(message, 403);
  }
}

async function resolveScopedBusinessStructureSelection(req, executor = null, branchId = null, cashRegisterId = null) {
  const actorUser = await resolveRequestActorUser(req, { required: false });
  const selection = await resolveBusinessStructureSelection(executor, branchId, cashRegisterId);
  if (actorUser) {
    assertActorCanAccessBranch(actorUser, selection.branchId);
    assertActorCanAccessCashRegister(actorUser, selection.cashRegisterId);
  }
  return selection;
}

function userRoleHasPermission(user, ...permissions) {
  const values = new Set(parseJsonArrayField(user?.role_permissions));
  if (values.has('*')) return true;
  return permissions.some((permission) => values.has(permission));
}

function canManageUsersWithRole(user) {
  const roleCode = normalizeLegacyUserRoleCode(user?.role_code || user?.rol);
  if (roleCode === 'administrador_general' || roleCode === 'administrador_sucursal') {
    return true;
  }
  if (roleCode === 'supervisor') {
    return userRoleHasPermission(user, 'usuarios', 'usuarios_crear', 'gestionar_usuarios');
  }
  return false;
}

function canAssignManagedRole(actorUser, targetRoleCode) {
  const actorRoleCode = normalizeLegacyUserRoleCode(actorUser?.role_code || actorUser?.rol);
  const nextRoleCode = normalizeLegacyUserRoleCode(targetRoleCode);

  if (actorRoleCode === 'administrador_general') {
    return true;
  }
  if (actorRoleCode === 'administrador_sucursal') {
    return nextRoleCode !== 'administrador_general';
  }
  if (actorRoleCode === 'supervisor' && canManageUsersWithRole(actorUser)) {
    return !['administrador_general', 'administrador_sucursal'].includes(nextRoleCode);
  }
  return false;
}

async function resolveUserManagementActor(req) {
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!actorUser || String(actorUser.estado || '').trim().toLowerCase() !== 'activo') {
    const error = new Error('Tu sesión ya no tiene permisos válidos para gestionar usuarios.');
    error.statusCode = 403;
    throw error;
  }
  if (!canManageUsersWithRole(actorUser)) {
    const error = new Error('Este usuario no tiene permiso para crear o editar cuentas.');
    error.statusCode = 403;
    throw error;
  }

  return actorUser;
}

async function getUserManagementRuntimeContext() {
  await ensureBusinessRulesExtensions();
  await ensureUserExtensions();
  const [configRows, branchRows, cashRegisterRows] = await Promise.all([
    query(`SELECT active_branch_id, business_structure_mode, cashier_register_required, exclusive_cashier_per_register, plan_code FROM config WHERE id = 1 LIMIT 1`),
    query('SELECT * FROM branches WHERE estado <> "Eliminada" ORDER BY id'),
    query('SELECT * FROM cash_registers WHERE estado <> "Eliminada" ORDER BY branch_id, id')
  ]);

  const config = configRows[0] || {};
  const terminalScope = getTerminalScopeSelection();
  const storedPlanCode = String(config.plan_code || 'basico').trim().toLowerCase() || 'basico';
  const derivedPlanCode = plans.planForMode(config.business_structure_mode) || 'basico';
  const rawActiveBranchId = Number(terminalScope.branchId || config.active_branch_id || 0) || null;
  const activeBranchId = (rawActiveBranchId && branchRows.some((b) => Number(b.id) === rawActiveBranchId))
    ? rawActiveBranchId
    : (Number(branchRows[0]?.id || 0) || null);
  return {
    planCode: (plans.PLAN_LEVELS[storedPlanCode] || 1) >= (plans.PLAN_LEVELS[derivedPlanCode] || 1)
      ? storedPlanCode
      : derivedPlanCode,
    mode: normalizeBusinessStructureMode(config.business_structure_mode) || 'monocaja',
    activeBranchId,
    cashierRegisterRequired: Boolean(config.cashier_register_required ?? 1),
    exclusiveCashierPerRegister: Boolean(config.exclusive_cashier_per_register ?? 1),
    branches: branchRows,
    cashRegisters: cashRegisterRows
  };
}

function getCashierLimitForPlanCode(planCode) {
  return String(planCode || 'basico').trim().toLowerCase() === 'basico' ? 3 : null;
}

async function ensureFirebaseIdentityAvailability(options = {}) {
  const businessName = String(options.businessName || '').trim();
  const username = String(options.username || '').trim();
  const email = String(options.email || '').trim().toLowerCase();
  if (!businessName && !username && !email) {
    return { checked: false, skipped: true, reason: 'missing_identity_values' };
  }
  return assertNoFirebaseIdentityConflicts({
    businessName,
    username,
    email,
    currentLicenseUid: String(options.currentLicenseUid || process.env.TECNO_CAJA_LICENSE_UID || '').trim(),
    currentFirebaseUid: String(options.currentFirebaseUid || '').trim(),
    currentLocalUserId: Number(options.currentLocalUserId || 0) || null,
    skipBusinessConflictCheck: options.skipBusinessConflictCheck === true,
  });
}

async function validateAndNormalizeUserPayload(data, actorUser, options = {}) {
  const existingUser = options.existingUser || null;
  const editingUserId = Number(existingUser?.id || 0) || 0;
  const runtime = await getUserManagementRuntimeContext();
  const role = await resolveRoleSelection(data.roleId || existingUser?.role_id, data.roleCode, data.rol || existingUser?.rol);
  const roleCode = normalizeLegacyUserRoleCode(role.codigo);
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(data || {}, key);
  const nombre = String(data.nombre || existingUser?.nombre || '').trim();
  const usuario = String(data.usuario || existingUser?.usuario || '').trim();
  const email = String(hasOwn('email') ? data.email : (existingUser?.email || '')).trim().toLowerCase() || null;
  const estado = String(hasOwn('estado') ? data.estado : (existingUser?.estado || 'Activo')).trim() || 'Activo';
  const telefono = String(hasOwn('telefono') ? data.telefono : (existingUser?.telefono || '')).trim() || null;
  const observacion = String(hasOwn('observacion') ? data.observacion : (existingUser?.observacion || '')).trim() || null;
  const tipoFacturacion = normalizeBillingFunctionType(
    hasOwn('billingType')
      ? data.billingType
      : (hasOwn('tipoFacturacion')
          ? data.tipoFacturacion
          : (existingUser?.tipo_facturacion || existingUser?.tipoFacturacion || 'mixta'))
  );
  const passwordInput = data.password === undefined ? '' : String(data.password ?? '');
  const actorBranchId = getUserBranchIdValue(actorUser);

  if (!nombre || !usuario) {
    const error = new Error('Nombre y usuario son obligatorios.');
    error.statusCode = 400;
    throw error;
  }
  if (!roleCode) {
    const error = new Error('Debes seleccionar un rol válido.');
    error.statusCode = 400;
    throw error;
  }
  if (!canAssignManagedRole(actorUser, roleCode)) {
    const error = new Error('No puedes crear o editar este tipo de usuario con tu alcance actual.');
    error.statusCode = 403;
    throw error;
  }
  if (!existingUser && passwordInput.length < 6) {
    const error = new Error('La contraseña debe tener al menos 6 caracteres.');
    error.statusCode = 400;
    throw error;
  }
  if (passwordInput && passwordInput.length < 6) {
    const error = new Error('La contraseña debe tener al menos 6 caracteres.');
    error.statusCode = 400;
    throw error;
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const error = new Error('El correo no tiene un formato válido.');
    error.statusCode = 400;
    throw error;
  }

  const duplicateUserRows = await query(
    'SELECT id FROM users WHERE usuario = ? AND id <> ? LIMIT 1',
    [usuario, editingUserId]
  );
  if (duplicateUserRows.length) {
    const error = new Error('Ya existe otro usuario con ese nombre de acceso.');
    error.statusCode = 409;
    throw error;
  }

  if (email) {
    const duplicateEmailRows = await query(
      'SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1',
      [email, editingUserId]
    );
    if (duplicateEmailRows.length) {
      const error = new Error('Ya existe otro usuario usando ese correo.');
      error.statusCode = 409;
      throw error;
    }
  }

  const businessNameRows = await query('SELECT business_name FROM config WHERE id = 1 LIMIT 1');
  await ensureFirebaseIdentityAvailability({
    businessName: businessNameRows[0]?.business_name || '',
    username: usuario,
    email,
    currentLocalUserId: editingUserId || null,
    currentFirebaseUid: existingUser?.firebase_uid || '',
    skipBusinessConflictCheck: true,
  });

  const cashierLimit = getCashierLimitForPlanCode(runtime.planCode);
  if (cashierLimit && roleCode === 'cajero' && String(estado).trim().toLowerCase() === 'activo') {
    const activeCashierRows = await query(
      `SELECT COUNT(*) AS total
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id <> ?
         AND u.estado = 'Activo'
         AND (COALESCE(r.codigo, '') = 'cajero' OR LOWER(COALESCE(u.rol, '')) = 'cajero')`,
      [editingUserId]
    );
    if (Number(activeCashierRows[0]?.total || 0) >= cashierLimit) {
      const planName = plans.PLAN_NAMES?.[runtime.planCode] || 'Tecno Caja Básico';
      const error = new Error(`El plan ${planName} permite hasta ${cashierLimit} cajeros activos.`);
      error.statusCode = 409;
      throw error;
    }
  }

  let sucursalId = null;
  if (roleNeedsBranchAssignment(roleCode)) {
    const requestedBranchId = hasOwn('branchId')
      ? data.branchId
      : (hasOwn('sucursalId') ? data.sucursalId : undefined);
    if (runtime.mode === 'multisucursal') {
      sucursalId = Number(requestedBranchId || existingUser?.sucursal_id || existingUser?.branch_id || actorBranchId || runtime.activeBranchId || 0) || null;
    } else {
      sucursalId = Number(runtime.activeBranchId || actorBranchId || existingUser?.sucursal_id || existingUser?.branch_id || 0) || null;
    }
  }

  if (sucursalId && !runtime.branches.some((branch) => Number(branch.id) === Number(sucursalId))) {
    const error = new Error('La sucursal asignada no existe.');
    error.statusCode = 404;
    throw error;
  }

  const actorRoleCode = normalizeLegacyUserRoleCode(actorUser?.role_code || actorUser?.rol);
  if (actorRoleCode !== 'administrador_general' && actorBranchId && Number(sucursalId || 0) !== Number(actorBranchId || 0)) {
    const error = new Error('No puedes crear usuarios fuera de tu sucursal.');
    error.statusCode = 403;
    throw error;
  }

  let cajaId = null;
  if (roleNeedsCashRegisterAssignment(roleCode)) {
    const availableRegisters = runtime.cashRegisters.filter((item) => Number(item.branch_id || 0) === Number(sucursalId || 0));
    const requestedCashRegisterId = hasOwn('cashRegisterId')
      ? data.cashRegisterId
      : (hasOwn('cajaId') ? data.cajaId : undefined);
    if (runtime.mode === 'monocaja') {
      cajaId = Number(availableRegisters[0]?.id || 0) || null;
    } else {
      cajaId = Number(requestedCashRegisterId || existingUser?.caja_id || 0) || null;
      if (!cajaId && availableRegisters.length === 1 && runtime.cashierRegisterRequired) {
        cajaId = Number(availableRegisters[0].id);
      }
    }

    if (!availableRegisters.length) {
      const error = new Error('La sucursal seleccionada no tiene cajas disponibles para asignar cajeros.');
      error.statusCode = 409;
      throw error;
    }
    if (!cajaId && runtime.cashierRegisterRequired) {
      const error = new Error('Debes asignar una caja al cajero.');
      error.statusCode = 400;
      throw error;
    }
    if (cajaId) {
      const selectedRegister = availableRegisters.find((item) => Number(item.id) === Number(cajaId));
      if (!selectedRegister) {
        const error = new Error('No puedes seleccionar una caja que pertenezca a otra sucursal.');
        error.statusCode = 400;
        throw error;
      }

      if (runtime.exclusiveCashierPerRegister) {
        const duplicateCashierRows = await query(
          `SELECT u.id, u.usuario
           FROM users u
           LEFT JOIN roles r ON r.id = u.role_id
           WHERE u.id <> ?
             AND u.estado = 'Activo'
             AND COALESCE(u.caja_id, 0) = ?
             AND (COALESCE(r.codigo, '') = 'cajero' OR LOWER(COALESCE(u.rol, '')) = 'cajero')
           LIMIT 1`,
          [editingUserId, cajaId]
        );
        if (duplicateCashierRows.length) {
          const error = new Error(`La caja seleccionada ya está asignada al cajero ${duplicateCashierRows[0].usuario}.`);
          error.statusCode = 409;
          throw error;
        }
      }
    }
  }

  const nextPassword = passwordInput || String(existingUser?.password || '');
  const nextPasswordHash = passwordInput
    ? createLocalPasswordHash(passwordInput)
    : (String(existingUser?.password_hash || '').trim() || (nextPassword ? createLocalPasswordHash(nextPassword) : null));

  return {
    role,
    roleCode,
    nombre,
    usuario,
    email,
    estado,
    telefono,
    observacion,
    tipoFacturacion,
    sucursalId,
    cajaId,
    password: nextPassword,
    passwordHash: nextPasswordHash
  };
}

function ensureNotCashier(req) {
  if (getRequestRoleCode(req) === 'cajero') {
    const error = new Error('Este usuario no tiene permiso para realizar esta acción.');
    error.statusCode = 403;
    throw error;
  }
}

function ensureAdministrator(req) {
  if (getRequestRoleCode(req) !== 'administrador_general') {
    const error = new Error('Solo el administrador puede realizar esta acción.');
    error.statusCode = 403;
    throw error;
  }
}

function mapRoleCodeToLegacyName(roleCode) {
  const normalized = String(roleCode || '').trim().toLowerCase();
  if (normalized === 'administrador_general') return 'Administrador';
  if (normalized === 'administrador_sucursal') return 'Administrador sucursal';
  if (normalized === 'supervisor') return 'Supervisor';
  if (normalized === 'cajero') return 'Cajero';
  if (normalized === 'repartidor') return 'Repartidor';
  return 'Cajero';
}

async function resolveRoleSelection(inputRoleId, inputRoleCode, inputRoleLabel) {
  await ensureRolesTable();
  let rows = [];
  const roleId = Number(inputRoleId || 0) || 0;
  if (roleId) {
    rows = await query('SELECT * FROM roles WHERE id = ? LIMIT 1', [roleId]);
  } else if (String(inputRoleCode || '').trim()) {
    rows = await query('SELECT * FROM roles WHERE codigo = ? LIMIT 1', [String(inputRoleCode).trim()]);
  } else if (String(inputRoleLabel || '').trim()) {
    const normalized = String(inputRoleLabel || '').trim().toLowerCase();
    const inferredCode = normalized === 'administrador'
      ? 'administrador_general'
      : normalized === 'administrador sucursal'
        ? 'administrador_sucursal'
        : normalized === 'supervisor'
          ? 'supervisor'
          : 'cajero';
    rows = await query('SELECT * FROM roles WHERE codigo = ? LIMIT 1', [inferredCode]);
  }

  const role = rows[0] || null;
  if (!role) {
    const error = new Error('El rol seleccionado no existe.');
    error.statusCode = 404;
    throw error;
  }

  return {
    id: Number(role.id),
    codigo: String(role.codigo || '').trim(),
    nombre: String(role.nombre || '').trim(),
    legacyLabel: mapRoleCodeToLegacyName(role.codigo)
  };
}

async function recalculateCashAmount(conn = null) {
  const executor = conn || { query };
  const rows = await executor.query('SELECT COALESCE(SUM(total), 0) AS total FROM sales');
  const total = Number(rows[0]?.total || 0);
  await executor.query('UPDATE config SET cash_amount = ? WHERE id = 1', [total]);
  return total;
}

async function getSecurityPassword() {
  await ensureConfigExtensions();
  const rows = await query('SELECT security_password FROM config WHERE id = 1 LIMIT 1');
  return String(rows[0]?.security_password || DEFAULT_SECURITY_PASSWORD);
}

async function getSetupStatus() {
  await ensureConfigExtensions();
  await ensureUserExtensions();
  const licenseResult = await secureLicenseService.resolveState({ allowRemote: true });
  const [configRows, userCountRows] = await Promise.all([
    query('SELECT * FROM config WHERE id = 1 LIMIT 1'),
    query('SELECT COUNT(*) AS total FROM users')
  ]);
  const row = configRows[0];
  const license = licenseResult?.license || getLicenseSummary(row || {});
  const hasUsers = Number(userCountRows[0]?.total || 0) > 0;

  // ── Lógica de setup_completed ──────────────────────────────────────────────
  // setup_completed = 1 es la señal autoritativa: el sistema fue configurado
  // (ya sea mediante el asistente o mediante una restauración de respaldo).
  //
  // CAMBIO vs versión anterior:
  //  Antes: setupCompleted = Boolean(setup_completed) && hasUsers
  //  Problema: si los usuarios no se restauraron correctamente, hasUsers = false
  //            causaba setupRequired = true y el asistente volvía a mostrarse,
  //            borrando la configuración restaurada en un loop infinito.
  //
  //  Ahora: setupCompleted = Boolean(setup_completed)  ← setup_completed es autoritativo
  //         setupCorrupted  = setup_completed pero sin usuarios  ← señal de error
  //         La UI maneja setupCorrupted mostrando un error, NO el asistente de configuración.
  const setupCompleted = Boolean(row?.setup_completed);

  // setupCorrupted: config dice "completado" pero no hay usuarios.
  // Indica un problema post-restauración (datos incompletos) o corrupción.
  // La UI debe mostrar un mensaje de error/reparación, NUNCA el asistente inicial.
  const setupCorrupted = setupCompleted && !hasUsers;

  if (setupCorrupted) {
    console.warn('[setup] ⚠ setup_completed=1 pero users está vacío. Posible restauración incompleta.');
  }

  return {
    setupRequired: !setupCompleted,
    setupCompleted,
    setupCorrupted,   // nuevo: true = configurado pero sin usuarios (error a mostrar en UI)
    hasUsers,
    config: await getConfig({ syncRemote: false, licenseResult }),
    license,
    businessTypes: listBusinessTypes(),
    languages: LANGUAGE_OPTIONS,
    currencies: CURRENCY_OPTIONS
  };
}

async function buildBackupPayload() {
  await ensureAuditTable();
  await ensureCategoriesTable();
  await ensureConfigExtensions();
  await ensureUserExtensions();
  await ensureProductExtensions();
  await ensureClientExtensions();
  await ensureSalesExtensions();
  await ensureSuppliersTable();
  await ensureSupplierInvoicesTable();
  await ensureDiningTables();
  await ensureDeliveryTrackingTable();
  await ensureSuspendedSalesTable();
  await ensureQuotationsTable();
  const config = await getConfig();
  if (config.setupCompleted) {
    await ensureBusinessStarterCatalog(config.tipoNegocio || 'pizzeria');
  }

  const [configRows, userRows, categoryRows, productRows, clientRows, supplierRows, supplierInvoiceRows, cashSessionRows, cashMovementRows, saleRows, saleItemRows, auditRows, diningTableRows, deliveryLocationRows, suspendedSaleRows, quotationRows] = await Promise.all([
    query('SELECT * FROM config ORDER BY id'),
    query('SELECT * FROM users ORDER BY id'),
    query('SELECT * FROM categories ORDER BY id'),
    query('SELECT * FROM products ORDER BY id'),
    query('SELECT * FROM clients ORDER BY id'),
    query('SELECT * FROM suppliers ORDER BY id'),
    query('SELECT * FROM supplier_invoices ORDER BY id'),
    query('SELECT * FROM cash_sessions ORDER BY id'),
    query('SELECT * FROM cash_movements ORDER BY id'),
    query('SELECT * FROM sales ORDER BY id'),
    query('SELECT * FROM sale_items ORDER BY id'),
    query('SELECT * FROM audit_logs ORDER BY id'),
    query('SELECT * FROM dining_tables ORDER BY id'),
    query('SELECT * FROM delivery_locations ORDER BY id'),
    query('SELECT * FROM suspended_sales ORDER BY created_at DESC, updated_at DESC'),
    query('SELECT * FROM quotations ORDER BY created_at DESC, updated_at DESC')
  ]);

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      config: configRows,
      users: userRows,
      categories: categoryRows,
      products: productRows,
      clients: clientRows,
      suppliers: supplierRows,
      supplierInvoices: supplierInvoiceRows,
      cashSessions: cashSessionRows,
      cashMovements: cashMovementRows,
      sales: saleRows,
      saleItems: saleItemRows,
      auditLogs: auditRows,
      diningTables: diningTableRows,
      deliveryLocations: deliveryLocationRows,
      suspendedSales: suspendedSaleRows,
      quotations: quotationRows
    }
  };
}

function getSecureBackupFilePath() {
  return path.join(SECURE_BACKUP_DIR, SECURE_BACKUP_FILE);
}

// Cifrado/descifrado de respaldos (extraído a server/security/backup-crypto.js).
// Los wrappers mantienen la firma con default = DEFAULT_SECURITY_PASSWORD para
// no romper callers existentes dentro de server.js.
const backupCrypto = require('./server/security/backup-crypto');

function encryptBackupPayload(payload, password = DEFAULT_SECURITY_PASSWORD) {
  return backupCrypto.encryptBackupPayload(payload, password);
}

function decryptBackupPayload(encryptedContent, password = DEFAULT_SECURITY_PASSWORD) {
  return backupCrypto.decryptBackupPayload(encryptedContent, password);
}

function normalizeDateTime(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return formatSqlDateTimeLocal(value);
  }
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    return text;
  }
  const parsed = parseStoredDateTime(text);
  if (parsed) {
    return formatSqlDateTimeLocal(parsed);
  }
  return text.includes('T') ? text.slice(0, 19).replace('T', ' ') : text;
}

async function saveLatestSecureBackup() {
  const payload = await buildBackupPayload();
  const securityPassword = await getSecurityPassword();
  fs.mkdirSync(SECURE_BACKUP_DIR, { recursive: true });
  for (const entry of fs.readdirSync(SECURE_BACKUP_DIR)) {
    fs.rmSync(path.join(SECURE_BACKUP_DIR, entry), { force: true, recursive: true });
  }
  const encrypted = encryptBackupPayload(payload, securityPassword);
  const backupPath = getSecureBackupFilePath();
  fs.writeFileSync(backupPath, encrypted, 'utf8');
  return {
    fileName: SECURE_BACKUP_FILE,
    backupPath,
    exportedAt: payload.exportedAt
  };
}

async function restoreLatestSecureBackup(password) {
  const currentPassword = await getSecurityPassword();
  if (password !== currentPassword) {
    const error = new Error('Clave de seguridad incorrecta.');
    error.statusCode = 403;
    throw error;
  }

  const backupPath = getSecureBackupFilePath();
  if (!fs.existsSync(backupPath)) {
    const error = new Error('No existe una copia segura disponible para restaurar.');
    error.statusCode = 404;
    throw error;
  }

  const encrypted = fs.readFileSync(backupPath, 'utf8');
  const payload = decryptBackupPayload(encrypted, password);
  await restoreBackupPayload(payload);
  return {
    fileName: SECURE_BACKUP_FILE,
    restoredAt: new Date().toISOString()
  };
}

function escapeSqlTableIdentifier(identifier) {
  return `\`${String(identifier || '').replace(/`/g, '``')}\``;
}

async function setForeignKeyChecks(conn, enabled) {
  if (getDbClient() === 'mysql') {
    await conn.query(`SET FOREIGN_KEY_CHECKS = ${enabled ? 1 : 0}`);
    return;
  }
  await conn.query(`PRAGMA foreign_keys = ${enabled ? 'ON' : 'OFF'}`);
}

async function listCurrentTableNames(conn) {
  if (getDbClient() === 'mysql') {
    const rows = await conn.query('SHOW TABLES');
    return rows
      .map((row) => String(Object.values(row || {})[0] || '').trim().toLowerCase())
      .filter(Boolean);
  }

  const rows = await conn.query("SELECT name FROM sqlite_master WHERE type = 'table'");
  return rows
    .map((row) => String(row.name || '').trim().toLowerCase())
    .filter((name) => Boolean(name) && name !== 'sqlite_sequence');
}

async function seedFactoryResetDefaults(conn) {
  await conn.query(
    `INSERT INTO businesses (id, nombre, rnc, direccion, telefono, estado)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [1, 'Tecno Caja', '', '', '', 'Activo']
  );

  await conn.query(
    `INSERT INTO branches (id, business_id, nombre, codigo, direccion, telefono, encargado, estado)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [1, 1, 'Sucursal Principal', 'PRINCIPAL', '', '', 'Administrador', 'Activa']
  );

  await conn.query(
    `INSERT INTO cash_registers (id, branch_id, nombre, codigo, estado)
     VALUES (?, ?, ?, ?, ?)`,
    [1, 1, 'Caja Principal', 'CAJA-01', 'Activa']
  );

  const defaultRoles = [
    [1, 'administrador_general', 'Administrador general', '["*"]', 'Activo'],
    [2, 'administrador_sucursal', 'Administrador de sucursal', '["dashboard_sucursal","ver_dashboard_sucursal","caja","cajas","ver_cajas_sucursal","crear_cajas_sucursal","editar_cajas_sucursal","activar_cajas_sucursal","asignar_cajeros_sucursal","usuarios","usuarios_crear","usuarios_editar","ver_usuarios_sucursal","crear_cajeros_sucursal","crear_supervisores_sucursal","editar_usuarios_sucursal","activar_usuarios_sucursal","resetear_password_usuarios_sucursal","ventas","ver_ventas_sucursal","ver_cierres_caja_sucursal","ver_aperturas_caja_sucursal","reportes_sucursal","ver_reportes_sucursal","inventario","ver_inventario_sucursal","registrar_movimientos_internos_sucursal","ver_productos_sucursal","consultar_stock_sucursal","ver_arqueos_caja_sucursal","ver_historial_inventario_sucursal"]', 'Activo'],
    [3, 'cajero', 'Cajero', '["ventas","caja","clientes"]', 'Activo'],
    [4, 'supervisor', 'Supervisor', '["ventas","caja","reportes_sucursal","inventario"]', 'Activo']
  ];
  for (const [id, codigo, nombre, permisos, estado] of defaultRoles) {
    await conn.query(
      `INSERT INTO roles (id, codigo, nombre, permisos, estado)
       VALUES (?, ?, ?, ?, ?)`,
      [id, codigo, nombre, permisos, estado]
    );
  }

  const defaultPaymentMethods = [
    [1, 'efectivo', 'Efectivo', 'Activo'],
    [2, 'tarjeta', 'Tarjeta', 'Activo'],
    [3, 'transferencia', 'Transferencia', 'Activo'],
    [4, 'credito', 'Crédito', 'Activo'],
    [5, 'contra_entrega', 'Contra entrega', 'Activo']
  ];
  for (const [id, codigo, nombre, estado] of defaultPaymentMethods) {
    await conn.query(
      `INSERT INTO payment_methods (id, codigo, nombre, estado)
       VALUES (?, ?, ?, ?)`,
      [id, codigo, nombre, estado]
    );
  }

  await conn.query(
    `INSERT INTO config (
      id, business_id, active_branch_id, active_cash_register_id, business_name, rnc, address, phone, currency, tax_rate,
      invoice_prefix, invoice_next_number, e_invoice_enabled, e_invoice_prefix, e_invoice_next_number, receipt_message,
      receipt_print_mode, receipt_printer_name, receipt_paper_size,
      cash_drawer_enabled, cash_drawer_method, cash_drawer_printer_name, cash_drawer_pin, cash_drawer_network_host, cash_drawer_network_port, cash_drawer_serial_port,
      scale_type, scale_serial_port, scale_serial_baud_rate, scale_default_unit, scale_read_pattern, scale_rounding_decimals, scale_auto_read,
      whatsapp_web_enabled, whatsapp_paste_guide_enabled,
      app_logo, security_password, language, business_type, setup_completed, license_status, require_cash_open_before_use,
      business_structure_mode, sales_operation_mode, starter_catalog_seeded, cash_open, cash_amount,
      cashier_register_required, exclusive_cashier_per_register
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?
    )`,
    [
      1, 1, 1, 1, 'Tecno Caja', '', '', '', 'RD$', 18.00,
      'FAC-', 1001, 1, 'ECF-', 1, '¡Gracias por su compra!',
      'dialog', null, '80mm',
      0, 'escpos', null, 0, null, 9100, 'COM1',
      'none', null, 9600, 'kg', null, 2, 1,
      0, 1,
      null, DEFAULT_SECURITY_PASSWORD, 'es', 'pizzeria', 0, 'trial', 1,
      'monocaja', 'directa', 1, 0, 0,
      1, 1
    ]
  );
}

async function resetSystemData({ keepUserId = null, factoryReset = false } = {}) {
  await ensureAuditTable();
  await ensureRolesTable();
  await ensureBranchesTable();
  await ensureCategoriesTable();
  await ensureConfigExtensions();
  await ensureUserExtensions();
  await ensureProductExtensions();
  await ensureClientExtensions();
  await ensureSalesExtensions();
  await ensureSuppliersTable();
  await ensureSupplierInvoicesTable();
  await ensureDiningTables();
  await ensureDeliveryTrackingTable();
  await ensureSuspendedSalesTable();
  await ensureQuotationsTable();
  await ensureSessionTables();
  await ensureBusinessRulesExtensions();
  await ensureNcfExtensions();
  await ensureMobileTables(query);
  await plans.ensurePlanExtensions(query);

  await withTransaction(async (conn) => {
    await setForeignKeyChecks(conn, false);
    try {
      if (factoryReset) {
        const tableNames = await listCurrentTableNames(conn);
        for (const tableName of tableNames) {
          await conn.query(`DELETE FROM ${escapeSqlTableIdentifier(tableName)}`);
        }
        if (getDbClient() !== 'mysql') {
          await conn.query('DELETE FROM sqlite_sequence').catch(() => {});
        }
        await seedFactoryResetDefaults(conn);
        return;
      }

      await conn.query('DELETE FROM audit_logs');
      await conn.query('DELETE FROM sale_items');
      await conn.query('DELETE FROM sales');
      await conn.query('DELETE FROM cash_movements');
      await conn.query('DELETE FROM cash_sessions');
      await conn.query('DELETE FROM supplier_invoices');
      await conn.query('DELETE FROM suppliers');
      await conn.query('DELETE FROM clients');
      await conn.query('DELETE FROM products');
      await conn.query('DELETE FROM categories');
      await conn.query('DELETE FROM suspended_sales');
      await conn.query('DELETE FROM quotations');
      if (keepUserId) {
        await conn.query('DELETE FROM users WHERE id <> ?', [keepUserId]);
        await conn.query('UPDATE users SET last_login = "—", estado = "Activo" WHERE id = ?', [keepUserId]);
      } else {
        await conn.query('DELETE FROM users');
      }
      await conn.query(
        `UPDATE config
         SET cash_open = 0,
             cash_amount = 0,
             invoice_next_number = 1001,
             e_invoice_next_number = 1,
             starter_catalog_seeded = 1`
      );
    } finally {
      await setForeignKeyChecks(conn, true);
    }
  });

  if (factoryReset) {
    await ensureConfigExtensions();
  }
}

async function restoreBackupPayload(backup) {
  const data = backup?.data || backup;
  if (!data || !Array.isArray(data.config) || !Array.isArray(data.users)) {
    const error = new Error('La copia de seguridad no tiene un formato válido.');
    error.statusCode = 400;
    throw error;
  }

  await ensureAuditTable();
  await ensureCategoriesTable();
  await ensureConfigExtensions();
  await ensureSalesExtensions();
  await ensureSuppliersTable();
  await ensureSupplierInvoicesTable();
  await ensureSuspendedSalesTable();
  await ensureQuotationsTable();

  await withTransaction(async (conn) => {
    await conn.query('PRAGMA foreign_keys = OFF');
    try {
      await conn.query('DELETE FROM audit_logs');
      await conn.query('DELETE FROM sale_items');
      await conn.query('DELETE FROM sales');
      await conn.query('DELETE FROM cash_movements');
      await conn.query('DELETE FROM cash_sessions');
      await conn.query('DELETE FROM supplier_invoices');
      await conn.query('DELETE FROM suppliers');
      await conn.query('DELETE FROM clients');
      await conn.query('DELETE FROM products');
      await conn.query('DELETE FROM categories');
      await conn.query('DELETE FROM suspended_sales');
      await conn.query('DELETE FROM quotations');
      await conn.query('DELETE FROM dining_tables');
      await conn.query('DELETE FROM delivery_locations');
      await conn.query('DELETE FROM users');
      await conn.query('DELETE FROM config');

      for (const row of data.config || []) {
        await conn.query(
          `INSERT INTO config
            (id, business_name, rnc, address, phone, currency, tax_rate, invoice_prefix, invoice_next_number, e_invoice_enabled, e_invoice_prefix, e_invoice_next_number, receipt_message, receipt_print_mode, receipt_printer_name, receipt_paper_size, cash_open, cash_amount, app_logo, security_password, language, business_type, business_structure_mode, sales_operation_mode, sales_split_view_enabled, starter_catalog_seeded, setup_completed, setup_completed_at, trial_started_at, trial_ends_at, license_status, license_activated_at, license_activated_by, require_cash_open_before_use)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id,
            row.business_name,
            row.rnc,
            row.address,
            row.phone,
            row.currency,
            row.tax_rate,
            row.invoice_prefix,
            row.invoice_next_number,
            row.e_invoice_enabled,
            row.e_invoice_prefix,
            row.e_invoice_next_number,
            row.receipt_message,
            row.receipt_print_mode || 'dialog',
            row.receipt_printer_name || null,
            row.receipt_paper_size || '80mm',
            row.cash_open,
            row.cash_amount,
            row.app_logo || null,
            row.security_password || DEFAULT_SECURITY_PASSWORD,
            row.language || 'es',
            row.business_type || 'pizzeria',
            normalizeBusinessStructureMode(row.business_structure_mode) || 'monocaja',
            row.sales_operation_mode || 'directa',
            row.sales_split_view_enabled === undefined ? (row.salesSplitViewEnabled ? 1 : 0) : (row.sales_split_view_enabled ? 1 : 0),
            row.starter_catalog_seeded === undefined ? 1 : (row.starter_catalog_seeded ? 1 : 0),
            row.setup_completed ? 1 : 0,
            normalizeDateTime(row.setup_completed_at),
            normalizeDateTime(row.trial_started_at),
            normalizeDateTime(row.trial_ends_at),
            row.license_status || 'trial',
            normalizeDateTime(row.license_activated_at),
            row.license_activated_by || null,
            row.require_cash_open_before_use === undefined ? 1 : (row.require_cash_open_before_use ? 1 : 0)
          ]
        );
      }
      for (const row of data.users || []) {
        await conn.query(
          `INSERT INTO users
            (id, usuario, email, password, password_hash, nombre, rol, role_id, branch_id, sucursal_id, caja_id, telefono, observacion, creado_por, fecha_creacion, estado, last_login, linked_client_id, account_type, auth_provider, firebase_uid)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id,
            row.usuario,
            row.email || null,
            row.password || '',
            row.password_hash || (row.password ? createLocalPasswordHash(row.password) : null),
            row.nombre,
            row.rol,
            row.role_id ?? null,
            row.branch_id ?? row.sucursal_id ?? null,
            row.sucursal_id ?? row.branch_id ?? null,
            row.caja_id ?? null,
            row.telefono || null,
            row.observacion || null,
            row.creado_por ?? null,
            normalizeDateTime(row.fecha_creacion),
            row.estado,
            normalizeDateTime(row.last_login),
            row.linked_client_id ?? null,
            row.account_type || 'staff',
            row.auth_provider || 'local',
            row.firebase_uid || null
          ]
        );
      }
      for (const row of data.categories || []) {
        await conn.query('INSERT INTO categories (id, nombre, created_at) VALUES (?, ?, ?)', [row.id, row.nombre, normalizeDateTime(row.created_at)]);
      }
      for (const row of data.products || []) {
        await conn.query(
          `INSERT INTO products (id, codigo, nombre, categoria, marca, unidad, precio_compra, precio_venta, stock, stock_min, estado, image_url, image_local, product_type, size_options, dough_options, border_options, extra_options, allow_half_and_half, is_combo, preparation_time_minutes, business_metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.id, row.codigo, row.nombre, row.categoria, row.marca, row.unidad, row.precio_compra, row.precio_venta, row.stock, row.stock_min, row.estado, row.image_url || null, row.image_local || null, row.product_type || 'general', row.size_options || null, row.dough_options || null, row.border_options || null, row.extra_options || null, row.allow_half_and_half || 0, row.is_combo || 0, row.preparation_time_minutes || 15, row.business_metadata || null]
        );
      }
      for (const row of data.clients || []) {
        await conn.query(
          `INSERT INTO clients
            (id, nombre, telefono, email, direccion, cedula, limite_credito, balance, reference_note, location_link, latitude, longitude)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id,
            row.nombre,
            row.telefono,
            row.email || null,
            row.direccion,
            row.cedula,
            row.limite_credito,
            row.balance,
            row.reference_note || null,
            row.location_link || null,
            row.latitude ?? null,
            row.longitude ?? null
          ]
        );
      }
      for (const row of data.suppliers || []) {
        await conn.query(
          `INSERT INTO suppliers (id, nombre, empresa, telefono, email, rnc, contacto, direccion, visit_days, payment_terms_days, estado, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.id, row.nombre, row.empresa, row.telefono, row.email, row.rnc, row.contacto, row.direccion, row.visit_days, row.payment_terms_days, row.estado, normalizeDateTime(row.created_at)]
        );
      }
      for (const row of data.supplierInvoices || []) {
        await conn.query(
          `INSERT INTO supplier_invoices (id, supplier_id, invoice_number, issued_at, due_at, total_amount, paid_amount, pending_amount, status, notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.id, row.supplier_id, row.invoice_number, normalizeDateTime(row.issued_at), normalizeDateTime(row.due_at), row.total_amount, row.paid_amount, row.pending_amount, row.status, row.notes, normalizeDateTime(row.created_at)]
        );
      }
      for (const row of data.cashSessions || []) {
        await conn.query(
          `INSERT INTO cash_sessions (id, opened_amount, closed_amount, opened_at, closed_at, status)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [row.id, row.opened_amount, row.closed_amount, normalizeDateTime(row.opened_at), normalizeDateTime(row.closed_at), row.status]
        );
      }
      await ensureCashMovementExtensions();
      for (const row of data.cashMovements || []) {
        await conn.query(
          `INSERT INTO cash_movements (id, session_id, movement_type, amount, notes, created_by_user_id, created_by_user_name, happened_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.id, row.session_id, row.movement_type, row.amount, row.notes, row.created_by_user_id || null, row.created_by_user_name || null, normalizeDateTime(row.happened_at)]
        );
      }
      for (const row of data.sales || []) {
        await conn.query(
          `INSERT INTO sales (id, invoice_number, user_id, client_id, document_type, client_name_snapshot, client_phone_snapshot, client_tax_id_snapshot, payment_method, subtotal, discount, tax, total, received_amount, change_amount, fiscal_status, fiscal_payload, created_at, order_type, kitchen_status, delivery_user_id, delivery_name_snapshot, delivery_email_snapshot, delivery_phone_snapshot, delivery_address_snapshot, delivery_reference_snapshot, delivery_location_link_snapshot, table_label, order_notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.id, row.invoice_number, row.user_id, row.client_id, row.document_type, row.client_name_snapshot, row.client_phone_snapshot || null, row.client_tax_id_snapshot, row.payment_method, row.subtotal, row.discount, row.tax, row.total, row.received_amount, row.change_amount, row.fiscal_status, row.fiscal_payload, normalizeDateTime(row.created_at), row.order_type || 'mostrador', row.kitchen_status || 'pendiente', row.delivery_user_id || null, row.delivery_name_snapshot || null, row.delivery_email_snapshot || null, row.delivery_phone_snapshot || null, row.delivery_address_snapshot || null, row.delivery_reference_snapshot || null, row.delivery_location_link_snapshot || null, row.table_label || null, row.order_notes || null]
        );
      }
      for (const row of data.saleItems || []) {
        await conn.query(
          `INSERT INTO sale_items (id, sale_id, product_id, qty, price, discount_rate, tax_rate, sale_mode, unit_label, weight_unit, scale_weight, scale_measured_value, scale_measured_unit, scale_source, scale_raw_reading, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id,
            row.sale_id,
            row.product_id,
            row.qty,
            row.price,
            row.discount_rate,
            row.tax_rate,
            row.sale_mode || 'unidad',
            row.unit_label || 'Unidad',
            row.weight_unit || null,
            row.scale_weight ?? null,
            row.scale_measured_value ?? null,
            row.scale_measured_unit || null,
            row.scale_source || null,
            row.scale_raw_reading || null,
            row.line_total
          ]
        );
      }
      for (const row of data.auditLogs || []) {
        await conn.query(
          `INSERT INTO audit_logs (id, user_id, user_name, user_role, module_name, action_name, detail, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.id, row.user_id, row.user_name, row.user_role, row.module_name, row.action_name, row.detail, normalizeDateTime(row.created_at)]
        );
      }
      for (const row of data.diningTables || []) {
        await conn.query(
          'INSERT INTO dining_tables (id, nombre, capacidad, estado, created_at) VALUES (?, ?, ?, ?, ?)',
          [row.id, row.nombre, row.capacidad, row.estado, normalizeDateTime(row.created_at)]
        );
      }
      for (const row of data.deliveryLocations || []) {
        await conn.query(
          'INSERT INTO delivery_locations (id, session_id, user_id, user_name, latitude, longitude, accuracy_meters, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [row.id, row.session_id || null, row.user_id || null, row.user_name || null, row.latitude, row.longitude, row.accuracy_meters ?? null, row.source || 'mobile', normalizeDateTime(row.created_at), normalizeDateTime(row.updated_at)]
        );
      }
      for (const row of data.suspendedSales || []) {
        await conn.query(
          'INSERT INTO suspended_sales (id, sale_name, draft_payload, total, item_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [row.id, row.sale_name, row.draft_payload, row.total, row.item_count, normalizeDateTime(row.created_at), normalizeDateTime(row.updated_at)]
        );
      }
      for (const row of data.quotations || []) {
        await conn.query(
          'INSERT INTO quotations (id, quotation_name, client_name, draft_payload, total, item_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [row.id, row.quotation_name, row.client_name, row.draft_payload, row.total, row.item_count, normalizeDateTime(row.created_at), normalizeDateTime(row.updated_at)]
        );
      }

      await recalculateCashAmount(conn);
    } finally {
      await conn.query('PRAGMA foreign_keys = ON');
    }
  });
}

function mapSaleRows(sales, items) {
  return sales.map((sale) => {
    let fiscalPayload = {};
    try {
      fiscalPayload = sale.fiscal_payload ? JSON.parse(sale.fiscal_payload) : {};
    } catch (_error) {
      fiscalPayload = {};
    }
    const estadoDgii = sale.ecf_estado || fiscalPayload.ecfEstado || '';

    return ({
    id: sale.invoice_number,
    ventaId: sale.id === null || sale.id === undefined ? null : Number(sale.id),
    cashSessionId: sale.cash_session_id === null || sale.cash_session_id === undefined ? null : Number(sale.cash_session_id),
    operativeDate: sale.operative_date || null,
    clientId: sale.client_id === null || sale.client_id === undefined ? null : Number(sale.client_id),
    sucursalId: sale.branch_id === null || sale.branch_id === undefined ? null : Number(sale.branch_id),
    cajaSucursalId: sale.cash_register_id === null || sale.cash_register_id === undefined ? null : Number(sale.cash_register_id),
    sucursalFacturoId: sale.billed_branch_id === null || sale.billed_branch_id === undefined ? null : Number(sale.billed_branch_id),
    cajaFacturoId: sale.billed_cash_register_id === null || sale.billed_cash_register_id === undefined ? null : Number(sale.billed_cash_register_id),
    usuarioFacturoId: sale.billed_by_user_id === null || sale.billed_by_user_id === undefined ? null : Number(sale.billed_by_user_id),
    sucursalCobroId: sale.charged_branch_id === null || sale.charged_branch_id === undefined ? null : Number(sale.charged_branch_id),
    cajaCobroId: sale.charged_cash_register_id === null || sale.charged_cash_register_id === undefined ? null : Number(sale.charged_cash_register_id),
    usuarioCobroId: sale.charged_by_user_id === null || sale.charged_by_user_id === undefined ? null : Number(sale.charged_by_user_id),
    sucursalInventarioId: sale.inventory_branch_id === null || sale.inventory_branch_id === undefined ? null : Number(sale.inventory_branch_id),
    fecha: sale.created_at,
    cajero: sale.cashier_name,
    cliente: sale.client_name_snapshot || sale.client_name || 'Consumidor Final',
    clienteTelefono: sale.client_phone_snapshot || sale.client_phone || '',
    clienteRncCedula: sale.client_tax_id_snapshot || '',
    metodo: sale.payment_method,
    estadoCobroDelivery: sale.delivery_cash_status || 'na',
    cobroDeliveryValidadoEn: sale.delivery_cash_received_at || null,
    cobroDeliveryValidadoPor: sale.delivery_cash_received_by_user_name || '',
    tipoComprobante: sale.document_type || 'ticket',
    estadoFiscal: sale.fiscal_status || 'emitida',
    estadoDgii,
    estadoVenta: sale.sale_status || 'pagada',
    modoVenta: sale.sale_mode || 'directa',
    cobradaEn: sale.charged_at || null,
    inventarioDescontadoEn: sale.inventory_discounted_at || null,
    cancelada: (sale.fiscal_status || '') === 'cancelada',
    motivoCancelacion: sale.cancel_reason || '',
    canceladaPor: sale.canceled_by_user_name || '',
    canceladaEn: sale.canceled_at || null,
    tipoPedido: sale.order_type || 'mostrador',
    estadoCocina: sale.kitchen_status || 'pendiente',
    repartidorId: sale.delivery_user_id || null,
    repartidor: sale.delivery_name_snapshot || '',
    repartidorCorreo: sale.delivery_email_snapshot || '',
    telefonoDelivery: sale.delivery_phone_snapshot || '',
    direccionDelivery: sale.delivery_address_snapshot || '',
    referenciaDelivery: sale.delivery_reference_snapshot || '',
    linkUbicacionDelivery: sale.delivery_location_link_snapshot || '',
    mesa: sale.table_label || '',
    notasPedido: sale.order_notes || '',
    codigoSeguridadFiscal: String(fiscalPayload.codigoSeguridad || '').trim(),
    fiscalFechaIso: String(fiscalPayload.fecha || '').trim(),
    // NCF fields
    ncf: sale.ncf || '',
    ncfType: sale.ncf_type || '',
    ncfLabel: NCF_LABELS[sale.ncf_type] || '',
    ncfReferencia: sale.ncf_referencia || '',
    encf: sale.encf || sale.ncf || '',
    tipoEcf: sale.tipo_ecf || fiscalPayload.tipoEcf || '',
    ecfDocumentId: sale.ecf_document_id === null || sale.ecf_document_id === undefined ? null : Number(sale.ecf_document_id),
    ecfTrackId: sale.ecf_track_id || '',
    qrUrl: sale.qr_data || '',
    rncEmisor: fiscalPayload.rncEmisor || '',
    facturaReferenciaId: sale.factura_referencia_id || null,
    razonSocialCliente: sale.razon_social_cliente || '',
    esElectronica: !!sale.es_electronica,
    fechaEmisionFiscal: sale.fecha_emision_fiscal || null,
    pdfPath: sale.pdf_path || null,
    items: items
      .filter((item) => item.sale_id === sale.id)
      .map((item) => ({
        id: item.product_id,
        nombre: item.product_name,
        qty: Number(item.qty || 0),
        precio: Number(item.price || 0),
        itbis: Number(item.tax_rate || 0),
        total: Number(item.line_total || 0),
        saleMode: normalizeProductSaleMode(item.sale_mode),
        unitLabel: item.unit_label || 'Unidad',
        weightUnit: item.weight_unit || '',
        scaleWeight: item.scale_weight === null || item.scale_weight === undefined ? null : Number(item.scale_weight),
        scaleMeasuredValue: item.scale_measured_value === null || item.scale_measured_value === undefined ? null : Number(item.scale_measured_value),
        scaleMeasuredUnit: item.scale_measured_unit || '',
        scaleSource: item.scale_source || '',
        scaleRawReading: item.scale_raw_reading || ''
      })),
    subtotal: Number(sale.subtotal || 0),
    descuento: Number(sale.discount || 0),
    itbis: Number(sale.tax || 0),
    total: Number(sale.total || 0),
    recibido: Number(sale.received_amount || 0),
    cambio: Number(sale.change_amount || 0)
  })});
}

async function getConfig(options = {}) {
  await ensureBusinessStructureExtensions();
  const licenseResult = options.licenseResult || await secureLicenseService.resolveState({
    force: Boolean(options.forceLicenseSync),
    allowRemote: options.syncRemote !== false,
  });

  // Sincronizar plan_code con business_structure_mode si hay desajuste
  // (ej: usuario tiene Multisucursal pero plan_code quedó como 'basico')
  await query(`
    UPDATE config
    SET plan_code = CASE business_structure_mode
                     WHEN 'multisucursal' THEN 'plus'
                     WHEN 'multicaja'     THEN 'pro'
                     ELSE plan_code
                   END,
        plan_name = CASE business_structure_mode
                     WHEN 'multisucursal' THEN 'Tecno Caja Plus'
                     WHEN 'multicaja'     THEN 'Tecno Caja Pro'
                     ELSE plan_name
                   END
    WHERE id = 1
      AND (plan_code IS NULL OR plan_code = 'basico')
      AND business_structure_mode IN ('multisucursal', 'multicaja')
  `).catch(() => {});

  const rows = await query('SELECT * FROM config WHERE id = 1 LIMIT 1');
  const row = rows[0];
  const license = licenseResult?.license || getLicenseSummary(row || {});
  const businessType = row.business_type || 'pizzeria';
  const structure = await getActiveBusinessStructure(row);
  const activeSessionRows = structure.activeCashRegisterId
    ? await query(
        'SELECT * FROM cash_sessions WHERE status = "open" AND cash_register_id = ? ORDER BY id DESC LIMIT 1',
        [structure.activeCashRegisterId]
      )
    : [];
  const activeSession = activeSessionRows[0] || null;
  return {
    nombre: row.business_name,
    logo: row.app_logo || '',
    rnc: row.rnc,
    direccion: row.address,
    telefono: row.phone,
    moneda: row.currency,
    itbis: Number(row.tax_rate ?? 18),
    taxCalculateAtInvoiceEnd: Boolean(row.tax_calculate_at_invoice_end ?? 1),
    taxIncludeInProductPrice: Boolean(row.tax_include_in_product_price ?? 0),
    taxShowBreakdownOnReceipts: Boolean(row.tax_show_breakdown_on_receipts ?? 1),
    taxSeparateTaxableAndExempt: Boolean(row.tax_separate_taxable_and_exempt ?? 1),
    prefix: row.invoice_prefix,
    nextInvoice: Number(row.invoice_next_number || 1001),
    eInvoiceEnabled: Boolean(row.e_invoice_enabled),
    eInvoicePrefix: row.e_invoice_prefix || 'ECF-',
    eInvoiceNextNumber: Number(row.e_invoice_next_number || 1),
    mensaje: row.receipt_message,
    receiptPrintMode: row.receipt_print_mode || 'dialog',
    receiptPrinterName: row.receipt_printer_name || '',
    receiptPaperSize: row.receipt_paper_size || '80mm',
    cashDrawerEnabled: Boolean(row.cash_drawer_enabled ?? 0),
    cashDrawerMethod: row.cash_drawer_method || 'escpos',
    cashDrawerPrinterName: row.cash_drawer_printer_name || '',
    cashDrawerPin: Number(row.cash_drawer_pin ?? 0),
    cashDrawerNetworkHost: row.cash_drawer_network_host || '',
    cashDrawerNetworkPort: Number(row.cash_drawer_network_port || 9100),
    cashDrawerSerialPort: row.cash_drawer_serial_port || 'COM1',
    scaleType: normalizeScaleType(row.scale_type),
    scaleSerialPort: row.scale_serial_port || '',
    scaleSerialBaudRate: Number(row.scale_serial_baud_rate || 9600),
    scaleDefaultUnit: normalizeScaleDefaultUnit(row.scale_default_unit),
    scaleReadPattern: row.scale_read_pattern || '',
    scaleRoundingDecimals: sanitizeScaleRoundingDecimals(row.scale_rounding_decimals),
    scaleAutoRead: Boolean(row.scale_auto_read ?? 1),
    whatsappWebEnabled: Boolean(row.whatsapp_web_enabled),
    whatsappPasteGuideEnabled: Boolean(row.whatsapp_paste_guide_enabled ?? 1),
    salesSplitViewEnabled: Boolean(row.sales_split_view_enabled ?? 0),
    idioma: row.language || 'es',
    tipoNegocio: businessType,
    businessStructureMode: normalizeBusinessStructureMode(row.business_structure_mode) || 'monocaja',
    cashierRegisterRequired: Boolean(row.cashier_register_required ?? 1),
    exclusiveCashierPerRegister: Boolean(row.exclusive_cashier_per_register ?? 1),
    salesOperationMode: row.sales_operation_mode || 'directa',
    starterCatalogSeeded: Boolean(row.starter_catalog_seeded),
    setupCompleted: Boolean(row.setup_completed),
    requireCashOpenBeforeUse: Boolean(row.require_cash_open_before_use),
    licenseStatus: license.status,
    trialStartedAt: license.trialStartedAt,
    trialEndsAt: license.trialEndsAt,
    trialDaysLeft: license.daysLeft,
    trialExpired: license.expired,
    planCode: (() => {
      const stored  = String(row.plan_code || 'basico').toLowerCase();
      const derived = plans.planForMode(row.business_structure_mode) || 'basico';
      return (plans.PLAN_LEVELS[stored] || 1) >= (plans.PLAN_LEVELS[derived] || 1) ? stored : derived;
    })(),
    planName: (() => {
      const stored  = String(row.plan_code || 'basico').toLowerCase();
      const derived = plans.planForMode(row.business_structure_mode) || 'basico';
      const code    = (plans.PLAN_LEVELS[stored] || 1) >= (plans.PLAN_LEVELS[derived] || 1) ? stored : derived;
      return plans.PLAN_NAMES[code] || 'Tecno Caja Básico';
    })(),
    planExpiresAt: row.plan_expires_at || null,
    planFeatures: plans.PLAN_FEATURE_MAP,
    mobileConnectionCode: row.mobile_connection_code || '',
    businessProfile: buildBusinessProfile(businessType),
    activeBranchId: structure.activeBranchId,
    activeCashRegisterId: structure.activeCashRegisterId,
    activeBranchName: structure.activeBranch?.nombre || '',
    activeCashRegisterName: structure.activeCashRegister?.nombre || '',
    cajaAbierta: Boolean(activeSession),
    cajaMonto: Number(activeSession?.current_amount || 0)
  };
}

async function getLatestDeliveryLocations() {
  await ensureDeliveryTrackingTable();
  const rows = await query(`
    SELECT dl.*
    FROM delivery_locations dl
    INNER JOIN (
      SELECT user_id, MAX(id) AS max_id
      FROM delivery_locations
      WHERE user_id IS NOT NULL
      GROUP BY user_id
    ) latest ON latest.max_id = dl.id
    ORDER BY dl.updated_at DESC
  `);
  return rows.map((row) => ({
    userId: row.user_id,
    userName: row.user_name || 'Delivery',
    sessionId: row.session_id || '',
    latitud: Number(row.latitude || 0),
    longitud: Number(row.longitude || 0),
    precisionMetros: row.accuracy_meters === null ? null : Number(row.accuracy_meters),
    fuente: row.source || 'mobile',
    actualizadaEn: row.updated_at
  }));
}

async function ensureUniqueProductCode(codigo, ignoreId = null, executor = query) {
  const runQuery = typeof executor?.query === 'function'
    ? executor.query.bind(executor)
    : query;
  const rows = ignoreId
    ? await runQuery('SELECT id FROM products WHERE LOWER(codigo) = LOWER(?) AND id <> ? LIMIT 1', [codigo, ignoreId])
    : await runQuery('SELECT id FROM products WHERE LOWER(codigo) = LOWER(?) LIMIT 1', [codigo]);
  if (rows.length) {
    const error = new Error('Ya existe un producto con ese código.');
    error.statusCode = 409;
    throw error;
  }
}

async function ensureUniqueProductName(nombre, ignoreId = null, executor = query) {
  const runQuery = typeof executor?.query === 'function'
    ? executor.query.bind(executor)
    : query;
  const rows = ignoreId
    ? await runQuery('SELECT id FROM products WHERE LOWER(nombre) = LOWER(?) AND id <> ? LIMIT 1', [nombre, ignoreId])
    : await runQuery('SELECT id FROM products WHERE LOWER(nombre) = LOWER(?) LIMIT 1', [nombre]);
  if (rows.length) {
    const error = new Error('Ya existe un producto con ese nombre.');
    error.statusCode = 409;
    throw error;
  }
}

async function getBootstrapData(actorUser = null) {
  await ensureAuditTable();
  await ensureCategoriesTable();
  await ensureBusinessStructureExtensions();
  await ensureBusinessRulesExtensions();
  await ensureUserExtensions();
  await ensureProductExtensions();
  await ensureClientExtensions();
  await ensureSalesExtensions();
  await ensureSuppliersTable();
  await ensureSupplierInvoicesTable();
  await ensureInventoryMovementsTable();
  await ensureCashMovementExtensions();
  await ensureDiningTables();
  await ensureDeliveryTrackingTable();
  await ensureSuspendedSalesTable();
  await ensureQuotationsTable();
  let config = await getConfig();
  config = await ensureStarterCatalogSeededIfNeeded(config);
  const actorRoleCode = normalizeLegacyUserRoleCode(actorUser?.role_code || actorUser?.rol);
  const shouldForceBranchScope = ['administrador_sucursal', 'supervisor', 'cajero'].includes(actorRoleCode);
  const scopedBranchId = getUserScopeBranchId(actorUser);
  const scopedCashRegisterId = getUserScopeCashRegisterId(actorUser);
  const effectiveBranchId = Number(scopedBranchId || config.activeBranchId || 0) || null;
  const effectiveCashRegisterId = Number(scopedCashRegisterId || (!scopedBranchId ? config.activeCashRegisterId : null) || 0) || null;
  const canAccessGlobalAudit = !actorUser || userCanAccessGlobalAudit(actorUser);
  const branchScopedUser = shouldForceBranchScope || Boolean(scopedBranchId);
  await query('UPDATE supplier_invoices SET status = CASE WHEN pending_amount <= 0 THEN "Pagada" WHEN due_at IS NOT NULL AND due_at < date(\'now\') THEN "Vencida" ELSE "Pendiente" END');
  const [categoryRows, productRows, clientRows, supplierRows, supplierInvoiceRows, userRows, saleRows, saleItemRows, movementRows, openSessionRows, auditRows, inventoryMovementRows, diningTableRows, deliveryLocations, suspendedSalesRows, quotationRows, branchRows, cashRegisterRows] = await Promise.all([
    getCategories(),
    effectiveBranchId
      ? query(
          `SELECT p.*, ib.id AS inventory_branch_id, ib.branch_id, ib.stock AS stock_in_branch, ib.stock_min AS stock_min_in_branch
           FROM products p
           LEFT JOIN inventory_by_branch ib ON ib.product_id = p.id AND ib.branch_id = ?
           ORDER BY p.nombre`,
          [effectiveBranchId]
        )
      : query('SELECT * FROM products ORDER BY nombre'),
    getClientRowsWithComputedBalance(),
    query('SELECT * FROM suppliers ORDER BY nombre'),
    query('SELECT si.*, s.nombre AS supplier_name FROM supplier_invoices si LEFT JOIN suppliers s ON s.id = si.supplier_id ORDER BY si.issued_at DESC, si.id DESC LIMIT 300'),
    branchScopedUser
      ? query('SELECT * FROM users WHERE COALESCE(sucursal_id, branch_id, 0) = ? ORDER BY id', [effectiveBranchId])
      : query('SELECT * FROM users ORDER BY id'),
    branchScopedUser
      ? query(
          `SELECT s.*, u.nombre AS cashier_name, COALESCE(c.nombre, "Consumidor Final") AS client_name, COALESCE(c.telefono, "") AS client_phone
           FROM sales s
           LEFT JOIN users u ON u.id = s.user_id
           LEFT JOIN clients c ON c.id = s.client_id
           WHERE COALESCE(s.inventory_branch_id, s.billed_branch_id, s.branch_id) = ?
           ORDER BY s.id DESC LIMIT 500`,
          [effectiveBranchId]
        )
      : query('SELECT s.*, u.nombre AS cashier_name, COALESCE(c.nombre, "Consumidor Final") AS client_name, COALESCE(c.telefono, "") AS client_phone FROM sales s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN clients c ON c.id = s.client_id ORDER BY s.id DESC LIMIT 500'),
    query('SELECT si.*, p.nombre AS product_name FROM sale_items si LEFT JOIN products p ON p.id = si.product_id WHERE si.sale_id IN (SELECT id FROM (SELECT id FROM sales ORDER BY id DESC LIMIT 500) AS _recent)'),
    scopedCashRegisterId
      ? query('SELECT movement_type AS tipo, amount AS monto, happened_at AS hora, notes AS obs, created_by_user_id, created_by_user_name FROM cash_movements WHERE cash_register_id = ? ORDER BY id DESC LIMIT 50', [scopedCashRegisterId])
      : branchScopedUser
      ? query('SELECT movement_type AS tipo, amount AS monto, happened_at AS hora, notes AS obs, created_by_user_id, created_by_user_name FROM cash_movements WHERE branch_id = ? ORDER BY id DESC LIMIT 50', [effectiveBranchId])
      : effectiveCashRegisterId
      ? query('SELECT movement_type AS tipo, amount AS monto, happened_at AS hora, notes AS obs, created_by_user_id, created_by_user_name FROM cash_movements WHERE cash_register_id = ? ORDER BY id DESC LIMIT 50', [effectiveCashRegisterId])
      : query('SELECT movement_type AS tipo, amount AS monto, happened_at AS hora, notes AS obs, created_by_user_id, created_by_user_name FROM cash_movements ORDER BY id DESC LIMIT 50'),
    // Sesión activa: incluimos operative_date para que el frontend filtre por turno
    scopedCashRegisterId
      ? query('SELECT id, opened_amount, current_amount, opened_at, opened_by_user_name, operative_date FROM cash_sessions WHERE status = "open" AND cash_register_id = ? ORDER BY id DESC LIMIT 1', [scopedCashRegisterId])
      : branchScopedUser
      ? query('SELECT id, opened_amount, current_amount, opened_at, opened_by_user_name, operative_date FROM cash_sessions WHERE status = "open" AND branch_id = ? ORDER BY id DESC LIMIT 1', [effectiveBranchId])
      : effectiveCashRegisterId
      ? query('SELECT id, opened_amount, current_amount, opened_at, opened_by_user_name, operative_date FROM cash_sessions WHERE status = "open" AND cash_register_id = ? ORDER BY id DESC LIMIT 1', [effectiveCashRegisterId])
      : query('SELECT id, opened_amount, current_amount, opened_at, opened_by_user_name, operative_date FROM cash_sessions WHERE status = "open" ORDER BY id DESC LIMIT 1'),
    canAccessGlobalAudit
      ? query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200')
      : Promise.resolve([]),
    effectiveBranchId
      ? query(`SELECT im.*, p.nombre AS product_name, p.codigo AS product_code
               FROM inventory_movements im
               LEFT JOIN products p ON p.id = im.product_id
               WHERE COALESCE(im.branch_id, im.source_branch_id, im.destination_branch_id, ?) = ?
               ORDER BY im.id DESC LIMIT 300`, [effectiveBranchId, effectiveBranchId])
      : query(`SELECT im.*, p.nombre AS product_name, p.codigo AS product_code
               FROM inventory_movements im
               LEFT JOIN products p ON p.id = im.product_id
               ORDER BY im.id DESC LIMIT 300`),
    query('SELECT * FROM dining_tables ORDER BY nombre'),
    branchScopedUser ? Promise.resolve([]) : getLatestDeliveryLocations(),
    branchScopedUser ? Promise.resolve([]) : query('SELECT * FROM suspended_sales ORDER BY updated_at DESC, created_at DESC'),
    branchScopedUser ? Promise.resolve([]) : query('SELECT * FROM quotations ORDER BY updated_at DESC, created_at DESC'),
    branchScopedUser ? getBranchRows().then((rows) => rows.filter((row) => Number(row.id || 0) === Number(effectiveBranchId || 0))) : getBranchRows(),
    branchScopedUser ? getCashRegisterRows(effectiveBranchId) : getCashRegisterRows()
  ]);
  const [roleRows, paymentMethodRows] = await Promise.all([
    query('SELECT * FROM roles WHERE estado = "Activo" ORDER BY nombre'),
    query('SELECT * FROM payment_methods WHERE estado = "Activo" ORDER BY nombre')
  ]);

  const ventas = mapSaleRows(saleRows, saleItemRows);
  const pendingCreditByClient = buildClientPendingCreditMapFromSaleRows(saleRows);
  const activeBranch = branchRows.find((item) => Number(item.id || 0) === Number(effectiveBranchId || 0)) || branchRows[0] || null;
  const activeCashRegister = cashRegisterRows.find((item) => Number(item.id || 0) === Number(effectiveCashRegisterId || 0)) || cashRegisterRows[0] || null;
  const openSession = openSessionRows[0] || null;
  const cajaAbierta = Boolean(openSession);
  const cajaMonto = Number(openSession?.current_amount || 0);

  // Construir objeto de sesión activa con fecha operativa y advertencia de turno largo
  const STALE_SESSION_HOURS = 20;
  let activeSessionInfo = null;
  if (openSession) {
    const openedAtMs = openSession.opened_at ? new Date(openSession.opened_at).getTime() : Date.now();
    const hoursOpen = Math.round((Date.now() - openedAtMs) / 36000) / 100;
    const operativeDate = openSession.operative_date
      ? toLocalDateKeyRD(openSession.operative_date)
      : toLocalDateKeyRD(openSession.opened_at || new Date());
    activeSessionInfo = {
      id: Number(openSession.id),
      openedAmount: Number(openSession.opened_amount || 0),
      currentAmount: Number(openSession.current_amount || 0),
      openedAt: openSession.opened_at,
      openedByUserName: openSession.opened_by_user_name || 'Sistema',
      operativeDate,
      hoursOpen,
      staleWarning: hoursOpen > STALE_SESSION_HOURS,
    };
  }

  if (branchScopedUser) {
    config = {
      ...config,
      activeBranchId: Number(activeBranch?.id || effectiveBranchId || 0) || null,
      activeCashRegisterId: Number(activeCashRegister?.id || effectiveCashRegisterId || 0) || null,
      activeBranchName: activeBranch?.nombre || '',
      activeCashRegisterName: activeCashRegister?.nombre || '',
      cajaAbierta,
      cajaMonto
    };
  } else {
    config = {
      ...config,
      cajaAbierta,
      cajaMonto
    };
  }

  return {
    config,
    categorias: categoryRows.map((item) => item.nombre),
    users: userRows.map(mapUserRow),
    currentUser: null,
    productos: productRows.map(mapProductRow),
    clientes: clientRows.map((row) => mapClientRow({
      ...row,
      balance: pendingCreditByClient.has(Number(row.id || 0))
        ? pendingCreditByClient.get(Number(row.id || 0))
        : Number(row.balance || 0)
    })),
    proveedores: supplierRows.map(mapSupplierRow),
    facturasProveedores: supplierInvoiceRows.map(mapSupplierInvoiceRow),
    mesas: diningTableRows.map((row) => ({
      id: row.id,
      nombre: row.nombre,
      capacidad: Number(row.capacidad || 0),
      estado: row.estado
    })),
    deliveryLocations,
    ventas,
    movimientosSistema: auditRows.map(mapAuditRow),
    movimientosInventario: inventoryMovementRows.map(mapInventoryMovementRow),
    ventasPendientes: suspendedSalesRows.map(mapSuspendedSaleRow),
    cotizaciones: quotationRows.map(mapQuotationRow),
    sucursales: branchRows.map(mapBranchRow),
    cajasSucursal: cashRegisterRows.map(mapCashRegisterRow),
    roles: roleRows.map((row) => ({
      id: Number(row.id),
      codigo: row.codigo,
      nombre: row.nombre,
      permisos: parseJsonArrayField(row.permisos)
    })),
    metodosPagoDisponibles: paymentMethodRows.map((row) => ({
      id: Number(row.id),
      codigo: row.codigo,
      nombre: row.nombre
    })),
    movimientosCaja: movementRows.map((movement) => ({
      tipo: movement.tipo,
      monto: Number(movement.monto || 0),
      hora: movement.hora,
      obs: movement.obs,
      usuarioId: movement.created_by_user_id === null ? null : Number(movement.created_by_user_id),
      usuarioNombre: movement.created_by_user_name || 'Sistema'
    })),
    nextInvoice: config.nextInvoice,
    saleItems: [],
    payMethod: 'efectivo',
    saleDocumentType: 'ticket',
    saleClientId: null,
    saleDeliveryUserId: null,
    saleOrderType: 'mostrador',
    saleKitchenStatus: 'pendiente',
    saleGeneralDiscount: 0,
    saleTableLabel: '',
    saleDeliveryPhone: '',
    saleDeliveryAddress: '',
    saleDeliveryReference: '',
    saleDeliveryLink: '',
    saleOrderNotes: '',
    caja: {
      sessionId: openSessionRows[0]?.id || null,
      abierta: cajaAbierta,
      activeSession: activeSessionInfo
    }
  };
}

app.post('/api/logout', async (req, res) => {
  const token = readAuthToken(req);
  if (token) await destroyAuthSession(token);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// LISTA PÚBLICA DE USUARIOS — para el selector de login (sin contraseñas)
// ═══════════════════════════════════════════════════════════════════════════
let publicUsersListCache = { expiresAt: 0, payload: null };

function clearPublicUsersListCache() {
  publicUsersListCache = { expiresAt: 0, payload: null };
}

app.get('/api/public/users-list', loginLimiter, async (req, res) => {
  try {
    if (publicUsersListCache.payload && publicUsersListCache.expiresAt > Date.now()) {
      res.setHeader('Cache-Control', 'private, max-age=10');
      return res.json(publicUsersListCache.payload);
    }

    const users = await query(
      `SELECT id, nombre, usuario, rol
       FROM users
       WHERE LOWER(COALESCE(estado, 'activo')) IN ('activo', 'active', '')
          OR estado IS NULL
       ORDER BY nombre ASC
       LIMIT 50`,
      []
    );
    const safeUsers = users.map(u => ({
      id: Number(u.id),
      nombre: String(u.nombre || u.usuario || 'Usuario'),
      usuario: String(u.usuario || ''),
      rol: String(u.rol || ''),
    }));
    const payload = { ok: true, users: safeUsers };
    publicUsersListCache = {
      expiresAt: Date.now() + 10 * 1000,
      payload
    };
    res.setHeader('Cache-Control', 'private, max-age=10');
    res.json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, users: [], error: e.message });
  }
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const setupStatus = await getSetupStatus();
  if (setupStatus.setupRequired) {
    return res.status(423).json({ error: 'Debes completar el asistente inicial antes de iniciar sesión.' });
  }
  if (!setupStatus.license.canEnter) {
    return res.status(403).json({ error: getLicenseDeniedMessage(setupStatus.license) });
  }

  const { usuario, password } = req.body || {};
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña son requeridos.' });
  }

  // Rate limiting por IP + usuario
  const rlKey = String(req.ip || '') + ':' + String(usuario || '');
  const rl = checkLoginRateLimit(rlKey);
  if (!rl.allowed) {
    try { await query('INSERT INTO login_attempts (usuario, ip_address, success) VALUES (?, ?, 0)', [usuario, req.ip]); } catch (_e) {}
    return res.status(429).json({
      error: `Demasiados intentos fallidos. Espera ${Math.ceil(rl.retryAfter / 60)} minutos.`,
      retry_after: rl.retryAfter
    });
  }

  await ensureUserExtensions();
  const rows = await query(
    `SELECT u.*, r.codigo AS role_code, r.nombre AS role_name, r.permisos AS role_permissions
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.usuario = ? AND u.estado = "Activo"
     LIMIT 1`,
    [usuario]
  );
  const user = rows[0];
  if (!user || !userPasswordMatches(user, password)) {
    try { await query('INSERT INTO login_attempts (usuario, ip_address, success) VALUES (?, ?, 0)', [usuario, req.ip]); } catch (_e) {}
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }

  const now = new Date().toLocaleString('sv-SE').replace(' ', ' ');
  await query('UPDATE users SET last_login = ?, auth_provider = ? WHERE id = ?', [now, 'local', user.id]);
  await writeAuditLog({
    userId: user.id,
    userName: user.nombre,
    userRole: user.rol,
    moduleName: 'Sistema',
    actionName: 'Inicio de sesión',
    detail: `Acceso al sistema con usuario ${user.usuario}`
  });
  const bootstrap = await getBootstrapData(user);
  const currentUser = { ...mapUserRow({ ...user, last_login: now }) };
  bootstrap.currentUser = currentUser;
  const token = await createAuthSession(user, req.ip, req.headers['user-agent']);
  resetLoginRateLimit(String(req.ip) + ':' + usuario);
  try { await query('INSERT INTO login_attempts (usuario, ip_address, success) VALUES (?, ?, 1)', [usuario, req.ip]); } catch (_e) {}

  res.json({
    token,
    user: currentUser,
    data: bootstrap
  });
});

app.post('/api/login/firebase-session', async (req, res) => {
  const setupStatus = await getSetupStatus();
  if (setupStatus.setupRequired) {
    return res.status(423).json({ error: 'Debes completar el asistente inicial antes de iniciar sesión.' });
  }
  if (!setupStatus.license.canEnter) {
    return res.status(403).json({ error: getLicenseDeniedMessage(setupStatus.license) });
  }

  const firebaseStatus = getFirebaseConfigStatus();
  if (!firebaseStatus.enabled) {
    return res.status(503).json({
      error: firebaseStatus.reason || 'Firebase Admin no esta configurado para validar sesiones Firebase.',
      collection: firebaseStatus.collection
    });
  }

  const decodedToken = await verifyFirebaseIdToken(String(req.body?.idToken || '').trim());
  const email = String(decodedToken.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ error: 'La cuenta Firebase debe tener un correo disponible.' });
  }

  let rows = await query(
    `SELECT id FROM users
     WHERE firebase_uid = ?
       AND estado = "Activo"
       AND COALESCE(account_type, "staff") <> "customer"
     LIMIT 1`,
    [decodedToken.uid]
  );

  if (!rows.length) {
    rows = await query(
      `SELECT id FROM users
       WHERE email = ?
         AND estado = "Activo"
         AND COALESCE(account_type, "staff") <> "customer"
       LIMIT 1`,
      [email]
    );
  }

  const matchedUserId = Number(rows[0]?.id || 0) || 0;
  if (!matchedUserId) {
    return res.status(403).json({
      error: 'Tu cuenta Firebase no está vinculada a un usuario activo del POS.'
    });
  }

  const user = await getUserWithRoleContextById(matchedUserId);
  if (!user || !canUseGoogleStaffAccess(user.role_code || user.rol)) {
    return res.status(403).json({
      error: 'Tu usuario del POS no tiene permiso para entrar al panel de reportes.'
    });
  }

  const now = new Date().toLocaleString('sv-SE').replace(' ', ' ');
  const displayName = String(decodedToken.name || user.nombre || '').trim() || user.nombre;
  await query(
    `UPDATE users
     SET email = ?, nombre = ?, firebase_uid = ?, last_login = ?
     WHERE id = ?`,
    [email, displayName, decodedToken.uid, now, user.id]
  );

  const currentUser = await getUserWithRoleContextById(user.id);
  try {
    const reportsConfig = await getReportSyncConfig();
    await syncStaffToReportsApp(
      {
        ...currentUser,
        email,
        nombre: displayName,
        firebase_uid: decodedToken.uid,
      },
      reportsConfig
    );
  } catch (error) {
    console.warn(
      'No se pudo sincronizar el perfil Firebase del usuario para Reportes:',
      error.message
    );
  }

  const bootstrap = await getBootstrapData(currentUser);
  const mappedCurrentUser = mapUserRow({ ...currentUser, last_login: now });
  bootstrap.currentUser = mappedCurrentUser;
  const token = await createAuthSession(currentUser, req.ip, req.headers['user-agent'], 'reports');

  res.json({
    token,
    user: mappedCurrentUser,
    data: bootstrap
  });
});

app.post('/api/login/google', loginLimiter, async (req, res) => {
  const setupStatus = await getSetupStatus();
  if (setupStatus.setupRequired) {
    return res.status(423).json({ error: 'Debes completar el asistente inicial antes de iniciar sesión.' });
  }
  if (!setupStatus.license.canEnter) {
    return res.status(403).json({ error: getLicenseDeniedMessage(setupStatus.license) });
  }

  const firebaseStatus = getFirebaseConfigStatus();
  if (!firebaseStatus.enabled) {
    return res.status(503).json({
      error: firebaseStatus.reason || 'Firebase Admin no esta configurado para validar Google.',
      collection: firebaseStatus.collection
    });
  }

  const decodedToken = await verifyFirebaseIdToken(String(req.body?.idToken || '').trim());
  const email = String(decodedToken.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ error: 'La cuenta de Google debe tener un correo disponible.' });
  }

  let rows = await query(
    `SELECT * FROM users
     WHERE firebase_uid = ?
       AND estado = "Activo"
       AND COALESCE(account_type, "staff") <> "customer"
       AND rol IN ("Administrador", "Administrador sucursal", "Supervisor")
     LIMIT 1`,
    [decodedToken.uid]
  );

  if (!rows.length) {
    rows = await query(
      `SELECT * FROM users
       WHERE email = ?
         AND estado = "Activo"
         AND COALESCE(account_type, "staff") <> "customer"
         AND rol IN ("Administrador", "Administrador sucursal", "Supervisor")
       LIMIT 1`,
      [email]
    );
  }

  const user = rows[0];
  if (!user) {
    return res.status(403).json({
      error: 'Tu cuenta de Google no está vinculada a un Administrador, Administrador de sucursal o Supervisor activo del POS.'
    });
  }

  const now = new Date().toLocaleString('sv-SE').replace(' ', ' ');
  const displayName = String(decodedToken.name || user.nombre || '').trim() || user.nombre;
  await query(
    `UPDATE users
     SET email = ?, nombre = ?, firebase_uid = ?, auth_provider = 'google', last_login = ?
     WHERE id = ?`,
    [email, displayName, decodedToken.uid, now, user.id]
  );

  await writeAuditLog({
    userId: user.id,
    userName: displayName,
    userRole: user.rol,
    moduleName: 'Sistema',
    actionName: 'Inicio de sesión con Google',
    detail: `Acceso al sistema con Google: ${email}`
  });
  const bootstrap = await getBootstrapData(user);
  const currentUserRows = await query(
    `SELECT u.*, r.codigo AS role_code, r.nombre AS role_name, r.permisos AS role_permissions
     FROM users u LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.id = ? LIMIT 1`,
    [user.id]
  );
  const currentUser = mapUserRow({ ...currentUserRows[0], last_login: now });
  bootstrap.currentUser = currentUser;
  const token = await createAuthSession(currentUserRows[0], req.ip, req.headers['user-agent']);

  res.json({
    token,
    user: currentUser,
    data: bootstrap
  });
});

app.post('/api/login/google/link', async (req, res) => {
  const setupStatus = await getSetupStatus();
  if (setupStatus.setupRequired) {
    return res.status(423).json({ error: 'Debes completar el asistente inicial antes de vincular Google.' });
  }
  if (!setupStatus.license.canEnter) {
    return res.status(403).json({ error: getLicenseDeniedMessage(setupStatus.license) });
  }

  const firebaseStatus = getFirebaseConfigStatus();
  if (!firebaseStatus.enabled) {
    return res.status(503).json({
      error: firebaseStatus.reason || 'Firebase no esta configurado para validar Google.',
      collection: firebaseStatus.collection
    });
  }

  const usuario = String(req.body?.usuario || '').trim();
  const password = String(req.body?.password || '').trim();
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Debes indicar tu usuario y contraseña actual para vincular Google.' });
  }

  const decodedToken = await verifyFirebaseIdToken(String(req.body?.idToken || '').trim());
  const email = String(decodedToken.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ error: 'La cuenta de Google debe tener un correo disponible.' });
  }

  const rows = await query(
    `SELECT * FROM users
     WHERE usuario = ?
       AND estado = "Activo"
       AND COALESCE(account_type, "staff") <> "customer"
       AND rol IN ("Administrador", "Administrador sucursal", "Supervisor")
     LIMIT 1`,
    [usuario]
  );
  const user = rows[0];
  if (!user || !userPasswordMatches(user, password)) {
    return res.status(401).json({ error: 'El usuario o la contraseña no son válidos para vincular esta cuenta Google.' });
  }

  const linkedUidRows = await query('SELECT id, usuario FROM users WHERE firebase_uid = ? LIMIT 1', [decodedToken.uid]);
  const linkedUidUser = linkedUidRows[0];
  if (linkedUidUser && Number(linkedUidUser.id) !== Number(user.id)) {
    return res.status(409).json({ error: `Esta cuenta de Google ya está vinculada al usuario ${linkedUidUser.usuario}.` });
  }

  if (String(user.firebase_uid || '').trim() && String(user.firebase_uid || '').trim() !== decodedToken.uid) {
    return res.status(409).json({ error: 'Este usuario ya está vinculado a otra cuenta de Google.' });
  }

  const now = new Date().toLocaleString('sv-SE').replace(' ', ' ');
  const displayName = String(decodedToken.name || user.nombre || '').trim() || user.nombre;
  await query(
    `UPDATE users
     SET email = ?, nombre = ?, firebase_uid = ?, auth_provider = 'google', last_login = ?
     WHERE id = ?`,
    [email, displayName, decodedToken.uid, now, user.id]
  );

  await writeAuditLog({
    userId: user.id,
    userName: displayName,
    userRole: user.rol,
    moduleName: 'Sistema',
    actionName: 'Cuenta Google vinculada',
    detail: `${usuario} vinculó Google: ${email}`
  });

  const bootstrap = await getBootstrapData();
  const currentUserRows = await query(
    `SELECT u.*, r.codigo AS role_code, r.nombre AS role_name, r.permisos AS role_permissions
     FROM users u LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.id = ? LIMIT 1`,
    [user.id]
  );
  const currentUser = mapUserRow({ ...currentUserRows[0], last_login: now });
  bootstrap.currentUser = currentUser;

  res.json({
    user: currentUser,
    data: bootstrap
  });
});

// ─── Registro de licencia POS en Firestore ──────────────────────────────────
async function registerPosLicenseInFirestore({ businessName, adminEmail, trialEndsAt, businessStructureMode }) {
  try {
    const { getFirestore } = require('./modules/firebase-admin');
    const db = getFirestore();
    if (!db) return null;

    const { FieldValue } = require('firebase-admin/firestore');
    const slug = businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const businessKey = `pos:${slug}`;
    const uid = `pos_${crypto.randomBytes(6).toString('hex')}`;
    const planCode = { monocaja: 'basico', multicaja: 'pro', multisucursal: 'plus' }[businessStructureMode] || 'basico';
    const publicUrl = String(process.env.POS_PUBLIC_BASE_URL || '').trim();
    const mobileCode = await query('SELECT mobile_connection_code FROM config WHERE id = 1').then(r => r[0]?.mobile_connection_code || '').catch(() => '');

    const sharedData = {
      licenseId: uid,
      principalUid:   uid,
      source:         'pos',
      systemAssignment: 'pos',
      businessName,
      businessKey,
      email:          adminEmail,
      ownerEmail:     adminEmail,
      planCode,
      status:         'trial',
      issuedAt:       FieldValue.serverTimestamp(),
      trialStartedAt: FieldValue.serverTimestamp(),
      expiresAt:      trialEndsAt,
      trialEndsAt,
      offlineGraceDays: Number(process.env.TECNO_CAJA_LICENSE_OFFLINE_GRACE_DAYS || 3) || 3,
      deviceLimit:    1,
      devices:        {},
      signature:      null,
      signatureAlg:   null,
      mobileConnectionCode:           mobileCode,
      mobileConnectionCodeNormalized: mobileCode.replace(/-/g, ''),
      mobileAccessUrl:  publicUrl,
      mobileAccessConfigured: Boolean(publicUrl),
      createdAt:      FieldValue.serverTimestamp(),
    };

    // usuarios: lo que muestra la app admin en la sección Usuarios/Clientes
    await db.collection('usuarios').doc(uid).set({
      ...sharedData,
      recordKind: 'account',
      nombre:     businessName,
    });

    // licencias: lo que usa el sistema de planes y syncLicenseFromFirebase
    await db.collection('licencias').doc(uid).set(sharedData);

    // Persistir el UID en la configuración editable del usuario para que la
    // licencia siga sincronizando incluso con la app instalada.
    persistRuntimeEnvValues({ TECNO_CAJA_LICENSE_UID: uid });

    console.log(`[setup] Licencia POS registrada en Firestore: ${uid} (${businessName})`);
    return uid;
  } catch (err) {
    console.warn('[setup] No se pudo registrar licencia en Firestore:', err.message);
    return null;
  }
}

app.get('/api/setup/status', async (_req, res) => {
  const status = await getSetupStatus();
  if (status.setupCompleted) {
    const mode = String(status.config?.businessStructureMode || 'monocaja');
    if (mode === 'multicaja' || mode === 'multisucursal') {
      const tc = getTerminalConfig();
      if (!tc) {
        return res.json({ ...status, setupRequired: true, linkingMode: true });
      }
      return res.json({ ...status, terminalConfig: tc });
    }
  }
  res.json(status);
});

app.post('/api/setup/complete', async (req, res) => {
  const payload = req.body || {};
  const currentStatus = await getSetupStatus();
  const forceReset = Boolean(payload.forceReset);
  if (!currentStatus.setupRequired && !forceReset) {
    return res.status(409).json({ error: 'El sistema ya fue configurado.' });
  }
  if (!currentStatus.setupRequired && forceReset) {
    const securityPassword = String(payload.securityPassword || '');
    const storedPassword = await getSecurityPassword();
    if (!securityPassword || securityPassword !== storedPassword) {
      return res.status(403).json({ error: 'La clave de seguridad no es válida para reinstalar la aplicación.' });
    }
  }

  const language = String(payload.language || 'es').trim().toLowerCase();
  const businessType = String(payload.businessType || 'pizzeria').trim().toLowerCase();
  const businessStructureMode = normalizeBusinessStructureMode(payload.businessStructureMode || 'monocaja');
  const businessName = String(payload.businessName || '').trim();
  const businessRnc = String(payload.businessRnc || '').trim();
  const businessAddress = String(payload.businessAddress || '').trim();
  const businessPhone = String(payload.businessPhone || '').trim();
  const currency = String(payload.currency || 'RD$').trim();
  const printMode = String(payload.receiptPrintMode || 'dialog').trim();
  const printerName = String(payload.receiptPrinterName || '').trim();
  const paperSize = String(payload.receiptPaperSize || '80mm').trim();
  const setupGoogleIdToken = String(payload.googleIdToken || '').trim();
  const googleAuthPayload = setupGoogleIdToken
    ? await verifyFirebaseIdToken(setupGoogleIdToken)
    : null;
  const googleEmail = String(googleAuthPayload?.email || '').trim().toLowerCase();
  const googleDisplayName = String(googleAuthPayload?.name || '').trim();
  const adminName = String(payload.adminName || googleDisplayName || '').trim();
  const adminUser = String(payload.adminUser || '').trim();
  const rawEmail = String(payload.adminEmail || googleEmail || '').trim().toLowerCase();
  const autoEmail = rawEmail || `${adminUser.toLowerCase().replace(/[^a-z0-9]/g, '')}@${businessName.toLowerCase().replace(/[^a-z0-9]/g, '')}.pos`;
  const adminEmail = autoEmail;
  const adminPassword = String(payload.adminPassword || '').trim();
  const openingAmount = Math.max(0, Number(payload.openingAmount || 0));
  const openingNotes = String(payload.openingNotes || 'Apertura inicial de caja').trim() || 'Apertura inicial de caja';
  const networkKey = String(payload.networkKey || '').trim();

  if (!businessName || !adminName || !adminUser || (!adminPassword && !googleAuthPayload)) {
    return res.status(400).json({ error: 'Completa el nombre del negocio y los datos del administrador.' });
  }
  if (!LANGUAGE_OPTIONS.some((item) => item.value === language)) {
    return res.status(400).json({ error: 'El idioma seleccionado no es válido.' });
  }
  if (!CURRENCY_OPTIONS.some((item) => item.value === currency)) {
    return res.status(400).json({ error: 'La moneda seleccionada no es válida.' });
  }
  if (!BUSINESS_TEMPLATES[businessType]) {
    return res.status(400).json({ error: 'El tipo de negocio seleccionado no es válido.' });
  }
  if (!businessStructureMode) {
    return res.status(400).json({ error: 'La estructura del negocio seleccionada no es válida.' });
  }
  if (['multicaja', 'multisucursal'].includes(businessStructureMode) && !networkKey) {
    return res.status(400).json({ error: 'La clave de red es obligatoria para configuración multicaja o multisucursal.' });
  }
  if (networkKey && networkKey.length < 6) {
    return res.status(400).json({ error: 'La clave de red debe tener al menos 6 caracteres.' });
  }
  const currentConfiguredBusinessName = String(currentStatus.config?.nombre || currentStatus.config?.businessName || '').trim();
  const currentLicenseUid = String(process.env.TECNO_CAJA_LICENSE_UID || '').trim();

  try {
    await ensureFirebaseIdentityAvailability({
      businessName,
      username: adminUser,
      email: adminEmail,
      currentLicenseUid,
      currentFirebaseUid: googleAuthPayload?.uid || '',
      skipBusinessConflictCheck: Boolean(forceReset && !currentLicenseUid && currentConfiguredBusinessName && currentConfiguredBusinessName === businessName),
    });
  } catch (error) {
    return res.status(Number(error.statusCode || 500)).json({ error: error.message || 'No se pudo validar la identidad en Firebase.' });
  }

  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + (30 * 24 * 60 * 60 * 1000));
  const nowSql = now.toISOString().slice(0, 19).replace('T', ' ');
  const trialEndsSql = trialEndsAt.toISOString().slice(0, 19).replace('T', ' ');

  await ensureBusinessRulesExtensions();
  await ensureSuspendedSalesTable();
  await ensureQuotationsTable();

  const sessionData = await withTransaction(async (conn) => {
    const duplicateUserRows = forceReset ? [] : await conn.query('SELECT id FROM users WHERE usuario = ? LIMIT 1', [adminUser]);
    if (duplicateUserRows.length) {
      const error = new Error('Ya existe un usuario con ese nombre de acceso.');
      error.statusCode = 409;
      throw error;
    }

    await conn.query('DELETE FROM sale_items');
    await conn.query('DELETE FROM sales');
    await conn.query('DELETE FROM cash_closings');
    await conn.query('DELETE FROM cash_openings');
    await conn.query('DELETE FROM cash_movements');
    await conn.query('DELETE FROM cash_sessions');
    await conn.query('DELETE FROM branch_transfer_items');
    await conn.query('DELETE FROM branch_transfers');
    await conn.query('DELETE FROM inventory_movements');
    await conn.query('DELETE FROM inventory_by_branch');
    await conn.query('DELETE FROM supplier_invoices');
    await conn.query('DELETE FROM suppliers');
    await conn.query('DELETE FROM clients');
    await conn.query('DELETE FROM products');
    await conn.query('DELETE FROM categories');
    await conn.query('DELETE FROM suspended_sales');
    await conn.query('DELETE FROM quotations');
    await conn.query('DELETE FROM dining_tables');
    await conn.query('DELETE FROM delivery_locations');
    await conn.query('DELETE FROM audit_logs');
    await conn.query('DELETE FROM users');
    await conn.query('DELETE FROM cash_registers');
    await conn.query('DELETE FROM branches');

    const businessRows = await conn.query('SELECT business_id FROM config WHERE id = 1 LIMIT 1');
    const businessId = Number(businessRows[0]?.business_id || 0) || null;
    if (businessId) {
      await conn.query(
        `UPDATE businesses
         SET nombre = ?, rnc = ?, direccion = ?, telefono = ?, estado = 'Activo'
         WHERE id = ?`,
        [businessName, businessRnc || null, businessAddress || null, businessPhone || null, businessId]
      );
    }

    await conn.query(
       `UPDATE config
        SET business_name = ?, rnc = ?, address = ?, phone = ?, currency = ?, tax_rate = ?,
           invoice_prefix = ?, invoice_next_number = ?, e_invoice_enabled = ?, e_invoice_prefix = ?,
           e_invoice_next_number = ?, receipt_message = ?, receipt_print_mode = ?, receipt_printer_name = ?, receipt_paper_size = ?, app_logo = ?,
           active_branch_id = NULL, active_cash_register_id = NULL, cash_open = 1, cash_amount = ?, language = ?, business_type = ?, business_structure_mode = ?, install_network_key = ?, starter_catalog_seeded = 0, setup_completed = 1, setup_completed_at = datetime('now'),
           trial_started_at = ?, trial_ends_at = ?, license_status = 'trial', license_activated_at = NULL, license_activated_by = NULL,
           require_cash_open_before_use = 1
       WHERE id = 1`,
      [
        businessName,
        businessRnc,
        businessAddress,
        businessPhone,
        currency,
        Number(payload.taxRate ?? 18),
        String(payload.invoicePrefix || 'FAC-').trim() || 'FAC-',
        Math.max(1, Number(payload.nextInvoice || 1001)),
        payload.eInvoiceEnabled === false ? 0 : 1,
        String(payload.eInvoicePrefix || 'ECF-').trim() || 'ECF-',
        Math.max(1, Number(payload.eInvoiceNextNumber || 1)),
        String(payload.receiptMessage || '¡Gracias por su compra!').trim() || '¡Gracias por su compra!',
        printMode || 'dialog',
        printerName || null,
        paperSize || '80mm',
        null,
        openingAmount,
        language,
        businessType,
        businessStructureMode,
        networkKey ? createLocalPasswordHash(networkKey) : null,
        nowSql,
        trialEndsSql
      ]
    );

    const branchResult = await conn.query(
      `INSERT INTO branches (business_id, nombre, codigo, direccion, telefono, encargado, estado, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Activa', datetime('now'))`,
      [businessId, 'Sucursal Principal', 'SUC-001', businessAddress || null, businessPhone || null, adminName]
    );
    const branchId = Number(branchResult.insertId || 0) || 1;

    const registerResult = await conn.query(
      `INSERT INTO cash_registers (branch_id, nombre, codigo, estado, created_at)
       VALUES (?, ?, ?, 'Activa', datetime('now'))`,
      [branchId, 'Caja Principal', 'CAJ-001']
    );
    const cashRegisterId = Number(registerResult.insertId || 0) || 1;

    await conn.query(
      'UPDATE config SET active_branch_id = ?, active_cash_register_id = ? WHERE id = 1',
      [branchId, cashRegisterId]
    );

    const adminRoleRows = await conn.query(`SELECT id FROM roles WHERE codigo = 'administrador_general' LIMIT 1`);
    const adminRoleId = Number(adminRoleRows[0]?.id || 0) || null;
    const userResult = await conn.query(
      `INSERT INTO users
        (usuario, email, password, password_hash, nombre, rol, role_id, branch_id, sucursal_id, caja_id, estado, last_login, linked_client_id, account_type, auth_provider, firebase_uid, creado_por, fecha_creacion)
       VALUES (?, ?, ?, ?, ?, 'Administrador', ?, ?, ?, NULL, 'Activo', ?, NULL, 'staff', ?, ?, NULL, datetime('now'))`,
      [
        adminUser,
        adminEmail || null,
        adminPassword || '',
        adminPassword ? createLocalPasswordHash(adminPassword) : null,
        adminName,
        adminRoleId,
        branchId,
        branchId,
        nowSql,
        googleAuthPayload ? 'google' : 'local',
        googleAuthPayload?.uid || null
      ]
    );

    const sessionResult = await conn.query(
      `INSERT INTO cash_sessions (opened_amount, current_amount, status, opened_at, branch_id, cash_register_id, opened_by_user_id, opened_by_user_name)
       VALUES (?, ?, "open", datetime('now'), ?, ?, ?, ?)`,
      [openingAmount, openingAmount, branchId, cashRegisterId, userResult.insertId, adminName]
    );
    await conn.query(
      `INSERT INTO cash_movements (session_id, movement_type, amount, notes, created_by_user_id, created_by_user_name, happened_at, branch_id, cash_register_id)
       VALUES (?, "Apertura", ?, ?, ?, ?, datetime('now'), ?, ?)`,
      [sessionResult.insertId, openingAmount, openingNotes, userResult.insertId, adminName, branchId, cashRegisterId]
    );

    return {
      userId: userResult.insertId,
      sessionId: sessionResult.insertId,
      branchId,
      cashRegisterId
    };
  });

  await ensureBusinessStarterCatalog(businessType);
  await query('UPDATE config SET starter_catalog_seeded = 1 WHERE id = 1');
  clearPublicUsersListCache();
  saveTerminalConfig({
    terminalId: crypto.randomBytes(8).toString('hex'),
    terminalName: 'Terminal Principal',
    branchId: sessionData.branchId,
    branchName: 'Sucursal Principal',
    cashRegisterId: sessionData.cashRegisterId,
    cashRegisterName: 'Caja Principal',
    setupMode: businessStructureMode,
    language: language,
    linkedAt: new Date().toISOString(),
    linkedBy: adminUser,
    isMain: true
  });
  let networkHosting = null;
  if (isMysqlDeployment() && ['multicaja', 'multisucursal', 'sucursal'].includes(businessStructureMode)) {
    try {
      const preparedProfile = await ensureLanMysqlAccessProfile();
      networkHosting = {
        enabled: true,
        restartRequired: Boolean(preparedProfile.localManaged),
        dbPort: Number(preparedProfile.port || process.env.DB_PORT || 3306)
      };
    } catch (error) {
      console.warn('[wizard/network-hosting]', error.message);
      networkHosting = {
        enabled: false,
        restartRequired: true,
        error: error.message || 'No se pudo preparar la publicación en LAN.'
      };
    }
  }
  await trySyncAllPosAccountsToFirebase().catch((error) => {
    console.warn('No se pudieron sincronizar los usuarios POS a Firebase:', error.message);
  });
  if (!forceReset) {
    await registerPosLicenseInFirestore({
      businessName,
      adminEmail,
      trialEndsAt,
      businessStructureMode,
    });
  }
  await writeAuditLog({
    userId: sessionData.userId,
    userName: adminName,
    userRole: 'Administrador',
    moduleName: 'Sistema',
    actionName: forceReset ? 'Sistema reinstalado' : 'Configuración inicial completada',
    detail: `${businessName} · ${getBusinessTemplate(businessType).label} · ${businessStructureMode} · prueba 30 días`
  });

  const bootstrap = await getBootstrapData();
  const currentUserRows = await query(
    `SELECT u.*, r.codigo AS role_code, r.nombre AS role_name, r.permisos AS role_permissions
     FROM users u LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.id = ? LIMIT 1`,
    [sessionData.userId]
  );
  const currentUser = mapUserRow(currentUserRows[0]);
  bootstrap.currentUser = currentUser;
  bootstrap.caja = {
    sessionId: sessionData.sessionId,
    abierta: true
  };

  const token = await createAuthSession(currentUserRows[0], req.ip, req.headers['user-agent']);

  res.status(201).json({
    ok: true,
    token,
    user: currentUser,
    data: normalizeJsonValue(bootstrap),
    networkHosting
  });
});

// ─── Wizard: validar credenciales (multicaja/multisucursal) ─────────────────
app.post('/api/wizard/validate-auth', async (req, res) => {
  try {
    const access = await authorizeWizardInstallationAccess(req.body || {});
    return res.json({
      ok: true,
      user: access.userPayload,
      branches: access.branches,
      cashRegisters: access.cashRegisters
    });
  } catch (err) {
    console.error('[wizard/validate-auth]', err);
    return res.status(Number(err.statusCode || 500)).json({ error: err.message || 'Error interno al validar las credenciales.' });
  }
});

app.post('/api/wizard/network-bootstrap', async (req, res) => {
  try {
    const access = await authorizeWizardInstallationAccess(req.body || {});
    const networkProfile = await buildPrimaryNetworkProfile(req);
    await logWizardNetworkAttempt({
      phase: 'validacion-principal',
      result: 'ok',
      principalHost: resolveRequestHostCandidate(req) || req.headers?.host || '',
      normalizedBaseUrl: networkProfile.principalBaseUrl,
      requestedBy: access.user?.usuario || req.body?.usuario || 'admin',
      actor: {
        userId: access.user?.id || null,
        userName: access.user?.nombre || access.user?.usuario || 'Administrador',
        userRole: access.user?.rol || 'Administrador'
      },
      sourceIp: req.ip,
      detail: `Modo: ${networkProfile.structureMode}`
    });
    return res.json({
      ok: true,
      user: access.userPayload,
      branches: access.branches,
      cashRegisters: access.cashRegisters,
      networkProfile
    });
  } catch (err) {
    console.error('[wizard/network-bootstrap]', err);
    return res.status(Number(err.statusCode || 500)).json({ error: err.message || 'No se pudo preparar el perfil del equipo principal.' });
  }
});

app.get('/api/network/identify', async (_req, res) => {
  try {
    const configRows = await query('SELECT business_name, active_branch_id FROM config WHERE id = 1 LIMIT 1');
    const config = configRows[0] || {};
    let branchName = String(config.business_name || 'Sucursal Principal').trim() || 'Sucursal Principal';
    const branchId = Number(config.active_branch_id || 0) || null;
    if (branchId) {
      const branchRows = await query('SELECT nombre FROM branches WHERE id = ? LIMIT 1', [branchId]);
      if (branchRows[0]) branchName = String(branchRows[0].nombre || branchName).trim() || branchName;
    }

    return res.json({
      ok: true,
      app: 'Tecno Caja',
      role: isMainTerminalConfig() ? 'principal' : 'terminal',
      isMain: isMainTerminalConfig(),
      businessName: String(config.business_name || 'Tecno Caja').trim() || 'Tecno Caja',
      branchName,
      serverPort: Number(process.env.PORT || 3000),
      localIp: getFirstPrivateIpv4(),
      version: String(packageJson.version || '').trim() || '0.0.0'
    });
  } catch (err) {
    console.error('[network/identify]', err);
    return res.status(500).json({ error: 'No se pudo obtener la identidad del servidor.' });
  }
});

app.get('/api/network/discover-principal', async (req, res) => {
  try {
    const candidates = await getDiscoveryCandidates(Number(process.env.PORT || 3000));
    return res.json({ ok: true, candidates, scanned: candidates.length, port: Number(process.env.PORT || 3000) });
  } catch (err) {
    console.error('[network/discover-principal]', err);
    return res.status(500).json({ ok: false, error: 'No se pudo explorar la red local.' });
  }
});

app.post('/api/wizard/test-principal', async (req, res) => {
  const rawHost = String(req.body?.principalHost || '').trim();
  let principalMeta = null;
  try {
    principalMeta = getWizardPrincipalConnectionMeta(rawHost, Number(process.env.PORT || 3000));
    const health = await probePrincipalHealth(principalMeta.baseUrl);
    await logWizardNetworkAttempt({
      phase: 'prueba-conexion',
      result: 'ok',
      principalHost: rawHost,
      normalizedBaseUrl: principalMeta.baseUrl,
      requestedBy: req.body?.usuario || 'wizard',
      sourceIp: req.ip,
      detail: `Servidor principal encontrado correctamente.`
    });
    return res.json({
      ok: true,
      normalizedBaseUrl: principalMeta.baseUrl,
      warning: principalMeta.warning || '',
      message: 'Servidor principal encontrado correctamente.',
      firewallHint: 'En la PC principal permite Node.js en el Firewall de Windows o abre el puerto TCP 3399.',
      health
    });
  } catch (err) {
    const friendlyError = mapWizardNetworkError(err, {
      host: principalMeta?.host || parseHostPortCandidate(rawHost, Number(process.env.PORT || 3000)).host || '',
      port: principalMeta?.port || parseHostPortCandidate(rawHost, Number(process.env.PORT || 3000)).port || Number(process.env.PORT || 3000)
    });
    await logWizardNetworkAttempt({
      phase: 'prueba-conexion',
      result: 'error',
      principalHost: rawHost,
      normalizedBaseUrl: principalMeta?.baseUrl || '',
      requestedBy: req.body?.usuario || 'wizard',
      sourceIp: req.ip,
      detail: friendlyError
    });
    return res.status(Number(err.statusCode || 500)).json({
      ok: false,
      error: friendlyError,
      normalizedBaseUrl: principalMeta?.baseUrl || '',
      warning: principalMeta?.warning || '',
      firewallHint: 'En la PC principal permite Node.js en el Firewall de Windows o abre el puerto TCP 3399.'
    });
  }
});

app.post('/api/wizard/remote-validate', async (req, res) => {
  const rawHost = String(req.body?.principalHost || '').trim();
  let principalMeta = null;
  try {
    principalMeta = getWizardPrincipalConnectionMeta(rawHost, Number(process.env.PORT || 3000));
    await probePrincipalHealth(principalMeta.baseUrl);
    const data = await postJsonToPeer(`${principalMeta.baseUrl}/api/wizard/network-bootstrap`, {
      usuario: req.body?.usuario,
      password: req.body?.password,
      networkKey: req.body?.networkKey,
      structureMode: req.body?.structureMode
    });
    await logWizardNetworkAttempt({
      phase: 'validacion-remota',
      result: 'ok',
      principalHost: rawHost,
      normalizedBaseUrl: principalMeta.baseUrl,
      requestedBy: req.body?.usuario || 'wizard',
      sourceIp: req.ip,
      detail: 'Conexión establecida con la PC principal.'
    });
    return res.json({
      ...(data || {}),
      warning: principalMeta.warning || '',
      normalizedBaseUrl: principalMeta.baseUrl,
      connectionMessage: 'Conexión establecida con la PC principal.'
    });
  } catch (err) {
    console.error('[wizard/remote-validate]', err);
    const friendlyError = mapWizardNetworkError(err, {
      host: principalMeta?.host || parseHostPortCandidate(rawHost, Number(process.env.PORT || 3000)).host || '',
      port: principalMeta?.port || parseHostPortCandidate(rawHost, Number(process.env.PORT || 3000)).port || Number(process.env.PORT || 3000)
    });
    await logWizardNetworkAttempt({
      phase: 'validacion-remota',
      result: 'error',
      principalHost: rawHost,
      normalizedBaseUrl: principalMeta?.baseUrl || '',
      requestedBy: req.body?.usuario || 'wizard',
      sourceIp: req.ip,
      detail: friendlyError
    });
    return res.status(Number(err.statusCode || 500)).json({
      error: friendlyError,
      warning: principalMeta?.warning || '',
      normalizedBaseUrl: principalMeta?.baseUrl || ''
    });
  }
});

// ─── Wizard: vincular terminal (multicaja/multisucursal) ─────────────────────
app.post('/api/wizard/link-terminal', async (req, res) => {
  try {
    const access = await authorizeWizardInstallationAccess(req.body || {});
    const user = access.user;
    const { branchId, cashRegisterId, terminalName, structureMode, language } = req.body || {};
    const bId = Number(branchId || 0);
    const crId = Number(cashRegisterId || 0);
    if (!bId || !crId) {
      return res.status(400).json({ error: 'Selecciona sucursal y caja para vincular el terminal.' });
    }
    const branch = (await query(`SELECT * FROM branches WHERE id = ? AND estado = 'Activa' LIMIT 1`, [bId]))[0];
    if (!branch) return res.status(404).json({ error: 'Sucursal no encontrada o inactiva.' });
    const register = (await query(`SELECT * FROM cash_registers WHERE id = ? AND estado = 'Activa' LIMIT 1`, [crId]))[0];
    if (!register) return res.status(404).json({ error: 'Caja no encontrada o inactiva.' });
    if (Number(register.branch_id || 0) !== bId) {
      return res.status(400).json({ error: 'La caja seleccionada no pertenece a la sucursal elegida.' });
    }

    const mode = normalizeBusinessStructureMode(structureMode) || 'multicaja';
    const lang = String(language || 'es').trim().toLowerCase();

    const terminalConfig = {
      terminalId: crypto.randomBytes(8).toString('hex'),
      terminalName: String(terminalName || register.nombre).trim(),
      branchId: bId,
      branchName: branch.nombre,
      cashRegisterId: crId,
      cashRegisterName: register.nombre,
      setupMode: mode,
      language: lang,
      linkedAt: new Date().toISOString(),
      linkedBy: user.usuario,
      linkedUserId: user.id
    };

    saveTerminalConfig(terminalConfig);

    if (isMysqlDeployment()) {
      await query(
        `UPDATE config SET business_structure_mode = ?, language = ?, setup_completed = 1, setup_completed_at = datetime('now') WHERE id = 1`,
        [mode, lang]
      );
    } else {
      await query(
        `UPDATE config SET business_structure_mode = ?, language = ?, setup_completed = 1, setup_completed_at = datetime('now'), active_branch_id = ?, active_cash_register_id = ? WHERE id = 1`,
        [mode, lang, bId, crId]
      );
    }

    await writeAuditLog({
      userId: user.id,
      userName: user.nombre || user.usuario,
      userRole: user.rol,
      moduleName: 'Sistema',
      actionName: 'Terminal vinculado',
      detail: `Modo: ${mode} | Sucursal: ${branch.nombre} | Caja: ${register.nombre} | Terminal: ${terminalConfig.terminalName}`
    });

    return res.json({ ok: true, terminalConfig });
  } catch (err) {
    console.error('[wizard/link-terminal]', err);
    return res.status(Number(err.statusCode || 500)).json({ error: err.message || 'Error al vincular el terminal.' });
  }
});

app.post('/api/wizard/network-finalize-terminal', async (req, res) => {
  try {
    const access = await authorizeWizardInstallationAccess(req.body || {});
    const user = access.user;
    const networkProfile = await buildPrimaryNetworkProfile(req);
    const { branchId, cashRegisterId, terminalName, structureMode, language } = req.body || {};
    const bId = Number(branchId || 0);
    const crId = Number(cashRegisterId || 0);

    if (!bId || !crId) {
      return res.status(400).json({ error: 'Selecciona sucursal y caja para continuar.' });
    }

    const branch = (await query(`SELECT * FROM branches WHERE id = ? AND estado = 'Activa' LIMIT 1`, [bId]))[0];
    if (!branch) return res.status(404).json({ error: 'Sucursal no encontrada o inactiva.' });
    const register = (await query(`SELECT * FROM cash_registers WHERE id = ? AND estado = 'Activa' LIMIT 1`, [crId]))[0];
    if (!register) return res.status(404).json({ error: 'Caja no encontrada o inactiva.' });
    if (Number(register.branch_id || 0) !== bId) {
      return res.status(400).json({ error: 'La caja seleccionada no pertenece a la sucursal elegida.' });
    }

    const mode = normalizeBusinessStructureMode(structureMode || networkProfile.structureMode) || networkProfile.structureMode || 'multicaja';
    const lang = String(language || 'es').trim().toLowerCase() || 'es';
    const terminalConfig = buildRemoteTerminalConfig({
      terminalName,
      branchId: bId,
      branchName: branch.nombre,
      cashRegisterId: crId,
      cashRegisterName: register.nombre,
      setupMode: mode,
      language: lang,
      linkedBy: user.usuario,
      linkedUserId: user.id,
      principalHost: networkProfile.principalHost,
      principalBaseUrl: networkProfile.principalBaseUrl
    });

    await writeAuditLog({
      userId: user.id,
      userName: user.nombre || user.usuario,
      userRole: user.rol,
      moduleName: 'Sistema',
      actionName: 'Terminal remoto autorizado',
      detail: `Terminal: ${terminalConfig.terminalName} | Sucursal: ${branch.nombre} | Caja: ${register.nombre}`
    });
    await logWizardNetworkAttempt({
      phase: 'enlace-principal',
      result: 'ok',
      principalHost: resolveRequestHostCandidate(req) || req.headers?.host || '',
      normalizedBaseUrl: networkProfile.principalBaseUrl,
      requestedBy: user.usuario || 'admin',
      actor: {
        userId: user.id,
        userName: user.nombre || user.usuario,
        userRole: user.rol || 'Administrador'
      },
      sourceIp: req.ip,
      detail: `Sucursal ${branch.nombre} · Caja ${register.nombre} · Terminal ${terminalConfig.terminalName}`
    });

    return res.json({
      ok: true,
      terminalConfig,
      networkProfile
    });
  } catch (err) {
    console.error('[wizard/network-finalize-terminal]', err);
    return res.status(Number(err.statusCode || 500)).json({ error: err.message || 'No se pudo autorizar el terminal remoto.' });
  }
});

app.post('/api/wizard/remote-link-terminal', async (req, res) => {
  const rawHost = String(req.body?.principalHost || '').trim();
  let principalMeta = null;
  try {
    principalMeta = getWizardPrincipalConnectionMeta(rawHost, Number(process.env.PORT || 3000));
    await probePrincipalHealth(principalMeta.baseUrl);
    const data = await postJsonToPeer(`${principalMeta.baseUrl}/api/wizard/network-finalize-terminal`, {
      usuario: req.body?.usuario,
      password: req.body?.password,
      networkKey: req.body?.networkKey,
      branchId: req.body?.branchId,
      cashRegisterId: req.body?.cashRegisterId,
      terminalName: req.body?.terminalName,
      structureMode: req.body?.structureMode,
      language: req.body?.language
    });

    const networkProfile = data?.networkProfile || {};
    const dbProfile = networkProfile?.db || {};
    if (!dbProfile.host || !dbProfile.user || !dbProfile.name) {
      return res.status(500).json({ error: 'El equipo principal devolvió un perfil MySQL incompleto.' });
    }

    const terminalConfig = buildRemoteTerminalConfig({
      ...(data?.terminalConfig || {}),
      principalHost: networkProfile.principalHost,
      principalBaseUrl: networkProfile.principalBaseUrl
    });
    if (!saveTerminalConfig(terminalConfig)) {
      return res.status(500).json({ error: 'No se pudo guardar la configuración local del terminal.' });
    }

    persistRuntimeEnvValues({
      DB_CLIENT: 'mysql',
      DB_HOST: dbProfile.host,
      DB_PORT: String(dbProfile.port || 3306),
      DB_USER: dbProfile.user,
      DB_PASSWORD: dbProfile.password || '',
      DB_NAME: dbProfile.name,
      POS_ALLOW_LAN: 'false',
      POS_BIND_HOST: '127.0.0.1',
      TECNO_CAJA_MYSQL_ALLOW_LAN: 'false',
      TECNO_CAJA_MYSQL_BIND_HOST: '127.0.0.1',
      TECNO_CAJA_LICENSE_UID: networkProfile.licenseUid || process.env.TECNO_CAJA_LICENSE_UID || ''
    });

    await logWizardNetworkAttempt({
      phase: 'enlace-remoto',
      result: 'ok',
      principalHost: rawHost,
      normalizedBaseUrl: principalMeta.baseUrl,
      requestedBy: req.body?.usuario || 'wizard',
      sourceIp: req.ip,
      detail: `Terminal ${terminalConfig.terminalName} autorizado y perfil remoto aplicado.`
    });

    return res.json({
      ok: true,
      terminalConfig,
      networkProfile,
      restartRequired: true
    });
  } catch (err) {
    console.error('[wizard/remote-link-terminal]', err);
    const friendlyError = mapWizardNetworkError(err, {
      host: principalMeta?.host || parseHostPortCandidate(rawHost, Number(process.env.PORT || 3000)).host || '',
      port: principalMeta?.port || parseHostPortCandidate(rawHost, Number(process.env.PORT || 3000)).port || Number(process.env.PORT || 3000)
    });
    await logWizardNetworkAttempt({
      phase: 'enlace-remoto',
      result: 'error',
      principalHost: rawHost,
      normalizedBaseUrl: principalMeta?.baseUrl || '',
      requestedBy: req.body?.usuario || 'wizard',
      sourceIp: req.ip,
      detail: friendlyError
    });
    return res.status(Number(err.statusCode || 500)).json({
      error: friendlyError,
      warning: principalMeta?.warning || '',
      normalizedBaseUrl: principalMeta?.baseUrl || ''
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// FASE 4 — Login offline: caché local de credenciales
// ═══════════════════════════════════════════════════════════════════════════

async function ensureOfflineTables() {
  try {
    await query(`CREATE TABLE IF NOT EXISTS local_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      usuario VARCHAR(60) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      nombre VARCHAR(120) NOT NULL,
      rol VARCHAR(40) NOT NULL,
      permisos TEXT DEFAULT NULL,
      branch_id INT DEFAULT NULL,
      cash_register_id INT DEFAULT NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'Activo',
      synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME DEFAULT NULL,
      UNIQUE KEY uq_local_users_usuario (usuario)
    )`);
    await query(`CREATE TABLE IF NOT EXISTS login_attempts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      usuario VARCHAR(60) NOT NULL,
      ip_address VARCHAR(60) DEFAULT NULL,
      success TINYINT(1) NOT NULL DEFAULT 0,
      attempted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await query(`CREATE TABLE IF NOT EXISTS sync_queue (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sync_id VARCHAR(64) NOT NULL UNIQUE,
      table_name VARCHAR(60) NOT NULL,
      record_id INT NOT NULL,
      operation VARCHAR(20) NOT NULL DEFAULT 'upsert',
      payload LONGTEXT NOT NULL,
      priority INT NOT NULL DEFAULT 5,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT DEFAULT NULL,
      last_attempt_at DATETIME DEFAULT NULL,
      synced_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (_e) { /* already exists */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS OFFLINE-FIRST: Gestión de caché y sincronización
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Inicializa el caché offline para una terminal secundaria.
 * Debe llamarse después del primer login exitoso.
 * 
 * @param {string} terminalId - ID único de la terminal secundaria
 * @param {number} branchId - ID de la sucursal
 * @param {number} cashRegisterId - ID de la caja registradora
 * @param {string} principalHost - Host del servidor principal
 * @param {string} principalBaseUrl - URL base del servidor principal
 * @returns {Promise<boolean>} true si se inicializó correctamente
 */
async function initializeOfflineCache(terminalId, branchId, cashRegisterId, principalHost, principalBaseUrl) {
  try {
    // Insertar o actualizar estado de la terminal
    await query(`
      INSERT INTO offline_terminal_cache
      (terminal_id, principal_host, principal_base_url, branch_id, cash_register_id, is_online, sync_status, last_full_sync)
      VALUES (?, ?, ?, ?, ?, 1, 'syncing', NOW())
      ON DUPLICATE KEY UPDATE
        principal_host = VALUES(principal_host),
        principal_base_url = VALUES(principal_base_url),
        branch_id = VALUES(branch_id),
        cash_register_id = VALUES(cash_register_id),
        last_full_sync = NOW()
    `, [terminalId, principalHost, principalBaseUrl, branchId, cashRegisterId]);

    console.log(`[offline-cache] Terminal ${terminalId} caché inicializado`);
    return true;
  } catch (err) {
    console.error('[offline-cache] Error inicializando caché:', err);
    return false;
  }
}

/**
 * Actualiza los productos en caché offline.
 * Sincroniza producto/precio/stock desde la BD principal.
 * 
 * @param {Array<number>} productIds - IDs de productos a cachear (null = todos)
 * @returns {Promise<number>} Cantidad de productos actualizados
 */
async function updateOfflineProductsCache(productIds = null) {
  try {
    let sql = `
      INSERT INTO offline_cache_products
      (product_id, codigo, nombre, categoria, precio_venta, stock_cached, stock_min, estado, last_updated)
      SELECT p.id, p.codigo, p.nombre, c.nombre, p.precio_venta, p.stock, p.stock_min, p.estado, NOW()
      FROM productos p
      LEFT JOIN categorias c ON p.categoria_id = c.id
      WHERE p.estado = 'Activo'
    `;
    
    if (Array.isArray(productIds) && productIds.length > 0) {
      const placeholders = productIds.map(() => '?').join(',');
      sql += ` AND p.id IN (${placeholders})`;
    }

    sql += ` ON DUPLICATE KEY UPDATE
      codigo = VALUES(codigo),
      nombre = VALUES(nombre),
      categoria = VALUES(categoria),
      precio_venta = VALUES(precio_venta),
      stock_cached = VALUES(stock_cached),
      stock_min = VALUES(stock_min),
      estado = VALUES(estado),
      last_updated = NOW()`;

    const result = await query(sql, productIds || []);
    const affectedRows = result?.affectedRows || 0;
    console.log(`[offline-cache] ${affectedRows} productos actualizados en caché`);
    return affectedRows;
  } catch (err) {
    console.error('[offline-cache] Error actualizando productos:', err);
    return 0;
  }
}

/**
 * Actualiza los clientes en caché offline (solo activos con crédito).
 * 
 * @returns {Promise<number>} Cantidad de clientes actualizados
 */
async function updateOfflineClientsCache() {
  try {
    const result = await query(`
      INSERT INTO offline_cache_clients
      (client_id, nombre, cedula, telefono, email, direccion, limite_credito, balance, last_updated)
      SELECT id, nombre, cedula, telefono, email, direccion, limite_credito, balance, NOW()
      FROM clientes
      WHERE estado = 'Activo'
      ON DUPLICATE KEY UPDATE
        nombre = VALUES(nombre),
        cedula = VALUES(cedula),
        telefono = VALUES(telefono),
        email = VALUES(email),
        direccion = VALUES(direccion),
        limite_credito = VALUES(limite_credito),
        balance = VALUES(balance),
        last_updated = NOW()
    `);
    const affectedRows = result?.affectedRows || 0;
    console.log(`[offline-cache] ${affectedRows} clientes actualizados en caché`);
    return affectedRows;
  } catch (err) {
    console.error('[offline-cache] Error actualizando clientes:', err);
    return 0;
  }
}

/**
 * Actualiza los usuarios autorizados en caché offline.
 * 
 * @returns {Promise<number>} Cantidad de usuarios actualizados
 */
async function updateOfflineUsersCache() {
  try {
    const result = await query(`
      INSERT INTO offline_cache_users
      (user_id, usuario, nombre, rol, password_hash, puede_vender, puede_cobrar, puede_ver_reportes, last_updated)
      SELECT id, usuario, nombre, rol, password_hash, 1, 1, 1, NOW()
      FROM users
      WHERE estado = 'Activo'
      ON DUPLICATE KEY UPDATE
        usuario = VALUES(usuario),
        nombre = VALUES(nombre),
        rol = VALUES(rol),
        password_hash = VALUES(password_hash),
        last_updated = NOW()
    `);
    const affectedRows = result?.affectedRows || 0;
    console.log(`[offline-cache] ${affectedRows} usuarios actualizados en caché`);
    return affectedRows;
  } catch (err) {
    console.error('[offline-cache] Error actualizando usuarios:', err);
    return 0;
  }
}

/**
 * Obtiene el estado actual del caché offline de una terminal.
 * 
 * @param {string} terminalId - ID de la terminal
 * @returns {Promise<Object>} Estado del caché
 */
async function getOfflineCacheStatus(terminalId) {
  try {
    const terminal = await query(
      'SELECT * FROM offline_terminal_cache WHERE terminal_id = ? LIMIT 1',
      [terminalId]
    );

    if (!Array.isArray(terminal) || terminal.length === 0) {
      return { initialized: false };
    }

    const tc = terminal[0];
    const products = await query('SELECT COUNT(*) as cnt FROM offline_cache_products');
    const clients = await query('SELECT COUNT(*) as cnt FROM offline_cache_clients');
    const users = await query('SELECT COUNT(*) as cnt FROM offline_cache_users');
    const pendingSales = await query(
      'SELECT COUNT(*) as cnt, SUM(total) as totalAmount FROM pending_sales WHERE status IN ("pending", "syncing")'
    );

    return {
      initialized: true,
      isOnline: tc.is_online,
      syncStatus: tc.sync_status,
      lastFullSync: tc.last_full_sync,
      lastHealthCheck: tc.last_health_check,
      productsCached: Array.isArray(products) ? products[0]?.cnt || 0 : 0,
      clientsCached: Array.isArray(clients) ? clients[0]?.cnt || 0 : 0,
      usersCached: Array.isArray(users) ? users[0]?.cnt || 0 : 0,
      pendingSalesCount: Array.isArray(pendingSales) && pendingSales[0] 
        ? pendingSales[0].cnt || 0
        : 0,
      pendingSalesTotalAmount: Array.isArray(pendingSales) && pendingSales[0]
        ? pendingSales[0].totalAmount || 0
        : 0
    };
  } catch (err) {
    console.error('[offline-cache] Error obteniendo estado:', err);
    return { error: err.message };
  }
}

/**
 * Marca un evento de conexión/desconexión para una terminal.
 * 
 * @param {string} terminalId - ID de la terminal
 * @param {boolean} isOnline - true si está online, false si offline
 * @param {string} status - Estado de sync: 'online', 'offline', 'syncing'
 */
async function updateTerminalOnlineStatus(terminalId, isOnline, status = null) {
  try {
    const finalStatus = status || (isOnline ? 'online' : 'offline');
    await query(
      'UPDATE offline_terminal_cache SET is_online = ?, sync_status = ?, last_health_check = NOW() WHERE terminal_id = ?',
      [isOnline ? 1 : 0, finalStatus, terminalId]
    );
  } catch (err) {
    console.error('[offline-cache] Error actualizando estado de terminal:', err);
  }
}

/**
 * Registra un evento de sincronización en el histórico.
 * 
 * @param {string} terminalId - ID de la terminal
 * @param {string} phase - Fase de sync: 'upload', 'download', 'confirm', 'full'
 * @param {number} itemsUploaded - Cantidad de items subidos
 * @param {number} itemsDownloaded - Cantidad de items descargados
 * @param {string} result - Resultado: 'ok', 'partial', 'error'
 * @param {string} errorDetail - Detalle del error si aplica
 */
async function logSyncEvent(terminalId, phase, itemsUploaded = 0, itemsDownloaded = 0, result = 'ok', errorDetail = null) {
  try {
    await query(`
      INSERT INTO sync_log
      (terminal_id, sync_phase, items_uploaded, items_downloaded, error_count, started_at, completed_at, result, error_detail)
      VALUES (?, ?, ?, ?, 0, NOW(), NOW(), ?, ?)
    `, [terminalId, phase, itemsUploaded, itemsDownloaded, result, errorDetail]);
  } catch (err) {
    console.error('[sync-log] Error registrando evento:', err);
  }
}

/**
 * Genera un ID único para venta offline.
 * Formato: {terminalId}#{secuencial}#{timestamp}
 * 
 * @param {string} terminalId - ID de la terminal
 * @returns {Promise<string>} ID offline único
 */
async function generateOfflineInvoiceId(terminalId) {
  try {
    // Obtener último secuencial para esta terminal
    const lastResult = await query(`
      SELECT SUBSTRING_INDEX(offline_invoice_id, '#', -2) as lastPart
      FROM pending_sales
      WHERE terminal_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `, [terminalId]);

    let seq = 1;
    if (Array.isArray(lastResult) && lastResult.length > 0) {
      const lastPart = lastResult[0]?.lastPart;
      if (lastPart) {
        const parts = lastPart.split('#');
        const lastSeq = parseInt(parts[0], 10);
        if (!isNaN(lastSeq)) seq = lastSeq + 1;
      }
    }

    const timestamp = Date.now();
    return `${terminalId}#${seq}#${timestamp}`;
  } catch (err) {
    console.error('[offline-invoice] Error generando ID:', err);
    // Fallback: generar algo al menos único
    return `${terminalId}#${Date.now()}`;
  }
}

// Cachear usuario después de login exitoso (para login offline futuro)
app.post('/api/auth/cache-offline', async (req, res) => {
  try {
    const user = await resolveRequestActorUser(req, { required: false });
    if (!user?.id) return res.status(401).json({ error: 'Sesión no válida.' });

    const rows = await query('SELECT * FROM users WHERE id = ? LIMIT 1', [user.id]);
    const fullUser = rows[0];
    if (!fullUser) return res.status(404).json({ error: 'Usuario no encontrado.' });

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 días

    await query(`INSERT INTO local_users
      (user_id, usuario, password_hash, nombre, rol, permisos, branch_id, cash_register_id, estado, synced_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
      ON DUPLICATE KEY UPDATE
        password_hash = VALUES(password_hash),
        nombre = VALUES(nombre),
        rol = VALUES(rol),
        permisos = VALUES(permisos),
        branch_id = VALUES(branch_id),
        cash_register_id = VALUES(cash_register_id),
        estado = VALUES(estado),
        synced_at = CURRENT_TIMESTAMP,
        expires_at = VALUES(expires_at)
    `, [
      fullUser.id,
      fullUser.usuario,
      fullUser.password_hash || fullUser.password,
      fullUser.nombre,
      fullUser.rol,
      typeof fullUser.permisos === 'string' ? fullUser.permisos : JSON.stringify(fullUser.permisos || []),
      fullUser.branch_id || null,
      fullUser.caja_id || null,
      fullUser.estado,
      expiresAt.toISOString().slice(0, 19).replace('T', ' ')
    ]);

    return res.json({ ok: true, cachedUntil: expiresAt });
  } catch (err) {
    console.error('[auth/cache-offline]', err);
    return res.status(500).json({ error: 'Error al guardar caché offline.' });
  }
});

// Login offline — consulta el caché SQLite local, siempre disponible aunque MySQL esté caído
app.post('/api/auth/offline-login', loginLimiter, async (req, res) => {
  try {
    const { usuario, password } = req.body || {};
    if (!usuario || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos.' });

    // Usar la BD SQLite local (no depende de MySQL)
    const rows = await localQuery(
      `SELECT * FROM offline_cache_users WHERE usuario = ? LIMIT 1`,
      [String(usuario).trim()]
    );
    const localUser = rows[0];
    if (!localUser) {
      return res.status(401).json({
        error: 'Usuario no encontrado en caché local. Necesitas hacer login en línea al menos una vez.'
      });
    }

    const validPass = userPasswordMatches(localUser, String(password));
    if (!validPass) {
      return res.status(401).json({ error: 'Contraseña incorrecta.' });
    }

    const offlineUser = {
      id: Number(localUser.user_id),
      usuario: localUser.usuario,
      nombre: localUser.nombre,
      rol: localUser.rol,
      role_code: localUser.rol,
      role_name: localUser.rol,
      role_permissions: [],
      permisos: [],
      branch_id: null,
      caja_id: null,
      estado: 'activo',
      offlineSession: true,
      offlineSince: new Date().toISOString()
    };

    // Crear token en memoria para que las peticiones siguientes se autentiquen
    const offlineToken = require('crypto').randomBytes(32).toString('hex');
    _authSessionCache.set(offlineToken, {
      user: offlineUser,
      expiresAt: Date.now() + TECNO_CAJA_AUTH_SESSION_TTL_MS
    });

    return res.json({ ok: true, token: offlineToken, user: offlineUser, offlineMode: true });
  } catch (err) {
    console.error('[auth/offline-login]', err);
    return res.status(500).json({ error: 'Error en login offline.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// HEALTH CHECK - Detección de conexión para offline-manager
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/health', async (req, res) => {
  // Responder rápido con ok:true aunque la BD tenga problemas temporales.
  // El health check sólo falla si la query tarda más de 4 s (timeout de BD)
  // o si el proceso Express mismo no puede responder.
  try {
    const dbCheck = await Promise.race([
      query('SELECT 1 as ok'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB query timeout')), 4000))
    ]);
    if (!dbCheck || !Array.isArray(dbCheck)) {
      return res.status(503).json({ error: 'BD no disponible', ok: false });
    }
    const configRows = await query(
      'SELECT business_name, business_structure_mode FROM config WHERE id = 1 LIMIT 1'
    ).catch(() => []);
    const config = configRows[0] || {};
    return res.json({
      status: 'OK',
      server: 'Tecno Caja',
      database: 'Connected',
      time: new Date().toISOString(),
      ok: true,
      version: packageJson.version,
      businessName: String(config.business_name || 'Tecno Caja').trim() || 'Tecno Caja',
      businessStructureMode: normalizeBusinessStructureMode(config.business_structure_mode) || 'monocaja',
      lanAddresses: getLanIpv4Addresses(),
      port: Number(process.env.PORT || 3000) || 3000
    });
  } catch (err) {
    console.warn('[health] Error en health check:', err.message);
    return res.status(503).json({
      status: 'ERROR',
      server: 'Tecno Caja',
      database: 'Disconnected',
      ok: false,
      error: err.message,
      time: new Date().toISOString()
    });
  }
});

// ✅ Los endpoints /api/offline/* ahora están en server/routes/offline.routes.js
// Registrados más arriba bajo app.use('/api/offline', offlineRouter)

// ═══════════════════════════════════════════════════════════════════════════
// FASE 6 — Sincronización: cola local → servidor central
// ═══════════════════════════════════════════════════════════════════════════

// DEPRECADO: Endpoint antiguo. Usar nuevo router en /server/routes/sync.routes.js
// app.get('/api/sync/status', ...) => Manejado por Firebase Sync Service

// Encolar registro para sincronización
app.post('/api/sync/enqueue', async (req, res) => {
  try {
    const { tableName, recordId, operation, payload } = req.body || {};
    if (!tableName || !recordId || !payload) {
      return res.status(400).json({ error: 'Faltan campos requeridos.' });
    }
    await ensureOfflineTables();
    const syncId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    await query(`INSERT IGNORE INTO sync_queue (sync_id, table_name, record_id, operation, payload, status)
      VALUES (?, ?, ?, ?, ?, 'pending')`,
      [syncId, tableName, Number(recordId), operation || 'upsert', JSON.stringify(payload)]
    );
    return res.json({ ok: true, syncId });
  } catch (err) {
    return res.status(500).json({ error: 'Error al encolar.' });
  }
});

// Ver cola pendiente
app.get('/api/sync/queue', async (req, res) => {
  try {
    await ensureOfflineTables();
    const rows = await query(`
      SELECT sync_id, table_name, record_id, operation, status, attempts, created_at
      FROM sync_queue
      WHERE status IN ('pending','failed')
      ORDER BY priority ASC, created_at ASC
      LIMIT 100
    `);
    return res.json({ ok: true, queue: rows });
  } catch (err) {
    return res.status(500).json({ error: 'Error al leer cola.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// FASE 5 — Panel central: reportes consolidados por sucursal/caja
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/admin/ventas-por-sucursal', async (req, res) => {
  try {
    const actorUser = await resolveRequestActorUser(req, { required: true });
    if (!isGlobalAdministratorUser(actorUser) && !userRoleHasPermission(actorUser, 'ver_reportes_globales')) {
      return res.status(403).json({ error: 'Sin permisos para ver reportes globales.' });
    }
    const { desde, hasta } = req.query;
    const filters = [];
    const params  = [];
    if (desde) { filters.push('s.created_at >= ?'); params.push(desde + ' 00:00:00'); }
    if (hasta) { filters.push('s.created_at <= ?'); params.push(hasta + ' 23:59:59'); }
    const where = filters.length ? 'AND ' + filters.join(' AND ') : '';

    const rows = await query(`
      SELECT
        b.id AS branch_id,
        b.nombre AS sucursal,
        COUNT(s.id) AS total_ventas,
        COALESCE(SUM(s.total), 0) AS total_monto,
        COALESCE(SUM(s.total - s.discount - s.tax), 0) AS subtotal_neto,
        COUNT(CASE WHEN s.sale_status = 'pendiente_cobro' THEN 1 END) AS pendientes_cobro,
        COUNT(CASE WHEN s.sale_status = 'anulada' THEN 1 END) AS anuladas
      FROM branches b
      LEFT JOIN sales s ON s.branch_id = b.id
        AND s.sale_status NOT IN ('borrador')
        ${where}
      WHERE b.estado = 'Activa'
      GROUP BY b.id, b.nombre
      ORDER BY total_monto DESC
    `, params);

    return res.json({ ok: true, data: rows });
  } catch (err) {
    return res.status(500).json({ error: 'Error al generar reporte.' });
  }
});

app.get('/api/admin/ventas-por-caja', async (req, res) => {
  try {
    const actorUser = await resolveRequestActorUser(req, { required: true });
    if (!isGlobalAdministratorUser(actorUser) && !userRoleHasPermission(actorUser, 'ver_reportes_globales')) {
      return res.status(403).json({ error: 'Sin permisos para ver reportes globales.' });
    }
    const { desde, hasta, branch_id } = req.query;
    const params  = [];
    const filters = [];
    if (desde) { filters.push('s.created_at >= ?'); params.push(desde + ' 00:00:00'); }
    if (hasta) { filters.push('s.created_at <= ?'); params.push(hasta + ' 23:59:59'); }
    if (branch_id) { filters.push('cr.branch_id = ?'); params.push(Number(branch_id)); }
    const where = filters.length ? 'AND ' + filters.join(' AND ') : '';

    const rows = await query(`
      SELECT
        cr.id AS cash_register_id,
        cr.nombre AS caja,
        cr.register_type,
        b.nombre AS sucursal,
        COUNT(s.id) AS total_ventas,
        COALESCE(SUM(s.total), 0) AS total_monto,
        COUNT(CASE WHEN s.sale_status = 'pendiente_cobro' THEN 1 END) AS pendientes_cobro
      FROM cash_registers cr
      LEFT JOIN branches b ON b.id = cr.branch_id
      LEFT JOIN sales s ON s.cash_register_id = cr.id
        AND s.sale_status NOT IN ('borrador')
        ${where}
      WHERE cr.estado = 'Activa'
      GROUP BY cr.id, cr.nombre, cr.register_type, b.nombre
      ORDER BY total_monto DESC
    `, params);

    return res.json({ ok: true, data: rows });
  } catch (err) {
    return res.status(500).json({ error: 'Error al generar reporte.' });
  }
});

app.get('/api/admin/ventas-pendientes-cobro', async (req, res) => {
  try {
    const actorUser = await resolveRequestActorUser(req, { required: true });
    if (!isGlobalAdministratorUser(actorUser) && !userRoleHasPermission(actorUser, 'ver_reportes_globales')) {
      return res.status(403).json({ error: 'Sin permisos para ver reportes globales.' });
    }
    const rows = await query(`
      SELECT
        s.id, s.invoice_number, s.total, s.created_at,
        s.client_name_snapshot AS cliente,
        s.billed_by_user_id, s.billed_branch_id,
        b_bill.nombre AS sucursal_factura,
        cr_bill.nombre AS caja_factura,
        u_bill.nombre AS cajero_factura
      FROM sales s
      LEFT JOIN branches b_bill ON b_bill.id = s.billed_branch_id
      LEFT JOIN cash_registers cr_bill ON cr_bill.id = s.billed_cash_register_id
      LEFT JOIN users u_bill ON u_bill.id = s.billed_by_user_id
      WHERE s.sale_status = 'pendiente_cobro'
      ORDER BY s.created_at DESC
      LIMIT 200
    `);
    return res.json({ ok: true, data: rows });
  } catch (err) {
    return res.status(500).json({ error: 'Error al obtener ventas pendientes.' });
  }
});

// Cola de cobro — ventas facturadas en caja de facturación, pendientes de pago en caja de cobro
app.get('/api/cola-cobro', async (req, res) => {
  try {
    const actorUser = await resolveRequestActorUser(req, { required: false });
    const actorBillingCaps = getBillingFunctionCapabilities(actorUser?.tipo_facturacion || actorUser?.tipoFacturacion || 'mixta');
    if (actorUser && !actorBillingCaps.canChargePending) {
      return res.status(403).json({
        error: `El usuario ${actorUser.nombre || actorUser.usuario || 'actual'} está configurado solo para facturación y no puede cobrar facturas pendientes.`
      });
    }
    const branchId = actorUser ? (getUserScopeBranchId(actorUser) || null) : null;
    const whereClause = branchId ? 'WHERE s.sale_status = \'pendiente_cobro\' AND s.branch_id = ?' : 'WHERE s.sale_status = \'pendiente_cobro\'';
    const params = branchId ? [branchId] : [];
    const rows = await query(`
      SELECT
        s.id, s.invoice_number, s.total, s.created_at,
        s.client_id, s.client_name_snapshot AS cliente,
        s.client_phone_snapshot AS cliente_telefono,
        s.payment_method, s.subtotal, s.discount, s.tax,
        s.billed_by_user_id, s.billed_branch_id, s.billed_cash_register_id,
        b_bill.nombre AS sucursal_factura,
        cr_bill.nombre AS caja_factura,
        u_bill.nombre AS cajero_factura
      FROM sales s
      LEFT JOIN branches b_bill ON b_bill.id = s.billed_branch_id
      LEFT JOIN cash_registers cr_bill ON cr_bill.id = s.billed_cash_register_id
      LEFT JOIN users u_bill ON u_bill.id = s.billed_by_user_id
      ${whereClause}
      ORDER BY s.created_at ASC
    `, params);
    return res.json({ ok: true, data: rows });
  } catch (err) {
    return res.status(500).json({ error: 'Error al obtener cola de cobro.' });
  }
});

// Cobrar una venta pendiente_cobro
app.post('/api/cola-cobro/:id/cobrar', async (req, res) => {
  try {
    const actorUser = await resolveRequestActorUser(req, { required: true });
    const ventaId = Number(req.params.id);
    const { recibido, cambio, branchId: reqBranchId, cashRegisterId: reqCashRegisterId } = req.body || {};

    const ventaCheck = await query('SELECT * FROM sales WHERE id = ? LIMIT 1', [ventaId]);
    if (!ventaCheck.length) return res.status(404).json({ error: 'Venta no encontrada.' });
    if (String(ventaCheck[0].sale_status || '') !== 'pendiente_cobro') {
      return res.status(409).json({ error: 'Esta venta no está pendiente de cobro.' });
    }

    const updatedVenta = await withTransaction(async (conn) => {
      const saleRows = await conn.query('SELECT * FROM sales WHERE id = ? LIMIT 1', [ventaId]);
      const venta = saleRows[0];
      const nowSql = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const structure = await resolveBusinessStructureSelection(conn, reqBranchId, reqCashRegisterId);
      const billingAccess = await resolveEffectiveBillingAccess(conn, actorUser, structure.cashRegisterId);

      if (!billingAccess.canChargePending) {
        const error = new Error(`Tu usuario está configurado como ${billingAccess.userTypeLabel} y no puede cobrar facturas pendientes desde una caja ${billingAccess.cashRegisterTypeLabel}.`);
        error.statusCode = 403;
        throw error;
      }

      await conn.query(
        `UPDATE sales
         SET sale_status = 'pagada',
             charged_branch_id = ?,
             charged_cash_register_id = ?,
             charged_by_user_id = ?,
             charged_at = ?,
             received_amount = COALESCE(?, total),
             change_amount = COALESCE(?, 0)
         WHERE id = ?`,
        [
          structure.branchId,
          structure.cashRegisterId,
          actorUser.id,
          nowSql,
          recibido != null ? Number(recibido) : null,
          cambio != null ? Number(cambio) : null,
          ventaId
        ]
      );

      // Apuntar el pago a la sesión de caja abierta si existe
      try {
        const sessionRows = await conn.query(
          `SELECT id FROM cash_sessions WHERE cash_register_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1`,
          [structure.cashRegisterId]
        );
        if (sessionRows.length) {
          await conn.query(
            `UPDATE cash_sessions SET current_amount = current_amount + ? WHERE id = ?`,
            [Number(venta.total || 0), sessionRows[0].id]
          );
        }
      } catch (_) { /* non-fatal: cash_sessions may not be open */ }

      return venta;
    });

    await writeAuditLog({
      userId: actorUser.id,
      userName: actorUser.nombre,
      userRole: actorUser.rol,
      moduleName: 'Cola de Cobro',
      actionName: 'Cobro registrado',
      detail: `Factura ${updatedVenta.invoice_number} cobrada por RD$ ${updatedVenta.total}`
    });

    const rows = await query(
      'SELECT s.*, u.nombre AS cashier_name, COALESCE(c.nombre, "Consumidor Final") AS client_name, COALESCE(c.telefono, "") AS client_phone FROM sales s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN clients c ON c.id = s.client_id WHERE s.id = ?',
      [ventaId]
    );
    const items = await query(
      'SELECT si.*, p.nombre AS product_name FROM sale_items si LEFT JOIN products p ON p.id = si.product_id WHERE sale_id = ?',
      [ventaId]
    );

    return res.json({
      ok: true,
      data: rows[0] || {},
      sale: mapSaleRows(rows, items)[0] || null,
      config: await getConfig({ syncRemote: false })
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ error: err.message || 'Error al registrar cobro.' });
  }
});

app.post('/api/license/activate', async (req, res) => {
  const activationKey = String(req.body?.activationKey || '').trim();
  if (!activationKey || activationKey !== DEFAULT_LICENSE_ACTIVATION_KEY) {
    return res.status(403).json({ error: 'La clave de activación no es válida.' });
  }

  const activatedBy = String(req.body?.activatedBy || req.body?.actorUserName || 'Administrador externo').trim();
  const licenseResult = await secureLicenseService.resolveState({
    force: true,
    allowRemote: true,
  });

  if (!licenseResult?.license?.canEnter) {
    return res.status(409).json({
      error: getLicenseDeniedMessage(licenseResult?.license || {}),
      license: licenseResult?.license || null,
    });
  }

  await writeAuditLog({
    userId: null,
    userName: activatedBy,
    userRole: 'Licenciamiento',
    moduleName: 'Sistema',
    actionName: 'Licencia revalidada',
    detail: 'Se forzó una revalidación contra Firebase y el sistema quedó habilitado'
  });
  res.json({
    ok: true,
    config: await getConfig({ syncRemote: false, licenseResult })
  });
});

app.get('/api/license/status', async (_req, res) => {
  const refreshRequested = ['1', 'true', 'yes', 'on'].includes(
    String(_req.query?.refresh || '').trim().toLowerCase()
  );
  const syncResult = await secureLicenseService.resolveState({
    force: refreshRequested,
    allowRemote: refreshRequested,
  });
  const config = await getConfig({ syncRemote: false, licenseResult: syncResult });
  const license = syncResult?.license || {};
  const licenseUid = String(syncResult?.licenseUid || process.env.TECNO_CAJA_LICENSE_UID || '').trim();
  res.json({
    syncedFromAdmin: Boolean(syncResult?.synced),
    syncReason: syncResult?.reason || null,
    source: syncResult?.source || 'unknown',
    licenseUid: licenseUid || null,
    businessName: config.nombre || null,
    license: {
      status: license.status || config.licenseStatus,
      planCode: license.planCode || config.planCode || 'basico',
      planName: license.planName || config.planName || 'Tecno Caja Básico',
      trialStartedAt: license.trialStartedAt || config.trialStartedAt,
      trialEndsAt: license.trialEndsAt || config.trialEndsAt,
      expiresAt: license.expiresAt || config.trialEndsAt,
      daysLeft: typeof license.daysLeft === 'number' ? license.daysLeft : config.trialDaysLeft,
      expired: Boolean(license.expired ?? config.trialExpired),
      suspended: Boolean(license.suspended || license.status === 'suspended'),
      canEnter: Boolean(license.canEnter),
      message: license.canEnter ? null : getLicenseDeniedMessage(license),
      blockedCode: license.blockedCode || null,
      deviceId: license.deviceId || null,
      deviceLimit: license.deviceLimit || null,
      offlineGraceDays: license.offlineGraceDays || null,
      offlineDaysRemaining: license.offlineDaysRemaining ?? null,
      lastValidatedAt: license.lastValidatedAt || null,
      validationMode: license.validationMode || null,
      source: syncResult?.source || 'unknown',
    }
  });
});

app.get('/api/bootstrap', async (req, res) => {
  const setupStatus = await getSetupStatus();
  if (setupStatus.setupRequired) {
    return res.status(423).json({ error: 'Debes completar el asistente inicial antes de cargar la aplicación.' });
  }
  if (!setupStatus.license.canEnter) {
    return res.status(403).json({ error: getLicenseDeniedMessage(setupStatus.license) });
  }
  const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: false });
  res.json(await getBootstrapData(actorUser));
});

app.get('/api/business-templates', async (req, res) => {
  ensureNotCashier(req);
  res.json({
    items: listBusinessTypes()
  });
});

app.get('/api/business-templates/:type', async (req, res) => {
  ensureNotCashier(req);
  const businessType = String(req.params.type || '').trim().toLowerCase();
  if (!BUSINESS_TEMPLATES[businessType]) {
    return res.status(404).json({ error: 'El tipo de negocio demo solicitado no existe.' });
  }
  res.json(buildBusinessTemplatePreview(businessType));
});

app.get('/api/firebase-sync/status', async (_req, res) => {
  res.json(getFirebaseConfigStatus());
});

app.post('/api/firebase-sync/clients', async (req, res) => {
  const actor = getActor(req);
  const status = getFirebaseConfigStatus();
  if (!status.adminEnabled) {
    return res.status(503).json({
      error: status.adminReason || status.reason || 'Firebase Admin no esta configurado.',
      collection: status.collection
    });
  }

  const result = await trySyncAllPosClientsToFirebase();
  await writeAuditLog({
    ...actor,
    moduleName: 'Clientes',
    actionName: 'Clientes POS sincronizados a Firebase',
    detail: `${result.total || 0} registros -> ${result.collection || status.collection}`
  });
  res.json(result);
});

app.post('/api/firebase-sync/accounts', async (req, res) => {
  const actor = getActor(req);
  const status = getFirebaseConfigStatus();
  if (!status.adminEnabled) {
    return res.status(503).json({
      error: status.adminReason || status.reason || 'Firebase Admin no esta configurado.',
      collection: status.collection
    });
  }

  const result = await trySyncAllPosAccountsToFirebase();
  await writeAuditLog({
    ...actor,
    moduleName: 'Usuarios',
    actionName: 'Usuarios POS sincronizados a Firebase',
    detail: `${result.total || 0} registros -> ${result.usersCollection || 'usuarios'} / ${result.licensesCollection || 'licencias'}`
  });
  res.json(result);
});

/**
 * Sincroniza TODOS los usuarios staff al Firebase Authentication (crea cuentas
 * Firebase para los que aún no las tienen y actualiza las existentes).
 * Útil para la migración inicial cuando el sistema ya tiene usuarios registrados.
 */
app.post('/api/firebase-sync/auth-all', async (req, res) => {
  const actorUser = await resolveRequestActorUser(req, { required: true }).catch(() => null);
  if (!actorUser || !isGlobalAdministratorUser(actorUser)) {
    return res.status(403).json({ error: 'Solo el administrador general puede ejecutar esta operación.' });
  }
  const status = getFirebaseConfigStatus();
  if (!status.adminEnabled) {
    return res.status(503).json({
      error: status.adminReason || status.reason || 'Firebase Admin no está configurado.',
    });
  }
  const result = await trySyncAllStaffToFirebaseAuth();
  await writeAuditLog({
    userId: actorUser.id,
    userName: actorUser.nombre,
    userRole: actorUser.rol,
    moduleName: 'Usuarios',
    actionName: 'Sincronización masiva Firebase Auth',
    detail: `${result.synced || 0} sincronizados, ${result.skipped || 0} omitidos, ${result.failed || 0} fallidos de ${result.total || 0} usuarios`,
  });
  res.json(result);
});

/**
 * Backfill completo del POS a Firestore (proyecto reporte-sistema-pos).
 * Toma branches, cajas, productos, clientes, ventas (90 días), cash movements (90 días).
 * Úsese la primera vez que se conecta el POS al nuevo proyecto Firebase.
 */
app.post('/api/firebase-reports/bootstrap', async (req, res) => {
  const actorUser = await resolveRequestActorUser(req, { required: true }).catch(() => null);
  if (actorUser && !isGlobalAdministratorUser(actorUser)) {
    return res.status(403).json({ error: 'Solo el administrador general puede ejecutar este bootstrap.' });
  }
  if (!reportsSync.isEnabled()) {
    return res.status(503).json({ error: 'Firebase no está configurado todavía. Verifica TECNO_CAJA_FIREBASE_SERVICE_ACCOUNT y reinicia el POS.' });
  }
  try {
    const bootstrap = require('./modules/firebase-reports-bootstrap');
    const config = await getReportSyncConfig();
    const report = await bootstrap.bootstrapAll({ query }, config);
    await writeAuditLog({
      userId: actorUser?.id || null,
      userName: actorUser?.nombre || 'Admin',
      userRole: actorUser?.rol || 'Administrador',
      moduleName: 'Reportes nube',
      actionName: 'Bootstrap reporte-sistema-pos',
      detail: `businesses=${report.businessId} sales=${report.sales} products=${report.products} customers=${report.customers}`
    });
    res.json(report);
  } catch (err) {
    console.error('[firebase-reports/bootstrap] falló:', err);
    res.status(500).json({ error: err.message || 'Bootstrap falló.' });
  }
});

/**
 * Estado: indica si el módulo de reportes-sync está activo y qué businessId se usa.
 */
app.get('/api/firebase-reports/status', async (_req, res) => {
  const enabled = reportsSync.isEnabled();
  const config = await getReportSyncConfig();
  res.json({
    enabled,
    businessId: reportsSync.getBusinessId(config),
    licenseUid: process.env.TECNO_CAJA_LICENSE_UID || null,
    note: enabled
      ? 'Sync activo a proyecto Firebase configurado (reporte-sistema-pos).'
      : 'Firebase Admin no inicializado todavía — revisa la credencial de servicio.'
  });
});

/**
 * Re-envía el perfil de un usuario existente como cuenta Firebase Auth + users/{uid}.
 * Útil para migrar usuarios ya creados antes de habilitar el sync.
 */
app.post('/api/firebase-reports/user/:id', async (req, res) => {
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!isGlobalAdministratorUser(actorUser)) {
    return res.status(403).json({ error: 'Solo el administrador general puede gestionar cuentas Firebase.' });
  }
  if (!reportsSync.isEnabled()) {
    return res.status(503).json({ error: 'Firebase no está configurado.' });
  }
  const id = Number(req.params.id);
  const rows = await query('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });
  const password = req.body?.password || req.body?.contrasena || '';
  const cfg = await getReportSyncConfig();
  try {
    await ensureFirebaseIdentityAvailability({
      businessName: cfg?.nombre || '',
      username: user.usuario,
      email: user.email,
      currentLocalUserId: user.id,
      currentFirebaseUid: user.firebase_uid || '',
      skipBusinessConflictCheck: true,
    });
  } catch (error) {
    return res.status(Number(error.statusCode || 500)).json({ error: error.message || 'No se pudo validar el usuario en Firebase.' });
  }
  const result = await reportsSync.ensureFirebaseUser({
    email: user.email,
    password,
    nombre: user.nombre,
    usuario: user.usuario,
    rol: user.rol || user.role_code || 'supervisor',
    estado: user.estado || 'Activo',
    branch_ids: user.sucursal_id ? [String(user.sucursal_id)] : [],
    allowed_modules: [],
    created_at: user.fecha_creacion || new Date(),
  }, { config: cfg });
  if (!result) {
    return res.status(409).json({ error: 'No se pudo crear/actualizar la cuenta Firebase (probablemente falta contraseña).' });
  }
  if (result.uid && result.uid !== user.firebase_uid) {
    await query('UPDATE users SET firebase_uid = ? WHERE id = ?', [result.uid, id]);
  }
  res.json({ ok: true, ...result });
});

/**
 * Sincroniza el resumen fiscal (NCF/DGII) de un período a businesses/{businessId}/taxReports.
 * Body: { desde: 'YYYY-MM-DD', hasta: 'YYYY-MM-DD', branchId?: number }
 */
app.post('/api/firebase-reports/sync-tax-report', async (req, res) => {
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!isGlobalAdministratorUser(actorUser)) {
    return res.status(403).json({ error: 'Solo el administrador puede sincronizar reportes fiscales.' });
  }
  if (!reportsSync.isEnabled()) {
    return res.status(503).json({ error: 'Firebase no está configurado.' });
  }

  const desde = String(req.body?.desde || '').trim();
  const hasta  = String(req.body?.hasta  || '').trim();
  if (!desde || !hasta) {
    return res.status(400).json({ error: 'Debes enviar { desde, hasta } en formato YYYY-MM-DD.' });
  }

  const branchId = Number(req.body?.branchId || 0) || null;
  let w = `WHERE s.created_at BETWEEN ? AND ? AND COALESCE(s.fiscal_status,'emitida') <> 'cancelada'`;
  const p = [`${desde} 00:00:00`, `${hasta} 23:59:59`];
  if (branchId) { w += ' AND COALESCE(s.billed_branch_id,s.branch_id)=?'; p.push(branchId); }

  const resumen = await query(`
    SELECT
      COUNT(*) AS total_facturas,
      COALESCE(SUM(s.total),0) AS total_facturado,
      COALESCE(SUM(s.tax),0) AS itbis_cobrado,
      MIN(s.ncf) AS ncf_start,
      MAX(s.ncf) AS ncf_end
    FROM sales s ${w}`, p);

  const config = await getReportSyncConfig();
  const branches = await getReportSyncBranchesMap();
  await reportsSync.syncTaxReport({
    id: `ncf-${desde}-${hasta}${branchId ? `-br${branchId}` : ''}`,
    period: `${desde}/${hasta}`,
    invoice_type: 'fiscal',
    ncf_start: resumen[0]?.ncf_start || null,
    ncf_end: resumen[0]?.ncf_end || null,
    total_invoices: Number(resumen[0]?.total_facturas || 0),
    total_amount: Number(resumen[0]?.total_facturado || 0),
    total_tax: Number(resumen[0]?.itbis_cobrado || 0),
    branch_id: branchId,
    generated_at: new Date(),
    status: 'generated',
  }, { config, branches });

  res.json({
    ok: true,
    period: `${desde}/${hasta}`,
    totalInvoices: Number(resumen[0]?.total_facturas || 0),
    totalAmount: Number(resumen[0]?.total_facturado || 0),
  });
});

app.get('/api/suspended-sales', async (req, res) => {
  const actorUser = await resolveRequestActorUser(req, { required: true });
  await ensureSuspendedSalesTable();
  const scopedBranchId = getUserScopeBranchId(actorUser);
  const rows = scopedBranchId
    ? await query('SELECT * FROM suspended_sales WHERE COALESCE(branch_id, 0) = ? OR branch_id IS NULL ORDER BY updated_at DESC, created_at DESC', [scopedBranchId])
    : await query('SELECT * FROM suspended_sales ORDER BY updated_at DESC, created_at DESC');
  res.json(rows.map(mapSuspendedSaleRow));
});

app.get('/api/quotations', async (req, res) => {
  const actorUser = await resolveRequestActorUser(req, { required: true });
  await ensureQuotationsTable();
  const scopedBranchId = getUserScopeBranchId(actorUser);
  const rows = scopedBranchId
    ? await query('SELECT * FROM quotations WHERE COALESCE(branch_id, 0) = ? OR branch_id IS NULL ORDER BY updated_at DESC, created_at DESC', [scopedBranchId])
    : await query('SELECT * FROM quotations ORDER BY updated_at DESC, created_at DESC');
  res.json(rows.map(mapQuotationRow));
});

app.post('/api/suspended-sales', async (req, res) => {
  await resolveRequestActorUser(req, { required: true });
  await ensureSuspendedSalesTable();
  const payload = req.body || {};
  const id = String(payload.id || '').trim() || `PEND-${Date.now()}`;
  const nombre = String(payload.nombre || '').trim() || 'Venta suspendida';
  const items = Array.isArray(payload.items) ? payload.items : [];
  const total = Math.max(0, Number(payload.total || 0));
  const itemCount = Math.max(0, Number(payload.itemCount || items.reduce((sum, item) => sum + Number(item.qty || 0), 0)));

  if (!items.length) {
    return res.status(400).json({ error: 'Debes incluir al menos un producto para suspender la venta.' });
  }

  const draft = {
    id,
    nombre,
    clientId: payload.clientId || null,
    clientName: String(payload.clientName || 'Consumidor Final').trim() || 'Consumidor Final',
    documentType: String(payload.documentType || 'ticket').trim() || 'ticket',
    payMethod: String(payload.payMethod || 'efectivo').trim() || 'efectivo',
    deliveryUserId: payload.deliveryUserId || null,
    orderType: String(payload.orderType || 'mostrador').trim() || 'mostrador',
    kitchenStatus: String(payload.kitchenStatus || 'pendiente').trim() || 'pendiente',
    generalDiscount: Number(payload.generalDiscount || 0) || 0,
    tableLabel: String(payload.tableLabel || '').trim(),
    deliveryPhone: String(payload.deliveryPhone || '').trim(),
    deliveryAddress: String(payload.deliveryAddress || '').trim(),
    deliveryReference: String(payload.deliveryReference || '').trim(),
    deliveryLink: String(payload.deliveryLink || '').trim(),
    orderNotes: String(payload.orderNotes || '').trim(),
    total,
    itemCount,
    items
  };

  await query(
    `INSERT INTO suspended_sales
      (id, sale_name, draft_payload, total, item_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
      sale_name = excluded.sale_name,
      draft_payload = excluded.draft_payload,
      total = excluded.total,
      item_count = excluded.item_count,
      updated_at = datetime('now')`,
    [id, nombre, JSON.stringify(draft), total, itemCount]
  );

  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Ventas',
    actionName: 'Venta suspendida',
    detail: `${nombre} · ${itemCount} item(s) · RD$ ${total.toFixed(2)}`
  });

  const rows = await query('SELECT * FROM suspended_sales WHERE id = ? LIMIT 1', [id]);
  res.status(201).json({
    suspendedSale: rows[0] ? mapSuspendedSaleRow(rows[0]) : draft
  });
});

app.post('/api/quotations', async (req, res) => {
  await resolveRequestActorUser(req, { required: true });
  await ensureQuotationsTable();
  const payload = req.body || {};
  const id = String(payload.id || '').trim() || `COT-${Date.now()}`;
  const nombre = String(payload.nombre || '').trim() || 'Cotización';
  const clientName = String(payload.clientName || '').trim();
  const items = Array.isArray(payload.items) ? payload.items : [];
  const total = Math.max(0, Number(payload.total || 0));
  const itemCount = Math.max(0, Number(payload.itemCount || items.reduce((sum, item) => sum + Number(item.qty || 0), 0)));

  if (!items.length) {
    return res.status(400).json({ error: 'Debes incluir al menos un producto para guardar la cotización.' });
  }
  if (!clientName) {
    return res.status(400).json({ error: 'El nombre del cliente es obligatorio para la cotización.' });
  }

  const draft = {
    id,
    nombre,
    clientId: payload.clientId || null,
    clientName,
    documentType: String(payload.documentType || 'ticket').trim() || 'ticket',
    payMethod: String(payload.payMethod || 'efectivo').trim() || 'efectivo',
    deliveryUserId: payload.deliveryUserId || null,
    orderType: String(payload.orderType || 'mostrador').trim() || 'mostrador',
    kitchenStatus: String(payload.kitchenStatus || 'pendiente').trim() || 'pendiente',
    generalDiscount: Number(payload.generalDiscount || 0) || 0,
    tableLabel: String(payload.tableLabel || '').trim(),
    deliveryPhone: String(payload.deliveryPhone || '').trim(),
    deliveryAddress: String(payload.deliveryAddress || '').trim(),
    deliveryReference: String(payload.deliveryReference || '').trim(),
    deliveryLink: String(payload.deliveryLink || '').trim(),
    orderNotes: String(payload.orderNotes || '').trim(),
    total,
    itemCount,
    items
  };

  await query(
    `INSERT INTO quotations
      (id, quotation_name, client_name, draft_payload, total, item_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
      quotation_name = excluded.quotation_name,
      client_name = excluded.client_name,
      draft_payload = excluded.draft_payload,
      total = excluded.total,
      item_count = excluded.item_count,
      updated_at = datetime('now')`,
    [id, nombre, clientName, JSON.stringify(draft), total, itemCount]
  );

  await writeAuditLog({
    ...getActor(req),
    moduleName: 'Ventas',
    actionName: 'Cotización guardada',
    detail: `${clientName} · ${itemCount} item(s) · RD$ ${total.toFixed(2)}`
  });

  const rows = await query('SELECT * FROM quotations WHERE id = ? LIMIT 1', [id]);
  res.status(201).json({
    quotation: rows[0] ? mapQuotationRow(rows[0]) : draft
  });
});

app.delete('/api/suspended-sales/:id', async (req, res) => {
  await ensureSuspendedSalesTable();
  const saleId = String(req.params.id || '').trim();
  if (!saleId) {
    return res.status(400).json({ error: 'Debes indicar la venta suspendida a recuperar.' });
  }

  const rows = await query('SELECT * FROM suspended_sales WHERE id = ? LIMIT 1', [saleId]);
  const current = rows[0];
  if (!current) {
    return res.status(404).json({ error: 'La venta suspendida ya no existe.' });
  }

  await query('DELETE FROM suspended_sales WHERE id = ?', [saleId]);

  await writeAuditLog({
    ...getActor(req),
    moduleName: 'Ventas',
    actionName: 'Venta recuperada',
    detail: `${current.sale_name || saleId}`
  });

  res.json({ ok: true });
});

app.delete('/api/quotations/:id', async (req, res) => {
  await ensureQuotationsTable();
  const quotationId = String(req.params.id || '').trim();
  if (!quotationId) {
    return res.status(400).json({ error: 'Debes indicar la cotización a eliminar.' });
  }

  const rows = await query('SELECT * FROM quotations WHERE id = ? LIMIT 1', [quotationId]);
  const current = rows[0];
  if (!current) {
    return res.status(404).json({ error: 'La cotización ya no existe.' });
  }

  await query('DELETE FROM quotations WHERE id = ?', [quotationId]);

  await writeAuditLog({
    ...getActor(req),
    moduleName: 'Ventas',
    actionName: 'Cotización eliminada',
    detail: `${current.client_name || current.quotation_name || quotationId}`
  });

  res.json({ ok: true });
});

app.get('/api/backup/export', async (req, res) => {
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!isGlobalAdministratorUser(actorUser)) {
    return res.status(403).json({ error: 'Solo el administrador general puede exportar copias de seguridad.' });
  }
  res.json(await buildBackupPayload());
});

app.post('/api/backup/restore', async (req, res) => {
  ensureAdministrator(req);
  await restoreBackupPayload(req.body?.payload || req.body);
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Configuración',
    actionName: 'Copia restaurada',
    detail: 'Se restauró una copia de seguridad del sistema'
  });
  res.json({ ok: true });
});

app.post('/api/backup/auto-save', async (req, res) => {
  const saved = await saveLatestSecureBackup();
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Configuración',
    actionName: 'Copia segura automática',
    detail: `Se actualizó la copia segura ${saved.fileName}`
  });
  res.json(saved);
});

app.post('/api/backup/restore-latest', async (req, res) => {
  ensureAdministrator(req);
  const password = String(req.body?.password || '');
  const restored = await restoreLatestSecureBackup(password);
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Configuración',
    actionName: 'Restauración de copia segura',
    detail: `Se restauró la copia segura ${restored.fileName}`
  });
  res.json({ ok: true, ...restored });
});

app.post('/api/security-password/verify', async (req, res) => {
  const password = String(req.body?.password || '');
  const currentPassword = await getSecurityPassword();
  if (password !== currentPassword) {
    return res.status(403).json({ error: 'Clave de seguridad incorrecta.' });
  }
  res.json({ ok: true });
});

app.post('/api/security-password/change', async (req, res) => {
  ensureAdministrator(req);
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '').trim();
  const storedPassword = await getSecurityPassword();

  if (currentPassword !== storedPassword) {
    return res.status(403).json({ error: 'La clave de seguridad actual no es correcta.' });
  }
  if (newPassword.length < 4) {
    return res.status(400).json({ error: 'La nueva clave de seguridad debe tener al menos 4 caracteres.' });
  }

  await query('UPDATE config SET security_password = ? WHERE id = 1', [newPassword]);
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Configuración',
    actionName: 'Clave de seguridad actualizada',
    detail: 'Se cambió la clave de seguridad del sistema'
  });
  res.json({ ok: true });
});

app.post('/api/license/sync', async (req, res) => {
  await resolveRequestActorUser(req, { required: true });
  const result = await secureLicenseService.resolveState({
    force: true,
    allowRemote: true,
  });
  if (!result?.license?.canEnter && !result?.synced) {
    return res.status(503).json({
      error: result?.reason || 'No se pudo sincronizar la licencia. Verifica TECNO_CAJA_LICENSE_UID y la conexión a Firebase.',
      license: result?.license || null,
    });
  }
  res.json({ ok: true, ...result });
});

app.post('/api/license/set-plan', async (req, res) => {
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!isGlobalAdministratorUser(actorUser)) {
    return res.status(403).json({ error: 'Solo el administrador general puede cambiar el plan.' });
  }
  const planCode = String(req.body?.planCode || '').toLowerCase();
  if (!plans.PLAN_LEVELS[planCode]) {
    return res.status(400).json({ error: 'Plan inválido. Opciones: basico, pro, plus.' });
  }
  const structureMode = plans.modeForPlan(planCode);
  await query(
    `UPDATE config SET plan_code = ?, plan_name = ?, business_structure_mode = ? WHERE id = 1`,
    [planCode, plans.PLAN_NAMES[planCode], structureMode]
  );
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Configuración',
    actionName: 'Plan cambiado',
    detail: `Plan activado: ${plans.PLAN_NAMES[planCode]}`,
  });
  await trySyncAllPosAccountsToFirebase().catch((error) => {
    console.warn('No se pudo sincronizar el cambio de plan con Firebase:', error.message);
  });
  res.json({ ok: true, planCode, planName: plans.PLAN_NAMES[planCode], businessStructureMode: structureMode });
});

// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/security-password/reset', async (req, res) => {
  ensureAdministrator(req);
  await query('UPDATE config SET security_password = ? WHERE id = 1', [DEFAULT_SECURITY_PASSWORD]);
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Configuración',
    actionName: 'Clave de seguridad restablecida',
    detail: 'Se restableció la clave de seguridad al valor por defecto del sistema.'
  });
  res.json({ ok: true, defaultPassword: DEFAULT_SECURITY_PASSWORD });
});

app.post('/api/account/access-password', async (req, res) => {
  await ensureUserExtensions();
  const userId = Number(req.body?.actorUserId || 0);
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');

  if (!userId) {
    return res.status(400).json({ error: 'Debes iniciar sesión para cambiar tu contraseña de acceso.' });
  }
  if (newPassword.length < 4) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 4 caracteres.' });
  }

  const rows = await query('SELECT * FROM users WHERE id = ? LIMIT 1', [userId]);
  const user = rows[0];
  if (!user) {
    return res.status(404).json({ error: 'Usuario no encontrado.' });
  }

  const hasExistingPassword = Boolean(String(user.password_hash || user.password || '').trim());
  if (hasExistingPassword && !userPasswordMatches(user, currentPassword)) {
    return res.status(403).json({ error: 'La contraseña actual no es correcta.' });
  }

  await query(
    `UPDATE users
     SET password = ?, password_hash = ?, auth_provider = CASE WHEN auth_provider = 'google' THEN 'google' ELSE 'local' END
     WHERE id = ?`,
    [newPassword, createLocalPasswordHash(newPassword), userId]
  );

  const updatedRows = await query('SELECT * FROM users WHERE id = ? LIMIT 1', [userId]);
  await writeAuditLog({
    userId,
    userName: updatedRows[0].nombre,
    userRole: updatedRows[0].rol,
    moduleName: 'Configuración',
    actionName: hasExistingPassword ? 'Contraseña de acceso actualizada' : 'Contraseña de acceso creada',
    detail: `Usuario ${updatedRows[0].usuario}`
  });

  res.json(mapUserRow(updatedRows[0]));
});

app.post('/api/system/reset', async (req, res) => {
  const isFactoryReset = Boolean(req.body?.factoryReset === true);
  if (!isFactoryReset) {
    ensureAdministrator(req);
  }
  const confirmation = String(req.body?.confirmation || '').trim().toUpperCase();
  const password = String(req.body?.password || '');
  const purgeFirebase = req.body?.purgeFirebase === true;
  const cloudConfirmation = String(req.body?.cloudConfirmation || '').trim().toUpperCase();
  const currentPassword = await getSecurityPassword();
  if (confirmation !== 'ELIMINAR TODO') {
    return res.status(400).json({ error: 'Debes confirmar escribiendo ELIMINAR TODO.' });
  }
  if (password !== currentPassword) {
    return res.status(403).json({ error: 'Clave de seguridad incorrecta.' });
  }
  if (purgeFirebase && cloudConfirmation !== 'BORRAR FIREBASE') {
    return res.status(400).json({ error: 'Debes confirmar el borrado remoto escribiendo BORRAR FIREBASE.' });
  }
  // Factory reset omite la validación de terminal principal
  if (purgeFirebase && !isFactoryReset) {
    const terminalConfig = getTerminalConfig();
    if (!isMainTerminalConfig(terminalConfig)) {
      return res.status(409).json({ error: 'Solo la terminal principal puede borrar la información remota de Firebase.' });
    }
  }

  const backup = await saveLatestSecureBackup();
  let firebaseSummary = null;
  if (purgeFirebase) {
    const config = await getConfig({ syncRemote: false }).catch(() => ({}));
    const userRows = await query('SELECT firebase_uid FROM users WHERE firebase_uid IS NOT NULL AND firebase_uid != ""').catch(() => []);
    firebaseSummary = await purgePosBusinessFromFirebase({
      businessName: config?.nombre || 'Tecno Caja',
      businessId: String(process.env.TECNO_CAJA_LICENSE_UID || '').trim() || null,
      licenseUid: String(process.env.TECNO_CAJA_LICENSE_UID || '').trim() || null,
      authUids: userRows.map((row) => row.firebase_uid).filter(Boolean),
    });
    persistRuntimeEnvValues({
      TECNO_CAJA_LICENSE_UID: '',
      TECNO_CAJA_BUSINESS_ID: ''
    });
    await query('DELETE FROM license_cache').catch(() => {});
    try {
      if (fs.existsSync(TERMINAL_CONFIG_PATH)) fs.unlinkSync(TERMINAL_CONFIG_PATH);
    } catch (_error) {}
  }

  // isFactoryReset controla QUÉ TAN PROFUNDO es el reset local (borrar todo vs. borrar solo datos).
  // purgeFirebase controla si TAMBIÉN se borra la nube.
  // Son decisiones independientes: puedes hacer factory reset local sin tocar Firebase.
  await resetSystemData({
    keepUserId: isFactoryReset ? null : (req.body?.actorUserId || null),
    factoryReset: isFactoryReset
  });

  const actor = getActor(req);
  let actionName, detail;
  if (isFactoryReset && purgeFirebase) {
    actionName = 'Factory reset completo (local + Firebase)';
    detail = `Se borró todo: base local y Firebase. Copia previa: ${backup.fileName}`;
  } else if (isFactoryReset) {
    actionName = 'Factory reset local';
    detail = `Se borró la base local completa. Firebase conservado. Copia previa: ${backup.fileName}`;
  } else if (purgeFirebase) {
    actionName = 'Sistema y Firebase limpiados';
    detail = `Se limpió la app y Firebase. Copia previa: ${backup.fileName}`;
  } else {
    actionName = 'Sistema limpiado';
    detail = `Se limpió la app completa. Copia previa: ${backup.fileName}`;
  }
  await writeAuditLog({ ...actor, moduleName: 'Configuración', actionName, detail });

  const payload = {
    ok: true,
    backupFile: backup.fileName,
    firebasePurged: Boolean(purgeFirebase),
    firebaseSummary,
  };
  if (isFactoryReset) {
    // Factory reset siempre reinicia en modo instalación limpia (wizard).
    // El frontend recarga y setup_completed=0 → muestra el asistente de configuración.
    payload.message = purgeFirebase
      ? 'Factory reset completo. Firebase eliminado y base local en cero. La app arrancará como nueva instalación.'
      : 'Factory reset local completado. Firebase conservado. La app arrancará como nueva instalación.';
  } else if (purgeFirebase) {
    payload.message = 'Firebase fue eliminado y la base local quedó en estado inicial. Ahora desinstala Tecno Caja y acepta borrar los archivos locales de esta PC.';
  } else {
    payload.data = await getBootstrapData();
  }
  res.json(payload);
});

app.get('/api/audit', async (req, res) => {
  const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: false });
  if (!userCanAccessGlobalAudit(actorUser)) {
    return res.status(403).json({ error: 'La auditoría global solo está disponible para el administrador general.' });
  }
  await ensureAuditTable();
  const rows = await query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200');
  res.json(rows.map(mapAuditRow));
});

app.post('/api/qrcode', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) {
    return res.status(400).json({ error: 'El texto para el QR es obligatorio.' });
  }

  const dataUrl = await QRCode.toDataURL(text, {
    width: 192,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: {
      dark: '#000000',
      light: '#FFFFFF'
    }
  });

  res.json({ dataUrl });
});

app.post('/api/categories', async (req, res) => {
  ensureNotCashier(req);
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!userCanManageGlobalProductCatalog(actorUser)) {
    return res.status(403).json({ error: 'No tienes permiso para crear categorías globales desde tu sucursal.' });
  }
  await ensureCategoriesTable();
  const nombre = String(req.body?.nombre || '').trim();
  if (!nombre) {
    return res.status(400).json({ error: 'El nombre de la categoría es obligatorio.' });
  }

  const existingRows = await query('SELECT * FROM categories WHERE LOWER(nombre) = LOWER(?) LIMIT 1', [nombre]);
  if (existingRows.length) {
    return res.status(409).json({ error: 'Esa categoría ya existe.' });
  }

  const result = await query('INSERT INTO categories (nombre) VALUES (?)', [nombre]);
  const rows = await query('SELECT * FROM categories WHERE id = ?', [result.insertId]);
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Productos',
    actionName: 'Categoría creada',
    detail: nombre
  });
  res.status(201).json(mapCategoryRow(rows[0]));
});

app.post('/api/products', async (req, res) => {
  ensureNotCashier(req);
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!userCanManageGlobalProductCatalog(actorUser)) {
    return res.status(403).json({ error: 'No tienes permiso para crear productos globales.' });
  }
  const data = req.body;
  if (!data?.codigo || !data?.nombre) {
    return res.status(400).json({ error: 'Código y nombre son obligatorios.' });
  }
  await ensureCategoriesTable();
  await ensureProductExtensions();
  const actor = getActor(req);
  await ensureBusinessStructureExtensions();
  await ensureBranchInventoryTable();
  await ensureInventoryMovementsTable();

  const createdResult = await withTransaction(async (conn) => {
    await conn.query('INSERT OR IGNORE INTO categories (nombre) VALUES (?)', [data.categoria]);
    await ensureUniqueProductCode(data.codigo, null, conn);
    await ensureUniqueProductName(data.nombre, null, conn);

    const result = await conn.query(
      `INSERT INTO products
        (codigo, nombre, categoria, marca, unidad, sale_mode, precio_compra, precio_venta, stock, stock_min, estado, image_url, image_local, product_type, size_options, dough_options, border_options, extra_options, allow_half_and_half, is_combo, aplica_itbis, preparation_time_minutes, business_metadata, tracks_stock)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.codigo,
        data.nombre,
        data.categoria,
        data.marca,
        data.unidad,
        normalizeProductSaleMode(data.saleMode),
        data.precioCompra,
        data.precioVenta,
        data.stock,
        data.stockMin,
        data.estado || 'Activo',
        data.imagen || null,
        data.imagenLocal || null,
        data.tipoProducto || 'general',
        JSON.stringify(data.tamanos || []),
        JSON.stringify(data.masas || []),
        JSON.stringify(data.bordes || []),
        JSON.stringify(data.extras || []),
        data.permiteMitades ? 1 : 0,
        data.esCombo ? 1 : 0,
        data.aplicaItbis ? 1 : 0,
        Number(data.tiempoPreparacion || 15),
        JSON.stringify(data.metaNegocio || {}),
        data.tracksStock === false ? 0 : 1
      ]
    );

    const productId = Number(result.insertId || 0);
    const terminalScope = getTerminalScopeSelection();
    const configRows = await conn.query('SELECT active_branch_id FROM config WHERE id = 1 LIMIT 1');
    const preferredBranchId = Number(data.branchId || terminalScope.branchId || configRows[0]?.active_branch_id || 0) || null;
    const branchId = await resolveInventoryBranchId(conn, preferredBranchId);

    await ensureBranchInventoryCoverageForProduct(conn, {
      productId,
      branchId,
      stock: Number(data.stock || 0),
      stockMin: Number(data.stockMin || 0)
    });

    let stockChange = null;
    if (branchId) {
      stockChange = await changeBranchInventoryStock(conn, {
        productId,
        branchId,
        absoluteStock: Number(data.stock || 0),
        stockMin: Number(data.stockMin || 0)
      });
    }

    if (Number(data.stock || 0) > 0 && branchId) {
      await registerInventoryMovement(conn, {
        productId,
        branchId,
        tipo: 'inicial',
        cantidad: Number(data.stock || 0),
        stockAnterior: stockChange?.previousStock ?? 0,
        stockNuevo: stockChange?.nextStock ?? Number(data.stock || 0),
        costoUnitario: Number(data.precioCompra || 0),
        referenciaTipo: 'producto',
        referenciaId: data.codigo,
        notas: 'Stock inicial al crear producto',
        usuarioId: actor.userId,
        usuarioNombre: actor.userName
      });
    }

    const rows = await conn.query('SELECT * FROM products WHERE id = ?', [productId]);
    return {
      row: rows[0],
      branchId
    };
  });

  try {
    await writeAuditLog({
      ...actor,
      moduleName: 'Productos',
      actionName: 'Producto creado',
      detail: `${data.codigo} · ${data.nombre}`
    });
  } catch (error) {
    console.warn('[audit] Falló al registrar producto creado:', error.message);
  }

  const created = mapProductRow(createdResult.row);
  try {
    productsCache.upsert(created);
  } catch (error) {
    console.warn('[products-cache] No se pudo actualizar caché tras crear producto:', error.message);
  }
  // ── Sync reporte-sistema-pos (producto creado) ──
  fireReportSync(async () => {
    const cfg = await getReportSyncConfig();
    await reportsSync.syncProduct(createdResult.row, { config: cfg, branchId: createdResult.branchId });
  });
  await persistProductsCsvBackup('crear_producto');
  scheduleSilentProductBackup('crear_producto');
  res.status(201).json(created);
});

app.post('/api/products/import-csv', async (req, res) => {
  ensureNotCashier(req);
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!userCanManageGlobalProductCatalog(actorUser)) {
    return res.status(403).json({ error: 'No tienes permiso para importar productos globales.' });
  }

  await ensureCategoriesTable();
  await ensureProductExtensions();
  await ensureBusinessStructureExtensions();
  await ensureBranchInventoryTable();
  await ensureInventoryMovementsTable();

  const form = formidable({ multiples: false, maxFileSize: 10 * 1024 * 1024, keepExtensions: true });
  const parsed = await new Promise((resolve, reject) => {
    form.parse(req, (error, fields, files) => {
      if (error) return reject(error);
      return resolve({ fields, files });
    });
  }).catch((error) => {
    error.statusCode = 400;
    throw error;
  });

  const uploaded = parsed?.files?.csv || parsed?.files?.file || parsed?.files?.products;
  const csvFile = Array.isArray(uploaded) ? uploaded[0] : uploaded;
  if (!csvFile?.filepath) {
    return res.status(400).json({ error: 'Debes seleccionar un archivo CSV de productos.' });
  }

  const originalFilename = String(csvFile.originalFilename || csvFile.newFilename || 'productos.csv').trim() || 'productos.csv';
  const extension = path.extname(originalFilename).toLowerCase();
  if (!['.csv', '.txt'].includes(extension)) {
    return res.status(400).json({ error: 'El archivo debe ser .csv o .txt.' });
  }

  const buffer = fs.readFileSync(csvFile.filepath);
  const importedRows = parseProductsCsvBuffer(buffer, originalFilename);
  const actor = getActor(req);

  const summary = await withTransaction(async (conn) => {
    const report = {
      imported: importedRows.length,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [],
      affectedIds: [],
      branchId: null,
    };

    const terminalScope = getTerminalScopeSelection();
    const configRows = await conn.query('SELECT active_branch_id FROM config WHERE id = 1 LIMIT 1');
    const preferredBranchId = Number(terminalScope.branchId || configRows[0]?.active_branch_id || 0) || null;
    const branchId = await resolveInventoryBranchId(conn, preferredBranchId);
    report.branchId = branchId;

    for (const record of importedRows) {
      try {
        if (!record.codigo || !record.nombre) {
          report.skipped += 1;
          report.errors.push(`Fila ${record.rowNumber}: código y nombre son obligatorios.`);
          continue;
        }

        await conn.query('INSERT OR IGNORE INTO categories (nombre) VALUES (?)', [record.categoria || 'General']);
        const existingRows = await conn.query('SELECT * FROM products WHERE LOWER(codigo) = LOWER(?) LIMIT 1', [record.codigo]);
        const existing = existingRows[0];

        if (existing) {
          const payload = {
            codigo: resolveImportedProductString(record, 'codigo', existing.codigo, existing.codigo),
            nombre: resolveImportedProductString(record, 'nombre', existing.nombre, existing.nombre),
            categoria: resolveImportedProductString(record, 'categoria', existing.categoria, 'General') || 'General',
            marca: resolveImportedProductString(record, 'marca', existing.marca, ''),
            unidad: resolveImportedProductString(record, 'unidad', existing.unidad, 'Unidad') || 'Unidad',
            saleMode: normalizeProductSaleMode(resolveImportedProductString(record, 'saleMode', existing.sale_mode, 'unidad')),
            precioCompra: resolveImportedProductNumber(record, 'precioCompra', existing.precio_compra, 0),
            precioVenta: resolveImportedProductNumber(record, 'precioVenta', existing.precio_venta, 0),
            stock: resolveImportedProductNumber(record, 'stock', existing.stock, 0),
            stockMin: resolveImportedProductNumber(record, 'stockMin', existing.stock_min, 0),
            estado: resolveImportedProductString(record, 'estado', existing.estado, 'Activo') || 'Activo',
            imageUrl: resolveImportedProductString(record, 'imagenUrl', existing.image_url, ''),
            imageLocal: resolveImportedProductString(record, 'imagenLocal', existing.image_local, ''),
            tipoProducto: resolveImportedProductString(record, 'tipoProducto', existing.product_type, 'general') || 'general',
            aplicaItbis: resolveImportedProductBoolean(record, 'aplicaItbis', existing.aplica_itbis, false) ? 1 : 0,
            tracksStock: resolveImportedProductBoolean(record, 'tracksStock', existing.tracks_stock, true) ? 1 : 0,
            esCombo: resolveImportedProductBoolean(record, 'esCombo', existing.is_combo, false) ? 1 : 0,
            tiempoPreparacion: Math.max(0, Math.round(resolveImportedProductNumber(record, 'tiempoPreparacion', existing.preparation_time_minutes, 15))),
          };

          await ensureUniqueProductCode(payload.codigo, existing.id, conn);
          await ensureUniqueProductName(payload.nombre, existing.id, conn);
          await conn.query(
            `UPDATE products
             SET codigo = ?, nombre = ?, categoria = ?, marca = ?, unidad = ?, sale_mode = ?, precio_compra = ?,
                 precio_venta = ?, stock = ?, stock_min = ?, estado = ?, image_url = ?, image_local = ?,
                 product_type = ?, aplica_itbis = ?, tracks_stock = ?, is_combo = ?, preparation_time_minutes = ?
             WHERE id = ?`,
            [
              payload.codigo,
              payload.nombre,
              payload.categoria,
              payload.marca,
              payload.unidad,
              payload.saleMode,
              payload.precioCompra,
              payload.precioVenta,
              payload.stock,
              payload.stockMin,
              payload.estado,
              payload.imageUrl || null,
              payload.imageLocal || null,
              payload.tipoProducto,
              payload.aplicaItbis,
              payload.tracksStock,
              payload.esCombo,
              payload.tiempoPreparacion,
              existing.id,
            ]
          );

          await ensureBranchInventoryCoverageForProduct(conn, {
            productId: Number(existing.id),
            branchId,
            stock: payload.stock,
            stockMin: payload.stockMin,
          });

          const stockChange = branchId
            ? await changeBranchInventoryStock(conn, {
              productId: Number(existing.id),
              branchId,
              absoluteStock: payload.stock,
              stockMin: payload.stockMin,
            })
            : null;

          if (stockChange && stockChange.previousStock !== stockChange.nextStock) {
            await registerInventoryMovement(conn, {
              productId: Number(existing.id),
              branchId,
              tipo: 'importacion_csv',
              cantidad: stockChange.nextStock - stockChange.previousStock,
              stockAnterior: stockChange.previousStock,
              stockNuevo: stockChange.nextStock,
              costoUnitario: payload.precioCompra,
              referenciaTipo: 'producto_csv',
              referenciaId: payload.codigo,
              notas: `Importación CSV (${originalFilename})`,
              usuarioId: actor.userId,
              usuarioNombre: actor.userName,
            });
          }

          report.updated += 1;
          report.affectedIds.push(Number(existing.id));
          continue;
        }

        await ensureUniqueProductCode(record.codigo, null, conn);
        await ensureUniqueProductName(record.nombre, null, conn);

        const result = await conn.query(
          `INSERT INTO products
            (codigo, nombre, categoria, marca, unidad, sale_mode, precio_compra, precio_venta, stock, stock_min, estado, image_url, image_local, product_type, size_options, dough_options, border_options, extra_options, allow_half_and_half, is_combo, aplica_itbis, preparation_time_minutes, business_metadata, tracks_stock)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.codigo,
            record.nombre,
            record.categoria || 'General',
            record.marca || '',
            record.unidad || 'Unidad',
            normalizeProductSaleMode(record.saleMode || 'unidad'),
            Number(record.precioCompra || 0),
            Number(record.precioVenta || 0),
            Number(record.stock || 0),
            Number(record.stockMin || 0),
            record.estado || 'Activo',
            record.imagenUrl || null,
            record.imagenLocal || null,
            record.tipoProducto || 'general',
            JSON.stringify([]),
            JSON.stringify([]),
            JSON.stringify([]),
            JSON.stringify([]),
            0,
            record.esCombo ? 1 : 0,
            record.aplicaItbis ? 1 : 0,
            Number(record.tiempoPreparacion || 15),
            JSON.stringify({}),
            record.tracksStock === false ? 0 : 1,
          ]
        );

        const productId = Number(result.insertId || 0);
        await ensureBranchInventoryCoverageForProduct(conn, {
          productId,
          branchId,
          stock: Number(record.stock || 0),
          stockMin: Number(record.stockMin || 0),
        });

        const stockChange = branchId
          ? await changeBranchInventoryStock(conn, {
            productId,
            branchId,
            absoluteStock: Number(record.stock || 0),
            stockMin: Number(record.stockMin || 0),
          })
          : null;

        if (Number(record.stock || 0) > 0 && branchId) {
          await registerInventoryMovement(conn, {
            productId,
            branchId,
            tipo: 'importacion_csv',
            cantidad: Number(record.stock || 0),
            stockAnterior: stockChange?.previousStock ?? 0,
            stockNuevo: stockChange?.nextStock ?? Number(record.stock || 0),
            costoUnitario: Number(record.precioCompra || 0),
            referenciaTipo: 'producto_csv',
            referenciaId: record.codigo,
            notas: `Importación CSV (${originalFilename})`,
            usuarioId: actor.userId,
            usuarioNombre: actor.userName,
          });
        }

        report.created += 1;
        report.affectedIds.push(productId);
      } catch (error) {
        report.skipped += 1;
        report.errors.push(`Fila ${record.rowNumber}: ${error.message}`);
      }
    }

    report.affectedIds = [...new Set(report.affectedIds.filter((id) => Number(id) > 0))];
    return report;
  });

  if (!summary.created && !summary.updated) {
    return res.status(422).json({
      error: 'No se importaron productos válidos desde el CSV.',
      details: summary.errors,
    });
  }

  try {
    await writeAuditLog({
      ...actor,
      moduleName: 'Productos',
      actionName: 'Productos importados desde CSV',
      detail: `${summary.created} creados, ${summary.updated} actualizados desde ${originalFilename}`,
    });
  } catch (error) {
    console.warn('[audit] Falló al registrar importación CSV de productos:', error.message);
  }

  const backupInfo = await persistProductsCsvBackup('importacion_csv');
  scheduleSilentProductBackup('importacion_csv');

  try {
    await productsCache.loadAll();
  } catch (error) {
    console.warn('[products-cache] No se pudo recargar la caché tras importar CSV:', error.message);
  }

  fireReportSync(async () => {
    if (summary.affectedIds.length) {
      await syncProductsToReportsByIds(summary.affectedIds, { branchId: summary.branchId });
    }
  });

  const allProductRows = await query('SELECT * FROM products ORDER BY nombre, id');
  return res.json({
    ok: true,
    imported: summary.imported,
    created: summary.created,
    updated: summary.updated,
    skipped: summary.skipped,
    errors: summary.errors,
    affectedIds: summary.affectedIds,
    backupCsv: backupInfo?.currentFilePath || PRODUCTS_CSV_CURRENT_FILE,
    products: allProductRows.map(mapProductRow),
  });
});

app.get('/api/products/cache-search', async (req, res) => {
  try {
    const q         = String(req.query.q || '').trim();
    const categoria = String(req.query.categoria || '').trim() || undefined;
    const limit     = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
    const results   = await productsCache.search(q, { categoria, limit });
    res.json({ ok: true, products: results, source: 'cache', stats: productsCache.stats() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/products/image-search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const page = Math.max(1, Number(req.query.page || 1));
  const perPage = Math.min(20, Math.max(10, Number(req.query.perPage || 10)));

  if (!q) {
    return res.status(400).json({ error: 'Debes indicar el nombre del producto a buscar.' });
  }
  if (!PEXELS_API_KEY) {
    return res.status(503).json({ error: 'Falta configurar PEXELS_API_KEY en el archivo .env.' });
  }

  const searchUrl = new URL('https://api.pexels.com/v1/search');
  searchUrl.searchParams.set('query', q);
  searchUrl.searchParams.set('page', String(page));
  searchUrl.searchParams.set('per_page', String(perPage));
  searchUrl.searchParams.set('orientation', 'square');

  const response = await fetch(searchUrl, {
    headers: {
      Authorization: PEXELS_API_KEY
    }
  });
  if (!response.ok) {
    return res.status(502).json({ error: 'No se pudo consultar la API de imágenes.' });
  }

  const payload = await response.json();
  const photos = Array.isArray(payload.photos) ? payload.photos : [];
  const results = photos.map((photo) => ({
    id: photo.id,
    width: photo.width,
    height: photo.height,
    alt: photo.alt || q,
    photographer: photo.photographer || '',
    thumbnailUrl: photo.src?.medium || photo.src?.small || photo.src?.original || '',
    imageUrl: photo.src?.large2x || photo.src?.large || photo.src?.original || '',
    sourceUrl: photo.url || ''
  })).filter((photo) => photo.thumbnailUrl && photo.imageUrl);

  res.json({
    query: q,
    page,
    perPage,
    hasMore: page * perPage < Number(payload.total_results || 0),
    total: Number(payload.total_results || results.length),
    results
  });
});

app.post('/api/products/:id/image', express.json({ limit: '20mb' }), async (req, res) => {
  ensureNotCashier(req);
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!userCanManageGlobalProductCatalog(actorUser)) {
    return res.status(403).json({ error: 'No tienes permiso para modificar imágenes del catálogo global.' });
  }
  await ensureProductExtensions();
  const productId = Number(req.params.id);
  const imageUrl = String(req.body?.imageUrl || '').trim();
  const imageData = String(req.body?.imageData || '').trim();
  const sourceUrl = String(req.body?.sourceUrl || '').trim();
  const productRows = await query('SELECT * FROM products WHERE id = ? LIMIT 1', [productId]);
  const product = productRows[0];
  if (!product) {
    return res.status(404).json({ error: 'Producto no encontrado.' });
  }

  let saved = null;
  let usedRemoteFallback = false;
  if (imageData) {
    try {
      saved = await saveProductImageBuffer({
        productId,
        productName: product.nombre,
        buffer: decodeDataUrlImage(imageData)
      });
    } catch (imgErr) {
      console.error('[Tecno Caja] Error procesando imagen del producto:', imgErr.message);
      return res.status(400).json({ error: `Error al procesar la imagen: ${imgErr.message}` });
    }
  } else {
    try {
      saved = await downloadAndSaveProductImage({
        productId,
        productName: product.nombre,
        imageUrl
      });
    } catch (error) {
      if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) {
        throw error;
      }
      usedRemoteFallback = true;
      saved = {
        imageLocal: null
      };
    }
  }
  await removeLocalProductImage(product.image_local);
  await query('UPDATE products SET image_url = ?, image_local = ? WHERE id = ?', [sourceUrl || imageUrl || null, saved.imageLocal || null, productId]);
  const rows = await query('SELECT * FROM products WHERE id = ?', [productId]);
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Productos',
    actionName: usedRemoteFallback ? 'Imagen de producto enlazada' : 'Imagen de producto guardada',
    detail: `${product.codigo} · ${product.nombre}`
  });
  await persistProductsCsvBackup('imagen_producto');
  res.json(mapProductRow(rows[0]));
});

app.delete('/api/products/:id/image', async (req, res) => {
  ensureNotCashier(req);
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!userCanManageGlobalProductCatalog(actorUser)) {
    return res.status(403).json({ error: 'No tienes permiso para modificar imágenes del catálogo global.' });
  }
  await ensureProductExtensions();
  const productId = Number(req.params.id);
  const rows = await query('SELECT * FROM products WHERE id = ? LIMIT 1', [productId]);
  const product = rows[0];
  if (!product) {
    return res.status(404).json({ error: 'Producto no encontrado.' });
  }
  await removeLocalProductImage(product.image_local);
  await query('UPDATE products SET image_url = NULL, image_local = NULL WHERE id = ?', [productId]);
  const updatedRows = await query('SELECT * FROM products WHERE id = ?', [productId]);
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Productos',
    actionName: 'Imagen de producto eliminada',
    detail: `${product.codigo} · ${product.nombre}`
  });
  await persistProductsCsvBackup('imagen_producto_eliminada');
  res.json(mapProductRow(updatedRows[0]));
});

app.put('/api/products/:id', async (req, res) => {
  ensureNotCashier(req);
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!userCanManageGlobalProductCatalog(actorUser)) {
    return res.status(403).json({ error: 'No tienes permiso para editar productos globales.' });
  }
  const { id } = req.params;
  const data = req.body;
  if (!data?.codigo || !data?.nombre) {
    return res.status(400).json({ error: 'Código y nombre son obligatorios.' });
  }
  await ensureCategoriesTable();
  await ensureProductExtensions();
  await ensureBusinessStructureExtensions();
  await ensureBranchInventoryTable();
  await ensureInventoryMovementsTable();
  const actor = getActor(req);
  const updatedResult = await withTransaction(async (conn) => {
    const previousRows = await conn.query('SELECT * FROM products WHERE id = ? LIMIT 1', [id]);
    const previous = previousRows[0];
    if (!previous) {
      const error = new Error('Producto no encontrado.');
      error.statusCode = 404;
      throw error;
    }

    await conn.query('INSERT OR IGNORE INTO categories (nombre) VALUES (?)', [data.categoria]);
    await ensureUniqueProductCode(data.codigo, id, conn);
    await ensureUniqueProductName(data.nombre, id, conn);
    await conn.query(
      `UPDATE products
       SET codigo = ?, nombre = ?, categoria = ?, marca = ?, unidad = ?, sale_mode = ?, precio_compra = ?,
           precio_venta = ?, stock = ?, stock_min = ?, estado = ?, image_url = ?, image_local = ?, product_type = ?,
           size_options = ?, dough_options = ?, border_options = ?, extra_options = ?,
           allow_half_and_half = ?, is_combo = ?, aplica_itbis = ?, preparation_time_minutes = ?, business_metadata = ?,
           tracks_stock = ?
       WHERE id = ?`,
      [
        data.codigo,
        data.nombre,
        data.categoria,
        data.marca,
        data.unidad,
        normalizeProductSaleMode(data.saleMode),
        data.precioCompra,
        data.precioVenta,
        data.stock,
        data.stockMin,
        data.estado || 'Activo',
        data.imagen || null,
        data.imagenLocal || null,
        data.tipoProducto || 'general',
        JSON.stringify(data.tamanos || []),
        JSON.stringify(data.masas || []),
        JSON.stringify(data.bordes || []),
        JSON.stringify(data.extras || []),
        data.permiteMitades ? 1 : 0,
        data.esCombo ? 1 : 0,
        data.aplicaItbis ? 1 : 0,
        Number(data.tiempoPreparacion || 15),
        JSON.stringify(data.metaNegocio || {}),
        data.tracksStock === false ? 0 : 1,
        id
      ]
    );

    const terminalScope = getTerminalScopeSelection();
    const configRows = await conn.query('SELECT active_branch_id FROM config WHERE id = 1 LIMIT 1');
    const preferredBranchId = Number(data.branchId || terminalScope.branchId || configRows[0]?.active_branch_id || 0) || null;
    const branchId = await resolveInventoryBranchId(conn, preferredBranchId);

    await ensureBranchInventoryCoverageForProduct(conn, {
      productId: Number(id),
      branchId,
      stock: Number(data.stock || 0),
      stockMin: Number(data.stockMin || 0)
    });

    let stockChange = null;
    if (branchId) {
      stockChange = await changeBranchInventoryStock(conn, {
        productId: Number(id),
        branchId,
        absoluteStock: Number(data.stock || 0),
        stockMin: Number(data.stockMin || 0)
      });
    }

    if (stockChange && stockChange.previousStock !== stockChange.nextStock) {
      await registerInventoryMovement(conn, {
        productId: Number(id),
        branchId,
        tipo: 'edicion',
        cantidad: stockChange.nextStock - stockChange.previousStock,
        stockAnterior: stockChange.previousStock,
        stockNuevo: stockChange.nextStock,
        costoUnitario: Number(data.precioCompra || previous.precio_compra || 0),
        referenciaTipo: 'producto',
        referenciaId: data.codigo,
        notas: 'Cambio de stock desde edición de producto',
        usuarioId: actor.userId,
        usuarioNombre: actor.userName
      });
    }

    const rows = await conn.query('SELECT * FROM products WHERE id = ?', [id]);
    return {
      row: rows[0],
      branchId
    };
  });

  try {
    await writeAuditLog({
      ...actor,
      moduleName: 'Productos',
      actionName: 'Producto actualizado',
      detail: `${data.codigo} · ${data.nombre}`
    });
  } catch (error) {
    console.warn('[audit] Falló al registrar producto actualizado:', error.message);
  }

  const updated = mapProductRow(updatedResult.row);
  try {
    productsCache.upsert(updated);
  } catch (error) {
    console.warn('[products-cache] No se pudo actualizar caché tras editar producto:', error.message);
  }
  // ── Sync reporte-sistema-pos (producto actualizado) ──
  fireReportSync(async () => {
    const cfg = await getReportSyncConfig();
    await reportsSync.syncProduct(updatedResult.row, { config: cfg, branchId: updatedResult.branchId });
  });
  await persistProductsCsvBackup('actualizar_producto');
  scheduleSilentProductBackup('actualizar_producto');
  res.json(updated);
});

app.delete('/api/products/:id', async (req, res) => {
  ensureNotCashier(req);
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!userCanManageGlobalProductCatalog(actorUser)) {
    return res.status(403).json({ error: 'No tienes permiso para eliminar productos globales.' });
  }
  const productRows = await query('SELECT id, codigo, nombre, stock, image_local FROM products WHERE id = ?', [req.params.id]);
  const product = productRows[0];
  if (!product) {
    return res.status(404).json({ error: 'Producto no encontrado.' });
  }
  if (Number(product.stock || 0) > 0) {
    return res.status(409).json({ error: 'No puedes eliminar este producto porque tiene stock pendiente.' });
  }
  const saleHistoryRows = await query('SELECT 1 FROM sale_items WHERE product_id = ? LIMIT 1', [req.params.id]);
  if (saleHistoryRows.length) {
    return res.status(409).json({
      error: 'No puedes eliminar este producto porque ya tiene historial de ventas. Ponlo inactivo si ya no lo venderás.'
    });
  }
  await withTransaction(async (conn) => {
    await conn.query('DELETE FROM products WHERE id = ?', [req.params.id]);
  });
  await removeLocalProductImage(product.image_local);
  productsCache.invalidate({ id: Number(req.params.id), codigo: product.codigo });
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Productos',
    actionName: 'Producto eliminado',
    detail: `${product.codigo} · ${product.nombre}`
  });
  fireReportSync(async () => {
    await deleteProductsFromReportsByIds([req.params.id]);
  });
  await persistProductsCsvBackup('eliminar_producto');
  scheduleSilentProductBackup('eliminar_producto');
  res.status(204).end();
});

// ── Limpieza masiva: elimina productos sin precio de venta configurado ────────
app.post('/api/admin/cleanup-zero-price-products', async (req, res) => {
  ensureNotCashier(req);
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!userCanManageGlobalProductCatalog(actorUser)) {
    return res.status(403).json({ error: 'No tienes permiso para realizar esta acción.' });
  }
  const zeroRows = await query(
    "SELECT id, codigo, nombre, stock FROM products WHERE (precio_venta IS NULL OR precio_venta = 0) AND estado != 'Eliminado'"
  );
  if (!zeroRows.length) {
    return res.json({ deleted: 0, products: [] });
  }
  const ids = zeroRows.map((p) => p.id);
  const placeholders = ids.map(() => '?').join(', ');
  await withTransaction(async (conn) => {
    // Eliminar sale_items y sales asociadas (ventas en 0, irrelevantes)
    const saleRows = await conn.query(
      `SELECT DISTINCT sale_id FROM sale_items WHERE product_id IN (${placeholders})`, ids
    );
    const saleIds = saleRows.map((r) => Number(r.sale_id)).filter(Boolean);
    if (saleIds.length) {
      const sp = saleIds.map(() => '?').join(', ');
      await conn.query(`DELETE FROM sale_items WHERE sale_id IN (${sp})`, saleIds);
      await conn.query(`DELETE FROM sales WHERE id IN (${sp})`, saleIds);
    }
    // Eliminar productos
    await conn.query(`DELETE FROM products WHERE id IN (${placeholders})`, ids);
    // Limpiar caché offline si la tabla existe
    try {
      await conn.query(`DELETE FROM offline_cache_products WHERE product_id IN (${placeholders})`, ids);
    } catch (_) { /* tabla puede no existir en todos los entornos */ }
    await recalculateCashAmount(conn);
  });
  for (const p of zeroRows) {
    productsCache.invalidate({ id: Number(p.id), codigo: p.codigo });
  }
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Productos',
    actionName: 'Limpieza masiva — productos sin precio',
    detail: `${ids.length} eliminados: ${zeroRows.map((p) => p.nombre).join(', ')}`
  });
  fireReportSync(async () => {
    await deleteProductsFromReportsByIds(ids);
  });
  await persistProductsCsvBackup('limpieza_productos_sin_precio');
  res.json({ deleted: ids.length, products: zeroRows.map((p) => ({ id: p.id, nombre: p.nombre })) });
});

app.post('/api/inventory/adjust', async (req, res) => {
  ensureNotCashier(req);
  const actorUser = await resolveRequestActorUser(req, { required: true });
  await ensureBusinessRulesExtensions();
  await ensureInventoryMovementsTable();
  const { productId, tipo, qty, notes } = req.body;
  const rows = await query('SELECT * FROM products WHERE id = ? LIMIT 1', [productId]);
  const product = rows[0];
  if (!product) {
    return res.status(404).json({ error: 'Producto no encontrado.' });
  }

  const terminalScope = getTerminalScopeSelection();
  const configRows = await query('SELECT active_branch_id FROM config WHERE id = 1 LIMIT 1');
  const preferredBranchId = Number(req.body?.branchId || terminalScope.branchId || configRows[0]?.active_branch_id || 0) || null;
  const branchId = await resolveInventoryBranchId(null, preferredBranchId);
  if (!branchId) {
    return res.status(400).json({ error: 'Debes seleccionar una sucursal para ajustar inventario.' });
  }
  assertActorCanAccessBranch(actorUser, branchId, 'No puedes ajustar inventario fuera de tu sucursal.');

  const quantity = Number(qty || 0);
  const inventoryChange = await changeBranchInventoryStock(null, {
    productId,
    branchId,
    quantityDelta: tipo === 'entrada' ? Math.abs(quantity) : tipo === 'salida' ? -Math.abs(quantity) : 0,
    absoluteStock: tipo === 'ajuste' ? Math.max(0, quantity) : null
  });
  const previousStock = inventoryChange.previousStock;
  const newStock = inventoryChange.nextStock;
  const updated = await query('SELECT * FROM products WHERE id = ?', [productId]);
  const actor = getActor(req);
  await registerInventoryMovement(null, {
    productId,
    branchId: Number(inventoryChange.branchId || branchId),
    tipo,
    cantidad: tipo === 'salida' ? -Math.abs(quantity) : tipo === 'ajuste' ? (newStock - previousStock) : Math.abs(quantity),
    stockAnterior: previousStock,
    stockNuevo: newStock,
    costoUnitario: Number(product.precio_compra || 0),
    referenciaTipo: 'manual',
    referenciaId: String(productId),
    notas: String(notes || '').trim() || `Ajuste manual de inventario: ${tipo}`,
    usuarioId: actor.userId,
    usuarioNombre: actor.userName
  });
  await writeAuditLog({
    ...actor,
    moduleName: 'Inventario',
    actionName: 'Ajuste de inventario',
    detail: `${product.nombre} · ${tipo} · cantidad ${qty}`
  });
  const movementRows = await query(
    `SELECT im.*, p.nombre AS product_name, p.codigo AS product_code
     FROM inventory_movements im
     LEFT JOIN products p ON p.id = im.product_id
     WHERE im.product_id = ?
     ORDER BY im.id DESC LIMIT 1`,
    [productId]
  );
  fireReportSync(async () => {
    await syncProductsToReportsByIds([productId], {
      branchId: inventoryChange.branchId || branchId,
    });
  });
  res.json({
    product: mapProductRow(updated[0]),
    movement: movementRows[0] ? mapInventoryMovementRow(movementRows[0]) : null
  });
});

app.get('/api/inventory/movements', async (req, res) => {
  const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
  await ensureInventoryMovementsTable();
  const productId = Number(req.query.productId || 0);
  const limit = Math.min(500, Math.max(20, Number(req.query.limit || 200)));
  const scopedBranchId = getUserScopeBranchId(actorUser);
  const params = [];
  let where = '';
  if (productId > 0) {
    where = 'WHERE im.product_id = ?';
    params.push(productId);
  }
  if (scopedBranchId) {
    where += where ? ' AND ' : 'WHERE ';
    where += 'COALESCE(im.branch_id, im.source_branch_id, im.destination_branch_id, 0) = ?';
    params.push(scopedBranchId);
  }
  const rows = await query(
    `SELECT im.*, p.nombre AS product_name, p.codigo AS product_code
     FROM inventory_movements im
     LEFT JOIN products p ON p.id = im.product_id
     ${where}
     ORDER BY im.id DESC
     LIMIT ${limit}`,
    params
  );
  res.json(rows.map(mapInventoryMovementRow));
});

app.post('/api/clients', async (req, res) => {
  const data = sanitizeClientPayload(req.body);
  await ensureClientExtensions();
  if (!data.nombre) {
    return res.status(400).json({ error: 'El nombre del cliente es requerido.' });
  }
  const result = await query(
    `INSERT INTO clients
      (nombre, telefono, email, direccion, cedula, rnc, limite_credito, balance, reference_note, location_link, latitude, longitude)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.nombre,
      normalizeOptionalText(data.telefono),
      normalizeOptionalText(data.email),
      normalizeOptionalText(data.direccion),
      normalizeOptionalText(data.cedula),
      normalizeOptionalText(data.rnc),
      data.limiteCredito,
      data.balance,
      normalizeOptionalText(data.referencia),
      normalizeOptionalText(data.linkUbicacion),
      Number.isFinite(data.latitud) ? data.latitud : null,
      Number.isFinite(data.longitud) ? data.longitud : null
    ]
  );
  const createdRow = await resolveClientRowAfterInsert(result.insertId, data);
  if (!createdRow) {
    return res.status(500).json({ error: 'El cliente se guardó, pero no se pudo leer el registro creado.' });
  }
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Clientes',
    actionName: 'Cliente creado',
    detail: data.nombre
  });
  await trySyncPosClientToFirebaseById(createdRow.id).catch((error) => {
    console.warn('No se pudo sincronizar el cliente nuevo a Firebase:', error.message);
  });
  // ── Sync reporte-sistema-pos (cliente creado) ──
  fireReportSync(async () => {
    const cfg = await getReportSyncConfig();
    await reportsSync.syncCustomer(createdRow, { config: cfg });
  });
  res.status(201).json(mapClientRow(createdRow));
});

app.put('/api/clients/:id', async (req, res) => {
  const data = sanitizeClientPayload(req.body);
  const { id } = req.params;
  await ensureClientExtensions();
  if (!data.nombre) {
    return res.status(400).json({ error: 'El nombre del cliente es requerido.' });
  }
  await query(
    `UPDATE clients
     SET nombre = ?, telefono = ?, email = ?, direccion = ?, cedula = ?, rnc = ?, limite_credito = ?, balance = ?, reference_note = ?, location_link = ?, latitude = ?, longitude = ?
     WHERE id = ?`,
    [
      data.nombre,
      normalizeOptionalText(data.telefono),
      normalizeOptionalText(data.email),
      normalizeOptionalText(data.direccion),
      normalizeOptionalText(data.cedula),
      normalizeOptionalText(data.rnc),
      data.limiteCredito,
      data.balance,
      normalizeOptionalText(data.referencia),
      normalizeOptionalText(data.linkUbicacion),
      Number.isFinite(data.latitud) ? data.latitud : null,
      Number.isFinite(data.longitud) ? data.longitud : null,
      id
    ]
  );
  const rows = await getClientRowsWithComputedBalance(id);
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Clientes',
    actionName: 'Cliente actualizado',
    detail: data.nombre
  });
  await trySyncPosClientToFirebaseById(id).catch((error) => {
    console.warn('No se pudo sincronizar el cliente actualizado a Firebase:', error.message);
  });
  // ── Sync reporte-sistema-pos (cliente actualizado) ──
  fireReportSync(async () => {
    const cfg = await getReportSyncConfig();
    if (rows[0]) await reportsSync.syncCustomer(rows[0], { config: cfg });
  });
  res.json(mapClientRow(rows[0]));
});

app.delete('/api/clients/:id', async (req, res) => {
  const clientRows = await getClientRowsWithComputedBalance(req.params.id);
  const client = clientRows[0];
  if (!client) {
    return res.status(404).json({ error: 'Cliente no encontrado.' });
  }

  const pendingCreditRows = await query(
    `SELECT COUNT(*) AS total
     FROM sales
     WHERE client_id = ? AND payment_method = "credito" AND total > received_amount`,
    [req.params.id]
  );
  const hasPendingCredit = Number(pendingCreditRows[0]?.total || 0) > 0;
  const balance = Number(client.balance || 0);
  if (balance > 0 || hasPendingCredit) {
    return res.status(409).json({
      error: 'No puedes eliminar este cliente porque tiene factura o balance pendiente.'
    });
  }

  await withTransaction(async (conn) => {
    const saleRows = await conn.query('SELECT id FROM sales WHERE client_id = ?', [req.params.id]);
    const saleIds = saleRows.map((row) => Number(row.id)).filter(Boolean);
    if (saleIds.length) {
      const placeholders = saleIds.map(() => '?').join(', ');
      await conn.query(`DELETE FROM sale_items WHERE sale_id IN (${placeholders})`, saleIds);
      await conn.query(`DELETE FROM sales WHERE id IN (${placeholders})`, saleIds);
    }
    await conn.query('DELETE FROM clients WHERE id = ?', [req.params.id]);
    await recalculateCashAmount(conn);
  });
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Clientes',
    actionName: 'Cliente eliminado',
    detail: client.nombre || `ID ${req.params.id}`
  });
  await tryDeletePosClientSync(req.params.id).catch((error) => {
    console.warn('No se pudo eliminar el cliente de Firebase:', error.message);
  });
  // ── Sync reporte-sistema-pos (cliente eliminado) ──
  fireReportSync(async () => {
    const cfg = await getReportSyncConfig();
    await reportsSync.deleteCustomer(req.params.id, { config: cfg });
  });
  res.status(204).end();
});

app.get('/api/clients/:id/credit-sales', async (req, res) => {
  await ensureClientExtensions();
  await ensureSalesExtensions();

  const clientId = Number(req.params.id || 0);
  if (!clientId) {
    return res.status(400).json({ error: 'Cliente no válido.' });
  }

  const clientRow = await getClientRowWithComputedBalance(clientId);
  if (!clientRow) {
    return res.status(404).json({ error: 'Cliente no encontrado.' });
  }

  const sales = await query(
    `SELECT id, invoice_number, document_type, created_at, total, received_amount
     FROM sales
     WHERE client_id = ?
       AND payment_method = 'credito'
       AND COALESCE(fiscal_status, 'emitida') <> 'cancelada'
       AND COALESCE(total, 0) > COALESCE(received_amount, 0)
     ORDER BY created_at ASC, id ASC`,
    [clientId]
  );

  const mappedSales = sales.map((sale) => {
    const total = normalizeCurrencyAmount(sale.total || 0);
    const receivedAmount = normalizeCurrencyAmount(sale.received_amount || 0);
    const pendingAmount = normalizeCurrencyAmount(Math.max(0, total - receivedAmount));
    return {
      id: Number(sale.id || 0),
      invoiceNumber: sale.invoice_number,
      documentType: sale.document_type || 'ticket',
      fecha: sale.created_at,
      total,
      recibido: receivedAmount,
      pendiente: pendingAmount
    };
  });

  res.json({
    client: mapClientRow(clientRow),
    sales: mappedSales,
    totalPending: normalizeCurrencyAmount(mappedSales.reduce((sum, sale) => sum + Number(sale.pendiente || 0), 0))
  });
});

app.post('/api/clients/:id/credit-payments', async (req, res) => {
  await ensureClientExtensions();
  await ensureSalesExtensions();
  await ensureCashMovementExtensions();

  const clientId = Number(req.params.id || 0);
  const amount = normalizeCurrencyAmount(req.body?.monto || 0);
  const paymentMethod = ['efectivo', 'tarjeta', 'transferencia'].includes(String(req.body?.metodo || '').trim())
    ? String(req.body.metodo).trim()
    : 'efectivo';
  const notes = String(req.body?.obs || '').trim() || 'Cobro de crédito a cliente';
  const actor = getActor(req);

  if (!clientId) {
    return res.status(400).json({ error: 'Cliente no válido.' });
  }
  if (amount <= 0) {
    return res.status(400).json({ error: 'El monto del cobro debe ser mayor que cero.' });
  }

  const result = await withTransaction(async (conn) => {
    const clientRow = await getClientRowWithComputedBalance(clientId, conn);
    if (!clientRow) {
      const error = new Error('Cliente no encontrado.');
      error.statusCode = 404;
      throw error;
    }

    const pendingSales = await conn.query(
      `SELECT id, invoice_number, total, received_amount, created_at
       FROM sales
       WHERE client_id = ?
         AND payment_method = 'credito'
         AND COALESCE(fiscal_status, 'emitida') <> 'cancelada'
         AND COALESCE(total, 0) > COALESCE(received_amount, 0)
       ORDER BY created_at ASC, id ASC`,
      [clientId]
    );

    if (!pendingSales.length) {
      const error = new Error('Este cliente no tiene facturas a crédito pendientes.');
      error.statusCode = 409;
      throw error;
    }

    const totalPending = normalizeCurrencyAmount(
      pendingSales.reduce((sum, sale) => sum + Math.max(0, Number(sale.total || 0) - Number(sale.received_amount || 0)), 0)
    );
    if (amount > totalPending) {
      const error = new Error('El monto supera el balance pendiente del cliente.');
      error.statusCode = 409;
      throw error;
    }

    let sessionId = null;
    if (paymentMethod === 'efectivo') {
      const sessions = await conn.query('SELECT * FROM cash_sessions WHERE status = "open" ORDER BY id DESC LIMIT 1');
      const session = sessions[0];
      if (!session) {
        const error = new Error('Debes tener una caja abierta para registrar cobros en efectivo.');
        error.statusCode = 409;
        throw error;
      }
      sessionId = Number(session.id || 0);
    }

    let remaining = amount;
    const appliedSales = [];

    for (const sale of pendingSales) {
      if (remaining <= 0) break;
      const total = normalizeCurrencyAmount(sale.total || 0);
      const receivedAmount = normalizeCurrencyAmount(sale.received_amount || 0);
      const pendingAmount = normalizeCurrencyAmount(Math.max(0, total - receivedAmount));
      const appliedAmount = normalizeCurrencyAmount(Math.min(remaining, pendingAmount));
      if (appliedAmount <= 0) continue;

      const newReceivedAmount = normalizeCurrencyAmount(receivedAmount + appliedAmount);
      await conn.query(
        'UPDATE sales SET received_amount = ?, change_amount = 0 WHERE id = ?',
        [newReceivedAmount, sale.id]
      );

      appliedSales.push({
        invoiceNumber: sale.invoice_number,
        appliedAmount,
        pendienteAnterior: pendingAmount,
        pendienteActual: normalizeCurrencyAmount(Math.max(0, pendingAmount - appliedAmount))
      });
      remaining = normalizeCurrencyAmount(Math.max(0, remaining - appliedAmount));
    }

    const updatedPendingTotal = normalizeCurrencyAmount(Math.max(0, totalPending - amount));
    await conn.query('UPDATE clients SET balance = ? WHERE id = ?', [updatedPendingTotal, clientId]);

    if (paymentMethod === 'efectivo') {
      await conn.query(
        `INSERT INTO cash_movements (session_id, movement_type, amount, notes, created_by_user_id, created_by_user_name, happened_at)
         VALUES (?, "Cobro crédito cliente", ?, ?, ?, ?, datetime('now'))`,
        [sessionId, amount, notes, actor.userId || null, actor.userName || 'Sistema']
      );
      await conn.query('UPDATE config SET cash_amount = cash_amount + ? WHERE id = 1', [amount]);
    }

    return {
      client: mapClientRow(await getClientRowWithComputedBalance(clientId, conn)),
      appliedSales,
      totalPaid: amount,
      totalPending: updatedPendingTotal
    };
  });

  await writeAuditLog({
    ...actor,
    moduleName: 'Clientes',
    actionName: 'Cobro de crédito registrado',
    detail: `${result.client.nombre} · ${paymentMethod} · abono ${amount.toFixed(2)}`
  });

  res.json({
    ...result,
    config: await getConfig()
  });
});

app.post('/api/mobile/customer-auth/firebase', async (req, res) => {
  await ensureMobileTables(query);
  const firebaseStatus = getFirebaseConfigStatus();
  if (!firebaseStatus.enabled) {
    return res.status(503).json({
      error: firebaseStatus.reason || 'Firebase no esta configurado para clientes POS.',
      collection: firebaseStatus.collection
    });
  }

  const decodedToken = await verifyFirebaseIdToken(String(req.body?.idToken || '').trim());
  const provider = String(decodedToken.firebase?.sign_in_provider || 'password').trim() || 'password';
  const email = String(decodedToken.email || req.body?.email || '').trim().toLowerCase();
  const displayName = String(req.body?.nombre || decodedToken.name || email.split('@')[0] || 'Cliente POS').trim();
  const telefono = String(req.body?.telefono || '').trim();
  const direccion = String(req.body?.direccion || '').trim();
  const cedula = String(req.body?.cedula || '').trim();
  const referencia = String(req.body?.referencia || '').trim();
  const linkUbicacion = String(req.body?.linkUbicacion || '').trim();

  if (!email) {
    return res.status(400).json({ error: 'La cuenta de Firebase debe tener un correo disponible.' });
  }

  const result = await withTransaction(async (conn) => {
    const firebaseUserRows = await conn.query(
      'SELECT * FROM users WHERE firebase_uid = ? LIMIT 1',
      [decodedToken.uid]
    );
    let localUser = firebaseUserRows[0] || null;

    if (!localUser) {
      const emailRows = await conn.query(
        'SELECT * FROM users WHERE email = ? AND account_type = "customer" LIMIT 1',
        [email]
      );
      localUser = emailRows[0] || null;
    }

    let clientId = localUser?.linked_client_id ? Number(localUser.linked_client_id) : null;
    if (!clientId) {
      const linkedClientRows = await conn.query(
        'SELECT * FROM clients WHERE email = ? LIMIT 1',
        [email]
      );
      clientId = linkedClientRows[0]?.id ? Number(linkedClientRows[0].id) : null;
    }

    if (!clientId) {
      const clientInsert = await conn.query(
        `INSERT INTO clients
          (nombre, telefono, email, direccion, cedula, limite_credito, balance, reference_note, location_link, latitude, longitude)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, NULL, NULL)`,
        [
          displayName,
          normalizeOptionalText(telefono),
          email,
          normalizeOptionalText(direccion),
          normalizeOptionalText(cedula),
          normalizeOptionalText(referencia),
          normalizeOptionalText(linkUbicacion)
        ]
      );
      const insertedClient = await resolveClientRowAfterInsert(clientInsert.insertId, {
        nombre: displayName,
        telefono,
        cedula
      });
      clientId = insertedClient?.id ? Number(insertedClient.id) : null;
    } else {
      await conn.query(
        `UPDATE clients
         SET nombre = ?, telefono = COALESCE(?, telefono), email = ?, direccion = COALESCE(?, direccion), cedula = COALESCE(?, cedula),
             reference_note = COALESCE(?, reference_note), location_link = COALESCE(?, location_link)
         WHERE id = ?`,
        [
          displayName,
          normalizeOptionalText(telefono),
          email,
          normalizeOptionalText(direccion),
          normalizeOptionalText(cedula),
          normalizeOptionalText(referencia),
          normalizeOptionalText(linkUbicacion),
          clientId
        ]
      );
    }

    const usernameBase = buildCustomerUsername(email, decodedToken.uid, clientId);
    let username = usernameBase;
    if (!localUser) {
      let suffix = 1;
      // Keep generated usernames unique without asking the customer for one.
      while (true) {
        const duplicateRows = await conn.query(
          'SELECT id FROM users WHERE usuario = ? LIMIT 1',
          [username]
        );
        if (!duplicateRows.length) break;
        suffix += 1;
        username = `${usernameBase}${suffix}`;
      }

      const customerPassword = createRandomLocalPassword();
      const insertUser = await conn.query(
        `INSERT INTO users
          (usuario, email, password, password_hash, nombre, rol, estado, last_login, linked_client_id, account_type, auth_provider, firebase_uid, fecha_creacion)
         VALUES (?, ?, ?, ?, ?, 'Cliente', 'Activo', datetime('now'), ?, 'customer', ?, ?, datetime('now'))`,
        [
          username,
          email,
          customerPassword,
          createLocalPasswordHash(customerPassword),
          displayName,
          clientId,
          provider,
          decodedToken.uid
        ]
      );
      const insertedRows = await conn.query('SELECT * FROM users WHERE id = ? LIMIT 1', [insertUser.insertId]);
      localUser = insertedRows[0];
    } else {
      await conn.query(
        `UPDATE users
         SET email = ?, nombre = ?, rol = 'Cliente', estado = 'Activo', last_login = datetime('now'),
             linked_client_id = ?, account_type = 'customer', auth_provider = ?, firebase_uid = ?
         WHERE id = ?`,
        [email, displayName, clientId, provider, decodedToken.uid, localUser.id]
      );
      const updatedRows = await conn.query('SELECT * FROM users WHERE id = ? LIMIT 1', [localUser.id]);
      localUser = updatedRows[0];
    }

    return {
      localUser,
      clientId
    };
  });

  await writeAuditLog({
    userId: result.localUser.id,
    userName: result.localUser.nombre,
    userRole: result.localUser.rol,
    moduleName: 'POS Movil',
    actionName: 'Inicio de sesion cliente POS',
    detail: `${provider} · ${email}`
  });
  await trySyncPosClientToFirebaseById(result.clientId).catch((error) => {
    console.warn('No se pudo sincronizar el cliente POS autenticado a Firebase:', error.message);
  });

  const config = await getConfig();
  res.json({
    user: mapUserRow(result.localUser),
    appName: config.nombre,
    enabled: true
  });
});

app.post('/api/suppliers', async (req, res) => {
  await ensureSuppliersTable();
  const data = req.body || {};
  const nombre = String(data.nombre || '').trim();
  if (!nombre) {
    return res.status(400).json({ error: 'El nombre del proveedor es obligatorio.' });
  }

  const result = await query(
    `INSERT INTO suppliers (nombre, empresa, telefono, email, rnc, contacto, direccion, visit_days, payment_terms_days, estado)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      nombre,
      data.empresa || null,
      data.telefono || null,
      data.email || null,
      data.rnc || null,
      data.contacto || null,
      data.direccion || null,
      data.diasVisita || null,
      Number(data.terminosPagoDias || 30),
      data.estado || 'Activo'
    ]
  );
  const rows = await query('SELECT * FROM suppliers WHERE id = ?', [result.insertId]);
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Proveedores',
    actionName: 'Proveedor creado',
    detail: nombre
  });
  res.status(201).json(mapSupplierRow(rows[0]));
});

app.put('/api/suppliers/:id', async (req, res) => {
  await ensureSuppliersTable();
  const data = req.body || {};
  const nombre = String(data.nombre || '').trim();
  if (!nombre) {
    return res.status(400).json({ error: 'El nombre del proveedor es obligatorio.' });
  }

  await query(
    `UPDATE suppliers
     SET nombre = ?, empresa = ?, telefono = ?, email = ?, rnc = ?, contacto = ?, direccion = ?, visit_days = ?, payment_terms_days = ?, estado = ?
     WHERE id = ?`,
    [
      nombre,
      data.empresa || null,
      data.telefono || null,
      data.email || null,
      data.rnc || null,
      data.contacto || null,
      data.direccion || null,
      data.diasVisita || null,
      Number(data.terminosPagoDias || 30),
      data.estado || 'Activo',
      req.params.id
    ]
  );
  const rows = await query('SELECT * FROM suppliers WHERE id = ?', [req.params.id]);
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Proveedores',
    actionName: 'Proveedor actualizado',
    detail: nombre
  });
  res.json(mapSupplierRow(rows[0]));
});

app.delete('/api/suppliers/:id', async (req, res) => {
  await ensureSuppliersTable();
  await ensureSupplierInvoicesTable();
  const rows = await query('SELECT nombre FROM suppliers WHERE id = ?', [req.params.id]);
  if (!rows.length) {
    return res.status(404).json({ error: 'Proveedor no encontrado.' });
  }
  const pendingRows = await query(
    'SELECT COUNT(*) AS total FROM supplier_invoices WHERE supplier_id = ? AND pending_amount > 0',
    [req.params.id]
  );
  if (Number(pendingRows[0]?.total || 0) > 0) {
    return res.status(409).json({
      error: 'No puedes eliminar este proveedor porque tiene facturas pendientes.'
    });
  }
  await query('DELETE FROM suppliers WHERE id = ?', [req.params.id]);
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Proveedores',
    actionName: 'Proveedor eliminado',
    detail: rows[0]?.nombre || `ID ${req.params.id}`
  });
  res.status(204).end();
});

app.post('/api/supplier-invoices', async (req, res) => {
  await ensureSuppliersTable();
  await ensureSupplierInvoicesTable();
  const data = req.body || {};
  const supplierId = Number(data.supplierId || 0);
  const invoiceNumber = String(data.numeroFactura || '').trim();
  const issuedAt = String(data.fechaEmision || '').trim();
  const totalAmount = Number(data.montoTotal || 0);
  const paidAmount = Number(data.montoPagado || 0);
  const pendingAmount = Math.max(0, totalAmount - paidAmount);

  if (!supplierId || !invoiceNumber || !issuedAt || totalAmount <= 0) {
    return res.status(400).json({ error: 'Proveedor, número de factura, fecha y monto total son obligatorios.' });
  }

  const supplierRows = await query('SELECT * FROM suppliers WHERE id = ? LIMIT 1', [supplierId]);
  if (!supplierRows.length) {
    return res.status(404).json({ error: 'Proveedor no encontrado.' });
  }

  const dueAt = String(data.fechaVencimiento || '').trim() || null;
  const status = pendingAmount <= 0 ? 'Pagada' : (dueAt && dueAt < new Date().toISOString().slice(0, 10) ? 'Vencida' : 'Pendiente');
  const result = await query(
    `INSERT INTO supplier_invoices (supplier_id, invoice_number, issued_at, due_at, total_amount, paid_amount, pending_amount, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [supplierId, invoiceNumber, issuedAt, dueAt, totalAmount, paidAmount, pendingAmount, status, data.notas || null]
  );
  const rows = await query(
    'SELECT si.*, s.nombre AS supplier_name FROM supplier_invoices si LEFT JOIN suppliers s ON s.id = si.supplier_id WHERE si.id = ?',
    [result.insertId]
  );
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Proveedores',
    actionName: 'Factura proveedor registrada',
    detail: `${supplierRows[0].nombre} · ${invoiceNumber} · pendiente ${pendingAmount.toFixed(2)}`
  });
  res.status(201).json(mapSupplierInvoiceRow(rows[0]));
});

app.post('/api/supplier-invoices/:id/payment', async (req, res) => {
  await ensureSupplierInvoicesTable();
  const invoiceId = Number(req.params.id);
  const amount = Number(req.body?.monto || 0);
  if (!invoiceId || amount <= 0) {
    return res.status(400).json({ error: 'El abono debe ser mayor que cero.' });
  }

  const rows = await query(
    'SELECT si.*, s.nombre AS supplier_name FROM supplier_invoices si LEFT JOIN suppliers s ON s.id = si.supplier_id WHERE si.id = ? LIMIT 1',
    [invoiceId]
  );
  const invoice = rows[0];
  if (!invoice) {
    return res.status(404).json({ error: 'Factura de proveedor no encontrada.' });
  }

  const newPaid = Math.min(Number(invoice.total_amount || 0), Number(invoice.paid_amount || 0) + amount);
  const newPending = Math.max(0, Number(invoice.total_amount || 0) - newPaid);
  const status = resolveSupplierInvoiceStatus({
    pending_amount: newPending,
    due_at: invoice.due_at
  });

  await query(
    'UPDATE supplier_invoices SET paid_amount = ?, pending_amount = ?, status = ? WHERE id = ?',
    [newPaid, newPending, status, invoiceId]
  );
  const updatedRows = await query(
    'SELECT si.*, s.nombre AS supplier_name FROM supplier_invoices si LEFT JOIN suppliers s ON s.id = si.supplier_id WHERE si.id = ?',
    [invoiceId]
  );
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Proveedores',
    actionName: 'Abono a factura proveedor',
    detail: `${invoice.supplier_name} · ${invoice.invoice_number} · abono ${amount.toFixed(2)}`
  });
  res.json(mapSupplierInvoiceRow(updatedRows[0]));
});

app.post('/api/users', async (req, res) => {
  const actorUser = await resolveUserManagementActor(req);
  const data = req.body || {};
  const normalized = await validateAndNormalizeUserPayload(data, actorUser);
  const result = await query(
    `INSERT INTO users
      (usuario, email, password, password_hash, nombre, rol, role_id, estado, last_login, branch_id, sucursal_id, caja_id, tipo_facturacion, telefono, observacion, creado_por, fecha_creacion)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, "—", ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      normalized.usuario,
      normalized.email,
      normalized.password,
      normalized.passwordHash,
      normalized.nombre,
      normalized.role.legacyLabel,
      normalized.role.id,
      normalized.estado,
      normalized.sucursalId,
      normalized.sucursalId,
      normalized.cajaId,
      normalized.tipoFacturacion,
      normalized.telefono,
      normalized.observacion,
      Number(actorUser.id)
    ]
  );
  let firebaseAuthResult = null;
  if (normalized.email) {
    firebaseAuthResult = await trySyncStaffFirebaseAuthForLocalUser(result.insertId).catch((error) => ({
      synced: false,
      reason: error.message,
    }));
  }
  const rows = await query('SELECT * FROM users WHERE id = ?', [result.insertId]);
  clearPublicUsersListCache();
  await writeAuditLog({
    userId: actorUser.id,
    userName: actorUser.nombre,
    userRole: actorUser.rol,
    moduleName: 'Usuarios',
    actionName: 'Usuario creado',
    detail: `${normalized.usuario} · rol ${normalized.role.nombre}${normalized.sucursalId ? ` · sucursal ${normalized.sucursalId}` : ''}${normalized.cajaId ? ` · caja ${normalized.cajaId}` : ''} · función ${getBillingFunctionLabel(normalized.tipoFacturacion)}`
  });
  await trySyncAllPosAccountsToFirebase().catch((error) => {
    console.warn('No se pudo sincronizar el usuario POS creado a Firebase:', error.message);
  });
  // ── Sync reporte-sistema-pos (user Firebase Auth + users/{uid}) ──
  fireReportSync(async () => {
    const cfg = await getReportSyncConfig();
    await reportsSync.ensureFirebaseUser({
      id: rows[0]?.id || result.insertId,
      email: normalized.email,
      password: data.password || data.contrasena || '', // plain si vino en el payload
      nombre: normalized.nombre,
      usuario: normalized.usuario,
      rol: normalized.role?.codigo || normalized.role?.legacyLabel || 'supervisor',
      rol_label: normalized.role?.legacyLabel || normalized.role?.nombre || 'Supervisor',
      role_code: normalized.role?.codigo || normalized.role?.legacyLabel || 'supervisor',
      estado: normalized.estado,
      billing_function: normalized.tipoFacturacion,
      branch_ids: normalized.sucursalId ? [String(normalized.sucursalId)] : [],
      allowed_modules: [],
      created_at: rows[0]?.fecha_creacion || new Date(),
    }, { config: cfg });
  });
  res.status(201).json({
    ...mapUserRow(rows[0]),
    firebaseAuthSynced: Boolean(firebaseAuthResult?.synced),
    firebaseAuthWarning: firebaseAuthResult && !firebaseAuthResult.synced
      ? buildFirebaseAuthWarning(firebaseAuthResult.reason, 'crear')
      : ''
  });
});

function buildFirebaseAuthWarning(reason, action = 'sincronizar') {
  if (!reason || reason === 'synced') return '';
  if (reason === 'missing_password_for_new_account') {
    return `Se guardó el usuario local, pero falta una contraseña para ${action} su acceso Firebase.`;
  }
  if (reason === 'password_too_short') {
    return 'Se guardó el usuario local, pero la contraseña debe tener al menos 6 caracteres para crear su acceso móvil.';
  }
  if (reason === 'missing_email') {
    return 'Se guardó el usuario local, pero sin correo no se puede crear su acceso Firebase.';
  }
  if (reason === 'customer_account') {
    return '';
  }
  if (String(reason).includes('admin SDK') || String(reason).includes('service account') || String(reason).includes('PERMISSION_DENIED')) {
    return `Firebase: el service account no tiene permiso suficiente (Firebase Authentication Admin). Verifica los roles IAM de la clave de servicio.`;
  }
  return `No se pudo sincronizar el acceso Firebase: ${reason}`;
}

app.put('/api/users/:id', async (req, res) => {
  const actorUser = await resolveUserManagementActor(req);
  await ensureBusinessRulesExtensions();
  const id = Number(req.params.id);
  const data = req.body || {};
  const user = await getUserWithRoleContextById(id);
  if (!user) {
    return res.status(404).json({ error: 'Usuario no encontrado.' });
  }
  const actorRoleCode = normalizeLegacyUserRoleCode(actorUser?.role_code || actorUser?.rol);
  const currentTargetRoleCode = normalizeLegacyUserRoleCode(user?.role_code || user?.rol);
  const actorBranchId = getUserBranchIdValue(actorUser);
  const targetBranchId = getUserBranchIdValue(user);
  if (!canAssignManagedRole(actorUser, currentTargetRoleCode)) {
    return res.status(403).json({ error: 'No tienes permiso para editar este tipo de usuario.' });
  }
  if (actorRoleCode !== 'administrador_general' && actorBranchId && Number(targetBranchId || 0) !== Number(actorBranchId || 0)) {
    return res.status(403).json({ error: 'No puedes editar usuarios fuera de tu sucursal.' });
  }

  const normalized = await validateAndNormalizeUserPayload(data, actorUser, { existingUser: user });

  if (currentTargetRoleCode === 'administrador_general' && (normalized.roleCode !== 'administrador_general' || normalized.estado !== 'Activo')) {
    const adminRows = await query(
      `SELECT COUNT(*) AS total
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.estado = 'Activo'
         AND (COALESCE(r.codigo, '') = 'administrador_general' OR LOWER(COALESCE(u.rol, '')) = 'administrador')`
    );
    if (Number(adminRows[0]?.total || 0) <= 1) {
      return res.status(409).json({ error: 'Debe quedar al menos un administrador general activo en el sistema.' });
    }
  }

  await query(
    `UPDATE users
     SET usuario = ?, email = ?, password = ?, password_hash = ?, nombre = ?, rol = ?, role_id = ?, branch_id = ?, sucursal_id = ?, caja_id = ?, tipo_facturacion = ?, telefono = ?, observacion = ?, estado = ?
     WHERE id = ?`,
    [
      normalized.usuario,
      normalized.email,
      normalized.password,
      normalized.passwordHash,
      normalized.nombre,
      normalized.role.legacyLabel,
      normalized.role.id,
      normalized.sucursalId,
      normalized.sucursalId,
      normalized.cajaId,
      normalized.tipoFacturacion,
      normalized.telefono,
      normalized.observacion,
      normalized.estado,
      id
    ]
  );
  let firebaseAuthResult = null;
  if (normalized.email) {
    firebaseAuthResult = await trySyncStaffFirebaseAuthForLocalUser(id).catch((error) => ({
      synced: false,
      reason: error.message,
    }));
  }
  const updatedRows = await query('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
  clearPublicUsersListCache();
  await writeAuditLog({
    userId: actorUser.id,
    userName: actorUser.nombre,
    userRole: actorUser.rol,
    moduleName: 'Usuarios',
    actionName: 'Usuario actualizado',
    detail: `${updatedRows[0].usuario} · rol ${normalized.role.nombre}${normalized.sucursalId ? ` · sucursal ${normalized.sucursalId}` : ''}${normalized.cajaId ? ` · caja ${normalized.cajaId}` : ''} · función ${getBillingFunctionLabel(normalized.tipoFacturacion)}`
  });
  await trySyncAllPosAccountsToFirebase().catch((error) => {
    console.warn('No se pudo sincronizar el usuario POS actualizado a Firebase:', error.message);
  });
  // ── Sync reporte-sistema-pos (user Firebase Auth + users/{uid}) ──
  fireReportSync(async () => {
    const cfg = await getReportSyncConfig();
    await reportsSync.ensureFirebaseUser({
      id: updatedRows[0]?.id || id,
      email: normalized.email,
      password: data.password || data.contrasena || '',
      nombre: normalized.nombre,
      usuario: normalized.usuario,
      rol: normalized.role?.codigo || normalized.role?.legacyLabel || 'supervisor',
      rol_label: normalized.role?.legacyLabel || normalized.role?.nombre || 'Supervisor',
      role_code: normalized.role?.codigo || normalized.role?.legacyLabel || 'supervisor',
      estado: normalized.estado,
      billing_function: normalized.tipoFacturacion,
      branch_ids: normalized.sucursalId ? [String(normalized.sucursalId)] : [],
      allowed_modules: [],
      created_at: updatedRows[0]?.fecha_creacion || new Date(),
    }, { config: cfg });
  });
  res.json({
    ...mapUserRow(updatedRows[0]),
    firebaseAuthSynced: Boolean(firebaseAuthResult?.synced),
    firebaseAuthWarning: firebaseAuthResult && !firebaseAuthResult.synced
      ? buildFirebaseAuthWarning(firebaseAuthResult.reason, 'actualizar')
      : ''
  });
});

app.post('/api/users/:id/sync-firebase', async (req, res) => {
  const actorUser = await resolveUserManagementActor(req);
  const id = Number(req.params.id);
  const manualFirebaseUid = String(req.body?.firebaseUid || '').trim();

  const user = await getUserWithRoleContextById(id);
  if (!user) {
    return res.status(404).json({ error: 'Usuario no encontrado.' });
  }
  if (!canAssignManagedRole(actorUser, normalizeLegacyUserRoleCode(user?.role_code || user?.rol))) {
    return res.status(403).json({ error: 'No tienes permiso para sincronizar este usuario.' });
  }

  if (manualFirebaseUid) {
    const conflict = await query(
      'SELECT id FROM users WHERE firebase_uid = ? AND id <> ? LIMIT 1',
      [manualFirebaseUid, id]
    );
    if (conflict.length) {
      return res.status(409).json({ error: 'Ese UID de Firebase ya está vinculado a otro usuario.' });
    }
    await query('UPDATE users SET firebase_uid = ? WHERE id = ?', [manualFirebaseUid, id]);
  }

  const result = await trySyncStaffFirebaseAuthForLocalUser(id).catch((err) => ({
    synced: false,
    reason: err.message || 'Error desconocido al sincronizar con Firebase.',
  }));

  const statusCode = result?.synced ? 200 : 422;
  return res.status(statusCode).json({
    synced: Boolean(result?.synced),
    uid: result?.uid || null,
    reason: result?.reason || null,
    reportsApp: result?.reportsApp || null,
    message: result?.synced
      ? 'Usuario sincronizado correctamente con Firebase Auth y la app de reportes.'
      : (result?.reason === 'missing_password_for_new_account'
          ? 'El usuario no tiene contraseña guardada. Edítalo y asígnale una contraseña de al menos 6 caracteres.'
          : (result?.reason === 'password_too_short'
              ? 'La contraseña tiene menos de 6 caracteres. Edítalo y actualiza la contraseña.'
          : (result?.reason === 'missing_email'
              ? 'El usuario no tiene correo electrónico. Edítalo y agrega un correo.'
          : (result?.reason || 'No se pudo sincronizar con Firebase. Verifica los logs del servidor.')))),
  });
});

app.put('/api/config', async (req, res) => {
  ensureNotCashier(req);
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!userCanManageGlobalConfig(actorUser)) {
    return res.status(403).json({ error: 'La configuración global solo puede ser cambiada por el administrador general.' });
  }
  const data = req.body;
  await ensureConfigExtensions();
  await ensureBusinessRulesExtensions();
  const language = String(data.idioma || 'es').trim().toLowerCase();
  const salesOperationMode = String(data.salesOperationMode || data.modoOperacionVentas || 'directa').trim().toLowerCase();
  const businessStructureMode = normalizeBusinessStructureMode(data.businessStructureMode || data.estructuraNegocio || 'monocaja');
  const cashDrawerMethod = ['escpos', 'network', 'serial'].includes(String(data.cashDrawerMethod || '').trim().toLowerCase())
    ? String(data.cashDrawerMethod || '').trim().toLowerCase()
    : 'escpos';
  const cashDrawerPin = Number(data.cashDrawerPin) === 1 ? 1 : 0;
  const cashDrawerNetworkPort = Math.max(1, Math.min(65535, Number(data.cashDrawerNetworkPort || 9100) || 9100));
  const cashDrawerSerialPort = String(data.cashDrawerSerialPort || 'COM1').trim() || 'COM1';
  const scaleType = normalizeScaleType(data.scaleType);
  const scaleSerialPort = String(data.scaleSerialPort || '').trim();
  const scaleSerialBaudRate = Math.max(300, Math.min(256000, Number(data.scaleSerialBaudRate || 9600) || 9600));
  const scaleDefaultUnit = normalizeScaleDefaultUnit(data.scaleDefaultUnit);
  const scaleReadPattern = String(data.scaleReadPattern || '').trim();
  const scaleRoundingDecimals = sanitizeScaleRoundingDecimals(data.scaleRoundingDecimals);
  const scaleAutoRead = data.scaleAutoRead !== false;
  const cashierRegisterRequired = businessStructureMode === 'monocaja'
    ? true
    : data.cashierRegisterRequired !== false;
  const exclusiveCashierPerRegister = businessStructureMode === 'monocaja'
    ? true
    : data.exclusiveCashierPerRegister !== false;
  if (!LANGUAGE_OPTIONS.some((item) => item.value === language)) {
    return res.status(400).json({ error: 'El idioma seleccionado no es válido.' });
  }
  if (!['directa', 'separada'].includes(salesOperationMode)) {
    return res.status(400).json({ error: 'El modo de operación de ventas no es válido.' });
  }
  if (!businessStructureMode) {
    return res.status(400).json({ error: 'La estructura del negocio no es válida.' });
  }
  const requestedBusinessName = String(data.nombre || '').trim();
  const currentConfigNameRows = await query('SELECT business_name FROM config WHERE id = 1 LIMIT 1');
  const currentBusinessName = String(currentConfigNameRows[0]?.business_name || '').trim();
  if (requestedBusinessName && requestedBusinessName !== currentBusinessName) {
    try {
      await ensureFirebaseIdentityAvailability({
        businessName: requestedBusinessName,
      });
    } catch (error) {
      return res.status(Number(error.statusCode || 500)).json({ error: error.message || 'No se pudo validar el nombre comercial en Firebase.' });
    }
  }
  await ensureBusinessStructureModeCompatibility(businessStructureMode);
  await query(
    `UPDATE config
     SET business_name = ?, rnc = ?, address = ?, phone = ?, currency = ?, tax_rate = ?,
         tax_calculate_at_invoice_end = ?, tax_include_in_product_price = ?, tax_show_breakdown_on_receipts = ?, tax_separate_taxable_and_exempt = ?,
         invoice_prefix = ?, invoice_next_number = ?, e_invoice_enabled = ?, e_invoice_prefix = ?,
      e_invoice_next_number = ?, receipt_message = ?, receipt_print_mode = ?, receipt_printer_name = ?, receipt_paper_size = ?,
         cash_drawer_enabled = ?, cash_drawer_method = ?, cash_drawer_printer_name = ?, cash_drawer_pin = ?, cash_drawer_network_host = ?, cash_drawer_network_port = ?, cash_drawer_serial_port = ?,
         scale_type = ?, scale_serial_port = ?, scale_serial_baud_rate = ?, scale_default_unit = ?, scale_read_pattern = ?, scale_rounding_decimals = ?, scale_auto_read = ?,
         whatsapp_web_enabled = ?, whatsapp_paste_guide_enabled = ?, sales_split_view_enabled = ?, app_logo = ?, language = ?, sales_operation_mode = ?, business_structure_mode = ?, cashier_register_required = ?, exclusive_cashier_per_register = ?
     WHERE id = 1`,
    [
      data.nombre,
      data.rnc,
      data.direccion,
      data.telefono,
      data.moneda,
      data.itbis,
      data.taxCalculateAtInvoiceEnd !== false ? 1 : 0,
      data.taxIncludeInProductPrice ? 1 : 0,
      data.taxShowBreakdownOnReceipts !== false ? 1 : 0,
      data.taxSeparateTaxableAndExempt !== false ? 1 : 0,
      data.prefix,
      data.nextInvoice,
      data.eInvoiceEnabled ? 1 : 0,
      data.eInvoicePrefix,
      data.eInvoiceNextNumber,
      data.mensaje,
      data.receiptPrintMode || 'dialog',
      data.receiptPrinterName || null,
      data.receiptPaperSize || '80mm',
      data.cashDrawerEnabled ? 1 : 0,
      cashDrawerMethod,
      String(data.cashDrawerPrinterName || '').trim() || null,
      cashDrawerPin,
      String(data.cashDrawerNetworkHost || '').trim() || null,
      cashDrawerNetworkPort,
      cashDrawerSerialPort,
      scaleType,
      scaleType === 'serial' ? scaleSerialPort || null : null,
      scaleSerialBaudRate,
      scaleDefaultUnit,
      scaleReadPattern || null,
      scaleRoundingDecimals,
      scaleAutoRead ? 1 : 0,
      data.whatsappWebEnabled ? 1 : 0,
      data.whatsappPasteGuideEnabled !== false ? 1 : 0,
      data.salesSplitViewEnabled ? 1 : 0,
      data.logo || null,
      language,
      salesOperationMode,
      businessStructureMode,
      cashierRegisterRequired ? 1 : 0,
      exclusiveCashierPerRegister ? 1 : 0
    ]
  );
  // Sincronizar plan_code con el nuevo business_structure_mode
  await query(`
    UPDATE config
    SET plan_code = CASE ?
                     WHEN 'multisucursal' THEN 'plus'
                     WHEN 'multicaja'     THEN 'pro'
                     ELSE plan_code
                   END,
        plan_name = CASE ?
                     WHEN 'multisucursal' THEN 'Tecno Caja Plus'
                     WHEN 'multicaja'     THEN 'Tecno Caja Pro'
                     ELSE plan_name
                   END
    WHERE id = 1
  `, [businessStructureMode, businessStructureMode]).catch(() => {});
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Configuración',
    actionName: 'Configuración actualizada',
    detail: `Negocio: ${data.nombre}`
  });
  await trySyncAllPosAccountsToFirebase().catch((error) => {
    console.warn('No se pudo sincronizar la configuracion/licencia POS a Firebase:', error.message);
  });
  res.json(await getConfig());
});

app.post('/api/branches', plans.requirePlan('plus', query, () => secureLicenseService.resolveState({ allowRemote: true })), async (req, res) => {
  ensureNotCashier(req);
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!isGlobalAdministratorUser(actorUser)) {
    return res.status(403).json({ error: 'No tienes permiso para crear nuevas sucursales.' });
  }
  await ensureBusinessRulesExtensions();
  const structureMode = await getConfiguredBusinessStructureMode();
  if (!getBusinessStructureCapabilities(structureMode).allowsMultipleBranches) {
    return res.status(409).json({ error: 'El modo actual del sistema no permite crear varias sucursales. Cambia a Multisucursal para habilitarlas.' });
  }
  const nombre = String(req.body?.nombre || '').trim();
  const codigo = String(req.body?.codigo || '').trim();
  const direccion = String(req.body?.direccion || '').trim();
  const telefono = String(req.body?.telefono || '').trim();
  const encargado = String(req.body?.encargado || '').trim();
  const estado = String(req.body?.estado || 'Activa').trim() || 'Activa';
  const configRows = await query('SELECT business_id FROM config WHERE id = 1 LIMIT 1');
  const businessId = Number(configRows[0]?.business_id || 0) || null;
  if (!nombre) {
    return res.status(400).json({ error: 'El nombre de la sucursal es obligatorio.' });
  }
  const result = await query(
    `INSERT INTO branches (business_id, nombre, codigo, direccion, telefono, encargado, estado, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [businessId, nombre, codigo || null, direccion || null, telefono || null, encargado || null, estado]
  );
  await syncBranchInventoryCatalog();
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Configuración',
    actionName: 'Sucursal creada',
    detail: `${nombre}${codigo ? ` · ${codigo}` : ''}`
  });
  const newBranchRow = (await query('SELECT * FROM branches WHERE id = ? LIMIT 1', [result.insertId]))[0];
  invalidateReportSyncCaches();
  // ── Sync reporte-sistema-pos (sucursal creada) ──
  fireReportSync(async () => {
    const cfg = await getReportSyncConfig();
    await reportsSync.syncBranch(newBranchRow, { config: cfg });
  });
  res.status(201).json({
    sucursal: mapBranchRow(newBranchRow),
    sucursales: (await getBranchRows()).map(mapBranchRow)
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DEVOLUCIONES — Flujo completo: buscar factura → seleccionar items → devolver
// ═══════════════════════════════════════════════════════════════════════════

// ─── 1. Buscar factura por número o fragmento ──────────────────────────────
app.get('/api/sales/search-for-return', async (req, res) => {
  try {
    await ensureReturnTables();
    await ensureSalesExtensions();
    const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    const q = String(req.query?.q || '').trim();
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Ingresa al menos 2 caracteres para buscar.' });
    }
    const scopedBranchId = getUserScopeBranchId(actorUser);
    const like = `%${q}%`;
    const params = [like, like];
    let where = `WHERE (s.invoice_number LIKE ? OR COALESCE(c.nombre, s.client_name_snapshot, '') LIKE ?)`;
    if (scopedBranchId) { where += ` AND COALESCE(s.branch_id, s.billed_branch_id) = ?`; params.push(scopedBranchId); }
    where += ` AND s.sale_status NOT IN ('pendiente')`;
    const rows = await query(
      `SELECT s.id, s.invoice_number, s.total, s.payment_method, s.sale_status,
              s.fiscal_status, s.created_at, s.inventory_branch_id, s.branch_id,
              COALESCE(c.nombre, s.client_name_snapshot, 'Consumidor Final') AS client_name,
              COALESCE(u.nombre, u.usuario, 'Sistema') AS cashier_name
       FROM sales s
       LEFT JOIN clients c ON c.id = s.client_id
       LEFT JOIN users u ON u.id = COALESCE(s.billed_by_user_id, s.user_id)
       ${where}
       ORDER BY s.id DESC LIMIT 20`,
      params
    );
    res.json({ results: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 2. Obtener detalle completo de una venta (con items y devoluciones previas) ──
app.get('/api/sales/:invoiceNumber/return-detail', async (req, res) => {
  try {
    await ensureReturnTables();
    await ensureSalesExtensions();
    const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    const invoiceNumber = String(req.params.invoiceNumber || '').trim();
    if (!invoiceNumber) return res.status(400).json({ error: 'Número de factura requerido.' });

    const saleRows = await query(
      `SELECT s.*, COALESCE(c.nombre, s.client_name_snapshot, 'Consumidor Final') AS client_name,
              COALESCE(u.nombre, u.usuario, 'Sistema') AS cashier_name
       FROM sales s
       LEFT JOIN clients c ON c.id = s.client_id
       LEFT JOIN users u ON u.id = COALESCE(s.billed_by_user_id, s.user_id)
       WHERE s.invoice_number = ? LIMIT 1`,
      [invoiceNumber]
    );
    if (!saleRows.length) return res.status(404).json({ error: 'Factura no encontrada.' });
    const sale = saleRows[0];

    assertActorCanAccessBranch(actorUser, Number(sale.inventory_branch_id || sale.branch_id || 0), 'No puedes ver ventas de otra sucursal.');

    const items = await query(
      `SELECT si.id, si.product_id, si.qty, si.price, si.discount_rate, si.tax_rate,
              si.line_total, si.sale_mode,
              COALESCE(p.nombre, 'Producto eliminado') AS product_name,
              p.codigo AS product_code
       FROM sale_items si
       LEFT JOIN products p ON p.id = si.product_id
       WHERE si.sale_id = ?`,
      [sale.id]
    );

    // Obtener cantidades ya devueltas por item
    const prevReturns = await query(
      `SELECT sri.product_id, SUM(sri.qty_returned) AS total_devuelto
       FROM sale_return_items sri
       JOIN sale_returns sr ON sr.id = sri.return_id
       WHERE sr.original_sale_id = ?
       GROUP BY sri.product_id`,
      [sale.id]
    );
    const devueltoMap = {};
    prevReturns.forEach(r => { devueltoMap[r.product_id] = Number(r.total_devuelto || 0); });

    const returnHistory = await query(
      `SELECT sr.id, sr.returned_at, sr.return_type, sr.returned_amount,
              sr.return_reason, sr.returned_by_user_name
       FROM sale_returns sr
       WHERE sr.original_sale_id = ?
       ORDER BY sr.id DESC`,
      [sale.id]
    );

    res.json({
      sale: {
        id: sale.id,
        invoiceNumber: sale.invoice_number,
        clientName: sale.client_name,
        cashierName: sale.cashier_name,
        createdAt: sale.created_at,
        total: Number(sale.total || 0),
        paymentMethod: sale.payment_method,
        saleStatus: sale.sale_status,
        fiscalStatus: sale.fiscal_status,
        inventoryBranchId: Number(sale.inventory_branch_id || sale.branch_id || 0),
      },
      items: items.map(i => ({
        id: i.id,
        productId: i.product_id,
        productName: i.product_name,
        productCode: i.product_code || '',
        qty: Number(i.qty || 0),
        price: Number(i.price || 0),
        discountRate: Number(i.discount_rate || 0),
        lineTotal: Number(i.line_total || 0),
        saleMode: i.sale_mode || 'unidad',
        qtyDevuelta: devueltoMap[i.product_id] || 0,
        qtyDisponible: Math.max(0, Number(i.qty || 0) - (devueltoMap[i.product_id] || 0)),
      })),
      returnHistory,
    });
  } catch (err) {
    const code = err.statusCode || 500;
    res.status(code).json({ error: err.message });
  }
});

// ─── 3. Procesar devolución (parcial o total) ──────────────────────────────
app.post('/api/sales/return', async (req, res) => {
  try {
    await ensureReturnTables();
    await ensureSalesExtensions();
    await ensureCashMovementExtensions();
    const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    if (!userCanReturnSales(actorUser)) {
      return res.status(403).json({ error: 'No tienes permiso para procesar devoluciones.' });
    }
    const actor = getActor(req);
    const invoiceNumber = String(req.body?.invoiceNumber || '').trim();
    const itemsToReturn = Array.isArray(req.body?.items) ? req.body.items : [];
    const reason = String(req.body?.reason || '').trim() || 'Devolución de cliente';
    const refundCash = Boolean(req.body?.refundCash !== false);

    if (!invoiceNumber) return res.status(400).json({ error: 'Número de factura requerido.' });
    if (!itemsToReturn.length) return res.status(400).json({ error: 'Debes seleccionar al menos un producto a devolver.' });

    // Validar estructura de negocio
    let structure;
    try {
      structure = await resolveScopedBusinessStructureSelection(req, null, req.body?.branchId, req.body?.cashRegisterId);
    } catch (_e) {
      structure = { branchId: null, cashRegisterId: null, branch: { nombre: 'Principal' }, cashRegister: { nombre: 'Caja' } };
    }

    const result = await withTransaction(async (conn) => {
      // Cargar la venta original
      const saleRows = await conn.query(
        `SELECT s.*, COALESCE(c.nombre, s.client_name_snapshot, 'Consumidor Final') AS client_name
         FROM sales s LEFT JOIN clients c ON c.id = s.client_id
         WHERE s.invoice_number = ? LIMIT 1`,
        [invoiceNumber]
      );
      if (!saleRows.length) throw Object.assign(new Error('Factura no encontrada.'), { statusCode: 404 });
      const sale = saleRows[0];

      if (String(sale.fiscal_status || '').trim() === 'cancelada') {
        throw Object.assign(new Error('Esta venta ya fue cancelada. No se puede devolver.'), { statusCode: 409 });
      }

      const inventoryBranchId = Number(sale.inventory_branch_id || sale.branch_id || structure.branchId || 0);

      // Cargar items originales
      const originalItems = await conn.query(
        `SELECT si.*, COALESCE(p.nombre,'Producto') AS product_name
         FROM sale_items si LEFT JOIN products p ON p.id = si.product_id
         WHERE si.sale_id = ?`,
        [sale.id]
      );

      // Cargar cantidades ya devueltas
      const prevReturns = await conn.query(
        `SELECT sri.product_id, SUM(sri.qty_returned) AS total_devuelto
         FROM sale_return_items sri JOIN sale_returns sr ON sr.id = sri.return_id
         WHERE sr.original_sale_id = ? GROUP BY sri.product_id`,
        [sale.id]
      );
      const devueltoMap = {};
      prevReturns.forEach(r => { devueltoMap[r.product_id] = Number(r.total_devuelto || 0); });

      // Validar cantidades a devolver
      let returnedAmount = 0;
      const validatedItems = [];
      for (const item of itemsToReturn) {
        const pid = Number(item.productId || 0);
        const qtyReturn = Number(item.qty || 0);
        if (!pid || qtyReturn <= 0) continue;

        const original = originalItems.find(o => Number(o.product_id) === pid);
        if (!original) throw Object.assign(new Error(`Producto ID ${pid} no pertenece a esta factura.`), { statusCode: 400 });

        const qtyOriginal = Number(original.qty || 0);
        const qtyYaDevuelta = devueltoMap[pid] || 0;
        const qtyDisponible = qtyOriginal - qtyYaDevuelta;

        if (qtyReturn > qtyDisponible) {
          throw Object.assign(new Error(
            `${original.product_name}: solo puedes devolver ${qtyDisponible} unidad(es), ya se devolvieron ${qtyYaDevuelta}.`
          ), { statusCode: 400 });
        }

        const unitPrice = Number(original.price || 0);
        const discRate = Number(original.discount_rate || 0);
        const effectivePrice = unitPrice * (1 - discRate / 100);
        const lineTotal = effectivePrice * qtyReturn;
        returnedAmount += lineTotal;

        validatedItems.push({
          productId: pid,
          productName: original.product_name || '',
          qty: qtyReturn,
          price: effectivePrice,
          lineTotal,
        });
      }

      if (!validatedItems.length) throw Object.assign(new Error('No hay ítems válidos para devolver.'), { statusCode: 400 });

      returnedAmount = Number(returnedAmount.toFixed(2));

      // Insertar registro de devolución
      const returnInsert = await conn.query(
        `INSERT INTO sale_returns
         (original_sale_id, original_invoice_number, return_type, return_reason,
          returned_amount, returned_by_user_id, returned_by_user_name,
          branch_id, cash_register_id, returned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          sale.id, invoiceNumber,
          validatedItems.length === originalItems.length ? 'total' : 'parcial',
          reason, returnedAmount,
          actor.userId || null, actor.userName || 'Sistema',
          structure.branchId || null, structure.cashRegisterId || null,
        ]
      );
      const returnId = returnInsert.insertId;

      // Insertar items devueltos y reintegrar al inventario
      for (const item of validatedItems) {
        await conn.query(
          `INSERT INTO sale_return_items (return_id, product_id, product_name, qty_returned, price, line_total)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [returnId, item.productId, item.productName, item.qty, item.price, item.lineTotal]
        );
        // Reintegrar al inventario
        if (inventoryBranchId) {
          await changeBranchInventoryStock(conn, {
            productId: item.productId,
            branchId: inventoryBranchId,
            quantityDelta: +item.qty,
            preventNegative: false,
          });
          // Registrar movimiento de inventario
          await conn.query(
            `INSERT INTO inventory_movements (product_id, branch_id, movement_type, quantity, notes, user_id, user_name, happened_at)
             VALUES (?, ?, 'devolucion', ?, ?, ?, ?, datetime('now'))`,
            [item.productId, inventoryBranchId, item.qty,
             `Devolución factura ${invoiceNumber} — ${reason}`,
             actor.userId || null, actor.userName || 'Sistema']
          ).catch(() => {}); // no crítico si falla el log
        }
      }

      // Registrar egreso de caja si aplica
      let cashMovementId = null;
      if (refundCash && structure.cashRegisterId) {
        const cashInsert = await conn.query(
          `INSERT INTO cash_movements
           (session_id, movement_type, amount, notes, created_by_user_id, created_by_user_name, happened_at, branch_id, cash_register_id)
           VALUES (NULL, 'Devolución', ?, ?, ?, ?, datetime('now'), ?, ?)`,
          [-returnedAmount, `Devolución ${invoiceNumber} — ${reason}`,
           actor.userId || null, actor.userName || 'Sistema',
           structure.branchId || null, structure.cashRegisterId]
        );
        cashMovementId = cashInsert.insertId;
        await conn.query(
          `UPDATE sale_returns SET cash_movement_id = ? WHERE id = ?`,
          [cashMovementId, returnId]
        );
        // Actualizar saldo de la sesión activa
        const openSessions = await conn.query(
          'SELECT id FROM cash_sessions WHERE status = "open" AND cash_register_id = ? ORDER BY id DESC LIMIT 1',
          [structure.cashRegisterId]
        );
        if (openSessions.length) {
          await conn.query(
            'UPDATE cash_sessions SET current_amount = current_amount - ? WHERE id = ?',
            [returnedAmount, openSessions[0].id]
          );
        }
        // Actualizar también el campo legacy config.cash_amount
        await conn.query('UPDATE config SET cash_amount = cash_amount - ? WHERE id = 1', [returnedAmount]);
      }

      // Si todos los items fueron devueltos, marcar venta como devuelta
      const totalItemsQty = originalItems.reduce((s, i) => s + Number(i.qty || 0), 0);
      const totalDevueltaQty = validatedItems.reduce((s, i) => s + i.qty, 0) +
        Object.values(devueltoMap).reduce((s, v) => s + v, 0);
      if (totalDevueltaQty >= totalItemsQty) {
        await conn.query(
          `UPDATE sales SET sale_status = 'devuelta', fiscal_status = 'cancelada',
                            canceled_at = datetime('now'), canceled_by_user_id = ?, canceled_by_user_name = ?,
                            cancel_reason = ?
           WHERE id = ?`,
          [actor.userId || null, actor.userName || 'Sistema',
           `Devolución total — ${reason}`, sale.id]
        );
      }

      return { returnId, returnedAmount, itemsCount: validatedItems.length, cashMovementId };
    });

    await writeAuditLog({
      ...actor,
      moduleName: 'Ventas',
      actionName: 'Devolución procesada',
      detail: `Factura ${invoiceNumber} — ${result.itemsCount} producto(s) — RD$ ${result.returnedAmount.toFixed(2)} — ${reason}`
    });

    res.status(201).json({
      ok: true,
      returnId: result.returnId,
      returnedAmount: result.returnedAmount,
      itemsCount: result.itemsCount,
      message: `Devolución procesada: RD$ ${result.returnedAmount.toFixed(2)} por ${result.itemsCount} producto(s).`,
    });
  } catch (err) {
    const code = err.statusCode || 500;
    console.error('[return] Error:', err.message);
    res.status(code).json({ error: err.message });
  }
});

// ─── 4. Historial de devoluciones de una sucursal ─────────────────────────
app.get('/api/sales/returns-history', async (req, res) => {
  try {
    await ensureReturnTables();
    const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    const scopedBranchId = getUserScopeBranchId(actorUser);
    const desde = String(req.query?.desde || '').trim() || new Date().toISOString().split('T')[0];
    const hasta = String(req.query?.hasta || '').trim() || desde;

    let where = `WHERE sr.returned_at BETWEEN ? AND ?`;
    const params = [`${desde} 00:00:00`, `${hasta} 23:59:59`];
    if (scopedBranchId) { where += ` AND sr.branch_id = ?`; params.push(scopedBranchId); }

    const rows = await query(
      `SELECT sr.id, sr.original_invoice_number, sr.returned_at, sr.return_type,
              sr.returned_amount, sr.return_reason, sr.returned_by_user_name,
              GROUP_CONCAT(sri.product_name ORDER BY sri.id SEPARATOR ', ') AS productos
       FROM sale_returns sr
       LEFT JOIN sale_return_items sri ON sri.return_id = sr.id
       ${where}
       GROUP BY sr.id
       ORDER BY sr.id DESC LIMIT 200`,
      params
    );
    res.json({ returns: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cash-registers', plans.requirePlan('pro', query, () => secureLicenseService.resolveState({ allowRemote: true })), async (req, res) => {
  ensureNotCashier(req);
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!userCanManageCashRegisters(actorUser)) {
    return res.status(403).json({ error: 'No tienes permiso para gestionar cajas.' });
  }
  await ensureBusinessStructureExtensions();
  const structureMode = await getConfiguredBusinessStructureMode();
  if (!getBusinessStructureCapabilities(structureMode).allowsMultipleRegisters) {
    return res.status(409).json({ error: 'El modo actual del sistema no permite crear varias cajas. Cambia a Multicaja o Multisucursal para habilitarlas.' });
  }
  const branchId = Number(req.body?.branchId || 0);
  const nombre = String(req.body?.nombre || '').trim();
  const codigo = String(req.body?.codigo || '').trim();
  if (!branchId || !nombre) {
    return res.status(400).json({ error: 'Sucursal y nombre de caja son obligatorios.' });
  }
  assertActorCanAccessBranch(actorUser, branchId, 'No puedes crear cajas en otra sucursal.');
  const branchRows = await query('SELECT * FROM branches WHERE id = ? LIMIT 1', [branchId]);
  if (!branchRows[0]) {
    return res.status(404).json({ error: 'La sucursal indicada no existe.' });
  }
  const result = await query(
    `INSERT INTO cash_registers (branch_id, nombre, codigo, estado, created_at)
     VALUES (?, ?, ?, 'Activa', datetime('now'))`,
    [branchId, nombre, codigo || null]
  );
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Configuración',
    actionName: 'Caja creada',
    detail: `${nombre} · sucursal ${branchRows[0].nombre}`
  });
  const newCashRegisterRow = (await query('SELECT * FROM cash_registers WHERE id = ? LIMIT 1', [result.insertId]))[0];
  // ── Sync reporte-sistema-pos (caja creada) ──
  fireReportSync(async () => {
    const cfg = await getReportSyncConfig();
    const branches = await getReportSyncBranchesMap();
    await reportsSync.syncCashRegister(newCashRegisterRow, {
      config: cfg,
      branches,
      sessionStatus: 'closed',
    });
  });
  res.status(201).json({
    caja: mapCashRegisterRow(newCashRegisterRow),
    cajasSucursal: (await getCashRegisterRows()).map(mapCashRegisterRow)
  });
});

// GET todas las cajas (con filtro opcional por sucursal)
app.get('/api/cash-registers', async (req, res) => {
  await ensureCashRegistersTable();
  await ensureCashRegisterTypeExtension();
  const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
  const scopedBranchId = getUserScopeBranchId(actorUser);
  const requestedBranchId = Number(req.query?.branchId || 0) || null;
  const branchId = scopedBranchId || requestedBranchId;
  const rows = branchId
    ? await query(
        `SELECT cr.*, b.nombre AS branch_nombre FROM cash_registers cr
         LEFT JOIN branches b ON b.id = cr.branch_id
         WHERE cr.branch_id = ? ORDER BY cr.nombre`,
        [branchId]
      )
    : await query(
        `SELECT cr.*, b.nombre AS branch_nombre FROM cash_registers cr
         LEFT JOIN branches b ON b.id = cr.branch_id ORDER BY b.nombre, cr.nombre`
      );
  res.json(rows.map((r) => ({ ...mapCashRegisterRow(r), sucursalNombre: r.branch_nombre || '' })));
});

// PUT actualizar configuración de una caja
app.put('/api/cash-registers/:id', async (req, res) => {
  await ensureCashRegistersTable();
  await ensureCashRegisterTypeExtension();
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!userCanManageCashRegisters(actorUser)) {
    return res.status(403).json({ error: 'Sin permisos para modificar cajas.' });
  }
  const cajaId = Number(req.params.id);
  const cajaRows = await query('SELECT * FROM cash_registers WHERE id = ? LIMIT 1', [cajaId]);
  if (!cajaRows[0]) return res.status(404).json({ error: 'Caja no encontrada.' });
  assertActorCanAccessBranch(actorUser, Number(cajaRows[0].branch_id), 'No puedes modificar cajas de otra sucursal.');

  const nombre = String(req.body?.nombre || cajaRows[0].nombre).trim();
  const tipoCaja = ['mixta', 'facturacion', 'cobro', 'centralizadora'].includes(req.body?.tipoCaja)
    ? req.body.tipoCaja
    : (cajaRows[0].tipo_caja || 'mixta');
  const puedeCobrar = req.body?.puedeCobrarOtrasCajas !== undefined
    ? (Number(req.body.puedeCobrarOtrasCajas) ? 1 : 0)
    : Number(cajaRows[0].puede_cobrar_otras_cajas || 0);
  const descripcion = req.body?.descripcion !== undefined
    ? String(req.body.descripcion || '').slice(0, 200)
    : (cajaRows[0].descripcion || '');
  const estado = ['Activa', 'Inactiva'].includes(req.body?.estado) ? req.body.estado : cajaRows[0].estado;

  await query(
    `UPDATE cash_registers SET nombre = ?, tipo_caja = ?, puede_cobrar_otras_cajas = ?, descripcion = ?, estado = ? WHERE id = ?`,
    [nombre, tipoCaja, puedeCobrar, descripcion, estado, cajaId]
  );
  const actor = getActor(req);
  await writeAuditLog({ ...actor, moduleName: 'Cajas', actionName: 'Caja actualizada', detail: `${nombre} · tipo: ${tipoCaja}` });
  const updated = await query('SELECT * FROM cash_registers WHERE id = ? LIMIT 1', [cajaId]);
  // ── Sync reporte-sistema-pos (caja actualizada) ──
  fireReportSync(async () => {
    const cfg = await getReportSyncConfig();
    const branches = await getReportSyncBranchesMap();
    if (updated[0]) await reportsSync.syncCashRegister(updated[0], { config: cfg, branches });
  });
  res.json({ caja: mapCashRegisterRow(updated[0]) });
});

app.delete('/api/branches/:id', async (req, res) => {
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!isGlobalAdministratorUser(actorUser)) {
    return res.status(403).json({ error: 'Solo el administrador general puede eliminar sucursales.' });
  }
  const id = Number(req.params.id);
  const branchRows = await query('SELECT * FROM branches WHERE id = ? LIMIT 1', [id]);
  const branch = branchRows[0];
  if (!branch) return res.status(404).json({ error: 'Sucursal no encontrada.' });

  const activeBranches = await query('SELECT COUNT(*) AS cnt FROM branches WHERE estado <> "Eliminada"');
  if (Number(activeBranches[0]?.cnt || 0) <= 1) {
    return res.status(409).json({ error: 'No puedes eliminar la única sucursal activa del sistema.' });
  }

  const configRow = await query('SELECT active_branch_id FROM config WHERE id = 1 LIMIT 1');
  if (Number(configRow[0]?.active_branch_id) === id) {
    return res.status(409).json({ error: 'Esta sucursal está en uso como sucursal activa. Cambia la sucursal activa antes de eliminarla.' });
  }

  // Cerrar sesiones huérfanas de todas las cajas de esta sucursal
  await query(
    `UPDATE cash_sessions cs
     JOIN cash_registers cr ON cr.id = cs.cash_register_id
     SET cs.status = 'closed', cs.closed_amount = cs.current_amount
     WHERE cr.branch_id = ? AND cs.status = 'open'`,
    [id]
  );

  await query('UPDATE branches SET estado = "Eliminada" WHERE id = ?', [id]);
  await query('UPDATE cash_registers SET estado = "Eliminada" WHERE branch_id = ?', [id]);
  const actor = getActor(req);
  await writeAuditLog({ ...actor, moduleName: 'Configuración', actionName: 'Sucursal eliminada', detail: `${branch.nombre} (ID ${id})` });
  invalidateReportSyncCaches();
  // ── Sync reporte-sistema-pos (sucursal marcada inactiva) ──
  fireReportSync(async () => {
    const cfg = await getReportSyncConfig();
    await reportsSync.syncBranch({ ...branch, estado: 'Eliminada' }, { config: cfg });
  });
  res.json({ ok: true, sucursales: (await getBranchRows()).map(mapBranchRow), cajasSucursal: (await getCashRegisterRows()).map(mapCashRegisterRow) });
});

app.delete('/api/cash-registers/:id', async (req, res) => {
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!isGlobalAdministratorUser(actorUser)) {
    return res.status(403).json({ error: 'Solo el administrador general puede eliminar cajas.' });
  }
  const id = Number(req.params.id);
  const cajaRows = await query(
    'SELECT cr.*, b.nombre AS branch_nombre FROM cash_registers cr LEFT JOIN branches b ON b.id = cr.branch_id WHERE cr.id = ? LIMIT 1',
    [id]
  );
  const caja = cajaRows[0];
  if (!caja) return res.status(404).json({ error: 'Caja no encontrada.' });

  const configRow = await query('SELECT active_cash_register_id FROM config WHERE id = 1 LIMIT 1');
  if (Number(configRow[0]?.active_cash_register_id) === id) {
    return res.status(409).json({ error: 'Esta caja está en uso como caja activa. Cambia la caja activa antes de eliminarla.' });
  }

  // Cerrar sesiones huérfanas (stale) automáticamente al eliminar
  await query(
    `UPDATE cash_sessions SET status = 'closed', closed_amount = current_amount WHERE cash_register_id = ? AND status = 'open'`,
    [id]
  );

  const activeCajas = await query('SELECT COUNT(*) AS cnt FROM cash_registers WHERE branch_id = ? AND estado <> "Eliminada"', [caja.branch_id]);
  if (Number(activeCajas[0]?.cnt || 0) <= 1) {
    return res.status(409).json({ error: 'No puedes eliminar la única caja activa de esta sucursal.' });
  }

  await query('UPDATE cash_registers SET estado = "Eliminada" WHERE id = ?', [id]);
  const actor = getActor(req);
  await writeAuditLog({ ...actor, moduleName: 'Configuración', actionName: 'Caja eliminada', detail: `${caja.nombre} · sucursal ${caja.branch_nombre} (ID ${id})` });
  res.json({ ok: true, cajasSucursal: (await getCashRegisterRows()).map(mapCashRegisterRow) });
});

app.put('/api/business-structure/active', async (req, res) => {
  ensureNotCashier(req);
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!isGlobalAdministratorUser(actorUser)) {
    return res.status(403).json({ error: 'Solo el administrador general puede cambiar la sucursal y caja activas del sistema.' });
  }
  await ensureBusinessStructureExtensions();
  const selection = await resolveBusinessStructureSelection(null, req.body?.branchId, req.body?.cashRegisterId);
  await query(
    'UPDATE config SET active_branch_id = ?, active_cash_register_id = ? WHERE id = 1',
    [selection.branchId, selection.cashRegisterId]
  );
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Configuración',
    actionName: 'Sucursal y caja activas actualizadas',
    detail: `${selection.branch.nombre} · ${selection.cashRegister.nombre}`
  });
  res.json({
    config: await getConfig(),
    sucursales: (await getBranchRows()).map(mapBranchRow),
    cajasSucursal: (await getCashRegisterRows()).map(mapCashRegisterRow)
  });
});

// ─── Báscula TCP — configuración y control ────────────────────────────────────

app.get('/api/config/bascula', async (req, res) => {
  try {
    await query(`CREATE TABLE IF NOT EXISTS installation_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_key VARCHAR(100) NOT NULL UNIQUE,
      config_value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    const rows = await query(
      `SELECT config_value FROM installation_config WHERE config_key = 'bascula_config' LIMIT 1`
    );
    const saved = rows.length ? JSON.parse(rows[0].config_value || '{}') : {};
    res.json({ ...bascula.getStatus(), saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/config/bascula', async (req, res) => {
  const { ip, port, autoconnect = true } = req.body || {};
  if (!ip || !port) return res.status(400).json({ error: 'Se requieren ip y port.' });
  if (Number(port) < 1 || Number(port) > 65535) return res.status(400).json({ error: 'Puerto inválido.' });
  // Validar IP básica
  if (!/^[\d.]+$/.test(ip)) return res.status(400).json({ error: 'IP inválida.' });
  try {
    await query(`CREATE TABLE IF NOT EXISTS installation_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_key VARCHAR(100) NOT NULL UNIQUE,
      config_value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    const cfg = JSON.stringify({ ip, port: Number(port), autoconnect });
    await query(
      `INSERT INTO installation_config (config_key, config_value) VALUES ('bascula_config', ?)
       ON DUPLICATE KEY UPDATE config_value = ?, updated_at = NOW()`,
      [cfg, cfg]
    );
    bascula.connect(ip, Number(port));
    res.json({ ok: true, status: bascula.getStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/config/bascula', async (req, res) => {
  try {
    bascula.disconnect();
    await query(
      `DELETE FROM installation_config WHERE config_key = 'bascula_config'`
    ).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Báscula TCP — probar conexión sin guardar ─────────────────────────────────
app.post('/api/config/bascula/test', async (req, res) => {
  const { ip, port } = req.body || {};
  if (!ip || !port) return res.status(400).json({ error: 'Se requieren ip y port.' });
  const reachable = await testTcpReachability(ip, Number(port), 3000);
  res.json({ reachable, ip, port: Number(port) });
});

app.put('/api/config/whatsapp-guide', async (req, res) => {
  ensureNotCashier(req);
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!userCanManageGlobalConfig(actorUser)) {
    return res.status(403).json({ error: 'Solo el administrador general puede cambiar esta configuración.' });
  }
  await ensureConfigExtensions();
  const enabled = req.body?.enabled !== false;
  await query(
    'UPDATE config SET whatsapp_paste_guide_enabled = ? WHERE id = 1',
    [enabled ? 1 : 0]
  );
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Configuración',
    actionName: enabled ? 'Guía de WhatsApp activada' : 'Guía de WhatsApp desactivada',
    detail: enabled ? 'La ayuda visual para enviar facturas fue activada.' : 'La ayuda visual para enviar facturas fue desactivada por ahora.'
  });
  res.json({ ok: true, enabled });
});

/**
 * Devuelve la sesión activa (status='open') para una caja dada.
 * Incluye operative_date, opened_by_user_name y horas abiertas.
 * Retorna null si no hay sesión abierta.
 */
async function getActiveSessionForRegister(cashRegisterId) {
  if (!cashRegisterId) return null;
  const rows = await query(
    `SELECT id, branch_id, cash_register_id, opened_by_user_id, opened_by_user_name,
            opened_amount, current_amount, expected_amount,
            opened_at, operative_date, status
     FROM cash_sessions
     WHERE status = 'open' AND cash_register_id = ?
     ORDER BY id DESC LIMIT 1`,
    [cashRegisterId]
  );
  const session = rows[0] || null;
  if (!session) return null;

  const openedAt = session.opened_at ? new Date(session.opened_at) : null;
  const hoursOpen = openedAt
    ? Math.round((Date.now() - openedAt.getTime()) / 36000) / 100  // 2 decimales
    : 0;
  const STALE_HOURS = 20; // advertir si lleva más de 20h abierta

  return {
    id: Number(session.id),
    branchId: session.branch_id ? Number(session.branch_id) : null,
    cashRegisterId: session.cash_register_id ? Number(session.cash_register_id) : null,
    openedByUserId: session.opened_by_user_id ? Number(session.opened_by_user_id) : null,
    openedByUserName: session.opened_by_user_name || 'Sistema',
    openedAmount: Number(session.opened_amount || 0),
    currentAmount: Number(session.current_amount || 0),
    openedAt: session.opened_at,
    operativeDate: session.operative_date
      ? toLocalDateKeyRD(session.operative_date)
      : toLocalDateKeyRD(openedAt || new Date()),
    hoursOpen,
    staleWarning: hoursOpen > STALE_HOURS,
  };
}

app.post('/api/cash/open', async (req, res) => {
  await ensureBusinessRulesExtensions();
  await ensureCashMovementExtensions();
  await ensureOperativeDateExtensions();
  const amount = Number(req.body?.monto || 0);
  const notes = req.body?.obs || 'Apertura de caja';
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!userCanOpenCash(actorUser)) {
    return res.status(403).json({ error: 'No tienes permiso para abrir caja.' });
  }
  const actor = getActor(req);

  let structure;
  try {
    structure = await resolveScopedBusinessStructureSelection(req, null, req.body?.branchId, req.body?.cashRegisterId);
  } catch (err) {
    if (req.authUser?.offlineSession) {
      structure = await resolveOfflineBusinessStructureSelection(req);
    } else {
      throw err;
    }
  }

  try {
    const result = await withTransaction(async (conn) => {
      const existingSessions = await conn.query(
        'SELECT * FROM cash_sessions WHERE status = "open" AND cash_register_id = ? ORDER BY id DESC LIMIT 1',
        [structure.cashRegisterId]
      );
      if (existingSessions[0]) {
        const existingSession = existingSessions[0];
        // Ya había una caja abierta. No crear otra, simplemente restablecer el estado.
        await conn.query(
          'UPDATE config SET cash_open = 1, cash_amount = ?, active_branch_id = ?, active_cash_register_id = ? WHERE id = 1',
          [Number(existingSession.current_amount || 0), structure.branchId, structure.cashRegisterId]
        );
        return Number(existingSession.id);
      }
      // operative_date = fecha del día en que se abre el turno.
      // Se mantiene fija aunque el turno cruce medianoche.
      const openedAtStr = nowRDString();
      const operativeDateStr = toLocalDateKeyRD(openedAtStr); // 'YYYY-MM-DD'
      const sessionResult = await conn.query(
        `INSERT INTO cash_sessions (opened_amount, current_amount, status, opened_at, operative_date, branch_id, cash_register_id, opened_by_user_id, opened_by_user_name)
         VALUES (?, ?, "open", ?, ?, ?, ?, ?, ?)`,
        [amount, amount, openedAtStr, operativeDateStr, structure.branchId, structure.cashRegisterId, actor.userId || null, actor.userName || 'Sistema']
      );
      await conn.query(
        `INSERT INTO cash_movements (session_id, movement_type, amount, notes, created_by_user_id, created_by_user_name, happened_at, branch_id, cash_register_id) VALUES (?, "Apertura", ?, ?, ?, ?, ?, ?, ?)`,
        [sessionResult.insertId, amount, notes, actor.userId || null, actor.userName || 'Sistema', openedAtStr, structure.branchId, structure.cashRegisterId]
      );
      await conn.query(
        `INSERT INTO cash_openings (cash_session_id, branch_id, cash_register_id, opened_amount, notes, opened_by_user_id, opened_by_user_name, opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionResult.insertId, structure.branchId, structure.cashRegisterId, amount, notes, actor.userId || null, actor.userName || 'Sistema', openedAtStr]
      );
      await conn.query('UPDATE config SET cash_open = 1, cash_amount = ?, active_branch_id = ?, active_cash_register_id = ? WHERE id = 1', [amount, structure.branchId, structure.cashRegisterId]);
      return Number(sessionResult.insertId);
    });

    await writeAuditLog({
      ...actor,
      moduleName: 'Caja',
      actionName: 'Apertura de caja',
      detail: `${structure.branch.nombre} · ${structure.cashRegister.nombre} · ${notes} · monto ${amount.toFixed(2)}`
    });
    firebaseSync.syncEstadoCaja({
      cajaId: structure.cashRegisterId,
      cajaNombre: structure.cashRegister.nombre,
      sucursalId: structure.branchId,
      sucursalNombre: structure.branch.nombre,
      estado: 'abierta',
      cajeroNombre: actor.userName,
      montoActual: amount,
    }).catch(() => {});
    // ── Sync reporte-sistema-pos (apertura) ──
    fireReportSync(async () => {
      const cfg = await getReportSyncConfig();
      const branches = await getReportSyncBranchesMap();
      await reportsSync.syncCashOpening({
        cash_register_id: structure.cashRegisterId,
        branch_id: structure.branchId,
        opened_at: new Date(),
        opened_amount: amount,
        opened_by_user_name: actor.userName || 'Sistema',
      }, { config: cfg, branches });
    });
    const activeSession = await getActiveSessionForRegister(structure.cashRegisterId);
    return res.status(201).json({ sessionId: result, activeSession, config: await getConfig() });
  } catch (err) {
    if (req.authUser?.offlineSession) {
      await setOfflineCashState(true, amount, structure.branchId, structure.cashRegisterId);
      return res.status(201).json({ sessionId: 'offline', activeSession: null, config: await getOfflineCashConfig() });
    }
    throw err;
  }
});

async function getOfflineCashConfig() {
  const rows = await localQuery(
    `SELECT config_key, config_value FROM offline_cache_config
     WHERE config_key IN (
       'active_branch_id', 'active_cash_register_id', 'activeBranchName', 'activeCashRegisterName',
       'requireCashOpenBeforeUse', 'cajaAbierta', 'cajaMonto'
     )`
  );
  const raw = {};
  for (const row of (rows || [])) {
    raw[row.config_key] = row.config_value;
  }
  return {
    nombre: raw.business_name || raw.nombre || '',
    rnc: raw.rnc || '',
    moneda: raw.currency || raw.moneda || 'RD$',
    itbis: Number(raw.tax_rate || raw.itbis || 18),
    prefix: raw.invoice_prefix || raw.prefix || 'FAC-',
    mensaje: raw.receipt_message || raw.mensaje || '¡Gracias por su compra!',
    tipoNegocio: raw.business_type || raw.tipoNegocio || '',
    activeBranchId: Number(raw.active_branch_id || raw.activeBranchId || 0) || null,
    activeCashRegisterId: Number(raw.active_cash_register_id || raw.activeCashRegisterId || 0) || null,
    activeBranchName: raw.activeBranchName || '',
    activeCashRegisterName: raw.activeCashRegisterName || '',
    requireCashOpenBeforeUse: raw.requireCashOpenBeforeUse !== 'false',
    setupCompleted: true,
    cajaAbierta: String(raw.cajaAbierta || 'false') === 'true',
    cajaMonto: Number(raw.cajaMonto || 0)
  };
}

async function setOfflineCashConfig(key, value) {
  await localQuery(
    `INSERT INTO offline_cache_config (config_key, config_value, last_updated)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(config_key) DO UPDATE SET config_value=excluded.config_value, last_updated=excluded.last_updated`,
    [key, String(value)]
  );
}

async function setOfflineCashState(isOpen, amount, branchId, cashRegisterId) {
  await Promise.all([
    setOfflineCashConfig('cajaAbierta', isOpen ? 'true' : 'false'),
    setOfflineCashConfig('cajaMonto', String(isOpen ? amount : 0)),
    setOfflineCashConfig('active_branch_id', String(branchId || 0)),
    setOfflineCashConfig('active_cash_register_id', String(cashRegisterId || 0))
  ]);
}

async function resolveOfflineBusinessStructureSelection(req) {
  const payloadBranchId = Number(req.body?.branchId || 0) || null;
  const payloadCashRegisterId = Number(req.body?.cashRegisterId || 0) || null;
  const config = await getOfflineCashConfig();
  return {
    branchId: payloadBranchId || config.activeBranchId || null,
    cashRegisterId: payloadCashRegisterId || config.activeCashRegisterId || null,
    branch: { id: payloadBranchId || config.activeBranchId || null, nombre: config.activeBranchName || '' },
    cashRegister: { id: payloadCashRegisterId || config.activeCashRegisterId || null, nombre: config.activeCashRegisterName || '' }
  };
}

app.post('/api/cash/close', async (req, res) => {
  await ensureBusinessRulesExtensions();
  await ensureCashMovementExtensions();
  const amount = Number(req.body?.monto || 0);
  const amountWasCaptured = req.body?.montoCapturado === true;
  const notes = req.body?.obs || 'Cierre de caja';
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!userCanCloseCash(actorUser)) {
    return res.status(403).json({ error: 'No tienes permiso para cerrar caja.' });
  }
  const actor = getActor(req);

  let structure;
  let session = null;
  try {
    structure = await resolveScopedBusinessStructureSelection(req, null, req.body?.branchId, req.body?.cashRegisterId);
    const sessions = await query('SELECT * FROM cash_sessions WHERE status = "open" AND cash_register_id = ? ORDER BY id DESC LIMIT 1', [structure.cashRegisterId]);
    session = sessions[0];

    if (!session) {
      return res.status(400).json({ error: 'No hay una caja abierta.' });
    }

    const [saleCountRows, cashSaleMovementRows] = await Promise.all([
      query(
        `SELECT COUNT(*) AS total
         FROM sales
         WHERE cash_session_id = ? AND COALESCE(sale_status, 'pagada') = 'pagada'`,
        [session.id]
      ).catch(() => [{ total: 0 }]),
      query(
        `SELECT COUNT(*) AS total
         FROM cash_movements
         WHERE session_id = ? AND movement_type = 'Venta'`,
        [session.id]
      ).catch(() => [{ total: 0 }]),
    ]);
    const hasSalesInTurn = Number(saleCountRows[0]?.total || 0) > 0
      || Number(cashSaleMovementRows[0]?.total || 0) > 0;
    if (hasSalesInTurn && !amountWasCaptured) {
      return res.status(400).json({
        error: 'Para cerrar caja con ventas debes escribir manualmente el monto contado/vendido.'
      });
    }

    await withTransaction(async (conn) => {
      const expectedAmount = Number(session.current_amount || 0);
      const countedAmount = amount;
      const differenceAmount = Number((countedAmount - expectedAmount).toFixed(2));
      // Calcular duración del turno en horas
      const openedAtMs = session.opened_at ? new Date(session.opened_at).getTime() : Date.now();
      const durationHours = Number(((Date.now() - openedAtMs) / 3600000).toFixed(2));
      await conn.query(
        `UPDATE cash_sessions
         SET closed_amount = ?, current_amount = ?, expected_amount = ?, counted_amount = ?, difference_amount = ?,
             closed_at = datetime('now'), status = "closed",
             closed_by_user_id = ?, closed_by_user_name = ?, duration_hours = ?
         WHERE id = ?`,
        [countedAmount, expectedAmount, expectedAmount, countedAmount, differenceAmount,
         actor.userId || null, actor.userName || 'Sistema', durationHours, session.id]
      );
      await conn.query(
        `INSERT INTO cash_movements (session_id, movement_type, amount, notes, created_by_user_id, created_by_user_name, happened_at, branch_id, cash_register_id) VALUES (?, "Cierre", ?, ?, ?, ?, datetime('now'), ?, ?)`,
        [session.id, countedAmount, notes, actor.userId || null, actor.userName || 'Sistema', structure.branchId, structure.cashRegisterId]
      );
      await conn.query(
        `INSERT INTO cash_closings (cash_session_id, branch_id, cash_register_id, expected_amount, counted_amount, difference_amount, notes, closed_by_user_id, closed_by_user_name, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [session.id, structure.branchId, structure.cashRegisterId, expectedAmount, countedAmount, differenceAmount, notes, actor.userId || null, actor.userName || 'Sistema']
      );
      await conn.query('UPDATE config SET cash_open = 0, cash_amount = 0 WHERE id = 1');
    });
  } catch (err) {
    if (req.authUser?.offlineSession) {
      const offlineConfig = await getOfflineCashConfig();
      structure = await resolveOfflineBusinessStructureSelection(req);
      if (!offlineConfig.cajaAbierta) {
        return res.status(400).json({ error: 'No hay una caja abierta.' });
      }
      await setOfflineCashState(false, 0, structure.branchId, structure.cashRegisterId);
      return res.json({ config: await getOfflineCashConfig() });
    }
    throw err;
  }

  await writeAuditLog({
    ...actor,
    moduleName: 'Caja',
    actionName: 'Cierre de caja',
    detail: `${structure.branch.nombre} · ${structure.cashRegister.nombre} · ${notes} · monto ${amount.toFixed(2)}`
  });
  firebaseSync.syncEstadoCaja({
    cajaId: structure.cashRegisterId,
    cajaNombre: structure.cashRegister.nombre,
    sucursalId: structure.branchId,
    sucursalNombre: structure.branch.nombre,
    estado: 'cerrada',
    cajeroNombre: actor.userName,
    montoActual: amount,
  }).catch(() => {});
  // ── Sync reporte-sistema-pos (cierre) ──
  fireReportSync(async () => {
    const cfg = await getReportSyncConfig();
    const branches = await getReportSyncBranchesMap();
    const closingRow = await query(
      'SELECT * FROM cash_closings WHERE cash_session_id = ? ORDER BY id DESC LIMIT 1',
      [session.id]
    );
    const totals = await query(
      `SELECT
         SUM(CASE WHEN movement_type IN ('Venta','entrada','income') THEN amount ELSE 0 END) AS totalIncome,
         SUM(CASE WHEN movement_type IN ('Egreso','salida','gasto','expense') THEN amount ELSE 0 END) AS totalExpenses,
         SUM(CASE WHEN movement_type IN ('Retiro','retiro','withdrawal') THEN amount ELSE 0 END) AS totalWithdrawals,
         SUM(CASE WHEN movement_type = 'Venta' THEN amount ELSE 0 END) AS totalSales
       FROM cash_movements WHERE session_id = ?`,
      [session.id]
    );
    await reportsSync.syncCashClosing({
      id: closingRow[0]?.id,
      cash_register_id: structure.cashRegisterId,
      branch_id: structure.branchId,
      closed_at: new Date(),
      counted_amount: amount,
      expected_amount: Number(session.current_amount || 0),
      notes: notes || null,
    }, {
      config: cfg,
      branches,
      openedBy: session.opened_by_user_name || '',
      closedBy: actor.userName || '',
      openedAt: session.opened_at,
      openingAmount: Number(session.opened_amount || 0),
      totalSales: Number(totals[0]?.totalSales || 0),
      totalIncome: Number(totals[0]?.totalIncome || 0),
      totalExpenses: Number(totals[0]?.totalExpenses || 0),
      totalWithdrawals: Number(totals[0]?.totalWithdrawals || 0),
    });
  });
  res.json({ config: await getConfig() });
});

app.post('/api/cash/expense', async (req, res) => {
  await ensureBusinessStructureExtensions();
  await ensureCashMovementExtensions();
  await ensureSupplierInvoicesTable();
  const amount = Number(req.body?.monto || 0);
  const expenseType = String(req.body?.tipo || '').trim();
  const notes = String(req.body?.obs || '').trim() || 'Egreso de caja';
  await resolveRequestActorUser(req, { required: true });
  const actor = getActor(req);
  const supplierInvoiceId = Number(req.body?.supplierInvoiceId || 0);
  const structure = await resolveScopedBusinessStructureSelection(req, null, req.body?.branchId, req.body?.cashRegisterId);

  const allowedTypes = {
    gasto: 'Gasto',
    pago_suplidor: 'Pago suplidor',
    devolucion: 'Devolución',
    retiro_efectivo: 'Retiro de efectivo'
  };

  if (!allowedTypes[expenseType] || amount <= 0) {
    return res.status(400).json({ error: 'Tipo de egreso y monto válido son requeridos.' });
  }

  const result = await withTransaction(async (conn) => {
    const sessions = await conn.query('SELECT * FROM cash_sessions WHERE status = "open" AND cash_register_id = ? ORDER BY id DESC LIMIT 1', [structure.cashRegisterId]);
    const session = sessions[0];
    if (!session) {
      const error = new Error('No hay una caja abierta para registrar egresos.');
      error.statusCode = 400;
      throw error;
    }

    const cashAmount = Number(session.current_amount || 0);
    if (cashAmount < amount) {
      const error = new Error('El monto del egreso supera el efectivo disponible en caja.');
      error.statusCode = 409;
      throw error;
    }

    let supplierInvoice = null;
    if (expenseType === 'pago_suplidor') {
      if (!supplierInvoiceId) {
        const error = new Error('Debes seleccionar una factura de suplidor.');
        error.statusCode = 400;
        throw error;
      }
      const supplierRows = await conn.query(
        'SELECT si.*, s.nombre AS supplier_name FROM supplier_invoices si LEFT JOIN suppliers s ON s.id = si.supplier_id WHERE si.id = ? LIMIT 1',
        [supplierInvoiceId]
      );
      supplierInvoice = supplierRows[0];
      if (!supplierInvoice) {
        const error = new Error('Factura de suplidor no encontrada.');
        error.statusCode = 404;
        throw error;
      }
      if (Number(supplierInvoice.pending_amount || 0) <= 0) {
        const error = new Error('Esa factura ya está saldada.');
        error.statusCode = 409;
        throw error;
      }
      if (amount > Number(supplierInvoice.pending_amount || 0)) {
        const error = new Error('El monto supera el balance pendiente de la factura seleccionada.');
        error.statusCode = 409;
        throw error;
      }
      const appliedAmount = amount;
      const newPaid = Number(supplierInvoice.paid_amount || 0) + appliedAmount;
      const newPending = Math.max(0, Number(supplierInvoice.total_amount || 0) - newPaid);
      const status = resolveSupplierInvoiceStatus({
        pending_amount: newPending,
        due_at: supplierInvoice.due_at
      });
      await conn.query(
        'UPDATE supplier_invoices SET paid_amount = ?, pending_amount = ?, status = ? WHERE id = ?',
        [newPaid, newPending, status, supplierInvoiceId]
      );
      const updatedRows = await conn.query(
        'SELECT si.*, s.nombre AS supplier_name FROM supplier_invoices si LEFT JOIN suppliers s ON s.id = si.supplier_id WHERE si.id = ? LIMIT 1',
        [supplierInvoiceId]
      );
      supplierInvoice = updatedRows[0];
    }

    await conn.query(
      `INSERT INTO cash_movements (session_id, movement_type, amount, notes, created_by_user_id, created_by_user_name, happened_at, branch_id, cash_register_id) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)`,
      [session.id, allowedTypes[expenseType], -Math.abs(amount), notes, actor.userId || null, actor.userName || 'Sistema', structure.branchId, structure.cashRegisterId]
    );
    await conn.query('UPDATE cash_sessions SET current_amount = current_amount - ? WHERE id = ?', [amount, session.id]);
    await conn.query('UPDATE config SET cash_amount = cash_amount - ? WHERE id = 1', [amount]);

    return {
      sessionId: Number(session.id),
      movementType: allowedTypes[expenseType],
      supplierInvoice
    };
  });

  await writeAuditLog({
    ...actor,
    moduleName: 'Caja',
    actionName: `Egreso registrado: ${result.movementType}`,
    detail: `${structure.branch.nombre} · ${structure.cashRegister.nombre} · ${notes} · monto ${amount.toFixed(2)}`
  });

  // ── Sync reporte-sistema-pos (egreso/gasto) ──
  fireReportSync(async () => {
    const cfg = await getReportSyncConfig();
    const branches = await getReportSyncBranchesMap();
    await reportsSync.syncCashMovement({
      id: `exp-${result.sessionId}-${Date.now()}`,
      movement_type: expenseType === 'retiro_efectivo' ? 'retiro' : 'salida',
      amount,
      notes,
      branch_id: structure.branchId,
      cash_register_id: structure.cashRegisterId,
      created_by_user_name: actor.userName || 'Sistema',
      happened_at: new Date(),
    }, { config: cfg, branches });
  });

  res.status(201).json({
    config: await getConfig(),
    movement: {
      tipo: result.movementType,
      monto: -Math.abs(amount),
      hora: new Date().toISOString(),
      obs: notes,
      usuarioId: actor.userId || null,
      usuarioNombre: actor.userName || 'Sistema'
    },
    supplierInvoice: result.supplierInvoice ? mapSupplierInvoiceRow(result.supplierInvoice) : null
  });
});

app.post('/api/cash/income', async (req, res) => {
  await ensureBusinessStructureExtensions();
  await ensureCashMovementExtensions();
  const amount = Number(req.body?.monto || 0);
  const notes = String(req.body?.obs || '').trim() || 'Ingreso adicional de caja';
  await resolveRequestActorUser(req, { required: true });
  const actor = getActor(req);
  const structure = await resolveScopedBusinessStructureSelection(req, null, req.body?.branchId, req.body?.cashRegisterId);

  if (amount <= 0) {
    return res.status(400).json({ error: 'El monto del ingreso debe ser mayor que cero.' });
  }

  const result = await withTransaction(async (conn) => {
    const sessions = await conn.query('SELECT * FROM cash_sessions WHERE status = "open" AND cash_register_id = ? ORDER BY id DESC LIMIT 1', [structure.cashRegisterId]);
    const session = sessions[0];
    if (!session) {
      const error = new Error('No hay una caja abierta para registrar ingresos.');
      error.statusCode = 400;
      throw error;
    }

    await conn.query(
      `INSERT INTO cash_movements (session_id, movement_type, amount, notes, created_by_user_id, created_by_user_name, happened_at, branch_id, cash_register_id) VALUES (?, "Ingreso adicional", ?, ?, ?, ?, datetime('now'), ?, ?)`,
      [session.id, amount, notes, actor.userId || null, actor.userName || 'Sistema', structure.branchId, structure.cashRegisterId]
    );
    await conn.query('UPDATE cash_sessions SET current_amount = current_amount + ? WHERE id = ?', [amount, session.id]);
    await conn.query('UPDATE config SET cash_amount = cash_amount + ? WHERE id = 1', [amount]);

    return {
      sessionId: Number(session.id),
      movementType: 'Ingreso adicional'
    };
  });

  await writeAuditLog({
    ...actor,
    moduleName: 'Caja',
    actionName: 'Ingreso adicional registrado',
    detail: `${structure.branch.nombre} · ${structure.cashRegister.nombre} · ${notes} · monto ${amount.toFixed(2)}`
  });

  // ── Sync reporte-sistema-pos (ingreso adicional) ──
  fireReportSync(async () => {
    const cfg = await getReportSyncConfig();
    const branches = await getReportSyncBranchesMap();
    await reportsSync.syncCashMovement({
      id: `inc-${result.sessionId}-${Date.now()}`,
      movement_type: 'entrada',
      amount,
      notes,
      branch_id: structure.branchId,
      cash_register_id: structure.cashRegisterId,
      created_by_user_name: actor.userName || 'Sistema',
      happened_at: new Date(),
    }, { config: cfg, branches });
  });

  res.status(201).json({
    config: await getConfig(),
    movement: {
      tipo: result.movementType,
      monto: amount,
      hora: new Date().toISOString(),
      obs: notes,
      usuarioId: actor.userId || null,
      usuarioNombre: actor.userName || 'Sistema'
    }
  });
});

// ─── Apertura manual de gaveta (sin afectar balance, solo auditoría) ──────────
app.post('/api/cash/drawer-event', async (req, res) => {
  await ensureBusinessStructureExtensions();
  await ensureCashMovementExtensions();
  const reason = String(req.body?.motivo || 'Sin motivo').trim();
  const actorUserDrawer = await resolveRequestActorUser(req, { required: true });
  if (!userCanOpenDrawer(actorUserDrawer)) {
    return res.status(403).json({ error: 'No tienes permiso para abrir la gaveta.' });
  }
  const actor = getActor(req);
  const structure = await resolveScopedBusinessStructureSelection(req, null, req.body?.branchId, req.body?.cashRegisterId);

  const sessions = await query(
    'SELECT * FROM cash_sessions WHERE status = "open" AND cash_register_id = ? ORDER BY id DESC LIMIT 1',
    [structure.cashRegisterId]
  );
  const session = sessions[0];

  await query(
    `INSERT INTO cash_movements (session_id, movement_type, amount, notes, created_by_user_id, created_by_user_name, happened_at, branch_id, cash_register_id)
     VALUES (?, "Gaveta abierta", 0, ?, ?, ?, datetime('now'), ?, ?)`,
    [session?.id || null, `Apertura manual — Motivo: ${reason}`, actor.userId || null, actor.userName || 'Sistema', structure.branchId, structure.cashRegisterId]
  );

  await writeAuditLog({
    ...actor,
    moduleName: 'Caja',
    actionName: 'Gaveta abierta manualmente',
    detail: `Motivo: ${reason} · ${structure.branch.nombre} · ${structure.cashRegister.nombre}`
  });

  res.json({ ok: true });
});

// ─── Corte de caja (guarda el resumen en audit_logs) ──────────────────────────
app.post('/api/cash/corte', async (req, res) => {
  await ensureBusinessStructureExtensions();
  const actorUserCorte = await resolveRequestActorUser(req, { required: true });
  if (!userCanMakeCorte(actorUserCorte)) {
    return res.status(403).json({ error: 'No tienes permiso para hacer corte de caja.' });
  }
  const actor = getActor(req);
  const structure = await resolveScopedBusinessStructureSelection(req, null, req.body?.branchId, req.body?.cashRegisterId);

  const {
    cajero, horaApertura, horaCorte,
    ventas, efectivo, tarjeta, transferencia, credito,
    descuentos, devoluciones, entradas, salidas,
    totalEsperado, contadoFisico, diferencia, notas
  } = req.body;

  await writeAuditLog({
    ...actor,
    moduleName: 'Caja',
    actionName: 'Corte de caja',
    detail: JSON.stringify({
      cajero, horaApertura, horaCorte,
      ventas: Number(ventas || 0),
      efectivo: Number(efectivo || 0),
      tarjeta: Number(tarjeta || 0),
      transferencia: Number(transferencia || 0),
      credito: Number(credito || 0),
      descuentos: Number(descuentos || 0),
      devoluciones: Number(devoluciones || 0),
      entradas: Number(entradas || 0),
      salidas: Number(salidas || 0),
      totalEsperado: Number(totalEsperado || 0),
      contadoFisico: Number(contadoFisico || 0),
      diferencia: Number(diferencia || 0),
      notas: notas || '',
      sucursal: structure.branch.nombre,
      caja: structure.cashRegister.nombre
    })
  });

  res.json({ ok: true });
});

app.post('/api/sales', async (req, res) => {
  await ensureBusinessRulesExtensions();
  await ensureSalesExtensions();
  await ensureClientExtensions();
  await ensureInventoryMovementsTable();
  await ensureNcfExtensions();
  const actorUser = await resolveRequestActorUser(req, { required: true });
  const sale = req.body;
  const created = await withTransaction(async (conn) => {
    const configRows = await conn.query('SELECT * FROM config WHERE id = 1');
    const config = configRows[0];
    const businessId = Number(config?.business_id || 1) || 1;
    const structure = await resolveScopedBusinessStructureSelection(req, conn, sale.branchId, sale.cashRegisterId);
    const billingAccess = await resolveEffectiveBillingAccess(conn, actorUser, structure.cashRegisterId);

    if (!billingAccess.canCreateSales) {
      const error = new Error(`Tu usuario está configurado como ${billingAccess.userTypeLabel} y no puede emitir ventas nuevas desde una caja ${billingAccess.cashRegisterTypeLabel}.`);
      error.statusCode = 403;
      throw error;
    }

    // ── Validar sesión de caja activa (turno) ─────────────────────
    // Buscar el turno abierto para esta caja. Si require_cash_open_before_use=1
    // y no hay turno, bloquear la venta — el cajero debe abrir caja primero.
    const activeSessionRows = await conn.query(
      `SELECT id, operative_date, opened_by_user_id
       FROM cash_sessions
       WHERE status = 'open' AND cash_register_id = ?
       ORDER BY id DESC LIMIT 1`,
      [structure.cashRegisterId]
    );
    const activeSession = activeSessionRows[0] || null;
    const requireCashOpen = Number(config?.require_cash_open_before_use ?? 1) !== 0;

    if (!activeSession && requireCashOpen) {
      const noSessionError = new Error(
        'No hay una caja abierta en este momento. Abre la caja antes de registrar ventas.'
      );
      noSessionError.statusCode = 409;
      noSessionError.code = 'NO_ACTIVE_SESSION';
      throw noSessionError;
    }

    // Fecha operativa = la del turno activo (no la del reloj).
    // Si la venta cruza medianoche, sigue perteneciendo al turno abierto el día anterior.
    // Para e-CF/DGII se usa created_at (fecha real) — nunca operative_date.
    const saleSessionId = activeSession ? Number(activeSession.id) : null;
    const saleOperativeDate = activeSession
      ? (activeSession.operative_date || new Date().toISOString().slice(0, 10))
      : new Date().toISOString().slice(0, 10);

    // ── Determine document type and NCF ──────────────────────────
    const VALID_NCF_TYPES = ['B01','B02','B03','B04','B14','B15'];
    const requestedNcfType = VALID_NCF_TYPES.includes(String(sale.ncfType || '').toUpperCase())
      ? String(sale.ncfType).toUpperCase() : null;

    let documentType;
    if (requestedNcfType) {
      documentType = 'comprobante-fiscal';
    } else if (sale.tipoComprobante === 'factura-electronica') {
      documentType = 'factura-electronica';
    } else {
      documentType = 'ticket';
    }

    // Internal invoice number — incremento atómico para evitar duplicados en concurrencia
    const sequenceField = documentType === 'factura-electronica' ? 'e_invoice_next_number' : 'invoice_next_number';
    const prefixField   = documentType === 'factura-electronica' ? 'e_invoice_prefix'      : 'invoice_prefix';
    const prefix        = config[prefixField] || (documentType === 'factura-electronica' ? 'ECF-' : 'FAC-');
    await conn.query(`UPDATE config SET ${sequenceField} = ${sequenceField} + 1 WHERE id = 1`);
    const seqRows = await conn.query(`SELECT ${sequenceField} AS seq FROM config WHERE id = 1`);
    const nextNumber = Number(seqRows[0]?.seq || 1);
    const invoiceNumber = `${prefix}${String(nextNumber).padStart(8, '0')}`;

    let clientId = sale.clientId || null;
    let clientName = 'Consumidor Final';
    let clientPhone = String(sale.clienteTelefono || '').trim();
    let clientTaxId = '';
    let clientRnc = '';
    let razonSocialCliente = '';
    let deliveryAddress = String(sale.direccionDelivery || '').trim();
    let deliveryReference = String(sale.referenciaDelivery || '').trim();
    let deliveryLocationLink = String(sale.linkUbicacionDelivery || '').trim();
    let deliveryLatitude = null;
    let deliveryLongitude = null;

    if (clientId) {
      const clientRows = await conn.query('SELECT * FROM clients WHERE id = ? LIMIT 1', [clientId]);
      const client = clientRows[0];
      if (!client) {
        const error = new Error('El cliente seleccionado no existe.');
        error.statusCode = 404;
        throw error;
      }
      clientName = client.nombre;
      clientPhone = client.telefono || clientPhone || '';
      clientTaxId = client.cedula || '';
      clientRnc = client.rnc || '';
      razonSocialCliente = client.razon_social || '';
      deliveryAddress = deliveryAddress || client.direccion || '';
      deliveryReference = deliveryReference || client.reference_note || '';
      deliveryLocationLink = deliveryLocationLink || client.location_link || '';
      deliveryLatitude = normalizeNullableCoordinate(client.latitude);
      deliveryLongitude = normalizeNullableCoordinate(client.longitude);
    }

    if (deliveryLatitude === null || deliveryLongitude === null) {
      const coordsFromLink = extractCoordinatesFromLocationLink(deliveryLocationLink);
      deliveryLatitude = deliveryLatitude ?? coordsFromLink.latitud;
      deliveryLongitude = deliveryLongitude ?? coordsFromLink.longitud;
    }

    // Allow RNC/razon_social from payload (manual entry for B01 without saved client)
    if (!clientRnc && sale.rncCliente) clientRnc = String(sale.rncCliente).trim();
    if (!razonSocialCliente && sale.razonSocialCliente) razonSocialCliente = String(sale.razonSocialCliente).trim();

    const effectiveNcfType = requestedNcfType;
    const shouldUseEcfFlow = documentType === 'factura-electronica';

    let deliveryUserId = sale.repartidorId || null;
    let deliveryName = String(sale.repartidor || '').trim();
    let deliveryEmail = String(sale.repartidorCorreo || '').trim();
    let deliveryFirebaseUid = null;
    if (deliveryUserId) {
      const deliveryRows = await conn.query('SELECT * FROM users WHERE id = ? LIMIT 1', [deliveryUserId]);
      const deliveryUser = deliveryRows[0];
      if (deliveryUser) {
        deliveryName = deliveryUser.nombre;
        deliveryEmail = deliveryUser.email || '';
        deliveryFirebaseUid = deliveryUser.firebase_uid || null;
      }
    }

    const orderType = ['mostrador', 'delivery', 'recoger', 'mesa'].includes(String(sale.tipoPedido || '').trim())
      ? String(sale.tipoPedido).trim()
      : 'mostrador';
    const paymentMethod = ['efectivo', 'tarjeta', 'transferencia', 'mixto', 'credito', 'contra_entrega'].includes(String(sale.metodo || '').trim())
      ? String(sale.metodo).trim()
      : 'efectivo';
    const kitchenStatus = ['pendiente', 'en preparacion', 'en horno', 'lista', 'entregada'].includes(String(sale.estadoCocina || '').trim())
      ? String(sale.estadoCocina).trim()
      : 'pendiente';
    const configuredSaleMode = String(config.sales_operation_mode || 'directa').trim() || 'directa';
    const requestedSaleMode = String(sale.saleMode || sale.modoOperacion || configuredSaleMode).trim().toLowerCase();
    const saleMode = requestedSaleMode === 'separada' || requestedSaleMode === 'facturacion_separada'
      ? 'separada'
      : 'directa';
    const requestedPendienteCobro = Boolean(sale.pendienteCobro || billingAccess.forcePendingCharge);
    let saleStatus = saleMode === 'separada'
      ? 'pendiente'
      : (requestedPendienteCobro ? 'pendiente_cobro' : 'pagada');
    const shouldDiscountInventoryNow = saleStatus === 'pagada' || saleStatus === 'pendiente_cobro';
    const deliveryCashStatus = paymentMethod === 'contra_entrega' ? 'pendiente' : 'na';
    const saleTotal = Number(sale.total || 0);
    const receivedAmount = saleStatus === 'pagada'
      ? (paymentMethod === 'contra_entrega' ? 0 : (paymentMethod === 'credito' ? 0 : Number(sale.recibido || 0)))
      : 0;
    const changeAmount = saleStatus === 'pagada'
      ? (paymentMethod === 'contra_entrega' ? 0 : (paymentMethod === 'credito' ? 0 : Number(sale.cambio || 0)))
      : 0;
    const pendingCreditAmount = paymentMethod === 'credito'
      ? Math.max(0, saleTotal - receivedAmount)
      : 0;
    const nowSql = new Date().toISOString().slice(0, 19).replace('T', ' ');

    if (paymentMethod === 'contra_entrega' && orderType !== 'delivery') {
      const error = new Error('Pago contra entrega solo está disponible para pedidos delivery.');
      error.statusCode = 400;
      throw error;
    }
    if (orderType === 'delivery' && !deliveryUserId) {
      const error = new Error('Debes asignar un delivery al pedido.');
      error.statusCode = 400;
      throw error;
    }
    if (paymentMethod === 'credito' && !clientId) {
      const error = new Error('Debes seleccionar un cliente para registrar una factura a crédito.');
      error.statusCode = 400;
      throw error;
    }

    if (documentType === 'factura-electronica') {
      if (!config.e_invoice_enabled) {
        const error = new Error('La factura electrónica está deshabilitada en configuración.');
        error.statusCode = 409;
        throw error;
      }
    }

    // ── NCF validations ──────────────────────────────────────────
    let generatedNcf = null;
    let ncfReferenciaVal = null;
    let facturaReferenciaId = null;

    if (effectiveNcfType) {
      // B01: requires RNC
      if (effectiveNcfType === 'B01') {
        const rnc = clientRnc;
        if (!rnc) {
          const error = new Error('El comprobante B01 (Crédito Fiscal) requiere el RNC del cliente.');
          error.statusCode = 400; throw error;
        }
      }
      // B14/B15: require a client
      if (['B14','B15'].includes(effectiveNcfType) && !clientId) {
        const error = new Error(`El comprobante ${effectiveNcfType} requiere un cliente registrado.`);
        error.statusCode = 400; throw error;
      }
      // B03/B04: require reference to original invoice
      if (['B03','B04'].includes(effectiveNcfType)) {
        const refNcf = String(sale.ncfReferencia || '').trim();
        if (!refNcf) {
          const error = new Error(`El comprobante ${effectiveNcfType} requiere indicar la factura original.`);
          error.statusCode = 400; throw error;
        }
        // Validate the reference invoice exists and is emitida
        const refRows = await conn.query(
          `SELECT id, fiscal_status, ncf_type FROM sales WHERE ncf = ? AND fiscal_status = 'emitida' LIMIT 1`,
          [refNcf]
        );
        if (!refRows[0]) {
          const error = new Error(`No se encontró la factura original con NCF ${refNcf} o ya fue cancelada.`);
          error.statusCode = 400; throw error;
        }
        ncfReferenciaVal = refNcf;
        facturaReferenciaId = Number(refRows[0].id);
      }
      generatedNcf = await getNextNcfFromSequence(conn, effectiveNcfType, structure.branchId);
    }

    const fiscalTimestamp = new Date().toISOString();
    const fiscalSecurityCode = (documentType === 'factura-electronica' || effectiveNcfType)
      ? `NOVA${crypto.randomBytes(6).toString('hex').toUpperCase()}`
      : '';
    const fiscalPayload = JSON.stringify({
      numero: generatedNcf || invoiceNumber,
      tipo: effectiveNcfType ? `${effectiveNcfType} - ${NCF_LABELS[effectiveNcfType]}` : documentType,
      estado: shouldUseEcfFlow ? 'pendiente' : 'emitida',
      cliente: razonSocialCliente || clientName,
      clienteRncCedula: clientRnc || clientTaxId,
      total: Number(sale.total || 0),
      itbis: Number(sale.itbis || 0),
      fecha: fiscalTimestamp,
      codigoSeguridad: fiscalSecurityCode,
      ncfReferencia: ncfReferenciaVal || null,
      ecfEstado: shouldUseEcfFlow ? 'pendiente' : null
    });

    const result = await conn.query(
      `INSERT INTO sales
        (invoice_number, user_id, client_id, branch_id, cash_register_id,
         billed_branch_id, billed_cash_register_id, billed_by_user_id,
         charged_branch_id, charged_cash_register_id, charged_by_user_id, charged_at,
         inventory_branch_id, inventory_discounted_at,
         sale_status, sale_mode, document_type,
         client_name_snapshot, client_phone_snapshot, client_tax_id_snapshot,
         payment_method, subtotal, discount, tax, total, received_amount, change_amount,
         fiscal_status, fiscal_payload, created_at,
         order_type, kitchen_status,
         delivery_user_id, delivery_name_snapshot, delivery_email_snapshot, delivery_phone_snapshot,
         delivery_address_snapshot, delivery_reference_snapshot, delivery_location_link_snapshot,
         table_label, order_notes,
         ncf, ncf_type, ncf_referencia, factura_referencia_id, razon_social_cliente, es_electronica, fecha_emision_fiscal,
         cash_session_id, operative_date)
       VALUES (?, ?, ?, ?, ?,
               ?, ?, ?,
               ?, ?, ?, ?,
               ?, ?,
               ?, ?, ?,
               ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?,
               ?, ?, datetime('now'),
               ?, ?,
               ?, ?, ?, ?,
               ?, ?, ?,
               ?, ?,
               ?, ?, ?, ?, ?, ?, datetime('now'),
               ?, ?)`,
      [
        invoiceNumber,
        sale.userId,
        clientId,
        structure.branchId,
        structure.cashRegisterId,
        // billed
        structure.branchId,
        structure.cashRegisterId,
        sale.userId || null,
        // charged
        saleStatus === 'pagada' ? structure.branchId : null,
        saleStatus === 'pagada' ? structure.cashRegisterId : null,
        saleStatus === 'pagada' ? (sale.userId || null) : null,
        saleStatus === 'pagada' ? nowSql : null,
        // inventory
        structure.branchId,
        shouldDiscountInventoryNow ? nowSql : null,
        // sale data
        saleStatus,
        saleMode,
        effectiveNcfType ? 'comprobante-fiscal' : documentType,
        clientName,
        clientPhone || null,
        clientRnc || clientTaxId || null,
        paymentMethod,
        sale.subtotal,
        sale.descuento,
        sale.itbis,
        saleTotal,
        receivedAmount,
        changeAmount,
        'emitida',
        fiscalPayload,
        // order
        orderType,
        kitchenStatus,
        // delivery
        deliveryUserId,
        deliveryName || null,
        deliveryEmail || null,
        String(sale.telefonoDelivery || '').trim() || null,
        deliveryAddress || null,
        deliveryReference || null,
        deliveryLocationLink || null,
        String(sale.mesa || '').trim() || null,
        String(sale.notasPedido || '').trim() || null,
        // NCF
        generatedNcf || null,
        effectiveNcfType || null,
        ncfReferenciaVal || null,
        facturaReferenciaId || null,
        razonSocialCliente || null,
        shouldUseEcfFlow ? 1 : 0,
        // Turno — NUNCA usar para e-CF (usar created_at/fecha_emision_fiscal)
        saleSessionId,
        saleOperativeDate,
      ]
    );

    await conn.query('UPDATE sales SET delivery_cash_status = ? WHERE id = ?', [deliveryCashStatus, result.insertId]);

    // BUG 10 fix: validar items antes de procesarlos — previene cantidades negativas o NaN
    if (!Array.isArray(sale.items) || sale.items.length === 0) {
      const emptyError = new Error('La venta debe tener al menos un producto.');
      emptyError.statusCode = 400;
      throw emptyError;
    }
    for (const item of sale.items) {
      const itemQty = Number(item.qty);
      if (!Number.isFinite(itemQty) || itemQty <= 0) {
        const qtyError = new Error(`Cantidad inválida para el producto ID ${item.id}: "${item.qty}". Debe ser mayor que cero.`);
        qtyError.statusCode = 400;
        throw qtyError;
      }
      const itemPrice = Number(item.precio);
      if (!Number.isFinite(itemPrice) || itemPrice < 0) {
        const priceError = new Error(`Precio inválido para el producto ID ${item.id}: "${item.precio}".`);
        priceError.statusCode = 400;
        throw priceError;
      }
    }

    const affectedProductIds = new Set();
    for (const item of sale.items) {
      affectedProductIds.add(Number(item.id || 0) || 0);
      const productRows = await conn.query('SELECT id, codigo, nombre, precio_compra, tracks_stock FROM products WHERE id = ? LIMIT 1', [item.id]);
      const product = productRows[0];
      await conn.query(
        `INSERT INTO sale_items
          (sale_id, product_id, qty, price, discount_rate, tax_rate, sale_mode, unit_label, weight_unit, scale_weight, scale_measured_value, scale_measured_unit, scale_source, scale_raw_reading, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          result.insertId,
          item.id,
          item.qty,
          item.precio,
          item.descuento || 0,
          item.itbis || 0,
          normalizeProductSaleMode(item.saleMode),
          String(item.unitLabel || 'Unidad').trim() || 'Unidad',
          String(item.weightUnit || '').trim() || null,
          item.scaleWeight === null || item.scaleWeight === undefined ? null : Number(item.scaleWeight),
          item.scaleMeasuredValue === null || item.scaleMeasuredValue === undefined ? null : Number(item.scaleMeasuredValue),
          String(item.scaleMeasuredUnit || '').trim() || null,
          String(item.scaleSource || '').trim() || null,
          String(item.scaleRawReading || '').trim() || null,
          item.total
        ]
      );

      if (shouldDiscountInventoryNow && Number(product?.tracks_stock ?? 1) !== 0) {
        const stockChange = await changeBranchInventoryStock(conn, {
          productId: item.id,
          branchId: structure.branchId,
          quantityDelta: -Math.abs(Number(item.qty || 0)),
          preventNegative: true
        });
        await registerInventoryMovement(conn, {
          productId: item.id,
          branchId: structure.branchId,
          cashRegisterId: structure.cashRegisterId,
          saleId: Number(result.insertId),
          tipo: 'venta',
          cantidad: -Math.abs(Number(item.qty || 0)),
          stockAnterior: stockChange.previousStock,
          stockNuevo: stockChange.nextStock,
          costoUnitario: Number(product?.precio_compra || 0),
          referenciaTipo: 'venta',
          referenciaId: invoiceNumber,
          notas: `Salida por venta ${invoiceNumber}`,
          usuarioId: sale.userId || null,
          usuarioNombre: actorUser.nombre || actorUser.usuario || 'Sistema'
        });
      }
    }

    if (paymentMethod === 'credito' && clientId && pendingCreditAmount > 0) {
      await conn.query(
        'UPDATE clients SET balance = COALESCE(balance, 0) + ? WHERE id = ?',
        [pendingCreditAmount, clientId]
      );
    }

    const cashDelta = saleStatus !== 'pagada'
      ? 0
      : paymentMethod === 'contra_entrega'
        ? 0
        : (paymentMethod === 'credito' ? receivedAmount : saleTotal);

    if (saleStatus === 'pagada' && (cashDelta > 0 || paymentMethod === 'efectivo')) {
      const sessionRows = await conn.query(
        'SELECT * FROM cash_sessions WHERE status = "open" AND cash_register_id = ? ORDER BY id DESC LIMIT 1',
        [structure.cashRegisterId]
      );
      const activeSession = sessionRows[0];
      if (!activeSession) {
        const error = new Error('Debes abrir la caja activa antes de registrar ventas en esa sucursal.');
        error.statusCode = 409;
        throw error;
      }
      if (cashDelta > 0) {
        await conn.query('UPDATE cash_sessions SET current_amount = current_amount + ? WHERE id = ?', [cashDelta, activeSession.id]);
      }
    }

    await conn.query(
      `UPDATE config SET cash_amount = cash_amount + ? WHERE id = 1`,
      [cashDelta]
    );

    return {
      saleId: Number(result.insertId),
      updatedClientId: clientId ? Number(clientId) : null,
      branchName: structure.branch.nombre,
      cashRegisterName: structure.cashRegister.nombre,
      saleStatus,
      saleMode,
      branchId: structure.branchId,
      productIds: [...affectedProductIds].filter((value) => value > 0),
      deliveryFirebaseUid,
      deliveryLatitude,
      deliveryLongitude,
      shouldAttemptEcf: shouldUseEcfFlow,
    };
  });

  let ecfEmissionResult = null;
  if (created.shouldAttemptEcf) {
    try {
      ecfEmissionResult = await ecfModule.service.processSaleForElectronicInvoicing(created.saleId, {
        userId: actorUser.id || sale.userId || null,
        userName: actorUser.nombre || actorUser.usuario || null,
        userRole: actorUser.rol || actorUser.role_code || null,
        requestedType: String(sale.ecfType || '').trim().toUpperCase() || null,
        ipAddress: req.ip
      });
    } catch (error) {
      console.warn('[ecf] Falló la emisión electrónica automática de la venta %s: %s', created.saleId, error.message);
      await query(
        'UPDATE sales SET ecf_estado = COALESCE(ecf_estado, ?) WHERE id = ?',
        ['error_validacion', created.saleId]
      ).catch(() => {});
      ecfEmissionResult = { ok: false, error: error.message };
    }
  }

  const rows = await query(
    'SELECT s.*, u.nombre AS cashier_name, COALESCE(c.nombre, "Consumidor Final") AS client_name, COALESCE(c.telefono, "") AS client_phone FROM sales s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN clients c ON c.id = s.client_id WHERE s.id = ?',
    [created.saleId]
  );
  const items = await query(
    `SELECT si.*, p.nombre AS product_name, p.categoria, p.precio_compra
     FROM sale_items si
     LEFT JOIN products p ON p.id = si.product_id
     WHERE sale_id = ?`,
    [created.saleId]
  );
  const updatedClientRows = created.updatedClientId
    ? await getClientRowsWithComputedBalance(created.updatedClientId)
    : [];
  assertActorCanAccessBranch(actorUser, created.branchId, 'No puedes registrar ventas fuera de tu sucursal.');
  // Audit log fire-and-forget — no necesitamos bloquear la respuesta al cajero.
  writeAuditLog({
    userId: actorUser.id || sale.userId || null,
    userName: actorUser.nombre || actorUser.usuario || 'Sistema',
    userRole: actorUser.rol || 'Sistema',
    moduleName: 'Ventas',
    actionName: created.saleStatus === 'pendiente' ? 'Factura pendiente creada' : 'Venta registrada',
    detail: `${created.branchName || 'Sucursal'} · ${created.cashRegisterName || 'Caja'} · ${rows[0]?.invoice_number || 'Venta'} · ${created.saleMode || 'directa'} · ${created.saleStatus || 'pagada'} · RD$ ${Number(sale.total || 0).toFixed(2)}`
  }).catch((err) => console.warn('[audit] Falló al registrar venta:', err.message));
  if (created.saleStatus === 'pagada') {
    firebaseSync.syncVentaDia({
      total: sale.total,
      metodoPago: sale.paymentMethod,
      sucursalId: created.branchId,
      sucursalNombre: created.branchName,
    }).catch(() => {});
  }
  if (rows[0]?.order_type === 'delivery') {
    firebaseSync.syncDeliveryOrder(rows[0]).catch(() => {});
    if (created.deliveryFirebaseUid) {
      const productosDelivery = items.map((it) => ({
        nombre: it.product_name || '',
        cantidad: Number(it.qty || 1),
        precio: Number(it.price || 0),
      }));
      firebaseSync.syncPedidoDelivery({
        invoiceNumber: rows[0].invoice_number,
        repartidorId: created.deliveryFirebaseUid,
        repartidorNombre: rows[0].delivery_name_snapshot || '',
        clienteNombre: rows[0].client_name_snapshot || rows[0].client_name || 'Consumidor Final',
        clienteTelefono: rows[0].delivery_phone_snapshot || rows[0].client_phone || '',
        clienteDireccion: rows[0].delivery_address_snapshot || '',
        clienteReferencia: rows[0].delivery_reference_snapshot || '',
        clienteLocationLink: rows[0].delivery_location_link_snapshot || '',
        clienteLat: created.deliveryLatitude,
        clienteLng: created.deliveryLongitude,
        negocioNombre: created.branchName || '',
        total: Number(rows[0].total || 0),
        productos: productosDelivery,
        notasInternas: rows[0].order_notes || null,
      }).catch(() => {});
    }
  }
  // ── Sync reporte-sistema-pos (fire-and-forget) ──
  fireReportSync(async () => {
    const cfg = await getReportSyncConfig();
    const branches = await getReportSyncBranchesMap();
    const saleRow = rows[0];
    if (!saleRow) return;
    const itemsForSync = items.map((it) => ({
      product_id: it.product_id,
      nombre: it.product_name,
      qty: it.qty,
      price: it.price,
      discount_rate: it.discount_rate,
      precio_compra: it.precio_compra,
    }));
    await reportsSync.syncSale(saleRow, {
      config: cfg,
      branches,
      cashier: saleRow.cashier_name || '',
      items: itemsForSync,
    });
    await syncProductsToReportsByIds(created.productIds, {
      branchId: created.branchId,
    });
    // Resumen diario KPI (para que la app de reportes no necesite el servidor)
    await reportsSync.syncDailySummary(saleRow, { config: cfg });
    // Venta a crédito o pendiente → receivable
    const status = String(saleRow.sale_status || '').toLowerCase();
    const payment = String(saleRow.payment_method || '').toLowerCase();
    if (status === 'pendiente' || payment === 'credito') {
      await reportsSync.syncReceivable({
        id: saleRow.id,
        customerId: saleRow.client_id,
        customerName: saleRow.client_name_snapshot || saleRow.client_name,
        branchId: saleRow.branch_id,
        branchName: created.branchName,
        total: saleRow.total,
        paid: Number(saleRow.received_amount || 0),
        createdAt: saleRow.created_at,
      }, { config: cfg });
    }
  });
  res.status(201).json({
    sale: mapSaleRows(rows, items)[0],
    ecf: ecfEmissionResult,
    // getConfig sin syncRemote evita un round-trip a Firebase durante la venta.
    // El license-watcher y el poller ya sincronizan en background.
    config: await getConfig({ syncRemote: false }),
    updatedClient: updatedClientRows[0] ? mapClientRow(updatedClientRows[0]) : null
  });
});

app.get('/api/sales/delivery-cash-pending', async (req, res) => {
  await ensureBusinessStructureExtensions();
  await ensureSalesExtensions();
  const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
  const scopedBranchId = getUserScopeBranchId(actorUser);
  const scopedCashRegisterId = getUserScopeCashRegisterId(actorUser);
  const config = await getConfig({ syncRemote: false });
  const activeCashRegisterId = Number(scopedCashRegisterId || config.activeCashRegisterId || 0) || 0;
  const rows = scopedBranchId
    ? await query(
        `SELECT s.*, u.nombre AS cashier_name, COALESCE(c.nombre, "Consumidor Final") AS client_name, COALESCE(c.telefono, "") AS client_phone
         FROM sales s
         LEFT JOIN users u ON u.id = s.user_id
         LEFT JOIN clients c ON c.id = s.client_id
         WHERE s.order_type = 'delivery'
           AND s.payment_method = 'contra_entrega'
           AND COALESCE(s.delivery_cash_status, 'pendiente') = 'pendiente'
           AND COALESCE(s.fiscal_status, 'emitida') <> 'cancelada'
           AND COALESCE(s.inventory_branch_id, s.billed_branch_id, s.branch_id) = ?
           AND (? = 0 OR COALESCE(s.cash_register_id, 0) = ?)
         ORDER BY s.created_at DESC`,
        [scopedBranchId, activeCashRegisterId, activeCashRegisterId]
      )
    : await query(
        `SELECT s.*, u.nombre AS cashier_name, COALESCE(c.nombre, "Consumidor Final") AS client_name, COALESCE(c.telefono, "") AS client_phone
         FROM sales s
         LEFT JOIN users u ON u.id = s.user_id
         LEFT JOIN clients c ON c.id = s.client_id
         WHERE s.order_type = 'delivery'
           AND s.payment_method = 'contra_entrega'
           AND COALESCE(s.cash_register_id, 0) = ?
           AND COALESCE(s.delivery_cash_status, 'pendiente') = 'pendiente'
           AND COALESCE(s.fiscal_status, 'emitida') <> 'cancelada'
         ORDER BY s.created_at DESC`,
        [activeCashRegisterId]
      );
  const items = await query('SELECT si.*, p.nombre AS product_name FROM sale_items si LEFT JOIN products p ON p.id = si.product_id');
  res.json(mapSaleRows(rows, items));
});

app.get('/api/sales/pending-collection', async (req, res) => {
  await ensureBusinessRulesExtensions();
  await ensureCashRegisterTypeExtension();
  const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
  const scopedBranchId = getUserScopeBranchId(actorUser);
  const requestedBranchId = Number(req.query?.branchId || 0) || null;
  const branchId = Number(scopedBranchId || requestedBranchId || 0) || null;
  if (scopedBranchId) {
    assertActorCanAccessBranch(actorUser, branchId, 'No puedes consultar cobros pendientes fuera de tu sucursal.');
  }

  // Soporte para caja específica: mostrar solo ventas que esta caja puede cobrar
  const cajaId = Number(req.query?.cashRegisterId || 0) || null;
  let cajaInfo = null;
  if (cajaId) {
    const cajaRows = await query('SELECT * FROM cash_registers WHERE id = ? LIMIT 1', [cajaId]);
    cajaInfo = cajaRows[0] || null;
  }

  const baseQuery = `
    SELECT s.*, u.nombre AS cashier_name,
           COALESCE(c.nombre, s.client_name_snapshot, 'Consumidor Final') AS client_name,
           COALESCE(c.telefono, '') AS client_phone,
           b.nombre AS sucursal_origen_nombre,
           cr.nombre AS caja_origen_nombre
    FROM sales s
    LEFT JOIN users u ON u.id = s.billed_by_user_id
    LEFT JOIN clients c ON c.id = s.client_id
    LEFT JOIN branches b ON b.id = COALESCE(s.billed_branch_id, s.branch_id)
    LEFT JOIN cash_registers cr ON cr.id = COALESCE(s.billed_cash_register_id, s.cash_register_id)
    WHERE COALESCE(s.sale_status, 'pagada') = 'pendiente'
      AND COALESCE(s.fiscal_status, 'emitida') <> 'cancelada'
  `;

  const rows = branchId
    ? await query(baseQuery + ` AND COALESCE(s.inventory_branch_id, s.billed_branch_id, s.branch_id) = ? ORDER BY s.id DESC`, [branchId])
    : await query(baseQuery + ` ORDER BY s.id DESC`);

  const salesIds = rows.map((r) => r.id);
  const items = salesIds.length
    ? await query(`SELECT si.*, p.nombre AS product_name FROM sale_items si LEFT JOIN products p ON p.id = si.product_id WHERE si.sale_id IN (${salesIds.map(() => '?').join(',')})`, salesIds)
    : [];

  const result = mapSaleRows(rows, items).map((s, i) => ({
    ...s,
    sucursalOrigenNombre: rows[i]?.sucursal_origen_nombre || '',
    cajaOrigenNombre: rows[i]?.caja_origen_nombre || ''
  }));

  res.json({
    ventas: result,
    total: result.length,
    cajaPuedeCobrar: cajaInfo
      ? (cajaInfo.tipo_caja !== 'facturacion')
      : true
  });
});

app.patch('/api/sales/:invoiceNumber/collect', async (req, res) => {
  await ensureBusinessRulesExtensions();
  await ensureCashMovementExtensions();
  await ensureInventoryMovementsTable();
  const invoiceNumber = String(req.params.invoiceNumber || '').trim();
  const actorUser = await resolveRequestActorUser(req, { required: true });
  const actor = getActor(req);
  const structure = await resolveScopedBusinessStructureSelection(req, null, req.body?.branchId, req.body?.cashRegisterId);
  const receivedAmount = Number(req.body?.recibido || req.body?.receivedAmount || 0);
  const paymentMethod = String(req.body?.metodo || req.body?.paymentMethod || '').trim();

  // Validar que la caja que cobra tiene permiso para cobrar
  if (structure.cashRegisterId) {
    try {
      const cajaRows = await query('SELECT tipo_caja, puede_cobrar_otras_cajas FROM cash_registers WHERE id = ? LIMIT 1', [structure.cashRegisterId]);
      const caja = cajaRows[0];
      if (caja && caja.tipo_caja === 'facturacion') {
        return res.status(403).json({ error: 'Esta caja está configurada solo para facturación. No puede cobrar ventas.' });
      }
    } catch (_e) {}
  }

  const collectedSale = await withTransaction(async (conn) => {
    const saleRows = await conn.query('SELECT * FROM sales WHERE invoice_number = ? LIMIT 1', [invoiceNumber]);
    const sale = saleRows[0];
    if (!sale) {
      const error = new Error('Factura pendiente no encontrada.');
      error.statusCode = 404;
      throw error;
    }
    assertActorCanAccessBranch(actorUser, Number(sale.inventory_branch_id || sale.billed_branch_id || sale.branch_id || structure.branchId || 0), 'No puedes cobrar ventas de otra sucursal.');
    if (String(sale.fiscal_status || '').trim() === 'cancelada') {
      const error = new Error('No se puede cobrar una factura cancelada.');
      error.statusCode = 409;
      throw error;
    }
    if (String(sale.sale_status || 'pagada').trim() !== 'pendiente') {
      const error = new Error('Esta factura ya fue cobrada.');
      error.statusCode = 409;
      throw error;
    }

    const inventoryBranchId = Number(sale.inventory_branch_id || sale.billed_branch_id || sale.branch_id || structure.branchId || 0) || 0;
    if (!inventoryBranchId) {
      const error = new Error('La venta pendiente no tiene una sucursal de inventario válida.');
      error.statusCode = 409;
      throw error;
    }

    const saleItems = await conn.query(
      `SELECT si.*, p.codigo AS product_code, p.nombre AS product_name, p.precio_compra
       FROM sale_items si
       LEFT JOIN products p ON p.id = si.product_id
       WHERE si.sale_id = ?`,
      [sale.id]
    );

    const affectedProductIds = new Set();
    for (const item of saleItems) {
      affectedProductIds.add(Number(item.product_id || 0) || 0);
      const qty = Number(item.qty || 0);
      const stockChange = await changeBranchInventoryStock(conn, {
        productId: item.product_id,
        branchId: inventoryBranchId,
        quantityDelta: -qty,
        preventNegative: true
      });
      await registerInventoryMovement(conn, {
        productId: item.product_id,
        tipo: 'venta',
        cantidad: -qty,
        stockAnterior: stockChange.previousStock,
        stockNuevo: stockChange.nextStock,
        costoUnitario: Number(item.precio_compra || stockChange.unitCost || 0),
        referenciaTipo: 'venta',
        referenciaId: invoiceNumber,
        notas: `Descuento por cobro de factura pendiente ${invoiceNumber}`,
        usuarioId: actor.userId || null,
        usuarioNombre: actor.userName || 'Sistema',
        branchId: inventoryBranchId,
        cashRegisterId: structure.cashRegisterId,
        saleId: sale.id
      });
    }

    const cashDelta = Number(sale.total || 0);
    const effectiveReceived = receivedAmount > 0 ? receivedAmount : cashDelta;
    const changeAmount = Math.max(0, Number((effectiveReceived - cashDelta).toFixed(2)));
    await conn.query(
      `UPDATE sales
       SET sale_status = 'pagada',
           payment_method = ?,
           received_amount = ?,
           change_amount = ?,
           charged_branch_id = ?,
           charged_cash_register_id = ?,
           charged_by_user_id = ?,
           charged_at = datetime('now'),
           inventory_branch_id = ?,
           inventory_discounted_at = datetime('now')
       WHERE id = ?`,
      [
        paymentMethod || sale.payment_method,
        effectiveReceived,
        changeAmount,
        structure.branchId,
        structure.cashRegisterId,
        actor.userId || null,
        inventoryBranchId,
        sale.id
      ]
    );

    const openSessionRows = await conn.query(
      'SELECT id FROM cash_sessions WHERE status = "open" AND cash_register_id = ? ORDER BY id DESC LIMIT 1',
      [structure.cashRegisterId]
    );
    if (openSessionRows[0]?.id) {
      await conn.query(
        `INSERT INTO cash_movements (session_id, movement_type, amount, notes, created_by_user_id, created_by_user_name, happened_at, branch_id, cash_register_id)
         VALUES (?, "Cobro factura pendiente", ?, ?, ?, ?, datetime('now'), ?, ?)`,
        [openSessionRows[0].id, cashDelta, `Cobro de ${invoiceNumber}`, actor.userId || null, actor.userName || 'Sistema', structure.branchId, structure.cashRegisterId]
      );
      await conn.query('UPDATE cash_sessions SET current_amount = current_amount + ? WHERE id = ?', [cashDelta, openSessionRows[0].id]);
    }

    await conn.query('UPDATE config SET cash_amount = cash_amount + ? WHERE id = 1', [cashDelta]);

    const rows = await conn.query(
      'SELECT s.*, u.nombre AS cashier_name, COALESCE(c.nombre, "Consumidor Final") AS client_name, COALESCE(c.telefono, "") AS client_phone FROM sales s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN clients c ON c.id = s.client_id WHERE s.id = ?',
      [sale.id]
    );
    const items = await conn.query('SELECT si.*, p.nombre AS product_name FROM sale_items si LEFT JOIN products p ON p.id = si.product_id WHERE sale_id = ?', [sale.id]);
    return {
      sale: mapSaleRows(rows, items)[0],
      productIds: [...affectedProductIds].filter((value) => value > 0),
      branchId: inventoryBranchId,
    };
  });

  await writeAuditLog({
    ...actor,
    moduleName: 'Caja',
    actionName: 'Factura pendiente cobrada',
    detail: `${invoiceNumber} · cobrada en sucursal ${structure.branch.nombre} · caja ${structure.cashRegister.nombre}`
  });
  fireReportSync(async () => {
    await syncProductsToReportsByIds(collectedSale.productIds, {
      branchId: collectedSale.branchId,
    });
  });

  res.json({
    sale: collectedSale.sale,
    config: await getConfig()
  });
});

app.patch('/api/sales/:invoiceNumber/settle-delivery-cash', async (req, res) => {
  await ensureBusinessStructureExtensions();
  await ensureSalesExtensions();
  const invoiceNumber = String(req.params.invoiceNumber || '').trim();
  const actorUser = await resolveRequestActorUser(req, { required: true });
  const actor = getActor(req);

  const settledSale = await withTransaction(async (conn) => {
    const saleRows = await conn.query('SELECT * FROM sales WHERE invoice_number = ? LIMIT 1', [invoiceNumber]);
    const sale = saleRows[0];
    if (!sale) {
      const error = new Error('Factura delivery no encontrada.');
      error.statusCode = 404;
      throw error;
    }
    assertActorCanAccessBranch(actorUser, Number(sale.inventory_branch_id || sale.billed_branch_id || sale.branch_id || 0), 'No puedes validar cobros delivery de otra sucursal.');
    if (sale.order_type !== 'delivery' || sale.payment_method !== 'contra_entrega') {
      const error = new Error('Esta factura no corresponde a un pago contra entrega.');
      error.statusCode = 409;
      throw error;
    }
    if (String(sale.delivery_cash_status || '').trim() === 'validado') {
      const error = new Error('Este pago contra entrega ya fue validado.');
      error.statusCode = 409;
      throw error;
    }

    await conn.query(
      `UPDATE sales
       SET delivery_cash_status = 'validado',
           delivery_cash_received_at = datetime('now'),
           delivery_cash_received_by_user_id = ?,
           delivery_cash_received_by_user_name = ?,
           charged_branch_id = COALESCE(charged_branch_id, branch_id),
           charged_cash_register_id = COALESCE(charged_cash_register_id, cash_register_id),
           charged_by_user_id = COALESCE(charged_by_user_id, ?),
           charged_at = COALESCE(charged_at, datetime('now')),
           received_amount = total,
           change_amount = 0
      WHERE id = ?`,
      [actor.userId || null, actor.userName || 'Sistema', actor.userId || null, sale.id]
    );
    const openSessionRows = await conn.query(
      'SELECT id FROM cash_sessions WHERE status = "open" AND cash_register_id = ? ORDER BY id DESC LIMIT 1',
      [sale.cash_register_id]
    );
    if (openSessionRows[0]?.id) {
      await conn.query('UPDATE cash_sessions SET current_amount = current_amount + ? WHERE id = ?', [Number(sale.total || 0), openSessionRows[0].id]);
    }
    await conn.query('UPDATE config SET cash_amount = cash_amount + ? WHERE id = 1', [Number(sale.total || 0)]);

    const rows = await conn.query(
      'SELECT s.*, u.nombre AS cashier_name, COALESCE(c.nombre, "Consumidor Final") AS client_name, COALESCE(c.telefono, "") AS client_phone FROM sales s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN clients c ON c.id = s.client_id WHERE s.id = ?',
      [sale.id]
    );
    const items = await conn.query('SELECT si.*, p.nombre AS product_name FROM sale_items si LEFT JOIN products p ON p.id = si.product_id WHERE sale_id = ?', [sale.id]);
    return mapSaleRows(rows, items)[0];
  });

  await writeAuditLog({
    ...actor,
    moduleName: 'Caja',
    actionName: 'Contra entrega validado',
    detail: `${invoiceNumber} · dinero recibido del delivery`
  });

  res.json({
    sale: settledSale,
    config: await getConfig()
  });
});

app.patch('/api/sales/:invoiceNumber/cancel', async (req, res) => {
  await ensureBusinessRulesExtensions();
  await ensureInventoryMovementsTable();
  const invoiceNumber = String(req.params.invoiceNumber || '').trim();
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!isGlobalAdministratorUser(actorUser) && !userRoleHasPermission(actorUser, 'borrar_ventas')) {
    return res.status(403).json({ error: 'No tienes permiso para cancelar ventas históricas.' });
  }
  const actor = getActor(req);
  const reason = String(req.body?.reason || '').trim() || 'Cancelada desde movimientos';

  const result = await withTransaction(async (conn) => {
    const saleRows = await conn.query('SELECT * FROM sales WHERE invoice_number = ? LIMIT 1', [invoiceNumber]);
    const sale = saleRows[0];
    if (!sale) {
      const error = new Error('Factura o pedido no encontrado.');
      error.statusCode = 404;
      throw error;
    }
    assertActorCanAccessBranch(actorUser, Number(sale.inventory_branch_id || sale.billed_branch_id || sale.branch_id || 0), 'No puedes cancelar ventas de otra sucursal.');
    if (String(sale.fiscal_status || '').trim() === 'cancelada') {
      const error = new Error('Esta factura ya fue cancelada.');
      error.statusCode = 409;
      throw error;
    }

    const saleItems = await conn.query(
      `SELECT si.*, p.codigo AS product_code, p.nombre AS product_name, p.stock, p.precio_compra
       FROM sale_items si
       LEFT JOIN products p ON p.id = si.product_id
       WHERE si.sale_id = ?`,
      [sale.id]
    );

    const inventoryWasDiscounted = Boolean(sale.inventory_discounted_at) || String(sale.sale_status || '').trim() === 'pagada';
    const inventoryBranchId = Number(sale.inventory_branch_id || sale.billed_branch_id || sale.branch_id || 0) || 0;

    const affectedProductIds = new Set();
    if (inventoryWasDiscounted && inventoryBranchId) {
      for (const item of saleItems) {
        affectedProductIds.add(Number(item.product_id || 0) || 0);
        const qty = Number(item.qty || 0);
        const stockChange = await changeBranchInventoryStock(conn, {
          productId: item.product_id,
          branchId: inventoryBranchId,
          quantityDelta: qty
        });
        await registerInventoryMovement(conn, {
          productId: item.product_id,
          tipo: 'cancelacion_venta',
          cantidad: qty,
          stockAnterior: stockChange.previousStock,
          stockNuevo: stockChange.nextStock,
          costoUnitario: Number(item.precio_compra || stockChange.unitCost || 0),
          referenciaTipo: 'cancelacion_venta',
          referenciaId: invoiceNumber,
          notas: `Reintegro por cancelación ${invoiceNumber}`,
          usuarioId: actor.userId || null,
          usuarioNombre: actor.userName || 'Sistema',
          branchId: inventoryBranchId,
          cashRegisterId: Number(sale.charged_cash_register_id || sale.cash_register_id || 0) || null,
          saleId: sale.id
        });
      }
    }

    await conn.query(
      `UPDATE sales
       SET fiscal_status = 'cancelada',
           canceled_at = datetime('now'),
           canceled_by_user_id = ?,
           canceled_by_user_name = ?,
           cancel_reason = ?
       WHERE id = ?`,
      [actor.userId || null, actor.userName || 'Sistema', reason, sale.id]
    );

    const saleTotal = Number(sale.total || 0);
    const receivedAmount = Number(sale.received_amount || 0);
    const alreadyCollected = String(sale.sale_status || '').trim() === 'pagada';
    const cashAdjustment = !alreadyCollected
      ? 0
      : sale.payment_method === 'contra_entrega'
      ? (String(sale.delivery_cash_status || '').trim() === 'validado' ? saleTotal : 0)
      : (sale.payment_method === 'credito' ? receivedAmount : saleTotal);
    const creditBalanceAdjustment = sale.payment_method === 'credito'
      ? Math.max(0, saleTotal - receivedAmount)
      : 0;

    await conn.query('UPDATE config SET cash_amount = cash_amount - ? WHERE id = 1', [cashAdjustment]);
    if (sale.client_id && creditBalanceAdjustment > 0) {
      await conn.query(
        'UPDATE clients SET balance = MAX(COALESCE(balance, 0) - ?, 0) WHERE id = ?',
        [creditBalanceAdjustment, sale.client_id]
      );
    }

    const rows = await conn.query(
      'SELECT s.*, u.nombre AS cashier_name, COALESCE(c.nombre, "Consumidor Final") AS client_name, COALESCE(c.telefono, "") AS client_phone FROM sales s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN clients c ON c.id = s.client_id WHERE s.id = ?',
      [sale.id]
    );
    const items = await conn.query('SELECT si.*, p.nombre AS product_name FROM sale_items si LEFT JOIN products p ON p.id = si.product_id WHERE sale_id = ?', [sale.id]);
    return {
      sale: mapSaleRows(rows, items)[0],
      productIds: [...affectedProductIds].filter((value) => value > 0),
      branchId: inventoryBranchId || null,
    };
  });

  await writeAuditLog({
    ...actor,
    moduleName: 'Ventas',
    actionName: 'Factura cancelada',
    detail: `${invoiceNumber} · ${reason}`
  });
  fireReportSync(async () => {
    const cfg = await getReportSyncConfig();
    await reportsSync.markSaleCancelled(invoiceNumber, {
      config: cfg,
      reason,
    });
    await syncProductsToReportsByIds(result.productIds, {
      branchId: result.branchId,
    });
  });

  res.json({
    sale: result.sale,
    config: await getConfig()
  });
});

// Stores the local PDF path after Electron saves it to disk
app.patch('/api/sales/:invoiceNumber/pdf-path', async (req, res) => {
  try {
    await ensureSalesExtensions();
    await resolveRequestActorUser(req, { required: true });
    const invoiceNumber = String(req.params.invoiceNumber || '').trim();
    const pdfPath = String(req.body?.pdfPath || '').trim();
    if (!invoiceNumber || !pdfPath) {
      return res.status(400).json({ error: 'Parámetros incompletos.' });
    }
    await query('UPDATE sales SET pdf_path = ? WHERE invoice_number = ?', [pdfPath, invoiceNumber]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/sales/:invoiceNumber/kitchen-status', async (req, res) => {
  await ensureSalesExtensions();
  const invoiceNumber = String(req.params.invoiceNumber || '').trim();
  const kitchenStatus = String(req.body?.estadoCocina || '').trim();
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!['pendiente', 'en preparacion', 'en horno', 'lista', 'entregada'].includes(kitchenStatus)) {
    return res.status(400).json({ error: 'Estado de cocina no válido.' });
  }
  const existingRows = await query(
    'SELECT s.*, u.nombre AS cashier_name, COALESCE(c.nombre, "Consumidor Final") AS client_name, COALESCE(c.telefono, "") AS client_phone FROM sales s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN clients c ON c.id = s.client_id WHERE s.invoice_number = ? LIMIT 1',
    [invoiceNumber]
  );
  if (!existingRows.length) return res.status(404).json({ error: 'Pedido no encontrado.' });
  assertActorCanAccessBranch(actorUser, Number(existingRows[0].inventory_branch_id || existingRows[0].billed_branch_id || existingRows[0].branch_id || 0), 'No puedes actualizar pedidos de otra sucursal.');
  await query('UPDATE sales SET kitchen_status = ? WHERE invoice_number = ?', [kitchenStatus, invoiceNumber]);
  const rows = await query(
    'SELECT s.*, u.nombre AS cashier_name, COALESCE(c.nombre, "Consumidor Final") AS client_name, COALESCE(c.telefono, "") AS client_phone FROM sales s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN clients c ON c.id = s.client_id WHERE s.invoice_number = ? LIMIT 1',
    [invoiceNumber]
  );
  const items = await query('SELECT si.*, p.nombre AS product_name FROM sale_items si LEFT JOIN products p ON p.id = si.product_id WHERE sale_id = ?', [rows[0].id]);
  const actor = getActor(req);
  await writeAuditLog({
    ...actor,
    moduleName: 'Cocina',
    actionName: 'Estado de pedido actualizado',
    detail: `${invoiceNumber} · ${kitchenStatus}`
  });
  res.json(mapSaleRows(rows, items)[0]);
});

app.get('/api/delivery/locations', async (_req, res) => {
  res.json(await getLatestDeliveryLocations());
});

app.get('/api/dining-tables', async (_req, res) => {
  await ensureDiningTables();
  const rows = await query('SELECT * FROM dining_tables ORDER BY nombre');
  res.json(rows.map((row) => ({
    id: row.id,
    nombre: row.nombre,
    capacidad: Number(row.capacidad || 0),
    estado: row.estado
  })));
});

app.get('/api/roles', async (_req, res) => {
  await ensureRolesTable();
  const rows = await query('SELECT * FROM roles WHERE estado = "Activo" ORDER BY nombre');
  res.json(rows.map((row) => ({
    id: Number(row.id),
    codigo: row.codigo,
    nombre: row.nombre,
    permisos: parseJsonArrayField(row.permisos)
  })));
});

app.get('/api/payment-methods', async (_req, res) => {
  await ensurePaymentMethodsTable();
  const rows = await query('SELECT * FROM payment_methods WHERE estado = "Activo" ORDER BY nombre');
  res.json(rows.map((row) => ({
    id: Number(row.id),
    codigo: row.codigo,
    nombre: row.nombre
  })));
});

app.get('/api/transfers', async (req, res) => {
  await ensureBusinessRulesExtensions();
  const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
  if (!userCanManageTransfers(actorUser)) {
    return res.status(403).json({ error: 'Las transferencias entre sucursales requieren permiso especial.' });
  }
  const rows = await query(
    `SELECT bt.*, bo.nombre AS from_branch_name, bd.nombre AS to_branch_name
     FROM branch_transfers bt
     INNER JOIN branches bo ON bo.id = bt.from_branch_id
     INNER JOIN branches bd ON bd.id = bt.to_branch_id
     ORDER BY bt.id DESC`
  );
  const itemRows = await query(
    `SELECT bti.*, p.nombre AS product_name, p.codigo AS product_code
     FROM branch_transfer_items bti
     INNER JOIN products p ON p.id = bti.product_id
     ORDER BY bti.transfer_id DESC, bti.id ASC`
  );
  res.json(rows.map((row) => ({
    id: Number(row.id),
    sucursalOrigenId: Number(row.from_branch_id),
    sucursalOrigen: row.from_branch_name,
    sucursalDestinoId: Number(row.to_branch_id),
    sucursalDestino: row.to_branch_name,
    estado: row.status,
    notas: row.notes || '',
    creadoPorUsuarioId: row.created_by_user_id === null || row.created_by_user_id === undefined ? null : Number(row.created_by_user_id),
    creadoPorUsuarioNombre: row.created_by_user_name || 'Sistema',
    fecha: row.created_at,
    items: itemRows
      .filter((item) => Number(item.transfer_id) === Number(row.id))
      .map((item) => ({
        id: Number(item.id),
        productoId: Number(item.product_id),
        codigo: item.product_code || '',
        nombre: item.product_name || '',
        cantidad: Number(item.qty || 0),
        costoUnitario: Number(item.unit_cost || 0),
        notas: item.notes || ''
      }))
  })));
});

app.post('/api/transfers', async (req, res) => {
  await ensureBusinessRulesExtensions();
  await ensureInventoryMovementsTable();
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!userCanManageTransfers(actorUser)) {
    return res.status(403).json({ error: 'No tienes permiso para transferir productos entre sucursales.' });
  }
  const actor = getActor(req);
  const fromBranchId = Number(req.body?.fromBranchId || req.body?.sucursalOrigenId || 0) || 0;
  const toBranchId = Number(req.body?.toBranchId || req.body?.sucursalDestinoId || 0) || 0;
  const notes = String(req.body?.notes || req.body?.notas || '').trim();
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  if (!fromBranchId || !toBranchId || fromBranchId === toBranchId) {
    return res.status(400).json({ error: 'Debes indicar una sucursal origen y otra destino válidas.' });
  }
  if (!items.length) {
    return res.status(400).json({ error: 'La transferencia debe incluir al menos un producto.' });
  }

  const transfer = await withTransaction(async (conn) => {
    const branchRows = await conn.query('SELECT id, nombre FROM branches WHERE id IN (?, ?)', [fromBranchId, toBranchId]);
    if (branchRows.length < 2) {
      const error = new Error('No se encontraron las sucursales indicadas para la transferencia.');
      error.statusCode = 404;
      throw error;
    }
    const transferResult = await conn.query(
      `INSERT INTO branch_transfers (from_branch_id, to_branch_id, status, notes, created_by_user_id, created_by_user_name, created_at)
       VALUES (?, ?, 'completada', ?, ?, ?, datetime('now'))`,
      [fromBranchId, toBranchId, notes || null, actor.userId || null, actor.userName || 'Sistema']
    );

    for (const rawItem of items) {
      const productId = Number(rawItem.productId || rawItem.id || 0) || 0;
      const qty = Math.abs(Number(rawItem.qty || rawItem.cantidad || 0));
      if (!productId || qty <= 0) continue;

      const originInventory = await ensureBranchInventoryRecord(conn, productId, fromBranchId);
      if (!originInventory || Number(originInventory.stock || 0) < qty) {
        const error = new Error(`Stock insuficiente para transferir el producto ${rawItem.nombre || productId}.`);
        error.statusCode = 409;
        throw error;
      }

      const originChange = await changeBranchInventoryStock(conn, {
        productId,
        branchId: fromBranchId,
        quantityDelta: -qty,
        preventNegative: true
      });
      const destinationChange = await changeBranchInventoryStock(conn, {
        productId,
        branchId: toBranchId,
        quantityDelta: qty
      });

      await conn.query(
        `INSERT INTO branch_transfer_items (transfer_id, product_id, qty, unit_cost, notes, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        [transferResult.insertId, productId, qty, Number(rawItem.costoUnitario || originChange.unitCost || 0), rawItem.notas || null]
      );

      await registerInventoryMovement(conn, {
        productId,
        tipo: 'transferencia',
        cantidad: -qty,
        stockAnterior: originChange.previousStock,
        stockNuevo: originChange.nextStock,
        costoUnitario: Number(rawItem.costoUnitario || originChange.unitCost || 0),
        referenciaTipo: 'transferencia_salida',
        referenciaId: String(transferResult.insertId),
        notas: `Salida por transferencia a sucursal ${toBranchId}`,
        usuarioId: actor.userId || null,
        usuarioNombre: actor.userName || 'Sistema',
        branchId: fromBranchId,
        sourceBranchId: fromBranchId,
        destinationBranchId: toBranchId,
        transferId: Number(transferResult.insertId)
      });
      await registerInventoryMovement(conn, {
        productId,
        tipo: 'transferencia',
        cantidad: qty,
        stockAnterior: destinationChange.previousStock,
        stockNuevo: destinationChange.nextStock,
        costoUnitario: Number(rawItem.costoUnitario || originChange.unitCost || 0),
        referenciaTipo: 'transferencia_entrada',
        referenciaId: String(transferResult.insertId),
        notas: `Entrada por transferencia desde sucursal ${fromBranchId}`,
        usuarioId: actor.userId || null,
        usuarioNombre: actor.userName || 'Sistema',
        branchId: toBranchId,
        sourceBranchId: fromBranchId,
        destinationBranchId: toBranchId,
        transferId: Number(transferResult.insertId)
      });
    }

    const rows = await conn.query(
      `SELECT bt.*, bo.nombre AS from_branch_name, bd.nombre AS to_branch_name
       FROM branch_transfers bt
       INNER JOIN branches bo ON bo.id = bt.from_branch_id
       INNER JOIN branches bd ON bd.id = bt.to_branch_id
       WHERE bt.id = ? LIMIT 1`,
      [transferResult.insertId]
    );
    const itemRows = await conn.query(
      `SELECT bti.*, p.nombre AS product_name, p.codigo AS product_code
       FROM branch_transfer_items bti
       INNER JOIN products p ON p.id = bti.product_id
       WHERE bti.transfer_id = ?
       ORDER BY bti.id`,
      [transferResult.insertId]
    );
    return {
      id: Number(rows[0].id),
      sucursalOrigenId: Number(rows[0].from_branch_id),
      sucursalOrigen: rows[0].from_branch_name,
      sucursalDestinoId: Number(rows[0].to_branch_id),
      sucursalDestino: rows[0].to_branch_name,
      estado: rows[0].status,
      notas: rows[0].notes || '',
      fecha: rows[0].created_at,
      items: itemRows.map((item) => ({
        id: Number(item.id),
        productoId: Number(item.product_id),
        codigo: item.product_code || '',
        nombre: item.product_name || '',
        cantidad: Number(item.qty || 0),
        costoUnitario: Number(item.unit_cost || 0),
        notas: item.notes || ''
      }))
    };
  });

  await writeAuditLog({
    ...actor,
    moduleName: 'Inventario',
    actionName: 'Transferencia entre sucursales',
    detail: `${transfer.sucursalOrigen} -> ${transfer.sucursalDestino} · ${transfer.items.length} productos`
  });

  res.status(201).json(transfer);
});

// Sesiones activas — solo admin general
app.get('/api/sessions', async (req, res) => {
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!isGlobalAdministratorUser(actorUser)) {
    return res.status(403).json({ error: 'Solo el administrador general puede ver sesiones activas.' });
  }
  try {
    const rows = await query(`
      SELECT s.id, s.user_id, s.ip_address, s.created_at, s.expires_at, s.last_seen_at,
             u.nombre AS user_nombre, u.usuario, u.rol
      FROM sesiones_activas s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.is_active = 1 AND s.expires_at > datetime('now')
      ORDER BY s.last_seen_at DESC
    `);
    res.json(rows.map((r) => ({
      token: r.id.slice(0, 8) + '...', // nunca exponer el token completo
      userId: r.user_id,
      nombre: r.user_nombre || '',
      usuario: r.usuario || '',
      rol: r.rol || '',
      ip: r.ip_address || '',
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      lastSeenAt: r.last_seen_at
    })));
  } catch (_e) {
    res.json([]);
  }
});

// Invalidar sesión específica — solo admin
app.delete('/api/sessions/:tokenPrefix', async (req, res) => {
  const actorUser = await resolveRequestActorUser(req, { required: true });
  if (!isGlobalAdministratorUser(actorUser)) {
    return res.status(403).json({ error: 'Solo el administrador general puede cerrar sesiones.' });
  }
  const prefix = String(req.params.tokenPrefix || '').trim();
  if (prefix.length < 8) return res.status(400).json({ error: 'Prefijo de sesión inválido.' });
  try {
    await query(`UPDATE sesiones_activas SET is_active = 0 WHERE id LIKE ?`, [prefix + '%']);
  } catch (_e) {}
  res.json({ ok: true });
});

// Reporte consolidado global — filtrable por sucursal, caja, cajero, fecha
app.get('/api/reports/consolidado-global', async (req, res) => {
  await ensureBusinessRulesExtensions();
  const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
  if (!isGlobalAdministratorUser(actorUser)) {
    return res.status(403).json({ error: 'Solo el administrador general puede ver el consolidado global.' });
  }
  const desde = String(req.query?.desde || '').trim() || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const hasta = String(req.query?.hasta || '').trim() || new Date().toISOString().split('T')[0];
  const branchId = Number(req.query?.branchId || 0) || null;
  const cashRegisterId = Number(req.query?.cashRegisterId || 0) || null;
  const userId = Number(req.query?.userId || 0) || null;

  let where = `WHERE s.created_at BETWEEN ? AND ? AND COALESCE(s.fiscal_status,'emitida') <> 'cancelada'`;
  const params = [`${desde} 00:00:00`, `${hasta} 23:59:59`];
  if (branchId) { where += ' AND COALESCE(s.billed_branch_id, s.branch_id) = ?'; params.push(branchId); }
  if (cashRegisterId) { where += ' AND COALESCE(s.billed_cash_register_id, s.cash_register_id) = ?'; params.push(cashRegisterId); }
  if (userId) { where += ' AND s.billed_by_user_id = ?'; params.push(userId); }

  const ventas = await query(`
    SELECT s.id, s.invoice_number, s.total, s.subtotal, s.tax, s.discount,
           s.sale_status, s.payment_method, s.created_at, s.charged_at,
           s.billed_by_user_id, s.charged_by_user_id,
           b.nombre AS sucursal_nombre,
           cr.nombre AS caja_factura_nombre,
           cc.nombre AS caja_cobro_nombre,
           ub.nombre AS cajero_factura,
           uc.nombre AS cajero_cobro,
           COALESCE(c.nombre, s.client_name_snapshot, 'Consumidor Final') AS cliente
    FROM sales s
    LEFT JOIN branches b      ON b.id  = COALESCE(s.billed_branch_id, s.branch_id)
    LEFT JOIN cash_registers cr ON cr.id = COALESCE(s.billed_cash_register_id, s.cash_register_id)
    LEFT JOIN cash_registers cc ON cc.id = s.charged_cash_register_id
    LEFT JOIN users ub         ON ub.id = s.billed_by_user_id
    LEFT JOIN users uc         ON uc.id = s.charged_by_user_id
    LEFT JOIN clients c        ON c.id  = s.client_id
    ${where}
    ORDER BY s.created_at DESC
    LIMIT 2000
  `, params);

  // Resumen por sucursal
  const porSucursal = {};
  for (const v of ventas) {
    const key = v.sucursal_nombre || 'Sin sucursal';
    if (!porSucursal[key]) porSucursal[key] = { ventas: 0, total: 0 };
    porSucursal[key].ventas++;
    porSucursal[key].total += Number(v.total || 0);
  }

  const totalGeneral = ventas.reduce((s, v) => s + Number(v.total || 0), 0);
  const cobradas = ventas.filter((v) => v.sale_status === 'pagada').length;
  const pendientes = ventas.filter((v) => v.sale_status === 'pendiente').length;

  res.json({
    desde, hasta,
    totalGeneral: Number(totalGeneral.toFixed(2)),
    totalVentas: ventas.length,
    cobradas,
    pendientes,
    resumenPorSucursal: Object.entries(porSucursal).map(([nombre, data]) => ({ nombre, ...data })),
    ventas: ventas.map((v) => ({
      id: Number(v.id),
      factura: v.invoice_number,
      total: Number(v.total || 0),
      estado: v.sale_status,
      metodoPago: v.payment_method || '',
      sucursal: v.sucursal_nombre || '',
      cajaFactura: v.caja_factura_nombre || '',
      cajaCobro: v.caja_cobro_nombre || '',
      cajeroFactura: v.cajero_factura || '',
      cajeroCobro: v.cajero_cobro || '',
      cliente: v.cliente || '',
      fecha: v.created_at,
      fechaCobro: v.charged_at || null
    }))
  });
});

app.get('/api/reports/sales-by-branch', async (req, res) => {
  await ensureBusinessRulesExtensions();
  const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
  const scopedBranchId = getUserScopeBranchId(actorUser);
  const rows = await query(
    `SELECT b.id, b.nombre, COUNT(s.id) AS total_sales, COALESCE(SUM(s.total), 0) AS total_amount
     FROM branches b
     LEFT JOIN sales s ON COALESCE(s.inventory_branch_id, s.billed_branch_id, s.branch_id) = b.id
       AND COALESCE(s.fiscal_status, 'emitida') <> 'cancelada'
     ${scopedBranchId ? 'WHERE b.id = ?' : ''}
     GROUP BY b.id, b.nombre
     ORDER BY b.nombre`,
    scopedBranchId ? [scopedBranchId] : []
  );
  res.json(rows.map((row) => ({
    sucursalId: Number(row.id),
    sucursal: row.nombre,
    ventas: Number(row.total_sales || 0),
    total: Number(row.total_amount || 0)
  })));
});

app.get('/api/reports/sales-by-cash-register', async (req, res) => {
  await ensureBusinessRulesExtensions();
  const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
  const scopedBranchId = getUserScopeBranchId(actorUser);
  const rows = await query(
    `SELECT cr.id, cr.nombre, b.nombre AS branch_name, COUNT(s.id) AS total_sales, COALESCE(SUM(s.total), 0) AS total_amount
     FROM cash_registers cr
     INNER JOIN branches b ON b.id = cr.branch_id
     LEFT JOIN sales s ON COALESCE(s.charged_cash_register_id, s.cash_register_id) = cr.id
       AND COALESCE(s.fiscal_status, 'emitida') <> 'cancelada'
     ${scopedBranchId ? 'WHERE cr.branch_id = ?' : ''}
     GROUP BY cr.id, cr.nombre, b.nombre
     ORDER BY b.nombre, cr.nombre`,
    scopedBranchId ? [scopedBranchId] : []
  );
  res.json(rows.map((row) => ({
    cajaId: Number(row.id),
    caja: row.nombre,
    sucursal: row.branch_name,
    ventas: Number(row.total_sales || 0),
    total: Number(row.total_amount || 0)
  })));
});

app.get('/api/reports/sales-by-cashier', async (req, res) => {
  await ensureBusinessRulesExtensions();
  const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
  const scopedBranchId = getUserScopeBranchId(actorUser);
  const rows = await query(
    `SELECT u.id, u.nombre, u.usuario, COUNT(s.id) AS total_sales, COALESCE(SUM(s.total), 0) AS total_amount
     FROM users u
     LEFT JOIN sales s ON COALESCE(s.charged_by_user_id, s.user_id) = u.id
       AND COALESCE(s.fiscal_status, 'emitida') <> 'cancelada'
     ${scopedBranchId ? 'WHERE COALESCE(u.sucursal_id, u.branch_id, 0) = ?' : ''}
     GROUP BY u.id, u.nombre, u.usuario
     ORDER BY total_amount DESC, u.nombre`,
    scopedBranchId ? [scopedBranchId] : []
  );
  res.json(rows.map((row) => ({
    usuarioId: Number(row.id),
    usuario: row.usuario,
    nombre: row.nombre,
    ventas: Number(row.total_sales || 0),
    total: Number(row.total_amount || 0)
  })));
});

app.get('/api/reports/cash-open-close', async (req, res) => {
  await ensureBusinessRulesExtensions();
  const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
  const scopedBranchId = getUserScopeBranchId(actorUser);
  const rows = await query(
    `SELECT cs.id, cs.opened_at, cs.closed_at, cs.opened_amount, cs.closed_amount, cs.current_amount,
            cs.expected_amount, cs.counted_amount, cs.difference_amount, cs.status,
            b.nombre AS branch_name, cr.nombre AS cash_register_name, cs.opened_by_user_name
            ,COALESCE(cm.total_income, 0) AS total_income
            ,COALESCE(cm.total_expenses, 0) AS total_expenses
            ,COALESCE(cm.total_withdrawals, 0) AS total_withdrawals
     FROM cash_sessions cs
     LEFT JOIN branches b ON b.id = cs.branch_id
     LEFT JOIN cash_registers cr ON cr.id = cs.cash_register_id
     LEFT JOIN (
       SELECT session_id,
              SUM(CASE
                    WHEN movement_type IN ('Venta', 'Cobro crédito cliente', 'Ingreso adicional', 'entrada', 'income')
                    THEN ABS(amount)
                    ELSE 0
                  END) AS total_income,
              SUM(CASE
                    WHEN movement_type IN ('Gasto', 'Pago suplidor', 'Devolución', 'Egreso', 'salida', 'gasto', 'expense')
                    THEN ABS(amount)
                    ELSE 0
                  END) AS total_expenses,
              SUM(CASE
                    WHEN movement_type IN ('Retiro', 'Retiro de efectivo', 'retiro', 'withdrawal')
                    THEN ABS(amount)
                    ELSE 0
                  END) AS total_withdrawals
       FROM cash_movements
       GROUP BY session_id
     ) cm ON cm.session_id = cs.id
     ${scopedBranchId ? 'WHERE cs.branch_id = ?' : ''}
     ORDER BY cs.id DESC`,
    scopedBranchId ? [scopedBranchId] : []
  );
  res.json(rows.map((row) => ({
    sesionId: Number(row.id),
    sucursal: row.branch_name || '',
    caja: row.cash_register_name || '',
    abiertaEn: row.opened_at,
    cerradaEn: row.closed_at || null,
    montoApertura: Number(row.opened_amount || 0),
    montoCierre: Number(row.closed_amount || 0),
    montoEsperado: Number(row.expected_amount || row.current_amount || 0),
    montoContado: row.counted_amount === null || row.counted_amount === undefined ? null : Number(row.counted_amount),
    diferencia: row.difference_amount === null || row.difference_amount === undefined ? null : Number(row.difference_amount),
    estado: row.status,
    abiertoPor: row.opened_by_user_name || 'Sistema',
    totalIngresos: Number(row.total_income || 0),
    totalGastos: Number(row.total_expenses || 0),
    totalRetiros: Number(row.total_withdrawals || 0)
  })));
});

app.get('/api/reports/inventory-by-branch', async (req, res) => {
  await ensureBusinessRulesExtensions();
  const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
  const scopedBranchId = getUserScopeBranchId(actorUser);
  const rows = await query(
    `SELECT ib.branch_id, b.nombre AS branch_name, ib.product_id, p.codigo, p.nombre AS product_name,
            p.categoria, p.precio_venta, p.precio_compra, ib.stock, ib.stock_min
     FROM inventory_by_branch ib
     INNER JOIN branches b ON b.id = ib.branch_id
     INNER JOIN products p ON p.id = ib.product_id
     ${scopedBranchId ? 'WHERE ib.branch_id = ?' : ''}
     ORDER BY b.nombre, p.nombre`,
    scopedBranchId ? [scopedBranchId] : []
  );
  res.json(rows.map((row) => ({
    sucursalId: Number(row.branch_id),
    sucursal: row.branch_name,
    productoId: Number(row.product_id),
    codigo: row.codigo,
    nombre: row.product_name,
    categoria: row.categoria || '',
    precioVenta: Number(row.precio_venta || 0),
    precioCompra: Number(row.precio_compra || 0),
    stock: Number(row.stock || 0),
    stockMin: Number(row.stock_min || 0)
  })));
});

app.get('/api/reports/low-stock', async (req, res) => {
  await ensureBusinessRulesExtensions();
  const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
  const scopedBranchId = getUserScopeBranchId(actorUser);
  const rows = await query(
    `SELECT ib.branch_id, b.nombre AS branch_name, ib.product_id, p.codigo, p.nombre AS product_name,
            p.categoria, p.precio_venta, p.precio_compra, ib.stock, ib.stock_min
     FROM inventory_by_branch ib
     INNER JOIN branches b ON b.id = ib.branch_id
     INNER JOIN products p ON p.id = ib.product_id
     WHERE ib.stock <= ib.stock_min
     ${scopedBranchId ? 'AND ib.branch_id = ?' : ''}
     ORDER BY ib.stock ASC, b.nombre, p.nombre`,
    scopedBranchId ? [scopedBranchId] : []
  );
  res.json(rows.map((row) => ({
    sucursalId: Number(row.branch_id),
    sucursal: row.branch_name,
    productoId: Number(row.product_id),
    codigo: row.codigo,
    nombre: row.product_name,
    categoria: row.categoria || '',
    precioVenta: Number(row.precio_venta || 0),
    precioCompra: Number(row.precio_compra || 0),
    stock: Number(row.stock || 0),
    stockMin: Number(row.stock_min || 0)
  })));
});

app.get('/api/reports/transfers', async (req, res) => {
  await ensureBusinessRulesExtensions();
  const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
  if (!userCanManageTransfers(actorUser)) {
    return res.status(403).json({ error: 'Las transferencias entre sucursales requieren permiso especial.' });
  }
  const rows = await query(
    `SELECT bt.id, bt.created_at, bt.status, bt.notes, bo.nombre AS from_branch_name, bd.nombre AS to_branch_name,
            COUNT(bti.id) AS total_items, COALESCE(SUM(bti.qty), 0) AS total_units
     FROM branch_transfers bt
     INNER JOIN branches bo ON bo.id = bt.from_branch_id
     INNER JOIN branches bd ON bd.id = bt.to_branch_id
     LEFT JOIN branch_transfer_items bti ON bti.transfer_id = bt.id
     GROUP BY bt.id, bt.created_at, bt.status, bt.notes, bo.nombre, bd.nombre
     ORDER BY bt.id DESC`
  );
  res.json(rows.map((row) => ({
    transferenciaId: Number(row.id),
    fecha: row.created_at,
    sucursalOrigen: row.from_branch_name,
    sucursalDestino: row.to_branch_name,
    estado: row.status,
    notas: row.notes || '',
    totalProductos: Number(row.total_items || 0),
    totalUnidades: Number(row.total_units || 0)
  })));
});

app.get('/api/reports/dashboard', async (req, res) => {
  await ensureSalesExtensions();
  await ensureBusinessRulesExtensions();
  const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
  const scopedBranchId = getUserScopeBranchId(actorUser);
  const [salesRows, lowStockRows, hourRows, topPizzaRows] = await Promise.all([
    scopedBranchId
      ? query(
          'SELECT payment_method, order_type, total, created_at FROM sales WHERE COALESCE(inventory_branch_id, billed_branch_id, branch_id) = ? ORDER BY id DESC LIMIT 1000',
          [scopedBranchId]
        )
      : query('SELECT payment_method, order_type, total, created_at FROM sales ORDER BY id DESC LIMIT 1000'),
    scopedBranchId
      ? query(
          `SELECT ib.product_id AS id, p.nombre, ib.stock, ib.stock_min
           FROM inventory_by_branch ib
           INNER JOIN products p ON p.id = ib.product_id
           WHERE ib.branch_id = ?
             AND p.estado = "Activo"
             AND ib.stock <= ib.stock_min
           ORDER BY ib.stock ASC
           LIMIT 12`,
          [scopedBranchId]
        )
      : query('SELECT id, nombre, stock, stock_min FROM products WHERE estado = "Activo" AND stock <= stock_min ORDER BY stock ASC LIMIT 12'),
    scopedBranchId
      ? query(
          `SELECT strftime('%H:00', created_at) AS hora, COUNT(*) AS total
           FROM sales
           WHERE COALESCE(inventory_branch_id, billed_branch_id, branch_id) = ?
           GROUP BY strftime('%H:00', created_at)
           ORDER BY total DESC
           LIMIT 8`,
          [scopedBranchId]
        )
      : query(`SELECT strftime('%H:00', created_at) AS hora, COUNT(*) AS total
           FROM sales
           GROUP BY strftime('%H:00', created_at)
           ORDER BY total DESC
           LIMIT 8`),
    scopedBranchId
      ? query(
          `SELECT p.nombre, SUM(si.qty) AS total_qty
           FROM sale_items si
           INNER JOIN sales s ON s.id = si.sale_id
           INNER JOIN products p ON p.id = si.product_id
           WHERE (p.categoria = "Pizzas" OR p.product_type IN ("pizza", "combo"))
             AND COALESCE(s.inventory_branch_id, s.billed_branch_id, s.branch_id) = ?
           GROUP BY p.id, p.nombre
           ORDER BY total_qty DESC
           LIMIT 5`,
          [scopedBranchId]
        )
      : query(`SELECT p.nombre, SUM(si.qty) AS total_qty
           FROM sale_items si
           INNER JOIN products p ON p.id = si.product_id
           WHERE p.categoria = "Pizzas" OR p.product_type IN ("pizza", "combo")
           GROUP BY p.id, p.nombre
           ORDER BY total_qty DESC
           LIMIT 5`)
  ]);

  res.json({
    ventasDelivery: salesRows.filter((row) => row.order_type === 'delivery').length,
    ventasMostrador: salesRows.filter((row) => row.order_type === 'mostrador').length,
    ventasRecoger: salesRows.filter((row) => row.order_type === 'recoger').length,
    productosAgotados: lowStockRows.map((row) => ({
      id: row.id,
      nombre: row.nombre,
      stock: Number(row.stock || 0),
      stockMin: Number(row.stock_min || 0)
    })),
    horasPico: hourRows.map((row) => ({
      hora: row.hora,
      total: Number(row.total || 0)
    })),
    pizzasMasVendidas: topPizzaRows.map((row) => ({
      nombre: row.nombre,
      cantidad: Number(row.total_qty || 0)
    }))
  });
});

// ============================================================
// REPORTES AVANZADOS v2.0
// ============================================================

function buildDateWhere(desde, hasta, alias = 's') {
  return {
    clause: `${alias}.created_at BETWEEN ? AND ?`,
    params: [`${desde} 00:00:00`, `${hasta} 23:59:59`]
  };
}

function getDefaultRange(req) {
  const desde = String(req.query?.desde || '').trim() || new Date(Date.now() - 29 * 86400000).toISOString().split('T')[0];
  const hasta = String(req.query?.hasta || '').trim() || new Date().toISOString().split('T')[0];
  return { desde, hasta };
}

// ── KPIs generales ──────────────────────────────────────────
app.get('/api/reports/advanced/kpis', async (req, res) => {
  try {
    const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    const scopedBranchId = getUserScopeBranchId(actorUser);
    const { desde, hasta } = getDefaultRange(req);
    const branchId = Number(req.query?.branchId || 0) || null;
    const cajaId = Number(req.query?.cajaId || 0) || null;
    const userId = Number(req.query?.userId || 0) || null;

    let w = `WHERE s.created_at BETWEEN ? AND ? AND COALESCE(s.fiscal_status,'emitida') <> 'cancelada'`;
    const p = [`${desde} 00:00:00`, `${hasta} 23:59:59`];
    const ef = scopedBranchId || branchId;
    if (ef) { w += ' AND COALESCE(s.billed_branch_id,s.branch_id)=?'; p.push(ef); }
    if (cajaId) { w += ' AND COALESCE(s.billed_cash_register_id,s.cash_register_id)=?'; p.push(cajaId); }
    if (userId) { w += ' AND s.billed_by_user_id=?'; p.push(userId); }

    const kpis = await query(`
      SELECT
        COUNT(*) AS total_facturas,
        COALESCE(SUM(s.total),0) AS total_ventas,
        COALESCE(SUM(s.tax),0) AS total_itbis,
        COALESCE(SUM(s.subtotal),0) AS total_subtotal,
        COALESCE(AVG(s.total),0) AS ticket_promedio,
        COALESCE(SUM(CASE WHEN s.payment_method='efectivo' THEN s.total ELSE 0 END),0) AS efectivo,
        COALESCE(SUM(CASE WHEN s.payment_method='tarjeta' THEN s.total ELSE 0 END),0) AS tarjeta,
        COALESCE(SUM(CASE WHEN s.payment_method='transferencia' THEN s.total ELSE 0 END),0) AS transferencia,
        COALESCE(SUM(CASE WHEN s.payment_method='credito' THEN s.total ELSE 0 END),0) AS credito,
        COALESCE(SUM(CASE WHEN s.payment_method='contra_entrega' THEN s.total ELSE 0 END),0) AS contra_entrega
      FROM sales s ${w}`, p);

    // costo estimado de lo vendido
    const costoRows = await query(`
      SELECT COALESCE(SUM(si.qty * COALESCE(p.precio_compra,0)),0) AS costo_total
      FROM sale_items si
      JOIN sales s ON si.sale_id=s.id
      JOIN products p ON si.product_id=p.id
      ${w.replace('WHERE s.','WHERE s.')}`, p);

    const costo = Number(costoRows[0]?.costo_total || 0);
    const ventas = Number(kpis[0]?.total_ventas || 0);
    const ganancia = ventas - costo;
    const margen = ventas > 0 ? ((ganancia / ventas) * 100).toFixed(1) : '0.0';

    res.json({ ...kpis[0], costo_total: costo, ganancia, margen, desde, hasta });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Ventas por día (tendencia) ───────────────────────────────
app.get('/api/reports/advanced/ventas-dia', async (req, res) => {
  try {
    const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    const scopedBranchId = getUserScopeBranchId(actorUser);
    const { desde, hasta } = getDefaultRange(req);
    const branchId = Number(req.query?.branchId || 0) || null;

    let w = `WHERE s.created_at BETWEEN ? AND ? AND COALESCE(s.fiscal_status,'emitida') <> 'cancelada'`;
    const p = [`${desde} 00:00:00`, `${hasta} 23:59:59`];
    const ef = scopedBranchId || branchId;
    if (ef) { w += ' AND COALESCE(s.billed_branch_id,s.branch_id)=?'; p.push(ef); }

    const rows = await query(`
      SELECT
        DATE(s.created_at) AS dia,
        COUNT(*) AS facturas,
        COALESCE(SUM(s.total),0) AS total,
        COALESCE(SUM(s.tax),0) AS itbis
      FROM sales s ${w}
      GROUP BY DATE(s.created_at)
      ORDER BY dia ASC`, p);

    res.json(rows.map(r => ({
      // Normalizar a string YYYY-MM-DD para evitar Invalid Date en el frontend
      dia: r.dia instanceof Date ? r.dia.toISOString().slice(0, 10) : String(r.dia || '').slice(0, 10),
      facturas: Number(r.facturas),
      total: Number(r.total),
      itbis: Number(r.itbis)
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Top productos vendidos ───────────────────────────────────
app.get('/api/reports/advanced/productos', async (req, res) => {
  try {
    const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    const scopedBranchId = getUserScopeBranchId(actorUser);
    const { desde, hasta } = getDefaultRange(req);
    const branchId = Number(req.query?.branchId || 0) || null;
    const limit = Math.min(Number(req.query?.limit || 20), 100);

    let w = `WHERE s.created_at BETWEEN ? AND ? AND COALESCE(s.fiscal_status,'emitida') <> 'cancelada'`;
    const p = [`${desde} 00:00:00`, `${hasta} 23:59:59`];
    const ef = scopedBranchId || branchId;
    if (ef) { w += ' AND COALESCE(s.billed_branch_id,s.branch_id)=?'; p.push(ef); }

    const rows = await query(`
      SELECT
        si.product_id,
        COALESCE(p.nombre, 'Producto') AS nombre,
        p.codigo,
        COALESCE(p.categoria, '') AS categoria,
        SUM(si.qty) AS cantidad,
        SUM(si.line_total) AS total_vendido,
        AVG(si.price) AS precio_promedio,
        COUNT(DISTINCT s.id) AS en_facturas
      FROM sale_items si
      JOIN sales s ON si.sale_id=s.id
      LEFT JOIN products p ON si.product_id=p.id
      ${w}
      GROUP BY si.product_id, nombre, p.codigo, p.categoria
      ORDER BY cantidad DESC
      LIMIT ?`, [...p, limit]);

    const totalQty = rows.reduce((s, r) => s + Number(r.cantidad || 0), 0);
    res.json(rows.map(r => ({
      productoId: r.product_id,
      nombre: r.nombre,
      codigo: r.codigo || '',
      categoria: r.categoria || '',
      cantidad: Number(r.cantidad),
      totalVendido: Number(r.total_vendido),
      precioPromedio: Number(r.precio_promedio),
      enFacturas: Number(r.en_facturas),
      participacion: totalQty > 0 ? ((Number(r.cantidad) / totalQty) * 100).toFixed(1) : '0.0'
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Top clientes ─────────────────────────────────────────────
app.get('/api/reports/advanced/clientes', async (req, res) => {
  try {
    const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    const scopedBranchId = getUserScopeBranchId(actorUser);
    const { desde, hasta } = getDefaultRange(req);

    let w = `WHERE s.created_at BETWEEN ? AND ? AND s.client_id IS NOT NULL AND COALESCE(s.fiscal_status,'emitida') <> 'cancelada'`;
    const p = [`${desde} 00:00:00`, `${hasta} 23:59:59`];
    if (scopedBranchId) { w += ' AND COALESCE(s.billed_branch_id,s.branch_id)=?'; p.push(scopedBranchId); }

    const rows = await query(`
      SELECT
        c.id, c.nombre, c.telefono, c.cedula, c.created_at,
        COALESCE(c.balance, 0) AS balance,
        COUNT(s.id) AS total_facturas,
        SUM(s.total) AS total_comprado,
        AVG(s.total) AS ticket_promedio,
        MAX(s.created_at) AS ultima_compra
      FROM sales s
      JOIN clients c ON s.client_id=c.id
      ${w}
      GROUP BY c.id, c.nombre, c.telefono, c.cedula, c.created_at, c.balance
      ORDER BY total_comprado DESC
      LIMIT 20`, p);

    res.json(rows.map(r => ({
      clienteId: r.id,
      nombre: r.nombre,
      telefono: r.telefono || '',
      cedula: r.cedula || '',
      balance: Number(r.balance || 0),
      createdAt: r.created_at,
      facturas: Number(r.total_facturas),
      totalComprado: Number(r.total_comprado),
      ticketPromedio: Number(r.ticket_promedio),
      ultimaCompra: r.ultima_compra
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Ventas por método de pago ────────────────────────────────
app.get('/api/reports/advanced/metodos-pago', async (req, res) => {
  try {
    const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    const scopedBranchId = getUserScopeBranchId(actorUser);
    const { desde, hasta } = getDefaultRange(req);
    const branchId = Number(req.query?.branchId || 0) || null;
    const cajaId  = Number(req.query?.cajaId   || 0) || null;
    const userId  = Number(req.query?.userId   || 0) || null;

    let w = `WHERE s.created_at BETWEEN ? AND ? AND COALESCE(s.fiscal_status,'emitida') <> 'cancelada'`;
    const p = [`${desde} 00:00:00`, `${hasta} 23:59:59`];
    const ef = scopedBranchId || branchId;
    if (ef)     { w += ' AND COALESCE(s.billed_branch_id,s.branch_id)=?'; p.push(ef); }
    if (cajaId) { w += ' AND COALESCE(s.billed_cash_register_id,s.cash_register_id)=?'; p.push(cajaId); }
    if (userId) { w += ' AND s.billed_by_user_id=?'; p.push(userId); }

    const rows = await query(`
      SELECT
        COALESCE(s.payment_method,'efectivo') AS metodo,
        COUNT(*) AS facturas,
        SUM(s.total) AS total
      FROM sales s ${w}
      GROUP BY metodo
      ORDER BY total DESC`, p);

    const totalGeneral = rows.reduce((s, r) => s + Number(r.total || 0), 0);
    res.json(rows.map(r => ({
      metodo: r.metodo,
      facturas: Number(r.facturas),
      total: Number(r.total),
      porcentaje: totalGeneral > 0 ? ((Number(r.total) / totalGeneral) * 100).toFixed(1) : '0.0'
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Ventas por usuario/cajero ────────────────────────────────
app.get('/api/reports/advanced/por-usuario', async (req, res) => {
  try {
    const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    const scopedBranchId = getUserScopeBranchId(actorUser);
    const { desde, hasta } = getDefaultRange(req);
    const branchId = Number(req.query?.branchId || 0) || null;

    let w = `WHERE s.created_at BETWEEN ? AND ? AND COALESCE(s.fiscal_status,'emitida') <> 'cancelada'`;
    const p = [`${desde} 00:00:00`, `${hasta} 23:59:59`];
    const ef = scopedBranchId || branchId;
    if (ef) { w += ' AND COALESCE(s.billed_branch_id,s.branch_id)=?'; p.push(ef); }

    const rows = await query(`
      SELECT
        u.id, COALESCE(u.nombre, u.usuario, 'Sin cajero') AS nombre, u.usuario,
        COUNT(s.id) AS facturas,
        SUM(s.total) AS total,
        AVG(s.total) AS ticket_promedio,
        COALESCE(SUM(s.tax),0) AS itbis
      FROM sales s
      LEFT JOIN users u ON s.billed_by_user_id=u.id
      ${w}
      GROUP BY u.id, nombre, u.usuario
      ORDER BY total DESC`, p);

    res.json(rows.map(r => ({
      usuarioId: r.id,
      nombre: r.nombre,
      usuario: r.usuario || '',
      facturas: Number(r.facturas),
      total: Number(r.total),
      ticketPromedio: Number(r.ticket_promedio),
      itbis: Number(r.itbis)
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Ventas por sucursal ──────────────────────────────────────
app.get('/api/reports/advanced/por-sucursal', async (req, res) => {
  try {
    const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    const scopedBranchId = getUserScopeBranchId(actorUser);
    const { desde, hasta } = getDefaultRange(req);
    const params = [
      `${desde} 00:00:00`,
      `${hasta} 23:59:59`,
      `${desde} 00:00:00`,
      `${hasta} 23:59:59`,
    ];
    const branchWhere = scopedBranchId
      ? 'WHERE b.estado <> "Eliminada" AND b.id = ?'
      : 'WHERE b.estado <> "Eliminada"';
    if (scopedBranchId) {
      params.push(scopedBranchId);
    }

    const rows = await query(`
      SELECT
        b.id, b.nombre AS sucursal, b.estado,
        COUNT(s.id) AS facturas,
        COALESCE(SUM(s.total),0) AS total,
        COALESCE(SUM(s.tax),0) AS itbis,
        COALESCE(AVG(s.total),0) AS ticket_promedio,
        COALESCE(eg.total_gastos, 0) AS total_gastos
      FROM branches b
      LEFT JOIN sales s
        ON COALESCE(s.billed_branch_id,s.branch_id)=b.id
       AND s.created_at BETWEEN ? AND ?
       AND COALESCE(s.fiscal_status,'emitida') <> 'cancelada'
      LEFT JOIN (
        SELECT branch_id, SUM(ABS(amount)) AS total_gastos
        FROM cash_movements
        WHERE happened_at BETWEEN ? AND ?
          AND movement_type IN ('Gasto', 'Pago suplidor', 'Devolución', 'Retiro de efectivo', 'Egreso', 'salida', 'gasto', 'expense')
        GROUP BY branch_id
      ) eg ON eg.branch_id = b.id
      ${branchWhere}
      GROUP BY b.id, b.nombre, b.estado, eg.total_gastos
      ORDER BY total DESC, b.nombre ASC`, params);

    res.json(rows.map(r => ({
      sucursalId: r.id,
      sucursal: r.sucursal,
      estado: r.estado || 'Activa',
      facturas: Number(r.facturas),
      total: Number(r.total),
      itbis: Number(r.itbis),
      ticketPromedio: Number(r.ticket_promedio),
      totalGastos: Number(r.total_gastos || 0)
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Ganancias ────────────────────────────────────────────────
app.get('/api/reports/advanced/ganancias', async (req, res) => {
  try {
    const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    const scopedBranchId = getUserScopeBranchId(actorUser);
    const { desde, hasta } = getDefaultRange(req);

    let where = `WHERE s.created_at BETWEEN ? AND ? AND COALESCE(s.fiscal_status,'emitida') <> 'cancelada'`;
    const baseParams = [`${desde} 00:00:00`, `${hasta} 23:59:59`];
    if (scopedBranchId) {
      where += ' AND COALESCE(s.billed_branch_id,s.branch_id)=?';
      baseParams.push(scopedBranchId);
    }

    const [summaryRows, categoryRows, branchRows, productRows] = await Promise.all([
      query(`
        SELECT
          COALESCE(SUM(s.total),0) AS revenue,
          COALESCE(SUM((si.qty * si.price) - (si.qty * COALESCE(p.precio_compra,0))),0) AS profit
        FROM sales s
        INNER JOIN sale_items si ON si.sale_id = s.id
        LEFT JOIN products p ON p.id = si.product_id
        ${where}`, [...baseParams]),
      query(`
        SELECT
          COALESCE(p.categoria, 'Sin categoría') AS categoria,
          COALESCE(SUM((si.qty * si.price) - (si.qty * COALESCE(p.precio_compra,0))),0) AS profit
        FROM sales s
        INNER JOIN sale_items si ON si.sale_id = s.id
        LEFT JOIN products p ON p.id = si.product_id
        ${where}
        GROUP BY categoria
        ORDER BY profit DESC`, [...baseParams]),
      query(`
        SELECT
          COALESCE(b.nombre, 'Sin sucursal') AS sucursal,
          COALESCE(SUM((si.qty * si.price) - (si.qty * COALESCE(p.precio_compra,0))),0) AS profit
        FROM sales s
        INNER JOIN sale_items si ON si.sale_id = s.id
        LEFT JOIN products p ON p.id = si.product_id
        LEFT JOIN branches b ON b.id = COALESCE(s.billed_branch_id, s.branch_id)
        ${where}
        GROUP BY sucursal
        ORDER BY profit DESC`, [...baseParams]),
      query(`
        SELECT
          COALESCE(si.product_id, 0) AS product_id,
          COALESCE(p.nombre, 'Producto') AS nombre,
          COALESCE(p.categoria, 'Sin categoría') AS categoria,
          COALESCE(SUM(si.line_total),0) AS revenue,
          COALESCE(SUM((si.qty * si.price) - (si.qty * COALESCE(p.precio_compra,0))),0) AS profit,
          COALESCE(SUM(si.qty),0) AS quantity
        FROM sales s
        INNER JOIN sale_items si ON si.sale_id = s.id
        LEFT JOIN products p ON p.id = si.product_id
        ${where}
        GROUP BY si.product_id, nombre, categoria
        ORDER BY profit DESC
        LIMIT 8`, [...baseParams]),
    ]);

    const revenue = Number(summaryRows[0]?.revenue || 0);
    const profit = Number(summaryRows[0]?.profit || 0);

    res.json({
      revenue,
      profit,
      marginPercent: revenue > 0 ? (profit / revenue) * 100 : 0,
      categoryProfit: categoryRows.map((row) => ({
        categoria: row.categoria,
        profit: Number(row.profit || 0),
      })),
      branchProfit: branchRows.map((row) => ({
        sucursal: row.sucursal,
        profit: Number(row.profit || 0),
      })),
      topProducts: productRows.map((row) => ({
        productoId: Number(row.product_id || 0),
        nombre: row.nombre,
        categoria: row.categoria,
        revenue: Number(row.revenue || 0),
        profit: Number(row.profit || 0),
        quantity: Number(row.quantity || 0),
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Ventas por caja ──────────────────────────────────────────
app.get('/api/reports/advanced/por-caja', async (req, res) => {
  try {
    const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    const scopedBranchId = getUserScopeBranchId(actorUser);
    const { desde, hasta } = getDefaultRange(req);
    const branchId = Number(req.query?.branchId || 0) || scopedBranchId;

    let w = `WHERE s.created_at BETWEEN ? AND ? AND COALESCE(s.fiscal_status,'emitida') <> 'cancelada'`;
    const p = [`${desde} 00:00:00`, `${hasta} 23:59:59`];
    if (branchId) { w += ' AND COALESCE(s.billed_branch_id,s.branch_id)=?'; p.push(branchId); }

    const rows = await query(`
      SELECT
        cr.id, cr.nombre AS caja,
        b.nombre AS sucursal,
        COUNT(s.id) AS facturas,
        COALESCE(SUM(s.total),0) AS total,
        COALESCE(SUM(s.tax),0) AS itbis,
        COALESCE(AVG(s.total),0) AS ticket_promedio
      FROM sales s
      JOIN cash_registers cr ON COALESCE(s.billed_cash_register_id,s.cash_register_id)=cr.id
      JOIN branches b ON COALESCE(s.billed_branch_id,s.branch_id)=b.id
      ${w}
      GROUP BY cr.id, cr.nombre, b.nombre
      ORDER BY total DESC`, p);

    res.json(rows.map(r => ({
      cajaId: r.id,
      caja: r.caja,
      sucursal: r.sucursal,
      facturas: Number(r.facturas),
      total: Number(r.total),
      itbis: Number(r.itbis),
      ticketPromedio: Number(r.ticket_promedio)
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Detalle de facturas ──────────────────────────────────────
app.get('/api/reports/advanced/facturas', async (req, res) => {
  try {
    const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    const scopedBranchId = getUserScopeBranchId(actorUser);
    const { desde, hasta } = getDefaultRange(req);
    const branchId = Number(req.query?.branchId || 0) || null;
    const cajaId = Number(req.query?.cajaId || 0) || null;
    const userId = Number(req.query?.userId || 0) || null;
    const metodo = String(req.query?.metodo || '').trim() || null;
    const page = Math.max(1, Number(req.query?.page || 1));
    const limit = Math.min(Number(req.query?.limit || 50), 200);
    const offset = (page - 1) * limit;

    let w = `WHERE s.created_at BETWEEN ? AND ?`;
    const p = [`${desde} 00:00:00`, `${hasta} 23:59:59`];
    const ef = scopedBranchId || branchId;
    if (ef) { w += ' AND COALESCE(s.billed_branch_id,s.branch_id)=?'; p.push(ef); }
    if (cajaId) { w += ' AND COALESCE(s.billed_cash_register_id,s.cash_register_id)=?'; p.push(cajaId); }
    if (userId) { w += ' AND s.billed_by_user_id=?'; p.push(userId); }
    if (metodo) { w += ' AND s.payment_method=?'; p.push(metodo); }

    const countRows = await query(`SELECT COUNT(*) AS total_count FROM sales s ${w}`, p);
    const total_count = Number(countRows[0]?.total_count || 0);

    const rows = await query(`
      SELECT
        s.id, s.invoice_number, s.ncf,
        COALESCE(s.fiscal_status,'emitida') AS estado,
        s.created_at,
        COALESCE(c.nombre, s.client_name_snapshot, '') AS cliente,
        COALESCE(u.nombre, u.usuario, '') AS cajero,
        b.nombre AS sucursal,
        cr.nombre AS caja,
        s.payment_method AS metodo,
        s.subtotal, s.discount AS discount_amount, s.tax AS itbis_amount, s.total,
        s.order_type
      FROM sales s
      LEFT JOIN clients c ON s.client_id=c.id
      LEFT JOIN users u ON s.billed_by_user_id=u.id
      LEFT JOIN branches b ON COALESCE(s.billed_branch_id,s.branch_id)=b.id
      LEFT JOIN cash_registers cr ON COALESCE(s.billed_cash_register_id,s.cash_register_id)=cr.id
      ${w}
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?`, [...p, limit, offset]);

    res.json({
      total: Number(total_count),
      page, limit,
      pages: Math.ceil(Number(total_count) / limit),
      rows: rows.map(r => ({
        id: r.id,
        factura: r.invoice_number || `#${r.id}`,
        ncf: r.ncf || '',
        estado: r.estado,
        fecha: r.created_at,
        cliente: r.cliente,
        cajero: r.cajero,
        sucursal: r.sucursal || '',
        caja: r.caja || '',
        metodo: r.metodo || 'efectivo',
        subtotal: Number(r.subtotal || 0),
        descuento: Number(r.discount_amount || 0),
        itbis: Number(r.itbis_amount || 0),
        total: Number(r.total || 0),
        tipoPedido: r.order_type || ''
      }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Devoluciones / cancelaciones ────────────────────────────
app.get('/api/reports/advanced/devoluciones', async (req, res) => {
  try {
    const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    const scopedBranchId = getUserScopeBranchId(actorUser);
    const { desde, hasta } = getDefaultRange(req);
    await ensureReturnTables();

    // ── Parte 1: devoluciones del sistema sale_returns (parciales y totales) ──
    let w1 = `WHERE sr.returned_at BETWEEN ? AND ?`;
    const p1 = [`${desde} 00:00:00`, `${hasta} 23:59:59`];
    if (scopedBranchId) { w1 += ' AND sr.branch_id = ?'; p1.push(scopedBranchId); }

    const returnRows = await query(`
      SELECT
        sr.id,
        sr.original_invoice_number  AS invoice_number,
        sr.returned_at              AS created_at,
        COALESCE(c.nombre, s.client_name_snapshot, '') AS cliente,
        COALESCE(sr.returned_by_user_name, u.nombre, u.usuario, 'Sistema') AS cajero,
        COALESCE(s.payment_method, 'efectivo') AS payment_method,
        COALESCE(s.tax, 0)          AS itbis_amount,
        sr.total_returned           AS total,
        sr.return_type,
        sr.return_reason,
        'devolucion'                AS tipo_registro
      FROM sale_returns sr
      LEFT JOIN sales   s ON s.id = sr.original_sale_id
      LEFT JOIN clients c ON s.client_id = c.id
      LEFT JOIN users   u ON sr.returned_by_user_id = u.id
      ${w1}
      ORDER BY sr.returned_at DESC`, p1);

    // ── Parte 2: anulaciones antiguas sin registro en sale_returns ──
    let w2 = `WHERE s.created_at BETWEEN ? AND ?
              AND COALESCE(s.fiscal_status,'emitida') = 'cancelada'
              AND s.id NOT IN (
                SELECT COALESCE(original_sale_id,0) FROM sale_returns WHERE original_sale_id IS NOT NULL
              )`;
    const p2 = [`${desde} 00:00:00`, `${hasta} 23:59:59`];
    if (scopedBranchId) { w2 += ' AND COALESCE(s.billed_branch_id,s.branch_id)=?'; p2.push(scopedBranchId); }

    const cancelRows = await query(`
      SELECT
        s.id, s.invoice_number, s.created_at,
        COALESCE(c.nombre, s.client_name_snapshot, '') AS cliente,
        COALESCE(u.nombre, u.usuario, '')              AS cajero,
        s.total, COALESCE(s.tax, 0) AS itbis_amount, s.payment_method,
        'total'      AS return_type,
        'Anulación'  AS return_reason,
        'anulacion'  AS tipo_registro
      FROM sales s
      LEFT JOIN clients c ON s.client_id = c.id
      LEFT JOIN users   u ON s.billed_by_user_id = u.id
      ${w2}
      ORDER BY s.created_at DESC`, p2);

    const allRows = [...returnRows, ...cancelRows]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const totalCancelado = allRows.reduce((s, r) => s + Number(r.total || 0), 0);

    res.json({
      total: allRows.length,
      totalCancelado,
      rows: allRows.map(r => ({
        id:             r.id,
        factura:        r.invoice_number || `#${r.id}`,
        fecha:          r.created_at,
        cliente:        r.cliente || '—',
        cajero:         r.cajero  || '—',
        metodo:         r.payment_method || 'efectivo',
        itbis:          Number(r.itbis_amount || 0),
        total:          Number(r.total || 0),
        tipo:           r.return_type   || 'total',
        motivo:         r.return_reason || '',
        tipoRegistro:   r.tipo_registro || 'devolucion'
      }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Reporte DGII (fiscal) ────────────────────────────────────
app.get('/api/reports/advanced/dgii', async (req, res) => {
  try {
    const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    const scopedBranchId = getUserScopeBranchId(actorUser);
    const { desde, hasta } = getDefaultRange(req);
    const branchId = Number(req.query?.branchId || 0) || null;

    let w = `WHERE s.created_at BETWEEN ? AND ? AND COALESCE(s.fiscal_status,'emitida') <> 'cancelada'`;
    const p = [`${desde} 00:00:00`, `${hasta} 23:59:59`];
    const ef = scopedBranchId || branchId;
    if (ef) { w += ' AND COALESCE(s.billed_branch_id,s.branch_id)=?'; p.push(ef); }

    // Totales por tipo de NCF
    const resumen = await query(`
      SELECT
        COUNT(*) AS total_facturas,
        COALESCE(SUM(s.total),0) AS total_facturado,
        COALESCE(SUM(s.tax),0) AS itbis_cobrado,
        COALESCE(SUM(CASE WHEN COALESCE(s.tax,0)>0 THEN s.subtotal ELSE 0 END),0) AS monto_gravado,
        COALESCE(SUM(CASE WHEN COALESCE(s.tax,0)=0 THEN s.total ELSE 0 END),0) AS monto_exento
      FROM sales s ${w}`, p);

    const porNcf = await query(`
      SELECT
        CASE
          WHEN s.ncf LIKE 'B01%' THEN 'B01'
          WHEN s.ncf LIKE 'B02%' THEN 'B02'
          WHEN s.ncf LIKE 'B14%' THEN 'B14'
          WHEN s.ncf IS NOT NULL AND s.ncf <> '' THEN 'Otro'
          ELSE 'Sin NCF'
        END AS tipo_ncf,
        COUNT(*) AS facturas,
        COALESCE(SUM(s.total),0) AS total,
        COALESCE(SUM(s.tax),0) AS itbis
      FROM sales s ${w}
      GROUP BY tipo_ncf
      ORDER BY facturas DESC`, p);

    // ITBIS crédito fiscal (facturas de proveedores pagadas en el período)
    const creditoFiscalRows = await query(`
      SELECT COALESCE(SUM(itbis_amount),0) AS itbis_credito
      FROM supplier_invoices
      WHERE created_at BETWEEN ? AND ? AND status <> 'cancelada'`,
      [`${desde} 00:00:00`, `${hasta} 23:59:59`]).catch(() => [{ itbis_credito: 0 }]);

    const itbisCobrado = Number(resumen[0]?.itbis_cobrado || 0);
    const itbisCredito = Number(creditoFiscalRows[0]?.itbis_credito || 0);
    const itbisPagar = Math.max(0, itbisCobrado - itbisCredito);

    res.json({
      desde, hasta,
      totalFacturas: Number(resumen[0]?.total_facturas || 0),
      totalFacturado: Number(resumen[0]?.total_facturado || 0),
      montoGravado: Number(resumen[0]?.monto_gravado || 0),
      montoExento: Number(resumen[0]?.monto_exento || 0),
      itbisCobrado,
      itbisCredito,
      itbisPagar,
      porNcf: porNcf.map(r => ({
        tipoNcf: r.tipo_ncf,
        facturas: Number(r.facturas),
        total: Number(r.total),
        itbis: Number(r.itbis)
      }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Gastos / egresos ────────────────────────────────────────
app.get('/api/reports/advanced/gastos', async (req, res) => {
  try {
    const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    const scopedBranchId = getUserScopeBranchId(actorUser);
    const { desde, hasta } = getDefaultRange(req);

    let where = `WHERE cm.happened_at BETWEEN ? AND ?`;
    const params = [`${desde} 00:00:00`, `${hasta} 23:59:59`];
    if (scopedBranchId) {
      where += ' AND cm.branch_id = ?';
      params.push(scopedBranchId);
    }

    const rows = await query(`
      SELECT
        cm.id,
        cm.movement_type,
        cm.amount,
        cm.notes,
        cm.created_by_user_name,
        cm.happened_at,
        cm.branch_id,
        b.nombre AS branch_name
      FROM cash_movements cm
      LEFT JOIN branches b ON b.id = cm.branch_id
      ${where}
        AND cm.movement_type IN ('Gasto', 'Pago suplidor', 'Devolución', 'Retiro de efectivo', 'Egreso', 'salida', 'gasto', 'expense')
      ORDER BY cm.happened_at DESC, cm.id DESC
      LIMIT 250`, params);

    res.json(rows.map((row) => ({
      id: Number(row.id || 0),
      categoria: row.movement_type || 'Gasto',
      descripcion: row.notes || '',
      amount: Math.abs(Number(row.amount || 0)),
      branchId: row.branch_id === null || row.branch_id === undefined ? null : Number(row.branch_id),
      branchName: row.branch_name || '',
      createdBy: row.created_by_user_name || 'Sistema',
      createdAt: row.happened_at,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function buildAccountsReceivableReportData(scopedBranchId) {
  let where = `WHERE s.payment_method = 'credito'
    AND COALESCE(s.fiscal_status, 'emitida') <> 'cancelada'
    AND COALESCE(s.total, 0) > COALESCE(s.received_amount, 0)`;
  const params = [];
  if (scopedBranchId) {
    where += ' AND COALESCE(s.billed_branch_id, s.branch_id) = ?';
    params.push(scopedBranchId);
  }

  const rows = await query(`
    SELECT
      s.id,
      s.created_at,
      s.total,
      COALESCE(s.received_amount, 0) AS paid_amount,
      s.invoice_number,
      c.id AS client_id,
      COALESCE(c.nombre, s.client_name_snapshot, 'Cliente') AS customer_name,
      COALESCE(c.balance, 0) AS client_balance,
      b.id AS branch_id,
      b.nombre AS branch_name
    FROM sales s
    LEFT JOIN clients c ON c.id = s.client_id
    LEFT JOIN branches b ON b.id = COALESCE(s.billed_branch_id, s.branch_id)
    ${where}
    ORDER BY s.created_at DESC, s.id DESC`, params);

  const mappedRows = rows.map((row) => ({
    id: Number(row.id || 0),
    invoiceNumber: row.invoice_number || '',
    customerId: row.client_id === null || row.client_id === undefined ? null : Number(row.client_id),
    customerName: row.customer_name || 'Cliente',
    branchId: row.branch_id === null || row.branch_id === undefined ? null : Number(row.branch_id),
    branchName: row.branch_name || '',
    total: Number(row.total || 0),
    paid: Number(row.paid_amount || 0),
    balance: Math.max(0, Number(row.total || 0) - Number(row.paid_amount || 0)),
    createdAt: row.created_at,
  }));

  const topDebtorsMap = new Map();
  for (const row of mappedRows) {
    const customerId = Number(row.customerId || 0);
    const key = customerId || `tmp-${row.customerName}`;
    const current = topDebtorsMap.get(key) || {
      clienteId: customerId || null,
      customerName: row.customerName || 'Cliente',
      branchName: row.branchName || '',
      balance: 0,
      invoices: 0,
      createdAt: row.createdAt,
    };
    current.balance += row.balance;
    current.invoices += 1;
    topDebtorsMap.set(key, current);
  }

  const topDebtors = [...topDebtorsMap.values()].sort(
    (a, b) => b.balance - a.balance
  );

  return {
    rows: mappedRows,
    topDebtors: topDebtors.slice(0, 20),
    payments: [],
    totalPending: mappedRows.reduce((sum, row) => sum + row.balance, 0),
    overdueCount: 0,
    totalCount: mappedRows.length,
    scopeBranchId: scopedBranchId || null,
  };
}

async function buildAccountsPayableReportData() {
  const rows = await query(`
    SELECT
      si.*,
      s.nombre AS supplier_name
    FROM supplier_invoices si
    LEFT JOIN suppliers s ON s.id = si.supplier_id
    WHERE COALESCE(si.pending_amount, 0) > 0
    ORDER BY COALESCE(si.due_at, si.issued_at) ASC, si.id DESC
    LIMIT 300
  `);

  const todayIso = new Date().toISOString().slice(0, 10);
  const mappedRows = rows.map((row) => {
    const mapped = mapSupplierInvoiceRow(row);
    const dueAt = mapped.fechaVencimiento || null;
    return {
      ...mapped,
      overdue: Boolean(dueAt && dueAt < todayIso && Number(mapped.montoPendiente || 0) > 0),
    };
  });

  const topSuppliersMap = new Map();
  for (const row of mappedRows) {
    const supplierId = Number(row.supplierId || 0);
    const key = supplierId || `tmp-${row.proveedor}`;
    const current = topSuppliersMap.get(key) || {
      supplierId: supplierId || null,
      supplierName: row.proveedor || 'Suplidor',
      pending: 0,
      invoices: 0,
      dueDate: row.fechaVencimiento || row.fechaEmision || null,
    };
    current.pending += Number(row.montoPendiente || 0);
    current.invoices += 1;
    if (!current.dueDate && (row.fechaVencimiento || row.fechaEmision)) {
      current.dueDate = row.fechaVencimiento || row.fechaEmision;
    }
    topSuppliersMap.set(key, current);
  }

  const topSuppliers = [...topSuppliersMap.values()].sort(
    (a, b) => b.pending - a.pending
  );

  return {
    rows: mappedRows,
    topSuppliers: topSuppliers.slice(0, 20),
    totalPending: mappedRows.reduce(
      (sum, row) => sum + Number(row.montoPendiente || 0),
      0
    ),
    overdueCount: mappedRows.filter((row) => row.overdue).length,
    totalCount: mappedRows.length,
    scopedByBranch: false,
  };
}

// ── Cuentas por cobrar ──────────────────────────────────────
app.get('/api/reports/advanced/cuentas-cobrar', async (req, res) => {
  try {
    const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    const scopedBranchId = getUserScopeBranchId(actorUser);
    res.json(await buildAccountsReceivableReportData(scopedBranchId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/advanced/cuentas-pagar-cobrar', async (req, res) => {
  try {
    const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    const scopedBranchId = getUserScopeBranchId(actorUser);
    const [receivables, payables] = await Promise.all([
      buildAccountsReceivableReportData(scopedBranchId),
      buildAccountsPayableReportData(),
    ]);

    res.json({
      receivables,
      payables,
      summary: {
        totalReceivable: Number(receivables.totalPending || 0),
        totalPayable: Number(payables.totalPending || 0),
        netBalance: Number(receivables.totalPending || 0) - Number(payables.totalPending || 0),
      },
      scope: {
        branchId: scopedBranchId || null,
        payablesScopedByBranch: false,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Lista de sucursales y cajas para filtros ─────────────────
app.get('/api/reports/advanced/filtros', async (req, res) => {
  try {
    const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    const scopedBranchId = getUserScopeBranchId(actorUser);

    let bWhere = scopedBranchId ? 'WHERE id=?' : '';
    const bParams = scopedBranchId ? [scopedBranchId] : [];
    const sucursales = await query(`SELECT id, nombre FROM branches ${bWhere} ORDER BY nombre`, bParams);

    let crWhere = 'WHERE 1=1';
    const crParams = [];
    if (scopedBranchId) { crWhere += ' AND branch_id=?'; crParams.push(scopedBranchId); }
    const cajas = await query(`SELECT id, nombre, branch_id FROM cash_registers ${crWhere} ORDER BY nombre`, crParams);

    const usuarios = await query(`SELECT id, nombre, usuario FROM users WHERE estado='Activo' ORDER BY nombre`);

    res.json({ sucursales, cajas, usuarios });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Guardar reporte diario en carpeta ───────────────────────
app.post('/api/reports/auto-save-daily', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const p = [`${today} 00:00:00`, `${today} 23:59:59`];

    const [kpisRows, porSucursalRows, porMetodoRows] = await Promise.all([
      query(`SELECT COUNT(*) AS total_facturas, COALESCE(SUM(total),0) AS total_ventas,
             COALESCE(SUM(tax),0) AS total_itbis, COALESCE(AVG(total),0) AS ticket_promedio,
             COALESCE(SUM(CASE WHEN payment_method='efectivo' THEN total ELSE 0 END),0) AS efectivo,
             COALESCE(SUM(CASE WHEN payment_method='tarjeta' THEN total ELSE 0 END),0) AS tarjeta,
             COALESCE(SUM(CASE WHEN payment_method='transferencia' THEN total ELSE 0 END),0) AS transferencia
             FROM sales WHERE created_at BETWEEN ? AND ? AND COALESCE(fiscal_status,'emitida') <> 'cancelada'`, p),
      query(`SELECT b.nombre AS sucursal, COUNT(s.id) AS facturas, COALESCE(SUM(s.total),0) AS total
             FROM sales s JOIN branches b ON COALESCE(s.billed_branch_id,s.branch_id)=b.id
             WHERE s.created_at BETWEEN ? AND ? AND COALESCE(s.fiscal_status,'emitida') <> 'cancelada'
             GROUP BY b.id, b.nombre ORDER BY total DESC`, p),
      query(`SELECT COALESCE(payment_method,'efectivo') AS metodo, COUNT(*) AS facturas, COALESCE(SUM(total),0) AS total
             FROM sales WHERE created_at BETWEEN ? AND ? AND COALESCE(fiscal_status,'emitida') <> 'cancelada'
             GROUP BY metodo ORDER BY total DESC`, p)
    ]);

    const monthStr = today.slice(0, 7);
    const reportsDir = path.join(runtime.userDataPath, 'reportes', monthStr);
    fs.mkdirSync(reportsDir, { recursive: true });
    const filePath = path.join(reportsDir, `reporte-${today}.json`);

    const report = {
      fecha: today,
      generadoEn: new Date().toISOString(),
      kpis: kpisRows[0] || {},
      porSucursal: porSucursalRows,
      porMetodo: porMetodoRows
    };

    fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8');
    res.json({ ok: true, filePath });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  NCF / COMPROBANTES FISCALES
// ══════════════════════════════════════════════════════════

// GET  /api/ncf/sequences  — listar secuencias
app.get('/api/ncf/sequences', async (req, res) => {
  try {
    await ensureNcfExtensions();
    const actorUser = await resolveRequestActorUser(req, { required: true });
    if (!isGlobalAdministratorUser(actorUser) && !isBranchAdministratorUser(actorUser) && !userRoleHasPermission(actorUser, 'gestionar_configuracion_fiscal', 'fiscal.sequence.view', 'fiscal.config.view')) return res.status(403).json({ error: 'Sin permiso para ver secuencias fiscales.' });
    const rows = await query(
      `SELECT ns.*, b.nombre AS branch_name
       FROM ncf_sequences ns
       LEFT JOIN branches b ON b.id = ns.branch_id
       ORDER BY ns.ncf_type, ns.branch_id`
    );
    res.json(rows.map(r => ({
      id: r.id, ncfType: r.ncf_type, branchId: r.branch_id, branchName: r.branch_name || 'Global',
      siguienteNumero: r.siguiente_numero, maximo: r.maximo, activa: !!r.activa,
      label: NCF_LABELS[r.ncf_type] || r.ncf_type
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ncf/sequences  — crear o actualizar secuencia
app.post('/api/ncf/sequences', async (req, res) => {
  try {
    await ensureNcfExtensions();
    const actorUser = await resolveRequestActorUser(req, { required: true });
    if (!isGlobalAdministratorUser(actorUser) && !isBranchAdministratorUser(actorUser) && !userRoleHasPermission(actorUser, 'gestionar_configuracion_fiscal', 'fiscal.sequence.create', 'fiscal.config.edit')) return res.status(403).json({ error: 'Sin permiso para crear secuencias fiscales.' });
    const { ncfType, branchId, siguienteNumero, maximo, activa, id } = req.body;
    const validTypes = ['B01', 'B02', 'B03', 'B04', 'B14', 'B15'];
    if (!validTypes.includes(ncfType)) return res.status(400).json({ error: 'Tipo de NCF inválido.' });
    const desde = Math.max(1, Number(siguienteNumero) || 1);
    const hasta = Math.max(desde, Number(maximo) || 99999999);
    const isActiva = activa !== false && activa !== 0 ? 1 : 0;
    const branchIdVal = branchId ? Number(branchId) : null;
    if (id) {
      await query(
        'UPDATE ncf_sequences SET ncf_type=?, branch_id=?, siguiente_numero=?, maximo=?, activa=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
        [ncfType, branchIdVal, desde, hasta, isActiva, id]
      );
    } else {
      await query(
        'INSERT INTO ncf_sequences (ncf_type, branch_id, siguiente_numero, maximo, activa) VALUES (?,?,?,?,?)',
        [ncfType, branchIdVal, desde, hasta, isActiva]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/ncf/sequences/:id  — desactivar secuencia (nunca borrar si fue usada)
app.delete('/api/ncf/sequences/:id', async (req, res) => {
  try {
    const actorUser = await resolveRequestActorUser(req, { required: true });
    if (!isGlobalAdministratorUser(actorUser) && !isBranchAdministratorUser(actorUser) && !userRoleHasPermission(actorUser, 'gestionar_configuracion_fiscal', 'fiscal.sequence.disable')) return res.status(403).json({ error: 'Sin permiso para desactivar secuencias fiscales.' });
    // Si la secuencia ya fue usada (siguiente_numero > desde original), solo desactivar
    const seqs = await query('SELECT * FROM ncf_sequences WHERE id = ?', [req.params.id]);
    if (!seqs[0]) return res.status(404).json({ error: 'Secuencia no encontrada.' });
    const seq = seqs[0];
    if (seq.siguiente_numero > 1) {
      await query('UPDATE ncf_sequences SET activa = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [req.params.id]);
      return res.json({ ok: true, action: 'deactivated', msg: 'Secuencia desactivada (ya fue utilizada, no se puede eliminar).' });
    }
    await query('DELETE FROM ncf_sequences WHERE id = ?', [req.params.id]);
    res.json({ ok: true, action: 'deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ncf/preview/:type  — previsualizar próximo NCF sin consumirlo
app.get('/api/ncf/preview/:type', async (req, res) => {
  try {
    await ensureNcfExtensions();
    await resolveRequestActorUser(req, { required: true });
    const ncfType = req.params.type.toUpperCase();
    const branchId = req.query.branchId ? Number(req.query.branchId) : null;
    const seqs = await query(
      `SELECT * FROM ncf_sequences WHERE ncf_type = ? AND activa = 1
       AND (branch_id = ? OR branch_id IS NULL)
       ORDER BY branch_id DESC LIMIT 1`,
      [ncfType, branchId]
    );
    if (!seqs[0]) return res.json({ ncf: null, disponible: false, mensaje: `Sin secuencia ${ncfType}` });
    const seq = seqs[0];
    const disponible = seq.siguiente_numero <= seq.maximo;
    const ncf = disponible ? `${ncfType}${String(seq.siguiente_numero).padStart(8, '0')}` : null;
    res.json({ ncf, disponible, siguiente: seq.siguiente_numero, maximo: seq.maximo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ncf/search-facturas  — buscar facturas para referencia en B03/B04
app.get('/api/ncf/search-facturas', async (req, res) => {
  try {
    await ensureNcfExtensions();
    await resolveRequestActorUser(req, { required: true });
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const rows = await query(
      `SELECT s.id, s.invoice_number, s.ncf, s.total, s.created_at,
              s.client_name_snapshot, s.ncf_type, s.fiscal_status
       FROM sales s
       WHERE s.fiscal_status = 'emitida'
         AND s.ncf_type NOT IN ('B03','B04')
         AND (s.invoice_number LIKE ? OR s.ncf LIKE ? OR s.client_name_snapshot LIKE ?)
       ORDER BY s.created_at DESC LIMIT 20`,
      [`%${q}%`, `%${q}%`, `%${q}%`]
    );
    res.json(rows.map(r => ({
      id: r.id,
      invoiceNumber: r.invoice_number,
      ncf: r.ncf || '',
      ncfType: r.ncf_type || '',
      total: r.total,
      cliente: r.client_name_snapshot || 'Consumidor Final',
      fecha: r.created_at,
      estadoFiscal: r.fiscal_status
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Nota: /api/health ya está definido arriba con try/catch completo.
// Este bloque duplicado fue eliminado para evitar shadowing del handler principal.

registerMobilePos({
  app,
  io,
  query,
  withTransaction,
  getConfig,
  writeAuditLog,
  saveLatestSecureBackup,
  syncPosAccountsToFirebase: trySyncAllPosAccountsToFirebase,
  getFirebaseConfigStatus,
  verifyFirebaseIdToken
});

app.use((err, _req, res, _next) => {
  console.error(err);
  const isMissingTableError = /no such table/i.test(String(err?.message || ''));
  res.status(err.statusCode || 500).json({
    error: isMissingTableError
      ? 'La base de datos no está inicializada. Ejecuta el script db/schema.sql.'
      : err.message || 'Error interno del servidor.'
  });
});

async function inspectCoreSchema() {
  const client = getDbClient();
  let rows;
  if (client === 'mysql') {
    const tableRows = await query('SHOW TABLES');
    rows = [];
    for (const tableRow of tableRows) {
      const tableName = Object.values(tableRow || {})[0];
      if (!tableName) continue;
      const createRows = await query(`SHOW CREATE TABLE \`${tableName}\``);
      const createRow = createRows[0] || {};
      rows.push({
        name: tableName,
        sql: createRow['Create Table'] || createRow['Create View'] || ''
      });
    }
  } else {
    rows = await query("SELECT name, sql FROM sqlite_master WHERE type = 'table'");
  }
  const tableMap = new Map(
    rows
      .map((row) => [String(row.name || '').trim().toLowerCase(), String(row.sql || '')])
      .filter(([name]) => Boolean(name))
  );
  const tables = new Set(tableMap.keys());
  const requiredTables = ['config', 'users', 'products', 'clients', 'sales', 'sale_items'];
  const missingTables = requiredTables.filter((tableName) => !tables.has(tableName));
  const autoIncrementTables = [
    'users',
    'categories',
    'products',
    'clients',
    'suppliers',
    'supplier_invoices',
    'cash_sessions',
    'cash_movements',
    'audit_logs',
    'inventory_movements',
    'sales',
    'sale_items',
    'mobile_session_items'
  ];
  const invalidPrimaryKeyTables = autoIncrementTables.filter((tableName) => {
    const sql = String(tableMap.get(tableName) || '');
    return /\bid INT\s+PRIMARY KEY\b/i.test(sql) || /\bid\s+INT\s+PRIMARY KEY\b/i.test(sql);
  });
  return {
    tables,
    missingTables,
    invalidPrimaryKeyTables,
    hasRequiredTables: missingTables.length === 0 && invalidPrimaryKeyTables.length === 0
  };
}

function moveBrokenDatabaseAside(dbFile) {
  if (!fs.existsSync(dbFile)) return null;
  const parsed = path.parse(dbFile);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(parsed.dir, `${parsed.name}.broken-${timestamp}${parsed.ext || '.db'}`);
  fs.renameSync(dbFile, backupPath);
  return backupPath;
}

function isBrokenDatabaseError(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('file is not a database') || message.includes('malformed') || message.includes('not a database');
}

function isUnknownDatabaseError(error) {
  if (!error) return false;
  const code = String(error.code || '').toUpperCase();
  const errno = Number(error.errno || 0);
  const message = String(error.message || '').toLowerCase();
  return (
    code === 'ER_BAD_DB_ERROR' ||
    errno === 1049 ||
    message.includes('unknown database')
  );
}

/**
 * Detecta errores de conexión transitorios que ocurren cuando MariaDB
 * abre el puerto TCP pero todavía no está lista para aceptar queries
 * (ventana de ~500ms–2s durante el arranque inicial).
 */
function isTransientConnectionError(error) {
  if (!error) return false;
  const code = String(error.code || '').toUpperCase();
  const message = String(error.message || '').toLowerCase();
  return (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    code === 'PROTOCOL_CONNECTION_LOST' ||
    message.includes('econnreset') ||
    message.includes('connection lost') ||
    message.includes('connection refused') ||
    message.includes('read econnreset')
  );
}

/**
 * Ejecuta `fn` con reintentos automáticos cuando el error es transitorio
 * (ECONNRESET, ECONNREFUSED, etc.). Útil en el arranque cuando MariaDB
 * acaba de abrir el puerto pero aún no procesa queries.
 */
async function withRetryOnTransient(fn, { maxAttempts = 5, baseDelayMs = 800, label = 'query' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientConnectionError(err) || attempt === maxAttempts) {
        throw err;
      }
      const delay = baseDelayMs * attempt; // 800ms, 1600ms, 2400ms, 3200ms …
      console.warn(
        `[startup] ${label} — error transitorio (${err.code || err.message}), ` +
        `reintentando en ${delay}ms (intento ${attempt}/${maxAttempts - 1} restantes)…`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

async function prepareServerRuntime() {
  try {
    if (getDbClient() === 'mysql') {
      let schemaState;
      try {
        // Primer intento con reintentos para errores transitorios de arranque
        // (MariaDB abre el puerto TCP ~1s antes de estar lista para queries).
        schemaState = await withRetryOnTransient(
          () => inspectCoreSchema(),
          { maxAttempts: 6, baseDelayMs: 1000, label: 'inspectCoreSchema' }
        );
      } catch (inspectError) {
        if (!isUnknownDatabaseError(inspectError)) throw inspectError;
        console.log('La base de datos MySQL no existe todavía. Creándola desde cero...');
        await initializeMySqlDatabase();
        await reloadDatabase();
        schemaState = await withRetryOnTransient(
          () => inspectCoreSchema(),
          { maxAttempts: 4, baseDelayMs: 800, label: 'inspectCoreSchema (post-init)' }
        );
      }
      if (!schemaState.hasRequiredTables) {
        console.log('Inicializando base de datos MySQL...');
        await initializeMySqlDatabase();
        await reloadDatabase();
        schemaState = await withRetryOnTransient(
          () => inspectCoreSchema(),
          { maxAttempts: 4, baseDelayMs: 800, label: 'inspectCoreSchema (post-repair)' }
        );
        if (!schemaState.hasRequiredTables) {
          throw new Error('La base MySQL no pudo inicializarse correctamente.');
        }
      }

      await Promise.all([
        ensureConfigExtensions(),
        ensureUserExtensions(),
        ensureProductExtensions(),
        ensureClientExtensions(),
        ensureSalesExtensions(),
        ensureDiningTables(),
        ensureDeliveryTrackingTable(),
        ensureSuspendedSalesTable(),
        ensureSessionTables(),
        ensureCashRegisterTypeExtension(),
        ensureWizardExtensions(),
        ensureMobileTables(query),
        plans.ensurePlanExtensions(query),
        ecfModule.ensureSchema().catch(e => console.warn('[ecf] init fallo:', e.message)),
        ensureNetworkExtensions(query).catch(e => console.warn('[network] init fallo:', e.message)),
        ensureOperativeDateExtensions().catch(e => console.warn('[operative-date] init fallo:', e.message)),
      ]);
      const setup = await getSetupStatus();
      await ensureStarterCatalogSeededIfNeeded(setup.config);
      // Sync license first so the signed secure cache is validated before the app accepts traffic.
      await syncRemoteLicenseToLocalConfig({ force: true }).catch(() => {});
      // Re-sync POS accounts to Firestore on every startup (fixes silent failures during setup)
      trySyncAllPosAccountsToFirebase().catch(() => {});
      // Sincroniza TODOS los usuarios al Firebase Authentication en cada arranque
      // (crea cuentas Firebase para usuarios que aún no las tienen).
      trySyncAllStaffToFirebaseAuth().catch(() => {});
      // Asegura que los clientes existentes también se envíen al menos al arrancar.
      trySyncAllPosClientsToFirebase().catch(() => {});
      // Repara pedidos delivery ya creados para que mantengan link y referencia en Firestore.
      tryRepairPendingDeliveryOrdersInFirebase().catch(() => {});
      // Bootstrap inicial de la data histórica para la app de reportes.
      tryEnsureInitialFirebaseReportsBootstrap().catch(() => {});
      await ensureLicenseBackgroundSync();
      // Si Firebase se habilita después del arranque, reintenta el bootstrap histórico.
      setInterval(() => {
        tryEnsureInitialFirebaseReportsBootstrap().catch(() => {});
      }, 5 * 60 * 1000);
      pruneExpiredAuthSessions().catch(() => {});
      productsCache.init(query);
      productsCache.loadAll().catch(err => console.warn('[products-cache] Carga inicial falló:', err.message));
      getSyncService().initialize().catch(e => console.warn('[sync] Firebase Sync Service init falló:', e.message));
      fileManagerService.initStructure().catch(e => console.warn('[file-manager] init falló:', e.message));
      console.log('Runtime de Tecno Caja preparado correctamente en MySQL.');
      return;
    }

    const dbFile = process.env.DB_FILE || path.join(__dirname, 'data', 'tecnocaja.db');
    let needsInit = !fs.existsSync(dbFile);
    if (needsInit) {
      console.log('Inicializando base de datos SQLite...');
      await initializeDatabase();
      await reloadDatabase();
      console.log('Base de datos inicializada correctamente.');
      needsInit = false;
    }

    let schemaState = null;
    try {
      schemaState = await inspectCoreSchema();
    } catch (error) {
      if (!isBrokenDatabaseError(error)) {
        throw error;
      }
      const brokenBackupPath = moveBrokenDatabaseAside(dbFile);
      console.warn(
        'La base de datos local estaba dañada y fue apartada automáticamente.' +
        (brokenBackupPath ? ` Copia guardada en ${brokenBackupPath}.` : '')
      );
      await initializeDatabase();
      await reloadDatabase();
      console.log('Base de datos reparada automáticamente.');
      schemaState = await inspectCoreSchema();
    }

    if (!schemaState.hasRequiredTables) {
      const brokenBackupPath = moveBrokenDatabaseAside(dbFile);
      console.warn(
        `La base de datos local estaba incompleta o usaba un esquema no compatible.` +
        (schemaState.missingTables.length ? ` Faltaban tablas: ${schemaState.missingTables.join(', ')}.` : '') +
        (schemaState.invalidPrimaryKeyTables.length ? ` Tablas con clave primaria incompatible: ${schemaState.invalidPrimaryKeyTables.join(', ')}.` : '') +
        (brokenBackupPath ? ` Se guardó una copia del archivo dañado en ${brokenBackupPath}.` : '')
      );
      await initializeDatabase();
      await reloadDatabase();
      console.log('Base de datos reparada automáticamente.');
    }

    await Promise.all([
      ensureConfigExtensions(),
      ensureUserExtensions(),
      ensureProductExtensions(),
      ensureClientExtensions(),
      ensureSalesExtensions(),
      ensureDiningTables(),
      ensureDeliveryTrackingTable(),
      ensureSuspendedSalesTable(),
      ensureSessionTables(),
      ensureCashRegisterTypeExtension(),
      ensureWizardExtensions(),
      ensureMobileTables(query),
      plans.ensurePlanExtensions(query),
      ecfModule.ensureSchema().catch(e => console.warn('[ecf] init fallo:', e.message)),
      ensureNetworkExtensions(query).catch(e => console.warn('[network] init fallo:', e.message)),
      ensureOperativeDateExtensions().catch(e => console.warn('[operative-date] init fallo:', e.message)),
    ]);
    const setup = await getSetupStatus();
    await ensureStarterCatalogSeededIfNeeded(setup.config);
    // Sync license first so the signed secure cache is validated before the app accepts traffic.
    await syncRemoteLicenseToLocalConfig({ force: true }).catch(() => {});
    // Re-sync POS accounts to Firestore on every startup (fixes silent failures during setup)
    trySyncAllPosAccountsToFirebase().catch(() => {});
    // Sincroniza TODOS los usuarios al Firebase Authentication en cada arranque
    // (crea cuentas Firebase para usuarios que aún no las tienen).
    trySyncAllStaffToFirebaseAuth().catch(() => {});
    // Asegura que los clientes existentes también se envíen al menos al arrancar.
    trySyncAllPosClientsToFirebase().catch(() => {});
    // Repara pedidos delivery ya creados para que mantengan link y referencia en Firestore.
    tryRepairPendingDeliveryOrdersInFirebase().catch(() => {});
    // Bootstrap inicial de la data histórica para la app de reportes.
    tryEnsureInitialFirebaseReportsBootstrap().catch(() => {});
    await ensureLicenseBackgroundSync();
    // Si Firebase se habilita después del arranque, reintenta el bootstrap histórico.
    setInterval(() => {
      tryEnsureInitialFirebaseReportsBootstrap().catch(() => {});
    }, 5 * 60 * 1000);
    pruneExpiredAuthSessions().catch(() => {});
    productsCache.init(query);
    productsCache.loadAll().catch(err => console.warn('[products-cache] Carga inicial falló:', err.message));

    // ── Auto-registro del terminal principal en la tabla central ─────────────
    try {
      const tc         = getTerminalConfig();
      const isMain     = !tc || tc.isMain !== false;
      const configRows = await query('SELECT business_id, active_branch_id, active_cash_register_id FROM config WHERE id = 1 LIMIT 1');
      const cfg        = configRows[0] || {};
      await registerTerminal(query, {
        terminalId:    tc?.terminalId    || 'principal',
        terminalName:  tc?.terminalName  || 'Servidor Principal',
        branchId:      tc?.branchId      || cfg.active_branch_id      || null,
        cashRegisterId: tc?.cashRegisterId || cfg.active_cash_register_id || null,
        businessId:    cfg.business_id   || 1,
        ipAddress:     getLocalIPs()[0]  || '127.0.0.1',
        connectionType: isMain ? 'local' : 'lan',
        isMain,
        registeredBy:  'server-startup'
      });
    } catch (_) {}

    getSyncService().initialize().catch(e => console.warn('[sync] Firebase Sync Service init falló:', e.message));
    fileManagerService.initStructure().catch(e => console.warn('[file-manager] init falló:', e.message));
    console.log('Runtime de Tecno Caja preparado correctamente.');
  } catch (error) {
    console.error('No se pudo preparar el runtime de Tecno Caja:', error);
    throw error;
  }
}

// ─── Listener Firestore en tiempo real para cambios de licencia ───────────────
async function startFirestoreLicenseWatcher() {
  const firebaseStatus = getFirebaseConfigStatus();
  if (!firebaseStatus.adminEnabled) return false;
  if (licenseWatcherUnsubscribe) return true;

  try {
    const { getFirestore: _getFs, getAdminLicensesCollectionName, fetchRemotePosLicenseState } = require('./modules/firebase-admin');
    const db = _getFs();

    let licenseUid = String(process.env.TECNO_CAJA_LICENSE_UID || '').trim();

    // Auto-descubrir UID si no está configurado
    if (!licenseUid) {
      const cfg = await getConfig({ syncRemote: false }).catch(() => ({}));
      const adminRows = await query(
        `SELECT firebase_uid FROM users WHERE rol IN ('admin','super_admin','administrador') AND firebase_uid IS NOT NULL AND firebase_uid != '' ORDER BY id ASC LIMIT 1`
      ).catch(() => []);
      const principalFirebaseUid = adminRows[0]?.firebase_uid || null;
      const remoteState = await fetchRemotePosLicenseState({ business_name: cfg.nombre, principalFirebaseUid }).catch(() => null);
      licenseUid = remoteState?.licenseUid || '';
    }

    if (!licenseUid) {
      console.warn('[license-watcher] No se pudo determinar licenseUid — listener Firestore desactivado.');
      return false;
    }

    const collectionName = getAdminLicensesCollectionName();
    const docRef = db.collection(collectionName).doc(licenseUid);

    licenseWatcherUnsubscribe = docRef.onSnapshot(
      () => {
        syncRemoteLicenseToLocalConfig({ allowRemoteWrite: false }).catch(() => {});
      },
      err => {
        console.warn('[license-watcher] Error en listener Firestore:', err.message);
        licenseWatcherUnsubscribe = null;
        ensureLicenseFallbackPoller('Error en listener Firestore: ' + err.message);
      }
    );

    console.log('[license-watcher] Listener en tiempo real activo para licenseUid:', licenseUid);
    return true;
  } catch (err) {
    console.warn('[license-watcher] No se pudo iniciar listener Firestore:', err.message);
    return false;
  }
}

// ─── Iniciar HTTP server (llamado desde electron/main.js) ────────────────────
/* ─────────────────────────────────────────────────────────────────────────────
   MÓDULO: ACTUALIZACIÓN DEL SISTEMA
   Rutas: GET /api/update/current-version
          GET /api/update/check
─────────────────────────────────────────────────────────────────────────────*/

/** Devuelve la versión instalada desde package.json */
app.get('/api/update/current-version', (_req, res) => {
  res.json({ version: packageJson.version || '1.0.0' });
});

/**
 * Verifica si hay una actualización disponible.
 * En producción apuntaría a https://updates.tecnocaja.com/latest.json
 * o a la GitHub Releases API del repositorio.
 * Por ahora sirve desde un archivo local configurable.
 */
app.get('/api/update/check', (req, res) => {
  const currentVer = String(req.query.v || '1.0.0').replace(/^v/, '');
  const showBeta   = req.query.beta === 'true';

  // Intentar leer manifiesto local de actualización (útil para distribución offline)
  const manifestPath = path.join(__dirname, 'update-manifest.json');
  let manifest = null;
  try {
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    }
  } catch (e) {
    console.warn('[update] No se pudo leer update-manifest.json:', e.message);
  }

  // Si no hay manifiesto local, devolver "al día" para no mostrar error
  if (!manifest) {
    return res.json({ upToDate: true, version: currentVer });
  }

  // Filtrar versiones beta si no están habilitadas
  const latest = showBeta ? manifest : { ...manifest, version: manifest.stableVersion || manifest.version };

  // Comparar versiones (semver básico)
  function semverGt(a, b) {
    const pa = String(a).replace(/^v/, '').split('.').map(Number);
    const pb = String(b).replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return true;
      if ((pa[i] || 0) < (pb[i] || 0)) return false;
    }
    return false;
  }

  if (!semverGt(latest.version, currentVer)) {
    return res.json({ upToDate: true, version: currentVer });
  }

  res.json({
    upToDate  : false,
    version   : latest.version,
    date      : latest.date      || new Date().toLocaleDateString('es-DO'),
    size      : latest.size      || '—',
    type      : latest.type      || 'feature',
    critical  : latest.critical  || false,
    changes   : latest.changes   || [],
    downloadUrl: latest.downloadUrl || null,
  });
});

async function startHttpServer(port, bindHost) {
  await prepareServerRuntime();
  
  // Detectar si terminal-config.json indica multicaja principal → usar 0.0.0.0 para LAN
  let finalBindHost = bindHost || '127.0.0.1';
  try {
    const configPaths = [
      path.join(__dirname, 'config', 'terminal-config.json'),
      path.join(__dirname, '..', 'config', 'terminal-config.json'),
      path.join(process.cwd(), 'config', 'terminal-config.json')
    ];
    const configPath = configPaths.find(p => fs.existsSync(p));
    if (configPath) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const mode = String(cfg?.setupMode || '').toLowerCase().trim();
      const isMain = cfg?.isMain !== false;
      if (isMain && ['multicaja', 'multisucursal', 'sucursal'].includes(mode)) {
        finalBindHost = '0.0.0.0';
        console.log(`[startHttpServer] Terminal-config detectado: mode=${mode}, isMain=${isMain} → bind 0.0.0.0 para LAN`);
      }
    }
  } catch (err) {
    console.warn(`[startHttpServer] Error al verificar terminal-config:`, err.message);
  }
  
  return new Promise((resolve, reject) => {
    httpServer.listen(port, finalBindHost, () => {
      console.log('[Tecno Caja] Servidor escuchando en ' + finalBindHost + ':' + port);
      resolve();
    });
    httpServer.once('error', reject);
  });
}

module.exports = { startHttpServer };
