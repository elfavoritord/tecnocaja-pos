'use strict';

const {
  createDisabledLegacyApiRouter,
  createDisabledLegacyPublicRouter,
  createEcfRouter,
} = require('./controllers/router');

function createEcfModule(deps) {
  const { router, service } = createEcfRouter(deps);
  return {
    apiRouter: router,
    legacyApiRouter: createDisabledLegacyApiRouter(),
    legacyPublicRouter: createDisabledLegacyPublicRouter(),
    service,
    ensureSchema: () => service.ensureReady(),
  };
}

module.exports = {
  createEcfModule,
};
