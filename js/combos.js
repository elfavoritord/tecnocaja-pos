// ══════════════════════════════════════════════════════════════════════════════
//  combos.js — Tecno Caja
//  Centro de Promociones → Combos promocionales.
//  Mismo patrón que promociones.js: modal genérico (#modal-box/#modal-body),
//  apiGet/apiPost (ncf-config.js), showToast/closeAllModals (ui.js).
//  El combo es un producto del catálogo (product_type 'combo') con su lista de
//  componentes; aparece solo en Ventas. Aquí solo se administra.
// ══════════════════════════════════════════════════════════════════════════════

let _combosCache = [];
let _comboModal = null; // { id, componentes: [{ id, cantidad }], imageData, removeImage, imagen }

function comboIcon(name, size = 18) {
  return window.TcIconos ? window.TcIconos.svg(name, size) : '';
}

function comboEsc(value) {
  return typeof escapeHtml === 'function'
    ? escapeHtml(value)
    : String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function comboMoney(value) {
  return typeof fmt === 'function' ? fmt(Number(value || 0)) : `RD$ ${Number(value || 0).toFixed(2)}`;
}

function comboQty(value) {
  const n = Number(value || 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function comboImageSrc(item) {
  const src = item?.imagenLocal || item?.imagenUrl || item?.imagen || '';
  if (src) return src;
  return typeof PRODUCT_IMAGE_PLACEHOLDER !== 'undefined' ? PRODUCT_IMAGE_PLACEHOLDER : '';
}

async function comboFetch(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken || ''}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error de servidor');
  return data;
}

// El catálogo de Ventas (DB.productos) trae los combos con sus componentes:
// después de cualquier cambio se refresca para que el cajero lo vea al momento.
async function refreshCatalogAfterComboChange() {
  if (typeof refrescarCatalogoSinTocarLaVenta === 'function') {
    await refrescarCatalogoSinTocarLaVenta();
  }
}

// ── Panel ───────────────────────────────────────────────────────────────────
async function loadCombosPanel() {
  const list = document.getElementById('combos-list');
  if (list) list.innerHTML = '<div class="combo-empty">Cargando combos…</div>';
  try {
    const [res, cfg] = await Promise.all([
      apiGet('/api/combos'),
      apiGet('/api/combos/config').catch(() => null),
    ]);
    _combosCache = res.combos || [];
    if (cfg?.presentacionFactura) {
      DB.config = { ...(DB.config || {}), comboInvoiceDisplay: cfg.presentacionFactura };
      const radio = document.querySelector(`input[name="combo-presentacion"][value="${cfg.presentacionFactura}"]`);
      if (radio) radio.checked = true;
    }
    updateCombosStats();
    filterCombos();
  } catch (e) {
    if (list) list.innerHTML = `<div class="combo-empty combo-empty--error">No se pudieron cargar los combos: ${comboEsc(e.message)}</div>`;
  }
}

function updateCombosStats() {
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  set('combos-count-active', _combosCache.filter((c) => c.activo).length);
  set('combos-count-inactive', _combosCache.filter((c) => !c.activo).length);
  set('combos-count-sold', comboQty(_combosCache.reduce((sum, c) => sum + Number(c.ventas?.unidades || 0), 0)));
  set('combos-income', comboMoney(_combosCache.reduce((sum, c) => sum + Number(c.ventas?.ingresos || 0), 0)));
}

function filterCombos() {
  const q = String(document.getElementById('combos-search')?.value || '').trim().toLowerCase();
  const estado = document.getElementById('combos-status-filter')?.value || '';
  const filtered = _combosCache.filter((c) => {
    if (estado === 'activo' && !c.activo) return false;
    if (estado === 'inactivo' && c.activo) return false;
    if (!q) return true;
    return String(c.nombre || '').toLowerCase().includes(q) || String(c.codigo || '').toLowerCase().includes(q);
  });
  renderCombosList(filtered);
}

function renderCombosList(items) {
  const list = document.getElementById('combos-list');
  if (!list) return;
  if (!items.length) {
    list.innerHTML = `
      <div class="combo-empty">
        ${comboIcon('package', 28)}
        <div>${_combosCache.length ? 'Ningún combo coincide con la búsqueda.' : 'Todavía no hay combos. Crea el primero con productos de tu inventario.'}</div>
        ${_combosCache.length ? '' : '<button type="button" class="tc-btn tc-btn--primary" onclick="openComboModal()">Nuevo combo</button>'}
      </div>`;
    return;
  }
  list.innerHTML = items.map((c) => {
    const t = c.totales || {};
    const disponible = c.disponible === null || c.disponible === undefined ? '—' : comboQty(c.disponible);
    return `
      <article class="combo-card ${c.activo ? '' : 'is-inactive'}">
        <div class="combo-card-media">
          <img src="${comboEsc(comboImageSrc(c))}" alt="${comboEsc(c.nombre)}" loading="lazy" onerror="this.onerror=null;this.src='${typeof PRODUCT_IMAGE_PLACEHOLDER !== 'undefined' ? PRODUCT_IMAGE_PLACEHOLDER : ''}'">
          <span class="tc-tag ${c.activo ? 'tc-tag--success' : ''}">${c.activo ? 'Activo' : 'Inactivo'}</span>
        </div>
        <div class="combo-card-body">
          <div class="combo-card-title">${comboEsc(c.nombre)}</div>
          <div class="combo-card-code">${comboEsc(c.codigo)}</div>
          <div class="combo-card-prices">
            <strong>${comboMoney(c.precio)}</strong>
            ${t.ahorro > 0 ? `<s>${comboMoney(t.precioNormal)}</s><span class="combo-saving">Ahorra ${comboMoney(t.ahorro)}</span>` : ''}
          </div>
          <ul class="combo-card-items">
            ${(c.componentes || []).map((p) => `<li>${comboQty(p.cantidad)} × ${comboEsc(p.nombre)}</li>`).join('') || '<li class="combo-warn">Sin productos: agrégale componentes para poder venderlo.</li>'}
          </ul>
          <div class="combo-card-meta">
            <span>Costo ${comboMoney(t.costo)}</span>
            <span class="${t.ganancia < 0 ? 'combo-warn' : ''}">Margen ${Number(t.margenPct || 0).toFixed(1)}%</span>
            <span>Se pueden armar: ${disponible}</span>
            <span>Vendidos: ${comboQty(c.ventas?.unidades || 0)}</span>
          </div>
        </div>
        <div class="combo-card-actions tc-row-actions">
          <button class="tc-btn tc-btn--soft" type="button" onclick="openComboModal(${c.id})">Editar</button>
          <button class="tc-btn tc-btn--icon" type="button" onclick="toggleCombo(${c.id}, ${c.activo ? 'false' : 'true'})" title="${c.activo ? 'Desactivar' : 'Activar'}" aria-label="${c.activo ? 'Desactivar' : 'Activar'}">${comboIcon(c.activo ? 'pause' : 'play')}</button>
          <button class="tc-btn tc-btn--icon" type="button" onclick="viewComboSales(${c.id})" title="Historial de ventas" aria-label="Historial de ventas">${comboIcon('history')}</button>
        </div>
      </article>`;
  }).join('');
}

async function toggleCombo(id, activo) {
  try {
    await apiPost(`/api/combos/${id}/estado`, { activo });
    showToast(activo ? 'Combo activado: ya aparece en Ventas.' : 'Combo desactivado: ya no se puede vender.', 'success');
    await loadCombosPanel();
    await refreshCatalogAfterComboChange();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function saveComboInvoiceDisplay(value) {
  try {
    const res = await comboFetch('PUT', '/api/combos/config', { presentacionFactura: value });
    DB.config = { ...(DB.config || {}), comboInvoiceDisplay: res.presentacionFactura };
    showToast(value === 'desglosado'
      ? 'Las facturas nuevas mostrarán los productos de cada combo.'
      : 'Las facturas nuevas mostrarán el combo como un solo artículo.', 'success');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// ── Modal crear/editar ───────────────────────────────────────────────────────
function comboProductById(id) {
  return (DB.productos || []).find((p) => Number(p.id) === Number(id)) || null;
}

async function openComboModal(id) {
  let combo = null;
  if (id) {
    try {
      combo = (await apiGet(`/api/combos/${id}`)).combo;
    } catch (e) {
      showToast('No se pudo cargar el combo: ' + e.message, 'error');
      return;
    }
  }
  _comboModal = {
    id: combo ? combo.id : null,
    componentes: (combo?.componentes || []).map((c) => ({ id: c.id, cantidad: Number(c.cantidad || 1), snapshot: c })),
    imageData: null,
    removeImage: false,
    imagen: combo ? (combo.imagenLocal || combo.imagenUrl || '') : '',
    aplicaItbisTocado: Boolean(combo),
  };
  const tieneImagen = Boolean(_comboModal.imagen);
  document.getElementById('modal-box').classList.add('product-modal');
  document.getElementById('modal-title').textContent = combo ? 'Editar combo' : 'Nuevo combo';
  document.getElementById('modal-body').innerHTML = `
    <div class="mp-image-row combo-head-row">
      <div class="combo-image-col">
        <div class="mp-image-box ${tieneImagen ? 'has-image' : ''}" onclick="document.getElementById('combo-image-file').click()" title="Clic para elegir la imagen">
          <img id="combo-image-preview" class="mp-image-preview" src="${comboEsc(_comboModal.imagen)}" style="display:${tieneImagen ? 'block' : 'none'}" onerror="this.style.display='none';document.getElementById('combo-image-placeholder').style.display='flex'">
          <div class="mp-image-placeholder" id="combo-image-placeholder" style="display:${tieneImagen ? 'none' : 'flex'}">
            <span>📷</span>
            <small>Imagen</small>
          </div>
          <input type="file" id="combo-image-file" accept="image/*" style="display:none" onchange="handleComboImageSelect(this)">
        </div>
        <button type="button" class="btn-ghost combo-image-remove" id="combo-image-remove" style="${tieneImagen ? '' : 'display:none'}" onclick="removeComboImage()">Quitar imagen</button>
      </div>
      <div class="mp-image-fields">
        <div class="form-group">
          <label>Nombre del combo</label>
          <input type="text" id="combo-nombre" class="form-input" maxlength="160" value="${comboEsc(combo?.nombre || '')}" placeholder="Ej. Combo Familiar">
        </div>
        <div class="modal-grid">
          <div class="form-group">
            <label>Código o referencia</label>
            <input type="text" id="combo-codigo" class="form-input" maxlength="40" value="${comboEsc(combo?.codigo || '')}" placeholder="Ej. COMBO-FAM">
          </div>
          <div class="form-group">
            <label>Estado</label>
            <select id="combo-activo" class="form-input">
              <option value="1" ${!combo || combo.activo ? 'selected' : ''}>Activo (se vende)</option>
              <option value="0" ${combo && !combo.activo ? 'selected' : ''}>Inactivo</option>
            </select>
          </div>
        </div>
      </div>
    </div>
    <div class="form-group span-full">
      <label>Descripción <small class="combo-hint">(opcional)</small></label>
      <textarea id="combo-descripcion" class="form-input" rows="2" maxlength="500" placeholder="Ej. Ideal para compartir">${comboEsc(combo?.descripcion || '')}</textarea>
    </div>

    <div class="form-group span-full">
      <label>Productos del combo</label>
      <input type="text" id="combo-product-search" class="form-input" placeholder="Busca por nombre, código o código de barras…" oninput="filterComboProductChoices(this.value)" autocomplete="off">
      <div id="combo-product-results" class="combo-picker-results"></div>
      <div id="combo-components" class="combo-components"></div>
    </div>

    <div class="modal-grid">
      <div class="form-group">
        <label>Precio promocional del combo</label>
        <input type="number" id="combo-precio" class="form-input" min="0" step="0.01" value="${combo ? Number(combo.precio || 0) : ''}" oninput="renderComboTotals()">
      </div>
      <div class="form-group">
        <label>ITBIS</label>
        <select id="combo-itbis" class="form-input" onchange="_comboModal.aplicaItbisTocado=true;renderComboTotals()">
          <option value="1" ${!combo || combo.aplicaItbis ? 'selected' : ''}>Aplica ITBIS</option>
          <option value="0" ${combo && !combo.aplicaItbis ? 'selected' : ''}>Exento</option>
        </select>
      </div>
    </div>
    <div id="combo-totals"></div>
    <small class="combo-hint">El precio de los productos sueltos no cambia. El cajero vende el combo completo, sin poder cambiar lo que lleva.</small>
  `;
  document.getElementById('modal-footer').innerHTML = `
    <button class="btn-secondary" onclick="closeAllModals()">Cancelar</button>
    <button class="btn-primary" id="combo-save-btn" onclick="saveCombo()">💾 Guardar combo</button>
  `;
  document.getElementById('modal-overlay').classList.remove('hidden');
  renderComboComponents();
  setTimeout(() => document.getElementById(combo ? 'combo-product-search' : 'combo-nombre')?.focus(), 50);
}

function filterComboProductChoices(query) {
  const results = document.getElementById('combo-product-results');
  if (!results) return;
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) { results.innerHTML = ''; return; }
  const yaEstan = new Set((_comboModal?.componentes || []).map((c) => Number(c.id)));
  const matches = (DB.productos || [])
    .filter((p) => p.tipoProducto !== 'combo' && Number(p.id) !== Number(_comboModal?.id || 0))
    .filter((p) => [p.nombre, p.codigo, p.barcode].some((v) => String(v || '').toLowerCase().includes(q)))
    .slice(0, 8);
  if (!matches.length) {
    results.innerHTML = '<div class="combo-picker-empty">Sin resultados en el inventario.</div>';
    return;
  }
  results.innerHTML = matches.map((p) => `
    <button type="button" class="combo-picker-item ${yaEstan.has(Number(p.id)) ? 'is-added' : ''}" onclick="addComboComponent(${p.id})">
      <img src="${comboEsc(comboImageSrc(p))}" alt="" onerror="this.onerror=null;this.src='${typeof PRODUCT_IMAGE_PLACEHOLDER !== 'undefined' ? PRODUCT_IMAGE_PLACEHOLDER : ''}'">
      <span class="combo-picker-name">${comboEsc(p.nombre)}<small>${comboEsc(p.barcode || p.codigo || '')}</small></span>
      <span class="combo-picker-num">${comboMoney(p.precioVenta)}<small>Costo ${comboMoney(p.precioCompra)}</small></span>
      <span class="combo-picker-num">${p.tracksStock === false ? '—' : comboQty(p.stock)}<small>Existencia</small></span>
    </button>
  `).join('');
}

function addComboComponent(productId) {
  if (!_comboModal) return;
  const existing = _comboModal.componentes.find((c) => Number(c.id) === Number(productId));
  if (existing) existing.cantidad = Number(existing.cantidad || 0) + 1;
  else _comboModal.componentes.push({ id: Number(productId), cantidad: 1 });
  const search = document.getElementById('combo-product-search');
  if (search) { search.value = ''; search.focus(); }
  const results = document.getElementById('combo-product-results');
  if (results) results.innerHTML = '';
  renderComboComponents();
}

function setComboComponentQty(index, value) {
  if (!_comboModal?.componentes[index]) return;
  _comboModal.componentes[index].cantidad = Number(value);
  renderComboTotals();
}

function removeComboComponent(index) {
  if (!_comboModal) return;
  _comboModal.componentes.splice(index, 1);
  renderComboComponents();
}

// Datos actuales del producto (catálogo cargado); si ya no está, los del combo.
function comboComponentData(component) {
  const p = comboProductById(component.id);
  if (p) {
    return {
      nombre: p.nombre, codigo: p.barcode || p.codigo, precioVenta: Number(p.precioVenta || 0),
      precioCompra: Number(p.precioCompra || 0), existencia: p.tracksStock === false ? null : Number(p.stock || 0),
      aplicaItbis: Boolean(p.aplicaItbis), imagen: comboImageSrc(p),
    };
  }
  const s = component.snapshot || {};
  return {
    nombre: s.nombre || `Producto ${component.id}`, codigo: s.barcode || s.codigo || '', precioVenta: Number(s.precioVenta || 0),
    precioCompra: Number(s.precioCompra || 0), existencia: s.existencia ?? null, aplicaItbis: Boolean(s.aplicaItbis), imagen: s.imagen || '',
  };
}

function renderComboComponents() {
  const box = document.getElementById('combo-components');
  if (!box || !_comboModal) return;
  if (!_comboModal.componentes.length) {
    box.innerHTML = '<div class="combo-picker-empty">Agrega los productos que lleva el combo (por ejemplo: 1 pollo, 2 refrescos, 1 papas).</div>';
  } else {
    box.innerHTML = `
      <table class="data-table combo-components-table">
        <thead><tr><th>Producto</th><th class="is-num">Precio · costo</th><th class="is-num">Existencia</th><th class="is-num">Cantidad</th><th></th></tr></thead>
        <tbody>
          ${_comboModal.componentes.map((c, i) => {
            const d = comboComponentData(c);
            return `<tr>
              <td><span class="tc-cell-title">${comboEsc(d.nombre)}</span><span class="tc-cell-sub">${comboEsc(d.codigo)}</span></td>
              <td class="is-num"><span class="tc-cell-title">${comboMoney(d.precioVenta)}</span><span class="tc-cell-sub">Costo ${comboMoney(d.precioCompra)}</span></td>
              <td class="is-num">${d.existencia === null ? '—' : comboQty(d.existencia)}</td>
              <td class="is-num"><input type="number" class="form-input combo-qty-input" min="0.001" step="1" value="${comboQty(c.cantidad)}" oninput="setComboComponentQty(${i}, this.value)"></td>
              <td><button type="button" class="tc-btn tc-btn--icon tc-row-danger" onclick="removeComboComponent(${i})" title="Quitar" aria-label="Quitar">${comboIcon('trash-2')}</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  }
  renderComboTotals();
}

function renderComboTotals() {
  const box = document.getElementById('combo-totals');
  if (!box || !_comboModal) return;
  const datos = _comboModal.componentes.map((c) => ({ ...comboComponentData(c), cantidad: Number(c.cantidad || 0) }));
  const precioNormal = datos.reduce((s, d) => s + d.precioVenta * d.cantidad, 0);
  const costo = datos.reduce((s, d) => s + d.precioCompra * d.cantidad, 0);
  const precio = Number(document.getElementById('combo-precio')?.value || 0);
  const ahorro = Math.max(0, precioNormal - precio);
  const ganancia = precio - costo;
  const margen = precio > 0 ? (ganancia / precio) * 100 : 0;
  const gravados = datos.filter((d) => d.aplicaItbis).length;
  const itbisMixto = gravados > 0 && gravados < datos.length;
  // Sugerencia de ITBIS mientras el usuario no lo haya elegido a mano.
  const itbisSelect = document.getElementById('combo-itbis');
  if (itbisSelect && !_comboModal.aplicaItbisTocado && datos.length) {
    itbisSelect.value = gravados === datos.length ? '1' : (gravados === 0 ? '0' : itbisSelect.value);
  }
  const avisos = [];
  if (precio > 0 && costo > 0 && precio < costo) avisos.push('El precio del combo está por debajo del costo de sus productos.');
  if (itbisMixto) {
    avisos.push('Este combo mezcla productos con ITBIS y exentos. En la factura y el e-CF el combo va como una sola línea con el ITBIS que elijas arriba; confirma con tu contador cuál corresponde.');
  }
  if (datos.some((d) => !(d.cantidad > 0))) avisos.push('Cada producto debe tener una cantidad mayor que cero.');
  box.innerHTML = `
    <div class="product-form-card combo-totals-card">
      <div><small>Precio normal de los productos</small><strong>${comboMoney(precioNormal)}</strong></div>
      <div><small>Costo estimado</small><strong>${comboMoney(costo)}</strong></div>
      <div><small>Ahorro del cliente</small><strong class="combo-saving">${comboMoney(ahorro)}</strong></div>
      <div><small>Margen estimado</small><strong class="${ganancia < 0 ? 'combo-warn' : ''}">${comboMoney(ganancia)} · ${margen.toFixed(1)}%</strong></div>
    </div>
    ${avisos.map((a) => `<div class="combo-alert">⚠ ${comboEsc(a)}</div>`).join('')}
  `;
}

function handleComboImageSelect(input) {
  const file = input?.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { showToast('Selecciona un archivo de imagen válido', 'error'); return; }
  if (file.size > 15 * 1024 * 1024) { showToast('La imagen debe pesar menos de 15 MB', 'error'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      // Mismo tamaño que las fotos de productos: el servidor la guarda como archivo .webp.
      const MAX = 900;
      let { width, height } = img;
      if (width > MAX || height > MAX) {
        const ratio = Math.min(MAX / width, MAX / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      _comboModal.imageData = canvas.toDataURL('image/jpeg', 0.82);
      _comboModal.removeImage = false;
      const preview = document.getElementById('combo-image-preview');
      const placeholder = document.getElementById('combo-image-placeholder');
      if (preview) { preview.src = _comboModal.imageData; preview.style.display = 'block'; }
      if (placeholder) placeholder.style.display = 'none';
      preview?.closest('.mp-image-box')?.classList.add('has-image');
      const removeBtn = document.getElementById('combo-image-remove');
      if (removeBtn) removeBtn.style.display = '';
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function removeComboImage() {
  if (!_comboModal) return;
  _comboModal.imageData = null;
  _comboModal.removeImage = Boolean(_comboModal.imagen);
  const preview = document.getElementById('combo-image-preview');
  const placeholder = document.getElementById('combo-image-placeholder');
  if (preview) { preview.src = ''; preview.style.display = 'none'; }
  if (placeholder) placeholder.style.display = 'flex';
  preview?.closest('.mp-image-box')?.classList.remove('has-image');
  const removeBtn = document.getElementById('combo-image-remove');
  if (removeBtn) removeBtn.style.display = 'none';
  const file = document.getElementById('combo-image-file');
  if (file) file.value = '';
}

async function saveCombo() {
  if (!_comboModal) return;
  const nombre = String(document.getElementById('combo-nombre')?.value || '').trim();
  const codigo = String(document.getElementById('combo-codigo')?.value || '').trim();
  const precio = Number(document.getElementById('combo-precio')?.value || 0);
  if (!nombre) { showToast('Escribe el nombre del combo.', 'warning'); return; }
  if (!codigo) { showToast('Escribe un código o referencia para el combo.', 'warning'); return; }
  if (!_comboModal.componentes.length) { showToast('Agrega al menos un producto al combo.', 'warning'); return; }
  if (_comboModal.componentes.some((c) => !(Number(c.cantidad) > 0))) { showToast('Cada producto debe tener una cantidad mayor que cero.', 'warning'); return; }
  if (!(precio > 0)) { showToast('Escribe un precio válido para el combo.', 'warning'); return; }

  const payload = {
    nombre,
    codigo,
    precio,
    descripcion: String(document.getElementById('combo-descripcion')?.value || '').trim(),
    activo: document.getElementById('combo-activo')?.value !== '0',
    aplicaItbis: document.getElementById('combo-itbis')?.value === '1',
    componentes: _comboModal.componentes.map((c) => ({ id: c.id, cantidad: Number(c.cantidad) })),
  };
  const btn = document.getElementById('combo-save-btn');
  if (btn) btn.disabled = true;
  try {
    const res = _comboModal.id
      ? await comboFetch('PUT', `/api/combos/${_comboModal.id}`, payload)
      : await apiPost('/api/combos', payload);
    const comboId = res.combo?.id;
    if (comboId && _comboModal.imageData) {
      await apiPost(`/api/combos/${comboId}/imagen`, { imageData: _comboModal.imageData })
        .catch((e) => showToast('El combo se guardó, pero la imagen no: ' + e.message, 'warning'));
    } else if (comboId && _comboModal.removeImage) {
      await comboFetch('DELETE', `/api/combos/${comboId}/imagen`).catch(() => {});
    }
    showToast(_comboModal.id ? 'Combo actualizado.' : 'Combo creado: ya aparece en Ventas.', 'success');
    closeAllModals();
    _comboModal = null;
    await loadCombosPanel();
    await refreshCatalogAfterComboChange();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Historial de ventas de un combo ─────────────────────────────────────────
async function viewComboSales(id) {
  const combo = _combosCache.find((c) => Number(c.id) === Number(id));
  try {
    const res = await apiGet(`/api/combos/${id}/ventas`);
    const ventas = res.ventas || [];
    document.getElementById('modal-box').classList.add('product-modal');
    document.getElementById('modal-title').textContent = `Ventas de ${combo?.nombre || 'combo'}`;
    document.getElementById('modal-body').innerHTML = ventas.length ? `
      <table class="data-table" style="width:100%">
        <thead><tr><th>Fecha</th><th>Factura</th><th>Cajero</th><th class="is-num">Cant.</th><th class="is-num">Total</th><th>Llevaba</th></tr></thead>
        <tbody>
          ${ventas.map((v) => `<tr class="${v.cancelada ? 'combo-row-cancelled' : ''}">
            <td>${comboEsc(String(v.fecha || '').slice(0, 16))}</td>
            <td>${comboEsc(v.factura || '')}${v.cancelada ? ' <span class="tc-tag tc-tag--danger">Cancelada</span>' : ''}</td>
            <td>${comboEsc(v.cajero || '')}</td>
            <td class="is-num">${comboQty(v.cantidad)}</td>
            <td class="is-num">${comboMoney(v.total)}</td>
            <td class="tc-cell-muted">${(v.componentes || []).map((p) => `${comboQty(p.cantidad)} × ${comboEsc(p.nombre)}`).join(', ')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <small class="combo-hint">Cada venta guarda lo que llevaba el combo ese día: editar el combo no cambia ventas pasadas.</small>
    ` : '<div class="combo-empty">Este combo todavía no tiene ventas.</div>';
    document.getElementById('modal-footer').innerHTML = '<button class="btn-secondary" onclick="closeAllModals()">Cerrar</button>';
    document.getElementById('modal-overlay').classList.remove('hidden');
  } catch (e) {
    showToast('No se pudo cargar el historial: ' + e.message, 'error');
  }
}

// ── Reporte de combos ───────────────────────────────────────────────────────
async function loadCombosReport() {
  const body = document.getElementById('combos-report-body');
  if (!body) return;
  const desde = document.getElementById('combos-report-desde')?.value || '';
  const hasta = document.getElementById('combos-report-hasta')?.value || '';
  body.innerHTML = '<tr><td colspan="8" class="combo-empty">Cargando…</td></tr>';
  try {
    const params = new URLSearchParams();
    if (desde) params.set('desde', desde);
    if (hasta) params.set('hasta', hasta);
    const res = await apiGet(`/api/combos/reportes/resumen?${params.toString()}`);
    const filas = res.combos || [];
    body.innerHTML = filas.length ? filas.map((f) => `
      <tr>
        <td><span class="tc-cell-title">${comboEsc(f.nombre)}</span><span class="tc-cell-sub">${comboEsc(f.codigo)}</span></td>
        <td class="is-num">${comboQty(f.unidades)}</td>
        <td class="is-num">${comboMoney(f.ingresos)}</td>
        <td class="is-num">${comboMoney(f.precioPromedio)}</td>
        <td class="is-num">${comboMoney(f.costo)}</td>
        <td class="is-num ${f.ganancia < 0 ? 'combo-warn' : ''}">${comboMoney(f.ganancia)} · ${Number(f.margenPct || 0).toFixed(1)}%</td>
        <td class="tc-cell-muted">${(f.componentes || []).map((c) => `${comboQty(c.cantidad)} × ${comboEsc(c.nombre)}`).join(', ')}</td>
        <td class="tc-cell-muted">${comboEsc(String(f.ultimaVenta || '').slice(0, 16))}<span class="tc-cell-sub">${comboEsc((f.cajeros || []).join(', '))}</span></td>
      </tr>`).join('')
      : '<tr><td colspan="8" class="combo-empty">No hay ventas de combos en ese período.</td></tr>';
  } catch (e) {
    body.innerHTML = `<tr><td colspan="8" class="combo-empty combo-empty--error">${comboEsc(e.message)}</td></tr>`;
  }
}

window.loadCombosPanel = loadCombosPanel;
window.filterCombos = filterCombos;
window.openComboModal = openComboModal;
window.toggleCombo = toggleCombo;
window.saveComboInvoiceDisplay = saveComboInvoiceDisplay;
window.filterComboProductChoices = filterComboProductChoices;
window.addComboComponent = addComboComponent;
window.setComboComponentQty = setComboComponentQty;
window.removeComboComponent = removeComboComponent;
window.renderComboTotals = renderComboTotals;
window.handleComboImageSelect = handleComboImageSelect;
window.removeComboImage = removeComboImage;
window.saveCombo = saveCombo;
window.viewComboSales = viewComboSales;
window.loadCombosReport = loadCombosReport;
