'use strict';

/**
 * superadmin.js — Panel SuperAdmin de Tecno Caja
 * Solo visible cuando roleCode === 'superadmin'
 */

window.superAdminPanel = (() => {
  let _token = () => (typeof window.getTecnoCajaAuthToken === 'function' ? window.getTecnoCajaAuthToken() : '') || '';

  async function apiFetch(path, opts = {}) {
    const res = await fetch('/api/superadmin' + path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + _token(),
        ...(opts.headers || {})
      },
      body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  }

  // ── Activar panel ─────────────────────────────────────────────────────────
  function activate() {
    document.getElementById('app')?.classList.add('hidden');
    document.getElementById('login-screen')?.classList.add('hidden');
    document.getElementById('setup-screen')?.classList.add('hidden');
    const panel = document.getElementById('superadmin-panel');
    if (panel) { panel.classList.remove('hidden'); panel.style.display = ''; }
    loadDashboard();
    showSection('sa-dashboard');
  }

  function logout() {
    document.getElementById('superadmin-panel')?.classList.add('hidden');
    if (typeof window.clearTecnoCajaAuthToken === 'function') window.clearTecnoCajaAuthToken();
    window.location.reload();
  }

  // ── Secciones ─────────────────────────────────────────────────────────────
  function showSection(id) {
    document.querySelectorAll('.sa-section').forEach(s => s.classList.add('hidden'));
    document.getElementById(id)?.classList.remove('hidden');
    document.querySelectorAll('.sa-nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.sa-nav-btn[data-section="${id}"]`)?.classList.add('active');

    if (id === 'sa-contadores') loadContadores();
    if (id === 'sa-negocios') loadNegocios();
    if (id === 'sa-solicitudes') loadSolicitudes();
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────
  async function loadDashboard() {
    try {
      const d = await apiFetch('/dashboard');
      const t = d.totales;
      document.getElementById('sa-stat-contadores').textContent = t.contadores;
      document.getElementById('sa-stat-negocios').textContent = t.negocios;
      document.getElementById('sa-stat-activas').textContent = t.activas;
      document.getElementById('sa-stat-prueba').textContent = t.prueba;
      document.getElementById('sa-stat-pendientes').textContent = t.pendientes;
      document.getElementById('sa-stat-solicitudes').textContent = t.solicitudesPendientes;

      const tbody = document.getElementById('sa-recent-negocios');
      if (tbody) {
        tbody.innerHTML = (d.ultimosNegocios || []).map(b => `
          <tr>
            <td>${esc(b.nombre_negocio)}</td>
            <td>${esc(b.contador_nombre || '—')}</td>
            <td><span class="sa-badge sa-badge-${b.license_status}">${b.license_status}</span></td>
            <td>${esc(b.plan)}</td>
            <td>${fmtDate(b.created_at)}</td>
          </tr>
        `).join('');
      }
    } catch (e) {
      showToastSA('Error al cargar dashboard: ' + e.message, 'error');
    }
  }

  // ── Contadores ─────────────────────────────────────────────────────────────
  let _contadores = [];

  async function loadContadores() {
    try {
      _contadores = await apiFetch('/contadores');
      renderContadores();
    } catch (e) {
      showToastSA('Error al cargar contadores: ' + e.message, 'error');
    }
  }

  function renderContadores() {
    const tbody = document.getElementById('sa-contadores-tbody');
    if (!tbody) return;
    tbody.innerHTML = _contadores.map(c => `
      <tr>
        <td>${esc(c.nombre_firma)}</td>
        <td>${esc(c.responsable || '—')}</td>
        <td>${esc(c.correo || '—')}</td>
        <td>${esc(c.telefono || '—')}</td>
        <td>${c.total_clientes || 0} <small>(${c.clientes_activos || 0} activos)</small></td>
        <td><span class="sa-badge sa-badge-${c.estado}">${c.estado}</span></td>
        <td class="sa-actions">
          <button onclick="superAdminPanel.editContador(${c.id})" class="sa-btn-sm">Editar</button>
          ${c.estado === 'activo'
            ? `<button onclick="superAdminPanel.suspenderContador(${c.id})" class="sa-btn-sm sa-btn-warn">Suspender</button>`
            : `<button onclick="superAdminPanel.reactivarContador(${c.id})" class="sa-btn-sm sa-btn-ok">Reactivar</button>`
          }
          <button onclick="superAdminPanel.deleteContador(${c.id}, '${esc(c.nombre_firma)}')" class="sa-btn-sm sa-btn-danger">Eliminar</button>
        </td>
      </tr>
    `).join('') || '<tr><td colspan="7" class="sa-empty">No hay contadores registrados.</td></tr>';
  }

  function openNewContadorForm() {
    document.getElementById('sa-contador-form-id').value = '';
    document.getElementById('sa-contador-nombre-firma').value = '';
    document.getElementById('sa-contador-responsable').value = '';
    document.getElementById('sa-contador-rnc').value = '';
    document.getElementById('sa-contador-telefono').value = '';
    document.getElementById('sa-contador-correo').value = '';
    document.getElementById('sa-contador-usuario').value = '';
    document.getElementById('sa-contador-password').value = '';
    document.getElementById('sa-contador-password-row').style.display = '';
    document.getElementById('sa-contador-usuario-row').style.display = '';
    document.getElementById('sa-contador-modal-title').textContent = 'Nuevo Contador';
    document.getElementById('sa-contador-modal').classList.remove('hidden');
  }

  function editContador(id) {
    const c = _contadores.find(x => x.id === id);
    if (!c) return;
    document.getElementById('sa-contador-form-id').value = id;
    document.getElementById('sa-contador-nombre-firma').value = c.nombre_firma;
    document.getElementById('sa-contador-responsable').value = c.responsable || '';
    document.getElementById('sa-contador-rnc').value = c.rnc || '';
    document.getElementById('sa-contador-telefono').value = c.telefono || '';
    document.getElementById('sa-contador-correo').value = c.correo || '';
    document.getElementById('sa-contador-password-row').style.display = 'none';
    document.getElementById('sa-contador-usuario-row').style.display = 'none';
    document.getElementById('sa-contador-modal-title').textContent = 'Editar Contador';
    document.getElementById('sa-contador-modal').classList.remove('hidden');
  }

  function closeContadorModal() {
    document.getElementById('sa-contador-modal').classList.add('hidden');
  }

  async function saveContador() {
    const id = document.getElementById('sa-contador-form-id').value;
    const body = {
      nombre_firma: document.getElementById('sa-contador-nombre-firma').value.trim(),
      responsable:  document.getElementById('sa-contador-responsable').value.trim(),
      rnc:          document.getElementById('sa-contador-rnc').value.trim(),
      telefono:     document.getElementById('sa-contador-telefono').value.trim(),
      correo:       document.getElementById('sa-contador-correo').value.trim(),
    };
    if (!body.nombre_firma) return alert('El nombre de la firma es requerido.');

    try {
      if (id) {
        await apiFetch(`/contadores/${id}`, { method: 'PUT', body });
        showToastSA('Contador actualizado.', 'ok');
      } else {
        body.usuario  = document.getElementById('sa-contador-usuario').value.trim();
        body.password = document.getElementById('sa-contador-password').value;
        if (!body.usuario || !body.password) return alert('Usuario y contraseña son requeridos.');
        await apiFetch('/contadores', { method: 'POST', body });
        showToastSA('Contador creado exitosamente.', 'ok');
      }
      closeContadorModal();
      loadContadores();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  }

  async function suspenderContador(id) {
    if (!await showDeleteConfirm('¿Suspender este contador? El usuario no podrá iniciar sesión.', { confirmText: 'Suspender' })) return;
    try {
      await apiFetch(`/contadores/${id}/suspender`, { method: 'POST' });
      showToastSA('Contador suspendido.', 'ok');
      loadContadores();
    } catch (e) { alert('Error: ' + e.message); }
  }

  async function reactivarContador(id) {
    try {
      await apiFetch(`/contadores/${id}/reactivar`, { method: 'POST' });
      showToastSA('Contador reactivado.', 'ok');
      loadContadores();
    } catch (e) { alert('Error: ' + e.message); }
  }

  async function deleteContador(id, nombre) {
    if (!await showDeleteConfirm(`¿Eliminar permanentemente al contador <strong>${nombre}</strong>? Esta acción no se puede deshacer.`)) return;
    try {
      await apiFetch(`/contadores/${id}`, { method: 'DELETE' });
      showToastSA('Contador eliminado.', 'ok');
      loadContadores();
    } catch (e) { alert('Error: ' + e.message); }
  }

  // ── Negocios ───────────────────────────────────────────────────────────────
  let _negocios = [];

  async function loadNegocios() {
    try {
      _negocios = await apiFetch('/negocios');
      renderNegocios();
    } catch (e) {
      showToastSA('Error al cargar negocios: ' + e.message, 'error');
    }
  }

  function renderNegocios() {
    const tbody = document.getElementById('sa-negocios-tbody');
    if (!tbody) return;
    tbody.innerHTML = _negocios.map(b => `
      <tr>
        <td>${esc(b.nombre_negocio)}</td>
        <td>${esc(b.contador_nombre || '—')}</td>
        <td><span class="sa-badge sa-badge-${b.license_status}">${licLabel(b.license_status)}</span></td>
        <td>${esc(b.plan)}</td>
        <td>${fmtDate(b.trial_end_date || b.license_expires_at)}</td>
        <td>
          <button onclick="superAdminPanel.openLicModal(${b.id}, '${esc(b.nombre_negocio)}')" class="sa-btn-sm">Gestionar licencia</button>
        </td>
      </tr>
    `).join('') || '<tr><td colspan="6" class="sa-empty">No hay negocios registrados.</td></tr>';
  }

  let _licBizId = null;

  function openLicModal(id, nombre) {
    _licBizId = id;
    document.getElementById('sa-lic-modal-title').textContent = 'Licencia — ' + nombre;
    document.getElementById('sa-lic-accion').value = 'activar';
    document.getElementById('sa-lic-plan').value = 'basico';
    document.getElementById('sa-lic-dias').value = '365';
    document.getElementById('sa-lic-notas').value = '';
    document.getElementById('sa-lic-modal').classList.remove('hidden');

    // Cargar historial
    apiFetch(`/licencias/${id}`).then(rows => {
      const ul = document.getElementById('sa-lic-history');
      if (!ul) return;
      ul.innerHTML = rows.map(r => `
        <li><span class="sa-badge sa-badge-${r.status}">${r.status}</span> ${esc(r.plan)} — ${fmtDate(r.created_at)} — ${esc(r.notes || '')}</li>
      `).join('') || '<li>Sin historial.</li>';
    }).catch(() => {});
  }

  function closeLicModal() {
    document.getElementById('sa-lic-modal').classList.add('hidden');
    _licBizId = null;
  }

  async function saveLicencia() {
    if (!_licBizId) return;
    const body = {
      accion: document.getElementById('sa-lic-accion').value,
      plan:   document.getElementById('sa-lic-plan').value,
      dias:   Number(document.getElementById('sa-lic-dias').value) || 365,
      notas:  document.getElementById('sa-lic-notas').value.trim() || null
    };
    try {
      await apiFetch(`/negocios/${_licBizId}/licencia`, { method: 'POST', body });
      showToastSA('Licencia actualizada.', 'ok');
      closeLicModal();
      loadNegocios();
    } catch (e) { alert('Error: ' + e.message); }
  }

  // ── Solicitudes ───────────────────────────────────────────────────────────
  let _solicitudes = [];

  async function loadSolicitudes(filterStatus) {
    try {
      const qs = filterStatus ? `?status=${filterStatus}` : '';
      _solicitudes = await apiFetch('/solicitudes' + qs);
      renderSolicitudes();
    } catch (e) {
      showToastSA('Error al cargar solicitudes: ' + e.message, 'error');
    }
  }

  function renderSolicitudes() {
    const tbody = document.getElementById('sa-solicitudes-tbody');
    if (!tbody) return;
    tbody.innerHTML = _solicitudes.map(s => `
      <tr>
        <td>${s.id}</td>
        <td>${esc(s.nombre_negocio || '—')}</td>
        <td>${esc(s.contador_nombre || '—')}</td>
        <td>${esc(s.tipo)}</td>
        <td><span class="sa-badge sa-badge-${s.status}">${s.status}</span></td>
        <td>${esc(s.descripcion || '—')}</td>
        <td>
          <button onclick="superAdminPanel.openSolModal(${s.id})" class="sa-btn-sm">Responder</button>
        </td>
      </tr>
    `).join('') || '<tr><td colspan="7" class="sa-empty">No hay solicitudes.</td></tr>';
  }

  let _solId = null;
  function openSolModal(id) {
    _solId = id;
    const s = _solicitudes.find(x => x.id === id);
    document.getElementById('sa-sol-descripcion').textContent = s?.descripcion || '';
    document.getElementById('sa-sol-status').value = s?.status || 'pendiente';
    document.getElementById('sa-sol-respuesta').value = s?.respuesta || '';
    document.getElementById('sa-sol-modal').classList.remove('hidden');
  }

  function closeSolModal() {
    document.getElementById('sa-sol-modal').classList.add('hidden');
    _solId = null;
  }

  async function saveSolicitud() {
    if (!_solId) return;
    const body = {
      status: document.getElementById('sa-sol-status').value,
      respuesta: document.getElementById('sa-sol-respuesta').value.trim()
    };
    try {
      await apiFetch(`/solicitudes/${_solId}`, { method: 'PUT', body });
      showToastSA('Solicitud actualizada.', 'ok');
      closeSolModal();
      loadSolicitudes();
    } catch (e) { alert('Error: ' + e.message); }
  }

  // ── Utilidades ─────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmtDate(d) {
    if (!d) return '—';
    try { return new Date(d).toLocaleDateString('es-DO'); } catch { return d; }
  }

  function licLabel(s) {
    const map = { trial: 'Prueba', pending: 'Pendiente', active: 'Activa', expired: 'Expirada', suspended: 'Suspendida', cancelled: 'Cancelada' };
    return map[s] || s;
  }

  function showToastSA(msg, type = 'ok') {
    if (typeof window.showToast === 'function') { window.showToast(msg, type === 'ok' ? 'success' : 'error'); return; }
    const t = document.getElementById('sa-toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'sa-toast sa-toast-' + type;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 3500);
  }

  return {
    activate, logout, showSection,
    loadDashboard, loadContadores, loadNegocios, loadSolicitudes,
    openNewContadorForm, editContador, closeContadorModal, saveContador,
    suspenderContador, reactivarContador, deleteContador,
    openLicModal, closeLicModal, saveLicencia,
    openSolModal, closeSolModal, saveSolicitud
  };
})();
