'use strict';

/**
 * server/tienda-online/fotos.js
 *
 * Fotos adicionales de un producto para la tienda online. Viven en
 * products.online_images (JSON con las rutas locales, en el mismo directorio
 * de imágenes de productos del POS). La foto principal NO se toca: sigue
 * siendo image_local / image_url del producto; estas solo se ven en el
 * carrusel del detalle de la tienda.
 */

const { MAX_FOTOS_PRODUCTO } = require('./contrato');

const MAX_EXTRA = MAX_FOTOS_PRODUCTO - 1;
const RUTA_RE = /^[\w./-]{1,255}$/;

/** Lista guardada en products.online_images (tolera basura o null). */
function leerFotosExtra(valor) {
  try {
    const lista = JSON.parse(String(valor || '[]'));
    return Array.isArray(lista) ? lista.filter((r) => typeof r === 'string' && RUTA_RE.test(r)).slice(0, MAX_EXTRA) : [];
  } catch (_error) {
    return [];
  }
}

function errorConEstado(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * @param {object} deps
 * @param {Function} deps.query
 * @param {Function} deps.saveImage    ({ productId, productName, buffer }) → { imageLocal }
 * @param {Function} deps.removeImage  (imageLocal) → borra el archivo
 */
function createFotos({ query, saveImage = null, removeImage = async () => {} }) {
  // Una operación a la vez: dos subidas seguidas no se pisan la lista.
  let cola = Promise.resolve();
  function enCola(fn) {
    const p = cola.then(fn, fn);
    cola = p.catch(() => {});
    return p;
  }

  async function leerProducto(productId) {
    const rows = await query('SELECT id, nombre, online_images FROM products WHERE id = ? LIMIT 1', [Number(productId)]);
    if (!rows[0]) throw errorConEstado('Producto no encontrado.', 404);
    return rows[0];
  }

  async function guardar(productId, lista) {
    await query('UPDATE products SET online_images = ? WHERE id = ?', [lista.length ? JSON.stringify(lista) : null, Number(productId)]);
  }

  async function listar(productId) {
    const row = await leerProducto(productId);
    return { producto: { id: Number(row.id), nombre: row.nombre }, fotos: leerFotosExtra(row.online_images), max: MAX_EXTRA };
  }

  function agregar(productId, buffer) {
    return enCola(async () => {
      if (!saveImage) throw errorConEstado('Este equipo no puede guardar fotos.', 500);
      if (!buffer || !buffer.length) throw errorConEstado('La imagen está vacía.', 400);
      const row = await leerProducto(productId);
      const lista = leerFotosExtra(row.online_images);
      if (lista.length >= MAX_EXTRA) throw errorConEstado(`Ya tiene ${MAX_EXTRA} fotos adicionales (${MAX_FOTOS_PRODUCTO} con la principal).`, 409);
      const saved = await saveImage({ productId: Number(row.id), productName: row.nombre, buffer });
      if (!saved?.imageLocal) throw errorConEstado('No se pudo guardar la imagen.', 500);
      lista.push(saved.imageLocal);
      await guardar(productId, lista);
      return { producto: { id: Number(row.id), nombre: row.nombre }, fotos: lista, max: MAX_EXTRA };
    });
  }

  /** n empieza en 1 (la 1.ª foto adicional). */
  function quitar(productId, n) {
    return enCola(async () => {
      const row = await leerProducto(productId);
      const lista = leerFotosExtra(row.online_images);
      const i = Number(n) - 1;
      if (!Number.isInteger(i) || i < 0 || i >= lista.length) throw errorConEstado('Esa foto no existe.', 404);
      const [ruta] = lista.splice(i, 1);
      await guardar(productId, lista);
      // Otro producto podría usar el mismo archivo (mismo nombre e imagen): solo se borra si nadie más lo tiene.
      const otros = await query('SELECT COUNT(*) AS n FROM products WHERE image_local = ? OR online_images LIKE ?', [ruta, `%${ruta}%`]);
      if (!Number(otros[0]?.n || 0)) await removeImage(ruta).catch(() => {});
      return { producto: { id: Number(row.id), nombre: row.nombre }, fotos: lista, max: MAX_EXTRA };
    });
  }

  /** Mueve la foto n un lugar (dir = -1 izquierda, 1 derecha). */
  function mover(productId, n, dir) {
    return enCola(async () => {
      const row = await leerProducto(productId);
      const lista = leerFotosExtra(row.online_images);
      const i = Number(n) - 1;
      const j = i + (Number(dir) < 0 ? -1 : 1);
      if (!Number.isInteger(i) || i < 0 || i >= lista.length) throw errorConEstado('Esa foto no existe.', 404);
      if (j >= 0 && j < lista.length) {
        [lista[i], lista[j]] = [lista[j], lista[i]];
        await guardar(productId, lista);
      }
      return { producto: { id: Number(row.id), nombre: row.nombre }, fotos: lista, max: MAX_EXTRA };
    });
  }

  return { listar, agregar, quitar, mover };
}

module.exports = { createFotos, leerFotosExtra, MAX_EXTRA };
