'use strict';

/**
 * Motor de los Combos personalizados (js/combos-personalizados-motor.js).
 * Además de las reglas, compara cada línea con las funciones REALES del
 * carrito (sacadas de js/ventas.js): si alguien cambia el redondeo del
 * carrito, el combo dejaría de cuadrar con la factura y esta prueba lo avisa.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const motor = require('../../js/combos-personalizados-motor');
const { nearestCatalogTaxRate } = require('../../server/services/tax-catalog');

const TASA = 18;

function sacarFuncion(fuente, nombre) {
  const inicio = fuente.indexOf(`function ${nombre}(`);
  if (inicio < 0) throw new Error(`No encontré ${nombre} en js/ventas.js`);
  // El cuerpo empieza en ") {" (los parámetros pueden traer "= {}").
  const cuerpo = /\)\s*\{/g;
  cuerpo.lastIndex = inicio;
  const encontrado = cuerpo.exec(fuente);
  let i = encontrado.index + encontrado[0].length - 1;
  let nivel = 0;
  for (; i < fuente.length; i += 1) {
    if (fuente[i] === '{') nivel += 1;
    else if (fuente[i] === '}') {
      nivel -= 1;
      if (nivel === 0) return fuente.slice(inicio, i + 1);
    }
  }
  throw new Error(`No pude cerrar ${nombre}`);
}

// Las funciones del carrito, tal cual están en js/ventas.js.
function cargarCarrito() {
  const fuente = fs.readFileSync(path.join(__dirname, '../../js/ventas.js'), 'utf8');
  const nombres = [
    'roundSaleMoney', 'getSaleTaxConfig', 'calculateSaleItemBase', 'calculateSaleItemDiscount',
    'calculateSaleItemNet', 'saleVaSinItbis', 'calculateSaleItemTax', 'calcItemTotal',
  ];
  const contexto = { DB: { config: { itbis: TASA }, saleDocumentType: 'ticket', saleEcfType: null } };
  vm.createContext(contexto);
  vm.runInContext(`${nombres.map((n) => sacarFuncion(fuente, n)).join('\n')}\nthis.calcItemTotal = calcItemTotal;`, contexto);
  return contexto;
}
const carrito = cargarCarrito();
const centavosCarrito = (item) => Math.round(carrito.calcItemTotal(item) * 100);

// Una línea del carrito como la arma buildSaleItem() para un producto suelto.
function itemSuelto(p, qty) {
  return {
    precio: p.precio,
    qty,
    descuento: 0,
    itbisModo: p.aplicaItbis && p.itbisModo === 'monto' ? 'monto' : 'porcentaje',
    itbisMontoUnit: p.aplicaItbis && p.itbisModo === 'monto' ? p.itbisMonto : 0,
    itbis: p.aplicaItbis && p.itbisModo !== 'monto' ? TASA : 0,
  };
}
// Una fila de combo como la arma buildCustomComboSaleItem().
const itemDeFila = (f) => ({ precio: f.precio, qty: f.qty, descuento: 0, itbisModo: 'porcentaje', itbisMontoUnit: 0, itbis: f.tasa });

const hamburguesa = { id: 1, precio: 84.75, aplicaItbis: true, itbisModo: 'porcentaje' };
const refresco = { id: 2, precio: 42.37, aplicaItbis: true, itbisModo: 'porcentaje' };
const papas = { id: 3, precio: 50, aplicaItbis: false };
const cerveza = { id: 4, precio: 80, aplicaItbis: true, itbisModo: 'monto', itbisMonto: 20 };

// Generador repetible para las pruebas con muchos casos.
function azar(semilla) {
  let s = semilla >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('lineaCentavos (igual que el carrito)', () => {
  test('gravado, exento e ITBIS fijo', () => {
    expect(motor.lineaCentavos({ precio: 100, aplicaItbis: true }, 1, { tasa: TASA })).toEqual({ neto: 10000, itbis: 1800, total: 11800 });
    expect(motor.lineaCentavos(papas, 2, { tasa: TASA })).toEqual({ neto: 10000, itbis: 0, total: 10000 });
    expect(motor.lineaCentavos(cerveza, 3, { tasa: TASA })).toEqual({ neto: 24000, itbis: 6000, total: 30000 });
  });

  test('coincide con calcItemTotal del carrito real en muchos precios y cantidades', () => {
    const productos = [hamburguesa, refresco, papas, cerveza];
    for (let c = 1; c <= 30000; c += 37) productos.push({ precio: c / 100, aplicaItbis: true, itbisModo: 'porcentaje' });
    for (const p of productos) {
      for (const qty of [1, 2, 3, 7]) {
        expect(motor.lineaCentavos(p, qty, { tasa: TASA }).total).toBe(centavosCarrito(itemSuelto(p, qty)));
      }
    }
  });
});

describe('tasaDeLinea', () => {
  test('18 % general, exento 0 y el ITBIS fijo a la tasa de la DGII más cercana (como el e-CF)', () => {
    expect(motor.tasaDeLinea(hamburguesa, 18)).toBe(18);
    expect(motor.tasaDeLinea(papas, 18)).toBe(0);
    expect(motor.tasaDeLinea(cerveza, 18)).toBe(nearestCatalogTaxRate(20, 80));
    expect(motor.tasaDeLinea({ precio: 100, aplicaItbis: true, itbisModo: 'monto', itbisMonto: 16 }, 18)).toBe(16);
  });
});

describe('repartirCombo', () => {
  test('el precio elegido (ITBIS incluido) se cobra exacto, sin ITBIS por encima', () => {
    const r = motor.repartirCombo({ precio: 500, seleccion: [{ ...hamburguesa, qty: 2 }, { ...papas, qty: 3 }, { ...refresco, qty: 3 }], tasa: TASA });
    expect(r.sumaCentavos).toBe(50000);
    expect(r.diferenciaCentavos).toBe(0);
    expect(r.filas.reduce((a, f) => a + f.neto + f.itbis, 0)).toBe(50000);
  });

  test('cada producto recibe una parte proporcional a su precio normal', () => {
    // Normal: 2 × 50 exentos (100) y 1 × 100 exento: 200. A RD$150 cada mitad vale 75.
    const r = motor.repartirCombo({ precio: 150, seleccion: [{ ...papas, qty: 2 }, { id: 9, precio: 100, aplicaItbis: false, qty: 1 }], tasa: TASA });
    expect(r.normalCentavos).toBe(20000);
    expect(r.filas.filter((f) => f.id === papas.id).reduce((a, f) => a + f.total, 0)).toBe(7500);
    expect(r.filas.find((f) => f.id === 9).total).toBe(7500);
  });

  test('la base y el ITBIS salen de la tasa de cada producto (gravado y exento)', () => {
    const r = motor.repartirCombo({ precio: 236, seleccion: [{ id: 1, precio: 100, aplicaItbis: true, qty: 1 }, { id: 2, precio: 100, aplicaItbis: false, qty: 1 }], tasa: TASA });
    const grav = r.filas.find((f) => f.id === 1);
    const exen = r.filas.find((f) => f.id === 2);
    // Normal: 118 + 100 = 218 → a 236 la parte gravada es 127.83 (base 108.33 + ITBIS 19.50).
    expect(grav.tasa).toBe(18);
    expect(grav.itbis).toBe(motor.lineaCentavos({ precio: grav.precio, aplicaItbis: true }, grav.qty, { tasa: 18 }).itbis);
    expect(exen.itbis).toBe(0);
    expect(grav.total + exen.total).toBe(23600);
  });

  test('si la base no divide exacto entre la cantidad, dos filas del mismo producto', () => {
    const r = motor.repartirCombo({ precio: 100, seleccion: [{ ...papas, qty: 3 }], tasa: TASA });
    expect(r.filas.map((f) => [f.qty, f.precio])).toEqual([[2, 33.33], [1, 33.34]]);
    expect(r.sumaCentavos).toBe(10000);
  });

  test('el precio puede ser mayor que el valor normal (no hay límites)', () => {
    const r = motor.repartirCombo({ precio: 999.99, seleccion: [{ ...cerveza, qty: 7 }, { ...refresco, qty: 3 }], tasa: TASA });
    expect(r.normalCentavos).toBe(84999);
    expect(r.sumaCentavos).toBe(99999);
  });

  test('guarda el precio de catálogo de cada producto (trazabilidad)', () => {
    const r = motor.repartirCombo({ precio: 120, seleccion: [{ ...hamburguesa, qty: 1 }, { ...papas, qty: 1 }], tasa: TASA });
    expect(r.filas.map((f) => f.precioOriginal)).toEqual([84.75, 50]);
  });

  test('es repetible: el servidor y la pantalla llegan a las mismas filas', () => {
    const sel = [{ ...refresco, qty: 5 }, { ...hamburguesa, qty: 2 }, { ...papas, qty: 1 }];
    expect(motor.repartirCombo({ precio: 333.33, seleccion: sel, tasa: TASA })).toEqual(motor.repartirCombo({ precio: 333.33, seleccion: sel, tasa: TASA }));
  });

  test('mil combos al azar: cada fila cuadra con el carrito, precio × cantidad = neto y el precio sale exacto', () => {
    const r = azar(20261104);
    for (let caso = 0; caso < 1000; caso += 1) {
      const n = 1 + Math.floor(r() * 5);
      const seleccion = Array.from({ length: n }, (_, i) => {
        const tipo = r();
        return {
          id: i + 1,
          precio: Math.round(r() * 50000) / 100,
          aplicaItbis: tipo > 0.3,
          itbisModo: tipo > 0.9 ? 'monto' : 'porcentaje',
          itbisMonto: Math.round(r() * 3000) / 100,
          qty: 1 + Math.floor(r() * 6),
        };
      });
      const precio = Math.round(r() * 200000) / 100 + 0.01;
      const res = motor.repartirCombo({ precio, seleccion, tasa: TASA });
      // Nunca se cobra de más. El único caso sin el centavo exacto: una sola
      // unidad de un solo producto gravado (con ITBIS por línea, 84.74 + 18% =
      // 99.99 y 84.75 + 18% = 100.01: 100.00 no existe). Ahí paga 1 centavo menos.
      const unaUnidadGravada = seleccion.length === 1 && seleccion[0].qty === 1 && motor.tasaDeLinea(seleccion[0], TASA) > 0;
      expect(res.diferenciaCentavos).toBeGreaterThanOrEqual(0);
      expect(res.diferenciaCentavos).toBeLessThanOrEqual(unaUnidadGravada ? 1 : 0);
      for (const f of res.filas) {
        expect(Math.abs(f.precio * 100 - Math.round(f.precio * 100))).toBeLessThan(1e-6); // 2 decimales
        expect(Math.round(f.precio * f.qty * 100)).toBe(f.neto);
        expect(f.total).toBe(centavosCarrito(itemDeFila(f)));
      }
      // Cantidades: las filas suman lo elegido de cada producto.
      for (const p of seleccion) {
        expect(res.filas.filter((f) => f.id === p.id).reduce((a, f) => a + f.qty, 0)).toBe(p.qty);
      }
    }
  });

  test('sin productos o sin precio no reparte nada', () => {
    expect(motor.repartirCombo({ precio: 100, seleccion: [], tasa: TASA }).filas).toEqual([]);
    expect(motor.repartirCombo({ precio: 0, seleccion: [{ ...papas, qty: 1 }], tasa: TASA }).filas).toEqual([]);
  });
});
