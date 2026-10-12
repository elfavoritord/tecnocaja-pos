'use strict';

// Íconos de la tienda (pestaña del navegador y "Agregar a pantalla de inicio")
// hechos con el logo que publica el POS. Sin logo: un carrito blanco sobre el
// color de la tienda (se dibuja con trazos: el contenedor no tiene fuentes).

const COLOR_BASE = '#10b981';
const TAMANOS = [32, 64, 180, 192, 512];
const MAX_CACHE = 300;

function colorValido(color) {
  return /^#[0-9a-f]{6}$/i.test(String(color || '')) ? String(color).toLowerCase() : COLOR_BASE;
}

function svgCarrito(color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <rect width="512" height="512" fill="${color}"/>
    <g fill="none" stroke="#fff" stroke-width="30" stroke-linecap="round" stroke-linejoin="round">
      <path d="M92 128h54l44 196h190l38-144H170"/>
    </g>
    <circle cx="214" cy="384" r="28" fill="#fff"/>
    <circle cx="352" cy="384" r="28" fill="#fff"/>
  </svg>`;
}

function createIconos({ tiendas, cargarSharp = () => require('sharp') }) {
  const cache = new Map();
  let sharp;
  function libreria() {
    if (sharp === undefined) {
      try { sharp = cargarSharp(); } catch (_e) { sharp = null; }
    }
    return sharp;
  }

  /**
   * PNG cuadrado de `tam` px. maskable = con margen de seguridad del 20 %
   * (Android recorta el ícono en círculo o gota).
   * @returns {Promise<null | { png: Buffer, exacto: boolean }>}  exacto = hecho
   *   con el logo de la versión publicada (si el POS aún lo está subiendo, no
   *   se guarda y se vuelve a hacer en la próxima visita).
   */
  async function icono(slug, tam, { maskable = false } = {}) {
    if (!TAMANOS.includes(tam)) return null;
    const lib = libreria();
    if (!lib) return null;
    const tienda = await tiendas.cargar(slug).catch(() => null);
    const perfil = tienda?.perfil;
    if (!perfil) return null;
    const color = colorValido(perfil.colorPrimario);
    const clave = `${slug}|${tam}|${maskable ? 'm' : ''}|${perfil.logoVersion || ''}|${color}`;
    if (cache.has(clave)) return { png: cache.get(clave), exacto: true };

    const logo = perfil.logo
      ? await tiendas.imagen(slug, '_logo', { version: String(perfil.logoVersion || '') }).catch(() => null)
      : null;
    const exacto = !perfil.logo || (Boolean(logo) && logo.version === String(perfil.logoVersion || ''));
    let png;
    if (logo?.data?.length) {
      // El logo completo, sin recortar, sobre blanco y con un margen.
      const margen = Math.round(tam * (maskable ? 0.2 : 0.06));
      const interior = Math.max(1, tam - margen * 2);
      const logoAjustado = await lib(logo.data)
        .resize(interior, interior, { fit: 'contain', background: '#ffffff' })
        .flatten({ background: '#ffffff' })
        .png()
        .toBuffer();
      png = await lib({ create: { width: tam, height: tam, channels: 3, background: '#ffffff' } })
        .composite([{ input: logoAjustado, gravity: 'center' }])
        .png()
        .toBuffer();
    } else {
      png = await lib(Buffer.from(svgCarrito(color))).resize(tam, tam).png().toBuffer();
    }
    if (exacto) {
      if (cache.size > MAX_CACHE) cache.clear();
      cache.set(clave, png);
    }
    return { png, exacto };
  }

  /** Manifiesto para instalar la tienda como app (Android / Chrome / Edge). */
  async function manifiesto(slug) {
    const tienda = await tiendas.cargar(slug).catch(() => null);
    const perfil = tienda?.perfil;
    if (!perfil) return null;
    const nombre = String(perfil.nombre || 'Tienda').slice(0, 60);
    const v = `${perfil.logoVersion || 'sin'}${colorValido(perfil.colorPrimario).slice(1)}r2`;
    const base = `/t/${slug}`;
    return {
      id: base,
      name: nombre,
      short_name: nombre.length > 14 ? nombre.slice(0, 14).trim() : nombre,
      description: perfil.descripcion || `Haz tu pedido en ${nombre}.`,
      lang: 'es-DO',
      start_url: `${base}?app=1`,
      scope: base,
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#f9fafb',
      theme_color: colorValido(perfil.colorPrimario),
      icons: [
        { src: `${base}/iconos/192.png?v=${v}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `${base}/iconos/512.png?v=${v}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: `${base}/iconos/512-m.png?v=${v}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    };
  }

  /** Versión de los íconos (cambia si cambia el logo o el color). */
  async function version(slug) {
    const tienda = await tiendas.cargar(slug).catch(() => null);
    const perfil = tienda?.perfil;
    // r2: renueva los íconos que los navegadores guardaron con el logo viejo.
    return perfil ? `${perfil.logoVersion || 'sin'}${colorValido(perfil.colorPrimario).slice(1)}r2` : 'sin';
  }

  return { icono, manifiesto, version, TAMANOS };
}

module.exports = { createIconos, colorValido };
