// ══════════════════════════════════════════════════════════════════════════════
//  combos-personalizados.js — Tecno Caja
//  Combos personalizados.
//
//  · Configuración → Apariencia: activar la función y sus opciones.
//  · Productos → "Disponible para combos" (casilla del formulario).
//  · Promociones → Combos personalizados: combos sugeridos (opcionales: un
//    nombre y un precio de partida), productos disponibles y reporte.
//  · Ventas → botón COMBOS: el cajero escribe el precio que acordó con el
//    cliente (con ITBIS incluido) y elige libremente los productos.
//
//  Un combo NO es un producto: en el carrito es un grupo de líneas normales
//  (una por producto, con su cantidad real) con la misma marca
//  item.comboPersonalizado. El precio del combo se reparte entre esas líneas
//  con el mismo motor que el servidor (js/combos-personalizados-motor.js):
//  cada una queda con su base y su ITBIS según la tasa del producto, y la suma
//  da el precio elegido. El sistema no pone precios ni límites.
// ══════════════════════════════════════════════════════════════════════════════

/* global DB, fmt, escapeHtml, showToast, showDeleteConfirm, closeAllModals, isProductSellable, focusSalesSearchInput,
   getCartQtyForProduct, PRODUCT_IMAGE_PLACEHOLDER, getSalesProductImage, buildCustomComboSaleItem, renderSaleTable,
   updateTotals, renderSalesCatalog, removeCustomComboGroup */

(function () {
  'use strict';

  const Motor = window.CombosPersonalizadosMotor;
  const API = '/api/combos-personalizados';
  const NOMBRE_POR_DEFECTO = 'Combo personalizado';

  const estado = {
    cargado: false,
    config: { activo: false, mostrarImagenes: true, permitirCantidades: true },
    combos: [],
    productoIds: new Set(),
    tasaItbis: 18,
    puedeAdministrar: false,
    puedeConfigurar: false,
  };
  let cargando = null;

  // Selector abierto en Ventas:
  // { precioTexto, nombre, comboId, seleccion: Map(id → qty), editando: clave|null, busqueda, categoria, paso }
  let sel = null;
  // Panel de Promociones.
  const panel = { combos: [], busquedaProductos: '' };
  let formulario = null; // { id, imageData, quitarImagen, imagen }

  // ── Utilidades ────────────────────────────────────────────────────────────
  function esc(valor) {
    return typeof escapeHtml === 'function'
      ? escapeHtml(valor)
      : String(valor ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function dinero(valor) {
    return typeof fmt === 'function' ? fmt(Number(valor || 0)) : `RD$ ${Number(valor || 0).toFixed(2)}`;
  }

  function dineroCentavos(centavos) {
    return dinero(Motor.deCentavos(centavos));
  }

  function icono(nombre, tam = 18) {
    return window.TcIconos ? window.TcIconos.svg(nombre, tam) : '';
  }

  function aviso(mensaje, tipo = 'info') {
    if (typeof showToast === 'function') showToast(mensaje, tipo);
  }

  // El aviso de la app sale abajo a la derecha, justo donde queda FINALIZAR
  // COMBO: al abrir el selector se esconde el que hubiera.
  function ocultarAviso() {
    document.getElementById('toast')?.classList.add('hidden');
  }

  // Modal de confirmación de la app (ui.js); sin él, el confirm del navegador.
  function confirmar(mensaje, textoBoton = 'Quitar') {
    if (typeof showDeleteConfirm === 'function') return showDeleteConfirm(esc(mensaje), { confirmText: textoBoton });
    return Promise.resolve(window.confirm(mensaje));
  }

  // "Hoy" en la hora local de la PC (nunca toISOString: de noche daría mañana).
  function hoyLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  async function pedir(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${(typeof DB !== 'undefined' && DB.authToken) || ''}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Error de servidor');
    return data;
  }

  function aplicarEstado(data = {}) {
    if (data.config) estado.config = { ...estado.config, ...data.config };
    if (Array.isArray(data.combos)) estado.combos = data.combos;
    if (Array.isArray(data.productoIds)) estado.productoIds = new Set(data.productoIds.map(Number));
    if (data.tasaItbis !== undefined) estado.tasaItbis = Number(data.tasaItbis);
    if (data.puedeAdministrar !== undefined) estado.puedeAdministrar = Boolean(data.puedeAdministrar);
    if (data.puedeConfigurar !== undefined) estado.puedeConfigurar = Boolean(data.puedeConfigurar);
    estado.cargado = true;
  }

  // Copia local del estado: si la caja queda sin la principal (contingencia),
  // el cajero sigue armando combos con lo último que se cargó.
  const CLAVE_LOCAL = 'tc-combos-personalizados-estado';

  function guardarCopiaLocal(data) {
    try { window.localStorage?.setItem(CLAVE_LOCAL, JSON.stringify({ ...data, guardadoEn: Date.now() })); } catch (_) { /* sin espacio */ }
  }

  function leerCopiaLocal() {
    try {
      const raw = window.localStorage?.getItem(CLAVE_LOCAL);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  async function cargar({ forzar = false } = {}) {
    if (cargando && !forzar) return cargando;
    cargando = pedir('GET', `${API}/estado`)
      .then((data) => {
        aplicarEstado(data);
        guardarCopiaLocal(data);
        aplicarVisibilidad();
        return estado;
      })
      .catch((error) => {
        console.warn('[combos-personalizados] No se pudo cargar:', error.message);
        if (!estado.cargado) {
          const copia = leerCopiaLocal();
          if (copia) aplicarEstado(copia);
        }
        aplicarVisibilidad();
        return estado;
      })
      .finally(() => {
        setTimeout(() => { cargando = null; }, 0);
      });
    return cargando;
  }

  function tasa() {
    const valor = Number(typeof DB !== 'undefined' ? DB.config?.itbis : NaN);
    return Number.isFinite(valor) ? valor : estado.tasaItbis;
  }

  function combosSugeridos() {
    return estado.combos.filter((c) => c.activo);
  }

  // Lo que el motor necesita de un producto del catálogo (DB.productos).
  function aMotor(p) {
    return {
      id: Number(p.id),
      precio: Number(p.precioVenta || 0),
      aplicaItbis: Boolean(p.aplicaItbis),
      itbisModo: p.aplicaItbis && p.itbisModo === 'monto' ? 'monto' : 'porcentaje',
      itbisMonto: Number(p.itbisMonto || 0),
    };
  }

  function productoPorId(id) {
    return (typeof DB !== 'undefined' ? DB.productos || [] : []).find((p) => Number(p.id) === Number(id)) || null;
  }

  function motivoNoUsable(p) {
    const modo = String(p?.saleMode || 'unidad').toLowerCase();
    if (modo !== 'unidad') return 'Solo productos que se venden por unidad';
    if (String(p?.tipoProducto || '') === 'combo') return 'Un combo promocional no puede ir dentro';
    return '';
  }

  // Productos que el cajero puede elegir: habilitados, activos y por unidad.
  function productosDisponibles() {
    return (typeof DB !== 'undefined' ? DB.productos || [] : []).filter((p) => (
      estado.productoIds.has(Number(p.id))
      && String(p.estado || 'Activo') !== 'Inactivo'
      && !motivoNoUsable(p)
      && (typeof isProductSellable !== 'function' || isProductSellable(p))
    ));
  }

  function aplicarVisibilidad() {
    const activo = Boolean(estado.config.activo);
    const boton = document.getElementById('ccp-ventas-btn');
    if (boton) boton.classList.toggle('hidden', !activo);
    const tab = document.getElementById('promo-tab-btn-combos-personalizados');
    if (tab) tab.classList.toggle('hidden', !(activo && estado.puedeAdministrar));
    pintarApariencia();
  }

  // ── Configuración → Apariencia ──────────────────────────────────────────
  const OPCIONES = [
    ['activo', 'cfg-ccp-activo'],
    ['mostrarImagenes', 'cfg-ccp-imagenes'],
    ['permitirCantidades', 'cfg-ccp-cantidades'],
  ];

  function pintarApariencia() {
    for (const [campo, id] of OPCIONES) {
      const input = document.getElementById(id);
      if (!input) continue;
      input.checked = Boolean(estado.config[campo]);
      input.disabled = !estado.puedeConfigurar;
    }
    const opciones = document.getElementById('cfg-ccp-opciones');
    if (opciones) opciones.classList.toggle('hidden', !estado.config.activo);
    const permiso = document.getElementById('cfg-ccp-permiso');
    if (permiso) permiso.classList.toggle('hidden', estado.puedeConfigurar);
  }

  async function loadConfigSection() {
    await cargar({ forzar: true });
    pintarApariencia();
  }

  async function guardarOpcion(campo, valor) {
    try {
      const data = await pedir('PUT', `${API}/config`, { [campo]: Boolean(valor) });
      aplicarEstado(data);
      aplicarVisibilidad();
      aviso(campo === 'activo'
        ? (valor ? 'Combos personalizados activados. Marca los productos disponibles en Promociones → Combos personalizados.' : 'Combos personalizados desactivados.')
        : 'Opción de combos guardada.', 'success');
    } catch (error) {
      aviso(`No se pudo guardar: ${error.message}`, 'error');
      pintarApariencia();
    }
  }

  // ── Productos → "Disponible para combos" ─────────────────────────────────
  function campoProducto(prod) {
    if (!estado.config.activo || !estado.puedeAdministrar) return '';
    const motivo = prod ? motivoNoUsable(prod) : '';
    const marcado = prod && estado.productoIds.has(Number(prod.id));
    return `
      <div class="form-group compact-toggle-card" id="mp-combo-personalizado-group">
        <label class="toggle-switch" style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;user-select:none">
          <input type="checkbox" id="mp-combo-personalizado" ${marcado ? 'checked' : ''} ${motivo && !marcado ? 'disabled' : ''} style="width:auto">
          <span>Disponible para combos</span>
        </label>
        <p style="margin:0.4rem 0 0;color:var(--text2);font-size:0.78rem;line-height:1.4">
          ${motivo
            ? esc(`${motivo}.`)
            : 'El cajero lo podrá elegir al armar un combo. Suelto se sigue vendiendo igual.'}
        </p>
      </div>`;
  }

  async function guardarCampoProducto(productId) {
    const input = document.getElementById('mp-combo-personalizado');
    if (!input || !productId) return;
    const quiere = input.checked;
    if (quiere === estado.productoIds.has(Number(productId))) return;
    const data = await pedir('PUT', `${API}/productos/${Number(productId)}`, { habilitado: quiere });
    aplicarEstado(data);
  }

  // ── Promociones → Combos personalizados ──────────────────────────────────
  async function onPromocionesOpen() {
    await cargar({ forzar: true });
  }

  async function cargarPanel() {
    const lista = document.getElementById('ccp-lista');
    if (lista) lista.innerHTML = '<div class="combo-empty">Cargando combos…</div>';
    try {
      await cargar({ forzar: true });
      const data = await pedir('GET', `${API}/combos`);
      panel.combos = data.combos || [];
      pintarPanel();
      pintarProductosPanel();
      const desde = document.getElementById('ccp-reporte-desde');
      const hasta = document.getElementById('ccp-reporte-hasta');
      if (desde && !desde.value) desde.value = `${hoyLocal().slice(0, 8)}01`;
      if (hasta && !hasta.value) hasta.value = hoyLocal();
    } catch (error) {
      if (lista) lista.innerHTML = `<div class="combo-empty combo-empty--error">No se pudieron cargar los combos: ${esc(error.message)}</div>`;
    }
  }

  function pintarPanel() {
    const lista = document.getElementById('ccp-lista');
    const activos = panel.combos.filter((c) => c.activo).length;
    const setText = (id, valor) => { const el = document.getElementById(id); if (el) el.textContent = valor; };
    setText('ccp-count-activos', String(activos));
    setText('ccp-count-inactivos', String(panel.combos.length - activos));
    setText('ccp-count-productos', String(estado.productoIds.size));
    if (!lista) return;
    if (!panel.combos.length) {
      lista.innerHTML = '<div class="combo-empty">No hay combos sugeridos. Son opcionales: el cajero puede escribir cualquier precio en Ventas.</div>';
      return;
    }
    lista.innerHTML = panel.combos.map((c) => `
      <article class="combo-card ccp-card ${c.activo ? '' : 'is-inactive'}" style="${c.color ? `--ccp-color:${esc(c.color)}` : ''}">
        <div class="ccp-card-band">${c.imagen ? `<img src="${esc(c.imagen)}" alt="" loading="lazy">` : icono('package', 28)}</div>
        <div class="combo-card-body">
          <div class="combo-card-title">${esc(c.nombre)}</div>
          <div class="combo-card-prices"><strong>${c.precio > 0 ? `Sugerido ${dinero(c.precio)}` : 'Precio libre'}</strong></div>
          ${c.descripcion ? `<div class="combo-card-code">${esc(c.descripcion)}</div>` : ''}
          <div class="combo-card-meta">
            <span>${c.activo ? 'Activo' : 'Inactivo'}</span>
            <span>${c.ventas ? `${c.ventas} venta(s)` : 'Sin ventas'}</span>
          </div>
        </div>
        <div class="combo-card-actions ccp-card-actions">
          <button class="btn-secondary compact-btn" type="button" onclick="CombosPersonalizados.abrirFormulario(${c.id})">Editar</button>
          <button class="btn-secondary compact-btn" type="button" onclick="CombosPersonalizados.cambiarEstado(${c.id}, ${c.activo ? 'false' : 'true'})">${c.activo ? 'Desactivar' : 'Activar'}</button>
          ${c.ventas ? '' : `<button class="btn-ghost compact-btn" type="button" onclick="CombosPersonalizados.eliminar(${c.id})">Eliminar</button>`}
        </div>
      </article>`).join('');
  }

  function pintarProductosPanel() {
    const cont = document.getElementById('ccp-productos');
    if (!cont) return;
    const q = String(panel.busquedaProductos || '').trim().toLowerCase();
    const todos = (DB.productos || []).filter((p) => String(p.estado || 'Activo') !== 'Inactivo' && !motivoNoUsable(p));
    const filtrados = todos
      .filter((p) => !q || [p.nombre, p.codigo, p.categoria].some((v) => String(v || '').toLowerCase().includes(q)))
      .sort((a, b) => Number(estado.productoIds.has(Number(b.id))) - Number(estado.productoIds.has(Number(a.id)))
        || String(a.nombre).localeCompare(String(b.nombre)))
      .slice(0, 200);
    if (!filtrados.length) {
      cont.innerHTML = '<div class="combo-empty">No hay productos con ese nombre.</div>';
      return;
    }
    cont.innerHTML = filtrados.map((p) => {
      const on = estado.productoIds.has(Number(p.id));
      return `
        <label class="ccp-prod-row ${on ? 'is-on' : ''}">
          <input type="checkbox" ${on ? 'checked' : ''} onchange="CombosPersonalizados.cambiarProducto(${Number(p.id)}, this.checked)">
          <span class="ccp-prod-name">${esc(p.nombre)}<small>${esc(p.categoria || '')}</small></span>
          <span class="ccp-prod-price">${dineroCentavos(Motor.precioFinalCentavos(aMotor(p), { tasa: tasa() }))}</span>
        </label>`;
    }).join('');
  }

  function buscarProductosPanel(valor) {
    panel.busquedaProductos = valor;
    pintarProductosPanel();
  }

  async function cambiarProducto(id, habilitado) {
    try {
      const data = await pedir('PUT', `${API}/productos/${Number(id)}`, { habilitado: Boolean(habilitado) });
      aplicarEstado(data);
      pintarPanel();
      pintarProductosPanel();
    } catch (error) {
      aviso(error.message, 'error');
      pintarProductosPanel();
    }
  }

  function abrirFormulario(id) {
    const combo = id ? panel.combos.find((c) => Number(c.id) === Number(id)) : null;
    formulario = { id: combo ? combo.id : null, imageData: null, quitarImagen: false, imagen: combo?.imagen || '' };
    const tieneImagen = Boolean(formulario.imagen);
    document.getElementById('modal-box')?.classList.add('product-modal');
    document.getElementById('modal-title').textContent = combo ? 'Editar combo sugerido' : 'Nuevo combo sugerido';
    document.getElementById('modal-body').innerHTML = `
      <div class="mp-image-row combo-head-row">
        <div class="combo-image-col">
          <div class="mp-image-box ${tieneImagen ? 'has-image' : ''}" onclick="document.getElementById('ccp-imagen-file').click()" title="Clic para elegir una imagen (opcional)">
            <img id="ccp-imagen-preview" class="mp-image-preview" src="${esc(formulario.imagen)}" style="display:${tieneImagen ? 'block' : 'none'}">
            <div class="mp-image-placeholder" id="ccp-imagen-placeholder" style="display:${tieneImagen ? 'none' : 'flex'}">
              ${icono('image', 22)}
              <small>Imagen</small>
            </div>
            <input type="file" id="ccp-imagen-file" accept="image/*" style="display:none" onchange="CombosPersonalizados.elegirImagen(this)">
          </div>
          <button type="button" class="btn-ghost combo-image-remove" id="ccp-imagen-quitar" style="${tieneImagen ? '' : 'display:none'}" onclick="CombosPersonalizados.quitarImagen()">Quitar imagen</button>
        </div>
        <div class="mp-image-fields">
          <div class="form-group">
            <label for="ccp-nombre">Nombre del combo</label>
            <input type="text" id="ccp-nombre" class="form-input" maxlength="150" value="${esc(combo?.nombre || '')}" placeholder="Ej. Combo especial">
          </div>
          <div class="modal-grid">
            <div class="form-group">
              <label for="ccp-precio">Precio sugerido (opcional, ITBIS incluido)</label>
              <input type="number" id="ccp-precio" class="form-input" min="0" step="0.01" inputmode="decimal" value="${combo && combo.precio > 0 ? combo.precio : ''}" placeholder="Libre">
            </div>
            <div class="form-group">
              <label for="ccp-color">Color (identificación)</label>
              <input type="color" id="ccp-color" class="form-input" value="${esc(combo?.color || '#14B8A6')}" style="height:42px;padding:4px">
            </div>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label for="ccp-descripcion">Descripción (opcional)</label>
        <input type="text" id="ccp-descripcion" class="form-input" maxlength="500" value="${esc(combo?.descripcion || '')}" placeholder="Ej. Comida y bebida a elección">
      </div>
      <div class="form-group compact-toggle-card">
        <label class="toggle-switch" style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;user-select:none">
          <input type="checkbox" id="ccp-activo" ${combo?.activo === false ? '' : 'checked'} style="width:auto">
          <span>Activo (aparece como atajo en Ventas)</span>
        </label>
      </div>
      <p class="combo-hint">Es solo un atajo con nombre: en cada venta el cajero puede cambiar el precio y elige los productos que quiera.</p>`;
    document.getElementById('modal-footer').innerHTML = `
      <button class="btn-secondary" type="button" onclick="closeAllModals()">Cancelar</button>
      <button class="btn-primary" type="button" id="ccp-guardar" onclick="CombosPersonalizados.guardarFormulario()">${combo ? 'Guardar cambios' : 'Crear combo'}</button>`;
    document.getElementById('modal-overlay')?.classList.remove('hidden');
    setTimeout(() => document.getElementById('ccp-nombre')?.focus(), 50);
  }

  function elegirImagen(input) {
    const file = input?.files?.[0];
    if (!file || !formulario) return;
    const reader = new FileReader();
    reader.onload = () => {
      formulario.imageData = String(reader.result || '');
      formulario.quitarImagen = false;
      const img = document.getElementById('ccp-imagen-preview');
      if (img) { img.src = formulario.imageData; img.style.display = 'block'; }
      const ph = document.getElementById('ccp-imagen-placeholder');
      if (ph) ph.style.display = 'none';
      const quitar = document.getElementById('ccp-imagen-quitar');
      if (quitar) quitar.style.display = '';
    };
    reader.readAsDataURL(file);
  }

  function quitarImagen() {
    if (!formulario) return;
    formulario.imageData = null;
    formulario.quitarImagen = true;
    const img = document.getElementById('ccp-imagen-preview');
    if (img) img.style.display = 'none';
    const ph = document.getElementById('ccp-imagen-placeholder');
    if (ph) ph.style.display = 'flex';
    const quitar = document.getElementById('ccp-imagen-quitar');
    if (quitar) quitar.style.display = 'none';
  }

  async function guardarFormulario() {
    if (!formulario) return;
    const precioTexto = String(document.getElementById('ccp-precio')?.value || '').trim();
    const body = {
      nombre: document.getElementById('ccp-nombre')?.value || '',
      precio: precioTexto ? Number(precioTexto) : 0,
      descripcion: document.getElementById('ccp-descripcion')?.value || '',
      color: document.getElementById('ccp-color')?.value || '',
      activo: document.getElementById('ccp-activo')?.checked !== false,
    };
    if (!String(body.nombre).trim()) { aviso('Escribe el nombre del combo.', 'warning'); return; }
    if (!Number.isFinite(body.precio) || body.precio < 0) { aviso('El precio sugerido no es válido.', 'warning'); return; }
    const boton = document.getElementById('ccp-guardar');
    if (boton) boton.disabled = true;
    try {
      const data = formulario.id
        ? await pedir('PUT', `${API}/combos/${formulario.id}`, body)
        : await pedir('POST', `${API}/combos`, body);
      const id = data.combo?.id;
      if (id && formulario.imageData) {
        await pedir('POST', `${API}/combos/${id}/imagen`, { imageData: formulario.imageData })
          .catch((e) => aviso(`Combo guardado, pero la imagen no: ${e.message}`, 'warning'));
      } else if (id && formulario.quitarImagen && formulario.imagen) {
        await pedir('DELETE', `${API}/combos/${id}/imagen`).catch(() => {});
      }
      closeAllModals();
      aviso(formulario.id ? 'Combo actualizado.' : 'Combo creado.', 'success');
      formulario = null;
      await cargarPanel();
    } catch (error) {
      aviso(error.message, 'error');
      if (boton) boton.disabled = false;
    }
  }

  async function cambiarEstado(id, activo) {
    try {
      await pedir('POST', `${API}/combos/${Number(id)}/estado`, { activo: Boolean(activo) });
      await cargarPanel();
    } catch (error) {
      aviso(error.message, 'error');
    }
  }

  async function eliminar(id) {
    const combo = panel.combos.find((c) => Number(c.id) === Number(id));
    if (!combo) return;
    const ok = await confirmar(`¿Eliminar el combo "${combo.nombre}"?`, 'Eliminar');
    if (!ok) return;
    try {
      await pedir('DELETE', `${API}/combos/${Number(id)}`);
      aviso('Combo eliminado.', 'success');
      await cargarPanel();
    } catch (error) {
      aviso(error.message, 'error');
    }
  }

  async function verReporte() {
    const cuerpo = document.getElementById('ccp-reporte');
    if (!cuerpo) return;
    const desde = document.getElementById('ccp-reporte-desde')?.value || '';
    const hasta = document.getElementById('ccp-reporte-hasta')?.value || '';
    cuerpo.innerHTML = '<div class="combo-empty">Cargando reporte…</div>';
    try {
      const params = new URLSearchParams();
      if (desde) params.set('desde', desde);
      if (hasta) params.set('hasta', hasta);
      const r = await pedir('GET', `${API}/reporte?${params.toString()}`);
      const tabla = (titulo, cabeceras, filas) => `
        <div class="ccp-report-block">
          <div class="combo-settings-title">${esc(titulo)}</div>
          <div class="table-wrap"><table class="data-table">
            <thead><tr>${cabeceras.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
            <tbody>${filas.length ? filas.join('') : `<tr><td colspan="${cabeceras.length}" class="combo-empty">Sin ventas en el período.</td></tr>`}</tbody>
          </table></div>
        </div>`;
      cuerpo.innerHTML = `
        <div class="stats-row ccp-report-stats">
          <div class="stat-card"><div class="stat-val">${Number(r.combosVendidos || 0)}</div><div class="stat-label">Combos vendidos</div></div>
          <div class="stat-card"><div class="stat-val">${dinero(r.ingresos)}</div><div class="stat-label">Cobrado (ITBIS incluido)</div></div>
          <div class="stat-card"><div class="stat-val">${dinero(r.itbis)}</div><div class="stat-label">ITBIS de los combos</div></div>
          <div class="stat-card"><div class="stat-val">${dinero(r.valorNormal)}</div><div class="stat-label">Valor normal de lo que llevaron</div></div>
        </div>
        ${tabla('Por combo', ['Combo', 'Vendidos', 'Precio promedio', 'Cobrado', 'Valor normal', 'ITBIS'], (r.porCombo || []).map((f) => `
          <tr><td>${esc(f.nombre)}</td><td>${f.combos}</td><td>${dinero(f.precioPromedio)}</td><td>${dinero(f.ingresos)}</td><td>${dinero(f.valorNormal)}</td><td>${dinero(f.itbis)}</td></tr>`))}
        ${tabla('Productos consumidos en combos', ['Producto', 'Cantidad', 'Devueltos', 'Cobrado'], (r.productos || []).map((f) => `
          <tr><td>${esc(f.nombre)}</td><td>${f.cantidad}</td><td>${f.devueltas || 0}</td><td>${dinero(f.ingresos)}</td></tr>`))}
        ${tabla('Por cajero', ['Cajero', 'Combos', 'Cobrado', 'Valor normal'], (r.porCajero || []).map((f) => `
          <tr><td>${esc(f.cajero)}</td><td>${f.combos}</td><td>${dinero(f.ingresos)}</td><td>${dinero(f.valorNormal)}</td></tr>`))}
        ${tabla('Por sucursal', ['Sucursal', 'Combos', 'Cobrado'], (r.porSucursal || []).map((f) => `
          <tr><td>${esc(f.sucursal)}</td><td>${f.combos}</td><td>${dinero(f.ingresos)}</td></tr>`))}
        <p class="combo-hint">Lo cobrado por los combos ya está dentro de las ventas de cada producto en los reportes de siempre: aquí no se suma otra vez, solo se muestra agrupado. "Valor normal" es lo que habrían costado esos productos sueltos. Ventas canceladas fuera; las devoluciones se restan.</p>`;
    } catch (error) {
      cuerpo.innerHTML = `<div class="combo-empty combo-empty--error">No se pudo cargar el reporte: ${esc(error.message)}</div>`;
    }
  }

  // ── Ventas: elegir el precio y los productos ─────────────────────────────
  function overlay() {
    let el = document.getElementById('ccp-overlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'ccp-overlay';
    el.className = 'ccp-overlay hidden';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'ccp-titulo');
    el.innerHTML = `
      <div class="ccp-dialog">
        <header class="ccp-head">
          <div class="ccp-head-text">
            <h2 id="ccp-titulo">Combo</h2>
            <p id="ccp-subtitulo"></p>
          </div>
          <button type="button" class="ccp-close" onclick="CombosPersonalizados.cerrar()" aria-label="Cerrar">${icono('x', 22)}</button>
        </header>
        <div class="ccp-body" id="ccp-cuerpo"></div>
        <footer class="ccp-foot" id="ccp-pie"></footer>
      </div>`;
    el.addEventListener('click', (event) => { if (event.target === el) cerrar(); });
    document.body.appendChild(el);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !document.getElementById('ccp-overlay')?.classList.contains('hidden')) {
        event.preventDefault();
        event.stopPropagation();
        cerrar();
      }
    }, true);
    return el;
  }

  function precioCentavos() {
    const valor = Number(String(sel?.precioTexto || '').replace(/,/g, ''));
    return Number.isFinite(valor) && valor > 0 ? Motor.aCentavos(valor) : 0;
  }

  async function abrir() {
    await cargar();
    if (!estado.config.activo) {
      aviso('Los combos personalizados están desactivados (Configuración → Apariencia).', 'warning');
      return;
    }
    if (!productosDisponibles().length) {
      aviso('No hay productos disponibles para combos. Márcalos en Promociones → Combos personalizados.', 'warning');
      return;
    }
    sel = { precioTexto: '', nombre: NOMBRE_POR_DEFECTO, comboId: null, seleccion: new Map(), editando: null, busqueda: '', categoria: '', paso: 'precio' };
    overlay().classList.remove('hidden');
    ocultarAviso();
    pintarPasoPrecio();
  }

  function cerrar() {
    sel = null;
    document.getElementById('ccp-overlay')?.classList.add('hidden');
    if (typeof focusSalesSearchInput === 'function') focusSalesSearchInput({ force: true });
  }

  // Paso 1: el precio que acordó el cliente (libre) y, si se quiere, un nombre
  // de los combos sugeridos.
  function pintarPasoPrecio() {
    sel.paso = 'precio';
    document.getElementById('ccp-titulo').textContent = sel.editando ? 'Precio del combo' : 'Nuevo combo';
    document.getElementById('ccp-subtitulo').textContent = 'Escribe el precio que pagará el cliente, con el ITBIS incluido.';
    const sugeridos = combosSugeridos();
    document.getElementById('ccp-cuerpo').innerHTML = `
      <div class="ccp-precio">
        <label class="ccp-precio-campo" for="ccp-precio-input">
          <span>Precio del combo (ITBIS incluido)</span>
          <span class="ccp-precio-entrada">
            <span class="ccp-precio-moneda">RD$</span>
            <input type="text" id="ccp-precio-input" inputmode="decimal" autocomplete="off" placeholder="0.00"
              value="${esc(sel.precioTexto)}" oninput="CombosPersonalizados.escribirPrecio(this.value)"
              onkeydown="if(event.key==='Enter'){event.preventDefault();CombosPersonalizados.irAProductos();}">
          </span>
        </label>
        <div class="ccp-precio-nombre">
          <span>Nombre en la factura:</span> <strong id="ccp-nombre-elegido">${esc(sel.nombre)}</strong>
        </div>
        ${sugeridos.length ? `
          <div class="combo-settings-title">Combos sugeridos (opcional)</div>
          <div class="ccp-combos">
            <button type="button" class="ccp-combo-card ${sel.comboId ? '' : 'is-active'}" onclick="CombosPersonalizados.elegirSugerido(0)">
              <span class="ccp-combo-media">${icono('package', 30)}</span>
              <span class="ccp-combo-name">${esc(NOMBRE_POR_DEFECTO)}</span>
              <span class="ccp-combo-desc">Precio libre</span>
            </button>
            ${sugeridos.map((c) => `
              <button type="button" class="ccp-combo-card ${Number(sel.comboId) === Number(c.id) ? 'is-active' : ''}" style="${c.color ? `--ccp-color:${esc(c.color)}` : ''}" onclick="CombosPersonalizados.elegirSugerido(${c.id})">
                <span class="ccp-combo-media">${c.imagen ? `<img src="${esc(c.imagen)}" alt="" loading="lazy">` : icono('package', 30)}</span>
                <span class="ccp-combo-name">${esc(c.nombre)}</span>
                <span class="ccp-combo-desc">${c.precio > 0 ? `Sugerido ${dinero(c.precio)}` : 'Precio libre'}</span>
              </button>`).join('')}
          </div>` : ''}
      </div>`;
    document.getElementById('ccp-pie').innerHTML = `
      <div class="ccp-foot-actions">
        <button type="button" class="btn-secondary ccp-btn" onclick="CombosPersonalizados.cerrar()">Cancelar</button>
        <button type="button" class="btn-primary ccp-btn ccp-finalizar" id="ccp-continuar" ${precioCentavos() > 0 ? '' : 'disabled'} onclick="CombosPersonalizados.irAProductos()">
          <span>Elegir productos</span>${icono('chevron-right', 18)}
        </button>
      </div>`;
    setTimeout(() => {
      const input = document.getElementById('ccp-precio-input');
      if (input) { input.focus(); input.select(); }
    }, 30);
  }

  function escribirPrecio(valor) {
    if (!sel) return;
    sel.precioTexto = String(valor || '').replace(/[^0-9.,]/g, '');
    const boton = document.getElementById('ccp-continuar');
    if (boton) boton.disabled = !(precioCentavos() > 0);
  }

  function elegirSugerido(id) {
    if (!sel) return;
    const combo = combosSugeridos().find((c) => Number(c.id) === Number(id)) || null;
    sel.comboId = combo ? combo.id : null;
    sel.nombre = combo ? combo.nombre : NOMBRE_POR_DEFECTO;
    if (combo && combo.precio > 0) sel.precioTexto = combo.precio.toFixed(2);
    pintarPasoPrecio();
  }

  function irAProductos() {
    if (!sel) return;
    if (!(precioCentavos() > 0)) {
      document.getElementById('ccp-precio-input')?.focus();
      return;
    }
    sel.paso = 'productos';
    pintarSelector();
    setTimeout(() => document.getElementById('ccp-buscar')?.focus(), 30);
  }

  function seleccionComoLista() {
    return [...sel.seleccion.entries()].map(([id, qty]) => {
      const p = productoPorId(id);
      return p ? { ...aMotor(p), qty } : null;
    }).filter(Boolean);
  }

  // Existencia que queda de un producto: lo que hay, menos lo que ya aparta el
  // carrito (sin contar el combo que se está editando) y lo elegido aquí.
  function disponible(p) {
    if (p.tracksStock === false) return Infinity;
    const enCarrito = typeof getCartQtyForProduct === 'function' ? getCartQtyForProduct(p.id) : 0;
    const delGrupo = sel.editando
      ? (DB.saleItems || []).filter((it) => it.comboPersonalizado?.clave === sel.editando && Number(it.id) === Number(p.id))
        .reduce((acc, it) => acc + Number(it.qty || 0), 0)
      : 0;
    return Number(p.stock || 0) - (enCarrito - delGrupo) - (sel.seleccion.get(Number(p.id)) || 0);
  }

  function puedeAgregar(p) {
    const actual = sel.seleccion.get(Number(p.id)) || 0;
    if (!estado.config.permitirCantidades && actual >= 1) return { puede: false, motivo: '' };
    if (disponible(p) < 1) return { puede: false, motivo: actual ? 'No quedan más' : 'Agotado' };
    return { puede: true, motivo: '' };
  }

  // Paso 2: los productos. Las tarjetas muestran solo la imagen (y el nombre
  // debajo); sin precios ni montos encima.
  function pintarSelector() {
    if (!sel) return;
    const productos = productosDisponibles();
    const categorias = [...new Set(productos.map((p) => p.categoria).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const q = sel.busqueda.trim().toLowerCase();
    const visibles = productos.filter((p) => (
      (!sel.categoria || p.categoria === sel.categoria)
      && (!q || [p.nombre, p.codigo, p.categoria].some((v) => String(v || '').toLowerCase().includes(q)))
    ));
    const conImagen = estado.config.mostrarImagenes !== false;
    document.getElementById('ccp-titulo').textContent = `${sel.nombre} · ${dineroCentavos(precioCentavos())}`;
    document.getElementById('ccp-subtitulo').textContent = 'ITBIS incluido. Elige los productos que lleva el combo.';
    const placeholder = typeof PRODUCT_IMAGE_PLACEHOLDER !== 'undefined' ? PRODUCT_IMAGE_PLACEHOLDER : '';
    const tarjetas = visibles.map((p) => {
      const qty = sel.seleccion.get(Number(p.id)) || 0;
      const est = puedeAgregar(p);
      const agotado = !est.puede && !qty;
      const img = typeof getSalesProductImage === 'function' ? getSalesProductImage(p) : (p.imagenLocal || p.imagen || placeholder);
      return `
        <div class="ccp-prod ${qty ? 'is-selected' : ''} ${agotado ? 'is-disabled' : ''} ${conImagen ? '' : 'is-text'}">
          <button type="button" class="ccp-prod-main" ${est.puede ? '' : 'disabled'} onclick="CombosPersonalizados.cambiarCantidad(${Number(p.id)}, 1)" title="${esc(est.motivo || `Agregar ${p.nombre}`)}">
            ${conImagen ? `<span class="ccp-prod-media"><img src="${esc(img)}" alt="${esc(p.nombre)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${esc(placeholder)}'"></span>` : ''}
            <span class="ccp-prod-info">
              <span class="ccp-prod-title">${esc(p.nombre)}</span>
              ${est.motivo ? `<span class="ccp-prod-reason">${esc(est.motivo)}</span>` : ''}
            </span>
          </button>
          ${qty ? `
            <div class="ccp-prod-qty">
              <button type="button" onclick="CombosPersonalizados.cambiarCantidad(${Number(p.id)}, -1)" aria-label="Quitar uno">${icono('minus', 18)}</button>
              <strong>${qty}</strong>
              <button type="button" ${est.puede ? '' : 'disabled'} onclick="CombosPersonalizados.cambiarCantidad(${Number(p.id)}, 1)" aria-label="Agregar uno">${icono('plus', 18)}</button>
            </div>` : ''}
        </div>`;
    }).join('');

    const lista = [...sel.seleccion.entries()].map(([id, qty]) => {
      const p = productoPorId(id);
      return `
        <li>
          <span>${qty} x ${esc(p?.nombre || '')}</span>
          <button type="button" class="ccp-quitar" onclick="CombosPersonalizados.quitarProducto(${Number(id)})" aria-label="Quitar ${esc(p?.nombre || '')}">${icono('x', 16)}</button>
        </li>`;
    }).join('');
    const normal = Motor.valorNormalCentavos(seleccionComoLista(), tasa());

    document.getElementById('ccp-cuerpo').innerHTML = `
      <div class="ccp-selector">
        <div class="ccp-catalogo">
          <div class="ccp-tools">
            <label class="ccp-search">${icono('search', 18)}
              <input type="search" id="ccp-buscar" placeholder="Buscar producto" value="${esc(sel.busqueda)}" oninput="CombosPersonalizados.buscar(this.value)" autocomplete="off">
            </label>
            <button type="button" class="btn-secondary ccp-btn" onclick="CombosPersonalizados.cambiarPrecio()">Cambiar precio</button>
          </div>
          <div class="ccp-chips" role="tablist">
            <button type="button" class="ccp-chip ${sel.categoria ? '' : 'is-active'}" onclick="CombosPersonalizados.filtrar('')">Todas</button>
            ${categorias.map((c) => `<button type="button" class="ccp-chip ${sel.categoria === c ? 'is-active' : ''}" onclick="CombosPersonalizados.filtrar('${esc(String(c).replace(/'/g, "\\'"))}')">${esc(c)}</button>`).join('')}
          </div>
          <div class="ccp-grid ${conImagen ? '' : 'is-text'}">
            ${tarjetas || `<div class="combo-empty">${productos.length ? 'No hay productos con ese filtro.' : 'No hay productos disponibles para combos.'}</div>`}
          </div>
        </div>
        <aside class="ccp-resumen">
          <div class="combo-settings-title">En el combo</div>
          ${lista ? `<ul class="ccp-lineas">${lista}</ul>` : '<p class="combo-hint">Toca un producto para agregarlo.</p>'}
          ${sel.seleccion.size ? `<p class="combo-hint ccp-normal">Valor normal de lo elegido: ${dineroCentavos(normal)}</p>` : ''}
        </aside>
      </div>`;
    pintarPie();
  }

  function pintarPie() {
    const precio = precioCentavos();
    const reparto = Motor.repartirCombo({ precio: precio / 100, seleccion: seleccionComoLista(), tasa: tasa() });
    const unidades = [...sel.seleccion.values()].reduce((a, b) => a + b, 0);
    const listo = precio > 0 && reparto.filas.length > 0;
    const nota = listo && reparto.diferenciaCentavos > 0
      ? `<span class="ccp-nota">Queda en ${dineroCentavos(reparto.sumaCentavos)}: con un solo producto gravado el ITBIS por línea no permite el centavo exacto.</span>`
      : '';
    document.getElementById('ccp-pie').innerHTML = `
      <div class="ccp-progreso ${listo ? 'is-ok' : ''}">
        <div class="ccp-progreso-texto">
          <span>Precio del combo <strong>${dineroCentavos(precio)}</strong> · ITBIS incluido</span>
          <strong id="ccp-estado">${unidades ? `${unidades} producto${unidades === 1 ? '' : 's'}` : 'Sin productos'}</strong>
        </div>
        ${nota}
      </div>
      <div class="ccp-foot-actions">
        <button type="button" class="btn-secondary ccp-btn" onclick="CombosPersonalizados.cerrar()">Cancelar</button>
        <button type="button" class="btn-primary ccp-btn ccp-finalizar" id="ccp-finalizar" ${listo ? '' : 'disabled'} onclick="CombosPersonalizados.finalizar()">
          ${icono('check', 18)}<span>${sel.editando ? 'GUARDAR COMBO' : 'FINALIZAR COMBO'}</span>
        </button>
      </div>`;
  }

  function buscar(valor) {
    if (!sel) return;
    sel.busqueda = String(valor || '');
    const cursor = document.getElementById('ccp-buscar')?.selectionStart;
    pintarSelector();
    const input = document.getElementById('ccp-buscar');
    if (input) {
      input.focus();
      if (cursor !== undefined && cursor !== null) input.setSelectionRange(cursor, cursor);
    }
  }

  function filtrar(categoria) {
    if (!sel) return;
    sel.categoria = categoria;
    pintarSelector();
  }

  function cambiarPrecio() {
    if (!sel) return;
    pintarPasoPrecio();
  }

  function cambiarCantidad(id, delta) {
    if (!sel) return;
    const p = productoPorId(id);
    if (!p) return;
    const actual = sel.seleccion.get(Number(id)) || 0;
    if (delta > 0) {
      if (!puedeAgregar(p).puede) {
        pintarSelector();
        return;
      }
      sel.seleccion.set(Number(id), actual + 1);
    } else if (actual <= 1) {
      sel.seleccion.delete(Number(id));
    } else {
      sel.seleccion.set(Number(id), actual - 1);
    }
    pintarSelector();
  }

  function quitarProducto(id) {
    if (!sel) return;
    sel.seleccion.delete(Number(id));
    pintarSelector();
  }

  function nuevaClave() {
    const azar = Math.random().toString(36).slice(2, 8);
    return `cp${Date.now().toString(36)}${azar}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
  }

  function finalizar() {
    if (!sel) return;
    const precio = precioCentavos();
    const reparto = Motor.repartirCombo({ precio: precio / 100, seleccion: seleccionComoLista(), tasa: tasa() });
    if (!(precio > 0) || !reparto.filas.length) return;
    const clave = sel.editando || nuevaClave();
    const combo = { clave, comboId: sel.comboId || null, nombre: sel.nombre || NOMBRE_POR_DEFECTO, precio: precio / 100 };
    const nuevas = reparto.filas
      .map((fila) => {
        const p = productoPorId(fila.id);
        return p ? buildCustomComboSaleItem(p, fila, combo) : null;
      })
      .filter(Boolean);
    if (sel.editando) {
      const items = DB.saleItems || [];
      const primero = items.findIndex((it) => it.comboPersonalizado?.clave === clave);
      const resto = items.filter((it) => it.comboPersonalizado?.clave !== clave);
      const posicion = primero < 0 ? resto.length : Math.min(primero, resto.length);
      resto.splice(posicion, 0, ...nuevas);
      DB.saleItems = resto;
    } else {
      DB.saleItems.push(...nuevas);
    }
    const nombre = combo.nombre;
    const editado = Boolean(sel.editando);
    cerrar();
    if (typeof renderSaleTable === 'function') renderSaleTable();
    if (typeof updateTotals === 'function') updateTotals();
    if (typeof renderSalesCatalog === 'function') renderSalesCatalog();
    aviso(editado ? `Combo "${nombre}" actualizado.` : `Combo "${nombre}" agregado: ${dineroCentavos(reparto.sumaCentavos)} con ITBIS incluido.`, 'success');
  }

  async function editarGrupo(clave) {
    await cargar();
    const lineas = (DB.saleItems || []).filter((it) => it.comboPersonalizado?.clave === clave);
    if (!lineas.length) return;
    const datos = lineas[0].comboPersonalizado;
    sel = {
      precioTexto: Number(datos.precio || 0).toFixed(2),
      nombre: datos.nombre || NOMBRE_POR_DEFECTO,
      comboId: datos.comboId || null,
      seleccion: new Map(),
      editando: clave,
      busqueda: '',
      categoria: '',
      paso: 'productos',
    };
    lineas.forEach((it) => sel.seleccion.set(Number(it.id), (sel.seleccion.get(Number(it.id)) || 0) + Number(it.qty || 0)));
    overlay().classList.remove('hidden');
    ocultarAviso();
    pintarSelector();
  }

  async function quitarGrupo(clave) {
    const linea = (DB.saleItems || []).find((it) => it.comboPersonalizado?.clave === clave);
    if (!linea) return;
    const pregunta = `¿Quitar el combo "${linea.comboPersonalizado.nombre}" con todos sus productos?`;
    const ok = await confirmar(pregunta, 'Quitar combo');
    if (!ok) return;
    if (typeof removeCustomComboGroup === 'function') removeCustomComboGroup(clave);
  }

  // Antes de cobrar: '' si todo cuadra, o el mensaje de lo que hay que arreglar.
  // El reparto se vuelve a calcular con los precios de catálogo de ahora (una
  // venta en pausa pudo retomarse después de un cambio de precios).
  function validarCarrito({ sinItbis = false } = {}) {
    const items = (typeof DB !== 'undefined' ? DB.saleItems : []) || [];
    const grupos = new Map();
    for (const it of items) {
      if (!it?.comboPersonalizado?.clave) continue;
      if (!grupos.has(it.comboPersonalizado.clave)) grupos.set(it.comboPersonalizado.clave, []);
      grupos.get(it.comboPersonalizado.clave).push(it);
    }
    if (!grupos.size) return '';
    if (!estado.cargado) return 'No se cargaron los combos personalizados. Actualiza la pantalla.';
    if (!estado.config.activo) return 'Los combos personalizados están desactivados: quita los combos del pedido.';
    if (sinItbis) return 'El precio de un combo personalizado incluye ITBIS: no se puede facturar como E44 o E46. Quita el combo o cambia el comprobante.';
    for (const lineas of grupos.values()) {
      const datos = lineas[0].comboPersonalizado;
      const porProducto = new Map();
      for (const it of lineas) {
        const p = productoPorId(it.id);
        if (!p || !estado.productoIds.has(Number(it.id))) return `"${it.nombre}" ya no está disponible para combos: edita el combo "${datos.nombre}".`;
        porProducto.set(Number(it.id), { ...aMotor(p), qty: (porProducto.get(Number(it.id))?.qty || 0) + Number(it.qty || 0) });
      }
      const reparto = Motor.repartirCombo({ precio: Number(datos.precio || 0), seleccion: [...porProducto.values()], tasa: tasa() });
      const igual = reparto.filas.length === lineas.length && reparto.filas.every((f, i) => (
        f.id === Number(lineas[i].id) && f.qty === Number(lineas[i].qty)
        && Motor.aCentavos(f.precio) === Motor.aCentavos(lineas[i].precio)
        && Math.abs(f.tasa - Number(lineas[i].itbis || 0)) < 0.001
      ));
      if (!igual) return `Los precios de los productos del combo "${datos.nombre}" cambiaron: edítalo y guárdalo otra vez.`;
    }
    return '';
  }

  function onVentasOpen() {
    cargar({ forzar: true });
  }

  window.CombosPersonalizados = {
    estado,
    cargar,
    aplicarVisibilidad,
    // Apariencia
    loadConfigSection,
    guardarOpcion,
    // Productos
    campoProducto,
    guardarCampoProducto,
    // Promociones
    onPromocionesOpen,
    cargarPanel,
    abrirFormulario,
    elegirImagen,
    quitarImagen,
    guardarFormulario,
    cambiarEstado,
    eliminar,
    buscarProductosPanel,
    cambiarProducto,
    verReporte,
    // Ventas
    onVentasOpen,
    abrir,
    cerrar,
    escribirPrecio,
    elegirSugerido,
    irAProductos,
    cambiarPrecio,
    buscar,
    filtrar,
    cambiarCantidad,
    quitarProducto,
    finalizar,
    editarGrupo,
    quitarGrupo,
    validarCarrito,
  };

  // Al abrir la página: lo último que se cargó (copia local), para que el botón
  // COMBOS aparezca de una vez al recargar. initApp() lo confirma enseguida
  // con el servidor (cargar), que es el que manda.
  const copiaInicial = leerCopiaLocal();
  if (copiaInicial) {
    aplicarEstado(copiaInicial);
    aplicarVisibilidad();
  }
})();
