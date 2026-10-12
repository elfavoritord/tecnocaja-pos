'use strict';

// Lectura de lo que publica el POS (perfil, catálogo, existencia, imágenes)
// con caché corta por instancia. El pedido SIEMPRE vuelve a leer la existencia
// dentro de su transacción; la caché solo sirve para mostrar la tienda.

const { rutas, slugValido, claveProducto, CLAVE_IMAGEN_RE, MAX_FOTOS_PRODUCTO } = require('../vendor/tienda-online/contrato');
const { precioParaCantidad, promocionPorCantidad, round2 } = require('../vendor/tienda-online/calculo-pedido');

function createTiendas({ db, ttlMs = 15000, slugTtlMs = 60000, imgTtlMs = 10 * 60 * 1000, now = Date.now }) {
  const slugs = new Map();
  const tiendas = new Map();
  const imagenes = new Map();

  async function licenciaDe(slug) {
    if (!slugValido(slug)) return null;
    const hit = slugs.get(slug);
    if (hit && now() - hit.t < slugTtlMs) return hit.lic;
    const snap = await db.doc(rutas.slug(slug)).get();
    const lic = snap.exists ? String(snap.data().licenseId || '') || null : null;
    slugs.set(slug, { lic, t: now() });
    return lic;
  }

  /**
   * @returns {null | { cerrada: true, perfil } | { licenseId, perfil, productos: Map, lista, stock }}
   */
  async function cargar(slug, { fresca = false } = {}) {
    const hit = tiendas.get(slug);
    if (!fresca && hit && now() - hit.t < ttlMs) return hit.v;
    const licenseId = await licenciaDe(slug);
    if (!licenseId) return null;
    const [perfilSnap, indiceSnap, stockSnap] = await Promise.all([
      db.doc(rutas.perfil(licenseId)).get(),
      db.doc(rutas.catalogo(licenseId)).get(),
      db.doc(rutas.stock(licenseId)).get(),
    ]);
    const perfil = perfilSnap.exists ? perfilSnap.data() : null;
    if (!perfil || perfil.licenseId !== licenseId || perfil.slug !== slug || !perfil.activa) {
      const v = perfil && perfil.licenseId === licenseId ? { cerrada: true, perfil } : null;
      tiendas.set(slug, { v, t: now() });
      return v;
    }
    const indice = indiceSnap.exists ? indiceSnap.data() : { paginas: 0 };
    const paginas = await Promise.all(
      Array.from({ length: Number(indice.paginas || 0) }, (_, n) => db.doc(rutas.catalogoPagina(licenseId, n)).get()),
    );
    const lista = [];
    for (const snap of paginas) {
      if (snap.exists) lista.push(...(snap.data().productos || []));
    }
    const productos = new Map(lista.map((p) => [Number(p.id), p]));
    const v = {
      licenseId,
      perfil,
      productos,
      lista,
      stock: stockSnap.exists ? stockSnap.data() : null,
      version: indice.version || '',
    };
    tiendas.set(slug, { v, t: now() });
    return v;
  }

  function invalidar(slug) {
    tiendas.delete(slug);
  }

  /** Existencia disponible para la tienda (null = sin límite). */
  function disponible(producto, stock) {
    if (!producto.controlaStock) return null;
    const item = stock?.items?.[claveProducto(producto.id)] || {};
    return Math.max(0, round2(Number(item.s || 0) - Math.max(0, Number(item.r || 0))));
  }

  // r=2: renueva de una vez lo que los navegadores guardaron con la versión
  // equivocada (antes de corregir la carrera logo nuevo / imagen vieja).
  function urlImagen(slug, clave, version) {
    return `/api/tiendas/${slug}/img/${clave}${version ? `?v=${version}&r=2` : ''}`;
  }

  /** Lo que ve el cliente: sin costos, sin existencias exactas de más. */
  function vistaPublica(slug, tienda, nowDate = new Date()) {
    const { perfil } = tienda;
    const productos = [];
    for (const p of tienda.lista) {
      const disp = disponible(p, tienda.stock);
      const agotado = disp !== null && disp <= 0;
      if (agotado && perfil.mostrarAgotados === false) continue;
      const { precio, precioOriginal, promocion } = precioParaCantidad(p, 1, nowDate);
      // Principal (la del POS) + fotos adicionales para el carrusel del detalle.
      const principal = p.imagen ? urlImagen(slug, p.imagen, p.imagenVersion) : (p.imagenUrl || null);
      const extras = (Array.isArray(p.fotosExtra) ? p.fotosExtra : [])
        .filter((f) => f && CLAVE_IMAGEN_RE.test(String(f.clave)))
        .map((f) => urlImagen(slug, f.clave, f.version));
      const fotos = [principal, ...extras].filter(Boolean).slice(0, MAX_FOTOS_PRODUCTO);
      productos.push({
        id: p.id,
        nombre: p.nombre,
        descripcion: p.descripcion || '',
        categoria: p.categoria,
        unidad: p.unidad,
        modoVenta: p.modoVenta,
        precio,
        precioAntes: precioOriginal && precioOriginal > precio ? precioOriginal : null,
        promocion: promocion ? (promocion.texto || promocion.nombre) : null,
        porCantidad: promocionPorCantidad(p, nowDate),
        descuentoPct: p.descuentoPct || 0,
        conItbis: Boolean(p.itbis),
        disponible: disp === null ? null : Math.min(disp, 999),
        agotado,
        destacado: Boolean(p.destacado),
        orden: Number(p.orden || 0),
        imagen: fotos[0] || null,
        imagenes: fotos,
      });
    }
    return {
      tienda: {
        slug,
        nombre: perfil.nombre,
        descripcion: perfil.descripcion || '',
        telefono: perfil.telefono || '',
        whatsapp: perfil.whatsapp || '',
        direccion: perfil.direccion || '',
        email: perfil.email || '',
        colorPrimario: perfil.colorPrimario || '#10b981',
        logo: perfil.logo ? urlImagen(slug, perfil.logo, perfil.logoVersion) : null,
        banner: perfil.banner ? urlImagen(slug, perfil.banner, perfil.bannerVersion) : null,
        moneda: perfil.moneda || 'RD$',
        horario: perfil.horario || null,
        pedidoMinimo: Number(perfil.pedidoMinimo || 0),
        retiro: perfil.retiro || { habilitado: true },
        delivery: perfil.delivery || { habilitado: false, zonas: [] },
        pagos: perfil.pagos || [],
        comprobanteFiscal: perfil.comprobanteFiscal !== false,
        categorias: perfil.categorias || [],
      },
      productos,
    };
  }

  /**
   * Imagen publicada. Si se pide una versión (?v=) distinta de la guardada en
   * caché, se vuelve a leer: el logo o la foto acaban de cambiar.
   * @returns {null | { mime, data: Buffer, version: string }}
   */
  async function imagen(slug, clave, { version = '' } = {}) {
    if (!CLAVE_IMAGEN_RE.test(String(clave))) return null;
    const licenseId = await licenciaDe(slug);
    if (!licenseId) return null;
    const key = `${licenseId}/${clave}`;
    const hit = imagenes.get(key);
    if (hit && now() - hit.t < imgTtlMs && (!version || hit.v?.version === version)) return hit.v;
    const snap = await db.doc(rutas.imagen(licenseId, clave)).get();
    const v = snap.exists
      ? {
        mime: snap.data().mime || 'image/webp',
        data: Buffer.from(String(snap.data().data || ''), 'base64'),
        version: String(snap.data().version || ''),
      }
      : null;
    if (imagenes.size > 500) imagenes.clear();
    imagenes.set(key, { v, t: now() });
    return v;
  }

  return { licenciaDe, cargar, invalidar, disponible, vistaPublica, imagen };
}

module.exports = { createTiendas };
