'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { enqueuePrinterJob } = require('./printer-queue');

function createPrintWindowPool({ createWindow, idleTimeout = 120000, maxIdle = 3 } = {}) {
  const entries = new Map();
  let sequence = 0;
  let closed = false;

  function discard(key, entry) {
    clearTimeout(entry.timer);
    if (entries.get(key) === entry) entries.delete(key);
    if (!entry.window.isDestroyed()) entry.window.destroy();
    fs.promises.unlink(entry.file).catch(() => {});
  }

  function run(printerName, layout, html, print) {
    const key = String(printerName || '').trim().toLowerCase();
    return enqueuePrinterJob(key, async () => {
      if (closed) throw new Error('El servicio de impresión se cerró.');
      let entry = entries.get(key);
      if (entry?.window.isDestroyed()) { discard(key, entry); entry = null; }
      if (!entry) {
        entry = {
          window: createWindow({ show: false, width: layout.previewWidth || 420, height: layout.previewHeight || 900,
            backgroundColor: '#ffffff', skipTaskbar: true,
            webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } }),
          file: path.join(os.tmpdir(), `tecnocaja-print-${process.pid}-${Date.now()}-${++sequence}.html`),
          busy: false, timer: null,
        };
        entries.set(key, entry);
      }
      clearTimeout(entry.timer);
      entry.busy = true;
      try {
        entry.window.setContentSize(layout.previewWidth || 420, layout.previewHeight || 900);
        await fs.promises.writeFile(entry.file, html, 'utf8');
        await entry.window.loadFile(entry.file, { query: { job: String(++sequence) } });
        return await print(entry.window);
      } catch (error) {
        discard(key, entry);
        throw error;
      } finally {
        await fs.promises.unlink(entry.file).catch(() => {});
        entry.busy = false;
        if (entries.get(key) === entry) {
          entry.timer = setTimeout(() => discard(key, entry), idleTimeout);
          entry.timer.unref?.();
          const idle = [...entries].filter(([, item]) => !item.busy);
          for (const [oldKey, old] of idle.slice(0, Math.max(0, idle.length - maxIdle))) discard(oldKey, old);
        }
      }
    });
  }

  const clear = () => { for (const [key, entry] of entries) discard(key, entry); };
  return { run, clear, close: () => { closed = true; clear(); } };
}

module.exports = { createPrintWindowPool };
