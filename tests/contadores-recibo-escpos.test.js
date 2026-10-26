'use strict';

/**
 * Recibo de pago del portal del contador en impresora térmica: sale con
 * comandos ESC/POS (tecno-caja-contadores/electron/recibo-pago.js, con el
 * motor del POS copiado por vendor-sync), no como página HTML.
 */

const { construirReciboPago, partir } = require('../tecno-caja-contadores/electron/recibo-pago');

const DATOS = {
  numero: 'B0100000018-02', fecha: '2026-10-25T15:30:00', cliente: 'SURTIDORA SUAREZ HERRERA', rnc: '133607336',
  ncf: 'B01-00000018', total: 4720, anteriores: 2000, monto: 1000, saldo: 1720, saldada: false,
  metodo: 'Efectivo', nota: 'Abono en caja', pagoNumero: 2, pagosTotal: 2, letras: 'MIL PESOS DOMINICANOS CON 00/100',
  concepto: ['Contabilidad mensual de octubre', '2 x Asesoría fiscal para la declaración jurada del impuesto sobre la renta'],
};
const FIRMA = { nombre_firma: 'VICRIS & ASOCIADOS SRL', rnc: '131-12345-6', telefono: '809-555-0101', direccion: 'Av. Duarte #45, Santo Domingo' };

// Texto de cada línea, sin los comandos ESC/POS (alinear, negrita, tamaño, corte…).
function lineas(buffer) {
  return buffer.toString('latin1')
    .replace(/\x1b@|\x1bt[\s\S]|\x1bM[\s\S]|\x1ba[\s\S]|\x1bE[\s\S]|\x1d![\s\S]|\x1dV[AB]\x00/g, '')
    .split('\n');
}

test('trae la firma, el cliente, este pago, el saldo y corta el papel', () => {
  const buffer = construirReciboPago(DATOS, FIRMA, 80);
  const texto = lineas(buffer).join('\n');
  for (const esperado of ['VICRIS & ASOCIADOS SRL', 'RECIBO DE PAGO', 'No. B0100000018-02', '25/10/2026 3:30 p. m.',
    'SURTIDORA SUAREZ HERRERA', 'RNC / C\x82dula: 133607336', 'Pagado antes', '2,000.00', 'ESTE PAGO', 'RD$ 1,000.00',
    'MIL PESOS DOMINICANOS CON 00/100', 'Pago', '2 de 2', 'Saldo pendiente', 'RD$ 1,720.00', 'Nota del pago: Abono en caja', 'Recibido por', '\xadGracias por su pago!',
    'Por concepto de:', '- Contabilidad mensual de octubre', '- 2 x Asesor\xa1a fiscal para la declaraci\xa2n']) {
    expect(texto).toContain(esperado);
  }
  // Empieza inicializando la impresora y termina con corte parcial (GS V A 0).
  expect(buffer.subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40]));
  expect(buffer.subarray(-4)).toEqual(Buffer.from([0x1d, 0x56, 0x41, 0x00]));
});

test('ninguna línea se pasa del ancho del papel (48 columnas en 80 mm, 32 en 58 mm)', () => {
  const largo = { ...DATOS, cliente: 'DISTRIBUIDORA DE PRODUCTOS FARMACEUTICOS DEL CIBAO Y ASOCIADOS SRL', nota: 'Pago recibido en la oficina principal por transferencia del Banco Popular, referencia 123456789' };
  for (const [ancho, cols] of [[80, 48], [58, 32]]) {
    const malas = lineas(construirReciboPago(largo, FIRMA, ancho)).filter((l) => l.length > cols);
    expect(malas).toEqual([]);
  }
});

test('el logo sale arriba, centrado, como imagen de térmica (GS v 0)', () => {
  const logoMono = { width: 16, height: 2, bytesPerLine: 2, data: [0xff, 0x00, 0x0f, 0xf0] };
  const buffer = construirReciboPago(DATOS, { ...FIRMA, logoMono }, 80);
  const inicio = buffer.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]));
  expect(inicio).toBeGreaterThan(0);
  // centrado antes de la imagen, y el logo va antes que el nombre de la firma
  expect(buffer.subarray(0, inicio).includes(Buffer.from([0x1b, 0x61, 0x01]))).toBe(true);
  expect(buffer.subarray(inicio, inicio + 12)).toEqual(Buffer.from([0x1d, 0x76, 0x30, 0x00, 2, 0, 2, 0, 0xff, 0x00, 0x0f, 0xf0]));
  expect(inicio).toBeLessThan(buffer.indexOf(Buffer.from('VICRIS', 'latin1')));
  // sin logo no manda imagen
  expect(construirReciboPago(DATOS, FIRMA, 80).indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]))).toBe(-1);
});

test('saldada: lo dice en vez del saldo', () => {
  const texto = lineas(construirReciboPago({ ...DATOS, saldo: 0, saldada: true }, FIRMA, 58)).join('\n');
  expect(texto).toContain('FACTURA SALDADA');
  expect(texto).not.toContain('Saldo pendiente');
});

test('partir no corta palabras', () => {
  expect(partir('Av. Duarte #45, Santo Domingo Este', 16)).toEqual(['Av. Duarte #45,', 'Santo Domingo', 'Este']);
});
