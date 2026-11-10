'use strict';
// ITBIS separado por tipo de documento (mejora 7): tickets internos y
// comprobantes no electrónicos, e-CF por estado real de la DGII y el
// consolidado. Cada venta cuenta una sola vez (por su documento); las notas
// de crédito y anulaciones del período restan como ajustes. La propina legal
// nunca entra en el ITBIS ni en la base gravada.
const M = require('../../js/pos-money');

const c = (v) => M.cents(v === null || v === undefined || v === '' ? 0 : Number(v).toFixed(2));
const n = (v) => M.number(v);
const fecha = (v) => (v instanceof Date ? v.toISOString().slice(0, 19).replace('T', ' ') : String(v || ''));
const ESTADOS_VALIDOS = new Set(['aceptado', 'aceptado_condicional']);
const ESTADOS_RECHAZO = new Set(['rechazado', 'error', 'error_validacion']);

function claseVenta(s) {
  if (s.document_type === 'factura-electronica') return 'ecf';
  if (s.document_type === 'comprobante-fiscal') return 'ncf';
  return 'ticket';
}
// Estado fiscal de un e-CF: lo que dijo la DGII (o lo que falta).
function estadoEcf(estado) {
  const e = String(estado || '').toLowerCase();
  if (ESTADOS_VALIDOS.has(e)) return 'aceptado';
  if (ESTADOS_RECHAZO.has(e)) return 'rechazado';
  if (e.includes('contingencia')) return 'contingencia';
  return 'pendiente';
}

// Base gravada y exenta de una venta, ya con descuentos, sin ITBIS ni propina.
function basesVenta(s, lineas) {
  const base = c(s.subtotal) - c(s.discount);
  let gravable = 0n, todas = 0n;
  for (const l of lineas) {
    const neto = c(Number(l.price || 0) * Number(l.qty || 0) * (1 - Number(l.discount_rate || 0) / 100));
    todas += neto;
    if (Number(l.tax_rate || 0) > 0 || Number(l.tax_amount || 0) > 0) gravable += neto;
  }
  let gravada;
  if (todas > 0n) gravada = M.divide(base * gravable, todas);
  else gravada = c(s.tax) > 0n ? base : 0n;
  if (gravada > base) gravada = base;
  return { base, gravada, exenta: base - gravada };
}

function vacio() {
  return { operaciones: 0, total: 0n, gravada: 0n, exenta: 0n, itbis: 0n, descuentos: 0n, propina: 0n, redondeo: 0n,
    ajustes: { cantidad: 0, base: 0n, itbis: 0n, propina: 0n, total: 0n } };
}
function sumar(acc, v) {
  acc.operaciones += 1; acc.total += v.total; acc.gravada += v.gravada; acc.exenta += v.exenta; acc.itbis += v.itbis;
  acc.descuentos += v.descuento; acc.propina += v.propina; acc.redondeo += v.redondeo;
}
function sumarAjuste(acc, a) {
  acc.ajustes.cantidad += 1; acc.ajustes.base += a.base; acc.ajustes.itbis += a.itbis; acc.ajustes.propina += a.propina; acc.ajustes.total += a.total;
}
function salida(acc) {
  return {
    operaciones: acc.operaciones, total: n(acc.total), gravada: n(acc.gravada), exenta: n(acc.exenta), itbis: n(acc.itbis),
    descuentos: n(acc.descuentos), propinaLegal: n(acc.propina), redondeo: n(acc.redondeo),
    ajustes: { cantidad: acc.ajustes.cantidad, base: n(acc.ajustes.base), itbis: n(acc.ajustes.itbis), propinaLegal: n(acc.ajustes.propina), total: n(acc.ajustes.total) },
    itbisNeto: n(acc.itbis - acc.ajustes.itbis), totalNeto: n(acc.total - acc.ajustes.total),
  };
}

async function enLotes(ids, consulta) {
  const out = [];
  for (let i = 0; i < ids.length; i += 400) {
    const lote = ids.slice(i, i + 400);
    out.push(...await consulta(lote, lote.map(() => '?').join(',')));
  }
  return out;
}

async function generar(run, { desdeDatetime, hastaDatetime, branchId = null, cashRegisterId = null, userId = null, obligadoEcf = false }) {
  const filtros = [], params = [desdeDatetime, hastaDatetime];
  if (branchId) { filtros.push('COALESCE(s.billed_branch_id, s.branch_id) = ?'); params.push(branchId); }
  if (cashRegisterId) { filtros.push('s.cash_register_id = ?'); params.push(cashRegisterId); }
  if (userId) { filtros.push('s.user_id = ?'); params.push(userId); }
  const extra = filtros.length ? ` AND ${filtros.join(' AND ')}` : '';
  const columnas = `s.id, s.invoice_number, s.ncf, s.document_type, s.created_at, s.subtotal, s.discount, s.tax, s.total, s.legal_tip_amount,
    s.fiscal_status, s.sale_status, s.canceled_at, s.cancel_reason, s.cancel_refund_mode, s.ecf_estado, s.user_id, u.nombre AS cajero`;

  const ventas = await run(
    `SELECT ${columnas} FROM sales s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.created_at BETWEEN ? AND ? AND COALESCE(s.sale_status, 'pagada') IN ('pagada', 'devuelta')${extra}
      ORDER BY s.created_at, s.id`, params);
  const devoluciones = await run(
    `SELECT r.id AS return_id, r.returned_at, r.returned_amount, r.tax_returned, r.legal_tip_returned, r.adjustment_kind, r.fiscal_document, r.return_type, r.tax_affects,
            ${columnas}
       FROM sale_returns r JOIN sales s ON s.id = r.original_sale_id LEFT JOIN users u ON u.id = s.user_id
      WHERE r.returned_at BETWEEN ? AND ?${extra} ORDER BY r.returned_at, r.id`, params).catch(() => []);
  const anuladas = await run(
    `SELECT ${columnas} FROM sales s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.fiscal_status = 'cancelada' AND s.canceled_at BETWEEN ? AND ? AND COALESCE(s.sale_status, 'pagada') IN ('pagada', 'devuelta')
        AND NOT EXISTS (SELECT 1 FROM sale_returns r WHERE r.original_sale_id = s.id)${extra}
      ORDER BY s.canceled_at, s.id`, params);

  const ids = [...new Set([...ventas, ...devoluciones, ...anuladas].map((s) => Number(s.id)))];
  const lineas = ids.length ? await enLotes(ids, (lote, ph) => run(`SELECT sale_id, qty, price, discount_rate, tax_rate, tax_amount FROM sale_items WHERE sale_id IN (${ph})`, lote)) : [];
  const ecfRows = ids.length ? await enLotes(ids, (lote, ph) => run(
    `SELECT id, sale_id, tipo_ecf, estado_dgii, encf FROM ecf_documents WHERE sale_id IN (${ph}) AND tipo_ecf NOT IN ('E33', 'E34') ORDER BY id`, lote)).catch(() => []) : [];
  const lineasPor = new Map(), ecfPor = new Map();
  for (const l of lineas) { const k = Number(l.sale_id); if (!lineasPor.has(k)) lineasPor.set(k, []); lineasPor.get(k).push(l); }
  for (const e of ecfRows) ecfPor.set(Number(e.sale_id), e); // el último por id

  const info = (s) => {
    const clase = claseVenta(s);
    const doc = ecfPor.get(Number(s.id));
    const estado = clase === 'ecf' ? estadoEcf(doc?.estado_dgii || s.ecf_estado) : (clase === 'ncf' ? 'emitido' : 'sin_ecf');
    const b = basesVenta(s, lineasPor.get(Number(s.id)) || []);
    const total = c(s.total), itbis = c(s.tax), propina = c(s.legal_tip_amount);
    return { clase, estado, encf: doc?.encf || s.ncf || '', total, itbis, propina, descuento: c(s.discount), ...b, redondeo: total - (b.base + itbis + propina) };
  };

  const acc = { ticket: vacio(), ncf: vacio(), ecf: vacio(), ecfPendiente: vacio(), ecfRechazado: vacio(), ecfContingencia: vacio() };
  const detalle = [];
  for (const s of ventas) {
    const v = info(s);
    if (v.clase === 'ecf') {
      if (v.estado === 'rechazado') sumar(acc.ecfRechazado, v);
      else {
        sumar(acc.ecf, v);
        if (v.estado === 'pendiente') sumar(acc.ecfPendiente, v);
        if (v.estado === 'contingencia') sumar(acc.ecfContingencia, v);
      }
    } else sumar(acc[v.clase], v);
    detalle.push({ saleId: Number(s.id), fecha: fecha(s.created_at), factura: s.invoice_number, documento: v.encf || s.invoice_number, clase: v.clase,
      estado: String(s.fiscal_status || '') === 'cancelada' ? `${v.estado} · cancelada` : v.estado, cajero: s.cajero || '',
      total: n(v.total), gravada: n(v.gravada), exenta: n(v.exenta), itbis: n(v.itbis), propinaLegal: n(v.propina), descuento: n(v.descuento) });
  }

  const ajustesDetalle = [];
  for (const r of devoluciones) {
    const v = info(r);
    if (v.clase === 'ecf' && v.estado === 'rechazado') continue; // nunca fue documento válido
    const monto = c(r.returned_amount);
    let itbis, propina, base;
    if (r.adjustment_kind) {
      itbis = c(r.tax_returned); propina = c(r.legal_tip_returned); base = monto - itbis - propina;
      // Nota emitida pasados 30 días: rebaja el monto pero no el ITBIS.
      if (Number(r.tax_affects ?? 1) === 0) { base += itbis; itbis = 0n; }
    }
    else {
      // Devoluciones anteriores a esta versión: el monto era sin ITBIS.
      base = monto; propina = 0n;
      itbis = v.base > 0n ? M.divide(v.itbis * monto, v.base) : 0n;
    }
    const a = { base, itbis, propina, total: base + itbis + propina };
    sumarAjuste(acc[v.clase === 'ecf' ? 'ecf' : v.clase], a);
    ajustesDetalle.push({ tipo: r.adjustment_kind || (r.return_type === 'total' ? 'devolucion_total' : 'devolucion_parcial'), fecha: fecha(r.returned_at), factura: r.invoice_number,
      documento: r.fiscal_document || '', clase: v.clase, base: n(base), itbis: n(itbis), propinaLegal: n(propina), total: n(a.total) });
  }
  for (const s of anuladas) {
    const v = info(s);
    if (v.clase === 'ecf' && v.estado === 'rechazado') continue;
    const a = { base: v.base, itbis: v.itbis, propina: v.propina, total: v.total };
    sumarAjuste(acc[v.clase], a);
    ajustesDetalle.push({ tipo: 'anulacion', fecha: fecha(s.canceled_at), factura: s.invoice_number, documento: v.encf || '', clase: v.clase,
      base: n(v.base), itbis: n(v.itbis), propinaLegal: n(v.propina), total: n(v.total) });
  }

  // Tickets internos y comprobantes tradicionales serie B: lo no electrónico.
  const noElectronico = vacio();
  for (const k of ['ticket', 'ncf']) {
    const a = acc[k];
    noElectronico.operaciones += a.operaciones; noElectronico.total += a.total; noElectronico.gravada += a.gravada; noElectronico.exenta += a.exenta;
    noElectronico.itbis += a.itbis; noElectronico.descuentos += a.descuentos; noElectronico.propina += a.propina; noElectronico.redondeo += a.redondeo;
    for (const f of ['base', 'itbis', 'propina', 'total']) noElectronico.ajustes[f] += a.ajustes[f];
    noElectronico.ajustes.cantidad += a.ajustes.cantidad;
  }
  const consolidado = vacio();
  for (const a of [noElectronico, acc.ecf]) {
    consolidado.operaciones += a.operaciones; consolidado.total += a.total; consolidado.gravada += a.gravada; consolidado.exenta += a.exenta;
    consolidado.itbis += a.itbis; consolidado.descuentos += a.descuentos; consolidado.propina += a.propina; consolidado.redondeo += a.redondeo;
    for (const f of ['base', 'itbis', 'propina', 'total']) consolidado.ajustes[f] += a.ajustes[f];
    consolidado.ajustes.cantidad += a.ajustes.cantidad;
  }

  const ticketsSinEcf = acc.ticket.operaciones;
  return {
    tickets: { ...salida(noElectronico), ticketsInternos: salida(acc.ticket), comprobantesSerieB: salida(acc.ncf),
      nota: 'Tickets internos sin e-CF: no son comprobantes emitidos ni aceptados por la DGII.' },
    ecf: { ...salida(acc.ecf), pendientes: salida(acc.ecfPendiente), contingencia: salida(acc.ecfContingencia), rechazados: salida(acc.ecfRechazado),
      nota: 'ITBIS facturado = e-CF aceptados y pendientes de respuesta. Los rechazados se muestran aparte y no se suman como documentos válidos.' },
    consolidado: { ...salida(consolidado), rechazadosExcluidos: salida(acc.ecfRechazado),
      nota: 'Cada venta se cuenta una sola vez según su documento. La propina legal no forma parte del ITBIS.' },
    regularizacion: {
      obligadoEcf: Boolean(obligadoEcf), ticketsSinEcf, montoTicketsSinEcf: n(acc.ticket.total), itbisTicketsSinEcf: n(acc.ticket.itbis),
      aviso: obligadoEcf && ticketsSinEcf
        ? `Hay ${ticketsSinEcf} venta(s) final(es) registradas como ticket interno sin e-CF. Este reporte no sustituye la emisión ni la declaración: consulta a tu contador el procedimiento para emitirlas o regularizarlas.`
        : '',
    },
    detalle, ajustesDetalle,
  };
}

module.exports = { generar, basesVenta, estadoEcf, claseVenta };
