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
    const onAvailable  = (_e, d) => callback('available', d);
    const onDownloaded = ()      => callback('downloaded', {});
    ipcRenderer.on('updater:available',  onAvailable);
    ipcRenderer.on('updater:downloaded', onDownloaded);
    return () => {
      ipcRenderer.removeListener('updater:available',  onAvailable);
      ipcRenderer.removeListener('updater:downloaded', onDownloaded);
    };
  },
});
