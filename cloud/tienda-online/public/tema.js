/* Tema claro/oscuro antes de pintar la página (evita el destello blanco).
 * Va en archivo aparte porque la política CSP no permite scripts en línea. */
(function () {
  'use strict';
  try {
    if (localStorage.getItem('tc-tema') === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  } catch (_e) { /* modo privado: queda el tema claro */ }
})();
