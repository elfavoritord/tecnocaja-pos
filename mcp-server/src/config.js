import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// El .env vive en la raíz de mcp-server/, no en src/.
loadEnv({ path: resolve(__dirname, '..', '.env') });

function req(name) {
  const v = String(process.env[name] || '').trim();
  if (!v) {
    console.error(`[config] Falta la variable de entorno obligatoria ${name}. Revisa mcp-server/.env`);
    process.exit(1);
  }
  return v;
}

function opt(name, fallback) {
  const v = String(process.env[name] || '').trim();
  return v || fallback;
}

const port = Number(opt('MCP_PORT', '3400'));

// URL pública HTTPS con la que ChatGPT / Claude llegan al servidor (a través del
// túnel Cloudflare con nombre fijo). Es el "issuer" OAuth: debe ser https salvo
// localhost/127.0.0.1, y sin query ni fragmento.
const publicUrl = opt('MCP_PUBLIC_URL', `http://127.0.0.1:${port}`).replace(/\/+$/, '');

export const config = {
  port,
  bindHost: opt('MCP_BIND_HOST', '127.0.0.1'),
  publicUrl,

  // ── OAuth 2.1 (login propio usuario/clave) ────────────────────────────────
  auth: {
    // Credenciales del único usuario que puede iniciar sesión en el MCP.
    user: req('MCP_AUTH_USER'),
    password: req('MCP_AUTH_PASSWORD'),
    // Vida del access token (segundos). El refresh token no caduca (se rota al usarlo).
    tokenTtlSec: Number(opt('MCP_TOKEN_TTL_SEC', '3600')),
    // Archivo JSON donde se persisten clientes OAuth registrados y refresh tokens.
    storePath: opt('MCP_OAUTH_STORE', resolve(__dirname, '..', '.oauth-store.json')),
  },

  // Token de máquina OPCIONAL: si se define, se acepta como Bearer sin pasar por
  // OAuth (útil para Claude Code / curl / scripts). Si se deja vacío, solo OAuth.
  staticToken: opt('MCP_ACCESS_TOKEN', ''),

  // ── Backend del POS ───────────────────────────────────────────────────────
  posBaseUrl: opt('POS_BASE_URL', 'http://127.0.0.1:3399').replace(/\/+$/, ''),
  posUser: req('POS_MCP_USER'),
  posPassword: req('POS_MCP_PASSWORD'),
  bootstrapTtlMs: Number(opt('POS_BOOTSTRAP_TTL_MS', String(5 * 60 * 1000))),

  serverName: opt('MCP_SERVER_NAME', 'tecno-caja-pos'),
  serverVersion: '0.2.0',
};
