const movimientosFilters = {
  search: '',
  module: 'todos'
};

function movementText(value) {
  return typeof window.translateCatalogText === 'function'
    ? window.translateCatalogText(String(value || ''))
    : String(value || '');
}

function movementLocale() {
  return typeof getCurrentLocale === 'function' ? getCurrentLocale() : 'es-DO';
}

function toggleMovimientosAuditPanel() {
  const panel = document.getElementById('movimientos-audit-panel');
  if (!panel) return;
  panel.classList.toggle('collapsed');
}

function getFilteredMovimientos() {
  const query = movimientosFilters.search.toLowerCase().trim();
  return (DB.movimientosSistema || []).filter((item) => {
    const matchesModule = movimientosFilters.module === 'todos' || item.modulo === movimientosFilters.module;
    const matchesSearch = !query || [
      item.usuario,
      item.rol,
      item.modulo,
      item.accion,
      item.detalle || ''
    ].some((value) => String(value || '').toLowerCase().includes(query));
    return matchesModule && matchesSearch;
  });
}

function getRecentMovimientosSales() {
  return [...(DB.ventas || [])]
    .sort((a, b) => {
      const left = new Date(b.fecha).getTime();
      const right = new Date(a.fecha).getTime();
      return left - right;
    })
    .slice(0, 10);
}

function syncMovimientosModuleFilter() {
  const select = document.getElementById('movimientos-module-filter');
  if (!select) return;
  const current = movimientosFilters.module;
  const modules = [...new Set((DB.movimientosSistema || []).map((item) => item.modulo).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  select.innerHTML = `<option value="todos">${movementText('Todos los módulos')}</option>` + modules.map((name) => `<option value="${name}">${movementText(name)}</option>`).join('');
  select.value = current;
}

function filterMovimientos() {
  movimientosFilters.search = document.getElementById('movimientos-search')?.value || '';
  movimientosFilters.module = document.getElementById('movimientos-module-filter')?.value || 'todos';
  renderMovimientosSistema();
}

function renderMovimientosSistema() {
  const tbody = document.getElementById('movimientos-sistema-tbody');
  const totalEl = document.getElementById('movimientos-total');
  const todayEl = document.getElementById('movimientos-hoy');
  const usersEl = document.getElementById('movimientos-usuarios');
  const logCountEl = document.getElementById('movimientos-log-count');
  const salesCountEl = document.getElementById('movimientos-sales-count');
  if (!tbody || !totalEl || !todayEl || !usersEl) return;

  const list = getFilteredMovimientos();
  const today = new Date().toISOString().slice(0, 10);
  const activeSales = (DB.ventas || []).filter((sale) => !sale.cancelada);

  totalEl.textContent = list.length;
  todayEl.textContent = list.filter((item) => String(item.fecha || '').slice(0, 10) === today).length;
  usersEl.textContent = new Set(list.map((item) => item.usuario)).size;
  if (logCountEl) logCountEl.textContent = `${list.length} ${movementText(list.length === 1 ? 'evento' : 'eventos')}`;
  if (salesCountEl) salesCountEl.textContent = `${activeSales.length} ${movementText('activas')}`;

  tbody.innerHTML = list.map((item) => `
    <tr>
      <td style="font-family:var(--font-mono);font-size:0.8rem">${formatMovimientoDate(item.fecha)}</td>
      <td style="font-weight:600">${item.usuario}</td>
      <td>${getRolBadge(item.rol)}</td>
      <td><span class="badge badge-info">${movementText(item.modulo)}</span></td>
      <td>${movementText(item.accion)}</td>
      <td style="color:var(--text2)">${item.detalle ? movementText(item.detalle) : '—'}</td>
    </tr>
  `).join('') || `<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text3)">${movementText('No hay movimientos registrados')}</td></tr>`;

  if (!document.getElementById('cancel-sale-result')?.dataset.locked) {
    resetCancelSaleResult();
  }
  if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('module-movimientos'));
}

function handleCancelSaleCodeKey(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    lookupCancelSale();
  }
}

function resetCancelSaleResult(message = movementText('Todavía no has buscado ninguna factura.')) {
  const container = document.getElementById('cancel-sale-result');
  if (!container) return;
  container.dataset.locked = '';
  container.innerHTML = `<div class="cancel-sale-empty">${message}</div>`;
}

function lookupCancelSale() {
  const input = document.getElementById('cancel-sale-code');
  const container = document.getElementById('cancel-sale-result');
  if (!input || !container) return;

  const invoiceNumber = String(input.value || '').trim();
  if (!invoiceNumber) {
    resetCancelSaleResult(movementText('Escribe un código de factura para consultarla.'));
    return;
  }

  const sale = (DB.ventas || []).find((item) => String(item.id || '').toLowerCase() === invoiceNumber.toLowerCase());
  if (!sale) {
    container.dataset.locked = '1';
    container.innerHTML = `<div class="cancel-sale-empty">${movementText('No se encontró una factura con ese código.')}</div>`;
    return;
  }

  renderCancelSaleLookupResult(sale);
}

function formatMovimientoDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(movementLocale(), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function renderCancelSaleLookupResult(sale) {
  const container = document.getElementById('cancel-sale-result');
  if (!container) return;
  container.dataset.locked = '1';

  const tipoPedido = movementText({
    mostrador: 'Mostrador',
    delivery: 'Delivery',
    recoger: 'Recoger',
    mesa: 'Mesa'
  }[sale.tipoPedido] || 'Mostrador');
  const metodo = movementText({
    efectivo: 'Efectivo',
    tarjeta: 'Tarjeta',
    transferencia: 'Transferencia',
    credito: 'Crédito'
  }[sale.metodo] || sale.metodo);
  const statusClass = sale.cancelada ? 'cancelada' : 'emitida';
  const statusLabel = movementText(sale.cancelada ? 'Cancelada' : 'Emitida');

  container.innerHTML = `
    <div class="cancel-sale-card">
      <div class="cancel-sale-card-head">
        <div class="cancel-sale-card-title">
          <strong>${sale.id}</strong>
          <span>${sale.cliente || movementText('Consumidor Final')}</span>
        </div>
        <div class="cancel-sale-card-amount">${fmt(sale.total)}</div>
      </div>
      <div class="cancel-sale-card-meta">
        <span class="cancel-sale-chip">${tipoPedido}</span>
        <span class="cancel-sale-chip">${metodo}</span>
        <span class="cancel-sale-chip">${formatMovimientoDate(sale.fecha)}</span>
        <span class="cancel-sale-status ${statusClass}">${statusLabel}</span>
      </div>
      <div class="cancel-sale-card-details">
        <div class="cancel-sale-detail">
          <div class="cancel-sale-detail-label">${movementText('Cajero')}</div>
          <div class="cancel-sale-detail-value">${sale.cajero || '—'}</div>
        </div>
        <div class="cancel-sale-detail">
          <div class="cancel-sale-detail-label">${movementText('Productos')}</div>
          <div class="cancel-sale-detail-value">${(sale.items || []).length}</div>
        </div>
      </div>
      ${sale.cancelada
        ? `<div class="cancel-sale-detail">
            <div class="cancel-sale-detail-label">${movementText('Detalle de cancelación')}</div>
            <div class="cancel-sale-detail-value">${sale.motivoCancelacion ? movementText(sale.motivoCancelacion) : movementText('Sin detalle')}${sale.canceladaPor ? ` · ${movementText('por')} ${sale.canceladaPor}` : ''}</div>
          </div>`
        : `<div class="form-group" style="margin-bottom:0">
            <label>${movementText('Motivo de cancelación')}</label>
            <textarea id="cancel-sale-reason" class="form-input" rows="3" placeholder="${movementText('Ej: error de captura, cliente desistió, pedido duplicado')}"></textarea>
          </div>`}
      <div class="cancel-sale-card-actions">
        <button class="btn-edit" onclick="showReceiptFromHistory('${sale.id}')">🧾 ${movementText('Ver factura')}</button>
        ${sale.cancelada
          ? `<button class="btn-secondary" type="button" onclick="clearCancelSaleLookup()">${movementText('Nueva búsqueda')}</button>`
          : `<button class="btn-danger" onclick="confirmCancelSale('${sale.id}')">✕ ${movementText('Cancelar factura')}</button>`}
      </div>
    </div>
  `;
  if (typeof translateDynamicUi === 'function') translateDynamicUi(container);
}

function clearCancelSaleLookup() {
  const input = document.getElementById('cancel-sale-code');
  if (input) input.value = '';
  resetCancelSaleResult();
}

async function confirmCancelSale(invoiceNumber) {
  const reason = document.getElementById('cancel-sale-reason')?.value.trim();
  if (!reason) {
    showToast(movementText('Indica el motivo de cancelación.'), 'error');
    return;
  }

  try {
    const response = await api.cancelSale(invoiceNumber, {
      reason,
      ...getActorPayload()
    });
    const updatedSale = response.sale;
    DB.ventas = (DB.ventas || []).map((item) => item.id === updatedSale.id ? updatedSale : item);
    if (response.config) {
      DB.config = { ...DB.config, ...response.config };
    }
    await refreshAuditLogs();
    if (typeof updateInventoryStats === 'function') updateInventoryStats();
    if (typeof updateReportes === 'function') updateReportes();
    if (typeof syncCajaState === 'function') syncCajaState();
    renderCancelSaleLookupResult(updatedSale);
    if (typeof renderMovimientosSistema === 'function') renderMovimientosSistema();
    showToast(movementText('Factura cancelada correctamente'), 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}
