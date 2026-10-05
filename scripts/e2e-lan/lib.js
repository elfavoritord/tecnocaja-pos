// Utilidades para la prueba de punta a punta LAN-first (MariaDB temporal +
// servidores Tecno Caja aislados). Nada toca el .env, la base ni el userData
// reales: todo vive en una carpeta temporal (TC_E2E_DIR o %TEMP%).
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const PROJECT = path.resolve(__dirname, '..', '..');
const E2E = __dirname;
const WORK = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-e2e-lan');
const APP = path.join(WORK, 'app');
const MARIADB_BIN = path.join(PROJECT, 'build', 'mariadb-runtime', 'bin');
const DB_PORT = Number(process.env.TC_E2E_DB_PORT || 3417);

function log(...args) { console.log('[e2e]', ...args); }

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// Copia del proyecto SIN .env ni firebase-key.json: el servidor de prueba no
// puede escribir en el .env real ni hablar con el Firebase real.
function prepareSandbox() {
  if (fs.existsSync(APP)) {
    for (const entry of fs.readdirSync(APP)) {
      if (entry === 'node_modules') continue;
      fs.rmSync(path.join(APP, entry), { recursive: true, force: true });
    }
  }
  fs.mkdirSync(APP, { recursive: true });
  for (const dir of ['server', 'modules', 'db', 'scripts', 'js', 'css', 'img']) {
    if (fs.existsSync(path.join(PROJECT, dir))) copyDir(path.join(PROJECT, dir), path.join(APP, dir));
  }
  for (const file of ['server.js', 'db.js', 'db-local.js', 'package.json', 'index.html']) {
    fs.copyFileSync(path.join(PROJECT, file), path.join(APP, file));
  }
  const nm = path.join(APP, 'node_modules');
  if (!fs.existsSync(nm)) fs.symlinkSync(path.join(PROJECT, 'node_modules'), nm, 'junction');
  for (const forbidden of ['.env', 'firebase-key.json']) {
    if (fs.existsSync(path.join(APP, forbidden))) throw new Error(`El sandbox no debe tener ${forbidden}`);
  }
}

function waitPort(port, host = '127.0.0.1', timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host, port });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error(`puerto ${port} no abrió`));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

let mariadbProc = null;
const DATADIR = path.join(WORK, 'mariadb-data');

async function startMariaDb({ fresh = false } = {}) {
  if (fresh && fs.existsSync(DATADIR)) fs.rmSync(DATADIR, { recursive: true, force: true });
  if (!fs.existsSync(DATADIR)) {
    const r = spawnSync(path.join(MARIADB_BIN, 'mariadb-install-db.exe'), [`--datadir=${DATADIR}`, `--port=${DB_PORT}`], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`install-db falló: ${r.stderr || r.stdout}`);
  }
  // 127.0.0.2 también es la propia PC (loopback), pero el servidor la trata
  // como "otra PC": así la caja terminal de la prueba se comporta como en una
  // LAN real (arranque en modo contingencia, vigilante de la principal). La
  // base de prueba nunca escucha en la red.
  mariadbProc = spawn(path.join(MARIADB_BIN, 'mariadbd.exe'), [
    `--datadir=${DATADIR}`, `--port=${DB_PORT}`, '--bind-address=127.0.0.1,127.0.0.2', '--skip-name-resolve', '--console',
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  mariadbProc.stderr.on('data', () => {});
  await waitPort(DB_PORT);
  log('MariaDB temporal arriba en', DB_PORT);
}

async function stopMariaDb() {
  if (!mariadbProc) return;
  const proc = mariadbProc;
  mariadbProc = null;
  spawnSync(path.join(MARIADB_BIN, 'mariadb-admin.exe'), ['-uroot', '-h127.0.0.1', `-P${DB_PORT}`, 'shutdown'], { encoding: 'utf8' });
  await new Promise((resolve) => {
    const t = setTimeout(() => { try { proc.kill(); } catch (_) { /* ya terminó */ } resolve(); }, 15000);
    proc.once('exit', () => { clearTimeout(t); resolve(); });
  });
  log('MariaDB temporal detenida');
}

async function mysqlRoot(sql) {
  const mysql = require(path.join(PROJECT, 'node_modules', 'mysql2', 'promise'));
  const conn = await mysql.createConnection({ host: '127.0.0.1', port: DB_PORT, user: 'root', password: '', multipleStatements: true });
  try { return (await conn.query(sql))[0]; } finally { await conn.end(); }
}

function serverEnv(extra = {}) {
  const env = { ...process.env };
  // Nada del Firebase/licencia reales.
  for (const key of Object.keys(env)) {
    if (/^(FIREBASE_|GOOGLE_APPLICATION|TECNO_CAJA_|DB_|POS_|R2_)/.test(key)) delete env[key];
  }
  return {
    ...env,
    FIREBASE_SERVICE_ACCOUNT_PATH: '',
    FIREBASE_SERVICE_ACCOUNT_JSON: '',
    GOOGLE_APPLICATION_CREDENTIALS: '',
    FIREBASE_PROJECT_ID: '',
    TECNO_CAJA_LICENSE_UID: '',
    TECNO_CAJA_SECURITY_PASSWORD: 'e2e-clave-segura',
    TECNO_CAJA_ALLOW_CONNECTIVITY_SIMULATION: '1',
    POS_BIND_HOST: '127.0.0.1',
    ...extra,
  };
}

// Igual que electron/main.js: la configuración de base de datos vive en
// config/app.env del usuario (el servidor la lee al arrancar).
function writeAppEnv(userData, port, env) {
  fs.mkdirSync(path.join(userData, 'config'), { recursive: true });
  const appEnv = path.join(userData, 'config', 'app.env');
  const keep = fs.existsSync(appEnv) ? fs.readFileSync(appEnv, 'utf8') : '';
  const lines = keep.split(/\r?\n/).filter((l) => l && !/^(DB_CLIENT|DB_HOST|DB_PORT|DB_USER|DB_PASSWORD|DB_NAME|PORT|POS_ALLOW_LAN|POS_BIND_HOST)=/.test(l));
  for (const key of ['DB_CLIENT', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) {
    if (env[key] !== undefined) lines.push(`${key}=${env[key]}`);
  }
  lines.push(`PORT=${port}`);
  // El asistente multicaja deja la principal escuchando en la LAN; en la
  // prueba los servidores solo escuchan en esta PC.
  lines.push('POS_ALLOW_LAN=false', 'POS_BIND_HOST=127.0.0.1');
  fs.writeFileSync(appEnv, lines.join('\n') + '\n');
}

// Primera activación de licencia de una PC (ver seed-license.js).
function seedLicense({ port, userData, env = {} }) {
  writeAppEnv(userData, port, env);
  const r = spawnSync(process.execPath, [path.join(E2E, 'seed-license.js')], {
    cwd: APP,
    env: serverEnv({ ...env, PORT: String(port), TECNO_CAJA_USER_DATA: userData, E2E_APP: APP }),
    encoding: 'utf8',
    windowsHide: true,
  });
  const line = String(r.stdout || '').trim().split(/\r?\n/).filter((l) => l.startsWith('{')).pop() || '';
  return { ok: r.status === 0, detail: line || String(r.stderr || '').slice(-300) };
}

const LAUNCHER = path.join(E2E, 'launch-server.js');

function startServer(name, { port, userData, env = {} }) {
  writeAppEnv(userData, port, env);
  const out = fs.createWriteStream(path.join(WORK, `${name}.log`));
  const proc = spawn(process.execPath, [LAUNCHER], {
    cwd: APP,
    env: serverEnv({ ...env, PORT: String(port), TECNO_CAJA_USER_DATA: userData, E2E_APP: APP }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  proc.stdout.pipe(out);
  proc.stderr.pipe(out);
  proc.name = name;
  proc.port = port;
  return proc;
}

async function waitHttp(port, pathName = '/api/connectivity', timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await request(port, 'GET', pathName);
      if (r.status > 0) return r;
    } catch (_) { /* aún arrancando */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`servidor en ${port} no respondió`);
}

async function stopServer(proc) {
  if (!proc || proc.exitCode !== null) return;
  await new Promise((resolve) => {
    const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) { /* ya terminó */ } resolve(); }, 5000);
    proc.once('exit', () => { clearTimeout(t); resolve(); });
    try { proc.kill(); } catch (_) { resolve(); }
  });
}

function request(port, method, pathName, body = null, token = '', timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const started = Date.now();
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathName, timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) { json = { raw: raw.slice(0, 300) }; }
        resolve({ status: res.statusCode, body: json, ms: Date.now() - started });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
}

module.exports = {
  PROJECT, E2E, WORK, APP, DB_PORT, log, prepareSandbox, startMariaDb, stopMariaDb, mysqlRoot,
  startServer, stopServer, waitHttp, request, check, results, waitPort, seedLicense,
};
