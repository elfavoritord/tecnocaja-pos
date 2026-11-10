'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../js/pos-money');
const P = require('../js/cliente-telefono');
test('importes, redondeo, cantidades y porcentajes son exactos', () => {
  assert.equal(M.cents('1.005'), 101n);
  assert.equal(M.cents('0.1') + M.cents('0.2'), 30n);
  assert.equal(M.percent(M.cents('900'), '10'), M.cents('90'));
  assert.equal(M.quantity(M.cents('33.33'), '1.5'), 5000n);
  assert.equal(M.decimal(-123n), '-1.23');
  assert.throws(() => M.cents(Infinity)); assert.throws(() => M.cents('NaN'));
});
test('teléfono RD normalizado y formato legible, sin verificación externa', () => {
  for (const input of ['809-555-1234', '+1 (809) 555-1234', '18095551234']) {
    assert.deepEqual(P.normalize(input), { ok: true, value: '+18095551234', display: '809-555-1234' });
  }
  for (const input of ['', '809123', '1235551234', 'hola', '8095551234 ext 2']) assert.equal(P.normalize(input).ok, false);
  assert.equal(P.normalize('+442079460123', 'INT').value, '+442079460123');
  assert.equal(P.normalize('2079460123', 'INT').ok, false);
});
