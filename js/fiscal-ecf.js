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
      await loadCertificationCases();
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
      background:#1e293b; color:#e2e8f0; border-radius:10px; padding:16px 20px;
      margin:12px 0; font-size:13px; line-height:1.7; position:relative;
      border:2px solid #3b82f6; font-family:monospace;
    `;
    // Insertar después del botón de guardar
    const saveBtn = document.getElementById('fiscal-btn-save-biz');
    if (saveBtn && saveBtn.parentNode) {
      saveBtn.parentNode.insertBefore(panel, saveBtn.nextSibling);
    } else {
      document.querySelector('.fiscal-business-section')?.appendChild(panel);
    }
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
        <td style="color:#94a3b8;padding:2px 8px 2px 0">&lt;${tag}&gt;</td>
        <td style="color:${color};padding:2px 0">${val}</td>
      </tr>`;
    }).join('');

    const warningHtml = (warnings || []).map((w) =>
      `<div style="color:#f87171;margin-top:4px">⚠ ${w}</div>`
    ).join('');

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <strong style="color:#3b82f6;font-size:14px">🔍 Vista previa — datos del emisor en el XML</strong>
        <button onclick="document.getElementById('emitter-xml-preview-panel').remove()"
          style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:16px">✕</button>
      </div>
      <div style="color:#64748b;font-size:11px;margin-bottom:8px">Fuente: <strong style="color:#94a3b8">${source}</strong></div>
      <table style="border-collapse:collapse;width:100%">${tagRows}</table>
      ${warningHtml}
      <div style="margin-top:10px;color:#64748b;font-size:11px">
        Los campos "(no se incluirá en el XML)" son correctos si DGII no tiene ese dato registrado para el RNC.<br>
        Si DGII espera ese campo vacío, dejarlo en blanco es la configuración correcta.
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
  if (!confirm('Se generará un nuevo token interno para las rutas públicas DGII. El token anterior dejará de ser válido.')) return;
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
    const win = window.open('', '_blank', 'width=900,height=680,scrollbars=yes');
    if (win) {
      win.document.write(`<pre style="white-space:pre-wrap;word-break:break-all;font-size:0.8rem;padding:1rem">${escapeHtml(xml)}</pre>`);
      win.document.close();
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
  if (!confirm('¿Deseas eliminar el historial local de semillas DGII? Esta acción borra los XML guardados en storage/ecf/seeds.')) return;
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
    const win = window.open('', '_blank', 'width=900,height=680,scrollbars=yes');
    if (!win) {
      showFiscalToast('El navegador bloqueó la ventana emergente para mostrar el XML enviado.', 'warning');
      return;
    }
    win.document.write(`<pre style="white-space:pre-wrap;word-break:break-all;font-size:0.8rem;padding:1rem">${escapeHtml(xml)}</pre>`);
    win.document.close();
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
  if (!confirm('¿Activar la facturación electrónica e-CF? Las nuevas ventas intentarán emitir e-CF en DGII usando la configuración del contribuyente.')) return;
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
  if (!confirm('Las facturas electrónicas ya emitidas se conservarán. A partir de ahora las nuevas ventas no serán enviadas a DGII.\n\n¿Desactivar?')) return;
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
  if (!confirm('¿Desactivar esta secuencia e-NCF? No podrá ser usada hasta ser reactivada, pero el historial se conserva.')) return;
  try {
    await fiscalApi('DELETE', `/sequences/${id}`);
    showFiscalToast('Secuencia desactivada.', 'success');
    await loadFiscalSequences();
    await loadFiscalStatus();
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
            <th>ITBIS</th><th>TrackID</th><th>Emisión</th><th>Estado DGII</th><th>Acciones</th>
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
    const win = window.open('', '_blank', 'width=900,height=680,scrollbars=yes');
    if (!win) {
      showFiscalToast('El navegador bloqueó la ventana emergente para mostrar el XML.', 'warning');
      return;
    }
    win.document.write(`<pre style="white-space:pre-wrap;word-break:break-all;font-size:0.8rem;padding:1rem">${escapeHtml(xml)}</pre>`);
    win.document.close();
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
    pendiente: { label: '⏳ Pendiente', cls: 'badge-yellow' },
    firmado: { label: '⏳ Pendiente', cls: 'badge-yellow' },
    enviado: { label: '🔄 Enviado', cls: 'badge-blue' },
    procesando: { label: '🔄 Enviado', cls: 'badge-blue' },
    en_proceso: { label: '🔄 Enviado', cls: 'badge-blue' },
    error: { label: '🔴 Rechazado', cls: 'badge-red' }
  };
  return map[normalized] || { label: state || '—', cls: 'badge-gray' };
}

/**
 * Muestra un aviso prominente que recuerda generar XMLs frescos antes de subir al portal.
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
    <strong>⚠ PASO OBLIGATORIO antes de subir al portal < 250Mil</strong><br>
    Haz click en el botón <strong>"📋 Generar XMLs &lt;250Mil"</strong> para generar los XMLs frescos con los eNCFs actuales.<br>
    <strong>⛔ NO subas XMLs anteriores — DGII los rechazará y reseteará todo.</strong><br>
    <button onclick="generate250MilXmls()" style="margin-top:8px;background:#6d28d9;color:#fff;border:none;border-radius:6px;padding:8px 16px;cursor:pointer;font-size:13px;">
      📋 Generar XMLs &lt;250Mil ahora
    </button>
  `;
  box.parentNode.insertBefore(div, box);
}

async function loadCertificationCases() {
  const box = document.getElementById('certification-cases-table');
  if (!box) return;
  box.innerHTML = '<div class="loading-text">Cargando pruebas de certificación…</div>';
  try {
    const payload = await fiscalApi('GET', '/certification/cases');
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

  container.innerHTML = `
    <div style="overflow-x:auto">
      <table class="compact-table" style="width:100%;font-size:.8rem">
        <thead>
          <tr>
            <th>Estado</th>
            <th>Tipo</th>
            <th>e-NCF</th>
            <th>Cliente</th>
            <th>Total</th>
            <th>Tipo de prueba</th>
            <th>TrackID</th>
            <th>Archivo XML</th>
            <th>Acción</th>
          </tr>
        </thead>
        <tbody>
          ${cases.map((testCase) => {
            const badge = certificationStatusBadge(testCase.estado);
            const total = Number(testCase.total || 0).toLocaleString('es-DO', { style: 'currency', currency: 'DOP' });
            const dgiiMsg = Array.isArray(testCase.mensajes)
              ? testCase.mensajes.map((item) => `[${item.codigo}] ${item.valor}`).join(' | ')
              : (testCase.dgiiMessage || '');
            return `
              <tr title="${escapeHtml(dgiiMsg)}">
                <td><span class="${badge.cls}" style="font-size:.72rem">${escapeHtml(badge.label)}</span></td>
                <td>${escapeHtml(testCase.tipo || '—')}</td>
                <td><code>${escapeHtml(testCase.encf || '—')}</code></td>
                <td>${escapeHtml(testCase.cliente || 'Consumidor Final')}</td>
                <td style="text-align:right">${total}</td>
                <td>${escapeHtml(testCase.tipoPrueba || testCase.testKey || '—')}</td>
                <td><code>${escapeHtml(testCase.trackId || '—')}</code></td>
                <td style="font-size:.73rem;color:var(--text3)">${escapeHtml(testCase.xmlPath || 'Generado internamente')}</td>
                <td style="white-space:nowrap">
                  <button class="btn-xs" onclick="sendCertificationDoc(${testCase.id})" title="Enviar individual">Enviar</button>
                  <button class="btn-xs" onclick="sendCertificationDoc(${testCase.id}, true)" title="Reenviar">↺</button>
                  <button class="btn-xs" onclick="queryCertificationDoc(${testCase.id})" title="Consultar DGII">⟳</button>
                  <button class="btn-xs" onclick="viewEcfXml(${testCase.id})" title="Ver XML">XML</button>
                  <button class="btn-xs" onclick="downloadEcfXml(${testCase.id}, '${escapeHtml(testCase.encf || 'ecf')}')" title="Descargar XML">⬇</button>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function importCertificationSet() {
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
  btn.textContent = 'Importando…';
  resultBox.style.display = 'none';

  try {
    const formData = new FormData();
    for (const file of files) {
      formData.append('files', file, file.webkitRelativePath || file.name);
    }
    const envEl = document.getElementById('fiscal-environment-select') || document.getElementById('fiscal-dgii-environment');
    formData.append('ambiente', envEl?.value || 'testecf');

    const result = await fiscalApi('POST', '/certification/import', formData, true);
    const okRows = (result.results || []).filter((row) => row.ok);
    const errRows = (result.results || []).filter((row) => !row.ok);
    resultBox.style.display = 'block';
    resultBox.innerHTML = `
      <div style="font-weight:700;margin-bottom:.5rem;color:${errRows.length ? '#9b2c2c' : '#276749'}">
        ${result.ok} de ${result.total} pruebas listas
        ${errRows.length ? ` &mdash; ${errRows.length} error(es)` : ''}
      </div>
      <div style="display:grid;gap:.3rem;max-height:220px;overflow-y:auto">
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
      ${result.certificateWarning ? `<div style="margin-top:.7rem;color:#9c4221">${escapeHtml(result.certificateWarning)}</div>` : ''}
    `;
    showFiscalToast(result.message || `${result.ok} pruebas importadas.`, errRows.length ? 'warning' : 'success');
    await loadCertificationCases();
  } catch (err) {
    resultBox.style.display = 'block';
    resultBox.innerHTML = `<span style="color:#9b2c2c">Error: ${escapeHtml(err.message)}</span>`;
    showFiscalToast(`Error al importar certificación: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Importar Set de Pruebas DGII';
  }
}

async function sendCertificationDoc(id, isResend = false) {
  // Mostrar validación previa del emisor antes de enviar a DGII
  await showDgiiPreSendValidation(id, async () => {
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
  });
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
  await showDgiiPreSendValidation(null, async () => {
    try {
      const response = await fiscalApi('POST', '/certification/send-next', {});
      showFiscalToast(response.message || 'Se envió la siguiente prueba pendiente.', response.ok ? 'success' : 'warning');
      showFiscalTechnicalResult('Enviar siguiente prueba DGII', response);
      await loadCertificationCases();
      await loadFiscalStatus();
    } catch (err) {
      showFiscalToast(`Error al enviar siguiente prueba: ${err.message}`, 'error');
    }
  });
}

async function runCertificationSequence() {
  // Mostrar validación previa del emisor una sola vez antes de ejecutar todos los casos
  await showDgiiPreSendValidation(null, async () => {
    await _runCertificationSequenceConfirmed();
  });
}

async function _runCertificationSequenceConfirmed() {
  const btns = document.querySelectorAll('[onclick="runCertificationSequence()"]');
  btns.forEach((b) => { b.disabled = true; b.textContent = '⏳ Enviando…'; });
  try {
    // Paso 0: resetear casos "enviado/en_proceso" para que puedan ser recogidos por el loop.
    // Esto es necesario cuando el portal DGII reinicia las pruebas (casos rechazados/reseteados).
    await fiscalApi('POST', '/certification/reset-sent').catch(() => null);

    showFiscalToast('Enviando todos los casos pendientes a DGII…', 'info');
    // Paso 1: ráfaga de envíos (rápida, sin esperar respuesta de cada TrackID)
    const response = await fiscalApi('POST', '/certification/run-sequential', { limit: 50 });
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
    btns.forEach((b) => { b.disabled = false; b.textContent = '▶ Ejecutar pruebas secuenciales'; });
  }
}

async function resetSentCertificationCases() {
  const ok = confirm(
    '¿Rotar eNCFs y reiniciar todo el proceso de certificación?\n\n' +
    '• Se asignan nuevos números de secuencia a TODOS los documentos\n' +
    '  (incluyendo los 4 comprobantes RFCE de < 250Mil).\n' +
    '• Todos los documentos vuelven a estado "firmado".\n' +
    '• Los XMLs firmados anteriores se descartan.\n\n' +
    'Usar cuando el portal DGII ha reiniciado las pruebas por un rechazo.\n' +
    'Después ejecuta "▶ Ejecutar pruebas secuenciales".'
  );
  if (!ok) return;

  const btn = document.querySelector('[onclick="resetSentCertificationCases()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Rotando…'; }

  try {
    const response = await fiscalApi('POST', '/certification/rotate-encfs', { force: true });
    const rotated = response.rotated ?? response.rotatedCount ?? 0;
    showFiscalToast(
      `✓ ${rotated} eNCF(s) rotados. Todos los docs vuelven a "firmado". Ahora ejecuta ▶ Ejecutar pruebas secuenciales.`,
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
    showFiscalToast('Generando y firmando XMLs < 250Mil…', 'info');
    const response = await fiscalApi('POST', '/certification/generate-250mil');

    if (!response.ok) {
      showFiscalToast(`Error: ${response.error || 'Error desconocido'}`, 'error');
      return;
    }

    // Mostrar resultado con la lista de archivos generados
    const files = (response.generated || []);
    const fileList = files.map(f =>
      `<li><strong>${f.encf}.xml</strong> — ${f.sizekb}KB — ${f.items?.join(', ') || '?'} — MontoTotal: ${f.montoTotal}</li>`
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
        <strong>✅ ${files.length} XMLs generados y firmados — SIN NombreComercial</strong><br>
        <small>📁 ${response.outDir || 'scripts/250mil-upload/'}</small>
        <ul style="margin:8px 0 4px 16px;padding:0;">${fileList}</ul>
        <strong>⬆ Sube esos ${files.length} archivos uno a uno al portal DGII "Facturas de consumo &lt;250Mil".</strong>
      `;
      box.parentNode.insertBefore(div, box);
    }

    showFiscalToast(`✓ ${files.length} XMLs listos en scripts/250mil-upload/. Súbelos al portal.`, 'success');
  } catch (err) {
    showFiscalToast(`Error generando XMLs: ${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📋 Generar XMLs <250Mil'; }
  }
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
  if (tab === 'homologation' && FISCAL_UI_STATE.bundle?.checklist) {
    renderHomologationChecklist(FISCAL_UI_STATE.bundle.checklist);
    renderCertificationSummary(FISCAL_UI_STATE.bundle.certificationSummary || null);
    loadCertificationCases();
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
  const confirmed = window.confirm(
    '⚠️ ¿Borrar TODAS las pruebas de certificación del batch actual?\n\n' +
    'Esto eliminará los documentos enviados y los pendientes.\n' +
    'Tendrás que importar el set de DGII nuevamente para empezar de cero.\n\n' +
    '¿Continuar?'
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
});
