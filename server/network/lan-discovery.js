'use strict';

/**
 * server/network/lan-discovery.js
 *
 * Encontrar la PC principal de Tecno Caja dentro de la red local, sin que el
 * cliente tenga que escribir la IP (y volver a encontrarla si el router le
 * cambió la IP por DHCP).
 *
 * Cómo: cada PC principal responde GET /api/network/identify con su
 * identificador de servidor (serverId, aleatorio y fijo por instalación), su
 * nombre de equipo y el nombre del negocio. Una caja:
 *   1. prueba primero el nombre del equipo guardado (http://NOMBRE-PC:3399):
 *      Windows lo resuelve en la LAN aunque cambie la IP;
 *   2. si no, recorre su propia red (/24 de cada tarjeta con IP privada) y se
 *      queda con la principal cuyo serverId coincide con el guardado.
 * Nunca se conecta a la principal de OTRO negocio: sin serverId guardado solo
 * acepta una principal con el mismo nombre de negocio y si es la única.
 *
 * Lo usan server.js (asistente y terminales con base en red) y
 * electron/main.js (cajas "terminal" que cargan la pantalla de la principal).
 */

const http = require('http');
const os = require('os');

const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/;

function getPrivateIpv4Addresses() {
  const addresses = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (PRIVATE_IPV4.test(String(iface.address || ''))) addresses.push(iface.address);
    }
  }
  return addresses;
}

/** Direcciones a probar: el /24 de cada tarjeta con IP privada (sin la propia). */
function getDiscoveryHosts(addresses = getPrivateIpv4Addresses()) {
  const own = new Set(addresses);
  const hosts = new Set();
  for (const address of addresses) {
    const parts = address.split('.');
    if (parts.length !== 4) continue;
    const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
    for (let last = 1; last <= 254; last += 1) {
      const host = `${prefix}.${last}`;
      if (!own.has(host)) hosts.add(host);
    }
  }
  return Array.from(hosts);
}

function buildBaseUrl(host, port) {
  const cleanHost = String(host || '').trim();
  return `http://${cleanHost}:${port}`;
}

/** Pregunta a un equipo si es un servidor Tecno Caja. null si no responde o no lo es. */
function probeIdentify(host, port, timeoutMs = 900) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.get({
      hostname: host,
      port,
      path: '/api/network/identify',
      timeout: timeoutMs,
      headers: { Accept: 'application/json' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) req.destroy();
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return finish(null);
        try {
          const data = JSON.parse(body || '{}');
          if (!data || data.app !== 'Tecno Caja') return finish(null);
          return finish({
            host,
            port,
            baseUrl: buildBaseUrl(host, port),
            localIp: data.localIp || host,
            app: data.app,
            role: data.role || (data.isMain ? 'principal' : 'terminal'),
            isMain: Boolean(data.isMain),
            serverId: String(data.serverId || '').trim() || null,
            hostname: String(data.hostname || '').trim() || null,
            businessName: String(data.businessName || '').trim(),
            branchName: String(data.branchName || '').trim(),
            version: String(data.version || '').trim(),
          });
        } catch (_error) {
          return finish(null);
        }
      });
    });
    req.on('error', () => finish(null));
    req.on('timeout', () => {
      req.destroy();
      finish(null);
    });
  });
}

/** Recorre la red local y devuelve las PCs principales que responden. */
async function scanForPrincipals({
  port,
  hosts = getDiscoveryHosts(),
  concurrency = 32,
  timeoutMs = 800,
  probe = probeIdentify,
} = {}) {
  const queue = [...hosts];
  const found = [];
  const workers = new Array(Math.min(concurrency, queue.length || 1)).fill(null).map(async () => {
    while (queue.length) {
      const host = queue.shift();
      const candidate = await probe(host, port, timeoutMs);
      if (candidate && candidate.isMain) found.push(candidate);
    }
  });
  await Promise.all(workers);
  return found;
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Elige la principal correcta entre las encontradas.
 *  - Con serverId guardado: solo la que tiene ese mismo serverId.
 *  - Sin serverId (cajas vinculadas antes de esta versión): solo si hay UNA
 *    principal con el mismo nombre de negocio.
 */
function pickPrincipal(candidates = [], { serverId = null, businessName = '' } = {}) {
  const mains = candidates.filter((candidate) => candidate && candidate.isMain);
  if (serverId) {
    return mains.find((candidate) => candidate.serverId === serverId) || null;
  }
  const name = normalizeName(businessName);
  if (!name) return null;
  const sameName = mains.filter((candidate) => normalizeName(candidate.businessName) === name);
  return sameName.length === 1 ? sameName[0] : null;
}

/**
 * Busca la principal de ESTE negocio: primero por nombre de equipo, luego
 * recorriendo la red. Devuelve el candidato o null.
 */
async function findPrincipal({
  port,
  serverId = null,
  businessName = '',
  hostnames = [],
  probe = probeIdentify,
  scan = scanForPrincipals,
  timeoutMs = 1500,
} = {}) {
  for (const hostname of hostnames.filter(Boolean)) {
    const candidate = await probe(hostname, port, timeoutMs);
    const picked = candidate ? pickPrincipal([candidate], { serverId, businessName }) : null;
    if (picked) return { ...picked, foundBy: 'hostname' };
  }
  const candidates = await scan({ port, probe });
  const picked = pickPrincipal(candidates, { serverId, businessName });
  return picked ? { ...picked, foundBy: 'scan' } : null;
}

module.exports = {
  getPrivateIpv4Addresses,
  getDiscoveryHosts,
  probeIdentify,
  scanForPrincipals,
  pickPrincipal,
  findPrincipal,
};
