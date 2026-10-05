'use strict';

/**
 * server/network/internet-monitor.js
 *
 * Única fuente de verdad sobre si HAY INTERNET en este equipo.
 *
 * Tecno Caja trabaja primero en la red local (LAN + MariaDB/SQLite local);
 * Internet solo hace falta para la nube (Firebase), la DGII (e-CF) y otros
 * servicios externos. Las piezas que dependen de Internet consultan este
 * monitor ANTES de intentar una llamada remota, para no hacer esperar al
 * cajero por un timeout cuando ya se sabe que no hay conexión.
 *
 * Cómo decide: resuelve el nombre (DNS) y abre una conexión TCP al puerto 443
 * de varios destinos con timeout corto. Basta uno que responda. El DNS solo no
 * sirve: Windows cachea los nombres y "resuelve" aunque no haya salida.
 *
 * Estados: online === null  → todavía no se ha comprobado (desconocido)
 *          online === true  → hay Internet
 *          online === false → sin Internet (se sabe)
 *
 * Eventos: 'change' (online:boolean), 'online', 'offline'.
 *
 * Para pruebas: TECNO_CAJA_SIMULATE_NO_INTERNET=1 fuerza "sin Internet" sin
 * tocar la red real.
 */

const dns = require('dns').promises;
const net = require('net');
const { EventEmitter } = require('events');

const DEFAULT_TARGETS = [
  { host: 'firestore.googleapis.com', port: 443 },
  { host: 'www.google.com', port: 443 },
  { host: '1.1.1.1', port: 443 },
];

function withTimeout(promise, ms, message) {
  let timer = null;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

function defaultTcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, error });
    };
    socket.setTimeout(timeoutMs, () => done(false, 'timeout'));
    socket.once('connect', () => done(true));
    socket.once('error', (err) => done(false, err.code || err.message));
  });
}

async function defaultResolve(host, timeoutMs) {
  if (net.isIP(host)) return host;
  const result = await withTimeout(dns.lookup(host), timeoutMs, 'dns timeout');
  return result.address;
}

class InternetMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.targets = options.targets || DEFAULT_TARGETS;
    this.timeoutMs = Number(options.timeoutMs || 2500);
    // Con Internet se comprueba cada 20 s; sin Internet, cada 8 s para notar
    // rápido cuando vuelve (y sincronizar lo pendiente).
    this.onlineIntervalMs = Number(options.onlineIntervalMs || 20000);
    this.offlineIntervalMs = Number(options.offlineIntervalMs || 8000);
    this.tcpProbe = options.tcpProbe || defaultTcpProbe;
    this.resolveHost = options.resolveHost || defaultResolve;
    this.now = options.now || (() => new Date());
    this.simulatedOffline = options.simulateOffline !== undefined
      ? Boolean(options.simulateOffline)
      : String(process.env.TECNO_CAJA_SIMULATE_NO_INTERNET || '') === '1';

    this.state = {
      online: null,
      lastCheckAt: null,
      lastChangeAt: null,
      lastError: null,
      checkedTarget: null,
    };
    this._timer = null;
    this._inFlight = null;
    this._started = false;
    this.setMaxListeners(50);
  }

  /** Comprueba ahora (una sola comprobación a la vez). Devuelve true/false. */
  check() {
    if (this._inFlight) return this._inFlight;
    this._inFlight = this._probe()
      .then((result) => {
        this._apply(result);
        return result.online;
      })
      .finally(() => { this._inFlight = null; });
    return this._inFlight;
  }

  async _probe() {
    if (this.simulatedOffline) {
      return { online: false, error: 'simulado (TECNO_CAJA_SIMULATE_NO_INTERNET)', target: null };
    }
    let lastError = null;
    for (const target of this.targets) {
      try {
        const address = await this.resolveHost(target.host, this.timeoutMs);
        const probe = await this.tcpProbe(address, target.port, this.timeoutMs);
        if (probe.ok) return { online: true, error: null, target: `${target.host}:${target.port}` };
        lastError = `${target.host}: ${probe.error || 'sin respuesta'}`;
      } catch (error) {
        lastError = `${target.host}: ${error.code || error.message}`;
      }
    }
    return { online: false, error: lastError, target: null };
  }

  _apply({ online, error, target }) {
    const previous = this.state.online;
    const at = this.now();
    this.state.lastCheckAt = at.toISOString();
    this.state.lastError = online ? null : error;
    this.state.checkedTarget = target;
    if (previous === online) return;
    this.state.online = online;
    this.state.lastChangeAt = at.toISOString();
    this.emit('change', online, previous);
    this.emit(online ? 'online' : 'offline');
  }

  /** Para pruebas manuales/automatizadas: forzar o quitar "sin Internet". */
  setSimulatedOffline(value) {
    this.simulatedOffline = Boolean(value);
    return this.check();
  }

  isOnline() {
    return this.state.online === true;
  }

  /** true solo si ya se comprobó y NO hay Internet (desconocido ≠ sin Internet). */
  isKnownOffline() {
    return this.state.online === false;
  }

  getStatus() {
    return {
      online: this.state.online,
      checked: this.state.lastCheckAt !== null,
      lastCheckAt: this.state.lastCheckAt,
      lastChangeAt: this.state.lastChangeAt,
      lastError: this.state.lastError,
      simulated: this.simulatedOffline,
    };
  }

  start() {
    if (this._started) return;
    this._started = true;
    const loop = async () => {
      try { await this.check(); } catch (_) { /* nunca tumba el proceso */ }
      if (!this._started) return;
      const wait = this.state.online === false ? this.offlineIntervalMs : this.onlineIntervalMs;
      this._timer = setTimeout(loop, wait);
      if (this._timer.unref) this._timer.unref();
    };
    loop();
  }

  stop() {
    this._started = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }
}

let instance = null;

function getInternetMonitor() {
  if (!instance) instance = new InternetMonitor();
  return instance;
}

module.exports = {
  InternetMonitor,
  getInternetMonitor,
  DEFAULT_TARGETS,
};
