import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Persistencia mínima en un archivo JSON para el servidor OAuth:
 *  - `clients`: clientes registrados vía Dynamic Client Registration (RFC 7591).
 *  - `refreshTokens`: refresh tokens vigentes (se rotan al usarlos).
 *
 * Los authorization codes y los access tokens NO se persisten: son de vida corta
 * y sobrevivir a un reinicio no aporta (el cliente simplemente refresca).
 */
export function createOAuthStore(path) {
  let data = { clients: {}, refreshTokens: {} };

  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    data = {
      clients: parsed.clients || {},
      refreshTokens: parsed.refreshTokens || {},
    };
  } catch {
    // Primera ejecución: el archivo aún no existe. Se creará al primer save().
  }

  function save() {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      /* noop */
    }
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  }

  return {
    // ── Clientes ───────────────────────────────────────────────────────────
    getClient(clientId) {
      return data.clients[clientId];
    },
    putClient(client) {
      data.clients[client.client_id] = client;
      save();
      return client;
    },

    // ── Refresh tokens ─────────────────────────────────────────────────────
    getRefresh(token) {
      return data.refreshTokens[token];
    },
    putRefresh(token, info) {
      data.refreshTokens[token] = info;
      save();
    },
    deleteRefresh(token) {
      if (data.refreshTokens[token]) {
        delete data.refreshTokens[token];
        save();
      }
    },
  };
}
