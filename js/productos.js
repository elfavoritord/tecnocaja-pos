// ===== TECNO_CAJA - PRODUCTOS MODULE =====

const productFilters = {
  search: '',
  category: '',
  status: 'todos'
};
const inventoryFilters = {
  search: '',
  category: '',
  status: 'todos'
};

const productScannerState = {
  armed: false,
  buffer: '',
  timer: null
};

let _pendingProductImageDataUrl = null;
const reportAppProductSyncState = {
  running: false,
  timer: null,
  lastRunAt: 0
};

function isProductsSyncModuleActive() {
  const active = document.querySelector('.module.active');
  return active?.id === 'module-productos' || active?.id === 'module-inventario';
}

async function refreshProductsAfterReportAppSync() {
  const payload = await api.getBootstrap();
  if (payload) hydrateDB(payload);
  if (typeof refreshProductCategoryFilter === 'function') refreshProductCategoryFilter();
  if (typeof loadProductsTable === 'function') loadProductsTable();
  if (typeof loadInventoryTable === 'function') loadInventoryTable();
  if (typeof updateInventoryStats === 'function') updateInventoryStats();
  if (typeof renderSalesCatalog === 'function') renderSalesCatalog();
  if (typeof updateNotifications === 'function') updateNotifications();
}

async function syncReportAppProductsNow(options = {}) {
  const {
    silent = true,
    force = false,
    minIntervalMs = 8000
  } = options;
  const now = Date.now();
  if (reportAppProductSyncState.running) return { skipped: true, reason: 'running' };
  if (minIntervalMs > 0 && now - reportAppProductSyncState.lastRunAt < minIntervalMs) {
    return { skipped: true, reason: 'too-soon' };
  }
  reportAppProductSyncState.running = true;
  reportAppProductSyncState.lastRunAt = now;
  try {
    const result = await api.syncReportAppProducts({ force });
    if (Number(result?.synced || 0) > 0) {
      await refreshProductsAfterReportAppSync();
      showToast(`${result.synced} producto(s) recibido(s) desde la App de Reporte.`, 'success');
    } else if (!silent) {
      if (typeof refreshProductCategoryFilter === 'function') refreshProductCategoryFilter();
      if (typeof loadProductsTable === 'function') loadProductsTable();
      showToast('Inventario sincronizado. No hay productos nuevos pendientes.', 'info');
    }
    if (Number(result?.errors || 0) > 0 && !silent) {
      showToast(`${result.errors} producto(s) no pudieron sincronizarse. Revisa el log.`, 'warning');
    }
    return result;
  } catch (error) {
    if (!silent) {
      showToast(error?.message || 'No se pudo consultar productos de la App de Reporte.', 'warning');
    }
    return { ok: false, error: error?.message || String(error) };
  } finally {
    reportAppProductSyncState.running = false;
  }
}

function startReportAppProductsPolling() {
  if (reportAppProductSyncState.timer) return;
  reportAppProductSyncState.timer = setInterval(() => {
    if (!isProductsSyncModuleActive()) return;
    syncReportAppProductsNow({ silent: true, minIntervalMs: 25000 });
  }, 30000);
}

window.syncReportAppProductsNow = syncReportAppProductsNow;
window.startReportAppProductsPolling = startReportAppProductsPolling;

function handleProductImageSelect(input) {
  const file = input?.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { showToast('Selecciona un archivo de imagen válido', 'error'); return; }
  if (file.size > 15 * 1024 * 1024) { showToast('La imagen debe pesar menos de 15 MB', 'error'); return; }
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
      _pendingProductImageDataUrl = canvas.toDataURL('image/jpeg', 0.82);
      const preview = document.getElementById('mp-image-preview');
      const placeholder = document.getElementById('mp-image-placeholder');
      const box = preview?.closest('.mp-image-box');
      if (preview) { preview.src = _pendingProductImageDataUrl; preview.style.display = 'block'; }
      if (placeholder) placeholder.style.display = 'none';
      if (box) box.classList.add('has-image');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}
window.handleProductImageSelect = handleProductImageSelect;
const PRODUCT_CARD_IMAGE_FALLBACK = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
    <defs>
      <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0%" stop-color="#172036"/>
        <stop offset="100%" stop-color="#0f172a"/>
      </linearGradient>
      <linearGradient id="orb" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.95"/>
        <stop offset="100%" stop-color="#fb7185" stop-opacity="0.95"/>
      </linearGradient>
    </defs>
    <rect width="640" height="640" rx="48" fill="url(#bg)"/>
    <circle cx="172" cy="168" r="104" fill="url(#orb)" opacity="0.22"/>
    <circle cx="502" cy="472" r="118" fill="#f97316" opacity="0.18"/>
    <rect x="166" y="186" width="308" height="218" rx="34" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.14)" stroke-width="8"/>
    <path d="M238 238h166l-22 106H261l-23-106Z" fill="none" stroke="#e2e8f0" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="280" cy="390" r="14" fill="#e2e8f0"/>
    <circle cx="366" cy="390" r="14" fill="#e2e8f0"/>
    <path d="M246 220h-42" stroke="#e2e8f0" stroke-width="16" stroke-linecap="round"/>
    <text x="320" y="496" text-anchor="middle" fill="#e2e8f0" font-family="Segoe UI, Arial, sans-serif" font-size="34" font-weight="700">Producto</text>
    <text x="320" y="536" text-anchor="middle" fill="#94a3b8" font-family="Segoe UI, Arial, sans-serif" font-size="20">Sin imagen disponible</text>
  </svg>
`)}`;

const BASE_PRODUCT_UNITS = [
  'Unidad',
  'Caja',
  'Paquete',
  'Metro',
  'Pie',
  'Galón',
  'Rollo',
  'Saco',
  'Kilogramo (kg)',
  'Gramo (g)',
  'Libra (lb)'
];

function mergeProductUnits(...groups) {
  return [...new Set(groups.flat().filter(Boolean))];
}

const PRODUCT_UNIT_PRESETS = {
  general: mergeProductUnits(BASE_PRODUCT_UNITS, ['Litro', 'Docena', 'Botella', 'Pack']),
  retail: mergeProductUnits(BASE_PRODUCT_UNITS, ['Botella', 'Lata', 'Fardo', 'Litro']),
  farmacia: mergeProductUnits(BASE_PRODUCT_UNITS, ['Frasco', 'Blíster', 'Tableta', 'Botella', 'Sobre', 'Ampolla']),
  ferreteria: mergeProductUnits(BASE_PRODUCT_UNITS, ['Litro']),
  moda: mergeProductUnits(BASE_PRODUCT_UNITS, ['Par', 'Set', 'Pieza']),
  tecnologia: mergeProductUnits(BASE_PRODUCT_UNITS, ['Pack', 'Kit', 'Pieza']),
  servicio: ['Servicio', 'Sesión', 'Consulta', 'Paquete', 'Unidad']
};

const PRODUCT_SALE_MODE_OPTIONS = [
  ['unidad', 'Unidad'],
  ['medida', 'Medida'],
  ['peso', 'Peso']
];

const PRODUCT_FORM_PROFILES = {
  default: {
    businessLabel: 'Negocio general',
    typeOptions: [
      ['general', 'General'],
      ['combo', 'Combo'],
      ['servicio', 'Servicio']
    ],
    unitOptions: PRODUCT_UNIT_PRESETS.general,
    showPizzaOptions: false,
    showPrepTime: false,
    showComboField: true,
    prepLabel: 'Tiempo de atención (min)',
    prepDefault: 0,
    imageQueryPlaceholder: 'Ej: nombre del producto'
  },
  pizzeria: {
    businessLabel: 'Pizzería',
    typeOptions: [
      ['general', 'General'],
      ['pizza', 'Pizza'],
      ['combo', 'Combo'],
      ['ingrediente', 'Ingrediente'],
      ['bebida', 'Bebida']
    ],
    unitOptions: PRODUCT_UNIT_PRESETS.general,
    showPizzaOptions: true,
    showPrepTime: true,
    showComboField: true,
    prepLabel: 'Tiempo prep. (min)',
    prepDefault: 15,
    imageQueryPlaceholder: 'Ej: Pizza pepperoni familiar'
  },
  restaurante: {
    businessLabel: 'Restaurante',
    typeOptions: [
      ['general', 'General'],
      ['plato', 'Plato'],
      ['bebida', 'Bebida'],
      ['postre', 'Postre'],
      ['combo', 'Combo'],
      ['ingrediente', 'Ingrediente']
    ],
    unitOptions: PRODUCT_UNIT_PRESETS.general,
    showPizzaOptions: false,
    showPrepTime: true,
    showComboField: true,
    prepLabel: 'Tiempo de cocina (min)',
    prepDefault: 12,
    imageQueryPlaceholder: 'Ej: hamburguesa clásica'
  },
  colmado: {
    businessLabel: 'Colmado / Supermercado',
    typeOptions: [
      ['general', 'General'],
      ['bebida', 'Bebida'],
      ['combo', 'Combo'],
      ['recarga', 'Recarga'],
      ['servicio', 'Servicio']
    ],
    unitOptions: PRODUCT_UNIT_PRESETS.retail,
    showPizzaOptions: false,
    showPrepTime: false,
    showComboField: true,
    prepLabel: 'Tiempo de atención (min)',
    prepDefault: 0,
    imageQueryPlaceholder: 'Ej: arroz selecto 125g'
  },
  farmacia: {
    businessLabel: 'Farmacia',
    typeOptions: [
      ['general', 'General'],
      ['medicamento', 'Medicamento'],
      ['cuidado', 'Cuidado personal'],
      ['combo', 'Combo'],
      ['servicio', 'Servicio']
    ],
    unitOptions: PRODUCT_UNIT_PRESETS.farmacia,
    showPizzaOptions: false,
    showPrepTime: false,
    showComboField: true,
    prepLabel: 'Tiempo de atención (min)',
    prepDefault: 0,
    imageQueryPlaceholder: 'Ej: acetaminofén 500mg'
  },
  ferreteria: {
    businessLabel: 'Ferretería',
    typeOptions: [
      ['general', 'Artículo'],
      ['herramienta', 'Herramienta'],
      ['material', 'Material'],
      ['repuesto', 'Repuesto'],
      ['combo', 'Combo']
    ],
    unitOptions: PRODUCT_UNIT_PRESETS.ferreteria,
    showPizzaOptions: false,
    showPrepTime: false,
    showComboField: true,
    prepLabel: 'Tiempo de despacho (min)',
    prepDefault: 0,
    imageQueryPlaceholder: 'Ej: martillo estándar'
  },
  boutique: {
    businessLabel: 'Boutique / Tienda',
    typeOptions: [
      ['general', 'Producto'],
      ['prenda', 'Prenda'],
      ['calzado', 'Calzado'],
      ['accesorio', 'Accesorio'],
      ['combo', 'Combo']
    ],
    unitOptions: PRODUCT_UNIT_PRESETS.moda,
    showPizzaOptions: false,
    showPrepTime: false,
    showComboField: true,
    prepLabel: 'Tiempo de atención (min)',
    prepDefault: 0,
    imageQueryPlaceholder: 'Ej: blusa casual'
  },
  panaderia: {
    businessLabel: 'Panadería / Repostería',
    typeOptions: [
      ['general', 'Producto'],
      ['pan', 'Pan'],
      ['postre', 'Postre'],
      ['bebida', 'Bebida'],
      ['combo', 'Combo']
    ],
    unitOptions: PRODUCT_UNIT_PRESETS.general,
    showPizzaOptions: false,
    showPrepTime: true,
    showComboField: true,
    prepLabel: 'Tiempo de producción (min)',
    prepDefault: 5,
    imageQueryPlaceholder: 'Ej: pan de agua'
  },
  tecnologia: {
    businessLabel: 'Tecnología / Electrónica',
    typeOptions: [
      ['general', 'Producto'],
      ['equipo', 'Equipo'],
      ['accesorio', 'Accesorio'],
      ['repuesto', 'Repuesto'],
      ['combo', 'Combo'],
      ['servicio', 'Servicio']
    ],
    unitOptions: PRODUCT_UNIT_PRESETS.tecnologia,
    showPizzaOptions: false,
    showPrepTime: false,
    showComboField: true,
    prepLabel: 'Tiempo de soporte (min)',
    prepDefault: 0,
    imageQueryPlaceholder: 'Ej: cargador USB-C'
  },
  salon: {
    businessLabel: 'Salón / Spa',
    typeOptions: [
      ['servicio', 'Servicio'],
      ['general', 'Producto'],
      ['combo', 'Paquete'],
      ['tratamiento', 'Tratamiento']
    ],
    unitOptions: [...PRODUCT_UNIT_PRESETS.servicio, 'Unidad', 'Botella'],
    showPizzaOptions: false,
    showPrepTime: true,
    showComboField: true,
    prepLabel: 'Duración del servicio (min)',
    prepDefault: 30,
    imageQueryPlaceholder: 'Ej: corte de dama'
  },
  cafeteria: {
    businessLabel: 'Cafetería',
    typeOptions: [
      ['general', 'Producto'],
      ['bebida', 'Bebida'],
      ['postre', 'Postre'],
      ['combo', 'Combo']
    ],
    unitOptions: PRODUCT_UNIT_PRESETS.general,
    showPizzaOptions: false,
    showPrepTime: true,
    showComboField: true,
    prepLabel: 'Tiempo de preparación (min)',
    prepDefault: 4,
    imageQueryPlaceholder: 'Ej: latte'
  },
  licoreria: {
    businessLabel: 'Licorería',
    typeOptions: [
      ['general', 'Producto'],
      ['bebida', 'Bebida'],
      ['combo', 'Combo']
    ],
    unitOptions: PRODUCT_UNIT_PRESETS.retail,
    showPizzaOptions: false,
    showPrepTime: false,
    showComboField: true,
    prepLabel: 'Tiempo de despacho (min)',
    prepDefault: 0,
    imageQueryPlaceholder: 'Ej: ron añejo 700ml'
  },
  repuestos: {
    businessLabel: 'Repuestos / Autopartes',
    typeOptions: [
      ['general', 'Producto'],
      ['repuesto', 'Repuesto'],
      ['accesorio', 'Accesorio'],
      ['combo', 'Combo']
    ],
    unitOptions: PRODUCT_UNIT_PRESETS.ferreteria,
    showPizzaOptions: false,
    showPrepTime: false,
    showComboField: true,
    prepLabel: 'Tiempo de despacho (min)',
    prepDefault: 0,
    imageQueryPlaceholder: 'Ej: filtro de aceite'
  },
  veterinaria: {
    businessLabel: 'Veterinaria / Mascotas',
    typeOptions: [
      ['servicio', 'Servicio'],
      ['medicamento', 'Medicamento'],
      ['general', 'Producto'],
      ['combo', 'Combo']
    ],
    unitOptions: [...PRODUCT_UNIT_PRESETS.farmacia, 'Servicio', 'Consulta'],
    showPizzaOptions: false,
    showPrepTime: true,
    showComboField: true,
    prepLabel: 'Duración / atención (min)',
    prepDefault: 20,
    imageQueryPlaceholder: 'Ej: consulta general'
  }
};

function getActiveBusinessType() {
  return DB.config?.tipoNegocio || 'pizzeria';
}

function getProductFormProfile() {
  const baseProfile = PRODUCT_FORM_PROFILES[getActiveBusinessType()] || PRODUCT_FORM_PROFILES.default;
  const runtimeConfig = typeof window.getBusinessConfig === 'function'
    ? window.getBusinessConfig(getActiveBusinessType())
    : { productFields: [] };
  return {
    ...baseProfile,
    dynamicFields: Array.isArray(runtimeConfig.productFields) ? runtimeConfig.productFields : []
  };
}

function humanizeProductType(value = '') {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildProductOptions(options = [], selectedValue = '', fallbackLabel = '') {
  const normalized = Array.isArray(options) ? [...options] : [];
  if (selectedValue && !normalized.some(([value]) => value === selectedValue)) {
    normalized.push([selectedValue, fallbackLabel || humanizeProductType(selectedValue)]);
  }
  return normalized.map(([value, label]) => `
    <option value="${value}" ${selectedValue === value ? 'selected' : ''}>${label}</option>
  `).join('');
}

function buildUnitOptions(options = [], selectedValue = '') {
  const normalized = Array.isArray(options) ? [...options] : [];
  if (selectedValue && !normalized.includes(selectedValue)) {
    normalized.push(selectedValue);
  }
  return normalized.map((unit) => `<option value="${unit}" ${selectedValue === unit ? 'selected' : ''}>${unit}</option>`).join('');
}

function getScaleUtils() {
  return window.TecnoCajaScaleUtils || {};
}

function getSelectedProductSaleMode() {
  return getScaleUtils().normalizeSaleMode
    ? getScaleUtils().normalizeSaleMode(document.getElementById('mp-sale-mode')?.value || 'unidad')
    : 'unidad';
}

function getSelectedProductUnit() {
  return String(document.getElementById('mp-unidad')?.value || 'Unidad').trim() || 'Unidad';
}

function getProductDynamicFieldValue(product, field) {
  return product?.metaNegocio?.[field.key];
}

function formatDynamicFieldValue(field, value) {
  if (value === null || value === undefined || value === '') return '';
  if (field.type === 'boolean') return value ? 'Sí' : 'No';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

function buildDynamicFieldInput(field, product) {
  const rawValue = getProductDynamicFieldValue(product, field);
  const inputId = `mp-dynamic-${field.key}`;
  const commonLabel = `<label>${field.label}</label>`;
  if (field.type === 'textarea') {
    return `
      <div class="form-group ${field.fullWidth !== false ? 'span-full' : ''}">
        ${commonLabel}
        <textarea id="${inputId}" class="form-input" rows="3" placeholder="${field.placeholder || ''}">${escapeHtml(formatDynamicFieldValue(field, rawValue))}</textarea>
      </div>
    `;
  }
  if (field.type === 'select') {
    const options = Array.isArray(field.options) ? field.options : [];
    return `
      <div class="form-group">
        ${commonLabel}
        <select id="${inputId}" class="form-input">
          <option value="">Selecciona</option>
          ${options.map((option) => {
            const label = typeof option === 'string' ? option : option.label;
            const value = typeof option === 'string' ? option : option.value;
            return `<option value="${escapeHtml(value)}" ${String(rawValue || '') === String(value) ? 'selected' : ''}>${escapeHtml(label)}</option>`;
          }).join('')}
        </select>
      </div>
    `;
  }
  if (field.type === 'boolean') {
    const normalized = Boolean(rawValue);
    return `
      <div class="form-group">
        ${commonLabel}
        <select id="${inputId}" class="form-input">
          <option value="no" ${normalized ? '' : 'selected'}>No</option>
          <option value="si" ${normalized ? 'selected' : ''}>Sí</option>
        </select>
      </div>
    `;
  }
  const value = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue ?? '');
  return `
    <div class="form-group ${field.fullWidth ? 'span-full' : ''}">
      ${commonLabel}
      <input
        type="${field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}"
        id="${inputId}"
        class="form-input"
        value="${escapeHtml(value)}"
        ${field.type === 'number' ? 'step="0.01"' : ''}
        placeholder="${field.placeholder || ''}">
    </div>
  `;
}

function buildDynamicFieldsMarkup(profile, product) {
  if (!Array.isArray(profile.dynamicFields) || !profile.dynamicFields.length) return '';
  return `
    <div class="span-full product-dynamic-fields-grid">
      ${profile.dynamicFields.map((field) => buildDynamicFieldInput(field, product)).join('')}
    </div>
  `;
}

function readDynamicProductFields(profile) {
  const payload = {};
  for (const field of profile.dynamicFields || []) {
    const element = document.getElementById(`mp-dynamic-${field.key}`);
    if (!element) continue;
    if (field.type === 'boolean') {
      payload[field.key] = element.value === 'si';
      continue;
    }
    if (field.type === 'tags') {
      payload[field.key] = String(element.value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      continue;
    }
    if (field.type === 'number') {
      const numeric = Number(element.value || 0);
      payload[field.key] = Number.isFinite(numeric) ? numeric : 0;
      continue;
    }
    payload[field.key] = String(element.value || '').trim();
  }
  return payload;
}

function buildProductDynamicHighlights(product, limit = 3) {
  const runtimeConfig = typeof window.getBusinessConfig === 'function'
    ? window.getBusinessConfig(getActiveBusinessType())
    : { productFields: [] };
  const fields = (runtimeConfig.productFields || []).filter((field) => field.highlight);
  const chips = [];
  for (const field of fields) {
    const value = formatDynamicFieldValue(field, product?.metaNegocio?.[field.key]);
    if (!value) continue;
    chips.push(`<span class="product-dynamic-chip">${escapeHtml(field.label)}: ${escapeHtml(value)}</span>`);
    if (chips.length >= limit) break;
  }
  return chips.length ? `<div class="product-dynamic-highlights">${chips.join('')}</div>` : '';
}

function syncProductBusinessFields() {
  const profile = getProductFormProfile();
  const typeValue = document.getElementById('mp-tipo')?.value || profile.typeOptions?.[0]?.[0] || 'general';
  const showPizzaConfig = profile.showPizzaOptions && typeValue === 'pizza';
  const showPrepTime = Boolean(profile.showPrepTime || typeValue === 'servicio');
  const showComboField = Boolean(profile.showComboField);
  const saleMode = getSelectedProductSaleMode();
  const selectedUnit = getSelectedProductUnit();
  const scaleUtils = getScaleUtils();
  const weightMode = saleMode === 'peso';
  const measureMode = saleMode === 'medida';
  const prepLabel = document.getElementById('mp-tiempo-label');
  const stockInput = document.getElementById('mp-stock');
  const stockMinInput = document.getElementById('mp-stockmin');
  const quantityBehavior = document.getElementById('mp-quantity-behavior');
  const measureHint = document.getElementById('mp-measure-hint');
  const weightHint = document.getElementById('mp-weight-hint');
  const unitSelect = document.getElementById('mp-unidad');

  ['mp-tamanos-group', 'mp-masas-group', 'mp-bordes-group', 'mp-extras-group', 'mp-mitades-group'].forEach((id) => {
    document.getElementById(id)?.classList.toggle('hidden', !showPizzaConfig);
  });
  document.getElementById('mp-tiempo-group')?.classList.toggle('hidden', !showPrepTime);
  document.getElementById('mp-combo-group')?.classList.toggle('hidden', !showComboField);
  document.getElementById('mp-measure-hint-group')?.classList.toggle('hidden', !measureMode);
  document.getElementById('mp-weight-hint-group')?.classList.toggle('hidden', !weightMode);

  if (prepLabel) prepLabel.textContent = profile.prepLabel || 'Tiempo prep. (min)';

  if (weightMode && scaleUtils.isWeightUnit && !scaleUtils.isWeightUnit(selectedUnit) && unitSelect) {
    const preferredUnit = scaleUtils.getWeightUnitLabel
      ? scaleUtils.getWeightUnitLabel(DB.config?.scaleDefaultUnit || 'kg')
      : 'Kilogramo (kg)';
    unitSelect.value = preferredUnit;
  }
  const effectiveUnit = getSelectedProductUnit();

  if (quantityBehavior) {
    quantityBehavior.textContent = weightMode
      ? 'La cantidad se tomará desde la báscula. El cajero no la escribirá manualmente en ventas.'
      : (measureMode
          ? 'La cantidad podrá editarse con decimales para vender por longitud, fracción o medida manual.'
          : 'La cantidad se manejará con el flujo tradicional por unidad.');
  }

  if (measureHint) {
    measureHint.textContent = `Ejemplo: 1.5 ${effectiveUnit.toLowerCase()} o 0.75 ${effectiveUnit.toLowerCase()}.`;
  }

  if (weightHint) {
    const defaultScaleUnit = scaleUtils.getWeightUnitLabel
      ? scaleUtils.getWeightUnitLabel(DB.config?.scaleDefaultUnit || 'kg')
      : (DB.config?.scaleDefaultUnit || 'kg');
    weightHint.textContent = `La venta se pesará en caja. Si la báscula envía el peso en ${defaultScaleUnit}, el sistema lo convertirá automáticamente a ${effectiveUnit}.`;
  }

  const numericStep = saleMode === 'unidad' ? '1' : '0.01';
  if (stockInput) stockInput.step = numericStep;
  if (stockMinInput) stockMinInput.step = numericStep;

  const tracksStock = document.getElementById('mp-tracks-stock')?.checked !== false;
  const noStockHint = document.getElementById('mp-no-stock-hint');
  const stockGroup = document.getElementById('mp-stock-group');
  const stockMinGroup = document.getElementById('mp-stockmin-group');
  if (noStockHint) noStockHint.style.display = tracksStock ? 'none' : '';
  if (stockGroup) stockGroup.style.display = tracksStock ? '' : 'none';
  if (stockMinGroup) stockMinGroup.style.display = tracksStock ? '' : 'none';
  if (!tracksStock) {
    if (stockInput) stockInput.value = '0';
    if (stockMinInput) stockMinInput.value = '0';
  }
}

function showProductsDebug(message) {
  const banner = document.getElementById('products-debug-banner');
  if (!banner) return;
  if (!message) {
    banner.classList.add('hidden');
    banner.textContent = '';
    return;
  }
  banner.textContent = message;
  banner.classList.remove('hidden');
}

function renderProductsFallback(productsList, reason = '') {
  const panel = document.getElementById('products-fallback-panel');
  if (!panel) return;
  const preview = (productsList || []).slice(0, 8);
  panel.innerHTML = `
    <div style="font-weight:700;margin-bottom:0.35rem">Vista de respaldo del modulo Productos</div>
    <div style="color:var(--text2)">Motivo: ${reason || 'diagnostico manual'}.</div>
    <div style="color:var(--text2)">Total detectado en memoria: ${productsList.length}</div>
    <div class="products-fallback-list">
      ${preview.map((product) => `
        <div class="products-fallback-item">
          <strong>${product.codigo} · ${typeof getLocalizedProductName === 'function' ? getLocalizedProductName(product) : product.nombre}</strong><br>
          <span>${typeof getLocalizedCategoryName === 'function' ? getLocalizedCategoryName(product.categoria) : product.categoria} · ${translateCatalogText(product.unidad || 'Unidad')} · Stock ${product.stock} · ${fmt(product.precioVenta)}</span>
        </div>
      `).join('')}
    </div>
  `;
  panel.classList.remove('hidden');
}

function hideProductsFallback() {
  const panel = document.getElementById('products-fallback-panel');
  if (!panel) return;
  panel.classList.add('hidden');
  panel.innerHTML = '';
}

function getFilteredProducts() {
  const search = productFilters.search.toLowerCase().trim();
  return DB.productos.filter((p) => {
    const matchesSearch = !search || [
      p.nombre,
      typeof getLocalizedProductName === 'function' ? getLocalizedProductName(p) : p.nombre,
      p.codigo,
      p.categoria,
      typeof getLocalizedCategoryName === 'function' ? getLocalizedCategoryName(p.categoria) : p.categoria,
      p.marca || '',
      p.unidad || ''
    ].some((value) => String(value).toLowerCase().includes(search));

    const matchesCategory = !productFilters.category || p.categoria === productFilters.category;

    let matchesStatus = true;
    if (productFilters.status === 'activos') matchesStatus = p.estado === 'Activo';
    if (productFilters.status === 'stock-bajo') matchesStatus = p.estado === 'Activo' && p.stock > 0 && p.stock <= p.stockMin;
    if (productFilters.status === 'agotados') matchesStatus = p.stock === 0;
    if (productFilters.status === 'inactivos') matchesStatus = p.estado !== 'Activo';

    return matchesSearch && matchesCategory && matchesStatus;
  });
}

function getProductImageSrc(product) {
  return product?.imagenLocal || product?.imagenUrl || PRODUCT_CARD_IMAGE_FALLBACK;
}

function getProductVisualTone(product) {
  if (product.estado !== 'Activo') return 'is-paused';
  if (Number(product.stock || 0) === 0) return 'is-out';
  if (Number(product.stock || 0) <= Number(product.stockMin || 0)) return 'is-low';
  return 'is-active';
}

function getProductCompactCategory(product) {
  return typeof getLocalizedCategoryName === 'function'
    ? getLocalizedCategoryName(product.categoria)
    : (product.categoria || '');
}

function getProductStockBadgeLabel(product) {
  if (product.estado !== 'Activo') return 'Pausado';
  if (Number(product.stock || 0) === 0) return 'Sin stock';
  return `Stock ${Number(product.stock || 0)}`;
}

function quickAddProductToSale(productId, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (typeof addProductById !== 'function') {
    showToast('No se pudo agregar el producto a la venta actual', 'warning');
    return;
  }
  addProductById(productId);
  showToast('Producto agregado a la venta actual', 'success');
}

function editProductFromCard(productId, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  editProduct(productId);
}

function toggleProductStatusFromCard(productId, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  toggleProductStatus(productId);
}

function deleteProductFromCard(productId, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  deleteProduct(productId);
}

function loadProductsTable() {
  const grid = document.getElementById('products-grid');
  const counter = document.getElementById('products-grid-counter');
  const footerNote = document.getElementById('products-grid-footer-note');
  if (!grid) return;

  try {
    const sourceCount = Array.isArray(DB.productos) ? DB.productos.length : 0;
    const prods = getFilteredProducts();
    grid.innerHTML = prods.map((p) => {
      const nombre = typeof getLocalizedProductName === 'function' ? getLocalizedProductName(p) : p.nombre;
      const tone = getProductVisualTone(p);
      return `
      <article class="products-grid-card products-catalog-card ${tone}" onclick="editProduct(${p.id})" title="${nombre}">
        <div class="products-catalog-media">
          <img src="${getProductImageSrc(p)}" alt="${nombre}" class="products-grid-image" loading="lazy" decoding="async" onerror="this.src=PRODUCT_CARD_IMAGE_FALLBACK">
        </div>
        <div class="products-catalog-body">
          <div class="products-catalog-name">${nombre}</div>
          <div class="products-catalog-price">${fmt(p.precioVenta)}</div>
        </div>
      </article>`;
    }).join('') || '<div class="products-grid-empty">No se encontraron productos</div>';
    updateProductsStats(prods);
    if (counter) {
      counter.textContent = `${prods.length} visibles`;
    }
    if (footerNote) {
      footerNote.textContent = `Productos cargados: ${prods.length} visibles de ${sourceCount} totales`;
    }
    showProductsDebug(`Productos cargados: ${prods.length} visibles de ${sourceCount} totales`);
    if (!prods.length && sourceCount > 0) {
      renderProductsFallback(DB.productos, 'la tabla filtrada quedo vacia aunque hay productos cargados');
    } else {
      hideProductsFallback();
    }
  } catch (error) {
    grid.innerHTML = '<div class="products-grid-empty" style="color:var(--danger)">Error al renderizar productos</div>';
    showProductsDebug(`Error en modulo productos: ${error.message}`);
    renderProductsFallback(Array.isArray(DB.productos) ? DB.productos : [], error.message);
    console.error('Error renderizando productos:', error);
  }
}

function updateProductsStats(productsList = getFilteredProducts()) {
  const totalEl = document.getElementById('products-total-count');
  const lowEl = document.getElementById('products-low-count');
  const outEl = document.getElementById('products-out-count');
  if (!totalEl || !lowEl || !outEl) return;

  totalEl.textContent = productsList.length;
  lowEl.textContent = productsList.filter(p => p.estado === 'Activo' && p.stock > 0 && p.stock <= p.stockMin).length;
  outEl.textContent = productsList.filter(p => p.stock === 0).length;
  const totalRetail = productsList.reduce((sum, p) => sum + (Number(p.precioVenta || 0) * p.stock), 0);
  const totalCost   = productsList.reduce((sum, p) => sum + (Number(p.precioCompra || 0) * p.stock), 0);
  const potentialProfit = totalRetail - totalCost;
  const totalValEl = document.getElementById('products-total-value');
  const profitSubEl = document.getElementById('products-profit-sub');
  if (totalValEl) totalValEl.textContent = fmt(totalRetail);
  if (profitSubEl) profitSubEl.textContent = `ganancia: ${fmt(potentialProfit)}`;
}

function getStockBadge(p) {
  if (p.estado !== 'Activo') return `<span class="badge badge-info">${translateCatalogText('Inactivo')}</span>`;
  if (p.stock === 0) return `<span class="badge badge-danger">${translateCatalogText('Agotado')}</span>`;
  if (p.stock <= p.stockMin) return `<span class="badge badge-warning">${translateCatalogText('Stock Bajo')}</span>`;
  return `<span class="badge badge-success">${translateCatalogText('Activo')}</span>`;
}

function getMarginAmount(product) {
  return Number(product.precioVenta || 0) - Number(product.precioCompra || 0);
}

function getMarginLabel(product) {
  const margin = getMarginAmount(product);
  const pct = product.precioCompra > 0 ? (margin / product.precioCompra) * 100 : 0;
  return `${fmt(margin)} · ${pct.toFixed(1)}%`;
}

function refreshProductCategoryFilter() {
  const select = document.getElementById('products-category-filter');
  if (!select) return;
  const previous = productFilters.category;
  const categories = [...new Set(DB.productos.map((product) => product.categoria).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  select.innerHTML = '<option value="">Todas las categorías</option>' + categories.map((category) => `
    <option value="${category}">${typeof getLocalizedCategoryName === 'function' ? getLocalizedCategoryName(category) : category}</option>
  `).join('');
  select.value = previous;
}

function filterProducts() {
  const searchEl = document.getElementById('products-search');
  const categoryEl = document.getElementById('products-category-filter');
  const statusEl = document.getElementById('products-status-filter');
  productFilters.search = searchEl?.value || '';
  productFilters.category = categoryEl?.value || '';
  productFilters.status = statusEl?.value || 'todos';
  loadProductsTable();
}

async function reloadProductsModule() {
  await syncReportAppProductsNow({ silent: false, minIntervalMs: 0 });
  refreshProductCategoryFilter();
  filterProducts();
  hideProductsFallback();
}

function triggerProductsCsvImport() {
  const input = document.getElementById('products-csv-import-input');
  if (!input) {
    showToast('No encontré el selector de CSV de productos.', 'error');
    return;
  }
  input.value = '';
  input.click();
}

async function handleProductsCsvImport(input) {
  const file = input?.files?.[0];
  if (!file) return;
  if (!/\.(csv|txt)$/i.test(file.name)) {
    showToast('Selecciona un archivo CSV o TXT válido.', 'error');
    input.value = '';
    return;
  }

  const button = document.getElementById('btn-products-import');
  const originalLabel = button?.textContent || '⬆ Importar CSV';
  if (button) {
    button.disabled = true;
    button.textContent = 'Importando...';
  }

  try {
    const formData = new FormData();
    formData.append('csv', file, file.name);
    const result = await api.importProductsCsv(formData);

    if (Array.isArray(result?.products)) {
      DB.productos = result.products;
    }

    reloadProductsModule();
    loadInventoryTable();
    updateInventoryStats();
    if (typeof renderSalesCatalog === 'function') renderSalesCatalog();
    if (typeof refreshAuditLogs === 'function') refreshAuditLogs();
    if (typeof updateNotifications === 'function') updateNotifications();

    const created = Number(result?.created || 0);
    const updated = Number(result?.updated || 0);
    const skipped = Number(result?.skipped || 0);
    const backupPath = String(result?.backupCsv || '').trim();
    const summary = [`${created} creado(s)`, `${updated} actualizado(s)`];
    if (skipped > 0) summary.push(`${skipped} omitido(s)`);

    showToast(`CSV importado correctamente: ${summary.join(', ')}.`, 'success');
    if (backupPath) {
      showToast(`Respaldo CSV actualizado en ${backupPath}`, 'info');
    }
    if (Array.isArray(result?.errors) && result.errors.length) {
      console.warn('[productos/import-csv]', result.errors);
      showToast(`Importación completada con observaciones: ${result.errors[0]}`, 'warning');
    }
  } catch (error) {
    showToast(error.message || 'No se pudo importar el CSV de productos.', 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
    if (input) input.value = '';
  }
}

async function cleanupZeroPriceProducts() {
  const zeroPriceProducts = (DB.productos || []).filter((p) => !Number(p.precioVenta));
  if (!zeroPriceProducts.length) {
    showToast('No hay productos sin precio que limpiar.', 'info');
    return;
  }
  const names = zeroPriceProducts.slice(0, 5).map((p) => p.nombre).join(', ');
  const more = zeroPriceProducts.length > 5 ? ` y ${zeroPriceProducts.length - 5} más` : '';
  const confirmed = confirm(
    `Se eliminarán ${zeroPriceProducts.length} producto(s) sin precio:\n${names}${more}\n\n¿Continuar?`
  );
  if (!confirmed) return;
  const btn = document.getElementById('btn-cleanup-zero-price');
  if (btn) { btn.disabled = true; btn.textContent = 'Limpiando...'; }
  try {
    const res = await fetch('/api/admin/cleanup-zero-price-products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getStoredAuthToken ? getStoredAuthToken() : ''}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al limpiar productos');
    // Actualizar DB local
    const deletedIds = new Set((data.products || []).map((p) => Number(p.id)));
    DB.productos = (DB.productos || []).filter((p) => !deletedIds.has(Number(p.id)));
    reloadProductsModule();
    if (typeof renderSalesCatalog === 'function') renderSalesCatalog();
    showToast(`${data.deleted} producto(s) eliminado(s) correctamente.`, 'success');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'danger');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🗑 Limpiar sin precio'; }
  }
}

function updateProductScanHint(message, tone = '') {
  const hint = document.getElementById('product-scan-hint');
  if (!hint) return;
  hint.textContent = message;
  hint.style.color = tone ? `var(--${tone})` : '';
}

function resetProductScanner() {
  productScannerState.armed = false;
  productScannerState.buffer = '';
  if (productScannerState.timer) {
    clearTimeout(productScannerState.timer);
    productScannerState.timer = null;
  }
  updateProductScanHint('Puedes escribir el código manualmente o usar un lector de barras.');
}

function armProductScanner() {
  productScannerState.armed = true;
  productScannerState.buffer = '';
  if (productScannerState.timer) clearTimeout(productScannerState.timer);
  const codeInput = document.getElementById('mp-codigo');
  if (codeInput) codeInput.blur();
  updateProductScanHint('Escáner activo: pasa el producto por el lector y espera Enter automático.', 'info');
  showToast('Escáner listo para capturar el código', 'success');
}

function normalizeProductIdentityValue(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function escapeProductIdentityHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getCurrentProductModalId() {
  const rawValue = document.getElementById('modal-box')?.dataset.productId || '';
  const numericId = Number(rawValue);
  return Number.isFinite(numericId) && numericId > 0 ? numericId : null;
}

function findDuplicateProductByField(fieldName, value, currentId = null) {
  const normalizedValue = normalizeProductIdentityValue(value);
  if (!normalizedValue) return null;
  return (DB.productos || []).find((product) => (
    normalizeProductIdentityValue(product?.[fieldName]) === normalizedValue
    && Number(product?.id || 0) !== Number(currentId || 0)
  )) || null;
}

function setProductIdentityFeedback(feedbackId, message, tone = '') {
  const feedback = document.getElementById(feedbackId);
  if (!feedback) return;
  feedback.textContent = message || '';
  feedback.style.color = tone ? `var(--${tone})` : 'var(--text2)';
}

function getProductsWithSameName(value, currentId = null, limit = 5) {
  const normalizedValue = normalizeProductIdentityValue(value);
  if (!normalizedValue) return [];

  return (DB.productos || [])
    .filter((product) => (
      Number(product?.id || 0) !== Number(currentId || 0)
      && normalizeProductIdentityValue(product?.nombre) === normalizedValue
    ))
    .sort((a, b) => String(a?.nombre || '').localeCompare(String(b?.nombre || '')))
    .slice(0, limit)
    .map((product) => product);
}

function renderProductNameSuggestions(value, currentId = null) {
  const container = document.getElementById('mp-name-suggestions');
  if (!container) return;

  const matches = getProductsWithSameName(value, currentId);
  if (!matches.length) {
    container.innerHTML = '';
    container.classList.add('hidden');
    return;
  }

  container.innerHTML = `
    <div style="margin-top:0.45rem;padding:0.7rem 0.8rem;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:0.7rem">
      <div style="font-size:0.74rem;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.5rem">
        Productos con el mismo nombre
      </div>
      <div style="display:grid;gap:0.38rem">
        ${matches.map((product) => `
          <div style="display:flex;justify-content:space-between;gap:0.75rem;align-items:center;padding:0.45rem 0.55rem;border-radius:0.55rem;background:rgba(255,255,255,0.025)">
            <div style="min-width:0">
              <div style="font-size:0.86rem;font-weight:600;color:var(--text1)">${escapeProductIdentityHtml(product.nombre)}</div>
              <div style="font-size:0.74rem;color:var(--text2)">
                Código: <span style="font-family:var(--font-mono)">${escapeProductIdentityHtml(product.codigo)}</span>${product.categoria ? ` · ${escapeProductIdentityHtml(product.categoria)}` : ''}
              </div>
            </div>
            <button type="button" class="btn-ghost" style="padding:0.32rem 0.6rem;font-size:0.75rem" onclick="editProduct(${Number(product.id)})">Ver</button>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  container.classList.remove('hidden');
}

function validateProductIdentity({ notify = false, focusField = false } = {}) {
  const currentId = getCurrentProductModalId();
  const codeInput = document.getElementById('mp-codigo');
  const nameInput = document.getElementById('mp-nombre');
  const duplicatedCode = findDuplicateProductByField('codigo', codeInput?.value, currentId);
  const duplicatedName = findDuplicateProductByField('nombre', nameInput?.value, currentId);
  renderProductNameSuggestions(nameInput?.value, currentId);

  if (duplicatedCode) {
    setProductIdentityFeedback('mp-code-feedback', `Ese código ya está registrado en: ${duplicatedCode.nombre}`, 'danger');
  } else if (String(codeInput?.value || '').trim()) {
    setProductIdentityFeedback('mp-code-feedback', 'Código disponible.', 'success');
  } else {
    setProductIdentityFeedback('mp-code-feedback', '');
  }

  if (duplicatedName) {
    setProductIdentityFeedback('mp-name-feedback', `Ese nombre ya está registrado con el código: ${duplicatedName.codigo}`, 'danger');
  } else if (String(nameInput?.value || '').trim()) {
    setProductIdentityFeedback('mp-name-feedback', 'Nombre disponible.', 'success');
  } else {
    setProductIdentityFeedback('mp-name-feedback', '');
  }

  if (duplicatedCode) {
    if (notify) showToast('Ese código ya existe en otro producto', 'error');
    if (focusField) {
      codeInput?.focus();
      codeInput?.select?.();
    }
    return false;
  }

  if (duplicatedName) {
    if (notify) showToast('Ese nombre ya existe en otro producto', 'error');
    if (focusField) {
      nameInput?.focus();
      nameInput?.select?.();
    }
    return false;
  }

  return true;
}

function focusProductNameField() {
  const nameInput = document.getElementById('mp-nombre');
  if (!nameInput) return;
  nameInput.focus();
  nameInput.select?.();
}

function handleProductCodeEnter(event) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  if (!validateProductIdentity({ notify: true, focusField: true })) return;
  focusProductNameField();
}

function openProductModal(id) {
  const prod = id ? DB.productos.find(p => p.id === id) : null;
  const profile = getProductFormProfile();
  const cats = DB.categorias.map(c => `<option ${prod&&prod.categoria===c?'selected':''}>${c}</option>`).join('');
  const selectedType = prod?.tipoProducto || profile.typeOptions?.[0]?.[0] || 'general';
  const selectedUnit = prod?.unidad || profile.unitOptions?.[0] || 'Unidad';
  const selectedSaleMode = getScaleUtils().normalizeSaleMode
    ? getScaleUtils().normalizeSaleMode(prod?.saleMode || 'unidad')
    : 'unidad';
  _pendingProductImageDataUrl = null;
  const existingImgSrc = prod?.imagenLocal || prod?.imagenUrl || '';
  const hasExistingImg = Boolean(existingImgSrc);
  document.getElementById('modal-box').classList.add('product-modal');
  document.getElementById('modal-box').dataset.productId = prod?.id ? String(prod.id) : '';
  document.getElementById('modal-title').textContent = prod ? 'Editar Producto' : 'Nuevo Producto';
  document.getElementById('modal-body').innerHTML = `

    <!-- Fila imagen + campos básicos rápidos -->
    <div class="mp-image-row">
      <div class="mp-image-box ${hasExistingImg ? 'has-image' : ''}" onclick="document.getElementById('mp-image-file').click()" title="Clic para cambiar imagen">
        <img id="mp-image-preview" class="mp-image-preview" src="${hasExistingImg ? existingImgSrc : ''}" style="display:${hasExistingImg ? 'block' : 'none'}" onerror="this.style.display='none';document.getElementById('mp-image-placeholder').style.display='flex'">
        <div class="mp-image-placeholder" id="mp-image-placeholder" style="display:${hasExistingImg ? 'none' : 'flex'}">
          <span>📷</span>
          <small>Imagen</small>
        </div>
        <input type="file" id="mp-image-file" accept="image/*" style="display:none" onchange="handleProductImageSelect(this)">
      </div>
      <div class="mp-image-fields">
        <div class="form-group">
          <label>Código</label>
          <div class="scan-input-row">
            <input type="text" id="mp-codigo" class="form-input" value="${prod?prod.codigo:''}" placeholder="Escribe o escanea">
            <button type="button" class="btn-secondary" onclick="armProductScanner()">📷</button>
          </div>
          <small id="mp-code-feedback" style="display:block;margin-top:0.35rem;font-size:0.78rem;color:var(--text2)"></small>
          <small id="product-scan-hint" style="display:block;margin-top:0.25rem;font-size:0.78rem;color:var(--text2)">Puedes escribir el código manualmente o usar un lector de barras.</small>
        </div>
      </div>
    </div>

    <div class="form-group span-full mp-name-block">
      <label>Nombre del producto</label>
      <input type="text" id="mp-nombre" class="form-input" value="${prod?prod.nombre:''}" placeholder="Nombre del producto">
      <small id="mp-name-feedback" style="display:block;margin-top:0.35rem;font-size:0.78rem;color:var(--text2)"></small>
      <div id="mp-name-suggestions" class="hidden"></div>
    </div>

    <!-- Campos básicos siempre visibles -->
    <div class="modal-grid mp-basics-grid">
      <div class="form-group span-full">
        <label>Categoría</label>
        <div class="scan-input-row">
          <select id="mp-categoria" class="form-input">${cats}</select>
          <button type="button" class="btn-secondary" onclick="toggleNewCategoryForm(true)">+</button>
        </div>
        <div id="new-category-box" class="new-category-box hidden">
          <input type="text" id="new-category-input" class="form-input" placeholder="Nueva categoría">
          <div class="new-category-actions">
            <button type="button" class="btn-primary" onclick="saveNewCategoryFromModal()">Guardar</button>
            <button type="button" class="btn-ghost" onclick="toggleNewCategoryForm(false)">Cancelar</button>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>Tipo</label>
        <select id="mp-tipo" class="form-input">
          ${buildProductOptions(profile.typeOptions, selectedType, humanizeProductType(selectedType))}
        </select>
      </div>
      <div class="form-group">
        <label>Estado</label>
        <select id="mp-estado" class="form-input">
          <option value="Activo" ${!prod || prod.estado === 'Activo' ? 'selected' : ''}>Activo</option>
          <option value="Inactivo" ${prod && prod.estado === 'Inactivo' ? 'selected' : ''}>Inactivo</option>
        </select>
      </div>
    </div>

    <!-- Tabs: Precios / Avanzado -->
    <div class="product-tab-nav">
      <button class="product-tab-btn active" onclick="switchProductTab(0)">💰 Precios</button>
      <button class="product-tab-btn" onclick="switchProductTab(1)">⚙️ Avanzado</button>
    </div>

    <!-- TAB 0: Precio e inventario -->
    <div class="product-tab-panel modal-grid active" id="product-tab-0">
      <div class="form-group"><label>Precio Compra (RD$)</label><input type="number" id="mp-pcompra" class="form-input" value="${prod?prod.precioCompra:''}" min="0" step="0.01"></div>
      <div class="form-group"><label>Precio Venta (RD$)</label><input type="number" id="mp-pventa" class="form-input" value="${prod?prod.precioVenta:''}" min="0" step="0.01"></div>
      <div class="span-full product-toggle-grid">
        <div class="form-group compact-toggle-card" id="mp-tracks-stock-group">
          <label class="toggle-switch" style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;user-select:none">
            <input type="checkbox" id="mp-tracks-stock" ${prod?.tracksStock !== false ? 'checked' : ''} style="width:auto" onchange="syncProductBusinessFields()">
            <span>Controlar inventario (existencias)</span>
          </label>
          <p id="mp-no-stock-hint" style="margin:0.4rem 0 0;color:var(--text2);font-size:0.82rem;line-height:1.45;display:${prod?.tracksStock === false ? '' : 'none'}">
            Sin control de inventario. El stock no se descontará al vender. Ideal para productos a granel, vendidos por peso o servicios sin existencias fijas.
          </p>
        </div>
        <div class="form-group compact-toggle-card" id="mp-itbis-group">
          <label class="toggle-switch" style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;user-select:none">
            <input type="checkbox" id="mp-aplica-itbis" ${prod?.aplicaItbis ? 'checked' : ''} style="width:auto">
            <span>Aplicar ITBIS (${DB.config?.itbis ?? 18}%) a este producto</span>
          </label>
        </div>
      </div>
      <div class="form-group" id="mp-stock-group" style="display:${prod?.tracksStock === false ? 'none' : ''}"><label>Stock Actual</label><input type="number" id="mp-stock" class="form-input" value="${prod?prod.stock:0}" min="0"></div>
      <div class="form-group" id="mp-stockmin-group" style="display:${prod?.tracksStock === false ? 'none' : ''}"><label>Stock Mínimo</label><input type="number" id="mp-stockmin" class="form-input" value="${prod?prod.stockMin:5}" min="0"></div>
    </div>

    <!-- TAB 1: Config. avanzada -->
    <div class="product-tab-panel modal-grid" id="product-tab-1">
      <div class="form-group"><label>Unidad</label><select id="mp-unidad" class="form-input">
        ${buildUnitOptions(profile.unitOptions, selectedUnit)}
      </select></div>
      <div class="form-group"><label>Venta por</label><select id="mp-sale-mode" class="form-input">
        ${buildProductOptions(PRODUCT_SALE_MODE_OPTIONS, selectedSaleMode, 'Unidad')}
      </select></div>
      <div class="form-group span-full" id="mp-quantity-behavior-group" style="background:var(--panel2);border:1px solid var(--border);border-radius:0.65rem;padding:0.75rem 0.9rem">
        <label style="display:block;margin-bottom:0.3rem">Comportamiento en caja</label>
        <div id="mp-quantity-behavior" style="color:var(--text2);line-height:1.45">La cantidad se manejará con el flujo tradicional por unidad.</div>
      </div>
      <div class="form-group span-full hidden" id="mp-measure-hint-group" style="background:rgba(14,165,233,0.08);border:1px solid rgba(14,165,233,0.24);border-radius:0.65rem;padding:0.75rem 0.9rem">
        <label style="display:block;margin-bottom:0.3rem">Venta por medida</label>
        <div id="mp-measure-hint" style="color:var(--text2);line-height:1.45">Ejemplo: 1.5 metros o 0.75 metros.</div>
      </div>
      <div class="form-group span-full hidden" id="mp-weight-hint-group" style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.22);border-radius:0.65rem;padding:0.75rem 0.9rem">
        <label style="display:block;margin-bottom:0.3rem">Venta por peso</label>
        <div id="mp-weight-hint" style="color:var(--text2);line-height:1.45">La venta se pesará en caja usando la báscula configurada.</div>
      </div>
      <div class="form-group" id="mp-combo-group"><label>¿Es combo?</label><select id="mp-combo" class="form-input">
        <option value="no" ${prod?.esCombo ? '' : 'selected'}>No</option>
        <option value="si" ${prod?.esCombo ? 'selected' : ''}>Sí</option>
      </select></div>
      <div class="form-group" id="mp-tiempo-group"><label id="mp-tiempo-label">${profile.prepLabel || 'Tiempo prep. (min)'}</label><input type="number" id="mp-tiempo" class="form-input" value="${prod ? (prod.tiempoPreparacion ?? profile.prepDefault ?? 0) : (profile.prepDefault ?? 0)}" min="0"></div>
      <div class="form-group" id="mp-mitades-group"><label>Mitades</label><select id="mp-mitades" class="form-input">
        <option value="no" ${prod?.permiteMitades ? '' : 'selected'}>No</option>
        <option value="si" ${prod?.permiteMitades ? 'selected' : ''}>Sí</option>
      </select></div>
      <div class="form-group span-full" id="mp-tamanos-group"><label>Tamaños</label><input type="text" id="mp-tamanos" class="form-input" value="${prod?(prod.tamanos||[]).join(', '):''}" placeholder="Personal, Mediana, Familiar"></div>
      <div class="form-group span-full" id="mp-masas-group"><label>Masas</label><input type="text" id="mp-masas" class="form-input" value="${prod?(prod.masas||[]).join(', '):''}" placeholder="Clásica, Delgada, Artesanal"></div>
      <div class="form-group span-full" id="mp-bordes-group"><label>Bordes</label><input type="text" id="mp-bordes" class="form-input" value="${prod?(prod.bordes||[]).join(', '):''}" placeholder="Normal, Queso, Ajo parmesano"></div>
      <div class="form-group span-full" id="mp-extras-group"><label>Extras</label><input type="text" id="mp-extras" class="form-input" value="${prod?(prod.extras||[]).join(', '):''}" placeholder="Extra queso, Pepperoni, Bacon"></div>
      ${buildDynamicFieldsMarkup(profile, prod)}
    </div>
  `;
  document.getElementById('modal-footer').innerHTML = `
    <div class="product-footer-summary">
      <div class="product-form-card">
        <label>Utilidad</label>
        <strong id="product-profit-preview">RD$ 0.00</strong>
      </div>
      <div class="product-form-card">
        <label>Margen</label>
        <strong id="product-margin-preview">0.0%</strong>
      </div>
      <div class="product-form-card">
        <label>Valor stock</label>
        <strong id="product-stock-value-preview">RD$ 0.00</strong>
      </div>
    </div>
    <div class="product-footer-bottom">
      <div class="product-footer-sale">
        <label>Se venderá en</label>
        <strong id="product-sale-price-preview">RD$0.00</strong>
      </div>
      <div class="product-footer-actions">
        <button class="btn-secondary" onclick="closeAllModals()">Cancelar</button>
        ${id ? `<button class="btn-ghost" style="color:var(--warning,#f59e0b)" onclick="closeAllModals();toggleProductStatus(${id})">${prod?.estado === 'Activo' ? 'Pausar' : 'Activar'}</button>` : ''}
        ${id ? `<button class="btn-ghost" style="color:var(--danger,#ef4444)" onclick="closeAllModals();deleteProduct(${id})">Eliminar</button>` : ''}
        <button class="btn-primary" onclick="saveProduct(${id||'null'})">💾 Guardar</button>
      </div>
    </div>
  `;
  document.getElementById('modal-footer').classList.toggle('product-modal-footer--edit', Boolean(id));
  document.getElementById('modal-overlay').classList.remove('hidden');
  ['mp-pcompra', 'mp-pventa', 'mp-stock'].forEach((fieldId) => {
    document.getElementById(fieldId)?.addEventListener('input', updateProductPreview);
  });
  document.getElementById('mp-aplica-itbis')?.addEventListener('change', updateProductPreview);
  document.getElementById('mp-tipo')?.addEventListener('change', syncProductBusinessFields);
  document.getElementById('mp-sale-mode')?.addEventListener('change', syncProductBusinessFields);
  document.getElementById('mp-unidad')?.addEventListener('change', syncProductBusinessFields);
  document.getElementById('mp-codigo')?.addEventListener('keydown', handleProductCodeEnter);
  document.getElementById('mp-codigo')?.addEventListener('input', () => validateProductIdentity());
  document.getElementById('mp-nombre')?.addEventListener('input', () => validateProductIdentity());
  document.getElementById('mp-codigo')?.focus();
  resetProductScanner();
  validateProductIdentity();
  updateProductPreview();
  syncProductBusinessFields();
}

function switchProductTab(index) {
  document.querySelectorAll('.product-tab-btn').forEach((btn, i) => btn.classList.toggle('active', i === index));
  document.querySelectorAll('.product-tab-panel').forEach((panel, i) => panel.classList.toggle('active', i === index));
}
window.switchProductTab = switchProductTab;

function editProduct(id) { openProductModal(id); }

function toggleNewCategoryForm(show) {
  const box = document.getElementById('new-category-box');
  const input = document.getElementById('new-category-input');
  if (!box) return;
  box.classList.toggle('hidden', !show);
  if (show) {
    if (input) {
      input.value = '';
      input.focus();
    }
  }
}

function saveNewCategoryFromModal() {
  const input = document.getElementById('new-category-input');
  const cleanCategory = String(input?.value || '').trim();
  if (!cleanCategory) {
    showToast('La categoría no puede estar vacía', 'error');
    return;
  }

  const exists = DB.categorias.some((item) => item.toLowerCase() === cleanCategory.toLowerCase());
  if (exists) {
    const select = document.getElementById('mp-categoria');
    const existing = DB.categorias.find((item) => item.toLowerCase() === cleanCategory.toLowerCase());
    if (select && existing) select.value = existing;
    showToast('Esa categoría ya existe', 'warning');
    return;
  }

  api.createCategory({
    nombre: cleanCategory,
    ...getActorPayload()
  }).then((createdCategory) => {
    DB.categorias.push(createdCategory.nombre);
    DB.categorias = [...new Set(DB.categorias)].sort((a, b) => a.localeCompare(b));

    const select = document.getElementById('mp-categoria');
    if (select) {
      select.innerHTML = DB.categorias.map((item) => `<option value="${item}">${item}</option>`).join('');
      select.value = createdCategory.nombre;
    }

    toggleNewCategoryForm(false);
    refreshProductCategoryFilter();
    refreshAuditLogs();
    showToast(`Categoría creada: ${createdCategory.nombre}`, 'success');
  }).catch((error) => {
    showToast(error.message, 'error');
  });
}

function updateProductPreview() {
  const compra = parseFloat(document.getElementById('mp-pcompra')?.value) || 0;
  const venta = parseFloat(document.getElementById('mp-pventa')?.value) || 0;
  const stock = parseFloat(document.getElementById('mp-stock')?.value) || 0;
  const utilidad = venta - compra;
  const margen = compra > 0 ? (utilidad / compra) * 100 : 0;
  const profitPreview = document.getElementById('product-profit-preview');
  const marginPreview = document.getElementById('product-margin-preview');
  const stockValuePreview = document.getElementById('product-stock-value-preview');
  const salePricePreview = document.getElementById('product-sale-price-preview');
  if (profitPreview) profitPreview.textContent = fmt(utilidad);
  if (marginPreview) marginPreview.textContent = `${margen.toFixed(1)}%`;
  if (stockValuePreview) stockValuePreview.textContent = fmt(stock * compra);
  if (!salePricePreview) return;
  salePricePreview.textContent = `RD$${Number(venta || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function saveProduct(id) {
  const profile = getProductFormProfile();
  const currentProduct = id ? DB.productos.find((item) => item.id === id) : null;
  const tipoProducto = document.getElementById('mp-tipo').value;
  const scaleUtils = getScaleUtils();
  const allowPizzaConfig = profile.showPizzaOptions && tipoProducto === 'pizza';
  const allowPrepTime = Boolean(profile.showPrepTime || tipoProducto === 'servicio');
  const nombre = document.getElementById('mp-nombre').value.trim();
  const codigo = document.getElementById('mp-codigo').value.trim();
  const saleMode = getSelectedProductSaleMode();
  const selectedUnit = getSelectedProductUnit();
  if (!nombre || !codigo) { showToast('Nombre y código son obligatorios', 'error'); return; }
  if (!validateProductIdentity({ notify: true, focusField: true })) return;
  if (saleMode === 'peso' && scaleUtils.isWeightUnit && !scaleUtils.isWeightUnit(selectedUnit)) {
    showToast('Los productos vendidos por peso deben usar Kilogramo, Gramo o Libra como unidad.', 'error');
    return;
  }

  const data = {
    codigo, nombre,
    categoria: document.getElementById('mp-categoria').value,
    imagen: currentProduct?.imagen || currentProduct?.imagenUrl || '',
    imagenLocal: currentProduct?.imagenLocal || null,
    tipoProducto,
    marca: currentProduct?.marca || '',
    unidad: selectedUnit,
    saleMode,
    precioCompra: parseFloat(document.getElementById('mp-pcompra').value) || 0,
    precioVenta: parseFloat(document.getElementById('mp-pventa').value) || 0,
    stock: parseFloat(document.getElementById('mp-stock').value) || 0,
    stockMin: parseFloat(document.getElementById('mp-stockmin').value) || 5,
    estado: document.getElementById('mp-estado').value,
    tamanos: allowPizzaConfig ? String(document.getElementById('mp-tamanos').value || '').split(',').map((item) => item.trim()).filter(Boolean) : [],
    masas: allowPizzaConfig ? String(document.getElementById('mp-masas').value || '').split(',').map((item) => item.trim()).filter(Boolean) : [],
    bordes: allowPizzaConfig ? String(document.getElementById('mp-bordes').value || '').split(',').map((item) => item.trim()).filter(Boolean) : [],
    extras: allowPizzaConfig ? String(document.getElementById('mp-extras').value || '').split(',').map((item) => item.trim()).filter(Boolean) : [],
    tiempoPreparacion: allowPrepTime ? (parseInt(document.getElementById('mp-tiempo').value, 10) || profile.prepDefault || 0) : 0,
    permiteMitades: allowPizzaConfig && document.getElementById('mp-mitades').value === 'si',
    esCombo: document.getElementById('mp-combo').value === 'si',
    aplicaItbis: document.getElementById('mp-aplica-itbis')?.checked ?? false,
    tracksStock: document.getElementById('mp-tracks-stock')?.checked !== false,
    metaNegocio: readDynamicProductFields(profile)
  };
  if (data.precioVenta < data.precioCompra) {
    showToast('El precio de venta no debe ser menor al de compra', 'warning');
    return;
  }

  const saveButton = document.querySelector('#modal-footer .btn-primary');
  const cancelButton = document.querySelector('#modal-footer .btn-secondary');
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.style.opacity = '0.7';
  }
  if (cancelButton) {
    cancelButton.disabled = true;
    cancelButton.style.opacity = '0.7';
  }

  try {
    let savedId = id;
    if (id) {
      const updated = await api.updateProduct(id, { ...data, ...getActorPayload() });
      const idx = DB.productos.findIndex(p => p.id === id);
      if (idx >= 0) DB.productos[idx] = updated;
      showToast('Producto actualizado', 'success');
    } else {
      const created = await api.createProduct({ ...data, ...getActorPayload() });
      DB.productos.push(created);
      savedId = created.id;
      showToast('Producto creado correctamente', 'success');
    }
    if (_pendingProductImageDataUrl && savedId) {
      try {
        const withImg = await api.uploadProductImage(savedId, _pendingProductImageDataUrl, getActorPayload());
        const idx2 = DB.productos.findIndex(p => p.id === savedId);
        if (idx2 >= 0) DB.productos[idx2] = withImg;
        _pendingProductImageDataUrl = null;
      } catch (imgErr) {
        console.error('[Tecno Caja] Error subiendo imagen:', imgErr);
        showToast(`Imagen no guardada: ${imgErr.message || 'error desconocido'}`, 'warning');
      }
    }
  } catch (error) {
    // BUG 20 fix: mensaje amigable para código/nombre duplicado (error único de BD)
    const msg = String(error.message || '');
    const isDuplicate = /duplicate|duplicado|ya existe|ER_DUP_ENTRY/i.test(msg);
    showToast(
      isDuplicate
        ? 'Ya existe un producto con ese código o nombre. Usa un identificador único.'
        : msg || 'Error al guardar el producto.',
      'error'
    );
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.style.opacity = '';
    }
    if (cancelButton) {
      cancelButton.disabled = false;
      cancelButton.style.opacity = '';
    }
    return;
  }
  closeAllModals();
  try {
    refreshProductCategoryFilter();
    loadProductsTable();
    loadInventoryTable();
    updateInventoryStats();
    if (typeof refreshAuditLogs === 'function') await refreshAuditLogs();
    if (typeof updateNotifications === 'function') updateNotifications();
  } catch (uiError) {
    console.error('[Tecno Caja] Error refrescando UI de productos:', uiError);
    showToast('Producto guardado, pero hubo un problema al refrescar la vista.', 'warning');
  }
}

async function deleteProduct(id) {
  const product = DB.productos.find((item) => item.id === id);
  if (product && Number(product.stock || 0) > 0) {
    showToast('No puedes eliminar este producto porque tiene stock pendiente.', 'warning');
    return;
  }
  if (!confirm('¿Eliminar este producto?')) return;
  const footerButtons = Array.from(document.querySelectorAll('#modal-footer button'));
  const deleteButton = footerButtons.find((button) => String(button.textContent || '').toLowerCase().includes('eliminar'));
  try {
    footerButtons.forEach((button) => {
      button.disabled = true;
      button.style.opacity = '0.7';
    });
    if (deleteButton) deleteButton.textContent = 'Eliminando...';
    await api.request(`/api/products/${id}`, {
      method: 'DELETE',
      body: JSON.stringify(getActorPayload())
    });
    closeAllModals();
    DB.productos = (DB.productos || []).filter((item) => Number(item.id) !== Number(id));
    refreshProductCategoryFilter();
    loadProductsTable();
    loadInventoryTable();
    updateInventoryStats();
    if (typeof refreshAuditLogs === 'function') await refreshAuditLogs();
    if (typeof updateNotifications === 'function') updateNotifications();
    showToast('Producto eliminado', 'success');
  } catch (error) {
    footerButtons.forEach((button) => {
      button.disabled = false;
      button.style.opacity = '';
    });
    if (deleteButton) deleteButton.textContent = 'Eliminar';
    showToast(error.message, 'error');
  }
}

async function toggleProductStatus(id) {
  const product = DB.productos.find((item) => item.id === id);
  if (!product) return;
  try {
    const updated = await api.updateProduct(id, {
      ...product,
      ...getActorPayload(),
      estado: product.estado === 'Activo' ? 'Inactivo' : 'Activo'
    });
    const idx = DB.productos.findIndex((item) => item.id === id);
    if (idx >= 0) DB.productos[idx] = updated;
    loadProductsTable();
    loadInventoryTable();
    updateInventoryStats();
    refreshAuditLogs();
    updateNotifications();
    showToast(`Producto ${updated.estado === 'Activo' ? 'activado' : 'pausado'}`, 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function exportProducts() {
  const escapeCsvCell = (value) => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    if (!/[",\n\r]/.test(text) && text.trim() === text) return text;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const rows = [[
    'Código',
    'Nombre',
    'Marca',
    'Categoría',
    'Unidad',
    'Modo Venta',
    'Costo',
    'Precio',
    'Margen',
    'Stock',
    'Stock Mínimo',
    'Estado',
    'Tipo Producto',
    'Aplica ITBIS',
    'Rastrea Stock',
    'Es Combo',
    'Tiempo Preparación',
    'Imagen URL',
    'Imagen Local'
  ]];
  getFilteredProducts().forEach((p) => rows.push([
    p.codigo,
    p.nombre,
    p.marca || '',
    p.categoria,
    p.unidad || '',
    p.saleMode || 'unidad',
    p.precioCompra,
    p.precioVenta,
    getMarginAmount(p).toFixed(2),
    p.stock,
    p.stockMin,
    p.estado,
    p.tipoProducto || 'general',
    p.aplicaItbis ? 'Sí' : 'No',
    p.tracksStock === false ? 'No' : 'Sí',
    p.esCombo ? 'Sí' : 'No',
    p.tiempoPreparacion || 0,
    p.imagenUrl || '',
    p.imagenLocal || ''
  ]));
  const csv = rows.map((row) => row.map(escapeCsvCell).join(',')).join('\n');
  downloadFile(csv, 'productos.csv', 'text/csv');
  showToast('Productos exportados', 'success');
}

function downloadFile(content, filename, type) {
  const blob = new Blob([content], {type});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

// Inventory
function loadInventoryTable() {
  const tbody = document.getElementById('inventory-tbody');
  if (!tbody) return;
  refreshInventoryCategoryFilter();
  const items = getFilteredInventoryProducts();
  tbody.innerHTML = items.map(p => {
    const difference = Number(p.stock || 0) - Number(p.stockMin || 0);
    return `
    <tr>
      <td style="font-weight:600">${typeof getLocalizedProductName === 'function' ? getLocalizedProductName(p) : p.nombre}<br><span style="font-family:var(--font-mono);font-size:0.78rem;color:var(--text3)">${p.codigo}</span></td>
      <td>${typeof getLocalizedCategoryName === 'function' ? getLocalizedCategoryName(p.categoria) : p.categoria}</td>
      <td style="font-family:var(--font-mono);font-weight:700">${p.stock}</td>
      <td style="font-family:var(--font-mono);color:var(--text2)">${p.stockMin}</td>
      <td style="font-family:var(--font-mono);color:${difference < 0 ? 'var(--danger)' : difference === 0 ? 'var(--warning)' : 'var(--success)'}">${difference >= 0 ? '+' : ''}${difference}</td>
      <td style="font-family:var(--font-mono)">${fmt(p.stock * p.precioCompra)}</td>
      <td>${getStockBadge(p)}</td>
      <td>
        <div class="products-actions">
          <button class="btn-edit" onclick="openAjusteModal(${p.id})">✏ Ajustar</button>
          <button class="btn-ghost" onclick="openKardexModal(${p.id})">📋 Kardex</button>
        </div>
      </td>
    </tr>
  `;
  }).join('') || `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text3)">No se encontraron productos con esos filtros</td></tr>`;
}

function updateInventoryStats() {
  document.getElementById('inv-total-products').textContent = DB.productos.length;
  document.getElementById('inv-low-stock').textContent = DB.productos.filter(p => p.stock > 0 && p.stock <= p.stockMin).length;
  document.getElementById('inv-out-stock').textContent = DB.productos.filter(p => p.stock === 0).length;
  const retailVal = DB.productos.reduce((s, p) => s + p.stock * Number(p.precioVenta || 0), 0);
  const costVal   = DB.productos.reduce((s, p) => s + p.stock * Number(p.precioCompra || 0), 0);
  document.getElementById('inv-total-value').textContent = fmt(retailVal);
  const invCostSub = document.getElementById('inv-cost-sub');
  if (invCostSub) invCostSub.textContent = `costo: ${fmt(costVal)}`;
}

function getFilteredInventoryProducts() {
  const search = inventoryFilters.search.toLowerCase().trim();
  return DB.productos.filter((p) => {
    const matchesSearch = !search || [
      p.nombre,
      typeof getLocalizedProductName === 'function' ? getLocalizedProductName(p) : p.nombre,
      p.codigo,
      p.categoria,
      typeof getLocalizedCategoryName === 'function' ? getLocalizedCategoryName(p.categoria) : p.categoria
    ].some((value) => String(value || '').toLowerCase().includes(search));
    const matchesCategory = !inventoryFilters.category || p.categoria === inventoryFilters.category;
    let matchesStatus = true;
    if (inventoryFilters.status === 'stock-bajo') matchesStatus = p.stock > 0 && p.stock <= p.stockMin;
    if (inventoryFilters.status === 'agotados') matchesStatus = p.stock === 0;
    if (inventoryFilters.status === 'activos') matchesStatus = p.stock > 0;
    return matchesSearch && matchesCategory && matchesStatus;
  });
}

function refreshInventoryCategoryFilter() {
  const select = document.getElementById('inventory-category-filter');
  if (!select) return;
  const previous = inventoryFilters.category;
  const categories = [...new Set(DB.productos.map((product) => product.categoria).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  select.innerHTML = '<option value="">Todas las categorías</option>' + categories.map((category) => `<option value="${category}">${typeof getLocalizedCategoryName === 'function' ? getLocalizedCategoryName(category) : category}</option>`).join('');
  select.value = previous;
}

function filterInventory() {
  inventoryFilters.search = document.getElementById('inventory-search')?.value || '';
  inventoryFilters.category = document.getElementById('inventory-category-filter')?.value || '';
  inventoryFilters.status = document.getElementById('inventory-status-filter')?.value || 'todos';
  loadInventoryTable();
}

function openAjusteModal(productId = null) {
  const opts = DB.productos.map(p => `<option value="${p.id}" ${Number(productId) === Number(p.id) ? 'selected' : ''}>${typeof getLocalizedProductName === 'function' ? getLocalizedProductName(p) : p.nombre} (Stock: ${p.stock})</option>`).join('');
  document.getElementById('modal-title').textContent = 'Ajuste de Inventario';
  document.getElementById('modal-body').innerHTML = `
    <div class="form-group"><label>Producto</label><select id="aj-prod" class="form-input" onchange="updateAjustePreview()">${opts}</select></div>
    <div class="form-group"><label>Tipo de Ajuste</label>
      <select id="aj-tipo" class="form-input" onchange="updateAjustePreview()">
        <option value="entrada">Entrada de Mercancía</option>
        <option value="salida">Salida / Merma</option>
        <option value="ajuste">Ajuste Manual (establecer cantidad)</option>
      </select>
    </div>
    <div class="form-group"><label>Cantidad</label><input type="number" id="aj-qty" class="form-input" min="0" value="1" oninput="updateAjustePreview()"></div>
    <div class="form-group"><label>Observaciones</label><input type="text" id="aj-obs" class="form-input" placeholder="Motivo del ajuste..."></div>
    <div class="product-form-summary">
      <div class="product-form-card"><label>Stock actual</label><strong id="aj-stock-actual">0</strong></div>
      <div class="product-form-card"><label>Resultado</label><strong id="aj-stock-nuevo">0</strong></div>
      <div class="product-form-card"><label>Movimiento</label><strong id="aj-movimiento-label">Entrada</strong></div>
    </div>
  `;
  document.getElementById('modal-footer').innerHTML = `
    <button class="btn-secondary" onclick="closeAllModals()">Cancelar</button>
    <button class="btn-primary" onclick="saveAjuste()">Aplicar Ajuste</button>
  `;
  document.getElementById('modal-overlay').classList.remove('hidden');
  updateAjustePreview();
}

function updateAjustePreview() {
  const productId = parseInt(document.getElementById('aj-prod')?.value, 10);
  const tipo = document.getElementById('aj-tipo')?.value || 'entrada';
  const qty = parseFloat(document.getElementById('aj-qty')?.value) || 0;
  const product = DB.productos.find((item) => Number(item.id) === productId);
  if (!product) return;

  const actual = Number(product.stock || 0);
  let nuevo = actual;
  if (tipo === 'entrada') nuevo = actual + qty;
  else if (tipo === 'salida') nuevo = Math.max(0, actual - qty);
  else nuevo = Math.max(0, qty);

  const movementLabel = tipo === 'entrada' ? 'Entrada' : tipo === 'salida' ? 'Salida' : 'Ajuste';
  document.getElementById('aj-stock-actual').textContent = actual;
  document.getElementById('aj-stock-nuevo').textContent = nuevo;
  document.getElementById('aj-movimiento-label').textContent = movementLabel;
}

async function saveAjuste() {
  const id = parseInt(document.getElementById('aj-prod').value);
  const tipo = document.getElementById('aj-tipo').value;
  const qty = parseInt(document.getElementById('aj-qty').value) || 0;
  const notes = document.getElementById('aj-obs').value.trim();
  const prod = DB.productos.find(p => p.id === id);
  if (!prod) return;
  try {
    const response = await api.adjustInventory({ productId: id, tipo, qty, notes, ...getActorPayload() });
    const updated = response.product;
    const idx = DB.productos.findIndex(p => p.id === id);
    if (idx >= 0) DB.productos[idx] = updated;
    if (response.movement) {
      DB.movimientosInventario = [response.movement, ...(DB.movimientosInventario || [])].slice(0, 300);
    }
    closeAllModals();
    refreshProductCategoryFilter();
    loadProductsTable();
    loadInventoryTable();
    updateInventoryStats();
    if (typeof refreshAuditLogs === 'function') await refreshAuditLogs();
    if (typeof updateNotifications === 'function') updateNotifications();
    showToast('Ajuste aplicado a: ' + updated.nombre, 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function openKardexModal(productId = null) {
  document.getElementById('modal-title').textContent = 'Kardex de Inventario';
  const opts = ['<option value="">Todos los productos</option>'].concat(
    DB.productos.map((p) => `<option value="${p.id}" ${Number(productId) === Number(p.id) ? 'selected' : ''}>${typeof getLocalizedProductName === 'function' ? getLocalizedProductName(p) : p.nombre}</option>`)
  ).join('');
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-grid">
      <div class="form-group"><label>Producto</label><select id="kardex-prod" class="form-input">${opts}</select></div>
      <div class="form-group"><label>Movimientos</label><select id="kardex-limit" class="form-input"><option value="50">Últimos 50</option><option value="100" selected>Últimos 100</option><option value="200">Últimos 200</option></select></div>
    </div>
    <div style="display:flex;gap:0.75rem;justify-content:flex-end;margin-bottom:1rem">
      <button class="btn-secondary" type="button" onclick="loadKardexList()">↻ Actualizar</button>
    </div>
    <div class="table-wrap" style="margin-top:0">
      <table class="data-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Producto</th>
            <th>Tipo</th>
            <th>Cantidad</th>
            <th>Antes</th>
            <th>Después</th>
            <th>Referencia</th>
            <th>Usuario</th>
          </tr>
        </thead>
        <tbody id="kardex-tbody">
          <tr><td colspan="8" style="text-align:center;padding:1.5rem;color:var(--text3)">Cargando kardex...</td></tr>
        </tbody>
      </table>
    </div>
  `;
  document.getElementById('modal-footer').innerHTML = `
    <button class="btn-secondary" onclick="closeAllModals()">Cerrar</button>
  `;
  document.getElementById('modal-overlay').classList.remove('hidden');
  await loadKardexList();
}

async function loadKardexList() {
  const tbody = document.getElementById('kardex-tbody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:1.5rem;color:var(--text3)">Cargando kardex...</td></tr>`;

  try {
    const productId = parseInt(document.getElementById('kardex-prod')?.value, 10) || '';
    const limit = parseInt(document.getElementById('kardex-limit')?.value, 10) || 100;
    const movements = await api.getInventoryMovements({ productId, limit, ...getActorPayload() });
    if (!productId) {
      DB.movimientosInventario = movements;
    }
    tbody.innerHTML = movements.map((mov) => `
      <tr>
        <td>${mov.fecha || '—'}</td>
        <td>${mov.productName}<br><span style="font-family:var(--font-mono);font-size:0.76rem;color:var(--text3)">${mov.productCode || ''}</span></td>
        <td style="text-transform:capitalize">${mov.tipo}</td>
        <td style="font-family:var(--font-mono);color:${mov.cantidad < 0 ? 'var(--danger)' : 'var(--success)'}">${mov.cantidad > 0 ? '+' : ''}${mov.cantidad}</td>
        <td style="font-family:var(--font-mono)">${mov.stockAnterior}</td>
        <td style="font-family:var(--font-mono)">${mov.stockNuevo}</td>
        <td>${mov.referenciaTipo || '—'}${mov.referenciaId ? `<br><span style="font-family:var(--font-mono);font-size:0.76rem;color:var(--text3)">${mov.referenciaId}</span>` : ''}</td>
        <td>${mov.usuarioNombre || 'Sistema'}${mov.notas ? `<br><span style="font-size:0.76rem;color:var(--text3)">${mov.notas}</span>` : ''}</td>
      </tr>
    `).join('') || `<tr><td colspan="8" style="text-align:center;padding:1.5rem;color:var(--text3)">No hay movimientos para mostrar</td></tr>`;
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:1.5rem;color:var(--danger)">${error.message}</td></tr>`;
  }
}

document.addEventListener('keydown', function handleProductScanner(event) {
  if (!productScannerState.armed) return;
  const modalVisible = !document.getElementById('modal-overlay')?.classList.contains('hidden');
  const codeInput = document.getElementById('mp-codigo');
  if (!modalVisible || !codeInput) {
    resetProductScanner();
    return;
  }

  if (event.key === 'Escape') {
    resetProductScanner();
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    const value = productScannerState.buffer.trim();
    if (value) {
      codeInput.value = value;
      codeInput.dispatchEvent(new Event('input', { bubbles: true }));
      showToast(`Código escaneado: ${value}`, 'success');
      updateProductScanHint(`Código capturado: ${value}`, 'success');
    }
    productScannerState.armed = false;
    productScannerState.buffer = '';
    if (productScannerState.timer) {
      clearTimeout(productScannerState.timer);
      productScannerState.timer = null;
    }
    if (validateProductIdentity({ notify: true, focusField: true })) {
      focusProductNameField();
    }
    return;
  }

  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    productScannerState.buffer += event.key;
    if (productScannerState.timer) clearTimeout(productScannerState.timer);
    productScannerState.timer = setTimeout(() => {
      if (productScannerState.armed) {
        updateProductScanHint('Escaneo cancelado: el lector no envió Enter.', 'warning');
        productScannerState.armed = false;
        productScannerState.buffer = '';
      }
    }, 800);
  }
});

// ─────────────────────────────────────────────────────────────────
// ESCANEO RÁPIDO DESDE LISTA DE PRODUCTOS
// Permite escanear un código de barras desde la vista principal de
// productos (sin abrir ningún modal). Si el producto existe, abre
// su modal de edición; si no existe, muestra un formulario rápido
// para guardarlo de inmediato en la base de datos.
// ─────────────────────────────────────────────────────────────────

const quickScanState = {
  armed: false,
  buffer: '',
  timer: null
};

function armQuickProductScan() {
  // No activar si ya hay un modal abierto
  const modalVisible = !document.getElementById('modal-overlay')?.classList.contains('hidden');
  if (modalVisible) {
    showToast('Cierra el formulario actual antes de usar el escaneo rápido.', 'warning');
    return;
  }
  quickScanState.armed = true;
  quickScanState.buffer = '';
  if (quickScanState.timer) clearTimeout(quickScanState.timer);

  const btn = document.getElementById('btn-products-quick-scan');
  if (btn) {
    btn.textContent = '⏳ Esperando código...';
    btn.classList.add('is-scanning');
  }
  showToast('Escáner listo: pasa el producto por el lector', 'success');
}

function disarmQuickProductScan() {
  quickScanState.armed = false;
  quickScanState.buffer = '';
  if (quickScanState.timer) { clearTimeout(quickScanState.timer); quickScanState.timer = null; }
  const btn = document.getElementById('btn-products-quick-scan');
  if (btn) {
    btn.textContent = '🔍 Escaneo Rápido';
    btn.classList.remove('is-scanning');
  }
}

function handleQuickScanResult(code) {
  disarmQuickProductScan();
  if (!code) return;

  // Buscar producto existente por código (case-insensitive)
  const existing = DB.productos.find(
    (p) => String(p.codigo || '').toLowerCase().trim() === code.toLowerCase().trim()
  );

  if (existing) {
    showToast(`Producto encontrado: ${existing.nombre}`, 'info');
    openProductModal(existing.id);
    return;
  }

  // No existe — abrir formulario rápido de registro
  openQuickAddProductModal(code);
}

function openQuickAddProductModal(scannedCode) {
  const safeCode = String(scannedCode || '');
  const cats = (DB.categorias || [])
    .map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)
    .join('');

  const overlay = document.getElementById('modal-overlay');
  const box = document.getElementById('modal-box');
  if (!overlay || !box) return;

  box.classList.remove('product-modal', 'billing-modal');
  box.classList.add('quick-add-product-modal');
  box.dataset.productId = '';

  document.getElementById('modal-title').textContent = '📦 Registro Rápido de Producto';
  document.getElementById('modal-body').innerHTML = `
    <div class="qap-wrapper">
      <div class="qap-code-badge">
        <span class="qap-code-icon">🔍</span>
        <div>
          <div class="qap-code-label">Código escaneado</div>
          <div class="qap-code-value">${escapeHtml(safeCode)}</div>
        </div>
      </div>

      <div class="form-group">
        <label>Nombre del producto <span class="required-star">*</span></label>
        <input type="text" id="qap-nombre" class="form-input" placeholder="Ej: Coca-Cola 600ml"
          onkeydown="if(event.key==='Enter'){event.preventDefault();document.getElementById('qap-precio')?.focus();}">
      </div>

      <div class="qap-row-2col">
        <div class="form-group">
          <label>Precio de venta <span class="required-star">*</span></label>
          <input type="number" id="qap-precio" class="form-input" placeholder="0.00" min="0" step="0.01"
            onkeydown="if(event.key==='Enter'){event.preventDefault();document.getElementById('qap-categoria')?.focus();}">
        </div>
        <div class="form-group">
          <label>Categoría</label>
          <select id="qap-categoria" class="form-input">
            <option value="">Sin categoría</option>
            ${cats}
          </select>
        </div>
      </div>

      <div class="qap-row-2col">
        <div class="form-group">
          <label>Precio de compra</label>
          <input type="number" id="qap-pcompra" class="form-input" placeholder="0.00" min="0" step="0.01">
        </div>
        <div class="form-group">
          <label>Stock inicial</label>
          <input type="number" id="qap-stock" class="form-input" value="0" min="0" step="1">
        </div>
      </div>
    </div>
  `;

  document.getElementById('modal-footer').innerHTML = `
    <button class="btn-secondary" onclick="closeAllModals()">Cancelar</button>
    <button class="btn-primary" id="qap-save-btn" data-qap-code="${escapeHtml(safeCode)}"
      onclick="saveQuickAddProduct(this.dataset.qapCode)">
      💾 Guardar Producto
    </button>
  `;

  overlay.classList.remove('hidden');
  // Foco automático al nombre
  setTimeout(() => document.getElementById('qap-nombre')?.focus(), 80);
}

async function saveQuickAddProduct(code) {
  const nombre = String(document.getElementById('qap-nombre')?.value || '').trim();
  if (!nombre) {
    showToast('El nombre del producto es obligatorio.', 'error');
    document.getElementById('qap-nombre')?.focus();
    return;
  }

  const precio = parseFloat(document.getElementById('qap-precio')?.value) || 0;
  const pcompra = parseFloat(document.getElementById('qap-pcompra')?.value) || 0;
  const categoria = document.getElementById('qap-categoria')?.value || '';
  const stock = parseFloat(document.getElementById('qap-stock')?.value) || 0;

  if (precio < pcompra && pcompra > 0) {
    showToast('El precio de venta no debe ser menor al de compra.', 'warning');
    return;
  }

  const saveBtn = document.getElementById('qap-save-btn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '⏳ Guardando...'; }

  try {
    const created = await api.createProduct({
      codigo: code,
      nombre,
      categoria,
      precioVenta: precio,
      precioCompra: pcompra,
      stock,
      stockMin: 5,
      estado: 'Activo',
      unidad: 'Unidad',
      saleMode: 'unidad',
      tipoProducto: 'general',
      tracksStock: true,
      ...getActorPayload()
    });

    DB.productos.push(created);
    closeAllModals();
    loadProductsTable();
    if (typeof renderSalesCatalog === 'function') renderSalesCatalog();
    showToast(`✅ ${nombre} guardado en el catálogo`, 'success');
  } catch (err) {
    showToast(`Error al guardar: ${err.message}`, 'error');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 Guardar Producto'; }
  }
}

// Listener global para captura de código de barras en modo quick-scan
document.addEventListener('keydown', function handleQuickProductListScan(event) {
  if (!quickScanState.armed) return;

  // BUG 11 fix: cancelar automáticamente si el usuario navegó fuera del módulo Productos.
  // Esto evita que el listener interfiera con el buscador de ventas u otros módulos.
  const productosModule = document.getElementById('module-productos');
  if (!productosModule?.classList.contains('active')) {
    disarmQuickProductScan();
    return;
  }

  // Si se abrió un modal mientras esperábamos, cancelar
  if (!document.getElementById('modal-overlay')?.classList.contains('hidden')) {
    disarmQuickProductScan();
    return;
  }

  if (event.key === 'Escape') {
    disarmQuickProductScan();
    showToast('Escaneo rápido cancelado.', 'info');
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    const code = quickScanState.buffer.trim();
    quickScanState.buffer = '';
    if (quickScanState.timer) { clearTimeout(quickScanState.timer); quickScanState.timer = null; }
    if (code) handleQuickScanResult(code);
    return;
  }

  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    quickScanState.buffer += event.key;
    if (quickScanState.timer) clearTimeout(quickScanState.timer);
    // Timeout de 150ms — si el lector no envió Enter, procesar de todas formas
    quickScanState.timer = setTimeout(() => {
      const code = quickScanState.buffer.trim();
      quickScanState.buffer = '';
      if (code) handleQuickScanResult(code);
    }, 150);
  }
});
