'use strict';

/**
 * Tecno Caja Wizard v3.0 — Flujo con selección de escenario por plan
 *
 * MONOCAJA (Plan Básico):
 *   [0(idioma) → 1(estructura) → 2(tipo) → 3(admin) → 4(datos) → 5(impresión) → 6(caja)]
 *
 * MULTICAJA / MULTISUCURSAL — Escenario "nuevo" (Plan Pro/Plus, negocio nuevo):
 *   [0 → 1 → [overlay escenario] → 2(tipo) → 3(admin) → 4(datos+clave de red) → 5(impresión) → 6(caja)]
 *   Mismo flujo que monocaja, pero guarda modo y clave de red.
 *
 * MULTICAJA / MULTISUCURSAL — Escenario "existente" (vincular terminal a red):
 *   [0 → 1 → [overlay escenario] → [overlay auth+clave de red] → 3(asignación) → 5(impresión) → 6(caja)]
 *   Requiere credenciales admin + clave de red del sistema principal.
 */

(function () {

  // ─── Flujos según modo y escenario ───────────────────────────────────────
  const FLOWS = {
    monocaja:      [0, 1, 2, 3, 4, 5, 6],
    // Multi* nuevo: mismo flujo que monocaja (crea negocio desde cero)
    nuevo:         [0, 1, 2, 3, 4, 5, 6],
    // Multi* existente: vincula terminal a red ya existente
    existente:     [0, 1, 3, 5, 6]
  };

  // Etiquetas de los dots por flujo
  const DOT_LABELS = {
    monocaja:  ['Idioma', 'Plan', 'Tipo', 'Admin', 'Datos', 'Impresión', 'Caja'],
    nuevo:     ['Idioma', 'Plan', 'Tipo', 'Admin', 'Datos', 'Impresión', 'Caja'],
    existente: ['Idioma', 'Plan', 'Asignación', 'Impresión', 'Caja']
  };

  // ─── Estado del wizard ────────────────────────────────────────────────────
  const WZ = {
    virtualStep:      0,
    scenario:         null,   // null | 'nuevo' | 'existente'
    authPassed:       false,
    authUser:         null,
    authBranches:     [],
    authCashRegisters:[],
    _creds:           null,
    linkingMode:      false,
    remoteHost:       '',
    remoteProfile:    null,
    selectedBizType:  null,

    get mode() {
      try {
        const raw = (typeof setupWizard !== 'undefined' ? setupWizard.businessStructureMode : null) || 'monocaja';
        if (typeof normalizeBusinessStructureMode === 'function') {
          return normalizeBusinessStructureMode(raw) || 'monocaja';
        }
        const v = String(raw).toLowerCase().trim();
        if (v.includes('sucursal') && v.includes('multi')) return 'multisucursal';
        if (v === 'sucursal') return 'sucursal';
        if (v.includes('multi')) return 'multicaja';
        return 'monocaja';
      } catch (_) { return 'monocaja'; }
    },

    get isMulti() {
      return ['multicaja', 'sucursal', 'multisucursal'].includes(WZ.mode);
    },

    // Cuando es multi* y elige "nuevo negocio", reutiliza flujo monocaja
    get isNewSetup() {
      return WZ.isMulti && WZ.scenario === 'nuevo';
    },

    get flowKey() {
      if (!WZ.isMulti) return 'monocaja';
      if (WZ.scenario === 'nuevo') return 'nuevo';
      if (WZ.scenario === 'existente') return 'existente';
      return 'monocaja'; // fallback mientras no se elige escenario
    },

    get flow() {
      return FLOWS[WZ.flowKey] || FLOWS.monocaja;
    },

    get currentPanel() {
      return WZ.flow[WZ.virtualStep] ?? 0;
    },

    get lastVirtualStep() {
      return WZ.flow.length - 1;
    },

    get modeLabel() {
      const labels = {
        monocaja: 'Plan Básico — Monocaja',
        multicaja: 'Plan Pro — Multicaja',
        sucursal: 'Sucursal',
        multisucursal: 'Plan Plus — Multisucursal'
      };
      return labels[WZ.mode] || 'Monocaja';
    },

    get scenarioPlanBadge() {
      const badges = {
        monocaja: '🟢 Plan Básico',
        multicaja: '🟡 Plan Pro',
        sucursal: '🏬 Sucursal',
        multisucursal: '🔵 Plan Plus'
      };
      return badges[WZ.mode] || '🟢 Plan Básico';
    }
  };

  function getWizardDefaultPrincipalPort() {
    return Number(window.location.port || 3399) || 3399;
  }

  function parseWizardPrincipalHost(value) {
    const raw = String(value || '').trim();
    if (!raw) return { raw: '', host: '', port: getWizardDefaultPrincipalPort(), protocol: 'http:', normalizedBaseUrl: '', warning: '' };
    try {
      const candidate = /^https?:\/\//i.test(raw)
        ? new URL(raw)
        : new URL(`http://${raw}`);
      const host = String(candidate.hostname || '').trim();
      const port = Number(candidate.port || getWizardDefaultPrincipalPort()) || getWizardDefaultPrincipalPort();
      const protocol = candidate.protocol || 'http:';
      const warning = (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host) && /\.1$/.test(host))
        ? `Esta IP parece ser la puerta de enlace del router. Verifica la IP real de la PC principal con ipconfig.`
        : '';
      return {
        raw,
        host,
        port,
        protocol,
        normalizedBaseUrl: host ? `${protocol}//${host}:${port}` : '',
        warning
      };
    } catch (_error) {
      return { raw, host: '', port: getWizardDefaultPrincipalPort(), protocol: 'http:', normalizedBaseUrl: '', warning: '' };
    }
  }

  function buildWizardPrincipalIpExamples(value) {
    const meta = parseWizardPrincipalHost(value);
    const port = Number(meta.port || getWizardDefaultPrincipalPort()) || getWizardDefaultPrincipalPort();
    const host = String(meta.host || '').trim();
    const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
    const isPrivateLan = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host);

    const fallbackCorrect = [
      `192.168.1.25:${port}`,
      `10.0.0.25:${port}`,
      `172.16.0.25:${port}`
    ];
    const fallbackIncorrect = [
      `192.168.1.1:${port}`,
      `10.0.0.1:${port}`,
      `172.16.0.1:${port}`
    ];

    if (!isIpv4 || !isPrivateLan) {
      return {
        correctExamples: fallbackCorrect,
        incorrectExamples: fallbackIncorrect
      };
    }

    const parts = host.split('.');
    const goodLastOctet = parts[3] === '1' ? '25' : parts[3];
    return {
      correctExamples: [`${parts[0]}.${parts[1]}.${parts[2]}.${goodLastOctet}:${port}`],
      incorrectExamples: [`${parts[0]}.${parts[1]}.${parts[2]}.1:${port}`]
    };
  }

  function refreshWizardPrincipalHostExamples(value = '') {
    const hostInput = document.getElementById('wz-auth-host');
    const hintEl = document.getElementById('wz-auth-host-hint');
    const correctEl = document.getElementById('wz-auth-help-correct');
    const incorrectEl = document.getElementById('wz-auth-help-incorrect');
    const examples = buildWizardPrincipalIpExamples(value || hostInput?.value || WZ.remoteHost || '');
    const correctLabel = examples.correctExamples.map((item) => `<strong>${item}</strong>`).join(', ');
    const incorrectLabel = examples.incorrectExamples.map((item) => `<strong>${item}</strong>`).join(' o ');

    if (hintEl) {
      hintEl.textContent = 'Escribe la Dirección IPv4 real de la PC principal. Puede ser 192.168.x.x, 10.x.x.x o 172.16-31.x.x. No uses la puerta de enlace del router.';
    }
    if (correctEl) {
      correctEl.innerHTML = `Correcto: ${correctLabel}`;
    }
    if (incorrectEl) {
      incorrectEl.innerHTML = `Incorrecto: ${incorrectLabel} si esa IP es el router.`;
    }
  }

  function showAuthWarning(msg = '') {
    const el = document.getElementById('wz-auth-host-warning');
    if (!el) return;
    if (!msg) {
      el.textContent = '';
      el.classList.add('wz-hidden');
      return;
    }
    el.textContent = msg;
    el.classList.remove('wz-hidden');
  }

  function showAuthOk(msg = '') {
    const okEl = document.getElementById('wz-auth-ok');
    const okText = document.getElementById('wz-auth-ok-text');
    if (!okEl || !okText) return;
    okText.textContent = msg || 'Conexión establecida con la PC principal.';
    okEl.classList.remove('wz-hidden');
  }

  // ─── CSS ──────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('wz-ext-styles')) return;
    const s = document.createElement('style');
    s.id = 'wz-ext-styles';
    s.textContent = `
      .setup-card { position: relative; overflow: hidden; }

      /* Overlay auth y escenario */
      .wz-auth-overlay {
        position: absolute; inset: 0;
        background: var(--card-bg, #10162a);
        z-index: 40; padding: 2rem 2.2rem 1.8rem;
        display: flex; flex-direction: column; justify-content: center;
        overflow-y: auto;
        animation: wzFadeIn .22s ease forwards;
      }
      .wz-auth-overlay.wz-hidden { display: none !important; }
      @keyframes wzFadeIn {
        from { opacity:0; transform:translateY(10px); }
        to   { opacity:1; transform:translateY(0); }
      }
      .wz-auth-icon-wrap { text-align:center; font-size:2.6rem; margin-bottom:.7rem; }
      .wz-auth-overlay > h3 { font-size:1.28rem; font-weight:700; color:var(--text1,#f0f0f0); margin:0 0 .35rem; text-align:center; }
      .wz-auth-overlay > p  { color:var(--text2,#a0b0c0); font-size:.87rem; line-height:1.55; text-align:center; margin:0 0 1.1rem; }
      .wz-auth-badge {
        display:block; background:rgba(108,92,231,.15); border:1px solid rgba(108,92,231,.4);
        color:#b2a5ff; font-size:.76rem; font-weight:700; letter-spacing:.04em;
        padding:4px 14px; border-radius:20px; text-align:center;
        width:fit-content; margin:0 auto 1.3rem;
      }
      .wz-auth-error {
        background:rgba(214,48,49,.12); border:1px solid rgba(214,48,49,.32);
        color:#ff7675; font-size:.83rem; padding:9px 13px; border-radius:8px;
        margin-top:.75rem; line-height:1.45;
      }
      .wz-auth-warning {
        background:rgba(253,203,110,.12); border:1px solid rgba(253,203,110,.35);
        color:#f6c453; font-size:.8rem; padding:9px 13px; border-radius:8px;
        margin-top:.75rem; line-height:1.45;
      }
      .wz-auth-ok {
        background:rgba(0,184,148,.12); border:1px solid rgba(0,184,148,.32);
        color:#00cec9; font-size:.83rem; padding:9px 13px; border-radius:8px;
        margin-top:.75rem; display:flex; align-items:center; gap:8px;
      }
      .wz-auth-help-panel {
        display:flex; flex-direction:column; gap:.28rem;
        background:rgba(9,132,227,.08); border:1px solid rgba(9,132,227,.22);
        color:var(--text2,#a0b0c0); font-size:.79rem; line-height:1.5;
        border-radius:10px; padding:.85rem .95rem; margin-top:.85rem;
      }
      .wz-auth-help-panel code {
        background:rgba(15,23,42,.36); color:#dfe6ff; padding:.08rem .3rem; border-radius:6px;
        font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      .wz-auth-error.wz-hidden, .wz-auth-ok.wz-hidden, .wz-auth-warning.wz-hidden, .wz-auth-help-panel.wz-hidden { display:none; }
      .wz-linking-banner {
        background:rgba(9,132,227,.1); border:1px solid rgba(9,132,227,.28);
        color:#74b9ff; font-size:.82rem; padding:9px 13px; border-radius:8px;
        margin-top:1rem; display:flex; align-items:flex-start; gap:8px; line-height:1.45;
      }
      .wz-linking-banner.wz-hidden { display:none; }

      /* Botones de escenario */
      #wz-scenario-btn-nuevo:hover  { border-color:rgba(108,92,231,.7) !important; }
      #wz-scenario-btn-existente:hover { border-color:rgba(9,132,227,.6) !important; }

      /* Cards de tipo de negocio */
      .setup-biztype-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
        gap: .75rem;
        margin-top: .5rem;
      }
      .setup-biztype-grid .setup-choice-card {
        display: flex; flex-direction: column; align-items: center;
        gap: .35rem; padding: 1rem .75rem; text-align: center;
        background: var(--card2-bg, rgba(255,255,255,.04));
        border: 2px solid transparent; border-radius: 12px; cursor: pointer;
        transition: border-color .18s, background .18s;
      }
      .setup-biztype-grid .setup-choice-card:hover {
        border-color: var(--accent, #6c5ce7);
        background: rgba(108,92,231,.08);
      }
      .setup-biztype-grid .setup-choice-card.selected {
        border-color: var(--accent, #6c5ce7);
        background: rgba(108,92,231,.14);
      }
      .setup-biztype-grid .setup-choice-card .choice-icon { font-size:1.8rem; }
      .setup-biztype-grid .setup-choice-card strong { font-size:.85rem; color:var(--text1,#f0f0f0); }
      .setup-biztype-grid .setup-choice-card span:not(.choice-icon) { font-size:.75rem; color:var(--text3,#7a8a9a); line-height:1.4; }

      /* Grid estructura más grande */
      .setup-structure-grid-full {
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      }

      /* Chip usuario autorizado */
      #wz-assign-user-chip {
        align-items:center; gap:10px;
        background:rgba(9,132,227,.08); border:1px solid rgba(9,132,227,.22);
        border-radius:8px; padding:9px 13px; margin-bottom:1rem;
        font-size:.84rem; color:var(--text2,#a0b0c0);
      }
      #wz-assign-user-chip strong { color:var(--text1,#f0f0f0); }

      /* Dots modo existente (5 pasos) — ocultar los exclusivos de nuevo/monocaja */
      .setup-steps.wz-mode-existente .wz-dot-monocaja { display: none !important; }
    `;
    document.head.appendChild(s);
  }

  // ─── Gestión de paneles ───────────────────────────────────────────────────
  function showPanel(panelIndex) {
    document.querySelectorAll('.setup-step-panel').forEach((el, i) => {
      el.classList.toggle('active', i === panelIndex);
    });
    if (panelIndex === 2) syncBizTypeSelection();
    if (typeof setupWizard !== 'undefined') setupWizard.step = panelIndex;
  }

  function syncBizTypeSelection() {
    const container = document.getElementById('setup-biztype-options');
    if (!container) return null;

    const selectedValue = WZ.selectedBizType || (typeof setupWizard !== 'undefined' ? setupWizard.businessType : null);
    let selectedCard = null;
    if (selectedValue) {
      selectedCard = container.querySelector(`.setup-choice-card[data-biztype="${selectedValue}"]`);
    }
    if (!selectedCard) {
      selectedCard = container.querySelector('.setup-choice-card.selected') || container.querySelector('.setup-choice-card.active');
    }
    if (!selectedCard) return null;

    container.querySelectorAll('.setup-choice-card').forEach((card) => {
      card.classList.toggle('selected', card === selectedCard);
    });

    WZ.selectedBizType = selectedCard.dataset?.biztype || null;
    if (WZ.selectedBizType && typeof setupWizard !== 'undefined') {
      setupWizard.businessType = WZ.selectedBizType;
    }
    return WZ.selectedBizType;
  }

  function updateButtons() {
    const isFirst = WZ.virtualStep === 0;
    const isLast  = WZ.virtualStep === WZ.lastVirtualStep;
    const back   = document.getElementById('setup-back-btn');
    const next   = document.getElementById('setup-next-btn');
    const finish = document.getElementById('setup-finish-btn');
    if (back)   back.disabled = isFirst;
    if (next)   next?.classList.toggle('hidden', isLast);
    if (finish) finish?.classList.toggle('hidden', !isLast);
  }

  function updateDots() {
    const stepsEl = document.getElementById('setup-steps');
    const dots    = stepsEl?.querySelectorAll('.setup-step-dot');
    if (!dots?.length) return;

    const isExistente = WZ.isMulti && WZ.scenario === 'existente';
    stepsEl.classList.toggle('wz-mode-existente', isExistente);

    const labels = DOT_LABELS[WZ.flowKey] || DOT_LABELS.monocaja;
    const visibleDots = Array.from(dots).filter(d => !isExistente || !d.classList.contains('wz-dot-monocaja'));
    visibleDots.forEach((dot, i) => {
      dot.classList.toggle('active', i === WZ.virtualStep);
      if (labels[i]) dot.textContent = `${i + 1}. ${labels[i]}`;
    });
  }

  function refreshUI() {
    showPanel(WZ.currentPanel);
    updateButtons();
    updateDots();

    // Panel 3: alternar vista monocaja/nuevo vs existente
    if (WZ.currentPanel === 3) {
      const showMultiView = WZ.isMulti && WZ.scenario === 'existente';
      document.getElementById('setup-step2-monocaja')?.style?.setProperty('display', showMultiView ? 'none' : '');
      document.getElementById('setup-step2-multi')?.style?.setProperty('display', showMultiView ? 'block' : 'none');
    }

    // Panel 4: mostrar campo clave de red solo para multi* nuevo
    const netKeyGroup = document.getElementById('setup-netkey-group');
    if (netKeyGroup) netKeyGroup.style.display = WZ.isNewSetup ? 'block' : 'none';
  }

  // ─── Validación por panel ─────────────────────────────────────────────────
  function validatePanel(panelIndex) {
    const toast = (msg) => { if (typeof showToast === 'function') showToast(msg, 'warning'); };

    switch (panelIndex) {
      case 1: {
        const sel = document.querySelector('#setup-structure-options .setup-choice-card.active')
                 || document.querySelector('#setup-structure-options .setup-choice-card.selected');
        if (!sel?.dataset?.value) { toast('Selecciona un plan de operación.'); return false; }
        break;
      }
      case 2: {
        if (!WZ.selectedBizType && !syncBizTypeSelection()) {
          toast('Selecciona el tipo de negocio.'); return false;
        }
        break;
      }
      case 3: {
        if (WZ.isMulti && WZ.scenario === 'existente') {
          const bId  = document.getElementById('wz-assign-branch')?.value;
          const crId = document.getElementById('wz-assign-register')?.value;
          if (!bId || !crId) { toast('Selecciona sucursal y caja para continuar.'); return false; }
        } else {
          const name = document.getElementById('setup-admin-name')?.value?.trim();
          const user = document.getElementById('setup-admin-user')?.value?.trim();
          const pass = document.getElementById('setup-admin-pass')?.value?.trim();
          const needPass = !hasGoogleSetupAuth();
          if (!name || !user || (needPass && !pass)) {
            toast('Completa los datos del administrador.'); return false;
          }
        }
        break;
      }
      case 4: {
        const name = document.getElementById('setup-business-name')?.value?.trim();
        if (!name) { toast('Escribe el nombre del negocio.'); return false; }
        if (WZ.isNewSetup) {
          const nk = document.getElementById('setup-network-key')?.value?.trim();
          if (!nk || nk.length < 6) {
            toast('La clave de red debe tener al menos 6 caracteres.'); return false;
          }
        }
        break;
      }
    }
    return true;
  }

  function hasGoogleSetupAuth() {
    return !!(typeof setupWizard !== 'undefined' && setupWizard.googleAuth?.idToken);
  }

  // ─── Leer estructura seleccionada ─────────────────────────────────────────
  function readSelectedStructure() {
    const sel = document.querySelector('#setup-structure-options .setup-choice-card.active')
             || document.querySelector('#setup-structure-options .setup-choice-card.selected');
    return sel?.dataset?.value || null;
  }

  function shouldUseRemotePrincipalFlow() {
    return WZ.isMulti && WZ.scenario === 'existente' && !WZ.linkingMode;
  }

  // ─── Scenario overlay ─────────────────────────────────────────────────────
  function $scenarioOverlay() { return document.getElementById('wz-scenario-overlay'); }

  function showScenarioOverlay() {
    injectStyles();
    const overlay = $scenarioOverlay();
    if (!overlay) return;

    const badge = document.getElementById('wz-scenario-badge');
    if (badge) badge.textContent = WZ.scenarioPlanBadge;

    const title = document.getElementById('wz-scenario-title');
    const desc  = document.getElementById('wz-scenario-desc');
    const icon  = document.getElementById('wz-scenario-icon');
    if (WZ.mode === 'multisucursal') {
      if (icon)  icon.textContent  = '🏢';
      if (title) title.textContent = '¿Cómo deseas configurar este sistema?';
      if (desc)  desc.textContent  = 'Elige si estás creando la red de sucursales desde cero o si este equipo se unirá a una red ya existente.';
    } else {
      if (icon)  icon.textContent  = '🏪';
      if (title) title.textContent = '¿Cómo deseas configurar este sistema?';
      if (desc)  desc.textContent  = 'Elige si estás creando un negocio nuevo o si esta terminal se conectará a una red multicaja ya existente.';
    }

    overlay.classList.remove('wz-hidden');
    overlay.querySelector('button')?.focus();
  }

  function hideScenarioOverlay() { $scenarioOverlay()?.classList.add('wz-hidden'); }

  window.wzScenarioSelect = function (scenario) {
    WZ.scenario = scenario;
    hideScenarioOverlay();
    if (scenario === 'nuevo') {
      _doAdvance(1);
    } else {
      showAuthOverlay();
    }
  };

  window.wzScenarioCancel = function () {
    WZ.scenario = null;
    hideScenarioOverlay();
    WZ.virtualStep = 1;
    refreshUI();
  };

  // ─── Auth overlay ─────────────────────────────────────────────────────────
  function $overlay() { return document.getElementById('wz-auth-overlay'); }

  function showAuthOverlay() {
    injectStyles();
    const overlay = $overlay();
    if (!overlay) return;
    overlay.classList.remove('wz-hidden');

    const badge = document.getElementById('wz-auth-mode-badge');
    if (badge) badge.textContent = WZ.modeLabel;

    const banner = document.getElementById('wz-linking-banner');
    if (banner) banner.classList.toggle('wz-hidden', !WZ.linkingMode);

    const errEl = document.getElementById('wz-auth-error');
    const okEl  = document.getElementById('wz-auth-ok');
    const warningEl = document.getElementById('wz-auth-host-warning');
    const helpPanel = document.getElementById('wz-auth-host-help');
    if (errEl) { errEl.textContent = ''; errEl.classList.add('wz-hidden'); }
    if (okEl)  okEl.classList.add('wz-hidden');
    if (warningEl) { warningEl.textContent = ''; warningEl.classList.add('wz-hidden'); }
    if (helpPanel) helpPanel.classList.toggle('wz-hidden', !shouldUseRemotePrincipalFlow());

    const hostGroup = document.getElementById('wz-auth-host-group');
    const hostInp   = document.getElementById('wz-auth-host');
    const userInp   = document.getElementById('wz-auth-user');
    const passInp   = document.getElementById('wz-auth-pass');
    const netkeyInp = document.getElementById('wz-auth-netkey');
    if (hostGroup) hostGroup.style.display = shouldUseRemotePrincipalFlow() ? '' : 'none';
    if (hostInp)   hostInp.value   = WZ.remoteHost || '';
    if (userInp)   userInp.value   = '';
    if (passInp)   passInp.value   = '';
    if (netkeyInp) netkeyInp.value = '';
    resetWizardDiscoveryUi();
    setTimeout(() => {
      if (shouldUseRemotePrincipalFlow() && !WZ.remoteHost) {
        hostInp?.focus();
        return;
      }
      userInp?.focus();
    }, 80);

    hostInp?.addEventListener('keydown', e => { if (e.key === 'Enter') userInp?.focus(); }, { once: true });
    if (hostInp) {
      hostInp.oninput = () => syncWizardPrincipalHostUi();
      hostInp.onblur = () => syncWizardPrincipalHostUi({ normalizeValue: true });
    }
    passInp?.addEventListener('keydown', e => { if (e.key === 'Enter') netkeyInp?.focus() || wizardAuthSubmit(); }, { once: true });
    netkeyInp?.addEventListener('keydown', e => { if (e.key === 'Enter') wizardAuthSubmit(); }, { once: true });
    userInp?.addEventListener('keydown', e => { if (e.key === 'Enter') passInp?.focus(); }, { once: true });
    syncWizardPrincipalHostUi();
  }

  function hideAuthOverlay() { $overlay()?.classList.add('wz-hidden'); }

  // ─── Funciones globales del overlay ──────────────────────────────────────
  window.wzToggleAuthPass = function () {
    const inp = document.getElementById('wz-auth-pass');
    if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
  };

  window.wzToggleAuthNetkey = function () {
    const inp = document.getElementById('wz-auth-netkey');
    if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
  };

  window.wzToggleSetupNetkey = function () {
    const inp = document.getElementById('setup-network-key');
    if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
  };

  window.wizardAuthCancel = function () {
    WZ.authPassed = false; WZ.authUser = null; WZ._creds = null; WZ.remoteProfile = null;
    hideAuthOverlay();
    // Volver al overlay de escenario para que pueda re-elegir
    showScenarioOverlay();
  };

  window.wizardAuthSubmit = async function () {
    const hostInputValue = document.getElementById('wz-auth-host')?.value?.trim() || WZ.remoteHost || '';
    const usuario   = document.getElementById('wz-auth-user')?.value?.trim()   || '';
    const password  = document.getElementById('wz-auth-pass')?.value?.trim()   || '';
    const networkKey= document.getElementById('wz-auth-netkey')?.value?.trim() || '';
    const errEl     = document.getElementById('wz-auth-error');
    const okEl      = document.getElementById('wz-auth-ok');
    const btn       = document.getElementById('wz-auth-submit-btn');

    if (errEl) { errEl.textContent = ''; errEl.classList.add('wz-hidden'); }
    if (okEl)  okEl.classList.add('wz-hidden');

    if (!usuario || !password) {
      showAuthError('Completa usuario y contraseña para verificar.'); return;
    }
    if (shouldUseRemotePrincipalFlow() && !hostInputValue) {
      showAuthError('Indica la IP o URL del equipo principal antes de continuar.'); return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Verificando…'; }

    try {
      let principalHost = hostInputValue;
      if (shouldUseRemotePrincipalFlow()) {
        const probe = await testPrincipalConnection({ lockSubmit: false });
        if (!probe.ok) {
          if (btn) { btn.disabled = false; btn.textContent = 'Verificar acceso →'; }
          return;
        }
        principalHost = probe.data?.normalizedBaseUrl || parseWizardPrincipalHost(hostInputValue).normalizedBaseUrl || hostInputValue;
      }

      const endpoint = shouldUseRemotePrincipalFlow()
        ? '/api/wizard/remote-validate'
        : '/api/wizard/validate-auth';
      const res  = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ principalHost, usuario, password, networkKey, structureMode: WZ.mode })
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        if (data?.warning) showAuthWarning(data.warning);
        showAuthError(data.error || 'No se pudo verificar el acceso.'); return;
      }

      WZ.authPassed        = true;
      WZ.authUser          = data.user;
      WZ.authBranches      = data.branches     || [];
      WZ.authCashRegisters = data.cashRegisters || [];
      WZ._creds            = { usuario, password };
      WZ.remoteHost        = data.normalizedBaseUrl || principalHost || WZ.remoteHost;
      WZ.remoteProfile     = data.networkProfile || null;
      if (data.warning) showAuthWarning(data.warning);

      showAuthOk(
        shouldUseRemotePrincipalFlow()
          ? `Conexión establecida con la PC principal. Acceso verificado: ${data.user?.nombre || usuario} (${data.user?.rol})`
          : `Verificado — ${data.user?.nombre || usuario} (${data.user?.rol})`
      );
      if (btn) btn.textContent = '✓ Acceso verificado';

      setTimeout(() => {
        hideAuthOverlay();
        WZ.virtualStep = WZ.flow.indexOf(3);
        activateMultiStep3();
        refreshUI();
      }, 900);

    } catch (_) {
      showAuthError('No se pudo validar el acceso con la PC principal. Verifica la IP correcta, que Tecno Caja esté abierto y que el Firewall permita el puerto 3399.');
    } finally {
      if (btn && !WZ.authPassed) { btn.disabled = false; btn.textContent = 'Verificar acceso →'; }
    }
  };

  function showAuthError(msg) {
    const el = document.getElementById('wz-auth-error');
    if (el) { el.textContent = msg; el.classList.remove('wz-hidden'); }
  }

  function syncWizardPrincipalHostUi(options = {}) {
    const hostInp = document.getElementById('wz-auth-host');
    if (!hostInp) return parseWizardPrincipalHost('');
    const meta = parseWizardPrincipalHost(hostInp.value);
    refreshWizardPrincipalHostExamples(meta.raw);
    if (options.normalizeValue && meta.normalizedBaseUrl) {
      hostInp.value = meta.normalizedBaseUrl;
    }
    showAuthWarning(meta.warning || '');
    return meta;
  }

  window.wizardToggleIpHelp = function () {
    const helpPanel = document.getElementById('wz-auth-host-help');
    if (!helpPanel) return;
    helpPanel.classList.toggle('wz-hidden');
    if (!helpPanel.classList.contains('wz-hidden')) {
      helpPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };

  async function testPrincipalConnection(options = {}) {
    const hostInp = document.getElementById('wz-auth-host');
    const rawHost = hostInp?.value?.trim() || WZ.remoteHost || '';
    const errEl = document.getElementById('wz-auth-error');
    const okEl = document.getElementById('wz-auth-ok');
    const testBtn = document.getElementById('wz-auth-test-btn');
    const submitBtn = document.getElementById('wz-auth-submit-btn');

    if (errEl) { errEl.textContent = ''; errEl.classList.add('wz-hidden'); }
    if (okEl) okEl.classList.add('wz-hidden');

    if (!rawHost) {
      showAuthError('Escribe la IP real de la PC principal antes de probar la conexión.');
      return { ok: false };
    }

    const localMeta = syncWizardPrincipalHostUi();
    if (!localMeta.host) {
      showAuthError('La dirección indicada no es válida. Usa la IP de la PC principal, por ejemplo 192.168.1.25:3399, 10.0.0.25:3399 o 172.16.0.25:3399.');
      return { ok: false };
    }

    if (testBtn) { testBtn.disabled = true; testBtn.textContent = 'Probando…'; }
    if (options.lockSubmit && submitBtn) submitBtn.disabled = true;

    try {
      const res = await fetch('/api/wizard/test-principal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          principalHost: rawHost,
          usuario: document.getElementById('wz-auth-user')?.value?.trim() || ''
        })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        if (data?.warning) showAuthWarning(data.warning);
        showAuthError(data?.error || 'No se pudo conectar con la PC principal.');
        return { ok: false, data };
      }

      if (hostInp && data.normalizedBaseUrl) hostInp.value = data.normalizedBaseUrl;
      WZ.remoteHost = data.normalizedBaseUrl || rawHost;
      if (data?.warning) showAuthWarning(data.warning);
      showAuthOk(data?.message || 'Conexión establecida con la PC principal.');
      return { ok: true, data };
    } catch (_error) {
      showAuthError('No se pudo probar la conexión con la PC principal. Verifica la IP correcta, que Tecno Caja esté abierto y que el puerto 3399 esté permitido en el Firewall.');
      return { ok: false };
    } finally {
      if (testBtn) { testBtn.disabled = false; testBtn.textContent = 'Probar conexión'; }
      if (options.lockSubmit && submitBtn) submitBtn.disabled = false;
    }
  }

  window.wizardTestPrincipalConnection = function () {
    return testPrincipalConnection();
  };

  function resetWizardDiscoveryUi() {
    const status = document.getElementById('wz-auth-discovery-status');
    const list = document.getElementById('wz-auth-discovery-list');
    if (status) { status.textContent = ''; }
    if (list) {
      list.innerHTML = '';
      list.classList.add('wz-hidden');
    }
  }

  window.wizardUseDiscoveredPrincipal = function (host) {
    const hostInput = document.getElementById('wz-auth-host');
    if (!hostInput) return;
    hostInput.value = host;
    syncWizardPrincipalHostUi({ normalizeValue: true });
    showAuthOk('IP principal autocompletada. Ahora prueba la conexión o continúa con las credenciales.');
  };

  window.wizardDiscoverPrincipal = async function () {
    const btn = document.getElementById('wz-auth-discover-btn');
    const status = document.getElementById('wz-auth-discovery-status');
    const list = document.getElementById('wz-auth-discovery-list');
    const errEl = document.getElementById('wz-auth-error');
    if (errEl) { errEl.textContent = ''; errEl.classList.add('wz-hidden'); }
    if (status) {
      status.textContent = 'Buscando servidor principal en la red local…';
      status.classList.remove('wz-hidden');
    }
    if (list) {
      list.innerHTML = '';
      list.classList.add('wz-hidden');
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Buscando…'; }

    try {
      const res = await fetch('/api/network/discover-principal');
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showAuthError(data?.error || 'No se pudo buscar el servidor principal en la red local.');
        return;
      }

      const candidates = Array.isArray(data.candidates) ? data.candidates : [];
      if (!candidates.length) {
        showAuthError('No se encontró ningún equipo principal en la red local. Verifica que el servidor principal esté en la misma red y tenga el puerto 3399 abierto.');
        return;
      }

      if (candidates.length === 1) {
        const candidate = candidates[0];
        const hostInput = document.getElementById('wz-auth-host');
        if (hostInput) {
          hostInput.value = candidate.baseUrl;
          syncWizardPrincipalHostUi({ normalizeValue: true });
        }
        showAuthOk(`Servidor principal encontrado: ${candidate.businessName} · ${candidate.branchName} · ${candidate.baseUrl}`);
        return;
      }

      if (status) {
        status.textContent = `Se encontraron ${candidates.length} servidores principales. Selecciona uno:`;
      }
      if (list) {
        list.classList.remove('wz-hidden');
        list.innerHTML = candidates.map((item) => {
          const safeHost = String(item.baseUrl || '').replace(/'/g, "\\'");
          return `<div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;padding:.65rem .85rem;border-bottom:1px solid rgba(255,255,255,.08);">` +
            `<div style="flex:1;min-width:0">` +
            `<strong style="display:block;color:var(--text1);font-size:.92rem">${item.businessName} · ${item.branchName}</strong>` +
            `<span style="display:block;color:var(--text3);font-size:.82rem;word-break:break-all">${item.baseUrl}</span>` +
            `</div>` +
            `<button type="button" class="btn-secondary" style="white-space:nowrap;" onclick="wizardUseDiscoveredPrincipal('${safeHost}')">Usar</button>` +
            `</div>`;
        }).join('');
      }
    } catch (error) {
      showAuthError('No se pudo buscar el servidor principal en la red local. Verifica que la red esté activa.');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Buscar servidor principal automáticamente'; }
    }
  };

  // ─── Panel 3 existente: poblar selects de sucursal/caja ──────────────────
  function activateMultiStep3() {
    const title = document.getElementById('wz-assign-title');
    const desc  = document.getElementById('wz-assign-desc');
    const modeLabels = {
      multicaja:     ['Asignación de terminal', 'Selecciona la sucursal y caja que operará este terminal.'],
      sucursal:      ['Vinculación de sucursal', 'Selecciona la sucursal principal asignada a este equipo.'],
      multisucursal: ['Asignación en red multisucursal', 'Selecciona la sucursal y caja autorizadas para este terminal.']
    };
    const [t, d] = modeLabels[WZ.mode] || modeLabels.multicaja;
    if (title) title.textContent = t;
    if (desc)  desc.textContent  = d;

    const chip = document.getElementById('wz-assign-user-chip');
    if (chip && WZ.authUser) {
      chip.innerHTML = `<span>👤</span><div>Autorizado: <strong>${WZ.authUser.nombre || WZ.authUser.usuario}</strong> · ${WZ.authUser.rol}</div>`;
      chip.style.display = 'flex';
    }

    const branchSel = document.getElementById('wz-assign-branch');
    if (branchSel) {
      branchSel.innerHTML = '<option value="">— Selecciona sucursal —</option>' +
        WZ.authBranches.map(b => `<option value="${b.id}">${b.nombre}</option>`).join('');
      branchSel.onchange = fillRegisterSelect;
    }
    fillRegisterSelect();
  }

  function fillRegisterSelect() {
    const bId  = Number(document.getElementById('wz-assign-branch')?.value || 0);
    const list = bId
      ? WZ.authCashRegisters.filter(cr => Number(cr.branch_id) === bId)
      : WZ.authCashRegisters;
    const regSel = document.getElementById('wz-assign-register');
    if (regSel) {
      regSel.innerHTML = '<option value="">— Selecciona caja —</option>' +
        list.map(cr => `<option value="${cr.id}">${cr.nombre}${cr.sucursal_nombre ? ' · ' + cr.sucursal_nombre : ''}</option>`).join('');
    }
  }

  // ─── Reset público (llamado desde startSetupWizardSession) ───────────────
  window.wzReset = function () {
    WZ.virtualStep      = 0;
    WZ.scenario         = null;
    WZ.authPassed       = false;
    WZ.authUser         = null;
    WZ.authBranches     = [];
    WZ.authCashRegisters = [];
    WZ._creds           = null;
    WZ.linkingMode      = false;
    WZ.remoteHost       = '';
    WZ.remoteProfile    = null;
    WZ.selectedBizType  = null;
    const scenOverlay = document.getElementById('wz-scenario-overlay');
    const authOverlay = document.getElementById('wz-auth-overlay');
    if (scenOverlay) scenOverlay.classList.add('wz-hidden');
    if (authOverlay) authOverlay.classList.add('wz-hidden');
  };

  // ─── Override: goToSetupStep ──────────────────────────────────────────────
  window.goToSetupStep = function (direction) {
    const curPanel = WZ.currentPanel;

    if (direction > 0 && curPanel === 1) {
      const rawMode = readSelectedStructure();
      if (!rawMode) {
        if (typeof showToast === 'function') showToast('Selecciona un plan de operación.', 'warning');
        return;
      }
      const mode = (typeof normalizeBusinessStructureMode === 'function')
        ? normalizeBusinessStructureMode(rawMode)
        : rawMode;
      if (typeof setupWizard !== 'undefined') setupWizard.businessStructureMode = mode;

      setTimeout(() => {
        if (WZ.isMulti && !WZ.scenario) {
          showScenarioOverlay();
          return;
        }
        if (WZ.isMulti && WZ.scenario === 'existente' && !WZ.authPassed) {
          showAuthOverlay();
          return;
        }
        _doAdvance(direction);
      }, 0);
      return;
    }

    // Retroceso al panel 1: resetear escenario para permitir re-selección
    if (direction < 0 && curPanel === 2 && WZ.isMulti) {
      WZ.scenario = null;
    }
    if (direction < 0 && curPanel === 3) {
      WZ.authPassed = false; WZ.authUser = null; WZ._creds = null; WZ.remoteProfile = null;
      if (WZ.isMulti && WZ.scenario === 'existente') {
        WZ.scenario = null; // vuelve a preguntar el escenario
      }
    }

    if (direction > 0 && !validatePanel(curPanel)) return;

    _doAdvance(direction);
  };

  function _doAdvance(direction) {
    const newVStep = Math.max(0, Math.min(WZ.lastVirtualStep, WZ.virtualStep + direction));
    WZ.virtualStep = newVStep;
    // Al llegar de vuelta al panel 1, resetear escenario
    if (direction < 0 && WZ.currentPanel === 1) {
      WZ.scenario = null;
    }
    refreshUI();
  }

  // ─── Override: updateSetupStepUi (compatibilidad app.js) ─────────────────
  const _origUpdateUI = window.updateSetupStepUi;
  window.updateSetupStepUi = function () {
    if (WZ.virtualStep === 0 && typeof _origUpdateUI === 'function') {
      _origUpdateUI();
    } else {
      refreshUI();
    }
  };

  // ─── Override: validateSetupStep (compatibilidad completeInitialSetup) ────
  window.validateSetupStep = function (step) {
    if (step === 2) return validatePanel(3); // admin
    if (step === 3) return validatePanel(4); // datos negocio
    return true;
  };

  // ─── Override: completeInitialSetup ──────────────────────────────────────
  const _origComplete = window.completeInitialSetup;

  window.completeInitialSetup = async function () {
    if (!validatePanel(WZ.currentPanel)) return;

    // Escenario existente: vincular terminal a red
    if (WZ.isMulti && WZ.scenario === 'existente') return await _completeLinkTerminal();

    // Monocaja o multi* nuevo: crear negocio desde cero
    if (typeof setupWizard !== 'undefined') {
      setupWizard.businessType = WZ.selectedBizType || 'otro';
      if (WZ.isNewSetup) {
        setupWizard.networkKey = document.getElementById('setup-network-key')?.value?.trim() || '';
      }
    }

    // Sincronizar moneda del panel 4 al selector original que usa app.js
    const v2currency = document.getElementById('setup-currency-v2')?.value;
    const origCurrency = document.getElementById('setup-currency');
    if (v2currency && origCurrency) origCurrency.value = v2currency;

    if (typeof _origComplete === 'function') return _origComplete();
  };

  // ─── Link-terminal flow (escenario existente) ─────────────────────────────
  async function _completeLinkTerminal() {
    const branchId       = Number(document.getElementById('wz-assign-branch')?.value   || 0);
    const cashRegisterId = Number(document.getElementById('wz-assign-register')?.value  || 0);
    const terminalName   = document.getElementById('wz-assign-terminal')?.value?.trim()  || '';
    const printMode      = document.getElementById('setup-print-mode')?.value            || 'dialog';
    const printerName    = document.getElementById('setup-printer-name')?.value          || '';
    const paperSize      = document.getElementById('setup-paper-size')?.value            || '80mm';
    const openingAmount  = Number(document.getElementById('setup-opening-amount')?.value || 0);
    const openingNotes   = document.getElementById('setup-opening-notes')?.value?.trim() || 'Apertura inicial';
    const language       = (typeof setupWizard !== 'undefined') ? (setupWizard.language || 'es') : 'es';

    if (!branchId || !cashRegisterId) {
      if (typeof showToast === 'function') showToast('Selecciona sucursal y caja para finalizar.', 'warning');
      return;
    }
    if (shouldUseRemotePrincipalFlow() && !WZ.remoteHost) {
      if (typeof showToast === 'function') showToast('Falta la IP o URL del equipo principal.', 'warning');
      return;
    }

    const finishBtn = document.getElementById('setup-finish-btn');
    if (finishBtn) { finishBtn.disabled = true; finishBtn.textContent = 'Vinculando…'; }

    try {
      const endpoint = shouldUseRemotePrincipalFlow()
        ? '/api/wizard/remote-link-terminal'
        : '/api/wizard/link-terminal';
      const res = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          principalHost: WZ.remoteHost,
          usuario: WZ._creds?.usuario, password: WZ._creds?.password,
          networkKey: document.getElementById('wz-auth-netkey')?.value?.trim() || '',
          branchId, cashRegisterId, terminalName,
          structureMode: WZ.mode, language,
          receiptPrintMode: printMode, receiptPrinterName: printerName,
          receiptPaperSize: paperSize, openingAmount, openingNotes
        })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        if (typeof showToast === 'function') showToast(data.error || 'Error al vincular el terminal.', 'error');
        return;
      }

      if (shouldUseRemotePrincipalFlow()) {
        WZ._creds = null;
        if (typeof showToast === 'function') showToast('Terminal enlazado. Reiniciando Tecno Caja…', 'success');
        if (window.novaDesktop?.restartApp) {
          await window.novaDesktop.restartApp();
          return;
        }
        if (typeof showToast === 'function') {
          showToast('El perfil ya fue aplicado. Reinicia la aplicación para terminar la conexión.', 'warning');
        }
        return;
      }

      const savedCreds = { ...WZ._creds };
      WZ._creds = null;
      if (typeof showToast === 'function') showToast('Terminal vinculado. Iniciando sesión…', 'success');

      setTimeout(async () => {
        try {
          if (typeof api !== 'undefined' && typeof activateAuthenticatedSession === 'function' && savedCreds.usuario) {
            const loginResp = await api.login(savedCreds.usuario, savedCreds.password);
            await activateAuthenticatedSession(loginResp, language);
            return;
          }
        } catch (_) { /* fall through */ }
        window.location.reload();
      }, 1000);

    } catch (_) {
      if (typeof showToast === 'function') showToast('Error de conexión al vincular el terminal.', 'error');
    } finally {
      if (finishBtn) { finishBtn.disabled = false; finishBtn.textContent = 'Finalizar e iniciar'; }
    }
  }

  // ─── Cards de tipo de negocio ─────────────────────────────────────────────
  function bindBizTypeCards() {
    document.querySelectorAll('#setup-biztype-options .setup-choice-card').forEach(card => {
      card.addEventListener('click', () => {
        document.querySelectorAll('#setup-biztype-options .setup-choice-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        WZ.selectedBizType = card.dataset.biztype;
        if (WZ.selectedBizType && typeof setupWizard !== 'undefined') {
          setupWizard.businessType = WZ.selectedBizType;
        }
      });
    });
    syncBizTypeSelection();
  }

  // ─── Detección de linking mode ────────────────────────────────────────────
  function detectLinkingMode() {
    const check = () => {
      if (typeof setupState !== 'undefined' && setupState !== null) {
        if (setupState.linkingMode) {
          WZ.linkingMode = true;
          WZ.scenario = 'existente'; // modo enlace siempre es "existente"
          const mode = setupState.config?.businessStructureMode || 'multicaja';
          if (typeof setupWizard !== 'undefined') setupWizard.businessStructureMode = mode;
        }
      } else {
        setTimeout(check, 200);
      }
    };
    setTimeout(check, 300);
  }

  // ─── Agregar "Sucursal" a las opciones de estructura ─────────────────────
  function ensureSucursalOption() {
    const check = () => {
      const container = document.getElementById('setup-structure-options');
      if (!container || container.children.length < 2) { setTimeout(check, 300); return; }

      const hasSucursal = !!container.querySelector('[data-value="sucursal"]');
      if (hasSucursal) return;

      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'setup-choice-card';
      card.dataset.value = 'sucursal';
      card.dataset.type  = 'structure';
      card.innerHTML = `<span class="choice-icon">🏬</span><strong>Sucursal</strong><small>Terminal secundaria vinculada al sistema principal de otra ubicación</small>`;
      card.addEventListener('click', () => {
        container.querySelectorAll('.setup-choice-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        if (typeof setupWizard !== 'undefined') {
          setupWizard.businessStructureMode = 'sucursal';
        }
        WZ.scenario = null; // resetear escenario al cambiar estructura
        WZ.remoteProfile = null;
      });

      const cards = container.querySelectorAll('.setup-choice-card');
      const last  = cards[cards.length - 1];
      if (last) container.insertBefore(card, last);
      else container.appendChild(card);
    };
    setTimeout(check, 400);
  }

  // ─── Resetear escenario al cambiar opción de estructura ──────────────────
  function bindStructureCardReset() {
    const check = () => {
      const container = document.getElementById('setup-structure-options');
      if (!container || container.children.length < 2) { setTimeout(check, 300); return; }
      container.addEventListener('click', (e) => {
        if (e.target.closest('.setup-choice-card')) {
          WZ.scenario = null;
          WZ.remoteProfile = null;
        }
      });
    };
    setTimeout(check, 500);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  WELCOME / RESTORE OVERLAY
  //  Pantalla inicial antes del asistente: Nuevo / Local / Nube
  // ══════════════════════════════════════════════════════════════════════════

  /** Estado del flujo de restauración */
  const WZR = {
    fileBase64:    null,   // base64 del .tcbak elegido localmente
    fileName:      null,
    metadata:      null,   // metadatos leídos del archivo
    selectedBackup: null,  // respaldo elegido en la nube (objeto R2)
    cloudEmail:    null,   // email usado para buscar respaldos en la nube
    businessId:    null,   // businessId resuelto desde el índice R2
  };

  // ─── Helpers de visibilidad ───────────────────────────────────────────────
  function _wzShow(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('wz-hidden');
  }
  function _wzHide(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('wz-hidden');
  }
  function _wzDisable(id, disabled) {
    const el = document.getElementById(id);
    if (el) el.disabled = !!disabled;
  }
  function _wzText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  function _wzHtml(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }
  function _wzStyle(id, prop, val) {
    const el = document.getElementById(id);
    if (el) el.style[prop] = val;
  }

  // ─── Mostrar/ocultar overlays ─────────────────────────────────────────────
  function _wzShowOverlay(id) {
    ['wz-welcome-overlay', 'wz-restore-local-overlay', 'wz-restore-cloud-overlay',
     'wz-auth-overlay', 'wz-scenario-overlay'].forEach(oid => {
      const el = document.getElementById(oid);
      if (el) el.classList.add('wz-hidden');
    });
    if (id) _wzShow(id);
  }

  /** Elección en la pantalla de bienvenida */
  window.wzWelcomeChoice = function wzWelcomeChoice(choice) {
    if (choice === 'nuevo') {
      // Cerrar el welcome overlay y dejar correr el wizard normal
      _wzShowOverlay(null);
    } else if (choice === 'restaurar-local') {
      _wzShowOverlay('wz-restore-local-overlay');
      // Volver a step-select limpio
      _wzStyle('wzrl-step-select', 'display', '');
      _wzStyle('wzrl-step-confirm', 'display', 'none');
      _wzHide('wzrl-error');
      _wzStyle('wzrl-progress', 'display', 'none');
    } else if (choice === 'restaurar-nube') {
      _wzShowOverlay('wz-restore-cloud-overlay');
      _wzStyle('wzrc-panel-login', 'display', '');
      _wzStyle('wzrc-panel-list', 'display', 'none');
    }
  };

  // ══════════════════════════════════════════════════════════════════════════
  //  FLUJO: RESTAURAR LOCAL
  // ══════════════════════════════════════════════════════════════════════════

  window.wzRestoreLocalSelectFile = function wzRestoreLocalSelectFile() {
    const input = document.getElementById('wzrl-file-input');
    if (!input) return;
    input.value = '';
    input.onchange = _wzHandleFileChosen;
    input.click();
  };

  async function _wzHandleFileChosen(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    _wzStyle('wzrl-reading-msg', 'display', '');
    _wzStyle('wzrl-step-select', 'display', 'none'); // ocultar botón mientras lee

    try {
      // Leer como base64
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = ev => {
          const result = ev.target.result;
          // result es "data:application/octet-stream;base64,XXXX"
          resolve(result.split(',')[1] || result);
        };
        reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
        reader.readAsDataURL(file);
      });

      // Consultar metadatos al backend (sin restaurar)
      const res  = await fetch('/api/respaldos/setup/leer-tcbak', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ base64 }),
      });
      const data = await res.json();

      if (!data.ok) {
        _wzStyle('wzrl-reading-msg', 'display', 'none');
        _wzStyle('wzrl-step-select', 'display', '');
        _wzShow('wzrl-error');
        _wzText('wzrl-error', data.error || 'Archivo inválido.');
        return;
      }

      WZR.fileBase64 = base64;
      WZR.fileName   = file.name;
      WZR.metadata   = data.metadata || {};

      // Mostrar metadatos
      const m = WZR.metadata;
      const fecha = data.createdAt ? new Date(data.createdAt).toLocaleString('es-DO') : '—';
      _wzHtml('wzrl-meta-box',
        `<table style="width:100%;border-collapse:collapse">` +
        `<tr><td style="color:var(--text3);padding-right:.6rem;width:40%">Negocio</td><td><strong>${m.businessName || '—'}</strong></td></tr>` +
        `<tr><td style="color:var(--text3)">RNC</td><td>${m.rnc || '—'}</td></tr>` +
        `<tr><td style="color:var(--text3)">Fecha</td><td>${fecha}</td></tr>` +
        `<tr><td style="color:var(--text3)">Versión</td><td>${m.systemVersion || '—'}</td></tr>` +
        `<tr><td style="color:var(--text3)">Productos</td><td>${m.stats?.productos ?? '—'}</td></tr>` +
        `<tr><td style="color:var(--text3)">Clientes</td><td>${m.stats?.clientes ?? '—'}</td></tr>` +
        `<tr><td style="color:var(--text3)">Ventas</td><td>${m.stats?.ventas ?? '—'}</td></tr>` +
        `</table>`
      );

      // Avisar si hay datos existentes (setup no requerido = ya hay negocio)
      _wzStyle('wzrl-warn-existing', 'display', 'none');
      try {
        const st = await fetch('/api/setup/status').then(r => r.json()).catch(() => ({}));
        if (!st.setupRequired) _wzStyle('wzrl-warn-existing', 'display', '');
      } catch (_) {}

      _wzHide('wzrl-error');
      _wzStyle('wzrl-reading-msg', 'display', 'none');
      _wzStyle('wzrl-step-select', 'display', '');
      _wzStyle('wzrl-step-confirm', 'display', '');
    } catch (err) {
      _wzStyle('wzrl-reading-msg', 'display', 'none');
      _wzStyle('wzrl-step-select', 'display', '');
      _wzShow('wzrl-error');
      _wzText('wzrl-error', err.message || 'Error al leer el archivo.');
    }
  }

  window.wzRestoreLocalBack = function wzRestoreLocalBack() {
    WZR.fileBase64 = null;
    WZR.metadata   = null;
    _wzShowOverlay('wz-welcome-overlay');
  };

  window.wzRestoreLocalConfirm = async function wzRestoreLocalConfirm() {
    if (!WZR.fileBase64) { _wzShow('wzrl-error'); _wzText('wzrl-error', 'No hay archivo seleccionado.'); return; }

    _wzDisable('wzrl-confirm-btn', true);
    _wzDisable('wzrl-back-btn',    true);
    _wzHide('wzrl-error');
    _wzStyle('wzrl-progress', 'display', '');
    _wzStyle('wzrl-progress-bar', 'width', '20%');
    _wzText('wzrl-progress-msg', 'Enviando al servidor…');

    const password = (document.getElementById('wzrl-password') || {}).value || '';

    try {
      _wzStyle('wzrl-progress-bar', 'width', '50%');
      _wzText('wzrl-progress-msg', 'Restaurando base de datos…');

      const res  = await fetch('/api/respaldos/setup/restaurar-local', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ base64: WZR.fileBase64, fileName: WZR.fileName, password }),
      });
      const data = await res.json();

      _wzStyle('wzrl-progress-bar', 'width', '100%');

      if (!data.ok) {
        _wzText('wzrl-progress-msg', '');
        _wzStyle('wzrl-progress', 'display', 'none');
        _wzShow('wzrl-error');
        _wzText('wzrl-error', data.error || 'Error al restaurar.');
        _wzDisable('wzrl-confirm-btn', false);
        _wzDisable('wzrl-back-btn',    false);
        return;
      }

      _wzText('wzrl-progress-msg', '¡Listo! Reiniciando…');
      await _wzShowSuccessAndRestart('Restauración completada. La aplicación se reiniciará.');
    } catch (err) {
      _wzStyle('wzrl-progress', 'display', 'none');
      _wzShow('wzrl-error');
      _wzText('wzrl-error', err.message || 'Error de red al restaurar.');
      _wzDisable('wzrl-confirm-btn', false);
      _wzDisable('wzrl-back-btn',    false);
    }
  };

  // ══════════════════════════════════════════════════════════════════════════
  //  FLUJO: RESTAURAR NUBE (R2 + email)
  // ══════════════════════════════════════════════════════════════════════════

  /** Panel A → busca backups en R2 por email */
  window.wzRestoreCloudLogin = async function wzRestoreCloudLogin() {
    const email = (document.getElementById('wzrc-email') || {}).value.trim();
    if (!email) {
      _wzShow('wzrc-login-error');
      _wzText('wzrc-login-error', 'Ingresa tu correo electrónico.');
      return;
    }

    const btn = document.getElementById('wzrc-login-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Buscando…'; }
    _wzHide('wzrc-login-error');
    _wzStyle('wzrc-list-loading', 'display', '');

    try {
      const res  = await fetch('/api/respaldos/setup/cloud/auth', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email }),
      });
      const data = await res.json();

      _wzStyle('wzrc-list-loading', 'display', 'none');

      if (!data.ok) {
        _wzShow('wzrc-login-error');
        _wzText('wzrc-login-error', data.error || 'No se encontraron respaldos para este correo.');
        return;
      }

      WZR.cloudEmail  = email;
      WZR.businessId  = data.businessId || '';

      // Pasar al panel de lista
      _wzStyle('wzrc-panel-login', 'display', 'none');
      _wzStyle('wzrc-panel-list',  'display', '');
      _wzText('wzrc-user-email', email);

      // Renderizar lista de backups
      _wzRenderBackupList(data.backups || []);

    } catch (err) {
      _wzStyle('wzrc-list-loading', 'display', 'none');
      _wzShow('wzrc-login-error');
      _wzText('wzrc-login-error', err.message || 'Error de red al buscar respaldos.');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔍 Buscar mis respaldos en la nube'; }
    }
  };

  /** Renderiza la lista de backups R2 */
  function _wzRenderBackupList(backups) {
    const listEl = document.getElementById('wzrc-backup-list');
    if (!listEl) return;

    if (!backups.length) {
      _wzShow('wzrc-list-error');
      _wzText('wzrc-list-error', 'No se encontraron respaldos en la nube para este correo.');
      return;
    }

    listEl.innerHTML = backups.map((b, i) => {
      const fecha = b.lastModified ? new Date(b.lastModified).toLocaleString('es-DO') : '—';
      const size  = b.size ? `${(b.size / 1024).toFixed(0)} KB` : '—';
      return `<button type="button" onclick="wzRestoreCloudSelect(${i})"
        data-backup-idx="${i}"
        style="display:block;width:100%;text-align:left;padding:.65rem .85rem;margin-bottom:.4rem;
               background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:8px;
               cursor:pointer;transition:background .15s;font-size:.8rem;line-height:1.55">
        <strong style="color:var(--text1)">${b.fileName || b.key || '—'}</strong><br>
        <span style="color:var(--text3)">📅 ${fecha} &nbsp;·&nbsp; 📦 ${size}</span>
      </button>`;
    }).join('');

    listEl._backups = backups;
    _wzStyle('wzrc-backup-list', 'display', '');
  }

  window.wzRestoreCloudSelect = async function wzRestoreCloudSelect(idx) {
    const listEl  = document.getElementById('wzrc-backup-list');
    const backups = listEl && listEl._backups;
    if (!backups || !backups[idx]) return;

    const b = backups[idx];
    WZR.selectedBackup = b;

    // Resaltar seleccionado
    listEl.querySelectorAll('button').forEach((btn, i) => {
      btn.style.background  = i === idx ? 'rgba(9,132,227,.2)' : 'rgba(255,255,255,.04)';
      btn.style.borderColor = i === idx ? 'rgba(9,132,227,.5)' : 'rgba(255,255,255,.1)';
    });

    // Mostrar caja de confirmación
    const fecha = b.lastModified ? new Date(b.lastModified).toLocaleString('es-DO') : '—';
    const size  = b.size ? `${(b.size / 1048576).toFixed(2)} MB` : '—';
    _wzHtml('wzrc-meta-box',
      `<table style="width:100%;border-collapse:collapse">` +
      `<tr><td style="color:var(--text3);padding-right:.6rem;width:40%">Archivo</td><td><strong>${b.fileName || '—'}</strong></td></tr>` +
      `<tr><td style="color:var(--text3)">Tamaño</td><td>${size}</td></tr>` +
      `<tr><td style="color:var(--text3)">Fecha</td><td>${fecha}</td></tr>` +
      `</table>`
    );

    // Avisar si hay datos existentes
    _wzStyle('wzrc-warn-existing', 'display', 'none');
    try {
      const st = await fetch('/api/setup/status').then(r => r.json()).catch(() => ({}));
      if (!st.setupRequired) _wzStyle('wzrc-warn-existing', 'display', '');
    } catch (_) {}

    _wzHide('wzrc-error');
    _wzStyle('wzrc-confirm-box', 'display', '');
  };

  window.wzRestoreCloudBack = function wzRestoreCloudBack() {
    WZR.selectedBackup = null;
    WZR.cloudEmail     = null;
    // Volver al panel de email
    _wzStyle('wzrc-panel-list',  'display', 'none');
    _wzStyle('wzrc-panel-login', 'display', '');
    _wzStyle('wzrc-confirm-box', 'display', 'none');
    _wzStyle('wzrc-backup-list', 'display', 'none');
    _wzHide('wzrc-list-error');
    _wzShowOverlay('wz-welcome-overlay');
  };

  window.wzRestoreCloudConfirm = async function wzRestoreCloudConfirm() {
    if (!WZR.selectedBackup) {
      _wzShow('wzrc-error'); _wzText('wzrc-error', 'Selecciona un respaldo primero.');
      return;
    }

    const b             = WZR.selectedBackup;
    const loginEmail    = (document.getElementById('wzrc-email')          || {}).value.trim();
    const loginPassword = (document.getElementById('wzrc-login-password') || {}).value || '';

    if (!loginPassword) {
      _wzShow('wzrc-error');
      _wzText('wzrc-error', 'Ingresa tu contraseña de TecnoCaja para confirmar tu identidad.');
      return;
    }

    _wzDisable('wzrc-confirm-btn', true);
    _wzDisable('wzrc-back-btn',    true);
    _wzHide('wzrc-error');
    _wzStyle('wzrc-progress', 'display', '');
    _wzStyle('wzrc-progress-bar', 'width', '20%');
    _wzText('wzrc-progress-msg', 'Descargando respaldo desde la nube…');

    try {
      _wzStyle('wzrc-progress-bar', 'width', '55%');
      _wzText('wzrc-progress-msg', 'Verificando identidad y restaurando datos…');

      const res = await fetch('/api/respaldos/setup/restaurar-nube', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          storageKey:    b.storageKey || b.key,
          loginEmail,
          loginPassword,
        }),
      });
      const data = await res.json();

      _wzStyle('wzrc-progress-bar', 'width', '100%');

      if (!data.ok) {
        _wzStyle('wzrc-progress', 'display', 'none');
        _wzShow('wzrc-error');
        _wzText('wzrc-error', data.error || 'Error al restaurar desde la nube.');
        _wzDisable('wzrc-confirm-btn', false);
        _wzDisable('wzrc-back-btn',    false);
        return;
      }

      _wzText('wzrc-progress-msg', '¡Listo! Reiniciando…');
      await _wzShowSuccessAndRestart('Restauración desde la nube completada. La aplicación se reiniciará.');
    } catch (err) {
      _wzStyle('wzrc-progress', 'display', 'none');
      _wzShow('wzrc-error');
      _wzText('wzrc-error', err.message || 'Error de red al restaurar.');
      _wzDisable('wzrc-confirm-btn', false);
      _wzDisable('wzrc-back-btn',    false);
    }
  };

  // ─── Éxito y reinicio ─────────────────────────────────────────────────────
  async function _wzShowSuccessAndRestart(msg) {
    // Notificar al usuario con un toast o alert simple
    if (window.showToast) {
      window.showToast(msg, 'success');
    }
    await new Promise(r => setTimeout(r, 1800));
    // Solicitar reinicio al proceso Electron (si está disponible)
    if (window.novaDesktop && window.novaDesktop.restartApp) {
      window.novaDesktop.restartApp();
    } else {
      window.location.reload();
    }
  }

  // ─── Inicializar el welcome overlay ──────────────────────────────────────
  function initWelcomeOverlay() {
    const check = () => {
      // setupState es null hasta que app.js lo llene con getSetupStatus()
      if (typeof setupState === 'undefined' || setupState === null) {
        setTimeout(check, 200);
        return;
      }
      // Si es modo enlace (terminal secundaria), no mostrar el welcome overlay
      if (setupState.linkingMode) return;

      // Solo mostrar si el setup es requerido
      if (setupState.setupRequired) {
        const el = document.getElementById('wz-welcome-overlay');
        if (el) el.classList.remove('wz-hidden');
      }
    };
    setTimeout(check, 350);
  }

  // Exponer para uso externo si es necesario
  window.wzShowWelcomeOverlay = function() {
    _wzShowOverlay('wz-welcome-overlay');
  };

  // ─── Init ────────────────────────────────────────────────────────────────
  injectStyles();
  bindBizTypeCards();
  detectLinkingMode();
  ensureSucursalOption();
  bindStructureCardReset();
  initWelcomeOverlay();

})();
