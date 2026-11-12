'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
const start = source.indexOf('async function waitForPrintWindowReady(');
const end = source.indexOf('\nfunction sanitizeReceiptPrintOptions', start);
const ctx = vm.createContext({});
vm.runInContext(source.slice(start, end), ctx);

function ready(document) {
  const executeJavaScript = (code) => vm.runInNewContext(code, { document, setTimeout, clearTimeout });
  return ctx.waitForPrintWindowReady({ isDestroyed: () => false, webContents: { executeJavaScript } });
}

test('una imagen fallida que ya terminó no detiene la impresión', async () => {
  const addEventListener = jest.fn();
  await ready({ images: [{ complete: true, naturalWidth: 0, addEventListener }], body: { getBoundingClientRect() {} } });
  expect(addEventListener).not.toHaveBeenCalled();
});

test('espera el logo, el QR y las fuentes antes de entregar el documento al driver', async () => {
  const listeners = [];
  let fontReady;
  const fonts = { ready: new Promise((resolve) => { fontReady = resolve; }) };
  const img = () => ({ complete: false, addEventListener: (event, done) => { if (event === 'load') listeners.push(done); } });
  let finished = false;
  const job = ready({ images: [img(), img()], fonts, body: { getBoundingClientRect() {} } }).then(() => { finished = true; });
  listeners[0](); fontReady();
  await new Promise(setImmediate);
  expect(finished).toBe(false);
  listeners[1]();
  await job;
  expect(finished).toBe(true);
});
