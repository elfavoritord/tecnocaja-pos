/* Biblioteca vectorial 2D compartida por el editor y su validación
   (server/services/mesas-plano.js). Vista desde arriba: cada figura se dibuja
   en su tamaño por defecto (viewBox = ancho × alto) para que no se deforme;
   si el usuario la estira, se estira con ella.
   Los tipos ya guardados en planos no se renombran ni se quitan. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MesasElementos = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const MADERA = '#b77b47';
  const G = {
    mesas: 'Mesas y asientos', cocina: 'Bar y cocina', tienda: 'Tienda y supermercado', belleza: 'Salud y belleza',
    oficina: 'Atención y oficina', estructura: 'Estructura y espacios', exterior: 'Exterior y decoración', formas: 'Formas y texto',
  };
  // [tipo, nombre, grupo, forma, ancho, alto, vendible, capacidad, color, palabras para buscar]
  const filas = [
    ['mesa2', 'Mesa · 2 plazas', G.mesas, 'mesa', 110, 90, true, 2, MADERA, 'pareja cuadrada'],
    ['mesa4', 'Mesa · 4 plazas', G.mesas, 'mesa', 120, 120, true, 4, MADERA, 'cuadrada comedor'],
    ['mesa6', 'Mesa · 6 plazas', G.mesas, 'mesa', 160, 120, true, 6, MADERA, 'rectangular familiar'],
    ['mesa8', 'Mesa · 8 plazas', G.mesas, 'mesa', 180, 120, true, 8, MADERA, 'rectangular grupo'],
    ['mesa10', 'Mesa · 10 plazas', G.mesas, 'mesa', 240, 120, true, 10, MADERA, 'banquete evento larga'],
    ['mesaRedonda2', 'Mesa bistró · 2', G.mesas, 'circulo', 90, 90, true, 2, MADERA, 'redonda pequeña cafe cafeteria'],
    ['mesaRedonda', 'Mesa redonda', G.mesas, 'circulo', 120, 120, true, 4, MADERA, 'redonda 4'],
    ['mesaRedonda6', 'Mesa redonda · 6', G.mesas, 'circulo', 150, 150, true, 6, MADERA, 'redonda grande'],
    ['mesaAlta', 'Mesa alta', G.mesas, 'circulo', 100, 100, true, 4, '#5f4b3b', 'periquera taburetes bar coctel'],
    ['reservado', 'Reservado', G.mesas, 'mesa', 150, 130, true, 4, MADERA, 'booth gabinete butaca'],
    ['terraza', 'Mesa con sombrilla', G.mesas, 'circulo', 140, 140, true, 4, '#e0623f', 'terraza exterior patio parasol'],
    ['barra', 'Barra con taburetes', G.mesas, 'mueble', 240, 90, true, 5, '#8a5a36', 'bar barra tragos bebidas'],
    ['silla', 'Silla', G.mesas, 'mueble', 64, 70, false, 1, MADERA, 'asiento'],
    ['taburete', 'Taburete', G.mesas, 'mueble', 50, 50, false, 1, '#4a5563', 'banco alto bar'],
    ['sillon', 'Sillón', G.mesas, 'mueble', 90, 90, false, 1, '#7f9cb3', 'butaca poltrona'],
    ['sofa', 'Sofá / espera', G.mesas, 'mueble', 150, 90, false, 3, '#a2b8b1', 'sala espera mueble'],
    ['banca', 'Banca', G.mesas, 'mueble', 160, 60, false, 3, MADERA, 'banco espera'],

    ['cafetera', 'Máquina de café', G.cocina, 'mueble', 80, 60, false, 0, '#36404b', 'cafe espresso cafeteria'],
    ['estufa', 'Estufa / fogones', G.cocina, 'mueble', 110, 80, false, 0, '#cfd6dd', 'cocina hornilla fogon'],
    ['horno', 'Horno', G.cocina, 'mueble', 90, 80, false, 0, '#cfd6dd', 'pizza panaderia'],
    ['freidora', 'Freidora', G.cocina, 'mueble', 70, 80, false, 0, '#cfd6dd', 'frituras pica pollo'],
    ['fregadero', 'Fregadero', G.cocina, 'mueble', 120, 70, false, 0, '#cfd6dd', 'lavaplatos lavadero'],
    ['mesaTrabajo', 'Mesa de acero', G.cocina, 'mueble', 160, 70, false, 0, '#cfd6dd', 'preparacion trabajo cocina'],
    ['nevera', 'Nevera', G.cocina, 'mueble', 80, 80, false, 0, '#eef2f5', 'refrigerador frigorifico frio'],
    ['congelador', 'Congelador', G.cocina, 'mueble', 130, 70, false, 0, '#eef2f5', 'freezer helados hielo frio'],

    ['estanteria', 'Estantería', G.tienda, 'mueble', 150, 90, false, 0, MADERA, 'anaquel repisa colmado'],
    ['gondola', 'Góndola doble', G.tienda, 'mueble', 200, 70, false, 0, '#cfd6dd', 'pasillo supermercado anaquel'],
    ['vitrina', 'Vitrina', G.tienda, 'mueble', 150, 90, false, 0, '#dbf1f6', 'exhibidor cristal reposteria joyeria'],
    ['neveraVitrina', 'Nevera exhibidora', G.tienda, 'mueble', 170, 70, false, 0, '#3a4652', 'refrigerador bebidas cervezas puertas de cristal frio'],
    ['checkout', 'Caja con banda', G.tienda, 'mueble', 200, 90, false, 0, '#c9d3dc', 'checkout supermercado caja registradora'],
    ['frutas', 'Exhibidor de frutas', G.tienda, 'mueble', 160, 110, false, 0, MADERA, 'verduras vegetales colmado cajones'],
    ['pallet', 'Pallet con cajas', G.tienda, 'mueble', 110, 100, false, 0, '#c9a26e', 'tarima almacen deposito mercancia'],
    ['perchero', 'Perchero de ropa', G.tienda, 'mueble', 160, 60, false, 0, '#9aa6b2', 'ropa boutique colgador'],
    ['probador', 'Probador', G.tienda, 'mueble', 110, 110, false, 0, '#9b7bd4', 'vestidor boutique cortina'],
    ['maniqui', 'Maniquí', G.tienda, 'decoracion', 60, 60, false, 0, '#e9d9c9', 'boutique ropa exhibicion'],
    ['isla', 'Mesa exhibidora', G.tienda, 'mueble', 140, 90, false, 0, MADERA, 'isla exhibicion ofertas'],
    ['carrito', 'Carrito de compras', G.tienda, 'mueble', 60, 90, false, 0, '#d9534f', 'supermercado carro'],

    ['sillonBarberia', 'Sillón de barbería', G.belleza, 'mueble', 90, 110, true, 1, '#2f3a45', 'barberia peluqueria salon estilista'],
    ['lavacabezas', 'Lavacabezas', G.belleza, 'mueble', 90, 110, false, 1, '#2f3a45', 'lavado cabello salon'],
    ['tocador', 'Tocador con espejo', G.belleza, 'mueble', 150, 60, false, 0, '#f1ece6', 'espejo maquillaje salon'],
    ['manicura', 'Mesa de manicura', G.belleza, 'mueble', 110, 90, true, 1, '#f1ece6', 'unas manicure pedicure'],
    ['camilla', 'Camilla', G.belleza, 'mueble', 80, 170, true, 1, '#8fc1cf', 'spa masaje consultorio clinica'],

    ['mostrador', 'Mostrador', G.oficina, 'mueble', 180, 85, true, 0, MADERA, 'counter despacho farmacia'],
    ['caja', 'Caja / recepción', G.oficina, 'mueble', 130, 100, false, 0, MADERA, 'recepcion cajero punto de venta'],
    ['puesto', 'Puesto de servicio', G.oficina, 'mueble', 110, 130, true, 1, MADERA, 'ventanilla atencion cliente'],
    ['escritorio', 'Escritorio', G.oficina, 'mueble', 140, 110, false, 1, MADERA, 'oficina computadora'],
    ['sillaOficina', 'Silla de oficina', G.oficina, 'mueble', 60, 60, false, 1, '#3c4654', 'giratoria'],
    ['mesaJuntas', 'Mesa de reuniones', G.oficina, 'mesa', 220, 120, false, 8, '#6f5845', 'juntas conferencia sala'],
    ['archivo', 'Archivero', G.oficina, 'mueble', 70, 60, false, 0, '#9aa6b2', 'archivo gaveta documentos'],
    ['pantalla', 'Pantalla / TV', G.oficina, 'mueble', 150, 30, false, 0, '#25303b', 'television monitor menu digital'],

    ['pared', 'Pared', G.estructura, 'pared', 200, 24, false, 0, '#6d7888', 'muro'],
    ['divisor', 'Divisor', G.estructura, 'pared', 160, 28, false, 0, '#a7b1bc', 'mampara separador'],
    ['puerta', 'Puerta', G.estructura, 'puerta', 90, 90, false, 0, '#e8d5ba', 'acceso'],
    ['puertaDoble', 'Puerta doble', G.estructura, 'puerta', 160, 90, false, 0, '#e8d5ba', 'entrada principal'],
    ['ventana', 'Ventana', G.estructura, 'mueble', 130, 34, false, 0, '#bde6f1', 'cristal'],
    ['columna', 'Columna', G.estructura, 'decoracion', 60, 60, false, 0, '#8a95a3', 'pilar'],
    ['escalera', 'Escalera', G.estructura, 'mueble', 120, 160, false, 0, '#d9dee3', 'escalones segundo piso'],
    ['bano', 'Baño', G.estructura, 'mueble', 100, 120, false, 0, '#e8f0f5', 'inodoro sanitario wc'],
    ['lavamanos', 'Lavamanos', G.estructura, 'mueble', 80, 60, false, 0, '#e9edf1', 'lavabo bano'],
    ['entrada', 'Entrada / salida', G.estructura, 'decoracion', 120, 60, false, 0, '#4a5563', 'alfombra acceso flecha'],

    ['planta', 'Planta', G.exterior, 'decoracion', 70, 80, false, 0, '#53a36d', 'maceta decoracion'],
    ['arbol', 'Árbol', G.exterior, 'decoracion', 110, 110, false, 0, '#4f9a5f', 'jardin exterior'],
    ['sombrilla', 'Sombrilla', G.exterior, 'decoracion', 130, 130, false, 0, '#e0623f', 'parasol terraza'],
    ['tarima', 'Tarima / escenario', G.exterior, 'mueble', 240, 140, false, 0, '#9c6b43', 'musica en vivo dj karaoke'],
    ['alfombra', 'Alfombra', G.exterior, 'decoracion', 160, 110, false, 0, '#a85b4b', 'tapete decoracion'],
    ['parqueo', 'Parqueo', G.exterior, 'mueble', 120, 200, false, 0, '#4f84c4', 'estacionamiento carro parking car wash'],
    ['extintor', 'Extintor', G.exterior, 'decoracion', 40, 40, false, 0, '#d9363e', 'seguridad incendio'],
    ['basurero', 'Zafacón', G.exterior, 'decoracion', 50, 50, false, 0, '#6b7785', 'basura papelera bote'],

    ['zona', 'Zona', G.formas, 'zona', 240, 180, false, 0, '#a8bed6', 'area seccion salon'],
    ['texto', 'Texto', G.formas, 'texto', 150, 45, false, 0, '#77899b', 'letrero rotulo'],
    ['cuadro', 'Cuadrado', G.formas, 'cuadro', 100, 100, false, 0, MADERA, 'forma'],
    ['rectangulo', 'Rectángulo', G.formas, 'rectangulo', 150, 90, false, 0, MADERA, 'forma'],
    ['circulo', 'Círculo', G.formas, 'circulo', 100, 100, false, 0, MADERA, 'forma redonda'],
  ];
  const catalogo = filas.map(([tipo, nombre, grupo, forma, ancho, alto, vendible, capacidad, color, palabras]) =>
    ({ tipo, nombre, grupo, forma, ancho, alto, vendible, capacidad, color, palabras }));
  function buscar(tipo) { return catalogo.find((e) => e.tipo === tipo); }

  // ── Piezas de dibujo ─────────────────────────────────────────────────────
  // Contorno y sombras en negro translúcido: sirven con cualquier color que
  // elija el usuario y en modo día o noche.
  const C = {
    cojin: '#ead6b8', respaldo: '#c99e70', acero: '#cfd6dd', aceroOscuro: '#97a3af', negro: '#36404b', pantalla: '#25303b',
    vidrio: '#cfeaf5', blanco: '#f6f8fa', tapiz: '#9c4a46', tapizOscuro: '#7d3633', carton: '#d8b483', terracota: '#c98d61',
  };
  const PRODUCTOS = ['#e4572e', '#f3a712', '#29a3a3', '#5b8fd9', '#9b7bd4', '#6cc070', '#e86a92', '#f2cf5b'];
  const n = (v) => Math.round(v * 10) / 10;
  // Contorno por defecto; `extra` puede cambiar cualquiera de sus atributos
  // (un atributo repetido en el SVG se ignora, por eso no se duplica).
  const CONTORNO = [['stroke', '#1d1a17'], ['stroke-opacity', '.42'], ['stroke-width', '1.4'], ['stroke-linejoin', 'round']];
  const linea = (extra = '') => [...CONTORNO.filter(([k]) => !new RegExp(`(^|\\s)${k}=`).test(extra)).map(([k, v]) => `${k}="${v}"`), extra].join(' ').trim();
  const rect = (x, y, w, h, fill, rx = 4, extra = '') => `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${rx}" fill="${fill}" ${linea(extra)}/>`;
  const circ = (cx, cy, r, fill, extra = '') => `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${fill}" ${linea(extra)}/>`;
  const elip = (cx, cy, rx, ry, fill, extra = '') => `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(ry)}" fill="${fill}" ${linea(extra)}/>`;
  const forma = (d, fill, extra = '') => `<path d="${d}" fill="${fill}" ${linea(extra)}/>`;
  const trazo = (d, color = '#1d1a17', op = 0.35, w = 1.4) => `<path d="${d}" fill="none" stroke="${color}" stroke-opacity="${op}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const luz = (x, y, w, h, rx = 3, op = 0.28) => `<rect x="${n(x)}" y="${n(y)}" width="${n(Math.max(0, w))}" height="${n(Math.max(0, h))}" rx="${rx}" fill="#fff" fill-opacity="${op}"/>`;
  const oscuro = (x, y, w, h, rx = 3, op = 0.18) => `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${rx}" fill="#000" fill-opacity="${op}"/>`;
  const sombra = (x, y, w, h, rx = 6) => `<rect x="${n(x + 1.5)}" y="${n(y + 2.5)}" width="${n(w)}" height="${n(h)}" rx="${rx}" fill="#000" fill-opacity=".14"/>`;
  const sombraCirc = (cx, cy, r) => `<circle cx="${n(cx + 1.5)}" cy="${n(cy + 2.5)}" r="${n(r)}" fill="#000" fill-opacity=".14"/>`;
  const en = (contenido, x, y, ang = 0) => `<g transform="translate(${n(x)} ${n(y)})${ang ? ` rotate(${ang})` : ''}">${contenido}</g>`;

  // Silla centrada en (x, y); con ángulo 0 el respaldo queda arriba.
  function silla(x, y, ang = 0, w = 22, d = 20, asiento = C.cojin, respaldo = C.respaldo) {
    const g = Math.max(6, d * 0.3);
    return en(sombra(-w / 2, -d / 2, w, d, 6) + rect(-w / 2, -d / 2 + g * 0.6, w, d - g * 0.6, asiento, 6)
      + luz(-w / 2 + 3, -d / 2 + g + 1, w - 6, Math.max(2, d * 0.18), 2, 0.38)
      + rect(-w / 2 - 1, -d / 2, w + 2, g, respaldo, g / 2), x, y, ang);
  }
  function taburete(x, y, r = 10, color = C.negro) {
    return sombraCirc(x, y, r) + circ(x, y, r, color) + `<circle cx="${n(x - r * 0.25)}" cy="${n(y - r * 0.25)}" r="${n(r * 0.45)}" fill="#fff" fill-opacity=".22"/>`;
  }
  function tablero(x, y, w, h, c, rx = 6) {
    return sombra(x, y, w, h, rx) + rect(x, y, w, h, c, rx) + luz(x + 4, y + 4, w - 8, Math.min(8, h * 0.18), Math.max(2, rx - 2), 0.22)
      + trazo(`M${n(x + 9)} ${n(y + h * 0.55)}h${n(w - 18)}M${n(x + 9)} ${n(y + h * 0.75)}h${n(w * 0.55)}`, '#fff', 0.16, 1.2);
  }
  function tableroRedondo(cx, cy, r, c) {
    return sombraCirc(cx, cy, r) + circ(cx, cy, r, c) + `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r * 0.78)}" stroke="#fff" stroke-opacity=".22" stroke-width="1.2"/>`
      + `<ellipse cx="${n(cx - r * 0.3)}" cy="${n(cy - r * 0.38)}" rx="${n(r * 0.36)}" ry="${n(r * 0.16)}" fill="#fff" fill-opacity=".22" transform="rotate(-28 ${n(cx - r * 0.3)} ${n(cy - r * 0.38)})"/>`;
  }
  function mesaRect(W, H, c, porLado, { asiento, respaldo, rx = 6 } = {}) {
    const conLados = porLado > 0;
    const tx = 26, tw = W - 52, ty = conLados ? 26 : 12, th = conLados ? H - 52 : H - 24;
    let s = '';
    for (let i = 0; i < porLado; i++) {
      const x = tx + tw * (i + 0.5) / porLado;
      s += silla(x, 13, 0, 22, 20, asiento, respaldo) + silla(x, H - 13, 180, 22, 20, asiento, respaldo);
    }
    s += silla(13, H / 2, -90, 22, 20, asiento, respaldo) + silla(W - 13, H / 2, 90, 22, 20, asiento, respaldo);
    return s + tablero(tx, ty, tw, th, c, rx);
  }
  function mesaRedonda(W, H, c, cantidad, r) {
    const cx = W / 2, cy = H / 2, d = r + 13;
    let s = '';
    for (let i = 0; i < cantidad; i++) {
      const a = (360 / cantidad) * i + (cantidad === 2 ? 90 : 0);
      const rad = (a * Math.PI) / 180;
      s += silla(cx + d * Math.sin(rad), cy - d * Math.cos(rad), a);
    }
    return s + tableroRedondo(cx, cy, r, c);
  }
  function productos(x, y, w, h, cantidad, desde = 0) {
    const ancho = (w - (cantidad - 1) * 2) / cantidad;
    let s = '';
    for (let i = 0; i < cantidad; i++) s += rect(x + i * (ancho + 2), y, ancho, h, PRODUCTOS[(i + desde) % PRODUCTOS.length], 2, 'stroke-opacity=".25"');
    return s;
  }
  const copo = (cx, cy, r, color = '#3f8fcf') => trazo(`M${cx} ${cy - r}V${cy + r}M${n(cx - r * 0.87)} ${n(cy - r / 2)}L${n(cx + r * 0.87)} ${n(cy + r / 2)}M${n(cx - r * 0.87)} ${n(cy + r / 2)}L${n(cx + r * 0.87)} ${n(cy - r / 2)}`, color, 0.9, 2);
  const reflejo = (x, y, w, h) => trazo(`M${n(x + w * 0.15)} ${n(y + h * 0.85)}L${n(x + w * 0.45)} ${n(y + h * 0.15)}M${n(x + w * 0.35)} ${n(y + h * 0.85)}L${n(x + w * 0.55)} ${n(y + h * 0.4)}`, '#fff', 0.7, 2);
  function octagono(cx, cy, r) {
    return Array.from({ length: 8 }, (_, i) => { const a = (Math.PI / 4) * i + Math.PI / 8; return `${n(cx + r * Math.cos(a))} ${n(cy + r * Math.sin(a))}`; });
  }

  // ── Figuras (W × H = tamaño por defecto) ─────────────────────────────────
  const DIBUJOS = {
    mesa2: (W, H, c) => mesaRect(W, H, c, 0),
    mesa4: (W, H, c) => mesaRect(W, H, c, 1),
    mesa6: (W, H, c) => mesaRect(W, H, c, 2),
    mesa8: (W, H, c) => mesaRect(W, H, c, 3),
    mesa10: (W, H, c) => mesaRect(W, H, c, 4),
    mesaRedonda2: (W, H, c) => mesaRedonda(W, H, c, 2, 22),
    mesaRedonda: (W, H, c) => mesaRedonda(W, H, c, 4, 33),
    mesaRedonda6: (W, H, c) => mesaRedonda(W, H, c, 6, 42),
    mesaAlta: (W, H, c) => [[26, 26], [74, 26], [26, 74], [74, 74]].map(([x, y]) => taburete(x, y, 10)).join('') + tableroRedondo(50, 50, 22, c),
    reservado: (W, H, c) => {
      const banco = (y, arriba) => sombra(4, y, W - 8, 34, 7) + rect(4, y, W - 8, 34, C.tapiz, 7)
        + rect(4, arriba ? y : y + 24, W - 8, 10, C.tapizOscuro, 5)
        + trazo(`M${W / 2} ${arriba ? y + 12 : y + 3}v19`, '#000', 0.25, 1.4) + luz(10, arriba ? y + 14 : y + 4, W - 20, 5, 2, 0.18);
      return banco(4, true) + banco(H - 38, false) + tablero(18, 44, W - 36, H - 88, c);
    },
    terraza: (W, H, c) => {
      const pts = octagono(W / 2, H / 2, 64);
      let gajos = '';
      for (let i = 0; i < 8; i++) if (i % 2 === 0) gajos += `<path d="M${W / 2} ${H / 2}L${pts[i]}L${pts[(i + 1) % 8]}Z" fill="#fff" fill-opacity=".22"/>`;
      return mesaRedonda(W, H, MADERA, 4, 24)
        + `<path d="M${pts.join('L')}Z" fill="${c}" fill-opacity=".55" stroke="#1d1a17" stroke-opacity=".35" stroke-width="1.4"/>` + gajos
        + trazo(pts.map((p) => `M${W / 2} ${H / 2}L${p}`).join(''), '#fff', 0.5, 1.2) + circ(W / 2, H / 2, 4, '#ece7df');
    },
    barra: (W, H, c) => {
      let s = '';
      for (let i = 0; i < 5; i++) s += taburete(24 + i * 48, 70, 11);
      return s + sombra(4, 6, W - 8, 42, 7) + rect(4, 6, W - 8, 42, c, 7) + oscuro(4, 38, W - 8, 10, 5, 0.22)
        + luz(10, 10, W - 20, 6, 3, 0.25) + trazo(`M12 26h${W - 24}`, '#fff', 0.18, 1.2)
        + [40, 120, 200].map((x) => circ(x, 22, 4, '#7ec0a0', 'stroke-opacity=".3"')).join('');
    },
    silla: (W, H, c) => silla(W / 2, H / 2 + 2, 0, 46, 52, C.cojin, c),
    taburete: (W, H, c) => taburete(W / 2, H / 2, 18, c),
    sillon: (W, H, c) => sombra(6, 6, W - 12, H - 12, 14) + rect(6, 6, W - 12, H - 12, c, 14) + oscuro(6, 6, W - 12, 22, 12, 0.18)
      + rect(6, 20, 17, H - 26, c, 8) + rect(W - 23, 20, 17, H - 26, c, 8) + rect(25, 28, W - 50, H - 38, c, 8) + luz(29, 32, W - 58, 12, 5, 0.3),
    sofa: (W, H, c) => {
      let s = sombra(6, 6, W - 12, H - 12, 12) + rect(6, 6, W - 12, H - 12, c, 12) + oscuro(6, 6, W - 12, 24, 10, 0.16)
        + rect(6, 20, 20, H - 26, c, 9) + rect(W - 26, 20, 20, H - 26, c, 9);
      const ancho = (W - 56) / 3;
      for (let i = 0; i < 3; i++) s += rect(28 + i * ancho, 30, ancho - 2, H - 42, c, 7) + luz(32 + i * ancho, 34, ancho - 10, 10, 4, 0.3);
      return s;
    },
    banca: (W, H, c) => sombra(6, 14, W - 12, 32, 5) + rect(6, 14, W - 12, 32, c, 5) + trazo(`M10 24.5h${W - 20}M10 35.5h${W - 20}`, '#000', 0.22, 1.2) + luz(10, 16, W - 20, 5, 2, 0.25),

    cafetera: (W, H, c) => sombra(6, 8, W - 12, H - 16, 7) + rect(6, 8, W - 12, H - 16, c, 7) + luz(10, 11, W - 20, 6, 3, 0.2)
      + circ(26, 32, 9, C.acero) + circ(54, 32, 9, C.acero) + circ(26, 32, 4, C.blanco) + circ(54, 32, 4, C.blanco) + rect(14, 44, 52, 5, C.aceroOscuro, 2),
    estufa: (W, H, c) => {
      let s = sombra(4, 4, W - 8, H - 8, 6) + rect(4, 4, W - 8, H - 8, c, 6) + rect(10, 9, W - 20, 48, '#2f363e', 4);
      for (const [x, y] of [[32, 21], [78, 21], [32, 45], [78, 45]]) s += circ(x, y, 9, '#1f252b') + `<circle cx="${x}" cy="${y}" r="5.5" stroke="#f28b30" stroke-opacity=".85" stroke-width="1.6"/>`;
      for (const x of [25, 45, 65, 85]) s += circ(x, 67, 3.5, C.negro);
      return s;
    },
    horno: (W, H, c) => sombra(4, 4, W - 8, H - 8, 6) + rect(4, 4, W - 8, H - 8, c, 6) + rect(4, 4, W - 8, 13, C.aceroOscuro, 5)
      + [22, 36, 50].map((x) => circ(x, 10.5, 3, C.negro)).join('') + circ(70, 10.5, 3, '#f28b30')
      + rect(14, 24, W - 28, 34, '#3a3f45', 4) + reflejo(14, 24, W - 28, 34) + rect(14, 63, W - 28, 5, C.aceroOscuro, 2),
    freidora: (W, H, c) => sombra(4, 4, W - 8, H - 8, 6) + rect(4, 4, W - 8, H - 8, c, 6)
      + [10, 38].map((x) => rect(x, 12, 22, 38, '#d9a441', 3) + trazo(`M${x + 5} 14v34M${x + 11} 14v34M${x + 17} 14v34M${x + 2} 24h18M${x + 2} 36h18`, '#000', 0.25, 1) + rect(x + 8, 50, 6, 20, C.negro, 2)).join(''),
    fregadero: (W, H, c) => sombra(4, 4, W - 8, H - 8, 5) + rect(4, 4, W - 8, H - 8, c, 5)
      + [12, 64].map((x) => rect(x, 18, 44, 40, '#aeb9c4', 8) + oscuro(x + 2, 20, 40, 6, 5, 0.12) + circ(x + 22, 42, 3, C.aceroOscuro)).join('')
      + rect(55, 6, 10, 7, C.aceroOscuro, 2) + trazo('M60 13v8', '#36404b', 0.6, 2.5),
    mesaTrabajo: (W, H, c) => sombra(4, 6, W - 8, H - 12, 4) + rect(4, 6, W - 8, H - 12, c, 4) + luz(8, 9, W - 16, 6, 2, 0.4)
      + trazo([22, 32, 42, 52].map((y) => `M12 ${y}h${W - 24}`).join(''), '#000', 0.1, 1),
    nevera: (W, H, c) => sombra(4, 4, W - 8, H - 8, 7) + rect(4, 4, W - 8, H - 8, c, 7) + luz(8, 8, W - 16, 8, 3, 0.5)
      + trazo(`M8 58h${W - 16}`, '#000', 0.25, 1.2) + rect(16, 64, 18, 5, C.aceroOscuro, 2) + rect(46, 64, 18, 5, C.aceroOscuro, 2) + copo(W / 2, 32, 12),
    congelador: (W, H, c) => sombra(4, 4, W - 8, H - 8, 7) + rect(4, 4, W - 8, H - 8, c, 7) + rect(10, 10, W - 20, H - 26, '#fff', 5, 'stroke-opacity=".2"')
      + rect(W / 2 - 14, H - 14, 28, 6, C.aceroOscuro, 3) + copo(W / 2, 32, 12),

    estanteria: (W, H, c) => {
      let s = sombra(4, 10, W - 8, H - 20, 4) + rect(4, 10, W - 8, H - 20, c, 4) + rect(10, 16, W - 20, H - 32, '#f3ece2', 2);
      [20, 39, 58].forEach((y, i) => { s += productos(14, y, W - 28, 13, 8, i * 3) + trazo(`M12 ${y + 16}h${W - 24}`, '#000', 0.3, 1.4); });
      return s;
    },
    gondola: (W, H, c) => sombra(4, 4, W - 8, H - 8, 4) + rect(4, 4, W - 8, H - 8, c, 4) + rect(4, 4, 12, H - 8, C.aceroOscuro, 4) + rect(W - 16, 4, 12, H - 8, C.aceroOscuro, 4)
      + productos(20, 9, W - 40, 22, 10, 0) + productos(20, H - 31, W - 40, 22, 10, 4) + trazo(`M16 ${H / 2}h${W - 32}`, '#000', 0.45, 2),
    vitrina: (W, H, c) => sombra(4, 10, W - 8, H - 20, 6) + rect(4, 10, W - 8, H - 20, '#8fa3b3', 6) + rect(10, 16, W - 20, H - 32, c, 3)
      + [28, 56, 84, 112].map((x, i) => circ(x, 35, 9, PRODUCTOS[(i * 2 + 1) % PRODUCTOS.length], 'stroke-opacity=".25"')).join('')
      + productos(20, 50, W - 40, 12, 6, 2) + reflejo(10, 16, W - 20, H - 32),
    neveraVitrina: (W, H, c) => {
      let s = sombra(4, 4, W - 8, H - 8, 6) + rect(4, 4, W - 8, H - 8, c, 6) + luz(8, 6, W - 16, 4, 2, 0.35);
      for (let i = 0; i < 3; i++) {
        const x = 10 + i * 52;
        s += rect(x, 12, 48, 44, C.vidrio, 3);
        for (let f = 0; f < 2; f++) for (let k = 0; k < 4; k++) s += circ(x + 8 + k * 10.5, 24 + f * 18, 4, PRODUCTOS[(i + k + f) % PRODUCTOS.length], 'stroke-opacity=".25"');
        s += trazo(`M${x + 44} 22v24`, '#fff', 0.8, 2) + reflejo(x, 12, 48, 44);
      }
      return s;
    },
    checkout: (W, H, c) => sombra(4, 18, W - 8, H - 24, 6) + rect(4, 18, W - 8, H - 24, c, 6)
      + rect(10, 28, 104, 38, '#2f363e', 4) + trazo([24, 40, 56, 72, 88, 104].map((x) => `M${x} 30v34`).join(''), '#fff', 0.15, 1.2)
      + productos(30, 38, 50, 16, 3, 1) + rect(120, 30, 26, 34, '#5b6b7b', 3) + reflejo(120, 30, 26, 34)
      + rect(154, 24, 34, 20, C.pantalla, 3) + luz(157, 27, 28, 4, 2, 0.25) + rect(154, 48, 34, 22, '#e9edf1', 3)
      + trazo('M160 54h22M160 60h22M160 66h22', '#000', 0.25, 1),
    frutas: (W, H, c) => {
      let s = sombra(4, 4, W - 8, H - 8, 6) + rect(4, 4, W - 8, H - 8, c, 6);
      const colores = ['#e4572e', '#f3a712', '#f2cf5b', '#6cc070', '#9b4dca', '#e86a92'];
      for (let j = 0; j < 2; j++) for (let i = 0; i < 3; i++) {
        const x = 10 + i * 48, y = 10 + j * 47;
        s += rect(x, y, 44, 43, '#e2c49b', 3);
        for (let f = 0; f < 3; f++) for (let k = 0; k < 3; k++) s += circ(x + 9 + k * 13, y + 9 + f * 12.5, 5.6, colores[j * 3 + i], 'stroke-opacity=".3"');
      }
      return s;
    },
    pallet: (W, H, c) => sombra(4, 4, W - 8, H - 8, 3) + rect(4, 4, W - 8, H - 8, c, 3) + trazo([20, 40, 60, 80].map((y) => `M6 ${y}h${W - 12}`).join(''), '#000', 0.2, 1.2)
      + [[12, 12, 40, 36], [56, 12, 42, 36], [12, 52, 86, 38]].map(([x, y, w, h]) => sombra(x, y, w, h, 2) + rect(x, y, w, h, C.carton, 2) + trazo(`M${x} ${y + h / 2}h${w}`, '#fff', 0.55, 3)).join(''),
    perchero: (W, H, c) => {
      let s = '';
      for (let i = 0; i < 9; i++) { const x = 24 + i * 13.5; s += rect(x - 5, 13, 10, 34, PRODUCTOS[i % PRODUCTOS.length], 3, 'stroke-opacity=".3"') + luz(x - 3, 15, 2, 28, 1, 0.3); }
      return s + trazo(`M12 30H${W - 12}`, '#36404b', 0.8, 2.5) + circ(12, 30, 6, c) + circ(W - 12, 30, 6, c);
    },
    probador: (W, H, c) => rect(6, 6, W - 12, H - 18, '#f1edf6', 2, 'stroke-opacity=".15"') + forma(`M6 ${H - 12}V6H${W - 6}V${H - 12}`, 'none', 'stroke="#6d7888" stroke-opacity="1" stroke-width="6"')
      + rect(30, 9, 50, 7, C.vidrio, 2) + circ(W / 2, 50, 11, C.cojin)
      // Cortina: seis ondas de 16 entre x = 8 y x = 104.
      + forma(`M8 ${H - 14}q8 8 16 0t16 0t16 0t16 0t16 0t16 0v10H8z`, c, 'stroke-opacity=".35"'),
    maniqui: (W, H, c) => `<circle cx="${W / 2}" cy="${H / 2}" r="26" fill="#000" fill-opacity=".08"/>` + elip(W / 2, H / 2 + 2, 22, 10, c) + circ(W / 2, H / 2 - 1, 8, c) + luz(W / 2 - 12, H / 2 - 2, 8, 3, 1.5, 0.35),
    isla: (W, H, c) => tablero(6, 6, W - 12, H - 12, c)
      + [[18, 18], [58, 18], [98, 18], [18, 48], [58, 48], [98, 48]].map(([x, y], i) => rect(x, y, 26, 22, PRODUCTOS[(i + 2) % PRODUCTOS.length], 3, 'stroke-opacity=".3"') + trazo(`M${x + 3} ${y + 8}h20M${x + 3} ${y + 14}h20`, '#fff', 0.45, 1)).join(''),
    carrito: (W, H, c) => sombra(10, 6, W - 20, 60, 5) + rect(10, 6, W - 20, 60, '#dfe5ea', 5)
      + trazo([18, 26, 34, 42].map((x) => `M${x} 9v54`).join('') + [18, 30, 42, 54].map((y) => `M13 ${y}h${W - 26}`).join(''), '#36404b', 0.35, 1)
      + rect(8, 72, W - 16, 7, c, 3) + trazo(`M14 66v6M${W - 14} 66v6`, '#36404b', 0.6, 2),

    sillonBarberia: (W, H, c) => rect(30, 92, 30, 14, C.acero, 4) + sombra(18, 30, W - 36, 56, 10)
      + rect(10, 38, 11, 42, C.aceroOscuro, 4) + rect(W - 21, 38, 11, 42, C.aceroOscuro, 4)
      + rect(18, 34, W - 36, 52, c, 10) + rect(21, 12, W - 42, 26, c, 9) + rect(35, 2, 20, 11, c, 4) + luz(24, 40, W - 48, 10, 4, 0.18) + luz(25, 15, W - 50, 6, 3, 0.18),
    lavacabezas: (W, H, c) => sombra(14, 4, W - 28, 36, 14) + elip(W / 2, 22, 30, 18, C.blanco) + elip(W / 2, 22, 18, 10, '#c9dbe6') + circ(W / 2, 22, 2.5, C.aceroOscuro)
      + rect(22, 40, W - 44, 14, c, 6) + rect(18, 52, W - 36, 38, c, 10) + luz(22, 56, W - 44, 8, 3, 0.18) + rect(30, 92, 30, 14, C.acero, 4),
    tocador: (W, H, c) => sombra(4, 24, W - 8, 32, 4) + rect(4, 24, W - 8, 32, c, 4) + rect(10, 6, W - 20, 14, C.vidrio, 3) + reflejo(10, 6, W - 20, 14)
      + [[24, 40, 5, '#e86a92'], [40, 40, 4, '#5b8fd9'], [110, 38, 6, '#f3a712']].map(([x, y, r, col]) => circ(x, y, r, col, 'stroke-opacity=".3"')).join('') + rect(60, 32, 30, 14, '#fff', 3, 'stroke-opacity=".2"'),
    manicura: (W, H, c) => silla(W / 2, 12, 0) + silla(W / 2, H - 12, 180) + tablero(20, 26, W - 40, 38, c)
      + rect(36, 36, 24, 16, '#fff', 3, 'stroke-opacity=".2"') + circ(76, 40, 7, '#f2cf5b') + trazo('M76 47v10', '#36404b', 0.5, 2),
    camilla: (W, H, c) => sombra(6, 6, W - 12, H - 12, 9) + rect(6, 6, W - 12, H - 12, C.acero, 9) + rect(10, 10, W - 20, H - 20, c, 8)
      + rect(18, 16, W - 36, 22, C.blanco, 8) + trazo(`M14 ${H * 0.6}h${W - 28}`, '#fff', 0.5, 2) + luz(14, 44, W - 28, 6, 3, 0.2),

    mostrador: (W, H, c) => sombra(4, 8, W - 8, H - 14, 6) + rect(4, 8, W - 8, H - 14, c, 6) + rect(4, 8, W - 8, 24, '#ece2d3', 6)
      + luz(10, 11, W - 20, 5, 2, 0.4) + trazo([40, 80, 120, 160].filter((x) => x < W - 10).map((x) => `M${x} 38v${H - 52}`).join(''), '#000', 0.16, 1.2),
    caja: (W, H, c) => silla(W / 2, 14, 0) + sombra(4, 30, W - 8, H - 34, 6) + rect(4, 30, W - 8, H - 34, c, 6) + rect(4, 30, W - 8, 18, '#ece2d3', 6)
      + rect(46, 50, 38, 22, C.pantalla, 3) + luz(49, 53, 32, 4, 2, 0.25) + rect(44, 76, 42, 12, '#3a4652', 3) + trazo('M58 82h14', '#fff', 0.4, 1.5),
    puesto: (W, H, c) => silla(W / 2, 18, 0) + silla(W / 2, H - 14, 180) + tablero(8, 36, W - 16, 52, c)
      + rect(W / 2 - 16, 44, 32, 9, C.pantalla, 2) + rect(W / 2 - 18, 60, 36, 11, '#e9edf1', 2, 'stroke-opacity=".25"'),
    escritorio: (W, H, c) => tablero(6, 8, W - 12, 56, c, 5) + rect(48, 14, 44, 9, C.pantalla, 2) + rect(64, 23, 12, 5, C.aceroOscuro, 1)
      + rect(46, 34, 48, 13, '#e9edf1', 2, 'stroke-opacity=".25"') + elip(104, 40, 4, 6, '#e9edf1') + rect(14, 18, 22, 28, '#fff', 1, 'stroke-opacity=".2"')
      + sillaOficina(W / 2, 86, 180, '#3c4654'),
    sillaOficina: (W, H, c) => sillaOficina(W / 2, H / 2 + 2, 0, c),
    mesaJuntas: (W, H, c) => mesaRect(W, H, c, 3, { asiento: '#4b5563', respaldo: '#2f3640', rx: 30 }),
    archivo: (W, H, c) => sombra(6, 6, W - 12, H - 12, 4) + rect(6, 6, W - 12, H - 12, c, 4) + luz(10, 9, W - 20, 6, 2, 0.35)
      + trazo(`M10 ${H - 20}h${W - 20}`, '#000', 0.25, 1.2) + rect(W / 2 - 9, H - 15, 18, 5, C.negro, 2),
    pantalla: (W, H, c) => rect(W / 2 - 15, 18, 30, 7, C.aceroOscuro, 2) + sombra(4, 6, W - 8, 12, 3) + rect(4, 6, W - 8, 12, c, 3) + trazo(`M8 8.5h${W - 16}`, '#7fd0ff', 0.6, 1.5),

    pared: (W, H, c) => rect(0, 2, W, H - 4, c, 2) + trazo(Array.from({ length: Math.floor((W - 8) / 12) }, (_, i) => `M${6 + i * 12} ${H - 4}l8 ${-(H - 8)}`).join(''), '#fff', 0.22, 1.2),
    divisor: (W, H, c) => rect(4, 9, W - 8, H - 18, c, 4) + trazo(`M12 ${H / 2}h${W - 24}`, '#fff', 0.5, 1.5) + circ(6, H / 2, 6, C.aceroOscuro) + circ(W - 6, H / 2, 6, C.aceroOscuro),
    puerta: (W, H, c) => `<path d="M8 ${H - 6}V8A${W - 16} ${H - 14} 0 0 1 ${W - 8} ${H - 6}Z" fill="${c}" fill-opacity=".35"/>`
      + trazo(`M8 8A${W - 16} ${H - 14} 0 0 1 ${W - 8} ${H - 6}`, '#725238', 0.7, 1.5) + rect(4, 8, 7, H - 14, '#8b6a4b', 2) + trazo(`M2 ${H - 5}H${W - 2}`, '#36404b', 0.7, 4),
    puertaDoble: (W, H, c) => {
      const m = W / 2, r = W / 2 - 8;
      return `<path d="M8 ${H - 6}V${H - 6 - r}A${r} ${r} 0 0 1 ${m} ${H - 6}ZM${W - 8} ${H - 6}V${H - 6 - r}A${r} ${r} 0 0 0 ${m} ${H - 6}Z" fill="${c}" fill-opacity=".35"/>`
        + trazo(`M8 ${H - 6 - r}A${r} ${r} 0 0 1 ${m} ${H - 6}M${W - 8} ${H - 6 - r}A${r} ${r} 0 0 0 ${m} ${H - 6}`, '#725238', 0.7, 1.5)
        + rect(4, H - 6 - r, 7, r, '#8b6a4b', 2) + rect(W - 11, H - 6 - r, 7, r, '#8b6a4b', 2) + trazo(`M2 ${H - 5}H${W - 2}`, '#36404b', 0.7, 4);
    },
    ventana: (W, H, c) => rect(0, 4, 10, H - 8, '#6d7888', 1) + rect(W - 10, 4, 10, H - 8, '#6d7888', 1) + rect(10, 10, W - 20, H - 20, c, 2)
      + trazo(`M10 ${H / 2}H${W - 10}M${W / 2} 10v${H - 20}`, '#fff', 0.8, 1.5) + reflejo(10, 10, W - 20, H - 20),
    columna: (W, H, c) => sombra(6, 6, W - 12, H - 12, 3) + rect(6, 6, W - 12, H - 12, c, 3) + trazo(`M12 12L${W - 12} ${H - 12}M${W - 12} 12L12 ${H - 12}`, '#fff', 0.3, 1.4) + luz(9, 9, W - 18, 6, 2, 0.25),
    escalera: (W, H, c) => rect(4, 4, W - 8, H - 8, c, 3) + trazo(Array.from({ length: 10 }, (_, i) => `M6 ${18 + i * 14}h${W - 12}`).join(''), '#000', 0.3, 1.3)
      + trazo(`M${W / 2} ${H - 18}V24M${W / 2 - 10} 36L${W / 2} 24L${W / 2 + 10} 36`, '#36404b', 0.75, 2.4),
    bano: (W, H, c) => sombra(22, 8, 56, 24, 6) + rect(22, 8, 56, 24, c, 6) + luz(26, 11, 48, 6, 3, 0.5) + sombraCirc(50, 70, 30)
      + elip(50, 70, 28, 38, '#fbfdff') + elip(50, 72, 18, 26, c) + elip(50, 74, 10, 15, '#cfe3ee'),
    lavamanos: (W, H, c) => sombra(4, 6, W - 8, H - 12, 6) + rect(4, 6, W - 8, H - 12, c, 6) + elip(W / 2, 34, 22, 14, '#fbfdff') + elip(W / 2, 35, 15, 9, '#cfe3ee')
      + circ(W / 2, 35, 2, C.aceroOscuro) + rect(W / 2 - 4, 9, 8, 6, C.aceroOscuro, 2) + trazo(`M${W / 2} 15v7`, '#36404b', 0.6, 2.5),
    entrada: (W, H, c) => rect(4, 10, W - 8, H - 20, c, 6) + trazo(`M14 ${H / 2}H${W - 30}M${W - 44} ${H / 2 - 12}L${W - 28} ${H / 2}L${W - 44} ${H / 2 + 12}`, '#6ee7a8', 0.95, 4),

    planta: (W, H, c) => {
      const cx = W / 2, cy = H / 2 + 4;
      let hojas = '';
      for (let i = 0; i < 5; i++) hojas += `<ellipse cx="${cx}" cy="${n(cy - 15)}" rx="9" ry="19" fill="${c}" stroke="#1d1a17" stroke-opacity=".35" stroke-width="1.2" transform="rotate(${i * 72} ${cx} ${n(cy)})"/>`;
      return sombraCirc(cx, cy, 24) + circ(cx, cy, 24, C.terracota) + circ(cx, cy, 19, '#6b4b35') + hojas + circ(cx, cy, 6, '#a4c97c');
    },
    arbol: (W, H, c) => sombraCirc(W / 2 + 4, H / 2 + 4, 44)
      + [[55, 32, 26], [32, 52, 24], [78, 52, 24], [44, 76, 24], [68, 76, 24], [55, 55, 28]].map(([x, y, r]) => circ(x, y, r, c, 'stroke-opacity=".25"')).join('')
      + [[48, 44, 10], [70, 64, 8], [40, 66, 7]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" fill-opacity=".14"/>`).join('') + circ(55, 55, 5, '#6b4b35'),
    sombrilla: (W, H, c) => {
      const pts = octagono(W / 2, H / 2, 60);
      let gajos = '';
      for (let i = 0; i < 8; i++) if (i % 2 === 0) gajos += `<path d="M${W / 2} ${H / 2}L${pts[i]}L${pts[(i + 1) % 8]}Z" fill="#fff" fill-opacity=".3"/>`;
      return `<path d="M${pts.map((p) => p.split(' ').map((v) => n(Number(v) + 2)).join(' ')).join('L')}Z" fill="#000" fill-opacity=".14"/>`
        + `<path d="M${pts.join('L')}Z" fill="${c}" stroke="#1d1a17" stroke-opacity=".4" stroke-width="1.4"/>` + gajos
        + trazo(pts.map((p) => `M${W / 2} ${H / 2}L${p}`).join(''), '#fff', 0.55, 1.2) + circ(W / 2, H / 2, 5, '#ece7df');
    },
    tarima: (W, H, c) => sombra(4, 4, W - 8, H - 8, 6) + rect(4, 4, W - 8, H - 8, c, 6)
      + trazo(Array.from({ length: Math.floor((W - 8) / 24) }, (_, i) => `M${28 + i * 24} 6v${H - 12}`).join(''), '#000', 0.16, 1.2)
      + oscuro(4, H - 16, W - 8, 12, 5, 0.2) + rect(10, 10, 26, 34, C.negro, 4) + rect(W - 36, 10, 26, 34, C.negro, 4)
      + circ(23, 27, 7, '#4b5563') + circ(W - 23, 27, 7, '#4b5563') + circ(W / 2, H / 2, 5, C.negro) + trazo(`M${W / 2} ${H / 2 + 5}v12`, '#36404b', 0.6, 2),
    alfombra: (W, H, c) => rect(8, 4, W - 16, H - 8, c, 3) + rect(16, 12, W - 32, H - 24, 'none', 2, 'stroke="#fff" stroke-opacity=".55" stroke-width="2"')
      + forma(`M${W / 2} ${H / 2 - 22}L${W / 2 + 34} ${H / 2}L${W / 2} ${H / 2 + 22}L${W / 2 - 34} ${H / 2}Z`, '#fff', 'fill-opacity=".22" stroke-opacity=".2"')
      + trazo(Array.from({ length: 9 }, (_, i) => `M8 ${10 + i * 11}h-6M${W - 8} ${10 + i * 11}h6`).join(''), '#000', 0.3, 1.2),
    parqueo: (W, H, c) => rect(0, 0, W, H, '#5f6873', 2, 'stroke-opacity=".2"') + trazo(`M4 0V${H}M${W - 4} 0V${H}`, '#fff', 0.9, 3)
      + sombra(22, 30, W - 44, 140, 22) + rect(22, 30, W - 44, 140, c, 22) + rect(30, 62, W - 60, 26, C.vidrio, 6) + rect(30, 132, W - 60, 18, C.vidrio, 5)
      + luz(34, 92, W - 68, 36, 6, 0.18) + rect(24, 40, 6, 12, '#f6e27a', 2, 'stroke-opacity=".2"') + rect(W - 30, 40, 6, 12, '#f6e27a', 2, 'stroke-opacity=".2"'),
    extintor: (W, H, c) => sombraCirc(W / 2, H / 2, 14) + circ(W / 2, H / 2, 14, c) + circ(W / 2, H / 2, 6, C.negro) + trazo(`M${W / 2 + 4} ${H / 2 - 4}q10 -6 12 -14`, '#1d1a17', 0.7, 2.2) + luz(W / 2 - 9, H / 2 - 9, 6, 4, 2, 0.35),
    basurero: (W, H, c) => sombraCirc(W / 2, H / 2, 19) + circ(W / 2, H / 2, 19, c) + circ(W / 2, H / 2, 14, '#8a96a4') + trazo(`M${W / 2 - 7} ${H / 2}h14`, '#1d1a17', 0.6, 3),

    zona: (W, H, c) => `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="3" fill="${c}" fill-opacity=".28" stroke="${c}" stroke-width="1"/>`,
    texto: (W, H, c) => trazo(`M${W / 2 - 22} 14v-6h44v6M${W / 2} 8v30M${W / 2 - 9} 38h18`, c, 1, 4),
    cuadro: (W, H, c) => `<rect x="10" y="10" width="${W - 20}" height="${H - 20}" rx="6" fill="${c}" fill-opacity=".18" stroke="${c}" stroke-width="2"/>`,
    rectangulo: (W, H, c) => `<rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="6" fill="${c}" fill-opacity=".18" stroke="${c}" stroke-width="2"/>`,
    circulo: (W, H, c) => `<circle cx="${W / 2}" cy="${H / 2}" r="${Math.min(W, H) / 2 - 10}" fill="${c}" fill-opacity=".2" stroke="${c}" stroke-width="2"/>`,
  };
  // Silla de oficina centrada en (x, y): base de cinco patas, asiento y
  // respaldo (arriba con ángulo 0).
  function sillaOficina(x, y, ang, c) {
    const patas = Array.from({ length: 5 }, (_, i) => { const a = (Math.PI * 2 * i) / 5 - Math.PI / 2; return `M0 0l${n(Math.cos(a) * 22)} ${n(Math.sin(a) * 22)}`; }).join('');
    return en(trazo(patas, '#36404b', 0.45, 3) + sombra(-17, -12, 34, 30, 10) + rect(-17, -10, 34, 28, c, 10) + luz(-13, -4, 26, 6, 3, 0.18)
      + rect(-19, -21, 38, 12, c, 6) + oscuro(-19, -21, 38, 12, 6, 0.15), x, y, ang);
  }

  function dibujo(tipo, color, { miniatura = false } = {}) {
    const modelo = buscar(tipo);
    const c = /^#[0-9a-f]{6}$/i.test(color || '') ? color : modelo?.color || MADERA;
    const W = modelo?.ancho || 100, H = modelo?.alto || 100;
    const pintar = DIBUJOS[tipo] || ((w, h, col) => `<rect x="10" y="15" width="${w - 20}" height="${h - 30}" rx="5" fill="${col}" fill-opacity=".15" stroke="${col}" stroke-width="2"/>`);
    // En el plano la figura llena su recuadro; en la biblioteca se ve entera.
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="${miniatura ? 'xMidYMid meet' : 'none'}" fill="none" aria-hidden="true" focusable="false">${pintar(W, H, c)}</svg>`;
  }
  return { catalogo, buscar, dibujo };
});
