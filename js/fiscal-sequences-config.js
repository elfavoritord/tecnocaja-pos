// ══════════════════════════════════════════════════════════════
//  NCF Authorized Sequences Config Module — Tecno Caja (Fase 1)
//  Administración de NCF: registro manual de rangos autorizados
//  por la DGII (reemplaza el panel legacy en js/ncf-config.js,
//  que se deja sin usar como referencia hasta confirmar en vivo).
//  Prefijo ncfAuthSeq/ncf-auth-seq- a propósito: js/fiscal-ecf.js
//  (panel de e-CF) ya usaba loadFiscalSequences/fiscal-seq-list/
//  fiscal-seq-branch/fiscal-seq-desde/fiscal-seq-hasta — no
//  reutilizar esos nombres o uno de los dos scripts pisa al otro.
// ══════════════════════════════════════════════════════════════

const NCF_AUTH_SEQ_DOCUMENT_LABELS = {
  B01: 'Crédito Fiscal', B02: 'Consumidor Final', B03: 'Nota de Débito', B04: 'Nota de Crédito',
  B11: 'Comprobante de Compras', B12: 'Registro Único de Ingresos', B13: 'Gastos Menores',
  B14: 'Régimen Especial', B15: 'Gubernamental', B16: 'Comprobante para Exportaciones',
  B17: 'Comprobante para Pagos al Exterior',
};

const NCF_AUTH_SEQ_STATUS_META = {
  activo: { label: 'Activo', color: '#22c55e' },
  proximo_agotarse: { label: 'Por agotarse', color: '#f59e0b' },
  agotado: { label: 'Agotado', color: '#ef4444' },
  vencido: { label: 'Vencido', color: '#ef4444' },
  suspendido: { label: 'Suspendido', color: '#6b7280' },
  pendiente: { label: 'Pendiente de activar', color: '#6b7280' },
  legacy_unverified: { label: 'Migrada — por confirmar', color: '#3b82f6' },
};

let ncfAuthSeqExpandedHistoryId = null;
let ncfAuthSeqHistoryCache = {};

async function ncfAuthSeqApiGet(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${DB.authToken || ''}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error de servidor');
  return data;
}

async function ncfAuthSeqApiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken || ''}` },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error de servidor');
  return data;
}

async function ncfAuthSeqApiPut(url, body) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken || ''}` },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error de servidor');
  return data;
}

async function ncfAuthSeqApiDelete(url, body) {
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken || ''}` },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error de servidor');
  return data;
}

function ncfAuthSeqFormatNumber(n) {
  return Number(n || 0).toLocaleString('es-DO');
}

function ncfAuthSeqFormatDate(iso) {
  if (!iso) return '—';
  try { return new Date(String(iso).slice(0, 10) + 'T00:00:00').toLocaleDateString('es-DO'); } catch (_) { return iso; }
}

async function loadNcfAuthSequences() {
  const container = document.getElementById('ncf-auth-seq-list');
  if (!container) return;
  container.innerHTML = '<div class="loading-text">Cargando…</div>';
  try {
    // Solo NCF tradicional serie B — la facturación electrónica (e-CF, serie
    // E) tiene su propia pantalla dedicada (Configuración → e-CF · DGII) con
    // su propio flujo de certificación/firma/envío. Mezclarlas aquí solo
    // confundía qué secuencia corresponde a qué sistema.
    const rows = await ncfAuthSeqApiGet('/api/fiscal-sequences');
    if (!rows.length) {
      container.innerHTML = `
        <div class="empty-state-small" style="padding:0.8rem;text-align:center;color:var(--text3)">
          No hay secuencias registradas aún. Agrega una abajo con el rango real autorizado por la DGII.
        </div>`;
      return;
    }
    container.innerHTML = `
      <table class="compact-table" style="width:100%;font-size:0.8rem">
        <thead><tr>
          <th>Tipo</th><th>Rango</th><th>Próximo</th><th>Usados</th><th>Disponibles</th>
          <th>%</th><th>Vence</th><th>Sucursal</th><th>Estado</th><th></th>
        </tr></thead>
        <tbody>
          ${rows.map(ncfAuthSeqRenderRow).join('')}
        </tbody>
      </table>`;
  } catch (e) {
    container.innerHTML = `<div class="error-text">Error al cargar: ${e.message}</div>`;
  }
}

function ncfAuthSeqRenderRow(r) {
  const meta = NCF_AUTH_SEQ_STATUS_META[r.effectiveStatus] || NCF_AUTH_SEQ_STATUS_META[r.status] || { label: r.status, color: '#6b7280' };
  const label = r.documentName || NCF_AUTH_SEQ_DOCUMENT_LABELS[r.documentType] || r.documentType;
  const rango = `${r.documentType}${String(r.startNumber).padStart(8, '0')}–${r.documentType}${String(r.endNumber).padStart(8, '0')}`;
  const actions = ncfAuthSeqRenderActions(r);
  const historyRow = ncfAuthSeqExpandedHistoryId === r.id ? ncfAuthSeqRenderHistoryRow(r) : '';
  return `<tr>
      <td><strong style="color:var(--accent)" title="${label}">${r.documentType}</strong></td>
      <td style="font-size:0.72rem">${rango}</td>
      <td>${ncfAuthSeqFormatNumber(r.nextNumber)}</td>
      <td>${ncfAuthSeqFormatNumber(r.totalUsed)}</td>
      <td>${ncfAuthSeqFormatNumber(r.totalAvailable)}</td>
      <td>${r.percentUsed}%</td>
      <td>${ncfAuthSeqFormatDate(r.expirationDate)}</td>
      <td>${r.branchName || 'Global'}</td>
      <td><span style="display:inline-block;padding:0.1rem 0.5rem;border-radius:999px;font-size:0.7rem;font-weight:600;color:#fff;background:${meta.color}">${meta.label}</span></td>
      <td style="white-space:nowrap">${actions}</td>
    </tr>${historyRow}`;
}

function ncfAuthSeqRenderActions(r) {
  const canActivate = r.status === 'pendiente' || r.status === 'legacy_unverified';
  const canSuspend = r.status === 'activo';
  return `
    <div style="display:flex;gap:0.25rem;flex-wrap:wrap">
      ${canActivate ? `<button class="btn-xs btn-primary" type="button" onclick="ncfAuthSeqActivate(${r.id})" title="Activar">▶</button>` : ''}
      ${canSuspend ? `<button class="btn-xs" type="button" onclick="ncfAuthSeqSuspend(${r.id})" title="Suspender">⏸</button>` : ''}
      <button class="btn-xs" type="button" onclick="ncfAuthSeqChangeNextNumber(${r.id})" title="Cambiar próximo número">✎</button>
      <label class="btn-xs" style="cursor:pointer" title="Adjuntar documento de autorización">
        📎<input type="file" accept=".pdf,.xml,.csv,.xls,.xlsx,image/*" style="display:none" onchange="ncfAuthSeqUploadAttachment(${r.id}, this)">
      </label>
      ${r.authorizationFileUrl ? `<a class="btn-xs" href="${r.authorizationFileUrl}" target="_blank" title="Ver documento">📄</a>` : ''}
      <button class="btn-xs" type="button" onclick="ncfAuthSeqToggleHistory(${r.id})" title="Ver historial">🕘</button>
      <button class="btn-xs btn-danger" type="button" onclick="ncfAuthSeqDelete(${r.id})" title="Eliminar (solo si nunca se usó)">🗑</button>
    </div>`;
}

function ncfAuthSeqRenderHistoryRow(r) {
  const entries = ncfAuthSeqHistoryCache[r.id] || [];
  const body = entries.length
    ? entries.map((h) => `<div style="padding:0.3rem 0;border-bottom:1px solid var(--border)">
        <strong>${h.action}</strong> — ${h.userName || 'Sistema'} — ${new Date(h.createdAt).toLocaleString('es-DO')}
        ${h.reason ? `<div style="color:var(--text3)">Motivo: ${h.reason}</div>` : ''}
      </div>`).join('')
    : '<div class="helper-text">Sin historial todavía.</div>';
  return `<tr><td colspan="10" style="background:var(--bg2);padding:0.5rem 0.8rem">${body}</td></tr>`;
}

async function ncfAuthSeqToggleHistory(id) {
  if (ncfAuthSeqExpandedHistoryId === id) {
    ncfAuthSeqExpandedHistoryId = null;
    loadNcfAuthSequences();
    return;
  }
  try {
    ncfAuthSeqHistoryCache[id] = await ncfAuthSeqApiGet(`/api/fiscal-sequences/${id}/history`);
    ncfAuthSeqExpandedHistoryId = id;
    loadNcfAuthSequences();
  } catch (e) {
    showToast('Error al cargar historial: ' + e.message, 'error');
  }
}

async function ncfAuthSeqActivate(id) {
  try {
    await ncfAuthSeqApiPost(`/api/fiscal-sequences/${id}/activate`, {});
    showToast('Secuencia activada.', 'success');
    loadNcfAuthSequences();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function ncfAuthSeqSuspend(id) {
  const reason = await showPromptModal('Motivo de la suspensión:');
  if (!reason || !reason.trim()) return;
  try {
    await ncfAuthSeqApiPost(`/api/fiscal-sequences/${id}/suspend`, { reason: reason.trim() });
    showToast('Secuencia suspendida.', 'success');
    loadNcfAuthSequences();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function ncfAuthSeqChangeNextNumber(id) {
  const newNumber = await showPromptModal('Nuevo próximo número (debe estar dentro del rango autorizado):', { inputType: 'number' });
  if (!newNumber) return;
  const reason = await showPromptModal('Motivo del cambio (obligatorio):');
  if (!reason || !reason.trim()) { showToast('Debes indicar un motivo.', 'warning'); return; }
  const password = await showPromptModal('Confirma tu contraseña de acceso:', { inputType: 'password' });
  if (!password) return;
  try {
    await ncfAuthSeqApiPost(`/api/fiscal-sequences/${id}/change-next-number`, {
      newNumber: Number(newNumber), reason: reason.trim(), password,
    });
    showToast('Próximo número actualizado y registrado en auditoría.', 'success');
    loadNcfAuthSequences();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function ncfAuthSeqUploadAttachment(id, inputEl) {
  const file = inputEl.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await ncfAuthSeqApiPost(`/api/fiscal-sequences/${id}/attachment`, { fileData: reader.result });
      showToast('Documento adjuntado.', 'success');
      loadNcfAuthSequences();
    } catch (e) {
      showToast('Error al adjuntar: ' + e.message, 'error');
    }
  };
  reader.readAsDataURL(file);
}

async function ncfAuthSeqDelete(id) {
  if (!await showDeleteConfirm('¿Eliminar esta secuencia?')) return;
  try {
    await ncfAuthSeqApiDelete(`/api/fiscal-sequences/${id}`, {});
    showToast('Secuencia eliminada.', 'success');
    loadNcfAuthSequences();
  } catch (e) {
    // El servidor bloquea eliminar una secuencia con NCF ya usados. Ofrecer
    // forzar: no borra las ventas emitidas, solo quita la secuencia de la lista.
    if (/ya fue utilizada/i.test(e.message || '')) {
      const ok = await showDeleteConfirm(
        'Esta secuencia ya tiene NCF usados. ¿Eliminarla de todas formas?\n\n'
        + 'No se borran las ventas ya emitidas con esos NCF; solo se quita la secuencia de la lista.'
      );
      if (!ok) return;
      try {
        await ncfAuthSeqApiDelete(`/api/fiscal-sequences/${id}`, { force: true });
        showToast('Secuencia eliminada.', 'success');
        loadNcfAuthSequences();
      } catch (e2) {
        showToast('Error: ' + e2.message, 'error');
      }
      return;
    }
    showToast('Error: ' + e.message, 'error');
  }
}

async function saveNcfAuthSequence() {
  const documentType = document.getElementById('ncf-auth-seq-type')?.value;
  const branchId = document.getElementById('ncf-auth-seq-branch')?.value || null;
  const startNumber = parseInt(document.getElementById('ncf-auth-seq-desde')?.value, 10) || 1;
  const endNumber = parseInt(document.getElementById('ncf-auth-seq-hasta')?.value, 10);
  const authorizationDate = document.getElementById('ncf-auth-seq-fecha-autorizacion')?.value || null;
  const expirationDate = document.getElementById('ncf-auth-seq-vencimiento')?.value || null;
  const authorizationReference = document.getElementById('ncf-auth-seq-referencia')?.value || '';
  const rncConfirmed = document.getElementById('ncf-auth-seq-rnc-confirm')?.checked;
  const notes = document.getElementById('ncf-auth-seq-notas')?.value || '';
  const fileInput = document.getElementById('ncf-auth-seq-file');

  if (!documentType) { showToast('Selecciona el tipo de comprobante.', 'warning'); return; }
  if (!endNumber || endNumber < startNumber) { showToast('El número final debe ser mayor o igual al inicial.', 'warning'); return; }
  if (!authorizationReference.trim()) { showToast('Indica la referencia de autorización de la DGII.', 'warning'); return; }
  if (!rncConfirmed) { showToast('Confirma que el RNC de esta autorización corresponde a tu empresa.', 'warning'); return; }

  try {
    const created = await ncfAuthSeqApiPost('/api/fiscal-sequences', {
      documentType, branchId: branchId || null, startNumber, endNumber,
      authorizationDate, expirationDate, authorizationReference: authorizationReference.trim(),
      notes: notes.trim(),
    });

    const file = fileInput?.files?.[0];
    if (file) {
      await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            await ncfAuthSeqApiPost(`/api/fiscal-sequences/${created.id}/attachment`, { fileData: reader.result });
            resolve();
          } catch (err) { reject(err); }
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      }).catch((e) => showToast('Secuencia creada, pero falló adjuntar el documento: ' + e.message, 'warning'));
    }

    showToast('Secuencia registrada. Actívala cuando confirmes los datos.', 'success');
    const details = document.querySelector('#cfg-ncf-section details');
    if (details) details.open = false;
    loadNcfAuthSequences();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// Aplica ahora mismo cualquier secuencia NCF que el contador haya registrado
// desde su Portal — normalmente se aplica sola en el próximo abrir/cerrar
// caja o venta (server/sync/apply-pending-ncf.js), este botón es solo para
// no tener que esperar. Mismo patrón de deshabilitar/reactivar que
// syncAllUsersFirebase() en js/clientes.js.
async function ncfAuthSeqSyncContador() {
  const btn = document.getElementById('ncf-auth-seq-sync-btn');
  const origText = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Sincronizando...'; }
  try {
    const result = await ncfAuthSeqApiPost('/api/fiscal-sequences/sync-contador', {});
    const msg = `${result.applied || 0} secuencia(s) aplicada(s)` + (result.failed ? `, ${result.failed} con error` : '');
    showToast(msg, result.failed ? 'warning' : 'success');
    loadNcfAuthSequences();
  } catch (e) {
    showToast('Error al sincronizar con tu contador: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = origText; }
  }
}

async function initNcfAuthSeqBranchSelect() {
  const sel = document.getElementById('ncf-auth-seq-branch');
  if (!sel) return;
  try {
    const branches = await ncfAuthSeqApiGet('/api/branches');
    sel.innerHTML = '<option value="">Global (todas las sucursales)</option>' +
      (branches || []).map((b) => `<option value="${b.id}">${b.nombre}</option>`).join('');
  } catch (_) { /* no bloquea el formulario si falla */ }
}

document.addEventListener('DOMContentLoaded', () => {
  const details = document.querySelector('#cfg-ncf-section details');
  if (details) {
    details.addEventListener('toggle', () => {
      if (details.open) initNcfAuthSeqBranchSelect();
    });
  }
});
