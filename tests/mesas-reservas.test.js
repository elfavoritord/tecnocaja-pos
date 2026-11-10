'use strict';
// Reservaciones de mesas: validación, choques de horario y cuándo una mesa se
// ve "Reservada" (js/mesas-reservas.js, compartido por servidor y plano).
const R = require('../js/mesas-reservas');

// 8 de noviembre de 2026, 6:00 p. m. hora local.
const ahora = new Date(2026, 10, 8, 18, 0, 0);
const base = { cliente: 'Juan Pérez', telefono: '809-555-0101', personas: 4, fecha: '2026-11-08', hora: '20:00', nota: '' };

describe('validar una reserva', () => {
  test('acepta una reserva normal y limpia los datos', () => {
    expect(R.validarReserva({ ...base, cliente: '  Juan   Pérez ', nota: ' cumpleaños ' }, { ahora }))
      .toEqual({ cliente: 'Juan Pérez', telefono: '809-555-0101', personas: 4, fecha: '2026-11-08', hora: '20:00', nota: 'cumpleaños' });
    expect(R.validarReserva({ ...base, telefono: '' }, { ahora }).telefono).toBeNull();
  });
  test.each([
    [{ cliente: 'J' }, /nombre/],
    [{ telefono: '12' }, /teléfono/],
    [{ personas: 0 }, /personas/],
    [{ personas: 2.5 }, /personas/],
    [{ fecha: '2026-02-30' }, /fecha/],
    [{ hora: '25:00' }, /hora/],
    [{ hora: '17:00' }, /ya pasó/],
    [{ fecha: '2028-01-01' }, /un año/],
  ])('rechaza %j', (cambio, mensaje) => {
    expect(() => R.validarReserva({ ...base, ...cambio }, { ahora })).toThrow(mensaje);
  });
  test('una hora de hace menos de 15 minutos todavía se acepta (el cliente ya está llegando)', () => {
    expect(() => R.validarReserva({ ...base, hora: '17:50' }, { ahora })).not.toThrow();
  });
});

describe('choques en la misma mesa', () => {
  const activa = { id: 'r1', elemento_id: 'm1', fecha: '2026-11-08', hora: '20:00', estado: 'activa', cliente: 'Ana' };
  test('misma mesa a menos de 2 horas choca; a 2 horas o más no', () => {
    expect(R.chocaCon([activa], { elementoId: 'm1', fecha: '2026-11-08', hora: '21:30' })).toBe(activa);
    expect(R.chocaCon([activa], { elementoId: 'm1', fecha: '2026-11-08', hora: '22:00' })).toBeNull();
  });
  test('otra mesa, otro día, la misma reserva al editarla o una ya cerrada no chocan', () => {
    expect(R.chocaCon([activa], { elementoId: 'm2', fecha: '2026-11-08', hora: '20:00' })).toBeNull();
    expect(R.chocaCon([activa], { elementoId: 'm1', fecha: '2026-11-09', hora: '20:00' })).toBeNull();
    expect(R.chocaCon([activa], { elementoId: 'm1', fecha: '2026-11-08', hora: '20:00', excluirId: 'r1' })).toBeNull();
    expect(R.chocaCon([{ ...activa, estado: 'cancelada' }], { elementoId: 'm1', fecha: '2026-11-08', hora: '20:00' })).toBeNull();
  });
});

describe('cuándo la mesa se ve reservada', () => {
  const reserva = (hora, extra = {}) => ({ id: hora, elemento_id: 'm1', fecha: '2026-11-08', hora, estado: 'activa', ...extra });
  test('desde 2 horas antes queda reservada; antes solo se avisa la hora', () => {
    expect(R.vigente([reserva('20:00')], 'm1', ahora)).toBeTruthy();
    expect(R.vigente([reserva('20:01')], 'm1', ahora)).toBeNull();
    expect(R.proxima([reserva('21:00')], 'm1', ahora).hora).toBe('21:00');
  });
  test('sigue reservada si ya pasó la hora y nadie la cerró (atrasada)', () => {
    const tarde = reserva('17:00');
    expect(R.vigente([tarde], 'm1', ahora)).toBe(tarde);
    expect(R.atrasada(tarde, ahora)).toBe(true);
    expect(R.atrasada(reserva('17:50'), ahora)).toBe(false);
  });
  test('las cerradas, las de otro día y las de otra mesa no reservan', () => {
    expect(R.vigente([reserva('19:00', { estado: 'cumplida' })], 'm1', ahora)).toBeNull();
    expect(R.vigente([reserva('19:00', { fecha: '2026-11-07' })], 'm1', ahora)).toBeNull();
    expect(R.vigente([reserva('19:00')], 'm2', ahora)).toBeNull();
  });
  test('"hoy" es la fecha local, no la de UTC (de noche en RD ya sería mañana en UTC)', () => {
    expect(R.fechaLocal(new Date(2026, 10, 8, 23, 30))).toBe('2026-11-08');
  });
});

describe('anticipo de la reserva (opcional)', () => {
  test('sin monto no hay anticipo; con monto exige forma de pago', () => {
    expect(R.validarAnticipo({})).toBeNull();
    expect(R.validarAnticipo({ anticipoMonto: '' })).toBeNull();
    expect(R.validarAnticipo({ anticipoMonto: '0.00', anticipoMetodo: 'efectivo' })).toBeNull();
    expect(R.validarAnticipo({ anticipoMonto: '1,500.5', anticipoMetodo: 'transferencia', anticipoReferencia: '  TRF  123 ', anticipoConsumible: true }))
      .toEqual({ monto: 1500.5, metodo: 'transferencia', referencia: 'TRF 123', consumible: true });
    expect(R.validarAnticipo({ anticipoMonto: '200', anticipoMetodo: 'efectivo', anticipoConsumible: 'on' }).consumible).toBe(true);
    expect(R.validarAnticipo({ anticipoMonto: '200', anticipoMetodo: 'efectivo' }).consumible).toBe(false);
  });
  test.each([
    [{ anticipoMonto: '100' }, /cómo pagó/],
    [{ anticipoMonto: '100', anticipoMetodo: 'cheque' }, /cómo pagó/],
    [{ anticipoMonto: '10.555', anticipoMetodo: 'efectivo' }, /2 decimales/],
    [{ anticipoMonto: '-5', anticipoMetodo: 'efectivo' }, /monto válido/],
    [{ anticipoMonto: '1000000.01', anticipoMetodo: 'efectivo' }, /1,000,000/],
  ])('rechaza %j', (body, mensaje) => {
    expect(() => R.validarAnticipo(body)).toThrow(mensaje);
  });
  const recibido = { monto: 500, metodo: 'efectivo', consumible: true, estado: 'recibido', aplicado: 0, saleId: null };
  test('consumible: se descuenta hasta el total de la cuenta, una sola vez', () => {
    expect(R.anticipoAplicable(recibido, 1234.56)).toBe(500);
    expect(R.anticipoAplicable(recibido, 199.99)).toBe(199.99);
    expect(R.anticipoAplicable({ ...recibido, consumible: false }, 1000)).toBe(0);
    expect(R.anticipoAplicable({ ...recibido, saleId: 9 }, 1000)).toBe(0);
    expect(R.anticipoAplicable({ ...recibido, estado: 'devuelto' }, 1000)).toBe(0);
    expect(R.anticipoAplicable(null, 1000)).toBe(0);
    expect(R.restarAnticipo(1234.56, 500)).toBe(734.56);
    expect(R.restarAnticipo(0.3, 0.1)).toBe(0.2);
  });
  test('saldo: lo que queda sin usar ni resolver', () => {
    expect(R.saldoAnticipo(recibido)).toBe(500);
    expect(R.saldoAnticipo({ ...recibido, aplicado: 199.99 })).toBe(300.01);
    expect(R.saldoAnticipo({ ...recibido, estado: 'aplicado', aplicado: 500 })).toBe(0);
    expect(R.saldoAnticipo({ ...recibido, estado: 'retenido' })).toBe(0);
  });
  test('constancia: datos de la reserva, del anticipo y la política', () => {
    const reserva = { id: 'ab12cd34-5678', cliente: 'Juan Pérez', telefono: '809-555-0101', personas: 4, fecha: '2026-11-08', hora: '20:00', nota: 'Cumpleaños',
      anticipo: { ...recibido, referencia: 'REF-1' } };
    const secciones = R.constancia(reserva, { mesa: 'Mesa 4', usuario: 'Ana' });
    const texto = JSON.stringify(secciones);
    expect(secciones.map((s) => s.titulo)).toEqual(['Reserva', 'Anticipo', 'Importante']);
    expect(secciones[0].filas[0]).toEqual(['Nº', 'AB12CD34', true]);
    expect(texto).toMatch(/Mesa 4/); expect(texto).toMatch(/8:00 p\. m\./); expect(texto).toMatch(/Juan Pérez/);
    expect(texto).toMatch(/RD\$ 500\.00/); expect(texto).toMatch(/Sí: se descuenta/); expect(texto).toMatch(/REF-1/);
    expect(texto).toMatch(/Atendido por: Ana/); expect(texto).toMatch(/No es factura/);
    expect(R.constancia({ ...reserva, anticipo: null }).map((s) => s.titulo)).toEqual(['Reserva', 'Importante']);
  });
  test('estado del anticipo en palabras', () => {
    expect(R.estadoAnticipoTexto(recibido)).toBe('Recibido');
    expect(R.estadoAnticipoTexto({ ...recibido, aplicado: 200 })).toBe('Usado RD$ 200.00 · quedan RD$ 300.00');
    expect(R.estadoAnticipoTexto({ ...recibido, estado: 'aplicado', aplicado: 500, factura: 'F-1' })).toBe('Descontado en la factura F-1');
    expect(R.estadoAnticipoTexto({ ...recibido, estado: 'devuelto', aplicado: 200, resueltoMonto: 300, resueltoMetodo: 'efectivo' })).toBe('Usado RD$ 200.00 · devuelto RD$ 300.00 (efectivo)');
    expect(R.estadoAnticipoTexto({ ...recibido, estado: 'retenido', resueltoMonto: 500 })).toBe('Quedó al negocio RD$ 500.00');
  });
});
