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

// Exponer token para rnc-lookup.js y otros scripts externos
window.getTecnoCajaContToken = () => _token || '';
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
  if (mod === 'dashboard')        loadDashboard();
  if (mod === 'negocios')         loadClientes();
  if (mod === 'licencias')        loadLicencias();
  if (mod === 'solicitudes')      loadSolicitudes();
  if (mod === 'configuracion')    loadPerfil();
  if (mod === 'actualizaciones')  loadActualizaciones();
  if (mod === 'reportes')         loadReportes();
  if (mod === 'facturacion')      loadFacturacion();
  if (mod === 'colaboradores')    loadColaboradores();
  if (mod === 'analisis-global')  loadAnalisisGlobal();
  if (mod === 'centro-fiscal')    loadCentroFiscal();
  if (mod === 'alertas')          loadAlertas();
  if (mod === 'contabilidad')     loadContabilidad();
}

// ══════════════════════════════════════════════════════════════════════
// FIREBASE INIT & AUTH
// ══════════════════════════════════════════════════════════════════════

async function _verifyWithRetry(token, attempts = 4, delay = 1200) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await apiCall('POST', '/api/auth/verify', { idToken: token });
    } catch (e) {
      if (e.message === 'Failed to fetch' && i < attempts - 1) {
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw e;
      }
    }
  }
}

// Aviso global de actualización — a diferencia de _initUpdaterUI() (que solo
// se suscribe cuando el usuario entra a la pantalla "Actualizaciones"), esto
// corre desde que arranca la app, en cualquier pantalla (incluso antes de
// iniciar sesión), igual que el POS: si el aviso llega mientras el usuario
// está en otro módulo, no se pierde. Con autoDownload=true (main.js) el
// evento 'downloaded' puede llegar minutos después de abrir la app sin que
// el usuario haya tocado nada.
function _initGlobalUpdaterListener() {
  if (!window.contadoresAPI?.onUpdaterEvent) return;
  window.contadoresAPI.onUpdaterEvent((event, data) => {
    const banner = $id('global-update-banner');
    if (!banner) return;
    if (event === 'downloaded') {
      $id('global-update-banner-text').textContent = `Nueva versión v${data.version || ''} lista para instalar.`;
      banner.style.display = 'flex';
    } else if (event === 'error' && banner.style.display !== 'none') {
      // Si ya se estaba mostrando el aviso de descarga y algo falló, no lo
      // ocultamos a la fuerza — el usuario puede reintentar desde ahí mismo.
    }
  });
}

function instalarActualizacionGlobal() {
  const banner = $id('global-update-banner');
  if (banner) banner.style.display = 'none';
  instalarActualizacion();
}

async function initApp() {
  _initGlobalUpdaterListener();
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
          const profile = await _verifyWithRetry(_token);
          _perfil = profile;
          showApp(profile);
        } catch (e) {
          const msg = e.message === 'Failed to fetch'
            ? 'No se pudo conectar al servidor. Intenta de nuevo.'
            : e.message;
          showLoginError(msg);
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

  // Restaurar el correo (no la contraseña — nunca se guarda) si "Mantener
  // sesión" estaba activo. Firebase persiste la sesión real por su cuenta.
  const savedEmail = localStorage.getItem('tc_saved_email') || '';
  const savedRemember = localStorage.getItem('tc_cont_persist') !== 'false';

  const emailEl = $id('inp-email');
  const chkEl   = $id('chk-remember');

  if (emailEl && savedEmail) emailEl.value = savedEmail;
  if (chkEl)                 chkEl.checked = savedRemember;
}

// Muestra el logo de la firma en el avatar del sidebar (abajo) y en el
// ícono de marca (arriba) si el contador tiene uno subido (Configuración →
// Logo de la firma); si no, cae al ícono/inicial genérico de Tecno Caja.
function _setSidebarAvatar(nombre, logoUrl) {
  const avatarEl = $id('user-avatar-letter');
  if (avatarEl) {
    if (logoUrl) {
      avatarEl.innerHTML = `<img src="${logoUrl}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    } else {
      avatarEl.textContent = (nombre || '?').charAt(0).toUpperCase();
    }
  }

  const brandIcon = $id('sidebar-brand-icon');
  if (brandIcon) {
    brandIcon.innerHTML = logoUrl
      ? `<img src="${logoUrl}" style="width:100%;height:100%;border-radius:10px;object-fit:cover">`
      : '🧮';
  }
  const brandName = $id('sidebar-brand-name');
  if (brandName) brandName.textContent = nombre || 'Tecno Caja';

  // Se guarda en disco (vía Electron) para que el PRÓXIMO arranque, antes de
  // iniciar sesión, el splash ya sepa qué nombre/logo mostrar — hoy no
  // existe sesión todavía en ese punto, así que no hay forma de saberlo en
  // el momento, solo de recordarlo del login anterior.
  window.contadoresAPI?.cacheProfile?.({ nombre_firma: nombre || '', logo_url: logoUrl || '' });
}

function showApp(profile) {
  hide('screen-login');
  show('screen-app');

  const nombre = profile.nombre_firma || profile.fullName || profile.email || 'Contador';
  setText('sidebar-nombre', nombre);
  setText('sidebar-email', profile.email || '');
  _setSidebarAvatar(nombre, profile.logo_url);

  // Permisos según tipo de usuario
  _applyPermisos(profile);

  goto('dashboard');

  // Iniciar pollers en background
  setTimeout(() => {
    _startSolicitudesPoller();
    _startAlertasPoller();
    // Cargar badge de alertas inicial sin abrir el módulo
    apiCall('GET', '/api/alertas').then(d => _actualizarBadgeAlertas(d.critico + d.urgente)).catch(() => {});
  }, 3000);
}

function _applyPermisos(profile) {
  const esDependiente = profile.isColaborador && profile.tipo === 'dependiente';
  const esCompleto    = profile.isColaborador && profile.tipo === 'completo';

  // Colaborador dependiente: ocultar módulos bloqueados
  const hiddenMods = esDependiente
    ? ['colaboradores', 'licencias', 'solicitudes', 'facturacion']
    : [];

  document.querySelectorAll('.nav-item[data-mod]').forEach(el => {
    const mod = el.dataset.mod;
    if (hiddenMods.includes(mod)) {
      el.style.display = 'none';
    } else {
      el.style.display = '';
    }
  });

  // Botón nuevo colaborador solo para principal y completos
  const btnNuevo = $id('btn-nuevo-colab');
  if (btnNuevo) btnNuevo.style.display = esDependiente ? 'none' : '';

  // Badge de rol en sidebar
  const roleEl = $id('sidebar-email');
  if (roleEl) {
    const roleLabel = esDependiente ? 'Colaborador Dependiente'
      : esCompleto    ? 'Colaborador Completo'
      : 'Contador Principal';
    roleEl.textContent = roleLabel;
  }
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
    // Recordar el correo (no la contraseña) si "Mantener sesión" está activo.
    // Firebase ya persiste la sesión real vía setPersistence — no hace falta
    // cachear la contraseña, y guardarla en base64 no es cifrado real.
    if (remember) localStorage.setItem('tc_saved_email', email);
    else localStorage.removeItem('tc_saved_email');
    // onAuthStateChanged lo toma desde aquí
  } catch (e) {
    let msg = e.message;
    if (e.code === 'auth/wrong-password' || e.code === 'auth/user-not-found') msg = 'Correo o contraseña incorrectos.';
    if (e.code === 'auth/too-many-requests') msg = 'Demasiados intentos. Espera un momento.';
    if (e.message === 'Failed to fetch') msg = 'No se pudo conectar al servidor. Reintenta.';
    if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Iniciar sesión'; }
  }
}

async function doLoginGoogle() {
  const errEl = $id('login-err');
  if (errEl) errEl.classList.add('hidden');

  const btn = $id('btn-login-google');
  if (btn) { btn.disabled = true; btn.textContent = 'Conectando con Google…'; }

  try {
    const remember = $id('chk-remember')?.checked !== false;
    localStorage.setItem('tc_cont_persist', String(remember));
    await _fbAuth.setPersistence(
      remember ? firebase.auth.Auth.Persistence.LOCAL : firebase.auth.Auth.Persistence.SESSION
    );
    await _fbAuth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
    // onAuthStateChanged verifica el token contra /api/auth/verify y muestra
    // un error claro si esa cuenta de Google no tiene perfil de contador.
  } catch (e) {
    let msg = e.message;
    if (e.code === 'auth/popup-closed-by-user') { msg = null; }
    if (e.code === 'auth/popup-blocked') msg = 'El navegador bloqueó la ventana de Google. Intenta de nuevo.';
    if (msg && errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔐 Iniciar con Google'; }
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

    // Cargar KPIs extra en background (análisis global + alertas críticas + obligaciones)
    Promise.all([
      apiCall('GET', '/api/analisis-global').catch(() => null),
      apiCall('GET', '/api/alertas').catch(() => null),
      apiCall('GET', '/api/centro-fiscal/obligaciones').catch(() => null),
    ]).then(([ag, al, obl]) => {
      if (ag) {
        setText('dash-ventas-mes', fmtMoney(ag.resumen.totalVentasMes));
        setText('dash-itbis-mes',  fmtMoney(ag.resumen.totalItbisMes));
      }
      if (al) {
        const cnt = al.critico + al.urgente;
        setText('dash-alertas-critico', cnt);
        const el = $id('dash-alertas-critico');
        if (el) el.style.color = cnt > 0 ? '#ef4444' : 'inherit';
      }
      if (obl) {
        const proximas = obl.filter(o => o.diasRestantes >= 0 && o.diasRestantes <= 7).length;
        setText('dash-obl-proximas', proximas);
        const el = $id('dash-obl-proximas');
        if (el) el.style.color = proximas > 0 ? '#f59e0b' : 'inherit';
      }
    });
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
        <div style="display:flex;gap:6px;flex-wrap:nowrap;justify-content:flex-end">
          <button class="btn btn-xs btn-secondary" style="padding:4px 8px" title="Ver detalle" onclick="app.verCliente('${c.id}')">👁</button>
          <button class="btn btn-xs btn-secondary" style="padding:4px 8px" title="Nueva solicitud" onclick="app.abrirSolicitudModal('${c.id}')">📋</button>
          ${c.telefono ? `<button class="btn btn-xs btn-secondary" style="padding:4px 8px" title="Contactar por WhatsApp" onclick="app.contactarNegocio('${(c.telefono||'').replace(/[^0-9]/g,'')}','${(c.businessName||'').replace(/'/g,'')}')">📞</button>` : ''}
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
    _setCfgLogoPreview(p.logo_url);
  } catch (e) {
    toast('Error cargando perfil: ' + e.message, 'error');
  }
}

function _setCfgLogoPreview(url) {
  const preview = $id('cfg-logo-preview');
  const placeholder = $id('cfg-logo-placeholder');
  const box = preview?.closest('.ap-image-box');
  if (url) {
    if (preview) { preview.src = url; preview.style.display = 'block'; }
    if (placeholder) placeholder.style.display = 'none';
    if (box) box.classList.add('has-image');
  } else {
    if (preview) { preview.src = ''; preview.style.display = 'none'; }
    if (placeholder) placeholder.style.display = '';
    if (box) box.classList.remove('has-image');
  }
}

// Mismo patrón que handleAgregarProductoImagen: redimensiona en el navegador
// (más chico que el de productos, es solo un avatar/logo) y comprime a JPEG
// antes de guardarlo, para no acercarse al límite de 1MB por documento de
// Firestore.
function handleCfgLogoUpload(input) {
  const file = input?.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('Selecciona un archivo de imagen válido.', 'error'); return; }
  if (file.size > 15 * 1024 * 1024) { toast('La imagen debe pesar menos de 15 MB.', 'error'); return; }

  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
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
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      const logoInput = $id('cfg-logo');
      if (logoInput) logoInput.value = dataUrl;
      _setCfgLogoPreview(dataUrl);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function quitarCfgLogo() {
  const logoInput = $id('cfg-logo');
  if (logoInput) logoInput.value = '';
  const fileInput = $id('cfg-logo-file');
  if (fileInput) fileInput.value = '';
  _setCfgLogoPreview(null);
}

async function savePerfil() {
  try {
    await refreshToken();
    const logoUrl = $id('cfg-logo')?.value?.trim() || null;
    await apiCall('PUT', '/api/perfil', {
      nombre_firma: $id('cfg-nombre-firma')?.value?.trim() || null,
      responsable:  $id('cfg-responsable')?.value?.trim()  || null,
      direccion:    $id('cfg-direccion')?.value?.trim()    || null,
      correo:       $id('cfg-correo')?.value?.trim()       || null,
      telefono:     $id('cfg-telefono')?.value?.trim()     || null,
      whatsapp:     $id('cfg-whatsapp')?.value?.trim()     || null,
      logo_url:     logoUrl,
    });
    toast('Perfil actualizado correctamente.', 'success');
    const nombre = $id('cfg-nombre-firma')?.value?.trim();
    if (nombre) setText('sidebar-nombre', nombre);
    _setSidebarAvatar(nombre, logoUrl);
  } catch (e) { toast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════
// ACTUALIZACIONES
// ══════════════════════════════════════════════════════════════════════

// ── Estado del auto-updater ───────────────────────────────────────────────
// Misma estructura/estados que actualizaciones.js del POS (hero + badge +
// tarjeta de resultado + barra de progreso), adaptado a window.contadoresAPI
// en vez de window.novaDesktop. No hay "Opciones avanzadas" (el portal no
// tiene preferencias de auto-descarga/backup que configurar — main.js ya
// deja autoDownload siempre activo) ni pasos de instalación con respaldo
// (no hay datos de negocio locales que respaldar aquí, todo vive en
// Firestore) — se omiten a propósito en vez de mostrar controles que no
// hacen nada.
let _updUnsub      = null;
let _updState      = 'idle';
let _updLatestInfo = null;
let _updVersion    = '1.0.0';

const UPD_STATUS_MAP = {
  idle        : { dot: '⚪', text: 'Sin verificar',            cls: 'upd-badge-idle'  },
  dev         : { dot: '🛠', text: 'Modo desarrollo',           cls: 'upd-badge-idle'  },
  checking    : { dot: '⏳', text: 'Verificando…',             cls: 'upd-badge-info'  },
  uptodate    : { dot: '🟢', text: 'Sistema actualizado',      cls: 'upd-badge-ok'    },
  available   : { dot: '🟡', text: 'Actualización disponible', cls: 'upd-badge-warn'  },
  downloading : { dot: '🔵', text: 'Descargando…',             cls: 'upd-badge-info'  },
  ready       : { dot: '🟣', text: 'Lista para instalar',      cls: 'upd-badge-ready' },
  installing  : { dot: '🔵', text: 'Instalando…',              cls: 'upd-badge-info'  },
  error       : { dot: '🔴', text: 'Error de actualización',   cls: 'upd-badge-error' },
};

function _updSetStatus(s) {
  _updState = s;
  const el = $id('upd-status-badge');
  if (!el) return;
  const m = UPD_STATUS_MAP[s] || UPD_STATUS_MAP.idle;
  el.className = `upd-status-badge ${m.cls}`;
  el.innerHTML = `<span>${m.dot}</span><span>${m.text}</span>`;
}

function _updRefreshHero() {
  setText('upd-current-version', 'v' + _updVersion);
}

function _fmtBytes(b) {
  if (!b) return '';
  if (b > 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024).toFixed(0) + ' KB';
}

function _updClearInfoBox() {
  const box = $id('upd-info-box');
  if (box) { box.innerHTML = ''; box.classList.add('hidden'); }
  _updShowProgress(false);
}

function _updShowUpdateCard(info) {
  const box = $id('upd-info-box');
  if (!box) return;
  box.innerHTML = `
    <div class="upd-card-available">
      <div class="upd-version-jump">
        <div class="upd-vjump-block">
          <span class="upd-vjump-label">Versión actual</span>
          <span class="upd-vjump-ver">v${esc(_updVersion)}</span>
        </div>
        <div class="upd-vjump-arrow">→</div>
        <div class="upd-vjump-block">
          <span class="upd-vjump-label">Nueva versión</span>
          <span class="upd-vjump-ver upd-vjump-new-ver">v${esc(info.version || '')}</span>
        </div>
      </div>
      <div class="upd-action-row">
        <div class="upd-warn-box" style="font-size:.8rem;color:var(--text2)">
          La descarga arranca sola en segundo plano — no hace falta hacer nada más.
        </div>
      </div>
    </div>`;
  box.classList.remove('hidden');
}

function _updShowUpToDate() {
  const box = $id('upd-info-box');
  if (!box) return;
  box.innerHTML = `
    <div class="upd-uptodate">
      <span class="upd-uptodate-icon">🎉</span>
      <div>
        <strong>¡Estás al día!</strong>
        <p>Tienes la versión más reciente instalada — <b>v${esc(_updVersion)}</b>.</p>
        <p style="font-size:0.78rem;color:var(--text3);margin-top:0.25rem">
          Última verificación: ${new Date().toLocaleString('es-DO')}
        </p>
      </div>
    </div>`;
  box.classList.remove('hidden');
}

function _updShowError(msg) {
  const box = $id('upd-info-box');
  if (!box) return;
  box.innerHTML = `
    <div class="upd-error-card">
      <span class="upd-error-icon">❌</span>
      <div>
        <strong>No se pudo verificar la actualización</strong>
        <p>${esc(msg)}</p>
        <button class="upd-btn-sec" onclick="app.verificarActualizacion()">↻ Reintentar</button>
      </div>
    </div>`;
  box.classList.remove('hidden');
}

function _updShowInstallAction(version) {
  const box = $id('upd-info-box');
  if (!box) return;
  $id('upd-install-action-wrap')?.remove();
  const d = document.createElement('div');
  d.id = 'upd-install-action-wrap';
  d.className = 'upd-action-row';
  d.style.marginTop = '1rem';
  d.innerHTML = `
    <div class="upd-ready-msg">✅ Descarga completa — versión v${esc(version)} lista para instalar</div>
    <button class="upd-btn-main upd-btn-install-pulse" id="upd-btn-install" onclick="app.instalarActualizacion()">
      ⚙️ Instalar y reiniciar
    </button>`;
  box.appendChild(d);
}

function _updShowInstallingOverlay(message = 'Cerrando Tecno Caja Contadores y abriendo el instalador…') {
  let overlay = $id('upd-installing-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'upd-installing-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.82);display:flex;align-items:center;justify-content:center;color:#fff;padding:24px';
    overlay.innerHTML = `
      <div style="width:min(440px,92vw);background:#111827;border:1px solid rgba(255,255,255,.18);border-radius:14px;padding:24px;text-align:center;box-shadow:0 24px 80px rgba(0,0,0,.4)">
        <div style="font-size:34px;margin-bottom:10px">⚙️</div>
        <div style="font-size:18px;font-weight:800;margin-bottom:8px">Instalando actualización</div>
        <div id="upd-installing-overlay-text" style="font-size:13px;line-height:1.5;color:#cbd5e1"></div>
      </div>`;
    document.body.appendChild(overlay);
  }
  setText('upd-installing-overlay-text', message);
  overlay.style.display = 'flex';
}

function _updShowProgress(show) {
  const el = $id('upd-progress-wrap');
  if (el) el.classList.toggle('hidden', !show);
}

function _updSetProgress(pct, label, transferred, total) {
  const bar   = $id('upd-prog-bar');
  const pctEl = $id('upd-prog-pct');
  const lblEl = $id('upd-prog-label');
  const spdEl = $id('upd-prog-speed');
  if (bar)   bar.style.width = pct + '%';
  if (pctEl) pctEl.textContent = Math.round(pct) + '% completado';
  if (lblEl) lblEl.textContent = label || 'Descargando actualización…';
  if (spdEl) spdEl.textContent = (transferred != null && total != null) ? `${_fmtBytes(transferred)} de ${_fmtBytes(total)}` : '';
}

function _setBtnLoading(loading) {
  const btn = $id('upd-btn-check');
  if (!btn) return;
  btn.disabled = loading;
  btn.innerHTML = loading
    ? '<span style="display:inline-block;animation:upd-spin 1s linear infinite">⏳</span> Verificando…'
    : '🔍 Buscar actualizaciones';
}

async function _initUpdaterUI() {
  if (!window.contadoresAPI?.updaterGetVersion) {
    _updSetStatus('dev');
    return;
  }

  const info = await window.contadoresAPI.updaterGetVersion();
  _updVersion = info.version || '1.0.0';
  _updRefreshHero();

  if (!info.isPackaged) {
    _updSetStatus('dev');
    return;
  }

  if (_updUnsub) _updUnsub();
  _updUnsub = window.contadoresAPI.onUpdaterEvent((event, data) => {
    if (event === 'checking') {
      _updSetStatus('checking');
      _setBtnLoading(true);
    } else if (event === 'available') {
      _updLatestInfo = data;
      _updSetStatus('available');
      _updShowUpdateCard(data);
      _updSetStatus('downloading'); // autoDownload:true en main.js — arranca sola
      _updShowProgress(true);
    } else if (event === 'not-available') {
      _updSetStatus('uptodate');
      _updShowUpToDate();
      _setBtnLoading(false);
    } else if (event === 'progress') {
      _updShowProgress(true);
      _updSetProgress(data.percent || 0, `Descargando v${_updLatestInfo?.version || ''}…`, data.transferred, data.total);
    } else if (event === 'downloaded') {
      _updShowProgress(false);
      _updSetStatus('ready');
      _setBtnLoading(false);
      _updShowInstallAction(data.version || _updLatestInfo?.version || '');
    } else if (event === 'installing') {
      _updSetStatus('installing');
      _updShowInstallingOverlay();
    } else if (event === 'error') {
      _updShowProgress(false);
      _updSetStatus('error');
      _updShowError(data.message || 'Intenta verificar de nuevo.');
      _setBtnLoading(false);
    }
  });

  _updSetStatus('idle');
}

async function verificarActualizacion() {
  if (!window.contadoresAPI?.updaterCheck) return;
  _updSetStatus('checking');
  _setBtnLoading(true);
  _updClearInfoBox();
  try {
    const r = await window.contadoresAPI.updaterCheck();
    if (r?.devMode) { _updSetStatus('dev'); _setBtnLoading(false); }
    // si no es devMode, los eventos IPC (arriba) manejan el resultado
  } catch (e) {
    _updSetStatus('error');
    _updShowError(e.message || 'No se pudo conectar al servidor de actualizaciones.');
    _setBtnLoading(false);
  }
}

async function instalarActualizacion() {
  if (!window.contadoresAPI?.updaterInstall) return;
  _updSetStatus('installing');
  _updShowInstallingOverlay();
  try {
    const r = await window.contadoresAPI.updaterInstall();
    if (r?.devMode) {
      $id('upd-installing-overlay')?.remove();
      _updSetStatus('dev');
      toast('El instalador solo se abre en la versión instalada, no en desarrollo.', 'info');
      return;
    }
    if (r?.ok === false) {
      $id('upd-installing-overlay')?.remove();
      _updSetStatus('error');
      _updShowError(r.error || 'No se pudo iniciar el instalador.');
    }
  } catch (e) {
    $id('upd-installing-overlay')?.remove();
    _updSetStatus('error');
    _updShowError(e.message || 'No se pudo iniciar el instalador.');
  }
}

function updSwitchTab(name) {
  document.querySelectorAll('#mod-actualizaciones .upd-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('#mod-actualizaciones .upd-tab-panel').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== name));
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
    // Última actualización real de ESTE instalador, si su versión aparece en
    // la lista de releases publicados.
    const instalada = list.find(v => v.version === _updVersion);
    if (instalada) setText('upd-last-date', fmtDate(instalada.created_at));

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
let _repNegocioSucursales = []; // [{id, nombre}] del negocio seleccionado — sincronizadas por el POS

// `aligns` es paralelo a `cols` — debe calzar 1 a 1 con la alineación real
// que usa cada <td> en renderFila() (clases td-amount → right, style
// text-align:center → center) para que el encabezado quede sobre su columna
// en vez de pegado a la izquierda mientras los datos se van a la derecha.
const REP_TABS = {
  ventas:     { label: 'Ventas', cols: ['Fecha','Factura','Sucursal','Cajero','Cliente','Método','Descuento','Total','ITBIS'],
                aligns: ['left','left','left','left','left','left','right','right','right'] },
  facturas:   { label: 'Facturas', cols: ['Fecha','NCF','Tipo','Sucursal','Cliente','RNC','Descuento','Total','ITBIS','Estado'],
                aligns: ['left','left','left','left','left','left','right','right','right','left'] },
  productos:  { label: 'Productos', cols: ['Código','Nombre','Sucursal','Categoría','Precio','Costo','Stock','Vendidos'],
                aligns: ['left','left','left','left','right','right','center','center'] },
  inventario: { label: 'Inventario', cols: ['Código','Nombre','Sucursal','Stock','Mínimo','Estado','Última Compra'],
                aligns: ['left','left','left','center','center','left','left'] },
  itbis:      { label: 'ITBIS', cols: ['Fecha','NCF','Tipo','Sucursal','Base Imponible','Descuento','ITBIS 18%','Total'],
                aligns: ['left','left','left','left','right','right','right','right'] },
  cxc:        { label: 'C×Cobrar', cols: ['Cliente','Sucursal','RNC','Teléfono','Deuda','Última Compra','Estado'],
                aligns: ['left','left','left','left','right','left','left'] },
  clientes:   { label: 'Clientes', cols: ['Nombre','RNC','Teléfono','Correo','Compras','Última Visita'],
                aligns: ['left','left','left','left','center','left'] },
  cierres:    { label: 'Cierres', cols: ['Apertura','Cierre','Sucursal','Caja','Cajero','Monto Apertura','Ventas','Contado','Diferencia','Estado'],
                aligns: ['left','left','left','left','left','right','right','right','right','left'] },
  mensual:    { label: 'Mensual', cols: ['Mes','Sucursal','Ventas','Descuentos','Facturas','ITBIS','Clientes Nuevos'],
                aligns: ['left','left','right','right','center','right','center'] },
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
    _repNegocioSucursales = [];
    $id('rep-state-empty').style.display = '';
    $id('rep-state-data').style.display  = 'none';
    loadProductosPendientes();
    loadNcfPendientes();
    loadNcfAplicadas();
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
    _repNegocioSucursales = Array.isArray(data.negocio?.sucursales) ? data.negocio.sucursales : [];
    renderSucursalReporteFilter();
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

    loadProductosPendientes();
    loadNcfPendientes();
    loadNcfAplicadas();
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

function renderSucursalReporteFilter() {
  const select = $id('rep-f-sucursal');
  if (!select) return;
  const current = select.value || '';
  select.innerHTML = '<option value="">Todas</option>' +
    _repNegocioSucursales.map((s) => `<option value="${esc(s.id)}">${esc(s.nombre || 'Sucursal')}</option>`).join('');
  select.value = _repNegocioSucursales.some((s) => String(s.id) === current) ? current : '';
}

function cambiarTabReporte(tab) {
  _repTab = tab;
  document.querySelectorAll('.rep-tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  // Show/hide NCF filter based on tab
  const ncfGroup = $id('rep-f-ncf-group');
  if (ncfGroup) ncfGroup.style.display = (tab === 'facturas' || tab === 'itbis') ? '' : 'none';

  loadProductosPendientes();
  loadNcfPendientes();
  loadNcfAplicadas();
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
    const cajero = $id('rep-f-cajero')?.value?.trim();
    const sucursal = $id('rep-f-sucursal')?.value;

    if (desde)  params.set('desde', desde);
    if (hasta)  params.set('hasta', hasta);
    if (metodo) params.set('metodo', metodo);
    if (ncf)    params.set('ncf', ncf);
    if (cajero) params.set('cajero', cajero);
    if (sucursal) params.set('branchId', sucursal);

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
  const aligns = REP_TABS[_repTab]?.aligns || [];
  if (!data.rows || !data.rows.length) {
    inner.innerHTML = `<div class="rep-no-sync">
      <div class="rep-no-sync-icon">📭</div>
      <div class="rep-no-sync-title">Sin resultados</div>
      <div class="rep-no-sync-sub">No hay datos para los filtros seleccionados.</div>
    </div>`;
    return;
  }

  const thead = `<thead><tr>${cols.map((c, i) => `<th style="text-align:${aligns[i] || 'left'}">${c}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${data.rows.map(row => renderFila(row, _repTab)).join('')}</tbody>`;
  inner.innerHTML = `<table class="data-table" style="table-layout:auto">${thead}${tbody}</table>`;
}

function renderFila(row, tab) {
  let cells = [];
  switch (tab) {
    case 'ventas':
      cells = [
        `<td class="td-date">${fmtDate(row.fecha)}</td>`,
        `<td class="td-ncf">${row.factura || row.ncf || '—'}</td>`,
        `<td>${row.sucursal || 'Global'}</td>`,
        `<td>${row.cajero || '—'}</td>`,
        `<td>${row.cliente || '—'}</td>`,
        `<td>${row.metodo_pago || '—'}</td>`,
        `<td class="td-amount">${fmtMoney(row.descuento)}</td>`,
        `<td class="td-amount">${fmtMoney(row.total)}</td>`,
        `<td class="td-amount">${fmtMoney(row.itbis)}</td>`,
      ]; break;
    case 'facturas':
      cells = [
        `<td class="td-date">${fmtDate(row.fecha)}</td>`,
        `<td class="td-ncf">${row.ncf || '—'}</td>`,
        `<td>${row.tipo_ncf || '—'}</td>`,
        `<td>${row.sucursal || 'Global'}</td>`,
        `<td>${row.cliente || '—'}</td>`,
        `<td class="td-ncf">${row.rnc || '—'}</td>`,
        `<td class="td-amount">${fmtMoney(row.descuento)}</td>`,
        `<td class="td-amount">${fmtMoney(row.total)}</td>`,
        `<td class="td-amount">${fmtMoney(row.itbis)}</td>`,
        `<td>${row.estado || '—'}</td>`,
      ]; break;
    case 'productos':
      cells = [
        `<td class="td-ncf">${row.codigo || '—'}</td>`,
        `<td style="font-weight:600">${row.nombre || '—'}</td>`,
        `<td>${row.sucursal || 'Global'}</td>`,
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
        `<td>${row.sucursal || 'Global'}</td>`,
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
        `<td>${row.sucursal || 'Global'}</td>`,
        `<td class="td-amount">${fmtMoney(row.base_imponible)}</td>`,
        `<td class="td-amount">${fmtMoney(row.descuento)}</td>`,
        `<td class="td-amount">${fmtMoney(row.itbis)}</td>`,
        `<td class="td-amount">${fmtMoney(row.total)}</td>`,
      ]; break;
    case 'cxc':
      cells = [
        `<td style="font-weight:600">${row.cliente || '—'}</td>`,
        `<td>${row.sucursal || 'Global'}</td>`,
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
        `<td>${row.sucursal || 'Global'}</td>`,
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
        `<td>${row.sucursal || 'Global'}</td>`,
        `<td class="td-amount">${fmtMoney(row.ventas)}</td>`,
        `<td class="td-amount">${fmtMoney(row.descuentos)}</td>`,
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

function exportarExcel() {
  const table = $id('rep-table-inner')?.querySelector('table');
  if (!table) { toast('No hay datos para exportar.', 'error'); return; }
  if (!window.XLSX) { toast('Librería de Excel no disponible.', 'error'); return; }

  const neg   = _allClientes.find(c => c.id === _repNegocioId);
  const title = _REP_TAB_LABELS[_repTab] || _repTab || 'Reporte';
  const fecha = new Date().toLocaleDateString('es-DO', { day: '2-digit', month: 'long', year: 'numeric' });

  // Encabezado con contexto del negocio, igual que en el PDF
  const aoa = [
    [neg?.businessName || 'Negocio'],
    [`RNC: ${neg?.rnc || '—'}  ·  ${title}  ·  Generado: ${fecha}`],
    [],
  ];

  const headerRow = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
  aoa.push(headerRow);

  table.querySelectorAll('tbody tr').forEach(tr => {
    const row = [...tr.querySelectorAll('td')].map(td => {
      const v = td.textContent.trim();
      // Solo montos "RD$ 1,234.56" se convierten a número real — todo lo demás
      // (RNC, teléfono, NCF, cédula) se deja como texto para no perder ceros a la izquierda.
      const m = v.match(/^RD\$\s*([\d.,]+)$/);
      if (m) return Number(m[1].replace(/,/g, ''));
      return v === '—' ? '' : v;
    });
    aoa.push(row);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: headerRow.length - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: headerRow.length - 1 } },
  ];
  ws['!cols'] = headerRow.map((h, i) => {
    const maxLen = aoa.reduce((max, row) => Math.max(max, String(row[i] ?? '').length), h.length);
    return { wch: Math.min(Math.max(maxLen + 2, 10), 40) };
  });

  const wb = XLSX.utils.book_new();
  const sheetName = title.replace(/[:\\/?*[\]]/g, '').slice(0, 31);
  XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Reporte');

  const nombre = (neg?.businessName || 'negocio').replace(/[^a-zA-Z0-9]/g, '_');
  const fechaArchivo = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `reporte_${_repTab}_${nombre}_${fechaArchivo}.xlsx`);
  toast('Excel exportado correctamente.', 'success');
}

function imprimirReporte() {
  window.print();
}

function actualizarReporte() {
  if (_repNegocioId) selNegocioReporte(_repNegocioId);
}

// ══════════════════════════════════════════════════════════════════════
// PRODUCTOS PENDIENTES (agregados desde este Portal)
// El POS de cada cliente corre local en su propia PC — esto no llega al
// instante. Queda en cola en Firestore y el POS del cliente lo aplica la
// próxima vez que sincronice (abrir/cerrar caja o una venta). Siempre queda
// global (visible en todas las sucursales de ese negocio) en esta versión.
// ══════════════════════════════════════════════════════════════════════

let _productosPendientes = [];
let _apImagenDataUrl = null; // imagen del producto en el modal Agregar Producto (base64, opcional)

// Mismo patrón que handleProductImageSelect() del POS (js/productos.js):
// redimensiona en el navegador a 900px máx y comprime a JPEG antes de
// mandarla — así el documento en Firestore no se acerca al límite de 1MB.
function handleAgregarProductoImagen(input) {
  const file = input?.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('Selecciona un archivo de imagen válido.', 'error'); return; }
  if (file.size > 15 * 1024 * 1024) { toast('La imagen debe pesar menos de 15 MB.', 'error'); return; }

  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 900;
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
      _apImagenDataUrl = canvas.toDataURL('image/jpeg', 0.82);

      const preview = $id('ap-image-preview');
      const placeholder = $id('ap-image-placeholder');
      const box = preview?.closest('.ap-image-box');
      if (preview) { preview.src = _apImagenDataUrl; preview.style.display = 'block'; }
      if (placeholder) placeholder.style.display = 'none';
      if (box) box.classList.add('has-image');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

async function loadProductosPendientes() {
  const panel = $id('rep-productos-pendientes-panel');
  const visible = _repTab === 'productos' && Boolean(_repNegocioId);
  if (panel) panel.style.display = visible ? '' : 'none';
  if (!visible) return;

  const listEl = $id('rep-productos-pendientes-list');
  if (listEl) listEl.innerHTML = `<div class="rep-loading"><div class="rep-spinner"></div>Cargando…</div>`;
  try {
    await refreshToken();
    _productosPendientes = await apiCall('GET', `/api/productos-pendientes/${_repNegocioId}`);
    renderProductosPendientes();
  } catch (e) {
    if (listEl) listEl.innerHTML = `<div class="rep-no-sync-sub">Error cargando productos pendientes: ${e.message}</div>`;
  }
}

function renderProductosPendientes() {
  const listEl = $id('rep-productos-pendientes-list');
  if (!listEl) return;
  // Ya aplicados no se muestran aquí — la tabla es "qué falta por sincronizar",
  // no un historial. Un producto aplicado ya aparece en la tabla de catálogo
  // de abajo, mostrarlo dos veces confundía.
  const pendientes = _productosPendientes.filter((p) => p.status !== 'aplicado');
  if (!pendientes.length) {
    listEl.innerHTML = `<div class="rep-no-sync-sub" style="padding:8px 0">No hay productos pendientes por sincronizar.</div>`;
    return;
  }
  const badges = { pendiente: '🟡 Pendiente de sincronizar', error: '🔴 Error' };
  listEl.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Código</th><th>Nombre</th><th>Sucursal</th><th>Precio</th><th>Estado</th><th>Detalle</th></tr></thead>
      <tbody>
        ${pendientes.map(p => `
          <tr>
            <td>${p.codigo || '—'}</td>
            <td>${p.nombre || '—'}${p.tieneImagen ? ' 📷' : ''}</td>
            <td>${p.branchNombre || '🌐 Global'}</td>
            <td>${fmtMoney(p.precioVenta)}</td>
            <td>${badges[p.status] || p.status || '—'}</td>
            <td>${p.status === 'error' ? (p.errorMessage || '') : ''}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function abrirAgregarProductoModal() {
  if (!_repNegocioId) { toast('Selecciona un negocio primero.', 'error'); return; }
  ['ap-codigo', 'ap-nombre', 'ap-categoria', 'ap-marca', 'ap-unidad', 'ap-precio-compra', 'ap-precio-venta', 'ap-stock', 'ap-stock-min'].forEach((id) => {
    const el = $id(id);
    if (el) el.value = '';
  });
  const itbisEl = $id('ap-aplica-itbis');
  if (itbisEl) itbisEl.checked = false;

  const sucursalEl = $id('ap-sucursal');
  if (sucursalEl) {
    sucursalEl.innerHTML = '<option value="">🌐 Global (todas las sucursales)</option>' +
      _repNegocioSucursales.map((s) => `<option value="${s.id}">${s.nombre}</option>`).join('');
  }

  _apImagenDataUrl = null;
  const preview = $id('ap-image-preview');
  const placeholder = $id('ap-image-placeholder');
  const box = preview?.closest('.ap-image-box');
  if (preview) { preview.src = ''; preview.style.display = 'none'; }
  if (placeholder) placeholder.style.display = '';
  if (box) box.classList.remove('has-image');
  const fileInput = $id('ap-image-file');
  if (fileInput) fileInput.value = '';

  show('modal-agregar-producto');
}

function cerrarAgregarProductoModal() { hide('modal-agregar-producto'); }

async function guardarProductoPendiente() {
  const codigo = $id('ap-codigo')?.value?.trim();
  const nombre = $id('ap-nombre')?.value?.trim();
  const precioVenta = Number($id('ap-precio-venta')?.value || 0);
  if (!codigo) { toast('El código es obligatorio.', 'error'); return; }
  if (!nombre) { toast('El nombre es obligatorio.', 'error'); return; }
  if (!precioVenta || precioVenta <= 0) { toast('Indica un precio de venta válido.', 'error'); return; }

  const sucursalEl = $id('ap-sucursal');
  const branchId = sucursalEl?.value ? Number(sucursalEl.value) : null;

  try {
    await refreshToken();
    await apiCall('POST', '/api/productos-pendientes', {
      businessId:   _repNegocioId,
      codigo,
      nombre,
      categoria:    $id('ap-categoria')?.value?.trim() || 'General',
      marca:        $id('ap-marca')?.value?.trim() || '',
      unidad:       $id('ap-unidad')?.value?.trim() || 'Unidad',
      precioCompra: Number($id('ap-precio-compra')?.value || 0),
      precioVenta,
      stock:        Number($id('ap-stock')?.value || 0),
      stockMin:     Number($id('ap-stock-min')?.value || 0),
      aplicaItbis:  Boolean($id('ap-aplica-itbis')?.checked),
      branchId,
      imagenData:   _apImagenDataUrl || null,
    });
    toast('Producto agregado — se aplicará cuando el sistema del cliente sincronice.', 'success');
    cerrarAgregarProductoModal();
    loadProductosPendientes();
  } catch (e) { toast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════
// SECUENCIAS NCF PENDIENTES (registradas desde este Portal)
// Mismo mecanismo que Productos Pendientes: el POS del cliente corre local,
// esto queda en cola en Firestore y se aplica la próxima vez que ese POS
// sincroniza. Solo NCF tradicional (B01-B17) — el e-CF ya se certifica aparte.
// Visible en la pestaña "🏛 ITBIS / DGII".
// ══════════════════════════════════════════════════════════════════════

const NCF_DOCUMENT_TYPES = [
  { code: 'B01', label: 'B01 — Crédito Fiscal' }, { code: 'B02', label: 'B02 — Consumidor Final' },
  { code: 'B03', label: 'B03 — Nota de Débito' }, { code: 'B04', label: 'B04 — Nota de Crédito' },
  { code: 'B11', label: 'B11 — Comprobante de Compras' }, { code: 'B12', label: 'B12 — Registro Único de Ingresos' },
  { code: 'B13', label: 'B13 — Gastos Menores' }, { code: 'B14', label: 'B14 — Régimen Especial' },
  { code: 'B15', label: 'B15 — Gubernamental' }, { code: 'B16', label: 'B16 — Comprobante para Exportaciones' },
  { code: 'B17', label: 'B17 — Comprobante para Pagos al Exterior' },
];

let _ncfPendientes = [];
let _anAdjuntoDataUrl = null; // documento de autorización DGII (base64), opcional

// El adjunto puede ser PDF/XML/imagen — a diferencia de la imagen de producto
// no se puede "redimensionar", solo se valida tamaño antes de convertir a base64.
function handleAgregarNcfAdjunto(input) {
  const file = input?.files?.[0];
  if (!file) return;
  if (file.size > 700 * 1024) { toast('El archivo debe pesar menos de 700 KB.', 'error'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    _anAdjuntoDataUrl = e.target.result;
    const label = $id('an-adjunto-nombre');
    if (label) label.textContent = `📎 ${file.name}`;
  };
  reader.readAsDataURL(file);
}

async function loadNcfPendientes() {
  const panel = $id('rep-ncf-pendientes-panel');
  const visible = _repTab === 'itbis' && Boolean(_repNegocioId);
  if (panel) panel.style.display = visible ? '' : 'none';
  if (!visible) return;

  const listEl = $id('rep-ncf-pendientes-list');
  if (listEl) listEl.innerHTML = `<div class="rep-loading"><div class="rep-spinner"></div>Cargando…</div>`;
  try {
    await refreshToken();
    _ncfPendientes = await apiCall('GET', `/api/ncf-pendientes/${_repNegocioId}`);
    renderNcfPendientes();
  } catch (e) {
    if (listEl) listEl.innerHTML = `<div class="rep-no-sync-sub">Error cargando secuencias NCF pendientes: ${e.message}</div>`;
  }
}

function renderNcfPendientes() {
  const listEl = $id('rep-ncf-pendientes-list');
  if (!listEl) return;
  if (!_ncfPendientes.length) {
    listEl.innerHTML = `<div class="rep-no-sync-sub" style="padding:8px 0">No hay secuencias NCF registradas desde el Portal todavía.</div>`;
    return;
  }
  const badges = { pendiente: '🔵 Pendiente de sincronizar', aplicado: '🟢 Aplicado en el POS', error: '🔴 Error' };
  const ACTION_LABELS = { create: 'Registrar', edit: 'Editar', suspend: 'Suspender', delete: 'Eliminar' };
  listEl.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Acción</th><th>Tipo</th><th>Rango</th><th>Sucursal</th><th>Referencia / motivo</th><th>Estado</th><th>Detalle</th><th></th></tr></thead>
      <tbody>
        ${_ncfPendientes.map(n => {
          const action = n.action || 'create';
          const target = action !== 'create' ? _ncfAplicadas.find((s) => String(s.id) === String(n.targetLocalSequenceId)) : null;
          const tipo = action === 'create' ? (n.documentType || '—') : (target?.documentType || `Secuencia #${n.targetLocalSequenceId}`);
          const rango = action === 'create' ? `${n.startNumber}–${n.endNumber}` : (target ? `${target.startNumber}–${target.endNumber}` : '—');
          const sucursal = action === 'create' ? (n.branchNombre || '🌐 Global') : (target?.branchName || '—');
          const refMotivo = action === 'create'
            ? `${n.authorizationReference || '—'}${n.tieneAdjunto ? ' 📎' : ''}`
            : (n.reason || '—');
          return `
          <tr>
            <td>${ACTION_LABELS[action] || action}</td>
            <td>${tipo}</td>
            <td>${rango}</td>
            <td>${sucursal}</td>
            <td>${refMotivo}</td>
            <td>${badges[n.status] || n.status || '—'}</td>
            <td>${n.status === 'error' ? (n.errorMessage || '') : ''}</td>
            <td>${['pendiente', 'error'].includes(n.status) ? `<button class="btn btn-xs btn-secondary" onclick="app.cancelarNcfPendiente('${n.id}')">✕ ${n.status === 'error' ? 'Descartar' : 'Cancelar'}</button>` : ''}</td>
          </tr>
        `; }).join('')}
      </tbody>
    </table>
  `;
}

async function cancelarNcfPendiente(pendienteId) {
  if (!confirm('¿Cancelar este registro? Todavía no se ha aplicado en el POS del cliente.')) return;
  try {
    await refreshToken();
    await apiCall('DELETE', `/api/ncf-pendientes/${_repNegocioId}/${pendienteId}`);
    toast('Registro cancelado.', 'success');
    loadNcfPendientes();
  } catch (e) { toast(e.message, 'error'); }
}

function abrirAgregarNcfModal() {
  if (!_repNegocioId) { toast('Selecciona un negocio primero.', 'error'); return; }
  const tipoEl = $id('an-tipo');
  if (tipoEl) tipoEl.innerHTML = NCF_DOCUMENT_TYPES.map((t) => `<option value="${t.code}">${t.label}</option>`).join('');
  ['an-desde', 'an-hasta', 'an-fecha-autorizacion', 'an-fecha-vencimiento', 'an-referencia', 'an-notas'].forEach((id) => {
    const el = $id(id);
    if (el) el.value = '';
  });
  const sucursalEl = $id('an-sucursal');
  if (sucursalEl) {
    sucursalEl.innerHTML = '<option value="">🌐 Global (todas las sucursales)</option>' +
      _repNegocioSucursales.map((s) => `<option value="${s.id}">${s.nombre}</option>`).join('');
  }
  _anAdjuntoDataUrl = null;
  const label = $id('an-adjunto-nombre');
  if (label) label.textContent = '';
  const fileInput = $id('an-adjunto-file');
  if (fileInput) fileInput.value = '';

  show('modal-agregar-ncf');
}

function cerrarAgregarNcfModal() { hide('modal-agregar-ncf'); }

async function guardarNcfPendiente() {
  const documentType = $id('an-tipo')?.value;
  const startNumber = Number($id('an-desde')?.value || 0);
  const endNumber = Number($id('an-hasta')?.value || 0);
  const authorizationReference = $id('an-referencia')?.value?.trim();

  if (!documentType) { toast('Selecciona el tipo de comprobante.', 'error'); return; }
  if (!startNumber || !endNumber || startNumber > endNumber) { toast('Indica un rango válido.', 'error'); return; }
  if (!authorizationReference) { toast('Indica la referencia de autorización de la DGII.', 'error'); return; }

  const sucursalEl = $id('an-sucursal');
  const branchId = sucursalEl?.value ? Number(sucursalEl.value) : null;

  try {
    await refreshToken();
    await apiCall('POST', '/api/ncf-pendientes', {
      businessId: _repNegocioId,
      documentType,
      branchId,
      startNumber,
      endNumber,
      authorizationDate: $id('an-fecha-autorizacion')?.value || null,
      expirationDate: $id('an-fecha-vencimiento')?.value || null,
      authorizationReference,
      notes: $id('an-notas')?.value?.trim() || '',
      attachmentData: _anAdjuntoDataUrl || null,
    });
    toast('Secuencia NCF registrada — se aplicará cuando el sistema del cliente sincronice.', 'success');
    cerrarAgregarNcfModal();
    loadNcfPendientes();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Secuencias ya aplicadas en el POS (espejo de solo lectura) ─────────
// Editar/Suspender no escriben directo — quedan como solicitud en la misma
// cola de pendientes (action:'edit'|'suspend'), el POS las revalida y aplica.

let _ncfAplicadas = [];
let _ncfEditTargetId = null;

async function loadNcfAplicadas() {
  const visible = _repTab === 'itbis' && Boolean(_repNegocioId);
  const listEl = $id('rep-ncf-aplicadas-list');
  if (!listEl) return;
  if (!visible) { listEl.innerHTML = ''; return; }
  listEl.innerHTML = `<div class="rep-loading"><div class="rep-spinner"></div>Cargando…</div>`;
  try {
    await refreshToken();
    _ncfAplicadas = await apiCall('GET', `/api/ncf-aplicadas/${_repNegocioId}`);
    renderNcfAplicadas();
  } catch (e) {
    listEl.innerHTML = `<div class="rep-no-sync-sub">Error cargando secuencias del POS: ${e.message}</div>`;
  }
}

function renderNcfAplicadas() {
  const listEl = $id('rep-ncf-aplicadas-list');
  if (!listEl) return;
  if (!_ncfAplicadas.length) {
    listEl.innerHTML = `<div class="rep-no-sync-sub" style="padding:8px 0">Todavía no hay secuencias activas en el POS de este negocio.</div>`;
    return;
  }
  const colores = {
    activo: '#22C55E', proximo_agotarse: '#f59e0b', agotado: '#ef4444', vencido: '#ef4444',
    suspendido: '#6b7280', pendiente: '#6b7280', legacy_unverified: '#3b82f6',
  };
  const ESTADO_LABELS = {
    activo: 'Activo', proximo_agotarse: 'Por agotarse', agotado: 'Agotado', vencido: 'Vencido',
    suspendido: 'Suspendido', pendiente: 'Pendiente de activar', legacy_unverified: 'Migrado — sin verificar',
  };
  listEl.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Tipo</th><th>Rango</th><th>Próximo</th><th>Disponibles</th><th>Sucursal</th><th>Estado</th><th></th></tr></thead>
      <tbody>
        ${_ncfAplicadas.map(s => `
          <tr>
            <td>${s.documentType || '—'}</td>
            <td>${s.startNumber}–${s.endNumber}</td>
            <td>${s.nextNumber}</td>
            <td>${s.totalAvailable}</td>
            <td>${s.branchName || '🌐 Global'}</td>
            <td><span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;color:#fff;background:${colores[s.effectiveStatus] || colores[s.status] || '#6b7280'}">${ESTADO_LABELS[s.effectiveStatus] || ESTADO_LABELS[s.status] || s.effectiveStatus || s.status}</span></td>
            <td style="white-space:nowrap">
              <button class="btn btn-xs btn-secondary" onclick="app.abrirEditarNcfModal('${s.id}')">✎ Editar</button>
              ${s.status === 'activo' ? `<button class="btn btn-xs btn-secondary" onclick="app.abrirSuspenderNcfModal('${s.id}')">⏸ Suspender</button>` : ''}
              <button class="btn btn-xs btn-danger" onclick="app.eliminarNcfAplicada('${s.id}')">🗑 Eliminar</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function abrirEditarNcfModal(localSequenceId) {
  const seq = _ncfAplicadas.find((s) => String(s.id) === String(localSequenceId));
  if (!seq) return;
  _ncfEditTargetId = localSequenceId;
  $id('ane-titulo').textContent = `Editar ${seq.documentType} · ${seq.startNumber}–${seq.endNumber}`;
  $id('ane-nombre').value = seq.documentName || '';
  $id('ane-hasta').value = seq.endNumber || '';
  $id('ane-hasta').min = seq.nextNumber || seq.startNumber || 1;
  $id('ane-fecha-autorizacion').value = (seq.authorizationDate || '').slice(0, 10);
  $id('ane-fecha-vencimiento').value = (seq.expirationDate || '').slice(0, 10);
  $id('ane-referencia').value = seq.authorizationReference || '';
  $id('ane-notas').value = '';
  show('modal-editar-ncf');
}

function cerrarEditarNcfModal() { hide('modal-editar-ncf'); }

async function guardarEdicionNcf() {
  if (!_ncfEditTargetId) return;
  try {
    await refreshToken();
    await apiCall('POST', '/api/ncf-pendientes/editar', {
      businessId: _repNegocioId,
      targetLocalSequenceId: _ncfEditTargetId,
      documentName: $id('ane-nombre')?.value?.trim() || null,
      endNumber: Number($id('ane-hasta')?.value || 0) || null,
      authorizationDate: $id('ane-fecha-autorizacion')?.value || null,
      expirationDate: $id('ane-fecha-vencimiento')?.value || null,
      authorizationReference: $id('ane-referencia')?.value?.trim() || null,
      notes: $id('ane-notas')?.value?.trim() || '',
    });
    toast('Edición registrada — se aplicará en unos segundos.', 'success');
    cerrarEditarNcfModal();
    loadNcfPendientes();
    scheduleNcfRefresh();
  } catch (e) { toast(e.message, 'error'); }
}

// Electron no implementa window.prompt() (funciona en un navegador normal
// pero en la app se queda en silencio, sin mostrar nada ni lanzar error) —
// este modal lo reemplaza para cualquier acción que necesite pedir un
// motivo de texto libre antes de continuar.
let _motivoNcfResolve = null;

function pedirMotivoNcf(titulo, subtitulo) {
  return new Promise((resolve) => {
    _motivoNcfResolve = resolve;
    $id('mtv-titulo').textContent = titulo;
    $id('mtv-sub').textContent = subtitulo || '';
    $id('mtv-input').value = '';
    show('modal-motivo-ncf');
    setTimeout(() => $id('mtv-input')?.focus(), 50);
  });
}

function confirmarMotivoNcf() {
  const val = $id('mtv-input')?.value?.trim() || '';
  if (!val) { toast('Escribe un motivo antes de confirmar.', 'error'); return; }
  hide('modal-motivo-ncf');
  if (_motivoNcfResolve) { _motivoNcfResolve(val); _motivoNcfResolve = null; }
}

function cancelarMotivoNcf() {
  hide('modal-motivo-ncf');
  if (_motivoNcfResolve) { _motivoNcfResolve(null); _motivoNcfResolve = null; }
}

// El POS tiene un listener en tiempo real sobre la cola de pendientes, así
// que normalmente aplica la solicitud en pocos segundos (no hay que esperar
// los 5 minutos del sync de respaldo). Este refresco solo le da tiempo a
// llegar antes de repintar, para que el contador vea el resultado sin tener
// que darle a "Actualizar" a mano.
function scheduleNcfRefresh() {
  setTimeout(() => { loadNcfAplicadas(); loadNcfPendientes(); }, 4000);
}

async function abrirSuspenderNcfModal(localSequenceId) {
  const seq = _ncfAplicadas.find((s) => String(s.id) === String(localSequenceId));
  if (!seq) return;
  const reason = await pedirMotivoNcf(
    `Suspender ${seq.documentType} ${seq.startNumber}–${seq.endNumber}`,
    'El motivo es obligatorio. Se aplicará cuando el POS del cliente sincronice.'
  );
  if (!reason) return;
  try {
    await refreshToken();
    await apiCall('POST', '/api/ncf-pendientes/suspender', {
      businessId: _repNegocioId,
      targetLocalSequenceId: localSequenceId,
      reason,
    });
    toast('Suspensión registrada — se aplicará en unos segundos.', 'success');
    loadNcfPendientes();
    scheduleNcfRefresh();
  } catch (e) { toast(e.message, 'error'); }
}

async function eliminarNcfAplicada(localSequenceId) {
  const seq = _ncfAplicadas.find((s) => String(s.id) === String(localSequenceId));
  if (!seq) return;
  const reason = await pedirMotivoNcf(
    `Eliminar ${seq.documentType} ${seq.startNumber}–${seq.endNumber}`,
    'El motivo es obligatorio. Se eliminará aunque ya tenga números usados — no se puede deshacer desde aquí.'
  );
  if (!reason) return;
  try {
    await refreshToken();
    await apiCall('POST', '/api/ncf-pendientes/eliminar', {
      businessId: _repNegocioId,
      targetLocalSequenceId: localSequenceId,
      reason,
    });
    toast('Eliminación registrada — se aplicará en unos segundos.', 'success');
    loadNcfPendientes();
    scheduleNcfRefresh();
  } catch (e) { toast(e.message, 'error'); }
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
    setText('rep-chart-total', fmtMoney(0));
    setText('rep-chart-sub', 'Tendencia diaria de ingresos');
    return;
  }
  canvas.style.display = '';
  if (emptyEl) emptyEl.style.display = 'none';

  const values = labels.map(d => Math.round(byDate[d] * 100) / 100);
  const total  = values.reduce((a, b) => a + b, 0);
  const diasConVenta = values.filter(v => v > 0).length;
  const promedio = diasConVenta ? total / diasConVenta : 0;
  setText('rep-chart-total', fmtMoney(total));
  setText('rep-chart-sub', diasConVenta === 1
    ? '1 día con ventas en el período'
    : `${diasConVenta} días con ventas · promedio ${fmtMoney(promedio)}/día`);

  const fmt = d => {
    try { return new Date(d + 'T12:00:00').toLocaleDateString('es-DO', { day: '2-digit', month: 'short' }); }
    catch { return d; }
  };

  const ctx2d = canvas.getContext('2d');
  const gradient = ctx2d.createLinearGradient(0, 0, 0, canvas.clientHeight || 200);
  gradient.addColorStop(0, 'rgba(59,130,246,0.38)');
  gradient.addColorStop(1, 'rgba(59,130,246,0)');

  if (_repChart) { _repChart.destroy(); _repChart = null; }
  _repChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: labels.map(fmt),
      datasets: [{
        label: 'Ventas',
        data: values,
        fill: true,
        backgroundColor: gradient,
        borderColor: '#3b82f6',
        borderWidth: 2.5,
        tension: 0.35,
        pointRadius: labels.length <= 1 ? 5 : 0,
        pointHoverRadius: 5,
        pointHitRadius: 16,
        pointBackgroundColor: '#3b82f6',
        pointHoverBackgroundColor: '#3b82f6',
        pointHoverBorderColor: '#e8edf5',
        pointHoverBorderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          padding: 10,
          cornerRadius: 8,
          titleFont: { size: 12, weight: '700' },
          bodyFont: { size: 12 },
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
          ticks: { color: '#8fa3c2', font: { size: 10 }, maxRotation: 0, minRotation: 0, autoSkip: true, maxTicksLimit: 7 },
          grid:  { display: false },
          border: { display: false },
        },
        y: {
          ticks: {
            color: '#8fa3c2', font: { size: 10 }, maxTicksLimit: 4,
            callback: v => 'RD$ ' + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v),
          },
          grid: { color: 'rgba(71,100,148,0.12)', borderDash: [4, 4] },
          border: { display: false },
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

// ── Mis Secuencias NCF (facturación propia del contador) ───────────────
// A diferencia de "Secuencias NCF" (que el contador registra PARA sus
// clientes, vía cola ncf_pendientes que aplica el POS del cliente), esto
// son los rangos que la DGII le autorizó al propio contador para facturar
// sus servicios — se guarda y se consume directo aquí, sin ningún POS de
// por medio. Sin una secuencia activa, guardarFactura() en el backend
// rechaza la emisión (ver POST /api/mis-secuencias-ncf y getNextNcf en
// server.js) — nunca se inventa un NCF sin respaldo real.

const MIS_NCF_TIPOS = [
  { code: 'B02', label: 'B02 — Consumidor Final' },
  { code: 'B01', label: 'B01 — Crédito Fiscal' },
  { code: 'B14', label: 'B14 — Régimen Especial' },
  { code: 'B15', label: 'B15 — Gubernamental' },
  { code: 'B16', label: 'B16 — Exportación' },
];

let _misNcf = [];
let _mnAdjuntoDataUrl = null;
let _mnEditTargetId = null;

async function abrirMisSecuenciasNcf() {
  show('modal-mis-ncf-lista');
  await loadMisSecuenciasNcf();
}

function cerrarMisSecuenciasNcf() { hide('modal-mis-ncf-lista'); }

async function loadMisSecuenciasNcf() {
  const body = $id('mis-ncf-lista-body');
  if (body) body.innerHTML = `<div class="empty-state"><div class="empty-icon">🔄</div><div class="empty-text">Cargando…</div></div>`;
  try {
    await refreshToken();
    _misNcf = await apiCall('GET', '/api/mis-secuencias-ncf');
    renderMisSecuenciasNcf();
  } catch (e) {
    if (body) body.innerHTML = `<div class="empty-state"><div style="color:#ef4444">Error: ${esc(e.message)}</div></div>`;
  }
}

function renderMisSecuenciasNcf() {
  const body = $id('mis-ncf-lista-body');
  if (!body) return;
  if (!_misNcf.length) {
    body.innerHTML = `<div class="empty-state"><div class="empty-icon">🏛</div><div class="empty-text">No tienes secuencias NCF registradas todavía.</div></div>`;
    return;
  }
  const colores = { activo: '#22C55E', agotado: '#ef4444', vencido: '#ef4444', suspendido: '#6b7280' };
  const labels  = { activo: 'Activo', agotado: 'Agotado', vencido: 'Vencido', suspendido: 'Suspendido' };
  body.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Tipo</th><th>Rango</th><th>Próximo</th><th>Disponibles</th><th>Vencimiento</th><th>Estado</th><th></th></tr></thead>
      <tbody>
        ${_misNcf.map(s => `
          <tr>
            <td>${esc(s.documentType)}</td>
            <td>${s.startNumber}–${s.endNumber}</td>
            <td>${s.nextNumber}</td>
            <td>${s.totalAvailable}</td>
            <td>${s.expirationDate ? fmtDate(s.expirationDate) : '—'}</td>
            <td><span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;color:#fff;background:${colores[s.effectiveStatus] || '#6b7280'}">${labels[s.effectiveStatus] || s.effectiveStatus}</span></td>
            <td style="white-space:nowrap">
              <button class="btn btn-xs btn-secondary" onclick="app.abrirRegistrarMiNcfModal('${s.id}')">✎ Editar</button>
              ${s.status === 'activo' ? `<button class="btn btn-xs btn-secondary" onclick="app.suspenderMiNcf('${s.id}')">⏸ Suspender</button>` : ''}
              ${s.status === 'suspendido' ? `<button class="btn btn-xs btn-secondary" onclick="app.activarMiNcf('${s.id}')">▶ Activar</button>` : ''}
              ${s.nextNumber === s.startNumber ? `<button class="btn btn-xs btn-danger" onclick="app.eliminarMiNcf('${s.id}')">🗑 Eliminar</button>` : ''}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function handleMiNcfAdjunto(input) {
  const file = input?.files?.[0];
  if (!file) return;
  if (file.size > 700 * 1024) { toast('El archivo debe pesar menos de 700 KB.', 'error'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    _mnAdjuntoDataUrl = e.target.result;
    const label = $id('mn-adjunto-nombre');
    if (label) label.textContent = `📎 ${file.name}`;
  };
  reader.readAsDataURL(file);
}

function abrirRegistrarMiNcfModal(editId) {
  _mnEditTargetId = editId || null;
  const seq = editId ? _misNcf.find((s) => String(s.id) === String(editId)) : null;
  _mnAdjuntoDataUrl = null;

  const tipoEl = $id('mn-tipo');
  if (tipoEl) tipoEl.innerHTML = MIS_NCF_TIPOS.map((t) => `<option value="${t.code}">${t.label}</option>`).join('');

  const set = (id, v) => { const el = $id(id); if (el) el.value = v || ''; };
  if (seq) {
    setText('mn-titulo', `🏛 Editar ${seq.documentType} · ${seq.startNumber}–${seq.endNumber}`);
    if (tipoEl) { tipoEl.value = seq.documentType; tipoEl.disabled = true; }
    set('mn-desde', seq.startNumber);
    $id('mn-desde').disabled = true;
    set('mn-hasta', seq.endNumber);
    set('mn-fecha-autorizacion', (seq.authorizationDate || '').slice(0, 10));
    set('mn-fecha-vencimiento', (seq.expirationDate || '').slice(0, 10));
    set('mn-referencia', seq.authorizationReference);
    set('mn-notas', seq.notes);
    // El adjunto no se reemplaza al editar (opcional) — se mantiene el ya guardado.
    const label = $id('mn-adjunto-nombre');
    if (label) label.textContent = seq.attachmentData ? '📎 Ya tiene documento adjunto (no se reemplaza al editar)' : '';
    $id('mn-adjunto-file').required = false;
  } else {
    setText('mn-titulo', '🏛 Registrar Mi Secuencia NCF');
    if (tipoEl) tipoEl.disabled = false;
    ['mn-desde','mn-hasta','mn-fecha-autorizacion','mn-fecha-vencimiento','mn-referencia','mn-notas'].forEach((id) => set(id, ''));
    $id('mn-desde').disabled = false;
    const label = $id('mn-adjunto-nombre');
    if (label) label.textContent = '';
    $id('mn-adjunto-file').value = '';
  }
  show('modal-registrar-mi-ncf');
}

function cerrarRegistrarMiNcfModal() { hide('modal-registrar-mi-ncf'); }

async function guardarMiNcf() {
  const get = (id) => $id(id)?.value?.trim() || '';
  try {
    await refreshToken();
    if (_mnEditTargetId) {
      await apiCall('PUT', `/api/mis-secuencias-ncf/${_mnEditTargetId}`, {
        endNumber: Number(get('mn-hasta')) || null,
        authorizationDate: get('mn-fecha-autorizacion') || null,
        expirationDate: get('mn-fecha-vencimiento') || null,
        authorizationReference: get('mn-referencia') || null,
        notes: get('mn-notas'),
      });
      toast('Secuencia actualizada.', 'success');
    } else {
      if (!_mnAdjuntoDataUrl) { toast('Sube el documento de autorización de la DGII.', 'error'); return; }
      await apiCall('POST', '/api/mis-secuencias-ncf', {
        documentType: get('mn-tipo'),
        startNumber: Number(get('mn-desde')) || 0,
        endNumber: Number(get('mn-hasta')) || 0,
        authorizationDate: get('mn-fecha-autorizacion') || null,
        expirationDate: get('mn-fecha-vencimiento') || null,
        authorizationReference: get('mn-referencia'),
        attachmentData: _mnAdjuntoDataUrl,
        notes: get('mn-notas'),
      });
      toast('Secuencia registrada y activa.', 'success');
    }
    cerrarRegistrarMiNcfModal();
    loadMisSecuenciasNcf();
  } catch (e) { toast(e.message, 'error'); }
}

async function suspenderMiNcf(id) {
  const seq = _misNcf.find((s) => String(s.id) === String(id));
  if (!seq) return;
  const reason = await pedirMotivoNcf(
    `Suspender ${seq.documentType} ${seq.startNumber}–${seq.endNumber}`,
    'El motivo es obligatorio. No podrás facturar con este rango hasta que la actives de nuevo.'
  );
  if (!reason) return;
  try {
    await refreshToken();
    await apiCall('POST', `/api/mis-secuencias-ncf/${id}/suspender`, { reason });
    toast('Secuencia suspendida.', 'success');
    loadMisSecuenciasNcf();
  } catch (e) { toast(e.message, 'error'); }
}

async function activarMiNcf(id) {
  try {
    await refreshToken();
    await apiCall('POST', `/api/mis-secuencias-ncf/${id}/activar`, {});
    toast('Secuencia activada.', 'success');
    loadMisSecuenciasNcf();
  } catch (e) { toast(e.message, 'error'); }
}

async function eliminarMiNcf(id) {
  const seq = _misNcf.find((s) => String(s.id) === String(id));
  if (!seq) return;
  if (!confirm(`¿Eliminar la secuencia ${seq.documentType} ${seq.startNumber}–${seq.endNumber}? Nunca se usó, así que se puede borrar sin problema.`)) return;
  try {
    await refreshToken();
    await apiCall('DELETE', `/api/mis-secuencias-ncf/${id}`);
    toast('Secuencia eliminada.', 'success');
    loadMisSecuenciasNcf();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Nueva Factura ─────────────────────────────────────────────────────

async function nuevaFactura() {
  _facItems = [{ descripcion: '', cantidad: 1, precio: 0, descuento: 0, itbis_rate: 18 }];
  const today = new Date().toISOString().slice(0, 10);
  const set = (id, v) => { const el = $id(id); if (el) el.value = v; };
  set('nf-fecha', today);
  ['nf-cli-nombre','nf-cli-rnc','nf-cli-dir','nf-cli-tel','nf-cli-correo','nf-observacion']
    .forEach(id => set(id, ''));

  // Autocomplete DGII en el RNC del cliente de facturación
  if (window.RNCLookup) {
    const rncEl    = $id('nf-cli-rnc');
    const nombreEl = $id('nf-cli-nombre');
    if (rncEl) {
      RNCLookup.attach(rncEl, {
        nameEl: nombreEl,
        mode: 'both',
        onSelect() {},
      });
    }
  }
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
    .inv-firma{display:flex;align-items:center;gap:12px}
    .inv-firma-logo{width:56px;height:56px;border-radius:10px;object-fit:cover;flex-shrink:0}
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
        ${f.contador_logo ? `<img src="${f.contador_logo}" class="inv-firma-logo">` : ''}
        <div>
          <h1>${esc(f.contador_nombre || '')}</h1>
          ${f.contador_rnc    ? `<p>RNC: ${f.contador_rnc}</p>` : ''}
          ${f.contador_tel    ? `<p>Tel: ${f.contador_tel}</p>` : ''}
          ${f.contador_correo ? `<p>${f.contador_correo}</p>`   : ''}
        </div>
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

  // Autocomplete DGII en el RNC del cliente de facturación
  if (window.RNCLookup) {
    const rncEl    = $id('clf-rnc');
    const nombreEl = $id('clf-nombre');
    if (rncEl) {
      RNCLookup.attach(rncEl, {
        nameEl: nombreEl,
        mode: 'both',
        onSelect() {},
      });
    }
  }

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
// COLABORADORES
// ══════════════════════════════════════════════════════════════════════

let _colabs        = [];        // array completo del servidor
let _colabsFiltered = [];       // resultado del filtro en tabla
let _colabEditId   = null;      // id del colaborador en edición (null = nuevo)
let _colabDetalleId = null;     // id del colaborador en vista detalle
let _negociosAsignar = [];      // cache de negocios para modal asignar

const PERMISOS_DEPENDIENTE = {
  puede: [
    'Iniciar sesión en la plataforma',
    'Ver clientes asignados',
    'Consultar reportes de clientes asignados',
    'Ver ventas y movimientos permitidos',
    'Cambiar contraseña propia',
  ],
  noPuede: [
    'Crear clientes propios',
    'Crear colaboradores',
    'Asignar clientes',
    'Crear empresas',
    'Gestionar licencias',
    'Ver negocios fuera de los asignados',
  ],
};

const PERMISOS_COMPLETO = {
  puede: [
    'Todo lo del Colaborador Dependiente',
    'Crear clientes propios',
    'Instalar Tecno Caja POS a clientes',
    'Registrar empresas',
    'Crear colaboradores propios',
    'Gestionar licencias',
    'Crear su propia red de trabajo',
  ],
  noPuede: [
    'Ver clientes privados de otros colaboradores',
  ],
};

function colabEstadoBadge(e) {
  const m = { activo: 'badge-active', inactivo: 'badge-pending', suspendido: 'badge-suspended', eliminado: 'badge-pending' };
  const labels = { activo: '✅ Activo', inactivo: '⚫ Inactivo', suspendido: '🚫 Suspendido', eliminado: '🗑 Eliminado' };
  return `<span class="badge ${m[e] || ''}">${labels[e] || e}</span>`;
}

function colabTipoBadge(t) {
  return t === 'completo'
    ? '<span class="badge badge-active" style="background:#7c3aed22;color:#a78bfa;border-color:#7c3aed">🌐 Completo</span>'
    : '<span class="badge badge-pending" style="background:#1e3a5f;color:#60a5fa;border-color:#2563eb">🔗 Dependiente</span>';
}

// ── Cargar listado ─────────────────────────────────────────────────────────
async function loadColaboradores() {
  setText('colab-subtitle', 'Cargando…');
  try {
    _colabs = await apiCall('GET', '/api/colaboradores');
    _colabsFiltered = _colabs.filter(c => c.estado !== 'eliminado');
    _renderColabStats();
    _renderColabTabla(_colabsFiltered);
    setText('colab-subtitle', `${_colabsFiltered.length} colaborador(es) en tu red`);
    // badge en nav
    const badge = $id('nav-badge-colab');
    if (badge) {
      const activos = _colabsFiltered.filter(c => c.estado === 'activo').length;
      if (activos > 0) { badge.textContent = activos; badge.classList.remove('hidden'); }
      else badge.classList.add('hidden');
    }
  } catch (e) {
    setText('colab-subtitle', 'Error cargando colaboradores');
    $id('colab-tbody').innerHTML = `<tr><td colspan="7" class="td-empty" style="color:#ef4444">${esc(e.message)}</td></tr>`;
  }
}

function _renderColabStats() {
  const lista = _colabs.filter(c => c.estado !== 'eliminado');
  setText('cs-total',   lista.length);
  setText('cs-activos', lista.filter(c => c.estado === 'activo').length);
  setText('cs-dep',     lista.filter(c => c.tipo === 'dependiente').length);
  setText('cs-comp',    lista.filter(c => c.tipo === 'completo').length);
}

function _renderColabTabla(lista) {
  const tbody = $id('colab-tbody');
  if (!lista.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="td-empty">No hay colaboradores registrados</td></tr>';
    return;
  }
  tbody.innerHTML = lista.map(c => `
    <tr>
      <td>
        <div style="font-weight:600;color:var(--text)">${esc(c.nombre)}</div>
        ${c.cedula ? `<div style="font-size:11px;color:var(--text-muted)">${esc(c.cedula)}</div>` : ''}
      </td>
      <td style="font-size:12px">${esc(c.email || '—')}</td>
      <td>${colabTipoBadge(c.tipo)}</td>
      <td>${colabEstadoBadge(c.estado)}</td>
      <td style="text-align:center">
        <span style="background:#1e3a5f;color:#60a5fa;border-radius:12px;padding:2px 10px;font-size:12px;font-weight:600">
          ${(c.clientesAsignados || []).length}
        </span>
      </td>
      <td style="font-size:11px;color:var(--text-muted)">${c.createdAt ? new Date(c.createdAt).toLocaleDateString('es-DO') : '—'}</td>
      <td style="text-align:center">
        <div style="display:flex;gap:4px;justify-content:center">
          <button class="btn btn-secondary btn-xs" onclick="app.verColabDetalle('${c.id}')">👁 Ver</button>
          <button class="btn btn-secondary btn-xs" onclick="app.abrirModalColab('${c.id}')">✏️</button>
          <button class="btn btn-danger btn-xs" onclick="app.eliminarColab('${c.id}')">🗑</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function filtrarColaboradores(q) {
  const t = (q || '').toLowerCase().trim();
  _colabsFiltered = _colabs.filter(c => {
    if (c.estado === 'eliminado') return false;
    if (!t) return true;
    return (c.nombre || '').toLowerCase().includes(t)
      || (c.email || '').toLowerCase().includes(t)
      || (c.cedula || '').toLowerCase().includes(t);
  });
  _renderColabTabla(_colabsFiltered);
}

// ── Modal crear/editar ─────────────────────────────────────────────────────
function abrirModalColab(id) {
  _colabEditId = id || null;
  const colab = id ? _colabs.find(c => c.id === id) : null;

  setText('mcolab-title', colab ? 'Editar colaborador' : 'Nuevo colaborador');
  setText('mcolab-sub', colab ? `Editando: ${colab.nombre}` : 'Completa los datos del nuevo miembro');

  // Resetear/rellenar campos
  const f = (elId, val) => { const el = $id(elId); if (el) el.value = val || ''; };
  f('mc-nombre',   colab?.nombre    || '');
  f('mc-cedula',   colab?.cedula    || '');
  f('mc-rnc',      colab?.rnc       || '');
  f('mc-correo',   colab?.email     || '');
  f('mc-telefono', colab?.telefono  || '');
  f('mc-whatsapp', colab?.whatsapp  || '');
  f('mc-direccion',colab?.direccion || '');
  f('mc-password', '');
  const estadoEl = $id('mc-estado');
  if (estadoEl) estadoEl.value = colab?.estado || 'activo';

  // Tipo
  const chk = $id('mc-check-dependiente');
  if (chk) chk.checked = (colab?.tipo || 'dependiente') === 'dependiente';
  toggleTipoColab((colab?.tipo || 'dependiente') === 'dependiente');

  // En modo edición: campo contraseña es opcional (botón separado)
  const pwGroup = $id('mc-pw-group');
  const pwInput = $id('mc-password');
  const btnPwChange = $id('mc-btn-pw-change');
  if (colab) {
    if (pwGroup)    pwGroup.style.display = 'none';
    if (btnPwChange) btnPwChange.style.display = '';
  } else {
    if (pwGroup)    pwGroup.style.display = '';
    if (btnPwChange) btnPwChange.style.display = 'none';
  }

  // El correo no se puede cambiar (Firebase Auth limitation)
  const correoEl = $id('mc-correo');
  if (correoEl) correoEl.disabled = !!colab;

  show('modal-colaborador');

  // Conectar autocomplete DGII a ambos campos
  if (window.RNCLookup) {
    const cedulaEl = $id('mc-cedula');
    const nombreEl = $id('mc-nombre');

    // Buscar por ID desde el campo Cédula/RNC → rellena nombre automáticamente
    if (cedulaEl) {
      RNCLookup.attach(cedulaEl, {
        nameEl: nombreEl,
        mode: 'both',
        onSelect(data) {
          if (nombreEl && !nombreEl.value) nombreEl.value = data.nombre || '';
          const rncEl = $id('mc-rnc');
          if (rncEl && data.rnc) {
            const digits = String(data.rnc).replace(/\D/g, '');
            rncEl.value = digits.length === 9 ? data.rnc : '';
          }
        },
      });
    }

    // Buscar por nombre desde el campo Nombre/Empresa → rellena cédula/RNC automáticamente
    if (nombreEl) {
      RNCLookup.attach(nombreEl, {
        mode: 'name',
        idEl: cedulaEl,
        onSelect(data) {
          const rncEl = $id('mc-rnc');
          if (rncEl && data.rnc) {
            const digits = String(data.rnc).replace(/\D/g, '');
            rncEl.value = digits.length === 9 ? data.rnc : '';
          }
        },
      });
    }
  }
}

function cerrarModalColab() { hide('modal-colaborador'); }

function toggleTipoColab(checked) {
  const badge = $id('mc-tipo-badge');
  const desc  = $id('mc-tipo-desc');
  const perms = checked ? PERMISOS_DEPENDIENTE : PERMISOS_COMPLETO;

  if (badge) badge.innerHTML = checked
    ? colabTipoBadge('dependiente') + ' <span style="font-size:11px;color:var(--text-muted);margin-left:6px">Este colaborador NO puede crear sus propios clientes</span>'
    : colabTipoBadge('completo')    + ' <span style="font-size:11px;color:var(--text-muted);margin-left:6px">Este colaborador tiene acceso completo a la plataforma</span>';

  if (desc) desc.innerHTML = checked
    ? 'Al activar este check, el colaborador será <strong style="color:#60a5fa">Dependiente</strong>: solo podrá ver y gestionar los clientes que le asignes.'
    : 'Sin este check, el colaborador funciona como <strong style="color:#a78bfa">Contador Completo</strong>: puede crear sus propios clientes y formar su propia red.';

  const pLista = $id('mc-permite-list');
  const bLista = $id('mc-bloquea-list');
  if (pLista) pLista.innerHTML = perms.puede.map(p => `• ${p}`).join('<br>');
  if (bLista) bLista.innerHTML = perms.noPuede.map(p => `• ${p}`).join('<br>');
}

async function guardarColab() {
  const get = id => ($id(id)?.value || '').trim();
  const nombre   = get('mc-nombre');
  const correo   = get('mc-correo');
  const password = get('mc-password');
  const tipo     = $id('mc-check-dependiente')?.checked ? 'dependiente' : 'completo';
  const estado   = $id('mc-estado')?.value || 'activo';

  if (!nombre)  { toast('El nombre es requerido.', 'error'); return; }
  if (!_colabEditId && !correo) { toast('El correo es requerido.', 'error'); return; }
  if (!_colabEditId && password.length < 6) { toast('La contraseña debe tener al menos 6 caracteres.', 'error'); return; }

  const btn = $id('mc-btn-guardar');
  if (btn) btn.disabled = true;

  try {
    // Detectar si el campo Cédula/RNC tiene una cédula (11 dígitos) o RNC (9 dígitos)
    const cedulaRncRaw = get('mc-cedula').replace(/\D/g, '');
    const esCedula = cedulaRncRaw.length === 11;
    const body = {
      nombre,
      cedula:    esCedula ? get('mc-cedula') : '',
      rnc:       esCedula ? (get('mc-rnc') || '') : get('mc-cedula'),
      telefono:  get('mc-telefono'),
      whatsapp:  get('mc-whatsapp'),
      direccion: get('mc-direccion'),
      tipo, estado,
    };

    if (_colabEditId) {
      await apiCall('PUT', `/api/colaboradores/${_colabEditId}`, body);
      toast('Colaborador actualizado.', 'success');
    } else {
      body.correo   = correo;
      body.password = password;
      await apiCall('POST', '/api/colaboradores', body);
      toast('Colaborador creado. Ya puede iniciar sesión.', 'success');
    }

    cerrarModalColab();
    await loadColaboradores();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function cambiarPwColab() {
  if (!_colabEditId) return;
  const pw = prompt('Nueva contraseña (mínimo 6 caracteres):');
  if (!pw) return;
  if (pw.length < 6) { toast('La contraseña debe tener al menos 6 caracteres.', 'error'); return; }
  try {
    await apiCall('POST', `/api/colaboradores/${_colabEditId}/cambiar-password`, { password: pw });
    toast('Contraseña actualizada.', 'success');
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

async function eliminarColab(id) {
  const colab = _colabs.find(c => c.id === id);
  if (!confirm(`¿Eliminar a ${colab?.nombre || id}?\nSe deshabilitará su acceso. No se puede deshacer.`)) return;
  try {
    await apiCall('DELETE', `/api/colaboradores/${id}`);
    toast('Colaborador eliminado.', 'success');
    await loadColaboradores();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

// ── Vista detalle ──────────────────────────────────────────────────────────
async function verColabDetalle(id) {
  _colabDetalleId = id;
  goto('colab-detalle');

  try {
    const colab = await apiCall('GET', `/api/colaboradores/${id}`);
    const esD = colab.tipo === 'dependiente';

    setText('cdet-nombre', colab.nombre || '—');
    $id('cdet-tipo-badge').innerHTML = colabTipoBadge(colab.tipo) + ' ' + colabEstadoBadge(colab.estado);

    // Info personal
    $id('cdet-info').innerHTML = [
      ['📧', 'Correo',     colab.email     || '—'],
      ['🪪', 'Cédula',     colab.cedula    || '—'],
      ['📄', 'RNC',        colab.rnc       || '—'],
      ['📱', 'Teléfono',   colab.telefono  || '—'],
      ['💬', 'WhatsApp',   colab.whatsapp  || '—'],
      ['📍', 'Dirección',  colab.direccion || '—'],
      ['📅', 'Creado',     colab.createdAt ? new Date(colab.createdAt).toLocaleDateString('es-DO') : '—'],
    ].map(([icon, label, val]) =>
      `<div class="info-row"><span class="info-icon">${icon}</span><span class="info-label">${label}:</span><span class="info-value">${esc(val)}</span></div>`
    ).join('');

    // Permisos
    const perms = esD ? PERMISOS_DEPENDIENTE : PERMISOS_COMPLETO;
    $id('cdet-permisos').innerHTML = `
      <div style="margin-bottom:10px">
        <div style="font-size:12px;font-weight:700;color:#4ade80;margin-bottom:4px">✅ Puede hacer</div>
        <div style="font-size:12px;color:#86efac;line-height:1.8">${perms.puede.map(p => '• ' + p).join('<br>')}</div>
      </div>
      <div>
        <div style="font-size:12px;font-weight:700;color:#f87171;margin-bottom:4px">❌ No puede hacer</div>
        <div style="font-size:12px;color:#fca5a5;line-height:1.8">${perms.noPuede.map(p => '• ' + p).join('<br>')}</div>
      </div>`;

    // Acciones
    $id('cdet-actions').innerHTML = `
      <button class="btn btn-secondary" onclick="app.abrirModalColab('${id}')">✏️ Editar</button>
      <button class="btn btn-danger" onclick="app.eliminarColab('${id}')">🗑 Eliminar</button>`;

    // Cargar negocios asignados
    await _renderColabClientes(id);
  } catch (e) {
    toast('Error cargando detalle: ' + e.message, 'error');
  }
}

async function _renderColabClientes(colabId) {
  const grid = $id('cdet-clientes-grid');
  if (!grid) return;
  try {
    const clientes = await apiCall('GET', `/api/colaboradores/${colabId}/clientes`);
    if (!clientes.length) {
      grid.innerHTML = '<div class="empty-state"><div class="empty-icon">🏪</div><div class="empty-text">Sin negocios asignados</div></div>';
      return;
    }
    grid.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">
      ${clientes.map(c => `
        <div style="background:var(--surface);border:1px solid #2d3a52;border-radius:10px;padding:14px;display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-weight:600;color:var(--text);font-size:13px">${esc(c.businessName)}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${esc(c.propietario)} • ${esc(c.rnc)}</div>
            <div style="margin-top:4px">${statusBadge(c.status)}</div>
          </div>
          <button class="btn btn-danger btn-xs" onclick="app.quitarCliente('${colabId}','${c.id}')">✕ Quitar</button>
        </div>`).join('')}
    </div>`;
  } catch (e) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-text" style="color:#ef4444">Error: ${esc(e.message)}</div></div>`;
  }
}

async function quitarCliente(colabId, businessId) {
  if (!confirm('¿Quitar este negocio del colaborador?')) return;
  try {
    await apiCall('DELETE', `/api/colaboradores/${colabId}/clientes/${businessId}`);
    toast('Negocio removido.', 'success');
    await _renderColabClientes(colabId);
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

// ── Modal asignar negocio ──────────────────────────────────────────────────
async function abrirModalAsignar() {
  if (!_colabDetalleId) return;
  const colab = await apiCall('GET', `/api/colaboradores/${_colabDetalleId}`).catch(() => null);
  setText('masig-colab-nombre', colab ? `Asignando a: ${colab.nombre}` : '');

  show('modal-asignar-cliente');
  $id('masig-search').value = '';

  // Cargar negocios disponibles
  try {
    _negociosAsignar = await apiCall('GET', '/api/clientes');
    _renderNegociosAsignar(_negociosAsignar, colab?.clientesAsignados || []);
  } catch (e) {
    $id('masig-lista').innerHTML = `<div style="text-align:center;padding:20px;color:#ef4444">Error: ${esc(e.message)}</div>`;
  }
}

function cerrarModalAsignar() { hide('modal-asignar-cliente'); }

function _renderNegociosAsignar(lista, yaAsignados) {
  const el = $id('masig-lista');
  if (!lista.length) {
    el.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-muted)">Sin negocios disponibles</div>';
    return;
  }
  el.innerHTML = lista.map(n => {
    const asignado = (yaAsignados || []).includes(n.id);
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #2d3a52">
      <div>
        <div style="font-weight:600;color:var(--text);font-size:13px">${esc(n.businessName || n.id)}</div>
        <div style="font-size:11px;color:var(--text-muted)">${esc(n.propietario || '')} • ${esc(n.rnc || '')} • ${statusBadge(n.status).replace(/<[^>]+>/g,'').trim()}</div>
      </div>
      ${asignado
        ? '<span style="font-size:11px;color:#4ade80;font-weight:600">✅ Ya asignado</span>'
        : `<button class="btn btn-primary btn-xs" onclick="app.asignarNegocio('${n.id}','${esc(n.businessName || n.id)}')">Asignar</button>`
      }
    </div>`;
  }).join('');
}

function filtrarNegociosAsignar(q) {
  const t = (q || '').toLowerCase().trim();
  const filtrados = t
    ? _negociosAsignar.filter(n =>
        (n.businessName || '').toLowerCase().includes(t) ||
        (n.rnc || '').toLowerCase().includes(t) ||
        (n.propietario || '').toLowerCase().includes(t))
    : _negociosAsignar;
  _renderNegociosAsignar(filtrados, []);
}

async function asignarNegocio(businessId, businessName) {
  if (!_colabDetalleId) return;
  try {
    await apiCall('POST', `/api/colaboradores/${_colabDetalleId}/asignar`, { businessId });
    toast(`"${businessName}" asignado correctamente.`, 'success');
    cerrarModalAsignar();
    await _renderColabClientes(_colabDetalleId);
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════════════
// ANÁLISIS GLOBAL
// ══════════════════════════════════════════════════════════════════════

async function loadAnalisisGlobal() {
  const sub = $id('ag-sub');
  if (sub) sub.textContent = 'Cargando datos agregados…';
  try {
    await refreshToken();
    const data = await apiCall('GET', '/api/analisis-global');
    const { resumen, topClientes } = data;
    const fmt = v => fmtMoney(v);

    setText('ag-ventas-mes', fmt(resumen.totalVentasMes));
    setText('ag-ventas-hoy', fmt(resumen.totalVentasHoy));
    setText('ag-itbis-mes',  fmt(resumen.totalItbisMes));
    setText('ag-facturas',   resumen.totalFacturasEmitidas.toLocaleString());
    setText('ag-cxc',        fmt(resumen.totalCxcPendiente));
    setText('ag-con-datos',  `${resumen.clientesConPosData} / ${resumen.totalClientes}`);
    setText('ag-sin-sync',   resumen.clientesSinSync7dias);
    setText('ag-total',      resumen.totalClientes);

    const topWrap = $id('ag-top-wrap');
    const sinDatos = $id('ag-sin-datos');

    if (topClientes.length === 0) {
      if (topWrap)  topWrap.style.display  = 'none';
      if (sinDatos) sinDatos.style.display = '';
    } else {
      if (topWrap)  topWrap.style.display  = '';
      if (sinDatos) sinDatos.style.display = 'none';
      const tbody = $id('ag-top-tbody');
      if (tbody) {
        tbody.innerHTML = topClientes.map((c, i) => {
          const posCls = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
          return `<tr>
            <td><span class="ag-top-pos ${posCls}">${i + 1}</span></td>
            <td style="font-weight:600">${esc(c.businessName)}</td>
            <td>${statusBadge(c.status)}</td>
            <td class="td-amount">${fmtMoney(c.ventasMes)}</td>
            <td class="td-amount" style="color:#f59e0b">${fmtMoney(c.itbisMes)}</td>
            <td style="text-align:center">${c.facturas}</td>
            <td><button class="btn btn-xs btn-secondary" onclick="app.verCliente('${c.id}')">Ver</button></td>
          </tr>`;
        }).join('');
      }
    }

    if (sub) sub.textContent = `Último actualización: ${new Date().toLocaleTimeString('es-DO')}`;
  } catch (e) {
    toast('Error cargando análisis global: ' + e.message, 'error');
    if (sub) sub.textContent = 'Error al cargar datos.';
  }
}

// ══════════════════════════════════════════════════════════════════════
// CENTRO FISCAL
// ══════════════════════════════════════════════════════════════════════

let _cfObligaciones = [];
let _cfTareas       = [];
let _cfFilObl  = 'todos';
let _cfFilTarea = 'pendiente';

async function loadCentroFiscal() {
  // Inicializar selector de año
  const sel = $id('cf-anio-sel');
  if (sel && !sel.children.length) {
    const anioActual = new Date().getFullYear();
    for (let y = anioActual - 1; y <= anioActual + 1; y++) {
      const opt = document.createElement('option');
      opt.value = y; opt.textContent = y;
      if (y === anioActual) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  // Populate tarea-negocio select if empty
  const tnSel = $id('tarea-negocio');
  if (tnSel && tnSel.options.length <= 1 && _allClientes.length) {
    _allClientes.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.businessName || c.businessKey || c.id;
      tnSel.appendChild(opt);
    });
  }

  await Promise.all([_cargarObligaciones(), _cargarTareas()]);
}

async function _cargarObligaciones() {
  const anio = $id('cf-anio-sel')?.value || new Date().getFullYear();
  try {
    await refreshToken();
    _cfObligaciones = await apiCall('GET', `/api/centro-fiscal/obligaciones?anio=${anio}`);
    _renderObligaciones();
  } catch (e) {
    const el = $id('cf-obligaciones-list');
    if (el) el.innerHTML = `<div style="color:#ef4444;padding:12px">${e.message}</div>`;
  }
}

async function _cargarTareas() {
  try {
    await refreshToken();
    _cfTareas = await apiCall('GET', '/api/centro-fiscal/tareas');
    _renderTareas();
  } catch (e) {
    const el = $id('cf-tareas-list');
    if (el) el.innerHTML = `<div style="color:#ef4444;padding:12px">${e.message}</div>`;
  }
}

function filtrarObligaciones(fil, btn) {
  _cfFilObl = fil;
  document.querySelectorAll('.cf-fil').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  _renderObligaciones();
}

function filtrarTareas(fil, btn) {
  _cfFilTarea = fil;
  document.querySelectorAll('.cf-tfil').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  _renderTareas();
}

function _renderObligaciones() {
  const el = $id('cf-obligaciones-list');
  if (!el) return;

  let lista = _cfObligaciones;
  if (_cfFilObl !== 'todos') {
    const isTipo = ['mensual','trimestral','anual'].includes(_cfFilObl);
    lista = lista.filter(o => isTipo ? o.tipo === _cfFilObl : o.estado === _cfFilObl);
  }

  if (!lista.length) {
    el.innerHTML = '<div style="text-align:center;padding:24px;color:#5a7099">Sin obligaciones para el filtro seleccionado.</div>';
    return;
  }

  const iconEstado = { urgente: '🔴', proxima: '🟡', vencida: '⚫', pendiente: '🟢' };
  const labelEstado = { urgente: 'Urgente', proxima: 'Próxima', vencida: 'Vencida', pendiente: 'Al día' };

  el.innerHTML = lista.map(o => {
    let diasTxt = '';
    if (o.diasRestantes < 0)     diasTxt = `<span class="obl-dias-vencida">Vencida hace ${Math.abs(o.diasRestantes)}d</span>`;
    else if (o.diasRestantes <= 7)  diasTxt = `<span class="obl-dias-urgente">⚡ ${o.diasRestantes}d restantes</span>`;
    else if (o.diasRestantes <= 30) diasTxt = `<span class="obl-dias-proxima">⚠ ${o.diasRestantes}d restantes</span>`;
    else                            diasTxt = `<span class="obl-dias-pendiente">${o.diasRestantes}d</span>`;

    return `<div class="obl-item ${o.estado}">
      <div style="flex:1">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">
          <span class="obl-form">${o.form}</span>
          <span class="obl-badge">${o.tipo}</span>
        </div>
        <div class="obl-desc">${o.desc}</div>
        <div class="obl-date">📅 Vence: ${o.fecha}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:16px">${iconEstado[o.estado] || '⚪'}</div>
        <div style="font-size:10px;color:var(--text-sub)">${labelEstado[o.estado] || ''}</div>
        <div style="margin-top:4px">${diasTxt}</div>
      </div>
    </div>`;
  }).join('');
}

function _renderTareas() {
  const el = $id('cf-tareas-list');
  if (!el) return;

  let lista = _cfTareas;
  if (_cfFilTarea !== 'todos') {
    lista = lista.filter(t => t.estado === _cfFilTarea);
  }

  if (!lista.length) {
    el.innerHTML = `<div style="text-align:center;padding:32px;color:#5a7099">
      <div style="font-size:28px;margin-bottom:8px">✅</div>
      <div>${_cfFilTarea === 'pendiente' ? 'Sin tareas pendientes' : 'Sin tareas completadas'}</div>
      <button class="btn btn-secondary" style="margin-top:12px" onclick="app.abrirModalTarea(null)">+ Agregar tarea</button>
    </div>`;
    return;
  }

  const hoy = new Date().toISOString().slice(0, 10);
  el.innerHTML = lista.map(t => {
    const vencida = t.fecha_vencimiento && t.fecha_vencimiento < hoy && t.estado !== 'completada';
    const chkState = t.estado === 'completada' ? 'checked' : '';
    const chkAction = t.estado === 'completada'
      ? `app.reabrirTarea('${t.id}')`
      : `app.completarTarea('${t.id}')`;
    const tipoColors = { itbis:'#f59e0b', tss:'#10b981', '606':'#60a5fa', '607':'#a78bfa', ir:'#fb923c', ncf:'#34d399', auditoria:'#f87171', general:'#94a3b8' };
    const tipoColor = tipoColors[t.tipo] || '#94a3b8';

    return `<div class="tarea-item ${t.estado} ${vencida ? 'vencida-task' : ''}">
      <input type="checkbox" class="tarea-chk" ${chkState} onchange="${chkAction}" />
      <div style="flex:1">
        <div class="tarea-desc" style="${t.estado === 'completada' ? 'text-decoration:line-through;' : ''}">${esc(t.titulo)}</div>
        <div class="tarea-meta">
          <span style="background:${tipoColor}22;color:${tipoColor};padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600">${(t.tipo||'general').toUpperCase()}</span>
          ${t.fecha_vencimiento ? `<span style="margin-left:6px;${vencida ? 'color:#ef4444;font-weight:600' : ''}">📅 ${t.fecha_vencimiento}</span>` : ''}
          ${t.businessName ? `<span class="tarea-negocio" style="margin-left:6px">🏪 ${esc(t.businessName)}</span>` : ''}
        </div>
        ${t.notas ? `<div style="font-size:11px;color:var(--text-sub);margin-top:3px;font-style:italic">${esc(t.notas)}</div>` : ''}
      </div>
      <button class="btn btn-xs btn-danger" style="flex-shrink:0" onclick="app.eliminarTarea('${t.id}')">🗑</button>
    </div>`;
  }).join('');
}

let _tareaEditId = null;

function abrirModalTarea() {
  _tareaEditId = null;
  ['tarea-titulo','tarea-notas'].forEach(id => { const el = $id(id); if (el) el.value = ''; });
  const tipoEl = $id('tarea-tipo'); if (tipoEl) tipoEl.value = 'general';
  const fechaEl = $id('tarea-fecha'); if (fechaEl) fechaEl.value = '';
  const negEl = $id('tarea-negocio');
  if (negEl) {
    negEl.innerHTML = '<option value="">— Ninguno —</option>';
    _allClientes.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.businessName || c.businessKey || c.id;
      negEl.appendChild(opt);
    });
  }
  show('modal-tarea');
}

function cerrarModalTarea() { hide('modal-tarea'); }

async function guardarTarea() {
  const titulo = $id('tarea-titulo')?.value?.trim();
  if (!titulo) { toast('El título es requerido.', 'error'); return; }

  const negEl = $id('tarea-negocio');
  const bizId = negEl?.value || null;
  const bizName = bizId ? negEl.options[negEl.selectedIndex]?.text : null;

  try {
    await refreshToken();
    await apiCall('POST', '/api/centro-fiscal/tareas', {
      titulo,
      tipo:              $id('tarea-tipo')?.value  || 'general',
      fecha_vencimiento: $id('tarea-fecha')?.value || null,
      businessId:  bizId,
      businessName: bizName,
      notas: $id('tarea-notas')?.value?.trim() || null,
    });
    toast('Tarea guardada.', 'success');
    cerrarModalTarea();
    _cargarTareas();
  } catch (e) { toast(e.message, 'error'); }
}

async function completarTarea(id) {
  try {
    await refreshToken();
    await apiCall('PUT', `/api/centro-fiscal/tareas/${id}/completar`);
    toast('Tarea marcada como completada.', 'success');
    _cargarTareas();
  } catch (e) { toast(e.message, 'error'); }
}

async function reabrirTarea(id) {
  try {
    await refreshToken();
    await apiCall('PUT', `/api/centro-fiscal/tareas/${id}/reabrir`);
    _cargarTareas();
  } catch (e) { toast(e.message, 'error'); }
}

async function eliminarTarea(id) {
  if (!confirm('¿Eliminar esta tarea?')) return;
  try {
    await refreshToken();
    await apiCall('DELETE', `/api/centro-fiscal/tareas/${id}`);
    toast('Tarea eliminada.', 'success');
    _cargarTareas();
  } catch (e) { toast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════
// GENERADOR 606/607/608 DESDE ARCHIVO EXPORTADO DEL NEGOCIO
// ══════════════════════════════════════════════════════════════════════
// El negocio exporta su detalle fiscal desde Tecno Caja POS (Reportes →
// Fiscal DGII → "Exportar para el Contador"). Aquí se importa ese JSON y
// se generan los .txt de envío + un Excel de trabajo. No hay conexión en
// vivo al POS del cliente — el flujo es exportar/importar por diseño.

let _dgiiImport = null;

function _dgiiFecha(iso) {
  const s = String(iso || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.replace(/-/g, '') : '';
}

function _dgiiMonto(n) {
  return (Number(n) || 0).toFixed(2);
}

// Formatos pipe-delimited basados en la Guía de Envío de Datos de la DGII.
// Columnas que el POS aún no captura por transacción (retenciones, ISC,
// tipo de bienes/servicios) quedan en 0/valor por defecto — revisar antes
// de presentar.
function _buildLinea606(c) {
  return [
    c.rncProveedor || '', c.tipoIdentificacion || '', '11', c.ncf || '', '',
    _dgiiFecha(c.fechaComprobante), _dgiiFecha(c.fechaComprobante),
    _dgiiMonto(c.montoFacturado), _dgiiMonto(c.itbisFacturado),
    '0.00', '0.00', '0.00', '0.00', '0.00', '', '0.00', '0.00', '0.00', '0.00', '',
  ].join('|');
}

function _buildLinea607(v) {
  return [
    v.rncCedula || '', v.tipoIdentificacion || '', v.ncf || '', '', '01',
    _dgiiFecha(v.fecha), '',
    _dgiiMonto(v.montoFacturado), _dgiiMonto(v.itbisFacturado),
    '0.00', '0.00', '0.00', '0.00', '0.00', '0.00',
    _dgiiMonto(v.montoFacturado), '0.00', '0.00',
  ].join('|');
}

function _buildLinea608(a) {
  return [a.ncf || '', _dgiiFecha(a.fechaAnulacion)].join('|');
}

function cargarArchivoFiscal(event) {
  const file = event?.target?.files?.[0];
  if (!file) return;
  const statusEl = $id('cf-dgii-status');
  const resultEl = $id('cf-dgii-resultado');
  if (statusEl) statusEl.textContent = 'Leyendo archivo…';

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (data?.tipo !== 'tecno_caja_export_fiscal') {
        throw new Error('Este archivo no es un export fiscal válido de Tecno Caja.');
      }
      _dgiiImport = data;
      const resumenEl = $id('cf-dgii-resumen');
      if (resumenEl) {
        resumenEl.innerHTML = `
          <strong>${esc(data.negocio?.nombre || 'Negocio')}</strong> (RNC ${esc(data.negocio?.rnc || '—')})<br>
          Período: ${esc(data.periodo?.desde || '?')} a ${esc(data.periodo?.hasta || '?')}<br>
          607 Ventas: ${data.ventas607?.length || 0} registro(s) &nbsp;·&nbsp;
          606 Compras: ${data.compras606?.length || 0} registro(s) &nbsp;·&nbsp;
          608 Anulados: ${data.anulados608?.length || 0} registro(s)
        `;
      }
      if (resultEl) resultEl.style.display = '';
      if (statusEl) statusEl.textContent = `Archivo cargado: ${file.name}`;
    } catch (e) {
      _dgiiImport = null;
      if (resultEl) resultEl.style.display = 'none';
      if (statusEl) statusEl.textContent = '';
      toast(e.message || 'No se pudo leer el archivo.', 'error');
    }
  };
  reader.onerror = () => toast('No se pudo leer el archivo.', 'error');
  reader.readAsText(file);
}

function _descargarTexto(nombre, contenido) {
  const blob = new Blob([contenido], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function descargarDGII(formato) {
  if (!_dgiiImport) { toast('Primero carga el archivo fiscal del negocio.', 'warning'); return; }
  const rnc = (_dgiiImport.negocio?.rnc || 'negocio').replace(/[^\w-]/g, '');
  if (formato === '606') {
    _descargarTexto(`606_${rnc}.txt`, (_dgiiImport.compras606 || []).map(_buildLinea606).join('\r\n'));
  } else if (formato === '607') {
    _descargarTexto(`607_${rnc}.txt`, (_dgiiImport.ventas607 || []).map(_buildLinea607).join('\r\n'));
  } else if (formato === '608') {
    _descargarTexto(`608_${rnc}.txt`, (_dgiiImport.anulados608 || []).map(_buildLinea608).join('\r\n'));
  }
}

function descargarDGIIExcel() {
  if (!_dgiiImport) { toast('Primero carga el archivo fiscal del negocio.', 'warning'); return; }
  const rnc = (_dgiiImport.negocio?.rnc || 'negocio').replace(/[^\w-]/g, '');
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet((_dgiiImport.ventas607 || []).map(v => ({
    NCF: v.ncf, Tipo: v.tipoNcf, Fecha: v.fecha, 'RNC/Cédula': v.rncCedula,
    'Monto Facturado': v.montoFacturado, 'ITBIS Facturado': v.itbisFacturado,
  }))), '607 Ventas');

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet((_dgiiImport.compras606 || []).map(c => ({
    NCF: c.ncf, Tipo: c.tipoNcf, 'RNC Proveedor': c.rncProveedor, Fecha: c.fechaComprobante,
    'Monto Facturado': c.montoFacturado, 'ITBIS Facturado': c.itbisFacturado,
  }))), '606 Compras');

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet((_dgiiImport.anulados608 || []).map(a => ({
    NCF: a.ncf, Tipo: a.tipoNcf, 'Fecha Anulación': a.fechaAnulacion,
  }))), '608 Anulados');

  XLSX.writeFile(wb, `DGII_606_607_608_${rnc}.xlsx`);
}

// ══════════════════════════════════════════════════════════════════════
// CONTABILIDAD — Sistema Contable (Fase 1, en vivo vía Firestore)
// ══════════════════════════════════════════════════════════════════════
// A diferencia del generador 606/607/608 (que sigue siendo importar un
// archivo), esto lee datos que sync-pos-stats.js del POS ya sincroniza
// automáticamente en cada venta/cierre de caja — no hace falta que el
// negocio exporte nada. "Generar Asientos" llama al backend, que crea los
// asientos nuevos de forma idempotente y los guarda en Firestore.

let _ctbNegocioId = null;
let _ctbVista = 'plan';
let _ctbCuentas = [];
let _ctbAutoSyncing = false;

async function loadContabilidad() {
  const sel = $id('ctb-negocio-select');
  if (!sel) return;
  if (!_allClientes.length) {
    try {
      await refreshToken();
      _allClientes = await apiCall('GET', '/api/clientes');
    } catch (e) {
      toast('Error cargando negocios: ' + e.message, 'error');
    }
  }
  sel.innerHTML = '<option value="">— Selecciona un negocio —</option>' +
    _allClientes.map(c => `<option value="${c.id}">${esc(c.businessName || c.businessKey || c.id)}</option>`).join('');

  if (_ctbNegocioId) {
    sel.value = _ctbNegocioId;
    selNegocioContabilidad(_ctbNegocioId);
  } else {
    $id('ctb-state-empty').style.display = '';
    $id('ctb-state-data').style.display = 'none';
  }
}

async function selNegocioContabilidad(id) {
  if (!id) {
    _ctbNegocioId = null;
    $id('ctb-state-empty').style.display = '';
    $id('ctb-state-data').style.display = 'none';
    return;
  }
  _ctbNegocioId = id;
  $id('ctb-state-empty').style.display = 'none';
  $id('ctb-state-data').style.display = '';
  _ctbCuentas = [];
  await ctbSincronizarAutomatico();
  await ctbSwitchVista(_ctbVista);
}

async function ctbSincronizarAutomatico() {
  if (!_ctbNegocioId || _ctbAutoSyncing) return;
  _ctbAutoSyncing = true;
  try {
    await apiCall('POST', `/api/contabilidad/${_ctbNegocioId}/generar`);
  } catch (e) {
    console.warn('[contabilidad] sync automático falló:', e?.message || e);
  } finally {
    _ctbAutoSyncing = false;
  }
}

async function ctbGenerarAsientos() {
  if (!_ctbNegocioId) return;
  const btn = $id('ctb-btn-generar');
  if (btn) { btn.disabled = true; btn.textContent = 'Generando…'; }
  try {
    const res = await apiCall('POST', `/api/contabilidad/${_ctbNegocioId}/generar`);
    toast(res.asientosCreados > 0 ? `${res.asientosCreados} asiento(s) nuevo(s) generado(s).` : 'Todo al día — no había movimientos nuevos.', 'success');
    if (res.omitidosPorDesbalance > 0) {
      toast(`${res.omitidosPorDesbalance} movimiento(s) no se contabilizaron por venir desbalanceados (debe ≠ haber) — revisa el dato de origen y vuelve a generar.`, 'warning');
    }
    await ctbSwitchVista(_ctbVista);
  } catch (e) {
    toast(e.message || 'No se pudo generar.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Generar Asientos'; }
  }
}

async function ctbSwitchVista(vista, btn) {
  _ctbVista = vista;
  document.querySelectorAll('.ctb-vfil').forEach(b => b.classList.toggle('active', b.dataset.vista === vista));
  ['plan', 'asientos', 'diario', 'mayor', 'balance', 'er', 'bg', 'fe', 'indicadores', 'cierre', 'activos', 'centros', 'presupuesto', 'auditoria', 'config'].forEach(v => {
    const el = $id(`ctb-vista-${v}`);
    if (el) el.style.display = v === vista ? '' : 'none';
  });
  if (!_ctbNegocioId) return;
  if (!_ctbCuentas.length) await ctbCargarCuentas();
  if (vista === 'plan') ctbRenderPlan();
  if (vista === 'diario') await ctbCargarDiario();
  if (vista === 'mayor') ctbRenderMayorSelect();
  if (vista === 'balance') await ctbCargarBalance();
  if (vista === 'er') await ctbCargarEstadoResultados();
  if (vista === 'bg') await ctbCargarBalanceGeneral();
  if (vista === 'fe') await ctbCargarFlujoEfectivo();
  if (vista === 'indicadores') await ctbCargarIndicadores();
  if (vista === 'cierre') await ctbCargarCierre();
  if (vista === 'activos') await ctbCargarActivosFijos();
  if (vista === 'centros') await ctbCargarCentrosCosto();
  if (vista === 'presupuesto') await ctbCargarPresupuesto();
  if (vista === 'auditoria') await ctbCargarAuditoria();
  if (vista === 'config') await ctbCargarConfiguracion();
}

async function ctbCargarCuentas() {
  try {
    _ctbCuentas = await apiCall('GET', `/api/contabilidad/${_ctbNegocioId}/cuentas`);
  } catch (e) {
    toast('Error cargando plan de cuentas: ' + e.message, 'error');
  }
}

function ctbRenderPlan() {
  const tbody = $id('ctb-plan-tbody');
  if (!tbody) return;
  tbody.innerHTML = _ctbCuentas.map(c => `
    <tr><td>${esc(c.code)}</td><td>${c.parentCode ? '&nbsp;&nbsp;&nbsp;' : '<b>'}${esc(c.name)}${c.parentCode ? '' : '</b>'}</td><td>${esc(c.accountType)}</td></tr>
  `).join('') || '<tr><td colspan="3">Sin cuentas.</td></tr>';
}

function ctbCuentaOptions() {
  return _ctbCuentas.map(c => `<option value="${esc(c.code)}">${esc(c.code)} — ${esc(c.name)}</option>`).join('');
}

let _ctbUltimoDiario = [];

async function ctbCargarDiario() {
  const tbody = $id('ctb-diario-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="6">Cargando…</td></tr>';
  try {
    const asientos = await apiCall('GET', `/api/contabilidad/${_ctbNegocioId}/diario`);
    _ctbUltimoDiario = asientos;
    const cuentasByCode = new Map(_ctbCuentas.map(c => [c.code, c]));
    if (!tbody) return;
    tbody.innerHTML = asientos.flatMap(a => (a.lineas || []).map((l, i) => `
      <tr>
        <td>${esc(String(a.fecha || '').slice(0, 10))}</td>
        <td>${esc(a.descripcion)}${a.origen === 'automatico' ? ' <span style="font-size:11px;color:#5a7099;border:1px solid #2a3550;border-radius:4px;padding:1px 5px">auto</span>' : ''}</td>
        <td>${esc(l.cuenta)} — ${esc(cuentasByCode.get(l.cuenta)?.name || '')}</td>
        <td style="text-align:right">${l.debe ? Number(l.debe).toFixed(2) : ''}</td>
        <td style="text-align:right">${l.haber ? Number(l.haber).toFixed(2) : ''}</td>
        ${i === 0 ? `<td rowspan="${(a.lineas || []).length}" style="text-align:center;vertical-align:middle"><button class="btn btn-xs btn-secondary" style="padding:2px 6px" title="Copiar este asiento" onclick="app.ctbCopiarAsiento('${a.id}')">⧉</button></td>` : ''}
      </tr>`)).join('') || '<tr><td colspan="6">Sin movimientos.</td></tr>';
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6">${esc(e.message)}</td></tr>`;
  }
}

function ctbCopiarAsiento(id) {
  const original = _ctbUltimoDiario.find(a => a.id === id);
  if (!original) { toast('No se encontró el asiento original.', 'error'); return; }
  _ctbLineas = (original.lineas || []).map(l => ({
    cuenta: l.cuenta || '', debe: l.debe || '', haber: l.haber || '', centroCosto: l.centroCosto || '',
  }));
  $id('asiento-fecha').value = new Date().toISOString().slice(0, 10);
  $id('asiento-descripcion').value = (original.descripcion || '') + ' (copia)';
  ctbRenderLineasAsiento();
  $id('modal-asiento').classList.remove('hidden');
  toast('Asiento copiado — revisa fecha y montos antes de guardar.', 'info');
}

function ctbRenderMayorSelect() {
  const sel = $id('ctb-mayor-select');
  if (!sel) return;
  sel.innerHTML = ctbCuentaOptions();
  ctbCargarMayor();
}

async function ctbCargarMayor() {
  const sel = $id('ctb-mayor-select');
  const tbody = $id('ctb-mayor-tbody');
  if (!sel || !tbody || !sel.value) { if (tbody) tbody.innerHTML = ''; return; }
  tbody.innerHTML = '<tr><td colspan="4">Cargando…</td></tr>';
  try {
    const data = await apiCall('GET', `/api/contabilidad/${_ctbNegocioId}/mayor/${sel.value}`);
    setText('ctb-mayor-apertura', Number(data.openingBalance).toFixed(2));
    setText('ctb-mayor-cierre', Number(data.closingBalance).toFixed(2));
    tbody.innerHTML = data.rows.map(r => `
      <tr>
        <td>${esc(String(r.fecha || '').slice(0, 10))}</td>
        <td>${esc(r.descripcion)}</td>
        <td style="text-align:right">${r.debe ? Number(r.debe).toFixed(2) : ''}</td>
        <td style="text-align:right">${r.haber ? Number(r.haber).toFixed(2) : ''}</td>
        <td style="text-align:right">${Number(r.saldo).toFixed(2)}</td>
      </tr>`).join('') || '<tr><td colspan="5">Sin movimientos para esta cuenta.</td></tr>';
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5">${esc(e.message)}</td></tr>`;
  }
}

async function ctbCargarBalance() {
  const tbody = $id('ctb-balance-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="5">Cargando…</td></tr>';
  try {
    const data = await apiCall('GET', `/api/contabilidad/${_ctbNegocioId}/balance-comprobacion`);
    if (tbody) {
      tbody.innerHTML = data.rows.map(r => `
        <tr>
          <td>${esc(r.code)}</td><td>${esc(r.name)}</td>
          <td style="text-align:right">${Number(r.totalDebe).toFixed(2)}</td>
          <td style="text-align:right">${Number(r.totalHaber).toFixed(2)}</td>
          <td style="text-align:right">${Number(r.saldo).toFixed(2)}</td>
        </tr>`).join('') || '<tr><td colspan="5">Sin movimientos en este período.</td></tr>';
    }
    const cuadra = Math.abs(data.totales.totalDebe - data.totales.totalHaber) < 0.01;
    setText('ctb-balance-totales', `Debe: ${data.totales.totalDebe.toFixed(2)} · Haber: ${data.totales.totalHaber.toFixed(2)} · ${cuadra ? '✓ Cuadrado' : '✗ Descuadrado'}`);
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="5">${esc(e.message)}</td></tr>`;
  }
}

async function ctbCargarEstadoResultados() {
  const wrap = $id('ctb-er-body');
  if (wrap) wrap.innerHTML = 'Cargando…';
  try {
    const d = await apiCall('GET', `/api/contabilidad/${_ctbNegocioId}/estado-resultados`);
    const fila = (label, val, fuerte) => `
      <div style="display:flex;justify-content:space-between;padding:6px 0;${fuerte ? 'font-weight:700;border-top:1px solid #2a3550' : ''}">
        <span>${esc(label)}</span><span>${Number(val).toFixed(2)}</span>
      </div>`;
    if (wrap) wrap.innerHTML = `
      ${fila('Ventas Netas', d.ventasNetas)}
      ${fila('Costo de Ventas', d.costoVentas)}
      ${fila('Utilidad Bruta', d.utilidadBruta, true)}
      ${fila('Gastos Operativos', d.gastosOperativos)}
      ${fila('Utilidad Operativa', d.utilidadOperativa, true)}
      ${fila('Otros Ingresos', d.otrosIngresos)}
      ${fila('Otros Gastos', d.otrosGastos)}
      ${fila('Utilidad Neta', d.utilidadNeta, true)}
    `;
  } catch (e) {
    if (wrap) wrap.innerHTML = esc(e.message);
  }
}

async function ctbCargarBalanceGeneral() {
  const wrap = $id('ctb-bg-body');
  if (wrap) wrap.innerHTML = 'Cargando…';
  try {
    const d = await apiCall('GET', `/api/contabilidad/${_ctbNegocioId}/balance-general`);
    const lista = (rows) => rows.map(r => `
      <div style="display:flex;justify-content:space-between;padding:3px 0;font-size:13px">
        <span>${esc(r.code)} — ${esc(r.name)}</span><span>${Number(r.saldo).toFixed(2)}</span>
      </div>`).join('') || '<div style="color:#5a7099;font-size:13px">Sin saldo.</div>';
    if (wrap) wrap.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div>
          <h4>Activos Corrientes</h4>${lista(d.activos.corrientes)}
          <h4 style="margin-top:12px">Activos No Corrientes</h4>${lista(d.activos.noCorrientes)}
          <div style="font-weight:700;border-top:1px solid #2a3550;padding-top:6px;margin-top:8px">Total Activos: ${d.activos.total.toFixed(2)}</div>
        </div>
        <div>
          <h4>Pasivos Corrientes</h4>${lista(d.pasivos.corrientes)}
          <h4 style="margin-top:12px">Pasivos Largo Plazo</h4>${lista(d.pasivos.largoPlazo)}
          <div style="font-weight:700;border-top:1px solid #2a3550;padding-top:6px;margin-top:8px">Total Pasivos: ${d.pasivos.total.toFixed(2)}</div>
          <h4 style="margin-top:16px">Patrimonio</h4>${lista(d.patrimonio.cuentas)}
          <div style="font-weight:700;border-top:1px solid #2a3550;padding-top:6px;margin-top:8px">Total Patrimonio: ${d.patrimonio.total.toFixed(2)}</div>
        </div>
      </div>
      <div style="margin-top:16px;font-weight:700;${d.cuadra ? 'color:#22c55e' : 'color:#ef4444'}">
        Activos: ${d.activos.total.toFixed(2)} ${d.cuadra ? '=' : '≠'} Pasivos + Patrimonio: ${d.totalPasivoPatrimonio.toFixed(2)} ${d.cuadra ? '✓' : '✗'}
      </div>`;
  } catch (e) {
    if (wrap) wrap.innerHTML = esc(e.message);
  }
}

async function ctbCargarFlujoEfectivo() {
  const wrap = $id('ctb-fe-body');
  if (wrap) wrap.innerHTML = 'Cargando…';
  try {
    const d = await apiCall('GET', `/api/contabilidad/${_ctbNegocioId}/flujo-efectivo`);
    const fila = (label, val) => `<div style="display:flex;justify-content:space-between;padding:6px 0"><span>${esc(label)}</span><span>${Number(val).toFixed(2)}</span></div>`;
    if (wrap) wrap.innerHTML = `
      ${fila('Flujo de Operación', d.operacion)}
      ${fila('Flujo de Inversión', d.inversion)}
      ${fila('Flujo de Financiamiento', d.financiamiento)}
      <div style="font-weight:700;border-top:1px solid #2a3550;padding-top:6px;margin-top:8px;display:flex;justify-content:space-between">
        <span>Cambio Neto en Efectivo</span><span>${Number(d.neto).toFixed(2)}</span>
      </div>`;
  } catch (e) {
    if (wrap) wrap.innerHTML = esc(e.message);
  }
}

// ── Exportar Estados Financieros a PDF ──────────────────────────────────────
// Reusa el mismo mecanismo ya usado por Reportes/Facturas (_savePdf → IPC →
// Electron printToPDF nativo) — no depende de ninguna librería nueva.
function _ctbPdfDoc(neg, badge, bodyHtml) {
  const fecha = new Date().toLocaleDateString('es-DO', { day: '2-digit', month: 'long', year: 'numeric' });
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
  <title>${esc(badge)} — ${esc(neg?.businessName || '')}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#1a1a2e;padding:24px}
    .hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:12px;border-bottom:3px solid #3b82f6;margin-bottom:18px}
    h1{font-size:18px;font-weight:800;margin-bottom:3px}
    h2{font-size:13px;color:#5a7099;font-weight:400}
    .badge{display:inline-block;background:#3b82f6;color:#fff;font-size:10px;font-weight:700;padding:3px 10px;border-radius:20px;letter-spacing:.3px;text-transform:uppercase}
    .row{display:flex;justify-content:space-between;padding:6px 0;font-size:12px;border-bottom:1px solid #e2e8f0}
    .row.strong{font-weight:700;border-bottom:2px solid #1a1a2e;font-size:13px}
    h4{font-size:12px;color:#3b82f6;margin:14px 0 4px}
    table{width:100%;border-collapse:collapse;margin-top:4px}
    th{background:#3b82f6;color:#fff;padding:7px 10px;font-size:10px;text-align:left;text-transform:uppercase;letter-spacing:.3px}
    td{padding:6px 10px;border-bottom:1px solid #e2e8f0;font-size:11px}
    tr:nth-child(even) td{background:#f8fafc}
    .footer{text-align:center;font-size:10px;color:#94a3b8;margin-top:20px;padding-top:10px;border-top:1px solid #e2e8f0}
  </style></head><body>
  <div class="hdr">
    <div>
      <h1>${esc(neg?.businessName || '—')}</h1>
      <h2>RNC: ${esc(neg?.rnc || '—')}</h2>
    </div>
    <div style="text-align:right">
      <div class="badge">${esc(badge)}</div>
      <div style="font-size:11px;color:#5a7099;margin-top:5px">Generado: ${fecha}</div>
    </div>
  </div>
  ${bodyHtml}
  <div class="footer">Tecno Caja Contadores — Portal de Contadores Asociados</div>
  </body></html>`;
}

function _pdfFila(label, val, strong) {
  return `<div class="row${strong ? ' strong' : ''}"><span>${esc(label)}</span><span>RD$ ${Number(val).toFixed(2)}</span></div>`;
}

function _ctbPdfSlug(neg) {
  return (neg?.businessName || 'negocio').replace(/\s+/g, '_').slice(0, 30);
}

async function ctbExportarER() {
  if (!_ctbNegocioId) return;
  try {
    const d = await apiCall('GET', `/api/contabilidad/${_ctbNegocioId}/estado-resultados`);
    const neg = _allClientes.find(c => c.id === _ctbNegocioId);
    const body = `
      ${_pdfFila('Ventas Netas', d.ventasNetas)}
      ${_pdfFila('Costo de Ventas', d.costoVentas)}
      ${_pdfFila('Utilidad Bruta', d.utilidadBruta, true)}
      ${_pdfFila('Gastos Operativos', d.gastosOperativos)}
      ${_pdfFila('Utilidad Operativa', d.utilidadOperativa, true)}
      ${_pdfFila('Otros Ingresos', d.otrosIngresos)}
      ${_pdfFila('Otros Gastos', d.otrosGastos)}
      ${_pdfFila('Utilidad Neta', d.utilidadNeta, true)}
    `;
    const html = _ctbPdfDoc(neg, 'Estado de Resultados', body);
    await _savePdf(html, `EstadoResultados_${_ctbPdfSlug(neg)}_${new Date().toISOString().slice(0, 10)}.pdf`, false);
  } catch (e) { toast('Error generando PDF: ' + e.message, 'error'); }
}

async function ctbExportarBG() {
  if (!_ctbNegocioId) return;
  try {
    const d = await apiCall('GET', `/api/contabilidad/${_ctbNegocioId}/balance-general`);
    const neg = _allClientes.find(c => c.id === _ctbNegocioId);
    const lista = (rows) => rows.map(r => `<div class="row"><span>${esc(r.code)} — ${esc(r.name)}</span><span>RD$ ${Number(r.saldo).toFixed(2)}</span></div>`).join('') || '<div style="color:#94a3b8;font-size:11px">Sin saldo.</div>';
    const body = `
      <div style="display:flex;gap:24px">
        <div style="flex:1">
          <h4>Activos Corrientes</h4>${lista(d.activos.corrientes)}
          <h4>Activos No Corrientes</h4>${lista(d.activos.noCorrientes)}
          <div class="row strong"><span>Total Activos</span><span>RD$ ${d.activos.total.toFixed(2)}</span></div>
        </div>
        <div style="flex:1">
          <h4>Pasivos Corrientes</h4>${lista(d.pasivos.corrientes)}
          <h4>Pasivos Largo Plazo</h4>${lista(d.pasivos.largoPlazo)}
          <div class="row strong"><span>Total Pasivos</span><span>RD$ ${d.pasivos.total.toFixed(2)}</span></div>
          <h4>Patrimonio</h4>${lista(d.patrimonio.cuentas)}
          <div class="row strong"><span>Total Patrimonio</span><span>RD$ ${d.patrimonio.total.toFixed(2)}</span></div>
        </div>
      </div>
      <div class="row strong" style="margin-top:10px;${d.cuadra ? 'color:#16a34a' : 'color:#dc2626'}">
        <span>Activos ${d.cuadra ? '=' : '≠'} Pasivos + Patrimonio</span>
        <span>RD$ ${d.activos.total.toFixed(2)} / RD$ ${d.totalPasivoPatrimonio.toFixed(2)}</span>
      </div>
    `;
    const html = _ctbPdfDoc(neg, 'Balance General', body);
    await _savePdf(html, `BalanceGeneral_${_ctbPdfSlug(neg)}_${new Date().toISOString().slice(0, 10)}.pdf`, false);
  } catch (e) { toast('Error generando PDF: ' + e.message, 'error'); }
}

async function ctbExportarFE() {
  if (!_ctbNegocioId) return;
  try {
    const d = await apiCall('GET', `/api/contabilidad/${_ctbNegocioId}/flujo-efectivo`);
    const neg = _allClientes.find(c => c.id === _ctbNegocioId);
    const body = `
      ${_pdfFila('Flujo de Operación', d.operacion)}
      ${_pdfFila('Flujo de Inversión', d.inversion)}
      ${_pdfFila('Flujo de Financiamiento', d.financiamiento)}
      ${_pdfFila('Cambio Neto en Efectivo', d.neto, true)}
    `;
    const html = _ctbPdfDoc(neg, 'Flujo de Efectivo', body);
    await _savePdf(html, `FlujoEfectivo_${_ctbPdfSlug(neg)}_${new Date().toISOString().slice(0, 10)}.pdf`, false);
  } catch (e) { toast('Error generando PDF: ' + e.message, 'error'); }
}

async function ctbExportarIndicadores() {
  if (!_ctbNegocioId) return;
  try {
    const d = await apiCall('GET', `/api/contabilidad/${_ctbNegocioId}/indicadores`);
    const neg = _allClientes.find(c => c.id === _ctbNegocioId);
    const pct = (v) => v === null || v === undefined ? '—' : (v * 100).toFixed(1) + '%';
    const vez = (v) => v === null || v === undefined ? '—' : Number(v).toFixed(2) + 'x';
    const filaTxt = (label, txt) => `<div class="row"><span>${esc(label)}</span><span>${txt}</span></div>`;
    const body = `
      <div style="display:flex;gap:20px">
        <div style="flex:1">
          <h4>Liquidez</h4>
          ${filaTxt('Razón Corriente', vez(d.liquidez.razonCorriente))}
          ${filaTxt('Prueba Ácida', vez(d.liquidez.pruebaAcida))}
          ${filaTxt('Capital de Trabajo', 'RD$ ' + Number(d.liquidez.capitalTrabajo).toFixed(2))}
        </div>
        <div style="flex:1">
          <h4>Rentabilidad</h4>
          ${filaTxt('Margen Bruto', pct(d.rentabilidad.margenBruto))}
          ${filaTxt('Margen Operativo', pct(d.rentabilidad.margenOperativo))}
          ${filaTxt('Margen Neto', pct(d.rentabilidad.margenNeto))}
          ${filaTxt('ROA', pct(d.rentabilidad.roa))}
          ${filaTxt('ROE', pct(d.rentabilidad.roe))}
        </div>
        <div style="flex:1">
          <h4>Endeudamiento</h4>
          ${filaTxt('Razón de Endeudamiento', pct(d.endeudamiento.razonEndeudamiento))}
          ${filaTxt('Deuda / Patrimonio', vez(d.endeudamiento.deudaPatrimonio))}
          ${filaTxt('Autonomía Financiera', pct(d.endeudamiento.autonomia))}
        </div>
      </div>
      <h4 style="margin-top:16px">Comparativo Anual</h4>
      <table>
        <thead><tr><th>Año</th><th>Ventas Netas</th><th>Gastos Operativos</th><th>Utilidad Neta</th></tr></thead>
        <tbody>
          ${d.comparativoAnual.map(a => `<tr><td>${esc(a.anio)}</td><td>RD$ ${a.ventasNetas.toFixed(2)}</td><td>RD$ ${a.gastosOperativos.toFixed(2)}</td><td>RD$ ${a.utilidadNeta.toFixed(2)}</td></tr>`).join('') || '<tr><td colspan="4">Sin datos.</td></tr>'}
        </tbody>
      </table>
      <div class="row strong" style="margin-top:12px"><span>Flujo de Caja Proyectado (próximo mes)</span><span>RD$ ${Number(d.flujoProyectado).toFixed(2)}</span></div>
    `;
    const html = _ctbPdfDoc(neg, 'Indicadores Financieros', body);
    await _savePdf(html, `Indicadores_${_ctbPdfSlug(neg)}_${new Date().toISOString().slice(0, 10)}.pdf`, false);
  } catch (e) { toast('Error generando PDF: ' + e.message, 'error'); }
}

let _ctbIndChart = null;

async function ctbCargarIndicadores() {
  const wrapLiq   = $id('ctb-ind-liquidez');
  const wrapRent  = $id('ctb-ind-rentabilidad');
  const wrapDeuda = $id('ctb-ind-endeudamiento');
  const anualBody = $id('ctb-ind-anual-tbody');
  const proyEl    = $id('ctb-ind-proyeccion');
  if (wrapLiq) wrapLiq.innerHTML = 'Cargando…';
  try {
    const d = await apiCall('GET', `/api/contabilidad/${_ctbNegocioId}/indicadores`);

    const fila = (label, val, tipo) => {
      let txt = '—';
      if (val !== null && val !== undefined) {
        txt = tipo === 'pct' ? (val * 100).toFixed(1) + '%'
          : tipo === 'money' ? fmtMoney(val)
          : Number(val).toFixed(2) + 'x';
      }
      return `<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px"><span>${esc(label)}</span><span style="font-weight:600">${txt}</span></div>`;
    };

    if (wrapLiq) wrapLiq.innerHTML =
      fila('Razón Corriente', d.liquidez.razonCorriente, 'veces') +
      fila('Prueba Ácida', d.liquidez.pruebaAcida, 'veces') +
      fila('Capital de Trabajo', d.liquidez.capitalTrabajo, 'money');

    if (wrapRent) wrapRent.innerHTML =
      fila('Margen Bruto', d.rentabilidad.margenBruto, 'pct') +
      fila('Margen Operativo', d.rentabilidad.margenOperativo, 'pct') +
      fila('Margen Neto', d.rentabilidad.margenNeto, 'pct') +
      fila('ROA (retorno s/ activos)', d.rentabilidad.roa, 'pct') +
      fila('ROE (retorno s/ patrimonio)', d.rentabilidad.roe, 'pct');

    if (wrapDeuda) wrapDeuda.innerHTML =
      fila('Razón de Endeudamiento', d.endeudamiento.razonEndeudamiento, 'pct') +
      fila('Deuda / Patrimonio', d.endeudamiento.deudaPatrimonio, 'veces') +
      fila('Autonomía Financiera', d.endeudamiento.autonomia, 'pct');

    if (anualBody) {
      anualBody.innerHTML = d.comparativoAnual.map(a => `
        <tr>
          <td>${esc(a.anio)}</td>
          <td style="text-align:right">${fmtMoney(a.ventasNetas)}</td>
          <td style="text-align:right">${fmtMoney(a.gastosOperativos)}</td>
          <td style="text-align:right;font-weight:600">${fmtMoney(a.utilidadNeta)}</td>
        </tr>`).join('') || '<tr><td colspan="4">Sin datos anuales todavía.</td></tr>';
    }

    if (proyEl) proyEl.textContent = fmtMoney(d.flujoProyectado);

    ctbRenderIndicadoresChart(d.comparativoMensual || []);
  } catch (e) {
    if (wrapLiq) wrapLiq.innerHTML = esc(e.message);
  }
}

function ctbRenderIndicadoresChart(rows) {
  const canvas = $id('ctb-ind-chart-mensual');
  if (!canvas || !window.Chart) return;

  const fmt = (m) => {
    try { return new Date(m + '-01T12:00:00').toLocaleDateString('es-DO', { month: 'short', year: '2-digit' }); }
    catch { return m; }
  };

  if (_ctbIndChart) { _ctbIndChart.destroy(); _ctbIndChart = null; }
  _ctbIndChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: rows.map(r => fmt(r.mes)),
      datasets: [
        { label: 'Ventas Netas', data: rows.map(r => r.ventasNetas), backgroundColor: 'rgba(59,130,246,0.55)', borderRadius: 4 },
        { label: 'Utilidad Neta', data: rows.map(r => r.utilidadNeta), backgroundColor: 'rgba(16,185,129,0.55)', borderRadius: 4 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#8fa3c2', font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.dataset.label}: RD$ ` + (ctx.parsed.y || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
          },
        },
      },
      scales: {
        x: { ticks: { color: '#8fa3c2', font: { size: 10 } }, grid: { display: false } },
        y: {
          ticks: {
            color: '#8fa3c2', font: { size: 10 },
            callback: v => 'RD$ ' + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v),
          },
          grid: { color: 'rgba(71,100,148,0.12)' },
        },
      },
    },
  });
}

// ── Períodos Contables y Cierre ─────────────────────────────────────────────
async function ctbCargarCierre() {
  await Promise.all([ctbCargarPeriodos(), ctbCargarHistorialCierres()]);
}

async function ctbCargarPeriodos() {
  const wrap = $id('ctb-periodos-body');
  if (wrap) wrap.innerHTML = 'Cargando…';
  try {
    const periodos = await apiCall('GET', `/api/contabilidad/${_ctbNegocioId}/periodos`);
    if (!wrap) return;
    if (!periodos.length) {
      wrap.innerHTML = '<div style="color:#5a7099;font-size:13px">No hay períodos cerrados todavía — todo el historial está abierto.</div>';
      return;
    }
    wrap.innerHTML = periodos.map(p => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #1a2238">
        <span>${esc(p.periodo)} ${p.tipo === 'anual' ? '<span style="font-size:11px;color:#5a7099">(cierre anual)</span>' : ''}</span>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="badge badge-active">Cerrado</span>
          <button class="btn btn-xs btn-secondary" onclick="app.ctbReabrirPeriodo('${p.periodo}')">Reabrir</button>
        </div>
      </div>`).join('');
  } catch (e) {
    if (wrap) wrap.innerHTML = esc(e.message);
  }
}

async function ctbCerrarPeriodo() {
  const yyyymm = $id('ctb-periodo-input').value;
  if (!yyyymm) { toast('Selecciona un mes.', 'warning'); return; }
  try {
    await apiCall('POST', `/api/contabilidad/${_ctbNegocioId}/periodos/${yyyymm}/cerrar`);
    toast(`Período ${yyyymm} cerrado.`, 'success');
    ctbCargarPeriodos();
  } catch (e) { toast(e.message, 'error'); }
}

async function ctbReabrirPeriodo(yyyymm) {
  if (!confirm(`¿Reabrir el período ${yyyymm}? Podrán registrarse asientos nuevos en esas fechas.`)) return;
  try {
    await apiCall('POST', `/api/contabilidad/${_ctbNegocioId}/periodos/${yyyymm}/reabrir`);
    toast(`Período ${yyyymm} reabierto.`, 'success');
    ctbCargarPeriodos();
  } catch (e) { toast(e.message, 'error'); }
}

async function ctbCargarHistorialCierres() {
  const wrap = $id('ctb-cierres-body');
  if (wrap) wrap.innerHTML = 'Cargando…';
  try {
    const cierres = await apiCall('GET', `/api/contabilidad/${_ctbNegocioId}/cierres`);
    if (!wrap) return;
    wrap.innerHTML = cierres.map(c => `
      <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #1a2238">
        <span>Ejercicio ${esc(String(c.year))}</span>
        <span>Utilidad Neta: ${Number(c.utilidadNeta).toFixed(2)} · Cerrado ${esc(String(c.cerradoEn || '').slice(0, 10))} por ${esc(c.cerradoPor || '')}</span>
      </div>`).join('') || '<div style="color:#5a7099;font-size:13px">Ningún año cerrado todavía.</div>';
  } catch (e) {
    if (wrap) wrap.innerHTML = esc(e.message);
  }
}

async function ctbCerrarAnio() {
  const year = $id('ctb-anio-input').value;
  if (!year) { toast('Indica el año a cerrar.', 'warning'); return; }
  if (!confirm(`¿Cerrar el ejercicio ${year}? Esto genera un asiento de cierre que salda las cuentas de ingresos/costos/gastos y bloquea los 12 meses de ${year}. No se puede deshacer automáticamente.`)) return;
  try {
    const res = await apiCall('POST', `/api/contabilidad/${_ctbNegocioId}/cierre-anual/${year}`);
    toast(`Año ${year} cerrado — Utilidad Neta transferida: ${Number(res.utilidadNeta).toFixed(2)}.`, 'success');
    ctbCargarCierre();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Activos Fijos y Depreciaciones ──────────────────────────────────────────
let _ctbActivos = [];

function ctbValorLibros(a) {
  // Prefiere el acumulado guardado por el servidor (correcto también para
  // saldo decreciente); el cálculo con mesesDepreciados es solo respaldo para
  // activos creados antes de que este campo existiera (siempre línea recta).
  const depAcumulada = a.depreciacionAcumulada != null
    ? a.depreciacionAcumulada
    : ctbRound2ClientSide((a.mesesDepreciados || 0) * ((a.costo - a.valorResidual) / a.vidaUtilMeses));
  return ctbRound2ClientSide(a.costo - depAcumulada);
}
function ctbRound2ClientSide(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100; }

const _CTB_METODO_DEP_LABEL = { linea_recta: 'Línea Recta', saldo_decreciente: 'Saldo Decreciente' };

async function ctbCargarActivosFijos() {
  const tbody = $id('ctb-activos-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="8">Cargando…</td></tr>';
  try {
    _ctbActivos = await apiCall('GET', `/api/contabilidad/${_ctbNegocioId}/activos-fijos`);
    if (!tbody) return;
    tbody.innerHTML = _ctbActivos.map(a => `
      <tr>
        <td>${esc(a.nombre)}</td>
        <td>${esc(a.fechaCompra)}</td>
        <td style="text-align:right">${Number(a.costo).toFixed(2)}</td>
        <td style="font-size:11px;color:#8fa3c2">${esc(_CTB_METODO_DEP_LABEL[a.metodoDepreciacion] || 'Línea Recta')}</td>
        <td style="text-align:right">${a.mesesDepreciados}/${a.vidaUtilMeses}</td>
        <td style="text-align:right">${ctbValorLibros(a).toFixed(2)}</td>
        <td>${a.estado === 'activo' ? '<span class="badge badge-active">Activo</span>' : '<span class="badge badge-expired">Dado de baja</span>'}</td>
        <td>${a.estado === 'activo' ? `
          <div style="display:flex;gap:6px">
            <button class="btn btn-xs btn-secondary" onclick="app.ctbAbrirRevalorizarActivo('${a.id}')">Revalorizar</button>
            <button class="btn btn-xs btn-secondary" onclick="app.ctbAbrirBajaActivo('${a.id}')">Dar de baja</button>
          </div>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="8">Sin activos fijos registrados.</td></tr>';
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="8">${esc(e.message)}</td></tr>`;
  }
}

async function ctbGuardarActivo() {
  const nombre = $id('activo-nombre').value.trim();
  const fechaCompra = $id('activo-fecha').value;
  const costo = Number($id('activo-costo').value);
  const valorResidual = Number($id('activo-residual').value) || 0;
  const vidaUtilMeses = Number($id('activo-vida').value);
  const metodoDepreciacion = $id('activo-metodo').value;
  if (!nombre || !fechaCompra || !(costo > 0) || !(vidaUtilMeses > 0)) {
    toast('Completa nombre, fecha, costo y vida útil.', 'warning'); return;
  }
  try {
    await apiCall('POST', `/api/contabilidad/${_ctbNegocioId}/activos-fijos`, { nombre, fechaCompra, costo, valorResidual, vidaUtilMeses, metodoDepreciacion });
    $id('activo-nombre').value = ''; $id('activo-costo').value = ''; $id('activo-residual').value = ''; $id('activo-vida').value = '';
    $id('activo-metodo').value = 'linea_recta';
    toast('Activo registrado.', 'success');
    ctbCargarActivosFijos();
  } catch (e) { toast(e.message, 'error'); }
}

async function ctbDepreciar() {
  const hasta = $id('ctb-depreciar-hasta').value;
  try {
    const res = await apiCall('POST', `/api/contabilidad/${_ctbNegocioId}/activos-fijos/depreciar`, hasta ? { hasta } : {});
    toast(res.asientoCreado ? `Depreciación generada: ${Number(res.totalDepreciacion).toFixed(2)} (${res.activosActualizados} activo(s)).` : res.mensaje, res.asientoCreado ? 'success' : 'info');
    ctbCargarActivosFijos();
  } catch (e) { toast(e.message, 'error'); }
}

let _ctbActivoBajaId = null;
function ctbAbrirBajaActivo(id) {
  _ctbActivoBajaId = id;
  $id('baja-fecha').value = new Date().toISOString().slice(0, 10);
  $id('baja-valor-venta').value = '';
  $id('baja-motivo').value = '';
  $id('modal-baja-activo').classList.remove('hidden');
}
function cerrarModalBajaActivo() { $id('modal-baja-activo').classList.add('hidden'); }

async function ctbGuardarBajaActivo() {
  const fecha = $id('baja-fecha').value;
  const valorVenta = Number($id('baja-valor-venta').value) || 0;
  const motivo = $id('baja-motivo').value.trim();
  if (!fecha) { toast('Fecha de baja requerida.', 'warning'); return; }
  try {
    const res = await apiCall('POST', `/api/contabilidad/${_ctbNegocioId}/activos-fijos/${_ctbActivoBajaId}/baja`, { fecha, valorVenta, motivo });
    cerrarModalBajaActivo();
    toast(`Activo dado de baja — ${res.resultado >= 0 ? 'ganancia' : 'pérdida'} de ${Math.abs(res.resultado).toFixed(2)}.`, 'success');
    ctbCargarActivosFijos();
  } catch (e) { toast(e.message, 'error'); }
}

let _ctbActivoRevalId = null;
function ctbAbrirRevalorizarActivo(id) {
  const activo = _ctbActivos.find(a => a.id === id);
  if (!activo) return;
  _ctbActivoRevalId = id;
  setText('reval-valor-actual', fmtMoney(ctbValorLibros(activo)));
  $id('reval-fecha').value = new Date().toISOString().slice(0, 10);
  $id('reval-valor-nuevo').value = '';
  $id('reval-motivo').value = '';
  $id('modal-revalorizar-activo').classList.remove('hidden');
}
function cerrarModalRevalorizarActivo() { $id('modal-revalorizar-activo').classList.add('hidden'); }

async function ctbGuardarRevalorizacion() {
  const fecha = $id('reval-fecha').value;
  const valorNuevo = Number($id('reval-valor-nuevo').value);
  const motivo = $id('reval-motivo').value.trim();
  if (!fecha || !(valorNuevo > 0)) { toast('Fecha y nuevo valor son requeridos.', 'warning'); return; }
  try {
    const res = await apiCall('POST', `/api/contabilidad/${_ctbNegocioId}/activos-fijos/${_ctbActivoRevalId}/revalorizar`, { fecha, valorNuevo, motivo });
    cerrarModalRevalorizarActivo();
    toast(`Activo revalorizado — ${res.ajuste >= 0 ? 'superávit' : 'deterioro'} de ${fmtMoney(Math.abs(res.ajuste))}.`, 'success');
    ctbCargarActivosFijos();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Centros de Costo ─────────────────────────────────────────────────────
let _ctbCentrosCosto = [];

async function ctbCargarCentrosCosto() {
  try {
    _ctbCentrosCosto = await apiCall('GET', `/api/contabilidad/${_ctbNegocioId}/centros-costo`);
    const tbody = $id('ctb-centros-tbody');
    if (tbody) {
      tbody.innerHTML = _ctbCentrosCosto.map(c => `<tr><td>${esc(c.nombre)}</td><td>${esc(c.tipo)}</td></tr>`).join('') || '<tr><td colspan="2">Sin centros de costo registrados.</td></tr>';
    }
    await ctbCargarComparativoCentros();
  } catch (e) { toast(e.message, 'error'); }
}

async function ctbGuardarCentroCosto() {
  const nombre = $id('centro-nombre').value.trim();
  const tipo = $id('centro-tipo').value;
  if (!nombre) { toast('Indica un nombre.', 'warning'); return; }
  try {
    await apiCall('POST', `/api/contabilidad/${_ctbNegocioId}/centros-costo`, { nombre, tipo });
    $id('centro-nombre').value = '';
    toast('Centro de costo agregado.', 'success');
    ctbCargarCentrosCosto();
  } catch (e) { toast(e.message, 'error'); }
}

async function ctbCargarComparativoCentros() {
  const tbody = $id('ctb-comparativo-centros-tbody');
  if (!tbody) return;
  try {
    const rows = await apiCall('GET', `/api/contabilidad/${_ctbNegocioId}/centros-costo/comparativo`);
    tbody.innerHTML = rows.map(r => `
      <tr><td>${esc(r.centro)}</td><td style="text-align:right">${Number(r.debe).toFixed(2)}</td><td style="text-align:right">${Number(r.haber).toFixed(2)}</td></tr>
    `).join('') || '<tr><td colspan="3">Sin movimientos con centro de costo asignado.</td></tr>';
  } catch (e) { tbody.innerHTML = esc(e.message); }
}

// ── Presupuesto ──────────────────────────────────────────────────────────
async function ctbCargarPresupuesto() {
  const year = $id('ctb-presupuesto-anio').value || new Date().getFullYear().toString();
  $id('ctb-presupuesto-anio').value = year;
  const wrap = $id('ctb-presupuesto-form');
  if (wrap) wrap.innerHTML = 'Cargando…';
  try {
    const [pres, comparativo] = await Promise.all([
      apiCall('GET', `/api/contabilidad/${_ctbNegocioId}/presupuesto/${year}`),
      apiCall('GET', `/api/contabilidad/${_ctbNegocioId}/presupuesto/${year}/comparativo`),
    ]);
    const cuentasEditable = _ctbCuentas.filter(c => ['ingreso', 'costo', 'gasto'].includes(c.accountType) && c.parentCode);
    if (wrap) {
      wrap.innerHTML = cuentasEditable.map(c => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0">
          <span style="font-size:13px">${esc(c.code)} — ${esc(c.name)}</span>
          <input type="number" class="form-input" style="width:140px" id="pres-${c.code}" value="${pres.cuentas?.[c.code] ?? ''}" placeholder="0.00">
        </div>`).join('');
    }
    const tbody = $id('ctb-comparativo-presupuesto-tbody');
    if (tbody) {
      tbody.innerHTML = comparativo.rows.map(r => `
        <tr>
          <td>${esc(r.code)} — ${esc(r.name)}</td>
          <td style="text-align:right">${r.presupuestado.toFixed(2)}</td>
          <td style="text-align:right">${r.real.toFixed(2)}</td>
          <td style="text-align:right;color:${r.variacion > 0 ? '#ef4444' : '#22c55e'}">${r.variacion.toFixed(2)}</td>
        </tr>`).join('') || '<tr><td colspan="4">Sin presupuesto definido para este año.</td></tr>';
    }
  } catch (e) {
    if (wrap) wrap.innerHTML = esc(e.message);
  }
}

async function ctbGuardarPresupuesto() {
  const year = $id('ctb-presupuesto-anio').value;
  const cuentasEditable = _ctbCuentas.filter(c => ['ingreso', 'costo', 'gasto'].includes(c.accountType) && c.parentCode);
  const cuentas = {};
  for (const c of cuentasEditable) {
    const val = $id(`pres-${c.code}`)?.value;
    if (val) cuentas[c.code] = Number(val);
  }
  try {
    await apiCall('PUT', `/api/contabilidad/${_ctbNegocioId}/presupuesto/${year}`, { cuentas });
    toast('Presupuesto guardado.', 'success');
    ctbCargarPresupuesto();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Auditoría ────────────────────────────────────────────────────────────
async function ctbCargarAuditoria() {
  const tbody = $id('ctb-auditoria-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="3">Cargando…</td></tr>';
  try {
    const log = await apiCall('GET', `/api/contabilidad/${_ctbNegocioId}/auditoria`);
    if (tbody) {
      tbody.innerHTML = log.map(l => `
        <tr><td>${esc(String(l.fecha || '').slice(0, 19).replace('T', ' '))}</td><td>${esc(l.usuario)}</td><td>${esc(l.accion)} — ${esc(l.detalle || '')}</td></tr>
      `).join('') || '<tr><td colspan="3">Sin actividad registrada todavía.</td></tr>';
    }
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="3">${esc(e.message)}</td></tr>`;
  }
}

// ── Configuración Contable ───────────────────────────────────────────────
async function ctbCargarConfiguracion() {
  try {
    const cfg = await apiCall('GET', `/api/contabilidad/${_ctbNegocioId}/configuracion`);
    $id('ctb-config-inicio-anio').value = cfg.inicioAnioFiscal || 1;
  } catch (e) { toast(e.message, 'error'); }
}

async function ctbGuardarConfiguracion() {
  try {
    await apiCall('PUT', `/api/contabilidad/${_ctbNegocioId}/configuracion`, { inicioAnioFiscal: $id('ctb-config-inicio-anio').value });
    toast('Configuración guardada.', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

// ── Asiento manual (ajustes sin equivalente en el POS) ─────────────────────
let _ctbLineas = [];

function abrirModalAsiento() {
  if (!_ctbNegocioId) { toast('Selecciona un negocio primero.', 'warning'); return; }
  _ctbLineas = [{ cuenta: '', debe: '', haber: '', centroCosto: '' }, { cuenta: '', debe: '', haber: '', centroCosto: '' }];
  $id('asiento-fecha').value = new Date().toISOString().slice(0, 10);
  $id('asiento-descripcion').value = '';
  ctbRenderLineasAsiento();
  $id('modal-asiento').classList.remove('hidden');
}

function cerrarModalAsiento() {
  $id('modal-asiento').classList.add('hidden');
}

function ctbRenderLineasAsiento() {
  const wrap = $id('asiento-lineas');
  if (!wrap) return;
  wrap.innerHTML = _ctbLineas.map((l, i) => `
    <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr auto;gap:6px;margin-bottom:6px">
      <select class="form-select" onchange="app.ctbLineaAsiento(${i},'cuenta',this.value)">
        <option value="">-- Cuenta --</option>${ctbCuentaOptions()}
      </select>
      <input type="number" class="form-input" placeholder="Debe" value="${l.debe}" oninput="app.ctbLineaAsiento(${i},'debe',this.value)">
      <input type="number" class="form-input" placeholder="Haber" value="${l.haber}" oninput="app.ctbLineaAsiento(${i},'haber',this.value)">
      <input type="text" class="form-input" placeholder="Centro de costo (opcional)" value="${esc(l.centroCosto || '')}" oninput="app.ctbLineaAsiento(${i},'centroCosto',this.value)">
      <button class="btn btn-secondary" onclick="app.ctbQuitarLineaAsiento(${i})">✕</button>
    </div>`).join('');
}

function ctbLineaAsiento(i, campo, valor) {
  _ctbLineas[i][campo] = valor;
  if (campo === 'debe' && Number(valor) > 0) _ctbLineas[i].haber = '';
  if (campo === 'haber' && Number(valor) > 0) _ctbLineas[i].debe = '';
}
function ctbAgregarLineaAsiento() { _ctbLineas.push({ cuenta: '', debe: '', haber: '', centroCosto: '' }); ctbRenderLineasAsiento(); }
function ctbQuitarLineaAsiento(i) {
  if (_ctbLineas.length <= 2) { toast('Un asiento necesita al menos dos líneas.', 'warning'); return; }
  _ctbLineas.splice(i, 1); ctbRenderLineasAsiento();
}

async function guardarAsiento() {
  const fecha = $id('asiento-fecha').value;
  const descripcion = $id('asiento-descripcion').value.trim();
  const lineas = _ctbLineas.filter(l => l.cuenta && (Number(l.debe) > 0 || Number(l.haber) > 0))
    .map(l => ({ cuenta: l.cuenta, debe: Number(l.debe) || 0, haber: Number(l.haber) || 0, centroCosto: l.centroCosto || null }));
  if (!fecha || !descripcion || lineas.length < 2) {
    toast('Completa fecha, descripción y al menos dos líneas.', 'warning'); return;
  }
  try {
    await apiCall('POST', `/api/contabilidad/${_ctbNegocioId}/asientos`, { fecha, descripcion, lineas });
    cerrarModalAsiento();
    toast('Asiento guardado.', 'success');
    ctbSwitchVista(_ctbVista);
  } catch (e) { toast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════
// ALERTAS
// ══════════════════════════════════════════════════════════════════════

let _alertasPollTimer = null;

async function loadAlertas() {
  const sub = $id('alertas-sub');
  if (sub) sub.textContent = 'Actualizando alertas…';
  try {
    await refreshToken();
    const data = await apiCall('GET', '/api/alertas');
    _renderAlertas(data);
    if (sub) sub.textContent = `${data.total} alerta(s) · Actualizado ${new Date().toLocaleTimeString('es-DO')}`;
  } catch (e) {
    toast('Error cargando alertas: ' + e.message, 'error');
    if (sub) sub.textContent = 'Error al cargar alertas.';
  }
}

function _renderAlertas(data) {
  const empty = $id('alertas-empty');
  const body  = $id('alertas-body');

  if (!data.alertas.length) {
    if (empty) empty.style.display = '';
    if (body)  body.style.display  = 'none';
    _actualizarBadgeAlertas(0);
    return;
  }

  if (empty) empty.style.display = 'none';
  if (body)  body.style.display  = '';

  const nivelIcon = { critico: '🔴', urgente: '🟠', advertencia: '🟡', info: '🔵' };
  const tipoIcon  = {
    licencia_vencida:   '📛', licencia_proxima: '⏰',
    sin_sync:           '🔄', solicitud_pendiente: '📋',
  };

  ['critico','urgente','advertencia','info'].forEach(nivel => {
    const sec  = $id(`alertas-${nivel}-sec`);
    const list = $id(`alertas-${nivel}-list`);
    const items = data.alertas.filter(a => a.nivel === nivel);
    if (!items.length) {
      if (sec) sec.style.display = 'none';
      return;
    }
    if (sec) sec.style.display = '';
    if (list) {
      list.innerHTML = items.map(a => `
        <div class="alert-item ${nivel}">
          <div class="alert-icon">${tipoIcon[a.tipo] || nivelIcon[nivel]}</div>
          <div class="alert-content">
            <div class="alert-bname">${esc(a.businessName || '—')}</div>
            <div class="alert-msg">${esc(a.msg)}</div>
          </div>
          ${a.businessId ? `<button class="btn btn-xs btn-secondary" onclick="app.verCliente('${a.businessId}')">Ver</button>` : ''}
        </div>`).join('');
    }
  });

  _actualizarBadgeAlertas(data.critico + data.urgente);
}

function _actualizarBadgeAlertas(count) {
  const badge = $id('nav-badge-alertas');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
    badge.style.background = '#ef4444';
  } else {
    badge.classList.add('hidden');
  }
}

// Auto-polling de alertas cada 3 minutos
function _startAlertasPoller() {
  if (_alertasPollTimer) return;
  _alertasPollTimer = setInterval(async () => {
    if (!_token) return;
    try {
      await refreshToken();
      const data = await apiCall('GET', '/api/alertas');
      _actualizarBadgeAlertas(data.critico + data.urgente);
      // Si el módulo está visible, actualizar tabla también
      if ($id('mod-alertas')?.classList.contains('active')) _renderAlertas(data);
    } catch (_) {}
  }, 3 * 60 * 1000);
}

// Auto-refresh solicitudes badge cada 60s
let _solPollTimer = null;
function _startSolicitudesPoller() {
  if (_solPollTimer) return;
  _solPollTimer = setInterval(async () => {
    if (!_token) return;
    try {
      await refreshToken();
      const list = await apiCall('GET', '/api/solicitudes?status=pendiente');
      const cnt = list.length;
      const badge = $id('nav-badge-sol');
      if (badge) {
        if (cnt > 0) { badge.textContent = cnt; badge.classList.remove('hidden'); }
        else           badge.classList.add('hidden');
      }
    } catch (_) {}
  }, 60 * 1000);
}

// ══════════════════════════════════════════════════════════════════════
// EXPORT — accesible desde HTML (onclick)
// ══════════════════════════════════════════════════════════════════════

window.app = {
  // auth
  doLogin, doLoginGoogle, showForgot, showLogin, sendReset, togglePw, logout,
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
  loadPerfil, savePerfil, handleCfgLogoUpload, quitarCfgLogo,
  // actualizaciones
  loadActualizaciones, verificarActualizacion, instalarActualizacion, instalarActualizacionGlobal, updSwitchTab,
  // reportes
  loadReportes, selNegocioReporte, cambiarTabReporte, cargarDatosReporte,
  aplicarFiltros, limpiarFiltros, exportarCSV, exportarExcel, imprimirReporte, actualizarReporte,
  abrirRepDetalle, cerrarRepDetalle, imprimirTabReporte, imprimirReporteMensual,
  // productos pendientes (agregados desde este Portal)
  abrirAgregarProductoModal, cerrarAgregarProductoModal, guardarProductoPendiente, handleAgregarProductoImagen,
  // secuencias NCF pendientes (registradas desde este Portal)
  abrirAgregarNcfModal, cerrarAgregarNcfModal, guardarNcfPendiente, handleAgregarNcfAdjunto, cancelarNcfPendiente,
  // secuencias NCF ya aplicadas (editar/suspender/eliminar remoto)
  abrirEditarNcfModal, cerrarEditarNcfModal, guardarEdicionNcf, abrirSuspenderNcfModal, eliminarNcfAplicada,
  confirmarMotivoNcf, cancelarMotivoNcf,
  // facturación — mis secuencias NCF propias (para facturar sus servicios)
  abrirMisSecuenciasNcf, cerrarMisSecuenciasNcf, abrirRegistrarMiNcfModal, cerrarRegistrarMiNcfModal,
  handleMiNcfAdjunto, guardarMiNcf, suspenderMiNcf, activarMiNcf, eliminarMiNcf,
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
  // colaboradores
  loadColaboradores, filtrarColaboradores,
  abrirModalColab, cerrarModalColab, guardarColab, toggleTipoColab, cambiarPwColab, eliminarColab,
  verColabDetalle, quitarCliente,
  abrirModalAsignar, cerrarModalAsignar, filtrarNegociosAsignar, asignarNegocio,
  // análisis global
  loadAnalisisGlobal,
  // centro fiscal
  loadCentroFiscal, filtrarObligaciones, filtrarTareas,
  abrirModalTarea, cerrarModalTarea, guardarTarea,
  completarTarea, reabrirTarea, eliminarTarea,
  // centro fiscal — generador 606/607/608
  cargarArchivoFiscal, descargarDGII, descargarDGIIExcel,
  // contabilidad — visor del Libro Mayor manual
  // contabilidad — Sistema Contable en vivo
  loadContabilidad, selNegocioContabilidad, ctbGenerarAsientos, ctbSwitchVista, ctbCargarMayor,
  abrirModalAsiento, cerrarModalAsiento, ctbLineaAsiento, ctbAgregarLineaAsiento, ctbQuitarLineaAsiento, guardarAsiento,
  ctbCerrarPeriodo, ctbReabrirPeriodo, ctbCerrarAnio,
  ctbGuardarActivo, ctbDepreciar, ctbAbrirBajaActivo, cerrarModalBajaActivo, ctbGuardarBajaActivo,
  ctbAbrirRevalorizarActivo, cerrarModalRevalorizarActivo, ctbGuardarRevalorizacion,
  ctbGuardarCentroCosto, ctbCargarPresupuesto, ctbGuardarPresupuesto, ctbGuardarConfiguracion,
  ctbCopiarAsiento, ctbExportarER, ctbExportarBG, ctbExportarFE, ctbExportarIndicadores,
  // alertas
  loadAlertas,
  // estado
  get currentClienteId() { return _currentClienteId; },
};

// ── Iniciar app ────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', initApp);
