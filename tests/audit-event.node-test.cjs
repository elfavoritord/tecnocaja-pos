const test = require('node:test');
const assert = require('node:assert/strict');
const { scrub, append } = require('../server/services/audit-event');
test('auditoría elimina credenciales y detalles de tarjeta', () => {
  assert.deepEqual(scrub({ total: 10, nested: { token: 'abc', password: 'x', cardNumber: '123', amount: 10 }, note: 'Bearer abc123' }),
    { total: 10, nested: { amount: 10 }, note: 'Bearer [oculto]' });
});
test('auditoría usa una inserción atómica y propaga fallo de persistencia', async () => {
  const queries = [];
  const id = await append(async (sql, args) => queries.push({ sql, args }), { moduleName: 'Caja', actionName: 'Cierre', before: { cash: 100 }, after: { cash: 99 }, result: 'exito' });
  assert.match(id, /^[a-f0-9-]{36}$/); assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /INSERT INTO audit_logs/);
  await assert.rejects(append(async () => { throw new Error('disk full'); }, {}), /disk full/);
});
