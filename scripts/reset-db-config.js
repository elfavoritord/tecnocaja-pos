/**
 * reset-db-config.js
 *
 * Restablece la configuración de base de datos al modo local embebido.
 * Úsalo cuando el app muestra "connect ENETUNREACH <IP remota>:3306" al arrancar.
 *
 * Ejecutar desde la raíz del proyecto:
 *   node scripts/reset-db-config.js
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// ─── Rutas ────────────────────────────────────────────────────────────────────

const appRoot      = path.resolve(__dirname, '..');
const projectEnv   = path.join(appRoot, '.env');
const overrideEnv  = path.join(appRoot, 'app-env-override.env');

// AppData del usuario (donde Electron guarda config/app.env en producción)
const appDataPath  = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const userDataPath = path.join(appDataPath, 'Tecno Caja');
const userEnvFile  = path.join(userDataPath, 'config', 'app.env');

// terminal-config.json del proyecto
const terminalConfigPath = path.join(appRoot, 'config', 'terminal-config.json');

// ─── Valores que se van a restablecer ─────────────────────────────────────────

const DB_RESET = {
  DB_CLIENT:  'sqlite',   // usa SQLite local por defecto; cámbialo a 'mysql' si tienes MariaDB embebido
  DB_HOST:    '127.0.0.1',
  DB_PORT:    '3306',
  DB_USER:    'root',
  DB_PASSWORD: '',
  DB_NAME:    'tecnocaja',
  POS_ALLOW_LAN:          'false',
  POS_BIND_HOST:          '127.0.0.1',
  TECNO_CAJA_MYSQL_ALLOW_LAN: 'false',
  TECNO_CAJA_MYSQL_BIND_HOST: '127.0.0.1',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function patchEnvFile(filePath, overrides) {
  if (!fs.existsSync(filePath)) {
    console.log(`  (no encontrado, omitiendo) ${filePath}`);
    return;
  }

  let content = fs.readFileSync(filePath, 'utf8');
  let changed  = false;

  for (const [key, value] of Object.entries(overrides)) {
    // Si la key ya existe en el archivo → reemplazar su valor
    const existing = new RegExp(`^(${key})=.*$`, 'm');
    if (existing.test(content)) {
      const newLine = `${key}=${value}`;
      const before  = content;
      content = content.replace(existing, newLine);
      if (content !== before) {
        console.log(`  ✔ ${key} → ${value || '(vacío)'}`);
        changed = true;
      }
    }
    // Si no existe, no agregarla (no queremos contaminar archivos que no la necesitan)
  }

  if (changed) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`  Guardado: ${filePath}`);
  } else {
    console.log(`  Sin cambios: ${filePath}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('\n🔧 Tecno Caja — Restableciendo configuración de base de datos\n');

console.log(`[1/4] Parcheando .env del proyecto...`);
patchEnvFile(projectEnv, DB_RESET);

console.log(`\n[2/4] Parcheando app-env-override.env...`);
patchEnvFile(overrideEnv, DB_RESET);

console.log(`\n[3/4] Parcheando config/app.env de AppData (${userEnvFile})...`);
patchEnvFile(userEnvFile, DB_RESET);

console.log(`\n[4/4] Limpiando terminal-config.json de vinculación LAN...`);
if (fs.existsSync(terminalConfigPath)) {
  try {
    const tc = JSON.parse(fs.readFileSync(terminalConfigPath, 'utf8'));
    if (tc.principalHost || tc.setupMode === 'multicaja') {
      // Limpiar campos LAN pero conservar la config de sucursal/caja
      delete tc.principalHost;
      delete tc.principalBaseUrl;
      tc.setupMode = 'monocaja';
      tc.isMain    = true;
      fs.writeFileSync(terminalConfigPath, JSON.stringify(tc, null, 2), 'utf8');
      console.log('  ✔ terminal-config.json limpiado (principalHost eliminado, modo → monocaja)');
    } else {
      console.log('  Sin cambios: terminal-config.json ya está en modo local');
    }
  } catch (e) {
    console.warn('  ⚠ No se pudo parsear terminal-config.json:', e.message);
  }
} else {
  console.log('  (no existe terminal-config.json, omitiendo)');
}

console.log('\n✅ Listo. Ahora puedes volver a ejecutar: npm run desktop\n');
