'use strict';

const express = require('express');
const path = require('path');
const { Worker } = require('worker_threads');

// El paquete `dgii-rnc` descarga y parsea de forma SÍNCRONA un archivo de la
// DGII de ~784k líneas (fs.readFileSync + split/map bloqueantes). Antes esto
// se cargaba con `getRncHandler()` llamado directo al iniciar server.js
// ("pre-cargar al iniciar"), lo cual bloqueaba el proceso principal justo
// antes de `server.listen()`. El health-check de main.js (`waitForServer`,
// 20 intentos × 300ms = 6s) se agotaba esperando `/health` y logueaba
// "Admin server no respondió" — aunque el servidor sí terminara de levantar
// un momento después. Mismo bug ya resuelto en el POS principal
// (server/routes/rnc.routes.js): se aísla en un worker_thread aparte para
// que la carga/parseo del dataset nunca bloquee el servidor HTTP.
let worker = null;
let workerError = null;
let nextRequestId = 1;
const pending = new Map();

function resolveWorkerPath() {
  // Por si esta app llega a empaquetarse en app.asar en el futuro:
  // worker_threads no puede cargar el script de entrada directo del asar.
  // Hoy tecno-caja-admin corre sin empaquetar, así que esto es un no-op.
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

function createRncRouter({ requireAuth }) {
  const router = express.Router();

  // Calentar el dataset en segundo plano, en el worker, sin bloquear el
  // arranque del servidor ni el health-check inicial de main.js.
  const warmupTimer = setTimeout(() => {
    callWorker('warmup', {}, 120_000).catch(() => {});
  }, 5_000);
  warmupTimer.unref?.();

  // GET /api/rnc/lookup?id=130000000
  router.get('/lookup', requireAuth, async (req, res) => {
    const raw = String(req.query.id || '').replace(/\D/g, '');
    if (!raw || raw.length < 9) return res.status(400).json({ error: 'RNC inválido.' });

    const candidates = [raw];
    if (raw.length === 10) candidates.push('0' + raw);

    try {
      const result = await callWorker('lookup', { raw, candidates }, 60_000);
      res.json(result);
    } catch (err) {
      res.status(503).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createRncRouter };
