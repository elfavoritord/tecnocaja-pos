// Arranca server.js del sandbox como lo hace electron/main.js (startHttpServer).
const path = require('path');
const app = require(path.join(process.env.E2E_APP, 'server.js'));
app.startHttpServer(Number(process.env.PORT), '127.0.0.1')
  .then(() => console.log('[launcher] escuchando en', process.env.PORT))
  .catch((err) => { console.error('[launcher] no arrancó:', err); process.exit(1); });
