/**
 * pos-client.js — Cliente HTTP de solo lectura contra el backend del POS (server.js).
 *
 * - Hace login una vez con un usuario dedicado y cachea el Bearer opaco que emite
 *   `POST /api/login`.
 * - Reintenta el login automáticamente cuando el POS responde 401 (token expirado).
 * - Cachea el "bootstrap" del login (clientes, catálogo) con un TTL, para las
 *   herramientas que no tienen un endpoint REST propio (p. ej. buscar_cliente).
 *
 * NO expone ningún método de escritura a propósito: la Fase 1 del MCP es read-only.
 */

export function createPosClient({
  baseUrl,
  user,
  password,
  bootstrapTtlMs = 5 * 60 * 1000,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  if (!baseUrl) throw new Error('createPosClient: baseUrl es obligatorio');
  const fetchFn = fetchImpl;

  let token = null;
  let loginPromise = null;
  let bootstrap = null;
  let bootstrapAt = 0;

  async function doLogin() {
    const res = await fetchFn(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario: user, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.token) {
      const msg = body?.error || `HTTP ${res.status}`;
      throw new Error(`Login del POS falló: ${msg}`);
    }
    token = body.token;
    bootstrap = body.data || null;
    bootstrapAt = now();
    return token;
  }

  async function ensureToken() {
    if (token) return token;
    if (!loginPromise) {
      loginPromise = doLogin().finally(() => {
        loginPromise = null;
      });
    }
    return loginPromise;
  }

  /**
   * GET autenticado contra el POS. `path` empieza con "/". `params` es un objeto
   * plano de query string (los valores null/undefined/'' se omiten).
   * Reintenta una vez si el POS devuelve 401.
   */
  async function get(path, params = {}) {
    await ensureToken();

    const url = new URL(`${baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v === null || v === undefined || v === '') continue;
      url.searchParams.set(k, String(v));
    }

    const doFetch = () =>
      fetchFn(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'x-auth-token': token,
          Accept: 'application/json',
        },
      });

    let res = await doFetch();
    if (res.status === 401) {
      token = null;
      await ensureToken();
      res = await doFetch();
    }

    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (body && body.error) || `HTTP ${res.status}`;
      throw new Error(`POS ${path} → ${msg}`);
    }
    return body;
  }

  /** Snapshot del login (config, clientes, productos, ventas recientes, caja). Cacheado por TTL. */
  async function getBootstrap({ force = false } = {}) {
    const stale = now() - bootstrapAt > bootstrapTtlMs;
    if (force || !bootstrap || stale) {
      token = null; // fuerza un login fresco para traer datos actualizados
      await ensureToken();
    }
    return bootstrap || {};
  }

  return { get, getBootstrap, ensureToken };
}
