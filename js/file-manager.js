/**
 * file-manager.js
 * Módulo frontend del gestor de archivos Sistema_Data de Tecno Caja.
 */

const FileManager = (() => {
  // ── Estado ─────────────────────────────────────────────────────────────────
  let state = {
    currentCategory: null,
    currentSub:      null,
    currentPage:     1,
    totalPages:      1,
    searchTerm:      '',
    startDate:       '',
    endDate:         '',
    diskStats:       null,
    loading:         false,
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const fmt = bytes => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B','KB','MB','GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(i > 1 ? 2 : 0)} ${sizes[i]}`;
  };
  const fmtDate = str => {
    if (!str) return '—';
    const d = new Date(str);
    return isNaN(d) ? str : d.toLocaleDateString('es-DO', { day:'2-digit', month:'short', year:'numeric' });
  };
  const fmtDateTime = str => {
    if (!str) return '—';
    const d = new Date(str);
    return isNaN(d) ? str : d.toLocaleString('es-DO', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
  };

  async function api(endpoint, opts = {}) {
    const res  = await fetch(`/api/files${endpoint}`, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    return res.json();
  }

  function showFMToast(msg, type = 'success') {
    if (typeof showToast === 'function') { showToast(msg, type); return; }
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `position:fixed;bottom:20px;right:20px;padding:10px 18px;border-radius:8px;font-size:14px;z-index:9999;color:#fff;background:${type==='error'?'#ef4444':type==='warning'?'#f59e0b':'#10b981'}`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    if (!$('fm-file-list')) return;
    await Promise.all([loadDiskStats(), loadTree(), loadFiles()]);
    bindSearch();
  }

  // ── Árbol de categorías ────────────────────────────────────────────────────
  async function loadTree() {
    const treeEl = $('fm-tree');
    if (!treeEl) return;
    try {
      const data = await api('/structure');
      if (!data.ok) return;
      treeEl.innerHTML = renderTree(data.tree);
    } catch (_) {}
  }

  function renderTree(nodes, depth = 0) {
    return nodes.map(node => {
      const hasChildren = node.children && node.children.length > 0;
      const subHtml     = hasChildren ? `<ul class="fm-subtree">${renderTree(node.children, depth + 1)}</ul>` : '';
      const icon        = depth === 0 ? getCategoryIcon(node.name) : '📂';
      return `
        <li class="fm-tree-item ${depth === 0 ? 'fm-tree-root' : ''}" data-cat="${node.name}" data-depth="${depth}">
          <span class="fm-tree-label" onclick="FileManager.selectCategory('${node.name}', ${depth === 0 ? 'null' : `'${node.name}'`}, ${depth})">
            <span class="fm-tree-icon">${icon}</span>
            <span>${node.label}</span>
          </span>
          ${subHtml}
        </li>`;
    }).join('');
  }

  function getCategoryIcon(name) {
    const icons = {
      Backups_Base_Datos: '💾', Inventario: '📦', Reportes: '📊',
      Facturas: '🧾', Clientes: '👥', Delivery: '🛵',
      Proveedores: '🚚', Exportaciones: '📤',
    };
    return icons[name] || '📁';
  }

  function selectCategory(name, sub, depth) {
    if (depth === 0) {
      state.currentCategory = name;
      state.currentSub      = null;
    } else {
      // El sub es el nombre del nodo → necesitamos buscar el padre
      // Por simplicidad, si depth > 0 el sub es el nombre y el cat es el padre
      // La UI pasa correctamente cat/sub desde el tree
      state.currentSub = name;
    }
    state.currentPage = 1;

    // Destacar activo
    document.querySelectorAll('.fm-tree-label').forEach(el => el.classList.remove('active'));
    const all = document.querySelectorAll('.fm-tree-item');
    all.forEach(el => {
      if (el.dataset.cat === name) el.querySelector('.fm-tree-label')?.classList.add('active');
    });

    loadFiles();
  }

  // Versión corregida para el HTML — recibe cat y sub explícitamente
  function selectCategoryExplicit(cat, sub) {
    state.currentCategory = cat || null;
    state.currentSub      = sub || null;
    state.currentPage     = 1;
    document.querySelectorAll('.fm-tree-label').forEach(el => el.classList.remove('active'));
    const key = sub || cat;
    document.querySelectorAll(`.fm-tree-item[data-cat="${key}"]`).forEach(el => {
      el.querySelector('.fm-tree-label')?.classList.add('active');
    });
    loadFiles();
  }

  // ── Carga de archivos ──────────────────────────────────────────────────────
  async function loadFiles() {
    if (state.loading) return;
    state.loading = true;
    const listEl = $('fm-file-list');
    if (listEl) listEl.innerHTML = '<tr><td colspan="6" class="fm-loading">Cargando...</td></tr>';

    try {
      const params = new URLSearchParams({
        page:  state.currentPage,
        limit: 40,
      });
      if (state.currentCategory) params.set('category', state.currentCategory);
      if (state.currentSub)      params.set('sub_category', state.currentSub);
      if (state.searchTerm)      params.set('term', state.searchTerm);
      if (state.startDate)       params.set('start_date', state.startDate);
      if (state.endDate)         params.set('end_date', state.endDate);

      const data = await api(`/list?${params}`);
      if (!data.ok) throw new Error(data.error);

      state.totalPages = data.totalPages || 1;
      renderFileList(data.files || [], data.total || 0, data.totalSize || 0);
      renderPagination();
    } catch (err) {
      if (listEl) listEl.innerHTML = `<tr><td colspan="6" class="fm-error">Error: ${err.message}</td></tr>`;
    } finally {
      state.loading = false;
    }
  }

  function renderFileList(files, total, totalSize) {
    const listEl   = $('fm-file-list');
    const countEl  = $('fm-file-count');
    const sizeEl   = $('fm-total-size');

    if (countEl) countEl.textContent = `${total} archivo${total !== 1 ? 's' : ''}`;
    if (sizeEl)  sizeEl.textContent  = fmt(totalSize);

    if (!files.length) {
      if (listEl) listEl.innerHTML = '<tr><td colspan="6" class="fm-empty">No hay archivos en esta categoría</td></tr>';
      return;
    }

    if (listEl) {
      listEl.innerHTML = files.map(f => {
        const exists = true; // asumimos que existe; la verificación real se hace al descargar
        const ext    = (f.file_name || '').split('.').pop().toLowerCase();
        const icon   = ext === 'pdf' ? '📄' : ext === 'zip' ? '🗜️' : '📎';
        return `
          <tr class="fm-row" data-id="${f.id}">
            <td><span class="fm-file-icon">${icon}</span> <span class="fm-file-name" title="${f.file_name}">${f.file_name}</span></td>
            <td><span class="fm-badge">${(f.category||'').replace(/_/g,' ')}</span></td>
            <td>${f.sub_category ? f.sub_category.replace(/_/g,' ') : '—'}</td>
            <td>${fmtDate(f.reference_date || f.created_at)}</td>
            <td class="fm-size">${fmt(f.file_size)}</td>
            <td class="fm-actions">
              <button class="fm-btn fm-btn-sm fm-btn-view"     onclick="FileManager.previewFile(${f.id})"    title="Ver">👁</button>
              <button class="fm-btn fm-btn-sm fm-btn-download" onclick="FileManager.downloadFile(${f.id})"  title="Descargar">⬇</button>
              <button class="fm-btn fm-btn-sm fm-btn-delete"   onclick="FileManager.deleteFile(${f.id}, '${f.file_name}')"   title="Eliminar">🗑</button>
            </td>
          </tr>`;
      }).join('');
    }
  }

  function renderPagination() {
    const el = $('fm-pagination');
    if (!el) return;
    if (state.totalPages <= 1) { el.innerHTML = ''; return; }
    const prev = `<button class="fm-btn" onclick="FileManager.goPage(${state.currentPage - 1})" ${state.currentPage <= 1 ? 'disabled' : ''}>‹ Anterior</button>`;
    const next = `<button class="fm-btn" onclick="FileManager.goPage(${state.currentPage + 1})" ${state.currentPage >= state.totalPages ? 'disabled' : ''}>Siguiente ›</button>`;
    el.innerHTML = `${prev} <span class="fm-page-info">Página ${state.currentPage} de ${state.totalPages}</span> ${next}`;
  }

  function goPage(n) {
    if (n < 1 || n > state.totalPages) return;
    state.currentPage = n;
    loadFiles();
  }

  // ── Búsqueda ───────────────────────────────────────────────────────────────
  function bindSearch() {
    const searchEl = $('fm-search');
    const startEl  = $('fm-date-start');
    const endEl    = $('fm-date-end');

    if (searchEl) {
      let timer;
      searchEl.addEventListener('input', e => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          state.searchTerm  = e.target.value.trim();
          state.currentPage = 1;
          loadFiles();
        }, 400);
      });
    }
    if (startEl) startEl.addEventListener('change', e => { state.startDate = e.target.value; state.currentPage = 1; loadFiles(); });
    if (endEl)   endEl.addEventListener('change',   e => { state.endDate   = e.target.value; state.currentPage = 1; loadFiles(); });
  }

  function clearFilters() {
    state.searchTerm      = '';
    state.startDate       = '';
    state.endDate         = '';
    state.currentCategory = null;
    state.currentSub      = null;
    state.currentPage     = 1;
    const s = $('fm-search'), sd = $('fm-date-start'), ed = $('fm-date-end');
    if (s)  s.value  = '';
    if (sd) sd.value = '';
    if (ed) ed.value = '';
    document.querySelectorAll('.fm-tree-label').forEach(el => el.classList.remove('active'));
    loadFiles();
  }

  // ── Disco ──────────────────────────────────────────────────────────────────
  async function loadDiskStats() {
    try {
      const data = await api('/disk-stats');
      if (!data.ok) return;
      state.diskStats = data.stats;
      renderDiskStats(data.stats);
    } catch (_) {}
  }

  function renderDiskStats(stats) {
    const el = $('fm-disk-stats');
    if (!el || !stats) return;
    el.innerHTML = `
      <div class="fm-stat-card">
        <div class="fm-stat-value">${stats.totalSizeMB} MB</div>
        <div class="fm-stat-label">Usado en disco</div>
      </div>
      <div class="fm-stat-card">
        <div class="fm-stat-value">${stats.fileCount}</div>
        <div class="fm-stat-label">Archivos totales</div>
      </div>
      <div class="fm-stat-card fm-stat-card--path">
        <div class="fm-stat-label">Carpeta base</div>
        <div class="fm-stat-path" title="${stats.baseDir}">${stats.baseDir}</div>
      </div>`;
  }

  async function refreshDiskStats() {
    const btn = $('fm-refresh-stats');
    if (btn) btn.disabled = true;
    await loadDiskStats();
    if (btn) btn.disabled = false;
    showFMToast('Estadísticas actualizadas');
  }

  // ── Acciones de archivo ────────────────────────────────────────────────────
  function downloadFile(id) {
    window.open(`/api/files/download/${id}`, '_blank');
  }

  function previewFile(id) {
    const modal = $('fm-preview-modal');
    const frame = $('fm-preview-frame');
    if (modal && frame) {
      frame.src = `/api/files/preview/${id}`;
      modal.style.display = 'flex';
    } else {
      window.open(`/api/files/preview/${id}`, '_blank');
    }
  }

  function closePreview() {
    const modal = $('fm-preview-modal');
    const frame = $('fm-preview-frame');
    if (modal) modal.style.display = 'none';
    if (frame) frame.src = '';
  }

  async function deleteFile(id, name) {
    if (!confirm(`¿Eliminar el archivo "${name}"?\n\nSe marcará como eliminado.`)) return;
    try {
      const data = await api(`/${id}`, { method: 'DELETE' });
      if (data.ok) {
        showFMToast(`Archivo eliminado: ${data.fileName}`);
        loadFiles();
        loadDiskStats();
      } else {
        showFMToast(data.error || 'Error al eliminar', 'error');
      }
    } catch (err) {
      showFMToast(err.message, 'error');
    }
  }

  // ── Limpieza inteligente ───────────────────────────────────────────────────
  async function openCleanupModal() {
    const daysEl = $('fm-cleanup-days');
    const days   = daysEl ? parseInt(daysEl.value) || 365 : 365;
    const modal  = $('fm-cleanup-modal');
    const info   = $('fm-cleanup-info');

    if (info) info.innerHTML = 'Calculando archivos a limpiar...';
    if (modal) modal.style.display = 'flex';

    try {
      const data = await api(`/old?days=${days}`);
      let totalSize = 0;
      (data.files || []).forEach(f => { totalSize += f.file_size || 0; });
      if (info) {
        info.innerHTML = data.count > 0
          ? `Se encontraron <strong>${data.count}</strong> archivos con más de <strong>${days} días</strong> de antigüedad,
             ocupando <strong>${fmt(totalSize)}</strong> en disco.`
          : `No hay archivos con más de <strong>${days} días</strong> de antigüedad.`;
      }
    } catch (err) {
      if (info) info.innerHTML = `Error: ${err.message}`;
    }
  }

  function closeCleanupModal() {
    const modal = $('fm-cleanup-modal');
    if (modal) modal.style.display = 'none';
  }

  async function executeCleanup() {
    const daysEl = $('fm-cleanup-days');
    const days   = daysEl ? parseInt(daysEl.value) || 365 : 365;
    const btn    = $('fm-cleanup-exec');
    if (btn) btn.disabled = true;

    try {
      const data = await api('/cleanup', {
        method: 'POST',
        body:   JSON.stringify({ daysOld: days }),
      });
      closeCleanupModal();
      if (data.ok) {
        showFMToast(`Limpieza completada: ${data.deleted} archivos eliminados, ${data.errors} errores.`);
        loadFiles();
        loadDiskStats();
      } else {
        showFMToast(data.error || 'Error en la limpieza', 'error');
      }
    } catch (err) {
      showFMToast(err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ── API pública ────────────────────────────────────────────────────────────
  return {
    init,
    loadFiles,
    loadDiskStats,
    refreshDiskStats,
    selectCategory,
    selectCategoryExplicit,
    goPage,
    clearFilters,
    downloadFile,
    previewFile,
    closePreview,
    deleteFile,
    openCleanupModal,
    closeCleanupModal,
    executeCleanup,
  };
})();

// Auto-init cuando el módulo se activa
if (typeof window !== 'undefined') {
  window.FileManager = FileManager;
}
