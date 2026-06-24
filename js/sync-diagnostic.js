'use strict';

/**
 * sync-diagnostic.js
 * Panel de diagnóstico de sincronización Firebase para el módulo de Configuración.
 * Muestra estado, cola pendiente, errores recientes y permite acciones manuales.
 */

let _syncDiagTimer = null;

async function syncDiagLoad() {
  try {
    const data = await api.request('/api/sync/diagnostic');
    _renderSyncDiag(data);
  } catch (e) {
    const label = document.getElementById('sync-diag-label');
    if (label) label.textContent = 'Error al obtener estado: ' + e.message;
  }
}

function _renderSyncDiag(d) {
  const dot    = document.getElementById('sync-diag-dot');
  const label  = document.getElementById('sync-diag-label');
  const grid   = document.getElementById('sync-diag-grid');
  const ptypes = document.getElementById('sync-diag-pending-types');
  const errWrap= document.getElementById('sync-diag-errors-wrap');
  const errBox = document.getElementById('sync-diag-errors');
  const retBtn = document.getElementById('sync-diag-retry-btn');
  const chkAt  = document.getElementById('sync-diag-checked-at');

  if (!dot || !label || !grid) return;

  const s = d.status || {};
  const q = d.queue  || {};

  // ── Indicador de estado ──────────────────────────────────────
  const isOk    = s.isOnline && s.firebaseReady && !q.pending && !q.errors;
  const hasWarn = (q.pending > 0 || q.errors > 0) && s.isOnline;
  const isErr   = !s.isOnline || !s.firebaseReady;

  dot.style.background = isOk ? '#10b981' : hasWarn ? '#f59e0b' : '#ef4444';

  let statusText = '';
  if (!s.hasInternet)      statusText = '🔴 Sin internet — cambios en cola local';
  else if (!s.firebaseReady) statusText = '🔴 Firebase no disponible — ' + (s.lastError || 'error desconocido');
  else if (q.errors > 0)    statusText = `⚠️ ${q.errors} item(s) con error — haz clic en "Reintentar"`;
  else if (q.pending > 0)   statusText = `🟡 ${q.pending} pendiente(s) de subir...`;
  else if (s.isSyncing)     statusText = '🔄 Sincronizando ahora...';
  else                       statusText = '✅ Todo sincronizado';

  label.textContent = statusText;

  // ── Grid de métricas ──────────────────────────────────────────
  const last = s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleTimeString('es-DO') : 'Nunca';
  grid.innerHTML = [
    { icon: '📡', label: 'Internet',  val: s.hasInternet   ? 'Conectado'   : 'Sin conexión', ok: s.hasInternet },
    { icon: '🔥', label: 'Firebase',  val: s.firebaseReady ? 'Listo'        : 'No disponible', ok: s.firebaseReady },
    { icon: '⏱',  label: 'Últ. sync', val: last },
    { icon: '⏳', label: 'Pendientes',val: q.pending || 0, warn: q.pending > 0 },
    { icon: '✅', label: 'Sincronizados', val: q.synced || 0 },
    { icon: '❌', label: 'Errores',   val: q.errors  || 0, warn: q.errors  > 0 },
  ].map(m => `
    <div style="background:var(--card-bg2,#151d2e);border-radius:8px;padding:10px 12px;border:1px solid var(--border,#2d3748)">
      <div style="font-size:1.1rem;margin-bottom:4px">${m.icon}</div>
      <div style="font-size:.72rem;color:var(--text3,#64748b);margin-bottom:2px">${m.label}</div>
      <div style="font-size:.92rem;font-weight:700;color:${m.ok === false ? '#ef4444' : m.warn ? '#f59e0b' : 'var(--text1,#f1f5f9)'}">${m.val}</div>
    </div>
  `).join('');

  // ── Pendientes por tipo ───────────────────────────────────────
  const byType = d.pendingByType || [];
  if (byType.length) {
    ptypes.innerHTML = '<div style="font-size:.78rem;color:var(--text2,#94a3b8);margin-bottom:6px">Pendientes por tipo:</div>' +
      byType.map(t => `
        <span style="display:inline-block;background:var(--card-bg2,#151d2e);border:1px solid var(--border);border-radius:20px;padding:2px 10px;font-size:.75rem;margin:2px;color:var(--text1)">
          ${_syncTypeLabel(t.entity_type)} <strong>${t.total}</strong>
        </span>
      `).join('');
  } else {
    ptypes.innerHTML = '';
  }

  // ── Errores recientes ─────────────────────────────────────────
  const errors = d.recentErrors || [];
  if (errors.length) {
    errWrap.style.display = '';
    retBtn.style.display  = '';
    errBox.innerHTML = errors.map(e =>
      `<div style="padding:3px 0;border-bottom:1px solid var(--border,#2d3748)">
        <span style="color:var(--text1,#f1f5f9)">${_syncTypeLabel(e.entity_type)}:${e.entity_id}</span>
        <span style="color:#ef4444;margin-left:6px">${_esc(e.error_message || '')}</span>
        <span style="color:var(--text3);margin-left:6px">${e.retry_count || 0} intentos</span>
      </div>`
    ).join('');
  } else {
    errWrap.style.display = 'none';
    retBtn.style.display  = 'none';
  }

  if (chkAt) {
    const t = d.checkedAt ? new Date(d.checkedAt).toLocaleTimeString('es-DO') : '';
    chkAt.textContent = t ? `Actualizado: ${t}` : '';
  }
}

async function syncDiagForce() {
  try {
    await api.request('/api/sync/now', { method: 'POST', body: '{}' });
    setTimeout(syncDiagLoad, 1500);
    if (typeof showToast === 'function') showToast('Sincronización iniciada', 'info');
  } catch (e) {
    if (typeof showToast === 'function') showToast('Error: ' + e.message, 'error');
  }
}

async function syncDiagRetryErrors() {
  try {
    const r = await api.request('/api/sync/retry-errors', { method: 'POST', body: '{}' });
    setTimeout(syncDiagLoad, 1500);
    if (typeof showToast === 'function') showToast(`Reintentando ${r.retried || 0} item(s)`, 'info');
  } catch (e) {
    if (typeof showToast === 'function') showToast('Error: ' + e.message, 'error');
  }
}

function _syncTypeLabel(t) {
  const map = {
    sale: 'Venta', cash_closing: 'Cierre caja', daily_report: 'Reporte diario',
    inventory: 'Inventario', product: 'Producto', product_delete: 'Baja producto',
    client: 'Cliente', client_delete: 'Baja cliente',
  };
  return map[t] || t || '—';
}

function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Auto-refresh cuando se abre el módulo de configuración
const _origShowModule = window.showModule;
if (typeof _origShowModule === 'function') {
  window.showModule = function(module, el) {
    _origShowModule.call(this, module, el);
    if (module === 'configuracion') {
      syncDiagLoad();
      clearInterval(_syncDiagTimer);
      _syncDiagTimer = setInterval(syncDiagLoad, 30000);
    } else {
      clearInterval(_syncDiagTimer);
    }
  };
}
