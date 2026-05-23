/**
 * OfflineManager - Gestión de conexión y sincronización offline
 * 
 * Responsabilidades:
 * - Monitorear estado de conexión (online/offline)
 * - Health check periódico al servidor principal
 * - Detectar transiciones de conexión
 * - Disparar sincronización automática cuando se restaura conexión
 * - Mantener UI sincronizada con estado de conexión
 */

class OfflineManager {
  constructor(config = {}) {
    this.config = {
      healthCheckInterval: 2000, // ms entre health checks
      healthCheckTimeout: 3000, // timeout para cada health check
      syncDebounceDelay: 1000, // esperar antes de disparar sync después de reconexión
      statusUpdateInterval: 1000, // actualizar UI cada 1s
      ...config
    };

    this.state = {
      isOnline: true, // el primer health check a /api/health corrige esto; no depender de navigator.onLine porque la BD es local
      isSyncing: false,
      lastHealthCheckAt: null,
      lastSyncAt: null,
      pendingSalesCount: 0,
      pendingSalesTotal: 0,
      syncError: null
    };

    // Contador de fallos consecutivos — requiere 2 seguidos antes de declarar offline
    // para evitar falsos positivos por pings lentos momentáneos
    this._consecutiveFailures = 0;
    this._requiredFailures = 2;

    this.listeners = {
      online: [],
      offline: [],
      syncStart: [],
      syncComplete: [],
      syncError: [],
      statusUpdate: []
    };

    this.timers = {
      healthCheck: null,
      syncDebounce: null,
      statusUpdate: null
    };

    this.isInitialized = false;
  }

  /**
   * Inicializa el gestor de conexión.
   * Debe llamarse una sola vez después de que se cargue la página.
   */
  async initialize() {
    if (this.isInitialized) return;

    console.log('[OfflineManager] Inicializando...');

    // No usar window online/offline — solo el health check a /api/health decide el estado
    // ya que la BD es local (embedded MariaDB) y no requiere internet

    // Iniciar monitoreo de health check
    await this._startHealthCheck();

    // Actualizar UI periódicamente
    this._startStatusUpdate();

    // Cargar estado inicial
    await this._updateCacheStatus();

    this.isInitialized = true;
    console.log('[OfflineManager] Inicializado. Estado:', this.state);
  }

  /**
   * Detiene todos los timers y listeners.
   */
  destroy() {
    clearInterval(this.timers.healthCheck);
    clearTimeout(this.timers.syncDebounce);
    clearInterval(this.timers.statusUpdate);

    this.listeners = {
      online: [],
      offline: [],
      syncStart: [],
      syncComplete: [],
      syncError: [],
      statusUpdate: []
    };

    this.isInitialized = false;
  }

  /**
   * Registra un listener para un evento.
   * 
   * @param {string} event - 'online', 'offline', 'syncStart', 'syncComplete', 'syncError', 'statusUpdate'
   * @param {Function} callback - Función a ejecutar
   */
  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback);
    }
  }

  /**
   * Desregistra un listener.
   */
  off(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    }
  }

  /**
   * Dispara un evento para todos los listeners registrados.
   */
  _emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(callback => {
        try {
          callback(data);
        } catch (err) {
          console.error(`[OfflineManager] Error en listener ${event}:`, err);
        }
      });
    }
  }

  /**
   * Inicia el monitoreo de health check periódico.
   */
  async _startHealthCheck() {
    // Hacer health check inmediato
    await this._performHealthCheck();

    // Repetir cada N ms
    this.timers.healthCheck = setInterval(
      () => this._performHealthCheck(),
      this.config.healthCheckInterval
    );
  }

  /**
   * Realiza un health check contra el servidor.
   * Requiere _requiredFailures consecutivos antes de declarar offline,
   * y un solo éxito para volver a online — evita falsos positivos por pings lentos.
   */
  async _performHealthCheck() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.healthCheckTimeout);

      const response = await fetch('/api/health', {
        method: 'GET',
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      this.state.lastHealthCheckAt = new Date();

      if (response.ok) {
        // Éxito → resetear contador de fallos
        this._consecutiveFailures = 0;
        const wasOnline = this.state.isOnline;
        this.state.isOnline = true;
        if (!wasOnline) {
          this._handleOnline();
        }
      } else {
        // Respuesta no-ok (503 etc.)
        this._consecutiveFailures++;
        if (this._consecutiveFailures >= this._requiredFailures && this.state.isOnline) {
          this.state.isOnline = false;
          this._handleOffline();
        }
      }
    } catch (err) {
      // Fetch lanzó (timeout AbortError, red caída, etc.)
      this._consecutiveFailures++;
      this.state.lastHealthCheckAt = new Date();
      if (this._consecutiveFailures >= this._requiredFailures && this.state.isOnline) {
        this.state.isOnline = false;
        this._handleOffline();
      }
    }
  }

  /**
   * Manejador para transición a online.
   * Se llama cuando wasOnline era false y ahora es true.
   */
  _handleOnline() {
    console.log('[OfflineManager] Transición a ONLINE');
    this._emit('online', this.state);

    // Debounce para evitar múltiples syncs
    clearTimeout(this.timers.syncDebounce);
    this.timers.syncDebounce = setTimeout(
      () => this._triggerSync(),
      this.config.syncDebounceDelay
    );
  }

  /**
   * Manejador para transición a offline.
   * Se llama cuando wasOnline era true y ahora es false.
   */
  _handleOffline() {
    console.log('[OfflineManager] Transición a OFFLINE');
    this._emit('offline', this.state);
  }

  /**
   * Dispara la sincronización de ventas pendientes.
   */
  async _triggerSync() {
    if (!this.state.isOnline || this.state.isSyncing) return;

    console.log('[OfflineManager] Iniciando sincronización...');
    this.state.isSyncing = true;
    this._emit('syncStart', this.state);

    try {
      // Enviar ventas pendientes
      const response = await fetch('/api/offline/sync-pending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      if (!response.ok) {
        throw new Error(`Sync failed: ${response.status}`);
      }

      const result = await response.json();
      this.state.lastSyncAt = new Date();
      this.state.syncError = null;
      this.state.isSyncing = false;

      console.log('[OfflineManager] Sincronización completada:', result);
      this._emit('syncComplete', { ...this.state, result });

      // Actualizar estado de caché
      await this._updateCacheStatus();
    } catch (err) {
      console.error('[OfflineManager] Error durante sync:', err);
      this.state.syncError = err.message;
      this.state.isSyncing = false;
      this._emit('syncError', this.state);
    }
  }

  /**
   * Obtiene el estado actual del caché offline desde el servidor.
   */
  async _updateCacheStatus() {
    try {
      const response = await fetch('/api/offline/status');
      if (response.ok) {
        const status = await response.json();
        this.state.pendingSalesCount = status.pendingSalesCount || 0;
        this.state.pendingSalesTotal = status.pendingSalesTotalAmount || 0;
      }
    } catch (err) {
      console.warn('[OfflineManager] Error obteniendo status:', err);
    }
  }

  /**
   * Inicia actualizaciones periódicas de UI.
   */
  _startStatusUpdate() {
    this.timers.statusUpdate = setInterval(
      () => {
        this._updateCacheStatus();
        this._emit('statusUpdate', this.state);
      },
      this.config.statusUpdateInterval
    );
  }

  /**
   * Obtiene el estado actual.
   */
  getState() {
    return { ...this.state };
  }

  /**
   * Obtiene la información de conexión para mostrar en UI.
   */
  getStatusInfo() {
    if (this.state.isSyncing) {
      return {
        status: 'syncing',
        label: 'Sincronizando...',
        icon: '↻',
        color: 'yellow'
      };
    }

    if (!this.state.isOnline) {
      return {
        status: 'offline',
        label: 'Modo Offline',
        icon: '✕',
        color: 'red',
        pendingCount: this.state.pendingSalesCount,
        pendingTotal: this.state.pendingSalesTotal
      };
    }

    if (this.state.syncError) {
      return {
        status: 'error',
        label: 'Error de Sync',
        icon: '⚠',
        color: 'orange',
        error: this.state.syncError
      };
    }

    return {
      status: 'online',
      label: 'En Línea',
      icon: '✓',
      color: 'green'
    };
  }

  /**
   * Cancela una venta offline específica (antes de sync).
   */
  async cancelPendingSale(offlineInvoiceId) {
    try {
      const response = await fetch('/api/offline/cancel-pending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offlineInvoiceId })
      });

      if (!response.ok) {
        throw new Error(`Cancel failed: ${response.status}`);
      }

      await this._updateCacheStatus();
      return await response.json();
    } catch (err) {
      console.error('[OfflineManager] Error cancelando venta:', err);
      throw err;
    }
  }

  /**
   * Fuerza una sincronización manual (incluso si está online).
   */
  async forceSync() {
    if (this.state.isSyncing) {
      console.warn('[OfflineManager] Sync ya en progreso');
      return;
    }

    await this._triggerSync();
  }
}

// Exportar como singleton si está en módulo, o global si es script
if (typeof module !== 'undefined' && module.exports) {
  module.exports = OfflineManager;
} else {
  window.OfflineManager = OfflineManager;
}
