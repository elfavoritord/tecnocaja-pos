/* Tienda online de Tecno Caja — catálogo, detalle, favoritos, carrito, checkout y seguimiento.
 * Todo precio y total lo calcula el servidor (/cotizar y /pedidos); aquí
 * solo se muestra. Sin código en línea (la política CSP lo prohíbe). */
(function () {
  'use strict';

  const partes = location.pathname.split('/').filter(Boolean); // t, slug, [pedido, id]
  const SLUG = partes[0] === 't' ? decodeURIComponent(partes[1] || '') : '';
  const PEDIDO_ID = partes[2] === 'pedido' ? decodeURIComponent(partes[3] || '') : '';
  const TOKEN = new URLSearchParams(location.search).get('k') || '';
  const API = `/api/tiendas/${encodeURIComponent(SLUG)}`;
  const KEY_CARRITO = `tc-carrito-${SLUG}`;
  const KEY_FAVORITOS = `tc-favoritos-${SLUG}`;
  const KEY_CLIENTE = 'tc-cliente';
  const KEY_TEMA = 'tc-tema';
  const MAX_DETALLE = 99;
  const POR_PAGINA = 24;
  const { ICO } = window.TCSecciones;
  // Carrusel de fotos del detalle.
  const SLIDE_MS = 6000;
  const REANUDAR_MS = 5000;
  const UMBRAL_ARRASTRE = 50;
  const SIN_MOVIMIENTO = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const ICONO_MAS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

  const S = {
    tienda: null,
    productos: [],
    porId: new Map(),
    categoria: '',
    buscar: '',
    min: '',
    max: '',
    orden: '',
    soloOfertas: false,
    soloDisponibles: false,
    soloDestacados: false,
    soloMasVendidos: false,
    marca: '',
    vista: 'inicio', // inicio (secciones) | catalogo (todos, con filtros)
    limite: POR_PAGINA,
    animar: true, // la entrada al bajar solo al abrir, no en cada actualización
    misPedidos: null, // null = cargando; [] = sin pedidos en este teléfono
    carrito: cargarCarrito(),
    favoritos: cargarFavoritos(),
    cot: null,
    cotN: 0,
    panel: '', // '' (cerrado) | carrito | favoritos | datos | listo
    abridor: null,
    detalle: null, // { id, cantidad } con el modal abierto
    abridorDetalle: null,
    cerrandoDetalle: false,
    enviando: false,
    entrega: 'retiro',
    zonaId: '',
    pago: '',
    comprobante: false,
    notas: '',
    resultado: null,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  function esc(v) {
    return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function norm(v) {
    return String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }
  function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }
  function money(v) {
    const m = S.tienda?.moneda || 'RD$';
    return `${m} ${Number(v || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  /** Precio tachado: sin ".00" para que quepa. */
  function moneyCorto(v) {
    const n = round2(v);
    const d = Number.isInteger(n) ? 0 : 2;
    return `${S.tienda?.moneda || 'RD$'} ${n.toLocaleString('es-DO', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
  }
  function cant(v) {
    return Number(v || 0).toLocaleString('es-DO', { maximumFractionDigits: 2 });
  }
  function fecha(v) {
    if (!v) return '';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('es-DO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function toast(texto, { error = false, ok = false } = {}) {
    const box = $('#toasts');
    const t = document.createElement('div');
    t.className = `toast${error ? ' err' : ''}`;
    if (ok) t.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';
    t.appendChild(document.createTextNode(texto));
    box.appendChild(t);
    while (box.children.length > 3) box.firstElementChild.remove();
    setTimeout(() => t.remove(), 3000);
  }
  function nuevaClave() {
    const b = new Uint8Array(18);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  function leerJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch (_e) { return fallback; }
  }
  function guardarJSON(key, valor) {
    try { localStorage.setItem(key, JSON.stringify(valor)); } catch (_e) { /* modo privado */ }
  }
  async function api(path, opts = {}) {
    const res = await fetch(`${API}${path}`, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      // Siempre preguntar al servidor (con ETag sigue siendo liviano): una
      // respuesta vieja guardada, como un "tienda cerrada", no vuelve a salir.
      cache: 'no-cache',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || 'No se pudo completar. Intenta de nuevo.');
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return data;
  }
  /** Repinta un contenedor sin perder el botón que tenía el foco del teclado.
   *  `raiz` da dónde buscarlo después (si el contenedor se reemplaza entero). */
  function conFoco(contenedor, pintar, raiz) {
    const a = document.activeElement;
    let sel = '';
    if (contenedor && a && contenedor.contains(a)) {
      for (const k of ['agregar', 'mas', 'menos', 'rapida', 'fav', 'ver', 'det', 'act']) if (a.dataset?.[k]) { sel = `[data-${k}="${a.dataset[k]}"]`; break; }
    }
    pintar();
    if (!sel) return;
    const lugar = raiz ? raiz() : contenedor;
    // "Agregar" se vuelve − 1 +; si ya no está, el foco pasa al botón que lo reemplazó.
    (lugar?.querySelector(sel) || lugar?.querySelector('[data-mas],[data-agregar]'))?.focus({ preventScroll: true });
  }

  // ── Precios: oferta del POS y descuento % del producto ──────────────────
  // Mismas cuentas que calculo-pedido.js: el descuento % se aplica sobre el
  // precio vigente (con oferta, si la hay). El total real lo da /cotizar.
  function descPct(p) { return Math.min(100, Math.max(0, Number(p.descuentoPct) || 0)); }
  function precioFinal(p) { return round2(p.precio * (1 - descPct(p) / 100)); }
  function precioAntesDe(p) {
    if (p.precioAntes && p.precioAntes > precioFinal(p)) return p.precioAntes;
    return descPct(p) > 0 ? p.precio : null;
  }
  function descuentoDe(p) {
    const antes = precioAntesDe(p);
    return antes ? Math.round((1 - precioFinal(p) / antes) * 100) : 0;
  }
  function tieneOferta(p) { return descuentoDe(p) > 0 || Boolean(p.porCantidad); }

  // ── Carrito y favoritos (se guardan en este teléfono) ───────────────────
  function cargarCarrito() {
    const c = leerJSON(KEY_CARRITO, {});
    return { items: Array.isArray(c.items) ? c.items : [], clave: c.clave || '' };
  }
  function guardarCarrito() { guardarJSON(KEY_CARRITO, S.carrito); }
  function cargarFavoritos() {
    const f = leerJSON(KEY_FAVORITOS, []);
    return Array.isArray(f) ? f.map(Number).filter(Number.isFinite) : [];
  }
  function cantidadDe(id) {
    return S.carrito.items.find((i) => i.productoId === id)?.cantidad || 0;
  }
  function paso(p) { return p.modoVenta === 'unidad' ? 1 : 0.5; }

  function setCantidad(id, cantidad) {
    const p = S.porId.get(id);
    const max = p && p.disponible !== null ? p.disponible : 999;
    const c = Math.max(0, Math.min(max, round2(cantidad)));
    const idx = S.carrito.items.findIndex((i) => i.productoId === id);
    if (c <= 0) { if (idx >= 0) S.carrito.items.splice(idx, 1); }
    else if (idx >= 0) S.carrito.items[idx].cantidad = c;
    else S.carrito.items.push({ productoId: id, cantidad: c });
    if (p && p.disponible !== null && cantidad > p.disponible) toast(`Solo hay ${cant(p.disponible)} disponibles.`);
    S.carrito.clave = '';
    guardarCarrito();
    pintarContadores();
    pintarTarjeta(id);
    if (S.detalle) pintarDetalle();
    if (S.panel === 'carrito') { pintarPanel(); recotizar(); }
    else if (S.panel === 'favoritos') pintarPanel();
    return c;
  }

  /** Suma al carrito y avisa. Devuelve cuánto se agregó de verdad. */
  function agregar(id, cuanto) {
    const p = S.porId.get(id);
    if (!p || p.agotado) return 0;
    const antes = cantidadDe(id);
    const agregado = round2(setCantidad(id, antes + (cuanto || paso(p))) - antes);
    if (agregado > 0) {
      toast(cuanto ? `${cant(agregado)} × ${p.nombre} agregado al carrito` : `${p.nombre} agregado al carrito`, { ok: true });
      for (const b of [$('#cart-btn'), $('#tb-cart'), $('#cart-flota')]) {
        b.classList.remove('pulso');
        void b.offsetWidth; // reinicia la animación si se agrega seguido
        b.classList.add('pulso');
      }
    }
    return agregado;
  }

  function quitar(id) {
    const p = S.porId.get(id);
    setCantidad(id, 0);
    toast(`${p ? p.nombre : 'Producto'} eliminado del carrito`);
  }

  function toggleFavorito(id) {
    const p = S.porId.get(id);
    const i = S.favoritos.indexOf(id);
    if (i >= 0) S.favoritos.splice(i, 1);
    else S.favoritos.unshift(id);
    guardarJSON(KEY_FAVORITOS, S.favoritos);
    pintarContadores();
    pintarTarjeta(id);
    if (S.detalle) pintarDetalle();
    if (S.panel === 'favoritos') pintarPanel();
    const nombre = p ? p.nombre : 'Producto';
    toast(i >= 0 ? `${nombre} quitado de favoritos` : `${nombre} agregado a favoritos`, { ok: i < 0 });
  }

  function pintarContadores() {
    const n = S.carrito.items.reduce((s, i) => s + (S.porId.get(i.productoId)?.modoVenta === 'unidad' ? i.cantidad : 1), 0);
    const f = S.favoritos.filter((id) => S.porId.has(id)).length;
    const cb = $('#cart-count');
    cb.textContent = n > 99 ? '99+' : cant(n);
    cb.classList.toggle('hidden', !n);
    $('#cart-btn').setAttribute('aria-label', n ? `Ver carrito (${cant(n)})` : 'Ver carrito');
    const fl = $('#flota-count');
    fl.textContent = cb.textContent;
    fl.classList.toggle('hidden', !n);
    const fb = $('#fav-count');
    fb.textContent = f > 99 ? '99+' : String(f);
    fb.classList.toggle('hidden', !f);
    $('#fav-btn').setAttribute('aria-label', f ? `Ver favoritos (${f})` : 'Ver favoritos');
    // Barra de abajo (teléfono)
    const tc = $('#tb-cart-count');
    tc.textContent = n > 99 ? '99+' : cant(n);
    tc.classList.toggle('hidden', !n);
    const tf = $('#tb-fav-count');
    tf.textContent = f > 99 ? '99+' : String(f);
    tf.classList.toggle('hidden', !f);
  }

  /** Marca en la barra de abajo dónde está el cliente. */
  function pintarTabbar() {
    const activo = S.panel === 'favoritos' ? 'favoritos'
      : ['carrito', 'datos', 'listo'].includes(S.panel) ? 'carrito'
        : S.panel === 'pedidos' ? 'pedidos'
          : S.soloOfertas && S.vista === 'catalogo' ? 'ofertas' : 'inicio';
    document.querySelectorAll('#tabbar [data-nav]').forEach((b) => {
      b.classList.toggle('on', b.dataset.nav === activo);
      if (b.dataset.nav === activo) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
  }

  // ── Tema y diseño del negocio ────────────────────────────────────────────
  function pintarTema() {
    const oscuro = document.documentElement.getAttribute('data-theme') === 'dark';
    const b = $('#tema-btn');
    b.innerHTML = oscuro ? ICO.sol : ICO.luna;
    b.setAttribute('aria-label', oscuro ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
  }

  function cambiarTema() {
    const oscuro = document.documentElement.getAttribute('data-theme') !== 'dark';
    document.documentElement.setAttribute('data-theme', oscuro ? 'dark' : 'light');
    try { localStorage.setItem(KEY_TEMA, oscuro ? 'dark' : 'light'); } catch (_e) { /* modo privado */ }
    window.TCDiseno.pintarMeta();
    pintarTema();
  }

  function aplicarDiseno() {
    const { diseno } = S.tienda;
    window.TCDiseno.aplicar(diseno);
    $('#tema-btn').classList.toggle('hidden', !diseno.apariencia.temaOscuro);
    pintarTema();
  }

  function seccionActiva(id) {
    return Boolean(S.tienda.diseno.secciones.find((s) => s.id === id)?.activa);
  }

  function waUrl(valor) {
    const wa = String(valor || '').replace(/\D/g, '');
    return wa.length >= 10 ? `https://wa.me/${wa.length === 10 ? `1${wa}` : wa}` : '';
  }

  // ── Encabezado y menús ───────────────────────────────────────────────────
  function pintarEncabezado() {
    const t = S.tienda;
    const e = t.diseno.encabezado;
    const html = document.documentElement;
    document.title = t.nombre;
    const logo = e.mostrarLogo && t.logo ? `<img src="${esc(t.logo)}" alt="">` : '';
    const conNombre = e.mostrarNombre || !logo;
    $('#brand').innerHTML = `${logo}<h1${conNombre ? '' : ' class="sr"'}>${esc(t.nombre)}</h1>${t.abierta ? '' : '<span class="chip off">Cerrado</span>'}`;
    contactoEnEncabezado(e.mostrarTelefono ? t.telefono : '', e.mostrarWhatsapp ? (t.whatsapp || t.telefono) : '');
    const cabecera = seccionActiva('encabezado');
    $('#top').classList.toggle('hidden', !cabecera);
    $('#top').classList.toggle('con-buscador', e.mostrarBuscador);
    $('#search-box').classList.toggle('hidden', !e.mostrarBuscador);
    $('#nav-pc').classList.toggle('hidden', !e.mostrarMenu);
    $('#cart-btn').classList.toggle('hidden', !e.mostrarCarrito);
    html.classList.toggle('sin-buscador', !e.mostrarBuscador);
    html.classList.toggle('sin-menu', !e.mostrarMenu);
    // Sin encabezado o sin carrito arriba, el carrito sigue a mano (nunca se pierde).
    html.classList.toggle('carrito-flota', !cabecera || !e.mostrarCarrito);
    pintarMenus();
    medirEncabezado();
  }

  /** En el teléfono solo queda fijo el buscador: el nombre sube con la página. */
  function medirEncabezado() {
    const caja = $('#search-box');
    if (caja && caja.offsetTop > 0) document.documentElement.style.setProperty('--alto-marca', `${Math.max(0, caja.offsetTop - 8)}px`);
  }

  /** Llamar y WhatsApp de la tienda, arriba junto al botón de día/noche. */
  function contactoEnEncabezado(telefono, whatsapp) {
    const tel = String(telefono || '').replace(/[^\d+]/g, '');
    const llamar = $('#llamar-btn');
    const waBtn = $('#wa-btn');
    llamar.classList.toggle('hidden', tel.replace(/\D/g, '').length < 7);
    if (tel) llamar.href = `tel:${tel}`;
    const wa = waUrl(whatsapp);
    waBtn.classList.toggle('hidden', !wa);
    if (wa) waBtn.href = wa;
  }

  function entradasMenu() {
    const t = S.tienda;
    const lista = [];
    if (listaDe('ofertas').length) lista.push(['ofertas', 'Ofertas']);
    if (listaDe('nuevos').length) lista.push(['nuevos', 'Novedades']);
    if (listaDe('masVendidos').length) lista.push(['masVendidos', 'Más vendidos']);
    const hayContacto = t.telefono || t.whatsapp || t.email || Object.values(t.diseno.redes || {}).some(Boolean);
    if (seccionActiva('contacto') && hayContacto) lista.push(['contacto', 'Contacto']);
    return lista;
  }

  function pintarMenus() {
    const cats = categorias();
    const extras = entradasMenu();
    const destino = ([d, txt]) => `<button class="nav-link" type="button" data-ir="${esc(d)}">${esc(txt)}</button>`;
    $('#nav-pc').innerHTML = `<div class="wrap nav-in">
      ${destino(['inicio', 'Inicio'])}
      <div class="nav-drop">
        <button class="nav-link" type="button" data-ir="catalogo" aria-haspopup="true">Productos ${ICO.flecha}</button>
        <div class="nav-menu">
          <button type="button" data-ir="catalogo">Todos los productos</button>
          ${cats.map((c) => `<button type="button" data-ir="categoria:${esc(c)}">${esc(c)}</button>`).join('')}
        </div>
      </div>
      ${extras.map(destino).join('')}
    </div>`;
    $('#menu-nombre').textContent = S.tienda.nombre;
    const fila = ([d, txt]) => `<button type="button" data-ir="${esc(d)}">${esc(txt)}${ICO.flecha.replace('<svg', '<svg width="16" height="16"')}</button>`;
    $('#menu-cuerpo').innerHTML = `
      ${fila(['inicio', 'Inicio'])}
      ${fila(['catalogo', 'Todos los productos'])}
      ${extras.map(fila).join('')}
      ${cats.length ? '<h3>Categorías</h3>' : ''}
      ${cats.map((c) => fila([`categoria:${c}`, c])).join('')}`;
  }

  function abrirMenu() {
    $('#menu').classList.add('open');
    $('#menu-fondo').classList.add('open');
    $('#menu-btn').setAttribute('aria-expanded', 'true');
    document.body.classList.add('lock');
    $('#menu .menu-x').focus({ preventScroll: true });
  }

  function cerrarMenu() {
    if (!$('#menu').classList.contains('open')) return;
    $('#menu').classList.remove('open');
    $('#menu-fondo').classList.remove('open');
    $('#menu-btn').setAttribute('aria-expanded', 'false');
    if (!S.panel && !S.detalle) document.body.classList.remove('lock');
    $('#menu-btn').focus({ preventScroll: true });
  }

  function subirA(top) {
    window.scrollTo({ top, behavior: SIN_MOVIMIENTO ? 'auto' : 'smooth' });
  }

  /** El nombre o logo del negocio lleva al inicio: sin filtros, arriba y sin paneles abiertos. */
  function irAlInicio() {
    if (S.detalle) cerrarDetalle();
    if (S.panel) cerrarPanel();
    cerrarMenu();
    limpiarFiltros();
    S.buscar = '';
    S.porBusqueda = false;
    $('#buscar').value = '';
    S.vista = 'inicio';
    try { if (history.state?.tcCatalogo) history.replaceState(null, ''); } catch (_e) { /* sin historial */ }
    if (S.tienda) pintarCatalogo();
    pintarTabbar();
    subirA(0);
  }

  /** A dónde lleva un botón de la tienda (portada, menú, "Ver todo", banners…). */
  function irDestino(valor) {
    const texto = String(valor || '');
    const corte = texto.indexOf(':');
    const tipo = corte > 0 ? texto.slice(0, corte) : texto;
    const dato = corte > 0 ? texto.slice(corte + 1) : '';
    cerrarMenu();
    if (S.panel) cerrarPanel();
    if (tipo === 'inicio') { irAlInicio(); return; }
    if (tipo === 'whatsapp') {
      const url = waUrl(S.tienda.whatsapp || S.tienda.telefono);
      if (url) window.open(url, '_blank', 'noopener');
      return;
    }
    if (tipo === 'contacto') {
      if (S.vista !== 'inicio') irAlInicio();
      const sec = $('#sec-contacto') || $('.foot');
      if (sec) subirA(sec.getBoundingClientRect().top + window.scrollY - ($('#top').offsetHeight || 0));
      return;
    }
    limpiarFiltros();
    S.buscar = '';
    $('#buscar').value = '';
    if (tipo === 'ofertas') S.soloOfertas = true;
    else if (tipo === 'nuevos') S.orden = 'nuevos';
    else if (tipo === 'destacados') S.soloDestacados = true;
    else if (tipo === 'masVendidos') S.soloMasVendidos = true;
    else if (tipo === 'categoria') S.categoria = dato;
    else if (tipo === 'marca') S.marca = dato;
    entrarCatalogo();
  }

  function horarioHoy(t) {
    const d = t.horario?.dias?.find((x) => Number(x.dia) === new Date().getDay());
    if (!d) return '';
    return d.abierto ? `Hoy ${d.abre} – ${d.cierra}` : 'Hoy cerrado';
  }

  function categorias() {
    const conProductos = new Set(S.productos.map((p) => p.categoria).filter(Boolean));
    const orden = S.tienda.categorias.filter((c) => conProductos.has(c));
    return [...orden, ...[...conProductos].filter((c) => !orden.includes(c))];
  }

  // ── Listas de la página de inicio ────────────────────────────────────────
  function ordenPorDefecto(a, b) {
    return Number(a.agotado) - Number(b.agotado) || Number(b.destacado) - Number(a.destacado);
  }

  function listaDe(id) {
    const hay = S.productos.filter((p) => !p.agotado);
    if (id === 'destacados') return hay.filter((p) => p.destacado).slice(0, 12);
    const { vitrinas } = S.tienda.diseno;
    if (id === 'ofertas') return hay.filter(tieneOferta).sort((a, b) => descuentoDe(b) - descuentoDe(a)).slice(0, vitrinas.ofertas.cantidad);
    if (id === 'nuevos') return hay.filter(esNuevo).sort(masNuevoPrimero).slice(0, vitrinas.nuevos.cantidad);
    if (id === 'masVendidos') {
      return (S.tienda.masVendidos || []).map((x) => S.porId.get(Number(x))).filter((p) => p && !p.agotado).slice(0, 12);
    }
    return [];
  }

  function esNuevo(p) { return p.nuevo === true; }

  function masNuevoPrimero(a, b) {
    return (Date.parse(b.creadoEn || '') || 0) - (Date.parse(a.creadoEn || '') || 0) || b.id - a.id;
  }

  /** Se consulta cada vez: el cliente puede cambiarlo con la página abierta. */
  const PREF_MOVIMIENTO = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  function sinMovimiento() { return Boolean(PREF_MOVIMIENTO?.matches); }
  PREF_MOVIMIENTO?.addEventListener?.('change', () => { if (S.tienda) pintarCatalogo(); });

  const SECC = window.TCSecciones.crear({
    esc, tarjeta, fotosDe, emojiDe, horarioHoy, money, waUrl, categorias, sinMovimiento,
    tintaSobre: window.TCDiseno.tintaSobre,
    productos: () => S.productos,
    ordenInicial: () => S.productos.slice().sort(ordenPorDefecto),
    lista: listaDe,
  });

  // ── Aparición suave al bajar y filas que se deslizan ─────────────────────
  const REVELA = !SIN_MOVIMIENTO && 'IntersectionObserver' in window
    ? new IntersectionObserver((entradas) => {
      for (const en of entradas) {
        if (!en.isIntersecting) continue;
        const el = en.target;
        REVELA.unobserve(el);
        el.classList.add('in');
        setTimeout(() => { el.classList.remove('rv', 'in'); el.style.transitionDelay = ''; }, 900);
      }
    }, { rootMargin: '0px 0px -4% 0px', threshold: 0.04 })
    : null;

  function revelar(raiz) {
    if (!S.animar || !REVELA) return;
    raiz.querySelectorAll('.sec-head, .mq-caja, .card, .cat-tile, .marcas button, .anuncio, .info-item, .cto').forEach((el) => {
      if (el.closest('.foot') || (el.matches('.card') && el.closest('.mq-caja'))) return;
      const i = [...el.parentElement.children].indexOf(el);
      el.classList.add('rv');
      el.style.transitionDelay = `${Math.min(i, 5) * 55}ms`;
      REVELA.observe(el);
    });
  }

  function flechasDeFila(fila) {
    const caja = fila.closest('.fila-caja');
    if (!caja) return;
    const izq = caja.querySelector('.prev');
    const der = caja.querySelector('.next');
    izq.hidden = fila.scrollLeft <= 4;
    der.hidden = fila.scrollLeft + fila.clientWidth >= fila.scrollWidth - 4;
  }

  function prepararFilas(guardadas) {
    document.querySelectorAll('.fila').forEach((fila) => {
      const antes = guardadas?.get(fila.dataset.filaLista);
      if (antes) { fila.style.scrollBehavior = 'auto'; fila.scrollLeft = antes; fila.style.scrollBehavior = ''; }
      flechasDeFila(fila);
      fila.addEventListener('scroll', () => flechasDeFila(fila), { passive: true });
    });
  }

  // ── Página: inicio por secciones o catálogo con filtros ──────────────────
  function pintarCatalogo() {
    const t = S.tienda;
    const app = $('#app');
    const filas = new Map([...document.querySelectorAll('.fila')].map((f) => [f.dataset.filaLista, f.scrollLeft]));
    const aviso = !t.abierta
      ? `<div class="wrap"><div class="aviso">${t.aceptaFueraDeHorario ? 'Estamos cerrados ahora: tu pedido se procesa cuando abramos.' : 'Estamos cerrados: no recibimos pedidos ahora.'}</div></div>`
      : '';
    rota.io?.disconnect();
    rota.visibles.clear();
    app.innerHTML = `${aviso}${S.vista === 'catalogo' ? catalogoHtml() : SECC.inicio(t)}${SECC.pie(t)}`;
    if (S.vista === 'catalogo') {
      enlazarFiltros();
      pintarProductos();
    } else {
      revelar(app);
      observarTarjetas(app);
    }
    window.TCMarquee.montar(app);
    prepararFilas(filas);
    S.animar = false;
  }

  function entrarCatalogo() {
    S.vista = 'catalogo';
    S.limite = POR_PAGINA;
    try { if (!history.state?.tcCatalogo) history.pushState({ tcCatalogo: true }, ''); } catch (_e) { /* sin historial */ }
    pintarCatalogo();
    $('#app').classList.remove('vista-entra');
    void $('#app').offsetWidth;
    $('#app').classList.add('vista-entra');
    pintarTabbar();
    window.scrollTo(0, 0);
  }

  function limpiarFiltros() {
    S.categoria = '';
    S.marca = '';
    S.min = '';
    S.max = '';
    S.orden = '';
    S.soloOfertas = false;
    S.soloDisponibles = false;
    S.soloDestacados = false;
    S.soloMasVendidos = false;
    S.limite = POR_PAGINA;
  }

  function tituloCatalogo() {
    const q = S.buscar.trim();
    if (q) return `Resultados para “${esc(q)}”`;
    if (S.categoria) return esc(S.categoria);
    if (S.marca) return esc(S.marca);
    if (S.soloOfertas) return 'Ofertas y promociones';
    if (S.soloDestacados) return 'Productos destacados';
    if (S.soloMasVendidos) return 'Los más vendidos';
    if (S.orden === 'nuevos') return 'Recién llegados';
    return 'Todos los productos';
  }

  function chipsActivos() {
    const c = [];
    if (S.categoria) c.push(['categoria', S.categoria]);
    if (S.marca) c.push(['marca', S.marca]);
    if (S.min !== '' || S.max !== '') c.push(['precio', `Precio: ${S.min || '0'} – ${S.max || '…'}`]);
    if (S.soloOfertas) c.push(['ofertas', 'En oferta']);
    if (S.soloDisponibles) c.push(['disponibles', 'Solo disponibles']);
    if (S.soloDestacados) c.push(['destacados', 'Destacados']);
    if (S.soloMasVendidos) c.push(['masVendidos', 'Más vendidos']);
    return c;
  }

  function catalogoHtml() {
    const ordenes = [['', 'Recomendados'], ['precio-asc', 'Menor precio'], ['precio-desc', 'Mayor precio'], ['ofertas', 'Mejores ofertas'], ['nuevos', 'Más nuevos']];
    return `<div class="wrap cat-vista">
      <nav class="migas" aria-label="Estás en"><button type="button" data-ir="inicio">Inicio</button><span>/</span><span id="miga"></span></nav>
      <div class="cat-head">
        <div class="cat-tit"><h2 id="cat-titulo"></h2><span id="cat-n" aria-live="polite"></span></div>
        <button class="btn-filtros" type="button" data-act="abrir-filtros">${ICO.filtros}Filtros<b id="n-filtros" class="hidden"></b></button>
        <select id="orden" aria-label="Ordenar por">
          ${ordenes.map(([v, l]) => `<option value="${v}" ${S.orden === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="chips" id="chips"></div>
      <div class="tira" id="tira" role="group" aria-label="Categorías"></div>
      <div class="cat-lay">
        <div class="filtros-fondo" id="filtros-fondo" data-act="cerrar-filtros"></div>
        <aside class="filtros" id="filtros" aria-label="Filtros">
          <header><span>Filtros</span><button type="button" data-act="cerrar-filtros" aria-label="Cerrar filtros">${ICO.x}</button></header>
          <div class="fcuerpo">
            <div class="fgrupo"><h3>Categorías</h3><div class="flist" id="f-cats"></div></div>
            <div class="fgrupo hidden" id="f-marcas-caja"><h3>Marcas</h3><div class="flist" id="f-marcas"></div></div>
            <div class="fgrupo"><h3>Precio</h3>
              <div class="precio-rango">
                <input id="pmin" type="number" min="0" step="any" inputmode="decimal" placeholder="Mín" aria-label="Precio mínimo" value="${esc(S.min)}">
                <span>–</span>
                <input id="pmax" type="number" min="0" step="any" inputmode="decimal" placeholder="Máx" aria-label="Precio máximo" value="${esc(S.max)}">
              </div>
            </div>
            <div class="fgrupo"><h3>Disponibilidad</h3>
              <label class="fcheck"><input id="f-disp" type="checkbox" ${S.soloDisponibles ? 'checked' : ''}> Solo disponibles</label>
              <label class="fcheck"><input id="f-ofertas" type="checkbox" ${S.soloOfertas ? 'checked' : ''}> Solo en oferta</label>
            </div>
          </div>
          <footer><button class="btn" type="button" data-act="cerrar-filtros" id="f-ver">Ver productos</button></footer>
        </aside>
        <div>
          <div class="grid" id="productos"></div>
          <div class="mas-caja" id="mas-caja"></div>
        </div>
      </div>
    </div>`;
  }

  function enlazarFiltros() {
    const cambio = () => { S.limite = POR_PAGINA; pintarProductos({ arriba: true }); };
    $('#pmin').addEventListener('input', (e) => { S.min = e.target.value; cambio(); });
    $('#pmax').addEventListener('input', (e) => { S.max = e.target.value; cambio(); });
    $('#orden').addEventListener('change', (e) => { S.orden = e.target.value; cambio(); });
    $('#f-disp').addEventListener('change', (e) => { S.soloDisponibles = e.target.checked; cambio(); });
    $('#f-ofertas').addEventListener('change', (e) => { S.soloOfertas = e.target.checked; cambio(); });
  }

  function abrirFiltros(abrir) {
    $('#filtros')?.classList.toggle('open', abrir);
    $('#filtros-fondo')?.classList.toggle('open', abrir);
    if (abrir) document.body.classList.add('lock');
    else if (!S.panel && !S.detalle) document.body.classList.remove('lock');
  }

  function quitarFiltro(cual) {
    if (cual === 'categoria') S.categoria = '';
    else if (cual === 'marca') S.marca = '';
    else if (cual === 'ofertas') S.soloOfertas = false;
    else if (cual === 'disponibles') S.soloDisponibles = false;
    else if (cual === 'destacados') S.soloDestacados = false;
    else if (cual === 'masVendidos') S.soloMasVendidos = false;
    else if (cual === 'precio') { S.min = ''; S.max = ''; }
    else if (cual === 'todo') limpiarFiltros();
    S.limite = POR_PAGINA;
    pintarCatalogo();
  }

  /** Lo que cambia con cada filtro, sin tocar los campos donde se está escribiendo. */
  function pintarEstadoFiltros(total) {
    const titulo = tituloCatalogo();
    $('#cat-titulo').innerHTML = titulo;
    $('#miga').innerHTML = titulo;
    $('#cat-n').textContent = `${total} ${total === 1 ? 'producto' : 'productos'}`;
    const activos = chipsActivos();
    $('#chips').innerHTML = activos.length
      ? `${activos.map(([k, txt]) => `<button type="button" data-quitar-filtro="${k}" aria-label="Quitar filtro: ${esc(txt)}">${esc(txt)}${ICO.x}</button>`).join('')}
        <button class="limpiar" type="button" data-quitar-filtro="todo">Limpiar todo</button>`
      : '';
    const n = $('#n-filtros');
    n.textContent = String(activos.length);
    n.classList.toggle('hidden', !activos.length);
    $('#f-ver').textContent = `Ver ${total} ${total === 1 ? 'producto' : 'productos'}`;
    const cats = categorias();
    const cuantos = new Map();
    for (const p of S.productos) cuantos.set(p.categoria, (cuantos.get(p.categoria) || 0) + 1);
    $('#f-cats').innerHTML = `<button type="button" data-cat="" class="${S.categoria ? '' : 'on'}">Todas<small>${S.productos.length}</small></button>
      ${cats.map((c) => `<button type="button" data-cat="${esc(c)}" class="${S.categoria === c ? 'on' : ''}">${esc(c)}<small>${cuantos.get(c) || 0}</small></button>`).join('')}`;
    $('#tira').innerHTML = `<button type="button" data-cat="" class="${S.categoria ? '' : 'on'}">Todo</button>
      ${cats.map((c) => `<button type="button" data-cat="${esc(c)}" class="${S.categoria === c ? 'on' : ''}">${esc(c)}</button>`).join('')}`;
    const marcas = new Map();
    for (const p of S.productos) if (p.marca) marcas.set(p.marca, (marcas.get(p.marca) || 0) + 1);
    $('#f-marcas-caja').classList.toggle('hidden', !marcas.size);
    $('#f-marcas').innerHTML = [...marcas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
      .map(([m, k]) => `<button type="button" data-marca="${esc(m)}" class="${S.marca === m ? 'on' : ''}">${esc(m)}<small>${k}</small></button>`).join('');
    const disp = $('#f-disp');
    if (disp) disp.checked = S.soloDisponibles;
    const of = $('#f-ofertas');
    if (of) of.checked = S.soloOfertas;
  }

  // ── Tarjetas de producto ────────────────────────────────────────────────
  const EMOJIS = [
    [/cafe/, '☕'], [/\bte\b|infusion/, '🍵'], [/agua/, '💧'], [/jugo|nectar/, '🧃'], [/cerveza/, '🍺'],
    [/vino/, '🍷'], [/\bron\b|whisky|licor|vodka/, '🥃'], [/refresco|soda|bebida|malta/, '🥤'],
    [/queso/, '🧀'], [/leche|lacteo|yogur/, '🥛'], [/huevo/, '🥚'], [/\bpan(es)?\b|panader/, '🍞'],
    [/galleta|oreo/, '🍪'], [/chip|papita|snack|picadera|palomita|platanito/, '🍿'], [/chocolate|dulce|caramelo|confit/, '🍫'],
    [/arroz|grano|habichuela|cereal|granola|avena|harina|pasta|espagueti/, '🌾'], [/pollo/, '🍗'],
    [/carne|\bres\b|cerdo|salami|jamon|embutido/, '🥩'], [/pescado|marisco|atun|sardina/, '🐟'],
    [/fruta|manzana|guineo|platano|naranja/, '🍎'], [/verdura|vegetal|legumbre|vivere/, '🥬'], [/miel/, '🍯'],
    [/aceite/, '🫒'], [/limpieza|detergente|cloro|desinfect/, '🧴'], [/jabon|higiene|cuidado|champu/, '🧼'],
    [/medic|farmac|vitamina|pastilla/, '💊'], [/bebe|panal/, '🍼'],
  ];
  function emojiDe(p) {
    const nombre = norm(p.nombre);
    const cat = norm(p.categoria);
    for (const [re, e] of EMOJIS) if (re.test(nombre)) return e;
    for (const [re, e] of EMOJIS) if (re.test(cat)) return e;
    return '🛍️';
  }
  function fondoDe(p) { return `g${Math.abs(Number(p.id) || 0) % 4}`; }
  const FOTOS_ROTAS = new Set(); // URLs que no cargaron: no se vuelven a mostrar
  /** Fotos del producto: la principal y las adicionales (hasta 6). */
  function fotosDe(p) {
    const lista = Array.isArray(p.imagenes) && p.imagenes.length ? p.imagenes : (p.imagen ? [p.imagen] : []);
    return lista.filter((u) => !FOTOS_ROTAS.has(u));
  }
  function cajaClase(p) { return fotosDe(p).length ? 'foto' : fondoDe(p); }
  /** Foto a su tamaño real (sin estirar ni recortar) o, si no hay, el emoji. */
  function imagenHtml(p, { lazy = true, indice = 0 } = {}) {
    const fotos = fotosDe(p);
    const url = fotos[indice % Math.max(1, fotos.length)];
    return url
      ? `<img src="${esc(url)}" alt="" draggable="false" data-pid="${p.id}"${lazy ? ' loading="lazy" decoding="async"' : ''}>`
      : `<span class="emoji" aria-hidden="true">${emojiDe(p)}</span>`;
  }
  function unidadHtml(p) {
    return p.modoVenta === 'unidad' ? '' : `<small>/ ${esc(p.unidad)}</small>`;
  }

  /** En una vitrina: la etiqueta NUEVO siempre y sin cambiar sola de foto (ya se mueve). */
  function tarjeta(p, opciones) {
    const vitrina = opciones?.vitrina || '';
    const c = cantidadDe(p.id);
    const fav = S.favoritos.includes(p.id);
    const desc = descuentoDe(p);
    const antes = precioAntesDe(p);
    const nombre = esc(p.nombre);
    const nFotos = fotosDe(p).length;
    const iFoto = (rota.indice.get(p.id) || 0) % Math.max(1, nFotos); // al repintar sigue en la misma foto
    const etiquetas = [
      desc > 0 ? `<span class="tag oferta">-${desc}%</span>` : p.porCantidad ? '<span class="tag oferta">Oferta</span>' : '',
      esNuevo(p) || vitrina === 'nuevos' ? '<span class="tag nuevo">Nuevo</span>' : '',
      p.destacado && !desc && !esNuevo(p) ? '<span class="tag star" title="Destacado">★</span>' : '',
    ].join('');
    const poco = !p.agotado && p.disponible !== null && p.disponible <= 10;
    return `
      <article class="card${p.agotado ? ' agotado' : ''}" data-id="${p.id}"${nFotos > 1 && !vitrina ? ' data-rota="1"' : ''}>
        <button class="ver" type="button" data-ver="${p.id}" aria-label="Ver detalle: ${nombre}"></button>
        <div class="img ${cajaClase(p)}">
          ${imagenHtml(p, { indice: iFoto })}
          ${etiquetas ? `<div class="tags">${etiquetas}</div>` : ''}
          <button class="fav${fav ? ' on' : ''}" type="button" data-fav="${p.id}" aria-pressed="${fav}" aria-label="${fav ? 'Quitar de' : 'Agregar a'} favoritos: ${nombre}">${ICO.corazon}</button>
          ${p.agotado ? '<span class="soldout">Agotado</span>'
            : `<button class="qv" type="button" data-rapida="${p.id}" aria-label="Vista rápida: ${nombre}">${ICO.ojo}Vista rápida</button>`}
          ${nFotos > 1 ? `<span class="nfotos" title="${nFotos} fotos">${iFoto + 1}/${nFotos}</span>` : ''}
        </div>
        <div class="body">
          ${p.categoria ? `<div class="card-cat">${esc(p.categoria)}</div>` : ''}
          <div class="name" title="${nombre}">${nombre}</div>
          <div class="price"><span class="now">${money(precioFinal(p))}</span>${unidadHtml(p)}${antes ? `<s>${moneyCorto(antes)}</s>` : ''}</div>
          ${p.porCantidad ? `<div class="rule">${esc(cant(p.porCantidad.cantidadMinima))}+ a ${moneyCorto(p.porCantidad.precio)}</div>` : ''}
          ${p.conItbis ? '<div class="tax">+ ITBIS</div>' : ''}
          ${poco ? `<div class="disp poco">Quedan ${esc(cant(p.disponible))}</div>` : ''}
          ${p.agotado ? '' : `<div class="card-cta">${c > 0
            ? `<div class="qty-pill" role="group" aria-label="Cantidad en el carrito: ${nombre}">
                <button type="button" data-menos="${p.id}" aria-label="Quitar uno">−</button>
                <span>${esc(cant(c))}</span>
                <button type="button" data-mas="${p.id}" aria-label="Agregar uno">+</button>
              </div>`
            : `<button class="add" type="button" data-agregar="${p.id}" aria-label="Agregar al carrito: ${nombre}">${ICONO_MAS}Agregar</button>`}</div>`}
        </div>
      </article>`;
  }

  /** Búsqueda, categoría, marca, precio, disponibilidad y orden se combinan. */
  function visibles() {
    const palabras = norm(S.buscar.trim()).split(/\s+/).filter(Boolean);
    const min = S.min === '' ? NaN : Number(S.min);
    const max = S.max === '' ? NaN : Number(S.max);
    const vendidos = new Map((S.tienda.masVendidos || []).map((id, i) => [Number(id), i]));
    const lista = S.productos.filter((p) => {
      if (S.categoria && p.categoria !== S.categoria) return false;
      if (S.marca && p.marca !== S.marca) return false;
      if (S.soloOfertas && !tieneOferta(p)) return false;
      if (S.soloDisponibles && p.agotado) return false;
      if (S.soloDestacados && !p.destacado) return false;
      if (S.soloMasVendidos && !vendidos.has(p.id)) return false;
      if (Number.isFinite(min) && precioFinal(p) < min) return false;
      if (Number.isFinite(max) && precioFinal(p) > max) return false;
      if (!palabras.length) return true;
      const texto = norm(`${p.nombre} ${p.descripcion} ${p.categoria} ${p.marca || ''}`);
      return palabras.every((w) => texto.includes(w));
    });
    const orden = {
      'precio-asc': (a, b) => precioFinal(a) - precioFinal(b),
      'precio-desc': (a, b) => precioFinal(b) - precioFinal(a),
      ofertas: (a, b) => descuentoDe(b) - descuentoDe(a),
      nuevos: masNuevoPrimero,
    }[S.orden] || (S.soloMasVendidos ? (a, b) => vendidos.get(a.id) - vendidos.get(b.id) : ordenPorDefecto);
    return lista.sort(orden);
  }

  function pieDeLista(total, mostrados) {
    const caja = $('#mas-caja');
    if (!caja) return;
    caja.innerHTML = total > mostrados
      ? `<span class="progreso">Mostrando ${mostrados} de ${total}</span>
         <button class="btn ghost" type="button" data-act="mas-productos">Ver más productos</button>`
      : '';
  }

  function pintarProductos({ arriba = false } = {}) {
    const box = $('#productos');
    // En la página de inicio no hay lista filtrable: se repintan las secciones.
    if (!box) { if (S.tienda) pintarCatalogo(); return; }
    const lista = visibles();
    const mostrar = lista.slice(0, S.limite);
    rota.io?.disconnect();
    rota.visibles.clear();
    box.innerHTML = mostrar.length ? mostrar.map(tarjeta).join('')
      : `<p class="empty">${S.buscar.trim() ? 'No encontramos ese producto. Prueba con otra palabra.' : 'No hay productos con estos filtros.'}</p>`;
    pintarEstadoFiltros(lista.length);
    pieDeLista(lista.length, mostrar.length);
    if (arriba) {
      const inicio = $('.cat-vista');
      const tope = inicio ? inicio.getBoundingClientRect().top + window.scrollY - ($('#top').offsetHeight || 0) : 0;
      if (window.scrollY > tope) window.scrollTo({ top: Math.max(0, tope) });
    }
    observarTarjetas(box);
  }

  function masProductos() {
    const lista = visibles();
    const desde = S.limite;
    S.limite += POR_PAGINA;
    const nuevos = lista.slice(desde, S.limite);
    const box = $('#productos');
    box.insertAdjacentHTML('beforeend', nuevos.map(tarjeta).join(''));
    pieDeLista(lista.length, Math.min(S.limite, lista.length));
    observarTarjetas(box);
  }

  /** Repinta las tarjetas de ese producto (sin perder el scroll ni el foco). Puede salir en varias secciones. */
  function pintarTarjeta(id) {
    const p = S.porId.get(id);
    if (!p) return;
    document.querySelectorAll(`.card[data-id="${Number(id)}"]`).forEach((vieja) => {
      rota.io?.unobserve(vieja);
      rota.visibles.delete(vieja);
      const marca = document.createElement('template');
      marca.innerHTML = tarjeta(p, { vitrina: vieja.closest('[data-vitrina]')?.dataset.vitrina }).trim();
      const nueva = marca.content.firstElementChild;
      // Las copias de la vitrina siguen fuera del teclado.
      if (vieja.closest('[data-copia]')) nueva.querySelectorAll('a, button, input').forEach((el) => el.setAttribute('tabindex', '-1'));
      conFoco(vieja, () => vieja.replaceWith(nueva), () => nueva);
      observarTarjetas(nueva);
    });
  }

  /** El producto vuela de su tarjeta al carrito. */
  function volarAlCarrito(origen) {
    if (SIN_MOVIMIENTO || !origen?.animate) return;
    const destino = ['#tb-cart', '#cart-btn', '#cart-flota'].map((s) => $(s)).find((el) => el && el.getBoundingClientRect().width > 0);
    const caja = origen.querySelector('.img, .sim-img, .thumb');
    if (!destino || !caja) return;
    const r = caja.getBoundingClientRect();
    const d = destino.getBoundingClientRect();
    const v = document.createElement('div');
    v.className = 'vuela';
    const foto = caja.querySelector('img');
    if (foto) { const i = new Image(); i.src = foto.src; i.alt = ''; v.appendChild(i); } else v.textContent = caja.querySelector('.emoji')?.textContent || '';
    const x = r.left + r.width / 2 - 32;
    const y = r.top + r.height / 2 - 32;
    v.style.left = `${x}px`;
    v.style.top = `${y}px`;
    document.body.appendChild(v);
    const dx = d.left + d.width / 2 - 32 - x;
    const dy = d.top + d.height / 2 - 32 - y;
    v.animate([
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      { transform: `translate(${dx * 0.55}px, ${dy * 0.55 - 36}px) scale(.72)`, opacity: 1, offset: 0.6 },
      { transform: `translate(${dx}px, ${dy}px) scale(.22)`, opacity: 0.2 },
    ], { duration: 620, easing: 'cubic-bezier(.3, .6, .2, 1)' }).onfinish = () => v.remove();
  }

  // ── Fotos que pasan solas en las tarjetas ───────────────────────────────
  // Solo las tarjetas que se ven en pantalla (al hacer scroll empiezan las
  // nuevas y se detienen las que salen). Cada una a su ritmo, con fundido; se
  // detiene con el mouse encima, con el detalle/carrito abierto, con la
  // pestaña oculta o con "reducir movimiento". La foto siguiente se descarga
  // justo antes de mostrarla (no se gastan datos en fotos que nadie ve).
  const ROTA_MS = 3500;
  const rota = { io: null, timer: null, visibles: new Set(), indice: new Map(), proxima: new WeakMap() };

  function observarTarjetas(raiz) {
    if (SIN_MOVIMIENTO || !('IntersectionObserver' in window) || !raiz) return;
    if (!rota.io) {
      rota.io = new IntersectionObserver((entradas) => {
        for (const en of entradas) {
          if (en.isIntersecting) {
            rota.visibles.add(en.target);
            if (!rota.proxima.has(en.target)) rota.proxima.set(en.target, Date.now() + 1500 + Math.random() * 2000);
          } else {
            rota.visibles.delete(en.target);
          }
        }
      }, { threshold: 0.6 });
      rota.timer = setInterval(tickRotacion, 500);
    }
    const cards = raiz.matches?.('.card[data-rota]') ? [raiz] : raiz.querySelectorAll('.card[data-rota]');
    cards.forEach((c) => rota.io.observe(c));
  }

  function tickRotacion() {
    if (document.hidden || S.detalle || S.panel) return;
    const ahora = Date.now();
    for (const card of rota.visibles) {
      if (!card.isConnected) { rota.visibles.delete(card); continue; }
      if ((rota.proxima.get(card) || 0) > ahora || card.dataset.cambiando || card.matches(':hover')) continue;
      rota.proxima.set(card, ahora + ROTA_MS);
      siguienteFoto(card);
    }
  }

  function siguienteFoto(card) {
    const p = S.porId.get(Number(card.dataset.id));
    const fotos = p ? fotosDe(p) : [];
    if (fotos.length < 2) return;
    const i = ((rota.indice.get(p.id) || 0) + 1) % fotos.length;
    const url = fotos[i];
    card.dataset.cambiando = '1';
    const pre = new Image();
    pre.onload = () => {
      delete card.dataset.cambiando;
      const vieja = card.querySelector('.img img');
      if (!card.isConnected || !vieja) return;
      rota.indice.set(p.id, i);
      const nueva = document.createElement('img');
      nueva.src = url;
      nueva.alt = '';
      nueva.draggable = false;
      nueva.dataset.pid = String(p.id);
      nueva.className = 'entrando';
      vieja.after(nueva);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        nueva.classList.remove('entrando');
        vieja.classList.add('saliendo');
      }));
      setTimeout(() => vieja.remove(), 700);
      const badge = card.querySelector('.nfotos');
      if (badge) badge.textContent = `${i + 1}/${fotos.length}`;
    };
    pre.onerror = () => {
      delete card.dataset.cambiando;
      FOTOS_ROTAS.add(url);
    };
    pre.src = url;
  }

  // ── Detalle del producto (modal) ────────────────────────────────────────
  function maxDetalle(p) {
    const tope = p.disponible === null ? MAX_DETALLE : Math.min(MAX_DETALLE, p.disponible);
    return Math.max(paso(p), tope);
  }
  function ajustarCantidad(p, v) {
    let n = Number(v);
    if (!Number.isFinite(n)) n = 1;
    n = p.modoVenta === 'unidad' ? Math.round(n) : round2(n);
    return Math.min(maxDetalle(p), Math.max(paso(p), n));
  }

  /** Lo que se sabe del producto (sin inventar nada que el POS no tenga). */
  function especificaciones(p) {
    const lista = [`Categoría: ${p.categoria || 'General'}`];
    if (p.marca) lista.push(`Marca: ${p.marca}`);
    const u = norm(p.unidad);
    lista.push(p.modoVenta === 'unidad'
      ? `Se vende por unidad${p.unidad && !['unidad', 'und', 'u'].includes(u) ? ` (${p.unidad})` : ''}`
      : `Se vende por ${p.unidad} (puedes pedir fracciones)`);
    if (p.agotado) lista.push('Disponibilidad: agotado por ahora');
    else if (p.disponible !== null && p.disponible <= 10) lista.push(`Disponibilidad: quedan ${cant(p.disponible)}`);
    else lista.push('Disponibilidad: en existencia');
    lista.push(p.conItbis ? 'ITBIS: se suma al total del pedido' : 'Precio final: no lleva ITBIS adicional');
    if (descPct(p) > 0) lista.push(`Descuento: ${cant(descPct(p))}% aplicado`);
    if (p.promocion && norm(p.promocion) !== 'oferta') lista.push(`Oferta: ${p.promocion}`);
    if (p.porCantidad) lista.push(`Llevando ${cant(p.porCantidad.cantidadMinima)} o más: ${money(p.porCantidad.precio)} c/u`);
    return lista;
  }

  function similaresDe(p) {
    const ref = precioFinal(p);
    return S.productos
      .filter((x) => x.id !== p.id && x.categoria === p.categoria && !x.agotado)
      .sort((a, b) => Math.abs(precioFinal(a) - ref) - Math.abs(precioFinal(b) - ref))
      .slice(0, 4);
  }

  function similarHtml(x) {
    return `<div class="sim-card">
      <button class="ver" type="button" data-ver="${x.id}" aria-label="Ver detalle: ${esc(x.nombre)}"></button>
      <div class="sim-img ${cajaClase(x)}">${imagenHtml(x)}</div>
      <button class="mini" type="button" data-agregar="${x.id}" aria-label="Agregar al carrito: ${esc(x.nombre)}">${ICONO_MAS}</button>
      <div class="sim-body"><div class="sim-name">${esc(x.nombre)}</div><div class="sim-price">${money(precioFinal(x))}</div></div>
    </div>`;
  }

  // Secciones desplegables del detalle: se recuerda cuáles abrió el cliente.
  const ACORDEON = new Set();
  const ICONO_FLECHA = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  const ICONO_LISTA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>';

  function seccion(clave, titulo, icono, contenido) {
    return `<details class="acc-item" data-acc="${clave}" ${ACORDEON.has(clave) ? 'open' : ''}>
      <summary><span class="acc-ico" aria-hidden="true">${icono}</span><span class="acc-tit">${titulo}</span>${ICONO_FLECHA}</summary>
      <div class="acc-body">${contenido}</div>
    </details>`;
  }

  /** Cómo se entrega y se paga (lo que configuró el negocio). */
  function entregaYPagoHtml() {
    const t = S.tienda;
    const filas = [];
    if (t.retiro?.habilitado !== false) filas.push(`<li><b>Retiro en tienda</b>${t.direccion ? ` · ${esc(t.direccion)}` : ''}</li>`);
    if (t.delivery?.habilitado) {
      const costos = (t.delivery.zonas || []).map((z) => Number(z.costo) || 0);
      const desde = costos.length ? Math.min(...costos) : null;
      filas.push(`<li><b>Delivery</b>${desde !== null ? ` · desde ${money(desde)}` : ''}${(t.delivery.zonas || []).length ? ` · ${esc(t.delivery.zonas.slice(0, 4).map((z) => z.nombre).join(', '))}${t.delivery.zonas.length > 4 ? '…' : ''}` : ''}</li>`);
    }
    if (t.pagos?.length) filas.push(`<li><b>Pagos:</b> ${esc(t.pagos.map((p) => p.etiqueta).join(', '))}</li>`);
    if (t.pedidoMinimo) filas.push(`<li><b>Pedido mínimo:</b> ${money(t.pedidoMinimo)}</li>`);
    const hoy = horarioHoy(t);
    if (hoy) filas.push(`<li><b>Horario:</b> ${esc(hoy)}</li>`);
    return filas.length ? `<ul class="det-specs">${filas.join('')}</ul>` : '<p class="muted">Pregunta a la tienda por WhatsApp.</p>';
  }

  /** Precio por unidad para esa cantidad (con la regla "llevando N o más"). Es un estimado: el total real lo da /cotizar. */
  function precioUnidadPara(p, q) {
    const regla = p.porCantidad;
    const base = regla && q >= Number(regla.cantidadMinima || 0) ? Number(regla.precio) : Number(p.precio);
    return round2(base * (1 - descPct(p) / 100));
  }

  function detalleHtml(p) {
    const fav = S.favoritos.includes(p.id);
    const desc = descuentoDe(p);
    const antes = precioAntesDe(p);
    const enCarrito = cantidadDe(p.id);
    const similares = similaresDe(p);
    const larga = String(p.descripcion || '').length > 160;
    const rapida = Boolean(S.detalle?.rapida);
    return `
      <div class="det-grid">
        <div class="det-media">
          ${carruselHtml(p, `${desc > 0 ? `<span class="off">-${desc}%</span>` : ''}${p.agotado ? '<span class="soldout">Agotado</span>' : ''}`)}
          ${miniaturasHtml(p)}
        </div>
        <div class="det-info">
          <div class="det-tags">
            ${p.categoria ? `<span class="det-cat">${esc(p.categoria)}</span>` : ''}
            ${esNuevo(p) ? '<span class="det-cat nuevo">Nuevo</span>' : ''}
            ${p.destacado ? '<span class="det-cat star">★ Destacado</span>' : ''}
            ${p.agotado ? '<span class="det-cat bad">Agotado</span>' : p.disponible !== null && p.disponible <= 10 ? `<span class="det-cat warn">Quedan ${esc(cant(p.disponible))}</span>` : '<span class="det-cat ok">Disponible</span>'}
          </div>
          <div class="det-head">
            <h2 id="modal-title">${esc(p.nombre)}</h2>
            <button class="det-fav${fav ? ' on' : ''}" type="button" data-fav="${p.id}" aria-pressed="${fav}" aria-label="${fav ? 'Quitar de' : 'Agregar a'} favoritos">${ICO.corazon}</button>
          </div>
          <div class="det-price">
            <span class="now">${money(precioFinal(p))}${unidadHtml(p)}</span>
            ${antes ? `<s>${money(antes)}</s>` : ''}
            ${desc > 0 ? `<span class="off">-${desc}%</span>` : ''}
          </div>
          ${p.conItbis ? '<p class="det-nota">+ ITBIS al pagar</p>' : ''}
          ${p.porCantidad ? `<p class="det-promo">Llevando ${esc(cant(p.porCantidad.cantidadMinima))} o más: ${money(p.porCantidad.precio)} c/u</p>` : ''}
          ${enCarrito > 0 ? `<p class="det-cart">Ya tienes ${esc(cant(enCarrito))} en tu carrito · <button class="link" type="button" data-act="ver-carrito-detalle">Ver carrito</button></p>` : ''}
          ${p.descripcion ? `<p class="det-desc${larga ? ' clamp' : ''}" id="det-desc">${esc(p.descripcion)}</p>
            ${larga ? '<button class="link det-vermas" type="button" data-act="ver-mas">Ver más</button>' : ''}` : ''}
          ${rapida ? `<button class="link det-completo" type="button" data-act="detalle-completo">Ver todos los detalles</button>` : `<div class="acc">
            ${seccion('specs', 'Especificaciones', ICONO_LISTA, `<ul class="det-specs">${especificaciones(p).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`)}
            ${seccion('entrega', 'Entrega y pago', ICO.moto, entregaYPagoHtml())}
          </div>`}
        </div>
      </div>
      ${!rapida && similares.length ? `<h3 class="det-sub sim">Productos similares</h3><div class="sim-grid">${similares.map(similarHtml).join('')}</div>` : ''}`;
  }

  /** Barra de compra fija abajo: cantidad y "Agregar · total". */
  function detallePieHtml(p) {
    if (p.agotado) return '<button class="btn big det-add" type="button" disabled>Agotado por ahora</button>';
    const q = ajustarCantidad(p, S.detalle.cantidad);
    return `
      <div class="det-qty qty-pill grande">
        <button type="button" data-det="menos" aria-label="Quitar uno" ${q <= paso(p) ? 'disabled' : ''}>−</button>
        <input id="det-cant" type="number" inputmode="decimal" min="${paso(p)}" max="${maxDetalle(p)}" step="${paso(p)}" value="${esc(q)}" aria-label="Cantidad${p.modoVenta === 'unidad' ? '' : ` en ${esc(p.unidad)}`}">
        <button type="button" data-det="mas" aria-label="Agregar uno" ${q >= maxDetalle(p) ? 'disabled' : ''}>+</button>
      </div>
      <button class="btn big det-add" type="button" data-act="agregar-detalle">
        <span class="det-add-txt">Agregar</span><span class="det-add-total" id="det-total">${money(precioUnidadPara(p, q) * q)}</span>
      </button>`;
  }

  // ── Carrusel de fotos (detalle) ─────────────────────────────────────────
  const CAR = { pid: null, i: 0, n: 0, timer: null, reanudar: null, arrastre: null };

  function carruselHtml(p, marcas) {
    const fotos = fotosDe(p);
    if (fotos.length < 2) {
      // Una sola foto (o ninguna): imagen fija, sin controles.
      return `<div class="car estatico ${cajaClase(p)}">${imagenHtml(p, { lazy: false })}${marcas}</div>`;
    }
    const nombre = esc(p.nombre);
    return `
      <div class="car foto" id="car" role="region" aria-roledescription="carrusel" aria-label="Fotos de ${nombre}">
        <div class="car-track" id="car-track">
          ${fotos.map((url, i) => `<div class="car-slide" role="group" aria-roledescription="foto" aria-label="${i + 1} de ${fotos.length}">
            <img src="${esc(url)}" alt="${i ? '' : nombre}" draggable="false" data-pid="${p.id}"></div>`).join('')}
        </div>
        <button class="car-arrow prev" type="button" data-car="prev" aria-label="Foto anterior">${ICO.flechaIzq}</button>
        <button class="car-arrow next" type="button" data-car="next" aria-label="Foto siguiente">${ICO.flecha}</button>
        <div class="car-dots">${fotos.map((_, i) => `<button class="dot" type="button" data-car-ir="${i}" aria-label="Ver foto ${i + 1}"></button>`).join('')}</div>
        ${marcas}
      </div>`;
  }

  /** Las fotos en pequeño debajo de la grande (computadora). */
  function miniaturasHtml(p) {
    const fotos = fotosDe(p);
    if (fotos.length < 2) return '';
    return `<div class="miniaturas">${fotos.map((url, i) => `<button type="button" data-car-ir="${i}" aria-label="Ver foto ${i + 1}"><img src="${esc(url)}" alt="" loading="lazy"></button>`).join('')}</div>`;
  }

  function irSlide(i, animar = true) {
    const track = $('#car-track');
    if (!track || !CAR.n) return;
    CAR.i = ((i % CAR.n) + CAR.n) % CAR.n;
    track.style.transition = animar ? '' : 'none';
    track.style.transform = `translateX(${-CAR.i * 100}%)`;
    document.querySelectorAll('#car .dot').forEach((d, k) => {
      d.classList.toggle('active', k === CAR.i);
      d.setAttribute('aria-current', k === CAR.i ? 'true' : 'false');
    });
    document.querySelectorAll('.miniaturas button').forEach((b, k) => b.classList.toggle('on', k === CAR.i));
  }

  function iniciarAuto() {
    clearInterval(CAR.timer);
    CAR.timer = null;
    if (SIN_MOVIMIENTO || CAR.n < 2 || !$('#car')) return;
    CAR.timer = setInterval(() => irSlide(CAR.i + 1), SLIDE_MS);
  }

  /** El cliente tocó el carrusel: se detiene y sigue solo 5 s después. */
  function pausarAuto() {
    clearInterval(CAR.timer);
    CAR.timer = null;
    clearTimeout(CAR.reanudar);
    CAR.reanudar = setTimeout(iniciarAuto, REANUDAR_MS);
  }

  function pararCarrusel() {
    clearInterval(CAR.timer);
    clearTimeout(CAR.reanudar);
    CAR.timer = null;
    CAR.reanudar = null;
    CAR.arrastre = null;
  }

  function iniciarCarrusel(pid) {
    pararCarrusel();
    const car = $('#car');
    const inicio = CAR.pid === pid ? CAR.i : 0; // al repintar el mismo producto no vuelve a la 1.ª foto
    CAR.pid = pid;
    CAR.n = car ? car.querySelectorAll('.car-slide').length : 0;
    if (!car) { CAR.i = 0; return; }
    irSlide(Math.min(inicio, CAR.n - 1), false);
    const track = $('#car-track');
    // Deslizar con el dedo o arrastrar con el mouse (Pointer Events cubre ambos).
    car.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      CAR.arrastre = { x: e.clientX, dx: 0, id: e.pointerId };
      try { car.setPointerCapture(e.pointerId); } catch (_e) { /* sin captura */ }
      track.style.transition = 'none';
      car.classList.add('arrastrando');
      pausarAuto();
    });
    car.addEventListener('pointermove', (e) => {
      const a = CAR.arrastre;
      if (!a || e.pointerId !== a.id) return;
      a.dx = e.clientX - a.x;
      track.style.transform = `translateX(calc(${-CAR.i * 100}% + ${a.dx}px))`;
    });
    const soltar = (e) => {
      const a = CAR.arrastre;
      if (!a || e.pointerId !== a.id) return;
      CAR.arrastre = null;
      car.classList.remove('arrastrando');
      if (a.dx <= -UMBRAL_ARRASTRE) irSlide(CAR.i + 1);
      else if (a.dx >= UMBRAL_ARRASTRE) irSlide(CAR.i - 1);
      else irSlide(CAR.i);
      pausarAuto();
    };
    car.addEventListener('pointerup', soltar);
    car.addEventListener('pointercancel', soltar);
    iniciarAuto();
  }

  /** Una foto que no carga se quita del carrusel (o queda el emoji si era la única). */
  function quitarSlide(slide) {
    const car = slide.closest('.car');
    const p = S.porId.get(CAR.pid);
    const k = [...car.querySelectorAll('.car-slide')].indexOf(slide);
    slide.remove();
    car.querySelectorAll('.dot')[k]?.remove();
    CAR.n = car.querySelectorAll('.car-slide').length;
    car.querySelectorAll('.dot').forEach((d, j) => { d.dataset.carIr = String(j); d.setAttribute('aria-label', `Ver foto ${j + 1}`); });
    if (CAR.n <= 1) car.classList.add('uno');
    if (!CAR.n && p) {
      car.classList.remove('foto');
      car.classList.add(fondoDe(p), 'estatico');
      car.insertAdjacentHTML('afterbegin', `<span class="emoji" aria-hidden="true">${emojiDe(p)}</span>`);
      pararCarrusel();
      return;
    }
    irSlide(Math.min(CAR.i, CAR.n - 1), false);
    if (CAR.n < 2) pararCarrusel();
  }

  function pintarDetalle() {
    if (!S.detalle) return;
    const p = S.porId.get(S.detalle.id);
    if (!p) { cerrarDetalle(); return; }
    const body = $('#modal-body');
    const pie = $('#modal-foot');
    conFoco($('#modal'), () => {
      body.innerHTML = detalleHtml(p);
      pie.innerHTML = detallePieHtml(p);
    });
    iniciarCarrusel(p.id);
    // "Ver más" solo si el texto de verdad quedó cortado en este tamaño de pantalla.
    const descr = $('#det-desc.clamp');
    if (descr && !descr.classList.contains('abierta') && descr.scrollHeight <= descr.clientHeight + 1) $('.det-vermas')?.remove();
    const inp = $('#det-cant');
    if (inp) {
      inp.addEventListener('input', (e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v) && v > 0) { S.detalle.cantidad = v; pintarTotalDetalle(p); }
      });
      inp.addEventListener('change', () => { S.detalle.cantidad = ajustarCantidad(p, S.detalle.cantidad); actualizarSelector(p); });
    }
  }

  function pintarTotalDetalle(p) {
    const q = ajustarCantidad(p, S.detalle.cantidad);
    const total = $('#det-total');
    if (total) total.textContent = money(precioUnidadPara(p, q) * q);
  }

  function actualizarSelector(p) {
    const q = ajustarCantidad(p, S.detalle.cantidad);
    S.detalle.cantidad = q;
    const inp = $('#det-cant');
    if (inp) inp.value = String(q);
    const menos = $('[data-det="menos"]');
    const mas = $('[data-det="mas"]');
    if (menos) menos.disabled = q <= paso(p);
    if (mas) mas.disabled = q >= maxDetalle(p);
    pintarTotalDetalle(p);
  }

  function abrirDetalle(id, { rapida = false, desdeUrl = false } = {}) {
    const p = S.porId.get(id);
    if (!p) return;
    const yaAbierto = Boolean(S.detalle);
    S.detalle = { id, cantidad: 1, rapida };
    $('#modal').classList.toggle('rapida', rapida);
    // Cada producto tiene su enlace (?p=id): se puede compartir por WhatsApp.
    const urlProducto = `${location.pathname}?p=${id}`;
    if (yaAbierto) {
      try { history.replaceState(history.state, '', urlProducto); } catch (_e) { /* sin historial */ }
      // Producto similar: cambia el contenido con un fundido corto, sin cerrar.
      const body = $('#modal-body');
      body.classList.add('cambiando');
      setTimeout(() => { pintarDetalle(); body.scrollTop = 0; body.classList.remove('cambiando'); }, 150);
      return;
    }
    S.abridorDetalle = document.activeElement;
    if (!desdeUrl) {
      try { history.pushState({ tcDetalle: true, tcCatalogo: Boolean(history.state?.tcCatalogo) }, '', urlProducto); } catch (_e) { /* sin historial */ }
    }
    pintarDetalle();
    $('#modal-body').scrollTop = 0;
    $('#modal').classList.add('open');
    $('#modal-overlay').classList.add('open');
    document.body.classList.add('lock');
    $('#modal .modal-x').focus({ preventScroll: true });
  }

  /** Cerrar con ✕, fondo o Esc: si se abrió con historial, "atrás" lo cierra (botón atrás del teléfono). */
  function cerrarDetalle() {
    if (!S.detalle || S.cerrandoDetalle) return;
    if (history.state && history.state.tcDetalle) {
      S.cerrandoDetalle = true;
      history.back();
      setTimeout(() => { if (S.detalle) ocultarDetalle(); }, 400);
    } else ocultarDetalle();
  }

  function ocultarDetalle() {
    S.detalle = null;
    S.cerrandoDetalle = false;
    pararCarrusel();
    CAR.pid = null;
    $('#modal').classList.remove('open');
    $('#modal-overlay').classList.remove('open');
    if (!S.panel) document.body.classList.remove('lock');
    if (new URLSearchParams(location.search).has('p')) {
      try { history.replaceState(history.state, '', location.pathname); } catch (_e) { /* sin historial */ }
    }
    // El foco vuelve a quien abrió el detalle, si sigue a la vista (con el panel abierto, solo si está en el panel).
    const a = S.abridorDetalle;
    S.abridorDetalle = null;
    if (a && document.contains(a) && !$('#modal').contains(a) && (!S.panel || $('#panel').contains(a))) a.focus({ preventScroll: true });
  }

  function agregarDesdeDetalle() {
    const p = S.detalle && S.porId.get(S.detalle.id);
    if (!p) return;
    S.detalle.cantidad = ajustarCantidad(p, $('#det-cant')?.value ?? S.detalle.cantidad);
    if (!agregar(p.id, S.detalle.cantidad)) {
      if (!p.agotado) toast(`Ya tienes en el carrito todo lo disponible de ${p.nombre}.`, { error: true });
      return;
    }
    // Confirmación en el mismo botón (el pie ya se repintó con el carrito nuevo).
    const boton = $('#modal-foot .det-add');
    const txt = boton?.querySelector('.det-add-txt');
    if (!boton || !txt) return;
    boton.classList.add('hecho');
    txt.textContent = '✓ Agregado';
    setTimeout(() => {
      if (!boton.isConnected) return;
      boton.classList.remove('hecho');
      txt.textContent = 'Agregar';
    }, 1400);
  }

  // ── Panel lateral: carrito → datos → listo, y favoritos ──────────────────
  async function cotizar() {
    const n = ++S.cotN;
    if (!S.carrito.items.length) { S.cot = null; return; }
    let r;
    try {
      r = await api('/cotizar', {
        method: 'POST',
        body: { items: S.carrito.items, entrega: { tipo: S.entrega, zonaId: S.zonaId } },
      });
    } catch (e) {
      r = { lineas: [], totales: null, errores: [{ error: e.message }] };
    }
    if (n === S.cotN) S.cot = r; // si llegó una respuesta vieja, se ignora
  }

  /** Recalcula y repinta solo si el cliente sigue en el mismo paso. */
  function recotizar() {
    const donde = S.panel;
    cotizar().then(() => {
      if (S.panel !== donde) return;
      if (donde === 'datos') { const box = $('#panel-totales'); if (box) box.innerHTML = totalesHtml(S.cot?.totales); }
      else pintarPanel();
    });
  }

  function abrirPanel(tipo) {
    if (!S.tienda) return;
    if (!S.panel) S.abridor = document.activeElement;
    S.panel = tipo;
    $('#panel').classList.add('open');
    $('#overlay').classList.add('open');
    document.body.classList.add('lock');
    if (tipo === 'pedidos') S.misPedidos = null;
    pintarPanel();
    if (tipo === 'carrito') recotizar();
    if (tipo === 'pedidos') cargarMisPedidos();
    $('#panel .x').focus({ preventScroll: true });
  }

  function cerrarPanel() {
    if (S.panel === 'datos') recordarForm();
    S.panel = '';
    $('#panel').classList.remove('open', 'ancho');
    $('#overlay').classList.remove('open');
    pintarTabbar();
    if (S.detalle) return;
    document.body.classList.remove('lock');
    S.abridor?.focus?.({ preventScroll: true });
    S.abridor = null;
  }

  function irA(destino) {
    if (S.panel === 'datos') recordarForm();
    S.panel = destino;
    if (destino === 'pedidos') S.misPedidos = null;
    pintarPanel();
    $('#panel-content').scrollTop = 0;
    if (destino === 'carrito') recotizar();
    if (destino === 'pedidos') cargarMisPedidos();
  }

  /** Barra de abajo del teléfono. */
  function navegar(destino) {
    if (destino === 'inicio') { irAlInicio(); return; }
    if (destino === 'ofertas') {
      if (S.panel) cerrarPanel();
      if (!S.productos.some(tieneOferta)) { toast('Esta tienda no tiene ofertas ahora.'); pintarTabbar(); return; }
      irDestino('ofertas');
      return;
    }
    if (S.panel) irA(destino);
    else abrirPanel(destino);
  }

  function totalesHtml(t) {
    if (!t) return '';
    return `<div class="totals">
      <span>Subtotal</span><span>${money(t.subtotal)}</span>
      ${t.descuento ? `<span>Descuento</span><span>− ${money(t.descuento)}</span>` : ''}
      ${t.itbis ? `<span>ITBIS</span><span>${money(t.itbis)}</span>` : ''}
      ${S.entrega === 'delivery' ? `<span>Delivery</span><span>${money(t.delivery + t.deliveryItbis)}</span>` : ''}
      ${t.ahorroPromociones ? `<span class="muted">Ahorras</span><span class="muted">${money(t.ahorroPromociones)}</span>` : ''}
      <span class="g">Total</span><span class="g">${money(t.total)}</span>
    </div>`;
  }

  function miniatura(p) {
    return `<div class="thumb ${cajaClase(p)}">${imagenHtml(p)}</div>`;
  }

  const ICONO_BASURA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>';
  const ICONO_CARRITO = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="20" r="1.6"/><circle cx="18" cy="20" r="1.6"/><path d="M2 3h3l2.6 12.2a1 1 0 0 0 1 .8h9.7a1 1 0 0 0 1-.8L21 7H6.2"/></svg>';

  /** Carrito como tarjetas: foto, nombre, basura, cantidad y precio (estilo app). */
  function panelCarrito(t) {
    if (!S.carrito.items.length) {
      return {
        contenido: `<div class="vacio">${ICONO_CARRITO}<p>Tu carrito está vacío.</p><span class="muted">Toca "Agregar" en un producto para guardarlo aquí.</span></div>`,
        pie: '<button class="btn big" type="button" data-act="cerrar">Ver productos</button>',
      };
    }
    const errores = new Map((S.cot?.errores || []).filter((e) => e.productoId).map((e) => [e.productoId, e.error]));
    const lineas = S.carrito.items.map((i) => {
      const p = S.porId.get(i.productoId);
      if (!p) {
        return `<div class="ci"><div class="ci-img g0"><span class="emoji" aria-hidden="true">❔</span></div>
          <div class="ci-body"><div class="ci-top"><span class="ci-name">Producto no disponible</span>
          <button class="ci-del" type="button" data-quitar="${i.productoId}" aria-label="Eliminar">${ICONO_BASURA}</button></div></div></div>`;
      }
      const l = S.cot?.lineas?.find((x) => x.productoId === i.productoId);
      const nota = [
        l?.promocion ? esc(l.promocion) : '',
        descPct(p) > 0 ? `${esc(cant(descPct(p)))}% desc.` : '',
      ].filter(Boolean).join(' · ');
      return `<div class="ci">
        <div class="ci-img ${cajaClase(p)}">${imagenHtml(p, { lazy: false })}</div>
        <div class="ci-body">
          <div class="ci-top">
            <span class="ci-name">${esc(p.nombre)}</span>
            <button class="ci-del" type="button" data-quitar="${p.id}" aria-label="Eliminar ${esc(p.nombre)}">${ICONO_BASURA}</button>
          </div>
          <span class="ci-meta">${money(l ? l.precioUnitario : precioFinal(p))} c/u${unidadHtml(p) ? ` ${unidadHtml(p)}` : ''}${nota ? ` · ${nota}` : ''}</span>
          <div class="ci-bot">
            <div class="qty-pill">
              <button type="button" data-menos="${p.id}" aria-label="Quitar uno">−</button>
              <span>${esc(cant(i.cantidad))}</span>
              <button type="button" data-mas="${p.id}" aria-label="Agregar uno">+</button>
            </div>
            <span class="ci-price">${l ? money(l.total) : '…'}</span>
          </div>
          ${errores.has(p.id) ? `<span class="err">${esc(errores.get(p.id))}</span>` : ''}
        </div>
      </div>`;
    }).join('');
    const general = (S.cot?.errores || []).filter((e) => !e.productoId).map((e) => `<div class="alert err">${esc(e.error)}</div>`).join('');
    const tot = S.cot?.totales;
    const minimo = t.pedidoMinimo && tot && (tot.total - tot.delivery - tot.deliveryItbis) < t.pedidoMinimo
      ? `<div class="alert warn">El pedido mínimo es ${money(t.pedidoMinimo)}.</div>` : '';
    const bloqueado = !tot || (S.cot.errores || []).length || minimo || (!t.abierta && !t.aceptaFueraDeHorario);
    return {
      contenido: `${general}<div class="ci-list">${lineas}</div>`,
      pie: `${totalesHtml(tot)}${minimo}
        <button class="btn big" type="button" data-act="datos" ${bloqueado ? 'disabled' : ''}>Comprar ahora</button>
        <button class="btn-link" type="button" data-act="cerrar">Seguir comprando</button>`,
    };
  }

  // ── Mis pedidos (los hechos desde este teléfono) ────────────────────────
  const ESTADO_CLASE = { entregado: 'ok', cancelado: 'bad', rechazado: 'bad' };

  async function cargarMisPedidos() {
    const hist = leerJSON(`tc-pedidos-${SLUG}`, []);
    const lista = await Promise.all((Array.isArray(hist) ? hist : []).slice(0, 10).map(async (h) => {
      try {
        const u = new URL(h.url, location.origin);
        const id = u.pathname.split('/').filter(Boolean)[3];
        const p = await api(`/pedidos/${encodeURIComponent(id)}?k=${encodeURIComponent(u.searchParams.get('k') || '')}`);
        return { url: h.url, numero: p.numero, estado: p.estado, etiqueta: p.estadoEtiqueta, total: p.totales?.total, en: p.creadoEn || h.en, entrega: p.entrega?.tipo };
      } catch (_e) {
        return { url: h.url, numero: h.numero, estado: '', etiqueta: 'No disponible', total: null, en: h.en };
      }
    }));
    S.misPedidos = lista;
    if (S.panel === 'pedidos') pintarPanel();
  }

  function panelPedidos() {
    if (S.misPedidos === null) {
      return { contenido: '<p class="empty">Buscando tus pedidos…</p>', pie: '' };
    }
    if (!S.misPedidos.length) {
      return {
        contenido: '<div class="vacio"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.5h12v19l-3-2-3 2-3-2-3 2z"/><path d="M9 7.5h6M9 11.5h6M9 15.5h4"/></svg><p>Aún no tienes pedidos.</p><span class="muted">Aquí verás los pedidos que hagas desde este teléfono o computadora.</span></div>',
        pie: '<button class="btn big" type="button" data-act="cerrar">Ver productos</button>',
      };
    }
    return {
      contenido: `<div class="mp-list">${S.misPedidos.map((p) => `
        <a class="mp" href="${esc(p.url)}">
          <span class="mp-top"><strong>Pedido #${esc(p.numero)}</strong>
            <span class="mp-estado ${ESTADO_CLASE[p.estado] || (p.estado ? 'activo' : '')}">${esc(p.etiqueta || '')}</span></span>
          <span class="mp-meta">${esc(fecha(p.en))}${p.entrega ? ` · ${p.entrega === 'delivery' ? 'Delivery' : 'Retiro en tienda'}` : ''}</span>
          <span class="mp-bot">${p.total !== null && p.total !== undefined ? `<b>${money(p.total)}</b>` : '<span></span>'}<span class="mp-ver">Ver pedido ›</span></span>
        </a>`).join('')}</div>`,
      pie: '<button class="btn-link" type="button" data-act="cerrar">Seguir comprando</button>',
    };
  }

  function panelFavoritos() {
    const favs = S.favoritos.map((id) => S.porId.get(id)).filter(Boolean);
    const contenido = favs.length
      ? favs.map((p) => {
        const c = cantidadDe(p.id);
        return `<div class="fav-line">
          <button class="abrir" type="button" data-ver="${p.id}" aria-label="Ver detalle: ${esc(p.nombre)}">
            ${miniatura(p)}
            <span class="fi"><span class="n">${esc(p.nombre)}</span>
              <span class="meta">${money(precioFinal(p))}${p.agotado ? ' · Agotado' : c > 0 ? ` · ${esc(cant(c))} en el carrito` : ''}</span></span>
          </button>
          <div class="fa">
            ${p.agotado ? '' : `<button class="mini" type="button" data-agregar="${p.id}" aria-label="Agregar al carrito: ${esc(p.nombre)}">${ICONO_MAS}</button>`}
            <button class="mini ghost" type="button" data-fav="${p.id}" aria-label="Quitar de favoritos: ${esc(p.nombre)}">✕</button>
          </div>
        </div>`;
      }).join('')
      : '<p class="empty">Aún no tienes favoritos.<br>Toca el corazón en un producto para guardarlo aquí.</p>';
    return {
      contenido,
      pie: `${S.carrito.items.length ? '<button class="btn" type="button" data-act="ver-carrito">Ver carrito</button>' : ''}
        <button class="btn ghost" type="button" data-act="cerrar">Seguir comprando</button>`,
    };
  }

  function panelDatos(t) {
    const c = leerJSON(KEY_CLIENTE, {});
    const zonas = t.delivery?.zonas || [];
    if (!S.pago && t.pagos.length) S.pago = t.pagos[0].codigo;
    if (S.entrega === 'retiro' && t.retiro?.habilitado === false) S.entrega = 'delivery';
    const contenido = `
      <form class="f" id="form" novalidate>
        <div class="legend">Tus datos</div>
        <label>Nombre<input name="nombre" required maxlength="120" autocomplete="name" value="${esc(c.nombre || '')}"></label>
        <div class="row2">
          <label>Teléfono<input name="telefono" required inputmode="tel" autocomplete="tel" maxlength="20" value="${esc(c.telefono || '')}"></label>
          <label>WhatsApp<input name="whatsapp" inputmode="tel" maxlength="20" placeholder="Igual al teléfono" value="${esc(c.whatsapp || '')}"></label>
        </div>
        <label>Correo (opcional)<input name="email" type="email" maxlength="160" autocomplete="email" value="${esc(c.email || '')}"></label>
        <div class="legend">Entrega</div>
        <div class="seg">
          ${t.retiro?.habilitado !== false ? `<button type="button" data-entrega="retiro" class="${S.entrega === 'retiro' ? 'on' : ''}">Retiro en tienda</button>` : ''}
          ${t.delivery?.habilitado ? `<button type="button" data-entrega="delivery" class="${S.entrega === 'delivery' ? 'on' : ''}">Delivery</button>` : ''}
        </div>
        ${S.entrega === 'retiro' && t.retiro?.instrucciones ? `<div class="muted">${esc(t.retiro.instrucciones)}</div>` : ''}
        ${S.entrega === 'delivery' ? `
          ${zonas.length ? `<label>Zona<select name="zona" id="zona"><option value="">Elige tu zona</option>${zonas.map((z) => `<option value="${esc(z.id)}" ${S.zonaId === z.id ? 'selected' : ''}>${esc(z.nombre)} — ${money(z.costo)}</option>`).join('')}</select></label>` : ''}
          <label>Dirección<input name="direccion" required maxlength="255" autocomplete="street-address" value="${esc(c.direccion || '')}"></label>
          <div class="row2">
            <label>Sector / barrio<input name="sector" required maxlength="120" value="${esc(c.sector || '')}"></label>
            <label>Municipio<input name="municipio" maxlength="120" value="${esc(c.municipio || '')}"></label>
          </div>
          <div class="row2">
            <label>Provincia<input name="provincia" maxlength="120" value="${esc(c.provincia || '')}"></label>
            <label>Referencia<input name="referencia" maxlength="255" placeholder="Cerca de…" value="${esc(c.referencia || '')}"></label>
          </div>
          ${t.delivery?.instrucciones ? `<div class="muted">${esc(t.delivery.instrucciones)}</div>` : ''}` : ''}
        <div class="legend">Pago</div>
        ${t.pagos.map((p) => `<label class="opt"><input type="radio" name="pago" value="${esc(p.codigo)}" ${S.pago === p.codigo ? 'checked' : ''}><span>${esc(p.etiqueta)}${p.instrucciones ? `<small>${esc(p.instrucciones)}</small>` : ''}</span></label>`).join('')}
        ${t.comprobanteFiscal ? `
          <label class="check"><input type="checkbox" id="comp" ${S.comprobante ? 'checked' : ''}> Necesito comprobante fiscal (RNC)</label>
          ${S.comprobante ? `<div class="row2"><label>RNC o cédula<input name="rnc" inputmode="numeric" maxlength="13" value="${esc(c.rnc || '')}"></label>
            <label>Nombre / razón social<input name="razon" maxlength="160" value="${esc(c.razon || '')}"></label></div>` : ''}` : ''}
        <label>Nota para la tienda (opcional)<textarea name="notas" maxlength="500">${esc(S.notas)}</textarea></label>
        <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
      </form>
      <div id="panel-totales">${totalesHtml(S.cot?.totales)}</div>
      <div id="form-err"></div>`;
    return {
      contenido,
      pie: `<button class="btn" type="button" data-act="confirmar" ${S.enviando ? 'disabled' : ''}>${S.enviando ? 'Enviando…' : 'Confirmar pedido'}</button>
        <button class="btn ghost" type="button" data-act="carrito">Volver al carrito</button>`,
    };
  }

  function panelListo(t) {
    const r = S.resultado;
    return {
      contenido: `<div class="alert ok">Tu pedido <strong>#${esc(r.numero)}</strong> fue enviado a ${esc(t.nombre)}.</div>
        <p>Total: <strong>${money(r.total)}</strong></p>
        <p class="muted">Guarda este enlace para ver el estado de tu pedido. Te avisaremos cuando lo confirmen.</p>`,
      pie: `<a class="btn" href="${esc(r.seguimiento)}">Ver mi pedido</a>
        <button class="btn ghost" type="button" data-act="cerrar">Volver a la tienda</button>`,
    };
  }

  function pintarPanel() {
    if (!S.panel) return;
    const t = S.tienda;
    const titulos = { carrito: 'Tu carrito', favoritos: 'Favoritos', datos: 'Datos del pedido', listo: '¡Pedido recibido!', pedidos: 'Mis pedidos' };
    const { contenido, pie } = {
      carrito: panelCarrito, favoritos: panelFavoritos, datos: panelDatos, listo: panelListo, pedidos: panelPedidos,
    }[S.panel](t);
    $('#panel').classList.toggle('ancho', S.panel === 'datos' || S.panel === 'listo');
    $('#panel-title').textContent = titulos[S.panel];
    const n = S.panel === 'carrito' ? S.carrito.items.length : S.panel === 'favoritos' ? S.favoritos.filter((id) => S.porId.has(id)).length : 0;
    $('#panel-extra').textContent = n ? `${n} ${n === 1 ? 'producto' : 'productos'}` : '';
    pintarTabbar();
    conFoco($('#panel'), () => {
      $('#panel-content').innerHTML = contenido;
      $('#panel-foot').innerHTML = pie;
    });
    const zona = $('#zona');
    if (zona) zona.addEventListener('change', (e) => { S.zonaId = e.target.value; recotizar(); });
    const comp = $('#comp');
    if (comp) comp.addEventListener('change', (e) => { recordarForm(); S.comprobante = e.target.checked; pintarPanel(); });
    document.querySelectorAll('#form input[name="pago"]').forEach((r) => r.addEventListener('change', (e) => { S.pago = e.target.value; }));
  }

  function leerForm() {
    const f = $('#form');
    if (!f) return {};
    const v = (n) => (f.elements[n] ? String(f.elements[n].value || '').trim() : '');
    return {
      nombre: v('nombre'), telefono: v('telefono'), whatsapp: v('whatsapp'), email: v('email'),
      direccion: v('direccion'), sector: v('sector'), municipio: v('municipio'), provincia: v('provincia'),
      referencia: v('referencia'), rnc: v('rnc'), razon: v('razon'), notas: v('notas'), website: v('website'),
    };
  }

  function recordarForm() {
    const f = $('#form');
    if (!f) return;
    const d = leerForm();
    S.notas = f.elements.notas ? f.elements.notas.value : S.notas;
    if (!d.nombre && !d.telefono) return;
    const guardar = { ...leerJSON(KEY_CLIENTE, {}) };
    for (const k of ['nombre', 'telefono', 'whatsapp', 'email', 'direccion', 'sector', 'municipio', 'provincia', 'referencia', 'rnc', 'razon']) {
      if (f.elements[k]) guardar[k] = d[k];
    }
    guardarJSON(KEY_CLIENTE, guardar);
  }

  async function confirmar() {
    if (S.enviando) return;
    const d = leerForm();
    recordarForm();
    if (!S.carrito.clave) { S.carrito.clave = nuevaClave(); guardarCarrito(); }
    S.enviando = true;
    pintarPanelPie();
    try {
      const r = await api('/pedidos', {
        method: 'POST',
        body: {
          idempotencyKey: S.carrito.clave,
          website: d.website,
          cliente: { nombre: d.nombre, telefono: d.telefono, whatsapp: d.whatsapp || d.telefono, email: d.email },
          entrega: {
            tipo: S.entrega, zonaId: S.zonaId, direccion: d.direccion, sector: d.sector,
            municipio: d.municipio, provincia: d.provincia, referencia: d.referencia,
          },
          pago: { metodo: S.pago },
          comprobante: S.comprobante ? { solicitado: true, rnc: d.rnc, razonSocial: d.razon } : { solicitado: false },
          notas: d.notas,
          items: S.carrito.items,
        },
      });
      S.resultado = r;
      const hist = leerJSON(`tc-pedidos-${SLUG}`, []);
      hist.unshift({ numero: r.numero, url: r.seguimiento, en: new Date().toISOString() });
      guardarJSON(`tc-pedidos-${SLUG}`, hist.slice(0, 10));
      S.carrito = { items: [], clave: '' };
      S.notas = '';
      guardarCarrito();
      S.enviando = false;
      S.panel = 'listo';
      pintarPanel();
      pintarContadores();
      pintarProductos();
      cargarTienda().catch(() => {});
    } catch (e) {
      S.enviando = false;
      if (e.status === 409 && (e.data?.errores || []).length) {
        // Algo se agotó o cambió: se vuelve al carrito para ajustarlo.
        S.carrito.clave = '';
        guardarCarrito();
        await cargarTienda().catch(() => {});
        S.panel = 'carrito';
        await cotizar();
        pintarPanel();
        toast(e.message);
        return;
      }
      const err = $('#form-err');
      if (err) err.innerHTML = `<div class="alert err">${esc(e.message)}</div>`;
      pintarPanelPie();
      const campo = e.data?.campo ? $(`#form [name="${String(e.data.campo).split('.').pop()}"]`) : null;
      if (campo) campo.focus();
    }
  }

  function pintarPanelPie() {
    const b = $('[data-act="confirmar"]');
    if (b) { b.disabled = S.enviando; b.textContent = S.enviando ? 'Enviando…' : 'Confirmar pedido'; }
  }

  // ── Eventos (delegados: sin onclick en el HTML) ──────────────────────────
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-nav],[data-ir],[data-fila],[data-rapida],[data-quitar-filtro],[data-marca],[data-car],[data-car-ir],[data-fav],[data-agregar],[data-ver],[data-det],[data-mas],[data-menos],[data-quitar],[data-cat],[data-act],[data-entrega]');
    if (!t) return;
    const d = t.dataset;
    if (d.nav) navegar(d.nav);
    else if (d.ir) irDestino(d.ir);
    else if (d.fila) {
      const fila = t.parentElement.querySelector('.fila');
      fila?.scrollBy({ left: Number(d.fila) * fila.clientWidth * 0.85, behavior: SIN_MOVIMIENTO ? 'auto' : 'smooth' });
    } else if (d.rapida) abrirDetalle(Number(d.rapida), { rapida: true });
    else if (d.quitarFiltro) quitarFiltro(d.quitarFiltro);
    else if (d.marca !== undefined) {
      S.marca = S.marca === d.marca ? '' : d.marca;
      S.limite = POR_PAGINA;
      pintarProductos({ arriba: true });
    } else if (d.car) { irSlide(CAR.i + (d.car === 'next' ? 1 : -1)); pausarAuto(); }
    else if (d.carIr !== undefined) { irSlide(Number(d.carIr)); pausarAuto(); }
    else if (d.fav) { e.stopPropagation(); toggleFavorito(Number(d.fav)); }
    else if (d.agregar) {
      e.stopPropagation();
      volarAlCarrito(t.closest('.card, .sim-card, .fav-line'));
      agregar(Number(d.agregar));
    }
    else if (d.ver) abrirDetalle(Number(d.ver));
    else if (d.det) {
      const p = S.detalle && S.porId.get(S.detalle.id);
      if (p) { S.detalle.cantidad = ajustarCantidad(p, Number($('#det-cant')?.value || S.detalle.cantidad) + (d.det === 'mas' ? paso(p) : -paso(p))); actualizarSelector(p); }
    } else if (d.mas) { const p = S.porId.get(Number(d.mas)); if (p) setCantidad(p.id, cantidadDe(p.id) + paso(p)); }
    else if (d.menos) { const p = S.porId.get(Number(d.menos)); if (p) setCantidad(p.id, cantidadDe(p.id) - paso(p)); }
    else if (d.quitar) quitar(Number(d.quitar));
    else if (d.cat !== undefined) {
      S.categoria = d.cat;
      S.limite = POR_PAGINA;
      pintarProductos({ arriba: true });
      const box = $('#productos');
      box?.classList.remove('vista-entra');
      void box?.offsetWidth;
      box?.classList.add('vista-entra');
    } else if (d.entrega) {
      recordarForm();
      S.entrega = d.entrega;
      pintarPanel();
      recotizar();
    } else if (d.act === 'cerrar') cerrarPanel();
    else if (d.act === 'cerrar-detalle') cerrarDetalle();
    else if (d.act === 'cerrar-menu') cerrarMenu();
    else if (d.act === 'abrir-filtros') abrirFiltros(true);
    else if (d.act === 'cerrar-filtros') abrirFiltros(false);
    else if (d.act === 'mas-productos') masProductos();
    else if (d.act === 'detalle-completo') {
      S.detalle.rapida = false;
      $('#modal').classList.remove('rapida');
      pintarDetalle();
      $('#modal-body').scrollTop = 0;
    }
    else if (d.act === 'agregar-detalle') agregarDesdeDetalle();
    else if (d.act === 'reintentar') arrancarCatalogo();
    else if (d.act === 'ver-mas') {
      const abierta = $('#det-desc')?.classList.toggle('abierta');
      t.textContent = abierta ? 'Ver menos' : 'Ver más';
    }
    else if (d.act === 'ver-carrito-detalle') {
      const abridor = S.abridorDetalle;
      cerrarDetalle();
      if (S.panel) irA('carrito');
      else { abrirPanel('carrito'); S.abridor = abridor; }
    } else if (d.act === 'datos') irA('datos');
    else if (d.act === 'carrito' || d.act === 'ver-carrito') irA('carrito');
    else if (d.act === 'confirmar') confirmar();
  });
  // Búsqueda al instante: abre el catálogo al escribir y vuelve al borrar.
  let esperaBusqueda = null;
  $('#buscar').addEventListener('input', (e) => {
    S.buscar = e.target.value;
    S.limite = POR_PAGINA;
    clearTimeout(esperaBusqueda);
    esperaBusqueda = setTimeout(() => {
      const hay = Boolean(S.buscar.trim());
      if (hay && S.vista !== 'catalogo') { S.porBusqueda = true; entrarCatalogo(); return; }
      if (!hay && S.porBusqueda) { irAlInicio(); return; }
      pintarProductos({ arriba: true });
    }, 120);
  });
  $('#menu-btn').addEventListener('click', abrirMenu);
  // Sombra del encabezado al bajar (y su medida al girar el teléfono).
  let marcoScroll = 0;
  window.addEventListener('scroll', () => {
    if (marcoScroll) return;
    marcoScroll = requestAnimationFrame(() => {
      marcoScroll = 0;
      $('#top').classList.toggle('scroll', window.scrollY > 4);
    });
  }, { passive: true });
  window.addEventListener('resize', () => {
    medirEncabezado();
    document.querySelectorAll('.fila').forEach(flechasDeFila);
  }, { passive: true });
  $('#tema-btn').addEventListener('click', cambiarTema);
  $('#fav-btn').addEventListener('click', () => abrirPanel('favoritos'));
  $('#pedidos-btn').addEventListener('click', () => abrirPanel('pedidos'));
  $('#cart-btn').addEventListener('click', () => abrirPanel('carrito'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (S.detalle) cerrarDetalle();
      else if (S.panel) cerrarPanel();
      else if ($('#menu').classList.contains('open')) cerrarMenu();
      else if ($('#filtros')?.classList.contains('open')) abrirFiltros(false);
      return;
    }
    // Flechas del teclado: cambian la foto del carrusel (si no se está escribiendo).
    if (S.detalle && CAR.n > 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
      irSlide(CAR.i + (e.key === 'ArrowRight' ? 1 : -1));
      pausarAuto();
    }
  });
  // Foto que no carga (aún no publicada, borrada…): emoji en su lugar o fuera del carrusel.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.dataset.pid) return;
    FOTOS_ROTAS.add(img.getAttribute('src'));
    const slide = img.closest('.car-slide');
    if (slide) { quitarSlide(slide); return; }
    const p = S.porId.get(Number(img.dataset.pid));
    const caja = img.parentElement;
    if (!p || !caja) return;
    const otra = fotosDe(p)[0];
    if (otra) { img.src = otra; return; } // le quedan otras fotos: se usa la siguiente
    caja.classList.remove('foto');
    caja.classList.add(fondoDe(p));
    img.outerHTML = `<span class="emoji" aria-hidden="true">${emojiDe(p)}</span>`;
  }, true);
  window.addEventListener('popstate', () => {
    if (S.detalle) { ocultarDetalle(); return; }
    // Botón atrás del teléfono: del catálogo vuelve al inicio de la tienda.
    const enCatalogo = Boolean(history.state?.tcCatalogo);
    if (!S.tienda || enCatalogo === (S.vista === 'catalogo')) return;
    if (!enCatalogo) {
      limpiarFiltros();
      S.buscar = '';
      S.porBusqueda = false;
      $('#buscar').value = '';
    }
    S.vista = enCatalogo ? 'catalogo' : 'inicio';
    pintarCatalogo();
    pintarTabbar();
    window.scrollTo(0, 0);
  });
  // Secciones desplegables del detalle ("toggle" no sube: se escucha en captura).
  document.addEventListener('toggle', (e) => {
    const sec = e.target?.dataset?.acc;
    if (!sec) return;
    if (e.target.open) ACORDEON.add(sec); else ACORDEON.delete(sec);
  }, true);

  // ── Carga ────────────────────────────────────────────────────────────────
  // El catálogo se guarda en el teléfono: al volver a entrar la tienda se ve
  // al instante con lo último guardado y enseguida se pone al día con el
  // servidor (precios, existencia y fotos nuevas). Pedir y cotizar siempre
  // van al servidor, así que nunca se cobra con un precio viejo.
  const KEY_CATALOGO = `tc-catalogo-${SLUG}`;
  const MAX_EDAD_GUARDADO = 7 * 24 * 60 * 60 * 1000;

  /** Pone los datos en pantalla: todo si cambió la tienda; si no, solo los productos. */
  function aplicarDatos(data, { inicial = false } = {}) {
    const tiendaAntes = S.tienda ? JSON.stringify(S.tienda) : '';
    S.tienda = data.tienda;
    S.productos = data.productos;
    S.porId = new Map(S.productos.map((p) => [p.id, p]));
    // Quitar del carrito lo que ya no se vende.
    const antes = S.carrito.items.length;
    S.carrito.items = S.carrito.items.filter((i) => S.porId.has(i.productoId) && !S.porId.get(i.productoId).agotado);
    if (S.carrito.items.length !== antes) { guardarCarrito(); toast('Algunos productos de tu carrito ya no están disponibles.'); }
    if (S.detalle && !S.porId.has(S.detalle.id)) cerrarDetalle();
    aplicarDiseno();
    pintarEncabezado();
    if (inicial || !$('#productos') || JSON.stringify(S.tienda) !== tiendaAntes) pintarCatalogo();
    else pintarProductos();
    abrirProductoDelEnlace();
    pintarContadores();
    if (S.panel === 'favoritos') pintarPanel();
    if (S.detalle && !document.querySelector('#modal-foot input:focus')) pintarDetalle();
  }

  /** Enlace directo a un producto (?p=id): se abre una sola vez, al entrar. */
  let enlaceRevisado = false;
  function abrirProductoDelEnlace() {
    if (enlaceRevisado) return;
    enlaceRevisado = true;
    const id = Number(new URLSearchParams(location.search).get('p'));
    if (!id) return;
    if (S.porId.has(id)) abrirDetalle(id, { desdeUrl: true });
    else {
      try { history.replaceState(history.state, '', location.pathname); } catch (_e) { /* sin historial */ }
    }
  }

  /** Pide el catálogo; solo repinta si algo cambió. Devuelve true si cambió. */
  async function cargarTienda({ inicial = false } = {}) {
    const data = await api('');
    const texto = JSON.stringify(data);
    const cambio = texto !== S.ultimoCatalogo;
    S.ultimoCatalogo = texto;
    try { localStorage.setItem(KEY_CATALOGO, `{"en":${Date.now()},"data":${texto}}`); } catch (_e) { /* sin espacio o modo privado */ }
    if (cambio || inicial) aplicarDatos(data, { inicial });
    return cambio;
  }

  /** Lo último guardado en este teléfono (para mostrar algo al instante). */
  function mostrarGuardado() {
    const guardado = leerJSON(KEY_CATALOGO, null);
    // Lo guardado antes del rediseño no trae el diseño: se espera a lo del servidor.
    if (!guardado?.data?.tienda?.diseno || !Array.isArray(guardado.data.productos) || Date.now() - Number(guardado.en || 0) > MAX_EDAD_GUARDADO) return false;
    try {
      aplicarDatos(guardado.data, { inicial: true });
      S.ultimoCatalogo = JSON.stringify(guardado.data);
      document.body.classList.remove('solo-marca');
      return true;
    } catch (_e) {
      return false;
    }
  }

  async function pintarSeguimiento() {
    document.body.classList.add('solo-marca');
    try {
      const p = await api(`/pedidos/${encodeURIComponent(PEDIDO_ID)}?k=${encodeURIComponent(TOKEN)}`);
      const pasos = ['nuevo', 'confirmado', 'en_preparacion', 'listo', ...(p.entrega.tipo === 'delivery' ? ['en_camino'] : []), 'entregado'];
      const etiquetas = { nuevo: 'Recibido', confirmado: 'Confirmado', en_preparacion: 'En preparación', listo: 'Listo', en_camino: 'En camino', entregado: 'Entregado' };
      const malo = ['cancelado', 'rechazado'].includes(p.estado);
      const idx = pasos.indexOf(p.estado);
      const tienda = p.tienda || {};
      window.TCDiseno.aplicarColor(tienda.colorPrimario);
      document.title = `Pedido #${p.numero} · ${tienda.nombre || ''}`;
      // El logo (el mismo ícono de la tienda) y el nombre llevan al inicio de la tienda.
      $('#brand').innerHTML = `<img src="/t/${encodeURIComponent(SLUG)}/iconos/64.png" alt=""><h1>${esc(tienda.nombre || 'Tu pedido')}</h1>`;
      contactoEnEncabezado(tienda.telefono, tienda.whatsapp || tienda.telefono);
      const t = p.totales || {};
      $('#app').innerHTML = `
        <div class="wrap"><div class="track">
          <div class="box">
            <h2>Pedido #${esc(p.numero)}</h2>
            <div class="chip ${malo ? 'off' : ''}">${esc(p.estadoEtiqueta)}</div>
            <p class="muted">Hecho el ${esc(fecha(p.creadoEn))} · ${p.entrega.tipo === 'delivery' ? `Delivery${p.entrega.zona ? ` (${esc(p.entrega.zona)})` : ''}` : 'Retiro en tienda'} · ${esc(p.pago.etiqueta)}</p>
          </div>
          <div class="box">
            ${malo ? `<ul class="steps"><li class="bad"><span class="d"></span>${esc(p.estadoEtiqueta)}</li></ul>` : `<ul class="steps">${pasos.map((s, i) => `<li class="${i <= idx ? 'done' : ''}"><span class="d"></span>${esc(etiquetas[s])}</li>`).join('')}</ul>`}
          </div>
          <div class="box"><h3>Avisos de la tienda</h3>
            ${(p.mensajes || []).slice().reverse().map((m) => `<div class="msg">${esc(m.texto)}<small>${esc(fecha(m.en))}</small></div>`).join('') || '<p class="muted">Sin avisos todavía.</p>'}
          </div>
          <div class="box"><h3>Tu pedido</h3>
            ${p.items.map((i) => `<div class="line"><span>${esc(cant(i.cantidad))} × ${esc(i.nombre)}</span><span>${money(i.total)}</span></div>`).join('')}
            <div class="totals"><span>Subtotal</span><span>${money(t.subtotal)}</span>${t.descuento ? `<span>Descuento</span><span>− ${money(t.descuento)}</span>` : ''}${t.itbis ? `<span>ITBIS</span><span>${money(t.itbis)}</span>` : ''}${t.delivery ? `<span>Delivery</span><span>${money(t.delivery + (t.deliveryItbis || 0))}</span>` : ''}<span class="g">Total</span><span class="g">${money(t.total)}</span></div>
          </div>
        </div></div>`;
      if (!['entregado', 'cancelado', 'rechazado'].includes(p.estado)) setTimeout(pintarSeguimiento, 20000);
    } catch (e) {
      $('#app').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    }
  }

  let reintento = null; // reintento de carga si la tienda no abrió (ver arrancarCatalogo)
  let refrescoActivo = false;
  let primeraCarga = true; // lo guardado en el teléfono solo se usa al abrir la página

  (async function iniciar() {
    pintarTema();
    const marca = $('#brand');
    marca.href = SLUG ? `/t/${encodeURIComponent(SLUG)}` : '/';
    // En el catálogo vuelve al inicio sin recargar; en el seguimiento abre la tienda.
    marca.addEventListener('click', (e) => {
      if (!SLUG || PEDIDO_ID || e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      irAlInicio();
    });
    if (!SLUG) {
      document.body.classList.add('solo-marca');
      $('#app').innerHTML = '<p class="empty">Tienda no encontrada.</p>';
      return;
    }
    // Página, archivos y fotos guardados en el teléfono (abre al instante).
    if ('serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* sin service worker sigue funcionando igual */ });
    }
    if (PEDIDO_ID) { pintarSeguimiento(); return; }
    arrancarCatalogo();
  })();

  // Si la tienda no carga (cerrada un momento, sin señal…) la página no se
  // queda pegada: reintenta sola y muestra los productos apenas vuelva.
  async function arrancarCatalogo() {
    clearTimeout(reintento);
    // 1) Al instante: lo último guardado en este teléfono (si lo hay).
    const yaVisible = primeraCarga && !S.tienda && mostrarGuardado();
    primeraCarga = false;
    try {
      // 2) Enseguida: lo del servidor (repinta solo si algo cambió).
      await cargarTienda({ inicial: !yaVisible && !S.tienda });
      document.body.classList.remove('solo-marca');
      if (!refrescoActivo) {
        refrescoActivo = true;
        // Cambios hechos en el POS (precio, existencia, fotos…) aparecen solos.
        setInterval(() => cargarTienda().catch(() => {}), 45000);
      }
    } catch (e) {
      const cerrada = e.status === 410 || e.data?.code === 'TIENDA_CERRADA';
      const noExiste = e.status === 404;
      if (!e.status && S.tienda) {
        // Sin señal pero con lo guardado en pantalla: se sigue viendo y se reintenta.
        toast('Sin conexión: viendo la última versión guardada.');
        reintento = setTimeout(arrancarCatalogo, 15000);
        return;
      }
      S.tienda = null;
      document.body.classList.add('solo-marca');
      $('#brand').innerHTML = `<img src="/t/${encodeURIComponent(SLUG)}/iconos/64.png" alt=""><h1>Tienda</h1>`;
      $('#app').innerHTML = `<div class="wrap"><div class="estado-tienda">
        <span class="estado-ico" aria-hidden="true">${cerrada ? '🕒' : noExiste ? '🔍' : '📶'}</span>
        <h2>${cerrada ? 'Volvemos enseguida' : noExiste ? 'Tienda no encontrada' : 'No pudimos cargar la tienda'}</h2>
        <p>${esc(e.message)}</p>
        ${noExiste ? '' : `<p class="muted">Esta página se actualiza sola.</p>
          <button class="btn" type="button" data-act="reintentar">Reintentar ahora</button>`}
      </div></div>`;
      if (!noExiste) reintento = setTimeout(arrancarCatalogo, cerrada ? 30000 : 15000);
    }
  }
})();
