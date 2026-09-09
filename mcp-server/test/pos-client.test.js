import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPosClient } from '../src/pos-client.js';

function jsonResponse(body, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

test('login se hace una sola vez y el token se cachea', async () => {
  const calls = [];
  const fetchImpl = (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).endsWith('/api/login')) return jsonResponse({ token: 'T1', data: { clientes: [] } });
    return jsonResponse({ ok: true });
  };
  const pos = createPosClient({ baseUrl: 'http://pos', user: 'u', password: 'p', fetchImpl });

  await pos.get('/api/reports/x');
  await pos.get('/api/reports/y');

  const logins = calls.filter((c) => c.url.endsWith('/api/login'));
  assert.equal(logins.length, 1, 'solo un login');
  const authed = calls.filter((c) => c.url.includes('/api/reports/'));
  assert.equal(authed[0].opts.headers.Authorization, 'Bearer T1');
});

test('un 401 dispara re-login y reintento', async () => {
  let loginCount = 0;
  let firstCall = true;
  const fetchImpl = (url) => {
    if (String(url).endsWith('/api/login')) {
      loginCount += 1;
      return jsonResponse({ token: `T${loginCount}`, data: {} });
    }
    if (firstCall) {
      firstCall = false;
      return jsonResponse({ error: 'token vencido' }, 401);
    }
    return jsonResponse({ ok: true, via: 'reintento' });
  };
  const pos = createPosClient({ baseUrl: 'http://pos', user: 'u', password: 'p', fetchImpl });

  const out = await pos.get('/api/reports/z');
  assert.equal(out.via, 'reintento');
  assert.equal(loginCount, 2, 'se relogueó una vez');
});

test('get() arma el query string y omite valores vacíos', async () => {
  let seen = '';
  const fetchImpl = (url) => {
    if (String(url).endsWith('/api/login')) return jsonResponse({ token: 'T', data: {} });
    seen = String(url);
    return jsonResponse([]);
  };
  const pos = createPosClient({ baseUrl: 'http://pos', user: 'u', password: 'p', fetchImpl });
  await pos.get('/api/reports/advanced/kpis', { desde: '2026-09-01', hasta: '2026-09-04', branchId: null, x: '' });
  assert.match(seen, /desde=2026-09-01/);
  assert.match(seen, /hasta=2026-09-04/);
  assert.doesNotMatch(seen, /branchId/);
  assert.doesNotMatch(seen, /[?&]x=/);
});

test('getBootstrap cachea dentro del TTL y refresca al expirar', async () => {
  let loginCount = 0;
  let t = 0;
  const fetchImpl = (url) => {
    if (String(url).endsWith('/api/login')) {
      loginCount += 1;
      return jsonResponse({ token: `T${loginCount}`, data: { clientes: [{ id: loginCount }] } });
    }
    return jsonResponse({});
  };
  const pos = createPosClient({
    baseUrl: 'http://pos',
    user: 'u',
    password: 'p',
    fetchImpl,
    bootstrapTtlMs: 1000,
    now: () => t,
  });

  const b1 = await pos.getBootstrap();
  const b2 = await pos.getBootstrap();
  assert.equal(loginCount, 1);
  assert.deepEqual(b1, b2);

  t = 2000; // pasa el TTL
  const b3 = await pos.getBootstrap();
  assert.equal(loginCount, 2, 'se refrescó tras expirar el TTL');
  assert.equal(b3.clientes[0].id, 2);
});
