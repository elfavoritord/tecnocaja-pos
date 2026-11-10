'use strict';
const money = require('../../js/pos-money');
function invalid(message) { throw Object.assign(new Error(message), { statusCode: 400 }); }
function nonnegative(value) {
  let n;
  try { n = money.cents(value ?? 0); money.number(n); } catch (_) { invalid('Importe de pago no válido.'); }
  if (n < 0n) invalid('Los pagos no pueden ser negativos.');
  return n;
}
// Amounts are applied to the invoice. Cash tender/change remain separate.
function calculate(sale, { method, status = 'pagada', total = sale.total } = {}) {
  const due = nonnegative(total);
  let cash = 0n, card = 0n, transfer = 0n, credit = 0n, change = 0n;
  if (status === 'pagada') {
    if (method === 'mixto') {
      cash = nonnegative(sale.montoEfectivo); card = nonnegative(sale.montoTarjeta);
      transfer = nonnegative(sale.montoTransferencia); credit = nonnegative(sale.montoCredito);
      const sum = cash + card + transfer + credit;
      if (sum < due) invalid('La suma del pago mixto no cubre el total.');
      change = sum - due;
      if (change > cash || (credit > 0n && change > 0n)) invalid('El pago mixto con crédito debe sumar exactamente el total. La devuelta solo puede salir del efectivo recibido.');
      cash -= change;
    } else if (method === 'credito') credit = due;
    else if (method === 'efectivo') {
      const tender = nonnegative(sale.recibido);
      if (tender < due) invalid('Efectivo recibido insuficiente.');
      cash = due; change = tender - due;
    } else if (method === 'tarjeta') card = due;
    else if (method === 'transferencia') transfer = due;
    // USD is accounted by the existing separate currency ledger.
  }
  const hasCredit = credit > 0n;
  const dueDate = String(sale.paymentDetails?.creditDueDate || '').trim();
  if (hasCredit) {
    if (!sale.clientId) invalid('El crédito requiere un cliente registrado.');
    const date = new Date(dueDate + 'T12:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dueDate) invalid('Define una fecha de vencimiento válida para el crédito.');
  }
  return { cash: money.number(cash), card: money.number(card), transfer: money.number(transfer), credit: money.number(credit),
    received: money.number(due - credit + change), change: money.number(change), dueDate: hasCredit ? dueDate : null };
}
function cashFromSale(sale) {
  if (sale.financial_version && sale.cash_amount !== null && sale.cash_amount !== undefined) return Number(sale.cash_amount);
  if (sale.payment_method === 'efectivo') return Number(sale.total || 0);
  if (sale.payment_method === 'credito') return Math.max(0, Number(sale.received_amount || 0));
  if (sale.payment_method === 'contra_entrega' && sale.delivery_cash_status === 'validado') return Number(sale.total || 0);
  return 0; // Historic mixed payments have no trustworthy cash breakdown.
}
module.exports = { calculate, cashFromSale };
