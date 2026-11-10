const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../js/mesas-seleccion');
const a = { id: 'a', x: 50, y: 50, ancho: 100, alto: 50, grupoId: 'g' };
const b = { id: 'b', x: 200, y: 80, ancho: 80, alto: 50, grupoId: 'g' };
test('seleccionar un miembro incluye su grupo, sin incluir otros', () => {
  assert.deepEqual([...s.expandir([a, b, { ...a, id: 'c', grupoId: '' }], ['a'])], ['a', 'b']);
});
test('mover mantiene distancias y las identidades', () => {
  const moved = s.trasladar([a, b], 100, 20);
  assert.equal(moved[1].x - moved[0].x, 150); assert.equal(moved[1].y - moved[0].y, 30);
  assert.equal(moved[0].id, 'a'); assert.equal(a.x, 50);
});
test('el límite del lienzo limita todo el conjunto con el mismo desplazamiento', () => {
  const moved = s.trasladar([a, b], -1000, 5000);
  assert.equal(moved[0].x, 0); assert.equal(moved[1].x, 150); assert.equal(moved[1].y + moved[1].alto, 1000);
});
test('los límites consideran la rotación', () => {
  const bounds = s.limites([{ ...a, rotacion: 90 }]);
  assert.ok(Math.abs(bounds.ancho - 50) < .001); assert.ok(Math.abs(bounds.alto - 100) < .001);
});
test('escalar cambia proporcionalmente posiciones, tamaño y texto', () => {
  const scaled = s.escalar([a, b], 1.5);
  assert.equal(scaled[0].ancho, 150); assert.equal(scaled[0].textoEscala, 1.5);
  assert.equal(scaled[1].x - scaled[0].x, 225); assert.equal(scaled[0].grupoId, 'g');
});
test('una selección vacía es una operación segura', () => {
  assert.deepEqual(s.trasladar([], 1, 1), []); assert.deepEqual(s.escalar([], 1.5), []);
});
