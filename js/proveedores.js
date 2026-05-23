// ===== TECNO_CAJA - PROVEEDORES =====

const WEEK_DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

function supplierText(value) {
  return typeof window.translateCatalogText === 'function'
    ? window.translateCatalogText(String(value || ''))
    : String(value || '');
}

function supplierLocale() {
  return typeof getCurrentLocale === 'function' ? getCurrentLocale() : 'es-DO';
}

function getSupplierInvoicesFor(id) {
  return (DB.facturasProveedores || []).filter((item) => item.supplierId === id);
}

function getSupplierPendingSummary(id) {
  const invoices = getSupplierInvoicesFor(id);
  return {
    totalFacturas: invoices.length,
    pendientes: invoices.filter((item) => item.montoPendiente > 0).length,
    totalPendiente: invoices.reduce((sum, item) => sum + Number(item.montoPendiente || 0), 0)
  };
}

function getVisitDaysArray(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getNextVisitDayLabel(proveedor) {
  const visitDays = getVisitDaysArray(proveedor.diasVisita);
  if (!visitDays.length) return supplierText('Sin ruta definida');
  const todayIndex = Math.max(0, new Date().getDay() - 1);
  const indexes = visitDays.map((day) => WEEK_DAYS.indexOf(day)).filter((index) => index >= 0);
  if (!indexes.length) return supplierText('Sin ruta definida');
  const sorted = indexes.sort((a, b) => a - b);
  const nextIndex = sorted.find((index) => index >= todayIndex);
  return supplierText(WEEK_DAYS[nextIndex ?? sorted[0]]);
}

function getSupplierInvoiceStatusBadge(status) {
  const map = {
    Pendiente: 'badge-warning',
    Vencida: 'badge-danger',
    Pagada: 'badge-success'
  };
  return `<span class="badge ${map[status] || 'badge-info'}">${supplierText(status)}</span>`;
}

function formatSupplierDate(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString(supplierLocale());
}

function getFilteredProveedores(query) {
  const q = String(query || document.getElementById('proveedores-search')?.value || '').toLowerCase().trim();
  if (!q) return DB.proveedores || [];
  return (DB.proveedores || []).filter((proveedor) => (
    [
      proveedor.nombre,
      proveedor.empresa,
      proveedor.telefono,
      proveedor.email,
      proveedor.rnc,
      proveedor.contacto,
      proveedor.direccion,
      proveedor.diasVisita
    ].some((value) => String(value || '').toLowerCase().includes(q))
  ));
}

function updateProveedoresStats() {
  const suppliers = DB.proveedores || [];
  const invoices = DB.facturasProveedores || [];
  const totalEl = document.getElementById('prov-total');
  const activosEl = document.getElementById('prov-activos');
  const pendientesEl = document.getElementById('prov-pendientes');
  const vencidasEl = document.getElementById('prov-vencidas');
  if (!totalEl || !activosEl || !pendientesEl || !vencidasEl) return;

  totalEl.textContent = suppliers.length;
  activosEl.textContent = suppliers.filter((item) => item.estado === 'Activo').length;
  pendientesEl.textContent = fmt(invoices.reduce((sum, item) => sum + Number(item.montoPendiente || 0), 0));
  vencidasEl.textContent = fmt(invoices.filter((item) => item.estado === 'Vencida').reduce((sum, item) => sum + Number(item.montoPendiente || 0), 0));
}

function loadProveedoresTable(filter) {
  const tbody = document.getElementById('proveedores-tbody');
  if (!tbody) return;
  const list = getFilteredProveedores(filter);
  tbody.innerHTML = list.map((proveedor) => {
    const summary = getSupplierPendingSummary(proveedor.id);
    return `
      <tr onclick="openProveedorModal(${proveedor.id})" style="cursor:pointer">
        <td>
          <div style="display:flex;flex-direction:column;gap:0.2rem">
            <span style="font-weight:600">${proveedor.nombre}</span>
            <span class="products-subtle">${proveedor.empresa || proveedor.telefono || supplierText('Sin empresa registrada')}</span>
          </div>
        </td>
        <td>${getNextVisitDayLabel(proveedor)}</td>
        <td><div class="supplier-summary"><strong>${fmt(summary.totalPendiente)}</strong><span class="products-subtle">${summary.totalFacturas} ${supplierText('factura(s)')}</span></div></td>
        <td><span class="badge ${proveedor.estado === 'Activo' ? 'badge-success' : 'badge-warning'}">${supplierText(proveedor.estado)}</span></td>
        <td>
          <button class="btn-edit" onclick="event.stopPropagation(); openProveedorModal(${proveedor.id})">✏ ${supplierText('Ver')}</button>
        </td>
      </tr>
    `;
  }).join('') || `<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--text3)">${supplierText('No se encontraron proveedores')}</td></tr>`;
  renderSupplierInvoicesTable();
  updateProveedoresStats();
  if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('module-proveedores'));
}

function renderSupplierInvoicesTable() {
  const tbody = document.getElementById('proveedores-facturas-tbody');
  if (!tbody) return;
  const invoices = (DB.facturasProveedores || []).slice().sort((a, b) => String(b.fechaEmision).localeCompare(String(a.fechaEmision)));
  tbody.innerHTML = invoices.map((invoice) => `
    <tr>
      <td style="font-weight:600">${invoice.proveedor}</td>
      <td class="supplier-money-cell">${invoice.numeroFactura}</td>
      <td class="supplier-money-cell" style="font-weight:700">${fmt(invoice.montoPendiente)}</td>
      <td>${getSupplierInvoiceStatusBadge(invoice.estado)}</td>
      <td>${invoice.montoPendiente > 0 ? `<button class="btn-edit" onclick="openSupplierPaymentModal(${invoice.id})">💵 ${supplierText('Abonar')}</button>` : '—'}</td>
    </tr>
  `).join('') || `<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--text3)">${supplierText('No hay facturas registradas')}</td></tr>`;
}

function filterProveedores(value) {
  loadProveedoresTable(value);
}

function buildVisitDaysChecklist(selected) {
  const selectedDays = new Set(getVisitDaysArray(selected));
  return `
    <div class="span-full">
      <label style="display:block;margin-bottom:0.5rem;color:var(--text2);font-size:0.85rem;font-weight:500">Días de visita</label>
      <div style="display:flex;flex-wrap:wrap;gap:0.5rem">
        ${WEEK_DAYS.map((day) => `
          <label class="badge badge-info" style="cursor:pointer;padding:0.45rem 0.7rem">
            <input type="checkbox" class="prov-dia" value="${day}" ${selectedDays.has(day) ? 'checked' : ''} style="margin-right:6px">
            ${supplierText(day)}
          </label>
        `).join('')}
      </div>
    </div>
  `;
}

function getSelectedVisitDays() {
  return Array.from(document.querySelectorAll('.prov-dia:checked')).map((el) => el.value).join(',');
}

function openProveedorModal(id) {
  const proveedor = id ? (DB.proveedores || []).find((item) => item.id === id) : null;
  const summary = proveedor ? getSupplierPendingSummary(proveedor.id) : { pendientes: 0, totalPendiente: 0 };
  document.getElementById('modal-title').textContent = proveedor ? supplierText('Editar Proveedor') : supplierText('Nuevo Proveedor');
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-grid">
      <div class="form-group span-full"><label>${supplierText('Nombre del Proveedor')}</label><input type="text" id="prov-nombre" class="form-input" value="${proveedor?.nombre || ''}" placeholder="${supplierText('Nombre o razón comercial')}"></div>
      <div class="form-group"><label>${supplierText('Empresa')}</label><input type="text" id="prov-empresa" class="form-input" value="${proveedor?.empresa || ''}" placeholder="${supplierText('Empresa suplidora')}"></div>
      <div class="form-group"><label>${supplierText('Contacto')}</label><input type="text" id="prov-contacto" class="form-input" value="${proveedor?.contacto || ''}" placeholder="${supplierText('Persona de contacto')}"></div>
      <div class="form-group"><label>${supplierText('Teléfono')}</label><input type="text" id="prov-telefono" class="form-input" value="${proveedor?.telefono || ''}" placeholder="809-000-0000"></div>
      <div class="form-group"><label>${supplierText('Email')}</label><input type="email" id="prov-email" class="form-input" value="${proveedor?.email || ''}" placeholder="correo@empresa.com"></div>
      <div class="form-group"><label>RNC</label><input type="text" id="prov-rnc" class="form-input" value="${proveedor?.rnc || ''}" placeholder="000-00000-0"></div>
      <div class="form-group"><label>${supplierText('Términos de pago (días)')}</label><input type="number" id="prov-terminos" class="form-input" value="${proveedor?.terminosPagoDias || 30}" min="0"></div>
      <div class="form-group"><label>${supplierText('Estado')}</label>
        <select id="prov-estado" class="form-input">
          <option value="Activo" ${proveedor?.estado !== 'Inactivo' ? 'selected' : ''}>${supplierText('Activo')}</option>
          <option value="Inactivo" ${proveedor?.estado === 'Inactivo' ? 'selected' : ''}>${supplierText('Inactivo')}</option>
        </select>
      </div>
      ${buildVisitDaysChecklist(proveedor?.diasVisita || '')}
      <div class="form-group span-full"><label>${supplierText('Dirección')}</label><input type="text" id="prov-direccion" class="form-input" value="${proveedor?.direccion || ''}" placeholder="${supplierText('Dirección del proveedor')}"></div>
      ${proveedor ? `<div class="span-full"><div class="product-form-summary"><div class="product-form-card"><label>${supplierText('Facturas pendientes')}</label><strong>${summary.pendientes}</strong></div><div class="product-form-card"><label>${supplierText('Total pendiente')}</label><strong>${fmt(summary.totalPendiente)}</strong></div><div class="product-form-card"><label>${supplierText('Próxima visita')}</label><strong>${getNextVisitDayLabel(proveedor)}</strong></div></div></div>` : ''}
    </div>
  `;
  document.getElementById('modal-footer').innerHTML = `
    <button class="btn-secondary" onclick="closeAllModals()">${supplierText('Cancelar')}</button>
    <button class="btn-primary" onclick="saveProveedor(${id || 'null'})">💾 ${supplierText('Guardar')}</button>
  `;
  document.getElementById('modal-overlay').classList.remove('hidden');
  if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('modal-overlay'));
  if (window.RNCLookup) {
    const rncEl = document.getElementById('prov-rnc');
    if (rncEl && !rncEl.dataset.rncAttached) {
      rncEl.dataset.rncAttached = '1';
      RNCLookup.attach(rncEl, {
        nameEl: document.getElementById('prov-nombre'),
        mode: 'both',
      });
    }
  }
}

async function saveProveedor(id) {
  const nombre = document.getElementById('prov-nombre').value.trim();
  if (!nombre) {
    showToast(supplierText('El nombre del proveedor es obligatorio'), 'error');
    return;
  }

  const data = {
    nombre,
    empresa: document.getElementById('prov-empresa').value.trim(),
    contacto: document.getElementById('prov-contacto').value.trim(),
    telefono: document.getElementById('prov-telefono').value.trim(),
    email: document.getElementById('prov-email').value.trim(),
    rnc: document.getElementById('prov-rnc').value.trim(),
    direccion: document.getElementById('prov-direccion').value.trim(),
    diasVisita: getSelectedVisitDays(),
    terminosPagoDias: parseInt(document.getElementById('prov-terminos').value, 10) || 30,
    estado: document.getElementById('prov-estado').value
  };

  try {
    if (id) {
      const updated = await api.updateSupplier(id, { ...data, ...getActorPayload() });
      const idx = DB.proveedores.findIndex((item) => item.id === id);
      if (idx >= 0) DB.proveedores[idx] = updated;
      showToast(supplierText('Proveedor actualizado'), 'success');
    } else {
      const created = await api.createSupplier({ ...data, ...getActorPayload() });
      DB.proveedores.push(created);
      showToast(supplierText('Proveedor creado'), 'success');
    }
  } catch (error) {
    showToast(error.message, 'error');
    return;
  }

  closeAllModals();
  try {
    loadProveedoresTable();
    if (typeof refreshAuditLogs === 'function') await refreshAuditLogs();
  } catch (uiError) {
    console.error('[Tecno Caja] Error refrescando UI de proveedores:', uiError);
  }
}

function openSupplierInvoiceModal(supplierId = null) {
  const suppliers = (DB.proveedores || []).filter((item) => item.estado === 'Activo');
  const selectedId = supplierId || suppliers[0]?.id || '';
  const supplier = suppliers.find((item) => item.id === selectedId) || (DB.proveedores || []).find((item) => item.id === selectedId);
  const today = new Date().toISOString().slice(0, 10);
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + Number(supplier?.terminosPagoDias || 30));
  document.getElementById('modal-title').textContent = supplierText('Registrar Factura de Proveedor');
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-grid">
      <div class="form-group"><label>${supplierText('Proveedor')}</label>
        <select id="spi-supplier" class="form-input" onchange="syncSupplierInvoiceDueDate()">
          ${suppliers.map((item) => `<option value="${item.id}" ${Number(selectedId) === item.id ? 'selected' : ''}>${item.nombre}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>${supplierText('No. Factura')}</label><input type="text" id="spi-number" class="form-input" placeholder="FAC-000123"></div>
      <div class="form-group"><label>${supplierText('Fecha emisión')}</label><input type="date" id="spi-issued" class="form-input" value="${today}" onchange="syncSupplierInvoiceDueDate()"></div>
      <div class="form-group"><label>${supplierText('Fecha vencimiento')}</label><input type="date" id="spi-due" class="form-input" value="${dueDate.toISOString().slice(0, 10)}"></div>
      <div class="form-group"><label>${supplierText('Monto total')}</label><input type="number" id="spi-total" class="form-input" min="0" step="0.01" value="0"></div>
      <div class="form-group"><label>${supplierText('Monto abonado')}</label><input type="number" id="spi-paid" class="form-input" min="0" step="0.01" value="0"></div>
      <div class="form-group span-full"><label>${supplierText('Notas')}</label><input type="text" id="spi-notes" class="form-input" placeholder="${supplierText('Observaciones de la factura')}"></div>
    </div>
  `;
  document.getElementById('modal-footer').innerHTML = `
    <button class="btn-secondary" onclick="closeAllModals()">${supplierText('Cancelar')}</button>
    <button class="btn-primary" onclick="saveSupplierInvoice()">💾 ${supplierText('Guardar Factura')}</button>
  `;
  document.getElementById('modal-overlay').classList.remove('hidden');
  if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('modal-overlay'));
}

function syncSupplierInvoiceDueDate() {
  const supplierId = Number(document.getElementById('spi-supplier')?.value || 0);
  const supplier = (DB.proveedores || []).find((item) => item.id === supplierId);
  const issued = document.getElementById('spi-issued')?.value;
  const dueInput = document.getElementById('spi-due');
  if (!supplier || !issued || !dueInput) return;
  const dueDate = new Date(issued);
  dueDate.setDate(dueDate.getDate() + Number(supplier.terminosPagoDias || 30));
  dueInput.value = dueDate.toISOString().slice(0, 10);
}

async function saveSupplierInvoice() {
  const supplierId = Number(document.getElementById('spi-supplier').value || 0);
  const numeroFactura = document.getElementById('spi-number').value.trim();
  const fechaEmision = document.getElementById('spi-issued').value;
  const fechaVencimiento = document.getElementById('spi-due').value;
  const montoTotal = parseFloat(document.getElementById('spi-total').value) || 0;
  const montoPagado = parseFloat(document.getElementById('spi-paid').value) || 0;
  if (!supplierId || !numeroFactura || !fechaEmision || montoTotal <= 0) {
    showToast(supplierText('Completa proveedor, factura, fecha y monto total'), 'error');
    return;
  }
  if (montoPagado > montoTotal) {
    showToast(supplierText('El abono inicial no puede ser mayor que el total'), 'error');
    return;
  }

  try {
    const created = await api.createSupplierInvoice({
      supplierId,
      numeroFactura,
      fechaEmision,
      fechaVencimiento,
      montoTotal,
      montoPagado,
      notas: document.getElementById('spi-notes').value.trim(),
      ...getActorPayload()
    });
    DB.facturasProveedores.unshift(created);
    closeAllModals();
    loadProveedoresTable();
    if (typeof refreshAuditLogs === 'function') await refreshAuditLogs();
    showToast(supplierText('Factura registrada correctamente'), 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function openSupplierPaymentModal(invoiceId) {
  const invoice = (DB.facturasProveedores || []).find((item) => item.id === invoiceId);
  if (!invoice) return;
  document.getElementById('modal-title').textContent = supplierText('Registrar Abono');
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-grid">
      <div class="form-group"><label>${supplierText('Proveedor')}</label><input type="text" class="form-input" value="${invoice.proveedor}" disabled></div>
      <div class="form-group"><label>${supplierText('Factura')}</label><input type="text" class="form-input" value="${invoice.numeroFactura}" disabled></div>
      <div class="form-group"><label>${supplierText('Total factura')}</label><input type="text" class="form-input" value="${fmt(invoice.montoTotal)}" disabled></div>
      <div class="form-group"><label>${supplierText('Pendiente actual')}</label><input type="text" class="form-input" value="${fmt(invoice.montoPendiente)}" disabled></div>
      <div class="form-group span-full"><label>${supplierText('Monto a abonar')}</label><input type="number" id="spi-payment-amount" class="form-input" min="0" max="${invoice.montoPendiente}" step="0.01" value="${invoice.montoPendiente}"></div>
    </div>
  `;
  document.getElementById('modal-footer').innerHTML = `
    <button class="btn-secondary" onclick="closeAllModals()">${supplierText('Cancelar')}</button>
    <button class="btn-primary" onclick="saveSupplierPayment(${invoiceId})">💵 ${supplierText('Aplicar Abono')}</button>
  `;
  document.getElementById('modal-overlay').classList.remove('hidden');
  if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('modal-overlay'));
}

async function saveSupplierPayment(invoiceId) {
  const amount = parseFloat(document.getElementById('spi-payment-amount').value) || 0;
  if (amount <= 0) {
    showToast(supplierText('El monto del abono debe ser mayor que cero'), 'error');
    return;
  }

  try {
    const updated = await api.paySupplierInvoice(invoiceId, {
      monto: amount,
      ...getActorPayload()
    });
    const idx = DB.facturasProveedores.findIndex((item) => item.id === invoiceId);
    if (idx >= 0) DB.facturasProveedores[idx] = updated;
    closeAllModals();
    loadProveedoresTable();
    if (typeof refreshAuditLogs === 'function') await refreshAuditLogs();
    showToast(supplierText('Abono aplicado correctamente'), 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function deleteProveedor(id) {
  const summary = getSupplierPendingSummary(id);
  if (summary.totalPendiente > 0) {
    showToast(supplierText('No puedes eliminar este proveedor porque tiene facturas pendientes.'), 'warning');
    return;
  }
  if (!confirm(supplierText('¿Eliminar este proveedor?'))) return;
  try {
    await api.request(`/api/suppliers/${id}`, {
      method: 'DELETE',
      body: JSON.stringify(getActorPayload())
    });
    closeAllModals();
    DB.proveedores = (DB.proveedores || []).filter((item) => Number(item.id) !== Number(id));
    DB.facturasProveedores = (DB.facturasProveedores || []).filter((item) => Number(item.supplierId) !== Number(id));
    loadProveedoresTable(document.getElementById('proveedores-search')?.value || '');
    if (typeof refreshAuditLogs === 'function') await refreshAuditLogs();
    showToast(supplierText('Proveedor eliminado'), 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}
