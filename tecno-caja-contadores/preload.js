'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('contadoresAPI', {
  isElectron: true,

  // ── PDF ──────────────────────────────────────────────────────────────────
  saveReportPdf(html, filename, landscape) {
    return ipcRenderer.invoke('report:save-pdf', { html, filename, landscape: !!landscape });
  },
  saveInvoicePdf(html, filename) {
    return ipcRenderer.invoke('report:save-pdf', { html, filename, landscape: false });
  },

  // ── Actualizaciones ───────────────────────────────────────────────────────
  updaterCheck()    { return ipcRenderer.invoke('updater:check'); },
  updaterDownload() { return ipcRenderer.invoke('updater:download'); },
  updaterInstall()  { return ipcRenderer.invoke('updater:install'); },
  updaterGetVersion() { return ipcRenderer.invoke('updater:get-version'); },
  onUpdaterEvent(callback) {
    if (typeof callback !== 'function') return () => {};
    const wrap = (ev) => (_e, d) => callback(ev, d || {});
    const handlers = {
      'updater:available':     wrap('available'),
      'updater:not-available': wrap('not-available'),
      'updater:progress':      wrap('progress'),
      'updater:downloaded':    wrap('downloaded'),
      'updater:error':         wrap('error'),
    };
    Object.entries(handlers).forEach(([ch, fn]) => ipcRenderer.on(ch, fn));
    return () => Object.entries(handlers).forEach(([ch, fn]) => ipcRenderer.removeListener(ch, fn));
  },
});
