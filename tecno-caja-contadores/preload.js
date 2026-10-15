'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('contadoresAPI', {
  isElectron: true,

  // ── PDF ──────────────────────────────────────────────────────────────────
  saveReportPdf(html, filename, landscape) {
    return ipcRenderer.invoke('report:save-pdf', { html, filename, landscape: !!landscape });
  },
  // Factura A4 (plantillas): sin márgenes, la hoja trae los suyos.
  saveInvoicePdf(html, filename) {
    return ipcRenderer.invoke('report:save-pdf', {
      html, filename, landscape: false, noMargins: true, title: 'Guardar factura como PDF',
    });
  },
  renderReportPdf(html, landscape) {
    return ipcRenderer.invoke('report:render-pdf', { html, landscape: !!landscape });
  },
  renderInvoicePdf(html) {
    return ipcRenderer.invoke('report:render-pdf', { html, landscape: false, noMargins: true });
  },
  previewPrint(html, title, filename) {
    return ipcRenderer.invoke('report:preview-print', { html, title, filename });
  },

  // ── Perfil (caché local para el splash pre-login) ──────────────────────────
  cacheProfile(data) {
    return ipcRenderer.invoke('profile:cache', data);
  },

  // ── Modo día / noche ('dia' | 'noche' | 'auto') ────────────────────────────
  setTheme(tema) {
    return ipcRenderer.invoke('ui:set-theme', String(tema || ''));
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
      'updater:checking':      wrap('checking'),
      'updater:available':     wrap('available'),
      'updater:not-available': wrap('not-available'),
      'updater:progress':      wrap('progress'),
      'updater:downloaded':    wrap('downloaded'),
      'updater:installing':    wrap('installing'),
      'updater:error':         wrap('error'),
    };
    Object.entries(handlers).forEach(([ch, fn]) => ipcRenderer.on(ch, fn));
    return () => Object.entries(handlers).forEach(([ch, fn]) => ipcRenderer.removeListener(ch, fn));
  },
});
