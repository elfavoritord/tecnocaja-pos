'use strict';

/**
 * Tecno Caja — Caché LRU de Productos
 *
 * Mantiene los productos activos en memoria para búsquedas instantáneas.
 * - Lookup por código de barra: < 1ms (vs ~50ms con SQLite)
 * - Búsqueda por texto: < 5ms con índice en memoria
 * - Se invalida automáticamente cuando se modifica un producto
 * - TTL de 60 segundos como respaldo
 */

const { LRUCache } = require('lru-cache');

// ─── Configuración ────────────────────────────────────────────────────────────
const CACHE_MAX      = 8000;   // Máx productos en memoria
const CACHE_TTL_MS   = 60_000; // 60 segundos de TTL
const SEARCH_MAX     = 25;     // Máximo de resultados de búsqueda

// ─── Instancias de caché ──────────────────────────────────────────────────────

// Cache principal: código → producto
const byCode = new LRUCache({
  max: CACHE_MAX,
  ttl: CACHE_TTL_MS,
  allowStale: true,   // Sirve datos viejos mientras refresca (sin lag)
  updateAgeOnGet: true,
});

// Cache secundario: id → producto
const byId = new LRUCache({
  max: CACHE_MAX,
  ttl: CACHE_TTL_MS,
  allowStale: true,
  updateAgeOnGet: true,
});

// Índice para búsqueda de texto (array ordenado por nombre)
let searchIndex = [];
let searchIndexReady = false;

// ─── Estado ───────────────────────────────────────────────────────────────────
let _queryFn = null;   // función db query inyectada
let _loading  = false;
let _loaded   = false;
let _loadedAt = 0;

// ─────────────────────────────────────────────────────────────────────────────
// INICIALIZACIÓN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inyecta la función de consulta a la base de datos
 * Debe llamarse una vez al arrancar el servidor
 *
 * @param {Function} queryFn — función (sql, params) => Promise<rows[]>
 */
function init(queryFn) {
  _queryFn = queryFn;
}

/**
 * Carga todos los productos activos en memoria
 * Se llama automáticamente en el primer acceso
 */
async function loadAll() {
  if (!_queryFn) throw new Error('ProductsCache: init() no fue llamado');
  if (_loading) return;
  _loading = true;

  try {
    const rows = await _queryFn(
      `SELECT id, codigo, nombre, categoria, precio_venta, precio_compra,
              stock, stock_min, estado, image_url, image_local,
              unidad, sale_mode, marca, product_type, size_options, dough_options,
              border_options, extra_options, allow_half_and_half, is_combo,
              preparation_time_minutes
       FROM products
       WHERE LOWER(estado) IN ('activo', 'active', 'enabled') OR estado IS NULL
       ORDER BY nombre ASC`,
      []
    );

    byCode.clear();
    byId.clear();

    for (const row of rows) {
      const product = normalizeProduct(row);
      if (product.codigo) {
        byCode.set(product.codigo.toLowerCase().trim(), product);
      }
      byId.set(String(product.id), product);
    }

    // Construir índice de búsqueda
    searchIndex = rows.map(r => normalizeProduct(r));
    searchIndexReady = true;
    _loaded  = true;
    _loadedAt = Date.now();

    console.log(`[products-cache] ${rows.length} productos cargados en memoria`);
  } catch (err) {
    console.error('[products-cache] Error cargando productos:', err.message);
  } finally {
    _loading = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSULTAS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Busca un producto por código de barra
 * Instantáneo si está en caché, fallback a DB si no
 *
 * @param {string} codigo
 * @returns {Promise<object|null>}
 */
async function getByCode(codigo) {
  if (!codigo) return null;

  await ensureLoaded();

  const key = String(codigo).toLowerCase().trim();
  const cached = byCode.get(key);
  if (cached) return cached;

  // Fallback: buscar en DB directamente (para productos nuevos)
  if (_queryFn) {
    try {
      const rows = await _queryFn(
        'SELECT * FROM products WHERE LOWER(codigo) = ? LIMIT 1',
        [key]
      );
      if (rows && rows.length > 0) {
        const product = normalizeProduct(rows[0]);
        byCode.set(key, product);
        byId.set(String(product.id), product);
        return product;
      }
    } catch {}
  }

  return null;
}

/**
 * Busca un producto por ID
 *
 * @param {string|number} id
 * @returns {Promise<object|null>}
 */
async function getById(id) {
  if (!id) return null;

  await ensureLoaded();

  const key = String(id);
  const cached = byId.get(key);
  if (cached) return cached;

  if (_queryFn) {
    try {
      const rows = await _queryFn('SELECT * FROM products WHERE id = ? LIMIT 1', [id]);
      if (rows && rows.length > 0) {
        const product = normalizeProduct(rows[0]);
        byCode.set((product.codigo || '').toLowerCase().trim(), product);
        byId.set(key, product);
        return product;
      }
    } catch {}
  }

  return null;
}

/**
 * Búsqueda de texto en memoria — devuelve resultados en < 5ms
 * Busca en nombre, código y categoría
 *
 * @param {string}  query    — texto a buscar
 * @param {object}  options
 * @param {number}  options.limit     — máximo de resultados (default 25)
 * @param {string}  options.categoria — filtrar por categoría
 * @returns {Promise<object[]>}
 */
async function search(query, options = {}) {
  await ensureLoaded();

  const limit = options.limit || SEARCH_MAX;
  const q = String(query || '').toLowerCase().trim();

  if (!q && !options.categoria) {
    return searchIndex.slice(0, limit);
  }

  const results = [];

  for (const product of searchIndex) {
    if (results.length >= limit) break;

    // Filtrar por categoría
    if (options.categoria) {
      const cat = String(product.categoria || '').toLowerCase();
      if (!cat.includes(options.categoria.toLowerCase())) continue;
    }

    if (!q) {
      results.push(product);
      continue;
    }

    // Búsqueda por relevancia
    const nombre  = (product.nombre  || '').toLowerCase();
    const codigo  = (product.codigo  || '').toLowerCase();
    const cat     = (product.categoria || '').toLowerCase();
    const marca   = (product.marca   || '').toLowerCase();

    // Coincidencia exacta de código (prioridad máxima)
    if (codigo === q) {
      results.unshift(product);
      continue;
    }

    // Coincidencia parcial
    if (
      nombre.includes(q)  ||
      codigo.includes(q)  ||
      cat.includes(q)     ||
      marca.includes(q)
    ) {
      results.push(product);
    }
  }

  return results;
}

/**
 * Obtiene todos los productos de una categoría
 */
async function getByCategory(categoria) {
  return search('', { categoria, limit: 500 });
}

/**
 * Total de productos en caché
 */
function size() {
  return byCode.size;
}

/**
 * Estado de la caché
 */
function stats() {
  return {
    loaded:    _loaded,
    loadedAt:  _loadedAt,
    size:      byCode.size,
    ageMs:     _loadedAt ? Date.now() - _loadedAt : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// INVALIDACIÓN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Invalida un producto específico (al crear/editar/eliminar)
 * El próximo acceso recargará desde DB
 *
 * @param {object} product — producto con id y codigo
 */
function invalidate(product) {
  if (!product) return;
  if (product.id)     byId.delete(String(product.id));
  if (product.codigo) byCode.delete(String(product.codigo).toLowerCase().trim());

  // Actualizar índice de búsqueda
  if (searchIndex.length > 0) {
    const idx = searchIndex.findIndex(p => p.id === product.id);
    if (idx !== -1) searchIndex.splice(idx, 1);
  }
}

/**
 * Agrega o actualiza un producto en caché (para evitar recarga completa)
 *
 * @param {object} product
 */
function upsert(product) {
  if (!product || !product.id) return;
  const normalized = normalizeProduct(product);

  byId.set(String(normalized.id), normalized);
  if (normalized.codigo) {
    byCode.set(normalized.codigo.toLowerCase().trim(), normalized);
  }

  // Actualizar índice de búsqueda
  const idx = searchIndex.findIndex(p => p.id === normalized.id);
  if (idx !== -1) {
    searchIndex[idx] = normalized;
  } else {
    searchIndex.push(normalized);
    searchIndex.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
  }
}

/**
 * Limpia toda la caché y fuerza recarga en el próximo acceso
 */
function flush() {
  byCode.clear();
  byId.clear();
  searchIndex = [];
  searchIndexReady = false;
  _loaded  = false;
  _loadedAt = 0;
  console.log('[products-cache] Caché vaciada');
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS INTERNOS
// ─────────────────────────────────────────────────────────────────────────────

async function ensureLoaded() {
  if (!_loaded && !_loading) {
    await loadAll();
  }
}

function normalizeProduct(row) {
  return {
    id:           row.id,
    codigo:       row.codigo || '',
    nombre:       row.nombre || '',
    categoria:    row.categoria || '',
    marca:        row.marca || '',
    unidad:       row.unidad || '',
    saleMode:     row.sale_mode || row.saleMode || 'unidad',
    precioVenta:  Number(row.precio_venta  || row.precioVenta  || 0),
    precioCompra: Number(row.precio_compra || row.precioCompra || 0),
    stock:        Number(row.stock || 0),
    stockMin:     Number(row.stock_min || row.stockMin || 0),
    estado:       row.estado || 'activo',
    imageUrl:     row.image_url   || row.imageUrl   || '',
    imageLocal:   row.image_local || row.imageLocal || '',
    tipoProducto: row.product_type || row.tipoProducto || 'general',
    // Opciones para pizzería (JSON strings)
    sizeOptions:  _parseJson(row.size_options),
    doughOptions: _parseJson(row.dough_options),
    borderOptions:_parseJson(row.border_options),
    extraOptions: _parseJson(row.extra_options),
    permiteMitades: Boolean(row.allow_half_and_half),
    esCombo:       Boolean(row.is_combo),
    tiempoPreparacion: Number(row.preparation_time_minutes || 0),
  };
}

function _parseJson(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val); } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  init,
  loadAll,
  getByCode,
  getById,
  search,
  getByCategory,
  invalidate,
  upsert,
  flush,
  stats,
  size,
};
