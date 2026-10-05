'use strict';

/**
 * tests/routes/connectivity.routes.test.js
 *
 * El estado separa base de datos (LAN/local), Internet y pendientes: sin
 * Internet se sigue vendiendo ("local"); una terminal sin la base de la
 * principal pasa a "contingencia".
 */

const express = require('express');
const request = require('supertest');
const { EventEmitter } = require('events');
const createConnectivityRouter = require('../../server/routes/connectivity.routes');

function fakeMonitor(online) {
  const monitor = new EventEmitter();
  monitor.state = { online };
  monitor.getStatus = () => ({ online: monitor.state.online, checked: monitor.state.online !== null, lastCheckAt: null, lastChangeAt: null, lastError: null, simulated: false });
  monitor.setSimulatedOffline = jest.fn(async (value) => { monitor.state.online = !value; return !value; });
  return monitor;
}

function buildApp({ dbOk = true, online = true, role = 'principal', allowSimulation = false } = {}) {
  const app = express();
  const monitor = fakeMonitor(online);
  app.use('/api/connectivity', createConnectivityRouter({
    query: jest.fn(async () => {
      if (!dbOk) throw new Error('connect ECONNREFUSED');
      return [{ ok: 1 }];
    }),
    monitor,
    getRole: () => role,
    getCloudStatus: async () => ({ firebaseReady: true, queue: { pending: 3, errors: 0 } }),
    countDeferredEcf: async () => 2,
    countContingencySales: async () => (role === 'terminal' ? 5 : 0),
    allowSimulation,
  }));
  return { app, monitor };
}

describe('GET /api/connectivity', () => {
  test('todo bien → normal, con los pendientes separados', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/connectivity');
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('normal');
    expect(res.body.database.ok).toBe(true);
    expect(res.body.cloud.ready).toBe(true);
    expect(res.body.pending).toEqual({ cloud: 3, cloudErrors: 0, ecf: 2, contingencySales: 0 });
  });

  test('sin Internet pero con base → modo local (se vende igual)', async () => {
    const { app } = buildApp({ online: false });
    const res = await request(app).get('/api/connectivity');
    expect(res.body.mode).toBe('local');
    expect(res.body.database.ok).toBe(true);
    expect(res.body.internet.online).toBe(false);
  });

  test('terminal sin la base de la principal → contingencia', async () => {
    const { app } = buildApp({ dbOk: false, role: 'terminal' });
    const res = await request(app).get('/api/connectivity');
    expect(res.body.mode).toBe('contingencia');
    expect(res.body.pending.contingencySales).toBe(5);
  });

  test('principal sin su base → sin_bd (no se confunde con Internet)', async () => {
    const { app } = buildApp({ dbOk: false, online: true });
    const res = await request(app).get('/api/connectivity');
    expect(res.body.mode).toBe('sin_bd');
    expect(res.body.database.error).toContain('ECONNREFUSED');
  });
});

describe('POST /api/connectivity/simulate', () => {
  test('desactivado por defecto', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/connectivity/simulate').send({ offline: true });
    expect(res.status).toBe(404);
  });

  test('con el interruptor de pruebas y desde este equipo, simula sin Internet', async () => {
    const { app, monitor } = buildApp({ allowSimulation: true });
    const res = await request(app).post('/api/connectivity/simulate').send({ offline: true });
    expect(res.status).toBe(200);
    expect(monitor.setSimulatedOffline).toHaveBeenCalledWith(true);
  });
});
