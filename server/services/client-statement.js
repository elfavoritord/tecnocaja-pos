'use strict';
// Estado de cuenta de un cliente: libro cronológico de cargos (facturas a
// crédito) y abonos (pagos, notas de crédito, cancelaciones) con el saldo
// después de cada movimiento. Todo en centavos; la pantalla, el PDF y lo que
// se comparte salen de este mismo cálculo.
const M = require('../../js/pos-money');
function timestamp(value) { return value instanceof Date ? value.toISOString().slice(0, 19).replace('T', ' ') : String(value || ''); }
function hoyRD() {
  return new Date(Date.now() - 4 * 3600000).toISOString().slice(0, 10); // RD = UTC−4
}
function diasEntre(desde, hasta) {
  const a = Date.parse(`${desde}T00:00:00Z`), b = Date.parse(`${hasta}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86400000) : 0;
}
function build({ client, sales = [], payments = [], returns = [], from = '', to = '', today = hoyRD() }) {
  const events = [];
  const add = (id, date, type, reference, debit, credit, extra = {}) => events.push({ id, date: timestamp(date), type, reference, debit: M.number(debit), credit: M.number(credit), ...extra });
  const facturas = new Map();
  for (const sale of sales) {
    const allocations = payments.filter(p => Number(p.sale_id) === Number(sale.id));
    const paidLater = allocations.reduce((n, p) => n + M.cents(p.applied_amount), 0n);
    const principal = Number(sale.financial_version) > 0 ? M.cents(sale.credit_amount || 0)
      : M.cents(sale.total || 0) - M.cents(sale.received_amount || 0) + paidLater;
    if (principal <= 0n) continue;
    const ref = sale.ncf || sale.invoice_number;
    const due = sale.credit_due_date ? timestamp(sale.credit_due_date).slice(0, 10) : null;
    add(`sale-${sale.id}`, sale.created_at, 'Factura a crédito', ref, principal, 0n, { saleId: sale.id, dueDate: due, invoice: sale.invoice_number });
    let pendiente = principal - paidLater;
    const notas = returns.filter(r => Number(r.original_sale_id) === Number(sale.id)).reduce((n, r) => n + M.cents(r.credit_reduction || 0), 0n);
    pendiente -= notas;
    if (sale.fiscal_status === 'cancelada') {
      const remaining = M.cents(sale.total || 0) - M.cents(sale.received_amount || 0) - M.cents(sale.credit_adjustment || 0);
      if (remaining > 0n) { add(`cancel-${sale.id}`, sale.canceled_at || sale.created_at, 'Cancelación de saldo', ref, 0n, remaining, { saleId: sale.id }); pendiente -= remaining; }
    }
    if (pendiente < 0n) pendiente = 0n;
    const vencida = pendiente > 0n && due && due < today;
    facturas.set(Number(sale.id), {
      saleId: Number(sale.id), factura: sale.invoice_number, documento: ref, fecha: timestamp(sale.created_at), vence: due,
      cargo: M.number(principal), pendiente: M.number(pendiente),
      estado: sale.fiscal_status === 'cancelada' ? 'cancelada' : (pendiente === 0n ? 'pagada' : (vencida ? 'vencida' : 'abierta')),
      diasAtraso: vencida ? diasEntre(due, today) : 0,
    });
  }
  for (const p of payments) add(`payment-${p.payment_id}-${p.sale_id}`, p.created_at, 'Abono · ' + p.payment_method, p.ncf || p.invoice_number, 0n, M.cents(p.applied_amount || 0), { saleId: p.sale_id, paymentId: p.payment_id });
  for (const r of returns) if (Number(r.credit_reduction) > 0) add(`return-${r.id}`, r.returned_at, 'Ajuste de crédito', r.fiscal_document || r.original_invoice_number, 0n, M.cents(r.credit_reduction), { saleId: r.original_sale_id, returnId: r.id });
  events.sort((a,b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  let running = sales.length ? 0n : M.cents(client.balance || 0), opening = running;
  const legacyOpening = M.number(running), rows = [];
  for (const e of events) {
    running += M.cents(e.debit) - M.cents(e.credit);
    const f = e.saleId ? facturas.get(Number(e.saleId)) : null;
    const extra = f ? { status: e.id.startsWith('sale-') ? f.estado : 'aplicado', overdueDays: e.id.startsWith('sale-') ? f.diasAtraso : 0 } : { status: 'aplicado', overdueDays: 0 };
    if (from && e.date.slice(0,10) < from) opening = running;
    else if (!to || e.date.slice(0,10) <= to) rows.push({ ...e, ...extra, balance: M.number(running) });
  }
  const closing = rows.length ? rows[rows.length - 1].balance : M.number(opening);
  const current = Number(client.balance || 0);
  const lista = [...facturas.values()];
  const vigente = lista.filter(f => f.estado === 'abierta').reduce((n, f) => n + M.cents(f.pendiente), 0n);
  const vencida = lista.filter(f => f.estado === 'vencida').reduce((n, f) => n + M.cents(f.pendiente), 0n);
  const limite = Number(client.limiteCredito || client.limite_credito || 0);
  return { client, from, to, fechaCorte: today, openingBalance: M.number(opening), closingBalance: closing, currentBalance: current,
    deudaVigente: M.number(vigente), deudaVencida: M.number(vencida), limiteCredito: limite, sinLimite: !(limite > 0),
    disponible: limite > 0 ? Math.max(0, M.number(M.cents(limite) - M.cents(current))) : null,
    facturas: lista, legacyOpening, rows, reconciliationDifference: M.number(M.cents(current) - running) };
}
module.exports = { build, hoyRD };
