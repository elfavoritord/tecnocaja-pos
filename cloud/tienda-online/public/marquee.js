/* Vitrinas con movimiento continuo. El grupo de productos se copia lo necesario y
 * la pista se mueve con requestAnimationFrame: al dar la vuelta salta exactamente
 * el ancho de un grupo, así que no se nota. Las copias son solo visuales (no están
 * para el teclado ni para lectores de pantalla) y usan los mismos botones.
 * Con pocos productos se copian las veces que haga falta para llenar la pantalla;
 * uno solo se queda quieto (no hay nada que mostrar moviéndolo). */
(function () {
  'use strict';

  const posiciones = new Map(); // se conserva al repintar la página
  let vitrinas = [];
  let marco = 0;
  let anterior = 0;
  let esperaMedida = null;

  const UMBRAL_ARRASTRE = 6;
  const REANUDAR_TACTIL_MS = 1500;

  function modulo(n, m) { return ((n % m) + m) % m; }

  function escribir(v) {
    v.pista.style.transform = `translate3d(${-v.pos}px, 0, 0)`;
  }

  function quitarCopias(v) {
    v.pista.querySelectorAll('.mq-grupo[data-copia]').forEach((c) => c.remove());
  }

  /** Mide y copia lo necesario. Se repite al cambiar el tamaño de la ventana. */
  function medir(v) {
    quitarCopias(v);
    const grupo = v.pista.querySelector('.mq-grupo');
    const hueco = parseFloat(getComputedStyle(grupo).columnGap) || 0;
    const anchoGrupo = grupo.getBoundingClientRect().width;
    const anchoCaja = v.caja.clientWidth;
    v.ancho = anchoGrupo + hueco;
    v.mueve = grupo.children.length > 1;
    v.caja.classList.toggle('quieta', !v.mueve);
    if (!v.mueve) {
      v.pos = 0;
      v.pista.style.transform = '';
      return;
    }
    v.pista.style.columnGap = `${hueco}px`;
    const copias = Math.ceil(anchoCaja / v.ancho);
    for (let i = 0; i < copias; i += 1) {
      const copia = grupo.cloneNode(true);
      copia.dataset.copia = '1';
      copia.setAttribute('aria-hidden', 'true');
      copia.querySelectorAll('a, button, input').forEach((el) => el.setAttribute('tabindex', '-1'));
      v.pista.appendChild(copia);
    }
    v.pos = modulo(v.pos, v.ancho);
    escribir(v);
  }

  function animar(ahora) {
    marco = 0;
    if (!vitrinas.length) return;
    const dt = Math.min(ahora - anterior, 100) / 1000;
    anterior = ahora;
    // Con un panel o el detalle abierto nadie la está mirando.
    const tapada = document.hidden || document.body.classList.contains('lock');
    for (const v of vitrinas) {
      if (!v.mueve || !v.visible || tapada || v.hover || v.foco || v.arrastre || ahora < v.quietaHasta) continue;
      v.pos = modulo(v.pos + v.velocidad * v.sentido * dt, v.ancho);
      posiciones.set(v.id, v.pos);
      escribir(v);
    }
    marco = requestAnimationFrame(animar);
  }

  function enlazar(v) {
    const { caja } = v;
    caja.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') v.hover = true; });
    caja.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') v.hover = false; });
    caja.addEventListener('focusin', (e) => {
      v.foco = true;
      // El navegador desplaza la caja para mostrar lo enfocado: se pasa a la pista.
      caja.scrollLeft = 0;
      if (!v.mueve || !e.target.matches(':focus-visible')) return;
      const r = (e.target.closest('.card') || e.target).getBoundingClientRect();
      const c = caja.getBoundingClientRect();
      if (r.left < c.left || r.right > c.right) {
        v.pos = modulo(v.pos + r.left - c.left - 16, v.ancho);
        escribir(v);
      }
    });
    caja.addEventListener('focusout', () => { v.foco = false; });

    // Deslizar con el dedo o arrastrar con el mouse. Un toque sin mover sigue siendo un clic.
    let toque = null;
    caja.addEventListener('pointerdown', (e) => {
      if (!v.mueve || e.button !== 0) return;
      toque = { x: e.clientX, pos: v.pos, id: e.pointerId, tipo: e.pointerType };
    });
    caja.addEventListener('pointermove', (e) => {
      if (!toque || e.pointerId !== toque.id) return;
      const dx = e.clientX - toque.x;
      if (!v.arrastre) {
        if (Math.abs(dx) < UMBRAL_ARRASTRE) return;
        v.arrastre = true;
        caja.classList.add('arrastrando');
        try { caja.setPointerCapture(e.pointerId); } catch (_e) { /* sin captura */ }
      }
      v.pos = modulo(toque.pos - dx, v.ancho);
      posiciones.set(v.id, v.pos);
      escribir(v);
    });
    const soltar = (e) => {
      if (!toque || e.pointerId !== toque.id) return;
      if (v.arrastre) {
        v.arrastre = false;
        v.ignorarClic = e.type === 'pointerup';
        caja.classList.remove('arrastrando');
        if (toque.tipo !== 'mouse') v.quietaHasta = performance.now() + REANUDAR_TACTIL_MS;
      }
      toque = null;
    };
    caja.addEventListener('pointerup', soltar);
    caja.addEventListener('pointercancel', soltar);
    // Soltar después de arrastrar no agrega al carrito ni abre el producto.
    caja.addEventListener('click', (e) => {
      if (!v.ignorarClic) return;
      v.ignorarClic = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);
  }

  const observador = 'IntersectionObserver' in window
    ? new IntersectionObserver((entradas) => {
      for (const en of entradas) {
        const v = vitrinas.find((x) => x.caja === en.target);
        if (v) v.visible = en.isIntersecting;
      }
    }, { rootMargin: '120px 0px' })
    : null;

  /** Arranca las vitrinas que haya dentro de `raiz` (reemplaza a las anteriores). */
  function montar(raiz) {
    observador?.disconnect();
    vitrinas = [...raiz.querySelectorAll('.mq-caja')].map((caja) => {
      const id = caja.dataset.marquee;
      const v = {
        id,
        caja,
        pista: caja.querySelector('.mq-pista'),
        velocidad: Number(caja.dataset.velocidad) || 40,
        sentido: caja.dataset.direccion === 'derecha' ? -1 : 1,
        pos: posiciones.get(id) || 0,
        ancho: 0,
        mueve: false,
        visible: !observador,
        hover: false,
        foco: false,
        arrastre: false,
        ignorarClic: false,
        quietaHasta: 0,
      };
      medir(v);
      enlazar(v);
      observador?.observe(caja);
      return v;
    });
    if (vitrinas.length && !marco) {
      anterior = performance.now();
      marco = requestAnimationFrame(animar);
    }
  }

  window.addEventListener('resize', () => {
    clearTimeout(esperaMedida);
    esperaMedida = setTimeout(() => vitrinas.forEach(medir), 150);
  }, { passive: true });

  // Al volver a la pestaña, sin un salto por el tiempo que estuvo oculta.
  document.addEventListener('visibilitychange', () => { anterior = performance.now(); });

  window.TCMarquee = { montar };
})();
