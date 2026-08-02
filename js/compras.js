// ===== TECNO_CAJA - COMPRAS Y GASTOS (Fase 1: Compras + Cuentas por pagar; Fase 2: Gastos) =====
//
// Compras registra mercancía con renglones de producto: el backend
// (server/routes/compras.routes.js) actualiza inventario/costo y genera
// automáticamente la cuenta por pagar reutilizando supplier_invoices —
// por eso "Registrar pago" aquí llama directo a openSupplierPaymentModal/
// saveSupplierPayment de js/proveedores.js en vez de duplicar esa lógica.
//
// Gastos (server/routes/gastos.routes.js) es un registro fiscal aparte
// (categoría, NCF, ITBIS, retenciones ISR/ITBIS) — NO descuenta Tesorería/
// Caja General a propósito, mismo criterio que Compras al contado.
//
// NO incluye DGII 606 ni contabilidad — eso vive en tecno-caja-contadores,
// fuera de alcance de esta fase.

let purchaseItemsDraft = [];
let _comprasActiveTab = 'compras';
let _cuentasPorPagarFiltro = 'todas';
let _expenseCategoriesCache = null;

function comprasLocale() {
  return typeof getCurrentLocale === 'function' ? getCurrentLocale() : 'es-DO';
}

function fmtCompraFecha(v) {
  if (!v) return '—';
  const d = new Date(String(v).length <= 10 ? `${v}T00:00:00` : v);
  return isNaN(d) ? String(v) : d.toLocaleDateString(comprasLocale());
}

// ── Tabs ──────────────────────────────────────────────────────────────────
function showComprasTab(tab) {
  _comprasActiveTab = tab;
  document.querySelectorAll('#module-compras .compras-tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('#module-compras .compras-tab-pane').forEach((pane) => {
    pane.classList.toggle('hidden', pane.id !== `compras-tab-${tab}`);
  });
  if (tab === 'compras') loadComprasTable();
  if (tab === 'cuentas-por-pagar') loadCuentasPorPagar();
  if (tab === 'gastos') loadGastosTable();
}

function initComprasModule() {
  showComprasTab(_comprasActiveTab);
}

// ── Listado de compras ───────────────────────────────────────────────────
async function loadComprasTable() {
  const container = document.getElementById('compras-list');
  if (!container) return;
  container.innerHTML = '<div class="loading-text">Cargando…</div>';
  try {
    const rows = await api.getPurchases();
    DB.compras = rows || [];
    renderComprasTable();
  } catch (e) {
    container.innerHTML = `<div class="error-text">Error al cargar: ${e.message}</div>`;
  }
}

function renderComprasTable() {
  const container = document.getElementById('compras-list');
  if (!container) return;
  const rows = DB.compras || [];
  if (!rows.length) {
    container.innerHTML = '<div class="empty-state-small" style="padding:1rem;text-align:center;color:var(--text3)">No hay compras registradas todavía.</div>';
    return;
  }
  const canAnular = typeof currentUserCan === 'function' && currentUserCan('compras.anular');
  container.innerHTML = `
    <table class="compact-table" style="width:100%;font-size:0.85rem">
      <thead><tr>
        <th>Fecha</th><th>Proveedor</th><th>Documento</th><th>Sucursal</th><th>Condición</th><th>Total</th><th>Estado</th><th></th>
      </tr></thead>
      <tbody>
        ${rows.map((p) => `
          <tr>
            <td>${fmtCompraFecha(p.fechaComprobante)}</td>
            <td>${escapeHtml(p.proveedor)}</td>
            <td>${escapeHtml(p.numeroDocumento)}${p.ncf ? ' · ' + escapeHtml(p.ncf) : ''}</td>
            <td>${escapeHtml(p.sucursal || '—')}</td>
            <td>${p.condicionPago === 'credito' ? 'Crédito' : 'Contado'}</td>
            <td>${fmt(p.total)}</td>
            <td><span class="badge ${p.estado === 'activa' ? 'badge-success' : 'badge-danger'}">${p.estado === 'activa' ? 'Activa' : 'Anulada'}</span></td>
            <td>
              <button class="btn-xs btn-secondary" type="button" onclick="verCompra(${p.id})" title="Ver">👁</button>
              ${p.estado === 'activa' && canAnular
                ? `<button class="btn-xs btn-danger" type="button" onclick="anularCompra(${p.id})" title="Anular">🛑</button>`
                : ''}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

// ── Nueva compra ──────────────────────────────────────────────────────────
function openNuevaCompraModal() {
  purchaseItemsDraft = [];
  const suppliers = (DB.proveedores || []).filter((p) => p.estado === 'Activo');
  const branches = DB.sucursales || [];
  const today = new Date().toISOString().slice(0, 10);
  const defaultBranchId = Number(DB.config?.activeBranchId || 0) || Number(branches[0]?.id || 0) || '';

  document.getElementById('modal-title').textContent = 'Nueva Compra';
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-grid">
      <div class="form-group"><label>Proveedor *</label>
        <select id="compra-supplier" class="form-input" onchange="syncCompraFechaVencimiento()">
          ${suppliers.map((p) => `<option value="${p.id}">${escapeHtml(p.nombre)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>Sucursal *</label>
        <select id="compra-branch" class="form-input">
          ${branches.map((b) => `<option value="${b.id}" ${Number(b.id) === Number(defaultBranchId) ? 'selected' : ''}>${escapeHtml(b.nombre)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>No. Documento del proveedor *</label><input type="text" id="compra-numero" class="form-input" placeholder="FAC-000123"></div>
      <div class="form-group"><label>NCF</label><input type="text" id="compra-ncf" class="form-input" placeholder="B0100000001"></div>
      <div class="form-group"><label>Fecha comprobante *</label><input type="date" id="compra-fecha" class="form-input" value="${today}" onchange="syncCompraFechaVencimiento()"></div>
      <div class="form-group"><label>Fecha recepción</label><input type="date" id="compra-recepcion" class="form-input" value="${today}"></div>
      <div class="form-group"><label>Condición de pago *</label>
        <select id="compra-condicion" class="form-input" onchange="toggleCompraVencimiento()">
          <option value="contado">Contado</option>
          <option value="credito">Crédito</option>
        </select>
      </div>
      <div class="form-group" id="compra-vencimiento-group" style="display:none">
        <label>Fecha de vencimiento *</label><input type="date" id="compra-vencimiento" class="form-input">
      </div>
      <div class="form-group span-full"><label>Notas</label><input type="text" id="compra-notas" class="form-input" placeholder="Observaciones de la compra"></div>
    </div>
    <div style="margin-top:1rem">
      <label style="font-weight:600">Productos</label>
      <div style="position:relative;margin:0.4rem 0">
        <input type="text" id="compra-product-search" class="form-input" placeholder="Buscar producto por nombre o código…" oninput="_searchCompraProducts(this.value)" autocomplete="off">
        <div id="compra-search-dropdown" class="search-dropdown hidden" style="position:absolute;z-index:20;width:100%"></div>
      </div>
      <table class="compact-table" style="width:100%;font-size:0.82rem">
        <thead><tr><th>Producto</th><th>Cant.</th><th>Costo Unit.</th><th>ITBIS %</th><th>Subtotal</th><th></th></tr></thead>
        <tbody id="compra-items-body"><tr><td colspan="6" style="text-align:center;color:var(--text3)">Agrega productos con el buscador de arriba</td></tr></tbody>
      </table>
      <div style="text-align:right;margin-top:0.6rem;font-size:0.9rem">
        <div>Subtotal: <strong id="compra-total-subtotal">${fmt(0)}</strong></div>
        <div>Descuento: <input type="number" id="compra-descuento" class="form-input" style="width:120px;display:inline-block" value="0" min="0" step="0.01" oninput="recalcCompraTotals()"></div>
        <div>ITBIS: <strong id="compra-total-itbis">${fmt(0)}</strong></div>
        <div style="font-size:1.05rem;margin-top:0.3rem">Total: <strong id="compra-total-total">${fmt(0)}</strong></div>
      </div>
    </div>`;

  document.getElementById('modal-footer').innerHTML = `
    <button class="btn-secondary" type="button" onclick="closeAllModals()">Cancelar</button>
    <button class="btn-primary" type="button" onclick="guardarCompra()">💾 Guardar Compra</button>`;

  document.getElementById('modal-overlay').classList.remove('hidden');
  if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('modal-overlay'));
}

function toggleCompraVencimiento() {
  const condicion = document.getElementById('compra-condicion')?.value;
  const group = document.getElementById('compra-vencimiento-group');
  if (!group) return;
  group.style.display = condicion === 'credito' ? '' : 'none';
  if (condicion === 'credito') syncCompraFechaVencimiento();
}

function syncCompraFechaVencimiento() {
  const condicion = document.getElementById('compra-condicion')?.value;
  if (condicion !== 'credito') return;
  const supplierId = Number(document.getElementById('compra-supplier')?.value || 0);
  const supplier = (DB.proveedores || []).find((p) => p.id === supplierId);
  const fecha = document.getElementById('compra-fecha')?.value;
  const vencInput = document.getElementById('compra-vencimiento');
  if (!fecha || !vencInput) return;
  const d = new Date(fecha);
  d.setDate(d.getDate() + Number(supplier?.terminosPagoDias || 30));
  vencInput.value = d.toISOString().slice(0, 10);
}

function _searchCompraProducts(q) {
  const dd = document.getElementById('compra-search-dropdown');
  if (!dd) return;
  const query = String(q || '').toLowerCase().trim();
  if (!query) { dd.classList.add('hidden'); dd.innerHTML = ''; return; }
  const results = (DB.productos || []).filter((p) => {
    const estado = String(p.estado || '').toLowerCase();
    if (estado === 'inactivo' || estado === 'eliminado') return false;
    return String(p.nombre || '').toLowerCase().includes(query) || String(p.codigo || '').toLowerCase().includes(query);
  }).slice(0, 8);

  if (!results.length) {
    dd.innerHTML = '<div style="padding:0.8rem;color:var(--text3)">No se encontraron productos</div>';
    dd.classList.remove('hidden');
    return;
  }
  dd.innerHTML = results.map((p) => `
    <div class="search-result-item" onclick="addProductToCompra(${p.id})">
      <div>
        <div class="sri-name">${escapeHtml(p.nombre)}</div>
        <div class="sri-code">${escapeHtml(p.codigo)} · Último costo: ${fmt(p.precioCompra)}</div>
      </div>
      <div style="text-align:right"><div class="sri-stock">Stock: ${p.stock ?? 0}</div></div>
    </div>`).join('');
  dd.classList.remove('hidden');
}

function addProductToCompra(productId) {
  const product = (DB.productos || []).find((p) => p.id === productId);
  if (!product) return;
  const existing = purchaseItemsDraft.find((it) => it.productId === productId);
  if (existing) {
    existing.cantidad = Number(existing.cantidad) + 1;
  } else {
    purchaseItemsDraft.push({
      productId: product.id,
      codigo: product.codigo,
      nombre: product.nombre,
      cantidad: 1,
      costoUnitario: Number(product.precioCompra || 0),
      itbisPct: product.aplicaItbis ? Number(DB.config?.itbis || 0) : 0,
    });
  }
  const searchInput = document.getElementById('compra-product-search');
  if (searchInput) searchInput.value = '';
  const dd = document.getElementById('compra-search-dropdown');
  if (dd) { dd.classList.add('hidden'); dd.innerHTML = ''; }
  renderCompraItemsTable();
}

function removeCompraItem(index) {
  purchaseItemsDraft.splice(index, 1);
  renderCompraItemsTable();
}

function updateCompraItemField(index, field, value) {
  const item = purchaseItemsDraft[index];
  if (!item) return;
  item[field] = Number(value) || 0;
  renderCompraItemsTable();
}

function renderCompraItemsTable() {
  const body = document.getElementById('compra-items-body');
  if (!body) return;
  if (!purchaseItemsDraft.length) {
    body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text3)">Agrega productos con el buscador de arriba</td></tr>';
  } else {
    body.innerHTML = purchaseItemsDraft.map((it, i) => {
      const subtotal = Number(it.cantidad) * Number(it.costoUnitario);
      return `<tr>
        <td>${escapeHtml(it.nombre)}<div style="font-size:0.72rem;color:var(--text3)">${escapeHtml(it.codigo)}</div></td>
        <td><input type="number" class="form-input" style="width:70px" value="${it.cantidad}" min="0.01" step="0.01" onchange="updateCompraItemField(${i},'cantidad',this.value)"></td>
        <td><input type="number" class="form-input" style="width:90px" value="${it.costoUnitario}" min="0" step="0.01" onchange="updateCompraItemField(${i},'costoUnitario',this.value)"></td>
        <td><input type="number" class="form-input" style="width:70px" value="${it.itbisPct}" min="0" step="0.01" onchange="updateCompraItemField(${i},'itbisPct',this.value)"></td>
        <td>${fmt(subtotal)}</td>
        <td><button class="btn-xs btn-danger" type="button" onclick="removeCompraItem(${i})">🗑</button></td>
      </tr>`;
    }).join('');
  }
  recalcCompraTotals();
}

function recalcCompraTotals() {
  let subtotal = 0;
  let itbis = 0;
  purchaseItemsDraft.forEach((it) => {
    const lineSubtotal = Number(it.cantidad) * Number(it.costoUnitario);
    subtotal += lineSubtotal;
    itbis += lineSubtotal * Number(it.itbisPct || 0) / 100;
  });
  const descuento = Number(document.getElementById('compra-descuento')?.value || 0);
  const total = subtotal - descuento + itbis;
  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = fmt(val); };
  setText('compra-total-subtotal', subtotal);
  setText('compra-total-itbis', itbis);
  setText('compra-total-total', total);
}

async function guardarCompra() {
  const supplierId = Number(document.getElementById('compra-supplier')?.value || 0);
  const branchId = Number(document.getElementById('compra-branch')?.value || 0);
  const numeroDocumento = document.getElementById('compra-numero')?.value.trim();
  const fechaComprobante = document.getElementById('compra-fecha')?.value;
  const fechaRecepcion = document.getElementById('compra-recepcion')?.value || fechaComprobante;
  const condicionPago = document.getElementById('compra-condicion')?.value || 'contado';
  const fechaVencimiento = document.getElementById('compra-vencimiento')?.value || null;

  if (!supplierId) return showToast('Selecciona un proveedor.', 'warning');
  if (!branchId) return showToast('Selecciona una sucursal.', 'warning');
  if (!numeroDocumento) return showToast('Indica el número de documento del proveedor.', 'warning');
  if (!fechaComprobante) return showToast('Indica la fecha del comprobante.', 'warning');
  if (condicionPago === 'credito' && !fechaVencimiento) return showToast('Indica la fecha de vencimiento.', 'warning');
  if (!purchaseItemsDraft.length) return showToast('Agrega al menos un producto.', 'warning');

  try {
    await api.createPurchase({
      supplierId, branchId, numeroDocumento,
      ncf: document.getElementById('compra-ncf')?.value.trim() || '',
      fechaComprobante, fechaRecepcion, condicionPago,
      fechaVencimiento: condicionPago === 'credito' ? fechaVencimiento : null,
      descuento: Number(document.getElementById('compra-descuento')?.value || 0),
      notas: document.getElementById('compra-notas')?.value.trim() || '',
      items: purchaseItemsDraft.map((it) => ({
        productId: it.productId, codigo: it.codigo, nombre: it.nombre,
        cantidad: Number(it.cantidad), costoUnitario: Number(it.costoUnitario), itbisPct: Number(it.itbisPct || 0),
      })),
    });
    closeAllModals();
    purchaseItemsDraft = [];
    showToast('Compra registrada correctamente.', 'success');
    loadComprasTable();
    loadCuentasPorPagar();
    if (typeof loadProductsTable === 'function') loadProductsTable();
    if (typeof loadInventoryTable === 'function') loadInventoryTable();
    if (typeof refreshAuditLogs === 'function') refreshAuditLogs().catch(() => {});
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// ── Ver compra ────────────────────────────────────────────────────────────
async function verCompra(id) {
  try {
    const compra = await api.getPurchase(id);
    document.getElementById('modal-title').textContent = `Compra · ${compra.numeroDocumento}`;
    document.getElementById('modal-body').innerHTML = `
      <div class="modal-grid">
        <div class="form-group"><label>Proveedor</label><input class="form-input" value="${escapeHtml(compra.proveedor)}" disabled></div>
        <div class="form-group"><label>Sucursal</label><input class="form-input" value="${escapeHtml(compra.sucursal || '—')}" disabled></div>
        <div class="form-group"><label>Documento</label><input class="form-input" value="${escapeHtml(compra.numeroDocumento)}" disabled></div>
        <div class="form-group"><label>NCF</label><input class="form-input" value="${escapeHtml(compra.ncf || '—')}" disabled></div>
        <div class="form-group"><label>Fecha comprobante</label><input class="form-input" value="${fmtCompraFecha(compra.fechaComprobante)}" disabled></div>
        <div class="form-group"><label>Condición</label><input class="form-input" value="${compra.condicionPago === 'credito' ? 'Crédito' : 'Contado'}" disabled></div>
        <div class="form-group"><label>Estado</label><input class="form-input" value="${compra.estado === 'activa' ? 'Activa' : 'Anulada'}" disabled></div>
      </div>
      <table class="compact-table" style="width:100%;font-size:0.82rem;margin-top:0.8rem">
        <thead><tr><th>Producto</th><th>Cant.</th><th>Costo Unit.</th><th>ITBIS %</th><th>Subtotal</th></tr></thead>
        <tbody>
          ${(compra.items || []).map((it) => `<tr>
            <td>${escapeHtml(it.nombre)}<div style="font-size:0.72rem;color:var(--text3)">${escapeHtml(it.codigo)}</div></td>
            <td>${it.cantidad}</td><td>${fmt(it.costoUnitario)}</td><td>${it.itbisPct}%</td><td>${fmt(it.subtotal)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div style="text-align:right;margin-top:0.6rem;font-size:0.9rem">
        <div>Subtotal: ${fmt(compra.subtotal)}</div>
        <div>Descuento: ${fmt(compra.descuento)}</div>
        <div>ITBIS: ${fmt(compra.itbis)}</div>
        <div style="font-size:1.05rem;margin-top:0.3rem"><strong>Total: ${fmt(compra.total)}</strong></div>
      </div>
      ${compra.notas ? `<p style="margin-top:0.6rem;color:var(--text3)">${escapeHtml(compra.notas)}</p>` : ''}
      ${compra.estado === 'anulada' ? `<p style="margin-top:0.6rem;color:#e53e3e">Anulada${compra.motivoAnulacion ? ': ' + escapeHtml(compra.motivoAnulacion) : ''}</p>` : ''}`;
    document.getElementById('modal-footer').innerHTML = '<button class="btn-secondary" type="button" onclick="closeAllModals()">Cerrar</button>';
    document.getElementById('modal-overlay').classList.remove('hidden');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// ── Anular compra ─────────────────────────────────────────────────────────
async function anularCompra(id) {
  const shouldProceed = typeof showDeleteConfirm === 'function'
    ? await showDeleteConfirm('¿Anular esta compra? Se revertirá el inventario que generó y se cancelará su cuenta por pagar. Esta acción no se puede deshacer.')
    : window.confirm('¿Anular esta compra? Se revertirá el inventario que generó y se cancelará su cuenta por pagar.');
  if (!shouldProceed) return;
  const motivo = window.prompt('Motivo de anulación (opcional):', '') || '';
  try {
    await api.voidPurchase(id, { motivo });
    showToast('Compra anulada.', 'success');
    loadComprasTable();
    loadCuentasPorPagar();
    if (typeof loadProductsTable === 'function') loadProductsTable();
    if (typeof loadInventoryTable === 'function') loadInventoryTable();
    if (typeof refreshAuditLogs === 'function') refreshAuditLogs().catch(() => {});
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// ── Cuentas por pagar ─────────────────────────────────────────────────────
async function loadCuentasPorPagar() {
  const container = document.getElementById('cuentas-por-pagar-list');
  if (!container) return;
  container.innerHTML = '<div class="loading-text">Cargando…</div>';
  try {
    const data = await api.getAccountsPayable();
    DB.cuentasPorPagar = data.cuentas || [];
    // Upsert en DB.facturasProveedores — así "Pagar" reutiliza el modal de
    // proveedores.js (openSupplierPaymentModal/saveSupplierPayment) sin
    // duplicar esa lógica.
    DB.facturasProveedores = DB.facturasProveedores || [];
    DB.cuentasPorPagar.forEach((cuenta) => {
      const idx = DB.facturasProveedores.findIndex((f) => f.id === cuenta.id);
      if (idx >= 0) DB.facturasProveedores[idx] = cuenta;
      else DB.facturasProveedores.push(cuenta);
    });
    renderCuentasPorPagarResumen(data.resumen || {});
    renderCuentasPorPagarTable();
  } catch (e) {
    container.innerHTML = `<div class="error-text">Error al cargar: ${e.message}</div>`;
  }
}

function renderCuentasPorPagarResumen(resumen) {
  const el = document.getElementById('cuentas-por-pagar-resumen');
  if (!el) return;
  el.innerHTML = `
    <div class="stat-card"><div class="stat-val">${fmt(resumen.totalPendiente || 0)}</div><div class="stat-label">Total pendiente</div></div>
    <div class="stat-card stat-danger"><div class="stat-val">${fmt(resumen.totalVencido || 0)}</div><div class="stat-label">Vencido</div></div>
    <div class="stat-card stat-warning"><div class="stat-val">${fmt(resumen.totalPorVencer7dias || 0)}</div><div class="stat-label">Vence en 7 días</div></div>
    <div class="stat-card"><div class="stat-val">${resumen.cantidadFacturas || 0}</div><div class="stat-label">Facturas pendientes</div></div>`;
}

function filterCuentasPorPagar(filtro) {
  _cuentasPorPagarFiltro = filtro;
  document.querySelectorAll('#module-compras .cxp-filter-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.filtro === filtro);
  });
  renderCuentasPorPagarTable();
}

function renderCuentasPorPagarTable() {
  const container = document.getElementById('cuentas-por-pagar-list');
  if (!container) return;
  let rows = DB.cuentasPorPagar || [];
  if (_cuentasPorPagarFiltro === 'vencidas') rows = rows.filter((r) => r.vencida);
  if (_cuentasPorPagarFiltro === 'proximos7') rows = rows.filter((r) => !r.vencida && r.diasParaVencer !== null && r.diasParaVencer <= 7);

  if (!rows.length) {
    container.innerHTML = '<div class="empty-state-small" style="padding:1rem;text-align:center;color:var(--text3)">No hay cuentas por pagar en este filtro.</div>';
    return;
  }
  container.innerHTML = `
    <table class="compact-table" style="width:100%;font-size:0.85rem">
      <thead><tr><th>Proveedor</th><th>Factura</th><th>Vence</th><th>Pendiente</th><th>Estado</th><th></th></tr></thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td>${escapeHtml(r.proveedor)}</td>
            <td>${escapeHtml(r.numeroFactura)}</td>
            <td style="${r.vencida ? 'color:#e53e3e;font-weight:700' : ''}">${fmtCompraFecha(r.fechaVencimiento)}${r.vencida ? ` (${r.diasVencido}d vencida)` : ''}</td>
            <td>${fmt(r.montoPendiente)}</td>
            <td>${typeof getSupplierInvoiceStatusBadge === 'function' ? getSupplierInvoiceStatusBadge(r.estado) : escapeHtml(r.estado)}</td>
            <td><button class="btn-xs btn-primary" type="button" onclick="openSupplierPaymentModal(${r.id})">💵 Pagar</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

// ── Gastos ────────────────────────────────────────────────────────────────
async function getExpenseCategories() {
  if (_expenseCategoriesCache) return _expenseCategoriesCache;
  try {
    _expenseCategoriesCache = await api.request('/api/expenses/categories');
  } catch (e) {
    _expenseCategoriesCache = ['Alquiler', 'Electricidad', 'Internet', 'Agua', 'Combustible', 'Publicidad', 'Papelería', 'Nómina', 'Seguridad', 'Limpieza', 'Mantenimiento', 'Honorarios', 'Impuestos', 'Servicios', 'Caja Chica', 'Otros'];
  }
  return _expenseCategoriesCache;
}

async function loadGastosTable() {
  const container = document.getElementById('gastos-list');
  if (!container) return;
  container.innerHTML = '<div class="loading-text">Cargando…</div>';
  try {
    const rows = await api.getExpenses();
    DB.gastos = rows || [];
    renderGastosTable();
  } catch (e) {
    container.innerHTML = `<div class="error-text">Error al cargar: ${e.message}</div>`;
  }
}

function renderGastosTable() {
  const container = document.getElementById('gastos-list');
  if (!container) return;
  const rows = DB.gastos || [];
  if (!rows.length) {
    container.innerHTML = '<div class="empty-state-small" style="padding:1rem;text-align:center;color:var(--text3)">No hay gastos registrados todavía.</div>';
    return;
  }
  const canAnular = typeof currentUserCan === 'function' && currentUserCan('gastos.anular');
  container.innerHTML = `
    <table class="compact-table" style="width:100%;font-size:0.85rem">
      <thead><tr>
        <th>Fecha</th><th>Categoría</th><th>Descripción</th><th>Proveedor/Beneficiario</th><th>Total</th><th>Estado</th><th></th>
      </tr></thead>
      <tbody>
        ${rows.map((g) => `
          <tr>
            <td>${fmtCompraFecha(g.fecha)}</td>
            <td>${escapeHtml(g.categoria)}</td>
            <td>${escapeHtml(g.descripcion)}${g.ncf ? ' · ' + escapeHtml(g.ncf) : ''}</td>
            <td>${escapeHtml(g.proveedor || g.beneficiario || '—')}</td>
            <td>${fmt(g.total)}</td>
            <td><span class="badge ${g.estado === 'anulado' ? 'badge-danger' : g.estado === 'pendiente' ? 'badge-warning' : 'badge-success'}">${escapeHtml(g.estado)}</span></td>
            <td>
              <button class="btn-xs btn-secondary" type="button" onclick="verGasto(${g.id})" title="Ver">👁</button>
              ${g.estado !== 'anulado' && canAnular
                ? `<button class="btn-xs btn-danger" type="button" onclick="anularGasto(${g.id})" title="Anular">🛑</button>`
                : ''}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

async function openNuevoGastoModal() {
  const categories = await getExpenseCategories();
  const suppliers = (DB.proveedores || []).filter((p) => p.estado === 'Activo');
  const branches = DB.sucursales || [];
  const today = new Date().toISOString().slice(0, 10);
  const defaultBranchId = Number(DB.config?.activeBranchId || 0) || Number(branches[0]?.id || 0) || '';

  document.getElementById('modal-title').textContent = 'Nuevo Gasto';
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-grid">
      <div class="form-group"><label>Categoría *</label>
        <select id="gasto-categoria" class="form-input">
          ${categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>Sucursal *</label>
        <select id="gasto-branch" class="form-input">
          ${branches.map((b) => `<option value="${b.id}" ${Number(b.id) === Number(defaultBranchId) ? 'selected' : ''}>${escapeHtml(b.nombre)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group span-full"><label>Descripción *</label><input type="text" id="gasto-descripcion" class="form-input" placeholder="Ej: Factura de luz de julio"></div>
      <div class="form-group"><label>Proveedor (opcional)</label>
        <select id="gasto-supplier" class="form-input">
          <option value="">-- Sin proveedor formal --</option>
          ${suppliers.map((p) => `<option value="${p.id}">${escapeHtml(p.nombre)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>Beneficiario (si no hay proveedor)</label><input type="text" id="gasto-beneficiario" class="form-input" placeholder="Nombre de la persona/empresa"></div>
      <div class="form-group"><label>NCF</label><input type="text" id="gasto-ncf" class="form-input" placeholder="B0100000001"></div>
      <div class="form-group"><label>Fecha *</label><input type="date" id="gasto-fecha" class="form-input" value="${today}"></div>
      <div class="form-group"><label>Estado *</label>
        <select id="gasto-estado" class="form-input" onchange="toggleGastoFechaPago()">
          <option value="pagado">Pagado</option>
          <option value="pendiente">Pendiente</option>
        </select>
      </div>
      <div class="form-group" id="gasto-fecha-pago-group"><label>Fecha de pago</label><input type="date" id="gasto-fecha-pago" class="form-input" value="${today}"></div>
      <div class="form-group"><label>Monto (sin ITBIS) *</label><input type="number" id="gasto-subtotal" class="form-input" min="0" step="0.01" value="0" oninput="recalcGastoTotales()"></div>
      <div class="form-group"><label>ITBIS</label><input type="number" id="gasto-itbis" class="form-input" min="0" step="0.01" value="0" oninput="recalcGastoTotales()"></div>
      <div class="form-group"><label>Retención ISR</label><input type="number" id="gasto-retencion-isr" class="form-input" min="0" step="0.01" value="0" oninput="recalcGastoTotales()"></div>
      <div class="form-group"><label>Retención ITBIS</label><input type="number" id="gasto-retencion-itbis" class="form-input" min="0" step="0.01" value="0" oninput="recalcGastoTotales()"></div>
      <div class="form-group span-full"><label>Notas</label><input type="text" id="gasto-notas" class="form-input" placeholder="Observaciones"></div>
    </div>
    <div style="text-align:right;margin-top:0.6rem;font-size:0.9rem">
      <div>Total gasto: <strong id="gasto-total-total">${fmt(0)}</strong></div>
      <div>Neto a pagar al beneficiario: <strong id="gasto-total-neto">${fmt(0)}</strong></div>
    </div>`;

  document.getElementById('modal-footer').innerHTML = `
    <button class="btn-secondary" type="button" onclick="closeAllModals()">Cancelar</button>
    <button class="btn-primary" type="button" onclick="guardarGasto()">💾 Guardar Gasto</button>`;

  document.getElementById('modal-overlay').classList.remove('hidden');
  if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('modal-overlay'));
}

function toggleGastoFechaPago() {
  const estado = document.getElementById('gasto-estado')?.value;
  const group = document.getElementById('gasto-fecha-pago-group');
  if (!group) return;
  group.style.display = estado === 'pagado' ? '' : 'none';
}

function recalcGastoTotales() {
  const subtotal = Number(document.getElementById('gasto-subtotal')?.value || 0);
  const itbis = Number(document.getElementById('gasto-itbis')?.value || 0);
  const retIsr = Number(document.getElementById('gasto-retencion-isr')?.value || 0);
  const retItbis = Number(document.getElementById('gasto-retencion-itbis')?.value || 0);
  const total = subtotal + itbis;
  const neto = total - retIsr - retItbis;
  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = fmt(val); };
  setText('gasto-total-total', total);
  setText('gasto-total-neto', neto);
}

async function guardarGasto() {
  const categoria = document.getElementById('gasto-categoria')?.value;
  const branchId = Number(document.getElementById('gasto-branch')?.value || 0);
  const descripcion = document.getElementById('gasto-descripcion')?.value.trim();
  const fecha = document.getElementById('gasto-fecha')?.value;
  const estado = document.getElementById('gasto-estado')?.value || 'pagado';
  const subtotal = Number(document.getElementById('gasto-subtotal')?.value || 0);

  if (!categoria) return showToast('Selecciona una categoría.', 'warning');
  if (!branchId) return showToast('Selecciona una sucursal.', 'warning');
  if (!descripcion) return showToast('Indica la descripción del gasto.', 'warning');
  if (!fecha) return showToast('Indica la fecha del gasto.', 'warning');
  if (!(subtotal > 0)) return showToast('El monto debe ser mayor a 0.', 'warning');

  try {
    await api.createExpense({
      categoria, branchId, descripcion, fecha, estado,
      supplierId: Number(document.getElementById('gasto-supplier')?.value || 0) || null,
      beneficiario: document.getElementById('gasto-beneficiario')?.value.trim() || '',
      ncf: document.getElementById('gasto-ncf')?.value.trim() || '',
      fechaPago: estado === 'pagado' ? (document.getElementById('gasto-fecha-pago')?.value || fecha) : null,
      subtotal,
      itbis: Number(document.getElementById('gasto-itbis')?.value || 0),
      retencionIsr: Number(document.getElementById('gasto-retencion-isr')?.value || 0),
      retencionItbis: Number(document.getElementById('gasto-retencion-itbis')?.value || 0),
      notas: document.getElementById('gasto-notas')?.value.trim() || '',
    });
    closeAllModals();
    showToast('Gasto registrado correctamente.', 'success');
    loadGastosTable();
    if (typeof refreshAuditLogs === 'function') refreshAuditLogs().catch(() => {});
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function verGasto(id) {
  try {
    const g = await api.getExpense(id);
    document.getElementById('modal-title').textContent = `Gasto · ${g.categoria}`;
    document.getElementById('modal-body').innerHTML = `
      <div class="modal-grid">
        <div class="form-group"><label>Categoría</label><input class="form-input" value="${escapeHtml(g.categoria)}" disabled></div>
        <div class="form-group"><label>Sucursal</label><input class="form-input" value="${escapeHtml(g.sucursal || '—')}" disabled></div>
        <div class="form-group span-full"><label>Descripción</label><input class="form-input" value="${escapeHtml(g.descripcion)}" disabled></div>
        <div class="form-group"><label>Proveedor/Beneficiario</label><input class="form-input" value="${escapeHtml(g.proveedor || g.beneficiario || '—')}" disabled></div>
        <div class="form-group"><label>NCF</label><input class="form-input" value="${escapeHtml(g.ncf || '—')}" disabled></div>
        <div class="form-group"><label>Fecha</label><input class="form-input" value="${fmtCompraFecha(g.fecha)}" disabled></div>
        <div class="form-group"><label>Estado</label><input class="form-input" value="${escapeHtml(g.estado)}" disabled></div>
      </div>
      <div style="text-align:right;margin-top:0.6rem;font-size:0.9rem">
        <div>Subtotal: ${fmt(g.subtotal)}</div>
        <div>ITBIS: ${fmt(g.itbis)}</div>
        <div>Retención ISR: ${fmt(g.retencionIsr)}</div>
        <div>Retención ITBIS: ${fmt(g.retencionItbis)}</div>
        <div style="font-size:1.05rem;margin-top:0.3rem"><strong>Total: ${fmt(g.total)}</strong></div>
        <div>Neto al beneficiario: ${fmt(g.montoNetoBeneficiario)}</div>
      </div>
      ${g.notas ? `<p style="margin-top:0.6rem;color:var(--text3)">${escapeHtml(g.notas)}</p>` : ''}
      ${g.estado === 'anulado' ? `<p style="margin-top:0.6rem;color:#e53e3e">Anulado${g.motivoAnulacion ? ': ' + escapeHtml(g.motivoAnulacion) : ''}</p>` : ''}`;
    document.getElementById('modal-footer').innerHTML = '<button class="btn-secondary" type="button" onclick="closeAllModals()">Cerrar</button>';
    document.getElementById('modal-overlay').classList.remove('hidden');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function anularGasto(id) {
  const shouldProceed = typeof showDeleteConfirm === 'function'
    ? await showDeleteConfirm('¿Anular este gasto? Esta acción no se puede deshacer.')
    : window.confirm('¿Anular este gasto?');
  if (!shouldProceed) return;
  const motivo = window.prompt('Motivo de anulación (opcional):', '') || '';
  try {
    await api.voidExpense(id, { motivo });
    showToast('Gasto anulado.', 'success');
    loadGastosTable();
    if (typeof refreshAuditLogs === 'function') refreshAuditLogs().catch(() => {});
  } catch (e) {
    showToast(e.message, 'error');
  }
}
