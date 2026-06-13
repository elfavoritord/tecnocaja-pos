'use strict';
/**
 * Tecno Caja Contadores — Electron main process
 * App independiente del POS. Panel exclusivo para contadores asociados.
 */
const path  = require('path');
const http  = require('http');
const fs    = require('fs');
const os    = require('os');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

// En desarrollo usa node_modules del proyecto padre; en producción usa los propios
if (!app.isPackaged) {
  const ROOT = path.resolve(__dirname, '..');
  require('module').globalPaths.push(path.join(ROOT, 'node_modules'));
}

require('dotenv').config({ path: path.join(__dirname, '.env') });

const PORT = Number(process.env.CONTADORES_PORT || 3401);
let mainWindow = null;

app.commandLine.appendSwitch('disable-features', [
  'PrivateNetworkAccessSendPreflights',
  'BlockInsecurePrivateNetworkRequests',
].join(','));

function startServer() {
  return new Promise((resolve, reject) => {
    try {
      const server = require('./server');
      server.listen(PORT, '127.0.0.1', () => {
        console.log(`[contadores] Servidor en puerto ${PORT}`);
        resolve();
      });
      server.on('error', reject);
    } catch (e) { reject(e); }
  });
}

function waitForServer(retries = 20) {
  return new Promise((resolve, reject) => {
    const check = (n) => {
      const req = http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
        if (res.statusCode === 200) resolve();
        else if (n > 0) setTimeout(() => check(n - 1), 300);
        else reject(new Error('Servidor contadores no respondió'));
      });
      req.on('error', () => {
        if (n > 0) setTimeout(() => check(n - 1), 300);
        else reject(new Error('Servidor contadores no disponible'));
      });
    };
    check(retries);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    title: 'Tecno Caja Contadores',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    backgroundColor: '#0f1624',
    show: false,
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Auto-updater ────────────────────────────────────────────────────────────
let autoUpdater = null;
function initUpdater() {
  if (!app.isPackaged) return;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload    = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updater:available', { version: info.version });
      }
    });
    autoUpdater.on('update-downloaded', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updater:downloaded');
      }
    });
    autoUpdater.on('error', (err) => {
      console.error('[updater]', err?.message || err);
    });

    // Revisa al iniciar y cada 4 horas
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
  } catch (e) {
    console.warn('[updater] no disponible:', e.message);
  }
}

ipcMain.handle('updater:check', async () => {
  if (!autoUpdater) return { devMode: true };
  try { return await autoUpdater.checkForUpdates(); } catch { return { error: true }; }
});
ipcMain.handle('updater:download', async () => {
  if (!autoUpdater) return { devMode: true };
  try { autoUpdater.downloadUpdate(); return { ok: true }; } catch { return { ok: false }; }
});
ipcMain.handle('updater:install', () => {
  if (!autoUpdater) return;
  autoUpdater.quitAndInstall(false, true);
});
ipcMain.handle('updater:get-version', () => ({
  version: app.getVersion(),
  isPackaged: app.isPackaged,
}));

// ── Guardar reporte como PDF ────────────────────────────────────────────────
ipcMain.handle('report:save-pdf', async (_event, { html = '', filename = 'reporte.pdf', landscape = false } = {}) => {
  let pdfWindow = null;
  let tempFile  = null;
  try {
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
      title:       'Guardar reporte como PDF',
      defaultPath: path.join(app.getPath('documents'), filename),
      filters:     [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };

    tempFile = path.join(os.tmpdir(), `tc-reporte-${Date.now()}.html`);
    fs.writeFileSync(tempFile, html, 'utf8');

    pdfWindow = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    await pdfWindow.loadFile(tempFile);

    const pdfBuffer = await pdfWindow.webContents.printToPDF({
      printBackground: true,
      pageSize:        'A4',
      landscape:       landscape,
      margins:         { marginType: 'printableArea' },
    });

    pdfWindow.close();
    pdfWindow = null;
    fs.unlinkSync(tempFile);
    tempFile = null;

    fs.writeFileSync(filePath, pdfBuffer);
    return { ok: true, filePath };
  } catch (error) {
    if (pdfWindow && !pdfWindow.isDestroyed()) pdfWindow.close();
    if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    return { ok: false, error: error.message || 'No se pudo guardar el PDF.' };
  }
});

app.whenReady().then(async () => {
  try {
    await startServer();
    await waitForServer();
  } catch (e) {
    console.error('[contadores] Error al iniciar servidor:', e.message);
  }
  createWindow();
  initUpdater();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});
