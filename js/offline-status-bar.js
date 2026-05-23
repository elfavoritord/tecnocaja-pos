/**
 * offline-status-bar.js
 *
 * Barra de estado visual que muestra la conexión de la terminal.
 * Se inyecta automáticamente en el DOM al cargar y muestra 5 estados:
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

  const BAR_ID = 'nova-offline-status-bar';
  const HIDE_TIMEOUT_MS = 4000; // cuánto dura el estado "synced" visible

  const ESTADOS = {
    online: {
      label: 'En línea',
      bg: '#27ae60',
      icon: '●',
      desc: ''
    },
    offline: {
      label: 'Modo Offline',
      bg: '#e74c3c',
      icon: '◌',
      desc: 'Las ventas se guardan localmente y se sincronizarán cuando vuelva la conexión.'
    },
    syncing: {
      label: 'Sincronizando...',
      bg: '#e67e22',
      icon: '↻',
      desc: 'Subiendo ventas pendientes al servidor principal.'
    },
    synced: {
      label: 'Sincronización completada',
      bg: '#27ae60',
      icon: '✓',
      desc: ''
    },
    error: {
      label: 'Error de sincronización',
      bg: '#c0392b',
      icon: '⚠',
      desc: 'Hubo un problema al sincronizar. Se reintentará automáticamente.'
    }
  };

  // ─── Crear o actualizar el elemento en el DOM ────────────────────────────────

  function getBar() {
    let bar = document.getElementById(BAR_ID);
    if (!bar) {
      bar = document.createElement('div');
      bar.id = BAR_ID;
      bar.style.cssText = [
        'position: fixed',
        'top: 0',
        'left: 0',
        'right: 0',
        'z-index: 99999',
        'display: flex',
        'align-items: center',
        'justify-content: space-between',
        'padding: 6px 16px',
        'font-family: system-ui, sans-serif',
        'font-size: 13px',
        'font-weight: 600',
        'color: #fff',
        'transition: background 0.4s ease',
        'box-shadow: 0 2px 6px rgba(0,0,0,0.2)',
        'user-select: none'
      ].join('; ');
      document.body.prepend(bar);
    }
    return bar;
  }

  let _hideTimer = null;

  function render(estado, extraInfo) {
    const cfg = ESTADOS[estado] || ESTADOS.online;
    const bar = getBar();
    bar.style.background = cfg.bg;

    const pendingCount = extraInfo?.pendingCount || 0;
    const pendingText = pendingCount > 0
      ? ` · <span style="opacity:0.9">${pendingCount} venta${pendingCount !== 1 ? 's' : ''} pendiente${pendingCount !== 1 ? 's' : ''}</span>`
      : '';

    const errorMsg = extraInfo?.error
      ? ` · <span style="opacity:0.85">${String(extraInfo.error).slice(0, 60)}</span>`
      : '';

    const descHtml = cfg.desc
      ? `<span style="font-weight:400;opacity:0.9;margin-left:8px">${cfg.desc}</span>`
      : '';

    bar.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:16px;animation:${estado === 'syncing' ? 'nova-spin 1s linear infinite' : 'none'}">${cfg.icon}</span>
        <span>${cfg.label}${pendingText}${errorMsg}</span>
        ${descHtml}
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        ${pendingCount > 0 && estado !== 'syncing' ? `
          <button id="nova-sync-now-btn" style="
            background:rgba(255,255,255,0.25);border:1px solid rgba(255,255,255,0.5);
            color:#fff;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600
          ">Sincronizar ahora</button>
        ` : ''}
        ${estado !== 'online' || pendingCount > 0 ? `
          <button id="nova-offline-panel-btn" style="
            background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.4);
            color:#fff;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:12px
          ">Ver pendientes</button>
        ` : ''}
        <button id="nova-status-close-btn" style="
          background:none;border:none;color:#fff;cursor:pointer;font-size:18px;
          opacity:0.7;padding:0 4px;line-height:1
        " title="Cerrar">×</button>
      </div>
    `;

    // Eventos
    const syncBtn = document.getElementById('nova-sync-now-btn');
    if (syncBtn) {
      syncBtn.addEventListener('click', () => {
        if (window.offlineManager) window.offlineManager.forceSync();
      });
    }

    const panelBtn = document.getElementById('nova-offline-panel-btn');
    if (panelBtn) {
      panelBtn.addEventListener('click', () => {
        if (window.offlinePendingPanel) window.offlinePendingPanel.open();
      });
    }

    const closeBtn = document.getElementById('nova-status-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => hide());
    }

    // Aplicar padding-top al body para que la barra no tape contenido
    document.body.style.paddingTop = (bar.offsetHeight + 2) + 'px';
  }

  function hide() {
    const bar = document.getElementById(BAR_ID);
    if (bar) {
      document.body.style.paddingTop = '';
      bar.remove();
    }
  }

  function show(estado, extraInfo) {
    clearTimeout(_hideTimer);
    render(estado, extraInfo);
    // Solo ocultar automáticamente cuando está "online" sin pendientes o "synced"
    if (estado === 'online' && !(extraInfo?.pendingCount > 0)) {
      _hideTimer = setTimeout(hide, HIDE_TIMEOUT_MS);
    } else if (estado === 'synced') {
      _hideTimer = setTimeout(() => show('online', {}), HIDE_TIMEOUT_MS);
    }
  }

  // Agregar animación CSS para el spinner
  if (!document.getElementById('nova-offline-styles')) {
    const style = document.createElement('style');
    style.id = 'nova-offline-styles';
    style.textContent = `
      @keyframes nova-spin {
        from { display: inline-block; transform: rotate(0deg); }
        to   { display: inline-block; transform: rotate(360deg); }
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
      show('offline', {
        pendingCount: state.pendingSalesCount || 0
      });
    });

    manager.on('online', () => {
      // No mostrar "en línea" inmediatamente — esperar resultado del sync
    });

    manager.on('syncStart', () => {
      show('syncing');
    });

    manager.on('syncComplete', (data) => {
      const synced = data?.result?.synced || 0;
      if (synced > 0) {
        show('synced');
      } else {
        // Sin pendientes, online limpio
        show('online', { pendingCount: data.pendingSalesCount || 0 });
      }
    });

    manager.on('syncError', (state) => {
      show('error', { error: state.syncError, pendingCount: state.pendingSalesCount || 0 });
    });

    manager.on('statusUpdate', (state) => {
      if (!state.isOnline) {
        show('offline', { pendingCount: state.pendingSalesCount || 0 });
      } else if (state.pendingSalesCount > 0 && !state.isSyncing) {
        show('online', { pendingCount: state.pendingSalesCount });
      }
    });

    // Estado inicial
    const initialState = manager.getState();
    if (!initialState.isOnline) {
      show('offline', { pendingCount: initialState.pendingSalesCount || 0 });
    } else if (initialState.pendingSalesCount > 0) {
      show('online', { pendingCount: initialState.pendingSalesCount });
    }
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
