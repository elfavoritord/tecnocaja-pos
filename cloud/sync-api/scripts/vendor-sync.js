'use strict';

// Copia del POS las reglas centrales de sucursales y equipos hacia vendor/.
// Cloud Run construye la imagen solo con lo que hay dentro de cloud/sync-api/,
// así que no puede requerir '../../server/...'. Así hay UNA sola fuente: el
// POS (las mismas reglas que usan el panel de Emilio y el portal del contador).
// Correr antes de cada deploy (npm test y npm run dev ya lo hacen).

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVICE_ROOT = path.resolve(__dirname, '..');

const FILES = [
  ['server/multisucursal/central/sucursales.js', 'vendor/multisucursal/sucursales.js'],
  ['server/multisucursal/central/sincronizacion-central.js', 'vendor/multisucursal/sincronizacion-central.js'],
];

for (const [from, to] of FILES) {
  const src = path.join(REPO_ROOT, from);
  const dest = path.join(SERVICE_ROOT, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[vendor-sync] ${from} -> cloud/sync-api/${to}`);
}
