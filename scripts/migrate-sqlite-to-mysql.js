#!/usr/bin/env node
/**
 * migrate-sqlite-to-mysql.js — CLI de la migración SQLite → MySQL.
 *
 * La lógica vive en scripts/lib/sqlite-to-mysql-migrator.js (compartida con la
 * migración automática que corre electron/main.js al activar multicaja en una
 * instalación que ya tenía datos). Este archivo sólo parsea args, carga el
 * entorno, imprime con colores y decide el código de salida.
 *
 * DEBE correrse en la MISMA PC donde vive el .db real — el archivo está cifrado
 * en reposo con una llave atada al hardware.
 *
 * Uso:
 *   node scripts/migrate-sqlite-to-mysql.js [--dry-run] [--sqlite=/ruta/custom.db]
 *
 * Opciones:
 *   --dry-run        Solo muestra cuántos registros migraría, no inserta nada.
 *   --sqlite=PATH    Ruta explícita al archivo .db de SQLite.
 *   --app-env=PATH   Ruta explícita al app.env (config cifrado/credenciales).
 *   --force-identity Fuerza businesses/config id=1 con INSERT ... ON DUPLICATE
 *                    KEY UPDATE (INSERT IGNORE normal no pisa la fila "de
 *                    fábrica" sembrada por db/schema.sql).
 *   --help           Muestra este mensaje.
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

// -- Args -------------------------------------------------------------------------
const args           = process.argv.slice(2);
const DRY_RUN        = args.includes('--dry-run');
const HELP           = args.includes('--help');
const FORCE_IDENTITY = args.includes('--force-identity');
const sqliteArg      = args.find((a) => a.startsWith('--sqlite='));
const CUSTOM_SQLITE  = sqliteArg ? sqliteArg.split('=')[1] : null;
const appEnvArg      = args.find((a) => a.startsWith('--app-env='));
const CUSTOM_APP_ENV = appEnvArg ? appEnvArg.split('=')[1] : null;

if (HELP) {
  console.log(`
Tecno Caja -- Migración SQLite -> MySQL
=====================================
Uso: node scripts/migrate-sqlite-to-mysql.js [opciones]

Opciones:
  --dry-run        Solo muestra cuántos registros migraría (no inserta).
  --sqlite=PATH    Ruta explícita al archivo .db de SQLite.
  --app-env=PATH   Ruta explícita al app.env (config cifrado/credenciales).
  --force-identity Fuerza businesses/config id=1 (upsert) para que el negocio
                   real (RNC, nombre, business_structure_mode) pise la fila de
                   fábrica.
  --help           Muestra este mensaje.

Variables de entorno requeridas (DB_HOST, DB_PORT, DB_USER, DB_PASSWORD,
DB_NAME, y TECNO_CAJA_DB_KEY_SALT/TECNO_CAJA_LICENSE_STORAGE_SECRET para
descifrar) se buscan en, en este orden: --app-env explícito, .env del
proyecto (dev), y luego el app.env real de esta PC en AppData.
`);
  process.exit(0);
}

// -- Cargar variables de entorno ------------------------------------------------
// Orden de prioridad (el primero que exista gana, override:false no pisa lo ya
// cargado): --app-env explícito > .env del proyecto (dev) > app.env real de esta
// PC en AppData (con o sin el rebrand a "Tecno Caja" aplicado).
const dotenv = require('dotenv');
const envCandidates = [
  CUSTOM_APP_ENV,
  path.join(__dirname, '..', '.env'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Tecno Caja', 'config', 'app.env'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'pos-system', 'config', 'app.env'),
].filter(Boolean);

for (const candidate of envCandidates) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate });
  }
}

const { runMigration } = require('./lib/sqlite-to-mysql-migrator');

// -- Logger con colores --------------------------------------------------------
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
const log = {
  info:  (m) => console.log(C.cyan + 'i' + C.reset + '  ' + m),
  ok:    (m) => console.log(C.green + 'v' + C.reset + '  ' + m),
  warn:  (m) => console.log(C.yellow + '!' + C.reset + '  ' + m),
  error: (m) => console.log(C.red + 'x' + C.reset + '  ' + m),
};

async function main() {
  console.log('\n' + C.bold + C.cyan + 'Tecno Caja -- Migración SQLite -> MySQL' + C.reset);
  console.log(C.gray + '-'.repeat(50) + C.reset);
  if (DRY_RUN) log.warn('MODO DRY-RUN: no se escribirá nada en MySQL.\n');

  let result;
  try {
    result = await runMigration({
      sqlitePath: CUSTOM_SQLITE,
      forceIdentity: FORCE_IDENTITY,
      dryRun: DRY_RUN,
      log,
      onProgress: (p) => {
        if (p.phase === 'table' && p.table) {
          process.stdout.write('  ' + C.gray + '->' + C.reset + ' ' + String(p.table).padEnd(35) + '\r');
        }
      },
    });
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  const { summary } = result;
  console.log('\n' + C.bold + C.cyan + '== Resumen ==' + C.reset);
  if (DRY_RUN) {
    console.log('  Registros a migrar: ' + C.bold + summary.totalSrc + C.reset);
  } else {
    console.log('  Tablas migradas   : ' + C.green + summary.ok + C.reset);
    console.log('  Registros creados : ' + C.bold + C.green + summary.totalInserted + C.reset);
  }
  console.log('  Tablas vacías     : ' + summary.empty);
  console.log('  Tablas omitidas   : ' + summary.skipped);

  if (summary.errors.length) {
    console.log('  ' + C.red + 'Tablas con error  : ' + summary.errors.length + C.reset);
    summary.errors.forEach((r) => log.error('    ' + r.table + ': ' + r.reason));
  }
  if (summary.missing.length) {
    console.log('  ' + C.red + 'Tablas SIN destino: ' + summary.missing.length + C.reset);
    summary.missing.forEach((r) => log.error('    ' + r.table + ': ' + r.reason));
    log.warn(
      '\nHay tablas con datos que no existen en la MySQL destino. Abre Tecno Caja\n' +
      'una vez conectado a la MySQL nueva (deja que llegue al login o a la pantalla\n' +
      'de configuración inicial, sin completarla) para que el POS cree esas tablas,\n' +
      'y vuelve a correr la migración.'
    );
  }

  if (result.incomplete) {
    log.warn('\nMigración incompleta. Revisa los detalles arriba.');
    process.exit(2);
  }
  log.ok(DRY_RUN
    ? '\nDry-run completado. Ejecuta sin --dry-run para migrar.'
    : '\nMigración completada exitosamente. Los datos están en MySQL!');
}

main().catch((err) => {
  console.log('\x1b[31mx\x1b[0m  Error fatal: ' + err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
