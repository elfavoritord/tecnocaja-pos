'use strict';

/**
 * server/network/principal-watcher.js
 *
 * Solo en una caja TERMINAL que trabaja con la base de datos de la PC
 * principal por la LAN (DB_HOST = IP de la principal).
 *
 * Si la principal deja de responder:
 *   - la caja ya pasa sola a modo contingencia (vende en su copia local,
 *     ver server/routes/offline.routes.js) — eso no cambia;
 *   - este vigilante además busca la principal en la red por su
 *     identificador (server/network/lan-discovery.js). Si la encuentra con
 *     OTRA IP (el router le cambió la IP por DHCP), guarda la nueva IP y
 *     reconecta la base sin reiniciar ni pedirle nada al cajero.
 *
 * Mientras la principal sí responde, guarda su identificador y nombre de
 * equipo si la caja se vinculó con una versión vieja que no los tenía.
 */

const net = require('net');

const DB_NETWORK_ERROR = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|PROTOCOL_CONNECTION_LOST|ECONNRESET|connect timeout|no respondió/i;

function tcpReachable(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function portFromBaseUrl(baseUrl, fallback) {
  try {
    const url = new URL(baseUrl);
    return Number(url.port || fallback);
  } catch (_error) {
    return fallback;
  }
}

function startPrincipalWatcher({
  query,
  getTerminalConfig,
  saveTerminalConfig,
  persistRuntimeEnvValues,
  reloadDatabase,
  findPrincipal,
  probeIdentify,
  env = process.env,
  intervalMs = 30000,
  rescanCooldownMs = 60000,
  logger = console,
  reachable = tcpReachable,
} = {}) {
  const terminalConfig = getTerminalConfig();
  if (!terminalConfig || terminalConfig.isMain !== false) return { stop() {}, tick: async () => null };

  let failures = 0;
  let lastScanAt = -Infinity;
  let busy = false;

  async function dbAlive() {
    let timer = null;
    try {
      await Promise.race([
        query('SELECT 1 AS ok'),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('La base de la principal no respondió.')), 4000);
        }),
      ]);
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    } finally {
      clearTimeout(timer);
    }
  }

  // Cajas vinculadas antes de esta versión: aprender el identificador de la
  // principal mientras responde, para poder reencontrarla después.
  async function learnIdentity(config) {
    if (config.principalServerId || !config.principalHost || typeof probeIdentify !== 'function') return;
    const port = portFromBaseUrl(config.principalBaseUrl, Number(env.PORT || 3399));
    const identity = await probeIdentify(config.principalHost, port, 2000);
    if (identity && identity.isMain && identity.serverId) {
      saveTerminalConfig({
        ...config,
        principalServerId: identity.serverId,
        principalHostname: identity.hostname || config.principalHostname || null,
      });
      logger.log(`[principal] Identificador de la PC principal guardado (${identity.serverId}).`);
    }
  }

  async function relocate(config) {
    if (!config.principalServerId) {
      logger.warn('[principal] La PC principal no responde y esta caja no tiene su identificador guardado: no se busca otra IP (podría ser la principal de otro negocio).');
      return null;
    }
    const port = portFromBaseUrl(config.principalBaseUrl, Number(env.PORT || 3399));
    const found = await findPrincipal({
      port,
      serverId: config.principalServerId,
      hostnames: [config.principalHostname],
    });
    if (!found) {
      logger.warn('[principal] No se encontró la PC principal en la red. Esta caja sigue en modo contingencia.');
      return null;
    }
    const currentHost = String(env.DB_HOST || '').trim();
    if (found.host === currentHost) return null; // misma IP: solo está apagada o reiniciando
    const dbPort = Number(env.DB_PORT || 3306);
    if (!await reachable(found.host, dbPort)) {
      logger.warn(`[principal] PC principal encontrada en ${found.host}, pero su base de datos (puerto ${dbPort}) aún no responde.`);
      return null;
    }
    persistRuntimeEnvValues({ DB_HOST: found.host });
    saveTerminalConfig({
      ...config,
      principalHost: found.host,
      principalBaseUrl: found.baseUrl,
      principalHostname: found.hostname || config.principalHostname || null,
    });
    await reloadDatabase();
    logger.log(`[principal] La PC principal cambió de IP: ${currentHost} → ${found.host}. Base de datos reconectada.`);
    return found;
  }

  async function tick(now = Date.now()) {
    if (busy) return null;
    busy = true;
    try {
      const config = getTerminalConfig();
      if (!config || config.isMain !== false) return null;
      const alive = await dbAlive();
      if (alive.ok) {
        failures = 0;
        await learnIdentity(config).catch(() => {});
        return { ok: true };
      }
      const message = [alive.error?.code, alive.error?.message].filter(Boolean).join(' ');
      if (!DB_NETWORK_ERROR.test(message)) return { ok: false, reason: 'db-error' };
      failures += 1;
      if (failures < 2 || now - lastScanAt < rescanCooldownMs) return { ok: false, reason: 'waiting' };
      lastScanAt = now;
      const found = await relocate(config);
      return { ok: false, relocated: Boolean(found), host: found?.host || null };
    } catch (error) {
      logger.warn('[principal] Vigilante:', error.message);
      return null;
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => { tick(); }, intervalMs);
  if (timer.unref) timer.unref();
  return {
    tick,
    stop() { clearInterval(timer); },
  };
}

module.exports = { startPrincipalWatcher, DB_NETWORK_ERROR };
