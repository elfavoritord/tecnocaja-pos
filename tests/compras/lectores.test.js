'use strict';
// Lectura de facturas de proveedor: XML e-CF (con el XML que arma nuestro propio
// generador, igual al de cualquier emisor) y plantilla Excel/CSV.
const XLSX = require('xlsx');
const { generateEcfXml } = require('../../modules/ecf/services/ecf-generator');
const { leerXmlEcf, fechaIso } = require('../../server/services/compras/lector-xml-ecf');
const { leerTabla, numero, fecha, plantillaFilas } = require('../../server/services/compras/lector-tabla');

function e31({ tipo = 'E31', encf = 'E310000000123', comprador = '131000001' } = {}) {
  return generateEcfXml({
    emitter: { rnc: '101000002', razonSocial: 'Distribuidora Ejemplo SRL', nombreComercial: 'Dist Ejemplo', direccion: 'Calle 2', telefono: '8090000001' },
    customer: { rnc: comprador, nombre: 'Colmado Lab' },
    document: { eNCF: encf, tipoeCF: tipo, tipoIngresos: '01', tipoPago: '2', fechaVencimientoSecuencia: '2027-12-31' },
    items: [
      { name: 'Arroz Selecto 5 lb', quantity: 10, unitPrice: 250, taxRate: 18 },
      { name: 'Habichuelas rojas', quantity: 4, unitPrice: 75, taxRate: 0 },
      { name: 'Transporte de mercancía', quantity: 1, unitPrice: 500, taxRate: 18, isService: true },
    ],
    issueDate: new Date(2026, 10, 9, 10, 0, 0),
  }).xml;
}

describe('XML e-CF del proveedor', () => {
  test('lee proveedor, e-NCF, fecha, líneas con su ITBIS y totales', () => {
    const r = leerXmlEcf(e31(), { rncNegocio: '131-00000-1' });
    expect(r.encabezado).toMatchObject({
      proveedor: { nombre: 'Distribuidora Ejemplo SRL', rnc: '101000002' }, tipoComprobante: 'E31', ncf: 'E310000000123',
      encfProveedor: 'E310000000123', fechaComprobante: '2026-11-09', condicionPago: 'credito', documentoOrigen: 'xml_ecf',
    });
    expect(r.lineas.map((l) => [l.descripcion, l.cantidad, l.costoUnitario, l.itbisPct, l.tipoLinea])).toEqual([
      ['Arroz Selecto 5 lb', 10, 250, 18, 'inventario'],
      ['Habichuelas rojas', 4, 75, 0, 'inventario'],
      ['Transporte de mercancía', 1, 500, 18, 'servicio_gasto'],
    ]);
    expect(r.encabezado.totalesDocumento).toMatchObject({ itbis: 540, total: 3840 });
    expect(r.avisos.filter((a) => a.nivel === 'error')).toEqual([]);
    expect(r.avisos.some((a) => /no está firmado/.test(a.texto))).toBe(true);
  });
  test('avisa si la factura no está a nombre del negocio y si es de consumo', () => {
    const otro = leerXmlEcf(e31({ comprador: '131999999' }), { rncNegocio: '131000001' });
    expect(otro.avisos.some((a) => /no da crédito fiscal al negocio/.test(a.texto))).toBe(true);
  });
  test('firma alterada: error que bloquea registrar', () => {
    const conFirma = e31().replace('</ECF>', '<Signature><SignedInfo/><SignatureValue>ABCDEF123</SignatureValue></Signature></ECF>');
    const r = leerXmlEcf(conFirma, { verificarFirma: () => ({ ok: false, validationError: 'digest' }) });
    expect(r.firma).toMatchObject({ verificada: true, valida: false });
    expect(r.avisos.some((a) => a.nivel === 'error' && /firma digital no es válida/.test(a.texto))).toBe(true);
    expect(r.encabezado.codigoSeguridad).toBe('ABCDEF');
  });
  test('notas de crédito/débito, otros tipos y archivos que no son e-CF se rechazan', () => {
    expect(() => leerXmlEcf(e31({ tipo: 'E34', encf: 'E340000000001' }))).toThrow(/notas de débito y crédito/);
    expect(() => leerXmlEcf(e31({ tipo: 'E41', encf: 'E410000000001' }))).toThrow(/no es una factura de compra/);
    expect(() => leerXmlEcf('<Factura><A>1</A></Factura>')).toThrow(/no es un comprobante electrónico/);
    expect(() => leerXmlEcf('hola')).toThrow(/no es un XML/);
  });
  test('fecha DGII dd-mm-aaaa', () => {
    expect(fechaIso('09-11-2026')).toBe('2026-11-09');
  });
});

describe('Excel y CSV con la plantilla', () => {
  const csv = [
    'rnc_proveedor,nombre_proveedor,ncf,fecha,descripcion,cantidad,costo_unitario,itbis_pct,precio_venta,modo_itbis,control_inventario',
    '101000002,Dist Ejemplo,B0100000010,09/11/2026,Arroz 5 lb,10,250,18,354,incluido,si',
    '101000002,Dist Ejemplo,B0100000010,09/11/2026,Aceite 1 L,5,"1,250.50",18,,,',
    '101000002,Dist Ejemplo,B0100000011,10/11/2026,Azúcar 2 lb,8,60,0,,,no',
    ',,,,Sin proveedor,1,10,18,,,',
    '101000002,Dist Ejemplo,B0100000012,10/11/2026,,0,abc,18,,,',
  ].join('\n');
  test('agrupa por factura, lee números y fechas, y reporta filas con error', () => {
    const { facturas, errores } = leerTabla(Buffer.from(csv, 'utf8'), 'compras.csv');
    expect(facturas).toHaveLength(3);
    const [a, b, c] = facturas;
    expect(a.encabezado).toMatchObject({ ncf: 'B0100000010', fechaComprobante: '2026-11-09', tipoComprobante: 'B01', proveedor: { rnc: '101000002' } });
    expect(a.lineas.map((l) => [l.descripcion, l.cantidad, l.costoUnitario])).toEqual([['Arroz 5 lb', 10, 250], ['Aceite 1 L', 5, 1250.5]]);
    expect(a.lineas[0].precio).toEqual({ modo: 'incluido', valor: 354 });
    expect(a.lineas[0].controlaInventario).toBe(true);
    expect(b.lineas[0]).toMatchObject({ itbisPct: 0, controlaInventario: false });
    expect(errores).toEqual([{ fila: 5, texto: 'falta el proveedor (RNC o nombre).' }]);
    expect(c.avisos.some((x) => x.nivel === 'error' && /Fila 6: falta la descripción, cantidad no válida, costo no válido/.test(x.texto))).toBe(true);
  });
  test('XLSX con la plantilla descargable', () => {
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet(plantillaFilas()), 'Compras');
    const buffer = XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' });
    const { facturas } = leerTabla(buffer, 'plantilla.xlsx');
    expect(facturas).toHaveLength(1);
    expect(facturas[0].lineas[0]).toMatchObject({ descripcion: 'Arroz 5 lb', codigoBarras: '7501234567890', cantidad: 10, costoUnitario: 250, tipoLinea: 'inventario' });
  });
  test('sin columnas necesarias se explica qué falta', () => {
    expect(() => leerTabla(Buffer.from('proveedor,producto\nA,B', 'utf8'), 'x.csv')).toThrow(/Falta la columna «cantidad»/);
  });
  test('números y fechas en los formatos de RD', () => {
    expect([numero('1,234.50'), numero('1.234,50'), numero('12,5'), numero('RD$ 100'), numero('1,250'), numero('')]).toEqual([1234.5, 1234.5, 12.5, 100, 1250, null]);
    expect([fecha('2026-11-09'), fecha('9/11/2026'), fecha(new Date(2026, 10, 9))]).toEqual(['2026-11-09', '2026-11-09', '2026-11-09']);
  });
});
