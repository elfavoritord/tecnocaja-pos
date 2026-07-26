// ══════════════════════════════════════════════════════════════════════════════
//  promociones.js — Tecno Caja
//  Centro de Promociones — Fase 1 (tipo "oferta_precio").
//  Sigue el mismo patrón que productos.js: modal genérico (#modal-box/#modal-body)
//  + apiGet/apiPost (definidos en ncf-config.js) + showToast/closeAllModals (ui.js).
// ══════════════════════════════════════════════════════════════════════════════

const PROMOTION_STATUS_LABELS = {
  activa: '🟢 Activa',
  programada: '🟡 Programada',
  vencida: '🔴 Vencida',
  deshabilitada: '⚫ Deshabilitada',
};

let _promotionsCache = [];
let _promotionModalProduct = null; // producto elegido en el modal de crear/editar

// ── Listado ─────────────────────────────────────────────────────────────────
async function loadPromotionsTable() {
  const tbody = document.getElementById('promotions-table-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:1.5rem">Cargando…</td></tr>';
  try {
    const res = await apiGet('/api/promotions');
    _promotionsCache = res.promotions || [];
    renderPromotionsTable(_promotionsCache);
    updatePromotionsStats(_promotionsCache);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--danger,#ef4444);padding:1.5rem">Error al cargar: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function updatePromotionsStats(promotions) {
  const activeEl = document.getElementById('promotions-active-count');
  const scheduledEl = document.getElementById('promotions-scheduled-count');
  const expiredEl = document.getElementById('promotions-expired-count');
  if (activeEl) activeEl.textContent = promotions.filter((p) => p.estado === 'activa').length;
  if (scheduledEl) scheduledEl.textContent = promotions.filter((p) => p.estado === 'programada').length;
  if (expiredEl) expiredEl.textContent = promotions.filter((p) => p.estado === 'vencida').length;
}

function filterPromotions() {
  const search = String(document.getElementById('promotions-search')?.value || '').trim().toLowerCase();
  const status = document.getElementById('promotions-status-filter')?.value || '';
  const filtered = _promotionsCache.filter((p) => {
    if (status && p.estado !== status) return false;
    if (!search) return true;
    return (
      String(p.nombre || '').toLowerCase().includes(search) ||
      String(p.productoNombre || '').toLowerCase().includes(search) ||
      String(p.productoCodigo || '').toLowerCase().includes(search)
    );
  });
  renderPromotionsTable(filtered);
}

function formatPromotionVigencia(p) {
  if (p.permanente) {
    if (p.horaInicio && p.horaFin) return `Permanente · ${p.horaInicio.slice(0, 5)}–${p.horaFin.slice(0, 5)}`;
    return 'Permanente';
  }
  const inicio = p.fechaInicio ? String(p.fechaInicio).slice(0, 10) : '—';
  const fin = p.fechaFin ? String(p.fechaFin).slice(0, 10) : '—';
  return `${inicio} → ${fin}`;
}

function renderPromotionsTable(promotions) {
  const tbody = document.getElementById('promotions-table-body');
  if (!tbody) return;
  if (!promotions.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:1.5rem">No hay promociones. Crea la primera con "+ Nueva Promoción".</td></tr>';
    return;
  }
  tbody.innerHTML = promotions.map((p) => `
    <tr>
      <td><span class="badge-${p.estado === 'activa' ? 'green' : p.estado === 'programada' ? 'yellow' : p.estado === 'vencida' ? 'red' : 'gray'}" style="font-size:.72rem">${PROMOTION_STATUS_LABELS[p.estado] || p.estado}</span></td>
      <td>
        <strong ${p.color ? `style="color:${escapeHtml(p.color)}"` : ''}>${escapeHtml(p.nombre)}</strong>
        ${p.textoPromocion ? `<div style="font-size:.72rem;color:var(--text3)">${escapeHtml(p.textoPromocion)}</div>` : ''}
        ${p.tipo === 'descuento_por_cantidad' ? `<div style="font-size:.7rem;color:var(--text3)">🔢 Desde ${p.cantidadMinima || '?'} unidades</div>` : ''}
      </td>
      <td>${escapeHtml(p.productoNombre || '—')}<div style="font-size:.72rem;color:var(--text3);font-family:var(--font-mono)">${escapeHtml(p.productoCodigo || '')}</div></td>
      <td style="text-decoration:line-through;color:var(--text3)">${fmt(p.precioOriginal || 0)}</td>
      <td style="font-weight:700;color:var(--success,#22c55e)">${fmt(p.precioPromocion || 0)}</td>
      <td style="font-size:.78rem">${formatPromotionVigencia(p)}</td>
      <td>${p.prioridad}</td>
      <td>
        <button class="btn-xs btn-secondary" type="button" onclick="openPromotionModal(${p.id})" title="Editar">✏️</button>
        <button class="btn-xs btn-secondary" type="button" onclick="togglePromotion(${p.id})" title="${p.deshabilitada ? 'Activar' : 'Desactivar'}">${p.deshabilitada ? '▶️' : '⏸️'}</button>
        <button class="btn-xs btn-secondary" type="button" onclick="viewPromotionAuditLog(${p.id})" title="Historial">🕘</button>
        <button class="btn-xs btn-danger" type="button" onclick="deletePromotion(${p.id})" title="Eliminar">🗑</button>
      </td>
    </tr>
  `).join('');
}

// ── Acciones de fila ─────────────────────────────────────────────────────────
async function togglePromotion(id) {
  try {
    await apiPost(`/api/promotions/${id}/toggle`, {});
    showToast('Promoción actualizada.', 'success');
    loadPromotionsTable();
    if (typeof loadActivePromotionsMap === 'function') loadActivePromotionsMap();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function deletePromotion(id) {
  if (!await showDeleteConfirm('¿Eliminar esta promoción? El producto vuelve a su precio normal de inmediato. Esta acción no se puede deshacer.')) return;
  try {
    const res = await fetch(`/api/promotions/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${DB.authToken || ''}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al eliminar.');
    showToast('Promoción eliminada.', 'success');
    loadPromotionsTable();
    if (typeof loadActivePromotionsMap === 'function') loadActivePromotionsMap();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// ── Modal crear/editar ───────────────────────────────────────────────────────
async function openPromotionModal(id) {
  let promo = null;
  if (id) {
    try {
      const res = await apiGet(`/api/promotions/${id}`);
      promo = res.promotion;
    } catch (e) {
      showToast('No se pudo cargar la promoción: ' + e.message, 'error');
      return;
    }
  }
  _promotionModalProduct = promo
    ? { id: promo.productoId, nombre: promo.productoNombre, codigo: promo.productoCodigo, precioVenta: promo.precioOriginal }
    : null;

  document.getElementById('modal-box').classList.add('product-modal');
  document.getElementById('modal-title').textContent = promo ? 'Editar Promoción' : 'Nueva Promoción';
  const tipoActual = promo?.tipo || 'oferta_precio';
  document.getElementById('modal-body').innerHTML = `
    <div class="form-group span-full">
      <label>Tipo de promoción</label>
      <select id="promo-tipo" class="form-input" onchange="syncPromotionTypeFieldsVisibility()" ${promo ? 'disabled' : ''}>
        <option value="oferta_precio" ${tipoActual === 'oferta_precio' ? 'selected' : ''}>Oferta de Precio — precio fijo de oferta</option>
        <option value="descuento_por_cantidad" ${tipoActual === 'descuento_por_cantidad' ? 'selected' : ''}>Descuento por Cantidad — precio especial al comprar X+ unidades</option>
      </select>
      ${promo ? '<small style="display:block;margin-top:.3rem;color:var(--text3)">El tipo de una promoción no se puede cambiar — elimina y crea una nueva si necesitas otro tipo.</small>' : ''}
    </div>

    <div class="form-group span-full">
      <label>Nombre de la promoción</label>
      <input type="text" id="promo-nombre" class="form-input" value="${promo ? escapeHtml(promo.nombre) : ''}" placeholder="Ej. Oferta de fin de semana">
    </div>

    <div class="form-group span-full">
      <label>Producto</label>
      ${promo ? `
        <div class="form-input is-readonly" style="display:flex;align-items:center;gap:.5rem">
          <strong>${escapeHtml(promo.productoNombre || '')}</strong>
          <span style="color:var(--text3);font-family:var(--font-mono);font-size:.78rem">${escapeHtml(promo.productoCodigo || '')}</span>
        </div>
        <small style="display:block;margin-top:.3rem;color:var(--text3)">El producto de una promoción no se puede cambiar — elimina y crea una nueva si necesitas otro producto.</small>
      ` : `
        <input type="text" id="promo-product-search" class="form-input" placeholder="Busca por código o nombre..." oninput="filterPromotionProductChoices(this.value)" autocomplete="off">
        <div id="promo-product-results" style="margin-top:.4rem"></div>
      `}
      <div id="promo-product-preview" style="margin-top:.6rem"></div>
    </div>

    <div class="modal-grid">
      <div class="form-group">
        <label>Precio normal</label>
        <input type="text" id="promo-precio-normal" class="form-input is-readonly" value="${promo ? fmt(promo.precioOriginal) : ''}" readonly disabled>
      </div>
      <div class="form-group">
        <label id="promo-precio-oferta-label">${tipoActual === 'descuento_por_cantidad' ? 'Precio especial por unidad' : 'Precio de oferta'}</label>
        <input type="number" id="promo-precio-oferta" class="form-input" min="0" step="0.01" value="${promo ? promo.precioPromocion : ''}" oninput="updatePromotionPreview()">
      </div>
    </div>
    <div class="modal-grid" id="promo-cantidad-fields" style="${tipoActual === 'descuento_por_cantidad' ? '' : 'display:none'}">
      <div class="form-group">
        <label>Cantidad mínima <small style="color:var(--text3)">(unidades en el mismo carrito)</small></label>
        <input type="number" id="promo-cantidad-minima" class="form-input" min="2" step="1" value="${promo?.cantidadMinima || ''}">
      </div>
    </div>
    <div id="promo-savings-preview" style="margin:.4rem 0 .8rem"></div>

    <div class="form-group span-full">
      <label><input type="checkbox" id="promo-permanente" ${promo?.permanente ? 'checked' : ''} onchange="syncPromotionDateFieldsVisibility()"> Oferta permanente (sin fecha de fin)</label>
    </div>
    <div class="modal-grid" id="promo-date-fields" style="${promo?.permanente ? 'display:none' : ''}">
      <div class="form-group">
        <label>Fecha inicio</label>
        <input type="date" id="promo-fecha-inicio" class="form-input" value="${promo?.fechaInicio ? String(promo.fechaInicio).slice(0, 10) : ''}">
      </div>
      <div class="form-group">
        <label>Fecha fin</label>
        <input type="date" id="promo-fecha-fin" class="form-input" value="${promo?.fechaFin ? String(promo.fechaFin).slice(0, 10) : ''}">
      </div>
    </div>
    <div class="modal-grid">
      <div class="form-group">
        <label>Hora inicio <small style="color:var(--text3)">(opcional, ej. Happy Hour)</small></label>
        <input type="time" id="promo-hora-inicio" class="form-input" value="${promo?.horaInicio ? String(promo.horaInicio).slice(0, 5) : ''}">
      </div>
      <div class="form-group">
        <label>Hora fin</label>
        <input type="time" id="promo-hora-fin" class="form-input" value="${promo?.horaFin ? String(promo.horaFin).slice(0, 5) : ''}">
      </div>
    </div>

    <div class="modal-grid">
      <div class="form-group">
        <label>Prioridad <small style="color:var(--text3)">(mayor número = gana si hay varias)</small></label>
        <input type="number" id="promo-prioridad" class="form-input" value="${promo ? promo.prioridad : 0}" min="0" step="1">
      </div>
      <div class="form-group">
        <label>Color identificador</label>
        <input type="color" id="promo-color" class="form-input" value="${promo?.color || '#22c55e'}" style="height:42px">
      </div>
    </div>
    <div class="form-group span-full">
      <label>Texto promocional <small style="color:var(--text3)">(se muestra en el POS y el ticket)</small></label>
      <input type="text" id="promo-texto" class="form-input" value="${promo ? escapeHtml(promo.textoPromocion || '') : ''}" placeholder="Ej. -20%, Oferta especial">
    </div>
    <div class="form-group span-full">
      <label>Observaciones</label>
      <textarea id="promo-descripcion" class="form-input" rows="2" placeholder="Notas internas (opcional)">${promo ? escapeHtml(promo.descripcion || '') : ''}</textarea>
    </div>
  `;
  document.getElementById('modal-footer').innerHTML = `
    <button class="btn-secondary" onclick="closeAllModals()">Cancelar</button>
    ${promo ? `<button class="btn-ghost" style="color:var(--danger,#ef4444)" onclick="closeAllModals();deletePromotion(${promo.id})">Eliminar</button>` : ''}
    <button class="btn-primary" onclick="savePromotion(${promo ? promo.id : 'null'})">💾 Guardar</button>
  `;
  document.getElementById('modal-overlay').classList.remove('hidden');
  if (promo) updatePromotionPreview();
}

function filterPromotionProductChoices(query) {
  const resultsEl = document.getElementById('promo-product-results');
  if (!resultsEl) return;
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) { resultsEl.innerHTML = ''; return; }
  const matches = (DB.productos || [])
    .filter((p) => String(p.nombre || '').toLowerCase().includes(q) || String(p.codigo || '').toLowerCase().includes(q))
    .slice(0, 8);
  if (!matches.length) {
    resultsEl.innerHTML = '<div class="ncf-ref-no-results">Sin resultados</div>';
    return;
  }
  resultsEl.innerHTML = matches.map((p) => `
    <div class="ncf-ref-item" onclick='selectPromotionProduct(${p.id})'>
      <span class="ncf-ref-item-ncf">${escapeHtml(p.codigo || '')}</span>
      <span class="ncf-ref-item-client">${escapeHtml(p.nombre)}</span>
      <span class="ncf-ref-item-total">${fmt(p.precioVenta || 0)}</span>
    </div>
  `).join('');
}

function selectPromotionProduct(productId) {
  const product = (DB.productos || []).find((p) => Number(p.id) === Number(productId));
  if (!product) return;
  _promotionModalProduct = product;
  const searchInput = document.getElementById('promo-product-search');
  if (searchInput) searchInput.value = `${product.codigo} — ${product.nombre}`;
  const resultsEl = document.getElementById('promo-product-results');
  if (resultsEl) resultsEl.innerHTML = '';
  const precioNormalInput = document.getElementById('promo-precio-normal');
  if (precioNormalInput) precioNormalInput.value = fmt(product.precioVenta || 0);
  updatePromotionPreview();
}

function updatePromotionPreview() {
  const previewProductEl = document.getElementById('promo-product-preview');
  const previewSavingsEl = document.getElementById('promo-savings-preview');
  const product = _promotionModalProduct;
  const precioOferta = Number(document.getElementById('promo-precio-oferta')?.value || 0);

  if (previewProductEl) {
    previewProductEl.innerHTML = product ? `
      <div class="product-form-card" style="display:flex;gap:1rem;flex-wrap:wrap">
        <div><small style="color:var(--text3)">Costo</small><br><strong>${fmt(product.precioCompra || 0)}</strong></div>
        <div><small style="color:var(--text3)">Precio normal</small><br><strong>${fmt(product.precioVenta || 0)}</strong></div>
        <div><small style="color:var(--text3)">Existencia</small><br><strong>${Number(product.stock || 0)}</strong></div>
      </div>
    ` : '';
  }

  if (previewSavingsEl) {
    if (!product || !(precioOferta > 0)) { previewSavingsEl.innerHTML = ''; return; }
    const precioNormal = Number(product.precioVenta || 0);
    const ahorro = precioNormal - precioOferta;
    const costo = Number(product.precioCompra || 0);
    const utilidad = precioOferta - costo;
    const belowCost = costo > 0 && precioOferta < costo;
    previewSavingsEl.innerHTML = `
      <div class="product-form-card" style="display:flex;gap:1rem;flex-wrap:wrap;${belowCost ? 'border-color:var(--danger,#ef4444)' : ''}">
        <div><small style="color:var(--text3)">Ahorro cliente</small><br><strong style="color:var(--success,#22c55e)">${fmt(Math.max(0, ahorro))}</strong></div>
        <div><small style="color:var(--text3)">Utilidad tras promoción</small><br><strong style="${belowCost ? 'color:var(--danger,#ef4444)' : ''}">${fmt(utilidad)}</strong></div>
        ${belowCost ? '<div style="color:var(--danger,#ef4444);font-weight:700">⚠ Por debajo del costo — solo un administrador puede guardar esto.</div>' : ''}
      </div>
    `;
  }
}

function syncPromotionDateFieldsVisibility() {
  const permanente = document.getElementById('promo-permanente')?.checked;
  const dateFields = document.getElementById('promo-date-fields');
  if (dateFields) dateFields.style.display = permanente ? 'none' : '';
}

function syncPromotionTypeFieldsVisibility() {
  const tipo = document.getElementById('promo-tipo')?.value || 'oferta_precio';
  const cantidadFields = document.getElementById('promo-cantidad-fields');
  if (cantidadFields) cantidadFields.style.display = tipo === 'descuento_por_cantidad' ? '' : 'none';
  const precioLabel = document.getElementById('promo-precio-oferta-label');
  if (precioLabel) precioLabel.textContent = tipo === 'descuento_por_cantidad' ? 'Precio especial por unidad' : 'Precio de oferta';
}

async function savePromotion(id) {
  const nombre = document.getElementById('promo-nombre')?.value.trim();
  const precioPromocion = Number(document.getElementById('promo-precio-oferta')?.value || 0);
  const tipo = document.getElementById('promo-tipo')?.value || 'oferta_precio';
  if (!nombre) { showToast('Ingresa un nombre para la promoción.', 'warning'); return; }
  if (!_promotionModalProduct) { showToast('Selecciona un producto.', 'warning'); return; }
  if (!(precioPromocion > 0)) { showToast('Ingresa un precio de oferta válido.', 'warning'); return; }

  let cantidadMinima = null;
  if (tipo === 'descuento_por_cantidad') {
    cantidadMinima = Number(document.getElementById('promo-cantidad-minima')?.value || 0);
    if (!Number.isInteger(cantidadMinima) || cantidadMinima < 2) {
      showToast('Ingresa una cantidad mínima entera de 2 o más.', 'warning');
      return;
    }
  }

  const permanente = Boolean(document.getElementById('promo-permanente')?.checked);
  const payload = {
    nombre,
    tipo,
    productoId: _promotionModalProduct.id,
    precioPromocion,
    cantidadMinima,
    permanente,
    fechaInicio: permanente ? null : (document.getElementById('promo-fecha-inicio')?.value || null),
    fechaFin: permanente ? null : (document.getElementById('promo-fecha-fin')?.value || null),
    horaInicio: document.getElementById('promo-hora-inicio')?.value || null,
    horaFin: document.getElementById('promo-hora-fin')?.value || null,
    prioridad: Number(document.getElementById('promo-prioridad')?.value || 0),
    color: document.getElementById('promo-color')?.value || null,
    textoPromocion: document.getElementById('promo-texto')?.value.trim() || '',
    descripcion: document.getElementById('promo-descripcion')?.value.trim() || '',
  };

  try {
    if (id) {
      await fetch(`/api/promotions/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken || ''}` },
        body: JSON.stringify(payload),
      }).then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Error al guardar.');
      });
    } else {
      await apiPost('/api/promotions', payload);
    }
    showToast('Promoción guardada.', 'success');
    closeAllModals();
    loadPromotionsTable();
    if (typeof loadActivePromotionsMap === 'function') loadActivePromotionsMap();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// ── Mapa de promociones activas — consumido por ventas.js ───────────────────
// Se llama al entrar al módulo de Ventas y se refresca cada 60s mientras el
// cajero sigue ahí, para que una promoción que se desactiva o vence no se
// quede pegada en el carrito.
let _activePromotionsPollTimer = null;
async function loadActivePromotionsMap() {
  try {
    const isOffline = window.offlineManager?.getState?.()?.isOnline === false;
    const endpoint = isOffline ? '/api/offline/promotions/active-map' : '/api/promotions/active-map';
    const res = await apiGet(endpoint);
    DB.activePromotions = res.activeMap || {};
    DB.quantityPromotions = res.quantityMap || {};
  } catch (_e) {
    // Sin promociones no se rompe la venta — el POS sigue funcionando a precio normal.
    DB.activePromotions = DB.activePromotions || {};
    DB.quantityPromotions = DB.quantityPromotions || {};
  }
  if (typeof renderSaleTable === 'function') renderSaleTable();
  if (!_activePromotionsPollTimer) {
    _activePromotionsPollTimer = setInterval(() => {
      if (document.getElementById('module-ventas')?.classList.contains('active')) loadActivePromotionsMap();
    }, 60000);
  }
}

// ── Pestañas del módulo ──────────────────────────────────────────────────────
const PROMOTIONS_TABS = ['dashboard', 'activas', 'estadisticas', 'historial', 'config'];
function switchPromotionsTab(tab) {
  PROMOTIONS_TABS.forEach((t) => {
    document.getElementById(`promo-panel-${t}`)?.classList.toggle('hidden', t !== tab);
    document.getElementById(`promo-tab-btn-${t}`)?.classList.toggle('active', t === tab);
  });
  // La barra de búsqueda/filtro/"+ Nueva Promoción" solo aplica a la pestaña Activas.
  const actionsBar = document.getElementById('promociones-tab-actions');
  if (actionsBar) actionsBar.style.display = tab === 'activas' ? '' : 'none';

  if (tab === 'dashboard') loadPromotionsDashboard();
  else if (tab === 'activas') loadPromotionsTable();
  else if (tab === 'estadisticas') loadPromotionStats();
  else if (tab === 'historial') loadPromotionsAuditLog();
  else if (tab === 'config') loadPromotionsConfig();
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function loadPromotionsDashboard() {
  try {
    const d = await apiGet('/api/promotions/reports/dashboard');
    document.getElementById('pd-activas').textContent = d.promocionesActivas;
    document.getElementById('pd-programadas').textContent = d.promocionesProgramadas;
    document.getElementById('pd-vencidas').textContent = d.promocionesVencidas;
    document.getElementById('pd-permanentes').textContent = d.promocionesPermanentes;
    document.getElementById('pd-productos').textContent = d.productosEnPromocion;
    document.getElementById('pd-ventas').textContent = d.ventasConPromo;
    document.getElementById('pd-descontado').textContent = fmt(d.montoDescontado || 0);
    document.getElementById('pd-ganancia').textContent = fmt(d.gananciaObtenida || 0);
    document.getElementById('pd-mas-utilizada').textContent = d.promocionMasUtilizada
      ? `${d.promocionMasUtilizada.nombre} (${d.promocionMasUtilizada.ventas} ventas)`
      : 'Todavía no hay ventas con promociones.';
    document.getElementById('pd-proxima-vencer').textContent = d.promocionProximaVencer
      ? `${d.promocionProximaVencer.nombre} — vence ${String(d.promocionProximaVencer.fechaFin).slice(0, 10)}`
      : 'No hay promociones con fecha de vencimiento próxima.';
  } catch (e) {
    showToast('Error al cargar el dashboard: ' + e.message, 'error');
  }
}

// ── Estadísticas ──────────────────────────────────────────────────────────────
let _promotionStatsCache = { promotions: [], neverUsed: [] };
async function loadPromotionStats() {
  const tbody = document.getElementById('promo-stats-table-body');
  const neverUsedEl = document.getElementById('promo-stats-never-used');
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:1.5rem">Cargando…</td></tr>';
  try {
    const res = await apiGet('/api/promotions/reports/stats');
    _promotionStatsCache = res;
    if (!res.promotions.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:1.5rem">Todavía no hay ventas con promociones.</td></tr>';
    } else {
      tbody.innerHTML = res.promotions.map((p) => `
        <tr>
          <td>${escapeHtml(p.nombre)}</td>
          <td>${escapeHtml(p.producto)}</td>
          <td>${p.ventas}</td>
          <td>${p.unidadesVendidas}</td>
          <td>${fmt(p.montoDescontado)}</td>
          <td>${fmt(p.gananciaGenerada)}</td>
          <td>${p.clientesBeneficiados}</td>
        </tr>
      `).join('');
    }
    if (neverUsedEl) {
      neverUsedEl.innerHTML = res.neverUsed.length
        ? `<strong>Promociones nunca utilizadas:</strong> ${res.neverUsed.map((p) => escapeHtml(p.nombre)).join(', ')}`
        : '';
    }
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--danger,#ef4444);padding:1.5rem">Error: ${escapeHtml(e.message)}</td></tr>`;
  }
}

async function exportPromotionStats(format) {
  const rows = _promotionStatsCache.promotions || [];
  if (!rows.length) { showToast('No hay datos de estadísticas para exportar.', 'warning'); return; }
  const headers = ['Promoción', 'Producto', 'Ventas', 'Unidades', 'Descontado', 'Ganancia', 'Clientes'];
  const data = rows.map((p) => [p.nombre, p.producto, p.ventas, p.unidadesVendidas, p.montoDescontado.toFixed(2), p.gananciaGenerada.toFixed(2), p.clientesBeneficiados]);

  if (format === 'csv') {
    const csv = [headers.join(','), ...data.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'estadisticas-promociones.csv';
    link.click();
    return;
  }

  if (format === 'excel') {
    await window.VendorLoader.load('xlsx').catch((error) => {
      showToast(error.message, 'error');
    });
    if (typeof XLSX === 'undefined') { showToast('Librería de Excel no disponible.', 'error'); return; }
    const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Promociones');
    XLSX.writeFile(wb, 'estadisticas-promociones.xlsx');
    return;
  }

  if (format === 'pdf') {
    await window.VendorLoader.load('jspdf').catch((error) => {
      showToast(error.message, 'error');
    });
    const jsPDFCtor = (typeof jspdf !== 'undefined' && jspdf.jsPDF) ? jspdf.jsPDF : window.jsPDF;
    if (!jsPDFCtor) { showToast('Librería de PDF no disponible.', 'error'); return; }
    const doc = new jsPDFCtor();
    doc.setFontSize(14);
    doc.text('Estadísticas de Promociones', 14, 16);
    let y = 26;
    doc.setFontSize(9);
    doc.text(headers.join('  |  '), 14, y);
    y += 6;
    data.forEach((row) => {
      doc.text(row.join('  |  '), 14, y);
      y += 6;
      if (y > 280) { doc.addPage(); y = 16; }
    });
    doc.save('estadisticas-promociones.pdf');
  }
}

// ── Historial ─────────────────────────────────────────────────────────────────
const PROMOTION_AUDIT_LABELS = {
  creada: '🆕 Creada',
  editada: '✏️ Editada',
  activada: '▶️ Activada',
  desactivada: '⏸️ Desactivada',
  eliminada: '🗑 Eliminada',
  finalizada: '🏁 Finalizada',
};
async function loadPromotionsAuditLog() {
  const tbody = document.getElementById('promo-audit-table-body');
  if (tbody) tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text3);padding:1.5rem">Cargando…</td></tr>';
  try {
    const res = await apiGet('/api/promotions/reports/audit-log');
    if (!res.entries.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text3);padding:1.5rem">Sin actividad registrada todavía.</td></tr>';
      return;
    }
    tbody.innerHTML = res.entries.map((e) => `
      <tr>
        <td style="font-size:.78rem;color:var(--text3)">${new Date(e.createdAt).toLocaleString('es-DO')}</td>
        <td>${escapeHtml(e.promotionNombre)}</td>
        <td>${PROMOTION_AUDIT_LABELS[e.accion] || e.accion}</td>
        <td>${escapeHtml(e.usuario)}</td>
      </tr>
    `).join('');
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--danger,#ef4444);padding:1.5rem">Error: ${escapeHtml(e.message)}</td></tr>`;
  }
}

// Historial de UNA promoción — usado desde un botón futuro en la fila del listado.
async function viewPromotionAuditLog(id) {
  try {
    const res = await apiGet(`/api/promotions/${id}/audit-log`);
    if (!res.entries.length) { showToast('Esta promoción todavía no tiene historial.', 'info'); return; }
    const lines = res.entries.map((e) => `${new Date(e.createdAt).toLocaleString('es-DO')} — ${PROMOTION_AUDIT_LABELS[e.accion] || e.accion} por ${e.usuario}`);
    alert(lines.join('\n'));
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// ── Configuración ─────────────────────────────────────────────────────────────
async function loadPromotionsConfig() {
  try {
    const cfg = await apiGet('/api/promotions/settings/config');
    document.getElementById('pc-enabled').checked = cfg.enabled;
    document.getElementById('pc-allow-permanent').checked = cfg.allowPermanent;
    document.getElementById('pc-allow-future').checked = cfg.allowFuture;
    document.getElementById('pc-default-priority').value = cfg.defaultPriority;
    document.getElementById('pc-default-color').value = cfg.defaultColor;
  } catch (e) {
    showToast('Error al cargar configuración: ' + e.message, 'error');
  }
}

async function savePromotionsConfig() {
  try {
    await fetch('/api/promotions/settings/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken || ''}` },
      body: JSON.stringify({
        enabled: document.getElementById('pc-enabled').checked,
        allowPermanent: document.getElementById('pc-allow-permanent').checked,
        allowFuture: document.getElementById('pc-allow-future').checked,
        defaultPriority: Number(document.getElementById('pc-default-priority').value || 0),
        defaultColor: document.getElementById('pc-default-color').value,
      }),
    }).then(async (r) => {
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Error al guardar.');
    });
    showToast('Configuración guardada.', 'success');
    if (typeof loadActivePromotionsMap === 'function') loadActivePromotionsMap();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// ── Alertas automáticas — integradas a la campanita de notificaciones ────────
// Se refresca solo (independiente de que el cajero visite el módulo) para que
// las alertas aparezcan aunque nunca abra Centro de Promociones.
async function refreshPromotionAlertsData() {
  try {
    const res = await apiGet('/api/promotions');
    _promotionsCache = res.promotions || [];
  } catch (_e) { /* silencioso — no bloquea el resto de la app */ }
  if (typeof updateNotifications === 'function') updateNotifications();
}

function buildPromotionNotifications() {
  const notifications = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const todayKey = today.toISOString().slice(0, 10);
  const tomorrowKey = tomorrow.toISOString().slice(0, 10);

  (_promotionsCache || []).forEach((p) => {
    if (p.permanente) return;
    const fin = p.fechaFin ? String(p.fechaFin).slice(0, 10) : null;
    const inicio = p.fechaInicio ? String(p.fechaInicio).slice(0, 10) : null;

    if (p.estado === 'activa' && fin === todayKey) {
      notifications.push({ severity: 'warning', title: `Promoción vence hoy`, text: `"${p.nombre}" vence hoy.`, time: 'Promociones' });
    } else if (p.estado === 'activa' && fin === tomorrowKey) {
      notifications.push({ severity: 'info', title: `Promoción vence mañana`, text: `"${p.nombre}" vence mañana.`, time: 'Promociones' });
    }
    if (p.estado === 'programada' && inicio === todayKey) {
      notifications.push({ severity: 'success', title: `Promoción comienza hoy`, text: `"${p.nombre}" empieza hoy.`, time: 'Promociones' });
    }
  });

  return notifications;
}

document.addEventListener('DOMContentLoaded', () => {
  refreshPromotionAlertsData();
  setInterval(refreshPromotionAlertsData, 5 * 60 * 1000);
});
