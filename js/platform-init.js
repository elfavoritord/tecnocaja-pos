'use strict';

/**
 * platform-init.js — Pantalla de selección inicial de plataforma
 * Mostrada antes del wizard cuando el sistema no está configurado
 * o cuando el usuario pulsa "Soy usuario nuevo".
 */

window.platformInit = (() => {
  let _onChoice = null;

  function show(onChoiceCallback) {
    _onChoice = onChoiceCallback;
    const screen = document.getElementById('platform-init-screen');
    if (!screen) return;

    document.getElementById('login-screen')?.classList.add('hidden');
    document.getElementById('setup-screen')?.classList.add('hidden');
    screen.classList.remove('hidden');
    screen.style.display = '';
  }

  function hide() {
    const screen = document.getElementById('platform-init-screen');
    if (screen) {
      screen.classList.add('hidden');
      screen.style.display = 'none';
    }
  }

  function choose(option) {
    hide();
    if (typeof _onChoice === 'function') _onChoice(option);
  }

  // ── Contador search autocomplete ─────────────────────────────────────────
  let _contadorSearchTimeout = null;
  let _selectedContador = null;

  function initContadorSearch() {
    const input = document.getElementById('pi-contador-search');
    const results = document.getElementById('pi-contador-results');
    if (!input || !results) return;

    input.addEventListener('input', () => {
      clearTimeout(_contadorSearchTimeout);
      const q = input.value.trim();
      if (q.length < 2) { results.innerHTML = ''; results.classList.add('hidden'); return; }
      _contadorSearchTimeout = setTimeout(() => searchContadores(q), 300);
    });
  }

  async function searchContadores(q) {
    const results = document.getElementById('pi-contador-results');
    if (!results) return;
    try {
      const res = await fetch(`/api/platform/contadores/buscar?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) {
        results.innerHTML = '<div class="pi-no-results">No se encontraron contadores activos.</div>';
        results.classList.remove('hidden');
        return;
      }
      results.innerHTML = data.map(c => `
        <div class="pi-contador-item" data-id="${c.id}" onclick="platformInit._selectContador(${JSON.stringify(c).replace(/"/g, '&quot;')})">
          <strong>${c.nombre_firma}</strong>
          <span>${c.responsable || ''} · ${c.correo || ''}</span>
        </div>
      `).join('');
      results.classList.remove('hidden');
    } catch {
      results.innerHTML = '<div class="pi-no-results">Error al buscar. Revisa la conexión.</div>';
      results.classList.remove('hidden');
    }
  }

  function _selectContador(contador) {
    _selectedContador = contador;
    const input = document.getElementById('pi-contador-search');
    const results = document.getElementById('pi-contador-results');
    const selected = document.getElementById('pi-contador-selected');
    if (input) input.value = contador.nombre_firma;
    if (results) results.classList.add('hidden');
    if (selected) {
      selected.innerHTML = `<span class="pi-selected-chip">✓ ${contador.nombre_firma}</span>`;
    }
  }

  function confirmContadorChoice() {
    if (!_selectedContador) {
      alert('Por favor selecciona un contador de la lista.');
      return;
    }
    choose({ type: 'accountant_client', contador: _selectedContador });
  }

  function showSubview(id) {
    document.querySelectorAll('.pi-subview').forEach(el => el.classList.add('hidden'));
    const target = document.getElementById(id);
    if (target) target.classList.remove('hidden');

    if (id === 'pi-sub-accountant-client') {
      setTimeout(initContadorSearch, 50);
    }
  }

  function backToMain() {
    document.querySelectorAll('.pi-subview').forEach(el => el.classList.add('hidden'));
    document.getElementById('pi-main-options')?.classList.remove('hidden');
    _selectedContador = null;
  }

  return { show, hide, choose, _selectContador, confirmContadorChoice, showSubview, backToMain };
})();
