// ===== TECNO_CAJA - ESTADO DE CONEXIÓN Y SINCRONIZACIÓN =====
// Badge de la barra superior + ventana "Estado de conexión".
//
// Tres cosas distintas, cada una con su mensaje (GET /api/connectivity):
//   1. Servidor local (Express + base de datos en esta PC o en la principal
//      por la LAN). Si no responde: "Servidor local no disponible".
//   2. Internet. Si falta: "Sin Internet · modo local" — se vende igual; la
//      nube y la DGII se ponen al día cuando vuelva.
//   3. Pendientes: cola de la nube, e-CF firmados sin enviar y ventas de
//      contingencia de esta caja.
// Nunca se dice "Sin Internet" cuando lo que falla es el servidor local.

let _syncPollTimer = null;
let _lastSyncStatus = null;
let _lastConnectivity = null;

async function _fetchJson(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function _pendingText(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

// Decide qué mostrar a partir del estado de conexión (null = servidor caído).
function _describeConnectivity(c) {
  if (!c) {
    return {
      state: 'server-down',
      label: 'Servidor local no disponible',
      detail: 'Esta caja no recibe respuesta del servidor de Tecno Caja. Revisa que la PC principal esté encendida, con Tecno Caja abierto y en la misma red.'
    };
  }
  if (c.mode === 'contingencia') {
    const sales = Number(c.pending?.contingencySales || 0);
    return {
      state: 'contingency',
      label: sales ? `Modo contingencia · ${_pendingText(sales, 'venta', 'ventas')}` : 'Modo contingencia',
      detail: 'La PC principal no responde. Esta caja sigue vendiendo con su copia local y sube todo a la principal cuando vuelva.'
    };
  }
  if (c.mode === 'sin_bd') {
    return {
      state: 'error',
      label: 'Base de datos no responde',
      detail: c.database?.error || 'La base de datos de este equipo no respondió.'
    };
  }
  const pendingCloud = Number(c.pending?.cloud || 0);
  const pendingEcf = Number(c.pending?.ecf || 0);
  if (c.internet?.online === false) {
    const waiting = [
      pendingCloud ? _pendingText(pendingCloud, 'cambio para la nube', 'cambios para la nube') : '',
      pendingEcf ? _pendingText(pendingEcf, 'e-CF por enviar', 'e-CF por enviar') : ''
    ].filter(Boolean).join(' y ');
    return {
      state: 'local',
      label: 'Sin Internet · modo local',
      detail: `Servidor local conectado. Internet no disponible: puedes vender, cobrar, imprimir y usar la caja normal.${waiting ? ` Esperando conexión: ${waiting}.` : ''} Todo se envía solo cuando vuelva Internet.`
    };
  }
  const errors = Number(c.pending?.cloudErrors || 0);
  if (errors > 0) {
    return { state: 'error', label: `${errors} con error`, detail: 'Hay cambios que la nube rechazó. Ábrelo para reintentar.' };
  }
  if (pendingCloud + pendingEcf > 0) {
    return {
      state: 'pending',
      label: `${pendingCloud + pendingEcf} ${pendingCloud + pendingEcf === 1 ? 'pendiente' : 'pendientes'}`,
      detail: 'Enviando a la nube y a la DGII lo que quedó pendiente.'
    };
  }
  if (c.cloud?.ready === false) {
    return { state: 'offline', label: 'Nube no configurada', detail: 'Hay Internet, pero la nube (Firebase) no está configurada en este equipo. La caja funciona igual.' };
  }
  return { state: 'ok', label: 'Sincronizado', detail: 'Servidor local e Internet conectados. Todo al día.' };
}

// ── Actualizar badge del topbar ───────────────────────────────────────────────
async function _updateSyncBadge() {
  let connectivity = null;
  try {
    connectivity = await _fetchJson('/api/connectivity');
  } catch (_) {
    connectivity = null;
  }
  _lastConnectivity = connectivity;
  window.TcConnectivity = connectivity;
  const view = _describeConnectivity(connectivity);
  _setSyncBadge(view.state, view.label, view.detail);
}

// Solo marca el estado: los colores salen de css/shell.css (variables del tema).
const _SYNC_BADGE_ICONS = {
  ok: 'check',
  pending: 'refresh-cw',
  error: 'circle-alert',
  offline: 'cloud-off',
  local: 'cloud-off',
  contingency: 'triangle-alert',
  'server-down': 'circle-alert'
};

function _setSyncBadge(state, text, detail = '') {
  const button = document.getElementById('sync-status-btn');
  const dot    = document.getElementById('sync-dot');
  const label  = document.getElementById('sync-label');
  if (!button || !dot || !label) return;
  button.dataset.state = state;
  label.textContent = text;
  button.title = detail || text;
  if (dot.dataset.icon !== state) {
    dot.dataset.icon = state;
    const icon = _SYNC_BADGE_ICONS[state] || 'circle-alert';
    dot.innerHTML = window.TcIconos ? window.TcIconos.svg(icon, 16) : '';
  }
}

function _startSyncPoller() {
  if (_syncPollTimer) return;
  _updateSyncBadge();
  // 15 s: el aviso de "sin Internet" o "servidor no disponible" aparece rápido.
  _syncPollTimer = setInterval(_updateSyncBadge, 15000);
}

// ── Ventana "Estado de conexión" ──────────────────────────────────────────────
function openSyncMonitor() {
  const modal = document.getElementById('sync-monitor-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  refreshSyncMonitor();
}

function closeSyncMonitor() {
  const modal = document.getElementById('sync-monitor-modal');
  if (modal) modal.classList.add('hidden');
}

function _formatDateTime(value) {
  if (!value) return 'Nunca';
  if (window.TcFecha) return window.TcFecha.formatear(value);
  return new Date(value).toLocaleString('es-DO');
}

function _statusRow(label, value, tone = '') {
  const safe = (text) => String(text ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  return `<div class="tc-conn-row${tone ? ` is-${tone}` : ''}"><span>${safe(label)}</span><strong>${safe(value)}</strong></div>`;
}

async function refreshSyncMonitor() {
  const body = document.getElementById('sync-monitor-body');
  if (!body) return;
  body.innerHTML = '<div class="tc-conn-loading">Actualizando…</div>';

  let connectivity = null;
  let sync = null;
  try { connectivity = await _fetchJson('/api/connectivity'); } catch (_) { connectivity = null; }
  try { sync = await _fetchJson('/api/sync/status'); } catch (_) { sync = null; }
  _lastConnectivity = connectivity;
  _lastSyncStatus = sync;
  const view = _describeConnectivity(connectivity);
  _setSyncBadge(view.state, view.label, view.detail);

  const tone = {
    ok: 'success', pending: 'warning', local: 'warning', contingency: 'warning',
    error: 'danger', 'server-down': 'danger', offline: ''
  }[view.state] || '';

  const rows = [];
  if (!connectivity) {
    rows.push(_statusRow('Servidor local', 'No responde', 'danger'));
  } else {
    const roleText = connectivity.role === 'terminal' ? 'Base de la PC principal (LAN)' : 'Base de datos de este equipo';
    rows.push(_statusRow(roleText, connectivity.database?.ok ? `Conectada · ${connectivity.database.latencyMs} ms` : 'No responde', connectivity.database?.ok ? 'success' : 'danger'));
    rows.push(_statusRow('Internet', connectivity.internet?.online === false ? 'No disponible' : (connectivity.internet?.online ? 'Disponible' : 'Comprobando…'), connectivity.internet?.online === false ? 'warning' : (connectivity.internet?.online ? 'success' : '')));
    rows.push(_statusRow('Nube (Firebase)', connectivity.cloud?.ready ? 'Lista' : (connectivity.cloud?.ready === false ? 'No configurada' : '—')));
    rows.push(_statusRow('Cambios para la nube', connectivity.pending?.cloud ?? 0, connectivity.pending?.cloud ? 'warning' : ''));
    rows.push(_statusRow('e-CF por enviar a la DGII', connectivity.pending?.ecf ?? 0, connectivity.pending?.ecf ? 'warning' : ''));
    if (connectivity.role === 'terminal') {
      rows.push(_statusRow('Ventas de contingencia en esta caja', connectivity.pending?.contingencySales ?? 0, connectivity.pending?.contingencySales ? 'warning' : ''));
    }
  }
  if (sync) {
    rows.push(_statusRow('Cambios con error', sync.fallidos ?? sync.queue?.errors ?? 0, (sync.fallidos ?? sync.queue?.errors) ? 'danger' : ''));
    rows.push(_statusRow('Última sincronización', _formatDateTime(sync.ultimo_sync ?? sync.lastSyncAt)));
  }

  body.innerHTML = `
    <div class="tc-notice tc-conn-summary${tone ? ` tc-notice--${tone}` : ''}">
      <strong>${view.label}</strong>
      <span>${view.detail}</span>
    </div>
    <div class="tc-conn-rows">${rows.join('')}</div>
    <p class="tc-conn-help">La red local mantiene funcionando el negocio: ventas, caja, inventario, clientes e impresión no necesitan Internet. Internet solo sincroniza la nube, los respaldos en línea y la DGII; lo pendiente se envía solo al volver la conexión.</p>`;
}

async function retrySyncFailed() {
  try {
    const res = await fetch('/api/sync/retry-failed', { method: 'POST' });
    const d   = await res.json();
    if (d.ok) {
      if (typeof showToast === 'function') showToast('Reintentando los cambios con error…', 'info');
      setTimeout(refreshSyncMonitor, 2000);
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('Error: ' + e.message, 'error');
  }
}

// ── Inicialización ────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _startSyncPoller);
} else {
  setTimeout(_startSyncPoller, 2000);
}
