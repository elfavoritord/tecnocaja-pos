const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const MANAGED_SERVICE_NAME = 'Tecno CajaMariaDB';

function isLoopbackHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  return normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0.0.0.0';
}

function resolveMysqlBindHost() {
  if (process.env.TECNO_CAJA_MYSQL_BIND_HOST) {
    return String(process.env.TECNO_CAJA_MYSQL_BIND_HOST).trim() || '127.0.0.1';
  }
  const allowLan = String(process.env.TECNO_CAJA_MYSQL_ALLOW_LAN || '').trim().toLowerCase() === 'true';
  return allowLan ? '0.0.0.0' : '127.0.0.1';
}

function testPort(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
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
    socket.connect(port, host);
  });
}

async function waitForPort(host, port, attempts = 15, delayMs = 1000) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await testPort(host, port)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return false;
}

function runSc(args = []) {
  try {
    return spawnSync('sc.exe', args, {
      windowsHide: true,
      encoding: 'utf8'
    });
  } catch (error) {
    return {
      status: 1,
      stdout: '',
      stderr: error.message || 'No se pudo ejecutar sc.exe'
    };
  }
}

function queryExistingService(serviceName) {
  const result = runSc(['query', serviceName]);
  if (result.status !== 0) {
    return null;
  }

  return {
    name: serviceName,
    output: `${result.stdout || ''}\n${result.stderr || ''}`
  };
}

function setServiceAutoStart(serviceName) {
  runSc(['config', serviceName, 'start=', 'auto']);
}

function startService(serviceName) {
  return runSc(['start', serviceName]);
}

function ensureDirectory(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
}

function getManagedMariaDbRoot() {
  return path.join(process.env.ProgramData || 'C:\\ProgramData', 'Tecno Caja', 'MariaDB');
}

function getBundledRuntimeRoot() {
  const candidates = [
    String(process.env.TECNO_CAJA_MARIADB_BUNDLE_DIR || '').trim(),
    typeof process.resourcesPath === 'string' ? path.join(process.resourcesPath, 'mariadb-runtime') : '',
    path.resolve(__dirname, '..', '..', 'mariadb-runtime'),
    path.resolve(__dirname, '..', 'build', 'mariadb-runtime')
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'bin', 'mariadbd.exe'))) || '';
}

function getBundledCandidate() {
  const root = getBundledRuntimeRoot();
  if (!root) {
    return null;
  }

  return {
    kind: 'bundled',
    root,
    executable: path.join(root, 'bin', 'mariadbd.exe'),
    bootstrapExecutable: path.join(root, 'bin', 'mysql_install_db.exe'),
    pluginDir: path.join(root, 'lib', 'plugin'),
    defaultsFile: path.join(getManagedMariaDbRoot(), 'my.ini')
  };
}

function findInstallDirectories() {
  const roots = [
    'C:\\Program Files',
    'C:\\Program Files (x86)'
  ];
  const directCandidates = [
    'C:\\MariaDB',
    'C:\\MySQL'
  ];
  const installDirs = [];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!/^(mariadb|mysql)/i.test(entry.name)) continue;
      installDirs.push(path.join(root, entry.name));
    }
  }

  for (const directPath of directCandidates) {
    if (fs.existsSync(directPath)) {
      installDirs.push(directPath);
    }
  }

  return [...new Set(installDirs)];
}

function getSystemCandidate() {
  const executableNames = ['mariadbd.exe', 'mysqld.exe'];

  for (const installDir of findInstallDirectories()) {
    const binDir = path.join(installDir, 'bin');
    for (const executableName of executableNames) {
      const executable = path.join(binDir, executableName);
      if (!fs.existsSync(executable)) {
        continue;
      }

      const defaultsCandidates = [
        path.join(installDir, 'data', 'my.ini'),
        path.join(installDir, 'my.ini')
      ];
      const defaultsFile = defaultsCandidates.find((candidate) => fs.existsSync(candidate)) || '';

      return {
        kind: 'system',
        root: installDir,
        executable,
        bootstrapExecutable: '',
        pluginDir: path.join(installDir, 'lib', 'plugin'),
        defaultsFile
      };
    }
  }

  return null;
}

function findServerCandidate() {
  return getBundledCandidate() || getSystemCandidate();
}

function writeManagedConfig(candidate, port) {
  const root = getManagedMariaDbRoot();
  const dataDir = path.join(root, 'data');
  const logsDir = path.join(root, 'logs');
  const errorLog = path.join(logsDir, 'mariadb.err');
  const bindHost = resolveMysqlBindHost();

  ensureDirectory(root);
  ensureDirectory(dataDir);
  ensureDirectory(logsDir);

  const normalize = (value) => String(value || '').replace(/\\/g, '/');
  const content = [
    '[mysqld]',
    `basedir=${normalize(candidate.root)}`,
    `datadir=${normalize(dataDir)}`,
    `port=${port}`,
    `bind-address=${bindHost}`,
    `plugin-dir=${normalize(candidate.pluginDir)}`,
    `log-error=${normalize(errorLog)}`,
    'character-set-server=utf8mb4',
    'collation-server=utf8mb4_unicode_ci',
    'skip-name-resolve',
    '',
    '[client]',
    `port=${port}`,
    `plugin-dir=${normalize(candidate.pluginDir)}`,
    ''
  ].join('\n');

  const iniPath = path.join(root, 'my.ini');
  try {
    fs.writeFileSync(iniPath, content, 'ascii');
  } catch (writeErr) {
    // Si no hay permisos de escritura (EPERM) pero el archivo ya existe,
    // MariaDB puede usar el my.ini existente — continuar sin error.
    if (writeErr.code === 'EPERM' && fs.existsSync(iniPath)) {
      return;
    }
    throw writeErr;
  }
}

function initializeBundledData(candidate, port, log) {
  const root = getManagedMariaDbRoot();
  const dataDir = path.join(root, 'data');
  const mysqlDir = path.join(dataDir, 'mysql');
  const ibdataFile = path.join(dataDir, 'ibdata1');

  if (fs.existsSync(mysqlDir) && fs.existsSync(ibdataFile)) {
    writeManagedConfig(candidate, port);
    return;
  }

  if (!fs.existsSync(candidate.bootstrapExecutable)) {
    throw new Error('No se encontro mysql_install_db.exe dentro del bundle MariaDB.');
  }

  log(`Inicializando MariaDB embebida en ${dataDir}.`);
  ensureDirectory(root);
  fs.rmSync(dataDir, { recursive: true, force: true });
  ensureDirectory(dataDir);

  const result = spawnSync(candidate.bootstrapExecutable, [
    '-d',
    dataDir,
    '-p',
    '',
    '-P',
    String(port),
    '-s'
  ], {
    windowsHide: true,
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'mysql_install_db.exe no pudo inicializar la base.');
  }

  writeManagedConfig(candidate, port);
}

function startDetachedServer(candidate) {
  const args = [];
  if (candidate.defaultsFile) {
    args.push(`--defaults-file=${candidate.defaultsFile}`);
  }

  const child = spawn(candidate.executable, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
}

async function ensureLocalMysqlAvailable(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const dbClient = String(process.env.DB_CLIENT || 'sqlite').trim().toLowerCase();
  const host = String(process.env.DB_HOST || '127.0.0.1').trim() || '127.0.0.1';
  const port = Number(process.env.DB_PORT || 3306);

  if (dbClient !== 'mysql') {
    return { status: 'skipped', reason: 'DB_CLIENT no usa mysql.' };
  }

  if (!isLoopbackHost(host)) {
    return { status: 'skipped', reason: `DB_HOST apunta a ${host}, no a una instancia local.` };
  }

  const candidate = findServerCandidate();
  const wantsLanBind = resolveMysqlBindHost() === '0.0.0.0';

  if (await testPort(host, port)) {
    if (wantsLanBind && candidate?.kind === 'bundled') {
      try {
        writeManagedConfig(candidate, port);
      } catch (error) {
        log(`No se pudo actualizar my.ini para LAN mientras MariaDB seguía abierta: ${error.message || error}`);
      }
    }
    return { status: 'ready', method: 'already-running' };
  }

  if (process.platform === 'win32') {
    for (const serviceName of [MANAGED_SERVICE_NAME, 'MariaDB']) {
      const service = queryExistingService(serviceName);
      if (!service) continue;

      log(`Intentando iniciar el servicio ${serviceName}.`);
      setServiceAutoStart(serviceName);
      startService(serviceName);

      if (await waitForPort(host, port)) {
        return { status: 'ready', method: 'windows-service', serviceName };
      }
    }
  }

  if (!candidate) {
    return {
      status: 'unavailable',
      reason: 'No se encontro MariaDB local ni el bundle embebido.'
    };
  }

  try {
    if (candidate.kind === 'bundled') {
      initializeBundledData(candidate, port, log);
    }

    log(`Iniciando MariaDB local desde ${candidate.executable}.`);
    startDetachedServer(candidate);
  } catch (error) {
    return {
      status: 'error',
      reason: error.message || 'No se pudo iniciar MariaDB local.'
    };
  }

  if (await waitForPort(host, port, 20, 1000)) {
    return {
      status: 'ready',
      method: candidate.kind === 'bundled' ? 'bundled-runtime' : 'detached-process',
      executable: candidate.executable
    };
  }

  return {
    status: 'error',
    reason: 'MariaDB/MySQL local no abrio el puerto configurado a tiempo.'
  };
}

module.exports = {
  ensureLocalMysqlAvailable,
  resolveMysqlBindHost
};
