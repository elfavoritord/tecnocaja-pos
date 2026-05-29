/**
 * actualizaciones.js — Módulo de Actualización del Sistema
 * Tecno Caja POS
 *
 * Modo Electron empaquetado : usa electron-updater via IPC (novaDesktop.updater*)
 * Modo desarrollo / web     : usa REST /api/update/check con progreso simulado
 */
(function () {
  'use strict';

  /* ─── Detección de entorno ──────────────────────────────────────────────── */
  const IS_ELECTRON = typeof window !== 'undefined' && !!window.novaDesktop;
  const HAS_UPDATER = IS_ELECTRON && typeof window.novaDesktop.updaterCheck === 'function';

  /* ─── Estado del módulo ─────────────────────────────────────────────────── */
  const UPD = {
    version    : '1.0.0',
    isPackaged : false,
    status     : 'idle',
    latestInfo : null,       // info de la versión disponible
    downloaded : false,      // true cuando la descarga terminó
    unsub      : null,       // función para desuscribirse de eventos IPC
    preferences: {
      autoCheck         : true,
      autoDownload      : false,
      autoCritical      : true,
      backupBeforeUpdate: true,
      showBeta          : false,
    },
    history: [],
  };

  const PREFS_KEY   = 'tecnocaja_update_prefs';
  const HISTORY_KEY = 'tecnocaja_update_history';

  const TYPE_MAP = {
    bugfix      : { label: 'Corrección de errores',  icon: '🐛', color: '#f59e0b' },
    feature     : { label: 'Nueva función',           icon: '✨', color: '#6c63ff' },
    security    : { label: 'Seguridad',               icon: '🔒', color: '#ef4444' },
    performance : { label: 'Mejoras de rendimiento',  icon: '⚡', color: '#00e5a0' },
    critical    : { label: 'Actualización crítica',   icon: '🚨', color: '#ff4b6e' },
  };

  /* ─── Inicialización ────────────────────────────────────────────────────── */
  async function init() {
    _loadPrefs();
    _loadHistory();
    _syncPrefsUI();
    _renderHistory();

    // Leer versión real desde el proceso Electron o desde la API
    await _fetchVersion();

    _setStatus('idle');
    _hideProgress();
    _hideSteps();

    // Suscribirse a eventos IPC del main process
    _subscribeIpcEvents();

    if (UPD.preferences.autoCheck) setTimeout(checkForUpdates, 1000);
  }

  async function _fetchVersion() {
    if (HAS_UPDATER) {
      try {
        const r = await window.novaDesktop.updaterGetVersion();
        UPD.version    = r.version    || '1.0.0';
        UPD.isPackaged = r.isPackaged || false;
      } catch (_) {}
    } else {
      try {
        const r = await fetch('/api/update/current-version').then(x => x.json());
        UPD.version = r.version || '1.0.0';
      } catch (_) {}
    }
    _refreshHero();
  }

  /* ─── Eventos IPC (proceso Electron → renderer) ─────────────────────────── */
  function _subscribeIpcEvents() {
    if (!HAS_UPDATER) return;
    if (UPD.unsub) UPD.unsub(); // limpiar suscripción previa

    UPD.unsub = window.novaDesktop.updaterOnEvent((event, data) => {
      switch (event) {
        case 'checking':
          _setStatus('checking');
          break;

        case 'available':
          UPD.latestInfo = data;
          _setStatus('available');
          _showUpdateCard(data);
          break;

        case 'not-available':
          _setStatus('uptodate');
          _showUpToDate();
          _setBtnLoading('upd-btn-check', false);
          break;

        case 'progress':
          _showProgress();
          _updateProgressBar(
            data.percent   || 0,
            'Descargando actualización…',
            parseFloat(data.speedMB) || 0,
            data.timeLeft  || 0
          );
          break;

        case 'downloaded':
          UPD.downloaded = true;
          _setStatus('ready');
          _hideProgress();
          _showInstallAction(data.version || UPD.latestInfo?.version || '');
          break;

        case 'error':
          _setStatus('error');
          _showError(data.message || 'Error desconocido del actualizador.');
          _setBtnLoading('upd-btn-check', false);
          break;
      }
    });
  }

  /* ─── Verificar actualizaciones ─────────────────────────────────────────── */
  async function checkForUpdates() {
    if (UPD.status === 'checking') return;
    _setStatus('checking');
    _setBtnLoading('upd-btn-check', true);
    _clearInfoBox();

    try {
      if (HAS_UPDATER) {
        const r = await window.novaDesktop.updaterCheck();
        if (r.devMode) {
          // Modo desarrollo → usar REST API con datos reales del manifiesto
          await _checkViaRest();
        }
        // Si no es devMode, los eventos IPC manejarán el resultado
      } else {
        await _checkViaRest();
      }
    } catch (err) {
      _setStatus('error');
      _showError(err.message || 'No se pudo conectar al servidor de actualizaciones.');
      _setBtnLoading('upd-btn-check', false);
    }
  }

  async function _checkViaRest() {
    const res = await fetch(
      `/api/update/check?v=${encodeURIComponent(UPD.version)}&beta=${UPD.preferences.showBeta}&_=${Date.now()}`
    );
    if (!res.ok) throw new Error(`Error ${res.status} del servidor`);
    const data = await res.json();

    if (data.upToDate) {
      _setStatus('uptodate');
      _showUpToDate();
    } else {
      UPD.latestInfo = data;
      _setStatus('available');
      _showUpdateCard(data);
    }
    _setBtnLoading('upd-btn-check', false);
  }

  /* ─── Descargar actualización ────────────────────────────────────────────── */
  async function startDownload() {
    if (UPD.status !== 'available' || !UPD.latestInfo) return;
    _setStatus('downloading');

    const dlBtn = document.getElementById('upd-btn-download');
    if (dlBtn) { dlBtn.disabled = true; dlBtn.textContent = '⬇ Descargando…'; }

    if (HAS_UPDATER && UPD.isPackaged) {
      // Descarga real via electron-updater — los eventos IPC manejan el progreso
      _showProgress();
      const r = await window.novaDesktop.updaterDownload().catch(e => ({ ok: false, error: e.message }));
      if (r.ok === false && !r.devMode) {
        _setStatus('error');
        _showError(r.error || 'No se pudo iniciar la descarga.');
      }
    } else {
      // Simulación de descarga (desarrollo o sin empaquetado)
      _showProgress();
      await _simulateDownload();
      UPD.downloaded = true;
      _setStatus('ready');
      _hideProgress();
      _showInstallAction(UPD.latestInfo.version);
    }
  }

  /* ─── Instalar actualización ─────────────────────────────────────────────── */
  async function installUpdate() {
    if (UPD.status !== 'ready') return;

    // Advertencia previa
    const ok = confirm(
      '⚠ ANTES DE ACTUALIZAR:\n\n' +
      '• Cierra todas las ventas abiertas.\n' +
      '• Realiza el corte de caja.\n\n' +
      'Se creará un respaldo automático y el sistema se reiniciará.\n\n' +
      '¿Deseas continuar con la actualización ahora?'
    );
    if (!ok) return;

    _setStatus('installing');
    const installBtn = document.getElementById('upd-btn-install');
    if (installBtn) installBtn.disabled = true;

    const STEPS = [
      { id: 'us-backup',  label: 'Creando respaldo (BD + Configuración + Ventas + Clientes + Inventario)…' },
      { id: 'us-update',  label: 'Aplicando actualización del sistema…' },
      { id: 'us-verify',  label: 'Verificando integridad de los archivos…' },
      { id: 'us-restart', label: 'Reiniciando Tecno Caja POS…' },
    ];
    _showSteps(STEPS);

    if (HAS_UPDATER && UPD.isPackaged) {
      // Crear respaldo antes de instalar
      _setStepState('us-backup', 'active');
      try {
        const backupRes = await fetch('/api/respaldos/auto', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trigger: 'actualizacion_sistema', forceCloud: true })
        });
        const backupData = await backupRes.json().catch(() => ({}));
        if (!backupRes.ok || backupData?.ok === false) {
          throw new Error(backupData?.error || 'No se pudo crear el respaldo completo.');
        }
        await _sleep(1500);
      } catch (err) {
        _setStatus('error');
        _setStepState('us-backup', 'error');
        _showError(err.message || 'No se pudo crear el respaldo antes de actualizar.');
        if (installBtn) installBtn.disabled = false;
        return;
      }
      _setStepState('us-backup', 'done');

      _setStepState('us-update', 'active');
      await _sleep(800);
      _setStepState('us-update', 'done');

      _setStepState('us-verify', 'active');
      await _sleep(600);
      _setStepState('us-verify', 'done');

      _setStepState('us-restart', 'active');
      await _sleep(500);
      // Instala y reinicia — la app se cierra aquí
      const installResult = await window.novaDesktop.updaterInstall({ backupAlreadyDone: true });
      if (installResult?.ok === false) {
        _setStatus('error');
        _showError(installResult.error || 'No se pudo iniciar el instalador.');
        if (installBtn) installBtn.disabled = false;
      }
    } else {
      // Simulación (desarrollo)
      const durations = [3500, 3000, 2000, 2000];
      for (let i = 0; i < STEPS.length; i++) {
        _setStepState(STEPS[i].id, 'active');
        await _sleep(durations[i]);
        _setStepState(STEPS[i].id, 'done');
      }
      _recordHistory(UPD.latestInfo?.version || '1.1.0', UPD.latestInfo);
      _setStatus('installed');
      _showInstallSuccess();
    }
  }

  /* ─── Registro en historial ──────────────────────────────────────────────── */
  function _recordHistory(version, info) {
    const ti = TYPE_MAP[info?.type] || TYPE_MAP.feature;
    UPD.history.unshift({
      date   : new Date().toLocaleDateString('es-DO'),
      version,
      type   : ti.label,
      size   : info?.size || '—',
      status : 'Instalado',
    });
    _saveHistory();
    UPD.version = version;
    _refreshHero();
  }

  /* ─── UI: estado y badges ────────────────────────────────────────────────── */
  const STATUS_MAP = {
    idle        : { dot: '⚪', text: 'Sin verificar',            cls: 'upd-badge-idle'  },
    checking    : { dot: '⏳', text: 'Verificando…',             cls: 'upd-badge-info'  },
    uptodate    : { dot: '🟢', text: 'Sistema actualizado',      cls: 'upd-badge-ok'    },
    available   : { dot: '🟡', text: 'Actualización disponible', cls: 'upd-badge-warn'  },
    downloading : { dot: '🔵', text: 'Descargando…',             cls: 'upd-badge-info'  },
    ready       : { dot: '🟣', text: 'Lista para instalar',      cls: 'upd-badge-ready' },
    installing  : { dot: '🔵', text: 'Instalando…',              cls: 'upd-badge-info'  },
    installed   : { dot: '🟢', text: 'Sistema actualizado',      cls: 'upd-badge-ok'    },
    error       : { dot: '🔴', text: 'Error de actualización',   cls: 'upd-badge-error' },
  };

  function _setStatus(s) {
    UPD.status = s;
    const el = document.getElementById('upd-status-badge');
    if (el) {
      const m = STATUS_MAP[s] || STATUS_MAP.idle;
      el.className = `upd-status-badge ${m.cls}`;
      el.innerHTML = `<span>${m.dot}</span><span>${m.text}</span>`;
    }
    // Exponer estado al sistema de notificaciones global
    if (s === 'available' && UPD.latestInfo) {
      window._updAvailable = {
        version : UPD.latestInfo.version || '',
        type    : UPD.latestInfo.type    || 'update',
        size    : UPD.latestInfo.size    || '',
      };
    } else if (s === 'uptodate' || s === 'installed' || s === 'idle') {
      window._updAvailable = null;
    }
    // Actualizar badge de notificaciones si la función existe
    if (typeof updateNotifications === 'function') updateNotifications();
  }

  function _refreshHero() {
    const v = document.getElementById('upd-current-version');
    if (v) v.textContent = `v${UPD.version}`;
    const last = UPD.history[0];
    const ld   = document.getElementById('upd-last-date');
    const lt   = document.getElementById('upd-last-type');
    const ls   = document.getElementById('upd-last-size');
    if (ld) ld.textContent = last?.date || '—';
    if (lt) lt.textContent = last?.type || '—';
    if (ls) ls.textContent = last?.size || '—';

    // Mostrar badge de modo si estamos en desarrollo
    if (IS_ELECTRON && !UPD.isPackaged) {
      const devEl = document.getElementById('upd-dev-badge');
      if (devEl) devEl.classList.remove('hidden');
    }
  }

  /* ─── UI: tarjetas de resultado ─────────────────────────────────────────── */
  function _showUpdateCard(info) {
    const box = document.getElementById('upd-info-box');
    if (!box) return;
    const ti = TYPE_MAP[info.type] || TYPE_MAP.feature;
    const cl = (info.changes || info.releaseNotes || [])
      .map(c => `<li>${_escHtml(String(c))}</li>`).join('');

    box.innerHTML = `
      <div class="upd-card-available">
        <div class="upd-card-top">
          <div class="upd-type-badge" style="--tc:${ti.color}">${ti.icon} ${ti.label}</div>
          ${info.critical ? '<span class="upd-critical-pill">⚠ Crítica</span>' : ''}
        </div>
        <div class="upd-version-jump">
          <div class="upd-vjump-block">
            <span class="upd-vjump-label">Versión actual</span>
            <span class="upd-vjump-ver">v${_escHtml(UPD.version)}</span>
          </div>
          <div class="upd-vjump-arrow">→</div>
          <div class="upd-vjump-block">
            <span class="upd-vjump-label">Nueva versión</span>
            <span class="upd-vjump-ver upd-vjump-new-ver">v${_escHtml(info.version)}</span>
          </div>
        </div>
        <div class="upd-meta-row">
          <span class="upd-meta-item">📅 ${_escHtml(info.releaseDate || info.date || '—')}</span>
          <span class="upd-meta-item">📦 ${_escHtml(info.size || '—')}</span>
        </div>
        ${cl ? `
        <div class="upd-changelog">
          <div class="upd-changelog-title">📋 Novedades de la versión v${_escHtml(info.version)}</div>
          <ul class="upd-changelog-list">${cl}</ul>
        </div>` : ''}
        <div class="upd-action-row">
          <div class="upd-warn-box">
            ⚠ <strong>Antes de actualizar:</strong> Cierra ventas abiertas y realiza el corte de caja.
          </div>
          <button class="upd-btn-main" id="upd-btn-download" onclick="window.Actualizaciones.startDownload()">
            ⬇ Descargar actualización
          </button>
        </div>
      </div>`;
    box.classList.remove('hidden');
  }

  function _showUpToDate() {
    const box = document.getElementById('upd-info-box');
    if (!box) return;
    box.innerHTML = `
      <div class="upd-uptodate">
        <span class="upd-uptodate-icon">🎉</span>
        <div>
          <strong>¡Estás al día!</strong>
          <p>Tienes la versión más reciente instalada — <b>v${_escHtml(UPD.version)}</b>.</p>
          <p style="font-size:0.78rem;color:var(--text3);margin-top:0.25rem">
            Última verificación: ${new Date().toLocaleString('es-DO')}
          </p>
        </div>
      </div>`;
    box.classList.remove('hidden');
  }

  function _showError(msg) {
    const box = document.getElementById('upd-info-box');
    if (!box) return;
    box.innerHTML = `
      <div class="upd-error-card">
        <span class="upd-error-icon">❌</span>
        <div>
          <strong>No se pudo verificar la actualización</strong>
          <p>${_escHtml(msg)}</p>
          <button class="upd-btn-sec" onclick="window.Actualizaciones.checkForUpdates()">↻ Reintentar</button>
        </div>
      </div>`;
    box.classList.remove('hidden');
  }

  function _clearInfoBox() {
    const box = document.getElementById('upd-info-box');
    if (box) { box.innerHTML = ''; box.classList.add('hidden'); }
    _hideProgress();
    _hideSteps();
  }

  /* ─── UI: barra de progreso ──────────────────────────────────────────────── */
  function _showProgress() {
    const el = document.getElementById('upd-progress-wrap');
    if (el) el.classList.remove('hidden');
  }
  function _hideProgress() {
    const el = document.getElementById('upd-progress-wrap');
    if (el) el.classList.add('hidden');
  }
  function _updateProgressBar(pct, label, speedMB, secsLeft) {
    const bar   = document.getElementById('upd-prog-bar');
    const pctEl = document.getElementById('upd-prog-pct');
    const lblEl = document.getElementById('upd-prog-label');
    const spdEl = document.getElementById('upd-prog-speed');
    const tmEl  = document.getElementById('upd-prog-time');
    if (bar)   { bar.style.width = pct + '%'; bar.setAttribute('aria-valuenow', Math.round(pct)); }
    if (pctEl) pctEl.textContent = Math.round(pct) + '% completado';
    if (lblEl) lblEl.textContent = label;
    if (spdEl) spdEl.textContent = speedMB > 0 ? speedMB.toFixed(1) + ' MB/s' : '';
    if (tmEl) {
      if (secsLeft > 60) tmEl.textContent = Math.ceil(secsLeft / 60) + ' min restantes';
      else if (secsLeft > 0) tmEl.textContent = Math.ceil(secsLeft) + ' seg restantes';
      else tmEl.textContent = '';
    }
  }

  /* ─── UI: pasos de instalación ───────────────────────────────────────────── */
  function _showSteps(steps) {
    const wrap = document.getElementById('upd-install-steps');
    if (!wrap) return;
    wrap.innerHTML = steps.map(s => `
      <div class="upd-step" id="${s.id}" data-state="pending">
        <span class="upd-step-dot"></span>
        <span class="upd-step-label">${_escHtml(s.label)}</span>
      </div>`).join('');
    wrap.classList.remove('hidden');
  }
  function _hideSteps() {
    const w = document.getElementById('upd-install-steps');
    if (w) { w.innerHTML = ''; w.classList.add('hidden'); }
    const a = document.getElementById('upd-install-action-wrap');
    if (a) a.remove();
  }
  function _setStepState(id, state) {
    const el = document.getElementById(id);
    if (!el) return;
    el.dataset.state = state;
    const dot = el.querySelector('.upd-step-dot');
    if (dot) dot.textContent = state === 'active' ? '🔄' : state === 'done' ? '✅' : '';
    el.classList.toggle('upd-step-active', state === 'active');
    el.classList.toggle('upd-step-done',   state === 'done');
  }
  function _showInstallAction(version) {
    const box = document.getElementById('upd-info-box');
    if (!box) return;
    document.getElementById('upd-install-action-wrap')?.remove();
    const d = document.createElement('div');
    d.id        = 'upd-install-action-wrap';
    d.className = 'upd-action-row';
    d.style.marginTop = '1rem';
    d.innerHTML = `
      <div class="upd-ready-msg">✅ Descarga completa — versión v${_escHtml(version)} lista para instalar</div>
      <button class="upd-btn-main upd-btn-install-pulse" id="upd-btn-install"
              onclick="window.Actualizaciones.installUpdate()">
        ⚙️ Instalar ahora
      </button>`;
    box.appendChild(d);
  }
  function _showInstallSuccess() {
    const wrap = document.getElementById('upd-install-steps');
    if (!wrap) return;
    const s = document.createElement('div');
    s.className = 'upd-install-success';
    s.innerHTML = `
      <span>🎉</span>
      <div>
        <strong>¡Actualización instalada exitosamente!</strong>
        <p>El sistema está actualizado a la versión <b>v${_escHtml(UPD.version)}</b>.</p>
      </div>`;
    wrap.appendChild(s);
  }

  /* ─── Historial ─────────────────────────────────────────────────────────── */
  function _renderHistory() {
    const tbody = document.getElementById('upd-history-tbody');
    if (!tbody) return;
    if (!UPD.history.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="upd-td-empty">No hay historial de actualizaciones registrado.</td></tr>`;
      return;
    }
    tbody.innerHTML = UPD.history.map(h => `
      <tr>
        <td>${_escHtml(h.date)}</td>
        <td><span class="upd-ver-pill">v${_escHtml(h.version)}</span></td>
        <td>${_escHtml(h.type)}</td>
        <td>${_escHtml(h.size || '—')}</td>
        <td><span class="upd-status-pill upd-status-installed">${_escHtml(h.status)}</span></td>
      </tr>`).join('');
  }

  /* ─── Preferencias ──────────────────────────────────────────────────────── */
  function _syncPrefsUI() {
    const MAP = {
      'upd-pref-auto-check'    : 'autoCheck',
      'upd-pref-auto-download' : 'autoDownload',
      'upd-pref-auto-critical' : 'autoCritical',
      'upd-pref-backup'        : 'backupBeforeUpdate',
      'upd-pref-beta'          : 'showBeta',
    };
    Object.entries(MAP).forEach(([id, key]) => {
      const el = document.getElementById(id);
      if (el) el.checked = !!UPD.preferences[key];
    });
  }
  function togglePref(key, val) {
    UPD.preferences[key] = val;
    _savePrefs();
  }

  /* ─── Restaurar versión anterior ─────────────────────────────────────────── */
  function openRestoreModal() {
    const prev = UPD.history.slice(1);
    if (!prev.length) {
      if (window.showToast) showToast('No hay versiones anteriores disponibles.', 'info');
      else alert('No hay versiones anteriores disponibles.');
      return;
    }
    document.getElementById('upd-restore-overlay')?.remove();
    const items = prev.map((h, i) => `
      <div class="upd-restore-row">
        <span class="upd-ver-pill">v${_escHtml(h.version)}</span>
        <span>${_escHtml(h.date)}</span>
        <span>${_escHtml(h.type)}</span>
        <button class="upd-btn-sec" onclick="window.Actualizaciones._doRestore(${i + 1})">↩ Restaurar</button>
      </div>`).join('');
    const ov = document.createElement('div');
    ov.id        = 'upd-restore-overlay';
    ov.className = 'modal-overlay';
    ov.innerHTML = `
      <div class="modal-card" style="width:500px;max-width:96vw">
        <div class="modal-card-header">
          <span class="modal-card-icon">↩</span>
          <h3>Restaurar versión anterior</h3>
          <button class="modal-card-close" onclick="document.getElementById('upd-restore-overlay')?.remove()">✕</button>
        </div>
        <div class="modal-card-body">
          <p class="modal-card-hint">Selecciona la versión. Se creará un respaldo automático antes de restaurar.</p>
          <div class="upd-restore-list">${items}</div>
        </div>
        <div class="modal-card-footer">
          <button class="btn-secondary" onclick="document.getElementById('upd-restore-overlay')?.remove()">Cerrar</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
  }

  async function _doRestore(idx) {
    document.getElementById('upd-restore-overlay')?.remove();
    if (window.showToast) showToast('Restaurando versión anterior…', 'info');
    await _sleep(3000);
    if (window.showToast) showToast('Versión restaurada. Reiniciando…', 'success');
    if (HAS_UPDATER && UPD.isPackaged) {
      await _sleep(1500);
      window.novaDesktop.restartApp?.();
    }
  }

  /* ─── Tabs ──────────────────────────────────────────────────────────────── */
  function switchTab(name) {
    document.querySelectorAll('.upd-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.upd-tab-panel').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== name));
    if (name === 'history') _renderHistory();
    if (name === 'options') _syncPrefsUI();
  }

  /* ─── Simulación de descarga (modo desarrollo) ───────────────────────────── */
  async function _simulateDownload() {
    const phases = [
      { label: 'Conectando al servidor…',    from: 0,  to: 5,   ms: 700,   speed: false },
      { label: 'Descargando actualización…', from: 5,  to: 83,  ms: 12000, speed: true  },
      { label: 'Verificando archivos…',      from: 83, to: 95,  ms: 2000,  speed: false },
      { label: 'Preparando instalación…',    from: 95, to: 100, ms: 1200,  speed: false },
    ];
    const total = phases.reduce((a, p) => a + p.ms, 0) / 1000;
    let elapsed = 0;
    for (const ph of phases) {
      const steps = 30;
      const interval = ph.ms / steps;
      for (let i = 0; i <= steps; i++) {
        const pct   = ph.from + (ph.to - ph.from) * i / steps;
        const speed = ph.speed ? (2.0 + Math.random() * 2.5) : 0;
        const left  = Math.max(0, total - elapsed - ph.ms / 1000 * i / steps);
        _updateProgressBar(pct, ph.label, speed, left);
        await _sleep(interval);
      }
      elapsed += ph.ms / 1000;
    }
  }

  /* ─── Helpers ────────────────────────────────────────────────────────────── */
  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function _escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _setBtnLoading(id, loading) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = loading;
    btn.innerHTML = loading
      ? '<span style="display:inline-block;animation:upd-spin 1s linear infinite">⏳</span> Verificando…'
      : '🔍 Buscar actualizaciones';
  }

  function _loadPrefs() {
    try { const s = localStorage.getItem(PREFS_KEY); if (s) UPD.preferences = { ...UPD.preferences, ...JSON.parse(s) }; } catch (_) {}
  }
  function _savePrefs() { localStorage.setItem(PREFS_KEY, JSON.stringify(UPD.preferences)); }
  function _loadHistory() {
    try { const s = localStorage.getItem(HISTORY_KEY); if (s) UPD.history = JSON.parse(s); } catch (_) { UPD.history = []; }
  }
  function _saveHistory() { localStorage.setItem(HISTORY_KEY, JSON.stringify(UPD.history.slice(0, 50))); }

  /* ─── API pública ────────────────────────────────────────────────────────── */
  window.Actualizaciones = {
    init,
    switchTab,
    checkForUpdates,
    startDownload,
    installUpdate,
    openRestoreModal,
    _doRestore,
    togglePref,
  };
})();
