'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   Modo día / noche del portal de contadores.

   - Preferencia: 'dia', 'noche' o 'auto' (igual que Windows). Por defecto
     'noche', el aspecto de siempre. Se guarda en esta computadora
     (localStorage) y se avisa a Electron (contadoresAPI.setTheme) para que el
     splash, el fondo de la ventana y la barra de título salgan iguales en el
     próximo arranque.
   - Se carga en el <head> de index.html: pone <html data-theme> antes de que
     se pinte la página (sin parpadeo). Los colores están en contadores.css
     (:root = noche, :root[data-theme="light"] = día).
   - Controles: cualquier botón con data-tema-alternar cambia entre día y
     noche (menú lateral e inicio de sesión) y los [data-tema] de
     Configuración → Apariencia eligen la preferencia.
   - TemaPortal.alCambiar(fn) avisa los cambios (las gráficas de Chart.js
     no leen CSS y se repintan con los colores nuevos).
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  const CLAVE = 'tc_cont_tema';
  const PREFERENCIAS = ['dia', 'noche', 'auto'];
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const oyentes = [];

  function preferencia() {
    try {
      const v = localStorage.getItem(CLAVE);
      return PREFERENCIAS.includes(v) ? v : 'noche';
    } catch (_) {
      return 'noche';
    }
  }

  function modo(pref = preferencia()) {
    if (pref === 'auto') return media && !media.matches ? 'dia' : 'noche';
    return pref;
  }

  function pintarControles() {
    const pref = preferencia();
    const dia = modo(pref) === 'dia';
    // El botón muestra el modo al que se cambia.
    document.querySelectorAll('[data-tema-icono]').forEach((el) => { el.textContent = dia ? '🌙' : '☀️'; });
    document.querySelectorAll('[data-tema-texto]').forEach((el) => { el.textContent = dia ? 'Modo noche' : 'Modo día'; });
    document.querySelectorAll('[data-tema]').forEach((el) => {
      el.setAttribute('aria-checked', String(el.dataset.tema === pref));
    });
  }

  function aplicar() {
    const dia = modo() === 'dia';
    document.documentElement.setAttribute('data-theme', dia ? 'light' : 'dark');
    if (document.readyState !== 'loading') pintarControles();
    oyentes.forEach((fn) => { try { fn(dia ? 'dia' : 'noche'); } catch (_) { /* una gráfica rota no frena el resto */ } });
  }

  function elegir(pref) {
    if (!PREFERENCIAS.includes(pref)) return;
    try { localStorage.setItem(CLAVE, pref); } catch (_) { /* sin almacenamiento: vale solo por esta sesión */ }
    window.contadoresAPI?.setTheme?.(pref);
    aplicar();
  }

  function alternar() {
    elegir(modo() === 'dia' ? 'noche' : 'dia');
  }

  // En automático, seguir a Windows si cambia con la app abierta.
  media?.addEventListener?.('change', () => { if (preferencia() === 'auto') aplicar(); });

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-tema-alternar]')) { alternar(); return; }
    const opcion = event.target.closest('[data-tema]');
    if (opcion) elegir(opcion.dataset.tema);
  });

  document.addEventListener('DOMContentLoaded', () => {
    pintarControles();
    // Electron guarda su copia (splash y ventana del próximo arranque).
    window.contadoresAPI?.setTheme?.(preferencia());
  });

  window.TemaPortal = {
    preferencia,
    modo: () => modo(),
    elegir,
    alternar,
    alCambiar(fn) { if (typeof fn === 'function') oyentes.push(fn); },
  };

  aplicar();

  // ── Tamaño de la pantalla: agranda letra, botones y módulos a la vez ──
  // En la app es el zoom de la ventana (Electron); en un navegador, CSS zoom.
  const CLAVE_TAMANO = 'tc_cont_tamano';
  const TAMANOS = { normal: 1, grande: 1.1, muy_grande: 1.2 };

  function tamano() {
    try {
      const v = localStorage.getItem(CLAVE_TAMANO);
      return TAMANOS[v] ? v : 'normal';
    } catch (_) {
      return 'normal';
    }
  }

  function aplicarTamano() {
    const factor = TAMANOS[tamano()];
    if (window.contadoresAPI?.setZoom) window.contadoresAPI.setZoom(factor);
    else document.documentElement.style.zoom = factor === 1 ? '' : String(factor);
    document.querySelectorAll('[data-tamano]').forEach((el) => {
      el.setAttribute('aria-checked', String(el.dataset.tamano === tamano()));
    });
  }

  document.addEventListener('click', (event) => {
    const opcion = event.target.closest('[data-tamano]');
    if (!opcion || !TAMANOS[opcion.dataset.tamano]) return;
    try { localStorage.setItem(CLAVE_TAMANO, opcion.dataset.tamano); } catch (_) { /* vale solo por esta sesión */ }
    aplicarTamano();
  });
  document.addEventListener('DOMContentLoaded', aplicarTamano);
  aplicarTamano();
})();
