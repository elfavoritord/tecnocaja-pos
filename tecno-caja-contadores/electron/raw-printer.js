'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const { enqueuePrinterJob } = require('./printer-queue');

function prepareWorkerScript() {
  // PowerShell no puede leer dentro de app.asar; extraer el helper una vez.
  const directory = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Tecno Caja');
  const target = path.join(directory, 'rawprint-worker-v2.ps1');
  // Windows PowerShell 5 necesita BOM para conservar el español del helper.
  const source = '\uFEFF' + fs.readFileSync(path.join(__dirname, 'raw-print-worker.ps1'), 'utf8').replace(/^\uFEFF/, '');
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== source) fs.writeFileSync(target, source, 'utf8');
  return target;
}

function createRawPrinter({ spawnProcess = spawn, prepareScript = prepareWorkerScript, startupTimeout = 45000, jobTimeout = 12000, idleTimeout = 120000, maxIdle = 3 } = {}) {
  const workers = new Map();
  let sequence = 0;
  let closed = false;

  function start(name, key) {
    const child = spawnProcess('powershell.exe', ['-NoLogo', '-NonInteractive', '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', prepareScript(), name], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const worker = { child, pending: null, dead: false, idle: null };
    workers.set(key, worker);
    let readyResolve;
    let readyReject;
    worker.ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const startupTimer = setTimeout(() => fail('No se pudo preparar la impresión en 45 segundos.'), startupTimeout);
    const lines = readline.createInterface({ input: child.stdout });
    let stderr = '';

    function fail(message) {
      if (worker.dead) return;
      worker.dead = true;
      clearTimeout(startupTimer);
      clearTimeout(worker.idle);
      if (workers.get(key) === worker) workers.delete(key);
      readyReject(new Error(message));
      if (worker.pending) {
        clearTimeout(worker.pending.timer);
        worker.pending.resolve({ ok: false, error: message });
        worker.pending = null;
      }
      lines.close();
      child.kill();
    }
    worker.stop = () => fail('El servicio de impresión se cerró.');
    child.stderr.on('data', (data) => { stderr = (stderr + data.toString()).slice(-2000); });
    child.on('error', (error) => fail(`No se pudo iniciar la impresión: ${error.message}`));
    child.stdin.on('error', (error) => fail(`Se interrumpió la impresión: ${error.message}`));
    child.on('exit', () => fail(stderr.trim() || 'El servicio de impresión terminó antes de confirmar el envío. Revisa la cola de Windows antes de repetir.'));
    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch (_) { return; }
      if (message.fatal) { fail(message.error || 'No se pudo preparar la impresión.'); return; }
      if (message.ready) { clearTimeout(startupTimer); readyResolve(); return; }
      if (!worker.pending || message.id !== worker.pending.id) return;
      clearTimeout(worker.pending.timer);
      worker.pending.resolve({ ok: Boolean(message.ok), error: message.error || null, jobId: message.jobId });
      worker.pending = null;
    });
    worker.print = (data) => new Promise((resolve) => {
      const id = ++sequence;
      const timer = setTimeout(() => fail('La impresora no confirmó el envío a tiempo. Revisa la cola de Windows antes de repetir.'), jobTimeout);
      worker.pending = { id, timer, resolve };
      try { child.stdin.write(`${JSON.stringify({ id, data: data.toString('base64') })}\n`); }
      catch (error) { fail(`Se interrumpió la impresión: ${error.message}`); }
    });
    return worker;
  }

  function send(printerName, data) {
    const name = String(printerName || '').trim();
    if (!name || !Buffer.isBuffer(data) || !data.length) return Promise.resolve({ ok: false, error: 'Falta la impresora o el contenido a imprimir.' });
    const key = name.toLowerCase();
    return enqueuePrinterJob(key, async () => {
      let worker;
      try {
        if (closed) throw new Error('El servicio de impresión se cerró.');
        worker = workers.get(key) || start(name, key);
        clearTimeout(worker.idle);
        worker.idle = null;
        await worker.ready;
        if (worker.dead) throw new Error('El servicio de impresión no está disponible.');
        return await worker.print(data);
      } catch (error) {
        return { ok: false, error: error.message };
      } finally {
        if (worker && !worker.dead) {
          worker.idle = setTimeout(worker.stop, idleTimeout);
          worker.idle.unref?.();
          const idle = [...workers.values()].filter((item) => item.idle && !item.pending);
          for (const old of idle.slice(0, Math.max(0, idle.length - maxIdle))) old.stop();
        }
      }
    });
  }

  return { send, close: () => { closed = true; for (const worker of workers.values()) worker.stop(); } };
}

const rawPrinter = createRawPrinter();
module.exports = { createRawPrinter, sendRawToPrinter: rawPrinter.send, closeRawPrinters: rawPrinter.close };
