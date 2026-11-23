'use strict';

// Precio cambiado en la venta (F3 en el carrito, js/ventas.js →
// startSaleLinePriceEdit). Decisiones de Emilio (2026-11-15):
//  - en la venta vale para esa línea; desde el 2026-11-23 la pantalla también
//    lo deja en el producto (POST /api/products/venta/:id/precio,
//    server/routes/venta-catalogo.routes.js);
//  - cualquier usuario que venda puede hacerlo (queda en la auditoría);
//  - nunca en productos por peso (ellos tienen el total editado), ni en combos,
//    venta rápida, combos personalizados o pedidos de la tienda online.
// El precio va en el mismo sentido que el precio de venta del producto: con el
// ITBIS incluido (método 3) es el precio final; si no, el precio sin ITBIS.

const PRECIO_MAXIMO = 99999999;

function errorPrecio(mensaje) {
  return Object.assign(new Error(mensaje), { statusCode: 400 });
}

// null si la línea no trae precio cambiado; si lo trae, el precio validado
// (2 decimales). Lanza 400 si no se puede usar en esa línea.
function precioManualDeLinea(item = {}, { product = null, isQuickSale = false, customCombo = null, comboSnapshot = null, agreed = null, porPeso = false } = {}) {
  const crudo = item.precioManual;
  if (crudo === undefined || crudo === null || crudo === '') return null;
  const nombre = product?.nombre || item.nombre || 'este producto';
  if (isQuickSale || customCombo || comboSnapshot || agreed || porPeso || Number(item.montoFinal) > 0) {
    throw errorPrecio(`El precio de "${nombre}" no se puede cambiar en la venta.`);
  }
  const precio = Number(crudo);
  if (!Number.isFinite(precio) || precio <= 0 || precio > PRECIO_MAXIMO) {
    throw errorPrecio(`El precio escrito para "${nombre}" no es válido.`);
  }
  return Math.round(precio * 100) / 100;
}

module.exports = { precioManualDeLinea, PRECIO_MAXIMO };
