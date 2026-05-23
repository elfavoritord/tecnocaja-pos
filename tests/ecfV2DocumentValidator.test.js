'use strict';

const { validateSaleForEcf } = require('../modules/ecf/validators/document-validator');

function buildBase() {
  return {
    sale: {
      subtotal: 100,
      descuento: 0,
      itbis: 18,
      total: 118,
      client_tax_id_snapshot: '',
      client_name_snapshot: 'Consumidor Final',
    },
    items: [
      { qty: 1, precio: 100, descuento: 0, itbis: 18, nombre: 'Producto gravado' },
    ],
    emitter: {
      rnc: '101123456',
      razon_social: 'Negocio Demo',
      nombre_comercial: 'Demo',
      direccion: 'Calle 1',
      provincia: 'DN',
      municipio: 'DN',
      telefono: '8090000000',
      correo: 'demo@test.com',
      environment: 'test',
      certificate_type: 'p12',
    },
    sequence: {
      activo: true,
      isExpired: false,
      isExhausted: false,
    },
    certificateStatus: {
      hasCertificate: true,
      isExpired: false,
    },
  };
}

test('permite e32 para consumidor final sin cliente', () => {
  const base = buildBase();
  const result = validateSaleForEcf({ ...base, requestedType: 'E32' });
  expect(result.ok).toBe(true);
});

test('requiere rnc para e31 credito fiscal', () => {
  const base = buildBase();
  const result = validateSaleForEcf({ ...base, requestedType: 'E31' });
  expect(result.ok).toBe(false);
  expect(result.errors.join(' ')).toMatch(/RNC\/Cédula/);
});

test('detecta productos exentos y descuentos sin romper totales', () => {
  const base = buildBase();
  base.sale.subtotal = 200;
  base.sale.descuento = 10;
  base.sale.itbis = 16.2;
  base.sale.total = 206.2;
  base.sale.client_tax_id_snapshot = '101999999';
  base.items = [
    { qty: 1, precio: 100, descuento: 10, itbis: 18, nombre: 'Producto gravado' },
    { qty: 1, precio: 100, descuento: 0, itbis: 0, nombre: 'Producto exento' },
  ];
  const result = validateSaleForEcf({ ...base, requestedType: 'E31' });
  expect(result.ok).toBe(true);
  expect(result.totals.taxable).toBeCloseTo(90, 2);
  expect(result.totals.exempt).toBeCloseTo(100, 2);
});
