// ===== TECNO CAJA - MENÚ LATERAL Y BARRA SUPERIOR =====
//
// Solo interfaz (estilos en css/shell.css). Se conservan los .nav-item de
// index.html con sus onclick, data-module, data-deny-role y data-plan-required:
// permisos, plan y modo de negocio los siguen manejando applyRolePermissions(),
// showModule() y servicios.css. Aquí solo se agregan íconos, grupos, nombres
// cortos, "Más" (lo que no cabe en el menú angosto) y el menú del usuario, y se
// mantienen al día los estados de la barra superior.

(function () {
  'use strict';

  function icon(name, size = 20) {
    return window.TcIconos ? window.TcIconos.svg(name, size) : '';
  }

  // DB se declara con let en data.js: no es propiedad de window.
  function appDb() {
    return typeof DB !== 'undefined' ? DB : null;
  }

  // módulo: [ícono, nombre corto (menú angosto), grupo]
  const NAV = {
    ventas: ['shopping-cart', 'Ventas', 'operacion'],
    caja: ['banknote', 'Caja', 'operacion'],
    colacobro: ['list', 'Cola de cobro', 'operacion'],
    delivery: ['bike', 'Delivery', 'operacion'],
    posmovil: ['smartphone', 'POS Móvil', 'operacion'],
    productos: ['package', 'Productos', 'catalogo'],
    inventario: ['clipboard-list', 'Inventario', 'catalogo'],
    promociones: ['tag', 'Promociones', 'catalogo'],
    labels: ['scan-barcode', 'Etiquetas', 'catalogo'],
    clientes: ['users', 'Clientes', 'contactos'],
    proveedores: ['truck', 'Proveedores', 'contactos'],
    compras: ['receipt', 'Compras', 'administracion'],
    reportes: ['chart-column', 'Reportes', 'administracion'],
    rrhh: ['briefcase-business', 'RR. HH.', 'administracion'],
    usuarios: ['user-cog', 'Usuarios', 'administracion'],
    movimientos: ['history', 'Movimientos', 'administracion'],
    configuracion: ['settings', 'Configuración', 'sistema'],
    monedas: ['coins', 'Monedas', 'sistema'],
    wabot: ['bot', 'Bot WhatsApp', 'sistema'],
    // Modo Empresa de Servicios (js/servicios/servicios.js)
    'srv-facturas': ['file-text', 'Facturación', 'servicios'],
    'srv-cobros': ['hand-coins', 'Cobros', 'servicios'],
    'srv-cxc': ['receipt-text', 'Por cobrar', 'servicios'],
    'srv-cotizaciones': ['file-pen-line', 'Cotizaciones', 'servicios'],
    'srv-dashboard': ['layout-dashboard', 'Panel', 'servicios'],
    'srv-servicios': ['wrench', 'Servicios', 'servicios'],
    'srv-contratos': ['file-signature', 'Contratos', 'servicios'],
    'srv-proyectos': ['folder-kanban', 'Proyectos', 'servicios'],
    'srv-obras': ['hard-hat', 'Obras', 'servicios'],
    'srv-campanas': ['megaphone', 'Campañas', 'servicios'],
    'srv-ordenes': ['clipboard-check', 'Órdenes', 'servicios'],
    'srv-mantenimiento': ['cog', 'Equipos', 'servicios'],
    'srv-seguridad': ['shield', 'Seguridad', 'servicios'],
    'srv-reservaciones': ['plane', 'Reservas', 'servicios'],
    'srv-calendario': ['calendar', 'Calendario', 'servicios'],
    'srv-auditoria': ['search-check', 'Auditoría', 'servicios']
  };

  const GROUPS = [
    ['servicios', 'Servicios'],
    ['operacion', 'Operación'],
    ['catalogo', 'Catálogo'],
    ['contactos', 'Contactos'],
    ['administracion', 'Administración'],
    ['sistema', 'Sistema']
  ];

  const MODULE_ORDER = Object.keys(NAV);
  const groupIndex = (key) => Math.max(0, GROUPS.findIndex(([id]) => id === key));

  function navEl() { return document.getElementById('sidebar-nav'); }
  function sidebarEl() { return document.getElementById('sidebar'); }
  function navItems() { return Array.from(navEl()?.querySelectorAll(':scope > .nav-item') || []); }

  function confOf(item) {
    const module = item.dataset.module || '';
    return NAV[module] || ['layout-grid', item.querySelector('.nav-label')?.textContent?.trim() || module, 'sistema'];
  }

  function orderOf(item) {
    const module = item.dataset.module || '';
    const [, , group] = confOf(item);
    const index = MODULE_ORDER.indexOf(module);
    return groupIndex(group) * 100 + 1 + (index >= 0 ? index : 90);
  }

  function isShown(el) {
    return Boolean(el) && getComputedStyle(el).display !== 'none';
  }

  function labelOf(item) {
    return item.querySelector('.nav-label')?.textContent?.trim() || '';
  }

  // ── Íconos, nombres cortos, orden y títulos de grupo ────────────────────

  function decorateNav() {
    const nav = navEl();
    if (!nav) return;
    navItems().forEach((item) => {
      const [iconName, shortLabel] = confOf(item);
      const iconSlot = item.querySelector('.nav-icon');
      if (iconSlot && !iconSlot.querySelector('svg')) iconSlot.innerHTML = icon(iconName, 22);
      let short = item.querySelector('.nav-short');
      if (!short) {
        short = document.createElement('span');
        short.className = 'nav-short';
        item.querySelector('.nav-label')?.before(short);
      }
      if (short.textContent !== shortLabel) short.textContent = shortLabel;
      const order = String(orderOf(item));
      if (item.style.order !== order) item.style.order = order;
    });

    GROUPS.forEach(([id, title], index) => {
      if (nav.querySelector(`:scope > .nav-group-title[data-group="${id}"]`)) return;
      const heading = document.createElement('div');
      heading.className = 'nav-group-title';
      heading.dataset.group = id;
      heading.textContent = title;
      heading.style.order = String(index * 100);
      nav.appendChild(heading);
    });

    if (!document.getElementById('nav-more')) {
      const more = document.createElement('button');
      more.type = 'button';
      more.id = 'nav-more';
      more.className = 'nav-more hidden';
      more.setAttribute('aria-haspopup', 'true');
      more.setAttribute('aria-expanded', 'false');
      more.title = 'Más módulos';
      more.innerHTML = `<span class="nav-icon">${icon('layout-grid', 22)}</span><span class="nav-short">Más</span>`;
      more.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleMoreMenu();
      });
      nav.appendChild(more);
    }
  }

  // Orden visual (CSS order), no el del DOM: servicios.js inserta sus módulos
  // al principio de la lista.
  function visibleItemsInOrder() {
    return navItems()
      .map((item, domIndex) => ({ item, domIndex, order: Number(item.style.order || 0) }))
      .filter(({ item }) => {
        item.classList.remove('is-overflow');
        return isShown(item);
      })
      .sort((a, b) => (a.order - b.order) || (a.domIndex - b.domIndex))
      .map(({ item }) => item);
  }

  // ── Menú angosto: lo que no cabe va en "Más" ────────────────────────────

  let overflowItems = [];

  function layoutRail() {
    const nav = navEl();
    const sidebar = sidebarEl();
    const more = document.getElementById('nav-more');
    if (!nav || !sidebar || !more) return;

    const visible = visibleItemsInOrder();

    // Títulos de grupo sin módulos visibles no se muestran.
    nav.querySelectorAll(':scope > .nav-group-title').forEach((heading) => {
      const hasItems = visible.some((item) => confOf(item)[2] === heading.dataset.group);
      heading.classList.toggle('is-empty', !hasItems);
    });

    visible.forEach((item) => {
      const label = labelOf(item);
      if (label && item.title !== label) item.title = label;
    });

    overflowItems = [];
    more.classList.add('hidden');
    more.classList.remove('active');

    if (!sidebar.classList.contains('collapsed') || !visible.length) {
      closeMoreMenu();
      return;
    }

    const available = nav.clientHeight;
    const itemHeight = visible[0].offsetHeight || 60;
    const capacity = Math.max(1, Math.floor(available / itemHeight));
    if (visible.length <= capacity) {
      closeMoreMenu();
      return;
    }

    // Se deja un lugar para "Más"; el módulo activo siempre queda a la vista.
    let kept = visible.slice(0, capacity - 1);
    const active = visible.find((item) => item.classList.contains('active'));
    if (active && !kept.includes(active)) {
      kept = kept.slice(0, -1).concat(active);
    }
    overflowItems = visible.filter((item) => !kept.includes(item));
    overflowItems.forEach((item) => item.classList.add('is-overflow'));
    more.classList.remove('hidden');
    if (isMoreMenuOpen()) renderMoreMenu();
  }

  // ── Menús flotantes ("Más" y usuario) ───────────────────────────────────

  function ensurePopover(id, className) {
    let pop = document.getElementById(id);
    if (!pop) {
      pop = document.createElement('div');
      pop.id = id;
      pop.className = `tc-popover tc-shell-pop ${className} hidden`;
      sidebarEl()?.appendChild(pop);
    }
    return pop;
  }

  function placeBesideSidebar(pop, anchor, { alignBottom = false } = {}) {
    const sidebarRect = sidebarEl().getBoundingClientRect();
    pop.style.left = `${Math.round(sidebarRect.right + 8)}px`;
    pop.style.top = '';
    pop.style.bottom = '';
    if (alignBottom) {
      pop.style.bottom = '8px';
      return;
    }
    const anchorRect = anchor.getBoundingClientRect();
    const height = pop.offsetHeight;
    const top = Math.min(anchorRect.top, window.innerHeight - height - 8);
    pop.style.top = `${Math.max(8, Math.round(top))}px`;
  }

  function isMoreMenuOpen() {
    const pop = document.getElementById('nav-more-menu');
    return Boolean(pop && !pop.classList.contains('hidden'));
  }

  function renderMoreMenu() {
    const pop = ensurePopover('nav-more-menu', 'nav-more-menu');
    let lastGroup = '';
    pop.innerHTML = overflowItems.map((item) => {
      const [iconName, , group] = confOf(item);
      const heading = group !== lastGroup
        ? `<div class="nav-more-group">${(GROUPS.find(([id]) => id === group) || ['', ''])[1]}</div>`
        : '';
      lastGroup = group;
      const active = item.classList.contains('active') ? ' is-active' : '';
      return `${heading}<button type="button" class="nav-more-item${active}" data-module="${item.dataset.module}">${icon(iconName, 20)}<span>${labelOf(item)}</span></button>`;
    }).join('');
    pop.querySelectorAll('.nav-more-item').forEach((button) => {
      button.addEventListener('click', () => {
        const target = navEl()?.querySelector(`:scope > .nav-item[data-module="${button.dataset.module}"]`);
        closeMoreMenu();
        target?.click();
      });
    });
  }

  function toggleMoreMenu(force = null) {
    const more = document.getElementById('nav-more');
    const pop = ensurePopover('nav-more-menu', 'nav-more-menu');
    const show = force === null ? pop.classList.contains('hidden') : Boolean(force);
    if (show) {
      closeUserMenu();
      renderMoreMenu();
      pop.classList.remove('hidden');
      placeBesideSidebar(pop, more);
    } else {
      pop.classList.add('hidden');
    }
    more?.setAttribute('aria-expanded', show ? 'true' : 'false');
  }

  function closeMoreMenu() {
    if (isMoreMenuOpen()) toggleMoreMenu(false);
  }

  function toggleUserMenu(force = null) {
    const pop = document.getElementById('user-menu');
    const avatar = document.getElementById('user-avatar-btn');
    if (!pop) return;
    const show = force === null ? pop.classList.contains('hidden') : Boolean(force);
    pop.classList.add('tc-shell-pop');
    if (show) {
      closeMoreMenu();
      pop.classList.remove('hidden');
      placeBesideSidebar(pop, avatar, { alignBottom: true });
    } else {
      pop.classList.add('hidden');
    }
    avatar?.setAttribute('aria-expanded', show ? 'true' : 'false');
  }

  function closeUserMenu() {
    const pop = document.getElementById('user-menu');
    if (pop && !pop.classList.contains('hidden')) toggleUserMenu(false);
  }

  // Esc: primero se cierra lo que esté abierto (no cancela la venta).
  function closePopovers() {
    let closed = false;
    if (isMoreMenuOpen()) { closeMoreMenu(); closed = true; }
    const userMenu = document.getElementById('user-menu');
    if (userMenu && !userMenu.classList.contains('hidden')) { closeUserMenu(); closed = true; }
    const notif = document.getElementById('notif-panel');
    if (notif && !notif.classList.contains('hidden')) {
      if (typeof closeNotifications === 'function') closeNotifications();
      closed = true;
    }
    const sidebar = sidebarEl();
    if (sidebar && !sidebar.classList.contains('collapsed') && window.innerWidth > 800) {
      sidebar.classList.add('collapsed');
      closed = true;
    }
    return closed;
  }

  document.addEventListener('pointerdown', (event) => {
    const target = event.target;
    if (isMoreMenuOpen() && !target.closest('#nav-more-menu') && !target.closest('#nav-more')) closeMoreMenu();
    const userMenu = document.getElementById('user-menu');
    if (userMenu && !userMenu.classList.contains('hidden') && !target.closest('#user-menu') && !target.closest('#user-avatar-btn')) {
      closeUserMenu();
    }
  }, true);

  // ── Barra superior ──────────────────────────────────────────────────────

  function syncTheme() {
    const button = document.getElementById('topbar-theme-toggle');
    if (!button) return;
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    button.innerHTML = `${icon(light ? 'sun' : 'moon', 18)}<span>${light ? 'Día' : 'Noche'}</span>`;
    button.title = light ? 'Cambiar a modo noche' : 'Cambiar a modo día';
  }

  function syncCaja() {
    const el = document.getElementById('topbar-caja');
    const text = document.getElementById('topbar-caja-text');
    if (!el || !text) return;
    const open = Boolean(appDb()?.config?.cajaAbierta || appDb()?.caja?.abierta);
    el.dataset.state = open ? 'open' : 'closed';
    text.textContent = open ? 'Caja abierta' : 'Caja cerrada';
  }

  function syncBusiness() {
    const el = document.getElementById('topbar-business');
    if (!el) return;
    const name = String(appDb()?.config?.nombre || '').trim();
    el.textContent = name;
    el.title = name;
  }

  function syncStaticIcons() {
    const set = (selector, name, size) => {
      const el = document.querySelector(selector);
      if (el && !el.querySelector('svg')) el.innerHTML = icon(name, size);
    };
    set('.app .topbar .btn-menu', 'menu', 22);
    set('#sidebar .sidebar-close', 'menu', 22);
    set('#topbar-help', 'circle-help', 22);
    set('#topbar-whatsapp', 'message-circle', 22);
    set('.topbar-notif-icon', 'bell', 22);
  }

  function onModuleShown() {
    closeMoreMenu();
    closeUserMenu();
    syncBusiness();
    scheduleLayout();
  }

  // ── Recalcular el menú cuando cambian módulos, permisos o la ventana ────

  let layoutFrame = 0;
  let observer = null;

  function refreshNav() {
    decorateNav();
    layoutRail();
    // Los cambios propios (clases, orden) no deben volver a disparar el cálculo.
    observer?.takeRecords();
  }

  function scheduleLayout() {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      refreshNav();
    });
  }

  function init() {
    if (!navEl()) return;
    refreshNav();
    syncTheme();
    syncCaja();
    syncBusiness();
    syncStaticIcons();

    observer = new MutationObserver(scheduleLayout);
    observer.observe(navEl(), { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    observer.observe(sidebarEl(), { attributes: true, attributeFilter: ['class'] });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-app-mode'] });
    // El tema puede cambiar desde Configuración (cfg-theme) además del botón.
    new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.addEventListener('resize', () => {
      closeMoreMenu();
      closeUserMenu();
      scheduleLayout();
    });
  }

  window.TcShell = {
    refreshNav: scheduleLayout,
    toggleMoreMenu,
    toggleUserMenu,
    closePopovers,
    syncTheme,
    syncCaja,
    syncBusiness,
    onModuleShown
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
