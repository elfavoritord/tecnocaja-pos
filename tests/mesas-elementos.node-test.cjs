const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogo, dibujo } = require('../js/mesas-elementos');
const { validarPlano } = require('../server/services/mesas-plano');
const base = { id: 'elemento', codigo: 'E1', forma: 'mesa', x: 20, y: 20, ancho: 120, alto: 120, vendible: true };
test('los planos anteriores conservan identidad, geometría y uso', () => {
  const r = validarPlano([base])[0];
  for (const key of Object.keys(base)) assert.equal(r[key], base[key]);
});
test('cada elemento visual conserva su configuración tras serializar', () => {
  for (const e of catalogo) {
    const item = { ...base, forma: e.forma, tipo: e.tipo, color: '#aabbcc', capacidad: e.capacidad, etiqueta: false };
    assert.deepEqual(validarPlano(JSON.parse(JSON.stringify([item])))[0], { ...item, zona: '', rotacion: 0, textoEscala: 1, grupoId: '' });
    assert.ok(dibujo(e.tipo, item.color).includes('<svg'));
  }
});
for (const [key, value] of [['color', 'red;background:url(x)'], ['tipo', 'desconocido'], ['capacidad', -1], ['capacidad', 2.5], ['etiqueta', 'false']]) {
  test(`rechaza apariencia inválida ${key}: ${value}`, () => assert.throws(() => validarPlano([{ ...base, [key]: value }])));
}
test('cambiar mobiliario no permite desactivar un elemento con cuenta abierta', () => {
  assert.throws(() => validarPlano([{ ...base, tipo: 'silla', vendible: false }], ['elemento']));
});
test('guarda ángulos y normaliza vueltas completas sin cambiar la identidad', () => {
  for (const [angulo, esperado] of [[90, 90], [45, 45], [-90, 270], [450, 90], [360, 0]]) {
    const r = validarPlano([{ ...base, rotacion: angulo }], ['elemento'])[0];
    assert.equal(r.rotacion, esperado); assert.equal(r.id, base.id); assert.equal(r.x, base.x);
  }
});
test('rechaza rotaciones no numéricas o no finitas', () => {
  for (const rotacion of ['90', Infinity, NaN]) assert.throws(() => validarPlano([{ ...base, rotacion }]));
});
test('el tamaño de texto se guarda por elemento y no afecta al resto', () => {
  const plano = validarPlano([{ ...base, textoEscala: 1.75 }, { ...base, id: 'otro', codigo: 'E2' }]);
  assert.equal(plano[0].textoEscala, 1.75); assert.equal(plano[1].textoEscala, 1);
});
test('rechaza escalas de texto inválidas', () => {
  for (const textoEscala of [0, 4, '2', Infinity, NaN]) assert.throws(() => validarPlano([{ ...base, textoEscala }]));
});
test('guarda agrupaciones conservando los identificadores de cada elemento', () => {
  const items = validarPlano([{ ...base, grupoId: 'grupo-1' }, { ...base, id: 'otro', codigo: 'E2', grupoId: 'grupo-1' }]);
  assert.equal(items[0].grupoId, items[1].grupoId); assert.notEqual(items[0].id, items[1].id);
  assert.throws(() => validarPlano([{ ...base, grupoId: '<script>' }]));
});
