'use strict';
// Precio cambiado en la venta (F3): reglas del servidor (server/sales/precio-manual.js)
// y que la pantalla de ventas tenga la tecla y el botón.
const fs = require('fs');
const path = require('path');
const { precioManualDeLinea } = require('../server/sales/precio-manual');

const producto = { id: 1, nombre: 'Galletas', precio_venta: 100 };

describe('precioManualDeLinea', () => {
  test('sin precio cambiado → null (todo como siempre)', () => {
    expect(precioManualDeLinea({ id: 1 }, { product: producto })).toBeNull();
    expect(precioManualDeLinea({ id: 1, precioManual: null }, { product: producto })).toBeNull();
    expect(precioManualDeLinea({ id: 1, precioManual: '' }, { product: producto })).toBeNull();
  });

  test('precio válido → con 2 decimales', () => {
    expect(precioManualDeLinea({ id: 1, precioManual: 90 }, { product: producto })).toBe(90);
    expect(precioManualDeLinea({ id: 1, precioManual: '85.456' }, { product: producto })).toBe(85.46);
  });

  test.each([[0], [-5], ['abc'], [100000000]])('precio no válido (%p) → 400', (precioManual) => {
    expect(() => precioManualDeLinea({ id: 1, precioManual }, { product: producto })).toThrow(/no es válido/);
  });

  test.each([
    ['producto por peso', { porPeso: true }],
    ['venta rápida', { isQuickSale: true }],
    ['combo', { comboSnapshot: { nombre: 'Combo' } }],
    ['combo personalizado', { customCombo: { precioLinea: 50 } }],
    ['pedido online', { agreed: { price: 80 } }],
  ])('no se puede en %s → 400', (_n, extra) => {
    let error = null;
    try { precioManualDeLinea({ id: 1, precioManual: 90 }, { product: producto, ...extra }); } catch (e) { error = e; }
    expect(error?.statusCode).toBe(400);
    expect(error?.message).toMatch(/no se puede cambiar/);
  });

  test('tampoco junto con el total editado de peso', () => {
    expect(() => precioManualDeLinea({ id: 1, precioManual: 90, montoFinal: 180 }, { product: producto })).toThrow(/no se puede cambiar/);
  });
});

describe('pantalla de ventas', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const ventas = fs.readFileSync(path.join(__dirname, '..', 'js', 'ventas.js'), 'utf8');

  test('F3 abre el cambio de precio fuera de la ventana de cobro', () => {
    const f3 = ui.indexOf("if (e.key === 'F3')");
    expect(f3).toBeGreaterThan(ui.indexOf('if (!isVentasActive)'));
    expect(ui.slice(f3, f3 + 400)).toMatch(/startSelectedSaleLinePriceEdit\(\)/);
  });

  test('botón "Precio" con F3 en la barra de ventas', () => {
    expect(html).toMatch(/onclick="startSelectedSaleLinePriceEdit\(\)"[\s\S]{0,400}<kbd class="tc-kbd">F3<\/kbd>/);
  });

  test('los productos por peso no cambian de precio', () => {
    const def = ventas.slice(ventas.indexOf('function canEditSaleLinePrice'), ventas.indexOf('function getSaleLineEditablePrice'));
    expect(def).toMatch(/isWeightSaleItem\(item\)/);
  });
});
