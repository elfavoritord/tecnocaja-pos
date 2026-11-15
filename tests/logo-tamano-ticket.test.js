'use strict';
// Tamaño del logo en el ticket térmico (Configuración → Datos del Negocio):
// el % reduce el ancho de siempre (400 puntos en 80 mm, 280 en 58 mm).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const FacturaPlantillas = require('../js/factura-plantillas.js');

const ventas = fs.readFileSync(path.join(__dirname, '../js/ventas.js'), 'utf8');

function cargar(config, conPlantillas = true) {
  const start = ventas.indexOf('// Tamaño del logo (Configuración → Datos del Negocio)');
  const end = ventas.indexOf('async function convertLogoToEscposMonochrome(', start);
  const context = vm.createContext({
    window: conPlantillas ? { FacturaPlantillas } : {},
    getReceiptConfigValue: (campo) => config[campo] ?? '',
  });
  vm.runInContext(ventas.slice(start, end), context);
  return context;
}

test('sin ajuste el logo sale como siempre', () => {
  const ctx = cargar({});
  expect(ctx.getReceiptLogoScaleFactor()).toBe(1);
  expect(ctx.getReceiptLogoMaxPx('80mm')).toBe(400);
  expect(ctx.getReceiptLogoMaxPx('58mm')).toBe(280);
});

test('el porcentaje guardado reduce el logo y respeta los límites', () => {
  expect(cargar({ invoiceLogoScale: 50 }).getReceiptLogoScaleFactor()).toBe(0.5);
  expect(cargar({ invoiceLogoScale: 10 }).getReceiptLogoScaleFactor()).toBe(0.3);
  expect(cargar({ invoiceLogoScale: 180 }).getReceiptLogoScaleFactor()).toBe(1);
});

test('funciona aunque no hayan cargado las plantillas', () => {
  expect(cargar({ invoiceLogoScale: 60 }, false).getReceiptLogoScaleFactor()).toBe(0.6);
  expect(cargar({}, false).getReceiptLogoScaleFactor()).toBe(1);
});
