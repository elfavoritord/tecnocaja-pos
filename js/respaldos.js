// ===== TECNO_CAJA — MÓDULO DE RESPALDOS =====
// Sistema de respaldo local y en la nube con Cloudflare R2.
// Usa api.request() para todas las llamadas autenticadas.

'use strict';

// ─── Estado del módulo ────────────────────────────────────────────────────────
const RespaldosMod = (() => {

  let _estado    = null;   // último estado cargado desde la API
  let _uploading = false;  // evitar doble clic

  // ─── Wrapper sobre api.request con timeout extendido para respaldos ──────────
  function _req(url, options = {}) {
    // api.request() incluye el token JWT automáticamente desde localStorage.
    // Timeout de 120 s para operaciones de respaldo (pueden ser lentas).
    return api.request(url, { _timeoutMs: 120000, ...options });
  }

  // ─── Utilidades ─────────────────────────────────────────────────────────────
  function fmt(bytes) {
    if (!bytes || bytes < 1) return '0 B';
    if (bytes < 1024)       return `${bytes} B`;
    if (bytes < 1048576)    return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(2)} MB`;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('es-DO', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Santo_Domingo',
      });
    } catch (_) { return iso; }
  }

  function estadoBadge(estado) {
    const map = {
      completado:    'badge-success',
      pendiente_nube: 'badge-warning',
      fallido:       'badge-danger',
      subiendo:      'badge-info',
    };
    return `<span class="rb-badge ${map[estado] || 'badge-neutral'}">${estado || '—'}</span>`;
  }

  function tipoBadge(tipo) {
    const map = {
      local:        { css: 'badge-local',  label: '💾 Local' },
      cloud:        { css: 'badge-cloud',  label: '☁️ Nube' },
      local_cloud:  { css: 'badge-both',   label: '💾☁️ Local+Nube' },
      automatico:   { css: 'badge-auto',   label: '🔄 Auto' },
    };
    const { css, label } = map[tipo] || { css: 'badge-neutral', label: tipo || '—' };
    return `<span class="rb-badge ${css}">${label}</span>`;
  }

  function ipcAvailable() {
    return Boolean(window.electronAPI || (window.electron && window.electron.ipcRenderer));
  }

  async function callIPC(channel, ...args) {
    if (window.electronAPI) return window.electronAPI[channel]?.(...args);
    if (window.electron?.ipcRenderer) return window.electron.ipcRenderer.invoke(channel, ...args);
    return null;
  }

  // ─── Mostrar progreso en el panel ────────────────────────────────────────────
  function setProgress(msg, type = 'info') {
    const el = document.getElementById('rb-progress-bar');
    const tx = document.getElementById('rb-progress-text');
    if (!el || !tx) return;
    el.className  = `rb-progress-bar rb-progress-${type}`;
    tx.textContent = msg || '';
    el.parentElement?.classList.toggle('hidden', !msg);
  }

  function clearProgress() { setProgress('', ''); }

  // ─── Cargar estado desde la API ──────────────────────────────────────────────
  async function cargarEstado() {
    try {
      _estado = await _req('/api/respaldos/estado');
      renderEstado();
    } catch (e) {
      console.error('[respaldos] Error cargando estado:', e.message);
      setProgress(`⚠️ No se pudo cargar el estado: ${e.message}`, 'error');
      setTimeout(clearProgress, 5000);
    }
  }

  // ─── Render del panel de estado ──────────────────────────────────────────────
  function renderEstado() {
    if (!_estado) return;

    // Último respaldo local
    const ul = document.getElementById('rb-ultimo-local');
    if (ul) {
      const ult = _estado.ultimoLocal;
      ul.innerHTML = ult
        ? `<strong>${ult.name}</strong><br><span class="rb-meta">${fmtDate(ult.mtime)} · ${fmt(ult.size)}</span>`
        : '<span class="rb-empty">Sin respaldos locales aún</span>';
    }

    // Directorio de respaldos
    const dirEl = document.getElementById('rb-dir-display');
    if (dirEl && _estado.backupDir) dirEl.textContent = _estado.backupDir;

    // Plan y estado de nube
    const planEl = document.getElementById('rb-plan-badge');
    if (planEl) {
      const plan = _estado.planActual || 'trial';
      const cls  = ['pro','plus','enterprise','active'].includes(plan) ? 'badge-success' : 'badge-warning';
      planEl.innerHTML = `<span class="rb-badge ${cls}">${plan.toUpperCase()}</span>`;
    }
    // Mostrar/ocultar sección nube según si Firebase está configurado (nubeDisponible)
    const nubeButtons = document.querySelectorAll('.rb-nube-only');
    nubeButtons.forEach(b => b.classList.toggle('hidden', !_estado.nubeDisponible));

    // Lista de archivos locales
    renderListaLocal();

    // Historial
    renderHistorial();

    // Auto-config
    renderAutoConfig();
  }

  function renderListaLocal() {
    const el = document.getElementById('rb-lista-local');
    if (!el) return;
    const files = _estado?.archivosLocales || [];
    if (!files.length) {
      el.innerHTML = '<div class="rb-empty-row">No hay respaldos locales.</div>';
      return;
    }
    el.innerHTML = files.map(f => `
      <div class="rb-file-row">
        <div class="rb-file-info">
          <span class="rb-file-icon">📦</span>
          <div>
            <div class="rb-file-name">${f.name}</div>
            <div class="rb-meta">${fmtDate(f.mtime)} · ${fmt(f.size)}</div>
          </div>
        </div>
        <div class="rb-file-actions">
          <button class="rb-btn rb-btn-sm" onclick="RespaldosMod.restaurarDesdeArchivoLocal('${f.path?.replace(/\\/g, '\\\\')}')">🔄 Restaurar</button>
          <button class="rb-btn rb-btn-sm rb-nube-only" onclick="RespaldosMod.subirArchivoNube('${f.path?.replace(/\\/g, '\\\\')}')">☁️ Subir</button>
        </div>
      </div>
    `).join('');

    // Respetar visibilidad nube
    el.querySelectorAll('.rb-nube-only').forEach(b => b.classList.toggle('hidden', !_estado?.nubeDisponible));
  }

  function renderHistorial() {
    const el = document.getElementById('rb-historial-body');
    if (!el) return;
    const rows = _estado?.historial || [];
    if (!rows.length) {
      el.innerHTML = '<tr><td colspan="7" class="rb-empty-row">Sin historial de respaldos.</td></tr>';
      return;
    }
    el.innerHTML = rows.map(r => `
      <tr>
        <td>${fmtDate(r.created_at)}</td>
        <td class="rb-filename-cell" title="${r.file_name}">${r.file_name || '—'}</td>
        <td>${tipoBadge(r.tipo)}</td>
        <td>${estadoBadge(r.estado)}</td>
        <td>${fmt(r.file_size)}</td>
        <td>${r.productos_count || 0} / ${r.clientes_count || 0} / ${r.ventas_count || 0}</td>
        <td>${r.created_by || '—'}</td>
      </tr>
    `).join('');
  }

  function renderAutoConfig() {
    const cfg = _estado?.autoConfig || {};
    const ids = [
      'rb-cfg-auto-diario','rb-cfg-auto-semanal','rb-cfg-cerrar-caja',
      'rb-cfg-nube-auto','rb-cfg-antes-actualizar','rb-cfg-antes-restaurar',
    ];
    const keys = [
      'backup_auto_diario','backup_auto_semanal','backup_al_cerrar_caja',
      'backup_nube_auto','backup_antes_actualizar','backup_antes_restaurar',
    ];
    ids.forEach((id, i) => {
      const el = document.getElementById(id);
      if (el) el.checked = (cfg[keys[i]] || '1') !== '0';
    });
    const dirEl = document.getElementById('rb-cfg-dir');
    if (dirEl) dirEl.value = cfg.backup_dir_personalizado || '';
  }

  function renderListaNube(backups) {
    const el = document.getElementById('rb-lista-nube');
    if (!el) return;
    if (!backups || !backups.length) {
      el.innerHTML = '<div class="rb-empty-row">No hay respaldos en la nube.</div>';
      return;
    }
    el.innerHTML = backups.map(b => `
      <div class="rb-file-row">
        <div class="rb-file-info">
          <span class="rb-file-icon">☁️</span>
          <div>
            <div class="rb-file-name">${b.fileName || b.key || '—'}</div>
            <div class="rb-meta">
              ${fmtDate(b.lastModified)} · ${fmt(b.size)}
            </div>
          </div>
        </div>
        <div class="rb-file-actions">
          <button class="rb-btn rb-btn-sm"
            onclick="RespaldosMod.restaurarDesdeNube('${(b.storageKey || b.key || '').replace(/'/g, "\\'")}','')">
            🔄 Restaurar
          </button>
        </div>
      </div>
    `).join('');
  }

  // ─── ACCIÓN: Crear respaldo local ────────────────────────────────────────────
  async function crearLocal() {
    if (_uploading) return;
    _uploading = true;
    try {
      setProgress('Construyendo respaldo…', 'info');

      let carpetaDestino = null;
      if (ipcAvailable()) {
        // Pedir ruta al usuario mediante diálogo
        const dialogResult = await callIPC('backup:save-dialog', {
          defaultName: `TecnoCaja_Backup_${new Date().toISOString().slice(0,10)}.tcbak`,
        });
        if (dialogResult?.canceled || !dialogResult?.ok) {
          clearProgress();
          _uploading = false;
          return;
        }
        // Extraer carpeta de la ruta elegida
        carpetaDestino = dialogResult.filePath
          ? dialogResult.filePath.replace(/[/\\][^/\\]*$/, '')
          : null;
      }

      setProgress('Cifrando y comprimiendo…', 'info');
      const data = await _req('/api/respaldos/crear-local', {
        method: 'POST',
        body: JSON.stringify({ carpetaDestino }),
      });

      setProgress(`✅ Respaldo creado: ${data.fileName} (${fmt(data.fileSize)})`, 'success');
      showToast(`✅ Respaldo creado: ${data.fileName}`, 'success');
      await cargarEstado();
    } catch (e) {
      setProgress(`❌ Error: ${e.message}`, 'error');
      showToast(`Error al crear respaldo: ${e.message}`, 'danger');
    } finally {
      _uploading = false;
      setTimeout(clearProgress, 6000);
    }
  }

  // ─── ACCIÓN: Subir a la nube ─────────────────────────────────────────────────
  async function subirNube() {
    if (_uploading) return;
    _uploading = true;
    try {
      setProgress('Creando respaldo y subiendo a la nube (R2)…', 'info');
      const data = await _req('/api/respaldos/subir-nube', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setProgress(`✅ Subido a nube: ${data.fileName} (${fmt(data.fileSize)})`, 'success');
      showToast(`☁️ Respaldo subido a la nube: ${data.fileName}`, 'success');
      await cargarEstado();
      await cargarListaNube();
    } catch (e) {
      setProgress(`❌ Error: ${e.message}`, 'error');
      showToast(`Error al subir respaldo: ${e.message}`, 'danger');
    } finally {
      _uploading = false;
      setTimeout(clearProgress, 6000);
    }
  }

  /** Subir un archivo local ya existente a la nube */
  async function subirArchivoNube(filePath) {
    if (_uploading) return;
    _uploading = true;
    try {
      setProgress('Subiendo respaldo existente a la nube (R2)…', 'info');
      const data = await _req('/api/respaldos/subir-nube', {
        method: 'POST',
        body: JSON.stringify({ filePath }),
      });
      setProgress(`✅ Subido: ${data.fileName}`, 'success');
      showToast(`☁️ Subido a nube: ${data.fileName}`, 'success');
      await cargarEstado();
      await cargarListaNube();
    } catch (e) {
      setProgress(`❌ ${e.message}`, 'error');
      showToast(`Error: ${e.message}`, 'danger');
    } finally {
      _uploading = false;
      setTimeout(clearProgress, 5000);
    }
  }

  // ─── ACCIÓN: Restaurar desde archivo local (con diálogo) ─────────────────────
  async function restaurarDesdeLocal() {
    let base64, fileName;

    if (ipcAvailable()) {
      const result = await callIPC('backup:open-dialog');
      if (!result?.ok || result.canceled) return;
      base64    = result.base64;
      fileName  = result.fileName;
    } else {
      // Fallback: input[type=file] oculto
      const input = document.getElementById('rb-file-input');
      if (!input) return;
      input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const buffer = await file.arrayBuffer();
        const b64    = btoa(String.fromCharCode(...new Uint8Array(buffer)));
        await _doRestaurarLocal(b64, file.name);
        input.value = '';
      };
      input.click();
      return;
    }

    await _doRestaurarLocal(base64, fileName);
  }

  async function restaurarDesdeArchivoLocal(filePath) {
    if (!filePath) return;
    const ok = await confirmRestaurar(`Restaurar desde:\n${filePath}\n\n⚠️ Se creará un respaldo del estado actual antes de restaurar.`);
    if (!ok) return;
    await _doRestaurarLocal(null, null, filePath);
  }

  async function _doRestaurarLocal(base64, fileName, filePath) {
    if (!base64 && !filePath) return;
    const ok = await confirmRestaurar(
      `¿Restaurar el sistema desde "${fileName || filePath}"?\n\n` +
      `⚠️ Se creará un respaldo automático del estado actual antes de restaurar.\n` +
      `El sistema se reiniciará al completar.`
    );
    if (!ok) return;

    try {
      setProgress('Validando archivo…', 'info');
      const data = await _req('/api/respaldos/restaurar-local', {
        method: 'POST',
        body: JSON.stringify({ base64, filePath, fileName }),
      });

      setProgress('✅ Restauración completada. Reiniciando…', 'success');
      showToast('✅ Negocio restaurado. Reiniciando…', 'success');

      // Reiniciar app
      setTimeout(async () => {
        if (ipcAvailable()) await callIPC('app:restart');
        else location.reload();
      }, 2500);
    } catch (e) {
      setProgress(`❌ Error: ${e.message}`, 'error');
      showToast(`Error al restaurar: ${e.message}`, 'danger');
    }
  }

  // ─── ACCIÓN: Cargar lista de respaldos en la nube ────────────────────────────
  async function cargarListaNube() {
    try {
      const data = await _req('/api/respaldos/lista-nube');
      renderListaNube(data.backups || []);
    } catch (e) {
      const el = document.getElementById('rb-lista-nube');
      if (el) el.innerHTML = `<div class="rb-empty-row">Error: ${e.message}</div>`;
    }
  }

  // ─── ACCIÓN: Restaurar desde la nube ────────────────────────────────────────
  async function restaurarDesdeNube(storageKey, sha256) {
    if (!storageKey) return;
    const fileName = storageKey.split('/').pop() || storageKey;
    const ok = await confirmRestaurar(
      `¿Restaurar desde la nube?\n\nArchivo: ${fileName}\n\n` +
      `⚠️ Se creará un respaldo del estado actual antes de restaurar.\n` +
      `El sistema se reiniciará al completar.`
    );
    if (!ok) return;

    try {
      setProgress('Descargando desde R2…', 'info');
      const data = await _req('/api/respaldos/restaurar-nube', {
        method: 'POST',
        body: JSON.stringify({ storageKey, sha256Esperado: sha256 || undefined }),
      });

      setProgress('✅ Restauración desde nube completada. Reiniciando…', 'success');
      showToast('✅ Negocio restaurado desde nube. Reiniciando…', 'success');

      setTimeout(async () => {
        if (ipcAvailable()) await callIPC('app:restart');
        else location.reload();
      }, 2500);
    } catch (e) {
      setProgress(`❌ Error: ${e.message}`, 'error');
      showToast(`Error al restaurar desde nube: ${e.message}`, 'danger');
    }
  }

  // ─── ACCIÓN: Guardar config automática ───────────────────────────────────────
  async function guardarAutoConfig() {
    try {
      const config = {
        backup_auto_diario:      document.getElementById('rb-cfg-auto-diario')?.checked     ? '1' : '0',
        backup_auto_semanal:     document.getElementById('rb-cfg-auto-semanal')?.checked    ? '1' : '0',
        backup_al_cerrar_caja:   document.getElementById('rb-cfg-cerrar-caja')?.checked     ? '1' : '0',
        backup_nube_auto:        document.getElementById('rb-cfg-nube-auto')?.checked       ? '1' : '0',
        backup_antes_actualizar: document.getElementById('rb-cfg-antes-actualizar')?.checked? '1' : '0',
        backup_antes_restaurar:  document.getElementById('rb-cfg-antes-restaurar')?.checked ? '1' : '0',
        backup_dir_personalizado: document.getElementById('rb-cfg-dir')?.value || '',
      };
      await _req('/api/respaldos/config', {
        method: 'PUT',
        body: JSON.stringify(config),
      });
      showToast('✅ Configuración de respaldo guardada.', 'success');
    } catch (e) {
      showToast(`Error: ${e.message}`, 'danger');
    }
  }

  // ─── ACCIÓN: Subir respaldos pendientes ─────────────────────────────────────
  async function subirPendientes() {
    try {
      setProgress('Subiendo respaldos pendientes…', 'info');
      const data = await _req('/api/respaldos/subir-pendientes', { method: 'POST', body: JSON.stringify({}) });
      const { subidos, resultados } = data;
      setProgress(`✅ ${subidos} respaldo(s) pendiente(s) subidos.`, 'success');
      showToast(`☁️ ${subidos} respaldo(s) sincronizados con la nube.`, 'success');
      if (resultados?.some(r => !r.ok)) {
        console.warn('[respaldos] Algunos pendientes fallaron:', resultados.filter(r => !r.ok));
      }
      await cargarEstado();
    } catch (e) {
      setProgress(`❌ ${e.message}`, 'error');
      showToast(`Error: ${e.message}`, 'danger');
    } finally {
      setTimeout(clearProgress, 5000);
    }
  }

  // ─── ACCIÓN: Subir archivo .tcbak desde disco a la nube ────────────────────
  async function subirArchivoDesdePC() {
    if (_uploading) return;

    if (ipcAvailable()) {
      // Electron: diálogo nativo de apertura de archivo
      const result = await callIPC('backup:open-dialog');
      if (!result?.ok || result.canceled) return;
      await _doSubirArchivoB64(result.base64, result.fileName);
    } else {
      // Navegador: input[type=file] oculto
      const input = document.getElementById('rb-upload-input');
      if (!input) return;
      input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const buffer = await file.arrayBuffer();
        // btoa en lotes para no romper el stack con archivos grandes
        const bytes  = new Uint8Array(buffer);
        let b64 = '';
        const chunk = 8192;
        for (let i = 0; i < bytes.length; i += chunk) {
          b64 += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        b64 = btoa(b64);
        await _doSubirArchivoB64(b64, file.name);
        input.value = '';
      };
      input.click();
    }
  }

  /** Envía el archivo ya convertido a base64 al endpoint de upload */
  async function _doSubirArchivoB64(base64, fileName) {
    if (_uploading) return;
    _uploading = true;
    _setUploadStatus(`⏳ Subiendo "${fileName}"…`, 'info');
    try {
      setProgress(`Subiendo "${fileName}" a la nube…`, 'info');
      const data = await _req('/api/respaldos/subir-archivo', {
        method: 'POST',
        body: JSON.stringify({ base64, fileName }),
      });
      const msg = `✅ ${data.fileName} (${fmt(data.fileSize)}) subido a la nube.`;
      setProgress(msg, 'success');
      _setUploadStatus(msg, 'success');
      showToast(`☁️ Archivo subido: ${data.fileName}`, 'success');
      await cargarEstado();
      await cargarListaNube();
    } catch (e) {
      const msg = `❌ Error: ${e.message}`;
      setProgress(msg, 'error');
      _setUploadStatus(msg, 'error');
      showToast(`Error al subir archivo: ${e.message}`, 'danger');
    } finally {
      _uploading = false;
      setTimeout(() => {
        clearProgress();
        _setUploadStatus('', '');
      }, 7000);
    }
  }

  /** Actualiza el área de estado del upload */
  function _setUploadStatus(msg, type) {
    const el = document.getElementById('rb-upload-status');
    if (!el) return;
    if (!msg) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    el.classList.remove('hidden');
    el.className = `rb-upload-status rb-upload-status--${type}`;
    el.textContent = msg;
  }

  // ─── Drag & Drop para el upload zone ────────────────────────────────────────
  function uploadDragOver(e) {
    e.preventDefault();
    document.getElementById('rb-upload-area')?.classList.add('rb-upload-area--over');
  }

  function uploadDragLeave(e) {
    // Solo quitar la clase si el cursor salió del contenedor (no de un hijo)
    const area = document.getElementById('rb-upload-area');
    if (!area) return;
    if (!area.contains(e.relatedTarget)) {
      area.classList.remove('rb-upload-area--over');
    }
  }

  async function uploadDrop(e) {
    e.preventDefault();
    document.getElementById('rb-upload-area')?.classList.remove('rb-upload-area--over');
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.tcbak') && !file.name.endsWith('.novaseguro')) {
      showToast('Solo se aceptan archivos .tcbak o .novaseguro', 'warning');
      return;
    }
    const buffer = await file.arrayBuffer();
    const bytes  = new Uint8Array(buffer);
    let b64 = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      b64 += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    b64 = btoa(b64);
    await _doSubirArchivoB64(b64, file.name);
  }

  // ─── ACCIÓN: Abrir carpeta de respaldos ─────────────────────────────────────
  async function abrirCarpeta() {
    const dir = _estado?.backupDir;
    if (ipcAvailable()) {
      const r = await callIPC('backup:open-folder', dir);
      if (!r?.ok) showToast(r?.error || 'No se pudo abrir la carpeta.', 'danger');
    } else {
      showToast('Solo disponible en la aplicación de escritorio.', 'info');
    }
  }

  // ─── Confirmación modal ──────────────────────────────────────────────────────
  function confirmRestaurar(message) {
    return new Promise(resolve => {
      // Intentar usar el modal de confirmación del sistema
      if (typeof showConfirmModal === 'function') {
        showConfirmModal({
          title:     '⚠️ Confirmar restauración',
          message,
          onConfirm: () => resolve(true),
          onCancel:  () => resolve(false),
        });
      } else {
        resolve(window.confirm(message));
      }
    });
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────
  async function init() {
    await cargarEstado();
    // Cargar lista nube si está disponible
    if (_estado?.nubeDisponible) {
      await cargarListaNube();
    }
  }

  // API pública
  return {
    init,
    crearLocal,
    subirNube,
    subirArchivoNube,
    subirArchivoDesdePC,
    subirPendientes,
    restaurarDesdeLocal,
    restaurarDesdeArchivoLocal,
    restaurarDesdeNube,
    cargarListaNube,
    guardarAutoConfig,
    abrirCarpeta,
    // drag & drop handlers
    uploadDragOver,
    uploadDragLeave,
    uploadDrop,
  };
})();

// Exponer globalmente para los botones onclick del HTML
window.RespaldosMod = RespaldosMod;
