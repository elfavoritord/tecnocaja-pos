/* Tecno Caja — Personalizar tienda: editor visual con vista previa real.
 * Lo que se cambia se ve al instante en la vista previa, pero los clientes solo lo
 * ven al pulsar "Guardar y publicar". Toda validación la hace el servidor. */
(function () {
  'use strict';

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const copia = (x) => JSON.parse(JSON.stringify(x));

  const COLORES = [
    ['principal', 'Principal', true],
    ['secundario', 'Secundario'],
    ['fondo', 'Fondo'],
    ['texto', 'Textos'],
    ['botones', 'Botones', true],
    ['encabezado', 'Encabezado', true],
    ['pie', 'Pie de página'],
    ['tarjetas', 'Tarjetas'],
    ['destacados', 'Elementos destacados'],
  ];
  const ETIQUETAS = {
    pequeno: 'Pequeño', normal: 'Normal', grande: 'Grande', mediano: 'Mediano',
    redondeado: 'Redondeados', pastilla: 'Pastilla', recto: 'Rectos', contorno: 'Con contorno',
    rectas: 'Rectas', suaves: 'Suaves', redondas: 'Redondas',
    ninguna: 'Ninguna', suaves_sombra: 'Suaves', marcadas: 'Marcadas',
    compacto: 'Compacto', amplio: 'Amplio',
    limpia: 'Limpias', borde: 'Con borde', elevada: 'Con sombra',
    baja: 'Baja', media: 'Media', alta: 'Alta',
    izquierda: 'Izquierda', centro: 'Centro', derecha: 'Derecha',
  };
  const DESTINOS = [
    ['catalogo', 'Todos los productos'], ['ofertas', 'Ofertas'], ['nuevos', 'Nuevos productos'], ['destacados', 'Destacados'],
    ['masVendidos', 'Más vendidos'], ['contacto', 'Contacto'], ['whatsapp', 'WhatsApp'],
  ];
  const ANCHOS = { computadora: '100%', tableta: '768px', telefono: '390px' };

  const E = {
    raiz: null, cfg: null, d: null, publicado: null, sucio: false, conBorrador: false, marco: null, espera: null, arrastrando: null,
  };

  function token() {
    return (typeof getStoredAuthToken === 'function' ? getStoredAuthToken() : '') || window.DB?.authToken || '';
  }

  async function api(metodo, ruta, cuerpo) {
    const res = await fetch(`/api/tienda-online${ruta}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(token() ? { Authorization: `Bearer ${token()}` } : {}) },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'No se pudo completar.');
    return data;
  }

  function aviso(texto, tipo = 'success') {
    if (typeof showToast === 'function') showToast(texto, tipo);
  }

  // ── Controles ───────────────────────────────────────────────────────────
  const seccion = (titulo, cuerpo, abierta = false) => `<details class="te-sec"${abierta ? ' open' : ''}><summary>${titulo}</summary><div class="te-sec-in">${cuerpo}</div></details>`;

  function opciones(lista, actual, etiquetar = (v) => ETIQUETAS[v] || v) {
    return lista.map((v) => `<option value="${esc(v)}" ${v === actual ? 'selected' : ''}>${esc(etiquetar(v))}</option>`).join('');
  }

  const selectCampo = (ruta, etiqueta, lista, actual, etiquetar) => `<label class="te-campo">${etiqueta}<select data-ruta="${ruta}">${opciones(lista, actual, etiquetar)}</select></label>`;
  const checkCampo = (ruta, etiqueta, actual) => `<label class="te-check"><input type="checkbox" data-ruta="${ruta}" ${actual ? 'checked' : ''}> ${etiqueta}</label>`;
  const textoCampo = (ruta, etiqueta, actual, max, ayuda = '') => `<label class="te-campo">${etiqueta}<input type="text" data-ruta="${ruta}" maxlength="${max}" value="${esc(actual)}" placeholder="${esc(ayuda)}"></label>`;

  function destinoCampo(ruta, etiqueta, actual) {
    const esUrl = /^https:/i.test(actual || '');
    const esCat = /^categoria:/.test(actual || '');
    const cats = E.cfg.categorias || [];
    return `<label class="te-campo">${etiqueta}<select data-destino="${ruta}">
        ${DESTINOS.map(([v, t]) => `<option value="${v}" ${v === actual ? 'selected' : ''}>${t}</option>`).join('')}
        ${cats.map((c) => `<option value="categoria:${esc(c)}" ${actual === `categoria:${c}` ? 'selected' : ''}>Categoría: ${esc(c)}</option>`).join('')}
        <option value="__url" ${esUrl ? 'selected' : ''}>Otra dirección (https)</option>
      </select>
      <input type="url" class="${esUrl ? '' : 'hidden'}" data-destino-url="${ruta}" maxlength="300" placeholder="https://…" value="${esUrl ? esc(actual) : ''}">
      ${esCat && !cats.includes(actual.slice(10)) ? '<small>La categoría anterior ya no existe.</small>' : ''}
    </label>`;
  }

  function colorCampo([id, nombre, auto]) {
    const valor = E.d.colores[id];
    return `<div class="te-color">
      <span>${nombre}</span>
      <input type="color" data-color="${id}" value="${esc(valor || E.cfg.settings.colorPrimario || '#10b981')}" ${valor === null ? 'disabled' : ''} aria-label="${nombre}">
      ${auto ? `<label class="te-check"><input type="checkbox" data-color-auto="${id}" ${valor === null ? 'checked' : ''}> Color del negocio</label>` : ''}
    </div>`;
  }

  function imagenCampo(clave, etiqueta, tiene) {
    return `<div class="te-imagen">
      <span>${etiqueta}</span>
      <span class="te-img-estado">${tiene ? 'Con imagen' : 'Sin imagen'}</span>
      <button type="button" class="btn-secondary" data-img-subir="${clave}">Subir</button>
      ${tiene ? `<button type="button" class="btn-secondary" data-img-quitar="${clave}">Quitar</button>` : ''}
    </div>`;
  }

  function filaSeccion(s, info) {
    const fija = info.fija;
    return `<li class="te-fila${fija ? ' fija' : ''}" data-sec="${s.id}" ${fija ? '' : 'draggable="true"'}>
      <span class="te-asa" aria-hidden="true">${fija ? '·' : '⠿'}</span>
      <label class="te-check"><input type="checkbox" data-sec-activa="${s.id}" ${s.activa ? 'checked' : ''} ${info.siempre ? 'disabled' : ''}> ${esc(info.nombre)}</label>
      ${fija || s.id === 'hero' || s.id === 'banners' ? '' : `<input type="text" data-sec-titulo="${s.id}" maxlength="60" placeholder="Título (opcional)" value="${esc(s.titulo)}" aria-label="Título de ${esc(info.nombre)}">`}
      ${fija ? '<small>Fijo</small>' : `<span class="te-mover">
        <button type="button" data-mover="-1" aria-label="Subir ${esc(info.nombre)}">↑</button>
        <button type="button" data-mover="1" aria-label="Bajar ${esc(info.nombre)}">↓</button>
      </span>`}
    </li>`;
  }

  function pintarControles() {
    const { d, cfg } = E;
    const ed = cfg.editor;
    const letra = ed.tipografias.map((t) => t.id);
    const nombreLetra = (id) => ed.tipografias.find((t) => t.id === id)?.nombre || id;
    const sombra = (v) => (v === 'suaves' ? 'Suaves' : ETIQUETAS[v] || v);
    const imgs = cfg.imagenes || [];
    const panel = E.raiz.querySelector('#te-controles');
    const abiertas = new Set([...panel.querySelectorAll('details[open] summary')].map((s) => s.textContent));
    const primera = !panel.children.length;
    panel.innerHTML = `
      ${seccion('Estilo inicial', `
        <p class="te-ayuda">Un punto de partida: colores, letra y orden. Después puedes cambiar todo. Tus textos no se pierden.</p>
        <div class="te-estilos">${ed.estilos.map((x) => `<button type="button" class="te-estilo${x.id === d.estilo ? ' on' : ''}" data-estilo="${x.id}"><b>${esc(x.nombre)}</b><small>${esc(x.descripcion)}</small></button>`).join('')}</div>`, primera)}
      ${seccion('Colores', `<div class="te-colores">${COLORES.map(colorCampo).join('')}</div>`)}
      ${seccion('Apariencia', `
        ${selectCampo('apariencia.tipografia', 'Letra', letra, d.apariencia.tipografia, nombreLetra)}
        ${selectCampo('apariencia.tipografiaTitulos', 'Letra de los títulos', letra, d.apariencia.tipografiaTitulos, nombreLetra)}
        ${selectCampo('apariencia.tamanoTexto', 'Tamaño de textos', ed.opciones.tamanoTexto, d.apariencia.tamanoTexto)}
        ${selectCampo('apariencia.estiloBotones', 'Botones', ed.opciones.estiloBotones, d.apariencia.estiloBotones)}
        ${selectCampo('apariencia.esquinas', 'Esquinas', ed.opciones.esquinas, d.apariencia.esquinas)}
        ${selectCampo('apariencia.sombras', 'Sombras', ed.opciones.sombras, d.apariencia.sombras, sombra)}
        ${selectCampo('apariencia.espaciado', 'Espacio entre secciones', ed.opciones.espaciado, d.apariencia.espaciado)}
        ${selectCampo('apariencia.estiloTarjetas', 'Tarjetas de producto', ed.opciones.estiloTarjetas, d.apariencia.estiloTarjetas)}
        ${checkCampo('apariencia.temaOscuro', 'El cliente puede usar modo oscuro', d.apariencia.temaOscuro)}`)}
      ${seccion('Encabezado', `
        ${checkCampo('encabezado.mostrarLogo', 'Mostrar logo', d.encabezado.mostrarLogo)}
        ${selectCampo('encabezado.tamanoLogo', 'Tamaño del logo', ed.opciones.tamanoLogo, d.encabezado.tamanoLogo)}
        ${checkCampo('encabezado.mostrarNombre', 'Mostrar el nombre', d.encabezado.mostrarNombre)}
        ${checkCampo('encabezado.mostrarMenu', 'Menú de navegación', d.encabezado.mostrarMenu)}
        ${checkCampo('encabezado.mostrarTelefono', 'Teléfono', d.encabezado.mostrarTelefono)}
        ${checkCampo('encabezado.mostrarWhatsapp', 'WhatsApp', d.encabezado.mostrarWhatsapp)}
        ${checkCampo('encabezado.mostrarBuscador', 'Buscador', d.encabezado.mostrarBuscador)}
        ${checkCampo('encabezado.mostrarCarrito', 'Carrito', d.encabezado.mostrarCarrito)}
        <p class="te-ayuda">Si quitas el carrito, en computadora aparece uno flotante para que el cliente siempre pueda comprar.</p>`)}
      ${seccion('Banner principal', `
        <p class="te-ayuda">Si tu imagen ya trae letras, deja el título y el subtítulo vacíos: la imagen sale sola y completa.</p>
        ${textoCampo('hero.titulo', 'Título', d.hero.titulo, 90)}
        ${textoCampo('hero.subtitulo', 'Subtítulo', d.hero.subtitulo, 200)}
        ${textoCampo('hero.textoBoton', 'Texto del botón', d.hero.textoBoton, 30, 'Ver productos')}
        ${destinoCampo('hero.enlaceBoton', 'El botón lleva a', d.hero.enlaceBoton)}
        ${textoCampo('hero.textoBoton2', 'Segundo botón (opcional)', d.hero.textoBoton2, 30)}
        ${destinoCampo('hero.enlaceBoton2', 'El segundo botón lleva a', d.hero.enlaceBoton2)}
        ${selectCampo('hero.altura', 'Altura', ed.opciones.alturaHero, d.hero.altura)}
        ${selectCampo('hero.alineacion', 'Alineación del texto', ed.opciones.alineacionHero, d.hero.alineacion)}
        ${imagenCampo('banner', 'Imagen para computadora', cfg.hasBanner)}
        ${imagenCampo('banner_movil', 'Imagen para teléfono', imgs.includes('banner_movil'))}`)}
      ${seccion('Secciones', `
        <p class="te-ayuda">Arrastra para cambiar el orden. Las Ofertas especiales y los Nuevos productos se ajustan en Configurar tienda → Vitrinas.</p>
        <ul class="te-filas" id="te-filas">${d.secciones.map((s) => filaSeccion(s, ed.secciones.find((x) => x.id === s.id) || { nombre: s.id })).join('')}</ul>`, true)}
      ${seccion('Banners publicitarios', Array.from({ length: ed.maxAnuncios }, (_, i) => {
    const n = i + 1;
    const a = d.anuncios[i] || { titulo: '', enlace: '' };
    return `<div class="te-anuncio"><b>Banner ${n}</b>
          ${imagenCampo(`anuncio_${n}`, 'Imagen', imgs.includes(`anuncio_${n}`))}
          ${textoCampo(`anuncios.${i}.titulo`, 'Texto', a.titulo, 60)}
          ${destinoCampo(`anuncios.${i}.enlace`, 'Lleva a', a.enlace)}
        </div>`;
  }).join(''))}
      ${seccion('Redes sociales', ed.redes.map((r) => textoCampo(`redes.${r}`, r[0].toUpperCase() + r.slice(1), d.redes[r], 300, 'https://…')).join(''))}
      <input type="file" id="te-archivo" accept="image/png,image/jpeg,image/webp" class="hidden">`;
    if (!primera) panel.querySelectorAll('details').forEach((x) => { x.open = abiertas.has(x.querySelector('summary').textContent); });
  }

  // ── Cambios ─────────────────────────────────────────────────────────────
  function poner(ruta, valor) {
    const partes = ruta.split('.');
    let o = E.d;
    for (let i = 0; i < partes.length - 1; i += 1) {
      const k = partes[i];
      if (o[k] === undefined) o[k] = /^\d+$/.test(partes[i + 1]) ? [] : {};
      o = o[k];
    }
    o[partes[partes.length - 1]] = valor;
  }

  function enviarVista() {
    const ventana = E.marco?.contentWindow;
    if (ventana) ventana.postMessage({ tipo: 'tc-diseno', diseno: E.d }, location.origin);
  }

  function cambio() {
    E.sucio = true;
    pintarEstado();
    clearTimeout(E.espera);
    E.espera = setTimeout(enviarVista, 120);
  }

  function pintarEstado() {
    const estado = E.raiz.querySelector('#te-estado');
    estado.textContent = E.sucio ? 'Cambios sin guardar' : E.conBorrador ? 'Borrador guardado, sin publicar' : 'Igual a lo publicado';
    estado.dataset.tipo = E.sucio || E.conBorrador ? 'pendiente' : 'ok';
  }

  function alCambiar(e) {
    const t = e.target;
    if (t.dataset.ruta) {
      poner(t.dataset.ruta, t.type === 'checkbox' ? t.checked : t.value);
      cambio();
    } else if (t.dataset.color) {
      E.d.colores[t.dataset.color] = t.value;
      cambio();
    } else if (t.dataset.colorAuto) {
      const id = t.dataset.colorAuto;
      const entrada = E.raiz.querySelector(`[data-color="${id}"]`);
      entrada.disabled = t.checked;
      E.d.colores[id] = t.checked ? null : entrada.value;
      cambio();
    } else if (t.dataset.destino) {
      const url = E.raiz.querySelector(`[data-destino-url="${t.dataset.destino}"]`);
      url.classList.toggle('hidden', t.value !== '__url');
      if (t.value !== '__url') { poner(t.dataset.destino, t.value); cambio(); } else url.focus();
    } else if (t.dataset.destinoUrl) {
      poner(t.dataset.destinoUrl, t.value.trim());
      cambio();
    } else if (t.dataset.secActiva) {
      E.d.secciones.find((s) => s.id === t.dataset.secActiva).activa = t.checked;
      cambio();
    } else if (t.dataset.secTitulo) {
      E.d.secciones.find((s) => s.id === t.dataset.secTitulo).titulo = t.value;
      cambio();
    }
  }

  /** El orden de la lista pasa al diseño; encabezado y pie se quedan en sus puntas. */
  function leerOrden() {
    const ids = [...E.raiz.querySelectorAll('#te-filas .te-fila')].map((x) => x.dataset.sec);
    E.d.secciones = ids.map((id) => E.d.secciones.find((s) => s.id === id));
    cambio();
  }

  function mover(fila, sentido) {
    const otra = sentido < 0 ? fila.previousElementSibling : fila.nextElementSibling;
    if (!otra || otra.classList.contains('fija')) return;
    if (sentido < 0) otra.before(fila); else otra.after(fila);
    leerOrden();
  }

  function enlazarArrastre() {
    const lista = E.raiz.querySelector('#te-controles');
    lista.addEventListener('dragstart', (e) => {
      const fila = e.target.closest?.('.te-fila');
      // Arrastrar dentro del título selecciona texto, no mueve la fila.
      if (!fila || fila.classList.contains('fija') || e.target.matches('input')) return;
      E.arrastrando = fila;
      fila.classList.add('arrastrando');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', fila.dataset.sec);
    });
    lista.addEventListener('dragover', (e) => {
      const sobre = e.target.closest?.('.te-fila');
      if (!E.arrastrando || !sobre || sobre === E.arrastrando || sobre.classList.contains('fija')) return;
      e.preventDefault();
      const r = sobre.getBoundingClientRect();
      if (e.clientY > r.top + r.height / 2) sobre.after(E.arrastrando); else sobre.before(E.arrastrando);
    });
    lista.addEventListener('drop', (e) => { if (E.arrastrando) e.preventDefault(); });
    lista.addEventListener('dragend', () => {
      if (!E.arrastrando) return;
      E.arrastrando.classList.remove('arrastrando');
      E.arrastrando = null;
      leerOrden();
    });
  }

  // ── Imágenes (se publican al subirlas, como el banner de siempre) ───────
  let claveImagen = null;
  function subirImagen(archivo) {
    if (!archivo) return;
    if (archivo.size > 8 * 1024 * 1024) { aviso('La imagen debe pesar menos de 8 MB.', 'error'); return; }
    const lector = new FileReader();
    lector.onload = async () => {
      try {
        if (claveImagen === 'banner') {
          await api('POST', '/config/banner', { dataUrl: lector.result });
          E.cfg.hasBanner = true;
        } else {
          const r = await api('POST', `/config/imagen/${claveImagen}`, { dataUrl: lector.result });
          E.cfg.imagenes = r.imagenes;
        }
        aviso('Imagen guardada.');
        pintarControles();
        recargarVista();
      } catch (error) { aviso(error.message, 'error'); }
    };
    lector.readAsDataURL(archivo);
  }

  async function quitarImagen(clave) {
    try {
      if (clave === 'banner') {
        await api('DELETE', '/config/banner');
        E.cfg.hasBanner = false;
      } else {
        const r = await api('DELETE', `/config/imagen/${clave}`);
        E.cfg.imagenes = r.imagenes;
      }
      pintarControles();
      recargarVista();
    } catch (error) { aviso(error.message, 'error'); }
  }

  function recargarVista() {
    if (E.marco) E.marco.src = `/t/vista-previa?r=${Date.now()}`;
  }

  // ── Acciones ────────────────────────────────────────────────────────────
  async function guardar(publicar) {
    try {
      const r = await api('PUT', '/config/diseno', { diseno: E.d, publicar });
      E.d = r.diseno;
      E.publicado = r.publicado;
      E.sucio = false;
      E.conBorrador = !publicar;
      // El servidor pudo corregir algo (un enlace inválido, un valor fuera de rango).
      pintarControles();
      enviarVista();
      pintarEstado();
      aviso(publicar ? 'Publicado: tus clientes ya lo ven.' : 'Borrador guardado. Tus clientes todavía no lo ven.');
    } catch (error) { aviso(error.message, 'error'); }
  }

  async function descartar() {
    if (!confirm('¿Descartar los cambios y volver a lo que está publicado?')) return;
    try {
      await api('DELETE', '/config/diseno/borrador');
      E.d = copia(E.publicado);
      E.sucio = false;
      E.conBorrador = false;
      pintarControles();
      enviarVista();
      pintarEstado();
    } catch (error) { aviso(error.message, 'error'); }
  }

  async function aplicarEstilo(id, { restaurar = false } = {}) {
    try {
      const r = await api('POST', '/config/diseno/estilo', { estilo: id, diseno: E.d, restaurar });
      E.d = r.diseno;
      pintarControles();
      cambio();
    } catch (error) { aviso(error.message, 'error'); }
  }

  function restaurar() {
    if (!confirm('¿Volver a los valores originales del estilo? Se borran también los textos del banner. No se publica hasta que lo indiques.')) return;
    aplicarEstilo(E.d.estilo, { restaurar: true });
  }

  function cerrar() {
    if (E.sucio && !confirm('Tienes cambios sin guardar. ¿Salir sin guardarlos?')) return;
    E.raiz.remove();
    E.raiz = null;
    document.removeEventListener('keydown', alTeclado);
  }

  function alTeclado(e) {
    if (e.key === 'Escape' && !E.arrastrando) cerrar();
  }

  function alClic(e) {
    const t = e.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (d.estilo) aplicarEstilo(d.estilo);
    else if (d.mover) mover(t.closest('.te-fila'), Number(d.mover));
    else if (d.imgSubir) { claveImagen = d.imgSubir; E.raiz.querySelector('#te-archivo').click(); }
    else if (d.imgQuitar) quitarImagen(d.imgQuitar);
    else if (d.ancho) {
      E.raiz.querySelectorAll('[data-ancho]').forEach((b) => b.classList.toggle('on', b === t));
      E.marco.style.width = ANCHOS[d.ancho];
    } else if (d.accion === 'borrador') guardar(false);
    else if (d.accion === 'publicar') guardar(true);
    else if (d.accion === 'descartar') descartar();
    else if (d.accion === 'restaurar') restaurar();
    else if (d.accion === 'cerrar') cerrar();
  }

  async function abrir() {
    if (E.raiz) return;
    let cfg;
    try {
      cfg = await api('GET', '/config');
    } catch (error) { aviso(error.message, 'error'); return; }
    E.cfg = cfg;
    E.publicado = copia(cfg.disenoBase);
    E.d = copia(cfg.settings.disenoBorrador || cfg.disenoBase);
    E.conBorrador = Boolean(cfg.settings.disenoBorrador);
    E.sucio = false;
    const raiz = document.createElement('div');
    raiz.className = 'te-raiz';
    raiz.setAttribute('role', 'dialog');
    raiz.setAttribute('aria-label', 'Personalizar tienda');
    raiz.innerHTML = `
      <header class="te-barra">
        <h2>Personalizar tienda</h2>
        <span id="te-estado" class="te-estado"></span>
        <div class="te-anchos" role="group" aria-label="Tamaño de la vista previa">
          <button type="button" data-ancho="computadora" class="on">Computadora</button>
          <button type="button" data-ancho="tableta">Tableta</button>
          <button type="button" data-ancho="telefono">Teléfono</button>
        </div>
        <div class="te-acciones">
          <button type="button" class="btn-secondary" data-accion="restaurar">Restaurar predeterminado</button>
          <button type="button" class="btn-secondary" data-accion="descartar">Descartar</button>
          <button type="button" class="btn-secondary" data-accion="borrador">Guardar</button>
          <button type="button" class="btn-primary" data-accion="publicar">Guardar y publicar</button>
          <button type="button" class="btn-secondary" data-accion="cerrar" aria-label="Cerrar">✕</button>
        </div>
      </header>
      <div class="te-cuerpo">
        <aside id="te-controles" class="te-controles"></aside>
        <div class="te-vista"><iframe id="te-marco" title="Vista previa de la tienda" src="/t/vista-previa?r=${Date.now()}"></iframe></div>
      </div>`;
    document.body.appendChild(raiz);
    E.raiz = raiz;
    E.marco = raiz.querySelector('#te-marco');
    E.marco.addEventListener('load', () => setTimeout(enviarVista, 400));
    raiz.addEventListener('click', alClic);
    raiz.addEventListener('input', alCambiar);
    raiz.addEventListener('change', (e) => {
      if (e.target.id === 'te-archivo') { subirImagen(e.target.files?.[0]); e.target.value = ''; } else if (e.target.tagName === 'SELECT' || e.target.type === 'checkbox') { /* ya atendido en input */ }
    });
    document.addEventListener('keydown', alTeclado);
    pintarControles();
    enlazarArrastre();
    pintarEstado();
  }

  window.TiendaEditor = { abrir };
})();
