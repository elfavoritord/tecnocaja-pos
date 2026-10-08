'use strict';

const { createApp } = require('./lib/app');

const app = createApp();
const port = Number(process.env.PORT) || 8080;

app.listen(port, () => {
  console.log(`[GATEWAY] Tecno Caja e-CF Gateway escuchando en :${port} (ambiente=${process.env.DGII_ENVIRONMENT || 'TEST'})`);
  const defaultRnc = String(process.env.GATEWAY_DEFAULT_RNC || '').trim();
  if (defaultRnc) {
    console.log(`[GATEWAY] Modo multiempresa — empresa por defecto RNC ${defaultRnc}; las demás se registran en /admin/tenants.`);
  } else {
    console.warn('[GATEWAY] GATEWAY_DEFAULT_RNC vacío — modo una sola empresa: acepta cualquier RNC y firma todo con CERT_PATH.');
  }
});
