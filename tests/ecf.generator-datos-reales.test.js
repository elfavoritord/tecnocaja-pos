'use strict';

/**
 * Datos como los que escribe la gente: un teléfono sin guiones o un nombre largo no deben
 * costar el rechazo del comprobante. Los XSD de la DGII los validan con
 * scripts/ecf/validar-xsd.ps1; aquí queda el comportamiento.
 */

const { generateEcfXml } = require('../modules/ecf/services/ecf-generator');

const emisor = { rnc: '132839676', razonSocial: 'Farmacia SRL', direccion: 'Calle 1', telefono: '809-555-1234', correo: 'a@b.com' };
const cliente = { rnc: '131880681', nombre: 'Cliente SRL' };
const gravado = [{ name: 'Producto', quantity: 2, unitPrice: 100, discount: 0, taxRate: 18 }];

function xmlDe({ tipo = 'E31', customer = cliente, emitter = emisor, items = gravado, extra = {} } = {}) {
  return generateEcfXml({
    emitter, customer, items,
    document: {
      eNCF: `${tipo}0000000001`, tipoeCF: tipo, tipoIngresos: '01', tipoPago: '1',
      ...(['E32', 'E34'].includes(tipo) ? {} : { fechaVencimientoSecuencia: '2027-12-31' }),
      ...extra,
    },
    issueDate: new Date('2026-11-01T12:00:00'),
  }).xml;
}
const valor = (xml, tag) => (xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1] ?? null;
const antes = (xml, a, b) => xml.indexOf(`<${a}>`) >= 0 && xml.indexOf(`<${a}>`) < xml.indexOf(`<${b}>`);

describe('comprador', () => {
  const completo = { ...cliente, correo: 'cliente@correo.com', telefono: '809-555-1234', direccion: 'Av. Duarte 12' };

  test.each(['E31', 'E32', 'E33', 'E34', 'E44', 'E45', 'E46'])('%s: correo, dirección y teléfono en el orden del XSD', (tipo) => {
    const xml = xmlDe({ tipo, customer: completo });
    expect(antes(xml, 'CorreoComprador', 'DireccionComprador')).toBe(true);
    expect(antes(xml, 'DireccionComprador', 'TelefonoAdicional')).toBe(true);
  });

  test('E41 no tiene teléfono del comprador', () => {
    expect(valor(xmlDe({ tipo: 'E41', customer: completo }), 'TelefonoAdicional')).toBeNull();
  });

  test('E47 solo lleva identificación extranjera y nombre', () => {
    const xml = xmlDe({ tipo: 'E47', customer: { ...completo, identificadorExtranjero: 'US-350555123' } });
    expect(valor(xml, 'RNCComprador')).toBeNull();
    expect(valor(xml, 'CorreoComprador')).toBeNull();
    expect(valor(xml, 'IdentificadorExtranjero')).toBe('US-350555123');
  });

  test.each([['8095551234'], ['(809) 555-1234'], ['1-809-555-1234']])('teléfono %s queda con el formato de la DGII', (telefono) => {
    expect(valor(xmlDe({ customer: { ...cliente, telefono } }), 'TelefonoAdicional')).toBe('809-555-1234');
  });

  test('un teléfono o correo inservible se omite', () => {
    const xml = xmlDe({ customer: { ...cliente, telefono: '555', correo: 'no tiene correo' } });
    expect(valor(xml, 'TelefonoAdicional')).toBeNull();
    expect(valor(xml, 'CorreoComprador')).toBeNull();
  });

  test('un RNC con guiones se limpia y uno incompleto no se manda', () => {
    expect(valor(xmlDe({ customer: { rnc: '131-88068-1', nombre: 'X' } }), 'RNCComprador')).toBe('131880681');
    expect(valor(xmlDe({ tipo: 'E32', customer: { rnc: '123', nombre: 'X' } }), 'RNCComprador')).toBeNull();
  });

  test('nombre y dirección se recortan al largo del XSD', () => {
    const xml = xmlDe({ customer: { ...cliente, nombre: 'N'.repeat(200), direccion: 'D'.repeat(200) } });
    expect(valor(xml, 'RazonSocialComprador')).toHaveLength(150);
    expect(valor(xml, 'DireccionComprador')).toHaveLength(100);
  });
});

describe('emisor', () => {
  test('varios teléfonos en una casilla van separados; lo que no sirve se omite', () => {
    const xml = xmlDe({ emitter: { ...emisor, telefono: '809-555-1234 / 8095559999, llamar' } });
    expect([...xml.matchAll(/<TelefonoEmisor>([^<]*)/g)].map((m) => m[1])).toEqual(['809-555-1234', '809-555-9999']);
  });

  test('correo malo se omite; razón social y dirección se recortan', () => {
    const xml = xmlDe({ emitter: { ...emisor, correo: 'correo', razonSocial: 'R'.repeat(200), direccion: 'D'.repeat(200) } });
    expect(valor(xml, 'CorreoEmisor')).toBeNull();
    expect(valor(xml, 'RazonSocialEmisor')).toHaveLength(150);
    expect(valor(xml, 'DireccionEmisor')).toHaveLength(100);
  });
});

describe('líneas', () => {
  test('el nombre se recorta a 80 y una unidad que no es código se omite', () => {
    const xml = xmlDe({ items: [{ ...gravado[0], name: 'P'.repeat(120), unitMeasure: 'Unidad' }] });
    expect(valor(xml, 'NombreItem')).toHaveLength(80);
    expect(valor(xml, 'UnidadMedida')).toBeNull();
  });

  test('báscula: 2 decimales en la cantidad, y cantidad × precio sigue dando el monto', () => {
    const xml = xmlDe({ items: [{ name: 'Queso', quantity: 0.375, unitPrice: 325.5, discount: 0, taxRate: 18 }] });
    expect(valor(xml, 'CantidadItem')).toBe('0.38');
    expect(valor(xml, 'MontoItem')).toBe('122.06');
    expect(Number(valor(xml, 'CantidadItem')) * Number(valor(xml, 'PrecioUnitarioItem'))).toBeCloseTo(122.06, 2);
  });

  test('báscula con menos de un centésimo: va como 1 con el monto de la línea', () => {
    const xml = xmlDe({ items: [{ name: 'Azafrán', quantity: 0.004, unitPrice: 5000, discount: 0, taxRate: 18 }] });
    expect(valor(xml, 'CantidadItem')).toBe('1.00');
    expect(valor(xml, 'PrecioUnitarioItem')).toBe('20.00');
  });

  test('precio con 4 decimales no se redondea', () => {
    const xml = xmlDe({ items: [{ name: 'Tornillo', quantity: 3, unitPrice: 1.3333, discount: 0, taxRate: 18 }] });
    expect(valor(xml, 'PrecioUnitarioItem')).toBe('1.3333');
  });
});

describe('tipos sin ITBIS', () => {
  test('E44 con línea gravada sale exento', () => {
    const xml = xmlDe({ tipo: 'E44' });
    expect(valor(xml, 'MontoGravadoTotal')).toBeNull();
    expect(valor(xml, 'MontoExento')).toBe('200.00');
    expect(valor(xml, 'IndicadorFacturacion')).toBe('4');
  });

  test('E46 con línea gravada sale a tasa 0%', () => {
    const xml = xmlDe({ tipo: 'E46', customer: { nombre: 'Foreign LLC' } });
    expect(valor(xml, 'MontoGravadoI3')).toBe('200.00');
    expect(valor(xml, 'TotalITBIS')).toBe('0.00');
  });
});

describe('notas de crédito', () => {
  const referencia = { ncfModificado: 'E310000000001', fechaNcfModificado: '01-10-2026', codigoModificacion: '3' };

  test('con líneas gravadas lleva TipoIngresos, como la que aceptó la DGII en la certificación', () => {
    const xml = xmlDe({ tipo: 'E34', extra: { indicadorNotaCredito: 0, referencia } });
    expect(valor(xml, 'TipoIngresos')).toBe('01');
    expect(antes(xml, 'IndicadorMontoGravado', 'TipoIngresos')).toBe(true);
  });

  test('exenta no lo lleva', () => {
    const xml = xmlDe({ tipo: 'E34', items: [{ ...gravado[0], taxRate: 0 }], extra: { indicadorNotaCredito: 0, referencia } });
    expect(valor(xml, 'TipoIngresos')).toBeNull();
  });
});
