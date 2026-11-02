'use strict';

// Productos y servicios viven en la misma tabla (products). Un servicio es
// product_type = 'servicio': nunca lleva inventario, lo diga quien lo diga.

const TIPO_SERVICIO = 'servicio';

function esServicio(tipo) {
  return String(tipo || '').trim().toLowerCase() === TIPO_SERVICIO;
}

/** Devuelve los datos listos para guardar, sin cambiar los que llegaron. */
function normalizarArticulo(data = {}) {
  const limpio = {
    ...data,
    codigo: String(data.codigo ?? '').trim(),
    barcode: String(data.barcode ?? '').trim(),
  };
  if (esServicio(limpio.tipoProducto)) {
    limpio.tipoProducto = TIPO_SERVICIO;
    limpio.tracksStock = false;
    limpio.stock = 0;
    limpio.stockMin = 0;
    limpio.descuentoHastaAgotar = false;
    limpio.esCombo = false;
  }
  return limpio;
}

/**
 * Código interno cuando el negocio no quiere escribir uno. La columna sigue siendo
 * obligatoria porque la sincronización entre sucursales usa el código como llave.
 */
async function generarCodigoArticulo(query, tipo) {
  const prefijo = esServicio(tipo) ? 'SRV' : 'ART';
  const [fila] = await query('SELECT COUNT(*) AS n FROM products');
  let numero = Number(fila?.n || 0) + 1;
  for (let intento = 0; intento < 200; intento += 1) {
    const codigo = `${prefijo}-${String(numero).padStart(5, '0')}`;
    const repetidos = await query('SELECT id FROM products WHERE codigo = ? OR barcode = ? LIMIT 1', [codigo, codigo]);
    if (!repetidos.length) return codigo;
    numero += 1;
  }
  const error = new Error('No se pudo generar el código. Escribe uno a mano.');
  error.statusCode = 409;
  throw error;
}

module.exports = {
  TIPO_SERVICIO,
  esServicio,
  generarCodigoArticulo,
  normalizarArticulo,
};
