/* Convierte el diseño del negocio en variables de CSS. Los colores de fondo,
 * texto y tarjetas se guardan aparte (--u-*) para que el modo oscuro del
 * cliente los pueda ignorar sin perder los colores de marca. */
(function () {
  'use strict';

  const COLOR_BASE = '#10b981';
  const LETRAS = {
    inter: '"Inter"',
    poppins: '"Poppins"',
    nunito: '"Nunito"',
    montserrat: '"Montserrat"',
    playfair: '"Playfair Display"',
    sistema: '',
  };
  const SISTEMA = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const aHex = (c) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
  const valido = (c) => /^#[0-9a-f]{6}$/i.test(c || '');

  function luminancia(c) {
    const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contraste(a, b) {
    const [x, y] = [luminancia(a), luminancia(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  }
  function mezclar(a, b, p) {
    const [x, y] = [rgb(a), rgb(b)];
    return aHex(x.map((v, i) => v * (1 - p) + y[i] * p));
  }
  /** Blanco o casi negro: lo que se lea mejor encima de ese color. */
  function tintaSobre(hex) {
    const c = rgb(hex);
    return contraste(c, [255, 255, 255]) >= contraste(c, [15, 23, 42]) ? '#ffffff' : '#0f172a';
  }
  /** El mismo color, oscurecido o aclarado lo justo para leerse sobre ese fondo. */
  function legible(hex, fondo, minimo = 3.5) {
    let c = rgb(hex);
    const f = rgb(fondo);
    const destino = luminancia(f) > 0.4 ? 0 : 255;
    for (let i = 0; i < 40 && contraste(c, f) < minimo; i += 1) c = c.map((v) => v + (destino - v) * 0.08);
    return aHex(c);
  }

  const raiz = () => document.documentElement;
  let metaLight = COLOR_BASE;

  function pintarMeta() {
    const oscuro = raiz().getAttribute('data-theme') === 'dark';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', oscuro ? '#111827' : metaLight);
  }

  /** Solo el color del negocio (el seguimiento del pedido no recibe el diseño completo). */
  function aplicarColor(color) {
    const c = valido(color) ? color.toLowerCase() : COLOR_BASE;
    const st = raiz().style;
    st.setProperty('--c', c);
    st.setProperty('--c-hover', mezclar(c, '#000000', 0.16));
    st.setProperty('--c-ink', legible(c, '#ffffff'));
    st.setProperty('--c-claro', legible(c, '#1e293b', 4));
    st.setProperty('--c-sobre', tintaSobre(c));
    st.setProperty('--c-soft', `rgba(${rgb(c).join(',')},.12)`);
    metaLight = c;
    pintarMeta();
  }

  function aplicar(d) {
    if (!d) return;
    const { colores: k, apariencia: a, encabezado: e, hero } = d;
    aplicarColor(k.principal);
    const st = raiz().style;
    const set = (n, v) => st.setProperty(n, v);

    set('--u-fondo', k.fondo);
    set('--u-texto', k.texto);
    set('--u-texto2', mezclar(k.texto, k.fondo, 0.38));
    set('--u-linea', mezclar(k.texto, k.fondo, 0.86));
    set('--u-suave', mezclar(k.texto, k.fondo, 0.94));
    set('--u-tarjeta', k.tarjetas);
    set('--u-head', k.encabezado);
    set('--u-head-ink', tintaSobre(k.encabezado));
    set('--u-pie', k.pie);
    set('--u-pie-ink', tintaSobre(k.pie));
    set('--u-pie-ink2', mezclar(tintaSobre(k.pie), k.pie, 0.3));
    set('--u-pie-linea', mezclar(tintaSobre(k.pie), k.pie, 0.82));
    set('--btn', k.botones);
    set('--btn-hover', mezclar(k.botones, '#000000', 0.16));
    set('--btn-ink', tintaSobre(k.botones));
    set('--btn-texto', legible(k.botones, '#ffffff'));
    set('--btn-texto-oscuro', legible(k.botones, '#1e293b', 4));
    set('--sec', k.secundario);
    set('--sec-ink', tintaSobre(k.secundario));
    set('--dest', k.destacados);
    set('--dest-ink', tintaSobre(k.destacados));

    const letra = (id) => (LETRAS[id] ? `${LETRAS[id]}, ${SISTEMA}` : SISTEMA);
    set('--font', letra(a.tipografia));
    set('--font-t', letra(a.tipografiaTitulos));

    const r = raiz();
    r.dataset.texto = a.tamanoTexto;
    r.dataset.boton = a.estiloBotones;
    r.dataset.esquinas = a.esquinas;
    r.dataset.sombras = a.sombras;
    r.dataset.espacio = a.espaciado;
    r.dataset.tarjeta = a.estiloTarjetas;
    r.dataset.logo = e.tamanoLogo;
    r.dataset.hero = hero.altura;
    r.dataset.titulos = a.tipografiaTitulos;

    // El negocio apagó el modo oscuro: se ve claro aunque el cliente lo hubiera elegido.
    if (!a.temaOscuro) r.setAttribute('data-theme', 'light');
    else {
      let guardado = '';
      try { guardado = localStorage.getItem('tc-tema') || ''; } catch (_e) { /* modo privado */ }
      r.setAttribute('data-theme', guardado === 'dark' ? 'dark' : 'light');
    }

    metaLight = k.encabezado;
    pintarMeta();
  }

  window.TCDiseno = { aplicar, aplicarColor, pintarMeta, tintaSobre, contraste: (a, b) => contraste(rgb(a), rgb(b)) };
})();
