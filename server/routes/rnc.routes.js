'use strict';

const express = require('express');
const path = require('path');
const { Worker } = require('worker_threads');

// El paquete `dgii-rnc` descarga y parsea de forma SÍNCRONA un archivo de la
// DGII de ~784k líneas (fs.readFileSync + split/map bloqueantes). Correr eso
// en el proceso principal congelaba TODA la app (incluido el login) durante
// varios segundos, sobre todo cuando el archivo local queda desactualizado
// (basta con que haya pasado la medianoche desde el último arranque) y hay
// que volver a descargarlo. Por eso vive en un worker_thread aparte: lo que
// pase ahí (descarga lenta, parseo pesado) nunca bloquea el servidor HTTP.
let worker = null;
let workerError = null;
let nextRequestId = 1;
const pending = new Map();

function resolveWorkerPath() {
  // Empaquetado en app.asar, worker_threads no puede cargar el script de
  // entrada directamente del asar — necesita la copia sin empaquetar (ver
  // "asarUnpack" en package.json). En desarrollo (sin asar) esto es un no-op.
  const p = path.join(__dirname, 'rnc-worker.js');
  return p.includes('app.asar') && !p.includes('app.asar.unpacked')
    ? p.replace('app.asar', 'app.asar.unpacked')
    : p;
}

function rejectAllPending(err) {
  for (const entry of pending.values()) entry.reject(err);
  pending.clear();
}

function spawnWorker() {
  if (worker) return worker;
  try {
    worker = new Worker(resolveWorkerPath());
    worker.on('message', (msg) => {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error || 'Error en el worker de RNC'));
    });
    worker.on('error', (err) => {
      workerError = err.message;
      worker = null;
      rejectAllPending(err);
    });
    worker.on('exit', (code) => {
      worker = null;
      if (code !== 0) {
        rejectAllPending(new Error(`El worker de RNC terminó inesperadamente (code ${code})`));
      }
    });
  } catch (err) {
    workerError = err.message;
    worker = null;
  }
  return worker;
}

function callWorker(action, payload, timeoutMs) {
  const w = spawnWorker();
  if (!w) return Promise.reject(new Error(workerError || 'Servicio RNC no disponible.'));

  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('El servicio RNC tardó demasiado en responder.'));
    }, timeoutMs);
    pending.set(id, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });
    w.postMessage({ id, action, payload });
  });
}

function createRncRouter() {
  const router = express.Router();

  // Calentar el dataset en segundo plano, en el worker. Igual que antes, se
  // difiere 15s para dar tiempo a que la UI abra primero; una consulta hecha
  // antes de eso simplemente dispara el calentamiento bajo demanda.
  const warmupTimer = setTimeout(() => {
    callWorker('warmup', {}, 120_000).catch(() => {});
  }, 15_000);
  warmupTimer.unref?.();

  // GET /api/rnc/lookup?id=130000000
  router.get('/api/rnc/lookup', async (req, res) => {
    const raw = String(req.query.id || '').replace(/\D/g, '');
    if (!raw || raw.length < 9) {
      return res.status(400).json({ error: 'Proporciona un RNC válido (9-11 dígitos).' });
    }

    // Construir lista de candidatos a buscar:
    // El dataset guarda cédulas con ceros a la izquierda (11 dígitos).
    // Si el usuario escribe solo 10 dígitos (falta el cero inicial), probamos
    // también con el padding. Para RNCs de empresa (9 dígitos) no se hace padding.
    const candidates = [raw.slice(0, 11)];
    if (raw.length === 10) {
      candidates.push('0' + raw); // cédula sin el cero inicial
    }

    try {
      const result = await callWorker('lookup', { raw, candidates }, 60_000);
      return res.json(result);
    } catch (err) {
      return res.status(503).json({ error: err.message });
    }
  });

  // GET /api/rnc/search?q=banco+popular&limit=10
  router.get('/api/rnc/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    if (!q || q.length < 3) {
      return res.status(400).json({ error: 'Escribe al menos 3 caracteres para buscar.' });
    }
    try {
      const results = await callWorker('search', { q, limit }, 60_000);
      return res.json({ results });
    } catch (err) {
      return res.status(503).json({ error: err.message });
    }
  });

  // GET /api/rnc/status — estado del dataset
  router.get('/api/rnc/status', async (_req, res) => {
    try {
      const result = await callWorker('status', {}, 5_000);
      return res.json(result);
    } catch (err) {
      return res.json({ ready: false, error: err.message });
    }
  });

  return router;
}

module.exports = createRncRouter;
