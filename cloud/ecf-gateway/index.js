'use strict';

const { createApp } = require('./lib/app');

const app = createApp();
const port = Number(process.env.PORT) || 8080;

app.listen(port, () => {
  console.log(`[GATEWAY] Tecno Caja e-CF Gateway escuchando en :${port} (ambiente=${process.env.DGII_ENVIRONMENT || 'TEST'})`);
});
