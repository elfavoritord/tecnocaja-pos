'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ventas = fs.readFileSync(path.join(__dirname, '../js/ventas.js'), 'utf8');
const mesas = fs.readFileSync(path.join(__dirname, '../js/mesas.js'), 'utf8');

test('preparar precuenta guarda el consumo y abre una consulta sin cobrar ni cerrar la mesa', async () => {
  const start = mesas.indexOf("barra.querySelector('#mesas-precuenta').onclick = ") + "barra.querySelector('#mesas-precuenta').onclick = ".length;
  const end = mesas.indexOf('\n    };\n  }\n  async function guardarCuenta', start) + '\n    }'.length;
  const activa = { id: 'cuenta-1', version: 4, draft: { tableLabel: 'M-3', meseroId: 'm1' } };
  const context = vm.createContext({
    activa, confirm: () => true, guardarCuenta: jest.fn(async () => {}),
    calculateCurrentSaleTotals: () => ({ total: 118, subtotal: 100, itbis: 18 }),
    meseros: [{ id: 'm1', nombre: 'Ana' }], DB: { saleItems: [{ nombre: 'Almuerzo', qty: 1, precio: 100 }] },
    cloneSaleData: (items) => JSON.parse(JSON.stringify(items)), getSelectedSaleClient: () => null,
    window: { showReceiptPreview: jest.fn() }, error: jest.fn(),
    finalizePendingSale: jest.fn(), openBillingModal: jest.fn(),
  });
  vm.runInContext(`globalThis.precuenta = ${mesas.slice(start, end)}`, context);
  await context.precuenta();
  expect(context.error).not.toHaveBeenCalled();
  expect(context.guardarCuenta).toHaveBeenCalledTimes(1);
  expect(context.window.showReceiptPreview).toHaveBeenCalledWith(expect.objectContaining({
    isPrecuenta: true, total: 118, mesa: 'M-3', mesero: 'Ana', recibido: 0,
    receiptDocumentNumber: 'PENDIENTE DE PAGO',
  }), expect.anything());
  expect(context.activa).toBe(activa);
  expect(context.finalizePendingSale).not.toHaveBeenCalled();
  expect(context.openBillingModal).not.toHaveBeenCalled();
});

test.each([true, false])('la acción de vista previa imprime por la ruta real y conserva la venta en curso (impresora ok=%s)', async (ok) => {
  const printer = jest.fn(async () => ({ ok, error: ok ? null : 'Impresora no disponible' }));
  const previousSale = { id: 'otra-venta' }, previousOptions = { pending: true };
  const context = vm.createContext({
    currentReceiptSale: previousSale, currentReceiptOptions: previousOptions, receiptPreviewPrintArmed: false,
    window: { novaDesktop: { printReceiptEscpos: printer, openCashDrawer: jest.fn() } },
    showToast: jest.fn(), isElectronicReceipt: () => false,
    getReceiptConfigValue: (key) => ({ receiptPaperSize: '80mm', receiptPrinterName: 'Ticketera' }[key]),
    resolveReceiptPrinterName: async () => 'Ticketera',
    buildEscposReceiptPayload: jest.fn(async (sale) => ({ content: sale.receiptDocumentTitle })),
    console: { warn: jest.fn() }, finalizePendingSale: jest.fn(),
  });
  const start = ventas.indexOf('async function printReceipt(venta =');
  const end = ventas.indexOf('\nfunction renderReceiptFooter', start);
  vm.runInContext(ventas.slice(start, end), context);
  const sale = { isPrecuenta: true, total: 118, receiptDocumentTitle: 'PRECUENTA / ESTADO DE CUENTA' };
  expect(await context.printReceiptFromPreview(sale)).toBe(ok);
  expect(printer).toHaveBeenCalledTimes(1);
  expect(context.currentReceiptSale).toBe(previousSale);
  expect(context.currentReceiptOptions).toBe(previousOptions);
  expect(context.receiptPreviewPrintArmed).toBe(false);
  expect(context.finalizePendingSale).not.toHaveBeenCalled();
  expect(context.window.novaDesktop.openCashDrawer).not.toHaveBeenCalled();
});
