'use strict';

/**
 * server/tienda-online/catalog.js
 *
 * Arma lo que se publica de la tienda a partir de la base del POS: perfil
 * público, productos marcados "Publicar en tienda online", existencia de la
 * sucursal de la tienda y las promociones vigentes de esa sucursal.
 *
 * Nada de esto es un catálogo aparte: se lee products / inventory_by_branch /
 * promotions en cada publicación.
 */

const crypto = require('crypto');
const { fetchDateActiveRows, isActiveOnDate } = require('../services/promotion-engine');
const { claveProducto, claveFotoProducto, METODOS_PAGO } = require('./contrato');
const { leerFotosExtra } = require('./fotos');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function fechaTexto(value) {
  if (!value) return null;
  if (value instanceof Date) return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
  return String(value).slice(0, 10);
}

function horaTexto(value) {
  if (!value) return null;
  if (value instanceof Date) return `${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())}`;
  return String(value).slice(0, 8);
}

function fechaHoraIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Fila promoción×producto en el formato que entiende promotion-engine. */
function serializarFilaPromo(row) {
  return {
    promotion_id: Number(row.promotion_id),
    producto_id: Number(row.producto_id),
    nombre: String(row.nombre || ''),
    prioridad: Number(row.prioridad || 0),
    color: row.color || '',
    texto_promocion: row.texto_promocion || '',
    hora_inicio: horaTexto(row.hora_inicio),
    hora_fin: horaTexto(row.hora_fin),
    permanente: Number(row.permanente || 0),
    fecha_inicio: fechaTexto(row.fecha_inicio),
    fecha_fin: fechaTexto(row.fecha_fin),
    created_at: fechaHoraIso(row.created_at),
    precio_original: Number(row.precio_original || 0),
    precio_promocion: Number(row.precio_promocion || 0),
    cantidad_minima: row.cantidad_minima === null || row.cantidad_minima === undefined ? null : Number(row.cantidad_minima),
  };
}

function agruparPorProducto(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const id = Number(row.producto_id);
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(serializarFilaPromo(row));
  }
  return map;
}

function esDataUrlImagen(value) {
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(String(value || ''));
}

function version(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 10);
}

function createCatalogBuilder({ query, getLicenseId = () => '', readBanner = null }) {
  async function readConfig() {
    const rows = await query('SELECT * FROM config WHERE id = 1 LIMIT 1');
    return rows[0] || {};
  }

  async function resolveStoreBranchId(preferred, config) {
    const branches = await query(`SELECT id, nombre, estado FROM branches ORDER BY id`);
    const activas = branches.filter((b) => String(b.estado || '') !== 'Eliminada');
    const wanted = Number(preferred || 0) || Number(config.active_branch_id || 0) || null;
    const branch = activas.find((b) => Number(b.id) === wanted) || activas[0] || null;
    return {
      branchId: branch ? Number(branch.id) : null,
      branchName: branch ? String(branch.nombre || '') : '',
      primaryBranchId: branches[0] ? Number(branches[0].id) : null,
    };
  }

  async function promotionsFor(branchId) {
    const cfg = await query('SELECT promotions_enabled FROM config WHERE id = 1 LIMIT 1').catch(() => []);
    if (cfg.length && Number(cfg[0].promotions_enabled) === 0) {
      return { ofertas: new Map(), porCantidad: new Map() };
    }
    const [ofertas, porCantidad] = await Promise.all([
      fetchDateActiveRows(query, { sucursalId: branchId, tipo: 'oferta_precio' }).catch(() => []),
      fetchDateActiveRows(query, { sucursalId: branchId, tipo: 'descuento_por_cantidad' }).catch(() => []),
    ]);
    return { ofertas: agruparPorProducto(ofertas), porCantidad: agruparPorProducto(porCantidad) };
  }

  /** Productos publicados con existencia de la sucursal de la tienda. */
  async function readProducts({ branchId, primaryBranchId }) {
    return query(
      `SELECT p.id, p.codigo, p.nombre, p.categoria, p.unidad, p.sale_mode, p.precio_venta, p.estado,
              p.aplica_itbis, p.itbis_modo, p.itbis_monto, p.tracks_stock, p.discount_percent, p.branch_id,
              p.image_url, p.image_local, p.online_images, p.online_description, p.online_featured, p.online_order,
              p.online_stock_mode, p.stock AS legacy_stock,
              ib.stock AS branch_stock,
              (SELECT COUNT(*) FROM inventory_by_branch x WHERE x.product_id = p.id) AS inv_rows
         FROM products p
         LEFT JOIN inventory_by_branch ib ON ib.product_id = p.id AND ib.branch_id = ?
        WHERE p.online_enabled = 1
        ORDER BY p.online_order, p.nombre`,
      [branchId || 0],
    ).then((rows) => rows.map((row) => ({ ...row, _primaryBranchId: primaryBranchId })));
  }

  function stockDeFila(row, branchId) {
    if (row.branch_stock !== null && row.branch_stock !== undefined) return Number(row.branch_stock || 0);
    // Mismo criterio que ensureBranchInventoryRecord: sin filas por sucursal,
    // la existencia histórica del producto es de la sucursal principal.
    if (Number(row.inv_rows || 0) === 0 && branchId && Number(branchId) === Number(row._primaryBranchId)) {
      return Number(row.legacy_stock || 0);
    }
    return 0;
  }

  /**
   * @returns {{ perfil, productos, stock, imagenes, branchId, config }}
   *   imagenes: [{ clave, fuente: { tipo: 'local'|'data', valor } }]
   */
  async function build({ store, now = new Date() }) {
    const config = await readConfig();
    const settings = store.settings;
    const { branchId, branchName, primaryBranchId } = await resolveStoreBranchId(store.branchId, config);
    const taxRate = Number(config.tax_rate ?? 18);
    const [rows, promos] = await Promise.all([
      readProducts({ branchId, primaryBranchId }),
      promotionsFor(branchId),
    ]);

    const productos = [];
    const stock = {};
    const imagenes = [];
    for (const row of rows) {
      if (String(row.estado || 'Activo') !== 'Activo') continue;
      if (row.branch_id !== null && row.branch_id !== undefined && Number(row.branch_id) !== Number(branchId)) continue;
      const id = Number(row.id);
      const controlaStock = Number(row.tracks_stock ?? 1) !== 0 && String(row.online_stock_mode || 'inventario') !== 'ilimitado';
      const aplicaItbis = Number(row.aplica_itbis || 0) === 1;
      let itbis = null;
      if (aplicaItbis && String(row.itbis_modo) === 'monto') itbis = { modo: 'monto', monto: Number(row.itbis_monto || 0) };
      else if (aplicaItbis && taxRate > 0) itbis = { modo: 'porcentaje', tasa: taxRate };

      let imagen = null;
      let imagenVersion = null;
      let imagenUrl = null;
      if (row.image_local) {
        imagen = claveProducto(id);
        imagenVersion = version(row.image_local);
        imagenes.push({ clave: imagen, version: imagenVersion, fuente: { tipo: 'local', valor: String(row.image_local) } });
      } else if (esDataUrlImagen(row.image_url)) {
        imagen = claveProducto(id);
        imagenVersion = version(row.image_url);
        imagenes.push({ clave: imagen, version: imagenVersion, fuente: { tipo: 'data', valor: String(row.image_url) } });
      } else if (/^https:\/\//i.test(String(row.image_url || '')) && String(row.image_url).length <= 600) {
        imagenUrl = String(row.image_url);
      }
      // Fotos adicionales (carrusel del detalle): p{id}_1 … p{id}_5.
      const fotosExtra = leerFotosExtra(row.online_images).map((ruta, i) => {
        const foto = { clave: claveFotoProducto(id, i + 1), version: version(ruta) };
        imagenes.push({ ...foto, fuente: { tipo: 'local', valor: ruta } });
        return foto;
      });

      productos.push({
        id,
        codigo: String(row.codigo || ''),
        nombre: String(row.nombre || ''),
        descripcion: String(row.online_description || ''),
        categoria: String(row.categoria || 'General'),
        unidad: String(row.unidad || 'Unidad'),
        modoVenta: ['peso', 'medida'].includes(String(row.sale_mode)) ? String(row.sale_mode) : 'unidad',
        precio: Number(row.precio_venta || 0),
        descuentoPct: Math.min(100, Math.max(0, Number(row.discount_percent || 0))),
        itbis,
        controlaStock,
        destacado: Number(row.online_featured || 0) === 1,
        orden: Number(row.online_order || 0),
        imagen,
        imagenVersion,
        imagenUrl,
        fotosExtra,
        ofertas: (promos.ofertas.get(id) || []).filter((r) => isActiveOnDate(r, now) || Number(r.permanente) === 1),
        porCantidad: promos.porCantidad.get(id) || [],
      });
      if (controlaStock) stock[claveProducto(id)] = Math.max(0, Number(stockDeFila(row, branchId).toFixed(2)));
    }

    const orden = settings.categoriasOrden || [];
    const categorias = [...new Set(productos.map((p) => p.categoria))].sort((a, b) => {
      const ia = orden.indexOf(a);
      const ib = orden.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 9999 : ia) - (ib === -1 ? 9999 : ib);
      return a.localeCompare(b, 'es');
    });

    const pagos = Object.entries(settings.pagos || {})
      .filter(([, cfg]) => cfg.habilitado)
      .map(([codigo, cfg]) => ({
        codigo,
        etiqueta: codigo === 'otro' && cfg.etiqueta ? cfg.etiqueta : METODOS_PAGO[codigo],
        instrucciones: cfg.instrucciones || '',
      }));

    const logoVersion = config.app_logo && esDataUrlImagen(config.app_logo) ? version(config.app_logo) : null;
    if (logoVersion) {
      imagenes.push({ clave: '_logo', version: logoVersion, tamano: 'logo', fuente: { tipo: 'data', valor: String(config.app_logo) } });
    }
    const bannerData = store.hasBanner && readBanner ? await readBanner() : null;
    const bannerVersion = bannerData && esDataUrlImagen(bannerData) ? version(bannerData) : null;
    if (bannerVersion) {
      imagenes.push({ clave: '_banner', version: bannerVersion, tamano: 'banner', fuente: { tipo: 'data', valor: bannerData } });
    }

    const perfil = {
      licenseId: getLicenseId(),
      slug: store.slug,
      activa: Boolean(store.enabled),
      nombre: settings.nombre || String(config.business_name || 'Mi tienda'),
      descripcion: settings.descripcion,
      telefono: settings.telefono || String(config.phone || ''),
      whatsapp: settings.whatsapp,
      direccion: settings.direccion || String(config.address || ''),
      email: settings.email,
      colorPrimario: settings.colorPrimario,
      logo: logoVersion ? '_logo' : null,
      logoVersion,
      banner: bannerVersion ? '_banner' : null,
      bannerVersion,
      moneda: String(config.currency || 'RD$'),
      tasaItbis: taxRate,
      horario: settings.horario,
      pedidoMinimo: settings.pedidoMinimo,
      retiro: settings.retiro,
      delivery: {
        habilitado: settings.delivery.habilitado,
        costoBase: settings.delivery.costoBase,
        aplicaItbis: settings.delivery.aplicaItbis,
        instrucciones: settings.delivery.instrucciones,
        zonas: settings.delivery.zonas.filter((z) => z.activa).map(({ id, nombre, costo }) => ({ id, nombre, costo })),
      },
      pagos,
      comprobanteFiscal: settings.comprobanteFiscal,
      mostrarAgotados: settings.mostrarAgotados,
      categorias,
      sucursalId: branchId,
      sucursalNombre: branchName,
    };

    return { perfil, productos, stock, imagenes, branchId, config };
  }

  /**
   * Existencia publicada + una huella liviana del catálogo (consulta corta para
   * revisarla cada 30 s). La huella cambia si cambia algo que se ve en la
   * tienda: nombre, precio, descuento, ITBIS, fotos, descripción, publicar/
   * ocultar, orden, destacado, el logo o el nombre del negocio. Así la PC
   * principal nota también lo que se edita en otra caja de la red.
   * @returns {{ stock: object, branchId: number|null, huella: string }}
   */
  async function buildStock({ store }) {
    const config = await readConfig();
    const { branchId, primaryBranchId } = await resolveStoreBranchId(store.branchId, config);
    const rows = await query(
      `SELECT p.id, p.estado, p.tracks_stock, p.online_stock_mode, p.branch_id, p.stock AS legacy_stock,
              p.nombre, p.categoria, p.unidad, p.sale_mode, p.precio_venta, p.discount_percent,
              p.aplica_itbis, p.itbis_modo, p.itbis_monto, p.image_local,
              LENGTH(COALESCE(p.image_url, '')) AS image_len, SUBSTR(COALESCE(p.image_url, ''), -32) AS image_tail,
              p.online_description, p.online_featured, p.online_order, p.online_images,
              ib.stock AS branch_stock,
              (SELECT COUNT(*) FROM inventory_by_branch x WHERE x.product_id = p.id) AS inv_rows
         FROM products p
         LEFT JOIN inventory_by_branch ib ON ib.product_id = p.id AND ib.branch_id = ?
        WHERE p.online_enabled = 1
        ORDER BY p.id`,
      [branchId || 0],
    );
    const huella = crypto.createHash('sha1');
    huella.update(JSON.stringify([
      version(config.app_logo), config.business_name || '', config.currency || '', config.tax_rate ?? '', branchId,
    ]));
    for (const row of rows) {
      huella.update(JSON.stringify([
        row.id, row.estado, row.tracks_stock, row.online_stock_mode, row.branch_id,
        row.nombre, row.categoria, row.unidad, row.sale_mode, Number(row.precio_venta || 0), Number(row.discount_percent || 0),
        row.aplica_itbis, row.itbis_modo, Number(row.itbis_monto || 0), row.image_local, Number(row.image_len || 0), row.image_tail,
        row.online_description, row.online_featured, row.online_order, row.online_images,
      ]));
    }
    const stock = {};
    for (const row of rows) {
      if (String(row.estado || 'Activo') !== 'Activo') continue;
      if (row.branch_id !== null && row.branch_id !== undefined && Number(row.branch_id) !== Number(branchId)) continue;
      if (Number(row.tracks_stock ?? 1) === 0 || String(row.online_stock_mode || 'inventario') === 'ilimitado') continue;
      stock[claveProducto(row.id)] = Math.max(0, Number(stockDeFila({ ...row, _primaryBranchId: primaryBranchId }, branchId).toFixed(2)));
    }
    return { stock, branchId, huella: huella.digest('hex') };
  }

  /** Existencia publicable de unos productos (para liberar reservas al facturar). */
  async function stockOf(store, productIds) {
    const { stock } = await buildStock({ store });
    const out = {};
    for (const id of productIds) {
      const clave = claveProducto(id);
      if (stock[clave] !== undefined) out[clave] = stock[clave];
    }
    return out;
  }

  return { build, buildStock, stockOf, resolveStoreBranchId, stockDeFila, readConfig };
}

module.exports = { createCatalogBuilder, serializarFilaPromo, esDataUrlImagen };
