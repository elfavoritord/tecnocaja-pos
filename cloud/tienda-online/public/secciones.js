/* Secciones de la página de inicio de la tienda. Cada una devuelve su HTML, o
 * nada si no tiene qué mostrar (una sección vacía no se pinta). El orden y cuáles
 * van salen del diseño que el negocio configura en el POS.
 * Sin código en línea: los botones se atienden en app.js con data-*. */
(function () {
  'use strict';

  const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${d}</svg>`;
  const ICO = {
    sol: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    luna: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
    corazon: svg('<path d="M12 20.5s-7.5-4.6-9.6-9.3A5.3 5.3 0 0 1 12 5.9a5.3 5.3 0 0 1 9.6 5.3c-2.1 4.7-9.6 9.3-9.6 9.3z"/>'),
    ojo: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'),
    carrito: svg('<circle cx="9" cy="20" r="1.6"/><circle cx="18" cy="20" r="1.6"/><path d="M2 3h3l2.6 12.2a1 1 0 0 0 1 .8h9.7a1 1 0 0 0 1-.8L21 7H6.2"/>'),
    flecha: svg('<path d="M9 6l6 6-6 6"/>'),
    flechaIzq: svg('<path d="M15 6l-6 6 6 6"/>'),
    filtros: svg('<path d="M4 6h16M7 12h10M10 18h4"/>'),
    x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    reloj: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    lugar: svg('<path d="M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
    moto: svg('<circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M9 17h6l2-6h-4l-2-4H8M15 11l3 6"/>'),
    tarjeta: svg('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10.5h18M7 15h4"/>'),
    telefono: svg('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>'),
    correo: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>'),
    whatsapp: svg('<path d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3z"/><path d="M9 8.5c-.5.5-.8 1.3-.7 2 .3 2.3 3.5 5.3 5.9 5.2.8 0 1.6-.6 1.8-1.4l-1.9-1.1-.9.8c-1-.5-1.9-1.4-2.4-2.4l.8-.9L10.5 8.8z"/>'),
    facebook: svg('<path d="M14 8h3V4h-3a4 4 0 0 0-4 4v3H7v4h3v6h4v-6h3l1-4h-4V8z"/>'),
    instagram: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r=".8"/>'),
    tiktok: svg('<path d="M14 3v11.5a3.5 3.5 0 1 1-3-3.5M14 3c.5 2.8 2.4 4.6 5 5"/>'),
    youtube: svg('<rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="M10.5 9.5l4.5 2.5-4.5 2.5z"/>'),
  };

  function crear(ctx) {
    const { esc, tarjeta, tintaSobre, sinMovimiento, fotosDe, emojiDe, horarioHoy, money, waUrl } = ctx;

    const titulo = (s, porDefecto) => esc(s.titulo || porDefecto);

    /** Botón o enlace según a dónde lleve (lo valida el servidor: solo https). */
    function botonDestino(destino, texto, clase) {
      if (/^https:\/\//i.test(destino)) {
        return `<a class="${clase}" href="${esc(destino)}" target="_blank" rel="noopener">${esc(texto)}</a>`;
      }
      return `<button class="${clase}" type="button" data-ir="${esc(destino)}">${esc(texto)}</button>`;
    }

    function cabeza(id, texto, destino) {
      return `<div class="sec-head">
        <h2 id="tit-${id}">${texto}</h2>
        ${destino ? `<button class="sec-ver" type="button" data-ir="${esc(destino)}">Ver todo ${ICO.flecha}</button>` : ''}
      </div>`;
    }

    /** Fila de productos que se desliza con el dedo o con las flechas. */
    function filaProductos(id, texto, lista, destino, { clase = 'sec', attrs = '', vitrina = '' } = {}) {
      if (!lista.length) return '';
      return `<section class="${clase}" id="sec-${id}" data-sec="${id}" ${attrs} aria-labelledby="tit-${id}"><div class="wrap">
        ${cabeza(id, texto, destino)}
        <div class="fila-caja">
          <button class="fila-fl prev" type="button" data-fila="-1" aria-label="Ver anteriores" hidden>${ICO.flechaIzq}</button>
          <div class="fila" data-fila-lista="${id}">${lista.map((p) => tarjeta(p, { vitrina })).join('')}</div>
          <button class="fila-fl next" type="button" data-fila="1" aria-label="Ver más" hidden>${ICO.flecha}</button>
        </div>
      </div></section>`;
    }

    /** Ofertas especiales y Nuevos productos: fila con movimiento continuo. */
    function vitrina(id, s, porDefecto, d) {
      const lista = ctx.lista(id);
      if (!lista.length) return '';
      const v = d.vitrinas[id];
      const vars = [];
      if (v.colorFondo) vars.push(`--m-fondo:${v.colorFondo}`, `--m-titulo:${v.colorTitulo || tintaSobre(v.colorFondo)}`);
      else if (v.colorTitulo) vars.push(`--m-titulo:${v.colorTitulo}`);
      if (v.colorEtiqueta) {
        const tinta = tintaSobre(v.colorEtiqueta);
        vars.push(`--dest:${v.colorEtiqueta}`, `--dest-ink:${tinta}`, `--sec:${v.colorEtiqueta}`, `--sec-ink:${tinta}`);
      }
      const attrs = `data-vitrina="${id}"${v.estiloTarjeta !== 'tienda' ? ` data-tarjeta="${esc(v.estiloTarjeta)}"` : ''}${vars.length ? ` style="${esc(vars.join(';'))}"` : ''}`;
      const clase = `sec sec-mq${v.colorFondo ? ' con-fondo' : ''}`;
      // Con "reducir movimiento" es una fila normal, que se desliza a mano.
      if (sinMovimiento()) return filaProductos(id, titulo(s, porDefecto), lista, id, { clase, attrs, vitrina: id });
      return `<section class="${clase}" id="sec-${id}" data-sec="${id}" ${attrs} aria-labelledby="tit-${id}">
        <div class="wrap">${cabeza(id, titulo(s, porDefecto), id)}</div>
        <div class="mq-caja" data-marquee="${id}" data-velocidad="${Number(v.velocidad)}" data-direccion="${esc(v.direccion)}">
          <div class="mq-pista"><div class="mq-grupo">${lista.map((p) => tarjeta(p, { vitrina: id })).join('')}</div></div>
        </div>
      </section>`;
    }

    function tituloCatalogoInicio(t) {
      if (t.modalidad !== 'servicios') return 'Todos los productos';
      return t.conProductos ? 'Servicios y productos' : 'Nuestros servicios';
    }

    function palabraCatalogo(t) {
      if (t.modalidad !== 'servicios') return 'productos';
      return t.conProductos ? 'artículos' : 'servicios';
    }

    function hero(t, d) {
      const h = d.hero;
      const tituloTxt = h.titulo || t.nombre;
      const sub = h.subtitulo || t.descripcion || '';
      const movil = t.bannerMovil ? `<source media="(max-width: 639px)" srcset="${esc(t.bannerMovil)}">` : '';
      const foto = t.banner || t.bannerMovil;
      if (foto && !h.titulo && !h.subtitulo) {
        return `<section class="solo-foto wrap" id="sec-hero" aria-label="Portada">
          <div class="solo-foto-caja">
            <picture class="solo-foto-fondo" aria-hidden="true">${movil}<img src="${esc(foto)}" alt=""></picture>
            <picture class="solo-foto-img">${movil}<img src="${esc(foto)}" alt="" fetchpriority="high"></picture>
          </div>
        </section>`;
      }
      return `<section class="hero al-${esc(h.alineacion)}${foto ? ' con-foto' : ''}" id="sec-hero" aria-label="Portada">
        ${foto ? `<picture class="hero-foto">${movil}<img src="${esc(foto)}" alt="" fetchpriority="high"></picture>` : ''}
        <div class="hero-txt wrap"><div class="hero-in">
          <h2>${esc(tituloTxt)}</h2>
          ${sub ? `<p>${esc(sub)}</p>` : ''}
          <div class="hero-btns">
            ${h.textoBoton ? botonDestino(h.enlaceBoton, h.textoBoton === 'Ver productos' && t.modalidad === 'servicios' && !t.conProductos ? 'Ver servicios' : h.textoBoton, 'btn hero-b1') : ''}
            ${h.textoBoton2 ? botonDestino(h.enlaceBoton2, h.textoBoton2, 'btn hero-b2') : ''}
          </div>
        </div></div>
      </section>`;
    }

    function categorias(s) {
      const productos = ctx.productos();
      const nombres = ctx.categorias();
      if (nombres.length < 2) return '';
      const tiles = nombres.slice(0, 8).map((c) => {
        const delGrupo = productos.filter((p) => p.categoria === c);
        const conFoto = delGrupo.find((p) => fotosDe(p).length);
        return `<button class="cat-tile" type="button" data-ir="categoria:${esc(c)}">
          <span class="cat-img${conFoto ? ' foto' : ''}">${conFoto
            ? `<img src="${esc(fotosDe(conFoto)[0])}" alt="" loading="lazy" data-pid="${conFoto.id}">`
            : `<span class="emoji" aria-hidden="true">${emojiDe(delGrupo[0] || { nombre: c, categoria: c })}</span>`}</span>
          <span class="cat-nom">${esc(c)}</span>
        </button>`;
      }).join('');
      return `<section class="sec" id="sec-categorias" aria-labelledby="tit-categorias"><div class="wrap">
        ${cabeza('categorias', titulo(s, ctx.tienda().modalidad === 'servicios' ? 'Explora por categoría' : 'Compra por categoría'), nombres.length > 8 ? 'catalogo' : '')}
        <div class="cat-tiles">${tiles}</div>
      </div></section>`;
    }

    function marcas(s) {
      const cuenta = new Map();
      for (const p of ctx.productos()) if (p.marca) cuenta.set(p.marca, (cuenta.get(p.marca) || 0) + 1);
      if (!cuenta.size) return '';
      const lista = [...cuenta.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16);
      return `<section class="sec" id="sec-marcas" aria-labelledby="tit-marcas"><div class="wrap">
        ${cabeza('marcas', titulo(s, 'Nuestras marcas'))}
        <div class="marcas">${lista.map(([m]) => `<button type="button" data-ir="marca:${esc(m)}">${esc(m)}</button>`).join('')}</div>
      </div></section>`;
    }

    function banners(t) {
      const lista = (t.anuncios || []).filter((a) => a.imagen);
      if (!lista.length) return '';
      const uno = (a) => {
        const dentro = `<img src="${esc(a.imagen)}" alt="${esc(a.titulo)}" loading="lazy">${a.titulo ? `<span>${esc(a.titulo)}</span>` : ''}`;
        if (!a.enlace) return `<div class="anuncio">${dentro}</div>`;
        return /^https:\/\//i.test(a.enlace)
          ? `<a class="anuncio" href="${esc(a.enlace)}" target="_blank" rel="noopener">${dentro}</a>`
          : `<button class="anuncio" type="button" data-ir="${esc(a.enlace)}">${dentro}</button>`;
      };
      return `<section class="sec" id="sec-banners" aria-label="Publicidad"><div class="wrap">
        <div class="anuncios n${Math.min(lista.length, 3)}">${lista.map(uno).join('')}</div>
      </div></section>`;
    }

    function catalogo(s) {
      const productos = ctx.productos();
      if (!productos.length) return '<section class="sec"><div class="wrap"><p class="empty">Esta tienda aún no tiene productos publicados.</p></div></section>';
      const lista = ctx.ordenInicial().slice(0, 12);
      return `<section class="sec" id="sec-catalogo" aria-labelledby="tit-catalogo"><div class="wrap">
        ${cabeza('catalogo', titulo(s, tituloCatalogoInicio(ctx.tienda())), productos.length > 12 ? 'catalogo' : '')}
        <div class="grid">${lista.map(tarjeta).join('')}</div>
        ${productos.length > 12 ? `<div class="mas-caja"><button class="btn ghost" type="button" data-ir="catalogo">Ver los ${productos.length} ${palabraCatalogo(ctx.tienda())}</button></div>` : ''}
      </div></section>`;
    }

    function informacion(s, t) {
      const hoy = horarioHoy(t);
      const costos = (t.delivery?.zonas || []).map((z) => Number(z.costo) || 0);
      const items = [
        hoy ? [ICO.reloj, 'Horario', esc(hoy)] : null,
        t.direccion ? [ICO.lugar, 'Dónde estamos', esc(t.direccion)] : null,
        t.delivery?.habilitado
          ? [ICO.moto, 'Delivery', costos.length ? `Desde ${esc(money(Math.min(...costos)))}` : 'Disponible']
          : t.retiro?.habilitado !== false ? [ICO.moto, 'Retiro', 'Recoge tu pedido en la tienda'] : null,
        t.pagos?.length ? [ICO.tarjeta, 'Formas de pago', esc(t.pagos.map((p) => p.etiqueta).join(', '))] : null,
      ].filter(Boolean);
      if (!items.length && !t.descripcion) return '';
      return `<section class="sec sec-suave" id="sec-informacion" aria-labelledby="tit-informacion"><div class="wrap">
        ${cabeza('informacion', titulo(s, `Sobre ${esc(t.nombre)}`))}
        ${t.descripcion ? `<p class="info-desc">${esc(t.descripcion)}</p>` : ''}
        <div class="info-grid">${items.map(([ico, tit, val]) => `<div class="info-item"><span class="info-ico">${ico}</span><div><b>${tit}</b><span>${val}</span></div></div>`).join('')}</div>
      </div></section>`;
    }

    function enlacesContacto(t, d) {
      const tel = String(t.telefono || '').replace(/[^\d+]/g, '');
      const wa = waUrl(t.whatsapp || t.telefono);
      const lista = [];
      if (wa) lista.push(`<a class="cto wa" href="${esc(wa)}" target="_blank" rel="noopener">${ICO.whatsapp}<span>WhatsApp</span></a>`);
      if (tel.replace(/\D/g, '').length >= 7) lista.push(`<a class="cto" href="tel:${esc(tel)}">${ICO.telefono}<span>${esc(t.telefono)}</span></a>`);
      if (t.email) lista.push(`<a class="cto" href="mailto:${esc(t.email)}">${ICO.correo}<span>${esc(t.email)}</span></a>`);
      const nombres = { facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };
      for (const [red, url] of Object.entries(d.redes || {})) {
        if (url && ICO[red]) lista.push(`<a class="cto" href="${esc(url)}" target="_blank" rel="noopener">${ICO[red]}<span>${nombres[red]}</span></a>`);
      }
      return lista;
    }

    function contacto(s, t, d) {
      const lista = enlacesContacto(t, d);
      if (t.solicitudes?.cotizacion) lista.unshift('<button class="cto" type="button" data-solicitud="cotizacion" data-solicitud-id="">Solicitar cotización</button>');
      if (!lista.length) return '';
      return `<section class="sec" id="sec-contacto" aria-labelledby="tit-contacto"><div class="wrap">
        ${cabeza('contacto', titulo(s, 'Contáctanos'))}
        <div class="ctos">${lista.join('')}</div>
      </div></section>`;
    }

    function inicio(t) {
      const d = t.diseno;
      const hechos = {
        hero: () => hero(t, d),
        categorias: (s) => categorias(s),
        destacados: (s) => filaProductos('destacados', titulo(s, 'Productos destacados'), ctx.lista('destacados'), 'destacados'),
        nuevos: (s) => vitrina('nuevos', s, 'Nuevos productos', d),
        ofertas: (s) => vitrina('ofertas', s, 'Ofertas especiales', d),
        masVendidos: (s) => filaProductos('masVendidos', titulo(s, 'Los más vendidos'), ctx.lista('masVendidos'), 'masVendidos'),
        marcas: (s) => marcas(s),
        banners: () => banners(t),
        catalogo: (s) => catalogo(s),
        informacion: (s) => informacion(s, t),
        contacto: (s) => contacto(s, t, d),
      };
      return d.secciones.filter((s) => s.activa && hechos[s.id]).map((s) => hechos[s.id](s)).join('');
    }

    function pie(t) {
      const d = t.diseno;
      if (!d.secciones.find((s) => s.id === 'pie')?.activa) return '';
      const cats = ctx.categorias().slice(0, 5);
      const hoy = horarioHoy(t);
      const contactos = enlacesContacto(t, d);
      return `<footer class="foot"><div class="wrap">
        <div class="foot-cols">
          <div class="foot-marca">
            <b>${esc(t.nombre)}</b>
            ${t.descripcion ? `<p>${esc(t.descripcion)}</p>` : ''}
            ${hoy ? `<p>${esc(hoy)}</p>` : ''}
            ${t.direccion ? `<p>${esc(t.direccion)}</p>` : ''}
          </div>
          ${cats.length ? `<div><h3>Comprar</h3>
            <button type="button" data-ir="catalogo">Todos los productos</button>
            ${cats.map((c) => `<button type="button" data-ir="categoria:${esc(c)}">${esc(c)}</button>`).join('')}
          </div>` : ''}
          <div><h3>Tu cuenta</h3>
            <button type="button" data-nav="pedidos">Mis pedidos</button>
            <button type="button" data-nav="favoritos">Favoritos</button>
            <button type="button" data-nav="carrito">Carrito</button>
          </div>
          ${contactos.length ? `<div class="foot-cto"><h3>Contacto</h3>${contactos.join('')}</div>` : ''}
        </div>
        <p class="foot-marca-tc">Pedidos procesados por ${esc(t.nombre)} con Tecno Caja.</p>
      </div></footer>`;
    }

    return { inicio, pie, botonDestino };
  }

  window.TCSecciones = { crear, ICO };
})();
