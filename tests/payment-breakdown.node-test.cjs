const test = require('node:test');
const assert = require('node:assert/strict');
const { calculate, cashFromSale } = require('../server/services/payment-breakdown');
test('cuatro componentes exactos, solo crédito pendiente y efectivo físico', () => {
  assert.deepEqual(calculate({ total: '100.10', clientId: 1, montoEfectivo: '20.10', montoTarjeta: 30, montoTransferencia: 10, montoCredito: 40, paymentDetails: { creditDueDate: '2026-12-01' } }, { method: 'mixto' }),
    { cash: 20.1, card: 30, transfer: 10, credit: 40, received: 60.1, change: 0, dueDate: '2026-12-01' });
  assert.equal(cashFromSale({ financial_version: 1, cash_amount: 20.1, payment_method: 'mixto', total: 100.1 }), 20.1);
  assert.equal(cashFromSale({ payment_method: 'tarjeta', total: 100 }), 0);
});
test('rechaza crédito anónimo, sobrepago con crédito y devuelta de tarjeta', () => {
  assert.throws(() => calculate({ total: 100 }, { method: 'credito' }), /cliente/);
  assert.throws(() => calculate({ total: 100, montoTarjeta: 101 }, { method: 'mixto' }), /devuelta/);
  assert.throws(() => calculate({ total: 100, montoCredito: 60, montoEfectivo: 50 }, { method: 'mixto' }), /exactamente/);
  assert.throws(() => calculate({ total: 100, montoTransferencia: -1 }, { method: 'mixto' }), /negativos/);
});
test('tarjeta y transferencia no generan efectivo; devuelta se resta del efectivo', () => {
  assert.equal(calculate({ total: 100 }, { method: 'tarjeta' }).cash, 0);
  assert.equal(calculate({ total: 100 }, { method: 'transferencia' }).cash, 0);
  assert.deepEqual(calculate({ total: 100, montoTarjeta: 50, montoEfectivo: 60 }, { method: 'mixto' }),
    { cash: 50, card: 50, transfer: 0, credit: 0, received: 110, change: 10, dueDate: null });
});
