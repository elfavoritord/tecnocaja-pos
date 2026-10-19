'use strict';

const { validarEvento } = require('../../server/multisucursal/aislamiento');

const EMPRESA_A = '11111111-1111-4111-8111-111111111111';
const EMPRESA_B = '99999999-9999-4999-8999-999999999999';
const SUC_A1 = '22222222-2222-4222-8222-222222222222';
const SUC_A2 = '33333333-3333-4333-8333-333333333333';

const base = (cambios = {}) => ({
  eventId: '44444444-4444-4444-8444-444444444444',
  companyUuid: EMPRESA_A,
  branchUuid: SUC_A1,
  entityType: 'venta',
  entityUuid: '55555555-5555-4555-8555-555555555555',
  operation: 'crear',
  version: 1,
  payload: { total: 100 },
  ...cambios,
});

describe('Aislamiento de eventos entre empresas y sucursales', () => {
  test('una venta de la propia sucursal se acepta', () => {
    expect(validarEvento(base(), { companyUuid: EMPRESA_A, branchUuid: SUC_A1 })).toEqual({ ok: true, alcance: 'sucursal' });
  });

  test('nunca se acepta un evento de otra empresa', () => {
    const r = validarEvento(base({ companyUuid: EMPRESA_B }), { companyUuid: EMPRESA_A, branchUuid: SUC_A1 });
    expect(r).toMatchObject({ ok: false, motivo: 'otra_empresa' });
  });

  test('una sucursal no recibe ventas de otra sucursal', () => {
    const r = validarEvento(base({ branchUuid: SUC_A2 }), { companyUuid: EMPRESA_A, branchUuid: SUC_A1 });
    expect(r).toMatchObject({ ok: false, motivo: 'otra_sucursal' });
  });

  test('el catálogo maestro vale para cualquier sucursal de la empresa', () => {
    const producto = base({ entityType: 'producto', branchUuid: null, operation: 'actualizar', version: 7 });
    expect(validarEvento(producto, { companyUuid: EMPRESA_A, branchUuid: SUC_A2 })).toEqual({ ok: true, alcance: 'empresa' });
  });

  test('la nube solo acepta ventas de las sucursales autorizadas al equipo', () => {
    const nube = { companyUuid: EMPRESA_A, branchUuid: null, sucursalesPermitidas: [SUC_A2] };
    expect(validarEvento(base(), nube)).toMatchObject({ ok: false, motivo: 'sucursal_no_autorizada' });
    expect(validarEvento(base({ branchUuid: SUC_A2 }), nube)).toMatchObject({ ok: true });
  });

  test.each([
    ['event_id roto', { eventId: '1' }, 'formato'],
    ['sin sucursal en un evento de sucursal', { branchUuid: null }, 'formato'],
    ['tipo desconocido', { entityType: 'nomina' }, 'entidad'],
    ['operación desconocida', { operation: 'borrar_todo' }, 'operacion'],
    ['versión cero', { version: 0 }, 'formato'],
    ['payload que no es objeto', { payload: [1, 2] }, 'formato'],
  ])('rechaza %s', (_nombre, cambios, motivo) => {
    expect(validarEvento(base(cambios), { companyUuid: EMPRESA_A, branchUuid: SUC_A1 })).toMatchObject({ ok: false, motivo });
  });

  test('sin identidad propia no se acepta nada', () => {
    expect(validarEvento(base(), { companyUuid: null })).toMatchObject({ ok: false, motivo: 'receptor' });
  });
});
