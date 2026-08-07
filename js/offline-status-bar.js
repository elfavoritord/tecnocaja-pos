/**
 * offline-status-bar.js
 *
 * Indicador visual (punto de color, fijo en pantalla) del estado de conexión
 * de la terminal:
 *   - online:    Conectado al servidor principal
 *   - offline:   Sin conexión, trabajando localmente
 *   - syncing:   Sincronizando datos pendientes
 *   - synced:    Sincronización completada
 *   - error:     Error en sincronización
 *
 * Uso: incluir este script en index.html después de offline-manager.js
 */

(function () {
  'use strict';

  const DOT_ID = 'nova-offline-status-dot';

  const ESTADOS = {
    online:  { label: 'En línea',                  color: '#27ae60', pulse: false },
    offline: { label: 'Modo Offline',               color: '#e74c3c', pulse: false },
    syncing: { label: 'Sincronizando...',           color: '#e67e22', pulse: true },
    synced:  { label: 'Sincronización completada',  color: '#27ae60', pulse: false },
    error:   { label: 'Error de sincronización',     color: '#c0392b', pulse: false }
  };

  function getDot() {
    let dot = document.getElementById(DOT_ID);
    if (!dot) {
      dot = document.createElement('div');
      dot.id = DOT_ID;
      dot.style.cssText = [
        'position: fixed',
        'left: 12px',
        'bottom: 12px',
        'width: 12px',
        'height: 12px',
        'border-radius: 50%',
        'border: 2px solid rgba(255,255,255,0.85)',
        'box-shadow: 0 1px 4px rgba(0,0,0,0.35)',
        'z-index: 99999',
        'cursor: pointer',
        'transition: background 0.3s ease'
      ].join('; ');
      dot.addEventListener('click', () => {
        if (window.offlinePendingPanel) window.offlinePendingPanel.open();
      });
      document.body.appendChild(dot);
    }
    return dot;
  }

  function render(estado, extraInfo) {
    const cfg = ESTADOS[estado] || ESTADOS.online;
    const dot = getDot();
    dot.style.background = cfg.color;
    dot.style.animation = cfg.pulse ? 'nova-dot-pulse 1.2s ease-in-out infinite' : 'none';

    const pendingCount = extraInfo?.pendingCount || 0;
    const pendingText = pendingCount > 0
      ? ` · ${pendingCount} venta${pendingCount !== 1 ? 's' : ''} pendiente${pendingCount !== 1 ? 's' : ''}`
      : '';
    const errorText = extraInfo?.error ? ` · ${String(extraInfo.error).slice(0, 60)}` : '';
    dot.title = `${cfg.label}${pendingText}${errorText}`;
  }

  function hide() {
    const dot = document.getElementById(DOT_ID);
    if (dot) dot.remove();
  }

  function show(estado, extraInfo) {
    render(estado, extraInfo);
  }

  if (!document.getElementById('nova-offline-styles')) {
    const style = document.createElement('style');
    style.id = 'nova-offline-styles';
    style.textContent = `
      @keyframes nova-dot-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }
    `;
    document.head.appendChild(style);
  }

  // ─── Inicialización — escuchar eventos del OfflineManager ───────────────────

  function initStatusBar() {
    if (!window.offlineManager) {
      // Reintentar en 500ms si el manager aún no está listo
      setTimeout(initStatusBar, 500);
      return;
    }

    const manager = window.offlineManager;

    manager.on('offline', (state) => {
      show('offline', { pendingCount: state.pendingSalesCount || 0 });
    });

    manager.on('online', () => {
      show('online');
    });

    manager.on('syncStart', () => {
      show('syncing');
    });

    manager.on('syncComplete', (data) => {
      const synced = data?.result?.synced || 0;
      show(synced > 0 ? 'synced' : 'online', { pendingCount: data.pendingSalesCount || 0 });
    });

    manager.on('syncError', (state) => {
      show('error', { error: state.syncError, pendingCount: state.pendingSalesCount || 0 });
    });

    manager.on('statusUpdate', (state) => {
      if (!state.isOnline) {
        show('offline', { pendingCount: state.pendingSalesCount || 0 });
      } else {
        show('online', { pendingCount: state.pendingSalesCount || 0 });
      }
    });

    // Estado inicial
    const initialState = manager.getState();
    show(initialState.isOnline ? 'online' : 'offline', { pendingCount: initialState.pendingSalesCount || 0 });
  }

  // Esperar a que el DOM esté listo
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initStatusBar);
  } else {
    initStatusBar();
  }

  // Exponer API pública
  window.offlineStatusBar = { show, hide, render };
})();
