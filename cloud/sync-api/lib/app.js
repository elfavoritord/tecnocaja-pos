'use strict';

const express = require('express');
const helmet = require('helmet');
const { createRouter } = require('./router');
const { createRespaldosRouter } = require('./respaldos');

/**
 * @param {object} [deps]  { db, now, limites, verificarIdToken, almacen, secretoRespaldos } —
 *   en pruebas, el emulador de Firestore, un verificador de cuentas falso y un almacén en memoria.
 */
function createApp(deps = {}) {
  const backend = deps.db ? deps : require('./store').getBackend();
  const app = express();
  app.disable('x-powered-by');
  // Un solo salto (el balanceador de Cloud Run): la IP del cliente, que usa el
  // límite de intentos de activación, no se puede falsificar con otro X-Forwarded-For.
  app.set('trust proxy', 1);
  // Solo API (el POS llama desde Node, no desde un navegador): sin CORS.
  app.use(helmet());
  app.use(createRouter({
    db: backend.db, now: deps.now, limites: deps.limites, verificarIdToken: backend.verificarIdToken,
  }));
  // Respaldos en la nube sin llaves en las PC (lib/respaldos.js).
  app.use(createRespaldosRouter({
    db: backend.db, now: deps.now, limites: deps.limites, verificarIdToken: backend.verificarIdToken,
    almacen: 'almacen' in deps ? deps.almacen : require('./almacen-b2').crearAlmacenB2(),
    secreto: 'secretoRespaldos' in deps ? deps.secretoRespaldos : (process.env.RESPALDOS_SECRETO || ''),
  }));
  app.use((_req, res) => res.status(404).set('Cache-Control', 'no-store').json({ ok: false, error: 'No encontrado.' }));
  return app;
}

module.exports = { createApp };
