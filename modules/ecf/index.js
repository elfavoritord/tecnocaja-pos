'use strict';

const {
  createDisabledLegacyApiRouter,
  createEcfRouter,
} = require('./controllers/router');
const { createDgiiPublicRouter } = require('../../server/routes/dgii-public.routes');

function createEcfModule(deps) {
  const { router, service } = createEcfRouter(deps);
  return {
    apiRouter: router,
    legacyApiRouter: createDisabledLegacyApiRouter(),
    publicDgiiRouter: createDgiiPublicRouter(),
    service,
    ensureSchema: () => service.ensureReady(),
  };
}

module.exports = {
  createEcfModule,
};
