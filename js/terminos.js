'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   TECNO CAJA — Términos y condiciones de uso

   Enlace debajo de la tarjeta de inicio de sesión (index.html) que abre el
   documento en una ventana. El texto vive en legal/terminos-y-condiciones.md
   para cambiarlo sin tocar código: aquí se pasa a HTML con lo poco de
   Markdown que usa (títulos, negritas, listas, tablas y separadores).
   ═══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  const RUTA_DOCUMENTO = 'legal/terminos-y-condiciones.md';
  let htmlDocumento = '';

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function enLinea(texto) {
    return esc(texto).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }

  function celdas(linea) {
    return linea.replace(/^\|/, '').replace(/\|$/, '').split('|').map((celda) => celda.trim());
  }

  function markdownAHtml(markdown) {
    const html = [];
    let parrafo = [];
    let lista = [];
    let tabla = [];

    const cerrarBloques = () => {
      if (parrafo.length) {
        html.push(`<p>${parrafo.map(enLinea).join('<br>')}</p>`);
        parrafo = [];
      }
      if (lista.length) {
        html.push(`<ul>${lista.map((item) => `<li>${enLinea(item)}</li>`).join('')}</ul>`);
        lista = [];
      }
      if (tabla.length) {
        // La fila |---|---| solo separa la cabecera del cuerpo.
        const [cabecera, ...cuerpo] = tabla.filter((fila) => !fila.every((celda) => /^:?-{3,}:?$/.test(celda)));
        html.push('<div class="tc-terms__tabla"><table>'
          + `<thead><tr>${cabecera.map((celda) => `<th>${enLinea(celda)}</th>`).join('')}</tr></thead>`
          + `<tbody>${cuerpo.map((fila) => `<tr>${fila.map((celda) => `<td>${enLinea(celda)}</td>`).join('')}</tr>`).join('')}</tbody>`
          + '</table></div>');
        tabla = [];
      }
    };

    String(markdown || '').replace(/\r\n?/g, '\n').split('\n').forEach((cruda) => {
      const linea = cruda.trim();
      if (!linea) {
        cerrarBloques();
        return;
      }
      const titulo = /^(#{1,4})\s+(.*)$/.exec(linea);
      if (titulo) {
        cerrarBloques();
        const nivel = titulo[1].length;
        html.push(`<h${nivel}>${enLinea(titulo[2])}</h${nivel}>`);
        return;
      }
      if (/^-{3,}$/.test(linea)) {
        cerrarBloques();
        html.push('<hr>');
        return;
      }
      if (linea.startsWith('|')) {
        if (!tabla.length) cerrarBloques();
        tabla.push(celdas(linea));
        return;
      }
      const item = /^[-*]\s+(.*)$/.exec(linea);
      if (item) {
        if (!lista.length) cerrarBloques();
        lista.push(item[1]);
        return;
      }
      if (lista.length || tabla.length) cerrarBloques();
      parrafo.push(linea);
    });
    cerrarBloques();
    return html.join('\n');
  }

  function iniciarDialogo(dialogo) {
    if (dialogo.dataset.listo) return;
    dialogo.dataset.listo = '1';
    // Clic fuera de la ventana (en el fondo oscuro) también la cierra.
    dialogo.addEventListener('click', (event) => {
      if (event.target === dialogo) dialogo.close();
    });
    // Esc la cierra aquí mismo: el atajo global de Esc (js/ui.js) hace
    // preventDefault y el <dialog> no se cerraría solo.
    dialogo.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dialogo.close();
    });
  }

  async function abrirTerminos() {
    const dialogo = global.document.getElementById('terms-dialog');
    const cuerpo = global.document.getElementById('terms-dialog-body');
    if (!dialogo || !cuerpo) return;
    iniciarDialogo(dialogo);
    if (!dialogo.open) dialogo.showModal();
    if (!htmlDocumento) {
      cuerpo.innerHTML = '<p class="tc-terms__estado">Cargando…</p>';
      try {
        const respuesta = await fetch(RUTA_DOCUMENTO, { cache: 'no-cache' });
        if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
        htmlDocumento = markdownAHtml(await respuesta.text());
      } catch (error) {
        console.warn('No se pudieron cargar los términos y condiciones.', error);
        cuerpo.innerHTML = '<p class="tc-terms__estado">No se pudieron cargar los términos y condiciones. Cierra esta ventana e intenta de nuevo.</p>';
        return;
      }
    }
    cuerpo.innerHTML = htmlDocumento;
    cuerpo.scrollTop = 0;
  }

  function cerrarTerminos() {
    global.document.getElementById('terms-dialog')?.close();
  }

  global.abrirTerminos = abrirTerminos;
  global.cerrarTerminos = cerrarTerminos;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { markdownAHtml };
  }
})(typeof window !== 'undefined' ? window : globalThis);
