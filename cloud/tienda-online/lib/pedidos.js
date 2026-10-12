'use strict';

// Creación y seguimiento de pedidos. La tienda NO factura: deja el pedido en
// businesses/{licencia}/pedidosOnline y el POS lo recibe, lo revisa y lo cobra.
//
// Garantías del checkout:
//   - Precio, ITBIS, promoción y total salen del catálogo publicado por el POS
//     (calculo-pedido.js), nunca del navegador.
//   - La existencia se revisa DENTRO de una transacción de Firestore que
//     además reserva las unidades: dos clientes no pueden llevarse la última.
//   - Un mismo checkout (clave de idempotencia) crea un solo pedido aunque el
//     cliente toque dos veces o se reintente la petición.

const crypto = require('crypto');
const {
  rutas, claveProducto, METODOS_PAGO, NUMERO_PEDIDO_INICIAL, ESTADO_ETIQUETAS,
} = require('../vendor/tienda-online/contrato');
const { calcularPedido, round2 } = require('../vendor/tienda-online/calculo-pedido');
const { estaAbierta } = require('./horario');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function httpError(message, statusCode = 400, extra = {}) {
  const e = new Error(message);
  e.statusCode = statusCode;
  Object.assign(e, extra);
  return e;
}

/** Token de seguimiento: derivado de la clave del checkout (que solo tiene el cliente). */
function tokenDe(licenseId, idempotencyKey) {
  return sha256(`seguimiento:${licenseId}:${idempotencyKey}`).slice(0, 32);
}

function costoDelivery(perfil, entrega) {
  if (entrega.tipo !== 'delivery') return { costo: 0, zona: null };
  const zonas = perfil.delivery?.zonas || [];
  if (zonas.length) {
    const zona = zonas.find((z) => z.id === entrega.zonaId);
    if (!zona) throw httpError('Elige la zona de entrega.', 400, { campo: 'entrega.zonaId' });
    return { costo: Number(zona.costo || 0), zona };
  }
  return { costo: Number(perfil.delivery?.costoBase || 0), zona: null };
}

/** Cotiza el carrito con las reglas del POS (sin guardar nada). */
function cotizar(tienda, { items, entrega = { tipo: 'retiro' } }, nowDate = new Date(), tiendas) {
  const { perfil } = tienda;
  let delivery = { costo: 0, zona: null };
  try {
    delivery = costoDelivery(perfil, entrega);
  } catch (_error) {
    delivery = { costo: 0, zona: null };
  }
  const calc = calcularPedido({
    catalogo: tienda.productos,
    items,
    delivery: { costo: delivery.costo, aplicaItbis: perfil.delivery?.aplicaItbis, tasaItbis: perfil.tasaItbis },
    now: nowDate,
  });
  const disponibles = {};
  for (const linea of calc.lineas) {
    const p = tienda.productos.get(linea.productoId);
    const disp = tiendas.disponible(p, tienda.stock);
    disponibles[linea.productoId] = disp;
    if (disp !== null && linea.cantidad > disp) {
      calc.errores.push({
        productoId: linea.productoId,
        nombre: linea.nombre,
        error: disp <= 0 ? `${linea.nombre} está agotado.` : `Solo quedan ${disp} de ${linea.nombre}.`,
        disponible: disp,
      });
    }
  }
  return { ...calc, disponibles, delivery };
}

async function crearPedido({ db, FieldValue, tienda, datos, nowDate = new Date(), origen = {} }) {
  const { perfil, licenseId } = tienda;

  // Reglas de la tienda (configuradas en el POS).
  if (!estaAbierta(perfil.horario, nowDate) && perfil.horario?.aceptarFueraDeHorario === false) {
    throw httpError('La tienda está cerrada en este momento. Revisa el horario.', 409, { code: 'CERRADA' });
  }
  if (datos.entrega.tipo === 'delivery' && !perfil.delivery?.habilitado) throw httpError('Esta tienda no hace delivery.', 400);
  if (datos.entrega.tipo === 'retiro' && perfil.retiro?.habilitado === false) throw httpError('Esta tienda solo hace delivery.', 400);
  const pago = (perfil.pagos || []).find((p) => p.codigo === datos.metodo);
  if (!pago) throw httpError('Ese método de pago no está disponible.', 400, { campo: 'pago.metodo' });
  if (datos.comprobante.solicitado && perfil.comprobanteFiscal === false) {
    throw httpError('Esta tienda no emite comprobante fiscal desde la web.', 400);
  }
  const delivery = costoDelivery(perfil, datos.entrega);

  const calc = calcularPedido({
    catalogo: tienda.productos,
    items: datos.items,
    delivery: { costo: delivery.costo, aplicaItbis: perfil.delivery?.aplicaItbis, tasaItbis: perfil.tasaItbis },
    now: nowDate,
  });
  if (calc.errores.length) {
    throw httpError(calc.errores[0].error, 409, { code: 'CARRITO', errores: calc.errores });
  }
  if (!calc.lineas.length) throw httpError('Tu carrito está vacío.', 400);
  const totalProductos = round2(calc.totales.subtotal - calc.totales.descuento + calc.totales.itbis);
  if (perfil.pedidoMinimo && totalProductos < Number(perfil.pedidoMinimo)) {
    throw httpError(`El pedido mínimo es ${perfil.moneda || 'RD$'} ${Number(perfil.pedidoMinimo).toFixed(2)}.`, 409, { code: 'MINIMO' });
  }

  const token = tokenDe(licenseId, datos.idempotencyKey);
  const claveRef = db.doc(rutas.clave(licenseId, sha256(`${licenseId}:${datos.idempotencyKey}`)));
  const stockRef = db.doc(rutas.stock(licenseId));
  const orderRef = db.collection(rutas.pedidos(licenseId)).doc();

  return db.runTransaction(async (tx) => {
    const claveSnap = await tx.get(claveRef);
    if (claveSnap.exists) {
      // Mismo checkout: se devuelve el pedido ya creado, no otro.
      const previo = claveSnap.data();
      return { pedidoId: previo.pedidoId, numero: previo.numero, token, total: previo.total, repetido: true };
    }
    const stockSnap = await tx.get(stockRef);
    if (!stockSnap.exists) throw httpError('La tienda se está actualizando. Intenta en un minuto.', 503);
    const stock = stockSnap.data();

    const errores = [];
    const reservas = {};
    for (const linea of calc.lineas) {
      const producto = tienda.productos.get(linea.productoId);
      if (!producto.controlaStock) continue;
      const clave = claveProducto(linea.productoId);
      const item = stock.items?.[clave] || {};
      const disp = round2(Number(item.s || 0) - Math.max(0, Number(item.r || 0)));
      if (linea.cantidad > disp) {
        errores.push({
          productoId: linea.productoId,
          nombre: linea.nombre,
          disponible: Math.max(0, disp),
          error: disp <= 0 ? `${linea.nombre} se agotó.` : `Solo quedan ${disp} de ${linea.nombre}.`,
        });
      } else {
        reservas[clave] = linea.cantidad;
      }
    }
    if (errores.length) throw httpError(errores[0].error, 409, { code: 'AGOTADO', errores });

    const numero = Math.max(NUMERO_PEDIDO_INICIAL, Number(stock.contador || 0) || NUMERO_PEDIDO_INICIAL);
    const ahora = nowDate.toISOString();
    const mensaje = `Hemos recibido tu pedido #${numero}. Te avisaremos cuando lo confirmemos.`;
    tx.set(orderRef, {
      licenseId,
      slug: perfil.slug,
      sucursalId: perfil.sucursalId || null,
      numero,
      estado: 'nuevo',
      creadoEn: FieldValue.serverTimestamp(),
      actualizadoEn: FieldValue.serverTimestamp(),
      cliente: datos.cliente,
      entrega: {
        ...datos.entrega,
        zonaNombre: delivery.zona ? delivery.zona.nombre : null,
        costo: delivery.costo,
      },
      pago: { metodo: pago.codigo, etiqueta: pago.etiqueta || METODOS_PAGO[pago.codigo] || pago.codigo },
      comprobante: datos.comprobante,
      notas: datos.notas,
      items: calc.lineas,
      totales: calc.totales,
      moneda: perfil.moneda || 'RD$',
      reservas,
      reservaActiva: Object.keys(reservas).length > 0,
      tokenHash: sha256(token),
      catalogoVersion: tienda.version || '',
      historial: [{ estado: 'nuevo', en: ahora, nota: '' }],
      mensajes: [{ en: ahora, texto: mensaje }],
      pos: { importado: false, importadoEn: null, venta: null },
      origen: {
        ipHash: origen.ip ? sha256(`${origen.ip}:${ahora.slice(0, 10)}`).slice(0, 16) : null,
        agente: String(origen.agente || '').slice(0, 160),
      },
    });
    tx.set(claveRef, { pedidoId: orderRef.id, numero, total: calc.totales.total, creadoEn: FieldValue.serverTimestamp() });
    const stockUpdate = { contador: numero + 1 };
    for (const [clave, cantidad] of Object.entries(reservas)) {
      stockUpdate[`items.${clave}.r`] = FieldValue.increment(cantidad);
    }
    tx.update(stockRef, stockUpdate);
    return { pedidoId: orderRef.id, numero, token, total: calc.totales.total, repetido: false };
  });
}

/** Seguimiento público del pedido (con el token del enlace). */
async function verPedido({ db, licenseId, pedidoId, token, perfil }) {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(String(pedidoId)) || !/^[a-f0-9]{32}$/.test(String(token))) return null;
  const snap = await db.doc(rutas.pedido(licenseId, pedidoId)).get();
  if (!snap.exists) return null;
  const p = snap.data();
  const esperado = Buffer.from(String(p.tokenHash || ''), 'utf8');
  const recibido = Buffer.from(sha256(token), 'utf8');
  if (esperado.length !== recibido.length || !crypto.timingSafeEqual(esperado, recibido)) return null;
  const fecha = (v) => (v && typeof v.toDate === 'function' ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : v || null);
  return {
    numero: p.numero,
    estado: p.estado,
    estadoEtiqueta: ESTADO_ETIQUETAS[p.estado] || p.estado,
    creadoEn: fecha(p.creadoEn),
    actualizadoEn: fecha(p.actualizadoEn),
    cliente: { nombre: p.cliente?.nombre || '' },
    entrega: { tipo: p.entrega?.tipo, zona: p.entrega?.zonaNombre || '', sector: p.entrega?.sector || '' },
    pago: { etiqueta: p.pago?.etiqueta || '' },
    items: (p.items || []).map((i) => ({
      nombre: i.nombre, cantidad: i.cantidad, unidad: i.unidad, precioUnitario: i.precioUnitario, total: i.total,
    })),
    totales: p.totales,
    moneda: p.moneda,
    historial: (p.historial || []).map((h) => ({ estado: h.estado, etiqueta: ESTADO_ETIQUETAS[h.estado] || h.estado, en: h.en })),
    mensajes: (p.mensajes || []).map((m) => ({ en: m.en, texto: m.texto })),
    facturado: Boolean(p.pos?.venta),
    tienda: {
      nombre: perfil?.nombre || '',
      telefono: perfil?.telefono || '',
      whatsapp: perfil?.whatsapp || '',
      colorPrimario: perfil?.colorPrimario || '',
    },
  };
}

module.exports = { cotizar, crearPedido, verPedido, tokenDe, costoDelivery };
