'use strict';
/**
 * Tecno Caja Admin — Frontend
 * Single-page app que corre en http://127.0.0.1:3400
 */
const adminApp = (() => {

  let _token = '';
  let _currentModule = 'dashboard';
  let _currentNegocioId = null;
  let _currentSolicitudId = null;
  let _allNegocios = [];

  // ── API helper ─────────────────────────────────────────────────────────────
  async function api(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: _token ? `Bearer ${_token}` : '' }
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(`/api${path}`, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  let _toastTimer = null;
  function toast(msg, type = 'ok') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast ${type}`;
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    _token = localStorage.getItem('tc-admin-token') || '';

    let status = {};
    try {
      const res = await fetch('/api/auth/first-run');
      status = await res.json();
    } catch (e) {
      showCriticalError('No se pudo conectar con el servidor admin. ' + e.message);
      return;
    }

    // DB no lista aún (MariaDB arrancando)
    if (status.dbReady === false) {
      showCriticalError(status.dbError || 'Conectando a la base de datos del POS...');
      // Reintentar en 2 segundos
      setTimeout(() => init(), 2000);
      return;
    }

    if (status.firstRun) {
      showSetupMode();
      return;
    }

    if (_token) {
      try {
        await loadDashboard();
        showAppShell();
        return;
      } catch {
        _token = '';
        localStorage.removeItem('tc-admin-token');
      }
    }

    showLoginScreen();
  }

  function showCriticalError(msg) {
    const el = document.getElementById('firebase-error-banner');
    if (el) { el.textContent = '⚠️ ' + msg; el.classList.remove('hidden'); }
    const btn = document.getElementById('btn-login');
    if (btn) btn.disabled = true;
    showLoginScreen();
  }

  function showSetupMode() {
    document.getElementById('setup-banner').classList.remove('hidden');
    document.getElementById('inp-nombre').classList.remove('hidden');
    document.getElementById('btn-login').textContent = 'Crear cuenta';
    document.getElementById('btn-login').onclick = doSetup;
  }

  function showLoginScreen() {
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('app-shell').classList.add('hidden');
  }

  function showAppShell() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app-shell').classList.remove('hidden');
  }

  // ── Auth ───────────────────────────────────────────────────────────────────
  async function doSetup() {
    const nombre = document.getElementById('inp-nombre').value.trim();
    const email  = document.getElementById('inp-email').value.trim();
    const pass   = document.getElementById('inp-password').value;
    if (!nombre || !email || !pass) return showError('Todos los campos son requeridos.');
    try {
      const data = await api('POST', '/auth/setup', { nombre, email, password: pass });
      _token = data.token;
      localStorage.setItem('tc-admin-token', _token);
      document.getElementById('admin-name-display').textContent = data.nombre || email;
      await loadDashboard();
      showAppShell();
    } catch (e) { showError(e.message); }
  }

  async function doLogin() {
    const email = document.getElementById('inp-email').value.trim();
    const pass  = document.getElementById('inp-password').value;
    if (!email || !pass) return showError('Correo y contraseña son requeridos.');
    try {
      const data = await api('POST', '/auth/login', { email, password: pass });
      _token = data.token;
      localStorage.setItem('tc-admin-token', _token);
      document.getElementById('admin-name-display').textContent = data.nombre || email;
      await loadDashboard();
      showAppShell();
    } catch (e) { showError(e.message); }
  }

  function logout() {
    _token = '';
    localStorage.removeItem('tc-admin-token');
    document.getElementById('app-shell').classList.add('hidden');
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('inp-password').value = '';
  }

  function showError(msg) {
    const el = document.getElementById('login-error');
    el.textContent = msg;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 4000);
  }

  // ── Módulo routing ─────────────────────────────────────────────────────────
  function switchModule(name) {
    document.querySelectorAll('.module').forEach(m => m.classList.add('hidden'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    const mod = document.getElementById(`mod-${name}`);
    if (mod) mod.classList.remove('hidden');
    document.querySelector(`.nav-item[data-module="${name}"]`)?.classList.add('active');
    _currentModule = name;

    if (name === 'dashboard')      loadDashboard();
    if (name === 'negocios')       loadNegocios();
    if (name === 'licencias')      loadLicencias();
    if (name === 'contadores')     loadContadores();
    if (name === 'solicitudes')    loadSolicitudes();
    if (name === 'actualizaciones') loadActualizaciones();
    if (name === 'auditoria')      loadAuditoria();
  }

  // ── Dashboard ──────────────────────────────────────────────────────────────
  async function loadDashboard() {
    try {
      const d = await api('GET', '/dashboard');
      const t = d.totales;
      document.getElementById('s-negocios').textContent  = t.negocios;
      document.getElementById('s-activas').textContent   = t.activas;
      document.getElementById('s-prueba').textContent    = t.prueba;
      document.getElementById('s-pendientes').textContent = t.pendientes;
      document.getElementById('s-vencidas').textContent  = t.vencidas;
      document.getElementById('s-contadores').textContent = t.contadores;

      // Badge solicitudes
      const badge = document.getElementById('sol-badge');
      if (t.solicitudesPendientes > 0) {
        badge.textContent = t.solicitudesPendientes;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }

      const tbody = document.getElementById('dash-negocios-list');
      tbody.innerHTML = (d.ultimosNegocios || []).map(n => `
        <tr>
          <td>${n.cloud_business_id || n.id}</td>
          <td><a href="#" onclick="adminApp.openNegocio('${n.id}')" style="color:var(--accent)">${n.nombre_negocio || '—'}</a></td>
          <td>${n.plan || '—'}</td>
          <td><span class="status-badge status-${n.license_status || 'trial'}">${n.license_status || 'trial'}</span></td>
          <td>${fmtDate(n.created_at)}</td>
        </tr>`).join('');
    } catch (e) { toast('Error al cargar dashboard: ' + e.message, 'err'); }
  }

  // ── Negocios ───────────────────────────────────────────────────────────────
  async function loadNegocios() {
    try {
      const status = document.getElementById('neg-filter-status')?.value || '';
      _allNegocios = await api('GET', `/negocios${status ? `?status=${status}` : ''}`);
      renderNegocios(_allNegocios);
    } catch (e) { toast('Error al cargar negocios: ' + e.message, 'err'); }
  }

  function renderNegocios(list) {
    document.getElementById('negocios-list').innerHTML = (list || []).map(n => `
      <tr>
        <td>${n.cloud_business_id || n.id}</td>
        <td><a href="#" onclick="adminApp.openNegocio('${n.id}')" style="color:var(--accent)">${n.nombre_negocio || '—'}</a></td>
        <td>${n.plan || '—'}</td>
        <td><span class="status-badge status-${n.license_status || 'trial'}">${n.license_status || 'trial'}</span></td>
        <td>${n.contador_nombre || '—'}</td>
        <td>${fmtDate(n.created_at)}</td>
        <td><button class="btn-sm" onclick="adminApp.openNegocio('${n.id}')">Ver</button></td>
      </tr>`).join('');
  }

  function filterNegocios(q) {
    const lq = q.toLowerCase();
    renderNegocios(_allNegocios.filter(n =>
      (n.nombre_negocio     || '').toLowerCase().includes(lq) ||
      (n.cloud_business_id  || '').toLowerCase().includes(lq)
    ));
  }

  async function openNegocio(id) {
    _currentNegocioId = id;
    try {
      const n = await api('GET', `/negocios/${id}`);
      document.getElementById('det-nombre').textContent = n.nombre_negocio || id;

      document.getElementById('det-info').innerHTML = [
        ['ID',             n.cloud_business_id || n.id],
        ['RNC',            n.rnc || '—'],
        ['Teléfono',       n.telefono || '—'],
        ['Correo',         n.email || '—'],
        ['Plan',           n.plan || '—'],
        ['Estado',         n.license_status || '—'],
        ['Contador',       n.contador_nombre || '—'],
        ['Modo',           n.business_mode || '—'],
        ['Trial inicio',   fmtDate(n.trial_start_date)],
        ['Trial fin',      fmtDate(n.trial_end_date)],
        ['Vence',          fmtDate(n.license_expires_at)],
        ['Registrado',     fmtDate(n.created_at)],
      ].map(([k, v]) => `<div class="detail-row"><span>${k}</span><span>${v}</span></div>`).join('');

      const sel = document.getElementById('lic-plan');
      if (sel) sel.value = n.plan || 'standalone';

      // Cargar historial licencias
      const hist = await api('GET', `/licencias/${id}`);
      document.getElementById('lic-historial').innerHTML = (hist || []).map(h => `
        <tr>
          <td>${h.action || '—'}</td>
          <td>${h.plan || '—'}</td>
          <td>${h.activated_by || '—'}</td>
          <td>${fmtDate(h.created_at)}</td>
        </tr>`).join('');

      // Mostrar módulo detalle
      document.querySelectorAll('.module').forEach(m => m.classList.add('hidden'));
      document.getElementById('mod-negocio-detalle').classList.remove('hidden');
    } catch (e) { toast('Error al abrir negocio: ' + e.message, 'err'); }
  }

  function backToNegocios() {
    switchModule('negocios');
  }

  async function accionLicencia(accion) {
    if (!_currentNegocioId) return;
    const plan  = document.getElementById('lic-plan')?.value;
    const notas = document.getElementById('lic-notas')?.value;
    const dias  = document.getElementById('lic-dias')?.value;
    try {
      await api('POST', `/negocios/${_currentNegocioId}/licencia`, { accion, plan, notas, dias });
      toast(`Licencia: ${accion} aplicado correctamente.`, 'ok');
      // Refrescar historial
      const hist = await api('GET', `/licencias/${_currentNegocioId}`);
      document.getElementById('lic-historial').innerHTML = (hist || []).map(h => `
        <tr>
          <td>${h.action || '—'}</td>
          <td>${h.plan || '—'}</td>
          <td>${h.activated_by || '—'}</td>
          <td>${fmtDate(h.created_at)}</td>
        </tr>`).join('');
      document.getElementById('renovar-form').classList.add('hidden');
    } catch (e) { toast('Error: ' + e.message, 'err'); }
  }

  function showRenovar() {
    document.getElementById('renovar-form').classList.toggle('hidden');
  }

  // ── Licencias ──────────────────────────────────────────────────────────────
  async function loadLicencias() {
    try {
      const m = await api('GET', '/licencias-resumen');
      document.getElementById('ls-active').textContent    = m.active    || 0;
      document.getElementById('ls-trial').textContent     = m.trial     || 0;
      document.getElementById('ls-pending').textContent   = m.pending   || 0;
      document.getElementById('ls-expired').textContent   = m.expired   || 0;
      document.getElementById('ls-suspended').textContent = m.suspended || 0;
      document.getElementById('ls-cancelled').textContent = m.cancelled || 0;
    } catch (e) { toast('Error: ' + e.message, 'err'); }
  }

  function goNegociosByStatus(status) {
    document.getElementById('neg-filter-status').value = status;
    switchModule('negocios');
  }

  // ── Contadores ─────────────────────────────────────────────────────────────
  async function loadContadores() {
    try {
      const list = await api('GET', '/contadores');
      document.getElementById('contadores-list').innerHTML = (list || []).map(c => `
        <tr>
          <td>${c.nombre_firma || '—'}</td>
          <td>${c.responsable || '—'}</td>
          <td>${c.rnc || '—'}</td>
          <td>${c.correo || '—'}</td>
          <td><span class="status-badge status-${c.estado || 'activo'}">${c.estado || 'activo'}</span></td>
          <td>
            ${c.estado === 'activo'
              ? `<button class="btn-sm" onclick="adminApp.suspenderContador('${c.id}')">Suspender</button>`
              : `<button class="btn-sm" onclick="adminApp.reactivarContador('${c.id}')">Reactivar</button>`}
            <button class="btn-sm" style="margin-left:4px;color:var(--red)" onclick="adminApp.eliminarContador('${c.id}')">Eliminar</button>
          </td>
        </tr>`).join('');
    } catch (e) { toast('Error al cargar contadores: ' + e.message, 'err'); }
  }

  function openNuevoContador() {
    document.getElementById('modal-cont-title').textContent = 'Nuevo Contador';
    ['cont-nombre-firma','cont-responsable','cont-rnc','cont-telefono','cont-correo','cont-email-acceso','cont-password']
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('cont-error').classList.add('hidden');
    document.getElementById('modal-contador').classList.remove('hidden');
  }

  async function guardarContador() {
    const payload = {
      nombre_firma:    document.getElementById('cont-nombre-firma').value.trim(),
      responsable:     document.getElementById('cont-responsable').value.trim(),
      rnc:             document.getElementById('cont-rnc').value.trim(),
      telefono:        document.getElementById('cont-telefono').value.trim(),
      correo:          document.getElementById('cont-correo').value.trim(),
      email_acceso:    document.getElementById('cont-email-acceso').value.trim(),
      password_acceso: document.getElementById('cont-password').value,
    };
    const errEl = document.getElementById('cont-error');
    try {
      await api('POST', '/contadores', payload);
      closeModal('modal-contador');
      toast('Contador creado.', 'ok');
      loadContadores();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.classList.remove('hidden');
    }
  }

  async function suspenderContador(id) {
    if (!confirm('¿Suspender este contador?')) return;
    try { await api('POST', `/contadores/${id}/suspender`); toast('Contador suspendido.', 'ok'); loadContadores(); }
    catch (e) { toast(e.message, 'err'); }
  }

  async function reactivarContador(id) {
    try { await api('POST', `/contadores/${id}/reactivar`); toast('Contador reactivado.', 'ok'); loadContadores(); }
    catch (e) { toast(e.message, 'err'); }
  }

  async function eliminarContador(id) {
    if (!confirm('¿Eliminar este contador? Esta acción no se puede deshacer.')) return;
    try { await api('DELETE', `/contadores/${id}`); toast('Contador eliminado.', 'ok'); loadContadores(); }
    catch (e) { toast(e.message, 'err'); }
  }

  // ── Solicitudes ────────────────────────────────────────────────────────────
  async function loadSolicitudes() {
    try {
      const status = document.getElementById('sol-filter')?.value || '';
      const list = await api('GET', `/solicitudes${status ? `?status=${status}` : ''}`);
      document.getElementById('solicitudes-list').innerHTML = (list || []).map(s => `
        <tr>
          <td>${s.business_id || s.negocio_nombre || '—'}</td>
          <td>${s.asunto || '—'}</td>
          <td><span class="status-badge status-${s.status || 'pending'}">${s.status || 'pendiente'}</span></td>
          <td>${fmtDate(s.created_at)}</td>
          <td><button class="btn-sm" onclick="adminApp.openSolicitud('${s.id}','${escHtml(s.mensaje || '')}')">Responder</button></td>
        </tr>`).join('');
    } catch (e) { toast('Error: ' + e.message, 'err'); }
  }

  function openSolicitud(id, mensaje) {
    _currentSolicitudId = id;
    document.getElementById('sol-detalle').textContent = mensaje || '(sin detalle)';
    document.getElementById('sol-respuesta').value = '';
    document.getElementById('sol-status').value = 'en_proceso';
    document.getElementById('modal-solicitud').classList.remove('hidden');
  }

  async function responderSolicitud() {
    const status    = document.getElementById('sol-status').value;
    const respuesta = document.getElementById('sol-respuesta').value;
    try {
      await api('PUT', `/solicitudes/${_currentSolicitudId}`, { status, respuesta });
      closeModal('modal-solicitud');
      toast('Solicitud actualizada.', 'ok');
      loadSolicitudes();
    } catch (e) { toast(e.message, 'err'); }
  }

  // ── Actualizaciones ────────────────────────────────────────────────────────
  async function loadActualizaciones() {
    try {
      const list = await api('GET', '/actualizaciones');
      document.getElementById('actualizaciones-list').innerHTML = (list || []).map(v => `
        <tr>
          <td><strong>${v.version}</strong></td>
          <td>${v.descripcion || '—'}</td>
          <td><span class="status-badge status-${v.estado === 'publicado' ? 'active' : 'pending'}">${v.estado || '—'}</span></td>
          <td>${v.es_obligatoria ? '✅ Sí' : '—'}</td>
          <td>${fmtDate(v.created_at)}</td>
        </tr>`).join('');
    } catch (e) { toast('Error: ' + e.message, 'err'); }
  }

  function openNuevaVersion() {
    ['ver-version','ver-desc','ver-url'].forEach(id => { const e = document.getElementById(id); if(e) e.value = ''; });
    document.getElementById('ver-obligatoria').checked = false;
    document.getElementById('ver-error').classList.add('hidden');
    document.getElementById('modal-version').classList.remove('hidden');
  }

  async function publicarVersion() {
    const errEl = document.getElementById('ver-error');
    const payload = {
      version:       document.getElementById('ver-version').value.trim(),
      descripcion:   document.getElementById('ver-desc').value.trim(),
      url_descarga:  document.getElementById('ver-url').value.trim(),
      es_obligatoria: document.getElementById('ver-obligatoria').checked,
      estado: 'publicado'
    };
    try {
      await api('POST', '/actualizaciones', payload);
      closeModal('modal-version');
      toast('Versión publicada.', 'ok');
      loadActualizaciones();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.classList.remove('hidden');
    }
  }

  // ── Auditoría ──────────────────────────────────────────────────────────────
  async function loadAuditoria() {
    try {
      const list = await api('GET', '/auditoria');
      document.getElementById('auditoria-list').innerHTML = (list || []).map(l => `
        <tr>
          <td>${l.actor || '—'}</td>
          <td><code style="font-size:11px">${l.action || '—'}</code></td>
          <td>${l.target || '—'}</td>
          <td style="color:var(--text-sub);font-size:12px">${l.detail || '—'}</td>
          <td>${fmtDate(l.created_at)}</td>
        </tr>`).join('');
    } catch (e) { toast('Error: ' + e.message, 'err'); }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleDateString('es-DO', { day:'2-digit', month:'short', year:'numeric' }); }
    catch { return iso; }
  }

  function escHtml(s) {
    return String(s).replace(/'/g, "\\'").replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function closeModal(id) {
    document.getElementById(id)?.classList.add('hidden');
  }

  // ── Nav click handler ──────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.nav-item').forEach(el => {
      el.addEventListener('click', () => switchModule(el.dataset.module));
    });

    // Enter en login
    ['inp-email','inp-password','inp-nombre'].forEach(id => {
      document.getElementById(id)?.addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('btn-login').click();
      });
    });

    init();
  });

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    doLogin, doSetup, logout,
    loadDashboard, loadNegocios, filterNegocios, openNegocio,
    backToNegocios, accionLicencia, showRenovar,
    loadLicencias, goNegociosByStatus,
    loadContadores, openNuevoContador, guardarContador, suspenderContador, reactivarContador, eliminarContador,
    loadSolicitudes, openSolicitud, responderSolicitud,
    loadActualizaciones, openNuevaVersion, publicarVersion,
    loadAuditoria,
    closeModal,
  };
})();
