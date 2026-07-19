/* ============================================================
   Tecno Caja — Centro de Etiquetas (Label Manager) v1
   Impresión rápida, impresión masiva, botón desde ficha de
   producto e historial. Plantillas fijas (sin editor visual
   libre) e impresión vía diálogo nativo de Windows.
   ============================================================ */

(function () {
  'use strict';

  const TAMANOS = {
    '30x20': { label: '30 × 20 mm (grilla A4)', widthMm: 30, heightMm: 20 },
    '50x30': { label: '50 × 30 mm (grilla A4)', widthMm: 50, heightMm: 30 },
  };

  const LM = {
    tab: 'rapida',
    templates: [],
    quick: { product: null, templateId: null, cantidad: 1 },
    bulk: { results: [], qty: {}, templateId: null },
    history: [],
  };

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function toastMsg(msg, type) { if (typeof showToast === 'function') showToast(msg, type); }
  function money(n) { return `RD$${Number(n || 0).toFixed(2)}`; }

  function getAuthHeaders() {
    let tok = '';
    if (typeof getTecnoCajaAuthToken === 'function') tok = getTecnoCajaAuthToken();
    else if (typeof DB !== 'undefined' && DB.authToken) tok = DB.authToken;
    if (tok) return { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
    return { 'Content-Type': 'application/json' };
  }

  async function labelsApi(method, path, body) {
    const r = await fetch(path, {
      method,
      headers: getAuthHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
    return data;
  }
  function labelsGet(path) { return labelsApi('GET', path); }

  // ── Tabs ─────────────────────────────────────────────────────────────────
  window.labelsSwitchTab = function (tab) {
    LM.tab = tab;
    document.querySelectorAll('#module-labels .labels-tab').forEach((b) => b.classList.toggle('active', b.dataset.labelstab === tab));
    document.querySelectorAll('#module-labels .labels-pane').forEach((p) => {
      const isActive = p.id === `labels-tab-${tab}`;
      p.classList.toggle('active', isActive);
      p.classList.toggle('hidden', !isActive);
    });
    if (tab === 'plantillas') labelsRenderTemplatesGallery();
    if (tab === 'historial') labelsLoadHistory();
  };

  let _initialized = false;
  async function labelsInit() {
    if (_initialized) return;
    _initialized = true;
    await labelsLoadTemplates();
  }

  async function labelsLoadTemplates() {
    try {
      LM.templates = await labelsGet('/api/labels/templates?activa=1');
      labelsFillTemplateSelects();
    } catch (e) {
      toastMsg(e.message, 'error');
    }
  }

  function labelsFillTemplateSelects() {
    const options = LM.templates.map((t) => `<option value="${t.id}">${esc(t.nombre)} (${esc(TAMANOS[t.tamanoKey]?.label || t.tamanoKey)})</option>`).join('');
    ['labels-quick-template', 'labels-bulk-template'].forEach((id) => {
      const sel = el(id);
      if (!sel) return;
      const prev = sel.value;
      sel.innerHTML = options;
      if (prev && LM.templates.some((t) => String(t.id) === prev)) sel.value = prev;
    });
    if (!LM.quick.templateId && LM.templates[0]) {
      LM.quick.templateId = LM.templates[0].id;
      if (el('labels-quick-template')) el('labels-quick-template').value = LM.quick.templateId;
    }
    if (!LM.bulk.templateId && LM.templates[0]) {
      LM.bulk.templateId = LM.templates[0].id;
      if (el('labels-bulk-template')) el('labels-bulk-template').value = LM.bulk.templateId;
    }
    labelsQuickSyncFieldControls();
  }

  // ── Personalización de campos (Impresión rápida) ─────────────────────────
  // Controles inline de mostrar/ocultar + tamaño de letra para nombre,
  // precio y código, sobre la plantilla elegida — no crean una plantilla
  // nueva, solo sobreescriben camposConfig en memoria para esta impresión.
  const QUICK_FIELD_CONTROLS = [
    { showId: 'labels-quick-show-nombre', showKey: 'mostrarNombre', sizeId: 'labels-quick-size-nombre', sizeKey: 'fuenteNombrePx', sizeDefault: 10 },
    { showId: 'labels-quick-show-precio', showKey: 'mostrarPrecio', sizeId: 'labels-quick-size-precio', sizeKey: 'fuentePrecioPx', sizeDefault: 16 },
    { showId: 'labels-quick-show-codigo', showKey: 'mostrarCodigo', sizeId: 'labels-quick-size-codigo', sizeKey: 'fuenteCodigoPx', sizeDefault: 8 },
  ];

  function labelsQuickSyncFieldControls() {
    const t = LM.templates.find((x) => x.id === LM.quick.templateId) || LM.templates[0];
    const cfg = t?.camposConfig || {};
    QUICK_FIELD_CONTROLS.forEach(({ showId, showKey, sizeId, sizeKey, sizeDefault }) => {
      const showEl = el(showId);
      const sizeEl = el(sizeId);
      if (showEl) showEl.checked = Boolean(cfg[showKey]);
      if (sizeEl) sizeEl.value = cfg[sizeKey] || sizeDefault;
    });
  }

  function labelsQuickGetEffectiveTemplate() {
    const base = LM.templates.find((t) => t.id === LM.quick.templateId) || LM.templates[0];
    if (!base) return null;
    const cfg = { ...base.camposConfig };
    QUICK_FIELD_CONTROLS.forEach(({ showId, showKey, sizeId, sizeKey }) => {
      const showEl = el(showId);
      const sizeEl = el(sizeId);
      if (showEl) cfg[showKey] = showEl.checked;
      if (sizeEl && sizeEl.value) cfg[sizeKey] = Math.max(6, Number(sizeEl.value) || cfg[sizeKey]);
    });
    return { ...base, camposConfig: cfg };
  }

  window.labelsQuickOnTemplateChange = function () {
    LM.quick.templateId = Number(el('labels-quick-template')?.value) || null;
    labelsQuickSyncFieldControls();
    labelsQuickRenderPreview();
  };

  function labelsRenderTemplatesGallery() {
    const wrap = el('labels-templates-gallery');
    if (!wrap) return;
    wrap.innerHTML = LM.templates.map((t) => `
      <div class="labels-template-card">
        <div class="labels-template-card-head">
          <strong>${esc(t.nombre)}</strong>
          ${t.esSistema ? '<span class="badge">Predefinida</span>' : ''}
        </div>
        <p>${esc(t.descripcion || '')}</p>
        <small>Tamaño: ${esc(TAMANOS[t.tamanoKey]?.label || t.tamanoKey)}</small>
      </div>`).join('') || '<p style="padding:12px;color:var(--text3)">Sin plantillas.</p>';
  }

  // ── Normalización de producto (cache-search u objeto DB.productos) ───────
  function normalizeProductForLabel(p) {
    return {
      id: p.id,
      codigo: p.codigo || '',
      barcode: p.barcode || p.codigo || '',
      nombre: p.nombre || '',
      categoria: p.categoria || '',
      marca: p.marca || '',
      precioVenta: Number(p.precioVenta ?? p.precio_venta ?? 0),
    };
  }

  // ── Impresión rápida ─────────────────────────────────────────────────────
  let _quickSearchTimer = null;
  window.labelsQuickSearchInput = function () {
    clearTimeout(_quickSearchTimer);
    _quickSearchTimer = setTimeout(labelsQuickSearch, 250);
  };

  async function labelsQuickSearch() {
    const q = el('labels-quick-search')?.value.trim() || '';
    const box = el('labels-quick-results');
    if (!box) return;
    if (!q) { box.innerHTML = ''; return; }
    try {
      const data = await labelsGet(`/api/products/cache-search?q=${encodeURIComponent(q)}&limit=15`);
      const products = data.products || [];
      box.innerHTML = products.map((p) => `
        <div class="labels-search-row" onclick='labelsQuickSelect(${JSON.stringify(normalizeProductForLabel(p)).replace(/'/g, "&#39;")})'>
          <span>${esc(p.nombre)}</span>
          <small>${esc(p.codigo)} · ${money(p.precioVenta)}</small>
        </div>`).join('') || '<div class="labels-search-row" style="color:var(--text3)">Sin resultados.</div>';
    } catch (e) {
      box.innerHTML = `<div class="labels-search-row" style="color:#f87171">${esc(e.message)}</div>`;
    }
  }

  window.labelsQuickSelect = function (product) {
    LM.quick.product = product;
    if (el('labels-quick-search')) el('labels-quick-search').value = product.nombre;
    if (el('labels-quick-results')) el('labels-quick-results').innerHTML = '';
    labelsQuickRenderPreview();
  };

  window.labelsQuickOnConfigChange = function () {
    LM.quick.cantidad = Math.max(1, Number(el('labels-quick-cantidad')?.value) || 1);
    labelsQuickRenderPreview();
  };

  window.labelsQuickRenderPreview = async function labelsQuickRenderPreview() {
    const container = el('labels-quick-preview');
    if (!container) return;
    if (!LM.quick.product) {
      container.innerHTML = '<p style="color:var(--text3);padding:12px">Busca y selecciona un producto para ver la vista previa.</p>';
      return;
    }
    const template = labelsQuickGetEffectiveTemplate();
    if (!template) { container.innerHTML = '<p style="color:var(--text3);padding:12px">No hay plantillas disponibles.</p>'; return; }
    const lineas = [{ ...LM.quick.product, cantidad: LM.quick.cantidad }];
    await labelsRenderGrid(container, lineas, template);
  };

  window.labelsQuickPrint = async function () {
    if (!LM.quick.product) { toastMsg('Selecciona un producto primero.', 'warning'); return; }
    const template = labelsQuickGetEffectiveTemplate();
    if (!template) { toastMsg('No hay plantillas disponibles.', 'warning'); return; }
    const container = el('labels-quick-preview');
    await labelsQuickRenderPreview();
    await labelsPrintContainerAndLog(container, template, [{
      productId: LM.quick.product.id,
      codigo: LM.quick.product.codigo,
      nombreSnapshot: LM.quick.product.nombre,
      cantidad: LM.quick.cantidad,
      precioVenta: LM.quick.product.precioVenta,
      marca: LM.quick.product.marca,
      categoria: LM.quick.product.categoria,
      barcode: LM.quick.product.barcode,
    }], 'rapida');
  };

  window.labelsQuickSavePdf = async function () {
    if (!LM.quick.product) { toastMsg('Selecciona un producto primero.', 'warning'); return; }
    const template = labelsQuickGetEffectiveTemplate();
    if (!template) { toastMsg('No hay plantillas disponibles.', 'warning'); return; }
    if (!window.novaDesktop?.saveLabelsPdf) {
      toastMsg('Disponible solo en la app de escritorio.', 'warning');
      return;
    }
    const container = el('labels-quick-preview');
    await labelsQuickRenderPreview();
    try {
      const result = await window.novaDesktop.saveLabelsPdf(container.innerHTML, { tamanoKey: template.tamanoKey });
      if (result?.canceled) return;
      if (!result?.ok) { toastMsg(result?.error || 'No se pudo guardar el PDF.', 'error'); return; }
      toastMsg('PDF guardado: ' + result.filePath, 'success');
    } catch (e) {
      toastMsg(e.message, 'error');
    }
  };

  // ── Impresión masiva ─────────────────────────────────────────────────────
  let _bulkSearchTimer = null;
  window.labelsBulkSearchInput = function () {
    clearTimeout(_bulkSearchTimer);
    _bulkSearchTimer = setTimeout(labelsBulkSearch, 250);
  };

  async function labelsBulkSearch() {
    const q = el('labels-bulk-search')?.value.trim() || '';
    try {
      const data = await labelsGet(`/api/products/cache-search?q=${encodeURIComponent(q)}&limit=100`);
      LM.bulk.results = (data.products || []).map(normalizeProductForLabel);
      labelsRenderBulkTable();
    } catch (e) {
      toastMsg(e.message, 'error');
    }
  }

  function labelsRenderBulkTable() {
    const tbody = el('labels-bulk-body');
    if (!tbody) return;
    tbody.innerHTML = LM.bulk.results.map((p) => `
      <tr>
        <td>${esc(p.nombre)}</td>
        <td>${esc(p.codigo)}</td>
        <td>${money(p.precioVenta)}</td>
        <td style="width:110px">
          <input type="number" min="0" class="form-input" style="max-width:90px"
            value="${LM.bulk.qty[p.id] || ''}" placeholder="0"
            oninput="labelsBulkSetQty(${p.id}, this.value)">
        </td>
      </tr>`).join('') || '<tr><td colspan="4" style="padding:12px;color:var(--text3)">Busca productos para agregarlos.</td></tr>';
  }

  window.labelsBulkSetQty = function (productId, value) {
    const n = Math.max(0, Number(value) || 0);
    if (n > 0) LM.bulk.qty[productId] = n;
    else delete LM.bulk.qty[productId];
  };

  window.labelsBulkOnTemplateChange = function () {
    LM.bulk.templateId = Number(el('labels-bulk-template')?.value) || null;
  };

  window.labelsBulkPrintAll = async function () {
    const entries = Object.entries(LM.bulk.qty).filter(([, qty]) => qty > 0);
    if (!entries.length) { toastMsg('Indica cantidad para al menos un producto.', 'warning'); return; }
    const template = LM.templates.find((t) => t.id === LM.bulk.templateId) || LM.templates[0];
    if (!template) { toastMsg('No hay plantillas disponibles.', 'warning'); return; }

    const lineas = entries.map(([id, cantidad]) => {
      const p = LM.bulk.results.find((r) => String(r.id) === String(id));
      return p ? { ...p, cantidad } : null;
    }).filter(Boolean);
    if (!lineas.length) { toastMsg('No se encontraron los productos seleccionados.', 'warning'); return; }

    const buffer = document.createElement('div');
    await labelsRenderGrid(buffer, lineas, template);
    await labelsPrintContainerAndLog(buffer, template, lineas.map((l) => ({
      productId: l.id, codigo: l.codigo, nombreSnapshot: l.nombre, cantidad: l.cantidad,
      precioVenta: l.precioVenta, marca: l.marca, categoria: l.categoria, barcode: l.barcode,
    })), 'masiva');
  };

  // ── Render de etiquetas (compartido) ─────────────────────────────────────
  // Impresora térmica de etiquetas dedicada: cada etiqueta es su PROPIA
  // página (mismo tamaño que @page en electron/main.js resolveLabelLayout),
  // no una grilla de varias etiquetas en una hoja A4. El salto de página
  // entre etiquetas hace que la impresora avance el rollo automáticamente.
  function buildLabelHtmlSkeleton(lineas, template) {
    const tamano = TAMANOS[template.tamanoKey] || TAMANOS['50x30'];
    const cfg = template.camposConfig || {};
    const labels = [];
    lineas.forEach((l) => {
      for (let i = 0; i < (Number(l.cantidad) || 0); i++) {
        labels.push(`
          <div class="lm-label" style="width:${tamano.widthMm}mm;height:${tamano.heightMm}mm">
            ${cfg.mostrarNombre ? `<div class="lm-f-nombre" style="font-size:${cfg.fuenteNombrePx || 10}px">${esc(l.nombre)}</div>` : ''}
            ${cfg.mostrarMarca ? `<div class="lm-f-marca" style="font-size:${cfg.fuenteMarcaPx || 8}px">${esc(l.marca)}</div>` : ''}
            ${cfg.mostrarCategoria ? `<div class="lm-f-categoria" style="font-size:${cfg.fuenteCategoriaPx || 7}px">${esc(l.categoria)}</div>` : ''}
            ${cfg.mostrarPrecio ? `<div class="lm-f-precio" style="font-size:${cfg.fuentePrecioPx || 16}px;font-weight:700">${money(l.precioVenta)}</div>` : ''}
            ${cfg.mostrarCodigo ? `<div class="lm-f-codigo" style="font-size:${cfg.fuenteCodigoPx || 8}px">${esc(l.codigo)}</div>` : ''}
            ${cfg.mostrarBarcode ? `<svg class="lm-barcode" data-code="${esc(l.barcode || l.codigo)}"></svg>` : ''}
            ${cfg.mostrarQR ? `<img class="lm-qr" data-code="${esc(l.barcode || l.codigo)}" alt="QR">` : ''}
          </div>`);
      }
    });
    return `<style>
      .lm-labels { display:flex; flex-direction:column; gap:2mm; }
      .lm-label { border:1px dashed #9ca3af; padding:1mm; box-sizing:border-box; display:flex; flex-direction:column;
        align-items:center; justify-content:center; text-align:center; overflow:hidden; font-family:Arial,sans-serif; color:#111827;
        page-break-after:always; break-after:page; page-break-inside:avoid; break-inside:avoid; }
      .lm-label:last-child { page-break-after:auto; break-after:auto; }
      .lm-label > div { line-height:1.15; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .lm-barcode { max-width:95%; height:9mm; }
      .lm-qr { width:12mm; height:12mm; }
      /* La vista previa en pantalla se muestra en una grilla de 4 columnas;
         al imprimir cada etiqueta sigue siendo su propia página (ver arriba). */
      @media screen { .lm-labels { display:grid; grid-template-columns:repeat(4, 1fr); gap:6px; } }
      @media print { .lm-labels { gap:0; } .lm-label { border:none; } }
    </style>
    <div class="lm-labels">${labels.join('')}</div>`;
  }

  async function labelsHydrateExtras(containerEl) {
    const barcodeEls = containerEl.querySelectorAll('.lm-barcode');
    barcodeEls.forEach((svgEl) => {
      const code = svgEl.dataset.code;
      if (!code || typeof JsBarcode !== 'function') return;
      try {
        JsBarcode(svgEl, code, { format: 'CODE128', displayValue: false, margin: 0, height: 40, width: 1.6 });
      } catch (_e) { /* código no compatible con CODE128, se deja vacío */ }
    });

    const qrEls = Array.from(containerEl.querySelectorAll('.lm-qr'));
    const uniqueCodes = [...new Set(qrEls.map((img) => img.dataset.code).filter(Boolean))];
    const qrCache = {};
    for (const code of uniqueCodes) {
      try {
        const res = await api.generateQr(code);
        qrCache[code] = res?.dataUrl || res?.qr || res?.data || '';
      } catch (_e) { qrCache[code] = ''; }
    }
    qrEls.forEach((img) => {
      const src = qrCache[img.dataset.code];
      if (src) img.src = src;
    });
  }

  async function labelsRenderGrid(containerEl, lineas, template) {
    containerEl.innerHTML = buildLabelHtmlSkeleton(lineas, template);
    await labelsHydrateExtras(containerEl);
    return containerEl.innerHTML;
  }

  async function labelsPrintContainerAndLog(containerEl, template, lineas, modo) {
    if (!window.novaDesktop?.printLabelsHtml) {
      toastMsg('La impresión directa está disponible solo en la app de escritorio.', 'warning');
      return;
    }
    try {
      const effectiveCfg = typeof getEffectiveConfig === 'function' ? getEffectiveConfig() : (window.LocalPeripheralsFlat || {});
      const printerName = effectiveCfg.labelsPrinterName || '';
      const mode = effectiveCfg.labelsPrintMode || 'dialog';

      let result;
      if (mode === 'direct') {
        // Modo directo: comandos TSPL nativos (electron/tspl-printer.js) en vez
        // de Chromium — Chromium descarta tamaños de página tan pequeños.
        result = await window.novaDesktop.printLabelsDirect({
          tamanoKey: template.tamanoKey,
          camposConfig: template.camposConfig,
          printerName,
          barcodeOffsetMm: Number(effectiveCfg.labelsBarcodeOffsetMm) || 0,
          lineas: lineas.map((l) => ({
            nombre: l.nombreSnapshot || l.nombre,
            precioVenta: l.precioVenta,
            codigo: l.codigo,
            barcode: l.barcode,
            marca: l.marca,
            categoria: l.categoria,
            cantidad: l.cantidad,
          })),
        });
      } else {
        const html = containerEl.innerHTML;
        result = await window.novaDesktop.printLabelsHtml(html, { tamanoKey: template.tamanoKey, printerName, mode });
      }
      if (!result?.ok) {
        toastMsg(result?.error || 'No se pudo imprimir las etiquetas.', 'error');
        return;
      }
      await labelsApi('POST', '/api/labels/print-log', {
        templateId: template.id,
        tamanoKey: template.tamanoKey,
        modo,
        lineas,
      });
      toastMsg('Etiquetas enviadas a impresión.', 'success');
      if (LM.tab === 'historial') labelsLoadHistory();
    } catch (e) {
      toastMsg(e.message, 'error');
    }
  }

  // ── Historial ────────────────────────────────────────────────────────────
  async function labelsLoadHistory() {
    const tbody = el('labels-history-body');
    try {
      LM.history = await labelsGet('/api/labels/print-log?limit=100');
      if (!tbody) return;
      tbody.innerHTML = LM.history.map((h) => `
        <tr>
          <td>${new Date(h.createdAt).toLocaleString('es-DO')}</td>
          <td>${esc(h.templateNombreSnapshot)}</td>
          <td>${esc(TAMANOS[h.tamanoKey]?.label || h.tamanoKey)}</td>
          <td>${h.totalProductos}</td>
          <td>${h.totalEtiquetas}</td>
          <td>${esc(h.usuarioNombreSnapshot)}</td>
          <td><button class="btn-secondary" style="padding:2px 10px;font-size:.78rem" onclick="labelsReprint(${h.id})">🖨 Reimprimir</button></td>
        </tr>`).join('') || '<tr><td colspan="7" style="padding:12px;color:var(--text3)">Sin impresiones registradas.</td></tr>';
    } catch (e) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="color:#f87171;padding:12px">${esc(e.message)}</td></tr>`;
    }
  }

  window.labelsReprint = async function (id) {
    try {
      const job = await labelsGet(`/api/labels/print-log/${id}`);
      let template = LM.templates.find((t) => t.id === job.templateId);
      if (!template) {
        template = await labelsGet(`/api/labels/templates/${job.templateId}`).catch(() => null);
      }
      if (!template) { toastMsg('La plantilla usada ya no existe.', 'error'); return; }
      const lineas = job.lineas.map((l) => ({
        id: l.productId, nombre: l.nombreSnapshot, codigo: l.codigo,
        cantidad: l.cantidad, precioVenta: l.precioVenta, marca: l.marca,
        categoria: l.categoria, barcode: l.barcode,
      }));
      const buffer = document.createElement('div');
      await labelsRenderGrid(buffer, lineas, template);
      await labelsPrintContainerAndLog(buffer, template, job.lineas, job.modo);
    } catch (e) {
      toastMsg(e.message, 'error');
    }
  };

  // ── Entrada desde la ficha de producto (Inventario) ─────────────────────
  window.openLabelQuickPrintForProduct = function (id) {
    const prod = (typeof DB !== 'undefined' ? DB.productos : []).find((p) => p.id === id);
    if (!prod) { toastMsg('Producto no encontrado.', 'error'); return; }
    if (typeof closeAllModals === 'function') closeAllModals();
    if (typeof showModule === 'function') {
      const navEl = document.querySelector('.nav-item[data-module="labels"]');
      showModule('labels', navEl);
    }
    labelsInit().then(() => {
      labelsSwitchTab('rapida');
      window.labelsQuickSelect(normalizeProductForLabel(prod));
    });
  };

  // ── Hook: activación del módulo ──────────────────────────────────────────
  const _origShowModule = window.showModule;
  window.showModule = function (mod, elm) {
    if (typeof _origShowModule === 'function') _origShowModule(mod, elm);
    if (mod === 'labels') labelsInit();
  };

  document.addEventListener('DOMContentLoaded', () => {
    const moduleEl = document.getElementById('module-labels');
    if (!moduleEl) return;
    const obs = new MutationObserver(() => {
      if (!moduleEl.classList.contains('hidden')) labelsInit();
    });
    obs.observe(moduleEl, { attributes: true, attributeFilter: ['class'] });
  });
})();
