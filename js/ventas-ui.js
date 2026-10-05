// ===== TECNO CAJA - PANTALLA DE VENTAS (panel derecho) =====
//
// Solo interfaz (estilos en css/ventas.css). Los totales los calcula
// updateTotals() en ventas.js y quedan en los <span> ocultos (#s-subtotal,
// #s-itbis, #s-total...): aquí solo se copian al resumen. El cliente es
// DB.saleClientId y se cambia con setSaleClient(), igual que en el cobro.

(function () {
  'use strict';

  function icon(name, size = 20) {
    return window.TcIconos ? window.TcIconos.svg(name, size) : '';
  }

  function esc(value) {
    return typeof escapeHtml === 'function' ? escapeHtml(value) : String(value ?? '');
  }

  function textOf(id, fallback = '') {
    return document.getElementById(id)?.textContent || fallback;
  }

  // "RD$ 2,600.00" / "- RD$ 260.00" → "2,600.00" / "-260.00"
  function stripCurrency(text) {
    const raw = String(text || '').trim();
    const negative = raw.startsWith('-');
    const digits = raw.replace(/[^0-9.,]/g, '');
    if (!digits) return '0.00';
    const isZero = Number(digits.replace(/,/g, '')) === 0;
    return negative && !isZero ? `-${digits}` : digits;
  }

  function set(id, value) {
    const el = document.getElementById(id);
    if (el && el.textContent !== value) el.textContent = value;
  }

  // El cobro usa el cliente elegido aquí; sin cliente elegido, el último
  // recordado (si esa opción está activa). Se muestra el mismo.
  function getDisplayedClient() {
    const id = Number(DB.saleClientId || 0)
      || (typeof getRememberedBillingClientId === 'function' ? Number(getRememberedBillingClientId() || 0) : 0);
    return id ? (DB.clientes || []).find((client) => Number(client.id) === id) || null : null;
  }

  function syncClient() {
    const client = getDisplayedClient();
    set('ventas-client-name', client?.nombre || 'Consumidor final');
    set('ventas-client-doc', client ? (client.rnc || client.cedula || '') : '');
  }

  function syncSummary() {
    const items = Array.isArray(DB.saleItems) ? DB.saleItems : [];
    const lines = items.length;
    const quantities = items.map((item) => Number(item?.qty || 0));
    const allWhole = quantities.every((qty) => Number.isInteger(qty));
    const units = quantities.reduce((sum, qty) => sum + qty, 0);
    set('ventas-sum-items', lines && allWhole
      ? `${lines} (${units} ${units === 1 ? 'unidad' : 'unidades'})`
      : String(lines));

    set('ventas-sum-subtotal', stripCurrency(textOf('s-subtotal', '0')));
    set('ventas-sum-descuento', stripCurrency(textOf('s-descuento', '0')));
    set('ventas-sum-itbis', stripCurrency(textOf('s-itbis', '0')));
    set('ventas-sum-itbis-label', textOf('sale-tax-label', 'ITBIS').replace(/[()]/g, '').trim() || 'ITBIS');

    // Redondeo solo cuando existe: cambia el total y hay que poder explicarlo.
    const rounding = typeof parseFmt === 'function' ? parseFmt(textOf('s-redondeo', '0')) : 0;
    document.getElementById('ventas-sum-redondeo-row')?.classList.toggle('hidden', Math.abs(rounding) < 0.01);
    set('ventas-sum-redondeo', stripCurrency(textOf('s-redondeo', '0')));

    set('ventas-total-currency', String(DB.config?.moneda || 'RD$').trim() || 'RD$');
    const total = stripCurrency(textOf('s-total', '0'));
    set('ventas-total-value', total);
    // Montos de 10+ caracteres (1,000,000.00) bajan un tamaño para no cortarse.
    document.getElementById('ventas-total-value')?.classList.toggle('is-long', total.length >= 10);
  }

  // ── Vista con catálogo (opción de Configuración): "Pedido | Catálogo" ──

  let activeView = 'pedido';

  function syncViewSwitch() {
    const workspace = document.querySelector('#module-ventas .ventas-workspace');
    const switcher = document.getElementById('ventas-view-switch');
    if (!workspace || !switcher) return;
    const split = workspace.classList.contains('ventas-workspace--split');
    switcher.classList.toggle('hidden', !split);
    if (!split) activeView = 'pedido';
    workspace.dataset.view = split ? activeView : 'pedido';
    switcher.querySelectorAll('[data-view]').forEach((tab) => {
      const selected = tab.dataset.view === activeView;
      tab.classList.toggle('is-active', selected);
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
  }

  function setView(view) {
    activeView = view === 'catalogo' ? 'catalogo' : 'pedido';
    syncViewSwitch();
    if (activeView === 'catalogo' && typeof renderSalesCatalog === 'function') renderSalesCatalog();
  }

  // ── Cliente ──────────────────────────────────────────────────────────────

  function renderClientResults(query = '') {
    const results = document.getElementById('ventas-client-results');
    if (!results) return;
    const needle = String(query || '').trim().toLowerCase();
    const digits = needle.replace(/\D/g, '');
    const clients = (DB.clientes || [])
      .filter((client) => {
        if (!needle) return true;
        const name = String(client.nombre || '').toLowerCase();
        const docs = `${client.cedula || ''} ${client.rnc || ''} ${client.telefono || ''}`.replace(/\D/g, '');
        return name.includes(needle) || (digits && docs.includes(digits));
      })
      .sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es'))
      .slice(0, 60);
    const activeId = String(getDisplayedClient()?.id || '');
    results.innerHTML = `
      <button type="button" class="tc-menu-item ${activeId ? '' : 'is-active'}" onclick="VentasUI.chooseClient('')">
        <strong>Consumidor final</strong><span>Sin cliente registrado</span>
      </button>
      ${clients.map((client) => `
        <button type="button" class="tc-menu-item ${activeId === String(client.id) ? 'is-active' : ''}" onclick="VentasUI.chooseClient('${esc(client.id)}')">
          <strong>${esc(client.nombre || 'Sin nombre')}</strong>
          <span>${esc([client.rnc || client.cedula, client.telefono].filter(Boolean).join(' · ') || 'Sin documento')}</span>
        </button>
      `).join('')}
      ${clients.length ? '' : '<div class="ventas-client-empty">Ningún cliente coincide con la búsqueda.</div>'}
    `;
  }

  function isPickerOpen() {
    const picker = document.getElementById('ventas-client-picker');
    return Boolean(picker && !picker.classList.contains('hidden'));
  }

  function toggleClientPicker(force = null) {
    const picker = document.getElementById('ventas-client-picker');
    const button = document.getElementById('ventas-client-btn');
    if (!picker) return;
    const show = force === null ? picker.classList.contains('hidden') : Boolean(force);
    picker.classList.toggle('hidden', !show);
    button?.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) {
      const search = document.getElementById('ventas-client-search');
      if (search) search.value = '';
      renderClientResults('');
      // Enfoque inmediato: así Ventas no devuelve el cursor al buscador de productos.
      search?.focus();
    }
  }

  function chooseClient(id) {
    toggleClientPicker(false);
    if (typeof setSaleClient === 'function') setSaleClient(id || '');
    sync();
    if (typeof focusSalesSearchInput === 'function') focusSalesSearchInput({ force: true });
  }

  function closePopovers() {
    if (!isPickerOpen()) return false;
    toggleClientPicker(false);
    if (typeof focusSalesSearchInput === 'function') focusSalesSearchInput({ force: true });
    return true;
  }

  document.addEventListener('pointerdown', (event) => {
    if (!isPickerOpen()) return;
    if (event.target.closest('#ventas-client-picker') || event.target.closest('#ventas-client-btn')) return;
    toggleClientPicker(false);
  }, true);

  // ── Íconos de la pantalla (sin emojis) ──────────────────────────────────

  function decorate() {
    const fill = (selector, name, size) => {
      document.querySelectorAll(selector).forEach((el) => {
        if (!el.querySelector('svg')) el.innerHTML = icon(name, size);
      });
    };
    fill('#module-ventas .search-icon', 'search', 22);
    fill('#module-ventas .quick-sale-add-btn', 'plus', 22);
    fill('#module-ventas .ventas-client-icon', 'user', 20);
    fill('#module-ventas .ventas-picker-search-icon', 'search', 18);
    fill('#module-ventas .sale-empty-icon', 'shopping-cart', 40);
    document.querySelectorAll('#module-ventas .ventas-action-icon[data-icon]').forEach((el) => {
      if (!el.querySelector('svg')) el.innerHTML = icon(el.dataset.icon, 18);
    });
  }

  function sync() {
    if (!document.getElementById('module-ventas')) return;
    decorate();
    syncClient();
    syncSummary();
    syncViewSwitch();
  }

  window.VentasUI = {
    sync,
    setView,
    toggleClientPicker,
    renderClientResults,
    chooseClient,
    closePopovers
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sync);
  } else {
    sync();
  }
})();
