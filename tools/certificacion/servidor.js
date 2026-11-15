'use strict';

/**
 * Servidor de certificación e-CF — para certificar empresas de clientes ante la
 * DGII SIN tocar el sistema de Emilio.
 *
 *   npm run certificacion          (o doble clic en «Servidor de certificación.cmd»)
 *   Panel (solo en esta PC):  http://127.0.0.1:3600
 *
 * Cada empresa es una instalación NUEVA y aislada del POS, como la de un cliente:
 *   Documents\TecnoCaja-certificacion\empresas\<RNC>\
 *     datos\     su base SQLite, su certificado .p12, el estado del asistente y los XML
 *     usuario\   su carpeta de usuario (respaldos, descargas)
 *     y es su carpeta de trabajo (cachés de firma, recibidos, diagnósticos e-CF)
 * No usa el .env de Emilio, ni su certificado, ni su Firebase: nada se cruza
 * entre empresas ni con el POS de Emilio (puerto 3399).
 *
 * Cada empresa corre en su puerto (3601, 3602…) y, para el contable desde su
 * casa, con un túnel rápido de Cloudflare (https://….trycloudflare.com; cambia
 * cada vez que se enciende). Se entra con usuario y clave del POS.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');
const express = require('express');

const PROYECTO = path.resolve(__dirname, '..', '..');
const BASE = process.env.TC_CERT_DIR || path.join(os.homedir(), 'Documents', 'TecnoCaja-certificacion');
const PROGRAMA = path.join(BASE, 'programa');
const EMPRESAS_DIR = path.join(BASE, 'empresas');
const ARCHIVO_EMPRESAS = path.join(BASE, 'empresas.json');
const ARCHIVO_CONFIG = path.join(BASE, 'config.json');
const GATEWAY_TOKENS = path.join(os.homedir(), 'Documents', 'TecnoCaja-gateway');
const PANEL_PORT = Number(process.env.TC_CERT_PANEL_PORT || 3600);
const PRIMER_PUERTO = PANEL_PORT + 1;
const PUPPETEER_CACHE = process.env.PUPPETEER_CACHE_DIR || path.join(os.homedir(), '.cache', 'puppeteer');
const ALTA_GATEWAY = path.join(PROYECTO, 'cloud', 'ecf-gateway', 'scripts', 'alta-empresa.ps1');

const log = (...a) => console.log(`[certificación ${new Date().toLocaleTimeString('es-DO')}]`, ...a);

// ── Archivos del panel ─────────────────────────────────────────────────────

function leerJson(archivo, porDefecto) {
  try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (_) { return porDefecto; }
}
function escribirJson(archivo, datos) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const tmp = `${archivo}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(datos, null, 2));
  fs.renameSync(tmp, archivo);
}

// Secretos propios de este servidor (no los del .env de Emilio): cifran la
// clave del .p12 y los respaldos de cada empresa. Se crean una vez.
function configuracion() {
  let cfg = leerJson(ARCHIVO_CONFIG, null);
  if (!cfg?.secretoFiscal || !cfg?.claveRespaldos) {
    cfg = { secretoFiscal: crypto.randomBytes(32).toString('hex'), claveRespaldos: crypto.randomBytes(24).toString('base64url'), creado: new Date().toISOString() };
    escribirJson(ARCHIVO_CONFIG, cfg);
  }
  return cfg;
}

let empresas = leerJson(ARCHIVO_EMPRESAS, []);
const guardarEmpresas = () => escribirJson(ARCHIVO_EMPRESAS, empresas);
const vivo = new Map(); // rnc → { pos, tunel, url, estado, error, desde }

const rutas = (rnc) => {
  const raiz = path.join(EMPRESAS_DIR, rnc);
  return { raiz, datos: path.join(raiz, 'datos'), usuario: path.join(raiz, 'usuario'), logs: path.join(raiz, 'logs') };
};

// ── Copia del programa (sin .env ni certificados de nadie) ─────────────────

function copiarCarpeta(origen, destino) {
  fs.mkdirSync(destino, { recursive: true });
  for (const e of fs.readdirSync(origen, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.env' || /\.(p12|pfx)$/i.test(e.name)) continue;
    const o = path.join(origen, e.name);
    const d = path.join(destino, e.name);
    if (e.isDirectory()) {
      if (path.relative(PROYECTO, o).replace(/\\/g, '/') === 'modules/ecf/logs') continue;
      copiarCarpeta(o, d);
    } else {
      fs.copyFileSync(o, d);
    }
  }
}

function prepararPrograma() {
  const app = path.join(PROGRAMA, 'app');
  if (fs.existsSync(app)) {
    for (const e of fs.readdirSync(app)) {
      if (e !== 'node_modules') fs.rmSync(path.join(app, e), { recursive: true, force: true });
    }
  }
  fs.mkdirSync(app, { recursive: true });
  for (const dir of ['server', 'modules', 'db', 'scripts', 'js', 'css', 'img', 'legal']) {
    if (fs.existsSync(path.join(PROYECTO, dir))) copiarCarpeta(path.join(PROYECTO, dir), path.join(app, dir));
  }
  for (const dir of ['cloud/tienda-online/public', 'cloud/tienda-online/lib', 'cloud/tienda-online/vendor']) {
    if (fs.existsSync(path.join(PROYECTO, dir))) copiarCarpeta(path.join(PROYECTO, dir), path.join(app, dir));
  }
  for (const f of ['server.js', 'db.js', 'db-local.js', 'package.json', 'index.html']) fs.copyFileSync(path.join(PROYECTO, f), path.join(app, f));
  const nm = path.join(app, 'node_modules');
  if (!fs.existsSync(nm)) fs.symlinkSync(path.join(PROYECTO, 'node_modules'), nm, 'junction');
  for (const prohibido of ['.env', 'firebase-key.json']) {
    if (fs.existsSync(path.join(app, prohibido))) throw new Error(`La copia del programa no debe tener ${prohibido}`);
  }
  return app;
}

// ── Entorno de cada empresa ─────────────────────────────────────────────────

// Token del gateway e-CF de la empresa (lo deja alta-empresa.ps1): con él los
// pasos 9 y 11 ven lo que la DGII mandó al gateway.
function tokenGateway(rnc) {
  const archivo = path.join(GATEWAY_TOKENS, `${rnc}-token.txt`);
  if (!fs.existsSync(archivo)) return null;
  const valores = {};
  for (const linea of fs.readFileSync(archivo, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = linea.match(/^\s*(ECF_GATEWAY_BASE_URL|ECF_GATEWAY_TOKEN)\s*=\s*(.+?)\s*$/);
    if (m) valores[m[1]] = m[2];
  }
  return valores.ECF_GATEWAY_TOKEN ? { ...valores, archivo, fecha: fs.statSync(archivo).mtimeMs } : null;
}

function entorno(emp, { url = '' } = {}) {
  const r = rutas(emp.rnc);
  const cfg = configuracion();
  const env = { ...process.env };
  // Nada de la configuración de Emilio (Firebase, licencia, DGII, certificado, base de datos…).
  for (const k of Object.keys(env)) {
    if (/^(FIREBASE_|GOOGLE_APPLICATION|TECNO_CAJA_|DB_|POS_|R2_|B2_|BACKBLAZE|DGII_|CERT_|ECF_|FISCAL_|CORS_|GH_|ADMIN_|ELECTRON_RUN_AS_NODE)/i.test(k)) delete env[k];
  }
  const gw = tokenGateway(emp.rnc);
  return {
    ...env,
    DB_CLIENT: 'sqlite',
    PORT: String(emp.puerto),
    TECNO_CAJA_USER_DATA: r.datos,
    E2E_APP: path.join(PROGRAMA, 'app'),
    USERPROFILE: r.usuario,
    HOME: r.usuario,
    PUPPETEER_CACHE_DIR: PUPPETEER_CACHE,
    FISCAL_CERT_SECRET: cfg.secretoFiscal,
    TECNO_CAJA_SECURITY_PASSWORD: cfg.claveRespaldos,
    POS_BIND_HOST: '127.0.0.1',
    POS_ALLOW_LAN: 'false',
    CORS_ALLOWED_ORIGINS: url,
    CERT_RNC: emp.rnc,
    CERT_NOMBRE: emp.nombre,
    ...(gw ? { ECF_GATEWAY_BASE_URL: gw.ECF_GATEWAY_BASE_URL || '', ECF_GATEWAY_TOKEN: gw.ECF_GATEWAY_TOKEN } : {}),
  };
}

// Como electron/main.js: la base de datos y el puerto se leen de config/app.env.
function escribirAppEnv(emp) {
  const r = rutas(emp.rnc);
  fs.mkdirSync(path.join(r.datos, 'config'), { recursive: true });
  fs.writeFileSync(path.join(r.datos, 'config', 'app.env'),
    ['DB_CLIENT=sqlite', `PORT=${emp.puerto}`, 'POS_ALLOW_LAN=false', 'POS_BIND_HOST=127.0.0.1'].join('\n') + '\n');
}

// ── HTTP al POS de cada empresa ─────────────────────────────────────────────

function pedir(puerto, metodo, ruta, cuerpo = null, token = '', ms = 60000) {
  return new Promise((resolve, reject) => {
    const data = cuerpo ? JSON.stringify(cuerpo) : null;
    const req = http.request({
      host: '127.0.0.1', port: puerto, method: metodo, path: ruta, timeout: ms,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { let body = null; try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = { raw: raw.slice(0, 300) }; } resolve({ status: res.statusCode, body }); });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('tiempo agotado')));
    if (data) req.write(data);
    req.end();
  });
}

async function esperarPos(puerto, ms = 240000) {
  const inicio = Date.now();
  while (Date.now() - inicio < ms) {
    try { const r = await pedir(puerto, 'GET', '/api/setup/status', null, '', 5000); if (r.status > 0) return r; } catch (_) { /* arrancando */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`El POS de la empresa no respondió en el puerto ${puerto}.`);
}

// ── Procesos: POS y túnel ───────────────────────────────────────────────────

function arrancarPos(emp, url) {
  const r = rutas(emp.rnc);
  fs.mkdirSync(r.logs, { recursive: true });
  for (const d of [path.join(r.usuario, 'Documents'), path.join(r.usuario, 'Downloads')]) fs.mkdirSync(d, { recursive: true });
  escribirAppEnv(emp);
  const salida = fs.createWriteStream(path.join(r.logs, 'pos.log'), { flags: 'a' });
  salida.write(`\n===== ${new Date().toISOString()} arranque (dirección: ${url || 'solo esta PC'}) =====\n`);
  const proc = spawn(process.execPath, [path.join(__dirname, 'lanzar-pos.js')], {
    cwd: r.raiz, env: entorno(emp, { url }), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  proc.stdout.pipe(salida);
  proc.stderr.pipe(salida);
  return proc;
}

// Guarda la base antes de salir (en Windows matar el proceso pierde lo último).
function apagarPos(proc, ms = 10000) {
  if (!proc || proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { proc.kill(); } catch (_) { /* ya salió */ } resolve(); }, ms);
    proc.once('exit', () => { clearTimeout(t); resolve(); });
    try { proc.send({ tipo: 'apagar' }); } catch (_) { try { proc.kill(); } catch (__) { /* ya salió */ } }
  });
}

function rutaCloudflared() {
  const enPath = spawnSync('where', ['cloudflared'], { encoding: 'utf8', windowsHide: true });
  if (enPath.status === 0 && enPath.stdout.trim()) return enPath.stdout.trim().split(/\r?\n/)[0];
  const local = path.join(PROYECTO, 'tools', 'cloudflared.exe');
  return fs.existsSync(local) ? local : null;
}
const CLOUDFLARED = rutaCloudflared();

// Túnel rápido (sin cuenta): da una dirección https nueva cada vez.
function abrirTunel(emp) {
  if (!CLOUDFLARED) return Promise.resolve({ proc: null, url: '', error: 'cloudflared no está instalado (winget install Cloudflare.cloudflared).' });
  const r = rutas(emp.rnc);
  fs.mkdirSync(r.logs, { recursive: true });
  const salida = fs.createWriteStream(path.join(r.logs, 'tunel.log'), { flags: 'a' });
  const proc = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${emp.puerto}`], { windowsHide: true });
  return new Promise((resolve) => {
    let texto = '';
    let listo = false;
    const fin = (res) => { if (!listo) { listo = true; resolve(res); } };
    const t = setTimeout(() => fin({ proc, url: '', error: 'Cloudflare no dio dirección (sin Internet o límite de túneles rápidos). Prueba «Nueva dirección».' }), 60000);
    const leer = (d) => {
      salida.write(d);
      texto += d.toString();
      const m = texto.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { clearTimeout(t); fin({ proc, url: m[0], error: '' }); }
    };
    proc.stdout.on('data', leer);
    proc.stderr.on('data', leer);
    proc.on('exit', () => { clearTimeout(t); fin({ proc: null, url: '', error: 'El túnel se cerró al arrancar.' }); });
  });
}

function cerrarTunel(proc) {
  if (proc && proc.exitCode === null) { try { proc.kill(); } catch (_) { /* ya salió */ } }
}

// Licencia local de la copia (ver licencia.js); se renueva en cada arranque.
function sembrarLicencia(emp) {
  const r = rutas(emp.rnc);
  escribirAppEnv(emp);
  const res = spawnSync(process.execPath, [path.join(__dirname, 'licencia.js')], {
    cwd: r.raiz, env: entorno(emp), encoding: 'utf8', windowsHide: true, timeout: 180000,
  });
  if (res.status !== 0) throw new Error(`No se pudo preparar la licencia local: ${String(res.stderr || res.stdout || '').slice(-300)}`);
}

// ── Encender / apagar / crear ───────────────────────────────────────────────

const ocupada = new Set();    // con una acción en curso (no aceptar otra)
const preparando = new Set(); // empresas nuevas que todavía se están preparando

async function encender(emp) {
  const v = vivo.get(emp.rnc) || {};
  if (v.pos && v.pos.exitCode === null) return;
  vivo.set(emp.rnc, { estado: 'encendiendo', error: '', url: '' });
  try {
    sembrarLicencia(emp);
    const t = await abrirTunel(emp);
    const pos = arrancarPos(emp, t.url);
    const estado = { pos, tunel: t.proc, url: t.url, estado: 'encendiendo', error: t.error, desde: Date.now(), gateway: tokenGateway(emp.rnc)?.fecha || null };
    vivo.set(emp.rnc, estado);
    pos.on('exit', (code) => {
      const ahora = vivo.get(emp.rnc);
      if (ahora?.pos !== pos) return;
      cerrarTunel(ahora.tunel);
      vivo.set(emp.rnc, { estado: 'apagada', error: code ? `El POS se cerró (código ${code}). Revisa ${path.join(rutas(emp.rnc).logs, 'pos.log')}` : '' });
    });
    await esperarPos(emp.puerto);
    if (vivo.get(emp.rnc)?.pos === pos) vivo.get(emp.rnc).estado = 'lista';
    log(`${emp.nombre} (${emp.rnc}) lista en http://127.0.0.1:${emp.puerto}${t.url ? ` · ${t.url}` : ''}`);
  } catch (error) {
    const v2 = vivo.get(emp.rnc) || {};
    await apagarPos(v2.pos);
    cerrarTunel(v2.tunel);
    vivo.set(emp.rnc, { estado: 'error', error: error.message });
    log(`${emp.nombre}: ${error.message}`);
  }
}

async function apagar(emp) {
  const v = vivo.get(emp.rnc);
  if (!v) return;
  vivo.set(emp.rnc, { ...v, estado: 'apagando' });
  await apagarPos(v.pos);
  cerrarTunel(v.tunel);
  vivo.set(emp.rnc, { estado: 'apagada', error: '' });
}

function claveNueva() {
  const letras = 'abcdefghjkmnpqrstuvwxyz';
  const parte = Array.from(crypto.randomBytes(5), (b) => letras[b % letras.length]).join('');
  return `Cert-${parte}${crypto.randomInt(1000, 9999)}`;
}

async function crearEmpresa({ nombre, rnc }) {
  const limpio = String(rnc || '').replace(/\D/g, '');
  const nom = String(nombre || '').trim().slice(0, 120);
  if (![9, 11].includes(limpio.length)) throw Object.assign(new Error('El RNC o cédula debe tener 9 u 11 dígitos.'), { status: 400 });
  if (!nom) throw Object.assign(new Error('Escribe el nombre de la empresa.'), { status: 400 });
  if (empresas.some((e) => e.rnc === limpio)) throw Object.assign(new Error('Esa empresa ya está en el servidor.'), { status: 409 });
  const puerto = Math.max(PRIMER_PUERTO - 1, ...empresas.map((e) => e.puerto)) + 1;
  const emp = {
    rnc: limpio, nombre: nom, puerto, activa: true, creada: new Date().toISOString(), lista: false,
    usuarios: [
      { rol: 'Emilio', nombre: 'Emilio', usuario: 'emilio', clave: claveNueva() },
      { rol: 'Contable', nombre: 'Contable', usuario: 'contable', clave: claveNueva() },
    ],
  };
  const r = rutas(limpio);
  if (fs.existsSync(r.datos)) {
    throw Object.assign(new Error(`Ya existe la carpeta ${r.raiz}. Muévela o bórrala a mano si quieres empezar de cero.`), { status: 409 });
  }
  empresas.push(emp);
  guardarEmpresas();
  prepararEmpresa(emp).catch(() => {});
  return emp;
}

// Instalación nueva: asistente inicial, licencia local, encender y usuario del contable.
async function prepararEmpresa(emp) {
  ocupada.add(emp.rnc);
  preparando.add(emp.rnc);
  vivo.set(emp.rnc, { estado: 'creando', error: '' });
  let pos = null;
  try {
    const [emilio, contable] = emp.usuarios;
    // Si se cortó a medias, se sigue donde quedó (sin repetir el asistente).
    if (!emp.asistenteListo) {
      pos = arrancarPos(emp, '');
      const estado = await esperarPos(emp.puerto);
      if (estado.body?.setupRequired !== false) {
        const setup = await pedir(emp.puerto, 'POST', '/api/setup/complete', {
          language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja', businessName: emp.nombre,
          adminName: emilio.nombre, adminUser: emilio.usuario, adminEmail: `cert${emp.rnc}@tecnocaja.test`, adminPassword: emilio.clave,
          openingAmount: 1000, currency: 'RD$',
        });
        if (setup.status !== 201) throw new Error(`Asistente inicial: ${setup.body?.error || `HTTP ${setup.status}`}`);
      }
      await new Promise((r) => setTimeout(r, 2500)); // que SQLite termine de escribir
      await apagarPos(pos);
      pos = null;
      emp.asistenteListo = true;
      guardarEmpresas();
    }
    vivo.delete(emp.rnc);
    await encender(emp);
    if (vivo.get(emp.rnc)?.estado !== 'lista') throw new Error(vivo.get(emp.rnc)?.error || 'No encendió.');
    const login = await pedir(emp.puerto, 'POST', '/api/login', { usuario: emilio.usuario, password: emilio.clave });
    const token = login.body?.token;
    if (!token) throw new Error(`No se pudo entrar como ${emilio.usuario}: ${login.body?.error || login.status}`);
    const datos = login.body.data || {};
    const yaEntra = await pedir(emp.puerto, 'POST', '/api/login', { usuario: contable.usuario, password: contable.clave });
    if (!yaEntra.body?.token) {
      const nuevo = await pedir(emp.puerto, 'POST', '/api/users', {
        nombre: contable.nombre, usuario: contable.usuario, password: contable.clave, roleCode: 'administrador_general', estado: 'Activo',
        branchId: datos.sucursales?.[0]?.id, cashRegisterId: datos.cajasSucursal?.[0]?.id,
      }, token);
      if (![200, 201].includes(nuevo.status)) throw new Error(`Usuario del contable: ${nuevo.body?.error || `HTTP ${nuevo.status}`}`);
    }
    emp.lista = true;
    guardarEmpresas();
    log(`Empresa nueva lista: ${emp.nombre} (${emp.rnc})`);
  } catch (error) {
    await apagarPos(pos);
    const v = vivo.get(emp.rnc) || {};
    vivo.set(emp.rnc, { ...v, estado: v.estado === 'lista' ? 'lista' : 'error', error: `No se terminó de preparar: ${error.message}` });
    log(`${emp.nombre}: ${error.message}`);
  } finally {
    ocupada.delete(emp.rnc);
    preparando.delete(emp.rnc);
  }
}

// ── Lo que muestra el panel ─────────────────────────────────────────────────

function progreso(emp) {
  const s = leerJson(path.join(rutas(emp.rnc).datos, 'storage', 'ecf', 'cert-wizard-state.json'), null);
  if (!s) return { paso: 1, completos: 0, terminado: false };
  const completos = Array.isArray(s.completedSteps) ? s.completedSteps.length : 0;
  return { paso: Number(s.currentStep || 1), completos, terminado: Boolean(s.finishedAt) || completos >= 15 };
}

function vistaEmpresa(emp) {
  const v = vivo.get(emp.rnc) || { estado: 'apagada', error: '' };
  const gw = tokenGateway(emp.rnc);
  return {
    rnc: emp.rnc, nombre: emp.nombre, puerto: emp.puerto, activa: emp.activa !== false, lista: emp.lista,
    local: `http://127.0.0.1:${emp.puerto}`, url: v.url || '', estado: preparando.has(emp.rnc) && v.estado !== 'error' ? 'creando' : v.estado,
    error: v.error || '', usuarios: emp.usuarios, progreso: progreso(emp),
    gateway: gw ? { listo: true, reiniciar: Boolean(v.pos) && gw.fecha > (v.gateway || 0) } : { listo: false },
    altaComando: `powershell -ExecutionPolicy Bypass -File "${ALTA_GATEWAY}" -Rnc ${emp.rnc} -P12 "RUTA\\DEL\\CERTIFICADO.p12" -Nombre "${emp.nombre.replace(/"/g, '')}"`,
    carpeta: rutas(emp.rnc).raiz,
  };
}

// ── Panel (solo en esta PC) ─────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '20kb' }));
// Las acciones exigen esta cabecera: una página de Internet no puede mandarla sin permiso (CORS).
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('X-Panel') !== 'certificacion') return res.status(403).json({ error: 'No permitido.' });
  next();
});
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'panel.html')));
app.get('/api/estado', (_req, res) => {
  res.json({ cloudflared: Boolean(CLOUDFLARED), carpeta: BASE, empresas: empresas.map(vistaEmpresa) });
});
app.post('/api/empresas', async (req, res) => {
  try { res.status(201).json(vistaEmpresa(await crearEmpresa(req.body || {}))); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
const accion = (fn) => async (req, res) => {
  const emp = empresas.find((e) => e.rnc === req.params.rnc);
  if (!emp) return res.status(404).json({ error: 'No existe esa empresa.' });
  if (ocupada.has(emp.rnc)) return res.status(409).json({ error: 'Esa empresa está ocupada. Espera un momento.' });
  ocupada.add(emp.rnc);
  try { await fn(emp); res.json(vistaEmpresa(emp)); } catch (e) { res.status(500).json({ error: e.message }); } finally { ocupada.delete(emp.rnc); }
};
app.post('/api/empresas/:rnc/encender', accion(async (emp) => { emp.activa = true; guardarEmpresas(); await encender(emp); }));
app.post('/api/empresas/:rnc/apagar', accion((emp) => apagar(emp)));
app.post('/api/empresas/:rnc/reiniciar', accion(async (emp) => { await apagar(emp); await encender(emp); }));
app.post('/api/empresas/:rnc/terminar', accion(async (emp) => { emp.activa = false; guardarEmpresas(); await apagar(emp); }));
app.post('/api/empresas/:rnc/carpeta', accion(async (emp) => { execFileSync('explorer.exe', [rutas(emp.rnc).raiz]); }));

let cerrando = false;
async function cerrarTodo() {
  if (cerrando) return;
  cerrando = true;
  log('Apagando las empresas (guardando sus bases)…');
  await Promise.all([...vivo.values()].map(async (v) => { await apagarPos(v.pos); cerrarTunel(v.tunel); }));
  process.exit(0);
}
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(s, cerrarTodo);

(async () => {
  fs.mkdirSync(EMPRESAS_DIR, { recursive: true });
  configuracion();
  log('Preparando la copia del programa (sin .env ni certificados)…');
  prepararPrograma();
  app.listen(PANEL_PORT, '127.0.0.1', () => {
    log(`Panel: http://127.0.0.1:${PANEL_PORT}  (cierra con Ctrl+C para guardar todo)`);
    if (!CLOUDFLARED) log('Aviso: falta cloudflared; las empresas solo se verán en esta PC.');
    if (process.env.TC_CERT_SIN_NAVEGADOR !== '1') {
      try { spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${PANEL_PORT}`], { windowsHide: true, detached: true, stdio: 'ignore' }).unref(); } catch (_) { /* sin navegador */ }
    }
  });
  // Una a una, para no cargar la PC: las activas que ya estaban preparadas.
  for (const emp of empresas.filter((e) => e.activa !== false)) {
    if (emp.lista) await encender(emp);
    else await prepararEmpresa(emp);
  }
})().catch((e) => { console.error(e); process.exit(1); });
