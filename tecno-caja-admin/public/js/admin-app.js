'use strict';
/**
 * Tecno Caja Admin — Frontend SPA
 * Login con Firebase Authentication (email/password).
 * Config de Firebase se obtiene del servidor (env vars, nunca hardcodeada aquí).
 */

// ── Firebase init ──────────────────────────────────────────────────────────
let _auth         = null;
let _currentUser  = null;
let _idToken      = null;
let _adminProfile = null;

async function initFirebaseClient() {
  try {
    const res  = await fetch('/api/firebase-config');
    const cfg  = await res.json();

    if (!res.ok) {
      showFirebaseError(cfg.error || 'No se pudo obtener la configuración de Firebase.');
      return;
    }

    firebase.initializeApp(cfg);
    _auth = firebase.auth();

    // Renovar token automáticamente en background
    _auth.onIdTokenChanged(async user => {
      if (user) { _idToken = await user.getIdToken(); _currentUser = user; }
    });

    _auth.onAuthStateChanged(onAuthStateChanged);
  } catch (e) {
    showFirebaseError('Error conectando con Firebase: ' + e.message);
  }
}

function showFirebaseError(msg) {
  const el = document.getElementById('firebase-error-banner');
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
  console.error('[admin]', msg);
}

// ── Auth state listener ────────────────────────────────────────────────────
async function onAuthStateChanged(user) {
  if (!user) {
    _currentUser  = null;
    _idToken      = null;
    _adminProfile = null;
    showLoginScreen();
    return;
  }

  try {
    _idToken     = await user.getIdToken();
    _currentUser = user;

    const res  = await fetch('/api/auth/verify', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ idToken: _idToken }),
    });
    const data = await res.json();

    if (!res.ok) {
      await _auth.signOut();
      showLoginError(data.error || 'Acceso denegado.');
      return;
    }

    _adminProfile = data;
    showAppShell();
  } catch {
    showLoginError('Error de red verificando sesión.');
  }
}

// ── API helper ─────────────────────────────────────────────────────────────
async function api(method, path, body) {
  if (_currentUser) _idToken = await _currentUser.getIdToken();
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${_idToken}` },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res  = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── UI helpers ─────────────────────────────────────────────────────────────
const $id     = id  => document.getElementById(id);
const hide    = id  => $id(id)?.classList.add('hidden');
const show    = id  => $id(id)?.classList.remove('hidden');
const setText = (id, v) => { const el = $id(id); if (el) el.textContent = String(v ?? '—'); };

function showLoginScreen() {
  hide('app-shell');
  show('login-screen');
  showLogin(null);
  hide('firebase-error-banner');
  const btn = $id('btn-login');
  if (btn) { btn.disabled = false; btn.textContent = 'Iniciar sesión'; }
}

function showAppShell() {
  hide('login-screen');
  show('app-shell');
  setText('admin-name-display', _adminProfile?.fullName || _adminProfile?.email || 'Admin');
  navigateTo('dashboard');
}

function showLoginError(msg) {
  const el = $id('login-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function showToast(msg, type = 'success') {
  const t = $id('toast');
  if (!t) return;
  t.textContent = msg;
  t.className   = `toast ${type}`;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3500);
}

// ── Login views ────────────────────────────────────────────────────────────
function showLogin(e) {
  if (e) e.preventDefault();
  show('view-login');
  hide('view-forgot');
  hide('login-error');
  hide('forgot-error');
}

function showForgotPassword(e) {
  if (e) e.preventDefault();
  hide('view-login');
  show('view-forgot');
}

// ── Login ──────────────────────────────────────────────────────────────────
async function doLogin() {
  const email    = ($id('inp-email')?.value    || '').trim();
  const password = $id('inp-password')?.value  || '';
  const remember = $id('chk-remember')?.checked ?? true;
  const btn      = $id('btn-login');

  hide('login-error');
  if (!email || !password) { showLoginError('Ingresa correo y contraseña.'); return; }
  if (!_auth)              { showLoginError('Firebase no está listo. Verifica la configuración.'); return; }

  btn.disabled    = true;
  btn.textContent = 'Verificando...';

  try {
    const persistence = remember
      ? firebase.auth.Auth.Persistence.LOCAL
      : firebase.auth.Auth.Persistence.SESSION;
    await _auth.setPersistence(persistence);
    await _auth.signInWithEmailAndPassword(email, password);
    // onAuthStateChanged continúa el flujo
  } catch (e) {
    const map = {
      'auth/user-not-found':       'Correo no registrado.',
      'auth/wrong-password':       'Contraseña incorrecta.',
      'auth/invalid-email':        'Correo inválido.',
      'auth/too-many-requests':    'Demasiados intentos fallidos. Espera unos minutos.',
      'auth/user-disabled':        'Esta cuenta está deshabilitada.',
      'auth/invalid-credential':   'Credenciales inválidas. Verifica tu correo y contraseña.',
      'auth/api-key-not-valid':    'API Key de Firebase inválida. Verifica FIREBASE_API_KEY en tecno-caja-admin/.env',
      'auth/invalid-api-key':      'API Key de Firebase inválida. Verifica FIREBASE_API_KEY en tecno-caja-admin/.env',
      'auth/network-request-failed': 'Sin conexión a internet.',
    };
    const msg = map[e.code] || (e.message?.includes('api-key') ? 'API Key inválida. Verifica FIREBASE_API_KEY en el .env del admin.' : e.message);
    showLoginError(msg);
    btn.disabled    = false;
    btn.textContent = 'Iniciar sesión';
  }
}

// ── Recuperar contraseña ───────────────────────────────────────────────────
async function sendPasswordReset() {
  const email = ($id('inp-email')?.value || '').trim();
  if (!email) { showForgotErr('Ingresa tu correo en el campo de arriba.'); return; }
  if (!_auth) { showForgotErr('Firebase no está listo.'); return; }

  try {
    await _auth.sendPasswordResetEmail(email);
    showToast('Correo de recuperación enviado. Revisa tu bandeja.', 'success');
    showLogin(null);
  } catch (e) {
    const map = {
      'auth/user-not-found':    'No existe una cuenta con ese correo.',
      'auth/invalid-email':     'Correo inválido.',
      'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos.',
    };
    showForgotErr(map[e.code] || e.message);
  }
}

function showForgotErr(msg) {
  const el = $id('forgot-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ── Toggle visibilidad de contraseña ──────────────────────────────────────
function togglePassword(inputId, btn) {
  const inp = $id(inputId);
  if (!inp) return;
  const isHidden = inp.type === 'password';
  inp.type = isHidden ? 'text' : 'password';

  // SVG open/closed (login) o emoji (configuración)
  const eyeOpen   = btn.querySelector('#eye-open');
  const eyeClosed = btn.querySelector('#eye-closed');
  if (eyeOpen && eyeClosed) {
    eyeOpen.style.display   = isHidden ? 'none'  : '';
    eyeClosed.style.display = isHidden ? ''      : 'none';
  } else {
    btn.textContent = isHidden ? '🙈' : '👁';
  }
}

// ── Cerrar sesión ──────────────────────────────────────────────────────────
async function logout() {
  if (_auth) await _auth.signOut();
  // onAuthStateChanged llamará showLoginScreen()
}

// ── Cambiar contraseña (Configuración → Seguridad) ─────────────────────────
async function changePasswordSec() {
  const currentPw = $id('sec-current-pw')?.value  || '';
  const newPw     = $id('sec-new-pw')?.value      || '';
  const confirmPw = $id('sec-confirm-pw')?.value  || '';
  const errEl     = $id('sec-error');
  const showErr   = msg => { if(errEl){ errEl.textContent=msg; errEl.classList.remove('hidden'); } };

  if (errEl) errEl.classList.add('hidden');
  if (!currentPw)        { showErr('Ingresa tu contraseña actual.');    return; }
  if (newPw.length < 8)  { showErr('La nueva contraseña debe tener al menos 8 caracteres.'); return; }
  if (newPw !== confirmPw){ showErr('Las contraseñas nuevas no coinciden.'); return; }
  if (!_currentUser)     { showErr('No hay sesión activa.'); return; }

  try {
    // Re-autenticar antes de cambiar contraseña (requerido por Firebase)
    const credential = firebase.auth.EmailAuthProvider.credential(_currentUser.email, currentPw);
    await _currentUser.reauthenticateWithCredential(credential);
    await _currentUser.updatePassword(newPw);

    // Limpiar campos
    ['sec-current-pw','sec-new-pw','sec-confirm-pw'].forEach(id => { const el=$id(id); if(el)el.value=''; });
    showToast('Contraseña actualizada correctamente.', 'success');
  } catch (e) {
    const map = {
      'auth/wrong-password':          'La contraseña actual es incorrecta.',
      'auth/too-many-requests':       'Demasiados intentos. Espera antes de volver a intentar.',
      'auth/requires-recent-login':   'Cierra sesión e inicia de nuevo para cambiar la contraseña.',
    };
    showErr(map[e.code] || e.message);
  }
}

// ── Navegación ─────────────────────────────────────────────────────────────
function navigateTo(mod) {
  document.querySelectorAll('.module').forEach(m => m.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const section = $id('mod-' + mod);
  if (section) section.classList.remove('hidden');
  const navItem = document.querySelector(`[data-module="${mod}"]`);
  if (navItem) navItem.classList.add('active');

  if (mod === 'dashboard')       loadDashboard();
  if (mod === 'negocios')        loadNegocios();
  if (mod === 'licencias')       loadLicencias();
  if (mod === 'contadores')      loadContadores();
  if (mod === 'solicitudes')     loadSolicitudes();
  if (mod === 'actualizaciones') loadActualizaciones();
  if (mod === 'auditoria')       loadAuditoria();
  if (mod === 'configuracion')   loadConfigPerfil();
}

function closeModal(id) { hide(id); }

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.nav-item').forEach(n => {
    n.addEventListener('click', () => navigateTo(n.dataset.module));
  });
  initFirebaseClient();
});

// ── Dashboard ──────────────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const data = await api('GET', '/api/dashboard');
    const t    = data.totales || {};
    setText('s-negocios',   t.negocios   ?? '—');
    setText('s-activas',    t.activas    ?? '—');
    setText('s-prueba',     t.prueba     ?? '—');
    setText('s-pendientes', t.pendientes ?? '—');
    setText('s-vencidas',   t.vencidas   ?? '—');
    setText('s-contadores', t.contadores ?? '—');

    const badge = $id('sol-badge');
    if (badge) {
      const sol = t.solicitudesPendientes || 0;
      badge.textContent = sol;
      badge.classList.toggle('hidden', sol === 0);
    }

    const tbody = $id('dash-negocios-list');
    if (tbody) {
      tbody.innerHTML = (data.ultimosNegocios || []).map(n => `
        <tr>
          <td><code style="font-size:11px">${n.businessKey || n.id}</code></td>
          <td>${n.businessName || '—'}</td>
          <td>${n.planCode || n.plan_code || '—'}</td>
          <td><span class="badge badge-${n.status || 'trial'}">${n.status || 'trial'}</span></td>
          <td>${fmtDate(n.syncedAt || n.updatedAt)}</td>
        </tr>`).join('');
    }
  } catch (e) { showToast('Error cargando dashboard: ' + e.message, 'error'); }
}

// ── Negocios ───────────────────────────────────────────────────────────────
let _allNegocios = [];

async function loadNegocios() {
  const sf  = $id('neg-filter-status')?.value || '';
  const url = sf ? `/api/negocios?status=${encodeURIComponent(sf)}` : '/api/negocios';
  try {
    _allNegocios = await api('GET', url);
    renderNegociosList(_allNegocios);
  } catch (e) { showToast('Error cargando negocios: ' + e.message, 'error'); }
}

function renderNegociosList(list) {
  const tbody = $id('negocios-list');
  if (!tbody) return;
  tbody.innerHTML = list.map(n => `
    <tr>
      <td><code style="font-size:11px">${n.businessKey || n.id}</code></td>
      <td>${n.businessName || '—'}</td>
      <td>${n.planCode || n.plan_code || '—'}</td>
      <td><span class="badge badge-${n.status || 'trial'}">${n.status || 'trial'}</span></td>
      <td>${n.contadorNombre
        ? `<span style="color:#10b981;font-weight:600">${n.contadorNombre}</span>`
        : `<span style="color:#64748b">—</span> <button class="btn-sm btn-warning" style="font-size:10px;padding:2px 7px" onclick="adminApp.openNegocio('${n.id}');setTimeout(()=>adminApp.showAsignarContador(),300)">Asignar</button>`}</td>
      <td>${fmtDate(n.syncedAt || n.updatedAt)}</td>
      <td><button class="btn-sm" onclick="adminApp.openNegocio('${n.id}')">Ver</button></td>
    </tr>`).join('') || '<tr><td colspan="7" style="text-align:center;opacity:.6">Sin resultados</td></tr>';
}

function filterNegocios(q) {
  const lower    = q.toLowerCase();
  const filtered = _allNegocios.filter(n =>
    (n.businessName || '').toLowerCase().includes(lower) ||
    (n.businessKey  || '').toLowerCase().includes(lower) ||
    (n.id           || '').toLowerCase().includes(lower)
  );
  renderNegociosList(filtered);
}

let _currentNegocioId = null;
async function openNegocio(id) {
  _currentNegocioId = id;
  try {
    const [neg, hist] = await Promise.all([
      api('GET', `/api/negocios/${id}`),
      api('GET', `/api/licencias/${id}`).catch(() => []),
    ]);

    setText('det-nombre', neg.businessName || neg.businessKey || id);
    const contadorHtml = neg.contadorNombre
      ? `<span style="color:#10b981;font-weight:600">${neg.contadorNombre}</span>`
      : `<span style="color:#64748b">Sin asignar</span>
         <button class="btn-sm btn-warning" style="margin-left:8px" onclick="adminApp.showAsignarContador()">Asignar</button>`;
    $id('det-info').innerHTML = `
      <dl class="info-dl">
        <dt>Business Key</dt><dd><code>${neg.businessKey || id}</code></dd>
        <dt>Plan</dt><dd>${neg.planCode || neg.plan_code || '—'}</dd>
        <dt>Estado</dt><dd><span class="badge badge-${neg.status||'trial'}">${neg.status||'trial'}</span></dd>
        <dt>Contador</dt><dd>${contadorHtml}</dd>
        <dt>Trial inicia</dt><dd>${fmtDate(neg.trialStartedAt)}</dd>
        <dt>Trial vence</dt><dd>${fmtDate(neg.trialEndsAt)}</dd>
        <dt>Expira</dt><dd>${fmtDate(neg.expiresAt)}</dd>
        <dt>Último sync</dt><dd>${fmtDate(neg.syncedAt)}</dd>
      </dl>
      <div id="form-asignar-contador" class="hidden" style="margin-top:1rem;padding:1rem;background:rgba(255,255,255,.04);border-radius:10px;border:1px solid rgba(255,255,255,.1)">
        <label style="font-size:.83rem;color:#94a3b8;display:block;margin-bottom:.5rem">Buscar y asignar contador:</label>
        <div style="display:flex;gap:.5rem">
          <input id="inp-asignar-contador" type="text" placeholder="Nombre o RNC del contador…"
            style="flex:1;padding:.5rem .75rem;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;color:#e2e8f0;font-size:.85rem"
            oninput="adminApp.buscarContadorAsignar(this.value)">
          <button class="btn-sm btn-back" onclick="adminApp.hideAsignarContador()">Cancelar</button>
        </div>
        <div id="res-asignar-contador" style="margin-top:.5rem"></div>
      </div>`;

    const sel = $id('lic-plan');
    if (sel && (neg.planCode || neg.plan_code)) sel.value = neg.planCode || neg.plan_code;

    const hbody = $id('lic-historial');
    if (hbody) {
      hbody.innerHTML = (hist || []).map(h => `
        <tr>
          <td>${h.action || '—'}</td>
          <td>${h.plan || '—'}</td>
          <td>${h.activated_by || '—'}</td>
          <td>${fmtDate(h.created_at)}</td>
        </tr>`).join('') || '<tr><td colspan="4" style="opacity:.6">Sin historial</td></tr>';
    }

    document.querySelectorAll('.module').forEach(m => m.classList.add('hidden'));
    show('mod-negocio-detalle');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

function backToNegocios() {
  _currentNegocioId = null;
  navigateTo('negocios');
}

function showAsignarContador() {
  $id('form-asignar-contador')?.classList.remove('hidden');
  setTimeout(() => $id('inp-asignar-contador')?.focus(), 80);
}
function hideAsignarContador() { $id('form-asignar-contador')?.classList.add('hidden'); }

let _asignarTimeout = null;
async function buscarContadorAsignar(q) {
  clearTimeout(_asignarTimeout);
  const res = $id('res-asignar-contador');
  if (!res) return;
  if ((q || '').trim().length < 2) { res.innerHTML = ''; return; }
  _asignarTimeout = setTimeout(async () => {
    try {
      const list = await api('GET', `/api/contadores?q=${encodeURIComponent(q)}`);
      if (!Array.isArray(list) || !list.length) { res.innerHTML = '<p style="font-size:.8rem;color:#64748b;margin:.5rem 0">Sin resultados</p>'; return; }
      res.innerHTML = list.map(c => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:.5rem .75rem;border-radius:8px;background:rgba(255,255,255,.04);margin-bottom:.3rem">
          <div>
            <div style="font-size:.85rem;font-weight:600;color:#e2e8f0">${c.nombre_firma}</div>
            ${c.rnc ? `<div style="font-size:.75rem;color:#64748b">RNC: ${c.rnc}</div>` : ''}
          </div>
          <button class="btn-sm" onclick="adminApp.confirmarAsignarContador('${c.id}','${(c.nombre_firma||'').replace(/'/g,"\\'")}')">Asignar</button>
        </div>`).join('');
    } catch (e) { res.innerHTML = `<p style="color:#ef4444;font-size:.8rem">${e.message}</p>`; }
  }, 350);
}

async function confirmarAsignarContador(contadorId, nombre) {
  if (!_currentNegocioId) return;
  if (!confirm(`¿Asignar el contador "${nombre}" a este negocio?`)) return;
  try {
    await api('POST', `/api/negocios/${_currentNegocioId}/asignar-contador`, { contadorId });
    showToast(`Contador "${nombre}" asignado.`, 'success');
    openNegocio(_currentNegocioId);
    loadNegocios();
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

function showRenovar() {
  const f = $id('renovar-form');
  if (f) f.classList.toggle('hidden');
}

async function accionLicencia(accion) {
  if (!_currentNegocioId) return;
  const plan  = $id('lic-plan')?.value;
  const dias  = $id('lic-dias')?.value;
  const notas = $id('lic-notas')?.value;
  try {
    await api('POST', `/api/negocios/${_currentNegocioId}/licencia`, { accion, plan, dias, notas });
    showToast('Licencia actualizada.', 'success');
    openNegocio(_currentNegocioId);
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

// ── Licencias overview ─────────────────────────────────────────────────────
async function loadLicencias() {
  try {
    const data = await api('GET', '/api/licencias-resumen');
    const set  = (id, key) => setText(id, data[key] || 0);
    set('ls-active',    'active');
    set('ls-trial',     'trial');
    set('ls-pending',   'pending');
    set('ls-expired',   'expired');
    set('ls-suspended', 'suspended');
    set('ls-cancelled', 'cancelled');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

function goNegociosByStatus(status) {
  const sel = $id('neg-filter-status');
  if (sel) sel.value = status;
  navigateTo('negocios');
}

// ── Contadores ─────────────────────────────────────────────────────────────
async function loadContadores() {
  try {
    const list  = await api('GET', '/api/contadores');
    const tbody = $id('contadores-list');
    if (!tbody) return;
    tbody.innerHTML = list.map(c => `
      <tr>
        <td>${c.nombre_firma || '—'}</td>
        <td>${c.responsable || '—'}</td>
        <td>${c.rnc || '—'}</td>
        <td>${c.correo || '—'}</td>
        <td><span class="badge badge-${c.estado==='activo'?'active':'suspended'}">${c.estado}</span></td>
        <td>
          ${c.estado === 'activo'
            ? `<button class="btn-sm btn-warning" onclick="adminApp.suspenderContador('${c.id}')">Suspender</button>`
            : `<button class="btn-sm btn-success" onclick="adminApp.reactivarContador('${c.id}')">Reactivar</button>`}
          <button class="btn-sm btn-danger" onclick="adminApp.eliminarContador('${c.id}','${(c.nombre_firma||'').replace(/'/g,'&#39;')}')" style="margin-left:4px">Eliminar</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;opacity:.6">Sin contadores</td></tr>';
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

function openNuevoContador() {
  ['cont-nombre-firma','cont-responsable','cont-rnc','cont-telefono','cont-correo','cont-email-acceso','cont-password']
    .forEach(id => { const el=$id(id); if(el) el.value=''; });
  hide('cont-error');
  show('modal-contador');
}

async function guardarContador() {
  const showErr = msg => { const e=$id('cont-error'); if(e){e.textContent=msg;e.classList.remove('hidden');} };
  const g       = id  => ($id(id)?.value || '').trim();
  const nombre_firma    = g('cont-nombre-firma');
  const email_acceso    = g('cont-email-acceso');
  const password_acceso = $id('cont-password')?.value || '';
  if (!nombre_firma || !email_acceso || !password_acceso) {
    showErr('Nombre de firma, correo de acceso y contraseña son obligatorios.'); return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email_acceso)) {
    showErr('El correo de acceso no tiene un formato válido. Ejemplo: contador@firma.com'); return;
  }
  if (password_acceso.length < 6) {
    showErr('La contraseña debe tener al menos 6 caracteres.'); return;
  }
  try {
    await api('POST', '/api/contadores', {
      nombre_firma, responsable: g('cont-responsable'),
      rnc: g('cont-rnc'), telefono: g('cont-telefono'),
      correo: g('cont-correo') || email_acceso,
      email_acceso, password_acceso,
    });
    closeModal('modal-contador');
    showToast('Contador creado correctamente.', 'success');
    loadContadores();
  } catch (e) { showErr(e.message); }
}

async function suspenderContador(id) {
  if (!confirm('¿Suspender este contador?')) return;
  try { await api('POST', `/api/contadores/${id}/suspender`); showToast('Suspendido.', 'success'); loadContadores(); }
  catch (e) { showToast('Error: ' + e.message, 'error'); }
}

async function reactivarContador(id) {
  try { await api('POST', `/api/contadores/${id}/reactivar`); showToast('Reactivado.', 'success'); loadContadores(); }
  catch (e) { showToast('Error: ' + e.message, 'error'); }
}

async function eliminarContador(id, nombre) {
  if (!confirm(`¿Eliminar al contador "${nombre}"? Esta acción no se puede deshacer.`)) return;
  try { await api('DELETE', `/api/contadores/${id}`); showToast('Eliminado.', 'success'); loadContadores(); }
  catch (e) { showToast('Error: ' + e.message, 'error'); }
}

// ── Solicitudes ────────────────────────────────────────────────────────────
let _currentSolicitudId = null;

async function loadSolicitudes() {
  const status = $id('sol-filter')?.value || '';
  const url    = status ? `/api/solicitudes?status=${encodeURIComponent(status)}` : '/api/solicitudes';
  try {
    const list  = await api('GET', url);
    const tbody = $id('solicitudes-list');
    if (!tbody) return;
    tbody.innerHTML = list.map(s => `
      <tr>
        <td>${s.businessName || s.businessKey || '—'}</td>
        <td>${s.asunto || s.subject || '—'}</td>
        <td><span class="badge badge-${s.status||'pendiente'}">${s.status||'pendiente'}</span></td>
        <td>${fmtDate(s.created_at)}</td>
        <td><button class="btn-sm" onclick="adminApp.abrirSolicitud('${s.id}')">Responder</button></td>
      </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;opacity:.6">Sin solicitudes</td></tr>';
    window._solicitudesCache = list;
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

function abrirSolicitud(id) {
  _currentSolicitudId = id;
  const sol = (window._solicitudesCache || []).find(s => s.id === id);
  const el  = $id('sol-detalle');
  if (el) el.textContent = sol?.mensaje || sol?.body || 'Sin mensaje.';
  const resp = $id('sol-respuesta'); if(resp) resp.value = '';
  const st   = $id('sol-status');   if(st)   st.value   = 'en_proceso';
  show('modal-solicitud');
}

async function responderSolicitud() {
  if (!_currentSolicitudId) return;
  const status    = $id('sol-status')?.value    || 'en_proceso';
  const respuesta = $id('sol-respuesta')?.value || '';
  try {
    await api('PUT', `/api/solicitudes/${_currentSolicitudId}`, { status, respuesta });
    closeModal('modal-solicitud');
    showToast('Solicitud actualizada.', 'success');
    loadSolicitudes();
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

// ── Actualizaciones ────────────────────────────────────────────────────────
async function loadActualizaciones() {
  try {
    const list  = await api('GET', '/api/actualizaciones');
    const tbody = $id('actualizaciones-list');
    if (!tbody) return;
    tbody.innerHTML = list.map(v => `
      <tr>
        <td><strong>${v.version}</strong></td>
        <td>${v.descripcion || '—'}</td>
        <td><span class="badge badge-active">${v.estado || 'publicado'}</span></td>
        <td>${v.es_obligatoria ? '✔ Sí' : 'No'}</td>
        <td>${fmtDate(v.created_at)}</td>
      </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;opacity:.6">Sin versiones</td></tr>';
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

function openNuevaVersion() {
  ['ver-version','ver-desc','ver-url'].forEach(id => { const el=$id(id); if(el) el.value=''; });
  const ob = $id('ver-obligatoria'); if(ob) ob.checked = false;
  hide('ver-error');
  show('modal-version');
}

async function publicarVersion() {
  const showErr    = msg => { const e=$id('ver-error'); if(e){e.textContent=msg;e.classList.remove('hidden');} };
  const version    = ($id('ver-version')?.value || '').trim();
  const descripcion  = ($id('ver-desc')?.value  || '').trim();
  const url_descarga = ($id('ver-url')?.value   || '').trim();
  const es_obligatoria = $id('ver-obligatoria')?.checked || false;
  if (!version) { showErr('La versión es obligatoria.'); return; }
  try {
    await api('POST', '/api/actualizaciones', { version, descripcion, url_descarga, es_obligatoria });
    closeModal('modal-version');
    showToast('Versión publicada.', 'success');
    loadActualizaciones();
  } catch (e) { showErr(e.message); }
}

// ── Auditoría ──────────────────────────────────────────────────────────────
async function loadAuditoria() {
  try {
    const list  = await api('GET', '/api/auditoria');
    const tbody = $id('auditoria-list');
    if (!tbody) return;
    tbody.innerHTML = list.map(a => `
      <tr>
        <td>${a.actor  || '—'}</td>
        <td><code style="font-size:11px">${a.action || '—'}</code></td>
        <td>${a.target || '—'}</td>
        <td>${a.detail || '—'}</td>
        <td>${fmtDate(a.created_at)}</td>
      </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;opacity:.6">Sin registros</td></tr>';
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

// ── Configuración ──────────────────────────────────────────────────────────
async function loadConfigPerfil() {
  try {
    const data = await api('GET', '/api/perfil');
    const el   = $id('config-perfil-info');
    if (!el) return;
    el.innerHTML = `
      <dt>Nombre</dt><dd>${data.fullName || '—'}</dd>
      <dt>Correo</dt><dd>${data.email || '—'}</dd>
      <dt>Rol</dt><dd>${data.role || '—'}</dd>
      <dt>Estado</dt><dd><span class="badge badge-${data.status==='active'?'active':'suspended'}">${data.status || '—'}</span></dd>
      <dt>Permisos</dt><dd>${(data.permissions || []).join(', ')}</dd>
      <dt>Último acceso</dt><dd>${fmtDate(data.lastLoginAt)}</dd>
      <dt>Creado</dt><dd>${fmtDate(data.createdAt)}</dd>`;
  } catch (e) { showToast('Error cargando perfil: ' + e.message, 'error'); }
}

// ── Utils ──────────────────────────────────────────────────────────────────
function fmtDate(v) {
  if (!v) return '—';
  try {
    const d = v?.toDate ? v.toDate() : new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' });
  } catch { return String(v); }
}

// ── Exponer al HTML ────────────────────────────────────────────────────────
window.adminApp = {
  doLogin, logout, sendPasswordReset, showLogin, showForgotPassword,
  togglePassword, changePasswordSec, closeModal,
  loadDashboard,
  loadNegocios, filterNegocios, openNegocio, backToNegocios,
  showAsignarContador, hideAsignarContador, buscarContadorAsignar, confirmarAsignarContador,
  accionLicencia, showRenovar,
  loadLicencias, goNegociosByStatus,
  loadContadores, openNuevoContador, guardarContador,
  suspenderContador, reactivarContador, eliminarContador,
  loadSolicitudes, abrirSolicitud, responderSolicitud,
  loadActualizaciones, openNuevaVersion, publicarVersion,
  loadAuditoria,
  loadConfigPerfil,
};
