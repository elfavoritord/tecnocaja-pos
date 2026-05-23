const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('novaDesktop', {
  platform: process.platform,
  openSecureBackupFolder(password) {
    return ipcRenderer.invoke('secure-backup:open-folder', password);
  },
  openExternal(url) {
    return ipcRenderer.invoke('app:open-external', url);
  },
  restartApp() {
    return ipcRenderer.invoke('app:restart');
  },
  listPrinters() {
    return ipcRenderer.invoke('app:list-printers');
  },
  listScaleSerialPorts() {
    return ipcRenderer.invoke('scale:list-serial-ports');
  },
  readScaleWeight(config) {
    return ipcRenderer.invoke('scale:read-weight', config || {});
  },
  printReceiptHtml(html, options) {
    return ipcRenderer.invoke('receipt:print-html', html, options);
  },
  copyImageToClipboard(dataUrl) {
    return ipcRenderer.invoke('receipt-image:copy', dataUrl);
  },
  openWhatsAppWeb(targetUrl) {
    return ipcRenderer.invoke('app:open-whatsapp-web', targetUrl || '');
  },
  openWhatsAppChat(phone, text, options = {}) {
    return ipcRenderer.invoke('app:open-whatsapp-chat', { phone, text, ...(options || {}) });
  },
  closeWhatsAppGuide() {
    return ipcRenderer.invoke('app:close-whatsapp-guide');
  },
  disableWhatsAppPasteGuide() {
    return ipcRenderer.invoke('app:disable-whatsapp-paste-guide');
  },
  onWhatsAppGuidePreferenceChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('config:whatsapp-guide-updated', listener);
    return () => ipcRenderer.removeListener('config:whatsapp-guide-updated', listener);
  },
  openWhatsAppChatWithPdf(phone, text, pdfDataUrl, fileName) {
    return ipcRenderer.invoke('app:open-whatsapp-chat-with-pdf', {
      phone,
      text,
      pdfDataUrl,
      fileName
    });
  },
  openWhatsAppChatWithMedia(phone, text, mediaDataUrl, fileName) {
    return ipcRenderer.invoke('app:open-whatsapp-chat-with-pdf', {
      phone,
      text,
      mediaDataUrl,
      fileName
    });
  },

  // ── Impresión ESC/POS directa (sin HTML, máxima velocidad) ──────────────
  /**
   * Imprime recibo vía ESC/POS directo a impresora térmica
   * @param {object} receiptData — { negocio, venta, config }
   * @param {object} options     — { printerName, paperWidth }
   */
  printReceiptEscpos(receiptData, options) {
    return ipcRenderer.invoke('receipt:print-escpos', receiptData, options || {});
  },

  // ── Guardado automático de facturas en PDF ───────────────────────────────
  /**
   * Guarda una factura en PDF organizada por carpetas año/mes.
   * @param {object} payload — { invoiceNumber, clientName, date, businessName, branchName, pdfBase64 }
   * @returns {{ ok: boolean, filePath?: string, error?: string }}
   */
  saveInvoicePdf(payload) {
    return ipcRenderer.invoke('invoice:save-pdf', payload);
  },

  /**
   * Imprime el Corte de Caja directo a la impresora térmica (ESC/POS)
   * @param {object} corteData — { negocio, corte, config }
   * @param {object} options   — { printerName, paperWidth }
   */
  printCorteEscpos(corteData, options) {
    return ipcRenderer.invoke('corte:print-escpos', corteData, options || {});
  },

  // ── Gaveta registradora ──────────────────────────────────────────────────
  /**
   * Abre la gaveta registradora
   * @param {object} config — { method, printerName, serialPort, networkHost, pin }
   */
  openCashDrawer(config) {
    return ipcRenderer.invoke('cash-drawer:open', config || {});
  },

  /**
   * Prueba la apertura de gaveta (para pantalla de configuración)
   */
  testCashDrawer(config) {
    return ipcRenderer.invoke('cash-drawer:test', config || {});
  },

  /**
   * Abre gaveta por pulso ESC/POS directo (forma rápida)
   * @param {string} printerName
   * @param {number} pin — 0=pin2, 1=pin5
   */
  openDrawerEscpos(printerName, pin) {
    return ipcRenderer.invoke('cash-drawer:open-escpos', printerName, pin || 0);
  },

  // ── Modo thin-client (terminal caja secundaria) ───────────────────────────
  testServerConnection(serverUrl) {
    return ipcRenderer.invoke('terminal:test-server', serverUrl);
  },
  saveAsThinClient(serverUrl, terminalName) {
    return ipcRenderer.invoke('terminal:save-thin-client-config', { serverUrl, terminalName });
  },
  getTerminalConfig() {
    return ipcRenderer.invoke('terminal:get-config');
  },
  resetTerminalConfig() {
    return ipcRenderer.invoke('terminal:reset-config');
  },

  // ── Auto-updater (electron-updater + GitHub Releases) ────────────────────
  /**
   * Busca actualizaciones en GitHub Releases.
   * Retorna { devMode:true } si el app no está empaquetada (desarrollo).
   */
  updaterCheck() {
    return ipcRenderer.invoke('updater:check');
  },
  /** Inicia la descarga de la actualización disponible */
  updaterDownload() {
    return ipcRenderer.invoke('updater:download');
  },
  /** Instala la actualización descargada y reinicia el sistema */
  updaterInstall() {
    return ipcRenderer.invoke('updater:install');
  },
  /** Devuelve { version, isPackaged } del proceso main */
  updaterGetVersion() {
    return ipcRenderer.invoke('updater:get-version');
  },
  /**
   * Suscribe a todos los eventos del updater.
   * @param {function} callback (eventName, payload) => void
   * @returns {function} unsub — llama para eliminar los listeners
   * Eventos: 'checking' | 'available' | 'not-available' | 'progress' | 'downloaded' | 'error'
   */
  updaterOnEvent(callback) {
    if (typeof callback !== 'function') return () => {};
    const EVENTS = [
      'updater:checking',
      'updater:available',
      'updater:not-available',
      'updater:progress',
      'updater:downloaded',
      'updater:error',
    ];
    const listeners = EVENTS.map(ev => {
      const fn = (_e, data) => callback(ev.replace('updater:', ''), data);
      ipcRenderer.on(ev, fn);
      return { ev, fn };
    });
    return () => listeners.forEach(({ ev, fn }) => ipcRenderer.removeListener(ev, fn));
  },
});
