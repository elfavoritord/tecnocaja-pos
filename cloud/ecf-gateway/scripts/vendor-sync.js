'use strict';

// Copia la lógica de firma existente (modules/ecf/signature + modules/ecf/utils)
// hacia vendor/ antes de cada deploy. Cloud Run construye la imagen solo con lo
// que hay dentro de cloud/ecf-gateway/, así que no puede requerir '../../modules/ecf/...'
// directamente — este script evita duplicar el código a mano y mantiene el
// vendor siempre sincronizado con la fuente real.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const GATEWAY_ROOT = path.resolve(__dirname, '..');

const FILES = [
  ['modules/ecf/signature/signature.service.js', 'vendor/modules/ecf/signature/signature.service.js'],
  ['modules/ecf/utils/xml.util.js', 'vendor/modules/ecf/utils/xml.util.js'],
];

for (const [from, to] of FILES) {
  const src = path.join(REPO_ROOT, from);
  const dest = path.join(GATEWAY_ROOT, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[vendor-sync] ${from} -> cloud/ecf-gateway/${to}`);
}
