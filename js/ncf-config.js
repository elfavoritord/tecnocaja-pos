// ══════════════════════════════════════════════════════════════
//  NCF Config Module — Tecno Caja
//  Manages NCF sequence configuration panel in Configuración
// ══════════════════════════════════════════════════════════════

const NCF_TYPE_LABELS = {
  B01: 'Crédito Fiscal',
  B02: 'Consumidor Final',
  B03: 'Nota de Débito',
  B04: 'Nota de Crédito',
  B14: 'Régimen Especial',
  B15: 'Gubernamental'
};

async function loadNcfSequences() {
  const container = document.getElementById('ncf-seq-list');
  if (!container) return;
  container.innerHTML = '<div class="loading-text">Cargando…</div>';
  try {
    const rows = await apiGet('/api/ncf/sequences');
    if (!rows.length) {
      container.innerHTML = `
        <div class="empty-state-small" style="padding:0.8rem;text-align:center;color:var(--text3)">
          No hay secuencias configuradas aún. Agrega una abajo.
        </div>`;
      return;
    }
    container.innerHTML = `
      <table class="compact-table" style="width:100%;font-size:0.82rem">
        <thead><tr>
          <th>Tipo</th><th>Descripción</th><th>Sucursal</th>
          <th>Siguiente</th><th>Máximo</th><th>Restantes</th><th>Estado</th><th></th>
        </tr></thead>
        <tbody>
          ${rows.map(r => {
            const restantes = r.maximo - r.siguienteNumero + 1;
            const pct = Math.max(0, (restantes / r.maximo) * 100);
            const alertCls = pct < 10 ? 'color:#e53e3e;font-weight:700' : pct < 25 ? 'color:#dd6b20' : '';
            return `<tr>
              <td><strong style="color:var(--accent)">${r.ncfType}</strong></td>
              <td>${NCF_TYPE_LABELS[r.ncfType] || r.ncfType}</td>
              <td>${r.branchName || 'Global'}</td>
              <td>${r.siguienteNumero.toLocaleString()}</td>
              <td>${r.maximo.toLocaleString()}</td>
              <td style="${alertCls}">${restantes > 0 ? restantes.toLocaleString() : '⚠ Agotada'}</td>
              <td><span class="badge-${r.activa ? 'green' : 'gray'}" style="font-size:0.7rem">${r.activa ? 'Activa' : 'Inactiva'}</span></td>
              <td>
                <button class="btn-xs btn-danger" type="button" onclick="deleteNcfSequence(${r.id})" title="Eliminar">🗑</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  } catch (e) {
    container.innerHTML = `<div class="error-text">Error al cargar: ${e.message}</div>`;
  }
}

async function saveNcfSequence() {
  const ncfType = document.getElementById('ncf-seq-type')?.value;
  const branchId = document.getElementById('ncf-seq-branch')?.value || null;
  const desde = parseInt(document.getElementById('ncf-seq-desde')?.value) || 1;
  const hasta = parseInt(document.getElementById('ncf-seq-hasta')?.value) || 99999999;
  if (!ncfType) { showToast('Selecciona el tipo de NCF.', 'warning'); return; }
  if (hasta < desde) { showToast('El límite máximo debe ser mayor al número inicial.', 'warning'); return; }
  try {
    await apiPost('/api/ncf/sequences', { ncfType, branchId: branchId || null, siguienteNumero: desde, maximo: hasta, activa: true });
    showToast('Secuencia guardada correctamente.', 'success');
    // Close the details and reload list
    const details = document.querySelector('#cfg-ncf-section details');
    if (details) details.open = false;
    loadNcfSequences();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function deleteNcfSequence(id) {
  if (!confirm('¿Eliminar esta secuencia? Esta acción no se puede deshacer.')) return;
  try {
    const resp = await fetch(`/api/ncf/sequences/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${DB.authToken || ''}` }
    });
    const data = await resp.json();
    if (data.ok) { showToast('Secuencia eliminada.', 'success'); loadNcfSequences(); }
    else showToast(data.error || 'Error al eliminar.', 'error');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// Populate the branch selector in the add form
async function initNcfBranchSelect() {
  const sel = document.getElementById('ncf-seq-branch');
  if (!sel) return;
  try {
    const branches = await apiGet('/api/branches');
    sel.innerHTML = '<option value="">Global (todas las sucursales)</option>' +
      (branches || []).map(b => `<option value="${b.id}">${b.nombre}</option>`).join('');
  } catch (_) {}
}

// Helper: generic GET with auth
async function apiGet(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${DB.authToken || ''}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error de servidor');
  return data;
}

// Helper: generic POST with auth
async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken || ''}` },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error de servidor');
  return data;
}

// Auto-init branch select when config module is shown
document.addEventListener('DOMContentLoaded', () => {
  const details = document.querySelector('#cfg-ncf-section details');
  if (details) {
    details.addEventListener('toggle', () => {
      if (details.open) initNcfBranchSelect();
    });
  }
});
