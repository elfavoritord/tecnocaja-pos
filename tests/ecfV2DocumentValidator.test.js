'use strict';

const { validateSaleForEcf } = require('../modules/ecf/validators/document-validator');

function buildBase() {
  return {
    emitter: {
      rnc: '101123456',
      razon_social: 'Negocio Demo',
      nombre_comercial: 'Demo',
    },
    certificateStatus: {
      hasCertificate: true,
      isExpired: false,
    },
    buyerTaxId: '',
    buyerName: 'Consumidor Final',
  };
}

test('permite e32 para consumidor final sin cliente', () => {
  const base = buildBase();
  const result = validateSaleForEcf({ ...base, tipoEcf: 'E32' });
  expect(result.ok).toBe(true);
});

test('requiere rnc para e31 credito fiscal', () => {
  const base = buildBase();
  const result = validateSaleForEcf({ ...base, tipoEcf: 'E31' });
  expect(result.ok).toBe(false);
  expect(result.errors.join(' ')).toMatch(/RNC o Cédula/);
});

test('permite e31 cuando el comprador tiene rnc y razon social', () => {
  const base = buildBase();
  base.buyerTaxId = '101999999';
  base.buyerName = 'Cliente Fiscal SRL';
  const result = validateSaleForEcf({ ...base, tipoEcf: 'E31' });
  expect(result.ok).toBe(true);
});

test('bloquea el envio si falta el rnc del emisor', () => {
  const base = buildBase();
  base.emitter.rnc = '';
  const result = validateSaleForEcf({ ...base, tipoEcf: 'E32' });
  expect(result.ok).toBe(false);
  expect(result.errors.join(' ')).toMatch(/RNC del emisor/);
});

test('bloquea el envio si el certificado esta vencido', () => {
  const base = buildBase();
  base.certificateStatus = { hasCertificate: true, isExpired: true };
  const result = validateSaleForEcf({ ...base, tipoEcf: 'E32' });
  expect(result.ok).toBe(false);
  expect(result.errors.join(' ')).toMatch(/vencido/);
});
