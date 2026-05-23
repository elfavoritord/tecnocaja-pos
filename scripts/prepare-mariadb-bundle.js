const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const bundleRoot = path.join(projectRoot, 'build', 'mariadb-runtime');

function log(message) {
  console.log(`[prepare-mariadb-bundle] ${message}`);
}

function normalizeWindowsPath(value) {
  return String(value || '')
    .trim()
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

function getWindowsProcessListByName(imageName) {
  if (process.platform !== 'win32') return [];

  try {
    const command = [
      '-NoProfile',
      '-Command',
      `
        Get-CimInstance Win32_Process -Filter "Name = '${String(imageName || '').replace(/'/g, "''")}'" |
        Select-Object ProcessId, ExecutablePath |
        ConvertTo-Json -Compress
      `
    ];

    const raw = execFileSync('powershell.exe', command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (_) {
    return [];
  }
}

function getBundledMariaDbProcesses() {
  const normalizedBundleRoot = normalizeWindowsPath(bundleRoot);
  return getWindowsProcessListByName('mariadbd.exe').filter((processInfo) => {
    const executablePath = normalizeWindowsPath(processInfo.ExecutablePath);
    return executablePath && executablePath.startsWith(normalizedBundleRoot);
  });
}

function ensureBundleDirectoryIsUnlocked() {
  const bundledProcesses = getBundledMariaDbProcesses();
  if (!bundledProcesses.length) return;

  const details = bundledProcesses
    .map((processInfo) => `PID ${processInfo.ProcessId} -> ${processInfo.ExecutablePath}`)
    .join('\n');

  const error = new Error(
    'No se puede reconstruir build/mariadb-runtime porque MariaDB está ejecutándose desde ese mismo bundle.\n' +
    'Cierra Tecno Caja o detén este proceso y vuelve a intentar:\n' +
    `${details}\n` +
    'Sugerencia PowerShell: Stop-Process -Id <PID> -Force'
  );
  error.code = 'BUNDLED_MARIADB_RUNNING';
  throw error;
}

function copyDirectory(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
      continue;
    }

    fs.copyFileSync(sourcePath, targetPath);
  }
}

function removeDevelopmentArtifacts(targetDir) {
  const walk = (currentDir) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }

      const lowerName = entry.name.toLowerCase();
      if (lowerName.endsWith('.pdb') || lowerName.endsWith('.lib')) {
        fs.rmSync(entryPath, { force: true });
      }
    }
  };

  walk(targetDir);
}

function detectMariaDbSource() {
  const explicitDir = String(process.env.TECNO_CAJA_MARIADB_SOURCE || '').trim();
  if (explicitDir) {
    return path.resolve(explicitDir);
  }

  const roots = [
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\MariaDB',
    'C:\\MySQL'
  ];
  const found = [];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;

    const stats = fs.statSync(root);
    if (stats.isDirectory() && /\\(MariaDB|MySQL)$/i.test(root)) {
      found.push(root);
      continue;
    }

    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!/^(mariadb|mysql)/i.test(entry.name)) continue;
      found.push(path.join(root, entry.name));
    }
  }

  const candidates = found
    .filter((installDir) => fs.existsSync(path.join(installDir, 'bin', 'mariadbd.exe')))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: 'base' }));

  return candidates[0] || '';
}

function writeManifest(sourceDir) {
  const manifest = {
    createdAt: new Date().toISOString(),
    sourceDir,
    files: ['bin', 'lib', 'share', 'COPYING', 'README.md', 'THIRDPARTY']
  };
  fs.writeFileSync(
    path.join(bundleRoot, 'bundle-manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );
}

function assertRequiredFiles(targetDir) {
  const requiredPaths = [
    path.join(targetDir, 'bin', 'mariadbd.exe'),
    path.join(targetDir, 'bin', 'mysql_install_db.exe'),
    path.join(targetDir, 'lib', 'plugin'),
    path.join(targetDir, 'share', 'mariadb_system_tables.sql')
  ];

  for (const requiredPath of requiredPaths) {
    if (!fs.existsSync(requiredPath)) {
      throw new Error(`Falta un archivo o carpeta requerida en el bundle: ${requiredPath}`);
    }
  }
}

function prepareMariaDbBundle() {
  const sourceDir = detectMariaDbSource();
  if (!sourceDir) {
    throw new Error(
      'No se encontro una instalacion local de MariaDB para empaquetar. ' +
      'Define TECNO_CAJA_MARIADB_SOURCE o instala MariaDB en esta PC de build.'
    );
  }

  log(`Usando MariaDB desde ${sourceDir}`);

  ensureBundleDirectoryIsUnlocked();
  fs.rmSync(bundleRoot, { recursive: true, force: true });
  fs.mkdirSync(bundleRoot, { recursive: true });

  for (const dirName of ['bin', 'lib', 'share']) {
    const sourcePath = path.join(sourceDir, dirName);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`La carpeta requerida no existe en la instalacion fuente: ${sourcePath}`);
    }
    copyDirectory(sourcePath, path.join(bundleRoot, dirName));
  }

  for (const fileName of ['COPYING', 'README.md', 'THIRDPARTY']) {
    const sourcePath = path.join(sourceDir, fileName);
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, path.join(bundleRoot, fileName));
    }
  }

  removeDevelopmentArtifacts(bundleRoot);
  writeManifest(sourceDir);
  assertRequiredFiles(bundleRoot);
  log(`Bundle listo en ${bundleRoot}`);
}

if (require.main === module) {
  try {
    prepareMariaDbBundle();
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}

module.exports = {
  prepareMariaDbBundle
};
