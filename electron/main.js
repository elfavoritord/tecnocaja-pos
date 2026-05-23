const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { app, BrowserWindow, dialog, ipcMain, shell, clipboard, nativeImage, screen } = require('electron');
const http = require('http');
const net = require('net');
const os = require('os');
const { printReceipt, printCorteReceipt, openCashDrawer: escposOpenDrawer } = require('./thermal-printer');
const { openDrawer: openCashDrawerAll, testDrawer } = require('./cash-drawer');
const { listSerialPorts, readWeightFromSerial } = require('./scale-reader');

const CUSTOM_USER_DATA_PATH = process.env.TECNO_CAJA_USER_DATA
  ? path.resolve(process.env.TECNO_CAJA_USER_DATA)
  : '';

if (CUSTOM_USER_DATA_PATH) {
  app.setPath('userData', CUSTOM_USER_DATA_PATH);
}

let mainWindow = null;
let serverRuntime = null;
let tunnelProcess = null;
let hasForcedReload = false;
let shutdownWindow = null;
let whatsappWindow = null;
let whatsappGuideWindow = null;
let whatsappGuideState = null;
let whatsappGuideAutoHideTimer = null;
let whatsappGuideInputHookInstalled = false;
if (process.platform === 'win32') {
  try { process.stdout.setEncoding('utf8'); } catch (_) {}
  try { process.stderr.setEncoding('utf8'); } catch (_) {}
}

const WHATSAPP_WEB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const WHATSAPP_WEB_URL = 'https://web.whatsapp.com/';
const WHATSAPP_SESSION_PARTITION = 'persist:tecnocaja-whatsapp';
const DEFAULT_ELECTRON_PORT = 3399;
const FALLBACK_APP_PORT = 3000;
let currentServerPort = DEFAULT_ELECTRON_PORT;
let currentAppUrl = `http://127.0.0.1:${currentServerPort}`;
const MIN_BACKUP_NOTICE_MS = 5000;
const STARTUP_LOG_FILE = path.join(process.env.TEMP || __dirname, 'tecnocaja-electron-startup.log');
// Switches de Chromium deben ir ANTES de app.whenReady().
// Previene el crash "Network service crashed" en Electron 41 / Chromium 130+:
// Chromium bloquea solicitudes de páginas web a localhost (Private Network Access)
// y eso colapsa el NetworkService. Desactivamos esas restricciones localmente.
app.commandLine.appendSwitch('disable-features', [
  'PrivateNetworkAccessSendPreflights',
  'BlockInsecurePrivateNetworkRequests',
  'NetworkServiceInProcess2',
].join(','));
app.commandLine.appendSwitch('disable-http-cache');

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

function buildLocalUrl(port) {
  return `http://127.0.0.1:${port}`;
}

function isServeoTunnelEnabled() {
  const value = String(process.env.TECNO_CAJA_ENABLE_SERVEO_TUNNEL || '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

function isLanOrVpnIpv4Address(address) {
  const normalized = String(address || '').trim();
  if (!normalized) return false;
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(normalized)
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(normalized);
}

function getNetworkProbeUrls(port) {
  const interfaces = os.networkInterfaces() || {};
  const urls = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue;
      if (entry.family !== 'IPv4' && entry.family !== 4) continue;
      const address = String(entry.address || '').trim();
      if (!isLanOrVpnIpv4Address(address)) continue;
      urls.push(`http://${address}:${port}`);
    }
  }
  return [...new Set(urls)];
}

function getSecureBackupDir() {
  return process.env.SECURE_BACKUP_DIR || path.join(app.getPath('userData'), 'secure-backups');
}

function logStartup(message) {
  try {
    fs.appendFileSync(
      STARTUP_LOG_FILE,
      `[${new Date().toISOString()}] ${message}\n`,
      'utf8'
    );
  } catch (_error) {
    // ignore log failures
  }
}

function postJson(url, payload, method = 'POST') {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const target = new URL(url);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = body ? JSON.parse(body) : null;
        } catch (_error) {
          parsed = body;
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
          return;
        }

        reject(new Error(parsed?.error || parsed || `Error ${res.statusCode}`));
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function createAutoBackup(actor = {}) {
  return postJson(`${currentAppUrl}/api/backup/auto-save`, actor);
}

async function verifySecurityPassword(password) {
  return postJson(`${currentAppUrl}/api/security-password/verify`, { password });
}

async function updateWhatsAppPasteGuideEnabled(enabled, actor = {}) {
  return postJson(`${currentAppUrl}/api/config/whatsapp-guide`, {
    enabled: Boolean(enabled),
    ...actor
  }, 'PUT');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearWhatsAppGuideAutoHideTimer() {
  if (whatsappGuideAutoHideTimer) {
    clearTimeout(whatsappGuideAutoHideTimer);
    whatsappGuideAutoHideTimer = null;
  }
}

function resetWhatsAppGuideState() {
  clearWhatsAppGuideAutoHideTimer();
  whatsappGuideState = null;
}

function closeWhatsAppGuideWindow() {
  clearWhatsAppGuideAutoHideTimer();
  if (whatsappGuideWindow && !whatsappGuideWindow.isDestroyed()) {
    whatsappGuideWindow.destroy();
  }
  whatsappGuideWindow = null;
  whatsappGuideState = null;
}

function notifyWhatsAppGuidePreferenceChanged(enabled) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('config:whatsapp-guide-updated', { enabled: Boolean(enabled) });
  }
}

function getWhatsAppGuideBounds() {
  const guideWidth = 356;
  const guideHeight = 202;
  const fallback = { x: 40, y: 40, width: guideWidth, height: guideHeight };
  try {
    const targetBounds = whatsappWindow && !whatsappWindow.isDestroyed()
      ? whatsappWindow.getBounds()
      : mainWindow?.getBounds?.();
    if (!targetBounds) return fallback;
    const display = screen.getDisplayMatching(targetBounds);
    const workArea = display?.workArea || { x: 0, y: 0, width: 1366, height: 768 };
    const x = Math.min(
      Math.max(targetBounds.x + targetBounds.width - guideWidth - 24, workArea.x + 12),
      workArea.x + workArea.width - guideWidth - 12
    );
    const y = Math.min(
      Math.max(targetBounds.y + 24, workArea.y + 12),
      workArea.y + workArea.height - guideHeight - 12
    );
    return { x, y, width: guideWidth, height: guideHeight };
  } catch (_error) {
    return fallback;
  }
}

function ensureWhatsAppGuideWindow() {
  if (whatsappGuideWindow && !whatsappGuideWindow.isDestroyed()) {
    whatsappGuideWindow.setBounds(getWhatsAppGuideBounds());
    return whatsappGuideWindow;
  }

  whatsappGuideWindow = new BrowserWindow({
    ...getWhatsAppGuideBounds(),
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreenable: false,
    focusable: true,
    skipTaskbar: true,
    show: false,
    transparent: true,
    hasShadow: true,
    alwaysOnTop: true,
    parent: whatsappWindow && !whatsappWindow.isDestroyed() ? whatsappWindow : (mainWindow || undefined),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  whatsappGuideWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  whatsappGuideWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        :root { color-scheme: dark; }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          background: transparent;
          font-family: "Segoe UI", Arial, sans-serif;
          color: #eef2ff;
          overflow: hidden;
        }
        .guide {
          margin: 8px;
          padding: 12px 14px;
          border-radius: 16px;
          background: rgba(15, 23, 42, 0.96);
          border: 1px solid rgba(129, 140, 248, 0.35);
          box-shadow: 0 18px 40px rgba(15, 23, 42, 0.35);
          backdrop-filter: blur(14px);
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .title {
          font-size: 0.9rem;
          line-height: 1.25;
          font-weight: 800;
          color: #ffffff;
        }
        .subtitle {
          font-size: 0.76rem;
          color: #cbd5e1;
          line-height: 1.25;
        }
        .steps {
          display: grid;
          gap: 6px;
        }
        .step {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          padding: 8px 10px;
          border-radius: 12px;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.06);
          color: #cbd5e1;
          font-size: 0.75rem;
          font-weight: 600;
        }
        .step strong {
          min-width: 48px;
          color: #ffffff;
        }
        .step-copy {
          line-height: 1.22;
          flex: 1 1 auto;
        }
        .step.is-done {
          background: rgba(16, 185, 129, 0.12);
          border-color: rgba(16, 185, 129, 0.38);
          color: #d1fae5;
        }
        .step-check {
          width: 18px;
          height: 18px;
          border-radius: 999px;
          border: 2px solid rgba(255,255,255,0.28);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 18px;
          font-size: 0.72rem;
          font-weight: 900;
        }
        .step.is-done .step-check {
          border-color: rgba(16, 185, 129, 0.9);
          background: rgba(16, 185, 129, 0.9);
          color: #052e16;
        }
        .actions {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
          margin-top: 1px;
        }
        .action-btn {
          border: 0;
          border-radius: 10px;
          padding: 7px 9px;
          font-size: 0.72rem;
          font-weight: 700;
          cursor: pointer;
          transition: transform .14s ease, opacity .14s ease, background .14s ease;
        }
        .action-btn:hover {
          transform: translateY(-1px);
        }
        .action-btn.secondary {
          background: rgba(255,255,255,0.08);
          color: #e2e8f0;
        }
        .action-btn.secondary:hover {
          background: rgba(255,255,255,0.14);
        }
        .action-btn.warning {
          background: rgba(245, 158, 11, 0.15);
          color: #fde68a;
          border: 1px solid rgba(245, 158, 11, 0.28);
        }
        .action-btn.warning:hover {
          background: rgba(245, 158, 11, 0.22);
        }
      </style>
    </head>
    <body>
      <div class="guide">
        <div class="title" id="wa-guide-title">Factura copiada para WhatsApp</div>
        <div class="subtitle" id="wa-guide-subtitle">En el chat del cliente, pega la factura y luego envíala.</div>
        <div class="steps">
          <div class="step" id="wa-guide-step-paste">
            <span class="step-check" id="wa-guide-step-paste-check"></span>
            <strong>Ctrl+V</strong>
            <span class="step-copy">Pega la factura en el chat.</span>
          </div>
          <div class="step" id="wa-guide-step-send">
            <span class="step-check" id="wa-guide-step-send-check"></span>
            <strong>Enter</strong>
            <span class="step-copy">Envía la imagen al cliente.</span>
          </div>
        </div>
        <div class="actions">
          <button class="action-btn secondary" id="wa-guide-close" type="button">Cerrar</button>
          <button class="action-btn warning" id="wa-guide-disable" type="button">No usar por ahora</button>
        </div>
      </div>
      <script>
        const closeBtn = document.getElementById('wa-guide-close');
        const disableBtn = document.getElementById('wa-guide-disable');
        closeBtn?.addEventListener('click', async () => {
          await window.novaDesktop?.closeWhatsAppGuide?.();
        });
        disableBtn?.addEventListener('click', async () => {
          await window.novaDesktop?.disableWhatsAppPasteGuide?.();
        });
      </script>
    </body>
    </html>
  `)}`);
  whatsappGuideWindow.webContents.on('did-finish-load', () => {
    if (whatsappGuideState) {
      renderWhatsAppGuideState();
    }
  });
  whatsappGuideWindow.on('closed', () => {
    whatsappGuideWindow = null;
  });
  return whatsappGuideWindow;
}

function renderWhatsAppGuideState() {
  if (!whatsappGuideState) return;
  const guideWindow = ensureWhatsAppGuideWindow();
  const shortCustomerName = whatsappGuideState.customerName
    ? (whatsappGuideState.customerName.length > 22
      ? `${whatsappGuideState.customerName.slice(0, 22).trim()}...`
      : whatsappGuideState.customerName)
    : '';
  const title = shortCustomerName
    ? `Factura copiada para ${shortCustomerName}`
    : 'Factura copiada para WhatsApp';
  const subtitle = whatsappGuideState.sent
    ? 'Factura enviada. Puedes seguir trabajando.'
    : whatsappGuideState.pasted
      ? 'Perfecto. Ahora presiona Enter para enviarla.'
      : 'En el chat del cliente, presiona Ctrl+V para pegar la factura.';

  guideWindow.setBounds(getWhatsAppGuideBounds());
  guideWindow.showInactive();
  guideWindow.webContents.executeJavaScript(`
    (() => {
      const title = document.getElementById('wa-guide-title');
      const subtitle = document.getElementById('wa-guide-subtitle');
      const pasteStep = document.getElementById('wa-guide-step-paste');
      const sendStep = document.getElementById('wa-guide-step-send');
      const pasteCheck = document.getElementById('wa-guide-step-paste-check');
      const sendCheck = document.getElementById('wa-guide-step-send-check');
      if (title) title.textContent = ${JSON.stringify(title)};
      if (subtitle) subtitle.textContent = ${JSON.stringify(subtitle)};
      if (pasteStep) pasteStep.classList.toggle('is-done', ${JSON.stringify(Boolean(whatsappGuideState.pasted))});
      if (sendStep) sendStep.classList.toggle('is-done', ${JSON.stringify(Boolean(whatsappGuideState.sent))});
      if (pasteCheck) pasteCheck.textContent = ${JSON.stringify(whatsappGuideState.pasted ? '✓' : '')};
      if (sendCheck) sendCheck.textContent = ${JSON.stringify(whatsappGuideState.sent ? '✓' : '')};
    })();
  `).catch(() => {});
}

function scheduleWhatsAppGuideAutoHide(delay = 2200) {
  clearWhatsAppGuideAutoHideTimer();
  whatsappGuideAutoHideTimer = setTimeout(() => {
    closeWhatsAppGuideWindow();
  }, delay);
}

function showWhatsAppPasteGuide({ customerName = '', phone = '' } = {}) {
  whatsappGuideState = {
    customerName: String(customerName || '').trim(),
    phone: String(phone || '').replace(/[^\d]/g, ''),
    pasted: false,
    sent: false
  };
  clearWhatsAppGuideAutoHideTimer();
  renderWhatsAppGuideState();
}

function markWhatsAppGuidePasted() {
  if (!whatsappGuideState || whatsappGuideState.pasted) return;
  whatsappGuideState.pasted = true;
  renderWhatsAppGuideState();
}

function markWhatsAppGuideSent() {
  if (!whatsappGuideState || whatsappGuideState.sent) return;
  whatsappGuideState.pasted = true;
  whatsappGuideState.sent = true;
  renderWhatsAppGuideState();
  scheduleWhatsAppGuideAutoHide();
}

function buildWhatsAppWebUrl(phone = '', text = '') {
  const cleanPhone = String(phone || '').replace(/[^\d]/g, '');
  const cleanText = String(text || '').trim();
  if (!cleanPhone) {
    return WHATSAPP_WEB_URL;
  }

  const params = new URLSearchParams({
    phone: cleanPhone,
    type: 'phone_number',
    app_absent: '0'
  });
  if (cleanText) {
    params.set('text', cleanText);
  }
  return `${WHATSAPP_WEB_URL}send?${params.toString()}`;
}

function normalizeWhatsAppWebTargetUrl(targetUrl = '') {
  const candidate = String(targetUrl || '').trim();
  if (!candidate) return WHATSAPP_WEB_URL;

  try {
    const parsed = new URL(candidate);
    const isSecureWebWhatsApp = parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'web.whatsapp.com';
    if (!isSecureWebWhatsApp) return WHATSAPP_WEB_URL;
    return parsed.toString();
  } catch (_error) {
    return WHATSAPP_WEB_URL;
  }
}

function isWhatsAppHomeUrl(targetUrl = '') {
  return normalizeWhatsAppWebTargetUrl(targetUrl) === WHATSAPP_WEB_URL;
}

function getCurrentWhatsAppUrl() {
  if (!whatsappWindow || whatsappWindow.isDestroyed()) return '';
  try {
    return normalizeWhatsAppWebTargetUrl(whatsappWindow.webContents.getURL() || '');
  } catch (_error) {
    return '';
  }
}

function extractWhatsAppPhoneFromUrl(targetUrl = '') {
  try {
    const parsed = new URL(normalizeWhatsAppWebTargetUrl(targetUrl));
    return String(parsed.searchParams.get('phone') || '').replace(/[^\d]/g, '');
  } catch (_error) {
    return '';
  }
}

async function openWhatsAppChatInCurrentSession(phone = '') {
  if (!whatsappWindow || whatsappWindow.isDestroyed()) return false;
  const cleanPhone = String(phone || '').replace(/[^\d]/g, '');
  if (!cleanPhone) return false;

  try {
    whatsappWindow.show();
    whatsappWindow.focus();

    const prepared = await whatsappWindow.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        function isVisible(node) {
          if (!node) return false;
          const style = window.getComputedStyle(node);
          if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
            return false;
          }
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }

        function focusComposer() {
          const selectors = [
            'footer [contenteditable="true"]',
            '[contenteditable="true"][data-tab="10"]',
            '[contenteditable="true"][data-tab="1"]'
          ];
          for (const selector of selectors) {
            const node = document.querySelector(selector);
            if (node && isVisible(node) && typeof node.focus === 'function') {
              node.focus();
              return true;
            }
          }
          return false;
        }

        function clickNewChat() {
          const selectors = [
            'button[aria-label="Nuevo chat"]',
            'button[aria-label="New chat"]',
            'div[role="button"][aria-label="Nuevo chat"]',
            'div[role="button"][aria-label="New chat"]',
            '[data-testid="chat"]'
          ];
          for (const selector of selectors) {
            const node = document.querySelector(selector);
            const button = node?.closest('button') || node?.closest('[role="button"]') || node;
            if (button && isVisible(button) && typeof button.click === 'function') {
              button.click();
              return true;
            }
          }
          return false;
        }

        function findSearchBox() {
          const selectors = [
            'div[role="textbox"][title*="Busca"]',
            'div[role="textbox"][title*="Search"]',
            'div[contenteditable="true"][aria-label*="Buscar"]',
            'div[contenteditable="true"][aria-label*="Search"]',
            '[data-testid="chat-list-search"] [contenteditable="true"]',
            '[contenteditable="true"][data-tab="3"]',
            '[contenteditable="true"][data-tab="2"]'
          ];
          for (const selector of selectors) {
            const node = document.querySelector(selector);
            if (node && isVisible(node) && typeof node.focus === 'function') {
              node.focus();
              return node;
            }
          }
          return null;
        }

        function clearEditable(node) {
          if (!node) return false;
          node.focus();
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(node);
          selection?.removeAllRanges();
          selection?.addRange(range);
          document.execCommand?.('delete');
          if ('value' in node) node.value = '';
          node.textContent = '';
          node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
          return true;
        }

        if (focusComposer()) {
          return { ok: true, alreadyOpen: true };
        }

        for (let attempt = 0; attempt < 12; attempt += 1) {
          clickNewChat();
          const searchBox = findSearchBox();
          if (searchBox) {
            clearEditable(searchBox);
            return { ok: true };
          }
          await sleep(220);
        }

        return { ok: false, error: 'No se pudo abrir el buscador de chats de WhatsApp.' };
      })();
    `, true);

    if (!prepared?.ok) {
      return false;
    }

    if (prepared?.alreadyOpen) {
      return true;
    }

    await wait(120);
    whatsappWindow.webContents.insertText(cleanPhone);
    await wait(900);

    const opened = await whatsappWindow.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const digits = ${JSON.stringify(cleanPhone)};
        const suffixes = Array.from(new Set([
          digits,
          digits.slice(-10),
          digits.slice(-8),
          digits.slice(-7)
        ].filter(Boolean)));

        function normalizeDigits(value) {
          return String(value || '').replace(/\\D/g, '');
        }

        function isVisible(node) {
          if (!node) return false;
          const style = window.getComputedStyle(node);
          if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
            return false;
          }
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }

        function focusComposer() {
          const selectors = [
            'footer [contenteditable="true"]',
            '[contenteditable="true"][data-tab="10"]',
            '[contenteditable="true"][data-tab="1"]'
          ];
          for (const selector of selectors) {
            const node = document.querySelector(selector);
            if (node && isVisible(node)) {
              return true;
            }
          }
          return false;
        }

        function findChatCandidate() {
          const selectors = [
            '[data-testid="cell-frame-container"]',
            '[data-testid="chat-list-item"]',
            '[role="grid"] [role="row"]',
            '[role="listbox"] [role="option"]'
          ];
          const seen = new Set();
          for (const selector of selectors) {
            const nodes = Array.from(document.querySelectorAll(selector));
            for (const node of nodes) {
              const candidate = node?.closest('[role="button"]') || node;
              if (!candidate || seen.has(candidate) || !isVisible(candidate)) continue;
              seen.add(candidate);
              const textDigits = normalizeDigits(candidate.innerText || candidate.textContent || '');
              if (suffixes.some((suffix) => suffix && textDigits.includes(suffix))) {
                return candidate;
              }
            }
          }
          return null;
        }

        for (let attempt = 0; attempt < 18; attempt += 1) {
          if (focusComposer()) {
            return { ok: true, mode: 'already-open' };
          }
          const candidate = findChatCandidate();
          if (candidate && typeof candidate.click === 'function') {
            candidate.click();
            await sleep(550);
            if (focusComposer()) {
              return { ok: true, mode: 'search-result' };
            }
          }
          await sleep(220);
        }

        return { ok: false, error: 'No se encontró el chat del cliente en la sesión actual.' };
      })();
    `, true);

    return Boolean(opened?.ok);
  } catch (_error) {
    return false;
  }
}

async function navigateWhatsAppWindowInApp(targetUrl = '') {
  if (!whatsappWindow || whatsappWindow.isDestroyed()) return false;
  const safeUrl = normalizeWhatsAppWebTargetUrl(targetUrl);
  if (!safeUrl || isWhatsAppHomeUrl(safeUrl)) return true;

  try {
    const result = await whatsappWindow.webContents.executeJavaScript(`
      (() => {
        try {
          const target = new URL(${JSON.stringify(safeUrl)});
          const current = new URL(window.location.href);
          if (current.toString() === target.toString()) {
            return { ok: true, same: true };
          }

          const relative = \`\${target.pathname}\${target.search}\${target.hash}\`;
          const anchor = document.createElement('a');
          anchor.href = relative;
          anchor.target = '_self';
          anchor.rel = 'noopener';
          anchor.style.display = 'none';
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          return { ok: true, same: false };
        } catch (error) {
          return { ok: false, error: error?.message || 'No se pudo cambiar al chat solicitado.' };
        }
      })();
    `, true);
    return Boolean(result?.ok);
  } catch (_error) {
    return false;
  }
}

function hideWhatsAppWindow(options = {}) {
  if (!whatsappWindow || whatsappWindow.isDestroyed()) return;
  try {
    const restoreBeforeHide = options.restoreBeforeHide !== false;
    whatsappWindow.setSkipTaskbar(true);
    if (restoreBeforeHide && whatsappWindow.isMinimized()) {
      whatsappWindow.restore();
    }
    whatsappWindow.hide();
    closeWhatsAppGuideWindow();
  } catch (_error) {
    // Ignore hide errors to avoid blocking app shutdown.
  }
}

function captureClipboardState() {
  try {
    const image = clipboard.readImage();
    return {
      text: clipboard.readText(),
      html: clipboard.readHTML(),
      hasImage: !image.isEmpty(),
      image
    };
  } catch (_error) {
    return null;
  }
}

function restoreClipboardState(snapshot) {
  if (!snapshot) return;
  try {
    const payload = {};
    if (snapshot.text) payload.text = snapshot.text;
    if (snapshot.html) payload.html = snapshot.html;
    if (snapshot.hasImage && snapshot.image && !snapshot.image.isEmpty()) {
      payload.image = snapshot.image;
    }

    if (!Object.keys(payload).length) {
      clipboard.clear();
      return;
    }

    clipboard.write(payload);
  } catch (_error) {
    // ignore clipboard restore failures
  }
}

async function pasteImageInWhatsAppWindow(imageDataUrl = '', caption = '') {
  if (!whatsappWindow || whatsappWindow.isDestroyed()) {
    return { ok: false, attached: false, sent: false, error: 'La ventana de WhatsApp no está disponible.' };
  }

  const safeImageDataUrl = String(imageDataUrl || '').trim();
  if (!safeImageDataUrl.startsWith('data:image/')) {
    return { ok: false, attached: false, sent: false, error: 'La imagen no tiene un formato válido para pegar en WhatsApp.' };
  }

  const clipboardSnapshot = captureClipboardState();

  try {
    const image = nativeImage.createFromDataURL(safeImageDataUrl);
    if (image.isEmpty()) {
      return { ok: false, attached: false, sent: false, error: 'No se pudo preparar la imagen para WhatsApp.' };
    }

    clipboard.writeImage(image);
    whatsappWindow.show();
    whatsappWindow.focus();

    const prepareResult = await whatsappWindow.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        function hasInvalidNumberState() {
          const bodyText = String(document.body?.innerText || '').toLowerCase();
          return (
            bodyText.includes('número de teléfono compartido a través de la url no es válido')
            || bodyText.includes('phone number shared via url is invalid')
            || bodyText.includes('el número de teléfono no está en whatsapp')
            || bodyText.includes('phone number is not on whatsapp')
          );
        }

        function focusComposer() {
          const selectors = [
            'footer [contenteditable="true"]',
            '[contenteditable="true"][data-tab="10"]',
            '[contenteditable="true"][data-tab="1"]',
            '[contenteditable="true"]'
          ];

          for (const selector of selectors) {
            const node = document.querySelector(selector);
            if (!node || typeof node.focus !== 'function') continue;
            node.focus();
            const range = document.createRange();
            range.selectNodeContents(node);
            range.collapse(false);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            return true;
          }

          return false;
        }

        function countOutgoingMessages() {
          const selectors = [
            'div.message-out',
            '[data-testid="msg-out-container"]',
            '[data-testid="outgoing-message"]'
          ];
          let total = 0;
          for (const selector of selectors) {
            total = Math.max(total, document.querySelectorAll(selector).length);
          }
          return total;
        }

        for (let attempt = 0; attempt < 48; attempt += 1) {
          if (hasInvalidNumberState()) {
            return { ok: false, error: 'El número del cliente no es válido en WhatsApp.' };
          }
          if (focusComposer()) {
            return { ok: true, outgoingBaseline: countOutgoingMessages() };
          }
          await sleep(250);
        }

        return { ok: false, error: 'No se pudo preparar el chat para pegar la imagen.' };
      })();
    `, true);

    if (!prepareResult?.ok) {
      return { ok: false, attached: false, sent: false, error: prepareResult?.error || 'No se pudo preparar el chat de WhatsApp.' };
    }

    // Si hay caption, enviarlo primero como mensaje de texto
    if (caption) {
      await wait(200);
      whatsappWindow.webContents.focus();
      whatsappWindow.webContents.insertText(caption);
      await wait(300);
      whatsappWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      whatsappWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      await wait(1200);
      // Recapturar baseline después del texto enviado para que la imagen se confirme correctamente
      try {
        const newBaseline = await whatsappWindow.webContents.executeJavaScript(`
          (() => {
            const sels = ['div.message-out','[data-testid="msg-out-container"]','[data-testid="outgoing-message"]'];
            let t = 0; for (const s of sels) t = Math.max(t, document.querySelectorAll(s).length); return t;
          })()
        `, true);
        prepareResult.outgoingBaseline = typeof newBaseline === 'number' ? newBaseline : (prepareResult.outgoingBaseline + 1);
      } catch (_) {
        prepareResult.outgoingBaseline = (prepareResult.outgoingBaseline || 0) + 1;
      }
    }

    await wait(150);
    whatsappWindow.webContents.focus();
    whatsappWindow.webContents.paste();
    await wait(900);

    const sendResult = await whatsappWindow.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const outgoingBaseline = Number(${JSON.stringify(Number(prepareResult?.outgoingBaseline || 0))});

        function hasInvalidNumberState() {
          const bodyText = String(document.body?.innerText || '').toLowerCase();
          return (
            bodyText.includes('número de teléfono compartido a través de la url no es válido')
            || bodyText.includes('phone number shared via url is invalid')
            || bodyText.includes('el número de teléfono no está en whatsapp')
            || bodyText.includes('phone number is not on whatsapp')
          );
        }

        function hasImagePreview() {
          const selectors = [
            '[data-testid="media-preview"]',
            '[data-testid="media-editor"]',
            '[data-testid="media-editor-video"]',
            '[data-testid="media-editor-image"]',
            '[data-animate-media-preview="true"]',
            'div[role="dialog"] img[src^="blob:"]',
            'img[src^="blob:"]',
            'img[src^="data:image/"]'
          ];
          return selectors.some((selector) => Boolean(document.querySelector(selector)));
        }

        function isVisible(node) {
          if (!node) return false;
          const style = window.getComputedStyle(node);
          if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
            return false;
          }
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }

        function countOutgoingMessages() {
          const selectors = [
            'div.message-out',
            '[data-testid="msg-out-container"]',
            '[data-testid="outgoing-message"]'
          ];
          let total = 0;
          for (const selector of selectors) {
            total = Math.max(total, document.querySelectorAll(selector).length);
          }
          return total;
        }

        function findSendButton() {
          const selectors = [
            'button[data-testid="compose-btn-send"]',
            'div[data-testid="compose-btn-send"]',
            '[data-testid="compose-btn-send"]',
            'button[data-testid="send"]',
            'div[data-testid="send"]',
            '[data-testid="send"]',
            'button[aria-label="Enviar"]',
            'button[aria-label="Send"]',
            'div[role="button"][aria-label="Enviar"]',
            'div[role="button"][aria-label="Send"]',
            'button[title="Enviar"]',
            'button[title="Send"]',
            'span[data-icon="send"]'
          ];
          const candidates = [];
          for (const selector of selectors) {
            const nodes = Array.from(document.querySelectorAll(selector));
            for (const node of nodes) {
              const button = node?.closest('button') || node?.closest('[role="button"]') || node;
              const isDisabled = button?.disabled || String(button?.getAttribute?.('aria-disabled') || '').toLowerCase() === 'true';
              if (button && typeof button.click === 'function' && !isDisabled && isVisible(button)) {
                candidates.push(button);
              }
            }
          }
          return candidates.length ? candidates[candidates.length - 1] : null;
        }

        let previewDetected = false;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          if (hasInvalidNumberState()) {
            return { ok: false, attached: false, sent: false, error: 'El número del cliente no es válido en WhatsApp.' };
          }
          if (hasImagePreview()) {
            previewDetected = true;
            break;
          }
          await sleep(200);
        }

        if (!previewDetected) {
          return { ok: false, attached: false, sent: false, error: 'WhatsApp no mostró la vista previa de la imagen.' };
        }

        for (let attempt = 0; attempt < 30; attempt += 1) {
          const sendButton = findSendButton();
          if (sendButton) {
            sendButton.scrollIntoView?.({ block: 'center', inline: 'center' });
            sendButton.click();
            for (let confirmAttempt = 0; confirmAttempt < 30; confirmAttempt += 1) {
              if (countOutgoingMessages() > outgoingBaseline) {
                return { ok: true, attached: true, sent: true, previewDetected: true };
              }
              await sleep(250);
            }
            return { ok: true, attached: true, sent: false, previewDetected: true, error: 'No se pudo confirmar el envío automático de la imagen.' };
          }
          await sleep(250);
        }

        return { ok: false, attached: true, sent: false, previewDetected: true, error: 'No apareció el botón de envío de la imagen.' };
      })();
    `, true);

    if (sendResult?.previewDetected && !sendResult?.sent) {
      try {
        whatsappWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        whatsappWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        await wait(600);
        const keyboardConfirm = await whatsappWindow.webContents.executeJavaScript(`
          (() => {
            const selectors = [
              'div.message-out',
              '[data-testid="msg-out-container"]',
              '[data-testid="outgoing-message"]'
            ];
            let total = 0;
            for (const selector of selectors) {
              total = Math.max(total, document.querySelectorAll(selector).length);
            }
            return total > Number(${JSON.stringify(Number(prepareResult?.outgoingBaseline || 0))});
          })();
        `, true);
        if (keyboardConfirm) {
          return { ok: true, attached: true, sent: true, error: '' };
        }
      } catch (_error) {
        // keep original sendResult below
      }
    }

    return {
      ok: Boolean(sendResult?.ok),
      attached: Boolean(sendResult?.attached),
      sent: Boolean(sendResult?.sent),
      error: sendResult?.error || ''
    };
  } catch (error) {
    return {
      ok: false,
      attached: false,
      sent: false,
      error: error?.message || 'No se pudo pegar la imagen en WhatsApp Web.'
    };
  } finally {
    restoreClipboardState(clipboardSnapshot);
  }
}

async function attachMediaInWhatsAppWindow(mediaDataUrl = '', fileName = 'factura.jpg') {
  if (!whatsappWindow || whatsappWindow.isDestroyed()) {
    return { ok: false, attached: false, error: 'La ventana de WhatsApp no está disponible.' };
  }

  const safeMediaDataUrl = String(mediaDataUrl || '').trim();
  const mimeMatch = safeMediaDataUrl.match(/^data:([^;]+);base64,/i);
  const rawMimeType = String(mimeMatch?.[1] || '').toLowerCase();
  const normalizedMimeType = rawMimeType === 'image/jpg' ? 'image/jpeg' : rawMimeType;
  const isSupportedImage = ['image/png', 'image/jpeg', 'image/webp'].includes(normalizedMimeType);
  const isPdf = normalizedMimeType === 'application/pdf';
  if (!isSupportedImage && !isPdf) {
    return { ok: false, attached: false, error: 'El archivo no tiene un formato válido para adjuntar.' };
  }

  const defaultExtension = isPdf
    ? '.pdf'
    : (normalizedMimeType === 'image/webp' ? '.webp' : (normalizedMimeType === 'image/png' ? '.png' : '.jpg'));
  let safeFileName = String(fileName || `factura${defaultExtension}`)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || `factura${defaultExtension}`;
  if (!path.extname(safeFileName)) {
    safeFileName = `${safeFileName}${defaultExtension}`;
  }

  const script = `
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const dataUrl = ${JSON.stringify(safeMediaDataUrl)};
      const fileName = ${JSON.stringify(safeFileName)};
      const mimeType = ${JSON.stringify(normalizedMimeType)};
      const isPdf = mimeType === 'application/pdf';
      const isImage = mimeType.startsWith('image/');

      function clickAttachButton() {
        const selectors = [
          'span[data-icon="plus"]',
          'button[title="Adjuntar"]',
          'button[aria-label="Adjuntar"]',
          'button[title="Attach"]',
          'button[aria-label="Attach"]',
          'span[data-icon="plus-rounded"]',
          'span[data-icon="clip"]'
        ];
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          const button = node?.closest('button') || node;
          if (button && typeof button.click === 'function') {
            button.click();
            return true;
          }
        }
        return false;
      }

      function clickAttachmentOptionByMime() {
        const selectors = isImage
          ? [
              'span[data-icon="attach-photo-video"]',
              'span[data-icon="media-upload"]',
              'div[role="button"][title="Fotos y videos"]',
              'div[role="button"][aria-label="Fotos y videos"]',
              'div[role="button"][title="Photos & videos"]',
              'div[role="button"][aria-label="Photos & videos"]'
            ]
          : [
              'span[data-icon="attach-document"]',
              'span[data-icon="document"]',
              'div[role="button"][title="Documento"]',
              'div[role="button"][aria-label="Documento"]',
              'div[role="button"][title="Document"]',
              'div[role="button"][aria-label="Document"]'
            ];
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          const button = node?.closest('[role="button"]') || node?.closest('button') || node;
          if (button && typeof button.click === 'function') {
            button.click();
            return true;
          }
        }
        return false;
      }

      function scoreInputForMime(input, wantedMime) {
        const accept = String(input?.getAttribute?.('accept') || '').toLowerCase();
        let score = 0;

        if (!accept || accept.includes('*/*')) {
          score += 10;
        }

        if (wantedMime.startsWith('image/')) {
          if (accept.includes('image')) score += 40;
          if (accept.includes('video')) score += 45;
          if (accept.includes('.png') || accept.includes('.jpg') || accept.includes('.jpeg')) score += 25;
          if (accept.includes('webp') && !accept.includes('.jpg') && !accept.includes('.jpeg') && !accept.includes('.png') && !accept.includes('image/*')) score -= 220;
          if (accept.includes('application') || accept.includes('pdf')) score -= 30;
        } else if (wantedMime === 'application/pdf') {
          if (accept.includes('application') || accept.includes('pdf')) score += 60;
          if (accept.includes('image') || accept.includes('video')) score -= 35;
        }

        if (Boolean(input?.multiple)) {
          score += 8;
        }

        return score;
      }

      function acceptMatchesMime(accept, wantedMime) {
        const cleanAccept = String(accept || '').toLowerCase().trim();
        if (!cleanAccept || cleanAccept === '*' || cleanAccept.includes('*/*')) {
          return true;
        }
        const entries = cleanAccept.split(',').map((entry) => entry.trim()).filter(Boolean);
        if (!entries.length) return true;

        for (const entry of entries) {
          if (entry === wantedMime) return true;
          if (entry.endsWith('/*') && wantedMime.startsWith(entry.replace('/*', '/'))) return true;
          if (entry.startsWith('.')) {
            if (entry === '.pdf' && wantedMime === 'application/pdf') return true;
            if ((entry === '.png' || entry === '.jpg' || entry === '.jpeg' || entry === '.webp') && wantedMime.startsWith('image/')) return true;
          }
          if (wantedMime.startsWith('image/') && entry.includes('image')) return true;
          if (wantedMime === 'application/pdf' && (entry.includes('pdf') || entry.includes('application'))) return true;
        }
        return false;
      }

      function findCompatibleInput() {
        const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
        if (!inputs.length) return null;
        const compatible = inputs.filter((input) => acceptMatchesMime(input.getAttribute('accept') || '', mimeType));
        if (!compatible.length) return inputs[inputs.length - 1] || null;

        const nonStickerCandidates = isImage
          ? compatible.filter((input) => {
              const accept = String(input.getAttribute('accept') || '').toLowerCase();
              const isWebpOnly = accept.includes('webp')
                && !accept.includes('image/*')
                && !accept.includes('.jpg')
                && !accept.includes('.jpeg')
                && !accept.includes('.png')
                && !accept.includes('video');
              return !isWebpOnly;
            })
          : compatible;
        const pool = nonStickerCandidates.length ? nonStickerCandidates : compatible;

        let best = pool[0];
        let bestScore = scoreInputForMime(best, mimeType);
        for (let index = 1; index < pool.length; index += 1) {
          const candidate = pool[index];
          const candidateScore = scoreInputForMime(candidate, mimeType);
          if (candidateScore > bestScore) {
            best = candidate;
            bestScore = candidateScore;
          }
        }
        return best;
      }

      function findSendButton() {
        const selectors = [
          'button[aria-label="Enviar"]',
          'button[aria-label="Send"]',
          'span[data-icon="send"]'
        ];
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          const button = node?.closest('button') || node?.closest('[role="button"]') || node;
          const isDisabled = button?.disabled || String(button?.getAttribute?.('aria-disabled') || '').toLowerCase() === 'true';
          if (button && typeof button.click === 'function' && !isDisabled) {
            return button;
          }
        }
        return null;
      }

      function hasInvalidNumberState() {
        const bodyText = String(document.body?.innerText || '').toLowerCase();
        return (
          bodyText.includes('número de teléfono compartido a través de la url no es válido')
          || bodyText.includes('phone number shared via url is invalid')
          || bodyText.includes('el número de teléfono no está en whatsapp')
          || bodyText.includes('phone number is not on whatsapp')
        );
      }

      function hasComposerReady() {
        const composer = document.querySelector('[contenteditable="true"]');
        return Boolean(composer);
      }

      function hasFileNameInChat(fileNameCandidate) {
        const chatText = String(document.body?.innerText || '');
        return chatText.includes(String(fileNameCandidate || ''));
      }

      function hasIncompatibleFileError() {
        const bodyText = String(document.body?.innerText || '').toLowerCase();
        return (
          bodyText.includes('el archivo que intentaste añadir no es compatible')
          || bodyText.includes('archivo no es compatible')
          || bodyText.includes('file you tried adding is not supported')
          || bodyText.includes('file is not supported')
        );
      }

      function countOutgoingMessages() {
        const selectors = [
          'div.message-out',
          '[data-testid="msg-out-container"]',
          '[data-testid="outgoing-message"]'
        ];
        let total = 0;
        for (const selector of selectors) {
          total = Math.max(total, document.querySelectorAll(selector).length);
        }
        return total;
      }

      let file = null;
      try {
        const response = await fetch(dataUrl);
        const buffer = await response.arrayBuffer();
        if (!buffer || !buffer.byteLength) {
          return { ok: false, attached: false, sent: false, error: 'El archivo generado está vacío.' };
        }

        if (isPdf) {
          const bytes = new Uint8Array(buffer);
          const header = String.fromCharCode(...bytes.slice(0, 5));
          if (header !== '%PDF-') {
            return { ok: false, attached: false, sent: false, error: 'El archivo PDF generado no tiene un formato válido.' };
          }
        }

        file = new File([buffer], fileName, { type: mimeType });
      } catch (_error) {
        return { ok: false, attached: false, sent: false, error: 'No se pudo preparar el archivo para adjuntar.' };
      }

      for (let attempt = 0; attempt < 48; attempt += 1) {
        if (hasInvalidNumberState()) {
          return { ok: false, attached: false, sent: false, error: 'El número del cliente no es válido en WhatsApp.' };
        }
        if (hasComposerReady()) break;
        await sleep(250);
      }

      for (let attempt = 0; attempt < 16; attempt += 1) {
        if (hasInvalidNumberState()) {
          return { ok: false, attached: false, sent: false, error: 'El número del cliente no es válido en WhatsApp.' };
        }
        if (hasIncompatibleFileError()) {
          return { ok: false, attached: false, sent: false, error: 'WhatsApp rechazó el archivo por formato no compatible.' };
        }

        if (isImage) {
          clickAttachButton();
          clickAttachmentOptionByMime();
          await sleep(180);
        }

        const input = findCompatibleInput();
        if (!input) {
          clickAttachButton();
          clickAttachmentOptionByMime();
          await sleep(250);
          continue;
        }

        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        const outgoingBaseline = countOutgoingMessages();

        for (let sendAttempt = 0; sendAttempt < 30; sendAttempt += 1) {
          if (hasInvalidNumberState()) {
            return { ok: false, attached: false, sent: false, error: 'El número del cliente no es válido en WhatsApp.' };
          }
          if (hasIncompatibleFileError()) {
            return { ok: false, attached: false, sent: false, error: 'WhatsApp rechazó el archivo por formato no compatible.' };
          }
          const sendButton = findSendButton();
          if (sendButton) {
            sendButton.click();
            for (let confirmAttempt = 0; confirmAttempt < 24; confirmAttempt += 1) {
              if (hasIncompatibleFileError()) {
                return { ok: false, attached: false, sent: false, error: 'WhatsApp rechazó el archivo por formato no compatible.' };
              }
              if (isPdf && hasFileNameInChat(fileName)) {
                return { ok: true, attached: true, sent: true };
              }
              if (countOutgoingMessages() > outgoingBaseline) {
                return { ok: true, attached: true, sent: true };
              }
              await sleep(250);
            }
            return { ok: true, attached: true, sent: false, error: 'No se pudo confirmar el envío automático del archivo.' };
          }
          await sleep(250);
        }

        return { ok: false, attached: false, sent: false, error: 'No se pudo cargar el adjunto para enviarlo en WhatsApp.' };
      }

      return { ok: false, attached: false, error: 'No se pudo abrir el selector de archivos en WhatsApp Web.' };
    })();
  `;

  try {
    const result = await whatsappWindow.webContents.executeJavaScript(script, true);
    return {
      ok: Boolean(result?.ok),
      attached: Boolean(result?.attached),
      sent: Boolean(result?.sent),
      error: result?.error || ''
    };
  } catch (error) {
    return {
      ok: false,
      attached: false,
      sent: false,
      error: error?.message || 'No se pudo adjuntar el archivo en WhatsApp Web.'
    };
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function closeShutdownWindow() {
  if (shutdownWindow && !shutdownWindow.isDestroyed()) {
    shutdownWindow.close();
  }
  shutdownWindow = null;
}

function updateShutdownWindowStatus(message) {
  if (!shutdownWindow || shutdownWindow.isDestroyed()) return;
  const safeMessage = escapeHtml(message);
  shutdownWindow.webContents.executeJavaScript(`
    (() => {
      const status = document.getElementById('shutdown-status');
      if (status) status.innerHTML = ${JSON.stringify(safeMessage)};
    })();
  `).catch(() => {});
}

function createShutdownWindow() {
  closeShutdownWindow();

  shutdownWindow = new BrowserWindow({
    width: 460,
    height: 280,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    modal: true,
    parent: mainWindow || undefined,
    backgroundColor: '#0b1220',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  shutdownWindow.removeMenu?.();
  shutdownWindow.setMenuBarVisibility(false);
  shutdownWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Guardando copia</title>
      <style>
        :root { color-scheme: dark; }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          min-height: 100vh;
          display: grid;
          place-items: center;
          font-family: Segoe UI, Arial, sans-serif;
          background:
            radial-gradient(circle at top, rgba(90,106,255,.35), transparent 42%),
            linear-gradient(180deg, #101726 0%, #0b1220 100%);
          color: #eef2ff;
        }
        .panel {
          width: calc(100% - 32px);
          max-width: 380px;
          background: rgba(17, 24, 39, 0.92);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 24px;
          padding: 28px;
          text-align: center;
          box-shadow: 0 24px 50px rgba(0, 0, 0, 0.35);
        }
        .spinner {
          width: 68px;
          height: 68px;
          margin: 0 auto 18px;
          border-radius: 50%;
          border: 5px solid rgba(255, 255, 255, 0.12);
          border-top-color: #8b5cf6;
          animation: spin 1s linear infinite;
        }
        h1 {
          margin: 0 0 10px;
          font-size: 1.35rem;
          font-weight: 800;
        }
        p {
          margin: 0;
          line-height: 1.65;
          color: #cbd5e1;
        }
        .status {
          margin-top: 16px;
          color: #f8fafc;
          font-weight: 700;
        }
        .hint {
          margin-top: 10px;
          font-size: 0.9rem;
          color: #94a3b8;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      </style>
    </head>
    <body>
      <div class="panel">
        <div class="spinner"></div>
        <h1>Guardando copia de seguridad</h1>
        <p>
          Tecno Caja está guardando tu respaldo automático antes de cerrar.
          Espera unos segundos para proteger la información del sistema.
        </p>
        <div id="shutdown-status" class="status">Preparando cierre seguro...</div>
        <div class="hint">La ventana se cerrará automáticamente al terminar.</div>
      </div>
    </body>
    </html>
  `)}`);

  shutdownWindow.once('ready-to-show', () => {
    shutdownWindow?.show();
  });

  shutdownWindow.on('closed', () => {
    shutdownWindow = null;
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#111827',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Register event listeners synchronously before any await
  mainWindow.on('close', async (event) => {
    if (app.isQuitting || mainWindow.__allowClose) return;
    if (mainWindow.__checkingClose) {
      event.preventDefault();
      return;
    }

    event.preventDefault();
    mainWindow.__checkingClose = true;

    try {
      const status = await mainWindow.webContents.executeJavaScript(
        'window.canExitApp ? window.canExitApp() : ({ allowed: true })'
      );

      if (status && status.allowed) {
        createShutdownWindow();
        updateShutdownWindowStatus('Guardando copia de seguridad...');
        const actor = await mainWindow.webContents.executeJavaScript(`
          (() => {
            const currentUser = window.DB?.currentUser;
            return currentUser ? {
              actorUserId: currentUser.id,
              actorUserName: currentUser.nombre,
              actorUserRole: currentUser.rol
            } : {};
          })()
        `);
        await Promise.all([
          createAutoBackup(actor),
          wait(MIN_BACKUP_NOTICE_MS)
        ]);
        updateShutdownWindowStatus('Copia guardada correctamente. Cerrando Tecno Caja...');
        await wait(900);
        closeShutdownWindow();
        mainWindow.__allowClose = true;
        mainWindow.close();
        return;
      }

      dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        title: 'Caja abierta',
        message: status?.reason || 'Debes cerrar la caja antes de salir del sistema.'
      });
    } catch (_error) {
      dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        title: 'Cierre bloqueado',
        message: 'No se pudo cerrar la app porque falló la validación de caja o la copia segura automática.'
      });
      closeShutdownWindow();
    } finally {
      if (mainWindow) mainWindow.__checkingClose = false;
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.loadURL(currentAppUrl, { userAgent: 'Tecno Caja-Electron' });
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

async function getAvailablePrinters() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('La ventana principal no está disponible para consultar impresoras.');
  }
  const printers = await mainWindow.webContents.getPrintersAsync();
  return printers.map((printer) => ({
    name: printer.name,
    displayName: printer.displayName || printer.name,
    description: printer.description || '',
    status: printer.status ?? 0,
    isDefault: Boolean(printer.isDefault)
  }));
}

function resolvePaperLayout(paperSize) {
  const normalized = String(paperSize || '80mm').toLowerCase();
  if (normalized === '58mm') {
    return {
      pageSize: { width: 58000, height: 327600 },
      pageCssSize: null,
      rollWidthCss: '48mm',
      contentWidth: '48mm',
      pageMargin: '0',
      preferPrinterDefaultPageSize: false,
      landscape: false,
      previewWidth: 220,
      previewHeight: 980
    };
  }
  if (normalized === 'a4') {
    return {
      pageSize: { width: 210000, height: 297000 },
      pageCssSize: '210mm 297mm',
      rollWidthCss: '210mm',
      contentWidth: '100%',
      pageMargin: '6mm',
      preferPrinterDefaultPageSize: false,
      landscape: false,
      previewWidth: 1100,
      previewHeight: 980
    };
  }
  return {
    pageSize: { width: 80000, height: 327600 },
    pageCssSize: null,
    rollWidthCss: '72mm',
    contentWidth: '72mm',
    pageMargin: '0',
    preferPrinterDefaultPageSize: false,
    landscape: false,
    previewWidth: 304,
    previewHeight: 980
  };
}

function buildPrintShell(html, layout) {
  const pageSizeRule = layout.pageCssSize ? `size: ${layout.pageCssSize};` : '';
  return `<!DOCTYPE html>
  <html lang="es">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Factura</title>
    <style>
      @page {
        ${pageSizeRule}
        margin: ${layout.pageMargin};
      }
      :root { color-scheme: light; }
      * {
        box-sizing: border-box;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      html, body {
        margin: 0;
        padding: 0;
        background: #ffffff;
        color: #111827;
        font-family: "Segoe UI", Arial, sans-serif;
        width: 100%;
        height: auto;
        min-height: 0;
        min-width: 0;
        max-width: none;
        overflow: hidden;
      }
      .print-root {
        width: ${layout.rollWidthCss || layout.contentWidth};
        max-width: ${layout.rollWidthCss || layout.contentWidth};
        margin: 0 auto;
        padding: 0;
        display: block;
        height: auto;
        min-height: 0;
      }
      .print-root .ticket-print {
        width: ${layout.contentWidth};
        max-width: ${layout.contentWidth};
        margin: 0;
        display: block;
        height: auto;
        min-height: 0;
      }
      .print-root .ticket-print .receipt-sheet--58mm,
      .print-root .ticket-print .receipt-sheet--80mm {
        width: 100%;
        max-width: 100%;
        margin: 0;
        height: auto;
        min-height: 0;
      }
      .print-root img {
        max-width: 100%;
        height: auto;
      }
    </style>
  </head>
  <body>
    <div class="print-root">${html}</div>
  </body>
  </html>`;
}

async function waitForPrintWindowReady(printWindow) {
  if (!printWindow || printWindow.isDestroyed()) {
    return;
  }

  await printWindow.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const images = Array.from(document.images || []);
      const waitForImages = Promise.all(images.map((image) => {
        if (image.complete && image.naturalWidth > 0) {
          return Promise.resolve();
        }

        return new Promise((done) => {
          const finish = () => done();
          image.addEventListener('load', finish, { once: true });
          image.addEventListener('error', finish, { once: true });
        });
      }));

      const waitForFonts = document.fonts?.ready
        ? document.fonts.ready.catch(() => undefined)
        : Promise.resolve();

      Promise.all([waitForImages, waitForFonts]).finally(() => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
    });
  `, true);
}

function sanitizeReceiptPrintOptions(options = {}) {
  const sanitized = { ...options };
  const hasPageSize = Boolean(sanitized.pageSize);

  if (sanitized.silent) {
    // Silent/direct printing must keep the explicit thermal page size.
    delete sanitized.usePrinterDefaultPageSize;
    return sanitized;
  }

  // The system print dialog only works reliably with the printer's own page size.
  sanitized.usePrinterDefaultPageSize = true;
  if (hasPageSize) {
    delete sanitized.pageSize;
  }
  return sanitized;
}

async function runReceiptPrintJob(printWindow, options) {
  const safeOptions = sanitizeReceiptPrintOptions(options);
  return new Promise((resolve) => {
    printWindow.webContents.print(safeOptions, (success, failureReason) => {
      resolve({
        ok: success,
        error: success ? null : (failureReason || 'No se pudo imprimir la factura.')
      });
    });
  });
}

function waitForServer(url, attempts = 40) {
  return new Promise((resolve, reject) => {
    const tryConnect = (remaining) => {
      const req = http.get(`${url}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
        } else if (remaining > 0) {
          setTimeout(() => tryConnect(remaining - 1), 500);
        } else {
          reject(new Error(`Servidor respondió con código ${res.statusCode}`));
        }
      });

      req.on('error', () => {
        if (remaining > 0) {
          setTimeout(() => tryConnect(remaining - 1), 500);
        } else {
          reject(new Error('No se pudo iniciar el servidor local.'));
        }
      });
    };

    tryConnect(attempts);
  });
}

function isAddressInUseError(error) {
  return error?.code === 'EADDRINUSE' || /EADDRINUSE/i.test(String(error?.message || ''));
}

/**
 * Determina a qué host atar el servidor Express embebido.
 * - Por defecto: 127.0.0.1 (solo localhost, seguro).
 * - Si POS_ALLOW_LAN=true: 0.0.0.0 (expone a LAN, necesario para mobile POS QR).
 * - Permite override explícito con POS_BIND_HOST.
 */
function resolveTerminalConfigPath(appRoot) {
  const candidates = [
    path.join(appRoot, 'config', 'terminal-config.json'),
    path.join(appRoot, '..', 'config', 'terminal-config.json'),
    path.join(appRoot, '..', '..', 'config', 'terminal-config.json'),
    path.join(process.cwd(), 'config', 'terminal-config.json')
  ];

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  return found || candidates[0];
}

function inferBindHostFromTerminalConfig(appRoot) {
  try {
    const terminalConfigPath = resolveTerminalConfigPath(appRoot);
    logStartup(`[inferBindHostFromTerminalConfig] Buscando en: ${terminalConfigPath}`);
    if (!fs.existsSync(terminalConfigPath)) {
      logStartup(`[inferBindHostFromTerminalConfig] Archivo no encontrado`);
      return '';
    }
    const terminalConfig = JSON.parse(fs.readFileSync(terminalConfigPath, 'utf8'));
    const mode = String(terminalConfig?.setupMode || '').trim().toLowerCase();
    const isMain = terminalConfig?.isMain !== false;
    logStartup(`[inferBindHostFromTerminalConfig] Detectado: mode=${mode}, isMain=${isMain}`);
    if (isMain && ['multicaja', 'multisucursal', 'sucursal'].includes(mode)) {
      logStartup(`[inferBindHostFromTerminalConfig] ✓ Debe usar 0.0.0.0 para LAN`);
      return '0.0.0.0';
    }
  } catch (_error) {
    logStartup(`[inferBindHostFromTerminalConfig] Error: ${_error.message}`);
  }
  return '';
}

function resolveServerBindHost(appRoot = '') {
  if (process.env.POS_BIND_HOST) return process.env.POS_BIND_HOST;
  const allowLan = String(process.env.POS_ALLOW_LAN || '').toLowerCase() === 'true';
  if (allowLan) return '0.0.0.0';
  const inferredHost = appRoot ? inferBindHostFromTerminalConfig(appRoot) : '';
  if (inferredHost) return inferredHost;
  return '127.0.0.1';
}

function checkPortAvailability(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const tester = net.createServer();

    tester.once('error', () => {
      resolve(false);
    });

    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });

    tester.listen(port, host);
  });
}

async function findAvailablePort(startPort, maxAttempts = 20) {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidate = startPort + offset;
    const isAvailable = await checkPortAvailability(candidate);
    if (isAvailable) {
      return candidate;
    }
  }
  return null;
}

async function canUseExistingServer(url) {
  try {
    await waitForServer(url, 3);
    return true;
  } catch (_error) {
    return false;
  }
}

async function canReuseExistingServerForBind(port, bindHost) {
  const preferredUrl = buildLocalUrl(port);
  if (!await canUseExistingServer(preferredUrl)) {
    return false;
  }

  if (bindHost !== '0.0.0.0') {
    return true;
  }

  const probeUrls = getNetworkProbeUrls(port);
  if (!probeUrls.length) {
    return false;
  }

  for (const url of probeUrls) {
    if (await canUseExistingServer(url)) {
      return true;
    }
  }
  return false;
}

async function startServer() {
  if (serverRuntime) return;
  const appRoot = app.getAppPath();
  const { prepareRuntimeEnvironment } = require(path.join(appRoot, 'scripts', 'runtime-bootstrap'));
  const runtime = prepareRuntimeEnvironment({
    appRoot,
    userDataPath: app.getPath('userData')
  });

  process.env.TECNO_CAJA_USER_DATA = runtime.userDataPath;
  process.env.PORT = String(DEFAULT_ELECTRON_PORT);
  process.env.DB_FILE = runtime.dbFile || path.join(app.getPath('userData'), 'data', 'tecnocaja.db');
  process.env.PRODUCT_UPLOAD_DIR = runtime.productUploadDir || path.join(app.getPath('userData'), 'uploads', 'productos');
  process.env.SECURE_BACKUP_DIR = runtime.secureBackupDir || path.join(app.getPath('userData'), 'secure-backups');

  for (const warning of runtime.warnings || []) {
    logStartup(`[runtime-bootstrap] ${warning}`);
  }

  if (String(process.env.DB_CLIENT || 'sqlite').trim().toLowerCase() === 'mysql') {
    const { ensureLocalMysqlAvailable } = require(path.join(appRoot, 'scripts', 'ensure-local-mysql'));
    const mysqlStatus = await ensureLocalMysqlAvailable({
      log: (message) => logStartup(`[mysql-runtime] ${message}`)
    });
    logStartup(`MySQL runtime status: ${JSON.stringify(mysqlStatus)}`);

    if (mysqlStatus.status === 'error' || mysqlStatus.status === 'unavailable') {
      throw new Error(mysqlStatus.reason || 'No se pudo preparar MariaDB/MySQL local.');
    }
  }

  const serverEntry = path.join(appRoot, 'server.js');
  logStartup(`App root: ${appRoot}`);
  logStartup(`User data: ${process.env.TECNO_CAJA_USER_DATA}`);
  logStartup(`Server entry: ${serverEntry}`);
  logStartup(`DB file: ${process.env.DB_FILE}`);
  const serverModule = require(serverEntry);
  serverRuntime = serverModule;
  let startupError = null;
  let targetPort = Number(process.env.PORT || DEFAULT_ELECTRON_PORT);

  try {
    process.env.PORT = String(targetPort);
    const bindHost = resolveServerBindHost(appRoot);
    logStartup(`Binding server to ${bindHost}:${targetPort} (LAN ${bindHost === '0.0.0.0' ? 'ENABLED' : 'disabled'})`);
    await serverModule.startHttpServer(targetPort, bindHost);
    await waitForServer(buildLocalUrl(targetPort));
    currentServerPort = targetPort;
    currentAppUrl = buildLocalUrl(targetPort);
    logStartup(`Internal server ready on port ${targetPort}`);
    if (isServeoTunnelEnabled()) {
      startServeoTunnel();
    } else {
      logStartup('Serveo SSH Tunnel deshabilitado por configuración');
    }
    return;
  } catch (error) {
    startupError = error;
    logStartup(`Internal server startup issue: ${error?.stack || error?.message || error}`);
  }

  if (isAddressInUseError(startupError)) {
    const bindHost = resolveServerBindHost(appRoot);
    if (await canReuseExistingServerForBind(targetPort, bindHost)) {
      const preferredUrl = buildLocalUrl(targetPort);
      currentServerPort = targetPort;
      currentAppUrl = preferredUrl;
      logStartup(`Reusing existing local server on port ${targetPort}`);
      return;
    }

    if (bindHost === '0.0.0.0') {
      startupError = new Error(
        `El puerto ${targetPort} ya está ocupado por un servidor que no está publicado en la red. ` +
        'Cierra por completo Tecno Caja y vuelve a abrirlo para habilitar la conexión multicaja.'
      );
      startupError.code = 'LAN_RESTART_REQUIRED';
    } else {
      const alternatePort = await findAvailablePort(targetPort + 1, 20);
      if (alternatePort) {
        try {
          process.env.PORT = String(alternatePort);
          await serverModule.startHttpServer(alternatePort, bindHost);
          await waitForServer(buildLocalUrl(alternatePort));
          currentServerPort = alternatePort;
          currentAppUrl = buildLocalUrl(alternatePort);
          logStartup(`Internal server moved to alternate port ${alternatePort}`);
          return;
        } catch (alternateError) {
          startupError = alternateError;
          logStartup(`Alternate port startup failed: ${alternateError?.stack || alternateError?.message || alternateError}`);
        }
      }
    }
  }

  const fallbackUrl = buildLocalUrl(FALLBACK_APP_PORT);
  if (await canUseExistingServer(fallbackUrl)) {
    currentServerPort = FALLBACK_APP_PORT;
    currentAppUrl = fallbackUrl;
    logStartup(`Using fallback server already available on port ${FALLBACK_APP_PORT}`);
    return;
  }

  const details = startupError?.message || 'Error desconocido';
  const isPortBusy = isAddressInUseError(startupError);
  dialog.showErrorBox(
    'Error al iniciar el servidor',
    isPortBusy
      ? `No se pudo iniciar el servidor interno porque el puerto local ${targetPort} ya está en uso y tampoco fue posible recuperar otro puerto.\n\nDetalles: ${details}`
      : `No se pudo iniciar el servidor interno.\n\nDetalles: ${details}`
  );
  app.quit();
}

function startServeoTunnel() {
  try {
    const home = os.homedir();
    const ed25519 = path.join(home, '.ssh', 'id_ed25519');
    const rsa     = path.join(home, '.ssh', 'id_rsa');
    const keyPath = fs.existsSync(ed25519) ? ed25519 : fs.existsSync(rsa) ? rsa : null;

    const args = [
      ...(keyPath ? ['-i', keyPath] : []),
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=60',
      '-o', 'ExitOnForwardFailure=yes',
      '-R', 'tecnocaja:80:127.0.0.1:3399',
      'serveo.net'
    ];

    tunnelProcess = spawn('ssh', args, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    tunnelProcess.stdout.on('data', (data) => {
      const m = data.toString().match(/https?:\/\/\S+/);
      if (m) logStartup(`Túnel público activo: ${m[0]}`);
    });
    tunnelProcess.stderr.on('data', (data) => {
      logStartup(`Serveo: ${data.toString().trim()}`);
    });
    tunnelProcess.on('error', (e) => {
      logStartup(`Serveo Tunnel error: ${e.message}`);
      tunnelProcess = null;
    });
    tunnelProcess.on('exit', () => { tunnelProcess = null; });
    logStartup('Serveo SSH Tunnel iniciado');
  } catch (e) {
    logStartup(`Serveo Tunnel no pudo iniciar: ${e.message}`);
  }
}

function stopServeoTunnel() {
  if (!tunnelProcess) return;
  try { tunnelProcess.kill(); } catch (_) {}
  tunnelProcess = null;
}

async function stopServer() {
  stopServeoTunnel();
  if (!serverRuntime?.stopHttpServer) {
    serverRuntime = null;
    return;
  }
  await serverRuntime.stopHttpServer().catch(() => {});
  serverRuntime = null;
}

ipcMain.handle('secure-backup:open-folder', async (_event, password) => {
  try {
    await verifySecurityPassword(String(password || ''));
    const secureBackupDir = getSecureBackupDir();
    fs.mkdirSync(secureBackupDir, { recursive: true });
    const openResult = await shell.openPath(secureBackupDir);
    if (openResult) {
      return { ok: false, error: openResult };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || 'Clave de seguridad incorrecta.' };
  }
});

ipcMain.handle('app:open-external', async (_event, targetUrl) => {
  try {
    const candidate = String(targetUrl || '').trim();
    if (!/^https?:\/\//i.test(candidate)) {
      return { ok: false, error: 'La URL externa no es válida.' };
    }
    await shell.openExternal(candidate);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || 'No se pudo abrir el enlace externo.' };
  }
});

ipcMain.handle('app:restart', async () => {
  try {
    app.isQuitting = true;
    setTimeout(() => {
      stopServer()
        .catch(() => {})
        .finally(() => {
          try {
            app.relaunch();
          } catch (_error) {
            // Ignorar y continuar con el cierre.
          }
          app.exit(0);
        });
    }, 60);
    return { ok: true };
  } catch (error) {
    app.isQuitting = false;
    return { ok: false, error: error?.message || 'No se pudo reiniciar la aplicación.' };
  }
});

ipcMain.handle('app:close-whatsapp-guide', async () => {
  closeWhatsAppGuideWindow();
  return { ok: true };
});

ipcMain.handle('app:disable-whatsapp-paste-guide', async () => {
  try {
    await updateWhatsAppPasteGuideEnabled(false, {
      actorUserName: 'Sistema',
      actorUserRole: 'Sistema'
    });
    notifyWhatsAppGuidePreferenceChanged(false);
    closeWhatsAppGuideWindow();
    return { ok: true, enabled: false };
  } catch (error) {
    return { ok: false, error: error?.message || 'No se pudo desactivar la guía de WhatsApp.' };
  }
});

async function openWhatsAppWindow(targetUrl = WHATSAPP_WEB_URL, options = {}) {
  try {
    const safeUrl = normalizeWhatsAppWebTargetUrl(targetUrl);
    const forceNavigate = Boolean(options?.forceNavigate);
    const preferInAppNavigation = Boolean(options?.preferInAppNavigation);
    if (whatsappWindow && !whatsappWindow.isDestroyed()) {
      const currentUrl = getCurrentWhatsAppUrl();
      const needsNavigation = forceNavigate
        ? currentUrl !== safeUrl
        : false;
      if (whatsappWindow.isMinimized()) {
        whatsappWindow.restore();
      }
      if (needsNavigation) {
        let navigatedInApp = false;
        if (preferInAppNavigation) {
          const chatPhone = extractWhatsAppPhoneFromUrl(safeUrl);
          if (chatPhone) {
            navigatedInApp = await openWhatsAppChatInCurrentSession(chatPhone);
          }
          if (!navigatedInApp) {
            navigatedInApp = await navigateWhatsAppWindowInApp(safeUrl);
          }
        }
        if (!navigatedInApp) {
          await whatsappWindow.loadURL(safeUrl, {
            userAgent: WHATSAPP_WEB_USER_AGENT
          });
        }
      }
      whatsappWindow.setSkipTaskbar(true);
      whatsappWindow.show();
      whatsappWindow.focus();
      if (whatsappGuideState) {
        renderWhatsAppGuideState();
      }
      return { ok: true };
    }

    whatsappWindow = new BrowserWindow({
      width: 1100,
      height: 780,
      resizable: false,
      maximizable: false,
      backgroundColor: '#111827',
      autoHideMenuBar: true,
      show: false,
      skipTaskbar: true,
      parent: mainWindow || undefined,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: WHATSAPP_SESSION_PARTITION
      }
    });

    whatsappWindow.setMenuBarVisibility(false);
    whatsappWindow.webContents.setUserAgent(WHATSAPP_WEB_USER_AGENT);
    if (!whatsappGuideInputHookInstalled) {
      whatsappWindow.webContents.on('before-input-event', (_event, input) => {
        if (!whatsappGuideState || !input || input.type !== 'keyDown') return;
        const key = String(input.key || '').toLowerCase();
        if ((input.control || input.meta) && key === 'v') {
          markWhatsAppGuidePasted();
          return;
        }
        if (key === 'enter') {
          markWhatsAppGuideSent();
        }
      });
      whatsappGuideInputHookInstalled = true;
    }
    whatsappWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(String(url || ''))) {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });

    await whatsappWindow.loadURL(safeUrl, {
      userAgent: WHATSAPP_WEB_USER_AGENT
    });
    whatsappWindow.show();
    whatsappWindow.focus();
    whatsappWindow.on('move', () => {
      if (whatsappGuideState && whatsappGuideWindow && !whatsappGuideWindow.isDestroyed()) {
        whatsappGuideWindow.setBounds(getWhatsAppGuideBounds());
      }
    });
    whatsappWindow.on('resize', () => {
      if (whatsappGuideState && whatsappGuideWindow && !whatsappGuideWindow.isDestroyed()) {
        whatsappGuideWindow.setBounds(getWhatsAppGuideBounds());
      }
    });
    whatsappWindow.on('minimize', () => {
      setTimeout(() => {
        hideWhatsAppWindow({ restoreBeforeHide: false });
      }, 0);
    });
    whatsappWindow.on('close', (event) => {
      if (app.isQuitting) return;
      event.preventDefault();
      hideWhatsAppWindow();
    });
    whatsappWindow.on('closed', () => {
      closeWhatsAppGuideWindow();
      whatsappWindow = null;
      whatsappGuideInputHookInstalled = false;
    });
    return { ok: true };
  } catch (error) {
    closeWhatsAppGuideWindow();
    if (whatsappWindow && !whatsappWindow.isDestroyed()) {
      whatsappWindow.destroy();
      whatsappWindow = null;
    }
    whatsappGuideInputHookInstalled = false;
    return { ok: false, error: error.message || 'No se pudo abrir WhatsApp Web.' };
  }
}

ipcMain.handle('app:open-whatsapp-web', async (_event, payload = '') => {
  const targetUrl = String(payload || '').trim();
  return openWhatsAppWindow(targetUrl || WHATSAPP_WEB_URL, {
    forceNavigate: !isWhatsAppHomeUrl(targetUrl)
  });
});

ipcMain.handle('app:open-whatsapp-chat', async (_event, payload = {}) => {
  const phone = String(payload?.phone || '').replace(/[^\d]/g, '');
  const text = String(payload?.text || '').trim();
  const showPasteGuideOverlay = Boolean(payload?.showPasteGuide);
  const customerName = String(payload?.customerName || '').trim();
  if (!phone) {
    return { ok: false, error: 'El cliente no tiene un teléfono válido para WhatsApp.' };
  }

  const result = await openWhatsAppWindow(buildWhatsAppWebUrl(phone, text), {
    forceNavigate: true,
    preferInAppNavigation: true
  });
  if (result?.ok && showPasteGuideOverlay) {
    showWhatsAppPasteGuide({ customerName, phone });
  }
  return result;
});

ipcMain.handle('app:open-whatsapp-chat-with-pdf', async (_event, payload = {}) => {
  const phone = String(payload?.phone || '').replace(/[^\d]/g, '');
  const text = String(payload?.text || '').trim();
  const mediaDataUrl = String(payload?.mediaDataUrl || payload?.pdfDataUrl || '').trim();
  const fileName = String(payload?.fileName || 'factura.jpg').trim() || 'factura.jpg';
  const isImagePayload = /^data:image\//i.test(mediaDataUrl);

  if (!phone) {
    return { ok: false, attached: false, error: 'El cliente no tiene un teléfono válido para WhatsApp.' };
  }

  const opened = await openWhatsAppWindow(buildWhatsAppWebUrl(phone, ''), {
    forceNavigate: true,
    preferInAppNavigation: true
  });
  if (!opened?.ok) {
    return { ok: false, attached: false, error: opened?.error || 'No se pudo abrir WhatsApp Web.' };
  }

  if (!mediaDataUrl) {
    return { ok: true, attached: false, error: 'No se recibió el archivo para adjuntar.' };
  }

  let attached = null;
  if (isImagePayload) {
    attached = await pasteImageInWhatsAppWindow(mediaDataUrl, text);
  } else {
    attached = await attachMediaInWhatsAppWindow(mediaDataUrl, fileName);
  }

  return {
    ok: Boolean(attached?.ok || opened?.ok),
    attached: Boolean(attached?.attached),
    sent: Boolean(attached?.sent),
    error: attached?.error || ''
  };
});

ipcMain.handle('app:list-printers', async () => {
  try {
    return { ok: true, printers: await getAvailablePrinters() };
  } catch (error) {
    return { ok: false, error: error.message || 'No se pudieron consultar las impresoras.' };
  }
});

ipcMain.handle('scale:list-serial-ports', async () => {
  try {
    return await listSerialPorts();
  } catch (error) {
    return { ok: false, error: error.message || 'No se pudieron listar los puertos COM.' };
  }
});

ipcMain.handle('scale:read-weight', async (_event, config = {}) => {
  try {
    const scaleType = String(config?.type || config?.scaleType || 'none').trim().toLowerCase();
    if (scaleType !== 'serial') {
      return {
        ok: false,
        error: 'La lectura directa solo aplica a básculas seriales. Para USB tipo teclado usa la pantalla de peso del POS.'
      };
    }
    return await readWeightFromSerial(config);
  } catch (error) {
    return { ok: false, error: error.message || 'No se pudo leer la báscula.' };
  }
});

ipcMain.handle('receipt:print-html', async (_event, html, options = {}) => {
  let printWindow = null;
  let tempPrintFile = null;
  try {
    const layout = resolvePaperLayout(options?.paperSize);
    const normalizedPaperSize = String(options?.paperSize || '80mm').toLowerCase();
    const isThermalPrint = normalizedPaperSize === '58mm' || normalizedPaperSize === '80mm';
    const printableHtml = buildPrintShell(String(html || ''), layout);
    tempPrintFile = path.join(os.tmpdir(), `tecnocaja-receipt-${Date.now()}-${Math.random().toString(16).slice(2)}.html`);
    fs.writeFileSync(tempPrintFile, printableHtml, 'utf8');
    printWindow = new BrowserWindow({
      show: false,
      width: layout.previewWidth || 420,
      height: layout.previewHeight || 900,
      backgroundColor: '#ffffff',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    await printWindow.loadFile(tempPrintFile);
    await waitForPrintWindowReady(printWindow);

    const mode = String(options?.mode || 'dialog').toLowerCase();
    const printerName = String(options?.printerName || '').trim();
    const shouldUsePrinterDefaultPageSize = mode !== 'direct';
    const printOptions = {
      silent: mode === 'direct',
      printBackground: !isThermalPrint,
      deviceName: printerName || undefined,
      color: !isThermalPrint,
      margins: { marginType: 'none' },
      scaleFactor: 100,
      pagesPerSheet: 1,
      copies: 1,
      collate: false,
      duplexMode: 'simplex',
      landscape: Boolean(layout.landscape)
    };
    if (shouldUsePrinterDefaultPageSize) {
      printOptions.usePrinterDefaultPageSize = true;
    } else if (isThermalPrint) {
      printOptions.dpi = { horizontal: 203, vertical: 203 };
      const contentHeightPx = await printWindow.webContents.executeJavaScript(`
        (() => {
          const root = document.querySelector('.ticket-print') ||
                       document.querySelector('.receipt-sheet') ||
                       document.querySelector('.print-root') ||
                       document.body;
          const rootRect = root.getBoundingClientRect();
          const visibleNodes = [root, ...Array.from(root.querySelectorAll('*'))].filter((node) => {
            const style = window.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          const lastNode = visibleNodes[visibleNodes.length - 1] || root;
          const lastRect = lastNode.getBoundingClientRect();
          const rootStyle = window.getComputedStyle(root);
          const paddingTop = parseFloat(rootStyle.paddingTop || '0') || 0;
          const paddingBottom = parseFloat(rootStyle.paddingBottom || '0') || 0;
          const contentHeight = Math.ceil((lastRect.bottom - rootRect.top) + paddingBottom);
          return Math.max(1, Math.ceil(contentHeight + paddingTop));
        })()`
      );
      const widthMicrons = normalizedPaperSize === '58mm' ? 58000 : 80000;
      const heightMicrons = Math.max(18000, Math.ceil(contentHeightPx * (25400 / 96)) + 1200);
      printOptions.pageSize = { width: widthMicrons, height: heightMicrons };
    } else {
      printOptions.pageSize = layout.pageSize;
    }

    let effectivePrintOptions = { ...printOptions };
    let result = await runReceiptPrintJob(printWindow, effectivePrintOptions);
    if (!result.ok && printerName) {
      result = await runReceiptPrintJob(printWindow, {
        ...effectivePrintOptions,
        deviceName: undefined
      });
    }

    printWindow.close();
    if (tempPrintFile && fs.existsSync(tempPrintFile)) {
      fs.unlinkSync(tempPrintFile);
    }
    return result;
  } catch (error) {
    if (printWindow && !printWindow.isDestroyed()) {
      printWindow.close();
    }
    if (tempPrintFile && fs.existsSync(tempPrintFile)) {
      fs.unlinkSync(tempPrintFile);
    }
    return { ok: false, error: error.message || 'No se pudo preparar la impresión.' };
  }
});

// ─── ESC/POS: Impresión térmica directa (sin HTML/Chromium) ──────────────────
ipcMain.handle('receipt:print-escpos', async (_event, receiptData, options = {}) => {
  try {
    const printerName = String(options.printerName || '').trim();
    if (!printerName) {
      return { ok: false, error: 'Nombre de impresora no especificado para ESC/POS.' };
    }
    const result = await printReceipt(printerName, receiptData);
    return result;
  } catch (err) {
    return { ok: false, error: err.message || 'Error en impresión ESC/POS.' };
  }
});

// ─── ESC/POS: Impresión de Corte de Caja directo a impresora térmica ────────
ipcMain.handle('corte:print-escpos', async (_event, corteData, options = {}) => {
  try {
    const printerName = String(options.printerName || '').trim();
    if (!printerName) {
      return { ok: false, error: 'Nombre de impresora no especificado para imprimir el corte.' };
    }
    const result = await printCorteReceipt(printerName, corteData);
    return result;
  } catch (err) {
    return { ok: false, error: err.message || 'Error imprimiendo el corte de caja.' };
  }
});

// ─── Apertura de gaveta registradora ────────────────────────────────────────
ipcMain.handle('cash-drawer:open', async (_event, config = {}) => {
  try {
    const result = await openCashDrawerAll(config);
    return result;
  } catch (err) {
    return { ok: false, error: err.message || 'No se pudo abrir la gaveta.' };
  }
});

// ─── Prueba de gaveta (diagnóstico desde configuración) ─────────────────────
ipcMain.handle('cash-drawer:test', async (_event, config = {}) => {
  try {
    const result = await testDrawer(config);
    return result;
  } catch (err) {
    return { ok: false, error: err.message || 'Error probando la gaveta.' };
  }
});

// ─── Apertura de gaveta ESC/POS directa (via impresora térmica) ─────────────
ipcMain.handle('cash-drawer:open-escpos', async (_event, printerName, pin = 0) => {
  try {
    const name = String(printerName || '').trim();
    if (!name) return { ok: false, error: 'Nombre de impresora requerido.' };
    return await escposOpenDrawer(name, pin);
  } catch (err) {
    return { ok: false, error: err.message || 'Error abriendo gaveta ESC/POS.' };
  }
});

// ── Guardado automático de facturas en PDF ────────────────────────────────────
ipcMain.handle('invoice:save-pdf', async (_event, payload = {}) => {
  try {
    const {
      invoiceNumber = 'FACTURA',
      clientName    = 'Consumidor Final',
      date          = new Date().toISOString(),
      businessName  = 'Tecno Caja',
      branchName    = 'Principal',
      pdfBase64     = ''
    } = payload;

    if (!pdfBase64) {
      return { ok: false, error: 'No se recibió el contenido PDF para guardar.' };
    }

    // Sanitize name segments so they're safe for Windows NTFS paths
    function sanitizePathSegment(value, maxLen = 40) {
      return String(value || 'sin-nombre')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // strip accents
        .replace(/[\\/:*?"<>|]/g, '_')                       // invalid chars
        .replace(/\s+/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^[._]+|[._]+$/g, '')
        .slice(0, maxLen) || 'sin-nombre';
    }

    // Build date parts
    const d = new Date(date);
    const year  = isNaN(d) ? new Date().getFullYear() : d.getFullYear();
    const month = isNaN(d) ? String(new Date().getMonth() + 1).padStart(2, '0')
                           : String(d.getMonth() + 1).padStart(2, '0');
    const day   = isNaN(d) ? String(new Date().getDate()).padStart(2, '0')
                           : String(d.getDate()).padStart(2, '0');

    // Folder: {userData}/facturas/{negocio}/{sucursal}/{año}/{mes}/
    const baseDir = path.join(app.getPath('userData'), 'facturas');
    const invoiceDir = path.join(
      baseDir,
      sanitizePathSegment(businessName),
      sanitizePathSegment(branchName),
      String(year),
      month
    );
    fs.mkdirSync(invoiceDir, { recursive: true });

    // Filename: {invoiceNumber}_{clientName}_{YYYY-MM-DD}.pdf
    const safeName = `${sanitizePathSegment(invoiceNumber, 30)}_${sanitizePathSegment(clientName, 30)}_${year}-${month}-${day}.pdf`;

    // Avoid overwriting — append counter if needed
    let targetPath = path.join(invoiceDir, safeName);
    if (fs.existsSync(targetPath)) {
      const base = safeName.replace(/\.pdf$/i, '');
      let counter = 2;
      while (fs.existsSync(path.join(invoiceDir, `${base}_${counter}.pdf`))) {
        counter++;
      }
      targetPath = path.join(invoiceDir, `${base}_${counter}.pdf`);
    }

    // Strip data-URI prefix if present
    const base64Clean = pdfBase64
      .replace(/^data:application\/pdf;base64,/i, '')
      .replace(/^data:[^;]+;base64,/i, '');

    const buffer = Buffer.from(base64Clean, 'base64');
    if (!buffer.length) {
      return { ok: false, error: 'El PDF generado está vacío.' };
    }

    fs.writeFileSync(targetPath, buffer);
    logStartup(`Invoice PDF saved: ${targetPath}`);

    return { ok: true, filePath: targetPath };
  } catch (error) {
    logStartup(`Invoice save error: ${error?.message || error}`);
    return { ok: false, error: error?.message || 'No se pudo guardar el PDF de la factura.' };
  }
});

ipcMain.handle('receipt-image:copy', async (_event, dataUrl) => {
  try {
    const image = nativeImage.createFromDataURL(String(dataUrl || ''));
    if (image.isEmpty()) {
      return { ok: false, error: 'No se pudo generar la imagen del comprobante.' };
    }
    clipboard.writeImage(image);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || 'No se pudo copiar la imagen al portapapeles.' };
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  MODO THIN-CLIENT (terminal caja secundaria)
//  Si terminal-config.json tiene { isMain: false, serverUrl: "http://..." }
//  la app NO arranca servidor propio — carga la URL del principal.
// ══════════════════════════════════════════════════════════════════════════════

function _getTerminalConfigPath() {
  return resolveTerminalConfigPath(app.getAppPath());
}

function readThinClientConfig() {
  try {
    const p = _getTerminalConfigPath();
    if (!fs.existsSync(p)) return null;
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (cfg && cfg.isMain === false && cfg.serverUrl) return cfg;
  } catch (_) {}
  return null;
}

// Prueba si la URL apunta a un servidor Tecno Caja real (GET /api/network/identify)
function probeTecnoCajaServer(serverUrl, timeoutMs) {
  var ms = timeoutMs || 5000;
  return new Promise(function(resolve) {
    try {
      var url = new URL('/api/network/identify', serverUrl);
      var mod  = url.protocol === 'https:' ? require('https') : http;
      var req  = mod.get(url.href, { timeout: ms }, function(res) {
        var body = '';
        res.on('data', function(d) { body += d; });
        res.on('end', function() {
          try {
            var json = JSON.parse(body);
            if (json && json.app === 'Tecno Caja') resolve({ ok: true, meta: json });
            else resolve({ ok: false, error: 'La URL no es un servidor Tecno Caja.' });
          } catch (e) {
            resolve({ ok: false, error: 'Respuesta inválida del servidor.' });
          }
        });
      });
      req.on('error', function(e) { resolve({ ok: false, error: e.message }); });
      req.on('timeout', function() { req.destroy(); resolve({ ok: false, error: 'Tiempo de espera agotado.' }); });
    } catch(e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

// IPC: Probar si una URL es un servidor Tecno Caja accesible
ipcMain.handle('terminal:test-server', async function(_event, serverUrl) {
  return probeTecnoCajaServer(String(serverUrl || '').trim());
});

// IPC: Guardar config thin-client y reiniciar como terminal
ipcMain.handle('terminal:save-thin-client-config', async function(_event, payload) {
  try {
    var serverUrl   = String((payload && payload.serverUrl) || '').trim();
    var terminalName = String((payload && payload.terminalName) || 'Caja Secundaria').trim();
    if (!serverUrl) return { ok: false, error: 'URL del servidor requerida.' };

    var probe = await probeTecnoCajaServer(serverUrl);
    if (!probe.ok) return { ok: false, error: probe.error };

    var configPath = _getTerminalConfigPath();
    var dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(configPath, JSON.stringify({
      isMain:       false,
      serverUrl:    serverUrl,
      terminalName: terminalName,
      terminalId:   require('crypto').randomBytes(6).toString('hex'),
      setupMode:    'multicaja',
      savedAt:      new Date().toISOString()
    }, null, 2));

    setTimeout(function() { app.relaunch(); app.quit(); }, 800);
    return { ok: true };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

// IPC: Leer config del terminal actual
ipcMain.handle('terminal:get-config', async function() {
  try {
    var p = _getTerminalConfigPath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch(_) { return null; }
});

// IPC: Resetear config (volver a modo principal)
ipcMain.handle('terminal:reset-config', async function() {
  try {
    var p = _getTerminalConfigPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
    setTimeout(function() { app.relaunch(); app.quit(); }, 800);
    return { ok: true };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

app.on('second-instance', function() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
});

/* ═══════════════════════════════════════════════════════════════════════════
   AUTO-UPDATER — electron-updater + GitHub Releases
   Documenta: https://www.electron.build/auto-update
═══════════════════════════════════════════════════════════════════════════ */
let autoUpdater = null;
let updaterReady = false;

try {
  ({ autoUpdater } = require('electron-updater'));
  updaterReady = true;
} catch (e) {
  logStartup('[updater] electron-updater no disponible: ' + e.message);
}

/** Envía evento de estado al renderer */
function sendUpdaterEvent(eventName, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('updater:' + eventName, payload || {});
}

/** Inicializa el autoUpdater y registra todos sus eventos */
function setupAutoUpdater() {
  if (!updaterReady || !autoUpdater) return;

  // ── Configuración ──────────────────────────────────────────────────────
  autoUpdater.autoDownload        = false;  // El usuario decide cuándo descargar
  autoUpdater.autoInstallOnAppQuit = true;  // Instala al cerrar si ya descargó
  autoUpdater.allowDowngrade      = false;  // No permite versiones menores

  // En desarrollo (no empaquetado): sólo loguea, no activa el updater real
  if (!app.isPackaged) {
    logStartup('[updater] Modo desarrollo → updater en modo demo (sin GitHub)');
    return;
  }

  // ── Eventos → IPC → Renderer ──────────────────────────────────────────
  autoUpdater.on('checking-for-update', () => {
    logStartup('[updater] Verificando actualizaciones…');
    sendUpdaterEvent('checking', {});
  });

  autoUpdater.on('update-available', (info) => {
    logStartup('[updater] Nueva versión disponible: ' + info.version);
    sendUpdaterEvent('available', {
      version     : info.version,
      releaseDate : info.releaseDate
        ? new Date(info.releaseDate).toLocaleDateString('es-DO')
        : '—',
      releaseNotes: parseReleaseNotes(info.releaseNotes),
      size        : info.files?.[0]?.size
        ? formatBytes(info.files[0].size)
        : '—',
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    logStartup('[updater] Sistema actualizado — versión: ' + info.version);
    sendUpdaterEvent('not-available', { version: info.version });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendUpdaterEvent('progress', {
      percent       : Math.round(progress.percent * 10) / 10,
      bytesPerSecond: progress.bytesPerSecond || 0,
      transferred   : progress.transferred || 0,
      total         : progress.total || 0,
      speedMB       : progress.bytesPerSecond
        ? (progress.bytesPerSecond / (1024 * 1024)).toFixed(1)
        : '0.0',
      timeLeft      : progress.bytesPerSecond && progress.total && progress.transferred
        ? Math.ceil((progress.total - progress.transferred) / progress.bytesPerSecond)
        : 0,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    logStartup('[updater] Descarga completada — versión: ' + info.version);
    sendUpdaterEvent('downloaded', {
      version     : info.version,
      releaseNotes: parseReleaseNotes(info.releaseNotes),
    });
  });

  autoUpdater.on('error', (err) => {
    const msg = (err && err.message) || String(err);
    logStartup('[updater] Error: ' + msg);
    sendUpdaterEvent('error', { message: msg });
  });
}

/** Convierte releaseNotes (string HTML o array) a array de strings limpios */
function parseReleaseNotes(notes) {
  if (!notes) return [];
  if (Array.isArray(notes)) {
    return notes.map(n => (typeof n === 'string' ? n : (n.note || n.body || ''))).filter(Boolean);
  }
  if (typeof notes === 'string') {
    // Quitar HTML básico y dividir por líneas
    return notes
      .replace(/<[^>]+>/g, '')
      .split('\n')
      .map(l => l.replace(/^[\s\-*•]+/, '').trim())
      .filter(l => l.length > 2);
  }
  return [];
}

function formatBytes(bytes) {
  if (!bytes) return '—';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? mb.toFixed(1) + ' MB' : (bytes / 1024).toFixed(0) + ' KB';
}

/* ── IPC Handlers del updater ─────────────────────────────────────────── */

/** Buscar actualizaciones */
ipcMain.handle('updater:check', async () => {
  if (!updaterReady || !autoUpdater) return { devMode: true };
  if (!app.isPackaged) return { devMode: true };
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** Descargar actualización */
ipcMain.handle('updater:download', async () => {
  if (!updaterReady || !autoUpdater) return { devMode: true };
  if (!app.isPackaged) return { devMode: true };
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** Instalar actualización y reiniciar */
ipcMain.handle('updater:install', () => {
  if (!updaterReady || !autoUpdater || !app.isPackaged) return;
  logStartup('[updater] Instalando y reiniciando…');
  // isSilent=false → muestra el progreso del instalador, isForceRunAfter=true → relanza la app
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
});

/** Versión actual */
ipcMain.handle('updater:get-version', () => ({
  version   : app.getVersion(),
  isPackaged: app.isPackaged,
}));

app.whenReady().then(async function() {
  try {
    // ── Detección de modo thin-client ───────────────────────────────────────
    var thinCfg = readThinClientConfig();
    if (thinCfg) {
      logStartup('[thin-client] Modo terminal → servidor principal: ' + thinCfg.serverUrl);
      var probe = await probeTecnoCajaServer(thinCfg.serverUrl, 8000);
      if (!probe.ok) {
        var choice = dialog.showMessageBoxSync({
          type: 'warning',
          title: 'Tecno Caja — Terminal',
          message: 'No se pudo conectar al servidor principal.\n\n' + thinCfg.serverUrl + '\n\nError: ' + probe.error,
          buttons: ['Reintentar', 'Abrir de todas formas', 'Reconfigurar terminal'],
          defaultId: 0,
          cancelId: 2
        });
        if (choice === 2) {
          try { fs.unlinkSync(_getTerminalConfigPath()); } catch(_) {}
          app.relaunch(); app.quit(); return;
        }
      }
      currentAppUrl = thinCfg.serverUrl;
      createWindow();
    } else {
      // Splash screen — show: false hasta ready-to-show para evitar destello blanco
      const splashHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{background:#0f172a;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
             display:flex;align-items:center;justify-content:center;height:100vh;user-select:none;-webkit-app-region:drag}
        .card{text-align:center;padding:40px 48px}
        .logo{font-size:36px;font-weight:800;color:#3B82F6;letter-spacing:-1px;margin-bottom:4px}
        .logo span{color:#60A5FA}
        .sub{font-size:11px;color:#475569;letter-spacing:3px;text-transform:uppercase;margin-bottom:28px}
        .bar-wrap{width:240px;height:3px;background:#1e293b;border-radius:99px;overflow:hidden;margin:0 auto}
        .bar{height:100%;width:0%;background:linear-gradient(90deg,#3B82F6,#60A5FA);border-radius:99px;
             animation:fill 2.4s cubic-bezier(.4,0,.2,1) forwards}
        @keyframes fill{0%{width:0%}60%{width:72%}85%{width:88%}100%{width:96%}}
        .status{font-size:11px;color:#475569;margin-top:14px;animation:fade 1s ease .3s both}
        @keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
      </style></head><body><div class="card">
        <div class="logo">Tecno<span>Caja</span></div>
        <div class="sub">Sistema Punto de Venta</div>
        <div class="bar-wrap"><div class="bar"></div></div>
        <div class="status">Iniciando sistema...</div>
      </div></body></html>`;

      const splashWin = new BrowserWindow({
        width: 420, height: 220, frame: false, resizable: false, center: true,
        backgroundColor: '#0f172a',
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });
      splashWin.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(splashHtml)}`);
      splashWin.once('ready-to-show', () => splashWin.show());

      // Arrancar servidor
      await startServer();

      // Crear mainWindow PRIMERO (aunque oculta) — evita que window-all-closed
      // dispare app.quit() al destruir el splash
      const windowReady = createWindow();
      splashWin.destroy();
      await windowReady;

      // Inicializar autoUpdater después de que mainWindow existe
      setupAutoUpdater();
    }
  } catch(error) {
    logStartup('Startup error: ' + (error && (error.stack || error.message) || error));
    dialog.showErrorBox(
      'Tecno Caja',
      (error && error.message) || 'No se pudo completar el arranque de Tecno Caja.'
    );
    app.quit();
  }

  app.on('activate', function() {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', function(e) {
  if (app.isQuitting) return;
  e.preventDefault();
  app.isQuitting = true;
  postJson(currentAppUrl + '/api/reports/auto-save-daily', {})
    .catch(function() {})
    .finally(function() { stopServer().catch(function() {}).finally(function() { app.quit(); }); });
});

app.on('window-all-closed', function() {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
