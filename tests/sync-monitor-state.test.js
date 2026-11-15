'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let monitor;
beforeAll(() => {
  monitor = vm.createContext({ document: { readyState: 'loading', addEventListener() {} }, window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/sync-monitor.js'), 'utf8'), monitor);
});
test('con Internet y pendientes, Firebase no disponible se muestra como bloqueado y no enviando', () => {
  const state = monitor._describeConnectivity({ internet: { online: true }, cloud: { ready: false }, pending: { cloud: 5 } });
  expect(state.state).toBe('offline');
  expect(state.label).toContain('5 pendientes');
  expect(state.detail).toContain('Firebase no está listo');
  expect(state.detail).not.toContain('Enviando');
});
test('con Firebase listo, conserva el estado de cambios pendientes', () => {
  expect(monitor._describeConnectivity({ internet: { online: true }, cloud: { ready: true }, pending: { cloud: 5 } }).state).toBe('pending');
});
test('sin Internet conserva el diagnóstico local', () => {
  expect(monitor._describeConnectivity({ internet: { online: false }, cloud: { ready: false }, pending: { cloud: 5 } }).state).toBe('local');
});
test('los mensajes de error del servidor se escapan al mostrarlos en el monitor', () => {
  const html = monitor._statusRow('Error de sincronización', '<script>alert(1)</script>', 'danger');
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
});
