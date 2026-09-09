import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createOAuthProvider } from '../src/oauth/provider.js';

function makeProvider() {
  const storePath = join(tmpdir(), `mcp-oauth-test-${randomUUID()}.json`);
  const p = createOAuthProvider({
    storePath,
    users: { user: 'emilio', password: 's3creta' },
    tokenTtlSec: 60,
    publicUrl: 'https://mcp.example.com',
    serverName: 'tecno-caja-pos',
  });
  return { ...p, storePath, cleanup: () => rmSync(storePath, { force: true }) };
}

function fakeRes() {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    redirectedTo: undefined,
    headersSent: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    type(t) {
      this.headers['content-type'] = t;
      return this;
    },
    send(b) {
      this.body = b;
      this.headersSent = true;
      return this;
    },
    redirect(code, url) {
      this.statusCode = code;
      this.redirectedTo = url;
      this.headersSent = true;
    },
  };
}

function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const CLIENT = {
  client_id: 'cid-123',
  client_name: 'ChatGPT',
  redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
};

test('registerClient persiste y getClient lo recupera', () => {
  const { provider, cleanup } = makeProvider();
  provider.clientsStore.registerClient({ ...CLIENT });
  assert.equal(provider.clientsStore.getClient('cid-123').client_name, 'ChatGPT');
  cleanup();
});

test('registerClient rechaza sin redirect_uris', () => {
  const { provider, cleanup } = makeProvider();
  assert.throws(() => provider.clientsStore.registerClient({ client_id: 'x', redirect_uris: [] }));
  cleanup();
});

test('authorize() renderiza la pantalla de login con los parámetros ocultos', async () => {
  const { provider, cleanup } = makeProvider();
  provider.clientsStore.registerClient({ ...CLIENT });
  const { challenge } = pkcePair();
  const res = fakeRes();
  await provider.authorize(
    CLIENT,
    { redirectUri: CLIENT.redirect_uris[0], codeChallenge: challenge, state: 'st-9', scopes: ['mcp'] },
    res
  );
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.body, /name="code_challenge" value="/);
  assert.match(res.body, /value="st-9"/);
  assert.match(res.body, /action="https:\/\/mcp\.example\.com\/oauth\/login"/);
  // El client_id oculto DEBE llevar el id real del cliente (venía vacío por un bug).
  assert.match(res.body, new RegExp(`name="client_id" value="${CLIENT.client_id}"`));
  cleanup();
});

// Extrae los <input type="hidden"> del formulario renderizado.
function hiddenFields(html) {
  const out = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    out[m[1]] = m[2].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  }
  return out;
}

test('el formulario renderizado se puede reenviar tal cual y funciona (sin inyectar client_id)', async () => {
  const { provider, handleLoginSubmit, cleanup } = makeProvider();
  provider.clientsStore.registerClient({ ...CLIENT });
  const { challenge } = pkcePair();

  const page = fakeRes();
  await provider.authorize(
    CLIENT,
    { redirectUri: CLIENT.redirect_uris[0], codeChallenge: challenge, state: 'st-x', scopes: ['mcp'] },
    page
  );
  const fields = hiddenFields(page.body);
  assert.equal(fields.client_id, CLIENT.client_id);
  assert.equal(fields.code_challenge, challenge);

  // Simula el submit del navegador: exactamente los hidden + credenciales.
  const res = fakeRes();
  await handleLoginSubmit({ body: { ...fields, username: 'emilio', password: 's3creta' } }, res);
  assert.equal(res.statusCode, 302, res.body);
  assert.ok(new URL(res.redirectedTo).searchParams.get('code'));
  cleanup();
});

test('login con credenciales malas → 401 y vuelve a mostrar el formulario', async () => {
  const { provider, handleLoginSubmit, cleanup } = makeProvider();
  provider.clientsStore.registerClient({ ...CLIENT });
  const { challenge } = pkcePair();
  const res = fakeRes();
  await handleLoginSubmit(
    {
      body: {
        client_id: CLIENT.client_id,
        redirect_uri: CLIENT.redirect_uris[0],
        code_challenge: challenge,
        state: 's',
        username: 'emilio',
        password: 'MALA',
      },
    },
    res
  );
  assert.equal(res.statusCode, 401);
  assert.match(res.body, /incorrect/i);
  cleanup();
});

test('login correcto → redirect al redirect_uri con code y state', async () => {
  const { provider, handleLoginSubmit, cleanup } = makeProvider();
  provider.clientsStore.registerClient({ ...CLIENT });
  const { challenge } = pkcePair();
  const res = fakeRes();
  await handleLoginSubmit(
    {
      body: {
        client_id: CLIENT.client_id,
        redirect_uri: CLIENT.redirect_uris[0],
        code_challenge: challenge,
        scope: 'mcp',
        state: 'xyz',
        username: 'emilio',
        password: 's3creta',
      },
    },
    res
  );
  assert.equal(res.statusCode, 302);
  const u = new URL(res.redirectedTo);
  assert.equal(u.origin + u.pathname, CLIENT.redirect_uris[0]);
  assert.ok(u.searchParams.get('code'));
  assert.equal(u.searchParams.get('state'), 'xyz');
  cleanup();
});

test('login rechaza redirect_uri no registrado', async () => {
  const { provider, handleLoginSubmit, cleanup } = makeProvider();
  provider.clientsStore.registerClient({ ...CLIENT });
  const { challenge } = pkcePair();
  const res = fakeRes();
  await handleLoginSubmit(
    {
      body: {
        client_id: CLIENT.client_id,
        redirect_uri: 'https://evil.example/callback',
        code_challenge: challenge,
        username: 'emilio',
        password: 's3creta',
      },
    },
    res
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /redirect_uri/);
  cleanup();
});

test('flujo completo: code → tokens → verify → refresh (rota) → revoke', async () => {
  const { provider, handleLoginSubmit, cleanup } = makeProvider();
  provider.clientsStore.registerClient({ ...CLIENT });
  const { challenge } = pkcePair();

  // 1. login → code
  const res = fakeRes();
  await handleLoginSubmit(
    {
      body: {
        client_id: CLIENT.client_id,
        redirect_uri: CLIENT.redirect_uris[0],
        code_challenge: challenge,
        scope: 'mcp',
        username: 'emilio',
        password: 's3creta',
      },
    },
    res
  );
  const code = new URL(res.redirectedTo).searchParams.get('code');

  // 2. challenge coincide con el enviado
  assert.equal(await provider.challengeForAuthorizationCode(CLIENT, code), challenge);

  // 3. code → tokens
  const tok = await provider.exchangeAuthorizationCode(CLIENT, code, undefined, CLIENT.redirect_uris[0]);
  assert.equal(tok.token_type, 'Bearer');
  assert.ok(tok.access_token && tok.refresh_token);
  assert.equal(tok.expires_in, 60);

  // 4. el code es de un solo uso
  await assert.rejects(() => provider.exchangeAuthorizationCode(CLIENT, code, undefined, CLIENT.redirect_uris[0]));

  // 5. verifyAccessToken
  const info = await provider.verifyAccessToken(tok.access_token);
  assert.equal(info.clientId, CLIENT.client_id);
  assert.equal(typeof info.expiresAt, 'number');

  // 6. refresh rota el refresh token
  const tok2 = await provider.exchangeRefreshToken(CLIENT, tok.refresh_token, ['mcp']);
  assert.ok(tok2.access_token !== tok.access_token);
  assert.ok(tok2.refresh_token !== tok.refresh_token);
  await assert.rejects(() => provider.exchangeRefreshToken(CLIENT, tok.refresh_token), /Refresh token/);

  // 7. revoke invalida el access token
  await provider.revokeToken(CLIENT, { token: tok2.access_token });
  await assert.rejects(() => provider.verifyAccessToken(tok2.access_token));

  cleanup();
});

test('verifyAccessToken rechaza basura', async () => {
  const { provider, cleanup } = makeProvider();
  await assert.rejects(() => provider.verifyAccessToken('no-existe'));
  cleanup();
});

test('el store persiste refresh tokens entre instancias', async () => {
  const first = makeProvider();
  first.provider.clientsStore.registerClient({ ...CLIENT });
  const { challenge } = pkcePair();
  const res = fakeRes();
  await first.handleLoginSubmit(
    {
      body: {
        client_id: CLIENT.client_id,
        redirect_uri: CLIENT.redirect_uris[0],
        code_challenge: challenge,
        username: 'emilio',
        password: 's3creta',
      },
    },
    res
  );
  const code = new URL(res.redirectedTo).searchParams.get('code');
  const tok = await first.provider.exchangeAuthorizationCode(CLIENT, code, undefined, CLIENT.redirect_uris[0]);

  // Nueva instancia sobre el mismo archivo: el cliente y el refresh siguen ahí.
  const second = createOAuthProvider({
    storePath: first.storePath,
    users: { user: 'emilio', password: 's3creta' },
    tokenTtlSec: 60,
    publicUrl: 'https://mcp.example.com',
    serverName: 'tecno-caja-pos',
  });
  assert.ok(second.provider.clientsStore.getClient(CLIENT.client_id));
  const tok2 = await second.provider.exchangeRefreshToken(CLIENT, tok.refresh_token, ['mcp']);
  assert.ok(tok2.access_token);

  first.cleanup();
});
