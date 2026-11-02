'use strict';

// Cada servicio del catálogo de una Empresa de Servicios tiene su producto en
// `products` (product_type 'servicio', sin inventario). Las cotizaciones, facturas y
// el portal del contador siguen usando svc_services; la tienda online y las fotos
// salen de `products`, que es el único catálogo que publica.
//
// Se puede correr las veces que haga falta: nunca duplica. Si algo falla, el servicio
// ya quedó guardado y la siguiente corrida lo arregla.

const { TIPO_SERVICIO } = require('../../services/articulos');

async function codigoLibre(query, deseado, servicioId, productoId) {
  const candidato = String(deseado || '').trim().slice(0, 40);
  if (candidato) {
    const usados = await query('SELECT id FROM products WHERE (codigo = ? OR barcode = ?) AND id <> ? LIMIT 1', [candidato, candidato, productoId || 0]);
    if (!usados.length) return candidato;
  }
  return `SRV-${servicioId}`;
}

async function enlazarServicio(query, servicioId) {
  const [s] = await query(
    `SELECT s.*, c.nombre AS categoria_nombre
       FROM svc_services s LEFT JOIN svc_service_categories c ON c.id = s.categoria_id
      WHERE s.id = ?`,
    [Number(servicioId)],
  );
  if (!s) return null;

  const categoria = String(s.categoria_nombre || 'Servicios').slice(0, 60);
  await query('INSERT OR IGNORE INTO categories (nombre) VALUES (?)', [categoria]);
  const estado = Number(s.activo) === 0 ? 'Inactivo' : 'Activo';
  const aplicaItbis = Number(s.itbis_pct || 0) > 0 ? 1 : 0;
  const nombre = String(s.nombre).slice(0, 160);
  const unidad = String(s.unidad || 'servicio').slice(0, 40);

  let productoId = Number(s.product_id || 0) || null;
  if (productoId) {
    const [existe] = await query('SELECT id FROM products WHERE id = ?', [productoId]);
    if (!existe) productoId = null;
  }
  const codigo = await codigoLibre(query, s.codigo, s.id, productoId);

  if (productoId) {
    await query(
      `UPDATE products SET codigo = ?, barcode = ?, nombre = ?, categoria = ?, unidad = ?, precio_venta = ?,
              estado = ?, aplica_itbis = ?, product_type = ?, tracks_stock = 0, stock = 0, stock_min = 0
        WHERE id = ?`,
      [codigo, codigo, nombre, categoria, unidad, Number(s.precio || 0), estado, aplicaItbis, TIPO_SERVICIO, productoId],
    );
  } else {
    const r = await query(
      `INSERT INTO products
        (codigo, barcode, nombre, categoria, unidad, precio_compra, precio_venta, stock, stock_min, estado,
         product_type, aplica_itbis, tracks_stock)
       VALUES (?, ?, ?, ?, ?, 0, ?, 0, 0, ?, ?, ?, 0)`,
      [codigo, codigo, nombre, categoria, unidad, Number(s.precio || 0), estado, TIPO_SERVICIO, aplicaItbis],
    );
    productoId = Number(r.insertId);
    await query('UPDATE svc_services SET product_id = ? WHERE id = ?', [productoId, s.id]);
  }
  // La descripción de la tienda es de la tienda online: esa columna puede no existir aún.
  await query('UPDATE products SET online_description = ? WHERE id = ?', [String(s.descripcion || '').slice(0, 500), productoId]).catch(() => {});
  return productoId;
}

/** Nunca rompe el guardado del servicio. */
async function enlazarServicioSeguro(query, servicioId, logger = console) {
  try {
    return await enlazarServicio(query, servicioId);
  } catch (error) {
    logger.warn?.(`[servicios] No se pudo enlazar el servicio ${servicioId} con su producto:`, error.message);
    return null;
  }
}

async function enlazarTodos(query, logger = console) {
  const filas = await query('SELECT id FROM svc_services').catch(() => []);
  let hechos = 0;
  for (const fila of filas) {
    if (await enlazarServicioSeguro(query, fila.id, logger)) hechos += 1;
  }
  return hechos;
}

module.exports = { enlazarServicio, enlazarServicioSeguro, enlazarTodos };
