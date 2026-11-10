const test = require('node:test');
const assert = require('node:assert/strict');
const { validarCobro, validarDraft } = require('../server/services/mesas-cuentas');
const items = [{ id: 1, qty: 2, precio: 100, descuento: 0 }];
function conn(row, affected = 1) {
  const calls = [];
  return { calls, query: async (sql) => { calls.push(sql); return sql.startsWith('SELECT') ? (row ? [row] : []) : { affectedRows: affected }; } };
}
const row = { id: 'cuenta', estado: 'abierta', version: 3, draft_json: JSON.stringify({ items }) };
const sale = { mesasCuenta: { id: 'cuenta', version: 3 }, items, metodo: 'efectivo' };
test('ventas normales conservan su flujo', async () => assert.equal(await validarCobro(conn(), {}, 1), null));
test('una cuenta vigente se reclama una sola vez', async () => {
  const db = conn(row); assert.equal((await validarCobro(db, sale, 1)).id, 'cuenta'); assert.equal(db.calls.length, 2);
});
for (const [name, change] of [['pagada', { estado: 'pagada' }], ['versión obsoleta', { version: 4 }]]) {
  test(`rechaza cuenta ${name}`, async () => assert.rejects(validarCobro(conn({ ...row, ...change }), sale, 1)));
}
test('rechaza líneas cambiadas desde el guardado', async () => assert.rejects(validarCobro(conn(row), { ...sale, items: [{ ...items[0], qty: 3 }] }, 1)));
test('rechaza conflicto concurrente al reclamar', async () => assert.rejects(validarCobro(conn(row, 0), sale, 1)));
test('no cierra una cuenta enviada a cola de cobro', async () => assert.rejects(validarCobro(conn(row), { ...sale, pendienteCobro: true }, 1)));
test('rechaza cantidades negativas', () => assert.throws(() => validarDraft({ items: [{ qty: -1, precio: 2 }] })));
