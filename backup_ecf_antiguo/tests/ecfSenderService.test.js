'use strict';

const { resolveSubmissionTarget, mapDGIIStatus } = require('../server/fiscal/ecfSenderService');

describe('ecfSenderService', () => {
  test('bloquea RFCE para E32 bajo el umbral cuando no existe flujo real implementado', () => {
    const result = resolveSubmissionTarget(
      {
        tipo_ecf: 'E32',
        monto_total: 1500,
        submission_mode: 'rfce'
      },
      'test'
    );

    expect(result.mode).toBe('rfce');
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('TODO profesional');
  });

  test('usa el endpoint normal de recepción e-CF para documentos estándar', () => {
    const result = resolveSubmissionTarget(
      {
        tipo_ecf: 'E31',
        monto_total: 350000,
        submission_mode: 'ecf'
      },
      'produccion'
    );

    expect(result.mode).toBe('ecf');
    expect(result.blocked).toBe(false);
    expect(result.url).toContain('/recepcion/api/facturaselectronicas');
  });

  test('normaliza estados DGII a estados internos del POS', () => {
    expect(mapDGIIStatus('Aceptado')).toBe('aceptado');
    expect(mapDGIIStatus('Aceptado Condicional')).toBe('aceptado_condicional');
    expect(mapDGIIStatus('Rechazado')).toBe('rechazado');
    expect(mapDGIIStatus('En proceso')).toBe('procesando');
  });
});
