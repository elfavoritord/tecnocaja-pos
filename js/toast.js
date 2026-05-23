'use strict';

/**
 * Tecno Caja Toast — sistema de notificaciones no bloqueantes
 * Reemplaza alert(), confirm() molestos por toasts elegantes y profesionales.
 * Uso: Toast.ok('Venta guardada'); Toast.error('Error al conectar');
 */

const Toast = (() => {
  const CONTAINER_ID = 'tecnocaja-toast-container';
  const DURATION_DEFAULT = 3500;
  const DURATION_ERROR = 6000;
  const DURATION_CONFIRM = 0; // no se auto-cierra

  const TIPOS = {
    success: { bg: '#00b894', icon: '✓', titulo: 'Listo' },
    error:   { bg: '#d63031', icon: '✕', titulo: 'Error' },
    warning: { bg: '#f39c12', icon: '⚠', titulo: 'Atención' },
    info:    { bg: '#0984e3', icon: 'ℹ', titulo: 'Información' },
    confirm: { bg: '#6c5ce7', icon: '?', titulo: 'Confirmar' }
  };

  function getContainer() {
    let container = document.getElementById(CONTAINER_ID);
    if (!container) {
      container = document.createElement('div');
      container.id = CONTAINER_ID;
      container.style.cssText = [
        'position:fixed',
        'bottom:24px',
        'right:24px',
        'z-index:999999',
        'display:flex',
        'flex-direction:column',
        'align-items:flex-end',
        'gap:10px',
        'pointer-events:none'
      ].join(';');
      document.body.appendChild(container);
    }
    return container;
  }

  function injectStyles() {
    if (document.getElementById('tecnocaja-toast-styles')) return;
    const style = document.createElement('style');
    style.id = 'tecnocaja-toast-styles';
    style.textContent = `
      @keyframes novaToastIn  { from { opacity:0; transform:translateX(40px); } to { opacity:1; transform:translateX(0); } }
      @keyframes novaToastOut { from { opacity:1; transform:translateX(0); }   to { opacity:0; transform:translateX(40px); } }
      .tecnocaja-toast {
        pointer-events: all;
        display: flex;
        align-items: flex-start;
        gap: 10px;
        min-width: 260px;
        max-width: 380px;
        padding: 13px 16px;
        border-radius: 10px;
        box-shadow: 0 6px 24px rgba(0,0,0,.22);
        color: #fff;
        font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
        font-size: 14px;
        line-height: 1.4;
        animation: novaToastIn .28s ease forwards;
        cursor: default;
        position: relative;
        overflow: hidden;
      }
      .tecnocaja-toast.hiding { animation: novaToastOut .28s ease forwards; }
      .tecnocaja-toast-icon {
        font-size: 18px;
        flex-shrink: 0;
        margin-top: 1px;
        font-weight: 700;
      }
      .tecnocaja-toast-body { flex: 1; }
      .tecnocaja-toast-titulo { font-weight: 700; font-size: 13px; margin-bottom: 2px; opacity: .85; }
      .tecnocaja-toast-msg   { font-weight: 500; }
      .tecnocaja-toast-close {
        position: absolute;
        top: 8px; right: 10px;
        background: none; border: none;
        color: rgba(255,255,255,.7);
        font-size: 16px; cursor: pointer;
        line-height: 1; padding: 0;
      }
      .tecnocaja-toast-close:hover { color: #fff; }
      .tecnocaja-toast-progress {
        position: absolute;
        bottom: 0; left: 0;
        height: 3px;
        background: rgba(255,255,255,.45);
        border-radius: 0 0 10px 10px;
        transition: none;
      }
      .tecnocaja-toast-actions {
        display: flex; gap: 8px; margin-top: 10px;
      }
      .tecnocaja-toast-btn {
        padding: 6px 14px;
        border: 1px solid rgba(255,255,255,.5);
        border-radius: 6px;
        background: rgba(255,255,255,.15);
        color: #fff;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: background .15s;
      }
      .tecnocaja-toast-btn:hover { background: rgba(255,255,255,.3); }
      .tecnocaja-toast-btn.primary { background: rgba(255,255,255,.35); }
    `;
    document.head.appendChild(style);
  }

  function show(mensaje, tipo = 'info', { duracion, titulo, acciones } = {}) {
    injectStyles();
    const container = getContainer();
    const config = TIPOS[tipo] || TIPOS.info;
    const ms = duracion !== undefined ? duracion : (tipo === 'error' ? DURATION_ERROR : DURATION_DEFAULT);

    const toast = document.createElement('div');
    toast.className = 'tecnocaja-toast';
    toast.style.background = config.bg;

    const tituloStr = titulo || config.titulo;
    const accionesHtml = Array.isArray(acciones)
      ? `<div class="tecnocaja-toast-actions">${acciones.map((a, i) =>
          `<button class="tecnocaja-toast-btn${a.primary ? ' primary' : ''}" data-idx="${i}">${a.label}</button>`
        ).join('')}</div>`
      : '';

    toast.innerHTML = `
      <div class="tecnocaja-toast-icon">${config.icon}</div>
      <div class="tecnocaja-toast-body">
        <div class="tecnocaja-toast-titulo">${tituloStr}</div>
        <div class="tecnocaja-toast-msg">${mensaje}</div>
        ${accionesHtml}
      </div>
      <button class="tecnocaja-toast-close" aria-label="Cerrar">×</button>
      ${ms > 0 ? '<div class="tecnocaja-toast-progress" style="width:100%"></div>' : ''}
    `;

    container.appendChild(toast);

    function cerrar() {
      toast.classList.add('hiding');
      setTimeout(() => toast.remove(), 300);
    }

    toast.querySelector('.tecnocaja-toast-close').addEventListener('click', cerrar);

    if (Array.isArray(acciones)) {
      toast.querySelectorAll('.tecnocaja-toast-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.dataset.idx);
          const accion = acciones[idx];
          if (accion?.onClick) accion.onClick();
          cerrar();
        });
      });
    }

    if (ms > 0) {
      const bar = toast.querySelector('.tecnocaja-toast-progress');
      if (bar) {
        bar.style.transition = `width ${ms}ms linear`;
        requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = '0%'; }));
      }
      setTimeout(cerrar, ms);
    }

    return { cerrar };
  }

  /**
   * Reemplaza confirm() del navegador con un toast interactivo.
   * Retorna una Promise<boolean>.
   */
  function confirm(mensaje, { titulo = '¿Confirmar acción?', labelOk = 'Sí, continuar', labelCancel = 'Cancelar' } = {}) {
    return new Promise((resolve) => {
      show(mensaje, 'confirm', {
        titulo,
        duracion: DURATION_CONFIRM,
        acciones: [
          { label: labelOk,     primary: true,  onClick: () => resolve(true) },
          { label: labelCancel, primary: false, onClick: () => resolve(false) }
        ]
      });
    });
  }

  return {
    show,
    confirm,
    ok:      (msg, opts) => show(msg, 'success', opts),
    error:   (msg, opts) => show(msg, 'error',   opts),
    warn:    (msg, opts) => show(msg, 'warning', opts),
    info:    (msg, opts) => show(msg, 'info',    opts),

    /**
     * Wrap de fetch con toast automático en caso de error.
     * Uso: const data = await Toast.fetch('/api/ventas', { method:'POST', body })
     */
    async fetch(url, options = {}) {
      try {
        const res = await window.fetch(url, options);
        if (!res.ok) {
          let msg = `Error ${res.status}`;
          try { const d = await res.json(); msg = d.error || d.message || msg; } catch (_e) {}
          this.error(msg);
          throw new Error(msg);
        }
        return res.json();
      } catch (err) {
        if (!String(err.message || '').startsWith('Error ')) {
          this.error(err.message || 'Error de conexión');
        }
        throw err;
      }
    }
  };
})();

// Exportar globalmente
window.Toast = Toast;
