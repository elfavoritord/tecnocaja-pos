// ===== TECNO_CAJA - PROVEEDORES (v2) =====

const WEEK_DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

const TIPOS_PROVEEDOR = ['Mercancía General', 'Materia Prima', 'Servicios', 'Tecnología', 'Alimentos y Bebidas', 'Farmacéutico', 'Construcción', 'Otros'];
const METODOS_PAGO   = ['Efectivo', 'Cheque', 'Transferencia', 'Tarjeta', 'Depósito', 'Otro'];
const TIPOS_NCF      = ['B01', 'B02', 'B03', 'B04', 'B14', 'B15', 'E31', 'E32', 'E33', 'E34', 'E41', 'E43', 'E44', 'E45', 'E46', 'E47'];

function supplierText(v) {
  return typeof window.translateCatalogText === 'function'
    ? window.translateCatalogText(String(v || ''))
    : String(v || '');
}
function supplierLocale() {
  return typeof getCurrentLocale === 'function' ? getCurrentLocale() : 'es-DO';
}
function fmtS(n) { return typeof fmt === 'function' ? fmt(n) : `RD$ ${Number(n||0).toFixed(2)}`; }
function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d) ? String(v) : d.toLocaleDateString(supplierLocale());
}
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Helpers de datos ──────────────────────────────────────────────────────────
function getSupplierInvoicesFor(id) {
  return (DB.facturasProveedores || []).filter(i => i.supplierId === id);
}
function getSupplierPendingSummary(id) {
  const inv = getSupplierInvoicesFor(id);
  const today = new Date().toISOString().slice(0,10);
  return {
    totalFacturas: inv.length,
    pendientes:    inv.filter(i => i.montoPendiente > 0).length,
    vencidas:      inv.filter(i => i.estado === 'Vencida').length,
    totalPendiente: inv.reduce((s,i) => s + Number(i.montoPendiente||0), 0),
    montoVencido:   inv.filter(i=>i.estado==='Vencida').reduce((s,i)=>s+Number(i.montoPendiente||0),0),
  };
}
function getVisitDaysArray(v) {
  return String(v||'').split(',').map(d=>d.trim()).filter(Boolean);
}
function getNextVisitDayLabel(p) {
  const days = getVisitDaysArray(p.diasVisita);
  if (!days.length) return 'Sin ruta';
  const idx = (new Date().getDay() + 6) % 7;
  const nums = days.map(d=>WEEK_DAYS.indexOf(d)).filter(n=>n>=0).sort((a,b)=>a-b);
  const next = nums.find(n=>n>=idx) ?? nums[0];
  return WEEK_DAYS[next] || 'Sin ruta';
}
function getSupplierInvoiceStatusBadge(s) {
  const m = { Pendiente:'badge-warning', Vencida:'badge-danger', Pagada:'badge-success' };
  return `<span class="badge ${m[s]||'badge-info'}">${esc(s)}</span>`;
}
function hasAlerts(id) {
  const s = getSupplierPendingSummary(id);
  return s.vencidas > 0 || (s.pendientes > 0 && s.montoVencido > 0);
}

// ── Filtro de lista ───────────────────────────────────────────────────────────
function getFilteredProveedores() {
  const q     = String(document.getElementById('proveedores-search')?.value || '').toLowerCase().trim();
  const filt  = document.getElementById('prov-filter-estado')?.value || '';
  let list    = DB.proveedores || [];

  if (q) list = list.filter(p =>
    [p.nombre, p.empresa, p.razonSocial, p.nombreComercial, p.telefono, p.email, p.rnc, p.contacto, p.ciudad, p.provincia, p.tipoProveedor]
      .some(v => String(v||'').toLowerCase().includes(q))
  );
  if (filt === 'Activo')         list = list.filter(p => p.estado === 'Activo');
  if (filt === 'Inactivo')       list = list.filter(p => p.estado === 'Inactivo');
  if (filt === 'con_pendientes') list = list.filter(p => getSupplierPendingSummary(p.id).totalPendiente > 0);
  if (filt === 'con_vencidas')   list = list.filter(p => getSupplierPendingSummary(p.id).vencidas > 0);
  return list;
}

function filterProveedores() {
  renderProveedoresList();
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function updateProveedoresStats() {
  const suppliers = DB.proveedores || [];
  const invoices  = DB.facturasProveedores || [];
  const totalPend = invoices.reduce((s,i) => s+Number(i.montoPendiente||0), 0);
  const totalVenc = invoices.filter(i=>i.estado==='Vencida').reduce((s,i)=>s+Number(i.montoPendiente||0),0);
  const conAlertas = suppliers.filter(p => hasAlerts(p.id)).length;
  const totalComprado = invoices.reduce((s,i)=>s+Number(i.montoTotal||0),0);

  const set = (id,v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
  set('prov-total',     suppliers.length);
  set('prov-activos',   suppliers.filter(p=>p.estado==='Activo').length);
  set('prov-con-alertas', conAlertas);
  set('prov-balance-total', fmtS(totalComprado));
  set('prov-pendientes', fmtS(totalPend));
  set('prov-vencidas',   fmtS(totalVenc));
}

// ── Lista de proveedores (panel izquierdo) ────────────────────────────────────
let _activeProveedorId = null;

function renderProveedoresList() {
  const container = document.getElementById('prov-list-body');
  if (!container) return;
  updateProveedoresStats();
  const list = getFilteredProveedores();

  if (!list.length) {
    container.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text3);font-size:.85rem">No se encontraron proveedores</div>`;
    return;
  }

  container.innerHTML = list.map(p => {
    const s    = getSupplierPendingSummary(p.id);
    const isA  = _activeProveedorId === p.id;
    const alert = s.vencidas > 0 ? '🔴' : s.pendientes > 0 ? '🟡' : '';
    const estadoBg = p.estado === 'Activo' ? '#065f46' : '#374151';
    const estadoColor = p.estado === 'Activo' ? '#6ee7b7' : '#9ca3af';
    return `
      <div onclick="openProveedorDetail(${p.id})"
        style="padding:10px 12px;border-radius:8px;cursor:pointer;border:1px solid ${isA?'var(--green,#22c55e)':'var(--border,#374151)'};background:${isA?'rgba(34,197,94,.08)':'var(--bg2,#1f2937)'};transition:border-color .15s"
        onmouseover="if(${p.id}!==_activeProveedorId)this.style.borderColor='rgba(34,197,94,.4)'"
        onmouseout="if(${p.id}!==_activeProveedorId)this.style.borderColor='var(--border,#374151)'">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <div style="flex:1;font-weight:600;font-size:.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.nombre)}${alert?' '+alert:''}</div>
          <span style="background:${estadoBg};color:${estadoColor};border-radius:4px;padding:1px 6px;font-size:.7rem;font-weight:700;flex-shrink:0">${esc(p.estado)}</span>
        </div>
        <div style="font-size:.75rem;color:var(--text3);margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${p.rnc ? `RNC: ${esc(p.rnc)}` : ''}${p.rnc && p.tipoProveedor ? ' · ' : ''}${p.tipoProveedor ? esc(p.tipoProveedor) : ''}
          ${!p.rnc && !p.tipoProveedor ? (p.empresa ? esc(p.empresa) : p.telefono ? esc(p.telefono) : 'Sin datos adicionales') : ''}
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:.78rem;color:var(--text3)">${s.totalFacturas} factura(s) · ${s.pendientes} pendiente(s)</div>
          <div style="font-size:.82rem;font-weight:700;color:${s.vencidas>0?'#f87171':s.pendientes>0?'#fbbf24':'#6ee7b7'}">${fmtS(s.totalPendiente)}</div>
        </div>
      </div>`;
  }).join('');
}

// ── Detalle del proveedor (panel derecho) ────────────────────────────────────
async function openProveedorDetail(id) {
  _activeProveedorId = id;
  renderProveedoresList(); // Re-render list to highlight active

  const panel = document.getElementById('prov-detail-panel');
  if (!panel) return;
  panel.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text3)"><div style="text-align:center"><div style="font-size:2rem;margin-bottom:8px">⏳</div><div>Cargando perfil…</div></div></div>`;

  try {
    const token = (typeof getStoredAuthToken==='function' ? getStoredAuthToken() : '') || DB?.authToken || '';
    const res = await fetch(`/api/suppliers/${id}/detail`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _renderProveedorDetailContent(panel, data);
  } catch(e) {
    panel.innerHTML = `<div style="padding:2rem;color:var(--text3)">Error al cargar el perfil: ${esc(e.message)}</div>`;
  }
}

function _renderProveedorDetailContent(panel, { proveedor: p, indicadores: ind, facturas, pagos, alertas }) {
  const tabs = [
    { id:'resumen',    label:'📊 Resumen' },
    { id:'facturas',   label:'📄 Facturas' },
    { id:'pagos',      label:'💵 Pagos' },
    { id:'alertas',    label:`🔔 Alertas${alertas.length?' ('+alertas.length+')':''}` },
  ];

  panel.innerHTML = `
    <!-- Header del proveedor -->
    <div style="padding:14px 16px;border-bottom:1px solid var(--border,#374151);display:flex;align-items:center;gap:12px;flex-shrink:0">
      <div style="width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,#065f46,#22c55e);display:flex;align-items:center;justify-content:center;font-size:1.2rem;flex-shrink:0;font-weight:700;color:#fff">
        ${esc(p.nombre.charAt(0).toUpperCase())}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:1rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.nombre)}</div>
        <div style="font-size:.76rem;color:var(--text3)">${p.rnc?'RNC: '+esc(p.rnc):''}${p.rnc&&p.tipoProveedor?' · ':''}${esc(p.tipoProveedor||p.empresa||'')}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button onclick="openProveedorModal(${p.id})" style="padding:5px 10px;background:rgba(255,255,255,.07);border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:.78rem;color:var(--text)">✏ Editar</button>
        <button onclick="openSupplierInvoiceModal(${p.id})" style="padding:5px 10px;background:rgba(34,197,94,.12);border:1px solid #22c55e;border-radius:6px;cursor:pointer;font-size:.78rem;color:#22c55e">+ Factura</button>
      </div>
    </div>

    <!-- Tabs -->
    <div style="display:flex;border-bottom:1px solid var(--border,#374151);flex-shrink:0;overflow-x:auto">
      ${tabs.map(t=>`
        <button id="prov-tab-btn-${t.id}" onclick="switchProveedorTab('${t.id}')"
          style="padding:9px 14px;background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;font-size:.8rem;color:var(--text3);white-space:nowrap;transition:color .15s">
          ${t.label}
        </button>`).join('')}
    </div>

    <!-- Tab content -->
    <div id="prov-tab-content" style="flex:1;overflow-y:auto;padding:16px">
      ${_renderResumenTab(p, ind)}
    </div>`;

  // Store data on panel for tab switching
  panel._provData = { p, ind, facturas, pagos, alertas };
  // Activate first tab
  const firstBtn = document.getElementById('prov-tab-btn-resumen');
  if (firstBtn) { firstBtn.style.borderBottomColor = 'var(--green,#22c55e)'; firstBtn.style.color = 'var(--green,#22c55e)'; }
}

function switchProveedorTab(tabId) {
  const panel = document.getElementById('prov-detail-panel');
  if (!panel?._provData) return;
  const { p, ind, facturas, pagos, alertas } = panel._provData;

  // Update tab buttons
  ['resumen','facturas','pagos','alertas'].forEach(id => {
    const btn = document.getElementById(`prov-tab-btn-${id}`);
    if (!btn) return;
    btn.style.borderBottomColor = id===tabId ? 'var(--green,#22c55e)' : 'transparent';
    btn.style.color = id===tabId ? 'var(--green,#22c55e)' : 'var(--text3)';
  });

  const content = document.getElementById('prov-tab-content');
  if (!content) return;
  if (tabId === 'resumen')  content.innerHTML = _renderResumenTab(p, ind);
  if (tabId === 'facturas') content.innerHTML = _renderFacturasTab(p, facturas);
  if (tabId === 'pagos')    content.innerHTML = _renderPagosTab(pagos);
  if (tabId === 'alertas')  content.innerHTML = _renderAlertasTab(alertas, p, ind);
}

// ── Tab: Resumen ──────────────────────────────────────────────────────────────
function _renderResumenTab(p, ind) {
  const kpis = [
    { label:'Total Comprado',   val: fmtS(ind.totalComprado),   color:'#6ee7b7' },
    { label:'Compras este mes', val: fmtS(ind.comprasMes),      color:'#93c5fd' },
    { label:'Compras este año', val: fmtS(ind.comprasAnio),     color:'#c4b5fd' },
    { label:'Por Pagar',        val: fmtS(ind.montoPendiente),  color: ind.montoPendiente>0?'#fbbf24':'#6ee7b7' },
    { label:'Vencido',          val: fmtS(ind.montoVencido),    color: ind.montoVencido>0?'#f87171':'#6ee7b7' },
    { label:'ITBIS Acreditable',val: fmtS(ind.totalITBIS),      color:'#fdba74' },
    { label:'Facturas',         val: ind.totalFacturas,         color:'#e5e7eb' },
    { label:'Pendientes',       val: ind.facturasPendientesCount, color: ind.facturasPendientesCount>0?'#fbbf24':'#6ee7b7' },
    { label:'Vencidas',         val: ind.facturasVencidasCount,   color: ind.facturasVencidasCount>0?'#f87171':'#6ee7b7' },
    { label:'Última Factura',   val: fmtDate(ind.ultimaFactura), color:'#e5e7eb' },
    { label:'Próx. visita',     val: getNextVisitDayLabel(p),   color:'#e5e7eb' },
    { label:'Términos pago',    val: `${p.terminosPagoDias} días`, color:'#e5e7eb' },
  ];

  const info = [
    { label:'Razón social',    val: p.razonSocial    || p.nombre },
    { label:'Nombre comercial',val: p.nombreComercial || p.empresa || '—' },
    { label:'RNC',             val: p.rnc || '—' },
    { label:'Tipo',            val: p.tipoProveedor  || '—' },
    { label:'Teléfono',        val: p.telefono       || '—' },
    { label:'Teléfono 2',      val: p.telefono2      || '—' },
    { label:'Email',           val: p.email          || '—' },
    { label:'Email 2',         val: p.email2         || '—' },
    { label:'Contacto',        val: p.contacto       || '—' },
    { label:'Web',             val: p.web            || '—' },
    { label:'Dirección',       val: p.direccion      || '—' },
    { label:'Ciudad',          val: p.ciudad         || '—' },
    { label:'Provincia',       val: p.provincia      || '—' },
    { label:'País',            val: p.pais           || 'República Dominicana' },
    { label:'Límite crédito',  val: p.limiteCredito ? fmtS(p.limiteCredito) : 'Sin límite' },
    { label:'Días de visita',  val: getVisitDaysArray(p.diasVisita).join(', ') || '—' },
  ];

  return `
    <!-- KPIs grid -->
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-bottom:16px">
      ${kpis.map(k=>`
        <div style="background:var(--bg,#111827);border:1px solid var(--border);border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:1.1rem;font-weight:700;color:${k.color}">${k.val}</div>
          <div style="font-size:.7rem;color:var(--text3);margin-top:2px">${k.label}</div>
        </div>`).join('')}
    </div>

    <!-- Información de contacto -->
    <div style="background:var(--bg,#111827);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:12px">
      <div style="font-weight:600;font-size:.85rem;margin-bottom:10px;color:var(--text2)">Información del Proveedor</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        ${info.map(r=>`
          <div style="display:flex;flex-direction:column;gap:1px">
            <span style="font-size:.68rem;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">${r.label}</span>
            <span style="font-size:.82rem;color:var(--text)">${esc(r.val)}</span>
          </div>`).join('')}
      </div>
    </div>

    ${p.observaciones ? `
    <div style="background:var(--bg,#111827);border:1px solid var(--border);border-radius:8px;padding:12px">
      <div style="font-weight:600;font-size:.82rem;margin-bottom:6px;color:var(--text2)">Observaciones</div>
      <div style="font-size:.83rem;color:var(--text3);line-height:1.5">${esc(p.observaciones)}</div>
    </div>` : ''}`;
}

// ── Tab: Facturas ─────────────────────────────────────────────────────────────
function _renderFacturasTab(p, facturas) {
  if (!facturas.length) return `<div style="text-align:center;padding:2rem;color:var(--text3)">Sin facturas registradas</div>`;

  return `
    <div style="overflow-x:auto">
      <table class="data-table" style="width:100%;font-size:.8rem">
        <thead>
          <tr>
            <th>No. Factura</th><th>NCF</th><th>Emisión</th><th>Vencimiento</th>
            <th style="text-align:right">Total</th><th style="text-align:right">ITBIS</th>
            <th style="text-align:right">Pendiente</th><th>Estado</th><th>Acción</th>
          </tr>
        </thead>
        <tbody>
          ${facturas.map(f => `
            <tr>
              <td style="font-weight:600">${esc(f.numeroFactura)}</td>
              <td style="font-size:.72rem;color:var(--text3)">${esc(f.ncf||'—')}</td>
              <td>${fmtDate(f.fechaEmision)}</td>
              <td>${fmtDate(f.fechaVencimiento)}</td>
              <td style="text-align:right">${fmtS(f.montoTotal)}</td>
              <td style="text-align:right;color:#fdba74">${fmtS(f.itbisAmount)}</td>
              <td style="text-align:right;font-weight:700;color:${f.montoPendiente>0?'#fbbf24':'#6ee7b7'}">${fmtS(f.montoPendiente)}</td>
              <td>${getSupplierInvoiceStatusBadge(f.estado)}</td>
              <td>${f.montoPendiente>0
                ? `<button class="btn-edit" onclick="openSupplierPaymentModal(${f.id})">💵 Abonar</button>`
                : '✅'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div style="margin-top:12px;text-align:right">
      <button onclick="openSupplierInvoiceModal(${p.id})" class="btn-primary" style="font-size:.8rem">+ Registrar Factura</button>
    </div>`;
}

// ── Tab: Pagos ────────────────────────────────────────────────────────────────
function _renderPagosTab(pagos) {
  if (!pagos.length) return `<div style="text-align:center;padding:2rem;color:var(--text3)">Sin pagos registrados aún</div>`;

  return `
    <div style="overflow-x:auto">
      <table class="data-table" style="width:100%;font-size:.8rem">
        <thead>
          <tr><th>Fecha</th><th>Monto</th><th>Método</th><th>Notas</th><th>Registrado por</th></tr>
        </thead>
        <tbody>
          ${pagos.map(p=>`
            <tr>
              <td>${fmtDate(p.fecha_pago)}</td>
              <td style="font-weight:700;color:#6ee7b7">${fmtS(p.monto)}</td>
              <td>${esc(p.metodo_pago||'Efectivo')}</td>
              <td style="color:var(--text3)">${esc(p.notas||'—')}</td>
              <td style="color:var(--text3)">${esc(p.created_by||'—')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ── Tab: Alertas ──────────────────────────────────────────────────────────────
function _renderAlertasTab(alertas, p, ind) {
  if (!alertas.length) return `
    <div style="text-align:center;padding:2rem;color:var(--text3)">
      <div style="font-size:2rem;margin-bottom:8px">✅</div>
      <div>Sin alertas para este proveedor</div>
    </div>`;

  const colors = { danger: '#fca5a5', warning: '#fde68a', info: '#93c5fd' };
  const bg     = { danger: 'rgba(239,68,68,.1)', warning: 'rgba(245,158,11,.1)', info: 'rgba(59,130,246,.1)' };

  return alertas.map(a=>`
    <div style="padding:12px 14px;border:1px solid ${colors[a.tipo]||colors.info};border-radius:8px;background:${bg[a.tipo]||bg.info};margin-bottom:8px;display:flex;align-items:center;gap:10px">
      <span style="font-size:1.1rem">${a.tipo==='danger'?'🔴':a.tipo==='warning'?'🟡':'ℹ️'}</span>
      <span style="font-size:.85rem;color:var(--text)">${esc(a.mensaje)}</span>
    </div>`).join('');
}

// ── Modal: Crear / Editar proveedor ──────────────────────────────────────────
function buildVisitDaysChecklist(selected) {
  const sel = new Set(getVisitDaysArray(selected));
  return `
    <div class="span-full">
      <label style="display:block;margin-bottom:.4rem;color:var(--text2);font-size:.85rem;font-weight:500">Días de visita del vendedor</label>
      <div style="display:flex;flex-wrap:wrap;gap:.4rem">
        ${WEEK_DAYS.map(d=>`
          <label class="badge badge-info" style="cursor:pointer;padding:.35rem .6rem">
            <input type="checkbox" class="prov-dia" value="${d}" ${sel.has(d)?'checked':''} style="margin-right:5px">
            ${supplierText(d)}
          </label>`).join('')}
      </div>
    </div>`;
}
function getSelectedVisitDays() {
  return Array.from(document.querySelectorAll('.prov-dia:checked')).map(e=>e.value).join(',');
}

function openProveedorModal(id) {
  const p = id ? (DB.proveedores||[]).find(x=>x.id===id) : null;
  document.getElementById('modal-title').textContent = p ? 'Editar Proveedor' : 'Nuevo Proveedor';
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-grid">
      <!-- Sección: Datos básicos -->
      <div class="span-full" style="margin-bottom:.25rem;padding-bottom:.5rem;border-bottom:1px solid var(--border);font-size:.8rem;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Identificación</div>

      <div class="form-group span-full"><label>Nombre del Proveedor *</label><input type="text" id="prov-nombre" class="form-input" value="${esc(p?.nombre||'')}" placeholder="Nombre principal del proveedor"></div>
      <div class="form-group"><label>Razón Social</label><input type="text" id="prov-razon-social" class="form-input" value="${esc(p?.razonSocial||'')}" placeholder="Nombre legal registrado"></div>
      <div class="form-group"><label>Nombre Comercial</label><input type="text" id="prov-nombre-comercial" class="form-input" value="${esc(p?.nombreComercial||'')}" placeholder="Nombre con que se conoce"></div>
      <div class="form-group"><label>RNC</label><input type="text" id="prov-rnc" class="form-input" value="${esc(p?.rnc||'')}" placeholder="000-00000-0"></div>
      <div class="form-group"><label>Tipo de Proveedor</label>
        <select id="prov-tipo" class="form-input">
          <option value="">-- Seleccionar --</option>
          ${TIPOS_PROVEEDOR.map(t=>`<option value="${t}" ${p?.tipoProveedor===t?'selected':''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>Empresa</label><input type="text" id="prov-empresa" class="form-input" value="${esc(p?.empresa||'')}" placeholder="Nombre de la empresa"></div>
      <div class="form-group"><label>Contacto principal</label><input type="text" id="prov-contacto" class="form-input" value="${esc(p?.contacto||'')}" placeholder="Persona de contacto"></div>

      <!-- Sección: Comunicación -->
      <div class="span-full" style="margin:8px 0 .25rem;padding-bottom:.5rem;border-bottom:1px solid var(--border);font-size:.8rem;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Comunicación</div>

      <div class="form-group"><label>Teléfono principal</label><input type="text" id="prov-telefono" class="form-input" value="${esc(p?.telefono||'')}" placeholder="809-000-0000"></div>
      <div class="form-group"><label>Teléfono 2 / WhatsApp</label><input type="text" id="prov-telefono2" class="form-input" value="${esc(p?.telefono2||'')}" placeholder="829-000-0000"></div>
      <div class="form-group"><label>Email principal</label><input type="email" id="prov-email" class="form-input" value="${esc(p?.email||'')}" placeholder="ventas@empresa.com"></div>
      <div class="form-group"><label>Email 2</label><input type="email" id="prov-email2" class="form-input" value="${esc(p?.email2||'')}" placeholder="contacto@empresa.com"></div>
      <div class="form-group span-full"><label>Página Web</label><input type="text" id="prov-web" class="form-input" value="${esc(p?.web||'')}" placeholder="https://empresa.com"></div>

      <!-- Sección: Ubicación -->
      <div class="span-full" style="margin:8px 0 .25rem;padding-bottom:.5rem;border-bottom:1px solid var(--border);font-size:.8rem;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Ubicación</div>

      <div class="form-group span-full"><label>Dirección</label><input type="text" id="prov-direccion" class="form-input" value="${esc(p?.direccion||'')}" placeholder="Calle, No., sector"></div>
      <div class="form-group"><label>Ciudad</label><input type="text" id="prov-ciudad" class="form-input" value="${esc(p?.ciudad||'')}" placeholder="Santo Domingo"></div>
      <div class="form-group"><label>Provincia</label><input type="text" id="prov-provincia" class="form-input" value="${esc(p?.provincia||'')}" placeholder="Distrito Nacional"></div>
      <div class="form-group"><label>País</label><input type="text" id="prov-pais" class="form-input" value="${esc(p?.pais||'República Dominicana')}" placeholder="República Dominicana"></div>

      <!-- Sección: Condiciones -->
      <div class="span-full" style="margin:8px 0 .25rem;padding-bottom:.5rem;border-bottom:1px solid var(--border);font-size:.8rem;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Condiciones Comerciales</div>

      <div class="form-group"><label>Términos de pago (días)</label><input type="number" id="prov-terminos" class="form-input" value="${p?.terminosPagoDias||30}" min="0"></div>
      <div class="form-group"><label>Límite de crédito (RD$)</label><input type="number" id="prov-limite" class="form-input" value="${p?.limiteCredito||''}" min="0" step="0.01" placeholder="Sin límite si vacío"></div>
      <div class="form-group"><label>Estado</label>
        <select id="prov-estado" class="form-input">
          <option value="Activo" ${p?.estado!=='Inactivo'?'selected':''}>Activo</option>
          <option value="Inactivo" ${p?.estado==='Inactivo'?'selected':''}>Inactivo</option>
        </select>
      </div>

      ${buildVisitDaysChecklist(p?.diasVisita||'')}

      <div class="form-group span-full"><label>Observaciones</label><textarea id="prov-observaciones" class="form-input" rows="2" placeholder="Notas internas sobre este proveedor…">${esc(p?.observaciones||'')}</textarea></div>
    </div>`;

  document.getElementById('modal-footer').innerHTML = `
    <div style="display:flex;justify-content:space-between;width:100%;gap:.5rem;align-items:center">
      <div>
        ${p ? `<button class="btn-secondary" onclick="deleteProveedor(${p.id})" style="color:#f87171;border-color:rgba(248,113,113,.3)">🗑 Eliminar</button>` : ''}
      </div>
      <div style="display:flex;gap:.5rem">
        <button class="btn-secondary" onclick="closeAllModals()">Cancelar</button>
        <button class="btn-primary" onclick="saveProveedor(${id||'null'})">💾 Guardar</button>
      </div>
    </div>`;

  document.getElementById('modal-overlay').classList.remove('hidden');
  if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('modal-overlay'));
  if (window.RNCLookup) {
    const rncEl = document.getElementById('prov-rnc');
    if (rncEl && !rncEl.dataset.rncAttached) {
      rncEl.dataset.rncAttached = '1';
      RNCLookup.attach(rncEl, { nameEl: document.getElementById('prov-nombre'), mode: 'both' });
    }
  }
}

async function saveProveedor(id) {
  const nombre = document.getElementById('prov-nombre').value.trim();
  if (!nombre) { showToast('El nombre es obligatorio', 'error'); return; }

  const data = {
    nombre,
    razonSocial:     document.getElementById('prov-razon-social')?.value.trim()||'',
    nombreComercial: document.getElementById('prov-nombre-comercial')?.value.trim()||'',
    empresa:         document.getElementById('prov-empresa')?.value.trim()||'',
    contacto:        document.getElementById('prov-contacto')?.value.trim()||'',
    telefono:        document.getElementById('prov-telefono')?.value.trim()||'',
    telefono2:       document.getElementById('prov-telefono2')?.value.trim()||'',
    email:           document.getElementById('prov-email')?.value.trim()||'',
    email2:          document.getElementById('prov-email2')?.value.trim()||'',
    rnc:             document.getElementById('prov-rnc')?.value.trim()||'',
    web:             document.getElementById('prov-web')?.value.trim()||'',
    direccion:       document.getElementById('prov-direccion')?.value.trim()||'',
    ciudad:          document.getElementById('prov-ciudad')?.value.trim()||'',
    provincia:       document.getElementById('prov-provincia')?.value.trim()||'',
    pais:            document.getElementById('prov-pais')?.value.trim()||'República Dominicana',
    diasVisita:      getSelectedVisitDays(),
    terminosPagoDias: parseInt(document.getElementById('prov-terminos')?.value,10)||30,
    tipoProveedor:   document.getElementById('prov-tipo')?.value||'',
    limiteCredito:   parseFloat(document.getElementById('prov-limite')?.value)||null,
    observaciones:   document.getElementById('prov-observaciones')?.value.trim()||'',
    estado:          document.getElementById('prov-estado')?.value||'Activo',
  };

  try {
    if (id) {
      const updated = await api.updateSupplier(id, { ...data, ...getActorPayload() });
      const idx = DB.proveedores.findIndex(x=>x.id===id);
      if (idx>=0) DB.proveedores[idx] = updated;
      showToast('Proveedor actualizado', 'success');
    } else {
      const created = await api.createSupplier({ ...data, ...getActorPayload() });
      DB.proveedores.push(created);
      showToast('Proveedor creado', 'success');
    }
  } catch(e) { showToast(e.message, 'error'); return; }

  closeAllModals();
  renderProveedoresList();
  if (id) openProveedorDetail(id);
  if (typeof refreshAuditLogs === 'function') refreshAuditLogs().catch(()=>{});
}

// ── Modal: Nueva Factura de Proveedor ────────────────────────────────────────
function openSupplierInvoiceModal(supplierId = null) {
  const suppliers = (DB.proveedores||[]).filter(p=>p.estado==='Activo');
  const selId     = supplierId || suppliers[0]?.id || '';
  const supplier  = (DB.proveedores||[]).find(p=>p.id===selId);
  const today     = new Date().toISOString().slice(0,10);
  const dueDate   = new Date();
  dueDate.setDate(dueDate.getDate() + Number(supplier?.terminosPagoDias||30));

  document.getElementById('modal-title').textContent = 'Registrar Factura de Proveedor';
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-grid">
      <div class="form-group"><label>Proveedor *</label>
        <select id="spi-supplier" class="form-input" onchange="syncSupplierInvoiceDueDate()">
          ${suppliers.map(p=>`<option value="${p.id}" ${Number(selId)===p.id?'selected':''}>${esc(p.nombre)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>No. Factura *</label><input type="text" id="spi-number" class="form-input" placeholder="FAC-000123"></div>
      <div class="form-group"><label>NCF</label><input type="text" id="spi-ncf" class="form-input" placeholder="B01-00000000"></div>
      <div class="form-group"><label>Tipo NCF</label>
        <select id="spi-tipo-ncf" class="form-input">
          <option value="">-- Tipo --</option>
          ${TIPOS_NCF.map(t=>`<option value="${t}">${t}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>Fecha emisión *</label><input type="date" id="spi-issued" class="form-input" value="${today}" onchange="syncSupplierInvoiceDueDate()"></div>
      <div class="form-group"><label>Fecha vencimiento</label><input type="date" id="spi-due" class="form-input" value="${dueDate.toISOString().slice(0,10)}"></div>
      <div class="form-group"><label>Monto total *</label><input type="number" id="spi-total" class="form-input" min="0" step="0.01" value="0" oninput="calcITBIS()"></div>
      <div class="form-group"><label>ITBIS (18%)</label><input type="number" id="spi-itbis" class="form-input" min="0" step="0.01" value="0" placeholder="Se calcula automático"></div>
      <div class="form-group"><label>Monto abonado</label><input type="number" id="spi-paid" class="form-input" min="0" step="0.01" value="0"></div>
      <div class="form-group"><label>Método de pago inicial</label>
        <select id="spi-metodo" class="form-input">
          ${METODOS_PAGO.map(m=>`<option>${m}</option>`).join('')}
        </select>
      </div>
      <div class="form-group span-full"><label>Notas</label><input type="text" id="spi-notes" class="form-input" placeholder="Observaciones de la factura"></div>
    </div>`;

  document.getElementById('modal-footer').innerHTML = `
    <button class="btn-secondary" onclick="closeAllModals()">Cancelar</button>
    <button class="btn-primary" onclick="saveSupplierInvoice()">💾 Guardar Factura</button>`;

  document.getElementById('modal-overlay').classList.remove('hidden');
  if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('modal-overlay'));
}

window.calcITBIS = function() {
  const total = parseFloat(document.getElementById('spi-total')?.value) || 0;
  const itbisEl = document.getElementById('spi-itbis');
  if (itbisEl && !itbisEl._manuallySet) itbisEl.value = (total * 0.18 / 1.18).toFixed(2);
};

function syncSupplierInvoiceDueDate() {
  const sid      = Number(document.getElementById('spi-supplier')?.value||0);
  const supplier = (DB.proveedores||[]).find(p=>p.id===sid);
  const issued   = document.getElementById('spi-issued')?.value;
  const dueInput = document.getElementById('spi-due');
  if (!supplier || !issued || !dueInput) return;
  const d = new Date(issued);
  d.setDate(d.getDate() + Number(supplier.terminosPagoDias||30));
  dueInput.value = d.toISOString().slice(0,10);
}

async function saveSupplierInvoice() {
  const supplierId    = Number(document.getElementById('spi-supplier').value||0);
  const numeroFactura = document.getElementById('spi-number').value.trim();
  const fechaEmision  = document.getElementById('spi-issued').value;
  const montoTotal    = parseFloat(document.getElementById('spi-total').value)||0;
  const montoPagado   = parseFloat(document.getElementById('spi-paid').value)||0;
  if (!supplierId||!numeroFactura||!fechaEmision||montoTotal<=0) {
    showToast('Completa proveedor, factura, fecha y monto total', 'error'); return;
  }
  if (montoPagado>montoTotal) { showToast('El abono no puede ser mayor al total', 'error'); return; }
  try {
    const created = await api.createSupplierInvoice({
      supplierId, numeroFactura,
      fechaEmision,
      fechaVencimiento: document.getElementById('spi-due').value,
      montoTotal, montoPagado,
      itbisAmount: parseFloat(document.getElementById('spi-itbis').value)||0,
      ncf:         document.getElementById('spi-ncf')?.value.trim()||'',
      tipoNcf:     document.getElementById('spi-tipo-ncf')?.value||'',
      metodoPago:  document.getElementById('spi-metodo')?.value||'Efectivo',
      notas:       document.getElementById('spi-notes').value.trim(),
      ...getActorPayload()
    });
    DB.facturasProveedores.unshift(created);
    closeAllModals();
    renderProveedoresList();
    if (_activeProveedorId === supplierId) openProveedorDetail(supplierId);
    if (typeof refreshAuditLogs === 'function') refreshAuditLogs().catch(()=>{});
    showToast('Factura registrada correctamente', 'success');
  } catch(e) { showToast(e.message, 'error'); }
}

// ── Modal: Pago ───────────────────────────────────────────────────────────────
function openSupplierPaymentModal(invoiceId) {
  const inv = (DB.facturasProveedores||[]).find(i=>i.id===invoiceId);
  if (!inv) return;
  document.getElementById('modal-title').textContent = 'Registrar Abono';
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-grid">
      <div class="form-group"><label>Proveedor</label><input class="form-input" value="${esc(inv.proveedor)}" disabled></div>
      <div class="form-group"><label>Factura</label><input class="form-input" value="${esc(inv.numeroFactura)}" disabled></div>
      <div class="form-group"><label>Total factura</label><input class="form-input" value="${fmtS(inv.montoTotal)}" disabled></div>
      <div class="form-group"><label>Pendiente actual</label><input class="form-input" value="${fmtS(inv.montoPendiente)}" disabled></div>
      <div class="form-group span-full"><label>Monto a abonar *</label><input type="number" id="spi-payment-amount" class="form-input" min="0.01" max="${inv.montoPendiente}" step="0.01" value="${inv.montoPendiente}"></div>
      <div class="form-group"><label>Método de pago</label>
        <select id="spi-payment-metodo" class="form-input">
          ${METODOS_PAGO.map(m=>`<option>${m}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>Notas</label><input type="text" id="spi-payment-notas" class="form-input" placeholder="Referencia, cheque No., etc."></div>
    </div>`;
  document.getElementById('modal-footer').innerHTML = `
    <button class="btn-secondary" onclick="closeAllModals()">Cancelar</button>
    <button class="btn-primary" onclick="saveSupplierPayment(${invoiceId})">💵 Aplicar Abono</button>`;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

async function saveSupplierPayment(invoiceId) {
  const amount = parseFloat(document.getElementById('spi-payment-amount').value)||0;
  if (amount<=0) { showToast('El monto debe ser mayor que cero', 'error'); return; }
  try {
    const inv = (DB.facturasProveedores||[]).find(i=>i.id===invoiceId);
    const updated = await api.paySupplierInvoice(invoiceId, {
      monto:      amount,
      metodoPago: document.getElementById('spi-payment-metodo')?.value||'Efectivo',
      notas:      document.getElementById('spi-payment-notas')?.value.trim()||'',
      ...getActorPayload()
    });
    const idx = DB.facturasProveedores.findIndex(i=>i.id===invoiceId);
    if (idx>=0) DB.facturasProveedores[idx] = updated;
    closeAllModals();
    renderProveedoresList();
    if (_activeProveedorId === inv?.supplierId) openProveedorDetail(inv.supplierId);
    if (typeof refreshAuditLogs === 'function') refreshAuditLogs().catch(()=>{});
    showToast('Abono aplicado correctamente', 'success');
  } catch(e) { showToast(e.message, 'error'); }
}

// ── Eliminar proveedor ────────────────────────────────────────────────────────
async function deleteProveedor(id) {
  const s = getSupplierPendingSummary(id);
  if (s.totalPendiente > 0) {
    showToast('No puedes eliminar un proveedor con facturas pendientes', 'warning'); return;
  }
  if (!await showDeleteConfirm('¿Eliminar este proveedor? Esta acción no se puede deshacer.')) return;
  try {
    await api.request(`/api/suppliers/${id}`, { method:'DELETE', body: JSON.stringify(getActorPayload()) });
    closeAllModals();
    DB.proveedores = (DB.proveedores||[]).filter(p=>Number(p.id)!==Number(id));
    DB.facturasProveedores = (DB.facturasProveedores||[]).filter(i=>Number(i.supplierId)!==Number(id));
    _activeProveedorId = null;
    const detailPanel = document.getElementById('prov-detail-panel');
    if (detailPanel) detailPanel.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:.75rem;color:var(--text3)"><div style="font-size:3rem">🚚</div><div style="font-size:.9rem">Selecciona un proveedor para ver su perfil completo</div></div>`;
    renderProveedoresList();
    if (typeof refreshAuditLogs === 'function') refreshAuditLogs().catch(()=>{});
    showToast('Proveedor eliminado', 'success');
  } catch(e) { showToast(e.message, 'error'); }
}

// ── Punto de entrada del módulo ───────────────────────────────────────────────
function loadProveedoresTable() {
  renderProveedoresList();
}

function initProveedoresModule() {
  renderProveedoresList();
}
