'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

describe('venta rápida sin inventario', () => {
  test('la pantalla expone el botón y el formulario calcula el total', () => {
    const html = read('index.html');
    const salesJs = read('js/ventas.js');

    expect(html).toContain('onclick="openQuickSaleModal()"');
    expect(salesJs).toContain('function syncQuickSaleTotal()');
    expect(salesJs).toContain('function addQuickSaleItem()');
    expect(salesJs).toContain("document.getElementById('modal-overlay')");
    expect(salesJs).toContain("quickSale: true");
    expect(salesJs).toContain('calcItemTotal(buildQuickSaleItem');
  });

  test('el payload conserva la marca de venta rápida', () => {
    const salesJs = read('js/ventas.js');
    expect(salesJs).toContain('quickSale: normalizedItem.quickSale === true');
    expect(salesJs).toContain("codigo: normalizedItem.codigo || ''");
  });

  test('sale_items permite producto nulo y conserva el nombre escrito', () => {
    const schema = read('db/schema.sql');
    expect(schema).toMatch(/CREATE TABLE sale_items[\s\S]*?product_id INT DEFAULT NULL/);
    expect(schema).toMatch(/CREATE TABLE sale_items[\s\S]*?item_name VARCHAR\(255\)/);
    expect(schema).toMatch(/CREATE TABLE sale_items[\s\S]*?is_quick_sale TINYINT\(1\)/);
  });

  test('el servidor online no consulta ni descuenta inventario para la línea rápida', () => {
    const server = read('server.js');
    expect(server).toContain("const isQuickSale = item.quickSale === true && !Number(item.id || 0)");
    expect(server).toContain('isQuickSale ? null : item.id');
    expect(server).toContain('isQuickSale ? quickName : null');
    expect(server).toContain('if (!isQuickSale && shouldDiscountInventoryNow');
  });

  test('la sincronización offline conserva la línea sin movimiento de inventario', () => {
    const offline = read('server/routes/offline.routes.js');
    expect(offline).toContain('if (saleId && (productId || isQuickSale))');
    expect(offline).toContain('isQuickSale ? null : productId');
    expect(offline).toContain('if (!isQuickSale) {');
  });

  test('e-CF y reportes leen primero el nombre guardado en la línea', () => {
    const repository = read('modules/ecf/models/ecf.repository.js');
    const server = read('server.js');
    expect(repository).toContain("COALESCE(si.item_name, p.nombre, 'Producto') AS product_name");
    expect(server).toContain("COALESCE(si.item_name, p.nombre, 'Producto') AS product_name");
  });
});
