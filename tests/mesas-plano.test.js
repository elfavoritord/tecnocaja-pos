const { validarPlano } = require('../server/services/mesas-plano');

const mesa = (extra = {}) => ({ id: 'mesa-1', codigo: 'V-1', forma: 'mesa', x: 0, y: 0, ancho: 80, alto: 60, vendible: true, ...extra });

test('conserva identidad al mover una mesa ocupada', () => {
  expect(validarPlano([mesa({ x: 120 })], ['mesa-1'])[0].id).toBe('mesa-1');
});
test('rechaza códigos duplicados independientemente de espacios y mayúsculas', () => {
  expect(() => validarPlano([mesa(), mesa({ id: 'mesa-2', codigo: ' v-1 ' })])).toThrow(/código ya existe/);
});
test.each([{ elementos: [] }, { elementos: [mesa({ vendible: false })] }])('protege mesas con operaciones activas', ({ elementos }) => {
  expect(() => validarPlano(elementos, ['mesa-1'])).toThrow();
});
test.each([{ ancho: -1 }, { x: Infinity }, { alto: '80' }, { forma: '3d' }])('rechaza geometría inválida %j', (extra) => {
  expect(() => validarPlano([mesa(extra)])).toThrow();
});
