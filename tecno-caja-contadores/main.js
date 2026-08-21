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

// En app empaquetada, .env y el service account están en process.resourcesPath
const envPath = app.isPackaged
  ? path.join(process.resourcesPath, '.env')
  : path.join(__dirname, '.env');
require('dotenv').config({ path: envPath });

// Ajusta la ruta del service account cuando es relativa (packaged)
if (app.isPackaged && process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
  const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!path.isAbsolute(saPath)) {
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH = path.join(
      process.resourcesPath,
      path.basename(saPath)
    );
  }
}

const PORT = Number(process.env.CONTADORES_PORT || 3401);
let mainWindow = null;
let httpServer = null;

app.commandLine.appendSwitch('disable-features', [
  'PrivateNetworkAccessSendPreflights',
  'BlockInsecurePrivateNetworkRequests',
].join(','));

// ── Caché local del último contador que inició sesión ─────────────────────
// El splash se carga como archivo local ANTES de que haya sesión (no se
// sabe todavía quién va a entrar), así que no puede leer el perfil real de
// Firestore. En vez de eso, cada login exitoso guarda aquí nombre+logo, y el
// PRÓXIMO arranque los lee para personalizar el splash — un arranque de
// atraso es aceptable para algo puramente cosmético.
const PROFILE_CACHE_PATH = path.join(app.getPath('userData'), 'last-profile.json');

function readCachedProfile() {
  try {
    return JSON.parse(fs.readFileSync(PROFILE_CACHE_PATH, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeCachedProfile(data) {
  try {
    fs.writeFileSync(PROFILE_CACHE_PATH, JSON.stringify({
      nombre_firma: data?.nombre_firma || '',
      logo_url:     data?.logo_url || '',
    }));
  } catch (e) {
    console.warn('[contadores] No se pudo guardar el perfil en caché:', e.message);
  }
}

ipcMain.handle('profile:cache', (_e, data) => {
  writeCachedProfile(data);
});

function startServer() {
  return new Promise((resolve, reject) => {
    try {
      // require('./server') exporta la app de Express (module.exports = app),
      // no el servidor HTTP real — app.listen() internamente crea y devuelve
      // el http.Server. Antes se guardaba la app misma en `httpServer`, que
      // no tiene .close(): stopServer() (llamado antes de instalar una
      // actualización) fallaba con "httpServer.close is not a function".
      const app = require('./server');
      httpServer = app.listen(PORT, '127.0.0.1', () => {
        console.log(`[contadores] Servidor en puerto ${PORT}`);
        resolve();
      });
      httpServer.on('error', reject);
    } catch (e) { reject(e); }
  });
}

// Cierre ordenado del servidor local antes de reiniciar para instalar —
// mismo cuidado que el POS (electron/main.js stopServer() antes de
// quitAndInstall). No hay datos de negocio que respaldar aquí (todo vive en
// Firestore), pero sí conviene no matar el proceso con conexiones abiertas.
function stopServer() {
  return new Promise((resolve) => {
    if (!httpServer) return resolve();
    httpServer.close(() => resolve());
    // No dejar que un socket colgado bloquee la actualización indefinidamente.
    setTimeout(resolve, 3000);
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

// Una sola ventana (sin ventana de splash separada): se muestra de inmediato
// con public/splash.html y luego navega a la app real cuando el servidor
// está listo. Sin depender de 'ready-to-show' — se comportó poco confiable
// en esta app (el splash terminaba sin llegar a verse). app.whenReady() de
// abajo le da un respiro fijo con setTimeout antes de arrancar el require
// pesado del servidor, para garantizar que el splash ya pintó en pantalla
// sin depender de ningún evento de Electron.
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
    show: true,
  });

  // Pasa el nombre/logo del último contador que inició sesión (si hay) para
  // que el splash los muestre en vez de la marca genérica — ver
  // PROFILE_CACHE_PATH arriba.
  const cached = readCachedProfile();
  const query = {};
  if (cached?.nombre_firma) query.nombre = cached.nombre_firma;
  if (cached?.logo_url)     query.logo   = cached.logo_url;
  mainWindow.loadFile(path.join(__dirname, 'public', 'splash.html'), { query });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Permitir el popup nativo de "Iniciar con Google" (Firebase Auth) —
    // todo lo demás se sigue abriendo en el navegador externo por seguridad.
    if (/^https:\/\/accounts\.google\.com\//.test(url) || /^https:\/\/[^/]+\.firebaseapp\.com\//.test(url)) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Auto-updater ────────────────────────────────────────────────────────────
let autoUpdater = null;
let updateDownloaded = false;
let updateInfo = null;
function sendUpdaterEvent(eventName, payload = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(`updater:${eventName}`, payload);
  }
}
function initUpdater() {
  if (!app.isPackaged) return;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
    // Igualado al POS (electron/main.js): la descarga arranca sola al
    // detectar versión nueva, sin esperar a que el usuario haga clic.
    autoUpdater.autoDownload    = true;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('checking-for-update', () => sendUpdaterEvent('checking'));
    autoUpdater.on('update-available', (info) => {
      updateDownloaded = false;
      updateInfo = info;
      sendUpdaterEvent('available', { version: info.version, releaseNotes: info.releaseNotes });
    });
    autoUpdater.on('update-not-available', () => {
      updateDownloaded = false;
      sendUpdaterEvent('not-available');
    });
    autoUpdater.on('download-progress', (p) => {
      sendUpdaterEvent('progress', {
        percent:  Math.round(p.percent || 0),
        transferred: p.transferred,
        total:    p.total,
        bytesPerSecond: p.bytesPerSecond,
      });
    });
    autoUpdater.on('update-downloaded', (info) => {
      updateDownloaded = true;
      updateInfo = info;
      sendUpdaterEvent('downloaded', { version: info.version });
    });
    autoUpdater.on('error', (err) => {
      console.error('[updater]', err?.message || err);
      sendUpdaterEvent('error', { message: err?.message || 'Error desconocido' });
    });

    // Revisa al iniciar y cada 4 horas
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
  } catch (e) {
    console.warn('[updater] no disponible:', e.message);
  }
}

ipcMain.handle('updater:check', async () => {
  if (!autoUpdater || !app.isPackaged) return { devMode: true, version: app.getVersion() };
  try {
    sendUpdaterEvent('checking');
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, updateInfo: result?.updateInfo || null };
  } catch (e) {
    const message = e?.message || 'No se pudo verificar la actualización.';
    sendUpdaterEvent('error', { message });
    return { ok: false, error: message };
  }
});
ipcMain.handle('updater:download', async () => {
  if (!autoUpdater || !app.isPackaged) return { devMode: true };
  if (updateDownloaded) return { ok: true, alreadyDownloaded: true };
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    const message = e?.message || 'No se pudo descargar la actualización.';
    sendUpdaterEvent('error', { message });
    return { ok: false, error: message };
  }
});
ipcMain.handle('updater:install', async () => {
  if (!autoUpdater || !app.isPackaged) return { devMode: true };
  if (!updateDownloaded) {
    return { ok: false, error: 'La actualización todavía no terminó de descargarse.' };
  }
  try {
    sendUpdaterEvent('installing', { version: updateInfo?.version || null });
    await stopServer();
    // quitAndInstall corre en el siguiente tick (setImmediate) — el try/catch
    // de afuera YA devolvió { ok: true } para entonces, así que un error
    // síncrono al invocarlo (ej. instalador cacheado corrupto/ausente) nunca
    // llegaba al renderer: el overlay "Instalando..." se quedaba pegado sin
    // explicación. autoUpdater.on('error', ...) solo cubre errores async
    // que electron-updater decide emitir como evento, no un throw directo.
    setImmediate(() => {
      try {
        autoUpdater.quitAndInstall(false, true);
      } catch (installError) {
        sendUpdaterEvent('error', { message: installError?.message || 'No se pudo iniciar el instalador (quitAndInstall falló).' });
      }
    });
    return { ok: true };
  } catch (e) {
    const message = e?.message || 'No se pudo iniciar el instalador.';
    sendUpdaterEvent('error', { message });
    return { ok: false, error: message };
  }
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
  const t0 = Date.now();
  console.log(`[splash] t=0ms whenReady`);

  createWindow(); // ventana visible de inmediato, mostrando el splash
  console.log(`[splash] t=${Date.now() - t0}ms createWindow() llamado`);

  // Respiro fijo para que el proceso de renderizado del splash tenga
  // garantizado un turno del event loop antes de que arranque el require
  // síncrono pesado de abajo (Firebase Admin, Express...). No depende de
  // ningún evento de Electron — solo tiempo de reloj.
  await new Promise(r => setTimeout(r, 300));
  console.log(`[splash] t=${Date.now() - t0}ms respiro de 300ms terminado`);

  try {
    await startServer();
    console.log(`[splash] t=${Date.now() - t0}ms startServer() resuelto`);
    await waitForServer();
    console.log(`[splash] t=${Date.now() - t0}ms waitForServer() resuelto`);
  } catch (e) {
    console.error('[contadores] Error al iniciar servidor:', e.message);
  }

  // require('./server') bloquea el hilo principal de forma síncrona varios
  // segundos (Firebase Admin, Express...) — mientras Node está bloqueado así,
  // Windows no puede repintar NINGUNA ventana que este proceso controle, así
  // que el splash se queda "congelado" (sin repintar) todo ese tiempo, sin
  // importar que ya esté renderizado por dentro. Por eso NO se resta ese
  // tiempo de un mínimo total — se espera un tramo FIJO adicional aquí,
  // después de que el bloqueo ya terminó y la ventana puede volver a
  // responder, para que ese repintado sea visible de verdad.
  const POST_SERVER_SPLASH_MS = 2500;
  await new Promise(r => setTimeout(r, POST_SERVER_SPLASH_MS));

  console.log(`[splash] t=${Date.now() - t0}ms navegando a la app real`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  }
  initUpdater();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});
