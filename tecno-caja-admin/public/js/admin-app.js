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

    // Siempre usar persistencia LOCAL para que la sesión sobreviva reinicios de la app
    await _auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

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

  const name = _adminProfile?.fullName || _adminProfile?.email?.split('@')[0] || 'Admin';
  setText('admin-name-display', name);
  setText('dash-admin-name', name.split(' ')[0]);

  // Avatar: primera letra del nombre
  const avatarEl = document.getElementById('admin-avatar');
  if (avatarEl) avatarEl.textContent = name[0].toUpperCase();

  // Fecha en el dashboard
  const dateEl = document.getElementById('dash-date');
  if (dateEl) {
    const now = new Date();
    dateEl.textContent = now.toLocaleDateString('es-DO', { weekday:'long', day:'numeric', month:'long' });
  }

  // Pequeño delay para que el DOM termine de renderizar el app-shell
  setTimeout(() => navigateTo('dashboard'), 150);
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
  if (mod === 'facturacion')     loadFacturas();
  if (mod === 'compras')         loadCompras();
  if (mod === 'gastos')          loadGastos();
  if (mod === 'flujo')           loadFlujoFinanciero();
  if (mod === 'solicitudes')     loadSolicitudes();
  if (mod === 'actualizaciones') loadActualizaciones();
  if (mod === 'auditoria')       loadAuditoria();
  if (mod === 'configuracion')   loadConfigPerfil();
}

function closeModal(id) { hide(id); }

// ── Branding (logo en login + sidebar) ──────────────────────────────────────
// Público (sin auth) porque el login se ve antes de iniciar sesión.
function applyBranding(dataUrl) {
  [document.querySelector('.logo-icon'), document.querySelector('.sidebar-logo-icon')]
    .forEach(el => {
      if (!el) return;
      el.innerHTML = dataUrl
        ? `<img src="${dataUrl}" style="width:100%;height:100%;object-fit:contain;border-radius:inherit" />`
        : '⚡';
    });
}

async function loadBranding() {
  try {
    const res  = await fetch('/api/branding/logo');
    const data = await res.json();
    applyBranding(data.logoDataUrl || null);
  } catch (_) { /* si falla, se queda el ícono ⚡ por defecto */ }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.nav-item').forEach(n => {
    n.addEventListener('click', () => navigateTo(n.dataset.module));
  });
  loadBranding();
  initFirebaseClient();
});

// ── Dashboard ──────────────────────────────────────────────────────────────
async function loadDashboard(attempt = 0) {
  // Mostrar estado de carga en las tarjetas de stats
  ['s-negocios','s-activas','s-prueba','s-pendientes','s-vencidas','s-contadores']
    .forEach(id => setText(id, '…'));
  const tbody = $id('dash-negocios-list');
  if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="opacity:.5;text-align:center">Cargando…</td></tr>';

  try {
    const data = await api('GET', '/api/dashboard');
    const t    = data.totales || {};
    setText('s-negocios',   t.negocios   ?? '0');
    setText('s-activas',    t.activas    ?? '0');
    setText('s-prueba',     t.prueba     ?? '0');
    setText('s-pendientes', t.pendientes ?? '0');
    setText('s-vencidas',   t.vencidas   ?? '0');
    setText('s-contadores', t.contadores ?? '0');

    const badge = $id('sol-badge');
    if (badge) {
      const sol = t.solicitudesPendientes || 0;
      badge.textContent = sol;
      badge.classList.toggle('hidden', sol === 0);
    }

    if (tbody) {
      tbody.innerHTML = (data.ultimosNegocios || []).map(n => `
        <tr>
          <td><code style="font-size:11px">${n.businessKey || n.id}</code></td>
          <td>${n.businessName || '—'}</td>
          <td>${n.planCode || n.plan_code || '—'}</td>
          <td><span class="badge badge-${n.status || 'trial'}">${n.status || 'trial'}</span></td>
          <td>${fmtDate(n.syncedAt || n.updatedAt)}</td>
        </tr>`).join('') || '<tr><td colspan="5" style="opacity:.5;text-align:center">Sin negocios registrados</td></tr>';
    }
  } catch (e) {
    // Retry automático hasta 3 veces (cubre race conditions de inicio)
    if (attempt < 3) {
      setTimeout(() => loadDashboard(attempt + 1), 800 * (attempt + 1));
      return;
    }
    ['s-negocios','s-activas','s-prueba','s-pendientes','s-vencidas','s-contadores']
      .forEach(id => setText(id, '—'));
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="color:#ef4444;text-align:center">Error cargando datos. <button class="btn-sm" onclick="adminApp.loadDashboard()" style="margin-left:.5rem">Reintentar</button></td></tr>`;
  }
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
    const [neg, hist, devData] = await Promise.all([
      api('GET', `/api/negocios/${id}`),
      api('GET', `/api/licencias/${id}`).catch(() => []),
      api('GET', `/api/negocios/${id}/dispositivos`).catch(() => ({ deviceLimit: 1, devices: [] })),
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
        <dt>Expira</dt><dd>${neg.expiresAt ? fmtDate(neg.expiresAt) : '<span style="color:#10b981;font-size:.8rem">Licencia perpetua</span>'}</dd>
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

    const devSection = $id('dispositivos-section');
    if (devSection) {
      const devices = devData?.devices || [];
      const limit   = devData?.deviceLimit ?? 1;
      devSection.innerHTML = `
        <h4 style="margin:0 0 .75rem;color:#94a3b8;font-size:.85rem;letter-spacing:.05em;text-transform:uppercase">
          Dispositivos registrados (${devices.length}/${limit})
        </h4>
        <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem">
          <label style="font-size:.82rem;color:#94a3b8">Límite de dispositivos:</label>
          <input id="inp-device-limit" type="number" min="1" max="50" value="${limit}"
            style="width:70px;padding:.3rem .5rem;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:#e2e8f0;font-size:.85rem">
          <button class="btn-sm btn-warning" onclick="adminApp.saveDeviceLimit()">Guardar límite</button>
        </div>
        ${devices.length === 0 ? '<p style="opacity:.5;font-size:.83rem">Ningún dispositivo registrado aún.</p>' : `
        <table style="width:100%;border-collapse:collapse;font-size:.82rem">
          <thead><tr style="color:#64748b;border-bottom:1px solid rgba(255,255,255,.07)">
            <th style="text-align:left;padding:.4rem .6rem">Host</th>
            <th style="text-align:left;padding:.4rem .6rem">Plataforma</th>
            <th style="text-align:left;padding:.4rem .6rem">Último acceso</th>
            <th style="padding:.4rem .6rem"></th>
          </tr></thead>
          <tbody>${devices.map(dv => `
            <tr style="border-bottom:1px solid rgba(255,255,255,.05)">
              <td style="padding:.4rem .6rem">${dv.hostname}</td>
              <td style="padding:.4rem .6rem">${dv.platform}</td>
              <td style="padding:.4rem .6rem">${fmtDate(dv.lastSeenAt)}</td>
              <td style="padding:.4rem .6rem;text-align:right">
                <button class="btn-sm btn-danger" style="font-size:.75rem;padding:.2rem .5rem"
                  onclick="adminApp.removeDevice('${dv.deviceId}')">Eliminar</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>`}`;
    }

    document.querySelectorAll('.module').forEach(m => m.classList.add('hidden'));
    show('mod-negocio-detalle');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

function backToNegocios() {
  _currentNegocioId = null;
  navigateTo('negocios');
}

async function eliminarNegocio() {
  const id = _currentNegocioId;
  if (!id) return;

  const nombre = $id('det-nombre')?.textContent || id;

  // Modal de confirmación
  const overlay = document.createElement('div');
  overlay.id = 'confirm-delete-negocio';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = `
    <div style="background:#1e2435;border:1px solid rgba(239,68,68,.35);border-radius:18px;padding:1.75rem 2rem;width:min(420px,92vw);display:flex;flex-direction:column;gap:1.1rem">
      <div style="display:flex;align-items:flex-start;gap:.85rem">
        <span style="font-size:1.6rem;line-height:1;flex-shrink:0">🗑️</span>
        <div>
          <div style="font-weight:700;font-size:1rem;color:#ef4444;margin-bottom:.3rem">Eliminar negocio de Firebase</div>
          <div style="font-size:.82rem;color:#94a3b8;line-height:1.55">
            Esto borrará <strong style="color:#e2e8f0">${nombre}</strong> de
            <code style="font-size:.78rem;background:rgba(255,255,255,.06);padding:.1rem .3rem;border-radius:4px">licencias</code>,
            <code style="font-size:.78rem;background:rgba(255,255,255,.06);padding:.1rem .3rem;border-radius:4px">usuarios</code> y
            <code style="font-size:.78rem;background:rgba(255,255,255,.06);padding:.1rem .3rem;border-radius:4px">businesses</code>.
            <br><br>
            Si esa PC sigue corriendo Tecno Caja, en el próximo arranque generará un documento <em>nuevo</em> con un UID diferente.
          </div>
        </div>
      </div>
      <div>
        <label style="font-size:.78rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;display:block;margin-bottom:.4rem">
          Escribe el ID para confirmar
        </label>
        <input id="confirm-del-input" type="text" placeholder="${id}"
          style="width:100%;padding:.55rem .8rem;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#e2e8f0;font-size:.83rem;font-family:monospace">
        <div id="confirm-del-status" style="font-size:.78rem;min-height:1.1em;margin-top:.35rem;color:#ef4444"></div>
      </div>
      <div style="display:flex;gap:.75rem;justify-content:flex-end">
        <button onclick="document.getElementById('confirm-delete-negocio').remove()"
          style="padding:.55rem 1.1rem;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:transparent;color:#94a3b8;cursor:pointer;font-size:.85rem">
          Cancelar
        </button>
        <button id="confirm-del-btn" onclick="confirmarEliminarNegocio('${id}')"
          style="padding:.55rem 1.2rem;border-radius:8px;border:none;background:#ef4444;color:#fff;font-weight:600;cursor:pointer;font-size:.85rem">
          🗑️ Eliminar
        </button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  setTimeout(() => $id('confirm-del-input')?.focus(), 80);
}

async function confirmarEliminarNegocio(id) {
  const input  = $id('confirm-del-input');
  const status = $id('confirm-del-status');
  const btn    = $id('confirm-del-btn');
  if (!input || input.value.trim() !== id) {
    if (status) status.textContent = `Escribe exactamente: ${id}`;
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Eliminando…'; }
  try {
    await api('DELETE', `/api/negocios/${id}`);
    document.getElementById('confirm-delete-negocio')?.remove();
    showToast('Negocio eliminado de Firebase correctamente.', 'success');
    backToNegocios();
    await loadNegocios();
  } catch (e) {
    if (status) status.textContent = 'Error: ' + e.message;
    if (btn) { btn.disabled = false; btn.textContent = '🗑️ Eliminar'; }
  }
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

async function saveDeviceLimit() {
  if (!_currentNegocioId) return;
  const limit = Number($id('inp-device-limit')?.value);
  if (!Number.isFinite(limit) || limit < 1) { showToast('Ingresa un número válido (mín. 1)', 'error'); return; }
  try {
    await api('PUT', `/api/negocios/${_currentNegocioId}/device-limit`, { limit });
    showToast(`Límite actualizado a ${limit} dispositivo(s).`, 'success');
    openNegocio(_currentNegocioId);
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

async function removeDevice(deviceId) {
  if (!_currentNegocioId) return;
  if (!confirm('¿Eliminar este dispositivo? El equipo quedará bloqueado hasta que se reconecte.')) return;
  try {
    await api('DELETE', `/api/negocios/${_currentNegocioId}/dispositivos/${deviceId}`);
    showToast('Dispositivo eliminado.', 'success');
    openNegocio(_currentNegocioId);
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
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
          <button class="btn-sm" onclick="adminApp.editarContador('${c.id}')">Editar</button>
          ${c.estado === 'activo'
            ? `<button class="btn-sm btn-warning" onclick="adminApp.suspenderContador('${c.id}')" style="margin-left:4px">Suspender</button>`
            : `<button class="btn-sm btn-success" onclick="adminApp.reactivarContador('${c.id}')" style="margin-left:4px">Reactivar</button>`}
          <button class="btn-sm btn-danger" onclick="adminApp.eliminarContador('${c.id}','${(c.nombre_firma||'').replace(/'/g,'&#39;')}')" style="margin-left:4px">Eliminar</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;opacity:.6">Sin contadores</td></tr>';
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

let _editingContadorId = null;

function openNuevoContador() {
  _editingContadorId = null;
  ['cont-nombre-firma','cont-responsable','cont-rnc','cont-telefono','cont-correo','cont-email-acceso','cont-password']
    .forEach(id => { const el=$id(id); if(el) el.value=''; });
  const st = $id('cont-rnc-status'); if (st) { st.textContent = ''; st.style.color = '#64748b'; }
  const title = $id('modal-cont-title'); if (title) title.textContent = 'Nuevo Contador';
  const acceso = document.querySelector('#modal-contador [data-seccion="acceso"]');
  if (acceso) acceso.style.display = '';
  const saveBtn = document.querySelector('#modal-contador .btn-primary');
  if (saveBtn) saveBtn.textContent = 'Guardar contador';
  hide('cont-error');
  show('modal-contador');
  setTimeout(() => $id('cont-rnc')?.focus(), 80);
}

async function editarContador(id) {
  try {
    const list = await api('GET', '/api/contadores');
    const c    = list.find(x => x.id === id);
    if (!c) { showToast('Contador no encontrado.', 'error'); return; }

    _editingContadorId = id;
    _rncLastByField['cont-rnc'] = '';

    const set = (elId, val) => { const el = $id(elId); if (el) el.value = val || ''; };
    set('cont-nombre-firma', c.nombre_firma);
    set('cont-responsable',  c.responsable);
    set('cont-rnc',          c.rnc);
    set('cont-telefono',     c.telefono);
    set('cont-correo',       c.correo);
    $id('cont-email-acceso') && ($id('cont-email-acceso').value = c.email_acceso || '');
    $id('cont-password')     && ($id('cont-password').value     = '');

    const st = $id('cont-rnc-status'); if (st) { st.textContent = ''; st.style.color = '#64748b'; }
    const title = $id('modal-cont-title'); if (title) title.textContent = 'Editar Contador';

    // En edición el correo y contraseña son opcionales (no cambiarlos si se dejan vacíos)
    const emailRow = $id('cont-email-acceso')?.closest('.form-group');
    const passRow  = $id('cont-password')?.closest('.form-group');
    if (emailRow) emailRow.querySelector('label').textContent = 'Correo de acceso (dejar igual si no cambia)';
    if (passRow)  passRow.querySelector('label').textContent  = 'Contraseña (dejar vacía para no cambiar)';

    const saveBtn = document.querySelector('#modal-contador .btn-primary');
    if (saveBtn) saveBtn.textContent = 'Actualizar contador';

    hide('cont-error');
    show('modal-contador');
    setTimeout(() => $id('cont-nombre-firma')?.focus(), 80);
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

function contRncFormat(input) {
  let v = input.value.replace(/[^\d-]/g, '');
  input.value = v;
}

// Consulta genérica de RNC/Cédula en DGII — usada por cualquier formulario
// que tenga un campo de RNC/Cédula (Contadores, Facturación, Compras…).
// inputId: campo con el RNC/Cédula. statusId: línea de estado. nombreId: campo
// de nombre a autocompletar (solo si está vacío). btnId: botón "DGII" (opcional).
const _rncLastByField = {};
async function rncLookup(inputId, statusId, nombreId, btnId) {
  const input  = $id(inputId);
  const status = $id(statusId);
  const btn    = btnId ? $id(btnId) : null;
  if (!input || !status) return;

  const raw = input.value.replace(/\D/g, '');
  if (raw.length < 9 || raw === _rncLastByField[inputId]) return;
  _rncLastByField[inputId] = raw;

  status.style.color = '#64748b';
  status.textContent = '⏳ Consultando DGII…';
  if (btn) btn.disabled = true;

  try {
    const data = await api('GET', `/api/rnc/lookup?id=${raw}`);
    if (!data.found) {
      status.style.color = '#f59e0b';
      status.textContent = '⚠ RNC/Cédula no encontrado en el registro DGII.';
      return;
    }
    const nombre = data.nombre || data.nombreComercial || '';
    const nombreEl = $id(nombreId);
    if (nombreEl && !nombreEl.value.trim()) nombreEl.value = nombre;

    // Formatear RNC con guiones
    let fmt = raw;
    if (raw.length === 9)       fmt = `${raw.slice(0,3)}-${raw.slice(3,8)}-${raw.slice(8)}`;
    else if (raw.length === 11) fmt = `${raw.slice(0,3)}-${raw.slice(3,10)}-${raw.slice(10)}`;
    input.value = fmt;

    const estadoColor = (data.estado || '').toLowerCase().includes('activo') ? '#10b981' : '#f59e0b';
    status.style.color = estadoColor;
    status.textContent = `✓ ${nombre}${data.estado ? ' — ' + data.estado : ''}`;
  } catch (e) {
    status.style.color = '#ef4444';
    status.textContent = '✗ Error al consultar: ' + e.message;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function guardarContador() {
  const showErr = msg => { const e=$id('cont-error'); if(e){e.textContent=msg;e.classList.remove('hidden');} };
  const g = id => ($id(id)?.value || '').trim();
  const nombre_firma    = g('cont-nombre-firma');
  const email_acceso    = g('cont-email-acceso');
  const password_acceso = $id('cont-password')?.value || '';

  if (!nombre_firma) { showErr('El nombre de la firma es obligatorio.'); return; }

  if (_editingContadorId) {
    // Modo edición: solo actualiza datos básicos
    try {
      await api('PUT', `/api/contadores/${_editingContadorId}`, {
        nombre_firma, responsable: g('cont-responsable'),
        rnc: g('cont-rnc'), telefono: g('cont-telefono'),
        correo: g('cont-correo'),
      });
      closeModal('modal-contador');
      showToast('Contador actualizado correctamente.', 'success');
      loadContadores();
    } catch (e) { showErr(e.message); }
    return;
  }

  // Modo creación
  if (!email_acceso || !password_acceso) {
    showErr('Correo de acceso y contraseña son obligatorios.'); return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email_acceso)) {
    showErr('El correo de acceso no tiene un formato válido.'); return;
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

// ── Facturación ────────────────────────────────────────────────────────────
let _allFacturas        = [];
let _currentFacturaId   = null;
let _currentFacturaCache = null;
let _editingFacturaId   = null;
let _facNegocios        = [];
let _facItems           = [];

function fmtCurrency(n) {
  return 'RD$ ' + Number(n || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function loadFacturas() {
  const estado = $id('fac-filter-estado')?.value || '';
  const url    = estado ? `/api/facturas?estado=${encodeURIComponent(estado)}` : '/api/facturas';
  try {
    _allFacturas = await api('GET', url);
    renderFacturasList(_allFacturas);
  } catch (e) { showToast('Error cargando facturas: ' + e.message, 'error'); }
}

function renderFacturasList(list) {
  const tbody = $id('facturas-list');
  if (!tbody) return;
  tbody.innerHTML = list.map(f => `
    <tr>
      <td><code style="font-size:11px">${f.numero}</code></td>
      <td>${f.clienteNombre || '—'}</td>
      <td>${fmtCurrency(f.total)}</td>
      <td><span class="badge badge-${f.estadoVisual || f.estado}">${f.estadoVisual || f.estado}</span></td>
      <td>${fmtDate(f.fechaEmision)}</td>
      <td>${f.fechaVencimiento ? fmtDate(f.fechaVencimiento) : '—'}</td>
      <td><button class="btn-sm" onclick="adminApp.openFactura('${f.id}')">Ver</button></td>
    </tr>`).join('') || '<tr><td colspan="7" style="text-align:center;opacity:.6">Sin facturas</td></tr>';
}

function filterFacturas(q) {
  const lower    = q.toLowerCase();
  const filtered = _allFacturas.filter(f =>
    (f.numero        || '').toLowerCase().includes(lower) ||
    (f.clienteNombre || '').toLowerCase().includes(lower)
  );
  renderFacturasList(filtered);
}

async function ensureFacNegocios() {
  if (_facNegocios.length) return _facNegocios;
  try { _facNegocios = await api('GET', '/api/negocios'); } catch { _facNegocios = []; }
  return _facNegocios;
}

async function openFactura(id) {
  _currentFacturaId = id;
  try {
    const f = await api('GET', `/api/facturas/${id}`);
    _currentFacturaCache = f;
    setText('fdet-numero', f.numero);
    $id('fdet-info').innerHTML = `
      <dl class="info-dl">
        <dt>Cliente</dt><dd>${f.clienteNombre || '—'}</dd>
        <dt>RNC/Cédula</dt><dd>${f.clienteRnc || '—'}</dd>
        <dt>Teléfono</dt><dd>${f.clienteTelefono || '—'}</dd>
        <dt>Estado</dt><dd><span class="badge badge-${f.estado}">${f.estado}</span></dd>
        <dt>Emisión</dt><dd>${fmtDate(f.fechaEmision)}</dd>
        <dt>Vencimiento</dt><dd>${f.fechaVencimiento ? fmtDate(f.fechaVencimiento) : '—'}</dd>
      </dl>`;

    const itemsBody = $id('fdet-items');
    if (itemsBody) {
      itemsBody.innerHTML = (f.items || []).map(it => `
        <tr><td>${it.cantidad}</td><td>${it.descripcion}</td><td>${fmtCurrency(it.precioUnitario)}</td><td>${fmtCurrency(it.monto)}</td></tr>
      `).join('');
    }

    const totalesEl = $id('fdet-totales');
    if (totalesEl) {
      const saldo = f.total - (f.montoPagado || 0);
      totalesEl.innerHTML = `
        Subtotal: ${fmtCurrency(f.subtotal)}<br>
        ${f.descuento ? `Descuento: -${fmtCurrency(f.descuento)}<br>` : ''}
        ${f.aplicaItbis ? `ITBIS: ${fmtCurrency(f.itbis)}<br>` : ''}
        <strong>Total: ${fmtCurrency(f.total)}</strong><br>
        ${f.montoPagado ? `Pagado: ${fmtCurrency(f.montoPagado)}<br>Saldo: ${fmtCurrency(saldo)}` : ''}`;
    }

    const pagosBody = $id('fdet-pagos');
    if (pagosBody) {
      pagosBody.innerHTML = (f.pagos || []).map(p => `
        <tr><td>${fmtCurrency(p.monto)}</td><td>${p.metodo}</td><td>${fmtDate(p.fecha)}</td><td>${p.nota || '—'}</td></tr>
      `).join('') || '<tr><td colspan="4" style="opacity:.6">Sin pagos registrados</td></tr>';
    }

    document.querySelectorAll('.module').forEach(m => m.classList.add('hidden'));
    show('mod-factura-detalle');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

function backToFacturas() {
  _currentFacturaId = null;
  navigateTo('facturacion');
}

async function openNuevaFactura() {
  _editingFacturaId = null;
  _facItems = [{ descripcion: '', cantidad: 1, precioUnitario: 0 }];
  ['fac-cliente-nombre','fac-cliente-rnc','fac-cliente-telefono','fac-cliente-direccion','fac-fecha-vencimiento','fac-notas']
    .forEach(id => { const el = $id(id); if (el) el.value = ''; });
  $id('fac-descuento').value      = 0;
  $id('fac-aplica-itbis').checked = true;
  $id('fac-metodo-pago').value    = 'efectivo';
  setText('modal-factura-title', 'Nueva factura');
  hide('fac-error');
  $id('fac-cliente-rnc-status').textContent = '';
  _rncLastByField['fac-cliente-rnc'] = '';

  const negocios = await ensureFacNegocios();
  const sel = $id('fac-negocio');
  if (sel) {
    sel.innerHTML = '<option value="">Selecciona un negocio…</option>' +
      negocios.map(n => `<option value="${n.id}">${n.businessName || n.businessKey || n.id}</option>`).join('');
    sel.value = '';
  }

  renderFacItems();
  recalcularTotalesFactura();
  show('modal-factura');
}

function onFacNegocioChange() {
  const sel     = $id('fac-negocio');
  const negocio = _facNegocios.find(n => n.id === sel?.value);
  if (!negocio) return;
  const nombreEl = $id('fac-cliente-nombre');
  if (nombreEl && !nombreEl.value.trim()) nombreEl.value = negocio.businessName || negocio.businessKey || '';
}

function renderFacItems() {
  const container = $id('fac-items');
  if (!container) return;
  container.innerHTML = _facItems.map((it, idx) => `
    <div style="display:grid;grid-template-columns:2fr 70px 90px 90px 28px;gap:.4rem;margin-bottom:.4rem;align-items:center">
      <input type="text" placeholder="Descripción" value="${(it.descripcion || '').replace(/"/g,'&quot;')}"
        oninput="adminApp.updateFacItem(${idx},'descripcion',this.value)"
        style="padding:.4rem .5rem;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:#e2e8f0;font-size:.82rem" />
      <input type="number" min="0.01" step="0.01" placeholder="Cant." value="${it.cantidad}"
        oninput="adminApp.updateFacItem(${idx},'cantidad',this.value)"
        style="padding:.4rem .5rem;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:#e2e8f0;font-size:.82rem" />
      <input type="number" min="0" step="0.01" placeholder="Precio" value="${it.precioUnitario}"
        oninput="adminApp.updateFacItem(${idx},'precioUnitario',this.value)"
        style="padding:.4rem .5rem;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:#e2e8f0;font-size:.82rem" />
      <div style="font-size:.8rem;color:#94a3b8;text-align:right">${fmtCurrency((Number(it.cantidad)||0)*(Number(it.precioUnitario)||0))}</div>
      <button type="button" onclick="adminApp.quitarItemFactura(${idx})"
        style="background:none;border:none;color:#ef4444;font-size:1rem;cursor:pointer;padding:0" title="Quitar">✕</button>
    </div>`).join('');
}

function updateFacItem(idx, field, value) {
  if (!_facItems[idx]) return;
  _facItems[idx][field] = field === 'descripcion' ? value : Number(value);
  if (field !== 'descripcion') renderFacItems();
  recalcularTotalesFactura();
}

function agregarItemFactura() {
  _facItems.push({ descripcion: '', cantidad: 1, precioUnitario: 0 });
  renderFacItems();
  recalcularTotalesFactura();
}

function quitarItemFactura(idx) {
  if (_facItems.length <= 1) { showToast('La factura debe tener al menos un ítem.', 'error'); return; }
  _facItems.splice(idx, 1);
  renderFacItems();
  recalcularTotalesFactura();
}

function recalcularTotalesFactura() {
  const subtotal    = _facItems.reduce((sum, it) => sum + (Number(it.cantidad)||0) * (Number(it.precioUnitario)||0), 0);
  const descuento    = Math.max(0, Number($id('fac-descuento')?.value) || 0);
  const aplicaItbis   = $id('fac-aplica-itbis')?.checked ?? true;
  const base         = Math.max(0, subtotal - descuento);
  const itbis        = aplicaItbis ? base * 0.18 : 0;
  const total        = base + itbis;
  const el = $id('fac-totales-preview');
  if (el) {
    el.innerHTML = `Subtotal: ${fmtCurrency(subtotal)}` +
      (descuento  ? ` &nbsp;·&nbsp; Descuento: -${fmtCurrency(descuento)}` : '') +
      (aplicaItbis ? ` &nbsp;·&nbsp; ITBIS: ${fmtCurrency(itbis)}` : '') +
      ` &nbsp;·&nbsp; <strong>Total: ${fmtCurrency(total)}</strong>`;
  }
}

async function editarFacturaActual() {
  if (!_currentFacturaId) return;
  try {
    const f = await api('GET', `/api/facturas/${_currentFacturaId}`);
    if (!['pendiente','parcial'].includes(f.estado)) {
      showToast(`No se puede editar una factura en estado "${f.estado}".`, 'error');
      return;
    }
    _editingFacturaId = f.id;
    _facItems = (f.items || []).map(it => ({ ...it }));

    await ensureFacNegocios();
    const sel = $id('fac-negocio');
    if (sel) {
      sel.innerHTML = '<option value="">Selecciona un negocio…</option>' +
        _facNegocios.map(n => `<option value="${n.id}">${n.businessName || n.businessKey || n.id}</option>`).join('');
      sel.value = f.negocioId || '';
    }

    $id('fac-cliente-nombre').value    = f.clienteNombre || '';
    $id('fac-cliente-rnc').value       = f.clienteRnc || '';
    $id('fac-cliente-telefono').value  = f.clienteTelefono || '';
    $id('fac-cliente-direccion').value = f.clienteDireccion || '';
    $id('fac-descuento').value         = f.descuento || 0;
    $id('fac-aplica-itbis').checked    = f.aplicaItbis !== false;
    $id('fac-metodo-pago').value       = f.metodoPago || 'efectivo';
    $id('fac-fecha-vencimiento').value = f.fechaVencimiento ? String(f.fechaVencimiento).slice(0,10) : '';
    $id('fac-notas').value             = f.notas || '';
    $id('fac-cliente-rnc-status').textContent = '';
    _rncLastByField['fac-cliente-rnc'] = '';

    setText('modal-factura-title', `Editar factura ${f.numero}`);
    hide('fac-error');
    renderFacItems();
    recalcularTotalesFactura();
    show('modal-factura');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

async function guardarFactura() {
  const showErr = msg => { const e = $id('fac-error'); if (e) { e.textContent = msg; e.classList.remove('hidden'); } };
  hide('fac-error');

  const negocioId     = $id('fac-negocio')?.value || '';
  const clienteNombre = ($id('fac-cliente-nombre')?.value || '').trim();
  if (!_editingFacturaId && !negocioId) { showErr('Selecciona un negocio/cliente.'); return; }
  if (!clienteNombre) { showErr('El nombre del cliente es obligatorio.'); return; }
  if (!_facItems.length || _facItems.some(it => !it.descripcion.trim())) {
    showErr('Todos los ítems necesitan una descripción.'); return;
  }

  const payload = {
    negocioId,
    clienteNombre,
    clienteRnc:          $id('fac-cliente-rnc')?.value || '',
    clienteTelefono:     $id('fac-cliente-telefono')?.value || '',
    clienteDireccion:    $id('fac-cliente-direccion')?.value || '',
    items:               _facItems,
    aplicaItbis:         $id('fac-aplica-itbis')?.checked ?? true,
    tasaItbis:           0.18,
    descuento:           Number($id('fac-descuento')?.value) || 0,
    metodoPago:          $id('fac-metodo-pago')?.value || 'efectivo',
    fechaVencimiento:    $id('fac-fecha-vencimiento')?.value || null,
    notas:               $id('fac-notas')?.value || '',
  };

  try {
    if (_editingFacturaId) {
      await api('PUT', `/api/facturas/${_editingFacturaId}`, payload);
      showToast('Factura actualizada.', 'success');
      closeModal('modal-factura');
      openFactura(_editingFacturaId);
    } else {
      const f = await api('POST', '/api/facturas', payload);
      showToast(`Factura ${f.numero} creada.`, 'success');
      closeModal('modal-factura');
      loadFacturas();
      openFactura(f.id);
    }
  } catch (e) { showErr(e.message); }
}

function openRegistrarPago() {
  if (!_currentFacturaId) return;
  $id('pago-monto').value  = '';
  $id('pago-metodo').value = 'efectivo';
  $id('pago-nota').value   = '';
  hide('pago-error');
  show('modal-pago');
}

async function registrarPago() {
  const showErr = msg => { const e = $id('pago-error'); if (e) { e.textContent = msg; e.classList.remove('hidden'); } };
  const monto = Number($id('pago-monto')?.value);
  if (!Number.isFinite(monto) || monto <= 0) { showErr('Ingresa un monto válido.'); return; }
  try {
    await api('POST', `/api/facturas/${_currentFacturaId}/pagos`, {
      monto, metodo: $id('pago-metodo')?.value || 'efectivo', nota: $id('pago-nota')?.value || '',
    });
    closeModal('modal-pago');
    showToast('Pago registrado.', 'success');
    openFactura(_currentFacturaId);
  } catch (e) { showErr(e.message); }
}

function openAnularFactura() {
  if (!_currentFacturaId) return;
  $id('anular-motivo').value = '';
  hide('anular-error');
  show('modal-anular-factura');
}

async function anularFactura() {
  const showErr = msg => { const e = $id('anular-error'); if (e) { e.textContent = msg; e.classList.remove('hidden'); } };
  const motivo = ($id('anular-motivo')?.value || '').trim();
  if (!motivo) { showErr('Indica el motivo de anulación.'); return; }
  try {
    await api('POST', `/api/facturas/${_currentFacturaId}/anular`, { motivo });
    closeModal('modal-anular-factura');
    showToast('Factura anulada.', 'success');
    openFactura(_currentFacturaId);
    loadFacturas();
  } catch (e) { showErr(e.message); }
}

async function fetchFacturaBlob(kind) {
  if (_currentUser) _idToken = await _currentUser.getIdToken();
  const res = await fetch(`/api/facturas/${_currentFacturaId}/${kind}`, {
    headers: { 'Authorization': `Bearer ${_idToken}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.blob();
}

async function descargarFacturaPdf() {
  if (!_currentFacturaId) return;
  try {
    const blob = await fetchFacturaBlob('pdf');
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${_currentFacturaCache?.numero || 'factura'}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (e) { showToast('Error generando PDF: ' + e.message, 'error'); }
}

async function abrirFacturaHtml() {
  if (!_currentFacturaId) return;
  try {
    const blob = await fetchFacturaBlob('html');
    const url  = URL.createObjectURL(blob);
    window.open(url, '_blank');
  } catch (e) { showToast('Error generando vista previa: ' + e.message, 'error'); }
}

// ── Compras ────────────────────────────────────────────────────────────────
let _allCompras      = [];
let _editingCompraId = null;
let _compraItems     = [];
let _pagoCompraId    = null;

async function loadCompras() {
  const estado = $id('compra-filter-estado')?.value || '';
  const url    = estado ? `/api/compras?estado=${encodeURIComponent(estado)}` : '/api/compras';
  try {
    _allCompras = await api('GET', url);
    renderComprasList(_allCompras);
  } catch (e) { showToast('Error cargando compras: ' + e.message, 'error'); }
}

function renderComprasList(list) {
  const tbody = $id('compras-list');
  if (!tbody) return;
  tbody.innerHTML = list.map(c => `
    <tr>
      <td>${c.suplidorNombre || '—'}</td>
      <td>${c.numeroFactura || '—'}</td>
      <td>${fmtCurrency(c.total)}</td>
      <td>${c.tipoPago === 'credito' ? 'Crédito' : 'Contado'}</td>
      <td><span class="badge badge-${c.estado}">${c.estado}</span></td>
      <td>${fmtDate(c.fechaCompra)}</td>
      <td>
        <button class="btn-sm" onclick="adminApp.editarCompra('${c.id}')">${['pendiente','parcial'].includes(c.estado) ? 'Editar' : 'Ver'}</button>
        ${c.tipoPago === 'credito' && c.estado !== 'pagada' ? `<button class="btn-sm btn-success" onclick="adminApp.openPagoCompra('${c.id}')">Pagar</button>` : ''}
        <button class="btn-sm" onclick="adminApp.openAdjuntos('compra','${c.id}','${(c.suplidorNombre||'').replace(/'/g,"\\'")}')">📎</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="7" style="text-align:center;opacity:.6">Sin compras</td></tr>';
}

function filterCompras(q) {
  const lower    = q.toLowerCase();
  const filtered = _allCompras.filter(c =>
    (c.suplidorNombre || '').toLowerCase().includes(lower) ||
    (c.numeroFactura  || '').toLowerCase().includes(lower)
  );
  renderComprasList(filtered);
}

function openNuevaCompra() {
  _editingCompraId = null;
  _compraItems = [{ descripcion: '', cantidad: 1, precioUnitario: 0 }];
  ['compra-suplidor-nombre','compra-suplidor-rnc','compra-numero-factura','compra-comprobante-fiscal','compra-fecha-vencimiento','compra-notas']
    .forEach(id => { const el = $id(id); if (el) el.value = ''; });
  $id('compra-aplica-itbis').checked = true;
  $id('compra-tipo-pago').value      = 'contado';
  $id('compra-metodo-pago').value    = 'efectivo';
  $id('compra-fecha').value          = new Date().toISOString().slice(0,10);
  onCompraTipoPagoChange();
  setText('modal-compra-title', 'Nueva compra');
  hide('compra-error');
  $id('compra-suplidor-rnc-status').textContent = '';
  _rncLastByField['compra-suplidor-rnc'] = '';

  document.querySelectorAll('#modal-compra input, #modal-compra select').forEach(el => { el.disabled = false; });
  const saveBtn = document.querySelector('#modal-compra .btn-primary');
  if (saveBtn) saveBtn.style.display = '';

  renderCompraItems();
  recalcularTotalesCompra();
  show('modal-compra');
}

function onCompraTipoPagoChange() {
  const esCredito = $id('compra-tipo-pago')?.value === 'credito';
  const group = $id('compra-fecha-vencimiento-group');
  if (group) group.style.display = esCredito ? '' : 'none';
}

function renderCompraItems() {
  const container = $id('compra-items');
  if (!container) return;
  container.innerHTML = _compraItems.map((it, idx) => `
    <div style="display:grid;grid-template-columns:2fr 70px 90px 90px 28px;gap:.4rem;margin-bottom:.4rem;align-items:center">
      <input type="text" placeholder="Descripción" value="${(it.descripcion || '').replace(/"/g,'&quot;')}"
        oninput="adminApp.updateCompraItem(${idx},'descripcion',this.value)"
        style="padding:.4rem .5rem;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:#e2e8f0;font-size:.82rem" />
      <input type="number" min="0.01" step="0.01" placeholder="Cant." value="${it.cantidad}"
        oninput="adminApp.updateCompraItem(${idx},'cantidad',this.value)"
        style="padding:.4rem .5rem;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:#e2e8f0;font-size:.82rem" />
      <input type="number" min="0" step="0.01" placeholder="Precio" value="${it.precioUnitario}"
        oninput="adminApp.updateCompraItem(${idx},'precioUnitario',this.value)"
        style="padding:.4rem .5rem;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:#e2e8f0;font-size:.82rem" />
      <div style="font-size:.8rem;color:#94a3b8;text-align:right">${fmtCurrency((Number(it.cantidad)||0)*(Number(it.precioUnitario)||0))}</div>
      <button type="button" onclick="adminApp.quitarItemCompra(${idx})"
        style="background:none;border:none;color:#ef4444;font-size:1rem;cursor:pointer;padding:0" title="Quitar">✕</button>
    </div>`).join('');
}

function updateCompraItem(idx, field, value) {
  if (!_compraItems[idx]) return;
  _compraItems[idx][field] = field === 'descripcion' ? value : Number(value);
  if (field !== 'descripcion') renderCompraItems();
  recalcularTotalesCompra();
}

function agregarItemCompra() {
  _compraItems.push({ descripcion: '', cantidad: 1, precioUnitario: 0 });
  renderCompraItems();
  recalcularTotalesCompra();
}

function quitarItemCompra(idx) {
  if (_compraItems.length <= 1) { showToast('La compra debe tener al menos un ítem.', 'error'); return; }
  _compraItems.splice(idx, 1);
  renderCompraItems();
  recalcularTotalesCompra();
}

function recalcularTotalesCompra() {
  const subtotal    = _compraItems.reduce((sum, it) => sum + (Number(it.cantidad)||0) * (Number(it.precioUnitario)||0), 0);
  const aplicaItbis = $id('compra-aplica-itbis')?.checked ?? true;
  const itbis       = aplicaItbis ? subtotal * 0.18 : 0;
  const total       = subtotal + itbis;
  const el = $id('compra-totales-preview');
  if (el) {
    el.innerHTML = `Subtotal: ${fmtCurrency(subtotal)}` +
      (aplicaItbis ? ` &nbsp;·&nbsp; ITBIS: ${fmtCurrency(itbis)}` : '') +
      ` &nbsp;·&nbsp; <strong>Total: ${fmtCurrency(total)}</strong>`;
  }
}

async function editarCompra(id) {
  try {
    const c = await api('GET', `/api/compras/${id}`);
    const editable = ['pendiente','parcial'].includes(c.estado);
    _editingCompraId = editable ? id : null;
    _compraItems = (c.items || []).map(it => ({ ...it }));

    $id('compra-suplidor-nombre').value    = c.suplidorNombre || '';
    $id('compra-suplidor-rnc').value       = c.suplidorRnc || '';
    $id('compra-numero-factura').value     = c.numeroFactura || '';
    $id('compra-comprobante-fiscal').value = c.comprobanteFiscal || '';
    $id('compra-aplica-itbis').checked     = c.aplicaItbis !== false;
    $id('compra-tipo-pago').value          = c.tipoPago || 'contado';
    $id('compra-metodo-pago').value        = c.metodoPago || 'efectivo';
    $id('compra-fecha').value              = c.fechaCompra ? String(c.fechaCompra).slice(0,10) : '';
    $id('compra-fecha-vencimiento').value  = c.fechaVencimiento ? String(c.fechaVencimiento).slice(0,10) : '';
    $id('compra-notas').value              = c.notas || '';
    onCompraTipoPagoChange();
    $id('compra-suplidor-rnc-status').textContent = '';
    _rncLastByField['compra-suplidor-rnc'] = '';

    setText('modal-compra-title', editable ? `Editar compra — ${c.suplidorNombre}` : `Compra — ${c.suplidorNombre} (solo lectura)`);
    hide('compra-error');
    renderCompraItems();
    recalcularTotalesCompra();

    document.querySelectorAll('#modal-compra input, #modal-compra select').forEach(el => { el.disabled = !editable; });
    const saveBtn = document.querySelector('#modal-compra .btn-primary');
    if (saveBtn) saveBtn.style.display = editable ? '' : 'none';

    show('modal-compra');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

async function guardarCompra() {
  const showErr = msg => { const e = $id('compra-error'); if (e) { e.textContent = msg; e.classList.remove('hidden'); } };
  hide('compra-error');

  const suplidorNombre = ($id('compra-suplidor-nombre')?.value || '').trim();
  if (!suplidorNombre) { showErr('El nombre del suplidor es obligatorio.'); return; }
  if (!_compraItems.length || _compraItems.some(it => !it.descripcion.trim())) {
    showErr('Todos los ítems necesitan una descripción.'); return;
  }

  const payload = {
    suplidorNombre,
    suplidorRnc:        $id('compra-suplidor-rnc')?.value || '',
    numeroFactura:      $id('compra-numero-factura')?.value || '',
    comprobanteFiscal:  $id('compra-comprobante-fiscal')?.value || '',
    items:              _compraItems,
    aplicaItbis:        $id('compra-aplica-itbis')?.checked ?? true,
    tasaItbis:          0.18,
    tipoPago:           $id('compra-tipo-pago')?.value || 'contado',
    metodoPago:         $id('compra-metodo-pago')?.value || 'efectivo',
    fechaCompra:        $id('compra-fecha')?.value || null,
    fechaVencimiento:   $id('compra-fecha-vencimiento')?.value || null,
    notas:              $id('compra-notas')?.value || '',
  };

  try {
    if (_editingCompraId) {
      await api('PUT', `/api/compras/${_editingCompraId}`, payload);
      showToast('Compra actualizada.', 'success');
    } else {
      await api('POST', '/api/compras', payload);
      showToast('Compra registrada.', 'success');
    }
    closeModal('modal-compra');
    loadCompras();
  } catch (e) { showErr(e.message); }
}

function openPagoCompra(id) {
  _pagoCompraId = id;
  $id('pago-compra-monto').value  = '';
  $id('pago-compra-metodo').value = 'efectivo';
  $id('pago-compra-nota').value   = '';
  hide('pago-compra-error');
  show('modal-pago-compra');
}

async function registrarPagoCompra() {
  const showErr = msg => { const e = $id('pago-compra-error'); if (e) { e.textContent = msg; e.classList.remove('hidden'); } };
  const monto = Number($id('pago-compra-monto')?.value);
  if (!Number.isFinite(monto) || monto <= 0) { showErr('Ingresa un monto válido.'); return; }
  try {
    await api('POST', `/api/compras/${_pagoCompraId}/pagos`, {
      monto, metodo: $id('pago-compra-metodo')?.value || 'efectivo', nota: $id('pago-compra-nota')?.value || '',
    });
    closeModal('modal-pago-compra');
    showToast('Pago registrado.', 'success');
    loadCompras();
  } catch (e) { showErr(e.message); }
}

// ── Gastos ─────────────────────────────────────────────────────────────────
let _allGastos      = [];
let _editingGastoId = null;

const GASTO_CATEGORIA_LABELS = {
  luz: 'Luz', internet: 'Internet', alquiler: 'Alquiler', combustible: 'Combustible',
  transporte: 'Transporte', nomina: 'Nómina', mantenimiento: 'Mantenimiento',
  publicidad: 'Publicidad', equipos: 'Equipos', servicios_profesionales: 'Servicios profesionales',
  impuestos: 'Impuestos', oficina: 'Oficina', otros: 'Otros',
};

async function loadGastos() {
  const categoria = $id('gasto-filter-categoria')?.value || '';
  const url = categoria ? `/api/gastos?categoria=${encodeURIComponent(categoria)}` : '/api/gastos';
  try {
    _allGastos = await api('GET', url);
    renderGastosList(_allGastos);
  } catch (e) { showToast('Error cargando gastos: ' + e.message, 'error'); }
}

function renderGastosList(list) {
  const tbody = $id('gastos-list');
  if (!tbody) return;
  tbody.innerHTML = list.map(g => `
    <tr>
      <td>${GASTO_CATEGORIA_LABELS[g.categoria] || g.categoria}</td>
      <td>${g.proveedor || '—'}</td>
      <td>${fmtCurrency(g.monto)}</td>
      <td>${g.metodoPago || '—'}</td>
      <td>${fmtDate(g.fecha)}</td>
      <td>
        <button class="btn-sm" onclick="adminApp.editarGasto('${g.id}')">Editar</button>
        <button class="btn-sm" onclick="adminApp.openAdjuntos('gasto','${g.id}','${(GASTO_CATEGORIA_LABELS[g.categoria] || g.categoria).replace(/'/g,"\\'")}')">📎</button>
        <button class="btn-sm btn-danger" onclick="adminApp.eliminarGasto('${g.id}')">Eliminar</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;opacity:.6">Sin gastos</td></tr>';
}

function filterGastos(q) {
  const lower    = q.toLowerCase();
  const filtered = _allGastos.filter(g =>
    (g.proveedor   || '').toLowerCase().includes(lower) ||
    (g.comprobante || '').toLowerCase().includes(lower)
  );
  renderGastosList(filtered);
}

function openNuevoGasto() {
  _editingGastoId = null;
  ['gasto-proveedor','gasto-comprobante','gasto-monto','gasto-notas'].forEach(id => { const el = $id(id); if (el) el.value = ''; });
  $id('gasto-categoria').value   = 'luz';
  $id('gasto-metodo-pago').value = 'efectivo';
  $id('gasto-fecha').value       = new Date().toISOString().slice(0,10);
  setText('modal-gasto-title', 'Nuevo gasto');
  hide('gasto-error');
  show('modal-gasto');
}

async function editarGasto(id) {
  try {
    const g = await api('GET', `/api/gastos/${id}`);
    _editingGastoId = id;
    $id('gasto-categoria').value   = g.categoria || 'luz';
    $id('gasto-proveedor').value   = g.proveedor || '';
    $id('gasto-comprobante').value = g.comprobante || '';
    $id('gasto-monto').value       = g.monto || '';
    $id('gasto-fecha').value       = g.fecha ? String(g.fecha).slice(0,10) : '';
    $id('gasto-metodo-pago').value = g.metodoPago || 'efectivo';
    $id('gasto-notas').value       = g.notas || '';
    setText('modal-gasto-title', 'Editar gasto');
    hide('gasto-error');
    show('modal-gasto');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

async function guardarGasto() {
  const showErr = msg => { const e = $id('gasto-error'); if (e) { e.textContent = msg; e.classList.remove('hidden'); } };
  hide('gasto-error');

  const monto = Number($id('gasto-monto')?.value);
  if (!Number.isFinite(monto) || monto <= 0) { showErr('Ingresa un monto válido.'); return; }

  const payload = {
    categoria:   $id('gasto-categoria')?.value || 'otros',
    proveedor:   $id('gasto-proveedor')?.value || '',
    comprobante: $id('gasto-comprobante')?.value || '',
    monto,
    fecha:       $id('gasto-fecha')?.value || null,
    metodoPago:  $id('gasto-metodo-pago')?.value || 'efectivo',
    notas:       $id('gasto-notas')?.value || '',
  };

  try {
    if (_editingGastoId) {
      await api('PUT', `/api/gastos/${_editingGastoId}`, payload);
      showToast('Gasto actualizado.', 'success');
    } else {
      await api('POST', '/api/gastos', payload);
      showToast('Gasto registrado.', 'success');
    }
    closeModal('modal-gasto');
    loadGastos();
  } catch (e) { showErr(e.message); }
}

async function eliminarGasto(id) {
  if (!confirm('¿Eliminar este gasto? Esta acción no se puede deshacer.')) return;
  try {
    await api('DELETE', `/api/gastos/${id}`);
    showToast('Gasto eliminado.', 'success');
    loadGastos();
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

// ── Adjuntos (compartido: compras y gastos) ─────────────────────────────────
let _adjEntidadTipo = null;
let _adjEntidadId   = null;

async function openAdjuntos(entidadTipo, entidadId, label) {
  _adjEntidadTipo = entidadTipo;
  _adjEntidadId   = entidadId;
  setText('modal-adjuntos-title', `Adjuntos — ${label || ''}`);
  $id('adj-file-input').value = '';
  $id('adj-upload-status').textContent = '';
  show('modal-adjuntos');
  await loadAdjuntosList();
}

async function loadAdjuntosList() {
  const container = $id('adj-list');
  if (!container) return;
  container.innerHTML = '<p style="opacity:.5;font-size:.82rem">Cargando…</p>';
  try {
    const list = await api('GET', `/api/adjuntos?entidadTipo=${encodeURIComponent(_adjEntidadTipo)}&entidadId=${encodeURIComponent(_adjEntidadId)}`);
    container.innerHTML = list.map(a => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:.5rem .6rem;border-radius:8px;background:rgba(255,255,255,.04);margin-bottom:.35rem">
        <a href="${a.url || '#'}" target="_blank" rel="noopener" style="font-size:.82rem;color:#93c5fd;text-decoration:none">📎 ${a.nombre}</a>
        <button class="btn-sm btn-danger" style="font-size:.72rem;padding:.2rem .5rem" onclick="adminApp.eliminarAdjunto('${a.id}')">Eliminar</button>
      </div>`).join('') || '<p style="opacity:.5;font-size:.82rem">Sin adjuntos.</p>';
  } catch (e) {
    container.innerHTML = `<p style="color:#ef4444;font-size:.82rem">Error: ${e.message}</p>`;
  }
}

function handleAdjuntoFileChange(input) {
  const file = input?.files?.[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { showToast('El archivo debe pesar menos de 10MB.', 'error'); input.value = ''; return; }

  const status = $id('adj-upload-status');
  if (status) status.textContent = 'Subiendo…';

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      await api('POST', '/api/adjuntos', {
        entidadTipo: _adjEntidadTipo, entidadId: _adjEntidadId,
        nombre: file.name, contentType: file.type, dataBase64: e.target.result,
      });
      if (status) status.textContent = '';
      input.value = '';
      showToast('Adjunto subido.', 'success');
      loadAdjuntosList();
    } catch (err) {
      if (status) status.textContent = '';
      showToast('Error subiendo archivo: ' + err.message, 'error');
    }
  };
  reader.readAsDataURL(file);
}

async function eliminarAdjunto(id) {
  if (!confirm('¿Eliminar este adjunto?')) return;
  try {
    await api('DELETE', `/api/adjuntos/${id}`);
    showToast('Adjunto eliminado.', 'success');
    loadAdjuntosList();
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

// ── Flujo Financiero ─────────────────────────────────────────────────────────
async function loadFlujoFinanciero() {
  try {
    const data = await api('GET', '/api/flujo-financiero');
    const r = data.resumenMes || {};
    setText('fl-facturado', fmtCurrency(r.facturado));
    setText('fl-cobrado',   fmtCurrency(r.cobrado));
    setText('fl-compras',   fmtCurrency(r.compras));
    setText('fl-gastos',    fmtCurrency(r.gastos));
    setText('fl-ganancia',  fmtCurrency(r.gananciaEstimada));
    setText('fl-cxc',       fmtCurrency(r.cuentasPorCobrar));
    setText('fl-cxp',       fmtCurrency(r.cuentasPorPagar));

    renderFlujoChart(data.serieMensual || []);

    const cxcBody = $id('fl-cxc-list');
    if (cxcBody) {
      cxcBody.innerHTML = (data.cuentasPorCobrar || []).map(f => `
        <tr>
          <td><a href="#" onclick="adminApp.openFactura('${f.id}');return false" style="color:#93c5fd;text-decoration:none">${f.numero}</a></td>
          <td>${f.clienteNombre || '—'}</td>
          <td>${fmtCurrency(f.saldo)}</td>
          <td>${f.fechaVencimiento ? fmtDate(f.fechaVencimiento) : '—'}</td>
        </tr>`).join('') || '<tr><td colspan="4" style="text-align:center;opacity:.6">Sin cuentas por cobrar</td></tr>';
    }

    const cxpBody = $id('fl-cxp-list');
    if (cxpBody) {
      cxpBody.innerHTML = (data.cuentasPorPagar || []).map(c => `
        <tr>
          <td><a href="#" onclick="adminApp.editarCompra('${c.id}');return false" style="color:#93c5fd;text-decoration:none">${c.suplidorNombre || '—'}</a></td>
          <td>${fmtCurrency(c.saldo)}</td>
          <td>${c.fechaVencimiento ? fmtDate(c.fechaVencimiento) : '—'}</td>
        </tr>`).join('') || '<tr><td colspan="3" style="text-align:center;opacity:.6">Sin cuentas por pagar</td></tr>';
    }
  } catch (e) { showToast('Error cargando flujo financiero: ' + e.message, 'error'); }
}

// Mismo helper que setupCanvas() en js/tesoreria.js — escala el canvas por
// devicePixelRatio para que no se vea borroso en pantallas HiDPI.
function setupFlujoCanvas(canvas, height) {
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

// Puerto de renderTendenciaChart() en js/tesoreria.js (barras dobles
// ingresos/gastos) a granularidad mensual — mismos colores (verde/rojo) para
// mantener el mismo lenguaje visual que el POS principal. tecno-caja-admin no
// tiene toggle claro/oscuro, así que los colores van fijos para tema oscuro.
function renderFlujoChart(serie) {
  const canvas = $id('flujo-chart-mensual');
  if (!canvas) return;
  const { ctx, W, H } = setupFlujoCanvas(canvas, 220);
  const textColor = 'rgba(255,255,255,0.55)';
  const gridColor = 'rgba(255,255,255,0.08)';
  const font = "'Inter', sans-serif";

  const maxV = Math.max(...serie.map(d => Math.max(d.ingresos, d.egresos)), 1) * 1.15;
  const padL = 54, padR = 10, padT = 10, padB = 46;
  const chartW = W - padL - padR, chartH = H - padT - padB;
  const n = serie.length || 1;
  const groupW = chartW / n;

  ctx.strokeStyle = gridColor; ctx.lineWidth = 1;
  ctx.fillStyle = textColor; ctx.font = `10px ${font}`; ctx.textAlign = 'right';
  for (let i = 0; i <= 3; i++) {
    const y = padT + (chartH / 3) * i;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    const val = maxV - (maxV / 3) * i;
    ctx.fillText(val >= 1000 ? `${(val / 1000).toFixed(1)}k` : val.toFixed(0), padL - 8, y + 3);
  }

  if (!serie.length) {
    ctx.textAlign = 'center';
    ctx.fillText('Sin datos aún', W / 2, H / 2);
    return;
  }

  ctx.textAlign = 'center';
  serie.forEach((d, i) => {
    const x = padL + i * groupW;
    const barW = Math.max(2, groupW * 0.32);
    const incH = (d.ingresos / maxV) * chartH;
    const expH = (d.egresos  / maxV) * chartH;
    ctx.fillStyle = '#00E5A0';
    ctx.fillRect(x + groupW * 0.12, padT + chartH - incH, barW, incH);
    ctx.fillStyle = '#FF4B6E';
    ctx.fillRect(x + groupW * 0.12 + barW + 2, padT + chartH - expH, barW, expH);
    ctx.fillStyle = textColor;
    ctx.fillText(d.label || d.mes, x + groupW / 2, H - 30);
  });

  // Leyenda
  ctx.textAlign = 'left';
  ctx.fillStyle = '#00E5A0'; ctx.fillRect(padL, H - 16, 8, 8);
  ctx.fillStyle = textColor; ctx.fillText('Ingresos', padL + 12, H - 8);
  ctx.fillStyle = '#FF4B6E'; ctx.fillRect(padL + 90, H - 16, 8, 8);
  ctx.fillStyle = textColor; ctx.fillText('Compras + Gastos', padL + 102, H - 8);
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
let _papeleraVisible = false;
async function togglePapelera() {
  _papeleraVisible = !_papeleraVisible;
  const section = $id('papelera-section');
  const btn     = $id('btn-ver-papelera');
  if (!section) return;
  if (_papeleraVisible) {
    section.style.display = 'block';
    if (btn) btn.textContent = '✕ Cerrar papelera';
    await loadPapelera();
  } else {
    section.style.display = 'none';
    if (btn) btn.textContent = '🗑️ Papelera';
  }
}

async function loadPapelera() {
  const tbody = $id('papelera-list');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" style="opacity:.5">Cargando…</td></tr>';
  try {
    const items = await api('GET', '/api/papelera');
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="opacity:.5;text-align:center">Papelera vacía</td></tr>';
      return;
    }
    tbody.innerHTML = items.map(n => `
      <tr>
        <td><code style="font-size:.75rem">${n._papeleraId || n.id}</code></td>
        <td>${n.businessName || n.businessKey || '—'}</td>
        <td style="font-size:.78rem;color:#94a3b8">${n._papeleraPor || '—'}</td>
        <td style="font-size:.78rem;color:#94a3b8">${n._papeleraFecha ? new Date(n._papeleraFecha).toLocaleString('es-DO') : '—'}</td>
        <td style="display:flex;gap:.4rem;justify-content:flex-end">
          <button class="btn-sm" style="color:#10b981;border-color:rgba(16,185,129,.4)"
            onclick="adminApp.restaurarNegocio('${n._papeleraId || n.id}')">↩ Restaurar</button>
          <button class="btn-sm btn-danger" style="font-size:.75rem"
            onclick="adminApp.eliminarPermanente('${n._papeleraId || n.id}', '${(n.businessName||'').replace(/'/g,"\\'")}')">
            Borrar definitivo
          </button>
        </td>
      </tr>`).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:#ef4444">Error: ${e.message}</td></tr>`;
  }
}

async function restaurarNegocio(id) {
  try {
    await api('POST', `/api/negocios/${id}/restaurar`);
    showToast('Negocio restaurado correctamente.', 'success');
    await Promise.all([loadPapelera(), loadNegocios()]);
  } catch (e) { showToast('Error al restaurar: ' + e.message, 'error'); }
}

async function eliminarPermanente(id, nombre) {
  if (!confirm(`¿Borrar permanentemente "${nombre}"?\n\nEsto eliminará la licencia, usuarios y datos del negocio de Firebase. NO se puede deshacer.`)) return;
  try {
    await api('DELETE', `/api/papelera/${id}`);
    showToast('Negocio eliminado definitivamente.', 'success');
    await loadPapelera();
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

async function limpiarHuerfanos() {
  const btn = document.querySelector('[onclick="adminApp.limpiarHuerfanos()"]');
  const result = $id('cleanup-result');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Limpiando…'; }
  if (result) result.textContent = '';
  try {
    const data = await api('DELETE', '/api/cleanup/huerfanos');
    if (result) {
      result.style.color = data.deleted > 0 ? '#10b981' : '#94a3b8';
      result.textContent = data.deleted > 0
        ? `✓ ${data.deleted} documento(s) huérfano(s) eliminados correctamente.`
        : 'No se encontraron documentos huérfanos.';
    }
  } catch (e) {
    if (result) { result.style.color = '#ef4444'; result.textContent = 'Error: ' + e.message; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🧹 Limpiar documentos huérfanos'; }
  }
}

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
  loadLogoPreview();
}

// ── Logo de facturación ──────────────────────────────────────────────────────
function setLogoPreview(dataUrl) {
  const img   = $id('logo-preview');
  const empty = $id('logo-preview-empty');
  const btn   = $id('logo-quitar-btn');
  if (dataUrl) {
    img.src = dataUrl;
    img.classList.remove('hidden');
    empty.classList.add('hidden');
    btn.classList.remove('hidden');
  } else {
    img.classList.add('hidden');
    img.src = '';
    empty.classList.remove('hidden');
    btn.classList.add('hidden');
  }
}

async function loadLogoPreview() {
  try {
    const data = await api('GET', '/api/facturas/config/logo');
    setLogoPreview(data.logoDataUrl || null);
  } catch (_) { /* silencioso — no interrumpe la carga del resto de Configuración */ }
}

// Redimensiona en el navegador antes de subir (mismo patrón que
// handleCfgLogoUpload en tecno-caja-contadores/public/js/contadores-app.js) —
// PNG en vez de JPEG para conservar transparencia, típico en logos de empresa.
function handleLogoFileChange(input) {
  const file = input?.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { showToast('Selecciona un archivo de imagen válido.', 'error'); input.value = ''; return; }
  if (file.size > 15 * 1024 * 1024) { showToast('La imagen debe pesar menos de 15MB.', 'error'); input.value = ''; return; }

  const status = $id('logo-status');
  if (status) status.textContent = 'Procesando…';

  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = async () => {
      const MAX = 400;
      let { width, height } = img;
      if (width > MAX || height > MAX) {
        const ratio = Math.min(MAX / width, MAX / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/png');

      try {
        await api('PUT', '/api/facturas/config/logo', { dataUrl });
        setLogoPreview(dataUrl);
        applyBranding(dataUrl);
        if (status) status.textContent = '';
        showToast('Logo actualizado.', 'success');
      } catch (err) {
        if (status) status.textContent = '';
        showToast('Error subiendo el logo: ' + err.message, 'error');
      }
      input.value = '';
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

async function quitarLogo() {
  if (!confirm('¿Quitar el logo de las facturas?')) return;
  try {
    await api('DELETE', '/api/facturas/config/logo');
    setLogoPreview(null);
    applyBranding(null);
    showToast('Logo eliminado.', 'success');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

// ── Utils ──────────────────────────────────────────────────────────────────
function fmtDate(v) {
  if (!v) return '—';
  try {
    let d;
    if (v?.toDate) {
      d = v.toDate(); // Firestore Timestamp en memoria
    } else if (typeof v === 'object' && (v._seconds != null || v.seconds != null)) {
      d = new Date((v._seconds ?? v.seconds) * 1000); // Timestamp serializado como JSON
    } else {
      d = new Date(v);
    }
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' });
  } catch { return '—'; }
}

// ── Exponer al HTML ────────────────────────────────────────────────────────
window.adminApp = {
  doLogin, logout, sendPasswordReset, showLogin, showForgotPassword,
  togglePassword, changePasswordSec, closeModal,
  loadDashboard,
  loadNegocios, filterNegocios, openNegocio, backToNegocios,
  showAsignarContador, hideAsignarContador, buscarContadorAsignar, confirmarAsignarContador,
  saveDeviceLimit, removeDevice, eliminarNegocio, confirmarEliminarNegocio, limpiarHuerfanos,
  togglePapelera, loadPapelera, restaurarNegocio, eliminarPermanente,
  accionLicencia, showRenovar,
  loadLicencias, goNegociosByStatus,
  loadContadores, openNuevoContador, editarContador, guardarContador, contRncFormat, rncLookup,
  suspenderContador, reactivarContador, eliminarContador,
  loadFacturas, filterFacturas, openFactura, backToFacturas, openNuevaFactura, editarFacturaActual,
  onFacNegocioChange, updateFacItem, agregarItemFactura, quitarItemFactura, recalcularTotalesFactura,
  guardarFactura, openRegistrarPago, registrarPago, openAnularFactura, anularFactura,
  descargarFacturaPdf, abrirFacturaHtml,
  loadCompras, filterCompras, openNuevaCompra, onCompraTipoPagoChange, updateCompraItem,
  agregarItemCompra, quitarItemCompra, recalcularTotalesCompra, editarCompra, guardarCompra,
  openPagoCompra, registrarPagoCompra,
  loadGastos, filterGastos, openNuevoGasto, editarGasto, guardarGasto, eliminarGasto,
  openAdjuntos, handleAdjuntoFileChange, eliminarAdjunto,
  loadFlujoFinanciero,
  handleLogoFileChange, quitarLogo,
  loadSolicitudes, abrirSolicitud, responderSolicitud,
  loadActualizaciones, openNuevaVersion, publicarVersion,
  loadAuditoria,
  loadConfigPerfil,
};
