'use strict';
// Cobrar con tarjeta o transferencia no exige comprobante fiscal: antes la tarjeta
// forzaba B02 y, sin secuencia B02 activa, no se podía cobrar (ni elegir Ticket).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ventas = fs.readFileSync(path.join(__dirname, '../js/ventas.js'), 'utf8');

function cargarSetPayMethod(DB) {
  const start = ventas.indexOf('function setPayMethod(method, el)');
  const fin = ventas.slice(start).match(/\r?\n\}\r?\n/);
  const end = start + fin.index + fin[0].length;
  const context = vm.createContext({
    DB,
    billingModalState: {},
    document: { querySelectorAll: () => [], getElementById: () => null },
    setSaleNcfType: jest.fn(), setSaleOrderType: jest.fn(), showToast: jest.fn(),
    updateTotals: jest.fn(), calcCambio: jest.fn(), calcMixto: jest.fn(),
    calcCambioUsd: jest.fn(), calcCambioContraEntrega: jest.fn(),
    syncBillingModalFooter: jest.fn(), syncBillingConfirmSummary: jest.fn(),
    ensureBillingModalFitsContent: jest.fn(), fmt: (n) => String(n), parseFmt: Number,
  });
  vm.runInContext(ventas.slice(start, end), context);
  return context;
}

test.each(['tarjeta', 'transferencia'])('cobrar con %s deja el Ticket sin pedir secuencias', (method) => {
  const DB = { payMethod: 'efectivo', saleNcfType: '', saleDocumentType: 'ticket' };
  const ctx = cargarSetPayMethod(DB);
  ctx.setPayMethod(method, null);
  expect(DB.payMethod).toBe(method);
  expect(ctx.setSaleNcfType).not.toHaveBeenCalled();
  expect(DB.saleNcfType).toBe('');
});

test('cambiar a tarjeta respeta el comprobante que eligió el cajero', () => {
  const DB = { payMethod: 'efectivo', saleNcfType: 'B01', saleDocumentType: 'ticket' };
  const ctx = cargarSetPayMethod(DB);
  ctx.setPayMethod('tarjeta', null);
  expect(ctx.setSaleNcfType).not.toHaveBeenCalled();
  expect(DB.saleNcfType).toBe('B01');
});
