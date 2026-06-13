'use strict';
/**
 * Tecno Caja Admin — Electron main process
 * App independiente del POS. Administración global de la plataforma.
 */
const path  = require('path');
const http  = require('http');
const { app, BrowserWindow, shell, ipcMain } = require('electron');

// Resolver node_modules del proyecto padre (comparte dependencias)
const ROOT = path.resolve(__dirname, '..');
require('module').globalPaths.push(path.join(ROOT, 'node_modules'));

require('dotenv').config({ path: path.join(__dirname, '.env') });

const PORT = Number(process.env.ADMIN_PORT || 3400);
let mainWindow = null;
let serverReady = false;

app.commandLine.appendSwitch('disable-features', [
  'PrivateNetworkAccessSendPreflights',
  'BlockInsecurePrivateNetworkRequests',
].join(','));

// ── Lanzar servidor Express ────────────────────────────────────────────────
function startAdminServer() {
  return new Promise((resolve, reject) => {
    try {
      const server = require('./server');
      server.listen(PORT, '127.0.0.1', () => {
        console.log(`[admin] Servidor en puerto ${PORT}`);
        resolve();
      });
      server.on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}

function waitForServer(retries = 20) {
  return new Promise((resolve, reject) => {
    const check = (n) => {
      const req = http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
        if (res.statusCode === 200) resolve();
        else if (n > 0) setTimeout(() => check(n - 1), 300);
        else reject(new Error('Admin server no respondió'));
      });
      req.on('error', () => {
        if (n > 0) setTimeout(() => check(n - 1), 300);
        else reject(new Error('Admin server no disponible'));
      });
    };
    check(retries);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    title: 'Tecno Caja Admin',
    icon: path.join(__dirname, 'public', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    backgroundColor: '#1a2234',
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

app.whenReady().then(async () => {
  try {
    await startAdminServer();
    await waitForServer();
  } catch (e) {
    console.error('[admin] Error al iniciar servidor:', e.message);
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});
