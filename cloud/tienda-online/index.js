'use strict';

const { createApp } = require('./lib/app');

const app = createApp();
const port = Number(process.env.PORT) || 8080;

app.listen(port, () => {
  console.log(`[TIENDA] Tienda online de Tecno Caja escuchando en :${port}`);
});
