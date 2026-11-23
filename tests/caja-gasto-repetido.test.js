'use strict';
// Gasto repetido en el turno (2026-11-23): un cuadre traía 14 gastos "platanos"
// de RD$ 1,600 iguales. Un gasto igual a otro del mismo turno pide confirmación.
const { contarGastosIguales, exigirConfirmacionSiRepetido } = require('../server/services/caja-gasto-repetido');

function base(filas) {
  const llamadas = [];
  const run = async (sql, params) => {
    llamadas.push({ sql, params });
    return filas.filter((f) => f.session_id === params[0] && f.movement_type === params[1]);
  };
  return { run, llamadas };
}

const movimientos = [
  { session_id: 7, movement_type: 'Gasto', amount: '-1600.00', notes: 'platanos' },
  { session_id: 7, movement_type: 'Gasto', amount: -300, notes: 'gasolina' },
  { session_id: 7, movement_type: 'Retiro de efectivo', amount: -1600, notes: 'platanos' },
  { session_id: 6, movement_type: 'Gasto', amount: -1600, notes: 'platanos' },
];

test('cuenta solo los gastos del mismo turno con el mismo monto y la misma descripción', async () => {
  const { run, llamadas } = base(movimientos);
  expect(await contarGastosIguales(run, { sessionId: 7, monto: 1600, notas: '  Platanos ' })).toBe(1);
  expect(await contarGastosIguales(run, { sessionId: 7, monto: 1600.01, notas: 'platanos' })).toBe(0);
  expect(await contarGastosIguales(run, { sessionId: 7, monto: 1600, notas: 'platanos verdes' })).toBe(0);
  expect(await contarGastosIguales(run, { sessionId: 8, monto: 1600, notas: 'platanos' })).toBe(0);
  expect(await contarGastosIguales(run, { sessionId: null, monto: 1600, notas: 'platanos' })).toBe(0);
  expect(llamadas[0].sql).toMatch(/session_id = \? AND movement_type = \?/);
});

test('un gasto repetido da 409 GASTO_REPETIDO, salvo confirmado', async () => {
  const { run } = base(movimientos);
  await expect(exigirConfirmacionSiRepetido(run, { sessionId: 7, monto: 1600, notas: 'platanos' }))
    .rejects.toMatchObject({ statusCode: 409, code: 'GASTO_REPETIDO', message: expect.stringContaining('"platanos" de 1,600.00') });
  await expect(exigirConfirmacionSiRepetido(run, { sessionId: 7, monto: 1600, notas: 'platanos', confirmado: true })).resolves.toBeUndefined();
  await expect(exigirConfirmacionSiRepetido(run, { sessionId: 7, monto: 50, notas: 'hielo' })).resolves.toBeUndefined();
});

test('con varios iguales dice cuántos hay', async () => {
  const { run } = base([...movimientos, { session_id: 7, movement_type: 'Gasto', amount: -1600, notes: 'platanos' }]);
  await expect(exigirConfirmacionSiRepetido(run, { sessionId: 7, monto: 1600, notas: 'platanos' }))
    .rejects.toThrow('ya se registraron 2 gastos');
});

test('retiros, pagos a suplidor y devoluciones no se revisan', async () => {
  const { run, llamadas } = base(movimientos);
  for (const tipo of ['Retiro de efectivo', 'Pago suplidor', 'Devolución']) {
    await expect(exigirConfirmacionSiRepetido(run, { sessionId: 7, tipo, monto: 1600, notas: 'platanos' })).resolves.toBeUndefined();
  }
  expect(llamadas).toHaveLength(0);
});
