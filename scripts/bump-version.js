/**
 * scripts/bump-version.js
 * Incrementa la version en package.json y update-manifest.json
 * Uso: node scripts/bump-version.js [patch|minor|major]
 * Output: "1.1.0|1.1.1" (oldVersion|newVersion)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const bump = (process.argv[2] || 'patch').trim().toLowerCase();
const root = path.join(__dirname, '..');

// ── Calcular nueva version ──────────────────────────────────────
// Leer eliminando BOM si existe (evita "Unexpected token" en JSON.parse)
function readJson(filePath) {
  let raw = fs.readFileSync(filePath, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  return JSON.parse(raw);
}

const pkgPath = path.join(root, 'package.json');
const pkg     = readJson(pkgPath);
const oldVer  = pkg.version;
let [maj, min, pat] = oldVer.split('.').map(Number);

switch (bump) {
  case 'major': maj++; min = 0; pat = 0; break;
  case 'minor': min++; pat = 0;          break;
  default:      pat++;                   break;  // patch
}

const newVer = `${maj}.${min}.${pat}`;

// ── Actualizar package.json ─────────────────────────────────────
pkg.version = newVer;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

// ── Actualizar update-manifest.json ────────────────────────────
const manifestPath = path.join(root, 'update-manifest.json');
if (fs.existsSync(manifestPath)) {
  const manifest = readJson(manifestPath);
  manifest.version       = newVer;
  manifest.stableVersion = newVer;
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = d.getFullYear();
  manifest.date = `${dd}/${mm}/${yy}`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

// ── Output para PowerShell ──────────────────────────────────────
process.stdout.write(`${oldVer}|${newVer}`);
