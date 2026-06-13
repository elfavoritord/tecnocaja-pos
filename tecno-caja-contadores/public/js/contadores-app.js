'use strict';
/**
 * Tecno Caja Contadores — Frontend SPA
 * Auth: Firebase Auth cliente + verificación backend
 * Datos: API REST del servidor Express (que filtra por contadorId)
 */

// ── Estado global ──────────────────────────────────────────────────────────
let _fbApp  = null;
let _fbAuth = null;
let _token  = null;
let _perfil = null;
let _allClientes = [];
let _toastTimer = null;
let _solTipoSel = null;
let _currentClienteId = null;

const TIPOS_SOLICITUD = [
  { key: 'activar_licencia',      icon: '🟢', label: 'Activar Licencia' },
  { key: 'renovar_licencia',      icon: '🔄', label: 'Renovar Licencia' },
  { key: 'cambiar_plan',          icon: '📦', label: 'Cambiar Plan' },
  { key: 'soporte_tecnico',       icon: '🛠', label: 'Soporte Técnico' },
  { key: 'error_sistema',         icon: '🚨', label: 'Error del Sistema' },
  { key: 'actualizacion',         icon: '⬆️', label: 'Actualización' },
  { key: 'facturacion_electronica', icon: '🧾', label: 'Facturación Electrónica' },
  { key: 'solicitud_especial',    icon: '⭐', label: 'Solicitud Especial' },
];

// ── API helper ─────────────────────────────────────────────────────────────
async function apiCall(method, path, body) {
  if (!_token) throw new Error('No autenticado.');
  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${_token}`, 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

async function refreshToken() {
  if (!_fbAuth?.currentUser) return;
  _token = await _fbAuth.currentUser.getIdToken(true);
}

// ── Toast ──────────────────────────────────────────────────────────────────
function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  if (!el) return;
  clearTimeout(_toastTimer);
  el.className = `${type}`;
  el.textContent = msg;
  _toastTimer = setTimeout(() => { el.className = 'hidden'; }, 4000);
}

// ── Show/hide helpers ──────────────────────────────────────────────────────
function show(id)  { const el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
function hide(id)  { const el = document.getElementById(id); if (el) el.classList.add('hidden'); }
function $id(id)   { return document.getElementById(id); }
function setText(id, txt) { const el = $id(id); if (el) el.textContent = txt; }

// ── Date formatting ────────────────────────────────────────────────────────
function fmtDate(val) {
  if (!val) return '—';
  try {
    const d = val?.toDate ? val.toDate() : new Date(val._seconds ? val._seconds * 1000 : val);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('es-DO', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return '—'; }
}

function diasLabel(dias) {
  if (dias === null || dias === undefined) return '—';
  if (dias < 0)  return `Vencido (${Math.abs(dias)}d)`;
  if (dias === 0) return 'Hoy';
  return `${dias} días`;
}

function diasClass(dias) {
  if (dias === null || dias === undefined) return '';
  if (dias <= 0)  return 'text-red';
  if (dias <= 7)  return 'text-red';
  if (dias <= 15) return 'text-orange';
  if (dias <= 30) return 'text-orange';
  return 'text-green';
}

function vencimientoFecha(c) {
  const s = String(c.status || '').toLowerCase();
  if (s === 'active') return c.expiresAt || null;
  return c.trialEndsAt || c.expiresAt || null;
}

function statusBadge(s) {
  const m = {
    active: 'badge-active', trial: 'badge-trial',
    expired: 'badge-expired', cancelled: 'badge-cancelled',
    suspended: 'badge-suspended', pending: 'badge-pending',
  };
  const labels = { active: '🟢 Activa', trial: '🟡 Prueba', expired: '🔴 Vencida',
    cancelled: '🔴 Cancelada', suspended: '⚫ Suspendida', pending: '⬜ Pendiente' };
  const cls = m[s] || 'badge-pending';
  return `<span class="badge ${cls}">${labels[s] || s}</span>`;
}

function solBadge(s) {
  const m = {
    pendiente: 'badge-sol-pendiente', en_revision: 'badge-sol-revision',
    aprobada: 'badge-sol-aprobada', rechazada: 'badge-sol-rechazada',
    completada: 'badge-sol-completada', cancelada: 'badge-sol-cancelada',
  };
  return `<span class="badge ${m[s] || ''}">${s}</span>`;
}

// ── Navigation ─────────────────────────────────────────────────────────────
function goto(mod) {
  document.querySelectorAll('.module').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

  const modEl = $id(`mod-${mod}`);
  if (modEl) modEl.classList.add('active');

  const navEl = document.querySelector(`[data-mod="${mod}"]`);
  if (navEl) navEl.classList.add('active');

  // Load data for the module
  if (mod === 'dashboard')       loadDashboard();
  if (mod === 'negocios')        loadClientes();
  if (mod === 'licencias')       loadLicencias();
  if (mod === 'solicitudes')     loadSolicitudes();
  if (mod === 'configuracion')   loadPerfil();
  if (mod === 'actualizaciones') loadActualizaciones();
  if (mod === 'reportes')        loadReportes();
  if (mod === 'facturacion')     loadFacturacion();
}

// ══════════════════════════════════════════════════════════════════════
// FIREBASE INIT & AUTH
// ══════════════════════════════════════════════════════════════════════

async function initApp() {
  try {
    const cfg = await fetch('/api/firebase-config').then(r => r.json());
    if (cfg.error) {
      showLoginError(`Firebase no configurado: ${cfg.error}`);
      return;
    }

    if (!firebase.apps.length) {
      _fbApp  = firebase.initializeApp(cfg);
    } else {
      _fbApp  = firebase.app();
    }
    _fbAuth = firebase.auth();

    // Persistencia según checkbox (si hay sesión guardada usamos local, si no session)
    const savedPersist = localStorage.getItem('tc_cont_persist');
    await _fbAuth.setPersistence(
      savedPersist === 'false'
        ? firebase.auth.Auth.Persistence.SESSION
        : firebase.auth.Auth.Persistence.LOCAL
    );

    _fbAuth.onAuthStateChanged(async (user) => {
      if (user) {
        try {
          _token = await user.getIdToken();
          const profile = await apiCall('POST', '/api/auth/verify', { idToken: _token });
          _perfil = profile;
          showApp(profile);
        } catch (e) {
          showLoginError(e.message);
          _fbAuth.signOut();
        }
      } else {
        showLoginScreen();
      }
    });
  } catch (e) {
    showLoginError(`Error iniciando app: ${e.message}`);
  }
}

function showLoginScreen() {
  hide('screen-app');
  show('screen-login');
}

function showApp(profile) {
  hide('screen-login');
  show('screen-app');

  const nombre = profile.nombre_firma || profile.fullName || profile.email || 'Contador';
  setText('sidebar-nombre', nombre);
  setText('sidebar-email', profile.email || '');
  setText('user-avatar-letter', nombre.charAt(0).toUpperCase());

  goto('dashboard');
}

function showLoginError(msg) {
  const banner = $id('login-error-banner');
  if (banner) { banner.textContent = msg; banner.classList.remove('hidden'); }
}

// ── Login ──────────────────────────────────────────────────────────────────
async function doLogin() {
  const email = $id('inp-email')?.value?.trim();
  const pass  = $id('inp-password')?.value;
  const remember = $id('chk-remember')?.checked !== false;

  const errEl = $id('login-err');
  if (errEl) errEl.classList.add('hidden');

  if (!email || !pass) {
    if (errEl) { errEl.textContent = 'Ingresa correo y contraseña.'; errEl.classList.remove('hidden'); }
    return;
  }

  const btn = $id('btn-login');
  if (btn) { btn.disabled = true; btn.textContent = 'Iniciando sesión…'; }

  try {
    localStorage.setItem('tc_cont_persist', String(remember));
    await _fbAuth.setPersistence(
      remember ? firebase.auth.Auth.Persistence.LOCAL : firebase.auth.Auth.Persistence.SESSION
    );
    await _fbAuth.signInWithEmailAndPassword(email, pass);
    // onAuthStateChanged lo toma desde aquí
  } catch (e) {
    let msg = e.message;
    if (e.code === 'auth/wrong-password' || e.code === 'auth/user-not-found') msg = 'Correo o contraseña incorrectos.';
    if (e.code === 'auth/too-many-requests') msg = 'Demasiados intentos. Espera un momento.';
    if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Iniciar sesión'; }
  }
}

function showForgot() {
  hide('view-login');
  show('view-forgot');
}

function showLogin() {
  hide('view-forgot');
  show('view-login');
}

async function sendReset() {
  const email = $id('inp-email')?.value?.trim();
  const errEl = $id('forgot-err');
  if (!email) {
    if (errEl) { errEl.textContent = 'Ingresa tu correo primero.'; errEl.classList.remove('hidden'); }
    return;
  }
  try {
    await apiCall('POST', '/api/auth/forgot-password', { email });
    toast('Enlace de recuperación enviado.', 'success');
    showLogin();
  } catch (e) {
    if (errEl) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
  }
}

function togglePw() {
  const inp = $id('inp-password');
  if (!inp) return;
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

async function logout() {
  if (!confirm('¿Cerrar sesión?')) return;
  await _fbAuth?.signOut();
  _token = null; _perfil = null; _allClientes = [];
}

// ══════════════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════════════

async function loadDashboard() {
  try {
    await refreshToken();
    const data = await apiCall('GET', '/api/dashboard');
    const { stats, recientes } = data;

    setText('dash-total',    stats.total);
    setText('dash-activas',  stats.activas);
    setText('dash-prueba',   stats.prueba);
    setText('dash-vencidas', stats.vencidas);
    setText('dash-sol',      stats.solicitudesPendientes);
    setText('dash-proximos', stats.proximosVencer.length);

    const badgeSol = $id('nav-badge-sol');
    if (badgeSol) {
      if (stats.solicitudesPendientes > 0) {
        badgeSol.textContent = stats.solicitudesPendientes;
        badgeSol.classList.remove('hidden');
      } else {
        badgeSol.classList.add('hidden');
      }
    }

    // Próximos vencimientos
    const vencEl = $id('dash-venc-list');
    if (vencEl) {
      if (!stats.proximosVencer.length) {
        vencEl.innerHTML = '<div class="empty-state"><div class="empty-icon">🎉</div><div class="empty-text">Sin vencimientos próximos</div></div>';
      } else {
        vencEl.innerHTML = stats.proximosVencer.slice(0, 8).map(v => {
          const cls = v.diasRestantes <= 7 ? 'critico' : v.diasRestantes <= 15 ? '' : 'ok';
          const dCls = v.diasRestantes <= 7 ? 'critico' : v.diasRestantes <= 15 ? 'warn' : 'ok';
          return `<div class="venc-item ${cls}">
            <div>
              <div class="venc-name">${v.businessName}</div>
              <div class="text-sm text-muted">${statusBadge(v.status)}</div>
            </div>
            <div class="venc-dias ${dCls}">${diasLabel(v.diasRestantes)}</div>
          </div>`;
        }).join('');
      }
    }

    // Recientes
    const recEl = $id('dash-recientes');
    if (recEl) {
      if (!recientes.length) {
        recEl.innerHTML = '<div class="empty-state"><div class="empty-icon">👥</div><div class="empty-text">Sin clientes aún</div></div>';
      } else {
        recEl.innerHTML = recientes.map(c => `
          <div class="reciente-item" onclick="app.goto('negocios');setTimeout(()=>app.verCliente('${c.id}'),300)">
            <div class="reciente-icon">🏪</div>
            <div>
              <div class="reciente-name">${c.businessName || '—'}</div>
              <div class="reciente-meta">${c.planCode || '—'} · ${fmtDate(c.syncedAt)}</div>
            </div>
            <div class="reciente-badge">${statusBadge(c.status)}</div>
          </div>`).join('');
      }
    }
  } catch (e) {
    toast('Error cargando dashboard: ' + e.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════════════
// CLIENTES
// ══════════════════════════════════════════════════════════════════════

async function loadClientes() {
  const tbody = $id('clientes-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;color:#5a7099">Cargando…</td></tr>';
  try {
    await refreshToken();
    _allClientes = await apiCall('GET', '/api/clientes');
    renderClientes(_allClientes);
    const countEl = $id('clientes-count');
    if (countEl) countEl.textContent = `${_allClientes.length} negocio(s) asociados a tu firma contable.`;
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#ef4444;padding:20px">${e.message}</td></tr>`;
  }
}

function renderClientes(list) {
  const tbody = $id('clientes-tbody');
  if (!tbody) return;
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:48px;color:#5a7099">
      <div style="font-size:36px;margin-bottom:8px">🏪</div>
      <div>Aún no tienes negocios asociados.</div>
      <div style="font-size:12px;margin-top:4px">Los negocios se asocian desde Tecno Caja POS al elegir "Negocio bajo Contador Asociado".</div>
    </td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(c => {
    const dias  = c.diasRestantes;
    const vence = vencimientoFecha(c);
    return `<tr>
      <td>
        <div style="font-weight:600">${c.businessName || c.businessKey || '—'}</div>
        <div class="td-small" style="font-family:monospace;font-size:10px;color:#5a7099">${c.businessKey || ''}</div>
      </td>
      <td class="td-small">${c.propietario || '—'}</td>
      <td class="td-small">${c.rnc || '—'}</td>
      <td><span style="font-size:12px;background:var(--surface2);padding:3px 8px;border-radius:6px">${c.planCode || c.plan_code || '—'}</span></td>
      <td>${statusBadge(c.status || 'trial')}</td>
      <td class="td-small ${diasClass(dias)}">${fmtDate(vence)}</td>
      <td class="td-small">${fmtDate(c.syncedAt)}</td>
      <td>
        <div style="display:flex;gap:5px;flex-wrap:wrap">
          <button class="btn btn-xs btn-secondary" onclick="app.verCliente('${c.id}')">Ver</button>
          <button class="btn btn-xs btn-secondary" onclick="app.abrirSolicitudModal('${c.id}')">Solicitud</button>
          ${c.telefono ? `<button class="btn btn-xs btn-secondary" onclick="app.contactarNegocio('${(c.telefono||'').replace(/[^0-9]/g,'')}','${(c.businessName||'').replace(/'/g,'')}')">Contactar</button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

function filtrarClientes(q) {
  const lower = q.toLowerCase();
  const filtered = _allClientes.filter(c =>
    (c.businessName || '').toLowerCase().includes(lower) ||
    (c.rnc          || '').toLowerCase().includes(lower) ||
    (c.propietario  || '').toLowerCase().includes(lower) ||
    (c.correo       || '').toLowerCase().includes(lower)
  );
  renderClientes(filtered);
}

function contactarNegocio(tel, nombre) {
  const msg = encodeURIComponent(`Hola ${nombre}, te contacto desde Tecno Caja Contadores.`);
  window.open(`https://wa.me/1${tel}?text=${msg}`, '_blank');
}

async function verCliente(id) {
  _currentClienteId = id;
  goto('cliente-detalle');
  try {
    await refreshToken();
    const [c, hist] = await Promise.all([
      apiCall('GET', `/api/clientes/${id}`),
      apiCall('GET', `/api/licencias/${id}`).catch(() => []),
    ]);

    setText('det-nombre', c.businessName || c.businessKey || id);
    setText('det-key', c.businessKey || id);

    const dias = c.diasRestantes;
    const pct  = dias !== null ? Math.min(100, Math.max(0, (dias / 30) * 100)) : 0;
    const barCls = dias <= 7 ? 'progress-red' : dias <= 15 ? 'progress-orange' : 'progress-green';

    const infoNeg = $id('det-info-negocio');
    if (infoNeg) infoNeg.innerHTML = [
      ['Nombre comercial', c.businessName || '—'],
      ['Razón social',     c.razon_social  || '—'],
      ['RNC / Cédula',     c.rnc           || '—'],
      ['Tipo de negocio',  c.tipo_negocio  || '—'],
      ['Dirección',        c.direccion     || '—'],
      ['Provincia',        c.provincia     || '—'],
    ].map(([k, v]) => `<div class="info-row"><span class="info-key">${k}</span><span class="info-val">${v}</span></div>`).join('');

    const infoLic = $id('det-info-licencia');
    if (infoLic) infoLic.innerHTML = `
      <div style="margin-bottom:12px">${statusBadge(c.status || 'trial')}</div>
      <div class="info-list">
        <div class="info-row"><span class="info-key">Plan</span><span class="info-val">${c.planCode || c.plan_code || '—'}</span></div>
        <div class="info-row"><span class="info-key">Inicio prueba</span><span class="info-val">${fmtDate(c.trialStartedAt)}</span></div>
        <div class="info-row"><span class="info-key">Vencimiento</span><span class="info-val ${diasClass(dias)}">${fmtDate(vencimientoFecha(c))}</span></div>
        <div class="info-row"><span class="info-key">Días restantes</span><span class="info-val ${diasClass(dias)} text-bold">${diasLabel(dias)}</span></div>
      </div>
      ${dias !== null ? `<div class="progress-wrap mt-4"><div class="progress-bar ${barCls}" style="width:${pct}%"></div></div>` : ''}`;

    const infoContacto = $id('det-info-contacto');
    if (infoContacto) infoContacto.innerHTML = [
      ['Propietario', c.propietario || '—'],
      ['Teléfono',    c.telefono    || '—'],
      ['Correo',      c.correo      || '—'],
    ].map(([k, v]) => `<div class="info-row"><span class="info-key">${k}</span><span class="info-val">${v}</span></div>`).join('');

    const infoTec = $id('det-info-tecnico');
    if (infoTec) infoTec.innerHTML = [
      ['Sucursales',   c.cantidad_sucursales || '—'],
      ['Cajas',        c.cantidad_cajas      || '—'],
      ['Business Key', `<code style="font-size:11px">${c.businessKey || c.id}</code>`],
      ['Origen',       c.source              || '—'],
      ['Último sync',  fmtDate(c.syncedAt)],
    ].map(([k, v]) => `<div class="info-row"><span class="info-key">${k}</span><span class="info-val">${v}</span></div>`).join('');

    const hTbody = $id('det-historial-tbody');
    if (hTbody) {
      hTbody.innerHTML = (hist || []).length
        ? (hist || []).map(h => `<tr>
            <td>${h.action || '—'}</td>
            <td>${h.plan || '—'}</td>
            <td class="td-small">${h.activated_by || '—'}</td>
            <td class="td-small">${fmtDate(h.created_at)}</td>
          </tr>`).join('')
        : '<tr><td colspan="4" style="text-align:center;padding:16px;color:#5a7099">Sin historial de licencias</td></tr>';
    }
  } catch (e) {
    toast('Error cargando negocio: ' + e.message, 'error');
    goto('negocios');
  }
}


// ══════════════════════════════════════════════════════════════════════
// LICENCIAS
// ══════════════════════════════════════════════════════════════════════

async function loadLicencias() {
  const tbody = $id('licencias-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:#5a7099">Cargando…</td></tr>';
  try {
    await refreshToken();
    const list = await apiCall('GET', '/api/clientes');
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:36px;color:#5a7099">Sin clientes registrados</td></tr>';
      return;
    }
    tbody.innerHTML = list.map(c => {
      const dias  = c.diasRestantes;
      const vence = vencimientoFecha(c);
      const inicio = c.trialStartedAt || c.syncedAt;
      return `<tr>
        <td style="font-weight:600">${c.businessName || '—'}</td>
        <td><span style="font-size:12px;background:var(--surface2);padding:3px 8px;border-radius:6px">${c.planCode || '—'}</span></td>
        <td>${statusBadge(c.status || 'trial')}</td>
        <td class="td-small">${fmtDate(inicio)}</td>
        <td class="td-small">${fmtDate(vence)}</td>
        <td class="${diasClass(dias)} text-bold">${diasLabel(dias)}</td>
        <td><button class="btn btn-sm btn-secondary" onclick="app.abrirSolicitudModal('${c.id}')">Solicitar</button></td>
      </tr>`;
    }).join('');
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="color:#ef4444;text-align:center;padding:20px">${e.message}</td></tr>`;
  }
}

// ══════════════════════════════════════════════════════════════════════
// SOLICITUDES
// ══════════════════════════════════════════════════════════════════════

async function loadSolicitudes() {
  const tbody = $id('solicitudes-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:#5a7099">Cargando…</td></tr>';
  try {
    await refreshToken();
    const status = $id('filtro-sol-status')?.value || '';
    const url = status ? `/api/solicitudes?status=${encodeURIComponent(status)}` : '/api/solicitudes';
    const list = await apiCall('GET', url);
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:36px;color:#5a7099">Sin solicitudes</td></tr>';
      return;
    }
    tbody.innerHTML = list.map(s => {
      const tipo = TIPOS_SOLICITUD.find(t => t.key === s.tipo);
      return `<tr>
        <td><span style="font-size:13px">${tipo?.icon || '📋'} ${tipo?.label || s.tipo}</span></td>
        <td class="td-small">${s.businessName || '—'}</td>
        <td style="max-width:240px"><div style="font-size:12px;color:#8fa3c2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.descripcion || '—'}</div></td>
        <td>${solBadge(s.status)}</td>
        <td class="td-small">${fmtDate(s.created_at)}</td>
        <td>
          ${s.status === 'pendiente'
            ? `<button class="btn btn-xs btn-danger" onclick="app.cancelarSolicitud('${s.id}')">Cancelar</button>`
            : '—'}
        </td>
      </tr>`;
    }).join('');
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="color:#ef4444;text-align:center;padding:20px">${e.message}</td></tr>`;
  }
}

async function cancelarSolicitud(id) {
  if (!confirm('¿Cancelar esta solicitud?')) return;
  try {
    await refreshToken();
    await apiCall('PUT', `/api/solicitudes/${id}/cancelar`);
    toast('Solicitud cancelada.', 'success');
    loadSolicitudes();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Modal solicitud ────────────────────────────────────────────────────────
function abrirSolicitudModal(clienteId) {
  _solTipoSel = null;

  // Render tipo buttons
  const tiposEl = $id('sol-tipos');
  if (tiposEl) {
    tiposEl.innerHTML = TIPOS_SOLICITUD.map(t => `
      <button class="sol-tipo-btn" data-key="${t.key}" onclick="app.selSolTipo('${t.key}', this)">
        <span class="sol-tipo-icon">${t.icon}</span>${t.label}
      </button>`).join('');
  }

  // Populate cliente select
  const selEl = $id('sol-cliente');
  if (selEl) {
    selEl.innerHTML = '<option value="">— General (sin cliente específico) —</option>' +
      _allClientes.map(c => `<option value="${c.id}" ${c.id === clienteId ? 'selected' : ''}>${c.businessName || c.id}</option>`).join('');
    if (clienteId) selEl.value = clienteId;
  }

  const descEl = $id('sol-descripcion');
  if (descEl) descEl.value = '';

  show('modal-solicitud');
}

function cerrarSolicitudModal() { hide('modal-solicitud'); }

function selSolTipo(key, btn) {
  _solTipoSel = key;
  document.querySelectorAll('.sol-tipo-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
}

async function enviarSolicitud() {
  if (!_solTipoSel) { toast('Selecciona un tipo de solicitud.', 'error'); return; }
  const desc = $id('sol-descripcion')?.value?.trim();
  if (!desc) { toast('La descripción es requerida.', 'error'); return; }

  const selEl = $id('sol-cliente');
  const bizId = selEl?.value || null;
  const bizName = bizId ? selEl.options[selEl.selectedIndex]?.text : null;

  try {
    await refreshToken();
    await apiCall('POST', '/api/solicitudes', {
      tipo: _solTipoSel,
      businessId:   bizId,
      businessName: bizId ? bizName : null,
      descripcion:  desc,
    });
    toast('Solicitud enviada al equipo de Tecno Caja.', 'success');
    cerrarSolicitudModal();
    if ($id('mod-solicitudes')?.classList.contains('active')) loadSolicitudes();
  } catch (e) { toast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════
// PERFIL / CONFIGURACIÓN
// ══════════════════════════════════════════════════════════════════════

async function loadPerfil() {
  try {
    await refreshToken();
    const p = await apiCall('GET', '/api/perfil');
    const setVal = (id, val) => { const el = $id(id); if (el) el.value = val || ''; };
    setVal('cfg-nombre-firma', p.nombre_firma);
    setVal('cfg-responsable', p.responsable);
    setVal('cfg-rnc',        p.rnc);
    setVal('cfg-direccion',  p.direccion);
    setVal('cfg-correo',     p.correo);
    setVal('cfg-telefono',   p.telefono);
    setVal('cfg-whatsapp',   p.whatsapp);
    setVal('cfg-logo',       p.logo_url);
  } catch (e) {
    toast('Error cargando perfil: ' + e.message, 'error');
  }
}

async function savePerfil() {
  try {
    await refreshToken();
    await apiCall('PUT', '/api/perfil', {
      nombre_firma: $id('cfg-nombre-firma')?.value?.trim() || null,
      responsable:  $id('cfg-responsable')?.value?.trim()  || null,
      direccion:    $id('cfg-direccion')?.value?.trim()    || null,
      correo:       $id('cfg-correo')?.value?.trim()       || null,
      telefono:     $id('cfg-telefono')?.value?.trim()     || null,
      whatsapp:     $id('cfg-whatsapp')?.value?.trim()     || null,
      logo_url:     $id('cfg-logo')?.value?.trim()         || null,
    });
    toast('Perfil actualizado correctamente.', 'success');
    const nombre = $id('cfg-nombre-firma')?.value?.trim();
    if (nombre) { setText('sidebar-nombre', nombre); setText('user-avatar-letter', nombre.charAt(0).toUpperCase()); }
  } catch (e) { toast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════
// ACTUALIZACIONES
// ══════════════════════════════════════════════════════════════════════

// ── Estado del auto-updater ───────────────────────────────────────────────
let _updUnsub       = null;
let _updDownloaded  = false;
let _updNewVersion  = null;

function _updSetStatus(icon, titulo, sub, actions = '') {
  setText('upd-status-icon',   icon);
  setText('upd-status-titulo', titulo);
  setText('upd-status-sub',    sub);
  const el = $id('upd-status-actions');
  if (el) el.innerHTML = actions;
}

function _updShowProgress(show) {
  const el = $id('upd-progress-wrap');
  if (el) el.classList.toggle('hidden', !show);
}

function _updSetProgress(pct, speed) {
  const bar = $id('upd-progress-bar');
  if (bar) bar.style.width = pct + '%';
  setText('upd-progress-pct', pct + '%');
  if (speed !== undefined) {
    const mb = (speed / 1024 / 1024).toFixed(1);
    setText('upd-progress-speed', mb + ' MB/s');
  }
}

function _fmtBytes(b) {
  if (!b) return '';
  if (b > 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024).toFixed(0) + ' KB';
}

async function _initUpdaterUI() {
  if (!window.contadoresAPI?.updaterGetVersion) {
    _updSetStatus('🌐', 'Modo web', 'El actualizador automático solo funciona en la app de escritorio.');
    return;
  }

  const info = await window.contadoresAPI.updaterGetVersion();
  setText('upd-ver-actual', 'v' + info.version);

  if (!info.isPackaged) {
    _updSetStatus('🛠', 'Modo desarrollo', 'El actualizador está deshabilitado en modo desarrollo.');
    return;
  }

  // Suscribir a eventos del main process
  if (_updUnsub) _updUnsub();
  _updUnsub = window.contadoresAPI.onUpdaterEvent((event, data) => {
    if (event === 'available') {
      _updNewVersion = data.version;
      _updSetStatus(
        '⬆️',
        `Nueva versión disponible: v${data.version}`,
        'Descarga e instala la actualización para obtener las últimas mejoras.',
        `<button class="btn btn-primary" onclick="app.descargarActualizacion()">⬇ Descargar ahora</button>`
      );
    } else if (event === 'not-available') {
      _updSetStatus('✅', 'Estás al día', 'No hay nuevas versiones disponibles.');
    } else if (event === 'progress') {
      _updShowProgress(true);
      _updSetProgress(data.percent || 0, data.bytesPerSecond);
      _updSetStatus(
        '⬇️',
        `Descargando v${_updNewVersion || ''}…`,
        `${_fmtBytes(data.transferred)} de ${_fmtBytes(data.total)}`
      );
    } else if (event === 'downloaded') {
      _updDownloaded = true;
      _updShowProgress(false);
      _updSetProgress(100);
      _updSetStatus(
        '🎉',
        `v${data.version || _updNewVersion} lista para instalar`,
        'La actualización se descargó. Haz clic para instalar y reiniciar la app.',
        `<button class="btn btn-primary" onclick="app.instalarActualizacion()">⚡ Instalar y reiniciar</button>`
      );
    } else if (event === 'error') {
      _updShowProgress(false);
      _updSetStatus('❌', 'Error al actualizar', data.message || 'Intenta verificar de nuevo.',
        `<button class="btn btn-secondary" onclick="app.verificarActualizacion()">↺ Reintentar</button>`
      );
    }
  });

  _updSetStatus('✅', 'App actualizada', 'Haz clic en "Verificar ahora" para buscar actualizaciones.');
}

async function verificarActualizacion() {
  if (!window.contadoresAPI?.updaterCheck) return;
  _updSetStatus('🔍', 'Verificando…', 'Buscando nuevas versiones en GitHub…');
  const btn = $id('upd-btn-verificar');
  if (btn) btn.disabled = true;
  try {
    await window.contadoresAPI.updaterCheck();
  } catch {
    _updSetStatus('❌', 'Error de conexión', 'No se pudo conectar a GitHub para verificar.');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function descargarActualizacion() {
  if (!window.contadoresAPI?.updaterDownload) return;
  _updShowProgress(true);
  _updSetProgress(0);
  _updSetStatus('⬇️', 'Iniciando descarga…', '');
  try {
    await window.contadoresAPI.updaterDownload();
  } catch {
    _updShowProgress(false);
    _updSetStatus('❌', 'Error al descargar', 'No se pudo iniciar la descarga.',
      `<button class="btn btn-secondary" onclick="app.descargarActualizacion()">↺ Reintentar</button>`
    );
  }
}

function instalarActualizacion() {
  if (!window.contadoresAPI?.updaterInstall) return;
  _updSetStatus('⚡', 'Instalando…', 'La app se cerrará y se instalará la nueva versión.');
  window.contadoresAPI.updaterInstall();
}

async function loadActualizaciones() {
  await _initUpdaterUI();

  const container = $id('actualizaciones-list');
  if (!container) return;
  container.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><div class="empty-text">Cargando…</div></div>';
  try {
    await refreshToken();
    const list = await apiCall('GET', '/api/actualizaciones');
    if (!list.length) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">✅</div><div class="empty-text">Sin versiones publicadas aún</div></div>';
      return;
    }
    container.innerHTML = list.map((v, i) => `
      <div class="ver-card">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <div class="ver-num">v${esc(v.version)}</div>
            ${i === 0 ? '<span class="ver-badge-nueva">✦ Última</span>' : ''}
            ${v.prerelease ? '<span style="background:#f59e0b22;color:#f59e0b;font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px">BETA</span>' : ''}
          </div>
          <div class="ver-date">${fmtDate(v.created_at)}</div>
          ${v.descripcion ? `<div class="ver-desc" style="margin-top:4px;font-size:12px;color:var(--text-sub)">${esc(v.descripcion)}</div>` : ''}
        </div>
        ${v.url ? `<a href="${esc(v.url)}" onclick="event.preventDefault();window.open('${esc(v.url)}','_blank')" class="btn btn-secondary btn-sm" style="white-space:nowrap;align-self:center">Ver release</a>` : ''}
      </div>`).join('');
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><div style="color:#ef4444">Error: ${esc(e.message)}</div></div>`;
  }
}

// ══════════════════════════════════════════════════════════════════════
// REPORTES
// ══════════════════════════════════════════════════════════════════════

let _repNegocioId = null;
let _repTab       = 'ventas';
let _repLoading   = false;

const REP_TABS = {
  ventas:     { label: 'Ventas', cols: ['Fecha','Factura','Cajero','Cliente','Método','Total','ITBIS'] },
  facturas:   { label: 'Facturas', cols: ['Fecha','NCF','Tipo','Cliente','RNC','Total','ITBIS','Estado'] },
  productos:  { label: 'Productos', cols: ['Código','Nombre','Categoría','Precio','Costo','Stock','Vendidos'] },
  inventario: { label: 'Inventario', cols: ['Código','Nombre','Stock','Mínimo','Estado','Última Compra'] },
  itbis:      { label: 'ITBIS', cols: ['Fecha','NCF','Tipo','Base Imponible','ITBIS 18%','Total'] },
  cxc:        { label: 'C×Cobrar', cols: ['Cliente','RNC','Teléfono','Deuda','Última Compra','Estado'] },
  clientes:   { label: 'Clientes', cols: ['Nombre','RNC','Teléfono','Correo','Compras','Última Visita'] },
  cierres:    { label: 'Cierres', cols: ['Apertura','Cierre','Caja','Cajero','Monto Apertura','Ventas','Contado','Diferencia','Estado'] },
  mensual:    { label: 'Mensual', cols: ['Mes','Ventas','Facturas','ITBIS','Clientes Nuevos'] },
};

function fmtMoney(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (isNaN(n)) return '—';
  return 'RD$ ' + n.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function loadReportes() {
  const sel = $id('rep-negocio-select');
  if (!sel) return;

  // Fetch clients if not yet loaded
  if (!_allClientes.length) {
    try {
      await refreshToken();
      _allClientes = await apiCall('GET', '/api/clientes');
    } catch (e) {
      toast('Error cargando negocios: ' + e.message, 'error');
    }
  }

  sel.innerHTML = '<option value="">— Selecciona un negocio —</option>' +
    _allClientes.map(c =>
      `<option value="${c.id}">${c.businessName || c.businessKey || c.id}</option>`
    ).join('');

  if (_repNegocioId) {
    sel.value = _repNegocioId;
    selNegocioReporte(_repNegocioId);
  } else {
    $id('rep-state-empty').style.display = '';
    $id('rep-state-data').style.display  = 'none';
    $id('rep-biz-status').style.display  = 'none';
  }
}

async function selNegocioReporte(id) {
  $id('rep-biz-status').style.display = 'none';
  if (!id) {
    _repNegocioId = null;
    $id('rep-state-empty').style.display = '';
    $id('rep-state-data').style.display  = 'none';
    return;
  }

  _repNegocioId = id;
  $id('rep-state-empty').style.display = 'none';
  $id('rep-state-data').style.display  = '';

  // Show loading state in table
  $id('rep-table-inner').innerHTML = `<div class="rep-loading"><div class="rep-spinner"></div>Cargando datos del negocio…</div>`;
  setText('rep-biz-name', '…');
  setText('rep-biz-meta', '');
  $id('rep-biz-chips').innerHTML = '';

  try {
    await refreshToken();
    const data = await apiCall('GET', `/api/reportes/${id}`);
    renderBizBar(data.negocio);
    renderRepStats(data.stats, data.negocio.hasPosData);
    cargarChartVentas();

    // Selector bar status
    const badge = $id('rep-biz-badge');
    if (badge) {
      badge.className = `badge badge-${data.negocio.status || 'trial'}`;
      const labels = { active:'🟢 Activa', trial:'🟡 Prueba', expired:'🔴 Vencida', suspended:'⚫ Suspendida' };
      badge.textContent = labels[data.negocio.status] || data.negocio.status;
    }
    const syncEl = $id('rep-biz-sync');
    if (syncEl) syncEl.textContent = 'Sync: ' + fmtDate(data.negocio.syncedAt);
    $id('rep-biz-status').style.display = '';

    await cargarDatosReporte();
  } catch (e) {
    $id('rep-table-inner').innerHTML = `<div class="rep-no-sync"><div class="rep-no-sync-icon">⚠️</div><div class="rep-no-sync-title">Error al cargar datos</div><div class="rep-no-sync-sub">${e.message}</div></div>`;
  }
}

function renderBizBar(neg) {
  setText('rep-biz-name', neg.businessName || '—');
  setText('rep-biz-meta', `RNC: ${neg.rnc || '—'}  ·  Propietario: ${neg.propietario || '—'}  ·  Plan: ${neg.planCode || '—'}`);
  const chips = $id('rep-biz-chips');
  if (chips) {
    chips.innerHTML = [
      neg.correo   ? `<span class="rep-biz-chip">✉️ ${neg.correo}</span>`   : '',
      neg.telefono ? `<span class="rep-biz-chip">📞 ${neg.telefono}</span>` : '',
    ].join('');
  }
}

function renderRepStats(stats, hasPosData) {
  const fmt  = v => hasPosData ? fmtMoney(v) : '—';
  const fmtn = v => hasPosData ? (v ?? '—') : '—';
  setText('rs-v-hoy',     fmt(stats.ventasHoy));
  setText('rs-v-mes',     fmt(stats.ventasMes));
  setText('rs-facturas',  fmtn(stats.facturasEmitidas));
  setText('rs-itbis',     fmt(stats.itbisMes));
  setText('rs-prod',      fmtn(stats.productosActivos));
  setText('rs-bajo-inv',  fmtn(stats.bajoInventario));
  setText('rs-cxc',       fmt(stats.cxcPendiente));
  setText('rs-sync',      fmtDate(stats.ultimaSync));
}

function cambiarTabReporte(tab) {
  _repTab = tab;
  document.querySelectorAll('.rep-tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  // Show/hide NCF filter based on tab
  const ncfGroup = $id('rep-f-ncf-group');
  if (ncfGroup) ncfGroup.style.display = (tab === 'facturas' || tab === 'itbis') ? '' : 'none';

  if (_repNegocioId) cargarDatosReporte();
}

async function cargarDatosReporte() {
  if (!_repNegocioId || _repLoading) return;
  _repLoading = true;

  const inner = $id('rep-table-inner');
  if (inner) inner.innerHTML = `<div class="rep-loading"><div class="rep-spinner"></div>Cargando ${REP_TABS[_repTab]?.label || _repTab}…</div>`;

  try {
    const params = new URLSearchParams({ tab: _repTab });
    const desde  = $id('rep-f-desde')?.value;
    const hasta  = $id('rep-f-hasta')?.value;
    const metodo = $id('rep-f-pago')?.value;
    const ncf    = $id('rep-f-ncf')?.value;

    if (desde)  params.set('desde', desde);
    if (hasta)  params.set('hasta', hasta);
    if (metodo) params.set('metodo', metodo);
    if (ncf)    params.set('ncf', ncf);

    await refreshToken();
    const data = await apiCall('GET', `/api/reportes/${_repNegocioId}/datos?${params}`);
    renderTablaReporte(data);
  } catch (e) {
    if (inner) inner.innerHTML = `<div class="rep-no-sync"><div class="rep-no-sync-icon">❌</div><div class="rep-no-sync-title">Error al cargar datos</div><div class="rep-no-sync-sub">${e.message}</div></div>`;
  } finally {
    _repLoading = false;
  }
}

function renderTablaReporte(data) {
  const inner = $id('rep-table-inner');
  if (!inner) return;

  if (!data.hasPosData) {
    inner.innerHTML = `<div class="rep-no-sync">
      <div class="rep-no-sync-icon">🔄</div>
      <div class="rep-no-sync-title">Sin datos sincronizados</div>
      <div class="rep-no-sync-sub">
        Este negocio aún no ha sincronizado sus datos con la plataforma.<br>
        El propietario debe abrir Tecno Caja POS y usar <strong>Configuración → Sincronizar con plataforma</strong>.
      </div>
    </div>`;
    return;
  }

  const cols = REP_TABS[_repTab]?.cols || [];
  if (!data.rows || !data.rows.length) {
    inner.innerHTML = `<div class="rep-no-sync">
      <div class="rep-no-sync-icon">📭</div>
      <div class="rep-no-sync-title">Sin resultados</div>
      <div class="rep-no-sync-sub">No hay datos para los filtros seleccionados.</div>
    </div>`;
    return;
  }

  const thead = `<thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${data.rows.map(row => renderFila(row, _repTab)).join('')}</tbody>`;
  inner.innerHTML = `<table class="data-table">${thead}${tbody}</table>`;
}

function renderFila(row, tab) {
  let cells = [];
  switch (tab) {
    case 'ventas':
      cells = [
        `<td class="td-date">${fmtDate(row.fecha)}</td>`,
        `<td class="td-ncf">${row.factura || row.ncf || '—'}</td>`,
        `<td>${row.cajero || '—'}</td>`,
        `<td>${row.cliente || '—'}</td>`,
        `<td>${row.metodo_pago || '—'}</td>`,
        `<td class="td-amount">${fmtMoney(row.total)}</td>`,
        `<td class="td-amount">${fmtMoney(row.itbis)}</td>`,
      ]; break;
    case 'facturas':
      cells = [
        `<td class="td-date">${fmtDate(row.fecha)}</td>`,
        `<td class="td-ncf">${row.ncf || '—'}</td>`,
        `<td>${row.tipo_ncf || '—'}</td>`,
        `<td>${row.cliente || '—'}</td>`,
        `<td class="td-ncf">${row.rnc || '—'}</td>`,
        `<td class="td-amount">${fmtMoney(row.total)}</td>`,
        `<td class="td-amount">${fmtMoney(row.itbis)}</td>`,
        `<td>${row.estado || '—'}</td>`,
      ]; break;
    case 'productos':
      cells = [
        `<td class="td-ncf">${row.codigo || '—'}</td>`,
        `<td style="font-weight:600">${row.nombre || '—'}</td>`,
        `<td>${row.categoria || '—'}</td>`,
        `<td class="td-amount">${fmtMoney(row.precio)}</td>`,
        `<td class="td-amount">${fmtMoney(row.costo)}</td>`,
        `<td style="text-align:center">${row.stock ?? '—'}</td>`,
        `<td style="text-align:center">${row.vendidos ?? '—'}</td>`,
      ]; break;
    case 'inventario':
      cells = [
        `<td class="td-ncf">${row.codigo || '—'}</td>`,
        `<td style="font-weight:600">${row.nombre || '—'}</td>`,
        `<td style="text-align:center">${row.stock ?? '—'}</td>`,
        `<td style="text-align:center">${row.minimo ?? '—'}</td>`,
        `<td>${row.estado || '—'}</td>`,
        `<td class="td-date">${fmtDate(row.ultima_compra)}</td>`,
      ]; break;
    case 'itbis':
      cells = [
        `<td class="td-date">${fmtDate(row.fecha)}</td>`,
        `<td class="td-ncf">${row.ncf || '—'}</td>`,
        `<td>${row.tipo_ncf || '—'}</td>`,
        `<td class="td-amount">${fmtMoney(row.base_imponible)}</td>`,
        `<td class="td-amount">${fmtMoney(row.itbis)}</td>`,
        `<td class="td-amount">${fmtMoney(row.total)}</td>`,
      ]; break;
    case 'cxc':
      cells = [
        `<td style="font-weight:600">${row.cliente || '—'}</td>`,
        `<td class="td-ncf">${row.rnc || '—'}</td>`,
        `<td>${row.telefono || '—'}</td>`,
        `<td class="td-amount" style="color:#f59e0b;font-weight:700">${fmtMoney(row.deuda)}</td>`,
        `<td class="td-date">${fmtDate(row.ultima_compra)}</td>`,
        `<td>${row.estado || '—'}</td>`,
      ]; break;
    case 'clientes':
      cells = [
        `<td style="font-weight:600">${row.nombre || '—'}</td>`,
        `<td class="td-ncf">${row.rnc || '—'}</td>`,
        `<td>${row.telefono || '—'}</td>`,
        `<td>${row.correo || '—'}</td>`,
        `<td style="text-align:center">${row.compras ?? '—'}</td>`,
        `<td class="td-date">${fmtDate(row.ultima_visita)}</td>`,
      ]; break;
    case 'cierres':
      cells = [
        `<td class="td-date">${fmtDate(row.fecha_apertura)}</td>`,
        `<td class="td-date">${row.fecha_cierre ? fmtDate(row.fecha_cierre) : '<span style="color:#10b981;font-size:11px">Abierta</span>'}</td>`,
        `<td>${row.caja || '—'}</td>`,
        `<td>${row.cajero_apertura || row.cajero_cierre || '—'}</td>`,
        `<td class="td-amount">${fmtMoney(row.monto_apertura)}</td>`,
        `<td class="td-amount">${fmtMoney(row.total_ventas)}</td>`,
        `<td class="td-amount">${fmtMoney(row.monto_contado)}</td>`,
        `<td class="td-amount" style="${Number(row.diferencia || 0) < 0 ? 'color:#ef4444' : ''}">${fmtMoney(row.diferencia)}</td>`,
        `<td>${row.estado || '—'}</td>`,
      ]; break;
    case 'mensual':
      cells = [
        `<td style="font-weight:600">${row.mes || '—'}</td>`,
        `<td class="td-amount">${fmtMoney(row.ventas)}</td>`,
        `<td style="text-align:center">${row.facturas ?? '—'}</td>`,
        `<td class="td-amount">${fmtMoney(row.itbis)}</td>`,
        `<td style="text-align:center">${row.clientes_nuevos ?? '—'}</td>`,
      ]; break;
    default:
      cells = Object.values(row).map(v => `<td>${v ?? '—'}</td>`);
  }
  return `<tr>${cells.join('')}</tr>`;
}

function aplicarFiltros() {
  if (_repNegocioId) cargarDatosReporte();
}

function limpiarFiltros() {
  ['rep-f-desde','rep-f-hasta','rep-f-cajero'].forEach(id => {
    const el = $id(id); if (el) el.value = '';
  });
  ['rep-f-sucursal','rep-f-ncf','rep-f-pago'].forEach(id => {
    const el = $id(id); if (el) el.value = '';
  });
  if (_repNegocioId) cargarDatosReporte();
}

function exportarCSV() {
  const table = $id('rep-table-inner')?.querySelector('table');
  if (!table) { toast('No hay datos para exportar.', 'error'); return; }

  const rows = [];
  table.querySelectorAll('tr').forEach(tr => {
    const cells = [];
    tr.querySelectorAll('th,td').forEach(td => {
      let v = td.textContent.trim().replace(/"/g, '""');
      cells.push(`"${v}"`);
    });
    rows.push(cells.join(','));
  });

  const neg = _allClientes.find(c => c.id === _repNegocioId);
  const nombre = (neg?.businessName || 'negocio').replace(/[^a-zA-Z0-9]/g, '_');
  const fecha  = new Date().toISOString().slice(0, 10);
  const csv    = '﻿' + rows.join('\n'); // BOM for Excel
  const blob   = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement('a');
  a.href = url; a.download = `reporte_${_repTab}_${nombre}_${fecha}.csv`;
  a.click(); URL.revokeObjectURL(url);
  toast('CSV exportado correctamente.', 'success');
}

function imprimirReporte() {
  window.print();
}

function actualizarReporte() {
  if (_repNegocioId) selNegocioReporte(_repNegocioId);
}

// ══════════════════════════════════════════════════════════════════════
// REPORTES — modal detalle + gráfico + impresión
// ══════════════════════════════════════════════════════════════════════

let _repChart = null;

async function cargarChartVentas() {
  if (!_repNegocioId) return;
  try {
    const data = await apiCall('GET', `/api/reportes/${_repNegocioId}/datos?tab=ventas`);
    renderRepChart(data.rows || []);
  } catch { /* chart not critical */ }
}

function renderRepChart(rows) {
  const canvas = $id('rep-sales-chart');
  const emptyEl = $id('rep-chart-empty');
  if (!canvas || !window.Chart) return;

  // Agrupar por fecha (YYYY-MM-DD) y sumar totales
  const byDate = {};
  for (const row of rows) {
    const date = (row.fecha || '').slice(0, 10);
    if (!date) continue;
    byDate[date] = (byDate[date] || 0) + (Number(row.total) || 0);
  }
  const labels = Object.keys(byDate).sort();

  if (!labels.length) {
    canvas.style.display = 'none';
    if (emptyEl) emptyEl.style.display = '';
    return;
  }
  canvas.style.display = '';
  if (emptyEl) emptyEl.style.display = 'none';

  const values = labels.map(d => Math.round(byDate[d] * 100) / 100);
  const total  = values.reduce((a, b) => a + b, 0);
  setText('rep-chart-total', 'Total: ' + fmtMoney(total));

  const fmt = d => {
    try { return new Date(d + 'T12:00:00').toLocaleDateString('es-DO', { day: '2-digit', month: 'short' }); }
    catch { return d; }
  };

  if (_repChart) { _repChart.destroy(); _repChart = null; }
  _repChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: labels.map(fmt),
      datasets: [{
        label: 'Ventas',
        data: values,
        backgroundColor: 'rgba(59,130,246,0.45)',
        borderColor: '#3b82f6',
        borderWidth: 1,
        borderRadius: 4,
        hoverBackgroundColor: 'rgba(59,130,246,0.7)',
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => 'RD$ ' + (ctx.parsed.y || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
          },
          backgroundColor: '#1a2234',
          titleColor: '#e8edf5',
          bodyColor: '#8fa3c2',
          borderColor: 'rgba(71,100,148,.4)',
          borderWidth: 1,
        },
      },
      scales: {
        x: {
          ticks: { color: '#8fa3c2', font: { size: 10 }, maxRotation: 45, minRotation: 0 },
          grid:  { color: 'rgba(71,100,148,0.15)' },
        },
        y: {
          ticks: {
            color: '#8fa3c2', font: { size: 10 },
            callback: v => 'RD$ ' + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v),
          },
          grid: { color: 'rgba(71,100,148,0.15)' },
          beginAtZero: true,
        },
      },
    },
  });
}

function abrirRepDetalle(tab) {
  const neg = _allClientes.find(c => c.id === _repNegocioId);
  setText('rmd-titulo',    neg?.businessName || 'Reportes detallados');
  setText('rmd-subtitulo', [neg?.rnc ? 'RNC: ' + neg.rnc : '', neg?.propietario ? 'Propietario: ' + neg.propietario : ''].filter(Boolean).join('  ·  '));
  show('modal-rep-detalle');
  cambiarTabReporte(tab || _repTab || 'ventas');
}

function cerrarRepDetalle() {
  hide('modal-rep-detalle');
}

const _REP_TAB_LABELS = {
  ventas: 'Ventas', facturas: 'Facturas NCF', productos: 'Productos',
  inventario: 'Inventario', itbis: 'ITBIS / DGII', cxc: 'Cuentas × Cobrar',
  clientes: 'Clientes', cierres: 'Cierres de Caja', mensual: 'Resumen Mensual',
};

async function imprimirTabReporte() {
  const tableEl = $id('rep-table-inner');
  if (!tableEl) return;
  const neg   = _allClientes.find(c => c.id === _repNegocioId);
  const title = _REP_TAB_LABELS[_repTab] || _repTab || 'Reporte';
  const fecha = new Date().toLocaleDateString('es-DO', { day: '2-digit', month: 'long', year: 'numeric' });
  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
  <title>${title} — ${esc(neg?.businessName || '')}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#1a1a2e;padding:20px}
    .hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:12px;border-bottom:3px solid #3b82f6;margin-bottom:16px}
    h1{font-size:18px;font-weight:800;margin-bottom:3px}
    h2{font-size:13px;color:#5a7099;font-weight:400}
    .badge{display:inline-block;background:#3b82f6;color:#fff;font-size:10px;font-weight:700;padding:3px 10px;border-radius:20px;letter-spacing:.3px;text-transform:uppercase}
    table{width:100%;border-collapse:collapse;margin-top:4px}
    th{background:#3b82f6;color:#fff;padding:7px 10px;font-size:10px;text-align:left;text-transform:uppercase;letter-spacing:.3px}
    td{padding:6px 10px;border-bottom:1px solid #e2e8f0;font-size:11px;vertical-align:middle}
    tr:nth-child(even) td{background:#f8fafc}
    .footer{text-align:center;font-size:10px;color:#94a3b8;margin-top:16px;padding-top:10px;border-top:1px solid #e2e8f0}
  </style></head><body>
  <div class="hdr">
    <div>
      <h1>${esc(neg?.businessName || '—')}</h1>
      <h2>RNC: ${neg?.rnc || '—'} · Plan: ${neg?.planCode || '—'}</h2>
    </div>
    <div style="text-align:right">
      <div class="badge">${title}</div>
      <div style="font-size:11px;color:#5a7099;margin-top:5px">Generado: ${fecha}</div>
    </div>
  </div>
  ${tableEl.innerHTML}
  <div class="footer">Tecno Caja Contadores — Portal de Contadores Asociados</div>
  </body></html>`;

  const slug = (neg?.businessName || 'negocio').replace(/\s+/g, '_').slice(0, 30);
  const filename = `${slug}_${_repTab}_${new Date().toISOString().slice(0,10)}.pdf`;
  await _savePdf(html, filename, true);
}

async function imprimirReporteMensual() {
  const neg     = _allClientes.find(c => c.id === _repNegocioId);
  const tableEl = $id('rep-table-inner');
  const mes     = new Date().toLocaleDateString('es-DO', { month: 'long', year: 'numeric' });
  const fecha   = new Date().toLocaleDateString('es-DO', { day: '2-digit', month: 'long', year: 'numeric' });
  const stats   = [
    ['Ventas hoy',        $id('rs-v-hoy')?.textContent     || '—'],
    ['Ventas del mes',    $id('rs-v-mes')?.textContent     || '—'],
    ['Facturas emitidas', $id('rs-facturas')?.textContent  || '—'],
    ['ITBIS generado',    $id('rs-itbis')?.textContent     || '—'],
    ['Productos vendidos',$id('rs-prod')?.textContent      || '—'],
    ['Bajo inventario',   $id('rs-bajo-inv')?.textContent  || '—'],
    ['Cuentas × cobrar',  $id('rs-cxc')?.textContent      || '—'],
    ['Última sync',       $id('rs-sync')?.textContent      || '—'],
  ];
  const tabTitle = _REP_TAB_LABELS[_repTab] || 'Ventas';

  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
  <title>Reporte Mensual — ${esc(neg?.businessName || '')}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#1a1a2e;padding:22px}
    .hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:14px;border-bottom:3px solid #3b82f6;margin-bottom:18px}
    h1{font-size:20px;font-weight:800;margin-bottom:4px}
    h3{font-size:13px;color:#5a7099;font-weight:400}
    .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:18px}
    .sc{background:#f1f5f9;border:1px solid #e2e8f0;padding:10px 12px;border-radius:8px}
    .sc-lbl{font-size:9px;text-transform:uppercase;color:#64748b;letter-spacing:.4px;margin-bottom:3px}
    .sc-val{font-size:15px;font-weight:700;color:#1d4ed8}
    h2{font-size:13px;font-weight:700;margin-bottom:8px;padding-left:8px;border-left:4px solid #3b82f6}
    table{width:100%;border-collapse:collapse;margin-bottom:16px}
    th{background:#3b82f6;color:#fff;padding:7px 10px;font-size:10px;text-align:left;text-transform:uppercase;letter-spacing:.3px}
    td{padding:6px 10px;border-bottom:1px solid #e2e8f0;font-size:11px;vertical-align:middle}
    tr:nth-child(even) td{background:#f8fafc}
    .footer{text-align:center;font-size:10px;color:#94a3b8;margin-top:16px;padding-top:10px;border-top:1px solid #e2e8f0}
  </style></head><body>
  <div class="hdr">
    <div>
      <h1>${esc(neg?.businessName || 'Negocio')}</h1>
      <h3>Reporte mensual — ${mes} · RNC: ${neg?.rnc || '—'}</h3>
    </div>
    <div style="text-align:right;font-size:11px;color:#5a7099">
      <div style="font-weight:700;font-size:13px;color:#1a1a2e">Tecno Caja Contadores</div>
      <div>${fecha}</div>
    </div>
  </div>
  <div class="stats">
    ${stats.map(([l, v]) => `<div class="sc"><div class="sc-lbl">${l}</div><div class="sc-val">${v}</div></div>`).join('')}
  </div>
  <h2>${tabTitle}</h2>
  ${tableEl ? tableEl.innerHTML : '<p style="color:#64748b">Sin datos cargados</p>'}
  <div class="footer">Tecno Caja Contadores — Portal de Contadores Asociados</div>
  </body></html>`;

  const slug = (neg?.businessName || 'negocio').replace(/\s+/g, '_').slice(0, 30);
  const filename = `${slug}_reporte_mensual_${new Date().toISOString().slice(0, 7)}.pdf`;
  await _savePdf(html, filename, false);
}

// ══════════════════════════════════════════════════════════════════════
// FACTURACIÓN
// ══════════════════════════════════════════════════════════════════════

let _facFacturas  = [];
let _facClientes  = [];
let _facCurId     = null;
let _facCurData   = null;
let _facEditClfId = null;
let _facItems     = [];

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function facNcfDisplay(ncf) {
  if (!ncf || ncf.length < 11) return ncf || '—';
  return ncf.slice(0, 3) + '-' + ncf.slice(3);
}

function facEstadoBadge(estado) {
  const map = {
    pendiente: 'Pendiente',
    pagada:    'Pagada',
    anulada:   'Anulada',
  };
  const lbl = map[estado] || estado || '—';
  return `<span class="fac-estado ${estado || 'pendiente'}">${lbl}</span>`;
}

function calcItemTotal(item) {
  const base = (Number(item.precio) || 0) * Math.max(1, Number(item.cantidad) || 1);
  const desc  = base * ((Number(item.descuento) || 0) / 100);
  const grav  = base - desc;
  return Math.round((grav * (1 + (Number(item.itbis_rate) || 0) / 100)) * 100) / 100;
}

async function loadFacturacion() {
  try {
    const stats = await apiCall('GET', '/api/facturacion/stats');
    setText('fac-s-mes',  fmtMoney(stats.totalMes));
    setText('fac-s-pend', String(stats.pendientes));
    setText('fac-s-pag',  String(stats.pagadas));
    setText('fac-s-gen',  fmtMoney(stats.totalGeneral));
  } catch { /* stats not critical */ }

  try {
    const list = await apiCall('GET', '/api/facturacion/facturas');
    _facFacturas = list;
    renderFacturas(_facFacturas);
  } catch (e) {
    const tb = $id('fac-tbody');
    if (tb) tb.innerHTML = `<tr><td colspan="8" class="td-empty" style="color:var(--red)">Error: ${e.message}</td></tr>`;
  }
}

function renderFacturas(list) {
  const tbody = $id('fac-tbody');
  if (!tbody) return;
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="td-empty">No hay facturas. Crea una con "＋ Nueva Factura".</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(f => `<tr>
    <td class="td-date">${fmtDate(f.fecha)}</td>
    <td><span class="ncf-badge">${facNcfDisplay(f.ncf)}</span></td>
    <td style="font-weight:500;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(f.cliente?.nombre)}">${esc(f.cliente?.nombre) || '—'}</td>
    <td style="font-family:monospace;font-size:11px;color:var(--text-sub)">${f.cliente?.rnc || '—'}</td>
    <td><span style="font-size:11px;background:var(--surface2);padding:2px 8px;border-radius:4px">${f.tipo_ncf || '—'}</span></td>
    <td class="td-amount">${fmtMoney(f.total)}</td>
    <td>${facEstadoBadge(f.estado)}</td>
    <td style="text-align:center">
      <button class="btn btn-xs btn-secondary" onclick="app.verFactura('${f.id}')">Ver</button>
    </td>
  </tr>`).join('');
}

function filtrarFacturas() {
  const estado = ($id('fac-f-estado')?.value || '');
  const tipo   = ($id('fac-f-tipo')?.value   || '');
  const desde  = ($id('fac-f-desde')?.value  || '');
  const hasta  = ($id('fac-f-hasta')?.value  || '');
  let list = _facFacturas;
  if (estado) list = list.filter(f => f.estado   === estado);
  if (tipo)   list = list.filter(f => f.tipo_ncf === tipo);
  if (desde)  list = list.filter(f => (f.fecha || '') >= desde);
  if (hasta)  list = list.filter(f => (f.fecha || '') <= hasta);
  renderFacturas(list);
}

function limpiarFiltrosFac() {
  ['fac-f-estado','fac-f-tipo','fac-f-desde','fac-f-hasta'].forEach(id => {
    const el = $id(id); if (el) el.value = '';
  });
  renderFacturas(_facFacturas);
}

// ── Nueva Factura ─────────────────────────────────────────────────────

async function nuevaFactura() {
  _facItems = [{ descripcion: '', cantidad: 1, precio: 0, descuento: 0, itbis_rate: 18 }];
  const today = new Date().toISOString().slice(0, 10);
  const set = (id, v) => { const el = $id(id); if (el) el.value = v; };
  set('nf-fecha', today);
  ['nf-cli-nombre','nf-cli-rnc','nf-cli-dir','nf-cli-tel','nf-cli-correo','nf-observacion']
    .forEach(id => set(id, ''));
  set('nf-tipo-ncf', 'B02');
  set('nf-condicion', 'contado');
  set('nf-metodo', 'efectivo');

  try {
    // Cargar clientes de facturación propios
    const [clientes, negocios] = await Promise.all([
      apiCall('GET', '/api/facturacion/clientes'),
      _allClientes.length ? Promise.resolve(_allClientes) : apiCall('GET', '/api/clientes').catch(() => []),
    ]);
    _facClientes = clientes;
    if (!_allClientes.length && negocios.length) _allClientes = negocios;

    const sel = $id('nf-cliente-sel');
    if (sel) {
      let html = '<option value="">— Ingresar datos manualmente —</option>';
      if (clientes.length) {
        html += `<optgroup label="Mis clientes de facturación">` +
          clientes.map(c => `<option value="fac_${c.id}">${esc(c.nombre)}${c.rnc ? ' — ' + c.rnc : ''}</option>`).join('') +
          `</optgroup>`;
      }
      if (negocios.length) {
        html += `<optgroup label="Negocios asociados">` +
          negocios.map(n => `<option value="neg_${n.id}">${esc(n.businessName || n.businessKey || n.id)}${n.rnc ? ' — ' + n.rnc : ''}</option>`).join('') +
          `</optgroup>`;
      }
      sel.innerHTML = html;
      sel.value = '';
    }
  } catch { /* no critical */ }

  renderFacItemsTable();
  calcularTotalesFac();
  show('modal-nueva-factura');
}

function cerrarNuevaFactura() { hide('modal-nueva-factura'); }

function selClienteFac(val) {
  if (!val) return;
  const set = (fid, v) => { const el = $id(fid); if (el) el.value = v || ''; };

  if (val.startsWith('fac_')) {
    // Cliente de facturación propio
    const c = _facClientes.find(x => x.id === val.slice(4));
    if (!c) return;
    set('nf-cli-nombre', c.nombre);
    set('nf-cli-rnc',    c.rnc);
    set('nf-cli-dir',    c.direccion);
    set('nf-cli-tel',    c.telefono);
    set('nf-cli-correo', c.correo);
  } else if (val.startsWith('neg_')) {
    // Negocio asociado del contador
    const n = _allClientes.find(x => x.id === val.slice(4));
    if (!n) return;
    set('nf-cli-nombre', n.businessName || n.businessKey || '');
    set('nf-cli-rnc',    n.rnc);
    set('nf-cli-dir',    n.direccion || '');
    set('nf-cli-tel',    n.telefono);
    set('nf-cli-correo', n.correo);
  }
}

function renderFacItemsTable() {
  const tbody = $id('nf-items-body');
  if (!tbody) return;
  tbody.innerHTML = _facItems.map((item, idx) => `<tr id="fac-item-row-${idx}">
    <td>
      <input type="text" class="form-input fac-iinput" list="fac-servicios-list"
        value="${esc(item.descripcion)}" placeholder="Descripción del servicio..."
        oninput="app.facItemSet(${idx},'descripcion',this.value)" />
    </td>
    <td>
      <input type="number" class="form-input fac-iinput" value="${item.cantidad}" min="1" step="1"
        oninput="app.facItemSet(${idx},'cantidad',this.value)" />
    </td>
    <td>
      <input type="number" class="form-input fac-iinput" value="${item.precio}" min="0" step="0.01"
        oninput="app.facItemSet(${idx},'precio',this.value)" />
    </td>
    <td>
      <input type="number" class="form-input fac-iinput" value="${item.descuento}" min="0" max="100" step="1"
        oninput="app.facItemSet(${idx},'descuento',this.value)" />
    </td>
    <td>
      <select class="form-select fac-iinput" onchange="app.facItemSet(${idx},'itbis_rate',this.value)">
        <option value="0"  ${item.itbis_rate ==  0 ? 'selected' : ''}>0%</option>
        <option value="18" ${item.itbis_rate == 18 ? 'selected' : ''}>18%</option>
      </select>
    </td>
    <td class="td-amount" id="fac-item-tot-${idx}">${fmtMoney(calcItemTotal(item))}</td>
    <td>
      <button class="btn-icon-danger" onclick="app.removeItemFac(${idx})" title="Eliminar">✕</button>
    </td>
  </tr>`).join('');
}

function facItemSet(idx, field, value) {
  if (!_facItems[idx]) return;
  _facItems[idx][field] = field === 'descripcion' ? value : (Number(value) || 0);
  const cell = $id(`fac-item-tot-${idx}`);
  if (cell) cell.textContent = fmtMoney(calcItemTotal(_facItems[idx]));
  calcularTotalesFac();
}

function addItemFac() {
  _facItems.push({ descripcion: '', cantidad: 1, precio: 0, descuento: 0, itbis_rate: 18 });
  renderFacItemsTable();
  calcularTotalesFac();
}

function removeItemFac(idx) {
  if (_facItems.length <= 1) { toast('Debe tener al menos un ítem.', 'error'); return; }
  _facItems.splice(idx, 1);
  renderFacItemsTable();
  calcularTotalesFac();
}

function calcularTotalesFac() {
  let sub = 0, desc = 0, itbis = 0;
  for (const item of _facItems) {
    const base = (Number(item.precio) || 0) * Math.max(1, Number(item.cantidad) || 1);
    const d    = base * ((Number(item.descuento) || 0) / 100);
    const grav = base - d;
    sub   += base;
    desc  += d;
    itbis += grav * ((Number(item.itbis_rate) || 0) / 100);
  }
  const total = sub - desc + itbis;
  setText('nf-t-sub',   fmtMoney(sub));
  setText('nf-t-desc',  '— ' + fmtMoney(desc));
  setText('nf-t-itbis', fmtMoney(itbis));
  setText('nf-t-total', fmtMoney(total));
}

async function guardarFactura() {
  const btn = $id('nf-btn-guardar');
  if (btn) { btn.disabled = true; btn.textContent = 'Emitiendo...'; }
  try {
    const get = id => ($id(id)?.value || '').trim();
    const cliente = {
      nombre: get('nf-cli-nombre'), rnc:      get('nf-cli-rnc'),
      direccion: get('nf-cli-dir'), telefono: get('nf-cli-tel'),
      correo:    get('nf-cli-correo'),
    };
    if (!cliente.nombre) { toast('El nombre del cliente es requerido.', 'error'); return; }
    if (!_facItems.some(i => (Number(i.precio) || 0) > 0)) {
      toast('Agrega al menos un ítem con precio mayor a 0.', 'error'); return;
    }

    await apiCall('POST', '/api/facturacion/facturas', {
      cliente,
      tipo_ncf:       get('nf-tipo-ncf'),
      fecha:          get('nf-fecha'),
      condicion_pago: get('nf-condicion'),
      metodo_pago:    get('nf-metodo'),
      observacion:    get('nf-observacion'),
      items: _facItems,
    });

    toast('Factura emitida correctamente.', 'success');
    hide('modal-nueva-factura');
    loadFacturacion();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Emitir Factura'; }
  }
}

// ── Ver Factura ───────────────────────────────────────────────────────

async function verFactura(id) {
  _facCurId = id; _facCurData = null;
  setText('vf-ncf', '...');
  const estEl = $id('vf-estado'); if (estEl) estEl.innerHTML = '';
  const actEl = $id('vf-actions'); if (actEl) actEl.innerHTML = '';
  show('modal-ver-factura');

  try {
    const f = await apiCall('GET', `/api/facturacion/facturas/${id}`);
    _facCurData = f;
    setText('vf-ncf',       facNcfDisplay(f.ncf));
    setText('vf-fecha-lbl', fmtDate(f.fecha));
    if (estEl) estEl.innerHTML = facEstadoBadge(f.estado);

    if (actEl) {
      const btnPagar  = f.estado === 'pendiente'
        ? `<button class="btn btn-secondary btn-sm" onclick="app.marcarPagada()">✅ Pagada</button>` : '';
      const btnAnular = f.estado !== 'anulada'
        ? `<button class="btn btn-danger btn-sm" onclick="app.anularFactura()">🚫 Anular</button>` : '';
      const btnWA = f.cliente?.telefono
        ? `<button class="btn btn-secondary btn-sm" onclick="app.enviarPorWhatsApp()">💬 WhatsApp</button>` : '';
      const btnMail = f.cliente?.correo
        ? `<button class="btn btn-secondary btn-sm" onclick="app.enviarPorCorreo()">✉ Correo</button>` : '';
      actEl.innerHTML =
        `<button class="btn btn-secondary btn-sm" onclick="app.imprimirFactura()">🖨 Imprimir</button>` +
        btnMail + btnWA + btnPagar + btnAnular;
    }

    const content = $id('vf-content');
    if (content) content.innerHTML = buildFacturaView(f);
  } catch (e) {
    toast('Error cargando factura: ' + e.message, 'error');
    hide('modal-ver-factura');
  }
}

function cerrarVerFactura() { hide('modal-ver-factura'); }

function buildFacturaView(f) {
  const items = (f.items || []).map(item => `<tr>
    <td>${esc(item.descripcion) || '—'}</td>
    <td style="text-align:center">${item.cantidad}</td>
    <td class="td-amount">${fmtMoney(item.precio)}</td>
    <td style="text-align:center">${item.descuento > 0 ? item.descuento + '%' : '—'}</td>
    <td style="text-align:center">${item.itbis_rate > 0 ? item.itbis_rate + '%' : '—'}</td>
    <td class="td-amount">${fmtMoney(item.total)}</td>
  </tr>`).join('');

  return `
  <div class="fac-view-grid">
    <div>
      <div class="fac-view-label">Emisor</div>
      <div class="fac-view-val" style="font-weight:700">${esc(f.contador_nombre) || '—'}</div>
      <div class="fac-view-val">RNC: ${f.contador_rnc || '—'}</div>
      <div class="fac-view-val" style="color:var(--text-sub)">${f.contador_tel || ''}${f.contador_tel && f.contador_correo ? ' · ' : ''}${f.contador_correo || ''}</div>
    </div>
    <div>
      <div class="fac-view-label">Cliente</div>
      <div class="fac-view-val" style="font-weight:700">${esc(f.cliente?.nombre) || '—'}</div>
      <div class="fac-view-val">RNC: ${f.cliente?.rnc || '—'}</div>
      ${f.cliente?.direccion ? `<div class="fac-view-val" style="color:var(--text-sub)">${esc(f.cliente.direccion)}</div>` : ''}
      <div class="fac-view-val" style="color:var(--text-sub)">${f.cliente?.telefono || ''}${f.cliente?.telefono && f.cliente?.correo ? ' · ' : ''}${f.cliente?.correo || ''}</div>
    </div>
  </div>
  <div class="fac-view-grid" style="margin-bottom:16px">
    <div><div class="fac-view-label">Condición de pago</div><div class="fac-view-val">${f.condicion_pago || '—'}</div></div>
    <div><div class="fac-view-label">Método de pago</div><div class="fac-view-val">${f.metodo_pago || '—'}</div></div>
  </div>
  <div style="overflow-x:auto;margin-bottom:16px">
    <table class="data-table">
      <thead><tr>
        <th>Descripción</th><th style="text-align:center">Cant.</th>
        <th style="text-align:right">Precio</th><th style="text-align:center">Desc.</th>
        <th style="text-align:center">ITBIS</th><th style="text-align:right">Total</th>
      </tr></thead>
      <tbody>${items}</tbody>
    </table>
  </div>
  <div class="fac-totals-box">
    <div class="fac-total-row"><span>Subtotal</span><span>${fmtMoney(f.subtotal)}</span></div>
    ${(f.descuento_total || 0) > 0 ? `<div class="fac-total-row"><span>Descuento</span><span style="color:var(--red)">— ${fmtMoney(f.descuento_total)}</span></div>` : ''}
    <div class="fac-total-row"><span>ITBIS</span><span>${fmtMoney(f.itbis_total)}</span></div>
    <div class="fac-total-row fac-total-final"><span>Total</span><span>${fmtMoney(f.total)}</span></div>
    ${(f.monto_pagado || 0) > 0 ? `<div class="fac-total-row"><span>Pagado</span><span style="color:var(--green)">${fmtMoney(f.monto_pagado)}</span></div>` : ''}
    ${(f.balance || 0) > 0 ? `<div class="fac-total-row" style="color:var(--orange)"><span>Balance pendiente</span><span>${fmtMoney(f.balance)}</span></div>` : ''}
  </div>
  ${f.observacion ? `<div style="margin-top:12px;padding:10px 14px;background:var(--surface2);border-radius:8px;font-size:13px;color:var(--text-sub)"><strong style="color:var(--text)">Observación:</strong> ${esc(f.observacion)}</div>` : ''}
  `;
}

async function marcarPagada() {
  if (!_facCurId || !_facCurData) return;
  try {
    await apiCall('PUT', `/api/facturacion/facturas/${_facCurId}`, {
      estado: 'pagada', monto_pagado: _facCurData.total || 0,
    });
    toast('Factura marcada como pagada.', 'success');
    verFactura(_facCurId);
    loadFacturacion();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function anularFactura() {
  if (!_facCurId) return;
  if (!confirm('¿Seguro que deseas anular esta factura? Esta acción no se puede deshacer.')) return;
  try {
    await apiCall('PUT', `/api/facturacion/facturas/${_facCurId}`, { estado: 'anulada' });
    toast('Factura anulada correctamente.', 'success');
    verFactura(_facCurId);
    loadFacturacion();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function imprimirFactura() {
  if (!_facCurData) return;
  const f = _facCurData;
  const filas = (f.items || []).map(item => `<tr>
    <td>${esc(item.descripcion)}</td>
    <td style="text-align:center">${item.cantidad}</td>
    <td style="text-align:right">RD$ ${(Number(item.precio)||0).toFixed(2)}</td>
    <td style="text-align:center">${item.descuento > 0 ? item.descuento + '%' : '—'}</td>
    <td style="text-align:center">${item.itbis_rate > 0 ? item.itbis_rate + '%' : '—'}</td>
    <td style="text-align:right">RD$ ${(Number(item.total)||0).toFixed(2)}</td>
  </tr>`).join('');

  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
  <title>Factura ${facNcfDisplay(f.ncf)}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#1a1a2e;padding:24px}
    .inv{max-width:740px;margin:0 auto}
    .inv-top{display:flex;justify-content:space-between;margin-bottom:24px;padding-bottom:16px;border-bottom:3px solid #3b82f6;gap:20px}
    .inv-firma h1{font-size:22px;font-weight:800;color:#1a1a2e;margin-bottom:4px}
    .inv-firma p{margin:2px 0;color:#5a7099;font-size:12px}
    .inv-meta{text-align:right}
    .inv-meta h2{font-size:28px;font-weight:900;color:#3b82f6;letter-spacing:3px;margin-bottom:6px}
    .inv-ncf{font-size:15px;font-weight:700;font-family:monospace;color:#1d4ed8;margin-bottom:4px}
    .inv-meta p{margin:2px 0;font-size:12px;color:#5a7099}
    .clients{display:flex;gap:16px;margin-bottom:20px}
    .cbox{flex:1;background:#f8fafc;border:1px solid #e2e8f0;padding:12px;border-radius:8px}
    .cbox h4{font-size:10px;text-transform:uppercase;color:#64748b;letter-spacing:.5px;margin-bottom:6px}
    .cbox .cname{font-weight:700;font-size:15px;margin-bottom:2px}
    .cbox p{margin:2px 0;font-size:12px;color:#475569}
    table{width:100%;border-collapse:collapse;margin-bottom:16px}
    th{background:#3b82f6;color:#fff;padding:8px 10px;font-size:11px;text-align:left}
    td{padding:8px 10px;border-bottom:1px solid #e8edf5;font-size:12px;vertical-align:middle}
    tr:last-child td{border-bottom:none}
    .totals{display:flex;justify-content:flex-end;margin-bottom:16px}
    .tbox{width:270px}
    .trow{display:flex;justify-content:space-between;padding:5px 0;font-size:13px;border-bottom:1px solid #e8edf5}
    .trow:last-child{border:none;font-size:16px;font-weight:700;color:#3b82f6;padding-top:10px}
    .obs{background:#f8fafc;padding:10px 12px;border-radius:6px;font-size:12px;color:#5a7099;margin-top:12px}
    .footer{text-align:center;font-size:11px;color:#94a3b8;margin-top:24px;padding-top:12px;border-top:1px solid #e8edf5}
    @media print{@page{size:A4;margin:14mm}body{padding:0}}
  </style></head><body>
  <div class="inv">
    <div class="inv-top">
      <div class="inv-firma">
        <h1>${esc(f.contador_nombre || '')}</h1>
        ${f.contador_rnc    ? `<p>RNC: ${f.contador_rnc}</p>` : ''}
        ${f.contador_tel    ? `<p>Tel: ${f.contador_tel}</p>` : ''}
        ${f.contador_correo ? `<p>${f.contador_correo}</p>`   : ''}
      </div>
      <div class="inv-meta">
        <h2>FACTURA</h2>
        <div class="inv-ncf">${facNcfDisplay(f.ncf)}</div>
        <p><strong>Tipo:</strong> ${f.tipo_ncf} — ${f.tipo_ncf_label || ''}</p>
        <p><strong>Fecha:</strong> ${f.fecha || ''}</p>
        <p><strong>Pago:</strong> ${f.condicion_pago || ''} / ${f.metodo_pago || ''}</p>
      </div>
    </div>
    <div class="clients">
      <div class="cbox">
        <h4>Emisor</h4>
        <div class="cname">${esc(f.contador_nombre || '')}</div>
        <p>RNC: ${f.contador_rnc || '—'}</p>
      </div>
      <div class="cbox">
        <h4>Cliente</h4>
        <div class="cname">${esc(f.cliente?.nombre || '—')}</div>
        <p>RNC: ${f.cliente?.rnc || '—'}</p>
        ${f.cliente?.direccion ? `<p>${esc(f.cliente.direccion)}</p>` : ''}
        ${f.cliente?.telefono  ? `<p>Tel: ${f.cliente.telefono}</p>` : ''}
      </div>
    </div>
    <table>
      <thead><tr><th>Descripción</th><th>Cant.</th><th style="text-align:right">Precio</th><th style="text-align:center">Desc.</th><th style="text-align:center">ITBIS</th><th style="text-align:right">Total</th></tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <div class="totals"><div class="tbox">
      <div class="trow"><span>Subtotal</span><span>RD$ ${(f.subtotal||0).toFixed(2)}</span></div>
      ${(f.descuento_total||0)>0?`<div class="trow" style="color:#ef4444"><span>Descuento</span><span>- RD$ ${(f.descuento_total||0).toFixed(2)}</span></div>`:''}
      <div class="trow"><span>ITBIS</span><span>RD$ ${(f.itbis_total||0).toFixed(2)}</span></div>
      <div class="trow"><span>TOTAL</span><span>RD$ ${(f.total||0).toFixed(2)}</span></div>
    </div></div>
    ${f.observacion?`<div class="obs"><strong>Observación:</strong> ${esc(f.observacion)}</div>`:''}
    <div class="footer">Generado por Tecno Caja Contadores — Portal de Contadores</div>
  </div>
  </body></html>`;

  const ncfSlug = (f.ncf || 'FACTURA').replace(/[^A-Z0-9]/gi, '');
  const clientSlug = (f.cliente?.nombre || 'cliente').replace(/\s+/g, '_').slice(0, 20);
  await _savePdf(html, `Factura_${ncfSlug}_${clientSlug}.pdf`, false);
}

async function _savePdf(html, filename, landscape) {
  if (!window.contadoresAPI?.isElectron) {
    toast('Esta función solo está disponible en la app de escritorio.', 'error');
    return;
  }
  try {
    toast('Generando PDF…', 'info');
    const result = await window.contadoresAPI.saveReportPdf(html, filename, landscape);
    if (result.canceled) return;
    if (result.ok) {
      toast('PDF guardado correctamente', 'success');
    } else {
      toast('Error al guardar: ' + (result.error || 'desconocido'), 'error');
    }
  } catch (e) {
    toast('Error al guardar el PDF.', 'error');
  }
}

function enviarPorCorreo() {
  if (!_facCurData) return;
  const f = _facCurData;
  const asunto = encodeURIComponent(`Factura ${facNcfDisplay(f.ncf)} — ${f.contador_nombre || ''}`);
  const cuerpo = encodeURIComponent(`Estimado/a ${f.cliente?.nombre || 'cliente'},\n\nLe enviamos la factura ${facNcfDisplay(f.ncf)} por un total de RD$ ${(f.total||0).toFixed(2)}.\n\nGracias por confiar en nosotros.`);
  window.open(`mailto:${f.cliente?.correo || ''}?subject=${asunto}&body=${cuerpo}`);
}

function enviarPorWhatsApp() {
  if (!_facCurData) return;
  const f    = _facCurData;
  const tel  = (f.cliente?.telefono || '').replace(/\D/g, '');
  const msg  = encodeURIComponent(`Hola ${f.cliente?.nombre || ''}! Le informamos que la factura ${facNcfDisplay(f.ncf)} por RD$ ${(f.total||0).toFixed(2)} está lista. Gracias.`);
  window.open(`https://wa.me/1${tel}?text=${msg}`, '_blank');
}

// ── Clientes de Facturación ───────────────────────────────────────────

async function abrirClientesFac() {
  _facEditClfId = null;
  ['clf-nombre','clf-rnc','clf-direccion','clf-telefono','clf-correo']
    .forEach(id => { const el = $id(id); if (el) el.value = ''; });
  setText('clf-form-title', 'Nuevo cliente');
  show('modal-clientes-fac');
  await loadClientesFac();
}

function cerrarClientesFac() { hide('modal-clientes-fac'); }

async function loadClientesFac() {
  try {
    const list = await apiCall('GET', '/api/facturacion/clientes');
    _facClientes = list;
    renderClientesFac(list);
  } catch (e) {
    const el = $id('clf-lista');
    if (el) el.innerHTML = `<div style="color:var(--red);padding:16px">Error: ${e.message}</div>`;
  }
}

function renderClientesFac(list) {
  const el = $id('clf-lista');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-muted)">Aún no hay clientes. Completa el formulario de arriba para agregar uno.</div>';
    return;
  }
  el.innerHTML = list.map(c => `<div class="clf-item">
    <div class="clf-item-info">
      <div class="clf-item-name">${esc(c.nombre)}</div>
      <div class="clf-item-meta">${c.rnc ? 'RNC: ' + c.rnc : ''}${c.rnc && c.telefono ? ' · ' : ''}${c.telefono || ''}</div>
    </div>
    <div class="clf-item-actions">
      <button class="btn btn-xs btn-secondary" onclick="app.editarClienteFac('${c.id}')">Editar</button>
      <button class="btn btn-xs btn-danger"    onclick="app.eliminarClienteFac('${c.id}')">Eliminar</button>
    </div>
  </div>`).join('');
}

function nuevoClienteFac() {
  _facEditClfId = null;
  setText('clf-form-title', 'Nuevo cliente');
  ['clf-nombre','clf-rnc','clf-direccion','clf-telefono','clf-correo']
    .forEach(id => { const el = $id(id); if (el) el.value = ''; });
  $id('clf-nombre')?.focus();
}

function editarClienteFac(id) {
  const c = _facClientes.find(x => x.id === id);
  if (!c) return;
  _facEditClfId = id;
  setText('clf-form-title', 'Editar cliente');
  const set = (fid, v) => { const el = $id(fid); if (el) el.value = v || ''; };
  set('clf-nombre',    c.nombre);
  set('clf-rnc',       c.rnc);
  set('clf-direccion', c.direccion);
  set('clf-telefono',  c.telefono);
  set('clf-correo',    c.correo);
  $id('clf-nombre')?.focus();
}

async function guardarClienteFac() {
  const get  = id => ($id(id)?.value || '').trim();
  const nombre = get('clf-nombre');
  if (!nombre) { toast('El nombre es requerido.', 'error'); return; }
  const data = { nombre, rnc: get('clf-rnc'), direccion: get('clf-direccion'), telefono: get('clf-telefono'), correo: get('clf-correo') };
  try {
    if (_facEditClfId) {
      await apiCall('PUT', `/api/facturacion/clientes/${_facEditClfId}`, data);
      toast('Cliente actualizado.', 'success');
    } else {
      await apiCall('POST', '/api/facturacion/clientes', data);
      toast('Cliente guardado.', 'success');
    }
    _facEditClfId = null;
    setText('clf-form-title', 'Nuevo cliente');
    ['clf-nombre','clf-rnc','clf-direccion','clf-telefono','clf-correo']
      .forEach(id => { const el = $id(id); if (el) el.value = ''; });
    await loadClientesFac();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

function cancelarClienteFac() {
  _facEditClfId = null;
  setText('clf-form-title', 'Nuevo cliente');
  ['clf-nombre','clf-rnc','clf-direccion','clf-telefono','clf-correo']
    .forEach(id => { const el = $id(id); if (el) el.value = ''; });
}

async function eliminarClienteFac(id) {
  if (!confirm('¿Eliminar este cliente? No se puede deshacer.')) return;
  try {
    await apiCall('DELETE', `/api/facturacion/clientes/${id}`);
    toast('Cliente eliminado.', 'success');
    await loadClientesFac();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════
// EXPORT — accesible desde HTML (onclick)
// ══════════════════════════════════════════════════════════════════════

window.app = {
  // auth
  doLogin, showForgot, showLogin, sendReset, togglePw, logout,
  // nav
  goto,
  // dashboard
  loadDashboard,
  // negocios
  loadClientes, filtrarClientes, verCliente, contactarNegocio,
  // licencias
  loadLicencias,
  // solicitudes
  loadSolicitudes, cancelarSolicitud,
  abrirSolicitudModal, cerrarSolicitudModal, selSolTipo, enviarSolicitud,
  // perfil
  loadPerfil, savePerfil,
  // actualizaciones
  loadActualizaciones, verificarActualizacion, descargarActualizacion, instalarActualizacion,
  // reportes
  loadReportes, selNegocioReporte, cambiarTabReporte, cargarDatosReporte,
  aplicarFiltros, limpiarFiltros, exportarCSV, imprimirReporte, actualizarReporte,
  abrirRepDetalle, cerrarRepDetalle, imprimirTabReporte, imprimirReporteMensual,
  // facturación — dashboard
  loadFacturacion, filtrarFacturas, limpiarFiltrosFac,
  // facturación — nueva factura
  nuevaFactura, cerrarNuevaFactura, selClienteFac,
  addItemFac, removeItemFac, facItemSet, guardarFactura,
  // facturación — ver factura
  verFactura, cerrarVerFactura, marcarPagada, anularFactura,
  imprimirFactura, enviarPorCorreo, enviarPorWhatsApp,
  // facturación — clientes
  abrirClientesFac, cerrarClientesFac,
  nuevoClienteFac, editarClienteFac, guardarClienteFac, cancelarClienteFac, eliminarClienteFac,
  // estado
  get currentClienteId() { return _currentClienteId; },
};

// ── Iniciar app ────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', initApp);
