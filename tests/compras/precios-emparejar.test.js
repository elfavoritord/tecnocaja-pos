'use strict';
// Precio de venta desde «Preparar compra» (js/compras-precios.js) y reconocimiento
// de productos (server/services/compras/emparejar-productos.js).
const P = require('../../js/compras-precios');
const { emparejarLinea, normalizarTexto, codigoBarrasValido } = require('../../server/services/compras/emparejar-productos');

// Lo que cobra la venta por 1 unidad (js/ventas.js calculateSaleItemTax: toFixed(2) por línea).
const finalVenta = (base, tasa) => Number((base + Number((base * tasa / 100).toFixed(2))).toFixed(2));

describe('precio de venta: ITBIS aparte, incluido o exento', () => {
  test('base + ITBIS: el ITBIS se suma con el redondeo de la venta', () => {
    const r = P.precioVenta({ modo: 'base', precio: 84.75, tasa: 18 });
    expect(r).toMatchObject({ base: 84.75, itbis: 15.26, final: 100.01, aplicaItbis: true, exacto: true });
    expect(r.final).toBe(finalVenta(84.75, 18));
  });
  test('incluido: el cliente paga exactamente el precio escrito cuando existe esa base', () => {
    for (const precio of [118, 59, 236.5, 1180, 35.4, 2.36]) {
      const r = P.precioVenta({ modo: 'incluido', precio, tasa: 18 });
      expect(finalVenta(r.base, 18)).toBe(r.final);
      if (r.exacto) expect(r.final).toBe(precio);
    }
    expect(P.precioVenta({ modo: 'incluido', precio: 118, tasa: 18 })).toMatchObject({ base: 100, itbis: 18, final: 118, exacto: true });
  });
  test('incluido sin base exacta (100 con 18 %): propone el más cercano sin pasarse y lo dice', () => {
    const r = P.precioVenta({ modo: 'incluido', precio: 100, tasa: 18 });
    expect(r).toMatchObject({ base: 84.74, final: 99.99, exacto: false });
    expect(r.aviso).toMatch(/más cercano es RD\$ 99\.99/);
    expect(finalVenta(r.base, 18)).toBe(99.99);
  });
  test('la tasa sale de la configuración: con 16 % u otra tasa también cuadra', () => {
    const r = P.precioVenta({ modo: 'incluido', precio: 116, tasa: 16 });
    expect(r).toMatchObject({ base: 100, final: 116, exacto: true });
    expect(P.precioVenta({ modo: 'base', precio: 50, tasa: 0 })).toMatchObject({ itbis: 0, final: 50, aplicaItbis: false });
  });
  test('exento: sin ITBIS', () => {
    expect(P.precioVenta({ modo: 'exento', precio: 75, tasa: 18 })).toMatchObject({ base: 75, itbis: 0, final: 75, aplicaItbis: false });
  });
  test('valores inválidos se rechazan', () => {
    expect(() => P.precioVenta({ modo: 'raro', precio: 10, tasa: 18 })).toThrow(/ITBIS/);
    expect(() => P.precioVenta({ modo: 'base', precio: -1, tasa: 18 })).toThrow(/no es válido/);
    expect(() => P.precioVenta({ modo: 'base', precio: 10, tasa: 180 })).toThrow(/tasa/);
  });
  test('margen sobre el costo y sobre la venta, y ganancia', () => {
    expect(P.baseDesdeMargen({ costo: 250, margen: 20, tipo: 'costo' })).toBe(300);
    expect(P.baseDesdeMargen({ costo: 240, margen: 20, tipo: 'venta' })).toBe(300);
    expect(() => P.baseDesdeMargen({ costo: 10, margen: 100, tipo: 'venta' })).toThrow(/menor de 100/);
    expect(P.precioDesdeMargen({ costo: 250, margen: 20, tipo: 'costo', modo: 'incluido', tasa: 18 })).toBe(354);
    expect(P.ganancia({ costo: 250, base: 300 })).toEqual({ ganancia: 50, margenCosto: 20, margenVenta: 16.67, perdida: false });
    expect(P.ganancia({ costo: 300, base: 250 }).perdida).toBe(true);
  });
});

describe('reconocer productos de la factura', () => {
  const productos = [
    { id: 1, codigo: 'ARZ5', barcode: '7501234567893', nombre: 'Arroz Selecto 5 lb', estado: 'Activo' },
    { id: 2, codigo: 'CC2', barcode: 'CC2', nombre: 'Coca Cola 2 L', estado: 'Activo' },
    { id: 3, codigo: 'CC1', barcode: 'CC1', nombre: 'Coca Cola 1 L', estado: 'Activo' },
    { id: 4, codigo: 'ACE', barcode: 'ACE', nombre: 'Aceite Crisol 1 Litro', estado: 'Activo' },
  ];
  test('normaliza tildes, signos y unidades', () => {
    expect(normalizarTexto('Coca-Cola 2 Lts.')).toBe('coca cola 2 l');
    expect(normalizarTexto('Café 500GR')).toBe('cafe 500 g');
    expect(normalizarTexto('Aceite 1 litro')).toBe('aceite 1 l');
  });
  test('código de barras con dígito de control válido', () => {
    expect(codigoBarrasValido('7501234567893')).toBe(true);
    expect(codigoBarrasValido('7501234567890')).toBe(false);
    expect(codigoBarrasValido('ABC123')).toBe(false);
  });
  test('orden: código de barras, código, equivalencia del proveedor, nombre idéntico', () => {
    expect(emparejarLinea({ codigoBarras: '7501234567893', descripcion: 'otra cosa' }, { productos })).toMatchObject({ productoId: 1, metodo: 'codigo_barras' });
    expect(emparejarLinea({ codigo: 'cc2' }, { productos })).toMatchObject({ productoId: 2, metodo: 'codigo' });
    expect(emparejarLinea({ codigoProveedor: 'DIST-9', descripcion: 'Refresco' }, { productos, equivalencias: [{ product_id: 3, codigo_proveedor: 'dist-9' }] }))
      .toMatchObject({ productoId: 3, metodo: 'equivalencia' });
    expect(emparejarLinea({ descripcion: 'ACEITE CRISOL 1 LT' }, { productos })).toMatchObject({ productoId: 4, metodo: 'nombre_exacto' });
  });
  test('nombres parecidos con otra medida NO se unen ni se sugieren', () => {
    const r = emparejarLinea({ descripcion: 'Coca Cola 3 L' }, { productos });
    expect(r.productoId).toBeNull();
    expect(r.sugerencias).toEqual([]);
  });
  test('parecido con la misma medida: solo sugerencia, el usuario decide', () => {
    const r = emparejarLinea({ descripcion: 'Arroz 5 lb Selecto Premium' }, { productos });
    expect(r.productoId).toBeNull();
    expect(r.sugerencias.map((s) => s.id)).toEqual([1]);
  });
  test('un producto eliminado no se reconoce', () => {
    expect(emparejarLinea({ codigo: 'X1' }, { productos: [{ id: 9, codigo: 'X1', nombre: 'X', estado: 'eliminado' }] }).productoId).toBeNull();
  });
});
