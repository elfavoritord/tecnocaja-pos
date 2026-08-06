'use strict';

const SystemHealth = (() => {
  let lastReport = null;

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtMoney(value) {
    const n = Number(value || 0);
    return `RD$ ${n.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function statusColor(status) {
    if (status === 'ok') return '#10b981';
    if (status === 'warning') return '#f59e0b';
    return '#ef4444';
  }

  function statusText(status) {
    if (status === 'ok') return 'Todo bien';
    if (status === 'warning') return 'Revisar';
    return 'Error';
  }

  async function collectLocalPeripherals() {
    const local = {
      electron: Boolean(window.novaDesktop),
      printersAvailable: null,
      savedLocalPeripherals: window.LocalPeripheralsFlat || {},
    };
    try {
      if (window.novaDesktop?.listPrinters) {
        const result = await window.novaDesktop.listPrinters();
        local.printersAvailable = Array.isArray(result?.printers) ? result.printers : [];
      }
    } catch (error) {
      local.printerError = error.message || String(error);
    }
    return local;
  }

  function mergeLocalChecks(report, local) {
    const checks = [...(report.checks || [])];
    const printers = local.printersAvailable;
    const savedPrinter = String(
      local.savedLocalPeripherals?.receiptPrinterName || report.config?.receiptPrinterName || ''
    ).trim();
    const savedDrawerPrinter = String(
      local.savedLocalPeripherals?.cashDrawerPrinterName || report.config?.cashDrawerPrinterName || savedPrinter
    ).trim();

    if (Array.isArray(printers)) {
      const printerExists = !savedPrinter || printers.some((p) => p.name === savedPrinter);
      checks.push({
        id: 'windows_printer',
        label: 'Impresora en Windows',
        status: printerExists ? 'ok' : 'error',
        detail: savedPrinter
          ? (printerExists ? `Windows reconoce "${savedPrinter}".` : `Windows no encontró "${savedPrinter}". Selecciónala de nuevo.`)
          : 'Sin impresora fija; se usará la predeterminada.',
      });

      if (report.config?.cashDrawerEnabled || local.savedLocalPeripherals?.cashDrawerEnabled) {
        const drawerExists = !savedDrawerPrinter || printers.some((p) => p.name === savedDrawerPrinter);
        checks.push({
          id: 'windows_drawer_printer',
          label: 'Caja vía impresora',
          status: drawerExists ? 'ok' : 'error',
          detail: savedDrawerPrinter
            ? (drawerExists ? `La impresora de gaveta existe: "${savedDrawerPrinter}".` : `La impresora de gaveta "${savedDrawerPrinter}" no aparece en Windows.`)
            : 'La caja está activa, pero no tiene impresora asignada.',
        });
      }
    } else if (local.printerError) {
      checks.push({
        id: 'windows_printer',
        label: 'Impresora en Windows',
        status: 'warning',
        detail: `No se pudo leer la lista de impresoras: ${local.printerError}`,
      });
    }

    return { ...report, checks, local };
  }

  function renderSummary(report) {
    const dot = document.getElementById('health-summary-dot');
    const text = document.getElementById('health-summary-text');
    const checked = document.getElementById('health-checked-at');
    if (!dot || !text) return;

    const hasError = report.checks.some((c) => c.status === 'error');
    const hasWarn = report.checks.some((c) => c.status === 'warning');
    const status = hasError ? 'error' : hasWarn ? 'warning' : 'ok';
    dot.style.background = statusColor(status);
    text.textContent = status === 'ok'
      ? 'Sistema saludable'
      : status === 'warning'
        ? 'Sistema funcionando con observaciones'
        : 'Sistema requiere atención';
    if (checked) checked.textContent = report.checkedAt ? `Actualizado: ${new Date(report.checkedAt).toLocaleString('es-DO')}` : '';
  }

  function renderChecks(report) {
    const grid = document.getElementById('health-checks-grid');
    if (!grid) return;
    grid.innerHTML = (report.checks || []).map((check) => `
      <div style="background:var(--card-bg,#1e2535);border:1px solid var(--border,#2d3748);border-left:4px solid ${statusColor(check.status)};border-radius:8px;padding:11px 12px;min-height:96px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px">
          <strong style="font-size:.88rem;color:var(--text1,#f1f5f9)">${esc(check.label)}</strong>
          <span style="font-size:.72rem;font-weight:800;color:${statusColor(check.status)}">${statusText(check.status)}</span>
        </div>
        <div style="font-size:.78rem;color:var(--text2,#94a3b8);line-height:1.45">${esc(check.detail)}</div>
      </div>
    `).join('');
  }

  function renderBranches(report) {
    const wrap = document.getElementById('health-branches-table');
    if (!wrap) return;
    const branches = report.branches || [];
    if (!branches.length) {
      wrap.innerHTML = '<div style="padding:10px;color:var(--text3)">No hay sucursales registradas.</div>';
      return;
    }
    wrap.innerHTML = `
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="color:var(--text3,#64748b);font-size:.72rem;text-transform:uppercase">
            <th style="text-align:left;padding:7px;border-bottom:1px solid var(--border)">Sucursal</th>
            <th style="text-align:right;padding:7px;border-bottom:1px solid var(--border)">Cajas</th>
            <th style="text-align:right;padding:7px;border-bottom:1px solid var(--border)">Abiertas</th>
            <th style="text-align:right;padding:7px;border-bottom:1px solid var(--border)">Ventas hoy</th>
            <th style="text-align:right;padding:7px;border-bottom:1px solid var(--border)">Pend.</th>
          </tr>
        </thead>
        <tbody>
          ${branches.map((b) => `
            <tr>
              <td style="padding:8px 7px;border-bottom:1px solid var(--border);color:var(--text1,#f1f5f9)">
                <strong>${esc(b.nombre)}</strong>
                ${b.codigo ? `<span style="color:var(--text3);font-size:.72rem"> ${esc(b.codigo)}</span>` : ''}
                <div style="color:var(--text3);font-size:.72rem">${esc(b.estado || 'Activa')}</div>
              </td>
              <td style="text-align:right;padding:8px 7px;border-bottom:1px solid var(--border)">${Number(b.cashRegisters || 0)}</td>
              <td style="text-align:right;padding:8px 7px;border-bottom:1px solid var(--border);color:${Number(b.openSessions || 0) > 0 ? '#10b981' : 'var(--text3)'}">${Number(b.openSessions || 0)}</td>
              <td style="text-align:right;padding:8px 7px;border-bottom:1px solid var(--border)">${Number(b.salesToday || 0)}<br><span style="font-size:.72rem;color:var(--text3)">${fmtMoney(b.amountToday)}</span></td>
              <td style="text-align:right;padding:8px 7px;border-bottom:1px solid var(--border);color:${Number(b.pendingOffline || 0) > 0 ? '#f59e0b' : '#10b981'}">${Number(b.pendingOffline || 0)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function renderRecommendations(report) {
    const wrap = document.getElementById('health-recommendations');
    if (!wrap) return;
    const recommendations = [
      ...(report.recommendations || []),
      ...(report.checks || []).filter((c) => c.status !== 'ok').map((c) => c.detail),
    ];
    const unique = [...new Set(recommendations.filter(Boolean))].slice(0, 8);
    wrap.innerHTML = unique.length
      ? `<ul style="margin:0;padding-left:18px">${unique.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`
      : '<span style="color:#10b981">No hay acciones pendientes.</span>';
  }

  function render(report) {
    renderSummary(report);
    renderChecks(report);
    renderBranches(report);
    renderRecommendations(report);
  }

  async function load() {
    const summary = document.getElementById('health-summary-text');
    if (summary) summary.textContent = 'Actualizando...';
    try {
      const [report, local] = await Promise.all([
        fetch('/api/diagnostics/health').then((r) => r.json()),
        collectLocalPeripherals(),
      ]);
      if (!report.ok) throw new Error(report.error || 'No se pudo leer salud del sistema.');
      lastReport = mergeLocalChecks(report, local);
      render(lastReport);
      return lastReport;
    } catch (error) {
      if (summary) summary.textContent = `Error: ${error.message}`;
      if (typeof showToast === 'function') showToast('No se pudo cargar el centro de salud: ' + error.message, 'error');
      return null;
    }
  }

  async function forceSync() {
    try {
      await fetch('/api/sync/now', { method: 'POST' });
      if (typeof showToast === 'function') showToast('Sincronización iniciada.', 'info');
      setTimeout(load, 1500);
    } catch (error) {
      if (typeof showToast === 'function') showToast('No se pudo iniciar sync: ' + error.message, 'error');
    }
  }

  async function exportDiagnostic() {
    const report = lastReport || await load();
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tecnocaja-diagnostico-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    if (typeof showToast === 'function') showToast('Diagnóstico exportado.', 'success');
  }

  document.addEventListener('tecnocaja:config-opened', () => {
    setTimeout(load, 350);
  });

  return {
    load,
    forceSync,
    export: exportDiagnostic,
  };
})();

window.SystemHealth = SystemHealth;
