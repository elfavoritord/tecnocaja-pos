'use strict';
// Anticipos de reservas en el cobro de la cuenta de la mesa
// (server/services/mesas-anticipos.js, dentro de la transacción de POST /api/sales).
const A = require('../server/services/mesas-anticipos');

const fila = (extra = {}) => ({ id: 'r1', elemento_id: 'm1', cliente: 'Ana', fecha: '2026-11-09', hora: '20:00', anticipo_monto: '300.00', anticipo_metodo: 'efectivo',
  anticipo_consumible: 1, anticipo_estado: 'recibido', anticipo_aplicado: '0.00', anticipo_sale_id: null, ...extra });
function conn(filas = [], { afectadas = 1 } = {}) {
  const sql = [];
  return {
    sql,
    async query(texto, params) {
      sql.push({ texto, params });
      if (/^SELECT \* FROM mesas_reservas/.test(texto)) return filas;
      if (/FROM cash_sessions/.test(texto)) return [{ id: 7 }];
      if (/^UPDATE mesas_reservas/.test(texto)) return { affectedRows: afectadas };
      return { affectedRows: 1 };
    },
  };
}
const cuenta = { id: 'c1', elemento_id: 'm1', reservaId: 'r1' };

describe('paraCobro', () => {
  test('venta normal (sin mesa ni anticipo): no consulta nada', async () => {
    const c = conn();
    expect(await A.paraCobro(c, { cuenta: null, sale: {}, branchId: 1, total: 100, method: 'efectivo' })).toBeNull();
    expect(c.sql).toHaveLength(0);
  });
  test('fuera de Mesas no se acepta un anticipo', async () => {
    await expect(A.paraCobro(conn(), { cuenta: null, sale: { anticipoReserva: 50 }, branchId: 1, total: 100, method: 'efectivo' })).rejects.toThrow(/Mesas/);
  });
  test('consumible: descuenta hasta el total y debe coincidir con lo que mostró la pantalla', async () => {
    const c = conn([fila()]);
    expect(await A.paraCobro(c, { cuenta, sale: { anticipoReserva: 300 }, branchId: 1, total: 400, method: 'efectivo' }))
      .toEqual({ reservaId: 'r1', monto: 300, completo: true });
    expect(await A.paraCobro(conn([fila()]), { cuenta, sale: { anticipoReserva: 120.5 }, branchId: 1, total: 120.5, method: 'tarjeta' }))
      .toEqual({ reservaId: 'r1', monto: 120.5, completo: false });
    await expect(A.paraCobro(conn([fila()]), { cuenta, sale: {}, branchId: 1, total: 400, method: 'efectivo' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(A.paraCobro(conn([fila()]), { cuenta, sale: { anticipoReserva: 250 }, branchId: 1, total: 400, method: 'efectivo' })).rejects.toMatchObject({ statusCode: 409 });
  });
  test('con anticipo no se vende a crédito', async () => {
    await expect(A.paraCobro(conn([fila()]), { cuenta, sale: { anticipoReserva: 300 }, branchId: 1, total: 400, method: 'credito' })).rejects.toThrow(/crédito/);
    await expect(A.paraCobro(conn([fila()]), { cuenta, sale: { anticipoReserva: 300, montoCredito: 10 }, branchId: 1, total: 400, method: 'mixto' })).rejects.toThrow(/crédito/);
  });
  test('ya usado, no consumible, de otra mesa o sin reserva: no se descuenta', async () => {
    for (const r of [fila({ anticipo_sale_id: 5 }), fila({ anticipo_consumible: 0 }), fila({ elemento_id: 'm2' }), fila({ anticipo_estado: 'devuelto' })]) {
      expect(await A.paraCobro(conn([r]), { cuenta, sale: {}, branchId: 1, total: 400, method: 'efectivo' })).toBeNull();
      await expect(A.paraCobro(conn([r]), { cuenta, sale: { anticipoReserva: 300 }, branchId: 1, total: 400, method: 'efectivo' })).rejects.toMatchObject({ statusCode: 409 });
    }
    const sinReserva = conn();
    expect(await A.paraCobro(sinReserva, { cuenta: { ...cuenta, reservaId: null }, sale: {}, branchId: 1, total: 400, method: 'efectivo' })).toBeNull();
    expect(sinReserva.sql).toHaveLength(0);
  });
});

describe('aplicarEnVenta', () => {
  test('marca el anticipo usado en la venta y guarda el monto en la factura', async () => {
    const c = conn();
    await A.aplicarEnVenta(c, { anticipo: { reservaId: 'r1', monto: 300, completo: true }, saleId: 44, factura: 'F-44', cashRegisterId: 2 });
    const reserva = c.sql.find((q) => /^UPDATE mesas_reservas/.test(q.texto));
    expect(reserva.texto).toMatch(/anticipo_estado = 'recibido' AND anticipo_sale_id IS NULL/);
    expect(reserva.params.slice(0, 5)).toEqual([300, 44, 'F-44', 7, 'aplicado']);
    expect(c.sql.find((q) => /^UPDATE sales/.test(q.texto)).params).toEqual(['r1', 300, 44]);
  });
  test('si otra caja ya lo usó, la venta se deshace', async () => {
    await expect(A.aplicarEnVenta(conn([], { afectadas: 0 }), { anticipo: { reservaId: 'r1', monto: 300, completo: true }, saleId: 44, factura: 'F-44', cashRegisterId: 2 }))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('totalesTurno (pantalla de Caja)', () => {
  test('recibidos por forma de pago, devueltos y neto del turno', async () => {
    const query = async () => [
      { anticipo_monto: '300.00', anticipo_metodo: 'efectivo', anticipo_estado: 'aplicado', anticipo_session_id: 7 },
      { anticipo_monto: '150.00', anticipo_metodo: 'tarjeta', anticipo_estado: 'devuelto', anticipo_session_id: 7, anticipo_resuelto_monto: '150.00', anticipo_resuelto_metodo: 'tarjeta', anticipo_resuelto_session_id: 7 },
      { anticipo_monto: '500.00', anticipo_metodo: 'efectivo', anticipo_estado: 'devuelto', anticipo_session_id: 6, anticipo_resuelto_monto: '200.00', anticipo_resuelto_metodo: 'efectivo', anticipo_resuelto_session_id: 7 },
      { anticipo_monto: '80.00', anticipo_metodo: 'transferencia', anticipo_estado: 'retenido', anticipo_session_id: 7, anticipo_resuelto_monto: '80.00', anticipo_resuelto_session_id: 7 },
    ];
    expect(await A.totalesTurno(query, 7)).toEqual({
      recibidos: { efectivo: 300, tarjeta: 150, transferencia: 80, total: 530 },
      devueltos: { efectivo: 200, tarjeta: 150, transferencia: 0, total: 350 },
      neto: 180,
    });
  });
  test('sin Mesas (sin tabla) o sin turno: todo en cero', async () => {
    const cero = { recibidos: { efectivo: 0, tarjeta: 0, transferencia: 0, total: 0 }, devueltos: { efectivo: 0, tarjeta: 0, transferencia: 0, total: 0 }, neto: 0 };
    expect(await A.totalesTurno(async () => { throw new Error('no such table: mesas_reservas'); }, 7)).toEqual(cero);
    expect(await A.totalesTurno(async () => [], null)).toEqual(cero);
  });
});

describe('recibir y resolver', () => {
  const actor = { id: 1, nombre: 'Caja' };
  const structure = { branchId: 1, cashRegisterId: 2 };
  test('en efectivo entra a la caja con su movimiento; con tarjeta solo queda en el turno', async () => {
    const c = conn();
    const r = await A.recibir(c, { reserva: fila(), anticipo: { monto: 300, metodo: 'efectivo', referencia: null, consumible: true }, structure, actor, mesa: 'Mesa 1', fecha: '2026-11-09 20:15:00' });
    expect(r.movimiento).toMatchObject({ tipo: 'Anticipo de reserva', monto: 300, fecha: '2026-11-09 20:15:00' });
    // Con la hora local del negocio (en SQLite datetime('now') sería UTC).
    expect(c.sql.some((q) => /INSERT INTO cash_movements/.test(q.texto) && q.params[1] === 'Anticipo de reserva' && q.params[2] === 300 && q.params[6] === '2026-11-09 20:15:00')).toBe(true);
    expect(A.fechaLocalSql(new Date(2026, 10, 9, 23, 5, 9))).toBe('2026-11-09 23:05:09');
    const t = conn();
    expect((await A.recibir(t, { reserva: fila(), anticipo: { monto: 300, metodo: 'tarjeta', referencia: 'A1', consumible: false }, structure, actor, mesa: 'Mesa 1' })).movimiento).toBeNull();
    expect(t.sql.some((q) => /cash_movements/.test(q.texto))).toBe(false);
  });
  test('sin caja abierta no se recibe', async () => {
    const c = conn();
    c.query = async (texto) => (/FROM cash_sessions/.test(texto) ? [] : { affectedRows: 1 });
    await expect(A.recibir(c, { reserva: fila(), anticipo: { monto: 1, metodo: 'efectivo', consumible: true }, structure, actor, mesa: 'Mesa 1' })).rejects.toThrow(/Abre la caja/);
  });
  test('devolver en efectivo saca de la gaveta solo lo que queda; retener no mueve dinero', async () => {
    const c = conn();
    const r = await A.resolver(c, { row: fila({ anticipo_aplicado: '120.00' }), accion: 'devolver', metodo: 'efectivo', structure, actor, mesa: 'Mesa 1' });
    expect(r).toMatchObject({ saldo: 180, via: 'efectivo' });
    expect(c.sql.some((q) => /INSERT INTO cash_movements/.test(q.texto) && q.params[1] === 'Devolución anticipo de reserva' && q.params[2] === -180)).toBe(true);
    const o = conn();
    expect((await A.resolver(o, { row: fila({ anticipo_metodo: 'transferencia' }), accion: 'devolver', metodo: 'original', structure, actor, mesa: 'Mesa 1' })).via).toBe('transferencia');
    expect(o.sql.some((q) => /cash_movements/.test(q.texto))).toBe(false);
    const k = conn();
    expect((await A.resolver(k, { row: fila(), accion: 'retener', structure, actor, mesa: 'Mesa 1' })).via).toBeNull();
    expect(k.sql.some((q) => /cash_movements/.test(q.texto))).toBe(false);
    await expect(A.resolver(conn(), { row: fila({ anticipo_estado: 'aplicado', anticipo_aplicado: '300.00' }), accion: 'retener', structure, actor, mesa: 'Mesa 1' })).rejects.toMatchObject({ statusCode: 409 });
  });
});
