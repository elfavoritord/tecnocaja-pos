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
  const COLOR_BASE = '#10b981';
  const COLOR_BASE_HOVER = '#059669';
  const MAX_DETALLE = 99;
  // Carrusel de fotos del detalle.
  const SLIDE_MS = 6000;
  const REANUDAR_MS = 5000;
  const UMBRAL_ARRASTRE = 50;
  const SIN_MOVIMIENTO = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const ICONO_MAS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';

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
  function toast(texto) {
    const box = $('#toasts');
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = texto;
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
      for (const k of ['agregar', 'fav', 'ver', 'det', 'act']) if (a.dataset?.[k]) { sel = `[data-${k}="${a.dataset[k]}"]`; break; }
    }
    pintar();
    if (sel) (raiz ? raiz() : contenedor)?.querySelector(sel)?.focus({ preventScroll: true });
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
      toast(cuanto ? `${cant(agregado)} × ${p.nombre} agregado al carrito` : `${p.nombre} agregado al carrito`);
      const b = $('#cart-btn');
      b.classList.add('pulso');
      setTimeout(() => b.classList.remove('pulso'), 200);
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
    toast(i >= 0 ? `${nombre} quitado de favoritos` : `${nombre} agregado a favoritos ❤️`);
  }

  function pintarContadores() {
    const n = S.carrito.items.reduce((s, i) => s + (S.porId.get(i.productoId)?.modoVenta === 'unidad' ? i.cantidad : 1), 0);
    const f = S.favoritos.filter((id) => S.porId.has(id)).length;
    const cb = $('#cart-count');
    cb.textContent = n > 99 ? '99+' : cant(n);
    cb.classList.toggle('hidden', !n);
    $('#cart-btn').setAttribute('aria-label', n ? `Ver carrito (${cant(n)})` : 'Ver carrito');
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
          : S.soloOfertas ? 'ofertas' : 'inicio';
    document.querySelectorAll('#tabbar [data-nav]').forEach((b) => {
      b.classList.toggle('on', b.dataset.nav === activo);
      if (b.dataset.nav === activo) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
  }

  // ── Tema y color del negocio ─────────────────────────────────────────────
  function pintarTema() {
    const oscuro = document.documentElement.getAttribute('data-theme') === 'dark';
    const b = $('#tema-btn');
    b.textContent = oscuro ? '☀️' : '🌙';
    b.setAttribute('aria-label', oscuro ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
  }

  function cambiarTema() {
    const oscuro = document.documentElement.getAttribute('data-theme') !== 'dark';
    document.documentElement.setAttribute('data-theme', oscuro ? 'dark' : 'light');
    try { localStorage.setItem(KEY_TEMA, oscuro ? 'dark' : 'light'); } catch (_e) { /* modo privado */ }
    pintarTema();
  }

  function contrasteConBlanco(rgb) {
    const [r, g, b] = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
  }

  function aplicarColor(color) {
    const c = /^#[0-9a-f]{6}$/i.test(color || '') ? color.toLowerCase() : COLOR_BASE;
    const rgb = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    // Texto (precios, nombre): el mismo color, oscurecido hasta leerse bien sobre blanco.
    let tinta = rgb;
    for (let i = 0; i < 20 && contrasteConBlanco(tinta) < 3.5; i++) tinta = tinta.map((v) => Math.round(v * 0.92));
    const st = document.documentElement.style;
    st.setProperty('--c', c);
    st.setProperty('--c-hover', c === COLOR_BASE ? COLOR_BASE_HOVER : `rgb(${rgb.map((v) => Math.round(v * 0.82)).join(',')})`);
    st.setProperty('--c-ink', c === COLOR_BASE ? COLOR_BASE_HOVER : `rgb(${tinta.join(',')})`);
    st.setProperty('--c-soft', `rgba(${rgb.join(',')},.12)`);
    $('meta[name="theme-color"]')?.setAttribute('content', c);
  }

  // ── Encabezado, filtros y pie ────────────────────────────────────────────
  function pintarEncabezado() {
    const t = S.tienda;
    document.title = t.nombre;
    $('#brand').innerHTML = `
      ${t.logo ? `<img src="${esc(t.logo)}" alt="">` : '<span class="logo-emoji" aria-hidden="true">🛒</span>'}
      <h1>${esc(t.nombre)}</h1>
      ${t.abierta ? '' : '<span class="chip off">Cerrado</span>'}`;
  }

  /** Llamar y WhatsApp de la tienda, arriba junto al botón de día/noche. */
  function contactoEnEncabezado(telefono, whatsapp) {
    const tel = String(telefono || '').replace(/[^\d+]/g, '');
    const wa = String(whatsapp || telefono || '').replace(/\D/g, '');
    const llamar = $('#llamar-btn');
    const waBtn = $('#wa-btn');
    llamar.classList.toggle('hidden', tel.replace(/\D/g, '').length < 7);
    if (tel) llamar.href = `tel:${tel}`;
    waBtn.classList.toggle('hidden', wa.length < 10);
    if (wa.length >= 10) waBtn.href = `https://wa.me/${wa.length === 10 ? `1${wa}` : wa}`;
  }

  /** El nombre o logo del negocio lleva al inicio: sin filtros, arriba y sin paneles abiertos. */
  function irAlInicio() {
    if (S.detalle) cerrarDetalle();
    if (S.panel) cerrarPanel();
    S.categoria = '';
    S.buscar = '';
    S.min = '';
    S.max = '';
    S.orden = '';
    S.soloOfertas = false;
    $('#buscar').value = '';
    if (S.tienda) pintarCatalogo();
    pintarTabbar();
    window.scrollTo({ top: 0, behavior: SIN_MOVIMIENTO ? 'auto' : 'smooth' });
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

  function pieHtml(t) {
    const wa = String(t.whatsapp || '').replace(/\D/g, '');
    const waUrl = wa.length >= 10 ? `https://wa.me/${wa.length === 10 ? `1${wa}` : wa}` : '';
    const hoy = horarioHoy(t);
    const datos = [
      hoy ? `<span>🕒 ${esc(hoy)}</span>` : '',
      t.direccion ? `<span>📍 ${esc(t.direccion)}</span>` : '',
      t.telefono ? `<a href="tel:${esc(String(t.telefono).replace(/[^\d+]/g, ''))}">📞 ${esc(t.telefono)}</a>` : '',
      waUrl ? `<a href="${esc(waUrl)}" target="_blank" rel="noopener">💬 WhatsApp</a>` : '',
    ].join('');
    return `<footer class="foot">
      ${t.descripcion ? `<p>${esc(t.descripcion)}</p>` : ''}
      ${datos ? `<div class="datos">${datos}</div>` : ''}
      <p class="marca">Pedidos procesados por ${esc(t.nombre)} con Tecno Caja.</p>
    </footer>`;
  }

  function pintarCatalogo() {
    const t = S.tienda;
    const ordenes = [['', 'Ordenar por'], ['precio-asc', 'Menor precio'], ['precio-desc', 'Mayor precio'], ['ofertas', 'Mejores ofertas'], ['nuevos', 'Más nuevos']];
    $('#app').innerHTML = `
      <section class="filtros" aria-label="Filtros">
        <div class="wrap">
          <div class="cats" id="cats" role="group" aria-label="Categorías">
            <button type="button" data-cat="" class="${S.categoria ? '' : 'on'}">Todo</button>
            ${S.productos.some((p) => descuentoDe(p) > 0 || p.porCantidad)
              ? `<button type="button" id="pill-ofertas" data-ofertas="1" class="pill-ofertas ${S.soloOfertas ? 'on' : ''}" aria-pressed="${S.soloOfertas}">🔥 Ofertas</button>` : ''}
            ${categorias().map((c) => `<button type="button" data-cat="${esc(c)}" class="${S.categoria === c ? 'on' : ''}">${esc(c)}</button>`).join('')}
          </div>
          <div class="price-range">
            <span class="lbl">Precio:</span>
            <input id="pmin" type="number" min="0" step="any" inputmode="decimal" placeholder="Mín" aria-label="Precio mínimo" value="${esc(S.min)}">
            <span class="dash">-</span>
            <input id="pmax" type="number" min="0" step="any" inputmode="decimal" placeholder="Máx" aria-label="Precio máximo" value="${esc(S.max)}">
          </div>
          <select id="orden" aria-label="Ordenar por">
            ${ordenes.map(([v, l]) => `<option value="${v}" ${S.orden === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
      </section>
      <div class="wrap contenido">
        ${!t.abierta ? `<div class="aviso">${t.aceptaFueraDeHorario ? 'Estamos cerrados ahora: tu pedido se procesa cuando abramos.' : 'Estamos cerrados: no recibimos pedidos ahora.'}</div>` : ''}
        ${t.banner ? `<div class="banner"><img src="${esc(t.banner)}" alt=""></div>` : ''}
        <div class="grid-box" id="grid-box"><div class="grid" id="productos"></div></div>
        ${pieHtml(t)}
      </div>`;
    $('#pmin').addEventListener('input', (e) => { S.min = e.target.value; pintarProductos({ arriba: true }); });
    $('#pmax').addEventListener('input', (e) => { S.max = e.target.value; pintarProductos({ arriba: true }); });
    $('#orden').addEventListener('change', (e) => { S.orden = e.target.value; pintarProductos({ arriba: true }); });
    pintarProductos();
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
      ? `<img src="${esc(url)}" alt="" draggable="false" data-pid="${p.id}"${lazy ? ' loading="lazy"' : ''}>`
      : `<span class="emoji" aria-hidden="true">${emojiDe(p)}</span>`;
  }
  function unidadHtml(p) {
    return p.modoVenta === 'unidad' ? '' : `<small>/ ${esc(p.unidad)}</small>`;
  }

  function tarjeta(p) {
    const c = cantidadDe(p.id);
    const fav = S.favoritos.includes(p.id);
    const desc = descuentoDe(p);
    const antes = precioAntesDe(p);
    const nombre = esc(p.nombre);
    const nFotos = fotosDe(p).length;
    const iFoto = (rota.indice.get(p.id) || 0) % Math.max(1, nFotos); // al repintar sigue en la misma foto
    return `
      <article class="card${p.agotado ? ' agotado' : ''}" data-id="${p.id}"${nFotos > 1 ? ' data-rota="1"' : ''}>
        <button class="ver" type="button" data-ver="${p.id}" aria-label="Ver detalle: ${nombre}"></button>
        <div class="img ${cajaClase(p)}">
          ${imagenHtml(p, { indice: iFoto })}
          ${desc > 0 ? `<span class="off">-${desc}%</span>` : p.destacado ? '<span class="off feat" title="Destacado">★</span>' : ''}
          <button class="fav${fav ? ' on' : ''}" type="button" data-fav="${p.id}" aria-pressed="${fav}" aria-label="${fav ? 'Quitar de' : 'Agregar a'} favoritos: ${nombre}">${fav ? '❤️' : '🤍'}</button>
          ${p.agotado ? '<span class="soldout">Agotado</span>'
            : `<button class="add" type="button" data-agregar="${p.id}" aria-label="Agregar al carrito: ${nombre}">${ICONO_MAS}</button>`}
          ${nFotos > 1 || c > 0 ? `<div class="abajo">
            ${nFotos > 1 ? `<span class="nfotos" title="${nFotos} fotos">📷 ${iFoto + 1}/${nFotos}</span>` : ''}
            ${c > 0 ? `<span class="qty" title="En tu carrito">${esc(cant(c))}</span>` : ''}
          </div>` : ''}
        </div>
        <div class="body">
          <div class="name" title="${nombre}">${nombre}</div>
          <div class="price">${antes ? `<s>${moneyCorto(antes)}</s>` : ''}<span class="now">${money(precioFinal(p))}</span>${unidadHtml(p)}</div>
          ${p.porCantidad ? `<div class="rule">${esc(cant(p.porCantidad.cantidadMinima))}+ a ${moneyCorto(p.porCantidad.precio)}</div>` : ''}
          ${p.conItbis ? '<div class="tax">+ ITBIS</div>' : ''}
        </div>
      </article>`;
  }

  /** Búsqueda, categoría, precio y orden se combinan. */
  function visibles() {
    const q = norm(S.buscar.trim());
    const min = S.min === '' ? NaN : Number(S.min);
    const max = S.max === '' ? NaN : Number(S.max);
    const lista = S.productos.filter((p) => (!S.categoria || p.categoria === S.categoria)
      && (!S.soloOfertas || descuentoDe(p) > 0 || p.porCantidad)
      && (!q || norm(`${p.nombre} ${p.descripcion}`).includes(q))
      && (!Number.isFinite(min) || precioFinal(p) >= min)
      && (!Number.isFinite(max) || precioFinal(p) <= max));
    const orden = {
      'precio-asc': (a, b) => precioFinal(a) - precioFinal(b),
      'precio-desc': (a, b) => precioFinal(b) - precioFinal(a),
      ofertas: (a, b) => descuentoDe(b) - descuentoDe(a),
      nuevos: (a, b) => b.id - a.id, // el id más alto es el último que se creó en el POS
    }[S.orden] || ((a, b) => Number(b.destacado) - Number(a.destacado));
    return lista.sort(orden);
  }

  function pintarProductos({ arriba = false } = {}) {
    const box = $('#productos');
    if (!box) return;
    const lista = visibles();
    rota.io?.disconnect();
    rota.visibles.clear();
    box.innerHTML = lista.length ? lista.map(tarjeta).join('')
      : `<p class="empty">${S.soloOfertas ? 'No hay ofertas con estos filtros.' : 'No se encontraron productos.'}</p>`;
    if (arriba) {
      $('#grid-box').scrollTop = 0;
      // En el teléfono la lista va con el scroll de la página: si quedó abajo, volver al inicio del catálogo.
      const filtros = $('.filtros');
      if (filtros && window.matchMedia('(max-width: 639px)').matches) {
        const destino = filtros.offsetTop + filtros.offsetHeight - ($('.top')?.offsetHeight || 0);
        if (window.scrollY > destino) window.scrollTo({ top: destino });
      }
    }
    observarTarjetas(box);
  }

  /** Repinta una sola tarjeta (sin perder el scroll ni el foco del teclado). */
  function pintarTarjeta(id) {
    const vieja = document.querySelector(`.card[data-id="${Number(id)}"]`);
    const p = S.porId.get(id);
    if (!vieja || !p) return;
    rota.io?.unobserve(vieja);
    rota.visibles.delete(vieja);
    const nueva = () => document.querySelector(`.card[data-id="${Number(id)}"]`);
    conFoco(vieja, () => { vieja.outerHTML = tarjeta(p); }, nueva);
    if (nueva()) observarTarjetas(nueva());
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
      if (badge) badge.textContent = `📷 ${i + 1}/${fotos.length}`;
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
      .slice(0, 3);
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
    return `
      <div class="det-grid">
        <div class="det-media">
          ${carruselHtml(p, `${desc > 0 ? `<span class="off">-${desc}%</span>` : ''}${p.agotado ? '<span class="soldout">Agotado</span>' : ''}`)}
        </div>
        <div class="det-info">
          <div class="det-tags">
            ${p.categoria ? `<span class="det-cat">${esc(p.categoria)}</span>` : ''}
            ${p.destacado ? '<span class="det-cat star">★ Destacado</span>' : ''}
            ${p.agotado ? '<span class="det-cat bad">Agotado</span>' : p.disponible !== null && p.disponible <= 10 ? `<span class="det-cat warn">Quedan ${esc(cant(p.disponible))}</span>` : ''}
          </div>
          <div class="det-head">
            <h2 id="modal-title">${esc(p.nombre)}</h2>
            <button class="det-fav${fav ? ' on' : ''}" type="button" data-fav="${p.id}" aria-pressed="${fav}" aria-label="${fav ? 'Quitar de' : 'Agregar a'} favoritos">${fav ? '❤️' : '🤍'}</button>
          </div>
          <div class="det-price">
            <span class="now">${money(precioFinal(p))}${unidadHtml(p)}</span>
            ${antes ? `<s>${money(antes)}</s>` : ''}
            ${desc > 0 ? `<span class="off">-${desc}%</span>` : ''}
          </div>
          ${p.conItbis ? '<p class="det-nota">+ ITBIS al pagar</p>' : ''}
          ${p.porCantidad ? `<p class="det-promo">🔥 Llevando ${esc(cant(p.porCantidad.cantidadMinima))} o más: ${money(p.porCantidad.precio)} c/u</p>` : ''}
          ${enCarrito > 0 ? `<p class="det-cart">🛒 Ya tienes ${esc(cant(enCarrito))} en tu carrito · <button class="link" type="button" data-act="ver-carrito-detalle">Ver carrito</button></p>` : ''}
          ${p.descripcion ? `<p class="det-desc${larga ? ' clamp' : ''}" id="det-desc">${esc(p.descripcion)}</p>
            ${larga ? '<button class="link det-vermas" type="button" data-act="ver-mas">Ver más</button>' : ''}` : ''}
          <div class="acc">
            ${seccion('specs', 'Especificaciones', '📋', `<ul class="det-specs">${especificaciones(p).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`)}
            ${seccion('entrega', 'Entrega y pago', '🛵', entregaYPagoHtml())}
          </div>
        </div>
      </div>
      ${similares.length ? `<h3 class="det-sub sim">Productos similares</h3><div class="sim-grid">${similares.map(similarHtml).join('')}</div>` : ''}`;
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
        <button class="car-arrow prev" type="button" data-car="prev" aria-label="Foto anterior">‹</button>
        <button class="car-arrow next" type="button" data-car="next" aria-label="Foto siguiente">›</button>
        <div class="car-dots">${fotos.map((_, i) => `<button class="dot" type="button" data-car-ir="${i}" aria-label="Ver foto ${i + 1}"></button>`).join('')}</div>
        ${marcas}
      </div>`;
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

  function abrirDetalle(id) {
    const p = S.porId.get(id);
    if (!p) return;
    const yaAbierto = Boolean(S.detalle);
    S.detalle = { id, cantidad: 1 };
    if (yaAbierto) {
      // Producto similar: cambia el contenido con un fundido corto, sin cerrar.
      const body = $('#modal-body');
      body.classList.add('cambiando');
      setTimeout(() => { pintarDetalle(); body.scrollTop = 0; body.classList.remove('cambiando'); }, 150);
      return;
    }
    S.abridorDetalle = document.activeElement;
    try { history.pushState({ tcDetalle: true }, ''); } catch (_e) { /* sin historial */ }
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
      if (!p.agotado) toast(`Ya tienes en el carrito todo lo disponible de ${p.nombre}.`);
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
    if (destino === 'inicio' || destino === 'ofertas') {
      if (S.panel) cerrarPanel();
      const ofertas = destino === 'ofertas';
      if (S.soloOfertas !== ofertas) {
        S.soloOfertas = ofertas;
        $('#pill-ofertas')?.classList.toggle('on', ofertas);
        $('#pill-ofertas')?.setAttribute('aria-pressed', String(ofertas));
        pintarProductos({ arriba: true });
      }
      window.scrollTo({ top: 0, behavior: SIN_MOVIMIENTO ? 'auto' : 'smooth' });
      pintarTabbar();
      if (ofertas && !S.productos.some((p) => descuentoDe(p) > 0 || p.porCantidad)) toast('Esta tienda no tiene ofertas ahora.');
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
        contenido: `<div class="vacio">${ICONO_CARRITO}<p>Tu carrito está vacío.</p><span class="muted">Toca + en un producto para agregarlo.</span></div>`,
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
      : '<p class="empty">Aún no tienes favoritos.<br>Toca 🤍 en un producto para guardarlo aquí.</p>';
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
    const t = e.target.closest('[data-nav],[data-ofertas],[data-car],[data-car-ir],[data-fav],[data-agregar],[data-ver],[data-det],[data-mas],[data-menos],[data-quitar],[data-cat],[data-act],[data-entrega]');
    if (!t) return;
    const d = t.dataset;
    if (d.nav) navegar(d.nav);
    else if (d.ofertas) navegar(S.soloOfertas ? 'inicio' : 'ofertas');
    else if (d.car) { irSlide(CAR.i + (d.car === 'next' ? 1 : -1)); pausarAuto(); }
    else if (d.carIr !== undefined) { irSlide(Number(d.carIr)); pausarAuto(); }
    else if (d.fav) { e.stopPropagation(); toggleFavorito(Number(d.fav)); }
    else if (d.agregar) { e.stopPropagation(); agregar(Number(d.agregar)); }
    else if (d.ver) abrirDetalle(Number(d.ver));
    else if (d.det) {
      const p = S.detalle && S.porId.get(S.detalle.id);
      if (p) { S.detalle.cantidad = ajustarCantidad(p, Number($('#det-cant')?.value || S.detalle.cantidad) + (d.det === 'mas' ? paso(p) : -paso(p))); actualizarSelector(p); }
    } else if (d.mas) { const p = S.porId.get(Number(d.mas)); if (p) setCantidad(p.id, cantidadDe(p.id) + paso(p)); }
    else if (d.menos) { const p = S.porId.get(Number(d.menos)); if (p) setCantidad(p.id, cantidadDe(p.id) - paso(p)); }
    else if (d.quitar) quitar(Number(d.quitar));
    else if (d.cat !== undefined) {
      S.categoria = d.cat;
      document.querySelectorAll('#cats button').forEach((b) => b.classList.toggle('on', b.dataset.cat === S.categoria));
      pintarProductos({ arriba: true });
    } else if (d.entrega) {
      recordarForm();
      S.entrega = d.entrega;
      pintarPanel();
      recotizar();
    } else if (d.act === 'cerrar') cerrarPanel();
    else if (d.act === 'cerrar-detalle') cerrarDetalle();
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
  $('#buscar').addEventListener('input', (e) => { S.buscar = e.target.value; pintarProductos({ arriba: true }); });
  $('#tema-btn').addEventListener('click', cambiarTema);
  $('#fav-btn').addEventListener('click', () => abrirPanel('favoritos'));
  $('#pedidos-btn').addEventListener('click', () => abrirPanel('pedidos'));
  $('#cart-btn').addEventListener('click', () => abrirPanel('carrito'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (S.detalle) cerrarDetalle();
      else if (S.panel) cerrarPanel();
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
  window.addEventListener('popstate', () => { if (S.detalle) ocultarDetalle(); });
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
    aplicarColor(S.tienda.colorPrimario);
    pintarEncabezado();
    if (inicial || !$('#productos') || JSON.stringify(S.tienda) !== tiendaAntes) pintarCatalogo();
    else pintarProductos();
    pintarContadores();
    if (S.panel === 'favoritos') pintarPanel();
    if (S.detalle && !document.querySelector('#modal-foot input:focus')) pintarDetalle();
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
    if (!guardado?.data?.tienda || !Array.isArray(guardado.data.productos) || Date.now() - Number(guardado.en || 0) > MAX_EDAD_GUARDADO) return false;
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
      aplicarColor(tienda.colorPrimario);
      document.title = `Pedido #${p.numero} · ${tienda.nombre || ''}`;
      // El logo (el mismo ícono de la tienda) y el nombre llevan al inicio de la tienda.
      $('#brand').innerHTML = `<img src="/t/${encodeURIComponent(SLUG)}/iconos/64.png" alt=""><h1>${esc(tienda.nombre || 'Tu pedido')}</h1>`;
      contactoEnEncabezado(tienda.telefono, tienda.whatsapp);
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
