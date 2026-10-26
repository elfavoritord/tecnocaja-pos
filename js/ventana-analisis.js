// ══════════════════════════════════════════════════════════════
//  Ventana de análisis ("como una IA") — Tecno Caja
//  Muestra los pasos de un trabajo uno a uno mientras corre (leer un
//  archivo, guardar en el servidor) y escribe el resultado letra por letra.
//  La usan Secuencias e-NCF (js/ecf-sequences-config.js), el Catálogo de
//  servicios (js/servicios/servicios.js) y la importación de productos
//  (js/productos.js). Estilos .ecfs-ai* en css/ecf-secuencias.css.
//
//  TcVentanaAnalisis.correr({ titulo, subtitulo, pasos, trabajo, resumen })
//    → Promise con lo que devuelve trabajo(). Si falla, muestra el error con
//      "Cerrar" y la promesa se rechaza con ese error.
// ══════════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  function icono(nombre, tam) {
    return global.TcIconos ? global.TcIconos.svg(nombre, tam) : '';
  }

  function esc(texto) {
    return String(texto == null ? '' : texto).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function espera(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Cada paso dura un mínimo para que se pueda leer; el último espera a que
  // el trabajo termine de verdad.
  async function correr({ titulo, subtitulo, pasos, trabajo, resumen }) {
    const capa = document.createElement('div');
    capa.className = 'ecfs-ai tc-themed';
    capa.setAttribute('role', 'status');
    capa.innerHTML = `
      <div class="ecfs-ai__panel">
        <div class="ecfs-ai__orb">${icono('check', 30)}</div>
        <div class="ecfs-ai__title">${esc(titulo)}</div>
        <div class="ecfs-ai__subtitle">${esc(subtitulo || '')}</div>
        <ul class="ecfs-ai__steps">${pasos.map((paso) => `
          <li class="ecfs-ai__step"><span class="ecfs-ai__dot">${icono('check', 12)}</span><span>${esc(paso)}</span></li>`).join('')}
        </ul>
        <div class="ecfs-ai__result"></div>
        <div class="ecfs-ai__close"></div>
      </div>`;
    document.body.appendChild(capa);
    const items = Array.from(capa.querySelectorAll('.ecfs-ai__step'));
    const reducido = global.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const ritmo = reducido ? 120 : 520;

    let resultado;
    let error = null;
    const tarea = Promise.resolve().then(trabajo).then((valor) => { resultado = valor; }, (e) => { error = e; });
    for (let i = 0; i < items.length; i += 1) {
      items[i].classList.add('ecfs-ai__step--active');
      await (i === items.length - 1 ? Promise.all([tarea, espera(ritmo)]) : espera(ritmo));
      items[i].classList.remove('ecfs-ai__step--active');
      if (error && i === items.length - 1) break;
      items[i].classList.add('ecfs-ai__step--done');
    }

    const tituloEl = capa.querySelector('.ecfs-ai__title');
    const resultadoEl = capa.querySelector('.ecfs-ai__result');
    if (error) {
      capa.classList.add('ecfs-ai--error');
      capa.querySelector('.ecfs-ai__orb').innerHTML = icono('x', 30);
      items[items.length - 1].classList.add('ecfs-ai__step--fail');
      items[items.length - 1].querySelector('.ecfs-ai__dot').innerHTML = icono('x', 12);
      tituloEl.textContent = 'No se pudo completar';
      resultadoEl.classList.add('ecfs-ai__result--typed');
      resultadoEl.textContent = error.message || String(error);
      await new Promise((resolve) => {
        const cerrar = capa.querySelector('.ecfs-ai__close');
        cerrar.innerHTML = '<button class="btn-secondary" type="button">Cerrar</button>';
        cerrar.querySelector('button').addEventListener('click', resolve, { once: true });
      });
      capa.remove();
      throw error;
    }

    capa.classList.add('ecfs-ai--done');
    tituloEl.textContent = 'Listo';
    const texto = typeof resumen === 'function' ? resumen(resultado) : (resumen || '');
    // El resumen se escribe letra por letra, como la respuesta de un asistente.
    for (let i = 1; i <= texto.length; i += 1) {
      resultadoEl.textContent = texto.slice(0, i);
      await espera(reducido ? 0 : 14);
    }
    resultadoEl.classList.add('ecfs-ai__result--typed');
    await espera(reducido ? 300 : 1100);
    capa.remove();
    return resultado;
  }

  global.TcVentanaAnalisis = { correr };
})(window);
