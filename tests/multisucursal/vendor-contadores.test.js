'use strict';

// El portal del contador usa COPIAS (tecno-caja-contadores/scripts/vendor-sync.js)
// de las reglas, rutas y pantalla de sucursales del POS. Si alguien cambia el
// original y no corre vendor-sync, el portal aplicaría reglas viejas.
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');
const COPIAS = [
  ['server/multisucursal/central/sucursales.js', 'tecno-caja-contadores/server/multisucursal/sucursales.js'],
  ['server/multisucursal/central/sucursales.routes.js', 'tecno-caja-contadores/server/multisucursal/sucursales.routes.js'],
  ['server/multisucursal/central/sincronizacion-central.js', 'tecno-caja-contadores/server/multisucursal/sincronizacion-central.js'],
  ['js/sucursales-central-ui.js', 'tecno-caja-contadores/public/js/sucursales-central-ui.js'],
  ['js/dgii-autorizacion.js', 'tecno-caja-contadores/public/js/dgii-autorizacion.js'],
  ['js/catalogo-csv.js', 'tecno-caja-contadores/public/js/catalogo-csv.js'],
  ['electron/thermal-printer.js', 'tecno-caja-contadores/electron/thermal-printer.js'],
  ['server/multisucursal/central/sincronizacion-central.js', 'cloud/sync-api/vendor/multisucursal/sincronizacion-central.js'],
  ['server/multisucursal/central/sucursales.js', 'cloud/sync-api/vendor/multisucursal/sucursales.js'],
];

test.each(COPIAS)('%s está copiado igual en el portal del contador', (original, copia) => {
  const a = fs.readFileSync(path.join(RAIZ, original), 'utf8');
  const b = fs.readFileSync(path.join(RAIZ, copia), 'utf8');
  expect(b).toBe(a);
});

test('la pantalla escapa lo que escribe el usuario', () => {
  const { _esc } = require('../../js/sucursales-central-ui.js');
  expect(_esc('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  expect(_esc("O'Neil & Hijos")).toBe('O&#39;Neil &amp; Hijos');
});
