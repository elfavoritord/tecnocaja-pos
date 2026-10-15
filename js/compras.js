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

// Usar componentes de fecha LOCAL (getFullYear/getMonth/getDate), NO
// toISOString() que devuelve UTC — en RD (UTC-4) después de las 8 PM eso da
// la fecha de mañana (mismo bug ya documentado y corregido en reportes-v2.js).
function localDateStrCompras(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtCompraFecha(v) {
  if (!v) return '—';
  const d = new Date(String(v).length <= 10 ? `${v}T00:00:00` : v);
  return isNaN(d) ? String(v) : d.toLocaleDateString(comprasLocale());
}

// ── Tabs ──────────────────────────────────────────────────────────────────
function showComprasTab(tab) {
  _comprasActiveTab = tab;
  // Un solo botón principal: el de la pestaña activa (css/modulos.css).
  const comprasModule = document.getElementById('module-compras');
  if (comprasModule) comprasModule.dataset.tab = tab;
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
  const today = localDateStrCompras(new Date());
  const defaultBranchId = Number(DB.config?.activeBranchId || 0) || Number(branches[0]?.id || 0) || '';

  document.getElementById('modal-title').textContent = 'Nueva Compra';
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-grid">
      <div class="form-group"><label>Proveedor *</label>
        <select id="compra-supplier" class="form-input" onchange="handleCompraSupplierChange()">
          <option value="">-- Seleccionar --</option>
          ${suppliers.map((p) => `<option value="${p.id}">${escapeHtml(p.nombre)}</option>`).join('')}
          <option value="__new__">+ Crear nuevo proveedor…</option>
        </select>
      </div>
      <div class="form-group span-full hidden" id="compra-new-supplier-group" style="display:flex;gap:0.75rem;flex-wrap:wrap;background:var(--panel2);padding:0.75rem;border-radius:10px;border:1px solid var(--border)">
        <div class="form-group" style="flex:2;min-width:200px;margin:0"><label>Nombre del nuevo proveedor *</label><input type="text" id="compra-new-supplier-nombre" class="form-input" placeholder="Nombre del proveedor"></div>
        <div class="form-group" style="flex:1;min-width:150px;margin:0"><label>RNC (opcional)</label><input type="text" id="compra-new-supplier-rnc" class="form-input" placeholder="000-00000-0"></div>
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
    <details style="margin-top:0.8rem">
      <summary style="cursor:pointer;font-weight:600;color:var(--accent)">Datos para Formato 606 DGII (opcional)</summary>
      <div class="modal-grid" style="margin-top:0.6rem">
        <div class="form-group"><label>Tipo de bien/servicio comprado</label>
          <select id="compra-606-tipo" class="form-input">
            <option value="1">1. Gastos de personal</option>
            <option value="2">2. Gastos por trabajos, suministros y servicios</option>
            <option value="3">3. Arrendamientos</option>
            <option value="4">4. Gastos de activos fijos</option>
            <option value="5">5. Gastos de representación</option>
            <option value="6">6. Otras deducciones admitidas</option>
            <option value="7">7. Gastos financieros</option>
            <option value="8">8. Gastos extraordinarios</option>
            <option value="9" selected>9. Compras y gastos que formarán parte del costo de venta</option>
            <option value="10">10. Adquisiciones de activos</option>
            <option value="11">11. Gastos de seguros</option>
          </select>
        </div>
        <div class="form-group"><label>Forma de pago</label>
          <select id="compra-606-forma-pago" class="form-input">
            <option value="">— usar según condición de pago —</option>
            <option value="1">1. Efectivo</option>
            <option value="2">2. Cheques/Transferencias/Depósito</option>
            <option value="3">3. Tarjeta crédito/débito</option>
            <option value="4">4. Compra a crédito</option>
            <option value="5">5. Permuta</option>
            <option value="6">6. Notas de crédito</option>
            <option value="7">7. Mixto</option>
          </select>
        </div>
        <div class="form-group"><label>ITBIS Retenido</label><input type="number" id="compra-606-itbis-retenido" class="form-input" value="0" min="0" step="0.01"></div>
        <div class="form-group"><label>Tipo de Retención ISR</label>
          <select id="compra-606-isr-tipo" class="form-input">
            <option value="">— no aplica —</option>
            <option value="1">1. Alquileres</option>
            <option value="2">2. Honorarios por servicios</option>
            <option value="3">3. Otras rentas</option>
            <option value="4">4. Otras rentas (rentas presuntas)</option>
            <option value="5">5. Intereses a personas jurídicas residentes</option>
            <option value="6">6. Intereses a personas físicas residentes</option>
            <option value="7">7. Retención por proveedores del Estado</option>
            <option value="8">8. Juegos telefónicos</option>
            <option value="9">9. Retenciones subsector ganadería de carne bovina</option>
          </select>
        </div>
        <div class="form-group"><label>Monto Retención Renta</label><input type="number" id="compra-606-isr-monto" class="form-input" value="0" min="0" step="0.01"></div>
        <div class="form-group"><label>NCF o Documento Modificado</label><input type="text" id="compra-606-ncf-modificado" class="form-input" placeholder="Si esta compra es una Nota de Débito/Crédito"></div>
      </div>
    </details>
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

// El cliente reportó que "Proveedor" solo dejaba elegir uno ya existente —
// para registrar una compra de un proveedor nuevo tenía que salirse de este
// modal, perder lo que llevaba capturado, crear el proveedor aparte y volver
// a empezar la compra. La opción "+ Crear nuevo proveedor…" evita eso: pide
// nombre (y RNC opcional) aquí mismo; guardarCompra() crea el proveedor
// primero y usa su id, sin tocar el resto del formulario.
function handleCompraSupplierChange() {
  const value = document.getElementById('compra-supplier')?.value || '';
  const group = document.getElementById('compra-new-supplier-group');
  if (group) group.classList.toggle('hidden', value !== '__new__');
  if (value !== '__new__') syncCompraFechaVencimiento();
}

function syncCompraFechaVencimiento() {
  const condicion = document.getElementById('compra-condicion')?.value;
  if (condicion !== 'credito') return;
  const supplierId = Number(document.getElementById('compra-supplier')?.value || 0);
  const supplier = (DB.proveedores || []).find((p) => p.id === supplierId);
  const fecha = document.getElementById('compra-fecha')?.value;
  const vencInput = document.getElementById('compra-vencimiento');
  if (!fecha || !vencInput) return;
  const d = new Date(`${fecha}T00:00:00`);
  d.setDate(d.getDate() + Number(supplier?.terminosPagoDias || 30));
  vencInput.value = localDateStrCompras(d);
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
  const supplierSelectValue = document.getElementById('compra-supplier')?.value || '';
  const isNewSupplier = supplierSelectValue === '__new__';
  let supplierId = isNewSupplier ? 0 : Number(supplierSelectValue || 0);
  const branchId = Number(document.getElementById('compra-branch')?.value || 0);
  const numeroDocumento = document.getElementById('compra-numero')?.value.trim();
  const fechaComprobante = document.getElementById('compra-fecha')?.value;
  const fechaRecepcion = document.getElementById('compra-recepcion')?.value || fechaComprobante;
  const condicionPago = document.getElementById('compra-condicion')?.value || 'contado';
  const fechaVencimiento = document.getElementById('compra-vencimiento')?.value || null;
  const newSupplierNombre = document.getElementById('compra-new-supplier-nombre')?.value.trim() || '';

  if (!supplierSelectValue) return showToast('Selecciona un proveedor.', 'warning');
  if (isNewSupplier && !newSupplierNombre) return showToast('Indica el nombre del nuevo proveedor.', 'warning');
  if (!branchId) return showToast('Selecciona una sucursal.', 'warning');
  if (!numeroDocumento) return showToast('Indica el número de documento del proveedor.', 'warning');
  if (!fechaComprobante) return showToast('Indica la fecha del comprobante.', 'warning');
  if (condicionPago === 'credito' && !fechaVencimiento) return showToast('Indica la fecha de vencimiento.', 'warning');
  if (!purchaseItemsDraft.length) return showToast('Agrega al menos un producto.', 'warning');

  try {
    if (isNewSupplier) {
      const created = await api.createSupplier({
        nombre: newSupplierNombre,
        rnc: document.getElementById('compra-new-supplier-rnc')?.value.trim() || '',
        estado: 'Activo',
        ...getActorPayload(),
      });
      DB.proveedores = DB.proveedores || [];
      DB.proveedores.push(created);
      supplierId = Number(created.id);
    }

    await api.createPurchase({
      supplierId, branchId, numeroDocumento,
      ncf: document.getElementById('compra-ncf')?.value.trim() || '',
      fechaComprobante, fechaRecepcion, condicionPago,
      fechaVencimiento: condicionPago === 'credito' ? fechaVencimiento : null,
      descuento: Number(document.getElementById('compra-descuento')?.value || 0),
      notas: document.getElementById('compra-notas')?.value.trim() || '',
      tipoBienesServicios: Number(document.getElementById('compra-606-tipo')?.value || 9),
      formaPago: document.getElementById('compra-606-forma-pago')?.value ? Number(document.getElementById('compra-606-forma-pago').value) : null,
      itbisRetenido: Number(document.getElementById('compra-606-itbis-retenido')?.value || 0),
      isrTipoRetencion: document.getElementById('compra-606-isr-tipo')?.value ? Number(document.getElementById('compra-606-isr-tipo').value) : null,
      isrMontoRetencion: Number(document.getElementById('compra-606-isr-monto')?.value || 0),
      ncfModificado: document.getElementById('compra-606-ncf-modificado')?.value.trim() || '',
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

// La vista Gastos del modo Empresa de Servicios (js/servicios/servicios.js)
// usa este mismo formulario y se refresca con este aviso.
function avisarGastosCambiaron() {
  window.dispatchEvent(new CustomEvent('tc:gastos-cambiaron'));
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
            <td title="${escapeHtml((g.categorias || [g.categoria]).join(', '))}">${escapeHtml(categoriasDeGastoTexto(g))}</td>
            <td>${escapeHtml(g.descripcion)}${g.ncf ? ' · ' + escapeHtml(g.ncf) : ''}</td>
            <td>${escapeHtml(g.proveedor || g.beneficiario || '—')}</td>
            <td>${fmt(g.total)}</td>
            <td><span class="badge ${g.estado === 'anulado' ? 'badge-danger' : g.estado === 'pendiente' ? 'badge-warning' : 'badge-success'}">${escapeHtml(g.estado)}</span></td>
            <td>
              <button class="btn-xs btn-secondary" type="button" onclick="verGasto(${g.id})" title="Ver">👁</button>
              <button class="btn-xs btn-secondary" type="button" onclick="imprimirGasto(${g.id})" title="Imprimir">🖨</button>
              ${g.estado !== 'anulado' && puedeEditarGastos()
                ? `<button class="btn-xs btn-secondary" type="button" onclick="editarGasto(${g.id})" title="Editar">✏️</button>`
                : ''}
              ${g.estado !== 'anulado' && canAnular
                ? `<button class="btn-xs btn-danger" type="button" onclick="anularGasto(${g.id})" title="Anular">🛑</button>`
                : ''}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

// Tasa de ITBIS de Configuración (en %), para el botón rápido del formulario.
function tasaItbisGasto() {
  const v = Number(DB.config?.itbis);
  if (!(v > 0)) return 18;
  return v <= 1 ? Math.round(v * 10000) / 100 : v;
}

const gastoIco = (name) => (window.TcIconos ? window.TcIconos.svg(name, 16) : '');

// ── Categorías: una principal por gasto y, si hace falta, otra por línea ──
// "+ Nueva categoría…" abre un campo para escribirla ahí mismo (Electron no
// tiene prompt()). Las nuevas se guardan con el gasto y el servidor las
// devuelve después en /api/expenses/categories.
const CATEGORIA_NUEVA = '__nueva__';

function opcionesCategoriaGasto(seleccionada, { heredar = false } = {}) {
  const lista = [...(_expenseCategoriesCache || [])];
  if (seleccionada && !lista.some((c) => c.toLowerCase() === String(seleccionada).toLowerCase())) lista.push(seleccionada);
  return (heredar ? `<option value="">Igual al gasto</option>` : '')
    + lista.map((c) => `<option value="${escapeHtml(c)}"${c === seleccionada ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('')
    + `<option value="${CATEGORIA_NUEVA}">+ Nueva categoría…</option>`;
}

function agregarCategoriaGasto(nombre) {
  const existente = (_expenseCategoriesCache || []).find((c) => c.toLowerCase() === nombre.toLowerCase());
  if (existente) return existente;
  _expenseCategoriesCache = [...(_expenseCategoriesCache || []), nombre];
  document.querySelectorAll('#modal-body select[data-cat]').forEach((sel) => {
    const nueva = sel.querySelector(`option[value="${CATEGORIA_NUEVA}"]`);
    const opt = document.createElement('option');
    opt.value = nombre;
    opt.textContent = nombre;
    sel.insertBefore(opt, nueva);
  });
  return nombre;
}

function pedirCategoriaNuevaGasto(select) {
  const anterior = select.dataset.prev ?? '';
  const campo = document.createElement('input');
  campo.type = 'text';
  campo.className = 'form-input gf-cat-nueva';
  campo.placeholder = 'Nombre de la categoría';
  campo.maxLength = 50;
  select.hidden = true;
  select.after(campo);
  campo.focus();
  let listo = false;
  const terminar = (aceptar) => {
    if (listo) return;
    listo = true;
    const nombre = campo.value.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    campo.remove();
    select.hidden = false;
    select.value = aceptar && nombre ? agregarCategoriaGasto(nombre) : anterior;
    select.dataset.prev = select.value;
    if (aceptar && nombre) showToast(`Categoría "${nombre}" agregada.`, 'success');
  };
  campo.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); terminar(true); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); terminar(false); }
  });
  campo.addEventListener('blur', () => terminar(true));
}

// Un solo listener en el cuerpo de la ventana para todos los selectores de categoría.
function cablearCategoriasGasto(raiz) {
  raiz.addEventListener('focusin', (e) => {
    if (e.target.matches?.('select[data-cat]')) e.target.dataset.prev = e.target.value;
  });
  raiz.addEventListener('change', (e) => {
    const sel = e.target;
    if (!sel.matches?.('select[data-cat]')) return;
    if (sel.value === CATEGORIA_NUEVA) pedirCategoriaNuevaGasto(sel);
    else sel.dataset.prev = sel.value;
  });
}

// Una fila del detalle del gasto (varios conceptos en una misma factura).
// it.categoria vacía = "Igual al gasto" (toma la categoría principal).
function filaLineaGasto(it = {}) {
  return `<tr>
    <td><input type="text" class="form-input gl-desc" value="${escapeHtml(it.descripcion || '')}" placeholder="Concepto o servicio" maxlength="255"></td>
    <td><select class="form-input gl-cat" data-cat title="Categoría de esta línea">${opcionesCategoriaGasto(it.categoria || '', { heredar: true })}</select></td>
    <td><input type="number" class="form-input gl-num gl-cant" min="0" step="0.01" inputmode="decimal" value="${it.cantidad ?? 1}"></td>
    <td><input type="number" class="form-input gl-num gl-precio" min="0" step="0.01" inputmode="decimal" placeholder="0.00" value="${it.precio ?? ''}"></td>
    <td><input type="number" class="form-input gl-num gl-itbis" min="0" max="100" step="0.01" inputmode="decimal" value="${it.itbisPct ?? 0}"></td>
    <td class="gl-imp">—</td>
    <td class="gl-acc"><button type="button" class="gl-quitar" title="Quitar línea" aria-label="Quitar línea" onclick="quitarLineaGasto(this)">${gastoIco('x')}</button></td>
  </tr>`;
}

function agregarLineaGasto(it) {
  const tbody = document.getElementById('gasto-lineas');
  if (!tbody) return null;
  tbody.insertAdjacentHTML('beforeend', filaLineaGasto(it));
  const fila = tbody.lastElementChild;
  fila.querySelector('.gl-desc')?.focus();
  recalcGastoTotales();
  return fila;
}

// Quitar la única línea la deja en blanco en vez de dejar la tabla vacía.
function quitarLineaGasto(btn) {
  const tr = btn.closest('tr');
  const tbody = document.getElementById('gasto-lineas');
  if (!tr || !tbody) return;
  if (tbody.rows.length > 1) tr.remove();
  else tr.outerHTML = filaLineaGasto();
  recalcGastoTotales();
}

function aplicarItbisGasto() {
  const tasa = tasaItbisGasto();
  document.querySelectorAll('#gasto-lineas .gl-itbis').forEach((el) => { el.value = tasa; });
  recalcGastoTotales();
}

function lineasGastoDelFormulario() {
  return [...document.querySelectorAll('#gasto-lineas tr')].map((tr) => {
    const v = (sel) => tr.querySelector(sel)?.value ?? '';
    const cat = v('.gl-cat');
    return {
      tr,
      descripcion: v('.gl-desc').trim(),
      categoria: cat === CATEGORIA_NUEVA ? '' : cat,
      cantidad: Number(v('.gl-cant') || 0),
      precio: Number(v('.gl-precio') || 0),
      itbisPct: Number(v('.gl-itbis') || 0),
    };
  });
}

// Enter dentro de una línea no guarda: pasa al siguiente campo y, al final
// de la última línea, agrega otra.
function teclaLineaGasto(event) {
  if (event.key !== 'Enter' || event.target.tagName !== 'INPUT' || event.target.classList.contains('gf-cat-nueva')) return;
  event.preventDefault();
  const campos = [...document.querySelectorAll('#gasto-lineas input:not(.gf-cat-nueva)')];
  const siguiente = campos[campos.indexOf(event.target) + 1];
  if (siguiente) { siguiente.focus(); siguiente.select?.(); } else agregarLineaGasto();
}

// Gasto que se está editando (null = nuevo). Lo lee guardarGasto().
let _gastoEditandoId = null;

async function editarGasto(id) {
  try {
    const g = await api.getExpense(id);
    if (g.estado === 'anulado') { showToast('Un gasto anulado no se puede editar.', 'warning'); return; }
    await openNuevoGastoModal(g);
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// Rellena la ventana con un gasto guardado (modo edición).
function rellenarFormularioGasto(g) {
  const poner = (id, valor) => { const el = document.getElementById(id); if (el && valor != null) el.value = valor; };
  const fecha = (v) => String(v || '').slice(0, 10);
  poner('gasto-branch', g.branchId);
  poner('gasto-descripcion', g.descripcion);
  poner('gasto-fecha', fecha(g.fecha));
  elegirEstadoGasto(g.estado === 'pendiente' ? 'pendiente' : 'pagado');
  if (g.fechaPago) poner('gasto-fecha-pago', fecha(g.fechaPago));
  const prov = document.getElementById('gasto-supplier');
  if (prov && g.supplierId && !prov.querySelector(`option[value="${Number(g.supplierId)}"]`)) {
    // Proveedor inactivo: se muestra igual para no perderlo al guardar.
    prov.insertAdjacentHTML('beforeend', `<option value="${Number(g.supplierId)}">${escapeHtml(g.proveedor || 'Proveedor #' + g.supplierId)}</option>`);
  }
  poner('gasto-supplier', g.supplierId || '');
  poner('gasto-beneficiario', g.beneficiario);
  poner('gasto-ncf', g.ncf);
  poner('gasto-notas', g.notas);
  poner('gasto-retencion-isr', Number(g.retencionIsr) > 0 ? g.retencionIsr : '');
  poner('gasto-retencion-itbis', Number(g.retencionItbis) > 0 ? g.retencionItbis : '');
  poner('gasto-606-forma-pago', g.formaPago || '');
  poner('gasto-606-isr-tipo', g.isrTipoRetencion || '');
  poner('gasto-606-ncf-modificado', g.ncfModificado);
  if (g.formaPago || g.isrTipoRetencion || g.ncfModificado) document.querySelector('#modal-body .gf-606')?.setAttribute('open', '');
  const tbody = document.getElementById('gasto-lineas');
  if (tbody) {
    tbody.innerHTML = lineasDeGasto(g).map((l) => filaLineaGasto({
      ...l, categoria: l.categoria && l.categoria !== g.categoria ? l.categoria : '',
    })).join('');
  }
  recalcGastoTotales();
}

// Ventana "Nuevo gasto" / "Editar gasto" por secciones (css/modulos.css →
// .gasto-modal). Los id de los campos son los que lee guardarGasto().
async function openNuevoGastoModal(gasto = null) {
  _gastoEditandoId = gasto?.id || null;
  const categories = await getExpenseCategories();
  const suppliers = (DB.proveedores || []).filter((p) => p.estado === 'Activo');
  const branches = DB.sucursales || [];
  const today = localDateStrCompras(new Date());
  const defaultBranchId = Number(DB.config?.activeBranchId || 0) || Number(branches[0]?.id || 0) || '';
  const ico = gastoIco;
  const req = '<span class="gf-req">*</span>';
  const monto = (id, label, extra = '') => `
        <div class="gf-field"><label for="${id}">${label}${extra}</label>
          <div class="gf-money"><span>RD$</span><input type="number" id="${id}" class="form-input" min="0" step="0.01" placeholder="0.00" inputmode="decimal" oninput="recalcGastoTotales()"></div>
        </div>`;

  document.getElementById('modal-title').textContent = gasto ? `Editar gasto ${numeroGasto(gasto.id)}` : 'Nuevo gasto';
  document.getElementById('modal-box')?.classList.add('gasto-modal');
  document.getElementById('modal-body').innerHTML = `
    <div class="gf">
      <section class="gf-card">
        <h4 class="gf-title"><span class="gf-ico">${ico('receipt-text')}</span>Datos del gasto</h4>
        <div class="gf-grid">
          <div class="gf-field"><label for="gasto-categoria">Categoría principal ${req}</label>
            <select id="gasto-categoria" class="form-input" data-cat>${opcionesCategoriaGasto(gasto?.categoria || categories[0])}</select>
          </div>
          <div class="gf-field"><label for="gasto-branch">Sucursal ${req}</label>
            <select id="gasto-branch" class="form-input">
              ${branches.map((b) => `<option value="${b.id}" ${Number(b.id) === Number(defaultBranchId) ? 'selected' : ''}>${escapeHtml(b.nombre)}</option>`).join('')}
            </select>
          </div>
          <div class="gf-field gf-span"><label for="gasto-descripcion">Concepto general <small>(opcional: si lo dejas vacío se usa la primera línea)</small></label>
            <input type="text" id="gasto-descripcion" class="form-input" placeholder="Ej: Factura de Ferretería Ochoa de octubre" maxlength="255"></div>
        </div>
        <div class="gf-grid gf-grid-3">
          <div class="gf-field"><label for="gasto-fecha">Fecha ${req}</label>
            <input type="date" id="gasto-fecha" class="form-input" value="${today}"></div>
          <div class="gf-field"><label>Estado del pago ${req}</label>
            <input type="hidden" id="gasto-estado" value="pagado">
            <div class="gf-seg" role="radiogroup" aria-label="Estado del pago">
              <button type="button" class="gf-seg-btn is-on" data-estado="pagado" role="radio" aria-checked="true" onclick="elegirEstadoGasto('pagado')">${ico('circle-check')}Pagado</button>
              <button type="button" class="gf-seg-btn" data-estado="pendiente" role="radio" aria-checked="false" onclick="elegirEstadoGasto('pendiente')">${ico('clock')}Pendiente</button>
            </div>
          </div>
          <div class="gf-field" id="gasto-fecha-pago-group"><label for="gasto-fecha-pago">Fecha de pago</label>
            <input type="date" id="gasto-fecha-pago" class="form-input" value="${today}"></div>
        </div>
      </section>

      <section class="gf-card">
        <h4 class="gf-title"><span class="gf-ico">${ico('truck')}</span>Proveedor y comprobante</h4>
        <div class="gf-grid">
          <div class="gf-field"><label for="gasto-supplier">Proveedor <small>(opcional)</small></label>
            <select id="gasto-supplier" class="form-input">
              <option value="">— Sin proveedor registrado —</option>
              ${suppliers.map((p) => `<option value="${p.id}">${escapeHtml(p.nombre)}</option>`).join('')}
            </select>
          </div>
          <div class="gf-field"><label for="gasto-beneficiario">Beneficiario <small>(si no hay proveedor)</small></label>
            <input type="text" id="gasto-beneficiario" class="form-input" placeholder="Persona o empresa a la que se pagó"></div>
          <div class="gf-field"><label for="gasto-ncf">NCF del comprobante</label>
            <input type="text" id="gasto-ncf" class="form-input" placeholder="B0100000001" maxlength="19"></div>
          <div class="gf-field"><label for="gasto-notas">Notas</label>
            <input type="text" id="gasto-notas" class="form-input" placeholder="Observaciones"></div>
        </div>
      </section>

      <section class="gf-card">
        <div class="gf-head">
          <h4 class="gf-title"><span class="gf-ico">${ico('list')}</span>Detalle del gasto ${req}</h4>
          <div class="gf-head-acc">
            <button type="button" class="gf-chip" onclick="aplicarItbisGasto()" title="Pone ITBIS ${tasaItbisGasto()}% en todas las líneas">ITBIS ${tasaItbisGasto()}% a todas</button>
            <button type="button" class="btn-secondary gf-add" onclick="agregarLineaGasto()">${ico('plus')}<span>Agregar línea</span></button>
          </div>
        </div>
        <div class="gf-lineas-wrap">
          <table class="gf-lineas">
            <colgroup><col><col class="gl-c-cat"><col class="gl-c-cant"><col class="gl-c-precio"><col class="gl-c-itbis"><col class="gl-c-imp"><col class="gl-c-acc"></colgroup>
            <thead><tr>
              <th>Descripción</th><th>Categoría</th><th class="num">Cant.</th><th class="num">Precio</th><th class="num">ITBIS %</th><th class="num">Importe</th><th></th>
            </tr></thead>
            <tbody id="gasto-lineas">${filaLineaGasto()}</tbody>
          </table>
        </div>
        <div class="gf-grid gf-grid-4 gf-ret">
          ${monto('gasto-retencion-isr', 'Retención ISR')}
          ${monto('gasto-retencion-itbis', 'Retención ITBIS')}
        </div>
        <div class="gf-totales">
          <div><span>Total del gasto</span><b id="gasto-total-total">${fmt(0)}</b><small id="gasto-total-desglose"></small></div>
          <div><span>Retenciones</span><b id="gasto-total-ret">${fmt(0)}</b></div>
          <div class="gf-neto"><span>Neto a pagar</span><b id="gasto-total-neto">${fmt(0)}</b></div>
        </div>
      </section>

      <details class="gf-card gf-606">
        <summary><span class="gf-ico">${ico('file-text')}</span>Datos para el Formato 606 DGII <small>(opcional)</small></summary>
        <div class="gf-grid gf-grid-3">
        <div class="gf-field"><label for="gasto-606-forma-pago">Forma de pago</label>
          <select id="gasto-606-forma-pago" class="form-input">
            <option value="">— no especificada —</option>
            <option value="1">1. Efectivo</option>
            <option value="2">2. Cheques/Transferencias/Depósito</option>
            <option value="3">3. Tarjeta crédito/débito</option>
            <option value="4">4. Compra a crédito</option>
            <option value="5">5. Permuta</option>
            <option value="6">6. Notas de crédito</option>
            <option value="7">7. Mixto</option>
          </select>
        </div>
        <div class="gf-field"><label for="gasto-606-isr-tipo">Tipo de retención ISR</label>
          <select id="gasto-606-isr-tipo" class="form-input">
            <option value="">— no aplica —</option>
            <option value="1">1. Alquileres</option>
            <option value="2">2. Honorarios por servicios</option>
            <option value="3">3. Otras rentas</option>
            <option value="4">4. Otras rentas (rentas presuntas)</option>
            <option value="5">5. Intereses a personas jurídicas residentes</option>
            <option value="6">6. Intereses a personas físicas residentes</option>
            <option value="7">7. Retención por proveedores del Estado</option>
            <option value="8">8. Juegos telefónicos</option>
            <option value="9">9. Retenciones subsector ganadería de carne bovina</option>
          </select>
        </div>
        <div class="gf-field"><label for="gasto-606-ncf-modificado">NCF o documento modificado</label>
          <input type="text" id="gasto-606-ncf-modificado" class="form-input" placeholder="Si es nota de débito o crédito"></div>
        </div>
      </details>
    </div>`;

  document.getElementById('modal-footer').innerHTML = `
    <button class="btn-secondary" type="button" onclick="closeAllModals()">Cancelar</button>
    <button class="btn-secondary" type="button" onclick="guardarGasto(true)">${ico('printer')}<span>Guardar e imprimir</span></button>
    <button class="btn-primary" type="button" onclick="guardarGasto()">${ico('check')}<span>${gasto ? 'Guardar cambios' : 'Guardar gasto'}</span></button>`;

  const tbody = document.getElementById('gasto-lineas');
  tbody?.addEventListener('input', recalcGastoTotales);
  tbody?.addEventListener('keydown', teclaLineaGasto);
  cablearCategoriasGasto(document.querySelector('#modal-body .gf'));
  if (gasto) rellenarFormularioGasto(gasto);
  document.getElementById('modal-overlay').classList.remove('hidden');
  if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('modal-overlay'));
  setTimeout(() => tbody?.querySelector('.gl-desc')?.focus(), 50);
}

function elegirEstadoGasto(estado) {
  const campo = document.getElementById('gasto-estado');
  if (campo) campo.value = estado;
  document.querySelectorAll('#modal-body .gf-seg-btn').forEach((btn) => {
    const on = btn.dataset.estado === estado;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  toggleGastoFechaPago();
}

function toggleGastoFechaPago() {
  const estado = document.getElementById('gasto-estado')?.value;
  const group = document.getElementById('gasto-fecha-pago-group');
  if (!group) return;
  group.style.display = estado === 'pagado' ? '' : 'none';
}

const redondearGasto = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Totales en vivo (misma cuenta que normalizarLineasGasto del backend:
// ITBIS por línea redondeado a centavos).
function recalcGastoTotales() {
  let subtotal = 0;
  let itbis = 0;
  lineasGastoDelFormulario().forEach((l) => {
    const sub = redondearGasto(l.cantidad * l.precio);
    const imp = redondearGasto(sub * l.itbisPct / 100);
    subtotal += sub;
    itbis += imp;
    const celda = l.tr.querySelector('.gl-imp');
    if (celda) celda.textContent = sub > 0 ? fmt(sub + imp) : '—';
  });
  const retIsr = Number(document.getElementById('gasto-retencion-isr')?.value || 0);
  const retItbis = Number(document.getElementById('gasto-retencion-itbis')?.value || 0);
  const total = redondearGasto(subtotal + itbis);
  const neto = total - retIsr - retItbis;
  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setText('gasto-total-total', fmt(total));
  setText('gasto-total-desglose', itbis > 0 ? `Subtotal ${fmt(subtotal)} · ITBIS ${fmt(itbis)}` : '');
  setText('gasto-total-ret', (retIsr + retItbis) > 0 ? '− ' + fmt(retIsr + retItbis) : fmt(0));
  setText('gasto-total-neto', fmt(neto));
}

async function guardarGasto(imprimir = false) {
  const categoria = document.getElementById('gasto-categoria')?.value;
  const branchId = Number(document.getElementById('gasto-branch')?.value || 0);
  const descripcion = document.getElementById('gasto-descripcion')?.value.trim();
  const fecha = document.getElementById('gasto-fecha')?.value;
  const estado = document.getElementById('gasto-estado')?.value || 'pagado';

  if (!categoria || categoria === CATEGORIA_NUEVA) return showToast('Selecciona una categoría.', 'warning');
  if (!branchId) return showToast('Selecciona una sucursal.', 'warning');
  if (!fecha) return showToast('Indica la fecha del gasto.', 'warning');

  // Filas vacías se ignoran; una fila a medias es un error (no se descarta).
  const lineas = lineasGastoDelFormulario().filter((l) => l.descripcion || l.precio > 0);
  for (let i = 0; i < lineas.length; i += 1) {
    const l = lineas[i];
    const marcar = (sel) => l.tr.querySelector(sel)?.focus();
    if (!l.descripcion) { marcar('.gl-desc'); return showToast(`Línea ${i + 1}: falta la descripción.`, 'warning'); }
    if (!(l.precio > 0)) { marcar('.gl-precio'); return showToast(`Línea ${i + 1}: escribe el precio.`, 'warning'); }
    if (!(l.cantidad > 0)) { marcar('.gl-cant'); return showToast(`Línea ${i + 1}: la cantidad debe ser mayor que cero.`, 'warning'); }
    if (l.itbisPct < 0 || l.itbisPct > 100) { marcar('.gl-itbis'); return showToast(`Línea ${i + 1}: el ITBIS debe estar entre 0% y 100%.`, 'warning'); }
  }
  if (!lineas.length) {
    document.querySelector('#gasto-lineas .gl-desc')?.focus();
    return showToast('Agrega al menos una línea con descripción y precio.', 'warning');
  }
  const items = lineas.map(({ descripcion: d, categoria: c, cantidad, precio, itbisPct }) => ({
    descripcion: d, categoria: c || categoria, cantidad, precio, itbisPct,
  }));
  const subtotal = redondearGasto(lineas.reduce((t, l) => t + redondearGasto(l.cantidad * l.precio), 0));
  const itbis = redondearGasto(lineas.reduce((t, l) => t + redondearGasto(redondearGasto(l.cantidad * l.precio) * l.itbisPct / 100), 0));

  const editandoId = _gastoEditandoId;
  try {
    const datos = {
      categoria, branchId, descripcion, fecha, estado, items,
      supplierId: Number(document.getElementById('gasto-supplier')?.value || 0) || null,
      beneficiario: document.getElementById('gasto-beneficiario')?.value.trim() || '',
      ncf: document.getElementById('gasto-ncf')?.value.trim() || '',
      fechaPago: estado === 'pagado' ? (document.getElementById('gasto-fecha-pago')?.value || fecha) : null,
      subtotal,
      itbis,
      retencionIsr: Number(document.getElementById('gasto-retencion-isr')?.value || 0),
      retencionItbis: Number(document.getElementById('gasto-retencion-itbis')?.value || 0),
      notas: document.getElementById('gasto-notas')?.value.trim() || '',
      formaPago: document.getElementById('gasto-606-forma-pago')?.value ? Number(document.getElementById('gasto-606-forma-pago').value) : null,
      isrTipoRetencion: document.getElementById('gasto-606-isr-tipo')?.value ? Number(document.getElementById('gasto-606-isr-tipo').value) : null,
      ncfModificado: document.getElementById('gasto-606-ncf-modificado')?.value.trim() || '',
    };
    const guardado = editandoId ? await api.updateExpense(editandoId, datos) : await api.createExpense(datos);
    _gastoEditandoId = null;
    closeAllModals();
    showToast(editandoId ? 'Gasto actualizado.' : 'Gasto registrado correctamente.', 'success');
    _expenseCategoriesCache = null; // trae también las categorías nuevas
    loadGastosTable();
    avisarGastosCambiaron();
    if (typeof refreshAuditLogs === 'function') refreshAuditLogs().catch(() => {});
    if (imprimir && guardado?.id) imprimirGasto(guardado.id);
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// Líneas de un gasto; los de antes (sin líneas) son una sola línea con los
// montos de la cabecera.
function lineasDeGasto(g) {
  if (Array.isArray(g.items) && g.items.length) return g.items;
  const subtotal = Number(g.subtotal || 0);
  return [{
    descripcion: g.descripcion, cantidad: 1, precio: subtotal,
    itbisPct: subtotal > 0 ? redondearGasto(Number(g.itbis || 0) / subtotal * 100) : 0,
    subtotal, itbis: Number(g.itbis || 0), total: Number(g.total || 0),
  }];
}

const numeroGasto = (id) => 'GAS-' + String(id).padStart(6, '0');

// Editar usa el mismo permiso que registrar (gastos.crear).
function puedeEditarGastos() {
  return typeof currentUserCan !== 'function' || currentUserCan('gastos.crear');
}

// "Mantenimiento" o "Mantenimiento +2" cuando las líneas tienen otras categorías.
function categoriasDeGastoTexto(g) {
  const lista = Array.isArray(g.categorias) && g.categorias.length ? g.categorias : [g.categoria];
  return lista.length > 1 ? `${lista[0]} +${lista.length - 1}` : (lista[0] || '');
}

async function verGasto(id) {
  try {
    const g = await api.getExpense(id);
    const lineas = lineasDeGasto(g);
    const variasCategorias = (g.categorias || []).length > 1;
    const ret = Number(g.retencionIsr || 0) + Number(g.retencionItbis || 0);
    const dato = (label, valor) => `<div class="gf-field"><label>${label}</label><div class="gf-dato">${valor}</div></div>`;
    const estado = { pagado: 'Pagado', pendiente: 'Pendiente de pago', anulado: 'Anulado' }[g.estado] || g.estado;
    document.getElementById('modal-title').textContent = `Gasto ${numeroGasto(g.id)}`;
    document.getElementById('modal-box')?.classList.add('gasto-modal');
    document.getElementById('modal-body').innerHTML = `
      <div class="gf">
        ${g.estado === 'anulado' ? `<p class="gf-aviso">Gasto anulado${g.motivoAnulacion ? ': ' + escapeHtml(g.motivoAnulacion) : ''}.</p>` : ''}
        <section class="gf-card">
          <h4 class="gf-title"><span class="gf-ico">${gastoIco('receipt-text')}</span>${escapeHtml(g.descripcion)}</h4>
          <div class="gf-grid gf-grid-3">
            ${dato(variasCategorias ? 'Categorías' : 'Categoría', escapeHtml((g.categorias && g.categorias.length ? g.categorias : [g.categoria]).join(', ')))}
            ${dato('Fecha', fmtCompraFecha(g.fecha))}
            ${dato('Estado', `<span class="gf-estado gf-estado--${escapeHtml(g.estado)}">${escapeHtml(estado)}</span>`)}
            ${dato('Proveedor / beneficiario', escapeHtml(g.proveedor || g.beneficiario || '—'))}
            ${dato('NCF', escapeHtml(g.ncf || '—'))}
            ${dato('Sucursal', escapeHtml(g.sucursal || '—'))}
          </div>
          ${g.notas ? `<p class="gf-nota">${escapeHtml(g.notas)}</p>` : ''}
        </section>
        <section class="gf-card">
          <h4 class="gf-title"><span class="gf-ico">${gastoIco('list')}</span>Detalle (${lineas.length} ${lineas.length === 1 ? 'línea' : 'líneas'})</h4>
          <div class="gf-lineas-wrap">
            <table class="gf-lineas gf-lineas--ver">
              <thead><tr><th>Descripción</th><th class="num">Cant.</th><th class="num">Precio</th><th class="num">ITBIS</th><th class="num">Importe</th></tr></thead>
              <tbody>${lineas.map((l) => `<tr>
                <td>${escapeHtml(l.descripcion)}${variasCategorias && l.categoria ? `<small class="gf-sub">${escapeHtml(l.categoria)}</small>` : ''}</td>
                <td class="num">${Number(l.cantidad)}</td>
                <td class="num">${fmt(l.precio)}</td>
                <td class="num">${Number(l.itbis) > 0 ? fmt(l.itbis) : '—'}</td>
                <td class="num">${fmt(l.total)}</td></tr>`).join('')}</tbody>
            </table>
          </div>
          <div class="gf-totales">
            <div><span>Total del gasto</span><b>${fmt(g.total)}</b><small>Subtotal ${fmt(g.subtotal)} · ITBIS ${fmt(g.itbis)}</small></div>
            <div><span>Retenciones</span><b>${ret > 0 ? '− ' + fmt(ret) : fmt(0)}</b></div>
            <div class="gf-neto"><span>Neto a pagar</span><b>${fmt(g.montoNetoBeneficiario)}</b></div>
          </div>
        </section>
      </div>`;
    const puedeEditar = g.estado !== 'anulado' && puedeEditarGastos();
    document.getElementById('modal-footer').innerHTML = `
      <button class="btn-secondary" type="button" onclick="closeAllModals()">Cerrar</button>
      ${puedeEditar ? `<button class="btn-secondary" type="button" onclick="editarGasto(${Number(g.id)})">${gastoIco('file-pen-line')}<span>Editar</span></button>` : ''}
      <button class="btn-primary" type="button" onclick="imprimirGasto(${Number(g.id)})">${gastoIco('printer')}<span>Imprimir</span></button>`;
    document.getElementById('modal-overlay').classList.remove('hidden');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// ── Imprimir un gasto con la plantilla A4 de Configuración ────────────────
const FORMAS_PAGO_606 = {
  1: 'Efectivo', 2: 'Cheque / transferencia / depósito', 3: 'Tarjeta de crédito o débito',
  4: 'A crédito', 5: 'Permuta', 6: 'Nota de crédito', 7: 'Mixto',
};

// Gasto → datos de FacturaPlantillas.render (js/factura-plantillas.js).
function gastoAFormalDoc(g) {
  const cfg = DB.config || {};
  const prov = (DB.proveedores || []).find((p) => Number(p.id) === Number(g.supplierId));
  const anulado = g.estado === 'anulado';
  const ret = (label, monto) => (Number(monto) > 0 ? [[label, '- ' + fmt(monto), '']] : []);
  return {
    titulo: 'GASTO',
    etiquetaCliente: 'Proveedor / beneficiario',
    isCot: false,
    anulada: anulado,
    marcaAgua: 'ANULADO',
    selloClase: anulado ? 'bad' : (g.estado === 'pendiente' ? 'warn' : 'ok'),
    estadoLabel: { pagado: 'PAGADO', pendiente: 'PENDIENTE DE PAGO', anulado: 'ANULADO' }[g.estado] || String(g.estado || '').toUpperCase(),
    pagado: 0,
    balance: 0,
    empresa: {
      nombre: cfg.nombre || 'Tecno Caja', rnc: cfg.rnc || '', direccion: cfg.direccion || '',
      telefono: cfg.telefono || '', logo: cfg.logo || '',
    },
    numero: numeroGasto(g.id),
    ncf: g.ncf || '',
    fiscalMode: 'ncf',
    ncfTipoLabel: '',
    fechaTexto: fmtCompraFecha(g.fecha),
    vencimientoTexto: '',
    metodoPago: FORMAS_PAGO_606[g.formaPago] || '',
    condicionPago: g.estado === 'pagado'
      ? `Pagado${g.fechaPago ? ' el ' + fmtCompraFecha(g.fechaPago) : ''}`
      : (anulado ? 'Anulado' : 'Pendiente de pago'),
    cliente: {
      nombre: g.proveedor || g.beneficiario || '—',
      rnc: prov?.rnc || prov?.cedula || '',
      tel: prov?.telefono || '',
      dir: prov?.direccion || '',
    },
    // Con varias categorías, cada línea lleva la suya debajo de la descripción.
    items: lineasDeGasto(g).map((l) => ({
      descripcion: l.descripcion, cantidad: l.cantidad, precio: l.precio,
      itbisPct: l.itbisPct, itbisMonto: l.itbis, total: l.subtotal,
      nota: (g.categorias || []).length > 1 && l.categoria ? l.categoria : '',
    })),
    subtotal: Number(g.subtotal || 0),
    descuento: 0,
    itbis: Number(g.itbis || 0),
    redondeo: 0,
    total: Number(g.total || 0),
    lineasPago: [
      ...ret('Retención ISR', g.retencionIsr),
      ...ret('Retención ITBIS', g.retencionItbis),
      ['Neto a pagar', fmt(g.montoNetoBeneficiario), g.estado === 'pendiente' ? 'due' : 'paid'],
    ],
    notasTitulo: 'Concepto',
    notas: [`${g.descripcion}\n${(g.categorias || []).length > 1 ? 'Categorías: ' + g.categorias.join(', ') : 'Categoría: ' + g.categoria}`, g.notas]
      .filter(Boolean).join('\n\n'),
    firmas: { etiqueta: 'Autorizado por', cliente: 'Recibido por' },
    pie: 'Comprobante interno de gasto. Documento generado electrónicamente.',
  };
}

function gastoDocumentoHtml(g) {
  const FP = window.FacturaPlantillas;
  const hoja = FP.render(gastoAFormalDoc(g), {
    plantilla: DB.config?.invoiceTemplate,
    color: DB.config?.invoiceAccentColor,
  });
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>${escapeHtml(numeroGasto(g.id))}</title>
<style>@page{size:A4;margin:0}html,body{margin:0;padding:0;background:#eef1f4}@media print{html,body{background:#fff}}</style>
</head><body>${hoja}${FP.scriptUnaHoja()}</body></html>`;
}

// Ventana con la hoja A4 y una barra: Imprimir y Guardar PDF.
function abrirVentanaGasto(g) {
  const html = gastoDocumentoHtml(g);
  const titulo = `Gasto ${numeroGasto(g.id)}`;
  const w = window.open('', '_blank');
  if (!w) { showToast('Permite las ventanas emergentes para ver el documento.', 'warning'); return; }
  const puedePdf = !!(window.novaDesktop?.htmlToPdf && window.novaDesktop?.saveInvoicePdf);
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(titulo)}</title>
    <style>body{margin:0;background:#eef1f4;font-family:system-ui,"Segoe UI",sans-serif}
    .bar{position:sticky;top:0;display:flex;gap:8px;align-items:center;padding:9px 14px;background:#111827;color:#fff}
    .bar strong{margin-right:auto}
    .bar button{font:inherit;font-weight:600;padding:7px 14px;border-radius:7px;border:0;cursor:pointer;background:#374151;color:#fff}
    .bar button.p{background:#6c63ff}
    iframe{width:100%;border:0;height:calc(100vh - 52px)}</style></head>
    <body><div class="bar"><strong>${escapeHtml(titulo)}</strong>
      ${puedePdf ? '<button id="pf">Guardar PDF</button>' : ''}
      <button class="p" id="pr">Imprimir</button></div>
    <iframe id="fr"></iframe></body></html>`);
  w.document.close();
  const fr = w.document.getElementById('fr');
  fr.srcdoc = html;
  w.document.getElementById('pr').onclick = () => { try { fr.contentWindow.print(); } catch (_) {} };
  const pf = w.document.getElementById('pf');
  if (pf) {
    pf.onclick = async () => {
      pf.disabled = true;
      try {
        const pdfBase64 = await window.novaDesktop.htmlToPdf(html);
        if (!pdfBase64) throw new Error('No se pudo generar el PDF.');
        const r = await window.novaDesktop.saveInvoicePdf({
          invoiceNumber: numeroGasto(g.id),
          clientName: g.proveedor || g.beneficiario || 'Gasto',
          date: g.fecha || undefined,
          businessName: DB.config?.nombre || 'Tecno Caja',
          branchName: g.sucursal || 'Principal',
          pdfBase64,
        });
        if (!r?.ok) throw new Error(r?.error || 'No se pudo guardar el PDF.');
        showToast('PDF guardado' + (r.filePath ? ': ' + r.filePath : ''), 'success');
        if (window.novaDesktop.openExternal && r.filePath) {
          try { window.novaDesktop.openExternal('file:///' + String(r.filePath).replace(/\\/g, '/')); } catch (_) {}
        }
      } catch (e) {
        showToast(e.message, 'error');
      } finally {
        pf.disabled = false;
      }
    };
  }
}

async function imprimirGasto(id) {
  if (!window.FacturaPlantillas) { showToast('Las plantillas de factura no están disponibles.', 'error'); return; }
  try {
    abrirVentanaGasto(await api.getExpense(id));
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
    avisarGastosCambiaron();
    if (typeof refreshAuditLogs === 'function') refreshAuditLogs().catch(() => {});
  } catch (e) {
    showToast(e.message, 'error');
  }
}
