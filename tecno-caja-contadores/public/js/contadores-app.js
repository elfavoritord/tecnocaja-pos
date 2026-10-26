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
  if (!res.ok) {
    const err = new Error(data.error || `Error ${res.status}`);
    err.status = res.status;   // p. ej. 409 = cliente con RNC repetido
    throw err;
  }
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

// ── Validación en línea (diseño 2026): el mensaje va en rojo debajo del
// campo, no en un aviso emergente. El campo debe estar dentro de .fm-campo.
function _fmError(campoId, msg) {
  const el = $id(campoId);
  const wrap = el?.closest('.fm-campo');
  if (!wrap) { if (msg) toast(msg, 'error'); return; }
  let box = wrap.querySelector(':scope > .fm-error');
  if (!box) { box = document.createElement('div'); box.className = 'fm-error'; wrap.appendChild(box); }
  box.textContent = msg || '';
  wrap.classList.toggle('is-invalido', Boolean(msg));
}
function _fmLimpiar(rootId) {
  $id(rootId)?.querySelectorAll('.fm-campo').forEach((w) => {
    w.classList.remove('is-invalido');
    const box = w.querySelector(':scope > .fm-error');
    if (box) box.textContent = '';
  });
}
// Al escribir en un campo con error, el error se quita.
document.addEventListener('input', (e) => {
  const wrap = e.target.closest?.('.fm-campo.is-invalido');
  if (!wrap) return;
  wrap.classList.remove('is-invalido');
  const box = wrap.querySelector(':scope > .fm-error');
  if (box) box.textContent = '';
});

// ── Date formatting ────────────────────────────────────────────────────────
// Fecha de HOY en la hora de la PC ("2026-10-19"). No sacarla de
// toISOString(): esa es la fecha en UTC, y en RD
// (UTC-4) después de las 8:00 p. m. ya da la de mañana — una factura hecha de
// noche quedaba con fecha de mañana y no salía en "Este mes" ni en "Hoy".
function hoyLocal(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDate(val) {
  if (!val) return '—';
  try {
    // "2026-10-19" (fecha sin hora) es ese día aquí: new Date('2026-10-19') lo
    // toma como medianoche UTC y en RD se mostraba el día anterior.
    const soloFecha = typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val);
    const d = soloFecha
      ? new Date(Number(val.slice(0, 4)), Number(val.slice(5, 7)) - 1, Number(val.slice(8, 10)))
      : val?.toDate ? val.toDate() : new Date(val._seconds ? val._seconds * 1000 : val);
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

// Empresas de servicios (modo administrativo del POS, sin punto de venta).
const SRV_VERTICALES = {
  srv_consultoria: 'Consultoría', srv_tecnologia: 'Empresa de Tecnología', srv_publicidad: 'Agencia de Publicidad',
  srv_arquitectura: 'Arquitectura e Ingeniería', srv_limpieza: 'Empresa de Limpieza', srv_seguridad: 'Empresa de Seguridad',
  srv_mantenimiento: 'Empresa de Mantenimiento', srv_viajes: 'Agencia de Viajes',
};
function esServicios(c) {
  return Boolean(c && (c.serviceCompany || String(c.vertical || c.tipo_negocio || '').startsWith('srv_')));
}
function verticalLabel(c) {
  const v = (c && (c.vertical || c.tipo_negocio)) || '';
  return SRV_VERTICALES[v] || (String(v).startsWith('srv_') ? 'Empresa de Servicios' : v || '—');
}
function verticalBadge(c) {
  if (!esServicios(c)) return '';
  // Colores del tema (día y noche), no fijos: en modo noche el azul oscuro no se leía.
  return `<span class="pill pill-info">🏢 ${esc(verticalLabel(c))}</span>`;
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
// Barra superior: grupo del menú (miga) y título. Los detalles marcan en el
// menú a su módulo padre (`nav`).
const MODULOS_TOPBAR = {
  dashboard:         { grupo: 'Principal',          titulo: 'Dashboard' },
  negocios:          { grupo: 'Principal',          titulo: 'Negocios asociados' },
  'cliente-detalle': { grupo: 'Negocios asociados', titulo: 'Detalle del negocio', nav: 'negocios' },
  licencias:         { grupo: 'Cartera',            titulo: 'Licencias' },
  reportes:          { grupo: 'Cartera',            titulo: 'Reportes' },
  'analisis-global': { grupo: 'Cartera',            titulo: 'Análisis global' },
  alertas:           { grupo: 'Gestión',            titulo: 'Alertas' },
  'centro-fiscal':   { grupo: 'Gestión',            titulo: 'Centro fiscal' },
  contabilidad:      { grupo: 'Gestión',            titulo: 'Contabilidad' },
  solicitudes:       { grupo: 'Gestión',            titulo: 'Solicitudes' },
  facturacion:       { grupo: 'Mi despacho',        titulo: 'Facturación' },
  'fac-detalle':     { grupo: 'Facturación',        titulo: 'Factura', nav: 'facturacion' },
  cotizaciones:      { grupo: 'Mi despacho',        titulo: 'Cotizaciones' },
  colaboradores:     { grupo: 'Mi despacho',        titulo: 'Colaboradores' },
  'colab-detalle':   { grupo: 'Colaboradores',      titulo: 'Colaborador', nav: 'colaboradores' },
  'mis-clientes':    { grupo: 'Facturación',        titulo: 'Mis clientes', nav: 'facturacion' },
  asistente:         { grupo: 'Mi despacho',        titulo: 'Asistente' },
  configuracion:     { grupo: 'Cuenta',             titulo: 'Configuración' },
  actualizaciones:   { grupo: 'Cuenta',             titulo: 'Actualizaciones' },
  ayuda:             { grupo: 'Cuenta',             titulo: 'Centro de ayuda' },
};

function _pintarTopbar(mod) {
  const info = MODULOS_TOPBAR[mod] || { grupo: '', titulo: '' };
  setText('topbar-migas', info.grupo);
  setText('topbar-titulo', info.titulo);
  const navMod = info.nav || mod;
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.mod === navMod));
  $id('main-content')?.scrollTo(0, 0);
}

function goto(mod) {
  document.querySelectorAll('.module').forEach(el => el.classList.remove('active'));

  const modEl = $id(`mod-${mod}`);
  if (modEl) modEl.classList.add('active');
  _pintarTopbar(mod);

  // Load data for the module
  if (mod === 'dashboard')        loadDashboard();
  if (mod === 'negocios')         loadClientes();
  if (mod === 'licencias')        loadLicencias();
  if (mod === 'solicitudes')      loadSolicitudes();
  if (mod === 'configuracion')    { cfgIr(); loadPerfil(); }
  if (mod === 'actualizaciones')  loadActualizaciones();
  if (mod === 'reportes')         loadReportes();
  if (mod === 'facturacion')      loadFacturacion();
  if (mod === 'cotizaciones')     loadCotizaciones();
  if (mod === 'mis-clientes')     loadMisClientes();
  if (mod === 'asistente')        loadAsistente();
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
  _initBuscadorGlobal();
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
          if (profile?.needsRegistration) {
            // Cuenta de Google sin perfil: abrir el wizard de auto-registro
            // en vez de entrar. La sesión de Firebase se mantiene viva.
            showRegistro(profile);
            return;
          }
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
  // Volver siempre a la vista de login (no dejar el wizard/olvidé colgados)
  hide('view-registro');
  hide('view-forgot');
  show('view-login');

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
// "Emilio Manaurys Cabrera" → "EM" (sin contar "de", "la", "y"…).
function _iniciales(nombre) {
  const partes = String(nombre || '').trim().split(/\s+/)
    .filter((p) => p && !/^(de|del|la|las|los|y|e|srl|sas|eirl)$/i.test(p.replace(/[.,]/g, '')));
  const letras = partes.slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join('');
  return letras || '?';
}

function _setSidebarAvatar(nombre, logoUrl) {
  const avatarEl = $id('user-avatar-letter');
  if (avatarEl) {
    if (logoUrl) {
      avatarEl.innerHTML = `<img src="${logoUrl}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    } else {
      avatarEl.textContent = _iniciales(nombre);
    }
  }

  // Arriba va la marca: el logo y nombre de la firma si subió logo; si no, Tecno Caja.
  const brandIcon = $id('sidebar-brand-icon');
  if (brandIcon) {
    brandIcon.innerHTML = logoUrl
      ? `<img src="${logoUrl}" style="width:100%;height:100%;border-radius:8px;object-fit:cover">`
      : 'TC';
    brandIcon.classList.toggle('con-logo', Boolean(logoUrl));
  }
  const brandName = $id('sidebar-brand-name');
  if (brandName) brandName.textContent = (logoUrl && nombre) || 'Tecno Caja';

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
    ? ['colaboradores', 'licencias', 'solicitudes', 'facturacion', 'mis-clientes']
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

  // Dashboard: licencias y honorarios son de módulos que el dependiente no ve.
  document.querySelectorAll('[data-solo-principal]').forEach((el) => {
    el.style.display = esDependiente ? 'none' : '';
  });

  // Badge de rol en sidebar
  const roleEl = $id('sidebar-email');
  if (roleEl) {
    const roleLabel = esDependiente ? 'Colaborador dependiente'
      : esCompleto    ? 'Colaborador completo'
      : 'Contador principal';
    roleEl.textContent = roleLabel;
  }
}

function _esDependiente() {
  return Boolean(_perfil?.isColaborador && _perfil?.tipo === 'dependiente');
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

// ── Wizard de auto-registro de contador (cuenta de Google sin perfil) ───────
function showRegistro(info) {
  hide('screen-app');
  show('screen-login');
  hide('view-login');
  hide('view-forgot');
  show('view-registro');
  $id('login-error-banner')?.classList.add('hidden');
  setText('reg-dgii-info', '');
  const firmaEl = $id('reg-firma');
  if (firmaEl) delete firmaEl.dataset.fromDgii;

  const email = info?.email || _fbAuth?.currentUser?.email || '';
  const dn    = info?.displayName || _fbAuth?.currentUser?.displayName || '';
  setText('reg-email-note', email ? `Cuenta: ${email}` : '');
  const resp = $id('reg-responsable');
  if (resp && !resp.value) resp.value = dn;
}

function _regErr(msg) {
  const el = $id('reg-err');
  if (el) { el.textContent = msg || 'No se pudo completar el registro.'; el.classList.remove('hidden'); }
}

// Consulta el RNC en la DGII y autollena el nombre de la firma.
async function buscarRncRegistro() {
  const rncEl  = $id('reg-rnc');
  const infoEl = $id('reg-dgii-info');
  const raw = (rncEl?.value || '').replace(/\D/g, '');
  if (raw.length < 9) { if (infoEl) { infoEl.style.color = 'var(--text-muted)'; infoEl.textContent = ''; } return; }
  if (infoEl) { infoEl.style.color = 'var(--text-muted)'; infoEl.textContent = 'Consultando la DGII…'; }
  try {
    const d = await apiCall('GET', `/api/rnc/consulta?id=${encodeURIComponent(raw)}`);
    const firmaEl = $id('reg-firma');
    if (d && d.found) {
      if (firmaEl && (!firmaEl.value.trim() || firmaEl.dataset.fromDgii === '1')) {
        firmaEl.value = d.nombre || d.nombreComercial || '';
        firmaEl.dataset.fromDgii = '1';
      }
      if (infoEl) {
        infoEl.style.color = 'var(--green)';
        infoEl.textContent = `✓ DGII: ${d.nombre || d.nombreComercial}${d.estado ? ' · ' + d.estado : ''}`;
      }
    } else if (infoEl) {
      infoEl.style.color = 'var(--orange)';
      infoEl.textContent = 'Ese RNC no aparece en la DGII. Puedes escribir el nombre de la firma a mano.';
    }
  } catch (e) {
    if (infoEl) { infoEl.style.color = 'var(--orange)'; infoEl.textContent = 'No se pudo consultar la DGII ahora — escribe el nombre a mano.'; }
  }
}

async function submitRegistroContador() {
  const errEl = $id('reg-err');
  if (errEl) errEl.classList.add('hidden');

  const body = {
    idToken:      _token,
    nombre_firma: $id('reg-firma')?.value.trim() || '',
    responsable:  $id('reg-responsable')?.value.trim() || '',
    rnc:          $id('reg-rnc')?.value.trim() || '',
    telefono:     $id('reg-telefono')?.value.trim() || '',
    direccion:    $id('reg-direccion')?.value.trim() || '',
  };
  if (!body.rnc || !body.responsable) {
    return _regErr('Escribe el RNC y el responsable de la firma.');
  }

  const btn = $id('btn-reg');
  if (btn) { btn.disabled = true; btn.textContent = 'Creando…'; }
  try {
    const data = await apiCall('POST', '/api/auth/registro-contador', body);
    _perfil = data;
    // Restaurar la vista de login para la próxima vez y entrar al portal.
    hide('view-registro');
    show('view-login');
    showApp(data);
  } catch (e) {
    _regErr(e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Crear mi cuenta de contador'; }
  }
}

async function cancelRegistro() {
  hide('view-registro');
  show('view-login');
  await _fbAuth?.signOut();
}

async function logout() {
  if (!confirm('¿Cerrar sesión?')) return;
  await _fbAuth?.signOut();
  _token = null; _perfil = null; _allClientes = [];
  _buscadorCache.facturas = null; // el buscador no muestra facturas de otra sesión
}

// ══════════════════════════════════════════════════════════════════════
// DASHBOARD (diseño 2026)
// Todo sale de lo que ya existía: /api/dashboard, /api/clientes (posStats que
// publica cada POS), /api/analisis-global, /api/alertas, el calendario del
// Centro fiscal y las facturas de honorarios. Si un dato no existe, "—".
// ══════════════════════════════════════════════════════════════════════

const _MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const _MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const _PLANES = { basico: 'Básico', basic: 'Básico', pro: 'Pro', plus: 'Plus', enterprise: 'Enterprise' };

// Fecha de Firestore / ISO / "AAAA-MM-DD" (este último es ese día aquí, no UTC).
function _aFecha(val) {
  if (!val) return null;
  try {
    if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val)) {
      return new Date(Number(val.slice(0, 4)), Number(val.slice(5, 7)) - 1, Number(val.slice(8, 10)));
    }
    const d = val?.toDate ? val.toDate() : new Date(val._seconds ? val._seconds * 1000 : val);
    return isNaN(d) ? null : d;
  } catch { return null; }
}

// Días de calendario de hoy a esa fecha (negativo = ya pasó).
function _diasHasta(val) {
  const d = _aFecha(val);
  if (!d) return null;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const dia = new Date(d); dia.setHours(0, 0, 0, 0);
  return Math.round((dia - hoy) / 86400000);
}

function _plural(n, uno, varios) { return `${n} ${n === 1 ? uno : varios}`; }
function _venceTexto(dias) {
  return dias === 0 ? 'vence hoy' : dias === 1 ? 'vence mañana' : `vence en ${dias} días`;
}

function _planTexto(c) {
  const code = String(c.planCode || c.plan_code || '').trim();
  if (!code) return '';
  return `Plan ${_PLANES[code.toLowerCase()] || code.charAt(0).toUpperCase() + code.slice(1)}`;
}

// ── Calendario DGII (obligaciones del Centro fiscal, agrupadas por fecha) ──
// El IT-1 que vence el 20 de un mes es el ITBIS del mes anterior.
function _oblEtiqueta(o) {
  if (o.form === 'IT-1') return `ITBIS de ${_MESES[(Number(o.mes) + 10) % 12]}`;
  const desc = String(o.desc || '');
  return desc.startsWith(o.form) ? desc.slice(o.form.length).trim() || o.form : desc || o.form;
}

function _oblProximas(lista, hastaDias) {
  const grupos = new Map();
  (lista || []).forEach((o) => {
    const dias = _diasHasta(o.fecha);
    if (dias === null || dias < 0 || dias > hastaDias) return;
    if (!grupos.has(o.fecha)) grupos.set(o.fecha, { fecha: o.fecha, dias, items: [] });
    grupos.get(o.fecha).items.push(o);
  });
  return [...grupos.values()].sort((a, b) => a.fecha.localeCompare(b.fecha)).map((g) => {
    const forms = [...new Set(g.items.map((o) => o.form))];
    const etiquetas = [...new Set(g.items.map(_oblEtiqueta))];
    const dow = _aFecha(g.fecha).getDay();
    return {
      ...g,
      titulo: forms.length === 1 ? `${forms[0]} · ${etiquetas[0]}` : forms.join(' · '),
      etiquetas: etiquetas.join(' / '),
      multiple: forms.length > 1,
      finDeSemana: dow === 0 ? 'Cae domingo' : dow === 6 ? 'Cae sábado' : '',
    };
  });
}

// ── Salud de cada negocio (licencia + última sincronización) ──
function _saludNegocio(c) {
  const status = String(c.status || 'trial').toLowerCase();
  const dias = typeof c.diasRestantes === 'number' ? c.diasRestantes : null;
  const sync = _aFecha(c.syncedAt);
  const diasSync = sync ? Math.max(0, -_diasHasta(sync)) : null;
  const motivos = [];
  let nivel = 'ok';
  const subir = (n) => { if (n === 'bad' || (n === 'warn' && nivel === 'ok')) nivel = n; };

  if (status === 'expired' || status === 'cancelled' || (dias !== null && dias < 0)) { subir('bad'); motivos.push('Licencia vencida'); }
  else if (status === 'suspended') { subir('bad'); motivos.push('Licencia suspendida'); }
  else if (dias !== null && dias <= 15) { subir('warn'); motivos.push(`Licencia ${_venceTexto(dias)}`); }

  if (diasSync === null) { subir('bad'); motivos.push('Nunca ha sincronizado'); }
  else if (diasSync > 7) { subir('bad'); motivos.push(`Sin datos hace ${diasSync} días`); }
  else if (diasSync >= 3) { subir('warn'); motivos.push(`Sin sincronizar hace ${diasSync} días`); }

  // En la tabla va el motivo principal; todos quedan en el title de la celda.
  return { nivel, pendiente: motivos[0] || 'Al día', motivos, diasSync };
}

// Mismos cortes que _saludNegocio: hasta 2 días está bien, 3–7 atención, más es crítico.
function _pillSync(diasSync) {
  if (diasSync === null) return '<span class="pill pill-bad">Sin sincronizar</span>';
  const txt = diasSync === 0 ? 'Hoy' : `Hace ${_plural(diasSync, 'día', 'días')}`;
  const cls = diasSync <= 2 ? 'pill-ok' : diasSync <= 7 ? 'pill-warn' : 'pill-bad';
  return `<span class="pill ${cls}">${txt}</span>`;
}

const _SALUD_PILL = {
  ok:   '<span class="pill pill-ok">Al día</span>',
  warn: '<span class="pill pill-warn">Atención</span>',
  bad:  '<span class="pill pill-bad">Crítico</span>',
};

function _renderSaludCartera(clientes) {
  const tbody = $id('db-salud-tbody');
  if (!tbody) return;
  if (!clientes) {
    tbody.innerHTML = '<tr><td colspan="5" class="db-vacio">No se pudieron cargar los negocios.</td></tr>';
    return;
  }
  if (!clientes.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="db-vacio">Aún no tienes negocios asociados.</td></tr>';
    return;
  }
  const orden = { bad: 0, warn: 1, ok: 2 };
  const filas = clientes.map((c) => ({ c, s: _saludNegocio(c), ventas: c.posStats?.ventasMes }))
    .sort((a, b) => (orden[a.s.nivel] - orden[b.s.nivel]) || ((Number(b.ventas) || 0) - (Number(a.ventas) || 0)))
    .slice(0, 6);
  tbody.innerHTML = filas.map(({ c, s, ventas }) => `
    <tr class="db-fila" onclick="app.verCliente('${esc(c.id)}')" title="Ver el detalle del negocio">
      <td>
        <div class="db-negocio" title="${esc(c.businessName || c.businessKey || '')}">${esc(c.businessName || c.businessKey || '—')}</div>
        <div class="db-negocio-plan">${esc(_planTexto(c))}</div>
      </td>
      <td>${_pillSync(s.diasSync)}</td>
      <td class="is-num num">${ventas === undefined || ventas === null ? '—' : fmtMoney(ventas)}</td>
      <td class="db-pendiente" title="${esc(s.motivos.join(' · '))}">${esc(s.pendiente)}${s.motivos.length > 1 ? ` <span class="db-mas">+${s.motivos.length - 1}</span>` : ''}</td>
      <td>${_SALUD_PILL[s.nivel]}</td>
    </tr>`).join('');
}

function _renderCalendario(grupos, totalNegocios) {
  const el = $id('db-calendario');
  if (!el) return;
  if (!grupos) { el.innerHTML = '<div class="db-vacio">No se pudo cargar el calendario.</div>'; return; }
  if (!grupos.length) { el.innerHTML = '<div class="db-vacio">Sin obligaciones en los próximos 30 días.</div>'; return; }
  const negocios = _plural(totalNegocios, 'negocio', 'negocios');
  el.innerHTML = grupos.slice(0, 4).map((g) => {
    const d = _aFecha(g.fecha);
    const sub = [g.multiple ? g.etiquetas : negocios, g.finDeSemana].filter(Boolean).join(' · ');
    const chip = g.dias === 0 ? '<span class="pill pill-bad">Hoy</span>'
      : g.dias === 1 ? '<span class="pill pill-warn">Mañana</span>'
      : `<span class="pill pill-neutral">${g.dias} días</span>`;
    return `<div class="db-cal-item">
      <div class="db-cal-fecha ${g.dias <= 2 ? 'is-pronto' : ''}">
        <strong>${d.getDate()}</strong><span>${_MESES_CORTOS[d.getMonth()]}</span>
      </div>
      <div class="db-cal-texto">
        <div class="db-cal-titulo" title="${esc(g.titulo)}">${esc(g.titulo)}</div>
        <div class="db-cal-sub" title="${esc(sub)}">${esc(sub)}</div>
      </div>
      ${chip}
    </div>`;
  }).join('');
}

// "Solicitud pendiente: soporte_tecnico" → "Solicitud pendiente: Soporte Técnico".
function _msgAlerta(a) {
  if (a?.tipo !== 'solicitud_pendiente') return a?.msg || '';
  const clave = String(a.msg || '').split(':').slice(1).join(':').trim();
  const tipo = TIPOS_SOLICITUD.find((t) => t.key === clave);
  return tipo ? `Solicitud pendiente: ${tipo.label}` : a.msg;
}

// Alertas del servidor + las obligaciones DGII de los próximos 3 días.
function _renderAlertasDashboard(al, grupos) {
  const el = $id('db-alertas');
  if (!el) return;
  const lista = [];

  (grupos || []).filter((g) => g.dias <= 3).forEach((g) => {
    lista.push({
      nivel: g.dias === 0 ? 'critico' : 'urgente',
      titulo: `${g.titulo} ${_venceTexto(g.dias)}`,
      sub: `Obligación DGII · ${fmtDate(g.fecha)}`,
      boton: 'Abrir centro fiscal',
      accion: "app.goto('centro-fiscal')",
    });
  });

  const servidor = al?.alertas || [];
  // Una licencia vencida y la falta de sincronización del mismo negocio van juntas.
  const sinSync = new Map(servidor.filter((a) => a.tipo === 'sin_sync').map((a) => [a.businessId, a]));
  const unidos = new Set();
  servidor.forEach((a) => {
    if (a.tipo === 'sin_sync' && unidos.has(a.businessId)) return;
    const nombre = a.businessName || '—';
    const idJs = esc(a.businessId || '');
    if (a.tipo === 'licencia_vencida' || a.tipo === 'licencia_proxima') {
      const extra = sinSync.get(a.businessId);
      const diasSync = extra ? (String(extra.msg).match(/(\d+)\s*días/) || [])[1] : null;
      if (extra) unidos.add(a.businessId);
      const base = a.tipo === 'licencia_vencida' ? 'Licencia vencida' : `Licencia ${_venceTexto(a.dias)}`;
      lista.push({
        nivel: a.nivel,
        titulo: diasSync ? `${base} y sin sincronizar ${diasSync} días` : base,
        sub: a.tipo === 'licencia_vencida' && typeof a.dias === 'number'
          ? `${nombre} · Hace ${_plural(Math.abs(a.dias), 'día', 'días')}` : nombre,
        boton: 'Renovar',
        accion: `app.abrirSolicitudModal('${idJs}', 'renovar_licencia')`,
      });
    } else if (a.tipo === 'sin_sync') {
      const n = (String(a.msg).match(/(\d+)\s*días/) || [])[1];
      lista.push({
        nivel: a.nivel, titulo: n ? `Sin sincronizar hace ${n} días` : 'Sin sincronizar',
        sub: nombre, boton: 'Ver negocio', accion: `app.verCliente('${idJs}')`,
      });
    } else {
      lista.push({
        nivel: a.nivel, titulo: _msgAlerta(a) || 'Aviso', sub: nombre,
        boton: 'Ver solicitudes', accion: "app.goto('solicitudes')",
      });
    }
  });

  if (!al && !lista.length) { el.innerHTML = '<div class="db-vacio">No se pudieron cargar las alertas.</div>'; return; }
  if (!lista.length) { el.innerHTML = '<div class="db-vacio">No hay alertas pendientes. Todo al día.</div>'; return; }

  const orden = { critico: 0, urgente: 1, advertencia: 2, info: 3 };
  const pills = {
    critico: '<span class="pill pill-bad">Crítica</span>',
    urgente: '<span class="pill pill-bad">Urgente</span>',
    advertencia: '<span class="pill pill-warn">Advertencia</span>',
    info: '<span class="pill pill-info">Aviso</span>',
  };
  el.innerHTML = lista.sort((a, b) => (orden[a.nivel] ?? 9) - (orden[b.nivel] ?? 9)).slice(0, 4).map((a) => `
    <div class="db-alerta">
      <div class="db-alerta__nivel">${pills[a.nivel] || pills.info}</div>
      <div class="db-alerta__texto">
        <div class="db-alerta__titulo">${esc(a.titulo)}</div>
        <div class="db-alerta__sub">${esc(a.sub)}</div>
      </div>
      <button class="btn btn-secondary btn-sm" onclick="${a.accion}">${esc(a.boton)}</button>
    </div>`).join('');
}

function _renderLicencias(stats) {
  const partes = [
    { n: stats.activas || 0,     cls: 'ok',   lbl: 'Activas' },
    { n: stats.prueba || 0,      cls: 'warn', lbl: 'En prueba' },
    { n: stats.vencidas || 0,    cls: 'bad',  lbl: 'Vencidas' },
    { n: stats.suspendidas || 0, cls: 'neutral', lbl: 'Suspendidas' },
  ].filter((p, i) => p.n > 0 || i < 3);
  const barra = $id('db-lic-barra');
  if (barra) {
    const total = partes.reduce((s, p) => s + p.n, 0);
    barra.innerHTML = total
      ? partes.filter((p) => p.n > 0).map((p) => `<span class="is-${p.cls}" style="flex-grow:${p.n}" title="${p.lbl}: ${p.n}"></span>`).join('')
      : '<span class="is-vacio"></span>';
  }
  const leyenda = $id('db-lic-leyenda');
  if (leyenda) {
    leyenda.innerHTML = partes.map((p) => `<span><i class="is-${p.cls}"></i>${p.lbl} <strong>${p.n}</strong></span>`).join('');
  }
}

async function _cargarHonorarios() {
  if (_esDependiente()) return;
  try {
    const facturas = await apiCall('GET', '/api/facturacion/facturas');
    _buscadorCache.facturas = facturas;
    _buscadorCache.facturasEn = Date.now();
    const pendientes = facturas.filter((f) => f.estado === 'pendiente' || f.estado === 'parcial');
    const saldo = (f) => Number(f.balance ?? ((f.total || 0) - (f.monto_pagado || 0))) || 0;
    setText('db-hon-monto', fmtMoney(pendientes.reduce((s, f) => s + saldo(f), 0)));
    let sub = 'Todas tus facturas están cobradas.';
    if (pendientes.length) {
      const masVieja = pendientes.reduce((a, f) => (String(f.fecha || '') < String(a.fecha || '') ? f : a), pendientes[0]);
      const dias = Math.max(0, -(_diasHasta(masVieja.fecha) ?? 0));
      sub = pendientes.length === 1
        ? `1 factura ${masVieja.tipo_ncf || ''} · ${_plural(dias, 'día', 'días')} sin cobrar`.replace('  ', ' ')
        : `${pendientes.length} facturas · la más antigua tiene ${_plural(dias, 'día', 'días')}`;
    }
    setText('db-hon-sub', sub);
  } catch (_) {
    setText('db-hon-monto', '—');
    setText('db-hon-sub', 'No se pudieron cargar tus facturas.');
  }
}

function _actualizarBadgeNav(id, count) {
  const badge = $id(id);
  if (!badge) return;
  badge.textContent = count;
  badge.classList.toggle('hidden', !(count > 0));
}

async function loadDashboard() {
  const ahora = new Date();
  const mes = _MESES[ahora.getMonth()];
  setText('topbar-periodo', `${mes.charAt(0).toUpperCase()}${mes.slice(1)} ${ahora.getFullYear()}`);
  setText('db-kpi-ventas-lbl', `Ventas de la cartera · ${_MESES_CORTOS[ahora.getMonth()]}`);
  setText('db-kpi-itbis-lbl', `ITBIS facturado · ${_MESES_CORTOS[ahora.getMonth()]}`);
  setText('db-salud-col-ventas', `Ventas ${_MESES_CORTOS[ahora.getMonth()]}`);

  try {
    await refreshToken();
    const anio = ahora.getFullYear();
    // En diciembre los próximos 30 días ya entran en el año siguiente.
    const [dash, clientes, ag, al, obl, oblSiguiente] = await Promise.all([
      apiCall('GET', '/api/dashboard'),
      apiCall('GET', '/api/clientes').catch(() => null),
      apiCall('GET', '/api/analisis-global').catch(() => null),
      apiCall('GET', '/api/alertas').catch(() => null),
      apiCall('GET', `/api/centro-fiscal/obligaciones?anio=${anio}`).catch(() => null),
      ahora.getMonth() === 11
        ? apiCall('GET', `/api/centro-fiscal/obligaciones?anio=${anio + 1}`).catch(() => [])
        : Promise.resolve([]),
    ]);
    const { stats } = dash;
    if (clientes) _allClientes = clientes;
    const total = stats.total || 0;

    setText('sidebar-cartera', `${_plural(total, 'negocio', 'negocios')} en cartera`);
    _actualizarBadgeNav('nav-badge-sol', stats.solicitudesPendientes || 0);

    // KPI: negocios
    setText('db-kpi-negocios', total);
    const partesCartera = [
      _plural(stats.activas || 0, 'activo', 'activos'),
      `${stats.prueba || 0} en prueba`,
      _plural(stats.vencidas || 0, 'vencido', 'vencidos'),
    ];
    if (stats.suspendidas) partesCartera.push(_plural(stats.suspendidas, 'suspendido', 'suspendidos'));
    setText('db-kpi-negocios-sub', partesCartera.join(' · '));

    // KPI: ventas e ITBIS del mes (lo que publica cada POS)
    if (ag) {
      const r = ag.resumen;
      setText('db-kpi-ventas', fmtMoney(r.totalVentasMes));
      setText('db-kpi-itbis', fmtMoney(r.totalItbisMes));
      setText('db-kpi-ventas-sub', r.clientesConPosData < r.totalClientes
        ? `Suma de ${r.clientesConPosData} de ${r.totalClientes} negocios (el resto sin datos)`
        : `Suma de ${r.totalClientes === 1 ? 'tu negocio' : `los ${r.totalClientes} negocios`}`);
      setText('db-kpi-itbis-sub', `Base para el IT-1 de ${_MESES[(ahora.getMonth() + 1) % 12]}`);
    } else {
      setText('db-kpi-ventas', '—');
      setText('db-kpi-itbis', '—');
      setText('db-kpi-ventas-sub', 'No se pudieron cargar las ventas');
    }

    // Obligaciones DGII: KPI, aviso, calendario y badge del menú
    const grupos = obl ? _oblProximas([...obl, ...(oblSiguiente || [])], 30) : null;
    const en7 = (grupos || []).filter((g) => g.dias <= 7);
    const cuantas = en7.reduce((s, g) => s + g.items.length, 0);
    setText('db-kpi-obl', grupos ? cuantas : '—');
    setText('db-kpi-obl-sub', en7.length ? `${en7[0].titulo.replace(' · ITBIS de ', ' ')} · ${_venceTexto(en7[0].dias)}` : 'Nada vence esta semana');
    const tag = $id('db-kpi-obl-tag');
    if (tag) {
      const urgente = en7.some((g) => g.dias <= 2);
      tag.className = `pill ${urgente ? 'pill-bad' : en7.length ? 'pill-warn' : 'pill-ok'}`;
      tag.textContent = urgente ? 'Urgente' : en7.length ? 'Próximas' : 'Al día';
    }
    _actualizarBadgeNav('nav-badge-cf', cuantas);

    const aviso = $id('db-aviso');
    const pronto = (grupos || []).find((g) => g.dias <= 2);
    if (aviso) {
      aviso.classList.toggle('hidden', !pronto);
      if (pronto) {
        const cuando = pronto.dias === 0 ? 'Vence hoy' : pronto.dias === 1 ? 'Vence mañana' : 'Vence en 2 días';
        setText('db-aviso-titulo', `${cuando}: ${pronto.titulo}`);
        setText('db-aviso-sub', `${fmtDate(pronto.fecha)} · Revisa el centro fiscal para tus ${_plural(total, 'negocio', 'negocios')}.`);
      }
    }

    _renderSaludCartera(clientes);
    _renderCalendario(grupos, total);
    _renderAlertasDashboard(al, grupos);
    _renderLicencias(stats);
    if (al) _actualizarBadgeAlertas(al.critico + al.urgente);
    _cargarHonorarios();
  } catch (e) {
    toast('Error cargando dashboard: ' + e.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════════════
// BUSCADOR GLOBAL (barra superior, Ctrl+K)
// Negocios (nombre, RNC, propietario, correo) y facturas de honorarios
// (NCF, cliente, RNC). Usa lo ya cargado; las facturas se refrescan cada minuto.
// ══════════════════════════════════════════════════════════════════════

const _buscadorCache = { facturas: null, facturasEn: 0, cargandoClientes: null };
let _buscadorTimer = null;
let _buscadorSel = -1;

function _normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
function _soloAlfanum(s) { return _normalizar(s).replace(/[^a-z0-9]/g, ''); }

async function _buscadorDatos() {
  if (!_allClientes.length) {
    _buscadorCache.cargandoClientes = _buscadorCache.cargandoClientes
      || apiCall('GET', '/api/clientes').then((l) => { _allClientes = l; }).catch(() => {});
    await _buscadorCache.cargandoClientes;
    _buscadorCache.cargandoClientes = null;
  }
  if (!_esDependiente() && (!_buscadorCache.facturas || Date.now() - _buscadorCache.facturasEn > 60000)) {
    try {
      _buscadorCache.facturas = await apiCall('GET', '/api/facturacion/facturas');
      _buscadorCache.facturasEn = Date.now();
    } catch (_) { /* sin facturas: se busca solo en negocios */ }
  }
}

async function _buscarGlobal() {
  const input = $id('buscador-global');
  const caja = $id('buscador-resultados');
  if (!input || !caja) return;
  const q = _normalizar(input.value);
  const qAlnum = _soloAlfanum(input.value);
  if (!q) { caja.classList.add('hidden'); return; }

  await _buscadorDatos();
  if (_normalizar(input.value) !== q) return; // ya escribió otra cosa

  const coincide = (texto) => _normalizar(texto).includes(q);
  const coincideCodigo = (texto) => qAlnum.length >= 3 && _soloAlfanum(texto).includes(qAlnum);

  const negocios = _allClientes.filter((c) =>
    coincide(c.businessName) || coincide(c.propietario) || coincide(c.correo) || coincideCodigo(c.rnc)
  ).slice(0, 5);
  const facturas = (_buscadorCache.facturas || []).filter((f) =>
    coincideCodigo(f.ncf) || coincide(f.cliente?.nombre) || coincideCodigo(f.cliente?.rnc)
  ).slice(0, 5);

  const items = [];
  let html = '';
  if (negocios.length) {
    html += '<div class="buscador-grupo">Negocios</div>';
    html += negocios.map((c) => {
      items.push(() => verCliente(c.id));
      return `<button type="button" class="buscador-item" data-i="${items.length - 1}">
        <span class="buscador-item__titulo">${esc(c.businessName || c.businessKey || '—')}</span>
        <span class="buscador-item__meta">${esc([c.rnc ? `RNC ${c.rnc}` : '', _planTexto(c)].filter(Boolean).join(' · '))}</span>
      </button>`;
    }).join('');
  }
  if (facturas.length) {
    html += '<div class="buscador-grupo">Facturas de honorarios</div>';
    html += facturas.map((f) => {
      items.push(() => verFactura(f.id));
      return `<button type="button" class="buscador-item" data-i="${items.length - 1}">
        <span class="buscador-item__titulo">${esc(facNcfDisplay(f.ncf))} · ${esc(f.cliente?.nombre || '—')}</span>
        <span class="buscador-item__meta">${esc(fmtDate(f.fecha))} · ${esc(fmtMoney(f.total))}</span>
      </button>`;
    }).join('');
  }
  if (!items.length) html = '<div class="buscador-vacio">Sin resultados para esa búsqueda.</div>';

  caja.innerHTML = html;
  caja._acciones = items;
  _buscadorSel = items.length ? 0 : -1;
  _buscadorMarcar();
  caja.classList.remove('hidden');
}

function _buscadorMarcar() {
  document.querySelectorAll('#buscador-resultados .buscador-item').forEach((b) => {
    b.classList.toggle('is-activo', Number(b.dataset.i) === _buscadorSel);
  });
}

function _buscadorAbrir(i) {
  const caja = $id('buscador-resultados');
  const accion = caja?._acciones?.[i];
  if (!accion) return;
  caja.classList.add('hidden');
  const input = $id('buscador-global');
  if (input) { input.value = ''; input.blur(); }
  accion();
}

function _initBuscadorGlobal() {
  const input = $id('buscador-global');
  const caja = $id('buscador-resultados');
  if (!input || !caja) return;
  input.addEventListener('input', () => {
    clearTimeout(_buscadorTimer);
    _buscadorTimer = setTimeout(_buscarGlobal, 150);
  });
  input.addEventListener('focus', () => { if (input.value.trim()) _buscarGlobal(); });
  input.addEventListener('keydown', (e) => {
    const total = caja._acciones?.length || 0;
    if (e.key === 'ArrowDown' && total) { e.preventDefault(); _buscadorSel = (_buscadorSel + 1) % total; _buscadorMarcar(); }
    else if (e.key === 'ArrowUp' && total) { e.preventDefault(); _buscadorSel = (_buscadorSel - 1 + total) % total; _buscadorMarcar(); }
    else if (e.key === 'Enter' && _buscadorSel >= 0) { e.preventDefault(); _buscadorAbrir(_buscadorSel); }
    else if (e.key === 'Escape') { caja.classList.add('hidden'); input.blur(); }
  });
  caja.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.buscador-item');
    if (!item) return;
    e.preventDefault(); // que el input no pierda el foco antes del clic
    _buscadorAbrir(Number(item.dataset.i));
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#buscador-global-wrap')) caja.classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !$id('screen-app')?.classList.contains('hidden')) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
}

// ══════════════════════════════════════════════════════════════════════
// CLIENTES
// ══════════════════════════════════════════════════════════════════════

async function loadClientes() {
  const tbody = $id('clientes-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--text-muted,#5a7099)">Cargando…</td></tr>';
  try {
    await refreshToken();
    _allClientes = await apiCall('GET', '/api/clientes');
    renderClientes(_allClientes);
    const countEl = $id('clientes-count');
    if (countEl) countEl.textContent = `${_allClientes.length} negocio(s) asociados a tu firma contable.`;
    setText('sidebar-cartera', `${_plural(_allClientes.length, 'negocio', 'negocios')} en cartera`);
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--red,#ef4444);padding:20px">${e.message}</td></tr>`;
  }
}

function renderClientes(list) {
  const tbody = $id('clientes-tbody');
  if (!tbody) return;
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:48px;color:var(--text-muted,#5a7099)">
      <div style="font-size:36px;margin-bottom:8px">🏪</div>
      <div>Aún no tienes negocios asociados.</div>
      <div style="font-size:12px;margin-top:4px">Los negocios se asocian desde Tecno Caja POS al elegir "Negocio bajo Contador Asociado".</div>
    </td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(c => {
    const dias  = c.diasRestantes;
    const vence = vencimientoFecha(c);
    const sucursales = Array.isArray(c.sucursales) ? c.sucursales : [];
    const sucursalesCell = sucursales.length
      ? `<span title="${esc(sucursales.map(s => s.nombre || 'Sucursal').join(', '))}" style="cursor:default">${sucursales.length} sucursal${sucursales.length === 1 ? '' : 'es'}</span>`
      : '<span style="color:var(--text-muted,#5a7099)">—</span>';
    return `<tr>
      <td>
        <div style="font-weight:600">${c.businessName || c.businessKey || '—'}</div>
        ${esServicios(c) ? `<div style="margin:2px 0">${verticalBadge(c)}</div>` : ''}
        <div class="td-small" style="font-family:monospace;font-size:10px;color:var(--text-muted,#5a7099)">${c.businessKey || ''}</div>
      </td>
      <td class="td-small">${sucursalesCell}</td>
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

// ── Ficha del negocio (Negocios → abrir) ─────────────────────────────────
// Una sola tarjeta: nombre, estado y plan arriba; en la cuadrícula solo los
// datos que tiene el negocio (sin filas con "—"); lo técnico al pie, en
// pequeño. Si es Empresa de Servicios, su mes en una fila de cifras.
function _fichaNegocio(c, id) {
  const svc = esServicios(c);
  const nombre = c.businessName || c.businessKey || id;
  const tipo = svc ? verticalLabel(c) : String(c.tipo_negocio || '').replace(/^./, (l) => l.toUpperCase());
  const sub = [
    c.rnc ? `RNC ${esc(c.rnc)}` : '',
    esc(tipo),
    esc([c.direccion, c.provincia].filter(Boolean).join(', ')),
  ].filter(Boolean).join(' · ');

  const dias = c.diasRestantes;
  const vence = vencimientoFecha(c);
  const licencia = vence
    ? `${esc(fmtDate(vence))} · <span class="${diasClass(dias)}">${esc(diasLabel(dias))}</span>`
    : (String(c.status) === 'active' ? 'Sin vencimiento' : '');
  const sucursales = Number(c.cantidad_sucursales || 0);
  const cajas = Number(c.cantidad_cajas || 0);
  const estructura = [
    sucursales ? _plural(sucursales, 'sucursal', 'sucursales') : '',
    cajas ? _plural(cajas, 'caja', 'cajas') : '',
  ].filter(Boolean).join(' · ');

  const datos = [
    ['Propietario', esc(c.propietario || '')],
    ['Teléfono', c.telefono ? `<a href="tel:${esc(c.telefono)}">${esc(c.telefono)}</a>` : ''],
    ['Correo', c.correo ? `<a href="mailto:${esc(c.correo)}">${esc(c.correo)}</a>` : ''],
    ['Razón social', c.razon_social && c.razon_social !== c.businessName ? esc(c.razon_social) : ''],
    [String(c.status) === 'active' ? 'Licencia' : 'Prueba vence', licencia],
    ['Cliente desde', c.trialStartedAt ? esc(fmtDate(c.trialStartedAt)) : ''],
    ['Estructura', estructura],
    ['Última sincronización', c.syncedAt ? esc(fmtDate(c.syncedAt)) : '<span class="text-orange">Nunca</span>'],
  ].filter(([, v]) => v)
    .map(([k, v]) => `<div class="det-dato"><span>${k}</span><strong>${v}</strong></div>`).join('');

  const s = (c.posStats && c.posStats.servicios) || {};
  const servicios = svc ? `
    <div class="det-cifras" aria-label="Servicios del mes">
      <div><span>Facturado (mes)</span><strong class="num">${fmtMoney(s.facturadoMes || 0)}</strong><small>${_plural(Number(s.facturasMes || 0), 'factura', 'facturas')}</small></div>
      <div><span>Cobrado (mes)</span><strong class="num">${fmtMoney(s.cobradoMes || 0)}</strong></div>
      <div><span>Por cobrar</span><strong class="num">${fmtMoney(s.cuentasPorCobrar || 0)}</strong><small>${_plural(Number(s.facturasPendientes || 0), 'factura pendiente', 'facturas pendientes')}</small></div>
      <div><span>Cotizaciones abiertas</span><strong class="num">${Number(s.cotizacionesAbiertas || 0)}</strong></div>
    </div>` : '';

  const plan = _planTexto(c);
  return {
    nombre,
    iniciales: _iniciales(nombre),
    pills: `${statusBadge(c.status || 'trial')}${plan ? `<span class="pill pill-neutral">${esc(plan)}</span>` : ''}${svc ? verticalBadge(c) : ''}`,
    sub,
    datos,
    servicios,
    pie: `Clave <code>${esc(c.businessKey || c.id || id)}</code>${c.source ? ` · Origen ${esc(c.source)}` : ''}`,
  };
}

// "Ver reportes" de la ficha: Reportes con ese negocio elegido.
function verReportesNegocio(id) {
  if (!id) return;
  _repNegocioId = id;
  goto('reportes');
}

async function verCliente(id) {
  _currentClienteId = id;
  goto('cliente-detalle');
  const comprobantesEl = $id('det-comprobantes');
  if (comprobantesEl) comprobantesEl.innerHTML = '<p style="color:var(--text-muted)">Cargando…</p>';
  cargarComprobantesNegocio(id);
  try {
    await refreshToken();
    const [c, hist] = await Promise.all([
      apiCall('GET', `/api/clientes/${id}`),
      apiCall('GET', `/api/licencias/${id}`).catch(() => []),
    ]);

    const ficha = _fichaNegocio(c, id);
    setText('det-nombre', ficha.nombre);
    setText('det-avatar', ficha.iniciales);
    const pills = $id('det-pills'); if (pills) pills.innerHTML = ficha.pills;
    const sub = $id('det-sub'); if (sub) sub.innerHTML = ficha.sub;
    const datos = $id('det-datos'); if (datos) datos.innerHTML = ficha.datos;
    const servicios = $id('det-servicios'); if (servicios) servicios.innerHTML = ficha.servicios;
    const pie = $id('det-key'); if (pie) pie.innerHTML = ficha.pie;

    const hTbody = $id('det-historial-tbody');
    if (hTbody) {
      hTbody.innerHTML = (hist || []).length
        ? (hist || []).map(h => `<tr>
            <td>${h.action || '—'}</td>
            <td>${h.plan || '—'}</td>
            <td class="td-small">${h.activated_by || '—'}</td>
            <td class="td-small">${fmtDate(h.created_at)}</td>
          </tr>`).join('')
        : '<tr><td colspan="4" style="text-align:center;padding:16px;color:var(--text-muted,#5a7099)">Sin historial de licencias</td></tr>';
    }

    // Sucursales: el contador crea y edita dentro del límite que fija Tecno
    // Caja; no cambia el límite ni activa/desactiva (lo rechaza el servidor).
    const sucEl = $id('det-sucursales');
    if (sucEl && window.SucursalesUI) {
      const nuevo = sucEl.cloneNode(false); // sin los listeners del negocio anterior
      sucEl.replaceWith(nuevo);
      window.SucursalesUI.montar(nuevo, {
        api: async (method, path, body) => { await refreshToken(); return apiCall(method, path, body); },
        licenseId: id,
        permisos: { limite: false, estado: false },
        avisar: toast,
      });
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
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-muted,#5a7099)">Cargando…</td></tr>';
  try {
    await refreshToken();
    const list = await apiCall('GET', '/api/clientes');
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:36px;color:var(--text-muted,#5a7099)">Sin clientes registrados</td></tr>';
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
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="color:var(--red,#ef4444);text-align:center;padding:20px">${e.message}</td></tr>`;
  }
}

// ══════════════════════════════════════════════════════════════════════
// SOLICITUDES
// ══════════════════════════════════════════════════════════════════════

async function loadSolicitudes() {
  const tbody = $id('solicitudes-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted,#5a7099)">Cargando…</td></tr>';
  try {
    await refreshToken();
    const status = $id('filtro-sol-status')?.value || '';
    const url = status ? `/api/solicitudes?status=${encodeURIComponent(status)}` : '/api/solicitudes';
    const list = await apiCall('GET', url);
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:36px;color:var(--text-muted,#5a7099)">Sin solicitudes</td></tr>';
      return;
    }
    tbody.innerHTML = list.map(s => {
      const tipo = TIPOS_SOLICITUD.find(t => t.key === s.tipo);
      return `<tr>
        <td><span style="font-size:13px">${tipo?.icon || '📋'} ${tipo?.label || s.tipo}</span></td>
        <td class="td-small">${s.businessName || '—'}</td>
        <td style="max-width:240px"><div style="font-size:12px;color:var(--text-sub,#8fa3c2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.descripcion || '—'}</div></td>
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
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="color:var(--red,#ef4444);text-align:center;padding:20px">${e.message}</td></tr>`;
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
function abrirSolicitudModal(clienteId, tipoKey) {
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

  // Desde el Dashboard ("Renovar") llega el tipo ya elegido.
  if (tipoKey) {
    const btn = tiposEl?.querySelector(`[data-key="${tipoKey}"]`);
    if (btn) selSolTipo(tipoKey, btn);
  }

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

// Secciones de Configuración (menú de la izquierda, una a la vez). Los datos
// de la firma y el diseño de la factura van al perfil con "Guardar cambios";
// lo demás se guarda al momento o con su propio botón.
const CFG_SECCIONES = {
  firma:      { sub: 'Los datos y el logo de tu firma', guardar: true },
  factura:    { sub: 'La plantilla y el color de tus facturas y cotizaciones', guardar: true },
  recibo:     { sub: 'El recibo de pago en impresora térmica, de esta computadora' },
  correo:     { sub: 'Tu Gmail para enviarles las facturas a tus clientes' },
  apariencia: { sub: 'Modo día o noche y tamaño de la pantalla, de esta computadora' },
  ia:         { sub: 'La llave de Google Gemini del asistente virtual' },
};
let _cfgSeccion = 'firma';

// Sin sección: la última que se abrió (una oculta, como la del asistente, no vale).
function cfgIr(seccion) {
  let s = CFG_SECCIONES[seccion] ? seccion : _cfgSeccion;
  if ($id(`cfg-nav-${s}`)?.style.display === 'none') s = 'firma';
  _cfgSeccion = s;
  document.querySelectorAll('[data-cfg]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.cfg === s)));
  document.querySelectorAll('[data-cfg-panel]').forEach((p) => { p.hidden = p.dataset.cfgPanel !== s; });
  setText('cfg-sub', CFG_SECCIONES[s].sub);
  const guardar = $id('cfg-btn-guardar');
  if (guardar) guardar.style.display = CFG_SECCIONES[s].guardar ? '' : 'none';
  $id('main-content')?.scrollTo(0, 0);
}

// Abre Configuración en una sección (y pone el cursor en un campo).
function irAConfig(seccion, campo) {
  goto('configuracion');
  cfgIr(seccion);
  if (campo) setTimeout(() => $id(campo)?.focus(), 250);
}

// Estado al lado de Recibo de pago y Correo de envío en el menú.
function _cfgPintarEstados() {
  const pinta = (id, texto, clase) => {
    const el = $id(id);
    if (el) el.innerHTML = texto ? `<span class="pill ${clase}">${texto}</span>` : '';
  };
  pinta('cfg-estado-recibo', reciboConfig().activo ? 'Activo' : '', 'pill-ok');
  if (_emailCfg) pinta('cfg-estado-correo', _emailCfg.configured ? 'Listo' : 'Falta', _emailCfg.configured ? 'pill-ok' : 'pill-warn');
}

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
    _pintarDisenoFactura(p.factura_plantilla, p.factura_color);
  } catch (e) {
    toast('Error cargando perfil: ' + e.message, 'error');
  }
  loadConfigCorreo();
  loadConfigIA();
  reciboPintarConfig();
  reciboCargarImpresoras();
}

// ── Diseño de la factura (plantillas A4 del POS) ─────────────────────────
// La elección vive en #cfg-invoice-template y #cfg-invoice-color (los mismos
// id que en el POS: factura-plantillas.js los maneja) y se guarda con
// "Guardar cambios" en el perfil (factura_plantilla, factura_color).
function _empresaDeConfiguracion() {
  const val = (id) => ($id(id)?.value || '').trim();
  return {
    nombre: val('cfg-nombre-firma'), rnc: val('cfg-rnc'), direccion: val('cfg-direccion'),
    telefono: val('cfg-telefono'), correo: val('cfg-correo'), logo: val('cfg-logo'),
  };
}

function _pintarDisenoFactura(plantilla, color) {
  window.FacturaPlantillas?.sincronizarSelector(
    { invoiceTemplate: plantilla, invoiceAccentColor: color },
    { muestra: () => FacturaContador.documentoDeMuestra(_empresaDeConfiguracion()) }
  );
}

// Las miniaturas muestran el logo y los datos de la firma: se repintan al
// cambiarlos, sin perder la plantilla y el color elegidos (aún sin guardar).
function _repintarDisenoFactura() {
  _pintarDisenoFactura($id('cfg-invoice-template')?.value, $id('cfg-invoice-color')?.value);
}

// ── Configuración de correo (por contador) ────────────────────────────
async function loadConfigCorreo() {
  const est = $id('cfg-email-estado');
  try {
    const cfg = await apiCall('GET', '/api/facturacion/config/email');
    _emailCfg = cfg;
    const setVal = (id, v) => { const el = $id(id); if (el) el.value = v || ''; };
    setVal('cfg-email-user', cfg.user);
    setVal('cfg-email-from', cfg.fromName);
    const del = $id('cfg-email-del');
    if (cfg.configured) {
      if (est) est.innerHTML = `<span style="color:var(--green)">✅ Conectado: ${esc(cfg.user)}${cfg.source === 'env' ? ' (configuración global)' : ''}</span>`;
      if (del) del.style.display = cfg.source === 'contador' ? '' : 'none';
      $id('cfg-email-pass') && ($id('cfg-email-pass').placeholder = '•••••••••••••••• (déjalo vacío si no lo cambias)');
    } else {
      if (est) est.innerHTML = `<span style="color:var(--orange)">Sin configurar — no podrás enviar facturas por correo hasta configurarlo.</span>`;
      if (del) del.style.display = 'none';
    }
  } catch (e) {
    if (est) est.textContent = 'Error: ' + e.message;
  }
  _cfgPintarEstados();
}

async function guardarConfigCorreo() {
  const user = ($id('cfg-email-user')?.value || '').trim();
  const pass = ($id('cfg-email-pass')?.value || '').trim();
  const fromName = ($id('cfg-email-from')?.value || '').trim();
  if (!user) { toast('Escribe tu Gmail.', 'error'); return; }
  if (!pass) { toast('Escribe la contraseña de aplicación.', 'error'); return; }
  const btn = $id('cfg-email-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Probando…'; }
  try {
    await apiCall('PUT', '/api/facturacion/config/email', { user, pass, fromName });
    if ($id('cfg-email-pass')) $id('cfg-email-pass').value = '';
    _emailCfg = null;
    toast('Correo conectado y probado correctamente.', 'success');
    loadConfigCorreo();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Guardar y probar'; } }
}

async function desconectarConfigCorreo() {
  if (!confirm('¿Desconectar tu correo? No podrás enviar facturas hasta volver a configurarlo.')) return;
  try {
    await apiCall('DELETE', '/api/facturacion/config/email');
    _emailCfg = null;
    ['cfg-email-user', 'cfg-email-pass', 'cfg-email-from'].forEach(id => { const el = $id(id); if (el) el.value = ''; });
    toast('Correo desconectado.', 'success');
    loadConfigCorreo();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ── Asistente virtual (IA) ───────────────────────────────────────────────
let _iaCfg = null;
let _chatHistory = [];   // [{ role: 'user'|'model', text }]
let _chatBusy = false;

async function loadConfigIA() {
  if ($id('cfg-ia-card')?.style.display === 'none') return;   // módulo desactivado
  const est = $id('cfg-ia-estado');
  try {
    _iaCfg = await apiCall('GET', '/api/asistente/config');
    const del = $id('cfg-ia-del');
    if (_iaCfg.configured) {
      if (est) est.innerHTML = `<span style="color:var(--green)">✅ Asistente conectado (modelo ${esc(_iaCfg.model || 'Gemini')})</span>`;
      if (del) del.style.display = '';
      $id('cfg-ia-key') && ($id('cfg-ia-key').placeholder = '•••••••••••••••••••••••••• (déjalo vacío si no lo cambias)');
    } else {
      if (est) est.innerHTML = `<span style="color:var(--orange)">Sin configurar — el asistente no funcionará hasta que pongas tu API key.</span>`;
      if (del) del.style.display = 'none';
    }
  } catch (e) { if (est) est.textContent = 'Error: ' + e.message; }
}

async function guardarConfigIA() {
  const apiKey = ($id('cfg-ia-key')?.value || '').trim();
  if (apiKey.length < 20) { toast('Pega tu API key de Google (empieza con AIza…).', 'error'); return; }
  const btn = $id('cfg-ia-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Probando…'; }
  try {
    await apiCall('PUT', '/api/asistente/config', { apiKey });
    if ($id('cfg-ia-key')) $id('cfg-ia-key').value = '';
    _iaCfg = null;
    toast('Asistente conectado correctamente.', 'success');
    loadConfigIA();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Guardar y probar'; } }
}

async function desconectarConfigIA() {
  if (!confirm('¿Desconectar el asistente? Se borrará tu API key guardada.')) return;
  try {
    await apiCall('DELETE', '/api/asistente/config');
    _iaCfg = null;
    if ($id('cfg-ia-key')) $id('cfg-ia-key').value = '';
    toast('Asistente desconectado.', 'success');
    loadConfigIA();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function loadAsistente() {
  try { _iaCfg = await apiCall('GET', '/api/asistente/config'); } catch { _iaCfg = { configured: false }; }
  const noCfg = $id('asis-noconfig');
  const chat = $id('asis-chat-wrap');
  if (!_iaCfg.configured) {
    noCfg?.classList.remove('hidden');
    chat?.classList.add('hidden');
    return;
  }
  noCfg?.classList.add('hidden');
  chat?.classList.remove('hidden');
  if (!_chatHistory.length) _renderChat();   // muestra el saludo inicial
}

function nuevoChat() {
  _chatHistory = [];
  _renderChat();
  $id('asis-input')?.focus();
}

function _mdToHtml(s) {
  let h = esc(s);
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/^\s*[-*] (.+)$/gm, '• $1');
  h = h.replace(/\n/g, '<br>');
  return h;
}

function _renderChat() {
  const box = $id('asis-mensajes');
  if (!box) return;
  if (!_chatHistory.length) {
    box.innerHTML = `<div style="color:var(--text-sub);font-size:13px;line-height:1.7;max-width:560px">
      👋 Hola. Pregúntame lo que quieras sobre tus clientes. Por ejemplo:<br>
      <span style="opacity:.85">• ¿Quién me debe honorarios y cuánto?<br>
      • Ventas e ITBIS de <em>[cliente]</em> este mes<br>
      • ¿Qué clientes tienen la licencia por vencer?<br>
      • Resumen del POS de <em>[cliente]</em><br>
      • ¿Cuántos NCF me quedan disponibles?</span>
    </div>`;
    return;
  }
  box.innerHTML = _chatHistory.map((m, mi) => {
    if (m.role === 'user') {
      return `<div style="text-align:right;margin:10px 0"><span style="display:inline-block;max-width:80%;background:var(--blue);color:#fff;padding:8px 12px;border-radius:12px 12px 2px 12px;font-size:13px;text-align:left">${esc(m.text)}</span></div>`;
    }
    let h = `<div style="margin:10px 0"><span style="display:inline-block;max-width:85%;background:var(--surface2);padding:9px 13px;border-radius:12px 12px 12px 2px;font-size:13px;line-height:1.6">${_mdToHtml(m.text)}</span></div>`;
    (m.proposals || []).forEach((p, pi) => { h += _propuestaCard(p, mi, pi); });
    return h;
  }).join('') + (_chatBusy ? '<div id="asis-typing" style="margin:10px 0;color:var(--text-sub);font-size:13px">El asistente está pensando…</div>' : '');
  box.scrollTop = box.scrollHeight;
}

async function enviarChat() {
  if (_chatBusy) return;
  const input = $id('asis-input');
  const text = (input?.value || '').trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';
  _chatHistory.push({ role: 'user', text });
  _chatBusy = true;
  _renderChat();
  const btn = $id('asis-send'); if (btn) btn.disabled = true;
  try {
    // Al servidor solo le mandamos role+text (sin proposals).
    const clean = _chatHistory.map(m => ({ role: m.role, text: m.text }));
    const r = await apiCall('POST', '/api/asistente/chat', { history: clean });
    _chatHistory.push({ role: 'model', text: r.reply || '(sin respuesta)', proposals: r.proposals || [] });
  } catch (e) {
    _chatHistory.push({ role: 'model', text: '⚠️ ' + e.message });
  } finally {
    _chatBusy = false;
    if (btn) btn.disabled = false;
    _renderChat();
    input?.focus();
  }
}

// ── Propuestas del asistente (PDF / correo) ──────────────────────────────
function _propuestaCard(p, mi, pi) {
  const wrap = (inner) => `<div style="margin:6px 0 12px;max-width:85%;border:1px solid var(--border);border-radius:10px;padding:12px 14px;background:var(--surface)">${inner}</div>`;
  if (p.done) {
    return wrap(`<span style="color:var(--green);font-size:13px">✅ ${p.type === 'pdf' ? 'PDF descargado' : 'Correo enviado a ' + esc(p.para)}</span>`);
  }
  if (p.dismissed) return '';
  if (p.type === 'pdf') {
    return wrap(`
      <div style="font-weight:700;font-size:13px;margin-bottom:2px">📄 Reporte listo para descargar</div>
      <div style="font-size:12px;color:var(--text-sub);margin-bottom:10px">${esc(p.titulo)}${p.subtitulo ? ' — ' + esc(p.subtitulo) : ''} · ${(p.secciones || []).length} sección(es)</div>
      <button class="btn btn-primary btn-sm" onclick="app.asisPropPdf(${mi},${pi})">⬇ Descargar PDF</button>
      <button class="btn btn-ghost btn-sm" onclick="app.asisPropDismiss(${mi},${pi})">Descartar</button>`);
  }
  if (p.type === 'email') {
    return wrap(`
      <div style="font-weight:700;font-size:13px;margin-bottom:8px">✉ Correo propuesto — revísalo antes de enviar</div>
      <div class="form-group" style="margin-bottom:6px"><label class="form-label">Para</label>
        <input id="asisp-to-${mi}-${pi}" class="form-input" value="${esc(p.para)}" /></div>
      <div class="form-group" style="margin-bottom:6px"><label class="form-label">Asunto</label>
        <input id="asisp-sub-${mi}-${pi}" class="form-input" value="${esc(p.asunto)}" /></div>
      <div class="form-group" style="margin-bottom:8px"><label class="form-label">Mensaje</label>
        <textarea id="asisp-body-${mi}-${pi}" class="form-textarea" rows="5">${esc(p.cuerpo)}</textarea></div>
      ${p.adjuntar_factura_ncf ? `<div style="font-size:11px;color:var(--text-sub);margin-bottom:8px">📎 Adjuntará la factura ${esc(p.adjuntar_factura_ncf)} en PDF</div>` : ''}
      <button class="btn btn-primary btn-sm" id="asisp-send-${mi}-${pi}" onclick="app.asisPropEmail(${mi},${pi})">Enviar correo</button>
      <button class="btn btn-ghost btn-sm" onclick="app.asisPropDismiss(${mi},${pi})">Descartar</button>`);
  }
  return '';
}

function asisPropDismiss(mi, pi) {
  const p = _chatHistory[mi]?.proposals?.[pi];
  if (p) { p.dismissed = true; _renderChat(); }
}

let _asisPerfilCache = null;
async function _asisPerfil() {
  if (_asisPerfilCache) return _asisPerfilCache;
  try { _asisPerfilCache = await apiCall('GET', '/api/perfil'); } catch { _asisPerfilCache = {}; }
  return _asisPerfilCache;
}

function _asisSeccionHtml(s) {
  const esc2 = v => String(v == null ? '' : v).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const head = s.titulo ? `<h2>${esc2(s.titulo)}</h2>` : '';
  if (s.tipo === 'parrafo') return head + `<p>${esc2(s.texto)}</p>`;
  if (s.tipo === 'lista') return head + `<ul>${(s.items || []).map(i => `<li>${esc2(i)}</li>`).join('')}</ul>`;
  if (s.tipo === 'kpis') return head + `<div class="kpis">${(s.kpis || []).map(k => `<div class="kpi"><div class="kv">${esc2(k.valor)}</div><div class="kl">${esc2(k.etiqueta)}</div></div>`).join('')}</div>`;
  if (s.tipo === 'tabla') {
    const th = (s.encabezados || []).map(h => `<th>${esc2(h)}</th>`).join('');
    const tr = (s.filas || []).map(f => `<tr>${(f || []).map(c => `<td>${esc2(c)}</td>`).join('')}</tr>`).join('');
    return head + `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
  }
  return head;
}

function _buildAsistentePdfHtml(p, perfil) {
  const esc2 = v => String(v == null ? '' : v).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const hoy = new Date().toLocaleDateString('es-DO', { day: '2-digit', month: 'long', year: 'numeric' });
  const logo = perfil?.logo_url ? `<img src="${perfil.logo_url}" class="logo" alt="">` : `<div class="brand">${esc2(perfil?.nombre_firma || 'Reporte')}</div>`;
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>${esc2(p.titulo)}</title><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:"Segoe UI","Helvetica Neue",Arial,sans-serif;font-size:11px;color:#1f2937;padding:0}
    .page{max-width:190mm;margin:0 auto;padding:6mm 0}
    .head{display:flex;justify-content:space-between;align-items:flex-start;gap:12mm;border-bottom:2.5px solid #15803d;padding-bottom:6mm;margin-bottom:7mm}
    .logo{max-height:24mm;max-width:70mm}
    .brand{font-size:20px;font-weight:800;color:#15803d}
    .doc h1{font-size:17px;font-weight:800;color:#15803d;text-align:right;line-height:1.2}
    .doc .sub{font-size:11px;color:#111827;text-align:right;margin-top:2mm}
    .doc .gen{font-size:9px;color:#6b7280;text-align:right;margin-top:1mm}
    h2{font-size:9px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#6b7280;margin:6mm 0 2mm;border-bottom:1px solid #e5e7eb;padding-bottom:1.5mm}
    p{line-height:1.6;margin:2mm 0}
    ul{margin:2mm 0 2mm 5mm;line-height:1.7}
    table{width:100%;border-collapse:collapse;font-size:10px;margin:2mm 0}
    th{background:#f4f7f5;text-align:left;padding:2.4mm 2.5mm;border-top:1.2px solid #15803d;border-bottom:1.2px solid #15803d;font-size:8.5px;text-transform:uppercase;letter-spacing:.4px;color:#374151}
    td{padding:2.2mm 2.5mm;border-bottom:1px solid #edf0f2}
    .kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:4mm;margin:3mm 0}
    .kpi{border:1px solid #e5e7eb;border-top:3px solid #15803d;border-radius:3px;padding:3mm}
    .kpi .kv{font-size:14px;font-weight:800;color:#111827}
    .kpi .kl{font-size:8px;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;margin-top:1mm}
    .foot{margin-top:12mm;padding-top:4mm;border-top:1px solid #e5e7eb;font-size:8.5px;color:#9ca3af}
    @page{size:A4;margin:12mm}
  </style></head><body><div class="page">
    <div class="head">
      <div>${logo}${perfil?.rnc ? `<div style="font-size:9px;color:#6b7280;margin-top:2mm">RNC: ${esc2(perfil.rnc)}</div>` : ''}</div>
      <div class="doc"><h1>${esc2(p.titulo).toUpperCase()}</h1>${p.subtitulo ? `<div class="sub">${esc2(p.subtitulo)}</div>` : ''}<div class="gen">Generado: ${hoy}</div></div>
    </div>
    ${(p.secciones || []).map(_asisSeccionHtml).join('')}
    <div class="foot">${esc2(perfil?.nombre_firma || '')} — Reporte generado por el asistente virtual. Verifica las cifras antes de compartirlo.</div>
  </div></body></html>`;
}

async function asisPropPdf(mi, pi) {
  const p = _chatHistory[mi]?.proposals?.[pi];
  if (!p) return;
  if (!window.contadoresAPI?.isElectron) { toast('Disponible solo en la app de escritorio.', 'error'); return; }
  try {
    const perfil = await _asisPerfil();
    const html = _buildAsistentePdfHtml(p, perfil);
    const slug = (p.titulo || 'reporte').replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
    const r = await window.contadoresAPI.saveReportPdf(html, `${slug}.pdf`, false);
    if (r?.canceled) return;
    if (r?.ok) { p.done = true; _renderChat(); toast('PDF guardado.', 'success'); }
    else toast('Error: ' + (r?.error || 'no se pudo guardar'), 'error');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function asisPropEmail(mi, pi) {
  const p = _chatHistory[mi]?.proposals?.[pi];
  if (!p) return;
  const to = ($id(`asisp-to-${mi}-${pi}`)?.value || '').trim();
  const asunto = ($id(`asisp-sub-${mi}-${pi}`)?.value || '').trim();
  const cuerpo = ($id(`asisp-body-${mi}-${pi}`)?.value || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { toast('Correo de destino inválido.', 'error'); return; }
  if (!asunto || !cuerpo) { toast('Completa el asunto y el mensaje.', 'error'); return; }
  const btn = $id(`asisp-send-${mi}-${pi}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }
  try {
    let pdfBase64 = null, pdfNombre = null;
    if (p.adjuntar_factura_ncf && window.contadoresAPI?.isElectron) {
      const ncfBusca = String(p.adjuntar_factura_ncf).replace(/[^A-Z0-9]/gi, '');
      const lista = await apiCall('GET', '/api/facturacion/facturas');
      const found = lista.find(f => String(f.ncf || '').replace(/[^A-Z0-9]/gi, '') === ncfBusca);
      if (found) {
        const full = await apiCall('GET', `/api/facturacion/facturas/${found.id}`);
        const pdf = await window.contadoresAPI.renderInvoicePdf(facturaFormalHtml(full));
        if (pdf?.ok) { pdfBase64 = pdf.base64; pdfNombre = `Factura_${ncfBusca}.pdf`; }
      } else {
        toast(`No encontré la factura ${p.adjuntar_factura_ncf}; se enviará sin adjunto.`, 'info');
      }
    }
    const r = await apiCall('POST', '/api/asistente/enviar-correo', { para: to, asunto, cuerpo, pdfBase64, pdfNombre });
    p.done = true; p.para = r.to;
    _renderChat();
    toast(`Correo enviado a ${r.to}.`, 'success');
  } catch (e) {
    toast('Error: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Enviar correo'; }
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
      _repintarDisenoFactura();
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
  _repintarDisenoFactura();
}

async function savePerfil() {
  try {
    await refreshToken();
    const logoUrl = $id('cfg-logo')?.value?.trim() || null;
    const datos = {
      nombre_firma: $id('cfg-nombre-firma')?.value?.trim() || null,
      responsable:  $id('cfg-responsable')?.value?.trim()  || null,
      direccion:    $id('cfg-direccion')?.value?.trim()    || null,
      correo:       $id('cfg-correo')?.value?.trim()       || null,
      telefono:     $id('cfg-telefono')?.value?.trim()     || null,
      whatsapp:     $id('cfg-whatsapp')?.value?.trim()     || null,
      logo_url:     logoUrl,
    };
    const tplEl = $id('cfg-invoice-template');
    if (tplEl) {
      datos.factura_plantilla = tplEl.value || 'clasica';
      datos.factura_color = $id('cfg-invoice-color')?.value || '';
    }
    await apiCall('PUT', '/api/perfil', datos);
    // Las facturas y los recibos se imprimen con el perfil de la sesión
    // (_perfil): los datos, el logo y el diseño nuevos valen desde ya, sin
    // volver a iniciar sesión.
    if (_perfil) {
      ['responsable', 'direccion', 'correo', 'telefono', 'whatsapp', 'logo_url'].forEach((k) => { _perfil[k] = datos[k]; });
      if (datos.nombre_firma) _perfil.nombre_firma = datos.nombre_firma;
      if (tplEl) {
        _perfil.factura_plantilla = datos.factura_plantilla;
        _perfil.factura_color = datos.factura_color || null;
      }
    }
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
            ${v.prerelease ? '<span style="background:#f59e0b22;color:var(--orange,#f59e0b);font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px">BETA</span>' : ''}
          </div>
          <div class="ver-date">${fmtDate(v.created_at)}</div>
          ${v.descripcion ? `<div class="ver-desc" style="margin-top:4px;font-size:12px;color:var(--text-sub)">${esc(v.descripcion)}</div>` : ''}
        </div>
        ${v.url ? `<a href="${esc(v.url)}" onclick="event.preventDefault();window.open('${esc(v.url)}','_blank')" class="btn btn-secondary btn-sm" style="white-space:nowrap;align-self:center">Ver release</a>` : ''}
      </div>`).join('');
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><div style="color:var(--red,#ef4444)">Error: ${esc(e.message)}</div></div>`;
  }
}

// ══════════════════════════════════════════════════════════════════════
// REPORTES
// ══════════════════════════════════════════════════════════════════════

let _repNegocioId = null;
let _repTab       = 'ventas';
let _repLoading   = false;
let _repNegocioSucursales = []; // [{id, nombre}] del negocio seleccionado — sincronizadas por el POS
let _repProductosRows = []; // último data.rows del tab 'productos' — para poder editar/eliminar por id sin refetch
let _repStatsGlobal  = null; // stats.* del negocio completo (posStats sincronizado por el POS), para volver a "Todas"
let _repHasPosData   = false;
let _repVentasRows   = []; // filas del tab 'ventas' (últimos 30 días) — reusadas por el gráfico y por las tarjetas al filtrar por sucursal
let _repPosInformaEcf = null; // ¿su POS informa las e-NCF? (ncfEspejoVersion ≥ 2)

// `aligns` es paralelo a `cols` — debe calzar 1 a 1 con la alineación real
// que usa cada <td> en renderFila() (clases td-amount → right, style
// text-align:center → center) para que el encabezado quede sobre su columna
// en vez de pegado a la izquierda mientras los datos se van a la derecha.
const REP_TABS = {
  ventas:     { label: 'Ventas', cols: ['Fecha','Factura','Sucursal','Cajero','Cliente','Método','Total','ITBIS'],
                aligns: ['left','left','left','left','left','left','right','right'] },
  facturas:   { label: 'Facturas', cols: ['Fecha','NCF','Tipo','Sucursal','Cliente','RNC','Total','ITBIS','Estado'],
                aligns: ['left','left','left','left','left','left','right','right','left'] },
  productos:  { label: 'Productos', cols: ['Código','Nombre','Sucursal','Categoría','Precio','Costo','Stock','Vendidos','Acciones'],
                aligns: ['left','left','left','left','right','right','center','center','center'] },
  inventario: { label: 'Inventario', cols: ['Código','Nombre','Sucursal','Stock','Mínimo','Estado','Última Compra'],
                aligns: ['left','left','left','center','center','left','left'] },
  itbis:      { label: 'ITBIS', cols: ['Fecha','NCF','Tipo','Sucursal','Base Imponible','ITBIS 18%','Total'],
                aligns: ['left','left','left','left','right','right','right'] },
  cxc:        { label: 'C×Cobrar', cols: ['Cliente','Sucursal','RNC','Teléfono','Deuda','Última Compra','Estado'],
                aligns: ['left','left','left','left','right','left','left'] },
  clientes:   { label: 'Clientes', cols: ['Nombre','RNC','Teléfono','Correo','Compras','Última Visita'],
                aligns: ['left','left','left','left','center','left'] },
  cierres:    { label: 'Cierres', cols: ['Apertura','Cierre','Sucursal','Caja','Cajero','Monto Apertura','Ventas','Contado','Diferencia','Estado'],
                aligns: ['left','left','left','left','left','right','right','right','right','left'] },
  mensual:    { label: 'Mensual', cols: ['Mes','Sucursal','Ventas','Facturas','ITBIS','Clientes Nuevos'],
                aligns: ['left','left','right','center','right','center'] },
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
    _repAccionesNegocio(false);
  }
}

// Botones del negocio elegido en la cabecera (Ver reportes detallados,
// Productos, ITBIS / DGII, Reporte mensual): solo con un negocio.
function _repAccionesNegocio(visible) {
  const el = $id('rep-acciones-negocio');
  if (el) el.style.display = visible ? '' : 'none';
}

async function selNegocioReporte(id) {
  $id('rep-biz-status').style.display = 'none';
  if (!id) {
    _repNegocioId = null;
    _repNegocioSucursales = [];
    $id('rep-state-empty').style.display = '';
    $id('rep-state-data').style.display  = 'none';
    _repAccionesNegocio(false);
    loadProductosPendientes();
    loadNcfPendientes();
    loadNcfAplicadas();
    return;
  }

  _repNegocioId = id;
  $id('rep-state-empty').style.display = 'none';
  $id('rep-state-data').style.display  = '';
  _repAccionesNegocio(true);

  // Show loading state in table
  $id('rep-table-inner').innerHTML = `<div class="rep-loading"><div class="rep-spinner"></div>Cargando datos del negocio…</div>`;
  setText('rs-comprobantes', '—');
  const comprobantesEl = $id('rep-comprobantes');
  if (comprobantesEl) comprobantesEl.innerHTML = '<div class="rep-loading"><div class="rep-spinner"></div>Cargando…</div>';
  setText('rep-biz-name', '…');
  setText('rep-biz-meta', '');
  $id('rep-biz-chips').innerHTML = '';

  try {
    await refreshToken();
    const data = await apiCall('GET', `/api/reportes/${id}`);
    _repNegocioSucursales = Array.isArray(data.negocio?.sucursales) ? data.negocio.sucursales : [];
    _repStatsGlobal = data.stats;
    _repHasPosData  = data.negocio.hasPosData;
    _repPosInformaEcf = _posInformaEcf(data.negocio);
    _repEsServicios = Boolean(data.negocio?.serviceCompany);
    _repServiciosPortal = Number(data.negocio?.serviciosPortalVersion || 0) >= 1;
    _pintarCatalogoTipo();
    cargarComprobantesActivos(id);
    renderSucursalReporteFilter();
    renderBizBar(data.negocio);
    await actualizarStatsPorSucursal();

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
  setText('rs-v-total',   fmt(stats.ventasTotal));
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
    const buscar = $id('rep-f-buscar')?.value?.trim();

    if (desde)  params.set('desde', desde);
    if (hasta)  params.set('hasta', hasta);
    if (metodo) params.set('metodo', metodo);
    if (ncf)    params.set('ncf', ncf);
    if (cajero) params.set('cajero', cajero);
    if (sucursal) params.set('branchId', sucursal);
    if (buscar) params.set('q', buscar);

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

  if (_repTab === 'productos') _repProductosRows = data.rows || [];

  // Empresa de Servicios: la pestaña Productos es su catálogo de servicios.
  const cols = _repTab === 'productos' && _repEsServicios
    ? ['Código', 'Servicio', 'Sucursal', 'Categoría', 'Precio', 'Costo', 'Unidad', 'Facturados', 'Acciones']
    : REP_TABS[_repTab]?.cols || [];
  const aligns = REP_TABS[_repTab]?.aligns || [];
  if (!data.rows || !data.rows.length) {
    const posViejo = _repTab === 'productos' && _repEsServicios && !_repServiciosPortal;
    inner.innerHTML = `<div class="rep-no-sync">
      <div class="rep-no-sync-icon">📭</div>
      <div class="rep-no-sync-title">${posViejo ? 'Sin servicios todavía' : 'Sin resultados'}</div>
      <div class="rep-no-sync-sub">${posViejo ? SERVICIOS_POS_VIEJO : 'No hay datos para los filtros seleccionados.'}</div>
    </div>`;
    return;
  }

  const thead = `<thead><tr>${cols.map((c, i) => `<th style="text-align:${aligns[i] || 'left'}">${c}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${data.rows.map(row => renderFila(row, _repTab)).join('')}</tbody>`;
  inner.innerHTML = `<table class="data-table" style="table-layout:auto">${thead}${tbody}</table>`;
}

// Producto que no controla inventario (products.tracks_stock = 0 en el POS).
function _sinControlStock(row) {
  return row && (row.tracksStock === false || row.tracksStock === 0 || row.tracksStock === '0');
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
        `<td class="td-amount">${fmtMoney(row.total)}</td>`,
        `<td class="td-amount">${fmtMoney(row.itbis)}</td>`,
        `<td>${row.estado || '—'}</td>`,
      ]; break;
    case 'productos':
      // Servicio del catálogo de la Empresa de Servicios: sin costo ni stock.
      if (_esFilaServicio(row)) {
        cells = [
          `<td class="td-ncf">${esc(row.codigo || '—')}</td>`,
          `<td class="td-nombre">${esc(row.nombre || '—')} <span class="pill pill-info">Servicio</span>${row.descripcion ? `<div class="text-muted" style="font-size:12px">${esc(row.descripcion)}</div>` : ''}</td>`,
          '<td>Global</td>',
          `<td>${esc(row.categoria || '—')}</td>`,
          `<td class="td-amount">${fmtMoney(row.precio)}${row.itbisPct ? `<div class="text-muted" style="font-size:11.5px">+ ${esc(row.itbisPct)}% ITBIS</div>` : ''}</td>`,
          '<td class="td-amount">—</td>',
          `<td style="text-align:center"><span class="text-muted">${esc(row.unidad || 'servicio')}</span></td>`,
          `<td style="text-align:center">${row.vendidos ?? '—'}</td>`,
          `<td style="text-align:center;white-space:nowrap"><div class="rep-acc">
             <button class="btn-icono" data-icono="pencil" title="Editar servicio" aria-label="Editar servicio" onclick="app.editarServicioReal('${esc(row.id)}')"></button>
             <button class="btn-icono is-danger" data-icono="trash-2" title="Pedir que se dé de baja" aria-label="Dar de baja el servicio" onclick="app.darDeBajaServicio('${esc(row.id)}')"></button>
           </div></td>`,
        ];
        break;
      }
      cells = [
        `<td class="td-ncf">${row.codigo || '—'}</td>`,
        `<td class="td-nombre">${row.nombre || '—'}</td>`,
        `<td>${row.sucursal || 'Global'}</td>`,
        `<td>${row.categoria || '—'}</td>`,
        `<td class="td-amount">${fmtMoney(row.precio)}</td>`,
        `<td class="td-amount">${fmtMoney(row.costo)}</td>`,
        `<td style="text-align:center">${_sinControlStock(row) ? '<span class="text-muted">No controla</span>' : (row.stock ?? '—')}</td>`,
        `<td style="text-align:center">${row.vendidos ?? '—'}</td>`,
        `<td style="text-align:center;white-space:nowrap"><div class="rep-acc">
           <button class="btn-icono" data-icono="pencil" title="Editar producto" aria-label="Editar producto" onclick="app.editarProductoReal('${row.id}')"></button>
           <button class="btn-icono is-danger" data-icono="trash-2" title="Pedir que se elimine" aria-label="Eliminar producto" onclick="app.eliminarProductoReal('${row.id}')"></button>
         </div></td>`,
      ]; break;
    case 'inventario':
      cells = _sinControlStock(row) ? [
        `<td class="td-ncf">${row.codigo || '—'}</td>`,
        `<td class="td-nombre">${row.nombre || '—'}</td>`,
        `<td>${row.sucursal || 'Global'}</td>`,
        `<td style="text-align:center" colspan="2"><span class="text-muted">No controla inventario</span></td>`,
        `<td><span class="pill pill-neutral">Sin control</span></td>`,
        `<td class="td-date">${fmtDate(row.ultima_compra)}</td>`,
      ] : [
        `<td class="td-ncf">${row.codigo || '—'}</td>`,
        `<td class="td-nombre">${row.nombre || '—'}</td>`,
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
        `<td class="td-amount">${fmtMoney(row.itbis)}</td>`,
        `<td class="td-amount">${fmtMoney(row.total)}</td>`,
      ]; break;
    case 'cxc':
      cells = [
        `<td class="td-nombre">${row.cliente || '—'}</td>`,
        `<td>${row.sucursal || 'Global'}</td>`,
        `<td class="td-ncf">${row.rnc || '—'}</td>`,
        `<td>${row.telefono || '—'}</td>`,
        `<td class="td-amount" style="color:var(--orange,#f59e0b);font-weight:700">${fmtMoney(row.deuda)}</td>`,
        `<td class="td-date">${fmtDate(row.ultima_compra)}</td>`,
        `<td>${row.estado || '—'}</td>`,
      ]; break;
    case 'clientes':
      cells = [
        `<td class="td-nombre">${row.nombre || '—'}</td>`,
        `<td class="td-ncf">${row.rnc || '—'}</td>`,
        `<td>${row.telefono || '—'}</td>`,
        `<td>${row.correo || '—'}</td>`,
        `<td style="text-align:center">${row.compras ?? '—'}</td>`,
        `<td class="td-date">${fmtDate(row.ultima_visita)}</td>`,
      ]; break;
    case 'cierres':
      cells = [
        `<td class="td-date">${fmtDate(row.fecha_apertura)}</td>`,
        `<td class="td-date">${row.fecha_cierre ? fmtDate(row.fecha_cierre) : '<span style="color:var(--green,#10b981);font-size:11px">Abierta</span>'}</td>`,
        `<td>${row.sucursal || 'Global'}</td>`,
        `<td>${row.caja || '—'}</td>`,
        `<td>${row.cajero_apertura || row.cajero_cierre || '—'}</td>`,
        `<td class="td-amount">${fmtMoney(row.monto_apertura)}</td>`,
        `<td class="td-amount">${fmtMoney(row.total_ventas)}</td>`,
        `<td class="td-amount">${fmtMoney(row.monto_contado)}</td>`,
        `<td class="td-amount" style="${Number(row.diferencia || 0) < 0 ? 'color:var(--red,#ef4444)' : ''}">${fmtMoney(row.diferencia)}</td>`,
        `<td>${row.estado || '—'}</td>`,
      ]; break;
    case 'mensual':
      cells = [
        `<td style="font-weight:600">${row.mes || '—'}</td>`,
        `<td>${row.sucursal || 'Global'}</td>`,
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

let _repBuscarDebounceTimer = null;
function aplicarFiltrosConDebounce() {
  clearTimeout(_repBuscarDebounceTimer);
  _repBuscarDebounceTimer = setTimeout(aplicarFiltros, 300);
}

function limpiarFiltros() {
  ['rep-f-desde','rep-f-hasta','rep-f-cajero','rep-f-buscar'].forEach(id => {
    const el = $id(id); if (el) el.value = '';
  });
  ['rep-f-sucursal','rep-f-ncf','rep-f-pago'].forEach(id => {
    const el = $id(id); if (el) el.value = '';
  });
  if (_repNegocioId) { cargarDatosReporte(); actualizarStatsPorSucursal(); }
}

function exportarCSV() {
  const original = $id('rep-table-inner')?.querySelector('table');
  if (!original) { toast('No hay datos para exportar.', 'error'); return; }
  const table = _copiaSinAcciones(original);

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
  const fecha  = hoyLocal();
  const csv    = '﻿' + rows.join('\n'); // BOM for Excel
  const blob   = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement('a');
  a.href = url; a.download = `reporte_${_repTab}_${nombre}_${fecha}.csv`;
  a.click(); URL.revokeObjectURL(url);
  toast('CSV exportado correctamente.', 'success');
}

function exportarExcel() {
  const original = $id('rep-table-inner')?.querySelector('table');
  if (!original) { toast('No hay datos para exportar.', 'error'); return; }
  if (!window.XLSX) { toast('Librería de Excel no disponible.', 'error'); return; }
  const table = _copiaSinAcciones(original);

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
  const fechaArchivo = hoyLocal();
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
    listEl.innerHTML = `<div class="rep-no-sync-sub" style="padding:8px 0">No hay ${_repEsServicios ? 'servicios' : 'productos'} pendientes por sincronizar.</div>`;
    return;
  }
  const badges = { pendiente: '🟡 Pendiente de sincronizar', error: '🔴 Error' };
  const accionBadges = { crear: '🆕 Crear', editar: '✎ Editar', eliminar: '🗑 Eliminar' };
  listEl.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Acción</th><th>Código</th><th>Nombre</th><th>Sucursal</th><th>Precio</th><th>Stock</th><th>Estado</th><th>Detalle</th><th>Acciones</th></tr></thead>
      <tbody>
        ${pendientes.map(p => {
          const accion = p.accion || 'crear';
          const esEliminar = accion === 'eliminar';
          const servicio = p.tipo === 'servicio';
          return `
          <tr>
            <td>${servicio && esEliminar ? 'Dar de baja' : (accionBadges[accion] || accion)}</td>
            <td>${esc(p.codigo || '—')}</td>
            <td>${esc(p.nombre || '—')}${p.tieneImagen ? ' 📷' : ''}${servicio ? ' <span class="pill pill-info">Servicio</span>' : ''}</td>
            <td>${p.branchNombre || '🌐 Global'}</td>
            <td>${esEliminar ? '—' : fmtMoney(p.precioVenta)}${servicio && !esEliminar && p.itbisPct ? ` <small class="text-muted">+ ${esc(p.itbisPct)}% ITBIS</small>` : ''}</td>
            <td>${esEliminar ? '—' : servicio ? '<span class="text-muted">Servicio</span>' : p.tracksStock === false ? '<span class="text-muted">No controla inventario</span>' : (p.stock ?? 0)}</td>
            <td>${badges[p.status] || p.status || '—'}</td>
            <td>${p.status === 'error' ? (p.errorMessage || '') : ''}</td>
            <td style="display:flex;gap:6px">
              ${esEliminar ? '' : `<button class="btn btn-sm btn-secondary" data-icono="pencil" onclick="app.editarProductoPendiente('${p.id}')">Editar</button>`}
              <button class="btn btn-sm btn-secondary" data-icono="x" onclick="app.eliminarProductoPendiente('${p.id}')">${esEliminar ? 'Cancelar' : 'Quitar'}</button>
            </td>
          </tr>
        `; }).join('')}
      </tbody>
    </table>
  `;
}

async function eliminarProductoPendiente(pendingId) {
  if (!confirm('¿Eliminar este producto pendiente? Todavía no se ha aplicado en el POS del cliente.')) return;
  try {
    await refreshToken();
    await apiCall('DELETE', `/api/productos-pendientes/${_repNegocioId}/${pendingId}`);
    toast('Producto pendiente eliminado.', 'success');
    loadProductosPendientes();
  } catch (e) { toast(e.message, 'error'); }
}

let _editingPendingProductId = null;
let _targetRealProductId = null; // producto YA sincronizado que se está proponiendo editar (accion:'editar')

// Modal "Nuevo producto" (diseño 2026). El alcance y el ITBIS se eligen con
// botones; al guardar se traducen a los mismos campos de siempre
// (branchId / aplicaItbis / itbisModo / itbisMonto) que aplica el POS.
let _apAlcance = 'todas';  // 'todas' | 'una'
let _apItbis   = 'exento'; // 'exento' | 'porcentaje' | 'monto'
// Solo para la vista previa: el POS cobra el % general de SU configuración
// (casi siempre 18%). El precio de venta se guarda SIN ITBIS, como en el POS.
const AP_ITBIS_TASA = 18;
const AP_UNIDADES = ['Unidad', 'Caja', 'Paquete', 'Botella', 'Lata', 'Fardo', 'Pack', 'Docena', 'Litro', 'Galón',
  'Frasco', 'Blíster', 'Sobre', 'Par', 'Pieza', 'Rollo', 'Saco', 'Metro', 'Pie', 'Servicio'];

function _apRedondear(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function _apLlenarUnidades(actual) {
  const sel = $id('ap-unidad');
  if (!sel) return;
  const lista = AP_UNIDADES.slice();
  if (actual && !lista.includes(actual)) lista.unshift(actual); // unidad propia del negocio
  sel.innerHTML = lista.map((u) => `<option value="${esc(u)}">${esc(u)}</option>`).join('');
  sel.value = actual || 'Unidad';
}

// Sugerencias de categoría: las que ya usa el catálogo cargado del negocio.
function _apLlenarCategorias() {
  const lista = $id('ap-categorias');
  if (!lista) return;
  const cats = [...new Set(_repProductosRows.filter((p) => !_esFilaServicio(p)).map((p) => String(p.categoria || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'es'));
  lista.innerHTML = cats.map((c) => `<option value="${esc(c)}"></option>`).join('');
}

function apElegirAlcance(alcance) {
  _apAlcance = alcance === 'una' && _repNegocioSucursales.length ? 'una' : 'todas';
  document.querySelectorAll('[data-ap-alcance]').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.apAlcance === _apAlcance));
  });
  const sel = $id('ap-sucursal');
  if (sel) sel.style.display = _apAlcance === 'una' ? '' : 'none';
}

// "Controlar inventario" (igual que el POS, products.tracks_stock): apagado
// oculta el stock; el producto se vende sin contar existencias.
function apControlInventario(valor) {
  const chk = $id('ap-controla');
  if (chk && typeof valor === 'boolean') chk.checked = valor;
  const controla = chk ? chk.checked : true;
  const wrap = $id('ap-stock-wrap'); if (wrap) wrap.style.display = controla ? '' : 'none';
  const nota = $id('ap-sin-control'); if (nota) nota.style.display = controla ? 'none' : '';
}

function apElegirItbis(modo) {
  _apItbis = ['exento', 'porcentaje', 'monto'].includes(modo) ? modo : 'exento';
  document.querySelectorAll('[data-ap-itbis]').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.apItbis === _apItbis));
  });
  const montoWrap = $id('ap-itbis-monto-wrap');
  if (montoWrap) montoWrap.style.display = _apItbis === 'monto' ? '' : 'none';
  const incluyeWrap = $id('ap-incluye-wrap');
  if (incluyeWrap) incluyeWrap.style.display = _apItbis === 'exento' ? 'none' : '';
  apCalcular();
}

// Precio que se guarda (sin ITBIS, igual que el POS) y la vista previa.
// "El precio ya incluye ITBIS" solo convierte lo escrito al precio base.
function _apPrecios() {
  const precio = Math.max(0, Number($id('ap-precio-venta')?.value || 0));
  const costo  = Math.max(0, Number($id('ap-precio-compra')?.value || 0));
  const monto  = Math.max(0, Number($id('ap-itbis-monto')?.value || 0));
  const incluye = _apItbis !== 'exento' && Boolean($id('ap-precio-incluye')?.checked);
  let base = precio;
  if (incluye) base = _apItbis === 'monto' ? precio - monto : precio / (1 + AP_ITBIS_TASA / 100);
  base = _apRedondear(Math.max(0, base));
  const itbis = _apItbis === 'exento' ? 0
    : _apItbis === 'monto' ? _apRedondear(monto)
    : _apRedondear(base * AP_ITBIS_TASA / 100);
  return { precio, costo, incluye, base, itbis, final: _apRedondear(base + itbis) };
}

function apCalcular() {
  const p = _apPrecios();
  setText('ap-r-base', fmtMoney(p.base));
  setText('ap-r-itbis', fmtMoney(p.itbis));
  setText('ap-r-final', fmtMoney(p.final));

  const gan = $id('ap-r-ganancia');
  if (gan) {
    if (!p.base || !p.costo) {
      gan.textContent = '—';
      gan.className = 'num';
    } else {
      const g = _apRedondear(p.base - p.costo);
      gan.textContent = `${fmtMoney(g)} · ${Math.round((g / p.base) * 100)}%`;
      gan.className = `num ${g >= 0 ? 'text-green' : 'text-red'}`;
    }
  }

  let nota = '';
  if (p.incluye && p.precio && Math.abs(p.final - p.precio) >= 0.005) {
    nota = `Por el redondeo a centavos, en caja se cobrará ${fmtMoney(p.final)}.`;
  } else if (_apItbis === 'porcentaje') {
    nota = 'Vista previa con 18 %. El POS aplica la tasa general que tenga configurada el negocio.';
  }
  setText('ap-r-nota', nota);
}

// Siguiente código corto libre (0001, 0002…) mirando el catálogo cargado y lo
// pendiente. Si choca con uno que no estaba cargado, el POS lo marca en Error.
function generarCodigoProducto() {
  const usados = new Set([..._repProductosRows, ..._productosPendientes]
    .map((p) => String(p.codigo || '').trim()).filter(Boolean));
  const cortos = [...usados].filter((c) => /^\d{1,6}$/.test(c));
  const ancho = Math.max(4, ...cortos.map((c) => c.length));
  let n = cortos.reduce((max, c) => Math.max(max, Number(c)), 0) + 1;
  let codigo = String(n).padStart(ancho, '0');
  while (usados.has(codigo)) { n += 1; codigo = String(n).padStart(ancho, '0'); }
  const el = $id('ap-codigo');
  if (el) { el.value = codigo; el.focus(); }
}

function _apLimpiarImagen() {
  _apImagenDataUrl = null;
  const preview = $id('ap-image-preview');
  const placeholder = $id('ap-image-placeholder');
  const box = preview?.closest('.ap-image-box');
  if (preview) { preview.src = ''; preview.style.display = 'none'; }
  if (placeholder) placeholder.style.display = '';
  if (box) box.classList.remove('has-image');
  const fileInput = $id('ap-image-file');
  if (fileInput) fileInput.value = '';
}

// Rótulos según el caso: crear, editar uno pendiente o pedir editar uno real.
function _apModo(modo) {
  const nuevo = modo === 'nuevo';
  setText('modal-agregar-producto-titulo',
    nuevo ? 'Nuevo producto' : modo === 'pendiente' ? 'Editar producto pendiente' : 'Solicitar edición del producto');
  setText('modal-agregar-producto-btn',
    nuevo ? 'Guardar producto' : modo === 'pendiente' ? 'Guardar cambios' : 'Enviar solicitud');
  setText('ap-stock-lbl', nuevo ? 'Stock inicial' : 'Stock');
  const otro = $id('ap-otro-wrap');
  if (otro) otro.style.visibility = nuevo ? '' : 'hidden';
}

function abrirAgregarProductoModal() {
  if (!_repNegocioId) { toast('Selecciona un negocio primero.', 'error'); return; }
  _editingPendingProductId = null;
  _targetRealProductId = null;
  ['ap-codigo', 'ap-nombre', 'ap-categoria', 'ap-marca', 'ap-precio-compra', 'ap-precio-venta', 'ap-stock', 'ap-stock-min', 'ap-itbis-monto'].forEach((id) => {
    const el = $id(id);
    if (el) el.value = '';
  });
  _apLlenarUnidades('Unidad');
  _apLlenarCategorias();

  const negocio = _allClientes.find((c) => c.id === _repNegocioId);
  const nombreNegocio = negocio?.businessName || $id('rep-biz-name')?.textContent || 'El negocio';
  setText('ap-sub', `${nombreNegocio} · se aplica en el POS cuando sincronice`);

  const sucursalEl = $id('ap-sucursal');
  if (sucursalEl) {
    sucursalEl.innerHTML = _repNegocioSucursales
      .map((s) => `<option value="${esc(s.id)}">${esc(s.nombre || 'Sucursal')}</option>`).join('');
  }
  const alcanceWrap = $id('ap-alcance-wrap');
  if (alcanceWrap) alcanceWrap.style.display = _repNegocioSucursales.length ? '' : 'none';
  apElegirAlcance('todas');

  const incluyeEl = $id('ap-precio-incluye');
  if (incluyeEl) incluyeEl.checked = false;
  const otroEl = $id('ap-crear-otro');
  if (otroEl) otroEl.checked = false;
  apElegirItbis('exento');
  apControlInventario(true);
  _fmLimpiar('modal-agregar-producto');

  _apLimpiarImagen();
  _apModo('nuevo');
  show('modal-agregar-producto');
  setTimeout(() => $id('ap-nombre')?.focus(), 50);
}

// Carga un producto (pendiente o real) en el modal ya abierto.
function _apRellenar(d) {
  const set = (id, val) => { const el = $id(id); if (el) el.value = val ?? ''; };
  set('ap-codigo', d.codigo);
  set('ap-nombre', d.nombre);
  set('ap-categoria', d.categoria);
  set('ap-marca', d.marca);
  _apLlenarUnidades(d.unidad || 'Unidad');
  set('ap-precio-compra', d.precioCompra);
  set('ap-precio-venta', d.precioVenta);
  set('ap-stock', d.stock);
  set('ap-stock-min', d.stockMin);
  set('ap-itbis-monto', d.itbisMonto || '');
  // El precio guardado ya es sin ITBIS: no volver a convertirlo.
  const incluyeEl = $id('ap-precio-incluye');
  if (incluyeEl) incluyeEl.checked = false;
  apElegirItbis(!d.aplicaItbis ? 'exento' : d.itbisModo === 'monto' ? 'monto' : 'porcentaje');
  // Sin el dato (POS viejo o solicitud vieja) = controla, como en el POS.
  apControlInventario(!(d.tracksStock === false || d.tracksStock === 0 || d.tracksStock === '0'));
  const sucursalEl = $id('ap-sucursal');
  const tieneSucursal = d.branchId && _repNegocioSucursales.some((s) => String(s.id) === String(d.branchId));
  if (sucursalEl && tieneSucursal) sucursalEl.value = String(d.branchId);
  apElegirAlcance(tieneSucursal ? 'una' : 'todas');
}

function editarProductoPendiente(pendingId) {
  const p = _productosPendientes.find((item) => item.id === pendingId);
  if (!p) { toast('No se encontró ese producto pendiente.', 'error'); return; }
  if (p.tipo === 'servicio') {
    abrirServicioModal();
    _asPendienteId = pendingId;
    _asRellenar(p);
    _asModo('pendiente');
    return;
  }

  abrirAgregarProductoModal();
  _editingPendingProductId = pendingId;
  _apRellenar(p);
  _apModo('pendiente');
}

// Producto YA sincronizado (vive en el POS real, no en la cola pendiente) —
// se abre el mismo modal precargado con sus datos actuales; al guardar se
// crea una SOLICITUD de edición nueva (accion:'editar' + productoId), que el
// POS aplica en su próxima sincronización (segundos, con el listener en
// tiempo real activo).
function editarProductoReal(productoId) {
  const p = _repProductosRows.find((item) => String(item.id) === String(productoId));
  if (!p) { toast('No se encontró ese producto. Actualiza la pestaña e intenta de nuevo.', 'error'); return; }

  abrirAgregarProductoModal();
  _targetRealProductId = productoId;
  _apRellenar({ ...p, precioCompra: p.costo, precioVenta: p.precio });
  _apModo('real');
}

async function eliminarProductoReal(productoId) {
  const p = _repProductosRows.find((item) => String(item.id) === String(productoId));
  const nombre = p?.nombre || `#${productoId}`;
  if (!confirm(`¿Solicitar eliminar "${nombre}"? Se aplicará en el POS del cliente en su próxima sincronización, y solo si no tiene stock pendiente ni ventas registradas — si tiene, quedará en Error y podrás marcarlo inactivo en su lugar.`)) return;
  try {
    await refreshToken();
    await apiCall('POST', '/api/productos-pendientes', {
      businessId: _repNegocioId,
      accion: 'eliminar',
      productoId,
      codigo: p?.codigo || '',
      nombre,
      branchId: p?.branchId || null,
    });
    toast('Solicitud de eliminación enviada.', 'success');
    loadProductosPendientes();
  } catch (e) { toast(e.message, 'error'); }
}

function cerrarAgregarProductoModal() { _editingPendingProductId = null; _targetRealProductId = null; hide('modal-agregar-producto'); }

// "Crear otro después de guardar": deja categoría, unidad, sucursal e ITBIS
// como estaban (lo normal es cargar varios parecidos seguidos).
function _apPrepararOtro() {
  ['ap-codigo', 'ap-nombre', 'ap-marca', 'ap-precio-compra', 'ap-precio-venta', 'ap-stock', 'ap-stock-min'].forEach((id) => {
    const el = $id(id);
    if (el) el.value = '';
  });
  _apLimpiarImagen();
  apCalcular();
  $id('ap-nombre')?.focus();
}

async function guardarProductoPendiente() {
  const codigo = $id('ap-codigo')?.value?.trim();
  const nombre = $id('ap-nombre')?.value?.trim();
  const precios = _apPrecios();
  const precioVenta = precios.base;
  const controla = $id('ap-controla')?.checked !== false;
  _fmLimpiar('modal-agregar-producto');
  const errores = [];
  if (!nombre) errores.push(['ap-nombre', 'Escribe el nombre del producto.']);
  if (!codigo) errores.push(['ap-codigo', 'Escribe el código o usa Generar.']);
  if (!precioVenta || precioVenta <= 0) errores.push(['ap-precio-venta', 'Indica un precio de venta mayor que 0.']);
  if (controla && Number($id('ap-stock')?.value || 0) < 0) errores.push(['ap-stock', 'El stock no puede ser negativo.']);
  if (controla && Number($id('ap-stock-min')?.value || 0) < 0) errores.push(['ap-stock-min', 'No puede ser negativo.']);
  if (errores.length) {
    errores.forEach(([id, msg]) => _fmError(id, msg));
    $id(errores[0][0])?.focus();
    return;
  }

  const sucursalEl = $id('ap-sucursal');
  const branchId = _apAlcance === 'una' && sucursalEl?.value ? Number(sucursalEl.value) : null;
  const payload = {
    codigo,
    nombre,
    categoria:    $id('ap-categoria')?.value?.trim() || 'General',
    marca:        $id('ap-marca')?.value?.trim() || '',
    unidad:       $id('ap-unidad')?.value?.trim() || 'Unidad',
    precioCompra: Number($id('ap-precio-compra')?.value || 0),
    precioVenta,
    // Sin control de inventario el stock no se usa (el POS no lo toca al editar).
    stock:        controla ? Number($id('ap-stock')?.value || 0) : 0,
    stockMin:     controla ? Number($id('ap-stock-min')?.value || 0) : 0,
    tracksStock:  controla,
    aplicaItbis:  _apItbis !== 'exento',
    itbisModo:    _apItbis === 'monto' ? 'monto' : 'porcentaje',
    itbisMonto:   Math.max(0, Number($id('ap-itbis-monto')?.value || 0)),
    branchId,
  };
  // Si no se tocó la imagen al editar, no mandar el campo — el backend
  // conserva la que ya había en vez de borrarla.
  if (_apImagenDataUrl !== null || !_editingPendingProductId) {
    payload.imagenData = _apImagenDataUrl || null;
  }
  if (_targetRealProductId) {
    payload.accion = 'editar';
    payload.productoId = _targetRealProductId;
  }

  const btn = $id('modal-agregar-producto-btn');
  if (btn) btn.disabled = true;
  try {
    await refreshToken();
    const esNuevo = !_editingPendingProductId && !_targetRealProductId;
    if (_editingPendingProductId) {
      await apiCall('PUT', `/api/productos-pendientes/${_repNegocioId}/${_editingPendingProductId}`, payload);
      toast('Producto pendiente actualizado — se aplicará cuando el sistema del cliente sincronice.', 'success');
    } else {
      await apiCall('POST', '/api/productos-pendientes', { businessId: _repNegocioId, ...payload });
      toast(_targetRealProductId
        ? 'Solicitud de edición enviada — se aplicará cuando el sistema del cliente sincronice.'
        : 'Producto agregado — se aplicará cuando el sistema del cliente sincronice.', 'success');
    }
    if (esNuevo && $id('ap-crear-otro')?.checked) {
      // El nuevo ya cuenta para "Generar" aunque la lista no haya recargado.
      _productosPendientes.push({ codigo });
      _apPrepararOtro();
    } else {
      cerrarAgregarProductoModal();
    }
    loadProductosPendientes();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ══════════════════════════════════════════════════════════════════════
// SERVICIOS (Empresa de Servicios)
// El catálogo de servicios del POS (svc_services) sale en la pestaña
// Productos (filas tipo 'servicio', id 'svc-N', ver sync-pos-stats.js del
// POS). Agregar, editar o dar de baja va por la misma cola que los productos
// con tipo 'servicio' (server/sync/pending-servicios.js del POS). El precio
// se guarda sin ITBIS y el ITBIS es un % que se suma en la factura, igual que
// en el Catálogo de servicios del POS. Un negocio que no es Empresa de
// Servicios vende servicios como productos sin control de inventario.
// ══════════════════════════════════════════════════════════════════════

const AS_UNIDADES = ['servicio', 'hora', 'día', 'semana', 'mes', 'año', 'visita', 'sesión', 'proyecto', 'unidad'];
let _repEsServicios = false; // el negocio de Reportes es Empresa de Servicios
let _repServiciosPortal = false; // su POS publica y recibe servicios (serviciosPortalVersion ≥ 1)
const SERVICIOS_POS_VIEJO = 'Este negocio tiene una versión de Tecno Caja que todavía no le manda sus servicios al portal ni los recibe desde aquí. Cuando actualice, aparecen aquí.';
let _asItbis = 18;
let _asPendienteId = null;   // editando un servicio que todavía está en la cola
let _asServicioId = null;    // pidiendo editar uno que ya está en el POS (id local)

function _esFilaServicio(row) { return row && row.tipo === 'servicio'; }
function _idServicio(rowId) { return Number(String(rowId || '').replace(/^svc-/, '')) || null; }

// En una Empresa de Servicios la pestaña Productos es su catálogo de servicios.
function _pintarCatalogoTipo() {
  document.querySelectorAll('.rep-lbl-productos').forEach((el) => { el.textContent = _repEsServicios ? 'Servicios' : 'Productos'; });
  const prod = $id('rep-btn-agregar-producto');
  const serv = $id('rep-btn-agregar-servicio');
  if (prod) { prod.style.display = _repEsServicios ? 'none' : ''; prod.className = 'btn btn-primary'; }
  if (serv) serv.className = `btn ${_repEsServicios ? 'btn-primary' : 'btn-secondary'}`;
}

function asElegirItbis(pct) {
  _asItbis = [0, 16, 18].includes(Number(pct)) ? Number(pct) : 18;
  document.querySelectorAll('[data-as-itbis]').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.asItbis) === _asItbis)));
  const incluye = $id('as-incluye-wrap');
  if (incluye) incluye.style.display = _asItbis ? '' : 'none';
  asCalcular();
}

function _asPrecios() {
  const precio = Math.max(0, Number($id('as-precio')?.value || 0));
  const incluye = _asItbis > 0 && Boolean($id('as-precio-incluye')?.checked);
  const base = _apRedondear(incluye ? precio / (1 + _asItbis / 100) : precio);
  const itbis = _apRedondear(base * _asItbis / 100);
  return { precio, base, itbis, final: _apRedondear(base + itbis) };
}

function asCalcular() {
  const p = _asPrecios();
  setText('as-r-base', fmtMoney(p.base));
  setText('as-r-itbis', fmtMoney(p.itbis));
  setText('as-r-final', fmtMoney(p.final));
}

function _asModo(modo) {
  setText('as-titulo', modo === 'nuevo' ? 'Nuevo servicio' : modo === 'pendiente' ? 'Editar servicio pendiente' : 'Solicitar edición del servicio');
  setText('as-btn', modo === 'nuevo' ? 'Guardar servicio' : modo === 'pendiente' ? 'Guardar cambios' : 'Enviar solicitud');
  const otro = $id('as-otro-wrap');
  if (otro) otro.style.visibility = modo === 'nuevo' ? '' : 'hidden';
}

function abrirServicioModal() {
  if (!_repNegocioId) { toast('Selecciona un negocio primero.', 'error'); return; }
  if (_repEsServicios && !_repServiciosPortal) { toast(SERVICIOS_POS_VIEJO, 'error'); return; }
  // Negocio normal: el servicio es un producto que no controla inventario.
  if (!_repEsServicios) {
    abrirAgregarProductoModal();
    apControlInventario(false);
    _apLlenarUnidades('Servicio');
    setText('modal-agregar-producto-titulo', 'Nuevo servicio');
    setText('modal-agregar-producto-btn', 'Guardar servicio');
    return;
  }
  _asPendienteId = null;
  _asServicioId = null;
  ['as-nombre', 'as-codigo', 'as-unidad', 'as-categoria', 'as-descripcion', 'as-precio'].forEach((id) => { const el = $id(id); if (el) el.value = ''; });
  const unidades = $id('as-unidades');
  if (unidades) unidades.innerHTML = AS_UNIDADES.map((u) => `<option value="${esc(u)}"></option>`).join('');
  const categorias = $id('as-categorias');
  if (categorias) {
    const cats = [...new Set(_repProductosRows.filter(_esFilaServicio).map((s) => String(s.categoria || '').trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'es'));
    categorias.innerHTML = cats.map((c) => `<option value="${esc(c)}"></option>`).join('');
  }
  const incluye = $id('as-precio-incluye'); if (incluye) incluye.checked = false;
  const otro = $id('as-crear-otro'); if (otro) otro.checked = false;
  const negocio = _allClientes.find((c) => c.id === _repNegocioId);
  setText('as-sub', `${negocio?.businessName || 'El negocio'} · se aplica en el POS cuando sincronice`);
  asElegirItbis(18);
  _fmLimpiar('modal-servicio');
  _asModo('nuevo');
  show('modal-servicio');
  setTimeout(() => $id('as-nombre')?.focus(), 50);
}

function _asRellenar(d) {
  const set = (id, val) => { const el = $id(id); if (el) el.value = val ?? ''; };
  set('as-nombre', d.nombre);
  set('as-codigo', d.codigo);
  set('as-unidad', d.unidad);
  set('as-categoria', d.categoria && d.categoria !== 'General' ? d.categoria : '');
  set('as-descripcion', d.descripcion);
  set('as-precio', d.precio ?? d.precioVenta);
  asElegirItbis(Number(d.itbisPct || 0));
}

function editarServicioReal(rowId) {
  const s = _repProductosRows.find((r) => String(r.id) === String(rowId));
  if (!s) { toast('No se encontró ese servicio. Actualiza la pestaña e intenta de nuevo.', 'error'); return; }
  abrirServicioModal();
  _asServicioId = _idServicio(rowId);
  _asRellenar(s);
  _asModo('real');
}

async function darDeBajaServicio(rowId) {
  const s = _repProductosRows.find((r) => String(r.id) === String(rowId));
  const nombre = s?.nombre || `#${_idServicio(rowId)}`;
  if (!confirm(`¿Dar de baja "${nombre}"? Deja de ofrecerse en el POS cuando sincronice; las facturas que ya lo tienen no cambian.`)) return;
  try {
    await refreshToken();
    await apiCall('POST', '/api/productos-pendientes', {
      businessId: _repNegocioId, tipo: 'servicio', accion: 'eliminar', servicioId: _idServicio(rowId), codigo: s?.codigo || '', nombre,
    });
    toast('Solicitud de baja enviada.', 'success');
    loadProductosPendientes();
  } catch (e) { toast(e.message, 'error'); }
}

function cerrarServicioModal() { _asPendienteId = null; _asServicioId = null; hide('modal-servicio'); }

async function guardarServicioPendiente() {
  const nombre = $id('as-nombre')?.value?.trim();
  _fmLimpiar('modal-servicio');
  if (!nombre) { _fmError('as-nombre', 'Escribe el nombre del servicio.'); $id('as-nombre')?.focus(); return; }
  const payload = {
    tipo: 'servicio',
    nombre,
    codigo: $id('as-codigo')?.value?.trim() || '',
    unidad: $id('as-unidad')?.value?.trim() || 'servicio',
    categoria: $id('as-categoria')?.value?.trim() || 'General',
    descripcion: $id('as-descripcion')?.value?.trim() || '',
    precioVenta: _asPrecios().base,
    itbisPct: _asItbis,
  };
  if (_asServicioId) { payload.accion = 'editar'; payload.servicioId = _asServicioId; }
  const esNuevo = !_asPendienteId && !_asServicioId;
  const btn = $id('as-btn');
  if (btn) btn.disabled = true;
  try {
    await refreshToken();
    if (_asPendienteId) {
      await apiCall('PUT', `/api/productos-pendientes/${_repNegocioId}/${_asPendienteId}`, payload);
      toast('Servicio pendiente actualizado — se aplicará cuando el sistema del cliente sincronice.', 'success');
    } else {
      await apiCall('POST', '/api/productos-pendientes', { businessId: _repNegocioId, ...payload });
      toast(_asServicioId
        ? 'Solicitud de edición enviada — se aplicará cuando el sistema del cliente sincronice.'
        : 'Servicio agregado — se aplicará cuando el sistema del cliente sincronice.', 'success');
    }
    if (esNuevo && $id('as-crear-otro')?.checked) {
      ['as-nombre', 'as-codigo', 'as-descripcion', 'as-precio'].forEach((id) => { const el = $id(id); if (el) el.value = ''; });
      asCalcular();
      $id('as-nombre')?.focus();
    } else {
      cerrarServicioModal();
    }
    loadProductosPendientes();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ══════════════════════════════════════════════════════════════════════
// IMPORTAR / EXPORTAR EL CATÁLOGO EN CSV (productos o servicios del negocio)
// Mismo formato que el POS (js/catalogo-csv.js, copiado por vendor-sync).
// Importar: se lee aquí, se muestra qué se crea y qué se actualiza, y cada
// fila va a la cola con importado: true (POST /api/productos-pendientes/lote).
// El POS crea lo nuevo y, en lo que ya tiene (por código), cambia solo las
// columnas que traía el archivo. En una Empresa de Servicios es su catálogo
// de servicios; si no, sus productos.
// ══════════════════════════════════════════════════════════════════════

const IC_LOTE = 500; // filas por envío (un lote de Firestore)
let _icLeido = null; // { filas: [...con estado], errores: [...] }

function _icNombreArchivo(sufijo) {
  const negocio = _allClientes.find((c) => c.id === _repNegocioId);
  const base = String(negocio?.businessName || 'negocio').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'negocio';
  return `${base}-${sufijo}.csv`;
}

function _icDescargar(contenido, nombre) {
  const url = URL.createObjectURL(new Blob([contenido], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Filas del catálogo (las de la pestaña) en las columnas que importa el POS.
function _icRegistrosCatalogo() {
  if (_repEsServicios) {
    return _repProductosRows.filter(_esFilaServicio).map((s) => ({
      codigo: s.codigo, nombre: s.nombre, descripcion: s.descripcion, categoria: s.categoria, unidad: s.unidad,
      precio: (Number(s.precio) || 0).toFixed(2), itbisPct: Number(s.itbisPct) || 0, duracionMin: '', estado: 'Activo',
    }));
  }
  return _repProductosRows.filter((p) => !_esFilaServicio(p)).map((p) => ({
    codigo: p.codigo, nombre: p.nombre, sucursal: p.branchId ? (p.sucursal || '') : '', marca: p.marca, categoria: p.categoria,
    unidad: p.unidad, precioCompra: (Number(p.costo) || 0).toFixed(2), precioVenta: (Number(p.precio) || 0).toFixed(2),
    stock: p.stock ?? '', stockMin: p.stockMin ?? '', estado: 'Activo',
    aplicaItbis: p.aplicaItbis ? 'Sí' : 'No', tracksStock: _sinControlStock(p) ? 'No' : 'Sí',
  }));
}

function exportarCatalogoCsv() {
  if (!_repNegocioId) { toast('Selecciona un negocio primero.', 'error'); return; }
  const csv = window.TcCatalogoCsv;
  const registros = _icRegistrosCatalogo();
  if (!registros.length) { toast(`Este negocio todavía no tiene ${_repEsServicios ? 'servicios' : 'productos'} sincronizados. Usa "Descargar plantilla" en Importar.`, 'error'); return; }
  const columnas = _repEsServicios ? csv.COLUMNAS_SERVICIOS : csv.COLUMNAS_PRODUCTOS;
  _icDescargar(csv.aCsv(columnas, registros), _icNombreArchivo(_repEsServicios ? 'servicios' : 'productos'));
  toast(`${registros.length} ${_repEsServicios ? 'servicios exportados' : 'productos exportados'}. Se abre con Excel.`, 'success');
}

function icPlantilla() {
  const csv = window.TcCatalogoCsv;
  _icDescargar(csv.aCsv(_repEsServicios ? csv.COLUMNAS_SERVICIOS : csv.COLUMNAS_PRODUCTOS, []),
    `plantilla-${_repEsServicios ? 'servicios' : 'productos'}.csv`);
}

function abrirImportarCatalogo() {
  if (!_repNegocioId) { toast('Selecciona un negocio primero.', 'error'); return; }
  if (_repEsServicios && !_repServiciosPortal) { toast(SERVICIOS_POS_VIEJO, 'error'); return; }
  const que = _repEsServicios ? 'servicios' : 'productos';
  const negocio = _allClientes.find((c) => c.id === _repNegocioId);
  setText('ic-titulo', `Importar ${que}`);
  setText('ic-sub', `${negocio?.businessName || 'El negocio'} · se aplica en su POS cuando sincronice.`);
  setText('ic-drop-titulo', `Sube el CSV de ${que} (uno o varios)`);
  setText('ic-drop-ayuda', _repEsServicios
    ? 'El que exporta el POS o Excel → Guardar como → CSV. Lo nuevo se crea y lo que ya existe (por código o nombre) se actualiza.'
    : 'El que exporta el POS o Excel → Guardar como → CSV. Lo nuevo se crea y lo que ya existe (por código) se actualiza.');
  setText('ic-columnas', _repEsServicios
    ? 'Columnas: Código, Nombre, Descripción, Categoría, Unidad, Precio, ITBIS %. Solo Nombre es obligatoria.'
    : 'Columnas: Código, Nombre, Sucursal, Marca, Categoría, Unidad, Costo, Precio, Stock, Stock Mínimo, Aplica ITBIS, Rastrea Stock. Código y Nombre son obligatorias.');
  _icLeido = null;
  _icDestinoElegido = false;
  _icPintarDestino(false);
  _icPintar();
  setText('ic-msg', '');
  _icPrepararArrastre();
  show('modal-importar-catalogo');
}

// ── A qué sucursal van los productos importados ─────────────────────────
// Solo productos y solo si el negocio tiene sucursales (el catálogo de
// servicios es de todo el negocio). '' = todas (global), un id = solo esa,
// 'archivo' = lo que diga la columna Sucursal de cada fila.
const IC_SEGUN_ARCHIVO = 'archivo';

function _icPintarDestino(archivoTraeSucursal) {
  const campo = $id('ic-destino-campo');
  const sel = $id('ic-destino');
  const aplica = !_repEsServicios && _repNegocioSucursales.length > 0;
  if (campo) campo.style.display = aplica ? '' : 'none';
  if (!sel || !aplica) return;
  const actual = sel.value;
  sel.innerHTML = '<option value="">Todas las sucursales (global)</option>'
    + _repNegocioSucursales.map((s) => `<option value="${esc(s.id)}">Solo en ${esc(s.nombre || 'Sucursal')}${s.conectada && !s.principal ? ' (conectada)' : ''}</option>`).join('')
    + (archivoTraeSucursal ? `<option value="${IC_SEGUN_ARCHIVO}">Según la columna Sucursal del archivo</option>` : '');
  const opciones = Array.from(sel.options).map((o) => o.value);
  // Recién leído un archivo con la columna Sucursal: se respeta por defecto.
  sel.value = archivoTraeSucursal && !_icDestinoElegido ? IC_SEGUN_ARCHIVO : (opciones.includes(actual) ? actual : '');
  _icAyudaDestino();
}

let _icDestinoElegido = false; // el contador ya lo cambió a mano

function _icDestino() {
  if (_repEsServicios || !_repNegocioSucursales.length) return '';
  return $id('ic-destino')?.value || '';
}

function _icAyudaDestino() {
  const d = _icDestino();
  const s = _repNegocioSucursales.find((x) => String(x.id) === String(d));
  setText('ic-destino-ayuda', (d === IC_SEGUN_ARCHIVO
    ? 'Cada producto nuevo va a la sucursal que diga su fila; vacía o "Global" = todas.'
    : s ? `Los productos nuevos quedan solo en ${s.nombre}.` : 'Los productos nuevos se ven y se venden en todas las sucursales.')
    + ' Los que ya existen se actualizan donde están.');
}

function icCambiarDestino() {
  _icDestinoElegido = true;
  _icAyudaDestino();
  _icPintar();
}

// Filas que se importan con el destino elegido: con "según el archivo", las
// de una sucursal que no es del negocio no van.
function _icFilasValidas() {
  const d = _icLeido;
  if (!d) return { filas: [], errores: [] };
  if (_icDestino() !== IC_SEGUN_ARCHIVO) return { filas: d.filas, errores: d.errores };
  return {
    filas: d.filas.filter((f) => f.sucursalMala === undefined),
    errores: [...d.errores, ...d.filas.filter((f) => f.sucursalMala !== undefined).map((f) => `fila ${f.fila}: la sucursal "${f.sucursalMala}" no es de este negocio.`)],
  };
}

function _icNombreDestino(f) {
  const d = _icDestino();
  const id = d === IC_SEGUN_ARCHIVO ? f.branchArchivo : (d || null);
  return id ? (_repNegocioSucursales.find((s) => String(s.id) === String(id))?.nombre || 'Sucursal') : 'Todas';
}

function cerrarImportarCatalogo() {
  hide('modal-importar-catalogo');
  _icLeido = null;
}

function _icPrepararArrastre() {
  const drop = $id('ic-drop');
  if (!drop || drop.dataset.listo) return;
  drop.dataset.listo = '1';
  ['dragenter', 'dragover'].forEach((tipo) => drop.addEventListener(tipo, (ev) => { ev.preventDefault(); drop.classList.add('is-encima'); }));
  ['dragleave', 'drop'].forEach((tipo) => drop.addEventListener(tipo, () => drop.classList.remove('is-encima')));
  drop.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const files = Array.from(ev.dataTransfer?.files || []);
    if (files.length) icLeerArchivos(files);
  });
}

// Sucursal del CSV (nombre o id) → id de una sucursal del negocio. Vacía o
// "Global" = todas. undefined = no existe.
function _icSucursal(valor) {
  const t = String(valor || '').trim();
  if (!t || t.toLowerCase() === 'global' || t.toLowerCase() === 'todas') return null;
  const s = _repNegocioSucursales.find((x) => String(x.id) === t || String(x.nombre || '').trim().toLowerCase() === t.toLowerCase());
  return s ? s.id : undefined;
}

// Nuevo o "se actualiza", contra lo que ya se ve del negocio (sus filas de la
// pestaña). El POS compara con todo su catálogo, así que uno que no salga
// aquí también se actualiza si ya existe allá. La columna Sucursal de cada
// producto queda resuelta (branchArchivo) o marcada si no es del negocio
// (sucursalMala): solo cuenta si el destino es "según el archivo".
function _icClasificar(filas, servicios) {
  const actuales = _repProductosRows.filter((r) => _esFilaServicio(r) === servicios);
  const porCodigo = new Map(actuales.filter((r) => r.codigo).map((r) => [String(r.codigo).toLowerCase(), r]));
  const porNombre = new Map(actuales.map((r) => [String(r.nombre || '').toLowerCase(), r]));
  const clasificadas = filas.map((f) => {
    const g = { ...f };
    if (!servicios && f.campos.includes('sucursal')) {
      const id = _icSucursal(f.sucursal);
      if (id === undefined) g.sucursalMala = f.sucursal;
      else g.branchArchivo = id;
    }
    const actual = (f.codigo && porCodigo.get(f.codigo.toLowerCase())) || (servicios ? porNombre.get(f.nombre.toLowerCase()) : null);
    g.estado = actual ? 'actualiza' : 'nuevo';
    return g;
  });
  return { filas: clasificadas, errores: [] };
}

async function icLeerArchivos(files) {
  const lista = Array.from(files || []);
  if (!lista.length) return;
  const csv = window.TcCatalogoCsv;
  const servicios = _repEsServicios;
  const varios = lista.length > 1;
  setText('ic-msg', '');
  try {
    _icLeido = await _anAnalizar({
      titulo: 'Analizando el archivo',
      subtitulo: varios ? `${lista.length} archivos: ${lista.map((f) => f.name).join(', ')}` : lista[0].name,
      pasos: [varios ? `Leyendo los ${lista.length} archivos` : 'Leyendo el archivo', 'Reconociendo las columnas', 'Comparando con lo que ya tiene el negocio'],
      trabajo: async () => {
        const filas = [];
        const errores = [];
        for (const file of lista) {
          try {
            const leido = servicios ? csv.leerServicios(await csv.leerArchivo(file)) : csv.leerProductos(await csv.leerArchivo(file));
            leido.filas.forEach((f) => filas.push({ ...f, archivo: file.name }));
            leido.errores.forEach((e) => errores.push(`${varios ? `${file.name}, ` : ''}fila ${e.fila}: ${e.mensaje}`));
          } catch (e) {
            errores.push(`${file.name}: ${e.message}`);
          }
        }
        if (!filas.length) throw new Error(errores[0] || 'El archivo no trae filas para importar.');
        const r = _icClasificar(filas, servicios);
        return { filas: r.filas, errores: [...errores, ...r.errores], servicios };
      },
      resumen: (r) => {
        const nuevos = r.filas.filter((f) => f.estado === 'nuevo').length;
        return `Encontré ${r.filas.length} ${servicios ? 'servicios' : 'productos'}: ${nuevos} nuevos y ${r.filas.length - nuevos} para actualizar.`
          + (r.errores.length ? ` ${r.errores.length} fila(s) con problemas.` : '');
      },
    });
  } catch (_) {
    return; // el error ya se mostró en la ventana de análisis
  }
  _icPintarDestino(_icLeido.filas.some((f) => String(f.sucursal || '').trim()));
  _icPintar();
}

function icQuitar() {
  _icLeido = null;
  _icPintarDestino(false);
  _icPintar();
}

function _icPintar() {
  const caja = $id('ic-resultado');
  const drop = $id('ic-drop');
  const boton = $id('ic-btn');
  const d = _icLeido;
  if (drop) drop.style.display = d ? 'none' : '';
  if (!caja) return;
  if (!d) {
    caja.innerHTML = '';
    if (boton) { boton.textContent = 'Importar'; boton.disabled = true; }
    return;
  }
  const { filas, errores } = _icFilasValidas();
  const nuevos = filas.filter((f) => f.estado === 'nuevo').length;
  const muestra = filas.slice(0, 50);
  const precio = (f) => (d.servicios ? f.precio : f.precioVenta);
  const conSucursal = !d.servicios && _repNegocioSucursales.length > 0;
  caja.innerHTML = `
    <div class="an-leido">
      <div class="an-leido__cabeza">
        <div><strong>Listo para importar</strong><small>${filas.length} ${d.servicios ? 'servicios' : 'productos'}: ${_plural(nuevos, 'nuevo', 'nuevos')} y ${filas.length - nuevos} ${filas.length - nuevos === 1 ? 'se actualiza' : 'se actualizan'}</small></div>
        <button type="button" class="btn btn-secondary btn-sm" data-icono="x" onclick="app.icQuitar()">Quitar</button>
      </div>
      ${errores.length ? `<div class="an-aviso" role="note"><strong>${_plural(errores.length, 'fila no se importa', 'filas no se importan')}:</strong>
        ${errores.slice(0, 5).map(esc).join(' · ')}${errores.length > 5 ? ` · y ${errores.length - 5} más` : ''}</div>` : ''}
      <div class="ic-tabla">
        <table class="data-table">
          <thead><tr><th>Fila</th><th>Código</th><th>${d.servicios ? 'Servicio' : 'Producto'}</th>${conSucursal ? '<th>Sucursal</th>' : ''}<th style="text-align:right">Precio</th><th></th></tr></thead>
          <tbody>${muestra.map((f) => `<tr>
            <td>${esc(f.fila)}</td><td>${esc(f.codigo || '—')}</td><td>${esc(f.nombre)}</td>
            ${conSucursal ? `<td>${f.estado === 'actualiza' ? '<span class="text-muted">Donde ya está</span>' : esc(_icNombreDestino(f))}</td>` : ''}
            <td style="text-align:right">${precio(f) != null ? fmtMoney(precio(f)) : '—'}</td>
            <td><span class="pill ${f.estado === 'nuevo' ? 'pill-ok' : 'pill-info'}">${f.estado === 'nuevo' ? 'Nuevo' : 'Se actualiza'}</span></td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
      ${filas.length > muestra.length ? `<small class="text-muted">… y ${filas.length - muestra.length} más.</small>` : ''}
      <small class="text-muted">Al actualizar solo cambian las columnas que trae el archivo: un CSV con Código y Precio sube los precios sin tocar lo demás.</small>
    </div>`;
  if (boton) {
    boton.textContent = `Importar ${_plural(filas.length, d.servicios ? 'servicio' : 'producto', d.servicios ? 'servicios' : 'productos')}`;
    boton.disabled = !filas.length;
  }
}

// Fila leída → lo que espera POST /api/productos-pendientes/lote. destino:
// '' = todas las sucursales, un id = esa sucursal, 'archivo' = la de la fila.
function _icItem(f, servicios, destino = '') {
  if (servicios) {
    return {
      fila: f.fila, campos: f.campos, codigo: f.codigo, nombre: f.nombre, descripcion: f.descripcion,
      categoria: f.categoria, unidad: f.unidad, precioVenta: f.precio, itbisPct: f.itbisPct,
    };
  }
  return {
    fila: f.fila, campos: f.campos, codigo: f.codigo, nombre: f.nombre, marca: f.marca, categoria: f.categoria,
    unidad: f.unidad, precioCompra: f.precioCompra, precioVenta: f.precioVenta, stock: f.stock, stockMin: f.stockMin,
    aplicaItbis: f.aplicaItbis, tracksStock: f.tracksStock,
    branchId: destino === IC_SEGUN_ARCHIVO ? (f.branchArchivo ?? null) : (destino || null),
  };
}

async function icImportar() {
  const d = _icLeido;
  const { filas } = _icFilasValidas();
  if (!d || !filas.length) return;
  const negocioId = _repNegocioId;
  const destino = _icDestino();
  const que = d.servicios ? 'servicios' : 'productos';
  const sucursal = _repNegocioSucursales.find((s) => String(s.id) === String(destino));
  setText('ic-msg', '');
  try {
    await _anAnalizar({
      titulo: `Importando ${que}`,
      subtitulo: `${filas.length} ${que}${d.servicios || !_repNegocioSucursales.length ? '' : destino === IC_SEGUN_ARCHIVO ? ' · cada uno a la sucursal del archivo' : sucursal ? ` · solo en ${sucursal.nombre}` : ' · todas las sucursales'}`,
      pasos: ['Revisando cada fila', 'Enviándolas al POS del negocio', 'Dejándolas listas para que su POS las aplique'],
      trabajo: async () => {
        await refreshToken();
        let registrados = 0;
        for (let i = 0; i < filas.length; i += IC_LOTE) {
          const r = await apiCall('POST', '/api/productos-pendientes/lote', {
            businessId: negocioId,
            tipo: d.servicios ? 'servicio' : 'producto',
            items: filas.slice(i, i + IC_LOTE).map((f) => _icItem(f, d.servicios, destino)),
          });
          registrados += Number(r.registrados || 0);
        }
        return registrados;
      },
      resumen: (n) => `Listo: ${n} ${que} en camino. Su POS los aplica cuando sincronice (en segundos si está abierto).`,
    });
  } catch (_) {
    return; // el error ya se mostró; lo leído sigue en pantalla
  }
  cerrarImportarCatalogo();
  loadProductosPendientes();
}

// ══════════════════════════════════════════════════════════════════════
// SECUENCIAS NCF PENDIENTES (registradas desde este Portal)
// Mismo mecanismo que Productos Pendientes: el POS del cliente corre local,
// esto queda en cola en Firestore y se aplica la próxima vez que ese POS
// sincroniza. NCF tradicional (B01-B17) y e-NCF de la factura electrónica
// (E31-E47), a mano o leídos del archivo de la DGII (js/dgii-autorizacion.js).
// Visible en la pestaña "🏛 ITBIS / DGII" y desde la ficha del negocio.
// ══════════════════════════════════════════════════════════════════════

// e-NCF que se le pueden registrar a un negocio (los del POS:
// modules/ecf/config/document-types.js). "Mis secuencias" del contador y su
// facturación siguen siendo solo B (NCF_DOCUMENT_TYPES).
const ECF_DOCUMENT_TYPES = ['E31', 'E32', 'E33', 'E34', 'E41', 'E43', 'E44', 'E45', 'E46', 'E47'];

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
// El modal "Registrar comprobantes" se abre para un negocio: el de Reportes o
// el de su ficha. Lo que ya tiene (aplicadas + en cola) sirve para no repetir.
let _anNegocioId = null;
let _anAplicadas = [];
let _anPendientes = [];
// Archivo de la DGII leído: { nombre, dataUrl, rangos: [{ ..., estado }] } o null.
let _anDgii = null;
// ¿El POS del negocio le informa al portal sus e-NCF? (ncfEspejoVersion ≥ 2,
// lo escribe sync-pos-stats.js). null = todavía no se sabe.
let _anPosInformaEcf = null;

function _posInformaEcf(negocio) {
  return Number(negocio?.ncfEspejoVersion || 0) >= 2;
}

// El adjunto puede ser PDF/XML/imagen — a diferencia de la imagen de producto
// no se puede "redimensionar", solo se valida tamaño antes de convertir a base64.
function handleAgregarNcfAdjunto(input) {
  const file = input?.files?.[0];
  if (!file) return;
  _fmError('an-adjunto-file', '');
  if (file.size > 700 * 1024) { _fmError('an-adjunto-file', 'El archivo debe pesar menos de 700 KB.'); input.value = ''; return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    _anAdjuntoDataUrl = e.target.result;
    setText('an-adjunto-nombre', `Adjunto: ${file.name}`);
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
            <td>${['pendiente', 'error'].includes(n.status) ? `<button class="btn btn-sm btn-secondary" data-icono="x" onclick="app.cancelarNcfPendiente('${n.id}')">${n.status === 'error' ? 'Descartar' : 'Cancelar'}</button>` : ''}</td>
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

// Abre "Registrar comprobantes" para un negocio: el elegido en Reportes o,
// desde su ficha, el que se pase. Carga lo que ya tiene para no repetir rangos.
async function abrirAgregarNcfModal(negocioId) {
  const id = negocioId || _repNegocioId;
  if (!id) { toast('Selecciona un negocio primero.', 'error'); return; }
  _anNegocioId = id;
  _anDgii = null;
  _anPosInformaEcf = null;
  _anAplicadas = id === _repNegocioId ? _ncfAplicadas : [];
  _anPendientes = id === _repNegocioId ? _ncfPendientes : [];
  const tipoEl = $id('an-tipo');
  if (tipoEl) { tipoEl.innerHTML = _ncfOpcionesCliente(); tipoEl.value = 'B02'; }
  ['an-desde', 'an-hasta', 'an-fecha-autorizacion', 'an-fecha-vencimiento', 'an-referencia', 'an-notas'].forEach((campoId) => {
    const el = $id(campoId);
    if (el) el.value = '';
  });
  const negocio = _allClientes.find((c) => c.id === id);
  setText('an-sub', `${negocio?.businessName || 'El negocio'} · se aplica en su POS cuando sincronice.`);
  _anPintarSucursales(id === _repNegocioId ? _repNegocioSucursales : []);
  _anAdjuntoDataUrl = null;
  setText('an-adjunto-nombre', '');
  const fileInput = $id('an-adjunto-file');
  if (fileInput) fileInput.value = '';
  _fmLimpiar('an-form');
  setText('an-msg', '');
  _anPrepararArrastre();
  renderAnDgii();
  anActualizar();
  show('modal-agregar-ncf');

  try {
    await refreshToken();
    const [aplicadas, pendientes, cliente] = await Promise.all([
      apiCall('GET', `/api/ncf-aplicadas/${id}`),
      apiCall('GET', `/api/ncf-pendientes/${id}`),
      apiCall('GET', `/api/clientes/${id}`).catch(() => null),
    ]);
    if (_anNegocioId !== id) return;
    _anAplicadas = aplicadas || [];
    _anPendientes = pendientes || [];
    if (cliente) {
      _anPosInformaEcf = _posInformaEcf(cliente);
      if (id !== _repNegocioId) _anPintarSucursales(cliente.sucursales || []);
    }
    if (_anDgii) {
      _anDgii.rangos = _anClasificarRangos(_anDgii.leidos, _anExistentes(), _anPosInformaEcf);
      renderAnDgii();
    }
  } catch (_) {
    // Sin la lista se registra igual: el servidor revisa los cruces.
  }
}

// Sucursal: solo si el negocio tiene. Una sucursal conectada por Internet
// recibe sus rangos en Sucursales (el servidor la rechaza aquí).
function _anPintarSucursales(sucursales) {
  const sel = $id('an-sucursal');
  const campo = $id('an-sucursal-campo');
  if (!sel) return;
  const actual = sel.value;
  sel.innerHTML = '<option value="">Todas las sucursales</option>' + (sucursales || []).map((s) => (s.conectada && !s.principal
    ? `<option value="${esc(s.id)}" disabled>${esc(s.nombre)} — sus rangos se asignan en Sucursales</option>`
    : `<option value="${esc(s.id)}">${esc(s.nombre)}</option>`)).join('');
  sel.value = (sucursales || []).some((s) => String(s.id) === actual) ? actual : '';
  if (campo) campo.style.display = (sucursales || []).length ? '' : 'none';
}

// Lo que el negocio ya tiene en su POS más lo que está en cola para aplicarse.
function _anExistentes() {
  const enCola = (_anPendientes || []).filter((n) => (n.action || 'create') === 'create' && n.status !== 'aplicado')
    .map((n) => ({ ...n, status: 'pendiente', enCola: true }));
  return [...(_anAplicadas || []), ...enCola];
}

function anActualizar() {
  const tipo = $id('an-tipo')?.value || '';
  const electronico = _ncfEsE(tipo);
  const el = $id('an-prefijo'); if (el) el.value = tipo;
  setText('an-tipo-ayuda', NCF_DESCRIPCIONES[tipo] || '');
  setText('an-vence-lbl', electronico ? 'Fecha de vencimiento (si la DGII la indica)'
    : NCF_SIN_VENCE.has(tipo) ? 'Fecha de vencimiento (las notas de crédito no vencen)' : 'Fecha de vencimiento *');
  setText('an-fecha-autorizacion-lbl', electronico ? 'Fecha de autorización *' : 'Fecha de autorización');
  const desde = $id('an-desde'); if (desde) desde.placeholder = '1';
  const hasta = $id('an-hasta'); if (hasta) hasta.placeholder = electronico ? '100' : '500';
  const p = $id('an-preview');
  if (p) p.innerHTML = _ncfPreviewHtml(tipo, $id('an-desde')?.value, $id('an-hasta')?.value);
}

function cerrarAgregarNcfModal() {
  hide('modal-agregar-ncf');
  _anDgii = null;
}

async function guardarNcfPendiente() {
  if (_anDgii) return registrarRangosDgii();
  const documentType = $id('an-tipo')?.value;
  const startNumber = Number($id('an-desde')?.value || 0);
  const endNumber = Number($id('an-hasta')?.value || 0);
  const authorizationReference = $id('an-referencia')?.value?.trim();
  const authorizationDate = $id('an-fecha-autorizacion')?.value || '';

  _fmLimpiar('an-form');
  setText('an-msg', '');
  const err = _ncfValidar({
    tipo: documentType, desde: startNumber, hasta: endNumber, vence: $id('an-fecha-vencimiento')?.value || '',
    existentes: _anExistentes(),
  });
  if (_ncfEsE(documentType) && _anPosInformaEcf === false) {
    const m = $id('an-msg');
    if (m) {
      m.textContent = 'Este negocio tiene una versión de Tecno Caja que no recibe e-NCF desde el portal: que actualice primero.';
      m.classList.add('is-error');
    }
    return;
  }
  if (!authorizationReference) err.referencia = 'Escribe el número de autorización de la DGII.';
  if (_ncfEsE(documentType) && !authorizationDate) err.autorizada = 'Indica la fecha en que la DGII autorizó el rango.';
  if (err.desde) _fmError('an-desde', err.desde);
  if (err.hasta) _fmError('an-hasta', err.hasta);
  if (err.vence) _fmError('an-fecha-vencimiento', err.vence);
  if (err.referencia) _fmError('an-referencia', err.referencia);
  if (err.autorizada) _fmError('an-fecha-autorizacion', err.autorizada);
  if (Object.keys(err).length) return;

  try {
    await refreshToken();
    await apiCall('POST', '/api/ncf-pendientes', {
      businessId: _anNegocioId,
      documentType,
      branchId: _anSucursalElegida(),
      startNumber,
      endNumber,
      authorizationDate: authorizationDate || null,
      expirationDate: $id('an-fecha-vencimiento')?.value || null,
      authorizationReference,
      notes: $id('an-notas')?.value?.trim() || '',
      attachmentData: _anAdjuntoDataUrl || null,
    });
    toast(`Secuencia ${documentType} registrada — se aplicará cuando el sistema del cliente sincronice.`, 'success');
    _anDespuesDeRegistrar();
  } catch (e) {
    const m = $id('an-msg');
    if (m) { m.textContent = e.message; m.classList.add('is-error'); }
  }
}

function _anSucursalElegida() {
  const valor = $id('an-sucursal')?.value;
  return valor ? Number(valor) : null;
}

// Cierra y repinta donde se abrió (Reportes o la ficha del negocio). El POS
// suele aplicarlo en segundos: se vuelve a mirar al rato.
function _anDespuesDeRegistrar() {
  const id = _anNegocioId;
  cerrarAgregarNcfModal();
  if (id === _repNegocioId) { loadNcfPendientes(); cargarComprobantesActivos(id); scheduleNcfRefresh(); }
  if (id === _currentClienteId) {
    cargarComprobantesNegocio(id);
    setTimeout(() => { if (_currentClienteId === id) cargarComprobantesNegocio(id); }, 4000);
  }
}

// ── Archivo de la DGII ───────────────────────────────────────────────────
// Lo lee js/dgii-autorizacion.js (el mismo del POS): XML, Excel o CSV de la
// Oficina Virtual. Cada rango aprobado queda como 'nuevo' o, si no se puede
// registrar, con el motivo. `existentes` = el espejo del POS (lo cargado ahí,
// a mano o desde aquí, con lo usado) más lo que está en cola.
// posInformaEcf === false: el POS del negocio es de una versión que no
// informa sus e-NCF, así que un E "nuevo" queda sin confirmar.
function _anClasificarRangos(leidos, existentes, posInformaEcf = null) {
  const validos = [...NCF_DOCUMENT_TYPES.map((t) => t.code), ...ECF_DOCUMENT_TYPES];
  // Con varios archivos, un rango tampoco puede cruzarse con otro del mismo lote.
  const delLote = [];
  return (leidos || []).map((r) => {
    const base = { ...r, tipo: String(r.tipo || '').toUpperCase() };
    if (!validos.includes(base.tipo)) return { ...base, estado: 'omitido', motivo: `${base.tipo} no se usa en Tecno Caja.` };
    if (!base.referencia) return { ...base, estado: 'omitido', motivo: 'Al archivo le falta el Nº de autorización: regístralo a mano.' };
    if (_ncfEsE(base.tipo) && !base.fechaAutorizacion) {
      return { ...base, estado: 'omitido', motivo: 'Al archivo le falta la fecha de autorización: regístralo a mano.' };
    }
    const cruza = (s) => String(s.documentType || '').toUpperCase() === base.tipo
      && !['cancelado', 'eliminado'].includes(s.status)
      && base.desde <= Number(s.endNumber) && base.hasta >= Number(s.startNumber);
    const choque = (existentes || []).find(cruza);
    const choqueLote = choque ? null : delLote.find(cruza);
    if (choqueLote) {
      return {
        ...base, estado: 'omitido',
        motivo: `Se cruza con ${_ncfFmt(base.tipo, choqueLote.startNumber)}–${_ncfFmt(base.tipo, choqueLote.endNumber)}${choqueLote.archivo ? ` de ${choqueLote.archivo}` : ''}.`,
      };
    }
    if (choque) {
      const igual = Number(choque.startNumber) === base.desde && Number(choque.endNumber) === base.hasta;
      let motivo;
      if (choque.enCola) motivo = igual ? 'Ya se registró: espera que el POS lo aplique.' : `Se cruza con ${_ncfFmt(base.tipo, choque.startNumber)}–${_ncfFmt(base.tipo, choque.endNumber)}, que espera que el POS lo aplique.`;
      else {
        const lugar = igual ? 'Ya está en el POS del negocio' : `Se cruza con ${_ncfFmt(base.tipo, choque.startNumber)}–${_ncfFmt(base.tipo, choque.endNumber)}, que ya está en el POS`;
        motivo = `${lugar}${_anUsoTexto(choque)}.`;
      }
      return { ...base, estado: 'registrado', motivo };
    }
    delLote.push({ documentType: base.tipo, startNumber: base.desde, endNumber: base.hasta, archivo: base.archivo });
    // Esa versión tampoco aplica e-NCF de la cola: no se registra hasta que actualice.
    if (_ncfEsE(base.tipo) && posInformaEcf === false) {
      return {
        ...base, estado: 'sin_confirmar', sinConfirmar: true,
        motivo: 'El POS de este negocio todavía no le informa al portal sus e-NCF: no puedo comprobar si ya lo tiene.',
      };
    }
    return { ...base, estado: 'nuevo', motivo: '' };
  });
}

// " · usados 1, va por el E320000000002" / " · ya se usó completo" / " · sin usar"
function _anUsoTexto(s) {
  const desde = Number(s.startNumber), hasta = Number(s.endNumber);
  const siguiente = Number(s.nextNumber);
  if (!Number.isFinite(siguiente) || siguiente <= desde) return ' · sin usar todavía';
  if (siguiente > hasta) return ' · ya se usó completo';
  return ` · ${_plural(siguiente - desde, 'usado', 'usados')}, va por el ${_ncfFmt(s.documentType, siguiente)}`;
}

function _anPrepararArrastre() {
  const drop = $id('an-drop');
  if (!drop || drop.dataset.listo) return;
  drop.dataset.listo = '1';
  ['dragenter', 'dragover'].forEach((tipo) => drop.addEventListener(tipo, (ev) => {
    ev.preventDefault();
    drop.classList.add('is-encima');
  }));
  ['dragleave', 'drop'].forEach((tipo) => drop.addEventListener(tipo, () => drop.classList.remove('is-encima')));
  drop.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const files = Array.from(ev.dataTransfer?.files || []);
    if (files.length) anLeerArchivoDgii(files);
  });
}

// Data URL con el tipo según la extensión (Windows a veces no lo da y el POS
// solo guarda XML, CSV o Excel como documento de autorización).
function _anArchivoComoDataUrl(file) {
  const tipos = {
    xml: 'application/xml', csv: 'text/csv', xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  const ext = String(file.name || '').split('.').pop().toLowerCase();
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(String(e.target.result || '').replace(/^data:[^;,]*/, `data:${tipos[ext] || 'application/octet-stream'}`));
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

// Uno o varios archivos a la vez (la DGII da uno por solicitud).
async function anLeerArchivoDgii(files) {
  const lista = files instanceof File ? [files] : Array.from(files || []);
  if (!lista.length) return;
  const lector = window.TcDgiiAutorizacion;
  if (!lector) { toast('No se pudo cargar el lector del archivo de la DGII. Recarga la página.', 'error'); return; }
  setText('an-msg', '');
  const varios = lista.length > 1;
  const nombre = varios ? `${lista.length} archivos` : lista[0].name;
  let leido = null;
  try {
    const rangos = await _anAnalizar({
      titulo: 'Analizando la autorización',
      subtitulo: varios ? `${nombre}: ${lista.map((f) => f.name).join(', ')}` : nombre,
      pasos: [varios ? `Leyendo los ${lista.length} archivos de la DGII` : 'Leyendo el archivo de la DGII', 'Buscando los rangos aprobados', 'Comparando con lo que ya tiene el negocio'],
      trabajo: async () => {
        leido = await lector.leerArchivos(lista);
        if (!leido.rangos.length) {
          const detalle = leido.errores.map((e) => (varios ? `${e.archivo}: ${e.mensaje}` : e.mensaje)).join(' | ');
          throw new Error(`No encontré rangos${detalle ? ` (${detalle})` : ''}. Descárgalos de la Oficina Virtual → Consultas → Solicitudes de Comprobantes.`);
        }
        leido.aprobados = lector.aprobados(leido.rangos);
        if (!leido.aprobados.length) throw new Error(varios ? 'Ninguno de los archivos trae un rango aprobado por la DGII todavía.' : 'El archivo no trae ningún rango aprobado por la DGII todavía.');
        return _anClasificarRangos(leido.aprobados, _anExistentes(), _anPosInformaEcf);
      },
      resumen: (r) => {
        const nuevos = r.filter((x) => x.estado === 'nuevo');
        if (nuevos.length) return `Encontré ${_plural(nuevos.length, 'rango nuevo', 'rangos nuevos')}: ${[...new Set(nuevos.map((x) => x.tipo))].join(', ')}.`;
        if (r.some((x) => x.sinConfirmar)) return 'No puedo confirmar los e-NCF: el POS de este negocio necesita actualizarse.';
        return varios ? 'Leí los archivos, pero no hay rangos nuevos para registrar.' : 'Leí el archivo, pero no hay rangos nuevos para registrar.';
      },
    });
    // Para los B, cada archivo va como documento de autorización de sus rangos.
    const adjuntos = {};
    for (const f of lista) adjuntos[f.name] = f.size <= 500 * 1024 ? await _anArchivoComoDataUrl(f) : null;
    _anDgii = {
      nombre,
      varios,
      leidos: leido.aprobados,
      rangos,
      ignorados: leido.rangos.length - leido.aprobados.length,
      errores: leido.errores,
      adjuntos,
    };
    renderAnDgii();
  } catch (_) {
    // El error ya se mostró en la ventana de análisis.
  }
}

function anQuitarArchivoDgii() {
  _anDgii = null;
  renderAnDgii();
}

// Resultado del archivo, en lugar de la zona de subir. Mientras está, el
// formulario a mano se oculta y el botón principal registra estos rangos.
function renderAnDgii() {
  const caja = $id('an-dgii-resultado');
  const drop = $id('an-drop');
  const manual = $id('an-manual');
  const boton = $id('an-btn-guardar');
  const d = _anDgii;
  if (drop) drop.style.display = d ? 'none' : '';
  if (manual) manual.style.display = d ? 'none' : '';
  if (!caja) return;
  if (!d) {
    caja.innerHTML = '';
    if (boton) { boton.textContent = 'Registrar secuencia'; boton.disabled = false; }
    return;
  }
  const nuevos = d.rangos.filter((r) => r.estado === 'nuevo');
  const necesitaVence = nuevos.some((r) => !_ncfEsE(r.tipo) && !NCF_SIN_VENCE.has(r.tipo));
  const negocio = _allClientes.find((c) => c.id === _anNegocioId);
  const filas = d.rangos.map((r) => `
    <div class="an-rango ${r.estado === 'nuevo' || r.sinConfirmar ? '' : 'is-omitido'}">
      <span class="an-rango__tipo">${esc(r.tipo)}</span>
      <div class="an-rango__datos">
        <strong>${esc(NCF_NOMBRES[r.tipo] || r.tipo)}</strong>
        <small>${esc(_ncfFmt(r.tipo, r.desde))} → ${esc(_ncfFmt(r.tipo, r.hasta))} · ${_plural(r.hasta - r.desde + 1, 'comprobante', 'comprobantes')}</small>
        <small>${r.referencia ? `Autorización ${esc(r.referencia)}` : 'Sin Nº de autorización'}${r.fechaAutorizacion ? ` · ${esc(fmtDate(r.fechaAutorizacion))}` : ''}</small>
        ${d.varios && r.archivo ? `<small>Archivo: ${esc(r.archivo)}</small>` : ''}
      </div>
      ${r.sinConfirmar ? '<span class="pill pill-warn">Sin confirmar</span>' : `<span class="pill ${r.estado === 'nuevo' ? 'pill-ok' : r.estado === 'registrado' ? 'pill-neutral' : 'pill-warn'}" title="${esc(r.motivo)}">${r.estado === 'nuevo' ? 'Nuevo' : r.estado === 'registrado' ? 'Ya registrado' : 'No se puede'}</span>`}
      ${r.motivo && !r.sinConfirmar ? `<div class="an-rango__motivo">${esc(r.motivo)}</div>` : ''}
    </div>`).join('');
  const sinConfirmar = d.rangos.some((r) => r.sinConfirmar);
  caja.innerHTML = `
    <div class="an-leido">
      <div class="an-leido__cabeza">
        <div><strong>Lo que autorizó la DGII</strong><small>${esc(d.nombre)}${d.ignorados ? ` · ${_plural(d.ignorados, 'solicitud no aprobada se ignoró', 'solicitudes no aprobadas se ignoraron')}` : ''}</small></div>
        <button type="button" class="btn btn-secondary btn-sm" data-icono="x" onclick="app.anQuitarArchivoDgii()">Quitar</button>
      </div>
      ${sinConfirmar ? `
        <div class="an-aviso" role="note">
          <strong>Este negocio tiene una versión de Tecno Caja que no le informa al portal sus e-NCF.</strong>
          No puedo comprobar si estos rangos E ya están cargados en su POS ni cuántos se usaron, y esa versión
          tampoco los recibe desde aquí. Que actualice Tecno Caja y vuelve a subir el archivo.
        </div>` : ''}
      ${(d.errores || []).length ? `
        <div class="an-aviso" role="note">
          <strong>${d.errores.length === 1 ? 'Un archivo no se pudo leer' : `${d.errores.length} archivos no se pudieron leer`}:</strong>
          ${d.errores.map((e) => `${esc(e.archivo)} (${esc(e.mensaje)})`).join(' · ')}
        </div>` : ''}
      ${filas}
      ${nuevos.length ? `
        ${necesitaVence ? `
          <div class="fm-campo an-leido__vence">
            <label for="an-dgii-vence">Fecha de vencimiento de los NCF (B) *</label>
            <input type="date" id="an-dgii-vence" class="form-input" />
            <div class="fm-ayuda">La que aparece en la autorización de la DGII. Los e-NCF no la necesitan.</div>
          </div>` : ''}
        <label class="an-leido__confirma">
          <input type="checkbox" id="an-dgii-confirma" />
          <span>Esta autorización es de <strong>${esc(negocio?.businessName || 'este negocio')}</strong>${negocio?.rnc ? ` (RNC ${esc(negocio.rnc)})` : ''}.</span>
        </label>` : ''}
    </div>`;
  if (boton) {
    boton.textContent = nuevos.length ? `Registrar ${_plural(nuevos.length, 'rango', 'rangos')}` : 'Nada nuevo que registrar';
    boton.disabled = !nuevos.length;
  }
}

async function registrarRangosDgii() {
  const d = _anDgii;
  const nuevos = (d?.rangos || []).filter((r) => r.estado === 'nuevo');
  if (!nuevos.length) return;
  _fmLimpiar('an-form');
  setText('an-msg', '');
  const vence = $id('an-dgii-vence')?.value || '';
  if ($id('an-dgii-vence') && !vence) { _fmError('an-dgii-vence', 'Indica la fecha de vencimiento que dio la DGII.'); return; }
  if (vence && vence < hoyLocal()) { _fmError('an-dgii-vence', 'Esa fecha ya pasó: la secuencia no se podría usar.'); return; }
  if (!$id('an-dgii-confirma')?.checked) {
    const m = $id('an-msg');
    if (m) { m.textContent = 'Confirma que la autorización es de este negocio.'; m.classList.add('is-error'); }
    return;
  }
  const negocioId = _anNegocioId;
  const branchId = _anSucursalElegida();
  try {
    await _anAnalizar({
      titulo: 'Enviando al POS del negocio',
      subtitulo: `Autorización ${[...new Set(nuevos.map((r) => r.referencia))].join(', ')}`,
      pasos: ['Revisando que no se cruce con lo que ya tiene', 'Guardando la autorización', 'Dejándolo listo para que su POS lo aplique'],
      trabajo: async () => {
        await refreshToken();
        const errores = [];
        for (const r of nuevos) {
          const electronico = _ncfEsE(r.tipo);
          try {
            await apiCall('POST', '/api/ncf-pendientes', {
              businessId: negocioId,
              documentType: r.tipo,
              branchId,
              startNumber: r.desde,
              endNumber: r.hasta,
              authorizationDate: r.fechaAutorizacion || null,
              expirationDate: electronico || NCF_SIN_VENCE.has(r.tipo) ? null : vence,
              authorizationReference: r.referencia,
              notes: `Del archivo de la DGII (${r.archivo || d.nombre}).`,
              // Para los B su archivo es el documento de autorización: con él
              // el POS deja la secuencia activa sin que el dueño la confirme.
              attachmentData: electronico ? null : (d.adjuntos[r.archivo] || null),
            });
          } catch (e) {
            errores.push(`${r.tipo}: ${e.message}`);
          }
        }
        if (errores.length === nuevos.length) throw new Error(errores.join(' | '));
        return errores;
      },
      resumen: (errores) => (errores.length
        ? `Registré una parte. No se pudo: ${errores.join(' | ')}`
        : `Listo: ${[...new Set(nuevos.map((r) => r.tipo))].join(', ')} se aplica${nuevos.length > 1 ? 'n' : ''} en el POS cuando sincronice.`),
    });
    _anDespuesDeRegistrar();
  } catch (_) {
    // El error ya se mostró; lo leído sigue en pantalla.
  }
}

// ── Ventana de análisis (como un asistente) ─────────────────────────────
// Muestra los pasos uno a uno mientras corre `trabajo`; cada paso dura un
// mínimo para que se lea y el último espera a que el trabajo termine.
// Misma idea que la del POS (js/ecf-sequences-config.js).
async function _anAnalizar({ titulo, subtitulo, pasos, trabajo, resumen }) {
  const icono = (nombre, tam) => (window.TcIconos ? window.TcIconos.svg(nombre, tam) : '');
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  const capa = document.createElement('div');
  capa.className = 'an-ia';
  capa.setAttribute('role', 'status');
  capa.innerHTML = `
    <div class="an-ia__panel">
      <div class="an-ia__orbe">${icono('check', 30)}</div>
      <div class="an-ia__titulo">${esc(titulo)}</div>
      <div class="an-ia__sub">${esc(subtitulo || '')}</div>
      <ul class="an-ia__pasos">${pasos.map((p) => `
        <li class="an-ia__paso"><span class="an-ia__punto">${icono('check', 12)}</span><span>${esc(p)}</span></li>`).join('')}
      </ul>
      <div class="an-ia__resultado"></div>
      <div class="an-ia__cerrar"></div>
    </div>`;
  document.body.appendChild(capa);
  const items = Array.from(capa.querySelectorAll('.an-ia__paso'));
  const reducido = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const ritmo = reducido ? 120 : 520;

  let resultado;
  let error = null;
  const tarea = Promise.resolve().then(trabajo).then((v) => { resultado = v; }, (e) => { error = e; });
  for (let i = 0; i < items.length; i += 1) {
    items[i].classList.add('is-activo');
    await (i === items.length - 1 ? Promise.all([tarea, espera(ritmo)]) : espera(ritmo));
    items[i].classList.remove('is-activo');
    if (error && i === items.length - 1) break;
    items[i].classList.add('is-hecho');
  }

  const tituloEl = capa.querySelector('.an-ia__titulo');
  const resultadoEl = capa.querySelector('.an-ia__resultado');
  if (error) {
    capa.classList.add('is-error');
    capa.querySelector('.an-ia__orbe').innerHTML = icono('x', 30);
    const ultimo = items[items.length - 1];
    ultimo.classList.add('is-fallo');
    ultimo.querySelector('.an-ia__punto').innerHTML = icono('x', 12);
    tituloEl.textContent = 'No se pudo completar';
    resultadoEl.classList.add('is-escrito');
    resultadoEl.textContent = error.message || String(error);
    await new Promise((resolve) => {
      const cerrar = capa.querySelector('.an-ia__cerrar');
      cerrar.innerHTML = '<button type="button" class="btn btn-secondary">Cerrar</button>';
      cerrar.querySelector('button').addEventListener('click', resolve, { once: true });
    });
    capa.remove();
    throw error;
  }

  capa.classList.add('is-listo');
  tituloEl.textContent = 'Listo';
  const texto = typeof resumen === 'function' ? resumen(resultado) : (resumen || '');
  // El resumen se escribe letra por letra, como la respuesta de un asistente.
  for (let i = 1; i <= texto.length; i += 1) {
    resultadoEl.textContent = texto.slice(0, i);
    await espera(reducido ? 0 : 14);
  }
  resultadoEl.classList.add('is-escrito');
  await espera(reducido ? 300 : 1100);
  capa.remove();
  return resultado;
}

// ── Ficha del negocio: Comprobantes fiscales ─────────────────────────────
async function cargarComprobantesNegocio(id) {
  const caja = $id('det-comprobantes');
  if (!caja) return;
  try {
    await refreshToken();
    const [aplicadas, pendientes, cliente] = await Promise.all([
      apiCall('GET', `/api/ncf-aplicadas/${id}`),
      apiCall('GET', `/api/ncf-pendientes/${id}`),
      apiCall('GET', `/api/clientes/${id}`).catch(() => null),
    ]);
    if (_currentClienteId !== id) return;
    caja.innerHTML = _comprobantesNegocioHtml(aplicadas || [], pendientes || [], cliente ? _posInformaEcf(cliente) : null);
  } catch (e) {
    caja.innerHTML = `<p style="color:var(--text-muted)">No se pudieron cargar los comprobantes: ${esc(e.message)}</p>`;
  }
}

function _comprobantesNegocioHtml(aplicadas, pendientes, posInformaEcf = null) {
  const enCola = pendientes.filter((n) => (n.action || 'create') === 'create' && ['pendiente', 'error'].includes(n.status));
  const aviso = posInformaEcf === false
    ? '<div class="an-aviso" role="note">Este negocio tiene una versión de Tecno Caja que no le informa al portal sus e-NCF: aquí solo se ven sus NCF (B). Cuando actualice, aparecen también las E con lo usado.</div>'
    : '';
  if (!aplicadas.length && !enCola.length) {
    return `${aviso}<p class="detc-vacio">Este negocio todavía no tiene secuencias en su POS. Sube la autorización de la DGII con "Registrar comprobantes".</p>`;
  }
  const fila = (tipo, cuerpo, pill) => `
    <div class="detc-item">
      <span class="detc-tipo">${esc(tipo)}</span>
      <div class="detc-datos">${cuerpo}</div>
      ${pill}
    </div>`;
  const filasCola = enCola.map((n) => fila(n.documentType,
    `<strong>${esc(NCF_NOMBRES[n.documentType] || n.documentType)}</strong>
     <small>${esc(_ncfFmt(n.documentType, n.startNumber))} → ${esc(_ncfFmt(n.documentType, n.endNumber))}${n.status === 'error' && n.errorMessage ? ` · ${esc(n.errorMessage)}` : ''}</small>`,
    n.status === 'error' ? '<span class="pill pill-bad">Error</span>' : '<span class="pill pill-info">Por aplicar</span>'));
  const filasPos = aplicadas.map((s) => {
    const e = _ncfEstado(s);
    return fila(s.documentType,
      `<strong>${esc(NCF_NOMBRES[s.documentType] || s.documentName || s.documentType)}</strong>
       <small>${esc(_ncfFmt(s.documentType, s.startNumber))} → ${esc(_ncfFmt(s.documentType, s.endNumber))} · ${_plural(Math.max(0, e.total - e.quedan), 'usado', 'usados')} · quedan ${Number(e.quedan).toLocaleString('es-DO')}${s.branchName && s.branchName !== 'Global' ? ` · ${esc(s.branchName)}` : ''}</small>`,
      `<span class="pill ${e.pill}">${esc(e.etiqueta)}</span>`);
  });
  return `${aviso}<div class="detc-lista">${[...filasCola, ...filasPos].join('')}</div>`;
}

// ── Reportes: comprobantes activos del negocio ──────────────────────────
// Los que su POS puede usar ahora (B y e-NCF, del espejo ncf_aplicadas),
// primero los que se están acabando, y los registrados desde aquí que el
// POS todavía no aplica.
async function cargarComprobantesActivos(id) {
  const caja = $id('rep-comprobantes');
  if (!caja || !id) return;
  try {
    await refreshToken();
    const [aplicadas, pendientes] = await Promise.all([
      apiCall('GET', `/api/ncf-aplicadas/${id}`),
      apiCall('GET', `/api/ncf-pendientes/${id}`),
    ]);
    if (_repNegocioId !== id) return;
    const r = _comprobantesActivos(aplicadas || [], pendientes || []);
    setText('rs-comprobantes', String(r.activas.length));
    setText('rep-comprobantes-sub', r.resumen);
    caja.innerHTML = _comprobantesActivosHtml(r, _repPosInformaEcf);
  } catch (e) {
    setText('rs-comprobantes', '—');
    caja.innerHTML = `<p class="detc-vacio">No se pudieron cargar los comprobantes: ${esc(e.message)}</p>`;
  }
}

function _comprobantesActivos(aplicadas, pendientes) {
  const lista = aplicadas.map((s) => ({ s, e: _ncfEstado(s) }));
  const activas = lista.filter((x) => x.e.activa)
    .sort((a, b) => (b.e.alertas.length - a.e.alertas.length)
      || String(a.s.documentType).localeCompare(String(b.s.documentType))
      || Number(a.s.startNumber) - Number(b.s.startNumber));
  const enCola = pendientes.filter((n) => (n.action || 'create') === 'create' && n.status === 'pendiente');
  const alerta = activas.filter((x) => x.e.alertas.length).length;
  const inactivas = lista.length - activas.length;
  const resumen = [
    _plural(activas.length, 'activa', 'activas'),
    alerta ? `${alerta} por agotarse o vencer` : '',
    enCola.length ? `${enCola.length} por aplicar` : '',
    inactivas ? `${inactivas} agotada${inactivas === 1 ? '' : 's'}, vencida${inactivas === 1 ? '' : 's'} o desactivada${inactivas === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ');
  return { activas, enCola, inactivas, resumen };
}

function _comprobantesActivosHtml({ activas, enCola, inactivas }, posInformaEcf = null) {
  const aviso = posInformaEcf === false
    ? '<div class="an-aviso" role="note" style="margin-bottom:10px">Este negocio tiene una versión de Tecno Caja que no le informa al portal sus e-NCF: aquí solo se ven sus NCF (B). Cuando actualice, aparecen también las E.</div>'
    : '';
  if (!activas.length && !enCola.length) {
    return `${aviso}<p class="detc-vacio">El POS de este negocio no tiene comprobantes activos${inactivas ? ' (las que tiene están agotadas, vencidas o desactivadas)' : ''}. Súbele la autorización de la DGII con "Registrar comprobantes".</p>`;
  }
  const tarjetas = activas.map(({ s, e }) => {
    const tipo = s.documentType;
    const barra = e.pct < 0.10 ? 'is-bad' : e.pct < 0.25 ? 'is-warn' : '';
    const vence = s.expirationDate
      ? `${_fmtFechaSolo(s.expirationDate)}${e.diasVence !== null && e.diasVence >= 0 ? ` · en ${_plural(e.diasVence, 'día', 'días')}` : ''}`
      : (_ncfEsE(tipo) || NCF_SIN_VENCE.has(tipo) ? 'No vence' : '—');
    const lugar = s.branchName && s.branchName !== 'Global' ? ` · ${esc(s.branchName)}` : '';
    return `<div class="ncf-card ${e.alertas.length ? 'is-alerta' : ''}">
      <div class="ncf-card__cabeza">
        <div class="ncf-card__tipo">${esc(tipo)} · ${esc(NCF_NOMBRES[tipo] || s.documentName || '')}<small>${_ncfEsE(tipo) ? 'Comprobante electrónico' : 'Comprobante fiscal'}${lugar}</small></div>
        <span class="pill ${e.pill}">${e.etiqueta}</span>
      </div>
      <dl class="ncf-datos">
        <dt>Próximo</dt><dd><code>${_ncfFmt(tipo, s.nextNumber)}</code></dd>
        <dt>Rango</dt><dd><code>${_ncfFmt(tipo, s.startNumber)} – ${_ncfFmt(tipo, s.endNumber)}</code></dd>
        <dt>Vence</dt><dd>${esc(vence)}</dd>
      </dl>
      <div class="ncf-barra ${barra}" role="progressbar" aria-valuemin="0" aria-valuemax="${e.total}" aria-valuenow="${e.quedan}"><span style="width:${Math.round(e.pct * 100)}%"></span></div>
      <div class="ncf-barra__txt"><span>Quedan ${e.quedan.toLocaleString('es-DO')} de ${e.total.toLocaleString('es-DO')}</span><span>${Math.round(e.pct * 100)}%</span></div>
      ${e.alertas.map((a) => `<div class="ncf-alerta">${esc(a)}</div>`).join('')}
    </div>`;
  });
  const porAplicar = enCola.map((n) => `<div class="ncf-card is-inactiva">
      <div class="ncf-card__cabeza">
        <div class="ncf-card__tipo">${esc(n.documentType)} · ${esc(NCF_NOMBRES[n.documentType] || '')}<small>Registrado desde el portal</small></div>
        <span class="pill pill-info">Por aplicar</span>
      </div>
      <dl class="ncf-datos">
        <dt>Rango</dt><dd><code>${_ncfFmt(n.documentType, n.startNumber)} – ${_ncfFmt(n.documentType, n.endNumber)}</code></dd>
        <dt>Autorización</dt><dd>${esc(n.authorizationReference || '—')}</dd>
      </dl>
      <div class="ncf-alerta">Se aplica cuando el POS del negocio sincronice.</div>
    </div>`);
  return `${aviso}<div class="ncf-cards">${[...tarjetas, ...porAplicar].join('')}</div>`;
}

// "Ver secuencias": Reportes → ese negocio → ITBIS / DGII (editar o suspender los B).
function verSecuenciasNegocio(id) {
  if (!id) return;
  _repNegocioId = id;
  goto('reportes');
  abrirRepDetalle('itbis');
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
    listEl.innerHTML = `<div class="rep-no-sync-sub" style="padding:8px 0">Todavía no hay secuencias en el POS de este negocio.</div>`;
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
            <td><span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;color:#fff;background:${colores[s.effectiveStatus] || colores[s.status] || '#6b7280'}">${s.readOnly && s.status === 'suspendido' ? 'Desactivada' : (ESTADO_LABELS[s.effectiveStatus] || ESTADO_LABELS[s.status] || s.effectiveStatus || s.status)}</span></td>
            <td style="white-space:nowrap">
              ${s.readOnly ? '<span class="rep-no-sync-sub" title="Las e-NCF se editan o desactivan en el POS: Configuración → Secuencias de Comprobantes Electrónicos">e-NCF · se maneja en el POS</span>' : `
              <button class="btn btn-sm btn-secondary" data-icono="pencil" onclick="app.abrirEditarNcfModal('${s.id}')">Editar</button>
              ${s.status === 'activo' ? `<button class="btn btn-sm btn-secondary" data-icono="circle-pause" onclick="app.abrirSuspenderNcfModal('${s.id}')">Suspender</button>` : ''}
              <button class="btn-icono is-danger" data-icono="trash-2" title="Eliminar" aria-label="Eliminar" onclick="app.eliminarNcfAplicada('${s.id}')"></button>`}
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
  _fmLimpiar('ane-form');
  $id('ane-titulo').textContent = `Editar ${_ncfFmt(seq.documentType, seq.startNumber)} – ${_ncfFmt(seq.documentType, seq.endNumber)}`;
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
  const seq = _ncfAplicadas.find((s) => String(s.id) === String(_ncfEditTargetId));
  const hasta = Number($id('ane-hasta')?.value || 0);
  _fmLimpiar('ane-form');
  if (seq) {
    const usado = Math.max(Number(seq.startNumber), Number(seq.nextNumber || seq.startNumber) - 1);
    const err = _ncfValidar({ tipo: seq.documentType, desde: seq.startNumber, hasta, existentes: _ncfAplicadas, excluirId: seq.id, editando: true });
    if (!err.hasta && hasta < usado) err.hasta = `Ya se usaron hasta el ${_ncfFmt(seq.documentType, usado)}: el final no puede ser menor.`;
    if (err.hasta) { _fmError('ane-hasta', err.hasta); return; }
  }
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
  setTimeout(() => { loadNcfAplicadas(); loadNcfPendientes(); cargarComprobantesActivos(_repNegocioId); }, 4000);
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

// Colores de las gráficas según el modo día/noche (Chart.js no lee el CSS):
// salen de los tokens de contadores.css.
function _coloresGrafico() {
  const css = getComputedStyle(document.documentElement);
  const v = (nombre, porDefecto) => css.getPropertyValue(nombre).trim() || porDefecto;
  return {
    texto:   v('--text-sub', '#8fa3c2'),
    rejilla: v('--chart-grid', 'rgba(71,100,148,0.12)'),
    fondo:   v('--surface', '#1a2234'),
    titulo:  v('--text', '#e8edf5'),
    borde:   v('--border', 'rgba(71,100,148,.4)'),
  };
}

// Al cambiar de modo, las gráficas abiertas toman los colores nuevos.
function _aplicarTemaGraficos() {
  const c = _coloresGrafico();
  [_repChart, _ctbIndChart].forEach((chart) => {
    if (!chart) return;
    const o = chart.options;
    Object.values(o.scales || {}).forEach((eje) => {
      if (eje.ticks) eje.ticks.color = c.texto;
      if (eje.grid && eje.grid.display !== false) eje.grid.color = c.rejilla;
    });
    if (o.plugins?.legend?.labels) o.plugins.legend.labels.color = c.texto;
    if (o.plugins?.tooltip) {
      Object.assign(o.plugins.tooltip, { backgroundColor: c.fondo, titleColor: c.titulo, bodyColor: c.texto, borderColor: c.borde });
    }
    chart.update('none');
  });
}
window.TemaPortal?.alCambiar(_aplicarTemaGraficos);

async function cargarChartVentas(branchId) {
  if (!_repNegocioId) return;
  try {
    const params = new URLSearchParams({ tab: 'ventas' });
    if (branchId) params.set('branchId', branchId);
    const data = await apiCall('GET', `/api/reportes/${_repNegocioId}/datos?${params}`);
    _repVentasRows = data.rows || [];
    renderRepChart(_repVentasRows);
  } catch { /* chart not critical */ }
}

// Deriva Ventas hoy/mes, facturas e ITBIS a partir de las filas del tab
// 'ventas' (ventana móvil de últimos 30 días), ya filtradas por sucursal en
// el backend. Es "best effort": si el mes en curso lleva más de 30 días
// (nunca pasa en un mes calendario), el día 1 podría quedar fuera de la
// ventana — aceptable para esta vista filtrada por sucursal.
function computeSalesStatsFromRows(rows) {
  const todayStr = hoyLocal();
  const monthStr = todayStr.slice(0, 7);
  let ventasHoy = 0, ventasMes = 0, itbisMes = 0, facturasEmitidas = 0;
  for (const r of rows) {
    const fecha = (r.fecha || '').slice(0, 10);
    if (!fecha) continue;
    const total = Number(r.total) || 0;
    if (fecha === todayStr) ventasHoy += total;
    if (fecha.slice(0, 7) === monthStr) {
      ventasMes += total;
      itbisMes += Number(r.itbis) || 0;
      facturasEmitidas += 1;
    }
  }
  return { ventasHoy, ventasMes, itbisMes, facturasEmitidas };
}

// Ventas hoy/mes, Facturas e ITBIS se calculan SIEMPRE desde las mismas
// filas que pinta el gráfico (tab 'ventas', últimos 30 días) — no desde
// posStats, el agregado que sincroniza el POS aparte. Los dos se escriben en
// llamadas de red separadas y pueden quedar desfasados si una venta llega
// justo entre medio, mostrando una tarjeta con un monto viejo mientras el
// gráfico (más fresco) ya incluye la venta nueva. Productos vendidos/Bajo
// inventario/Cuentas × cobrar sí vienen de posStats — no son sumas por
// fecha, son el estado actual, y no hay desglose por sucursal sincronizado
// todavía para esos tres.
async function actualizarStatsPorSucursal() {
  const branchId = $id('rep-f-sucursal')?.value || '';
  await cargarChartVentas(branchId || undefined);
  renderRepStats({ ...(_repStatsGlobal || {}), ...computeSalesStatsFromRows(_repVentasRows) }, _repHasPosData);
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
  const col = _coloresGrafico();
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
          backgroundColor: col.fondo,
          titleColor: col.titulo,
          bodyColor: col.texto,
          borderColor: col.borde,
          borderWidth: 1,
        },
      },
      scales: {
        x: {
          ticks: { color: col.texto, font: { size: 10 }, maxRotation: 0, minRotation: 0, autoSkip: true, maxTicksLimit: 7 },
          grid:  { display: false },
          border: { display: false },
        },
        y: {
          ticks: {
            color: col.texto, font: { size: 10 }, maxTicksLimit: 4,
            callback: v => 'RD$ ' + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v),
          },
          grid: { color: col.rejilla, borderDash: [4, 4] },
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
  setText('rmd-subtitulo', [neg?.propietario ? 'Propietario: ' + neg.propietario : '', neg?.rnc ? 'RNC ' + neg.rnc : '', neg ? _planTexto(neg) : '']
    .filter(Boolean).join('  ·  '));
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

// PDF, CSV y Excel llevan la tabla tal cual, menos la columna de botones (Editar/Eliminar).
function _copiaSinAcciones(el) {
  const copia = el.cloneNode(true);
  copia.querySelectorAll('tr').forEach((tr) => {
    const ultima = tr.lastElementChild;
    if (ultima && (ultima.querySelector('.rep-acc') || /^acciones$/i.test(ultima.textContent.trim()))) ultima.remove();
  });
  return copia;
}

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
    h2{font-size:13px;color:var(--text-muted,#5a7099);font-weight:400}
    .badge{display:inline-block;background:#3b82f6;color:#fff;font-size:10px;font-weight:700;padding:3px 10px;border-radius:20px;letter-spacing:.3px;text-transform:uppercase}
    table{width:100%;border-collapse:collapse;margin-top:4px}
    th{background:#3b82f6;color:#fff;padding:7px 10px;font-size:10px;text-align:left;text-transform:uppercase;letter-spacing:.3px}
    td{padding:6px 10px;border-bottom:1px solid #e2e8f0;font-size:11px;vertical-align:middle}
    tr:nth-child(even) td{background:#f8fafc}
    .td-nombre{font-weight:600}
    .td-amount{text-align:right;white-space:nowrap}
    .footer{text-align:center;font-size:10px;color:#94a3b8;margin-top:16px;padding-top:10px;border-top:1px solid #e2e8f0}
  </style></head><body>
  <div class="hdr">
    <div>
      <h1>${esc(neg?.businessName || '—')}</h1>
      <h2>RNC: ${neg?.rnc || '—'} · Plan: ${neg?.planCode || '—'}</h2>
    </div>
    <div style="text-align:right">
      <div class="badge">${title}</div>
      <div style="font-size:11px;color:var(--text-muted,#5a7099);margin-top:5px">Generado: ${fecha}</div>
    </div>
  </div>
  ${_copiaSinAcciones(tableEl).innerHTML}
  <div class="footer">Tecno Caja Contadores — Portal de Contadores Asociados</div>
  </body></html>`;

  const slug = (neg?.businessName || 'negocio').replace(/\s+/g, '_').slice(0, 30);
  const filename = `${slug}_${_repTab}_${hoyLocal()}.pdf`;
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
    h3{font-size:13px;color:var(--text-muted,#5a7099);font-weight:400}
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
    <div style="text-align:right;font-size:11px;color:var(--text-muted,#5a7099)">
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
  const filename = `${slug}_reporte_mensual_${hoyLocal().slice(0, 7)}.pdf`;
  await _savePdf(html, filename, false);
}

// ══════════════════════════════════════════════════════════════════════
// FACTURACIÓN
// ══════════════════════════════════════════════════════════════════════

let _facFacturas  = [];
let _facClientes  = [];
let _facCurId     = null;
let _facCurData   = null;
let _facItems     = [];
let _facEditId    = null;   // id de la factura en edición (null = nueva)

let _cotCotizaciones = [];
let _cotClientes     = [];
let _cotItems         = [];
let _cotEditId        = null;   // id de la cotización en edición (null = nueva)
let _envioCot         = null;   // { id, data } — cotización en curso de envío por correo

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
    parcial:   'Pago parcial',
    pagada:    'Pagada',
    anulada:   'Anulada',
  };
  const lbl = map[estado] || estado || '—';
  return `<span class="fac-estado ${estado || 'pendiente'}">${lbl}</span>`;
}

async function loadFacturacion() {
  try {
    _facFacturas = await apiCall('GET', '/api/facturacion/facturas');
  } catch (e) {
    _facFacturas = [];
    toast('No se pudieron cargar las facturas: ' + e.message, 'error');
  }
  facRInit();
}

// ── Reporte de facturación en PDF — mismo estilo que el POS ────────────
// (banda morada #6C63FF, tablas con cabecera lila y filas alternas). Usa
// jsPDF (vendor/jspdf, ya incluido en index.html) y descarga el archivo,
// igual que los reportes del POS.
function _repPdfHeader(doc, title, periodo) {
  const firma = _perfil?.nombre_firma || _perfil?.responsable || 'Tecno Caja Contadores';
  const rnc   = _perfil?.rnc || '';
  doc.setFillColor(108, 99, 255);
  doc.rect(0, 0, 210, 22, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(13); doc.setFont(undefined, 'bold');
  doc.text(String(firma).slice(0, 60), 14, 10);
  doc.setFontSize(8); doc.setFont(undefined, 'normal');
  doc.text(`RNC: ${rnc || '—'}  |  ${title}`, 14, 16);
  doc.text(`Período: ${periodo}  |  Generado: ${new Date().toLocaleDateString('es-DO')}`, 14, 21);
  doc.setTextColor(30, 36, 53);
  return 28;
}

function _repPdfTable(doc, y, headers, rows, colWidths) {
  const pageW = 210, padL = 14, rowH = 7;
  doc.setFillColor(240, 243, 255);
  doc.rect(padL, y, pageW - padL * 2, rowH, 'F');
  doc.setFontSize(7); doc.setFont(undefined, 'bold'); doc.setTextColor(100, 100, 130);
  let x = padL;
  headers.forEach((h, i) => { doc.text(String(h), x + 2, y + 5); x += colWidths[i]; });
  y += rowH;
  doc.setFont(undefined, 'normal'); doc.setTextColor(30, 36, 53);
  rows.forEach((row, ri) => {
    if (y > 275) { doc.addPage(); y = 14; }
    if (ri % 2 === 0) { doc.setFillColor(248, 249, 255); doc.rect(padL, y, pageW - padL * 2, rowH, 'F'); }
    x = padL;
    row.forEach((cell, i) => { doc.text(String(cell ?? ''), x + 2, y + 5); x += colWidths[i]; });
    y += rowH;
  });
  doc.setDrawColor(200, 204, 220);
  doc.line(padL, y, pageW - padL, y);
  return y + 4;
}

// ══════════════════════════════════════════════════════════════════════
// MÓDULO DE REPORTES DE FACTURACIÓN — pestañas estilo POS (reportes-v2)
// 100% cliente sobre _facFacturas. Pestañas: Dashboard · Detallados · DGII · Exportar.
// ══════════════════════════════════════════════════════════════════════
let _facR = { tab: 'facturas', sub: 'cliente', periodo: 'mes', desde: '', hasta: '',
              estado: '', metodo: '', tipo: '', facMetodo: '', page: 1 };
const FACR_PAGE = 50;
const FACR_ESTADO_LBL = { pendiente: 'Pendiente', parcial: 'Pago parcial', pagada: 'Pagada', anulada: 'Anulada' };
const FACR_NCF_DESC = { B01: 'Crédito Fiscal', B02: 'Consumidor Final', B03: 'Nota de Débito', B04: 'Nota de Crédito',
  B11: 'Comprobante de Compras', B12: 'Registro Único de Ingresos', B13: 'Gastos Menores',
  B14: 'Régimen Especial', B15: 'Gubernamental', B16: 'Exportaciones', B17: 'Pagos al Exterior' };
const _facN = v => Number(v || 0);
const _facRMoneyPdf = v => 'RD$ ' + _facN(v).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function _facRMetodoLabel(m) {
  return { efectivo: 'Efectivo', transferencia: 'Transferencia', tarjeta: 'Tarjeta', cheque: 'Cheque', deposito: 'Depósito', otro: 'Otro' }[m] || m || '—';
}
function _facRNcfLabel(t) { return FACR_NCF_DESC[t] || t || '—'; }
function _facRPeriodoLabel() {
  const map = { hoy: 'Hoy', ayer: 'Ayer', semana: 'Esta semana', mes: 'Este mes', mes_pasado: 'Mes pasado', anio: 'Este año', custom: 'Personalizado' };
  return `${map[_facR.periodo] || _facR.periodo} (${_facR.desde || '—'} a ${_facR.hasta || '—'})`;
}

function facRInit() {
  const per = $id('facr-periodo');
  if (per && !per.value) per.value = _facR.periodo;
  _facR.facMetodo = ''; _facR.page = 1;
  facROnPeriodoChange();
  facRCalcRange();
  facRSwitchSubtab(_facR.sub);   // deja marcada la sub-pestaña sin renderizar aún
  facRSwitchTab(_facR.tab);
}

function facROnPeriodoChange() {
  const custom = $id('facr-custom');
  if (custom) custom.classList.toggle('hidden', ($id('facr-periodo')?.value || 'mes') !== 'custom');
}

function facRCalcRange() {
  const p = $id('facr-periodo')?.value || 'mes';
  _facR.periodo = p;
  const pad = n => String(n).padStart(2, '0');
  const local = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const now = new Date();
  let desde = '', hasta = '';
  if (p === 'custom') { desde = $id('facr-desde')?.value || ''; hasta = $id('facr-hasta')?.value || ''; }
  else if (p === 'hoy') { desde = hasta = local(now); }
  else if (p === 'ayer') { const d = new Date(now); d.setDate(d.getDate() - 1); desde = hasta = local(d); }
  else if (p === 'semana') { const d = new Date(now); d.setDate(d.getDate() - 6); desde = local(d); hasta = local(now); }
  else if (p === 'mes') { desde = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`; hasta = local(now); }
  else if (p === 'mes_pasado') {
    desde = local(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    hasta = local(new Date(now.getFullYear(), now.getMonth(), 0));
  } else if (p === 'anio') { desde = `${now.getFullYear()}-01-01`; hasta = local(now); }
  _facR.desde = desde; _facR.hasta = hasta;
  _facR.estado = $id('facr-estado')?.value || '';
  _facR.metodo = $id('facr-metodo')?.value || '';
  _facR.tipo   = $id('facr-tipo')?.value || '';
}

function facRFiltered() {
  let l = _facFacturas.slice();
  if (_facR.desde) l = l.filter(f => (f.fecha || '') >= _facR.desde);
  if (_facR.hasta) l = l.filter(f => (f.fecha || '') <= _facR.hasta);
  if (_facR.estado) l = l.filter(f => (f.estado || 'pendiente') === _facR.estado);
  if (_facR.metodo) l = l.filter(f => (f.metodo_pago || 'efectivo') === _facR.metodo);
  if (_facR.tipo)   l = l.filter(f => (f.tipo_ncf || '') === _facR.tipo);
  return l;
}

function facRApply() { facRCalcRange(); _facR.page = 1; facRRenderActive(); }

function facRSwitchTab(tab) {
  _facR.tab = tab;
  document.querySelectorAll('#facr-tabs .rep-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['facturas', 'agrupados', 'dgii', 'exportar'].forEach(t => {
    const p = $id('facr-pane-' + t); if (p) p.classList.toggle('hidden', t !== tab);
  });
  facRRenderActive();
}

function facRSwitchSubtab(sub) {
  _facR.sub = sub; _facR.page = 1;
  document.querySelectorAll('#facr-subtabs .facr-subtab').forEach(b => b.classList.toggle('active', b.dataset.sub === sub));
  ['cliente', 'tipo', 'metodo', 'estado'].forEach(s => {
    const p = $id('facr-sub-' + s); if (p) p.classList.toggle('hidden', s !== sub);
  });
  if (_facR.tab === 'agrupados') facRRenderGroup(sub);
}

function facRRenderActive() {
  facRRenderKpis();
  if (_facR.tab === 'facturas') facRRenderFacturas();
  else if (_facR.tab === 'agrupados') facRRenderGroup(_facR.sub);
  else if (_facR.tab === 'dgii') facRRenderDGII();
}

const _facSaldo = (f) => Math.max(0, _facN(f.balance ?? (_facN(f.total) - _facN(f.monto_pagado))));
const _facCobrable = (f) => ['pendiente', 'parcial'].includes(f.estado || 'pendiente');
// Días desde la emisión (fecha "AAAA-MM-DD" de aquí, no UTC).
function _facDiasDesde(fecha) { return Math.max(0, -(_diasHasta(fecha) ?? 0)); }

// ── Tarjetas de arriba (mismo filtro que la tabla) ─────────────────────
function facRRenderKpis() {
  const list = facRFiltered();
  const vig  = list.filter(f => (f.estado || 'pendiente') !== 'anulada');
  const totalFact = vig.reduce((s, f) => s + _facN(f.total), 0);
  const itbis     = vig.reduce((s, f) => s + _facN(f.itbis_total), 0);
  const cobrado   = vig.reduce((s, f) => s + _facN(f.monto_pagado), 0);
  const base      = vig.reduce((s, f) => s + _facN(f.subtotal) - _facN(f.descuento_total), 0);
  const pendientes = vig.filter(_facCobrable);
  const porCobrar = pendientes.reduce((s, f) => s + _facSaldo(f), 0);
  const viejo = pendientes.filter(f => _facDiasDesde(f.fecha) > 30).reduce((s, f) => s + _facSaldo(f), 0);
  const tipos = [...new Set(vig.map(f => f.tipo_ncf).filter(Boolean))];

  const lblPer = { hoy: 'Facturado hoy', ayer: 'Facturado ayer', semana: 'Facturado esta semana', mes: 'Facturado este mes',
    mes_pasado: 'Facturado el mes pasado', anio: 'Facturado este año', custom: 'Facturado en el período' };
  setText('facx-k-fact-lbl', lblPer[_facR.periodo] || 'Facturado');
  setText('facx-k-fact', fmtMoney(totalFact));
  setText('facx-k-fact-sub', vig.length ? `${_plural(vig.length, 'factura', 'facturas')}${tipos.length ? ' · ' + tipos.join(', ') : ''}` : 'Sin facturas en el período');
  setText('facx-k-cob', fmtMoney(cobrado));
  setText('facx-k-cob-sub', totalFact > 0 ? `${Math.round((cobrado / totalFact) * 100)}% del facturado` : '—');
  setText('facx-k-pend', fmtMoney(porCobrar));
  setText('facx-k-pend-sub', !pendientes.length ? 'Nada pendiente'
    : viejo > 0.009 ? `${fmtMoney(viejo)} con más de 30 días` : 'Todo en 0–30 días');
  setText('facx-k-itbis', fmtMoney(itbis));
  setText('facx-k-itbis-sub', `Base gravada ${fmtMoney(base)}`);
}

function facRRenderFacturas() {
  let rows = facRFiltered();
  if (_facR.facMetodo) rows = rows.filter(f => (f.metodo_pago || 'efectivo') === _facR.facMetodo);
  const pages = Math.max(1, Math.ceil(rows.length / FACR_PAGE));
  if (_facR.page > pages) _facR.page = pages;
  const slice = rows.slice((_facR.page - 1) * FACR_PAGE, _facR.page * FACR_PAGE);

  // Montos sin "RD$" en la tabla (el encabezado ya lo dice).
  const mm = v => _facN(v).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  setText('facr-fac-count', `${rows.length} factura${rows.length === 1 ? '' : 's'}`);
  const conRecibo = reciboConfig().activo;
  const tb = $id('facr-fac-tbody');
  if (tb) {
    tb.innerHTML = slice.length ? slice.map(f => {
      const base = _facN(f.subtotal) - _facN(f.descuento_total);
      const cobrable = _facCobrable(f);
      const dias = _facDiasDesde(f.fecha);
      const antig = cobrable ? `<span class="pill ${dias > 60 ? 'pill-bad' : dias > 30 ? 'pill-warn' : 'pill-neutral'}">${_plural(dias, 'día', 'días')}</span>` : '<span class="text-muted">—</span>';
      return `<tr>
        <td class="facx-ncf">${esc(facNcfDisplay(f.ncf))}</td>
        <td>${fmtDate(f.fecha)}</td>
        <td title="${esc(f.cliente?.nombre || '')}"><div class="facx-cli">${esc(f.cliente?.nombre || '—')}</div><div class="facx-rnc">${f.cliente?.rnc ? 'RNC ' + esc(f.cliente.rnc) : 'Sin RNC'}</div></td>
        <td class="is-num">${mm(base)}</td>
        <td class="is-num">${mm(f.itbis_total)}</td>
        <td class="is-num" style="font-weight:700">${mm(f.total)}</td>
        <td>${facEstadoBadge(f.estado)}</td>
        <td>${antig}</td>
        <td><div class="facx-acc">
          ${cobrable ? `<button class="btn btn-secondary btn-sm" data-icono="banknote" onclick="app.registrarCobroLista('${f.id}')" title="Registrar cobro · saldo RD$ ${mm(_facSaldo(f))}">Cobrar</button>` : ''}
          ${conRecibo && f.estado !== 'anulada' && _reciboPagos(f).length ? `<button class="btn-icono" title="Imprimir el recibo del último pago" aria-label="Imprimir recibo" data-icono="printer" onclick="app.reciboFacturaLista('${f.id}')"></button>` : ''}
          <button class="btn-icono" title="Descargar PDF" aria-label="Descargar PDF" data-icono="download" onclick="app.pdfFacturaLista('${f.id}')"></button>
          <button class="btn-icono" title="Ver factura" aria-label="Ver factura" data-icono="eye" onclick="app.verFactura('${f.id}')"></button>
        </div></td>
      </tr>`;
    }).join('') : '<tr><td colspan="9" class="td-empty">Sin facturas en el período seleccionado.</td></tr>';
  }

  const tf = $id('facr-fac-tfoot');
  if (tf) {
    if (rows.length) {
      const sB = rows.reduce((s, f) => s + (_facN(f.subtotal) - _facN(f.descuento_total)), 0);
      const sI = rows.reduce((s, f) => s + _facN(f.itbis_total), 0);
      const sT = rows.reduce((s, f) => s + _facN(f.total), 0);
      tf.innerHTML = `<tr>
        <td colspan="3">Totales · ${rows.length} factura${rows.length === 1 ? '' : 's'}${pages > 1 ? ` · pág. ${_facR.page}/${pages}` : ''}</td>
        <td class="is-num">${mm(sB)}</td>
        <td class="is-num">${mm(sI)}</td>
        <td class="is-num">${mm(sT)}</td>
        <td colspan="3"></td>
      </tr>`;
    } else tf.innerHTML = '';
  }

  const pg = $id('facr-fac-pager');
  if (pg) {
    if (pages <= 1) { pg.innerHTML = ''; return; }
    const btns = [];
    if (_facR.page > 1) btns.push(`<button class="facr-page-btn" onclick="app.facRFacPage(${_facR.page - 1})">‹</button>`);
    const start = Math.max(1, _facR.page - 2), end = Math.min(pages, start + 4);
    for (let i = start; i <= end; i++) btns.push(`<button class="facr-page-btn${i === _facR.page ? ' active' : ''}" onclick="app.facRFacPage(${i})">${i}</button>`);
    if (_facR.page < pages) btns.push(`<button class="facr-page-btn" onclick="app.facRFacPage(${_facR.page + 1})">›</button>`);
    pg.innerHTML = btns.join('');
  }
}
function facRFacPage(p) { _facR.page = p; facRRenderFacturas(); }
function facRFacMetodo(v) { _facR.facMetodo = v; _facR.page = 1; facRRenderFacturas(); }

function _facRGroupData(kind) {
  const list = facRFiltered();
  const m = {};
  list.forEach(f => {
    let key;
    if (kind === 'cliente') key = f.cliente?.nombre || '—';
    else if (kind === 'tipo') key = f.tipo_ncf || '—';
    else if (kind === 'metodo') key = f.metodo_pago || 'efectivo';
    else key = f.estado || 'pendiente';
    if (!m[key]) m[key] = { key, n: 0, base: 0, itbis: 0, total: 0, rnc: f.cliente?.rnc || '' };
    m[key].n += 1;
    m[key].base  += _facN(f.subtotal) - _facN(f.descuento_total);
    m[key].itbis += _facN(f.itbis_total);
    m[key].total += _facN(f.total);
  });
  const rows = Object.values(m).sort((a, b) => b.total - a.total);
  const gt = rows.reduce((s, r) => s + r.total, 0);
  rows.forEach(r => { r.pct = gt > 0 ? (r.total / gt * 100) : 0; });
  return { rows, totals: {
    n: rows.reduce((s, r) => s + r.n, 0),
    base: rows.reduce((s, r) => s + r.base, 0),
    itbis: rows.reduce((s, r) => s + r.itbis, 0),
    total: gt,
  } };
}

function facRRenderGroup(kind) {
  const { rows, totals } = _facRGroupData(kind);
  const noun = { cliente: 'cliente(s)', tipo: 'tipo(s)', metodo: 'método(s)', estado: 'estado(s)' }[kind];
  setText(`facr-${kind}-count`, `${rows.length} ${noun}`);
  const tbl = $id(`facr-${kind}-table`);
  if (!tbl) return;
  const M = fmtMoney;
  let head, body, foot;
  if (kind === 'cliente') {
    head = `<tr><th>Cliente</th><th>RNC</th><th style="text-align:right">Facturas</th><th style="text-align:right">Base</th><th style="text-align:right">ITBIS</th><th style="text-align:right">Total</th><th style="text-align:right">%</th></tr>`;
    body = rows.map(r => `<tr><td>${esc(r.key)}</td><td style="font-family:var(--font-mono);font-size:11px">${esc(r.rnc || '—')}</td><td class="facr-td-r">${r.n}</td><td class="facr-td-r">${M(r.base)}</td><td class="facr-td-r">${M(r.itbis)}</td><td class="facr-td-r" style="font-weight:700">${M(r.total)}</td><td class="facr-td-r">${r.pct.toFixed(1)}%</td></tr>`).join('');
    foot = `<tr><td colspan="2">TOTAL</td><td class="facr-td-r">${totals.n}</td><td class="facr-td-r">${M(totals.base)}</td><td class="facr-td-r">${M(totals.itbis)}</td><td class="facr-td-r">${M(totals.total)}</td><td class="facr-td-r">100%</td></tr>`;
  } else if (kind === 'tipo') {
    head = `<tr><th>Tipo</th><th>Descripción</th><th style="text-align:right">Facturas</th><th style="text-align:right">Base</th><th style="text-align:right">ITBIS</th><th style="text-align:right">Total</th><th style="text-align:right">%</th></tr>`;
    body = rows.map(r => `<tr><td><strong>${esc(r.key)}</strong></td><td>${esc(_facRNcfLabel(r.key))}</td><td class="facr-td-r">${r.n}</td><td class="facr-td-r">${M(r.base)}</td><td class="facr-td-r">${M(r.itbis)}</td><td class="facr-td-r" style="font-weight:700">${M(r.total)}</td><td class="facr-td-r">${r.pct.toFixed(1)}%</td></tr>`).join('');
    foot = `<tr><td colspan="2">TOTAL</td><td class="facr-td-r">${totals.n}</td><td class="facr-td-r">${M(totals.base)}</td><td class="facr-td-r">${M(totals.itbis)}</td><td class="facr-td-r">${M(totals.total)}</td><td class="facr-td-r">100%</td></tr>`;
  } else {
    const lbl = kind === 'metodo' ? _facRMetodoLabel : (k => FACR_ESTADO_LBL[k] || k);
    head = `<tr><th>${kind === 'metodo' ? 'Método' : 'Estado'}</th><th style="text-align:right">Facturas</th><th style="text-align:right">Total</th><th style="text-align:right">%</th></tr>`;
    body = rows.map(r => `<tr><td>${esc(lbl(r.key))}</td><td class="facr-td-r">${r.n}</td><td class="facr-td-r" style="font-weight:700">${M(r.total)}</td><td class="facr-td-r">${r.pct.toFixed(1)}%</td></tr>`).join('');
    foot = `<tr><td>TOTAL</td><td class="facr-td-r">${totals.n}</td><td class="facr-td-r">${M(totals.total)}</td><td class="facr-td-r">100%</td></tr>`;
  }
  const cols = kind === 'metodo' || kind === 'estado' ? 4 : 7;
  tbl.innerHTML = `<thead>${head}</thead><tbody>${body || `<tr><td colspan="${cols}" class="td-empty">Sin datos en el período seleccionado.</td></tr>`}</tbody>${rows.length ? `<tfoot>${foot}</tfoot>` : ''}`;
}

// ── DGII ──────────────────────────────────────────────────────────────
function _facRDGIIData() {
  const list = facRFiltered().filter(f => (f.estado || 'pendiente') !== 'anulada');
  let gravado = 0, exento = 0, itbis = 0, total = 0;
  const m = {};
  list.forEach(f => {
    const base = _facN(f.subtotal) - _facN(f.descuento_total);
    if (_facN(f.itbis_total) > 0) gravado += base; else exento += base;
    itbis += _facN(f.itbis_total); total += _facN(f.total);
    const k = f.tipo_ncf || '—';
    if (!m[k]) m[k] = { n: 0, total: 0, itbis: 0 };
    m[k].n += 1; m[k].total += _facN(f.total); m[k].itbis += _facN(f.itbis_total);
  });
  return { gravado, exento, itbis, total, porNcf: m };
}

function facRRenderDGII() {
  const d = _facRDGIIData();
  const kpis = [
    ['Total facturado', fmtMoney(d.total), 'purple'],
    ['Monto gravado', fmtMoney(d.gravado), 'blue'],
    ['Monto exento', fmtMoney(d.exento), ''],
    ['ITBIS facturado', fmtMoney(d.itbis), 'orange'],
  ];
  const box = $id('facr-dgii-kpis');
  if (box) box.innerHTML = kpis.map(([l, v, c]) => `<div class="fac-stat-card"><div class="fac-stat-lbl">${l}</div><div class="fac-stat-val ${c}">${v}</div></div>`).join('');

  const keys = Object.keys(d.porNcf).sort();
  const gt = keys.reduce((s, k) => s + d.porNcf[k].total, 0);
  const tbl = $id('facr-dgii-table');
  if (tbl) {
    tbl.innerHTML = `
      <thead><tr><th>Tipo</th><th>Descripción</th><th style="text-align:right">Facturas</th><th style="text-align:right">Total</th><th style="text-align:right">ITBIS</th><th style="text-align:right">%</th></tr></thead>
      <tbody>${keys.length ? keys.map(k => `<tr><td><strong>${esc(k)}</strong></td><td>${esc(_facRNcfLabel(k))}</td><td class="facr-td-r">${d.porNcf[k].n}</td><td class="facr-td-r" style="font-weight:700">${fmtMoney(d.porNcf[k].total)}</td><td class="facr-td-r">${fmtMoney(d.porNcf[k].itbis)}</td><td class="facr-td-r">${gt > 0 ? (d.porNcf[k].total / gt * 100).toFixed(1) : '0.0'}%</td></tr>`).join('') : '<tr><td colspan="6" class="td-empty">Sin facturas en el período seleccionado.</td></tr>'}</tbody>
      ${keys.length ? `<tfoot><tr><td colspan="2">TOTAL</td><td class="facr-td-r">${keys.reduce((s, k) => s + d.porNcf[k].n, 0)}</td><td class="facr-td-r">${fmtMoney(gt)}</td><td class="facr-td-r">${fmtMoney(d.itbis)}</td><td class="facr-td-r">100%</td></tr></tfoot>` : ''}`;
  }
}

// ── Exportar (jsPDF, estilo POS morado vía _repPdfHeader/_repPdfTable) ──
function _facRPdfDoc() {
  const J = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
  if (!J) { toast('No se pudo cargar el generador de PDF.', 'error'); return null; }
  return new J({ orientation: 'p', unit: 'mm', format: 'a4' });
}
function _facRSave(doc, name) {
  const slug = String(_perfil?.nombre_firma || 'firma').replace(/[^a-z0-9]+/gi, '_').slice(0, 30);
  doc.save(`${name}_${slug}_${hoyLocal()}.pdf`);
  toast('Reporte PDF generado', 'success');
}

function facRExportFacturas() {
  const doc = _facRPdfDoc(); if (!doc) return;
  let rows = facRFiltered();
  if (_facR.facMetodo) rows = rows.filter(f => (f.metodo_pago || 'efectivo') === _facR.facMetodo);
  let y = _repPdfHeader(doc, 'Detalle de Facturas', _facRPeriodoLabel());
  y = _repPdfTable(doc, y,
    ['NCF', 'Tipo', 'Fecha', 'Cliente', 'Método', 'Base', 'ITBIS', 'Total', 'Estado'],
    rows.map(f => [
      facNcfDisplay(f.ncf), f.tipo_ncf || '—', f.fecha || '—',
      String(f.cliente?.nombre || '—').slice(0, 22), _facRMetodoLabel(f.metodo_pago),
      _facRMoneyPdf(_facN(f.subtotal) - _facN(f.descuento_total)), _facRMoneyPdf(f.itbis_total), _facRMoneyPdf(f.total),
      FACR_ESTADO_LBL[f.estado] || f.estado || '—',
    ]),
    [24, 12, 20, 34, 22, 22, 20, 22, 16]);
  const sB = rows.reduce((s, f) => s + (_facN(f.subtotal) - _facN(f.descuento_total)), 0);
  const sI = rows.reduce((s, f) => s + _facN(f.itbis_total), 0);
  const sT = rows.reduce((s, f) => s + _facN(f.total), 0);
  doc.setFont(undefined, 'bold'); doc.setFontSize(9);
  doc.text(`Base: ${_facRMoneyPdf(sB)}   |   ITBIS: ${_facRMoneyPdf(sI)}   |   Total: ${_facRMoneyPdf(sT)}   (${rows.length} facturas)`, 14, y + 5);
  _facRSave(doc, 'Detalle_Facturas');
}

function facRExportGroup(kind) {
  const doc = _facRPdfDoc(); if (!doc) return;
  const { rows, totals } = _facRGroupData(kind);
  const titles = { cliente: 'Facturación por Cliente', tipo: 'Facturación por Tipo de Comprobante', metodo: 'Facturación por Método de Pago', estado: 'Facturación por Estado' };
  let y = _repPdfHeader(doc, titles[kind] || 'Reporte', _facRPeriodoLabel());
  if (kind === 'cliente') {
    y = _repPdfTable(doc, y, ['Cliente', 'RNC', 'Facturas', 'Base', 'ITBIS', 'Total', '%'],
      rows.map(r => [String(r.key).slice(0, 30), r.rnc || '—', r.n, _facRMoneyPdf(r.base), _facRMoneyPdf(r.itbis), _facRMoneyPdf(r.total), r.pct.toFixed(1) + '%']),
      [46, 26, 18, 24, 22, 26, 20]);
  } else if (kind === 'tipo') {
    y = _repPdfTable(doc, y, ['Tipo', 'Descripción', 'Facturas', 'Base', 'ITBIS', 'Total', '%'],
      rows.map(r => [r.key, _facRNcfLabel(r.key), r.n, _facRMoneyPdf(r.base), _facRMoneyPdf(r.itbis), _facRMoneyPdf(r.total), r.pct.toFixed(1) + '%']),
      [16, 50, 18, 24, 22, 26, 16]);
  } else {
    const lbl = kind === 'metodo' ? _facRMetodoLabel : (k => FACR_ESTADO_LBL[k] || k);
    y = _repPdfTable(doc, y, [kind === 'metodo' ? 'Método' : 'Estado', 'Facturas', 'Total', '%'],
      rows.map(r => [lbl(r.key), r.n, _facRMoneyPdf(r.total), r.pct.toFixed(1) + '%']),
      [70, 30, 46, 26]);
  }
  doc.setFont(undefined, 'bold'); doc.setFontSize(9);
  doc.text(`TOTAL: ${_facRMoneyPdf(totals.total)}   (${totals.n} facturas)`, 14, y + 5);
  _facRSave(doc, 'Reporte_' + kind);
}

function facRExportDGII() {
  const doc = _facRPdfDoc(); if (!doc) return;
  const d = _facRDGIIData();
  let y = _repPdfHeader(doc, 'Reporte Fiscal DGII', _facRPeriodoLabel());
  doc.setFontSize(9); doc.setFont(undefined, 'bold'); doc.text('RESUMEN FISCAL', 14, y); y += 7;
  y = _repPdfTable(doc, y, ['Concepto', 'Monto', 'Concepto', 'Monto'], [
    ['Total facturado', _facRMoneyPdf(d.total), 'ITBIS facturado', _facRMoneyPdf(d.itbis)],
    ['Monto gravado', _facRMoneyPdf(d.gravado), 'Monto exento', _facRMoneyPdf(d.exento)],
  ], [45, 51, 45, 41]);
  y += 6;
  doc.setFont(undefined, 'bold'); doc.setFontSize(9); doc.text('DESGLOSE POR NCF', 14, y); y += 7;
  const keys = Object.keys(d.porNcf).sort();
  const gt = keys.reduce((s, k) => s + d.porNcf[k].total, 0);
  _repPdfTable(doc, y, ['Tipo', 'Descripción', 'Facturas', 'Total', 'ITBIS', '%'],
    keys.map(k => [k, _facRNcfLabel(k), d.porNcf[k].n, _facRMoneyPdf(d.porNcf[k].total), _facRMoneyPdf(d.porNcf[k].itbis), gt > 0 ? (d.porNcf[k].total / gt * 100).toFixed(1) + '%' : '0.0%']),
    [18, 55, 22, 30, 30, 27]);
  _facRSave(doc, 'Reporte_Fiscal_DGII');
}

function facRExportConsolidado() {
  const doc = _facRPdfDoc(); if (!doc) return;
  const list = facRFiltered();
  const vig  = list.filter(f => (f.estado || 'pendiente') !== 'anulada');
  const totalFact = vig.reduce((s, f) => s + _facN(f.total), 0);
  const cobrado   = vig.reduce((s, f) => s + _facN(f.monto_pagado), 0);
  let y = _repPdfHeader(doc, 'Reporte Consolidado', _facRPeriodoLabel());
  doc.setFontSize(9); doc.setFont(undefined, 'bold'); doc.text('1. RESUMEN', 14, y); y += 7;
  y = _repPdfTable(doc, y, ['Métrica', 'Valor', 'Métrica', 'Valor'], [
    ['Facturas', String(list.length), 'Total facturado', _facRMoneyPdf(totalFact)],
    ['Cobrado', _facRMoneyPdf(cobrado), 'Por cobrar', _facRMoneyPdf(Math.max(0, totalFact - cobrado))],
  ], [45, 51, 45, 41]);

  const secc = (titulo, kind) => {
    y += 6; if (y > 245) { doc.addPage(); y = 16; }
    doc.setFont(undefined, 'bold'); doc.setFontSize(9); doc.setTextColor(30, 36, 53); doc.text(titulo, 14, y); y += 7;
    const { rows } = _facRGroupData(kind);
    if (kind === 'cliente') {
      y = _repPdfTable(doc, y, ['Cliente', 'Facturas', 'Base', 'ITBIS', 'Total'],
        rows.map(r => [String(r.key).slice(0, 32), r.n, _facRMoneyPdf(r.base), _facRMoneyPdf(r.itbis), _facRMoneyPdf(r.total)]),
        [60, 22, 32, 30, 38]);
    } else {
      y = _repPdfTable(doc, y, ['Tipo', 'Descripción', 'Facturas', 'Total'],
        rows.map(r => [r.key, _facRNcfLabel(r.key), r.n, _facRMoneyPdf(r.total)]),
        [18, 70, 30, 64]);
    }
  };
  secc('2. POR CLIENTE', 'cliente');
  secc('3. POR TIPO DE COMPROBANTE', 'tipo');

  y += 6; if (y > 245) { doc.addPage(); y = 16; }
  doc.setFont(undefined, 'bold'); doc.setFontSize(9); doc.setTextColor(30, 36, 53); doc.text('4. FISCAL DGII', 14, y); y += 7;
  const d = _facRDGIIData();
  _repPdfTable(doc, y, ['Concepto', 'Monto', 'Concepto', 'Monto'], [
    ['Total facturado', _facRMoneyPdf(d.total), 'ITBIS facturado', _facRMoneyPdf(d.itbis)],
    ['Monto gravado', _facRMoneyPdf(d.gravado), 'Monto exento', _facRMoneyPdf(d.exento)],
  ], [45, 51, 45, 41]);
  _facRSave(doc, 'Reporte_Consolidado');
}

// ── Mis Secuencias NCF (facturación propia del contador) ───────────────
// A diferencia de "Secuencias NCF" (que el contador registra PARA sus
// clientes, vía cola ncf_pendientes que aplica el POS del cliente), esto
// son los rangos que la DGII le autorizó al propio contador para facturar
// sus servicios — se guarda y se consume directo aquí, sin ningún POS de
// por medio. Sin una secuencia activa, guardarFactura() en el backend
// rechaza la emisión (ver POST /api/mis-secuencias-ncf y getNextNcf en
// server.js) — nunca se inventa un NCF sin respaldo real.

let _misNcf = [];
let _mnAdjuntoDataUrl = null;
let _mnEditTargetId = null;

// ── Secuencias NCF: lo común a "Mis secuencias" y a las del POS del negocio ──
const NCF_NOMBRES = {
  B01: 'Crédito fiscal', B02: 'Consumidor final', B03: 'Nota de débito', B04: 'Nota de crédito',
  B11: 'Comprobante de compras', B12: 'Registro único de ingresos', B13: 'Gastos menores',
  B14: 'Régimen especial', B15: 'Gubernamental', B16: 'Exportaciones', B17: 'Pagos al exterior',
  // e-NCF: como los nombra la DGII en la Oficina Virtual.
  E31: 'Factura de Crédito Fiscal Electrónica', E32: 'Factura de Consumo Electrónica',
  E33: 'Nota de Débito Electrónica', E34: 'Nota de Crédito Electrónica', E41: 'Compras Electrónico',
  E43: 'Gastos Menores Electrónico', E44: 'Regímenes Especiales Electrónico', E45: 'Gubernamental Electrónico',
  E46: 'Exportaciones Electrónico', E47: 'Pagos al Exterior Electrónico',
};
const NCF_DESCRIPCIONES = {
  B01: 'Empresa con RNC que deduce gastos', B02: 'Persona o empresa sin crédito fiscal',
  B03: 'Aumenta el monto de una factura ya emitida', B04: 'Anula o reduce una factura ya emitida',
  B11: 'Compras a personas sin RNC', B12: 'Ventas resumidas en un solo registro',
  B13: 'Gastos menores del negocio', B14: 'Zonas francas y regímenes exentos',
  B15: 'Entidades del Estado', B16: 'Ventas al exterior', B17: 'Pagos a proveedores del exterior',
  E31: 'Factura electrónica a empresa con RNC', E32: 'Factura electrónica a consumidor final',
  E33: 'Aumenta una factura electrónica ya emitida', E34: 'Anula o reduce una factura electrónica',
  E41: 'Compras electrónicas a personas sin RNC', E43: 'Gastos menores del negocio',
  E44: 'Zonas francas y regímenes exentos', E45: 'Entidades del Estado',
  E46: 'Ventas al exterior', E47: 'Pagos a proveedores del exterior',
};
// Las notas de crédito (B04) no vencen; el resto lleva la fecha que da la DGII.
const NCF_SIN_VENCE = new Set(['B04']);
// e-NCF: 10 dígitos y la DGII autoriza cantidades concretas (mismos límites
// que el POS, EcfRepository.saveSequence).
const ECF_MAXIMO = 9999999999;
const ECF_RANGO_MAXIMO = 1000000;

function _ncfEsE(tipo) { return ECF_DOCUMENT_TYPES.includes(String(tipo || '').toUpperCase()); }
function _ncfFmt(tipo, n) {
  return `${tipo}${String(Math.max(0, Math.trunc(Number(n) || 0))).padStart(_ncfEsE(tipo) ? 10 : 8, '0')}`;
}
function _ncfOpciones() {
  return NCF_DOCUMENT_TYPES.map(t => `<option value="${t.code}">${t.code} — ${NCF_NOMBRES[t.code] || t.label}</option>`).join('');
}
// Para los negocios: NCF (B) y e-NCF de la factura electrónica (E).
function _ncfOpcionesCliente() {
  return `<optgroup label="Comprobantes fiscales (NCF)">${_ncfOpciones()}</optgroup>`
    + `<optgroup label="Comprobantes electrónicos (e-NCF)">${ECF_DOCUMENT_TYPES.map(c => `<option value="${c}">${c} — ${NCF_NOMBRES[c]}</option>`).join('')}</optgroup>`;
}

// "Primer NCF: B0200000001 · Último: B0200000500 · 500 comprobantes"
function _ncfPreviewHtml(tipo, desde, hasta) {
  const d = Number(desde), h = Number(hasta);
  if (!tipo || !Number.isInteger(d) || d < 1 || !Number.isInteger(h) || h <= d) {
    return 'Escribe el número inicial y el final para ver el rango.';
  }
  const n = h - d + 1;
  const sigla = _ncfEsE(tipo) ? 'e-NCF' : 'NCF';
  return `Primer ${sigla}: <strong>${_ncfFmt(tipo, d)}</strong> · Último: <strong>${_ncfFmt(tipo, h)}</strong> · ${n.toLocaleString('es-DO')} comprobante${n === 1 ? '' : 's'}`;
}

// Reglas del formulario: { campo: mensaje }. `existentes` = secuencias ya
// registradas (las suspendidas no cuentan, igual que en el servidor). Una
// e-NCF desactivada sí cuenta: el POS no repite un número de producción.
function _ncfValidar({ tipo, desde, hasta, vence, existentes = [], excluirId = null, editando = false }) {
  const err = {};
  const d = Number(desde), h = Number(hasta);
  const electronico = _ncfEsE(tipo);
  if (!editando && (!Number.isInteger(d) || d < 1)) err.desde = 'Escribe el número inicial (1 o más).';
  if (!Number.isInteger(h) || h < 1) err.hasta = 'Escribe el número final.';
  else if (Number.isInteger(d) && h <= d) err.hasta = 'El número final debe ser mayor que el inicial.';
  else if (electronico && h > ECF_MAXIMO) err.hasta = 'El e-NCF tiene 10 dígitos: máximo 9999999999.';
  else if (!electronico && h > 99999999) err.hasta = 'El NCF tiene 8 dígitos: máximo 99999999.';
  else if (electronico && h - d + 1 > ECF_RANGO_MAXIMO) err.hasta = 'Ese rango es demasiado grande: copia el "desde" y el "hasta" exactos de la DGII.';
  if (!vence && !NCF_SIN_VENCE.has(tipo) && !electronico && !editando) err.vence = 'Indica la fecha de vencimiento que dio la DGII.';
  else if (vence && !editando && vence < hoyLocal()) err.vence = 'Esa fecha ya pasó: la secuencia no se podría usar.';
  if (!err.desde && !err.hasta) {
    const noCuentan = electronico ? ['cancelado', 'eliminado'] : ['suspendido', 'cancelado', 'eliminado'];
    const choque = existentes.find(s => s.documentType === tipo && String(s.id) !== String(excluirId)
      && !noCuentan.includes(s.status)
      && d <= Number(s.endNumber) && h >= Number(s.startNumber));
    if (choque) err.hasta = `Se cruza con la secuencia ${_ncfFmt(tipo, choque.startNumber)}–${_ncfFmt(tipo, choque.endNumber)}.`;
  }
  return err;
}

// Estado que se muestra: Activa / Por agotarse / Por vencer / Vencida / Agotada / Desactivada.
function _ncfEstado(s) {
  const total = Math.max(1, Number(s.totalAuthorized) || (Number(s.endNumber) - Number(s.startNumber) + 1));
  const quedan = Math.max(0, Number(s.totalAvailable ?? (Number(s.endNumber) - Number(s.nextNumber) + 1)));
  const pct = quedan / total;
  const diasVence = s.expirationDate ? _diasHasta(s.expirationDate) : null;
  if (s.status === 'suspendido') return { etiqueta: 'Desactivada', pill: 'pill-neutral', activa: false, quedan, total, pct, diasVence, alertas: [] };
  if ((s.effectiveStatus || s.status) === 'vencido' || (diasVence !== null && diasVence < 0)) {
    return { etiqueta: 'Vencida', pill: 'pill-bad', activa: false, quedan, total, pct, diasVence, alertas: [] };
  }
  if (quedan <= 0 || (s.effectiveStatus || s.status) === 'agotado') {
    return { etiqueta: 'Agotada', pill: 'pill-bad', activa: false, quedan: 0, total, pct: 0, diasVence, alertas: [] };
  }
  const alertas = [];
  if (pct < 0.10) alertas.push(`Quedan solo ${_plural(quedan, 'comprobante', 'comprobantes')} (${Math.max(1, Math.round(pct * 100))}%).`);
  if (diasVence !== null && diasVence < 30) alertas.push(diasVence === 0 ? 'Vence hoy.' : `Vence en ${_plural(diasVence, 'día', 'días')}.`);
  if (alertas.length) {
    return { etiqueta: pct < 0.10 ? 'Por agotarse' : 'Por vencer', pill: 'pill-warn', activa: true, quedan, total, pct, diasVence, alertas };
  }
  return { etiqueta: 'Activa', pill: 'pill-ok', activa: true, quedan, total, pct, diasVence, alertas };
}

async function abrirMisSecuenciasNcf() {
  show('modal-mis-ncf-lista');
  await loadMisSecuenciasNcf();
}

function cerrarMisSecuenciasNcf() { hide('modal-mis-ncf-lista'); }

async function loadMisSecuenciasNcf() {
  const body = $id('mis-ncf-lista-body');
  setText('mis-ncf-resumen', 'Cargando…');
  if (body) body.innerHTML = '';
  try {
    await refreshToken();
    _misNcf = await apiCall('GET', '/api/mis-secuencias-ncf');
    renderMisSecuenciasNcf();
  } catch (e) {
    setText('mis-ncf-resumen', '');
    if (body) body.innerHTML = `<div class="fm-aviso fm-aviso--error">No se pudieron cargar tus secuencias: ${esc(e.message)}</div>`;
  }
}

function renderMisSecuenciasNcf() {
  const body = $id('mis-ncf-lista-body');
  if (!body) return;
  if (!_misNcf.length) {
    setText('mis-ncf-resumen', 'Todavía no tienes secuencias registradas.');
    body.innerHTML = `<div class="fm-aviso">Registra el rango que la DGII te autorizó (por ejemplo B02 del 1 al 500) para poder emitir facturas de ese tipo.
      <button class="btn btn-primary btn-sm" data-icono="plus" onclick="app.abrirRegistrarMiNcfModal()">Agregar secuencia</button></div>`;
    return;
  }
  const lista = _misNcf.map(s => ({ s, e: _ncfEstado(s) }))
    .sort((a, b) => (Number(b.e.activa) - Number(a.e.activa))
      || String(a.s.documentType).localeCompare(String(b.s.documentType))
      || Number(a.s.startNumber) - Number(b.s.startNumber));
  const activas = lista.filter(x => x.e.activa).length;
  const alerta = lista.filter(x => x.e.alertas.length).length;
  const inactivas = lista.length - activas;
  setText('mis-ncf-resumen', [
    _plural(activas, 'activa', 'activas'),
    alerta ? `${alerta} por agotarse o vencer` : '',
    inactivas ? `${inactivas} vencida${inactivas === 1 ? '' : 's'}, agotada${inactivas === 1 ? '' : 's'} o desactivada${inactivas === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · '));

  body.innerHTML = lista.map(({ s, e }) => {
    const tipo = s.documentType;
    const usados = Math.max(0, Number(s.totalUsed ?? (Number(s.nextNumber) - Number(s.startNumber))));
    const barra = e.pct < 0.10 ? 'is-bad' : e.pct < 0.25 ? 'is-warn' : '';
    const vence = s.expirationDate
      ? `${_fmtFechaSolo(s.expirationDate)}${e.diasVence !== null && e.diasVence >= 0 ? ` · en ${_plural(e.diasVence, 'día', 'días')}` : ''}`
      : 'No vence';
    return `<div class="ncf-card ${e.alertas.length ? 'is-alerta' : ''} ${e.activa ? '' : 'is-inactiva'}">
      <div class="ncf-card__cabeza">
        <div class="ncf-card__tipo">${esc(tipo)} · ${esc(NCF_NOMBRES[tipo] || '')}<small>${esc(NCF_DESCRIPCIONES[tipo] || '')}</small></div>
        <span class="pill ${e.pill}">${e.etiqueta}</span>
      </div>
      <dl class="ncf-datos">
        <dt>Rango</dt><dd><code>${_ncfFmt(tipo, s.startNumber)} – ${_ncfFmt(tipo, s.endNumber)}</code></dd>
        <dt>Próximo NCF</dt><dd><code>${e.quedan > 0 ? _ncfFmt(tipo, s.nextNumber) : '—'}</code></dd>
        <dt>Usados</dt><dd>${usados.toLocaleString('es-DO')}</dd>
        <dt>Vence</dt><dd>${esc(vence)}</dd>
      </dl>
      <div class="ncf-barra ${barra}" role="progressbar" aria-valuemin="0" aria-valuemax="${e.total}" aria-valuenow="${e.quedan}"><span style="width:${Math.round(e.pct * 100)}%"></span></div>
      <div class="ncf-barra__txt"><span>Quedan ${e.quedan.toLocaleString('es-DO')} de ${e.total.toLocaleString('es-DO')}</span><span>${Math.round(e.pct * 100)}%</span></div>
      ${e.alertas.map(a => `<div class="ncf-alerta">${esc(a)}</div>`).join('')}
      <div class="ncf-acciones">
        <button class="btn btn-secondary btn-sm" data-icono="pencil" onclick="app.abrirRegistrarMiNcfModal('${s.id}')">Editar</button>
        ${s.status === 'suspendido'
          ? `<button class="btn btn-secondary btn-sm" data-icono="play" onclick="app.activarMiNcf('${s.id}')">Activar</button>`
          : (s.status === 'activo' ? `<button class="btn btn-secondary btn-sm" data-icono="circle-pause" onclick="app.suspenderMiNcf('${s.id}')">Desactivar</button>` : '')}
        ${s.tieneDocumento ? `<button class="btn btn-secondary btn-sm" data-icono="file-text" onclick="app.verDocumentoMiNcf('${s.id}')">Documento</button>` : ''}
        ${Number(s.nextNumber) === Number(s.startNumber) ? `<button class="btn-icono is-danger" data-icono="trash-2" title="Eliminar (nunca se usó)" aria-label="Eliminar" onclick="app.eliminarMiNcf('${s.id}')"></button>` : ''}
      </div>
    </div>`;
  }).join('');
}

// El documento de la DGII se baja solo cuando se pide (no viene en la lista).
async function verDocumentoMiNcf(id) {
  try {
    const { attachmentData } = await apiCall('GET', `/api/mis-secuencias-ncf/${id}/documento`);
    const seq = _misNcf.find(s => String(s.id) === String(id));
    const ext = /^data:application\/pdf/.test(attachmentData) ? 'pdf' : (/^data:image\/(\w+)/.exec(attachmentData)?.[1] || 'bin');
    const a = document.createElement('a');
    a.href = attachmentData;
    a.download = `Autorizacion_${seq?.documentType || 'NCF'}_${seq?.startNumber || ''}-${seq?.endNumber || ''}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) { toast(e.message, 'error'); }
}

function handleMiNcfAdjunto(input) {
  const file = input?.files?.[0];
  _fmError('mn-adjunto-file', '');
  if (!file) return;
  if (file.size > 700 * 1024) { _fmError('mn-adjunto-file', 'El archivo debe pesar menos de 700 KB.'); input.value = ''; return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    _mnAdjuntoDataUrl = e.target.result;
    setText('mn-adjunto-nombre', `Adjunto: ${file.name}`);
  };
  reader.readAsDataURL(file);
}

// Prefijo, vista previa y ayuda del tipo mientras se escribe.
function mnActualizar() {
  const tipo = $id('mn-tipo')?.value || '';
  const el = $id('mn-prefijo'); if (el) el.value = tipo;
  setText('mn-tipo-ayuda', NCF_DESCRIPCIONES[tipo] || '');
  setText('mn-vence-lbl', NCF_SIN_VENCE.has(tipo) ? 'Fecha de vencimiento (las notas de crédito no vencen)' : 'Fecha de vencimiento *');
  const p = $id('mn-preview');
  if (p) p.innerHTML = _ncfPreviewHtml(tipo, $id('mn-desde')?.value, $id('mn-hasta')?.value);
}

function abrirRegistrarMiNcfModal(editId) {
  _mnEditTargetId = editId || null;
  const seq = editId ? _misNcf.find((s) => String(s.id) === String(editId)) : null;
  _mnAdjuntoDataUrl = null;
  _fmLimpiar('mn-form');
  setText('mn-msg', '');

  const tipoEl = $id('mn-tipo');
  if (tipoEl) tipoEl.innerHTML = _ncfOpciones();

  const set = (id, v) => { const el = $id(id); if (el) el.value = v ?? ''; };
  const fileInput = $id('mn-adjunto-file'); if (fileInput) fileInput.value = '';
  if (seq) {
    setText('mn-titulo', `Editar secuencia ${seq.documentType}`);
    if (tipoEl) { tipoEl.value = seq.documentType; tipoEl.disabled = true; }
    set('mn-desde', seq.startNumber);
    $id('mn-desde').disabled = true;
    set('mn-hasta', seq.endNumber);
    set('mn-fecha-autorizacion', String(seq.authorizationDate || '').slice(0, 10));
    set('mn-fecha-vencimiento', String(seq.expirationDate || '').slice(0, 10));
    set('mn-referencia', seq.authorizationReference);
    set('mn-notas', seq.notes);
    setText('mn-adjunto-nombre', seq.tieneDocumento ? 'Ya tiene un documento guardado. Sube otro solo si quieres reemplazarlo.' : '');
    setText('mn-btn-guardar', 'Guardar cambios');
  } else {
    setText('mn-titulo', 'Registrar secuencia NCF');
    if (tipoEl) { tipoEl.disabled = false; tipoEl.value = 'B02'; }
    ['mn-desde', 'mn-hasta', 'mn-fecha-autorizacion', 'mn-fecha-vencimiento', 'mn-referencia', 'mn-notas'].forEach((id) => set(id, ''));
    $id('mn-desde').disabled = false;
    setText('mn-adjunto-nombre', '');
    setText('mn-btn-guardar', 'Guardar secuencia');
  }
  mnActualizar();
  show('modal-registrar-mi-ncf');
  setTimeout(() => $id(seq ? 'mn-hasta' : 'mn-desde')?.focus(), 50);
}

function cerrarRegistrarMiNcfModal() { hide('modal-registrar-mi-ncf'); }

async function guardarMiNcf() {
  const get = (id) => $id(id)?.value?.trim() || '';
  const seq = _mnEditTargetId ? _misNcf.find(s => String(s.id) === String(_mnEditTargetId)) : null;
  const tipo = seq ? seq.documentType : get('mn-tipo');
  _fmLimpiar('mn-form');
  setText('mn-msg', '');
  const err = _ncfValidar({
    tipo, desde: seq ? seq.startNumber : get('mn-desde'), hasta: get('mn-hasta'), vence: get('mn-fecha-vencimiento'),
    existentes: _misNcf, excluirId: _mnEditTargetId, editando: Boolean(seq),
  });
  if (seq && !err.hasta && Number(get('mn-hasta')) < Number(seq.nextNumber) - 1) {
    err.hasta = `Ya se usaron hasta el ${_ncfFmt(tipo, Number(seq.nextNumber) - 1)}: el final no puede ser menor.`;
  }
  if (err.desde) _fmError('mn-desde', err.desde);
  if (err.hasta) _fmError('mn-hasta', err.hasta);
  if (err.vence) _fmError('mn-fecha-vencimiento', err.vence);
  if (Object.keys(err).length) return;

  const btn = $id('mn-btn-guardar');
  if (btn) btn.disabled = true;
  try {
    await refreshToken();
    if (seq) {
      await apiCall('PUT', `/api/mis-secuencias-ncf/${_mnEditTargetId}`, {
        endNumber: Number(get('mn-hasta')) || null,
        authorizationDate: get('mn-fecha-autorizacion') || null,
        expirationDate: get('mn-fecha-vencimiento') || null,
        authorizationReference: get('mn-referencia'),
        notes: get('mn-notas'),
        attachmentData: _mnAdjuntoDataUrl || undefined,
      });
      toast('Secuencia actualizada.', 'success');
    } else {
      await apiCall('POST', '/api/mis-secuencias-ncf', {
        documentType: tipo,
        startNumber: Number(get('mn-desde')) || 0,
        endNumber: Number(get('mn-hasta')) || 0,
        authorizationDate: get('mn-fecha-autorizacion') || null,
        expirationDate: get('mn-fecha-vencimiento') || null,
        authorizationReference: get('mn-referencia'),
        attachmentData: _mnAdjuntoDataUrl || null,
        notes: get('mn-notas'),
      });
      toast('Secuencia registrada y activa.', 'success');
    }
    cerrarRegistrarMiNcfModal();
    await loadMisSecuenciasNcf();
    if (!$id('modal-nueva-factura')?.classList.contains('hidden')) _nfPintarTipos();
  } catch (e) {
    // Errores del servidor (p. ej. 409: se cruza con otra) debajo del campo que toca.
    if (/cruza|final/i.test(e.message)) _fmError('mn-hasta', e.message);
    else if (/vencimiento|fecha/i.test(e.message)) _fmError('mn-fecha-vencimiento', e.message);
    else { const m = $id('mn-msg'); if (m) { m.textContent = e.message; m.classList.add('is-error'); } }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function suspenderMiNcf(id) {
  const seq = _misNcf.find((s) => String(s.id) === String(id));
  if (!seq) return;
  const reason = await pedirMotivoNcf(
    `Desactivar ${seq.documentType} ${_ncfFmt(seq.documentType, seq.startNumber)}–${_ncfFmt(seq.documentType, seq.endNumber)}`,
    'El motivo es obligatorio. No podrás facturar con este rango hasta que lo actives de nuevo.'
  );
  if (!reason) return;
  try {
    await refreshToken();
    await apiCall('POST', `/api/mis-secuencias-ncf/${id}/suspender`, { reason });
    toast('Secuencia desactivada.', 'success');
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
  if (!confirm(`¿Eliminar la secuencia ${_ncfFmt(seq.documentType, seq.startNumber)}–${_ncfFmt(seq.documentType, seq.endNumber)}? Nunca se usó, así que se puede borrar sin problema.`)) return;
  try {
    await refreshToken();
    await apiCall('DELETE', `/api/mis-secuencias-ncf/${id}`);
    toast('Secuencia eliminada.', 'success');
    loadMisSecuenciasNcf();
  } catch (e) { toast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════
// FACTURA Y COTIZACIÓN — formulario común (diseño 2026)
// Prefijo 'nf' = Nueva factura, 'cot' = cotización. Mismos pasos: cliente
// (buscador de Mis clientes y negocios asociados + DGII), servicios con
// "Agregar rápido", pago y notas, y el resumen fijo a la derecha.
// ══════════════════════════════════════════════════════════════════════

function _docItems(p) { return p === 'cot' ? _cotItems : _facItems; }
function _docSetItems(p, v) { if (p === 'cot') _cotItems = v; else _facItems = v; }
function _docNuevaLinea(d = {}) {
  return {
    descripcion: d.descripcion || '', cantidad: Number(d.cantidad) || 1, precio: Number(d.precio) || 0,
    descuento: Number(d.descuento) || 0, itbis_rate: d.itbis_rate ?? 18,
  };
}
const _r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
// Importe de la línea sin ITBIS (el ITBIS va aparte en el resumen).
function _docImporte(it) {
  const base = (Number(it.precio) || 0) * Math.max(1, Number(it.cantidad) || 1);
  return _r2(base - base * (Math.min(100, Math.max(0, Number(it.descuento) || 0)) / 100));
}
// Mismo cálculo que computeFacturaItems() del servidor.
function _docTotales(items) {
  let subtotal = 0, descuentos = 0, gravada = 0, exento = 0, itbis = 0;
  for (const it of items || []) {
    const base = (Number(it.precio) || 0) * Math.max(1, Number(it.cantidad) || 1);
    const d = base * (Math.min(100, Math.max(0, Number(it.descuento) || 0)) / 100);
    const g = base - d;
    const rate = Number(it.itbis_rate) || 0;
    subtotal += base; descuentos += d; itbis += g * (rate / 100);
    if (rate > 0) gravada += g; else exento += g;
  }
  return {
    subtotal: _r2(subtotal), descuentos: _r2(descuentos), gravada: _r2(gravada), exento: _r2(exento),
    itbis: _r2(itbis), total: _r2(subtotal - descuentos + itbis),
  };
}
// Líneas que se mandan: sin las que quedaron completamente vacías.
function _docItemsUtiles(items) {
  return (items || []).filter(it => String(it.descripcion || '').trim() || Number(it.precio) > 0);
}

// "Agregar rápido": servicios típicos del despacho con el período ya puesto.
function _docPlantillas() {
  const hoy = new Date();
  const prev = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
  const mesHoy = `${_MESES_CORTOS[hoy.getMonth()]} ${hoy.getFullYear()}`;
  const mesPrev = `${_MESES_CORTOS[prev.getMonth()]} ${prev.getFullYear()}`;
  return [
    { clave: 'Contabilidad mensual', etiqueta: 'Contabilidad mensual', descripcion: `Contabilidad mensual · ${mesHoy}` },
    { clave: 'Preparación y envío IT-1', etiqueta: 'IT-1', descripcion: `Preparación y envío IT-1 · ${mesPrev}` },
    { clave: 'Formatos 606 / 607', etiqueta: '606 / 607', descripcion: `Formatos 606 / 607 · ${mesPrev}` },
    { clave: 'Declaración IR-2', etiqueta: 'IR-2 anual', descripcion: `Declaración IR-2 · año ${hoy.getFullYear() - 1}` },
  ];
}
// Precio sugerido: el último que usaste en una factura o cotización con ese servicio.
function _docUltimoPrecio(clave) {
  const docs = [...(_facFacturas || []), ...(_cotCotizaciones || [])]
    .sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
  for (const d of docs) {
    const it = (d.items || []).find(x => String(x.descripcion || '').startsWith(clave) && Number(x.precio) > 0);
    if (it) return Number(it.precio);
  }
  return 0;
}
// Las sugerencias salen al escribir la descripción (datalist), con el período ya puesto.
const _DOC_SERVICIOS_EXTRA = ['Declaración IR-17', 'Preparación de nómina y TSS', 'Asesoría fiscal', 'Auditoría', 'Consultoría empresarial', 'Registro mercantil'];
function _docPintarPlantillas() {
  const lista = $id('fac-servicios-list');
  if (!lista) return;
  lista.innerHTML = [..._docPlantillas().map(x => x.descripcion), ..._DOC_SERVICIOS_EXTRA]
    .map(v => `<option value="${esc(v)}"></option>`).join('');
}
function docAgregarPlantilla(p, i) {
  const x = _docPlantillas()[i];
  if (!x) return;
  const items = _docItems(p);
  const precio = _docUltimoPrecio(x.clave);
  const linea = _docNuevaLinea({ descripcion: x.descripcion, precio });
  let idx;
  if (items.length === 1 && !items[0].descripcion && !Number(items[0].precio)) { items[0] = linea; idx = 0; }
  else { items.push(linea); idx = items.length - 1; }
  renderDocItems(p);
  _docPintarTotales(p);
  _docActualizarPie(p);
  if (!precio) setTimeout(() => $id(`${p}-items-body`)?.querySelector(`[data-precio="${idx}"]`)?.focus(), 30);
}

function renderDocItems(p) {
  const tbody = $id(`${p}-items-body`);
  if (!tbody) return;
  const ej = _docPlantillas()[0].descripcion;
  // Sin columna de descuento (diseño 2026): si la línea trae uno (de una
  // cotización vieja) se respeta en el cálculo y sale en el resumen.
  tbody.innerHTML = _docItems(p).map((it, i) => {
    const rate = Number(it.itbis_rate) || 0;
    const extra = [0, 18].includes(rate) ? '' : `<option value="${rate}" selected>${rate}%</option>`;
    const precio = Number(it.precio) ? Number(it.precio).toFixed(2) : '';
    return `<tr>
      <td><input type="text" class="form-input" list="fac-servicios-list" value="${esc(it.descripcion)}" placeholder="Ej.: ${esc(ej)}"
        aria-label="Descripción" oninput="app.docItemSet('${p}',${i},'descripcion',this.value)" /></td>
      <td><input type="number" class="form-input fm-cant" min="1" step="1" value="${it.cantidad}" aria-label="Cantidad"
        oninput="app.docItemSet('${p}',${i},'cantidad',this.value)" /></td>
      <td><input type="number" class="form-input" min="0" step="0.01" value="${precio}" placeholder="5000.00" data-precio="${i}"
        aria-label="Precio" oninput="app.docItemSet('${p}',${i},'precio',this.value)" /></td>
      <td><select class="form-select" aria-label="ITBIS" onchange="app.docItemSet('${p}',${i},'itbis_rate',this.value)">
        <option value="18" ${rate === 18 ? 'selected' : ''}>18%</option>
        <option value="0" ${rate === 0 ? 'selected' : ''}>Exento</option>${extra}
      </select></td>
      <td class="fm-importe" id="${p}-item-imp-${i}">${fmtMoney(_docImporte(it))}</td>
      <td><button type="button" class="btn-quitar" data-icono="trash-2" title="Quitar línea" aria-label="Quitar línea" onclick="app.docRemoveItem('${p}',${i})"></button></td>
    </tr>`;
  }).join('');
}

function docItemSet(p, idx, field, value) {
  const it = _docItems(p)[idx];
  if (!it) return;
  it[field] = field === 'descripcion' ? value : (Number(value) || 0);
  // Elegida una sugerencia ("Contabilidad mensual · oct 2026") sin precio: el último que usaste.
  if (field === 'descripcion' && !Number(it.precio)) {
    const sug = _docPlantillas().find(x => x.descripcion === value);
    const precio = sug ? _docUltimoPrecio(sug.clave) : 0;
    if (precio) {
      it.precio = precio;
      const inp = $id(`${p}-items-body`)?.querySelector(`[data-precio="${idx}"]`);
      if (inp) inp.value = precio.toFixed(2);
    }
  }
  const cell = $id(`${p}-item-imp-${idx}`);
  if (cell) cell.textContent = fmtMoney(_docImporte(it));
  _docPintarTotales(p);
}

function docAddItem(p) {
  _docItems(p).push(_docNuevaLinea());
  renderDocItems(p);
  _docPintarTotales(p);
  _docActualizarPie(p);
  const filas = $id(`${p}-items-body`)?.querySelectorAll('tr');
  filas?.[filas.length - 1]?.querySelector('input')?.focus();
}

function docRemoveItem(p, idx) {
  const items = _docItems(p);
  if (items.length <= 1) _docSetItems(p, [_docNuevaLinea()]);
  else items.splice(idx, 1);
  renderDocItems(p);
  _docPintarTotales(p);
  _docActualizarPie(p);
}

function _docPintarTotales(p) {
  const t = _docTotales(_docItems(p));
  setText(`${p}-t-sub`, fmtMoney(t.subtotal));
  setText(`${p}-t-desc`, '− ' + fmtMoney(t.descuentos));
  setText(`${p}-t-gravada`, fmtMoney(t.gravada));
  setText(`${p}-t-exento`, fmtMoney(t.exento));
  setText(`${p}-t-itbis`, fmtMoney(t.itbis));
  setText(`${p}-t-total`, fmtMoney(t.total));
  // En el resumen solo salen las cifras que dicen algo: descuentos y exento si hay.
  const ver = (id, si) => { const fila = $id(id)?.parentElement; if (fila) fila.hidden = !si; };
  ver(`${p}-t-desc`, t.descuentos > 0);
  ver(`${p}-t-exento`, t.exento > 0);
  const tasas = [...new Set(_docItems(p).map(it => Number(it.itbis_rate) || 0).filter(r => r > 0))];
  setText(`${p}-t-itbis-lbl`, tasas.length === 1 ? `ITBIS (${tasas[0]}%)` : 'ITBIS');
  return t;
}

function _docActualizarPie(p) { if (p === 'cot') cotActualizarPie(); else nfActualizarPie(); }

function docElegirCondicion(p, valor) {
  const h = $id(`${p}-condicion`); if (h) h.value = valor;
  document.querySelectorAll(`#${p}-condicion-seg [data-valor]`).forEach(b => b.setAttribute('aria-checked', String(b.dataset.valor === valor)));
}

// ── Cliente: buscador + DGII ──
function _docClientesGuardados(p) { return (p === 'cot' ? _cotClientes : _facClientes) || []; }

// Se busca escribiendo en "Razón social". soloVacio: al entrar al campo, la
// lista sale solo si está vacío (para elegir un cliente sin escribir).
function docBuscarCliente(p, soloVacio) {
  const input = $id(`${p}-cli-nombre`);
  const caja = $id(`${p}-cli-resultados`);
  if (!input || !caja) return;
  if (soloVacio && input.value.trim()) return;
  const q = _normalizar(input.value);
  const qd = String(input.value || '').replace(/\D/g, '');
  const pasa = (nombre, rnc) => !q || _normalizar(nombre).includes(q) || (qd.length >= 3 && String(rnc || '').replace(/\D/g, '').includes(qd));
  const guardados = _docClientesGuardados(p).filter(c => pasa(c.nombre, c.rnc)).slice(0, 6);
  const negocios = (_allClientes || []).filter(n => pasa(n.businessName || n.businessKey, n.rnc)).slice(0, 6);
  let html = '';
  if (guardados.length) {
    html += '<div class="buscador-grupo">Mis clientes</div>' + guardados.map(c => `
      <button type="button" class="buscador-item" onmousedown="event.preventDefault();app.docElegirCliente('${p}','fac_${esc(c.id)}')">
        <span class="buscador-item__titulo">${esc(c.nombre)}</span>
        <span class="buscador-item__meta">${esc([c.rnc ? `RNC ${c.rnc}` : 'Sin RNC', c.correo].filter(Boolean).join(' · '))}</span>
      </button>`).join('');
  }
  if (negocios.length) {
    html += '<div class="buscador-grupo">Negocios asociados</div>' + negocios.map(n => `
      <button type="button" class="buscador-item" onmousedown="event.preventDefault();app.docElegirCliente('${p}','neg_${esc(n.id)}')">
        <span class="buscador-item__titulo">${esc(n.businessName || n.businessKey || '—')}</span>
        <span class="buscador-item__meta">${esc(n.rnc ? `RNC ${n.rnc}` : 'Sin RNC')}</span>
      </button>`).join('');
  }
  // Sin coincidencias es un cliente nuevo: no se muestra nada y se sigue escribiendo.
  caja.innerHTML = html;
  caja.classList.toggle('hidden', !html);
}

async function docElegirCliente(p, val) {
  $id(`${p}-cli-resultados`)?.classList.add('hidden');
  if (p === 'cot') await selClienteCot(val); else await selClienteFac(val);
  setText(`${p}-rnc-ayuda`, '');
  if (p === 'nf') _nfPintarTipos();
  _docActualizarPie(p);
}

function docClienteNuevo(p) {
  ['nombre', 'rnc', 'dir', 'tel', 'correo'].forEach(c => { const el = $id(`${p}-cli-${c}`); if (el) el.value = ''; });
  // El nombre que traiga la DGII vuelve a llenarse solo (no es una edición a mano).
  const nom = $id(`${p}-cli-nombre`); if (nom) delete nom.dataset.rncOverride;
  $id(`${p}-cli-resultados`)?.classList.add('hidden');
  _mostrarCheckGuardarCliente(p, '');
  const chk = $id(`${p}-guardar-cliente`); if (chk) chk.checked = true;
  setText(`${p}-rnc-ayuda`, '');
  _docActualizarPie(p);
  $id(`${p}-cli-rnc`)?.focus();
}

async function _consultarDgii(rncId, nombreId, ayudaId) {
  const raw = String($id(rncId)?.value || '').replace(/\D/g, '');
  _fmError(rncId, '');
  if (raw.length !== 9 && raw.length !== 11) { _fmError(rncId, 'El RNC tiene 9 dígitos y la cédula 11.'); return; }
  setText(ayudaId, 'Consultando la DGII…');
  try {
    const d = await apiCall('GET', `/api/rnc/consulta?id=${encodeURIComponent(raw)}`);
    if (d && d.found) {
      const nom = $id(nombreId);
      if (nom) nom.value = d.nombre || d.nombreComercial || nom.value;
      setText(ayudaId, `DGII: ${d.nombre || d.nombreComercial}${d.estado ? ' · ' + d.estado : ''}`);
      _fmError(nombreId, '');
    } else {
      setText(ayudaId, 'Ese RNC no aparece en la DGII. Escribe el nombre a mano.');
    }
  } catch (_) {
    setText(ayudaId, 'No se pudo consultar la DGII ahora. Escribe el nombre a mano.');
  }
}
async function docConsultarDgii(p) {
  await _consultarDgii(`${p}-cli-rnc`, `${p}-cli-nombre`, `${p}-rnc-ayuda`);
  if (p === 'nf') _nfPintarTipos();
  _docActualizarPie(p);
}
function mcliConsultarDgii() { return _consultarDgii('mcli-f-rnc', 'mcli-f-nombre', 'mcli-rnc-ayuda'); }

// Los resultados del buscador de cliente se cierran al tocar fuera.
document.addEventListener('mousedown', (e) => {
  if (e.target.closest?.('.fm-buscador, .fm-autocompletar')) return;
  document.querySelectorAll('.fm-resultados').forEach(c => c.classList.add('hidden'));
});

async function _docCargarClientes(p) {
  try {
    const [clientes, negocios] = await Promise.all([
      apiCall('GET', '/api/facturacion/clientes'),
      _allClientes.length ? Promise.resolve(_allClientes) : apiCall('GET', '/api/clientes').catch(() => []),
    ]);
    if (p === 'cot') _cotClientes = clientes; else _facClientes = clientes;
    if (!_allClientes.length && negocios.length) _allClientes = negocios;
  } catch { /* sin clientes guardados: se escriben a mano */ }
}

// ── Nueva factura ─────────────────────────────────────────────────────

// En tarjetas; los demás (B15, B16…) van en "Otro".
const NF_TIPOS_PRINCIPALES = ['B01', 'B02', 'B14'];
let _nfTipo = 'B02';
let _nfTipoManual = false;     // el contador eligió el tipo: no se cambia solo al elegir cliente
let _nfIntento = false;        // tras el primer "Emitir", los errores se pintan mientras escribe
let _nfEditNcf = null;         // NCF de la factura en edición (no cambia)
let _facDesdeCot = null;       // { id, numero } — "Convertir en factura" desde una cotización

// La secuencia con la que el servidor va a emitir (la activa de menor rango).
function _nfSecuenciaUsable(tipo) {
  return (_misNcf || [])
    .filter(s => s.documentType === tipo && (s.effectiveStatus || s.status) === 'activo' && Number(s.totalAvailable ?? 1) > 0)
    .sort((a, b) => Number(a.startNumber) - Number(b.startNumber))[0] || null;
}

function _nfEstadoTipo(tipo) {
  const u = _nfSecuenciaUsable(tipo);
  if (u) {
    const n = Number(u.totalAvailable || 0);
    return { texto: `${n.toLocaleString('es-DO')} disponible${n === 1 ? '' : 's'}`, cls: n <= 5 ? '' : 'is-ok', usable: u };
  }
  const seqs = (_misNcf || []).filter(s => s.documentType === tipo);
  if (!seqs.length) return { texto: 'Sin secuencia', cls: '', usable: null };
  return { texto: _ncfEstado(seqs[0]).etiqueta, cls: 'is-bad', usable: null };
}

function _nfPintarTipos() {
  const editando = Boolean(_facEditId);
  const cont = $id('nf-tipos');
  if (cont) {
    cont.innerHTML = NF_TIPOS_PRINCIPALES.map(t => {
      const st = _nfEstadoTipo(t);
      // Código y nombre; el estado solo se ve cuando no se puede emitir con ese tipo.
      return `<button type="button" class="fm-tipo" role="radio" aria-checked="${_nfTipo === t}" ${editando ? 'disabled' : ''}
        title="${esc(`${NCF_DESCRIPCIONES[t]} · ${st.texto}`)}" onclick="app.nfElegirTipo('${t}')">
        <span class="fm-tipo__cod">${t}</span>
        <span class="fm-tipo__nombre">${esc(NCF_NOMBRES[t])}</span>
        ${st.usable ? '' : `<span class="fm-tipo__estado is-bad">${esc(st.texto)}</span>`}
      </button>`;
    }).join('');
  }
  const otros = NCF_DOCUMENT_TYPES.map(x => x.code).filter(c => !NF_TIPOS_PRINCIPALES.includes(c));
  const sel = $id('nf-tipo-otro');
  if (sel) {
    sel.innerHTML = '<option value="">Elegir…</option>' +
      otros.map(c => `<option value="${c}">${c} — ${esc(NCF_NOMBRES[c])} · ${esc(_nfEstadoTipo(c).texto)}</option>`).join('');
    sel.value = otros.includes(_nfTipo) ? _nfTipo : '';
    sel.disabled = editando;
  }
  const hidden = $id('nf-tipo-ncf'); if (hidden) hidden.value = _nfTipo;
  setText('nf-rnc-lbl', _nfTipo === 'B01' ? 'RNC / Cédula *' : 'RNC / Cédula');

  const hint = $id('nf-ncf-hint');
  const chip = $id('nf-ncf-chip');
  const chipWrap = $id('nf-ncf-wrap');
  if (editando) {
    if (chip) chip.textContent = facNcfDisplay(_nfEditNcf);
    setText('nf-ncf-chip-lbl', 'NCF asignado:');
    chipWrap?.classList.remove('is-bad');
    if (hint) hint.innerHTML = '';
    return;
  }
  setText('nf-ncf-chip-lbl', 'NCF:');
  const u = _nfSecuenciaUsable(_nfTipo);
  if (chip) chip.textContent = u ? _ncfFmt(_nfTipo, u.nextNumber) : `${_nfTipo} sin secuencia`;
  chipWrap?.classList.toggle('is-bad', !u);
  if (!hint) return;
  if (!u) {
    hint.className = 'fm-aviso fm-aviso--error';
    hint.innerHTML = `No tienes una secuencia ${_nfTipo} activa para emitir este comprobante.
      <button type="button" class="btn btn-secondary btn-sm" data-icono="plus" onclick="app.abrirRegistrarMiNcfModal()">Agregar secuencia</button>`;
    return;
  }
  const e = _ncfEstado(u);
  hint.className = 'fm-aviso';
  hint.innerHTML = e.alertas.length ? esc(`${_nfTipo}: ${e.alertas.join(' ')}`) : '';
}

function nfElegirTipo(tipo) {
  if (!tipo || _facEditId) return;
  _nfTipo = tipo;
  _nfTipoManual = true;
  _nfPintarTipos();
  nfActualizarPie();
}

// Lo que falta para emitir: { campo, msg, pie } (pie = texto corto del pie).
function _nfProblemas() {
  const get = (id) => ($id(id)?.value || '').trim();
  const out = [];
  if (!_facEditId && !_nfSecuenciaUsable(_nfTipo)) {
    out.push({ campo: null, msg: `No tienes una secuencia ${_nfTipo} activa. Agrégala o elige otro tipo de comprobante.` });
  }
  const rnc = get('nf-cli-rnc').replace(/\D/g, '');
  if (_nfTipo === 'B01' && rnc.length !== 9 && rnc.length !== 11) {
    out.push({ campo: 'nf-cli-rnc', msg: rnc ? 'El RNC tiene 9 dígitos y la cédula 11.' : 'El B01 requiere el RNC o cédula del cliente.',
      pie: 'Falta el RNC del cliente para emitir un B01.' });
  } else if (rnc && rnc.length !== 9 && rnc.length !== 11) {
    out.push({ campo: 'nf-cli-rnc', msg: 'El RNC tiene 9 dígitos y la cédula 11.' });
  }
  if (!get('nf-cli-nombre')) out.push({ campo: 'nf-cli-nombre', msg: 'Escribe el nombre o la razón social del cliente.', pie: 'Falta el nombre del cliente.' });
  const correo = get('nf-cli-correo');
  if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) out.push({ campo: 'nf-cli-correo', msg: 'Ese correo no es válido.' });
  const utiles = _docItemsUtiles(_facItems);
  if (!utiles.some(i => Number(i.precio) > 0)) {
    out.push({ campo: 'nf-items', msg: 'Agrega al menos un servicio con precio.', pie: 'Agrega al menos un servicio con precio.' });
  } else if (utiles.some(i => Number(i.precio) > 0 && !String(i.descripcion || '').trim())) {
    out.push({ campo: 'nf-items', msg: 'Cada línea con precio necesita una descripción.' });
  }
  if (!get('nf-fecha')) out.push({ campo: 'nf-fecha', msg: 'Indica la fecha de emisión.' });
  return out;
}

function _nfPintarEnvio() {
  const bloque = $id('nf-enviar-bloque');
  if (bloque) bloque.style.display = _facEditId ? 'none' : '';
  const correo = ($id('nf-cli-correo')?.value || '').trim();
  const tel = ($id('nf-cli-tel')?.value || '').replace(/\D/g, '');
  const chkC = $id('nf-enviar-correo');
  const chkW = $id('nf-enviar-wa');
  const okCorreo = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo);
  const okTel = tel.length >= 10;
  if (chkC) { chkC.disabled = !okCorreo; if (!okCorreo) chkC.checked = false; }
  if (chkW) { chkW.disabled = !okTel; if (!okTel) chkW.checked = false; }
  setText('nf-enviar-ayuda', !okCorreo && !okTel ? 'Escribe el correo o el teléfono del cliente para enviarle la factura.'
    : !okCorreo ? 'Sin correo del cliente: solo WhatsApp.' : !okTel ? 'Sin teléfono del cliente: solo correo.' : '');
}

function nfActualizarPie() {
  _docPintarTotales('nf');
  const probs = _nfProblemas();
  const msg = $id('nf-msg');
  if (msg) {
    msg.textContent = probs[0] ? (probs[0].pie || probs[0].msg)
      : (_facEditId ? 'El NCF y el tipo de comprobante no cambian al editar.' : '');
    msg.classList.toggle('is-error', Boolean(probs.length && _nfIntento));
  }
  const btn = $id('nf-btn-guardar');
  // El NCF que se asigna ya se ve arriba, en la etiqueta "NCF:".
  if (btn && !btn.disabled) _btnTexto(btn, _facEditId ? 'Guardar cambios' : 'Emitir factura');
  if (_nfIntento) {
    _fmLimpiar('nf-form');
    probs.forEach(p => { if (p.campo) _fmError(p.campo, p.msg); });
    _docAbrirMasSiError('nf-mas');
  }
  _nfPintarEnvio();
}

// Cambia el texto de un botón sin perder su ícono (data-icono).
function _btnTexto(btn, txt) {
  if (!btn || btn.textContent.trim() === txt) return;
  btn.textContent = txt;
  if (btn.dataset.icono && window.TcIconos) {
    btn.insertAdjacentHTML('afterbegin', window.TcIconos.svg(btn.dataset.icono, Number(btn.dataset.iconoTam) || 16, 'tc-icono'));
  }
}

// "Más opciones" se abre solo si un campo de adentro (la fecha) tiene error.
function _docAbrirMasSiError(id) {
  const mas = $id(id);
  if (mas && !mas.open && mas.querySelector('.fm-campo.is-invalido')) mas.open = true;
}

// opts.enfocar = false cuando se abre con datos ya puestos (editar, desde una
// cotización o desde Mis clientes): así no se abre el buscador encima.
async function nuevaFactura(opts) {
  const enfocar = opts?.enfocar !== false;
  _facEditId = null;
  _nfEditNcf = null;
  _facDesdeCot = null;
  _nfIntento = false;
  _nfTipoManual = false;
  setText('nf-titulo', 'Nueva factura');
  setText('nf-sub', 'Honorarios de tu despacho');
  const mas = $id('nf-mas'); if (mas) mas.open = false;

  _facItems = [_docNuevaLinea()];
  const set = (id, v) => { const el = $id(id); if (el) el.value = v; };
  set('nf-fecha', hoyLocal());
  ['nf-cli-nombre', 'nf-cli-rnc', 'nf-cli-dir', 'nf-cli-tel', 'nf-cli-correo', 'nf-observacion'].forEach(id => set(id, ''));
  setText('nf-rnc-ayuda', '');
  $id('nf-cli-resultados')?.classList.add('hidden');
  const chkCli = $id('nf-guardar-cliente'); if (chkCli) chkCli.checked = false;
  _mostrarCheckGuardarCliente('nf', '');
  ['nf-enviar-correo', 'nf-enviar-wa'].forEach(id => { const el = $id(id); if (el) el.checked = false; });
  set('nf-metodo', 'efectivo');
  docElegirCondicion('nf', 'contado');
  _fmLimpiar('nf-form');

  // Autocompletado de la DGII al escribir el RNC (además del botón).
  if (window.RNCLookup) {
    const rncEl = $id('nf-cli-rnc');
    if (rncEl) RNCLookup.attach(rncEl, { nameEl: $id('nf-cli-nombre'), mode: 'both', onSelect() { nfActualizarPie(); } });
  }

  await _docCargarClientes('nf');
  // Secuencias y tipo por defecto: uno que SÍ tenga rango activo.
  try { _misNcf = await apiCall('GET', '/api/mis-secuencias-ncf'); } catch { _misNcf = _misNcf || []; }
  _nfTipo = _facPickDefaultNcf(false);

  _docPintarPlantillas('nf');
  renderDocItems('nf');
  _nfPintarTipos();
  show('modal-nueva-factura');
  $id('nf-form')?.scrollTo(0, 0);
  nfActualizarPie();
  if (enfocar) setTimeout(() => $id('nf-cli-rnc')?.focus(), 50);
}

// Tipos de NCF con una secuencia utilizable (activa, no vencida, con números).
function _facNcfUsables() {
  return [...new Set((_misNcf || [])
    .filter(s => (s.effectiveStatus || s.status) === 'activo' && Number(s.totalAvailable ?? 1) > 0)
    .map(s => s.documentType))];
}

function _facPickDefaultNcf(conRnc) {
  const usables = _facNcfUsables();
  const orden = conRnc
    ? ['B01', 'B02', 'B15', 'B14', 'B16', 'B03', 'B04', 'B11', 'B12', 'B13', 'B17']
    : ['B02', 'B01', 'B15', 'B14', 'B16', 'B03', 'B04', 'B11', 'B12', 'B13', 'B17'];
  return orden.find(t => usables.includes(t)) || usables[0] || (conRnc ? 'B01' : 'B02');
}

function cerrarNuevaFactura() { _facEditId = null; _facDesdeCot = null; hide('modal-nueva-factura'); }

// Reabrir el formulario con una factura existente para editarla (solo pendiente).
async function editarFactura(id) {
  try {
    const f = await apiCall('GET', `/api/facturacion/facturas/${id}`);
    if (f.estado !== 'pendiente' || Number(f.monto_pagado || 0) > 0) {
      toast('Solo se puede editar una factura pendiente y sin pagos.', 'error');
      return;
    }
    await nuevaFactura({ enfocar: false });   // arranca el modal en limpio y carga los clientes
    _facEditId = id;
    _nfEditNcf = f.ncf;
    _nfTipo = f.tipo_ncf || 'B02';

    const set = (fid, v) => { const el = $id(fid); if (el) el.value = v == null ? '' : v; };
    set('nf-cli-nombre', f.cliente?.nombre);
    set('nf-cli-rnc',    f.cliente?.rnc);
    set('nf-cli-dir',    f.cliente?.direccion);
    set('nf-cli-tel',    f.cliente?.telefono);
    set('nf-cli-correo', f.cliente?.correo);
    set('nf-fecha',      (f.fecha || '').slice(0, 10));
    set('nf-metodo',     f.metodo_pago || 'efectivo');
    set('nf-observacion', f.observacion || '');
    docElegirCondicion('nf', f.condicion_pago || 'contado');

    _facItems = (f.items || []).map(it => _docNuevaLinea(it));
    if (!_facItems.length) _facItems = [_docNuevaLinea()];

    setText('nf-titulo', `Editar factura ${facNcfDisplay(f.ncf)}`);
    setText('nf-sub', 'Solo mientras esté pendiente y sin cobros');
    renderDocItems('nf');
    _nfPintarTipos();
    nfActualizarPie();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function selClienteFac(val) {
  _mostrarCheckGuardarCliente('nf', val);
  if (!val) return;
  const set = (fid, v) => { const el = $id(fid); if (el) el.value = v || ''; };

  if (val.startsWith('fac_')) {
    const c = _facClientes.find(x => x.id === val.slice(4));
    if (!c) return;
    set('nf-cli-nombre', c.nombre);
    set('nf-cli-rnc',    c.rnc);
    set('nf-cli-dir',    c.direccion);
    set('nf-cli-tel',    c.telefono);
    set('nf-cli-correo', c.correo);
  } else if (val.startsWith('neg_')) {
    const id = val.slice(4);
    let n = _allClientes.find(x => x.id === id);
    try { n = await apiCall('GET', `/api/clientes/${id}`); } catch { /* usa el de caché */ }
    if (!n) return;
    set('nf-cli-nombre', n.razon_social || n.businessName || n.businessKey || '');
    set('nf-cli-rnc',    n.rnc || '');
    set('nf-cli-dir',    n.direccion || n.businessAddress || '');
    set('nf-cli-tel',    n.telefono || n.phone || '');
    set('nf-cli-correo', n.correo || n.email || n.ownerEmail || '');
  }

  // Tipo de NCF por defecto según si ya hay RNC (si el contador no lo eligió).
  if (!_facEditId && !_nfTipoManual) {
    _nfTipo = _facPickDefaultNcf(!!($id('nf-cli-rnc')?.value || '').trim());
  }
}

// Nombres viejos (siguen en window.app): ahora todo pasa por el formulario común.
function facItemSet(idx, field, value) { docItemSet('nf', idx, field, value); }
function addItemFac() { docAddItem('nf'); }
function removeItemFac(idx) { docRemoveItem('nf', idx); }

// Factura armada con lo que hay en el formulario (vista previa antes de emitir).
function _nfFacturaTemporal() {
  const get = id => ($id(id)?.value || '').trim();
  const items = _docItemsUtiles(_facItems).map(it => {
    const base = (Number(it.precio) || 0) * Math.max(1, Number(it.cantidad) || 1);
    const desc = base * ((Number(it.descuento) || 0) / 100);
    const itbis = (base - desc) * ((Number(it.itbis_rate) || 0) / 100);
    return { ...it, itbis: _r2(itbis), total: _r2(base - desc + itbis) };
  });
  const t = _docTotales(items);
  const u = _nfSecuenciaUsable(_nfTipo);
  return {
    ncf: _facEditId ? _nfEditNcf : (u ? _ncfFmt(_nfTipo, u.nextNumber) : `${_nfTipo}00000000`),
    tipo_ncf: _nfTipo, tipo_ncf_label: NCF_DOCUMENT_TYPES.find(x => x.code === _nfTipo)?.label || _nfTipo,
    ncf_vencimiento: u?.expirationDate || null,
    fecha: get('nf-fecha') || hoyLocal(),
    cliente: { nombre: get('nf-cli-nombre'), rnc: get('nf-cli-rnc'), direccion: get('nf-cli-dir'), telefono: get('nf-cli-tel'), correo: get('nf-cli-correo') },
    items, subtotal: t.subtotal, descuento_total: t.descuentos, itbis_total: t.itbis, total: t.total,
    monto_pagado: 0, balance: t.total, estado: 'pendiente',
    condicion_pago: get('nf-condicion') || 'contado', metodo_pago: get('nf-metodo') || 'efectivo', observacion: get('nf-observacion'),
  };
}

async function vistaPreviaFactura() {
  if (!window.contadoresAPI?.isElectron) { toast('La vista previa solo está disponible en la app de escritorio.', 'error'); return; }
  try {
    const r = await window.contadoresAPI.previewPrint(facturaFormalHtml(_nfFacturaTemporal()), 'Vista previa de la factura', 'Vista_previa_factura.pdf');
    if (!r?.ok) toast('Error al abrir la vista previa: ' + (r?.error || 'desconocido'), 'error');
  } catch (_) { toast('Error al abrir la vista previa.', 'error'); }
}

// "Enviar al emitir": correo con el PDF y/o enlace de WhatsApp.
async function _nfEnviarAlEmitir(f, { correo, whatsapp }) {
  if (whatsapp && f.cliente?.telefono) {
    const tel = String(f.cliente.telefono).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    const msg = encodeURIComponent(`Hola ${f.cliente?.nombre || ''}, le enviamos la factura ${facNcfDisplay(f.ncf)} por ${fmtMoney(f.total)}. Gracias por preferirnos.`);
    window.open(`https://wa.me/1${tel}?text=${msg}`, '_blank');
  }
  if (correo && f.cliente?.correo) {
    const cfg = await ensureEmailCfg();
    if (!cfg.configured || !window.contadoresAPI?.isElectron) { abrirModalEnvioFac(f.id, f.cliente.correo, f); return; }
    try {
      const pdf = await window.contadoresAPI.renderInvoicePdf(facturaFormalHtml(f));
      if (!pdf?.ok) throw new Error(pdf?.error || 'No se pudo generar el PDF.');
      const r = await apiCall('POST', `/api/facturacion/facturas/${f.id}/enviar`, { to: f.cliente.correo, mensaje: '', pdfBase64: pdf.base64 });
      toast(`Factura enviada a ${r.to}.`, 'success');
    } catch (e) {
      toast('La factura se emitió, pero el correo no salió: ' + e.message, 'error');
    }
  }
}

async function guardarFactura() {
  _nfIntento = true;
  const probs = _nfProblemas();
  nfActualizarPie();
  if (probs.length) {
    const primero = probs.find(p => p.campo && p.campo !== 'nf-items');
    if (primero) $id(primero.campo)?.focus();
    return;
  }

  const btn = $id('nf-btn-guardar');
  const esEdicion = !!_facEditId;
  if (btn) { btn.disabled = true; _btnTexto(btn, esEdicion ? 'Guardando…' : 'Emitiendo…'); }
  const get = id => ($id(id)?.value || '').trim();
  const cliente = {
    nombre: get('nf-cli-nombre'), rnc: get('nf-cli-rnc'),
    direccion: get('nf-cli-dir'), telefono: get('nf-cli-tel'), correo: get('nf-cli-correo'),
  };
  const envio = { correo: Boolean($id('nf-enviar-correo')?.checked), whatsapp: Boolean($id('nf-enviar-wa')?.checked) };
  const desdeCot = _facDesdeCot;
  try {
    const payload = {
      cliente,
      fecha:          get('nf-fecha'),
      condicion_pago: get('nf-condicion') || 'contado',
      metodo_pago:    get('nf-metodo'),
      observacion:    get('nf-observacion'),
      items: _docItemsUtiles(_facItems),
    };

    const editandoId = _facEditId;
    let nueva = null;
    if (esEdicion) {
      await apiCall('PUT', `/api/facturacion/facturas/${editandoId}`, payload);
    } else {
      payload.tipo_ncf = _nfTipo;
      if (desdeCot) payload.cotizacion_id = desdeCot.id;
      nueva = await apiCall('POST', '/api/facturacion/facturas', payload);
    }
    const guardado = $id('nf-guardar-cliente')?.checked && $id('nf-guardar-cliente-row')?.style.display !== 'none'
      ? await _guardarEnMisClientes(cliente, _facClientes) : '';
    toast((esEdicion ? 'Factura actualizada.'
      : `Factura ${facNcfDisplay(nueva?.ncf)} emitida${desdeCot ? ` desde la cotización ${desdeCot.numero}` : ''}.`) + _textoGuardadoCliente(guardado), 'success');

    _facEditId = null;
    _facDesdeCot = null;
    hide('modal-nueva-factura');
    loadFacturacion();
    if ($id('mod-mis-clientes')?.classList.contains('active')) loadMisClientes();
    if (desdeCot && $id('mod-cotizaciones')?.classList.contains('active')) loadCotizaciones();
    if (esEdicion && editandoId) verFactura(editandoId);
    if (nueva) _nfEnviarAlEmitir(nueva, envio);
  } catch (e) {
    // El error va donde corresponde: RNC, secuencia o el pie.
    if (/RNC|cédula/i.test(e.message)) _fmError('nf-cli-rnc', e.message);
    else if (/secuencia/i.test(e.message)) { try { _misNcf = await apiCall('GET', '/api/mis-secuencias-ncf'); } catch { /* sigue */ } _nfPintarTipos(); }
    const msg = $id('nf-msg');
    if (msg) { msg.textContent = e.message; msg.classList.add('is-error'); }
  } finally {
    if (btn) {
      btn.disabled = false;
      _btnTexto(btn, esEdicion ? 'Guardar cambios' : 'Emitir factura');
    }
  }
}

// ── Detalle de Factura (página completa, estilo panel admin) ───────────

const _FAC_NCF_LABELS = Object.fromEntries(
  NCF_DOCUMENT_TYPES.map((t) => [t.code, t.label.replace(/^B\d+\s*—\s*/, '')])
);

function _showFacDetalle() {
  document.querySelectorAll('.module').forEach(el => el.classList.remove('active'));
  const el = $id('mod-fac-detalle');
  if (el) el.classList.add('active');
  _pintarTopbar('fac-detalle');
}

function backToFacturas() { goto('facturacion'); }
function cerrarVerFactura() { goto('facturacion'); }

async function verFactura(id) {
  _facCurId = id; _facCurData = null;
  setText('fd-numero', 'Cargando…');
  ['fd-info', 'fd-actions', 'fd-totales', 'fd-items', 'fd-pagos', 'fd-email-info'].forEach(x => { const e = $id(x); if (e) e.innerHTML = ''; });
  _showFacDetalle();

  try {
    const f = await apiCall('GET', `/api/facturacion/facturas/${id}`);
    _facCurData = f;
    const money = n => 'RD$ ' + (Number(n) || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const balance = Number(f.balance ?? ((f.total || 0) - (f.monto_pagado || 0)));

    setText('fd-numero', facNcfDisplay(f.ncf));

    $id('fd-info').innerHTML = `
      <dl class="info-dl">
        <dt>NCF</dt><dd><code>${facNcfDisplay(f.ncf)}</code>${f.tipo_ncf ? ` · ${_FAC_NCF_LABELS[f.tipo_ncf] || f.tipo_ncf} (${f.tipo_ncf})` : ''}</dd>
        <dt>NCF válido hasta</dt><dd>${f.ncf_vencimiento ? _fmtFechaSolo(f.ncf_vencimiento) : '—'}</dd>
        <dt>Cliente</dt><dd>${esc(f.cliente?.nombre) || '—'}</dd>
        <dt>RNC / Cédula</dt><dd>${f.cliente?.rnc || '—'}</dd>
        <dt>Teléfono</dt><dd>${f.cliente?.telefono || '—'}</dd>
        <dt>Correo</dt><dd>${f.cliente?.correo || '—'}</dd>
        <dt>Dirección</dt><dd>${esc(f.cliente?.direccion) || '—'}</dd>
        <dt>Estado</dt><dd>${facEstadoBadge(f.estado)}</dd>
        <dt>Emisión</dt><dd>${fmtDate(f.fecha)}</dd>
        <dt>Condición / Método</dt><dd>${esc(f.condicion_pago || '—')} · ${esc(f.metodo_pago || '—')}</dd>
      </dl>`;

    $id('fd-items').innerHTML = (f.items || []).map(it => `
      <tr>
        <td style="text-align:center">${it.cantidad}</td>
        <td>${esc(it.descripcion) || '—'}</td>
        <td style="text-align:right">${money(it.precio)}</td>
        <td style="text-align:center">${Number(it.descuento) > 0 ? it.descuento + '%' : '—'}</td>
        <td style="text-align:center">${Number(it.itbis_rate) > 0 ? it.itbis_rate + '%' : '—'}</td>
        <td style="text-align:right">${money(it.total)}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="td-empty">Sin ítems</td></tr>';

    $id('fd-totales').innerHTML = `
      Subtotal: ${money(f.subtotal)}<br>
      ${Number(f.descuento_total) > 0 ? `Descuento: − ${money(f.descuento_total)}<br>` : ''}
      ITBIS: ${money(f.itbis_total)}<br>
      <strong>Total: ${money(f.total)}</strong><br>
      ${Number(f.monto_pagado) > 0 ? `Pagado: ${money(f.monto_pagado)}<br>` : ''}
      ${balance > 0.009 && f.estado !== 'anulada' ? `<span style="color:var(--orange)">Saldo pendiente: ${money(balance)}</span>` : ''}`;

    const editable = f.estado === 'pendiente' && Number(f.monto_pagado || 0) === 0;
    const cobrable = ['pendiente', 'parcial'].includes(f.estado);
    const conRecibo = reciboConfig().activo && f.estado !== 'anulada';
    const pagosRecibo = _reciboPagos(f);
    const acc = [];
    if (cobrable) acc.push(`<button class="btn btn-primary btn-sm" data-icono="banknote" onclick="app.openRegistrarPagoFac()">Registrar cobro</button>`);
    if (conRecibo && pagosRecibo.length) acc.push(`<button class="btn btn-secondary btn-sm" data-icono="printer" onclick="app.reciboDePago(${pagosRecibo.length - 1})">Recibo del último pago</button>`);
    if (editable) acc.push(`<button class="btn btn-secondary btn-sm" data-icono="pencil" onclick="app.editarFactura('${f.id}')">Editar</button>`);
    acc.push(`<button class="btn btn-secondary btn-sm" data-icono="copy" onclick="app.duplicarFactura('${f.id}')">Duplicar</button>`);
    acc.push(`<button class="btn btn-secondary btn-sm" data-icono="download" onclick="app.imprimirFactura()">Descargar PDF</button>`);
    acc.push(`<button class="btn btn-secondary btn-sm" data-icono="printer" onclick="app.imprimirFacturaPreview()">Imprimir / Vista previa</button>`);
    acc.push(`<button class="btn btn-secondary btn-sm" data-icono="mail" onclick="app.enviarPorCorreo()">Enviar por correo</button>`);
    if (f.cliente?.telefono) acc.push(`<button class="btn btn-secondary btn-sm" data-icono="message-circle" onclick="app.enviarPorWhatsApp()">WhatsApp</button>`);
    if (f.estado !== 'anulada') acc.push(`<button class="btn btn-danger btn-sm" data-icono="x" onclick="app.anularFactura()">Anular</button>`);
    $id('fd-actions').innerHTML = acc.join('');

    $id('fd-email-info').textContent = f.ultimoEmailA ? `✉ Último envío: ${f.ultimoEmailA} · ${fmtDate(f.ultimoEmailEn)}` : '';

    $id('fd-pagos').innerHTML = pagosRecibo.map((p, i) => `
      <tr><td style="text-align:right">${money(p.monto)}</td><td>${esc(p.metodo) || '—'}</td><td>${fmtDate(p.fecha)}</td><td>${esc(p.nota) || '—'}</td>
        <td style="text-align:right">${conRecibo ? `<button class="btn btn-secondary btn-sm" data-icono="printer" onclick="app.reciboDePago(${i})" title="Imprimir el recibo de este pago">Recibo</button>` : ''}</td></tr>
    `).join('') || '<tr><td colspan="5" class="td-empty">Sin pagos registrados</td></tr>';
  } catch (e) {
    toast('Error cargando factura: ' + e.message, 'error');
    goto('facturacion');
  }
}

// Vista previa formal en ventana nueva + diálogo de impresión (A4).
async function imprimirFacturaPreview() {
  if (!_facCurData) return;
  if (!window.contadoresAPI?.isElectron) {
    toast('Esta función solo está disponible en la app de escritorio.', 'error');
    return;
  }
  try {
    const ncfSlug = (_facCurData.ncf || 'FACTURA').replace(/[^A-Z0-9]/gi, '');
    const clientSlug = (_facCurData.cliente?.nombre || 'cliente').replace(/\s+/g, '_').slice(0, 20);
    const filename = `Factura_${ncfSlug}_${clientSlug}.pdf`;
    const r = await window.contadoresAPI.previewPrint(facturaFormalHtml(_facCurData), `Factura ${facNcfDisplay(_facCurData.ncf)}`, filename);
    if (!r?.ok) toast('Error al abrir la vista previa: ' + (r?.error || 'desconocido'), 'error');
  } catch (e) { toast('Error al abrir la vista previa.', 'error'); }
}

// ── Registrar pago ───────────────────────────────────────────────────
let _pagoDesdeLista = false;   // el cobro se pidió desde la tabla de Facturación

// "Registrar cobro" y "PDF" en cada fila de la tabla de Facturación.
function registrarCobroLista(id) {
  const f = _facFacturas.find(x => x.id === id);
  if (!f) return;
  _facCurId = id; _facCurData = f; _pagoDesdeLista = true;
  openRegistrarPagoFac();
}

async function pdfFacturaLista(id) {
  let f = _facFacturas.find(x => x.id === id);
  if (!f) return;
  if (!f.ncf_vencimiento) {
    try { f = await apiCall('GET', `/api/facturacion/facturas/${id}`); } catch { /* usa la de la lista */ }
  }
  const ncfSlug = (f.ncf || 'FACTURA').replace(/[^A-Z0-9]/gi, '');
  const clientSlug = (f.cliente?.nombre || 'cliente').replace(/\s+/g, '_').slice(0, 20);
  await _savePdf(facturaFormalHtml(f), `Factura_${ncfSlug}_${clientSlug}.pdf`, false, { factura: true });
}

function openRegistrarPagoFac() {
  if (!_facCurData) return;
  const bal = Number(_facCurData.balance ?? ((_facCurData.total || 0) - (_facCurData.monto_pagado || 0)));
  setText('fp-saldo-lbl', `Saldo pendiente: RD$ ${bal.toLocaleString('es-DO', { minimumFractionDigits: 2 })}`);
  $id('fp-monto').value = bal > 0 ? bal.toFixed(2) : '';
  $id('fp-metodo').value = _facCurData.metodo_pago || 'efectivo';
  $id('fp-nota').value = '';
  show('modal-fac-pago');
}
function cerrarRegistrarPagoFac() { _pagoDesdeLista = false; hide('modal-fac-pago'); }

async function registrarPagoFac() {
  if (!_facCurId) return;
  const monto = Number($id('fp-monto')?.value);
  const saldo = Number(_facCurData?.balance ?? ((_facCurData?.total || 0) - (_facCurData?.monto_pagado || 0)));
  _fmError('fp-monto', '');
  if (!Number.isFinite(monto) || monto <= 0) { _fmError('fp-monto', 'Escribe un monto mayor que 0.'); return; }
  if (saldo > 0 && monto > saldo + 0.01) { _fmError('fp-monto', `No puede pasar del saldo pendiente (${fmtMoney(saldo)}).`); return; }
  const btn = $id('fp-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
  const facturaId = _facCurId;
  try {
    await apiCall('PUT', `/api/facturacion/facturas/${facturaId}`, {
      pago: { monto, metodo: $id('fp-metodo')?.value || 'efectivo', nota: $id('fp-nota')?.value || '' },
    });
    hide('modal-fac-pago');
    toast('Pago registrado.', 'success');
    if (!_pagoDesdeLista) verFactura(facturaId);
    _pagoDesdeLista = false;
    loadFacturacion();
    _reciboTrasCobro(facturaId);
  } catch (e) { _fmError('fp-monto', e.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Registrar'; } }
}

// ══════════════════════════════════════════════════════════════════════
// RECIBO DE PAGO (impresora térmica, opcional)
// Configuración → Recibo de pago: activarlo, la impresora (de esta PC), el
// ancho (80 o 58 mm), qué hacer al registrar un cobro y las copias. Se
// guarda en esta computadora. El botón "Recibo" sale en la tabla de
// Facturación (último pago) y en cada pago del detalle de la factura. Sin
// impresora elegida se abre la vista previa con la ventana de imprimir.
// ══════════════════════════════════════════════════════════════════════

const RECIBO_CLAVE = 'tc-recibo-pago';
const RECIBO_POR_DEFECTO = { activo: false, impresora: '', ancho: 80, alCobrar: 'preguntar', copias: 1, logo: true };
const RECIBO_METODOS = { efectivo: 'Efectivo', transferencia: 'Transferencia', tarjeta: 'Tarjeta', cheque: 'Cheque', deposito: 'Depósito', credito: 'Crédito' };

function reciboConfig() {
  try {
    return { ...RECIBO_POR_DEFECTO, ...JSON.parse(localStorage.getItem(RECIBO_CLAVE) || '{}') };
  } catch (_) {
    return { ...RECIBO_POR_DEFECTO };
  }
}

function _reciboGuardar(cfg) {
  try { localStorage.setItem(RECIBO_CLAVE, JSON.stringify(cfg)); } catch (_) { /* solo vale por esta sesión */ }
}

// Pagos de la factura. Una marcada "pagada" a mano (o al contado) puede no
// tener la lista: cuenta como un solo pago por lo cobrado.
function _reciboPagos(f) {
  const pagos = Array.isArray(f?.pagos) ? f.pagos.filter((p) => Number(p.monto) > 0) : [];
  if (pagos.length) return pagos;
  const pagado = Number(f?.monto_pagado || 0);
  return pagado > 0 ? [{ monto: pagado, metodo: f.metodo_pago || 'efectivo', fecha: f.updatedAt || f.fecha, nota: '' }] : [];
}

// Datos de un recibo: el pago `indice` (por defecto el último) de la factura.
function reciboPagoDatos(f, indice) {
  const pagos = _reciboPagos(f);
  if (!pagos.length) return null;
  const i = Number.isInteger(indice) && indice >= 0 && indice < pagos.length ? indice : pagos.length - 1;
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const anteriores = r2(pagos.slice(0, i).reduce((s, p) => s + Number(p.monto || 0), 0));
  const monto = r2(pagos[i].monto);
  const total = r2(f.total);
  const saldo = Math.max(0, r2(total - anteriores - monto));
  // Por qué paga: lo que se facturó (hasta 6 líneas).
  const lineas = (Array.isArray(f.items) ? f.items : []).filter((it) => String(it.descripcion || '').trim());
  const concepto = lineas.slice(0, 6).map((it) => `${Number(it.cantidad) > 1 ? `${Number(it.cantidad)} x ` : ''}${String(it.descripcion).trim()}`);
  if (lineas.length > 6) concepto.push(`y ${lineas.length - 6} más`);
  return {
    numero: `${String(f.ncf || 'FACT').replace(/[^A-Z0-9]/gi, '')}-${String(i + 1).padStart(2, '0')}`,
    fecha: pagos[i].fecha || new Date().toISOString(),
    cliente: f.cliente?.nombre || 'Cliente',
    rnc: f.cliente?.rnc || '',
    ncf: facNcfDisplay(f.ncf),
    total, anteriores, monto, saldo,
    saldada: saldo <= 0.009,
    metodo: RECIBO_METODOS[String(pagos[i].metodo || '').toLowerCase()] || pagos[i].metodo || 'Efectivo',
    nota: pagos[i].nota || '',
    concepto,
    pagoNumero: i + 1,
    pagosTotal: pagos.length,
  };
}

// Recibo para impresora térmica: letra negra sobre blanco, sin colores, del
// ancho imprimible del rollo (72 mm en 80 mm, 48 mm en 58 mm). logo: el de
// _reciboLogoVista (como sale en el papel); sin pasarlo usa el de la firma.
function reciboPagoHtml(d, perfil, ancho = 80, logo) {
  const e = (t) => esc(t == null ? '' : String(t));
  const dinero = (n) => (Number(n) || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const angosto = Number(ancho) === 58;
  const util = angosto ? 48 : 72;
  const fecha = (() => {
    const f = new Date(d.fecha);
    return Number.isNaN(f.getTime()) ? '' : `${hoyLocal(f).split('-').reverse().join('/')} ${f.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}`;
  })();
  const letras = window.FacturaPlantillas?.montoEnLetras ? window.FacturaPlantillas.montoEnLetras(d.monto) : '';
  const fila = (k, v, clase = '') => `<div class="fila ${clase}"><span>${k}</span><span>${v}</span></div>`;
  const firma = perfil || {};
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Recibo ${e(d.numero)}</title><style>
    @page { size: ${angosto ? 58 : 80}mm auto; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { background: #fff; }
    body { width: ${util}mm; margin: 0 auto; padding: 3mm 0 6mm; font-family: Arial, Helvetica, sans-serif; font-size: ${angosto ? 10.5 : 11.5}px; line-height: 1.35; color: #000; }
    .c { text-align: center; }
    .logo { display: block; max-width: ${angosto ? 30 : 40}mm; max-height: 16mm; margin: 0 auto 2mm; filter: grayscale(1); }
    .firma { font-size: ${angosto ? 13 : 14.5}px; font-weight: 800; }
    .titulo { margin: 2mm 0 1mm; font-size: ${angosto ? 13 : 15}px; font-weight: 800; letter-spacing: 1px; }
    .linea { border-top: 1px dashed #000; margin: 2mm 0; }
    .fila { display: flex; justify-content: space-between; gap: 2mm; }
    .fila > span:last-child { text-align: right; white-space: nowrap; }
    .b { font-weight: 700; }
    .grande { font-size: ${angosto ? 14 : 16}px; font-weight: 800; }
    .caja { border: 1.5px solid #000; padding: 1.5mm 2mm; margin: 2mm 0; }
    ${angosto ? '.caja .fila { flex-direction: column; gap: 0; } .caja .fila > span:last-child { text-align: left; }' : ''}
    .letras { font-size: ${angosto ? 9 : 10}px; margin-top: 1mm; }
    .firma-linea { margin: 9mm 6mm 1mm; border-top: 1px solid #000; }
    .concepto { padding-left: 2mm; text-indent: -2mm; }
    .pie { font-size: ${angosto ? 9.5 : 10.5}px; }
  </style></head><body>
    ${logo ? `<img class="logo" src="${e(logo.src)}" style="width:${logo.mm}mm;max-height:none" alt="">`
      : logo === undefined && firma.logo_url && reciboConfig().logo ? `<img class="logo" src="${e(firma.logo_url)}" alt="">` : ''}
    <div class="c firma">${e(firma.nombre_firma || 'Recibo de pago')}</div>
    <div class="c pie">${[firma.rnc ? `RNC ${e(firma.rnc)}` : '', e(firma.telefono)].filter(Boolean).join(' · ')}</div>
    ${firma.direccion ? `<div class="c pie">${e(firma.direccion)}</div>` : ''}
    <div class="c titulo">RECIBO DE PAGO</div>
    <div class="c">No. ${e(d.numero)}</div>
    <div class="c">${e(fecha)}</div>
    <div class="linea"></div>
    <div>Recibimos de:</div>
    <div class="b">${e(d.cliente)}</div>
    ${d.rnc ? `<div>RNC / Cédula: ${e(d.rnc)}</div>` : ''}
    <div class="linea"></div>
    ${(d.concepto || []).length ? `<div>Por concepto de:</div>${d.concepto.map((c) => `<div class="concepto">- ${e(c)}</div>`).join('')}<div class="linea"></div>` : ''}
    ${fila('Factura', e(d.ncf))}
    ${fila('Total factura', dinero(d.total))}
    ${d.anteriores > 0 ? fila('Pagado antes', dinero(d.anteriores)) : ''}
    <div class="caja">
      ${fila('ESTE PAGO', `RD$ ${dinero(d.monto)}`, 'grande')}
      ${letras ? `<div class="letras">${e(letras)}</div>` : ''}
    </div>
    ${fila('Forma de pago', e(d.metodo))}
    ${d.pagosTotal > 1 ? fila('Pago', `${d.pagoNumero} de ${d.pagosTotal}`) : ''}
    ${d.saldada ? '<div class="c b" style="margin-top:2mm">FACTURA SALDADA</div>' : fila('Saldo pendiente', `RD$ ${dinero(d.saldo)}`, 'b')}
    ${d.nota ? `<div class="linea"></div><div>Nota del pago: ${e(d.nota)}</div>` : ''}
    <div class="firma-linea"></div>
    <div class="c pie">Recibido por</div>
    <div class="linea"></div>
    <div class="c pie">¡Gracias por su pago!</div>
  </body></html>`;
}

// Logo de la firma en puntos de térmica (1 bit por punto), como el del ticket
// del POS (convertLogoToEscposMonochrome en js/ventas.js): sin los bordes
// blancos y a lo sumo maxAncho × maxAlto puntos (203 puntos = 1 pulgada).
// Un logo sobre fondo oscuro (estilo ícono de app) se invierte: el fondo queda
// blanco y el dibujo negro. Sin eso salía un cuadro casi todo negro que la
// térmica no imprimía. Si aun así queda más de la mitad en negro, no se pone.
const _reciboLogoCache = new Map();
const RECIBO_LOGO_MAX_NEGRO = 0.5;

function _reciboLogoMono(dataUrl, maxAncho, maxAlto) {
  if (!dataUrl) return Promise.resolve(null);
  const clave = `${maxAncho}x${maxAlto}:${dataUrl}`;
  if (!_reciboLogoCache.has(clave)) _reciboLogoCache.set(clave, _reciboLogoMonoSinCache(dataUrl, maxAncho, maxAlto));
  return _reciboLogoCache.get(clave);
}

function _reciboLogoMonoSinCache(dataUrl, maxAncho, maxAlto) {
  return new Promise((resolve) => {
    const img = new Image();
    const espera = setTimeout(() => resolve(null), 3000);
    img.onload = () => {
      clearTimeout(espera);
      try {
        const sonda = document.createElement('canvas');
        sonda.width = img.width;
        sonda.height = img.height;
        const sctx = sonda.getContext('2d');
        sctx.drawImage(img, 0, 0);
        const px = sctx.getImageData(0, 0, img.width, img.height).data;
        const gris = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        // ¿Fondo oscuro? Lo dice la orilla de la imagen (lo transparente no cuenta).
        let suma = 0, opacos = 0, orilla = 0;
        for (let y = 0; y < img.height; y += 1) {
          for (let x = 0; x < img.width; x += 1) {
            if (y > 0 && y < img.height - 1 && x > 0 && x < img.width - 1) continue;
            orilla += 1;
            const i = (y * img.width + x) * 4;
            if (px[i + 3] < 10) continue;
            suma += gris(px, i);
            opacos += 1;
          }
        }
        const invertir = opacos > orilla / 2 && suma / opacos < 100;
        // Punto negro en el papel: lo oscuro (o lo claro, si se invierte); lo transparente es papel.
        const negro = (d, i) => d[i + 3] >= 128 && (invertir ? gris(d, i) >= 150 : gris(d, i) < 150);
        let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
        for (let y = 0; y < img.height; y += 1) {
          for (let x = 0; x < img.width; x += 1) {
            if (!negro(px, (y * img.width + x) * 4)) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
        if (maxX < minX) { resolve(null); return; } // nada que imprimir
        const cw = maxX - minX + 1;
        const ch = maxY - minY + 1;
        const escala = Math.min(1, maxAncho / cw, maxAlto / ch);
        const w = Math.max(8, Math.round(cw * escala));
        const h = Math.max(1, Math.round(ch * escala));
        const ancho = Math.ceil(w / 8) * 8; // ESC/POS: ancho en múltiplos de 8
        const lienzo = document.createElement('canvas');
        lienzo.width = ancho;
        lienzo.height = h;
        const ctx = lienzo.getContext('2d');
        ctx.drawImage(img, minX, minY, cw, ch, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, ancho, h);
        const bytesPorLinea = ancho / 8;
        const bytes = [];
        let puntos = 0;
        for (let y = 0; y < h; y += 1) {
          for (let bx = 0; bx < bytesPorLinea; bx += 1) {
            let byte = 0;
            for (let bit = 0; bit < 8; bit += 1) {
              if (bx * 8 + bit < w && negro(data, (y * ancho + bx * 8 + bit) * 4)) { byte |= (1 << (7 - bit)); puntos += 1; }
            }
            bytes.push(byte);
          }
        }
        if (puntos > w * h * RECIBO_LOGO_MAX_NEGRO) { resolve(null); return; }
        resolve({ width: ancho, height: h, bytesPerLine: bytesPorLinea, data: bytes });
      } catch (_) {
        resolve(null);
      }
    };
    img.onerror = () => { clearTimeout(espera); resolve(null); };
    img.src = dataUrl;
  });
}

// El logo tal como sale en el papel, para la vista previa ({ src, mm } o null).
async function _reciboLogoVista(angosto) {
  if (!reciboConfig().logo || !_perfil?.logo_url) return null;
  const mono = await _reciboLogoMono(_perfil.logo_url, angosto ? 200 : 280, 140);
  if (!mono) return null;
  const lienzo = document.createElement('canvas');
  lienzo.width = mono.width;
  lienzo.height = mono.height;
  const ctx = lienzo.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, mono.width, mono.height);
  ctx.fillStyle = '#000000';
  mono.data.forEach((byte, n) => {
    const y = Math.floor(n / mono.bytesPerLine);
    const x0 = (n % mono.bytesPerLine) * 8;
    for (let bit = 0; bit < 8; bit += 1) if (byte & (1 << (7 - bit))) ctx.fillRect(x0 + bit, y, 1, 1);
  });
  return { src: lienzo.toDataURL('image/png'), mm: mono.width / 8 }; // 8 puntos por mm
}

// Imprime el recibo del pago `indice` (o el último) de la factura f.
async function imprimirReciboPago(f, indice) {
  const datos = reciboPagoDatos(f, indice);
  if (!datos) { toast('Esta factura todavía no tiene pagos registrados.', 'error'); return false; }
  const cfg = reciboConfig();
  const api = window.contadoresAPI;
  try {
    // En la térmica sale con comandos ESC/POS, como los tickets del POS
    // (electron/recibo-pago.js); el HTML es solo para la vista previa.
    if (api?.printReceipt && cfg.impresora) {
      const angosto = Number(cfg.ancho) === 58;
      const firma = {
        nombre_firma: _perfil?.nombre_firma || '', rnc: _perfil?.rnc || '', telefono: _perfil?.telefono || '', direccion: _perfil?.direccion || '',
        logoMono: cfg.logo && _perfil?.logo_url ? await _reciboLogoMono(_perfil.logo_url, angosto ? 200 : 280, 140) : null,
      };
      const letras = window.FacturaPlantillas?.montoEnLetras ? window.FacturaPlantillas.montoEnLetras(datos.monto) : '';
      const r = await api.printReceipt({ ...datos, letras }, firma, cfg.impresora, cfg.ancho, cfg.copias);
      if (!r?.ok) throw new Error(r?.error || 'La impresora no respondió.');
      toast(`Recibo ${datos.numero} enviado a ${cfg.impresora}.`, 'success');
      return true;
    }
    if (api?.previewPrint) {
      const html = reciboPagoHtml(datos, _perfil, cfg.ancho, await _reciboLogoVista(Number(cfg.ancho) === 58));
      const r = await api.previewPrint(html, `Recibo ${datos.numero}`, `Recibo_${datos.numero}.pdf`);
      if (!r?.ok) throw new Error(r?.error || 'No se pudo abrir la vista previa.');
      return true;
    }
    toast('El recibo se imprime desde la app de escritorio.', 'error');
    return false;
  } catch (e) {
    toast(`No se pudo imprimir el recibo: ${e.message}`, 'error');
    return false;
  }
}

// Botón "Recibo" de la tabla de Facturación: el último pago.
async function reciboFacturaLista(id) {
  const f = _facFacturas.find((x) => x.id === id);
  if (f) await imprimirReciboPago(f);
}

// Botón "Recibo" de un pago en el detalle de la factura.
async function reciboDePago(indice) {
  if (_facCurData) await imprimirReciboPago(_facCurData, Number(indice));
}

// Después de registrar un cobro: según Configuración, pregunta, imprime solo o nada.
async function _reciboTrasCobro(facturaId) {
  const cfg = reciboConfig();
  if (!cfg.activo || cfg.alCobrar === 'no') return;
  if (cfg.alCobrar !== 'auto' && !confirm('Pago registrado. ¿Imprimo el recibo para el cliente?')) return;
  try {
    const f = await apiCall('GET', `/api/facturacion/facturas/${facturaId}`);
    await imprimirReciboPago(f);
  } catch (e) {
    toast(`No se pudo preparar el recibo: ${e.message}`, 'error');
  }
}

// ── Configuración → Recibo de pago ───────────────────────────────────────
async function reciboCargarImpresoras() {
  const sel = $id('cfg-recibo-impresora');
  if (!sel) return;
  const cfg = reciboConfig();
  const api = window.contadoresAPI;
  if (!api?.listPrinters) {
    sel.innerHTML = '<option value="">Solo en la app de escritorio</option>';
    return;
  }
  sel.innerHTML = '<option value="">Buscando impresoras…</option>';
  const r = await api.listPrinters().catch((e) => ({ ok: false, error: e.message, impresoras: [] }));
  const lista = r.impresoras || [];
  const elegida = cfg.impresora && !lista.some((p) => p.nombre === cfg.impresora)
    ? [{ nombre: cfg.impresora, etiqueta: `${cfg.impresora} (no conectada ahora)` }] : [];
  sel.innerHTML = '<option value="">— Ventana de imprimir (sin elegir) —</option>'
    + [...elegida, ...lista].map((p) => `<option value="${esc(p.nombre)}">${esc(p.etiqueta || p.nombre)}${p.predeterminada ? ' · predeterminada' : ''}</option>`).join('');
  sel.value = cfg.impresora || '';
  if (!r.ok) setText('cfg-recibo-estado', `No se pudieron leer las impresoras: ${r.error || ''}`);
}

function reciboPintarConfig() {
  const cfg = reciboConfig();
  const activo = $id('cfg-recibo-activo');
  if (activo) activo.checked = Boolean(cfg.activo);
  const opciones = $id('cfg-recibo-opciones');
  const acciones = $id('cfg-recibo-acciones');
  if (opciones) opciones.classList.toggle('is-apagado', !cfg.activo);
  if (acciones) acciones.style.display = cfg.activo ? '' : 'none';
  document.querySelectorAll('[data-recibo-ancho]').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.reciboAncho) === Number(cfg.ancho))));
  const alCobrar = $id('cfg-recibo-al-cobrar'); if (alCobrar) alCobrar.value = cfg.alCobrar;
  const copias = $id('cfg-recibo-copias'); if (copias) copias.value = String(cfg.copias);
  const logo = $id('cfg-recibo-logo'); if (logo) logo.checked = cfg.logo !== false;
  const imp = $id('cfg-recibo-impresora'); if (imp && imp.options.length) imp.value = cfg.impresora || '';
  _cfgPintarEstados();
}

function reciboGuardarConfig() {
  const cfg = {
    ...reciboConfig(),
    activo: Boolean($id('cfg-recibo-activo')?.checked),
    impresora: $id('cfg-recibo-impresora')?.value || '',
    alCobrar: $id('cfg-recibo-al-cobrar')?.value || 'preguntar',
    copias: Number($id('cfg-recibo-copias')?.value || 1) === 2 ? 2 : 1,
    logo: $id('cfg-recibo-logo') ? Boolean($id('cfg-recibo-logo').checked) : true,
  };
  _reciboGuardar(cfg);
  reciboPintarConfig();
  setText('cfg-recibo-estado', cfg.activo ? 'Guardado en esta computadora.' : 'Recibos de pago apagados.');
  if (typeof facRRenderFacturas === 'function' && $id('facr-fac-tbody')) facRRenderFacturas();
}

function reciboElegirAncho(ancho) {
  _reciboGuardar({ ...reciboConfig(), ancho: Number(ancho) === 58 ? 58 : 80 });
  reciboPintarConfig();
}

// Un recibo de ejemplo con los datos de la firma.
function _reciboEjemplo() {
  return {
    ncf: 'B0100000099', total: 4720, monto_pagado: 3000, metodo_pago: 'efectivo',
    cliente: { nombre: 'Cliente de ejemplo SRL', rnc: '131000000' },
    items: [{ cantidad: 1, descripcion: 'Contabilidad mensual de octubre' }, { cantidad: 1, descripcion: 'Declaración IT-1' }],
    pagos: [
      { monto: 2000, metodo: 'transferencia', fecha: new Date().toISOString() },
      { monto: 1000, metodo: 'efectivo', fecha: new Date().toISOString(), nota: 'Recibo de prueba' },
    ],
  };
}

async function reciboVistaPrevia() {
  const cfg = reciboConfig();
  const html = reciboPagoHtml(reciboPagoDatos(_reciboEjemplo()), _perfil, cfg.ancho, await _reciboLogoVista(Number(cfg.ancho) === 58));
  if (!window.contadoresAPI?.previewPrint) { toast('La vista previa es de la app de escritorio.', 'error'); return; }
  await window.contadoresAPI.previewPrint(html, 'Recibo de pago (ejemplo)', 'Recibo_ejemplo.pdf');
}

async function reciboPrueba() {
  setText('cfg-recibo-estado', 'Imprimiendo…');
  const ok = await imprimirReciboPago(_reciboEjemplo());
  setText('cfg-recibo-estado', ok ? 'Listo. Si no salió, revisa que la impresora esté encendida y con papel.' : '');
}

// Formatea una fecha "YYYY-MM-DD" sin corrimiento por zona horaria.
function _fmtFechaSolo(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  if (!m) return s ? fmtDate(s) : '—';
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${Number(m[3])} ${meses[Number(m[2]) - 1]} ${m[1]}`;
}

// Documento A4 de la factura del contador (vista previa, impresión, PDF y
// adjunto del correo) con la plantilla y el color de Configuración → Diseño
// de la factura — las mismas de la factura A4 del POS (js/factura-contador.js).
function facturaFormalHtml(f) {
  return FacturaContador.documentoHtml(f, _perfil || {});
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

async function duplicarFactura(id) {
  if (!id) return;
  if (!confirm('¿Duplicar esta factura? Se creará una nueva con un NCF distinto (el siguiente de tu secuencia), lista para editar.')) return;
  try {
    const nueva = await apiCall('POST', `/api/facturacion/facturas/${id}/duplicar`);
    toast('Factura duplicada como ' + facNcfDisplay(nueva.ncf) + '.', 'success');
    loadFacturacion();
    verFactura(nueva.id);
  } catch (e) { toast('Error al duplicar: ' + e.message, 'error'); }
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
  const html = facturaFormalHtml(f);
  const ncfSlug = (f.ncf || 'FACTURA').replace(/[^A-Z0-9]/gi, '');
  const clientSlug = (f.cliente?.nombre || 'cliente').replace(/\s+/g, '_').slice(0, 20);
  await _savePdf(html, `Factura_${ncfSlug}_${clientSlug}.pdf`, false, { factura: true });
}

// factura: la hoja A4 de la plantilla trae sus márgenes → PDF sin márgenes.
async function _savePdf(html, filename, landscape, { factura = false } = {}) {
  if (!window.contadoresAPI?.isElectron) {
    toast('Esta función solo está disponible en la app de escritorio.', 'error');
    return;
  }
  try {
    toast('Generando PDF…', 'info');
    const result = factura
      ? await window.contadoresAPI.saveInvoicePdf(html, filename)
      : await window.contadoresAPI.saveReportPdf(html, filename, landscape);
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

let _emailCfg = null;
async function ensureEmailCfg() {
  if (_emailCfg) return _emailCfg;
  try { _emailCfg = await apiCall('GET', '/api/facturacion/config/email'); }
  catch { _emailCfg = { configured: false }; }
  return _emailCfg;
}

let _envioFac = null;   // { id, data }

// Lleva al contador a Configuración → Correo de envío.
function irAConfigurarCorreo() {
  toast('Primero configura tu correo para poder enviar facturas.', 'info');
  irAConfig('correo', 'cfg-email-user');
}

async function abrirModalEnvioFac(id, prefillEmail, data) {
  const cfg = await ensureEmailCfg();

  // Fuera de Electron no podemos generar el PDF → mailto: simple.
  if (!window.contadoresAPI?.isElectron) {
    const f = data || _facFacturas.find(x => x.id === id) || {};
    const asunto = encodeURIComponent(`Factura ${facNcfDisplay(f.ncf)} — ${f.contador_nombre || ''}`);
    const cuerpo = encodeURIComponent(`Estimado/a ${f.cliente?.nombre || 'cliente'},\n\nLe enviamos la factura ${facNcfDisplay(f.ncf)} por RD$ ${(f.total || 0).toFixed(2)}.\n\nGracias por confiar en nosotros.`);
    window.open(`mailto:${prefillEmail || ''}?subject=${asunto}&body=${cuerpo}`);
    return;
  }

  // Sin correo configurado → llevar directo a Configuración (sin abrir el modal).
  if (!cfg.configured) { irAConfigurarCorreo(); return; }

  let f = data;
  if (!f || !f.items) {
    try { f = await apiCall('GET', `/api/facturacion/facturas/${id}`); }
    catch (e) { toast('Error cargando la factura: ' + e.message, 'error'); return; }
  }
  _envioFac = { id, data: f };
  $id('fe-to').value = prefillEmail || f.cliente?.correo || '';
  $id('fe-mensaje').value = '';
  setText('fe-from', `Se envía desde ${cfg.user || 'tu Gmail'} con el PDF adjunto.`);
  show('modal-fac-envio');
}
function cerrarEnvioFac() { hide('modal-fac-envio'); }

async function confirmarEnvioFac() {
  if (!_envioFac) return;
  const to = ($id('fe-to')?.value || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { toast('Escribe un correo de destino válido.', 'error'); return; }

  const btn = $id('fe-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }
  try {
    const html = facturaFormalHtml(_envioFac.data);
    const pdf = await window.contadoresAPI.renderInvoicePdf(html);
    if (!pdf?.ok) throw new Error(pdf?.error || 'No se pudo generar el PDF.');
    const r = await apiCall('POST', `/api/facturacion/facturas/${_envioFac.id}/enviar`, {
      to, mensaje: $id('fe-mensaje')?.value || '', pdfBase64: pdf.base64,
    });
    hide('modal-fac-envio');
    toast(`Factura enviada a ${r.to}.`, 'success');
    if (_facCurId === _envioFac.id) verFactura(_facCurId);
    loadFacturacion();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Enviar'; } }
}

function enviarPorCorreo() {
  if (!_facCurData) return;
  abrirModalEnvioFac(_facCurId, _facCurData.cliente?.correo || '', _facCurData);
}

// Abre una URL en el navegador externo (Electron redirige window.open a shell.openExternal).
function abrirLink(url) { try { window.open(url, '_blank'); } catch (_) {} }

function enviarPorWhatsApp() {
  if (!_facCurData) return;
  const f    = _facCurData;
  const tel  = (f.cliente?.telefono || '').replace(/\D/g, '');
  const msg  = encodeURIComponent(`Hola ${f.cliente?.nombre || ''}! Le informamos que la factura ${facNcfDisplay(f.ncf)} por RD$ ${(f.total||0).toFixed(2)} está lista. Gracias.`);
  window.open(`https://wa.me/1${tel}?text=${msg}`, '_blank');
}

// Acción rápida desde la lista de Facturación.
async function enviarFacturaCorreoLista(id) {
  const f = _facFacturas.find(x => x.id === id);
  abrirModalEnvioFac(id, f?.cliente?.correo || '', null);
}

async function marcarPagadaLista(id) {
  const f = _facFacturas.find(x => x.id === id);
  if (!f) return;
  const saldo = Number(f.balance ?? ((f.total || 0) - (f.monto_pagado || 0)));
  if (saldo <= 0) { toast('Esta factura ya está pagada.', 'info'); return; }
  if (!confirm(`¿Marcar la factura ${facNcfDisplay(f.ncf)} como PAGADA?\nSe registrará el pago de RD$ ${saldo.toFixed(2)}.`)) return;
  try {
    await apiCall('PUT', `/api/facturacion/facturas/${id}`, {
      pago: { monto: saldo, metodo: f.metodo_pago || 'efectivo', nota: 'Pago completo' },
    });
    toast('Factura marcada como pagada.', 'success');
    loadFacturacion();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════
// MIS CLIENTES — clientes guardados del contador (colección clientes_fac).
// Son los mismos del selector "Cliente guardado" de Nueva factura y Nueva
// cotización. Facturas y cotizaciones guardan su propia copia del cliente:
// se cruzan con la ficha por RNC/cédula (solo dígitos) o, si alguno de los
// dos no tiene RNC, por el nombre.
// ══════════════════════════════════════════════════════════════════════

let _mcli             = [];         // clientes guardados
let _mcliFacturas     = [];
let _mcliCotizaciones = [];
let _mcliResumenes    = new Map();  // id del cliente → resumen de facturación
let _mcliEditId       = null;       // cliente en edición (null = nuevo)
let _mcliFichaId      = null;       // cliente abierto en la ficha

const _mcliTexto = (v) => String(v || '').trim().toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
const _mcliDigitos = (v) => String(v || '').replace(/\D/g, '');

// ¿Este documento (factura/cotización) es de este cliente guardado?
function _mcliEsDe(cliente, docCliente) {
  if (!docCliente) return false;
  const a = _mcliDigitos(cliente.rnc), b = _mcliDigitos(docCliente.rnc);
  if (a && b) return a === b;
  const n = _mcliTexto(cliente.nombre);
  return !!n && n === _mcliTexto(docCliente.nombre);
}

function _mcliResumen(cliente) {
  const facturas = _mcliFacturas.filter(f => _mcliEsDe(cliente, f.cliente))
    .sort((x, y) => String(y.fecha || '').localeCompare(String(x.fecha || '')));
  const vigentes = facturas.filter(f => f.estado !== 'anulada');
  const saldo = (f) => Math.max(0, Number(f.balance ?? ((f.total || 0) - (f.monto_pagado || 0))) || 0);
  const anio = String(new Date().getFullYear());
  return {
    facturas,
    cotizaciones: _mcliCotizaciones.filter(c => _mcliEsDe(cliente, c.cliente))
      .sort((x, y) => String(y.fecha || '').localeCompare(String(x.fecha || ''))),
    cantidad:  vigentes.length,
    facturado: vigentes.reduce((a, f) => a + Number(f.total || 0), 0),
    cobrado:   vigentes.reduce((a, f) => a + Number(f.monto_pagado || 0), 0),
    pendiente: vigentes.reduce((a, f) => a + saldo(f), 0),
    esteAnio:  vigentes.filter(f => String(f.fecha || '').startsWith(anio)).reduce((a, f) => a + Number(f.total || 0), 0),
    ultima:    vigentes[0]?.fecha || '',
  };
}

async function loadMisClientes() {
  const tbody = $id('mcli-tbody');
  if (tbody && !_mcli.length) tbody.innerHTML = '<tr><td colspan="7" class="td-empty">Cargando clientes…</td></tr>';
  try {
    const [clientes, facturas, cotizaciones] = await Promise.all([
      apiCall('GET', '/api/facturacion/clientes'),
      apiCall('GET', '/api/facturacion/facturas').catch(() => []),
      apiCall('GET', '/api/cotizaciones/cotizaciones?todas=1').catch(() => []),
    ]);
    _mcli = clientes;
    _facClientes = clientes;
    _mcliFacturas = facturas;
    _mcliCotizaciones = cotizaciones;
    _mcliResumenes = new Map(clientes.map(c => [c.id, _mcliResumen(c)]));
    _renderMcliResumen();
    filtrarMisClientes();
    if (_mcliFichaId && !$id('modal-mi-cliente-ficha')?.classList.contains('hidden')) verMiCliente(_mcliFichaId);
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="td-empty" style="color:var(--red)">Error: ${esc(e.message)}</td></tr>`;
  }
}

function _renderMcliResumen() {
  const res = [..._mcliResumenes.values()];
  setText('mcli-total', String(_mcli.length));
  setText('mcli-con-saldo', String(res.filter(r => r.pendiente > 0.009).length));
  setText('mcli-pendiente', fmtMoney(res.reduce((a, r) => a + r.pendiente, 0)));
  setText('mcli-anio', fmtMoney(res.reduce((a, r) => a + r.esteAnio, 0)));
}

function filtrarMisClientes() {
  const tbody = $id('mcli-tbody');
  if (!tbody) return;
  const q = _mcliTexto($id('mcli-buscar')?.value);
  const qDig = _mcliDigitos(q);
  const filtro = $id('mcli-filtro')?.value || '';

  const lista = _mcli.filter((c) => {
    const r = _mcliResumenes.get(c.id) || {};
    if (filtro === 'saldo' && !(r.pendiente > 0.009)) return false;
    if (filtro === 'sin-facturas' && r.cantidad) return false;
    if (!q) return true;
    if ([c.nombre, c.contacto, c.correo].some(v => _mcliTexto(v).includes(q))) return true;
    return qDig.length >= 3 && [c.rnc, c.telefono].some(v => _mcliDigitos(v).includes(qDig));
  });

  setText('mcli-sub', _mcli.length
    ? `${_mcli.length} cliente${_mcli.length === 1 ? '' : 's'} guardado${_mcli.length === 1 ? '' : 's'} para facturar y cotizar`
    : 'Guarda aquí los clientes a los que facturas y cotizas');

  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="td-empty">${_mcli.length
      ? 'Ningún cliente coincide con la búsqueda.'
      : 'Aún no tienes clientes guardados. Presiona <b>Nuevo cliente</b> para agregar el primero.'}</td></tr>`;
    return;
  }

  tbody.innerHTML = lista.map((c) => {
    const r = _mcliResumenes.get(c.id) || {};
    const contacto = [c.telefono, c.correo].filter(Boolean).map(esc).join('<br>') || '<span class="text-muted">—</span>';
    return `<tr>
      <td>
        <a href="#" class="mcli-nombre" onclick="app.verMiCliente('${c.id}');return false">${esc(c.nombre)}</a>
        ${c.contacto ? `<div class="td-small">Atención: ${esc(c.contacto)}</div>` : ''}
      </td>
      <td class="td-small">${esc(c.rnc) || '—'}</td>
      <td class="td-small">${contacto}</td>
      <td style="text-align:right">${r.cantidad || 0}</td>
      <td class="num" style="text-align:right;white-space:nowrap;font-weight:500">${fmtMoney(r.facturado || 0)}</td>
      <td class="num ${r.pendiente > 0.009 ? 'mcli-pendiente' : ''}" style="text-align:right;white-space:nowrap;font-weight:600">${fmtMoney(r.pendiente || 0)}</td>
      <td>
        <div class="mcli-acciones">
          <button class="btn btn-secondary btn-sm" data-icono="receipt-text" onclick="app.facturarMiCliente('${c.id}')" title="Nueva factura a este cliente">Facturar</button>
          <button class="btn btn-secondary btn-sm" data-icono="clipboard-check" onclick="app.cotizarMiCliente('${c.id}')" title="Nueva cotización a este cliente">Cotizar</button>
          <button class="btn-icono" data-icono="pencil" onclick="app.abrirMiCliente('${c.id}')" title="Editar datos" aria-label="Editar datos"></button>
          <button class="btn-icono is-danger" data-icono="trash-2" onclick="app.eliminarMiCliente('${c.id}')" title="Eliminar de Mis clientes" aria-label="Eliminar"></button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── Formulario nuevo / editar ─────────────────────────────────────────
const _MCLI_CAMPOS = ['nombre', 'rnc', 'contacto', 'telefono', 'correo', 'direccion', 'notas'];

function abrirMiCliente(id) {
  const c = id ? _mcli.find(x => x.id === id) : null;
  _mcliEditId = c ? c.id : null;
  _MCLI_CAMPOS.forEach((campo) => { const el = $id(`mcli-f-${campo}`); if (el) el.value = c?.[campo] || ''; });
  setText('mcli-form-titulo', c ? 'Editar cliente' : 'Nuevo cliente');
  const btn = $id('mcli-btn-guardar'); if (btn) btn.textContent = c ? 'Guardar cambios' : 'Guardar cliente';
  _fmLimpiar('mcli-form');
  setText('mcli-rnc-ayuda', '');
  const m = $id('mcli-msg'); if (m) { m.textContent = ''; m.classList.remove('is-error'); }

  // Autocompletar con la DGII al escribir el RNC, igual que en la factura.
  if (window.RNCLookup) {
    const rncEl = $id('mcli-f-rnc');
    if (rncEl) RNCLookup.attach(rncEl, { nameEl: $id('mcli-f-nombre'), mode: 'both', onSelect() {} });
  }
  show('modal-mi-cliente');
  setTimeout(() => $id('mcli-f-nombre')?.focus(), 50);
}

function cerrarMiCliente() { _mcliEditId = null; hide('modal-mi-cliente'); }

async function guardarMiCliente() {
  const datos = {};
  _MCLI_CAMPOS.forEach((campo) => { datos[campo] = ($id(`mcli-f-${campo}`)?.value || '').trim(); });
  _fmLimpiar('mcli-form');
  const rnc = datos.rnc.replace(/\D/g, '');
  let invalido = false;
  if (rnc && rnc.length !== 9 && rnc.length !== 11) { _fmError('mcli-f-rnc', 'El RNC tiene 9 dígitos y la cédula 11.'); invalido = true; }
  if (!datos.nombre) { _fmError('mcli-f-nombre', 'Escribe el nombre o la razón social del cliente.'); invalido = true; }
  if (datos.correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(datos.correo)) { _fmError('mcli-f-correo', 'Ese correo no es válido.'); invalido = true; }
  if (invalido) { $id('mcli-form')?.querySelector('.is-invalido input')?.focus(); return; }

  const btn = $id('mcli-btn-guardar');
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
  try {
    if (_mcliEditId) {
      await apiCall('PUT', `/api/facturacion/clientes/${_mcliEditId}`, datos);
      toast('Cliente actualizado.', 'success');
    } else {
      await apiCall('POST', '/api/facturacion/clientes', datos);
      toast('Cliente guardado en Mis clientes.', 'success');
    }
    cerrarMiCliente();
    await loadMisClientes();
  } catch (e) {
    // 409 = ya hay un cliente con ese RNC/cédula.
    if (e.status === 409) _fmError('mcli-f-rnc', e.message);
    else { const m = $id('mcli-msg'); if (m) { m.textContent = e.message; m.classList.add('is-error'); } }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

async function eliminarMiCliente(id) {
  const c = _mcli.find(x => x.id === id);
  if (!c) return;
  if (!confirm(`¿Eliminar a "${c.nombre}" de Mis Clientes?\n\nSus facturas y cotizaciones no se borran.`)) return;
  try {
    await apiCall('DELETE', `/api/facturacion/clientes/${id}`);
    toast('Cliente eliminado.', 'success');
    if (_mcliFichaId === id) cerrarFichaMiCliente();
    await loadMisClientes();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

// ── Ficha del cliente: datos, saldo, facturas y cotizaciones ──────────
function verMiCliente(id) {
  const c = _mcli.find(x => x.id === id);
  if (!c) return;
  _mcliFichaId = id;
  const r = _mcliResumenes.get(id) || _mcliResumen(c);

  setText('mcli-ficha-nombre', c.nombre);
  setText('mcli-ficha-rnc', c.rnc ? `RNC / Cédula: ${c.rnc}` : 'Sin RNC / cédula');
  const fila = (dt, dd) => `<dt>${dt}</dt><dd>${dd || '—'}</dd>`;
  $id('mcli-ficha-datos').innerHTML = `<dl class="info-dl">
    ${fila('Atención', esc(c.contacto))}
    ${fila('Teléfono', esc(c.telefono))}
    ${fila('Correo', esc(c.correo))}
    ${fila('Dirección', esc(c.direccion))}
    ${c.notas ? fila('Notas', `<span style="white-space:pre-wrap">${esc(c.notas)}</span>`) : ''}
  </dl>`;

  setText('mcli-ficha-facturado', fmtMoney(r.facturado));
  setText('mcli-ficha-cobrado', fmtMoney(r.cobrado));
  setText('mcli-ficha-pendiente', fmtMoney(r.pendiente));
  setText('mcli-ficha-ultima', r.ultima ? fmtDate(r.ultima) : '—');
  $id('mcli-ficha-pendiente')?.classList.toggle('mcli-pendiente', r.pendiente > 0.009);

  $id('mcli-ficha-facturas').innerHTML = r.facturas.map(f => `<tr>
      <td><a href="#" onclick="app.verFacturaDeMiCliente('${f.id}');return false"><code>${esc(facNcfDisplay(f.ncf))}</code></a></td>
      <td class="td-date">${fmtDate(f.fecha)}</td>
      <td class="td-amount" style="text-align:right">${fmtMoney(f.total)}</td>
      <td class="td-amount" style="text-align:right">${f.estado === 'anulada' ? '—' : fmtMoney(f.balance ?? ((f.total || 0) - (f.monto_pagado || 0)))}</td>
      <td>${facEstadoBadge(f.estado)}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="td-empty">Sin facturas todavía.</td></tr>';

  $id('mcli-ficha-cotizaciones').innerHTML = r.cotizaciones.map(q => `<tr>
      <td><a href="#" onclick="app.verCotizacionPreview('${q.id}');return false">${esc(q.numero)}</a></td>
      <td class="td-date">${fmtDate(q.fecha)}</td>
      <td class="td-amount" style="text-align:right">${fmtMoney(q.total)}</td>
      <td>${cotEstadoBadge(q.estado)}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="td-empty">Sin cotizaciones todavía.</td></tr>';

  show('modal-mi-cliente-ficha');
}

function cerrarFichaMiCliente() { _mcliFichaId = null; hide('modal-mi-cliente-ficha'); }

function editarFichaMiCliente() { if (_mcliFichaId) abrirMiCliente(_mcliFichaId); }

function verFacturaDeMiCliente(facturaId) {
  cerrarFichaMiCliente();
  verFactura(facturaId);
}

// Abre Nueva factura / Nueva cotización con el cliente ya puesto.
async function facturarMiCliente(id) {
  const clienteId = id || _mcliFichaId;
  if (!clienteId) return;
  cerrarFichaMiCliente();
  await nuevaFactura({ enfocar: false });
  await docElegirCliente('nf', `fac_${clienteId}`);
}

async function cotizarMiCliente(id) {
  const clienteId = id || _mcliFichaId;
  if (!clienteId) return;
  cerrarFichaMiCliente();
  await nuevaCotizacion({ enfocar: false });
  await docElegirCliente('cot', `fac_${clienteId}`);
}

// "Guardar este cliente en Mis Clientes" de Nueva factura / Nueva
// cotización. No repite un cliente que ya está (mismo RNC/cédula, o mismo
// nombre si no tiene RNC). Devuelve 'nuevo', 'existe' o '' si falló.
async function _guardarEnMisClientes(cliente, yaGuardados) {
  if ((yaGuardados || []).some(c => _mcliEsDe(c, cliente))) return 'existe';
  try {
    await apiCall('POST', '/api/facturacion/clientes', cliente);
    _mcli = [];   // la próxima visita a Mis Clientes recarga la lista
    return 'nuevo';
  } catch (e) {
    if (e.status === 409) return 'existe';
    toast('No se pudo guardar el cliente en Mis Clientes: ' + e.message, 'error');
    return '';
  }
}

function _textoGuardadoCliente(r) {
  if (r === 'nuevo') return ' El cliente quedó guardado en Mis Clientes.';
  if (r === 'existe') return ' El cliente ya estaba en Mis Clientes.';
  return '';
}

// El check solo tiene sentido si el cliente no viene de Mis Clientes.
function _mostrarCheckGuardarCliente(prefijo, valorSelector) {
  const fila = $id(`${prefijo}-guardar-cliente-row`);
  if (fila) fila.style.display = String(valorSelector || '').startsWith('fac_') ? 'none' : '';
}

// ══════════════════════════════════════════════════════════════════════
// COTIZACIONES — cotizar servicios y convertirlos en factura con un clic.
// ══════════════════════════════════════════════════════════════════════

function cotEstadoBadge(estado) {
  const map = { aprobada: 'Aprobada', rechazada: 'Rechazada', vencida: 'Vencida', convertida: 'Convertida' };
  const lbl = map[estado] || estado || '—';
  return `<span class="cot-estado ${estado || 'aprobada'}">${lbl}</span>`;
}

async function loadCotizaciones() {
  const tbody = $id('cotizaciones-tbody');
  try {
    const todas = $id('cot-ver-todas')?.checked ? '?todas=1' : '';
    _cotCotizaciones = await apiCall('GET', '/api/cotizaciones/cotizaciones' + todas);
  } catch (e) {
    _cotCotizaciones = [];
    toast('No se pudieron cargar las cotizaciones: ' + e.message, 'error');
  }
  if (!tbody) return;
  if (!_cotCotizaciones.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="td-empty">Sin cotizaciones todavía.
      <div style="margin-top:10px"><button class="btn btn-secondary btn-sm" data-icono="plus" onclick="app.nuevaCotizacion()">Nueva cotización</button></div></td></tr>`;
    return;
  }
  tbody.innerHTML = _cotCotizaciones.map(c => {
    const vence = c.fecha_vencimiento ? _fmtFechaSolo(c.fecha_vencimiento) : '—';
    const vencida = c.estado !== 'convertida' && c.fecha_vencimiento && c.fecha_vencimiento < hoyLocal();
    const acciones = [
      `<button class="btn-icono" data-icono="eye" title="Ver / imprimir" aria-label="Ver / imprimir" onclick="app.verCotizacionPreview('${c.id}')"></button>`,
      `<button class="btn-icono" data-icono="mail" title="Enviar por correo" aria-label="Enviar por correo" onclick="app.abrirModalEnvioCot('${c.id}')"></button>`,
    ];
    if (c.estado !== 'convertida') {
      acciones.push(`<button class="btn-icono" data-icono="pencil" title="Editar" aria-label="Editar" onclick="app.editarCotizacion('${c.id}')"></button>`);
      acciones.push(`<button class="btn btn-secondary btn-sm" data-icono="receipt-text" onclick="app.convertirCotizacionEnFactura('${c.id}')">Convertir en factura</button>`);
    } else if (c.converted_invoice_id) {
      acciones.push(`<button class="btn btn-secondary btn-sm" data-icono="receipt-text" onclick="app.verFactura('${c.converted_invoice_id}')">Ver factura</button>`);
    }
    return `<tr>
      <td class="facx-ncf">${esc(c.numero)}</td>
      <td style="font-weight:600">${esc(c.cliente?.nombre) || '—'}</td>
      <td>${fmtDate(c.fecha)}</td>
      <td ${vencida ? 'style="color:var(--pill-bad-text)"' : ''}>${vence}</td>
      <td>${cotEstadoBadge(vencida && c.estado === 'aprobada' ? 'vencida' : c.estado)}</td>
      <td style="text-align:right;font-weight:600" class="num">${fmtMoney(c.total)}</td>
      <td><div class="cotx-acc">${acciones.join('')}</div></td>
    </tr>`;
  }).join('');
}

let _cotValidez = 30;
let _cotIntento = false;
let _cotNumero = null;

function cotElegirValidez(v) {
  const wrap = $id('cot-validez-otro-wrap');
  const input = $id('cot-validez-dias');
  if (v === 'otro') {
    if (wrap) wrap.style.display = '';
    input?.focus();
  } else {
    _cotValidez = Number(v) || 30;
    if (input) input.value = _cotValidez;
    if (wrap) wrap.style.display = 'none';
  }
  document.querySelectorAll('#cot-validez-seg [data-valor]').forEach(b => {
    b.setAttribute('aria-checked', String(v === 'otro' ? b.dataset.valor === 'otro' : b.dataset.valor === String(_cotValidez)));
  });
  cotActualizarPie();
}

function _cotDiasValidez() { return Math.max(1, Math.min(365, Number($id('cot-validez-dias')?.value) || 30)); }
function _cotVenceFecha() {
  const f = $id('cot-fecha')?.value || hoyLocal();
  const d = _aFecha(f) || new Date();
  d.setDate(d.getDate() + _cotDiasValidez());
  return hoyLocal(d);
}

function _cotProblemas() {
  const get = (id) => ($id(id)?.value || '').trim();
  const out = [];
  const rnc = get('cot-cli-rnc').replace(/\D/g, '');
  if (rnc && rnc.length !== 9 && rnc.length !== 11) out.push({ campo: 'cot-cli-rnc', msg: 'El RNC tiene 9 dígitos y la cédula 11.' });
  if (!get('cot-cli-nombre')) out.push({ campo: 'cot-cli-nombre', msg: 'Escribe el nombre o la razón social del cliente.', pie: 'Falta el nombre del cliente.' });
  const correo = get('cot-cli-correo');
  if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) out.push({ campo: 'cot-cli-correo', msg: 'Ese correo no es válido.' });
  const utiles = _docItemsUtiles(_cotItems);
  if (!utiles.some(i => Number(i.precio) > 0)) out.push({ campo: 'cot-items', msg: 'Agrega al menos un servicio con precio.', pie: 'Agrega al menos un servicio con precio.' });
  else if (utiles.some(i => Number(i.precio) > 0 && !String(i.descripcion || '').trim())) out.push({ campo: 'cot-items', msg: 'Cada línea con precio necesita una descripción.' });
  if (!get('cot-fecha')) out.push({ campo: 'cot-fecha', msg: 'Indica la fecha de la cotización.' });
  const dias = Number(get('cot-validez-dias'));
  if (!Number.isInteger(dias) || dias < 1 || dias > 365) out.push({ campo: 'cot-validez-dias', msg: 'Entre 1 y 365 días.' });
  return out;
}

function cotActualizarPie() {
  _docPintarTotales('cot');
  const vence = _cotVenceFecha();
  setText('cot-vence-chip', _fmtFechaSolo(vence));
  setText('cot-vence-nota', `Válida ${_plural(_cotDiasValidez(), 'día', 'días')}: hasta el ${_fmtFechaSolo(vence)}.`);
  const probs = _cotProblemas();
  const msg = $id('cot-msg');
  if (msg) {
    msg.textContent = probs[0] ? (probs[0].pie || probs[0].msg) : '';
    msg.classList.toggle('is-error', Boolean(probs.length && _cotIntento));
  }
  const btn = $id('cot-btn-guardar');
  if (btn && !btn.disabled) _btnTexto(btn, _cotEditId ? 'Guardar cambios' : 'Guardar cotización');
  if (_cotIntento) {
    _fmLimpiar('cot-form');
    probs.forEach(p => { if (p.campo) _fmError(p.campo, p.msg); });
    _docAbrirMasSiError('cot-mas');
  }
}

async function nuevaCotizacion(opts) {
  const enfocar = opts?.enfocar !== false;
  _cotEditId = null;
  _cotNumero = null;
  _cotIntento = false;
  setText('cot-titulo', 'Nueva cotización');
  const conv = $id('cot-btn-convertir'); if (conv) conv.style.display = 'none';

  _cotItems = [_docNuevaLinea()];
  const set = (id, v) => { const el = $id(id); if (el) el.value = v; };
  set('cot-fecha', hoyLocal());
  ['cot-cli-nombre', 'cot-cli-rnc', 'cot-cli-dir', 'cot-cli-tel', 'cot-cli-correo', 'cot-notas', 'cot-observacion']
    .forEach(id => set(id, ''));
  setText('cot-rnc-ayuda', '');
  $id('cot-cli-resultados')?.classList.add('hidden');
  const chkCli = $id('cot-guardar-cliente'); if (chkCli) chkCli.checked = false;
  _mostrarCheckGuardarCliente('cot', '');
  docElegirCondicion('cot', 'contado');
  cotElegirValidez(30);
  _fmLimpiar('cot-form');
  const mas = $id('cot-mas'); if (mas) mas.open = false;

  if (window.RNCLookup) {
    const rncEl = $id('cot-cli-rnc');
    if (rncEl) RNCLookup.attach(rncEl, { nameEl: $id('cot-cli-nombre'), mode: 'both', onSelect() { cotActualizarPie(); } });
  }

  await _docCargarClientes('cot');
  _docPintarPlantillas('cot');
  renderDocItems('cot');
  show('modal-nueva-cotizacion');
  $id('cot-form')?.scrollTo(0, 0);
  cotActualizarPie();
  if (enfocar) setTimeout(() => $id('cot-cli-rnc')?.focus(), 50);
}

function cerrarNuevaCotizacion() { _cotEditId = null; hide('modal-nueva-cotizacion'); }

async function editarCotizacion(id) {
  try {
    const c = await apiCall('GET', `/api/cotizaciones/cotizaciones/${id}`);
    if (c.estado === 'convertida') { toast('No se puede editar una cotización ya convertida a factura.', 'error'); return; }
    await nuevaCotizacion({ enfocar: false });   // arranca el modal en limpio y carga los clientes
    _cotEditId = id;
    _cotNumero = c.numero || null;

    const set = (fid, v) => { const el = $id(fid); if (el) el.value = v == null ? '' : v; };
    set('cot-cli-nombre', c.cliente?.nombre);
    set('cot-cli-rnc',    c.cliente?.rnc);
    set('cot-cli-dir',    c.cliente?.direccion);
    set('cot-cli-tel',    c.cliente?.telefono);
    set('cot-cli-correo', c.cliente?.correo);
    set('cot-fecha',      (c.fecha || '').slice(0, 10));
    set('cot-notas', c.notas || '');
    set('cot-observacion', c.observacion || '');
    docElegirCondicion('cot', c.condicion_pago || 'contado');
    const dias = Number(c.validez_dias) || 30;
    if (dias === 15 || dias === 30) cotElegirValidez(dias);
    else { set('cot-validez-dias', dias); cotElegirValidez('otro'); }

    _cotItems = (c.items || []).map(it => _docNuevaLinea(it));
    if (!_cotItems.length) _cotItems = [_docNuevaLinea()];

    setText('cot-titulo', `Cotización ${c.numero}`);
    const conv = $id('cot-btn-convertir'); if (conv) conv.style.display = '';
    renderDocItems('cot');
    cotActualizarPie();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function selClienteCot(val) {
  _mostrarCheckGuardarCliente('cot', val);
  if (!val) return;
  const set = (fid, v) => { const el = $id(fid); if (el) el.value = v || ''; };

  if (val.startsWith('fac_')) {
    const c = _cotClientes.find(x => x.id === val.slice(4));
    if (!c) return;
    set('cot-cli-nombre', c.nombre);
    set('cot-cli-rnc',    c.rnc);
    set('cot-cli-dir',    c.direccion);
    set('cot-cli-tel',    c.telefono);
    set('cot-cli-correo', c.correo);
  } else if (val.startsWith('neg_')) {
    const id = val.slice(4);
    let n = _allClientes.find(x => x.id === id);
    try { n = await apiCall('GET', `/api/clientes/${id}`); } catch { /* usa el de caché */ }
    if (!n) return;
    set('cot-cli-nombre', n.razon_social || n.businessName || n.businessKey || '');
    set('cot-cli-rnc',    n.rnc || '');
    set('cot-cli-dir',    n.direccion || n.businessAddress || '');
    set('cot-cli-tel',    n.telefono || n.phone || '');
    set('cot-cli-correo', n.correo || n.email || n.ownerEmail || '');
  }
}

// Nombres viejos (siguen en window.app).
function cotItemSet(idx, field, value) { docItemSet('cot', idx, field, value); }
function addItemCot() { docAddItem('cot'); }
function removeItemCot(idx) { docRemoveItem('cot', idx); }

function _cotDatosForm() {
  const get = id => ($id(id)?.value || '').trim();
  return {
    cliente: {
      nombre: get('cot-cli-nombre'), rnc: get('cot-cli-rnc'),
      direccion: get('cot-cli-dir'), telefono: get('cot-cli-tel'), correo: get('cot-cli-correo'),
    },
    fecha:          get('cot-fecha'),
    validez_dias:   _cotDiasValidez(),
    condicion_pago: get('cot-condicion') || 'contado',
    observacion:    get('cot-observacion'),
    notas:          get('cot-notas'),
    items: _docItemsUtiles(_cotItems),
  };
}

// silencioso: guarda sin cerrar el modal ni avisar (antes de convertir en factura).
async function guardarCotizacion({ silencioso = false } = {}) {
  _cotIntento = true;
  const probs = _cotProblemas();
  cotActualizarPie();
  if (probs.length) {
    const primero = probs.find(p => p.campo && p.campo !== 'cot-items');
    if (primero) $id(primero.campo)?.focus();
    return false;
  }
  const btn = $id('cot-btn-guardar');
  const esEdicion = !!_cotEditId;
  if (btn) { btn.disabled = true; _btnTexto(btn, 'Guardando…'); }
  try {
    const payload = _cotDatosForm();
    const editandoId = _cotEditId;
    if (esEdicion) await apiCall('PUT', `/api/cotizaciones/cotizaciones/${editandoId}`, payload);
    else {
      const nueva = await apiCall('POST', '/api/cotizaciones/cotizaciones', payload);
      _cotEditId = nueva.id;
      _cotNumero = nueva.numero;
    }
    const guardado = $id('cot-guardar-cliente')?.checked && $id('cot-guardar-cliente-row')?.style.display !== 'none'
      ? await _guardarEnMisClientes(payload.cliente, _cotClientes) : '';
    if (!silencioso) {
      toast((esEdicion ? 'Cotización actualizada.' : `Cotización ${_cotNumero || ''} guardada.`) + _textoGuardadoCliente(guardado), 'success');
      _cotEditId = null;
      hide('modal-nueva-cotizacion');
    }
    loadCotizaciones();
    if ($id('mod-mis-clientes')?.classList.contains('active')) loadMisClientes();
    return true;
  } catch (e) {
    const msg = $id('cot-msg');
    if (msg) { msg.textContent = e.message; msg.classList.add('is-error'); }
    return false;
  } finally {
    if (btn) {
      btn.disabled = false;
      _btnTexto(btn, _cotEditId ? 'Guardar cambios' : 'Guardar cotización');
    }
  }
}

// Vista previa de lo que hay en el formulario (aunque no esté guardada).
async function vistaPreviaCotizacionForm() {
  if (!window.contadoresAPI?.isElectron) { toast('La vista previa solo está disponible en la app de escritorio.', 'error'); return; }
  const d = _cotDatosForm();
  const items = d.items.map(it => {
    const base = (Number(it.precio) || 0) * Math.max(1, Number(it.cantidad) || 1);
    const desc = base * ((Number(it.descuento) || 0) / 100);
    const itbis = (base - desc) * ((Number(it.itbis_rate) || 0) / 100);
    return { ...it, itbis: _r2(itbis), total: _r2(base - desc + itbis) };
  });
  const t = _docTotales(items);
  const c = {
    ...d, items, numero: _cotNumero || 'COT-BORRADOR', estado: 'aprobada', fecha_vencimiento: _cotVenceFecha(),
    subtotal: t.subtotal, descuento_total: t.descuentos, itbis_total: t.itbis, total: t.total,
  };
  try {
    const r = await window.contadoresAPI.previewPrint(cotizacionFormalHtml(c), `Cotización ${c.numero}`, `Cotizacion_${c.numero}.pdf`);
    if (!r?.ok) toast('Error al abrir la vista previa: ' + (r?.error || 'desconocido'), 'error');
  } catch (_) { toast('Error al abrir la vista previa.', 'error'); }
}

// ── Convertir en factura: abre Nueva factura con todo lo de la cotización ──
async function _abrirFacturaDesdeCotizacion(c) {
  await nuevaFactura({ enfocar: false });
  _facDesdeCot = { id: c.id, numero: c.numero };
  const set = (fid, v) => { const el = $id(fid); if (el) el.value = v == null ? '' : v; };
  set('nf-cli-nombre', c.cliente?.nombre);
  set('nf-cli-rnc',    c.cliente?.rnc);
  set('nf-cli-dir',    c.cliente?.direccion);
  set('nf-cli-tel',    c.cliente?.telefono);
  set('nf-cli-correo', c.cliente?.correo);
  set('nf-observacion', c.observacion || '');
  docElegirCondicion('nf', c.condicion_pago || 'contado');
  _facItems = (c.items || []).map(it => _docNuevaLinea(it));
  if (!_facItems.length) _facItems = [_docNuevaLinea()];
  _nfTipo = _facPickDefaultNcf(Boolean(String(c.cliente?.rnc || '').trim()));
  // El subtítulo basta para saber de dónde viene (un aviso aparte quitaba espacio).
  setText('nf-sub', `Desde la cotización ${c.numero} · al emitir queda como convertida`);
  renderDocItems('nf');
  _nfPintarTipos();
  nfActualizarPie();
}

async function convertirCotizacionEnFactura(id) {
  let c = _cotCotizaciones.find(x => x.id === id);
  try { c = await apiCall('GET', `/api/cotizaciones/cotizaciones/${id}`); } catch { /* usa la de la lista */ }
  if (!c) { toast('No se encontró la cotización.', 'error'); return; }
  if (c.estado === 'convertida') { toast('Esta cotización ya fue facturada.', 'info'); return; }
  await _abrirFacturaDesdeCotizacion({ ...c, id });
}

// Desde el formulario: guarda los cambios y pasa todo a Nueva factura.
async function convertirCotizacionDesdeModal() {
  const ok = await guardarCotizacion({ silencioso: true });
  if (!ok || !_cotEditId) return;
  const datos = { ..._cotDatosForm(), id: _cotEditId, numero: _cotNumero };
  hide('modal-nueva-cotizacion');
  _cotEditId = null;
  await _abrirFacturaDesdeCotizacion(datos);
}

// ── Ver / imprimir / enviar por correo ──────────────────────────────────

async function verCotizacionPreview(id) {
  const c = _cotCotizaciones.find(x => x.id === id);
  if (!c) { toast('Cotización no encontrada en la lista actual.', 'error'); return; }
  if (!window.contadoresAPI?.isElectron) {
    toast('Esta función solo está disponible en la app de escritorio.', 'error');
    return;
  }
  try {
    const clientSlug = (c.cliente?.nombre || 'cliente').replace(/\s+/g, '_').slice(0, 20);
    const filename = `Cotizacion_${(c.numero || 'COT').replace(/[^A-Z0-9]/gi, '')}_${clientSlug}.pdf`;
    const r = await window.contadoresAPI.previewPrint(cotizacionFormalHtml(c), `Cotización ${c.numero}`, filename);
    if (!r?.ok) toast('Error al abrir la vista previa: ' + (r?.error || 'desconocido'), 'error');
  } catch (e) { toast('Error al abrir la vista previa.', 'error'); }
}

async function abrirModalEnvioCot(id) {
  const cfg = await ensureEmailCfg();
  const c = _cotCotizaciones.find(x => x.id === id);
  if (!c) { toast('Cotización no encontrada en la lista actual.', 'error'); return; }

  // Fuera de Electron no podemos generar el PDF → mailto: simple.
  if (!window.contadoresAPI?.isElectron) {
    const asunto = encodeURIComponent(`Cotización ${c.numero} — ${c.contador_nombre || ''}`);
    const cuerpo = encodeURIComponent(`Estimado/a ${c.cliente?.nombre || 'cliente'},\n\nLe enviamos la cotización ${c.numero} por RD$ ${(c.total || 0).toFixed(2)}, válida hasta el ${c.fecha_vencimiento || '—'}.\n\nGracias por confiar en nosotros.`);
    window.open(`mailto:${c.cliente?.correo || ''}?subject=${asunto}&body=${cuerpo}`);
    return;
  }

  if (!cfg.configured) { irAConfigurarCorreo(); return; }

  _envioCot = { id, data: c };
  $id('ce-to').value = c.cliente?.correo || '';
  $id('ce-mensaje').value = '';
  setText('ce-from', `Se envía desde ${cfg.user || 'tu Gmail'} con el PDF adjunto.`);
  show('modal-cot-envio');
}
function cerrarEnvioCot() { hide('modal-cot-envio'); }

async function confirmarEnvioCot() {
  if (!_envioCot) return;
  const to = ($id('ce-to')?.value || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { toast('Escribe un correo de destino válido.', 'error'); return; }

  const btn = $id('ce-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }
  try {
    const html = cotizacionFormalHtml(_envioCot.data);
    const pdf = await window.contadoresAPI.renderInvoicePdf(html);
    if (!pdf?.ok) throw new Error(pdf?.error || 'No se pudo generar el PDF.');
    const r = await apiCall('POST', `/api/cotizaciones/cotizaciones/${_envioCot.id}/enviar`, {
      to, mensaje: $id('ce-mensaje')?.value || '', pdfBase64: pdf.base64,
    });
    hide('modal-cot-envio');
    toast(`Cotización enviada a ${r.to}.`, 'success');
    loadCotizaciones();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Enviar'; } }
}

// Documento A4 de la cotización con la misma plantilla y color de la factura
// (Configuración → Diseño de la factura). Sin NCF: lleva su número COT-….
function cotizacionFormalHtml(c) {
  return FacturaContador.cotizacionHtml(c, _perfil || {});
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
    ? '<span class="badge badge-active" style="background:#7c3aed22;color:var(--purple,#a78bfa);border-color:#7c3aed">🌐 Completo</span>'
    : '<span class="badge badge-pending" style="background:var(--blue-glow,#1e3a5f);color:var(--sky,#60a5fa);border-color:#2563eb">🔗 Dependiente</span>';
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
    $id('colab-tbody').innerHTML = `<tr><td colspan="7" class="td-empty" style="color:var(--red,#ef4444)">${esc(e.message)}</td></tr>`;
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
        <span style="background:var(--blue-glow,#1e3a5f);color:var(--sky,#60a5fa);border-radius:12px;padding:2px 10px;font-size:12px;font-weight:600">
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
    ? 'Al activar este check, el colaborador será <strong style="color:var(--sky,#60a5fa)">Dependiente</strong>: solo podrá ver y gestionar los clientes que le asignes.'
    : 'Sin este check, el colaborador funciona como <strong style="color:var(--purple,#a78bfa)">Contador Completo</strong>: puede crear sus propios clientes y formar su propia red.';

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
        <div style="font-size:12px;font-weight:700;color:var(--ok-text,#4ade80);margin-bottom:4px">✅ Puede hacer</div>
        <div style="font-size:12px;color:var(--ok-text-2,#86efac);line-height:1.8">${perms.puede.map(p => '• ' + p).join('<br>')}</div>
      </div>
      <div>
        <div style="font-size:12px;font-weight:700;color:var(--bad-text,#f87171);margin-bottom:4px">❌ No puede hacer</div>
        <div style="font-size:12px;color:var(--bad-text-2,#fca5a5);line-height:1.8">${perms.noPuede.map(p => '• ' + p).join('<br>')}</div>
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
        <div style="background:var(--surface);border:1px solid var(--border,#2d3a52);border-radius:10px;padding:14px;display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-weight:600;color:var(--text);font-size:13px">${esc(c.businessName)}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${esc(c.propietario)} • ${esc(c.rnc)}</div>
            <div style="margin-top:4px">${statusBadge(c.status)}</div>
          </div>
          <button class="btn btn-danger btn-xs" onclick="app.quitarCliente('${colabId}','${c.id}')">✕ Quitar</button>
        </div>`).join('')}
    </div>`;
  } catch (e) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-text" style="color:var(--red,#ef4444)">Error: ${esc(e.message)}</div></div>`;
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
    $id('masig-lista').innerHTML = `<div style="text-align:center;padding:20px;color:var(--red,#ef4444)">Error: ${esc(e.message)}</div>`;
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
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--border,#2d3a52)">
      <div>
        <div style="font-weight:600;color:var(--text);font-size:13px">${esc(n.businessName || n.id)}</div>
        <div style="font-size:11px;color:var(--text-muted)">${esc(n.propietario || '')} • ${esc(n.rnc || '')} • ${statusBadge(n.status).replace(/<[^>]+>/g,'').trim()}</div>
      </div>
      ${asignado
        ? '<span style="font-size:11px;color:var(--ok-text,#4ade80);font-weight:600">✅ Ya asignado</span>'
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

let _agTopClientes = [];

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

    _agTopClientes = topClientes;
    const buscarEl = $id('ag-f-buscar');
    if (buscarEl) buscarEl.value = '';
    renderAnalisisGlobalTop(topClientes);

    if (sub) sub.textContent = `Último actualización: ${new Date().toLocaleTimeString('es-DO')}`;
  } catch (e) {
    toast('Error cargando análisis global: ' + e.message, 'error');
    if (sub) sub.textContent = 'Error al cargar datos.';
  }
}

function renderAnalisisGlobalTop(topClientes) {
  const topWrap = $id('ag-top-wrap');
  const sinDatos = $id('ag-sin-datos');

  if (topClientes.length === 0) {
    if (topWrap)  topWrap.style.display  = 'none';
    if (sinDatos) sinDatos.style.display = '';
    return;
  }
  if (topWrap)  topWrap.style.display  = '';
  if (sinDatos) sinDatos.style.display = 'none';
  const tbody = $id('ag-top-tbody');
  if (!tbody) return;
  tbody.innerHTML = topClientes.map((c, i) => {
    const posCls = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    return `<tr>
      <td><span class="ag-top-pos ${posCls}">${i + 1}</span></td>
      <td style="font-weight:600">${esc(c.businessName)}</td>
      <td>${statusBadge(c.status)}</td>
      <td class="td-amount">${fmtMoney(c.ventasMes)}</td>
      <td class="td-amount" style="color:var(--orange,#f59e0b)">${fmtMoney(c.itbisMes)}</td>
      <td style="text-align:center">${c.facturas}</td>
      <td><button class="btn btn-xs btn-secondary" onclick="app.verCliente('${c.id}')">Ver</button></td>
    </tr>`;
  }).join('');
}

function filtrarAnalisisGlobal(q) {
  const lower = q.toLowerCase();
  const filtered = lower
    ? _agTopClientes.filter(c => (c.businessName || '').toLowerCase().includes(lower))
    : _agTopClientes;
  renderAnalisisGlobalTop(filtered);
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
    if (el) el.innerHTML = `<div style="color:var(--red,#ef4444);padding:12px">${e.message}</div>`;
  }
}

async function _cargarTareas() {
  try {
    await refreshToken();
    _cfTareas = await apiCall('GET', '/api/centro-fiscal/tareas');
    _renderTareas();
  } catch (e) {
    const el = $id('cf-tareas-list');
    if (el) el.innerHTML = `<div style="color:var(--red,#ef4444);padding:12px">${e.message}</div>`;
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
    el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted,#5a7099)">Sin obligaciones para el filtro seleccionado.</div>';
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
    el.innerHTML = `<div style="text-align:center;padding:32px;color:var(--text-muted,#5a7099)">
      <div style="font-size:28px;margin-bottom:8px">✅</div>
      <div>${_cfFilTarea === 'pendiente' ? 'Sin tareas pendientes' : 'Sin tareas completadas'}</div>
      <button class="btn btn-secondary" style="margin-top:12px" onclick="app.abrirModalTarea(null)">+ Agregar tarea</button>
    </div>`;
    return;
  }

  const hoy = hoyLocal();
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
          <span class="tarea-tipo" style="--tipo:${tipoColor}">${(t.tipo||'general').toUpperCase()}</span>
          ${t.fecha_vencimiento ? `<span style="margin-left:6px;${vencida ? 'color:var(--red,#ef4444);font-weight:600' : ''}">📅 ${t.fecha_vencimiento}</span>` : ''}
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
        <td>${esc(a.descripcion)}${a.origen === 'automatico' ? ' <span style="font-size:11px;color:var(--text-muted,#5a7099);border:1px solid var(--border,#2a3550);border-radius:4px;padding:1px 5px">auto</span>' : ''}</td>
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
  $id('asiento-fecha').value = hoyLocal();
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
      <div style="display:flex;justify-content:space-between;padding:6px 0;${fuerte ? 'font-weight:700;border-top:1px solid var(--border,#2a3550)' : ''}">
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
      </div>`).join('') || '<div style="color:var(--text-muted,#5a7099);font-size:13px">Sin saldo.</div>';
    if (wrap) wrap.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div>
          <h4>Activos Corrientes</h4>${lista(d.activos.corrientes)}
          <h4 style="margin-top:12px">Activos No Corrientes</h4>${lista(d.activos.noCorrientes)}
          <div style="font-weight:700;border-top:1px solid var(--border,#2a3550);padding-top:6px;margin-top:8px">Total Activos: ${d.activos.total.toFixed(2)}</div>
        </div>
        <div>
          <h4>Pasivos Corrientes</h4>${lista(d.pasivos.corrientes)}
          <h4 style="margin-top:12px">Pasivos Largo Plazo</h4>${lista(d.pasivos.largoPlazo)}
          <div style="font-weight:700;border-top:1px solid var(--border,#2a3550);padding-top:6px;margin-top:8px">Total Pasivos: ${d.pasivos.total.toFixed(2)}</div>
          <h4 style="margin-top:16px">Patrimonio</h4>${lista(d.patrimonio.cuentas)}
          <div style="font-weight:700;border-top:1px solid var(--border,#2a3550);padding-top:6px;margin-top:8px">Total Patrimonio: ${d.patrimonio.total.toFixed(2)}</div>
        </div>
      </div>
      <div style="margin-top:16px;font-weight:700;${d.cuadra ? 'color:var(--green,#22c55e)' : 'color:var(--red,#ef4444)'}">
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
      <div style="font-weight:700;border-top:1px solid var(--border,#2a3550);padding-top:6px;margin-top:8px;display:flex;justify-content:space-between">
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
    h2{font-size:13px;color:var(--text-muted,#5a7099);font-weight:400}
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
      <div style="font-size:11px;color:var(--text-muted,#5a7099);margin-top:5px">Generado: ${fecha}</div>
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
    await _savePdf(html, `EstadoResultados_${_ctbPdfSlug(neg)}_${hoyLocal()}.pdf`, false);
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
    await _savePdf(html, `BalanceGeneral_${_ctbPdfSlug(neg)}_${hoyLocal()}.pdf`, false);
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
    await _savePdf(html, `FlujoEfectivo_${_ctbPdfSlug(neg)}_${hoyLocal()}.pdf`, false);
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
    await _savePdf(html, `Indicadores_${_ctbPdfSlug(neg)}_${hoyLocal()}.pdf`, false);
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
  const col = _coloresGrafico();
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
        legend: { labels: { color: col.texto, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.dataset.label}: RD$ ` + (ctx.parsed.y || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
          },
        },
      },
      scales: {
        x: { ticks: { color: col.texto, font: { size: 10 } }, grid: { display: false } },
        y: {
          ticks: {
            color: col.texto, font: { size: 10 },
            callback: v => 'RD$ ' + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v),
          },
          grid: { color: col.rejilla },
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
      wrap.innerHTML = '<div style="color:var(--text-muted,#5a7099);font-size:13px">No hay períodos cerrados todavía — todo el historial está abierto.</div>';
      return;
    }
    wrap.innerHTML = periodos.map(p => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border,#1a2238)">
        <span>${esc(p.periodo)} ${p.tipo === 'anual' ? '<span style="font-size:11px;color:var(--text-muted,#5a7099)">(cierre anual)</span>' : ''}</span>
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
      <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border,#1a2238)">
        <span>Ejercicio ${esc(String(c.year))}</span>
        <span>Utilidad Neta: ${Number(c.utilidadNeta).toFixed(2)} · Cerrado ${esc(String(c.cerradoEn || '').slice(0, 10))} por ${esc(c.cerradoPor || '')}</span>
      </div>`).join('') || '<div style="color:var(--text-muted,#5a7099);font-size:13px">Ningún año cerrado todavía.</div>';
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
        <td style="font-size:11px;color:var(--text-sub,#8fa3c2)">${esc(_CTB_METODO_DEP_LABEL[a.metodoDepreciacion] || 'Línea Recta')}</td>
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
  $id('baja-fecha').value = hoyLocal();
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
  $id('reval-fecha').value = hoyLocal();
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
          <td style="text-align:right;color:${r.variacion > 0 ? 'var(--red)' : 'var(--green)'}">${r.variacion.toFixed(2)}</td>
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
  $id('asiento-fecha').value = hoyLocal();
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
            <div class="alert-msg">${esc(_msgAlerta(a))}</div>
          </div>
          ${a.businessId ? `<button class="btn btn-xs btn-secondary" onclick="app.verCliente('${a.businessId}')">Ver</button>` : ''}
        </div>`).join('');
    }
  });

  _actualizarBadgeAlertas(data.critico + data.urgente);
}

function _actualizarBadgeAlertas(count) {
  // Menú lateral y campana de la barra superior muestran el mismo número.
  ['nav-badge-alertas', 'topbar-badge-alertas'].forEach((id) => {
    const badge = $id(id);
    if (!badge) return;
    badge.textContent = count > 99 ? '99+' : count;
    badge.classList.toggle('hidden', !(count > 0));
  });
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
  submitRegistroContador, cancelRegistro, buscarRncRegistro,
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
  loadPerfil, savePerfil, handleCfgLogoUpload, quitarCfgLogo, cfgIr, irAConfig,
  guardarConfigCorreo, desconectarConfigCorreo, abrirLink,
  loadAsistente, nuevoChat, enviarChat, guardarConfigIA, desconectarConfigIA,
  asisPropPdf, asisPropEmail, asisPropDismiss,
  // actualizaciones
  loadActualizaciones, verificarActualizacion, instalarActualizacion, instalarActualizacionGlobal, updSwitchTab,
  // reportes
  loadReportes, selNegocioReporte, cambiarTabReporte, cargarDatosReporte,
  aplicarFiltros, aplicarFiltrosConDebounce, actualizarStatsPorSucursal, limpiarFiltros, exportarCSV, exportarExcel, imprimirReporte, actualizarReporte,
  abrirRepDetalle, cerrarRepDetalle, imprimirTabReporte, imprimirReporteMensual,
  // productos pendientes (agregados desde este Portal)
  abrirAgregarProductoModal, editarProductoPendiente, eliminarProductoPendiente, editarProductoReal, eliminarProductoReal, cerrarAgregarProductoModal, guardarProductoPendiente, handleAgregarProductoImagen,
  apElegirAlcance, apElegirItbis, apCalcular, generarCodigoProducto, apControlInventario,
  // secuencias NCF pendientes (registradas desde este Portal)
  abrirAgregarNcfModal, cerrarAgregarNcfModal, guardarNcfPendiente, handleAgregarNcfAdjunto, cancelarNcfPendiente, anActualizar,
  anLeerArchivoDgii, anQuitarArchivoDgii, verSecuenciasNegocio, verReportesNegocio,
  // servicios (Empresa de Servicios)
  abrirServicioModal, cerrarServicioModal, guardarServicioPendiente, asElegirItbis, asCalcular, editarServicioReal, darDeBajaServicio,
  // importar / exportar el catálogo en CSV
  abrirImportarCatalogo, cerrarImportarCatalogo, icLeerArchivos, icQuitar, icImportar, icPlantilla, exportarCatalogoCsv, icCambiarDestino,
  // recibo de pago (impresora térmica)
  reciboFacturaLista, reciboDePago, reciboCargarImpresoras, reciboGuardarConfig, reciboElegirAncho, reciboVistaPrevia, reciboPrueba,
  // secuencias NCF ya aplicadas (editar/suspender/eliminar remoto)
  abrirEditarNcfModal, cerrarEditarNcfModal, guardarEdicionNcf, abrirSuspenderNcfModal, eliminarNcfAplicada,
  confirmarMotivoNcf, cancelarMotivoNcf,
  // facturación — mis secuencias NCF propias (para facturar sus servicios)
  abrirMisSecuenciasNcf, cerrarMisSecuenciasNcf, abrirRegistrarMiNcfModal, cerrarRegistrarMiNcfModal,
  handleMiNcfAdjunto, guardarMiNcf, suspenderMiNcf, activarMiNcf, eliminarMiNcf, mnActualizar, verDocumentoMiNcf,
  // facturación — dashboard
  loadFacturacion,
  facRApply, facROnPeriodoChange, facRSwitchTab, facRSwitchSubtab, facRFacPage, facRFacMetodo,
  facRExportFacturas, facRExportGroup, facRExportDGII, facRExportConsolidado,
  registrarCobroLista, pdfFacturaLista,
  // facturación — nueva factura (y formulario común con la cotización)
  nuevaFactura, cerrarNuevaFactura, selClienteFac, editarFactura,
  addItemFac, removeItemFac, facItemSet, guardarFactura,
  nfElegirTipo, nfActualizarPie, vistaPreviaFactura,
  docBuscarCliente, docElegirCliente, docClienteNuevo, docConsultarDgii, docAgregarPlantilla,
  docItemSet, docAddItem, docRemoveItem, docElegirCondicion, mcliConsultarDgii,
  enviarFacturaCorreoLista, marcarPagadaLista,
  // facturación — detalle
  verFactura, cerrarVerFactura, backToFacturas, marcarPagada, anularFactura, duplicarFactura,
  imprimirFactura, imprimirFacturaPreview, enviarPorCorreo, enviarPorWhatsApp,
  cerrarEnvioFac, confirmarEnvioFac,
  openRegistrarPagoFac, cerrarRegistrarPagoFac, registrarPagoFac,
  // mis clientes
  loadMisClientes, filtrarMisClientes, abrirMiCliente, cerrarMiCliente, guardarMiCliente, eliminarMiCliente,
  verMiCliente, cerrarFichaMiCliente, editarFichaMiCliente, verFacturaDeMiCliente,
  facturarMiCliente, cotizarMiCliente,
  // cotizaciones
  loadCotizaciones, nuevaCotizacion, cerrarNuevaCotizacion, editarCotizacion, selClienteCot,
  addItemCot, removeItemCot, cotItemSet, guardarCotizacion,
  cotElegirValidez, cotActualizarPie, vistaPreviaCotizacionForm,
  convertirCotizacionEnFactura, convertirCotizacionDesdeModal,
  verCotizacionPreview, abrirModalEnvioCot, cerrarEnvioCot, confirmarEnvioCot,
  // colaboradores
  loadColaboradores, filtrarColaboradores,
  abrirModalColab, cerrarModalColab, guardarColab, toggleTipoColab, cambiarPwColab, eliminarColab,
  verColabDetalle, quitarCliente,
  abrirModalAsignar, cerrarModalAsignar, filtrarNegociosAsignar, asignarNegocio,
  // análisis global
  loadAnalisisGlobal, filtrarAnalisisGlobal,
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
