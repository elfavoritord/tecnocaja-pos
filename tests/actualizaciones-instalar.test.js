'use strict';

/**
 * Botón "Instalar ahora" del actualizador (js/actualizaciones.js).
 *
 * Hasta v1.4.4 el renderer pedía el respaldo previo con fetch SIN sesión;
 * desde v1.4.2 ese endpoint exige sesión → 401 → la actualización nunca
 * arrancaba y había que usar el instalador a mano. Ahora el respaldo, el
 * cierre y el instalador los hace el proceso principal (updaterInstall).
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'js', 'actualizaciones.js'), 'utf8');

function fakeElement(id = '') {
  return {
    id,
    innerHTML: '',
    textContent: '',
    className: '',
    disabled: false,
    dataset: {},
    style: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(child) { this.children.push(child); return child; },
    querySelector: () => null,
    setAttribute() {},
    remove() {},
  };
}

function cargarActualizador({ installResults, confirmar = [] }) {
  const elementos = new Map();
  const document = {
    getElementById(id) {
      if (id === 'setup-update-overlay') return null; // no es el asistente inicial
      if (!elementos.has(id)) elementos.set(id, fakeElement(id));
      return elementos.get(id);
    },
    querySelectorAll: () => [],
    createElement: () => fakeElement(),
    body: fakeElement('body'),
  };
  const almacen = { tecnocaja_update_prefs: JSON.stringify({ autoCheck: false }) };
  let emitir = null;
  const respuestas = [...installResults];
  const confirmaciones = [...confirmar];
  const ctx = {
    document,
    console,
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: (k) => (k in almacen ? almacen[k] : null),
      setItem: (k, v) => { almacen[k] = String(v); },
    },
    fetch: jest.fn(async () => ({ ok: true, json: async () => ({}) })),
    showDeleteConfirm: jest.fn(async () => (confirmaciones.length ? confirmaciones.shift() : true)),
    showToast: jest.fn(),
    novaDesktop: {
      updaterCheck: jest.fn(async () => ({ ok: true })),
      updaterDownload: jest.fn(async () => ({ ok: true })),
      updaterGetVersion: jest.fn(async () => ({ version: '1.4.5', isPackaged: true })),
      updaterInstall: jest.fn(async () => respuestas.shift() || { ok: true }),
      updaterOnEvent: (cb) => { emitir = cb; return () => {}; },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SCRIPT, ctx);
  return {
    ctx,
    estado: () => document.getElementById('upd-status-badge').innerHTML,
    emitir: (...args) => emitir(...args),
    historial: () => JSON.parse(almacen.tecnocaja_update_history || '[]'),
  };
}

async function listoParaInstalar(opts) {
  const u = cargarActualizador(opts);
  await u.ctx.Actualizaciones.init();
  u.emitir('downloaded', { version: '1.4.6' });
  expect(u.estado()).toMatch(/Lista para instalar/);
  return u;
}

test('instala sin pedir el respaldo por fetch: lo hace el proceso principal', async () => {
  const u = await listoParaInstalar({ installResults: [{ ok: true }] });
  await u.ctx.Actualizaciones.installUpdate();
  expect(u.ctx.fetch).not.toHaveBeenCalled();
  expect(u.ctx.novaDesktop.updaterInstall).toHaveBeenCalledTimes(1);
  expect(u.ctx.novaDesktop.updaterInstall).toHaveBeenCalledWith({ skipBackup: false });
  expect(u.estado()).toMatch(/Instalando/);
  expect(u.historial()[0]).toMatchObject({ version: '1.4.6' });
});

test('si el respaldo falla pregunta y, si acepta, instala sin respaldo', async () => {
  const u = await listoParaInstalar({
    installResults: [{ ok: false, backupFailed: true, error: 'disco lleno' }, { ok: true }],
    confirmar: [true, true],
  });
  await u.ctx.Actualizaciones.installUpdate();
  expect(u.ctx.showDeleteConfirm).toHaveBeenCalledTimes(2);
  expect(u.ctx.showDeleteConfirm.mock.calls[1][0]).toMatch(/disco lleno/);
  expect(u.ctx.novaDesktop.updaterInstall.mock.calls).toEqual([[{ skipBackup: false }], [{ skipBackup: true }]]);
  expect(u.estado()).toMatch(/Instalando/);
});

test('si el respaldo falla y no acepta, no instala y se puede reintentar', async () => {
  const u = await listoParaInstalar({
    installResults: [{ ok: false, backupFailed: true, error: 'disco lleno' }, { ok: true }],
    confirmar: [true, false, true],
  });
  await u.ctx.Actualizaciones.installUpdate();
  expect(u.ctx.novaDesktop.updaterInstall).toHaveBeenCalledTimes(1);
  expect(u.estado()).toMatch(/Lista para instalar/);
  // Reintento con el mismo botón (antes quedaba en "error" y no hacía nada).
  await u.ctx.Actualizaciones.installUpdate();
  expect(u.ctx.novaDesktop.updaterInstall).toHaveBeenCalledTimes(2);
});

test('un error del instalador deja el botón listo para reintentar', async () => {
  const u = await listoParaInstalar({
    installResults: [{ ok: false, error: 'La actualización todavía no terminó de descargarse.' }, { ok: true }],
  });
  await u.ctx.Actualizaciones.installUpdate();
  expect(u.estado()).toMatch(/Lista para instalar/);
  await u.ctx.Actualizaciones.installUpdate();
  expect(u.ctx.novaDesktop.updaterInstall).toHaveBeenCalledTimes(2);
  expect(u.estado()).toMatch(/Instalando/);
});

test('respeta la opción "Respaldo antes de actualizar" apagada', async () => {
  const u = cargarActualizador({ installResults: [{ ok: true }] });
  u.ctx.localStorage.setItem('tecnocaja_update_prefs', JSON.stringify({ autoCheck: false, backupBeforeUpdate: false }));
  await u.ctx.Actualizaciones.init();
  u.emitir('downloaded', { version: '1.4.6' });
  await u.ctx.Actualizaciones.installUpdate();
  expect(u.ctx.novaDesktop.updaterInstall).toHaveBeenCalledWith({ skipBackup: true });
});
