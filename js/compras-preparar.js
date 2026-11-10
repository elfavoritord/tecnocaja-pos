/* Compras de proveedores — pantalla «Preparar compra», subida de facturas,
   borradores, recepción de mercancía y configuración de compras.
   Servidor: server/routes/compras.routes.js + server/services/compras/.
   Un borrador no toca inventario, cuentas por pagar ni la DGII: eso pasa solo
   al «Confirmar y registrar compra», una sola vez. */
(() => {
  'use strict';
  const P = () => window.ComprasPrecios;
  const Mon = () => window.PosMoney;
  const esc = (v) => (typeof escapeHtml === 'function' ? escapeHtml(String(v ?? '')) : String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const money = (v) => (typeof fmt === 'function' ? fmt(Number(v || 0)) : `RD$ ${Number(v || 0).toFixed(2)}`);
  const toast = (m, t = 'success') => (typeof showToast === 'function' ? showToast(m, t) : alert(m));
  const estructura = () => (typeof getBusinessStructurePayload === 'function' ? getBusinessStructurePayload() : {});
  const req = (url, opts = {}) => api.request(url, opts);
  const json = (method, body, extra = {}) => ({ method, body: JSON.stringify(body || {}), ...extra });
  function uuid() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    const b = new Uint8Array(16); window.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  const ORIGEN = { manual: 'Manual', xml: 'XML e-CF', csv: 'CSV', xlsx: 'Excel', adjunto: 'Foto / PDF', portal: 'Portal del contador' };
  const ESTADO_INV = { no_aplica: 'Sin inventario', pendiente_recepcion: 'Por recibir', recibido_parcial: 'Recibido en parte', recibido_total: 'Recibido' };
  // Igual que server/services/compras/compras.service.js: electrónicos primero.
  const TIPOS_PROVEEDOR = { E31: 'Crédito fiscal electrónico', E32: 'Consumo electrónico', E44: 'Régimen especial electrónico', E45: 'Gubernamental electrónico',
    B01: 'Crédito fiscal', B02: 'Consumo', B14: 'Régimen especial', B15: 'Gubernamental' };
  const TIPOS_NEGOCIO = { E41: 'Comprobante de compras electrónico', B11: 'Comprobante de compras' };
  function tipoDeNcf(ncf) {
    const t = String(ncf || '').toUpperCase().replace(/[\s-]/g, '');
    if (!t) return '';
    if (!/^(B\d{10}|E\d{12})$/.test(t)) return t.length >= 3 ? 'Formato no válido: B + 10 dígitos o E + 12 dígitos' : '';
    const tipo = t.slice(0, 3);
    return TIPOS_PROVEEDOR[tipo] ? `${tipo} · ${TIPOS_PROVEEDOR[tipo]}` : `${tipo}: no es un comprobante de proveedor para compras`;
  }
  let cfg = null;

  async function configuracion(forzar = false) {
    if (!cfg || forzar) cfg = await req('/api/purchases/config');
    return cfg;
  }
  async function refrescarDatos() {
    try { const fresh = await api.getBootstrap(); if (fresh && typeof hydrateDB === 'function') hydrateDB(fresh); } catch (_) { /* se verá al recargar */ }
    for (const fn of ['loadProductsTable', 'loadInventoryTable', 'updateInventoryStats', 'renderSalesCatalog']) {
      try { if (typeof window[fn] === 'function') window[fn](); } catch (_) { /* pantalla no abierta */ }
    }
  }

  // ═══ Subir facturas (XML, Excel/CSV, fotos o PDF) ═══════════════════════
  function abrirSubida() {
    document.getElementById('modal-title').textContent = 'Subir facturas de proveedor';
    document.getElementById('modal-body').innerHTML = `
      <div class="cp-subida">
        <label class="cp-drop" id="cp-drop">
          <input type="file" id="cp-archivos" multiple accept=".xml,.csv,.txt,.xlsx,.xls,.jpg,.jpeg,.png,.pdf" hidden>
          <strong>Arrastra aquí las facturas o haz clic para elegirlas</strong>
          <span>XML del e-CF del proveedor · Excel o CSV (puede traer muchas facturas) · foto o PDF (por ahora se completa a mano)</span>
        </label>
        <p class="cp-nota">Cada factura queda como <b>borrador</b>: revisas proveedor, productos, precios e inventario y la registras cuando esté bien. Nada se registra solo.
          <button type="button" class="tc-btn tc-btn--soft cp-link" id="cp-plantilla">Descargar plantilla de Excel</button></p>
        <div class="cp-progreso hidden" id="cp-progreso"><div class="cp-progreso-barra"><i id="cp-progreso-i"></i></div><span id="cp-progreso-t"></span></div>
        <ul class="cp-archivos" id="cp-lista"></ul>
      </div>`;
    document.getElementById('modal-footer').innerHTML = `
      <button class="btn-secondary" type="button" onclick="closeAllModals()">Cerrar</button>
      <button class="btn-primary" type="button" id="cp-ver-borradores">Ver borradores</button>`;
    document.getElementById('modal-overlay').classList.remove('hidden');
    const input = document.getElementById('cp-archivos');
    const drop = document.getElementById('cp-drop');
    input.onchange = () => procesar([...input.files]);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('is-over'); };
    drop.ondragleave = () => drop.classList.remove('is-over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('is-over'); procesar([...(e.dataTransfer?.files || [])]); };
    document.getElementById('cp-plantilla').onclick = descargarPlantilla;
    document.getElementById('cp-ver-borradores').onclick = () => { closeAllModals(); if (typeof showComprasTab === 'function') showComprasTab('borradores'); };
  }

  const leerBase64 = (archivo) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || '').replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    r.readAsDataURL(archivo);
  });

  let procesando = false;
  async function procesar(archivos) {
    if (!archivos.length) return;
    if (procesando) { toast('Espera a que terminen los archivos que se están subiendo.', 'warning'); return; }
    procesando = true;
    const lista = document.getElementById('cp-lista');
    const barra = document.getElementById('cp-progreso');
    barra?.classList.remove('hidden');
    const filas = archivos.map((a) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="cp-archivo-nombre">${esc(a.name)}</span><span class="cp-archivo-estado">En espera</span>`;
      lista?.prepend(li);
      return li;
    });
    const borradores = [];
    let ok = 0, mal = 0;
    for (const [i, archivo] of archivos.entries()) {
      const li = filas[i];
      const estado = li.querySelector('.cp-archivo-estado');
      const progreso = () => {
        const t = document.getElementById('cp-progreso-t'); const b = document.getElementById('cp-progreso-i');
        if (t) t.textContent = `${i + 1} de ${archivos.length}`;
        if (b) b.style.width = `${Math.round(((i + 1) / archivos.length) * 100)}%`;
      };
      const intentar = async () => {
        estado.textContent = 'Leyendo…'; li.className = 'is-trabajando';
        try {
          if (archivo.size > 5 * 1024 * 1024) throw new Error('pasa de 5 MB');
          const contenido = await leerBase64(archivo);
          const r = await req('/api/purchases/import', json('POST', { nombre: archivo.name, contenido, ...estructura() }, { _timeoutMs: 180000 }));
          const n = r.borradores?.length || 0;
          const conError = (r.borradores || []).filter((b) => b.estado === 'requiere_revision').length;
          borradores.push(...(r.borradores || []));
          li.className = 'is-ok';
          estado.textContent = r.borradores?.[0]?.repetido ? 'Ya estaba en borradores'
            : `${n} borrador${n === 1 ? '' : 'es'}${conError ? ` · ${conError} por revisar` : ''}${r.errores?.length ? ` · ${r.errores.length} fila(s) con error` : ''}`;
          if (r.errores?.length) li.title = r.errores.map((e) => `Fila ${e.fila}: ${e.texto}`).join('\n');
          ok += 1;
        } catch (e) {
          mal += 1;
          li.className = 'is-error';
          estado.innerHTML = `${esc(e.message)} <button type="button" class="tc-btn tc-btn--soft cp-link">Reintentar</button>`;
          estado.querySelector('button').onclick = async () => { mal -= 1; await intentar(); };
        }
      };
      await intentar();
      progreso();
    }
    procesando = false;
    toast(`${ok} archivo(s) leído(s)${mal ? `, ${mal} con error` : ''}.`, mal ? 'warning' : 'success');
    actualizarContadores();
    // Una sola factura: directo a prepararla.
    if (archivos.length === 1 && borradores.length === 1 && !mal) {
      closeAllModals();
      abrir(borradores[0].id);
    }
  }

  async function descargarPlantilla() {
    try {
      const { filas } = await req('/api/purchases/plantilla');
      await window.VendorLoader.load('xlsx');
      const libro = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet(filas), 'Compras');
      XLSX.writeFile(libro, 'plantilla-compras-tecno-caja.xlsx');
    } catch (e) { toast(e.message || 'No se pudo crear la plantilla.', 'error'); }
  }

  // ═══ Borradores (pestaña) ═══════════════════════════════════════════════
  async function cargarBorradores() {
    const caja = document.getElementById('compras-borradores-list');
    if (!caja) return;
    caja.innerHTML = '<div class="loading-text">Cargando…</div>';
    try {
      const filas = await req('/api/purchases/drafts');
      actualizarContador('borradores', filas.length);
      if (!filas.length) {
        caja.innerHTML = '<div class="cp-vacio">No hay borradores. Usa <b>Subir factura de proveedor</b> o <b>Registrar compra manualmente</b>.</div>';
        return;
      }
      caja.innerHTML = `<table class="compact-table cp-tabla-lista"><thead><tr><th>Factura</th><th>Origen</th><th>Fecha</th><th>Líneas</th><th>Total</th><th>Estado</th><th></th></tr></thead><tbody>
        ${filas.map((b) => `<tr data-id="${esc(b.id)}">
          <td><strong>${esc(b.proveedor || 'Proveedor sin nombre')}</strong><small>${esc(b.ncf || '')}</small></td>
          <td>${esc(ORIGEN[b.origen] || b.origen)}</td><td>${esc(b.fecha || '—')}</td><td>${b.lineas}</td><td>${money(b.total)}</td>
          <td><span class="badge ${b.estado === 'requiere_revision' ? 'badge-warning' : 'badge-info'}">${b.estado === 'requiere_revision' ? 'Por revisar' : 'Borrador'}</span></td>
          <td class="cp-acciones"><button class="btn-xs btn-primary" type="button" data-accion="abrir">Preparar</button>
            <button class="btn-xs btn-secondary" type="button" data-accion="descartar">Descartar</button></td></tr>`).join('')}
        </tbody></table>`;
      caja.onclick = async (e) => {
        const boton = e.target.closest('[data-accion]');
        if (!boton) return;
        const id = boton.closest('tr').dataset.id;
        if (boton.dataset.accion === 'abrir') abrir(id);
        else if (confirm('¿Descartar este borrador? La compra no se registra y el borrador queda en el historial.')) {
          try { await req(`/api/purchases/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' }); toast('Borrador descartado.'); cargarBorradores(); }
          catch (err) { toast(err.message, 'error'); }
        }
      };
    } catch (e) { caja.innerHTML = `<div class="error-text">Error al cargar: ${esc(e.message)}</div>`; }
  }

  function actualizarContador(clave, n) {
    const badge = document.getElementById(`compras-badge-${clave}`);
    if (badge) { badge.textContent = n ? String(n) : ''; badge.classList.toggle('hidden', !n); }
  }
  async function actualizarContadores() {
    try { actualizarContador('borradores', (await req('/api/purchases/drafts')).length); } catch (_) { /* sin permiso */ }
    try { actualizarContador('recepciones', (await req('/api/purchases/receipts/pending')).length); } catch (_) { /* sin permiso */ }
  }

  // ═══ Preparar compra ═════════════════════════════════════════════════════
  let st = null; // { id, version, origen, documentos, payload, resumen, avisos, bloqueos, config, sucio, sel }
  let raiz = null;

  async function nuevaManual() {
    try {
      const b = await req('/api/purchases/drafts', json('POST', { ...estructura() }));
      await abrir(b.id);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function abrir(id) {
    try {
      await configuracion(true);
      const d = await req(`/api/purchases/drafts/${encodeURIComponent(id)}`);
      if (!['borrador', 'requiere_revision'].includes(d.estado)) { toast('Ese borrador ya no está pendiente.', 'warning'); return; }
      // Un borrador recién creado a mano (sin líneas) no muestra todavía lo que le falta.
      const vacio = !(d.payload?.lineas || []).length;
      st = { id: d.id, version: d.version, origen: d.origen, documentos: d.documentos || [], payload: d.payload || { encabezado: {}, lineas: [] },
        resumen: d.resumen, avisos: d.avisos || [], bloqueos: vacio ? [] : (d.bloqueos || []), config: d.config || cfg, sucio: false, sel: new Set(),
        disponibles: await comprobantesDisponibles(d.branchId) };
      st.payload.encabezado = st.payload.encabezado || {};
      st.payload.lineas = st.payload.lineas || [];
      const e = st.payload.encabezado;
      if (!e.modoComprobante) e.modoComprobante = !e.ncf && e.documentoOrigen !== 'xml_ecf' && (e.comprobanteNegocio || e.emitirE41) ? 'negocio' : 'proveedor';
      if (e.modoComprobante === 'negocio' && !e.comprobanteNegocio && e.emitirE41) e.comprobanteNegocio = 'E41';
      render();
    } catch (e) { toast(e.message, 'error'); }
  }

  // Comprobantes de compra que el negocio puede emitir ahora: solo los que tienen
  // secuencia disponible (Configuración → Comprobantes), electrónicos primero.
  async function comprobantesDisponibles(branchId) {
    try {
      const filas = await req(`/api/fiscal-sequences/available?uso=compras${branchId ? `&branchId=${encodeURIComponent(branchId)}` : ''}`);
      return (filas || []).map((f) => ({ tipo: String(f.documentType || '').toUpperCase(), siguiente: f.nextNumber ?? null }))
        .filter((f) => TIPOS_NEGOCIO[f.tipo])
        .sort((a, b) => Object.keys(TIPOS_NEGOCIO).indexOf(a.tipo) - Object.keys(TIPOS_NEGOCIO).indexOf(b.tipo));
    } catch (_) { return []; }
  }

  function quitarBuscadoresRnc() {
    document.querySelectorAll('.rnc-dropdown[data-cp]').forEach((d) => d.remove());
  }
  // RNC o cédula: busca en el registro de la DGII por número o por nombre y llena el proveedor.
  function conectarBuscadorRnc() {
    const input = raiz?.querySelector('[data-e="proveedor.rnc"]');
    if (!input || !window.RNCLookup) return;
    quitarBuscadoresRnc();
    RNCLookup.attach(input, {
      mode: 'both',
      onSelect: (data) => {
        const digitos = String(data.rnc || '').replace(/\D/g, '');
        const local = (DB.proveedores || []).find((p) => String(p.rnc || '').replace(/\D/g, '') === digitos);
        const nombre = local?.nombre || data.nombreComercial || data.nombre || '';
        const e = st.payload.encabezado;
        e.proveedor = { ...(e.proveedor || {}), rnc: digitos, nombre, id: local ? Number(local.id) : null, nuevo: !local };
        const campoNombre = raiz.querySelector('[data-e="proveedor.nombre"]');
        if (campoNombre) campoNombre.value = nombre;
        const titulo = raiz.querySelector('.cp-cabecera h2');
        if (titulo && titulo.firstChild) titulo.firstChild.textContent = `${nombre || 'Proveedor sin nombre'} `;
        raiz.querySelector('.cp-nuevo')?.classList.toggle('hidden', Boolean(local));
        marcarSucio();
      },
    });
    const lista = document.body.lastElementChild;
    if (lista?.classList.contains('rnc-dropdown')) lista.dataset.cp = '1';
  }

  function cerrar(forzar = false) {
    if (!forzar && st?.sucio && !confirm('Hay cambios sin guardar en el borrador. ¿Cerrar sin guardar?')) return;
    document.removeEventListener('keydown', teclas, true);
    quitarBuscadoresRnc();
    raiz?.remove(); raiz = null; st = null;
    if (typeof showComprasTab === 'function') showComprasTab(document.getElementById('module-compras')?.dataset.tab || 'borradores');
  }
  function teclas(e) {
    if (e.key === 'Escape' && raiz && !document.querySelector('#modal-overlay:not(.hidden), .tc-form-modal-fondo, .cp-buscador')) { e.preventDefault(); cerrar(); }
  }

  const tasa = () => Number(st?.config?.tasaItbis ?? cfg?.tasaItbis ?? 18);
  const puedeProductos = () => Boolean(st?.config?.puedeCambiarProductos ?? cfg?.puedeCambiarProductos);

  // Montos de una línea como el servidor: cantidad × costo − descuento; ITBIS por línea.
  function montos(l) {
    const M = Mon();
    try {
      const bruto = M.quantity(M.cents(Number(l.costoUnitario || 0).toFixed(2)), Number(l.cantidad || 0).toFixed(3));
      const sub = bruto - M.cents(Number(l.descuento || 0).toFixed(2));
      const itbis = Number(l.itbisPct) > 0 ? M.percent(sub, Number(l.itbisPct)) : 0n;
      return { sub, itbis };
    } catch (_) { return { sub: 0n, itbis: 0n }; }
  }
  function totales() {
    const M = Mon();
    let sub = 0n, itbis = 0n;
    for (const l of st.payload.lineas) { const m = montos(l); sub += m.sub; itbis += m.itbis; }
    const desc = M.cents(Number(st.payload.encabezado.descuento || 0).toFixed(2));
    return { sub: M.number(sub), desc: M.number(desc), itbis: M.number(itbis), total: M.number(sub - desc + itbis) };
  }
  function precioInfo(l) {
    if (!l.precio || !(Number(l.precio.valor) > 0)) return null;
    try {
      const calc = P().precioVenta({ modo: l.precio.modo || st.config?.precioModo || 'base', precio: l.precio.valor, tasa: tasa() });
      return { ...calc, ganancia: P().ganancia({ costo: l.costoUnitario, base: calc.base }) };
    } catch (_) { return null; }
  }

  function render() {
    if (!raiz) {
      raiz = document.createElement('section');
      raiz.id = 'cp-preparar';
      raiz.className = 'cp-pantalla';
      raiz.setAttribute('role', 'dialog');
      raiz.setAttribute('aria-modal', 'true');
      raiz.setAttribute('aria-label', 'Preparar compra');
      document.body.append(raiz);
      document.addEventListener('keydown', teclas, true);
      raiz.addEventListener('input', alEscribir);
      raiz.addEventListener('change', alCambiar);
      raiz.addEventListener('click', alClic);
    }
    const e = st.payload.encabezado;
    const prov = e.proveedor || {};
    const proveedores = (DB.proveedores || []).filter((p) => p.estado !== 'Inactivo');
    const desdeXml = e.documentoOrigen === 'xml_ecf';
    const modo = desdeXml ? 'proveedor' : (e.modoComprobante || 'proveedor');
    const disponibles = st.disponibles || [];
    const negocioSel = String(e.comprobanteNegocio || '').toUpperCase();
    const ayudaNegocio = negocioSel === 'E41' ? 'Se firma y se envía a la DGII al registrar la compra.'
      : negocioSel === 'B11' ? 'Se le asigna el siguiente número B11 al registrar la compra.'
        : 'Sin comprobante fiscal: la compra queda solo como registro interno (no da crédito de ITBIS).';
    const bloqueComprobante = modo === 'proveedor'
      ? `<label class="cp-campo">NCF o e-NCF del proveedor<input class="tc-input" data-e="ncf" value="${esc(e.ncf || '')}" maxlength="19" placeholder="E310000000001 o B0100000001" ${desdeXml ? 'readonly' : ''}>
           <small class="cp-tipo-ncf" id="cp-tipo-ncf">${esc(tipoDeNcf(e.ncf))}</small></label>
         <label class="cp-campo">Nº de factura<input class="tc-input" data-e="numeroDocumento" value="${esc(e.numeroDocumento || '')}"></label>`
      : `<label class="cp-campo cp-ancho2">Comprobante de compra que emite el negocio
           <select class="tc-select" data-e="comprobanteNegocio">
             ${disponibles.map((d) => `<option value="${d.tipo}" ${negocioSel === d.tipo ? 'selected' : ''}>${d.tipo} · ${esc(TIPOS_NEGOCIO[d.tipo])}${d.siguiente ? ` (siguiente nº ${d.siguiente})` : ''}</option>`).join('')}
             <option value="" ${!negocioSel ? 'selected' : ''}>Sin comprobante fiscal (solo registro interno)</option>
           </select>
           <small id="cp-ayuda-negocio">${esc(ayudaNegocio)}${disponibles.length ? '' : ' No hay secuencias E41 ni B11 disponibles: agrégalas en Configuración → Comprobantes.'}</small></label>
         <label class="cp-campo">Nº de factura o recibo (opcional)<input class="tc-input" data-e="numeroDocumento" value="${esc(e.numeroDocumento || '')}"></label>`;
    raiz.innerHTML = `
      <header class="cp-cabecera">
        <div><span class="cp-etiqueta">PREPARAR COMPRA · ${esc(ORIGEN[st.origen] || st.origen)}</span>
          <h2>${esc(prov.nombre || 'Proveedor sin nombre')}${e.ncf ? ` <small>${esc(e.ncf)}</small>` : ''}</h2></div>
        <div class="cp-cabecera-acciones">
          ${st.documentos.length ? '<button type="button" class="tc-btn tc-btn--soft" data-accion="documento">Ver documento</button>' : ''}
          <button type="button" class="tc-btn" data-accion="cerrar" title="Cerrar (Esc)">Cerrar</button>
        </div>
      </header>
      <div class="cp-cuerpo">
        <section class="cp-panel cp-encabezado">
          <label class="cp-campo cp-ancho2">Proveedor
            <input class="tc-input" data-e="proveedor.nombre" list="cp-proveedores" value="${esc(prov.nombre || '')}" placeholder="Nombre del proveedor" autocomplete="off">
            <datalist id="cp-proveedores">${proveedores.map((p) => `<option value="${esc(p.nombre)}">${esc(p.rnc || '')}</option>`).join('')}</datalist>
            <small class="cp-nuevo ${prov.nuevo && prov.nombre ? '' : 'hidden'}">Proveedor nuevo: se crea al registrar</small></label>
          <label class="cp-campo cp-ancho2 cp-rnc">RNC o cédula<input class="tc-input" data-e="proveedor.rnc" value="${esc(prov.rnc || '')}" autocomplete="off" placeholder="Número o nombre para buscar en la DGII"></label>
          <div class="cp-ancho4 cp-comprobante">
            <div class="cp-segmento" role="radiogroup" aria-label="Comprobante de la compra">
              <button type="button" role="radio" data-modo="proveedor" aria-checked="${modo === 'proveedor'}" class="${modo === 'proveedor' ? 'is-on' : ''}">El proveedor me dio comprobante (NCF o e-NCF)</button>
              <button type="button" role="radio" data-modo="negocio" aria-checked="${modo === 'negocio'}" class="${modo === 'negocio' ? 'is-on' : ''}" ${desdeXml ? 'disabled' : ''}>El proveedor no da comprobante</button>
            </div>
          </div>
          ${bloqueComprobante}
          <label class="cp-campo">Fecha<input class="tc-input" type="date" data-e="fechaComprobante" value="${esc(e.fechaComprobante || '')}"></label>
          <label class="cp-campo">Pago<select class="tc-select" data-e="condicionPago"><option value="contado" ${e.condicionPago !== 'credito' ? 'selected' : ''}>Contado</option><option value="credito" ${e.condicionPago === 'credito' ? 'selected' : ''}>Crédito</option></select></label>
          <label class="cp-campo ${e.condicionPago === 'credito' ? '' : 'hidden'}" id="cp-vence">Vence<input class="tc-input" type="date" data-e="fechaVencimiento" value="${esc(e.fechaVencimiento || '')}"></label>
          <label class="cp-campo cp-ancho2">Notas<input class="tc-input" data-e="notas" value="${esc(e.notas || '')}" maxlength="255"></label>
          <details class="cp-ancho4 cp-fiscal"><summary>Datos para el Formato 606 (opcional)</summary>
            <div class="cp-fiscal-grid">
              <label class="cp-campo">Tipo de bienes/servicios<select class="tc-select" data-e="tipoBienesServicios">${[[9, '9 · Costo de venta'], [1, '1 · Gastos de personal'], [2, '2 · Trabajos, suministros y servicios'], [3, '3 · Arrendamientos'], [4, '4 · Activos fijos'], [5, '5 · Representación'], [6, '6 · Otras deducciones'], [7, '7 · Gastos financieros'], [8, '8 · Extraordinarios'], [10, '10 · Adquisición de activos'], [11, '11 · Seguros']].map(([v, t]) => `<option value="${v}" ${Number(e.tipoBienesServicios || 9) === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
              <label class="cp-campo">ITBIS retenido<input class="tc-input" type="number" min="0" step="0.01" data-e="itbisRetenido" value="${esc(e.itbisRetenido ?? e.totalesDocumento?.itbisRetenido ?? '')}"></label>
              <label class="cp-campo">ISR retenido<input class="tc-input" type="number" min="0" step="0.01" data-e="isrMontoRetencion" value="${esc(e.isrMontoRetencion ?? e.totalesDocumento?.isrRetenido ?? '')}"></label>
            </div></details>
        </section>
        <section class="cp-panel cp-avisos" id="cp-avisos">${htmlAvisos()}</section>
        <section class="cp-panel cp-lineas">
          <div class="cp-lineas-barra">
            <strong>Productos y servicios</strong>
            <span class="cp-masivo ${st.sel.size ? '' : 'is-oculto'}" id="cp-masivo">
              <span>${st.sel.size} seleccionada(s):</span>
              <select class="tc-select" data-masivo="modo"><option value="">Modo de precio…</option>${Object.entries(P().MODOS).map(([k, t]) => `<option value="${k}">${esc(t)}</option>`).join('')}</select>
              <button type="button" class="tc-btn tc-btn--soft" data-masivo="inv-si">Inventario: Sí</button>
              <button type="button" class="tc-btn tc-btn--soft" data-masivo="inv-no">Inventario: No</button>
              <input class="tc-input cp-margen" type="number" min="0" step="0.1" placeholder="Margen %" id="cp-margen-masivo">
              <button type="button" class="tc-btn tc-btn--soft" data-masivo="margen" title="Precio = costo + margen ${esc(st.config?.tipoMargen === 'venta' ? 'sobre la venta' : 'sobre el costo')}">Aplicar margen</button>
              <button type="button" class="tc-btn tc-btn--danger" data-masivo="quitar">Quitar</button>
            </span>
            <span class="cp-agregar">
              <button type="button" class="tc-btn tc-btn--soft" data-accion="agregar-existente">+ Producto existente</button>
              <button type="button" class="tc-btn tc-btn--soft" data-accion="agregar-nuevo">+ Producto nuevo</button>
              <button type="button" class="tc-btn tc-btn--soft" data-accion="agregar-servicio">+ Servicio o gasto</button>
            </span>
          </div>
          <div class="cp-tabla-scroll"><table class="cp-tabla">
            <thead><tr><th><input type="checkbox" data-accion="sel-todas" aria-label="Seleccionar todas" ${st.sel.size && st.sel.size === st.payload.lineas.length ? 'checked' : ''}></th>
              <th>Producto o servicio</th><th>Tipo</th><th>Cant.</th><th>Costo unit.</th><th>Desc.</th><th>ITBIS %</th><th>Subtotal</th>
              <th>Precio de venta</th><th>Inventario</th><th></th></tr></thead>
            <tbody>${st.payload.lineas.map(htmlLinea).join('') || '<tr><td colspan="11" class="cp-vacio">Agrega los productos o servicios de la factura.</td></tr>'}</tbody>
          </table></div>
        </section>
      </div>
      <footer class="cp-pie">
        <div class="cp-totales" id="cp-totales">${htmlTotales()}</div>
        <div class="cp-pie-botones">
          <button type="button" class="tc-btn tc-btn--danger" data-accion="descartar">Descartar borrador</button>
          <button type="button" class="tc-btn" data-accion="guardar">Guardar borrador</button>
          <button type="button" class="tc-btn tc-btn--primary" data-accion="registrar" id="cp-registrar">Confirmar y registrar compra</button>
        </div>
      </footer>`;
    sincronizarBotonRegistrar();
    conectarBuscadorRnc();
  }

  function htmlAvisos() {
    const items = [
      ...(st.sucio ? [{ tipo: 'info', texto: 'Hay cambios sin revisar: «Guardar borrador» los revisa (también se revisan al registrar).' }] : []),
      ...st.bloqueos.map((t) => ({ tipo: 'error', texto: t })),
      ...st.avisos.map((a) => ({ tipo: 'aviso', texto: a.texto || a })),
    ];
    const listo = !st.sucio && !st.bloqueos.length ? '<p class="cp-ok">Lista para registrar.</p>' : '';
    if (!items.length) return listo;
    return `${listo}<ul>${items.map((a) => `<li class="cp-aviso-${a.tipo}">${esc(a.texto)}</li>`).join('')}</ul>`;
  }

  function htmlTotales() {
    const t = totales();
    const doc = st.payload.encabezado.totalesDocumento;
    const dif = doc && Number(doc.total) > 0 ? Number((t.total - Number(doc.total)).toFixed(2)) : null;
    return `
      <span>Subtotal <b>${money(t.sub)}</b></span>
      <label>Descuento general <input class="tc-input cp-num" type="number" min="0" step="0.01" data-e="descuento" value="${esc(st.payload.encabezado.descuento || '')}" placeholder="0.00"></label>
      <span>ITBIS <b>${money(t.itbis)}</b></span>
      <span class="cp-total">Total <b>${money(t.total)}</b></span>
      ${dif !== null ? `<span class="${Math.abs(dif) > 1 ? 'cp-dif-mal' : 'cp-dif-ok'}">Factura ${money(doc.total)}${dif ? ` · diferencia ${money(dif)}` : ' · cuadra'}</span>` : ''}`;
  }

  function htmlProducto(l, i) {
    if (l.tipoLinea === 'servicio_gasto') {
      return `<input class="tc-input" data-l="descripcion" value="${esc(l.descripcion || '')}" placeholder="Descripción del servicio o gasto"><span class="cp-badge cp-badge-servicio">Servicio o gasto</span>`;
    }
    const cambiar = `<button type="button" class="cp-mini" data-accion="cambiar" data-i="${i}">Cambiar</button>`;
    const original = l.descripcion && l.producto && l.producto.nombre !== l.descripcion ? `<small class="cp-original">En la factura: ${esc(l.descripcion)}</small>` : '';
    if (l.accion === 'existente' && l.producto) {
      const metodo = { codigo_barras: 'por código de barras', codigo: 'por código', equivalencia: 'como la última vez', nombre_exacto: 'por nombre', elegido: 'elegido' }[l.metodo] || '';
      return `<span class="cp-producto"><b>${esc(l.producto.nombre)}</b> <small>${esc(l.producto.codigo || '')}</small></span>
        <span class="cp-badge cp-badge-existe" title="${esc(metodo)}">Existente${metodo ? ` · ${esc(metodo)}` : ''}</span>${cambiar}${original}`;
    }
    if (l.accion === 'elegir') {
      return `<select class="tc-select" data-l="elegir"><option value="">Elige el producto (hay parecidos)…</option>
        ${(l.sugerencias || []).map((s) => `<option value="${s.id}">${esc(s.nombre)} · ${esc(s.codigo || '')} (${Math.round(s.puntaje * 100)} %)</option>`).join('')}
        <option value="nuevo">Es otro: crear producto nuevo</option></select>
        <span class="cp-badge cp-badge-elegir">Elegir</span><small class="cp-original">En la factura: ${esc(l.descripcion || '')}</small>`;
    }
    return `<input class="tc-input" data-l="descripcion" value="${esc(l.descripcion || '')}" placeholder="Nombre del producto nuevo">
      <span class="cp-badge cp-badge-nuevo">Nuevo</span>${cambiar}`;
  }

  function htmlPrecio(l) {
    if (l.tipoLinea === 'servicio_gasto') return '<span class="cp-tenue">—</span>';
    const existe = l.accion === 'existente' && l.producto;
    const bloqueado = existe && !puedeProductos();
    const valor = l.precio && Number(l.precio.valor) > 0 ? l.precio.valor : '';
    const modo = l.precio?.modo || st.config?.precioModo || 'base';
    const info = precioInfo(l);
    const actual = existe ? `Precio actual ${money(l.producto.precioVenta)}${l.producto.aplicaItbis ? ' + ITBIS' : ''}. Deja vacío para no cambiarlo` : 'Escribe el precio para poder venderlo';
    return `<div class="cp-precio">
      <input class="tc-input cp-num" type="number" min="0" step="0.01" data-l="precio" value="${esc(valor)}" placeholder="${existe ? 'Sin cambio' : '0.00'}" ${bloqueado ? 'disabled title="Cambiar precios requiere el permiso de Productos"' : ''}>
      <select class="tc-select" data-l="modo" ${bloqueado ? 'disabled' : ''}>${Object.entries(P().MODOS).map(([k, t]) => `<option value="${k}" ${modo === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <small class="cp-precio-info">${info ? `Cliente paga <b>${money(info.final)}</b> (base ${money(info.base)}${info.itbis ? ` + ITBIS ${money(info.itbis)}` : ''}) · ganancia ${money(info.ganancia.ganancia)}${info.ganancia.margenVenta !== null ? ` (${info.ganancia.margenVenta} %)` : ''}${info.exacto ? '' : ' · <em>más cercano posible</em>'}${l.precio?.sugerido ? ' · sugerido por el margen' : ''}` : esc(actual)}</small>
    </div>`;
  }

  function htmlLinea(l, i) {
    const m = montos(l);
    const servicio = l.tipoLinea === 'servicio_gasto';
    const inventario = !servicio && l.controlaInventario !== false;
    const bloqueaInv = l.accion === 'existente' && !puedeProductos();
    return `<tr data-i="${i}" class="${(l.avisos || []).length ? 'cp-con-aviso' : ''}">
      <td><input type="checkbox" data-l="sel" ${st.sel.has(i) ? 'checked' : ''} aria-label="Seleccionar línea ${i + 1}"></td>
      <td class="cp-col-producto">${htmlProducto(l, i)}${(l.avisos || []).map((a) => `<small class="cp-linea-aviso">${esc(a)}</small>`).join('')}</td>
      <td><select class="tc-select" data-l="tipo">${(servicio ? ['servicio_gasto', 'producto'] : ['producto', 'servicio_gasto']).map((k) => `<option value="${k}" ${(k === 'servicio_gasto') === servicio ? 'selected' : ''}>${k === 'producto' ? 'Producto' : 'Servicio o gasto'}</option>`).join('')}</select></td>
      <td><input class="tc-input cp-num" type="number" min="0" step="any" data-l="cantidad" value="${esc(l.cantidad ?? '')}"></td>
      <td><input class="tc-input cp-num" type="number" min="0" step="0.01" data-l="costoUnitario" value="${esc(l.costoUnitario ?? '')}"></td>
      <td><input class="tc-input cp-num" type="number" min="0" step="0.01" data-l="descuento" value="${esc(l.descuento || '')}" placeholder="0"></td>
      <td><input class="tc-input cp-num cp-pct" type="number" min="0" max="100" step="0.01" data-l="itbisPct" value="${esc(l.itbisPct ?? '')}"></td>
      <td class="cp-subtotal" data-sub="${i}">${money(Mon().number(m.sub))}</td>
      <td class="cp-col-precio" data-precio="${i}">${htmlPrecio(l)}</td>
      <td><label class="cp-switch" title="${servicio ? 'Un servicio o gasto no lleva inventario' : (bloqueaInv ? 'Cambiar el control de inventario requiere el permiso de Productos' : 'Controlar existencias de este producto')}">
        <input type="checkbox" data-l="inventario" ${inventario ? 'checked' : ''} ${servicio || bloqueaInv ? 'disabled' : ''}><span>${inventario ? 'Sí' : 'No'}</span></label></td>
      <td><button type="button" class="cp-mini cp-quitar" data-accion="quitar" data-i="${i}" aria-label="Quitar línea">✕</button></td>
    </tr>`;
  }

  function marcarSucio() {
    if (!st) return;
    if (!st.sucio) { st.sucio = true; const a = document.getElementById('cp-avisos'); if (a) a.innerHTML = htmlAvisos(); }
    sincronizarBotonRegistrar();
  }
  function sincronizarBotonRegistrar() {
    const b = document.getElementById('cp-registrar');
    if (!b) return;
    const bloqueado = !st.sucio && st.bloqueos.length > 0;
    b.disabled = bloqueado || !st.payload.lineas.length;
    b.title = bloqueado ? st.bloqueos[0] : '';
  }
  function setEnc(ruta, valor) {
    const e = st.payload.encabezado;
    if (ruta.startsWith('proveedor.')) {
      e.proveedor = { ...(e.proveedor || {}) };
      const campo = ruta.split('.')[1];
      e.proveedor[campo] = valor;
      if (campo === 'nombre') {
        const p = (DB.proveedores || []).find((x) => String(x.nombre).toLowerCase() === String(valor).trim().toLowerCase());
        e.proveedor.id = p ? Number(p.id) : null;
        e.proveedor.nuevo = !p;
        if (p && p.rnc) { e.proveedor.rnc = p.rnc; const r = raiz.querySelector('[data-e="proveedor.rnc"]'); if (r) r.value = p.rnc; }
      } else {
        // El RNC manda: si ya es un suplidor del negocio, se toma ese.
        const digitos = String(valor || '').replace(/\D/g, '');
        const p = digitos.length >= 9 ? (DB.proveedores || []).find((x) => String(x.rnc || '').replace(/\D/g, '') === digitos) : null;
        e.proveedor.id = p ? Number(p.id) : null;
        e.proveedor.nuevo = false;
        if (p) {
          e.proveedor.nombre = p.nombre;
          const n = raiz.querySelector('[data-e="proveedor.nombre"]'); if (n) n.value = p.nombre;
        }
      }
      const aviso = raiz.querySelector('.cp-nuevo');
      if (aviso) aviso.classList.toggle('hidden', !e.proveedor.nuevo);
      return;
    }
    e[ruta] = valor;
  }

  function alEscribir(ev) {
    const t = ev.target;
    if (t.dataset.e && t.type !== 'checkbox') {
      setEnc(t.dataset.e, t.type === 'number' ? (t.value === '' ? '' : Number(t.value)) : t.value);
      marcarSucio();
      if (t.dataset.e === 'descuento') refrescarTotales();
      if (t.dataset.e === 'ncf') { const chip = document.getElementById('cp-tipo-ncf'); if (chip) chip.textContent = tipoDeNcf(t.value); }
      return;
    }
    const fila = t.closest('tr[data-i]');
    if (!fila || !t.dataset.l) return;
    const i = Number(fila.dataset.i);
    const l = st.payload.lineas[i];
    const campo = t.dataset.l;
    if (['cantidad', 'costoUnitario', 'descuento', 'itbisPct'].includes(campo)) {
      l[campo] = t.value === '' ? '' : Number(t.value);
      const celda = raiz.querySelector(`[data-sub="${i}"]`);
      if (celda) celda.textContent = money(Mon().number(montos(l).sub));
      if (campo === 'costoUnitario') refrescarPrecio(i);
      refrescarTotales();
    } else if (campo === 'descripcion') {
      l.descripcion = t.value;
    } else if (campo === 'precio') {
      l.precio = { ...(l.precio || {}), valor: t.value === '' ? '' : Number(t.value), modo: l.precio?.modo || st.config?.precioModo || 'base', sugerido: false };
      refrescarPrecio(i, false);
    }
    marcarSucio();
  }

  function alCambiar(ev) {
    const t = ev.target;
    if (t.dataset.e) {
      if (t.type === 'checkbox') setEnc(t.dataset.e, t.checked);
      else setEnc(t.dataset.e, t.dataset.e === 'tipoBienesServicios' ? Number(t.value) : t.value);
      if (t.dataset.e === 'condicionPago') document.getElementById('cp-vence')?.classList.toggle('hidden', t.value !== 'credito');
      marcarSucio();
      if (t.dataset.e === 'comprobanteNegocio') render();
      return;
    }
    if (t.dataset.masivo === 'modo' && t.value) { masivo('modo', t.value); t.value = ''; return; }
    const fila = t.closest('tr[data-i]');
    if (!fila || !t.dataset.l) return;
    const i = Number(fila.dataset.i);
    const l = st.payload.lineas[i];
    switch (t.dataset.l) {
      case 'sel': if (t.checked) st.sel.add(i); else st.sel.delete(i); actualizarMasivo(); return;
      case 'modo':
        if (t.value === 'exento' && !confirmarExento(l)) { t.value = l.precio?.modo || 'base'; return; }
        l.precio = { ...(l.precio || {}), modo: t.value, exentoConfirmado: t.value === 'exento' ? true : l.precio?.exentoConfirmado, sugerido: false };
        refrescarPrecio(i, false);
        break;
      case 'inventario': l.controlaInventario = t.checked; t.nextElementSibling.textContent = t.checked ? 'Sí' : 'No'; break;
      case 'tipo':
        if (t.value === 'servicio_gasto') { l.tipoLinea = 'servicio_gasto'; l.productoId = null; l.accion = 'sin_producto'; l.producto = null; }
        else { l.tipoLinea = null; l.accion = 'nuevo'; l.decision = 'usuario'; }
        render();
        break;
      case 'elegir':
        if (t.value === 'nuevo') { l.accion = 'nuevo'; l.decision = 'usuario'; l.productoId = null; }
        else if (t.value) elegirProducto(i, Number(t.value));
        render();
        break;
      default: break;
    }
    marcarSucio();
  }

  function confirmarExento(l) {
    return confirm(`¿«${l.producto?.nombre || l.descripcion || 'Este producto'}» está exento de ITBIS según la ley (Ley 253-12 / Código Tributario)?\n\nNo uses «exento» solo para bajar el precio: queda registrado en la auditoría.`);
  }

  function elegirProducto(i, id) {
    const l = st.payload.lineas[i];
    const p = (DB.productos || []).find((x) => Number(x.id) === Number(id));
    l.productoId = Number(id); l.accion = 'existente'; l.metodo = 'elegido'; l.decision = 'usuario';
    if (p) {
      l.producto = { id: Number(p.id), codigo: p.codigo, nombre: p.nombre, precioVenta: Number(p.precioVenta ?? p.precio ?? 0), aplicaItbis: Boolean(p.aplicaItbis), tracksStock: p.tracksStock !== false, estado: p.estado };
      l.controlaInventario = p.tracksStock !== false;
    }
  }

  function refrescarPrecio(i) {
    const celda = raiz.querySelector(`[data-precio="${i}"]`);
    if (!celda) return;
    // Con precio escrito ya no aplica el aviso de «sin precio» de la última revisión.
    if (Number(st.payload.lineas[i]?.precio?.valor) > 0) {
      raiz.querySelectorAll(`tr[data-i="${i}"] .cp-linea-aviso`).forEach((a) => { if (/^Sin precio de venta/.test(a.textContent)) a.remove(); });
    }
    const info = celda.querySelector('.cp-precio-info');
    const tmp = document.createElement('div');
    tmp.innerHTML = htmlPrecio(st.payload.lineas[i]);
    const nuevo = tmp.querySelector('.cp-precio-info');
    if (info && nuevo) info.innerHTML = nuevo.innerHTML;
  }
  function refrescarTotales() {
    const t = document.getElementById('cp-totales');
    if (!t) return;
    const foco = document.activeElement?.dataset?.e === 'descuento';
    const pos = foco ? document.activeElement.selectionStart : null;
    t.innerHTML = htmlTotales();
    if (foco) { const d = t.querySelector('[data-e="descuento"]'); d.focus(); try { d.setSelectionRange(pos, pos); } catch (_) { /* number */ } }
  }
  function actualizarMasivo() {
    const barra = document.getElementById('cp-masivo');
    if (!barra) return;
    barra.classList.toggle('is-oculto', !st.sel.size);
    const texto = barra.querySelector('span');
    if (texto) texto.textContent = `${st.sel.size} seleccionada(s):`;
  }

  function masivo(accion, valor) {
    const lineas = [...st.sel].map((i) => st.payload.lineas[i]).filter(Boolean);
    if (!lineas.length) return;
    const productos = lineas.filter((l) => l.tipoLinea !== 'servicio_gasto');
    if (accion === 'modo') {
      if (valor === 'exento' && !confirm(`¿Los ${productos.length} producto(s) seleccionados están exentos de ITBIS según la ley? Queda registrado en la auditoría.`)) return;
      for (const l of productos) l.precio = { ...(l.precio || {}), modo: valor, exentoConfirmado: valor === 'exento' || l.precio?.exentoConfirmado, sugerido: false };
    } else if (accion === 'inv-si' || accion === 'inv-no') {
      for (const l of productos) l.controlaInventario = accion === 'inv-si';
    } else if (accion === 'margen') {
      const margen = Number(document.getElementById('cp-margen-masivo')?.value);
      if (!(margen >= 0)) { toast('Escribe el margen en %.', 'warning'); return; }
      try {
        for (const l of productos) {
          const modo = l.precio?.modo && l.precio.modo !== 'exento' ? l.precio.modo : (st.config?.precioModo || 'base');
          const valorPrecio = P().precioDesdeMargen({ costo: l.costoUnitario, margen, tipo: st.config?.tipoMargen || 'costo', modo, tasa: tasa() });
          l.precio = { ...(l.precio || {}), modo, valor: valorPrecio, sugerido: false };
        }
      } catch (e) { toast(e.message, 'error'); return; }
    } else if (accion === 'quitar') {
      if (!confirm(`¿Quitar ${lineas.length} línea(s) de la compra?`)) return;
      st.payload.lineas = st.payload.lineas.filter((_, i) => !st.sel.has(i));
      st.sel.clear();
    }
    marcarSucio();
    render();
  }

  async function alClic(ev) {
    const masivoBtn = ev.target.closest('[data-masivo]');
    if (masivoBtn && masivoBtn.tagName === 'BUTTON') { masivo(masivoBtn.dataset.masivo); return; }
    // ¿Quién da el comprobante? El proveedor (su NCF) o el negocio (E41/B11 con secuencia).
    const modoBtn = ev.target.closest('[data-modo]');
    if (modoBtn && !modoBtn.disabled) {
      const e = st.payload.encabezado;
      if (e.modoComprobante === modoBtn.dataset.modo) return;
      e.modoComprobante = modoBtn.dataset.modo;
      if (e.modoComprobante === 'negocio') {
        e.ncf = ''; e.tipoComprobante = '';
        e.comprobanteNegocio = st.disponibles?.[0]?.tipo || '';
      } else {
        e.comprobanteNegocio = ''; e.emitirE41 = false;
      }
      marcarSucio();
      render();
      return;
    }
    const b = ev.target.closest('[data-accion]');
    if (!b) return;
    const accion = b.dataset.accion;
    if (accion === 'sel-todas') {
      st.sel = b.checked ? new Set(st.payload.lineas.map((_, i) => i)) : new Set();
      raiz.querySelectorAll('[data-l="sel"]').forEach((c) => { c.checked = b.checked; });
      actualizarMasivo();
      return;
    }
    switch (accion) {
      case 'cerrar': cerrar(); break;
      case 'documento': verDocumento(); break;
      case 'quitar': st.payload.lineas.splice(Number(b.dataset.i), 1); st.sel.clear(); marcarSucio(); render(); break;
      case 'agregar-nuevo': st.payload.lineas.push({ accion: 'nuevo', decision: 'usuario', descripcion: '', cantidad: 1, costoUnitario: 0, itbisPct: tasa(), controlaInventario: true }); marcarSucio(); render(); enfocarUltima(); break;
      case 'agregar-servicio': st.payload.lineas.push({ tipoLinea: 'servicio_gasto', accion: 'sin_producto', descripcion: '', cantidad: 1, costoUnitario: 0, itbisPct: tasa() }); marcarSucio(); render(); enfocarUltima(); break;
      case 'agregar-existente': buscarProducto(null); break;
      case 'cambiar': buscarProducto(Number(b.dataset.i)); break;
      case 'guardar': await guardar(); break;
      case 'descartar': await descartar(); break;
      case 'registrar': await registrar(); break;
      default: break;
    }
  }
  function enfocarUltima() {
    const filas = raiz.querySelectorAll('tbody tr[data-i]');
    filas[filas.length - 1]?.querySelector('[data-l="descripcion"]')?.focus();
  }

  // Buscador de productos del catálogo (para cambiar la línea o agregar uno existente).
  function buscarProducto(indice) {
    document.querySelector('.cp-buscador')?.remove();
    const caja = document.createElement('div');
    caja.className = 'cp-buscador';
    caja.innerHTML = `<div class="cp-buscador-caja" role="dialog" aria-label="Buscar producto">
      <input class="tc-input" placeholder="Buscar por nombre, código o código de barras…" autocomplete="off">
      <ul></ul>
      <div class="cp-buscador-pie">${indice !== null ? '<button type="button" class="tc-btn tc-btn--soft" data-b="nuevo">Es un producto nuevo</button><button type="button" class="tc-btn tc-btn--soft" data-b="servicio">Es servicio o gasto</button>' : ''}<button type="button" class="tc-btn" data-b="cerrar">Cerrar</button></div></div>`;
    document.body.append(caja);
    const input = caja.querySelector('input');
    const lista = caja.querySelector('ul');
    const cerrarB = () => caja.remove();
    const pintar = () => {
      const q = input.value.trim().toLowerCase();
      const res = (DB.productos || []).filter((p) => !['combo'].includes(p.tipoProducto) && String(p.estado || '').toLowerCase() !== 'eliminado'
        && (!q || String(p.nombre || '').toLowerCase().includes(q) || String(p.codigo || '').toLowerCase() === q || String(p.codigoBarras || p.barcode || '').toLowerCase() === q
          || String(p.codigo || '').toLowerCase().includes(q))).slice(0, 12);
      lista.innerHTML = res.map((p) => `<li><button type="button" data-id="${p.id}"><b>${esc(p.nombre)}</b> <small>${esc(p.codigo || '')} · ${money(p.precioVenta ?? p.precio ?? 0)}</small></button></li>`).join('')
        || '<li class="cp-tenue">Sin resultados.</li>';
    };
    input.oninput = pintar;
    caja.onclick = (e) => {
      if (e.target === caja) { cerrarB(); return; }
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.b === 'cerrar') { cerrarB(); return; }
      if (btn.dataset.b === 'nuevo') { Object.assign(st.payload.lineas[indice], { accion: 'nuevo', decision: 'usuario', productoId: null, producto: null }); }
      else if (btn.dataset.b === 'servicio') { Object.assign(st.payload.lineas[indice], { tipoLinea: 'servicio_gasto', accion: 'sin_producto', productoId: null, producto: null }); }
      else if (btn.dataset.id) {
        if (indice === null) {
          const p = (DB.productos || []).find((x) => Number(x.id) === Number(btn.dataset.id));
          st.payload.lineas.push({ cantidad: 1, costoUnitario: Number(p?.precioCompra ?? p?.costo ?? 0), itbisPct: p?.aplicaItbis === false ? 0 : tasa(), descripcion: p?.nombre || '' });
          elegirProducto(st.payload.lineas.length - 1, Number(btn.dataset.id));
        } else elegirProducto(indice, Number(btn.dataset.id));
      } else return;
      cerrarB(); marcarSucio(); render();
    };
    input.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); cerrarB(); } };
    pintar(); input.focus();
  }

  async function verDocumento() {
    const d = st.documentos[0];
    if (!d) return;
    try {
      const doc = await req(`/api/purchases/documents/${encodeURIComponent(d.id)}`);
      const w = window.open('', '_blank', 'width=900,height=1000');
      if (!w) { toast('Permite ventanas emergentes para ver el documento.', 'warning'); return; }
      const datos = `data:${doc.tipo};base64,${doc.contenido}`;
      if (/^image\//.test(doc.tipo)) w.document.write(`<title>${esc(doc.nombre)}</title><img src="${datos}" style="max-width:100%">`);
      else if (doc.tipo === 'application/pdf') w.document.write(`<title>${esc(doc.nombre)}</title><iframe src="${datos}" style="border:0;width:100%;height:98vh"></iframe>`);
      else w.document.write(`<title>${esc(doc.nombre)}</title><pre style="white-space:pre-wrap;font:12px monospace">${esc(atob(doc.contenido))}</pre>`);
      w.document.close();
    } catch (e) { toast(e.message, 'error'); }
  }

  // El servidor revisa todo (proveedor, productos, duplicados, totales) al guardar.
  function payloadParaGuardar() {
    return { ...st.payload, lineas: st.payload.lineas.map((l) => ({ ...l, avisos: undefined, subtotal: undefined, itbis: undefined })) };
  }
  async function guardar({ silencioso = false } = {}) {
    try {
      const r = await req(`/api/purchases/drafts/${encodeURIComponent(st.id)}`, json('PUT', { version: st.version, payload: payloadParaGuardar() }));
      Object.assign(st, { version: r.version, payload: r.payload, resumen: r.resumen, avisos: r.avisos || [], bloqueos: r.bloqueos || [], config: { ...st.config, ...(r.config || {}) }, sucio: false });
      st.sel.clear();
      render();
      if (!silencioso) toast(st.bloqueos.length ? 'Borrador guardado: revisa lo que falta.' : 'Borrador guardado y revisado.', st.bloqueos.length ? 'warning' : 'success');
      return true;
    } catch (e) { toast(e.message, 'error'); return false; }
  }
  async function descartar() {
    if (!confirm('¿Descartar este borrador? La compra no se registra.')) return;
    try { await req(`/api/purchases/drafts/${encodeURIComponent(st.id)}`, { method: 'DELETE' }); toast('Borrador descartado.'); cerrar(true); }
    catch (e) { toast(e.message, 'error'); }
  }
  let registrando = false;
  async function registrar() {
    if (registrando) return;
    registrando = true;
    const boton = document.getElementById('cp-registrar');
    if (boton) { boton.disabled = true; boton.textContent = 'Registrando…'; }
    try {
      if (st.sucio && !(await guardar({ silencioso: true }))) return;
      if (st.bloqueos.length) { toast(st.bloqueos[0], 'warning'); return; }
      const t = totales();
      const nuevos = st.payload.lineas.filter((l) => l.accion === 'nuevo' && l.tipoLinea !== 'servicio_gasto').length;
      const modo = st.config?.modoRecepcion === 'confirmacion' ? 'La mercancía queda POR RECIBIR hasta que el encargado la confirme.' : 'El inventario sube al registrar.';
      if (!confirm(`¿Registrar la compra por ${money(t.total)}?\n\n${nuevos ? `Se crearán ${nuevos} producto(s) nuevo(s).\n` : ''}${modo}`)) return;
      const r = await req(`/api/purchases/drafts/${encodeURIComponent(st.id)}/registrar`, json('POST', { version: st.version }, { _timeoutMs: 60000 }));
      const partes = [`Compra #${r.id} registrada`];
      if (r.productosCreados) partes.push(`${r.productosCreados} producto(s) nuevo(s)`);
      if (r.estadoInventario === 'pendiente_recepcion') partes.push('mercancía por recibir');
      if (r.tipoNcf === 'B11' && r.ncf) partes.push(`comprobante de compras ${r.ncf}`);
      if (r.ecf?.encf) partes.push(`e-CF ${r.ecf.encf}`);
      if (r.ecf && r.ecf.ok === false) partes.push(`E41 no emitido: ${r.ecf.error || 'revisa Comprobantes'}`);
      toast(partes.join(' · '), r.ecf && r.ecf.ok === false ? 'warning' : 'success');
      cerrar(true);
      refrescarDatos();
      actualizarContadores();
    } catch (e) {
      if (e.bloqueos?.length) { st.bloqueos = e.bloqueos; const a = document.getElementById('cp-avisos'); if (a) a.innerHTML = htmlAvisos(); }
      toast(e.message, 'error');
    } finally {
      registrando = false;
      const b = document.getElementById('cp-registrar');
      if (b) { b.textContent = 'Confirmar y registrar compra'; sincronizarBotonRegistrar(); }
    }
  }

  // ═══ Recepción de mercancía ══════════════════════════════════════════════
  let pendientes = [];
  async function cargarRecepciones() {
    const caja = document.getElementById('compras-recepciones-list');
    if (!caja) return;
    caja.innerHTML = '<div class="loading-text">Cargando…</div>';
    try {
      await configuracion();
      pendientes = await req('/api/purchases/receipts/pending');
      actualizarContador('recepciones', pendientes.length);
      const aviso = cfg?.modoRecepcion === 'confirmacion' ? '' : '<p class="cp-nota">Este negocio sube el inventario al registrar cada compra. Puedes cambiarlo en ⚙ Configuración de compras.</p>';
      if (!pendientes.length) { caja.innerHTML = `${aviso}<div class="cp-vacio">No hay mercancía pendiente de recibir.</div>`; return; }
      caja.innerHTML = `${aviso}<table class="compact-table cp-tabla-lista"><thead><tr><th>Compra</th><th>Proveedor</th><th>Fecha</th><th>Productos</th><th>Estado</th><th></th></tr></thead><tbody>
        ${pendientes.map((p) => `<tr data-id="${p.id}"><td>#${p.id} <small>${esc(p.ncf || p.numeroDocumento || '')}</small></td><td>${esc(p.proveedor)}</td>
          <td>${esc(String(p.fechaComprobante || '').slice(0, 10))}</td><td>${p.items.length}</td>
          <td><span class="badge badge-warning">${esc(ESTADO_INV[p.estadoInventario] || p.estadoInventario)}</span></td>
          <td>${cfg?.puedeRecibir ? '<button type="button" class="btn-xs btn-primary" data-accion="recibir">Recibir mercancía</button>' : '<small>Requiere permiso «Recibir mercancía»</small>'}</td></tr>`).join('')}
        </tbody></table>`;
      caja.onclick = (e) => {
        const b = e.target.closest('[data-accion="recibir"]');
        if (b) abrirRecepcion(Number(b.closest('tr').dataset.id));
      };
    } catch (e) { caja.innerHTML = `<div class="error-text">Error al cargar: ${esc(e.message)}</div>`; }
  }

  function abrirRecepcion(id) {
    const p = pendientes.find((x) => Number(x.id) === Number(id));
    if (!p) return;
    const reciboUuid = uuid();
    document.getElementById('modal-title').textContent = `Recibir mercancía · Compra #${p.id}`;
    document.getElementById('modal-body').innerHTML = `
      <p class="cp-nota">${esc(p.proveedor)} · ${esc(p.ncf || p.numeroDocumento || '')}. Escribe lo que llegó ahora; lo que falte queda pendiente.</p>
      <table class="compact-table cp-tabla-lista"><thead><tr><th>Producto</th><th>Facturado</th><th>Recibido</th><th>Llegó ahora</th></tr></thead><tbody>
        ${p.items.map((it) => { const pend = Math.max(0, Number((it.cantidad - Number(it.cantidadRecibida || 0)).toFixed(3))); return `<tr>
          <td>${esc(it.nombre)}</td><td>${it.cantidad}</td><td>${Number(it.cantidadRecibida || 0)}</td>
          <td><input class="tc-input cp-num" type="number" min="0" step="any" data-item="${it.id}" value="${pend}"></td></tr>`; }).join('')}
      </tbody></table>
      <label class="cp-check"><input type="checkbox" id="cp-cerrar-recepcion"> No llegará más: cerrar con lo recibido (el faltante queda anotado)</label>
      <label class="cp-campo">Nota (obligatoria si llegó de más)<input class="tc-input" id="cp-nota-recepcion" maxlength="300"></label>`;
    document.getElementById('modal-footer').innerHTML = `<button class="btn-secondary" type="button" onclick="closeAllModals()">Cancelar</button>
      <button class="btn-primary" type="button" id="cp-confirmar-recepcion">Confirmar recepción</button>`;
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById('cp-confirmar-recepcion').onclick = async (e) => {
      e.target.disabled = true;
      try {
        const lineas = [...document.querySelectorAll('#modal-body [data-item]')].map((i) => ({ itemId: Number(i.dataset.item), cantidad: Number(i.value || 0) }));
        const r = await req(`/api/purchases/${p.id}/receipts`, json('POST', { uuid: reciboUuid, lineas, cerrar: document.getElementById('cp-cerrar-recepcion').checked,
          notas: document.getElementById('cp-nota-recepcion').value }));
        toast(`Recepción registrada: ${ESTADO_INV[r.estadoInventario] || r.estadoInventario}.`);
        closeAllModals();
        cargarRecepciones();
        refrescarDatos();
      } catch (err) { toast(err.message, 'error'); e.target.disabled = false; }
    };
  }

  // ═══ Configuración de compras ═══════════════════════════════════════════
  async function abrirConfig() {
    try {
      const c = await configuracion(true);
      document.getElementById('modal-title').textContent = 'Configuración de compras';
      document.getElementById('modal-body').innerHTML = `
        <fieldset class="cp-config"><legend>¿Cuándo sube el inventario?</legend>
          <label class="cp-check"><input type="radio" name="cp-modo" value="automatica" ${c.modoRecepcion !== 'confirmacion' ? 'checked' : ''}> <span><b>Al registrar la compra</b> (automático, una sola vez)</span></label>
          <label class="cp-check"><input type="radio" name="cp-modo" value="confirmacion" ${c.modoRecepcion === 'confirmacion' ? 'checked' : ''}> <span><b>Cuando el encargado confirma la mercancía</b> (la compra y la deuda se registran igual; el inventario espera en «Recepciones»)</span></label>
        </fieldset>
        <fieldset class="cp-config"><legend>Precio de los productos nuevos</legend>
          <label class="cp-campo">Margen sugerido (%) — vacío: precio a mano<input class="tc-input" type="number" min="0" step="0.1" id="cp-cfg-margen" value="${c.margenDefecto ?? ''}"></label>
          <label class="cp-campo">El margen es sobre<select class="tc-select" id="cp-cfg-tipo"><option value="costo" ${c.tipoMargen !== 'venta' ? 'selected' : ''}>el costo</option><option value="venta" ${c.tipoMargen === 'venta' ? 'selected' : ''}>la venta</option></select></label>
          <label class="cp-campo">El precio que se escribe es<select class="tc-select" id="cp-cfg-modo"><option value="base" ${c.precioModo === 'base' ? 'selected' : ''}>Precio base + ITBIS</option><option value="incluido" ${c.precioModo === 'incluido' ? 'selected' : ''}>Precio final (ITBIS incluido)</option></select></label>
          <p class="cp-nota">La tasa de ITBIS sale de Configuración → Facturación (hoy ${c.tasaItbis} %).</p>
        </fieldset>
        <fieldset class="cp-config"><legend>Tu contador</legend>
          <label class="cp-check"><input type="checkbox" id="cp-cfg-contador" ${c.contadorRegistra !== false ? 'checked' : ''}> <span><b>Mi contador registra compras desde su portal</b> (entran solas: inventario, costos y cuentas por pagar; no cambia los precios de tus productos)</span></label>
        </fieldset>`;
      document.getElementById('modal-footer').innerHTML = `<button class="btn-secondary" type="button" onclick="closeAllModals()">Cancelar</button>
        ${c.puedeConfigurar ? '<button class="btn-primary" type="button" id="cp-cfg-guardar">Guardar</button>' : '<small>Solo quien administra la configuración puede cambiarla.</small>'}`;
      document.getElementById('modal-overlay').classList.remove('hidden');
      document.getElementById('cp-cfg-guardar')?.addEventListener('click', async () => {
        try {
          cfg = { ...cfg, ...(await req('/api/purchases/config', json('PUT', {
            modoRecepcion: document.querySelector('input[name="cp-modo"]:checked')?.value, margenDefecto: document.getElementById('cp-cfg-margen').value,
            tipoMargen: document.getElementById('cp-cfg-tipo').value, precioModo: document.getElementById('cp-cfg-modo').value,
            contadorRegistra: document.getElementById('cp-cfg-contador').checked,
          }))) };
          toast('Configuración de compras guardada.');
          closeAllModals();
        } catch (e) { toast(e.message, 'error'); }
      });
    } catch (e) { toast(e.message, 'error'); }
  }

  window.ComprasPreparar = { abrirSubida, nuevaManual, abrir, cerrar, cargarBorradores, cargarRecepciones, abrirConfig, descargarPlantilla, actualizarContadores,
    // Para pruebas.
    _estado: () => st };
})();
