// ══════════════════════════════════════════════════════════════════════════════
//  fiscal-ecf.js  —  Tecno Caja e-CF / DGII
//  Consola administrativa de homologación y operación fiscal.
// ══════════════════════════════════════════════════════════════════════════════

const FISCAL_UI_STATE = {
  status: null,
  bundle: null,
  sequencesLoaded: false,
  branches: [],
  cashRegisters: []
};

async function fiscalApi(method, endpoint, body = null, isFormData = false) {
  const token = (typeof getStoredAuthToken === 'function' ? getStoredAuthToken() : '') || DB?.authToken || '';
  const userId = DB?.currentUser?.id;
  const m = String(method).toUpperCase();

  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}` }
  };

  // Adjuntar actorUserId como fallback de autenticación (igual que el resto del sistema)
  if (body && !isFormData) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(userId ? { actorUserId: userId, ...body } : body);
  } else if (body && isFormData) {
    opts.body = body;
  } else if (!body && userId && (m === 'POST' || m === 'PUT' || m === 'PATCH')) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify({ actorUserId: userId });
  }

  // Para GET/DELETE/FormData el fallback va por query param
  let url = `/api/ecf${endpoint}`;
  if (userId && (m === 'GET' || m === 'DELETE' || isFormData)) {
    url += (endpoint.includes('?') ? '&' : '?') + `actorUserId=${userId}`;
  }

  const res = await fetch(url, opts);
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_) {
    data = { raw };
  }
  if (!res.ok) {
    const error = new Error(data.error || data.message || raw || `Error ${res.status}`);
    error.details = data.details || null;
    error.payload = data;
    throw error;
  }
  return data;
}

async function fetchJsonWithAuth(url) {
  const token = (typeof getStoredAuthToken === 'function' ? getStoredAuthToken() : '') || DB?.authToken || '';
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const raw = await res.text();
  let data = [];
  try {
    data = raw ? JSON.parse(raw) : [];
  } catch (_) {
    data = [];
  }
  if (!res.ok) throw new Error(data.error || raw || `Error ${res.status}`);
  return data;
}

function openFiscalConfigModal() {
  const modal = document.getElementById('fiscal-ecf-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  loadFiscalStatus();
  if (window.RNCLookup) {
    const rncEl = document.getElementById('fiscal-biz-rnc');
    if (rncEl && !rncEl.dataset.rncAttached) {
      rncEl.dataset.rncAttached = '1';
      RNCLookup.attach(rncEl, {
        nameEl: document.getElementById('fiscal-biz-razon_social'),
        onSelect(data) {
          const comercialEl = document.getElementById('fiscal-biz-nombre_comercial');
          if (comercialEl && data.nombreComercial) comercialEl.value = data.nombreComercial;
        },
        mode: 'both',
      });
    }
  }
}

function closeFiscalConfigModal() {
  const modal = document.getElementById('fiscal-ecf-modal');
  if (modal) modal.classList.add('hidden');
  document.body.style.overflow = '';
}

async function loadFiscalStatus() {
  try {
    showFiscalLoading(true);
    clearFiscalError();

    const [status, bundle] = await Promise.all([
      fiscalApi('GET', '/status'),
      fiscalApi('GET', '/config/dgii')
    ]);

    FISCAL_UI_STATE.status = status;
    FISCAL_UI_STATE.bundle = bundle;

    renderFiscalStatus(status, bundle);
    renderCertificateInfo(bundle.certificate, bundle.dgiiSettings);
    renderBusinessForm(bundle, status);
    renderConnectionPanel(bundle, status);
    renderHomologationChecklist(bundle.checklist);
    renderCertificationSummary(bundle.certificationSummary || null);

    if (getCurrentFiscalTab() === 'sequences') {
      await initEcfSequenceForm();
      await loadFiscalSequences();
    }
    if (getCurrentFiscalTab() === 'documents') {
      await loadEcfDocuments();
    }
    if (getCurrentFiscalTab() === 'homologation') {
      await loadCertificationCenterStatus({ silent: true });
    }
  } catch (e) {
    showFiscalError(e.message);
    showFiscalToast(`Error fiscal: ${e.message}`, 'error');
  } finally {
    showFiscalLoading(false);
  }
}

function renderFiscalStatus(status, bundle) {
  const fiscalConfig = bundle?.fiscalConfig || {};
  const dgiiSettings = bundle?.dgiiSettings || {};
  const checklist = bundle?.checklist || { items: [], summary: {} };

  const statusBadge = document.getElementById('fiscal-status-badge');
  if (statusBadge) {
    const currentStatus = status?.status || fiscalConfig.status || 'no_configurado';
    statusBadge.textContent = STATUS_LABELS[currentStatus] || currentStatus;
    statusBadge.className = `fiscal-status-badge ${getStatusClass(currentStatus)}`;
  }

  const tokenInfo = document.getElementById('fiscal-token-info');
  const tokenInfoConn = document.getElementById('fiscal-token-info-conn');
  const tokenHtml = buildConnectionStatusHtml(status || fiscalConfig);
  if (tokenInfo) tokenInfo.innerHTML = tokenHtml;
  if (tokenInfoConn) tokenInfoConn.innerHTML = tokenHtml;

  setText('fiscal-status-cert-mode', dgiiSettings.certificateMode === 'qscd' ? 'QSCD / Cloud' : 'Archivo .p12 local');
  setText('fiscal-status-environment', ENV_LABELS[dgiiSettings.environment || fiscalConfig.environment || 'test'] || '—');
  setText('fiscal-business-ecf-mode', status?.isActive ? 'Activo y listo para emisión' : 'Inactivo hasta nueva activación');
  setText(
    'fiscal-dgii-active-status',
    status?.isActive
      ? `Modo e-CF activo en ${ENV_LABELS[fiscalConfig.environment || dgiiSettings.environment || 'test'] || 'ambiente actual'}`
      : 'Modo e-CF inactivo'
  );

  const btnActivate = document.getElementById('fiscal-btn-activate');
  const btnDeactivate = document.getElementById('fiscal-btn-deactivate');
  if (btnActivate) btnActivate.style.display = status?.isActive ? 'none' : 'inline-flex';
  if (btnDeactivate) btnDeactivate.style.display = status?.isActive ? 'inline-flex' : 'none';

  renderActivationWarnings(status);
  renderChecklistSummary(checklist);
  renderQuickChecklist(checklist);
  renderPublicUrls(dgiiSettings.publicUrls);
  renderInternalTokenStatus(dgiiSettings.internalToken);
  _renderEcfStatusCards(status, bundle);
}

function buildConnectionStatusHtml(status) {
  if (status?.tokenExpiresAt && status?.lastConnStatus === 'conectado') {
    return `<span class="fiscal-badge-green">● Conectado</span> — Token expira: ${formatDateTime(status.tokenExpiresAt)}`;
  }
  if (status?.lastConnMsg) {
    return `<span class="fiscal-badge-red">✗ ${escapeHtml(status.lastConnMsg)}</span>`;
  }
  return '<span class="fiscal-badge-gray">Sin conexión registrada</span>';
}

function renderActivationWarnings(status) {
  const box = document.getElementById('fiscal-warnings-box');
  if (!box) return;
  const warns = [];

  if (!status?.hasRnc) warns.push('El negocio no tiene RNC configurado.');
  if (!status?.hasCertificate) warns.push('No hay certificado digital del contribuyente cargado.');
  else if (status?.certificateStatus === 'vencido') warns.push('El certificado digital está vencido.');
  if (!status?.hasActiveSequences) warns.push('No hay secuencias e-NCF activas disponibles.');

  box.innerHTML = warns.length
    ? `<div class="fiscal-warn-list">${warns.map((warning) => `<div class="fiscal-warn-item">⚠ ${escapeHtml(warning)}</div>`).join('')}</div>`
    : '';
}

function renderChecklistSummary(checklist) {
  const summary = checklist?.summary || {};
  setText(
    'fiscal-checklist-summary',
    `${Number(summary.ok || 0)} OK • ${Number(summary.warning || 0)} observaciones • ${Number(summary.pending || 0)} pendientes`
  );
  setText(
    'fiscal-homologation-summary',
    `${Number(summary.ok || 0)} de ${Number(summary.total || 0)} puntos listos`
  );
}

function renderQuickChecklist(checklist) {
  const box = document.getElementById('fiscal-status-quick-checklist');
  if (!box) return;
  const items = (checklist?.items || []).slice(0, 6);
  if (!items.length) {
    box.innerHTML = '<div style="font-size:.82rem;color:var(--text3)">Sin información disponible todavía.</div>';
    return;
  }
  box.innerHTML = items.map((item) => `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.75rem;padding:.7rem .8rem;border:1px solid var(--border);border-radius:10px;background:var(--bg2)">
      <div>
        <div style="font-size:.84rem;font-weight:600">${escapeHtml(item.label)}</div>
        <div style="font-size:.78rem;color:var(--text3);margin-top:.2rem">${escapeHtml(item.message || '—')}</div>
      </div>
      ${renderStatusPill(item.status)}
    </div>
  `).join('');
}

function formatDocStateCaption(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const labels = {
    aceptado: 'Aceptado',
    aceptado_condicional: 'Aceptado condicional',
    rechazado: 'Rechazado',
    pendiente: 'Pendiente',
    firmado: 'Firmado',
    pendiente_red: 'Pendiente red',
    pendiente_rfce: 'Pendiente RFCE',
    enviado: 'Enviado',
    procesando: 'Procesando',
    en_proceso: 'En proceso',
    error_validacion: 'Error validación',
    error_firma: 'Error firma',
    error_xml: 'Error XML',
    error_auth: 'Error autenticación',
    error: 'Error',
    error_consulta: 'Error consulta'
  };
  return labels[normalized] || value || '—';
}

function renderCertificationSummary(summary) {
  const box = document.getElementById('certification-summary-panel');
  if (!box) return;
  const data = summary || {};
  const total = Number(data.total || 0);
  const accepted = Number(data.aceptadas || 0);
  const conditional = Number(data.aceptadasCondicionales || 0);
  const rejected = Number(data.rechazadas || 0);
  const pending = Number(data.pendientes || 0);
  const progress = Number(data.progress || 0);
  const avgSeconds = Number(data.averageResponseSeconds || 0);
  const last = data.ultimoEnvio || null;

  box.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.55rem">
      <div class="config-card" style="padding:.75rem;background:var(--bg2)"><div style="font-size:.78rem;color:var(--text3)">Total pruebas</div><div style="font-size:1.1rem;font-weight:700">${total}</div></div>
      <div class="config-card" style="padding:.75rem;background:var(--bg2)"><div style="font-size:.78rem;color:var(--text3)">Aceptadas</div><div style="font-size:1.1rem;font-weight:700;color:#2f855a">${accepted}</div></div>
      <div class="config-card" style="padding:.75rem;background:var(--bg2)"><div style="font-size:.78rem;color:var(--text3)">Aceptado condicional</div><div style="font-size:1.1rem;font-weight:700;color:#2b6cb0">${conditional}</div></div>
      <div class="config-card" style="padding:.75rem;background:var(--bg2)"><div style="font-size:.78rem;color:var(--text3)">Rechazadas</div><div style="font-size:1.1rem;font-weight:700;color:#c53030">${rejected}</div></div>
      <div class="config-card" style="padding:.75rem;background:var(--bg2)"><div style="font-size:.78rem;color:var(--text3)">Pendientes</div><div style="font-size:1.1rem;font-weight:700;color:#d69e2e">${pending}</div></div>
      <div class="config-card" style="padding:.75rem;background:var(--bg2)"><div style="font-size:.78rem;color:var(--text3)">Tiempo prom. DGII</div><div style="font-size:1.1rem;font-weight:700">${avgSeconds ? `${avgSeconds}s` : '—'}</div></div>
    </div>
    <div style="margin-top:.75rem">
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:.8rem;color:var(--text3);margin-bottom:.25rem">
        <span>Progreso</span>
        <strong style="color:var(--text1)">${progress}%</strong>
      </div>
      <div style="height:10px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden">
        <div style="height:100%;width:${Math.max(0, Math.min(progress, 100))}%;background:linear-gradient(90deg,var(--accent),#2f855a)"></div>
      </div>
    </div>
    <div style="margin-top:.75rem;font-size:.8rem;color:var(--text3)">
      <div><strong style="color:var(--text1)">Último envío:</strong> ${last ? `${escapeHtml(last.encf || '—')} · ${escapeHtml(formatDocStateCaption(last.estado || ''))} · ${formatDateTime(last.sent_at)}` : '—'}</div>
    </div>
  `;
}

function renderPublicUrls(publicUrls) {
  const box = document.getElementById('fiscal-public-urls-box');
  if (!box) return;
  if (!publicUrls?.baseUrl) {
    box.innerHTML = '<div style="color:var(--text3)">Configura una base URL pública HTTPS para publicar las rutas requeridas por DGII.</div>';
    return;
  }
  box.innerHTML = [
    ['Recepción', publicUrls.recepcionUrl],
    ['Aprobación comercial', publicUrls.aprobacionUrl],
    ['Semilla', publicUrls.semillaUrl],
    ['Validación certificado', publicUrls.validacionCertificadoUrl]
  ].map(([label, value]) => `
    <div style="margin-bottom:.45rem">
      <div style="font-weight:600;color:var(--text1)">${escapeHtml(label)}</div>
      <div style="word-break:break-all">${escapeHtml(value || '—')}</div>
    </div>
  `).join('');
}

function renderInternalTokenStatus(tokenInfo) {
  const box = document.getElementById('fiscal-internal-token-status');
  if (!box) return;
  if (!tokenInfo) {
    box.textContent = 'Sin datos del token interno.';
    return;
  }
  box.innerHTML = `
    <div><strong>Protección:</strong> ${tokenInfo.requireInternalToken ? 'Activa' : 'Inactiva'}</div>
    <div><strong>Configurado:</strong> ${tokenInfo.configured ? 'Sí' : 'No'}</div>
    <div><strong>Huella:</strong> ${escapeHtml(tokenInfo.hashPreview || '—')}</div>
  `;
}

// ── Visual Status Cards ─────────────────────────────────────────────────────
function _renderEcfStatusCards(status, bundle) {
  const cert = bundle?.certificate || {};

  function setCard(id, valId, html, state) {
    const card = document.getElementById(id);
    const val  = document.getElementById(valId);
    if (!val) return;
    val.innerHTML = html;
    if (card) {
      card.className = 'ecf-scard' + (state ? ` ecf-scard--${state}` : '');
    }
  }

  const dot = (color) => `<span class="ecf-dot ecf-dot--${color}"></span>`;

  // DGII connection
  if (status?.lastConnStatus === 'conectado') {
    setCard('ecf-scard-dgii', 'ecf-scard-dgii-val', `${dot('green')} Conectado`, 'ok');
  } else if (status?.lastConnMsg) {
    setCard('ecf-scard-dgii', 'ecf-scard-dgii-val', `${dot('red')} Error`, 'error');
  } else {
    setCard('ecf-scard-dgii', 'ecf-scard-dgii-val', `${dot('gray')} Sin conexión`, '');
  }

  // Certificado
  if (!status?.hasCertificate) {
    setCard('ecf-scard-cert', 'ecf-scard-cert-val', `${dot('red')} Sin certificado`, 'error');
  } else if (status?.certificateStatus === 'vencido' || cert.isExpired) {
    setCard('ecf-scard-cert', 'ecf-scard-cert-val', `${dot('red')} Vencido`, 'error');
  } else if (Number(cert.daysRemaining || 999) < 30) {
    const days = cert.daysRemaining ?? '?';
    setCard('ecf-scard-cert', 'ecf-scard-cert-val', `${dot('yellow')} Vence en ${days}d`, 'warn');
  } else {
    setCard('ecf-scard-cert', 'ecf-scard-cert-val', `${dot('green')} Válido`, 'ok');
  }

  // Facturación e-CF
  if (status?.isActive) {
    setCard('ecf-scard-factura', 'ecf-scard-factura-val', `${dot('green')} Activa`, 'ok');
  } else {
    setCard('ecf-scard-factura', 'ecf-scard-factura-val', `${dot('gray')} Inactiva`, '');
  }

  // Secuencias
  if (status?.hasActiveSequences) {
    setCard('ecf-scard-seq', 'ecf-scard-seq-val', `${dot('green')} Sincronizadas`, 'ok');
  } else {
    setCard('ecf-scard-seq', 'ecf-scard-seq-val', `${dot('yellow')} Sin secuencias`, 'warn');
  }

  // Último envío
  const lastSent = status?.lastSentAt || bundle?.receptionStorage?.lastSent;
  const valUlt = document.getElementById('ecf-scard-ultimo-val');
  if (valUlt) {
    valUlt.innerHTML = lastSent
      ? `<span style="font-size:11px;line-height:1.4">${escapeHtml(formatDateTime(lastSent))}</span>`
      : `<span style="color:var(--text3)">Sin envíos</span>`;
  }
}

// ── Mi Contador ──────────────────────────────────────────────────────────────
async function loadContadorSection() {
  const panel = document.getElementById('ecf-contador-panel');
  if (!panel) return;
  panel.innerHTML = '<div class="loading-text">Cargando…</div>';
  try {
    const token = (typeof getStoredAuthToken === 'function' ? getStoredAuthToken() : '') || DB?.authToken || '';
    const userId = DB?.currentUser?.id;
    const r = await fetch(`/api/platform/mi-contador${userId ? `?actorUserId=${userId}` : ''}`,
      { headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json();
    if (!data || !data.found) {
      panel.innerHTML = `
        <div style="text-align:center;padding:40px 20px;max-width:460px;margin:0 auto">
          <div style="font-size:48px;margin-bottom:16px">👨‍💼</div>
          <div style="font-size:1.1rem;font-weight:700;margin-bottom:8px">¿Necesitas ayuda con tus obligaciones fiscales?</div>
          <div style="font-size:.9rem;color:var(--text3);margin-bottom:24px">
            Conecta con un contador verificado Tecno Caja para gestionar tu DGII, e-CF y obligaciones tributarias desde aquí mismo.
          </div>
          <button class="btn-primary" onclick="openWizardStep('wizard-contador')">🔍 Buscar Contador Verificado</button>
        </div>`;
      return;
    }
    const c = data;
    const badge = c.verified ? '<span style="background:#065f46;color:#6ee7b7;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700">✅ Verificado DGII</span>' : '';
    panel.innerHTML = `
      <div style="display:grid;grid-template-columns:auto 1fr;gap:20px;align-items:start;max-width:640px">
        <div style="width:80px;height:80px;border-radius:50%;background:var(--bg2);border:2px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:36px;flex-shrink:0">
          ${c.logo_url ? `<img src="${escapeHtml(c.logo_url)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">` : '👨‍💼'}
        </div>
        <div>
          <div style="font-size:1.1rem;font-weight:700;margin-bottom:4px">${escapeHtml(c.nombre || c.nombre_firma || '—')}</div>
          ${badge}
          ${c.especialidad ? `<div style="font-size:.85rem;color:var(--text3);margin-top:6px">${escapeHtml(c.especialidad)}</div>` : ''}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px">
            ${c.telefono ? `<a href="tel:${escapeHtml(c.telefono)}" class="btn-secondary" style="text-decoration:none;text-align:center">📞 ${escapeHtml(c.telefono)}</a>` : ''}
            ${c.whatsapp ? `<a href="https://wa.me/${String(c.whatsapp).replace(/\D/g,'')}" target="_blank" class="btn-secondary" style="text-decoration:none;text-align:center">💬 WhatsApp</a>` : ''}
            ${c.email || c.correo ? `<a href="mailto:${escapeHtml(c.email || c.correo)}" class="btn-secondary" style="text-decoration:none;text-align:center">📧 Correo</a>` : ''}
            <button class="btn-secondary" onclick="showFiscalToast('Funcionalidad próximamente disponible.','info')">🔄 Solicitar cambio</button>
          </div>
        </div>
      </div>`;
  } catch (e) {
    panel.innerHTML = `<div style="color:var(--text3);padding:24px">No se pudo cargar la información del contador asignado.</div>`;
  }
}

// ── Centro Fiscal ────────────────────────────────────────────────────────────
function renderCentroFiscal() {
  const panel = document.getElementById('ecf-centro-fiscal-panel');
  if (!panel) return;

  const now  = new Date();
  const year = now.getFullYear();
  const mon  = now.getMonth() + 1; // 1-12

  // Calcular próximas fechas de vencimiento DGII (RD)
  // ITBIS: día 20 del mes siguiente
  // 606/607: día 20 del mes siguiente
  // ISR adelanto: día 15 del tercer mes del trimestre
  function nextDue(dayOfMonth, offsetMonths = 1) {
    const d = new Date(year, mon - 1 + offsetMonths, dayOfMonth);
    return d;
  }

  function daysLeft(d) {
    return Math.ceil((d - now) / 86400000);
  }

  function fmtDate(d) {
    return d.toLocaleDateString('es-DO', { day:'2-digit', month:'long', year:'numeric' });
  }

  function stateColor(days) {
    if (days < 0)  return { dot: 'red',    label: 'Atrasado',  cls: '#7f1d1d' };
    if (days <= 5) return { dot: 'red',    label: 'Urgente',   cls: '#7f1d1d' };
    if (days <= 15)return { dot: 'yellow', label: 'Próximo',   cls: '#78350f' };
    return             { dot: 'green',  label: 'Al día',    cls: '#064e3b' };
  }

  const obligations = [
    { icon:'🧾', name:'ITBIS (IT-1)',    due: nextDue(20), desc:'Declaración y pago mensual ITBIS' },
    { icon:'📋', name:'Formato 606',      due: nextDue(20), desc:'Compras y gastos del mes anterior' },
    { icon:'📋', name:'Formato 607',      due: nextDue(20), desc:'Ventas del mes anterior' },
    { icon:'🏦', name:'Retenciones 608',  due: nextDue(10), desc:'Retenciones efectuadas' },
    { icon:'💰', name:'ISR Adelanto',     due: nextDue(15, Math.ceil(mon / 3) * 3 - mon + 1), desc:'Pago a cuenta ISR trimestral' },
  ];

  panel.innerHTML = `
    <div style="margin-bottom:16px">
      <div style="font-size:1rem;font-weight:700">Centro Fiscal</div>
      <div style="font-size:.85rem;color:var(--text3)">Próximas obligaciones tributarias DGII — ${now.toLocaleDateString('es-DO',{month:'long',year:'numeric'})}</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">
      ${obligations.map(ob => {
        const days = daysLeft(ob.due);
        const st   = stateColor(days);
        return `
          <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px;border-left:3px solid ${st.cls === '#064e3b' ? '#10b981' : st.cls === '#78350f' ? '#f59e0b' : '#ef4444'}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
              <div style="font-size:20px">${ob.icon}</div>
              <span style="font-size:11px;font-weight:700;background:${st.cls};color:${st.dot==='green'?'#6ee7b7':st.dot==='yellow'?'#fde68a':'#fca5a5'};border-radius:4px;padding:2px 6px">${st.label}</span>
            </div>
            <div style="font-size:.9rem;font-weight:700;margin-bottom:2px">${ob.name}</div>
            <div style="font-size:.78rem;color:var(--text3);margin-bottom:6px">${ob.desc}</div>
            <div style="font-size:.82rem;font-weight:600">${fmtDate(ob.due)}</div>
            <div style="font-size:.78rem;color:var(--text3)">${days < 0 ? `${Math.abs(days)}d de retraso` : days === 0 ? 'Vence hoy' : `${days}d restantes`}</div>
          </div>`;
      }).join('')}
    </div>
    <div style="margin-top:14px;padding:.85rem 1rem;background:var(--bg2);border:1px solid var(--border);border-radius:10px;font-size:.82rem;color:var(--text3)">
      💡 Las fechas son aproximadas. Verifica en <strong>dgii.gov.do</strong> o consulta con tu contador.
    </div>`;
}

function renderBusinessForm(bundle, status) {
  const business = bundle?.business || {};
  const dgiiSettings = bundle?.dgiiSettings || {};

  ['rnc', 'razon_social', 'nombre_comercial', 'direccion', 'municipio', 'provincia', 'telefono', 'correo'].forEach((field) => {
    const el = document.getElementById(`fiscal-biz-${field}`);
    if (el) el.value = business[field] || '';
  });

  setSelectValue('fiscal-dgii-environment', dgiiSettings.environment || 'test');
  setSelectValue('fiscal-environment-select', dgiiSettings.environment || 'test');
  setSelectValue('fiscal-dgii-cert-mode', dgiiSettings.certificateMode || 'p12');

  setValue('fiscal-dgii-public-base-url', dgiiSettings.publicBaseUrl || '');
  setValue('fiscal-dgii-allowed-origins', dgiiSettings.allowedOrigins || '');
  setValue('fiscal-dgii-qscd-provider', dgiiSettings.qscdProvider || '');
  setValue('fiscal-dgii-qscd-preview', dgiiSettings.qscdConfigPreview || '');
  setValue('fiscal-dgii-qscd-config', '');
  setChecked('fiscal-dgii-clear-qscd', false);
  setChecked('fiscal-dgii-rfce-enabled', !!dgiiSettings.rfceEnabled);
  setChecked('fiscal-dgii-require-token', !!dgiiSettings.internalToken?.requireInternalToken);
  setValue('fiscal-dgii-notes', dgiiSettings.notes || '');

  const modeHint = document.getElementById('fiscal-cert-mode-hint');
  if (modeHint) {
    modeHint.textContent = dgiiSettings.certificateMode === 'qscd'
      ? 'Modo QSCD / cloud seleccionado. La firma real debe integrarse con el proveedor autorizado del contribuyente. El .p12 local queda fuera del flujo operativo.'
      : 'Modo .p12 local seleccionado. Sube exclusivamente el certificado del contribuyente, nunca uno del vendedor del software.';
  }

  syncFiscalEnvironmentSelects(dgiiSettings.environment || 'test');
  syncDgiiConfigVisibility();

  const certValidationBox = document.getElementById('fiscal-cert-validation-box');
  if (certValidationBox && !certValidationBox.dataset.hasContent) {
    certValidationBox.style.display = 'none';
  }

  const rotatedBox = document.getElementById('fiscal-rotated-token-box');
  if (rotatedBox && !rotatedBox.dataset.visible) {
    rotatedBox.style.display = 'none';
  }

  const businessEcfMode = document.getElementById('fiscal-business-ecf-mode');
  if (businessEcfMode && status) {
    businessEcfMode.innerHTML = status.isActive
      ? '<span class="fiscal-badge-green">Activo</span> Emite e-CF desde ventas.'
      : '<span class="fiscal-badge-gray">Inactivo</span> Todavía no envía ventas a DGII.';
  }
}

function renderCertificateInfo(cert, dgiiSettings = {}) {
  const box = document.getElementById('fiscal-cert-info');
  if (!box) return;

  if (!cert || !cert.hasCertificate) {
    box.innerHTML = '<div class="fiscal-no-cert">Sin certificado cargado.</div>';
    return;
  }

  const isExpired = !!cert.isExpired;
  const expClass = isExpired
    ? 'color:#e53e3e;font-weight:700'
    : Number(cert.daysRemaining || 0) < 30
      ? 'color:#dd6b20;font-weight:700'
      : 'color:#38a169';

  box.innerHTML = `
    <div class="fiscal-cert-grid">
      <div class="fiscal-cert-row"><span class="fiscal-cert-label">Tipo</span><span class="fiscal-cert-val">${escapeHtml(dgiiSettings.certificateMode === 'qscd' ? 'QSCD / Cloud' : '.p12 local')}</span></div>
      <div class="fiscal-cert-row"><span class="fiscal-cert-label">Subject</span><span class="fiscal-cert-val">${escapeHtml(cert.subject || '')}</span></div>
      <div class="fiscal-cert-row"><span class="fiscal-cert-label">Emisor</span><span class="fiscal-cert-val">${escapeHtml(cert.issuer || '')}</span></div>
      <div class="fiscal-cert-row"><span class="fiscal-cert-label">Serie</span><span class="fiscal-cert-val">${escapeHtml(cert.serialNumber || '')}</span></div>
      <div class="fiscal-cert-row"><span class="fiscal-cert-label">Emitido</span><span class="fiscal-cert-val">${formatDate(cert.validFrom)}</span></div>
      <div class="fiscal-cert-row"><span class="fiscal-cert-label">Vence</span><span class="fiscal-cert-val" style="${expClass}">${formatDate(cert.validTo)}${cert.daysRemaining !== null && cert.daysRemaining !== undefined ? ` (${cert.daysRemaining} días)` : ''}</span></div>
      <div class="fiscal-cert-row"><span class="fiscal-cert-label">Estado</span><span class="fiscal-cert-val"><span class="fiscal-badge-${isExpired ? 'red' : 'green'}">${isExpired ? 'Vencido' : 'Válido'}</span></span></div>
    </div>
  `;
}

function renderConnectionPanel(bundle, status) {
  const dgiiSettings = bundle?.dgiiSettings || {};
  const selectedEnvironment = dgiiSettings.environment || status?.environment || 'test';
  setSelectValue('fiscal-environment-select', selectedEnvironment);
  setSelectValue('fiscal-dgii-environment', selectedEnvironment);
  renderOfficialUrls(bundle?.officialUrlsByEnvironment, selectedEnvironment);
  renderSeedStorage(bundle?.seedStorage || null);
  renderReceptionStorage(bundle?.receptionStorage || null);
  renderRecentTestRuns(bundle?.recentTestRuns || []);
}

function renderOfficialUrls(officialUrlsByEnvironment, selectedEnvironment) {
  const box = document.getElementById('fiscal-official-urls');
  if (!box) return;
  const env = normalizeEnvironment(selectedEnvironment);
  const urls = officialUrlsByEnvironment?.[env];
  if (!urls) {
    box.innerHTML = '<div style="color:var(--text3)">No hay endpoints oficiales disponibles.</div>';
    return;
  }

  const lines = [
    ['Auth base', urls.auth?.baseUrl || urls.authUrl],
    ['Semilla', urls.auth?.seedUrl || urls.semillaUrl],
    ['Validar semilla', urls.auth?.validateSeedUrl || urls.validarSemillaUrl],
    ['Recepción e-CF', urls.ecf?.recepcionUrl || urls.recepcionUrl],
    ['Consulta resultado', urls.ecf?.consultaResultadoUrl || urls.consultaTrackIdUrl],
    ['Consulta estado', urls.ecf?.consultaEstadoUrl || urls.consultaEstadoUrl],
    ['Consulta TrackIDs', urls.ecf?.consultaTrackIdsUrl || urls.consultaTrackIdUrl],
    ['Aprobación comercial', urls.ecf?.aprobacionComercialUrl],
    ['FC / RFCE base', urls.fc?.baseUrl || urls.facturaConsumoUrl || 'No configurada'],
    ['Recepción RFCE', urls.fc?.recepcionResumenUrl || urls.facturaConsumoUrl || 'TODO profesional'],
    ['Consulta RFCE', urls.fc?.consultaResumenUrl || 'TODO profesional']
  ];

  box.innerHTML = `
    <div style="margin-bottom:.5rem"><strong>Ambiente:</strong> ${escapeHtml(ENV_LABELS[env] || env)}</div>
    ${lines.map(([label, value]) => `
      <div style="margin-bottom:.45rem">
        <div style="font-weight:600;color:var(--text1)">${escapeHtml(label)}</div>
        <div style="word-break:break-all">${escapeHtml(value || '—')}</div>
      </div>
    `).join('')}
  `;
}

function renderRecentTestRuns(runs) {
  const box = document.getElementById('fiscal-test-runs-list');
  if (!box) return;
  if (!runs.length) {
    box.innerHTML = '<div style="font-size:.8rem;color:var(--text3)">Todavía no hay pruebas registradas desde este panel.</div>';
    return;
  }
  box.innerHTML = runs.slice(0, 8).map((run) => `
    <div style="padding:.7rem .8rem;border:1px solid var(--border);border-radius:10px;background:var(--bg2)">
      <div style="display:flex;justify-content:space-between;gap:.75rem;align-items:flex-start">
        <div>
          <div style="font-size:.83rem;font-weight:700">${escapeHtml(TEST_LABELS[run.test_key] || run.test_key || 'Prueba')}</div>
          <div style="font-size:.77rem;color:var(--text3);margin-top:.18rem">${escapeHtml(run.summary || 'Sin resumen')}</div>
        </div>
        ${renderStatusPill(run.status)}
      </div>
      <div style="font-size:.73rem;color:var(--text3);margin-top:.35rem">${formatDateTime(run.created_at)}${run.environment ? ` • ${escapeHtml(ENV_LABELS[run.environment] || run.environment)}` : ''}</div>
    </div>
  `).join('');
}

function renderSeedStorage(seedStorage) {
  const box = document.getElementById('fiscal-seed-status');
  if (!box) return;

  const current = seedStorage?.current || null;
  if (!current) {
    box.innerHTML = `
      <div style="font-size:.82rem;color:var(--text3)">No hay semillas recientes disponibles. La próxima autenticación pedirá una nueva semilla a DGII.</div>
      <div style="font-size:.74rem;color:var(--text3);margin-top:.55rem">Historial: ${Number(seedStorage?.history?.length || 0)} registro(s)</div>
    `;
    return;
  }

  const envLabel = ENV_LABELS[current.environment] || current.environment || '—';
  const signedLine = current.signedPath
    ? `<div><strong>Archivo firmado:</strong> ${escapeHtml(current.signedPath)}</div>`
    : '';
  const errorLine = current.error
    ? `<div style="color:#c53030"><strong>Error:</strong> ${escapeHtml(current.error)}</div>`
    : '';

  box.innerHTML = `
    <div style="display:grid;gap:.42rem;font-size:.82rem;color:var(--text2)">
      <div><strong>Ultima semilla obtenida:</strong> ${escapeHtml(current.id || '—')}</div>
      <div><strong>Fecha:</strong> ${escapeHtml(formatDateTime(current.fecha))}</div>
      <div><strong>Ambiente:</strong> ${escapeHtml(envLabel)}</div>
      <div><strong>Estado:</strong> ${escapeHtml(formatSeedState(current.estado))}</div>
      <div><strong>Archivo original:</strong> ${escapeHtml(current.xmlPath || '—')}</div>
      ${signedLine}
      <div><strong>Historial:</strong> ${Number(seedStorage?.history?.length || 0)} registro(s)</div>
      <div style="margin-top:.15rem;padding:.55rem .65rem;border-radius:8px;background:var(--bg2);font-size:.76rem;color:var(--text3)">
        Flujo correcto: 1. obtener semilla desde DGII, 2. firmarla con el certificado <code>.p12</code>, 3. validar la semilla firmada en DGII.
      </div>
      ${errorLine}
    </div>
  `;
}

function renderReceptionStorage(receptionStorage) {
  const box = document.getElementById('fiscal-reception-status');
  if (!box) return;

  const latestSent = receptionStorage?.latestSent || null;
  const latestTrack = receptionStorage?.latestTrack || null;
  const latestTrackStatus = receptionStorage?.latestTrackStatus || null;

  if (!latestSent && !latestTrack && !latestTrackStatus) {
    box.innerHTML = '<div style="font-size:.82rem;color:var(--text3)">Todavía no hay envíos ni consultas de TrackID registradas.</div>';
    return;
  }

  const rawState = latestTrackStatus?.estado || latestTrack?.estado || 'ENVIADO';
  const env = latestTrackStatus?.environment || latestTrack?.environment || latestSent?.environment || '';
  const dgiiCode = latestTrackStatus?.codigo || latestTrack?.codigo || '—';
  const state = String(dgiiCode || '') === '4' && String(rawState || '').toUpperCase() === 'ACEPTADO'
    ? 'ACEPTADO_CONDICIONAL'
    : rawState;
  const dgiiDescription = latestTrackStatus?.descripcion || latestTrackStatus?.mensaje || latestTrack?.descripcion || latestTrack?.mensaje || '—';
  const dgiiDate = latestTrackStatus?.fechaRecepcion || latestTrackStatus?.fecha || latestTrack?.fecha || latestSent?.fecha || null;
  const trackId = latestTrackStatus?.trackId || latestTrack?.trackId || '—';
  const encf = latestTrackStatus?.encf || latestTrack?.encf || '—';
  const rnc = latestTrackStatus?.rnc || latestTrack?.rnc || '—';
  const secuenciaUtilizada = latestTrackStatus?.secuenciaUtilizada;
  const mensajes = Array.isArray(latestTrackStatus?.mensajes) ? latestTrackStatus.mensajes : [];
  const mensajesResumen = mensajes.length
    ? mensajes.map((message) => {
      const code = message?.codigo !== null && message?.codigo !== undefined ? `[${message.codigo}] ` : '';
      return `${code}${message?.valor || ''}`.trim();
    }).filter(Boolean).join(' | ')
    : '—';

  box.innerHTML = `
    <div style="display:grid;gap:.42rem;font-size:.82rem;color:var(--text2)">
      <div><strong>Estado:</strong> ${escapeHtml(formatReceptionState(state))}</div>
      <div><strong>Ambiente:</strong> ${escapeHtml(ENV_LABELS[env] || env || '—')}</div>
      <div><strong>TrackID:</strong> ${escapeHtml(trackId)}</div>
      <div><strong>e-NCF:</strong> ${escapeHtml(encf)}</div>
      <div><strong>RNC:</strong> ${escapeHtml(rnc)}</div>
      <div><strong>Fecha:</strong> ${escapeHtml(formatDateTime(dgiiDate))}</div>
      <div><strong>Fecha recepción DGII:</strong> ${escapeHtml(formatDateTime(latestTrackStatus?.fechaRecepcion || null))}</div>
      <div><strong>Secuencia utilizada:</strong> ${escapeHtml(secuenciaUtilizada === null || secuenciaUtilizada === undefined ? '—' : (secuenciaUtilizada ? 'Sí' : 'No'))}</div>
      <div><strong>XML enviado:</strong> ${escapeHtml(latestSent?.xmlPath || receptionStorage?.currentSentXmlPath || '—')}</div>
      <div><strong>Archivo DGII:</strong> ${escapeHtml(latestSent?.dgiiFileName || '—')}</div>
      <div><strong>Archivo track:</strong> ${escapeHtml(latestTrackStatus?.statusPath || latestTrack?.trackPath || receptionStorage?.currentTrackPath || '—')}</div>
      <div><strong>Código DGII:</strong> ${escapeHtml(dgiiCode || '—')}</div>
      <div><strong>Descripción DGII:</strong> ${escapeHtml(dgiiDescription || '—')}</div>
      <div><strong>Mensajes DGII:</strong> ${escapeHtml(mensajesResumen)}</div>
    </div>
  `;
}

function renderHomologationChecklist(checklist) {
  const box = document.getElementById('fiscal-homologation-list');
  if (!box) return;
  const items = checklist?.items || [];
  if (!items.length) {
    box.innerHTML = '<div style="font-size:.82rem;color:var(--text3)">Sin checklist disponible.</div>';
    return;
  }
  box.innerHTML = items.map((item) => `
    <div style="padding:.85rem .95rem;border:1px solid var(--border);border-radius:10px;background:${item.status === 'ok' ? '#f0fff4' : item.status === 'warning' ? '#fffaf0' : 'var(--bg2)'}">
      <div style="display:flex;justify-content:space-between;gap:.75rem;align-items:flex-start">
        <div>
          <div style="font-size:.85rem;font-weight:700">${escapeHtml(item.label)}</div>
          <div style="font-size:.78rem;color:var(--text2);margin-top:.22rem">${escapeHtml(item.message || '—')}</div>
          <div style="font-size:.72rem;color:var(--text3);margin-top:.3rem">Fuente: ${escapeHtml(renderChecklistSource(item.source))}</div>
        </div>
        ${renderStatusPill(item.status)}
      </div>
    </div>
  `).join('');

  const printItem = items.find((item) => item.key === 'print_representation');
  if (printItem) {
    setSelectValue('fiscal-manual-print-status', printItem.status || 'pending');
    setValue('fiscal-manual-print-notes', printItem.message && printItem.source === 'manual' ? printItem.message : '');
  }
}

function renderChecklistSource(source) {
  const labels = {
    local: 'evidencia local',
    test: 'prueba técnica',
    manual: 'validación manual',
    todo: 'pendiente profesional',
    pending: 'sin ejecutar'
  };
  return labels[source] || source || 'desconocida';
}

function syncDgiiConfigVisibility() {
  const mode = document.getElementById('fiscal-dgii-cert-mode')?.value || 'p12';
  const isQscd = mode === 'qscd';
  document.querySelectorAll('.fiscal-qscd-field').forEach((el) => {
    el.style.display = isQscd ? 'block' : 'none';
  });

  const fileInput = document.getElementById('fiscal-cert-file');
  const passInput = document.getElementById('fiscal-cert-password');
  const uploadBtn = document.getElementById('fiscal-btn-upload-cert');
  const toggleBtn = document.getElementById('fiscal-cert-password-toggle');
  if (fileInput) fileInput.disabled = isQscd;
  if (passInput) passInput.disabled = isQscd;
  if (uploadBtn) uploadBtn.disabled = isQscd;
  if (toggleBtn) toggleBtn.disabled = isQscd;

  const modeHint = document.getElementById('fiscal-cert-mode-hint');
  if (modeHint) {
    modeHint.textContent = isQscd
      ? 'QSCD / cloud requiere integración real con el proveedor del contribuyente. El backend ya está preparado para guardar la configuración, pero no simula firma remota.'
      : 'Sube aquí el .p12 del contribuyente para firmar XML localmente de forma segura.';
  }
}

function toggleFiscalCertPasswordVisibility() {
  const input = document.getElementById('fiscal-cert-password');
  const button = document.getElementById('fiscal-cert-password-toggle');
  if (!input || !button || input.disabled) return;

  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  button.textContent = showing ? '👁' : '🙈';
  button.setAttribute('aria-label', showing ? 'Mostrar contraseña del certificado' : 'Ocultar contraseña del certificado');
  button.setAttribute('title', showing ? 'Mostrar contraseña' : 'Ocultar contraseña');
}

function getFriendlyCertificateErrorMessage(message) {
  const raw = String(message || '').trim();
  const normalized = raw.toLowerCase();

  if (
    normalized.includes('invalid password') ||
    normalized.includes('mac could not be verified') ||
    normalized.includes('contraseña') ||
    normalized.includes('password')
  ) {
    return 'No se pudo abrir el certificado .p12. Verifica que la contraseña sea correcta.';
  }

  if (normalized.includes('no contiene') || normalized.includes('clave privada')) {
    return 'El archivo .p12 no contiene un certificado y clave privada válidos del contribuyente.';
  }

  if (normalized.includes('no existe')) {
    return 'No se encontró el archivo del certificado seleccionado.';
  }

  return raw || 'No se pudo validar el certificado.';
}

function syncFiscalEnvironmentSelects(value) {
  const env = normalizeEnvironment(value);
  setSelectValue('fiscal-environment-select', env);
  setSelectValue('fiscal-dgii-environment', env);
  if (FISCAL_UI_STATE.bundle?.officialUrlsByEnvironment) {
    renderOfficialUrls(FISCAL_UI_STATE.bundle.officialUrlsByEnvironment, env);
  }
}

async function uploadFiscalCertificate() {
  const mode = document.getElementById('fiscal-dgii-cert-mode')?.value || 'p12';
  if (mode !== 'p12') {
    showFiscalToast('La carga de .p12 solo aplica cuando el modo de certificado es local. Para QSCD/cloud deja la configuración del proveedor en Datos Negocio.', 'warning');
    return;
  }

  const fileInput = document.getElementById('fiscal-cert-file');
  const passInput = document.getElementById('fiscal-cert-password');
  const btn = document.getElementById('fiscal-btn-upload-cert');

  if (!fileInput?.files?.[0]) {
    showFiscalToast('Selecciona un archivo .p12', 'warning');
    return;
  }
  if (!passInput?.value) {
    showFiscalToast('Ingresa la contraseña del certificado', 'warning');
    return;
  }

  const formData = new FormData();
  formData.append('certificate', fileInput.files[0]);
  formData.append('password', passInput.value);

  setBtnLoading(btn, true, 'Validando…');
  try {
    const result = await fiscalApi('POST', '/certificate/upload', formData, true);
    passInput.value = '';
    fileInput.value = '';
    if (passInput.type === 'text') toggleFiscalCertPasswordVisibility();
    showFiscalToast('Certificado cargado y validado correctamente.', 'success');
    showFiscalTechnicalResult('Certificado cargado', result);
    await loadFiscalStatus();
  } catch (e) {
    const friendlyError = getFriendlyCertificateErrorMessage(e.message);
    showFiscalToast(`Error: ${friendlyError}`, 'error');
    showFiscalTechnicalResult('Error validando certificado', {
      error: friendlyError,
      originalError: e.message
    }, true);
  } finally {
    setBtnLoading(btn, false, '⬆ Subir y validar certificado');
  }
}

async function validateStoredFiscalCertificate() {
  const btn = document.getElementById('fiscal-btn-validate-stored-cert');
  setBtnLoading(btn, true, 'Validando…');
  try {
    const response = await fiscalApi('POST', '/certificate/validate-stored');
    const box = document.getElementById('fiscal-cert-validation-box');
    if (box) {
      box.dataset.hasContent = '1';
      box.style.display = 'block';
      box.innerHTML = `
        <div style="font-weight:700;margin-bottom:.3rem">Resultado de validación almacenada</div>
        <div><strong>Válido:</strong> ${response.ok ? 'Sí' : 'No'}</div>
        <div><strong>Vence:</strong> ${escapeHtml(formatDate(response.result?.validTo))}</div>
        <div><strong>RNC coincide:</strong> ${response.result?.rncMatch === null ? 'No verificado' : response.result?.rncMatch ? 'Sí' : 'No'}</div>
      `;
    }
    showFiscalTechnicalResult('Validación de certificado almacenado', response);
    showFiscalToast(response.ok ? 'Certificado almacenado validado.' : 'El certificado almacenado tiene observaciones.', response.ok ? 'success' : 'warning');
    await loadFiscalStatus();
  } catch (e) {
    showFiscalTechnicalResult('Error validando certificado almacenado', { error: e.message }, true);
    showFiscalToast(`Error: ${e.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, '🔐 Validar certificado almacenado');
  }
}

async function saveFiscalBusinessData() {
  const fields = ['rnc', 'razon_social', 'nombre_comercial', 'direccion', 'municipio', 'provincia', 'telefono', 'correo'];
  const body = {};
  fields.forEach((field) => {
    const el = document.getElementById(`fiscal-biz-${field}`);
    // IMPORTANTE: enviar '' (cadena vacía) cuando el campo está vacío, NO null.
    // Si enviamos null, upsertEmitter con ?? no lo actualiza y el valor anterior persiste.
    // Enviando '' permite limpiar explícitamente el campo en la BD.
    if (el) body[field] = el.value.trim(); // '' si vacío → limpia el campo en BD
  });

  const btn = document.getElementById('fiscal-btn-save-biz');
  setBtnLoading(btn, true, 'Guardando…');
  try {
    await fiscalApi('POST', '/config/business', body);
    showFiscalToast('✅ Datos del negocio guardados. Los XMLs de certificación en disco se limpiaron automáticamente.', 'success');
    await loadFiscalStatus();
    // Actualizar la vista previa automáticamente después de guardar
    const previewPanel = document.getElementById('emitter-xml-preview-panel');
    if (previewPanel && !previewPanel.classList.contains('hidden')) {
      await showEmitterXmlPreview();
    }
  } catch (e) {
    showFiscalToast(`Error: ${e.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, 'Guardar datos del negocio');
  }
}

/**
 * Muestra la vista previa de los datos del emisor tal como aparecerán en el XML.
 * Permite al usuario verificar ANTES de enviar que nombre_comercial, RNC, etc. son correctos.
 */
async function showEmitterXmlPreview() {
  let panel = document.getElementById('emitter-xml-preview-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'emitter-xml-preview-panel';
    panel.style.cssText = `
      position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
      background:#1e293b; color:#e2e8f0; border-radius:10px; padding:12px 16px;
      font-size:11px; line-height:1.55; border:1.5px solid #3b82f6;
      font-family:monospace; z-index:9999; max-width:400px; width:90vw;
      box-shadow:0 8px 32px rgba(0,0,0,.55);
    `;
    document.body.appendChild(panel);
  }

  panel.innerHTML = '<div style="color:#94a3b8">⏳ Cargando vista previa del XML del emisor…</div>';
  panel.classList.remove('hidden');

  try {
    const data = await fiscalApi('GET', '/emitter/xml-preview');
    const { emitter, xmlTags, warnings, source } = data;

    const tagRows = Object.entries(xmlTags || {}).map(([tag, val]) => {
      const isOmitted = val.includes('(no se incluirá)');
      const color = isOmitted ? '#64748b' : '#4ade80';
      return `<tr>
        <td style="color:#94a3b8;padding:1px 6px 1px 0;white-space:nowrap">&lt;${tag}&gt;</td>
        <td style="color:${color};padding:1px 0;word-break:break-all">${val}</td>
      </tr>`;
    }).join('');

    const warningHtml = (warnings || []).map((w) =>
      `<div style="color:#f87171;margin-top:4px">⚠ ${w}</div>`
    ).join('');

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px">
        <strong style="color:#3b82f6;font-size:11px">🔍 Vista previa — emisor en el XML</strong>
        <button onclick="document.getElementById('emitter-xml-preview-panel').remove()"
          style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:14px;line-height:1;padding:0 2px">✕</button>
      </div>
      <div style="color:#64748b;font-size:10px;margin-bottom:6px">Fuente: <strong style="color:#94a3b8">${source}</strong></div>
      <table style="border-collapse:collapse;width:100%">${tagRows}</table>
      ${warningHtml}
      <div style="margin-top:7px;color:#64748b;font-size:10px;line-height:1.4">
        Los campos "(no se incluirá en el XML)" son correctos si DGII no tiene ese dato registrado para el RNC.
      </div>
    `;
  } catch (e) {
    panel.innerHTML = `<div style="color:#f87171">Error al cargar vista previa: ${e.message}</div>`;
  }
}

/**
 * Modal de validación previa antes de enviar a DGII.
 * Muestra comparación entre datos configurados y datos en el XML.
 */
async function showDgiiPreSendValidation(caseId, onConfirm) {
  // Eliminar modal previo si existe
  document.getElementById('dgii-presend-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'dgii-presend-modal';
  modal.style.cssText = `
    position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.75);
    z-index:10000;display:flex;align-items:center;justify-content:center;
  `;
  modal.innerHTML = `
    <div style="background:#1e293b;border-radius:12px;padding:24px;max-width:600px;width:95%;
                color:#e2e8f0;border:2px solid #3b82f6;font-family:monospace;font-size:13px;
                max-height:85vh;overflow-y:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <strong style="color:#3b82f6;font-size:15px">✅ Validación previa DGII</strong>
        <button id="dgii-presend-close" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:18px">✕</button>
      </div>
      <div id="dgii-presend-content" style="color:#94a3b8">⏳ Verificando datos del emisor…</div>
      <div style="margin-top:16px;display:flex;gap:10px;justify-content:flex-end">
        <button id="dgii-presend-cancel" style="
          background:#374151;color:#e2e8f0;border:none;padding:8px 18px;
          border-radius:6px;cursor:pointer;font-size:13px;">Cancelar</button>
        <button id="dgii-presend-confirm" style="
          background:#3b82f6;color:#fff;border:none;padding:8px 18px;
          border-radius:6px;cursor:pointer;font-size:13px;" disabled>⏳ Verificando…</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector('#dgii-presend-close').onclick = close;
  modal.querySelector('#dgii-presend-cancel').onclick = close;

  try {
    // Cargar vista previa del emisor
    const preview = await fiscalApi('GET', '/emitter/xml-preview');
    const { emitter, xmlTags, warnings } = preview;

    const checks = [
      { ok: !!emitter.rnc, label: 'RNC cargado', valor: emitter.rnc || '(vacío)' },
      { ok: !!emitter.razonSocial, label: 'Razón social cargada', valor: emitter.razonSocial || '(vacío)' },
      { ok: true, label: 'Nombre comercial configurado', valor: emitter.nombreComercial || '(vacío — se omitirá del XML)' },
      { ok: !!emitter.direccion || true, label: 'Dirección', valor: emitter.direccion || '(no se incluirá en el XML)' },
    ];

    const checksHtml = checks.map((c) => `
      <div style="display:flex;align-items:center;gap:8px;padding:4px 0">
        <span style="color:${c.ok ? '#4ade80' : '#f87171'}">${c.ok ? '✓' : '✗'}</span>
        <span style="color:#94a3b8">${c.label}:</span>
        <span style="color:${c.ok ? '#e2e8f0' : '#fbbf24'}">${c.valor}</span>
      </div>
    `).join('');

    const warningsHtml = (warnings || []).length
      ? `<div style="background:#450a0a;border-radius:6px;padding:10px;margin:10px 0">
           ${warnings.map((w) => `<div style="color:#f87171">⚠ ${w}</div>`).join('')}
         </div>`
      : '';

    const hasErrors = warnings && warnings.length > 0;

    modal.querySelector('#dgii-presend-content').innerHTML = `
      <div style="margin-bottom:12px">
        <strong style="color:#94a3b8">Datos del negocio cargados desde la BD:</strong>
        <div style="margin-top:8px">${checksHtml}</div>
      </div>
      ${warningsHtml}
      <div style="background:#0f172a;border-radius:6px;padding:10px;font-size:12px">
        <strong style="color:#64748b">Tags que aparecerán en el XML:</strong><br>
        ${Object.entries(xmlTags || {}).map(([k, v]) => `
          <span style="color:#3b82f6">&lt;${k}&gt;</span>
          <span style="color:${v.includes('(no se incluirá)') ? '#64748b' : '#4ade80'}">${v}</span><br>
        `).join('')}
      </div>
      <div style="margin-top:10px;color:#64748b;font-size:11px">
        Fuente: ecf_emitters (base de datos, sin caché, sin valores hardcodeados)
      </div>
    `;

    const confirmBtn = modal.querySelector('#dgii-presend-confirm');
    if (hasErrors) {
      confirmBtn.textContent = '⚠ Hay errores — revisar';
      confirmBtn.style.background = '#dc2626';
      confirmBtn.disabled = false;
      confirmBtn.onclick = () => {
        close();
        showFiscalToast('Corrige los errores antes de enviar a DGII.', 'error');
      };
    } else {
      confirmBtn.textContent = '▶ Enviar a DGII';
      confirmBtn.style.background = '#16a34a';
      confirmBtn.disabled = false;
      confirmBtn.onclick = () => {
        close();
        if (onConfirm) onConfirm();
      };
    }
  } catch (e) {
    modal.querySelector('#dgii-presend-content').innerHTML =
      `<div style="color:#f87171">Error al verificar: ${e.message}</div>`;
    const confirmBtn = modal.querySelector('#dgii-presend-confirm');
    confirmBtn.textContent = 'Enviar de todas formas';
    confirmBtn.disabled = false;
    confirmBtn.onclick = () => { close(); if (onConfirm) onConfirm(); };
  }
}

async function saveDgiiSettings() {
  const btn = document.getElementById('fiscal-btn-save-dgii');
  const selectedEnvironment = normalizeEnvironment(document.getElementById('fiscal-dgii-environment')?.value || 'test');
  const currentEnvironment = normalizeEnvironment(FISCAL_UI_STATE.status?.environment || FISCAL_UI_STATE.bundle?.fiscalConfig?.environment || 'test');

  const body = {
    environment: selectedEnvironment,
    certificateMode: document.getElementById('fiscal-dgii-cert-mode')?.value || 'p12',
    rfceEnabled: document.getElementById('fiscal-dgii-rfce-enabled')?.checked ? 1 : 0,
    requireInternalToken: document.getElementById('fiscal-dgii-require-token')?.checked ? 1 : 0,
    publicBaseUrl: document.getElementById('fiscal-dgii-public-base-url')?.value.trim() || '',
    allowedOrigins: document.getElementById('fiscal-dgii-allowed-origins')?.value.trim() || '',
    qscdProvider: document.getElementById('fiscal-dgii-qscd-provider')?.value.trim() || '',
    notes: document.getElementById('fiscal-dgii-notes')?.value.trim() || '',
    clearQscdConfig: document.getElementById('fiscal-dgii-clear-qscd')?.checked ? 1 : 0
  };

  const qscdConfigJson = document.getElementById('fiscal-dgii-qscd-config')?.value.trim() || '';
  if (qscdConfigJson) body.qscdConfigJson = qscdConfigJson;

  setBtnLoading(btn, true, 'Guardando…');
  try {
    if (selectedEnvironment !== currentEnvironment) {
      await fiscalApi('POST', '/config/environment', { environment: selectedEnvironment });
    }
    await fiscalApi('POST', '/config/dgii', body);
    showFiscalToast('Configuración DGII guardada correctamente.', 'success');
    await loadFiscalStatus();
  } catch (e) {
    showFiscalToast(`Error: ${e.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, 'Guardar configuración DGII');
  }
}

async function rotateFiscalInternalToken() {
  if (!await showDeleteConfirm('Se generará un nuevo token interno para las rutas públicas DGII. El token anterior dejará de ser válido.', { confirmText: 'Rotar token' })) return;
  const btn = document.getElementById('fiscal-btn-rotate-token');
  setBtnLoading(btn, true, 'Rotando…');
  try {
    const result = await fiscalApi('POST', '/security/internal-token/rotate', {
      requireInternalToken: document.getElementById('fiscal-dgii-require-token')?.checked ? 1 : 0
    });
    const box = document.getElementById('fiscal-rotated-token-box');
    const value = document.getElementById('fiscal-rotated-token-value');
    if (box && value) {
      value.value = result.token || '';
      box.dataset.visible = '1';
      box.style.display = 'block';
    }
    showFiscalToast('Token interno rotado correctamente.', 'success');
    showFiscalTechnicalResult('Rotación de token interno', {
      ok: result.ok,
      maskedToken: result.maskedToken,
      internalToken: result.internalToken
    });
    await loadFiscalStatus();
  } catch (e) {
    showFiscalToast(`Error: ${e.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, 'Rotar token interno');
  }
}

async function saveFiscalEnvironment() {
  const env = normalizeEnvironment(document.getElementById('fiscal-environment-select')?.value || 'test');
  try {
    await fiscalApi('POST', '/config/environment', { environment: env });
    showFiscalToast(`Ambiente cambiado a "${ENV_LABELS[env] || env}". El token anterior fue invalidado.`, 'success');
    await loadFiscalStatus();
  } catch (e) {
    showFiscalToast(`Error: ${e.message}`, 'error');
  }
}

async function testDgiiConnection() {
  const btn = document.getElementById('fiscal-btn-test-conn');
  const env = normalizeEnvironment(document.getElementById('fiscal-environment-select')?.value || 'test');
  setBtnLoading(btn, true, 'Conectando…');
  try {
    const result = await fiscalApi('POST', '/dgii/test-connection', { environment: env });
    showFiscalTechnicalResult('Autenticación / prueba de conexión DGII', result);
    const blockingLabels = Array.isArray(result.blockingRequirements)
      ? result.blockingRequirements.map((item) => item.label).filter(Boolean)
      : [];
    const detailSuffix = blockingLabels.length ? ` Falta: ${blockingLabels.join(', ')}.` : '';
    showFiscalToast(
      result.ok
        ? `Configuración lista para pruebas e-CF (${env}).`
        : `${result.message || 'La configuración aún no está lista para pruebas.'}${detailSuffix}`,
      result.ok ? 'success' : 'warning'
    );
    await loadFiscalStatus();
  } catch (e) {
    showFiscalTechnicalResult('Error en prueba de conexión DGII', { error: e.message }, true);
    showFiscalToast(`Error: ${e.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, '⚡ Autenticar / probar conexión');
  }
}

async function runFiscalSeedTest() {
  const btn = document.getElementById('fiscal-btn-test-seed');
  const env = normalizeEnvironment(document.getElementById('fiscal-environment-select')?.value || 'test');
  setBtnLoading(btn, true, 'Obteniendo…');
  try {
    const result = await fiscalApi('POST', '/dgii/test-seed', { environment: env });
    showFiscalTechnicalResult('Paso 1 - Semilla obtenida desde DGII', result);
    showFiscalToast(
      result.ok
        ? `Semilla obtenida desde DGII y guardada en ${result.archivo || 'storage/ecf/seeds/current-semilla.xml'}. Falta firmarla con el certificado .p12.`
        : 'DGII respondió sin semilla interpretable.',
      result.ok ? 'success' : 'warning'
    );
    await loadFiscalStatus();
  } catch (e) {
    showFiscalTechnicalResult('Error en el paso 1 - Obtener semilla desde DGII', { error: e.message }, true);
    showFiscalToast(`Error: ${e.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, '🌱 Obtener semilla DGII');
  }
}

async function runDebugAuth() {
  const env = normalizeEnvironment(document.getElementById('fiscal-environment-select')?.value || 'test');
  showFiscalToast('Ejecutando flujo completo: obtener semilla, firmar con .p12 y validar en DGII…');
  try {
    const data = await fiscalApi('POST', '/dgii/debug-auth', { environment: env });
    const out = {
      environment: data.environment || env,
      seedValue: data.seedValue,
      seedFile: data.seedFile,
      signedSeedFile: data.signedSeedFile,
      validateUrl: data.validateSeedUrl,
      dgiiStatus: data.dgiiHttpStatus,
      dgiiBody: data.dgiiResponseBody,
      signedXmlPreview: data.signedXml ? data.signedXml.slice(0, 600) + '…' : null
    };
    showFiscalTechnicalResult('Paso 2 y 3 - Firmar semilla con .p12 y validarla en DGII', out);
    const ok = data.dgiiHttpStatus === 200;
    showFiscalToast(
      ok
        ? 'DGII aceptó la semilla firmada con el certificado .p12.'
        : `DGII rechazó la semilla firmada. HTTP ${data.dgiiHttpStatus}: ${data.dgiiResponseBody?.slice(0, 120)}`,
      ok ? 'success' : 'error'
    );
    await loadFiscalStatus();
  } catch (err) {
    showFiscalToast(`Error diagnóstico: ${err.message}`, 'error');
  }
}

async function viewCurrentSeedXml() {
  try {
    const res = await fetch('/api/ecf/dgii/seeds/current/xml?type=original', {
      headers: { Authorization: `Bearer ${DB?.authToken || ''}` }
    });
    const xml = await res.text();
    if (!res.ok) {
      let error = xml;
      try {
        error = JSON.parse(xml)?.error || xml;
      } catch (_) {}
      throw new Error(error || 'No se pudo obtener el XML de la semilla.');
    }

    showFiscalTechnicalResult('XML original de la semilla actual', xml);
    if (window.novaDesktop?.openTextFile) {
      await window.novaDesktop.openTextFile(xml, 'semilla-ecf.xml');
    }
  } catch (error) {
    showFiscalTechnicalResult('Error obteniendo XML de semilla', { error: error.message }, true);
    showFiscalToast(`Error: ${error.message}`, 'error');
  }
}

async function copyCurrentSeedXml() {
  try {
    const res = await fetch('/api/ecf/dgii/seeds/current/xml?type=original', {
      headers: { Authorization: `Bearer ${DB?.authToken || ''}` }
    });
    const xml = await res.text();
    if (!res.ok) {
      let error = xml;
      try {
        error = JSON.parse(xml)?.error || xml;
      } catch (_) {}
      throw new Error(error || 'No se pudo copiar el XML original de la semilla.');
    }
    if (!navigator.clipboard?.writeText) {
      throw new Error('El navegador no permite copiar al portapapeles en este entorno.');
    }
    await navigator.clipboard.writeText(xml);
    showFiscalToast('XML original de la semilla copiado al portapapeles.', 'success');
  } catch (error) {
    showFiscalToast(`Error: ${error.message}`, 'error');
  }
}

async function signCurrentSeed() {
  const btn = document.getElementById('fiscal-btn-sign-seed');
  setBtnLoading(btn, true, 'Firmando…');
  try {
    const result = await fiscalApi('POST', '/dgii/seeds/sign-current', {});
    showFiscalTechnicalResult('Paso 2 - Firma local de la semilla actual con certificado .p12', result);
    showFiscalToast(
      result.ok
        ? 'Semilla actual firmada correctamente con el certificado .p12.'
        : 'No se pudo firmar la semilla actual.',
      result.ok ? 'success' : 'warning'
    );
    await loadFiscalStatus();
  } catch (error) {
    showFiscalTechnicalResult('Error en el paso 2 - Firmar la semilla actual con .p12', { error: error.message }, true);
    showFiscalToast(`Error: ${error.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, 'Firmar con .p12');
  }
}

async function clearSeedHistory() {
  if (!await showDeleteConfirm('¿Eliminar el historial local de semillas DGII? Esta acción borra los XML guardados en storage/ecf/seeds.')) return;
  const btn = document.getElementById('fiscal-btn-clear-seed-history');
  setBtnLoading(btn, true, 'Limpiando…');
  try {
    const result = await fiscalApi('POST', '/dgii/seeds/clear-history', {});
    showFiscalTechnicalResult('Historial de semillas limpiado', result);
    showFiscalToast(`Historial limpiado. ${result.removed || 0} registro(s) eliminados.`, 'success');
    await loadFiscalStatus();
  } catch (error) {
    showFiscalTechnicalResult('Error limpiando historial de semillas', { error: error.message }, true);
    showFiscalToast(`Error: ${error.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, 'Limpiar historial');
  }
}

async function runFiscalSendTest() {
  const btn = document.getElementById('fiscal-btn-test-send');
  const xmlPath = document.getElementById('fiscal-send-xml-path')?.value.trim() || '';
  const manualEncf = document.getElementById('fiscal-send-encf-manual')?.value.trim() || '';
  const environment = document.getElementById('fiscal-environment-select')?.value || document.getElementById('fiscal-dgii-environment')?.value || 'testecf';
  setBtnLoading(btn, true, 'Enviando…');
  try {
    const result = await fiscalApi('POST', '/enviar', { xmlPath, manualEncf, environment });
    const trackInput = document.getElementById('fiscal-test-trackid');
    if (trackInput && result.trackId) {
      trackInput.value = result.trackId;
    }
    showFiscalTechnicalResult('Envío XML a DGII', result);
    showFiscalToast(
      `XML enviado. ${result.encf ? `e-NCF: ${result.encf}. ` : ''}TrackID: ${result.trackId || 'sin respuesta'}`,
      result.trackId ? 'success' : 'warning'
    );
    await loadFiscalStatus();
    await loadEcfDocuments();
  } catch (e) {
    showFiscalTechnicalResult('Error enviando XML a DGII', { error: e.message, details: e.details || null }, true);
    showFiscalToast(`Error: ${e.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, '📤 Enviar XML');
  }
}

async function runFiscalTrackIdTest() {
  const btn = document.getElementById('fiscal-btn-test-trackid');
  const trackInput = document.getElementById('fiscal-test-trackid');
  const manualTrackId = trackInput?.value.trim() || '';
  const latestTrackId = FISCAL_UI_STATE.bundle?.receptionStorage?.latestTrackStatus?.trackId
    || FISCAL_UI_STATE.bundle?.receptionStorage?.latestTrack?.trackId
    || '';
  const trackId = manualTrackId || latestTrackId;
  const environment = document.getElementById('fiscal-environment-select')?.value || document.getElementById('fiscal-dgii-environment')?.value || 'testecf';
  setBtnLoading(btn, true, 'Consultando…');
  try {
    if (!trackId) throw new Error('Debes indicar un TrackID o enviar un documento primero.');
    const result = await fiscalApi('GET', `/track/${encodeURIComponent(trackId)}?environment=${encodeURIComponent(environment)}`);
    if (trackInput && !trackInput.value.trim()) {
      trackInput.value = trackId;
    }
    showFiscalTechnicalResult('Consulta TrackID', result);
    showFiscalToast(
      result.autoRetryAvailable
        ? 'Consulta TrackID ejecutada. DGII reportó secuencia usada; el sistema ya no reenviará automáticamente al consultar.'
        : 'Consulta TrackID ejecutada.',
      result.autoRetryAvailable ? 'warning' : 'success'
    );
    await loadFiscalStatus();
    await loadEcfDocuments();
  } catch (e) {
    showFiscalTechnicalResult('Error consultando TrackID', { error: e.message, details: e.details || null }, true);
    showFiscalToast(`Error: ${e.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, '🔎 Consultar TrackID');
  }
}

async function viewCurrentSentXml() {
  try {
    const res = await fetch('/api/ecf/enviados/current/xml', {
      headers: { Authorization: `Bearer ${DB?.authToken || ''}` }
    });
    if (!res.ok) {
      const raw = await res.text();
      throw new Error(raw || 'No se pudo obtener el XML enviado.');
    }
    const xml = await res.text();
    if (window.novaDesktop?.openTextFile) {
      await window.novaDesktop.openTextFile(xml, 'ecf-enviado.xml');
    }
  } catch (error) {
    showFiscalTechnicalResult('Error mostrando XML enviado', { error: error.message }, true);
    showFiscalToast(`Error: ${error.message}`, 'error');
  }
}

async function saveFiscalManualPrintCheck() {
  const btn = document.getElementById('fiscal-btn-save-manual-print');
  const status = document.getElementById('fiscal-manual-print-status')?.value || 'pending';
  const notes = document.getElementById('fiscal-manual-print-notes')?.value.trim() || '';
  setBtnLoading(btn, true, 'Guardando…');
  try {
    await fiscalApi('POST', '/homologation/checklist/print_representation', { status, notes });
    showFiscalToast('Validación manual guardada.', 'success');
    await loadFiscalStatus();
  } catch (e) {
    showFiscalToast(`Error: ${e.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, 'Guardar validación manual');
  }
}

async function activateFiscalMode() {
  const validation = await fiscalApi('GET', '/validate-activation').catch(() => ({ canActivate: false, reasons: [] }));
  if (!validation.canActivate) {
    showFiscalToast(`No se puede activar: ${(validation.reasons || []).join(' | ')}`, 'error');
    return;
  }
  if (!await showDeleteConfirm('¿Activar la facturación electrónica e-CF? Las nuevas ventas intentarán emitir e-CF en DGII usando la configuración del contribuyente.', { confirmText: 'Activar e-CF' })) return;
  const btn = document.getElementById('fiscal-btn-activate');
  setBtnLoading(btn, true, 'Activando…');
  try {
    await fiscalApi('POST', '/activate');
    showFiscalToast('Facturación electrónica e-CF activada correctamente.', 'success');
    await loadFiscalStatus();
  } catch (e) {
    showFiscalToast(`Error: ${e.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, '✓ Activar facturación electrónica');
  }
}

async function deactivateFiscalMode() {
  if (!await showDeleteConfirm('Las facturas electrónicas ya emitidas se conservarán. A partir de ahora las nuevas ventas no serán enviadas a DGII. ¿Desactivar?', { confirmText: 'Desactivar e-CF' })) return;
  const btn = document.getElementById('fiscal-btn-deactivate');
  setBtnLoading(btn, true, 'Desactivando…');
  try {
    await fiscalApi('POST', '/deactivate');
    showFiscalToast('Facturación electrónica desactivada. El historial se conserva.', 'success');
    await loadFiscalStatus();
  } catch (e) {
    showFiscalToast(`Error: ${e.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, '✗ Desactivar facturación electrónica');
  }
}

async function loadFiscalSequences() {
  const container = document.getElementById('fiscal-seq-list');
  if (!container) return;
  container.innerHTML = '<div class="loading-text">Cargando secuencias…</div>';
  try {
    const seqs = await fiscalApi('GET', '/sequences');
    renderSequencesTable(container, seqs);
    FISCAL_UI_STATE.sequencesLoaded = true;
  } catch (e) {
    container.innerHTML = `<div class="error-text">Error al cargar: ${escapeHtml(e.message)}</div>`;
  }
  loadSequenceUsagePanel();
}

async function loadSequenceUsagePanel() {
  const panel = document.getElementById('ecf-seq-usage-panel');
  if (!panel) return;
  try {
    const stats = await fiscalApi('GET', '/sequence-usage/stats');
    if (!stats.length) {
      panel.innerHTML = '<p style="font-size:.8rem;color:var(--text3);margin:0">No hay e-NCF enviados a DGII registrados aún.</p>';
      return;
    }
    const statusLabel = (s) => ({
      ACCEPTED: '<span style="color:#10b981;font-weight:700">✓ Aceptada</span>',
      REJECTED: '<span style="color:#ef4444;font-weight:700">✗ Rechazada</span>',
      BLOCKED_DGII_USED: '<span style="color:#f59e0b;font-weight:700">⛔ Bloqueada DGII</span>',
      SENT: '<span style="color:#3b82f6">↑ Enviada</span>',
      RESERVED: '<span style="color:var(--text3)">⏳ Reservada</span>',
    }[s] || s);
    panel.innerHTML = `
      <div style="overflow-x:auto">
        <table class="compact-table" style="width:100%;font-size:.78rem">
          <thead>
            <tr>
              <th>Tipo e-CF</th>
              <th style="text-align:right">Último usado</th>
              <th style="text-align:right">Próximo disponible</th>
              <th style="text-align:right">Aceptadas</th>
              <th style="text-align:right">Rechazadas</th>
              <th style="text-align:right">Bloqueadas</th>
              <th style="text-align:right">Enviadas</th>
              <th style="text-align:right">Total registradas</th>
              <th style="text-align:right">Disponibles</th>
              <th>Último envío</th>
            </tr>
          </thead>
          <tbody>
            ${stats.map(r => `
              <tr>
                <td><strong>${escapeHtml(r.tipoEcf)}</strong></td>
                <td style="text-align:right;font-family:monospace">${r.ultimoNumero || '—'}</td>
                <td style="text-align:right;font-family:monospace;color:var(--accent)">${r.proximoDisponible || '—'}</td>
                <td style="text-align:right;color:#10b981">${r.aceptadas || 0}</td>
                <td style="text-align:right;color:#ef4444">${r.rechazadas || 0}</td>
                <td style="text-align:right;color:#f59e0b">${r.bloqueadas || 0}</td>
                <td style="text-align:right;color:#3b82f6">${r.enviadas || 0}</td>
                <td style="text-align:right">${r.total || 0}</td>
                <td style="text-align:right;color:${r.disponibleTotal > 0 ? '#10b981' : '#ef4444'}">${r.disponibleTotal ?? '—'}</td>
                <td style="font-size:.72rem;color:var(--text3)">${r.ultimoEnvio ? new Date(r.ultimoEnvio).toLocaleString('es-DO') : '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (e) {
    panel.innerHTML = `<p style="font-size:.8rem;color:var(--text3);margin:0">No se pudieron cargar estadísticas: ${escapeHtml(e.message)}</p>`;
  }
}

async function openFindNextSequenceModal() {
  const tipo = prompt('Ingresa el tipo de e-CF a consultar (ej. E31, E32, E33, E41, E44, E45, E46, E47):');
  if (!tipo) return;
  try {
    const r = await fiscalApi('POST', '/sequence-usage/find-next', { tipoEcf: tipo.trim().toUpperCase() });
    if (!r.ok) { showFiscalToast(r.message || 'No se encontró resultado.', 'warning'); return; }
    const lines = [
      `Tipo: ${r.tipoEcf}`,
      `Próximo disponible: ${r.proximoDisponible}`,
      r.encf ? `e-NCF: ${r.encf}` : '',
      `Máximo usado en DGII: ${r.maxUsadoEnDGII || 0}`,
      `Próximo en secuencia local: ${r.proxNumeroSecuencia || 'Sin secuencia'}`,
      r.disponibleTotal !== undefined ? `Disponibles: ${r.disponibleTotal}` : '',
    ].filter(Boolean).join('\n');
    if (r.encf && confirm(`${lines}\n\n¿Actualizar la secuencia ${r.tipoEcf} al próximo disponible (${r.proximoDisponible})?`)) {
      if (r.secuenciaId) {
        await fiscalApi('POST', `/sequences/${r.secuenciaId}/next`, { proximoNumero: r.proximoDisponible });
        showFiscalToast(`Secuencia ${r.tipoEcf} actualizada al ${r.proximoDisponible}. Próximo e-NCF: ${r.encf}`, 'success');
        loadFiscalSequences();
      }
    } else {
      showFiscalToast(lines.replace(/\n/g, ' | '), 'info');
    }
  } catch (e) {
    showFiscalToast(`Error: ${e.message}`, 'error');
  }
}

function renderSequencesTable(container, seqs) {
  if (!seqs.length) {
    container.innerHTML = '<div class="empty-state-small">No hay secuencias e-NCF configuradas. Agrega una abajo.</div>';
    return;
  }
  container.innerHTML = `
    <table class="compact-table" style="width:100%;font-size:0.82rem">
      <thead><tr>
        <th>Tipo</th><th>Descripción</th><th>Sucursal</th><th>Caja</th>
        <th>Prefijo</th><th>Rango</th><th>Próximo</th><th>Restantes</th>
        <th>Vence</th><th>Estado</th><th></th>
      </tr></thead>
      <tbody>
        ${seqs.map((seq) => {
          const restPct = seq.hasta > 0 ? (seq.remaining / (seq.hasta - seq.desde + 1)) * 100 : 0;
          const restStyle = seq.isExhausted
            ? 'color:#e53e3e;font-weight:700'
            : restPct < 10
              ? 'color:#dd6b20;font-weight:700'
              : restPct < 25
                ? 'color:#d69e2e'
                : '';
          const expStyle = seq.isExpired ? 'color:#e53e3e;font-weight:700' : '';
          const statusCls = !seq.activo ? 'gray' : seq.isExpired || seq.isExhausted ? 'red' : 'green';
          const statusLbl = !seq.activo ? 'Inactiva' : seq.isExpired ? 'Vencida' : seq.isExhausted ? 'Agotada' : 'Activa';
          return `
            <tr>
              <td><strong style="color:var(--accent)">${escapeHtml(seq.tipoComprobante)}</strong></td>
              <td>${escapeHtml(seq.label)}</td>
              <td>${escapeHtml(seq.branchName)}</td>
              <td>${escapeHtml(seq.cashRegisterName || 'Global')}</td>
              <td>${escapeHtml(seq.prefijo)}${escapeHtml(seq.serie || '')}</td>
              <td>${Number(seq.desde || 0).toLocaleString()}–${Number(seq.hasta || 0).toLocaleString()}</td>
              <td>${Number(seq.proximo || 0).toLocaleString()}</td>
              <td style="${restStyle}">${seq.isExhausted ? '⚠ Agotada' : Number(seq.remaining || 0).toLocaleString()}</td>
              <td style="${expStyle}">${seq.fechaVencimiento ? formatDate(seq.fechaVencimiento) : '—'}</td>
              <td><span class="badge-${statusCls}" style="font-size:0.7rem">${statusLbl}</span></td>
              <td style="display:flex;gap:.35rem;flex-wrap:wrap">
                ${seq.activo ? `<button class="btn-xs" onclick='setEcfSequenceNext(${seq.id}, ${Number(seq.proximo || 0)}, ${JSON.stringify(String(seq.tipoComprobante || ''))})' title="Ajustar próximo número">↺</button>` : ''}
                ${seq.activo ? `<button class="btn-xs btn-danger" onclick="disableEcfSequence(${seq.id})" title="Desactivar">✕</button>` : ''}
                <button class="btn-xs btn-danger" onclick="deleteEcfSequencePermanently(${seq.id},'${escapeHtml(seq.tipoComprobante)}')" title="Eliminar permanentemente">🗑</button>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

async function initEcfSequenceForm() {
  const branchSel = document.getElementById('fiscal-seq-branch');
  const cajaSel = document.getElementById('fiscal-seq-caja');
  const typeSelect = document.getElementById('fiscal-seq-type');

  if (!FISCAL_UI_STATE.branches.length) {
    try {
      FISCAL_UI_STATE.branches = await fetchJsonWithAuth('/api/branches');
    } catch (_) {
      FISCAL_UI_STATE.branches = [];
    }
  }
  if (!FISCAL_UI_STATE.cashRegisters.length) {
    try {
      FISCAL_UI_STATE.cashRegisters = await fetchJsonWithAuth('/api/cash-registers');
    } catch (_) {
      FISCAL_UI_STATE.cashRegisters = [];
    }
  }

  if (branchSel) {
    branchSel.innerHTML = '<option value="">Global (todas las sucursales)</option>' +
      FISCAL_UI_STATE.branches.map((branch) => `<option value="${branch.id}">${escapeHtml(branch.nombre)}</option>`).join('');
    branchSel.onchange = () => populateSequenceCashRegisterOptions(branchSel.value || '');
  }

  populateSequenceCashRegisterOptions(branchSel?.value || '');

  if (typeSelect && typeSelect.children.length <= 1) {
    try {
      const types = await fiscalApi('GET', '/sequences/types');
      typeSelect.innerHTML = '<option value="">— Selecciona tipo —</option>' +
        types.map((type) => `<option value="${type.code}">${type.code} — ${escapeHtml(type.label)}</option>`).join('');
    } catch (_) {
      typeSelect.innerHTML = `
        <option value="">— Selecciona tipo —</option>
        <option value="E31">E31 — Crédito Fiscal</option>
        <option value="E32">E32 — Consumidor Final</option>
        <option value="E33">E33 — Nota de Débito</option>
        <option value="E34">E34 — Nota de Crédito</option>
        <option value="E41">E41 — Compras</option>
        <option value="E43">E43 — Gastos Menores</option>
        <option value="E44">E44 — Regímenes Especiales</option>
        <option value="E45">E45 — Gubernamental</option>
        <option value="E46">E46 — Exportaciones</option>
        <option value="E47">E47 — Pagos al Exterior</option>`;
    }
  }

  if (cajaSel && !cajaSel.value) {
    cajaSel.innerHTML = '<option value="">Global / todas las cajas</option>';
  }
}

function populateSequenceCashRegisterOptions(branchId) {
  const cajaSel = document.getElementById('fiscal-seq-caja');
  if (!cajaSel) return;
  const normalizedBranchId = Number(branchId || 0) || null;
  const filtered = normalizedBranchId
    ? FISCAL_UI_STATE.cashRegisters.filter((item) => Number(item.sucursalId || item.branch_id || 0) === normalizedBranchId)
    : FISCAL_UI_STATE.cashRegisters;

  cajaSel.innerHTML = '<option value="">Global / todas las cajas</option>' +
    filtered.map((register) => {
      const branchName = register.sucursalNombre ? ` (${register.sucursalNombre})` : '';
      return `<option value="${register.id}">${escapeHtml(register.nombre)}${escapeHtml(branchName)}</option>`;
    }).join('');
}

async function saveEcfSequence() {
  const tipo = document.getElementById('fiscal-seq-type')?.value;
  const branchId = document.getElementById('fiscal-seq-branch')?.value || null;
  const cashRegisterId = document.getElementById('fiscal-seq-caja')?.value || null;
  const desde = parseInt(document.getElementById('fiscal-seq-desde')?.value, 10) || 1;
  const hasta = parseInt(document.getElementById('fiscal-seq-hasta')?.value, 10) || 9999999999;
  const fechaAutorizacion = document.getElementById('fiscal-seq-fecha-aut')?.value || null;
  const fechaVencimiento = document.getElementById('fiscal-seq-fecha-ven')?.value || null;

  if (!tipo) {
    showFiscalToast('Selecciona el tipo de comprobante.', 'warning');
    return;
  }
  if (hasta < desde) {
    showFiscalToast('El límite debe ser mayor al número inicial.', 'warning');
    return;
  }

  const btn = document.getElementById('fiscal-btn-save-seq');
  setBtnLoading(btn, true, 'Guardando…');
  try {
    await fiscalApi('POST', '/sequences', {
      tipoComprobante: tipo,
      branchId: branchId || null,
      cashRegisterId: cashRegisterId || null,
      desde,
      hasta,
      fechaAutorizacion,
      fechaVencimiento
    });
    showFiscalToast('Secuencia e-NCF creada correctamente.', 'success');
    const details = document.getElementById('fiscal-seq-add-details');
    if (details) details.open = false;
    await loadFiscalSequences();
    await loadFiscalStatus();
  } catch (e) {
    showFiscalToast(`Error: ${e.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, 'Guardar secuencia');
  }
}

async function setEcfSequenceNext(id, currentNext, tipo) {
  const nextValue = prompt(`Indica el próximo número para la secuencia ${tipo}.`, String(currentNext || ''));
  if (nextValue == null) return;
  const parsed = parseInt(String(nextValue).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    showFiscalToast('Debes indicar un próximo número válido.', 'warning');
    return;
  }

  try {
    await fiscalApi('POST', `/sequences/${id}/next`, { proximoNumero: parsed });
    showFiscalToast(`Secuencia ${tipo} actualizada. Próximo número: ${parsed}.`, 'success');
    await loadFiscalSequences();
    await loadFiscalStatus();
  } catch (e) {
    showFiscalToast(`Error: ${e.message}`, 'error');
  }
}

async function disableEcfSequence(id) {
  if (!await showDeleteConfirm('¿Desactivar esta secuencia e-NCF? No podrá ser usada hasta ser reactivada, pero el historial se conserva.', { confirmText: 'Desactivar' })) return;
  try {
    await fiscalApi('DELETE', `/sequences/${id}`);
    showFiscalToast('Secuencia desactivada.', 'success');
    await loadFiscalSequences();
    await loadFiscalStatus();
  } catch (e) {
    showFiscalToast(`Error: ${e.message}`, 'error');
  }
}

async function deleteEcfSequencePermanently(id, tipo) {
  if (!confirm(`¿ELIMINAR permanentemente la secuencia ${tipo || id}?\n\nEsta acción no se puede deshacer. La secuencia será borrada de la base de datos.`)) return;
  try {
    const r = await fiscalApi('DELETE', `/sequences/${id}/permanent`);
    if (r.ok) {
      showFiscalToast(`Secuencia ${tipo || id} eliminada.`, 'success');
      await loadFiscalSequences();
      await loadFiscalStatus();
    } else {
      showFiscalToast(r.message || 'No se pudo eliminar.', 'warning');
    }
  } catch (e) {
    showFiscalToast(`Error: ${e.message}`, 'error');
  }
}

async function loadEcfDocuments(page = 1) {
  const container = document.getElementById('fiscal-docs-list');
  if (!container) return;
  container.innerHTML = '<div class="loading-text">Cargando documentos…</div>';

  const estado = document.getElementById('fiscal-docs-filter-estado')?.value || '';
  const desde = document.getElementById('fiscal-docs-filter-desde')?.value || '';
  const hasta = document.getElementById('fiscal-docs-filter-hasta')?.value || '';

  try {
    const params = new URLSearchParams({ page: String(page), limit: '30' });
    if (estado) params.set('estado', estado);
    if (desde) params.set('desde', desde);
    if (hasta) params.set('hasta', hasta);

    const data = await fiscalApi('GET', `/documents?${params}`);
    renderDocsTable(container, data);
  } catch (e) {
    container.innerHTML = `<div class="error-text">Error: ${escapeHtml(e.message)}</div>`;
  }
}

function renderDocsTable(container, data) {
  const docs = data?.documents || [];
  const total = Number(data?.total || 0);
  if (!docs.length) {
    container.innerHTML = '<div class="empty-state-small">No hay documentos e-CF en este rango.</div>';
    return;
  }

  const estadoMap = {
    aceptado: 'green',
    aceptado_condicional: 'blue',
    rechazado: 'red',
    pendiente: 'yellow',
    firmado: 'blue',
    pendiente_red: 'orange',
    pendiente_rfce: 'orange',
    enviado: 'blue',
    procesando: 'blue',
    error_validacion: 'red',
    error_firma: 'red',
    error_xml: 'red',
    error_auth: 'red',
    error: 'red',
    error_consulta: 'red'
  };

  const formatDocStateLabel = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    const labels = {
      aceptado: 'Aceptado',
      aceptado_condicional: 'Aceptado condicional',
      rechazado: 'Rechazado',
      pendiente: 'Pendiente',
      firmado: 'Firmado',
      pendiente_red: 'Pendiente red',
      pendiente_rfce: 'Pendiente RFCE',
      enviado: 'Enviado',
      procesando: 'Procesando',
      en_proceso: 'En proceso',
      error_validacion: 'Error validación',
      error_firma: 'Error firma',
      error_xml: 'Error XML',
      error_auth: 'Error autenticación',
      error: 'Error',
      error_consulta: 'Error consulta'
    };
    return labels[normalized] || value || '—';
  };

  container.innerHTML = `
    <p style="font-size:0.8rem;color:var(--text3);margin:0 0 0.5rem">${total.toLocaleString()} documento(s) en total</p>
    <div style="overflow-x:auto">
      <table class="compact-table" style="width:100%;font-size:0.8rem">
        <thead>
          <tr>
            <th>e-NCF</th><th>Tipo</th><th>Comprador</th><th>Monto</th>
            <th>ITBIS</th><th>TrackID</th><th>XML/Endpoint</th><th>Emisión</th><th>Estado DGII</th><th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          ${docs.map((doc) => `
            <tr>
              <td><code>${escapeHtml(doc.encf)}</code></td>
              <td>${escapeHtml(doc.tipo_ecf)}</td>
              <td>${escapeHtml(doc.nombre_comprador || 'Consumidor Final')}</td>
              <td style="text-align:right">${Number(doc.monto_total || 0).toLocaleString('es-DO', { style: 'currency', currency: 'DOP' })}</td>
              <td style="text-align:right">${Number(doc.itbis_total || 0).toLocaleString('es-DO', { style: 'currency', currency: 'DOP' })}</td>
              <td><code>${escapeHtml(doc.track_id || '—')}</code>${doc.submission_mode === 'rfce' ? '<div style="font-size:0.68rem;color:var(--text3)">RFCE</div>' : ''}</td>
              <td style="font-size:0.72rem;line-height:1.25">
                <strong>${escapeHtml(doc.xmlType || (doc.submissionMode === 'rfce' || doc.submission_mode === 'rfce' ? 'RFCE' : 'ECF'))}</strong>
                <div>${escapeHtml(doc.submission_mode === 'rfce' ? 'RecepcionFC' : 'Recepcion')}</div>
                <div>${escapeHtml(doc.documentCount ? `${doc.documentCount} doc.` : '1 doc.')}</div>
              </td>
              <td>${formatDate(doc.fecha_emision)}</td>
              <td title="${escapeHtml(doc.mensajes_dgii || '')}"><span class="badge-${estadoMap[doc.estado_dgii] || 'gray'}" style="font-size:0.7rem">${escapeHtml(formatDocStateLabel(doc.estado_dgii))}</span></td>
              <td style="white-space:nowrap">
                ${['pendiente', 'pendiente_red', 'pendiente_rfce', 'error_auth', 'rechazado', 'error'].includes(doc.estado_dgii)
                  ? `<button class="btn-xs" onclick="resendEcfDoc(${doc.id})" title="Reenviar">↺</button>`
                  : ''}
                <button class="btn-xs" onclick="checkEcfDocStatus(${doc.id})" title="Ver estado">⟳</button>
                <button class="btn-xs" onclick="viewEcfXml(${doc.id})" title="Ver XML">XML</button>
                <button class="btn-xs" onclick="downloadEcfXml(${doc.id}, '${escapeHtml(doc.encf)}')" title="Descargar XML">⬇</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function resendEcfDoc(id) {
  try {
    const response = await fiscalApi('POST', `/documents/${id}/resend`);
    showFiscalToast(`Reenvío: ${response.estado || response.status || 'procesado'} — ${response.mensaje || ''}`, response.ok ? 'success' : 'warning');
    await loadEcfDocuments();
    await loadFiscalStatus();
  } catch (e) {
    showFiscalToast(`Error: ${e.message}`, 'error');
  }
}

async function checkEcfDocStatus(id) {
  try {
    const response = await fiscalApi('GET', `/documents/${id}/status`);
    showFiscalToast(`Estado DGII: ${response.estado || 'sin estado'} — ${response.mensaje || ''}`, 'info');
    showFiscalTechnicalResult('Consulta manual de estado DGII', response);
    await loadEcfDocuments();
    await loadFiscalStatus();
  } catch (e) {
    showFiscalToast(`Error: ${e.message}`, 'error');
  }
}

async function viewEcfXml(id) {
  try {
    const res = await fetch(`/api/ecf/documents/${id}/xml`, {
      headers: { Authorization: `Bearer ${DB?.authToken || ''}` }
    });
    if (!res.ok) throw new Error('No se pudo obtener el XML.');
    const xml = await res.text();
    if (window.novaDesktop?.openTextFile) {
      await window.novaDesktop.openTextFile(xml, 'ecf-firmado.xml');
    }
  } catch (e) {
    showFiscalToast(`Error: ${e.message}`, 'error');
  }
}

async function downloadEcfXml(id, encf) {
  try {
    const res = await fetch(`/api/ecf/documents/${id}/xml?download=1`, {
      headers: { Authorization: `Bearer ${DB?.authToken || ''}` }
    });
    if (!res.ok) throw new Error('No se pudo descargar el XML.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${encf}.xml`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch (e) {
    showFiscalToast(`Error: ${e.message}`, 'error');
  }
}

function certificationStatusBadge(state) {
  const normalized = String(state || '').trim().toLowerCase();
  const map = {
    aceptado: { label: '🟢 Aceptado', cls: 'badge-green' },
    aceptado_condicional: { label: '🟡 Aceptado Condicional', cls: 'badge-blue' },
    rechazado: { label: '🔴 Rechazado', cls: 'badge-red' },
    bloqueado: { label: 'Bloqueado', cls: 'badge-red' },
    pendiente: { label: '⏳ Pendiente', cls: 'badge-yellow' },
    firmado: { label: '⏳ Pendiente', cls: 'badge-yellow' },
    enviado: { label: '🔄 Enviado', cls: 'badge-blue' },
    procesando: { label: '🔄 Enviado', cls: 'badge-blue' },
    en_proceso: { label: '🔄 Enviado', cls: 'badge-blue' },
    error: { label: '🔴 Rechazado', cls: 'badge-red' }
  };
  return map[normalized] || { label: state || '—', cls: 'badge-gray' };
}

let _certCenterPolling = null;

function certCenterAppendLog(message, tone = 'info') {
  const log = document.getElementById('cert-center-log');
  if (!log) return;
  const colors = { info: 'var(--text3)', ok: '#16a34a', warn: '#d97706', error: '#dc2626' };
  const line = document.createElement('div');
  line.style.cssText = `padding:2px 0;color:${colors[tone] || colors.info}`;
  line.textContent = `[${new Date().toLocaleTimeString('es-DO')}] ${message}`;
  if (log.textContent.includes('Centro listo. Esperando archivos.')) log.innerHTML = '';
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function renderCertCenterDashboard(counts = {}, byType = []) {
  const box = document.getElementById('cert-center-dashboard');
  if (!box) return;

  // ── Resumen general (fila superior) ─────────────────────────────────────
  const summaryItems = [
    ['Total', counts.total || 0, '#2563eb'],
    ['Aceptados', counts.accepted || 0, '#16a34a'],
    ['Rechazados', counts.rejected || 0, '#dc2626'],
    ['Bloqueados', counts.blocked || 0, '#b91c1c'],
    ['En proceso', counts.sent || 0, '#d97706'],
    ['Avance', `${counts.progress || 0}%`, '#0f766e'],
  ];
  const summaryHtml = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:.55rem;margin-bottom:1rem">
      ${summaryItems.map(([label, value, color]) => `
        <div style="border:1px solid var(--border);border-radius:8px;background:var(--bg2);padding:.65rem">
          <div style="font-size:.68rem;color:var(--text3);font-weight:700;text-transform:uppercase">${escapeHtml(label)}</div>
          <div style="font-size:1.2rem;font-weight:900;color:${color};margin-top:.15rem">${escapeHtml(String(value))}</div>
        </div>
      `).join('')}
    </div>
  `;

  // ── Progreso por tipo (estilo portal DGII) ───────────────────────────────
  let byTypeHtml = '';
  if (byType && byType.length > 0) {
    // Separar ECF normales y RFCE
    const ecfItems = byType.filter((t) => !t.isRfce);
    const rfceItems = byType.filter((t) => t.isRfce);

    const renderTypeCard = (t) => {
      const allAccepted = t.accepted === t.total && t.total > 0;
      const hasRejected = t.rejected > 0;
      const borderColor = allAccepted ? '#16a34a' : hasRejected ? '#dc2626' : 'var(--border)';
      const countColor = allAccepted ? '#16a34a' : hasRejected ? '#dc2626' : t.sent > 0 ? '#d97706' : 'var(--text)';
      const label = t.isRfce ? `Comprobantes tipo ${t.tipo.replace('E', '')} RFCE` : `Comprobantes tipo ${t.tipo.replace('E', '')}`;
      return `
        <div style="border:1px solid ${borderColor};border-radius:8px;background:var(--bg2);padding:.6rem .85rem;display:flex;align-items:center;justify-content:space-between;gap:.5rem">
          <div style="font-size:.78rem;color:var(--text3)">${escapeHtml(label)}</div>
          <div style="font-size:1rem;font-weight:800;color:${countColor};white-space:nowrap">
            ${t.accepted}/${t.total}
            ${allAccepted ? '<span style="color:#16a34a;margin-left:.3rem">✓</span>' : ''}
            ${hasRejected ? '<span style="color:#dc2626;margin-left:.3rem">✗</span>' : ''}
          </div>
        </div>
      `;
    };

    const ecfGrid = ecfItems.length ? `
      <div style="margin-bottom:.65rem">
        <div style="font-size:.72rem;font-weight:700;color:var(--text3);text-transform:uppercase;margin-bottom:.45rem">Estado actual de las pruebas de simulación</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.45rem">
          ${ecfItems.map(renderTypeCard).join('')}
        </div>
      </div>
    ` : '';

    const rfceGrid = rfceItems.length ? `
      <div>
        <div style="font-size:.72rem;font-weight:700;color:var(--text3);text-transform:uppercase;margin-bottom:.45rem">Facturas de consumo &lt;250Mil (RFCE)</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.45rem">
          ${rfceItems.map(renderTypeCard).join('')}
        </div>
      </div>
    ` : '';

    byTypeHtml = ecfGrid + rfceGrid;
  }

  box.innerHTML = summaryHtml + (byTypeHtml
    ? `<div style="border:1px solid var(--border);border-radius:10px;background:var(--bg2);padding:.85rem">${byTypeHtml}</div>`
    : '<div class="empty-state-small">Carga el Excel DGII para ver el progreso por tipo.</div>'
  );
}

function certCenterStageIndex(stage, state) {
  const normalized = String(state || '').toLowerCase();
  if (normalized === 'bloqueado') return 6;
  if (normalized === 'rechazado' || normalized === 'error') return 6;
  if (normalized === 'aceptado' || normalized === 'aceptado_condicional') return 6;
  const stages = ['Pendiente', 'Generando XML', 'Firmando', 'Enviando', 'Consultando'];
  return Math.max(0, stages.indexOf(stage));
}

function renderCertCenterCards(cases = []) {
  const box = document.getElementById('cert-center-cards');
  if (!box) return;
  if (!cases.length) {
    box.innerHTML = '<div class="empty-state-small">Carga el Excel oficial de DGII para ver las tarjetas del lote.</div>';
    return;
  }
  const ordered = [...cases].sort((a, b) => Number(a.orden || a.order || a.id || 0) - Number(b.orden || b.order || b.id || 0));
  const stages = ['Pendiente', 'Generando XML', 'Firmando', 'Enviando', 'Consultando', 'Aceptado/Rechazado'];
  box.innerHTML = ordered.map((item) => {
    const state = String(item.estado || '').toLowerCase();
    const badge = certificationStatusBadge(item.estado);
    const activeIndex = certCenterStageIndex(item.stage, item.estado);
    const response = item.responseText || item.dgiiMessage || item.error || 'Sin respuesta DGII todavía.';
    const canRetry = Boolean(item.retryable);
    return `
      <div style="border:1px solid var(--border);border-radius:8px;background:var(--bg2);padding:.85rem;display:grid;gap:.65rem">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:.75rem;flex-wrap:wrap">
          <div>
            <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
              <span class="${badge.cls}" style="font-size:.72rem">${escapeHtml(badge.label)}</span>
              <strong>${escapeHtml(item.tipo || '—')}</strong>
              <code>${escapeHtml(item.encf || '—')}</code>
            </div>
            <div style="font-size:.76rem;color:var(--text3);margin-top:.25rem">TrackID: <code>${escapeHtml(item.trackId || '—')}</code></div>
          </div>
          <div style="display:flex;gap:.4rem;flex-wrap:wrap">
            <button class="btn-xs" onclick="viewEcfXml(${item.id})">Ver XML</button>
            <button class="btn-xs" onclick="downloadEcfXml(${item.id}, '${escapeHtml(item.encf || 'ecf')}')">Descargar XML</button>
            ${canRetry ? `<button class="btn-xs btn-secondary" onclick="retryCertificationCenterCase(${item.id})">Reintentar</button>` : ''}
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:.3rem">
          ${stages.map((stage, idx) => {
            const done = idx <= activeIndex;
            const color = state === 'bloqueado' ? '#b91c1c' : state === 'rechazado' || state === 'error' ? '#dc2626' : done ? '#16a34a' : 'var(--border)';
            return `<div title="${escapeHtml(stage)}" style="height:7px;border-radius:999px;background:${color}"></div>`;
          }).join('')}
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:.45rem;font-size:.76rem;color:var(--text3)">
          <div>Tipo e-CF: <strong style="color:var(--text)">${escapeHtml(item.tipo || '—')}</strong></div>
          <div>e-NCF: <code>${escapeHtml(item.encf || '—')}</code></div>
          <div>Modo: <strong style="color:var(--text)">${escapeHtml(item.submissionMode || 'normal')}</strong></div>
          <div>Etapa: <strong style="color:var(--text)">${escapeHtml(item.stage || 'Pendiente')}</strong></div>
        </div>
        <div style="font-size:.76rem;color:var(--text3);border-top:1px solid var(--border);padding-top:.55rem;word-break:break-word">
          Respuesta DGII: ${escapeHtml(response)}
        </div>
      </div>
    `;
  }).join('');
}

function renderCertificationCenterRfce(rfceStep4 = {}) {
  const box = document.getElementById('cert-center-rfce');
  if (!box) return;
  const items = rfceStep4.items || [];
  const accepted = items.filter((it) => ['aceptado', 'aceptado_condicional'].includes(String(it.estado || '').toLowerCase())).length;
  const sent = items.filter((it) => String(it.estado || '').toLowerCase() === 'enviado').length;
  if (!items.length && !rfceStep4.outDir) {
    box.innerHTML = `
      <div style="font-weight:800;margin-bottom:.45rem">Paso 4: RFCE &lt;250Mil</div>
      <div style="font-size:.78rem;color:var(--text3);margin-bottom:.55rem">Genera los 4 resúmenes RFCE y envíalos por el servicio RecepcionFC de CerteCF.</div>
      <div style="display:flex;gap:.45rem;flex-wrap:wrap">
        <button class="btn-secondary" onclick="generateCertificationCenterRfce()">Generar RFCE</button>
        <button class="btn-secondary" onclick="submitCertificationCenterRfce()">Enviar RecepcionFC</button>
      </div>
    `;
    return;
  }
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:.75rem;align-items:center;flex-wrap:wrap;margin-bottom:.45rem">
      <div style="font-weight:800">Paso 4: RFCE &lt;250Mil</div>
      <span class="${accepted === 4 ? 'badge-green' : 'badge-blue'}" style="font-size:.72rem">${accepted}/4 aceptados</span>
    </div>
    <code style="font-size:.72rem;word-break:break-all;color:var(--text3)">${escapeHtml(rfceStep4.outDir || 'Pendiente de generar')}</code>
    <div style="display:grid;gap:.25rem;margin-top:.55rem;font-size:.76rem">
      ${items.map((item) => `<div><code>${escapeHtml(item.fileName || item.encf || '')}</code> · ${escapeHtml(item.estado || 'generado')}${item.trackId ? ` · Track ${escapeHtml(item.trackId)}` : ''}</div>`).join('')}
    </div>
    <div style="display:flex;gap:.45rem;flex-wrap:wrap;margin-top:.65rem">
      <button class="btn-secondary" onclick="generateCertificationCenterRfce()">Generar RFCE</button>
      <button class="btn-secondary" onclick="submitCertificationCenterRfce()">Enviar RecepcionFC</button>
      <button class="btn-secondary" onclick="pollCertificationCenterRfce()">Consultar RFCE</button>
    </div>
    <div style="font-size:.72rem;color:var(--text3);margin-top:.5rem">${sent}/4 enviado(s) esperando consulta DGII.</div>
  `;
}

function renderCertificationCenterHistory(history = []) {
  const box = document.getElementById('cert-center-history');
  if (!box) return;
  if (!history.length) {
    box.innerHTML = 'Sin sesiones registradas.';
    return;
  }
  box.innerHTML = history.slice(0, 6).map((row) => `
    <div style="border-bottom:1px solid var(--border);padding:.3rem 0">
      <div style="font-weight:700;color:var(--text)">${escapeHtml(row.summary || row.key || 'Sesión DGII')}</div>
      <div>${escapeHtml(row.environment || '—')} · ${escapeHtml(row.status || '—')} · ${escapeHtml(row.createdAt || '')}</div>
    </div>
  `).join('');
}

function renderCertificationCenter(payload = {}) {
  renderCertCenterDashboard(payload.counts || {}, payload.byType || []);
  renderCertCenterCards(payload.cases || []);
  renderCertificationCenterRfce(payload.rfceStep4 || {});
  renderCertificationCenterHistory(payload.history || []);
}

async function loadCertificationCenterStatus(options = {}) {
  try {
    const payload = await fiscalApi('GET', '/certification-center/status');
    renderCertificationCenter(payload);
    if (!options.silent) certCenterAppendLog(payload.message || 'Estado actualizado.', 'info');
    return payload;
  } catch (err) {
    certCenterAppendLog(`Error consultando estado: ${err.message}`, 'error');
    if (!options.silent) showFiscalToast(`Error: ${err.message}`, 'error');
    return null;
  }
}

async function processCertificationCenter() {
  const excel = document.getElementById('cert-center-excel');
  const p12 = document.getElementById('cert-center-p12');
  const password = document.getElementById('cert-center-password');
  const env = document.getElementById('cert-center-environment');
  const btn = document.getElementById('cert-center-process');
  if (!excel?.files?.[0]) { showFiscalToast('Carga el Excel oficial DGII.', 'warning'); return; }
  if (p12?.files?.[0] && !password?.value) { showFiscalToast('Escribe la contraseña del certificado.', 'warning'); return; }

  const formData = new FormData();
  formData.append('excel', excel.files[0], excel.files[0].name);
  if (p12?.files?.[0]) {
    formData.append('certificate', p12.files[0], p12.files[0].name);
    formData.append('password', password.value);
  }
  formData.append('environment', env?.value || 'certecf');

  setBtnLoading(btn, true, 'Procesando...');
  certCenterAppendLog('Validando certificado P12...', 'info');
  certCenterAppendLog('Importando Excel oficial DGII y generando XML...', 'info');
  clearInterval(_certCenterPolling);
  _certCenterPolling = setInterval(() => loadCertificationCenterStatus({ silent: true }), 1800);
  try {
    const payload = await fiscalApi('POST', '/certification-center/process', formData, true);
    renderCertificationCenter(payload);
    const counts = payload.counts || {};
    certCenterAppendLog(`Proceso terminado: ${counts.accepted || 0}/${counts.total || 0} aceptados, ${counts.blocked || 0} bloqueados.`, counts.rejected || counts.blocked ? 'warn' : 'ok');
    showFiscalToast(payload.message || 'Certificación procesada.', counts.rejected || counts.blocked ? 'warning' : 'success');
    showFiscalTechnicalResult('Centro de Certificación DGII', payload);
  } catch (err) {
    if (err.statusCode === 409 || (err.message || '').includes('aceptados por DGII')) {
      certCenterAppendLog(`⚠ ${err.message}`, 'warn');
      const confirmed = confirm(`${err.message}\n\n¿Deseas forzar el reinicio y perder los resultados actuales?`);
      if (confirmed) {
        formData.set('forceReset', 'true');
        setBtnLoading(btn, true, 'Procesando (forzado)...');
        try {
          const payload2 = await fiscalApi('POST', '/certification-center/process', formData, true);
          renderCertificationCenter(payload2);
          certCenterAppendLog(`Proceso forzado terminado: ${(payload2.counts || {}).accepted || 0} aceptados.`, 'ok');
        } catch (err2) {
          certCenterAppendLog(`Error: ${err2.message}`, 'error');
          showFiscalToast(`Error: ${err2.message}`, 'error');
        }
      }
    } else {
      certCenterAppendLog(`Error: ${err.message}`, 'error');
      showFiscalToast(`Error procesando certificación: ${err.message}`, 'error');
      showFiscalTechnicalResult('Error Centro de Certificación DGII', { error: err.message, details: err.details || null }, true);
    }
  } finally {
    clearInterval(_certCenterPolling);
    _certCenterPolling = null;
    setBtnLoading(btn, false, 'Procesar paso 4');
    await loadCertificationCenterStatus({ silent: true });
  }
}

async function retryCertificationCenterCase(id) {
  try {
    certCenterAppendLog(`Reintentando caso #${id}...`, 'info');
    const payload = await fiscalApi('POST', `/certification-center/cases/${id}/retry`, {});
    renderCertificationCenter(payload);
    showFiscalToast('Reintento procesado.', 'success');
  } catch (err) {
    certCenterAppendLog(`Reintento bloqueado/error: ${err.message}`, 'error');
    showFiscalToast(`No se pudo reintentar: ${err.message}`, 'error');
  }
}

async function generateCertificationCenterRfce() {
  try {
    const payload = await fiscalApi('POST', '/certification-center/rfce/generate', {});
    if (payload.ok) {
      certCenterAppendLog(payload.message || 'RFCE generados.', 'ok');
      showFiscalToast(payload.message || 'RFCE generados.', 'success');
    } else {
      certCenterAppendLog(payload.error || 'No se pudieron generar los RFCE.', 'warn');
      showFiscalToast(payload.error || 'No se pudieron generar los RFCE.', 'warning');
    }
    await loadCertificationCenterStatus({ silent: true });
  } catch (err) {
    certCenterAppendLog(`Error generando RFCE: ${err.message}`, 'error');
    showFiscalToast(`Error: ${err.message}`, 'error');
  }
}

async function submitCertificationCenterRfce() {
  try {
    certCenterAppendLog('Enviando RFCE por RecepcionFC...', 'info');
    const payload = await fiscalApi('POST', '/certification-center/rfce/submit', {});
    renderCertificationCenter({ ...(await loadCertificationCenterStatus({ silent: true }) || {}), rfceStep4: { items: payload.items || [] } });
    certCenterAppendLog(`RFCE enviados: ${(payload.results || []).filter((r) => r.ok).length}/${(payload.results || []).length}.`, payload.ok ? 'ok' : 'warn');
    showFiscalToast('Envío RFCE completado. Consulta estados en unos segundos.', payload.ok ? 'success' : 'warning');
  } catch (err) {
    certCenterAppendLog(`Error enviando RFCE: ${err.message}`, 'error');
    showFiscalToast(`Error RFCE: ${err.message}`, 'error');
  } finally {
    await loadCertificationCenterStatus({ silent: true });
  }
}

async function pollCertificationCenterRfce() {
  try {
    const payload = await fiscalApi('POST', '/certification-center/rfce/poll', {});
    const accepted = payload.aceptados || 0;
    certCenterAppendLog(`RFCE actualizados: ${accepted}/4 aceptados.`, accepted === 4 ? 'ok' : 'info');
    showFiscalToast(`RFCE: ${accepted}/4 aceptados.`, accepted === 4 ? 'success' : 'info');
  } catch (err) {
    certCenterAppendLog(`Error consultando RFCE: ${err.message}`, 'error');
    showFiscalToast(`Error consulta RFCE: ${err.message}`, 'error');
  } finally {
    await loadCertificationCenterStatus({ silent: true });
  }
}

async function resetCertificationCenter() {
  const ok = await showDeleteConfirm(
    '¿Reiniciar por completo el Centro de Certificación? Se borrarán los casos locales, estados y archivos temporales RFCE del paso 4.',
    { confirmText: 'Reiniciar limpio' }
  );
  if (!ok) return;
  const btn = document.getElementById('cert-center-reset');
  setBtnLoading(btn, true, 'Reiniciando...');
  try {
    const payload = await fiscalApi('POST', '/certification-center/reset', {});
    certCenterAppendLog(payload.message || 'Centro reiniciado.', 'ok');
    showFiscalToast(payload.message || 'Centro reiniciado.', 'success');
    renderCertificationCenter({ counts: {}, cases: [], rfceStep4: {} });
  } catch (err) {
    certCenterAppendLog(`Error reiniciando: ${err.message}`, 'error');
    showFiscalToast(`Error: ${err.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, 'Reinicio limpio');
  }
}

async function processAcecf() {
  const btn = document.getElementById('acecf-process-btn');
  const resultDiv = document.getElementById('acecf-result');
  const excelInput = document.getElementById('acecf-excel');
  const envSelect = document.getElementById('acecf-environment');

  if (!excelInput?.files?.[0]) {
    showFiscalToast('Carga el Excel de Aprobaciones Comerciales descargado del portal DGII.', 'warning');
    return;
  }

  setBtnLoading(btn, true, 'Enviando…');
  resultDiv.innerHTML = '<span style="color:var(--text3)">Procesando…</span>';

  const formData = new FormData();
  formData.append('excel', excelInput.files[0]);
  formData.append('environment', envSelect?.value || 'certecf');

  try {
    const payload = await fiscalApi('POST', '/certification/aprobacion-comercial/process', formData, true);
    const results = payload.results || [];
    const accepted = payload.accepted || 0;
    const total = payload.total || results.length;

    const color = accepted === total && total > 0 ? '#4ade80' : accepted > 0 ? '#facc15' : '#f87171';
    let html = `<div style="font-weight:700;color:${color};margin-bottom:.5rem">${accepted}/${total} aceptadas — ${escapeHtml(payload.message || '')}</div>`;
    html += '<div style="display:grid;gap:.3rem">';
    for (const r of results) {
      const rowColor = r.ok ? '#4ade80' : '#f87171';
      html += `<div style="border-left:3px solid ${rowColor};padding-left:.5rem;font-size:.76rem">`;
      html += `<strong>${escapeHtml(r.encf || 'N/A')}</strong> `;
      if (r.trackId) html += `TrackId: ${escapeHtml(r.trackId)} `;
      if (r.estado) html += `Estado: ${escapeHtml(String(r.estado))} `;
      if (r.mensaje) html += `· ${escapeHtml(r.mensaje)} `;
      if (r.error) html += `<span style="color:#f87171">Error: ${escapeHtml(r.error)}</span>`;
      if (r.http) html += `<span style="color:var(--text3)">[HTTP ${r.http}]</span>`;
      html += '</div>';
    }
    html += '</div>';
    resultDiv.innerHTML = html;

    if (accepted === total && total > 0) {
      showFiscalToast(`${accepted}/${total} Aprobaciones Comerciales enviadas y aceptadas.`, 'success');
    } else {
      showFiscalToast(`${accepted}/${total} aceptadas. Revisa los errores.`, 'warning');
    }
  } catch (err) {
    resultDiv.innerHTML = `<span style="color:#f87171">Error: ${escapeHtml(err.message)}</span>`;
    showFiscalToast(`Error: ${err.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, 'Enviar Aprobaciones Comerciales');
  }
}

/**
 * Muestra un aviso prominente que recuerda generar RFCE frescos antes de enviar por RecepcionFC.
 * Se llama después de cada run-sequential exitoso.
 */
function showCertification250MilReminder() {
  // Quitar aviso anterior si existe
  const prev = document.getElementById('cert-250mil-reminder');
  if (prev) prev.remove();

  const box = document.getElementById('certification-cases-table') || document.querySelector('.certification-section');
  if (!box) return;

  const div = document.createElement('div');
  div.id = 'cert-250mil-reminder';
  div.style.cssText = `
    background: #7c3aed; color: #fff; border-radius: 8px; padding: 14px 18px;
    margin: 12px 0; font-size: 14px; line-height: 1.6; position: relative;
  `;
  div.innerHTML = `
    <button onclick="document.getElementById('cert-250mil-reminder').remove()" style="
      position:absolute;top:8px;right:12px;background:none;border:none;color:#fff;
      font-size:18px;cursor:pointer;line-height:1;" title="Cerrar">✕</button>
    <strong>Paso final para consumo &lt;250Mil</strong><br>
    Genera y envía los 4 resúmenes RFCE por RecepcionFC; no subas e-CF completos a ese servicio.<br>
    <strong>Este bloque pertenece al paso 4 de simulación.</strong><br>
    <button onclick="generateCertificationCenterRfce()" style="margin-top:8px;background:#6d28d9;color:#fff;border:none;border-radius:6px;padding:8px 16px;cursor:pointer;font-size:13px;">
      Generar RFCE paso 4
    </button>
  `;
  box.parentNode.insertBefore(div, box);
}

function primeCertificationCasesPanel() {
  const box = document.getElementById('certification-cases-table');
  if (!box || box.dataset.loaded === '1') return;
  box.innerHTML = '<div class="empty-state-small">Tabla en pausa para abrir más rápido. Usa “Ver casos” si necesitas revisar el detalle.</div>';
}

async function loadCertificationCases(options = {}) {
  const box = document.getElementById('certification-cases-table');
  if (!box) return;
  if (!options.silent) box.innerHTML = '<div class="loading-text">Cargando pruebas de certificación…</div>';
  try {
    const payload = await fiscalApi('GET', '/certification/cases?compact=1');
    box.dataset.loaded = '1';
    renderCertificationSummary(payload.summary || null);
    renderCertificationCasesTable(box, payload.cases || []);
  } catch (err) {
    box.innerHTML = `<div class="error-text">Error: ${escapeHtml(err.message)}</div>`;
  }
}

function renderCertificationCasesTable(container, cases) {
  if (!Array.isArray(cases) || !cases.length) {
    container.innerHTML = '<div class="empty-state-small">Todavía no hay pruebas de certificación importadas.</div>';
    return;
  }

  const ordered = [...cases].sort((a, b) => Number(a.orden || a.order || a.id || 0) - Number(b.orden || b.order || b.id || 0));
  container.innerHTML = `
    <div style="overflow-x:auto">
      <table class="compact-table" style="width:100%;font-size:.8rem">
        <thead>
          <tr>
            <th>Estado</th>
            <th>Tipo</th>
            <th>e-NCF</th>
            <th>Total</th>
            <th>TrackID</th>
            <th>Mensaje DGII</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          ${ordered.map((testCase) => {
            const badge = certificationStatusBadge(testCase.estado);
            const total = Number(testCase.total || 0).toLocaleString('es-DO', { style: 'currency', currency: 'DOP' });
            const dgiiMsg = Array.isArray(testCase.mensajes)
              ? testCase.mensajes.map((item) => `[${item.codigo}] ${item.valor}`).join(' | ')
              : (testCase.dgiiMessage || '');
            const canSend = ['pendiente', 'firmado', 'error', 'error_firma', 'error_xml', 'error_auth', 'error_validacion'].includes(testCase.estado);
            const canResend = ['enviado', 'procesando', 'rechazado', 'pendiente_red', 'aceptado_condicional'].includes(testCase.estado);
            return `
              <tr title="${escapeHtml(dgiiMsg)}">
                <td><span class="${badge.cls}" style="font-size:.72rem">${escapeHtml(badge.label)}</span></td>
                <td>${escapeHtml(testCase.tipo || '—')}</td>
                <td><code>${escapeHtml(testCase.encf || '—')}</code></td>
                <td style="text-align:right">${total}</td>
                <td><code>${escapeHtml(testCase.trackId || '—')}</code></td>
                <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text3)">${escapeHtml(dgiiMsg || testCase.error || '—')}</td>
                <td style="white-space:nowrap">
                  ${canSend ? `<button class="btn-xs" onclick="sendCertificationDoc(${testCase.id})" title="Enviar a DGII">Enviar</button>` : ''}
                  ${canResend ? `<button class="btn-xs" onclick="sendCertificationDoc(${testCase.id}, true)" title="Reenviar">↺</button>` : ''}
                  <button class="btn-xs" onclick="queryCertificationDoc(${testCase.id})" title="Consultar estado DGII">⟳</button>
                  <button class="btn-xs btn-secondary" onclick="openXmlEditor(${testCase.id},'${escapeHtml(testCase.encf||'')}')" title="Editar XML manualmente">✏️ XML</button>
                  <button class="btn-xs btn-danger" onclick="deleteCertificationCase(${testCase.id},'${escapeHtml(testCase.encf||'')}')" title="Eliminar este caso">🗑</button>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function regenerateCertificationDoc(id) {
  try {
    const response = await fiscalApi('POST', `/certification/cases/${id}/regenerate`, {});
    showFiscalToast(response.message || 'XML de prueba regenerado.', response.ok ? 'success' : 'warning');
    showFiscalTechnicalResult('Regenerar XML de prueba', response);
    await loadCertificationCases();
  } catch (err) {
    showFiscalToast(`Error regenerando XML: ${err.message}`, 'error');
  }
}

async function deleteCertificationCase(id, encf) {
  const label = encf ? ` (${encf})` : ` #${id}`;
  if (!confirm(`¿Eliminar caso de certificación${label}?\n\nEste caso se borrará de la base de datos local. Podrás reimportarlo junto al set DGII si es necesario.`)) return;
  try {
    const response = await fiscalApi('DELETE', `/certification/cases/${id}`, {});
    showFiscalToast(response.message || 'Caso eliminado.', response.ok ? 'success' : 'warning');
    if (response.ok) await loadCertificationCases();
  } catch (err) {
    showFiscalToast(`Error eliminando caso: ${err.message}`, 'error');
  }
}

async function openXmlEditor(id, encf) {
  const existing = document.getElementById('xml-editor-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'xml-editor-modal';
  modal.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;
    display:flex;align-items:center;justify-content:center;padding:16px
  `;
  modal.innerHTML = `
    <div style="background:#1e293b;border-radius:10px;width:100%;max-width:860px;
      max-height:90vh;display:flex;flex-direction:column;border:1px solid #334155">
      <div style="padding:14px 18px;border-bottom:1px solid #334155;display:flex;
        justify-content:space-between;align-items:center">
        <strong style="color:#e2e8f0;font-size:14px">✏️ Editar XML — <code style="color:#60a5fa">${escapeHtml(encf)}</code></strong>
        <button id="xml-editor-close" style="background:none;border:none;color:#94a3b8;
          cursor:pointer;font-size:18px;line-height:1">✕</button>
      </div>
      <div id="xml-editor-body" style="padding:14px 18px;flex:1;overflow:auto;display:flex;flex-direction:column;gap:10px">
        <div style="color:#94a3b8;font-size:12px">⏳ Cargando XML…</div>
      </div>
      <div id="xml-editor-footer" style="padding:12px 18px;border-top:1px solid #334155;
        display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button id="xml-editor-save" class="btn-primary" disabled style="min-width:160px">
          💾 Guardar y Firmar
        </button>
        <button id="xml-editor-cancel" class="btn-secondary">Cancelar</button>
        <span id="xml-editor-status" style="color:#94a3b8;font-size:12px;margin-left:auto"></span>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector('#xml-editor-close').onclick = close;
  modal.querySelector('#xml-editor-cancel').onclick = close;
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  const body = modal.querySelector('#xml-editor-body');
  const saveBtn = modal.querySelector('#xml-editor-save');
  const status = modal.querySelector('#xml-editor-status');

  try {
    const data = await fiscalApi('GET', `/certification/cases/${id}/full-xml`);
    const xmlContent = data.xml || '';

    body.innerHTML = `
      <div style="font-size:11px;color:#64748b;margin-bottom:4px">
        Puedes editar el XML directamente. Al guardar se re-firma con el certificado almacenado.
        <strong style="color:#f59e0b">No modifiques la firma (SignatureValue) — se reemplaza automáticamente.</strong>
      </div>
      <textarea id="xml-editor-textarea" spellcheck="false" style="
        flex:1;width:100%;min-height:400px;background:#0f172a;color:#e2e8f0;
        border:1px solid #334155;border-radius:6px;padding:12px;
        font-family:monospace;font-size:11.5px;line-height:1.55;resize:vertical;
        outline:none;tab-size:2">${escapeHtml(xmlContent)}</textarea>
    `;
    saveBtn.disabled = false;

    saveBtn.onclick = async () => {
      const textarea = document.getElementById('xml-editor-textarea');
      const xmlToSave = textarea?.value?.trim() || '';
      if (!xmlToSave) { status.textContent = '❌ El XML no puede estar vacío.'; status.style.color = '#f87171'; return; }
      saveBtn.disabled = true;
      saveBtn.textContent = '⏳ Firmando…';
      status.textContent = '';
      try {
        const result = await fiscalApi('POST', `/certification/cases/${id}/edit-xml`, { xml: xmlToSave });
        status.textContent = result.message || 'Guardado y firmado.';
        status.style.color = '#4ade80';
        saveBtn.textContent = '✅ Guardado';
        showFiscalToast(result.message || 'XML guardado y firmado.', 'success');
        await loadCertificationCases({ silent: true });
        setTimeout(close, 1200);
      } catch (err) {
        status.textContent = `❌ ${err.message}`;
        status.style.color = '#f87171';
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Guardar y Firmar';
      }
    };
  } catch (err) {
    body.innerHTML = `<div style="color:#f87171">Error cargando XML: ${escapeHtml(err.message)}</div>`;
  }
}

async function importCertificationSet(options = {}) {
  const fileInput = document.getElementById('certification-testset-files');
  const folderInput = document.getElementById('certification-testset-folder');
  const files = [
    ...(fileInput?.files ? Array.from(fileInput.files) : []),
    ...(folderInput?.files ? Array.from(folderInput.files) : []),
  ];
  if (!files.length) {
    showFiscalToast('Selecciona archivos o una carpeta del set DGII.', 'error');
    return;
  }

  const btn = document.getElementById('certification-btn-import');
  const resultBox = document.getElementById('certification-import-result');
  btn.disabled = true;
  btn.textContent = 'Importando rápido…';
  resultBox.style.display = 'none';
  const startedAt = performance.now();

  try {
    const formData = new FormData();
    for (const file of files) {
      formData.append('files', file, file.webkitRelativePath || file.name);
    }
    const envEl = document.getElementById('fiscal-environment-select') || document.getElementById('fiscal-dgii-environment');
    formData.append('ambiente', envEl?.value || 'testecf');
    formData.append('fastImport', '1');

    const result = await fiscalApi('POST', '/certification/import', formData, true);
    const okRows = (result.results || []).filter((row) => row.ok);
    const errRows = (result.results || []).filter((row) => !row.ok);
    const durationSeconds = Math.max(0.1, ((result.durationMs || (performance.now() - startedAt)) / 1000)).toFixed(1);
    resultBox.style.display = 'block';
    resultBox.innerHTML = `
      <div style="font-weight:700;margin-bottom:.5rem;color:${errRows.length ? '#9b2c2c' : '#276749'}">
        ${result.ok} de ${result.total} pruebas listas en ${durationSeconds}s
        ${errRows.length ? ` &mdash; ${errRows.length} error(es)` : ''}
      </div>
      <div style="font-size:.78rem;color:var(--text3);margin-bottom:.5rem">
        Modo rápido activo: se guardan los datos del set y la firma se genera justo al enviar a DGII.
      </div>
      <details style="display:${errRows.length ? 'block' : 'none'}">
        <summary style="cursor:pointer;font-weight:700">Ver detalle de importación</summary>
        <div style="display:grid;gap:.3rem;max-height:220px;overflow-y:auto;margin-top:.45rem">
          ${(result.results || []).map((row) => `
          <div style="display:flex;gap:.45rem;align-items:baseline;font-size:.78rem">
            <span style="font-weight:700;color:${row.ok ? '#276749' : '#c53030'}">${row.ok ? '✓' : '✗'}</span>
            <code style="min-width:140px">${escapeHtml(row.encf || row.casoPrueba || '—')}</code>
            <span>${row.ok
              ? `${escapeHtml(row.tipoEcf || '—')} · ${escapeHtml(row.submissionMode || 'normal')} · ${Number(row.montoTotal || 0).toLocaleString('es-DO', { style: 'currency', currency: 'DOP' })}`
              : `<span style="color:#c53030">${escapeHtml(row.error || 'Error')}</span>`}</span>
          </div>
          `).join('')}
        </div>
      </details>
      ${result.certificateWarning ? `<div style="margin-top:.7rem;color:#9c4221">${escapeHtml(result.certificateWarning)}</div>` : ''}
    `;
    if (result.summary) renderCertificationSummary(result.summary);
    showFiscalToast(result.message || `${result.ok} pruebas importadas.`, errRows.length ? 'warning' : 'success');
    if (!options.skipTableRefresh) {
      loadCertificationCases({ silent: true }).catch(() => {});
    }
    return result;
  } catch (err) {
    resultBox.style.display = 'block';
    resultBox.innerHTML = `<span style="color:#9b2c2c">Error: ${escapeHtml(err.message)}</span>`;
    showFiscalToast(`Error al importar certificación: ${err.message}`, 'error');
    return null;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Solo importar';
  }
}

async function sendCertificationDoc(id, isResend = false) {
  try {
    const endpoint = isResend ? `/certification/cases/${id}/resend` : `/certification/cases/${id}/send`;
    const response = await fiscalApi('POST', endpoint, {});
    showFiscalToast(response.message || 'Prueba enviada a DGII.', response.ok ? 'success' : 'warning');
    showFiscalTechnicalResult(isResend ? 'Reenvío prueba certificación DGII' : 'Envío prueba certificación DGII', response);
    await loadCertificationCases();
    await loadFiscalStatus();
  } catch (err) {
    showFiscalToast(`Error al enviar prueba: ${err.message}`, 'error');
  }
}

async function queryCertificationDoc(id) {
  try {
    const response = await fiscalApi('GET', `/certification/cases/${id}/track`);
    showFiscalToast(`DGII: ${response.estado || 'sin estado'} — ${response.mensaje || 'Consulta completada.'}`, 'info');
    showFiscalTechnicalResult('Consulta TrackID', response);
    await loadCertificationCases();
    await loadFiscalStatus();
  } catch (err) {
    showFiscalToast(`Error consultando DGII: ${err.message}`, 'error');
  }
}

async function sendNextCertificationCase() {
  const btn = document.getElementById('certification-btn-send-next');
  setBtnLoading(btn, true, 'Enviando…');
  try {
    const response = await fiscalApi('POST', '/certification/send-next', {});
    showFiscalToast(response.message || 'Se envió la siguiente prueba pendiente.', response.ok ? 'success' : 'warning');
    showFiscalTechnicalResult('Enviar siguiente prueba DGII', response);
    await loadCertificationCases();
    await loadFiscalStatus();
  } catch (err) {
    showFiscalToast(`Error al enviar siguiente prueba: ${err.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, 'Enviar siguiente');
  }
}

async function runCertificationSequence() {
  await _runCertificationSequenceConfirmed();
}

async function _runCertificationSequenceConfirmed() {
  const btns = document.querySelectorAll('.certification-run-btn, [onclick="runCertificationSequence()"]');
  btns.forEach((b) => { b.disabled = true; b.textContent = 'Enviando…'; });
  startCertLivePolling();
  try {
    showFiscalToast('Enviando todos los casos pendientes a DGII…', 'info');
    // Paso 1: ráfaga de envíos (rápida, sin esperar respuesta de cada TrackID)
    const response = await fiscalApi('POST', '/certification/run-sequential', { limit: 50, delayMs: 80 });
    const sent = response.totalProcessed || 0;

    // Si el servidor detuvo la ráfaga por un rechazo, mostrar aviso prominente
    if (response.stoppedByRejection) {
      const lastResult = (response.results || []).slice().reverse().find((r) => !r?.ok);
      const rejectedEncf = lastResult?.case?.encf || lastResult?.encf || '—';
      showFiscalToast(
        `⛔ Ráfaga detenida: la prueba ${rejectedEncf} fue rechazada por DGII. ` +
        'Corrige ese caso y reenvíalo individualmente antes de continuar.',
        'error'
      );
    } else if (response.stoppedByTransient) {
      const lastResult = (response.results || []).slice().reverse().find((r) => !r?.ok);
      const transientEncf = lastResult?.case?.encf || lastResult?.encf || '—';
      showFiscalToast(
        `DGII no respondió correctamente para ${transientEncf}. No es rechazo del XML; espera unos segundos y presiona “Enviar pendientes”.`,
        'warning'
      );
    } else {
      showFiscalToast(`${sent} caso(s) enviado(s). Consultando estados…`, 'info');
    }

    showFiscalTechnicalResult('Envíos secuenciales DGII', response);
    await loadCertificationCases();

    // Paso 2: esperar y consultar TrackIDs para actualizar estados
    await new Promise((r) => setTimeout(r, 2000));
    const pollResponse = await fiscalApi('POST', '/certification/poll-statuses').catch(() => null);
    if (pollResponse?.polled > 0) {
      const aceptados = (pollResponse.results || []).filter((r) => r.estado === 'aceptado').length;
      const rechazados = (pollResponse.results || []).filter((r) => r.estado === 'rechazado').length;
      showFiscalToast(
        `Estados: ${aceptados} ✅ aceptado(s)${rechazados ? ` / ${rechazados} ❌ rechazado(s)` : ''}.`,
        rechazados > 0 ? 'warning' : 'success'
      );
    } else if (!response.stoppedByRejection) {
      showFiscalToast(`${sent} caso(s) enviados a DGII. En proceso…`, 'info');
    }
    await loadCertificationCases();
    await loadFiscalStatus();

    // Aviso prominente para < 250Mil: NUNCA subir XMLs viejos (solo si se enviaron pruebas)
    if (sent > 0 && !response.stoppedByRejection) {
      showCertification250MilReminder();
    }
  } catch (err) {
    showFiscalToast(`Error: ${err.message}`, 'error');
  } finally {
    btns.forEach((b) => { b.disabled = false; b.textContent = 'Enviar pendientes'; });
  }
}

async function runFastCertificationFlow() {
  const btn = document.getElementById('certification-btn-fast-flow');
  if (btn) { btn.disabled = true; btn.textContent = 'Procesando…'; }
  try {
    const imported = await importCertificationSet({ skipTableRefresh: true });
    if (!imported || Number(imported.ok || 0) <= 0) return;
    await _runCertificationSequenceConfirmed();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Importar y enviar ahora'; }
  }
}

let _certLivePolling = null;

function startCertLivePolling() {
  const log = document.getElementById('cert-live-log');
  const badge = document.getElementById('cert-live-badge');
  if (log) { log.style.display = 'block'; log.innerHTML = ''; }
  if (badge) badge.style.display = 'inline-block';

  // Rastrear el último estado conocido por e-NCF para detectar cambios
  const knownState = {}; // encf → estado
  const lineEls = {};    // encf → elemento DOM de la línea del log

  const IN_PROGRESS = new Set(['pendiente', 'firmado', 'enviado', 'procesando', 'en_proceso']);

  const tick = async () => {
    try {
      const payload = await fiscalApi('GET', '/certification/cases?compact=1');
      const cases = payload.cases || [];

      if (log) {
        cases.forEach(c => {
          const encf = c.encf || '—';
          const prev = knownState[encf];
          const cur = c.estado;
          if (prev === cur) return; // sin cambio
          knownState[encf] = cur;

          if (cur === 'enviado' || cur === 'procesando' || cur === 'en_proceso') {
            // Mostrar spinner inmediatamente cuando el documento se envía
            if (!lineEls[encf]) {
              const el = document.createElement('div');
              el.style.cssText = 'padding:3px 0;border-bottom:1px solid rgba(255,255,255,.08)';
              log.appendChild(el);
              lineEls[encf] = el;
            }
            lineEls[encf].innerHTML = `<span style="color:#94a3b8">🔄 <b style="color:#e2e8f0">${escapeHtml(encf)}</b> (${escapeHtml(c.tipo || '')}) — Esperando respuesta DGII…</span>`;
            log.scrollTop = log.scrollHeight;
          } else if (cur === 'aceptado' || cur === 'rechazado') {
            const color = cur === 'aceptado' ? '#10b981' : '#ef4444';
            const icon = cur === 'aceptado' ? '✅' : '❌';
            const msg = c.mensajes?.[0]?.valor || c.dgiiMessage || '';
            const msgHtml = msg ? ` <span style="color:#94a3b8;font-size:12px">— ${escapeHtml(msg)}</span>` : '';
            if (!lineEls[encf]) {
              const el = document.createElement('div');
              el.style.cssText = 'padding:3px 0;border-bottom:1px solid rgba(255,255,255,.08)';
              log.appendChild(el);
              lineEls[encf] = el;
            }
            lineEls[encf].innerHTML = `<span style="color:${color}">${icon} <b>${escapeHtml(encf)}</b> (${escapeHtml(c.tipo || '')})</span>${msgHtml}`;
            log.scrollTop = log.scrollHeight;
          }
        });
      }

      renderCertificationCasesTable(document.getElementById('certification-cases-table'), cases);
      if (payload.summary) renderCertificationSummary(payload.summary);

      // Detener cuando no quede ningún caso en proceso
      const inProgress = cases.filter(c => IN_PROGRESS.has(c.estado)).length;
      if (inProgress === 0) { stopCertLivePolling(); }
    } catch (_) {}
  };
  _certLivePolling = setInterval(tick, 1500);
}

function stopCertLivePolling() {
  if (_certLivePolling) { clearInterval(_certLivePolling); _certLivePolling = null; }
  const badge = document.getElementById('cert-live-badge');
  if (badge) badge.style.display = 'none';
}

async function resetSentCertificationCases() {
  const ok = await showDeleteConfirm(
    '¿Reiniciar el estado local de certificación? Se conservan los eNCF del dataset DGII pero los XMLs firmados se descartan y los documentos vuelven a estado "firmado". Usar cuando el portal DGII ha reiniciado las pruebas.',
    { confirmText: 'Reiniciar estado' }
  );
  if (!ok) return;

  const btn = document.querySelector('[onclick="resetSentCertificationCases()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Reiniciando…'; }

  try {
    const response = await fiscalApi('POST', '/certification/reset-sent', {});
    const reset = response.reset ?? 0;
    showFiscalToast(
      `✓ ${reset} caso(s) reiniciados sin cambiar eNCF. Ahora ejecuta ▶ Ejecutar pruebas secuenciales.`,
      'success'
    );
    await loadCertificationCases();
  } catch (err) {
    showFiscalToast(`Error al rotar eNCFs: ${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↩ Reset enviados'; }
  }
}

async function generate250MilXmls() {
  const btn = document.getElementById('btn-gen-250mil');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generando…'; }

  // Quitar aviso anterior
  const prev = document.getElementById('cert-250mil-reminder');
  if (prev) prev.remove();

  try {
    showFiscalToast('Generando y firmando resúmenes RFCE < 250Mil…', 'info');
    const response = await fiscalApi('POST', '/certification/generate-250mil');

    if (!response.ok) {
      showFiscalToast(`Error: ${response.error || 'Error desconocido'}`, 'error');
      return;
    }

    // Mostrar resultado con la lista de archivos generados
    const files = (response.generated || []);
    const portalFiles = (response.portalFiles || []);
    const portalDir = response.portalDir || '';

    const rfceList = files.map(f =>
      `<li><strong>${escapeHtml(f.encf)}.xml</strong> — RFCE — ${f.sizekb}KB — MontoTotal: ${escapeHtml(String(f.montoTotal || '?'))}</li>`
    ).join('');

    const portalList = portalFiles.map(f =>
      `<li><strong>${escapeHtml(f.dgiiFileName)}</strong> — E32 completo para portal DGII</li>`
    ).join('');

    const box = document.getElementById('certification-cases-table') || document.querySelector('.certification-section');
    if (box) {
      const div = document.createElement('div');
      div.id = 'cert-250mil-reminder';
      div.style.cssText = `
        background: #065f46; color: #fff; border-radius: 8px; padding: 14px 18px;
        margin: 12px 0; font-size: 14px; line-height: 1.8; position: relative;
      `;
      div.innerHTML = `
        <button onclick="document.getElementById('cert-250mil-reminder').remove()" style="
          position:absolute;top:8px;right:12px;background:none;border:none;color:#fff;
          font-size:18px;cursor:pointer;line-height:1;" title="Cerrar">✕</button>
        <strong>✅ ${files.length} archivos generados y firmados</strong><br><br>
        <strong>📤 RFCE para RecepcionFC (API — ya enviados/aceptados):</strong><br>
        <small>Carpeta: ${escapeHtml(response.outDir || 'scripts/250mil-upload/')}</small>
        <ul style="margin:4px 0 8px 16px;padding:0;">${rfceList}</ul>
        ${portalDir ? `
        <strong>🌐 E32 completos para portal DGII "Facturas de consumo &lt;250Mil":</strong><br>
        <small style="word-break:break-all">Carpeta: <strong>${escapeHtml(portalDir)}</strong></small><br>
        <small>Sube estos ${portalFiles.length} archivos uno a uno en el portal CerteCF → "Facturas de consumo &lt;250Mil"</small>
        <ul style="margin:4px 0 4px 16px;padding:0;">${portalList}</ul>
        ` : `<small>E32 locales en: ${escapeHtml(response.localEcfDir || '')}</small><br>`}
      `;
      box.parentNode.insertBefore(div, box);
    }

    showFiscalToast(`✓ ${files.length} RFCE + ${portalFiles.length} E32 portal listos.`, 'success');
  } catch (err) {
    showFiscalToast(`Error generando XMLs: ${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📋 Generar RFCE <250Mil'; }
  }
}

function _showDisabled250MilPortalFlow() {
  const message = 'Ese flujo fue eliminado. Para las facturas <250Mil usa solo RFCE automático: Generar RFCE, Enviar RFCE y Consultar.';
  if (typeof showFiscalToast === 'function') showFiscalToast(message, 'warning');
  return { ok: false, disabled: true, message };
}

function render250MilPortalPackageResult() {
  const box = document.getElementById('certification-final-250mil-result');
  if (!box) return;
  box.style.display = 'none';
  box.innerHTML = '';
}

async function prepare250MilPortalPackage() {
  return _showDisabled250MilPortalFlow();
}

async function open250MilPortalFolder() {
  return _showDisabled250MilPortalFlow();
}

function render250MilPortalCards() {}

async function open250MilXmlEditor() {
  return _showDisabled250MilPortalFlow();
}

async function load250MilPortalStatus() {}

async function portal250MilGenerate() {
  return _showDisabled250MilPortalFlow();
}

async function portal250MilSubmit() {
  return _showDisabled250MilPortalFlow();
}

async function portal250MilPoll() {
  return _showDisabled250MilPortalFlow();
}

async function pollCertificationStatuses() {
  try {
    showFiscalToast('Consultando estados en DGII…', 'info');
    const response = await fiscalApi('POST', '/certification/poll-statuses');
    const aceptados = (response.results || []).filter((r) => r.estado === 'aceptado').length;
    const rechazados = (response.results || []).filter((r) => r.estado === 'rechazado').length;
    showFiscalToast(
      `${response.polled || 0} consultado(s): ${aceptados} ✅${rechazados ? ` / ${rechazados} ❌` : ''}`,
      rechazados > 0 ? 'warning' : 'success'
    );
    showFiscalTechnicalResult('Consulta de estados DGII', response);
    await loadCertificationCases();
    await loadFiscalStatus();
  } catch (err) {
    showFiscalToast(`Error consultando estados: ${err.message}`, 'error');
  }
}

async function importDgiiTestSet() {
  return importCertificationSet();
}

async function retryAllPending() {
  const btn = document.getElementById('fiscal-btn-retry-all');
  setBtnLoading(btn, true, 'Reintentando…');
  try {
    const response = await fiscalApi('POST', '/documents/retry-pending');
    showFiscalToast(`Se intentaron ${response.results?.length || 0} documento(s) pendiente(s).`, 'success');
    await loadEcfDocuments();
    await loadFiscalStatus();
  } catch (e) {
    showFiscalToast(`Error: ${e.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, '↺ Reintentar pendientes');
  }
}

function switchFiscalTab(tab) {
  document.querySelectorAll('.fiscal-tab-btn').forEach((btn) => {
    btn.classList.remove('active');
    btn.style.borderBottomColor = 'transparent';
    btn.style.color = '';
    btn.style.opacity = '';
  });
  document.querySelectorAll('.fiscal-tab-content').forEach((content) => {
    content.classList.remove('active');
    content.style.display = 'none';
  });

  const btn = document.querySelector(`.fiscal-tab-btn[data-tab="${tab}"]`);
  const content = document.getElementById(`fiscal-tab-${tab}`);
  if (btn) {
    btn.classList.add('active');
    btn.style.borderBottomColor = 'var(--accent)';
    btn.style.color = 'var(--accent)';
    btn.style.opacity = '1';
  }
  if (content) {
    content.classList.add('active');
    content.style.display = 'block';
  }

  if (tab === 'sequences') {
    initEcfSequenceForm().then(loadFiscalSequences).catch(() => {});
  }
  if (tab === 'documents') {
    loadEcfDocuments();
  }
  if (tab === 'connection' && FISCAL_UI_STATE.bundle) {
    renderConnectionPanel(FISCAL_UI_STATE.bundle, FISCAL_UI_STATE.status);
  }
  if (tab === 'homologation') {
    if (typeof ECF_CERT_WIZARD !== 'undefined') {
      ECF_CERT_WIZARD.init();
    }
  }
  if (tab === 'contador') {
    loadContadorSection();
  }
  if (tab === 'centro-fiscal') {
    renderCentroFiscal();
  }
}

function getCurrentFiscalTab() {
  return document.querySelector('.fiscal-tab-btn.active')?.dataset?.tab || 'status';
}

const STATUS_LABELS = {
  no_configurado: 'No configurado',
  certificado_cargado: 'Certificado cargado',
  certificado_valido: 'Certificado válido',
  conectado: 'Conectado a DGII',
  listo: 'Listo para facturar',
  inactivo: 'Inactivo',
  pendiente: 'Pendiente',
  error: 'Error'
};

const ENV_LABELS = {
  test: 'Test (TesteCF)',
  testecf: 'Test (TesteCF)',
  certificacion: 'Certificación (CerteCF)',
  certecf: 'Certificación (CerteCF)',
  produccion: 'Producción (eCF)',
  ecf: 'Producción (eCF)'
};

const TEST_LABELS = {
  authenticate: 'Autenticación DGII',
  seed: 'Obtener semilla DGII',
  certificate_validation: 'Validación certificado',
  send_ecf: 'Envío e-CF',
  trackid: 'Consulta TrackID',
  xml_validation: 'Validación XML',
  signature_validation: 'Validación firma',
  rfce: 'Prueba RFCE',
  debug_auth: 'Firmar y validar semilla DGII'
};

function getStatusClass(status) {
  const map = {
    listo: 'status-green',
    conectado: 'status-blue',
    certificado_valido: 'status-blue',
    certificado_cargado: 'status-yellow',
    inactivo: 'status-gray',
    error: 'status-red',
    no_configurado: 'status-gray'
  };
  return map[status] || 'status-gray';
}

function renderStatusPill(status) {
  const meta = {
    ok: { label: 'OK', bg: '#c6f6d5', color: '#22543d' },
    warning: { label: 'Observación', bg: '#feebc8', color: '#9c4221' },
    pending: { label: 'Pendiente', bg: '#e2e8f0', color: '#2d3748' },
    error: { label: 'Error', bg: '#fed7d7', color: '#822727' }
  }[status] || { label: status || '—', bg: '#e2e8f0', color: '#2d3748' };
  return `<span style="padding:.25rem .5rem;border-radius:999px;background:${meta.bg};color:${meta.color};font-size:.72rem;font-weight:700;white-space:nowrap">${escapeHtml(meta.label)}</span>`;
}

function showFiscalTechnicalResult(title, payload, isError = false) {
  const box = document.getElementById('fiscal-technical-result');
  if (!box) return;
  const formatted = typeof payload === 'string'
    ? payload
    : JSON.stringify(payload || {}, null, 2);
  box.style.color = isError ? '#9b2c2c' : 'var(--text2)';
  box.textContent = `${title}\n${formatDateTime(new Date())}\n\n${formatted}`;
}

function showFiscalLoading(show) {
  const el = document.getElementById('fiscal-loading');
  if (el) el.style.display = show ? 'flex' : 'none';
}

function showFiscalError(message) {
  const el = document.getElementById('fiscal-error-box');
  if (!el) return;
  el.style.display = 'block';
  el.textContent = message;
}

function clearFiscalError() {
  const el = document.getElementById('fiscal-error-box');
  if (!el) return;
  el.style.display = 'none';
  el.textContent = '';
}

function showFiscalToast(message, type = 'info') {
  if (typeof showToast === 'function') {
    showToast(message, type);
    return;
  }
  alert(message);
}

function setBtnLoading(btn, loading, label) {
  if (!btn) return;
  btn.disabled = loading;
  btn.textContent = label;
}

function setValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value ?? '';
}

function setChecked(id, checked) {
  const el = document.getElementById(id);
  if (el) el.checked = !!checked;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value ?? '';
}

function setSelectValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function normalizeEnvironment(environment) {
  const normalized = String(environment || 'test').trim().toLowerCase();
  if (normalized === 'ecf' || normalized === 'produccion' || normalized === 'prod' || normalized === 'production') return 'ecf';
  if (normalized === 'certecf' || normalized === 'certificacion' || normalized === 'certification') return 'certecf';
  return 'testecf';
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('es-DO');
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('es-DO');
}

function formatSeedState(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const labels = {
    obtenida: 'Obtenida',
    firmada: 'Firmada',
    autenticada: 'Autenticada',
    error: 'Error',
  };
  return labels[normalized] || value || '—';
}

function formatReceptionState(value) {
  const normalized = String(value || '').trim().toUpperCase();
  const labels = {
    ENVIADO: '✔ Enviado',
    PROCESANDO: '✔ Procesando',
    ACEPTADO: '✔ Aceptado',
    ACEPTADO_CONDICIONAL: '✔ Aceptado Condicional',
    RECHAZADO: '✔ Rechazado',
  };
  return labels[normalized] || value || '—';
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Importador Set de Pruebas DGII ────────────────────────────────────────────

async function importDgiiTestSet() {
  return importCertificationSet();
}

async function resetCertificationData() {
  const confirmed = await showDeleteConfirm(
    '¿Borrar TODAS las pruebas de certificación del batch actual? Esto eliminará los documentos enviados y pendientes. Tendrás que importar el set de DGII nuevamente para empezar de cero.',
    { confirmText: 'Borrar todo' }
  );
  if (!confirmed) return;

  const btn = document.getElementById('certification-btn-reset');
  setBtnLoading(btn, true, 'Borrando…');
  try {
    const response = await fiscalApi('DELETE', '/certification/reset', {});
    showFiscalToast(response.message || 'Pruebas de certificación eliminadas.', 'success');
    // Limpiar los inputs de archivos
    const fileInput = document.getElementById('certification-testset-files');
    const folderInput = document.getElementById('certification-testset-folder');
    if (fileInput) fileInput.value = '';
    if (folderInput) folderInput.value = '';
    // Limpiar resultado de importación
    const resultBox = document.getElementById('certification-import-result');
    if (resultBox) resultBox.style.display = 'none';
    await loadCertificationCases();
    await loadFiscalStatus();
  } catch (err) {
    showFiscalToast(`Error al borrar las pruebas: ${err.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, '🗑 Borrar pruebas y empezar de nuevo');
  }
}

async function resignPendingDocs() {
  const btn = event?.currentTarget;
  if (btn) { btn.disabled = true; btn.textContent = 'Re-firmando…'; }
  const resultDiv = document.getElementById('homologation-import-result');
  try {
    showFiscalToast('Re-firmando documentos pendientes con el certificado vigente…');
    const result = await fiscalApi('POST', '/documents/resign-pending', {});
    const ok = result.results?.filter(r => r.ok).length ?? 0;
    const fail = result.results?.filter(r => !r.ok).length ?? 0;
    const msg = `Re-firma completada: ${ok} OK${fail > 0 ? `, ${fail} error(es)` : ''}.`;
    showFiscalToast(msg);
    if (resultDiv) {
      resultDiv.style.display = 'block';
      resultDiv.innerHTML = `<b>${msg}</b>`;
    }
  } catch (err) {
    showFiscalToast(`Error al re-firmar: ${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Re-firmar pendientes'; }
  }
}

async function sendAllPendingTestDocs() {
  const btn = event?.currentTarget;
  if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }
  try {
    showFiscalToast('Enviando documentos pendientes a DGII…');
    const result = await fiscalApi('POST', '/documents/retry-pending', {});
    const sent = Array.isArray(result.results) ? result.results.length : '—';
    showFiscalToast(`Reintento completado: ${sent} documentos procesados.`);
    loadEcfDocuments();
  } catch (err) {
    showFiscalToast(`Error al enviar: ${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Enviar todos a DGII'; }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const seqDetails = document.getElementById('fiscal-seq-add-details');
  if (seqDetails) {
    seqDetails.addEventListener('toggle', () => {
      if (seqDetails.open) initEcfSequenceForm();
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeFiscalConfigModal();
  });

  // Persistir contraseña del certificado P12 en localStorage (app de escritorio local).
  const certPwdInput = document.getElementById('cert-center-password');
  if (certPwdInput) {
    const saved = localStorage.getItem('cert_center_p12_password');
    if (saved) certPwdInput.value = saved;
    certPwdInput.addEventListener('input', () => {
      if (certPwdInput.value) {
        localStorage.setItem('cert_center_p12_password', certPwdInput.value);
      } else {
        localStorage.removeItem('cert_center_p12_password');
      }
    });
  }
});
