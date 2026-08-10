'use strict';

process.env.NODE_ENV = 'test';

const request = require('supertest');
const { createApp } = require('../lib/app');
const { createMemoryStore } = require('../lib/store');

describe('GET /health', () => {
  it('responde 200 con status ok', async () => {
    const app = createApp({ store: createMemoryStore() });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('tecno-caja-ecf-gateway');
  });
});
