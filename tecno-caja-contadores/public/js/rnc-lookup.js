/**
 * rnc-lookup.js — Consulta RNC/Cédula desde dataset DGII local.
 * Adaptado para el Portal de Contadores (usa Bearer token de Firebase Auth).
 *
 * Uso:
 *   RNCLookup.attach(inputEl, { nameEl, onSelect, mode });
 *   const r = await RNCLookup.byId('130000000');
 */

window.RNCLookup = (() => {
  const CACHE = new Map();

  // ── Fetch autenticado ───────────────────────────────────────────────────────
  async function authFetch(url) {
    const token = typeof getTecnoCajaContToken === 'function'
      ? getTecnoCajaContToken()
      : (localStorage.getItem('tc-cont-token') || '');
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return res.json();
  }

  // ── API ─────────────────────────────────────────────────────────────────────
  async function byId(rnc) {
    const id = String(rnc).replace(/\D/g, '').slice(0, 11);
    if (!id || id.length < 9) return null;
    if (CACHE.has(id)) return CACHE.get(id);
    try {
      const data = await authFetch(`/api/rnc/lookup?id=${encodeURIComponent(id)}`);
      if (data.found) CACHE.set(id, data);
      return data;
    } catch { return null; }
  }

  async function search(q, limit = 8) {
    if (!q || q.length < 3) return [];
    try {
      const data = await authFetch(`/api/rnc/search?q=${encodeURIComponent(q)}&limit=${limit}`);
      return data.results || [];
    } catch { return []; }
  }

  // ── Dropdown UI ─────────────────────────────────────────────────────────────
  function createDropdown() {
    const el = document.createElement('ul');
    el.className = 'rnc-dropdown';
    el.style.display = 'none';
    document.body.appendChild(el);
    return el;
  }

  function positionDropdown(dropdown, inputEl) {
    const r = inputEl.getBoundingClientRect();
    dropdown.style.left  = `${r.left + window.scrollX}px`;
    dropdown.style.top   = `${r.bottom + window.scrollY + 2}px`;
    dropdown.style.width = `${r.width}px`;
  }

  function renderDropdown(dropdown, items, onSelect) {
    dropdown.innerHTML = '';
    if (!items.length) { dropdown.style.display = 'none'; return; }
    items.forEach(item => {
      const li = document.createElement('li');
      li.className = 'rnc-dropdown-item';
      const label = item.nombreComercial || item.nombre || item.rnc;
      li.innerHTML = `<span class="rnc-dd-name">${label}</span><span class="rnc-dd-id">${item.rnc}</span>`;
      if (item.estado && item.estado.toLowerCase() !== 'activo') {
        li.classList.add('rnc-dd-inactive');
      }
      li.addEventListener('mousedown', e => {
        e.preventDefault();
        onSelect(item);
        dropdown.style.display = 'none';
      });
      dropdown.appendChild(li);
    });
    dropdown.style.display = 'block';
  }

  // ── Badge de estado ─────────────────────────────────────────────────────────
  function setBadge(container, state, text) {
    removeBadge(container);
    const badge = document.createElement('span');
    badge.className = `rnc-badge rnc-badge--${state}`;
    badge.textContent = text;
    container.appendChild(badge);
  }

  function removeBadge(container) {
    container.querySelector('.rnc-badge')?.remove();
  }

  // ── attach ──────────────────────────────────────────────────────────────────
  /**
   * Conecta autocomplete RNC a un campo input.
   *
   * @param {HTMLInputElement} inputEl
   * @param {object} opts
   *   nameEl         — input donde volcar el nombre encontrado (opcional)
   *   badgeContainer — elemento donde mostrar el badge (default: parentElement)
   *   onSelect(data) — callback cuando se selecciona un resultado
   *   mode           — 'id' | 'search' | 'both' (default)
   */
  function attach(inputEl, opts = {}) {
    if (!inputEl || inputEl.dataset.rncAttached) return;
    inputEl.dataset.rncAttached = '1';

    // idEl: solo se usa en mode='name' — campo donde se vuelca el RNC seleccionado
    const { onSelect, nameEl, idEl, badgeContainer, mode = 'both' } = opts;
    const dropdown = createDropdown();
    let debounce   = null;

    function applyResult(data) {
      // En mode='name' el inputEl es el campo de nombre; nameEl no aplica aquí
      if (mode !== 'name' && nameEl && (!nameEl.value || nameEl.dataset.rncOverride !== 'manual')) {
        nameEl.value = data.nombreComercial || data.nombre || '';
      }
      const estado  = (data.estado || '').toLowerCase();
      const isOk    = !estado || estado === 'activo';
      const badgeTxt = isOk
        ? `✓ ${data.nombre || data.rnc}`
        : `⚠ ${data.nombre} (${data.estado})`;
      setBadge(badgeContainer || inputEl.parentElement, isOk ? 'ok' : 'warn', badgeTxt);
      if (typeof onSelect === 'function') onSelect(data);
    }

    async function handleInput() {
      const raw = inputEl.value.replace(/\D/g, '');
      removeBadge(badgeContainer || inputEl.parentElement);
      dropdown.style.display = 'none';
      if (!raw && !inputEl.value.trim()) return;

      clearTimeout(debounce);
      debounce = setTimeout(async () => {
        // Lookup exacto si 9-11 dígitos (no aplica en mode='name')
        if (raw.length >= 9 && (mode === 'id' || mode === 'both')) {
          const data = await byId(raw);
          if (data?.found) { applyResult(data); return; }
          if (data && !data.found) {
            setBadge(badgeContainer || inputEl.parentElement, 'error', 'No encontrado en DGII');
            return;
          }
        }
        // Búsqueda por nombre si 3+ caracteres de texto
        const txt = inputEl.value.trim();
        if (txt.length >= 3 && (mode === 'search' || mode === 'both' || mode === 'name') && !/^\d+$/.test(txt)) {
          const results = await search(txt);
          positionDropdown(dropdown, inputEl);
          renderDropdown(dropdown, results, item => {
            if (mode === 'name') {
              // inputEl es el campo nombre: llenarlo con el nombre, idEl con el RNC
              inputEl.value = item.nombreComercial || item.nombre || '';
              if (idEl) idEl.value = item.rnc || '';
            } else {
              inputEl.value = item.rnc;
            }
            applyResult(item);
          });
        }
      }, 650); // 650ms debounce
    }

    // Marcar edición manual en el campo nombre para no sobrescribirlo (solo en modos no-name)
    if (nameEl && mode !== 'name') {
      nameEl.addEventListener('input', () => { nameEl.dataset.rncOverride = 'manual'; });
    }

    inputEl.addEventListener('input', handleInput);
    inputEl.addEventListener('blur', () => setTimeout(() => { dropdown.style.display = 'none'; }, 200));
    window.addEventListener('scroll', () => {
      if (dropdown.style.display !== 'none') positionDropdown(dropdown, inputEl);
    }, { passive: true });
  }

  return { byId, search, attach };
})();

// Helper para obtener el token de auth del portal de contadores
function getTecnoCajaContToken() {
  try {
    return localStorage.getItem('tecnocaja-auth-token') || '';
  } catch { return ''; }
}
