'use strict';
// Portal de Contadores: lo que se manda a la cola de compras del negocio
// (tecno-caja-contadores/server/compras-portal.js) y los lectores copiados del POS.
const { limpiarCompra, totalAproximado } = require('../tecno-caja-contadores/server/compras-portal');
const fs = require('fs');
const path = require('path');

const base = (extra = {}) => ({
  encabezado: { proveedor: { nombre: 'Distribuidora Uno', rnc: '101-00000-2' }, ncf: 'b0100000077', fechaComprobante: '2026-11-09', condicionPago: 'contado' },
  lineas: [
    { productoId: 7, descripcion: 'Arroz', cantidad: 2, costoUnitario: 100, itbisPct: 18, precio: { modo: 'incluido', valor: 500 } },
    { accion: 'nuevo', descripcion: 'Habichuelas', cantidad: 1, costoUnitario: 50, itbisPct: 18, precio: { modo: 'incluido', valor: 90 } },
    { tipoLinea: 'servicio_gasto', productoId: 3, descripcion: 'Flete', cantidad: 1, costoUnitario: 200, itbisPct: 0 },
  ],
  ...extra,
});

describe('Portal: compra que se manda al negocio', () => {
  test('limpia lo que va a la cola: RNC en dígitos, NCF en mayúscula, sin precio para productos existentes', () => {
    const c = limpiarCompra(base());
    expect(c.encabezado.proveedor.rnc).toBe('101000002');
    expect(c.encabezado.ncf).toBe('B0100000077');
    expect(c.encabezado.documentoOrigen).toBe('portal');
    expect(c.lineas[0]).toMatchObject({ productoId: 7, accion: 'existente' });
    expect(c.lineas[0].precio).toBeUndefined(); // el contador no cambia precios del negocio
    expect(c.lineas[1]).toMatchObject({ accion: 'nuevo', precio: { modo: 'incluido', valor: 90 } });
    expect(c.lineas[2]).toMatchObject({ tipoLinea: 'servicio_gasto' });
    expect(c.lineas[2].productoId).toBeUndefined();
    expect(totalAproximado(c.lineas)).toBeCloseTo(2 * 100 * 1.18 + 50 * 1.18 + 200, 2);
  });

  test('rechaza datos que el POS no podría registrar', () => {
    expect(() => limpiarCompra(base({ encabezado: { ...base().encabezado, ncf: 'B01-123' } }))).toThrow(/formato de la DGII/);
    expect(() => limpiarCompra(base({ encabezado: { ...base().encabezado, fechaComprobante: '' } }))).toThrow(/fecha/);
    expect(() => limpiarCompra(base({ encabezado: { ...base().encabezado, proveedor: { rnc: '123' } } }))).toThrow(/9 u 11/);
    expect(() => limpiarCompra(base({ lineas: [] }))).toThrow(/al menos una línea/);
    expect(() => limpiarCompra(base({ lineas: [{ descripcion: 'X', cantidad: 0, costoUnitario: 1 }] }))).toThrow(/cantidad/);
  });

  test('los lectores del portal son la copia exacta de los del POS', () => {
    const raiz = path.join(__dirname, '..');
    for (const [pos, portal] of [
      ['server/services/compras/lector-tabla.js', 'tecno-caja-contadores/server/compras/lector-tabla.js'],
      ['server/services/compras/emparejar-productos.js', 'tecno-caja-contadores/server/compras/emparejar-productos.js'],
      ['modules/ecf/utils/xml.util.js', 'tecno-caja-contadores/server/compras/xml.util.js'],
    ]) {
      expect(fs.readFileSync(path.join(raiz, portal), 'utf8')).toBe(fs.readFileSync(path.join(raiz, pos), 'utf8'));
    }
    const xml = fs.readFileSync(path.join(raiz, 'tecno-caja-contadores/server/compras/lector-xml-ecf.js'), 'utf8');
    expect(xml).toBe(fs.readFileSync(path.join(raiz, 'server/services/compras/lector-xml-ecf.js'), 'utf8')
      .replace("require('../../../modules/ecf/utils/xml.util')", "require('./xml.util')"));
  });
});
