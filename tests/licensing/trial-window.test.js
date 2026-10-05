'use strict';

const {
  computeTrialWindow,
  parseUtcDbDateTime,
  toUtcDbDateTime,
} = require('../../server/licensing/trial-window');

describe('server/licensing/trial-window', () => {
  it('lee el DATETIME UTC igual venga como texto (SQLite) o como Date local (mysql2)', () => {
    const fromSqlite = parseUtcDbDateTime('2026-11-01 14:00:00');
    const fromMysql = parseUtcDbDateTime(new Date(2026, 10, 1, 14, 0, 0));

    expect(fromSqlite.toISOString()).toBe('2026-11-01T14:00:00.000Z');
    expect(fromMysql.toISOString()).toBe('2026-11-01T14:00:00.000Z');
  });

  it('leer y volver a guardar es idempotente', () => {
    let stored = '2026-11-01 14:00:00';
    for (let i = 0; i < 10; i += 1) {
      const [y, m, d, h, mi, s] = stored.split(/[- :]/).map(Number);
      stored = toUtcDbDateTime(parseUtcDbDateTime(new Date(y, m - 1, d, h, mi, s)));
    }
    expect(stored).toBe('2026-11-01 14:00:00');
  });

  it('el fin es siempre inicio + 30 días y nunca muestra más de 30', () => {
    const now = new Date('2026-04-01T10:00:00.000Z');

    const fresh = computeTrialWindow({ now });
    expect(fresh.daysLeft).toBe(30);
    expect(fresh.endsAt.toISOString()).toBe('2026-05-01T10:00:00.000Z');

    const inflated = computeTrialWindow({
      startedAt: new Date('2026-03-25T10:00:00.000Z'),
      endsAt: new Date('2026-06-30T10:00:00.000Z'),
      now,
    });
    expect(inflated.endsAt.toISOString()).toBe('2026-04-24T10:00:00.000Z');
    expect(inflated.daysLeft).toBe(23);

    const futureStart = computeTrialWindow({ startedAt: new Date('2026-04-05T10:00:00.000Z'), now });
    expect(futureStart.daysLeft).toBe(30);
  });

  it('sin inicio guardado lo reconstruye desde el fin', () => {
    const window = computeTrialWindow({
      endsAt: new Date('2026-05-01T10:00:00.000Z'),
      now: new Date('2026-05-02T10:00:00.000Z'),
    });
    expect(window.startedAt.toISOString()).toBe('2026-04-01T10:00:00.000Z');
    expect(window.expired).toBe(true);
    expect(window.daysLeft).toBe(0);
  });
});
