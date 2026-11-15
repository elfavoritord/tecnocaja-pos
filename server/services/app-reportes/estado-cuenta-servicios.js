'use strict';

/**
 * Estado de cuenta de un cliente de la Empresa de Servicios.
 *
 * Sus facturas viven en svc_invoices y sus cobros en svc_invoice_payments (no en
 * los créditos del POS), así que aquí se pasan a la forma que espera
 * server/services/client-statement.js: cada factura es un cargo por su total y
 * cada cobro un abono aplicado a ella. El cálculo y el PDF son los mismos.
 * Solo se usa si el negocio es Empresa de Servicios: los negocios con POS siguen
 * con /api/clients/:id/statement.
 */

const statement = require('../client-statement');
const M = require('../../../js/pos-money');

function fechaTexto(valor) {
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${valor.getFullYear()}-${p(valor.getMonth() + 1)}-${p(valor.getDate())} ${p(valor.getHours())}:${p(valor.getMinutes())}:${p(valor.getSeconds())}`;
  }
  return String(valor || '').replace('T', ' ').slice(0, 19);
}

// La fecha del documento (DATE) con la hora en que se registró, para que el
// orden dentro del mismo día sea el real.
function fechaConHora(fecha, creado) {
  const dia = fechaTexto(fecha).slice(0, 10);
  const hora = fechaTexto(creado).slice(11, 19) || '00:00:00';
  return dia ? `${dia} ${hora}` : fechaTexto(creado);
}

async function estadoCuentaServicios({ query, mapClientRow, clientId, from = '', to = '' }) {
  if ([from, to].some((d) => d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) || (from && to && from > to)) {
    throw Object.assign(new Error('Período no válido.'), { statusCode: 400 });
  }
  const [cliente] = await query('SELECT * FROM clients WHERE id = ? LIMIT 1', [clientId]);
  if (!cliente) throw Object.assign(new Error('Cliente no encontrado.'), { statusCode: 404 });
  const facturas = await query(
    `SELECT id, numero, ncf, fecha, vencimiento, total, balance, estado, anulada_at, created_at
     FROM svc_invoices WHERE client_id = ? ORDER BY fecha, id`, [clientId]
  );
  const pagos = await query(
    `SELECT p.id, p.invoice_id, p.monto, p.metodo, p.fecha, p.created_at, i.numero, i.ncf
     FROM svc_invoice_payments p INNER JOIN svc_invoices i ON i.id = p.invoice_id
     WHERE i.client_id = ? AND p.anulado_at IS NULL`, [clientId]
  );
  const pagadoPorFactura = new Map();
  for (const p of pagos) pagadoPorFactura.set(Number(p.invoice_id), (pagadoPorFactura.get(Number(p.invoice_id)) || 0n) + M.cents(p.monto || 0));

  const sales = facturas.map((f) => {
    const anulada = String(f.estado || '') === 'anulada';
    return {
      id: Number(f.id), invoice_number: f.numero, ncf: f.ncf || '', created_at: fechaConHora(f.fecha, f.created_at),
      financial_version: 1, credit_amount: Number(f.total || 0), total: Number(f.total || 0), received_amount: 0,
      credit_due_date: f.vencimiento ? fechaTexto(f.vencimiento).slice(0, 10) : null,
      fiscal_status: anulada ? 'cancelada' : 'emitida',
      // Anulada: se cancela lo que quedaba (lo cobrado antes se queda como abono).
      credit_adjustment: anulada ? M.number(pagadoPorFactura.get(Number(f.id)) || 0n) : 0,
      canceled_at: f.anulada_at ? fechaTexto(f.anulada_at) : null,
    };
  });
  const payments = pagos.map((p) => ({
    sale_id: Number(p.invoice_id), payment_id: Number(p.id), applied_amount: Number(p.monto || 0),
    payment_method: p.metodo || 'efectivo', created_at: fechaConHora(p.fecha, p.created_at), invoice_number: p.numero, ncf: p.ncf || '',
  }));
  const saldo = facturas
    .filter((f) => String(f.estado || '') !== 'anulada')
    .reduce((n, f) => n + M.cents(f.balance || 0), 0n);
  const client = { ...mapClientRow(cliente), balance: M.number(saldo) };
  return statement.build({ client, sales, payments, returns: [], from, to });
}

module.exports = { estadoCuentaServicios };
