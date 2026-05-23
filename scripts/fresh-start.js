/**
 * fresh-start.js
 *
 * Borra todos los datos locales de Tecno Caja (AppData) para arrancar desde cero.
 * Hace un backup de la carpeta antes de borrarla por seguridad.
 *
 * Ejecutar:
 *   node scripts/fresh-start.js
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const appData    = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const tecnocajaDir = path.join(appData, 'Tecno Caja');
const backupDir  = path.join(appData, `Tecno Caja_backup_${Date.now()}`);

console.log('\n🗑️  Tecno Caja — Inicio limpio\n');

if (!fs.existsSync(tecnocajaDir)) {
  console.log('✅ No hay datos previos en AppData. Puedes ejecutar npm run desktop directamente.\n');
  process.exit(0);
}

// Hacer backup primero
console.log(`[1/2] Haciendo backup en:\n      ${backupDir}`);
try {
  fs.cpSync(tecnocajaDir, backupDir, { recursive: true });
  console.log('      ✔ Backup completado');
} catch (e) {
  console.warn('      ⚠ No se pudo hacer backup:', e.message);
}

// Borrar directorio Tecno Caja
console.log(`\n[2/2] Borrando datos de AppData Tecno Caja...`);
try {
  fs.rmSync(tecnocajaDir, { recursive: true, force: true });
  console.log('      ✔ Carpeta eliminada');
} catch (e) {
  console.error('      ✖ Error al borrar:', e.message);
  process.exit(1);
}

console.log('\n✅ Listo. Ahora ejecuta: npm run desktop\n');
console.log(`   (Si necesitas recuperar datos, el backup está en:\n    ${backupDir})\n`);
