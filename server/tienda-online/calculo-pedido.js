'use strict';

/**
 * server/tienda-online/calculo-pedido.js
 *
 * Totales de un pedido de la tienda online. Lo usan el servicio en la nube
 * (al cotizar y al crear el pedido) y el POS (al revisar un pedido); la nube
 * lo recibe copiado con scripts/vendor-sync.js, así hay UNA sola fórmula.
 *
 * Las cuentas son las mismas del carrito de Ventas (js/ventas.js:
 * calculateSaleItemBase / calculateSaleItemDiscount / calculateSaleItemTax):
 *   base      = precio × cantidad
 *   descuento = base × descuento% del producto
 *   ITBIS     = (base − descuento) × tasa   ó   monto fijo × cantidad
 * y la promoción se elige con el mismo motor del POS (promotion-engine.js).
 *
 * Al facturar, el POS vuelve a calcular todo con su lógica normal; esto es el
 * precio que se le ofrece y se le respeta al cliente.
 */

const { buildActiveMapFromRows, pickWinningPromotion } = require('../services/promotion-engine');
const { MAX_CANTIDAD_LINEA } = require('./contrato');

function round2(value) {
  return Math.round((Number(value) || 0) * 100 + Number.EPSILON) / 100;
}

function esVentaPorUnidad(producto) {
  return String(producto?.modoVenta || 'unidad') === 'unidad';
}

/** Cantidad válida para el producto o null. */
function normalizarCantidad(producto, cantidad) {
  const n = Number(cantidad);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_CANTIDAD_LINEA) return null;
  if (esVentaPorUnidad(producto)) return Number.isInteger(n) ? n : null;
  const redondeada = round2(n);
  return redondeada > 0 ? redondeada : null;
}

/** Precio unitario vigente para esa cantidad (con la promoción que gane). */
function precioParaCantidad(producto, cantidad, now = new Date()) {
  const productoId = Number(producto.id);
  const ofertaMap = buildActiveMapFromRows(producto.ofertas || [], { now });
  const quantityMap = buildActiveMapFromRows(producto.porCantidad || [], { now, withMinQty: true });
  const promo = pickWinningPromotion({ ofertaMap, quantityMap, productoId, qty: cantidad });
  if (promo) {
    return {
      precio: round2(promo.precioPromocion),
      precioOriginal: round2(promo.precioOriginal),
      promocion: { id: promo.promotionId, nombre: promo.nombre, texto: promo.texto || '' },
    };
  }
  return { precio: round2(producto.precio), precioOriginal: null, promocion: null };
}

/** Promoción por cantidad para mostrar en la tienda ("3+ a RD$ X"). */
function promocionPorCantidad(producto, now = new Date()) {
  const quantityMap = buildActiveMapFromRows(producto.porCantidad || [], { now, withMinQty: true });
  const regla = quantityMap[Number(producto.id)];
  return regla ? { cantidadMinima: regla.cantidadMinima, precio: round2(regla.precioPromocion), nombre: regla.nombre } : null;
}

function calcularLinea(producto, cantidad, now = new Date()) {
  const { precio, precioOriginal, promocion } = precioParaCantidad(producto, cantidad, now);
  const descuentoPct = Math.min(100, Math.max(0, Number(producto.descuentoPct || 0)));
  const subtotal = round2(precio * cantidad);
  const descuento = round2(subtotal * (descuentoPct / 100));
  const neto = round2(subtotal - descuento);
  const tx = producto.itbis || null;
  let itbis = 0;
  if (tx && tx.modo === 'monto') {
    itbis = round2(Math.max(0, Number(tx.monto || 0)) * cantidad);
  } else if (tx && Number(tx.tasa) > 0 && neto > 0) {
    itbis = round2(neto * (Number(tx.tasa) / 100));
  }
  return {
    productoId: Number(producto.id),
    codigo: producto.codigo || '',
    nombre: producto.nombre,
    unidad: producto.unidad || 'Unidad',
    modoVenta: producto.modoVenta || 'unidad',
    cantidad,
    precioUnitario: precio,
    precioOriginal,
    promocionId: promocion ? promocion.id : null,
    promocionNombre: promocion ? promocion.nombre : null,
    descuentoPct,
    subtotal,
    descuento,
    itbis,
    itbisModo: tx ? tx.modo : null,
    itbisTasa: tx && tx.modo !== 'monto' ? Number(tx.tasa || 0) : 0,
    itbisMontoUnit: tx && tx.modo === 'monto' ? Number(tx.monto || 0) : 0,
    total: round2(neto + itbis),
  };
}

/**
 * Calcula el pedido completo.
 * @param {object} p
 * @param {Map<number, object>} p.catalogo  productos publicados por id
 * @param {Array<{productoId, cantidad}>} p.items
 * @param {{costo?:number, aplicaItbis?:boolean, tasaItbis?:number}} [p.delivery]
 * @returns {{ lineas, totales, errores }}
 */
function calcularPedido({ catalogo, items, delivery = null, now = new Date() }) {
  const errores = [];
  const porProducto = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const id = Number(item?.productoId);
    if (!Number.isInteger(id) || id <= 0) {
      errores.push({ productoId: item?.productoId ?? null, error: 'Producto inválido.' });
      continue;
    }
    porProducto.set(id, (porProducto.get(id) || 0) + Number(item?.cantidad || 0));
  }

  const lineas = [];
  for (const [id, cantidadPedida] of porProducto) {
    const producto = catalogo.get(id);
    if (!producto) {
      errores.push({ productoId: id, error: 'Este producto ya no está disponible en la tienda.' });
      continue;
    }
    const cantidad = normalizarCantidad(producto, cantidadPedida);
    if (cantidad === null) {
      errores.push({
        productoId: id,
        nombre: producto.nombre,
        error: esVentaPorUnidad(producto)
          ? `La cantidad de ${producto.nombre} debe ser un número entero entre 1 y ${MAX_CANTIDAD_LINEA}.`
          : `La cantidad de ${producto.nombre} no es válida.`,
      });
      continue;
    }
    lineas.push(calcularLinea(producto, cantidad, now));
  }

  const totales = {
    subtotal: 0, descuento: 0, itbis: 0, ahorroPromociones: 0,
    delivery: 0, deliveryItbis: 0, total: 0, articulos: 0,
  };
  for (const linea of lineas) {
    totales.subtotal += linea.subtotal;
    totales.descuento += linea.descuento;
    totales.itbis += linea.itbis;
    totales.articulos += linea.cantidad;
    if (linea.precioOriginal !== null && linea.precioOriginal > linea.precioUnitario) {
      totales.ahorroPromociones += (linea.precioOriginal - linea.precioUnitario) * linea.cantidad;
    }
  }
  const costoDelivery = round2(Math.max(0, Number(delivery?.costo || 0)));
  totales.delivery = costoDelivery;
  totales.deliveryItbis = delivery?.aplicaItbis && Number(delivery?.tasaItbis) > 0
    ? round2(costoDelivery * (Number(delivery.tasaItbis) / 100))
    : 0;
  for (const key of ['subtotal', 'descuento', 'itbis', 'ahorroPromociones', 'articulos']) {
    totales[key] = round2(totales[key]);
  }
  totales.total = round2(totales.subtotal - totales.descuento + totales.itbis + totales.delivery + totales.deliveryItbis);
  return { lineas, totales, errores };
}

module.exports = {
  round2,
  normalizarCantidad,
  precioParaCantidad,
  promocionPorCantidad,
  calcularLinea,
  calcularPedido,
};
