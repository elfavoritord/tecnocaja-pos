'use strict';

// Límite de peticiones en memoria por instancia de Cloud Run (ventana fija),
// igual que cloud/tienda-online. Frena que alguien pruebe códigos de
// activación a lo loco: con 31^8 combinaciones y 10 intentos cada 15 minutos
// por IP, adivinar uno no es viable.

function createRateLimiter({ windowMs, max, now = Date.now }) {
  const hits = new Map();
  let lastSweep = now();
  return function allow(key) {
    const t = now();
    if (t - lastSweep > windowMs) {
      for (const [k, v] of hits) if (t - v.start > windowMs) hits.delete(k);
      lastSweep = t;
    }
    const entry = hits.get(key);
    if (!entry || t - entry.start > windowMs) {
      hits.set(key, { start: t, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= max;
  };
}

module.exports = { createRateLimiter };
