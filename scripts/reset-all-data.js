/**
 * reset-all-data.js
 *
 * Borra TODOS los datos del negocio de la BD SQLite local y resetea
 * la app al estado de primer arranque (wizard de configuración).
 *
 * 1. Cierra la app (npm run desktop)
 * 2. Ejecuta:  node scripts/reset-all-data.js
 * 3. Vuelve a abrir: npm run desktop
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// ─── Localizar el archivo de base de datos ────────────────────────────────────
const appDataRoaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

// Electron en dev usa el nombre del package.json como carpeta de userData
const packageJson  = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const appName      = packageJson.productName || packageJson.name || 'pos-system';

const candidates = [
  path.join(appDataRoaming, 'Tecno Caja',    'data', 'tecnocaja.db'),
  path.join(appDataRoaming, appName,      'data', 'tecnocaja.db'),
  path.join(appDataRoaming, 'pos-system', 'data', 'tecnocaja.db'),
  path.join(appDataRoaming, 'Electron',   'data', 'tecnocaja.db'),
  // Fallback en el proyecto
  path.join(__dirname, '..', 'data',         'tecnocaja.db'),
  path.join(__dirname, '..', 'runtime-data', 'data', 'tecnocaja.db'),
];

const dbPath = candidates.find(p => fs.existsSync(p));

if (!dbPath) {
  console.log('\n⚠  No se encontró ninguna base de datos SQLite en:');
  candidates.forEach(p => console.log('   -', p));
  console.log('\nSi la app aún está abierta, ciérrala primero y vuelve a intentarlo.\n');
  process.exit(1);
}

console.log(`\n🗑️  Tecno Caja — Reset total de datos\n`);
console.log(`   Base de datos: ${dbPath}\n`);

// Hacer backup antes de borrar
const backupPath = dbPath + '.backup_' + Date.now();
fs.copyFileSync(dbPath, backupPath);
console.log(`[1/2] Backup guardado en:\n      ${backupPath}\n`);

// Borrar el archivo — la app lo recreará desde schema.sql al arrancar
console.log(`[2/2] Eliminando base de datos...`);
fs.unlinkSync(dbPath);
console.log(`      ✔ Eliminada\n`);

console.log(`✅ Listo. Ahora ejecuta: npm run desktop`);
console.log(`   La app arrancará con el wizard de configuración inicial.\n`);
console.log(`   (Backup disponible en: ${backupPath})\n`);
