'use strict';

/**
 * Términos y condiciones (js/terminos.js): el Markdown de
 * legal/terminos-y-condiciones.md se muestra como HTML en la ventana que se
 * abre desde el inicio de sesión.
 */

const fs = require('fs');
const path = require('path');
const { markdownAHtml } = require('../js/terminos.js');

const DOCUMENTO = fs.readFileSync(path.join(__dirname, '..', 'legal', 'terminos-y-condiciones.md'), 'utf8');

describe('markdownAHtml', () => {
  test('títulos, negritas, listas, tablas y separadores', () => {
    const html = markdownAHtml([
      '# Título',
      '## Subtítulo',
      '**Proveedor:** Emilio',
      '**Producto:** Tecno Caja',
      '',
      '---',
      '',
      'a) **Firma:** texto.',
      '   - uno',
      '   - dos',
      '',
      '| Aspecto | Información |',
      '|--------|------------|',
      '| **RNC** | [completar] |'
    ].join('\n'));

    expect(html).toContain('<h1>Título</h1>');
    expect(html).toContain('<h2>Subtítulo</h2>');
    expect(html).toContain('<p><strong>Proveedor:</strong> Emilio<br><strong>Producto:</strong> Tecno Caja</p>');
    expect(html).toContain('<hr>');
    expect(html).toContain('<p>a) <strong>Firma:</strong> texto.</p>\n<ul><li>uno</li><li>dos</li></ul>');
    expect(html).toContain('<thead><tr><th>Aspecto</th><th>Información</th></tr></thead>');
    expect(html).toContain('<tbody><tr><td><strong>RNC</strong></td><td>[completar]</td></tr></tbody>');
    expect(html).not.toContain('---');
  });

  test('escapa el HTML del documento', () => {
    expect(markdownAHtml('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  test('el documento real se convierte completo', () => {
    const html = markdownAHtml(DOCUMENTO);
    expect(html).toContain('<h1>TÉRMINOS Y CONDICIONES DE USO DE TECNO CAJA POS</h1>');
    expect(html).toContain('<h2>1. ACEPTACIÓN DE LOS TÉRMINOS Y CONDICIONES</h2>');
    expect(html).toContain('<h4>Información Oficial del Proveedor</h4>');
    expect(html).toContain('<td>Tecno Caja POS</td>');
    expect(html).not.toMatch(/\*\*|^#|\|-{3,}/m);
  });
});
