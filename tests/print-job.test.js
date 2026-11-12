'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
const start = source.indexOf('function sanitizeReceiptPrintOptions(');
const end = source.indexOf('\nfunction waitForServer(', start);
const ctx = vm.createContext({ setTimeout: (...args) => setTimeout(...args), clearTimeout: (...args) => clearTimeout(...args) });
vm.runInContext(source.slice(start, end), ctx);

function windowForPrint() {
  const contents = new EventEmitter();
  contents.print = jest.fn();
  return { webContents: contents, isDestroyed: () => false, destroy: jest.fn() };
}

afterEach(() => jest.useRealTimers());

test.each([['58mm', 58000], ['80mm', 80000]])('la impresión directa conserva el papel %s y la impresora elegida', async (_paper, width) => {
  const w = windowForPrint();
  w.webContents.print.mockImplementation((_options, done) => done(true));
  const options = { silent: true, deviceName: 'Caja 2', pageSize: { width, height: 100000 }, copies: 1 };
  expect((await ctx.runReceiptPrintJob(w, options, { preservePageSize: true })).ok).toBe(true);
  expect(w.webContents.print.mock.calls[0][0]).toMatchObject(options);
  expect(w.webContents.listenerCount('destroyed')).toBe(0);
});

test('el diálogo A4 respeta el driver y las etiquetas conservan su tamaño físico', () => {
  const a4 = ctx.sanitizeReceiptPrintOptions({ silent: false, pageSize: 'A4' });
  expect(a4.usePrinterDefaultPageSize).toBe(true);
  expect(a4.pageSize).toBeUndefined();
  const label = ctx.sanitizeReceiptPrintOptions({ silent: false, pageSize: { width: 50000, height: 30000 } }, { preservePageSize: true });
  expect(label.pageSize).toEqual({ width: 50000, height: 30000 });
});

test('si el renderer se cae finaliza con error y no intenta imprimir otra vez', async () => {
  const w = windowForPrint();
  const job = ctx.runReceiptPrintJob(w, { silent: true });
  w.webContents.emit('render-process-gone');
  expect(await job).toMatchObject({ ok: false });
  expect(w.destroy).toHaveBeenCalledTimes(1);
  expect(w.webContents.print).toHaveBeenCalledTimes(1);
});

test('un driver bloqueado libera la cola y descarta la ventana sin reimprimir', async () => {
  jest.useFakeTimers();
  const w = windowForPrint();
  const job = ctx.runReceiptPrintJob(w, { silent: true });
  jest.advanceTimersByTime(30000);
  expect(await job).toMatchObject({ ok: false, error: expect.stringContaining('Revisa la cola') });
  expect(w.destroy).toHaveBeenCalledTimes(1);
  expect(w.webContents.print).toHaveBeenCalledTimes(1);
});

test('el usuario puede tardar en el diálogo sin que se cancele ni se cambie de impresora', async () => {
  jest.useFakeTimers();
  const w = windowForPrint();
  const job = ctx.runReceiptPrintJob(w, { silent: false, deviceName: 'HP oficina' });
  jest.advanceTimersByTime(90000);
  expect(w.destroy).not.toHaveBeenCalled();
  w.webContents.print.mock.calls[0][1](false, 'cancelled');
  expect(await job).toMatchObject({ ok: false, error: 'cancelled' });
  expect(w.webContents.print).toHaveBeenCalledTimes(1);
});
