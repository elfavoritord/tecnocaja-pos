'use strict';
// La app de escritorio (Electron) no tiene window.prompt(): el diálogo nunca
// aparece y el botón parece que "no hace nada" (pasó con Meseros/as en Mesas).
// Para pedir datos se usan showPromptModal / showFormModal de js/ui.js.
const fs = require('fs');
const path = require('path');

function archivosJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const ruta = path.join(dir, e.name);
    if (e.isDirectory()) return archivosJs(ruta);
    return e.name.endsWith('.js') ? [ruta] : [];
  });
}

test('el frontend no usa prompt()', () => {
  const raiz = path.join(__dirname, '..');
  const usos = [];
  for (const archivo of [...archivosJs(path.join(raiz, 'js')), path.join(raiz, 'index.html')]) {
    fs.readFileSync(archivo, 'utf8').split(/\r?\n/).forEach((linea, i) => {
      const codigo = linea.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      if (/(^|[^\w.])prompt\s*\(|\bwindow\.prompt\s*\(/.test(codigo)) usos.push(`${path.relative(raiz, archivo)}:${i + 1}: ${linea.trim()}`);
    });
  }
  expect(usos).toEqual([]);
});
