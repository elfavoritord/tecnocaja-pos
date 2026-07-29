'use strict';

/**
 * tests/security/hardcoded-credentials.test.js
 *
 * Verifica que ningún script en el proyecto tenga credenciales de base de datos
 * hardcodeadas (user: 'root', password: '', database: 'novapos' literales).
 *
 * Este test detecta regresiones: si alguien copia un script viejo con creds
 * hardcodeadas, el test falla antes de que llegue a producción.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

const SCAN_DIRS = [
  'scripts',
  'scripts/operational',
];

// Patrones que indican credenciales hardcodeadas peligrosas
const DANGEROUS_PATTERNS = [
  /password:\s*''/,
  /password:\s*""/,
  /user:\s*'root'/,
  /database:\s*'novapos'/,
  /database:\s*"novapos"/,
];

function collectJsFiles(dir) {
  const absDir = path.join(ROOT, dir);
  if (!fs.existsSync(absDir)) return [];
  return fs.readdirSync(absDir)
    .filter(f => f.endsWith('.js'))
    .map(f => path.join(absDir, f));
}

describe('hardcoded-credentials', () => {
  it('ningún script en scripts/ tiene credenciales DB hardcodeadas', () => {
    const files = [
      ...collectJsFiles('scripts'),
      ...collectJsFiles('scripts/operational'),
    ];

    const violations = [];

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines   = content.split('\n');

      lines.forEach((line, i) => {
        for (const pattern of DANGEROUS_PATTERNS) {
          if (pattern.test(line)) {
            violations.push(`${path.relative(ROOT, filePath)}:${i + 1} → ${line.trim()}`);
          }
        }
      });
    }

    if (violations.length > 0) {
      throw new Error(
        `Se encontraron credenciales hardcodeadas en ${violations.length} lugar(es):\n` +
        violations.map(v => `  ${v}`).join('\n') +
        '\n\nUsa variables de entorno: process.env.DB_USER || "root"'
      );
    }
  });

  it('firebase-key.json no está incluido en el build de package.json', () => {
    const pkgPath = path.join(ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const buildFiles = pkg?.build?.files || [];

    expect(buildFiles).not.toContain('firebase-key.json');
    expect(buildFiles).not.toContain('.env');
  });

  it('/debug-firestore no existe en platform.routes.js', () => {
    const routePath = path.join(ROOT, 'server/routes/platform.routes.js');
    const content = fs.readFileSync(routePath, 'utf8');
    expect(content).not.toContain('/debug-firestore');
    expect(content).not.toContain('debug-firestore');
  });
});
