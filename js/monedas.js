// ===== TECNO_CAJA - CONFIGURACIÓN DE MONEDAS (Fase 1 multi-moneda USD/DOP) =====

function monedasLocale() {
  return typeof getCurrentLocale === 'function' ? getCurrentLocale() : 'es-DO';
}

function fmtMonedasFecha(v) {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d) ? String(v) : d.toLocaleString(monedasLocale());
}

function fmtMonedasTasa(v) {
  return v !== null && v !== undefined ? Number(v).toFixed(4) : '—';
}

async function loadMonedasModule() {
  try {
    const [current, history] = await Promise.all([
      api.request('/api/currency/exchange-rate'),
      api.request('/api/currency/exchange-rate/history?limit=100'),
    ]);
    renderMonedasCurrentRate(current);
    renderMonedasHistory(history?.items || []);
  } catch (err) {
    showToast('No se pudo cargar la configuración de monedas: ' + (err?.message || 'error'), 'error');
  }
}

function renderMonedasCurrentRate(current) {
  const card = document.getElementById('monedas-current-rate-card');
  if (card) {
    const rate = current?.rate;
    card.innerHTML = rate
      ? `<strong>Tipo de cambio actual: 1 USD = RD$ ${fmtMonedasTasa(rate)}</strong>
         <small>Última actualización: ${fmtMonedasFecha(current.updatedAt)} por ${current.updatedByUserName || 'Sistema'}</small>`
      : `<strong>Sin tipo de cambio configurado todavía.</strong><small>Se define automáticamente al abrir caja.</small>`;
  }

  // Solo un administrador general puede cambiar la tasa desde aquí — el resto
  // de los roles solo puede consultar la tarjeta y el historial.
  const section = document.getElementById('monedas-cambiar-tasa-section');
  if (section) {
    const isAdmin = getCurrentUserRoleCode() === 'administrador_general';
    section.style.display = isAdmin ? '' : 'none';
  }
}

function renderMonedasHistory(items) {
  const tbody = document.getElementById('monedas-history-tbody');
  if (!tbody) return;
  const sourceLabels = { cash_open: 'Apertura de caja', manual: 'Cambio manual' };
  tbody.innerHTML = items.map((row) => `
    <tr>
      <td>${fmtMonedasFecha(row.created_at)}</td>
      <td>${row.changed_by_user_name || 'Sistema'}</td>
      <td>${sourceLabels[row.source] || row.source}</td>
      <td>${fmtMonedasTasa(row.previous_rate)}</td>
      <td>${fmtMonedasTasa(row.new_rate)}</td>
      <td>${row.change_reason || '—'}</td>
    </tr>
  `).join('') || `<tr><td colspan="6" style="text-align:center;color:var(--text3)">Sin cambios registrados.</td></tr>`;
}

async function submitExchangeRateChange() {
  const rateInput = document.getElementById('monedas-nueva-tasa');
  const reasonInput = document.getElementById('monedas-motivo-cambio');
  const rate = Number(rateInput?.value || 0);
  const reason = reasonInput?.value?.trim() || '';
  if (!Number.isFinite(rate) || rate <= 0) {
    showToast('Indica un valor de tasa válido.', 'error');
    return;
  }
  try {
    await api.request('/api/currency/exchange-rate', {
      method: 'PUT',
      body: JSON.stringify({ rate, reason, ...getActorPayload() })
    });
    showToast('Tipo de cambio actualizado.', 'success');
    if (rateInput) rateInput.value = '';
    if (reasonInput) reasonInput.value = '';
    if (DB.config) DB.config.exchangeRateUsdDop = rate;
    await loadMonedasModule();
  } catch (err) {
    showToast(err?.message || 'No se pudo actualizar el tipo de cambio.', 'error');
  }
}
