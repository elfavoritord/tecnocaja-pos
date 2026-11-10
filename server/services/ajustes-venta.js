'use strict';
// Cancelación y notas de crédito (mejora 4). Reglas por tipo de documento y
// estado fiscal REAL; nunca se asume que un e-CF fue aceptado:
//   ticket interno      → cancelación interna documentada / nota de crédito interna
//   comprobante serie B → anulación (se reporta en el 608) o nota de crédito B04
//   e-CF aceptado       → nota de crédito electrónica E34 (total o parcial)
//   e-CF pendiente      → esperar la respuesta de la DGII (no se cancela a ciegas)
//   e-CF rechazado      → no es comprobante válido: cancelación interna, sin E34
// La factura original nunca se borra ni se sobrescribe: los ajustes son
// registros nuevos (sale_returns, cash_movements, ecf_documents).
const M = require('../../js/pos-money');

const c = (v) => M.cents(v === null || v === undefined || v === '' ? 0 : Number(v).toFixed(2));
const n = (v) => M.number(v);
const ESTADOS_VALIDOS = new Set(['aceptado', 'aceptado_condicional']);
const ESTADOS_RECHAZO = new Set(['rechazado', 'error', 'error_validacion']);

function httpError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function diasDesde(fecha) {
  const t = new Date(String(fecha || '').replace(' ', 'T')).getTime();
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : 0;
}

async function documentoEcf(run, saleId) {
  const rows = await run(
    `SELECT id, tipo_ecf, encf, estado_dgii, track_id FROM ecf_documents
      WHERE sale_id = ? AND tipo_ecf NOT IN ('E33', 'E34') ORDER BY id DESC LIMIT 1`,
    [saleId]
  ).catch(() => []);
  return rows[0] || null;
}

// Qué se puede hacer con esta venta, y por qué no cuando no se puede.
async function clasificar(run, sale) {
  const dias = diasDesde(sale.created_at);
  const base = { dias, masDe30Dias: dias > 30, ncf: sale.ncf || '', tipoNcf: sale.ncf_type || '' };
  if (String(sale.fiscal_status || '') === 'cancelada') {
    return { ...base, clase: claseDe(sale), estadoFiscal: 'cancelada', cancelar: { permitido: false, razon: 'La factura ya está cancelada.' }, notaCredito: { permitido: false, razon: 'La factura ya está cancelada.' } };
  }
  if (String(sale.sale_status || '') === 'pendiente') {
    return { ...base, clase: claseDe(sale), estadoFiscal: 'pendiente_cobro',
      cancelar: { permitido: true, modos: ['interna'], razon: 'Factura pendiente de cobro: se cancela sin mover dinero.' },
      notaCredito: { permitido: false, razon: 'Solo se emite nota de crédito sobre una venta cobrada.' } };
  }
  let clase = claseDe(sale);
  // Un e-CF real de la venta manda sobre el tipo guardado: una venta con su
  // e-CF no se trata como ticket (se le haría una nota interna, sin E34).
  const doc = clase === 'ncf' ? null : await documentoEcf(run, sale.id);
  if (clase === 'ticket' && doc) clase = 'ecf';
  if (clase === 'ticket') {
    return { ...base, clase, estadoFiscal: 'sin_comprobante',
      cancelar: { permitido: true, modos: ['interna'], razon: 'Ticket interno sin comprobante fiscal: cancelación interna documentada.' },
      notaCredito: { permitido: true, tipo: 'interna', razon: 'Nota de crédito interna (sin comprobante fiscal).' } };
  }
  if (clase === 'ncf') {
    return { ...base, clase, estadoFiscal: 'emitido',
      cancelar: { permitido: true, modos: ['anulacion_608', 'nota_credito_b04'], razon: 'Comprobante serie B: anular el NCF (se reporta en el formato 608) o emitir una nota de crédito B04 por el total.' },
      notaCredito: { permitido: true, tipo: 'B04', razon: 'Nota de crédito B04 con referencia al NCF original.' } };
  }
  const estado = String(doc?.estado_dgii || sale.ecf_estado || '').toLowerCase();
  const ecf = doc ? { id: Number(doc.id), encf: doc.encf, tipo: doc.tipo_ecf, estado: doc.estado_dgii } : null;
  if (ESTADOS_VALIDOS.has(estado)) {
    return { ...base, clase, estadoFiscal: estado, ecf,
      cancelar: { permitido: true, modos: ['nota_credito_e34'], razon: 'e-CF aceptado: se anula con una nota de crédito electrónica E34 (código 1).' },
      notaCredito: { permitido: true, tipo: 'E34', razon: 'Nota de crédito electrónica E34 con referencia al e-CF original.' } };
  }
  if (ESTADOS_RECHAZO.has(estado)) {
    return { ...base, clase, estadoFiscal: 'rechazado', ecf,
      cancelar: { permitido: true, modos: ['interna_rechazado'], razon: 'El e-CF fue rechazado por la DGII: no es un comprobante válido. La venta se cancela sin nota de crédito y su secuencia queda usada.' },
      notaCredito: { permitido: false, razon: 'No hay un e-CF aceptado al cual referirse. Corrige y emite un e-CF nuevo, o cancela la venta.' } };
  }
  if (!doc && !estado) {
    // Venta electrónica que nunca llegó a generar su e-CF (módulo apagado).
    return { ...base, clase: 'ticket', estadoFiscal: 'sin_ecf',
      cancelar: { permitido: true, modos: ['interna'], razon: 'No se generó e-CF para esta venta: cancelación interna documentada.' },
      notaCredito: { permitido: true, tipo: 'interna', razon: 'Nota de crédito interna (la venta no tiene e-CF).' } };
  }
  return { ...base, clase, estadoFiscal: 'pendiente_dgii', ecf,
    cancelar: { permitido: false, razon: 'El e-CF está pendiente de respuesta de la DGII. Espera la respuesta (o reintenta el envío en Facturación electrónica) antes de cancelar.' },
    notaCredito: { permitido: false, razon: 'La nota de crédito E34 solo se emite sobre un e-CF aceptado. El e-CF sigue pendiente de respuesta.' } };
}

function claseDe(sale) {
  if (sale.document_type === 'factura-electronica') return 'ecf';
  if (sale.document_type === 'comprobante-fiscal' || /^B\d\d/.test(String(sale.ncf || ''))) return 'ncf';
  return 'ticket';
}

// Importe a devolver por línea: neto (con descuentos) + ITBIS + propina, en
// proporción a lo devuelto. Si con esto se completa la factura, el total es
// exactamente lo que queda pendiente de devolver (sin centavos perdidos).
function calcularLineas({ sale, originalItems, devueltoMap, itemsToReturn, previos }) {
  const validados = [];
  for (const item of itemsToReturn) {
    const saleItemId = Number(item.saleItemId || 0);
    const qty = Number(item.qty || 0);
    if (!saleItemId || !(qty > 0)) continue;
    const original = originalItems.find((o) => Number(o.id) === saleItemId);
    if (!original) throw httpError(`La línea ${saleItemId} no pertenece a esta factura.`);
    const vendida = Number(original.qty || 0);
    const yaDevuelta = Number(devueltoMap[saleItemId] || 0);
    if (qty > vendida - yaDevuelta + 1e-9) throw httpError(`${original.product_name}: solo puedes devolver ${vendida - yaDevuelta} unidad(es), ya se devolvieron ${yaDevuelta}.`);
    const r = vendida > 0 ? qty / vendida : 0;
    const neto = c(Number(original.price || 0) * qty * (1 - Number(original.discount_rate || 0) / 100)) - c(Number(original.general_discount_amount || 0) * r);
    const itbis = String(original.tax_mode || '') === 'monto'
      ? c(Number(original.tax_amount || 0) * r)
      : M.percent(neto, Number(original.tax_rate || 0));
    const propina = c(Number(original.legal_tip_amount || 0) * r);
    validados.push({
      saleItemId, productId: original.product_id ? Number(original.product_id) : null, productName: original.product_name || '',
      qty, price: Number(original.price || 0), comboSnapshot: original.combo_snapshot || null, taxRate: Number(original.tax_rate || 0),
      tracksStock: original.tracks_stock === undefined ? true : Number(original.tracks_stock) !== 0,
      restock: item.restock !== false && item.reintegrar !== false,
      neto, itbis, propina, total: neto + itbis + propina,
    });
  }
  if (!validados.length) throw httpError('No hay productos válidos para la nota de crédito.');
  const vendidoTotal = originalItems.reduce((s, i) => s + Number(i.qty || 0), 0);
  const devueltoTotal = validados.reduce((s, i) => s + i.qty, 0) + Object.values(devueltoMap).reduce((s, v) => s + Number(v || 0), 0);
  const completa = devueltoTotal >= vendidoTotal - 1e-9;
  let neto = validados.reduce((s, i) => s + i.neto, 0n);
  let itbis = validados.reduce((s, i) => s + i.itbis, 0n);
  let propina = validados.reduce((s, i) => s + i.propina, 0n);
  if (completa) {
    const restanteTotal = c(sale.total) - c(previos.total);
    const restanteItbis = c(sale.tax) - c(previos.itbis);
    const restantePropina = c(sale.legal_tip_amount) - c(previos.propina);
    if (restanteTotal >= 0n) {
      itbis = restanteItbis >= 0n ? restanteItbis : itbis;
      propina = restantePropina >= 0n ? restantePropina : propina;
      neto = restanteTotal - itbis - propina;
    }
  }
  return { lineas: validados, completa, neto, itbis, propina, total: neto + itbis + propina };
}

// Componentes con que se cobró la venta (columnas exactas o, en ventas viejas, su método).
function componentes(sale) {
  const total = c(sale.total);
  if (Number(sale.financial_version || 0) > 0 && sale.payment_method !== 'contra_entrega') {
    return { cash: c(sale.cash_amount), card: c(sale.card_amount), transfer: c(sale.transfer_amount), credit: c(sale.credit_amount) };
  }
  switch (String(sale.payment_method || '')) {
    case 'tarjeta': return { cash: 0n, card: total, transfer: 0n, credit: 0n };
    case 'transferencia': return { cash: 0n, card: 0n, transfer: total, credit: 0n };
    case 'credito': { const rec = c(sale.received_amount); const cash = rec > total ? total : rec; return { cash, card: 0n, transfer: 0n, credit: total - cash }; }
    case 'contra_entrega': return String(sale.delivery_cash_status || '') === 'validado' ? { cash: total, card: 0n, transfer: 0n, credit: 0n } : { cash: 0n, card: 0n, transfer: 0n, credit: 0n };
    default: return { cash: total, card: 0n, transfer: 0n, credit: 0n };
  }
}

// Reparte el importe del ajuste entre lo que se cobró. El crédito pendiente
// se rebaja (sin pasar de lo que aún se debe); si el cliente ya lo había
// pagado, esa parte se le devuelve como dinero. Tarjeta y transferencia se
// reembolsan fuera de la gaveta.
function repartirReembolso(sale, importe, { refundCash = true } = {}) {
  const total = c(sale.total);
  const comp = componentes(sale);
  const p = (x) => (total > 0n ? M.divide(x * importe, total) : 0n);
  const card = p(comp.card), transfer = p(comp.transfer);
  let cash = p(comp.cash);
  let credit = importe - card - transfer - cash;
  const pendiente = (() => {
    const v = total - c(sale.received_amount) - c(sale.credit_adjustment);
    const credito = comp.credit > 0n || sale.payment_method === 'credito';
    return credito && v > 0n ? v : 0n;
  })();
  if (credit < 0n) { cash += credit; credit = 0n; if (cash < 0n) cash = 0n; }
  if (credit > pendiente) { cash += credit - pendiente; credit = pendiente; }
  const efectivoCaja = refundCash ? cash : 0n;
  return {
    total: n(importe), efectivo: n(cash), efectivoDesdeCaja: n(efectivoCaja), tarjeta: n(card), transferencia: n(transfer), creditoRebajado: n(credit),
    efectivoSinReembolsar: n(cash - efectivoCaja),
  };
}

module.exports = { clasificar, calcularLineas, repartirReembolso, componentes, documentoEcf, claseDe, diasDesde };
