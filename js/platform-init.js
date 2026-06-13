'use strict';

/**
 * platform-init.js — Pantalla de selección inicial de plataforma
 */

window.platformInit = (() => {
  let _onChoice         = null;
  let _selectedContador = null;
  let _searchTimeout    = null;

  // ── Mostrar / ocultar pantalla ─────────────────────────────────────────────
  function show(onChoiceCallback) {
    _onChoice = onChoiceCallback;
    const screen = document.getElementById('platform-init-screen');
    if (!screen) return;
    document.getElementById('login-screen')?.classList.add('hidden');
    document.getElementById('setup-screen')?.classList.add('hidden');
    screen.classList.remove('hidden');
    screen.style.display = '';
    _updateStatusFooter();
  }

  function _updateStatusFooter() {
    // Versión
    const verEl = document.getElementById('pi-version-label');
    if (verEl && window.__APP_VERSION__) verEl.textContent = `v${window.__APP_VERSION__}`;

    // Firebase status
    const fbEl = document.getElementById('pi-status-firebase');
    if (!fbEl) return;
    fetch('/api/health', { signal: AbortSignal.timeout(4000) })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => {
        const ok = data?.firebase !== false;
        fbEl.querySelector('.pi-status-dot')?.setAttribute('class', `pi-status-dot ${ok ? 'pi-dot-ok' : 'pi-dot-error'}`);
        fbEl.querySelector('span:last-child').textContent = ok ? 'Plataforma conectada' : 'Sin conexión a plataforma';
      })
      .catch(() => {
        fbEl.querySelector('.pi-status-dot')?.setAttribute('class', 'pi-status-dot pi-dot-error');
        fbEl.querySelector('span:last-child').textContent = 'Sin conexión al servidor';
      });
  }

  function hide() {
    const screen = document.getElementById('platform-init-screen');
    if (screen) { screen.classList.add('hidden'); screen.style.display = 'none'; }
  }

  function choose(option) {
    hide();
    if (typeof _onChoice === 'function') _onChoice(option);
  }

  // ── Navegación entre subvistas ─────────────────────────────────────────────
  function showSubview(id) {
    const target = document.getElementById(id);
    if (!target) return;
    target.classList.remove('hidden');
    if (id === 'pi-sub-accountant-client') setTimeout(initContadorSearch, 50);
  }

  function backToMain() {
    document.querySelectorAll('.pi-subview-overlay').forEach(el => el.classList.add('hidden'));
    _selectedContador = null;
    _searchInitialized = false;
    clearContador();
  }

  // ── Búsqueda de contadores ─────────────────────────────────────────────────
  let _searchInitialized = false;

  function initContadorSearch() {
    if (_searchInitialized) return;
    _searchInitialized = true;

    const input = document.getElementById('pi-contador-search');
    if (!input) return;
    input.value = '';
    hideResults();

    input.addEventListener('input', () => {
      clearTimeout(_searchTimeout);
      const q = input.value.trim();
      if (q.length < 2) { hideResults(); return; }
      showSpinner(true);
      _searchTimeout = setTimeout(() => _fetchContadores(q), 350);
    });

    setTimeout(() => input.focus(), 80);
  }

  async function _fetchContadores(q) {
    try {
      const res = await fetch(`/api/platform/contadores/buscar?q=${encodeURIComponent(q)}`);
      showSpinner(false);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (!Array.isArray(data) || data.length === 0) {
        setResults(`<div class="pi-no-results"><p>Sin resultados</p><span>Prueba con otro nombre, RNC o correo</span></div>`);
        showResults(); return;
      }

      setResults(data.map(c => {
        const safe = JSON.stringify(c).replace(/'/g, '&#39;');
        const ini  = (c.nombre_firma || '?')[0].toUpperCase();
        return `<div class="pi-resultado-item" onclick='platformInit._selectContador(${safe})'>
          <div class="pi-res-avatar">${ini}</div>
          <div class="pi-res-info">
            <div class="pi-res-nombre">${c.nombre_firma}</div>
            <div class="pi-res-sub">
              ${c.responsable ? `<span>${c.responsable}</span>` : ''}
              ${c.rnc         ? `<span>RNC: ${c.rnc}</span>`    : ''}
              ${c.correo      ? `<span>${c.correo}</span>`       : ''}
            </div>
          </div>
          <div class="pi-res-select">Seleccionar</div>
        </div>`;
      }).join(''));
      showResults();
    } catch (err) {
      showSpinner(false);
      setResults(`<div class="pi-no-results"><p>Error de conexión</p><span>${err.message}</span></div>`);
      showResults();
    }
  }


  function _selectContador(contador) {
    _selectedContador = contador;

    // Mostrar card de seleccionado, ocultar resultados e input
    const inp    = document.getElementById('pi-contador-search');
    const wrap   = document.querySelector('.pi-search-wrap');
    const selWrap = document.getElementById('pi-contador-selected');
    const btnCont = document.getElementById('pi-btn-continuar');

    if (wrap)    wrap.classList.add('hidden');
    if (inp)     inp.value = '';
    hideResults();

    if (selWrap) {
      selWrap.classList.remove('hidden');
      const el = document.getElementById('pi-sel-nombre');
      const el2 = document.getElementById('pi-sel-detalle');
      if (el)  el.textContent  = contador.nombre_firma;
      if (el2) el2.textContent = [contador.responsable, contador.rnc ? `RNC: ${contador.rnc}` : '', contador.correo].filter(Boolean).join(' · ');
    }

    if (btnCont) btnCont.disabled = false;
  }

  function clearContador() {
    _selectedContador = null;
    const wrap    = document.querySelector('.pi-search-wrap');
    const selWrap = document.getElementById('pi-contador-selected');
    const btn     = document.getElementById('pi-btn-continuar');
    const inp     = document.getElementById('pi-contador-search');

    if (wrap)    wrap.classList.remove('hidden');
    if (selWrap) selWrap.classList.add('hidden');
    if (btn)     btn.disabled = true;
    if (inp)     { inp.value = ''; inp.focus(); }
    hideResults();
  }

  function confirmContadorChoice() {
    if (!_selectedContador) return;
    choose({ type: 'accountant_client', contador: _selectedContador });
  }

  // ── Helpers UI ─────────────────────────────────────────────────────────────
  function setResults(html)  { const el = document.getElementById('pi-contador-results'); if (el) el.innerHTML = html; }
  function showResults()     { document.getElementById('pi-mr')?.style && (document.getElementById('pi-mr').style.display = ''); }
  function hideResults()     { document.getElementById('pi-mr')?.style && (document.getElementById('pi-mr').style.display = 'none'); }
  function showSpinner(show) { document.getElementById('pi-search-spinner')?.classList.toggle('hidden', !show); }

  return { show, hide, choose, showSubview, backToMain, _selectContador, clearContador, confirmContadorChoice };
})();
