/* ═══════════════════════════════════════════════════════════════════════════
   TECNO CAJA — Información adicional del producto en la factura

   Cada producto puede llevar una descripción adicional, especificaciones
   técnicas, el país de procedencia y observaciones (pestaña "Detalles" de la
   ficha). Si el negocio lo activa (Configuración → Facturación →
   "Descripciones adicionales en facturas") y el producto tiene marcado
   "Mostrar en la factura", esa información sale debajo del nombre en el
   ticket de 58/80 mm, la factura A4 y el PDF:

     Disco 115mm ultra fino porcelanato
     MRT115
     Corte de porcelanato, Dekton, Neolith e Infinity.
     Corte de materiales de ingeniería.
     PROCEDENCIA: CHINA

   Decisiones de Emilio (2026-11-16): solo se cambia desde Productos (no en la
   venta) y el XML del e-CF no cambia (la información va solo en la factura
   impresa). Cada línea de venta guarda una copia (sale_items.info_adicional):
   una factura vieja se reimprime con lo que tenía aunque el producto cambie.

   Lo usan la ficha del producto (js/productos.js), la impresión
   (js/ventas.js, js/factura-plantillas.js) y el servidor (server.js), que es
   quien arma la copia de cada venta.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProductoInfoAdicional = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CAMPOS = ['descripcion', 'especificaciones', 'procedencia', 'observaciones'];
  // Largos máximos: caben descripciones técnicas completas sin llenar la factura.
  const LIMITES = { descripcion: 1000, especificaciones: 2000, procedencia: 60, observaciones: 1000 };
  const ETIQUETAS = {
    descripcion: 'Descripción adicional',
    especificaciones: 'Especificaciones técnicas',
    procedencia: 'País de procedencia',
    observaciones: 'Observaciones adicionales',
  };

  // Configuración del negocio. Apagada (por defecto) todo sale como siempre.
  const CONFIG_BASE = {
    activo: false,
    descripcion: true,
    especificaciones: true,
    procedencia: true,
    observaciones: false,
    // Los productos nuevos traen marcado "Mostrar en la factura".
    nuevosMuestran: true,
  };

  const PAISES = [
    'República Dominicana', 'Estados Unidos', 'China', 'México', 'España', 'Alemania', 'Italia', 'Japón',
    'Corea del Sur', 'Taiwán', 'India', 'Brasil', 'Colombia', 'Venezuela', 'Puerto Rico', 'Haití', 'Panamá',
    'Costa Rica', 'Guatemala', 'Honduras', 'El Salvador', 'Nicaragua', 'Cuba', 'Argentina', 'Chile', 'Perú',
    'Ecuador', 'Uruguay', 'Paraguay', 'Bolivia', 'Canadá', 'Reino Unido', 'Francia', 'Portugal', 'Países Bajos',
    'Bélgica', 'Suiza', 'Austria', 'Suecia', 'Dinamarca', 'Noruega', 'Finlandia', 'Polonia', 'República Checa',
    'Turquía', 'Rusia', 'Israel', 'Emiratos Árabes Unidos', 'Arabia Saudita', 'Tailandia', 'Vietnam', 'Malasia',
    'Indonesia', 'Filipinas', 'Singapur', 'Australia', 'Nueva Zelanda', 'Sudáfrica', 'Egipto', 'Marruecos',
  ];

  function quitarInvisibles(texto) {
    let salida = '';
    for (const caracter of texto) {
      const c = caracter.codePointAt(0);
      const invisible = (c < 32 && c !== 10) || c === 127 || (c >= 0x200B && c <= 0x200F)
        || c === 0x2028 || c === 0x2029 || c === 0xFEFF;
      salida += invisible ? ' ' : caracter;
    }
    return salida;
  }

  // Texto limpio: sin caracteres de control (rompen la impresión térmica y el
  // PDF), con saltos de línea normales, sin espacios sobrantes y con su largo.
  function limpiarTexto(valor, max, { multilinea = true } = {}) {
    // Fuera los caracteres de control (menos el salto de línea) y los
    // invisibles de formato que algunos programas pegan.
    let texto = quitarInvisibles(String(valor ?? '').replace(/\r\n?/g, '\n'));
    if (!multilinea) texto = texto.replace(/\n+/g, ' ');
    texto = texto
      .split('\n')
      .map((linea) => linea.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return texto.length > max ? texto.slice(0, max).trim() : texto;
  }

  function leerObjeto(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
      const valor = JSON.parse(String(raw));
      return valor && typeof valor === 'object' ? valor : {};
    } catch (_) {
      return {};
    }
  }

  // La información de un producto, tal como se guarda (products.info_adicional).
  function normalizar(raw) {
    const datos = leerObjeto(raw);
    return {
      descripcion: limpiarTexto(datos.descripcion, LIMITES.descripcion),
      especificaciones: limpiarTexto(datos.especificaciones, LIMITES.especificaciones),
      procedencia: limpiarTexto(datos.procedencia, LIMITES.procedencia, { multilinea: false }),
      observaciones: limpiarTexto(datos.observaciones, LIMITES.observaciones),
      mostrarEnFactura: datos.mostrarEnFactura === true || datos.mostrarEnFactura === 1 || datos.mostrarEnFactura === '1' || datos.mostrarEnFactura === 'true',
    };
  }

  function tieneTexto(info) {
    const datos = normalizar(info);
    return CAMPOS.some((campo) => datos[campo]);
  }

  // Lo que se guarda en la base: JSON, o null si no hay nada escrito.
  function serializar(raw) {
    const datos = normalizar(raw);
    return CAMPOS.some((campo) => datos[campo]) ? JSON.stringify(datos) : null;
  }

  // Para la ficha y el catálogo: el objeto, o null si el producto no tiene nada.
  function deFila(raw) {
    return tieneTexto(raw) ? normalizar(raw) : null;
  }

  function configFactura(raw) {
    const datos = leerObjeto(raw);
    const bool = (valor, base) => (valor === undefined || valor === null ? base : (valor === true || valor === 1 || valor === '1' || valor === 'true'));
    return {
      activo: bool(datos.activo, CONFIG_BASE.activo),
      descripcion: bool(datos.descripcion, CONFIG_BASE.descripcion),
      especificaciones: bool(datos.especificaciones, CONFIG_BASE.especificaciones),
      procedencia: bool(datos.procedencia, CONFIG_BASE.procedencia),
      observaciones: bool(datos.observaciones, CONFIG_BASE.observaciones),
      nuevosMuestran: bool(datos.nuevosMuestran, CONFIG_BASE.nuevosMuestran),
    };
  }

  // La copia que guarda cada línea de venta: solo lo que sale en la factura
  // según el negocio y el producto. null = la línea se imprime como siempre.
  function paraVenta(infoProducto, config) {
    const cfg = configFactura(config);
    if (!cfg.activo) return null;
    const info = normalizar(infoProducto);
    if (!info.mostrarEnFactura) return null;
    const copia = {};
    CAMPOS.forEach((campo) => {
      if (cfg[campo] && info[campo]) copia[campo] = info[campo];
    });
    return Object.keys(copia).length ? copia : null;
  }

  // La copia guardada en sale_items.info_adicional (o la que traiga la venta).
  function deLinea(raw) {
    const datos = leerObjeto(raw);
    const copia = {};
    CAMPOS.forEach((campo) => {
      const texto = limpiarTexto(datos[campo], LIMITES[campo], { multilinea: campo !== 'procedencia' });
      if (texto) copia[campo] = texto;
    });
    return Object.keys(copia).length ? copia : null;
  }

  // Las líneas que van debajo del nombre, en orden: código, descripción,
  // especificaciones, "PROCEDENCIA: CHINA" y observaciones.
  function lineas(copia, { codigo = '' } = {}) {
    const datos = deLinea(copia);
    if (!datos) return [];
    const salida = [];
    const cod = String(codigo || '').trim();
    if (cod && cod !== 'RAPIDO') salida.push(cod);
    const partir = (texto) => String(texto || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (datos.descripcion) salida.push(...partir(datos.descripcion));
    if (datos.especificaciones) salida.push(...partir(datos.especificaciones));
    if (datos.procedencia) salida.push(`PROCEDENCIA: ${datos.procedencia.toLocaleUpperCase('es-DO')}`);
    if (datos.observaciones) salida.push(...partir(datos.observaciones));
    return salida;
  }

  // Parte una línea en pedazos de `ancho` caracteres sin cortar palabras (una
  // palabra más larga que el ancho sí se corta).
  function partirAncho(texto, ancho) {
    const max = Math.max(8, Number(ancho) || 32);
    const resultado = [];
    let actual = '';
    String(texto || '').split(/\s+/).filter(Boolean).forEach((palabra) => {
      let resto = palabra;
      while (resto.length > max) {
        if (actual) { resultado.push(actual); actual = ''; }
        resultado.push(resto.slice(0, max));
        resto = resto.slice(max);
      }
      if (!resto) return;
      if (!actual) actual = resto;
      else if (actual.length + 1 + resto.length <= max) actual += ` ${resto}`;
      else { resultado.push(actual); actual = resto; }
    });
    if (actual) resultado.push(actual);
    return resultado;
  }

  // Para el ticket térmico: las mismas líneas, partidas al ancho del papel.
  function lineasTicket(copia, ancho, opciones = {}) {
    return lineas(copia, opciones).flatMap((linea) => partirAncho(linea, ancho));
  }

  return {
    CAMPOS,
    LIMITES,
    ETIQUETAS,
    CONFIG_BASE,
    PAISES,
    limpiarTexto,
    normalizar,
    tieneTexto,
    serializar,
    deFila,
    configFactura,
    paraVenta,
    deLinea,
    lineas,
    partirAncho,
    lineasTicket,
  };
}));
