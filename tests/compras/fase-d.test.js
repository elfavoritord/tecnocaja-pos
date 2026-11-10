'use strict';
// Fase D de compras: formato 606 (js/formato-606.js), validador XSD de los e-CF
// (modules/ecf/utils/xsd-validator.js), reparto de retenciones y estados.

const Formato606 = require('../../js/formato-606');
const { validarEcfXsd } = require('../../modules/ecf/utils/xsd-validator');
const { generateEcfXml } = require('../../modules/ecf/services/ecf-generator');
const { repartir, estadoDesdeEcf } = require('../../server/services/comprobantes-compra.service');

const EMISOR = { rnc: '131000001', razonSocial: 'Negocio Prueba SRL', nombreComercial: 'Negocio', direccion: 'Calle 1', telefono: '809-555-1234' };
const xmlDe = (tipo, customer, items, extra = {}) => generateEcfXml({
  emitter: EMISOR, customer, items, issueDate: new Date(),
  document: { eNCF: `${tipo}0000000001`, tipoeCF: tipo, tipoIngresos: '01', tipoPago: '1', fechaVencimientoSecuencia: '2027-12-31', ...extra },
}).xml;

describe('Formato 606', () => {
  const base = { rncCedula: '101000002', tipoBienesServicios: 9, ncf: 'E310000000901', fechaComprobante: '2026-11-05', fechaPago: '2026-11-05', montoBienes: 1000, itbisFacturado: 180, formaPago: 1 };

  test('encabezado, 23 campos por línea, fechas AAAAMMDD y nombre DGII', () => {
    const r = Formato606.construir({ rncInformante: '131000001', periodo: '202611', registros: [base] });
    expect(r.ok).toBe(true);
    expect(r.nombreArchivo).toBe('DGII_F_606_131000001_202611.TXT');
    const [enc, linea] = r.txt.split('\r\n');
    expect(enc).toBe('606|131000001|202611|1');
    const campos = linea.split('|');
    expect(campos).toHaveLength(23);
    expect(campos.slice(0, 7)).toEqual(['101000002', '1', '09', 'E310000000901', '', '20261105', '20261105']);
    expect(campos[9]).toBe('1000.00');
    expect(campos[14]).toBe('180.00'); // ITBIS por adelantar = facturado − al costo
    expect(campos[22]).toBe('01');
  });

  test('gastos menores y pagos al exterior llevan el RNC del negocio', () => {
    const r = Formato606.construir({ rncInformante: '131000001', periodo: '202611', registros: [
      { tipoBienesServicios: 2, ncf: 'E430000000001', fechaComprobante: '2026-11-06', montoServicios: 300, formaPago: 1 },
      { rncCedula: '101000002', tipoBienesServicios: 2, ncf: 'E470000000001', fechaComprobante: '2026-11-06', montoServicios: 300, formaPago: 2 },
    ] });
    expect(r.filas[0].campos[0]).toBe('131000001');
    expect(r.errores.map((e) => e.mensaje).join()).toMatch(/E47: la DGII pide el RNC o cédula de tu negocio/);
  });

  test('retención sin fecha de pago, consumo, duplicados y mes posterior bloquean', () => {
    const r = Formato606.construir({ rncInformante: '131000001', periodo: '202611', registros: [
      { ...base, fechaPago: '', itbisRetenido: 18 },
      { ...base, ncf: 'B0200000001' },
      { ...base },
      { ...base, ncf: 'B0100000009', fechaComprobante: '2026-12-01', fechaPago: '' },
    ] });
    const textos = r.errores.map((e) => e.mensaje).join(' | ');
    expect(r.ok).toBe(false);
    expect(r.txt).toBe('');
    expect(textos).toMatch(/fecha de pago/);
    expect(textos).toMatch(/B02 es de consumo/);
    expect(textos).toMatch(/Repetido/);
    expect(textos).toMatch(/mes posterior/);
  });

  test('nota de crédito exige el NCF que modifica', () => {
    const r = Formato606.construir({ rncInformante: '131000001', periodo: '202611', registros: [{ ...base, ncf: 'E340000000001' }] });
    expect(r.errores[0].mensaje).toMatch(/indica el NCF que modifica/);
  });
});

describe('XSD de la DGII', () => {
  test('E41, E43 y E47 generados pasan su XSD', () => {
    const casos = [
      ['E41', { rnc: '40211932609', nombre: 'Pedro Agricultor' }, [{ name: 'Platano', quantity: 10, unitPrice: 20, taxRate: 18, withholdingAmount: 5, itbisRetenido: 36 }]],
      ['E43', { nombre: 'Taxi' }, [{ name: 'Taxi', quantity: 1, unitPrice: 300, taxRate: 0 }]],
      ['E47', { nombre: 'Foreign', identificadorExtranjero: 'US-1' }, [{ name: 'Licencia', quantity: 1, unitPrice: 500, taxRate: 0, isService: true, withholdingAmount: 50 }], { totalIsrRetencion: 50 }],
    ];
    for (const [tipo, cliente, items, extra] of casos) {
      const r = validarEcfXsd(xmlDe(tipo, cliente, items, extra), { tipo, sinFirma: true });
      expect({ tipo, errores: r.errores }).toEqual({ tipo, errores: [] });
    }
  });

  test('E41: el ITBIS retenido va en la línea y el total es su suma', () => {
    const xml = xmlDe('E41', { rnc: '40211932609', nombre: 'Pedro' }, [
      { name: 'A', quantity: 1, unitPrice: 100, taxRate: 18, itbisRetenido: 10 },
      { name: 'B', quantity: 1, unitPrice: 100, taxRate: 18, itbisRetenido: 8 },
    ]);
    expect([...xml.matchAll(/<MontoITBISRetenido>([^<]+)</g)].map((m) => m[1])).toEqual(['10.00', '8.00']);
    expect(xml).toMatch(/<TotalITBISRetenido>18\.00</);
  });

  test('detecta orden, valores y largos inválidos', () => {
    const xml = xmlDe('E43', { nombre: 'Taxi' }, [{ name: 'Taxi', quantity: 1, unitPrice: 300, taxRate: 0 }]);
    const malos = [
      xml.replace(/<eNCF>[^<]*<\/eNCF>/, '<eNCF>E43000000001</eNCF>'),
      xml.replace(/<NombreItem>[^<]*<\/NombreItem>/, `<NombreItem>${'A'.repeat(90)}</NombreItem>`),
      xml.replace('</Encabezado>', '<Inventado>1</Inventado></Encabezado>'),
      xml.replace(/<MontoTotal>[^<]*<\/MontoTotal>/, ''),
    ];
    for (const m of malos) expect(validarEcfXsd(m, { tipo: 'E43', sinFirma: true }).ok).toBe(false);
    expect(validarEcfXsd(xml, { tipo: 'E43' }).errores.join()).toMatch(/firma/);
  });
});

describe('Comprobantes de compra', () => {
  test('repartir no pierde centavos', () => {
    const partes = repartir(10, [1, 1, 1]);
    expect(Math.round(partes.reduce((t, x) => t + x, 0) * 100)).toBe(1000);
    expect(repartir(0, [5, 5])).toEqual([0, 0]);
  });

  test('un TrackID no es una aceptación', () => {
    expect(estadoDesdeEcf('enviado', true)).toBe('en_proceso');
    expect(estadoDesdeEcf('aceptado', true)).toBe('aceptado');
    expect(estadoDesdeEcf('bloqueado', true)).toBe('rechazado');
    expect(estadoDesdeEcf('pendiente', false)).toBe('en_envio');
    expect(estadoDesdeEcf('error', false)).toBe('autorizado');
  });
});
