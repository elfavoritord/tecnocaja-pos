'use strict';

// Copia del POS la lógica que la tienda comparte (contrato de datos, cálculo
// del pedido y motor de promociones) hacia vendor/. Cloud Run construye la
// imagen solo con lo que hay dentro de cloud/tienda-online/, así que no puede
// requerir '../../server/...'. Así hay UNA sola fuente: el POS.
// Correr antes de cada deploy (npm test y npm run dev ya lo hacen).

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVICE_ROOT = path.resolve(__dirname, '..');

const FILES = [
  ['server/tienda-online/contrato.js', 'vendor/tienda-online/contrato.js'],
  ['server/tienda-online/calculo-pedido.js', 'vendor/tienda-online/calculo-pedido.js'],
  ['server/services/promotion-engine.js', 'vendor/services/promotion-engine.js'],
];

for (const [from, to] of FILES) {
  const src = path.join(REPO_ROOT, from);
  const dest = path.join(SERVICE_ROOT, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[vendor-sync] ${from} -> cloud/tienda-online/${to}`);
}
