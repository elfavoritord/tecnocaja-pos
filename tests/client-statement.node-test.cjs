const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../server/services/client-statement');
const sale = { id: 1, invoice_number: 'FAC-1', financial_version: 1, credit_amount: 40, total: 100, received_amount: 75, created_at: '2026-01-01 10:00:00' };
const payment = { sale_id: 1, payment_id: 1, applied_amount: 15, payment_method: 'efectivo', invoice_number: 'FAC-1', created_at: '2026-01-02 11:00:00' };
test('estado de cuenta no convierte compras pagadas en deuda y usa solo crédito mixto', () => {
  const r = build({ client: { balance: 25 }, sales: [sale], payments: [payment] });
  assert.equal(r.rows[0].debit, 40); assert.equal(r.rows[1].credit, 15);
  assert.equal(r.closingBalance, 25); assert.equal(r.reconciliationDifference, 0);
});
test('período conserva el saldo inicial y cancelaciones/ajustes no generan abonos ficticios', () => {
  const r = build({ client: { balance: 0 }, sales: [{ ...sale, credit_adjustment: 5, fiscal_status: 'cancelada', canceled_at: '2026-01-04 12:00:00' }],
    payments: [payment], returns: [{ id: 1, original_sale_id: 1, original_invoice_number: 'FAC-1', credit_reduction: 5, returned_at: '2026-01-03 11:00:00' }], from: '2026-01-02', to: '2026-01-03' });
  assert.equal(r.openingBalance, 40); assert.equal(r.closingBalance, 20); assert.equal(r.rows.length, 2); assert.equal(r.reconciliationDifference, 0);
});
test('histórico reconoce principal a partir de abonos documentados y señala diferencias', () => {
  const r = build({ client: { balance: 25 }, sales: [{ ...sale, financial_version: 0 }], payments: [payment] });
  assert.equal(r.rows[0].debit, 40); assert.equal(r.closingBalance, 25);
  assert.equal(build({ client: { balance: 30 }, sales: [sale], payments: [payment] }).reconciliationDifference, 5);
});
