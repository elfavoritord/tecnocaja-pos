'use strict';
// Propina legal: monto mínimo del negocio y propina quitada en una venta.
const { calculate } = require('../../js/propina-legal');

const base = { enabled: true, orderType: 'mesa', lines: [{ net: 600, eligible: true }, { net: 300, eligible: true }], discount: 0 };

describe('propina legal: mínimo y propina quitada', () => {
  test('sin mínimo se cobra el 10 % de la base', () => {
    expect(calculate(base)).toMatchObject({ amount: 90, posible: 90, applies: true, motivo: null });
  });
  test('debajo del mínimo no se cobra; desde el mínimo sí', () => {
    expect(calculate({ ...base, minimo: 1000 })).toMatchObject({ amount: 0, posible: 0, applies: false, motivo: 'bajo_minimo', base: 900 });
    expect(calculate({ ...base, minimo: 900 })).toMatchObject({ amount: 90, applies: true });
  });
  test('el mínimo se mide después del descuento y solo con lo que lleva propina', () => {
    expect(calculate({ ...base, minimo: 900, discount: 90 }).motivo).toBe('bajo_minimo');
    expect(calculate({ ...base, minimo: 600, lines: [{ net: 600, eligible: true }, { net: 300, eligible: false }] })).toMatchObject({ amount: 60, base: 600 });
  });
  test('quitada en la venta: cero, pero se conoce cuánto era', () => {
    const r = calculate({ ...base, sinPropina: true });
    expect(r).toMatchObject({ amount: 0, posible: 90, quitada: true, applies: false, motivo: 'quitada' });
    expect(r.lineAmounts).toEqual([0, 0]);
  });
  test('quitar no tiene efecto cuando no había propina (para llevar o bajo el mínimo)', () => {
    expect(calculate({ ...base, orderType: 'recoger', sinPropina: true })).toMatchObject({ amount: 0, quitada: false, motivo: 'modalidad' });
    expect(calculate({ ...base, minimo: 5000, sinPropina: true }).quitada).toBe(false);
  });
});
