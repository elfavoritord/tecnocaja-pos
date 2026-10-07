'use strict';

/**
 * server/sync/control-center/labels.js
 *
 * Nombres legibles de los códigos que guarda el POS. La app de reportes NO
 * tiene listas fijas: muestra lo que llegue aquí. Para un código nuevo (un
 * método de pago agregado mañana) primero se usa el nombre configurado en la
 * tabla payment_methods y, si no hay, el código "humanizado".
 */

const PAYMENT_LABELS = {
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  transferencia: 'Transferencia',
  credito: 'Crédito',
  mixto: 'Mixto',
  contra_entrega: 'Contra entrega',
  usd: 'Dólares (USD)',
};

const ORDER_TYPE_LABELS = {
  mostrador: 'Mostrador',
  delivery: 'Delivery',
  recoger: 'Para recoger',
  mesa: 'Mesa',
};

const DOC_TYPE_LABELS = {
  ticket: 'Ticket',
  'comprobante-fiscal': 'Comprobante fiscal (NCF)',
  'factura-electronica': 'Factura electrónica (e-CF)',
};

const NCF_TYPE_LABELS = {
  B01: 'B01 Crédito fiscal',
  B02: 'B02 Consumidor final',
  B03: 'B03 Nota de débito',
  B04: 'B04 Nota de crédito',
  B14: 'B14 Régimen especial',
  B15: 'B15 Gubernamental',
  B16: 'B16 Exportaciones',
  E31: 'E31 Crédito fiscal',
  E32: 'E32 Consumo',
  E33: 'E33 Nota de débito',
  E34: 'E34 Nota de crédito',
  E41: 'E41 Compras',
  E43: 'E43 Gastos menores',
  E44: 'E44 Régimen especial',
  E45: 'E45 Gubernamental',
  E46: 'E46 Exportaciones',
  E47: 'E47 Pagos al exterior',
};

const DELIVERY_STATUS_LABELS = {
  pendiente: 'Pendiente',
  en_camino: 'En camino',
  entregado: 'Entregado',
  incidencia: 'Con incidencia',
  cancelado: 'Cancelado',
};

// Estados de ecf_documents.estado_dgii agrupados como los ve el dueño.
const ECF_GROUPS = {
  aceptado: 'accepted',
  aceptado_condicional: 'accepted',
  rechazado: 'rejected',
  enviado: 'inProcess',
  procesando: 'inProcess',
  en_proceso: 'inProcess',
  pendiente: 'pending',
  firmado: 'pending',
  anulado: 'cancelled',
  anulada: 'cancelled',
};

const ECF_STATUS_LABELS = {
  aceptado: 'Aceptado',
  aceptado_condicional: 'Aceptado condicional',
  rechazado: 'Rechazado',
  enviado: 'Enviado a DGII',
  procesando: 'En proceso DGII',
  en_proceso: 'En proceso DGII',
  pendiente: 'Pendiente de envío',
  firmado: 'Firmado sin enviar',
  anulado: 'Anulado',
  anulada: 'Anulado',
  error: 'Error',
};

// Tipos de salida de caja (cash_movements.movement_type). Solo "gasto" cuenta
// como gasto en la ganancia: un pago a suplidor es compra de mercancía (ya
// está en el costo), un retiro es dinero del dueño y una devolución ya bajó
// la venta.
const OUTFLOW_TYPES = [
  'Gasto', 'gasto', 'expense',
  'Pago suplidor',
  'Devolución',
  'Retiro de efectivo', 'Retiro', 'retiro', 'withdrawal',
  'Egreso', 'salida',
];
const EXPENSE_OUTFLOW_TYPES = new Set(['gasto', 'expense']);

function humanize(code) {
  const text = String(code || '').trim().replace(/[_-]+/g, ' ');
  if (!text) return 'Otro';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function paymentLabel(code, catalog = {}) {
  const key = String(code || '').trim();
  return catalog[key] || PAYMENT_LABELS[key] || humanize(key);
}

function orderTypeLabel(code) {
  const key = String(code || '').trim();
  return ORDER_TYPE_LABELS[key] || humanize(key);
}

function docTypeLabel(code) {
  const key = String(code || '').trim();
  return DOC_TYPE_LABELS[key] || humanize(key);
}

function ncfTypeLabel(code) {
  const key = String(code || '').trim().toUpperCase();
  return NCF_TYPE_LABELS[key] || key || 'Sin comprobante';
}

function deliveryStatusLabel(code) {
  const key = String(code || '').trim();
  return DELIVERY_STATUS_LABELS[key] || humanize(key);
}

function ecfGroup(status) {
  const key = String(status || '').trim().toLowerCase();
  if (ECF_GROUPS[key]) return ECF_GROUPS[key];
  if (key.startsWith('error')) return 'error';
  return 'other';
}

function ecfStatusLabel(status) {
  const key = String(status || '').trim().toLowerCase();
  if (ECF_STATUS_LABELS[key]) return ECF_STATUS_LABELS[key];
  if (key.startsWith('error')) return 'Error';
  return humanize(key);
}

function outflowKind(type) {
  const key = String(type || '').trim().toLowerCase();
  if (EXPENSE_OUTFLOW_TYPES.has(key)) return 'expense';
  if (key === 'pago suplidor') return 'supplier';
  if (key === 'devolución' || key === 'devolucion') return 'refund';
  if (key.startsWith('retiro') || key === 'withdrawal') return 'withdrawal';
  return 'other';
}

module.exports = {
  OUTFLOW_TYPES,
  humanize,
  paymentLabel,
  orderTypeLabel,
  docTypeLabel,
  ncfTypeLabel,
  deliveryStatusLabel,
  ecfGroup,
  ecfStatusLabel,
  outflowKind,
};
