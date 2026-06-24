'use strict';

const { EcfRepository } = require('../modules/ecf/models/ecf.repository');

describe('EcfRepository numeric SQL guards', () => {
  test('recordSequenceUsage never sends NaN to SQL parameters', async () => {
    const calls = [];
    const repository = new EcfRepository({
      query: jest.fn(async (sql, params = []) => {
        calls.push({ sql, params });
        if (/SELECT id FROM ecf_sequence_usage/i.test(sql)) return [];
        return { insertId: 1 };
      }),
      withTransaction: jest.fn(),
    });

    await repository.recordSequenceUsage({
      businessId: 'bad-number',
      tipoEcf: 'E32',
      encf: 'E320000000011',
      sequenceNumber: Number.NaN,
      status: 'ACCEPTED',
    });

    const insert = calls.find((call) => /INSERT INTO ecf_sequence_usage/i.test(call.sql));
    expect(insert).toBeTruthy();
    expect(insert.params).not.toContain(Number.NaN);
    expect(insert.params[0]).toBe(1);
    expect(insert.params[4]).toBe(0);
  });

  test('saveImportedDocument normalizes NaN money and index values before INSERT', async () => {
    const calls = [];
    const conn = {
      query: jest.fn(async (sql, params = []) => {
        calls.push({ sql, params });
        if (/SELECT \* FROM ecf_documents/i.test(sql)) return [];
        return { insertId: 7 };
      }),
    };
    const repository = new EcfRepository({
      query: jest.fn(),
      withTransaction: jest.fn(),
    });

    await repository.saveImportedDocument(conn, 'bad-business', {
      sequenceId: Number.NaN,
      userId: Number.NaN,
      tipoEcf: 'E31',
      encf: 'E310000000001',
      estadoDgii: 'firmado',
      subtotal: Number.NaN,
      descuentoTotal: Number.NaN,
      montoExento: Number.NaN,
      montoGravado: Number.NaN,
      itbisTotal: Number.NaN,
      montoTotal: Number.NaN,
      certificationOrderIndex: Number.NaN,
    });

    const insert = calls.find((call) => /INSERT INTO ecf_documents/i.test(call.sql));
    expect(insert).toBeTruthy();
    expect(insert.params).not.toContain(Number.NaN);
    expect(insert.params[0]).toBe(1);
    expect(insert.params[1]).toBeNull();
    expect(insert.params[2]).toBeNull();
    expect(insert.params.slice(11, 17)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(insert.params[25]).toBeNull();
  });
});
