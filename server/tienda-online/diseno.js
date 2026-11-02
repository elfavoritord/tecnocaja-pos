'use strict';

// Diseño de la tienda online: lo que el negocio personaliza (colores, letra,
// encabezado, portada y orden de las secciones). Es solo configuración visual:
// ningún dato de productos, precios ni existencia vive aquí.
//
// El POS lo valida al guardar y la nube lo vuelve a validar al mostrar. Las dos
// usan este archivo (la nube lo copia con `npm run vendor-sync`).

const VERSION_DISENO = 1;

/** "fija": no se mueve con arrastrar. "siempre": no se puede apagar. */
const SECCIONES = [
  { id: 'encabezado', nombre: 'Encabezado', fija: 'arriba' },
  { id: 'hero', nombre: 'Banner principal' },
  { id: 'categorias', nombre: 'Categorías destacadas' },
  { id: 'destacados', nombre: 'Productos destacados' },
  { id: 'nuevos', nombre: 'Nuevos productos' },
  { id: 'ofertas', nombre: 'Ofertas especiales' },
  { id: 'masVendidos', nombre: 'Más vendidos' },
  { id: 'marcas', nombre: 'Marcas' },
  { id: 'banners', nombre: 'Banners publicitarios' },
  { id: 'catalogo', nombre: 'Todos los productos', siempre: true },
  { id: 'informacion', nombre: 'Información del negocio' },
  { id: 'contacto', nombre: 'Contacto y redes sociales' },
  { id: 'pie', nombre: 'Pie de página', fija: 'abajo' },
];
const IDS_SECCIONES = SECCIONES.map((s) => s.id);

const TIPOGRAFIAS = [
  { id: 'inter', nombre: 'Inter', css: '"Inter"' },
  { id: 'poppins', nombre: 'Poppins', css: '"Poppins"' },
  { id: 'nunito', nombre: 'Nunito', css: '"Nunito"' },
  { id: 'montserrat', nombre: 'Montserrat', css: '"Montserrat"' },
  { id: 'playfair', nombre: 'Playfair Display (elegante)', css: '"Playfair Display"' },
  { id: 'sistema', nombre: 'La del teléfono o computadora', css: '' },
];

const OPCIONES = {
  tamanoTexto: ['pequeno', 'normal', 'grande'],
  estiloBotones: ['redondeado', 'pastilla', 'recto', 'contorno'],
  esquinas: ['rectas', 'suaves', 'redondas'],
  sombras: ['ninguna', 'suaves', 'marcadas'],
  espaciado: ['compacto', 'normal', 'amplio'],
  estiloTarjetas: ['limpia', 'borde', 'elevada'],
  tamanoLogo: ['pequeno', 'mediano', 'grande'],
  alturaHero: ['baja', 'media', 'alta'],
  alineacionHero: ['izquierda', 'centro', 'derecha'],
};

/** Las dos secciones con movimiento continuo. */
const VITRINAS = {
  ofertas: {
    cantidad: 24, velocidad: 40, direccion: 'izquierda',
    colorFondo: null, colorTitulo: null, colorEtiqueta: null, estiloTarjeta: 'tienda',
  },
  nuevos: {
    cantidad: 24, velocidad: 40, direccion: 'derecha',
    colorFondo: null, colorTitulo: null, colorEtiqueta: null, estiloTarjeta: 'tienda', diasNuevo: 30,
  },
};
const LIMITES_VITRINA = {
  cantidad: { min: 4, max: 40 },
  velocidad: { min: 10, max: 150 }, // píxeles por segundo
  diasNuevo: { min: 1, max: 365 },
};
const OPCIONES_VITRINA = {
  direccion: ['izquierda', 'derecha'],
  estiloTarjeta: ['tienda', 'limpia', 'borde', 'elevada'],
};

const MAX_ANUNCIOS = 4;
const REDES = ['facebook', 'instagram', 'tiktok', 'youtube'];

function ordenSecciones(medio) {
  return ['encabezado', ...medio, 'pie'].map((id) => ({ id, activa: true, titulo: '' }));
}

/**
 * Los tres puntos de partida. Solo son valores iniciales: todo se puede cambiar.
 * Un color en null se toma del color del negocio (Mi Negocio → color principal).
 */
const ESTILOS = {
  moderno: {
    nombre: 'Moderno',
    descripcion: 'Limpio y con mucho aire. Fotos grandes y tarjetas sin bordes.',
    colores: {
      principal: null, secundario: '#0f172a', fondo: '#ffffff', texto: '#0f172a', botones: null,
      encabezado: '#ffffff', pie: '#0f172a', tarjetas: '#ffffff', destacados: '#e11d48',
    },
    apariencia: {
      tipografia: 'inter', tipografiaTitulos: 'inter', tamanoTexto: 'normal', estiloBotones: 'pastilla',
      esquinas: 'redondas', sombras: 'suaves', espaciado: 'normal', estiloTarjetas: 'limpia',
    },
    hero: { altura: 'media', alineacion: 'izquierda' },
    secciones: ordenSecciones(['hero', 'categorias', 'destacados', 'ofertas', 'nuevos', 'masVendidos', 'marcas', 'banners', 'catalogo', 'informacion', 'contacto']),
  },
  comercial: {
    nombre: 'Comercial',
    descripcion: 'Mucho producto a la vista y las ofertas primero, como un supermercado.',
    colores: {
      principal: null, secundario: '#f59e0b', fondo: '#f1f5f9', texto: '#111827', botones: null,
      encabezado: null, pie: '#111827', tarjetas: '#ffffff', destacados: '#dc2626',
    },
    apariencia: {
      tipografia: 'poppins', tipografiaTitulos: 'poppins', tamanoTexto: 'normal', estiloBotones: 'redondeado',
      esquinas: 'suaves', sombras: 'suaves', espaciado: 'compacto', estiloTarjetas: 'elevada',
    },
    hero: { altura: 'baja', alineacion: 'izquierda' },
    secciones: ordenSecciones(['hero', 'ofertas', 'categorias', 'masVendidos', 'destacados', 'nuevos', 'banners', 'marcas', 'catalogo', 'informacion', 'contacto']),
  },
  premium: {
    nombre: 'Premium',
    descripcion: 'Elegante: letra fina, tonos sobrios y portada a todo lo alto.',
    colores: {
      principal: '#1c1917', secundario: '#a8894f', fondo: '#faf8f5', texto: '#1c1917', botones: '#1c1917',
      encabezado: '#faf8f5', pie: '#1c1917', tarjetas: '#ffffff', destacados: '#a8894f',
    },
    apariencia: {
      tipografia: 'inter', tipografiaTitulos: 'playfair', tamanoTexto: 'normal', estiloBotones: 'recto',
      esquinas: 'rectas', sombras: 'ninguna', espaciado: 'amplio', estiloTarjetas: 'borde',
    },
    hero: { altura: 'alta', alineacion: 'centro' },
    secciones: ordenSecciones(['hero', 'destacados', 'categorias', 'nuevos', 'banners', 'ofertas', 'masVendidos', 'marcas', 'catalogo', 'informacion', 'contacto']),
  },
};

const ESTILO_BASE = 'moderno';
const IDS_COLORES = Object.keys(ESTILOS[ESTILO_BASE].colores);

// ── Validadores ─────────────────────────────────────────────────────────────
function color(valor, respaldo) {
  if (valor === null) return null;
  const s = String(valor ?? '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(s) ? s : respaldo;
}

function opcion(valor, lista, respaldo) {
  return lista.includes(valor) ? valor : respaldo;
}

function bool(valor, respaldo) {
  return typeof valor === 'boolean' ? valor : respaldo;
}

function texto(valor, max, respaldo = '') {
  if (valor === undefined || valor === null) return respaldo;
  return String(valor).replace(/[\s]+/g, ' ').trim().slice(0, max);
}

function entero(valor, { min, max }, respaldo) {
  const n = Number(valor);
  if (valor === null || valor === '' || !Number.isFinite(n)) return respaldo;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizarVitrina(entrada, base) {
  const e = entrada && typeof entrada === 'object' ? entrada : {};
  const limpia = {
    cantidad: entero(e.cantidad, LIMITES_VITRINA.cantidad, base.cantidad),
    velocidad: entero(e.velocidad, LIMITES_VITRINA.velocidad, base.velocidad),
    direccion: opcion(e.direccion, OPCIONES_VITRINA.direccion, base.direccion),
    colorFondo: color(e.colorFondo, null),
    colorTitulo: color(e.colorTitulo, null),
    colorEtiqueta: color(e.colorEtiqueta, null),
    estiloTarjeta: opcion(e.estiloTarjeta, OPCIONES_VITRINA.estiloTarjeta, base.estiloTarjeta),
  };
  if (base.diasNuevo) limpia.diasNuevo = entero(e.diasNuevo, LIMITES_VITRINA.diasNuevo, base.diasNuevo);
  return limpia;
}

/** Solo https: el dueño no puede dejar en su tienda un enlace javascript: ni http. */
function urlSegura(valor) {
  const s = String(valor ?? '').trim().slice(0, 300);
  if (!/^https:\/\/[^\s"'<>]+$/i.test(s)) return '';
  try {
    return new URL(s).protocol === 'https:' ? s : '';
  } catch (_e) {
    return '';
  }
}

/** A dónde lleva un botón: un lugar de la tienda, una categoría o una dirección https. */
function enlace(valor, respaldo = 'catalogo') {
  const s = String(valor ?? '').trim();
  if (['catalogo', 'ofertas', 'nuevos', 'destacados', 'masVendidos', 'contacto', 'whatsapp'].includes(s)) return s;
  if (/^categoria:.{1,120}$/.test(s)) return s;
  return urlSegura(s) || respaldo;
}

function normalizarSecciones(lista, base) {
  const entrada = Array.isArray(lista) ? lista : [];
  const vistas = new Set();
  const medio = [];
  const porId = new Map();
  for (const item of entrada) {
    const id = item && item.id;
    if (!IDS_SECCIONES.includes(id) || vistas.has(id)) continue;
    vistas.add(id);
    const info = SECCIONES.find((s) => s.id === id);
    const limpia = { id, activa: info.siempre ? true : bool(item.activa, true), titulo: texto(item.titulo, 60) };
    porId.set(id, limpia);
    if (!info.fija) medio.push(limpia);
  }
  // Lo que falte (una sección nueva de otra versión) entra en su lugar del estilo.
  for (const b of base) {
    if (vistas.has(b.id)) continue;
    const info = SECCIONES.find((s) => s.id === b.id);
    const limpia = { ...b };
    porId.set(b.id, limpia);
    if (info.fija) continue;
    const i = base.findIndex((x) => x.id === b.id);
    const anterior = base.slice(0, i).reverse().find((x) => medio.some((m) => m.id === x.id));
    const pos = anterior ? medio.findIndex((m) => m.id === anterior.id) + 1 : 0;
    medio.splice(pos, 0, limpia);
  }
  return [porId.get('encabezado'), ...medio, porId.get('pie')];
}

/**
 * Deja el diseño completo y válido, venga lo que venga. Lo que no se entiende
 * se cambia por el valor del estilo elegido; nunca falla.
 */
function normalizarDiseno(entrada) {
  const d = entrada && typeof entrada === 'object' ? entrada : {};
  const estilo = Object.prototype.hasOwnProperty.call(ESTILOS, d.estilo) ? d.estilo : ESTILO_BASE;
  const base = ESTILOS[estilo];

  const coloresEntrada = d.colores && typeof d.colores === 'object' ? d.colores : {};
  const colores = {};
  for (const id of IDS_COLORES) {
    colores[id] = coloresEntrada[id] === undefined ? base.colores[id] : color(coloresEntrada[id], base.colores[id]);
  }

  const a = d.apariencia && typeof d.apariencia === 'object' ? d.apariencia : {};
  const idsLetra = TIPOGRAFIAS.map((t) => t.id);
  const apariencia = {
    tipografia: opcion(a.tipografia, idsLetra, base.apariencia.tipografia),
    tipografiaTitulos: opcion(a.tipografiaTitulos, idsLetra, base.apariencia.tipografiaTitulos),
    tamanoTexto: opcion(a.tamanoTexto, OPCIONES.tamanoTexto, base.apariencia.tamanoTexto),
    estiloBotones: opcion(a.estiloBotones, OPCIONES.estiloBotones, base.apariencia.estiloBotones),
    esquinas: opcion(a.esquinas, OPCIONES.esquinas, base.apariencia.esquinas),
    sombras: opcion(a.sombras, OPCIONES.sombras, base.apariencia.sombras),
    espaciado: opcion(a.espaciado, OPCIONES.espaciado, base.apariencia.espaciado),
    estiloTarjetas: opcion(a.estiloTarjetas, OPCIONES.estiloTarjetas, base.apariencia.estiloTarjetas),
    temaOscuro: bool(a.temaOscuro, true),
  };

  const e = d.encabezado && typeof d.encabezado === 'object' ? d.encabezado : {};
  const encabezado = {
    mostrarLogo: bool(e.mostrarLogo, true),
    mostrarNombre: bool(e.mostrarNombre, true),
    tamanoLogo: opcion(e.tamanoLogo, OPCIONES.tamanoLogo, 'mediano'),
    mostrarMenu: bool(e.mostrarMenu, true),
    mostrarTelefono: bool(e.mostrarTelefono, true),
    mostrarWhatsapp: bool(e.mostrarWhatsapp, true),
    mostrarBuscador: bool(e.mostrarBuscador, true),
    mostrarCarrito: bool(e.mostrarCarrito, true),
  };

  const h = d.hero && typeof d.hero === 'object' ? d.hero : {};
  const hero = {
    titulo: texto(h.titulo, 90),
    subtitulo: texto(h.subtitulo, 200),
    textoBoton: texto(h.textoBoton, 30, 'Ver productos'),
    enlaceBoton: enlace(h.enlaceBoton),
    textoBoton2: texto(h.textoBoton2, 30),
    enlaceBoton2: enlace(h.enlaceBoton2, 'ofertas'),
    altura: opcion(h.altura, OPCIONES.alturaHero, base.hero.altura),
    alineacion: opcion(h.alineacion, OPCIONES.alineacionHero, base.hero.alineacion),
  };

  const redesEntrada = d.redes && typeof d.redes === 'object' ? d.redes : {};
  const redes = {};
  for (const red of REDES) redes[red] = urlSegura(redesEntrada[red]);

  const anuncios = (Array.isArray(d.anuncios) ? d.anuncios : []).slice(0, MAX_ANUNCIOS).map((x, i) => ({
    n: i + 1,
    titulo: texto(x && x.titulo, 60),
    enlace: x && x.enlace ? enlace(x.enlace, '') : '',
  }));

  const v = d.vitrinas && typeof d.vitrinas === 'object' ? d.vitrinas : {};
  const vitrinas = {
    ofertas: normalizarVitrina(v.ofertas, VITRINAS.ofertas),
    nuevos: normalizarVitrina(v.nuevos, VITRINAS.nuevos),
  };

  return {
    version: VERSION_DISENO,
    estilo,
    colores,
    apariencia,
    encabezado,
    hero,
    redes,
    anuncios,
    vitrinas,
    secciones: normalizarSecciones(d.secciones, base.secciones),
  };
}

/** Elegir un estilo: colores, letra y orden del estilo; los textos del negocio se quedan. */
function aplicarEstilo(id, actual) {
  const estilo = Object.prototype.hasOwnProperty.call(ESTILOS, id) ? id : ESTILO_BASE;
  const base = ESTILOS[estilo];
  const previo = normalizarDiseno(actual);
  return normalizarDiseno({
    ...previo,
    estilo,
    colores: { ...base.colores },
    apariencia: { ...base.apariencia, temaOscuro: previo.apariencia.temaOscuro },
    hero: { ...previo.hero, ...base.hero },
    secciones: base.secciones.map((s) => {
      const antes = previo.secciones.find((x) => x.id === s.id);
      return { ...s, titulo: antes ? antes.titulo : '' };
    }),
  });
}

/** Con el color del negocio en lo que quedó "automático". Es lo que recibe la página. */
function resolverDiseno(diseno, { colorPrimario } = {}) {
  const d = normalizarDiseno(diseno);
  const marca = color(colorPrimario, null) || '#10b981';
  const principal = d.colores.principal || marca;
  return {
    ...d,
    colores: {
      ...d.colores,
      principal,
      botones: d.colores.botones || principal,
      encabezado: d.colores.encabezado || principal,
    },
  };
}

module.exports = {
  VERSION_DISENO,
  SECCIONES,
  TIPOGRAFIAS,
  OPCIONES,
  VITRINAS,
  LIMITES_VITRINA,
  OPCIONES_VITRINA,
  ESTILOS,
  ESTILO_BASE,
  MAX_ANUNCIOS,
  REDES,
  normalizarDiseno,
  aplicarEstilo,
  resolverDiseno,
};
