'use strict';

// Worker thread que aísla la descarga y el parseo del dataset de la DGII
// (~784k líneas). El paquete `dgii-rnc` hace fs.readFileSync + split/map
// síncronos y bloqueantes sobre todo el archivo (ver comentario histórico en
// rnc.routes.js). Corriendo eso aquí, en un hilo aparte, el proceso
// principal de Electron/Express nunca se congela — el login y el resto de
// la app siguen respondiendo aunque este hilo esté ocupado descargando o
// parseando.

const { parentPort } = require('worker_threads');

let handler = null;
let ready = false;
let lastError = null;
let warmupPromise = null;
let dailyTimerSet = false;

function getHandler() {
  if (handler) return handler;
  try {
    const mod = require('dgii-rnc');
    handler = new mod.RNCHandler();
  } catch (err) {
    lastError = 'Paquete dgii-rnc no disponible: ' + err.message;
  }
  return handler;
}

function scheduleDailyCheck() {
  if (dailyTimerSet) return;
  dailyTimerSet = true;
  const timer = setInterval(() => {
    warmup().catch(() => {});
  }, 24 * 60 * 60 * 1000);
  timer.unref?.();
}

function warmup() {
  if (warmupPromise) return warmupPromise;
  const h = getHandler();
  if (!h) return Promise.resolve();
  warmupPromise = h
    .checkFile()
    .then(() => {
      ready = true;
      lastError = null;
      scheduleDailyCheck();
    })
    .catch((err) => {
      lastError = err.message;
    })
    .finally(() => {
      warmupPromise = null;
    });
  return warmupPromise;
}

function findById(h, candidates) {
  for (const id of candidates) {
    const record = h.df.find((r) => r.ID === id);
    if (record) return record;
  }
  return null;
}

function toLookupResult(record, raw) {
  if (!record) return { found: false, rnc: raw };
  return {
    found: true,
    rnc: record.ID || raw,
    nombre: record.NOMBRE || '',
    nombreComercial: record.NOMBRE_COMERCIAL || record.NOMBRE || '',
    estado: record.ESTADO || '',
    tipo: (record.ID || '').length === 11 ? 'Persona Física' : 'Persona Jurídica',
    categoria: record.CATEGORIA || '',
    regimen: record.REGIMEN_PAGO || '',
  };
}

async function handleMessage({ id, action, payload }) {
  try {
    const h = getHandler();
    if (!h) {
      parentPort.postMessage({ id, ok: false, error: lastError || 'Servicio RNC no disponible.' });
      return;
    }

    if (action === 'status') {
      parentPort.postMessage({ id, ok: true, result: { ready, error: lastError } });
      return;
    }

    if (action === 'warmup') {
      await warmup();
      parentPort.postMessage({ id, ok: true, result: { ready, error: lastError } });
      return;
    }

    if (action === 'lookup') {
      if (!ready) await warmup();
      if (!ready) {
        parentPort.postMessage({ id, ok: false, error: lastError || 'Servicio RNC no disponible.' });
        return;
      }
      const record = findById(h, payload.candidates);
      parentPort.postMessage({ id, ok: true, result: toLookupResult(record, payload.raw) });
      return;
    }

    if (action === 'search') {
      if (!ready) await warmup();
      if (!ready) {
        parentPort.postMessage({ id, ok: false, error: lastError || 'Servicio RNC no disponible.' });
        return;
      }
      const qUpper = payload.q.toUpperCase();
      const rows = [];
      for (const r of h.df) {
        if (r.NOMBRE.includes(qUpper) || (r.NOMBRE_COMERCIAL && r.NOMBRE_COMERCIAL.includes(qUpper))) {
          rows.push(r);
          if (rows.length >= payload.limit) break;
        }
      }
      parentPort.postMessage({
        id,
        ok: true,
        result: rows.map((r) => ({
          rnc: r.ID || '',
          nombre: r.NOMBRE || '',
          nombreComercial: r.NOMBRE_COMERCIAL || r.NOMBRE || '',
          estado: r.ESTADO || '',
          tipo: (r.ID || '').length === 11 ? 'Persona Física' : 'Persona Jurídica',
          categoria: r.CATEGORIA || '',
        })),
      });
      return;
    }

    parentPort.postMessage({ id, ok: false, error: 'Acción desconocida: ' + action });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.message });
  }
}

parentPort.on('message', (msg) => {
  handleMessage(msg);
});
