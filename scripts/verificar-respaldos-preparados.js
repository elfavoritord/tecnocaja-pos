'use strict';
// Comprobaciones de código: nunca compila, publica ni instala una actualización.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');
const ROOT = path.resolve(__dirname, '..');
const critical = ['server/services/backup-builder.js', 'server/services/backup-format.js', 'server/services/backup-policy.js',
  'server/services/backup-upload-state.js', 'server/services/backup-health.js', 'server/services/backup-restore-integral.js',
  'server/services/backup-components.js', 'server/services/auto-recovery.js', 'server/routes/respaldos.routes.js', 'js/respaldos.js', 'js/mesas.js', 'db.js', 'server.js'];
function run(args) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) throw new Error('Falló la comprobación: ' + args.slice(0, 2).join(' '));
}
for (const file of critical) { if (!fs.existsSync(path.join(ROOT, file))) throw new Error('Falta ' + file); run(['--check', file]); }
const config = path.join(ROOT, 'config', 'app.env');
if (fs.existsSync(config)) {
  const env = dotenv.parse(fs.readFileSync(config));
  for (const key of ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'B2_MASTER_KEY_ID', 'B2_MASTER_APPLICATION_KEY', 'TECNO_CAJA_LICENSE_UID']) {
    if (String(env[key] || '').trim()) throw new Error(`La configuración común que se empaqueta contiene ${key}. Debe pertenecer a cada instalación.`);
  }
}
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json')));
if (!pkg.build.files.includes('server/**/*') || !pkg.build.files.includes('js/**/*')) throw new Error('El empaquetado no incluye los módulos corregidos.');
if (!process.argv.includes('--solo-sintaxis')) run([require.resolve('jest/bin/jest'), '--runInBand', '--silent',
  'tests/routes/respaldo-diario.test.js', 'tests/routes/respaldos.routes.test.js', 'tests/routes/respaldo-nube-dueno.test.js',
  'tests/services/backup-policy.test.js', 'tests/services/backup-health.test.js', 'tests/services/backup-integral.test.js',
  'tests/services/backup-core-multisucursal.test.js', 'tests/services/backup-core-restore-columnas.test.js',
  'tests/services/backup-cloud-verification.test.js', 'tests/services/db-maintenance.test.js', 'tests/services/factory-reset.service.test.js',
  'tests/services/offline-readiness.test.js', 'tests/services/rnc-offline.test.js', 'tests/security/backup-crypto.test.js']);
console.log('Correcciones verificadas para la próxima versión. No se compiló, publicó ni instaló una actualización.');
