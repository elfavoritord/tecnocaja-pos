'use strict';

const { createOfflineSessionMiddleware } = require('../../server/middleware/offline-session');

function build({ cache = new Map(), getDbSession = jest.fn(async () => null), getUserById = jest.fn(async () => null) } = {}) {
  const middleware = createOfflineSessionMiddleware({
    readAuthToken: (req) => String(req.headers.authorization || '').replace(/^Bearer /, ''),
    sessionCache: cache,
    getDbSession,
    getUserById,
    getSessionTtlMs: () => 60000,
    now: () => 1000,
  });
  const run = async (headers = {}) => {
    const req = { headers };
    const next = jest.fn();
    await middleware(req, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    return req;
  };
  return { run, cache, getDbSession, getUserById };
}

describe('sesión en contingencia (/api/offline)', () => {
  test('identifica al cajero desde el caché sin tocar la base caída', async () => {
    const cache = new Map([['tok-1', { user: { id: 7, nombre: 'Cajera' }, expiresAt: 5000 }]]);
    const getDbSession = jest.fn(async () => { throw new Error('connect ECONNREFUSED'); });
    const { run } = build({ cache, getDbSession });
    const req = await run({ authorization: 'Bearer tok-1' });
    expect(req.authUser).toMatchObject({ id: 7 });
    expect(getDbSession).not.toHaveBeenCalled();
  });

  test('una sesión vencida en caché no sirve', async () => {
    const cache = new Map([['tok-1', { user: { id: 7 }, expiresAt: 500 }]]);
    const { run } = build({ cache });
    const req = await run({ authorization: 'Bearer tok-1' });
    expect(req.authUser).toBeUndefined();
  });

  test('sin caché consulta la base y guarda la sesión para cuando se caiga', async () => {
    const getDbSession = jest.fn(async () => ({ user_id: 3 }));
    const getUserById = jest.fn(async () => ({ id: 3, estado: 'Activo' }));
    const { run, cache } = build({ getDbSession, getUserById });
    const req = await run({ authorization: 'Bearer tok-2' });
    expect(req.authUser).toMatchObject({ id: 3 });
    expect(cache.get('tok-2')).toMatchObject({ user: { id: 3 }, expiresAt: 61000 });
  });

  test('usuario inactivo o base caída: sigue sin usuario (la ruta responde 401)', async () => {
    const inactive = build({ getDbSession: jest.fn(async () => ({ user_id: 3 })), getUserById: jest.fn(async () => ({ id: 3, estado: 'Inactivo' })) });
    expect((await inactive.run({ authorization: 'Bearer tok-3' })).authUser).toBeUndefined();
    const down = build({ getDbSession: jest.fn(async () => { throw new Error('ETIMEDOUT'); }) });
    expect((await down.run({ authorization: 'Bearer tok-4' })).authUser).toBeUndefined();
    expect((await down.run({})).authUser).toBeUndefined();
  });
});
