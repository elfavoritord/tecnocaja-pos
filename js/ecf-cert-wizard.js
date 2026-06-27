'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  ecf-cert-wizard.js — Wizard de Certificación DGII — Tecno Caja POS
//  Flujo guiado paso a paso para completar la certificación DGII CerteCF.
// ═══════════════════════════════════════════════════════════════════════════════

const ECF_CERT_WIZARD = (() => {

  // ── Definición de pasos — 15 pasos exactos del portal DGII CerteCF ──────────
  const STEPS = [
    { id: 1,  key: 'registrado',       icon: '📋', label: 'Registrado',                        desc: 'Postulación firmada y enviada a DGII' },
    { id: 2,  key: 'datos_ecf',        icon: '📊', label: 'Pruebas de Datos e-CF',             desc: 'Genera y envía comprobantes con datos DGII' },
    { id: 3,  key: 'datos_acecf',      icon: '🤝', label: 'Pruebas Datos Aprobación Com.',     desc: 'Aprobaciones Comerciales con datos DGII' },
    { id: 4,  key: 'sim_ecf',          icon: '📄', label: 'Pruebas Simulación e-CF',           desc: 'Simulación con datos reales de operaciones' },
    { id: 5,  key: 'sim_repr',         icon: '🖨️', label: 'Sim. Representación Impresa',      desc: 'Vista impresa de los e-CF de simulación' },
    { id: 6,  key: 'val_repr',         icon: '✔️', label: 'Validación Repr. Impresa',         desc: 'DGII valida el formato de representación' },
    { id: 7,  key: 'url_prueba',       icon: '🔗', label: 'URL Servicios Prueba',              desc: 'URLs públicas del sistema para pruebas' },
    { id: 8,  key: 'inicio_recv_ecf',  icon: '📡', label: 'Inicio Prueba Recepción e-CF',     desc: 'DGII envía e-CF de prueba a tu endpoint' },
    { id: 9,  key: 'recv_ecf',         icon: '📥', label: 'Recepción e-CF',                   desc: 'Recibir y procesar los e-CF enviados por DGII' },
    { id: 10, key: 'inicio_acecf',     icon: '📤', label: 'Inicio Prueba Recep. ACECF',       desc: 'DGII envía aprobaciones comerciales de prueba' },
    { id: 11, key: 'recv_acecf',       icon: '✅', label: 'Recepción Aprobación Comercial',    desc: 'Recibir y responder ACECF de DGII' },
    { id: 12, key: 'url_prod',         icon: '🌍', label: 'URL Servicios Producción',         desc: 'URLs definitivas del sistema en producción' },
    { id: 13, key: 'decl_jurada',      icon: '📝', label: 'Declaración Jurada',                desc: 'Firma y envío de la declaración jurada' },
    { id: 14, key: 'verif_estatus',    icon: '🔍', label: 'Verificación Estatus',              desc: 'DGII verifica y aprueba la certificación' },
    { id: 15, key: 'finalizado',       icon: '🎉', label: 'Finalizado',                        desc: 'DGII ha aprobado toda la certificación' },
  ];

  // ── Estado interno ────────────────────────────────────────────────────────────
  const WZ = {
    state: null,
    activeStep: 1,
    polling: null,
  };

  // ── CSS ───────────────────────────────────────────────────────────────────────
  function injectCss() {
    if (document.getElementById('ecf-cert-wz-css')) return;
    const s = document.createElement('style');
    s.id = 'ecf-cert-wz-css';
    s.textContent = `
      #ecf-cert-wizard {
        display:flex;flex-direction:column;min-height:580px;
        background:var(--bg);border-radius:12px;overflow:hidden;
        border:1px solid var(--border);
      }
      .ecf-wz-topbar {
        padding:1rem 1.4rem .85rem;
        background:var(--bg2);border-bottom:1px solid var(--border);
        display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;
      }
      .ecf-wz-progress-wrap {
        padding:.6rem 1.4rem;background:var(--bg2);border-bottom:1px solid var(--border);
      }
      .ecf-wz-progress-track {
        height:6px;background:var(--bg4);border-radius:999px;overflow:hidden;
      }
      .ecf-wz-progress-fill {
        height:100%;border-radius:999px;
        background:linear-gradient(90deg,var(--accent),var(--accent-light));
        transition:width .5s cubic-bezier(.4,0,.2,1);
      }
      .ecf-wz-body {
        display:grid;grid-template-columns:252px 1fr;flex:1;
        min-height:0;
      }
      .ecf-wz-sidebar {
        border-right:1px solid var(--border);background:var(--bg2);
        overflow-y:auto;padding:.5rem 0;max-height:calc(100vh - 260px);
      }
      .ecf-wz-step-item {
        display:flex;align-items:center;gap:.75rem;
        padding:.6rem 1rem;cursor:pointer;
        border-left:3px solid transparent;
        transition:background .15s,border-color .15s;
        user-select:none;
      }
      .ecf-wz-step-item:hover:not(.locked) { background:rgba(108,99,255,.06); }
      .ecf-wz-step-item.active { background:rgba(108,99,255,.08);border-left-color:var(--accent); }
      .ecf-wz-step-item.locked { opacity:.38;cursor:not-allowed; }
      .ecf-wz-step-item.completed { opacity:1; }
      .ecf-wz-step-dot {
        width:26px;height:26px;border-radius:50%;flex-shrink:0;
        display:flex;align-items:center;justify-content:center;
        font-size:.72rem;font-weight:800;transition:background .2s,color .2s;
      }
      .ecf-wz-step-dot.dot-locked   { background:var(--bg4);color:var(--text3); }
      .ecf-wz-step-dot.dot-available{ background:var(--bg3);color:var(--text2);border:1px solid var(--border); }
      .ecf-wz-step-dot.dot-active   { background:var(--accent);color:#fff; }
      .ecf-wz-step-dot.dot-done     { background:#16a34a;color:#fff; }
      .ecf-wz-step-dot.dot-error    { background:#dc2626;color:#fff; }
      .ecf-wz-content {
        overflow-y:auto;padding:1.4rem;max-height:calc(100vh - 260px);
        animation:ecfWzFadeIn .22s ease;
      }
      @keyframes ecfWzFadeIn {
        from { opacity:0;transform:translateY(6px); }
        to   { opacity:1;transform:translateY(0); }
      }

      /* Step header */
      .ecf-wz-step-header { margin-bottom:1.2rem; }
      .ecf-wz-step-header .step-num {
        font-size:.72rem;font-weight:700;color:var(--accent);
        text-transform:uppercase;letter-spacing:.06em;margin-bottom:.3rem;
      }
      .ecf-wz-step-header h2 { font-size:1.35rem;font-weight:800;margin:0 0 .3rem;color:var(--text); }
      .ecf-wz-step-header p  { font-size:.85rem;color:var(--text2);margin:0; }

      /* Cards */
      .ecf-wz-card {
        background:var(--bg2);border:1px solid var(--border);
        border-radius:10px;padding:1rem;margin-bottom:.85rem;
      }
      .ecf-wz-card-title {
        font-size:.8rem;font-weight:700;color:var(--text2);
        text-transform:uppercase;letter-spacing:.05em;margin-bottom:.7rem;
      }

      /* Status badges */
      .ecf-wz-badge {
        display:inline-flex;align-items:center;gap:.35rem;
        font-size:.72rem;font-weight:700;padding:.2rem .55rem;
        border-radius:999px;
      }
      .ecf-wz-badge.locked    { background:rgba(90,98,128,.12);color:var(--text3); }
      .ecf-wz-badge.available { background:rgba(59,130,246,.12);color:#60a5fa; }
      .ecf-wz-badge.pending   { background:rgba(217,119,6,.12);color:#f59e0b; }
      .ecf-wz-badge.done      { background:rgba(22,163,74,.12);color:#4ade80; }
      .ecf-wz-badge.error     { background:rgba(220,38,38,.12);color:#f87171; }

      /* Action button */
      .ecf-wz-action-btn {
        display:inline-flex;align-items:center;gap:.5rem;
        padding:.7rem 1.4rem;background:var(--accent);color:#fff;
        border:none;border-radius:8px;font-family:var(--font);font-size:.9rem;
        font-weight:700;cursor:pointer;transition:background .15s,transform .12s,box-shadow .15s;
      }
      .ecf-wz-action-btn:hover:not(:disabled) {
        background:var(--accent-light);transform:translateY(-1px);
        box-shadow:0 4px 18px var(--accent-glow);
      }
      .ecf-wz-action-btn:disabled { opacity:.45;cursor:not-allowed;transform:none;box-shadow:none; }
      .ecf-wz-action-btn.secondary {
        background:var(--bg3);color:var(--text2);
        border:1px solid var(--border);
      }
      .ecf-wz-action-btn.secondary:hover:not(:disabled) {
        background:var(--bg4);color:var(--text);box-shadow:none;
      }

      /* Doc list (step 4/5) */
      .ecf-wz-doc-row {
        display:flex;align-items:center;justify-content:space-between;
        gap:.65rem;padding:.55rem .75rem;
        border-radius:8px;border:1px solid var(--border);
        margin-bottom:.4rem;background:var(--bg3);font-size:.82rem;
      }
      .ecf-wz-doc-row .doc-encf { font-family:var(--font-mono);font-size:.78rem;color:var(--text2); }
      .ecf-wz-doc-row .doc-tipo { font-weight:700;min-width:40px; }
      .ecf-wz-doc-row .doc-resp { font-size:.74rem;color:var(--text3);flex:1;text-align:right;word-break:break-word; }

      /* Step 8 — celebration */
      .ecf-wz-done-screen {
        text-align:center;padding:2.5rem 1.5rem;
      }
      .ecf-wz-done-screen .done-icon {
        font-size:3.5rem;margin-bottom:1rem;
        animation:ecfWzPop .5s cubic-bezier(.175,.885,.32,1.275) .1s both;
      }
      @keyframes ecfWzPop {
        from { transform:scale(.5);opacity:0; }
        to   { transform:scale(1);opacity:1; }
      }
      .ecf-wz-done-screen h1 {
        font-size:1.6rem;font-weight:900;margin:.2rem 0 .5rem;
        background:linear-gradient(135deg,var(--accent),#4ade80);
        -webkit-background-clip:text;-webkit-text-fill-color:transparent;
      }

      /* Info grid */
      .ecf-wz-info-grid {
        display:grid;grid-template-columns:1fr 1fr;gap:.55rem;margin-top:1rem;
      }
      .ecf-wz-info-cell {
        background:var(--bg3);border:1px solid var(--border);border-radius:8px;
        padding:.65rem .85rem;
      }
      .ecf-wz-info-cell .info-label { font-size:.68rem;font-weight:700;color:var(--text3);text-transform:uppercase;margin-bottom:.2rem; }
      .ecf-wz-info-cell .info-val   { font-size:.92rem;font-weight:700;color:var(--text); }

      /* Type grid */
      .ecf-wz-type-grid, .ecf-wz-types-grid {
        display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:.5rem;margin-top:.6rem;
      }
      .ecf-wz-type-cell {
        background:var(--bg3);border:1px solid var(--border);border-radius:8px;
        padding:.55rem .8rem;display:flex;align-items:center;justify-content:space-between;
        font-size:.8rem;
      }
      .ecf-wz-type-cell.all-done { border-color:#16a34a;background:rgba(22,163,74,.06); }
      .ecf-wz-type-cell.has-error{ border-color:#dc2626;background:rgba(220,38,38,.06); }

      /* Log box */
      .ecf-wz-log {
        height:160px;overflow-y:auto;
        background:var(--bg);border:1px solid var(--border);border-radius:8px;
        padding:.55rem .75rem;font-family:var(--font-mono);font-size:.72rem;
        color:var(--text3);line-height:1.55;
      }
      .ecf-wz-log .log-ok    { color:#4ade80; }
      .ecf-wz-log .log-err   { color:#f87171; }
      .ecf-wz-log .log-warn  { color:#f59e0b; }
      .ecf-wz-log .log-info  { color:var(--text3); }

      /* File upload zone */
      .ecf-wz-dropzone {
        border:2px dashed var(--border);border-radius:10px;
        padding:1.2rem;text-align:center;cursor:pointer;
        transition:border-color .15s,background .15s;
        color:var(--text3);font-size:.85rem;
      }
      .ecf-wz-dropzone:hover { border-color:var(--accent);background:rgba(108,99,255,.04); }
      .ecf-wz-dropzone.has-file { border-color:#16a34a;background:rgba(22,163,74,.05);color:var(--text); }

      /* Summary row */
      .ecf-wz-summary-row {
        display:flex;align-items:center;gap:.65rem;
        padding:.55rem .75rem;border-radius:8px;
        background:var(--bg3);border:1px solid var(--border);margin-bottom:.35rem;
        font-size:.82rem;
      }

      /* Spin animation */
      @keyframes ecfWzSpin {
        to { transform:rotate(360deg); }
      }
      .ecf-wz-spin { display:inline-block;animation:ecfWzSpin .8s linear infinite; }

      /* Responsive */
      @media(max-width:680px) {
        .ecf-wz-body { grid-template-columns:1fr; }
        .ecf-wz-sidebar { display:none; }
        .ecf-wz-info-grid { grid-template-columns:1fr; }
      }
    `;
    document.head.appendChild(s);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function h(str) {
    return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleDateString('es-DO', { day:'2-digit', month:'2-digit', year:'numeric' }); }
    catch (_) { return iso; }
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('es-DO'); }
    catch (_) { return iso; }
  }

  function appendLog(boxId, text, type = 'info') {
    const box = document.getElementById(boxId);
    if (!box) return;
    const line = document.createElement('div');
    line.className = `log-${type}`;
    line.textContent = `${new Date().toLocaleTimeString('es-DO')} — ${text}`;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function setBtnState(id, loading, label) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = loading;
    btn.innerHTML = loading
      ? `<span class="ecf-wz-spin">⏳</span> ${h(label)}`
      : h(label);
  }

  // ── State management ──────────────────────────────────────────────────────────
  function defaultState() {
    return {
      currentStep: 1,
      completedSteps: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: null,
      progress: 0,
      environment: 'certecf',
      steps: {},
    };
  }

  async function loadState() {
    try {
      const res = await fiscalApi('GET', '/wizard/state');
      WZ.state = (res && res.state) ? res.state : defaultState();
    } catch (_) {
      try {
        const local = localStorage.getItem('ecf_cert_wz_v2');
        WZ.state = local ? JSON.parse(local) : defaultState();
      } catch (__) {
        WZ.state = defaultState();
      }
    }
    WZ.activeStep = WZ.state.currentStep || 1;
  }

  async function saveState(updates = {}) {
    WZ.state = {
      ...WZ.state,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    try { await fiscalApi('POST', '/wizard/state', { state: WZ.state }); } catch (_) {}
    try { localStorage.setItem('ecf_cert_wz_v2', JSON.stringify(WZ.state)); } catch (_) {}
  }

  // ── Step control ──────────────────────────────────────────────────────────────
  function isCompleted(stepId) {
    return (WZ.state?.completedSteps || []).includes(stepId);
  }

  function isUnlocked(stepId) {
    if (stepId === 1) return true;
    return isCompleted(stepId - 1);
  }

  function getProgress() {
    const done = (WZ.state?.completedSteps || []).length;
    return Math.round((done / STEPS.length) * 100);
  }

  async function markDone(stepId, data = {}) {
    const completed = [...new Set([...(WZ.state?.completedSteps || []), stepId])];
    const next = stepId < STEPS.length ? stepId + 1 : stepId;
    const manualResetSteps = (WZ.state?.manualResetSteps || []).filter((id) => id !== stepId);
    await saveState({
      currentStep: next,
      completedSteps: completed,
      manualResetSteps,
      progress: Math.round((completed.length / STEPS.length) * 100),
      steps: { ...(WZ.state?.steps || {}), [stepId]: { completedAt: new Date().toISOString(), data } },
      finishedAt: stepId === STEPS.length ? new Date().toISOString() : WZ.state.finishedAt,
    });
    WZ.activeStep = next;
    render();
  }

  async function resetStep(stepId) {
    const step = STEPS[stepId - 1];
    if (!confirm(`¿Reiniciar desde el Paso ${stepId} — "${step?.label}"?\n\nEsto borra el progreso de este paso y de los pasos posteriores. Los pasos anteriores quedan intactos.`)) return;
    const completed = (WZ.state?.completedSteps || []).filter((id) => id < stepId);
    const steps = { ...(WZ.state?.steps || {}) };
    Object.keys(steps).forEach((key) => {
      if (Number(key) >= stepId) delete steps[key];
    });
    const manualResetSteps = [...new Set([...(WZ.state?.manualResetSteps || []), stepId])];
    await saveState({ completedSteps: completed, manualResetSteps, currentStep: stepId, steps, finishedAt: null });
    WZ.activeStep = stepId;
    render();
  }

  // ── Public: go to step ────────────────────────────────────────────────────────
  function goToStep(stepId) {
    if (!isUnlocked(stepId)) return;
    WZ.activeStep = stepId;
    renderContent();
    renderSidebar();
  }

  // ── Main render ───────────────────────────────────────────────────────────────
  function render() {
    const root = document.getElementById('fiscal-tab-homologation');
    if (!root) return;
    injectCss();

    const progress = getProgress();
    const env = WZ.state?.environment || 'certecf';
    const envLabel = env === 'certecf' ? 'CerteCF' : 'TesteCF';
    const envColor = env === 'certecf' ? '#f59e0b' : '#60a5fa';
    const startedAt = fmtDate(WZ.state?.startedAt);
    const finishedAt = fmtDate(WZ.state?.finishedAt);

    root.innerHTML = `
      <div id="ecf-cert-wizard">
        <!-- Top bar -->
        <div class="ecf-wz-topbar">
          <div>
            <div style="font-size:1.1rem;font-weight:900;color:var(--text)">
              Wizard de Certificación DGII
            </div>
            <div style="font-size:.78rem;color:var(--text3);margin-top:.1rem">
              Guía paso a paso para completar la certificación e-CF
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:.85rem;flex-wrap:wrap">
            <span style="font-size:.75rem;color:${envColor};font-weight:700;background:rgba(245,158,11,.08);padding:.2rem .6rem;border-radius:6px;border:1px solid ${envColor}33">
              ${h(envLabel)}
            </span>
            <div style="font-size:.75rem;color:var(--text3)">
              Inicio: <strong style="color:var(--text2)">${h(startedAt)}</strong>
              ${WZ.state?.finishedAt ? `&nbsp;·&nbsp; Fin: <strong style="color:#4ade80">${h(finishedAt)}</strong>` : ''}
            </div>
            <button class="ecf-wz-action-btn secondary" style="padding:.4rem .85rem;font-size:.78rem"
              onclick="ECF_CERT_WIZARD._resetWizard()">
              Reiniciar
            </button>
          </div>
        </div>

        <!-- Progress bar -->
        <div class="ecf-wz-progress-wrap">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.35rem">
            <span style="font-size:.72rem;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.05em">
              Progreso de certificación
            </span>
            <span style="font-size:.85rem;font-weight:800;color:${progress===100?'#4ade80':'var(--accent)'}">
              ${progress}%
            </span>
          </div>
          <div class="ecf-wz-progress-track">
            <div class="ecf-wz-progress-fill" style="width:${progress}%"></div>
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:.3rem;font-size:.68rem;color:var(--text3)">
            <span>${(WZ.state?.completedSteps||[]).length} de ${STEPS.length} pasos completados</span>
            <span>${progress === 100 ? '🎉 Certificación completada' : progress === 0 ? 'Inicia el proceso para comenzar' : 'En progreso…'}</span>
          </div>
        </div>

        <!-- Body -->
        <div class="ecf-wz-body">
          <div class="ecf-wz-sidebar" id="ecf-wz-sidebar"></div>
          <div class="ecf-wz-content" id="ecf-wz-content"></div>
        </div>
      </div>
    `;

    renderSidebar();
    renderContent();
  }

  function renderSidebar() {
    const sidebar = document.getElementById('ecf-wz-sidebar');
    if (!sidebar) return;
    sidebar.innerHTML = STEPS.map(step => {
      const completed = isCompleted(step.id);
      const unlocked  = isUnlocked(step.id);
      const active    = WZ.activeStep === step.id;
      const locked    = !unlocked;

      let dotClass = 'dot-locked';
      let statusText = '🔒 Bloqueado';
      if (completed) { dotClass = 'dot-done'; statusText = '✅ Completado'; }
      else if (active) { dotClass = 'dot-active'; statusText = '⏳ En proceso'; }
      else if (unlocked) { dotClass = 'dot-available'; statusText = '🔵 Disponible'; }

      return `
        <div class="ecf-wz-step-item ${locked?'locked':''} ${completed?'completed':''} ${active?'active':''}"
          ${locked ? '' : `onclick="ECF_CERT_WIZARD.goToStep(${step.id})"`}
          style="position:relative">
          <div class="ecf-wz-step-dot ${dotClass}">
            ${completed ? '✓' : step.id}
          </div>
          <div style="min-width:0;flex:1">
            <div style="font-size:.8rem;font-weight:${active?700:500};color:${locked?'var(--text3)':active?'var(--text)':'var(--text2)'};
              white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              ${h(step.label)}
            </div>
            <div style="font-size:.66rem;color:var(--text3)">${statusText}</div>
          </div>
          ${completed ? `<button
            onclick="event.stopPropagation();ECF_CERT_WIZARD.resetStep(${step.id})"
            title="Reiniciar solo este paso"
            style="flex-shrink:0;background:none;border:1px solid rgba(251,113,133,.35);border-radius:4px;color:#fb7185;font-size:.6rem;padding:.15rem .35rem;cursor:pointer;line-height:1.2;opacity:.7"
            onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='.7'">↩</button>` : ''}
        </div>
      `;
    }).join('');
  }

  function renderContent() {
    const content = document.getElementById('ecf-wz-content');
    if (!content) return;
    const renderers = [
      null,
      renderStep1,   // 1  Registrado
      renderStep2,   // 2  Pruebas de Datos e-CF
      renderStep3,   // 3  Pruebas Datos Aprobación Com.
      renderStep4,   // 4  Pruebas Simulación e-CF
      renderStep5,    // 5  Sim. Representación Impresa
      renderStep6val, // 6  Validación Repr. Impresa
      renderStep7url, // 7  URL Servicios Prueba
      renderStep8recv,// 8  Inicio Prueba Recepción e-CF
      renderStep9ecf, // 9  Recepción e-CF
      renderStep10inicio,// 10 Inicio Prueba Recep. ACECF
      renderStep6,    // 11 Recepción Aprobación Comercial
      renderStep12prod,// 12 URL Servicios Producción
      renderStep13decl,// 13 Declaración Jurada
      renderStep14verify,// 14 Verificación Estatus
      renderStep15,  // 15 Finalizado
    ];
    const fn = renderers[WZ.activeStep];
    if (fn) {
      content.style.animation = 'none';
      requestAnimationFrame(() => {
        content.style.animation = '';
        content.innerHTML = fn();
        initStepHandlers(WZ.activeStep);
      });
    }
  }

  function stepHeader(id, iconOverride) {
    const step = STEPS[id - 1];
    const completed = isCompleted(id);
    const badge = completed
      ? '<span class="ecf-wz-badge done">✅ Completado</span>'
      : isUnlocked(id)
        ? (id === WZ.activeStep ? '<span class="ecf-wz-badge pending">⏳ En proceso</span>' : '<span class="ecf-wz-badge available">🔵 Disponible</span>')
        : '<span class="ecf-wz-badge locked">🔒 Bloqueado</span>';

    const resetBtn = completed
      ? `<button
          onclick="ECF_CERT_WIZARD.resetStep(${id})"
          title="Reiniciar solo este paso"
          style="margin-left:auto;background:rgba(251,113,133,.1);border:1px solid rgba(251,113,133,.35);border-radius:6px;color:#fb7185;font-size:.72rem;padding:.3rem .7rem;cursor:pointer;white-space:nowrap;flex-shrink:0">
          ↩ Reiniciar paso
        </button>`
      : '';

    return `
      <div class="ecf-wz-step-header">
        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
          <div class="step-num" style="flex:1;min-width:0">Paso ${id} de ${STEPS.length} ${badge}</div>
          ${resetBtn}
        </div>
        <h2>${iconOverride || step.icon} ${h(step.label)}</h2>
        <p>${h(step.desc)}</p>
      </div>
    `;
  }

  // ── PASO 1: Registrado — Postulación ante DGII ───────────────────────────────
  function renderStep1() {
    const completed = isCompleted(1);
    const savedData = WZ.state?.steps?.[1]?.data || {};
    return `
      ${stepHeader(1)}

      <!-- Datos del contribuyente -->
      <div class="ecf-wz-card">
        <div class="ecf-wz-card-title">Datos del contribuyente (pre-llenados por DGII)</div>
        <div id="ecf-wz-step1-loading" style="color:var(--text3);font-size:.85rem">
          <span class="ecf-wz-spin">⏳</span> Cargando…
        </div>
        <div id="ecf-wz-step1-biz" style="display:none">
          <div class="ecf-wz-info-grid" id="ecf-wz-step1-grid"></div>
          <div id="ecf-wz-step1-warnings" style="margin-top:.65rem"></div>
        </div>
      </div>

      <!-- Datos del software -->
      <div class="ecf-wz-card">
        <div class="ecf-wz-card-title">Datos del software a utilizar</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:.6rem;max-width:560px">
          <div>
            <label class="form-label-sm">Tipo de software</label>
            <select id="ecf-wz-sw-tipo" class="form-input" ${completed?'disabled':''}>
              <option value="PROPIO">PROPIO</option>
              <option value="TERCERO">TERCERO</option>
            </select>
          </div>
          <div>
            <label class="form-label-sm">Nombre del software *</label>
            <input id="ecf-wz-sw-nombre" class="form-input" value="Tecno Caja Pos" ${completed?'disabled':''} placeholder="Tecno Caja Pos">
          </div>
          <div>
            <label class="form-label-sm">Versión *</label>
            <input id="ecf-wz-sw-version" class="form-input" value="1.0" ${completed?'disabled':''} placeholder="1.0">
          </div>
        </div>
      </div>

      <!-- Flujo: Generar → Firmar → Enviar -->
      ${completed ? `
        <div style="background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.25);border-radius:10px;padding:1rem;display:flex;align-items:center;gap:.85rem;margin-bottom:.85rem">
          <span style="font-size:2rem">✅</span>
          <div>
            <div style="font-weight:800;color:#4ade80">Postulación enviada a DGII</div>
            <div style="font-size:.78rem;color:var(--text3);margin-top:.2rem">
              Completado el ${h(fmtDateTime(WZ.state?.steps?.[1]?.completedAt))}
            </div>
          </div>
        </div>
        <div style="display:flex;gap:.65rem">
          <button class="ecf-wz-action-btn" onclick="ECF_CERT_WIZARD.goToStep(2)">Ir al Paso 2 →</button>
          <button class="ecf-wz-action-btn secondary" onclick="ECF_CERT_WIZARD._unlockStep1()">Rehacerlo</button>
        </div>
      ` : `
        <div class="ecf-wz-card">
          <div class="ecf-wz-card-title" style="margin-bottom:.55rem">🔏 Firmar y enviar XML de postulación</div>
          <div style="font-size:.78rem;color:var(--text3);margin-bottom:.7rem">
            Portal DGII CerteCF → Paso 1 → <strong>GENERAR ARCHIVO</strong> → arrastra aquí → firma → sube el resultado en DGII → <strong>ENVIAR ARCHIVO</strong>
          </div>

          <!-- Drop zone -->
          <label id="ecf-wz-post-dropzone"
            style="display:flex;align-items:center;gap:.65rem;min-height:64px;border:2px dashed rgba(99,102,241,.45);border-radius:10px;padding:.7rem 1rem;cursor:pointer;transition:border-color .2s;margin-bottom:.55rem;background:rgba(99,102,241,.04)"
            ondragover="event.preventDefault();this.style.borderColor='#6366f1'"
            ondragleave="this.style.borderColor='rgba(99,102,241,.45)'"
            ondrop="event.preventDefault();this.style.borderColor='rgba(99,102,241,.45)';ECF_CERT_WIZARD._onPostXmlDrop(event.dataTransfer.files)">
            <span style="font-size:1.5rem">📂</span>
            <div>
              <div style="font-size:.83rem;color:var(--text2)">Arrastra el XML de DGII aquí, o haz clic para seleccionar</div>
              <div id="ecf-wz-post-filename" style="font-size:.78rem;color:#93c5fd;margin-top:.15rem">Sin archivo seleccionado</div>
            </div>
            <input type="file" id="ecf-wz-postulation-xml" accept=".xml,text/xml,application/xml"
              style="position:absolute;opacity:0;pointer-events:none;width:1px;height:1px"
              onchange="ECF_CERT_WIZARD._onPostXmlChange(this)">
          </label>

          <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
            <button id="ecf-wz-step1-sign-btn" class="ecf-wz-action-btn" onclick="ECF_CERT_WIZARD.runStep1Sign()">
              🔏 Firmar y descargar XML →
            </button>
            <button id="ecf-wz-step1-confirm-btn" class="ecf-wz-action-btn secondary" style="display:none" onclick="ECF_CERT_WIZARD.runStep1Confirm()">
              ✅ Ya envié a DGII — Continuar →
            </button>
          </div>
          <div id="ecf-wz-step1-sign-result" style="margin-top:.5rem;display:none"></div>
        </div>

        <div style="display:none">
        </div>
      `}
    `;
  }

  async function initStep1() {
    try {
      const bundle = await fiscalApi('GET', '/config');
      const biz = bundle.business || {};
      const loadingEl = document.getElementById('ecf-wz-step1-loading');
      const bizEl = document.getElementById('ecf-wz-step1-biz');
      const grid = document.getElementById('ecf-wz-step1-grid');
      const warningsEl = document.getElementById('ecf-wz-step1-warnings');

      const fields = [
        { label: 'RNC/Cédula',     val: biz.rnc || '—',           ok: !!(biz.rnc && biz.rnc.replace(/\D/g,'').length >= 9) },
        { label: 'Razón Social',    val: biz.razon_social || '—',  ok: !!biz.razon_social },
        { label: 'Nombre Comercial',val: biz.nombre_comercial || '(vacío)', ok: true },
        { label: 'Correo',          val: biz.correo || '—',        ok: !!biz.correo },
        { label: 'Teléfono',        val: biz.telefono || '—',      ok: !!biz.telefono },
        { label: 'Dirección',       val: biz.direccion || '—',     ok: !!biz.direccion },
        { label: 'Provincia',       val: biz.provincia || '—',     ok: !!biz.provincia },
        { label: 'Municipio',       val: biz.municipio || '—',     ok: true },
      ];

      if (grid) {
        grid.innerHTML = fields.map(f => `
          <div class="ecf-wz-info-cell">
            <div class="info-label">${h(f.label)}</div>
            <div class="info-val" style="color:${f.ok?'var(--text)':'#f87171'};font-size:.82rem">
              ${f.ok ? '' : '⚠ '}${h(f.val)}
            </div>
          </div>
        `).join('');
      }

      const missing = fields.filter(f => !f.ok);
      if (warningsEl) {
        warningsEl.innerHTML = missing.length
          ? `<div style="background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.2);border-radius:8px;padding:.6rem .8rem;font-size:.78rem;color:#f87171">
               ⚠ Completa en "🏢 Mi Negocio": <strong>${missing.map(f=>f.label).join(', ')}</strong>
             </div>`
          : `<div style="background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.2);border-radius:8px;padding:.6rem .8rem;font-size:.78rem;color:#4ade80">
               ✓ Datos del emisor completos — coinciden con lo que DGII tiene registrado
             </div>`;
      }

      if (loadingEl) loadingEl.style.display = 'none';
      if (bizEl) bizEl.style.display = '';
    } catch (err) {
      const loadingEl = document.getElementById('ecf-wz-step1-loading');
      if (loadingEl) loadingEl.innerHTML = `<span style="color:#f87171">Error: ${h(err.message)}</span>`;
    }
  }

  function _setPostXmlFile(file) {
    const span = document.getElementById('ecf-wz-post-filename');
    if (!span || !file) return;
    if (!file.name.toLowerCase().endsWith('.xml')) {
      span.textContent = `⚠ ${file.name} — debe ser un archivo .xml`;
      span.style.color = '#f87171';
      return;
    }
    span.textContent = `✓ ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    span.style.color = '#4ade80';
  }

  function _onPostXmlChange(input) {
    if (input.files?.[0]) _setPostXmlFile(input.files[0]);
  }

  function _onPostXmlDrop(files) {
    if (!files?.[0]) return;
    const input = document.getElementById('ecf-wz-postulation-xml');
    if (!input) return;
    const dt = new DataTransfer();
    dt.items.add(files[0]);
    input.files = dt.files;
    _setPostXmlFile(files[0]);
  }

  async function runStep1Sign() {
    const fileInput = document.getElementById('ecf-wz-postulation-xml');
    const resultEl = document.getElementById('ecf-wz-step1-sign-result');

    if (!fileInput?.files?.[0]) {
      if (typeof showFiscalToast === 'function') showFiscalToast('Selecciona el XML generado por DGII.', 'warning'); return;
    }

    setBtnState('ecf-wz-step1-sign-btn', true, 'Firmando…');
    if (resultEl) resultEl.style.display = 'none';

    try {
      const form = new FormData();
      form.append('xml', fileInput.files[0]);
      const res = await fiscalApi('POST', '/wizard/sign-postulation-xml', form, true);

      if (!res.ok || !res.signedXml) throw new Error(res.error || 'No se recibió el XML firmado.');

      // Descargar el XML firmado automáticamente
      const blob = new Blob([res.signedXml], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'postulacion-firmada.xml';
      a.click();
      URL.revokeObjectURL(url);

      if (resultEl) {
        resultEl.style.display = '';
        const autoMsg = res.autoFilledFields?.length
          ? `<div style="margin-top:.4rem;font-size:.76rem;color:#86efac">✔ Auto-completado desde DGII: ${res.autoFilledFields.join(', ')}</div>`
          : '';
        resultEl.innerHTML = `
          <div style="background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.25);border-radius:8px;padding:.6rem .85rem;font-size:.8rem;color:#4ade80">
            ✅ <strong>postulacion-firmada.xml</strong> descargado — súbelo en DGII → <strong>ENVIAR ARCHIVO</strong>
            ${autoMsg}
          </div>
        `;
      }

      // Refrescar tabla de datos del emisor (correo/provincia pueden haberse auto-poblado)
      initStep1().catch(() => {});

      // Mostrar botón confirmar sin tener que hacer scroll
      const confirmBtn = document.getElementById('ecf-wz-step1-confirm-btn');
      if (confirmBtn) confirmBtn.style.display = '';

      setBtnState('ecf-wz-step1-sign-btn', false, '🔏 Firmar y descargar XML →');
    } catch (err) {
      if (resultEl) {
        resultEl.style.display = '';
        resultEl.innerHTML = `<div style="background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.25);border-radius:8px;padding:.7rem;color:#f87171">❌ ${h(err.message)}</div>`;
      }
      setBtnState('ecf-wz-step1-sign-btn', false, '🔏 Firmar XML con P12 →');
    }
  }

  async function runStep1Confirm() {
    setBtnState('ecf-wz-step1-confirm-btn', true, 'Guardando…');
    try {
      const bundle = await fiscalApi('GET', '/config').catch(() => ({}));
      const biz = bundle.business || {};
      const swNombre  = document.getElementById('ecf-wz-sw-nombre')?.value || 'Tecno Caja Pos';
      const swVersion = document.getElementById('ecf-wz-sw-version')?.value || '1.0';
      const swTipo    = document.getElementById('ecf-wz-sw-tipo')?.value || 'PROPIO';
      await markDone(1, {
        rnc: biz.rnc, razonSocial: biz.razon_social,
        software: { nombre: swNombre, version: swVersion, tipo: swTipo },
      });
    } catch (err) {
      setBtnState('ecf-wz-step1-confirm-btn', false, '✅ Confirmar — ya envié el archivo a DGII →');
      if (typeof showFiscalToast === 'function') showFiscalToast(`Error: ${err.message}`, 'error');
    }
  }

  // runStep1 kept as alias for backwards compat with public API
  async function runStep1() { return runStep1Confirm(); }

  function _unlockStep1() {
    const completed = (WZ.state?.completedSteps || []).filter(s => s !== 1);
    WZ.state.completedSteps = completed;
    WZ.activeStep = 1;
    render();
  }

  // ── PASO 2: Pruebas de Datos e-CF ────────────────────────────────────────────
  function renderStep2() {
    const completed = isCompleted(2);
    const savedData = WZ.state?.steps?.[2]?.data || {};
    return `
      ${stepHeader(2)}

      ${completed ? `
        <div class="ecf-wz-card">
          <div style="background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.25);border-radius:10px;padding:1rem;display:flex;align-items:center;gap:.85rem;margin-bottom:.85rem">
            <span style="font-size:2rem">✅</span>
            <div>
              <div style="font-weight:800;color:#4ade80">Pruebas de Datos e-CF completadas</div>
              <div style="font-size:.78rem;color:var(--text3);margin-top:.2rem">
                ${h(savedData.ecfAccepted||'—')}/${h(savedData.ecfTotal||'—')} comprobantes ·
                ${h(savedData.rfceAccepted||0)}/4 resúmenes ·
                Completado el ${h(fmtDateTime(WZ.state?.steps?.[2]?.completedAt))}
              </div>
            </div>
          </div>
          <button class="ecf-wz-action-btn" onclick="ECF_CERT_WIZARD.goToStep(3)">Ir al Paso 3 →</button>
        </div>
      ` : `
        <!-- Estado actual -->
        <div class="ecf-wz-card" style="padding:.9rem 1.1rem">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.7rem;gap:.5rem">
            <div class="ecf-wz-card-title" style="margin:0">📊 Estado actual de las pruebas</div>
            <button class="ecf-wz-action-btn secondary" style="font-size:.78rem;padding:.35rem .7rem"
              onclick="ECF_CERT_WIZARD._pollStep2()">🔄 Actualizar</button>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:.65rem">
            <div style="background:rgba(255,255,255,.04);border-radius:8px;padding:.7rem .9rem">
              <div id="ecf-wz-s2-ecf-count" style="font-size:2rem;font-weight:900;color:var(--text);line-height:1.1">0/21</div>
              <div id="ecf-wz-s2-ecf-subtitle" style="font-size:.8rem;color:var(--text3);margin-top:.2rem">Comprobantes Aceptados</div>
              <div id="ecf-wz-s2-ecf-progress" style="display:none;font-size:.72rem;color:#f59e0b;margin-top:.1rem"></div>
            </div>
            <div style="background:rgba(255,255,255,.04);border-radius:8px;padding:.7rem .9rem">
              <div id="ecf-wz-s2-rfce-count" style="font-size:2rem;font-weight:900;color:var(--text);line-height:1.1">0/4</div>
              <div id="ecf-wz-s2-rfce-subtitle" style="font-size:.8rem;color:var(--text3);margin-top:.2rem">Resúmenes de Consumo Aceptados</div>
              <button id="ecf-wz-s2-rfce-resend-btn" class="ecf-wz-action-btn"
                style="font-size:.75rem;padding:.3rem .7rem;margin-top:.5rem"
                onclick="ECF_CERT_WIZARD._resendRfce()">🔄 Reenviar RFCE</button>
              <div id="ecf-wz-s2-rfce-resend-log" style="font-size:.72rem;margin-top:.3rem;color:var(--text3)"></div>
            </div>
          </div>
        </div>

        <!-- Alerta rechazados (oculta) -->
        <div id="ecf-wz-step2-blocked-alert" style="display:none">
          <div style="background:rgba(220,38,38,.07);border:1px solid rgba(220,38,38,.3);border-radius:10px;padding:.75rem 1rem;margin-bottom:.5rem;display:flex;align-items:center;gap:.65rem;flex-wrap:wrap">
            <span style="font-size:1.2rem">⚠️</span>
            <span style="font-weight:700;color:#f87171;font-size:.85rem;flex:1">Comprobantes rechazados — resetear y reintentar</span>
            <button id="ecf-wz-step2-reset-btn" class="ecf-wz-action-btn" style="font-size:.8rem;padding:.4rem .8rem"
              onclick="ECF_CERT_WIZARD._resetAndRetry2()">🔄 Resetear y reintentar</button>
          </div>
        </div>

        <!-- Drop zone Excel + botón enviar -->
        <div class="ecf-wz-card" style="padding:.9rem 1.1rem">
          <label id="ecf-wz-step2-dropzone"
            style="display:flex;align-items:center;gap:.65rem;min-height:64px;border:2px dashed rgba(99,102,241,.45);border-radius:10px;padding:.7rem 1rem;cursor:pointer;transition:border-color .2s;margin-bottom:.55rem;background:rgba(99,102,241,.04)"
            ondragover="event.preventDefault();this.style.borderColor='#6366f1'"
            ondragleave="this.style.borderColor='rgba(99,102,241,.45)'"
            ondrop="event.preventDefault();this.style.borderColor='rgba(99,102,241,.45)';ECF_CERT_WIZARD._onStep2ExcelDrop(event.dataTransfer.files)">
            <span style="font-size:1.5rem">📊</span>
            <div>
              <div style="font-size:.83rem;color:var(--text2)">Arrastra el Excel de DGII aquí, o haz clic para seleccionar</div>
              <div id="ecf-wz-step2-excel-name" style="font-size:.78rem;color:#93c5fd;margin-top:.15rem">Sin archivo</div>
            </div>
            <input type="file" id="ecf-wz-step2-excel" accept=".xlsx,.xls,.ods,.zip,.xml"
              style="position:absolute;opacity:0;pointer-events:none;width:1px;height:1px"
              onchange="ECF_CERT_WIZARD._onStep2ExcelChange(this)">
          </label>
          <button id="ecf-wz-step2-process-btn" class="ecf-wz-action-btn"
            style="font-size:.88rem;padding:.65rem 1rem;width:100%;margin-bottom:.4rem"
            onclick="ECF_CERT_WIZARD.runStep2()">
            📤 Procesar y enviar comprobantes →
          </button>
          <div class="ecf-wz-log" id="ecf-wz-step2-log" style="max-height:100px;min-height:36px">Listo para importar…</div>
        </div>

        <!-- IDs ocultos necesarios para JS -->
        <div style="display:none">
          <button onclick="ECF_CERT_WIZARD.runStep2ForceSync()">sync</button>
          <button onclick="ECF_CERT_WIZARD.runStep2SendPending()">pending</button>
          <button id="ecf-wz-step2-rfce-gen"></button>
          <button id="ecf-wz-step2-rfce-send"></button>
          <div id="ecf-wz-step2-rfce-list"></div>
          <div id="ecf-wz-step2-rfce-log"></div>
        </div>

        <!-- Botón preparar 4 XML -->
        <div class="ecf-wz-card" style="padding:.9rem 1.1rem">
          <button id="ecf-wz-step2-portal-btn" class="ecf-wz-action-btn secondary"
            style="font-size:.88rem;padding:.65rem 1rem;width:100%;opacity:.4;cursor:not-allowed" disabled
            onclick="ECF_CERT_WIZARD.runStep2PreparePortal()">
            📁 Preparar 4 XML para portal
          </button>
        </div>

        <!-- Confirmar -->
        <div class="ecf-wz-card" style="border:1px solid rgba(22,163,74,.25);background:rgba(22,163,74,.035);padding:.75rem 1rem">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap">
            <div style="font-size:.82rem;color:#4ade80;font-weight:700">¿El portal DGII confirma 21/21 y 4/4?</div>
            <button id="ecf-wz-step2-confirm-btn" class="ecf-wz-action-btn" style="font-size:.82rem;padding:.5rem .9rem"
              onclick="ECF_CERT_WIZARD.runStep2Confirm()">Continuar al Paso 3 →</button>
          </div>
        </div>
      `}
    `;
  }

  function _setStep2ExcelFile(file) {
    const span = document.getElementById('ecf-wz-step2-excel-name');
    if (!span || !file) return;
    span.textContent = `✓ ${file.name}`;
    span.style.color = '#4ade80';
  }

  function _onStep2ExcelChange(input) {
    if (input.files?.[0]) _setStep2ExcelFile(input.files[0]);
  }

  function _onStep2ExcelDrop(files) {
    if (!files?.[0]) return;
    const input = document.getElementById('ecf-wz-step2-excel');
    if (!input) return;
    const dt = new DataTransfer();
    dt.items.add(files[0]);
    input.files = dt.files;
    _setStep2ExcelFile(files[0]);
  }

  function _togglePass(id) {
    const inp = document.getElementById(id);
    if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
  }

  function _unlockStep2() {
    const completed = (WZ.state?.completedSteps || []).filter(s => s < 2);
    WZ.state.completedSteps = completed;
    WZ.activeStep = 2;
    render();
  }

  async function runStep2() {
    const excelInput = document.getElementById('ecf-wz-step2-excel');
    if (!excelInput?.files?.[0]) {
      if (typeof showFiscalToast === 'function') showFiscalToast('Selecciona el Excel del set de datos DGII.', 'warning'); return;
    }

    // Verificar si ya hay docs aceptados o bloqueados antes de sobrescribir
    try {
      const prev = await fiscalApi('GET', '/certification-center/status').catch(() => null);
      if (prev?.counts) {
        const { accepted = 0, blocked = 0, total = 0 } = prev.counts;
        if (total > 0 && (accepted > 0 || blocked > 0)) {
          const ok = confirm(
            `⚠️ ATENCIÓN — Ya hay comprobantes en DGII de una corrida anterior:\n` +
            `• ${accepted} aceptado(s)\n` +
            `• ${blocked} bloqueado(s)\n\n` +
            `Si corres el proceso de nuevo se creará un lote NUEVO con los mismos eNCF.\n` +
            `DGII los rechazará como "secuencia ya utilizada" y quedarán bloqueados.\n\n` +
            `¿Estás seguro de que quieres reiniciar desde cero?`
          );
          if (!ok) return;
        }
      }
    } catch (_) {}

    const alertEl = document.getElementById('ecf-wz-step2-blocked-alert');
    if (alertEl) alertEl.style.display = 'none';
    setBtnState('ecf-wz-step2-process-btn', true, '⏳ Procesando…');
    const logId = 'ecf-wz-step2-log';
    document.getElementById(logId).innerHTML = '';
    function logLine(msg, type='info') { appendLog(logId, msg, type); }

    // Polling independiente cada 4s mientras dura el proceso
    if (WZ._step2PollId) clearInterval(WZ._step2PollId);
    WZ._step2PollId = setInterval(() => _pollStep2(logLine), 4000);

    const form = new FormData();
    form.append('excel', excelInput.files[0]);
    form.append('environment', WZ.state?.environment || 'certecf');

    logLine('Importando set de datos y generando XMLs…');

    // AbortController: si tarda >90s mostramos mensaje pero el backend sigue
    const ctrl = new AbortController();
    const hangTimeout = setTimeout(() => {
      ctrl.abort();
      logLine('⏱ Proceso corriendo en background — usa "Actualizar" para ver progreso.', 'info');
      setBtnState('ecf-wz-step2-process-btn', false, '📤 Procesar y enviar comprobantes →');
    }, 90000);

    try {
      const token = (typeof getStoredAuthToken === 'function' ? getStoredAuthToken() : '') || DB?.authToken || '';
      const userId = DB?.currentUser?.id;
      let url = `/api/ecf/certification-center/process`;
      if (userId) url += `?actorUserId=${userId}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        signal: ctrl.signal,
      });
      clearTimeout(hangTimeout);
      const raw = await res.text();
      const result = raw ? JSON.parse(raw) : {};
      if (!res.ok) {
        const detailText = Array.isArray(result?.details?.errors)
          ? result.details.errors.slice(0, 3).join(' | ')
          : (Array.isArray(result?.details?.results)
            ? result.details.results
                .filter(item => item && item.ok === false)
                .slice(0, 3)
                .map(item => `${item.encf || item.casoPrueba || 'fila'}: ${item.error || 'error'}`)
                .join(' | ')
            : '');
        throw new Error(result.error || result.message || detailText || `HTTP ${res.status}`);
      }
      const counts = result.counts || {};
      const blocked = counts.blocked || 0;
      const rejected = counts.rejected || 0;
      logLine(`Listo: ${counts.accepted||0}/${counts.total||0} aceptados, ${rejected} rechazados, ${blocked} bloqueados.`,
        blocked > 0 || rejected > 0 ? 'warn' : 'ok');
      if (blocked > 0 || rejected > 0) {
        logLine('⚠ Hay documentos con problemas — usa "Resetear y reintentar".', 'err');
        if (alertEl) alertEl.style.display = '';
      } else {
        // Auto-generar y enviar RFCE si los 21 comprobantes están bien
        try {
          logLine('Generando resúmenes RFCE <250Mil…');
          await fiscalApi('POST', '/certification-center/rfce/generate');
          logLine('Enviando RFCE a DGII…');
          const rfceRes = await fiscalApi('POST', '/certification-center/rfce/submit');
          logLine(`RFCE: ${rfceRes.aceptados||0} aceptados, ${rfceRes.rechazados||0} rechazados.`,
            (rfceRes.rechazados||0) > 0 ? 'warn' : 'ok');
        } catch (rfceErr) {
          logLine(`RFCE: ${rfceErr.message}`, 'warn');
        }
      }
    } catch (err) {
      clearTimeout(hangTimeout);
      if (err.name !== 'AbortError') {
        logLine(`Error: ${err.message}`, 'err');
      }
    } finally {
      clearInterval(WZ._step2PollId);
      WZ._step2PollId = null;
      setBtnState('ecf-wz-step2-process-btn', false, '📤 Procesar y enviar comprobantes →');
      _pollStep2();
    }
  }

  async function _pollStep2(logLine) {
    try {
      // 1. Sincronizar estados con DGII (track IDs pendientes)
      fiscalApi('POST', '/certification/poll-statuses').catch(() => {});
      fiscalApi('POST', '/certification-center/rfce/poll').catch(() => {});

      // 2. Leer estado local actualizado
      const [ecfStatus, rfceStatus] = await Promise.all([
        fiscalApi('GET', '/certification-center/status').catch(() => ({ counts: {}, byType: [] })),
        fiscalApi('GET', '/certification-center/rfce/status').catch(() => ({ items: [] })),
      ]);
      await _updateStep2Types(ecfStatus.byType || []);
      const counts = ecfStatus.counts || {};
      const rfceItems = rfceStatus.items || [];
      _updateStep2Counters(counts, rfceItems);
      await _loadStep2ManualDocs([], rfceItems);
      if (logLine) {
        const acc  = counts.accepted || 0;
        const sent = counts.sent     || 0;
        const rej  = counts.rejected || 0;
        const tot  = (counts.total   || 0) - (counts.rfceTotal || 0);
        const parts = [`${acc}/${tot} aceptados`];
        if (sent > 0) parts.push(`${sent} en proceso`);
        if (rej  > 0) parts.push(`${rej} rechazados`);
        logLine(parts.join(' · ') + '…');
      }
      if ((counts.blocked||0) > 0 || (counts.rejected||0) > 0) {
        const alertEl = document.getElementById('ecf-wz-step2-blocked-alert');
        if (alertEl) alertEl.style.display = '';
      }
    } catch (_) {}
  }

  function _updateStep2Counters(counts, rfceItems) {
    const ecfEl       = document.getElementById('ecf-wz-s2-ecf-count');
    const ecfSubEl    = document.getElementById('ecf-wz-s2-ecf-subtitle');
    const ecfProgEl   = document.getElementById('ecf-wz-s2-ecf-progress');

    if (ecfEl) {
      // ECF solamente: excluir RFCE del total para coincidir con DGII (21, no 25)
      const ecfTot  = (counts.total    || 0) - (counts.rfceTotal    || 0);
      const ecfAcc  = (counts.accepted || 0) - (counts.rfceAccepted || 0);
      const ecfSent = counts.sent      || 0;   // enviados / en proceso en DGII
      const ecfRej  = counts.rejected  || 0;
      const allDone = ecfTot > 0 && ecfAcc === ecfTot;
      const inFlight = ecfSent > 0 && !allDone;

      ecfEl.textContent  = ecfTot > 0 ? `${ecfAcc}/${ecfTot}` : `${ecfAcc}/…`;
      ecfEl.style.color  = allDone ? '#4ade80' : ecfAcc > 0 ? '#f59e0b' : 'var(--text)';

      if (ecfSubEl) {
        ecfSubEl.textContent = allDone ? 'Comprobantes Aceptados ✅' : 'Comprobantes Aceptados';
        ecfSubEl.style.color = allDone ? '#4ade80' : 'var(--text3)';
      }
      if (ecfProgEl) {
        if (inFlight) {
          ecfProgEl.style.display = '';
          ecfProgEl.textContent = `⏳ ${ecfSent} enviado(s) a DGII — esperando confirmación…`;
        } else if (ecfRej > 0 && !allDone) {
          ecfProgEl.style.display = '';
          ecfProgEl.style.color = '#f87171';
          ecfProgEl.textContent = `❌ ${ecfRej} rechazado(s) — revisa el log`;
        } else {
          ecfProgEl.style.display = 'none';
        }
      }
    }

    const rfceEl    = document.getElementById('ecf-wz-s2-rfce-count');
    const rfceSubEl = document.getElementById('ecf-wz-s2-rfce-subtitle');
    if (rfceEl && rfceItems) {
      const hasRfceItems = Array.isArray(rfceItems) && rfceItems.length > 0;
      const rfceAcc = hasRfceItems
        ? rfceItems.filter(i => ['aceptado','aceptado_condicional'].includes(String(i.estado||'').toLowerCase())).length
        : Number(counts.rfceAccepted || 0);
      const rfceTot = hasRfceItems
        ? rfceItems.length
        : Number(counts.rfceTotal || 0);
      const rfceDone = rfceTot > 0 && rfceAcc === rfceTot;
      rfceEl.textContent = rfceTot > 0 ? `${rfceAcc}/${rfceTot}` : '0/…';
      rfceEl.style.color = rfceDone ? '#4ade80' : rfceAcc > 0 ? '#f59e0b' : 'var(--text)';
      if (rfceSubEl) {
        rfceSubEl.textContent = rfceDone ? 'Resúmenes de Consumo Aceptados ✅' : 'Resúmenes de Consumo Aceptados';
        rfceSubEl.style.color = rfceDone ? '#4ade80' : 'var(--text3)';
      }

      // Habilitar botón portal cuando haya al menos 1 RFCE aceptado
      const portalBtn = document.getElementById('ecf-wz-step2-portal-btn');
      if (portalBtn) {
        const hasAccepted = rfceAcc > 0;
        portalBtn.disabled = !hasAccepted;
        portalBtn.style.opacity = hasAccepted ? '1' : '.4';
        portalBtn.style.cursor = hasAccepted ? 'pointer' : 'not-allowed';
      }
    }
  }

  async function _updateStep2Types(byType) {
    const box = document.getElementById('ecf-wz-step2-types');
    if (!box) return;
    let data = byType && byType.length ? byType : [];
    if (!data.length) {
      try { const r = await fiscalApi('GET', '/certification-center/status'); data = r.byType || []; } catch (_) {}
    }
    if (!data.length) return;
    box.innerHTML = data.filter(t => !t.isRfce).map(t => {
      const allDone = t.accepted === t.total && t.total > 0;
      const hasErr  = (t.rejected||0) > 0 || (t.blocked||0) > 0;
      const color   = allDone ? '#4ade80' : hasErr ? '#f87171' : 'var(--text2)';
      const icon    = allDone ? '✅' : hasErr ? '❌' : t.sent > 0 ? '⏳' : '⏸';
      return `<div class="ecf-wz-type-cell ${allDone?'all-done':hasErr?'has-error':''}">
        <span style="font-weight:700">Tipo ${h(String(t.tipo).replace('E',''))}</span>
        <span style="font-size:.75rem;color:${color}">${icon} ${t.accepted}/${t.total}</span>
      </div>`;
    }).join('');
  }

  async function _loadStep2ManualDocs(manualItems, rfceItems = []) {
    const rfceList = document.getElementById('ecf-wz-step2-rfce-list');
    const noDataMsg = '<div style="font-size:.78rem;color:var(--text3);padding:.5rem">Sin datos aún — importa el Excel o genera los RFCE.</div>';
    const rfceDisplayItems = (rfceItems && rfceItems.length ? rfceItems : []).slice(0, 4);

    // ── RFCE list (sub-sección A) ─────────────────────────────────────────────
    if (rfceList) {
      if (!rfceDisplayItems.length) { rfceList.innerHTML = noDataMsg; }
      else {
        rfceList.innerHTML = rfceDisplayItems.map((item, i) => {
          const state = String(item.estado || 'pendiente').toLowerCase();
          const accepted = state === 'aceptado' || state === 'aceptado_condicional';
          const color = accepted ? '#4ade80' : state.includes('rechaz') ? '#f87171' : state === 'enviado' ? '#f59e0b' : 'var(--text3)';
          const icon  = accepted ? '✅' : state.includes('rechaz') ? '❌' : state === 'enviado' ? '⏳' : '⏸';
          return `<div class="ecf-wz-doc-row" style="margin-bottom:.3rem">
            <span style="font-size:.74rem;font-weight:700;min-width:62px">${icon} RFCE ${i+1}</span>
            <span style="font-size:.7rem;color:var(--text3);font-family:var(--font-mono);flex:1;overflow:hidden;text-overflow:ellipsis">${h(item.encf||'—')}</span>
            <span style="font-size:.7rem;font-weight:700;color:${color};flex-shrink:0">${state.toUpperCase()}</span>
          </div>`;
        }).join('');
      }
    }
  }

  async function _resetAndRetry2() {
    setBtnState('ecf-wz-step2-reset-btn', true, 'Reseteando…');
    try {
      await fiscalApi('POST', '/certification/reset-sent').catch(() => {});
      await fiscalApi('POST', '/certification/reset-rejected').catch(() => {});
      await fiscalApi('POST', '/certification/run-sequential').catch(() => {});
      const alertEl = document.getElementById('ecf-wz-step2-blocked-alert');
      if (alertEl) alertEl.style.display = 'none';
      appendLog('ecf-wz-step2-log', '✅ Reseteado. Reenvío secuencial iniciado. Usa "Actualizar" para ver progreso.', 'ok');
      setTimeout(() => _pollStep2(), 3000);
    } catch (err) {
      appendLog('ecf-wz-step2-log', `Error: ${err.message}`, 'err');
    } finally {
      setBtnState('ecf-wz-step2-reset-btn', false, '🔄 Resetear y reintentar');
    }
  }

  async function runStep2RfceGenerate() {
    setBtnState('ecf-wz-step2-rfce-gen', true, 'Generando…');
    try {
      const r = await fiscalApi('POST', '/certification-center/rfce/generate');
      appendLog('ecf-wz-step2-log', `RFCE generados y firmados (${(r.items||[]).length} archivos).`, 'ok');
      await _pollStep2();
    } catch (err) { appendLog('ecf-wz-step2-log', `Error RFCE: ${err.message}`, 'err'); }
    finally { setBtnState('ecf-wz-step2-rfce-gen', false, '📋 Generar RFCE'); }
  }

  async function runStep2RfceSend() {
    setBtnState('ecf-wz-step2-rfce-send', true, 'Enviando…');
    try {
      const r = await fiscalApi('POST', '/certification-center/rfce/submit');
      appendLog('ecf-wz-step2-log', `RFCE enviados: ${r.aceptados||0} aceptados.`, 'ok');
      _showPortalE32Result(r);
      await _pollStep2();
    } catch (err) { appendLog('ecf-wz-step2-log', `Error RFCE: ${err.message}`, 'err'); }
    finally { setBtnState('ecf-wz-step2-rfce-send', false, '📤 Enviar RFCE'); }
  }

  async function runStep2RfcePoll() {
    try {
      const r = await fiscalApi('POST', '/certification-center/rfce/poll');
      _showPortalE32Result(r);
      await _pollStep2();
    } catch (_) {}
  }

  async function _resendRfce() {
    const btn = document.getElementById('ecf-wz-s2-rfce-resend-btn');
    const logEl = document.getElementById('ecf-wz-s2-rfce-resend-log');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Enviando…'; }
    if (logEl) logEl.textContent = '';
    try {
      if (logEl) logEl.textContent = 'Generando XMLs…';
      await fiscalApi('POST', '/certification-center/rfce/generate');
      if (logEl) logEl.textContent = 'Enviando a DGII…';
      const r = await fiscalApi('POST', '/certification-center/rfce/submit');
      if (logEl) { logEl.textContent = `✅ ${r.aceptados||0} aceptados, ${r.rechazados||0} rechazados.`; logEl.style.color = (r.rechazados||0) > 0 ? '#f87171' : '#4ade80'; }
      await _pollStep2();
    } catch (err) {
      if (logEl) { logEl.textContent = `❌ ${err.message}`; logEl.style.color = '#f87171'; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔄 Reenviar RFCE'; }
    }
  }

  async function runStep2PreparePortal() {
    setBtnState('ecf-wz-step2-portal-btn', true, 'Preparando…');
    function logLine(msg, type='info') { appendLog('ecf-wz-step2-rfce-log', msg, type); }
    try {
      const result = await fiscalApi('POST', '/certification-center/rfce/prepare-portal');
      if (result.ok && result.portalFiles?.length) {
        logLine(`✅ ${result.portalFiles.length} E32 listos para subir al portal DGII.`, 'ok');
        logLine(`📁 Carpeta: ${result.portalDir}`, 'ok');
        logLine('En el portal DGII → "Facturas de consumo <250Mil": elige cada XML y presiona ENVIAR uno por uno.', 'info');
      } else {
        logLine(`⚠ ${result.message || 'No se pudieron preparar los archivos.'}`, 'warn');
      }
      (result.portalWarnings || []).forEach((w) => {
        logLine(`⚠️ ${w.encf}: ${w.warning}`, 'warn');
      });
    } catch (err) {
      logLine(`Error preparando XML portal: ${err.message}`, 'err');
    } finally {
      setBtnState('ecf-wz-step2-portal-btn', false, '📁 Preparar 4 XML para portal');
    }
  }

  function _showPortalE32Result(r) {
    if (!r) return;
    const portalWarnings = r.portalWarnings || [];
    if (portalWarnings.length > 0) {
      for (const w of portalWarnings) {
        appendLog('ecf-wz-step2-log',
          `⚠️ ${w.encf}: ${w.warning}`,
          'warn');
      }
      appendLog('ecf-wz-step2-log', 'Verifica RFCE con "Generar RFCE", "Enviar RFCE" y "Consultar".', 'warn');
    }
  }

  async function runStep2ForceSync() {
    const reconcilePortalAccepted = confirm(
      '¿El portal DGII CerteCF ya muestra 21/21 comprobantes aceptados y 4/4 resúmenes aceptados?\n\n' +
      'Si respondes Sí, el sistema sincronizará los TrackID disponibles y reconciliará el lote local como aceptado.'
    );
    appendLog(
      'ecf-wz-step2-log',
      reconcilePortalAccepted
        ? '🔄 Sincronizando con DGII — consultando TrackID y reconciliando estado del portal…'
        : '🔄 Sincronizando con DGII — consultando TrackID disponibles…'
    );
    try {
      const r = await fiscalApi('POST', '/certification-center/force-sync', { reconcilePortalAccepted });
      appendLog('ecf-wz-step2-log', `✅ ${r.message || `${r.synced} docs sincronizados.`}`, 'ok');
      await _pollStep2();
    } catch (err) {
      appendLog('ecf-wz-step2-log', `Error: ${err.message}`, 'err');
    }
  }

  async function runStep2SendPending() {
    appendLog('ecf-wz-step2-log', 'Enviando documentos pendientes…');
    try {
      await fiscalApi('POST', '/certification/run-sequential');
      appendLog('ecf-wz-step2-log', '✅ Envío secuencial iniciado. Actualizando estado…', 'ok');
      setTimeout(() => _pollStep2(), 3500);
    } catch (err) {
      appendLog('ecf-wz-step2-log', `Error: ${err.message}`, 'err');
    }
  }

  async function runStep2Confirm() {
    setBtnState('ecf-wz-step2-confirm-btn', true, 'Guardando…');
    try {
      // Sincronizar con DGII antes de guardar
      await fiscalApi('POST', '/certification/poll-statuses').catch(() => {});
      const [ecfStatus, rfceStatus] = await Promise.all([
        fiscalApi('GET', '/certification-center/status').catch(() => ({ counts: {} })),
        fiscalApi('GET', '/certification-center/rfce/status').catch(() => ({ items: [] })),
      ]);
      const rfceItems = rfceStatus.items || [];
      const rfceAcc   = rfceItems.filter(i => ['aceptado','aceptado_condicional'].includes(String(i.estado||'').toLowerCase())).length;
      await markDone(2, {
        ecfAccepted:    ecfStatus.counts?.accepted,
        ecfTotal:       ecfStatus.counts?.total,
        rfceAccepted:   rfceAcc,
      });
    } catch (err) {
      setBtnState('ecf-wz-step2-confirm-btn', false, '✅ Confirmar — todos aceptados en DGII →');
      if (typeof showFiscalToast === 'function') showFiscalToast(`Error: ${err.message}`, 'error');
    }
  }

  // ── Placeholder para pasos aún no implementados ───────────────────────────────
  function renderStepTodo() {
    const step = STEPS[WZ.activeStep - 1] || {};
    return `
      ${stepHeader(WZ.activeStep)}
      <div class="ecf-wz-card" style="text-align:center;padding:2rem">
        <div style="font-size:2.5rem;margin-bottom:.75rem">🔜</div>
        <div style="font-weight:800;font-size:1rem;color:var(--text);margin-bottom:.4rem">${h(step.label)}</div>
        <div style="font-size:.85rem;color:var(--text2);margin-bottom:1.2rem;max-width:400px;margin-left:auto;margin-right:auto">
          Este paso se activará en el wizard cuando llegues a él en el portal DGII. Comparte el screenshot para implementarlo.
        </div>
        <button class="ecf-wz-action-btn secondary" onclick="ECF_CERT_WIZARD._confirmTodoStep()">
          ✅ Marcar como completado manualmente →
        </button>
      </div>
    `;
  }

  async function _confirmTodoStep() {
    await markDone(WZ.activeStep, { manual: true, confirmedAt: new Date().toISOString() });
  }

  async function validateStoredCertificate() {
    try {
      const result = await fiscalApi('POST', '/certificate/validate-stored');
      const vr = result.result || {};
      if (result.ok && typeof showFiscalToast === 'function') {
        showFiscalToast(`Certificado válido hasta ${vr.validTo || '—'}`, 'success');
      } else if (typeof showFiscalToast === 'function') {
        showFiscalToast(`Certificado inválido: ${vr.error || 'Sin detalles'}`, 'error');
      }
    } catch (err) {
      if (typeof showFiscalToast === 'function') showFiscalToast(`Error: ${err.message}`, 'error');
    }
  }

  // ── PASO 3: Pruebas Datos Aprobación Com. (ACECF) ────────────────────────────
  function renderStep3() {
    const completed = isCompleted(3);
    const savedData = WZ.state?.steps?.[3]?.data || {};
    const accepted  = savedData.accepted ?? 0;
    const total     = savedData.total ?? 0;

    return `
      ${stepHeader(3)}

      ${completed ? `
        <div class="ecf-wz-card">
          <div style="background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.25);border-radius:10px;padding:1rem 1.2rem;display:flex;align-items:center;gap:.85rem">
            <span style="font-size:2rem">✅</span>
            <div>
              <div style="font-weight:800;color:#4ade80">Aprobaciones Comerciales enviadas</div>
              <div style="font-size:.78rem;color:var(--text3);margin-top:.2rem">
                ${accepted}/${total} aceptadas · ${h(fmtDateTime(WZ.state?.steps?.[3]?.completedAt))}
              </div>
            </div>
          </div>
          <button class="ecf-wz-action-btn" style="margin-top:.85rem" onclick="ECF_CERT_WIZARD.goToStep(4)">
            Continuar al Paso 4 →
          </button>
        </div>
      ` : `
        <!-- Estado -->
        <div class="ecf-wz-card" style="padding:.9rem 1.1rem">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem;gap:.5rem">
            <div class="ecf-wz-card-title" style="margin:0">📊 Estado actual de las pruebas</div>
          </div>
          <div style="font-size:2rem;font-weight:900;line-height:1;color:${accepted>0?'#4ade80':'var(--text)'}">
            <span id="ecf-wz-step3-status">${accepted > 0 ? `${accepted}/${total}` : '0/11'}</span>
          </div>
          <div style="font-size:.8rem;color:var(--text3);margin-top:.2rem">Aprobaciones comerciales aceptadas</div>
        </div>

        <!-- Drop zone + enviar -->
        <div class="ecf-wz-card" style="padding:.9rem 1.1rem">
          <label id="ecf-wz-step3-file-label"
            style="display:flex;align-items:center;gap:.65rem;min-height:64px;border:2px dashed rgba(99,102,241,.45);border-radius:10px;padding:.7rem 1rem;cursor:pointer;transition:border-color .2s;margin-bottom:.55rem;background:rgba(99,102,241,.04)"
            ondragover="event.preventDefault();this.style.borderColor='#6366f1'"
            ondragleave="this.style.borderColor='rgba(99,102,241,.45)'"
            ondrop="event.preventDefault();this.style.borderColor='rgba(99,102,241,.45)';ECF_CERT_WIZARD._onStep3FileDrop(event.dataTransfer.files)">
            <span style="font-size:1.5rem">📊</span>
            <div>
              <div style="font-size:.83rem;color:var(--text2)">Arrastra el Excel de DGII (Paso 3) aquí, o haz clic para seleccionar</div>
              <div id="ecf-wz-step3-filename" style="font-size:.78rem;color:#93c5fd;margin-top:.15rem">Sin archivo</div>
            </div>
            <input type="file" id="ecf-wz-step3-file" accept=".xlsx,.xls,.ods"
              style="position:absolute;opacity:0;pointer-events:none;width:1px;height:1px"
              onchange="ECF_CERT_WIZARD._onStep3FileChange(this)">
          </label>
          <button id="ecf-wz-step3-btn" class="ecf-wz-action-btn"
            style="font-size:.88rem;padding:.65rem 1rem;width:100%;margin-bottom:.4rem"
            onclick="ECF_CERT_WIZARD.runStep3()">
            ✅ Enviar Aprobaciones Comerciales a DGII →
          </button>
          <div id="ecf-wz-step3-result" style="margin-top:.35rem;display:none"></div>
        </div>

        <!-- Confirmar -->
        <div class="ecf-wz-card" style="border:1px solid rgba(22,163,74,.25);background:rgba(22,163,74,.035);padding:.75rem 1rem">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap">
            <div style="font-size:.82rem;color:#4ade80;font-weight:700">¿El portal DGII confirma todas aceptadas?</div>
            <button class="ecf-wz-action-btn" style="font-size:.82rem;padding:.5rem .9rem"
              onclick="ECF_CERT_WIZARD._confirmStep3()">
              Continuar al Paso 4 →
            </button>
          </div>
        </div>
      `}
    `;
  }

  function _setStep3File(file) {
    const span = document.getElementById('ecf-wz-step3-filename');
    if (!span || !file) return;
    span.textContent = `✓ ${file.name} · ${(file.size/1024).toFixed(0)} KB`;
    span.style.color = '#4ade80';
  }

  function _onStep3FileChange(input) {
    if (input.files?.[0]) _setStep3File(input.files[0]);
  }

  function _onStep3FileDrop(files) {
    if (!files?.[0]) return;
    const input = document.getElementById('ecf-wz-step3-file');
    if (!input) return;
    const dt = new DataTransfer();
    dt.items.add(files[0]);
    input.files = dt.files;
    _setStep3File(files[0]);
  }

  async function runStep3() {
    const fileInput = document.getElementById('ecf-wz-step3-file');
    const resultEl  = document.getElementById('ecf-wz-step3-result');
    if (!fileInput?.files?.[0]) {
      if (typeof showFiscalToast === 'function') showFiscalToast('Selecciona el Excel de Aprobaciones Comerciales descargado del portal DGII.', 'warning');
      return;
    }

    setBtnState('ecf-wz-step3-btn', true, 'Enviando a DGII…');
    if (resultEl) resultEl.style.display = 'none';

    try {
      const form = new FormData();
      form.append('excel', fileInput.files[0]);
      form.append('environment', WZ.state?.environment || 'certecf');
      const result = await fiscalApi('POST', '/certification/aprobacion-comercial/process', form, true);

      const accepted = result.accepted || 0;
      const total    = result.total || (result.results || []).length;
      const isOk     = accepted > 0;
      const results  = result.results || [];

      // Actualizar contador
      const statusEl = document.getElementById('ecf-wz-step3-status');
      if (statusEl) statusEl.innerHTML = `<span style="color:${isOk?'#4ade80':'#f87171'}">${accepted}/${total}</span>`;

      // Detectar si el Excel está desactualizado
      const hasStaleData = results.some((r) =>
        String(r.mensaje || '').toLowerCase().includes('no existe en nuestra colecci') ||
        String(r.mensaje || '').toLowerCase().includes('fechahora') ||
        String(r.mensaje || '').toLowerCase().includes('no es válida')
      );

      if (resultEl) {
        resultEl.style.display = '';
        resultEl.innerHTML = `
          <div style="background:rgba(${isOk?'22,163,74':'220,38,38'},.08);border:1px solid rgba(${isOk?'22,163,74':'220,38,38'},.25);border-radius:8px;padding:.75rem .9rem">
            <div style="font-weight:700;color:${isOk?'#4ade80':'#f87171'};margin-bottom:.5rem">
              ${isOk ? '✅' : '❌'} ${accepted}/${total} Aprobaciones Comerciales ${isOk ? 'aceptadas' : 'con errores'}
            </div>
            ${hasStaleData ? `
              <div style="background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.3);border-radius:6px;padding:.6rem .75rem;margin-bottom:.55rem;font-size:.78rem;color:#fbbf24">
                ⚠ <strong>El Excel está desactualizado.</strong> DGII reinició las pruebas y cambió los datos.
                Ve al portal DGII → Paso 3 → descarga el Excel <strong>más reciente</strong> y sube de nuevo.
              </div>
            ` : ''}
            <div style="display:grid;gap:.3rem">
              ${results.map((r) => `
                <div style="font-size:.77rem;color:${r.ok?'#4ade80':'#f87171'};line-height:1.4">
                  ${r.ok ? '✓' : '✗'} <strong>${h(r.encf || 'N/A')}</strong>
                  ${r.estado ? ` · ${h(r.estado)}` : ''}
                  ${r.trackId ? ` · Track: ${h(r.trackId)}` : ''}
                  ${r.mensaje ? `<br><span style="padding-left:1.1rem;font-size:.72rem;color:${r.ok?'#86efac':'#fca5a5'}">${h(r.mensaje)}</span>` : ''}
                  ${r.error ? `<br><span style="padding-left:1.1rem;font-size:.72rem;color:#fbbf24">${h(r.error)}</span>` : ''}
                </div>
              `).join('')}
            </div>
          </div>
        `;
      }

      // Guardar progreso
      await saveState({
        steps: { ...(WZ.state?.steps || {}), 3: { ...(WZ.state?.steps?.[3] || {}), data: { accepted, total, message: result.message } } }
      });

    } catch (err) {
      if (typeof showFiscalToast === 'function') showFiscalToast(`Error: ${err.message}`, 'error');
    } finally {
      setBtnState('ecf-wz-step3-btn', false, '✅ Enviar Aprobaciones Comerciales a DGII →');
    }
  }

  async function _confirmStep3() {
    const data = WZ.state?.steps?.[3]?.data || {};
    await markDone(3, { accepted: data.accepted || 0, total: data.total || 0, confirmedAt: new Date().toISOString() });
  }

  // ── PASO 4: Pruebas Simulación e-CF ──────────────────────────────────────────
  function renderStep4() {
    const completed = isCompleted(4);
    const savedData = WZ.state?.steps?.[4]?.data || {};
    return `
      ${stepHeader(4)}
      ${completed ? `
        <div class="ecf-wz-card">
          <div style="background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.25);border-radius:10px;padding:1rem;display:flex;align-items:center;gap:.85rem;margin-bottom:.85rem">
            <span style="font-size:2rem">✅</span>
            <div>
              <div style="font-weight:800;color:#4ade80">Comprobantes de simulación aprobados por DGII</div>
              <div style="font-size:.78rem;color:var(--text3);margin-top:.2rem">
                ${h(savedData.accepted||'—')}/${h(savedData.total||'—')} aceptados · ${h(fmtDateTime(WZ.state?.steps?.[4]?.completedAt))}
              </div>
            </div>
          </div>
          <div id="ecf-wz-step4-types-done" class="ecf-wz-types-grid" style="margin-bottom:.85rem">
            <div style="color:var(--text3);font-size:.8rem">Cargando…</div>
          </div>
          <button class="ecf-wz-action-btn" onclick="ECF_CERT_WIZARD.goToStep(5)">
            Ir al Paso 5 →
          </button>
        </div>
      ` : `
        <!-- Estado actual -->
        <div class="ecf-wz-card" style="padding:.9rem 1.1rem">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.7rem;gap:.5rem">
            <div class="ecf-wz-card-title" style="margin:0">📊 Estado actual de las pruebas de simulación</div>
            <button class="ecf-wz-action-btn secondary" style="font-size:.78rem;padding:.35rem .7rem"
              onclick="ECF_CERT_WIZARD._pollStep4()">🔄 Actualizar</button>
          </div>
          <div id="ecf-wz-step4-types" class="ecf-wz-types-grid">
            <div style="color:var(--text3);font-size:.8rem;grid-column:1/-1">Cargando…</div>
          </div>
        </div>

        <!-- IDs requeridos por la lógica JS (ocultos) -->
        <div style="display:none">
          <div id="ecf-wz-step4-blocked-alert">
            <div id="ecf-wz-step4-regen-btn"></div>
            <div class="ecf-wz-log" id="ecf-wz-step4-regen-log"></div>
          </div>
          <div id="ecf-wz-step4-filenames"></div>
          <input id="ecf-wz-step4-fileinput" type="file" accept=".xml,.xlsx,.xls" multiple>
          <div id="ecf-wz-step4-filelist"></div>
          <div class="ecf-wz-log" id="ecf-wz-step4-manual-log"></div>
          <div class="ecf-wz-log" id="ecf-wz-step4-regen-main-log"></div>
          <div class="ecf-wz-log" id="ecf-wz-step4-log"></div>
          <div id="ecf-wz-step4-rfce-list"></div>
          <div id="ecf-wz-step4-rfce-counter"><span id="ecf-wz-step4-rfce-count-text"></span></div>
          <button id="ecf-wz-rfce-gen-btn"></button>
          <button id="ecf-wz-rfce-send-btn"></button>
          <button id="ecf-wz-rfce-poll-btn"></button>
          <button id="ecf-wz-step4-manual-send-btn"></button>
        </div>

        <!-- Dos botones principales -->
        <div class="ecf-wz-card" style="padding:.9rem 1.1rem;display:flex;flex-direction:column;gap:.6rem">
          <button id="ecf-wz-step4-regen-main-btn" class="ecf-wz-action-btn"
            style="background:linear-gradient(135deg,#7c3aed,#4f46e5);font-size:.88rem;padding:.65rem 1rem"
            onclick="ECF_CERT_WIZARD._regenerateWithNewEncfs()">
            🆕 Enviar todos los documentos a DGII
          </button>
          <button id="ecf-wz-portal-btn" class="ecf-wz-action-btn secondary"
            style="font-size:.88rem;padding:.65rem 1rem;opacity:.4;cursor:not-allowed"
            onclick="ECF_CERT_WIZARD._preparePortalFiles()" disabled>
            📁 Generar 4 archivos para el portal
          </button>
          <div class="ecf-wz-log" id="ecf-wz-rfce-log" style="min-height:36px;margin-top:.1rem"></div>
        </div>

        <!-- Confirmar y avanzar -->
        <div class="ecf-wz-card" style="border:1px solid rgba(22,163,74,.25);background:rgba(22,163,74,.035);padding:.75rem 1rem">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap">
            <div style="font-size:.82rem;color:#4ade80;font-weight:700">¿El portal DGII confirma todos los tipos aceptados?</div>
            <button class="ecf-wz-action-btn" style="font-size:.82rem;padding:.5rem .9rem"
              onclick="ECF_CERT_WIZARD._confirmStep4()">
              Continuar al Paso 5 →
            </button>
          </div>
        </div>
      `}
    `;
  }

  function _showBlockedAlert(show) {
    const alert = document.getElementById('ecf-wz-step4-blocked-alert');
    if (alert) alert.style.display = show ? '' : 'none';
  }

  async function runStep4() {
    _showBlockedAlert(false);
    if ((WZ.state?.manualResetSteps || []).includes(4)) {
      await saveState({ manualResetSteps: (WZ.state.manualResetSteps || []).filter((id) => id !== 4) });
    }
    setBtnState('ecf-wz-step4-btn', true, 'Generando simulación…');
    if (document.getElementById('ecf-wz-step4-log'))
      document.getElementById('ecf-wz-step4-log').innerHTML = '';

    function logLine(msg, type='info') { appendLog('ecf-wz-step4-log', msg, type); }

    let pollInterval = null;
    try {
      logLine('Validando certificado P12 almacenado…');
      const certOk = await fiscalApi('POST', '/certificate/validate-stored').catch(() => ({ ok: false }));
      if (!certOk.ok) throw new Error('El certificado almacenado no es válido. Verifica el Paso 1.');

      logLine('Generando set de simulación con nuevas secuencias eNCF…');
      pollInterval = setInterval(() => _pollStep4Status(logLine), 3500);
      const result = await fiscalApi('POST', '/certification-center/simulate/generate');

      if (result.encfMapping?.length) {
        logLine(`Nuevos eNCFs: ${result.encfMapping.slice(0,3).map(m=>`${m.old}→${m.new}`).join(', ')}${result.encfMapping.length>3?' …':''}`, 'info');
      }

      logLine(
        `Generados: ${result.created||0} comprobantes (${result.normal||0} normales, ${result.rfce||0} RFCE) · ${result.sent||0}/${result.normal||0} enviados.`,
        result.errors?.length ? 'warn' : 'ok'
      );

      if (result.errors?.length) {
        result.errors.slice(0,3).forEach(e => logLine(`⚠ ${e}`, 'warn'));
        _showBlockedAlert(true);
      }

      const latestStatus = await _pollStep4Status(logLine);
      if (await _completeStep4IfAccepted(latestStatus, logLine)) return;

      if (result.rfce > 0) {
        logLine(`${result.rfce} RFCE pendientes — usa "Generar RFCE" en la sección de abajo.`, 'info');
      }
    } catch (err) {
      const latestStatus = await fiscalApi('GET', '/certification-center/status').catch(() => null);
      if (await _completeStep4IfAccepted(latestStatus, logLine)) return;
      appendLog('ecf-wz-step4-log', `Error: ${err.message}`, 'err');
      if (typeof showFiscalToast === 'function') showFiscalToast(`Error: ${err.message}`, 'error');
    } finally {
      clearInterval(pollInterval);
      setBtnState('ecf-wz-step4-btn', false, '🚀 Generar simulación automáticamente →');
    }
  }

  async function _rfceGenerate() {
    setBtnState('ecf-wz-rfce-gen-btn', true, 'Generando…');
    function logLine(msg, type='info') { appendLog('ecf-wz-rfce-log', msg, type); }
    try {
      logLine('Generando XMLs de Resúmenes de Factura de Consumo (RFCE)…');
      const result = await fiscalApi('POST', '/certification-center/rfce/generate');
      if (result.ok) {
        logLine(`✅ ${result.generated || result.items?.length || 0} RFCE generados.`, 'ok');
        _renderStep4RfceList(result.items || []);
      } else {
        logLine(`⚠ ${result.message || 'No se pudieron generar los RFCE.'}`, 'warn');
      }
    } catch (err) {
      logLine(`Error: ${err.message}`, 'err');
    } finally {
      setBtnState('ecf-wz-rfce-gen-btn', false, '⚙ Generar RFCE');
    }
  }

  async function _rfceSubmit() {
    setBtnState('ecf-wz-rfce-send-btn', true, 'Enviando…');
    function logLine(msg, type='info') { appendLog('ecf-wz-rfce-log', msg, type); }
    try {
      logLine('Enviando RFCE a DGII vía RecepciónFC…');
      const result = await fiscalApi('POST', '/certification-center/rfce/submit');
      const aceptados = result.aceptados ?? result.results?.filter(r=>r.ok)?.length ?? 0;
      const total = result.enviados ?? result.results?.length ?? 0;
      if (result.ok || aceptados > 0) {
        logLine(`✅ ${aceptados}/${total} RFCE aceptados por DGII.`, 'ok');
      } else {
        logLine(`⚠ ${aceptados}/${total} aceptados. ${result.message || ''}`, 'warn');
      }
      (result.results || []).forEach(r => {
        logLine(`  ${r.ok?'✓':'✗'} ${r.encf||'?'} — ${r.estado||r.error||''}`, r.ok?'ok':'err');
      });
      // Refrescar lista con estado actualizado
      const status = await fiscalApi('GET', '/certification-center/rfce/status').catch(() => ({ items: [] }));
      _renderStep4RfceList(status.items || []);
    } catch (err) {
      logLine(`Error: ${err.message}`, 'err');
    } finally {
      setBtnState('ecf-wz-rfce-send-btn', false, '📡 Enviar RFCE');
    }
  }

  async function _rfcePoll() {
    setBtnState('ecf-wz-rfce-poll-btn', true, 'Consultando…');
    function logLine(msg, type='info') { appendLog('ecf-wz-rfce-log', msg, type); }
    try {
      logLine('Consultando estados de RFCE en DGII…');
      const result = await fiscalApi('POST', '/certification-center/rfce/poll');
      const items = result.items || [];
      const aceptados = result.aceptados ?? items.filter(i => ['aceptado','aceptado_condicional'].includes(String(i.estado||'').toLowerCase())).length;
      const total = items.length;
      _renderStep4RfceList(items);
      logLine(`Estado RFCE: ${aceptados}/${total} aceptados.`, aceptados === total && total > 0 ? 'ok' : 'warn');
    } catch (err) {
      logLine(`Error: ${err.message}`, 'err');
    } finally {
      setBtnState('ecf-wz-rfce-poll-btn', false, '🔄 Consultar');
    }
  }

  function _renderStep4RfceList(items) {
    const listEl    = document.getElementById('ecf-wz-step4-rfce-list');
    const counterEl = document.getElementById('ecf-wz-step4-rfce-counter');
    const countText = document.getElementById('ecf-wz-step4-rfce-count-text');
    if (!listEl) return;
    if (!items || !items.length) {
      listEl.innerHTML = '<div style="font-size:.78rem;color:var(--text3)">Sin datos — genera la simulación y usa los botones.</div>';
      if (counterEl) counterEl.style.display = 'none';
      return;
    }
    const acc = items.filter(i => ['aceptado','aceptado_condicional'].includes(String(i.estado||'').toLowerCase())).length;
    listEl.innerHTML = items.map((item) => {
      const state = String(item.estado || 'pendiente').toLowerCase();
      const accepted = state === 'aceptado' || state === 'aceptado_condicional';
      const rejected = state.includes('rechaz') || state === 'error';
      const color = accepted ? '#4ade80' : rejected ? '#f87171' : state === 'enviado' ? '#f59e0b' : 'var(--text3)';
      const icon  = accepted ? '✅' : rejected ? '❌' : state === 'enviado' ? '⏳' : '○';
      const monto = item.montoTotal ? `RD$ ${Number(item.montoTotal).toLocaleString('es-DO')}` : '';
      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:.5rem;padding:.35rem .5rem;background:rgba(255,255,255,.03);border-radius:6px;border:1px solid rgba(255,255,255,.07)">
        <div style="display:flex;align-items:center;gap:.4rem">
          <span style="font-size:.9rem">${icon}</span>
          <span style="font-size:.8rem;font-weight:600;color:var(--text)">${h(item.encf||'?')}</span>
          ${monto ? `<span style="font-size:.75rem;color:var(--text3)">${monto}</span>` : ''}
        </div>
        <span style="font-size:.75rem;font-weight:600;color:${color}">${h(state)}</span>
      </div>`;
    }).join('');
    if (counterEl && countText) {
      const done = acc === items.length && items.length > 0;
      countText.innerHTML = `<span style="color:${done?'#4ade80':'var(--text2)'};font-weight:700">${acc}/${items.length}</span> RFCE aceptados para portal DGII`;
      counterEl.style.display = '';
    }
  }

  // ── Upload manual de Excel/XMLs para simulación ──────────────────────────────
  let _step4ManualFiles = [];

  function _step4FilesSelected(fileList) {
    _step4ManualFiles = Array.from(fileList || []);
    _renderStep4FileList();
  }
  function _step4FilesDrop(fileList) {
    const ALLOWED = ['.xml', '.xlsx', '.xls'];
    _step4ManualFiles = Array.from(fileList || []).filter(f =>
      ALLOWED.some(ext => f.name.toLowerCase().endsWith(ext))
    );
    _renderStep4FileList();
    document.getElementById('ecf-wz-step4-fileinput').value = '';
  }
  function _renderStep4FileList() {
    const el = document.getElementById('ecf-wz-step4-filelist');
    const nameEl = document.getElementById('ecf-wz-step4-filenames');
    if (nameEl) nameEl.textContent = _step4ManualFiles.length ? `${_step4ManualFiles.length} archivo(s) seleccionado(s)` : '';
    if (!el) return;
    if (!_step4ManualFiles.length) { el.innerHTML = ''; return; }
    el.innerHTML = _step4ManualFiles.map((f, i) => {
      const isExcel = f.name.toLowerCase().endsWith('.xlsx') || f.name.toLowerCase().endsWith('.xls');
      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:.5rem;padding:.3rem .5rem;background:rgba(99,102,241,.06);border-radius:6px;border:1px solid rgba(99,102,241,.2)">
        <div style="display:flex;align-items:center;gap:.4rem">
          <span style="font-size:.85rem">${isExcel ? '📊' : '📄'}</span>
          <span style="font-size:.78rem;color:var(--text)">${h(f.name)}</span>
          <span style="font-size:.72rem;color:var(--text3)">${(f.size/1024).toFixed(1)} KB</span>
          ${isExcel ? '<span style="font-size:.68rem;color:#4ade80;font-weight:600">EXCEL</span>' : ''}
        </div>
        <button onclick="ECF_CERT_WIZARD._step4RemoveFile(${i})" style="background:none;border:none;color:#f87171;cursor:pointer;font-size:.9rem;padding:0 .2rem" title="Quitar">✕</button>
      </div>`;
    }).join('');
  }
  function _step4RemoveFile(index) {
    _step4ManualFiles.splice(index, 1);
    _renderStep4FileList();
  }

  async function _step4ManualSend() {
    if (!_step4ManualFiles.length) {
      appendLog('ecf-wz-step4-manual-log', '⚠ Selecciona tu Excel de simulación primero.', 'warn');
      return;
    }
    setBtnState('ecf-wz-step4-manual-send-btn', true, 'Procesando…');
    function logLine(msg, type='info') { appendLog('ecf-wz-step4-manual-log', msg, type); }
    try {
      const token = (typeof getStoredAuthToken === 'function' ? getStoredAuthToken() : '') || DB?.authToken || '';
      const userId = DB?.currentUser?.id;

      const hasExcel = _step4ManualFiles.some(f => /\.(xlsx|xls)$/i.test(f.name));

      if (hasExcel) {
        // Flujo Excel: importar templates → luego regenerar con nuevos eNCFs
        logLine('Importando Excel y guardando templates de certificación…');
        const formData = new FormData();
        _step4ManualFiles.forEach((f) => formData.append('excel', f, f.name));
        formData.append('forceReset', 'true');
        formData.append('environment', 'certecf');
        formData.append('importOnly', 'true');
        if (userId) formData.append('actorUserId', userId);
        const url = `/api/ecf/certification-center/process${userId ? `?actorUserId=${userId}` : ''}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || result.message || `Error ${res.status}`);
        const tot = result.total || result.imported || result.created || 0;
        logLine(`${tot} templates importados. Asignando nuevos eNCFs y enviando a DGII…`, 'ok');
        _step4ManualFiles = [];
        _renderStep4FileList();
        // Inmediatamente regenerar con nuevos eNCFs para no enviar los eNCFs viejos del Excel
        await _regenerateWithNewEncfs();
        return;
      } else {
        // Flujo XML: firma y envía cada archivo individualmente
        logLine(`Firmando y enviando ${_step4ManualFiles.length} XML(s) a DGII…`);
        const formData = new FormData();
        _step4ManualFiles.forEach((f) => formData.append('files', f, f.name));
        const url = `/api/ecf/certification-center/simulate/manual-send${userId ? `?actorUserId=${userId}` : ''}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || result.message || `Error ${res.status}`);
        logLine(`${result.aceptados}/${result.total} aceptados por DGII.`, result.aceptados === result.total ? 'ok' : 'warn');
        (result.results || []).forEach((r) => {
          logLine(`  ${r.ok?'✅':'❌'} ${r.encf} (Tipo ${r.tipo}) — ${r.estado}${r.mensaje ? ': '+r.mensaje : ''}`, r.ok ? 'ok' : 'err');
        });
      }

      _step4ManualFiles = [];
      _renderStep4FileList();
      setTimeout(() => _pollStep4(), 2000);
    } catch (err) {
      logLine(`Error: ${err.message}`, 'err');
    } finally {
      setBtnState('ecf-wz-step4-manual-send-btn', false, '📡 Importar, firmar y enviar a DGII →');
    }
  }

  async function _preparePortalFiles() {
    setBtnState('ecf-wz-portal-btn', true, 'Preparando…');
    function logLine(msg, type='info') { appendLog('ecf-wz-rfce-log', msg, type); }
    try {
      const result = await fiscalApi('POST', '/certification-center/rfce/prepare-portal');
      if (result.ok && result.portalFiles?.length) {
        logLine(`✅ ${result.portalFiles.length} E32 listos en la carpeta — súbelos al portal DGII uno por uno.`, 'ok');
        logLine(`📁 ${result.portalDir}`, 'ok');
        logLine('Portal DGII → "Facturas de consumo <250Mil" → Browse → ENVIAR (repite para cada uno).', 'info');
        // Mostrar los archivos en el log
        (result.portalFiles || []).forEach((f, i) => {
          logLine(`  ${i+1}. ${f.dgiiFileName || f.encf}`, 'info');
        });
      } else {
        logLine(`⚠ ${result.message || 'No se pudieron preparar los XML para el portal.'}`, 'warn');
      }
      (result.portalWarnings || []).forEach((item) => {
        logLine(`⚠ ${item.encf || ''}: ${item.warning || 'No coincide con RFCE aceptado.'}`, 'warn');
      });
    } catch (err) {
      logLine(`Error preparando XML portal: ${err.message}`, 'err');
    } finally {
      setBtnState('ecf-wz-portal-btn', false, '📁 Generar 4 archivos para el portal');
    }
  }

  async function _confirmStep4() {
    const status = await fiscalApi('GET', '/certification-center/status').catch(() => null);
    const counts = status?.counts || {};
    await markDone(4, {
      accepted: counts.accepted || 0,
      total: counts.total || 0,
      byType: status?.byType || [],
      confirmedAt: new Date().toISOString(),
    });
  }

  function _isStep4FullyAccepted(status) {
    const counts = status?.counts || {};
    const total = Number(counts.total || 0);
    return total > 0
      && Number(counts.accepted || 0) >= total
      && Number(counts.pending || 0) === 0
      && Number(counts.sent || 0) === 0
      && Number(counts.rejected || 0) === 0
      && Number(counts.blocked || 0) === 0;
  }

  async function _completeStep4IfAccepted(status, logLine = null) {
    if ((WZ.state?.manualResetSteps || []).includes(4)) return false;
    if (!_isStep4FullyAccepted(status) || isCompleted(4)) return false;
    const counts = status?.counts || {};
    if (logLine) logLine(`✅ ${counts.accepted}/${counts.total} aceptados. Paso 4 completado.`, 'ok');
    await markDone(4, {
      accepted: counts.accepted || 0,
      total: counts.total || 0,
      byType: status?.byType || [],
      autoCompletedAt: new Date().toISOString(),
    });
    return true;
  }

  async function _regenerateWithNewEncfs() {
    const logEl = document.getElementById('ecf-wz-step4-regen-log');
    const mainLogEl = document.getElementById('ecf-wz-step4-regen-main-log');
    if (logEl) { logEl.style.display = ''; logEl.innerHTML = ''; }
    if (mainLogEl) { mainLogEl.style.display = ''; mainLogEl.innerHTML = ''; }
    function logLine(msg, type='info') {
      appendLog('ecf-wz-step4-regen-log', msg, type);
      appendLog('ecf-wz-step4-regen-main-log', msg, type);
      appendLog('ecf-wz-step4-log', msg, type);
      appendLog('ecf-wz-rfce-log', msg, type);
    }
    setBtnState('ecf-wz-step4-regen-btn', true, 'Regenerando…');
    setBtnState('ecf-wz-step4-regen-main-btn', true, 'Regenerando…');
    try {
      logLine('Borrando documentos anteriores y asignando nuevos eNCFs desde la secuencia…');
      const result = await fiscalApi('POST', '/certification-center/simulate/generate');

      if (result.encfMapping?.length) {
        logLine(`Nuevos eNCFs asignados: ${result.encfMapping.slice(0, 4).map(m => `${m.old}→${m.new}`).join(', ')}${result.encfMapping.length > 4 ? ' …' : ''}`, 'ok');
      }
      logLine(`Comprobantes creados: ${result.created || 0} · Enviados: ${result.sent || 0}/${result.normal || 0}`, result.errors?.length ? 'warn' : 'ok');

      if (result.errors?.length) {
        result.errors.slice(0, 3).forEach(e => logLine(`⚠ ${e}`, 'warn'));
      }

      if ((result.rfce || 0) > 0) {
        logLine(`Generando ${result.rfce} RFCE con los nuevos eNCFs…`);
        const rfceGen = await fiscalApi('POST', '/certification-center/rfce/generate').catch(e => ({ error: e.message }));
        if (rfceGen?.error) {
          logLine(`RFCE generate: ${rfceGen.error}`, 'warn');
        } else {
          logLine(`${rfceGen?.generated || rfceGen?.items?.length || 0} RFCE generados. Enviando a DGII…`);
          const rfceSend = await fiscalApi('POST', '/certification-center/rfce/submit').catch(e => ({ error: e.message }));
          if (rfceSend?.error) {
            logLine(`RFCE submit: ${rfceSend.error}`, 'warn');
          } else {
            const ok = rfceSend?.aceptados ?? rfceSend?.results?.filter(r => r.ok)?.length ?? 0;
            const total = rfceSend?.enviados ?? rfceSend?.results?.length ?? 0;
            logLine(`RFCE: ${ok}/${total} aceptados por DGII.`, ok > 0 ? 'ok' : 'warn');
          }
        }
      }

      _showBlockedAlert(false);
      logLine('Listo. Revisa el portal DGII para confirmar el estado.', 'ok');
      setTimeout(() => _pollStep4(), 2500);
    } catch (err) {
      logLine(`Error: ${err.message}`, 'err');
    } finally {
      setBtnState('ecf-wz-step4-regen-btn', false, '🆕 Regenerar con nuevos eNCFs');
      setBtnState('ecf-wz-step4-regen-main-btn', false, '🆕 Regenerar todos los docs con nuevos eNCFs');
    }
  }

  async function _resetAndRetry4() {
    setBtnState('ecf-wz-step4-rotate-btn', true, 'Reseteando…');
    function logLine(msg, type='info') { appendLog('ecf-wz-step4-log', msg, type); }

    try {
      logLine('Reseteando documentos enviados/rechazados a estado pendiente…');
      await fiscalApi('POST', '/certification/reset-sent').catch(() => {});
      await fiscalApi('POST', '/certification/reset-rejected').catch(() => {});
      logLine('Documentos reseteados. Los eNCFs originales se mantienen intactos.', 'ok');

      logLine('Iniciando envío secuencial…');
      const seqResult = await fiscalApi('POST', '/certification/run-sequential').catch(e => ({ error: e.message }));
      if (seqResult?.error) {
        logLine(`Advertencia: ${seqResult.error}`, 'warn');
      } else {
        logLine(`Enviados: ${seqResult?.sent || 0} en esta ronda.`, 'ok');
      }

      _showBlockedAlert(false);
      setBtnState('ecf-wz-step4-rotate-btn', false, '🔄 Resetear enviados y reintentar');
      logLine('✅ Reiniciado. Usa "Actualizar estados" para seguir el progreso.', 'ok');
      setTimeout(() => _pollStep4(), 3000);
    } catch (err) {
      logLine(`Error: ${err.message}`, 'err');
      setBtnState('ecf-wz-step4-rotate-btn', false, '🔄 Resetear enviados y reintentar');
    }
  }

  async function _pollStep4() {
    try {
      const [result, rfceStatus] = await Promise.all([
        fiscalApi('GET', '/certification-center/status'),
        fiscalApi('GET', '/certification-center/rfce/status').catch(() => ({ items: [] })),
      ]);
      await _updateStep4Types(result.byType || []);
      _renderStep4RfceList(rfceStatus.items || []);
      const counts = result.counts || {};
      const blocked = counts.blocked || 0;
      const rejected = counts.rejected || 0;

      if (blocked > 0 || rejected > 0) {
        _showBlockedAlert(true);
        appendLog('ecf-wz-step4-log',
          `⚠ ${rejected} rechazados${blocked > 0 ? `, ${blocked} bloqueados` : ''} — usa "Resetear enviados y reintentar".`,
          'warn'
        );
        return;
      }
      _showBlockedAlert(false);

      const ecfCases = (result.cases || []).filter(c => String(c.submissionMode||'').toLowerCase() !== 'rfce');
      const ecfAccepted = ecfCases.filter(c => ['aceptado','aceptado_condicional'].includes(String(c.estado||'').toLowerCase())).length;
      if (ecfCases.length > 0 && ecfAccepted === ecfCases.length) {
        appendLog('ecf-wz-step4-log', `✅ Todos los ${ecfAccepted} comprobantes ECF aceptados.`, 'ok');
      }
      await _completeStep4IfAccepted(result, (msg, type) => appendLog('ecf-wz-step4-log', msg, type));
    } catch (_) {}
  }

  async function _pollStep4Status(logLine) {
    try {
      const result = await fiscalApi('GET', '/certification-center/status');
      await _updateStep4Types(result.byType || []);
      const counts = result.counts || {};
      if (logLine) logLine(`Estado: ${counts.accepted||0}/${counts.total||0} aceptados, ${counts.pending||0} pendientes…`);
      return result;
    } catch (_) {}
    return null;
  }

  async function _updateStep4Types(byType) {
    const box = document.getElementById('ecf-wz-step4-types') || document.getElementById('ecf-wz-step4-types-done');
    if (!box) return;

    let data = byType;
    if (!data || !data.length) {
      try {
        const status = await fiscalApi('GET', '/certification-center/status');
        data = status.byType || [];
      } catch (_) { return; }
    }

    if (!data.length) { box.innerHTML = '<div style="color:var(--text3);font-size:.8rem;grid-column:1/-1">Sin datos — importa el set de pruebas primero.</div>'; return; }

    const ecfTypes = data.filter(t => !t.isRfce);
    const rfceTypes = data.filter(t => t.isRfce);

    const cellHtml = (t) => {
      const allDone  = t.accepted === t.total && t.total > 0;
      const hasErr   = (t.rejected || 0) > 0 || (t.blocked || 0) > 0;
      const inFlight = (t.sent || 0) > 0;
      const color    = allDone ? '#4ade80' : hasErr ? '#f87171' : inFlight ? '#fbbf24' : 'var(--text2)';
      const icon     = allDone ? '✅' : hasErr ? '❌' : inFlight ? '⏳' : '⏸';
      const label    = allDone ? `${t.accepted}/${t.total}` : hasErr
        ? `✗ ${(t.rejected||0)+(t.blocked||0)} err.`
        : inFlight ? `${t.sent} env.` : `${t.accepted}/${t.total}`;
      const typeNum  = String(t.tipo||'').replace(/^E/i,'');
      return `<div class="ecf-wz-type-cell ${allDone?'all-done':hasErr?'has-error':''}">
        <span style="font-weight:700">Tipo ${h(typeNum)}${t.isRfce?' RFCE':''}</span>
        <span style="font-size:.78rem;color:${color}">${icon} ${label}</span>
      </div>`;
    };

    box.innerHTML = ecfTypes.map(cellHtml).join('') +
      (rfceTypes.length ? rfceTypes.map(cellHtml).join('') : '');

    // Habilitar botón portal cuando RFCE esté aceptado (significa que los E32 ECF ya existen)
    const rfce = data.find(t => t.isRfce);
    const e32 = data.find(t => String(t.tipo||'').replace(/^E/i,'') === '32' && !t.isRfce);
    const portalBtn = document.getElementById('ecf-wz-portal-btn');
    if (portalBtn) {
      const hasAccepted = (rfce && (rfce.accepted || 0) > 0) || (e32 && (e32.accepted || 0) > 0);
      portalBtn.disabled = !hasAccepted;
      portalBtn.style.opacity = hasAccepted ? '1' : '.4';
      portalBtn.style.cursor = hasAccepted ? 'pointer' : 'not-allowed';
    }
  }

  function initStep4() {
    _updateStep4Types([]);
    fiscalApi('GET', '/certification-center/status').then(r => {
      _updateStep4Types(r.byType || []);
      const c = r.counts || {};
      if ((c.blocked || 0) > 0 || (c.rejected || 0) > 0) _showBlockedAlert(true);
      _completeStep4IfAccepted(r).catch(() => {});
    }).catch(() => {});
  }

  // ── PASO 5: Representación Impresa Simulación ────────────────────────────────
  let _step5Docs = null; // cache de docs por tipo cargados del servidor

  function renderStep5() {
    const completed = isCompleted(5);
    const checked = WZ.state?.steps?.[5]?.data?.checked || {};
    return `
      ${stepHeader(5)}
      ${completed ? `
        <div class="ecf-wz-card">
          <div style="background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.25);border-radius:10px;padding:1rem;display:flex;align-items:center;gap:.85rem">
            <span style="font-size:2rem">✅</span>
            <div>
              <div style="font-weight:800;color:#4ade80">Representaciones impresas confirmadas</div>
              <div style="font-size:.78rem;color:var(--text3);margin-top:.2rem">Completado el ${h(fmtDateTime(WZ.state?.steps?.[5]?.completedAt))}</div>
            </div>
          </div>
          <button class="ecf-wz-action-btn" style="margin-top:.85rem" onclick="ECF_CERT_WIZARD.goToStep(6)">Ir al Paso 6 →</button>
        </div>
      ` : `
        <div class="ecf-wz-card">
          <div class="ecf-wz-card-title">¿Qué necesita DGII?</div>
          <div style="font-size:.82rem;color:var(--text2);line-height:1.7">
            La DGII requiere que subas al portal CerteCF una <strong>captura o PDF de la representación impresa</strong>
            de cada tipo de e-CF. Tecno Caja las genera automáticamente desde los documentos de simulación aceptados.
          </div>
          <div style="background:rgba(108,99,255,.06);border:1px solid rgba(108,99,255,.2);border-radius:8px;padding:.75rem .9rem;font-size:.82rem;color:var(--text2);margin-top:.75rem;line-height:1.6">
            <strong>Flujo:</strong><br>
            1. Descarga el PDF de cada tipo (botón 📄 Descargar PDF)<br>
            2. Súbelo al portal DGII CerteCF en el campo correspondiente<br>
            3. Marca el check ✓ después de subir cada uno<br>
            4. Confirma cuando todos estén subidos
          </div>
        </div>
        <div class="ecf-wz-card">
          <div class="ecf-wz-card-title" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.4rem">
            <span>Tipos de comprobante (11 en total)</span>
            <div style="display:flex;gap:.4rem">
              <a id="ecf-wz-step5-zip-btn"
                href="/api/ecf/print/step5-pdf-bundle"
                download="representaciones-impresas-DGII.zip"
                onclick="ECF_CERT_WIZARD._step5StartZipDownload(this)"
                style="font-size:.75rem;padding:.25rem .65rem;background:rgba(22,163,74,.12);border:1px solid rgba(22,163,74,.35);border-radius:6px;color:#4ade80;text-decoration:none;white-space:nowrap;cursor:pointer;display:inline-flex;align-items:center;gap:.3rem">
                📦 Descargar todos en ZIP
              </a>
              <button class="ecf-wz-action-btn secondary" style="padding:.25rem .65rem;font-size:.75rem;min-width:auto"
                onclick="ECF_CERT_WIZARD._step5LoadDocs()">🔄 Recargar</button>
            </div>
          </div>
          <div id="ecf-wz-step5-list">
            <div style="font-size:.82rem;color:var(--text3);text-align:center;padding:.75rem">Cargando comprobantes…</div>
          </div>
          <div style="display:flex;gap:.65rem;flex-wrap:wrap;margin-top:.75rem">
            <button class="ecf-wz-action-btn secondary" onclick="ECF_CERT_WIZARD._step5CheckAll()">☑️ Marcar todos como subidos</button>
            <button id="ecf-wz-step5-btn" class="ecf-wz-action-btn" onclick="ECF_CERT_WIZARD.runStep5()">
              ✅ Confirmar subidos al portal DGII →
            </button>
          </div>
        </div>
      `}
    `;
  }

  async function _step5LoadDocs() {
    const el = document.getElementById('ecf-wz-step5-list');
    if (!el) return;
    el.innerHTML = '<div style="font-size:.82rem;color:var(--text3);text-align:center;padding:.75rem">Cargando…</div>';
    try {
      const res = await fiscalApi('GET', '/print/step5-docs');
      _step5Docs = res.docs || [];
      _renderStep5List();
    } catch (e) {
      el.innerHTML = `<div style="font-size:.82rem;color:#f87171;padding:.5rem">Error al cargar documentos: ${h(e.message)}</div>`;
    }
  }

  function _renderStep5List() {
    const el = document.getElementById('ecf-wz-step5-list');
    if (!el) return;
    const checked = WZ.state?.steps?.[5]?.data?.checked || {};
    if (!_step5Docs || !_step5Docs.length) {
      el.innerHTML = '<div style="font-size:.82rem;color:#f87171;padding:.5rem">No se encontraron documentos de simulación. Asegúrate de haber completado el Paso 4.</div>';
      return;
    }
    el.innerHTML = `<div style="display:grid;gap:.3rem;margin:.25rem 0">
      ${_step5Docs.map((doc) => {
        const isChecked = !!checked[doc.key];
        return `<div style="display:flex;align-items:center;gap:.6rem;padding:.45rem .5rem;border-radius:7px;background:${isChecked ? 'rgba(22,163,74,.06)' : 'rgba(255,255,255,.02)'}">
          <input type="checkbox" id="step5-chk-${doc.key}" ${isChecked ? 'checked' : ''}
            onchange="ECF_CERT_WIZARD._step5Check('${doc.key}', this.checked)"
            style="width:16px;height:16px;accent-color:var(--accent);cursor:pointer;flex-shrink:0">
          <div style="flex:1;min-width:0">
            <div style="font-size:.82rem;color:var(--text1);font-weight:600">${h(doc.label)}</div>
            <div style="font-size:.73rem;color:var(--text3);font-family:monospace">${h(doc.encf)} <span style="color:${doc.estado==='aceptado'?'#4ade80':'#fbbf24'};font-family:sans-serif;font-size:.7rem">${doc.estado}</span></div>
          </div>
          <div style="display:flex;gap:.4rem;flex-shrink:0">
            <a href="/api/ecf/print/repr-impresa/${encodeURIComponent(doc.encf)}" target="_blank"
              style="font-size:.73rem;padding:.25rem .55rem;background:rgba(108,99,255,.15);border:1px solid rgba(108,99,255,.3);border-radius:5px;color:var(--accent);text-decoration:none;white-space:nowrap"
              title="Ver vista previa en nueva pestaña">
              👁 Ver
            </a>
            <a href="/api/ecf/print/repr-impresa/${encodeURIComponent(doc.encf)}/pdf" download
              style="font-size:.73rem;padding:.25rem .55rem;background:rgba(22,163,74,.1);border:1px solid rgba(22,163,74,.3);border-radius:5px;color:#4ade80;text-decoration:none;white-space:nowrap"
              title="Descargar PDF para subir al portal DGII">
              📄 PDF
            </a>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  }

  function _step5Check(key, value) {
    if (!WZ.state.steps) WZ.state.steps = {};
    if (!WZ.state.steps[5]) WZ.state.steps[5] = { data: {} };
    const checked = { ...(WZ.state.steps[5].data.checked || {}), [key]: value };
    WZ.state.steps[5].data = { ...WZ.state.steps[5].data, checked };
    saveState(WZ.state).catch(() => {});
    // Re-render just the list to update background color
    if (_step5Docs) _renderStep5List();
  }

  function _step5StartZipDownload(el) {
    const orig = el.innerHTML;
    el.innerHTML = '⏳ Generando ZIP…';
    el.style.pointerEvents = 'none';
    el.style.opacity = '0.6';
    setTimeout(() => {
      el.innerHTML = orig;
      el.style.pointerEvents = '';
      el.style.opacity = '';
    }, 15000);
  }

  function _step5CheckAll() {
    if (!WZ.state.steps) WZ.state.steps = {};
    if (!WZ.state.steps[5]) WZ.state.steps[5] = { data: {} };
    const checked = {};
    if (_step5Docs) {
      _step5Docs.forEach((d) => { checked[d.key] = true; });
    } else {
      ['31-normal','32-normal','32-rfce','33-normal','34-normal','41-normal','43-normal','44-normal','45-normal','46-normal','47-normal']
        .forEach((k) => { checked[k] = true; });
    }
    WZ.state.steps[5].data = { ...WZ.state.steps[5].data, checked };
    saveState(WZ.state).catch(() => {});
    if (_step5Docs) _renderStep5List();
    else document.querySelectorAll('[id^="step5-chk-"]').forEach((el) => { el.checked = true; });
  }

  async function runStep5() {
    setBtnState('ecf-wz-step5-btn', true, 'Confirmando…');
    const checked = WZ.state?.steps?.[5]?.data?.checked || {};
    await markDone(5, { confirmed: true, checked, confirmedAt: new Date().toISOString() });
  }

  // ── PASO 6: Validación Repr. Impresa ─────────────────────────────────────────
  function renderStep6val() {
    const completed = isCompleted(6);
    return `
      ${stepHeader(6)}
      ${completed ? `
        <div class="ecf-wz-card">
          <div style="background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.25);border-radius:10px;padding:1rem;display:flex;align-items:center;gap:.85rem">
            <span style="font-size:2rem">✅</span>
            <div>
              <div style="font-weight:800;color:#4ade80">Representación impresa validada por DGII</div>
              <div style="font-size:.78rem;color:var(--text3);margin-top:.2rem">Aprobado el ${h(fmtDateTime(WZ.state?.steps?.[6]?.completedAt))}</div>
            </div>
          </div>
          <button class="ecf-wz-action-btn" style="margin-top:.85rem" onclick="ECF_CERT_WIZARD.goToStep(7)">Ir al Paso 7 →</button>
        </div>
      ` : `
        <div class="ecf-wz-card">
          <div class="ecf-wz-card-title">Esperando validación de DGII</div>
          <div style="font-size:.82rem;color:var(--text2);line-height:1.7;margin-bottom:.85rem">
            La DGII revisará las representaciones impresas subidas en el paso anterior.
            Este proceso puede tomar <strong>1 a 5 días hábiles</strong>.
            Cuando el portal CerteCF muestre el paso en verde (✓), regresa y confirma.
          </div>
          <div style="background:rgba(234,179,8,.08);border:1px solid rgba(234,179,8,.25);border-radius:8px;padding:.75rem .9rem;font-size:.82rem;color:#fbbf24;margin-bottom:.85rem">
            ⏳ Monitorea el portal DGII CerteCF. Cuando el paso 6 esté aprobado, confirma aquí.
          </div>
          <button id="ecf-wz-step6val-btn" class="ecf-wz-action-btn" onclick="ECF_CERT_WIZARD.runStep6val()">
            ✅ DGII aprobó la representación impresa →
          </button>
        </div>
      `}
    `;
  }

  async function runStep6val() {
    setBtnState('ecf-wz-step6val-btn', true, 'Guardando…');
    await markDone(6, { approved: true, approvedAt: new Date().toISOString() });
  }

  // ── PASO 7: URL Servicios Prueba ──────────────────────────────────────────────
  function renderStep7url() {
    const completed = isCompleted(7);
    return `
      ${stepHeader(7)}
      ${completed ? `
        <div class="ecf-wz-card">
          <div style="background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.25);border-radius:10px;padding:1rem;display:flex;align-items:center;gap:.85rem">
            <span style="font-size:2rem">✅</span>
            <div>
              <div style="font-weight:800;color:#4ade80">URLs de servicios de prueba confirmadas</div>
              <div style="font-size:.78rem;color:var(--text3);margin-top:.2rem">Completado el ${h(fmtDateTime(WZ.state?.steps?.[7]?.completedAt))}</div>
            </div>
          </div>
          <button class="ecf-wz-action-btn" style="margin-top:.85rem" onclick="ECF_CERT_WIZARD.goToStep(8)">Ir al Paso 8 →</button>
        </div>
      ` : `
        <div class="ecf-wz-card">
          <div class="ecf-wz-card-title">Instrucciones</div>
          <ol style="font-size:.82rem;color:var(--text2);line-height:1.8;margin:0;padding-left:1.3rem">
            <li>Inicia el <strong>túnel Cloudflare</strong> y copia la URL pública</li>
            <li>En el portal DGII CerteCF, abre el Paso 7 → <strong>"Actualizar URLs de Servicios"</strong></li>
            <li>Ingresa las URLs que aparecen abajo en los campos correspondientes</li>
            <li>Guarda en el portal y luego confirma aquí</li>
          </ol>
        </div>
        <div class="ecf-wz-card">
          <div class="ecf-wz-card-title" style="display:flex;align-items:center;justify-content:space-between">
            <span>URLs de tu sistema</span>
            <button class="ecf-wz-action-btn secondary" style="padding:.25rem .65rem;font-size:.76rem;min-width:auto"
              onclick="ECF_CERT_WIZARD._loadStep7Urls()">🔄 Recargar</button>
          </div>
          <div id="ecf-wz-step7url-urls" style="margin:.5rem 0 .85rem">
            <div style="font-size:.82rem;color:var(--text3);text-align:center">Cargando URLs…</div>
          </div>
          <button id="ecf-wz-step7url-btn" class="ecf-wz-action-btn" onclick="ECF_CERT_WIZARD.runStep7url()">
            ✅ Confirmar URLs actualizadas en portal →
          </button>
        </div>
      `}
    `;
  }

  async function _loadStep7Urls() {
    const el = document.getElementById('ecf-wz-step7url-urls');
    if (!el) return;
    try {
      const cfg = await fiscalApi('GET', '/config');
      const urls = cfg?.dgiiSettings?.publicUrls || {};
      const base = urls.baseUrl || '';
      const items = [
        { label: 'Autenticación (Semilla)', url: urls.semillaUrl || (base ? `${base}/fe/autenticacion/api/semilla` : '') },
        { label: 'Recepción e-CF', url: urls.recepcionUrl || (base ? `${base}/fe/recepcion/api/ecf` : '') },
        { label: 'Aprobación Comercial', url: urls.aprobacionUrl || (base ? `${base}/fe/aprobacioncomercial/api/ecf` : '') },
      ];
      if (!base) {
        el.innerHTML = `
          <div style="background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.25);border-radius:8px;padding:.75rem .9rem;font-size:.82rem;color:#f87171">
            ⚠️ No hay URL base configurada. Configura la URL pública del túnel Cloudflare en Configuración → DGII → URL Base.
          </div>`;
        return;
      }
      el.innerHTML = items.map(item => `
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:.65rem .85rem;margin-bottom:.4rem">
          <div style="font-size:.71rem;color:var(--text3);margin-bottom:.2rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em">${h(item.label)}</div>
          <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
            <code style="font-size:.78rem;color:var(--accent);flex:1;word-break:break-all">${h(item.url || '(sin URL)')}</code>
            ${item.url ? `<button class="ecf-wz-action-btn secondary" style="padding:.2rem .55rem;font-size:.74rem;min-width:auto"
              onclick="ECF_CERT_WIZARD._copyText(${JSON.stringify(item.url)})">📋</button>` : ''}
          </div>
        </div>
      `).join('');
      WZ._step7Urls = urls;
    } catch (err) {
      if (el) el.innerHTML = `<div style="color:#f87171;font-size:.82rem">Error: ${h(err.message)}</div>`;
    }
  }

  function _copyText(text) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        if (typeof showFiscalToast === 'function') showFiscalToast('URL copiada al portapapeles', 'success');
      }).catch(() => {});
    } else {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(ta);
      if (typeof showFiscalToast === 'function') showFiscalToast('URL copiada', 'success');
    }
  }

  async function runStep7url() {
    setBtnState('ecf-wz-step7url-btn', true, 'Confirmando…');
    await markDone(7, { confirmed: true, urls: WZ._step7Urls || {}, confirmedAt: new Date().toISOString() });
  }

  // ── PASO 8: Inicio Prueba Recepción e-CF ──────────────────────────────────────
  function renderStep8recv() {
    const completed = isCompleted(8);
    const recepcionUrl = WZ.state?.steps?.[7]?.data?.urls?.recepcionUrl || '(URL del paso 7 no confirmada)';
    return `
      ${stepHeader(8)}
      ${completed ? `
        <div class="ecf-wz-card">
          <div style="background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.25);border-radius:10px;padding:1rem;display:flex;align-items:center;gap:.85rem">
            <span style="font-size:2rem">✅</span>
            <div>
              <div style="font-weight:800;color:#4ade80">Inicio de prueba de recepción señalado</div>
              <div style="font-size:.78rem;color:var(--text3);margin-top:.2rem">Completado el ${h(fmtDateTime(WZ.state?.steps?.[8]?.completedAt))}</div>
            </div>
          </div>
          <button class="ecf-wz-action-btn" style="margin-top:.85rem" onclick="ECF_CERT_WIZARD.goToStep(9)">Ir al Paso 9 →</button>
        </div>
      ` : `
        <div class="ecf-wz-card">
          <div class="ecf-wz-card-title">Instrucciones</div>
          <ol style="font-size:.82rem;color:var(--text2);line-height:1.8;margin:0;padding-left:1.3rem">
            <li>Verifica que el <strong>túnel Cloudflare esté activo</strong> en esta computadora</li>
            <li>Verifica que <strong>Tecno Caja esté corriendo</strong> (este servidor)</li>
            <li>En el portal DGII CerteCF, haz clic en <strong>"Inicio Prueba de Recepción e-CF"</strong></li>
            <li>DGII enviará e-CF de prueba a tu endpoint — Tecno Caja responderá automáticamente</li>
            <li>Monitorea los documentos recibidos en el Paso 9</li>
          </ol>
        </div>
        <div class="ecf-wz-card">
          <div class="ecf-wz-card-title">Estado del sistema</div>
          <div id="ecf-wz-step8-status" style="margin-bottom:.75rem">
            <div style="font-size:.82rem;color:var(--text3)">Verificando…</div>
          </div>
          <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:.65rem .85rem;margin-bottom:.85rem">
            <div style="font-size:.71rem;color:var(--text3);margin-bottom:.2rem;font-weight:600;text-transform:uppercase">DGII enviará e-CF a tu endpoint:</div>
            <code style="font-size:.78rem;color:var(--accent);word-break:break-all">${h(recepcionUrl)}</code>
          </div>
          <div style="display:flex;gap:.65rem;flex-wrap:wrap">
            <button class="ecf-wz-action-btn secondary" onclick="ECF_CERT_WIZARD._checkStep8Status()">🔄 Verificar servidor</button>
            <button id="ecf-wz-step8-btn" class="ecf-wz-action-btn" onclick="ECF_CERT_WIZARD.runStep8recv()">
              ✅ Inicio de prueba señalado a DGII →
            </button>
          </div>
        </div>
      `}
    `;
  }

  async function _checkStep8Status() {
    const el = document.getElementById('ecf-wz-step8-status');
    if (!el) return;
    try {
      const status = await fiscalApi('GET', '/status');
      const active = status?.checklist?.certificateLoaded && status?.checklist?.emitterConfigured;
      el.innerHTML = `
        <div style="display:flex;align-items:center;gap:.65rem;padding:.6rem .9rem;background:rgba(${active?'22,163,74':'234,179,8'},.08);border:1px solid rgba(${active?'22,163,74':'234,179,8'},.25);border-radius:8px">
          <span style="font-size:1.1rem">${active?'🟢':'🟡'}</span>
          <div>
            <div style="font-weight:700;color:${active?'#4ade80':'#fbbf24'};font-size:.83rem">Servidor: ${active?'LISTO':'CONFIGURACIÓN INCOMPLETA'}</div>
            <div style="font-size:.76rem;color:var(--text3)">
              Ambiente: ${h(status?.environment||'—')} ·
              Certificado: ${status?.checklist?.certificateLoaded?'✅':'❌'} ·
              Emisor: ${status?.checklist?.emitterConfigured?'✅':'❌'}
            </div>
          </div>
        </div>
      `;
    } catch (err) {
      if (el) el.innerHTML = `<div style="color:#f87171;font-size:.82rem">Error al verificar: ${h(err.message)}</div>`;
    }
  }

  async function runStep8recv() {
    setBtnState('ecf-wz-step8-btn', true, 'Guardando…');
    await markDone(8, { startedAt: new Date().toISOString() });
  }

  // ── PASO 9: Recepción e-CF ────────────────────────────────────────────────────
  function renderStep9ecf() {
    const completed = isCompleted(9);
    const savedData = WZ.state?.steps?.[9]?.data || {};
    return `
      ${stepHeader(9)}
      ${completed ? `
        <div class="ecf-wz-card">
          <div style="background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.25);border-radius:10px;padding:1rem;display:flex;align-items:center;gap:.85rem">
            <span style="font-size:2rem">✅</span>
            <div>
              <div style="font-weight:800;color:#4ade80">Prueba de recepción e-CF completada</div>
              <div style="font-size:.78rem;color:var(--text3);margin-top:.2rem">
                ${savedData.received||0} e-CF recibido${savedData.received!==1?'s':''} · Completado el ${h(fmtDateTime(WZ.state?.steps?.[9]?.completedAt))}
              </div>
            </div>
          </div>
          <button class="ecf-wz-action-btn" style="margin-top:.85rem" onclick="ECF_CERT_WIZARD.goToStep(10)">Ir al Paso 10 →</button>
        </div>
      ` : `
        <div class="ecf-wz-card">
          <div class="ecf-wz-card-title">e-CFs recibidos de DGII</div>
          <div style="font-size:.82rem;color:var(--text2);margin-bottom:.75rem">
            DGII está enviando e-CF de prueba. Tecno Caja los recibe y responde automáticamente con el <strong>acuse de recibo (ARECF)</strong>.
          </div>
          <div id="ecf-wz-step9-list" style="min-height:80px;margin-bottom:.85rem">
            <div style="font-size:.82rem;color:var(--text3);text-align:center">Cargando documentos recibidos…</div>
          </div>
          <div style="display:flex;gap:.65rem;flex-wrap:wrap">
            <button class="ecf-wz-action-btn secondary" onclick="ECF_CERT_WIZARD._pollStep9()">🔄 Actualizar lista</button>
            <button id="ecf-wz-step9-btn" class="ecf-wz-action-btn" onclick="ECF_CERT_WIZARD.runStep9ecf()">
              ✅ DGII completó la prueba de recepción →
            </button>
          </div>
        </div>
      `}
    `;
  }

  async function _pollStep9() {
    const el = document.getElementById('ecf-wz-step9-list');
    if (!el) return;
    try {
      const result = await fiscalApi('GET', '/reception/received');
      const items = (result?.items || []).filter(i => i.type === 'recepcion-ecf');
      if (items.length === 0) {
        el.innerHTML = `<div style="font-size:.82rem;color:var(--text3);text-align:center;padding:1rem 0">No se han recibido e-CFs de DGII todavía.<br>Espera a que DGII inicie el envío.</div>`;
        return;
      }
      el.innerHTML = `
        <div style="font-size:.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.04em;margin-bottom:.4rem">
          ${items.length} e-CF recibido${items.length!==1?'s':''} de DGII
        </div>
        ${items.slice(0, 15).map(item => `
          <div style="display:flex;align-items:center;gap:.6rem;padding:.4rem .65rem;background:rgba(22,163,74,.06);border:1px solid rgba(22,163,74,.2);border-radius:6px;margin-bottom:.3rem">
            <span>📥</span>
            <div style="flex:1">
              <div style="font-size:.8rem;font-weight:600;color:#4ade80">${h(item.meta?.encf||'eNCF desconocido')}</div>
              <div style="font-size:.72rem;color:var(--text3)">RNC: ${h(item.meta?.rncEmisor||'—')} · ${h(new Date(item.receivedAt).toLocaleString('es-DO'))}</div>
            </div>
            <span style="font-size:.72rem;color:#4ade80;background:rgba(22,163,74,.15);padding:.1rem .4rem;border-radius:4px">ARECF ✓</span>
          </div>
        `).join('')}
      `;
    } catch (err) {
      if (el) el.innerHTML = `<div style="color:#f87171;font-size:.82rem">Error: ${h(err.message)}</div>`;
    }
  }

  async function runStep9ecf() {
    setBtnState('ecf-wz-step9-btn', true, 'Guardando…');
    const result = await fiscalApi('GET', '/reception/received').catch(() => ({ items: [] }));
    const received = (result?.items || []).filter(i => i.type === 'recepcion-ecf').length;
    await markDone(9, { received, completedAt: new Date().toISOString() });
  }

  // ── PASO 10: Inicio Prueba Recep. ACECF ──────────────────────────────────────
  function renderStep10inicio() {
    const completed = isCompleted(10);
    const aprobacionUrl = WZ.state?.steps?.[7]?.data?.urls?.aprobacionUrl || '(URL del paso 7 no confirmada)';
    return `
      ${stepHeader(10)}
      ${completed ? `
        <div class="ecf-wz-card">
          <div style="background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.25);border-radius:10px;padding:1rem;display:flex;align-items:center;gap:.85rem">
            <span style="font-size:2rem">✅</span>
            <div>
              <div style="font-weight:800;color:#4ade80">Inicio prueba recepción ACECF señalado</div>
              <div style="font-size:.78rem;color:var(--text3);margin-top:.2rem">Completado el ${h(fmtDateTime(WZ.state?.steps?.[10]?.completedAt))}</div>
            </div>
          </div>
          <button class="ecf-wz-action-btn" style="margin-top:.85rem" onclick="ECF_CERT_WIZARD.goToStep(11)">Ir al Paso 11 →</button>
        </div>
      ` : `
        <div class="ecf-wz-card">
          <div class="ecf-wz-card-title">Instrucciones</div>
          <ol style="font-size:.82rem;color:var(--text2);line-height:1.8;margin:0;padding-left:1.3rem">
            <li>Verifica que el <strong>túnel Cloudflare siga activo</strong></li>
            <li>En el portal DGII CerteCF, haz clic en <strong>"Inicio Prueba de Recepción Aprobación Comercial"</strong></li>
            <li>DGII enviará Aprobaciones Comerciales de prueba — Tecno Caja responderá automáticamente</li>
          </ol>
        </div>
        <div class="ecf-wz-card">
          <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:.65rem .85rem;margin-bottom:.85rem">
            <div style="font-size:.71rem;color:var(--text3);margin-bottom:.2rem;font-weight:600;text-transform:uppercase">DGII enviará ACECF a:</div>
            <code style="font-size:.78rem;color:var(--accent);word-break:break-all">${h(aprobacionUrl)}</code>
          </div>
          <button id="ecf-wz-step10-btn" class="ecf-wz-action-btn" onclick="ECF_CERT_WIZARD.runStep10inicio()">
            ✅ Inicio prueba ACECF señalado a DGII →
          </button>
        </div>
      `}
    `;
  }

  async function runStep10inicio() {
    setBtnState('ecf-wz-step10-btn', true, 'Guardando…');
    await markDone(10, { startedAt: new Date().toISOString() });
  }

  // ── PASO 12: URL Servicios Producción ─────────────────────────────────────────
  function renderStep12prod() {
    const completed = isCompleted(12);
    const savedData = WZ.state?.steps?.[12]?.data || {};
    const step7Urls = WZ.state?.steps?.[7]?.data?.urls || {};
    const savedBase = savedData.baseUrl || step7Urls.baseUrl || '';
    return `
      ${stepHeader(12)}
      ${completed ? `
        <div class="ecf-wz-card">
          <div style="background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.25);border-radius:10px;padding:1rem;display:flex;align-items:center;gap:.85rem">
            <span style="font-size:2rem">✅</span>
            <div>
              <div style="font-weight:800;color:#4ade80">URLs de producción confirmadas</div>
              <div style="font-size:.78rem;color:var(--text3);margin-top:.2rem">
                ${h(savedData.baseUrl||'—')} · Completado el ${h(fmtDateTime(WZ.state?.steps?.[12]?.completedAt))}
              </div>
            </div>
          </div>
          <button class="ecf-wz-action-btn" style="margin-top:.85rem" onclick="ECF_CERT_WIZARD.goToStep(13)">Ir al Paso 13 →</button>
        </div>
      ` : `
        <div class="ecf-wz-card">
          <div class="ecf-wz-card-title">Instrucciones</div>
          <div style="font-size:.82rem;color:var(--text2);line-height:1.7;margin-bottom:.85rem">
            Ingresa en el portal DGII CerteCF las <strong>URLs definitivas de producción</strong>.
            Si usas el mismo túnel permanente de Cloudflare que en las pruebas, usa la misma URL base.
          </div>
        </div>
        <div class="ecf-wz-card">
          <div class="ecf-wz-card-title">URL base de tu sistema en producción</div>
          <div style="display:grid;gap:.75rem;margin-bottom:.85rem">
            <div>
              <label style="font-size:.78rem;color:var(--text3);display:block;margin-bottom:.3rem">URL base (sin /fe/...)</label>
              <input id="step12-base-url" type="url" value="${h(savedBase)}"
                placeholder="https://mi-tunel.trycloudflare.com"
                style="width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:.5rem .75rem;color:var(--text);font-size:.83rem;box-sizing:border-box"
                oninput="ECF_CERT_WIZARD._previewStep12()">
            </div>
          </div>
          <div id="step12-preview" style="margin-bottom:.85rem"></div>
          <div style="background:rgba(108,99,255,.06);border:1px solid rgba(108,99,255,.2);border-radius:8px;padding:.7rem .9rem;font-size:.81rem;color:var(--text2);margin-bottom:.85rem">
            💡 El sistema registrará estas 3 URLs en DGII:<br>
            <span style="color:var(--text3);font-size:.77rem">/fe/autenticacion/api/semilla · /fe/recepcion/api/ecf · /fe/aprobacioncomercial/api/ecf</span>
          </div>
          <button id="ecf-wz-step12-btn" class="ecf-wz-action-btn" onclick="ECF_CERT_WIZARD.runStep12prod()">
            ✅ Confirmar URLs de producción registradas en portal →
          </button>
        </div>
      `}
    `;
  }

  function _previewStep12() {
    const input = document.getElementById('step12-base-url');
    const el = document.getElementById('step12-preview');
    if (!input || !el) return;
    const base = String(input.value || '').trim().replace(/\/+$/, '');
    if (!base) { el.innerHTML = ''; return; }
    const paths = ['/fe/autenticacion/api/semilla', '/fe/recepcion/api/ecf', '/fe/aprobacioncomercial/api/ecf'];
    const labels = ['Autenticación', 'Recepción e-CF', 'Aprobación Comercial'];
    el.innerHTML = `<div style="display:grid;gap:.35rem">${paths.map((p, i) => `
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:.5rem .7rem;display:flex;align-items:center;gap:.5rem">
        <div style="flex:1">
          <div style="font-size:.71rem;color:var(--text3);margin-bottom:.1rem">${labels[i]}</div>
          <code style="font-size:.75rem;color:var(--accent);word-break:break-all">${h(base + p)}</code>
        </div>
        <button class="ecf-wz-action-btn secondary" style="padding:.2rem .5rem;font-size:.73rem;min-width:auto"
          onclick="ECF_CERT_WIZARD._copyText(${JSON.stringify(base + p)})">📋</button>
      </div>
    `).join('')}</div>`;
  }

  async function runStep12prod() {
    setBtnState('ecf-wz-step12-btn', true, 'Guardando…');
    const input = document.getElementById('step12-base-url');
    const baseUrl = String(input?.value || '').trim().replace(/\/+$/, '');
    await markDone(12, { baseUrl, confirmedAt: new Date().toISOString() });
  }

  // ── PASO 13: Declaración Jurada ───────────────────────────────────────────────
  function renderStep13decl() {
    const completed = isCompleted(13);
    return `
      ${stepHeader(13)}
      ${completed ? `
        <div class="ecf-wz-card">
          <div style="background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.25);border-radius:10px;padding:1rem;display:flex;align-items:center;gap:.85rem">
            <span style="font-size:2rem">✅</span>
            <div>
              <div style="font-weight:800;color:#4ade80">Declaración jurada firmada y enviada</div>
              <div style="font-size:.78rem;color:var(--text3);margin-top:.2rem">Completado el ${h(fmtDateTime(WZ.state?.steps?.[13]?.completedAt))}</div>
            </div>
          </div>
          <button class="ecf-wz-action-btn" style="margin-top:.85rem" onclick="ECF_CERT_WIZARD.goToStep(14)">Ir al Paso 14 →</button>
        </div>
      ` : `
        <div class="ecf-wz-card">
          <div class="ecf-wz-card-title">Proceso</div>
          <ol style="font-size:.82rem;color:var(--text2);line-height:1.9;margin:0;padding-left:1.3rem">
            <li>En el portal DGII CerteCF, descarga el <strong>XML de Declaración Jurada</strong> que genera DGII</li>
            <li>Súbelo aquí — Tecno Caja lo firmará con tu certificado P12 automáticamente</li>
            <li>Descarga el <strong>XML firmado</strong> que el sistema genera</li>
            <li>Sube ese XML firmado al portal DGII CerteCF para completar el paso</li>
          </ol>
        </div>
        <div class="ecf-wz-card">
          <div class="ecf-wz-card-title">Firmar XML de Declaración Jurada</div>
          <div style="max-width:480px;display:grid;gap:.75rem">
            <label class="ecf-wz-dropzone" for="ecf-wz-decl-input" id="ecf-wz-decl-label">
              <div style="font-size:1.5rem;margin-bottom:.3rem">📄</div>
              <div>Seleccionar XML de Declaración Jurada</div>
              <div style="font-size:.71rem;color:var(--text3);margin-top:.15rem">Descargado del portal DGII CerteCF</div>
            </label>
            <input type="file" id="ecf-wz-decl-input" accept=".xml" style="display:none"
              onchange="ECF_CERT_WIZARD._onDeclFileChange(this)">
            <div id="ecf-wz-decl-result" style="display:none"></div>
            <button id="ecf-wz-step13-sign-btn" class="ecf-wz-action-btn" onclick="ECF_CERT_WIZARD.runStep13Sign()">
              🔐 Firmar y descargar XML firmado →
            </button>
            <button id="ecf-wz-step13-btn" class="ecf-wz-action-btn"
              style="background:var(--bg3);color:var(--text3);cursor:not-allowed" disabled
              onclick="ECF_CERT_WIZARD.runStep13decl()">
              ✅ XML firmado subido al portal DGII →
            </button>
          </div>
        </div>
      `}
    `;
  }

  function _onDeclFileChange(input) {
    const label = document.getElementById('ecf-wz-decl-label');
    if (label && input.files?.[0]) {
      label.classList.add('has-file');
      label.innerHTML = `<div style="font-size:1.2rem">✓</div>
        <div style="font-weight:600">${h(input.files[0].name)}</div>
        <div style="font-size:.71rem;color:var(--text3)">${(input.files[0].size/1024).toFixed(0)} KB · XML</div>`;
    }
  }

  async function runStep13Sign() {
    const fileInput = document.getElementById('ecf-wz-decl-input');
    const resultEl = document.getElementById('ecf-wz-decl-result');
    const confirmBtn = document.getElementById('ecf-wz-step13-btn');
    if (!fileInput?.files?.[0]) {
      if (typeof showFiscalToast === 'function') showFiscalToast('Selecciona el XML de Declaración Jurada primero.', 'warning');
      return;
    }
    setBtnState('ecf-wz-step13-sign-btn', true, 'Firmando…');
    if (resultEl) resultEl.style.display = 'none';
    try {
      const form = new FormData();
      form.append('xml', fileInput.files[0]);
      const result = await fiscalApi('POST', '/wizard/sign-postulation-xml', form, true);
      if (result?.ok && result?.signedXml) {
        const blob = new Blob([result.signedXml], { type: 'application/xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'declaracion-jurada-firmada.xml';
        document.body.appendChild(a); a.click();
        document.body.removeChild(a); URL.revokeObjectURL(url);
        if (resultEl) {
          resultEl.style.display = '';
          resultEl.innerHTML = `
            <div style="background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.25);border-radius:8px;padding:.75rem .9rem">
              <div style="font-weight:700;color:#4ade80;margin-bottom:.3rem">✅ XML firmado y descargado</div>
              <div style="font-size:.79rem;color:var(--text2)">
                Se descargó <strong>declaracion-jurada-firmada.xml</strong>. Súbelo ahora al portal DGII CerteCF.
              </div>
            </div>
          `;
        }
        if (confirmBtn) {
          confirmBtn.disabled = false;
          confirmBtn.style.background = ''; confirmBtn.style.color = ''; confirmBtn.style.cursor = '';
        }
      }
    } catch (err) {
      if (resultEl) {
        resultEl.style.display = '';
        resultEl.innerHTML = `<div style="color:#f87171;font-size:.82rem">Error al firmar: ${h(err.message)}</div>`;
      }
      if (typeof showFiscalToast === 'function') showFiscalToast(`Error al firmar: ${err.message}`, 'error');
    } finally {
      setBtnState('ecf-wz-step13-sign-btn', false, '🔐 Firmar y descargar XML firmado →');
    }
  }

  async function runStep13decl() {
    setBtnState('ecf-wz-step13-btn', true, 'Guardando…');
    await markDone(13, { signed: true, confirmedAt: new Date().toISOString() });
  }

  // ── PASO 14: Verificación Estatus ─────────────────────────────────────────────
  function renderStep14verify() {
    const completed = isCompleted(14);
    return `
      ${stepHeader(14)}
      ${completed ? `
        <div class="ecf-wz-card">
          <div style="background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.25);border-radius:10px;padding:1rem;display:flex;align-items:center;gap:.85rem">
            <span style="font-size:2rem">✅</span>
            <div>
              <div style="font-weight:800;color:#4ade80">Verificación de estatus aprobada por DGII</div>
              <div style="font-size:.78rem;color:var(--text3);margin-top:.2rem">Completado el ${h(fmtDateTime(WZ.state?.steps?.[14]?.completedAt))}</div>
            </div>
          </div>
          <button class="ecf-wz-action-btn" style="margin-top:.85rem" onclick="ECF_CERT_WIZARD.goToStep(15)">
            Ver certificación completada 🎉
          </button>
        </div>
      ` : `
        <div class="ecf-wz-card">
          <div class="ecf-wz-card-title">Última verificación antes de aprobar</div>
          <div style="font-size:.82rem;color:var(--text2);line-height:1.7;margin-bottom:.85rem">
            La DGII verificará que el RNC esté <strong>activo, al día con sus obligaciones fiscales</strong>
            y en condiciones de ser emisor electrónico. Este proceso es automático — puede tomar hasta <strong>24 horas hábiles</strong>.
          </div>
          <div style="background:rgba(234,179,8,.08);border:1px solid rgba(234,179,8,.25);border-radius:8px;padding:.75rem .9rem;font-size:.82rem;color:#fbbf24;margin-bottom:.75rem">
            ⏳ Monitorea el portal DGII CerteCF. Cuando el paso 14 esté en verde, confirma aquí.
          </div>
          <div style="background:rgba(108,99,255,.06);border:1px solid rgba(108,99,255,.2);border-radius:8px;padding:.75rem .9rem;font-size:.82rem;color:var(--text2);margin-bottom:.85rem">
            📋 Asegúrate de que el RNC esté activo en DGII, sin deudas fiscales pendientes.
          </div>
          <button id="ecf-wz-step14-btn" class="ecf-wz-action-btn" onclick="ECF_CERT_WIZARD.runStep14verify()">
            ✅ DGII aprobó la verificación de estatus →
          </button>
        </div>
      `}
    `;
  }

  async function runStep14verify() {
    setBtnState('ecf-wz-step14-btn', true, 'Guardando…');
    await markDone(14, { verified: true, verifiedAt: new Date().toISOString() });
  }

  // ── PASO 6/11: Aprobaciones Comerciales ─────────────────────────────────────────
  function renderStep6() {
    const completed = isCompleted(6);
    const savedData = WZ.state?.steps?.[6]?.data || {};
    return `
      ${stepHeader(6)}
      ${completed ? `
        <div class="ecf-wz-card">
          <div style="background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.25);border-radius:10px;padding:1rem;display:flex;align-items:center;gap:.85rem">
            <span style="font-size:2rem">✅</span>
            <div>
              <div style="font-weight:800;color:#4ade80">Aprobaciones Comerciales enviadas</div>
              <div style="font-size:.78rem;color:var(--text3);margin-top:.2rem">
                ${h(savedData.accepted||'—')}/${h(savedData.total||'—')} aceptadas · ${h(fmtDateTime(WZ.state?.steps?.[6]?.completedAt))}
              </div>
            </div>
          </div>
          <button class="ecf-wz-action-btn" style="margin-top:.85rem" onclick="ECF_CERT_WIZARD.goToStep(7)">
            Ir al Paso 7 →
          </button>
        </div>
      ` : `
        <div class="ecf-wz-card">
          <div class="ecf-wz-card-title">Instrucciones</div>
          <ol style="font-size:.82rem;color:var(--text2);line-height:1.8;margin:0;padding-left:1.3rem">
            <li>Ingresa al portal DGII CerteCF</li>
            <li>Descarga el Excel de <strong>"Aprobaciones Comerciales"</strong></li>
            <li>Súbelo aquí debajo</li>
            <li>El sistema genera y envía las respuestas ACECF automáticamente</li>
          </ol>
        </div>
        <div class="ecf-wz-card">
          <div class="ecf-wz-card-title">Cargar Excel de Aprobaciones</div>
          <div style="max-width:420px;display:grid;gap:.75rem">
            <label class="ecf-wz-dropzone" for="ecf-wz-acecf-input" id="ecf-wz-acecf-label">
              <div style="font-size:1.5rem;margin-bottom:.3rem">📂</div>
              <div>Seleccionar Excel de Aprobaciones Comerciales</div>
              <div style="font-size:.71rem;color:var(--text3);margin-top:.15rem">Descargado del portal DGII</div>
            </label>
            <input type="file" id="ecf-wz-acecf-input" accept=".xlsx,.xls,.ods" style="display:none"
              onchange="ECF_CERT_WIZARD._onAcecfFileChange(this)">
            <div id="ecf-wz-step6-result" style="display:none"></div>
            <button id="ecf-wz-step6-btn" class="ecf-wz-action-btn" onclick="ECF_CERT_WIZARD.runStep6()">
              ✅ Enviar Aprobaciones Comerciales →
            </button>
          </div>
        </div>
      `}
    `;
  }

  function _onAcecfFileChange(input) {
    const label = document.getElementById('ecf-wz-acecf-label');
    if (label && input.files?.[0]) {
      label.classList.add('has-file');
      label.innerHTML = `<div style="font-size:1.2rem">✓</div>
        <div style="font-weight:600">${h(input.files[0].name)}</div>
        <div style="font-size:.71rem;color:var(--text3)">${(input.files[0].size/1024).toFixed(0)} KB</div>`;
    }
  }

  async function runStep6() {
    const fileInput = document.getElementById('ecf-wz-acecf-input');
    const resultEl = document.getElementById('ecf-wz-step6-result');
    if (!fileInput?.files?.[0]) {
      if (typeof showFiscalToast === 'function') showFiscalToast('Selecciona el Excel de Aprobaciones Comerciales.', 'warning');
      return;
    }

    setBtnState('ecf-wz-step6-btn', true, 'Enviando Aprobaciones…');
    if (resultEl) resultEl.style.display = 'none';

    try {
      const form = new FormData();
      form.append('excel', fileInput.files[0]);
      form.append('environment', WZ.state?.environment || 'certecf');
      const result = await fiscalApi('POST', '/certification/aprobacion-comercial/process', form, true);

      const accepted = result.accepted || 0;
      const total = result.total || (result.results||[]).length;
      const isOk = accepted > 0;

      if (resultEl) {
        resultEl.style.display = '';
        resultEl.innerHTML = `
          <div style="background:rgba(${isOk?'22,163,74':'220,38,38'},.08);border:1px solid rgba(${isOk?'22,163,74':'220,38,38'},.25);border-radius:8px;padding:.75rem .9rem">
            <div style="font-weight:700;color:${isOk?'#4ade80':'#f87171'};margin-bottom:.4rem">
              ${isOk?'✅':'❌'} ${accepted}/${total} Aprobaciones Comerciales aceptadas
            </div>
            <div style="display:grid;gap:.3rem">
              ${(result.results||[]).map(r => `
                <div style="font-size:.78rem;color:${r.ok?'#4ade80':'#f87171'}">
                  ${r.ok?'✓':'✗'} ${h(r.encf||'N/A')} ${r.estado?`· ${h(r.estado)}`:''}
                  ${r.mensaje?`· ${h(r.mensaje)}`:''}
                  ${r.error?`<span style="color:#f87171">Error: ${h(r.error)}</span>`:''}
                </div>
              `).join('')}
            </div>
          </div>
        `;
      }

      if (isOk) {
        await markDone(6, { accepted, total, message: result.message });
      } else {
        setBtnState('ecf-wz-step6-btn', false, '✅ Enviar Aprobaciones Comerciales →');
      }
    } catch (err) {
      setBtnState('ecf-wz-step6-btn', false, '✅ Enviar Aprobaciones Comerciales →');
      if (typeof showFiscalToast === 'function') showFiscalToast(`Error: ${err.message}`, 'error');
    }
  }

  // ── PASO 7: Representación Impresa ────────────────────────────────────────────
  function renderStep7() {
    const completed = isCompleted(7);
    return `
      ${stepHeader(7)}
      ${completed ? `
        <div class="ecf-wz-card">
          <div style="background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.25);border-radius:10px;padding:1rem;display:flex;align-items:center;gap:.85rem">
            <span style="font-size:2rem">✅</span>
            <div>
              <div style="font-weight:800;color:#4ade80">Representación Impresa confirmada</div>
              <div style="font-size:.78rem;color:var(--text3);margin-top:.2rem">
                Completado el ${h(fmtDateTime(WZ.state?.steps?.[7]?.completedAt))}
              </div>
            </div>
          </div>
          <button class="ecf-wz-action-btn" style="margin-top:.85rem" onclick="ECF_CERT_WIZARD.goToStep(8)">
            Ver certificación completada 🎉
          </button>
        </div>
      ` : `
        <div class="ecf-wz-card">
          <div class="ecf-wz-card-title">Requisitos DGII para la representación impresa</div>
          <div style="font-size:.82rem;color:var(--text2);line-height:1.8;margin-bottom:.85rem">
            <p style="margin:0 0 .5rem">La representación impresa (RI) es el comprobante en papel o PDF que el comercio entrega al cliente. Debe incluir:</p>
            <div style="display:grid;gap:.3rem">
              ${['eNCF (código del comprobante)', 'RNC del emisor y del comprador', 'Fecha y hora de emisión',
                 'Detalle de artículos/servicios', 'ITBIS desglosado', 'Total pagado',
                 'Código QR DGII (para validación)', 'Nombre del negocio y dirección'].map(r =>
                `<div style="display:flex;align-items:center;gap:.5rem"><span style="color:#4ade80">✓</span>${r}</div>`
              ).join('')}
            </div>
          </div>
          <div style="background:rgba(108,99,255,.06);border:1px solid rgba(108,99,255,.2);border-radius:8px;padding:.75rem .9rem;font-size:.82rem;color:var(--text2);margin-bottom:.85rem">
            💡 Tecno Caja genera automáticamente la representación fiscal con todos los campos requeridos al imprimir cualquier factura e-CF.
          </div>
          <div id="ecf-wz-step7-preview" style="margin-bottom:.85rem"></div>
          <div style="display:flex;gap:.65rem;flex-wrap:wrap">
            <button id="ecf-wz-step7-preview-btn" class="ecf-wz-action-btn secondary" onclick="ECF_CERT_WIZARD.runStep7Preview()">
              🖨️ Ver vista previa de muestra
            </button>
            <button id="ecf-wz-step7-confirm-btn" class="ecf-wz-action-btn" onclick="ECF_CERT_WIZARD.runStep7()">
              ✅ Confirmar representación impresa →
            </button>
          </div>
        </div>
      `}
    `;
  }

  async function runStep7Preview() {
    const previewEl = document.getElementById('ecf-wz-step7-preview');
    if (!previewEl) return;
    setBtnState('ecf-wz-step7-preview-btn', true, 'Cargando vista previa…');
    try {
      const docs = await fiscalApi('GET', '/documents');
      const lastDoc = (docs.documents || docs || []).find(d => d.estado_dgii === 'aceptado' || d.estado_dgii === 'aceptado_condicional');
      if (lastDoc) {
        previewEl.innerHTML = `
          <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:.85rem;font-family:var(--font-mono);font-size:.75rem;color:var(--text2);line-height:1.8">
            <div style="text-align:center;font-weight:700;margin-bottom:.5rem;color:var(--text)">── TECNO CAJA ──</div>
            <div>eNCF: <strong>${h(lastDoc.encf||'—')}</strong></div>
            <div>RNC:  ${h(lastDoc.rnc_emisor||'—')}</div>
            <div>Fecha: ${h(fmtDateTime(lastDoc.created_at||''))}</div>
            <div>Total: ${h(lastDoc.monto_total||'0.00')} DOP</div>
            <div style="text-align:center;margin-top:.5rem;color:var(--accent)">[QR DGII]</div>
          </div>
        `;
      } else {
        previewEl.innerHTML = `<div style="font-size:.8rem;color:var(--text3)">Sin documentos aceptados para mostrar vista previa. Puedes confirmar directamente.</div>`;
      }
    } catch (_) {
      previewEl.innerHTML = `<div style="font-size:.8rem;color:var(--text3)">Vista previa no disponible. Puedes confirmar directamente.</div>`;
    } finally {
      setBtnState('ecf-wz-step7-preview-btn', false, '🖨️ Ver vista previa de muestra');
    }
  }

  async function runStep7() {
    setBtnState('ecf-wz-step7-confirm-btn', true, 'Confirmando…');
    await markDone(7, { confirmed: true, confirmedAt: new Date().toISOString() });
  }

  // ── PASO 8: Certificación Completada ──────────────────────────────────────────
  function renderStep8() {
    const steps = WZ.state?.steps || {};
    const biz = steps[1]?.data || {};
    const cert = steps[2]?.data || {};
    const ecf21 = steps[4]?.data || {};
    const rfce4 = steps[5]?.data || {};
    const acecf = steps[6]?.data || {};
    const env = WZ.state?.environment || 'certecf';
    const envLabel = env === 'certecf' ? 'CerteCF — Certificación' : 'TesteCF — Pruebas';

    return `
      ${stepHeader(8, '🎉')}
      <div class="ecf-wz-done-screen">
        <div class="done-icon">🎉</div>
        <h1>¡Certificación DGII Completada!</h1>
        <p style="color:var(--text2);font-size:.9rem;max-width:480px;margin:.5rem auto 1.5rem;line-height:1.6">
          Tu negocio ha completado exitosamente el proceso de certificación e-CF con la DGII.
          Ahora puedes emitir comprobantes fiscales electrónicos en producción.
        </p>

        <div class="ecf-wz-info-grid" style="max-width:520px;margin:0 auto 1.5rem;text-align:left">
          <div class="ecf-wz-info-cell">
            <div class="info-label">Estado</div>
            <div class="info-val" style="color:#4ade80">✅ APROBADO</div>
          </div>
          <div class="ecf-wz-info-cell">
            <div class="info-label">Ambiente</div>
            <div class="info-val" style="font-size:.82rem">${h(envLabel)}</div>
          </div>
          <div class="ecf-wz-info-cell">
            <div class="info-label">Inicio</div>
            <div class="info-val">${h(fmtDate(WZ.state?.startedAt))}</div>
          </div>
          <div class="ecf-wz-info-cell">
            <div class="info-label">Finalización</div>
            <div class="info-val" style="color:#4ade80">${h(fmtDate(WZ.state?.finishedAt||new Date().toISOString()))}</div>
          </div>
          <div class="ecf-wz-info-cell">
            <div class="info-label">RNC</div>
            <div class="info-val">${h(biz.rnc||'—')}</div>
          </div>
          <div class="ecf-wz-info-cell">
            <div class="info-label">Razón Social</div>
            <div class="info-val" style="font-size:.82rem">${h(biz.razonSocial||'—')}</div>
          </div>
          <div class="ecf-wz-info-cell">
            <div class="info-label">Comprobantes ECF</div>
            <div class="info-val" style="color:#4ade80">${ecf21.accepted||'—'}/${ecf21.total||'—'} aceptados</div>
          </div>
          <div class="ecf-wz-info-cell">
            <div class="info-label">Resúmenes RFCE</div>
            <div class="info-val" style="color:#4ade80">${rfce4.aceptados||4}/4 aceptados</div>
          </div>
          <div class="ecf-wz-info-cell">
            <div class="info-label">Aprobaciones Comerciales</div>
            <div class="info-val" style="color:#4ade80">${acecf.accepted||'—'}/${acecf.total||'—'} enviadas</div>
          </div>
          <div class="ecf-wz-info-cell">
            <div class="info-label">Certificado Digital</div>
            <div class="info-val" style="font-size:.82rem">Válido hasta ${h(cert.validTo||'—')}</div>
          </div>
        </div>

        <div style="display:flex;justify-content:center;gap:.85rem;flex-wrap:wrap">
          <button class="ecf-wz-action-btn secondary" onclick="ECF_CERT_WIZARD._resetWizard()">
            Iniciar nueva certificación
          </button>
        </div>
      </div>

      <!-- Summary of all steps -->
      <div class="ecf-wz-card" style="max-width:100%">
        <div class="ecf-wz-card-title">Resumen del proceso</div>
        <div style="display:grid;gap:.35rem">
          ${STEPS.map(step => {
            const done = isCompleted(step.id);
            const stepData = steps[step.id] || {};
            return `
              <div class="ecf-wz-summary-row">
                <span style="font-size:1rem">${done?'✅':'⏸'}</span>
                <span style="font-weight:600;min-width:180px">Paso ${step.id}: ${h(step.label)}</span>
                <span style="font-size:.76rem;color:var(--text3);flex:1">
                  ${done ? `Completado el ${h(fmtDateTime(stepData.completedAt))}` : 'Pendiente'}
                </span>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  // ── PASO 15: Finalizado — Certificación DGII Aprobada ─────────────────────────
  function renderStep15() {
    const steps = WZ.state?.steps || {};
    const biz   = steps[1]?.data || {};
    const ecf2  = steps[2]?.data || {};
    const ecf4  = steps[4]?.data || {};
    const acecf = steps[11]?.data || {};
    const env   = WZ.state?.environment || 'certecf';
    const envLabel = env === 'certecf' ? 'CerteCF — Certificación' : 'TesteCF — Pruebas';

    return `
      ${stepHeader(15, '🎉')}
      <div class="ecf-wz-done-screen">
        <div class="done-icon">🎉</div>
        <h1>¡Certificación DGII Completada!</h1>
        <p style="color:var(--text2);font-size:.9rem;max-width:480px;margin:.5rem auto 1.5rem;line-height:1.6">
          Tu negocio ha completado exitosamente el proceso de certificación e-CF con la DGII.
          Ahora puedes emitir comprobantes fiscales electrónicos en producción.
        </p>

        <div class="ecf-wz-info-grid" style="max-width:520px;margin:0 auto 1.5rem;text-align:left">
          <div class="ecf-wz-info-cell">
            <div class="info-label">Estado</div>
            <div class="info-val" style="color:#4ade80">✅ APROBADO</div>
          </div>
          <div class="ecf-wz-info-cell">
            <div class="info-label">Ambiente</div>
            <div class="info-val" style="font-size:.82rem">${h(envLabel)}</div>
          </div>
          <div class="ecf-wz-info-cell">
            <div class="info-label">RNC</div>
            <div class="info-val">${h(biz.rnc||'—')}</div>
          </div>
          <div class="ecf-wz-info-cell">
            <div class="info-label">Razón Social</div>
            <div class="info-val" style="font-size:.82rem">${h(biz.razonSocial||'—')}</div>
          </div>
          <div class="ecf-wz-info-cell">
            <div class="info-label">Inicio</div>
            <div class="info-val">${h(fmtDate(WZ.state?.startedAt))}</div>
          </div>
          <div class="ecf-wz-info-cell">
            <div class="info-label">Finalización</div>
            <div class="info-val" style="color:#4ade80">${h(fmtDate(WZ.state?.finishedAt||new Date().toISOString()))}</div>
          </div>
          <div class="ecf-wz-info-cell">
            <div class="info-label">Datos e-CF enviados</div>
            <div class="info-val" style="color:#4ade80">${ecf2.accepted||'—'}/${ecf2.total||'—'} aceptados</div>
          </div>
          <div class="ecf-wz-info-cell">
            <div class="info-label">Simulación e-CF</div>
            <div class="info-val" style="color:#4ade80">${ecf4.accepted||'—'}/${ecf4.total||'—'} aceptados</div>
          </div>
          <div class="ecf-wz-info-cell">
            <div class="info-label">Aprobaciones Comerciales</div>
            <div class="info-val" style="color:#4ade80">${acecf.accepted||acecf.total||'—'} procesadas</div>
          </div>
        </div>

        <!-- Resumen de los 15 pasos -->
        <div class="ecf-wz-card" style="max-width:600px;margin:0 auto 1.5rem;text-align:left">
          <div class="ecf-wz-card-title">Resumen del proceso</div>
          <div style="display:grid;gap:.35rem">
            ${STEPS.map(step => {
              const done = isCompleted(step.id);
              const stepData = steps[step.id] || {};
              return `
                <div class="ecf-wz-summary-row">
                  <span style="font-size:1rem">${done?'✅':'⏸'}</span>
                  <span style="font-weight:600;min-width:200px">Paso ${step.id}: ${h(step.label)}</span>
                  <span style="font-size:.76rem;color:var(--text3);flex:1">
                    ${done ? `Completado el ${h(fmtDateTime(stepData.completedAt))}` : 'Pendiente'}
                  </span>
                </div>
              `;
            }).join('')}
          </div>
        </div>

        <div style="display:flex;justify-content:center;gap:.85rem;flex-wrap:wrap">
          <button class="ecf-wz-action-btn secondary" onclick="ECF_CERT_WIZARD._resetWizard()">
            Iniciar nueva certificación
          </button>
        </div>
      </div>
    `;
  }

  // ── Step initializers (called after render) ────────────────────────────────────
  function initStepHandlers(stepId) {
    if (stepId === 1) initStep1();
    if (stepId === 2) _initStep2();
    if (stepId === 4) initStep4();
    if (stepId === 5 && !isCompleted(5)) _step5LoadDocs();
    if (stepId === 7) _loadStep7Urls();
    if (stepId === 8) _checkStep8Status();
    if (stepId === 9) _pollStep9();
  }

  async function _initStep2() {
    // Carga rápida local sin llamar poll-statuses (evita freeze en apertura)
    try {
      const [ecfStatus, rfceStatus] = await Promise.all([
        fiscalApi('GET', '/certification-center/status').catch(() => ({ counts: {}, byType: [] })),
        fiscalApi('GET', '/certification-center/rfce/status').catch(() => ({ items: [] })),
      ]);
      await _updateStep2Types(ecfStatus.byType || []);
      _updateStep2Counters(ecfStatus.counts || {}, rfceStatus.items || []);
      await _loadStep2ManualDocs([], rfceStatus.items || []);
    } catch (_) {}
  }

  // ── Reset wizard ──────────────────────────────────────────────────────────────
  async function _resetWizard() {
    const ok = typeof showDeleteConfirm === 'function'
      ? await showDeleteConfirm('¿Reiniciar completamente el wizard de certificación? Se borrarán todos los estados locales.')
      : confirm('¿Reiniciar el wizard de certificación? Se borrarán todos los estados locales.');
    if (!ok) return;
    try {
      await fiscalApi('DELETE', '/certification/reset', {});
    } catch (_) {}
    WZ.state = defaultState();
    WZ.activeStep = 1;
    await saveState(WZ.state);
    render();
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  return {
    async init() {
      injectCss();
      await loadState();
      render();
    },

    render,
    goToStep,

    runStep1,
    runStep1Sign,
    runStep1Confirm,
    _onPostXmlChange,
    _onPostXmlDrop,

    // Step 2 — Pruebas de Datos e-CF
    runStep2,
    runStep2Confirm,
    runStep2ForceSync,
    runStep2SendPending,
    runStep2RfceGenerate,
    runStep2RfceSend,
    runStep2RfcePoll,
    runStep2PreparePortal,

    // Step 3 — ACECF
    runStep3,
    _onStep3FileChange,
    _onStep3FileDrop,
    _confirmStep3,

    resetStep,
    _onStep2ExcelChange,
    _onStep2ExcelDrop,
    _resetAndRetry2,
    _pollStep2,
    _resendRfce,

    // Step 4 — Simulación e-CF
    runStep4,
    _pollStep4,
    _regenerateWithNewEncfs,
    _resetAndRetry4,
    _showBlockedAlert,
    _rfceGenerate,
    _rfceSubmit,
    _rfcePoll,
    _preparePortalFiles,
    _confirmStep4,
    initStep4,
    _step4FilesSelected,
    _step4FilesDrop,
    _step4RemoveFile,
    _step4ManualSend,

    // Step 5 — Representación Impresa Simulación
    runStep5,
    _step5Check,
    _step5CheckAll,
    _step5StartZipDownload,
    _step5LoadDocs,

    // Step 6 — Validación Repr. Impresa
    runStep6val,

    // Step 7 — URL Servicios Prueba
    runStep7url,
    _loadStep7Urls,
    _copyText,

    // Step 8 — Inicio Prueba Recepción e-CF
    runStep8recv,
    _checkStep8Status,

    // Step 9 — Recepción e-CF
    runStep9ecf,
    _pollStep9,

    // Step 10 — Inicio Prueba Recep. ACECF
    runStep10inicio,

    // Step 11 — Aprobaciones Comerciales (renderStep6)
    runStep6,
    _onAcecfFileChange,

    // Step 12 — URL Servicios Producción
    runStep12prod,
    _previewStep12,

    // Step 13 — Declaración Jurada
    runStep13Sign,
    runStep13decl,
    _onDeclFileChange,

    // Step 14 — Verificación Estatus
    runStep14verify,

    // Misc
    validateStoredCertificate,
    _confirmTodoStep,
    _unlockStep1,
    _unlockStep2,
    _togglePass,
    _resetWizard,
  };
})();
