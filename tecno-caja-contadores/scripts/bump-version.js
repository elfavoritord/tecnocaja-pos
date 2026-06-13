'use strict';
/**
 * bump-version.js — Incrementa la versión de tecno-caja-contadores/package.json
 * Uso: node bump-version.js [patch|minor|major]
 * Salida stdout: "oldVer|newVer"
 */
const fs   = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg     = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const bump    = (process.argv[2] || 'patch').toLowerCase();

const [major, minor, patch] = pkg.version.split('.').map(Number);
let newVersion;
if (bump === 'major') newVersion = `${major + 1}.0.0`;
else if (bump === 'minor') newVersion = `${major}.${minor + 1}.0`;
else newVersion = `${major}.${minor}.${patch + 1}`;

const oldVersion = pkg.version;
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
process.stdout.write(`${oldVersion}|${newVersion}`);
