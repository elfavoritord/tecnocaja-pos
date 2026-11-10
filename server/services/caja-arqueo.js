'use strict';
// Cierre seguro y arqueos (mejora 8). Todo el cálculo sale de la base de datos,
// en centavos enteros, para que la pantalla, la impresión y el PDF del cierre
// muestren exactamente lo mismo. Nunca usa lo que calculó el navegador.
const M = require('../../js/pos-money');

// Billetes y monedas dominicanos en circulación.
const DENOMINACIONES = Object.freeze([
  { valor: 2000, tipo: 'billete' }, { valor: 1000, tipo: 'billete' }, { valor: 500, tipo: 'billete' },
  { valor: 200, tipo: 'billete' }, { valor: 100, tipo: 'billete' }, { valor: 50, tipo: 'billete' },
  { valor: 20, tipo: 'billete' }, { valor: 25, tipo: 'moneda' }, { valor: 10, tipo: 'moneda' },
  { valor: 5, tipo: 'moneda' }, { valor: 1, tipo: 'moneda' },
]);

// Movimientos que el resumen NO toma de cash_movements porque ya los cuenta
// desde su tabla de origen (ventas, abonos) o porque no mueven dinero.
const MOVIMIENTOS_YA_CONTADOS = new Set(['Apertura', 'Cierre', 'Venta', 'Cobro factura pendiente', 'Cobro crédito cliente', 'Gaveta abierta']);
// Anticipos de reservas de mesas en efectivo (server/services/mesas-anticipos.js).
const MOV_ANTICIPO = 'Anticipo de reserva';
const MOV_ANTICIPO_DEVUELTO = 'Devolución anticipo de reserva';

function httpError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// { "2000": 3, "25": 4 } o [{ valor: 2000, cantidad: 3 }] → líneas y total.
function contarDenominaciones(entrada) {
  const pares = Array.isArray(entrada)
    ? entrada.map((e) => [String(e?.valor), e?.cantidad])
    : Object.entries(entrada && typeof entrada === 'object' ? entrada : {});
  const cantidades = new Map();
  for (const [clave, cantidad] of pares) {
    if (!DENOMINACIONES.some((d) => String(d.valor) === clave)) throw httpError(`Denominación no válida: ${clave}.`);
    cantidades.set(clave, cantidad);
  }
  let total = 0n;
  const lineas = DENOMINACIONES.map((d) => {
    const raw = cantidades.get(String(d.valor));
    const cantidad = raw === undefined || raw === null || raw === '' ? 0 : Number(raw);
    if (!Number.isSafeInteger(cantidad) || cantidad < 0 || cantidad > 1000000) {
      throw httpError(`Cantidad no válida para ${d.tipo} de RD$${d.valor}. Usa unidades enteras.`);
    }
    const subtotal = BigInt(d.valor) * 100n * BigInt(cantidad);
    total += subtotal;
    return { valor: d.valor, tipo: d.tipo, cantidad, subtotal: M.number(subtotal) };
  });
  return { lineas, total: M.number(total) };
}

const c = (v) => M.cents(v === null || v === undefined || v === '' ? 0 : Number(v).toFixed(2));
const n = (v) => M.number(v);
const parseJson = (value, fallback) => { try { return value ? JSON.parse(value) : fallback; } catch (_) { return fallback; } };
const fecha = (v) => (v instanceof Date ? v.toISOString().slice(0, 19).replace('T', ' ') : String(v || ''));

// ¿La venta trae dinero a este turno? Una cancelación vieja (sin modo de
// reembolso) ya no cuenta, como antes; una nueva sigue contando porque su
// reembolso, si lo hubo, está en su propio movimiento de caja.
function ventaCuenta(s) {
  if (!['pagada', 'devuelta'].includes(String(s.sale_status || 'pagada'))) return false;
  if (String(s.fiscal_status || '') === 'cancelada' && !s.cancel_refund_mode) return false;
  return true;
}

// Reparte una venta en sus componentes de cobro. Ventas nuevas: columnas
// exactas. Ventas viejas: por su método (un mixto viejo no tiene desglose).
function componentesVenta(s, sessionId) {
  const total = c(s.total);
  const method = String(s.payment_method || '');
  const out = { cash: 0n, card: 0n, transfer: 0n, credit: 0n, usd: 0, mixtoSinDesglose: 0n, contraEntregaPendiente: 0n };
  if (method === 'contra_entrega') {
    const validado = String(s.delivery_cash_status || '') === 'validado';
    const turnoCobro = Number(s.delivery_cash_session_id || 0) || Number(s.cash_session_id || 0);
    if (validado && turnoCobro === Number(sessionId)) out.cash = total;
    else if (!validado && Number(s.cash_session_id) === Number(sessionId)) out.contraEntregaPendiente = total;
    return out;
  }
  if (Number(s.cash_session_id) !== Number(sessionId)) return out;
  if (method === 'usd') { out.usd = Number(s.usd_amount_received || 0); return out; }
  if (Number(s.financial_version || 0) > 0) {
    out.cash = c(s.cash_amount); out.card = c(s.card_amount); out.transfer = c(s.transfer_amount); out.credit = c(s.credit_amount);
    return out;
  }
  if (method === 'efectivo') out.cash = total;
  else if (method === 'tarjeta') out.card = total;
  else if (method === 'transferencia') out.transfer = total;
  else if (method === 'credito') {
    const recibido = c(s.received_amount);
    out.cash = recibido > total ? total : recibido;
    out.credit = total - out.cash;
  } else if (method === 'mixto') out.mixtoSinDesglose = total;
  return out;
}

function clasificarMovimiento(tipo, monto) {
  if (monto > 0n) return 'entradas';
  const t = String(tipo || '').toLowerCase();
  if (t.includes('retiro')) return 'retiros';
  if (t.includes('devoluci') || t.includes('cancelaci')) return 'devoluciones';
  if (t.includes('suplidor')) return 'pagosSuplidor';
  if (t.includes('gasto') || t.includes('egreso')) return 'gastos';
  return 'otrasSalidas';
}

// Resumen completo de un turno. `run(sql, params)` puede ser la conexión de la
// transacción del cierre (así lo que se guarda es lo que se calculó ahí).
async function resumenTurno(run, sessionId) {
  const [session] = await run('SELECT * FROM cash_sessions WHERE id = ? LIMIT 1', [sessionId]);
  if (!session) throw httpError('Turno de caja no encontrado.', 404);
  const sid = Number(session.id);

  const sales = await run(
    `SELECT s.id, s.invoice_number, s.ncf, s.document_type, s.created_at, s.subtotal, s.discount, s.tax, s.total,
            s.payment_method, s.sale_status, s.fiscal_status, s.financial_version, s.cash_amount, s.card_amount,
            s.transfer_amount, s.credit_amount, s.received_amount, s.change_amount, s.legal_tip_amount, s.payment_details,
            s.client_id, s.client_name_snapshot, s.credit_due_date, s.delivery_cash_status, s.delivery_cash_session_id,
            s.cash_session_id, s.cancel_refund_mode, s.usd_amount_received, s.card_status, s.transfer_status, s.user_id,
            u.nombre AS cashier_name
       FROM sales s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.cash_session_id = ? OR s.delivery_cash_session_id = ?
      ORDER BY s.created_at, s.id`,
    [sid, sid]
  );
  const abonos = await run(
    `SELECT p.id, p.client_id, p.amount, p.payment_method, p.created_at, c.nombre AS client_name
       FROM client_credit_payments p LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.cash_session_id = ? ORDER BY p.created_at, p.id`,
    [sid]
  ).catch(() => []);
  const movimientos = await run(
    `SELECT id, movement_type, amount, notes, happened_at, created_by_user_name
       FROM cash_movements WHERE session_id = ? ORDER BY happened_at, id`,
    [sid]
  );
  const devoluciones = await run(
    `SELECT id, original_invoice_number, return_type, return_reason, returned_amount, returned_at, fiscal_document, adjustment_kind
       FROM sale_returns WHERE cash_session_id = ? ORDER BY returned_at, id`,
    [sid]
  ).catch(() => []);
  const arqueos = await run(
    `SELECT id, count_uuid, counted_amount, expected_amount, difference_amount, counted_by_user_name, created_at
       FROM cash_counts WHERE cash_session_id = ? AND kind = 'arqueo' ORDER BY created_at, id`,
    [sid]
  ).catch(() => []);
  const gaveta = await run(
    `SELECT reason, origin, COUNT(*) AS total FROM cash_drawer_events WHERE cash_session_id = ? GROUP BY reason, origin`,
    [sid]
  ).catch(() => []);
  // Anticipos de reservas de mesas (server/services/mesas-anticipos.js). El
  // efectivo ya viene de sus movimientos de caja; de aquí salen tarjeta,
  // transferencia y el detalle. Sin módulo de Mesas la tabla no existe: nada.
  const reservasAnticipo = await run(
    `SELECT id, cliente, fecha, hora, anticipo_monto, anticipo_metodo, anticipo_estado, anticipo_session_id, anticipo_aplicado,
            anticipo_aplicado_session_id, anticipo_factura, anticipo_resuelto_monto, anticipo_resuelto_metodo, anticipo_resuelto_session_id
       FROM mesas_reservas
      WHERE anticipo_session_id = ? OR anticipo_aplicado_session_id = ? OR anticipo_resuelto_session_id = ?`,
    [sid, sid, sid]
  ).catch(() => []);

  const acc = {
    ventasTotal: 0n, ventasPropias: 0n, itbis: 0n, descuentos: 0n, propina: 0n, propinaEfectivo: 0n,
    efectivoVentas: 0n, tarjeta: 0n, tarjetaReversada: 0n, transferencia: 0n, transferenciaPendiente: 0n,
    credito: 0n, mixtoSinDesglose: 0n, contraEntregaPendiente: 0n, usd: 0,
  };
  const facturas = { total: 0, ticket: 0, comprobanteFiscal: 0, electronica: 0, canceladas: 0 };
  const tarjetas = [], transferencias = [], creditos = [];

  for (const s of sales) {
    const creadaEnTurno = Number(s.cash_session_id) === sid;
    if (creadaEnTurno && String(s.fiscal_status || '') === 'cancelada') facturas.canceladas += 1;
    if (!ventaCuenta(s)) continue;
    const comp = componentesVenta(s, sid);
    const detalles = parseJson(s.payment_details, {});
    if (creadaEnTurno) {
      const total = c(s.total), tip = c(s.legal_tip_amount);
      acc.ventasTotal += total; acc.propina += tip; acc.ventasPropias += total - tip;
      acc.itbis += c(s.tax); acc.descuentos += c(s.discount);
      facturas.total += 1;
      if (s.document_type === 'factura-electronica') facturas.electronica += 1;
      else if (s.document_type === 'comprobante-fiscal') facturas.comprobanteFiscal += 1;
      else facturas.ticket += 1;
      // Propina recibida en efectivo: su parte proporcional del efectivo.
      if (tip > 0n && total > 0n && comp.cash > 0n) acc.propinaEfectivo += M.divide(tip * comp.cash, total);
    }
    acc.efectivoVentas += comp.cash; acc.credito += comp.credit; acc.usd += comp.usd;
    acc.mixtoSinDesglose += comp.mixtoSinDesglose; acc.contraEntregaPendiente += comp.contraEntregaPendiente;
    if (comp.card > 0n) {
      const estado = String(s.card_status || 'aprobada');
      if (estado === 'reversada') acc.tarjetaReversada += comp.card; else acc.tarjeta += comp.card;
      tarjetas.push({ factura: s.invoice_number, monto: n(comp.card), banco: detalles.cardBank || '', referencia: detalles.cardReference || '', tipo: detalles.cardType || '', estado });
    }
    if (comp.transfer > 0n) {
      const estado = String(s.transfer_status || 'pendiente');
      acc.transferencia += comp.transfer;
      if (estado !== 'confirmada') acc.transferenciaPendiente += comp.transfer;
      transferencias.push({ saleId: Number(s.id), factura: s.invoice_number, monto: n(comp.transfer), banco: detalles.transferBank || '', referencia: detalles.transferReference || '', estado });
    }
    if (comp.credit > 0n) {
      creditos.push({ saleId: Number(s.id), factura: s.invoice_number, clienteId: s.client_id ? Number(s.client_id) : null, cliente: s.client_name_snapshot || '', monto: n(comp.credit), vence: s.credit_due_date ? fecha(s.credit_due_date).slice(0, 10) : null });
    }
  }

  const abonosPor = { efectivo: 0n, tarjeta: 0n, transferencia: 0n, otro: 0n };
  for (const a of abonos) {
    const metodo = ['efectivo', 'tarjeta', 'transferencia'].includes(a.payment_method) ? a.payment_method : 'otro';
    abonosPor[metodo] += c(a.amount);
  }

  const mov = { entradas: 0n, gastos: 0n, pagosSuplidor: 0n, devoluciones: 0n, retiros: 0n, otrasSalidas: 0n, anticipos: 0n, anticiposDevueltos: 0n };
  const movimientosLista = [];
  for (const m of movimientos) {
    if (MOVIMIENTOS_YA_CONTADOS.has(m.movement_type)) continue;
    const monto = c(m.amount);
    if (monto === 0n) continue;
    const grupo = m.movement_type === MOV_ANTICIPO ? 'anticipos'
      : (m.movement_type === MOV_ANTICIPO_DEVUELTO ? 'anticiposDevueltos' : clasificarMovimiento(m.movement_type, monto));
    mov[grupo] += monto < 0n ? -monto : monto;
    movimientosLista.push({ id: Number(m.id), tipo: m.movement_type, monto: n(monto), notas: m.notes || '', fecha: fecha(m.happened_at), usuario: m.created_by_user_name || '' });
  }

  // Anticipos de reservas: recibidos, descontados en facturas, devueltos y los
  // que quedaron al negocio en este turno.
  const ant = { tarjeta: 0n, transferencia: 0n, efectivo: 0n, aplicados: 0n, devueltosTarjeta: 0n, devueltosTransferencia: 0n, retenidos: 0n };
  const anticiposDetalle = [];
  for (const r of reservasAnticipo) {
    const base = { cliente: r.cliente || '', reserva: `${r.fecha || ''} ${r.hora || ''}`.trim() };
    if (Number(r.anticipo_session_id) === sid && r.anticipo_estado) {
      const metodo = ['efectivo', 'tarjeta', 'transferencia'].includes(r.anticipo_metodo) ? r.anticipo_metodo : 'efectivo';
      ant[metodo] += c(r.anticipo_monto);
      anticiposDetalle.push({ ...base, tipo: 'recibido', metodo, monto: n(c(r.anticipo_monto)) });
    }
    if (Number(r.anticipo_aplicado_session_id) === sid && c(r.anticipo_aplicado) > 0n) {
      ant.aplicados += c(r.anticipo_aplicado);
      anticiposDetalle.push({ ...base, tipo: 'aplicado', factura: r.anticipo_factura || '', monto: n(c(r.anticipo_aplicado)) });
    }
    if (Number(r.anticipo_resuelto_session_id) === sid && ['devuelto', 'retenido'].includes(r.anticipo_estado)) {
      const monto = c(r.anticipo_resuelto_monto);
      if (r.anticipo_estado === 'retenido') ant.retenidos += monto;
      else if (r.anticipo_resuelto_metodo === 'tarjeta') ant.devueltosTarjeta += monto;
      else if (r.anticipo_resuelto_metodo === 'transferencia') ant.devueltosTransferencia += monto;
      anticiposDetalle.push({ ...base, tipo: r.anticipo_estado, metodo: r.anticipo_resuelto_metodo || '', monto: n(monto) });
    }
  }

  const apertura = c(session.opened_amount);
  const esperado = apertura + acc.efectivoVentas + abonosPor.efectivo + mov.entradas + mov.anticipos
    - mov.gastos - mov.pagosSuplidor - mov.devoluciones - mov.retiros - mov.otrasSalidas - mov.anticiposDevueltos;
  // Tarjeta y transferencia: lo cobrado en el turno, con los anticipos que se
  // pagaron así (y sin los que se devolvieron por la misma vía).
  const cobradoTarjeta = acc.tarjeta + abonosPor.tarjeta + ant.tarjeta - ant.devueltosTarjeta;
  const cobradoTransferencia = acc.transferencia + abonosPor.transferencia + ant.transferencia - ant.devueltosTransferencia;
  const cobradoEfectivo = acc.efectivoVentas + abonosPor.efectivo + mov.anticipos - mov.anticiposDevueltos;

  const avisos = [];
  if (acc.mixtoSinDesglose > 0n) avisos.push(`Hay pagos mixtos anteriores a esta versión sin desglose por método (${n(acc.mixtoSinDesglose).toFixed(2)}). No se suman al efectivo esperado.`);
  if (acc.transferenciaPendiente > 0n) avisos.push('Hay transferencias pendientes de confirmar con el banco. Una captura de pantalla no confirma el depósito.');
  if (acc.tarjetaReversada > 0n) avisos.push('Hay pagos con tarjeta reversados: no cuentan como cobrados.');
  if (acc.contraEntregaPendiente > 0n) avisos.push('Hay pedidos contra entrega sin validar en este turno.');

  return {
    turno: {
      id: sid, estado: session.status, apertura: fecha(session.opened_at), cierre: session.closed_at ? fecha(session.closed_at) : null,
      fechaOperativa: session.operative_date ? fecha(session.operative_date).slice(0, 10) : null,
      abiertoPor: session.opened_by_user_name || '', cerradoPor: session.closed_by_user_name || '',
      branchId: session.branch_id ? Number(session.branch_id) : null, cashRegisterId: session.cash_register_id ? Number(session.cash_register_id) : null,
    },
    ventas: {
      total: n(acc.ventasTotal), propias: n(acc.ventasPropias), itbis: n(acc.itbis), descuentos: n(acc.descuentos),
      propinaLegal: n(acc.propina), facturas,
    },
    efectivo: {
      apertura: n(apertura), ventas: n(acc.efectivoVentas), abonos: n(abonosPor.efectivo), entradas: n(mov.entradas),
      gastos: n(mov.gastos), pagosSuplidor: n(mov.pagosSuplidor), devoluciones: n(mov.devoluciones), retiros: n(mov.retiros),
      otrasSalidas: n(mov.otrasSalidas), propinaEnEfectivo: n(acc.propinaEfectivo), esperado: n(esperado),
      anticipos: n(mov.anticipos), anticiposDevueltos: n(mov.anticiposDevueltos),
    },
    tarjeta: { ventas: n(acc.tarjeta), abonos: n(abonosPor.tarjeta), anticipos: n(ant.tarjeta - ant.devueltosTarjeta), cobrado: n(cobradoTarjeta), reversado: n(acc.tarjetaReversada), detalle: tarjetas },
    transferencia: { ventas: n(acc.transferencia), abonos: n(abonosPor.transferencia), anticipos: n(ant.transferencia - ant.devueltosTransferencia), cobrado: n(cobradoTransferencia), pendienteConfirmar: n(acc.transferenciaPendiente), detalle: transferencias },
    // Anticipos de reservas del turno. "aplicados": ya pagados antes, descontados
    // en facturas de este turno (por eso lo cobrado puede ser menor que lo vendido).
    anticipos: {
      recibidos: { efectivo: n(mov.anticipos), tarjeta: n(ant.tarjeta), transferencia: n(ant.transferencia), total: n(mov.anticipos + ant.tarjeta + ant.transferencia) },
      aplicados: n(ant.aplicados),
      devueltos: { efectivo: n(mov.anticiposDevueltos), tarjeta: n(ant.devueltosTarjeta), transferencia: n(ant.devueltosTransferencia), total: n(mov.anticiposDevueltos + ant.devueltosTarjeta + ant.devueltosTransferencia) },
      retenidos: n(ant.retenidos),
      detalle: anticiposDetalle,
    },
    credito: { pendienteNuevo: n(acc.credito), detalle: creditos },
    cobrado: { efectivo: n(cobradoEfectivo), tarjeta: n(cobradoTarjeta), transferencia: n(cobradoTransferencia), total: n(cobradoEfectivo + cobradoTarjeta + cobradoTransferencia) },
    usdRecibido: acc.usd,
    mixtoSinDesglose: n(acc.mixtoSinDesglose),
    contraEntregaPendiente: n(acc.contraEntregaPendiente),
    abonos: abonos.map((a) => ({ id: Number(a.id), cliente: a.client_name || '', metodo: a.payment_method, monto: n(c(a.amount)), fecha: fecha(a.created_at) })),
    movimientos: movimientosLista,
    devoluciones: devoluciones.map((d) => ({ id: Number(d.id), factura: d.original_invoice_number, tipo: d.return_type, motivo: d.return_reason || '', monto: Number(d.returned_amount || 0), fecha: fecha(d.returned_at), documento: d.fiscal_document || '' })),
    arqueos: arqueos.map((a) => ({ id: Number(a.id), contado: Number(a.counted_amount || 0), esperado: a.expected_amount === null ? null : Number(a.expected_amount), diferencia: a.difference_amount === null ? null : Number(a.difference_amount), usuario: a.counted_by_user_name || '', fecha: fecha(a.created_at) })),
    gaveta: gaveta.map((g) => ({ motivo: g.reason, origen: g.origin, veces: Number(g.total || 0) })),
    avisos,
  };
}

// Compara lo contado con lo esperado. Diferencia positiva = sobrante.
function compararConteo(contado, esperado) {
  const diferencia = c(contado) - c(esperado);
  return { contado: n(c(contado)), esperado: n(c(esperado)), diferencia: n(diferencia), estado: diferencia === 0n ? 'cuadrada' : (diferencia > 0n ? 'sobrante' : 'faltante') };
}

module.exports = { DENOMINACIONES, contarDenominaciones, resumenTurno, compararConteo, componentesVenta, ventaCuenta };
