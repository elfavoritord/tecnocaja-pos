// ===== TECNO CAJA - DETALLES VISUALES COMUNES DE LOS MÓDULOS =====
//
// Solo interfaz (estilos en css/modulos.css). Dos cosas:
//
// 1. Ceros en color normal: los módulos pintan sus tarjetas de resumen de
//    ámbar o rojo siempre ("Agotados", "Vencido"...); aquí se marca .is-zero
//    cuando el valor es 0 para que el color solo aparezca con un problema real.
//
// 2. Sin emojis: muchos textos de los módulos se arman en los .js con emojis
//    ("💾 Guardar", "✅ Listo", botones "👁"). En vez de reescribir cientos de
//    cadenas en 30 archivos, al mostrarse en pantalla:
//      - un emoji junto a un texto se quita ("💾 Guardar" → "Guardar");
//      - un emoji solo (ícono suelto) se cambia por el ícono de línea Lucide
//        equivalente (js/iconos.js), o se quita si no hay equivalente.
//    No se tocan campos de texto, recibos ni conversaciones (los datos del
//    usuario quedan como están). Para excluir algo: data-keep-emoji.

(function () {
  'use strict';

  // ── 1. Ceros en color normal ────────────────────────────────────────────

  const NUMBER_SELECTOR = [
    '.stat-card .stat-val',
    '.stat-card .stat-value',
    '.report-card .report-card-val',
    '.dp-stat .dp-stat-num',
    '[data-tc-number]'
  ].join(',');

  function isZeroText(text) {
    const digits = String(text || '').replace(/[^0-9.,-]/g, '').replace(/,/g, '');
    if (!digits || !/[0-9]/.test(digits)) return false;
    return Number(digits) === 0;
  }

  function markZeros(root = document) {
    root.querySelectorAll(NUMBER_SELECTOR).forEach((el) => {
      const zero = isZeroText(el.textContent);
      if (el.classList.contains('is-zero') !== zero) el.classList.toggle('is-zero', zero);
    });
  }

  // ── 2. Emojis → texto limpio o ícono de línea ───────────────────────────

  const EMOJI = '(?:[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{21A9}\\u{21BA}\\u{21BB}\\u{2197}\\u{2198}\\u{2300}-\\u{23FF}\\u{25A0}-\\u{25FF}\\u{2139}](?:\\u{FE0F}|\\u{200D}[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}])*)';
  const HAS_EMOJI = new RegExp(EMOJI, 'u');
  const EMOJI_WITH_SPACE = new RegExp(`\\s*${EMOJI}\\s*`, 'gu');
  const ONLY_EMOJI = new RegExp(`^\\s*(${EMOJI})\\s*$`, 'u');

  const ICON = {
    '👁': 'eye', '🙈': 'eye-off', '✓': 'check', '✔': 'check', '✅': 'circle-check', '☑': 'square-check', 'ℹ': 'info',
    '✕': 'x', '✖': 'x', '❌': 'x', '✗': 'x', '⚠': 'triangle-alert', '⛔': 'circle-alert', '🔍': 'search', '🔎': 'search',
    '🏪': 'store', '🔗': 'link', '🔒': 'lock', '🔓': 'lock-open', '🔐': 'key-round', '🔑': 'key-round', '🖥': 'monitor',
    '🚚': 'truck', '🛵': 'bike', '🧾': 'receipt', '💵': 'banknote', '💸': 'banknote', '💰': 'wallet', '↺': 'rotate-ccw',
    '↻': 'refresh-cw', '🔄': 'refresh-cw', '🔁': 'repeat', '↩': 'undo-2', '📦': 'package', '📝': 'file-pen-line', '⚡': 'zap',
    '🏭': 'factory', '📊': 'chart-column', '📈': 'chart-line', '📉': 'chart-line', '📋': 'clipboard-list', '🏛': 'landmark',
    '🏦': 'landmark', '📄': 'file-text', '📃': 'file-text', '📑': 'files', '💾': 'save', '📕': 'book-open', '📚': 'book-open',
    '🏢': 'building-2', '🖨': 'printer', '👤': 'user', '👥': 'users', '▾': 'chevron-down', '▼': 'chevron-down',
    '🛒': 'shopping-cart', '☁': 'cloud', '🌐': 'globe', '🔢': 'hash', '📤': 'send', '📨': 'send', '🗂': 'folder',
    '📁': 'folder', '📂': 'folder-open', '💱': 'arrow-left-right', '🗑': 'trash-2', '✏': 'pencil', '➕': 'plus', '➖': 'minus',
    '⚙': 'settings', '📅': 'calendar', '📆': 'calendar', '🕒': 'clock', '🕘': 'clock', '⏱': 'clock', '⏳': 'clock',
    '⏰': 'alarm-clock', '📱': 'smartphone', '💬': 'message-circle', '🔔': 'bell', '🔌': 'plug', '⚖': 'scale', '🏷': 'tag',
    '📢': 'megaphone', '📣': 'megaphone', '🖼': 'image', '🚀': 'rocket', '🧹': 'brush-cleaning', '💳': 'credit-card',
    '🤖': 'bot', '🏆': 'trophy', '▶': 'play', '■': 'square', '⬇': 'download', '⬆': 'upload', '📥': 'download',
    '↗': 'arrow-up-right', '↘': 'arrow-down-right', '🎨': 'palette', '🔥': 'flame', '🏠': 'house', '🧪': 'flask-conical',
    '🛡': 'shield', '🚪': 'log-out', '🔧': 'wrench', '🛠': 'wrench', '📞': 'phone', '☎': 'phone', '📧': 'mail', '✉': 'mail',
    '📍': 'map-pin', '🗺': 'map', '👔': 'user', '🧑‍💼': 'user', '👨‍💼': 'user'
  };

  // No se tocan datos escritos por el usuario ni documentos impresos. El login,
  // el asistente inicial, la bienvenida y los paneles de plataforma ya tienen
  // el diseño nuevo: sus emojis también pasan a íconos de línea.
  const SKIP = 'textarea, input, select, script, style, pre, code, svg, [contenteditable="true"], [data-keep-emoji], '
    + '#receipt-content, .receipt, .tcfac-root, .ticket-print, '
    + '.wabot-chat, .wabot-messages, .label-preview, #lbl-preview';

  function iconFor(emoji) {
    const key = emoji.replace(/️/g, '');
    const name = ICON[key] || ICON[emoji];
    if (!name || !window.TcIconos || !window.TcIconos.paths[name]) return null;
    const holder = document.createElement('span');
    holder.innerHTML = window.TcIconos.svg(name, 20);
    const svg = holder.firstElementChild;
    // Del tamaño del texto que reemplaza (los íconos grandes de pantallas vacías siguen grandes).
    svg.setAttribute('width', '1.15em');
    svg.setAttribute('height', '1.15em');
    svg.classList.add('tc-emoji-icon');
    return svg;
  }

  function cleanText(node) {
    const value = node.nodeValue;
    if (!value || !HAS_EMOJI.test(value)) return;
    const parent = node.parentElement;
    if (!parent || parent.closest(SKIP)) return;

    const only = value.match(ONLY_EMOJI);
    if (only) {
      const icon = iconFor(only[1]);
      if (icon) {
        node.replaceWith(icon);
      } else {
        node.nodeValue = '';
      }
      return;
    }
    const lead = /^\s/.test(value) ? ' ' : '';
    const trail = /\s$/.test(value) ? ' ' : '';
    const cleaned = value.replace(EMOJI_WITH_SPACE, ' ').replace(/ {2,}/g, ' ').trim();
    node.nodeValue = cleaned ? `${lead}${cleaned}${trail}` : '';
  }

  const ATTRS = ['title', 'placeholder', 'aria-label'];

  function cleanAttrs(el) {
    if (el.closest(SKIP) && !el.matches('input, textarea, select')) return;
    ATTRS.forEach((attr) => {
      const value = el.getAttribute(attr);
      if (value && HAS_EMOJI.test(value)) {
        el.setAttribute(attr, value.replace(EMOJI_WITH_SPACE, ' ').replace(/ {2,}/g, ' ').trim());
      }
    });
  }

  function cleanTree(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      cleanText(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    if (root.matches(SKIP) && !root.matches('input, textarea, select')) return;
    cleanAttrs(root);
    root.querySelectorAll('[title], [placeholder], [aria-label]').forEach(cleanAttrs);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    texts.forEach(cleanText);
  }

  // ── Observador ──────────────────────────────────────────────────────────

  const pending = new Set();

  function flush() {
    pending.forEach((node) => {
      if (node.isConnected) cleanTree(node);
    });
    pending.clear();
    markZeros();
  }

  function onMutations(records) {
    records.forEach((record) => {
      if (record.type === 'characterData') {
        pending.add(record.target);
      } else if (record.type === 'attributes') {
        pending.add(record.target);
      } else {
        record.addedNodes.forEach((node) => pending.add(node));
      }
    });
    // En el mismo turno (antes de pintar): el emoji no llega a verse.
    flush();
  }

  function init() {
    cleanTree(document.body);
    markZeros();
    new MutationObserver(onMutations).observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ATTRS
    });
  }

  // ── 3. Listas: paginación y menú "Más acciones" ─────────────────────────
  // Plantilla de lista: pie con "Mostrando X a Y de Z" y paginación. Cada
  // módulo pide su página con TcLista.paginate('clave', lista) y dibuja el pie
  // con TcLista.footer(...). Solo cambia lo que se muestra, no los datos.

  const PAGE_SIZE = 50;
  const pages = {};

  function paginate(key, items, size = PAGE_SIZE) {
    const list = Array.isArray(items) ? items : [];
    const total = list.length;
    const pageCount = Math.max(1, Math.ceil(total / size));
    const page = Math.min(Math.max(1, pages[key] || 1), pageCount);
    pages[key] = page;
    const start = (page - 1) * size;
    const slice = list.slice(start, start + size);
    return { items: slice, total, page, pageCount, from: total ? start + 1 : 0, to: start + slice.length };
  }

  function resetPage(key) {
    pages[key] = 1;
  }

  function go(key, delta, renderFn) {
    pages[key] = Math.max(1, (pages[key] || 1) + delta);
    if (typeof window[renderFn] === 'function') window[renderFn]();
  }

  function footer(key, info, renderFn, noun = 'registros') {
    const count = info.total
      ? `Mostrando ${info.from} a ${info.to} de ${info.total} ${noun}`
      : `0 ${noun}`;
    const nav = info.pageCount > 1
      ? `<div class="tc-pagination">
          <button type="button" class="tc-btn" ${info.page <= 1 ? 'disabled' : ''} onclick="TcLista.go('${key}', -1, '${renderFn}')">Anterior</button>
          <button type="button" class="tc-btn" ${info.page >= info.pageCount ? 'disabled' : ''} onclick="TcLista.go('${key}', 1, '${renderFn}')">Siguiente</button>
        </div>`
      : '';
    return `<span class="tc-list-count">${count}</span>${nav}`;
  }

  function closeMenus(except = null) {
    document.querySelectorAll('.tc-more-menu:not(.hidden)').forEach((menu) => {
      if (menu === except) return;
      menu.classList.add('hidden');
      menu.parentElement?.querySelector('.tc-more-btn')?.setAttribute('aria-expanded', 'false');
    });
  }

  function toggleMore(button) {
    const menu = button?.parentElement?.querySelector('.tc-more-menu');
    if (!menu) return;
    const show = menu.classList.contains('hidden');
    closeMenus(menu);
    menu.classList.toggle('hidden', !show);
    button.setAttribute('aria-expanded', show ? 'true' : 'false');
  }

  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('.tc-more')) closeMenus();
  }, true);
  document.addEventListener('click', (event) => {
    if (event.target.closest('.tc-more-menu .tc-menu-item')) closeMenus();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.querySelector('.tc-more-menu:not(.hidden)')) closeMenus();
  }, true);

  window.TcLista = { paginate, resetPage, go, footer, toggleMore, closeMenus };
  window.TcModulos = { markZeros, cleanTree };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
