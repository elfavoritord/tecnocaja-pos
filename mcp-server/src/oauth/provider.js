import crypto from 'node:crypto';
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidClientError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { createOAuthStore } from './store.js';

const rnd = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
const now = () => Math.floor(Date.now() / 1000);
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

function safeEqual(a, b) {
  // Comparación en tiempo constante sin filtrar la longitud.
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function loginPage({ params, clientId, error, publicUrl, serverName }) {
  const hidden = {
    client_id: clientId ?? params.clientId,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    scope: (params.scopes || []).join(' '),
    state: params.state || '',
    resource: params.resource ? params.resource.href : '',
  };
  const inputs = Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('\n      ');

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Acceso · ${esc(serverName)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
         display: grid; place-items: center; min-height: 100vh; margin: 0;
         background: #f4f4f5; }
  @media (prefers-color-scheme: dark) { body { background: #18181b; } }
  .card { background: Canvas; color: CanvasText; width: min(360px, 92vw);
          padding: 28px; border-radius: 14px; box-shadow: 0 8px 30px rgba(0,0,0,.12); }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { margin: 0 0 20px; opacity: .7; font-size: 13px; }
  label { display: block; font-size: 13px; margin: 12px 0 4px; font-weight: 600; }
  input[type=text], input[type=password] { width: 100%; box-sizing: border-box;
          padding: 10px 12px; border: 1px solid #a1a1aa; border-radius: 8px;
          background: Field; color: FieldText; font-size: 15px; }
  button { margin-top: 20px; width: 100%; padding: 11px; border: 0; border-radius: 8px;
           background: #2563eb; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  .err { margin-top: 14px; padding: 9px 12px; border-radius: 8px; font-size: 13px;
         background: #fee2e2; color: #991b1b; }
  .foot { margin-top: 18px; font-size: 11px; opacity: .55; text-align: center; word-break: break-all; }
</style>
</head>
<body>
  <form class="card" method="POST" action="${esc(publicUrl)}/oauth/login">
    <h1>Conectar con ${esc(serverName)}</h1>
    <p class="sub">Inicia sesión para autorizar el acceso de solo lectura a tu POS.</p>
    ${inputs}
    <label for="u">Usuario</label>
    <input id="u" name="username" type="text" autocomplete="username" autofocus required>
    <label for="p">Contraseña</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    <button type="submit">Autorizar</button>
    <div class="foot">${esc(params.clientId)}</div>
  </form>
</body>
</html>`;
}

/**
 * Crea el OAuthServerProvider (login propio usuario/clave) que consume el
 * `mcpAuthRouter` de la SDK, más los handlers para la pantalla de login.
 */
export function createOAuthProvider({ storePath, users, tokenTtlSec, publicUrl, serverName }) {
  const store = createOAuthStore(storePath);

  // Memoria efímera: no tiene sentido persistir estos.
  const authCodes = new Map(); // code -> { clientId, redirectUri, codeChallenge, scopes, resource, exp }
  const accessTokens = new Map(); // token -> { clientId, scopes, resource, exp }

  const AUTH_CODE_TTL = 300; // 5 min

  function issueTokens({ clientId, scopes = [], resource }) {
    const access = rnd(32);
    const refresh = rnd(32);
    accessTokens.set(access, { clientId, scopes, resource, exp: now() + tokenTtlSec });
    store.putRefresh(refresh, { clientId, scopes, resource: resource || null });
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: tokenTtlSec,
      refresh_token: refresh,
      scope: scopes.length ? scopes.join(' ') : undefined,
    };
  }

  function checkCredentials(username, password) {
    // Se comparan ambos aunque el usuario falle, para no filtrar cuál de los dos era incorrecto.
    const okUser = safeEqual(username || '', users.user);
    const okPass = safeEqual(password || '', users.password);
    return okUser && okPass;
  }

  const clientsStore = {
    getClient(clientId) {
      return store.getClient(clientId);
    },
    registerClient(client) {
      if (!Array.isArray(client.redirect_uris) || client.redirect_uris.length === 0) {
        throw new InvalidRequestError('redirect_uris es obligatorio');
      }
      return store.putClient(client);
    },
  };

  const provider = {
    get clientsStore() {
      return clientsStore;
    },

    async authorize(client, params, res) {
      // `mcpAuthRouter` ya validó client_id y redirect_uri antes de llegar aquí.
      // OJO: la SDK NO mete client_id en `params`, hay que sacarlo de `client`.
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(loginPage({ params, clientId: client.client_id, publicUrl, serverName }));
    },

    async challengeForAuthorizationCode(client, authorizationCode) {
      const rec = authCodes.get(authorizationCode);
      if (!rec || rec.clientId !== client.client_id) {
        throw new InvalidGrantError('Código de autorización inválido');
      }
      return rec.codeChallenge;
    },

    async exchangeAuthorizationCode(client, authorizationCode, _verifier, redirectUri) {
      const rec = authCodes.get(authorizationCode);
      authCodes.delete(authorizationCode); // un solo uso
      if (!rec || rec.exp < now()) {
        throw new InvalidGrantError('Código de autorización inválido o expirado');
      }
      if (rec.clientId !== client.client_id) {
        throw new InvalidGrantError('El código pertenece a otro cliente');
      }
      if (redirectUri !== undefined && redirectUri !== rec.redirectUri) {
        throw new InvalidGrantError('redirect_uri no coincide con el de la autorización');
      }
      return issueTokens({ clientId: client.client_id, scopes: rec.scopes, resource: rec.resource });
    },

    async exchangeRefreshToken(client, refreshToken, scopes) {
      const rec = store.getRefresh(refreshToken);
      if (!rec || rec.clientId !== client.client_id) {
        throw new InvalidGrantError('Refresh token inválido');
      }
      store.deleteRefresh(refreshToken); // rotación
      const nextScopes = scopes && scopes.length ? scopes : rec.scopes || [];
      return issueTokens({
        clientId: client.client_id,
        scopes: nextScopes,
        resource: rec.resource || undefined,
      });
    },

    async verifyAccessToken(token) {
      const rec = accessTokens.get(token);
      if (!rec) throw new InvalidTokenError('Token desconocido');
      if (rec.exp < now()) {
        accessTokens.delete(token);
        throw new InvalidTokenError('Token expirado');
      }
      return {
        token,
        clientId: rec.clientId,
        scopes: rec.scopes || [],
        expiresAt: rec.exp,
        resource: rec.resource ? new URL(rec.resource) : undefined,
      };
    },

    async revokeToken(client, request) {
      const t = request.token;
      accessTokens.delete(t);
      store.deleteRefresh(t);
    },
  };

  /**
   * Handler de `POST /oauth/login` (envío del formulario de la pantalla de login).
   * Debe montarse en el app con express.urlencoded() delante.
   */
  async function handleLoginSubmit(req, res) {
    const b = req.body || {};
    const params = {
      clientId: String(b.client_id || ''),
      redirectUri: String(b.redirect_uri || ''),
      codeChallenge: String(b.code_challenge || ''),
      scopes: String(b.scope || '').split(' ').filter(Boolean),
      state: String(b.state || ''),
      resource: b.resource ? tryUrl(b.resource) : undefined,
    };

    const client = store.getClient(params.clientId);
    if (!client) {
      return res.status(400).type('text/plain').send('client_id inválido');
    }
    const okRedirect = client.redirect_uris.some((r) => redirectUriMatches(params.redirectUri, r));
    if (!okRedirect) {
      return res.status(400).type('text/plain').send('redirect_uri no registrado');
    }
    if (!params.codeChallenge) {
      return res.status(400).type('text/plain').send('Falta code_challenge (PKCE)');
    }

    if (!checkCredentials(b.username, b.password)) {
      res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(
        loginPage({ params, publicUrl, serverName, error: 'Usuario o contraseña incorrectos.' })
      );
    }

    const code = rnd(32);
    authCodes.set(code, {
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes,
      resource: params.resource,
      exp: now() + AUTH_CODE_TTL,
    });

    const to = new URL(params.redirectUri);
    to.searchParams.set('code', code);
    if (params.state) to.searchParams.set('state', params.state);
    res.redirect(302, to.href);
  }

  function startSweeper() {
    const iv = setInterval(() => {
      const t = now();
      for (const [k, v] of authCodes) if (v.exp < t) authCodes.delete(k);
      for (const [k, v] of accessTokens) if (v.exp < t) accessTokens.delete(k);
    }, 60_000);
    iv.unref?.();
    return iv;
  }

  return { provider, handleLoginSubmit, startSweeper };
}

function tryUrl(s) {
  try {
    return new URL(s);
  } catch {
    return undefined;
  }
}
