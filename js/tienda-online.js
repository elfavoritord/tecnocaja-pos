/* ============================================================
   Tecno Caja — Tienda Online (módulo opcional)
   - Configuración en Configuración → Mi Negocio → Tienda online.
   - Módulo "Pedidos online": recibir, revisar, cambiar estado y
     cobrar el pedido con el flujo NORMAL de Ventas.
   - Pestaña "Tienda online" en la ficha del producto.
   Los datos del cliente vienen de Internet: TODO se escapa.
   ============================================================ */

/* global DB, showToast, showDeleteConfirm, showPromptModal, showModule, currentUserCan, getTecnoCajaAuthToken,
   buildSaleItem, buildQuickSaleItem, calcItemTotal, applyRecoveredSuspendedSale, cancelSale, refreshSaleClientOptions, io */

(function () {
  'use strict';

  const ESTADOS = {
    nuevo: 'Nuevo',
    confirmado: 'Confirmado',
    en_preparacion: 'En preparación',
    listo: 'Listo',
    en_camino: 'En camino',
    entregado: 'Entregado',
    cancelado: 'Cancelado',
    rechazado: 'Rechazado',
  };
  const FILTROS = [
    ['activos', 'Activos'],
    ['nuevo', 'Nuevos'],
    ['confirmado', 'Confirmados'],
    ['en_preparacion', 'En preparación'],
    ['listo', 'Listos'],
    ['en_camino', 'En camino'],
    ['entregado', 'Entregados'],
    ['cancelado', 'Cancelados'],
    ['rechazado', 'Rechazados'],
    ['', 'Todos'],
  ];
  const METODOS = {
    efectivo: 'Efectivo',
    transferencia: 'Transferencia bancaria',
    tarjeta: 'Tarjeta (al recibir)',
    contra_entrega: 'Pago contra entrega',
    otro: 'Otro método',
  };
  const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

  const TO = {
    activa: false,
    estado: null,
    config: null,
    resumen: null,
    filtro: 'activos',
    buscar: '',
    pedidos: [],
    seleccionado: null,
    detalle: null,
    tab: 'pedidos',
    notificados: new Set(),
    ultimoId: null,
    socket: null,
    productos: { page: 1, filtro: 'todos', buscar: '', categoria: '', data: null },
    busy: false,
  };

  // ── Utilidades ─────────────────────────────────────────────────────────

  function el(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(msg, type = 'success', ms) { if (typeof showToast === 'function') showToast(msg, type, ms); }
  function money(value, moneda) {
    const cur = moneda || (typeof DB !== 'undefined' && (DB.config?.moneda || DB.config?.currency)) || 'RD$';
    return `${cur} ${Number(value || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  function fecha(value) { return window.TcFecha ? window.TcFecha.formatear(value) : String(value || ''); }
  function digits(value) { return String(value || '').replace(/\D/g, ''); }
  function canConfigure() {
    return typeof currentUserCan === 'function' && (currentUserCan('*') || currentUserCan('tienda_online') || currentUserCan('gestionar_configuracion_global'));
  }
  function authHeaders() {
    let tok = '';
    if (typeof getTecnoCajaAuthToken === 'function') tok = getTecnoCajaAuthToken();
    else if (typeof DB !== 'undefined' && DB.authToken) tok = DB.authToken;
    return tok ? { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
  }
  async function api(method, path, body) {
    const res = await fetch(`/api/tienda-online${path}`, {
      method,
      headers: authHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error || `${res.status} ${res.statusText}`);
      error.code = data.code;
      error.status = res.status;
      error.avisos = data.avisos;
      error.por = data.por;
      throw error;
    }
    return data;
  }
  function isLoggedIn() { return typeof DB !== 'undefined' && Boolean(DB.currentUser); }

  // En la app de escritorio los enlaces se abren en el navegador del equipo.
  function abrir(url) {
    if (!/^https:\/\//i.test(String(url || ''))) return;
    if (window.novaDesktop?.openExternal) window.novaDesktop.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  }
  document.addEventListener('click', (ev) => {
    const link = ev.target.closest?.('a[data-to-ext]');
    if (!link) return;
    ev.preventDefault();
    abrir(link.getAttribute('href'));
  });
  function moduleVisible() { return el('module-tiendaonline')?.classList.contains('active'); }

  // ── Menú, contador y aviso de pedido nuevo ─────────────────────────────

  function syncNav() {
    const nav = el('nav-tienda-online');
    if (nav) nav.style.display = TO.activa ? '' : 'none';
    const badge = el('tienda-online-badge');
    const nuevos = Number(TO.resumen?.nuevos || 0);
    if (badge) {
      badge.textContent = nuevos > 0 ? String(nuevos) : '';
      badge.style.display = TO.activa && nuevos > 0 ? '' : 'none';
    }
    const origen = el('repv2-origen');
    if (origen) origen.classList.toggle('hidden', !TO.activa);
    window.TcShell?.refreshNav?.();
  }

  async function refreshResumen() {
    if (!isLoggedIn()) return;
    try {
      const r = await api('GET', '/pedidos/resumen');
      const anterior = TO.ultimoId;
      TO.activa = Boolean(r.activa);
      TO.resumen = r;
      TO.ultimoId = r.ultimoId;
      syncNav();
      // Respaldo del aviso en tiempo real (si el socket se perdió).
      if (anterior !== null && r.ultimoId > anterior && !TO.notificados.has(r.ultimoId)) {
        aviso({ id: r.ultimoId, numero: null, cliente: '', total: null });
      }
    } catch (_error) {
      // Sin sesión o servidor ocupado: se reintenta en el próximo ciclo.
    }
  }

  function beep() {
    try {
      if (localStorage.getItem('tc-tienda-sonido') === '0') return;
    } catch (_e) { /* sin almacenamiento: suena */ }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      [[880, 0], [1175, 0.18]].forEach(([freq, delay]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + delay + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.16);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + delay);
        osc.stop(ctx.currentTime + delay + 0.18);
      });
      setTimeout(() => ctx.close().catch(() => {}), 800);
    } catch (_e) { /* sin audio */ }
  }

  function aviso(p) {
    if (p.id) TO.notificados.add(Number(p.id));
    beep();
    let box = el('to-alert');
    if (!box) {
      box = document.createElement('div');
      box.id = 'to-alert';
      box.addEventListener('click', () => {
        box.remove();
        openModule(Number(box.dataset.id || 0) || null);
      });
      document.body.appendChild(box);
    }
    box.dataset.id = p.id || '';
    box.innerHTML = `
      <div style="font-size:22px;line-height:1">🛒</div>
      <div>
        <strong>Nuevo pedido online${p.numero ? ` #${esc(p.numero)}` : ''}</strong>
        ${p.cliente ? `<small>${esc(p.cliente)}${p.total !== null && p.total !== undefined ? ` · ${esc(money(p.total, p.moneda))}` : ''}</small>` : ''}
        <small>Toca para revisarlo</small>
      </div>`;
    clearTimeout(box._timer);
    box._timer = setTimeout(() => box.remove(), 20000);
  }

  function initSocket() {
    if (TO.socket || typeof io === 'undefined') return;
    try {
      TO.socket = io();
      TO.socket.on('tienda-online:nuevo-pedido', (p) => {
        if (!p || TO.notificados.has(Number(p.id))) return;
        aviso(p);
        refreshResumen();
        if (moduleVisible()) loadPedidos();
      });
      TO.socket.on('tienda-online:cambio', (p) => {
        refreshResumen();
        if (moduleVisible()) {
          loadPedidos();
          if (TO.seleccionado && p?.id && Number(p.id) === Number(TO.seleccionado)) loadDetalle(TO.seleccionado);
        }
      });
      // Cliente creado por un pedido online: DB.clientes se cachea al entrar, hay que empujarlo.
      TO.socket.on('tienda-online:cliente', (data) => {
        const c = data?.client;
        if (!c?.id || typeof DB === 'undefined') return;
        const lista = DB.clientes || (DB.clientes = []);
        const i = lista.findIndex((x) => x.id === c.id);
        if (i >= 0) lista[i] = { ...lista[i], ...c };
        else lista.unshift(c);
        if (typeof refreshSaleClientOptions === 'function') refreshSaleClientOptions();
        if (typeof window.loadClientesTable === 'function') window.loadClientesTable(document.getElementById('clientes-search')?.value || '');
      });
    } catch (_e) { TO.socket = null; }
  }

  function openModule(orderId = null) {
    const nav = el('nav-tienda-online');
    if (typeof showModule === 'function') showModule('tiendaonline', nav);
    if (orderId) {
      TO.seleccionado = orderId;
      TO.filtro = '';
      loadPedidos().then(() => loadDetalle(orderId));
    }
  }

  // ── Módulo: estado, pestañas y lista ────────────────────────────────────

  async function loadEstado() {
    try {
      TO.estado = await api('GET', '/estado');
      TO.activa = Boolean(TO.estado.activa);
      syncNav();
      renderStatusBar();
    } catch (error) {
      const bar = el('to-status-bar');
      if (bar) bar.textContent = error.message;
    }
  }

  function renderStatusBar() {
    const bar = el('to-status-bar');
    const s = TO.estado;
    if (!bar || !s) return;
    const pub = s.publicacion || {};
    const ped = s.pedidos || {};
    const problemas = [];
    if (!s.licencia) problemas.push('Este equipo no tiene licencia vinculada.');
    if (!s.firebase) problemas.push('Firebase no está configurado en este equipo.');
    if (pub.ultimoError && !problemas.includes(pub.ultimoError)) problemas.push(pub.ultimoError);
    if (ped.ultimoError && !problemas.includes(ped.ultimoError)) problemas.push(ped.ultimoError);
    const ok = s.activa && !problemas.length;
    const sinInternet = s.internet === false;
    bar.innerHTML = `
      <span><span class="to-dot ${!s.activa ? '' : sinInternet ? 'warn' : ok ? 'ok' : 'err'}"></span>
        ${!s.activa ? 'Tienda desactivada' : sinInternet ? 'Sin Internet: los pedidos llegarán al volver la conexión' : ok ? 'Tienda en línea' : 'Revisar tienda'}</span>
      ${s.url ? `<span>Tienda: <a href="${esc(s.url)}" data-to-ext="1">${esc(s.url)}</a></span>` : ''}
      ${s.principal ? '' : '<span>Esta caja ve los pedidos de la PC principal.</span>'}
      ${pub.ultimaPublicacion ? `<span>Catálogo: ${esc(fecha(pub.ultimaPublicacion))} · ${Number(pub.productosPublicados || 0)} productos</span>` : ''}
      ${s.resumen?.sinSincronizar ? `<span>${s.resumen.sinSincronizar} cambio(s) por subir</span>` : ''}
      ${problemas.length ? `<span style="color:var(--danger)">${problemas.map(esc).join(' · ')}</span>` : ''}
    `;
    el('to-btn-config')?.classList.toggle('hidden', !canConfigure());
    el('to-tab-btn-productos')?.classList.toggle('hidden', !canConfigure());
  }

  function switchTab(tab) {
    TO.tab = tab;
    document.querySelectorAll('[data-to-tab]').forEach((b) => b.classList.toggle('active', b.dataset.toTab === tab));
    ['pedidos', 'productos', 'reportes'].forEach((t) => el(`to-pane-${t}`)?.classList.toggle('hidden', t !== tab));
    if (tab === 'pedidos') loadPedidos();
    if (tab === 'productos') loadProductos();
    if (tab === 'reportes') renderReportes();
  }

  function renderFilters() {
    const box = el('to-filters');
    if (!box) return;
    const porEstado = TO.resumen?.porEstado || {};
    box.innerHTML = FILTROS.map(([value, label]) => {
      const count = value === 'activos' ? TO.resumen?.activos : porEstado[value];
      return `<button type="button" class="pill-tab ${TO.filtro === value ? 'active' : ''}" onclick="TiendaOnline.setFilter('${value}')">${esc(label)}${count ? `<span class="to-count">${Number(count)}</span>` : ''}</button>`;
    }).join('');
  }

  async function loadPedidos() {
    const params = new URLSearchParams();
    if (TO.filtro) params.set('estado', TO.filtro);
    if (TO.buscar) params.set('buscar', TO.buscar);
    params.set('limit', '100');
    try {
      const data = await api('GET', `/pedidos?${params}`);
      TO.pedidos = data.pedidos || [];
      renderFilters();
      renderList();
    } catch (error) {
      const list = el('to-list');
      if (list) list.innerHTML = `<div class="to-detail-empty">${esc(error.message)}</div>`;
    }
  }

  function renderList() {
    const list = el('to-list');
    if (!list) return;
    if (!TO.pedidos.length) {
      list.innerHTML = '<div class="to-detail-empty">No hay pedidos en esta vista.</div>';
      return;
    }
    list.innerHTML = TO.pedidos.map((p) => `
      <button type="button" class="to-card ${p.estado === 'nuevo' ? 'is-new' : ''} ${Number(TO.seleccionado) === p.id ? 'active' : ''}" onclick="TiendaOnline.select(${p.id})">
        <span class="to-card-title">#${esc(p.numero)} · ${esc(p.cliente.nombre)}</span>
        <span class="to-card-total">${esc(money(p.totales.total, p.moneda))}</span>
        <span class="to-card-meta">
          <span class="to-badge st-${esc(p.estado)}">${esc(ESTADOS[p.estado] || p.estado)}</span>
          ${p.venta ? `<span class="to-badge venta">${esc(p.venta.factura)}</span>` : ''}
          <span>${p.entrega.tipo === 'delivery' ? '🛵 Delivery' : '🏪 Retiro'}</span>
          <span>${Number(p.articulos || 0)} producto(s)</span>
          <span>${esc(fecha(p.recibidoEn))}</span>
          ${p.enProceso && !p.venta ? `<span>⏳ ${esc(p.enProceso.por)} lo está cobrando</span>` : ''}
        </span>
      </button>`).join('');
  }

  async function select(id) {
    TO.seleccionado = id;
    renderList();
    await loadDetalle(id);
  }

  async function loadDetalle(id) {
    const box = el('to-detail');
    if (!box) return;
    try {
      const branchId = Number(DB?.config?.activeBranchId || 0) || '';
      TO.detalle = await api('GET', `/pedidos/${id}?branchId=${branchId}`);
      renderDetalle();
    } catch (error) {
      box.innerHTML = `<div class="to-detail-empty">${esc(error.message)}</div>`;
    }
  }

  function accionesPara(p) {
    const b = [];
    const conVenta = Boolean(p.venta);
    const convertible = ['nuevo', 'confirmado', 'en_preparacion', 'listo'].includes(p.estado) && !conVenta;
    if (p.estado === 'nuevo') b.push(['primary', 'Aceptar pedido', `TiendaOnline.setEstado(${p.id}, 'confirmado')`]);
    if (convertible) b.push(['primary', 'Convertir en venta', `TiendaOnline.convertir(${p.id})`]);
    if (['confirmado'].includes(p.estado)) b.push(['secondary', 'En preparación', `TiendaOnline.setEstado(${p.id}, 'en_preparacion')`]);
    if (['confirmado', 'en_preparacion'].includes(p.estado)) b.push(['secondary', 'Marcar listo', `TiendaOnline.setEstado(${p.id}, 'listo')`]);
    if (conVenta && p.entrega.tipo === 'delivery' && ['confirmado', 'en_preparacion', 'listo'].includes(p.estado)) {
      b.push(['secondary', 'En camino', `TiendaOnline.setEstado(${p.id}, 'en_camino')`]);
    }
    if (conVenta && ['confirmado', 'en_preparacion', 'listo', 'en_camino'].includes(p.estado)) {
      b.push(['secondary', 'Entregado', `TiendaOnline.setEstado(${p.id}, 'entregado')`]);
    }
    if (p.estado === 'nuevo') b.push(['danger', 'Rechazar', `TiendaOnline.setEstado(${p.id}, 'rechazado')`]);
    if (!conVenta && ['confirmado', 'en_preparacion', 'listo', 'en_camino'].includes(p.estado)) {
      b.push(['danger', 'Cancelar pedido', `TiendaOnline.setEstado(${p.id}, 'cancelado')`]);
    }
    const tel = digits(p.cliente.whatsapp || p.cliente.telefono);
    if (tel.length >= 10) {
      const wa = tel.length === 10 ? `1${tel}` : tel;
      b.push(['secondary', 'Escribir por WhatsApp', `TiendaOnline.abrir('https://wa.me/${wa}')`]);
    }
    b.push(['secondary', 'Imprimir pedido', `TiendaOnline.imprimir(${p.id})`]);
    return b;
  }

  function renderDetalle() {
    const box = el('to-detail');
    const p = TO.detalle;
    if (!box || !p) return;
    const m = p.moneda;
    const rev = p.revision || [];
    const entrega = p.entrega;
    const direccion = [entrega.direccion, entrega.sector, entrega.municipio, entrega.provincia].filter(Boolean).join(', ');
    const enProceso = p.enProceso && !p.venta ? `<div class="to-note aviso">⏳ ${esc(p.enProceso.por)} está cobrando este pedido.</div>` : '';
    const conItbis = p.items.some((it) => Number(it.itbis || 0) > 0);
    box.innerHTML = `
      <div class="to-detail-inner">
      <div class="to-detail-head">
        <h3>Pedido #${esc(p.numero)}</h3>
        <div class="to-detail-badges">
          <span class="to-badge st-${esc(p.estado)}">${esc(ESTADOS[p.estado] || p.estado)}</span>
          ${p.venta ? `<span class="to-badge venta">Venta ${esc(p.venta.factura)}${p.venta.ncf ? ` · ${esc(p.venta.ncf)}` : ''}</span>` : ''}
          ${p.sincronizado ? '' : '<span class="to-badge">Pendiente de subir</span>'}
        </div>
      </div>
      ${enProceso}
      ${p.motivoCancelacion ? `<div class="to-note error">Motivo: ${esc(p.motivoCancelacion)}</div>` : ''}
      <div class="to-grid2">
        <div class="to-box">
          <h4>Cliente</h4>
          <p><strong>${esc(p.cliente.nombre)}</strong></p>
          ${p.cliente.telefono ? `<p>Tel: ${esc(p.cliente.telefono)}</p>` : ''}
          ${p.cliente.whatsapp && p.cliente.whatsapp !== p.cliente.telefono ? `<p>WhatsApp: ${esc(p.cliente.whatsapp)}</p>` : ''}
          ${p.cliente.email ? `<p>${esc(p.cliente.email)}</p>` : ''}
          ${p.cliente.clientId ? '<p class="to-ok">✓ Guardado en Clientes</p>' : ''}
        </div>
        <div class="to-box">
          <h4>Entrega</h4>
          <p><strong>${entrega.tipo === 'delivery' ? 'Delivery' : 'Retiro en tienda'}</strong>${entrega.zona ? ` · ${esc(entrega.zona)}` : ''}</p>
          ${direccion ? `<p>${esc(direccion)}</p>` : ''}
          ${entrega.referencia ? `<p>Ref.: ${esc(entrega.referencia)}</p>` : ''}
          ${p.venta?.repartidor ? `<p>Repartidor: ${esc(p.venta.repartidor)}</p>` : ''}
          ${p.despachadoEn ? `<p>Salió: ${esc(fecha(p.despachadoEn))}</p>` : ''}
          ${p.entregadoEn ? `<p>Entregado: ${esc(fecha(p.entregadoEn))}</p>` : ''}
        </div>
        <div class="to-box">
          <h4>Pago y comprobante</h4>
          <p>${esc(p.pago.etiqueta || METODOS[p.pago.metodo] || p.pago.metodo || '—')}</p>
          ${p.comprobante.solicitado ? `<p>Pide comprobante fiscal: ${esc(p.comprobante.razonSocial || '')} ${p.comprobante.rnc ? `(RNC ${esc(p.comprobante.rnc)})` : ''}</p>` : '<p>Consumidor final</p>'}
          <p class="to-muted">Recibido ${esc(fecha(p.recibidoEn))}</p>
        </div>
      </div>
      ${p.notas ? `<div class="to-note info"><strong>Nota del cliente:</strong> ${esc(p.notas)}</div>` : ''}
      <table class="to-items to-items-pedido">
        <colgroup><col><col class="c-cant"><col class="c-monto">${conItbis ? '<col class="c-monto">' : ''}<col class="c-monto"></colgroup>
        <thead><tr><th>Producto</th><th class="cen">Cant.</th><th class="num">Precio</th>${conItbis ? '<th class="num">ITBIS</th>' : ''}<th class="num">Total</th></tr></thead>
        <tbody>
          ${p.items.map((it, i) => {
            const r = rev[i] || {};
            const notas = [];
            if (!p.venta && !['entregado', 'cancelado', 'rechazado'].includes(p.estado)) {
              if (!r.existe) notas.push('<span class="to-err">Ya no existe en el POS</span>');
              else if (!r.activo) notas.push('<span class="to-err">Inactivo en el POS</span>');
              else if (r.controlaStock && !r.suficiente) notas.push(`<span class="to-warn">Hay ${esc(r.existencia)} en la sucursal</span>`);
              if (r.existe && r.precioActual !== null && Math.abs(r.precioActual - (it.precioOriginal ?? it.precioUnitario)) > 0.009) {
                notas.push(`<span class="to-warn">Precio hoy: ${esc(money(r.precioActual, m))}</span>`);
              }
            }
            return `<tr>
              <td>${esc(it.nombre)}${it.promocionNombre ? ` <span class="to-muted">· ${esc(it.promocionNombre)}</span>` : ''}${notas.length ? `<br>${notas.join(' · ')}` : ''}</td>
              <td class="cen">${esc(it.cantidad)}${it.modoVenta !== 'unidad' ? ` ${esc(it.unidad)}` : ''}</td>
              <td class="num">${esc(money(it.precioUnitario, m))}${it.precioOriginal && it.precioOriginal > it.precioUnitario ? `<br><s class="to-muted">${esc(money(it.precioOriginal, m))}</s>` : ''}</td>
              ${conItbis ? `<td class="num">${Number(it.itbis || 0) > 0 ? esc(money(it.itbis, m)) : '<span class="to-muted">—</span>'}</td>` : ''}
              <td class="num"><strong>${esc(money(it.total, m))}</strong></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      <div class="to-totals">
        <span>Subtotal</span><span>${esc(money(p.totales.subtotal, m))}</span>
        ${p.totales.descuento ? `<span>Descuento</span><span>− ${esc(money(p.totales.descuento, m))}</span>` : ''}
        ${p.totales.itbis ? `<span>ITBIS</span><span>${esc(money(p.totales.itbis, m))}</span>` : ''}
        ${p.totales.delivery ? `<span>Delivery</span><span>${esc(money(p.totales.delivery + p.totales.deliveryItbis, m))}</span>` : ''}
        ${p.totales.ahorroPromociones ? `<span class="to-muted">Ahorro en promociones</span><span class="to-muted">${esc(money(p.totales.ahorroPromociones, m))}</span>` : ''}
        <span class="grand">Total</span><span class="grand">${esc(money(p.totales.total, m))}</span>
      </div>
      <div class="to-actions">
        ${accionesPara(p).map(([kind, label, action]) => `<button type="button" class="btn-${kind}" onclick="${action}">${esc(label)}</button>`).join('')}
      </div>
      <h4 class="to-history-title">Historial</h4>
      <ul class="to-history">
        ${(p.historial || []).map((h) => `<li><strong>${esc(h.hacia ? (ESTADOS[h.hacia] || h.hacia) : h.tipo === 'venta' ? 'Venta' : h.tipo === 'cliente' ? 'Cliente' : 'Nota')}</strong> · ${esc(fecha(h.fecha))}${h.usuario ? ` · ${esc(h.usuario)}` : ''}${h.detalle ? `<br>${esc(h.detalle)}` : ''}</li>`).join('')}
      </ul>
      </div>`;
  }

  async function setEstado(id, estado) {
    let motivo = '';
    if (estado === 'rechazado' || estado === 'cancelado') {
      const texto = typeof showPromptModal === 'function'
        ? await showPromptModal(`Motivo para ${estado === 'rechazado' ? 'rechazar' : 'cancelar'} el pedido (lo verá el cliente):`, { confirmText: estado === 'rechazado' ? 'Rechazar' : 'Cancelar pedido', cancelText: 'Volver' })
        : '';
      if (texto === null) return;
      motivo = String(texto || '').trim();
    }
    try {
      await api('POST', `/pedidos/${id}/estado`, { estado, motivo });
      toast(`Pedido marcado como ${ESTADOS[estado]}.`, 'success');
      await Promise.all([loadPedidos(), loadDetalle(id), refreshResumen()]);
    } catch (error) {
      toast(error.message, error.status === 409 ? 'warning' : 'error', 7000);
      loadDetalle(id);
    }
  }

  // ── Convertir en venta: el pedido entra al carrito de Ventas ────────────

  async function convertir(id, forzar = false) {
    if (TO.busy) return;
    if (window.offlineManager?.getState?.()?.isOnline === false) {
      toast('Los pedidos online se cobran con la PC principal conectada.', 'warning');
      return;
    }
    if (typeof buildSaleItem !== 'function' || typeof applyRecoveredSuspendedSale !== 'function') {
      toast('El módulo de Ventas no está disponible.', 'error');
      return;
    }
    TO.busy = true;
    try {
      const actual = typeof window.getActiveOnlineOrder === 'function' ? window.getActiveOnlineOrder() : null;
      if (DB.saleItems?.length && !(actual && actual.id === id)) {
        const ok = await showDeleteConfirm('Hay una venta en pantalla. Si cargas este pedido, la venta actual se reemplazará.', { confirmText: 'Cargar pedido' });
        if (!ok) return;
      }
      let draft;
      try {
        draft = await api('POST', `/pedidos/${id}/preparar-venta`, {
          branchId: Number(DB.config?.activeBranchId || 0) || null,
          forzar,
        });
      } catch (error) {
        if (error.code === 'EN_PROCESO') {
          const ok = await showDeleteConfirm(`${esc(error.por || 'Otra caja')} está cobrando este pedido ahora mismo. ¿Cargarlo aquí de todas formas? Solo una caja podrá cobrarlo.`, { confirmText: 'Cargar aquí' });
          if (ok) {
            TO.busy = false;
            return convertir(id, true);
          }
          return;
        }
        if (error.avisos?.length) mostrarAvisos(error.avisos, error.message);
        else toast(error.message, 'warning', 8000);
        loadDetalle(id);
        return;
      }
      cargarEnCarrito(draft);
    } finally {
      TO.busy = false;
    }
  }

  function cargarEnCarrito(draft) {
    if (draft.cliente?.id && Array.isArray(DB.clientes) && !DB.clientes.some((c) => c.id === draft.cliente.id)) {
      DB.clientes.push(draft.cliente);
      if (typeof refreshSaleClientOptions === 'function') refreshSaleClientOptions();
    }
    const items = [];
    const omitidos = [];
    for (const it of draft.items) {
      const prod = (DB.productos || []).find((p) => Number(p.id) === Number(it.productoId));
      if (!prod) { omitidos.push(it.nombre); continue; }
      const item = buildSaleItem(prod, Number(it.cantidad));
      if (it.precioPactado !== null && it.precioPactado !== undefined) {
        item.precio = Number(it.precioPactado);
        item.precioPactado = Number(it.precioPactado);
        const original = Number(it.precioOriginal || 0);
        item.promoAplicada = original > item.precio ? {
          promotionId: it.promocionId || null,
          nombre: it.promocionNombre || 'Precio del pedido online',
          precioOriginal: original,
          ahorro: Number((original - item.precio).toFixed(2)),
          texto: 'Pedido online',
          color: '',
          cantidadMinima: null,
        } : null;
        item.total = typeof calcItemTotal === 'function' ? calcItemTotal(item) : item.precio * item.qty;
      }
      items.push(item);
    }
    if (draft.delivery && typeof buildQuickSaleItem === 'function') {
      items.push(buildQuickSaleItem({
        nombre: draft.delivery.nombre,
        precio: Number(draft.delivery.costo),
        qty: 1,
        aplicaItbis: Boolean(draft.delivery.aplicaItbis),
      }));
    }
    if (!items.length) {
      toast('Ningún producto del pedido está en el catálogo de esta caja.', 'error');
      return;
    }
    if (typeof cancelSale === 'function') cancelSale();
    applyRecoveredSuspendedSale({
      items,
      clientId: draft.cliente?.id || null,
      documentType: DB.saleDocumentType || 'ticket',
      payMethod: draft.metodoPago || 'efectivo',
      deliveryUserId: null,
      orderType: draft.tipoPedido || 'recoger',
      kitchenStatus: 'pendiente',
      generalDiscount: 0,
      tableLabel: '',
      deliveryPhone: draft.telefono || '',
      deliveryAddress: draft.direccion || '',
      deliveryReference: draft.referencia || '',
      deliveryLink: '',
      deliveryPayAmount: draft.metodoPago === 'contra_entrega' ? Number(draft.totalPedido || 0) : 0,
      orderNotes: draft.notas || '',
      onlineOrder: draft.pedido,
    });
    if (draft.ncfType) {
      DB.saleNcfType = draft.ncfType;
      DB.saleRncCliente = draft.rnc || '';
      DB.saleRazonSocial = draft.razonSocial || '';
    }
    // El cobro conserva cliente, entrega, método y comprobante del pedido.
    window.CobroUI?.markResume?.();
    if (typeof showModule === 'function') {
      showModule('ventas', document.querySelector('.nav-item[data-module="ventas"]'));
    }
    const avisos = [...(draft.avisos || [])];
    if (omitidos.length) avisos.push({ tipo: 'error', texto: `No están en el catálogo de esta caja: ${omitidos.join(', ')}` });
    if (draft.tipoPedido === 'delivery') avisos.push({ tipo: 'info', texto: 'Asigna el repartidor en el cobro (paso Delivery).' });
    if (avisos.some((a) => a.tipo !== 'info')) mostrarAvisos(avisos, `Pedido #${draft.pedido.numero} cargado en Ventas`);
    else toast(`Pedido #${draft.pedido.numero} cargado. Revisa y cobra como cualquier venta.`, 'success', 6000);
  }

  function mostrarAvisos(avisos, titulo) {
    modal({
      titulo: titulo || 'Revisa el pedido',
      cuerpo: avisos.map((a) => `<div class="to-note ${a.tipo === 'error' ? 'error' : a.tipo === 'aviso' ? 'aviso' : 'info'}">${esc(a.texto)}</div>`).join(''),
      botones: [['primary', 'Entendido', (close) => close()]],
    });
  }

  function onCartCleared(orderId) {
    if (!orderId) return;
    api('POST', `/pedidos/${orderId}/liberar`, {}).catch(() => {});
  }

  function onSaleCompleted(orderId, venta) {
    toast(`Pedido online cobrado: ${venta?.id || venta?.invoiceNumber || ''}`, 'success', 5000);
    refreshResumen();
    if (moduleVisible()) loadPedidos();
  }

  // ── Imprimir el pedido (preparación / despacho) ─────────────────────────

  function imprimir(id) {
    const p = TO.detalle && TO.detalle.id === id ? TO.detalle : null;
    if (!p) return;
    const w = window.open('', '_blank', 'width=420,height=640');
    if (!w) { toast('No se pudo abrir la ventana de impresión.', 'error'); return; }
    const entrega = p.entrega;
    const direccion = [entrega.direccion, entrega.sector, entrega.municipio, entrega.provincia].filter(Boolean).join(', ');
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Pedido #${esc(p.numero)}</title>
      <style>body{font-family:Arial,sans-serif;font-size:13px;margin:12px;width:280px}h2{margin:0 0 6px;font-size:18px}
      table{width:100%;border-collapse:collapse}td{padding:3px 0;border-bottom:1px dashed #999;vertical-align:top}
      .r{text-align:right}.b{font-weight:bold}</style></head><body>
      <h2>Pedido online #${esc(p.numero)}</h2>
      <div>${esc(fecha(p.recibidoEn))}</div>
      <div class="b">${esc(p.cliente.nombre)} · ${esc(p.cliente.telefono || '')}</div>
      <div>${entrega.tipo === 'delivery' ? 'DELIVERY' : 'RETIRO EN TIENDA'}${entrega.zona ? ` · ${esc(entrega.zona)}` : ''}</div>
      ${direccion ? `<div>${esc(direccion)}</div>` : ''}${entrega.referencia ? `<div>Ref.: ${esc(entrega.referencia)}</div>` : ''}
      <div>Pago: ${esc(p.pago.etiqueta || p.pago.metodo || '')}</div>
      ${p.notas ? `<div>Nota: ${esc(p.notas)}</div>` : ''}
      <table>${p.items.map((it) => `<tr><td>${esc(it.cantidad)} × ${esc(it.nombre)}</td><td class="r">${esc(money(it.total, p.moneda))}</td></tr>`).join('')}</table>
      <div class="r b" style="margin-top:6px">Total: ${esc(money(p.totales.total, p.moneda))}</div>
      <script>window.onload=function(){window.print();setTimeout(function(){window.close()},300)}</script>
      </body></html>`);
    w.document.close();
  }

  // ── Productos publicados ────────────────────────────────────────────────

  async function loadProductos() {
    const pane = el('to-pane-productos');
    if (!pane) return;
    if (!canConfigure()) {
      pane.innerHTML = '<div class="to-detail-empty">Solo el administrador puede publicar productos.</div>';
      return;
    }
    const s = TO.productos;
    const params = new URLSearchParams({ page: String(s.page), filtro: s.filtro, limit: '60' });
    if (s.buscar) params.set('buscar', s.buscar);
    if (s.categoria) params.set('categoria', s.categoria);
    try {
      s.data = await api('GET', `/productos?${params}`);
      renderProductos();
    } catch (error) {
      pane.innerHTML = `<div class="to-detail-empty">${esc(error.message)}</div>`;
    }
  }

  function renderProductos() {
    const pane = el('to-pane-productos');
    const s = TO.productos;
    const d = s.data;
    if (!pane || !d) return;
    const categorias = [...new Set((DB.productos || []).map((p) => p.categoria).filter(Boolean))].sort();
    const paginas = Math.max(1, Math.ceil(d.total / d.limit));
    pane.innerHTML = `
      <div class="to-products-tools">
        <input type="text" class="mod-search" placeholder="Buscar producto…" value="${esc(s.buscar)}" onchange="TiendaOnline.productosFiltro('buscar', this.value)">
        <select class="mod-select" onchange="TiendaOnline.productosFiltro('filtro', this.value)">
          ${[['todos', 'Todos'], ['publicados', 'Publicados'], ['no_publicados', 'Sin publicar'], ['destacados', 'Destacados']]
            .map(([v, l]) => `<option value="${v}" ${s.filtro === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <select class="mod-select" onchange="TiendaOnline.productosFiltro('categoria', this.value)">
          <option value="">Todas las categorías</option>
          ${categorias.map((c) => `<option value="${esc(c)}" ${s.categoria === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
        ${s.categoria ? `<button class="btn-secondary" type="button" onclick="TiendaOnline.masivo('publicar')">Publicar toda la categoría</button>
          <button class="btn-secondary" type="button" onclick="TiendaOnline.masivo('ocultar')">Ocultar toda la categoría</button>` : ''}
        <span class="to-muted">${Number(d.publicados)} publicado(s) en la tienda</span>
      </div>
      <div class="table-wrap tc-list-panel">
        <table class="data-table to-products-table">
          <thead><tr><th>Publicar</th><th>Producto</th><th>Fotos</th><th>Precio</th><th>Existencia</th><th>Destacado</th><th>Orden</th><th>Existencia en tienda</th><th>Descripción para la tienda</th></tr></thead>
          <tbody>
            ${d.productos.map((p) => `<tr>
              <td><input type="checkbox" ${p.publicado ? 'checked' : ''} ${p.activo ? '' : 'disabled title="Producto inactivo"'} onchange="TiendaOnline.productoCampo(${p.id}, 'publicado', this.checked)"></td>
              <td><strong>${esc(p.nombre)}</strong><br><span class="to-muted">${esc(p.codigo)} · ${esc(p.categoria)}${p.activo ? '' : ' · Inactivo'}${p.tieneImagen ? '' : ' · sin foto'}</span></td>
              <td><button type="button" class="btn-secondary to-fotos-btn" title="Subir y ordenar las fotos de este producto en la tienda" onclick="TiendaOnline.fotosDialogo(${p.id})">📷 ${(p.tieneImagen ? 1 : 0) + Number(p.fotosExtra || 0)}/6</button></td>
              <td>${esc(money(p.precio))}</td>
              <td>${p.controlaStock ? esc(p.stock) : 'No controla'}</td>
              <td><input type="checkbox" ${p.destacado ? 'checked' : ''} onchange="TiendaOnline.productoCampo(${p.id}, 'destacado', this.checked)"></td>
              <td><input type="number" class="form-input" style="width:80px" value="${esc(p.orden)}" onchange="TiendaOnline.productoCampo(${p.id}, 'orden', this.value)"></td>
              <td><select class="form-input" onchange="TiendaOnline.productoCampo(${p.id}, 'modoExistencia', this.value)">
                <option value="inventario" ${p.modoExistencia === 'inventario' ? 'selected' : ''}>Según inventario</option>
                <option value="ilimitado" ${p.modoExistencia === 'ilimitado' ? 'selected' : ''}>Siempre disponible</option>
              </select></td>
              <td><input type="text" class="form-input" maxlength="500" value="${esc(p.descripcion)}" placeholder="Opcional" onchange="TiendaOnline.productoCampo(${p.id}, 'descripcion', this.value)"></td>
            </tr>`).join('') || '<tr><td colspan="9" class="to-muted" style="text-align:center;padding:1.5rem">Sin productos.</td></tr>'}
          </tbody>
        </table>
      </div>
      <div class="to-products-tools" style="margin-top:10px">
        <button class="btn-secondary" type="button" ${s.page <= 1 ? 'disabled' : ''} onclick="TiendaOnline.productosPagina(-1)">Anterior</button>
        <span class="to-muted">Página ${s.page} de ${paginas} · ${Number(d.total)} producto(s)</span>
        <button class="btn-secondary" type="button" ${s.page >= paginas ? 'disabled' : ''} onclick="TiendaOnline.productosPagina(1)">Siguiente</button>
      </div>`;
  }

  async function productoCampo(id, campo, valor) {
    try {
      await api('PUT', `/productos/${id}`, { [campo]: valor });
      const prod = (DB.productos || []).find((p) => p.id === id);
      if (prod) prod.online = { ...(prod.online || {}), [campo]: valor };
      if (campo === 'publicado') {
        toast(valor ? 'Producto publicado en la tienda.' : 'Producto quitado de la tienda.', 'success');
        loadProductos();
      }
    } catch (error) {
      toast(error.message, 'error');
      loadProductos();
    }
  }

  async function masivo(accion) {
    const s = TO.productos;
    if (!s.categoria) return;
    const ok = await showDeleteConfirm(`${accion === 'publicar' ? 'Publicar' : 'Ocultar'} todos los productos activos de <strong>${esc(s.categoria)}</strong>?`, { confirmText: accion === 'publicar' ? 'Publicar' : 'Ocultar' });
    if (!ok) return;
    try {
      const r = await api('POST', '/productos/masivo', { accion, categoria: s.categoria });
      toast(`${r.cambiados} producto(s) actualizados.`, 'success');
      loadProductos();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  // ── Reportes de la tienda ───────────────────────────────────────────────

  function hoy() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  async function renderReportes() {
    const pane = el('to-pane-reportes');
    if (!pane) return;
    const desde = el('to-rep-desde')?.value || `${hoy().slice(0, 8)}01`;
    const hasta = el('to-rep-hasta')?.value || hoy();
    pane.innerHTML = `
      <div class="to-products-tools">
        <input type="date" id="to-rep-desde" class="form-input" style="width:auto" value="${esc(desde)}">
        <input type="date" id="to-rep-hasta" class="form-input" style="width:auto" value="${esc(hasta)}">
        <button class="btn-primary" type="button" onclick="TiendaOnline.switchTab('reportes')">Ver</button>
        <span class="to-muted">Las ventas de la tienda también salen en Reportes con el filtro "Tienda online".</span>
      </div>
      <div id="to-rep-body" class="to-muted">Cargando…</div>`;
    try {
      const r = await api('GET', `/reportes?desde=${desde}&hasta=${hasta}`);
      const pedidos = r.porEstado.reduce((s, x) => s + x.pedidos, 0);
      const cancelados = r.porEstado.filter((x) => ['cancelado', 'rechazado'].includes(x.status)).reduce((s, x) => s + x.pedidos, 0);
      const delivery = r.entrega.find((x) => x.tipo === 'delivery') || { pedidos: 0, cobrado: 0 };
      const tabla = (titulo, filas, cols) => `
        <div class="to-box"><h4>${esc(titulo)}</h4>
          <table class="to-items"><tbody>${filas.length ? filas.map((f) => `<tr>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${esc(c.v(f))}</td>`).join('')}</tr>`).join('') : '<tr><td class="to-muted">Sin datos</td></tr>'}</tbody></table>
        </div>`;
      el('to-rep-body').innerHTML = `
        <div class="to-report-cards">
          <div class="stat-card"><div class="stat-val">${money(r.ventas.total)}</div><div class="stat-label">Vendido online (${r.ventas.facturas} facturas)</div></div>
          <div class="stat-card"><div class="stat-val">${pedidos}</div><div class="stat-label">Pedidos recibidos</div></div>
          <div class="stat-card stat-danger"><div class="stat-val">${cancelados}</div><div class="stat-label">Cancelados / rechazados</div></div>
          <div class="stat-card"><div class="stat-val">${delivery.pedidos}</div><div class="stat-label">Con delivery (${money(delivery.cobrado)})</div></div>
        </div>
        <div class="to-report-grid">
          ${tabla('Pedidos por estado', r.porEstado, [{ v: (f) => ESTADOS[f.status] || f.status }, { v: (f) => f.pedidos, num: true }, { v: (f) => money(f.total), num: true }])}
          ${tabla('Productos más vendidos online', r.productos, [{ v: (f) => f.nombre }, { v: (f) => f.cantidad, num: true }, { v: (f) => money(f.total), num: true }])}
          ${tabla('Mejores clientes online', r.clientes, [{ v: (f) => f.nombre }, { v: (f) => f.telefono || '' }, { v: (f) => f.pedidos, num: true }, { v: (f) => money(f.total), num: true }])}
          ${tabla('Pedidos por día', r.porDia, [{ v: (f) => fecha(f.dia).split(' ')[0] }, { v: (f) => f.pedidos, num: true }, { v: (f) => money(f.total), num: true }])}
        </div>`;
    } catch (error) {
      el('to-rep-body').textContent = error.message;
    }
  }

  // ── Configuración (Mi Negocio → Tienda online) ──────────────────────────

  async function loadConfigSection() {
    const state = el('cfg-tienda-online-state');
    const toggle = el('cfg-tienda-online-enabled');
    if (!state || !toggle) return;
    if (!canConfigure()) {
      el('cfg-tienda-online-section')?.classList.add('hidden');
      return;
    }
    try {
      TO.config = await api('GET', '/config');
      TO.activa = Boolean(TO.config.enabled);
      toggle.checked = TO.activa;
      syncNav();
      const e = TO.config.estado || {};
      const err = e.publicacion?.ultimoError;
      state.innerHTML = TO.activa
        ? `<span class="to-dot ${err ? 'err' : 'ok'}"></span>${err ? esc(err) : 'Tienda activa'}${TO.config.url ? ` · <a href="${esc(TO.config.url)}" data-to-ext="1">${esc(TO.config.url)}</a>` : ''}`
        : '<span class="to-dot"></span>Tienda desactivada';
    } catch (error) {
      state.textContent = error.message;
    }
  }

  async function onToggleEnabled(input) {
    const enabled = Boolean(input.checked);
    if (enabled && !TO.config?.slug) {
      input.checked = false;
      openConfig({ activar: true });
      return;
    }
    try {
      const saved = await api('PUT', '/config', { enabled });
      TO.config = { ...(TO.config || {}), ...saved };
      TO.activa = Boolean(saved.enabled);
      syncNav();
      toast(enabled ? 'Tienda online activada.' : 'Tienda online desactivada. Los pedidos y ventas se conservan.', 'success');
      loadConfigSection();
    } catch (error) {
      input.checked = !enabled;
      toast(error.message, 'error');
    }
  }

  function copyLink() {
    const url = TO.config?.url || TO.estado?.url;
    if (!url) { toast('Primero configura la dirección de la tienda.', 'warning'); return; }
    navigator.clipboard?.writeText(url).then(() => toast('Enlace copiado.', 'success')).catch(() => toast(url, 'info', 10000));
  }

  function openProductsTab() {
    openModule();
    switchTab('productos');
  }

  function modal({ titulo, cuerpo, botones = [], ancho }) {
    const overlay = document.createElement('div');
    overlay.className = 'to-modal-overlay';
    overlay.innerHTML = `
      <div class="to-modal tc-themed" role="dialog" aria-modal="true" ${ancho ? `style="width:min(${ancho}px,100%)"` : ''}>
        <div class="to-modal-head"><h3>${esc(titulo)}</h3><button type="button" class="btn-secondary" data-close>✕</button></div>
        <div class="to-modal-body">${cuerpo}</div>
        <div class="to-modal-foot">${botones.map(([kind, label], i) => `<button type="button" class="btn-${kind}" data-btn="${i}">${esc(label)}</button>`).join('')}</div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('[data-close]').addEventListener('click', close);
    botones.forEach(([, , fn], i) => overlay.querySelector(`[data-btn="${i}"]`).addEventListener('click', () => fn(close, overlay)));
    return overlay;
  }

  async function openConfig({ activar = false } = {}) {
    if (!canConfigure()) { toast('Solo el administrador puede configurar la tienda.', 'warning'); return; }
    let cfg;
    try {
      cfg = await api('GET', '/config');
    } catch (error) {
      toast(error.message, 'error');
      return;
    }
    TO.config = cfg;
    const s = cfg.settings;
    const slugSugerido = cfg.slug || (await api('GET', `/slug-sugerido?nombre=${encodeURIComponent(s.nombre || DB.config?.nombre || '')}`).catch(() => ({}))).slug || '';
    const base = (cfg.url || '').replace(/\/t\/[^/]*$/, '') || 'https://…';
    const pagos = Object.entries(cfg.metodosPago).map(([codigo, etiqueta]) => {
      const p = s.pagos[codigo] || {};
      return `<div class="to-pay-row">
        <label><input type="checkbox" data-pago="${codigo}" ${p.habilitado ? 'checked' : ''}> ${esc(etiqueta)}</label>
        <div>${codigo === 'otro' ? `<input type="text" class="form-input" data-pago-etiqueta placeholder="Nombre del método" value="${esc(p.etiqueta || '')}" style="margin-bottom:6px">` : ''}
        <input type="text" class="form-input" data-pago-instr="${codigo}" maxlength="400" placeholder="Instrucciones para el cliente (opcional)" value="${esc(p.instrucciones || '')}"></div>
      </div>`;
    }).join('');
    const zonas = (s.delivery.zonas || []).map(zonaRow).join('');
    const horas = s.horario.dias.map((d) => `
      <span>${DIAS[d.dia]}</span>
      <label><input type="checkbox" data-dia-abierto="${d.dia}" ${d.abierto ? 'checked' : ''}> Abierto</label>
      <input type="time" class="form-input" data-dia-abre="${d.dia}" value="${esc(d.abre)}">
      <input type="time" class="form-input" data-dia-cierra="${d.dia}" value="${esc(d.cierra)}">`).join('');
    const sucursales = cfg.sucursales.map((b) => `<option value="${b.id}" ${Number(cfg.branchId) === b.id ? 'selected' : ''}>${esc(b.nombre)}</option>`).join('');

    const overlay = modal({
      titulo: 'Configurar tienda online',
      ancho: 940,
      cuerpo: `
        <div class="tc-tabs">
          ${['General', 'Entrega', 'Pagos', 'Horario', 'Avanzado'].map((t, i) => `<button type="button" class="pill-tab ${i === 0 ? 'active' : ''}" data-cfg-tab="${i}">${t}</button>`).join('')}
        </div>
        <div data-cfg-pane="0" class="to-form-grid">
          <div class="form-group span-full">
            <label>Dirección de tu tienda</label>
            <div class="to-slug-row"><span>${esc(base)}/t/</span><input type="text" class="form-input" id="tocfg-slug" maxlength="40" value="${esc(slugSugerido)}" placeholder="mi-colmado"></div>
            <small class="helper-text">Solo letras minúsculas, números y guiones. Es el enlace que compartirás con tus clientes.</small>
          </div>
          <div class="form-group"><label>Nombre de la tienda</label><input type="text" class="form-input" id="tocfg-nombre" maxlength="120" value="${esc(s.nombre)}" placeholder="${esc(DB.config?.nombre || 'Mi negocio')}"></div>
          <div class="form-group"><label>Sucursal que despacha</label><select class="form-input" id="tocfg-branch">${sucursales}</select></div>
          <div class="form-group span-full"><label>Descripción</label><textarea class="form-input" id="tocfg-desc" maxlength="600" rows="2">${esc(s.descripcion)}</textarea></div>
          <div class="form-group"><label>Teléfono</label><input type="text" class="form-input" id="tocfg-tel" maxlength="40" value="${esc(s.telefono)}" placeholder="${esc(DB.config?.telefono || '')}"></div>
          <div class="form-group"><label>WhatsApp</label><input type="text" class="form-input" id="tocfg-wa" maxlength="40" value="${esc(s.whatsapp)}"></div>
          <div class="form-group"><label>Correo</label><input type="email" class="form-input" id="tocfg-email" maxlength="160" value="${esc(s.email)}"></div>
          <div class="form-group"><label>Dirección del local</label><input type="text" class="form-input" id="tocfg-dir" maxlength="255" value="${esc(s.direccion)}" placeholder="${esc(DB.config?.direccion || '')}"></div>
          <div class="form-group"><label>Color principal</label><input type="color" class="form-input" id="tocfg-color" value="${esc(s.colorPrimario)}" style="height:44px"></div>
          <div class="form-group span-full">
            <label>Banner (imagen de portada)</label>
            <div id="tocfg-banner-box" class="to-muted">${cfg.hasBanner ? 'Cargando…' : 'Sin banner'}</div>
            <div style="display:flex;gap:8px;margin-top:6px">
              <button type="button" class="btn-secondary" id="tocfg-banner-btn">Subir banner</button>
              <button type="button" class="btn-secondary" id="tocfg-banner-del">Quitar</button>
              <input type="file" id="tocfg-banner-file" accept="image/png,image/jpeg,image/webp" class="hidden">
            </div>
            <small class="helper-text">El logo es el mismo de Configuración → Datos del Negocio.</small>
          </div>
        </div>
        <div data-cfg-pane="1" class="to-form-grid hidden">
          <div class="form-group"><label><input type="checkbox" id="tocfg-retiro" ${s.retiro.habilitado ? 'checked' : ''}> Retiro en tienda</label>
            <input type="text" class="form-input" id="tocfg-retiro-instr" maxlength="400" placeholder="Instrucciones de retiro (opcional)" value="${esc(s.retiro.instrucciones)}"></div>
          <div class="form-group"><label><input type="checkbox" id="tocfg-delivery" ${s.delivery.habilitado ? 'checked' : ''}> Delivery</label>
            <input type="text" class="form-input" id="tocfg-delivery-instr" maxlength="400" placeholder="Instrucciones de delivery (opcional)" value="${esc(s.delivery.instrucciones)}"></div>
          <div class="form-group"><label>Costo de delivery (si no usas zonas)</label><input type="number" min="0" step="0.01" class="form-input" id="tocfg-delivery-costo" value="${esc(s.delivery.costoBase)}"></div>
          <div class="form-group"><label><input type="checkbox" id="tocfg-delivery-itbis" ${s.delivery.aplicaItbis ? 'checked' : ''}> Cobrar ITBIS sobre el delivery</label></div>
          <div class="form-group"><label>Pedido mínimo</label><input type="number" min="0" step="0.01" class="form-input" id="tocfg-minimo" value="${esc(s.pedidoMinimo)}"></div>
          <div class="form-group span-full">
            <label>Zonas de entrega (si las agregas, el cliente elige una y paga su costo)</label>
            <div id="tocfg-zonas">${zonas}</div>
            <button type="button" class="btn-secondary" id="tocfg-zona-add">+ Agregar zona</button>
          </div>
        </div>
        <div data-cfg-pane="2" class="hidden">
          <p class="helper-text">El cliente solo elige el método; el cobro real se hace en Tecno Caja al convertir el pedido en venta.</p>
          ${pagos}
        </div>
        <div data-cfg-pane="3" class="hidden">
          <div class="to-hours">${horas}</div>
          <div class="form-group" style="margin-top:12px"><label><input type="checkbox" id="tocfg-fuera" ${s.horario.aceptarFueraDeHorario ? 'checked' : ''}> Recibir pedidos fuera de horario (se procesan al abrir)</label></div>
          <div class="form-group"><label>Nota de horario (opcional)</label><input type="text" class="form-input" id="tocfg-horario-nota" maxlength="200" value="${esc(s.horario.nota)}"></div>
        </div>
        <div data-cfg-pane="4" class="to-form-grid hidden">
          <div class="form-group span-full"><label><input type="checkbox" id="tocfg-fiscal" ${s.comprobanteFiscal ? 'checked' : ''}> Permitir que el cliente pida comprobante fiscal (RNC)</label></div>
          <div class="form-group span-full"><label><input type="checkbox" id="tocfg-agotados" ${s.mostrarAgotados ? 'checked' : ''}> Mostrar productos agotados (marcados "Agotado", sin poder comprarlos)</label></div>
          <div class="form-group span-full">
            <label>Al cobrar un pedido, usar</label>
            <select class="form-input" id="tocfg-precio">
              <option value="pedido" ${s.conversion.precio !== 'actual' ? 'selected' : ''}>El precio con que el cliente compró (recomendado)</option>
              <option value="actual" ${s.conversion.precio === 'actual' ? 'selected' : ''}>El precio actual del POS</option>
            </select>
          </div>
          <div class="form-group span-full"><label><input type="checkbox" id="tocfg-wa-dueno" ${s.notificaciones.whatsappDueno ? 'checked' : ''}> Avisarme por WhatsApp cuando entre un pedido (bot de WhatsApp conectado)</label></div>
          <div class="form-group span-full"><label><input type="checkbox" id="tocfg-wa-cliente" ${s.notificaciones.whatsappCliente ? 'checked' : ''}> Avisar al cliente por WhatsApp cuando cambie su pedido</label></div>
          <div class="form-group span-full"><label><input type="checkbox" id="tocfg-sonido"> Sonido al recibir un pedido en esta caja</label></div>
          <div class="form-group span-full"><label>Orden de categorías (una por línea; las demás van después en orden alfabético)</label>
            <textarea class="form-input" id="tocfg-cats" rows="4">${esc((s.categoriasOrden || []).join('\n'))}</textarea></div>
        </div>`,
      botones: [
        ['secondary', 'Publicar ahora', async () => {
          try {
            const r = await api('POST', '/publicar', {});
            toast(r.ok ? 'Tienda publicada.' : (r.error || r.omitido || 'No se publicó.'), r.ok ? 'success' : 'warning', 7000);
          } catch (error) { toast(error.message, 'error'); }
        }],
        ['primary', activar ? 'Guardar y activar' : 'Guardar', async (close, ov) => {
          const ok = await guardarConfig(ov, { activar });
          if (ok) close();
        }],
      ],
    });

    overlay.querySelectorAll('[data-cfg-tab]').forEach((b) => b.addEventListener('click', () => {
      overlay.querySelectorAll('[data-cfg-tab]').forEach((x) => x.classList.toggle('active', x === b));
      overlay.querySelectorAll('[data-cfg-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.cfgPane !== b.dataset.cfgTab));
    }));
    overlay.querySelector('#tocfg-zona-add').addEventListener('click', () => {
      overlay.querySelector('#tocfg-zonas').insertAdjacentHTML('beforeend', zonaRow({ nombre: '', costo: 0, activa: true }));
    });
    overlay.addEventListener('click', (ev) => {
      if (ev.target.matches('[data-zona-del]')) ev.target.closest('.to-zones-row')?.remove();
    });
    try { overlay.querySelector('#tocfg-sonido').checked = localStorage.getItem('tc-tienda-sonido') !== '0'; } catch (_e) { /* nada */ }
    const bannerBox = overlay.querySelector('#tocfg-banner-box');
    if (cfg.hasBanner) {
      api('GET', '/config/banner').then((r) => {
        bannerBox.innerHTML = r.banner ? `<img class="to-banner-preview" src="${esc(r.banner)}" alt="Banner">` : 'Sin banner';
      }).catch(() => { bannerBox.textContent = 'Sin banner'; });
    }
    const file = overlay.querySelector('#tocfg-banner-file');
    overlay.querySelector('#tocfg-banner-btn').addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) { toast('La imagen debe pesar menos de 8 MB.', 'error'); return; }
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const r = await api('POST', '/config/banner', { dataUrl: reader.result });
          bannerBox.innerHTML = `<img class="to-banner-preview" src="${esc(r.banner)}" alt="Banner">`;
          toast('Banner guardado.', 'success');
        } catch (error) { toast(error.message, 'error'); }
      };
      reader.readAsDataURL(f);
    });
    overlay.querySelector('#tocfg-banner-del').addEventListener('click', async () => {
      try {
        await api('DELETE', '/config/banner');
        bannerBox.textContent = 'Sin banner';
      } catch (error) { toast(error.message, 'error'); }
    });
  }

  function zonaRow(z) {
    return `<div class="to-zones-row" data-zona-id="${esc(z.id || '')}">
      <input type="text" class="form-input" data-zona-nombre maxlength="80" placeholder="Ej.: Villa Mella" value="${esc(z.nombre)}">
      <input type="number" class="form-input" data-zona-costo min="0" step="0.01" value="${esc(z.costo)}">
      <label><input type="checkbox" data-zona-activa ${z.activa !== false ? 'checked' : ''}> Activa</label>
      <button type="button" class="btn-secondary" data-zona-del>Quitar</button>
    </div>`;
  }

  async function guardarConfig(ov, { activar }) {
    const q = (sel) => ov.querySelector(sel);
    const pagos = {};
    ov.querySelectorAll('[data-pago]').forEach((c) => {
      const codigo = c.dataset.pago;
      pagos[codigo] = {
        habilitado: c.checked,
        instrucciones: ov.querySelector(`[data-pago-instr="${codigo}"]`)?.value || '',
      };
      if (codigo === 'otro') pagos[codigo].etiqueta = ov.querySelector('[data-pago-etiqueta]')?.value || '';
    });
    if (!Object.values(pagos).some((p) => p.habilitado)) {
      toast('Activa al menos un método de pago.', 'warning');
      return false;
    }
    const dias = [0, 1, 2, 3, 4, 5, 6].map((d) => ({
      dia: d,
      abierto: q(`[data-dia-abierto="${d}"]`).checked,
      abre: q(`[data-dia-abre="${d}"]`).value,
      cierra: q(`[data-dia-cierra="${d}"]`).value,
    }));
    const zonas = [...ov.querySelectorAll('.to-zones-row')].map((row) => ({
      id: row.dataset.zonaId || '',
      nombre: row.querySelector('[data-zona-nombre]').value,
      costo: Number(row.querySelector('[data-zona-costo]').value || 0),
      activa: row.querySelector('[data-zona-activa]').checked,
    })).filter((z) => z.nombre.trim());
    const retiro = q('#tocfg-retiro').checked;
    const delivery = q('#tocfg-delivery').checked;
    if (!retiro && !delivery) {
      toast('Activa retiro en tienda, delivery o ambos.', 'warning');
      return false;
    }
    try { localStorage.setItem('tc-tienda-sonido', q('#tocfg-sonido').checked ? '1' : '0'); } catch (_e) { /* nada */ }
    const body = {
      slug: q('#tocfg-slug').value,
      branchId: Number(q('#tocfg-branch').value || 0) || null,
      settings: {
        nombre: q('#tocfg-nombre').value,
        descripcion: q('#tocfg-desc').value,
        telefono: q('#tocfg-tel').value,
        whatsapp: q('#tocfg-wa').value,
        email: q('#tocfg-email').value,
        direccion: q('#tocfg-dir').value,
        colorPrimario: q('#tocfg-color').value,
        retiro: { habilitado: retiro, instrucciones: q('#tocfg-retiro-instr').value },
        delivery: {
          habilitado: delivery,
          instrucciones: q('#tocfg-delivery-instr').value,
          costoBase: Number(q('#tocfg-delivery-costo').value || 0),
          aplicaItbis: q('#tocfg-delivery-itbis').checked,
          zonas,
        },
        pedidoMinimo: Number(q('#tocfg-minimo').value || 0),
        pagos,
        horario: { dias, aceptarFueraDeHorario: q('#tocfg-fuera').checked, nota: q('#tocfg-horario-nota').value },
        comprobanteFiscal: q('#tocfg-fiscal').checked,
        mostrarAgotados: q('#tocfg-agotados').checked,
        conversion: { precio: q('#tocfg-precio').value },
        notificaciones: { whatsappDueno: q('#tocfg-wa-dueno').checked, whatsappCliente: q('#tocfg-wa-cliente').checked },
        categoriasOrden: q('#tocfg-cats').value.split('\n').map((c) => c.trim()).filter(Boolean),
      },
    };
    if (activar) body.enabled = true;
    try {
      const saved = await api('PUT', '/config', body);
      TO.config = { ...(TO.config || {}), ...saved };
      TO.activa = Boolean(saved.enabled);
      syncNav();
      toast(saved.aviso || (activar ? 'Tienda online activada.' : 'Configuración guardada.'), saved.aviso ? 'warning' : 'success', 6000);
      loadConfigSection();
      return true;
    } catch (error) {
      toast(error.message, 'error', 8000);
      return false;
    }
  }

  // ── Ficha del producto: pestaña "Tienda online" ─────────────────────────

  function productTabButton(index) {
    if (!TO.activa || !canConfigure()) return '';
    return `<button class="product-tab-btn" onclick="switchProductTab(${index})">🛒 Tienda online</button>`;
  }

  function productTabPanel(index, prod) {
    if (!TO.activa || !canConfigure()) return '';
    const o = prod?.online || {};
    // El modal inserta este HTML enseguida; las fotos se cargan justo después.
    if (prod?.id) setTimeout(() => cargarFotos(Number(prod.id)), 0);
    return `
      <div class="product-tab-panel modal-grid" id="product-tab-${index}" data-to-product-panel="1">
        <div class="form-group span-full compact-toggle-card">
          <label class="toggle-switch" style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;user-select:none">
            <input type="checkbox" id="mp-online-publicado" ${o.publicado ? 'checked' : ''} style="width:auto">
            <span>Publicar en tienda online</span>
          </label>
          <p class="helper-text" style="margin:0.4rem 0 0">Si el producto está inactivo no se vende online aunque esté marcado.</p>
        </div>
        <div class="form-group span-full"><label>Descripción para la tienda (opcional)</label>
          <textarea id="mp-online-descripcion" class="form-input" rows="2" maxlength="500">${esc(o.descripcion || '')}</textarea></div>
        <div class="form-group"><label class="toggle-switch" style="display:flex;align-items:center;gap:0.5rem">
          <input type="checkbox" id="mp-online-destacado" ${o.destacado ? 'checked' : ''} style="width:auto"><span>Destacado</span></label></div>
        <div class="form-group"><label>Orden en la tienda</label><input type="number" id="mp-online-orden" class="form-input" value="${Number(o.orden || 0)}"></div>
        <div class="form-group span-full"><label>Existencia en la tienda</label>
          <select id="mp-online-modo" class="form-input">
            <option value="inventario" ${o.modoExistencia !== 'ilimitado' ? 'selected' : ''}>Según el inventario de la sucursal de la tienda</option>
            <option value="ilimitado" ${o.modoExistencia === 'ilimitado' ? 'selected' : ''}>Siempre disponible (servicios, comida preparada…)</option>
          </select></div>
        <div class="form-group span-full"><label>Fotos para la tienda</label>
          <p class="helper-text" style="margin:0 0 0.5rem">La principal es la foto del producto (se cambia arriba, en la ficha). Puedes agregar hasta 5 más: en la tienda se ven en un carrusel dentro del detalle.</p>
          ${prod?.id ? fotosBloque(Number(prod.id), { principalEditable: false })
            : '<p class="to-muted" style="margin:0">Guarda el producto primero para agregarle más fotos.</p>'}
        </div>
      </div>`;
  }

  // ── Fotos del producto para la tienda ───────────────────────────────────
  // En la ficha del producto la principal NO se cambia aquí (el botón Guardar
  // de la ficha la volvería a escribir); en el diálogo de "Productos
  // publicados" sí, con el mismo endpoint de la ficha (/api/products/:id/image).

  function fotosBloque(productId, { principalEditable }) {
    return `<div class="to-fotos" id="to-fotos" data-principal-editable="${principalEditable ? '1' : '0'}"><span class="to-muted">Cargando fotos…</span></div>
      <input type="file" id="to-fotos-file" accept="image/png,image/jpeg,image/webp" multiple hidden onchange="TiendaOnline.fotosSubir(${productId}, this)">
      <input type="file" id="to-foto-principal-file" accept="image/png,image/jpeg,image/webp" hidden onchange="TiendaOnline.fotoPrincipalSubir(${productId}, this)">`;
  }

  function fotosDialogo(productId) {
    const p = (TO.productos.data?.productos || []).find((x) => x.id === productId);
    const overlay = modal({
      titulo: `Fotos para la tienda${p ? ` · ${p.nombre}` : ''}`,
      ancho: 680,
      cuerpo: `<p class="helper-text" style="margin:0 0 0.75rem">Hasta 6 fotos: la <strong>principal</strong> (la del producto, la que se ve en la tarjeta) y 5 más para el carrusel del detalle.
        Puedes elegir varias a la vez. Se publican solas en unos segundos.</p>
        ${fotosBloque(productId, { principalEditable: true })}`,
      botones: [['primary', 'Listo', (close) => { close(); loadProductos(); }]],
    });
    overlay.querySelector('[data-close]').addEventListener('click', () => loadProductos());
    cargarFotos(productId);
  }

  function renderFotos(productId, r) {
    const box = el('to-fotos');
    if (!box) return;
    const fotos = r.fotos || [];
    const max = Number(r.maxFotos || 5);
    const editable = box.dataset.principalEditable === '1';
    box.dataset.tienePrincipal = r.tieneFotoPrincipal ? '1' : '0';
    const elegirPrincipal = `document.getElementById('to-foto-principal-file').click()`;
    box.innerHTML = `
      ${!r.tieneFotoPrincipal && editable
        ? `<button type="button" class="to-foto add principal" onclick="${elegirPrincipal}"><b>＋</b><span>Foto principal</span></button>`
        : `<div class="to-foto principal" title="${editable ? 'Foto principal del producto' : 'Foto principal del producto (se cambia arriba, en la ficha)'}">
        ${r.fotoPrincipal ? `<img src="${esc(r.fotoPrincipal)}" alt="">` : `<span class="to-foto-vacia">${r.tieneFotoPrincipal ? '🖼️' : 'Sin foto'}</span>`}
        <span class="to-foto-tag">Principal</span>
        ${editable ? `<div class="to-foto-acts"><button type="button" onclick="${elegirPrincipal}">Cambiar</button></div>` : ''}
      </div>`}
      ${fotos.map((ruta, i) => `
        <div class="to-foto">
          <img src="${esc(ruta)}" alt="">
          <div class="to-foto-acts">
            <button type="button" title="Mover a la izquierda" ${i === 0 ? 'disabled' : ''} onclick="TiendaOnline.fotoMover(${productId}, ${i + 1}, -1)">◀</button>
            <button type="button" title="Quitar foto" class="del" onclick="TiendaOnline.fotoQuitar(${productId}, ${i + 1})">✕</button>
            <button type="button" title="Mover a la derecha" ${i === fotos.length - 1 ? 'disabled' : ''} onclick="TiendaOnline.fotoMover(${productId}, ${i + 1}, 1)">▶</button>
          </div>
        </div>`).join('')}
      ${fotos.length < max ? `<button type="button" class="to-foto add" onclick="document.getElementById('to-fotos-file').click()"><b>＋</b><span>Agregar foto</span></button>` : ''}
      <span class="to-muted to-fotos-count">${fotos.length + (r.tieneFotoPrincipal ? 1 : 0)} de ${max + 1} fotos</span>`;
  }

  async function cargarFotos(productId) {
    if (!el('to-fotos')) return;
    try {
      renderFotos(productId, await api('GET', `/productos/${productId}`));
    } catch (error) {
      el('to-fotos').innerHTML = `<span class="to-muted">${esc(error.message)}</span>`;
    }
  }

  /** Achica la foto en el equipo antes de subirla (el servidor la deja en 900 px). */
  function reducirImagen(file, max = 1600) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/webp', 0.9));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`No se pudo leer ${file.name}.`)); };
      img.src = url;
    });
  }

  function fotoValida(file) {
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) { toast(`${file.name}: usa PNG, JPG o WEBP.`, 'error'); return false; }
    if (file.size > 15 * 1024 * 1024) { toast(`${file.name} pesa más de 15 MB.`, 'error'); return false; }
    return true;
  }

  /** Foto principal = la del producto en el POS (mismo endpoint que la ficha). */
  async function subirPrincipal(productId, file) {
    const res = await fetch(`/api/products/${productId}/image`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ imageData: await reducirImagen(file) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'No se pudo guardar la foto principal.');
    const i = (DB.productos || []).findIndex((p) => p.id === productId);
    if (i >= 0) DB.productos[i] = { ...DB.productos[i], ...data };
    // Cambiar la foto del producto no avisa al publicador: se publica ya.
    api('POST', '/publicar').catch(() => {});
  }

  async function fotoPrincipalSubir(productId, input) {
    const file = input.files?.[0];
    input.value = '';
    if (!file || !fotoValida(file)) return;
    try {
      await subirPrincipal(productId, file);
      toast('Foto principal guardada. Se publica en la tienda en unos segundos.', 'success');
    } catch (error) { toast(error.message, 'error'); }
    cargarFotos(productId);
  }

  async function fotosSubir(productId, input) {
    const files = [...(input.files || [])].filter(fotoValida);
    input.value = '';
    if (!files.length) return;
    const box = el('to-fotos');
    // En "Productos publicados", si el producto no tiene foto, la primera elegida pasa a ser la principal.
    if (box?.dataset.principalEditable === '1' && box.dataset.tienePrincipal !== '1') {
      try {
        await subirPrincipal(productId, files.shift());
        toast('Foto principal guardada.', 'success');
      } catch (error) { toast(error.message, 'error'); }
    }
    let subidas = 0;
    for (const file of files) {
      try {
        const r = await api('POST', `/productos/${productId}/fotos`, { dataUrl: await reducirImagen(file) });
        subidas += 1;
        if (r.fotos.length >= r.maxFotos) {
          if (files.length > subidas) toast('Llegaste al máximo de 6 fotos; las demás no se subieron.', 'warning');
          break;
        }
      } catch (error) {
        toast(error.message, 'error');
        if (error.status === 409) break;
      }
    }
    if (subidas) toast(subidas === 1 ? 'Foto agregada. Se publica en la tienda en unos segundos.' : `${subidas} fotos agregadas. Se publican en unos segundos.`, 'success');
    cargarFotos(productId);
  }

  async function fotoQuitar(productId, n) {
    const ok = await showDeleteConfirm('¿Quitar esta foto de la tienda? La foto principal del producto no se toca.', { confirmText: 'Quitar' });
    if (!ok) return;
    try {
      await api('DELETE', `/productos/${productId}/fotos/${n}`);
      cargarFotos(productId);
    } catch (error) { toast(error.message, 'error'); }
  }

  async function fotoMover(productId, n, dir) {
    try {
      await api('POST', `/productos/${productId}/fotos/${n}/mover`, { dir });
      cargarFotos(productId);
    } catch (error) { toast(error.message, 'error'); }
  }

  async function saveProductPanel(productId) {
    if (!document.querySelector('[data-to-product-panel]')) return;
    const body = {
      publicado: Boolean(el('mp-online-publicado')?.checked),
      descripcion: el('mp-online-descripcion')?.value || '',
      destacado: Boolean(el('mp-online-destacado')?.checked),
      orden: Number(el('mp-online-orden')?.value || 0),
      modoExistencia: el('mp-online-modo')?.value || 'inventario',
    };
    await api('PUT', `/productos/${productId}`, body);
    const prod = (DB.productos || []).find((p) => p.id === productId);
    if (prod) prod.online = { ...(prod.online || {}), ...body };
  }

  // ── Arranque ────────────────────────────────────────────────────────────

  function onModuleOpen() {
    loadEstado();
    refreshResumen();
    switchTab(TO.tab || 'pedidos');
  }

  function start() {
    initSocket();
    refreshResumen();
    setInterval(() => {
      if (!isLoggedIn()) return;
      refreshResumen();
      if (moduleVisible() && TO.tab === 'pedidos') loadPedidos();
    }, 30000);
  }

  window.TiendaOnline = {
    start,
    refresh: () => { refreshResumen(); if (moduleVisible()) loadPedidos(); },
    onModuleOpen,
    switchTab,
    setFilter: (f) => { TO.filtro = f; loadPedidos(); },
    onSearch: (() => {
      let t = null;
      return (value) => { clearTimeout(t); t = setTimeout(() => { TO.buscar = String(value || '').trim(); loadPedidos(); }, 300); };
    })(),
    select,
    setEstado,
    convertir,
    imprimir,
    syncNow: async () => {
      try {
        TO.estado = await api('POST', '/sincronizar', {});
        renderStatusBar();
        loadPedidos();
        toast('Sincronizado.', 'success');
      } catch (error) { toast(error.message, 'error'); }
    },
    openConfig,
    openProductsTab,
    copyLink,
    abrir,
    loadConfigSection,
    onToggleEnabled,
    productosFiltro: (campo, valor) => { TO.productos[campo] = valor; TO.productos.page = 1; loadProductos(); },
    productosPagina: (delta) => { TO.productos.page = Math.max(1, TO.productos.page + delta); loadProductos(); },
    productoCampo,
    masivo,
    productTabButton,
    productTabPanel,
    saveProductPanel,
    fotosDialogo,
    fotosSubir,
    fotoPrincipalSubir,
    fotoQuitar,
    fotoMover,
    onCartCleared,
    onSaleCompleted,
  };

  // Espera a que haya sesión para consultar el estado (el login es dinámico).
  const boot = setInterval(() => {
    if (!isLoggedIn()) return;
    clearInterval(boot);
    start();
  }, 2000);
})();
