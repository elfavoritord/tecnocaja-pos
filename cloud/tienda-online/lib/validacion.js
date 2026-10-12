'use strict';

// Validación del checkout. Nada de lo que manda el navegador se usa tal cual:
// precios, impuestos, totales y existencia los calcula el servidor; aquí solo
// se limpian y acotan los datos del cliente.

const { MAX_ITEMS_PEDIDO } = require('../vendor/tienda-online/contrato');

function texto(value, max) {
  // eslint-disable-next-line no-control-regex -- quitar caracteres de control es justo la idea
  return String(value ?? '').replace(/[\u0000-\u001F\u007F<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function digitos(value) {
  return String(value || '').replace(/\D/g, '');
}

function error(message, campo) {
  const e = new Error(message);
  e.statusCode = 400;
  e.campo = campo;
  return e;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const KEY_RE = /^[A-Za-z0-9_-]{16,80}$/;

function validarPedido(body = {}) {
  if (texto(body.website, 50)) throw error('Solicitud no válida.', 'website');

  const idempotencyKey = String(body.idempotencyKey || '');
  if (!KEY_RE.test(idempotencyKey)) throw error('Falta el identificador del pedido. Recarga la página.', 'idempotencyKey');

  const c = body.cliente || {};
  const nombre = texto(c.nombre, 120);
  if (nombre.length < 2) throw error('Escribe tu nombre.', 'cliente.nombre');
  const telefono = digitos(c.telefono);
  if (telefono.length < 10 || telefono.length > 15) throw error('Escribe un teléfono válido (10 dígitos).', 'cliente.telefono');
  const whatsapp = digitos(c.whatsapp) || telefono;
  if (whatsapp.length < 10 || whatsapp.length > 15) throw error('El WhatsApp no es válido.', 'cliente.whatsapp');
  const email = texto(c.email, 160).toLowerCase();
  if (email && !EMAIL_RE.test(email)) throw error('El correo no es válido.', 'cliente.email');

  const e = body.entrega || {};
  const tipo = e.tipo === 'delivery' ? 'delivery' : e.tipo === 'retiro' ? 'retiro' : null;
  if (!tipo) throw error('Elige cómo quieres recibir tu pedido.', 'entrega.tipo');
  const entrega = {
    tipo,
    zonaId: texto(e.zonaId, 40),
    direccion: texto(e.direccion, 255),
    sector: texto(e.sector, 120),
    referencia: texto(e.referencia, 255),
    municipio: texto(e.municipio, 120),
    provincia: texto(e.provincia, 120),
  };
  if (tipo === 'delivery') {
    if (entrega.direccion.length < 5) throw error('Escribe la dirección de entrega.', 'entrega.direccion');
    if (entrega.sector.length < 2) throw error('Escribe el sector o barrio.', 'entrega.sector');
  }

  const metodo = texto(body.pago?.metodo, 30);
  if (!metodo) throw error('Elige cómo vas a pagar.', 'pago.metodo');

  const comp = body.comprobante || {};
  const comprobante = { solicitado: comp.solicitado === true, rnc: '', razonSocial: '' };
  if (comprobante.solicitado) {
    comprobante.rnc = digitos(comp.rnc);
    comprobante.razonSocial = texto(comp.razonSocial, 160);
    if (![9, 11].includes(comprobante.rnc.length)) throw error('El RNC o la cédula debe tener 9 u 11 dígitos.', 'comprobante.rnc');
    if (comprobante.razonSocial.length < 2) throw error('Escribe el nombre o razón social del comprobante.', 'comprobante.razonSocial');
  }

  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw error('Tu carrito está vacío.', 'items');
  if (items.length > MAX_ITEMS_PEDIDO) throw error(`Máximo ${MAX_ITEMS_PEDIDO} productos distintos por pedido.`, 'items');

  return {
    idempotencyKey,
    cliente: { nombre, telefono, whatsapp, email },
    entrega,
    metodo,
    comprobante,
    notas: texto(body.notas, 500),
    items: items.map((it) => ({ productoId: Number(it?.productoId), cantidad: Number(it?.cantidad) })),
  };
}

function validarItems(body = {}) {
  const items = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS_PEDIDO) : [];
  return items.map((it) => ({ productoId: Number(it?.productoId), cantidad: Number(it?.cantidad) }));
}

module.exports = { validarPedido, validarItems, texto, digitos };
