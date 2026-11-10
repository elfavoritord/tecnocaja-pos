const test = require('node:test');
const assert = require('node:assert/strict');
const { HistorialPlano } = require('../js/mesas-historial');
const base = [{ id: 'a', x: 10, grupoId: '' }];
test('deshacer y rehacer restaura datos y selección sin referencias mutables', () => {
  const h = new HistorialPlano(base);
  h.registrar(base, ['a'], 'a'); h.registrar([{ ...base[0], x: 30 }], ['a'], 'a');
  const undo = h.deshacer(); assert.equal(undo.elementos[0].x, 10); assert.deepEqual(undo.seleccion, ['a']);
  undo.elementos[0].x = 999;
  assert.equal(h.rehacer().elementos[0].x, 30); assert.equal(h.deshacer().elementos[0].x, 10);
});
test('editar después de deshacer descarta la rama de rehacer', () => {
  const h = new HistorialPlano(base); h.registrar([]); h.deshacer(); h.registrar([{ id: 'b' }]);
  assert.equal(h.puedeRehacer, false); assert.equal(h.rehacer(), null);
});
test('seleccionar sin editar no crea pasos ni borra rehacer', () => {
  const h = new HistorialPlano(base); h.registrar([]); h.deshacer(); h.registrar(base, ['a'], 'a');
  assert.equal(h.puedeDeshacer, false); assert.equal(h.puedeRehacer, true);
});
test('guardar sincroniza el paso actual y conserva el historial', () => {
  const h = new HistorialPlano(base); h.registrar([]); h.sincronizar([]);
  assert.equal(h.deshacer().elementos[0].id, 'a'); assert.deepEqual(h.rehacer().elementos, []);
});
test('elimina y recupera grupos manteniendo identificadores', () => {
  const grupo = [{ id: 'a', grupoId: 'g' }, { id: 'b', grupoId: 'g' }];
  const h = new HistorialPlano(grupo); h.registrar([]);
  assert.deepEqual(h.deshacer().elementos, grupo);
});
test('limita los pasos y la memoria del historial', () => {
  const h = new HistorialPlano([], { maxPasos: 2, maxCaracteres: 1000 });
  for (let i = 0; i < 10; i++) h.registrar([{ id: i }]);
  assert.equal(h.estados.length, 3); h.deshacer(); h.deshacer(); assert.equal(h.deshacer(), null);
  const corto = new HistorialPlano([], { maxCaracteres: 10 }); corto.registrar([{ id: 'cadena larga' }]);
  assert.equal(corto.estados.length, 1);
});
