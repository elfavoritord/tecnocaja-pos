'use strict';

/**
 * tests/network/principal-watcher.test.js
 *
 * Caja terminal con la base de la PC principal por la LAN: si la principal
 * cambia de IP, se reencuentra y se reconecta sola; nunca a otra principal.
 */

const { startPrincipalWatcher } = require('../../server/network/principal-watcher');

function setup({ config, dbUp = false, found = null, reachable = true } = {}) {
  const state = {
    config: { isMain: false, principalHost: '192.168.1.40', principalBaseUrl: 'http://192.168.1.40:3399', principalServerId: 'srv_aaaaaaaaaaaaaaaa', principalHostname: 'PC-ADMIN', ...config },
    dbUp,
    saved: [],
    persisted: [],
    reloads: 0,
  };
  const env = { DB_HOST: '192.168.1.40', DB_PORT: '3306', PORT: '3399' };
  const query = jest.fn(async () => {
    if (state.dbUp) return [{ ok: 1 }];
    throw Object.assign(new Error('connect ECONNREFUSED 192.168.1.40:3306'), { code: 'ECONNREFUSED' });
  });
  const findPrincipal = jest.fn(async () => found);
  const watcher = startPrincipalWatcher({
    query,
    env,
    getTerminalConfig: () => state.config,
    saveTerminalConfig: (cfg) => { state.config = cfg; state.saved.push(cfg); return true; },
    persistRuntimeEnvValues: (values) => { Object.assign(env, values); state.persisted.push(values); },
    reloadDatabase: async () => { state.reloads += 1; },
    findPrincipal,
    probeIdentify: jest.fn(async () => ({ isMain: true, serverId: 'srv_cccccccccccccccc', hostname: 'PC-NUEVA' })),
    reachable: async () => reachable,
    intervalMs: 3600000,
    logger: { log() {}, warn() {} },
  });
  return { watcher, state, env, findPrincipal, query };
}

describe('principal-watcher', () => {
  test('la principal cambió de IP: guarda la nueva y reconecta la base', async () => {
    const { watcher, state, env, findPrincipal } = setup({
      found: { host: '192.168.1.88', port: 3399, baseUrl: 'http://192.168.1.88:3399', hostname: 'PC-ADMIN', foundBy: 'scan' },
    });
    expect((await watcher.tick(0)).reason).toBe('waiting'); // 1er fallo: espera
    const result = await watcher.tick(1000);
    watcher.stop();
    expect(result.relocated).toBe(true);
    expect(findPrincipal).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'srv_aaaaaaaaaaaaaaaa', hostnames: ['PC-ADMIN'], port: 3399 }));
    expect(env.DB_HOST).toBe('192.168.1.88');
    expect(state.config.principalHost).toBe('192.168.1.88');
    expect(state.config.principalBaseUrl).toBe('http://192.168.1.88:3399');
    expect(state.reloads).toBe(1);
  });

  test('misma IP (principal apagada): no toca nada y sigue en contingencia', async () => {
    const { watcher, state, env } = setup({ found: { host: '192.168.1.40', port: 3399, baseUrl: 'http://192.168.1.40:3399' } });
    await watcher.tick(0);
    await watcher.tick(1000);
    watcher.stop();
    expect(env.DB_HOST).toBe('192.168.1.40');
    expect(state.reloads).toBe(0);
    expect(state.persisted).toHaveLength(0);
  });

  test('sin identificador guardado no busca otra IP (podría ser otro negocio)', async () => {
    const { watcher, findPrincipal, state } = setup({ config: { principalServerId: null } });
    await watcher.tick(0);
    await watcher.tick(1000);
    watcher.stop();
    expect(findPrincipal).not.toHaveBeenCalled();
    expect(state.reloads).toBe(0);
  });

  test('si la base de la nueva IP aún no responde, no cambia', async () => {
    const { watcher, env } = setup({ found: { host: '192.168.1.88', port: 3399, baseUrl: 'http://192.168.1.88:3399' }, reachable: false });
    await watcher.tick(0);
    await watcher.tick(1000);
    watcher.stop();
    expect(env.DB_HOST).toBe('192.168.1.40');
  });

  test('con la principal respondiendo, aprende su identificador si no lo tenía', async () => {
    const { watcher, state } = setup({ dbUp: true, config: { principalServerId: null, principalHostname: null } });
    const result = await watcher.tick(0);
    watcher.stop();
    expect(result.ok).toBe(true);
    expect(state.config.principalServerId).toBe('srv_cccccccccccccccc');
    expect(state.config.principalHostname).toBe('PC-NUEVA');
  });

  test('en la PC principal no hace nada', async () => {
    const watcher = startPrincipalWatcher({ getTerminalConfig: () => null });
    expect(await watcher.tick()).toBeNull();
    watcher.stop();
  });
});
