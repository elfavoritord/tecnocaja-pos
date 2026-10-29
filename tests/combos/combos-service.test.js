'use strict';

const combos = require('../../server/services/combos.service');

const componentes = [
  { id: 1, codigo: 'POL', nombre: 'Pollo', cantidad: 1, precioVenta: 400, precioCompra: 250, controlaStock: true, aplicaItbis: false },
  { id: 2, codigo: 'REF', nombre: 'Refresco', cantidad: 2, precioVenta: 100, precioCompra: 60, controlaStock: true, aplicaItbis: true },
  { id: 3, codigo: 'PAP', nombre: 'Papas', cantidad: 1, precioVenta: 150, precioCompra: 80, controlaStock: true, aplicaItbis: true },
];

describe('cálculos del combo', () => {
  test('precio normal, costo, ahorro y margen', () => {
    const t = combos.computeComboTotals(componentes, 600);
    expect(t.precioNormal).toBe(750);
    expect(t.costo).toBe(450);
    expect(t.ahorro).toBe(150);
    expect(t.ganancia).toBe(150);
    expect(t.margenPct).toBe(25);
    expect(t.itbisMixto).toBe(true);
  });

  test('cuántos combos se pueden armar con la existencia', () => {
    const stock = new Map([[1, 10], [2, 7], [3, 50]]);
    // Refresco: 7 / 2 = 3 combos.
    expect(combos.computeComboAvailability(componentes, stock)).toBe(3);
    // Con 2 refrescos ya apartados en el carrito: (7-2)/2 = 2.
    expect(combos.computeComboAvailability(componentes, stock, new Map([[2, 2]]))).toBe(2);
    // Ningún componente controla existencia → sin límite.
    expect(combos.computeComboAvailability(componentes.map((c) => ({ ...c, controlaStock: false })), stock)).toBeNull();
  });
});

describe('foto de la venta e inventario', () => {
  const snapshot = combos.buildSaleSnapshot({ id: 9, codigo: 'FAM', nombre: 'Combo Familiar', precio_venta: 600 }, componentes);

  test('la foto guarda nombre, precio, componentes y costos de ese momento', () => {
    expect(snapshot).toMatchObject({ comboId: 9, codigo: 'FAM', nombre: 'Combo Familiar', precio: 600 });
    expect(snapshot.componentes).toEqual([
      expect.objectContaining({ id: 1, cantidad: 1, costoUnitario: 250, controlaStock: true }),
      expect.objectContaining({ id: 2, cantidad: 2, costoUnitario: 60 }),
      expect.objectContaining({ id: 3, cantidad: 1, costoUnitario: 80 }),
    ]);
  });

  test('4 combos descuentan 4 pollos, 8 refrescos y 4 papas', () => {
    const lines = combos.inventoryLinesForSaleItem({ combo_snapshot: JSON.stringify(snapshot) }, 4);
    expect(lines.map((l) => [l.productId, l.qty])).toEqual([[1, 4], [2, 8], [3, 4]]);
    expect(lines.every((l) => l.comboName === 'Combo Familiar')).toBe(true);
  });

  test('una línea normal se mueve a sí misma con su costo', () => {
    expect(combos.inventoryLinesForSaleItem({ product_id: 5, qty: 3, precio_compra: 12, tracks_stock: 1 })).toEqual([
      expect.objectContaining({ productId: 5, qty: 3, unitCost: 12, tracksStock: true }),
    ]);
    expect(combos.inventoryLinesForSaleItem({ product_id: null, qty: 1 })).toEqual([]);
  });

  test('el carrito suma lo que piden todos los combos y productos sueltos', () => {
    const needs = combos.aggregateStockNeeds([
      { qty: 3, componentes },
      { qty: 1, componentes },
      { productId: 2, qty: 5, tracksStock: true },
      { productId: 8, qty: 9, tracksStock: false },
    ]);
    expect(needs.get(1)).toBe(4);
    expect(needs.get(2)).toBe(8 + 5);
    expect(needs.get(3)).toBe(4);
    expect(needs.has(8)).toBe(false);
  });
});

describe('e-CF de una venta con combo', () => {
  // Mismo mapeo que processSaleForElectronicInvoicing (ecf.service.js): una
  // línea de sale_items → un <Item>. La línea del combo trae su nombre, precio
  // e ITBIS; los componentes NO son líneas facturables.
  const { generateEcfXml } = require('../../modules/ecf/services/ecf-generator');
  const { parseXml } = require('../../modules/ecf/utils/xml.util');

  test('el combo va como un solo ítem y los totales no se duplican', () => {
    const saleItems = [
      { product_name: 'Combo Familiar', qty: 2, price: 600, tax_rate: 18, combo_snapshot: JSON.stringify(combos.buildSaleSnapshot({ id: 9, codigo: 'FAM', nombre: 'Combo Familiar', precio_venta: 600 }, componentes)) },
      { product_name: 'Agua', qty: 1, price: 50, tax_rate: 18 },
    ];
    const items = saleItems.map((i) => ({ name: i.product_name, quantity: i.qty, unitPrice: i.price, discount: 0, taxRate: i.tax_rate }));
    const { xml } = generateEcfXml({
      emitter: { rnc: '40211932609', razonSocial: 'Tecno Caja POS', direccion: 'Calle 1' },
      customer: { nombre: 'Consumidor Final' },
      document: { eNCF: 'E320000000013', tipoeCF: 'E32' },
      items,
      issueDate: new Date('2026-10-29T12:00:00Z'),
    });
    const doc = parseXml(xml);
    const nombres = Array.from(doc.getElementsByTagName('NombreItem')).map((n) => n.textContent);
    expect(nombres).toEqual(['Combo Familiar', 'Agua']);
    expect(xml).not.toContain('Refresco');
    expect(doc.getElementsByTagName('MontoGravadoTotal')[0].textContent).toBe('1250.00');
    expect(doc.getElementsByTagName('TotalITBIS')[0].textContent).toBe('225.00');
    expect(doc.getElementsByTagName('MontoTotal')[0].textContent).toBe('1475.00');
  });
});

describe('validación del formulario', () => {
  test('pide nombre, código, precio y al menos un producto', () => {
    const { errores } = combos.validateComboPayload({ nombre: '', codigo: '', precio: 0, componentes: [] });
    expect(errores).toEqual(expect.arrayContaining([
      'El combo necesita un nombre.',
      'El combo necesita un código o referencia.',
      'El precio del combo debe ser mayor que cero.',
      'Agrega al menos un producto al combo.',
    ]));
  });

  test('rechaza cantidades en cero o negativas y productos repetidos', () => {
    expect(combos.validateComboPayload({ nombre: 'X', codigo: 'X', precio: 1, componentes: [{ id: 1, cantidad: 0 }] }).errores)
      .toContain('Cada producto del combo debe tener una cantidad mayor que cero.');
    expect(combos.validateComboPayload({ nombre: 'X', codigo: 'X', precio: 1, componentes: [{ id: 1, cantidad: -2 }] }).errores)
      .toContain('Cada producto del combo debe tener una cantidad mayor que cero.');
    expect(combos.validateComboPayload({ nombre: 'X', codigo: 'X', precio: 1, componentes: [{ id: 1, cantidad: 1 }, { id: 1, cantidad: 2 }] }).errores[0])
      .toMatch(/repetido/);
  });

  test('un combo válido no tiene errores', () => {
    const { errores, datos } = combos.validateComboPayload({
      nombre: ' Combo Familiar ', codigo: 'FAM', precio: '600', componentes: [{ id: 1, cantidad: 1 }, { id: 2, cantidad: '2' }],
    });
    expect(errores).toEqual([]);
    expect(datos).toMatchObject({ nombre: 'Combo Familiar', codigo: 'FAM', precio: 600, activo: true });
    expect(datos.componentes).toEqual([{ id: 1, cantidad: 1 }, { id: 2, cantidad: 2 }]);
  });
});
