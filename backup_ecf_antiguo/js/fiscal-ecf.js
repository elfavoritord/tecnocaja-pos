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
  let url = `/api/fiscal${endpoint}`;
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
  if (!res.ok) throw new Error(data.error || data.message || raw || `Error ${res.status}`);
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

    if (getCurrentFiscalTab() === 'sequences') {
      await initEcfSequenceForm();
      await loadFiscalSequences();
    }
    if (getCurrentFiscalTab() === 'documents') {
      await loadEcfDocuments();
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
    ['Auth base', urls.auth?.baseUrl],
    ['Semilla', urls.auth?.seedUrl],
    ['Validar semilla', urls.auth?.validateSeedUrl],
    ['Recepción e-CF', urls.ecf?.recepcionUrl],
    ['Consulta resultado', urls.ecf?.consultaResultadoUrl],
    ['Consulta estado', urls.ecf?.consultaEstadoUrl],
    ['Consulta TrackIDs', urls.ecf?.consultaTrackIdsUrl],
    ['Aprobación comercial', urls.ecf?.aprobacionComercialUrl],
    ['FC / RFCE base', urls.fc?.baseUrl || 'No configurada'],
    ['Recepción RFCE', urls.fc?.recepcionResumenUrl || 'TODO profesional'],
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
  if (fileInput) fileInput.disabled = isQscd;
  if (passInput) passInput.disabled = isQscd;
  if (uploadBtn) uploadBtn.disabled = isQscd;

  const modeHint = document.getElementById('fiscal-cert-mode-hint');
  if (modeHint) {
    modeHint.textContent = isQscd
      ? 'QSCD / cloud requiere integración real con el proveedor del contribuyente. El backend ya está preparado para guardar la configuración, pero no simula firma remota.'
      : 'Sube aquí el .p12 del contribuyente para firmar XML localmente de forma segura.';
  }
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
    showFiscalToast('Certificado cargado y validado correctamente.', 'success');
    showFiscalTechnicalResult('Certificado cargado', result);
    await loadFiscalStatus();
  } catch (e) {
    showFiscalToast(`Error: ${e.message}`, 'error');
    showFiscalTechnicalResult('Error validando certificado', { error: e.message }, true);
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
    if (el) body[field] = el.value.trim() || null;
  });

  const btn = document.getElementById('fiscal-btn-save-biz');
  setBtnLoading(btn, true, 'Guardando…');
  try {
    await fiscalApi('POST', '/config/business', body);
    showFiscalToast('Datos del negocio guardados correctamente.', 'success');
    await loadFiscalStatus();
  } catch (e) {
    showFiscalToast(`Error: ${e.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, 'Guardar datos del negocio');
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
    showFiscalToast(result.ok ? `Conexión exitosa con DGII (${env}).` : `Error al conectar: ${result.error || 'sin detalle'}`, result.ok ? 'success' : 'warning');
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
  setBtnLoading(btn, true, 'Probando…');
  try {
    const result = await fiscalApi('POST', '/dgii/test-seed', { environment: env });
    showFiscalTechnicalResult('Prueba de semilla DGII', result);
    showFiscalToast(result.ok ? 'Semilla solicitada correctamente.' : 'DGII respondió sin semilla interpretable.', result.ok ? 'success' : 'warning');
    await loadFiscalStatus();
  } catch (e) {
    showFiscalTechnicalResult('Error solicitando semilla', { error: e.message }, true);
    showFiscalToast(`Error: ${e.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, '🌱 Probar semilla');
  }
}

async function runDebugAuth() {
  const resultDiv = document.getElementById('fiscal-test-result');
  showFiscalToast('Ejecutando diagnóstico de firma y autenticación…');
  try {
    const data = await fiscalApi('POST', '/dgii/debug-auth', {});
    const out = {
      seedValue: data.seedValue,
      validateUrl: data.validateSeedUrl,
      dgiiStatus: data.dgiiHttpStatus,
      dgiiBody: data.dgiiResponseBody,
      signedXmlPreview: data.signedXml ? data.signedXml.slice(0, 600) + '…' : null
    };
    if (resultDiv) {
      resultDiv.style.display = 'block';
      resultDiv.querySelector('.test-result-title').textContent = 'Diagnóstico firma DGII';
      resultDiv.querySelector('.test-result-time').textContent = new Date().toLocaleString();
      resultDiv.querySelector('.test-result-body').textContent = JSON.stringify(out, null, 2);
    }
    const ok = data.dgiiHttpStatus === 200;
    showFiscalToast(ok ? 'DGII aceptó la semilla firmada.' : `DGII respondió HTTP ${data.dgiiHttpStatus}: ${data.dgiiResponseBody?.slice(0, 120)}`, ok ? 'success' : 'error');
  } catch (err) {
    showFiscalToast(`Error diagnóstico: ${err.message}`, 'error');
  }
}

async function runFiscalSendTest() {
  const btn = document.getElementById('fiscal-btn-test-send');
  const documentId = Number(document.getElementById('fiscal-test-document-id')?.value || 0) || undefined;
  setBtnLoading(btn, true, 'Enviando…');
  try {
    const result = await fiscalApi('POST', '/dgii/test-send', documentId ? { documentId } : {});
    showFiscalTechnicalResult('Envío e-CF de prueba', result);
    showFiscalToast('Prueba de envío ejecutada. Revisa el resultado técnico.', 'success');
    await loadFiscalStatus();
    await loadEcfDocuments();
  } catch (e) {
    showFiscalTechnicalResult('Error enviando e-CF de prueba', { error: e.message }, true);
    showFiscalToast(`Error: ${e.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, '📤 Enviar XML de prueba');
  }
}

async function runFiscalTrackIdTest() {
  const btn = document.getElementById('fiscal-btn-test-trackid');
  const documentId = Number(document.getElementById('fiscal-test-document-id')?.value || 0) || undefined;
  const trackId = document.getElementById('fiscal-test-trackid')?.value.trim() || undefined;
  setBtnLoading(btn, true, 'Consultando…');
  try {
    const payload = {};
    if (documentId) payload.documentId = documentId;
    if (trackId) payload.trackId = trackId;
    const result = await fiscalApi('POST', '/dgii/test-trackid', payload);
    showFiscalTechnicalResult('Consulta TrackID', result);
    showFiscalToast('Consulta TrackID ejecutada.', 'success');
    await loadFiscalStatus();
    await loadEcfDocuments();
  } catch (e) {
    showFiscalTechnicalResult('Error consultando TrackID', { error: e.message }, true);
    showFiscalToast(`Error: ${e.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, '🔎 Consultar TrackID');
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
              <td>${seq.activo ? `<button class="btn-xs btn-danger" onclick="disableEcfSequence(${seq.id})" title="Desactivar">✕</button>` : ''}</td>
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
    pendiente_red: 'orange',
    pendiente_rfce: 'orange',
    enviado: 'blue',
    procesando: 'blue',
    error_auth: 'red',
    error: 'red',
    error_consulta: 'red'
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
              <td title="${escapeHtml(doc.mensajes_dgii || '')}"><span class="badge-${estadoMap[doc.estado_dgii] || 'gray'}" style="font-size:0.7rem">${escapeHtml(doc.estado_dgii || '')}</span></td>
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
    const res = await fetch(`/api/fiscal/documents/${id}/xml`, {
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
    const res = await fetch(`/api/fiscal/documents/${id}/xml?download=1`, {
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
  error: 'Error'
};

const ENV_LABELS = {
  test: 'Test (TesteCF)',
  certificacion: 'Certificación (CerteCF)',
  produccion: 'Producción (eCF)'
};

const TEST_LABELS = {
  authenticate: 'Autenticación DGII',
  seed: 'Semilla',
  certificate_validation: 'Validación certificado',
  send_ecf: 'Envío e-CF',
  trackid: 'Consulta TrackID',
  xml_validation: 'Validación XML',
  signature_validation: 'Validación firma',
  rfce: 'Prueba RFCE'
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
  if (normalized === 'produccion' || normalized === 'prod' || normalized === 'production') return 'produccion';
  if (normalized === 'certificacion' || normalized === 'certification') return 'certificacion';
  return 'test';
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
  const fileInput = document.getElementById('homologation-testset-file');
  const file = fileInput?.files?.[0];
  if (!file) {
    showFiscalToast('Selecciona el archivo CSV del set de prueba DGII.', 'error');
    return;
  }

  const btn = document.getElementById('homologation-btn-import');
  const resultBox = document.getElementById('homologation-import-result');
  btn.disabled = true;
  btn.textContent = 'Importando…';
  resultBox.style.display = 'none';

  try {
    const formData = new FormData();
    formData.append('csv', file);
    const envEl = document.getElementById('fiscal-environment-select') || document.getElementById('fiscal-dgii-environment');
    formData.append('ambiente', envEl?.value || 'test');

    const result = await fiscalApi('POST', '/homologation/import-test-set', formData, true);

    const okRows  = (result.results || []).filter(r => r.ok);
    const errRows = (result.results || []).filter(r => !r.ok);

    const rowsHtml = (result.results || []).map(r => {
      const monto  = r.ok ? `RD$${Number(r.montoTotal || 0).toLocaleString('es-DO', { minimumFractionDigits: 2 })}` : '';
      const mode   = r.submissionMode === 'rfce' ? 'RFCE' : 'Recepción';
      const signed = r.signed ? '<span style="color:#276749">Firmado</span>' : '<span style="color:#d97706">Sin firma</span>';
      const detail = r.ok
        ? `${monto} · ${mode} · ${signed}`
        : `<span style="color:#9b2c2c">${escapeHtml(r.error || 'Error desconocido')}</span>`;
      const icon = r.ok ? '✓' : '✗';
      const color = r.ok ? '#276749' : '#9b2c2c';
      return `<div style="display:flex;gap:.5rem;align-items:baseline;font-size:.78rem">
        <span style="color:${color};font-weight:700;min-width:12px">${icon}</span>
        <span style="font-family:monospace;min-width:155px">${escapeHtml(r.encf || r.casoPrueba || '')}</span>
        <span style="color:var(--text3)">${detail}</span>
      </div>`;
    }).join('');

    const noCert = result.ok > 0 && !result.hasCert;
    const certWarning = noCert
      ? `<div style="margin-top:.65rem;padding:.5rem .75rem;background:#fff5f5;border-radius:6px;font-size:.78rem;color:#9b2c2c">
           Sin certificado .p12. Sube tu certificado en la pestaña <strong>Certificado</strong> y luego haz clic en <strong>Enviar todos a DGII</strong>.
         </div>`
      : '';

    resultBox.style.display = 'block';
    resultBox.innerHTML = `
      <div style="font-weight:700;margin-bottom:.5rem;color:${errRows.length ? '#9b2c2c' : '#276749'}">
        ${result.ok} de ${result.total} documentos creados
        ${errRows.length ? ` &mdash; ${errRows.length} errores` : ''}
      </div>
      <div style="display:grid;gap:.25rem;max-height:220px;overflow-y:auto">${rowsHtml}</div>
      ${certWarning}
    `;

    showFiscalToast(
      `${result.ok} documentos importados${errRows.length ? `, ${errRows.length} con error` : ''}.`,
      errRows.length ? 'warning' : 'success'
    );

    if (result.ok > 0) loadEcfDocuments();
  } catch (err) {
    resultBox.style.display = 'block';
    resultBox.innerHTML = `<span style="color:#9b2c2c">Error: ${escapeHtml(err.message)}</span>`;
    showFiscalToast(`Error al importar: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Importar set de prueba';
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
