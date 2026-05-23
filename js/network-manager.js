// ══════════════════════════════════════════════════════════════════════════════
//  network-manager.js  —  Tecno Caja
//  Panel de gestión de Red: Multicaja LAN + Sucursales Remotas
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

// ── Estado local ──────────────────────────────────────────────────────────────
const _net = {
  status:      null,
  pingTimer:   null,
  refreshTimer: null,
  currentTab:  'terminales'
};

// ── Abrir / cerrar modal ──────────────────────────────────────────────────────
function openNetworkModal() {
  const modal = document.getElementById('network-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  loadNetworkStatus();
  _net.refreshTimer = setInterval(loadNetworkStatus, 15000);
}

function closeNetworkModal() {
  const modal = document.getElementById('network-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  document.body.style.overflow = '';
  if (_net.refreshTimer) { clearInterval(_net.refreshTimer); _net.refreshTimer = null; }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function switchNetworkTab(tab) {
  _net.currentTab = tab;
  document.querySelectorAll('.net-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.net-tab-pane').forEach(p => p.classList.toggle('hidden', p.dataset.tab !== tab));

  if (tab === 'lan')    loadLanGuide();
  if (tab === 'remote') loadRemoteGuide();
}

// ── Cargar estado principal ───────────────────────────────────────────────────
async function loadNetworkStatus() {
  try {
    const res  = await fetch('/api/network/status', { headers: _authHeaders() });
    if (!res.ok) {
      const msg = await res.json().then(j => j.error).catch(() => `Error ${res.status}`);
      _showNetError(msg); return;
    }
    _net.status = await res.json();
    renderNetworkStatus(_net.status);
    renderTerminalsTable(_net.status.terminals || []);
  } catch (e) {
    _showNetError('No se pudo conectar con el servidor.');
  }
}

// ── Renderizar encabezado de estado ──────────────────────────────────────────
function renderNetworkStatus(data) {
  // Barra de estado superior
  const dot     = document.getElementById('net-status-dot');
  const label   = document.getElementById('net-status-label');
  const ipsList = document.getElementById('net-ips-list');
  const urlBox  = document.getElementById('net-primary-url');
  const onlineCt = document.getElementById('net-online-count');
  const offlineCt = document.getElementById('net-offline-count');
  const lanBadge  = document.getElementById('net-lan-badge');
  const mainBadge = document.getElementById('net-main-badge');

  if (!dot) return;

  const online  = data.totalOnline  || 0;
  const offline = data.totalOffline || 0;

  dot.className   = 'net-status-dot ' + (data.lanEnabled ? 'green' : 'gray');
  label.textContent = data.isMain
    ? (data.lanEnabled ? '✅ Servidor principal activo — LAN habilitada' : '⚠️ Servidor principal — LAN deshabilitada')
    : '🔗 Terminal remoto conectado al servidor principal';

  if (onlineCt)  onlineCt.textContent  = `${online} en línea`;
  if (offlineCt) offlineCt.textContent = `${offline} desconectado${offline !== 1 ? 's' : ''}`;
  if (lanBadge)  lanBadge.textContent  = data.lanEnabled ? 'LAN activa' : 'LAN inactiva';
  if (lanBadge)  lanBadge.className    = 'net-badge ' + (data.lanEnabled ? 'badge-green' : 'badge-gray');
  if (mainBadge) mainBadge.textContent = data.isMain ? 'Principal' : 'Terminal';
  if (mainBadge) mainBadge.className   = 'net-badge ' + (data.isMain ? 'badge-blue' : 'badge-purple');

  // IPs locales
  if (ipsList) {
    ipsList.innerHTML = (data.localIPs || []).map(ip =>
      `<span class="net-ip-chip">${ip}:${data.port || 3399}</span>`
    ).join('') || '<span style="color:var(--text2);font-size:0.85rem">Sin IP LAN detectada</span>';
  }

  // URL primaria
  if (urlBox && data.primaryUrl) {
    urlBox.innerHTML = `
      <code class="net-url-code">${data.primaryUrl}</code>
      <button class="btn-icon" title="Copiar" onclick="copyNetworkUrl('${data.primaryUrl}')">📋</button>
    `;
  } else if (urlBox) {
    urlBox.innerHTML = '<span style="color:var(--text2);font-size:0.85rem">LAN no disponible</span>';
  }
}

// ── Tabla de terminales ───────────────────────────────────────────────────────
function renderTerminalsTable(terminals) {
  const tbody = document.getElementById('net-terminals-tbody');
  const empty = document.getElementById('net-terminals-empty');
  if (!tbody) return;

  if (!terminals.length) {
    tbody.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  tbody.innerHTML = terminals.map(t => {
    const statusCls = t.status === 'online' ? 'badge-green' : 'badge-gray';
    const statusTxt = t.status === 'online' ? '🟢 En línea' : '🔴 Desconectado';
    const typeTxt   = t.connectionType === 'remote' ? '🌐 Remoto' : t.connectionType === 'local' ? '💻 Local' : '🔗 LAN';
    const lastSeen  = t.lastSeenAt ? _relTime(new Date(t.lastSeenAt)) : '—';
    const mainIcon  = t.isMain ? '<span title="Servidor principal">⭐</span> ' : '';

    return `
      <tr>
        <td>
          ${mainIcon}<strong>${_esc(t.terminalName)}</strong>
          <div style="font-size:0.75rem;color:var(--text2)">${_esc(t.terminalId)}</div>
        </td>
        <td>${_esc(t.branchName)}</td>
        <td>${_esc(t.cashRegisterName)}</td>
        <td>${_esc(t.ipAddress || '—')}</td>
        <td><span class="net-badge ${statusCls}">${statusTxt}</span></td>
        <td>${typeTxt}</td>
        <td style="font-size:0.78rem;color:var(--text2)">${lastSeen}</td>
        <td>
          <div style="display:flex;gap:0.4rem">
            <button class="btn-icon" title="Reasignar sucursal/caja"
              onclick="openAssignTerminal('${_esc(t.terminalId)}','${_esc(t.terminalName)}')">✏️</button>
            ${!t.isMain ? `<button class="btn-icon btn-icon-danger" title="Eliminar registro"
              onclick="confirmRemoveTerminal('${_esc(t.terminalId)}','${_esc(t.terminalName)}')">🗑️</button>` : ''}
          </div>
        </td>
      </tr>`;
  }).join('');
}

// ── Asignar terminal a sucursal/caja ─────────────────────────────────────────
function openAssignTerminal(terminalId, terminalName) {
  const modal = document.getElementById('net-assign-modal');
  if (!modal) return;

  document.getElementById('net-assign-terminal-id').value   = terminalId;
  document.getElementById('net-assign-terminal-name').textContent = terminalName;

  // Cargar select de sucursales
  const branchSel   = document.getElementById('net-assign-branch');
  const registerSel = document.getElementById('net-assign-register');

  branchSel.innerHTML   = '<option value="">— Selecciona sucursal —</option>';
  registerSel.innerHTML = '<option value="">— Selecciona caja —</option>';

  const branches = _net.status?.branches || [];
  branches.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.nombre + (b.codigo ? ` (${b.codigo})` : '');
    branchSel.appendChild(opt);
  });

  branchSel.onchange = () => {
    const bid = Number(branchSel.value);
    const registers = (_net.status?.cashRegisters || []).filter(r => r.branch_id === bid);
    registerSel.innerHTML = '<option value="">— Selecciona caja —</option>';
    registers.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.nombre + (r.codigo ? ` (${r.codigo})` : '');
      registerSel.appendChild(opt);
    });
  };

  modal.classList.remove('hidden');
}

function closeAssignModal() {
  const modal = document.getElementById('net-assign-modal');
  if (modal) modal.classList.add('hidden');
}

async function saveTerminalAssignment() {
  const terminalId   = document.getElementById('net-assign-terminal-id').value;
  const branchId     = Number(document.getElementById('net-assign-branch').value) || null;
  const cashRegId    = Number(document.getElementById('net-assign-register').value) || null;

  if (!branchId || !cashRegId) {
    _netToast('Selecciona sucursal y caja.', 'warn'); return;
  }

  try {
    const res = await fetch(`/api/network/terminals/${encodeURIComponent(terminalId)}/assign`, {
      method: 'PUT',
      headers: _authHeaders(),
      body: JSON.stringify({ branchId, cashRegisterId: cashRegId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al reasignar.');
    _netToast('Terminal reasignado correctamente.', 'ok');
    closeAssignModal();
    loadNetworkStatus();
  } catch (e) {
    _netToast(e.message, 'error');
  }
}

// ── Eliminar terminal ─────────────────────────────────────────────────────────
function confirmRemoveTerminal(terminalId, terminalName) {
  if (!confirm(`¿Eliminar el registro del terminal "${terminalName}"?\nEl equipo podrá volver a registrarse.`)) return;
  removeTerminalEntry(terminalId);
}

async function removeTerminalEntry(terminalId) {
  try {
    const res  = await fetch(`/api/network/terminals/${encodeURIComponent(terminalId)}`, { method: 'DELETE', headers: _authHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al eliminar.');
    _netToast('Terminal eliminado del registro.', 'ok');
    loadNetworkStatus();
  } catch (e) {
    _netToast(e.message, 'error');
  }
}

// ── Guía LAN ─────────────────────────────────────────────────────────────────
async function loadLanGuide() {
  const container = document.getElementById('net-lan-guide');
  if (!container || container.dataset.loaded) return;

  // Detectar si estamos en Electron y si ya somos thin-client
  const isThinClient = await _isThinClientMode();

  try {
    const res  = await fetch('/api/network/lan-setup-guide', { headers: _authHeaders() });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`);
    const data = await res.json();

    container.innerHTML = `
      <div class="net-guide-header">
        <h3>🔗 Conectar cajas adicionales en la misma red (LAN)</h3>
        <p>Todas las cajas comparten la misma base de datos del servidor principal a través del WiFi o cable de red local.</p>
      </div>
      <div class="net-lan-status-bar">
        <span class="net-badge ${data.lanEnabled ? 'badge-green' : 'badge-orange'}">
          ${data.lanEnabled ? '✅ LAN habilitada' : '⚠️ LAN deshabilitada'}
        </span>
        ${data.lanEnabled && data.localIPs.length ? `
          <span style="font-size:0.85rem;color:var(--text2)">
            Accede desde otras PCs en: <strong>${data.accessUrls.join(', ')}</strong>
          </span>` : ''}
      </div>
      ${!data.lanEnabled ? `
        <div class="net-warn-box">
          ⚠️ <strong>LAN deshabilitada.</strong> Para habilitar, añade en tu archivo <code>.env</code>:<br>
          <code>POS_ALLOW_LAN=true</code><br>
          <code>TECNO_CAJA_MYSQL_ALLOW_LAN=true</code><br>
          Luego reinicia Tecno Caja.
        </div>` : ''}
      <div class="net-steps">
        ${data.steps.map(s => `
          <div class="net-step">
            <div class="net-step-num">${s.step}</div>
            <div class="net-step-body">
              <div class="net-step-title">
                ${s.done === true ? '✅ ' : s.done === false ? '⏳ ' : ''}${_esc(s.title)}
              </div>
              <pre class="net-step-desc">${_esc(s.description)}</pre>
            </div>
          </div>`).join('')}
      </div>
      ${_renderThinClientSection(isThinClient)}`;
    container.dataset.loaded = '1';
  } catch (e) {
    container.innerHTML = `<p style="color:var(--danger)">Error cargando guía: ${_esc(e.message)}</p>`;
  }
}

// ── Guía Sucursales Remotas ───────────────────────────────────────────────────
async function loadRemoteGuide() {
  const container = document.getElementById('net-remote-guide');
  if (!container || container.dataset.loaded) return;

  try {
    const res  = await fetch('/api/network/remote-setup-guide', { headers: _authHeaders() });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`);
    const data = await res.json();

    container.innerHTML = `
      <div class="net-guide-header">
        <h3>🌐 Conectar sucursales en ubicaciones distintas (Remoto)</h3>
        <p>Para sucursales en diferentes ciudades o edificios, todas se conectan a un servidor central vía internet.</p>
      </div>
      <div class="net-steps">
        ${data.steps.map(s => `
          <div class="net-step">
            <div class="net-step-num">${s.step}</div>
            <div class="net-step-body">
              <div class="net-step-title">${_esc(s.title)}</div>
              <pre class="net-step-desc">${_esc(s.description)}</pre>
            </div>
          </div>`).join('')}
      </div>
      <div class="net-info-box" style="margin-top:1.5rem">
        <strong>Comando Cloudflare Tunnel (rápido sin VPS):</strong><br>
        <code class="net-code-block">${_esc(data.cloudflareCmd)}</code>
        <button class="btn-icon" onclick="copyNetworkUrl('${_esc(data.cloudflareCmd)}')">📋 Copiar</button>
      </div>
      <div class="net-info-box" style="margin-top:1rem">
        <strong>Variables de entorno necesarias en el servidor principal:</strong>
        <pre class="net-code-block">${_esc(data.envExample)}</pre>
      </div>`;
    container.dataset.loaded = '1';
  } catch (e) {
    container.innerHTML = `<p style="color:var(--danger)">Error cargando guía: ${_esc(e.message)}</p>`;
  }
}

// ── Auto-registro del terminal al arrancar ────────────────────────────────────
async function autoRegisterThisTerminal() {
  try {
    // Leer config del terminal si existe (wizard ya la guarda)
    let terminalConfig = null;
    if (typeof window !== 'undefined' && window._terminalConfig) {
      terminalConfig = window._terminalConfig;
    }

    if (!terminalConfig?.terminalId) return; // No configurado aún

    await fetch('/api/network/terminals/register', {
      method: 'POST',
      headers: _authHeaders(),
      body: JSON.stringify({
        terminalId:    terminalConfig.terminalId,
        terminalName:  terminalConfig.terminalName  || null,
        branchId:      terminalConfig.branchId      || null,
        cashRegisterId: terminalConfig.cashRegisterId || null,
        connectionType: terminalConfig.isMain ? 'local' : 'lan',
        isMain:         !!terminalConfig.isMain
      })
    });

    // Iniciar heartbeat cada 30 segundos
    if (_net.pingTimer) clearInterval(_net.pingTimer);
    _net.pingTimer = setInterval(() => {
      fetch(`/api/network/terminals/${encodeURIComponent(terminalConfig.terminalId)}/ping`, { method: 'POST' })
        .catch(() => {});
    }, 30000);
  } catch (_) {}
}

// ── Auth helper ───────────────────────────────────────────────────────────────
function _authHeaders(extra = {}) {
  const token = window.DB?.authToken || window._authToken || '';
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
    ...extra
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function copyNetworkUrl(url) {
  navigator.clipboard?.writeText(url).then(() => _netToast('Copiado al portapapeles.', 'ok'))
    .catch(() => _netToast('No se pudo copiar.', 'warn'));
}

function _showNetError(msg) {
  const el = document.getElementById('net-error-bar');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function _netToast(msg, type = 'ok') {
  if (typeof showToast === 'function') { showToast(msg, type); return; }
  if (typeof novaToast === 'function') { novaToast(msg, type); return; }
  alert(msg);
}

function _esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _relTime(date) {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff <  60)  return 'hace unos segundos';
  if (diff < 3600) return `hace ${Math.floor(diff/60)} min`;
  if (diff < 86400)return `hace ${Math.floor(diff/3600)} h`;
  return `hace ${Math.floor(diff/86400)} días`;
}

// ── Thin-client helpers ───────────────────────────────────────────────────────
async function _isThinClientMode() {
  try {
    if (!window.novaDesktop || !window.novaDesktop.getTerminalConfig) return false;
    const cfg = await window.novaDesktop.getTerminalConfig();
    return cfg && cfg.isMain === false && !!cfg.serverUrl;
  } catch (_) { return false; }
}

function _renderThinClientSection(isThinClient) {
  if (!window.novaDesktop || !window.novaDesktop.saveAsThinClient) return '';

  if (isThinClient) {
    return `
      <div class="net-info-box" style="margin-top:1.5rem;border-left:4px solid #48bb78">
        <div style="font-weight:600;margin-bottom:0.4rem">&#x2705; Esta PC está configurada como terminal</div>
        <div style="font-size:0.85rem;color:var(--text2);margin-bottom:0.75rem">
          Conectada al servidor principal. Los datos se guardan allá.
        </div>
        <button class="btn-danger" onclick="resetThinClientConfig()" style="font-size:0.83rem">
          &#x1F504; Volver a modo servidor principal
        </button>
      </div>`;
  }

  return `
    <div class="net-info-box" style="margin-top:1.5rem;border-left:4px solid var(--primary)">
      <div style="font-weight:600;margin-bottom:0.5rem">&#x1F5A5;&#xFE0F; Configurar esta PC como terminal (caja secundaria)</div>
      <div style="font-size:0.85rem;color:var(--text2);margin-bottom:0.75rem">
        Esta PC dejará de ser servidor. Cargará la pantalla del servidor principal y todos los datos serán compartidos.
      </div>
      <div style="display:flex;flex-direction:column;gap:0.6rem;max-width:440px">
        <div>
          <label style="font-size:0.82rem;font-weight:600">URL del servidor principal</label>
          <input id="net-thin-server-url" class="form-input" style="margin-top:0.25rem"
            placeholder="http://192.168.1.5:3399" oninput="_clearThinResult()">
        </div>
        <div>
          <label style="font-size:0.82rem;font-weight:600">Nombre de esta caja (opcional)</label>
          <input id="net-thin-terminal-name" class="form-input" style="margin-top:0.25rem"
            placeholder="Caja 2">
        </div>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
          <button class="btn-secondary" onclick="testThinClientConnection()" style="font-size:0.83rem">
            &#x1F50D; Probar conexión
          </button>
          <button id="net-thin-connect-btn" class="btn-primary" style="font-size:0.83rem;display:none"
            onclick="saveThinClientConfig()">
            &#x2705; Conectar y reiniciar
          </button>
        </div>
        <div id="net-thin-result" style="font-size:0.83rem;margin-top:0.2rem"></div>
      </div>
    </div>`;
}

async function testThinClientConnection() {
  const urlInput  = document.getElementById('net-thin-server-url');
  const resultEl  = document.getElementById('net-thin-result');
  const connectBtn = document.getElementById('net-thin-connect-btn');
  if (!urlInput || !resultEl) return;

  const url = urlInput.value.trim();
  if (!url) { resultEl.innerHTML = '<span style="color:var(--danger)">Ingresa la URL del servidor.</span>'; return; }

  resultEl.innerHTML = '<span style="color:var(--text2)">Probando conexión…</span>';
  if (connectBtn) connectBtn.style.display = 'none';

  const result = await window.novaDesktop.testServerConnection(url);
  if (result.ok) {
    const name = result.meta && result.meta.businessName ? result.meta.businessName : 'Tecno Caja';
    const ver  = result.meta && result.meta.version ? result.meta.version : '?';
    resultEl.innerHTML = `<span style="color:#48bb78">&#x2705; Servidor encontrado: <strong>${_esc(name)}</strong> (v${_esc(ver)})</span>`;
    if (connectBtn) connectBtn.style.display = '';
  } else {
    resultEl.innerHTML = `<span style="color:var(--danger)">&#x274C; ${_esc(result.error)}</span>`;
  }
}

async function saveThinClientConfig() {
  const urlInput  = document.getElementById('net-thin-server-url');
  const nameInput = document.getElementById('net-thin-terminal-name');
  const resultEl  = document.getElementById('net-thin-result');
  const btn       = document.getElementById('net-thin-connect-btn');
  if (!urlInput) return;

  const url  = urlInput.value.trim();
  const name = (nameInput && nameInput.value.trim()) || 'Caja Secundaria';
  if (!url) return;

  if (!confirm('¿Configurar esta PC como terminal de:\n' + url + '\n\nLa app se reiniciará automáticamente.')) return;

  if (btn)     { btn.disabled = true; btn.textContent = 'Reiniciando…'; }
  if (resultEl) resultEl.innerHTML = '<span style="color:var(--text2)">Guardando y reiniciando…</span>';

  const result = await window.novaDesktop.saveAsThinClient(url, name);
  if (!result.ok) {
    if (btn)     { btn.disabled = false; btn.textContent = '✅ Conectar y reiniciar'; }
    if (resultEl) resultEl.innerHTML = `<span style="color:var(--danger)">❌ ${_esc(result.error)}</span>`;
  }
  // Si ok: la app se reinicia sola desde main.js
}

async function resetThinClientConfig() {
  if (!confirm('¿Volver a modo servidor principal?\n\nEsta PC volverá a arrancar su propio servidor. La app se reiniciará.')) return;
  await window.novaDesktop.resetTerminalConfig();
}

function _clearThinResult() {
  const r = document.getElementById('net-thin-result');
  const b = document.getElementById('net-thin-connect-btn');
  if (r) r.innerHTML = '';
  if (b) b.style.display = 'none';
}

// ── Auth helper ───────────────────────────────────────────────────────────────
function _authHeaders(extra) {
  const token = (window.DB && window.DB.authToken) || window._authToken || '';
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (extra) Object.assign(headers, extra);
  return headers;
}

// Inicializar al cargar
document.addEventListener('DOMContentLoaded', function() {
  autoRegisterThisTerminal();
});
