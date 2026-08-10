'use strict';

const express = require('express');
const helmet = require('helmet');

const { getStore } = require('./store');
const { createGatewayRouter } = require('./router');

function createApp({ store = getStore() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(createGatewayRouter({ store }));
  return app;
}

module.exports = { createApp };
