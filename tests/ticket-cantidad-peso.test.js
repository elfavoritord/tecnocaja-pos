'use strict';
// La cantidad de un producto por peso en el ticket 58/80 mm: salía "2..." en
// pantalla y "12.2" en la impresora porque "2.50lb" no cabía en CANT. Ahora la
// columna se ensancha y nunca se corta el número.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ESCPOSBuilder, buildReceipt } = require('../electron/thermal-printer');

function lineasImpresas(data) {
  const lineas = [];
  const original = ESCPOSBuilder.prototype.text;
  ESCPOSBuilder.prototype.text = function (str) { lineas.push(String(str)); return original.call(this, str); };
  try { buildReceipt(data); } finally { ESCPOSBuilder.prototype.text = original; }
  return lineas;
}

const items = [
  { cantidad: 2.5, cantidadTexto: '2.50lb', descripcion: 'Pollo', precio: 100, subtotal: 250, itbisTexto: '' },
  { cantidad: 12.25, cantidadTexto: '12.25lb', descripcion: 'Queso de freír', precio: 300, subtotal: 3675, itbisTexto: '18%' },
  { cantidad: 1, cantidadTexto: '1', descripcion: 'Arroz', precio: 50, subtotal: 50, itbisTexto: '' },
];

describe('impresora (ESC/POS)', () => {
  test.each(['80mm', '58mm'])('%s: la cantidad por peso sale completa y la línea cabe', (paperWidth) => {
    const lineas = lineasImpresas({ negocio: { nombre: 'Colmado' }, venta: { numeroFactura: 'F1', items, total: 3975 }, config: { paperWidth } });
    const pollo = lineas.find((l) => l.startsWith('Pollo'));
    const queso = lineas.find((l) => l.startsWith('Queso') || l.startsWith('Ques'));
    expect(pollo).toMatch(/2\.50(lb)?\s/);
    expect(queso).toMatch(/12\.25(lb)?\s/);
    const cols = new ESCPOSBuilder(paperWidth).cols;
    for (const l of [pollo, queso]) expect(l.length).toBeLessThanOrEqual(cols);
  });
});

describe('pantalla (js/ventas.js → buildThermalItemLines)', () => {
  // Se carga solo lo necesario de ventas.js en un contexto aislado.
  const fuente = fs.readFileSync(path.join(__dirname, '..', 'js', 'ventas.js'), 'utf8');
  const tomar = (nombre) => {
    const inicio = fuente.indexOf(`function ${nombre}(`);
    let i = fuente.indexOf('{', inicio);
    let nivel = 0;
    for (; i < fuente.length; i += 1) {
      if (fuente[i] === '{') nivel += 1;
      else if (fuente[i] === '}') { nivel -= 1; if (nivel === 0) break; }
    }
    return fuente.slice(inicio, i + 1);
  };
  const codigo = ['clipThermalText', 'padThermalRight', 'padThermalLeft', 'wrapThermalText', 'getThermalItemItbisText', 'buildThermalItemLines']
    .map(tomar).join('\n');
  const contexto = {
    normalizeReceiptText: (v) => String(v ?? '').replace(/\s+/g, ' ').trim(),
    formatCustomComboDetailLines: () => [],
    formatReceiptSaleItemQuantity: (item) => (item.saleMode === 'peso' ? `${Number(item.qty).toFixed(2)}lb` : String(item.qty)),
    formatSaleItemQuantity: (item) => (item.saleMode === 'peso' ? Number(item.qty).toFixed(2) : String(item.qty)),
  };
  vm.createContext(contexto);
  vm.runInContext(`${codigo}\nthis.buildThermalItemLines = buildThermalItemLines;`, contexto);

  const venta = [
    { nombre: 'Pollo', qty: 2.5, saleMode: 'peso', precio: 100, total: 250, itbisRate: 0 },
    { nombre: 'Queso de freír', qty: 12.25, saleMode: 'peso', precio: 300, total: 3675, itbisRate: 18 },
    { nombre: 'Arroz', qty: 1, saleMode: 'unidad', precio: 50, total: 50, itbisRate: 0 },
  ];

  test.each([['80mm', 48], ['58mm', 32]])('%s: sin "..." en la cantidad', (papel, ancho) => {
    const lineas = contexto.buildThermalItemLines(venta, ancho, papel);
    const pollo = lineas.find((l) => l.startsWith('Pollo'));
    const queso = lineas.find((l) => l.startsWith('Que'));
    expect(pollo).not.toMatch(/\d\.\.\./);
    expect(pollo).toMatch(/2\.50(lb)?\s/);
    // En 58 mm, con la columna ITBIS, un peso de dos cifras va con un decimal.
    expect(queso).toMatch(papel === '80mm' ? /12\.25(lb)?\s/ : /12\.3\s/);
    expect(queso).not.toMatch(/\s1\.\.\./);
    for (const l of lineas) expect(l.length).toBeLessThanOrEqual(ancho);
  });
});
