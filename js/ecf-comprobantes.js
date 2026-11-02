// ===== COMPROBANTES ENVIADOS A LA DGII =====
//
// Configuración → Ventas y Facturación → Comprobantes enviados a la DGII.
// Lista cada e-CF con su estado, el motivo si dio error, el enlace de consulta
// de la DGII y su XML. Los datos salen de GET /api/ecf/comprobantes.

/* global DB, escapeHtml, fiscalApi, getStoredAuthToken, showDeleteConfirm, showToast */

(function () {
  'use strict';

  const GRUPOS = [
    ['', 'Todos', 'total'],
    ['aceptado', 'Aceptados', 'aceptado'],
    ['condicional', 'Condicionales', 'condicional'],
    ['rechazado', 'Rechazados', 'rechazado'],
    ['proceso', 'En proceso', 'proceso'],
    ['sin_enviar', 'Sin enviar o con error', 'sinEnviar'],
  ];
  const ESTADOS = {
    aceptado: ['Aceptado', 'ecfs-pill--ok'],
    aceptado_condicional: ['Aceptado condicional', 'ecfd-pill--aviso'],
    rechazado: ['Rechazado', 'ecfs-pill--bad'],
    bloqueado: ['Número ya usado', 'ecfs-pill--bad'],
    enviado: ['Enviado, esperando a la DGII', 'ecfd-pill--aviso'],
    en_proceso: ['En proceso', 'ecfd-pill--aviso'],
    procesando: ['En proceso', 'ecfd-pill--aviso'],
    firmado: ['Firmado, sin enviar', ''],
    pendiente: ['Pendiente de envío', ''],
    pendiente_red: ['Pendiente: sin conexión', ''],
    pendiente_rfce: ['Pendiente de envío', ''],
  };
  const SE_REENVIA = ['rechazado', 'bloqueado', 'error', 'error_auth', 'error_consulta', 'error_xml', 'error_firma', 'pendiente', 'pendiente_red', 'pendiente_rfce', 'firmado'];

  const filtros = { estado: '', tipo: '', ambiente: 'ecf', desde: '', hasta: '', buscar: '', pagina: 1 };
  let datos = null;
  let tiposCargados = false;
  let esperaBusqueda = null;
  let seguimiento = null;

  const $ = (id) => document.getElementById(id);
  const esc = (valor) => escapeHtml(String(valor ?? ''));
  const icono = (nombre) => (window.TcIconos ? window.TcIconos.svg(nombre, 16) : '');
  const dinero = (valor) => Number(valor || 0).toLocaleString('es-DO', { style: 'currency', currency: 'DOP' });

  function fechaCorta(valor) {
    const fecha = new Date(String(valor || '').replace(' ', 'T'));
    return Number.isNaN(fecha.getTime()) ? '' : fecha.toLocaleString('es-DO', { dateStyle: 'medium', timeStyle: 'short' });
  }

  async function cargar() {
    const lista = $('ecfd-lista');
    if (!lista) return;
    clearTimeout(seguimiento);
    const consulta = new URLSearchParams();
    Object.entries(filtros).forEach(([clave, valor]) => { if (valor) consulta.set(clave, valor); });
    try {
      datos = await fiscalApi('GET', `/comprobantes?${consulta}`);
    } catch (e) {
      lista.innerHTML = `<div class="error-text">No se pudieron cargar los comprobantes: ${esc(e.message)}</div>`;
      return;
    }
    pintar();
    seguirEsperando(0);
  }

  function pintar() {
    const { documents, resumen, total, pagina, paginas } = datos;
    $('ecfd-resumen').innerHTML = GRUPOS.map(([valor, nombre, clave]) => `
      <button type="button" class="ecfd-chip ${filtros.estado === valor ? 'is-activo' : ''}" data-grupo="${valor}">
        <strong>${Number(resumen[clave] || 0).toLocaleString('es-DO')}</strong>${esc(nombre)}
      </button>`).join('');
    $('ecfd-lista').innerHTML = documents.length
      ? documents.map(fila).join('')
      : `<div class="ecfs-empty">${total === 0 && !filtros.buscar && !filtros.estado && !filtros.tipo && !filtros.desde && !filtros.hasta
        ? 'Todavía no hay comprobantes en este ambiente.'
        : 'Ningún comprobante coincide con esos filtros.'}</div>`;
    $('ecfd-paginas').innerHTML = paginas > 1 ? `
      <button type="button" class="ecfs-btn" data-pagina="${pagina - 1}" ${pagina <= 1 ? 'disabled' : ''}>Anterior</button>
      <span>Página ${pagina} de ${paginas}</span>
      <button type="button" class="ecfs-btn" data-pagina="${pagina + 1}" ${pagina >= paginas ? 'disabled' : ''}>Siguiente</button>` : '';
  }

  function fila(doc) {
    const [estado, clase] = ESTADOS[doc.estado] || [doc.estado ? `Error: ${doc.estado.replace(/^error_?/, '') || 'sin enviar'}` : 'Sin estado', 'ecfs-pill--bad'];
    const datosLinea = [
      doc.comprador || 'Consumidor Final',
      doc.rncComprador ? `RNC ${doc.rncComprador}` : '',
      fechaCorta(doc.fecha),
      doc.factura ? `Factura ${doc.factura}` : '',
    ].filter(Boolean).map(esc).join(' · ');
    const mensajes = doc.mensajes.length ? `
      <ul class="ecfd-mensajes ${doc.grupo === 'condicional' ? 'ecfd-mensajes--aviso' : ''}">
        ${doc.mensajes.map((m) => `<li>${m.codigo ? `<strong>Código ${esc(m.codigo)}:</strong> ` : ''}${esc(m.texto)}</li>`).join('')}
      </ul>` : '';
    const puedeReenviar = doc.ambiente === 'ecf' && SE_REENVIA.includes(doc.estado);
    return `
      <div class="ecfd-fila" data-id="${doc.id}">
        <div class="ecfd-fila__cabeza">
          <span class="ecfs-chip">${esc(doc.tipoEcf)}</span>
          <div class="ecfd-fila__titulo">
            <strong class="ecfd-encf">${esc(doc.encf || 'Sin número')}</strong>
            <div class="ecfs-card__meta">${esc(doc.tipoNombre)}</div>
          </div>
          <div class="ecfd-fila__monto">
            <strong>${dinero(doc.montoTotal)}</strong>
            <span class="ecfs-pill ${clase}">${esc(estado)}</span>
          </div>
        </div>
        <div class="ecfs-card__meta">${datosLinea}</div>
        ${mensajes}
        ${doc.trackId ? `<div class="ecfd-track">TrackID: <code>${esc(doc.trackId)}</code>
          <button type="button" class="ecfd-copiar" data-accion="copiar" data-texto="${esc(doc.trackId)}" title="Copiar TrackID" aria-label="Copiar TrackID">${icono('copy')}</button></div>` : ''}
        <div class="ecfs-card__actions">
          ${doc.enlace ? `<button type="button" class="ecfs-btn" data-accion="enlace" data-url="${esc(doc.enlace)}">${icono('eye')}Ver en la DGII</button>
            <button type="button" class="ecfs-btn" data-accion="copiar" data-texto="${esc(doc.enlace)}">${icono('copy')}Copiar enlace</button>` : ''}
          ${doc.tieneXml ? `<button type="button" class="ecfs-btn" data-accion="xml" data-encf="${esc(doc.encf)}">${icono('file-text')}Ver XML</button>` : ''}
          ${doc.trackId ? `<button type="button" class="ecfs-btn" data-accion="consultar">${icono('refresh-cw')}Consultar DGII</button>` : ''}
          ${puedeReenviar ? `<button type="button" class="ecfs-btn" data-accion="reenviar" data-encf="${esc(doc.encf)}" data-estado="${esc(doc.estado)}">${icono('refresh-cw')}Reenviar</button>` : ''}
        </div>
      </div>`;
  }

  // Mientras alguno espere respuesta se le pregunta a la DGII, que contesta a los pocos segundos.
  function seguirEsperando(intento) {
    const esperando = (datos?.documents || []).filter((doc) => doc.grupo === 'proceso' && doc.trackId).slice(0, 10);
    if (!esperando.length || intento >= 12) return;
    seguimiento = setTimeout(async () => {
      if (!$('ecfd-lista')?.isConnected) return;
      const respuestas = await Promise.all(esperando.map((doc) => fiscalApi('GET', `/documents/${doc.id}/status`).catch(() => null)));
      const cambio = respuestas.some((r, i) => r && r.estado !== esperando[i].estado);
      if (cambio) cargar();
      else seguirEsperando(intento + 1);
    }, intento === 0 ? 2000 : 5000);
  }

  async function copiar(texto) {
    try {
      await navigator.clipboard.writeText(texto);
      showToast('Copiado.', 'success');
    } catch (_) {
      showToast('No se pudo copiar.', 'error');
    }
  }

  async function abrirEnlace(url) {
    if (!window.novaDesktop?.openExternal) { window.open(url, '_blank', 'noopener'); return; }
    const resultado = await window.novaDesktop.openExternal(url);
    if (resultado && resultado.ok === false) showToast(resultado.error || 'No se pudo abrir el enlace.', 'error');
  }

  // Los avisos quedan detrás de la ventana del XML: ahí el propio botón dice que copió.
  async function copiarXml(boton) {
    try {
      await navigator.clipboard.writeText($('ecfd-xml').dataset.xml);
      boton.textContent = 'Copiado';
    } catch (_) {
      boton.textContent = 'No se pudo copiar';
    }
    setTimeout(() => { boton.textContent = 'Copiar'; }, 1500);
  }

  // Sangría para poder leerlo; el XML guardado no cambia.
  function conSangria(xml) {
    let nivel = 0;
    return String(xml).replace(/>\s*</g, '>\n<').split('\n').map((linea) => {
      if (/^<\//.test(linea)) nivel = Math.max(nivel - 1, 0);
      const salida = `${'  '.repeat(nivel)}${linea}`;
      if (/^<[^!?/][^>]*[^/]>$/.test(linea) || /^<[^!?/]>$/.test(linea)) nivel += 1;
      return salida;
    }).join('\n');
  }

  async function verXml(id, encf) {
    let xml = '';
    try {
      const token = (typeof getStoredAuthToken === 'function' ? getStoredAuthToken() : '') || DB?.authToken || '';
      const res = await fetch(`/api/ecf/documents/${id}/xml`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      xml = await res.text();
    } catch (e) {
      showToast(`No se pudo abrir el XML: ${e.message}`, 'error');
      return;
    }
    if (!xml.trim()) { showToast('Este comprobante no tiene XML guardado.', 'warning'); return; }
    const visor = $('ecfd-xml');
    $('ecfd-xml-titulo').textContent = `XML de ${encf || 'el comprobante'}`;
    $('ecfd-xml-texto').textContent = conSangria(xml);
    visor.dataset.xml = xml;
    visor.dataset.nombre = `${encf || `ecf-${id}`}.xml`;
    visor.showModal();
  }

  function descargarXml() {
    const visor = $('ecfd-xml');
    const url = URL.createObjectURL(new Blob([visor.dataset.xml], { type: 'application/xml' }));
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = visor.dataset.nombre;
    enlace.click();
    URL.revokeObjectURL(url);
  }

  async function consultar(id, boton) {
    boton.disabled = true;
    try {
      const r = await fiscalApi('GET', `/documents/${id}/status`);
      showToast(`La DGII dice: ${(ESTADOS[r.estado] || [r.estado])[0]}.`, 'info');
    } catch (e) {
      showToast(`No se pudo consultar: ${e.message}`, 'error');
    }
    cargar();
  }

  async function reenviar(id, encf, estado, boton) {
    const rechazado = ['rechazado', 'bloqueado'].includes(estado);
    const aviso = rechazado
      ? `La DGII ya usó el <strong>${esc(encf)}</strong>, así que este comprobante saldrá con el siguiente número de tu secuencia y gastará uno. ¿Reenviarlo?`
      : `¿Enviar el <strong>${esc(encf)}</strong> a la DGII?`;
    if (!await showDeleteConfirm(aviso, { confirmText: 'Reenviar', cancelText: 'Cancelar' })) return;
    boton.disabled = true;
    try {
      const r = await fiscalApi('POST', `/documents/${id}/resend`);
      showToast(`${r.encf || encf}: ${(ESTADOS[r.estado] || [r.estado || 'enviado'])[0]}.`, r.ok === false ? 'error' : 'success');
    } catch (e) {
      showToast(`No se pudo reenviar: ${e.message}`, 'error');
    }
    cargar();
  }

  function conectar() {
    // Configuración mueve el contenido de la sección a su ventana y deja el
    // #cfg-ecf-docs-section atrás: los eventos se escuchan en #ecfd-panel, que viaja con él.
    const raiz = $('ecfd-panel');
    if (!raiz || raiz.dataset.listo) return;
    raiz.dataset.listo = '1';
    raiz.addEventListener('click', (evento) => {
      const grupo = evento.target.closest('[data-grupo]');
      if (grupo) { filtros.estado = grupo.dataset.grupo; filtros.pagina = 1; cargar(); return; }
      const pagina = evento.target.closest('[data-pagina]');
      if (pagina) { filtros.pagina = Number(pagina.dataset.pagina); cargar(); return; }
      const boton = evento.target.closest('[data-accion]');
      if (!boton) return;
      const id = Number(boton.closest('[data-id]')?.dataset.id);
      if (boton.dataset.accion === 'enlace') abrirEnlace(boton.dataset.url);
      if (boton.dataset.accion === 'copiar') copiar(boton.dataset.texto);
      if (boton.dataset.accion === 'xml') verXml(id, boton.dataset.encf);
      if (boton.dataset.accion === 'consultar') consultar(id, boton);
      if (boton.dataset.accion === 'reenviar') reenviar(id, boton.dataset.encf, boton.dataset.estado, boton);
    });
    [['ecfd-tipo', 'tipo'], ['ecfd-ambiente', 'ambiente'], ['ecfd-desde', 'desde'], ['ecfd-hasta', 'hasta']].forEach(([campo, clave]) => {
      $(campo).addEventListener('change', (evento) => { filtros[clave] = evento.target.value; filtros.pagina = 1; cargar(); });
    });
    $('ecfd-buscar').addEventListener('input', (evento) => {
      clearTimeout(esperaBusqueda);
      esperaBusqueda = setTimeout(() => { filtros.buscar = evento.target.value.trim(); filtros.pagina = 1; cargar(); }, 300);
    });
    $('ecfd-xml-copiar').addEventListener('click', (evento) => copiarXml(evento.currentTarget));
    $('ecfd-xml-descargar').addEventListener('click', descargarXml);
    $('ecfd-xml-cerrar').addEventListener('click', () => $('ecfd-xml').close());
  }

  async function cargarTipos() {
    if (tiposCargados) return;
    const tipos = await fiscalApi('GET', '/sequences/types').catch(() => []);
    if (!tipos.length) return;
    $('ecfd-tipo').innerHTML = `<option value="">Todos los tipos</option>${tipos.map((t) => `<option value="${esc(t.code)}">${esc(t.code)} · ${esc(t.label)}</option>`).join('')}`;
    tiposCargados = true;
  }

  window.loadEcfComprobantes = function loadEcfComprobantes() {
    if (!$('ecfd-panel')) return;
    conectar();
    cargarTipos();
    cargar();
  };
}());
