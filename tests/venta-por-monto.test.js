'use strict';
// Total editado en productos por peso (js/venta-por-monto.js). La caja y el
// servidor usan este mismo cálculo; aquí se comprueba, con las fórmulas del
// carrito (calculateSaleItemDiscount / Net / Tax), que la línea da el monto.
const V = require('../js/venta-por-monto.js');

const r2 = (v) => Number(Number(v).toFixed(2));

function totalDelCarrito(r, { descuentoPct = 0, tasaItbis = 0, modoItbis = 'porcentaje', itbisPorUnidad = 0 } = {}) {
  const descuento = r2(r.base * (descuentoPct / 100));
  const neto = r2(r.base - descuento);
  const itbis = modoItbis === 'monto'
    ? r2(itbisPorUnidad * r.cantidad)
    : (tasaItbis > 0 ? r2(neto * (tasaItbis / 100)) : 0);
  return r2(neto + itbis);
}

describe('pruebas del documento (cantidad con 2 decimales)', () => {
  test.each([
    ['Prueba 1: RD$160/lb, total 180', 160, 180, 1.13],
    ['Prueba 2: RD$50/lb, total 125', 50, 125, 2.5],
    ['Prueba 3: RD$200/lb, total 100', 200, 100, 0.5],
  ])('%s', (_n, precio, monto, cantidad) => {
    const r = V.calcular({ monto, precio });
    expect(r.cantidad).toBe(cantidad);
    expect(r.total).toBe(monto); // el monto escrito no cambia
    expect(r.base).toBe(monto); // exento y sin descuento: el importe es el monto
    expect(totalDelCarrito(r)).toBe(monto);
  });

  test('Prueba 6: editar varias veces no acumula redondeos', () => {
    const p = { precio: 160 };
    for (const monto of [180, 175.5, 200, 180, 99.99, 180]) {
      const r = V.calcular({ ...p, monto });
      expect(totalDelCarrito(r)).toBe(r2(monto));
    }
    expect(V.calcular({ ...p, monto: 180 })).toEqual(V.calcular({ ...p, monto: 180 }));
  });
});

describe('ITBIS y descuento de la línea', () => {
  test('con ITBIS el monto ya lo incluye (no se suma otra vez)', () => {
    const p = { monto: 236, precio: 300, tasaItbis: 18 };
    const r = V.calcular(p);
    expect(r).toMatchObject({ base: 200, neto: 200, itbis: 36, total: 236, cantidad: 0.67 });
    expect(totalDelCarrito(r, p)).toBe(236);
  });

  test('el descuento queda visible: importe, descuento e ITBIS por separado', () => {
    const p = { monto: 180, precio: 160, descuentoPct: 10 };
    const r = V.calcular(p);
    expect(r).toMatchObject({ base: 200, descuento: 20, neto: 180, total: 180, cantidad: 1.25 });
    expect(totalDelCarrito(r, p)).toBe(180);
  });

  test('descuento con ITBIS', () => {
    const p = { monto: 200, precio: 160, descuentoPct: 10, tasaItbis: 18 };
    const r = V.calcular(p);
    expect(totalDelCarrito(r, p)).toBe(200);
    expect(r.total).toBe(200);
  });

  test('ITBIS de monto fijo por unidad', () => {
    const p = { monto: 150, precio: 95, modoItbis: 'monto', itbisPorUnidad: 5 };
    const r = V.calcular(p);
    expect(r).toMatchObject({ cantidad: 1.5, itbis: 7.5, total: 150 });
    expect(totalDelCarrito(r, p)).toBe(150);
  });

  test('exento sin descuento: siempre exacto al centavo', () => {
    for (let c = 100; c <= 500000; c += 113) {
      for (const precio of [45, 85, 99.99, 115, 160, 1234.5]) {
        const r = V.calcular({ monto: c / 100, precio });
        expect(totalDelCarrito(r)).toBe(c / 100);
        expect(r.total).toBe(c / 100);
      }
    }
  });

  test('con ITBIS o descuento: el carrito da lo mismo y a lo sumo a un centavo del monto', () => {
    for (let c = 100; c <= 200000; c += 97) {
      for (const descuentoPct of [0, 5, 12.5]) {
        for (const tasaItbis of [0, 16, 18]) {
          const p = { monto: c / 100, precio: 115, descuentoPct, tasaItbis };
          const r = V.calcular(p);
          expect(totalDelCarrito(r, p)).toBe(r.total);
          expect(Math.abs(r.total - c / 100)).toBeLessThanOrEqual(0.0100001);
        }
      }
    }
  });
});

// Método 3: ITBIS incluido en el precio final (cálculo inverso). La caja
// (calculateSaleItemBase) y POST /api/sales usan lineaItbisIncluido.
describe('ITBIS incluido en el precio (método 3)', () => {
  test('ejemplo del pedido: RD$118 → base 100 + ITBIS 18 = 118', () => {
    expect(V.precioBaseIncluido({ precioFinal: 118, tasaItbis: 18 })).toBeCloseTo(100, 10);
    const r = V.lineaItbisIncluido({ precioFinal: 118, cantidad: 1, tasaItbis: 18 });
    expect(r).toMatchObject({ base: 100, descuento: 0, neto: 100, itbis: 18, total: 118 });
    expect(totalDelCarrito({ ...r, cantidad: 1 }, { tasaItbis: 18 })).toBe(118);
  });

  test('cantidades: 3 × RD$118 = RD$354 (el ITBIS no se suma otra vez)', () => {
    const r = V.lineaItbisIncluido({ precioFinal: 118, cantidad: 3, tasaItbis: 18 });
    expect(r).toMatchObject({ base: 300, itbis: 54, total: 354 });
  });

  test('descuento de la línea: 10% de RD$118 → paga RD$106.20', () => {
    const p = { precioFinal: 118, cantidad: 1, descuentoPct: 10, tasaItbis: 18 };
    const r = V.lineaItbisIncluido(p);
    expect(r.total).toBe(106.2);
    expect(totalDelCarrito({ ...r, cantidad: 1 }, p)).toBe(106.2);
  });

  test('monto fijo por unidad: el ITBIS fijo sale de adentro del precio', () => {
    expect(V.precioBaseIncluido({ precioFinal: 100, modoItbis: 'monto', itbisPorUnidad: 15 })).toBe(85);
    const p = { precioFinal: 100, cantidad: 2, modoItbis: 'monto', itbisPorUnidad: 15 };
    const r = V.lineaItbisIncluido(p);
    expect(r).toMatchObject({ base: 170, itbis: 30, total: 200 });
  });

  test('redondeo: nunca cobra más que precio × cantidad, a lo sumo un centavo menos', () => {
    let exactos = 0;
    let casos = 0;
    for (let c = 1; c <= 300000; c += 211) {
      for (const cantidad of [1, 2, 3, 0.75, 1.13, 7]) {
        for (const descuentoPct of [0, 10]) {
          for (const tasaItbis of [16, 18]) {
            const p = { precioFinal: c / 100, cantidad, descuentoPct, tasaItbis };
            const r = V.lineaItbisIncluido(p);
            const esperado = r2(r2((c / 100) * cantidad) * (1 - descuentoPct / 100));
            casos += 1;
            // Lo que suma el carrito con su fórmula de siempre es lo que dice la línea.
            expect(totalDelCarrito({ ...r, cantidad }, p)).toBe(r.total);
            expect(r.total).toBeLessThanOrEqual(esperado + 1e-9);
            expect(esperado - r.total).toBeLessThanOrEqual(0.0100001);
            if (r.total === esperado) exactos += 1;
          }
        }
      }
    }
    expect(exactos / casos).toBeGreaterThan(0.8);
  });

  test('datos no válidos → null', () => {
    expect(V.lineaItbisIncluido({ precioFinal: 118, cantidad: 0, tasaItbis: 18 })).toBeNull();
    expect(V.lineaItbisIncluido({ precioFinal: 118, cantidad: 1, descuentoPct: 100, tasaItbis: 18 })).toBeNull();
  });
});

describe('validaciones', () => {
  test.each([
    [{ monto: 0, precio: 100 }],
    [{ monto: -5, precio: 100 }],
    [{ monto: 120, precio: 0 }],
    [{ monto: 'abc', precio: 100 }],
    [{ monto: 99999999, precio: 100 }],
    [{ monto: 100, precio: 100, descuentoPct: 100 }],
  ])('datos no válidos → null (%j)', (p) => {
    expect(V.calcular(p)).toBeNull();
  });

  test('la cantidad nunca baja de 0.01', () => {
    expect(V.calcular({ monto: 0.5, precio: 500 }).cantidad).toBe(0.01);
  });

  test.each([
    ['180', 180], ['180.50', 180.5], ['1,250.75', 1250.75], ['RD$ 85', 85],
  ])('leerNumero(%s) → %s', (texto, esperado) => {
    expect(V.leerNumero(texto)).toBe(esperado);
  });

  test.each([[''], ['abc']])('leerNumero(%j) no es número', (texto) => {
    expect(Number.isNaN(V.leerNumero(texto))).toBe(true);
  });
});
