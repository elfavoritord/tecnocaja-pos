'use strict';

/**
 * contador.js — Panel del Contador Asociado
 * Solo visible cuando roleCode === 'contador_asociado'
 */

window.contadorPanel = (() => {
  let _token = () => (typeof window.getTecnoCajaAuthToken === 'function' ? window.getTecnoCajaAuthToken() : '') || '';

  async function apiFetch(path, opts = {}) {
    const res = await fetch('/api/contador' + path, {
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
    const panel = document.getElementById('contador-panel');
    if (panel) { panel.classList.remove('hidden'); panel.style.display = ''; }
    loadDashboard();
    showSection('cont-dashboard');
  }

  function logout() {
    document.getElementById('contador-panel')?.classList.add('hidden');
    if (typeof window.clearTecnoCajaAuthToken === 'function') window.clearTecnoCajaAuthToken();
    window.location.reload();
  }

  // ── Secciones ─────────────────────────────────────────────────────────────
  function showSection(id) {
    document.querySelectorAll('.cont-section').forEach(s => s.classList.add('hidden'));
    document.getElementById(id)?.classList.remove('hidden');
    document.querySelectorAll('.cont-nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.cont-nav-btn[data-section="${id}"]`)?.classList.add('active');

    if (id === 'cont-clientes') loadClientes();
    if (id === 'cont-solicitudes') loadSolicitudes();
    if (id === 'cont-perfil') loadPerfil();
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────
  async function loadDashboard() {
    try {
      const d = await apiFetch('/dashboard');
      const t = d.totales;
      document.getElementById('cont-stat-clientes').textContent = t.clientes;
      document.getElementById('cont-stat-activos').textContent = t.activos;
      document.getElementById('cont-stat-prueba').textContent = t.prueba;
      document.getElementById('cont-stat-vencidos').textContent = t.vencidos;

      const tbody = document.getElementById('cont-vencimientos-tbody');
      if (tbody) {
        const rows = d.proximosVencimientos || [];
        tbody.innerHTML = rows.map(b => `
          <tr class="${(b.dias_restantes != null && b.dias_restantes <= 7) ? 'sa-row-warn' : ''}">
            <td>${esc(b.nombre_negocio)}</td>
            <td><span class="sa-badge sa-badge-${b.license_status}">${licLabel(b.license_status)}</span></td>
            <td>${b.dias_restantes != null ? b.dias_restantes + ' días' : '—'}</td>
          </tr>
        `).join('') || '<tr><td colspan="3" class="sa-empty">Sin vencimientos próximos.</td></tr>';
      }
    } catch (e) {
      showToastCont('Error al cargar dashboard: ' + e.message, 'error');
    }
  }

  // ── Clientes ───────────────────────────────────────────────────────────────
  let _clientes = [];

  async function loadClientes() {
    try {
      _clientes = await apiFetch('/clientes');
      renderClientes();
    } catch (e) {
      showToastCont('Error al cargar clientes: ' + e.message, 'error');
    }
  }

  function renderClientes() {
    const tbody = document.getElementById('cont-clientes-tbody');
    if (!tbody) return;
    tbody.innerHTML = _clientes.map(c => `
      <tr>
        <td>${esc(c.nombre_negocio)}</td>
        <td>${esc(c.rnc || '—')}</td>
        <td>${esc(c.propietario || '—')}</td>
        <td>${esc(c.telefono || '—')}</td>
        <td><span class="sa-badge sa-badge-${c.license_status}">${licLabel(c.license_status)}</span></td>
        <td>${esc(c.plan)}</td>
        <td>${c.dias_restantes != null ? c.dias_restantes + ' días' : '—'}</td>
      </tr>
    `).join('') || '<tr><td colspan="7" class="sa-empty">No hay clientes registrados.</td></tr>';
  }

  function openNuevoClienteModal() {
    ['cont-cli-nombre','cont-cli-rnc','cont-cli-propietario','cont-cli-telefono','cont-cli-correo'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    document.getElementById('cont-cli-plan').value = 'basico';
    document.getElementById('cont-cli-modal').classList.remove('hidden');
  }

  function closeNuevoClienteModal() {
    document.getElementById('cont-cli-modal').classList.add('hidden');
  }

  async function saveNuevoCliente() {
    const body = {
      nombre_negocio: document.getElementById('cont-cli-nombre').value.trim(),
      rnc:            document.getElementById('cont-cli-rnc').value.trim() || null,
      propietario:    document.getElementById('cont-cli-propietario').value.trim() || null,
      telefono:       document.getElementById('cont-cli-telefono').value.trim() || null,
      correo:         document.getElementById('cont-cli-correo').value.trim() || null,
      plan:           document.getElementById('cont-cli-plan').value
    };
    if (!body.nombre_negocio) return alert('El nombre del negocio es requerido.');
    try {
      await apiFetch('/clientes/registrar', { method: 'POST', body });
      showToastCont('Cliente registrado con prueba de 30 días.', 'ok');
      closeNuevoClienteModal();
      loadClientes();
    } catch (e) { alert('Error: ' + e.message); }
  }

  // ── Solicitudes ───────────────────────────────────────────────────────────
  let _solicitudes = [];

  async function loadSolicitudes() {
    try {
      _solicitudes = await apiFetch('/solicitudes');
      renderSolicitudes();
    } catch (e) {
      showToastCont('Error al cargar solicitudes: ' + e.message, 'error');
    }
  }

  function renderSolicitudes() {
    const tbody = document.getElementById('cont-sol-tbody');
    if (!tbody) return;
    tbody.innerHTML = _solicitudes.map(s => `
      <tr>
        <td>${s.id}</td>
        <td>${esc(s.nombre_negocio || '—')}</td>
        <td>${esc(s.tipo)}</td>
        <td><span class="sa-badge sa-badge-${s.status}">${s.status}</span></td>
        <td>${esc(s.descripcion || '—')}</td>
        <td>${esc(s.respuesta || '—')}</td>
        <td>${fmtDate(s.created_at)}</td>
      </tr>
    `).join('') || '<tr><td colspan="7" class="sa-empty">No hay solicitudes.</td></tr>';
  }

  // ── Perfil ────────────────────────────────────────────────────────────────
  async function loadPerfil() {
    try {
      const p = await apiFetch('/perfil');
      document.getElementById('cont-perfil-firma').value = p.nombre_firma || '';
      document.getElementById('cont-perfil-responsable').value = p.responsable || '';
      document.getElementById('cont-perfil-rnc').value = p.rnc || '';
      document.getElementById('cont-perfil-telefono').value = p.telefono || '';
      document.getElementById('cont-perfil-correo').value = p.correo || '';
      document.getElementById('cont-perfil-whatsapp').value = p.whatsapp || '';
      document.getElementById('cont-perfil-direccion').value = p.direccion || '';
    } catch (e) {
      showToastCont('Error al cargar perfil: ' + e.message, 'error');
    }
  }

  async function savePerfil() {
    const body = {
      nombre_firma: document.getElementById('cont-perfil-firma').value.trim(),
      responsable:  document.getElementById('cont-perfil-responsable').value.trim() || null,
      rnc:          document.getElementById('cont-perfil-rnc').value.trim() || null,
      telefono:     document.getElementById('cont-perfil-telefono').value.trim() || null,
      correo:       document.getElementById('cont-perfil-correo').value.trim() || null,
      whatsapp:     document.getElementById('cont-perfil-whatsapp').value.trim() || null,
      direccion:    document.getElementById('cont-perfil-direccion').value.trim() || null
    };
    if (!body.nombre_firma) return alert('El nombre de la firma es requerido.');
    try {
      await apiFetch('/perfil', { method: 'PUT', body });
      showToastCont('Perfil actualizado correctamente.', 'ok');
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

  function showToastCont(msg, type = 'ok') {
    if (typeof window.showToast === 'function') { window.showToast(msg, type === 'ok' ? 'success' : 'error'); return; }
    const t = document.getElementById('cont-toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'sa-toast sa-toast-' + type;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 3500);
  }

  return {
    activate, logout, showSection,
    loadDashboard, loadClientes, loadSolicitudes, loadPerfil,
    openNuevoClienteModal, closeNuevoClienteModal, saveNuevoCliente,
    savePerfil
  };
})();
