/* ============================================================
   Tecno Caja — Reportes Avanzados v2.0
   ============================================================ */

(function () {
  'use strict';

  // ── Estado global del módulo ─────────────────────────────
  const RV2 = {
    tab: 'dashboard',
    subtab: 'facturas',
    filtros: { desde: '', hasta: '', sucursalId: '', cajaId: '', usuarioId: '' },
    // caché de datos cargados
    kpis: null,
    ventas_dia: [],
    metodos: [],
    productos: [],
    clientes: [],
    por_sucursal: [],
    facturas: { rows: [], total: 0, page: 1, pages: 1 },
    por_caja: [],
    por_usuario: [],
    devoluciones: { rows: [], total: 0, totalCancelado: 0 },
    dgii: null,
    // charts canvas contexts
    _chartTendencia: null,
    _chartMetodos: null,
  };

  // ── Utilidades ───────────────────────────────────────────
  function fmt(v) {
    const num = Number(v) || 0;
    const cur = (typeof DB !== 'undefined' && DB.config?.currency) || 'RD$';
    return `${cur} ${num.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  function fmtNum(v) { return Number(v || 0).toLocaleString('es-DO'); }
  function el(id) { return document.getElementById(id); }
  function setText(id, val) { const e = el(id); if (e) e.textContent = val; }

  function getAuthHeaders() {
    let tok = '';
    if (typeof getTecnoCajaAuthToken === 'function') tok = getTecnoCajaAuthToken();
    else if (typeof DB !== 'undefined' && DB.authToken) tok = DB.authToken;
    if (tok) return { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' };
    return { 'Content-Type': 'application/json' };
  }

  async function apiGet(path) {
    const r = await fetch(path, { headers: getAuthHeaders() });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }

  function buildQS(extra = {}) {
    const f = RV2.filtros;
    const p = new URLSearchParams();
    if (f.desde)      p.set('desde', f.desde);
    if (f.hasta)      p.set('hasta', f.hasta);
    if (f.sucursalId) p.set('branchId', f.sucursalId);
    if (f.cajaId)     p.set('cajaId', f.cajaId);
    if (f.usuarioId)  p.set('userId', f.usuarioId);
    Object.entries(extra).forEach(([k, v]) => { if (v !== '' && v != null) p.set(k, v); });
    return p.toString() ? '?' + p.toString() : '';
  }

  // ── Calcular rango de fechas según período ────────────────
  function calcFiltros() {
    const periodo = el('repv2-periodo')?.value || 'mes';
    const now = new Date();
    let desde, hasta;

    if (periodo === 'custom') {
      desde = el('repv2-desde')?.value || '';
      hasta = el('repv2-hasta')?.value || '';
    } else {
      hasta = now.toISOString().split('T')[0];
      if (periodo === 'hoy') {
        desde = hasta;
      } else if (periodo === 'semana') {
        const d = new Date(now);
        d.setDate(d.getDate() - 6);
        desde = d.toISOString().split('T')[0];
      } else if (periodo === 'mes') {
        desde = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
      } else if (periodo === 'año') {
        desde = `${now.getFullYear()}-01-01`;
      }
    }

    RV2.filtros.desde      = desde || '';
    RV2.filtros.hasta      = hasta || '';
    RV2.filtros.sucursalId = el('repv2-sucursal')?.value || '';
    RV2.filtros.cajaId     = el('repv2-caja')?.value || '';
    RV2.filtros.usuarioId  = el('repv2-usuario')?.value || '';
  }

  // ── Tab switching ────────────────────────────────────────
  window.repV2SwitchTab = function (tab) {
    RV2.tab = tab;
    document.querySelectorAll('.repv2-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.repv2-pane').forEach(p => {
      const isActive = p.id === `repv2-tab-${tab}`;
      p.classList.toggle('active', isActive);
      p.classList.toggle('hidden', !isActive);
    });
    // Lazy-load tab data
    if (tab === 'dgii' && !RV2.dgii) loadDGII();
    if (tab === 'detallados') repV2SwitchSubtab(RV2.subtab);
  };

  window.repV2SwitchSubtab = function (subtab) {
    RV2.subtab = subtab;
    document.querySelectorAll('.repv2-subtab').forEach(b => b.classList.toggle('active', b.dataset.subtab === subtab));
    document.querySelectorAll('.repv2-subpane').forEach(p => {
      const isActive = p.id === `repv2-subtab-${subtab}`;
      p.classList.toggle('active', isActive);
      p.classList.toggle('hidden', !isActive);
    });
    // lazy load
    if (subtab === 'facturas'    && !RV2.facturas.rows.length)    repV2LoadFacturas(1);
    if (subtab === 'productos'   && !RV2.productos.length)        loadProductosDetallado();
    if (subtab === 'sucursal'    && !RV2.por_sucursal.length)     loadPorSucursalDetallado();
    if (subtab === 'caja'        && !RV2.por_caja.length)         loadPorCaja();
    if (subtab === 'usuario'     && !RV2.por_usuario.length)      loadPorUsuario();
    if (subtab === 'metodos'     )                                 renderMetodosTable();
    if (subtab === 'devoluciones'&& !RV2.devoluciones.rows.length) loadDevoluciones();
  };

  window.repV2OnPeriodoChange = function () {
    const p = el('repv2-periodo')?.value;
    const cr = el('repv2-custom-range');
    if (cr) cr.classList.toggle('hidden', p !== 'custom');
  };

  window.repV2OnSucursalChange = function () {
    // Filtrar cajas según sucursal
    const branchId = el('repv2-sucursal')?.value;
    const cajaSelect = el('repv2-caja');
    if (!cajaSelect || !window._repv2Filtros) return;
    cajaSelect.innerHTML = '<option value="">Todas las cajas</option>';
    window._repv2Filtros.cajas
      .filter(c => !branchId || String(c.branch_id) === String(branchId))
      .forEach(c => {
        const o = document.createElement('option');
        o.value = c.id; o.textContent = c.nombre;
        cajaSelect.appendChild(o);
      });
  };

  // ── Load all (al presionar Aplicar) ─────────────────────
  window.repV2LoadAll = async function () {
    calcFiltros();
    setLoadingState(true);
    // Reset cache
    RV2.kpis = null;
    RV2.ventas_dia = [];
    RV2.metodos = [];
    RV2.productos = [];
    RV2.clientes = [];
    RV2.por_sucursal = [];
    RV2.facturas = { rows: [], total: 0, page: 1, pages: 1 };
    RV2.por_caja = [];
    RV2.por_usuario = [];
    RV2.devoluciones = { rows: [], total: 0, totalCancelado: 0 };
    RV2.dgii = null;

    await Promise.all([loadKPIs(), loadVentasDia(), loadMetodos(), loadProductos(), loadClientes(), loadPorSucursal()]);
    setLoadingState(false);
    renderDashboard();

    if (RV2.tab === 'detallados') repV2SwitchSubtab(RV2.subtab);
    if (RV2.tab === 'dgii') loadDGII();
  };

  // ── Init del módulo ──────────────────────────────────────
  async function initRepV2() {
    calcFiltros();
    await loadFiltros();
    await Promise.all([loadKPIs(), loadVentasDia(), loadMetodos(), loadProductos(), loadClientes(), loadPorSucursal()]);
    renderDashboard();
  }

  // ── Cargar filtros (sucursales/cajas/usuarios) ────────────
  async function loadFiltros() {
    try {
      const data = await apiGet('/api/reports/advanced/filtros');
      window._repv2Filtros = data;
      const sSelect = el('repv2-sucursal');
      const cSelect = el('repv2-caja');
      const uSelect = el('repv2-usuario');
      if (sSelect) {
        sSelect.innerHTML = '<option value="">Todas las sucursales</option>';
        data.sucursales.forEach(s => {
          const o = document.createElement('option');
          o.value = s.id; o.textContent = s.nombre;
          sSelect.appendChild(o);
        });
      }
      if (cSelect) {
        cSelect.innerHTML = '<option value="">Todas las cajas</option>';
        data.cajas.forEach(c => {
          const o = document.createElement('option');
          o.value = c.id; o.textContent = c.nombre;
          cSelect.appendChild(o);
        });
      }
      if (uSelect) {
        uSelect.innerHTML = '<option value="">Todos los cajeros</option>';
        data.usuarios.forEach(u => {
          const o = document.createElement('option');
          o.value = u.id; o.textContent = u.nombre || u.usuario;
          uSelect.appendChild(o);
        });
      }
    } catch (_) { /* no-op si falla */ }
  }

  // ── Indicador de estado ───────────────────────────────────
  function setLoadingState(loading) {
    const btn = el('repv2-apply-btn');
    if (btn) btn.textContent = loading ? '⏳ Cargando...' : '🔍 Aplicar';
    const err = el('repv2-error-banner');
    if (err && loading) err.style.display = 'none';
  }
  function showDataError(msg) {
    let err = el('repv2-error-banner');
    if (!err) {
      err = document.createElement('div');
      err.id = 'repv2-error-banner';
      err.style.cssText = 'background:#ff4b6e22;border:1px solid #ff4b6e;color:#ff4b6e;padding:0.75rem 1rem;border-radius:8px;margin:0.75rem 0;font-size:0.85rem;';
      const topbar = document.querySelector('.repv2-topbar');
      if (topbar) topbar.insertAdjacentElement('afterend', err);
    }
    err.style.display = 'block';
    err.textContent = msg;
  }

  // ── KPIs ─────────────────────────────────────────────────
  async function loadKPIs() {
    try {
      RV2.kpis = await apiGet('/api/reports/advanced/kpis' + buildQS());
    } catch (e) {
      console.error('[Reportes] loadKPIs error:', e.message);
      RV2.kpis = {};
      if (e.message.includes('401')) showDataError('Sesión expirada — recarga e inicia sesión nuevamente.');
      else showDataError('No se pudieron cargar los datos del servidor. Verifica que el servidor esté activo.');
    }
  }

  function renderKPIs() {
    const k = RV2.kpis || {};
    const ventas = Number(k.total_ventas || 0);
    setText('kpi-ventas',    fmt(ventas));
    setText('kpi-facturas',  `${fmtNum(k.total_facturas || 0)} facturas`);
    setText('kpi-ganancia',  fmt(k.ganancia || 0));
    setText('kpi-margen',    `${k.margen || '0.0'}% margen`);
    setText('kpi-ticket',    fmt(k.ticket_promedio || 0));
    setText('kpi-itbis',     fmt(k.total_itbis || 0));
    setText('kpi-efectivo',  fmt(k.efectivo || 0));
    setText('kpi-tarjeta',   fmt(k.tarjeta || 0));
    setText('kpi-transferencia', fmt(k.transferencia || 0));
    setText('kpi-credito',   fmt(k.credito || 0));

    const total = ventas || 1;
    setText('kpi-efectivo-pct',     `${((Number(k.efectivo||0)/total)*100).toFixed(1)}% de ventas`);
    setText('kpi-tarjeta-pct',      `${((Number(k.tarjeta||0)/total)*100).toFixed(1)}% de ventas`);
    setText('kpi-transferencia-pct',`${((Number(k.transferencia||0)/total)*100).toFixed(1)}% de ventas`);
  }

  // ── Ventas por día ────────────────────────────────────────
  async function loadVentasDia() {
    try {
      RV2.ventas_dia = await apiGet('/api/reports/advanced/ventas-dia' + buildQS());
    } catch (e) { console.error('[Reportes] loadVentasDia:', e.message); RV2.ventas_dia = []; }
  }

  function renderChartTendencia() {
    const canvas = el('repv2-chart-tendencia');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rows = RV2.ventas_dia;

    const labels = rows.map(r => {
      // r.dia puede llegar como string 'YYYY-MM-DD' o como Date object (MariaDB)
      let d;
      if (r.dia instanceof Date) {
        d = r.dia;
      } else {
        const dStr = String(r.dia || '').trim();
        d = new Date(dStr.includes('T') ? dStr : dStr + 'T00:00:00');
      }
      if (isNaN(d.getTime())) return String(r.dia || '?');
      return d.toLocaleDateString('es-DO', { day: '2-digit', month: 'short' });
    });
    const values = rows.map(r => Number(r.total));
    const maxV = Math.max(...values, 1);

    const W = canvas.offsetWidth || 600;
    const H = 220;
    canvas.width = W;
    canvas.height = H;
    ctx.clearRect(0, 0, W, H);

    const padL = 60, padR = 20, padT = 20, padB = 40;
    const chartW = W - padL - padR;
    const chartH = H - padT - padB;
    const n = labels.length;

    if (n === 0) {
      ctx.fillStyle = 'rgba(150,150,150,0.5)';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Sin datos en el período', W / 2, H / 2);
      setText('dash-trend-label', 'Sin datos');
      return;
    }

    // Gradiente de fondo bajo la línea
    const isDark = document.documentElement.dataset.theme !== 'light';
    const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
    const textColor = isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)';
    const accentColor = '#6C63FF';

    // Grid lines
    const gridLines = 5;
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    for (let i = 0; i <= gridLines; i++) {
      const y = padT + (chartH / gridLines) * i;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      const val = maxV - (maxV / gridLines) * i;
      ctx.fillStyle = textColor;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(val >= 1000 ? `${(val/1000).toFixed(0)}k` : val.toFixed(0), padL - 5, y + 4);
    }

    // X labels
    const step = n > 14 ? Math.ceil(n / 7) : 1;
    ctx.fillStyle = textColor;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    labels.forEach((l, i) => {
      if (i % step !== 0 && i !== n - 1) return;
      const x = padL + (i / Math.max(n - 1, 1)) * chartW;
      ctx.fillText(l, x, H - padB + 16);
    });

    // Area gradient
    const xPts = values.map((_, i) => padL + (i / Math.max(n - 1, 1)) * chartW);
    const yPts = values.map(v => padT + chartH - (v / maxV) * chartH);

    const grad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
    grad.addColorStop(0, 'rgba(108,99,255,0.25)');
    grad.addColorStop(1, 'rgba(108,99,255,0.01)');
    ctx.beginPath();
    ctx.moveTo(xPts[0], padT + chartH);
    xPts.forEach((x, i) => ctx.lineTo(x, yPts[i]));
    ctx.lineTo(xPts[n - 1], padT + chartH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    xPts.forEach((x, i) => i === 0 ? ctx.moveTo(x, yPts[i]) : ctx.lineTo(x, yPts[i]));
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Dots
    xPts.forEach((x, i) => {
      ctx.beginPath();
      ctx.arc(x, yPts[i], 4, 0, Math.PI * 2);
      ctx.fillStyle = accentColor;
      ctx.fill();
      ctx.strokeStyle = isDark ? '#1e2435' : '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    const total = values.reduce((s, v) => s + v, 0);
    setText('dash-trend-label', `${n} días · ${fmt(total)}`);
  }

  // ── Métodos de pago ───────────────────────────────────────
  async function loadMetodos() {
    try {
      RV2.metodos = await apiGet('/api/reports/advanced/metodos-pago' + buildQS());
    } catch (e) { console.error('[Reportes] loadMetodos:', e.message); RV2.metodos = []; }
  }

  const METODO_COLORS = ['#6C63FF','#00E5A0','#40C4FF','#FFB300','#FF4B6E','#A78BFA'];
  const METODO_LABELS = {
    efectivo: 'Efectivo', tarjeta: 'Tarjeta',
    transferencia: 'Transfer.', credito: 'Crédito',
    contra_entrega: 'C. Entrega'
  };

  function renderChartMetodos() {
    const canvas = el('repv2-chart-metodos');
    const legend = el('repv2-metodos-legend');
    if (!canvas) return;
    const rows = RV2.metodos;

    if (!rows.length) {
      if (legend) legend.innerHTML = '<p style="color:var(--text3);font-size:0.8rem">Sin datos</p>';
      return;
    }

    const W = canvas.offsetWidth || 280;
    const H = 200;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2, cy = H / 2, r = Math.min(cx, cy) - 16, ri = r * 0.58;
    let startAngle = -Math.PI / 2;
    const total = rows.reduce((s, r) => s + Number(r.total), 0) || 1;

    rows.forEach((row, i) => {
      const slice = (Number(row.total) / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, startAngle, startAngle + slice);
      ctx.fillStyle = METODO_COLORS[i % METODO_COLORS.length];
      ctx.fill();
      startAngle += slice;
    });

    // Hole
    ctx.beginPath();
    ctx.arc(cx, cy, ri, 0, Math.PI * 2);
    const isDark = document.documentElement.dataset.theme !== 'light';
    ctx.fillStyle = isDark ? '#1E2435' : '#ffffff';
    ctx.fill();

    // Center text
    ctx.textAlign = 'center';
    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText('TOTAL', cx, cy - 6);
    ctx.font = 'bold 12px monospace';
    const cur = (typeof DB !== 'undefined' && DB.config?.currency) || 'RD$';
    ctx.fillText(`${cur} ${(total/1000).toFixed(1)}k`, cx, cy + 12);

    // Legend
    if (legend) {
      legend.innerHTML = rows.map((row, i) => `
        <div class="repv2-donut-item">
          <div class="repv2-donut-dot" style="background:${METODO_COLORS[i % METODO_COLORS.length]}"></div>
          <span class="repv2-donut-label">${METODO_LABELS[row.metodo] || row.metodo}</span>
          <span class="repv2-donut-val">${fmt(row.total)}</span>
          <span class="repv2-donut-pct">${row.porcentaje}%</span>
        </div>`).join('');
    }
  }

  // ── Top productos ─────────────────────────────────────────
  async function loadProductos() {
    try {
      RV2.productos = await apiGet('/api/reports/advanced/productos' + buildQS({ limit: 10 }));
    } catch (e) { console.error('[Reportes] loadProductos:', e.message); RV2.productos = []; }
  }

  function renderTopProductos() {
    const c = el('repv2-top-productos');
    if (!c) return;
    const rows = RV2.productos.slice(0, 10);
    if (!rows.length) { c.innerHTML = '<p style="color:var(--text3);font-size:0.82rem;padding:.5rem">Sin datos</p>'; return; }
    c.innerHTML = rows.map((r, i) => `
      <div class="repv2-rank-item">
        <span class="repv2-rank-num">${i + 1}</span>
        <span class="repv2-rank-name" title="${r.nombre}">${r.nombre}</span>
        <span class="repv2-rank-val">${fmtNum(r.cantidad)} u.</span>
      </div>`).join('');
  }

  // ── Top clientes ──────────────────────────────────────────
  async function loadClientes() {
    try {
      RV2.clientes = await apiGet('/api/reports/advanced/clientes' + buildQS());
    } catch (e) { console.error('[Reportes] loadClientes:', e.message); RV2.clientes = []; }
  }

  function renderTopClientes() {
    const c = el('repv2-top-clientes');
    if (!c) return;
    const rows = RV2.clientes.slice(0, 10);
    if (!rows.length) { c.innerHTML = '<p style="color:var(--text3);font-size:0.82rem;padding:.5rem">Sin datos</p>'; return; }
    c.innerHTML = rows.map((r, i) => `
      <div class="repv2-rank-item">
        <span class="repv2-rank-num">${i + 1}</span>
        <span class="repv2-rank-name" title="${r.nombre}">${r.nombre}</span>
        <span class="repv2-rank-val">${fmt(r.totalComprado)}</span>
      </div>`).join('');
  }

  // ── Por sucursal (barras) ─────────────────────────────────
  async function loadPorSucursal() {
    try {
      RV2.por_sucursal = await apiGet('/api/reports/advanced/por-sucursal' + buildQS());
    } catch (e) { console.error('[Reportes] loadPorSucursal:', e.message); RV2.por_sucursal = []; }
  }

  function renderPorSucursalBars() {
    const c = el('repv2-por-sucursal-bars');
    if (!c) return;
    const rows = RV2.por_sucursal;
    if (!rows.length) { c.innerHTML = '<p style="color:var(--text3);font-size:0.82rem;padding:.5rem">Sin datos</p>'; return; }
    const max = Math.max(...rows.map(r => Number(r.total)), 1);
    c.innerHTML = rows.map(r => {
      const pct = ((Number(r.total) / max) * 100).toFixed(1);
      return `
        <div class="repv2-bar-item-v2">
          <div class="repv2-bar-row">
            <span class="repv2-bar-name">${r.sucursal}</span>
            <span class="repv2-bar-amount">${fmt(r.total)}</span>
          </div>
          <div class="repv2-bar-track-v2"><div class="repv2-bar-fill-v2" style="width:${pct}%"></div></div>
        </div>`;
    }).join('');
  }

  // ── Render dashboard completo ─────────────────────────────
  function renderDashboard() {
    renderKPIs();
    setTimeout(() => {
      renderChartTendencia();
      renderChartMetodos();
      if (typeof window.scheduleUiTranslation === 'function') window.scheduleUiTranslation(document.body);
    }, 80);
    renderTopProductos();
    renderTopClientes();
    renderPorSucursalBars();
    if (typeof window.scheduleUiTranslation === 'function') window.scheduleUiTranslation(document.body);
  }

  // ── DETALLADOS: Facturas ──────────────────────────────────
  window.repV2LoadFacturas = async function (page = 1) {
    try {
      const metodo = el('det-metodo-filter')?.value || '';
      const data = await apiGet('/api/reports/advanced/facturas' + buildQS({ page, limit: 50, metodo }));
      RV2.facturas = data;
      renderFacturasTable();
    } catch (e) { console.error(e); }
  };

  function renderFacturasTable() {
    const { rows, total, page, pages } = RV2.facturas;
    setText('det-facturas-count', `${fmtNum(total)} facturas`);
    const tbody = el('det-facturas-tbody');
    const tfoot = el('det-facturas-tfoot');
    if (!tbody) return;

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;color:var(--text3);padding:2rem">Sin facturas en el período</td></tr>`;
      if (tfoot) tfoot.innerHTML = '';
      el('det-facturas-pager').innerHTML = '';
      return;
    }

    tbody.innerHTML = rows.map(r => `
      <tr>
        <td><strong>${r.factura}</strong></td>
        <td>${r.ncf || '—'}</td>
        <td>${new Date(r.fecha).toLocaleDateString('es-DO')}</td>
        <td>${r.cliente || '—'}</td>
        <td>${r.cajero || '—'}</td>
        <td>${r.sucursal || '—'}</td>
        <td>${fmtMetodo(r.metodo)}</td>
        <td style="font-family:var(--font-mono)">${fmt(r.subtotal)}</td>
        <td style="font-family:var(--font-mono)">${fmt(r.itbis)}</td>
        <td style="font-family:var(--font-mono);font-weight:800">${fmt(r.total)}</td>
        <td><span class="repv2-estado repv2-estado-${r.estado}">${r.estado}</span></td>
      </tr>`).join('');

    const totals = rows.reduce((a, r) => ({ sub: a.sub + r.subtotal, itbis: a.itbis + r.itbis, total: a.total + r.total }), { sub: 0, itbis: 0, total: 0 });
    if (tfoot) {
      tfoot.innerHTML = `<tr>
        <td colspan="7">Subtotales (página ${page})</td>
        <td>${fmt(totals.sub)}</td>
        <td>${fmt(totals.itbis)}</td>
        <td>${fmt(totals.total)}</td>
        <td></td>
      </tr>`;
    }

    renderPager('det-facturas-pager', page, pages, p => repV2LoadFacturas(p));
  }

  function fmtMetodo(m) {
    return { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transfer.', credito: 'Crédito', contra_entrega: 'C.Entrega' }[m] || m || '—';
  }

  function renderPager(containerId, page, pages, cb) {
    const c = el(containerId);
    if (!c || pages <= 1) { if (c) c.innerHTML = ''; return; }
    const btns = [];
    if (page > 1) btns.push(`<button class="repv2-page-btn" onclick="(${cb})(${page - 1})">‹</button>`);
    const start = Math.max(1, page - 2);
    const end = Math.min(pages, start + 4);
    for (let i = start; i <= end; i++) {
      btns.push(`<button class="repv2-page-btn${i === page ? ' active' : ''}" onclick="(${cb})(${i})">${i}</button>`);
    }
    if (page < pages) btns.push(`<button class="repv2-page-btn" onclick="(${cb})(${page + 1})">›</button>`);
    c.innerHTML = btns.join('');
  }

  // ── DETALLADOS: Productos ─────────────────────────────────
  async function loadProductosDetallado() {
    try {
      RV2.productos = await apiGet('/api/reports/advanced/productos' + buildQS({ limit: 50 }));
      renderProductosTable();
    } catch (_) {}
  }

  function renderProductosTable() {
    const rows = RV2.productos;
    setText('det-productos-count', `${rows.length} productos`);
    const tbody = el('det-productos-tbody');
    if (!tbody) return;
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:2rem;color:var(--text3)">Sin datos</td></tr>`; return; }
    tbody.innerHTML = rows.map((r, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${r.codigo || '—'}</td>
        <td><strong>${r.nombre}</strong></td>
        <td>${r.categoria || '—'}</td>
        <td style="font-family:var(--font-mono);font-weight:700">${fmtNum(r.cantidad)}</td>
        <td>${fmtNum(r.enFacturas)}</td>
        <td>${fmt(r.precioPromedio)}</td>
        <td style="font-family:var(--font-mono);font-weight:800">${fmt(r.totalVendido)}</td>
        <td>${r.participacion}%</td>
      </tr>`).join('');
  }

  // ── DETALLADOS: Por Sucursal ──────────────────────────────
  async function loadPorSucursalDetallado() {
    try {
      RV2.por_sucursal = await apiGet('/api/reports/advanced/por-sucursal' + buildQS());
      renderSucursalTable();
    } catch (_) {}
  }

  function renderSucursalTable() {
    const rows = RV2.por_sucursal;
    setText('det-sucursal-count', `${rows.length} sucursales`);
    const tbody = el('det-sucursal-tbody');
    const tfoot = el('det-sucursal-tfoot');
    if (!tbody) return;
    const totalGeneral = rows.reduce((s, r) => s + Number(r.total), 0);
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td><strong>${r.sucursal}</strong></td>
        <td>${fmtNum(r.facturas)}</td>
        <td style="font-family:var(--font-mono);font-weight:800">${fmt(r.total)}</td>
        <td>${fmt(r.itbis)}</td>
        <td>${fmt(r.ticketPromedio)}</td>
        <td>${totalGeneral > 0 ? ((Number(r.total)/totalGeneral)*100).toFixed(1) : '0.0'}%</td>
      </tr>`).join('');
    if (tfoot) {
      const totals = rows.reduce((a, r) => ({ f: a.f + r.facturas, t: a.t + Number(r.total), i: a.i + Number(r.itbis) }), { f: 0, t: 0, i: 0 });
      tfoot.innerHTML = `<tr><td>TOTAL</td><td>${fmtNum(totals.f)}</td><td>${fmt(totals.t)}</td><td>${fmt(totals.i)}</td><td>—</td><td>100%</td></tr>`;
    }
  }

  // ── DETALLADOS: Por Caja ──────────────────────────────────
  async function loadPorCaja() {
    try {
      RV2.por_caja = await apiGet('/api/reports/advanced/por-caja' + buildQS());
      renderCajaTable();
    } catch (_) {}
  }

  function renderCajaTable() {
    const rows = RV2.por_caja;
    setText('det-caja-count', `${rows.length} cajas`);
    const tbody = el('det-caja-tbody');
    const tfoot = el('det-caja-tfoot');
    if (!tbody) return;
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td><strong>${r.caja}</strong></td>
        <td>${r.sucursal}</td>
        <td>${fmtNum(r.facturas)}</td>
        <td style="font-family:var(--font-mono);font-weight:800">${fmt(r.total)}</td>
        <td>${fmt(r.itbis)}</td>
        <td>${fmt(r.ticketPromedio)}</td>
      </tr>`).join('');
    if (tfoot) {
      const tot = rows.reduce((a, r) => ({ f: a.f + r.facturas, t: a.t + Number(r.total), i: a.i + Number(r.itbis) }), { f: 0, t: 0, i: 0 });
      tfoot.innerHTML = `<tr><td colspan="2">TOTAL</td><td>${fmtNum(tot.f)}</td><td>${fmt(tot.t)}</td><td>${fmt(tot.i)}</td><td>—</td></tr>`;
    }
  }

  // ── DETALLADOS: Por Usuario ───────────────────────────────
  async function loadPorUsuario() {
    try {
      RV2.por_usuario = await apiGet('/api/reports/advanced/por-usuario' + buildQS());
      renderUsuarioTable();
    } catch (_) {}
  }

  function renderUsuarioTable() {
    const rows = RV2.por_usuario;
    setText('det-usuario-count', `${rows.length} cajeros`);
    const tbody = el('det-usuario-tbody');
    const tfoot = el('det-usuario-tfoot');
    if (!tbody) return;
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td><strong>${r.nombre}</strong></td>
        <td>${r.usuario || '—'}</td>
        <td>${fmtNum(r.facturas)}</td>
        <td style="font-family:var(--font-mono);font-weight:800">${fmt(r.total)}</td>
        <td>${fmt(r.itbis)}</td>
        <td>${fmt(r.ticketPromedio)}</td>
      </tr>`).join('');
    if (tfoot) {
      const tot = rows.reduce((a, r) => ({ f: a.f + r.facturas, t: a.t + Number(r.total), i: a.i + Number(r.itbis) }), { f: 0, t: 0, i: 0 });
      tfoot.innerHTML = `<tr><td colspan="2">TOTAL</td><td>${fmtNum(tot.f)}</td><td>${fmt(tot.t)}</td><td>${fmt(tot.i)}</td><td>—</td></tr>`;
    }
  }

  // ── DETALLADOS: Métodos tabla ─────────────────────────────
  function renderMetodosTable() {
    const rows = RV2.metodos;
    const tbody = el('det-metodos-tbody');
    if (!tbody) return;
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:2rem;color:var(--text3)">Sin datos</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td><strong>${fmtMetodo(r.metodo)}</strong></td>
        <td>${fmtNum(r.facturas)}</td>
        <td style="font-family:var(--font-mono);font-weight:800">${fmt(r.total)}</td>
        <td>${r.porcentaje}%</td>
      </tr>`).join('');
  }

  // ── DETALLADOS: Devoluciones ──────────────────────────────
  async function loadDevoluciones() {
    try {
      const data = await apiGet('/api/reports/advanced/devoluciones' + buildQS());
      RV2.devoluciones = data;
      renderDevolucionesTable();
    } catch (_) {}
  }

  function renderDevolucionesTable() {
    const { rows, total, totalCancelado } = RV2.devoluciones;
    setText('det-dev-count', `${total} devoluciones · ${fmt(totalCancelado)} total devuelto`);
    const resumen = el('det-dev-resumen');
    if (resumen) {
      if (total > 0) {
        resumen.style.display = 'block';
        resumen.innerHTML = `↺ <strong>${total}</strong> devoluciones registradas en el período por un total de <strong>${fmt(totalCancelado)}</strong>.`;
      } else {
        resumen.style.display = 'none';
      }
    }
    const tbody = el('det-dev-tbody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text3)">Sin devoluciones en el período</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(r => {
      const tipoBadge = r.tipo === 'parcial'
        ? `<span style="background:var(--warning);color:#000;border-radius:4px;padding:2px 6px;font-size:.75rem">Parcial</span>`
        : `<span style="background:var(--danger);color:#fff;border-radius:4px;padding:2px 6px;font-size:.75rem">Total</span>`;
      const fechaFmt = (() => { try { return new Date(r.fecha).toLocaleDateString('es-DO'); } catch(_) { return r.fecha; } })();
      return `
      <tr>
        <td style="font-weight:700">${r.factura}</td>
        <td>${fechaFmt}</td>
        <td>${r.cliente || '—'}</td>
        <td>${r.cajero  || '—'}</td>
        <td>${tipoBadge}</td>
        <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.motivo || ''}">${r.motivo || '—'}</td>
        <td>${fmtMetodo(r.metodo)}</td>
        <td style="font-family:var(--font-mono);font-weight:800;color:var(--danger)">− ${fmt(r.total)}</td>
      </tr>`;
    }).join('');
  }

  // ── DGII ──────────────────────────────────────────────────
  async function loadDGII() {
    try {
      RV2.dgii = await apiGet('/api/reports/advanced/dgii' + buildQS());
      renderDGII();
    } catch (e) { console.error('[Reportes] loadDGII:', e.message); }
  }

  const NCF_DESC = { B01: 'Crédito Fiscal', B02: 'Consumidor Final', B14: 'Régimen Especial', Otro: 'Otros NCF', 'Sin NCF': 'Sin comprobante' };

  function renderDGII() {
    const d = RV2.dgii || {};
    setText('dgii-total',          fmt(d.totalFacturado));
    setText('dgii-gravado',        fmt(d.montoGravado));
    setText('dgii-exento',         fmt(d.montoExento));
    setText('dgii-itbis-cobrado',  fmt(d.itbisCobrado));
    setText('dgii-itbis-credito',  fmt(d.itbisCredito));
    setText('dgii-itbis-pagar',    fmt(d.itbisPagar));
    setText('dgii-formula-cobrado',fmt(d.itbisCobrado));
    setText('dgii-formula-credito',fmt(d.itbisCredito));
    setText('dgii-formula-pagar',  fmt(d.itbisPagar));

    const tbody = el('dgii-ncf-tbody');
    const tfoot = el('dgii-ncf-tfoot');
    if (!tbody) return;
    const rows = d.porNcf || [];
    const totalFact = rows.reduce((s, r) => s + Number(r.total), 0);
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td><strong>${r.tipoNcf}</strong></td>
        <td>${NCF_DESC[r.tipoNcf] || r.tipoNcf}</td>
        <td>${fmtNum(r.facturas)}</td>
        <td style="font-family:var(--font-mono);font-weight:800">${fmt(r.total)}</td>
        <td>${fmt(r.itbis)}</td>
        <td>${totalFact > 0 ? ((Number(r.total)/totalFact)*100).toFixed(1) : '0.0'}%</td>
      </tr>`).join('');
    if (tfoot) {
      const tot = rows.reduce((a, r) => ({ f: a.f + r.facturas, t: a.t + Number(r.total), i: a.i + Number(r.itbis) }), { f: 0, t: 0, i: 0 });
      tfoot.innerHTML = `<tr><td colspan="2">TOTAL</td><td>${fmtNum(tot.f)}</td><td>${fmt(tot.t)}</td><td>${fmt(tot.i)}</td><td>100%</td></tr>`;
    }
  }

  // ── PDF EXPORT ────────────────────────────────────────────
  function pdfHeader(doc, title) {
    const cfg = (typeof DB !== 'undefined' && DB.config) || {};
    const name = cfg.business_name || cfg.businessName || 'Tecno Caja';
    const rnc  = cfg.rnc || '';
    const f    = RV2.filtros;

    doc.setFillColor(108, 99, 255);
    doc.rect(0, 0, 210, 22, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(13); doc.setFont(undefined, 'bold');
    doc.text(name, 14, 10);
    doc.setFontSize(8); doc.setFont(undefined, 'normal');
    doc.text(`RNC: ${rnc}  |  ${title}`, 14, 16);
    doc.text(`Período: ${f.desde || '—'} a ${f.hasta || '—'}  |  Generado: ${new Date().toLocaleDateString('es-DO')}`, 14, 21);
    doc.setTextColor(30, 36, 53);
    return 28;
  }

  function pdfTable(doc, y, headers, rows, colWidths) {
    const pageW = 210, padL = 14, rowH = 7;
    // Header
    doc.setFillColor(240, 243, 255);
    doc.rect(padL, y, pageW - padL * 2, rowH, 'F');
    doc.setFontSize(7); doc.setFont(undefined, 'bold'); doc.setTextColor(100, 100, 130);
    let x = padL;
    headers.forEach((h, i) => { doc.text(h, x + 2, y + 5); x += colWidths[i]; });
    y += rowH;

    doc.setFont(undefined, 'normal'); doc.setTextColor(30, 36, 53);
    rows.forEach((row, ri) => {
      if (y > 270) { doc.addPage(); y = 14; }
      if (ri % 2 === 0) { doc.setFillColor(248, 249, 255); doc.rect(padL, y, pageW - padL * 2, rowH, 'F'); }
      x = padL;
      row.forEach((cell, i) => { doc.text(String(cell ?? ''), x + 2, y + 5); x += colWidths[i]; });
      y += rowH;
    });

    // Footer line
    doc.setDrawColor(200, 204, 220);
    doc.line(padL, y, pageW - padL, y);
    return y + 4;
  }

  function getJsPDF() {
    if (typeof jspdf !== 'undefined' && jspdf.jsPDF) return jspdf.jsPDF;
    if (typeof window.jsPDF !== 'undefined') return window.jsPDF;
    if (typeof jsPDF !== 'undefined') return jsPDF;
    return null;
  }

  function buildPdfBase(title) {
    const jsPDF = getJsPDF();
    if (!jsPDF) { alert('jsPDF no disponible'); return null; }
    const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
    return { doc, y: pdfHeader(doc, title) };
  }

  async function saveReportToSistemaData(doc, documentType, fileName) {
    try {
      const dataUri = doc.output('datauristring');
      const base64  = dataUri.split(',')[1];
      const res  = await fetch('/api/files/save', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentType,
          content:       base64,
          fileName,
          referenceDate: new Date().toISOString(),
          description:   `${fileName} | ${RV2.filtros.desde} — ${RV2.filtros.hasta}`,
        }),
      });
      const data = await res.json();
      if (data.ok && typeof showToast === 'function') {
        showToast(`Guardado en Sistema_Data/Reportes ✓`, 'success');
      }
    } catch (e) {
      console.error('[reportes] Error guardando en Sistema_Data:', e);
    }
  }

  window.repV2ExportDashboardPDF = function () {
    const res = buildPdfBase('Dashboard Ejecutivo');
    if (!res) return;
    const { doc } = res;
    let y = res.y;
    const k = RV2.kpis || {};
    // KPI block
    doc.setFontSize(9); doc.setFont(undefined, 'bold');
    doc.text('INDICADORES CLAVE', 14, y); y += 7;
    const kpiRows = [
      ['Total Ventas', fmt(k.total_ventas), 'Facturas', fmtNum(k.total_facturas)],
      ['Ganancia Bruta', fmt(k.ganancia), 'Margen', `${k.margen || 0}%`],
      ['Ticket Promedio', fmt(k.ticket_promedio), 'ITBIS', fmt(k.total_itbis)],
      ['Efectivo', fmt(k.efectivo), 'Tarjeta', fmt(k.tarjeta)],
      ['Transferencia', fmt(k.transferencia), 'Crédito', fmt(k.credito)],
    ];
    y = pdfTable(doc, y, ['Métrica', 'Valor', 'Métrica', 'Valor'], kpiRows, [50, 40, 50, 46]);

    // Top productos
    y += 6;
    doc.setFont(undefined, 'bold'); doc.setFontSize(9);
    doc.text('TOP PRODUCTOS', 14, y); y += 7;
    const prodRows = RV2.productos.slice(0, 10).map((r, i) => [i + 1, r.nombre, fmtNum(r.cantidad), fmt(r.totalVendido), `${r.participacion}%`]);
    y = pdfTable(doc, y, ['#', 'Producto', 'Cantidad', 'Total Vendido', '% Mix'], prodRows, [8, 80, 25, 40, 20]);

    const _fn1 = `Dashboard_Ejecutivo_${RV2.filtros.desde}_${RV2.filtros.hasta}.pdf`;
    doc.save(_fn1);
    saveReportToSistemaData(doc, 'reporte_general', _fn1);
  };

  window.repV2ExportFacturasPDF = function () {
    const res = buildPdfBase('Detalle de Facturas');
    if (!res) return;
    const { doc } = res;
    let y = res.y;
    const rows = RV2.facturas.rows.map(r => [
      r.factura, r.ncf || '—',
      new Date(r.fecha).toLocaleDateString('es-DO'),
      (r.cliente || '—').substring(0, 18),
      fmtMetodo(r.metodo),
      fmt(r.subtotal), fmt(r.itbis), fmt(r.total), r.estado
    ]);
    y = pdfTable(doc, y, ['Factura', 'NCF', 'Fecha', 'Cliente', 'Método', 'Subtotal', 'ITBIS', 'Total', 'Estado'],
      rows, [22, 20, 18, 30, 18, 24, 18, 24, 18]);
    const tot = RV2.facturas.rows.reduce((a, r) => ({ t: a.t + r.total, i: a.i + r.itbis }), { t: 0, i: 0 });
    doc.setFont(undefined, 'bold'); doc.setFontSize(9);
    doc.text(`Total: ${fmt(tot.t)}  |  ITBIS: ${fmt(tot.i)}`, 14, y + 5);
    const _fn2 = `Detalle_Facturas_${RV2.filtros.desde}_${RV2.filtros.hasta}.pdf`;
    doc.save(_fn2);
    saveReportToSistemaData(doc, 'reporte_ventas', _fn2);
  };

  window.repV2ExportProductosPDF = function () {
    const res = buildPdfBase('Productos Vendidos');
    if (!res) return;
    const { doc } = res;
    const rows = RV2.productos.map((r, i) => [i + 1, r.codigo || '—', r.nombre.substring(0, 35), fmtNum(r.cantidad), fmt(r.totalVendido), `${r.participacion}%`]);
    pdfTable(doc, res.y, ['#', 'Código', 'Producto', 'Cantidad', 'Total', '% Mix'], rows, [8, 18, 80, 22, 38, 16]);
    const _fn3 = `Productos_Vendidos_${RV2.filtros.desde}_${RV2.filtros.hasta}.pdf`;
    doc.save(_fn3);
    saveReportToSistemaData(doc, 'reporte_ventas', _fn3);
  };

  window.repV2ExportSucursalPDF = function () {
    const res = buildPdfBase('Ventas por Sucursal');
    if (!res) return;
    const { doc } = res;
    const rows = RV2.por_sucursal.map(r => [r.sucursal, fmtNum(r.facturas), fmt(r.total), fmt(r.itbis), fmt(r.ticketPromedio)]);
    pdfTable(doc, res.y, ['Sucursal', 'Facturas', 'Total', 'ITBIS', 'Ticket Prom.'], rows, [60, 25, 40, 35, 36]);
    const _fn4 = `Ventas_Sucursal_${RV2.filtros.desde}_${RV2.filtros.hasta}.pdf`;
    doc.save(_fn4);
    saveReportToSistemaData(doc, 'reporte_ventas', _fn4);
  };

  window.repV2ExportCajaPDF = function () {
    const res = buildPdfBase('Ventas por Caja');
    if (!res) return;
    const { doc } = res;
    const rows = RV2.por_caja.map(r => [r.caja, r.sucursal, fmtNum(r.facturas), fmt(r.total), fmt(r.itbis)]);
    pdfTable(doc, res.y, ['Caja', 'Sucursal', 'Facturas', 'Total', 'ITBIS'], rows, [45, 45, 22, 40, 34]);
    const _fn5 = `Ventas_Caja_${RV2.filtros.desde}_${RV2.filtros.hasta}.pdf`;
    doc.save(_fn5);
    saveReportToSistemaData(doc, 'reporte_ventas', _fn5);
  };

  window.repV2ExportUsuarioPDF = function () {
    const res = buildPdfBase('Ventas por Cajero');
    if (!res) return;
    const { doc } = res;
    const rows = RV2.por_usuario.map(r => [r.nombre, r.usuario || '—', fmtNum(r.facturas), fmt(r.total), fmt(r.itbis), fmt(r.ticketPromedio)]);
    pdfTable(doc, res.y, ['Cajero', 'Usuario', 'Facturas', 'Total', 'ITBIS', 'Ticket'], rows, [42, 30, 20, 36, 30, 28]);
    const _fn6 = `Ventas_Cajero_${RV2.filtros.desde}_${RV2.filtros.hasta}.pdf`;
    doc.save(_fn6);
    saveReportToSistemaData(doc, 'reporte_ventas', _fn6);
  };

  window.repV2ExportMetodosPDF = function () {
    const res = buildPdfBase('Métodos de Pago');
    if (!res) return;
    const { doc } = res;
    const rows = RV2.metodos.map(r => [fmtMetodo(r.metodo), fmtNum(r.facturas), fmt(r.total), `${r.porcentaje}%`]);
    pdfTable(doc, res.y, ['Método', 'Facturas', 'Total', '% del Total'], rows, [55, 30, 55, 36]);
    const _fn7 = `Metodos_Pago_${RV2.filtros.desde}_${RV2.filtros.hasta}.pdf`;
    doc.save(_fn7);
    saveReportToSistemaData(doc, 'reporte_ventas', _fn7);
  };

  window.repV2ExportDevolucionesPDF = function () {
    const res = buildPdfBase('Devoluciones y Anulaciones');
    if (!res) return;
    const { doc } = res;
    const rows = RV2.devoluciones.rows.map(r => {
      const fechaFmt = (() => { try { return new Date(r.fecha).toLocaleDateString('es-DO'); } catch(_) { return String(r.fecha || ''); } })();
      return [
        r.factura,
        fechaFmt,
        (r.cliente || '—').substring(0, 18),
        r.tipo === 'parcial' ? 'Parcial' : 'Total',
        (r.motivo || '—').substring(0, 20),
        fmtMetodo(r.metodo),
        fmt(r.total)
      ];
    });
    pdfTable(doc, res.y, ['Factura', 'Fecha', 'Cliente', 'Tipo', 'Motivo', 'Método', 'Total Dev.'], rows, [28, 20, 40, 15, 38, 20, 30]);
    const _fn8 = `Devoluciones_${RV2.filtros.desde}_${RV2.filtros.hasta}.pdf`;
    doc.save(_fn8);
    saveReportToSistemaData(doc, 'reporte_ventas', _fn8);
  };

  window.repV2ExportDGIIPDF = function () {
    const res = buildPdfBase('Reporte Fiscal DGII');
    if (!res) return;
    const { doc } = res;
    let y = res.y;
    const d = RV2.dgii || {};

    doc.setFontSize(9); doc.setFont(undefined, 'bold');
    doc.text('RESUMEN FISCAL', 14, y); y += 7;
    const kRows = [
      ['Total Facturado', fmt(d.totalFacturado), 'Facturas', fmtNum(d.totalFacturas)],
      ['Monto Gravado', fmt(d.montoGravado), 'Monto Exento', fmt(d.montoExento)],
      ['ITBIS Cobrado', fmt(d.itbisCobrado), 'Crédito Fiscal', fmt(d.itbisCredito)],
      ['ITBIS A PAGAR', fmt(d.itbisPagar), '', ''],
    ];
    y = pdfTable(doc, y, ['Concepto', 'Monto', 'Concepto', 'Monto'], kRows, [55, 38, 55, 38]);

    y += 8; doc.setFont(undefined, 'bold'); doc.text('DESGLOSE POR NCF', 14, y); y += 7;
    const ncfRows = (d.porNcf || []).map(r => [r.tipoNcf, NCF_DESC[r.tipoNcf] || r.tipoNcf, fmtNum(r.facturas), fmt(r.total), fmt(r.itbis)]);
    y = pdfTable(doc, y, ['Tipo', 'Descripción', 'Facturas', 'Total', 'ITBIS'], ncfRows, [18, 55, 20, 42, 36]);

    y += 10;
    doc.setFillColor(108, 99, 255);
    doc.rect(14, y, 182, 10, 'F');
    doc.setTextColor(255, 255, 255); doc.setFontSize(10); doc.setFont(undefined, 'bold');
    doc.text(`ITBIS ESTIMADO A PAGAR: ${fmt(d.itbisPagar)}`, 18, y + 7);
    doc.setTextColor(150, 150, 150); doc.setFontSize(7); doc.setFont(undefined, 'normal');
    doc.text('* Este reporte es orientativo. Consulte con su contador para la declaración oficial ante la DGII.', 14, y + 18);

    const _fn9 = `Reporte_Fiscal_DGII_${RV2.filtros.desde}_${RV2.filtros.hasta}.pdf`;
    doc.save(_fn9);
    saveReportToSistemaData(doc, 'reporte_general', _fn9);
  };

  window.repV2ExportConsolidadoPDF = async function () {
    if (typeof showToast === 'function') showToast('Generando reporte consolidado...', 'info');
    // Asegurar que todos los datos estén cargados
    if (!RV2.dgii) await loadDGII();
    if (!RV2.facturas.rows.length) await repV2LoadFacturas(1);

    const res = buildPdfBase('Reporte Consolidado Completo');
    if (!res) return;
    const { doc } = res;
    let y = res.y;
    const k = RV2.kpis || {};

    // KPIs
    doc.setFontSize(10); doc.setFont(undefined, 'bold'); doc.text('1. RESUMEN EJECUTIVO', 14, y); y += 8;
    y = pdfTable(doc, y, ['Métrica', 'Valor', 'Métrica', 'Valor'], [
      ['Total Ventas', fmt(k.total_ventas), 'Facturas', fmtNum(k.total_facturas)],
      ['Ganancia', fmt(k.ganancia), 'Margen', `${k.margen || 0}%`],
      ['Ticket Prom.', fmt(k.ticket_promedio), 'ITBIS', fmt(k.total_itbis)],
    ], [50, 40, 50, 46]);

    // Por sucursal
    if (RV2.por_sucursal.length) {
      doc.addPage(); y = 14;
      doc.setFont(undefined, 'bold'); doc.setFontSize(10); doc.text('2. VENTAS POR SUCURSAL', 14, y); y += 8;
      y = pdfTable(doc, y, ['Sucursal', 'Facturas', 'Total', 'ITBIS', 'Ticket'],
        RV2.por_sucursal.map(r => [r.sucursal, fmtNum(r.facturas), fmt(r.total), fmt(r.itbis), fmt(r.ticketPromedio)]),
        [60, 25, 38, 32, 30]);
    }

    // DGII
    if (RV2.dgii) {
      doc.addPage(); y = 14;
      doc.setFont(undefined, 'bold'); doc.setFontSize(10); doc.text('3. REPORTE FISCAL DGII', 14, y); y += 8;
      const d = RV2.dgii;
      y = pdfTable(doc, y, ['Concepto', 'Monto', 'Concepto', 'Monto'], [
        ['Total Facturado', fmt(d.totalFacturado), 'Monto Exento', fmt(d.montoExento)],
        ['ITBIS Cobrado', fmt(d.itbisCobrado), 'Crédito Fiscal', fmt(d.itbisCredito)],
        ['ITBIS A PAGAR', fmt(d.itbisPagar), '', ''],
      ], [55, 38, 55, 38]);
    }

    // Top productos
    if (RV2.productos.length) {
      doc.addPage(); y = 14;
      doc.setFont(undefined, 'bold'); doc.setFontSize(10); doc.text('4. TOP PRODUCTOS', 14, y); y += 8;
      y = pdfTable(doc, y, ['#', 'Producto', 'Cant.', 'Total', '% Mix'],
        RV2.productos.slice(0, 20).map((r, i) => [i + 1, r.nombre.substring(0, 50), fmtNum(r.cantidad), fmt(r.totalVendido), `${r.participacion}%`]),
        [8, 90, 20, 36, 16]);
    }

    const _fn10 = `Consolidado_Completo_${RV2.filtros.desde}_${RV2.filtros.hasta}.pdf`;
    doc.save(_fn10);
    saveReportToSistemaData(doc, 'reporte_general', _fn10);
  };

  // ── Guardar reporte diario en carpeta ────────────────────
  window.repV2SaveDailyReport = async function () {
    try {
      if (typeof showToast === 'function') showToast('Guardando reporte del día...', 'info');
      const r = await fetch('/api/reports/auto-save-daily', { method: 'POST', headers: getAuthHeaders(), body: '{}' });
      if (!r.ok) throw new Error(r.statusText);
      const result = await r.json();
      if (typeof showToast === 'function') showToast(`Reporte guardado: ${result.filePath}`, 'success');
    } catch (_) {
      if (typeof showToast === 'function') showToast('No se pudo guardar el reporte diario', 'error');
    }
  };

  // ── Compatibilidad con funciones antiguas del sistema ─────
  window.loadReporte = function () { repV2LoadAll(); };
  window.exportReporte = function () { repV2ExportDashboardPDF(); };
  window.updateReportes = function () { repV2LoadAll(); };

  // ── Hook: cuando se activa el módulo de reportes ──────────
  const _origShowModule = window.showModule;
  window.showModule = function (mod) {
    if (typeof _origShowModule === 'function') _origShowModule(mod);
    if (mod === 'reportes' || mod === 'module-reportes') {
      if (!RV2.kpis) initRepV2();
    }
  };

  // También escuchar el clic en el menú lateral
  document.addEventListener('DOMContentLoaded', () => {
    // Observar cuando el módulo se hace visible
    const moduleEl = document.getElementById('module-reportes');
    if (!moduleEl) return;
    const obs = new MutationObserver(() => {
      if (!moduleEl.classList.contains('hidden') && !RV2.kpis) {
        initRepV2();
      }
    });
    obs.observe(moduleEl, { attributes: true, attributeFilter: ['class'] });
  });

})();
