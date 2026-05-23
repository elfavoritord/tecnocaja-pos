'use strict';

const {
  REPORTS_BOOTSTRAP_CONFIG_KEY,
  ensureInitialReportsBootstrap,
} = require('../../server/services/firebase-initial-sync');

describe('server/services/firebase-initial-sync', () => {
  it('ejecuta el bootstrap y guarda la marca de completado', async () => {
    const store = new Map();
    const query = jest.fn(async (sql, params = []) => {
      if (sql.includes('SELECT config_value')) {
        const value = store.get(params[0]);
        return value ? [{ config_value: value }] : [];
      }
      if (sql.startsWith('DELETE FROM installation_config')) {
        store.delete(params[0]);
        return [];
      }
      if (sql.includes('INSERT INTO installation_config')) {
        store.set(params[0], params[1]);
        return [];
      }
      return [];
    });
    const bootstrapAll = jest.fn().mockResolvedValue({
      ok: true,
      businessId: 'pos_demo',
      sales: 8,
      products: 5,
      customers: 3,
    });

    const result = await ensureInitialReportsBootstrap({
      query,
      getConfig: async () => ({ nombre: 'Demo POS' }),
      isEnabled: () => true,
      bootstrapAll,
      logger: { log: jest.fn() },
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(false);
    expect(bootstrapAll).toHaveBeenCalledTimes(1);
    expect(store.has(REPORTS_BOOTSTRAP_CONFIG_KEY)).toBe(true);
  });

  it('omite el bootstrap si ya existe la marca', async () => {
    const query = jest.fn(async (sql, params = []) => {
      if (sql.includes('SELECT config_value')) {
        return [{ config_value: '2026-04-30T10:00:00.000Z' }];
      }
      throw new Error(`Query inesperada: ${sql} :: ${params.join(',')}`);
    });
    const bootstrapAll = jest.fn();

    const result = await ensureInitialReportsBootstrap({
      query,
      getConfig: async () => ({ nombre: 'Demo POS' }),
      isEnabled: () => true,
      bootstrapAll,
      logger: { log: jest.fn() },
    });

    expect(result).toEqual({
      ok: true,
      skipped: true,
      reason: 'already_bootstrapped',
      completedAt: '2026-04-30T10:00:00.000Z',
    });
    expect(bootstrapAll).not.toHaveBeenCalled();
  });

  it('no guarda la marca si Firebase todavía no está disponible', async () => {
    const query = jest.fn();
    const bootstrapAll = jest.fn();

    const result = await ensureInitialReportsBootstrap({
      query,
      getConfig: async () => ({ nombre: 'Demo POS' }),
      isEnabled: () => false,
      bootstrapAll,
      logger: { log: jest.fn() },
    });

    expect(result).toEqual({
      ok: false,
      skipped: true,
      reason: 'firebase_not_configured',
    });
    expect(query).not.toHaveBeenCalled();
    expect(bootstrapAll).not.toHaveBeenCalled();
  });
});
