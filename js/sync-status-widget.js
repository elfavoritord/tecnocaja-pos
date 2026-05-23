/**
 * sync-status-widget.js
 *
 * Widget visual que muestra el estado de la sincronización con Firebase.
 * Se actualiza cada 5 segundos.
 */

class SyncStatusWidget {
  constructor(containerId = 'sync-status-widget') {
    this.containerId = containerId;
    this.container = document.getElementById(containerId);
    this.refreshInterval = null;
    this.isManualSyncing = false;
  }

  /**
   * Inicializa el widget y comienza a actualizar estado.
   */
  async init() {
    this.render();
    await this.updateStatus();
    this.refreshInterval = setInterval(() => this.updateStatus(), 30000);
  }

  /**
   * Obtiene estado actual de sincronización.
   */
  async getStatus() {
    try {
      const response = await fetch('/api/sync/status');
      return await response.json();
    } catch (err) {
      console.error('Error getting sync status:', err);
      return { isOnline: false, isSyncing: false, queue: { pending: 0, errors: 0 } };
    }
  }

  /**
   * Actualiza el widget con estado actual.
   */
  async updateStatus() {
    const status = await this.getStatus();
    this.render(status);
  }

  /**
   * Renderiza el HTML del widget.
   */
  render(status = null) {
    if (!this.container) {
      console.warn(`Container #${this.containerId} no encontrado`);
      return;
    }

    const isOnline = status?.isOnline ?? false;
    const hasInternet = status?.hasInternet ?? isOnline;
    const firebaseReady = status?.firebaseReady ?? isOnline;
    const isSyncing = status?.isSyncing ?? false;
    const pending = status?.queue?.pending ?? 0;
    const errors = status?.queue?.errors ?? 0;
    const synced = status?.queue?.synced ?? 0;
    const lastSyncAt = status?.lastSyncAt;
    const lastError = status?.lastError;

    let statusIcon = '📡';
    let statusText = 'Detectando...';
    let statusColor = '#666';
    let statusDetail = '';

    if (!hasInternet) {
      statusIcon = '⚠️';
      statusText = 'Sin internet';
      statusColor = '#ff6b6b';
    } else if (!firebaseReady) {
      // Hay internet pero la credencial Firebase no carga.
      statusIcon = '🔑';
      statusText = 'Firebase no configurado';
      statusColor = '#ff6b6b';
      statusDetail = lastError || 'Revisa FIREBASE_SERVICE_ACCOUNT_PATH';
    } else if (isSyncing) {
      statusIcon = '🔄';
      statusText = 'Sincronizando...';
      statusColor = '#ffa500';
    } else if (errors > 0) {
      statusIcon = '❌';
      statusText = `${errors} error${errors !== 1 ? 's' : ''}`;
      statusColor = '#ff6b6b';
    } else if (pending > 0) {
      statusIcon = '⏳';
      statusText = `${pending} pendiente${pending !== 1 ? 's' : ''}`;
      statusColor = '#ffa500';
    } else {
      statusIcon = '✅';
      statusText = 'Sincronizado';
      statusColor = '#51cf66';
    }

    const lastSyncText = lastSyncAt
      ? `Última sincronización: ${new Date(lastSyncAt).toLocaleTimeString()}`
      : 'Ninguna sincronización aún';

    this.container.innerHTML = `
      <div style="
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px;
        background: #f8f9fa;
        border-radius: 6px;
        border-left: 4px solid ${statusColor};
      ">
        <div style="font-size: 24px;">${statusIcon}</div>

        <div style="flex: 1;">
          <div style="
            font-weight: 600;
            color: ${statusColor};
            margin-bottom: 4px;
          ">
            ${statusText}
          </div>
          <div style="
            font-size: 12px;
            color: #666;
            margin-bottom: 4px;
          ">
            ${lastSyncText}
          </div>
          ${statusDetail ? `<div style="font-size: 11px; color: #c0392b; margin-bottom: 4px;">${statusDetail}</div>` : ''}
          <div style="
            font-size: 11px;
            color: #999;
          ">
            ✓ ${synced} | ⏳ ${pending} | ❌ ${errors}
          </div>
        </div>

        <button
          id="sync-now-btn"
          onclick="window.syncWidget?.syncNow()"
          style="
            padding: 8px 16px;
            background: ${statusColor};
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: 600;
            font-size: 12px;
            ${(isSyncing || this.isManualSyncing) ? 'opacity: 0.5; cursor: not-allowed;' : ''}
          "
          ${(isSyncing || this.isManualSyncing) ? 'disabled' : ''}
        >
          ${this.isManualSyncing ? 'Sincronizando...' : 'Sincronizar ahora'}
        </button>
      </div>
    `;
  }

  /**
   * Fuerza una sincronización manual.
   */
  async syncNow() {
    if (this.isManualSyncing) return;

    this.isManualSyncing = true;
    this.render({ isOnline: true, isSyncing: true, queue: {} });

    try {
      const response = await fetch('/api/sync/now', { method: 'POST' });
      const result = await response.json();
      console.log('Sincronización iniciada:', result);
    } catch (err) {
      console.error('Error iniciando sincronización:', err);
    }

    setTimeout(async () => {
      this.isManualSyncing = false;
      await this.updateStatus();
    }, 2000);
  }

  /**
   * Detiene el widget.
   */
  destroy() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }
}

// Global para acceso desde HTML
window.syncWidget = new SyncStatusWidget('sync-status-widget');

// Auto-inicializar cuando el DOM esté listo
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.syncWidget?.init());
} else {
  window.syncWidget?.init();
}
