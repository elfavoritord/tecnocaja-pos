'use strict';

/**
 * Ticket ESC/POS (electron/thermal-printer.js → buildReceipt).
 *
 * js/ventas.js manda las filas ya armadas (filasDetalle, filasResumen,
 * filasPago, items[].itbisTexto, config.seguridadEcf) para que el ticket
 * impreso lleve los mismos datos que el de la pantalla y la factura A4.
 */

const { ESCPOSBuilder, buildReceipt, encodeText } = require('../electron/thermal-printer');

function lineasImpresas(data) {
  const lineas = [];
  const original = ESCPOSBuilder.prototype.text;
  ESCPOSBuilder.prototype.text = function (str) {
    lineas.push(String(str));
    return original.call(this, str);
  };
  try {
    buildReceipt(data);
  } finally {
    ESCPOSBuilder.prototype.text = original;
  }
  return lineas;
}

function payload(paperWidth) {
  return {
    negocio: { nombre: 'Colmado La Esquina', rnc: '131-00000-1', direccion: 'Calle Principal 1', telefono: '809-555-0000' },
    venta: {
      numeroFactura: 'E310000000045',
      documentTitle: 'FACTURA ELECTRONICA',
      documentNumber: 'eNCF E310000000045',
      fecha: '2026-10-12T10:00:00.000Z',
      cliente: 'Juan',
      metodo: 'Crédito',
      items: [
        { cantidad: 2, cantidadTexto: '2', descripcion: 'Agua Dasani 500 ml', precio: 25, subtotal: 50, itbisTexto: '' },
        { cantidad: 1, cantidadTexto: '1', descripcion: 'Café molido 1 lb', precio: 395, subtotal: 395, itbisTexto: '18%' }
      ],
      filasDetalle: [
        ['Factura', 'ECF-0000045'],
        ['e-NCF', 'E310000000045'],
        ['Tipo e-CF', 'E31'],
        ['Fecha', '12/10/2026 06:00'],
        ['Cajero', 'ANTHONY'],
        ['Cliente', 'Distribuidora de Materiales de Construcción Hermanos Rodríguez SRL'],
        ['RNC / Cédula', '130-83390-7'],
        ['Método', 'Crédito']
      ],
      filasResumen: [['Subtotal', '445.00'], ['ITBIS (18%)', '71.10'], ['Redondeo', '0.90']],
      filasPago: [['Abonado', '200.00'], ['PENDIENTE', '317.00', 'meta-strong'], ['Método', 'A CRÉDITO']],
      subtotal: 445,
      impuesto: 71.1,
      total: 517
    },
    config: {
      paperWidth,
      mostrarQR: true,
      qrData: 'https://ecf.dgii.gov.do/ConsultaTimbre?ENCF=E310000000045',
      seguridadEcf: ['Código de seguridad: A7K2M9', 'Fecha firma: 12-10-2026 10:00:05'],
      mensaje: 'Gracias por su compra'
    }
  };
}

describe('buildReceipt con las filas del renderer', () => {
  test.each([['80mm', 48], ['58mm', 32]])('%s: imprime los mismos datos y ninguna línea se pasa de %i columnas', (papel, columnas) => {
    const lineas = lineasImpresas(payload(papel));
    const texto = lineas.join('\n');

    expect(texto).toContain('TIPO E-CF');
    expect(texto).toContain('RNC / CÉDULA');
    expect(texto).toContain('130-83390-7');
    expect(texto).toContain('Hermanos');
    expect(texto).toContain('ITBIS');
    expect(texto).toContain('18%');
    expect(texto).toContain('ITBIS (18%)');
    expect(texto).toContain('Redondeo');
    expect(texto).toContain('PENDIENTE');
    expect(texto).toContain('A CRÉDITO');
    expect(texto).toContain('Código de seguridad: A7K2M9');
    expect(texto).toContain('Fecha firma: 12-10-2026 10:00:05');

    lineas.forEach((linea) => expect(linea.length).toBeLessThanOrEqual(columnas));
  });

  test('un pago exacto en efectivo no agrega filas de pago', () => {
    const data = payload('80mm');
    data.venta.filasPago = [];
    data.venta.cambio = 0;
    const texto = lineasImpresas(data).join('\n');
    expect(texto).not.toContain('Cambio');
    expect(texto).not.toContain('PENDIENTE');
  });
});

describe('buildReceipt con un payload de antes (sin filas)', () => {
  test('sigue imprimiendo las filas básicas', () => {
    const lineas = lineasImpresas({
      negocio: { nombre: 'Colmado' },
      venta: {
        numeroFactura: 'FAC-0001',
        fecha: '2026-10-12T10:00:00.000Z',
        cajero: 'ANA',
        cliente: 'Consumidor Final',
        metodo: 'Efectivo',
        ncf: 'B0200000001',
        items: [{ cantidad: 1, descripcion: 'Pan', precio: 10, subtotal: 10 }],
        subtotal: 10,
        total: 10,
        cambio: 5
      },
      config: { paperWidth: '80mm' }
    });
    const texto = lineas.join('\n');
    expect(texto).toContain('B0200000001');
    expect(texto).toContain('Subtotal:');
    expect(texto).toContain('Cambio:');
    expect(texto).not.toContain('ITBIS');
  });
});

describe('encodeText', () => {
  test('caracteres que antes salían como basura en CP437', () => {
    expect([...encodeText('·')]).toEqual([0xFA]);
    expect(encodeText('★ — “x”').toString('latin1')).toBe('* - "x"');
    expect([...encodeText('Nº')]).toEqual([0x4E, 0xA7]);
  });
});
