import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { config } from './config.js';
import { createPosClient } from './pos-client.js';
import { buildMcpServer } from './server.js';
import { createOAuthProvider } from './oauth/provider.js';

const pos = createPosClient({
  baseUrl: config.posBaseUrl,
  user: config.posUser,
  password: config.posPassword,
  bootstrapTtlMs: config.bootstrapTtlMs,
});

const { provider, handleLoginSubmit, startSweeper } = createOAuthProvider({
  storePath: config.auth.storePath,
  users: { user: config.auth.user, password: config.auth.password },
  tokenTtlSec: config.auth.tokenTtlSec,
  publicUrl: config.publicUrl,
  serverName: config.serverName,
});
startSweeper();

// Verificador combinado: acepta el token de máquina estático (si está definido)
// y, si no, delega en el proveedor OAuth.
const verifier = {
  async verifyAccessToken(token) {
    if (config.staticToken && token === config.staticToken) {
      return {
        token,
        clientId: 'static-machine-token',
        scopes: [],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    }
    return provider.verifyAccessToken(token);
  },
};

const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL('/mcp', config.publicUrl));

const app = express();
app.use(express.json({ limit: '1mb' }));

// ── Healthcheck (sin auth) ───────────────────────────────────────────────────
app.get('/healthz', (_req, res) =>
  res.json({ ok: true, server: config.serverName, version: config.serverVersion })
);

// ── OAuth 2.1: metadata, /authorize, /token, /register, /revoke ──────────────
app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: new URL(config.publicUrl),
    resourceServerUrl: new URL('/mcp', config.publicUrl),
    scopesSupported: ['mcp'],
    resourceName: config.serverName,
  })
);
// Envío del formulario de login (pantalla que renderiza provider.authorize()).
app.post('/oauth/login', express.urlencoded({ extended: false }), (req, res) => {
  handleLoginSubmit(req, res).catch((e) => {
    console.error('[oauth] login submit:', e);
    if (!res.headersSent) res.status(500).type('text/plain').send('Error interno');
  });
});

// ── Endpoint MCP (Streamable HTTP, stateless) protegido por Bearer ───────────
const bearer = requireBearerAuth({ verifier, resourceMetadataUrl });

app.post('/mcp', bearer, async (req, res) => {
  const server = buildMcpServer(pos, { name: config.serverName, version: config.serverVersion });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] error manejando request:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Error interno del servidor MCP.' },
        id: null,
      });
    }
  }
});

const methodNotAllowed = (_req, res) =>
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Método no permitido (servidor MCP stateless).' },
    id: null,
  });
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

app.listen(config.port, config.bindHost, () => {
  console.log(
    `[tecno-caja-mcp] escuchando en http://${config.bindHost}:${config.port}` +
      `  ·  público: ${config.publicUrl}/mcp`
  );
  console.log(
    `[tecno-caja-mcp] OAuth issuer ${config.publicUrl} · usuario de login "${config.auth.user}"` +
      (config.staticToken ? ' · token de máquina: ACTIVO' : '')
  );
  pos.ensureToken().then(
    () => console.log('[tecno-caja-mcp] login con el POS OK'),
    (e) => console.error('[tecno-caja-mcp] AVISO: no se pudo hacer login con el POS todavía:', e.message)
  );
});
