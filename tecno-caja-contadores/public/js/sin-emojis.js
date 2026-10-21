// ===== PORTAL DE CONTADORES — SIN EMOJIS (diseño 2026) =====
//
// Mismo criterio que el POS (js/modulos.js): muchos textos del portal se arman
// con emojis ("🔄 Actualizar datos", "🟢 Activa", botones "👁"). En vez de
// reescribir cientos de cadenas, al mostrarse en pantalla:
//   - un emoji junto a un texto se quita ("📋 Crear Solicitud" → "Crear Solicitud");
//   - un emoji solo (ícono suelto) se cambia por el ícono de línea equivalente
//     (js/iconos.js, copia del POS) o se quita si no hay equivalente.
// No se tocan campos de texto, facturas ni el chat del asistente (los datos
// del usuario quedan como están). Para excluir algo: data-keep-emoji.
//
// También pone los íconos pedidos con data-icono="nombre" (botones con ícono
// y texto: <button class="btn" data-icono="download">PDF</button>). Un ícono
// que queda pegado a un texto fuera de un contenedor flex recibe separación.

(function () {
  'use strict';

  const EMOJI = '(?:[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{21A9}\\u{21BA}\\u{21BB}\\u{2197}\\u{2198}\\u{2300}-\\u{23FF}\\u{25A0}-\\u{25FF}\\u{2139}](?:\\u{FE0F}|\\u{200D}[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}])*)';
  const HAS_EMOJI = new RegExp(EMOJI, 'u');
  const EMOJI_WITH_SPACE = new RegExp(`\\s*${EMOJI}\\s*`, 'gu');
  const ONLY_EMOJI = new RegExp(`^\\s*(${EMOJI})\\s*$`, 'u');

  const ICON = {
    '👁': 'eye', '🙈': 'eye-off', '✓': 'check', '✔': 'check', '✅': 'circle-check', '☑': 'square-check', 'ℹ': 'info',
    '✕': 'x', '✖': 'x', '❌': 'x', '✗': 'x', '⚠': 'triangle-alert', '⛔': 'circle-alert', '📛': 'circle-alert',
    '🚨': 'circle-alert', '🔍': 'search', '🔎': 'search',
    '🏪': 'store', '🏬': 'store', '🔗': 'link', '🔒': 'lock', '🔓': 'lock-open', '🔐': 'key-round', '🔑': 'key-round',
    '🖥': 'monitor', '🧾': 'receipt', '💵': 'banknote', '💸': 'banknote', '💰': 'wallet', '↺': 'rotate-ccw',
    '↻': 'refresh-cw', '🔄': 'refresh-cw', '🔁': 'repeat', '↩': 'undo-2', '📦': 'package', '📝': 'file-pen-line', '⚡': 'zap',
    '📊': 'chart-column', '📈': 'chart-line', '📉': 'chart-line', '📋': 'clipboard-list', '🏛': 'landmark',
    '🏦': 'landmark', '📄': 'file-text', '📃': 'file-text', '📑': 'files', '💾': 'save', '📕': 'book-open', '📚': 'book-open',
    '📒': 'book-open', '🏢': 'building-2', '🖨': 'printer', '👤': 'user', '👥': 'users', '🤝': 'users', '▾': 'chevron-down',
    '▼': 'chevron-down', '☁': 'cloud', '🌐': 'globe', '🔢': 'hash', '📤': 'send', '📨': 'send', '🗂': 'folder',
    '📁': 'folder', '📂': 'folder-open', '💱': 'arrow-left-right', '🗑': 'trash-2', '✏': 'pencil', '✎': 'pencil',
    '➕': 'plus', '➖': 'minus', '⚙': 'settings', '📅': 'calendar', '📆': 'calendar', '🗓': 'calendar', '🕒': 'clock',
    '⏱': 'clock', '⏳': 'clock', '⏰': 'alarm-clock', '📱': 'smartphone', '💬': 'message-circle', '🔔': 'bell',
    '🔌': 'plug', '⚖': 'scale', '🏷': 'tag', '📢': 'megaphone', '🖼': 'image', '🚀': 'rocket', '💳': 'credit-card',
    '🤖': 'bot', '🏆': 'trophy', '▶': 'play', '⬇': 'download', '⬆': 'upload', '📥': 'download', '↗': 'arrow-up-right',
    '↘': 'arrow-down-right', '🎨': 'palette', '🏠': 'house', '🛡': 'shield', '🚪': 'log-out', '🔧': 'wrench',
    '🛠': 'wrench', '📞': 'phone', '☎': 'phone', '📧': 'mail', '✉': 'mail', '📍': 'map-pin', '💼': 'briefcase-business',
    '☀': 'sun', '🌙': 'moon', '📎': 'file-text', '📷': 'image',
  };

  const SKIP = 'textarea, input, select, option, script, style, pre, code, svg, [contenteditable="true"], [data-keep-emoji], '
    + '.tcfac-root, #asis-mensajes';

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
        // Con texto al lado y sin flex (sin gap) el ícono quedaría pegado.
        if (parent.textContent.trim() && !/flex|grid/.test(getComputedStyle(parent).display)) {
          icon.classList.add('con-texto');
        }
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

  // <button data-icono="download">PDF</button> → ícono de línea delante del texto.
  function putIcon(el) {
    if (!window.TcIconos || !el.dataset.icono) return;
    if (el.firstElementChild && el.firstElementChild.classList.contains('tc-icono')) return;
    const holder = document.createElement('span');
    holder.innerHTML = window.TcIconos.svg(el.dataset.icono, Number(el.dataset.iconoTam) || 16, 'tc-icono');
    if (holder.firstElementChild) el.prepend(holder.firstElementChild);
  }

  function cleanTree(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) { cleanText(root); return; }
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    if (root.matches('[data-icono]')) putIcon(root);
    root.querySelectorAll('[data-icono]').forEach(putIcon);
    if (root.matches(SKIP) && !root.matches('input, textarea, select')) return;
    cleanAttrs(root);
    root.querySelectorAll('[title], [placeholder], [aria-label]').forEach(cleanAttrs);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    texts.forEach(cleanText);
  }

  function onMutations(records) {
    const pending = new Set();
    records.forEach((record) => {
      if (record.type === 'childList') record.addedNodes.forEach((node) => pending.add(node));
      else pending.add(record.target);
    });
    // En el mismo turno (antes de pintar): el emoji no llega a verse.
    pending.forEach((node) => { if (node.isConnected) cleanTree(node); });
  }

  function init() {
    cleanTree(document.body);
    new MutationObserver(onMutations).observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ATTRS,
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
