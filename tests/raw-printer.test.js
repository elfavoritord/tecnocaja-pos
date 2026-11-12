'use strict';

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createRawPrinter } = require('../electron/raw-printer');
const tick = () => new Promise(setImmediate);

function transport(options = {}) {
  const children = [];
  const spawnProcess = jest.fn(() => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.jobs = [];
    child.stdin.on('data', (chunk) => child.jobs.push(JSON.parse(chunk.toString())));
    child.reply = (message) => child.stdout.write(JSON.stringify(message) + '\n');
    child.kill = jest.fn(() => { child.emit('exit', 0); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
    children.push(child);
    queueMicrotask(() => child.reply({ ready: true }));
    return child;
  });
  const printer = createRawPrinter({ spawnProcess, prepareScript: () => 'worker.ps1', ...options });
  return { printer, spawnProcess, children };
}

describe('transporte RAW reutilizable', () => {
  const instances = [];
  const make = (options) => { const t = transport(options); instances.push(t); return t; };
  afterEach(() => { for (const t of instances.splice(0)) t.printer.close(); });

  test('reutiliza PowerShell, conserva bytes y ordena recibo y gaveta en la misma impresora', async () => {
    const t = make();
    const bytes = Buffer.from([0x1b, 0x40, 0xa4, 0, 0xff]);
    const one = t.printer.send('EPSON Caja 1', bytes);
    const two = t.printer.send('EPSON Caja 1', Buffer.from('segundo'));
    await tick();
    const child = t.children[0];
    expect(child.jobs).toHaveLength(1);
    expect(Buffer.from(child.jobs[0].data, 'base64')).toEqual(bytes);
    child.reply({ id: child.jobs[0].id, ok: true, jobId: 42 });
    expect(await one).toMatchObject({ ok: true, jobId: 42 });
    await tick();
    expect(child.jobs).toHaveLength(2);
    child.reply({ id: child.jobs[1].id, ok: true });
    expect((await two).ok).toBe(true);
    expect(t.spawnProcess).toHaveBeenCalledTimes(1);
    expect(t.spawnProcess.mock.calls[0][2]).toMatchObject({ windowsHide: true });
  });

  test('otra impresora imprime sin esperar a la que está ocupada', async () => {
    const t = make();
    const a = t.printer.send('Caja A', Buffer.from('a'));
    const b = t.printer.send('Caja B', Buffer.from('b'));
    await tick();
    expect(t.children).toHaveLength(2);
    const second = t.children[1];
    second.reply({ id: second.jobs[0].id, ok: true });
    expect((await b).ok).toBe(true);
    const first = t.children[0];
    first.reply({ id: first.jobs[0].id, ok: true });
    await a;
  });

  test('un error de spooler se informa sin reenviar ni duplicar el recibo', async () => {
    const t = make();
    const job = t.printer.send('Caja', Buffer.from('a'));
    await tick();
    t.children[0].reply({ id: t.children[0].jobs[0].id, ok: false, error: 'OpenPrinter fallo' });
    expect(await job).toMatchObject({ ok: false, error: 'OpenPrinter fallo' });
    expect(t.children[0].jobs).toHaveLength(1);
  });

  test('tras caerse el proceso, el siguiente trabajo inicia otro sin repetir el anterior', async () => {
    const t = make();
    const first = t.printer.send('Caja', Buffer.from('a'));
    await tick();
    t.children[0].emit('exit', 1);
    expect((await first).ok).toBe(false);
    const next = t.printer.send('Caja', Buffer.from('b'));
    await tick();
    expect(t.children).toHaveLength(2);
    expect(Buffer.from(t.children[1].jobs[0].data, 'base64').toString()).toBe('b');
    t.children[1].reply({ id: t.children[1].jobs[0].id, ok: true });
    await next;
  });

  test('un tiempo agotado no reimprime y no deja bloqueada la cola', async () => {
    const t = make({ jobTimeout: 15 });
    const result = await t.printer.send('Caja', Buffer.from('a'));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Revisa la cola') });
    expect(t.children[0].jobs).toHaveLength(1);
    expect(t.children[0].kill).toHaveBeenCalledTimes(1);
  });

  test('rechaza datos vacíos y no vuelve a iniciar procesos al cerrar la app', async () => {
    const t = make();
    expect((await t.printer.send('', Buffer.from('a'))).ok).toBe(false);
    t.printer.close();
    expect((await t.printer.send('Caja', Buffer.from('a'))).ok).toBe(false);
    expect(t.spawnProcess).not.toHaveBeenCalled();
  });

  test('limita procesos inactivos sin dejar abiertas todas las impresoras usadas', async () => {
    const t = make({ maxIdle: 1 });
    for (const name of ['Caja A', 'Caja B']) {
      const job = t.printer.send(name, Buffer.from(name));
      await tick();
      const child = t.children[t.children.length - 1];
      child.reply({ id: child.jobs[0].id, ok: true });
      await job;
    }
    expect(t.children[0].kill).toHaveBeenCalledTimes(1);
    expect(t.children[1].kill).not.toHaveBeenCalled();
  });
});
