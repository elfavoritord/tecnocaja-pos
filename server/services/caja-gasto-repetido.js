'use strict';
// Gasto repetido en el turno (Emilio, 2026-11-23). En el cuadre de un cliente
// salieron 14 gastos "platanos" de RD$ 1,600 y sobraban RD$ 19,735 en la
// gaveta: el mismo gasto se había registrado varias veces. Antes de registrar
// un gasto igual a otro del mismo turno (mismo monto y misma descripción) se
// pide confirmación; con `confirmarRepetido` se registra igual. Lo usan las dos
// rutas que registran gastos: Caja → Gastos (/api/cash/expense) y la gaveta
// con motivo "gasto" (/api/caja/gaveta).

const TIPO_GASTO = 'Gasto';
const normalizar = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const centavos = (v) => Math.round(Math.abs(Number(v || 0)) * 100);
const formatoMonto = (cent) => (cent / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// Cuántos gastos iguales hay ya en el turno `sessionId`.
async function contarGastosIguales(run, { sessionId, monto, notas }) {
  if (!sessionId) return 0;
  const filas = await run(
    'SELECT amount, notes FROM cash_movements WHERE session_id = ? AND movement_type = ? ORDER BY id DESC LIMIT 1000',
    [sessionId, TIPO_GASTO]
  );
  const cent = centavos(monto), texto = normalizar(notas);
  return (filas || []).filter((f) => Number(f.amount) < 0 && centavos(f.amount) === cent && normalizar(f.notes) === texto).length;
}

// Lanza 409 GASTO_REPETIDO si ya hay uno igual y no vino confirmado.
async function exigirConfirmacionSiRepetido(run, { sessionId, tipo = TIPO_GASTO, monto, notas, confirmado }) {
  if (tipo !== TIPO_GASTO || confirmado === true) return;
  const iguales = await contarGastosIguales(run, { sessionId, monto, notas });
  if (!iguales) return;
  const que = `"${String(notas || '').trim()}" de ${formatoMonto(centavos(monto))}`;
  const error = new Error(iguales === 1
    ? `En este turno ya se registró un gasto ${que}. Si es otro gasto, confírmalo.`
    : `En este turno ya se registraron ${iguales} gastos ${que}. Si es otro gasto, confírmalo.`);
  error.statusCode = 409;
  error.code = 'GASTO_REPETIDO';
  throw error;
}

module.exports = { TIPO_GASTO, contarGastosIguales, exigirConfirmacionSiRepetido };
