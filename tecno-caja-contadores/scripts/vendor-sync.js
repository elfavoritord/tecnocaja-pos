'use strict';

// Copia del POS las plantillas de la factura A4 (js/factura-plantillas.js)
// hacia public/js/. El instalador del portal solo empaqueta lo que hay dentro
// de tecno-caja-contadores/ (electron-builder.yml), así que no puede cargar
// '../js/...'. Así hay UNA sola fuente: el POS.
// Corre solo con npm start, npm run build y el release; la prueba
// tests/contadores-factura.test.js avisa si la copia quedó vieja.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_ROOT = path.resolve(__dirname, '..');

const FILES = [
  ['js/factura-plantillas.js', 'public/js/factura-plantillas.js'],
];

for (const [from, to] of FILES) {
  const src = path.join(REPO_ROOT, from);
  const dest = path.join(APP_ROOT, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[vendor-sync] ${from} -> tecno-caja-contadores/${to}`);
}
