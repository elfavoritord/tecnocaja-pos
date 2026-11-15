'use strict';

// Arranca el server.js de la copia del programa para UNA empresa del servidor
// de certificación (como electron/main.js). Al apagarla desde el panel guarda
// la base SQLite antes de salir: en Windows matar el proceso pierde lo último.
const path = require('path');

const APP = process.env.E2E_APP;
const app = require(path.join(APP, 'server.js'));
const db = require(path.join(APP, 'db.js'));

let saliendo = false;
async function salir(codigo = 0) {
  if (saliendo) return;
  saliendo = true;
  try { await db.flushPendingSave(); } catch (_) { /* nada que guardar */ }
  process.exit(codigo);
}

app.startHttpServer(Number(process.env.PORT), '127.0.0.1')
  .then(() => {
    console.log('[certificacion] escuchando en', process.env.PORT);
    if (process.send) process.send({ tipo: 'listo' });
  })
  .catch((err) => { console.error('[certificacion] no arrancó:', err); process.exit(1); });

process.on('message', (m) => { if (m && m.tipo === 'apagar') salir(0); });
// Si el panel se cierra de golpe, el canal se corta: guardar y salir.
process.on('disconnect', () => salir(0));
