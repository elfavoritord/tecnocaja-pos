/**
 * offline-pending-panel.js
 *
 * Panel lateral que muestra:
 *   - Ventas pendientes de sincronizar
 *   - Última sincronización exitosa
 *   - Errores de sincronización
 *   - Botón para forzar sincronización
 *   - Botón para cancelar ventas pendientes individuales
 *
 * Uso: window.offlinePendingPanel.open() / .close()
 */

(function () {
  'use strict';

  const PANEL_ID = 'nova-offline-pending-panel';
  const OVERLAY_ID = 'nova-offline-pending-overlay';

  // ─── Crear estructura del panel ──────────────────────────────────────────────

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = [
      'position: fixed', 'inset: 0', 'background: rgba(0,0,0,0.45)',
      'z-index: 99990', 'display: none'
    ].join('; ');
    overlay.addEventListener('click', close);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = [
      'position: fixed', 'top: 0', 'right: 0', 'bottom: 0',
      'width: min(480px, 100vw)',
      'background: #fff', 'z-index: 99995',
      'display: none', 'flex-direction: column',
      'box-shadow: -4px 0 20px rgba(0,0,0,0.18)',
      'font-family: system-ui, sans-serif',
      'overflow: hidden'
    ].join('; ');

    panel.innerHTML = `
      <div style="
        display:flex;align-items:center;justify-content:space-between;
        padding:16px 20px;background:#2c3e50;color:#fff;flex-shrink:0
      ">
        <div>
          <div style="font-size:16px;font-weight:700">Sincronización Offline</div>
          <div id="nova-panel-subtitle" style="font-size:12px;opacity:0.8;margin-top:2px">Cargando...</div>
        </div>
        <button id="nova-panel-close" style="
          background:none;border:none;color:#fff;font-size:22px;
          cursor:pointer;opacity:0.8;padding:4px
        ">×</button>
      </div>

      <div style="padding:12px 20px;background:#ecf0f1;flex-shrink:0;border-bottom:1px solid #ddd">
        <div style="display:flex;gap:8px">
          <button id="nova-panel-sync-btn" style="
            flex:1;padding:10px;background:#27ae60;color:#fff;border:none;
            border-radius:6px;cursor:pointer;font-weight:700;font-size:14px
          ">↑ Sincronizar ahora</button>
          <button id="nova-panel-refresh-btn" style="
            padding:10px 14px;background:#95a5a6;color:#fff;border:none;
            border-radius:6px;cursor:pointer;font-size:14px
          " title="Actualizar">⟳</button>
        </div>
      </div>

      <div id="nova-panel-body" style="flex:1;overflow-y:auto;padding:16px 20px">
        <div style="text-align:center;color:#7f8c8d;padding:40px 0">
          Cargando pendientes...
        </div>
      </div>

      <div id="nova-panel-footer" style="
        padding:10px 20px;background:#ecf0f1;border-top:1px solid #ddd;
        font-size:12px;color:#7f8c8d;flex-shrink:0
      ">
        Última sync: —
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(panel);

    document.getElementById('nova-panel-close').addEventListener('click', close);
    document.getElementById('nova-panel-sync-btn').addEventListener('click', doSync);
    document.getElementById('nova-panel-refresh-btn').addEventListener('click', loadData);
  }

  // ─── Abrir / cerrar ──────────────────────────────────────────────────────────

  function open() {
    createPanel();
    document.getElementById(OVERLAY_ID).style.display = 'block';
    document.getElementById(PANEL_ID).style.display = 'flex';
    loadData();
  }

  function close() {
    const overlay = document.getElementById(OVERLAY_ID);
    const panel = document.getElementById(PANEL_ID);
    if (overlay) overlay.style.display = 'none';
    if (panel) panel.style.display = 'none';
  }

  // ─── Cargar datos del backend ─────────────────────────────────────────────────

  async function loadData() {
    createPanel();
    const body = document.getElementById('nova-panel-body');
    const subtitle = document.getElementById('nova-panel-subtitle');
    if (body) body.innerHTML = `<div style="text-align:center;color:#7f8c8d;padding:40px 0">Cargando...</div>`;

    try {
      // Obtener status
      const statusResp = await fetch('/api/offline/status').catch(() => null);
      const status = statusResp?.ok ? await statusResp.json() : {};

      // Obtener lista de pendientes
      const listResp = await fetch('/api/offline/pending-list?limit=50').catch(() => null);
      const listData = listResp?.ok ? await listResp.json() : { pending: [], errors: [], lastSync: null };

      const pending = listData.pending || [];
      const errors = listData.errors || [];
      const lastSync = listData.lastSync || null;

      if (subtitle) {
        const cnt = status.pendingSalesCount || pending.length;
        subtitle.textContent = cnt > 0
          ? `${cnt} venta${cnt !== 1 ? 's' : ''} pendiente${cnt !== 1 ? 's' : ''} de sincronizar`
          : 'Sin ventas pendientes';
      }

      renderBody(body, pending, errors, status);
      renderFooter(lastSync, status);
    } catch (err) {
      if (body) body.innerHTML = `
        <div style="color:#e74c3c;padding:20px;text-align:center">
          Error al cargar datos: ${err.message}
        </div>`;
    }
  }

  function renderBody(container, pending, errors, status) {
    if (!container) return;

    let html = '';

    // Estado de conexión
    const isOnline = window.offlineManager?.getState?.()?.isOnline !== false;
    const connectionColor = isOnline ? '#27ae60' : '#e74c3c';
    const connectionLabel = isOnline ? 'En línea' : 'Sin conexión';

    html += `
      <div style="
        display:flex;align-items:center;gap:8px;margin-bottom:16px;
        padding:10px 14px;border-radius:8px;background:${isOnline ? '#eafaf1' : '#fdedec'};
        border:1px solid ${connectionColor}22
      ">
        <span style="width:10px;height:10px;border-radius:50%;background:${connectionColor};display:inline-block"></span>
        <span style="font-weight:600;color:${connectionColor}">${connectionLabel}</span>
        ${status.productsCached > 0 ? `<span style="color:#7f8c8d;font-size:12px;margin-left:auto">${status.productsCached} productos en caché</span>` : ''}
      </div>
    `;

    // Ventas pendientes
    if (pending.length === 0 && errors.length === 0) {
      html += `
        <div style="text-align:center;padding:40px 0;color:#27ae60">
          <div style="font-size:36px">✓</div>
          <div style="font-weight:600;margin-top:8px">Todo sincronizado</div>
          <div style="color:#7f8c8d;font-size:13px;margin-top:4px">No hay ventas pendientes</div>
        </div>
      `;
    } else {
      if (pending.length > 0) {
        html += `<div style="font-weight:700;margin-bottom:10px;color:#2c3e50">
          Pendientes (${pending.length})
        </div>`;

        for (const sale of pending) {
          const fecha = new Date(sale.created_at).toLocaleString('es-DO', {
            day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
          });
          const total = Number(sale.total || 0).toLocaleString('es-DO', { minimumFractionDigits: 2 });

          html += `
            <div style="
              border:1px solid #ddd;border-radius:8px;padding:12px;
              margin-bottom:8px;background:#fff;position:relative
            ">
              <div style="display:flex;justify-content:space-between;align-items:flex-start">
                <div>
                  <div style="font-weight:600;font-size:14px;color:#2c3e50">
                    ${sale.offline_invoice_id}
                  </div>
                  <div style="font-size:12px;color:#7f8c8d;margin-top:2px">${fecha}</div>
                </div>
                <div style="text-align:right">
                  <div style="font-weight:700;color:#27ae60">RD$ ${total}</div>
                  <div style="font-size:11px;color:#7f8c8d;margin-top:2px">${sale.payment_method || 'efectivo'}</div>
                </div>
              </div>
              <div style="margin-top:8px;display:flex;justify-content:flex-end">
                <button
                  data-cancel-id="${sale.offline_invoice_id}"
                  style="
                    background:none;border:1px solid #e74c3c;color:#e74c3c;
                    padding:3px 10px;border-radius:4px;font-size:12px;cursor:pointer
                  "
                >Cancelar venta</button>
              </div>
            </div>
          `;
        }
      }

      // Errores
      if (errors.length > 0) {
        html += `<div style="font-weight:700;margin:16px 0 10px;color:#e74c3c">
          Errores (${errors.length})
        </div>`;
        for (const err of errors) {
          html += `
            <div style="
              border:1px solid #e74c3c44;border-radius:8px;padding:10px;
              margin-bottom:6px;background:#fdedec
            ">
              <div style="font-size:12px;font-weight:600;color:#c0392b">${err.offline_invoice_id}</div>
              <div style="font-size:12px;color:#7f8c8d;margin-top:2px">${err.error_message || 'Error desconocido'}</div>
            </div>
          `;
        }
      }
    }

    container.innerHTML = html;

    // Agregar listeners para cancelar ventas
    container.querySelectorAll('[data-cancel-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-cancel-id');
        if (!confirm(`¿Cancelar la venta ${id}? Esta acción no se puede deshacer.`)) return;
        btn.disabled = true;
        btn.textContent = 'Cancelando...';
        try {
          const resp = await fetch('/api/offline/cancel-pending', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ offlineInvoiceId: id })
          });
          const result = await resp.json();
          if (result.ok) {
            loadData();
            if (window.offlineManager) window.offlineManager._updateCacheStatus?.();
          } else {
            alert('Error al cancelar: ' + (result.error || 'Error desconocido'));
            btn.disabled = false;
            btn.textContent = 'Cancelar venta';
          }
        } catch (e) {
          alert('Error de conexión: ' + e.message);
          btn.disabled = false;
          btn.textContent = 'Cancelar venta';
        }
      });
    });
  }

  function renderFooter(lastSync, status) {
    const footer = document.getElementById('nova-panel-footer');
    if (!footer) return;

    const syncTs = lastSync?.completed_at
      ? new Date(lastSync.completed_at).toLocaleString('es-DO')
      : 'Nunca';

    footer.innerHTML = `
      Última sync: <strong>${syncTs}</strong>
      ${status.usersCached > 0 ? ` · ${status.usersCached} usuarios en caché` : ''}
      ${status.clientsCached > 0 ? ` · ${status.clientsCached} clientes` : ''}
    `;
  }

  // ─── Sincronización desde el panel ───────────────────────────────────────────

  async function doSync() {
    const btn = document.getElementById('nova-panel-sync-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '↑ Sincronizando...';
      btn.style.background = '#95a5a6';
    }

    try {
      if (window.offlineManager) {
        await window.offlineManager.forceSync();
      } else {
        const resp = await fetch('/api/offline/sync-pending', { method: 'POST' });
        if (!resp.ok) throw new Error('Error en sync');
      }
      await loadData();
    } catch (err) {
      alert('Error al sincronizar: ' + err.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '↑ Sincronizar ahora';
        btn.style.background = '#27ae60';
      }
    }
  }

  // ─── Inicializar cuando el OfflineManager inicie sync ────────────────────────

  function initPanelListeners() {
    if (!window.offlineManager) {
      setTimeout(initPanelListeners, 500);
      return;
    }
    // Refrescar el panel cuando se completa un sync si está abierto
    window.offlineManager.on('syncComplete', () => {
      const panel = document.getElementById(PANEL_ID);
      if (panel && panel.style.display !== 'none') {
        loadData();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPanelListeners);
  } else {
    initPanelListeners();
  }

  // Exponer API pública
  window.offlinePendingPanel = { open, close, refresh: loadData };
})();
