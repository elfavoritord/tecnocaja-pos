// ===== TECNO_CAJA - SYNC MONITOR =====
// Controla el badge del topbar y el modal de estado de sincronización.

let _syncPollTimer = null;
let _lastSyncStatus = null;

// ── Actualizar badge del topbar ───────────────────────────────────────────────
async function _updateSyncBadge() {
  try {
    const res = await fetch('/api/sync/status');
    if (!res.ok) return;
    const s = await res.json();
    _lastSyncStatus = s;

    const dot   = document.getElementById('sync-dot');
    const label = document.getElementById('sync-label');
    if (!dot || !label) return;

    const pending = s.pendientes ?? s.queue?.pending ?? 0;
    const failed  = s.fallidos   ?? s.queue?.errors  ?? 0;
    const fbOk    = s.firebase_disponible ?? s.isOnline ?? false;

    if (!fbOk) {
      dot.style.background = '#6b7280';
      label.textContent    = 'Firebase';
    } else if (failed > 0) {
      dot.style.background = '#f87171';
      label.textContent    = `${failed} error${failed!==1?'s':''}`;
    } else if (pending > 0) {
      dot.style.background = '#fbbf24';
      label.textContent    = `${pending} pend.`;
    } else {
      dot.style.background = '#22c55e';
      label.textContent    = 'Sync ✓';
    }
  } catch (_) {
    const dot = document.getElementById('sync-dot');
    if (dot) dot.style.background = '#6b7280';
  }
}

function _startSyncPoller() {
  if (_syncPollTimer) return;
  _updateSyncBadge();
  _syncPollTimer = setInterval(_updateSyncBadge, 30000);
}

// ── Modal monitor ─────────────────────────────────────────────────────────────
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

async function refreshSyncMonitor() {
  const body = document.getElementById('sync-monitor-body');
  if (!body) return;
  body.innerHTML = `<div style="text-align:center;padding:1.5rem;color:var(--text3)">Actualizando…</div>`;

  try {
    const res = await fetch('/api/sync/status');
    const s   = await res.json();
    _lastSyncStatus = s;

    const fbOk    = s.firebase_disponible ?? s.isOnline ?? false;
    const pending = s.pendientes ?? s.queue?.pending ?? 0;
    const failed  = s.fallidos   ?? s.queue?.errors  ?? 0;
    const done    = s.completados ?? s.queue?.synced  ?? 0;
    const lastAt  = s.ultimo_sync ?? s.lastSyncAt ?? null;

    const rows = [
      { label: 'Firebase',             val: fbOk ? '✅ Conectado' : '🔴 No disponible',        color: fbOk ? '#6ee7b7' : '#f87171' },
      { label: 'Eventos pendientes',   val: pending,   color: pending > 0 ? '#fbbf24' : '#6ee7b7' },
      { label: 'Eventos fallidos',     val: failed,    color: failed  > 0 ? '#f87171' : '#6ee7b7' },
      { label: 'Completados (7 días)', val: done,      color: '#6ee7b7' },
      { label: 'Último sync',          val: lastAt ? new Date(lastAt).toLocaleString('es-DO') : 'Nunca', color: '#e5e7eb' },
    ];

    body.innerHTML = `
      <div style="display:grid;gap:8px;margin-bottom:16px">
        ${rows.map(r=>`
          <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 12px;background:var(--bg,#111827);border:1px solid var(--border);border-radius:7px">
            <span style="font-size:.83rem;color:var(--text3)">${r.label}</span>
            <span style="font-size:.85rem;font-weight:700;color:${r.color}">${r.val}</span>
          </div>`).join('')}
      </div>

      <div style="background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.2);border-radius:8px;padding:12px;font-size:.79rem;color:var(--text3);line-height:1.6">
        <strong style="color:var(--text2)">Arquitectura de datos Tecno Caja:</strong><br>
        • <strong>MariaDB local</strong> — fuente principal de verdad (funciona sin internet)<br>
        • <strong>Cola de sync</strong> — cada operación crítica se encola automáticamente<br>
        • <strong>Firebase</strong> — recibe resúmenes diarios y eventos de negocio<br>
        • <strong>Reintentos</strong> — los fallos se reintenta automáticamente con back-off exponencial<br>
        • <strong>Sin pérdida de datos</strong> — si Firebase falla, los datos permanecen en MariaDB
      </div>`;
  } catch (e) {
    body.innerHTML = `<div style="color:#f87171;padding:1rem">Error al obtener estado: ${e.message}</div>`;
  }
}

async function retrySyncFailed() {
  try {
    const res = await fetch('/api/sync/retry-failed', { method: 'POST' });
    const d   = await res.json();
    if (d.ok) {
      if (typeof showToast === 'function') showToast('Reiniciando sincronización de eventos fallidos…', 'info');
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
