'use strict';
// Cuadre de caja corto (Emilio, 2026-11-17): lo que dice el sistema, lo que
// declara el cajero (efectivo, verifón y transferencias), el efectivo contado y
// la diferencia, con cada gasto y su descripción. El reporte largo queda como
// "detalle completo".
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function cargar() {
  const ctx = vm.createContext({
    window: {}, DB: { config: {} }, console,
    fmt: (n) => `RD$ ${Number(n || 0).toFixed(2)}`,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'caja-segura.js'), 'utf8'), ctx);
  return ctx.window.CajaSegura;
}

const reporte = {
  turno: { id: 7, apertura: '2026-11-17 08:00:00', cierre: '2026-11-17 19:15:00', abiertoPor: 'Ana', cerradoPor: 'Ana' },
  cerradoPor: 'Ana',
  ventas: { total: 5500, facturas: { total: 12, ticket: 9, electronica: 3, comprobanteFiscal: 0 } },
  efectivo: { apertura: 1000, ventas: 3000, abonos: 200, entradas: 100, gastos: 500, pagosSuplidor: 0, esperado: 3800 },
  cobrado: { efectivo: 3200, tarjeta: 1500, transferencia: 800, total: 5500 },
  credito: { pendienteNuevo: 0 },
  movimientos: [
    { tipo: 'Gasto', monto: -350, notas: 'Pago de la luz' },
    { tipo: 'Gasto', monto: -150, notas: '' },
    { tipo: 'Entrada', monto: 100, notas: 'Cambio de menudo' },
  ],
  conteo: { contado: 3780, diferencia: -20, denominaciones: [{ valor: 2000, tipo: 'billete', cantidad: 1, subtotal: 2000 }, { valor: 1000, tipo: 'billete', cantidad: 0, subtotal: 0 }] },
  verifon: { total: 1500, diferencia: 0 },
  transferenciaDeclarada: { total: 750, diferencia: -50 },
};

test('el cuadre trae lo importante, en el orden del cuadre de papel', () => {
  const secciones = cargar()._filasReporte(reporte);
  expect(secciones.map((s) => s.titulo)).toEqual([
    'Turno', 'Desglose del sistema', 'Desglose del cajero', 'Efectivo físico en caja', 'Diferencia sistema - cajero',
  ]);
  const plano = secciones.flatMap((s) => s.filas.map(([l, v]) => `${l} = ${v}`));
  expect(plano).toContain('Facturas = 12 (9 tickets · 3 e-CF)');
  expect(plano).toContain('  · Pago de la luz = - RD$ 350.00');
  expect(plano).toContain('  · Gasto = - RD$ 150.00'); // sin descripción: el tipo
  expect(plano).toContain('  · Cambio de menudo = RD$ 100.00');
  expect(plano).toContain('Transferencias = RD$ 750.00');
  expect(plano).toContain('Total declarado = RD$ 6030.00');
  expect(plano).toContain('2,000 x 1 = RD$ 2000.00');
  expect(plano.some((l) => l.startsWith('1,000 x'))).toBe(false); // solo lo contado
  expect(plano).toContain('Efectivo = Falta RD$ 20.00');
  expect(plano).toContain('Transferencia = Falta RD$ 50.00');
  expect(plano).toContain('Descuadre = Falta RD$ 70.00');
  // Lo largo (ITBIS, propina, aperturas de gaveta, anticipos…) ya no sale.
  expect(plano.some((l) => /ITBIS|Propina|gaveta|Anticipos/.test(l))).toBe(false);
});

test('sin verifón ni transferencias declaradas, el cajero solo declara el efectivo', () => {
  const { verifon, transferenciaDeclarada, ...sinDeclarar } = reporte;
  const secciones = cargar()._filasReporte({ ...sinDeclarar, conteo: { contado: 3800, diferencia: 0 } });
  const cajero = secciones.find((s) => s.titulo === 'Desglose del cajero').filas.map(([l]) => l);
  expect(cajero).toEqual(['Efectivo contado', 'Total declarado']);
  const dif = secciones.find((s) => s.titulo === 'Diferencia sistema - cajero').filas.map(([l, v]) => `${l} = ${v}`);
  expect(dif).toEqual(['Efectivo = Cuadrado', 'Descuadre = Cuadrado']);
  expect(secciones.some((s) => s.titulo === 'Efectivo físico en caja')).toBe(false);
});

test('el detalle completo sigue disponible', () => {
  const detalle = cargar()._filasDetalle({
    ...reporte, ventas: { ...reporte.ventas, propias: 5500, itbis: 0, descuentos: 0, propinaLegal: 0, facturas: { ...reporte.ventas.facturas, canceladas: 0 } },
    efectivo: { ...reporte.efectivo, devoluciones: 0, retiros: 0, otrasSalidas: 0, propinaEnEfectivo: 0 },
    tarjeta: { cobrado: 1500, ventas: 1500, abonos: 0, reversado: 0 }, transferencia: { cobrado: 800, ventas: 800, abonos: 0, pendienteConfirmar: 0 },
    credito: { pendienteNuevo: 0, detalle: [] },
  });
  const plano = detalle.flatMap((s) => s.filas.map(([l]) => l));
  expect(plano.some((l) => /Gasto · Pago de la luz/.test(l))).toBe(true);
});
