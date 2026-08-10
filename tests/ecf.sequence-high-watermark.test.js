'use strict';

const {
  collectEncfHighWatermarks,
  createEcfService,
  mergeEncfHighWatermarks,
} = require('../modules/ecf/services/ecf.service');

describe('Paso 4 - máximo histórico de secuencias', () => {
  test('obtiene el mayor número por tipo desde respaldos y respuestas DGII', () => {
    expect(collectEncfHighWatermarks(
      'E320000000108 E320000000180',
      { encf: 'E310000000103', response: '<eNCF>E320000000111</eNCF>' },
    )).toEqual({ E31: 103, E32: 180 });
  });

  test('nunca reduce un máximo histórico existente', () => {
    expect(mergeEncfHighWatermarks(
      { E31: 103, E32: 180 },
      { E31: 80, E32: 186, E33: 21 },
    )).toEqual({ E31: 103, E32: 186, E33: 21 });
  });

  test('adelanta una secuencia reiniciada hasta después del máximo respaldado', async () => {
    const service = createEcfService({ query: async () => [], withTransaction: async () => null });
    service._readSequenceHighWatermarkState = () => ({});
    service._writeSequenceHighWatermarkState = jest.fn();
    service._legacyCertificationHighWatermarks = () => ({ E32: 180 });
    const query = jest.fn(async (sql) => {
      if (sql.includes('FROM ecf_documents')) return [{ encf: 'E320000000111' }];
      if (sql.includes('FROM ecf_sequence_usage')) return [];
      if (sql.includes('FROM ecf_sequences')) {
        return [{ id: 7, tipo_comprobante: 'E32', numero_final: 10000000, proximo_numero: 112, activo: 1 }];
      }
      return { affectedRows: 1 };
    });
    service.repository = { query };

    const maxima = await service._syncCertificationSequenceHighWatermarks();

    expect(maxima.E32).toBe(180);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE ecf_sequences SET proximo_numero'),
      [181, 1, 7],
    );
  });
});
