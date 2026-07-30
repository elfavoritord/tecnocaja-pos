/* ============================================================
   Tecno Caja — Caja General / Tesorería (Fase 1)
   Concentra el dinero de la empresa. NO reemplaza la caja
   operativa (apertura/cierre/arqueo de turnos, que sigue igual).
   ============================================================ */

(function () {
  'use strict';

  const TES = {
    unlocked: false,
    settings: null,
    funds: [],
    categories: [],
    branchScope: '', // '' = consolidado
    subtab: 'fondos',
  };

  function el(id) { return document.getElementById(id); }
  function toast(msg, type) { if (typeof showToast === 'function') showToast(msg, type); }
  function money(v) { return typeof fmt === 'function' ? fmt(v) : `RD$ ${Number(v || 0).toFixed(2)}`; }

  function getAuthHeaders() {
    let tok = '';
    if (typeof getTecnoCajaAuthToken === 'function') tok = getTecnoCajaAuthToken();
    else if (typeof DB !== 'undefined' && DB.authToken) tok = DB.authToken;
    if (tok) return { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' };
    return { 'Content-Type': 'application/json' };
  }

  async function tesApi(method, path, body) {
    const r = await fetch(path, {
      method,
      headers: getAuthHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
    return data;
  }
  function tesGet(path) { return tesApi('GET', path); }

  const MOVEMENT_TYPE_LABELS = {
    ingreso: 'Ingreso',
    gasto: 'Gasto',
    retiro_propietario: 'Retiro del propietario',
    pago_suplidor: 'Pago a suplidor',
    pago_empleado: 'Pago a empleado',
    transferencia_cierre: 'Transferencia de cierre',
    transferencia_fondo: 'Transferencia entre fondos',
    transferencia_sucursal_salida: 'Transferencia enviada a sucursal',
    transferencia_sucursal_entrada: 'Transferencia recibida de sucursal',
    ajuste_anulacion: 'Ajuste por anulación',
  };
  const STATUS_LABELS = {
    confirmado: '✅ Confirmado', anulado: '❌ Anulado', rechazado: '🚫 Rechazado', pendiente_aprobacion: '⏳ Pendiente',
  };
  function statusBadge(status) {
    return `<span class="tes-badge tes-badge-${status}">${STATUS_LABELS[status] || status}</span>`;
  }
  const FUND_TYPE_LABELS = {
    efectivo: 'Efectivo', banco: 'Banco', transferencias: 'Transferencias',
    tarjetas_pendientes: 'Tarjetas pendientes', tarjetas_liquidadas: 'Tarjetas liquidadas',
    cuentas_por_cobrar: 'Cuentas por cobrar', caja_fuerte: 'Caja fuerte',
    fondo_operativo: 'Fondo operativo', otro: 'Otro',
  };

  // ── Visibilidad del botón / gate inicial ─────────────────────────────

  window.tesoreriaOnReportesOpen = async function () {
    const btn = el('repv2-tab-btn-caja-general');
    if (!btn) return;
    if (typeof currentUserCan === 'function' && !currentUserCan('ver_caja_general')) {
      btn.classList.add('hidden');
      return;
    }
    try {
      TES.settings = await tesGet('/api/tesoreria/settings');
      btn.classList.toggle('hidden', !(TES.settings.enabled && TES.settings.showButton));
    } catch (_e) {
      btn.classList.add('hidden');
    }
  };

  // El cajero que acaba de cerrar su turno NO necesita permisos de Tesorería
  // para esto — solo mueve el efectivo de SU propio cierre a un fondo ya
  // configurado por un administrador, no le da acceso a ver ni administrar
  // Caja General. Por eso no se revisa currentUserCan aquí.
  window.tesoreriaMaybeShowTransferButton = function (summary) {
    const btn = el('btn-transferir-caja-general');
    const tesInfo = summary?.tesoreriaInfo || {};
    const canShow = Boolean(tesInfo.enabled && summary?.cashSessionId);
    if (btn) {
      btn.classList.toggle('hidden', !canShow);
      btn.onclick = () => tesoreriaShowQuickTransferConfirm(summary.cashSessionId, summary.efectivo || 0);
    }
    // Modo "preguntar" (Tesorería activa pero sin transferencia automática):
    // se pregunta de una vez, sin que el cajero tenga que acordarse de tocar el botón.
    if (canShow && tesInfo.askTransfer) {
      tesoreriaShowQuickTransferConfirm(summary.cashSessionId, summary.efectivo || 0);
    }
  };

  // Confirmación simple sin contraseña ni selección de fondos — usa el fondo
  // predeterminado de efectivo de la sucursal (POST /api/cash/closings/:id/transfer-to-tesoreria).
  window.tesoreriaShowQuickTransferConfirm = function (cashSessionId, montoEfectivo) {
    const body = `<p style="margin:0;font-size:0.95rem">¿Transferir ${money(montoEfectivo)} en efectivo a Caja General?</p>`;
    openModal('Transferir a Caja General', body, {
      icon: '↗️', confirmLabel: 'Sí, transferir',
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/cash/closings/${cashSessionId}/transfer-to-tesoreria`, {
            method: 'POST', headers: getAuthHeaders(),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'No se pudo transferir.');
          toast('Efectivo transferido a Caja General.', 'success');
          el('btn-transferir-caja-general')?.classList.add('hidden');
          return true;
        } catch (e) { toast(e.message || 'No se pudo transferir.', 'error'); return false; }
      },
    });
  };

  window.tesoreriaUnlock = function () {
    showSuperAdminPasswordModal(
      'Caja General',
      'Ingresa tu contraseña de inicio de sesión para acceder a Caja General.',
      async (pwd) => {
        try {
          await api.verifyAccountPassword({ password: pwd });
          TES.unlocked = true;
          el('tesoreria-locked')?.classList.add('hidden');
          el('tesoreria-content')?.classList.remove('hidden');
          await tesoreriaRefreshAll();
          return true;
        } catch (e) {
          toast(e.message || 'Contraseña incorrecta.', 'error');
          return false;
        }
      }
    );
  };

  window.tesoreriaOnTabOpen = function () {
    if (TES.unlocked) tesoreriaRefreshAll();
  };

  // ── Configuración (módulo Configuración) ─────────────────────────────

  window.loadTesoreriaConfig = async function () {
    try {
      const s = await tesGet('/api/tesoreria/settings');
      TES.settings = s;
      if (el('cfg-tesoreria-enabled')) el('cfg-tesoreria-enabled').checked = !!s.enabled;
      if (el('cfg-tesoreria-show-button')) el('cfg-tesoreria-show-button').checked = !!s.showButton;
      if (el('cfg-tesoreria-allow-negative')) el('cfg-tesoreria-allow-negative').checked = !!s.allowNegativeBalance;
      if (el('cfg-tesoreria-pass-expenses')) el('cfg-tesoreria-pass-expenses').checked = !!s.requirePasswordExpenses;
      if (el('cfg-tesoreria-pass-withdrawals')) el('cfg-tesoreria-pass-withdrawals').checked = !!s.requirePasswordWithdrawals;
      if (el('cfg-tesoreria-approval-threshold')) el('cfg-tesoreria-approval-threshold').value = s.approvalThresholdAmount || '';
      if (el('cfg-tesoreria-auto-transfer')) el('cfg-tesoreria-auto-transfer').checked = !!s.autoTransferEnabled;
    } catch (e) { console.warn('[tesoreria] No se pudo cargar configuración:', e.message); }
  };

  window.saveTesoreriaConfig = async function () {
    try {
      const payload = {
        enabled: !!el('cfg-tesoreria-enabled')?.checked,
        showButton: !!el('cfg-tesoreria-show-button')?.checked,
        allowNegativeBalance: !!el('cfg-tesoreria-allow-negative')?.checked,
        requirePasswordExpenses: !!el('cfg-tesoreria-pass-expenses')?.checked,
        requirePasswordWithdrawals: !!el('cfg-tesoreria-pass-withdrawals')?.checked,
        approvalThresholdAmount: Number(el('cfg-tesoreria-approval-threshold')?.value || 0),
        autoTransferEnabled: !!el('cfg-tesoreria-auto-transfer')?.checked,
      };
      await tesApi('PUT', '/api/tesoreria/settings', payload);
      TES.settings = payload;
      toast('Configuración de Caja General guardada.', 'success');
    } catch (e) { toast(e.message || 'No se pudo guardar la configuración.', 'error'); }
  };

  // ── Carga principal ───────────────────────────────────────────────────

  window.tesoreriaToggleMoreMenu = function (event) {
    event?.stopPropagation();
    el('tesoreria-more-menu')?.classList.toggle('open');
  };
  window.tesoreriaCloseMoreMenu = function () {
    el('tesoreria-more-menu')?.classList.remove('open');
  };
  document.addEventListener('click', (e) => {
    const menu = el('tesoreria-more-menu');
    if (menu && menu.classList.contains('open') && !menu.contains(e.target)) menu.classList.remove('open');
  });

  function applyActionPermissions() {
    const can = (p) => typeof currentUserCan === 'function' && currentUserCan(p);
    el('tesoreria-btn-income')?.classList.toggle('hidden', !can('registrar_ingresos_caja_general'));
    el('tesoreria-btn-expense')?.classList.toggle('hidden', !can('registrar_gastos_caja_general'));
    el('tesoreria-btn-withdrawal')?.classList.toggle('hidden', !can('registrar_gastos_caja_general'));
    el('tesoreria-btn-fund-transfer')?.classList.toggle('hidden', !can('transferir_fondos_caja_general'));
    el('tesoreria-btn-branch-transfer')?.classList.toggle('hidden', !can('transferir_entre_sucursales_caja_general'));
    el('tesoreria-btn-supplier-payment')?.classList.toggle('hidden', !can('pagar_suplidores_caja_general'));
    el('tesoreria-btn-employee-payment')?.classList.toggle('hidden', !can('pagar_empleados_caja_general'));
  }

  async function tesoreriaRefreshAll() {
    populateScopeSelect();
    applyActionPermissions();
    await Promise.all([
      loadDashboard(),
      loadFunds(),
      loadCategoriesOnce(),
    ]);
    if (TES.subtab === 'movimientos') await tesoreriaLoadMovements();
    if (TES.subtab === 'cierres') await loadClosingsPending();
  }

  function populateScopeSelect() {
    const sel = el('tesoreria-scope-select');
    if (!sel) return;
    const canAll = typeof currentUserCan === 'function' && (currentUserCan('ver_todas_sucursales_caja_general') || currentUserCan('*'));
    if (!canAll) {
      sel.innerHTML = '<option value="">Mi sucursal</option>';
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    const branches = DB.sucursales || [];
    sel.innerHTML = '<option value="">Vista consolidada</option>' +
      branches.map((b) => `<option value="${b.id}">${b.nombre}</option>`).join('');
    sel.value = TES.branchScope || '';
  }

  window.tesoreriaOnScopeChange = function () {
    TES.branchScope = el('tesoreria-scope-select')?.value || '';
    tesoreriaRefreshAll();
  };

  window.tesoreriaSwitchSubtab = function (subtab) {
    TES.subtab = subtab;
    document.querySelectorAll('.tesoreria-subtab').forEach((b) => b.classList.toggle('active', b.dataset.subtab === subtab));
    document.querySelectorAll('.tesoreria-subpane').forEach((p) => {
      const isActive = p.id === `tesoreria-subtab-${subtab}`;
      p.classList.toggle('active', isActive);
      p.classList.toggle('hidden', !isActive);
    });
    if (subtab === 'movimientos') tesoreriaLoadMovements();
    if (subtab === 'cierres') loadClosingsPending();
    if (subtab === 'transferencias') loadBranchTransfersPending();
    if (subtab === 'aprobaciones') loadApprovals();
    if (subtab === 'ventas-dia') loadDailyClosings();
  };

  function scopeQuery() {
    return TES.branchScope ? `branchId=${encodeURIComponent(TES.branchScope)}` : '';
  }

  async function loadDashboard() {
    try {
      const data = await tesGet(`/api/tesoreria/dashboard?${scopeQuery()}`);
      TES.lastDashboard = data;
      renderSummaryCards(data);
      renderTendenciaChart(data.dailySeries || []);
      renderCategoriasChart(data.byCategory || []);
      renderEvolucionChart(data.balanceEvolution || []);
      renderPorFondoChart(data.byFundType || []);
    } catch (e) { console.warn('[tesoreria] dashboard:', e.message); }
    try {
      const porSucursal = await tesGet(`/api/tesoreria/reports/por-sucursal?${scopeQuery()}`);
      renderPorSucursalChart(porSucursal);
    } catch (e) { console.warn('[tesoreria] por-sucursal:', e.message); }
  }

  function renderSummaryCards(data) {
    const wrap = el('tesoreria-summary-cards');
    if (!wrap) return;
    const cards = [
      { icon: '💰', label: 'Balance total', val: money(data.totalBalance), color: 'var(--tes-accent)' },
      { icon: '📈', label: 'Ingresos de hoy', val: money(data.incomeToday), color: '#16a34a' },
      { icon: '📊', label: 'Ingresos del mes', val: money(data.incomeMonth), color: '#16a34a' },
      { icon: '📉', label: 'Gastos de hoy', val: money(data.expenseToday), color: 'var(--danger)' },
      { icon: '📕', label: 'Gastos del mes', val: money(data.expenseMonth), color: 'var(--danger)' },
    ];
    if (Number(data.pendingApprovalCount || 0) > 0) {
      cards.push({ icon: '⏳', label: 'Pendientes de aprobación', val: `${data.pendingApprovalCount} · ${money(data.pendingApprovalAmount)}`, color: 'var(--warning)' });
    }
    wrap.innerHTML = cards.map((c) => `
      <div class="tes-stat-card" style="--stat-color:${c.color}">
        <span class="tes-stat-icon">${c.icon}</span>
        <div class="tes-stat-label">${c.label}</div>
        <div class="tes-stat-val">${c.val}</div>
      </div>
    `).join('');
  }

  const CHART_FONT = "'Plus Jakarta Sans', sans-serif";
  function isDarkTheme() { return document.documentElement.dataset.theme !== 'light'; }

  function setupCanvas(canvas, height) {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth || 400;
    canvas.width = W * dpr;
    canvas.height = height * dpr;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, height);
    return { ctx, W, H: height };
  }

  // Gráfico de barras dobles: ingresos vs gastos, últimos 30 días.
  function renderTendenciaChart(series) {
    const canvas = el('tesoreria-chart-tendencia');
    if (!canvas) return;
    const { ctx, W, H } = setupCanvas(canvas, 200);
    const dark = isDarkTheme();
    const textColor = dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.5)';
    const gridColor = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';

    const maxV = Math.max(...series.map((d) => Math.max(d.income, d.expense)), 1) * 1.15;
    const padL = 46, padR = 10, padT = 10, padB = 24;
    const chartW = W - padL - padR, chartH = H - padT - padB;
    const n = series.length || 1;
    const groupW = chartW / n;

    ctx.strokeStyle = gridColor; ctx.lineWidth = 1;
    ctx.fillStyle = textColor; ctx.font = `10px ${CHART_FONT}`; ctx.textAlign = 'right';
    for (let i = 0; i <= 3; i++) {
      const y = padT + (chartH / 3) * i;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      const val = maxV - (maxV / 3) * i;
      ctx.fillText(val >= 1000 ? `${(val / 1000).toFixed(1)}k` : val.toFixed(0), padL - 6, y + 3);
    }

    if (!series.length) {
      ctx.textAlign = 'center';
      ctx.fillText('Sin movimientos en los últimos 30 días', W / 2, H / 2);
      return;
    }

    series.forEach((d, i) => {
      const x = padL + i * groupW;
      const barW = Math.max(2, groupW * 0.32);
      const incH = (d.income / maxV) * chartH;
      const expH = (d.expense / maxV) * chartH;
      ctx.fillStyle = '#00E5A0';
      ctx.fillRect(x + groupW * 0.12, padT + chartH - incH, barW, incH);
      ctx.fillStyle = '#FF4B6E';
      ctx.fillRect(x + groupW * 0.12 + barW + 2, padT + chartH - expH, barW, expH);
    });

    // Leyenda simple.
    ctx.textAlign = 'left';
    ctx.fillStyle = '#00E5A0'; ctx.fillRect(padL, H - 14, 8, 8);
    ctx.fillStyle = textColor; ctx.fillText('Ingresos', padL + 12, H - 6);
    ctx.fillStyle = '#FF4B6E'; ctx.fillRect(padL + 80, H - 14, 8, 8);
    ctx.fillStyle = textColor; ctx.fillText('Gastos', padL + 92, H - 6);
  }

  // Gráfico de barras horizontales: gastos por categoría.
  function renderCategoriasChart(byCategory) {
    const canvas = el('tesoreria-chart-categorias');
    if (!canvas) return;
    const rows = (byCategory || []).slice(0, 6);
    const { ctx, W, H } = setupCanvas(canvas, 200);
    const dark = isDarkTheme();
    const textColor = dark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)';

    if (!rows.length) {
      ctx.fillStyle = textColor; ctx.font = `12px ${CHART_FONT}`; ctx.textAlign = 'center';
      ctx.fillText('Sin gastos categorizados en los últimos 30 días', W / 2, H / 2);
      return;
    }
    const maxV = Math.max(...rows.map((r) => r.total), 1);
    const padL = 110, padR = 50, padT = 10;
    const rowH = (H - padT * 2) / rows.length;
    ctx.font = `10.5px ${CHART_FONT}`;
    rows.forEach((r, i) => {
      const y = padT + i * rowH + rowH * 0.2;
      const barW = ((W - padL - padR) * r.total) / maxV;
      ctx.fillStyle = textColor; ctx.textAlign = 'right';
      ctx.fillText(r.name.length > 16 ? `${r.name.slice(0, 15)}…` : r.name, padL - 8, y + rowH * 0.35);
      ctx.fillStyle = '#6C63FF';
      ctx.fillRect(padL, y, Math.max(2, barW), rowH * 0.55);
      ctx.fillStyle = textColor; ctx.textAlign = 'left';
      ctx.fillText(money(r.total), padL + barW + 6, y + rowH * 0.35);
    });
  }

  // Línea de evolución del balance total (30 días).
  function renderEvolucionChart(series) {
    const canvas = el('tesoreria-chart-evolucion');
    if (!canvas) return;
    const { ctx, W, H } = setupCanvas(canvas, 200);
    const dark = isDarkTheme();
    const textColor = dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.5)';
    const gridColor = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
    if (!series.length) {
      ctx.fillStyle = textColor; ctx.font = `12px ${CHART_FONT}`; ctx.textAlign = 'center';
      ctx.fillText('Sin datos suficientes todavía', W / 2, H / 2);
      return;
    }
    const values = series.map((d) => d.balance);
    const minV = Math.min(...values, 0);
    const maxV = Math.max(...values, 1) * 1.1;
    const padL = 56, padR = 14, padT = 12, padB = 22;
    const chartW = W - padL - padR, chartH = H - padT - padB;
    const range = (maxV - minV) || 1;

    ctx.strokeStyle = gridColor; ctx.lineWidth = 1;
    ctx.fillStyle = textColor; ctx.font = `10px ${CHART_FONT}`; ctx.textAlign = 'right';
    for (let i = 0; i <= 3; i++) {
      const y = padT + (chartH / 3) * i;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      const val = maxV - (range / 3) * i;
      ctx.fillText(val >= 1000 ? `${(val / 1000).toFixed(1)}k` : val.toFixed(0), padL - 6, y + 3);
    }

    ctx.beginPath();
    ctx.strokeStyle = '#16a34a';
    ctx.lineWidth = 2;
    series.forEach((d, i) => {
      const x = padL + (chartW / (series.length - 1 || 1)) * i;
      const y = padT + chartH - ((d.balance - minV) / range) * chartH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // Barras por tipo de fondo (dónde está el dinero hoy).
  function renderPorFondoChart(byFundType) {
    const canvas = el('tesoreria-chart-por-fondo');
    if (!canvas) return;
    const rows = byFundType || [];
    const { ctx, W, H } = setupCanvas(canvas, 200);
    const dark = isDarkTheme();
    const textColor = dark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)';
    if (!rows.length) {
      ctx.fillStyle = textColor; ctx.font = `12px ${CHART_FONT}`; ctx.textAlign = 'center';
      ctx.fillText('Sin fondos creados todavía', W / 2, H / 2);
      return;
    }
    const maxV = Math.max(...rows.map((r) => r.total), 1);
    const padL = 110, padR = 50, padT = 10;
    const rowH = (H - padT * 2) / rows.length;
    ctx.font = `10.5px ${CHART_FONT}`;
    rows.forEach((r, i) => {
      const y = padT + i * rowH + rowH * 0.2;
      const barW = ((W - padL - padR) * r.total) / maxV;
      const label = FUND_TYPE_LABELS[r.type] || r.type;
      ctx.fillStyle = textColor; ctx.textAlign = 'right';
      ctx.fillText(label.length > 16 ? `${label.slice(0, 15)}…` : label, padL - 8, y + rowH * 0.35);
      ctx.fillStyle = FUND_TYPE_COLORS[r.type] || '#6C63FF';
      ctx.fillRect(padL, y, Math.max(2, barW), rowH * 0.55);
      ctx.fillStyle = textColor; ctx.textAlign = 'left';
      ctx.fillText(money(r.total), padL + barW + 6, y + rowH * 0.35);
    });
  }

  // Barras dobles (ingresos/gastos) por sucursal, con rentabilidad como etiqueta.
  function renderPorSucursalChart(rows) {
    const canvas = el('tesoreria-chart-por-sucursal');
    if (!canvas) return;
    const { ctx, W, H } = setupCanvas(canvas, 220);
    const dark = isDarkTheme();
    const textColor = dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.5)';
    const gridColor = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
    if (!rows || !rows.length) {
      ctx.fillStyle = textColor; ctx.font = `12px ${CHART_FONT}`; ctx.textAlign = 'center';
      ctx.fillText('Sin datos de sucursales todavía', W / 2, H / 2);
      return;
    }
    const maxV = Math.max(...rows.map((r) => Math.max(r.ingresos, r.gastosTotal)), 1) * 1.15;
    const padL = 50, padR = 14, padT = 10, padB = 40;
    const chartW = W - padL - padR, chartH = H - padT - padB;
    const n = rows.length;
    const groupW = chartW / n;

    ctx.strokeStyle = gridColor; ctx.lineWidth = 1;
    ctx.fillStyle = textColor; ctx.font = `10px ${CHART_FONT}`; ctx.textAlign = 'right';
    for (let i = 0; i <= 3; i++) {
      const y = padT + (chartH / 3) * i;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      const val = maxV - (maxV / 3) * i;
      ctx.fillText(val >= 1000 ? `${(val / 1000).toFixed(1)}k` : val.toFixed(0), padL - 6, y + 3);
    }

    rows.forEach((r, i) => {
      const x = padL + i * groupW;
      const barW = Math.max(2, groupW * 0.3);
      const incH = (r.ingresos / maxV) * chartH;
      const expH = (r.gastosTotal / maxV) * chartH;
      ctx.fillStyle = '#16a34a';
      ctx.fillRect(x + groupW * 0.15, padT + chartH - incH, barW, incH);
      ctx.fillStyle = '#FF4B6E';
      ctx.fillRect(x + groupW * 0.15 + barW + 3, padT + chartH - expH, barW, expH);
      ctx.fillStyle = textColor; ctx.font = `9.5px ${CHART_FONT}`; ctx.textAlign = 'center';
      const label = r.branchName.length > 12 ? `${r.branchName.slice(0, 11)}…` : r.branchName;
      ctx.fillText(label, x + groupW / 2, H - padB + 14);
      ctx.fillStyle = r.rentabilidad >= 0 ? '#16a34a' : '#FF4B6E';
      ctx.font = `700 9.5px ${CHART_FONT}`;
      ctx.fillText(money(r.rentabilidad), x + groupW / 2, H - padB + 28);
    });
  }

  async function loadFunds() {
    try {
      TES.funds = await tesGet(`/api/tesoreria/funds?${scopeQuery()}`);
      renderFundsTable(TES.funds);
    } catch (e) { console.warn('[tesoreria] funds:', e.message); }
  }

  const FUND_TYPE_ICONS = {
    efectivo: '💵', banco: '🏦', transferencias: '🔄', tarjetas_pendientes: '💳', tarjetas_liquidadas: '✅',
    cuentas_por_cobrar: '📄', caja_fuerte: '🔐', fondo_operativo: '⚙️', otro: '📦',
  };
  const FUND_TYPE_COLORS = {
    efectivo: '#16a34a', banco: '#2563eb', transferencias: '#0891b2', tarjetas_pendientes: '#d97706',
    tarjetas_liquidadas: '#16a34a', cuentas_por_cobrar: '#7c3aed', caja_fuerte: '#57534e', fondo_operativo: '#4b5563', otro: '#6b7280',
  };

  function renderFundsTable(funds) {
    const grid = el('tesoreria-funds-grid');
    if (!grid) return;
    if (!funds.length) {
      grid.innerHTML = `<div class="tes-empty-state">
        <span class="tes-empty-icon">🗂️</span>
        No hay fondos creados. <a href="#" onclick="tesoreriaOpenNewFundModal();return false;">Crear el primer fondo</a>
      </div>`;
      return;
    }
    const branchName = (id) => (DB.sucursales || []).find((b) => Number(b.id) === Number(id))?.nombre || '—';
    grid.innerHTML = funds.map((f) => `
      <div class="tes-fund-card" style="--fund-color:${FUND_TYPE_COLORS[f.fundType] || 'var(--tes-accent)'}">
        <div class="tes-fund-card-top">
          <span class="tes-fund-icon">${FUND_TYPE_ICONS[f.fundType] || '📦'}</span>
          <span class="tes-fund-name" title="${f.name}">${f.name}</span>
          ${f.isDefaultForType ? '<span class="tes-fund-default-badge">Predeterminado</span>' : ''}
        </div>
        <div class="tes-fund-meta">${FUND_TYPE_LABELS[f.fundType] || f.fundType} · ${f.branchId ? branchName(f.branchId) : 'Corporativo'} · ${f.currency}</div>
        <div class="tes-fund-balance">${money(f.currentBalance)}</div>
      </div>
    `).join('') + `
      <div class="tes-fund-card" style="display:flex;align-items:center;justify-content:center;cursor:pointer;border-style:dashed" onclick="tesoreriaOpenNewFundModal()">
        <span style="color:var(--tes-accent);font-weight:700">+ Nuevo fondo</span>
      </div>
    `;
  }

  async function loadCategoriesOnce() {
    try {
      TES.categories = await tesGet('/api/tesoreria/categories');
    } catch (e) { console.warn('[tesoreria] categories:', e.message); }
  }

  window.tesoreriaLoadMovements = async function () {
    const tbody = el('tesoreria-movements-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="padding:1rem;text-align:center">Cargando…</td></tr>';
    try {
      const params = new URLSearchParams();
      if (TES.branchScope) params.set('branchId', TES.branchScope);
      const desde = el('tesoreria-mov-desde')?.value;
      const hasta = el('tesoreria-mov-hasta')?.value;
      const tipo = el('tesoreria-mov-tipo')?.value;
      if (desde) params.set('desde', desde);
      if (hasta) params.set('hasta', hasta);
      if (tipo) params.set('type', tipo);
      const rows = await tesGet(`/api/tesoreria/movements?${params.toString()}`);
      renderMovementsTable(rows);
    } catch (e) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="padding:1rem;color:var(--danger)">${e.message}</td></tr>`;
    }
  };

  function renderMovementsTable(rows) {
    const tbody = el('tesoreria-movements-tbody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="padding:1rem;text-align:center;color:var(--text3)">Sin movimientos.</td></tr>';
      return;
    }
    const canVoid = typeof currentUserCan === 'function' && currentUserCan('anular_movimientos_caja_general');
    tbody.innerHTML = rows.map((m) => `
      <tr>
        <td>${(m.createdAt || '').replace('T', ' ').slice(0, 16)}</td>
        <td>${MOVEMENT_TYPE_LABELS[m.movementType] || m.movementType}</td>
        <td>${m.description || ''}</td>
        <td>${money(m.amount)}</td>
        <td>${m.paymentMethod || '—'}</td>
        <td>${m.createdByUserName || '—'}</td>
        <td>${statusBadge(m.status)}</td>
        <td style="white-space:nowrap">
          ${m.documentReference ? `<a href="${m.documentReference}" target="_blank" title="Ver comprobante">📎</a>` : `<a href="#" onclick="tesoreriaAttachFile(${m.id});return false;" title="Adjuntar comprobante">📎+</a>`}
          ${canVoid && m.status === 'confirmado' ? ` · <a href="#" onclick="tesoreriaVoidMovement(${m.id});return false;">Anular</a>` : ''}
        </td>
      </tr>
    `).join('');
  }

  // ── Adjuntar comprobante (imagen o PDF) a un movimiento existente ───────

  window.tesoreriaAttachFile = function (movementId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,application/pdf';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      document.body.removeChild(input);
      if (!file) return;
      if (file.size > 15 * 1024 * 1024) { toast('El archivo no puede superar 15 MB.', 'warning'); return; }
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          await tesApi('POST', `/api/tesoreria/movements/${movementId}/attachment`, { fileData: reader.result });
          toast('Comprobante adjuntado.', 'success');
          tesoreriaRefreshAll();
        } catch (e) { toast(e.message || 'No se pudo adjuntar el archivo.', 'error'); }
      };
      reader.readAsDataURL(file);
    });
    document.body.appendChild(input);
    input.click();
  };

  // ── Exportación PDF / Excel ──────────────────────────────────────────────

  function tesPdfHeader(doc, title) {
    const cfg = (typeof DB !== 'undefined' && DB.config) || {};
    const name = cfg.business_name || cfg.businessName || 'Tecno Caja';
    doc.setFillColor(34, 197, 94);
    doc.rect(0, 0, 210, 22, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(13); doc.setFont(undefined, 'bold');
    doc.text(name, 14, 10);
    doc.setFontSize(8); doc.setFont(undefined, 'normal');
    doc.text(`Caja General · ${title}`, 14, 16);
    doc.text(`Generado: ${new Date().toLocaleString('es-DO')}`, 14, 21);
    doc.setTextColor(30, 36, 53);
    return 28;
  }

  function tesPdfTable(doc, y, headers, rows, colWidths) {
    const pageW = 210, padL = 14, rowH = 7;
    doc.setFillColor(230, 250, 240);
    doc.rect(padL, y, pageW - padL * 2, rowH, 'F');
    doc.setFontSize(7); doc.setFont(undefined, 'bold'); doc.setTextColor(60, 100, 80);
    let x = padL;
    headers.forEach((h, i) => { doc.text(h, x + 2, y + 5); x += colWidths[i]; });
    y += rowH;
    doc.setFont(undefined, 'normal'); doc.setTextColor(30, 36, 53);
    rows.forEach((row, ri) => {
      if (y > 270) { doc.addPage(); y = 14; }
      if (ri % 2 === 0) { doc.setFillColor(248, 253, 250); doc.rect(padL, y, pageW - padL * 2, rowH, 'F'); }
      x = padL;
      row.forEach((cell, i) => { doc.text(String(cell ?? ''), x + 2, y + 5); x += colWidths[i]; });
      y += rowH;
    });
    doc.setDrawColor(200, 204, 220);
    doc.line(padL, y, pageW - padL, y);
    return y + 4;
  }

  function getJsPDFCtor() {
    if (typeof window.jspdf !== 'undefined' && window.jspdf.jsPDF) return window.jspdf.jsPDF;
    if (typeof window.jsPDF !== 'undefined') return window.jsPDF;
    return null;
  }

  window.tesoreriaExportBalancePDF = async function () {
    try {
      if (window.VendorLoader) await window.VendorLoader.load('jspdf');
      const jsPDFCtor = getJsPDFCtor();
      if (!jsPDFCtor) { toast('No se pudo cargar el generador de PDF.', 'error'); return; }
      const doc = new jsPDFCtor({ orientation: 'p', unit: 'mm', format: 'a4' });
      let y = tesPdfHeader(doc, 'Balance de Fondos');
      const rows = TES.funds.map((f) => [f.name, FUND_TYPE_LABELS[f.fundType] || f.fundType, f.branchId ? ((DB.sucursales || []).find((b) => Number(b.id) === Number(f.branchId))?.nombre || '—') : 'Corporativo', f.currency, money(f.currentBalance)]);
      y = tesPdfTable(doc, y, ['Fondo', 'Tipo', 'Sucursal', 'Moneda', 'Balance'], rows, [45, 35, 45, 20, 45]);
      y += 6;
      doc.setFont(undefined, 'bold'); doc.setFontSize(10);
      doc.text(`Balance total: ${money(TES.funds.reduce((s, f) => s + f.currentBalance, 0))}`, 14, y);
      doc.save(`Balance_Caja_General_${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (e) { toast(e.message || 'No se pudo generar el PDF.', 'error'); }
  };

  function getReportRange() {
    return { desde: el('tesoreria-rep-desde')?.value || '', hasta: el('tesoreria-rep-hasta')?.value || '' };
  }

  window.tesoreriaExportMovementsExcel = async function () {
    try {
      if (window.VendorLoader) await window.VendorLoader.load('xlsx');
      if (typeof window.XLSX === 'undefined') { toast('No se pudo cargar el generador de Excel.', 'error'); return; }
      const params = new URLSearchParams({ pageSize: '500' });
      if (TES.branchScope) params.set('branchId', TES.branchScope);
      const tipo = el('tesoreria-mov-tipo')?.value;
      const desde = el('tesoreria-mov-desde')?.value || getReportRange().desde;
      const hasta = el('tesoreria-mov-hasta')?.value || getReportRange().hasta;
      if (tipo) params.set('type', tipo);
      if (desde) params.set('desde', desde);
      if (hasta) params.set('hasta', hasta);
      const rows = await tesGet(`/api/tesoreria/movements?${params.toString()}`);
      const headers = ['Fecha', 'Tipo', 'Descripción', 'Monto', 'Método', 'Usuario', 'Estado'];
      const data = rows.map((m) => [
        (m.createdAt || '').replace('T', ' ').slice(0, 16), MOVEMENT_TYPE_LABELS[m.movementType] || m.movementType,
        m.description || '', m.amount, m.paymentMethod || '', m.createdByUserName || '', m.status,
      ]);
      const ws = window.XLSX.utils.aoa_to_sheet([headers, ...data]);
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, 'Movimientos');
      window.XLSX.writeFile(wb, `Movimientos_Caja_General_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) { toast(e.message || 'No se pudo generar el Excel.', 'error'); }
  };

  window.tesoreriaExportGastosCategoriaPDF = async function () {
    try {
      if (window.VendorLoader) await window.VendorLoader.load('jspdf');
      const jsPDFCtor = getJsPDFCtor();
      if (!jsPDFCtor) { toast('No se pudo cargar el generador de PDF.', 'error'); return; }
      const { desde, hasta } = getReportRange();
      const params = new URLSearchParams();
      if (TES.branchScope) params.set('branchId', TES.branchScope);
      if (desde) params.set('desde', desde);
      if (hasta) params.set('hasta', hasta);
      const rows = await tesGet(`/api/tesoreria/reports/gastos-por-categoria?${params.toString()}`);
      const doc = new jsPDFCtor({ orientation: 'p', unit: 'mm', format: 'a4' });
      let y = tesPdfHeader(doc, 'Gastos por Categoría');
      y = tesPdfTable(doc, y, ['Categoría', 'Total'], rows.map((r) => [r.name, money(r.total)]), [140, 45]);
      doc.save(`Gastos_por_Categoria_${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (e) { toast(e.message || 'No se pudo generar el PDF.', 'error'); }
  };

  window.tesoreriaExportPorSucursalPDF = async function () {
    try {
      if (window.VendorLoader) await window.VendorLoader.load('jspdf');
      const jsPDFCtor = getJsPDFCtor();
      if (!jsPDFCtor) { toast('No se pudo cargar el generador de PDF.', 'error'); return; }
      const { desde, hasta } = getReportRange();
      const params = new URLSearchParams();
      if (TES.branchScope) params.set('branchId', TES.branchScope);
      if (desde) params.set('desde', desde);
      if (hasta) params.set('hasta', hasta);
      const rows = await tesGet(`/api/tesoreria/reports/por-sucursal?${params.toString()}`);
      const doc = new jsPDFCtor({ orientation: 'p', unit: 'mm', format: 'a4' });
      let y = tesPdfHeader(doc, 'Gastos y Rentabilidad por Sucursal');
      y = tesPdfTable(doc, y,
        ['Sucursal', 'Ingresos', 'Gastos Directos', 'Gastos Distrib.', 'Gastos Total', 'Rentabilidad'],
        rows.map((r) => [r.branchName, money(r.ingresos), money(r.gastosDirectos), money(r.gastosDistribuidos), money(r.gastosTotal), money(r.rentabilidad)]),
        [40, 30, 30, 30, 25, 30]
      );
      doc.save(`Gastos_Rentabilidad_Sucursal_${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (e) { toast(e.message || 'No se pudo generar el PDF.', 'error'); }
  };

  window.tesoreriaExportCuentasPorPagarPDF = async function () {
    try {
      if (window.VendorLoader) await window.VendorLoader.load('jspdf');
      const jsPDFCtor = getJsPDFCtor();
      if (!jsPDFCtor) { toast('No se pudo cargar el generador de PDF.', 'error'); return; }
      const rows = await tesGet('/api/tesoreria/supplier-invoices/pending');
      const doc = new jsPDFCtor({ orientation: 'p', unit: 'mm', format: 'a4' });
      let y = tesPdfHeader(doc, 'Cuentas por Pagar a Suplidores');
      y = tesPdfTable(doc, y,
        ['Suplidor', 'Factura', 'Vence', 'Total', 'Pagado', 'Pendiente'],
        rows.map((r) => [r.supplier_name || `#${r.supplier_id}`, r.invoice_number || r.id, r.due_at || '—', money(r.total_amount), money(r.paid_amount), money(r.pending_amount)]),
        [40, 30, 25, 30, 30, 30]
      );
      doc.save(`Cuentas_por_Pagar_${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (e) { toast(e.message || 'No se pudo generar el PDF.', 'error'); }
  };

  // ── Impresión (reutiliza el mismo canal genérico HTML→impresora del corte
  //    de caja; no ESC/POS dedicado, pero respeta el ancho de papel configurado) ──

  window.tesoreriaPrintBalanceTermico = async function () {
    const paperWidth = String(DB.config?.receiptPaperSize || '80mm').toLowerCase();
    const currency = DB.config?.currency || 'RD$';
    const fmtN = (n) => `${currency} ${Number(n || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const funds = TES.funds || [];
    const total = funds.reduce((s, f) => s + Number(f.currentBalance || 0), 0);
    const branchName = (id) => (DB.sucursales || []).find((b) => Number(b.id) === Number(id))?.nombre || '—';

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Balance Caja General</title>
      <style>
        body{font-family:'Courier New',monospace;font-size:12px;margin:0;padding:12px;color:#000;background:#fff}
        h2{text-align:center;font-size:14px;margin:0 0 4px}
        .center{text-align:center}
        .sep{border-top:1px dashed #000;margin:6px 0}
        .row{display:flex;justify-content:space-between;margin:2px 0}
        .row.bold{font-weight:bold}
        .small{font-size:10px;color:#555}
        @media print{body{padding:4px}}
      </style></head><body>
      <h2>${DB.config?.businessName || 'Tecno Caja'}</h2>
      <p class="center small">BALANCE DE CAJA GENERAL</p>
      <div class="sep"></div>
      ${funds.map((f) => `<div class="row"><span>${f.name} (${f.branchId ? branchName(f.branchId) : 'Corporativo'})</span><span>${fmtN(f.currentBalance)}</span></div>`).join('')}
      <div class="sep"></div>
      <div class="row bold"><span>Total:</span><span>${fmtN(total)}</span></div>
      <div class="sep"></div>
      <p class="center small">${new Date().toLocaleString('es-DO')}</p>
      </body></html>`;

    if (window.novaDesktop?.printReceiptHtml) {
      await window.novaDesktop.printReceiptHtml(html, { paperSize: paperWidth || '80mm', mode: 'dialog' });
    } else {
      toast('La impresión solo está disponible en la app de escritorio.', 'warning');
    }
  };

  async function loadClosingsPending() {
    const tbody = el('tesoreria-closings-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="padding:1rem;text-align:center">Cargando…</td></tr>';
    try {
      const rows = await tesGet(`/api/tesoreria/closings/pending?${scopeQuery()}`);
      renderClosingsTable(rows);
    } catch (e) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="padding:1rem;color:var(--danger)">${e.message}</td></tr>`;
    }
  }

  function renderClosingsTable(rows) {
    const tbody = el('tesoreria-closings-tbody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="padding:1rem;text-align:center;color:var(--text3)">No hay cierres pendientes de transferir.</td></tr>';
      return;
    }
    const branchName = (id) => (DB.sucursales || []).find((b) => Number(b.id) === Number(id))?.nombre || '—';
    tbody.innerHTML = rows.map((s) => `
      <tr>
        <td>#${s.id}</td>
        <td>${branchName(s.branch_id)}</td>
        <td>${s.closed_by_user_name || '—'}</td>
        <td>${(s.closed_at || '').replace('T', ' ').slice(0, 16)}</td>
        <td>${money(s.counted_amount)}</td>
        <td>${money(s.difference_amount)}</td>
        <td><button class="btn-secondary compact-btn" onclick='tesoreriaOpenTransferModal(${JSON.stringify(s).replace(/'/g, "&#39;")})'>Transferir</button></td>
      </tr>
    `).join('');
  }

  // ── Transferencias entre sucursales pendientes de confirmar ─────────────

  async function loadBranchTransfersPending() {
    const tbody = el('tesoreria-branch-transfers-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="padding:1rem;text-align:center">Cargando…</td></tr>';
    try {
      const rows = await tesGet(`/api/tesoreria/branch-transfers/pending?${scopeQuery()}`);
      renderBranchTransfersTable(rows);
    } catch (e) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="padding:1rem;color:var(--danger)">${e.message}</td></tr>`;
    }
  }

  function renderBranchTransfersTable(rows) {
    const tbody = el('tesoreria-branch-transfers-tbody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="padding:1rem;text-align:center;color:var(--text3)">No hay transferencias pendientes de confirmar.</td></tr>';
      return;
    }
    const branchName = (id) => (DB.sucursales || []).find((b) => Number(b.id) === Number(id))?.nombre || '—';
    const canReceive = typeof currentUserCan === 'function' && currentUserCan('recibir_transferencias_caja_general');
    tbody.innerHTML = rows.map((t) => `
      <tr>
        <td>#${t.id}</td>
        <td>${branchName(t.fromBranchId)}</td>
        <td>${branchName(t.toBranchId)}</td>
        <td>${money(t.amount)}</td>
        <td>${t.sentByUserName || '—'}</td>
        <td>${(t.createdAt || '').replace('T', ' ').slice(0, 16)}</td>
        <td>${canReceive ? `
          <button class="btn-secondary compact-btn" onclick="tesoreriaConfirmBranchTransfer(${t.id}, ${t.toFundId || 'null'})">Confirmar</button>
          <button class="btn-danger-ghost compact-btn" onclick="tesoreriaRejectBranchTransfer(${t.id})">Rechazar</button>
        ` : ''}</td>
      </tr>
    `).join('');
  }

  window.tesoreriaConfirmBranchTransfer = function (transferId, toFundId) {
    if (toFundId) {
      tesApi('POST', `/api/tesoreria/branch-transfers/${transferId}/confirm`, { toFundId })
        .then(() => { toast('Transferencia confirmada.', 'success'); tesoreriaRefreshAll(); })
        .catch((e) => toast(e.message || 'No se pudo confirmar.', 'error'));
      return;
    }
    const body = `<div class="form-group"><label>Fondo de destino</label><select id="tes-branchconfirm-fund" class="form-input">${fundOptions()}</select></div>`;
    openModal('Confirmar recepción de transferencia', body, {
      confirmLabel: 'Confirmar',
      icon: '🏢', accent: '#2563eb',
      onConfirm: async () => {
        try {
          await tesApi('POST', `/api/tesoreria/branch-transfers/${transferId}/confirm`, { toFundId: el('tes-branchconfirm-fund')?.value });
          toast('Transferencia confirmada.', 'success');
          tesoreriaRefreshAll();
          return true;
        } catch (e) { toast(e.message || 'No se pudo confirmar.', 'error'); return false; }
      },
    });
  };

  window.tesoreriaRejectBranchTransfer = function (transferId) {
    const body = '<div class="form-group"><label>Motivo del rechazo</label><input type="text" id="tes-branchreject-reason" class="form-input"></div>';
    openModal('Rechazar transferencia', body, {
      confirmLabel: 'Rechazar',
      icon: '🚫', danger: true,
      onConfirm: async () => {
        const reason = el('tes-branchreject-reason')?.value || '';
        if (!reason) { toast('El motivo es requerido.', 'warning'); return false; }
        try {
          await tesApi('POST', `/api/tesoreria/branch-transfers/${transferId}/reject`, { reason });
          toast('Transferencia rechazada.', 'success');
          tesoreriaRefreshAll();
          return true;
        } catch (e) { toast(e.message || 'No se pudo rechazar.', 'error'); return false; }
      },
    });
  };

  // ── Movimientos pendientes de aprobación ────────────────────────────────

  async function loadApprovals() {
    const tbody = el('tesoreria-approvals-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="padding:1rem;text-align:center">Cargando…</td></tr>';
    try {
      const params = new URLSearchParams({ status: 'pendiente_aprobacion' });
      if (TES.branchScope) params.set('branchId', TES.branchScope);
      const rows = await tesGet(`/api/tesoreria/movements?${params.toString()}`);
      renderApprovalsTable(rows);
    } catch (e) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="padding:1rem;color:var(--danger)">${e.message}</td></tr>`;
    }
  }

  function renderApprovalsTable(rows) {
    const tbody = el('tesoreria-approvals-tbody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="padding:1rem;text-align:center;color:var(--text3)">No hay movimientos pendientes de aprobación.</td></tr>';
      return;
    }
    const canApprove = typeof currentUserCan === 'function' && currentUserCan('aprobar_movimientos_caja_general');
    const canReject = typeof currentUserCan === 'function' && currentUserCan('rechazar_movimientos_caja_general');
    tbody.innerHTML = rows.map((m) => `
      <tr>
        <td>${(m.createdAt || '').replace('T', ' ').slice(0, 16)}</td>
        <td>${MOVEMENT_TYPE_LABELS[m.movementType] || m.movementType}</td>
        <td>${m.description || ''}</td>
        <td>${money(m.amount)}</td>
        <td>${m.createdByUserName || '—'}</td>
        <td>
          ${canApprove ? `<button class="btn-secondary compact-btn" onclick="tesoreriaApproveMovement(${m.id})">Aprobar</button>` : ''}
          ${canReject ? `<button class="btn-danger-ghost compact-btn" onclick="tesoreriaRejectMovement(${m.id})">Rechazar</button>` : ''}
        </td>
      </tr>
    `).join('');
  }

  window.tesoreriaApproveMovement = async function (movementId) {
    try {
      await tesApi('POST', `/api/tesoreria/movements/${movementId}/approve`, {});
      toast('Movimiento aprobado.', 'success');
      tesoreriaRefreshAll();
    } catch (e) { toast(e.message || 'No se pudo aprobar.', 'error'); }
  };

  window.tesoreriaRejectMovement = function (movementId) {
    const body = '<div class="form-group"><label>Motivo del rechazo</label><input type="text" id="tes-mov-reject-reason" class="form-input"></div>';
    openModal('Rechazar movimiento', body, {
      confirmLabel: 'Rechazar',
      icon: '🚫', danger: true,
      onConfirm: async () => {
        const reason = el('tes-mov-reject-reason')?.value || '';
        if (!reason) { toast('El motivo es requerido.', 'warning'); return false; }
        try {
          await tesApi('POST', `/api/tesoreria/movements/${movementId}/reject`, { reason });
          toast('Movimiento rechazado.', 'success');
          tesoreriaRefreshAll();
          return true;
        } catch (e) { toast(e.message || 'No se pudo rechazar.', 'error'); return false; }
      },
    });
  };

  // ── Ventas del día (reporte automático al cerrar la última caja del día) ─

  let TES_DAILY_CLOSINGS = [];

  async function loadDailyClosings() {
    const tbody = el('tesoreria-daily-closings-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="padding:1rem;text-align:center">Cargando…</td></tr>';
    try {
      TES_DAILY_CLOSINGS = await tesGet(`/api/tesoreria/daily-closings?${scopeQuery()}`);
      renderDailyClosingsTable(TES_DAILY_CLOSINGS);
    } catch (e) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="padding:1rem;color:var(--danger)">${e.message}</td></tr>`;
    }
  }

  function renderDailyClosingsTable(rows) {
    const tbody = el('tesoreria-daily-closings-tbody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="padding:1rem;text-align:center;color:var(--text3)">Todavía no se ha generado ningún cierre de día (se crea solo al cerrar la última caja del día).</td></tr>';
      return;
    }
    const branchName = (id) => (DB.sucursales || []).find((b) => Number(b.id) === Number(id))?.nombre || '—';
    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td>${r.operativeDate}</td>
        <td>${branchName(r.branchId)}</td>
        <td>${r.cashSessionsCount}</td>
        <td>${r.totalFacturas}</td>
        <td>${money(r.totalVentas)}</td>
        <td>${money(r.totalGastos)}</td>
        <td><a href="#" onclick="tesoreriaShowDailyClosingDetail(${r.id});return false;">Ver detalle</a></td>
      </tr>
    `).join('');
  }

  window.tesoreriaShowDailyClosingDetail = function (id) {
    const r = TES_DAILY_CLOSINGS.find((row) => row.id === id);
    if (!r) return;
    const rows = r.vendorBreakdown.map((v) => `
      <tr>
        <td>${v.nombre}</td><td>${v.facturas}</td><td>${money(v.total)}</td>
        <td>${money(v.efectivo)}</td><td>${money(v.tarjeta)}</td><td>${money(v.transferencia)}</td><td>${money(v.credito)}</td>
      </tr>
    `).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text3)">Sin ventas registradas.</td></tr>';
    const body = `
      <div class="tes-section-label">Resumen del día ${r.operativeDate}</div>
      <div class="reportes-grid" style="margin-bottom:1rem">
        <div class="tes-stat-card" style="--stat-color:var(--tes-accent)"><span class="tes-stat-icon">🧾</span><div class="tes-stat-label">Facturas</div><div class="tes-stat-val">${r.totalFacturas}</div></div>
        <div class="tes-stat-card" style="--stat-color:#16a34a"><span class="tes-stat-icon">💰</span><div class="tes-stat-label">Total Ventas</div><div class="tes-stat-val">${money(r.totalVentas)}</div></div>
        <div class="tes-stat-card" style="--stat-color:var(--danger)"><span class="tes-stat-icon">📕</span><div class="tes-stat-label">Gastos</div><div class="tes-stat-val">${money(r.totalGastos)}</div></div>
      </div>
      <div class="tes-section-label">Por vendedor</div>
      <div class="repv2-table-wrap">
        <table class="repv2-table">
          <thead><tr><th>Vendedor</th><th>Facturas</th><th>Total</th><th>Efectivo</th><th>Tarjeta</th><th>Transferencia</th><th>Crédito</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
    openModal(`Ventas del día — ${r.operativeDate}`, body, { icon: '📊', confirmLabel: 'Cerrar', hideCancel: true, onConfirm: async () => true });
  };

  // ── Modal genérico ────────────────────────────────────────────────────

  // accent: color hex/var para el icono y el botón de confirmar; icon: emoji del badge circular.
  function openModal(title, bodyHtml, { confirmLabel = 'Guardar', onConfirm, accent = 'var(--tes-accent)', icon = '💰', danger = false, hideCancel = false } = {}) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.zIndex = '9999';
    const confirmBg = danger ? 'var(--danger)' : accent;
    overlay.innerHTML = `
      <div class="modal-card tes-modal-card" style="width:500px;max-width:96vw" data-modal-accent="${accent}">
        <div class="modal-card-header">
          <span class="tes-modal-icon-badge" style="--modal-accent:${accent}22;color:${accent}">${icon}</span>
          <h3 style="margin:0">${title}</h3>
          <button type="button" class="modal-card-close" id="tes-modal-close">✕</button>
        </div>
        <div class="modal-card-body" id="tes-modal-body">${bodyHtml}</div>
        <div class="modal-card-footer">
          ${hideCancel ? '' : '<button id="tes-modal-cancel" class="btn-secondary">Cancelar</button>'}
          <button id="tes-modal-confirm" class="btn-primary" style="background:${confirmBg};border-color:${confirmBg}">${confirmLabel}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => document.body.contains(overlay) && document.body.removeChild(overlay);
    overlay.querySelector('#tes-modal-close').addEventListener('click', close);
    overlay.querySelector('#tes-modal-cancel')?.addEventListener('click', close);
    overlay.querySelector('#tes-modal-confirm').addEventListener('click', async () => {
      const ok = await onConfirm(overlay, close);
      if (ok) close();
    });
    return overlay;
  }

  function fundOptions(filterFn) {
    return TES.funds.filter(filterFn || (() => true)).map((f) =>
      `<option value="${f.id}">${f.name} (${FUND_TYPE_LABELS[f.fundType] || f.fundType} · ${money(f.currentBalance)})</option>`
    ).join('') || '<option value="">-- No hay fondos, crea uno primero --</option>';
  }

  function categoryOptions(kind) {
    return '<option value="">Sin categoría</option>' + TES.categories.filter((c) => c.kind === kind)
      .map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
  }

  // ── Registrar ingreso / gasto / retiro del propietario ────────────────

  window.tesoreriaOpenMovementModal = function (movementType) {
    const isIncome = movementType === 'ingreso';
    const isWithdrawal = movementType === 'retiro_propietario';
    const needsPassword = movementType === 'gasto' || isWithdrawal;
    const title = isIncome ? 'Registrar Ingreso' : isWithdrawal ? 'Retiro del Propietario' : 'Registrar Gasto';
    const modalIcon = isIncome ? '➕' : isWithdrawal ? '🏦' : '➖';
    const modalAccent = isIncome ? 'var(--tes-accent)' : isWithdrawal ? '#7c3aed' : 'var(--danger)';
    const fundLabel = isIncome ? 'Fondo de destino' : 'Fondo de origen';
    const fundOpts = fundOptions();
    const catOpts = categoryOptions(isIncome ? 'ingreso' : 'gasto');
    const canDistribute = movementType === 'gasto' && typeof currentUserCan === 'function' && (currentUserCan('ver_todas_sucursales_caja_general') || currentUserCan('*'));
    const branches = DB.sucursales || [];

    const body = `
      <div class="tes-section-label">Datos del movimiento</div>
      <div class="form-group"><label>Monto</label><input type="number" id="tes-mov-amount" class="form-input" min="0.01" step="0.01" placeholder="0.00"></div>
      <div class="form-group"><label>${fundLabel}</label><select id="tes-mov-fund" class="form-input">${fundOpts}</select></div>
      <div class="form-group"><label>Categoría</label><select id="tes-mov-category" class="form-input">${catOpts}</select></div>
      <div class="form-group"><label>Descripción</label><input type="text" id="tes-mov-desc" class="form-input" placeholder="Detalle del movimiento"></div>

      <div class="tes-section-label">Detalles adicionales (opcional)</div>
      <div class="form-group"><label>Beneficiario</label><input type="text" id="tes-mov-beneficiario" class="form-input" placeholder="Nombre de suplidor, empleado, etc."></div>
      <div class="form-group"><label>Referencia de comprobante</label><input type="text" id="tes-mov-doc" class="form-input" placeholder="No. de factura, URL, etc."></div>
      ${needsPassword ? '<div class="tes-section-label">Autorización</div><div class="form-group"><label>Tu contraseña de inicio de sesión</label><input type="password" id="tes-mov-password" class="form-input"></div>' : ''}
      ${canDistribute ? `
        <div class="tes-section-label">Distribución entre sucursales</div>
        <div class="form-group"><label class="checkbox-label"><input type="checkbox" id="tes-mov-distribute" onchange="tesoreriaToggleDistribution()"> Distribuir este gasto entre varias sucursales (gasto corporativo)</label></div>
        <div id="tes-mov-distribution-wrap" class="hidden">
          <small class="helper-text" style="display:block;margin-bottom:0.5rem">Indica el % de cada sucursal (debe sumar 100%).</small>
          ${branches.map((b) => `
            <div class="form-group" style="display:flex;gap:0.5rem;align-items:center">
              <label style="flex:1;margin:0">${b.nombre}</label>
              <input type="number" class="form-input tes-dist-pct" data-branch-id="${b.id}" placeholder="%" min="0" max="100" step="0.01" style="width:90px">
            </div>
          `).join('')}
        </div>
      ` : ''}
    `;

    openModal(title, body, {
      confirmLabel: 'Registrar',
      icon: modalIcon, accent: modalAccent,
      onConfirm: async () => {
        const amount = Number(el('tes-mov-amount')?.value || 0);
        const fundId = el('tes-mov-fund')?.value;
        if (!amount || amount <= 0) { toast('Ingresa un monto válido.', 'warning'); return false; }
        if (!fundId) { toast('Selecciona un fondo.', 'warning'); return false; }
        const payload = {
          amount,
          categoryId: el('tes-mov-category')?.value || null,
          description: el('tes-mov-desc')?.value || '',
          beneficiarioNombre: el('tes-mov-beneficiario')?.value || '',
          documentReference: el('tes-mov-doc')?.value || '',
          branchId: TES.branchScope || null,
        };
        if (canDistribute && el('tes-mov-distribute')?.checked) {
          const distribution = Array.from(document.querySelectorAll('.tes-dist-pct'))
            .map((input) => ({ branchId: Number(input.dataset.branchId), percentage: Number(input.value || 0) }))
            .filter((d) => d.percentage > 0);
          if (!distribution.length) { toast('Ingresa al menos un porcentaje de distribución.', 'warning'); return false; }
          const totalPct = distribution.reduce((s, d) => s + d.percentage, 0);
          if (Math.abs(totalPct - 100) > 0.5) { toast(`Los porcentajes deben sumar 100% (suman ${totalPct}%).`, 'warning'); return false; }
          payload.distribution = distribution;
          payload.distributionMethod = 'porcentaje';
          delete payload.branchId;
        }
        try {
          if (isIncome) {
            payload.fundDestinationId = fundId;
            await tesApi('POST', '/api/tesoreria/income', payload);
          } else {
            payload.fundOriginId = fundId;
            payload.movementType = movementType;
            payload.password = el('tes-mov-password')?.value || '';
            await tesApi('POST', '/api/tesoreria/expense', payload);
          }
          toast('Movimiento registrado.', 'success');
          tesoreriaRefreshAll();
          return true;
        } catch (e) { toast(e.message || 'No se pudo registrar el movimiento.', 'error'); return false; }
      },
    });
  };

  window.tesoreriaToggleDistribution = function () {
    const checked = !!el('tes-mov-distribute')?.checked;
    el('tes-mov-distribution-wrap')?.classList.toggle('hidden', !checked);
  };

  // ── Anular movimiento ──────────────────────────────────────────────────

  window.tesoreriaVoidMovement = function (movementId) {
    const body = `
      <div class="form-group"><label>Motivo de la anulación</label><input type="text" id="tes-void-reason" class="form-input" placeholder="Explica por qué se anula"></div>
      <div class="form-group"><label>Tu contraseña de inicio de sesión</label><input type="password" id="tes-void-password" class="form-input"></div>
    `;
    openModal('Anular movimiento', body, {
      confirmLabel: 'Anular',
      icon: '🗑️', danger: true,
      onConfirm: async () => {
        const reason = el('tes-void-reason')?.value || '';
        const password = el('tes-void-password')?.value || '';
        if (!reason) { toast('El motivo es requerido.', 'warning'); return false; }
        try {
          await tesApi('POST', `/api/tesoreria/movements/${movementId}/void`, { reason, password });
          toast('Movimiento anulado.', 'success');
          tesoreriaRefreshAll();
          return true;
        } catch (e) { toast(e.message || 'No se pudo anular.', 'error'); return false; }
      },
    });
  };

  // ── Nuevo fondo ─────────────────────────────────────────────────────────

  window.tesoreriaOpenNewFundModal = function () {
    const branches = DB.sucursales || [];
    const body = `
      <div class="form-group"><label>Nombre</label><input type="text" id="tes-fund-name" class="form-input" placeholder="Ej: Efectivo Sucursal Principal"></div>
      <div class="form-group"><label>Tipo de fondo</label>
        <select id="tes-fund-type" class="form-input">${Object.entries(FUND_TYPE_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      </div>
      <div class="form-group"><label>Sucursal</label>
        <select id="tes-fund-branch" class="form-input">
          <option value="">Corporativo (todas las sucursales)</option>
          ${branches.map((b) => `<option value="${b.id}">${b.nombre}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>Moneda</label>
        <select id="tes-fund-currency" class="form-input"><option value="DOP">DOP</option><option value="USD">USD</option></select>
      </div>
      <div class="form-group"><label class="checkbox-label"><input type="checkbox" id="tes-fund-default"> Fondo predeterminado de este tipo (usado por la transferencia automática de cierres)</label></div>
    `;
    openModal('Nuevo Fondo', body, {
      confirmLabel: 'Crear',
      icon: '🗂️',
      onConfirm: async () => {
        const name = el('tes-fund-name')?.value || '';
        if (!name) { toast('El nombre es requerido.', 'warning'); return false; }
        try {
          await tesApi('POST', '/api/tesoreria/funds', {
            name,
            fundType: el('tes-fund-type')?.value,
            branchId: el('tes-fund-branch')?.value || null,
            currency: el('tes-fund-currency')?.value,
            isDefaultForType: !!el('tes-fund-default')?.checked,
          });
          toast('Fondo creado.', 'success');
          loadFunds();
          return true;
        } catch (e) { toast(e.message || 'No se pudo crear el fondo.', 'error'); return false; }
      },
    });
  };

  // ── Transferencia entre fondos (misma sucursal) ─────────────────────────

  window.tesoreriaOpenFundTransferModal = function () {
    const body = `
      <div class="form-group"><label>Fondo de origen</label><select id="tes-ft-origin" class="form-input">${fundOptions()}</select></div>
      <div class="form-group"><label>Fondo de destino</label><select id="tes-ft-dest" class="form-input">${fundOptions()}</select></div>
      <div class="form-group"><label>Monto</label><input type="number" id="tes-ft-amount" class="form-input" min="0.01" step="0.01"></div>
      <div class="form-group"><label>Descripción (opcional)</label><input type="text" id="tes-ft-desc" class="form-input"></div>
    `;
    openModal('Transferir entre Fondos', body, {
      confirmLabel: 'Transferir',
      icon: '🔁', accent: '#2563eb',
      onConfirm: async () => {
        const originId = el('tes-ft-origin')?.value;
        const destId = el('tes-ft-dest')?.value;
        const amount = Number(el('tes-ft-amount')?.value || 0);
        if (!amount || amount <= 0) { toast('Ingresa un monto válido.', 'warning'); return false; }
        if (!originId || !destId) { toast('Selecciona ambos fondos.', 'warning'); return false; }
        if (originId === destId) { toast('El fondo de origen y destino no pueden ser el mismo.', 'warning'); return false; }
        try {
          await tesApi('POST', '/api/tesoreria/fund-transfers', { fundOriginId: originId, fundDestinationId: destId, amount, description: el('tes-ft-desc')?.value || '' });
          toast('Transferencia realizada.', 'success');
          tesoreriaRefreshAll();
          return true;
        } catch (e) { toast(e.message || 'No se pudo transferir.', 'error'); return false; }
      },
    });
  };

  // ── Transferencia entre sucursales ──────────────────────────────────────

  window.tesoreriaOpenBranchTransferModal = function () {
    const branches = DB.sucursales || [];
    const branchOpts = branches.map((b) => `<option value="${b.id}">${b.nombre}</option>`).join('');
    const body = `
      <div class="form-group"><label>Sucursal de origen</label><select id="tes-bt-from-branch" class="form-input" onchange="tesoreriaBranchTransferFromBranchChanged()">${branchOpts}</select></div>
      <div class="form-group"><label>Fondo de origen</label><select id="tes-bt-from-fund" class="form-input">${fundOptions()}</select></div>
      <div class="form-group"><label>Sucursal de destino</label><select id="tes-bt-to-branch" class="form-input">${branchOpts}</select></div>
      <div class="form-group"><label>Monto</label><input type="number" id="tes-bt-amount" class="form-input" min="0.01" step="0.01"></div>
      <div class="form-group"><label>Observación (opcional)</label><input type="text" id="tes-bt-obs" class="form-input"></div>
      <div class="form-group"><label>Tu contraseña de inicio de sesión</label><input type="password" id="tes-bt-password" class="form-input"></div>
    `;
    openModal('Transferir a otra Sucursal', body, {
      confirmLabel: 'Transferir',
      icon: '🏢', accent: '#2563eb',
      onConfirm: async () => {
        const fromBranchId = el('tes-bt-from-branch')?.value;
        const toBranchId = el('tes-bt-to-branch')?.value;
        const fromFundId = el('tes-bt-from-fund')?.value;
        const amount = Number(el('tes-bt-amount')?.value || 0);
        if (!amount || amount <= 0) { toast('Ingresa un monto válido.', 'warning'); return false; }
        if (!fromBranchId || !toBranchId || fromBranchId === toBranchId) { toast('Selecciona sucursales de origen y destino distintas.', 'warning'); return false; }
        try {
          await tesApi('POST', '/api/tesoreria/branch-transfers', {
            fromBranchId, toBranchId, fromFundId, amount,
            observaciones: el('tes-bt-obs')?.value || '', password: el('tes-bt-password')?.value || '',
          });
          toast('Transferencia enviada. Queda pendiente hasta que la sucursal destino confirme la recepción.', 'success');
          tesoreriaRefreshAll();
          return true;
        } catch (e) { toast(e.message || 'No se pudo enviar la transferencia.', 'error'); return false; }
      },
    });
  };
  // Nota: no se filtran los fondos por sucursal en el select (lista completa) para
  // mantener el modal simple; el backend valida que el fondo de origen exista.
  window.tesoreriaBranchTransferFromBranchChanged = function () {};

  // ── Pago a suplidor ──────────────────────────────────────────────────────

  window.tesoreriaOpenSupplierPaymentModal = async function () {
    let invoices = [];
    try { invoices = await tesGet('/api/tesoreria/supplier-invoices/pending'); }
    catch (e) { toast(e.message || 'No se pudieron cargar las facturas pendientes.', 'error'); return; }
    if (!invoices.length) { toast('No hay facturas de suplidores pendientes.', 'warning'); return; }
    const invoiceOpts = invoices.map((i) => `<option value="${i.id}" data-pending="${i.pending_amount}" data-supplier="${i.supplier_id}" data-supplier-name="${i.supplier_name || ''}">${i.supplier_name || 'Suplidor #' + i.supplier_id} · Factura ${i.invoice_number || i.id} · Pendiente ${money(i.pending_amount)}</option>`).join('');
    const body = `
      <div class="form-group"><label>Factura pendiente</label><select id="tes-sp-invoice" class="form-input">${invoiceOpts}</select></div>
      <div class="form-group"><label>Monto a pagar</label><input type="number" id="tes-sp-amount" class="form-input" min="0.01" step="0.01"></div>
      <div class="form-group"><label>Fondo de origen</label><select id="tes-sp-fund" class="form-input">${fundOptions()}</select></div>
      <div class="form-group"><label>Método de pago</label>
        <select id="tes-sp-method" class="form-input"><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option><option value="cheque">Cheque</option></select>
      </div>
      <div class="form-group"><label>Observación (opcional)</label><input type="text" id="tes-sp-obs" class="form-input"></div>
      <div class="form-group"><label>Tu contraseña de inicio de sesión (si aplica)</label><input type="password" id="tes-sp-password" class="form-input"></div>
    `;
    openModal('Pagar Suplidor', body, {
      confirmLabel: 'Pagar',
      icon: '🧾', accent: '#d97706',
      onConfirm: async () => {
        const invoiceSelect = el('tes-sp-invoice');
        const opt = invoiceSelect?.selectedOptions?.[0];
        const amount = Number(el('tes-sp-amount')?.value || 0);
        if (!amount || amount <= 0) { toast('Ingresa un monto válido.', 'warning'); return false; }
        if (!el('tes-sp-fund')?.value) { toast('Selecciona el fondo de origen.', 'warning'); return false; }
        try {
          await tesApi('POST', '/api/tesoreria/supplier-payments', {
            supplierInvoiceId: invoiceSelect?.value, amount, fundOriginId: el('tes-sp-fund')?.value,
            paymentMethod: el('tes-sp-method')?.value, observaciones: el('tes-sp-obs')?.value || '',
            password: el('tes-sp-password')?.value || '', supplierName: opt?.dataset?.supplierName || '',
          });
          toast('Pago a suplidor registrado.', 'success');
          tesoreriaRefreshAll();
          return true;
        } catch (e) { toast(e.message || 'No se pudo registrar el pago.', 'error'); return false; }
      },
    });
  };

  // ── Pago a empleado ──────────────────────────────────────────────────────

  window.tesoreriaOpenEmployeePaymentModal = async function () {
    let employees = [];
    try { employees = await tesGet('/api/tesoreria/employees'); }
    catch (e) { toast(e.message || 'No se pudieron cargar los empleados.', 'error'); return; }
    if (!employees.length) { toast('No hay empleados activos registrados en RRHH.', 'warning'); return; }
    const employeeOpts = employees.map((emp) => `<option value="${emp.id}">${emp.nombre}${emp.cargo ? ` · ${emp.cargo}` : ''}</option>`).join('');
    const body = `
      <div class="form-group"><label>Empleado</label><select id="tes-ep-employee" class="form-input">${employeeOpts}</select></div>
      <div class="form-group"><label>Concepto</label>
        <select id="tes-ep-concept" class="form-input">
          <option value="salario">Salario</option><option value="adelanto">Adelanto</option><option value="bono">Bonificación</option>
          <option value="comision">Comisión</option><option value="viaticos">Viáticos</option><option value="otro">Otro</option>
        </select>
      </div>
      <div class="form-group"><label>Monto</label><input type="number" id="tes-ep-amount" class="form-input" min="0.01" step="0.01"></div>
      <div class="form-group"><label>Fondo de origen</label><select id="tes-ep-fund" class="form-input">${fundOptions()}</select></div>
      <div class="form-group"><label>Observación (opcional)</label><input type="text" id="tes-ep-obs" class="form-input"></div>
      <div class="form-group"><label>Tu contraseña de inicio de sesión (si aplica)</label><input type="password" id="tes-ep-password" class="form-input"></div>
    `;
    openModal('Pagar Empleado', body, {
      confirmLabel: 'Pagar',
      icon: '👤', accent: '#0891b2',
      onConfirm: async () => {
        const amount = Number(el('tes-ep-amount')?.value || 0);
        if (!amount || amount <= 0) { toast('Ingresa un monto válido.', 'warning'); return false; }
        if (!el('tes-ep-fund')?.value) { toast('Selecciona el fondo de origen.', 'warning'); return false; }
        try {
          await tesApi('POST', '/api/tesoreria/employee-payments', {
            employeeId: el('tes-ep-employee')?.value, concept: el('tes-ep-concept')?.value, amount,
            fundOriginId: el('tes-ep-fund')?.value, observaciones: el('tes-ep-obs')?.value || '', password: el('tes-ep-password')?.value || '',
          });
          toast('Pago a empleado registrado.', 'success');
          tesoreriaRefreshAll();
          return true;
        } catch (e) { toast(e.message || 'No se pudo registrar el pago.', 'error'); return false; }
      },
    });
  };

  // ── Transferencia manual desde un cierre de caja ──────────────────────

  function normalizeClosingSource(source) {
    if (!source) return null;
    if (source.cashSessionId !== undefined) {
      return {
        cashSessionId: source.cashSessionId,
        efectivo: Number(source.efectivo || 0),
        tarjeta: Number(source.tarjeta || 0),
        transferencia: Number(source.transferencia || 0),
        counted: Number(source.contado || 0),
        difference: Number(source.diferencia || 0),
      };
    }
    return {
      cashSessionId: source.id,
      efectivo: Number(source.counted_amount || 0),
      tarjeta: 0,
      transferencia: 0,
      counted: Number(source.counted_amount || 0),
      difference: Number(source.difference_amount || 0),
    };
  }

  window.tesoreriaOpenTransferModal = function (source) {
    const closing = normalizeClosingSource(source);
    if (!closing || !closing.cashSessionId) { toast('No se pudo determinar el cierre a transferir.', 'error'); return; }
    if (!TES.unlocked) { toast('Abre Caja General (Reportes) al menos una vez para cargar los fondos disponibles.', 'warning'); return; }

    const body = `
      <p class="helper-text" style="margin:0 0 1rem">Cierre #${closing.cashSessionId} · Contado ${money(closing.counted)} · Diferencia ${money(closing.difference)}</p>
      <div class="form-group"><label>Efectivo entregado</label><input type="number" id="tes-tr-efectivo" class="form-input" step="0.01" value="${closing.efectivo.toFixed(2)}"></div>
      <div class="form-group"><label>Fondo destino (efectivo)</label><select id="tes-tr-fund-efectivo" class="form-input">${fundOptions((f) => f.fundType === 'efectivo')}</select></div>
      <div class="form-group"><label>Tarjeta</label><input type="number" id="tes-tr-tarjeta" class="form-input" step="0.01" value="${closing.tarjeta.toFixed(2)}"></div>
      <div class="form-group"><label>Fondo destino (tarjeta)</label><select id="tes-tr-fund-tarjeta" class="form-input">${fundOptions((f) => f.fundType.startsWith('tarjetas'))}</select></div>
      <div class="form-group"><label>Transferencia</label><input type="number" id="tes-tr-transferencia" class="form-input" step="0.01" value="${closing.transferencia.toFixed(2)}"></div>
      <div class="form-group"><label>Fondo destino (transferencia)</label><select id="tes-tr-fund-transferencia" class="form-input">${fundOptions((f) => f.fundType === 'banco' || f.fundType === 'transferencias')}</select></div>
      <div class="form-group"><label>Fondo retenido en caja (para el próximo turno)</label><input type="number" id="tes-tr-retenido" class="form-input" step="0.01" value="0.00"></div>
      <div class="form-group"><label>Observación</label><input type="text" id="tes-tr-obs" class="form-input"></div>
      <div class="form-group"><label>Tu contraseña de inicio de sesión</label><input type="password" id="tes-tr-password" class="form-input"></div>
    `;

    openModal('Transferir a Caja General', body, {
      confirmLabel: 'Transferir',
      icon: '↗️',
      onConfirm: async () => {
        const payload = {
          efectivoEntregado: Number(el('tes-tr-efectivo')?.value || 0),
          fundEfectivoId: el('tes-tr-fund-efectivo')?.value || null,
          tarjeta: Number(el('tes-tr-tarjeta')?.value || 0),
          fundTarjetaId: el('tes-tr-fund-tarjeta')?.value || null,
          transferencia: Number(el('tes-tr-transferencia')?.value || 0),
          fundTransferenciaId: el('tes-tr-fund-transferencia')?.value || null,
          fondoRetenido: Number(el('tes-tr-retenido')?.value || 0),
          observaciones: el('tes-tr-obs')?.value || '',
          password: el('tes-tr-password')?.value || '',
        };
        try {
          await tesApi('POST', `/api/tesoreria/closings/${closing.cashSessionId}/transfer`, payload);
          toast('Cierre transferido a Caja General.', 'success');
          el('btn-transferir-caja-general')?.classList.add('hidden');
          tesoreriaRefreshAll();
          return true;
        } catch (e) { toast(e.message || 'No se pudo transferir el cierre.', 'error'); return false; }
      },
    });
  };
})();
