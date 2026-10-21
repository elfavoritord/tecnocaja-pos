'use strict';

// Copia del POS lo que el portal comparte con él. El instalador del portal solo
// empaqueta lo que hay dentro de tecno-caja-contadores/ (electron-builder.yml),
// así que no puede cargar '../js/...'. Así hay UNA sola fuente: el POS.
//  - Plantillas de la factura A4 (js/factura-plantillas.js).
//  - Sucursales centrales: reglas, rutas y pantalla (multisucursal, Fase 3),
//    rangos NCF por sucursal y resumen de ventas (sincronizacion-central.js).
//  - Íconos de línea (js/iconos.js): el portal cambia sus emojis por estos
//    al mostrarse (public/js/sin-emojis.js), igual que el POS.
// Corre solo con npm start, npm run build y el release; las pruebas
// tests/contadores-factura.test.js y tests/multisucursal/vendor-contadores.test.js
// avisan si una copia quedó vieja.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_ROOT = path.resolve(__dirname, '..');

const FILES = [
  ['js/factura-plantillas.js', 'public/js/factura-plantillas.js'],
  ['server/multisucursal/central/sucursales.js', 'server/multisucursal/sucursales.js'],
  ['server/multisucursal/central/sucursales.routes.js', 'server/multisucursal/sucursales.routes.js'],
  ['server/multisucursal/central/sincronizacion-central.js', 'server/multisucursal/sincronizacion-central.js'],
  ['js/sucursales-central-ui.js', 'public/js/sucursales-central-ui.js'],
  ['js/iconos.js', 'public/js/iconos.js'],
];

for (const [from, to] of FILES) {
  const src = path.join(REPO_ROOT, from);
  const dest = path.join(APP_ROOT, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[vendor-sync] ${from} -> tecno-caja-contadores/${to}`);
}
