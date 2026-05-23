/**
 * rnc-lookup.js — Consulta RNC del dataset DGII local.
 *
 * Uso:
 *   // Lookup por RNC exacto
 *   const res = await RNCLookup.byId('130000000');
 *   // res = { found, rnc, nombre, nombreComercial, estado }
 *
 *   // Conectar autocomplete a un campo input
 *   RNCLookup.attach(inputEl, { onSelect: (data) => { ... } });
 */

window.RNCLookup = (() => {
  const CACHE = new Map();

  // ── API call ────────────────────────────────────────────────────────────────
  async function byId(rnc) {
    const id = String(rnc).replace(/\D/g, '').slice(0, 11);
    if (!id || id.length < 9) return null;
    if (CACHE.has(id)) return CACHE.get(id);
    try {
      const res = await fetch(`/api/rnc/lookup?id=${id}`);
      const data = await res.json();
      if (data.found) CACHE.set(id, data);
      return data;
    } catch { return null; }
  }

  async function search(q, limit = 8) {
    if (!q || q.length < 3) return [];
    try {
      const res = await fetch(`/api/rnc/search?q=${encodeURIComponent(q)}&limit=${limit}`);
      const data = await res.json();
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
    dropdown.style.left   = `${r.left + window.scrollX}px`;
    dropdown.style.top    = `${r.bottom + window.scrollY + 2}px`;
    dropdown.style.width  = `${r.width}px`;
  }

  function renderDropdown(dropdown, items, onSelect) {
    dropdown.innerHTML = '';
    if (!items.length) { dropdown.style.display = 'none'; return; }
    items.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'rnc-dropdown-item';
      const label = item.nombreComercial || item.nombre || item.rnc;
      li.innerHTML = `<span class="rnc-dd-name">${label}</span><span class="rnc-dd-id">${item.rnc}</span>`;
      if (item.estado && item.estado.toLowerCase() !== 'activo') {
        li.classList.add('rnc-dd-inactive');
      }
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        onSelect(item);
        dropdown.style.display = 'none';
      });
      dropdown.appendChild(li);
    });
    dropdown.style.display = 'block';
  }

  // ── Status badge ─────────────────────────────────────────────────────────────
  function setBadge(container, state, text) {
    let badge = container.querySelector('.rnc-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'rnc-badge';
      container.appendChild(badge);
    }
    badge.className = `rnc-badge rnc-badge--${state}`;
    badge.textContent = text;
  }

  function removeBadge(container) {
    container.querySelector('.rnc-badge')?.remove();
  }

  // ── attach ──────────────────────────────────────────────────────────────────
  /**
   * Conecta autocomplete RNC a un input.
   *
   * @param {HTMLInputElement} inputEl  — campo de texto
   * @param {object}  opts
   *   onSelect(data)   — callback cuando el usuario selecciona un resultado
   *   nameEl           — elemento donde escribir el nombre automáticamente
   *   badgeContainer   — elemento donde mostrar badge de estado
   *   mode             — 'id' (solo lookup exacto) | 'search' | 'both' (default)
   */
  function attach(inputEl, opts = {}) {
    const { onSelect, nameEl, badgeContainer, mode = 'both' } = opts;
    const dropdown = createDropdown();
    let debounce = null;

    async function handleInput() {
      const raw = inputEl.value.replace(/\D/g, '');
      removeBadge(badgeContainer || inputEl.parentElement);
      dropdown.style.display = 'none';

      if (!raw) return;

      clearTimeout(debounce);
      debounce = setTimeout(async () => {
        // Si tiene 9-11 dígitos → lookup exacto por ID
        if (raw.length >= 9 && (mode === 'id' || mode === 'both')) {
          const data = await byId(raw);
          if (data?.found) {
            applyResult(data);
            return;
          } else if (data && !data.found) {
            setBadge(badgeContainer || inputEl.parentElement, 'error', 'RNC no encontrado');
            return;
          }
        }
        // Búsqueda por nombre si tiene 3+ caracteres y no son solo dígitos
        if (inputEl.value.trim().length >= 3 && (mode === 'search' || mode === 'both') && !/^\d+$/.test(inputEl.value)) {
          const results = await search(inputEl.value.trim());
          positionDropdown(dropdown, inputEl);
          renderDropdown(dropdown, results, (item) => {
            inputEl.value = item.rnc;
            applyResult(item);
          });
        }
      }, 400);
    }

    function applyResult(data) {
      if (nameEl) nameEl.value = data.nombreComercial || data.nombre || '';
      const estado = (data.estado || '').toLowerCase();
      const badge = estado === 'activo' || !estado
        ? ['ok', `✓ ${data.nombre || data.rnc}`]
        : ['warn', `⚠ ${data.nombre} (${data.estado})`];
      setBadge(badgeContainer || inputEl.parentElement, badge[0], badge[1]);
      if (typeof onSelect === 'function') onSelect(data);
    }

    inputEl.addEventListener('input', handleInput);
    inputEl.addEventListener('blur', () => setTimeout(() => { dropdown.style.display = 'none'; }, 150));
    window.addEventListener('scroll', () => { if (dropdown.style.display !== 'none') positionDropdown(dropdown, inputEl); }, { passive: true });
  }

  return { byId, search, attach };
})();
