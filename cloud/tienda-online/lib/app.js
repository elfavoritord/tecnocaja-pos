'use strict';

const express = require('express');
const helmet = require('helmet');
const { createRouter } = require('./router');

/**
 * @param {object} [deps]  { db, FieldValue } — en pruebas, un Firestore en memoria.
 */
function createApp(deps = {}) {
  const backend = deps.db ? deps : require('./store').getBackend();
  const app = express();
  app.disable('x-powered-by');
  // Un solo salto (el balanceador de Cloud Run): la IP del cliente no se puede
  // falsificar mandando otro X-Forwarded-For.
  app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'img-src': ["'self'", 'https:', 'data:'],
        'style-src': ["'self'", "'unsafe-inline'"],
        'script-src': ["'self'"],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(createRouter({ db: backend.db, FieldValue: backend.FieldValue, now: deps.now, limits: deps.limits }));
  app.use((req, res) => res.status(404).set('Cache-Control', 'no-store').json({ error: 'No encontrado.' }));
  return app;
}

module.exports = { createApp };
