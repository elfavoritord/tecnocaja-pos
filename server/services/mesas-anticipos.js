'use strict';
// Anticipos de reservas de mesas (reglas en js/mesas-reservas.js).
// - Al recibirlo entra en el turno abierto de la caja: en efectivo con un
//   movimiento "Anticipo de reserva" (cuenta en el efectivo esperado); con
//   tarjeta o transferencia queda en el turno para el cuadre de ese método.
// - Consumible: al cobrar la cuenta de la reserva se descuenta de lo que paga el
//   cliente. La factura conserva su total (ITBIS y e-CF no cambian); el anticipo
//   es un pago hecho antes, por eso no vuelve a entrar en el efectivo.
// - Lo que no se usa se devuelve (en efectivo sale de la gaveta con
//   "Devolución anticipo de reserva") o queda al negocio, según su política.
const M = require('../../js/pos-money');
const R = require('../../js/mesas-reservas');

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const c = (v) => M.cents(Number(v || 0).toFixed(2));
const afectadas = (result) => Number(result?.affectedRows ?? result?.rowsAffected ?? 0);

const COLUMNAS = {
  anticipo_monto: 'DECIMAL(12,2) DEFAULT NULL',
  anticipo_metodo: 'VARCHAR(20) DEFAULT NULL',
  anticipo_referencia: 'VARCHAR(80) DEFAULT NULL',
  anticipo_consumible: 'INTEGER DEFAULT 0',
  anticipo_estado: 'VARCHAR(20) DEFAULT NULL',
  anticipo_session_id: 'INTEGER DEFAULT NULL',
  anticipo_cash_register_id: 'INTEGER DEFAULT NULL',
  anticipo_user_name: 'VARCHAR(120) DEFAULT NULL',
  anticipo_at: 'VARCHAR(40) DEFAULT NULL',
  anticipo_aplicado: 'DECIMAL(12,2) DEFAULT NULL',
  anticipo_sale_id: 'INTEGER DEFAULT NULL',
  anticipo_factura: 'VARCHAR(60) DEFAULT NULL',
  anticipo_aplicado_session_id: 'INTEGER DEFAULT NULL',
  anticipo_resuelto_monto: 'DECIMAL(12,2) DEFAULT NULL',
  anticipo_resuelto_metodo: 'VARCHAR(20) DEFAULT NULL',
  anticipo_resuelto_session_id: 'INTEGER DEFAULT NULL',
  anticipo_resuelto_por: 'VARCHAR(120) DEFAULT NULL',
  anticipo_resuelto_at: 'VARCHAR(40) DEFAULT NULL',
};

async function ensure(addColumnIfMissing) {
  for (const [columna, definicion] of Object.entries(COLUMNAS)) await addColumnIfMissing('mesas_reservas', columna, definicion);
}

// Fila de mesas_reservas → anticipo como lo usan la pantalla y las reglas (o null).
function deFila(r) {
  if (!r || !r.anticipo_estado) return null;
  const num = (v) => (v === null || v === undefined ? 0 : Number(v));
  return {
    monto: num(r.anticipo_monto), metodo: r.anticipo_metodo, referencia: r.anticipo_referencia || '',
    consumible: Boolean(Number(r.anticipo_consumible)), estado: r.anticipo_estado,
    aplicado: num(r.anticipo_aplicado), saleId: r.anticipo_sale_id ? Number(r.anticipo_sale_id) : null, factura: r.anticipo_factura || '',
    recibidoPor: r.anticipo_user_name || '', recibidoEn: r.anticipo_at || '',
    resueltoMonto: num(r.anticipo_resuelto_monto), resueltoMetodo: r.anticipo_resuelto_metodo || '',
    resueltoPor: r.anticipo_resuelto_por || '', resueltoEn: r.anticipo_resuelto_at || '',
  };
}

async function turnoAbierto(conn, cashRegisterId) {
  if (!cashRegisterId) return null;
  const rows = await conn.query("SELECT id FROM cash_sessions WHERE status = 'open' AND cash_register_id = ? ORDER BY id DESC LIMIT 1", [cashRegisterId]);
  return rows[0] || null;
}

const dos = (n) => String(n).padStart(2, '0');
// Hora local del negocio (en SQLite datetime('now') sería UTC).
function fechaLocalSql(d = new Date()) {
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())} ${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}`;
}

// Igual que un ingreso o una salida de caja: movimiento, turno y saldo general.
async function movimientoCaja(conn, { sessionId, tipo, monto, notas, actor, structure, fecha }) {
  await conn.query(
    `INSERT INTO cash_movements (session_id, movement_type, amount, notes, created_by_user_id, created_by_user_name, happened_at, branch_id, cash_register_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, tipo, monto, notas.slice(0, 250), actor.id || null, actor.nombre || 'Sistema', fecha || fechaLocalSql(), structure.branchId, structure.cashRegisterId]
  );
  await conn.query('UPDATE cash_sessions SET current_amount = current_amount + ? WHERE id = ?', [monto, sessionId]);
  await conn.query('UPDATE config SET cash_amount = cash_amount + ? WHERE id = 1', [monto]);
}

const notaReserva = (reserva, mesa) => `Reserva de ${reserva.cliente} · ${mesa} · ${reserva.fecha} ${reserva.hora}`;

// Registra el anticipo de una reserva que todavía no tiene. Dentro de la transacción.
async function recibir(conn, { reserva, anticipo, structure, actor, mesa, fecha = fechaLocalSql() }) {
  const turno = await turnoAbierto(conn, structure.cashRegisterId);
  if (!turno) throw fail('Abre la caja para recibir el anticipo: el dinero entra en el turno de esta caja.', 409);
  const result = await conn.query(
    `UPDATE mesas_reservas SET anticipo_monto = ?, anticipo_metodo = ?, anticipo_referencia = ?, anticipo_consumible = ?, anticipo_estado = 'recibido',
       anticipo_session_id = ?, anticipo_cash_register_id = ?, anticipo_user_name = ?, anticipo_at = ?, anticipo_aplicado = 0, updated_at = ?
     WHERE id = ? AND anticipo_estado IS NULL`,
    [anticipo.monto, anticipo.metodo, anticipo.referencia, anticipo.consumible ? 1 : 0, Number(turno.id), structure.cashRegisterId,
      String(actor.nombre || '').slice(0, 120), new Date().toISOString(), new Date().toISOString(), reserva.id]
  );
  if (afectadas(result) !== 1) throw fail('Esta reserva ya tiene un anticipo registrado.', 409);
  let movimiento = null;
  if (anticipo.metodo === 'efectivo') {
    movimiento = { tipo: 'Anticipo de reserva', monto: anticipo.monto, notas: notaReserva(reserva, mesa), fecha };
    await movimientoCaja(conn, { sessionId: Number(turno.id), ...movimiento, actor, structure });
  }
  return { sessionId: Number(turno.id), movimiento };
}

// Devolver o dejar al negocio lo que queda del anticipo.
// metodo: 'efectivo' (sale de la gaveta) u 'original' (por tarjeta o transferencia, fuera de la caja).
async function resolver(conn, { row, accion, metodo, structure, actor, mesa, fecha = fechaLocalSql() }) {
  if (!['devolver', 'retener'].includes(accion)) throw fail('Indica si el anticipo se devuelve o queda al negocio.');
  const anticipo = deFila(row);
  const saldo = R.saldoAnticipo(anticipo);
  if (!(saldo > 0)) throw fail('Este anticipo ya no tiene saldo pendiente.', 409);
  const turno = await turnoAbierto(conn, structure.cashRegisterId);
  let via = null;
  if (accion === 'devolver') {
    if (!turno) throw fail('Abre la caja para devolver el anticipo.', 409);
    via = metodo === 'original' && anticipo.metodo !== 'efectivo' ? anticipo.metodo : 'efectivo';
  }
  const result = await conn.query(
    `UPDATE mesas_reservas SET anticipo_estado = ?, anticipo_resuelto_monto = ?, anticipo_resuelto_metodo = ?, anticipo_resuelto_session_id = ?,
       anticipo_resuelto_por = ?, anticipo_resuelto_at = ?, updated_at = ?
     WHERE id = ? AND anticipo_estado = 'recibido'`,
    [accion === 'devolver' ? 'devuelto' : 'retenido', saldo, via, turno ? Number(turno.id) : null, String(actor.nombre || '').slice(0, 120),
      new Date().toISOString(), new Date().toISOString(), row.id]
  );
  if (afectadas(result) !== 1) throw fail('Otra caja ya resolvió este anticipo. Recarga las reservaciones.', 409);
  let movimiento = null;
  if (via === 'efectivo') {
    movimiento = { tipo: 'Devolución anticipo de reserva', monto: -saldo, notas: notaReserva(row, mesa), fecha };
    await movimientoCaja(conn, { sessionId: Number(turno.id), ...movimiento, actor, structure });
  }
  return { saldo, via, movimiento };
}

// POST /api/sales, dentro de su transacción y después de validarCobro: cuánto
// anticipo de la reserva de esta cuenta se descuenta. La pantalla lo muestra y lo
// manda (anticipoReserva); si no coincide con la base, el cobro se rechaza para
// que el cajero no cobre de más ni de menos.
async function paraCobro(conn, { cuenta, sale, branchId, total, method }) {
  const pedido = Number(sale.anticipoReserva || 0);
  const reservaId = String(cuenta?.reservaId || '');
  if (!cuenta) {
    if (pedido > 0) throw fail('El anticipo de reserva solo se descuenta al cobrar una cuenta de Mesas.');
    return null;
  }
  let row = null;
  if (reservaId) row = (await conn.query('SELECT * FROM mesas_reservas WHERE id = ? AND branch_id = ?', [reservaId, branchId]).catch(() => []))[0] || null;
  const anticipo = row && row.elemento_id === cuenta.elemento_id ? deFila(row) : null;
  const aplicable = R.anticipoAplicable(anticipo, total);
  if (!(aplicable > 0)) {
    if (pedido > 0) throw fail('El anticipo de la reserva ya se usó o cambió. Cierra el cobro y vuelve a abrirlo.', 409);
    return null;
  }
  if (c(pedido) !== c(aplicable)) {
    throw fail(`Esta cuenta tiene un anticipo de reserva de RD$ ${aplicable.toFixed(2)} por descontar. Cierra el cobro y vuelve a abrirlo.`, 409);
  }
  if (method === 'credito' || method === 'contra_entrega' || Number(sale.montoCredito || 0) > 0) {
    throw fail('Con anticipo de reserva no se vende a crédito: cobra el resto con efectivo, tarjeta o transferencia.');
  }
  return { reservaId, monto: aplicable, completo: c(anticipo.monto) <= c(aplicable) };
}

// Ya creada la venta: marca el anticipo como usado en ella (una sola vez).
async function aplicarEnVenta(conn, { anticipo, saleId, factura, cashRegisterId }) {
  const turno = await turnoAbierto(conn, cashRegisterId);
  const result = await conn.query(
    `UPDATE mesas_reservas SET anticipo_aplicado = ?, anticipo_sale_id = ?, anticipo_factura = ?, anticipo_aplicado_session_id = ?, anticipo_estado = ?, updated_at = ?
     WHERE id = ? AND anticipo_estado = 'recibido' AND anticipo_sale_id IS NULL`,
    [anticipo.monto, saleId, String(factura || '').slice(0, 60), turno ? Number(turno.id) : null, anticipo.completo ? 'aplicado' : 'recibido',
      new Date().toISOString(), anticipo.reservaId]
  );
  if (afectadas(result) !== 1) throw fail('El anticipo de la reserva ya se usó en otra caja. Recarga MESAS.', 409);
  await conn.query('UPDATE sales SET reserva_id = ?, reserva_anticipo = ? WHERE id = ?', [anticipo.reservaId, anticipo.monto, saleId]);
}

// Anticipos que entraron y salieron en un turno, por forma de pago (pantalla de
// Caja: resumen del día, ingresos y corte). Sin módulo de Mesas: todo en cero.
async function totalesTurno(query, sessionId) {
  const vacio = () => ({ efectivo: 0, tarjeta: 0, transferencia: 0, total: 0 });
  const out = { recibidos: vacio(), devueltos: vacio(), neto: 0 };
  if (!sessionId) return out;
  const filas = await Promise.resolve(query(
    `SELECT anticipo_monto, anticipo_metodo, anticipo_estado, anticipo_session_id, anticipo_resuelto_monto, anticipo_resuelto_metodo, anticipo_resuelto_session_id
       FROM mesas_reservas WHERE anticipo_session_id = ? OR anticipo_resuelto_session_id = ?`, [sessionId, sessionId]
  )).catch(() => []);
  const acc = { recibidos: { efectivo: 0n, tarjeta: 0n, transferencia: 0n }, devueltos: { efectivo: 0n, tarjeta: 0n, transferencia: 0n } };
  const metodo = (m) => (['efectivo', 'tarjeta', 'transferencia'].includes(m) ? m : 'efectivo');
  for (const r of filas || []) {
    if (Number(r.anticipo_session_id) === Number(sessionId) && r.anticipo_estado) acc.recibidos[metodo(r.anticipo_metodo)] += c(r.anticipo_monto);
    if (Number(r.anticipo_resuelto_session_id) === Number(sessionId) && r.anticipo_estado === 'devuelto') acc.devueltos[metodo(r.anticipo_resuelto_metodo)] += c(r.anticipo_resuelto_monto);
  }
  for (const grupo of ['recibidos', 'devueltos']) {
    const g = acc[grupo];
    out[grupo] = { efectivo: M.number(g.efectivo), tarjeta: M.number(g.tarjeta), transferencia: M.number(g.transferencia), total: M.number(g.efectivo + g.tarjeta + g.transferencia) };
  }
  out.neto = M.number(c(out.recibidos.total) - c(out.devueltos.total));
  return out;
}

module.exports = { COLUMNAS, ensure, deFila, turnoAbierto, recibir, resolver, paraCobro, aplicarEnVenta, totalesTurno, fechaLocalSql };
