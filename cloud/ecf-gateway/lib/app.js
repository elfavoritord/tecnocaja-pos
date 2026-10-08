'use strict';

const express = require('express');
const helmet = require('helmet');

const { getStore } = require('./store');
const { createGatewayRouter } = require('./router');

// `kms` solo se inyecta en tests; en producción el cliente real de Cloud KMS
// se crea la primera vez que hace falta (ver lib/certificate.js).
function createApp({ store = getStore(), kms } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(createGatewayRouter({ store, kms }));
  return app;
}

module.exports = { createApp };
