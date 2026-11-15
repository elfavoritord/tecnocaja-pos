'use strict';
// ITBIS incluido en el precio (método 3) en el catálogo de la empresa: la
// principal lo publica, las reglas centrales lo dejan pasar y la sucursal lo
// guarda. Los productos sin la marca publican lo mismo que antes (su huella no
// cambia, así no se republica todo el catálogo).
const { maestroProducto, huellaProducto } = require('../../server/multisucursal/catalogo-local');

const fila = (extra = {}) => ({
  codigo: 'REF', barcode: 'REF', nombre: 'Refresco', categoria: 'Bebidas', marca: null, unidad: 'Unidad',
  sale_mode: 'unidad', product_type: 'general', aplica_itbis: 1, itbis_modo: 'porcentaje', itbis_monto: 0,
  tracks_stock: 1, estado: 'Activo', precio_venta: 118, precio_compra: 60, alcance_empresa: 'empresa', ...extra,
});

test('con el ITBIS incluido se publica la marca', () => {
  expect(maestroProducto(fila({ itbis_incluido: 1 })).itbisIncluido).toBe(true);
});

test('sin la marca (o sin ITBIS) no se publica nada nuevo y la huella no cambia', () => {
  const antes = fila();
  expect('itbisIncluido' in maestroProducto(antes)).toBe(false);
  expect('itbisIncluido' in maestroProducto(fila({ itbis_incluido: 0 }))).toBe(false);
  expect('itbisIncluido' in maestroProducto(fila({ itbis_incluido: 1, aplica_itbis: 0 }))).toBe(false);
  expect(huellaProducto(fila({ itbis_incluido: 0 }))).toBe(huellaProducto(antes));
  expect(huellaProducto(fila({ itbis_incluido: 1 }))).not.toBe(huellaProducto(antes));
});

test('las reglas centrales dejan pasar la marca solo con ITBIS', () => {
  const fuente = require('fs').readFileSync(require.resolve('../../server/multisucursal/central/sincronizacion-central.js'), 'utf8');
  expect(fuente).toMatch(/p\.aplicaItbis && p\.itbisIncluido === true \? \{ itbisIncluido: true \}/);
});
