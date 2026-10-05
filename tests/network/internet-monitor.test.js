'use strict';

/**
 * tests/network/internet-monitor.test.js
 *
 * El monitor decide "hay Internet" con DNS + conexión TCP real, emite eventos
 * solo cuando el estado cambia y distingue "desconocido" de "sin Internet".
 */

const { InternetMonitor } = require('../../server/network/internet-monitor');

function buildMonitor({ online = true, simulateOffline = false } = {}) {
  const state = { online, calls: 0 };
  const monitor = new InternetMonitor({
    simulateOffline,
    targets: [{ host: 'a.test', port: 443 }, { host: 'b.test', port: 443 }],
    resolveHost: async (host) => `${host}-ip`,
    tcpProbe: async () => {
      state.calls += 1;
      return state.online ? { ok: true } : { ok: false, error: 'ECONNREFUSED' };
    },
  });
  return { monitor, state };
}

describe('InternetMonitor', () => {
  test('arranca en "desconocido": no se considera sin Internet', () => {
    const { monitor } = buildMonitor();
    expect(monitor.getStatus().online).toBeNull();
    expect(monitor.isKnownOffline()).toBe(false);
    expect(monitor.isOnline()).toBe(false);
  });

  test('con un destino que responde, hay Internet', async () => {
    const { monitor } = buildMonitor({ online: true });
    await expect(monitor.check()).resolves.toBe(true);
    expect(monitor.isOnline()).toBe(true);
    expect(monitor.getStatus().checked).toBe(true);
  });

  test('si ningún destino responde, se sabe que no hay Internet', async () => {
    const { monitor, state } = buildMonitor({ online: false });
    await expect(monitor.check()).resolves.toBe(false);
    expect(monitor.isKnownOffline()).toBe(true);
    expect(state.calls).toBe(2); // probó todos los destinos
    expect(monitor.getStatus().lastError).toContain('ECONNREFUSED');
  });

  test('el DNS que falla también cuenta como sin Internet', async () => {
    const monitor = new InternetMonitor({
      targets: [{ host: 'a.test', port: 443 }],
      resolveHost: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); },
      tcpProbe: async () => ({ ok: true }),
    });
    await expect(monitor.check()).resolves.toBe(false);
    expect(monitor.getStatus().lastError).toContain('ENOTFOUND');
  });

  test('emite change/online/offline solo cuando el estado cambia', async () => {
    const { monitor, state } = buildMonitor({ online: true });
    const events = [];
    monitor.on('change', (online) => events.push(`change:${online}`));
    monitor.on('online', () => events.push('online'));
    monitor.on('offline', () => events.push('offline'));

    await monitor.check();
    await monitor.check(); // sin cambio: no emite
    state.online = false;
    await monitor.check();
    state.online = true;
    await monitor.check();

    expect(events).toEqual(['change:true', 'online', 'change:false', 'offline', 'change:true', 'online']);
  });

  test('una sola comprobación a la vez', async () => {
    let resolveProbe;
    const monitor = new InternetMonitor({
      targets: [{ host: 'a.test', port: 443 }],
      resolveHost: async (host) => host,
      tcpProbe: () => new Promise((resolve) => { resolveProbe = resolve; }),
    });
    const first = monitor.check();
    const second = monitor.check();
    expect(second).toBe(first);
    await new Promise((r) => setImmediate(r));
    resolveProbe({ ok: true });
    await expect(first).resolves.toBe(true);
  });

  test('modo simulado: sin Internet sin tocar la red', async () => {
    const { monitor, state } = buildMonitor({ online: true, simulateOffline: true });
    await expect(monitor.check()).resolves.toBe(false);
    expect(state.calls).toBe(0);
    expect(monitor.getStatus().simulated).toBe(true);
    await expect(monitor.setSimulatedOffline(false)).resolves.toBe(true);
    expect(monitor.isOnline()).toBe(true);
  });
});
