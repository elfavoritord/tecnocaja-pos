// ===== TECNO_CAJA - VENTAS MODULE =====

let searchResults = [];
let selectedSearchIdx = -1;
let pendingSaleConfirmation = null;
let currentReceiptSale = null;
let currentReceiptOptions = {};
let receiptPreviewContext = null;
let receiptPrinterCache = { expiresAt: 0, printers: [] };
let billingActivePane = 'payment';
let billingActiveStep = 'order';
let activeRecoveredQuotationId = null;
let activeRecoveredQuotationName = '';
let salesSearchFocusTimer = null;
const BILLING_MODAL_WIDTH_KEY = 'tecnocaja-billing-modal-width';
const BILLING_MODAL_HEIGHT_KEY = 'tecnocaja-billing-modal-height';
let billingModalResizeState = null;
let _billingKeyHandler = null;
const PRODUCT_IMAGE_PLACEHOLDER = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320">
    <defs>
      <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0%" stop-color="#1f2937"/>
        <stop offset="100%" stop-color="#0f172a"/>
      </linearGradient>
    </defs>
    <rect width="480" height="320" rx="28" fill="url(#g)"/>
    <circle cx="122" cy="102" r="42" fill="#f97316" opacity="0.18"/>
    <circle cx="352" cy="228" r="56" fill="#fb923c" opacity="0.12"/>
    <text x="50%" y="48%" text-anchor="middle" fill="#e5e7eb" font-family="Segoe UI, Arial, sans-serif" font-size="28" font-weight="700">Producto</text>
    <text x="50%" y="60%" text-anchor="middle" fill="#94a3b8" font-family="Segoe UI, Arial, sans-serif" font-size="16">Imagen no disponible</text>
  </svg>
`)}`;
const SALE_DOCUMENT_TYPES = {
  ticket: 'Ticket / Factura',
  'factura-electronica': 'Factura Electrónica',
  'comprobante-fiscal': 'Comprobante Fiscal'
};
const SALE_ORDER_TYPES = {
  mostrador: 'Mostrador',
  delivery: 'Delivery',
  recoger: 'Para recoger',
  mesa: 'Mesa'
};
const SALE_PAYMENT_TYPES = {
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  transferencia: 'Transferencia',
  mixto: 'Mixto (Tarjeta + Efectivo)',
  credito: 'Crédito',
  contra_entrega: 'Contra entrega',
  usd: 'Dólares (USD)'
};
const BILLING_STEP_FLOW = ['order', 'client', 'payment', 'confirm'];
const BILLING_LAST_CLIENT_KEY = 'tecnocaja-billing-last-client-id';
const BILLING_KEEP_LAST_CLIENT_KEY = 'tecnocaja-billing-keep-last-client';
const BILLING_CARD_TYPES = ['Débito', 'Crédito', 'Amex', 'Prepagada'];
const BILLING_RESPONSIBLE_TYPES = [
  { key: 'cajero', label: 'Cajero', icon: '🧾', hint: 'Cobro en caja principal' },
  { key: 'delivery', label: 'Delivery', icon: '🛵', hint: 'Entrega y cobro en ruta' },
  { key: 'vendedor', label: 'Vendedor', icon: '🏷️', hint: 'Venta asistida o comercial' }
];
let billingModalState = createDefaultBillingModalState();
let _billingSubmitting = false;
const SALES_UI_PREFS_KEY = 'tecnocaja-ui-preferences';
const SALE_SCALE_MODAL_ID = 'sale-scale-overlay';

let saleScaleState = {
  resolver: null,
  overlay: null,
  product: null,
  config: null,
  reading: null,
  hidTimer: null,
  serialBusy: false
};

function createDefaultBillingModalState() {
  return {
    step: 'order',
    discardPromptVisible: false,
    cardBank: '',
    cardReference: '',
    cardType: '',
    transferBank: '',
    transferReference: '',
    transferCaptureName: '',
    mixedCashAmount: '',
    mixedCardAmount: '',
    mixedTransferAmount: '',
    creditDueDate: '',
    creditNotes: '',
    responsibleType: 'cajero'
  };
}

function getSaleScaleUtils() {
  return window.TecnoCajaScaleUtils || {
    normalizeSaleMode(value) {
      const normalized = String(value || 'unidad').trim().toLowerCase();
      return ['unidad', 'medida', 'peso'].includes(normalized) ? normalized : 'unidad';
    },
    normalizeWeightUnit(value, fallback = 'kg') {
      const normalized = String(value || '').trim().toLowerCase();
      if (['kg', 'kilogramo', 'kilogramo (kg)'].includes(normalized)) return 'kg';
      if (['g', 'gramo', 'gramo (g)'].includes(normalized)) return 'g';
      if (['lb', 'libra', 'libra (lb)'].includes(normalized)) return 'lb';
      return fallback;
    },
    isWeightUnit(value) {
      return ['kg', 'g', 'lb'].includes(this.normalizeWeightUnit(value, ''));
    },
    getProductSaleMode(product = {}) {
      return this.normalizeSaleMode(product.saleMode || product.sale_mode || product.ventaPor);
    },
    getProductWeightUnit(product = {}, fallback = 'kg') {
      return this.normalizeWeightUnit(product.unidad || product.unit || product.weightUnit, fallback);
    },
    convertWeight(value, fromUnit, toUnit) {
      const numeric = Number(value || 0);
      const normalizedFrom = this.normalizeWeightUnit(fromUnit, 'kg');
      const normalizedTo = this.normalizeWeightUnit(toUnit, normalizedFrom);
      if (!Number.isFinite(numeric) || normalizedFrom === normalizedTo) return numeric;
      let valueInKg = numeric;
      if (normalizedFrom === 'g') valueInKg = numeric / 1000;
      if (normalizedFrom === 'lb') valueInKg = numeric * 0.45359237;
      if (normalizedTo === 'g') return valueInKg * 1000;
      if (normalizedTo === 'lb') return valueInKg / 0.45359237;
      return valueInKg;
    },
    sanitizeDecimals(value, fallback = 2) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return fallback;
      return Math.max(0, Math.min(2, Math.floor(numeric)));
    },
    roundValue(value, decimals = 2) {
      const numeric = Number(value || 0);
      const normalizedDecimals = this.sanitizeDecimals(decimals, 2);
      return Number.isFinite(numeric) ? Number(numeric.toFixed(normalizedDecimals)) : 0;
    },
    formatValue(value, decimals = 2) {
      const numeric = Number(value || 0);
      const normalizedDecimals = this.sanitizeDecimals(decimals, 2);
      return numeric.toLocaleString('es-DO', {
        minimumFractionDigits: normalizedDecimals,
        maximumFractionDigits: normalizedDecimals
      });
    },
    parseScaleReading(rawValue, options = {}) {
      const raw = String(rawValue || '').replace(/\s+/g, ' ').trim();
      if (!raw) return { ok: false, reason: 'empty', raw: '' };
      const pattern = String(options.pattern || '(-?\\d+(?:[\\.,]\\d+)?)\\s*(kg|g|lb)?').trim() || '(-?\\d+(?:[\\.,]\\d+)?)\\s*(kg|g|lb)?';
      const matcher = new RegExp(pattern, 'i');
      const match = raw.match(matcher);
      if (!match) return { ok: false, reason: 'pattern_mismatch', raw };
      const numericValue = Number.parseFloat(String(match[1] || '').replace(/,/g, '.'));
      if (!Number.isFinite(numericValue)) return { ok: false, reason: 'invalid_number', raw };
      const decimals = this.sanitizeDecimals(options.decimals, 2);
      return {
        ok: true,
        raw,
        unit: this.normalizeWeightUnit(match[2], options.defaultUnit || 'kg'),
        value: this.roundValue(numericValue, decimals),
        valueRaw: numericValue,
        decimals
      };
    }
  };
}

// ── Parser de código de báscula (EAN-13 con precio/peso embebido) ─────────────
// Formato confirmado: PP PPPPP VVVVV C  (13 dígitos)
//   PP    = prefijo 2 dígitos (01, 20, 22, etc. — varía según báscula)
//   PPPPP = PLU del producto (5 dígitos)
//   VVVVV = valor embebido (precio total entero o gramos)
//   C     = dígito verificador
// Ejemplos reales:
//   0100001001003  → PLU=1,  precio=RD$100 (POLLO $100/pcs)
//   2000025001008  → PLU=25, precio=RD$100 (prefijo 20)
//   2200025001008  → PLU=25, precio=RD$100 (prefijo 22)
// El valor VVVVV es el precio TOTAL en moneda entera (sin decimales implícitos).
function parseScaleBarcode(code) {
  if (!/^\d{13}$/.test(code)) return null;
  // Siempre intentamos prefijo de 2 dígitos primero (formato confirmado de la báscula)
  // y prefijo de 1 dígito como respaldo
  return [
    { pluPadded: code.substring(2, 7), embeddedStr: code.substring(7, 12) },  // prefijo 2 dígitos
    { pluPadded: code.substring(1, 6), embeddedStr: code.substring(6, 11) }   // prefijo 1 dígito
  ].map(({ pluPadded, embeddedStr }) => {
    const plu = String(parseInt(pluPadded, 10));
    const embeddedValue = parseInt(embeddedStr, 10);
    return { plu, pluPadded, embeddedStr, embeddedValue,
      weightGrams: embeddedValue,       // si embed = peso: valor en gramos
      weightKg: embeddedValue / 1000,   // en kg
      priceAmount: embeddedValue        // si embed = precio: valor directo en moneda (entero)
    };
  });
}

// Intenta agregar un producto a partir de un código de báscula.
// Retorna true si lo procesó, false si el código no era de báscula o el PLU no existe.
function addProductByScaleBarcode(scanned) {
  const candidates = parseScaleBarcode(scanned);
  if (!candidates) return false;
  let prod = null;
  let parsed = null;
  // 1. Busca por PLU extraído (prefijo 1 dígito, luego 2 dígitos)
  // Solo aplica a productos de PESO o MEDIDA — los de unidad normal se manejan por el flujo estándar.
  for (const candidate of candidates) {
    const found = DB.productos.find(
      (p) => p.codigo === candidate.plu || p.codigo === candidate.pluPadded
    );
    if (found && getSaleItemSaleMode(found, found) !== 'unidad') {
      prod = found;
      parsed = candidate;
      break;
    }
  }
  // 2. El producto tiene el barcode completo como código.
  // Solo se extrae peso/precio embebido si el producto NO es de venta por unidad normal.
  // Un EAN-13 estándar (producto de unidad) debe pasar por el flujo normal para agregar qty=1.
  if (!prod) {
    const fullMatchProd = DB.productos.find((p) => p.codigo === scanned);
    if (fullMatchProd) {
      if (getSaleItemSaleMode(fullMatchProd, fullMatchProd) === 'unidad') {
        // Barcode EAN-13 normal — el flujo estándar lo agrega con cantidad 1.
        return false;
      }
      prod = fullMatchProd;
      // Elegir la interpretación con peso realista (< 30 kg).
      // Fallback a candidates[0] (prefijo-2, formato estándar de báscula) en lugar de candidates[1].
      parsed = candidates.find((c) => c.weightKg < 30 && c.weightKg > 0) || candidates[0];
    }
  }
  if (!prod || !parsed) return false;

  const saleMode = getSaleItemSaleMode(prod, prod);
  const utils = getSaleScaleUtils();
  let nextQty;
  let lineExtra = {};

  if (saleMode === 'peso') {
    const weightUnit = utils.normalizeWeightUnit(prod.weightUnit || prod.unidadPeso || DB.config?.scaleDefaultUnit, 'kg');
    nextQty = weightUnit === 'g' ? parsed.weightGrams : parsed.weightKg;
    lineExtra = { weightUnit, scaleWeight: parsed.weightKg,
      scaleMeasuredValue: parsed.weightGrams, scaleMeasuredUnit: 'g',
      scaleSource: 'barcode', scaleRawReading: parsed.embeddedStr };
  } else {
    // Precio embebido: calcular cantidad proporcional
    const unitPrice = Number(prod.precioVenta || 0);
    nextQty = unitPrice > 0 ? Math.round((parsed.priceAmount / unitPrice) * 1000) / 1000 : 1;
  }

  if (!nextQty || nextQty <= 0) nextQty = 1;

  const existIdx = findMergeableSaleItemIndex(prod, saleMode);
  if (existIdx >= 0) {
    const nextTotalQty = Number(DB.saleItems[existIdx]?.qty || 0) + nextQty;
    DB.saleItems[existIdx] = recalcSaleItemForQty(DB.saleItems[existIdx], nextTotalQty);
  } else {
    DB.saleItems.push(buildSaleItem(prod, nextQty, lineExtra));
  }

  document.getElementById('product-search').value = '';
  document.getElementById('search-dropdown')?.classList.add('hidden');
  searchResults = [];
  renderSaleTable();
  updateTotals();
  renderSalesCatalog();
  focusSalesSearchInput({ force: true });
  return true;
}

function getSaleScaleConfig() {
  const utils = getSaleScaleUtils();
  const cfg = getEffectiveConfig();
  return {
    type: String(cfg.scaleType || 'none').trim().toLowerCase() || 'none',
    serialPort: String(cfg.scaleSerialPort || '').trim(),
    baudRate: Math.max(300, Number(cfg.scaleSerialBaudRate || 9600) || 9600),
    pattern: String(cfg.scaleReadPattern || '').trim(),
    defaultUnit: utils.normalizeWeightUnit(cfg.scaleDefaultUnit || 'kg', 'kg') || 'kg',
    roundingDecimals: utils.sanitizeDecimals(cfg.scaleRoundingDecimals ?? 2, 2),
    autoRead: Boolean(cfg.scaleAutoRead ?? true)
  };
}

function getSaleQuantityDecimals() {
  return getSaleScaleConfig().roundingDecimals;
}

function findProductForSaleItem(item = {}) {
  const productId = Number(item.id || item.productId || 0);
  return productId ? (DB.productos || []).find((product) => Number(product.id || 0) === productId) || null : null;
}

function getSaleItemSaleMode(item = {}, product = null) {
  const utils = getSaleScaleUtils();
  const productRef = product || findProductForSaleItem(item);
  return utils.normalizeSaleMode(item.saleMode || item.sale_mode || productRef?.saleMode || productRef?.sale_mode || item.ventaPor || 'unidad');
}

function getSaleItemUnitLabel(item = {}, product = null) {
  const productRef = product || findProductForSaleItem(item);
  return String(item.unitLabel || item.unidad || item.unit || productRef?.unidad || 'Unidad').trim() || 'Unidad';
}

function getSaleItemWeightUnit(item = {}, product = null) {
  const utils = getSaleScaleUtils();
  const saleMode = getSaleItemSaleMode(item, product);
  if (saleMode !== 'peso') return '';
  const fallbackUnit = getSaleScaleConfig().defaultUnit;
  return utils.normalizeWeightUnit(item.weightUnit || item.scaleMeasuredUnit || getSaleItemUnitLabel(item, product), fallbackUnit) || fallbackUnit;
}

function getCompactSaleUnitLabel(item = {}, product = null) {
  const saleMode = getSaleItemSaleMode(item, product);
  if (saleMode === 'peso') return getSaleItemWeightUnit(item, product);

  const label = getSaleItemUnitLabel(item, product);
  const normalized = String(label || '').trim().toLowerCase();
  if (normalized === 'metro') return 'm';
  if (normalized === 'pie') return 'ft';
  if (normalized === 'galón' || normalized === 'galon') return 'gal';
  if (normalized === 'unidad') return 'u';
  if (normalized === 'caja') return 'cj';
  if (normalized === 'paquete') return 'paq';
  if (normalized === 'rollo') return 'roll';
  if (normalized === 'saco') return 'sac';
  return label;
}

function isWeightSaleItem(item = {}, product = null) {
  return getSaleItemSaleMode(item, product) === 'peso';
}

function isMeasureSaleItem(item = {}, product = null) {
  return getSaleItemSaleMode(item, product) === 'medida';
}

function getSaleItemQuantityStep(item = {}, product = null) {
  return getSaleItemSaleMode(item, product) === 'unidad' ? '1' : '0.01';
}

function getSaleItemMinQuantity(item = {}, product = null) {
  return getSaleItemSaleMode(item, product) === 'unidad' ? '1' : '0.01';
}

function sanitizeSaleItemQty(item = {}, value, options = {}) {
  const saleMode = getSaleItemSaleMode(item);
  const allowZero = Boolean(options.allowZero);
  let numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) numeric = 0;

  if (saleMode === 'unidad') {
    const rounded = Math.round(numeric || 0);
    return allowZero ? Math.max(0, rounded) : Math.max(1, rounded || 1);
  }

  const minimum = allowZero ? 0 : 0.01;
  return getSaleScaleUtils().roundValue(Math.max(minimum, numeric), getSaleQuantityDecimals());
}

function formatSaleItemQuantity(item = {}, value = item.qty, options = {}) {
  const saleMode = getSaleItemSaleMode(item);
  const compactUnit = Boolean(options.compactUnit);
  const includeUnit = Boolean(options.includeUnit);
  const includeUnitForUnitMode = Boolean(options.includeUnitForUnitMode);

  if (saleMode === 'unidad') {
    const numeric = Number(value || 0);
    const formatted = Number.isFinite(numeric) ? String(Math.max(0, Math.round(numeric))) : '0';
    if (!includeUnit || !includeUnitForUnitMode) return formatted;
    return `${formatted}${compactUnit ? 'u' : ' un.'}`;
  }

  const decimals = getSaleQuantityDecimals();
  const formattedValue = getSaleScaleUtils().formatValue(value, decimals);
  if (!includeUnit) return formattedValue;

  const unitLabel = compactUnit
    ? getCompactSaleUnitLabel(item)
    : (saleMode === 'peso' ? getSaleItemWeightUnit(item) : getSaleItemUnitLabel(item));
  return compactUnit ? `${formattedValue}${unitLabel}` : `${formattedValue} ${unitLabel}`;
}

function formatReceiptSaleItemQuantity(item = {}, options = {}) {
  const saleMode = getSaleItemSaleMode(item);
  return formatSaleItemQuantity(item, item.qty ?? item.cantidad, {
    includeUnit: saleMode !== 'unidad',
    compactUnit: Boolean(options.compactUnit)
  });
}

function buildSaleItemPriceLabel(item = {}, product = null) {
  const saleMode = getSaleItemSaleMode(item, product);
  if (saleMode === 'peso') {
    return `Precio por ${getSaleItemWeightUnit(item, product)}`;
  }
  if (saleMode === 'medida') {
    return `Precio por ${getSaleItemUnitLabel(item, product)}`;
  }
  return 'Precio por unidad';
}

function buildSaleItemMeta(item = {}, product = null) {
  const saleMode = getSaleItemSaleMode(item, product);
  const modeLabel = saleMode === 'peso'
    ? 'Venta por peso'
    : (saleMode === 'medida' ? 'Venta por medida' : 'Venta por unidad');
  const unitLabel = saleMode === 'peso'
    ? getSaleItemWeightUnit(item, product)
    : getSaleItemUnitLabel(item, product);
  const scaleSource = isWeightSaleItem(item, product)
    ? (item.scaleSource === 'serial'
        ? 'Báscula COM'
        : (item.scaleSource === 'usb' ? 'Báscula USB' : 'Báscula'))
    : '';
  return [modeLabel, unitLabel, scaleSource].filter(Boolean).join(' · ');
}

function normalizeSaleItem(item = {}) {
  const product = findProductForSaleItem(item);
  const saleMode = getSaleItemSaleMode(item, product);
  const unitLabel = getSaleItemUnitLabel(item, product);
  const weightUnit = saleMode === 'peso' ? getSaleItemWeightUnit(item, product) : '';
  const normalized = {
    ...item,
    saleMode,
    unitLabel,
    weightUnit,
    qty: sanitizeSaleItemQty({ ...item, saleMode }, item.qty)
  };

  if (saleMode === 'peso') {
    normalized.scaleWeight = Number.isFinite(Number(item.scaleWeight))
      ? getSaleScaleUtils().roundValue(Number(item.scaleWeight), getSaleQuantityDecimals())
      : normalized.qty;
    normalized.scaleMeasuredValue = Number.isFinite(Number(item.scaleMeasuredValue))
      ? getSaleScaleUtils().roundValue(Number(item.scaleMeasuredValue), getSaleQuantityDecimals())
      : normalized.scaleWeight;
    normalized.scaleMeasuredUnit = item.scaleMeasuredUnit || weightUnit;
    normalized.scaleSource = String(item.scaleSource || '').trim();
    normalized.scaleRawReading = String(item.scaleRawReading || '').trim();
  } else {
    normalized.scaleWeight = null;
    normalized.scaleMeasuredValue = null;
    normalized.scaleMeasuredUnit = '';
    normalized.scaleSource = '';
    normalized.scaleRawReading = '';
  }

  return normalized;
}

function normalizeCartSaleItems() {
  DB.saleItems = (DB.saleItems || []).map((item) => normalizeSaleItem(item));
  return DB.saleItems;
}

// Espejo liviano de isBetterCandidate() en server/services/promotion-engine.js
// — solo para pintar el precio en el carrito; el servidor SIEMPRE vuelve a
// resolver la promoción al cerrar la venta (server.js y offline.routes.js),
// así que una discrepancia aquí nunca compromete el precio realmente cobrado.
function isBetterPromotionCandidateClient(candidate, current) {
  if (candidate.prioridad !== current.prioridad) return candidate.prioridad > current.prioridad;
  const cs = candidate.precioOriginal - candidate.precioPromocion;
  const us = current.precioOriginal - current.precioPromocion;
  if (cs !== us) return cs > us;
  return new Date(candidate.createdAt || 0).getTime() > new Date(current.createdAt || 0).getTime();
}

// Decide qué promoción aplica a una línea del carrito según su cantidad.
// Si el producto tiene una Oferta de Precio y/o un Descuento por Cantidad
// activos (ver js/promociones.js, DB.activePromotions/DB.quantityPromotions
// cargados al entrar a Ventas), resuelve cuál gana — nunca toca
// product.precioVenta ni el campo de descuento manual (item.descuento), son
// sistemas independientes.
function resolvePromotionForCartLine(productId, qty) {
  const oferta = DB.activePromotions?.[productId] || null;
  const cantidad = DB.quantityPromotions?.[productId] || null;
  const qtyQualifies = Boolean(cantidad) && Number(qty) >= Number(cantidad.cantidadMinima);
  if (qtyQualifies && oferta) return isBetterPromotionCandidateClient(cantidad, oferta) ? cantidad : oferta;
  if (qtyQualifies) return cantidad;
  return oferta;
}

// Recalcula precio + promoAplicada + total de una línea del carrito para su
// cantidad final — necesario porque, a diferencia de Oferta de Precio, un
// Descuento por Cantidad depende de cuánto termine habiendo en el carrito.
function recalcSaleItemForQty(item, qty) {
  const promo = resolvePromotionForCartLine(Number(item.id), qty);
  const product = findProductForSaleItem(item);
  const updated = normalizeSaleItem({
    ...item,
    qty,
    precio: promo ? Number(promo.precioPromocion) : Number(product?.precioVenta ?? item.precio ?? 0),
    promoAplicada: promo ? {
      promotionId: promo.promotionId,
      nombre: promo.nombre,
      precioOriginal: Number(promo.precioOriginal),
      ahorro: Number(promo.ahorro),
      texto: promo.texto || '',
      color: promo.color || '',
      cantidadMinima: promo.cantidadMinima ?? null,
    } : null,
  });
  updated.total = calcItemTotal(updated);
  return updated;
}

function buildSaleItem(product, qty = 1, extra = {}) {
  const promo = resolvePromotionForCartLine(product.id, qty);
  const item = normalizeSaleItem({
    id: product.id,
    codigo: product.codigo,
    nombre: product.nombre,
    precio: promo ? Number(promo.precioPromocion) : Number(product.precioVenta || 0),
    promoAplicada: promo ? {
      promotionId: promo.promotionId,
      nombre: promo.nombre,
      precioOriginal: Number(promo.precioOriginal),
      ahorro: Number(promo.ahorro),
      texto: promo.texto || '',
      color: promo.color || '',
      cantidadMinima: promo.cantidadMinima ?? null,
    } : null,
    qty,
    // El % de descuento configurado en la ficha del producto se precarga
    // aquí — es lo mismo que ya usa el descuento general de la venta
    // (calculateSaleItemDiscount), así que no hace falta tocar el resto del
    // cálculo de totales/ITBIS/recibo, ya lo respetan automáticamente.
    descuento: Number(extra.descuento ?? product.descuentoPct ?? 0),
    itbisModo: (product.aplicaItbis && product.itbisModo === 'monto') ? 'monto' : 'porcentaje',
    itbisMontoUnit: (product.aplicaItbis && product.itbisModo === 'monto') ? Number(product.itbisMonto || 0) : 0,
    itbis: (product.aplicaItbis && product.itbisModo !== 'monto') ? Number(DB.config.itbis || 0) : 0,
    saleMode: extra.saleMode || product.saleMode || 'unidad',
    unitLabel: extra.unitLabel || product.unidad || 'Unidad',
    weightUnit: extra.weightUnit || '',
    scaleWeight: extra.scaleWeight ?? null,
    scaleMeasuredValue: extra.scaleMeasuredValue ?? null,
    scaleMeasuredUnit: extra.scaleMeasuredUnit || '',
    scaleSource: extra.scaleSource || '',
    scaleRawReading: extra.scaleRawReading || ''
  });
  item.total = calcItemTotal(item);
  return item;
}

function buildQuickSaleItem({ nombre, precio, qty, aplicaItbis = true }) {
  const item = normalizeSaleItem({
    id: null,
    codigo: 'RAPIDO',
    nombre: String(nombre || '').trim(),
    precio: Number(precio || 0),
    qty: Number(qty || 1),
    descuento: 0,
    itbis: aplicaItbis ? Number(getSaleTaxConfig().taxRate || 0) : 0,
    saleMode: 'unidad',
    unitLabel: 'Unidad',
    quickSale: true,
  });
  item.total = calcItemTotal(item);
  return item;
}

function syncQuickSaleTotal() {
  const price = Number(document.getElementById('quick-sale-price')?.value || 0);
  const qty = Number(document.getElementById('quick-sale-qty')?.value || 0);
  const aplicaItbis = document.getElementById('quick-sale-itbis')?.checked !== false;
  const total = document.getElementById('quick-sale-total-value');
  if (!total) return;
  total.textContent = fmt(price > 0 && qty > 0
    ? calcItemTotal(buildQuickSaleItem({ nombre: 'Producto rápido', precio: price, qty, aplicaItbis }))
    : 0);
}

function openQuickSaleModal() {
  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');
  if (!overlay || !title || !body || !footer) return;

  title.textContent = 'Agregar producto rápido';
  body.innerHTML = `
    <form id="quick-sale-form" class="quick-sale-form" onsubmit="event.preventDefault();addQuickSaleItem()">
      <div class="form-group">
        <label for="quick-sale-name">Nombre del producto</label>
        <input class="form-input" id="quick-sale-name" type="text" maxlength="150" autocomplete="off" placeholder="Ej. Cable especial" required>
      </div>
      <div class="quick-sale-fields">
        <div class="form-group">
          <label for="quick-sale-price">Precio unitario</label>
          <input class="form-input" id="quick-sale-price" type="number" min="0.01" max="99999999.99" step="0.01" inputmode="decimal" oninput="syncQuickSaleTotal()" required>
        </div>
        <div class="form-group">
          <label for="quick-sale-qty">Cantidad</label>
          <input class="form-input" id="quick-sale-qty" type="number" min="1" max="999999" step="1" value="1" inputmode="numeric" oninput="syncQuickSaleTotal()" required>
        </div>
      </div>
      <div class="form-group compact-toggle-card">
        <label class="toggle-switch" style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;user-select:none">
          <input type="checkbox" id="quick-sale-itbis" checked style="width:auto" onchange="syncQuickSaleTotal()">
          <span>Aplicar ITBIS (${DB.config?.itbis ?? 18}%) a este producto</span>
        </label>
      </div>
      <div class="quick-sale-total" aria-live="polite">
        <span>Total del producto</span>
        <strong id="quick-sale-total-value">${fmt(0)}</strong>
      </div>
    </form>`;
  footer.innerHTML = `
    <button class="btn-secondary" type="button" onclick="closeAllModals();focusSalesSearchInput({force:true})">Cancelar</button>
    <button class="btn-primary" type="submit" form="quick-sale-form">Agregar al pedido</button>`;
  overlay.classList.remove('hidden');
  setTimeout(() => document.getElementById('quick-sale-name')?.focus(), 50);
}

function addQuickSaleItem() {
  const nameInput = document.getElementById('quick-sale-name');
  const priceInput = document.getElementById('quick-sale-price');
  const qtyInput = document.getElementById('quick-sale-qty');
  const aplicaItbis = document.getElementById('quick-sale-itbis')?.checked !== false;
  const nombre = String(nameInput?.value || '').trim();
  const precio = Number(priceInput?.value || 0);
  const qty = Number(qtyInput?.value || 0);

  if (!nombre) {
    showToast('Escribe el nombre del producto.', 'warning');
    nameInput?.focus();
    return;
  }
  if (!Number.isFinite(precio) || precio <= 0) {
    showToast('El precio debe ser mayor que cero.', 'warning');
    priceInput?.focus();
    return;
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    showToast('La cantidad debe ser un número entero mayor que cero.', 'warning');
    qtyInput?.focus();
    return;
  }

  DB.saleItems.push(buildQuickSaleItem({ nombre, precio, qty, aplicaItbis }));
  closeAllModals();
  renderSaleTable();
  updateTotals();
  showToast(`Producto rápido agregado: ${nombre}`, 'success');
  focusSalesSearchInput({ force: true });
}

function findMergeableSaleItemIndex(product, saleMode) {
  if (saleMode === 'peso') return -1;
  return (DB.saleItems || []).findIndex((item) => {
    if (Number(item.id || 0) !== Number(product.id || 0)) return false;
    return getSaleItemSaleMode(item, product) === saleMode;
  });
}

// Suma la cantidad de un producto que ya está en el carrito (aún no facturada),
// para poder mostrar disponibilidad en vivo y evitar agregar más de lo que hay.
function getCartQtyForProduct(productId, excludeIdx = -1) {
  return (DB.saleItems || []).reduce((sum, item, idx) => {
    if (idx === excludeIdx) return sum;
    return Number(item.id || 0) === Number(productId) ? sum + Number(item.qty || 0) : sum;
  }, 0);
}

function focusSaleQuantityInput(index, options = {}) {
  setTimeout(() => {
    const input = document.getElementById(`sale-item-qty-${index}`);
    if (!input) return;
    input.focus({ preventScroll: true });
    if (options.select && typeof input.select === 'function') {
      input.select();
    }
  }, Number(options.delay ?? 0));
}

function getSaleLineCountLabel(items = [], fallbackCount = null) {
  const total = Array.isArray(items) && items.length
    ? items.length
    : Math.max(0, Math.round(Number(fallbackCount || 0)));
  return `${total} ${total === 1 ? 'producto' : 'productos'}`;
}

function setSaleScaleStatus(message, tone = 'info') {
  const status = document.getElementById('sale-scale-status');
  if (!status) return;
  status.textContent = message;
  status.style.color = tone === 'success'
    ? 'var(--success)'
    : (tone === 'error' ? 'var(--danger)' : 'var(--text2)');
}

function updateSaleScaleSummary() {
  const state = saleScaleState;
  const product = state.product;
  const reading = state.reading;
  if (!product) return;

  const weightEl = document.getElementById('sale-scale-live-weight');
  const priceEl = document.getElementById('sale-scale-live-price');
  const totalEl = document.getElementById('sale-scale-live-total');
  const rawEl = document.getElementById('sale-scale-raw-reading');
  const confirmBtn = document.getElementById('sale-scale-confirm-btn');
  const unitForPricing = reading?.productUnit || getSaleItemWeightUnit({ saleMode: 'peso', unitLabel: product.unidad }, product);
  const detected = reading?.qty || 0;
  const baseTotal = Number(product.precioVenta || 0) * detected;

  if (weightEl) {
    weightEl.textContent = formatSaleItemQuantity(
      { saleMode: 'peso', weightUnit: unitForPricing },
      detected,
      { includeUnit: true }
    );
  }
  if (priceEl) {
    priceEl.textContent = `${fmt(Number(product.precioVenta || 0))} / ${unitForPricing}`;
  }
  if (totalEl) {
    totalEl.textContent = fmt(baseTotal);
  }
  if (rawEl) {
    rawEl.textContent = reading?.raw || 'Esperando lectura...';
  }
  if (confirmBtn) confirmBtn.disabled = !reading || detected <= 0;
}

function applyScaleReadingToDialog(parsed, source = 'usb') {
  const state = saleScaleState;
  if (!state.product) return false;

  const utils = getSaleScaleUtils();
  const productUnit = utils.getProductWeightUnit(state.product, state.config?.defaultUnit || 'kg');
  const qty = utils.roundValue(
    utils.convertWeight(parsed.value, parsed.unit, productUnit),
    getSaleQuantityDecimals()
  );

  if (!(qty > 0)) {
    setSaleScaleStatus('La báscula devolvió un peso inválido. Intenta de nuevo.', 'error');
    return false;
  }

  state.reading = {
    raw: parsed.raw,
    qty,
    productUnit,
    scaleMeasuredValue: parsed.value,
    scaleMeasuredUnit: parsed.unit,
    scaleSource: source
  };
  updateSaleScaleSummary();
  setSaleScaleStatus('Peso detectado correctamente. Puedes confirmar la venta.', 'success');
  return true;
}

function consumeSaleScaleHidInput() {
  const input = document.getElementById('sale-scale-hid-input');
  if (!input) return false;

  const rawValue = String(input.value || '').trim();
  if (!rawValue) {
    setSaleScaleStatus('La báscula USB aún no ha enviado ningún peso.', 'info');
    return false;
  }

  const parsed = getSaleScaleUtils().parseScaleReading(rawValue, {
    pattern: saleScaleState.config?.pattern,
    defaultUnit: saleScaleState.config?.defaultUnit,
    decimals: saleScaleState.config?.roundingDecimals
  });

  if (!parsed.ok) {
    setSaleScaleStatus('No pude interpretar la lectura recibida por USB. Revisa el formato configurado.', 'error');
    const rawEl = document.getElementById('sale-scale-raw-reading');
    if (rawEl) rawEl.textContent = rawValue;
    return false;
  }

  input.value = '';
  return applyScaleReadingToDialog(parsed, 'usb');
}

function scheduleSaleScaleHidParse() {
  clearTimeout(saleScaleState.hidTimer);
  saleScaleState.hidTimer = setTimeout(() => {
    consumeSaleScaleHidInput();
  }, 180);
}

function armSaleScaleUsbCapture() {
  const input = document.getElementById('sale-scale-hid-input');
  if (!input) return;
  input.focus({ preventScroll: true });
  input.select?.();
  setSaleScaleStatus('Coloque el producto en la báscula. Estoy esperando la lectura USB.', 'info');
}

async function requestSaleScaleWeightRead() {
  const state = saleScaleState;
  if (!state.product || !state.config) return;

  if (state.config.type === 'usb') {
    armSaleScaleUsbCapture();
    return;
  }

  if (state.config.type !== 'serial') {
    setSaleScaleStatus('Configura primero el tipo de báscula en Ajustes del sistema.', 'error');
    return;
  }

  if (!window.novaDesktop?.readScaleWeight) {
    setSaleScaleStatus('La lectura por puerto COM solo está disponible en la app de escritorio.', 'error');
    return;
  }

  if (state.serialBusy) return;
  state.serialBusy = true;
  setSaleScaleStatus('Leyendo peso desde la báscula serial...', 'info');

  const button = document.getElementById('sale-scale-read-btn');
  if (button) button.disabled = true;

  try {
    const result = await window.novaDesktop.readScaleWeight({
      serialPort: state.config.serialPort,
      baudRate: state.config.baudRate
    });

    if (!result?.ok) {
      throw new Error(result?.error || 'No se recibió ninguna lectura desde la báscula serial.');
    }

    const parsed = getSaleScaleUtils().parseScaleReading(result.raw, {
      pattern: state.config.pattern,
      defaultUnit: state.config.defaultUnit,
      decimals: state.config.roundingDecimals
    });

    if (!parsed.ok) {
      throw new Error('La lectura serial no coincide con el formato configurado.');
    }

    applyScaleReadingToDialog(parsed, 'serial');
  } catch (error) {
    setSaleScaleStatus(error.message || 'No se pudo leer el peso desde la báscula.', 'error');
    const rawEl = document.getElementById('sale-scale-raw-reading');
    if (rawEl) rawEl.textContent = 'Sin lectura válida';
  } finally {
    state.serialBusy = false;
    if (button) button.disabled = false;
  }
}

function confirmSaleScaleWeight() {
  const reading = saleScaleState.reading;
  if (!reading || !(Number(reading.qty || 0) > 0)) {
    setSaleScaleStatus('Necesitas una lectura válida antes de confirmar.', 'error');
    return;
  }

  closeSaleScaleDialog({
    qty: reading.qty,
    weightUnit: reading.productUnit,
    scaleWeight: reading.qty,
    scaleMeasuredValue: reading.scaleMeasuredValue,
    scaleMeasuredUnit: reading.scaleMeasuredUnit,
    scaleSource: reading.scaleSource,
    scaleRawReading: reading.raw
  });
}

function closeSaleScaleDialog(result = null) {
  const state = saleScaleState;
  clearTimeout(state.hidTimer);

  if (state.overlay?.remove) {
    state.overlay.remove();
  } else {
    document.getElementById(SALE_SCALE_MODAL_ID)?.remove();
  }

  saleScaleState = {
    resolver: null,
    overlay: null,
    product: null,
    config: null,
    reading: null,
    hidTimer: null,
    serialBusy: false
  };

  if (typeof state.resolver === 'function') {
    state.resolver(result);
  }
  if (typeof window.scheduleSalesSearchFocus === 'function') {
    window.scheduleSalesSearchFocus({ force: true });
  }
}

function buildSaleScaleModalMarkup(product) {
  const config = getSaleScaleConfig();
  const weightUnit = getSaleScaleUtils().getProductWeightUnit(product, config.defaultUnit);
  const typeLabel = config.type === 'serial' ? 'Báscula por puerto COM' : 'Báscula USB / HID';
  const autoReadLabel = config.autoRead
    ? 'La captura automática está activa para este producto.'
    : 'Usa el botón "Leer peso" cuando el producto esté colocado en la báscula.';

  return `
    <div class="modal" style="max-width:560px;width:min(92vw,560px)" onclick="event.stopPropagation()">
      <div class="modal-header">
        <h3>Venta por peso</h3>
        <button class="modal-close" type="button" onclick="closeSaleScaleDialog()">✕</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:1rem">
        <div style="padding:1rem;border-radius:18px;background:linear-gradient(135deg, rgba(14,116,144,.14), rgba(249,115,22,.12));border:1px solid rgba(148,163,184,.18)">
          <div style="display:flex;justify-content:space-between;gap:1rem;align-items:flex-start">
            <div>
              <div style="font-size:.78rem;color:var(--text3);text-transform:uppercase;letter-spacing:.08em">Producto</div>
              <div style="font-size:1.1rem;font-weight:800;color:var(--text1)">${escapeHtml(typeof getLocalizedProductName === 'function' ? getLocalizedProductName(product) : product.nombre)}</div>
              <div style="color:var(--text2);font-size:.9rem">${escapeHtml(typeLabel)} · Precio por ${escapeHtml(weightUnit)}</div>
            </div>
            <div style="padding:.45rem .7rem;border-radius:999px;background:rgba(15,23,42,.08);font-size:.78rem;color:var(--text2)">Coloque el producto en la báscula</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.8rem">
          <div style="padding:.9rem;border:1px solid rgba(148,163,184,.18);border-radius:16px;background:rgba(15,23,42,.02)">
            <div style="font-size:.76rem;color:var(--text3);margin-bottom:.35rem">Peso</div>
            <div id="sale-scale-live-weight" style="font-size:1.2rem;font-weight:800;color:var(--text1)">0.00 ${escapeHtml(weightUnit)}</div>
          </div>
          <div style="padding:.9rem;border:1px solid rgba(148,163,184,.18);border-radius:16px;background:rgba(15,23,42,.02)">
            <div style="font-size:.76rem;color:var(--text3);margin-bottom:.35rem">Precio por ${escapeHtml(weightUnit)}</div>
            <div id="sale-scale-live-price" style="font-size:1.05rem;font-weight:700;color:var(--text1)">${fmt(Number(product.precioVenta || 0))}</div>
          </div>
          <div style="padding:.9rem;border:1px solid rgba(148,163,184,.18);border-radius:16px;background:rgba(15,23,42,.02)">
            <div style="font-size:.76rem;color:var(--text3);margin-bottom:.35rem">Total</div>
            <div id="sale-scale-live-total" style="font-size:1.2rem;font-weight:800;color:var(--success)">${fmt(0)}</div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:.45rem;padding:.9rem;border-radius:16px;background:rgba(15,23,42,.025);border:1px dashed rgba(148,163,184,.22)">
          <div id="sale-scale-status" style="font-weight:700;color:var(--text2)">Coloque el producto en la báscula.</div>
          <small class="helper-text">${escapeHtml(autoReadLabel)}</small>
        </div>
        <div class="form-group" style="margin:0">
          <label>Lectura recibida</label>
          <div id="sale-scale-raw-reading" style="padding:.78rem .9rem;border:1px solid rgba(148,163,184,.18);border-radius:14px;background:var(--surface);font-family:var(--font-mono);color:var(--text2)">Esperando lectura...</div>
        </div>
        <input id="sale-scale-hid-input" type="text" autocomplete="off" spellcheck="false" style="position:absolute;left:-9999px;opacity:0;pointer-events:none" aria-hidden="true">
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" type="button" onclick="closeSaleScaleDialog()">Cancelar</button>
        <button class="btn-secondary" type="button" id="sale-scale-read-btn" onclick="requestSaleScaleWeightRead()">Leer peso</button>
        <button class="btn-primary" type="button" id="sale-scale-confirm-btn" onclick="confirmSaleScaleWeight()" disabled>Usar este peso</button>
      </div>
    </div>
  `;
}

function promptWeightForProduct(product) {
  const config = getSaleScaleConfig();
  if (config.type === 'none') {
    showToast('Este producto se vende por peso. Configura la báscula en Ajustes antes de venderlo.', 'warning');
    return Promise.resolve(null);
  }

  closeSaleScaleDialog();

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = SALE_SCALE_MODAL_ID;
    overlay.className = 'modal-overlay active';
    overlay.innerHTML = buildSaleScaleModalMarkup(product);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeSaleScaleDialog();
    });
    document.body.appendChild(overlay);

    saleScaleState = {
      resolver: resolve,
      overlay,
      product,
      config,
      reading: null,
      hidTimer: null,
      serialBusy: false
    };

    const hidInput = overlay.querySelector('#sale-scale-hid-input');
    hidInput?.addEventListener('input', scheduleSaleScaleHidParse);
    hidInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        consumeSaleScaleHidInput();
      }
    });

    updateSaleScaleSummary();
    setSaleScaleStatus('Coloque el producto en la báscula.', 'info');

    if (typeof translateDynamicUi === 'function') translateDynamicUi(overlay);

    if (config.type === 'usb') {
      armSaleScaleUsbCapture();
    }
    if (config.autoRead) {
      requestSaleScaleWeightRead();
    }
  });
}

async function reweighSaleItem(index) {
  const currentItem = normalizeSaleItem(DB.saleItems[index] || {});
  const product = findProductForSaleItem(currentItem);
  if (!currentItem || !product) {
    showToast('No pude encontrar el producto para volver a pesar.', 'error');
    return;
  }

  const result = await promptWeightForProduct(product);
  if (!result) return;

  const nextItem = normalizeSaleItem({
    ...currentItem,
    qty: result.qty,
    weightUnit: result.weightUnit,
    scaleWeight: result.scaleWeight,
    scaleMeasuredValue: result.scaleMeasuredValue,
    scaleMeasuredUnit: result.scaleMeasuredUnit,
    scaleSource: result.scaleSource,
    scaleRawReading: result.scaleRawReading
  });
  nextItem.total = calcItemTotal(nextItem);
  DB.saleItems[index] = nextItem;
  renderSaleTable();
  updateTotals();
  renderSalesCatalog();
}

function getSalesFlowConfig() {
  if (typeof window.getBusinessConfig === 'function') {
    return window.getBusinessConfig(DB.config?.tipoNegocio || 'pizzeria').salesFlow || {};
  }
  return {};
}

function getSalesDashboardConfig() {
  if (typeof window.getBusinessConfig === 'function') {
    return window.getBusinessConfig(DB.config?.tipoNegocio || 'pizzeria').dashboard || {};
  }
  return {};
}

function getSalesOrderTypeOptions() {
  const config = getSalesFlowConfig();
  const options = Array.isArray(config.orderTypes) && config.orderTypes.length
    ? config.orderTypes
    : Object.entries(SALE_ORDER_TYPES).map(([value, label]) => ({ value, label }));
  return options;
}

function getKitchenStatusOptions() {
  const config = getSalesFlowConfig();
  const options = Array.isArray(config.kitchenStatuses) && config.kitchenStatuses.length
    ? config.kitchenStatuses
    : [
        { value: 'pendiente', label: 'Pendiente' },
        { value: 'en preparacion', label: 'En preparación' },
        { value: 'lista', label: 'Lista' },
        { value: 'entregada', label: 'Entregada' }
      ];
  return options;
}

function getSaleOrderTypeLabel(value) {
  const customMap = {
    barra: 'Barra',
    terraza: 'Terraza'
  };
  const found = getSalesOrderTypeOptions().find((item) => item.value === value);
  return found?.label || customMap[value] || SALE_ORDER_TYPES[value] || value || 'Mostrador';
}

function getSaleKitchenStatusLabel(value) {
  const found = getKitchenStatusOptions().find((item) => item.value === value);
  return found?.label || value || 'Pendiente';
}

function buildOptionMarkup(options, selectedValue = '') {
  return options.map((item) => `
    <option value="${item.value}" ${String(selectedValue) === String(item.value) ? 'selected' : ''}>${item.label}</option>
  `).join('');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getSalesSearchInput() {
  return document.getElementById('product-search');
}

let salesPhysicalKeyboardUntil = 0;

function isTouchCapableSalesDevice() {
  return Number(navigator.maxTouchPoints || 0) > 0
    || window.matchMedia?.('(pointer: coarse)')?.matches === true;
}

// En un POS táctil nunca abrir el teclado de Windows por un focus()
// programático. Si el usuario toca directamente un input, el navegador lo
// enfoca normalmente. Un teclado físico o lector de código sigue funcionando.
document.addEventListener('keydown', () => {
  salesPhysicalKeyboardUntil = Date.now() + 1500;
}, true);

function isVentasModuleActive() {
  const module = document.getElementById('module-ventas');
  return Boolean(module && module.classList.contains('active') && !module.classList.contains('hidden'));
}

function isSalesOverlayOpen() {
  const modalOverlay = document.getElementById('modal-overlay');
  const receiptOverlay = document.getElementById('receipt-overlay');
  const scaleOverlay = document.getElementById(SALE_SCALE_MODAL_ID);
  return Boolean(
    (modalOverlay && !modalOverlay.classList.contains('hidden'))
    || (receiptOverlay && !receiptOverlay.classList.contains('hidden'))
    || scaleOverlay
  );
}

function isEditableSalesTarget(element) {
  if (!element) return false;
  const tag = String(element.tagName || '').toLowerCase();
  if (['textarea', 'select'].includes(tag)) return true;
  if (tag === 'input') {
    const type = String(element.type || '').toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file'].includes(type);
  }
  return Boolean(element.isContentEditable);
}

function canAutoFocusSalesSearch(options = {}) {
  const searchInput = getSalesSearchInput();
  if (!searchInput || !isVentasModuleActive() || isSalesOverlayOpen()) return false;
  if (searchInput.disabled || searchInput.readOnly) return false;
  if (
    isTouchCapableSalesDevice()
    && !options.allowTouch
    && Date.now() > salesPhysicalKeyboardUntil
  ) {
    return false;
  }
  if (options.force) return true;
  const activeElement = document.activeElement;
  if (activeElement && activeElement !== searchInput && isEditableSalesTarget(activeElement)) {
    return false;
  }
  return true;
}

function focusSalesSearchInput(options = {}) {
  const searchInput = getSalesSearchInput();
  if (!searchInput || !canAutoFocusSalesSearch(options)) return null;
  if (document.activeElement !== searchInput) {
    searchInput.focus({ preventScroll: true });
  }
  if (options.select) {
    searchInput.select();
  } else if (typeof searchInput.setSelectionRange === 'function') {
    const cursorPos = searchInput.value.length;
    searchInput.setSelectionRange(cursorPos, cursorPos);
  }
  return searchInput;
}

function cancelSalesSearchFocus() {
  clearTimeout(salesSearchFocusTimer);
  salesSearchFocusTimer = null;
}

function scheduleSalesSearchFocus(options = {}) {
  cancelSalesSearchFocus();
  salesSearchFocusTimer = setTimeout(() => {
    salesSearchFocusTimer = null;
    const activeElement = document.activeElement;
    const searchInput = getSalesSearchInput();
    if (activeElement && activeElement !== searchInput && isEditableSalesTarget(activeElement)) {
      return;
    }
    focusSalesSearchInput(options);
  }, Number(options.delay ?? 0));
}

function shouldRestoreSalesSearchAfterClick(target) {
  if (!target || !target.closest || !isVentasModuleActive() || isSalesOverlayOpen()) return false;
  if (!target.closest('#module-ventas')) return false;
  if (target.closest('.search-wrap') || target.closest('#search-dropdown')) return false;
  if (isEditableSalesTarget(target)) return false;
  return true;
}

function shouldRouteKeyToSalesSearch(event) {
  if (event.defaultPrevented || event.isComposing) return false;
  if (!isVentasModuleActive() || isSalesOverlayOpen()) return false;
  const searchInput = getSalesSearchInput();
  if (!searchInput || document.activeElement === searchInput) return false;
  if (document.activeElement && document.activeElement !== searchInput && isEditableSalesTarget(document.activeElement)) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (isEditableSalesTarget(event.target)) return false;
  const targetInVentas = event.target?.closest?.('#module-ventas');
  const plainDocumentTarget = event.target === document.body || event.target === document.documentElement;
  if (!targetInVentas && !plainDocumentTarget) return false;
  if (event.key === 'Backspace' || event.key === 'Delete') return true;
  if (event.key.length !== 1) return false;
  if (event.key === ' ' && event.target?.closest?.('button, a, [role="button"]')) return false;
  return true;
}

function routeKeyToSalesSearch(event) {
  const searchInput = focusSalesSearchInput({ force: true, allowTouch: true });
  if (!searchInput) return;
  event.preventDefault();
  const rawStart = typeof searchInput.selectionStart === 'number' ? searchInput.selectionStart : searchInput.value.length;
  const rawEnd = typeof searchInput.selectionEnd === 'number' ? searchInput.selectionEnd : searchInput.value.length;
  let nextValue = searchInput.value;
  let nextCursor = rawStart;

  if (event.key === 'Backspace') {
    if (rawStart !== rawEnd) {
      nextValue = `${searchInput.value.slice(0, rawStart)}${searchInput.value.slice(rawEnd)}`;
      nextCursor = rawStart;
    } else if (rawStart > 0) {
      nextValue = `${searchInput.value.slice(0, rawStart - 1)}${searchInput.value.slice(rawEnd)}`;
      nextCursor = rawStart - 1;
    }
  } else if (event.key === 'Delete') {
    if (rawStart !== rawEnd) {
      nextValue = `${searchInput.value.slice(0, rawStart)}${searchInput.value.slice(rawEnd)}`;
      nextCursor = rawStart;
    } else {
      nextValue = `${searchInput.value.slice(0, rawStart)}${searchInput.value.slice(rawStart + 1)}`;
      nextCursor = rawStart;
    }
  } else {
    nextValue = `${searchInput.value.slice(0, rawStart)}${event.key}${searchInput.value.slice(rawEnd)}`;
    nextCursor = rawStart + event.key.length;
  }

  searchInput.value = nextValue;
  if (typeof searchInput.setSelectionRange === 'function') {
    searchInput.setSelectionRange(nextCursor, nextCursor);
  }
  searchProduct(searchInput.value);
}

document.addEventListener('click', (event) => {
  if (!shouldRestoreSalesSearchAfterClick(event.target)) return;
  scheduleSalesSearchFocus();
});

document.addEventListener('focusin', (event) => {
  const searchInput = getSalesSearchInput();
  if (event.target && event.target !== searchInput && isEditableSalesTarget(event.target)) {
    cancelSalesSearchFocus();
  }
}, true);

document.addEventListener('keydown', (event) => {
  if (!shouldRouteKeyToSalesSearch(event)) return;
  routeKeyToSalesSearch(event);
}, true);

window.focusSalesSearchInput = focusSalesSearchInput;
window.scheduleSalesSearchFocus = scheduleSalesSearchFocus;
window.cancelSalesSearchFocus = cancelSalesSearchFocus;

function cloneSaleData(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value ?? fallback));
  } catch (_error) {
    return fallback;
  }
}

function buildSuspendedSaleId() {
  return `PEND-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function buildQuotationId() {
  return `COT-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function roundSaleMoney(value) {
  return Number((Number(value || 0)).toFixed(2));
}

// Redondeo configurable del total final — siempre hacia arriba al múltiplo
// configurado (ej. RD$1000.20 con modo '5' -> RD$1005.00). Nunca reduce el total.
function applyRoundingUp(total, mode) {
  const increment = Number(mode);
  if (!Number.isFinite(increment) || increment <= 0) return roundSaleMoney(total);
  return roundSaleMoney(Math.ceil(roundSaleMoney(total) / increment) * increment);
}

function getSaleTaxConfig(config = DB.config || {}) {
  const rate = Number(config?.itbis ?? 18);
  const taxRate = Number.isFinite(rate) ? Math.max(0, rate) : 18;
  const calculateAtEnd = config?.taxCalculateAtInvoiceEnd !== false;
  const includeInProductPrice = config?.taxIncludeInProductPrice === true && !calculateAtEnd;
  return {
    taxRate,
    calculateAtEnd,
    includeInProductPrice,
    showBreakdownOnReceipts: config?.taxShowBreakdownOnReceipts !== false,
    separateTaxableAndExempt: config?.taxSeparateTaxableAndExempt !== false
  };
}

function calculateSaleItemBase(item = {}) {
  return roundSaleMoney(Number(item?.precio || 0) * Number(item?.qty || 0));
}

function calculateSaleItemDiscount(item = {}) {
  const base = calculateSaleItemBase(item);
  const rate = Math.max(0, Number(item?.descuento || 0));
  return roundSaleMoney(base * (rate / 100));
}

function calculateSaleItemNet(item = {}) {
  return roundSaleMoney(calculateSaleItemBase(item) - calculateSaleItemDiscount(item));
}

function calculateSaleItemTax(item = {}, options = {}) {
  const net = calculateSaleItemNet(item);
  if (!(net > 0)) return 0;
  const discountRate = Math.max(0, Number(options.generalDiscountRate ?? 0));
  if (String(item?.itbisModo || 'porcentaje') === 'monto') {
    // ITBIS de monto fijo por unidad — no se prorratea contra ninguna tasa,
    // se multiplica directo por la cantidad de la línea (y se reduce por el
    // descuento general de la venta, igual que el modo %, para que ambos
    // modos se comporten consistentemente).
    const montoUnit = Math.max(0, Number(item?.itbisMontoUnit || 0));
    return roundSaleMoney(montoUnit * Number(item?.qty || 0) * (1 - discountRate / 100));
  }
  const behavior = getSaleTaxConfig(options.config);
  const itemRate = Number(item?.itbis || 0);
  const taxRate = Number.isFinite(itemRate) ? Math.max(0, itemRate) : behavior.taxRate;
  if (!(taxRate > 0)) return 0;
  const taxableBase = roundSaleMoney(net - (net * (discountRate / 100)));
  return roundSaleMoney(taxableBase * (taxRate / 100));
}

function isSaleItemTaxable(item = {}) {
  return String(item?.itbisModo || 'porcentaje') === 'monto'
    ? Number(item?.itbisMontoUnit || 0) > 0
    : Number(item?.itbis || 0) > 0;
}

function calcularTotales(items = [], options = {}) {
  const behavior = getSaleTaxConfig(options.config);
  const generalDiscountRate = Math.max(0, Number(options.generalDiscountRate ?? 0));
  let subtotalGravado = 0;
  let subtotalExento = 0;
  let subtotalGravadoFinal = 0;
  let subtotalExentoFinal = 0;
  let itbis = 0;
  let discount = 0;
  let itemCount = 0;

  (Array.isArray(items) ? items : []).forEach((rawItem) => {
    const item = normalizeSaleItem(rawItem);
    const qty = Number(item.qty || 0);
    const net = calculateSaleItemNet(item);
    const generalDiscountAmount = roundSaleMoney(net * (generalDiscountRate / 100));
    const lineNetAfterGeneralDiscount = roundSaleMoney(net - generalDiscountAmount);
    const itemTax = calculateSaleItemTax(item, { config: options.config, generalDiscountRate });

    if (isSaleItemTaxable(item)) {
      subtotalGravado += net;
      subtotalGravadoFinal += lineNetAfterGeneralDiscount;
      itbis += itemTax;
    } else {
      subtotalExento += net;
      subtotalExentoFinal += lineNetAfterGeneralDiscount;
    }

    discount += generalDiscountAmount;
    itemCount += qty;
  });

  subtotalGravado = roundSaleMoney(subtotalGravado);
  subtotalExento = roundSaleMoney(subtotalExento);
  subtotalGravadoFinal = roundSaleMoney(subtotalGravadoFinal);
  subtotalExentoFinal = roundSaleMoney(subtotalExentoFinal);
  discount = roundSaleMoney(discount);
  itbis = roundSaleMoney(itbis);

  const subtotal = roundSaleMoney(subtotalGravado + subtotalExento);
  const subtotalFinal = roundSaleMoney(subtotalGravadoFinal + subtotalExentoFinal);

  const totalBeforeRounding = roundSaleMoney(subtotalFinal + (behavior.calculateAtEnd ? itbis : itbis));
  const roundingMode = String(options.config?.roundingMode || 'none');
  const total = applyRoundingUp(totalBeforeRounding, roundingMode);
  const roundingAdjustment = roundSaleMoney(total - totalBeforeRounding);

  return {
    subtotal,
    subtotalGravado,
    subtotalExento,
    subtotalFinal,
    subtotalGravadoFinal,
    subtotalExentoFinal,
    itbis,
    discount,
    totalBeforeRounding,
    roundingAdjustment,
    total,
    itemCount
  };
}

function calculateCurrentSaleTotals() {
  normalizeCartSaleItems();
  return calcularTotales(DB.saleItems, {
    generalDiscountRate: parseFloat(DB.saleGeneralDiscount || 0) || 0,
    config: DB.config
  });
}

function formatSuspendedSaleDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('es-DO', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function buildSuggestedSuspendedSaleName() {
  const client = getSelectedSaleClient();
  const parts = [];
  if (DB.saleTableLabel) {
    parts.push(DB.saleTableLabel);
  } else if ((DB.saleOrderType || 'mostrador') === 'delivery') {
    parts.push('Delivery');
  } else if (client?.nombre) {
    parts.push(client.nombre);
  } else {
    parts.push('Factura en pausa');
  }
  parts.push(new Date().toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' }));
  return parts.join(' · ');
}

function ensureUniqueSuspendedSaleName(value) {
  const baseName = String(value || '').trim() || buildSuggestedSuspendedSaleName();
  let candidate = baseName;
  let index = 2;
  const existingNames = new Set(DB.ventasPendientes.map((item) => String(item?.nombre || '').trim().toLowerCase()).filter(Boolean));
  while (existingNames.has(candidate.toLowerCase())) {
    candidate = `${baseName} (${index})`;
    index += 1;
  }
  return candidate;
}

function buildSuggestedQuotationName(clientName = '') {
  const cleanClientName = String(clientName || '').trim();
  const baseName = cleanClientName || getSelectedSaleClient()?.nombre || 'Cotización';
  const timestamp = new Date().toLocaleDateString('es-DO');
  return `${baseName} · ${timestamp}`;
}

function ensureUniqueQuotationName(value) {
  const baseName = String(value || '').trim() || buildSuggestedQuotationName();
  let candidate = baseName;
  let index = 2;
  const existingNames = new Set((DB.cotizaciones || []).map((item) => String(item?.nombre || '').trim().toLowerCase()).filter(Boolean));
  while (existingNames.has(candidate.toLowerCase())) {
    candidate = `${baseName} (${index})`;
    index += 1;
  }
  return candidate;
}

function findClientIdByName(name) {
  const cleanName = String(name || '').trim().toLowerCase();
  if (!cleanName) return null;
  const match = (DB.clientes || []).find((client) => String(client?.nombre || '').trim().toLowerCase() === cleanName);
  return match?.id || null;
}

function setSaleTableLabel(value) {
  DB.saleTableLabel = String(value || '');
  syncBillingConfirmSummary();
}

function setSaleDeliveryPhone(value) {
  DB.saleDeliveryPhone = String(value || '');
  syncBillingModalFooter();
  syncBillingConfirmSummary();
}

function setSaleDeliveryAddress(value) {
  DB.saleDeliveryAddress = String(value || '');
  syncBillingModalFooter();
  syncBillingConfirmSummary();
}

function setSaleDeliveryReference(value) {
  DB.saleDeliveryReference = String(value || '');
  syncBillingConfirmSummary();
}

function setSaleDeliveryLink(value) {
  DB.saleDeliveryLink = String(value || '');
  syncBillingConfirmSummary();
}

function setSaleDeliveryPayAmount(value) {
  DB.saleDeliveryPayAmount = parseFloat(value) || 0;
  calcCambioContraEntrega();
  syncBillingConfirmSummary();
}

function setSaleOrderNotes(value) {
  DB.saleOrderNotes = String(value || '');
  syncBillingConfirmSummary();
}

function buildSuspendedSaleDraft(name) {
  const client = getSelectedSaleClient();
  const totals = calculateCurrentSaleTotals();
  return {
    id: buildSuspendedSaleId(),
    nombre: ensureUniqueSuspendedSaleName(name),
    clientId: DB.saleClientId || null,
    clientName: client?.nombre || 'Consumidor Final',
    documentType: DB.saleDocumentType || 'ticket',
    payMethod: DB.payMethod || 'efectivo',
    deliveryUserId: DB.saleDeliveryUserId || null,
    orderType: DB.saleOrderType || 'mostrador',
    kitchenStatus: DB.saleKitchenStatus || 'pendiente',
    generalDiscount: parseFloat(DB.saleGeneralDiscount || 0) || 0,
    tableLabel: String(DB.saleTableLabel || '').trim(),
    deliveryPhone: String(DB.saleDeliveryPhone || '').trim(),
    deliveryAddress: String(DB.saleDeliveryAddress || '').trim(),
    deliveryReference: String(DB.saleDeliveryReference || '').trim(),
    deliveryLink: String(DB.saleDeliveryLink || '').trim(),
    deliveryPayAmount: Number(DB.saleDeliveryPayAmount || 0) || 0,
    orderNotes: String(DB.saleOrderNotes || '').trim(),
    total: totals.total,
    itemCount: totals.itemCount,
    items: cloneSaleData(DB.saleItems, [])
  };
}

function buildQuotationDraft({ name = '', clientName = '' } = {}) {
  const selectedClient = getSelectedSaleClient();
  const typedClientName = String(clientName || '').trim();
  const resolvedClientName = typedClientName || selectedClient?.nombre || 'Consumidor Final';
  const selectedClientMatchesTyped = selectedClient
    ? !typedClientName || String(selectedClient.nombre || '').trim().toLowerCase() === typedClientName.toLowerCase()
    : false;
  const matchedClientId = selectedClientMatchesTyped
    ? selectedClient.id
    : findClientIdByName(resolvedClientName);
  const totals = calculateCurrentSaleTotals();

  return {
    id: buildQuotationId(),
    nombre: ensureUniqueQuotationName(name || buildSuggestedQuotationName(resolvedClientName)),
    clientId: matchedClientId || null,
    clientName: resolvedClientName,
    documentType: DB.saleDocumentType || 'ticket',
    payMethod: DB.payMethod || 'efectivo',
    deliveryUserId: DB.saleDeliveryUserId || null,
    orderType: DB.saleOrderType || 'mostrador',
    kitchenStatus: DB.saleKitchenStatus || 'pendiente',
    generalDiscount: parseFloat(DB.saleGeneralDiscount || 0) || 0,
    tableLabel: String(DB.saleTableLabel || '').trim(),
    deliveryPhone: String(DB.saleDeliveryPhone || '').trim(),
    deliveryAddress: String(DB.saleDeliveryAddress || '').trim(),
    deliveryReference: String(DB.saleDeliveryReference || '').trim(),
    deliveryLink: String(DB.saleDeliveryLink || '').trim(),
    deliveryPayAmount: Number(DB.saleDeliveryPayAmount || 0) || 0,
    orderNotes: String(DB.saleOrderNotes || '').trim(),
    total: totals.total,
    itemCount: totals.itemCount,
    items: cloneSaleData(DB.saleItems, [])
  };
}

function clearRecoveredQuotationTracking() {
  activeRecoveredQuotationId = null;
  activeRecoveredQuotationName = '';
}

function applyRecoveredSuspendedSale(pending) {
  DB.saleItems = (cloneSaleData(pending.items, []) || []).map((item) => normalizeSaleItem(item));
  DB.saleClientId = pending.clientId || null;
  DB.saleDocumentType = pending.documentType || 'ticket';
  DB.payMethod = pending.payMethod || 'efectivo';
  DB.saleDeliveryUserId = pending.deliveryUserId || null;
  DB.saleOrderType = pending.orderType || 'mostrador';
  DB.saleKitchenStatus = pending.kitchenStatus || 'pendiente';
  DB.saleGeneralDiscount = Number(pending.generalDiscount || 0) || 0;
  DB.saleTableLabel = pending.tableLabel || '';
  DB.saleDeliveryPhone = pending.deliveryPhone || '';
  DB.saleDeliveryAddress = pending.deliveryAddress || '';
  DB.saleDeliveryReference = pending.deliveryReference || '';
  DB.saleDeliveryLink = pending.deliveryLink || '';
  DB.saleDeliveryPayAmount = Number(pending.deliveryPayAmount || 0) || 0;
  DB.saleOrderNotes = pending.orderNotes || '';

  renderSaleTable();
  updateTotals();
  renderSalesCatalog();
  syncSaleFiscalControls();
  updateNotifications();
  focusSalesSearchInput({ force: true });
}

function buildSuspendedSalesListMarkup() {
  if (!DB.ventasPendientes.length) {
    return `
      <div class="pending-sales-empty">
        <strong>No hay facturas en pausa</strong>
        <span>Suspende una venta con nombre para recuperarla luego desde aquí.</span>
      </div>
    `;
  }

  return `
    <div class="pending-sales-list">
      ${DB.ventasPendientes.map((pending) => `
        <div class="pending-sale-card">
          <div class="pending-sale-card-head">
            <div>
              <strong class="pending-sale-name">${escapeHtml(pending.nombre || 'Venta suspendida')}</strong>
              <div class="pending-sale-meta">${escapeHtml(formatSuspendedSaleDate(pending.updatedAt || pending.hora))}</div>
            </div>
            <div class="pending-sale-total">${fmt(pending.total || 0)}</div>
          </div>
          <div class="pending-sale-tags">
            <span class="pending-sale-tag">${getSaleLineCountLabel(pending.items, pending.itemCount)}</span>
            <span class="pending-sale-tag">${escapeHtml(pending.clientName || 'Consumidor Final')}</span>
            <span class="pending-sale-tag">${escapeHtml(getSaleOrderTypeLabel(pending.orderType))}</span>
          </div>
          <div class="pending-sale-card-actions">
            <button class="btn-primary" type="button" onclick="recoverSuspendedSaleById('${escapeHtml(pending.id)}')">Recuperar esta factura</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function buildQuotationsListMarkup() {
  if (!DB.cotizaciones?.length) {
    return `
      <div class="pending-sales-empty">
        <strong>No hay cotizaciones guardadas</strong>
        <span>Usa el botón Cotizar para guardar una propuesta por nombre del cliente.</span>
      </div>
    `;
  }

  return `
    <div class="pending-sales-list">
      ${DB.cotizaciones.map((quotation) => `
        <div class="pending-sale-card is-quotation">
          <div class="pending-sale-card-head">
            <div>
              <strong class="pending-sale-name">${escapeHtml(quotation.nombre || 'Cotización')}</strong>
              <div class="pending-sale-meta">${escapeHtml(formatSuspendedSaleDate(quotation.updatedAt || quotation.hora))}</div>
            </div>
            <div class="pending-sale-total">${fmt(quotation.total || 0)}</div>
          </div>
          <div class="pending-sale-tags">
            <span class="pending-sale-tag is-quotation">Cotización</span>
            <span class="pending-sale-tag">${getSaleLineCountLabel(quotation.items, quotation.itemCount)}</span>
            <span class="pending-sale-tag">${escapeHtml(quotation.clientName || 'Cliente no definido')}</span>
          </div>
          <div class="pending-sale-card-actions">
            <button class="btn-primary" type="button" onclick="recoverQuotationById('${escapeHtml(quotation.id)}')">Cargar esta cotización</button>
            <button class="btn-danger pending-sale-delete" type="button" onclick="deleteQuotationById('${escapeHtml(quotation.id)}')">Eliminar</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function buildRecoverSalesModalMarkup() {
  const suspendedCount = Number(DB.ventasPendientes?.length || 0);
  const quotationCount = Number(DB.cotizaciones?.length || 0);

  if (!suspendedCount && !quotationCount) {
    return `
      <div class="pending-sales-empty">
        <strong>No hay ventas ni cotizaciones guardadas</strong>
        <span>Suspende una venta o guarda una cotización para recuperarla luego desde aquí.</span>
      </div>
    `;
  }

  return `
    <div class="recover-sales-panels">
      <section class="recover-sales-panel">
        <div class="recover-sales-panel-head">
          <div class="pending-sales-section-title">Facturas suspendidas</div>
          <span class="recover-sales-count">${suspendedCount}</span>
        </div>
        ${buildSuspendedSalesListMarkup()}
      </section>
      <section class="recover-sales-panel is-quotation-panel">
        <div class="recover-sales-panel-head">
          <div class="pending-sales-section-title">Cotizaciones</div>
          <span class="recover-sales-count is-quotation">${quotationCount}</span>
        </div>
        ${buildQuotationsListMarkup()}
      </section>
    </div>
  `;
}

function renderRecoverSalesModalContent() {
  document.getElementById('modal-title').textContent = 'Recuperar venta o cotización';
  document.getElementById('modal-body').innerHTML = buildRecoverSalesModalMarkup();
  document.getElementById('modal-footer').innerHTML = `
    <button class="btn-secondary" onclick="closeAllModals()">Cerrar</button>
  `;
  document.getElementById('modal-box').classList.remove('billing-modal');
  document.getElementById('modal-box').classList.add('recover-sales-modal');
  document.getElementById('modal-overlay').classList.remove('hidden');
  if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('modal-overlay'));
}

function refreshRecoverSalesModalIfOpen() {
  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  if (overlay?.classList.contains('hidden')) return;
  if (String(title?.textContent || '').trim() !== 'Recuperar venta o cotización') return;
  renderRecoverSalesModalContent();
}

function isSalesSplitViewEnabled(forceValue = null) {
  if (typeof forceValue === 'boolean') return forceValue;
  return Boolean(DB.config?.salesSplitViewEnabled);
}

function syncSalesSplitViewLayout(forceValue = null) {
  const enabled = isSalesSplitViewEnabled(forceValue);
  const workspace = document.querySelector('#module-ventas .ventas-workspace');
  const catalogPanel = document.getElementById('sales-catalog-panel');

  if (workspace) {
    workspace.classList.toggle('ventas-workspace--split', enabled);
  }
  if (catalogPanel) {
    catalogPanel.classList.toggle('hidden', !enabled);
    catalogPanel.setAttribute('aria-hidden', enabled ? 'false' : 'true');
  }

  return enabled;
}

function getSalesUiPreferences() {
  try {
    return JSON.parse(localStorage.getItem(SALES_UI_PREFS_KEY) || '{}');
  } catch (_error) {
    return {};
  }
}

function saveSalesUiPreference(key, value) {
  try {
    const prefs = getSalesUiPreferences();
    prefs[key] = value;
    localStorage.setItem(SALES_UI_PREFS_KEY, JSON.stringify(prefs));
  } catch (_error) {
    // Keep the catalog usable even if localStorage is unavailable.
  }
}

function applySalesQuickMenuState() {
  const panel = document.getElementById('sales-quick-menu-panel');
  if (!panel) return;
  const collapsed = Boolean(getSalesUiPreferences().salesQuickMenuCollapsed);
  panel.classList.toggle('collapsed', collapsed);
  const toggle = panel.querySelector('.sales-pizza-mini-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', String(!collapsed));
}

function toggleSalesQuickMenu() {
  const panel = document.getElementById('sales-quick-menu-panel');
  if (!panel) return;
  const collapsed = !panel.classList.contains('collapsed');
  panel.classList.toggle('collapsed', collapsed);
  const toggle = panel.querySelector('.sales-pizza-mini-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', String(!collapsed));
  saveSalesUiPreference('salesQuickMenuCollapsed', collapsed);
}

function getSalesCatalogProducts() {
  const query = String(document.getElementById('product-search')?.value || '').toLowerCase().trim();
  const category = String(document.getElementById('sales-category-filter')?.value || '');
  const stockFilter = String(document.getElementById('sales-stock-filter')?.value || 'todos');

  return DB.productos.filter((product) => {
    // Usar la misma función que el buscador → catálogo y búsqueda son coherentes.
    if (!isProductSellable(product)) return false;

    const localizedName = typeof getLocalizedProductName === 'function' ? getLocalizedProductName(product) : product.nombre;
    const localizedCategory = typeof getLocalizedCategoryName === 'function' ? getLocalizedCategoryName(product.categoria) : product.categoria;

    const matchesQuery = !query || [
      product.nombre,
      localizedName,
      product.codigo,
      product.categoria,
      localizedCategory,
      product.marca || ''
    ].some((value) => String(value).toLowerCase().includes(query));
    const matchesCategory = !category || product.categoria === category;
    const matchesStock = stockFilter === 'agotados'
      ? product.tracksStock !== false && Number(product.stock || 0) === 0
      : stockFilter === 'disponibles'
        ? product.tracksStock === false || Number(product.stock || 0) > 0
        : true;

    return matchesQuery && matchesCategory && matchesStock;
  });
}

function refreshSalesCategoryFilter() {
  const select = document.getElementById('sales-category-filter');
  if (!select) return;
  const currentValue = select.value;
  const categories = [...new Set(DB.productos.map((item) => item.categoria).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  select.innerHTML = '<option value="">Todas las categorías</option>' + categories.map((category) => {
    const label = typeof getLocalizedCategoryName === 'function' ? getLocalizedCategoryName(category) : category;
    return `<option value="${category}">${label}</option>`;
  }).join('');
  select.value = currentValue;
}

function renderSalesCatalog(forceSplitViewEnabled = null) {
  const grid = document.getElementById('sales-catalog-grid');
  const summary = document.getElementById('sales-catalog-summary');
  syncSalesSplitViewLayout(forceSplitViewEnabled);
  if (!grid) return;

  applySalesQuickMenuState();
  refreshSalesCategoryFilter();
  const products = getSalesCatalogProducts();
  const totalEnDB = Array.isArray(DB.productos) ? DB.productos.length : 0;
  if (summary) {
    summary.textContent = totalEnDB > 0 && products.length === 0
      ? `0 visibles (${totalEnDB} en catálogo)`
      : `${products.length} producto${products.length === 1 ? '' : 's'} visible${products.length === 1 ? '' : 's'}`;
  }
  if (!products.length) {
    const emptyMsg = totalEnDB === 0
      ? 'No se cargaron productos del servidor. Revisa la conexión o reinicia la app.'
      : `No hay productos con esos filtros. <br><small style="opacity:.7">${totalEnDB} producto${totalEnDB === 1 ? '' : 's'} en tu catálogo.</small>`;
    grid.innerHTML = `<div class="sales-catalog-empty">${emptyMsg}</div>`;
    return;
  }

  grid.innerHTML = products.map((product) => {
    const nombre = typeof getLocalizedProductName === 'function' ? getLocalizedProductName(product) : product.nombre;
    const stock = Number(product.stock || 0);
    const stockMin = Number(product.stockMin || 0);
    const tracksStock = product.tracksStock !== false;
    // El stock mostrado descuenta lo que ya está en el carrito (aún no vendido)
    // para que baje en vivo al agregar y vuelva a la normalidad si se quita.
    const cartQty = tracksStock ? getCartQtyForProduct(product.id) : 0;
    const availableStock = tracksStock ? Math.max(0, stock - cartQty) : stock;
    const stockClass = tracksStock && availableStock === 0 ? 'is-out' : tracksStock && availableStock <= stockMin ? 'is-low' : '';
    const stockLabel = !tracksStock ? '' : availableStock === 0 ? 'Agotado' : `Disp: ${availableStock}`;
    return `
    <article class="sales-product-card ${stockClass}" onclick="addProductById(${product.id})" title="${nombre}">
      <div class="sales-product-media">
        <img class="sales-product-image" src="${getSalesProductImage(product)}" alt="${nombre}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${PRODUCT_IMAGE_PLACEHOLDER}'">
      </div>
      <div class="sales-product-body">
        <div class="sales-product-name">${nombre}</div>
        <div class="sales-product-price">${fmt(getProductFinalPriceWithItbis(product))}</div>
        ${stockLabel ? `<div class="sales-product-stock ${stockClass}">${stockLabel}</div>` : ''}
      </div>
    </article>`;
  }).join('');
}

function getSalesProductImage(product) {
  return product.imagenLocal || product.imagenUrl || product.imagen || PRODUCT_IMAGE_PLACEHOLDER;
}

function getSelectedSaleClient() {
  const clientId = Number(DB.saleClientId || 0);
  return clientId ? DB.clientes.find((client) => client.id === clientId) || null : null;
}

function buildSelectedClientSnapshotMarkup() {
  const client = getSelectedSaleClient();
  const orderType = DB.saleOrderType || 'mostrador';
  const emptyText = orderType === 'delivery'
    ? 'Selecciona un cliente para usar automáticamente su teléfono, dirección y referencia guardados.'
    : 'Si eliges un cliente, sus datos quedarán vinculados automáticamente a la factura.';

  if (!client) {
    return `
      <div class="billing-client-card is-empty">
        <div class="billing-client-card-head">
          <div>
            <strong>Datos del cliente</strong>
            <span>Se cargarán automáticamente al seleccionar un cliente.</span>
          </div>
        </div>
        <div class="billing-client-empty">${emptyText}</div>
      </div>
    `;
  }

  const rows = [
    { label: 'Cliente', value: client.nombre || 'Sin nombre' },
    { label: 'Teléfono', value: client.telefono || 'No registrado' },
    { label: 'Dirección', value: client.direccion || 'No registrada' },
    { label: 'Referencia', value: client.referencia || 'Sin referencia' },
    { label: 'Ubicación', value: client.linkUbicacion || 'No registrada' }
  ];

  return `
    <div class="billing-client-card">
      <div class="billing-client-card-head">
        <div>
          <strong>${escapeHtml(client.nombre || 'Cliente seleccionado')}</strong>
          <span>Datos cargados desde la ficha del cliente</span>
        </div>
        <span class="billing-client-badge">${escapeHtml(getSaleOrderTypeLabel(orderType))}</span>
      </div>
      <div class="billing-client-grid">
        ${rows.map((row) => `
          <div class="billing-client-item">
            <span>${escapeHtml(row.label)}</span>
            <strong>${escapeHtml(row.value)}</strong>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function syncBillingClientSnapshot() {
  const container = document.getElementById('billing-client-snapshot');
  if (container) container.innerHTML = buildSelectedClientSnapshotMarkup();
  // V3: también sincroniza los chips del cliente en el subheader
  _syncBillingV3ClientExpand();
}

function getDocumentSequencePreview(type) {
  // Si hay un NCF fiscal elegido (B01/B02/B03/B04/B14/B15), ESE es el
  // documento que se va a emitir — nunca el contador interno FAC-/ECF-
  // (ese es solo para Ticket/e-CF sin NCF tradicional). El número exacto lo
  // asigna el servidor al cobrar (evita colisiones entre cajas/terminales
  // vendiendo al mismo tiempo), así que aquí solo se previsualiza el tipo
  // con el formato real de DGII (sin guion) y el número final pendiente.
  const ncfType = DB.saleNcfType || '';
  if (ncfType) {
    const knownNext = _availableNcfNextNumbers?.get(ncfType.toUpperCase());
    if (Number.isFinite(knownNext)) {
      return `${ncfType}${String(knownNext).padStart(8, '0')}`;
    }
    return `${ncfType}········`;
  }
  if (type === 'factura-electronica') {
    return `${DB.config.eInvoicePrefix || 'ECF-'}${String(DB.config.eInvoiceNextNumber || 1).padStart(8, '0')}`;
  }
  return `${DB.config.prefix || 'FAC-'}${String(DB.config.nextInvoice || 1).padStart(8, '0')}`;
}

function getBillingRememberLastClientEnabled() {
  try {
    return localStorage.getItem(BILLING_KEEP_LAST_CLIENT_KEY) === '1';
  } catch (_error) {
    return false;
  }
}

function setBillingRememberLastClientEnabled(enabled) {
  try {
    localStorage.setItem(BILLING_KEEP_LAST_CLIENT_KEY, enabled ? '1' : '0');
    if (!enabled) localStorage.removeItem(BILLING_LAST_CLIENT_KEY);
  } catch (_error) {
    // Ignore storage failures to keep checkout usable.
  }
}

function getRememberedBillingClientId() {
  if (!getBillingRememberLastClientEnabled()) return null;
  try {
    const value = Number(localStorage.getItem(BILLING_LAST_CLIENT_KEY) || 0);
    return value > 0 ? value : null;
  } catch (_error) {
    return null;
  }
}

function storeRememberedBillingClientId(clientId) {
  try {
    if (!getBillingRememberLastClientEnabled()) {
      localStorage.removeItem(BILLING_LAST_CLIENT_KEY);
      return;
    }
    if (clientId) localStorage.setItem(BILLING_LAST_CLIENT_KEY, String(clientId));
    else localStorage.removeItem(BILLING_LAST_CLIENT_KEY);
  } catch (_error) {
    // Ignore storage failures to keep checkout usable.
  }
}

function getBillingClientOptionLabel() {
  return 'Consumidor Final / Sin seleccionar';
}

function resetBillingModalState() {
  billingModalState = createDefaultBillingModalState();
  billingActiveStep = 'order';
  _billingSubmitting = false;
}

// Tipo de comprobante con el que arranca cada venta nueva — Configuración →
// Facturación → "Tipo de comprobante preferido para vender" (preferredBillingDocType).
// El cajero puede seguir cambiándolo a mano para un cliente en particular; esto
// solo define cuál llega ya seleccionado.
function applyPreferredBillingDocumentType() {
  const preferred = String(DB.config?.preferredBillingDocType || 'ticket').trim();
  if (preferred === 'factura-electronica') {
    DB.saleDocumentType = 'factura-electronica';
    DB.saleNcfType = '';
  } else if (!preferred || preferred === 'ticket') {
    DB.saleDocumentType = 'ticket';
    DB.saleNcfType = '';
  } else {
    DB.saleDocumentType = 'ticket';
    DB.saleNcfType = preferred.toUpperCase();
  }
}

function resetBillingCheckoutDraft({ preserveRememberedClient = false } = {}) {
  resetBillingModalState();
  applyPreferredBillingDocumentType();
  DB.saleOrderType = 'mostrador';
  DB.saleKitchenStatus = 'pendiente';
  DB.saleGeneralDiscount = 0;
  DB.saleRncCliente = '';
  DB.saleRazonSocial = '';
  DB.saleNcfReferencia = '';
  DB.saleNcfReferenciaId = null;
  DB.saleTableLabel = '';
  DB.saleDeliveryPhone = '';
  DB.saleDeliveryAddress = '';
  DB.saleDeliveryReference = '';
  DB.saleDeliveryLink = '';
  DB.saleDeliveryPayAmount = 0;
  DB.saleOrderNotes = '';
  DB.payMethod = 'efectivo';
  DB.saleDeliveryUserId = null;
  DB.saleClientId = preserveRememberedClient ? getRememberedBillingClientId() : null;
}

function getBillingStepIndex(step = billingActiveStep) {
  return Math.max(0, BILLING_STEP_FLOW.indexOf(step));
}

function getBillingOrderTypeCards() {
  return [
    { key: 'mostrador', label: 'Mostrador', icon: '🏪', hint: 'Cobro en caja' },
    { key: 'delivery', label: 'Envío', icon: '🛵', hint: 'Pedido a domicilio' },
    { key: 'recoger', label: 'Para llevar', icon: '🥡', hint: 'Retiro rápido' },
    { key: 'mesa', label: 'Mesa', icon: '🍽️', hint: 'Consumo en local' },
    { key: 'barra', label: 'Barra', icon: '🥤', hint: 'Atención rápida' },
    { key: 'terraza', label: 'Terraza', icon: '🌿', hint: 'Área exterior' }
  ];
}

function normalizeBillingOrderType(rawType) {
  const value = String(rawType || 'mostrador').trim().toLowerCase();
  if (value === 'envio') return 'delivery';
  if (value === 'para llevar') return 'recoger';
  return value;
}

function getSelectedBillingResponsible() {
  return BILLING_RESPONSIBLE_TYPES.find((item) => item.key === billingModalState.responsibleType) || BILLING_RESPONSIBLE_TYPES[0];
}

function getBillingPrimaryActionLabel() {
  const totalText = document.getElementById('billing-total')?.textContent || fmt(0);
  const paymentMethod = DB.payMethod || 'efectivo';
  const documentType = DB.saleDocumentType || 'ticket';
  const ncfType = String(DB.saleNcfType || '').trim().toUpperCase();
  let label = 'Cobrar y generar ticket';
  if (paymentMethod === 'contra_entrega') label = 'Enviar pedido';
  else if (paymentMethod === 'credito') label = 'Registrar crédito';
  else if (documentType === 'factura-electronica') label = 'Cobrar y emitir e-CF';
  else if (ncfType) label = 'Cobrar y facturar';
  return `${label} ${totalText}`;
}

function getBillingDirtyFields() {
  const total = parseFmt(document.getElementById('s-total')?.textContent || fmt(0));
  return [
    Array.isArray(DB.saleItems) && DB.saleItems.length > 0,
    Number(total || 0) > 0,
    Boolean(DB.saleClientId),
    String(DB.saleDocumentType || 'ticket') !== 'ticket',
    Boolean(DB.saleNcfType),
    Number(DB.saleGeneralDiscount || 0) > 0,
    String(DB.saleOrderType || 'mostrador') !== 'mostrador',
    Boolean(DB.saleDeliveryUserId),
    Boolean(String(DB.saleDeliveryPhone || '').trim()),
    Boolean(String(DB.saleDeliveryAddress || '').trim()),
    Boolean(String(DB.saleOrderNotes || '').trim()),
    Boolean(String(DB.saleTableLabel || '').trim()),
    String(DB.payMethod || 'efectivo') !== 'efectivo',
    Boolean(String(document.getElementById('monto-recibido')?.value || '').trim()),
    Boolean(String(billingModalState.cardReference || '').trim()),
    Boolean(String(billingModalState.transferReference || '').trim()),
    Boolean(String(billingModalState.creditDueDate || '').trim()),
    Boolean(String(billingModalState.creditNotes || '').trim()),
    Boolean(String(billingModalState.mixedCashAmount || '').trim()),
    Boolean(String(billingModalState.mixedCardAmount || '').trim()),
    Boolean(String(billingModalState.mixedTransferAmount || '').trim())
  ];
}

function billingHasDraftData() {
  return getBillingDirtyFields().some(Boolean);
}

function requestBillingModalClose({ source = 'generic' } = {}) {
  const interactiveSource = source === 'cancel' || source === 'x' || source === 'success' || source === 'force';
  if (source === 'success' || source === 'force') {
    closeAllModals(true, source);
    return;
  }
  if (!billingHasDraftData()) {
    if (interactiveSource) {
      closeAllModals(true, source);
    } else {
      showToast('Usa Cancelar o la X para cerrar este módulo.', 'info');
    }
    return;
  }
  showBillingDiscardPrompt();
}
window.requestBillingModalClose = requestBillingModalClose;

function refreshSaleClientOptions() {
  const select = document.getElementById('sale-client-select');
  if (!select) return;

  const currentValue = DB.saleClientId ? String(DB.saleClientId) : '';
  select.innerHTML = `
    <option value="">${getBillingClientOptionLabel()}</option>
    ${DB.clientes
      .slice()
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
      .map((client) => `<option value="${client.id}">${client.nombre}${client.cedula ? ` · ${client.cedula}` : ''}</option>`)
      .join('')}
  `;
  select.value = currentValue;
}

function getDeliveryUsers() {
  return (DB.users || [])
    .filter((user) => ['Delivery', 'Repartidor'].includes(user.rol) && user.estado === 'Activo')
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

function buildDeliveryUserOptions() {
  const selectedValue = DB.saleDeliveryUserId ? String(DB.saleDeliveryUserId) : '';
  return `
    <option value="">Selecciona un delivery</option>
    ${getDeliveryUsers().map((user) => `
      <option value="${user.id}" ${selectedValue === String(user.id) ? 'selected' : ''}>${user.nombre}${user.email ? ` · ${user.email}` : ''}</option>
    `).join('')}
  `;
}

function buildBillingModalMarkup() {
  const salesFlow = getSalesFlowConfig();
  const orderTypeOptions = getSalesOrderTypeOptions();
  const kitchenStatusOptions = getKitchenStatusOptions();
  const activeFeatures = (typeof getBusinessFeatureList === 'function' ? getBusinessFeatureList() : []).slice(0, 5);
  const paymentMethods = Array.isArray(salesFlow.paymentMethods) && salesFlow.paymentMethods.length
    ? salesFlow.paymentMethods
    : ['efectivo', 'tarjeta', 'transferencia', 'credito', 'contra_entrega'];
  const effectivePaymentMethods = paymentMethods.includes('contra_entrega')
    ? paymentMethods
    : [...paymentMethods, 'contra_entrega'];
  const paymentButtons = [
    { key: 'efectivo', icon: '💵', label: 'Efectivo', hint: 'Pago en caja' },
    { key: 'tarjeta', icon: '💳', label: 'Tarjeta', hint: 'Débito o crédito' },
    { key: 'transferencia', icon: '📲', label: 'Transferencia', hint: 'Banco o QR' },
    { key: 'mixto', icon: '💳💵', label: 'Mixto', hint: 'Tarjeta + efectivo' },
    { key: 'credito', icon: '📋', label: 'Crédito', hint: 'Cobrar después' },
    { key: 'contra_entrega', icon: '🛵', label: 'Contra entrega', hint: 'Delivery cobra' }
  ].filter((item) => effectivePaymentMethods.includes(item.key) || item.key === 'mixto');

  return `
    <div class="billing-modal-body">
      <div class="billing-pane-switcher">
        <button
          type="button"
          id="billing-pane-switch-data"
          class="billing-pane-switch ${billingActivePane === 'data' ? 'active' : ''}"
          onclick="setBillingPane('data')"
        >
          <span class="billing-pane-switch-arrow">←</span>
          <span>Datos del pedido</span>
        </button>
        <button
          type="button"
          id="billing-pane-switch-payment"
          class="billing-pane-switch ${billingActivePane === 'payment' ? 'active' : ''}"
          onclick="setBillingPane('payment')"
        >
          <span>Cobro y pago</span>
          <span class="billing-pane-switch-arrow">→</span>
        </button>
      </div>
      <div class="billing-layout">
        <div id="billing-pane-data" class="billing-main-pane billing-workspace-pane ${billingActivePane === 'data' ? '' : 'hidden'}">
          <div class="billing-pane-shell billing-data-shell">
            <div class="billing-panel-head">
              <strong>Datos de la venta</strong>
              <span>Selecciona pedido, cliente y comprobante.</span>
            </div>
            <div class="billing-field-stack">
              <div class="billing-field-card">
                <label>Pedido</label>
                <select id="sale-order-type" class="form-input billing-field-input" onchange="setSaleOrderType(this.value)">
                  ${buildOptionMarkup(orderTypeOptions, DB.saleOrderType || salesFlow.defaultOrderType || 'mostrador')}
                </select>
              </div>
              <div class="billing-field-card">
                <label>Cliente</label>
                <select id="sale-client-select" class="form-input billing-field-input" onchange="setSaleClient(this.value)">
                  <option value="">Consumidor Final</option>
                </select>
              </div>
              <div class="billing-doc-row">
                <select id="sale-doc-type" class="form-input billing-field-input" onchange="setSaleDocumentType(this.value)">
                  <option value="ticket">Ticket / Factura</option>
                  <option value="factura-electronica">Factura Electrónica</option>
                </select>
                <button class="btn-secondary" type="button" onclick="openClienteModal()">+ Cliente</button>
              </div>

              <!-- NCF TYPE SELECTOR -->
              <div class="billing-field-card" id="ncf-selector-block">
                <label class="ncf-selector-label">
                  Comprobante Fiscal (NCF)
                  <span class="ncf-none-badge" id="ncf-none-badge">Sin NCF</span>
                </label>
                <div class="ncf-type-grid" id="ncf-type-grid">
                  <button type="button" class="ncf-type-btn" data-ncf="" onclick="setSaleNcfType('')" title="Sin NCF — ticket interno">
                    <span class="ncf-code">—</span><span class="ncf-desc">Ticket</span>
                  </button>
                  <button type="button" class="ncf-type-btn" data-ncf="B02" onclick="setSaleNcfType('B02')" title="Consumidor Final">
                    <span class="ncf-code">B02</span><span class="ncf-desc">Consumo</span>
                  </button>
                  <button type="button" class="ncf-type-btn" data-ncf="B01" onclick="setSaleNcfType('B01')" title="Crédito Fiscal — requiere RNC">
                    <span class="ncf-code">B01</span><span class="ncf-desc">Crédito Fiscal</span>
                  </button>
                  <button type="button" class="ncf-type-btn" data-ncf="B04" onclick="setSaleNcfType('B04')" title="Nota de Crédito — requiere factura original">
                    <span class="ncf-code">B04</span><span class="ncf-desc">Nota Crédito</span>
                  </button>
                  <button type="button" class="ncf-type-btn" data-ncf="B03" onclick="setSaleNcfType('B03')" title="Nota de Débito — requiere factura original">
                    <span class="ncf-code">B03</span><span class="ncf-desc">Nota Débito</span>
                  </button>
                  <button type="button" class="ncf-type-btn ncf-type-btn-sm" data-ncf="B14" onclick="setSaleNcfType('B14')" title="Régimen Especial">
                    <span class="ncf-code">B14</span><span class="ncf-desc">Esp.</span>
                  </button>
                  <button type="button" class="ncf-type-btn ncf-type-btn-sm" data-ncf="B15" onclick="setSaleNcfType('B15')" title="Gubernamental">
                    <span class="ncf-code">B15</span><span class="ncf-desc">Gob.</span>
                  </button>
                </div>
                <!-- Cliente rápido por RNC/cédula: disponible en cualquier tipo salvo B03/B04 -->
                <div class="ncf-extra-fields" id="ncf-rnc-fields" style="display:none">
                  <input type="text" id="ncf-rnc-input" class="form-input" placeholder="RNC o cédula (opcional, autocompleta nombre)" maxlength="11"
                    oninput="DB.saleRncCliente=this.value.replace(/\D/g,'').slice(0,11); updateSaleFiscalPreview()">
                  <input type="text" id="ncf-razon-input" class="form-input" placeholder="Nombre o razón social"
                    oninput="DB.saleRazonSocial=this.value; updateSaleFiscalPreview()">
                </div>
                <!-- B03/B04: reference invoice search -->
                <div class="ncf-extra-fields" id="ncf-ref-fields" style="display:none">
                  <div class="ncf-ref-search-row">
                    <input type="text" id="ncf-ref-input" class="form-input" placeholder="Buscar factura original (NCF, # o cliente)…"
                      oninput="ncfSearchInvoices(this.value)">
                    <span class="ncf-ref-clear" onclick="clearNcfRef()" title="Limpiar">✕</span>
                  </div>
                  <div class="ncf-ref-results" id="ncf-ref-results"></div>
                  <div class="ncf-ref-selected" id="ncf-ref-selected" style="display:none">
                    <span id="ncf-ref-selected-text"></span>
                    <button type="button" class="ncf-ref-clear-btn" onclick="clearNcfRef()">✕</button>
                  </div>
                </div>
              </div>
            </div>
            <div class="sale-fiscal-preview" id="sale-fiscal-preview"></div>

            <details class="billing-advanced" id="billing-advanced-section">
              <summary>Opciones del pedido</summary>
              <div class="billing-modal-grid" style="margin-top:1rem">
                <div class="form-group ${salesFlow.showKitchenStatus === false ? 'hidden' : ''}">
                  <label>Estado de cocina</label>
                  <select id="sale-kitchen-status" class="form-input" onchange="setSaleKitchenStatus(this.value)">
                    ${buildOptionMarkup(kitchenStatusOptions, DB.saleKitchenStatus || salesFlow.defaultKitchenStatus || 'pendiente')}
                  </select>
                </div>
                <div class="form-group ${salesFlow.showTableField === false ? 'hidden' : ''}">
                  <label>${escapeHtml(salesFlow.tableLabel || 'Mesa / Comanda')}</label>
                  <input type="text" id="sale-table-label" class="form-input" placeholder="Mesa 4 / Barra / Terraza" value="${escapeHtml(DB.saleTableLabel || '')}" oninput="setSaleTableLabel(this.value)">
                </div>
                <div class="form-group ${salesFlow.showDeliveryFields === false ? 'hidden' : ''}">
                  <label>${escapeHtml(salesFlow.deliveryUserLabel || 'Repartidor')}</label>
                  <select id="sale-delivery-user" class="form-input" onchange="setSaleDeliveryUser(this.value)">
                    ${buildDeliveryUserOptions()}
                  </select>
                </div>
                <div class="form-group span-full ${salesFlow.showDeliveryFields === false ? 'hidden' : ''}">
                  <label>Resumen del cliente</label>
                  <div id="billing-client-snapshot">${buildSelectedClientSnapshotMarkup()}</div>
                </div>
                <div class="form-group span-full">
                  <label>Notas del pedido</label>
                  <textarea id="sale-order-notes" class="form-input" rows="3" placeholder="${escapeHtml(salesFlow.notesPlaceholder || 'Sin cebolla, borde relleno, llamar al llegar')}" oninput="setSaleOrderNotes(this.value)">${escapeHtml(DB.saleOrderNotes || '')}</textarea>
                </div>
              </div>
            </details>
          </div>
        </div>

        <div id="billing-pane-payment" class="billing-side-pane billing-showcase-pane ${billingActivePane === 'payment' ? '' : 'hidden'}">
          <div class="billing-pane-shell billing-payment-pane">
            <div class="billing-panel-head">
              <strong>Método de pago</strong>
              <span>Elige cómo paga el cliente y confirma el monto recibido.</span>
            </div>
            <div class="billing-sale-summary" id="billing-sale-summary">
              <div class="billing-sale-summary-header">
                <span>Resumen a cobrar</span>
                <strong id="billing-items-count">0 productos</strong>
              </div>
              <div class="billing-sale-summary-lines">
                <div class="billing-sale-line">
                  <span>Subtotal</span>
                  <strong id="billing-subtotal">RD$ 0.00</strong>
                </div>
                <div class="billing-sale-line" id="billing-subtotal-gravado-row" style="display:none">
                  <span>Subtotal gravado</span>
                  <strong id="billing-subtotal-gravado">RD$ 0.00</strong>
                </div>
                <div class="billing-sale-line" id="billing-subtotal-exento-row" style="display:none">
                  <span>Subtotal exento</span>
                  <strong id="billing-subtotal-exento">RD$ 0.00</strong>
                </div>
                <div class="billing-sale-line">
                  <span>Descuento</span>
                  <strong id="billing-descuento">- RD$ 0.00</strong>
                </div>
                <div class="billing-sale-line">
                  <span>ITBIS</span>
                  <strong id="billing-itbis">RD$ 0.00</strong>
                </div>
                <div class="billing-sale-line billing-sale-line-total">
                  <span>Total</span>
                  <strong id="billing-total">RD$ 0.00</strong>
                </div>
              </div>
            </div>
            <div class="payment-methods">
              ${paymentButtons.map((method, index) => `
                <button class="pay-method ${index === 0 ? 'active' : ''}" ${method.key === 'contra_entrega' ? 'id="pay-method-cod"' : ''} onclick="setPayMethod('${method.key}', this)">
                  <span class="pay-method-icon">${method.icon}</span>
                  <span class="pay-method-label">${method.label}</span>
                  <span class="pay-method-hint">${method.hint}</span>
                </button>
              `).join('')}
            </div>

            <div class="payment-amount-area" id="efectivo-area">
              <label>Monto recibido del cliente</label>
              <input type="number" id="monto-recibido" placeholder="0.00" oninput="calcCambio()" class="amount-input">
              <div class="cambio-display">
                <span class="cambio-label">Cambio a entregar:</span>
                <span id="cambio-val" class="cambio-amount">RD$ 0.00</span>
              </div>
            </div>
            <div class="payment-amount-area" id="contra-entrega-area" style="display:none">
              <label>Pago contra entrega</label>
              <div class="sale-fiscal-ok">Este pedido quedará pendiente en caja hasta que el delivery entregue el dinero.</div>
            </div>
            <div class="payment-amount-area pay-mixto-area" id="mixto-area" style="display:none">
              <label>Pago mixto — Tarjeta + Efectivo</label>
              <div class="mixto-inputs">
                <div class="mixto-field">
                  <span class="mixto-field-label">💳 Tarjeta</span>
                  <input type="number" id="mixto-tarjeta" class="amount-input" placeholder="0.00" min="0" step="0.01" oninput="calcMixto()">
                </div>
                <div class="mixto-field">
                  <span class="mixto-field-label">💵 Efectivo</span>
                  <input type="number" id="mixto-efectivo" class="amount-input" placeholder="0.00" min="0" step="0.01" oninput="calcMixto()">
                </div>
              </div>
              <div class="mixto-status" id="mixto-status">
                <span class="mixto-status-label">Pendiente:</span>
                <span class="mixto-status-val" id="mixto-pendiente">RD$ 0.00</span>
              </div>
              <div class="cambio-display" id="mixto-cambio-row" style="display:none">
                <span class="cambio-label">Cambio a entregar:</span>
                <span id="mixto-cambio-val" class="cambio-amount">RD$ 0.00</span>
              </div>
            </div>

            <div class="quick-amounts" id="quick-amounts">
              <button type="button" class="quick-amount-btn" onclick="setMontoRapido(100, this)">RD$ 100</button>
              <button type="button" class="quick-amount-btn" onclick="setMontoRapido(200, this)">RD$ 200</button>
              <button type="button" class="quick-amount-btn" onclick="setMontoRapido(500, this)">RD$ 500</button>
              <button type="button" class="quick-amount-btn" onclick="setMontoRapido(1000, this)">RD$ 1,000</button>
              <button type="button" class="quick-amount-btn" onclick="setMontoRapido(2000, this)">RD$ 2,000</button>
              <button type="button" class="quick-amount-btn quick-amount-btn-exact" id="quick-amount-exact" onclick="setMontoExacto(this)">Exacto</button>
            </div>

            <div class="discount-area">
              <label>Descuento general del pedido (%)</label>
              <input type="number" id="desc-general" min="0" max="100" placeholder="0" value="${parseFloat(DB.saleGeneralDiscount || 0) || 0}" oninput="applyGeneralDiscount()" class="discount-input">
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function buildBillingStepModalMarkup() {
  const total = parseFmt(document.getElementById('s-total')?.textContent || fmt(0));
  const selectedClient = getSelectedSaleClient();
  const selectedResponsible = getSelectedBillingResponsible();
  const orderCards = getBillingOrderTypeCards().map((item) => {
    const isActive = normalizeBillingOrderType(DB.saleOrderType) === item.key;
    return `
      <button
        type="button"
        class="billing-step-card billing-order-card ${isActive ? 'is-active' : ''}"
        onclick="setSaleOrderTypeFromCard('${item.key}')"
      >
        <span class="billing-step-card-icon">${item.icon}</span>
        <span class="billing-step-card-name">${item.label}</span>
        <span class="billing-step-card-hint">${item.hint}</span>
      </button>
    `;
  }).join('');
  const responsibleCards = BILLING_RESPONSIBLE_TYPES.map((item) => `
    <button
      type="button"
      class="billing-step-card billing-step-card-sm billing-responsible-card ${billingModalState.responsibleType === item.key ? 'is-active' : ''}"
      onclick="setBillingResponsible('${item.key}')"
    >
      <span class="billing-step-card-icon">${item.icon}</span>
      <span class="billing-step-card-name">${item.label}</span>
      <span class="billing-step-card-hint">${item.hint}</span>
    </button>
  `).join('');
  const rememberLastClient = getBillingRememberLastClientEnabled();
  const activeClientId = DB.saleClientId ? String(DB.saleClientId) : '';
  const activeDocType = DB.saleDocumentType || 'ticket';
  const isElectronicEnabled = Boolean(DB.config?.eInvoiceEnabled);
  const paymentMethod = DB.payMethod || 'efectivo';
  const showNoItems = !(Array.isArray(DB.saleItems) && DB.saleItems.length) || !(total > 0);

  return `
    <div class="billing-step-shell">
      <div class="billing-stepper">
        ${BILLING_STEP_FLOW.map((step, index) => {
          const labels = {
            order: '1 Datos del pedido',
            client: '2 Cliente y comprobante',
            payment: '3 Cobro y pago',
            confirm: '4 Confirmación'
          };
          const currentIndex = getBillingStepIndex();
          const status = index < currentIndex ? 'done' : index === currentIndex ? 'active' : 'pending';
          const symbol = status === 'done' ? '✓' : status === 'active' ? '●' : '○';
          return `
            <button
              type="button"
              class="billing-stepper-item is-${status}"
              onclick="setBillingStep('${step}')"
            >
              <span class="billing-stepper-dot">${symbol}</span>
              <span class="billing-stepper-label">${labels[step]}</span>
            </button>
          `;
        }).join('')}
      </div>

      <div class="billing-step-panels">
        <section id="billing-step-order" class="billing-step-panel ${billingActiveStep === 'order' ? '' : 'hidden'}">
          <div class="billing-step-head">
            <strong>Datos del pedido</strong>
            <span>Define el contexto de la venta antes de elegir cliente y comprobante.</span>
          </div>
          <div class="billing-step-section">
            <div class="billing-step-section-title">Tipo de pedido</div>
            <div class="billing-step-card-grid">${orderCards}</div>
          </div>
          <div class="billing-step-section">
            <div class="billing-step-section-title">Responsable</div>
            <div class="billing-step-card-grid billing-step-card-grid-sm">${responsibleCards}</div>
          </div>
          <div class="billing-step-grid">
            <div class="billing-step-field">
              <label>Estado de cocina</label>
              <select id="sale-kitchen-status" class="form-input billing-step-input" onchange="setSaleKitchenStatus(this.value)">
                ${buildOptionMarkup(getKitchenStatusOptions(), DB.saleKitchenStatus || 'pendiente')}
              </select>
            </div>
            <div class="billing-step-field">
              <label>Mesa / referencia interna</label>
              <input
                id="sale-table-label"
                type="text"
                class="form-input billing-step-input"
                placeholder="Mesa 4, barra, terraza, comanda..."
                value="${escapeHtml(DB.saleTableLabel || '')}"
                oninput="setSaleTableLabel(this.value)"
              >
            </div>
          </div>
          <div class="billing-step-field">
            <label>Notas del pedido</label>
            <textarea
              id="sale-order-notes"
              class="form-input billing-step-input"
              rows="3"
              placeholder="Sin cebolla, llamar al llegar, cliente espera en la puerta..."
              oninput="setSaleOrderNotes(this.value)"
            >${escapeHtml(DB.saleOrderNotes || '')}</textarea>
          </div>
          <div class="billing-step-inline-note">
            <strong>${selectedResponsible.icon} ${selectedResponsible.label}</strong>
            <span>${selectedResponsible.hint}</span>
          </div>
        </section>

        <section id="billing-step-client" class="billing-step-panel ${billingActiveStep === 'client' ? '' : 'hidden'}">
          <div class="billing-step-head">
            <strong>Cliente y comprobante</strong>
            <span>El cliente es opcional, pero algunos comprobantes requieren datos fiscales completos.</span>
          </div>
          <div class="billing-step-grid billing-step-grid-tight">
            <div class="billing-step-field">
              <label>Cliente</label>
              <select id="sale-client-select" class="form-input billing-step-input" onchange="setSaleClient(this.value)">
                <option value="">${getBillingClientOptionLabel()}</option>
                ${DB.clientes
                  .slice()
                  .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
                  .map((client) => `<option value="${client.id}" ${activeClientId === String(client.id) ? 'selected' : ''}>${client.nombre}${client.cedula ? ` · ${client.cedula}` : ''}</option>`)
                  .join('')}
              </select>
            </div>
            <div class="billing-step-field billing-step-field-action">
              <label>Cliente rápido</label>
              <button class="btn-secondary billing-step-action-btn" type="button" onclick="toggleBillingQuickClient()">+ Cliente rápido</button>
            </div>
          </div>
          <div id="billing-quick-client" class="billing-quick-client hidden">
            <div class="billing-step-grid billing-step-grid-tight">
              <div class="billing-step-field">
                <label>Nombre</label>
                <input id="billing-qc-nombre" type="text" class="form-input billing-step-input" placeholder="Nombre completo">
              </div>
              <div class="billing-step-field">
                <label>Cédula / RNC</label>
                <input id="billing-qc-cedula" type="text" class="form-input billing-step-input" placeholder="Documento fiscal">
              </div>
              <div class="billing-step-field">
                <label>Teléfono</label>
                <input id="billing-qc-telefono" type="text" class="form-input billing-step-input" placeholder="809-000-0000">
              </div>
              <div class="billing-step-field">
                <label>WhatsApp</label>
                <input id="billing-qc-whatsapp" type="text" class="form-input billing-step-input" placeholder="809-000-0000">
              </div>
            </div>
            <div class="billing-step-grid billing-step-grid-tight">
              <div class="billing-step-field">
                <label>Dirección</label>
                <input id="billing-qc-direccion" type="text" class="form-input billing-step-input" placeholder="Dirección del cliente">
              </div>
              <div class="billing-step-field">
                <label>Referencia</label>
                <input id="billing-qc-referencia" type="text" class="form-input billing-step-input" placeholder="Casa azul, frente al parque">
              </div>
            </div>
            <div class="billing-step-field">
              <label>Ubicación</label>
              <input id="billing-qc-ubicacion" type="text" class="form-input billing-step-input" placeholder="https://maps.google.com/...">
            </div>
            <div class="billing-quick-client-actions">
              <button type="button" class="btn-secondary" onclick="toggleBillingQuickClient(false)">Cancelar</button>
              <button type="button" class="btn-primary" onclick="saveBillingQuickClient()">Guardar cliente</button>
            </div>
          </div>
          <label class="billing-inline-check">
            <input
              type="checkbox"
              id="billing-remember-client"
              ${rememberLastClient ? 'checked' : ''}
              onchange="toggleBillingRememberLastClient(this.checked)"
            >
            <span>Mantener último cliente seleccionado</span>
          </label>
          <div id="billing-client-snapshot">${buildSelectedClientSnapshotMarkup()}</div>

          <div class="billing-step-section">
            <div class="billing-step-section-title">Tipo de comprobante</div>
            <div class="billing-doc-type-grid">
              <button type="button" class="billing-doc-card ${activeDocType === 'ticket' ? 'is-active' : ''}" onclick="setSaleDocumentTypeCard('ticket')">
                <span class="billing-doc-card-title">Ticket</span>
                <span class="billing-doc-card-sub">Venta rápida o factura interna</span>
              </button>
              <button
                type="button"
                class="billing-doc-card ${activeDocType === 'factura-electronica' ? 'is-active' : ''} ${!isElectronicEnabled ? 'is-disabled' : ''}"
                onclick="setSaleDocumentTypeCard('factura-electronica')"
                ${!isElectronicEnabled ? 'disabled' : ''}
              >
                <span class="billing-doc-card-title">Factura Electrónica</span>
                <span class="billing-doc-card-sub">${isElectronicEnabled ? 'Emisión DGII / e-CF' : 'Deshabilitada en configuración'}</span>
              </button>
            </div>
          </div>

          <div class="billing-step-section billing-step-section-ncf">
            <div class="billing-step-section-title">Comprobante fiscal</div>
            <div class="ncf-type-grid" id="ncf-type-grid">
              <button type="button" class="ncf-type-btn" data-ncf="" onclick="setSaleNcfType('')" title="Sin NCF — ticket interno">
                <span class="ncf-code">—</span><span class="ncf-desc">Ticket</span>
              </button>
              <button type="button" class="ncf-type-btn" data-ncf="B02" onclick="setSaleNcfType('B02')" title="Consumidor Final">
                <span class="ncf-code">B02</span><span class="ncf-desc">Consumo</span>
              </button>
              <button type="button" class="ncf-type-btn" data-ncf="B01" onclick="setSaleNcfType('B01')" title="Crédito Fiscal">
                <span class="ncf-code">B01</span><span class="ncf-desc">Fiscal</span>
              </button>
              <button type="button" class="ncf-type-btn" data-ncf="B04" onclick="setSaleNcfType('B04')" title="Nota de Crédito">
                <span class="ncf-code">B04</span><span class="ncf-desc">Nota Cr.</span>
              </button>
              <button type="button" class="ncf-type-btn" data-ncf="B03" onclick="setSaleNcfType('B03')" title="Nota de Débito">
                <span class="ncf-code">B03</span><span class="ncf-desc">Nota Db.</span>
              </button>
              <button type="button" class="ncf-type-btn ncf-type-btn-sm" data-ncf="B14" onclick="setSaleNcfType('B14')" title="Régimen Especial">
                <span class="ncf-code">B14</span><span class="ncf-desc">Especial</span>
              </button>
              <button type="button" class="ncf-type-btn ncf-type-btn-sm" data-ncf="B15" onclick="setSaleNcfType('B15')" title="Gubernamental">
                <span class="ncf-code">B15</span><span class="ncf-desc">Gob.</span>
              </button>
            </div>
            <span class="ncf-none-badge" id="ncf-none-badge">Sin NCF</span>
            <div class="ncf-extra-fields" id="ncf-rnc-fields" style="display:none">
              <input type="text" id="ncf-rnc-input" class="form-input billing-step-input" placeholder="RNC o cédula (opcional, autocompleta nombre)" maxlength="11" oninput="DB.saleRncCliente=this.value.replace(/\\D/g,'').slice(0,11); updateSaleFiscalPreview()">
              <input type="text" id="ncf-razon-input" class="form-input billing-step-input" placeholder="Nombre o razón social" oninput="DB.saleRazonSocial=this.value; updateSaleFiscalPreview()">
            </div>
            <div class="ncf-extra-fields" id="ncf-ref-fields" style="display:none">
              <div class="ncf-ref-search-row">
                <input type="text" id="ncf-ref-input" class="form-input billing-step-input" placeholder="Buscar factura original..." oninput="ncfSearchInvoices(this.value)">
                <span class="ncf-ref-clear" onclick="clearNcfRef()" title="Limpiar">✕</span>
              </div>
              <div class="ncf-ref-results" id="ncf-ref-results"></div>
              <div class="ncf-ref-selected" id="ncf-ref-selected" style="display:none">
                <span id="ncf-ref-selected-text"></span>
                <button type="button" class="ncf-ref-clear-btn" onclick="clearNcfRef()">✕</button>
              </div>
            </div>
          </div>
          <div class="sale-fiscal-preview" id="sale-fiscal-preview"></div>
        </section>

        <section id="billing-step-payment" class="billing-step-panel ${billingActiveStep === 'payment' ? '' : 'hidden'}">
          <div class="billing-step-head">
            <strong>Cobro y pago</strong>
            <span>Selecciona el método de pago y completa solo los datos necesarios.</span>
          </div>
          <div class="billing-sale-summary billing-sale-summary-lg" id="billing-sale-summary">
            <div class="billing-sale-summary-header">
              <span>Resumen de cobro</span>
              <strong id="billing-items-count">0 productos</strong>
            </div>
            <div class="billing-sale-summary-lines">
              <div class="billing-sale-line">
                <span>Subtotal</span>
                <strong id="billing-subtotal">RD$ 0.00</strong>
              </div>
              <div class="billing-sale-line" id="billing-subtotal-gravado-row" style="display:none">
                <span>Subtotal gravado</span>
                <strong id="billing-subtotal-gravado">RD$ 0.00</strong>
              </div>
              <div class="billing-sale-line" id="billing-subtotal-exento-row" style="display:none">
                <span>Subtotal exento</span>
                <strong id="billing-subtotal-exento">RD$ 0.00</strong>
              </div>
              <div class="billing-sale-line">
                <span>Descuento</span>
                <strong id="billing-descuento">- RD$ 0.00</strong>
              </div>
              <div class="billing-sale-line">
                <span>ITBIS</span>
                <strong id="billing-itbis">RD$ 0.00</strong>
              </div>
              <div class="billing-sale-line billing-sale-line-total">
                <span>Total</span>
                <strong id="billing-total">RD$ 0.00</strong>
              </div>
            </div>
            <div id="billing-total-empty" class="billing-total-empty ${showNoItems ? '' : 'hidden'}">No existen productos para cobrar.</div>
          </div>

          <div class="payment-methods payment-methods-modern">
            ${[
              { key: 'efectivo', icon: '💵', label: 'Efectivo', hint: 'Cambio automático' },
              { key: 'tarjeta', icon: '💳', label: 'Tarjeta', hint: 'Banco y referencia' },
              { key: 'transferencia', icon: '🏦', label: 'Transferencia', hint: 'Banco o QR' },
              { key: 'mixto', icon: '💵💳', label: 'Mixto', hint: 'Suma varias fuentes' },
              { key: 'credito', icon: '📄', label: 'Crédito', hint: 'Cliente obligatorio' },
              { key: 'contra_entrega', icon: '🛵', label: 'Contra entrega', hint: 'Delivery cobra' }
            ].map((method) => `
              <button type="button" class="pay-method ${paymentMethod === method.key ? 'active' : ''}" ${method.key === 'contra_entrega' ? 'id="pay-method-cod"' : ''} onclick="setPayMethod('${method.key}', this)">
                <span class="pay-method-icon">${method.icon}</span>
                <span class="pay-method-label">${method.label}</span>
                <span class="pay-method-hint">${method.hint}</span>
              </button>
            `).join('')}
          </div>

          <div class="billing-payment-panels">
            <div class="payment-amount-area" id="efectivo-area">
              <label>Monto recibido</label>
              <input type="number" id="monto-recibido" placeholder="0.00" oninput="calcCambio()" class="amount-input billing-step-input">
              <div class="cambio-display">
                <span class="cambio-label">Cambio automático:</span>
                <span id="cambio-val" class="cambio-amount">RD$ 0.00</span>
              </div>
              <div class="quick-amounts" id="quick-amounts">
                <button type="button" class="quick-amount-btn" onclick="setMontoRapido(100, this)">RD$ 100</button>
                <button type="button" class="quick-amount-btn" onclick="setMontoRapido(200, this)">RD$ 200</button>
                <button type="button" class="quick-amount-btn" onclick="setMontoRapido(500, this)">RD$ 500</button>
                <button type="button" class="quick-amount-btn" onclick="setMontoRapido(1000, this)">RD$ 1,000</button>
                <button type="button" class="quick-amount-btn" onclick="setMontoRapido(2000, this)">RD$ 2,000</button>
                <button type="button" class="quick-amount-btn quick-amount-btn-exact" id="quick-amount-exact" onclick="setMontoExacto(this)">Exacto</button>
              </div>
            </div>

            <div class="payment-amount-area billing-payment-form" id="tarjeta-area" style="display:none">
              <label>Datos de tarjeta</label>
              <div class="billing-step-grid billing-step-grid-tight">
                <div class="billing-step-field">
                  <label>Banco</label>
                  <input type="text" class="form-input billing-step-input" value="${escapeHtml(billingModalState.cardBank || '')}" oninput="updateBillingPaymentDetail('cardBank', this.value)" placeholder="Banco emisor">
                </div>
                <div class="billing-step-field">
                  <label>Referencia</label>
                  <input type="text" class="form-input billing-step-input" value="${escapeHtml(billingModalState.cardReference || '')}" oninput="updateBillingPaymentDetail('cardReference', this.value)" placeholder="Últimos 4 dígitos o lote">
                </div>
              </div>
              <div class="billing-step-field">
                <label>Tipo de tarjeta</label>
                <select class="form-input billing-step-input" onchange="updateBillingPaymentDetail('cardType', this.value)">
                  <option value="">Selecciona un tipo</option>
                  ${BILLING_CARD_TYPES.map((item) => `<option value="${item}" ${billingModalState.cardType === item ? 'selected' : ''}>${item}</option>`).join('')}
                </select>
              </div>
            </div>

            <div class="payment-amount-area billing-payment-form" id="transferencia-area" style="display:none">
              <label>Datos de transferencia</label>
              <div class="billing-step-grid billing-step-grid-tight">
                <div class="billing-step-field">
                  <label>Banco</label>
                  <input type="text" class="form-input billing-step-input" value="${escapeHtml(billingModalState.transferBank || '')}" oninput="updateBillingPaymentDetail('transferBank', this.value)" placeholder="Banco destino">
                </div>
                <div class="billing-step-field">
                  <label>Referencia</label>
                  <input type="text" class="form-input billing-step-input" value="${escapeHtml(billingModalState.transferReference || '')}" oninput="updateBillingPaymentDetail('transferReference', this.value)" placeholder="No. de comprobante">
                </div>
              </div>
              <div class="billing-step-field">
                <label>Captura opcional</label>
                <input type="text" class="form-input billing-step-input" value="${escapeHtml(billingModalState.transferCaptureName || '')}" oninput="updateBillingPaymentDetail('transferCaptureName', this.value)" placeholder="Nombre o referencia de la captura">
              </div>
            </div>

            <div class="payment-amount-area pay-mixto-area" id="mixto-area" style="display:none">
              <label>Pago mixto</label>
              <div class="mixto-inputs mixto-inputs-3">
                <div class="mixto-field">
                  <span class="mixto-field-label">💵 Efectivo</span>
                  <input type="number" id="mixto-efectivo" class="amount-input" placeholder="0.00" min="0" step="0.01" value="${escapeHtml(String(billingModalState.mixedCashAmount || ''))}" oninput="calcMixto()">
                </div>
                <div class="mixto-field">
                  <span class="mixto-field-label">💳 Tarjeta</span>
                  <input type="number" id="mixto-tarjeta" class="amount-input" placeholder="0.00" min="0" step="0.01" value="${escapeHtml(String(billingModalState.mixedCardAmount || ''))}" oninput="calcMixto()">
                </div>
                <div class="mixto-field">
                  <span class="mixto-field-label">🏦 Transferencia</span>
                  <input type="number" id="mixto-transferencia" class="amount-input" placeholder="0.00" min="0" step="0.01" value="${escapeHtml(String(billingModalState.mixedTransferAmount || ''))}" oninput="calcMixto()">
                </div>
              </div>
              <div class="mixto-status" id="mixto-status">
                <span class="mixto-status-label">Pendiente:</span>
                <span class="mixto-status-val" id="mixto-pendiente">RD$ 0.00</span>
              </div>
              <div class="cambio-display" id="mixto-cambio-row" style="display:none">
                <span class="cambio-label">Cambio a entregar:</span>
                <span id="mixto-cambio-val" class="cambio-amount">RD$ 0.00</span>
              </div>
            </div>

            <div class="payment-amount-area billing-payment-form" id="credito-area" style="display:none">
              <label>Crédito</label>
              <div class="billing-step-grid billing-step-grid-tight">
                <div class="billing-step-field">
                  <label>Fecha de vencimiento</label>
                  <input type="date" class="form-input billing-step-input" value="${escapeHtml(billingModalState.creditDueDate || '')}" oninput="updateBillingPaymentDetail('creditDueDate', this.value)">
                </div>
                <div class="billing-step-field">
                  <label>Límite disponible</label>
                  <input type="text" class="form-input billing-step-input" readonly value="${selectedClient ? fmt(Math.max(0, Number(selectedClient.limiteCredito || 0))) : 'Selecciona un cliente'}">
                </div>
              </div>
              <div class="billing-step-field">
                <label>Notas del crédito</label>
                <textarea class="form-input billing-step-input" rows="2" placeholder="Observaciones, acuerdos o fecha de seguimiento" oninput="updateBillingPaymentDetail('creditNotes', this.value)">${escapeHtml(billingModalState.creditNotes || '')}</textarea>
              </div>
            </div>

            <div class="payment-amount-area billing-payment-form" id="contra-entrega-area" style="display:none">
              <label>Contra entrega</label>
              <div class="sale-fiscal-ok">El delivery entregará el dinero luego del despacho. El pedido quedará protegido como pendiente de cobro.</div>
              <div class="billing-step-grid billing-step-grid-tight">
                <div class="billing-step-field">
                  <label>Delivery asignado</label>
                  <select id="sale-delivery-user" class="form-input billing-step-input" onchange="setSaleDeliveryUser(this.value)">
                    ${buildDeliveryUserOptions()}
                  </select>
                </div>
                <div class="billing-step-field">
                  <label>Teléfono</label>
                  <input id="sale-delivery-phone" type="text" class="form-input billing-step-input" value="${escapeHtml(DB.saleDeliveryPhone || '')}" oninput="setSaleDeliveryPhone(this.value)">
                </div>
              </div>
              <div class="billing-step-field">
                <label>Dirección</label>
                <input id="sale-delivery-address" type="text" class="form-input billing-step-input" value="${escapeHtml(DB.saleDeliveryAddress || '')}" oninput="setSaleDeliveryAddress(this.value)">
              </div>
              <div class="billing-step-grid billing-step-grid-tight">
                <div class="billing-step-field">
                  <label>Referencia</label>
                  <input id="sale-delivery-reference" type="text" class="form-input billing-step-input" value="${escapeHtml(DB.saleDeliveryReference || '')}" oninput="setSaleDeliveryReference(this.value)">
                </div>
                <div class="billing-step-field">
                  <label>Ubicación</label>
                  <input id="sale-delivery-link" type="text" class="form-input billing-step-input" value="${escapeHtml(DB.saleDeliveryLink || '')}" oninput="setSaleDeliveryLink(this.value)">
                </div>
              </div>
            </div>
          </div>

          <div class="discount-area">
            <label>Descuento general del pedido (%)</label>
            <input type="number" id="desc-general" min="0" max="100" placeholder="0" value="${parseFloat(DB.saleGeneralDiscount || 0) || 0}" oninput="applyGeneralDiscount()" class="discount-input billing-step-input">
          </div>
        </section>

        <section id="billing-step-confirm" class="billing-step-panel ${billingActiveStep === 'confirm' ? '' : 'hidden'}">
          <div class="billing-step-head">
            <strong>Confirmación</strong>
            <span>Revisa la venta antes de cobrar para evitar duplicados, datos incompletos o cobros erróneos.</span>
          </div>
          <div id="billing-confirm-summary" class="billing-confirm-summary"></div>
        </section>
      </div>

      <div id="billing-discard-guard" class="billing-discard-guard hidden">
        <div class="billing-discard-card">
          <strong>Tienes datos sin guardar</strong>
          <span>Si sales ahora, se descartará la información del cobro actual.</span>
          <div class="billing-discard-actions">
            <button type="button" class="btn-secondary" onclick="hideBillingDiscardPrompt()">Continuar editando</button>
            <button type="button" class="btn-danger" onclick="confirmBillingDiscard()">Salir y descartar</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function buildBillingCompactSummaryRowsMarkup() {
  if (!Array.isArray(DB.saleItems) || !DB.saleItems.length) {
    return `
      <div class="billing-compact-empty">
        <strong>No existen productos para cobrar</strong>
        <span>Escanea o agrega productos antes de abrir el cobro.</span>
      </div>
    `;
  }

  return DB.saleItems.map((item, index) => {
    const qty = Number(item?.qty || 0);
    const price = Number(item?.precio || 0);
    const discount = Number(item?.descuento || 0);
    const tax = Number(item?.itbis || 0);
    const total = Number(item?.total || 0);
    return `
      <div class="billing-compact-line">
        <div class="billing-compact-line-main">
          <span class="billing-compact-line-index">${index + 1}</span>
          <div class="billing-compact-line-copy">
            <strong>${escapeHtml(typeof getLocalizedProductName === 'function' ? getLocalizedProductName(item.nombre) : item.nombre || 'Producto')}</strong>
            <span>${escapeHtml(String(item?.codigo || ''))}</span>
          </div>
        </div>
        <div class="billing-compact-line-meta">${qty}</div>
        <div class="billing-compact-line-meta">${fmt(price)}</div>
        <div class="billing-compact-line-meta">${discount}%</div>
        <div class="billing-compact-line-meta">${tax}%</div>
        <div class="billing-compact-line-total">${fmt(total)}</div>
      </div>
    `;
  }).join('');
}

function getBillingActiveDocumentPreset() {
  if (DB.saleDocumentType === 'factura-electronica') return 'factura-electronica';
  return String(DB.saleNcfType || '').trim().toUpperCase() || 'ticket';
}

function buildBillingCompactModalMarkup() {
  const total = parseFmt(document.getElementById('s-total')?.textContent || fmt(0));
  const selectedClient = getSelectedSaleClient();
  const activeClientId = DB.saleClientId ? String(DB.saleClientId) : '';
  const activePreset = getBillingActiveDocumentPreset();
  const paymentMethod = DB.payMethod || 'efectivo';
  const printMode = getBillingPrintMode();
  const hasProducts = Array.isArray(DB.saleItems) && DB.saleItems.length > 0 && total > 0;
  const discountVal = parseFloat(DB.saleGeneralDiscount || 0) || 0;
  const orderType = String(DB.saleOrderType || 'mostrador');

  const mainDocs = [
    { key: 'ticket',              label: 'Ticket', hint: 'Ticket rápido' },
    { key: 'B02',                 label: 'B02',    hint: 'Consumidor final' },
    { key: 'B01',                 label: 'B01',    hint: 'Crédito fiscal' },
    { key: 'factura-electronica', label: 'e-CF',   hint: 'Electrónica' }
  ];
  // Comprobantes menos frecuentes en un desplegable aparte, en vez de llenar
  // la fila de pills — B11/B12/B13/B17 quedan fuera a propósito (esos son de
  // Compras/Gastos, no de una venta del POS).
  const extraDocs = [
    { key: 'B14', label: 'B14 — Régimen Especial' },
    { key: 'B15', label: 'B15 — Gubernamental' },
    { key: 'B16', label: 'B16 — Exportaciones' },
    { key: 'B03', label: 'B03 — Nota de Débito' },
    { key: 'B04', label: 'B04 — Nota de Crédito' },
  ];
  const activeExtraDoc = extraDocs.find((doc) => doc.key === activePreset);

  const sessionExchangeRate = Number(DB.caja?.activeSession?.exchangeRateUsdDop || 0);
  const paymentMethodButtons = [
    { key: 'efectivo',      icon: '💵',   label: 'Efectivo',  shortcut: 'F2' },
    { key: 'tarjeta',       icon: '💳',   label: 'Tarjeta',   shortcut: 'F3' },
    { key: 'transferencia', icon: '🏦',   label: 'Transfer.', shortcut: 'F4' },
    { key: 'mixto',         icon: '💵💳', label: 'Mixto',     shortcut: 'F5' },
    { key: 'credito',       icon: '📄',   label: 'Crédito',   shortcut: 'F6' },
    { key: 'contra_entrega',icon: '🛵',   label: 'Contra entrega', shortcut: 'F8' },
    // Solo si el turno activo tiene una tasa de cambio válida (Fase 1 multi-moneda)
    ...(sessionExchangeRate > 0 ? [{ key: 'usd', icon: '💵', label: 'Dólares', shortcut: 'F7' }] : [])
  ];

  const clientChips = selectedClient ? `
    <span class="billing-v3-client-chip">👤 ${escapeHtml(selectedClient.nombre || '')}</span>
    ${selectedClient.cedula ? `<span class="billing-v3-client-chip">🪪 ${escapeHtml(selectedClient.cedula)}</span>` : ''}
    ${selectedClient.telefono ? `<span class="billing-v3-client-chip">📞 ${escapeHtml(selectedClient.telefono)}</span>` : ''}
  ` : '';

  return `
    <div class="billing-v3-shell">

      <!-- ══ SUBHEADER: Cliente + Tipo + [% Desc] ══ -->
      <div class="billing-v3-subheader">
        <!-- Cliente -->
        <div class="billing-v3-client-wrap">
          <label class="billing-v3-sh-label">Cliente</label>
          <div class="billing-v3-client-row">
            <select id="sale-client-select" class="form-input billing-v3-client-select"
              onchange="setSaleClient(this.value); _syncBillingV3ClientExpand()">
              <option value="">${getBillingClientOptionLabel()}</option>
              ${DB.clientes
                .slice()
                .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
                .map((c) => `<option value="${c.id}" ${activeClientId === String(c.id) ? 'selected' : ''}>${c.nombre}${c.cedula ? ` · ${c.cedula}` : ''}</option>`)
                .join('')}
            </select>
            <button class="billing-v3-add-btn" type="button" onclick="toggleBillingQuickClient()" title="+ Nuevo cliente">+</button>
          </div>
          <!-- Chips del cliente real (auto-expande al seleccionar) -->
          <div id="billing-v3-client-expand" class="billing-v3-client-expand ${selectedClient ? '' : 'hidden'}">
            ${clientChips}
          </div>
          <!-- Formulario de cliente rápido -->
          <div id="billing-quick-client" class="billing-quick-client hidden">
            <div class="billing-step-grid billing-step-grid-tight">
              <div class="billing-step-field">
                <label>Nombre</label>
                <input id="billing-qc-nombre" type="text" class="form-input billing-step-input" placeholder="Nombre completo">
              </div>
              <div class="billing-step-field">
                <label>Cédula/RNC</label>
                <input id="billing-qc-cedula" type="text" class="form-input billing-step-input" placeholder="Documento">
              </div>
              <div class="billing-step-field">
                <label>RNC</label>
                <input id="billing-qc-rnc" type="text" class="form-input billing-step-input" placeholder="RNC">
              </div>
              <div class="billing-step-field">
                <label>Teléfono</label>
                <input id="billing-qc-telefono" type="text" class="form-input billing-step-input" placeholder="809-000-0000">
              </div>
              <div class="billing-step-field">
                <label>WhatsApp</label>
                <input id="billing-qc-whatsapp" type="text" class="form-input billing-step-input" placeholder="809-000-0000">
              </div>
              <div class="billing-step-field">
                <label>Dirección</label>
                <input id="billing-qc-direccion" type="text" class="form-input billing-step-input" placeholder="Dirección">
              </div>
            </div>
            <div class="billing-quick-client-actions">
              <button type="button" class="btn-secondary" onclick="toggleBillingQuickClient(false)">Cancelar</button>
              <button type="button" class="btn-primary" onclick="saveBillingQuickClient()">Guardar</button>
            </div>
          </div>
        </div>

        <!-- Tipo de comprobante + Botón descuento -->
        <div class="billing-v3-sh-right">
          <div class="billing-v3-tipo-wrap">
            <label class="billing-v3-sh-label">Tipo</label>
            <div class="billing-v3-doc-pills">
              ${mainDocs.map((doc) => `
                <button type="button" data-preset="${doc.key}"
                  class="billing-v3-doc-pill ${activePreset === doc.key ? 'is-active' : ''}"
                  onclick="setSaleDocumentPreset('${doc.key}')"
                  title="${doc.hint}"><span>${doc.label}</span></button>
              `).join('')}
              <select class="billing-v3-doc-pill billing-v3-doc-pill--select ${activeExtraDoc ? 'is-active' : ''}"
                onchange="setSaleDocumentPreset(this.value)" title="Otros comprobantes fiscales">
                <option value="" ${activeExtraDoc ? '' : 'selected'} disabled>Más ▾</option>
                ${extraDocs.map((doc) => `<option value="${doc.key}" ${activePreset === doc.key ? 'selected' : ''}>${doc.label}</option>`).join('')}
              </select>
            </div>
          </div>
          <button type="button" class="billing-v3-desc-btn" onclick="openBillingDiscountModal()" title="Descuento general (%)">
            %${discountVal > 0 ? ` <strong>${discountVal}%</strong>` : ' Desc.'}
          </button>
        </div>

        <!-- Tira NCF (visible solo cuando aplica) -->
        <div class="billing-v3-ncf-strip" id="billing-v3-ncf-strip">
          <span class="ncf-none-badge" id="ncf-none-badge">Sin NCF</span>
          <div class="ncf-extra-fields" id="ncf-rnc-fields" style="display:none">
            <input type="text" id="ncf-rnc-input" class="form-input billing-step-input" placeholder="RNC o cédula (opcional)" maxlength="11"
              oninput="DB.saleRncCliente=this.value.replace(/\\D/g,'').slice(0,11); updateSaleFiscalPreview()">
            <input type="text" id="ncf-razon-input" class="form-input billing-step-input" placeholder="Nombre o razón social"
              oninput="DB.saleRazonSocial=this.value; updateSaleFiscalPreview()">
          </div>
          <div class="ncf-extra-fields" id="ncf-ref-fields" style="display:none">
            <div class="ncf-ref-search-row">
              <input type="text" id="ncf-ref-input" class="form-input billing-step-input" placeholder="Buscar factura..." oninput="ncfSearchInvoices(this.value)">
              <span class="ncf-ref-clear" onclick="clearNcfRef()">✕</span>
            </div>
            <div class="ncf-ref-results" id="ncf-ref-results"></div>
            <div class="ncf-ref-selected" id="ncf-ref-selected" style="display:none">
              <span id="ncf-ref-selected-text"></span>
              <button type="button" class="ncf-ref-clear-btn" onclick="clearNcfRef()">✕</button>
            </div>
          </div>
          <div id="sale-fiscal-preview" class="sale-fiscal-preview"></div>
        </div>
      </div>

      <!-- ══ Tipo de pedido + datos de entrega ══ -->
      <div class="billing-v3-order-row">
        <div class="billing-v3-order-pills">
          <button type="button" class="billing-v3-order-pill ${orderType === 'mostrador' ? 'is-active' : ''}"
            onclick="setSaleOrderType('mostrador')">🏬 Mostrador</button>
          <button type="button" class="billing-v3-order-pill ${orderType === 'delivery' ? 'is-active' : ''}"
            onclick="setSaleOrderType('delivery')">🛵 Delivery</button>
          <button type="button" class="billing-v3-order-pill ${orderType === 'recoger' ? 'is-active' : ''}"
            onclick="setSaleOrderType('recoger')">🥡 Para llevar</button>
        </div>
        <div id="billing-delivery-fields" class="billing-v3-delivery-fields ${orderType === 'delivery' ? '' : 'hidden'}">
          <div class="billing-step-grid billing-step-grid-tight">
            <div class="billing-step-field">
              <label>Repartidor</label>
              <select id="sale-delivery-user" class="form-input billing-step-input" onchange="setSaleDeliveryUser(this.value)">
                ${buildDeliveryUserOptions()}
              </select>
            </div>
            <div class="billing-step-field">
              <label>Teléfono</label>
              <input type="text" id="sale-delivery-phone" class="form-input billing-step-input" placeholder="809-000-0000"
                value="${escapeHtml(DB.saleDeliveryPhone || '')}" oninput="setSaleDeliveryPhone(this.value)">
            </div>
            <div class="billing-step-field billing-step-field-wide">
              <label>Dirección</label>
              <input type="text" id="sale-delivery-address" class="form-input billing-step-input" placeholder="Calle, número, sector..."
                value="${escapeHtml(DB.saleDeliveryAddress || '')}" oninput="setSaleDeliveryAddress(this.value)">
            </div>
            <div class="billing-step-field billing-step-field-wide">
              <label>Referencia</label>
              <input type="text" id="sale-delivery-reference" class="form-input billing-step-input" placeholder="Punto de referencia (opcional)"
                value="${escapeHtml(DB.saleDeliveryReference || '')}" oninput="setSaleDeliveryReference(this.value)">
            </div>
          </div>
        </div>
      </div>

      <!-- ══ LAYOUT: 2 columnas ══ -->
      <div class="billing-v3-layout">

        <!-- ── COL 1: Lista de productos (44%) ── -->
        <section class="billing-v3-col billing-v3-products">
          <div class="billing-v3-col-head">
            <strong>Productos</strong>
            <span id="billing-items-count">${getSaleLineCountLabel(DB.saleItems, DB.saleItems.length)}</span>
          </div>
          <div id="billing-compact-lines" class="billing-v3-lines">
            ${buildBillingCompactSummaryRowsMarkup()}
          </div>
        </section>

        <!-- ── COL 2: Cobro (56%) ── -->
        <section class="billing-v3-col billing-v3-pay">

          <!-- Status pill (oculto, para compatibilidad) -->
          <div id="billing-v2-status-pill" class="billing-v2-status-pill billing-v2-status-pill--neutral" style="display:none">⏳</div>

          <!-- TOTAL — 52px -->
          <div class="billing-v3-total-block">
            <span class="billing-v3-total-label">TOTAL</span>
            <strong class="billing-v3-total-amount" id="billing-total">${fmt(total)}</strong>
            <div id="billing-total-empty" class="${hasProducts ? 'hidden' : ''} billing-v3-total-empty">🛒 Sin productos</div>
          </div>

          <!-- DOS botones COBRAR -->
          <div class="billing-v3-cobrar-group">
            <button id="billing-v2-cobrar-btn"
              class="billing-v3-cobrar-print"
              type="button"
              onclick="processSale('print')"
              title="ENTER · cobrar e imprimir">
              🖨 Cobrar e imprimir
            </button>
            <button id="billing-v3-cobrar-noprint"
              class="billing-v3-cobrar-noprint"
              type="button"
              onclick="processSale('charge')"
              title="cobrar sin imprimir">
              💾 Sin imprimir
            </button>
          </div>

          <!-- Indicador de modo F9 (qué hace ENTER) -->
          <div id="billing-v2-print-indicator"
            class="billing-v3-print-mode-badge${printMode ? '' : ' billing-v3-print-mode-badge--off'}">
            ${printMode ? '🖨 ENTER imprime · F9 para cambiar' : '💾 ENTER no imprime · F9 para activar'}
          </div>

          <!-- Métodos de pago -->
          <div class="billing-v3-methods">
            ${paymentMethodButtons.map((m) => `
              <button type="button"
                ${m.key === 'contra_entrega' ? 'id="pay-method-cod"' : ''}
                class="billing-v3-method-btn pay-method ${paymentMethod === m.key ? 'active' : ''}"
                onclick="setPayMethod('${m.key}', this)"
                title="${m.shortcut ? m.shortcut + ': ' : ''}${m.label}">
                <span class="billing-v3-method-icon">${m.icon}</span>
                <span class="billing-v3-method-label">${m.label}</span>
                ${m.shortcut ? `<span class="billing-v3-method-key">${m.shortcut}</span>` : ''}
              </button>
            `).join('')}
          </div>
          <div id="billing-compact-method-note" class="billing-compact-method-note ${paymentMethod === 'contra_entrega' ? '' : 'hidden'}">
            Contra entrega activo.
          </div>

          <!-- Área efectivo -->
          <div class="payment-amount-area" id="efectivo-area">
            <label class="billing-v3-recibido-label">Recibido</label>
            <input type="number" id="monto-recibido" placeholder="0.00"
              oninput="calcCambio()" class="billing-v3-amount-input" autocomplete="off">
            <div class="billing-v3-quick-row" id="quick-amounts">
              <button type="button" class="billing-v3-quick-btn billing-v3-quick-exact quick-amount-btn" id="quick-amount-exact" onclick="setMontoExacto(this)" title="Alt+E — Exacto">Exacto</button>
              <button type="button" class="billing-v3-quick-btn quick-amount-btn" onclick="setMontoRapido(100, this)" title="Alt+1 — Poner 100">100</button>
              <button type="button" class="billing-v3-quick-btn quick-amount-btn" onclick="setMontoRapido(200, this)" title="Alt+2 — Poner 200">200</button>
              <button type="button" class="billing-v3-quick-btn quick-amount-btn" onclick="setMontoRapido(500, this)" title="Alt+5 — Poner 500">500</button>
              <button type="button" class="billing-v3-quick-btn quick-amount-btn" onclick="setMontoRapido(1000, this)" title="Alt+0 — Poner 1,000">1,000</button>
              <button type="button" class="billing-v3-quick-btn quick-amount-btn" onclick="setMontoRapido(2000, this)" title="Alt+9 — Poner 2,000">2,000</button>
            </div>
            <!-- Tarjeta de cambio prominente -->
            <div class="billing-v3-cambio-card" id="billing-cambio-card">
              <div class="billing-cambio-card-top">
                <span class="billing-cambio-card-icon">💵</span>
                <span class="billing-cambio-card-label">DEVUELTA AL CLIENTE</span>
              </div>
              <strong id="cambio-val" class="billing-cambio-card-amount">RD$ 0.00</strong>
              <div id="billing-cambio-faltan" class="billing-cambio-card-faltan hidden"></div>
            </div>
          </div>

          <!-- Área tarjeta -->
          <div class="payment-amount-area billing-payment-form" id="tarjeta-area" style="display:none">
            <div class="billing-step-grid billing-step-grid-tight">
              <div class="billing-step-field"><label>Banco</label>
                <input type="text" class="form-input billing-step-input"
                  value="${escapeHtml(billingModalState.cardBank || '')}"
                  oninput="updateBillingPaymentDetail('cardBank', this.value)" placeholder="Banco">
              </div>
              <div class="billing-step-field"><label>Ref.</label>
                <input type="text" class="form-input billing-step-input"
                  value="${escapeHtml(billingModalState.cardReference || '')}"
                  oninput="updateBillingPaymentDetail('cardReference', this.value)" placeholder="Referencia">
              </div>
            </div>
            <select class="form-input billing-step-input" onchange="updateBillingPaymentDetail('cardType', this.value)">
              <option value="">Tipo de tarjeta</option>
              ${BILLING_CARD_TYPES.map((t) => `<option value="${t}" ${billingModalState.cardType === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
          </div>

          <!-- Área transferencia -->
          <div class="payment-amount-area billing-payment-form" id="transferencia-area" style="display:none">
            <div class="billing-step-grid billing-step-grid-tight">
              <div class="billing-step-field"><label>Banco</label>
                <input type="text" class="form-input billing-step-input"
                  value="${escapeHtml(billingModalState.transferBank || '')}"
                  oninput="updateBillingPaymentDetail('transferBank', this.value)" placeholder="Banco">
              </div>
              <div class="billing-step-field"><label>Ref.</label>
                <input type="text" class="form-input billing-step-input"
                  value="${escapeHtml(billingModalState.transferReference || '')}"
                  oninput="updateBillingPaymentDetail('transferReference', this.value)" placeholder="Referencia">
              </div>
            </div>
          </div>

          <!-- Área mixto -->
          <div class="payment-amount-area pay-mixto-area" id="mixto-area" style="display:none">
            <div class="mixto-inputs mixto-inputs-3">
              <div class="mixto-field"><span class="mixto-field-label">💵 Efectivo</span>
                <input type="number" id="mixto-efectivo" class="amount-input" placeholder="0.00" min="0" step="0.01"
                  value="${escapeHtml(String(billingModalState.mixedCashAmount || ''))}" oninput="calcMixto()"></div>
              <div class="mixto-field"><span class="mixto-field-label">💳 Tarjeta</span>
                <input type="number" id="mixto-tarjeta" class="amount-input" placeholder="0.00" min="0" step="0.01"
                  value="${escapeHtml(String(billingModalState.mixedCardAmount || ''))}" oninput="calcMixto()"></div>
              <div class="mixto-field"><span class="mixto-field-label">🏦 Transf.</span>
                <input type="number" id="mixto-transferencia" class="amount-input" placeholder="0.00" min="0" step="0.01"
                  value="${escapeHtml(String(billingModalState.mixedTransferAmount || ''))}" oninput="calcMixto()"></div>
            </div>
            <div class="mixto-status" id="mixto-status">
              <span class="mixto-status-label">Pendiente:</span>
              <span class="mixto-status-val" id="mixto-pendiente">RD$ 0.00</span>
            </div>
            <div class="cambio-display" id="mixto-cambio-row" style="display:none">
              <span class="cambio-label">Cambio:</span>
              <span id="mixto-cambio-val" class="cambio-amount">RD$ 0.00</span>
            </div>
          </div>

          <!-- Área crédito -->
          <div class="payment-amount-area billing-payment-form" id="credito-area" style="display:none">
            <div class="billing-step-grid billing-step-grid-tight">
              <div class="billing-step-field"><label>Vence</label>
                <input type="date" class="form-input billing-step-input"
                  value="${escapeHtml(billingModalState.creditDueDate || '')}"
                  oninput="updateBillingPaymentDetail('creditDueDate', this.value)">
              </div>
              <div class="billing-step-field"><label>Límite</label>
                <input type="text" class="form-input billing-step-input" readonly
                  value="${selectedClient ? fmt(Math.max(0, Number(selectedClient.limiteCredito || 0))) : '—'}">
              </div>
            </div>
            <textarea class="form-input billing-step-input" rows="2" placeholder="Notas del crédito..."
              oninput="updateBillingPaymentDetail('creditNotes', this.value)">${escapeHtml(billingModalState.creditNotes || '')}</textarea>
          </div>

          <!-- Contra entrega -->
          <div class="payment-amount-area" id="contra-entrega-area" style="display:none">
            <div class="sale-fiscal-ok">Pendiente hasta que el delivery entregue el dinero.</div>
            <label class="billing-v3-recibido-label">¿Con cuánto pagará el cliente?</label>
            <input type="number" id="monto-recibido-contra-entrega" placeholder="0.00"
              value="${escapeHtml(String(DB.saleDeliveryPayAmount || ''))}"
              oninput="setSaleDeliveryPayAmount(this.value)" class="billing-v3-amount-input" autocomplete="off" step="0.01" min="0">
            <div class="billing-v3-quick-row">
              <button type="button" class="billing-v3-quick-btn billing-v3-quick-exact" onclick="setMontoExactoContraEntrega(this)" title="Cliente paga el monto exacto">Exacto</button>
              <button type="button" class="billing-v3-quick-btn" onclick="setMontoRapidoContraEntrega(100, this)">100</button>
              <button type="button" class="billing-v3-quick-btn" onclick="setMontoRapidoContraEntrega(200, this)">200</button>
              <button type="button" class="billing-v3-quick-btn" onclick="setMontoRapidoContraEntrega(500, this)">500</button>
              <button type="button" class="billing-v3-quick-btn" onclick="setMontoRapidoContraEntrega(1000, this)">1,000</button>
              <button type="button" class="billing-v3-quick-btn" onclick="setMontoRapidoContraEntrega(2000, this)">2,000</button>
            </div>
            <div class="billing-v3-cambio-card" id="billing-cambio-card-contra-entrega">
              <div class="billing-cambio-card-top">
                <span class="billing-cambio-card-icon">🛵</span>
                <span class="billing-cambio-card-label">CAMBIO A LLEVAR POR EL REPARTIDOR</span>
              </div>
              <strong id="cambio-val-contra-entrega" class="billing-cambio-card-amount">RD$ 0.00</strong>
              <div id="billing-cambio-faltan-contra-entrega" class="billing-cambio-card-faltan hidden"></div>
            </div>
          </div>

          <!-- Área dólares (USD) -->
          <div class="payment-amount-area" id="usd-area" style="display:none">
            <div class="billing-usd-equiv-row">
              <span class="billing-usd-equiv-label">Equivalente a cobrar</span>
              <strong id="billing-usd-equiv-val" class="billing-usd-equiv-amount">US$ 0.00</strong>
              <span class="billing-usd-equiv-rate" id="billing-usd-rate-label"></span>
            </div>
            <label class="billing-v3-recibido-label">Recibido (US$)</label>
            <input type="number" id="monto-recibido-usd" placeholder="0.00"
              oninput="calcCambioUsd()" class="billing-v3-amount-input" autocomplete="off" step="0.01" min="0">
            <!-- Tarjeta de cambio propia — NO reutilizar #cambio-val/#billing-cambio-card,
                 anidados dentro de #efectivo-area y quedarían ocultos con método 'usd'. -->
            <div class="billing-v3-cambio-card" id="billing-cambio-card-usd">
              <div class="billing-cambio-card-top">
                <span class="billing-cambio-card-icon">💵</span>
                <span class="billing-cambio-card-label">DEVUELTA AL CLIENTE (RD$)</span>
              </div>
              <strong id="cambio-val-usd" class="billing-cambio-card-amount">RD$ 0.00</strong>
              <div id="billing-cambio-faltan-usd" class="billing-cambio-card-faltan hidden"></div>
            </div>
          </div>

          <!-- ── Elementos ocultos para compatibilidad ── -->
          <span id="billing-subtotal" style="display:none">RD$ 0.00</span>
          <div id="billing-subtotal-gravado-row" style="display:none"><strong id="billing-subtotal-gravado">RD$ 0.00</strong></div>
          <div id="billing-subtotal-exento-row" style="display:none"><strong id="billing-subtotal-exento">RD$ 0.00</strong></div>
          <strong id="billing-descuento" style="display:none">-RD$ 0.00</strong>
          <strong id="billing-itbis" style="display:none">RD$ 0.00</strong>
          <select id="sale-doc-type" style="display:none" onchange="setSaleDocumentType(this.value)">
            <option value="ticket">Ticket / Factura</option>
            <option value="factura-electronica">Factura Electrónica</option>
          </select>
          <select id="sale-order-type" style="display:none" onchange="setSaleOrderType(this.value)">
            <option value="mostrador" ${String(DB.saleOrderType || 'mostrador') === 'mostrador' ? 'selected' : ''}>Mostrador</option>
            <option value="delivery"  ${String(DB.saleOrderType || '') === 'delivery'  ? 'selected' : ''}>Delivery</option>
            <option value="recoger"   ${String(DB.saleOrderType || '') === 'recoger'   ? 'selected' : ''}>Para llevar</option>
          </select>
          <select id="sale-kitchen-status" style="display:none" onchange="setSaleKitchenStatus(this.value)"></select>
          <input type="text" id="sale-table-label" style="display:none"
            value="${escapeHtml(DB.saleTableLabel || '')}" oninput="setSaleTableLabel(this.value)">
          <textarea id="sale-order-notes" style="display:none"
            oninput="setSaleOrderNotes(this.value)">${escapeHtml(DB.saleOrderNotes || '')}</textarea>
          <div id="billing-client-snapshot" style="display:none"></div>
          <button id="billing-v2-mode-print" style="display:none" onclick="setBillingPrintMode(true)"></button>
          <button id="billing-v2-mode-noprint" style="display:none" onclick="setBillingPrintMode(false)"></button>
          <div id="billing-compact-status" style="display:none"></div>
        </section>
      </div>

      <!-- Guardia de descarte -->
      <div id="billing-discard-guard" class="billing-discard-guard hidden">
        <div class="billing-discard-card">
          <strong>¿Salir sin guardar?</strong>
          <span>Se descartará la información del cobro actual.</span>
          <div class="billing-discard-actions">
            <button type="button" class="btn-secondary" onclick="hideBillingDiscardPrompt()">Seguir</button>
            <button type="button" class="btn-danger" onclick="confirmBillingDiscard()">Salir</button>
          </div>
        </div>
      </div>

      <!-- Modal flotante de descuento -->
      <div id="billing-v3-discount-modal" class="billing-v3-discount-overlay hidden">
        <div class="billing-v3-discount-card">
          <strong>Descuento general</strong>
          <div class="billing-v3-discount-body">
            <input type="number" id="desc-general" class="billing-v3-discount-input"
              min="0" max="100" placeholder="0"
              value="${discountVal}"
              oninput="applyGeneralDiscount(); _syncBillingV3DiscountBtn()">
            <span class="billing-v3-discount-pct-label">%</span>
          </div>
          <div class="billing-v3-discount-actions">
            <button type="button" class="btn-secondary" onclick="closeBillingDiscountModal()">Cerrar</button>
            <button type="button" class="btn-primary" onclick="closeBillingDiscountModal()">Aplicar</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ─── LEGACY: layout de dos paneles (ya no se usa como modal principal) ─────────
function _buildBillingCompactModalMarkup_legacy() {
  const total = parseFmt(document.getElementById('s-total')?.textContent || fmt(0));
  const selectedClient = getSelectedSaleClient();
  const rememberLastClient = getBillingRememberLastClientEnabled();
  const activeClientId = DB.saleClientId ? String(DB.saleClientId) : '';
  const activePreset = getBillingActiveDocumentPreset();
  const paymentMethod = DB.payMethod || 'efectivo';
  const mainDocs = [
    { key: 'ticket', label: 'Ticket', hint: 'Rápido' },
    { key: 'B02', label: 'B02', hint: 'Consumidor final' },
    { key: 'B01', label: 'B01', hint: 'Crédito fiscal' },
    { key: 'factura-electronica', label: 'e-CF', hint: 'Electrónica' }
  ];
  const extraDocs = [
    { key: 'B03', label: 'B03 Nota Débito' },
    { key: 'B04', label: 'B04 Nota Crédito' },
    { key: 'B14', label: 'B14 Especial' },
    { key: 'B15', label: 'B15 Gubernamental' }
  ];

  return `
    <div class="billing-compact-shell">
      <div class="billing-compact-layout">
        <section class="billing-compact-left">
          <div class="billing-compact-head">
            <strong>Resumen de venta</strong>
            <span>${getSaleLineCountLabel(DB.saleItems, DB.saleItems.length)}</span>
          </div>
          <div class="billing-compact-table-head">
            <span>Producto</span>
            <span>Cant.</span>
            <span>Precio</span>
            <span>Desc.</span>
            <span>ITBIS</span>
            <span>Subtotal</span>
          </div>
          <div id="billing-compact-lines" class="billing-compact-lines">
            ${buildBillingCompactSummaryRowsMarkup()}
          </div>
          <div class="billing-compact-totals">
            <div class="billing-sale-summary-lines">
              <div class="billing-sale-line">
                <span>Subtotal</span>
                <strong id="billing-subtotal">RD$ 0.00</strong>
              </div>
              <div class="billing-sale-line" id="billing-subtotal-gravado-row" style="display:none">
                <span>Subtotal gravado</span>
                <strong id="billing-subtotal-gravado">RD$ 0.00</strong>
              </div>
              <div class="billing-sale-line" id="billing-subtotal-exento-row" style="display:none">
                <span>Subtotal exento</span>
                <strong id="billing-subtotal-exento">RD$ 0.00</strong>
              </div>
              <div class="billing-sale-line">
                <span>Descuento</span>
                <strong id="billing-descuento">- RD$ 0.00</strong>
              </div>
              <div class="billing-sale-line">
                <span>ITBIS</span>
                <strong id="billing-itbis">RD$ 0.00</strong>
              </div>
            </div>
            <div class="billing-compact-total-box">
              <span>Total</span>
              <strong id="billing-total">${fmt(total)}</strong>
            </div>
            <div id="billing-total-empty" class="billing-total-empty ${Array.isArray(DB.saleItems) && DB.saleItems.length && total > 0 ? 'hidden' : ''}">
              No existen productos para cobrar.
            </div>
          </div>
        </section>

        <section class="billing-compact-right">
          <div class="billing-compact-head">
            <strong>Cobro rápido</strong>
            <span>Escanear, cobrar e imprimir sin pasos extra.</span>
          </div>

          <div class="billing-compact-field">
            <label>Cliente</label>
            <div class="billing-compact-field-row">
              <select id="sale-client-select" class="form-input billing-step-input" onchange="setSaleClient(this.value)">
                <option value="">${getBillingClientOptionLabel()}</option>
                ${DB.clientes
                  .slice()
                  .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
                  .map((client) => `<option value="${client.id}" ${activeClientId === String(client.id) ? 'selected' : ''}>${client.nombre}${client.cedula ? ` · ${client.cedula}` : ''}</option>`)
                  .join('')}
              </select>
              <button class="btn-secondary billing-compact-mini-btn" type="button" onclick="toggleBillingQuickClient()">+ Cliente rápido</button>
            </div>
            <label class="billing-inline-check">
              <input type="checkbox" id="billing-remember-client" ${rememberLastClient ? 'checked' : ''} onchange="toggleBillingRememberLastClient(this.checked)">
              <span>Mantener último cliente seleccionado</span>
            </label>
            <div id="billing-quick-client" class="billing-quick-client hidden">
              <div class="billing-step-grid billing-step-grid-tight">
                <div class="billing-step-field">
                  <label>Nombre</label>
                  <input id="billing-qc-nombre" type="text" class="form-input billing-step-input" placeholder="Nombre completo">
                </div>
                <div class="billing-step-field">
                  <label>Cédula</label>
                  <input id="billing-qc-cedula" type="text" class="form-input billing-step-input" placeholder="Documento">
                </div>
                <div class="billing-step-field">
                  <label>RNC</label>
                  <input id="billing-qc-rnc" type="text" class="form-input billing-step-input" placeholder="RNC">
                </div>
                <div class="billing-step-field">
                  <label>Teléfono</label>
                  <input id="billing-qc-telefono" type="text" class="form-input billing-step-input" placeholder="809-000-0000">
                </div>
                <div class="billing-step-field">
                  <label>WhatsApp</label>
                  <input id="billing-qc-whatsapp" type="text" class="form-input billing-step-input" placeholder="809-000-0000">
                </div>
                <div class="billing-step-field">
                  <label>Dirección</label>
                  <input id="billing-qc-direccion" type="text" class="form-input billing-step-input" placeholder="Dirección">
                </div>
                <div class="billing-step-field">
                  <label>Referencia</label>
                  <input id="billing-qc-referencia" type="text" class="form-input billing-step-input" placeholder="Referencia">
                </div>
                <div class="billing-step-field">
                  <label>Ubicación</label>
                  <input id="billing-qc-ubicacion" type="text" class="form-input billing-step-input" placeholder="https://maps.google.com/...">
                </div>
              </div>
              <div class="billing-quick-client-actions">
                <button type="button" class="btn-secondary" onclick="toggleBillingQuickClient(false)">Cancelar</button>
                <button type="button" class="btn-primary" onclick="saveBillingQuickClient()">Guardar cliente</button>
              </div>
            </div>
            <div id="billing-client-snapshot">${buildSelectedClientSnapshotMarkup()}</div>
          </div>

          <div class="billing-compact-field">
            <label>Comprobante</label>
            <div class="billing-compact-pill-grid">
              ${mainDocs.map((doc) => `
                <button type="button" class="billing-compact-pill ${activePreset === doc.key ? 'is-active' : ''}" onclick="setSaleDocumentPreset('${doc.key}')">
                  <strong>${doc.label}</strong>
                  <span>${doc.hint}</span>
                </button>
              `).join('')}
            </div>
            <details class="billing-compact-more">
              <summary>Más opciones</summary>
              <div class="billing-compact-more-body">
                <div class="billing-compact-extra-docs">
                  ${extraDocs.map((doc) => `
                    <button type="button" class="billing-compact-chip ${activePreset === doc.key ? 'is-active' : ''}" onclick="setSaleDocumentPreset('${doc.key}')">${doc.label}</button>
                  `).join('')}
                </div>
                <div class="billing-compact-extra-docs">
                  <button type="button" id="billing-cod-option" class="billing-compact-chip ${paymentMethod === 'contra_entrega' ? 'is-active' : ''}" onclick="setPayMethod('contra_entrega', this)">Contra entrega</button>
                </div>
                <div class="billing-step-grid billing-step-grid-tight">
                  <div class="billing-step-field">
                    <label>Tipo de pedido</label>
                    <select id="sale-order-type" class="form-input billing-step-input" onchange="setSaleOrderType(this.value)">
                      <option value="mostrador" ${String(DB.saleOrderType || 'mostrador') === 'mostrador' ? 'selected' : ''}>Mostrador</option>
                      <option value="delivery" ${String(DB.saleOrderType || '') === 'delivery' ? 'selected' : ''}>Envío</option>
                      <option value="recoger" ${String(DB.saleOrderType || '') === 'recoger' ? 'selected' : ''}>Para llevar</option>
                    </select>
                  </div>
                  <div class="billing-step-field">
                    <label>Estado de cocina</label>
                    <select id="sale-kitchen-status" class="form-input billing-step-input" onchange="setSaleKitchenStatus(this.value)">
                      ${buildOptionMarkup(getKitchenStatusOptions(), DB.saleKitchenStatus || 'pendiente')}
                    </select>
                  </div>
                </div>
                <div class="billing-step-grid billing-step-grid-tight">
                  <div class="billing-step-field">
                    <label>Delivery / Contra entrega</label>
                    <select id="sale-delivery-user" class="form-input billing-step-input" onchange="setSaleDeliveryUser(this.value)">
                      ${buildDeliveryUserOptions()}
                    </select>
                  </div>
                  <div class="billing-step-field">
                    <label>Dirección delivery</label>
                    <input id="sale-delivery-address" type="text" class="form-input billing-step-input" value="${escapeHtml(DB.saleDeliveryAddress || '')}" oninput="setSaleDeliveryAddress(this.value)">
                  </div>
                </div>
                <div class="billing-step-grid billing-step-grid-tight">
                  <div class="billing-step-field">
                    <label>Teléfono delivery</label>
                    <input id="sale-delivery-phone" type="text" class="form-input billing-step-input" value="${escapeHtml(DB.saleDeliveryPhone || '')}" oninput="setSaleDeliveryPhone(this.value)">
                  </div>
                  <div class="billing-step-field">
                    <label>Referencia</label>
                    <input id="sale-delivery-reference" type="text" class="form-input billing-step-input" value="${escapeHtml(DB.saleDeliveryReference || '')}" oninput="setSaleDeliveryReference(this.value)">
                  </div>
                </div>
                <div class="billing-step-field">
                  <label>Notas</label>
                  <textarea id="sale-order-notes" class="form-input billing-step-input" rows="2" placeholder="Notas opcionales" oninput="setSaleOrderNotes(this.value)">${escapeHtml(DB.saleOrderNotes || '')}</textarea>
                </div>
              </div>
            </details>

            <div class="billing-step-section billing-step-section-ncf">
              <div class="billing-step-section-title">Datos fiscales</div>
              <span class="ncf-none-badge" id="ncf-none-badge">Sin NCF</span>
              <div class="ncf-extra-fields" id="ncf-rnc-fields" style="display:none">
                <input type="text" id="ncf-rnc-input" class="form-input billing-step-input" placeholder="RNC o cédula (opcional, autocompleta nombre)" maxlength="11" oninput="DB.saleRncCliente=this.value.replace(/\\D/g,'').slice(0,11); updateSaleFiscalPreview()">
                <input type="text" id="ncf-razon-input" class="form-input billing-step-input" placeholder="Nombre o razón social" oninput="DB.saleRazonSocial=this.value; updateSaleFiscalPreview()">
              </div>
              <div class="ncf-extra-fields" id="ncf-ref-fields" style="display:none">
                <div class="ncf-ref-search-row">
                  <input type="text" id="ncf-ref-input" class="form-input billing-step-input" placeholder="Buscar factura original..." oninput="ncfSearchInvoices(this.value)">
                  <span class="ncf-ref-clear" onclick="clearNcfRef()" title="Limpiar">✕</span>
                </div>
                <div class="ncf-ref-results" id="ncf-ref-results"></div>
                <div class="ncf-ref-selected" id="ncf-ref-selected" style="display:none">
                  <span id="ncf-ref-selected-text"></span>
                  <button type="button" class="ncf-ref-clear-btn" onclick="clearNcfRef()">✕</button>
                </div>
              </div>
            </div>
            <div id="sale-fiscal-preview" class="sale-fiscal-preview"></div>
          </div>

          <div class="billing-compact-field">
            <label>Método de pago</label>
            <div class="payment-methods payment-methods-modern billing-compact-methods">
              ${[
                { key: 'efectivo', icon: '💵', label: 'Efectivo', hint: 'Cambio' },
                { key: 'tarjeta', icon: '💳', label: 'Tarjeta', hint: 'POS' },
                { key: 'transferencia', icon: '🏦', label: 'Transferencia', hint: 'Banco' },
                { key: 'mixto', icon: '💵💳', label: 'Mixto', hint: 'Combinado' },
                { key: 'credito', icon: '📄', label: 'Crédito', hint: 'Cobro luego' }
              ].map((method) => `
                <button type="button" class="pay-method ${paymentMethod === method.key ? 'active' : ''}" onclick="setPayMethod('${method.key}', this)">
                  <span class="pay-method-icon">${method.icon}</span>
                  <span class="pay-method-label">${method.label}</span>
                  <span class="pay-method-hint">${method.hint}</span>
                </button>
              `).join('')}
            </div>
            <div id="billing-compact-method-note" class="billing-compact-method-note ${paymentMethod === 'contra_entrega' ? '' : 'hidden'}">
              Contra entrega está activo desde Más opciones.
            </div>
          </div>

          <div class="billing-compact-field">
            <label>Monto recibido</label>
            <div class="payment-amount-area" id="efectivo-area">
              <input type="number" id="monto-recibido" placeholder="0.00" oninput="calcCambio()" class="amount-input billing-step-input">
              <div class="cambio-display">
                <span class="cambio-label">Cambio:</span>
                <span id="cambio-val" class="cambio-amount">RD$ 0.00</span>
              </div>
              <div class="quick-amounts" id="quick-amounts">
                <button type="button" class="quick-amount-btn quick-amount-btn-exact" id="quick-amount-exact" onclick="setMontoExacto(this)">Exacto</button>
                <button type="button" class="quick-amount-btn" onclick="setMontoRapido(100, this)">100</button>
                <button type="button" class="quick-amount-btn" onclick="setMontoRapido(200, this)">200</button>
                <button type="button" class="quick-amount-btn" onclick="setMontoRapido(500, this)">500</button>
                <button type="button" class="quick-amount-btn" onclick="setMontoRapido(1000, this)">1000</button>
                <button type="button" class="quick-amount-btn" onclick="setMontoRapido(2000, this)">2000</button>
              </div>
            </div>

            <div class="payment-amount-area billing-payment-form" id="tarjeta-area" style="display:none">
              <div class="billing-step-grid billing-step-grid-tight">
                <div class="billing-step-field">
                  <label>Banco</label>
                  <input type="text" class="form-input billing-step-input" value="${escapeHtml(billingModalState.cardBank || '')}" oninput="updateBillingPaymentDetail('cardBank', this.value)" placeholder="Banco">
                </div>
                <div class="billing-step-field">
                  <label>Referencia</label>
                  <input type="text" class="form-input billing-step-input" value="${escapeHtml(billingModalState.cardReference || '')}" oninput="updateBillingPaymentDetail('cardReference', this.value)" placeholder="Referencia">
                </div>
              </div>
              <div class="billing-step-field">
                <label>Tipo</label>
                <select class="form-input billing-step-input" onchange="updateBillingPaymentDetail('cardType', this.value)">
                  <option value="">Selecciona un tipo</option>
                  ${BILLING_CARD_TYPES.map((item) => `<option value="${item}" ${billingModalState.cardType === item ? 'selected' : ''}>${item}</option>`).join('')}
                </select>
              </div>
            </div>

            <div class="payment-amount-area billing-payment-form" id="transferencia-area" style="display:none">
              <div class="billing-step-grid billing-step-grid-tight">
                <div class="billing-step-field">
                  <label>Banco</label>
                  <input type="text" class="form-input billing-step-input" value="${escapeHtml(billingModalState.transferBank || '')}" oninput="updateBillingPaymentDetail('transferBank', this.value)" placeholder="Banco">
                </div>
                <div class="billing-step-field">
                  <label>Referencia</label>
                  <input type="text" class="form-input billing-step-input" value="${escapeHtml(billingModalState.transferReference || '')}" oninput="updateBillingPaymentDetail('transferReference', this.value)" placeholder="Referencia">
                </div>
              </div>
            </div>

            <div class="payment-amount-area pay-mixto-area" id="mixto-area" style="display:none">
              <div class="mixto-inputs mixto-inputs-3">
                <div class="mixto-field">
                  <span class="mixto-field-label">💵 Efectivo</span>
                  <input type="number" id="mixto-efectivo" class="amount-input" placeholder="0.00" min="0" step="0.01" value="${escapeHtml(String(billingModalState.mixedCashAmount || ''))}" oninput="calcMixto()">
                </div>
                <div class="mixto-field">
                  <span class="mixto-field-label">💳 Tarjeta</span>
                  <input type="number" id="mixto-tarjeta" class="amount-input" placeholder="0.00" min="0" step="0.01" value="${escapeHtml(String(billingModalState.mixedCardAmount || ''))}" oninput="calcMixto()">
                </div>
                <div class="mixto-field">
                  <span class="mixto-field-label">🏦 Transferencia</span>
                  <input type="number" id="mixto-transferencia" class="amount-input" placeholder="0.00" min="0" step="0.01" value="${escapeHtml(String(billingModalState.mixedTransferAmount || ''))}" oninput="calcMixto()">
                </div>
              </div>
              <div class="mixto-status" id="mixto-status">
                <span class="mixto-status-label">Pendiente:</span>
                <span class="mixto-status-val" id="mixto-pendiente">RD$ 0.00</span>
              </div>
              <div class="cambio-display" id="mixto-cambio-row" style="display:none">
                <span class="cambio-label">Cambio:</span>
                <span id="mixto-cambio-val" class="cambio-amount">RD$ 0.00</span>
              </div>
            </div>

            <div class="payment-amount-area billing-payment-form" id="credito-area" style="display:none">
              <div class="billing-step-grid billing-step-grid-tight">
                <div class="billing-step-field">
                  <label>Fecha vencimiento</label>
                  <input type="date" class="form-input billing-step-input" value="${escapeHtml(billingModalState.creditDueDate || '')}" oninput="updateBillingPaymentDetail('creditDueDate', this.value)">
                </div>
                <div class="billing-step-field">
                  <label>Límite crédito</label>
                  <input type="text" class="form-input billing-step-input" readonly value="${selectedClient ? fmt(Math.max(0, Number(selectedClient.limiteCredito || 0))) : 'Selecciona un cliente'}">
                </div>
              </div>
              <div class="billing-step-field">
                <label>Notas</label>
                <textarea class="form-input billing-step-input" rows="2" placeholder="Observaciones del crédito" oninput="updateBillingPaymentDetail('creditNotes', this.value)">${escapeHtml(billingModalState.creditNotes || '')}</textarea>
              </div>
            </div>
          </div>

          <div id="billing-compact-status" class="billing-compact-status"></div>
        </section>
      </div>

      <div id="billing-discard-guard" class="billing-discard-guard hidden">
        <div class="billing-discard-card">
          <strong>Tienes información pendiente</strong>
          <span>Si sales ahora, se descartará la información del cobro actual.</span>
          <div class="billing-discard-actions">
            <button type="button" class="btn-secondary" onclick="hideBillingDiscardPrompt()">Seguir editando</button>
            <button type="button" class="btn-danger" onclick="confirmBillingDiscard()">Salir y descartar</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// Tipos de comprobante NCF (serie B) con secuencia activa y números
// disponibles, según el registro manual de Configuración → Comprobantes
// fiscales (server/routes/fiscal-sequences.routes.js). null = todavía no se
// consultó esta sesión de facturación (no bloquea, solo no colorea aún).
let _availableNcfDocTypes = null;
// Próximo número real de cada tipo NCF activo (solo para previsualizar en el
// título del modal — ver getDocumentSequencePreview) — el número final que de
// verdad se asigna lo decide el servidor al cobrar, así que este puede quedar
// desactualizado si otra caja vende primero. Igual es mejor que mostrar puntos.
let _availableNcfNextNumbers = null;

async function refreshAvailableNcfDocTypes() {
  try {
    const branchId = DB.currentUser?.sucursalId || DB.config?.activeBranchId || '';
    const res = await fetch(`/api/fiscal-sequences/available${branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''}`, {
      headers: { Authorization: `Bearer ${DB.authToken || ''}` }
    });
    if (!res.ok) return;
    const rows = await res.json();
    _availableNcfDocTypes = new Set((rows || []).map((r) => String(r.documentType || '').toUpperCase()));
    _availableNcfNextNumbers = new Map((rows || [])
      .filter((r) => r.nextNumber !== undefined && r.nextNumber !== null)
      .map((r) => [String(r.documentType || '').toUpperCase(), Number(r.nextNumber)]));
    _applyAvailableNcfDocTypesToPills();
    if (typeof syncBillingModalHeader === 'function') syncBillingModalHeader();
  } catch (_) { /* si falla, no se bloquea la venta — solo se sigue mostrando el placeholder */ }
}

// Solo aplica a los presets que son un tipo NCF real (B01/B02/...) — ticket
// y factura-electronica no dependen de fiscal_sequences.
function _applyAvailableNcfDocTypesToPills() {
  if (!_availableNcfDocTypes) return;
  document.querySelectorAll('.billing-v3-doc-pill[data-preset]').forEach((btn) => {
    const preset = String(btn.dataset.preset || '').toUpperCase();
    if (!/^B\d{2}$/.test(preset)) return;
    const available = _availableNcfDocTypes.has(preset);
    btn.classList.toggle('is-unavailable', !available);
    btn.title = available ? btn.title : 'Sin secuencia activa para este comprobante — regístrala en Configuración → Comprobantes fiscales.';
  });
}

function setSaleDocumentPreset(preset) {
  const normalized = String(preset || 'ticket').trim();
  if (normalized === 'factura-electronica') {
    DB.saleDocumentType = 'factura-electronica';
    setSaleNcfType('');
  } else if (normalized === 'ticket') {
    DB.saleDocumentType = 'ticket';
    setSaleNcfType('');
  } else {
    const upper = normalized.toUpperCase();
    if (_availableNcfDocTypes && /^B\d{2}$/.test(upper) && !_availableNcfDocTypes.has(upper)) {
      showToast(`No existen secuencias disponibles para ${upper}. Regístrala en Configuración → Comprobantes fiscales.`, 'warning');
      return;
    }
    DB.saleDocumentType = 'ticket';
    setSaleNcfType(upper);
  }
  syncSaleFiscalControls();
}

function cycleBillingPaymentMethod() {
  const methods = ['efectivo', 'tarjeta', 'transferencia', 'mixto', 'credito'];
  const current = methods.indexOf(DB.payMethod || 'efectivo');
  const next = methods[(current + 1) % methods.length];
  const nextButton = Array.from(document.querySelectorAll('.pay-method')).find((button) => button.getAttribute('onclick')?.includes(`'${next}'`));
  if (nextButton) setPayMethod(next, nextButton);
}

function cycleBillingDocumentPreset() {
  const presets = ['ticket', 'B02', 'B01', 'factura-electronica'];
  const current = presets.indexOf(getBillingActiveDocumentPreset());
  const next = presets[(current + 1) % presets.length];
  setSaleDocumentPreset(next);
}

function focusBillingClientSelect() {
  const select = document.getElementById('sale-client-select');
  if (select) {
    select.focus();
    select.click?.();
  }
}

function buildBillingStepLabel(step) {
  return {
    order: 'Datos del pedido',
    client: 'Cliente y comprobante',
    payment: 'Cobro y pago',
    confirm: 'Confirmación'
  }[step] || 'Cobro';
}

function buildBillingValidationBuckets() {
  const total = parseFmt(document.getElementById('s-total')?.textContent || fmt(0));
  const client = getSelectedSaleClient();
  const paymentMethod = DB.payMethod || 'efectivo';
  const documentType = DB.saleDocumentType || 'ticket';
  const orderType = normalizeBillingOrderType(DB.saleOrderType || 'mostrador');
  const ncfType = String(DB.saleNcfType || '').trim().toUpperCase();
  const rnc = String(DB.saleRncCliente || client?.rnc || client?.cedula || '').replace(/\D/g, '').trim();
  const cashReceived = Number(parseFloat(document.getElementById('monto-recibido')?.value) || 0);
  const mixedCash = Number(parseFloat(document.getElementById('mixto-efectivo')?.value) || 0);
  const mixedCard = Number(parseFloat(document.getElementById('mixto-tarjeta')?.value) || 0);
  const mixedTransfer = Number(parseFloat(document.getElementById('mixto-transferencia')?.value) || 0);
  const mixedTotal = mixedCash + mixedCard + mixedTransfer;
  const buckets = {
    order: [],
    client: [],
    payment: [],
    confirm: []
  };

  if (!Array.isArray(DB.saleItems) || !DB.saleItems.length) {
    buckets.order.push('No existen productos para cobrar.');
  }
  if (!(total > 0)) {
    buckets.order.push('El total debe ser mayor a RD$ 0.00.');
  }

  if (documentType === 'factura-electronica') {
    const buyerRnc = (DB.saleRncCliente || '').trim() || String(client?.rnc || '').trim();
    if (buyerRnc && !(buyerRnc.length === 9 || buyerRnc.length === 11)) {
      buckets.client.push('El RNC para emitir e-CF debe tener 9 u 11 dígitos.');
    }
  }
  if (ncfType === 'B01') {
    // B01 solo exige un RNC válido — no un cliente registrado en el sistema.
    // Un "cliente rápido" (RNC/cédula escrito a mano, sin guardarlo antes en
    // Clientes) es un caso legítimo, igual que ya lo permite el servidor.
    if (!(rnc.length === 9 || rnc.length === 11)) {
      buckets.client.push('B01 requiere un RNC válido (9 u 11 dígitos).');
    }
  }
  if (['B14', 'B15'].includes(ncfType) && !client) {
    buckets.client.push(`${ncfType} requiere un cliente registrado.`);
  }
  if (['B03', 'B04'].includes(ncfType) && !DB.saleNcfReferencia) {
    buckets.client.push(`${ncfType} requiere seleccionar una factura anterior.`);
  }

  if (paymentMethod === 'efectivo' && cashReceived < total) {
    buckets.payment.push('El monto recibido en efectivo es insuficiente.');
  }
  if (paymentMethod === 'mixto') {
    if (mixedTotal <= 0) buckets.payment.push('Ingresa montos para el pago mixto.');
    if (mixedTotal < total) buckets.payment.push('La suma del pago mixto no cubre el total.');
  }
  if (paymentMethod === 'credito') {
    if (!client) buckets.payment.push('El crédito requiere un cliente seleccionado.');
    if (!billingModalState.creditDueDate) buckets.payment.push('Define una fecha de vencimiento para el crédito.');
  }
  if (paymentMethod === 'contra_entrega') {
    if (orderType !== 'delivery') buckets.payment.push('Contra entrega solo aplica a pedidos de envío.');
    if (!DB.saleDeliveryUserId) buckets.payment.push('Debes asignar un delivery.');
    if (!String(DB.saleDeliveryAddress || '').trim()) buckets.payment.push('La dirección de entrega es obligatoria.');
    if (!String(DB.saleDeliveryPhone || '').trim()) buckets.payment.push('El teléfono de entrega es obligatorio.');
    if (Number(DB.saleDeliveryPayAmount || 0) < total) {
      buckets.payment.push('El monto con que pagará el cliente es menor al total.');
    }
  }

  buckets.confirm = [...buckets.order, ...buckets.client, ...buckets.payment];
  return buckets;
}

function setBillingStep(step) {
  const targetStep = BILLING_STEP_FLOW.includes(step) ? step : 'order';
  const targetIndex = getBillingStepIndex(targetStep);
  const currentIndex = getBillingStepIndex();

  if (targetIndex > currentIndex) {
    for (let index = currentIndex; index < targetIndex; index += 1) {
      if (!validateBillingStep(BILLING_STEP_FLOW[index], { silent: false })) return;
    }
  }

  billingActiveStep = targetStep;
  billingModalState.step = targetStep;
  document.querySelectorAll('.billing-step-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `billing-step-${targetStep}`);
  });
  document.querySelectorAll('.billing-stepper-item').forEach((item, index) => {
    item.classList.toggle('is-active', index === targetIndex);
    item.classList.toggle('is-done', index < targetIndex);
    item.classList.toggle('is-pending', index > targetIndex);
  });
  syncBillingModalFooter();
  syncBillingConfirmSummary();
  syncBillingModalHeader();
  ensureBillingModalFitsContent();
}

function validateBillingStep(step = billingActiveStep, { silent = true } = {}) {
  const buckets = buildBillingValidationBuckets();
  const warnings = buckets[step] || [];
  if (!warnings.length) return true;
  if (!silent) {
    showToast(warnings[0], 'warning');
  }
  return false;
}

function billingGoToNextStep() {
  if (!validateBillingStep(billingActiveStep, { silent: false })) return;
  const currentIndex = getBillingStepIndex();
  const nextStep = BILLING_STEP_FLOW[Math.min(currentIndex + 1, BILLING_STEP_FLOW.length - 1)];
  setBillingStep(nextStep);
}

function billingGoToPrevStep() {
  const currentIndex = getBillingStepIndex();
  const prevStep = BILLING_STEP_FLOW[Math.max(0, currentIndex - 1)];
  setBillingStep(prevStep);
}

function syncBillingConfirmSummary() {
  const warnings = buildBillingValidationBuckets();
  const ready = warnings.confirm.length === 0;
  const totalText = document.getElementById('billing-total')?.textContent || fmt(0);

  // ── Actualizar la lista de productos ──
  const summaryBox = document.getElementById('billing-compact-lines');
  if (summaryBox) summaryBox.innerHTML = buildBillingCompactSummaryRowsMarkup();

  // ── Sincronizar pills de comprobante ──
  const activePreset = getBillingActiveDocumentPreset();
  document.querySelectorAll('.billing-compact-pill, .billing-v2-doc-pill').forEach((button) => {
    button.classList.toggle('is-active', button.getAttribute('onclick')?.includes(`'${activePreset}'`));
  });
  document.querySelectorAll('.billing-compact-chip').forEach((button) => {
    button.classList.toggle('is-active', button.getAttribute('onclick')?.includes(`'${activePreset}'`));
  });
  const codButton = document.getElementById('billing-cod-option');
  if (codButton) codButton.classList.toggle('is-active', DB.payMethod === 'contra_entrega');
  const methodNote = document.getElementById('billing-compact-method-note');
  if (methodNote) {
    methodNote.classList.toggle('hidden', DB.payMethod !== 'contra_entrega');
    if (DB.payMethod === 'contra_entrega') {
      const totalNow = parseFmt(totalText);
      const montoCliente = Number(DB.saleDeliveryPayAmount || 0);
      const cambioRepartidor = Math.max(0, montoCliente - totalNow);
      methodNote.innerHTML = montoCliente > 0
        ? `Cliente paga con <strong>${fmt(montoCliente)}</strong> · Cambio a llevar: <strong>${fmt(cambioRepartidor)}</strong>`
        : 'Contra entrega activo — indica con cuánto pagará el cliente.';
    }
  }

  // ── V2: Pill de estado (reemplaza la tarjeta grande) ──
  const pill = document.getElementById('billing-v2-status-pill');
  if (pill) {
    const hasProducts = Array.isArray(DB.saleItems) && DB.saleItems.length > 0;
    if (!hasProducts) {
      pill.className = 'billing-v2-status-pill billing-v2-status-pill--error';
      pill.textContent = '🔴 Sin productos';
    } else if (!ready) {
      const firstErr = warnings.confirm[0] || 'Datos incompletos';
      const isClientWarn = firstErr.toLowerCase().includes('cliente') || firstErr.toLowerCase().includes('rNC');
      pill.className = `billing-v2-status-pill billing-v2-status-pill--${isClientWarn ? 'warn' : 'error'}`;
      pill.textContent = isClientWarn ? `🟡 ${firstErr}` : `🔴 ${firstErr}`;
    } else {
      pill.className = 'billing-v2-status-pill billing-v2-status-pill--ok';
      pill.textContent = '🟢 Listo para cobrar';
    }
  }

  // ── V2: Botón COBRAR embebido en Col 3 ──
  const cobrarBtn = document.getElementById('billing-v2-cobrar-btn');
  if (cobrarBtn) {
    const disabled = !ready || _billingSubmitting;
    cobrarBtn.disabled = disabled;
    const printMode = getBillingPrintMode();
    if (_billingSubmitting) {
      cobrarBtn.textContent = '⏳ Procesando...';
    } else {
      cobrarBtn.textContent = printMode
        ? `🔒 COBRAR E IMPRIMIR ${totalText}`
        : `🔒 COBRAR ${totalText}`;
    }
  }

  // ── Contenedor legacy: mantenido vacío en v2, usado en modal step ──
  const container = document.getElementById('billing-compact-status');
  if (!container || container.style.display === 'none') return;

  // Fallback para modal step (no v2)
  container.innerHTML = `
    <div class="billing-compact-status-card ${ready ? 'is-ready' : 'is-warning'}">
      <div class="billing-compact-status-head">
        <strong>${ready ? '🟢 Listo para cobrar' : '🔴 Datos incompletos'}</strong>
        <span>${ready ? 'Venta lista.' : (warnings.confirm[0] || '')}</span>
      </div>
    </div>
  `;
}

function syncBillingModalFooter() {
  const footer = document.getElementById('modal-footer');
  if (!footer) return;
  const buckets = buildBillingValidationBuckets();
  const disabled = buckets.confirm.length > 0 || _billingSubmitting;
  const isV3 = Boolean(document.querySelector('.billing-v3-shell'));
  const isV2 = !isV3 && Boolean(document.querySelector('.billing-v2-shell'));

  if (isV3) {
    // ── Footer v3: totales a la izquierda + [Cancelar][Guardar][WhatsApp] ──
    const subtotalText = document.getElementById('s-subtotal')?.textContent || fmt(0);
    const itbisText    = document.getElementById('s-itbis')?.textContent    || fmt(0);
    const descText     = document.getElementById('s-descuento')?.textContent || `- ${fmt(0)}`;
    const roundingAdjustment = parseFmt(document.getElementById('s-redondeo')?.textContent || fmt(0));
    const totalText    = document.getElementById('s-total')?.textContent    || fmt(0);

    footer.innerHTML = `
      <div class="billing-v3-footer">
        <div class="billing-v3-footer-totals">
          <span>Subtotal <strong>${subtotalText}</strong></span>
          <span>ITBIS <strong>${itbisText}</strong></span>
          <span>Desc. <strong>${descText}</strong></span>
          ${Math.abs(roundingAdjustment) >= 0.01 ? `<span>Redondeo <strong>+ ${fmt(roundingAdjustment)}</strong></span>` : ''}
          <span class="billing-v3-footer-total">Total <strong>${totalText}</strong></span>
        </div>
        <div class="billing-v3-footer-actions">
          <button class="billing-v3-btn-cancel" type="button"
            onclick="requestBillingModalClose({ source: 'cancel' })" title="ESC">
            ✕ Cancelar
          </button>
          <button class="billing-v3-btn-save" type="button"
            ${_billingSubmitting ? 'disabled' : ''}
            onclick="processSale('charge')" title="F5">
            💾 Guardar
          </button>
          <button class="billing-v3-btn-wa" type="button"
            ${disabled ? 'disabled' : ''}
            onclick="processSale('whatsapp')" title="F6">
            📱 WhatsApp
          </button>
        </div>
      </div>
    `;
    // Sincronizar los dos botones COBRAR embebidos en Col 2
    const cobrarPrintBtn   = document.getElementById('billing-v2-cobrar-btn');
    const cobrarNoPrintBtn = document.getElementById('billing-v3-cobrar-noprint');
    if (cobrarPrintBtn)   cobrarPrintBtn.disabled   = disabled;
    if (cobrarNoPrintBtn) cobrarNoPrintBtn.disabled = _billingSubmitting;
    if (_billingSubmitting) {
      if (cobrarPrintBtn)   cobrarPrintBtn.textContent   = '⏳ Procesando...';
      if (cobrarNoPrintBtn) cobrarNoPrintBtn.textContent = '⏳ Procesando...';
    } else {
      if (cobrarPrintBtn)   cobrarPrintBtn.textContent   = '🖨 Cobrar e imprimir';
      if (cobrarNoPrintBtn) cobrarNoPrintBtn.textContent = '💾 Cobrar sin imprimir';
    }

  } else if (isV2) {
    // Footer ultra-compacto: botones secundarios solamente
    // El botón principal COBRAR está embebido en Col 3 (billing-v2-cobrar-btn)
    const totalText = document.getElementById('billing-total')?.textContent || fmt(0);
    footer.innerHTML = `
      <div class="billing-v2-footer billing-v2-footer--slim">
        <button class="billing-v2-btn-sm billing-v2-btn-cancel" type="button"
          onclick="requestBillingModalClose({ source: 'cancel' })" title="ESC">
          ✕ Cancelar
        </button>
        <button class="billing-v2-btn-sm billing-v2-btn-save" type="button"
          ${_billingSubmitting ? 'disabled' : ''}
          onclick="processSale('charge')" title="F5 — Sin imprimir">
          💾 Guardar
        </button>
        <button class="billing-v2-btn-sm billing-v2-btn-wa" type="button"
          ${disabled ? 'disabled' : ''}
          onclick="processSale('whatsapp')" title="F6">
          📱 WA
        </button>
        <span class="billing-v2-footer-hint">Efectivo: F2 Exacto · F3+100 · F4+200 · F5+500 · F6+1K · F7+2K · F9 🖨/💾 · ENTER Cobrar · ESC Salir</span>
      </div>
    `;
    // También sincronizar el botón COBRAR embebido en Col 3
    const cobrarBtn = document.getElementById('billing-v2-cobrar-btn');
    if (cobrarBtn) {
      cobrarBtn.disabled = disabled;
      const printMode = getBillingPrintMode();
      if (_billingSubmitting) {
        cobrarBtn.textContent = '⏳ Procesando...';
      } else {
        cobrarBtn.textContent = printMode
          ? `🔒 COBRAR E IMPRIMIR ${totalText}`
          : `🔒 COBRAR ${totalText}`;
      }
    }
  } else {
    // Fallback para modal legacy (paso a paso)
    const totalText = document.getElementById('billing-total')?.textContent || fmt(0);
    footer.innerHTML = `
      <div class="billing-footer-meta">
        <span class="billing-footer-step">POS</span>
        <strong>Cobro rápido</strong>
        <span class="billing-footer-status ${buckets.confirm.length ? 'is-pending' : 'is-ready'}">${buckets.confirm.length ? '● Cambios pendientes' : '✓ Listo'}</span>
      </div>
      <div class="billing-footer-actions">
        <button class="btn-secondary" type="button" onclick="requestBillingModalClose({ source: 'cancel' })">Cancelar</button>
        <button class="btn-secondary" type="button" ${_billingSubmitting ? 'disabled' : ''} onclick="processSale('charge')">Guardar sin imprimir</button>
        <button class="btn-secondary" type="button" ${disabled ? 'disabled' : ''} onclick="processSale('whatsapp')">Enviar WhatsApp</button>
        <button
          id="billing-primary-btn"
          class="btn-primary"
          type="button"
          ${disabled ? 'disabled' : ''}
          onclick="processSale('print')"
        >${_billingSubmitting ? '⏳ Procesando cobro...' : `💰 Cobrar e imprimir ${totalText}`}</button>
      </div>
    `;
  }
}

function showBillingDiscardPrompt() {
  billingModalState.discardPromptVisible = true;
  document.getElementById('billing-discard-guard')?.classList.remove('hidden');
}

function hideBillingDiscardPrompt() {
  billingModalState.discardPromptVisible = false;
  document.getElementById('billing-discard-guard')?.classList.add('hidden');
}

function confirmBillingDiscard() {
  hideBillingDiscardPrompt();
  cancelSale();
  closeAllModals(true, 'force');
}

function setBillingResponsible(value) {
  billingModalState.responsibleType = BILLING_RESPONSIBLE_TYPES.find((item) => item.key === value)?.key || 'cajero';
  document.querySelectorAll('.billing-responsible-card').forEach((button) => {
    button.classList.toggle('is-active', button.getAttribute('onclick')?.includes(`'${billingModalState.responsibleType}'`));
  });
  syncBillingConfirmSummary();
}

function setSaleOrderTypeFromCard(rawType) {
  const normalized = normalizeBillingOrderType(rawType);
  setSaleOrderType(normalized === 'barra' || normalized === 'terraza' ? 'mesa' : normalized);
  if (normalized === 'barra' && !String(DB.saleTableLabel || '').trim()) DB.saleTableLabel = 'Barra';
  if (normalized === 'terraza' && !String(DB.saleTableLabel || '').trim()) DB.saleTableLabel = 'Terraza';
  const tableLabelInput = document.getElementById('sale-table-label');
  if (tableLabelInput && DB.saleTableLabel) tableLabelInput.value = DB.saleTableLabel;
  document.querySelectorAll('.billing-order-card').forEach((button) => {
    const onclickValue = String(button.getAttribute('onclick') || '');
    button.classList.toggle('is-active', onclickValue.includes(`'${rawType}'`));
  });
  syncBillingConfirmSummary();
}

function setSaleDocumentTypeCard(value) {
  setSaleDocumentType(value);
  document.querySelectorAll('.billing-doc-card').forEach((button) => {
    const onclickValue = String(button.getAttribute('onclick') || '');
    button.classList.toggle('is-active', onclickValue.includes(`'${value}'`));
  });
}

function toggleBillingRememberLastClient(enabled) {
  setBillingRememberLastClientEnabled(Boolean(enabled));
  storeRememberedBillingClientId(DB.saleClientId);
}

function updateBillingPaymentDetail(field, value) {
  billingModalState[field] = value;
  syncBillingConfirmSummary();
  syncBillingModalFooter();
}

function toggleBillingQuickClient(forceState = null) {
  const panel = document.getElementById('billing-quick-client');
  if (!panel) return;
  const shouldShow = forceState === null ? panel.classList.contains('hidden') : Boolean(forceState);
  panel.classList.toggle('hidden', !shouldShow);
  if (shouldShow) {
    document.getElementById('billing-qc-nombre')?.focus();
    if (window.RNCLookup) {
      // La plantilla del panel varía según el flujo de facturación: a veces
      // solo hay un campo "Documento" (cédula), a veces cédula + RNC separados.
      ['billing-qc-cedula', 'billing-qc-rnc'].forEach((id) => {
        const el = document.getElementById(id);
        if (el && !el.dataset.rncAttached) {
          el.dataset.rncAttached = '1';
          RNCLookup.attach(el, { nameEl: document.getElementById('billing-qc-nombre'), mode: 'both' });
        }
      });
    }
  }
  ensureBillingModalFitsContent();
}

async function saveBillingQuickClient() {
  const nombre = String(document.getElementById('billing-qc-nombre')?.value || '').trim();
  if (!nombre) {
    showToast('El nombre del cliente es obligatorio.', 'error');
    return;
  }

  const telefono = String(document.getElementById('billing-qc-telefono')?.value || '').trim();
  const whatsapp = String(document.getElementById('billing-qc-whatsapp')?.value || '').trim();
  const referenciaBase = String(document.getElementById('billing-qc-referencia')?.value || '').trim();
  const referencia = [referenciaBase, whatsapp ? `WhatsApp: ${whatsapp}` : ''].filter(Boolean).join(' · ');
  const payload = {
    nombre,
    telefono: telefono || whatsapp,
    cedula: String(document.getElementById('billing-qc-cedula')?.value || '').trim(),
    rnc: String(document.getElementById('billing-qc-rnc')?.value || '').trim(),
    direccion: String(document.getElementById('billing-qc-direccion')?.value || '').trim(),
    referencia,
    linkUbicacion: String(document.getElementById('billing-qc-ubicacion')?.value || '').trim(),
    limiteCredito: 0,
    balance: 0,
    ...getActorPayload()
  };

  try {
    const created = await api.createClient(payload);
    DB.clientes.push(created);
    refreshSaleClientOptions();
    setSaleClient(created.id);
    const clientSelect = document.getElementById('sale-client-select');
    if (clientSelect) clientSelect.value = String(created.id);
    toggleBillingQuickClient(false);
    showToast('Cliente creado y vinculado a la venta.', 'success');
  } catch (error) {
    showToast(error.message || 'No se pudo crear el cliente.', 'error');
  }
}

function getBillingModalWidthLimits() {
  const viewportWidth = Math.max(window.innerWidth || 0, 420);
  return {
    min: 260,
    max: Math.max(340, Math.min(980, viewportWidth - 4))
  };
}

function getBillingModalHeightLimits() {
  const viewportHeight = Math.max(window.innerHeight || 0, 560);
  return {
    min: 280,
    max: Math.max(420, Math.min(980, viewportHeight - 4))
  };
}

function clampBillingModalWidth(width) {
  const numericWidth = Number(width || 0);
  const limits = getBillingModalWidthLimits();
  if (!Number.isFinite(numericWidth) || numericWidth <= 0) {
    return Math.min(520, limits.max);
  }
  return Math.max(limits.min, Math.min(limits.max, numericWidth));
}

function clampBillingModalHeight(height) {
  const numericHeight = Number(height || 0);
  const limits = getBillingModalHeightLimits();
  if (!Number.isFinite(numericHeight) || numericHeight <= 0) {
    return Math.min(640, limits.max);
  }
  return Math.max(limits.min, Math.min(limits.max, numericHeight));
}

function getStoredBillingModalWidth() {
  try {
    return clampBillingModalWidth(localStorage.getItem(BILLING_MODAL_WIDTH_KEY));
  } catch (_error) {
    return clampBillingModalWidth(520);
  }
}

function getStoredBillingModalHeight() {
  try {
    return clampBillingModalHeight(localStorage.getItem(BILLING_MODAL_HEIGHT_KEY));
  } catch (_error) {
    return clampBillingModalHeight(640);
  }
}

function setStoredBillingModalWidth(width) {
  try {
    localStorage.setItem(BILLING_MODAL_WIDTH_KEY, String(clampBillingModalWidth(width)));
  } catch (_error) {
    // Keep resizing usable even if localStorage is unavailable.
  }
}

function setStoredBillingModalHeight(height) {
  try {
    localStorage.setItem(BILLING_MODAL_HEIGHT_KEY, String(clampBillingModalHeight(height)));
  } catch (_error) {
    // Keep resizing usable even if localStorage is unavailable.
  }
}

function applyBillingModalWidth(width) {
  const modalBox = document.getElementById('modal-box');
  if (!modalBox?.classList.contains('billing-modal')) return;
  const clampedWidth = clampBillingModalWidth(width);
  modalBox.style.width = `${clampedWidth}px`;
  modalBox.style.maxWidth = `${clampedWidth}px`;
}

function applyBillingModalHeight(height) {
  const modalBox = document.getElementById('modal-box');
  if (!modalBox?.classList.contains('billing-modal')) return;
  const clampedHeight = clampBillingModalHeight(height);
  modalBox.style.height = `${clampedHeight}px`;
  modalBox.style.maxHeight = `${clampedHeight}px`;
}

function stopBillingModalResize() {
  if (!billingModalResizeState) return;
  window.removeEventListener('pointermove', billingModalResizeState.handleMove);
  window.removeEventListener('pointerup', billingModalResizeState.handleUp);
  window.removeEventListener('pointercancel', billingModalResizeState.handleUp);
  document.body.classList.remove('is-resizing-billing-modal');
  billingModalResizeState = null;
}

function ensureBillingModalFitsContent() {
  const modalBox = document.getElementById('modal-box');
  const modalBody = document.getElementById('modal-body');
  if (!modalBox?.classList.contains('billing-modal') || !modalBody) return;
  // V3: el tamaño lo controla CSS (:has(.billing-v3-shell)); no intervenir
  if (modalBody.querySelector('.billing-v3-shell')) return;

  requestAnimationFrame(() => {
    const headerHeight = modalBox.querySelector('.modal-header')?.offsetHeight || 0;
    const footerHeight = modalBox.querySelector('.modal-footer')?.offsetHeight || 0;
    const bodyHeightNeeded = Math.ceil(modalBody.scrollHeight);
    const targetHeight = clampBillingModalHeight(headerHeight + footerHeight + bodyHeightNeeded + 4);
    const currentHeight = Math.ceil(modalBox.getBoundingClientRect().height);

    if (targetHeight > currentHeight + 4) {
      applyBillingModalHeight(targetHeight);
      setStoredBillingModalHeight(targetHeight);
    }
  });
}

function initBillingModalResize() {
  stopBillingModalResize();
  const modalBox = document.getElementById('modal-box');
  if (!modalBox?.classList.contains('billing-modal')) return;
  // V3: tamaño gestionado por CSS; no restaurar dimensiones guardadas
  if (document.getElementById('modal-body')?.querySelector('.billing-v3-shell')) return;

  applyBillingModalWidth(getStoredBillingModalWidth());
  applyBillingModalHeight(getStoredBillingModalHeight());

  modalBox.querySelectorAll('.billing-resize-handle').forEach((node) => node.remove());

  const directions = [
    { key: 'nw', label: 'Ajustar desde la esquina superior izquierda' },
    { key: 'n', label: 'Ajustar altura desde arriba' },
    { key: 'ne', label: 'Ajustar desde la esquina superior derecha' },
    { key: 'e', label: 'Ajustar ancho desde la derecha' },
    { key: 'se', label: 'Ajustar desde la esquina inferior derecha' },
    { key: 's', label: 'Ajustar altura desde abajo' },
    { key: 'sw', label: 'Ajustar desde la esquina inferior izquierda' },
    { key: 'w', label: 'Ajustar ancho desde la izquierda' }
  ];

  directions.forEach(({ key, label }) => {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'billing-resize-handle';
    handle.dataset.direction = key;
    handle.setAttribute('aria-label', label);
    modalBox.appendChild(handle);

    handle.onpointerdown = (event) => {
      event.preventDefault();
      handle.setPointerCapture?.(event.pointerId);
      const startWidth = modalBox.getBoundingClientRect().width;
      const startHeight = modalBox.getBoundingClientRect().height;
      const startX = event.clientX;
      const startY = event.clientY;

      const handleMove = (moveEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const deltaY = moveEvent.clientY - startY;
        let nextWidth = startWidth;
        let nextHeight = startHeight;

        if (key.includes('e')) nextWidth = startWidth + deltaX;
        if (key.includes('w')) nextWidth = startWidth - deltaX;
        if (key.includes('s')) nextHeight = startHeight + deltaY;
        if (key.includes('n')) nextHeight = startHeight - deltaY;

        if (key.includes('e') || key.includes('w')) {
          applyBillingModalWidth(nextWidth);
        }
        if (key.includes('n') || key.includes('s')) {
          applyBillingModalHeight(nextHeight);
        }
      };

      const handleUp = () => {
        const rect = modalBox.getBoundingClientRect();
        setStoredBillingModalWidth(rect.width);
        setStoredBillingModalHeight(rect.height);
        stopBillingModalResize();
      };

      billingModalResizeState = { handleMove, handleUp };
      document.body.classList.add('is-resizing-billing-modal');
      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', handleUp);
      window.addEventListener('pointercancel', handleUp);
    };
  });
}

function syncBillingModalHeader(warnings = []) {
  const title = document.getElementById('modal-title');
  if (!title) return;

  const type = DB.saleDocumentType || 'ticket';
  const nextNumber = getDocumentSequencePreview(type);
  const compactWarnings = typeof buildBillingValidationBuckets === 'function'
    ? buildBillingValidationBuckets().confirm
    : [];
  const allWarnings = [...warnings, ...compactWarnings];
  const ready = allWarnings.length === 0;
  const hasDraft = billingHasDraftData();
  const billingCaps = window.TecnoCajaBilling?.getEffectiveBillingCapabilities
    ? window.TecnoCajaBilling.getEffectiveBillingCapabilities()
    : { canCreateSales: true, forcePendingCharge: false };
  const titleMain = 'Cobrar y Facturar';
  const readyText = billingCaps.forcePendingCharge ? 'Lista para emitir' : 'Listo para cobrar';

  title.innerHTML = `
    <span class="billing-titlebar">
      <span class="billing-titlebar-main">${titleMain}</span>
      <span class="billing-titlebar-doc">${escapeHtml(nextNumber)}</span>
      <span class="billing-titlebar-badge ${ready ? 'is-ready' : 'is-warning'}">${ready ? readyText : 'Revisar datos'}</span>
      <span class="billing-titlebar-pending ${hasDraft ? '' : 'hidden'}">● Cambios pendientes</span>
    </span>
  `;
}

function _showCajaRequiredModal() {
  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');
  if (!overlay || !title || !body || !footer) {
    showToast('La caja está cerrada. Ábrela desde el módulo Caja antes de vender.', 'error');
    return;
  }
  document.getElementById('modal-box')?.classList.remove('billing-modal');
  title.textContent = 'Caja cerrada';
  body.innerHTML = `
    <p style="line-height:1.6;color:var(--text2)">La caja está cerrada. Debes abrirla antes de registrar ventas.</p>
    <p style="line-height:1.6;color:var(--text2);margin-top:.5rem">Ve al módulo <strong style="color:var(--text1)">Caja</strong> y presiona <strong style="color:var(--text1)">Abrir Caja</strong>.</p>
  `;
  footer.innerHTML = `
    <button class="btn-secondary" type="button" onclick="closeAllModals()">Volver</button>
    <button class="btn-primary" type="button" onclick="closeAllModals();showModule('caja',document.querySelector('.nav-item[data-module=caja]'))">Ir a Caja →</button>
  `;
  overlay.classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════
//  BILLING V2 — Atajos de teclado (F1–F6, ENTER, ESC)
// ═══════════════════════════════════════════════════════════
// ── Modo de impresión (persiste entre ventas) ──────────────
// ═══════════════════════════════════════════════════════════

const BILLING_PRINT_MODE_KEY = 'tecnocaja_billing_print_mode';

/** Devuelve true = imprimir, false = no imprimir. Default: true. */
function getBillingPrintMode() {
  const stored = localStorage.getItem(BILLING_PRINT_MODE_KEY);
  return stored === null ? true : stored !== 'false';
}

/** Guarda la preferencia y actualiza la UI del modal (si está abierto). */
function setBillingPrintMode(value) {
  localStorage.setItem(BILLING_PRINT_MODE_KEY, String(Boolean(value)));
  _syncBillingPrintModeUI();
}

/** Alterna entre imprimir / no imprimir. Mapeado a F9. */
function toggleBillingPrintMode() {
  setBillingPrintMode(!getBillingPrintMode());
  // Notificar brevemente con el toast
  const printMode = getBillingPrintMode();
  showToast(printMode ? '🖨 Impresión activada' : '💾 Sin impresión', 'info');
}

/** Sincroniza todos los elementos visuales de modo impresión en el modal abierto. */
function _syncBillingPrintModeUI() {
  const printMode = getBillingPrintMode();
  const isV3 = Boolean(document.querySelector('.billing-v3-shell'));

  if (isV3) {
    // V3: actualizar indicador de modo (qué hace ENTER)
    const indicator = document.getElementById('billing-v2-print-indicator');
    if (indicator) {
      indicator.textContent = printMode ? '🖨 ENTER imprime · F9 para cambiar' : '💾 ENTER no imprime · F9 para activar';
      indicator.className = `billing-v3-print-mode-badge${printMode ? '' : ' billing-v3-print-mode-badge--off'}`;
    }
    // En v3 ambos botones son siempre visibles — no se cambia su texto por F9
    return;
  }

  // V2 legacy:
  // Botones de alternancia
  document.getElementById('billing-v2-mode-print')?.classList.toggle('is-active', printMode);
  document.getElementById('billing-v2-mode-noprint')?.classList.toggle('is-active', !printMode);

  // Indicador de texto
  const indicator = document.getElementById('billing-v2-print-indicator');
  if (indicator) {
    indicator.textContent = printMode ? '🖨 Se imprimirá recibo' : '💾 No se imprimirá recibo';
    indicator.className = `billing-v2-print-indicator${printMode ? '' : ' billing-v2-print-indicator--off'}`;
  }

  // Botón COBRAR (solo texto, no disabled: eso lo maneja syncBillingConfirmSummary)
  const cobrarBtn = document.getElementById('billing-v2-cobrar-btn');
  if (cobrarBtn && !_billingSubmitting) {
    const totalText = document.getElementById('billing-total')?.textContent || '';
    const b = buildBillingValidationBuckets ? buildBillingValidationBuckets() : { confirm: ['?'] };
    const ready = b.confirm.length === 0;
    if (!cobrarBtn.disabled || ready) {
      cobrarBtn.textContent = printMode
        ? `🔒 COBRAR E IMPRIMIR ${totalText}`
        : `🔒 COBRAR ${totalText}`;
    }
  }
}

// ═══════════════════════════════════════════════════════════

function attachBillingKeyHandler() {
  detachBillingKeyHandler();
  _billingKeyHandler = (event) => {
    // Solo actuar cuando el modal de cobro está abierto
    if (!document.getElementById('modal-box')?.classList.contains('billing-modal')) return;

    // Si el foco está en un textarea o en un input que NO sea el de monto, no interceptar ENTER
    const tag = event.target?.tagName || '';
    const isRestrictedInput = tag === 'TEXTAREA' ||
      (tag === 'INPUT' && event.target?.id !== 'monto-recibido');

    const isEfectivoActive = DB.payMethod === 'efectivo';

    // ── Atajos Alt + tecla (montos rápidos, solo en efectivo) ──────────────
    if (event.altKey && isEfectivoActive) {
      switch (event.key) {
        case 'e': case 'E':
          event.preventDefault();
          setMontoExacto(document.getElementById('quick-amount-exact'));
          document.getElementById('monto-recibido')?.focus();
          return;
        case '1':
          event.preventDefault();
          setMontoRapido(100, document.querySelector('.billing-v3-quick-btn[onclick*="100"]'));
          return;
        case '2':
          event.preventDefault();
          setMontoRapido(200, document.querySelector('.billing-v3-quick-btn[onclick*="200"]'));
          return;
        case '5':
          event.preventDefault();
          setMontoRapido(500, document.querySelector('.billing-v3-quick-btn[onclick*="500"]'));
          return;
        case '0':
          event.preventDefault();
          setMontoRapido(1000, document.querySelector('.billing-v3-quick-btn[onclick*="1,000"]'));
          return;
        case '9':
          event.preventDefault();
          setMontoRapido(2000, document.querySelector('.billing-v3-quick-btn[onclick*="2,000"]'));
          return;
      }
    }

    switch (event.key) {
      // ── Métodos de pago (F2–F6, siempre) ──────────────────────────────
      case 'F2': {
        event.preventDefault();
        const btn = document.querySelector('.pay-method[onclick*="\'efectivo\'"]');
        if (btn) setPayMethod('efectivo', btn);
        document.getElementById('monto-recibido')?.focus();
        break;
      }
      case 'F3': {
        event.preventDefault();
        const btn = document.querySelector('.pay-method[onclick*="\'tarjeta\'"]');
        if (btn) setPayMethod('tarjeta', btn);
        break;
      }
      case 'F4': {
        event.preventDefault();
        const btn = document.querySelector('.pay-method[onclick*="\'transferencia\'"]');
        if (btn) setPayMethod('transferencia', btn);
        break;
      }
      case 'F5': {
        event.preventDefault();
        const btn = document.querySelector('.pay-method[onclick*="\'mixto\'"]');
        if (btn) setPayMethod('mixto', btn);
        break;
      }
      case 'F6': {
        event.preventDefault();
        const btn = document.querySelector('.pay-method[onclick*="\'credito\'"]');
        if (btn) setPayMethod('credito', btn);
        break;
      }

      // ── Imprimir / no imprimir ─────────────────────────────────────────
      case 'F9':
        event.preventDefault();
        event.stopPropagation();
        toggleBillingPrintMode();
        break;

      // ── Cobrar (Enter) ─────────────────────────────────────────────────
      case 'Enter':
        if (isRestrictedInput) return;
        event.preventDefault();
        event.stopPropagation();
        { const b = buildBillingValidationBuckets();
          if (!b.confirm.length && !_billingSubmitting) processSale(getBillingPrintMode() ? 'print' : 'charge'); }
        break;

      // ── Cancelar (Escape) ──────────────────────────────────────────────
      case 'Escape':
        event.preventDefault();
        requestBillingModalClose({ source: 'cancel' });
        break;

      default:
        break;
    }
  };
  document.addEventListener('keydown', _billingKeyHandler, true);
}

function detachBillingKeyHandler() {
  if (!_billingKeyHandler) return;
  document.removeEventListener('keydown', _billingKeyHandler, true);
  _billingKeyHandler = null;
}
window.detachBillingKeyHandler = detachBillingKeyHandler;

// ═══════════════════════════════════════════════════════════
//  BILLING V3 — Helpers de cliente y descuento
// ═══════════════════════════════════════════════════════════

/** Actualiza los chips del cliente en el subheader v3. */
function _syncBillingV3ClientExpand() {
  const expand = document.getElementById('billing-v3-client-expand');
  if (!expand) return;
  const client = getSelectedSaleClient();
  if (client) {
    const cedula  = client.cedula   ? `<span class="billing-v3-client-chip">🪪 ${escapeHtml(client.cedula)}</span>` : '';
    const telefono = client.telefono ? `<span class="billing-v3-client-chip">📞 ${escapeHtml(client.telefono)}</span>` : '';
    expand.innerHTML = `
      <span class="billing-v3-client-chip">👤 ${escapeHtml(client.nombre || '')}</span>
      ${cedula}${telefono}
    `;
    expand.classList.remove('hidden');
  } else {
    expand.innerHTML = '';
    expand.classList.add('hidden');
  }
}

/** Abre el mini-modal de descuento (v3). */
function openBillingDiscountModal() {
  const overlay = document.getElementById('billing-v3-discount-modal');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  setTimeout(() => {
    const input = document.getElementById('desc-general');
    if (input) { input.focus(); input.select(); }
  }, 50);
}

/** Cierra el mini-modal de descuento (v3). */
function closeBillingDiscountModal() {
  document.getElementById('billing-v3-discount-modal')?.classList.add('hidden');
  document.getElementById('monto-recibido')?.focus();
}
window.openBillingDiscountModal  = openBillingDiscountModal;
window.closeBillingDiscountModal = closeBillingDiscountModal;

/** Actualiza el texto del botón [% Desc.] según el valor actual. */
function _syncBillingV3DiscountBtn() {
  const btn = document.querySelector('.billing-v3-desc-btn');
  if (!btn) return;
  const val = parseFloat(DB.saleGeneralDiscount || 0) || 0;
  btn.innerHTML = val > 0 ? `% <strong>${val}%</strong>` : '% Desc.';
}

function openBillingModal() {
  // El cajero suele tardar unos segundos escogiendo método de pago; usar ese
  // tiempo para dejar lista la impresora y el logo elimina la preparación
  // posterior al botón Facturar.
  warmReceiptPrintPipeline().catch(() => {});
  if (!(DB.config?.cajaAbierta || DB.caja?.abierta || cajaAbierta)) {
    _showCajaRequiredModal();
    return;
  }
  // Limpiar cualquier estado colgado de una sesión anterior
  _billingSubmitting = false;
  const billingCaps = window.TecnoCajaBilling?.getEffectiveBillingCapabilities
    ? window.TecnoCajaBilling.getEffectiveBillingCapabilities()
    : { canCreateSales: true, forcePendingCharge: false };
  if (!billingCaps.canCreateSales) {
    showToast(`Tu usuario está configurado como ${billingCaps.userTypeLabel || 'Cobro'} y no puede emitir ventas nuevas desde esta caja.`, 'warning');
    return;
  }
  if (!document.getElementById('modal-overlay')?.classList.contains('hidden')) {
    requestBillingModalClose({ source: 'force' });
  }
  billingActivePane = 'payment';
  resetBillingCheckoutDraft({ preserveRememberedClient: true });
  if ((DB.saleOrderType || 'mostrador') === 'delivery') {
    billingModalState.responsibleType = 'delivery';
  } else if (String(DB.currentUser?.rol || '').trim().toLowerCase().includes('vendedor')) {
    billingModalState.responsibleType = 'vendedor';
  }
  syncBillingModalHeader();
  document.getElementById('modal-body').innerHTML = buildBillingCompactModalMarkup();
  document.getElementById('modal-box').classList.add('billing-modal');
  document.getElementById('modal-overlay').classList.remove('hidden');
  syncBillingModalFooter();
  syncSaleFiscalControls();
  setSaleNcfType(DB.saleNcfType || '');
  refreshAvailableNcfDocTypes();
  _applyAvailableNcfDocTypesToPills();
  syncBillingModalTotals();
  syncBillingClientSnapshot();
  const amountInput = document.getElementById('monto-recibido');
  const totalEl = document.getElementById('billing-total')?.textContent || fmt(0);
  const total = parseFmt(totalEl);
  if (amountInput) {
    if (DB.payMethod === 'contra_entrega') {
      amountInput.value = '';
    } else if (DB.payMethod === 'credito') {
      amountInput.value = '0';
    } else {
      amountInput.value = total.toFixed(2);
    }
  }
  if (amountInput) amountInput.focus();
  calcCambio();
  calcMixto();
  syncBillingConfirmSummary();
  ensureBillingModalFitsContent();
  attachBillingKeyHandler();
  if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('modal-overlay'));
}

function setBillingPane(pane = 'payment') {
  billingActivePane = pane === 'data' ? 'data' : 'payment';

  const dataPane = document.getElementById('billing-pane-data');
  const paymentPane = document.getElementById('billing-pane-payment');
  const dataSwitch = document.getElementById('billing-pane-switch-data');
  const paymentSwitch = document.getElementById('billing-pane-switch-payment');

  dataPane?.classList.toggle('hidden', billingActivePane !== 'data');
  paymentPane?.classList.toggle('hidden', billingActivePane !== 'payment');
  dataSwitch?.classList.toggle('active', billingActivePane === 'data');
  paymentSwitch?.classList.toggle('active', billingActivePane === 'payment');

  if (billingActivePane === 'data') {
    document.getElementById('sale-order-type')?.focus();
  } else {
    document.getElementById('monto-recibido')?.focus();
  }
  ensureBillingModalFitsContent();
}

function syncBillingModalTotals() {
  const itemsCountEl = document.getElementById('billing-items-count');
  const subtotalEl = document.getElementById('billing-subtotal');
  const subtotalGravadoRowEl = document.getElementById('billing-subtotal-gravado-row');
  const subtotalExentoRowEl = document.getElementById('billing-subtotal-exento-row');
  const subtotalGravadoEl = document.getElementById('billing-subtotal-gravado');
  const subtotalExentoEl = document.getElementById('billing-subtotal-exento');
  const itbisEl = document.getElementById('billing-itbis');
  const descuentoEl = document.getElementById('billing-descuento');
  const totalEl = document.getElementById('billing-total');
  const totalEmptyEl = document.getElementById('billing-total-empty');
  const taxBehavior = getSaleTaxConfig();

  const sidebarSubtotal = document.getElementById('s-subtotal')?.textContent || fmt(0);
  const sidebarSubtotalGravado = document.getElementById('s-subtotal-gravado')?.textContent || fmt(0);
  const sidebarSubtotalExento = document.getElementById('s-subtotal-exento')?.textContent || fmt(0);
  const sidebarItbis = document.getElementById('s-itbis')?.textContent || fmt(0);
  const sidebarDescuento = document.getElementById('s-descuento')?.textContent || `- ${fmt(0)}`;
  const sidebarTotal = document.getElementById('s-total')?.textContent || fmt(0);
  const totalItemsLabel = getSaleLineCountLabel(DB.saleItems, DB.saleItems.length);
  const totalValue = parseFmt(sidebarTotal);

  if (itemsCountEl) {
    itemsCountEl.textContent = totalItemsLabel;
  }
  if (subtotalEl) subtotalEl.textContent = sidebarSubtotal;
  if (subtotalGravadoEl) subtotalGravadoEl.textContent = sidebarSubtotalGravado;
  if (subtotalExentoEl) subtotalExentoEl.textContent = sidebarSubtotalExento;
  if (subtotalGravadoRowEl) subtotalGravadoRowEl.style.display = taxBehavior.separateTaxableAndExempt ? '' : 'none';
  if (subtotalExentoRowEl) subtotalExentoRowEl.style.display = taxBehavior.separateTaxableAndExempt ? '' : 'none';
  if (itbisEl) itbisEl.textContent = sidebarItbis;
  if (descuentoEl) descuentoEl.textContent = sidebarDescuento;
  if (totalEl) totalEl.textContent = sidebarTotal;
  if (totalEmptyEl) totalEmptyEl.classList.toggle('hidden', Array.isArray(DB.saleItems) && DB.saleItems.length && totalValue > 0);
  syncBillingModalFooter();
  syncBillingConfirmSummary();
}

function syncAdvancedOrderFieldsVisibility() {
  const advancedSection = document.getElementById('billing-advanced-section');
  if (!advancedSection) return;

  const selectedType = DB.saleOrderType || document.getElementById('sale-order-type')?.value || 'mostrador';
  const shouldHide = selectedType === 'mostrador';

  advancedSection.hidden = shouldHide;
  advancedSection.style.display = shouldHide ? 'none' : '';

  if (shouldHide) {
    advancedSection.open = false;
    advancedSection.classList.add('hidden');
    return;
  }

  advancedSection.classList.remove('hidden');
  advancedSection.open = selectedType === 'delivery' || selectedType === 'mesa';
}

function syncSaleFiscalControls() {
  const docTypeSelect = document.getElementById('sale-doc-type');
  const orderTypeSelect = document.getElementById('sale-order-type');
  const kitchenStatusSelect = document.getElementById('sale-kitchen-status');

  if (!DB.config.eInvoiceEnabled && DB.saleDocumentType === 'factura-electronica') {
    DB.saleDocumentType = 'ticket';
  }

  refreshSaleClientOptions();
  if (docTypeSelect) docTypeSelect.value = DB.saleDocumentType || 'ticket';
  if (orderTypeSelect) orderTypeSelect.value = DB.saleOrderType || getSalesFlowConfig().defaultOrderType || 'mostrador';
  if (kitchenStatusSelect) kitchenStatusSelect.value = DB.saleKitchenStatus || getSalesFlowConfig().defaultKitchenStatus || 'pendiente';
  const deliveryUserSelect = document.getElementById('sale-delivery-user');
  if (deliveryUserSelect) deliveryUserSelect.value = DB.saleDeliveryUserId ? String(DB.saleDeliveryUserId) : '';
  const tableLabelInput = document.getElementById('sale-table-label');
  if (tableLabelInput) tableLabelInput.value = DB.saleTableLabel || '';
  const orderNotesInput = document.getElementById('sale-order-notes');
  if (orderNotesInput) orderNotesInput.value = DB.saleOrderNotes || '';
  const electronicOption = docTypeSelect?.querySelector('option[value="factura-electronica"]');
  if (electronicOption) electronicOption.disabled = !DB.config.eInvoiceEnabled;
  syncContraEntregaAvailability();
  syncDeliveryClientFields();
  syncBillingClientSnapshot();
  const activePayButton = Array.from(document.querySelectorAll('.pay-method')).find((button) => button.getAttribute('onclick')?.includes(`'${DB.payMethod || 'efectivo'}'`));
  if (activePayButton) {
    setPayMethod(DB.payMethod || 'efectivo', activePayButton);
  } else if (DB.payMethod === 'contra_entrega') {
    setPayMethod('contra_entrega', document.getElementById('billing-cod-option'));
  }
  document.querySelectorAll('.billing-doc-card').forEach((button) => {
    button.classList.toggle('is-active', button.getAttribute('onclick')?.includes(`'${DB.saleDocumentType || 'ticket'}'`));
  });
  // V3: sincronizar pills de comprobante
  const activePreset = getBillingActiveDocumentPreset();
  document.querySelectorAll('.billing-v3-doc-pill').forEach((button) => {
    const onclickVal = button.getAttribute('onclick') || '';
    button.classList.toggle('is-active', onclickVal.includes(`'${activePreset}'`));
  });
  updateSaleFiscalPreview();
  syncBillingModalFooter();
  syncBillingConfirmSummary();
  ensureBillingModalFitsContent();
}

function setSaleDocumentType(value) {
  if (value === 'factura-electronica' && !DB.config.eInvoiceEnabled) {
    DB.saleDocumentType = 'ticket';
    showToast('La factura electrónica está deshabilitada en configuración.', 'warning');
  } else {
    DB.saleDocumentType = value || 'ticket';
  }
  syncSaleFiscalControls();
}

function setSaleClient(value) {
  DB.saleClientId = value ? Number(value) : null;
  storeRememberedBillingClientId(DB.saleClientId);
  const client = getSelectedSaleClient();
  if (client) {
    DB.saleDeliveryPhone = client.telefono || '';
    DB.saleDeliveryAddress = client.direccion || '';
    DB.saleDeliveryReference = client.referencia || '';
    DB.saleDeliveryLink = client.linkUbicacion || '';
  }
  syncDeliveryClientFields();
  syncBillingClientSnapshot();
  updateSaleFiscalPreview();
  syncBillingModalFooter();
  syncBillingConfirmSummary();
}

function setSaleOrderType(value) {
  DB.saleOrderType = value || getSalesFlowConfig().defaultOrderType || 'mostrador';
  if (DB.saleOrderType === 'delivery') {
    billingModalState.responsibleType = 'delivery';
  } else if (billingModalState.responsibleType === 'delivery') {
    billingModalState.responsibleType = 'cajero';
  }
  if (DB.saleOrderType !== 'delivery' && DB.payMethod === 'contra_entrega') {
    const defaultMethod = document.querySelector('.pay-method');
    if (defaultMethod) setPayMethod('efectivo', defaultMethod);
  }
  // Si se sale de "Delivery" hay que soltar el repartidor/teléfono/dirección
  // que se hubieran cargado — si no, quedan pegados en DB.sale* y la venta se
  // guarda con delivery_user_id aunque tipoPedido ya no sea 'delivery', lo
  // que hace que la factura no muestre esos datos (exige tipoPedido==='delivery')
  // pero el repartidor sí quede asignado en la base — inconsistente y confuso.
  if (DB.saleOrderType !== 'delivery') {
    DB.saleDeliveryUserId = null;
    DB.saleDeliveryPhone = '';
    DB.saleDeliveryAddress = '';
    DB.saleDeliveryReference = '';
    DB.saleDeliveryLink = '';
    DB.saleDeliveryPayAmount = 0;
    const deliveryUserSelect = document.getElementById('sale-delivery-user');
    if (deliveryUserSelect) deliveryUserSelect.value = '';
    ['sale-delivery-phone', 'sale-delivery-address', 'sale-delivery-reference'].forEach((id) => {
      const field = document.getElementById(id);
      if (field) field.value = '';
    });
  }
  document.querySelectorAll('.billing-v3-order-pill').forEach((button) => {
    button.classList.toggle('is-active', button.getAttribute('onclick') === `setSaleOrderType('${DB.saleOrderType}')`);
  });
  document.getElementById('billing-delivery-fields')?.classList.toggle('hidden', DB.saleOrderType !== 'delivery');
  const orderTypeSelect = document.getElementById('sale-order-type');
  if (orderTypeSelect) orderTypeSelect.value = DB.saleOrderType;
  syncContraEntregaAvailability();
  syncBillingModalFooter();
  syncBillingConfirmSummary();
}

function setSaleKitchenStatus(value) {
  DB.saleKitchenStatus = value || getSalesFlowConfig().defaultKitchenStatus || 'pendiente';
  syncBillingConfirmSummary();
}

function setSaleDeliveryUser(value) {
  DB.saleDeliveryUserId = value ? Number(value) : null;
  syncDeliveryClientFields();
  syncBillingModalFooter();
  syncBillingConfirmSummary();
}

function syncContraEntregaAvailability() {
  const codButton = document.getElementById('pay-method-cod');
  if (!codButton) return;
  const enabled = (DB.saleOrderType || 'mostrador') === 'delivery';
  codButton.disabled = false;
  codButton.classList.toggle('pay-method-delivery-hint', !enabled);
  codButton.title = enabled
    ? 'Cobro pendiente hasta que el delivery entregue el dinero'
    : 'Al seleccionarlo, el pedido cambia automáticamente a delivery';
}

function syncDeliveryClientFields() {
  const client = getSelectedSaleClient();
  const phone = document.getElementById('sale-delivery-phone');
  const address = document.getElementById('sale-delivery-address');
  const reference = document.getElementById('sale-delivery-reference');
  const link = document.getElementById('sale-delivery-link');
  const hasClient = Boolean(client);

  [phone, address, reference, link].forEach((field) => {
    if (!field) return;
    field.readOnly = hasClient;
    field.classList.toggle('form-input-readonly', hasClient);
  });

  if (client) {
    DB.saleDeliveryPhone = client.telefono || '';
    DB.saleDeliveryAddress = client.direccion || '';
    DB.saleDeliveryReference = client.referencia || '';
    DB.saleDeliveryLink = client.linkUbicacion || '';
  }

  if (phone) phone.value = DB.saleDeliveryPhone || '';
  if (address) address.value = DB.saleDeliveryAddress || '';
  if (reference) reference.value = DB.saleDeliveryReference || '';
  if (link) link.value = DB.saleDeliveryLink || '';
}

function updateSaleFiscalPreview() {
  const preview = document.getElementById('sale-fiscal-preview');
  if (!preview) return;

  const type = DB.saleDocumentType || 'ticket';
  const ncfType = DB.saleNcfType || '';
  const client = getSelectedSaleClient();
  const clientTaxId = client?.cedula || client?.rnc || '';
  const electronicBuyerRnc = (DB.saleRncCliente || '').trim() || (client?.rnc || '').trim();
  const nextNumber = getDocumentSequencePreview(type);
  const warnings = [];

  if (type === 'factura-electronica') {
    if (!DB.config.eInvoiceEnabled) {
      warnings.push('La facturación electrónica está deshabilitada en configuración.');
    }
  }
  if (ncfType === 'B01') {
    const rnc = (DB.saleRncCliente || '').trim() || (client?.rnc || '').trim() || clientTaxId;
    if (!rnc) warnings.push('B01 requiere RNC del cliente.');
  }
  if (['B03','B04'].includes(ncfType) && !DB.saleNcfReferencia) {
    warnings.push(`${ncfType} requiere seleccionar la factura original.`);
  }

  syncBillingModalHeader(warnings);

  const ncfLabels = { B01:'Crédito Fiscal', B02:'Consumidor Final', B03:'Nota Débito', B04:'Nota Crédito', B14:'Esp.', B15:'Gob.' };
  const electronicDisplayType = electronicBuyerRnc
    ? 'E31 · Crédito Fiscal'
    : 'E32 · Consumidor Final';
  const displayType = ncfType
    ? `${ncfType} · ${ncfLabels[ncfType] || ncfType}`
    : type === 'factura-electronica'
      ? electronicDisplayType
      : (SALE_DOCUMENT_TYPES[type] || type);
  preview.innerHTML = `
    <div class="sale-fiscal-inline">
      <span class="sale-fiscal-inline-type">${displayType}</span>
      <span class="sale-fiscal-inline-separator">•</span>
      <span class="sale-fiscal-inline-meta">${nextNumber}</span>
      ${DB.saleOrderType === 'delivery' ? `
        <span class="sale-fiscal-inline-separator">•</span>
        <span class="sale-fiscal-inline-meta">${getDeliveryUsers().find((user) => user.id === DB.saleDeliveryUserId)?.nombre || 'Delivery pendiente'}</span>
      ` : ''}
      ${clientTaxId ? `<span class="sale-fiscal-inline-separator">•</span><span class="sale-fiscal-inline-meta">${clientTaxId}</span>` : ''}
      ${DB.saleNcfReferencia ? `<span class="sale-fiscal-inline-separator">•</span><span class="sale-fiscal-inline-meta">Ref: ${DB.saleNcfReferencia}</span>` : ''}
    </div>
    ${warnings.length ? `<div class="sale-fiscal-warning">${warnings.join(' ')}</div>` : `<div class="sale-fiscal-ok">Comprobante listo para emitir.</div>`}
  `;
  syncBillingModalFooter();
  syncBillingConfirmSummary();
}

// ── NCF SELECTOR FUNCTIONS ───────────────────────────────────────────────────

const NCF_LABELS_FE = { B01:'Crédito Fiscal', B02:'Consumidor Final', B03:'Nota de Débito', B04:'Nota de Crédito', B14:'Régimen Especial', B15:'Gubernamental' };

function setSaleNcfType(ncfType) {
  DB.saleNcfType = ncfType || '';
  DB.saleRncCliente = '';
  DB.saleRazonSocial = '';
  DB.saleNcfReferencia = '';
  DB.saleNcfReferenciaId = null;

  // Mark active button
  document.querySelectorAll('.ncf-type-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.ncf === ncfType);
  });

  // Show/hide badge
  const badge = document.getElementById('ncf-none-badge');
  if (badge) badge.style.display = ncfType ? 'none' : 'inline';

  // Show/hide extra fields — el campo de RNC/cédula con autocompletado está
  // disponible para CUALQUIER tipo de comprobante (Ticket, B02, B01, B14,
  // B15), para poder facturarle a un cliente rápido por su RNC/cédula sin
  // tener que crearlo antes en el sistema. Solo se oculta en B03/B04, que
  // usan el buscador de factura original en su lugar.
  const showsRncFields = !['B03', 'B04'].includes(ncfType);
  const rncFields = document.getElementById('ncf-rnc-fields');
  const refFields = document.getElementById('ncf-ref-fields');
  if (rncFields) rncFields.style.display = showsRncFields ? '' : 'none';
  if (refFields) refFields.style.display = showsRncFields ? 'none' : '';

  const rncInput = document.getElementById('ncf-rnc-input');
  const razonInput = document.getElementById('ncf-razon-input');
  if (showsRncFields) {
    // Auto-fill desde el cliente ya seleccionado en el dropdown (si hay uno)
    const client = getSelectedSaleClient();
    if (rncInput) rncInput.value = client ? (client.rnc || client.cedula || '') : '';
    if (razonInput) razonInput.value = client ? (client.razon_social || client.nombre || '') : '';
    DB.saleRncCliente = rncInput?.value || '';
    DB.saleRazonSocial = razonInput?.value || '';

    // Conectar autocomplete RNC (solo la primera vez)
    if (rncInput && !rncInput.dataset.rncAttached && window.RNCLookup) {
      rncInput.dataset.rncAttached = '1';
      RNCLookup.attach(rncInput, {
        nameEl: razonInput,
        onSelect(data) {
          DB.saleRncCliente  = data.rnc;
          DB.saleRazonSocial = data.nombreComercial || data.nombre || '';
          updateSaleFiscalPreview();
        }
      });
    }
  } else {
    if (rncInput) rncInput.value = '';
    if (razonInput) razonInput.value = '';
    const refInput = document.getElementById('ncf-ref-input');
    if (refInput) refInput.value = '';
    clearNcfRef();
  }

  updateSaleFiscalPreview();
  ensureBillingModalFitsContent();
}

let _ncfSearchTimer = null;
function ncfSearchInvoices(query) {
  clearTimeout(_ncfSearchTimer);
  const results = document.getElementById('ncf-ref-results');
  if (!query || query.trim().length < 2) { if (results) results.innerHTML = ''; return; }
  _ncfSearchTimer = setTimeout(async () => {
    try {
      const data = await fetch(`/api/ncf/search-facturas?q=${encodeURIComponent(query)}`, {
        headers: { Authorization: `Bearer ${DB.authToken || ''}` }
      }).then(r => r.json());
      if (!results) return;
      if (!Array.isArray(data) || !data.length) {
        results.innerHTML = '<div class="ncf-ref-no-results">Sin resultados</div>'; return;
      }
      results.innerHTML = data.map(f => `
        <div class="ncf-ref-item" onclick="selectNcfRef('${escapeHtml(f.ncf || f.invoiceNumber)}', '${f.id}', '${escapeHtml(f.ncf || f.invoiceNumber)} — ${escapeHtml(f.cliente)}')">
          <span class="ncf-ref-item-ncf">${escapeHtml(f.ncf || f.invoiceNumber)}</span>
          <span class="ncf-ref-item-client">${escapeHtml(f.cliente)}</span>
          <span class="ncf-ref-item-total">RD$ ${Number(f.total).toLocaleString('es-DO',{minimumFractionDigits:2})}</span>
        </div>`).join('');
    } catch (_) {}
  }, 300);
}

function selectNcfRef(ncf, id, label) {
  DB.saleNcfReferencia = ncf;
  DB.saleNcfReferenciaId = id;
  const refInput = document.getElementById('ncf-ref-input');
  const refResults = document.getElementById('ncf-ref-results');
  const refSelected = document.getElementById('ncf-ref-selected');
  const refSelectedText = document.getElementById('ncf-ref-selected-text');
  if (refInput) refInput.value = '';
  if (refResults) refResults.innerHTML = '';
  if (refSelected) refSelected.style.display = '';
  if (refSelectedText) refSelectedText.textContent = label;
  updateSaleFiscalPreview();
}

function clearNcfRef() {
  DB.saleNcfReferencia = '';
  DB.saleNcfReferenciaId = null;
  const refInput = document.getElementById('ncf-ref-input');
  const refResults = document.getElementById('ncf-ref-results');
  const refSelected = document.getElementById('ncf-ref-selected');
  if (refInput) refInput.value = '';
  if (refResults) refResults.innerHTML = '';
  if (refSelected) refSelected.style.display = 'none';
  updateSaleFiscalPreview();
}

let _searchDebounceTimer = null;
function searchProduct(query) {
  clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(() => _doSearchProduct(query), 120);
}
// Criterio único de "producto vendible": no inactivo ni eliminado (igual que catálogo visual).
// Centralizar aquí evita que búsqueda y catálogo muestren resultados distintos.
function isProductSellable(p) {
  const st = String(p.estado || '').toLowerCase().trim();
  return st !== 'inactivo' && st !== 'eliminado';
}

function _doSearchProduct(query) {
  const q = query.toLowerCase().trim();
  const dd = document.getElementById('search-dropdown');
  if (!q) {
    dd.classList.add('hidden');
    searchResults = [];
    renderSalesCatalog();
    return;
  }

  searchResults = DB.productos.filter(p =>
    isProductSellable(p) && (
      p.nombre.toLowerCase().includes(q) ||
      (typeof getLocalizedProductName === 'function' ? getLocalizedProductName(p) : p.nombre).toLowerCase().includes(q) ||
      p.codigo.toLowerCase().includes(q) ||
      (p.categoria || '').toLowerCase().includes(q) ||
      (typeof getLocalizedCategoryName === 'function' ? getLocalizedCategoryName(p.categoria) : p.categoria || '').toLowerCase().includes(q) ||
      (p.marca && p.marca.toLowerCase().includes(q))
    )
  ).slice(0, 8);

  if (!searchResults.length) {
    dd.innerHTML = '<div style="padding:1rem;color:var(--text3)">No se encontraron productos</div>';
    dd.classList.remove('hidden');
    return;
  }

  dd.innerHTML = searchResults.map((p, i) => `
    <div class="search-result-item ${i===selectedSearchIdx?'selected':''}" onclick="addProductById(${p.id})">
      <div style="display:flex;gap:0.75rem;align-items:center">
        <img src="${getSalesProductImage(p)}" alt="${typeof getLocalizedProductName === 'function' ? getLocalizedProductName(p) : p.nombre}" style="width:46px;height:46px;object-fit:cover;border-radius:12px;border:1px solid var(--border);background:var(--panel2)" onerror="this.onerror=null;this.src='${PRODUCT_IMAGE_PLACEHOLDER}'">
        <div>
          <div class="sri-name">${typeof getLocalizedProductName === 'function' ? getLocalizedProductName(p) : p.nombre}</div>
          <div class="sri-code">${p.codigo} · ${typeof getLocalizedCategoryName === 'function' ? getLocalizedCategoryName(p.categoria) : p.categoria}</div>
          <div style="font-size:.72rem;color:var(--text3);margin-top:.18rem">${escapeHtml(buildSaleItemMeta(p, p))}</div>
        </div>
      </div>
      <div style="text-align:right">
        <div class="sri-price">${fmt(p.precioVenta)}</div>
        <div class="sri-stock ${p.tracksStock!==false&&p.stock===0?'text-danger':''}">${p.tracksStock===false?'':(p.stock===0?(!p.branchId?'⚠ Sin stock en esta sucursal':'⚠ Agotado'):'Stock: '+p.stock)}</div>
      </div>
    </div>
  `).join('');
  dd.classList.remove('hidden');
  selectedSearchIdx = -1;
}

function handleSearchKey(e) {
  // El comprobante (u otro modal/báscula) puede quedar abierto sobre la
  // pantalla de ventas hasta que el cajero le haga clic a "Cerrar" — nada
  // obliga a cerrarlo antes de seguir cobrando. Si en ese momento el cajero
  // sigue escaneando (para ir más rápido), el foco a veces seguía en este
  // input aunque estuviera tapado por el modal, así que el escaneo se
  // procesaba igual y agregaba productos a la venta siguiente SIN que el
  // cajero pudiera verlo (la pantalla estaba cubierta) — apareciendo luego
  // como productos "fantasma" que nadie vio agregar. canAutoFocusSalesSearch()
  // ya evita volver a enfocar este input mientras hay un overlay de venta
  // abierto (ver isSalesOverlayOpen); este guard hace que tampoco proceses
  // el Enter si el foco quedó aquí por cualquier otra razón.
  if (typeof isSalesOverlayOpen === 'function' && isSalesOverlayOpen()) return;
  const dd = document.getElementById('search-dropdown');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedSearchIdx = Math.min(selectedSearchIdx + 1, searchResults.length - 1);
    highlightSearch();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedSearchIdx = Math.max(selectedSearchIdx - 1, 0);
    highlightSearch();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    // Prioridad máxima: código de báscula con peso/precio embebido.
    // Se evalúa ANTES del flujo normal para evitar que el escáner
    // caiga en el prompt de báscula física cuando el peso ya viene en el código.
    const currentQuery = String(document.getElementById('product-search')?.value || '').trim();
    if (currentQuery && addProductByScaleBarcode(currentQuery)) return;

    // Si el usuario seleccionó un ítem con las flechas ↑↓, usar esa selección explícita.
    if (selectedSearchIdx >= 0 && searchResults[selectedSearchIdx]) {
      addProductById(searchResults[selectedSearchIdx].id);
      return;
    }

    // Siempre forzar una búsqueda fresca para evitar resultados obsoletos.
    // El escáner envía Enter antes de que corra el debounce de 120 ms, y
    // searchResults podría contener datos de una búsqueda anterior distinta.
    if (currentQuery) {
      clearTimeout(_searchDebounceTimer);

      // Si el dropdown ya está visible con resultados de una búsqueda previa
      // y hay un match EXACTO de código para lo que está escrito ahora mismo,
      // agregarlo sin re-buscar (atajo seguro: el código sí corresponde a lo
      // que se acaba de escanear/escribir).
      // OJO: antes, si no había match exacto, caía a "searchResults[0]" —
      // es decir, agregaba el primer resultado de la búsqueda ANTERIOR, que
      // con frecuencia era de OTRO producto. El escáner manda el código y el
      // Enter casi de inmediato: si el dropdown del escaneo previo (varios
      // resultados, sin match exacto) seguía abierto cuando llegó el
      // siguiente escaneo, este atajo agregaba a ciegas ese resultado viejo
      // — un producto "aleatorio" que el cajero nunca eligió. Sin match
      // exacto, ahora cae al flujo de búsqueda fresca de abajo en vez de
      // adivinar.
      const ddVisible = !dd.classList.contains('hidden');
      if (ddVisible && searchResults.length > 0 && selectedSearchIdx < 0) {
        const exactMatch = searchResults.find(p => p.codigo.toLowerCase() === currentQuery.toLowerCase());
        if (exactMatch) {
          addProductById(exactMatch.id);
          return;
        }
      }

      _doSearchProduct(currentQuery);
      if (searchResults.length === 1) {
        addProductById(searchResults[0].id);
      } else if (searchResults.length > 1) {
        // Múltiples resultados: buscar coincidencia exacta por código primero
        const exactMatch = searchResults.find(p => p.codigo.toLowerCase() === currentQuery.toLowerCase());
        if (exactMatch) {
          addProductById(exactMatch.id);
        }
        // Si no hay exacta, el dropdown se muestra con los resultados frescos
        // y no se agrega nada a ciegas — el cajero elige con clic o flechas+Enter.
      } else {
        // Sin resultados — sugerir registro del producto
        if (!addProductByScaleBarcode(currentQuery)) {
          suggestRegisterProduct(currentQuery);
        }
      }
    }
  } else if (e.key === 'Escape') {
    dd.classList.add('hidden');
  }
}

function suggestRegisterProduct(codigo) {
  const searchInput = document.getElementById('product-search');
  if (searchInput) searchInput.value = '';
  document.getElementById('search-dropdown')?.classList.add('hidden');
  searchResults = [];

  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');
  if (!overlay || !title || !body || !footer) {
    showToast('Producto no encontrado', 'error');
    focusSalesSearchInput({ force: true });
    return;
  }

  title.textContent = 'Producto no registrado';
  body.innerHTML = `
    <p style="line-height:1.6;color:var(--text2)">
      El código <strong style="color:var(--text1);font-family:var(--font-mono)">${escapeHtml(codigo)}</strong>
      no está registrado en el catálogo.
    </p>
    <p style="line-height:1.6;color:var(--text2);margin-top:0.5rem">
      ¿Deseas ir al módulo de Productos para registrarlo?
    </p>
  `;
  footer.innerHTML = `
    <button class="btn-secondary" type="button" onclick="closeAllModals();focusSalesSearchInput({force:true})">Cancelar</button>
    <button class="btn-primary" type="button" onclick="closeAllModals();irARegistrarProducto(${JSON.stringify(codigo)})">Registrar producto</button>
  `;
  overlay.classList.remove('hidden');
}

function irARegistrarProducto(codigo) {
  const navItem = document.querySelector('.nav-item[data-module="productos"]');
  showModule('productos', navItem);
  setTimeout(() => {
    if (typeof openProductModal === 'function') {
      openProductModal(null);
      setTimeout(() => {
        const codigoInput = document.getElementById('mp-codigo');
        if (codigoInput) {
          codigoInput.value = codigo;
          codigoInput.dispatchEvent(new Event('input'));
        }
        document.getElementById('mp-nombre')?.focus();
      }, 80);
    }
  }, 80);
}

function highlightSearch() {
  document.querySelectorAll('.search-result-item').forEach((el, i) => {
    el.classList.toggle('selected', i === selectedSearchIdx);
  });
}

async function addProductById(id) {
  const prod = DB.productos.find(p => p.id === id);
  if (!prod) return;

  const saleMode = getSaleItemSaleMode(prod, prod);
  let nextQty = 1;
  let lineExtra = {};

  if (saleMode === 'peso') {
    // Si hay un peso fresco de la báscula TCP (< 4s), usarlo directamente sin prompt
    if (addBasculaTcpWeightToProduct(prod)) return;

    const weightReading = await promptWeightForProduct(prod);
    if (!weightReading) {
      focusSalesSearchInput({ force: true });
      return;
    }
    nextQty = Number(weightReading.qty || 0);
    lineExtra = {
      weightUnit: weightReading.weightUnit,
      scaleWeight: weightReading.scaleWeight,
      scaleMeasuredValue: weightReading.scaleMeasuredValue,
      scaleMeasuredUnit: weightReading.scaleMeasuredUnit,
      scaleSource: weightReading.scaleSource,
      scaleRawReading: weightReading.scaleRawReading
    };
  }

  // Tope de disponibilidad: no dejar agregar más de lo que realmente hay
  // (stock real menos lo que ya está en el carrito), avisando antes de que
  // llegue a facturarse.
  if (prod.tracksStock !== false) {
    const alreadyInCart = getCartQtyForProduct(prod.id);
    const available = Number(prod.stock || 0) - alreadyInCart;
    if (available <= 0) {
      showToast(
        !prod.branchId
          ? 'Este producto es global pero no tiene stock recibido en tu sucursal — pídelo por transferencia o edítalo para agregar la cantidad de aquí.'
          : `Ya no quedan más unidades disponibles de "${prod.nombre}".`,
        'warning'
      );
      focusSalesSearchInput({ force: true });
      return;
    }
    if (nextQty > available) {
      const availableLabel = Number.isInteger(available) ? available : available.toFixed(3);
      showToast(`Solo quedan ${availableLabel} disponibles de "${prod.nombre}".`, 'warning');
      focusSalesSearchInput({ force: true });
      return;
    }
  }

  const existIdx = findMergeableSaleItemIndex(prod, saleMode);
  let targetIdx = existIdx;

  if (existIdx >= 0) {
    const currentQty = Number(DB.saleItems[existIdx]?.qty || 0);
    DB.saleItems[existIdx] = recalcSaleItemForQty(DB.saleItems[existIdx], currentQty + nextQty);
  } else {
    const item = buildSaleItem(prod, nextQty, lineExtra);
    DB.saleItems.push(item);
    targetIdx = DB.saleItems.length - 1;
  }

  document.getElementById('product-search').value = '';
  document.getElementById('search-dropdown').classList.add('hidden');
  searchResults = [];
  renderSaleTable();
  updateTotals();
  renderSalesCatalog();

  focusSalesSearchInput({ force: true });
}

// El TOTAL de la línea en el carrito SIEMPRE incluye el ITBIS de esa línea
// (precio a como se venderá), sin importar el modo de facturación
// configurado (ese config solo afecta cómo se desglosa el ITBIS en el
// recibo impreso, no esta vista interactiva) — así el cajero ve de una vez
// cuánto va a cobrar por esa línea, igual que ya se ve en el catálogo y en
// la grilla de Ventas.
function calcItemTotal(item) {
  const net = calculateSaleItemNet(item);
  return roundSaleMoney(net + calculateSaleItemTax(item));
}

function renderSaleTable() {
  const tbody = document.getElementById('sale-items');
  normalizeCartSaleItems();
  syncSaleOrderCount();

  if (!DB.saleItems.length) {
    tbody.innerHTML = `<tr class="empty-row" id="empty-row"><td colspan="9"><div class="empty-sale"><span class="empty-icon">🛒</span><p>Escanea o busca un producto para comenzar</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = DB.saleItems.map((item, idx) => `
    <tr>
      <td style="color:var(--text3);font-family:var(--font-mono)">${idx+1}</td>
      <td style="font-family:var(--font-mono);font-size:0.7rem;line-height:1.15;white-space:normal;word-break:break-word">${item.codigo}</td>
      <td style="white-space:normal;word-break:break-word">
        <span style="font-weight:600;line-height:1.2">${typeof getLocalizedProductName === 'function' ? getLocalizedProductName(item.nombre) : item.nombre}</span>
        ${item.quickSale ? '<span class="quick-sale-badge">VENTA RÁPIDA · SIN INVENTARIO</span>' : ''}
        ${item.promoAplicada ? `
          <div style="margin-top:.2rem">
            <span style="display:inline-block;font-size:.68rem;font-weight:700;color:#fff;background:${item.promoAplicada.color || '#22c55e'};border-radius:4px;padding:.05rem .4rem">${item.promoAplicada.cantidadMinima ? `🔢 ${item.promoAplicada.cantidadMinima}+ uds` : '🏷'} ${escapeHtml(item.promoAplicada.texto || item.promoAplicada.nombre || 'OFERTA')}</span>
          </div>
        ` : ''}
      </td>
      <td>
        ${item.promoAplicada ? `<div style="font-size:.72rem;color:var(--text3);text-decoration:line-through">${fmt(item.promoAplicada.precioOriginal)}</div>` : ''}
        <input id="sale-item-price-${idx}" class="price-input is-readonly" type="number" value="${item.precio}" min="0" step="0.01" readonly disabled tabindex="-1">
      </td>
      <td>
        ${isWeightSaleItem(item)
          ? `
            <div style="display:flex;flex-direction:column;gap:0.4rem">
              <div style="font-weight:800;font-family:var(--font-mono);color:var(--text1)">${escapeHtml(formatSaleItemQuantity(item, item.qty, { includeUnit: true }))}</div>
              <button class="btn-secondary" type="button" style="padding:.36rem .55rem;font-size:.72rem" onclick="reweighSaleItem(${idx})">⚖️ Leer peso</button>
            </div>
          `
          : `
            <input id="sale-item-qty-${idx}" class="qty-input" type="number" value="${item.qty}" oninput="updateItemQty(${idx},this.value)" onchange="updateItemQty(${idx},this.value)" onkeydown="handleQtyInputKey(event, ${idx})" min="${getSaleItemMinQuantity(item)}" step="${getSaleItemQuantityStep(item)}">
          `}
      </td>
      <td><input id="sale-item-disc-${idx}" class="disc-input" type="number" value="${item.descuento}" min="0" max="100" step="0.01" oninput="updateItemDisc(${idx},this.value)" onchange="updateItemDisc(${idx},this.value)" title="Descuento de este producto en %"></td>
      <td style="color:var(--text2);font-size:0.74rem">${item.itbisModo === 'monto' ? `RD$${Number(item.itbisMontoUnit || 0).toFixed(2)}` : `${item.itbis}%`}</td>
      <td id="sale-item-total-${idx}" style="font-weight:700;font-family:var(--font-mono);font-size:0.76rem;white-space:nowrap">${fmt(item.total)}</td>
      <td><button class="btn-remove" onclick="removeItem(${idx})">✕</button></td>
    </tr>
  `).join('');
}

function syncSaleOrderCount() {
  const orderCount = document.getElementById('sale-order-count');
  if (!orderCount) return;

  if (!DB.saleItems.length) {
    orderCount.textContent = '0 productos';
    return;
  }

  const lineCount = DB.saleItems.length;
  const unitQty = DB.saleItems
    .filter((item) => getSaleItemSaleMode(item) === 'unidad')
    .reduce((sum, item) => sum + Number(item.qty || 0), 0);
  const measureCount = DB.saleItems.filter((item) => getSaleItemSaleMode(item) === 'medida').length;
  const weightCount = DB.saleItems.filter((item) => getSaleItemSaleMode(item) === 'peso').length;
  const fragments = [`${lineCount} ${lineCount === 1 ? 'línea' : 'líneas'}`];
  if (unitQty > 0) fragments.push(`${unitQty} unid.`);
  if (measureCount > 0) fragments.push(`${measureCount} por medida`);
  if (weightCount > 0) fragments.push(`${weightCount} por peso`);
  orderCount.textContent = fragments.join(' · ');
}

function handleQtyInputKey(event, idx) {
  if (event.key === 'Enter') {
    event.preventDefault();
    updateItemQty(idx, event.target.value);
    focusSalesSearchInput({ force: true });
    return;
  }
  if (!['+', '-', 'Add', 'Subtract', 'NumpadAdd', 'NumpadSubtract'].includes(event.key)) return;

  event.preventDefault();
  const currentQty = Number(DB.saleItems[idx]?.qty || 1);
  const step = Number.parseFloat(getSaleItemQuantityStep(DB.saleItems[idx])) || 1;
  const nextQty = ['+', 'Add', 'NumpadAdd'].includes(event.key)
    ? currentQty + step
    : Math.max(Number(getSaleItemMinQuantity(DB.saleItems[idx]) || 1), currentQty - step);

  if (event.target && 'value' in event.target) {
    event.target.value = String(nextQty);
  }
  updateItemQty(idx, nextQty);
}

function getGeneralDiscountValue() {
  const discountInput = document.getElementById('desc-general');
  if (discountInput) {
    const value = parseFloat(discountInput.value) || 0;
    DB.saleGeneralDiscount = value;
    return value;
  }
  return parseFloat(DB.saleGeneralDiscount || 0) || 0;
}

function syncSaleRowDisplay(idx) {
  const item = DB.saleItems[idx];
  if (!item) return;

  const totalCell = document.getElementById(`sale-item-total-${idx}`);
  if (totalCell) totalCell.textContent = fmt(item.total);

  const qtyInput = document.getElementById(`sale-item-qty-${idx}`);
  if (qtyInput && document.activeElement !== qtyInput) {
    qtyInput.value = String(item.qty);
  }

  const priceInput = document.getElementById(`sale-item-price-${idx}`);
  if (priceInput && document.activeElement !== priceInput) {
    priceInput.value = String(item.precio);
  }

  const discInput = document.getElementById(`sale-item-disc-${idx}`);
  if (discInput && document.activeElement !== discInput) {
    discInput.value = String(item.descuento);
  }
}

function updateItemQty(idx, val) {
  const item = DB.saleItems[idx];
  if (!item) return;
  if (isWeightSaleItem(item)) {
    showToast('Los productos por peso se actualizan leyendo la báscula.', 'warning');
    renderSaleTable();
    return;
  }

  let qty = sanitizeSaleItemQty(item, val);
  const product = DB.productos.find(p => Number(p.id) === Number(item.id));
  if (product && product.tracksStock !== false) {
    const otherCartQty = getCartQtyForProduct(product.id, idx);
    const available = Number(product.stock || 0) - otherCartQty;
    if (qty > available) {
      qty = Math.max(0, available);
      showToast(
        available > 0
          ? `Solo quedan ${available} disponibles de "${product.nombre}".`
          : `Ya no quedan más unidades disponibles de "${product.nombre}".`,
        'warning'
      );
    }
  }

  DB.saleItems[idx] = recalcSaleItemForQty(item, qty);
  syncSaleOrderCount();
  syncSaleRowDisplay(idx);
  updateTotals();
  renderSalesCatalog();
}
function updateItemPrice(idx, val) {
  DB.saleItems[idx].precio = Math.max(0, parseFloat(val) || 0);
  DB.saleItems[idx].total = calcItemTotal(DB.saleItems[idx]);
  syncSaleRowDisplay(idx);
  updateTotals();
}
function updateItemDisc(idx, val) {
  DB.saleItems[idx].descuento = Math.min(100, Math.max(0, parseFloat(val) || 0));
  DB.saleItems[idx].total = calcItemTotal(DB.saleItems[idx]);
  syncSaleRowDisplay(idx);
  updateTotals();
}
function removeItem(idx) {
  DB.saleItems.splice(idx, 1);
  renderSaleTable();
  updateTotals();
  renderSalesCatalog();
}

function applyGeneralDiscount() {
  DB.saleGeneralDiscount = getGeneralDiscountValue();
  updateTotals();
  // Re-llenar monto-recibido si el modal está abierto
  const amountInput = document.getElementById('monto-recibido');
  const totalEl = document.getElementById('billing-total')?.textContent || fmt(0);
  const total = parseFmt(totalEl);
  if (amountInput && DB.payMethod !== 'contra_entrega') {
    amountInput.value = total.toFixed(2);
    calcCambio();
  }
}

function updateTotals() {
  normalizeCartSaleItems();
  const totals = calcularTotales(DB.saleItems, {
    generalDiscountRate: getGeneralDiscountValue(),
    config: DB.config
  });
  const taxBehavior = getSaleTaxConfig();

  document.getElementById('s-subtotal').textContent = fmt(totals.subtotal);
  document.getElementById('s-subtotal-gravado').textContent = fmt(totals.subtotalGravado);
  document.getElementById('s-subtotal-exento').textContent = fmt(totals.subtotalExento);
  document.getElementById('s-descuento').textContent = '- ' + fmt(totals.discount);
  document.getElementById('s-itbis').textContent = fmt(totals.itbis);
  const redondeoEl = document.getElementById('s-redondeo');
  if (redondeoEl) redondeoEl.textContent = '+ ' + fmt(totals.roundingAdjustment || 0);
  document.getElementById('s-total').textContent = fmt(totals.total);
  document.getElementById('cobrar-total').textContent = fmt(totals.total);
  const taxLabelEl = document.getElementById('sale-tax-label');
  if (taxLabelEl) {
    taxLabelEl.textContent = `ITBIS (${taxBehavior.taxRate.toFixed(2).replace(/\.00$/, '')}%)`;
  }
  const separateBreakdownFlag = document.getElementById('s-separate-tax-breakdown');
  if (separateBreakdownFlag) {
    separateBreakdownFlag.textContent = taxBehavior.separateTaxableAndExempt ? '1' : '0';
  }

  syncBillingModalTotals();
  calcCambio();
}

function validateSaleItemsBeforeCheckout() {
  normalizeCartSaleItems();

  for (const item of DB.saleItems) {
    const qty = Number(item.qty || 0);
    if (!(qty > 0)) {
      showToast(`La cantidad de ${item.nombre || 'un producto'} debe ser mayor a 0.`, 'error');
      return false;
    }

    if (isWeightSaleItem(item)) {
      const weight = Number(item.scaleWeight ?? qty);
      if (!(weight > 0)) {
        showToast(`Debes leer el peso de ${item.nombre || 'este producto'} antes de cobrar.`, 'error');
        return false;
      }
    }
  }

  return true;
}

function setPayMethod(method, el) {
  if (method === 'contra_entrega' && (DB.saleOrderType || 'mostrador') !== 'delivery') {
    setSaleOrderType('delivery');
    showToast('Se cambió el pedido a delivery para usar contra entrega.', 'success');
  }
  DB.payMethod = method;
  document.querySelectorAll('.pay-method').forEach(b => b.classList.remove('active'));
  el?.classList.add('active');
  // Pago con tarjeta siempre se factura con NCF fiscal — por defecto B02 (Consumidor
  // Final), salvo que el cajero ya haya puesto B01 porque el cliente lo pidió con RNC
  // (no se sobreescribe). Sigue siendo editable: el cajero puede cambiarlo después.
  if (method === 'tarjeta' && DB.saleNcfType !== 'B01') {
    setSaleNcfType('B02');
  }
  // Recalcular totales ANTES de prellenar el monto a cobrar más abajo — el ITBIS de
  // cada producto es el mismo sin importar el método de pago, pero el total mostrado
  // debe estar actualizado antes de copiarlo al campo de monto a cobrar.
  updateTotals();
  const efArea = document.getElementById('efectivo-area');
  const qaArea = document.getElementById('quick-amounts');
  const codArea = document.getElementById('contra-entrega-area');
  const mixtoArea = document.getElementById('mixto-area');
  const tarjetaArea = document.getElementById('tarjeta-area');
  const transferenciaArea = document.getElementById('transferencia-area');
  const creditoArea = document.getElementById('credito-area');
  const usdArea = document.getElementById('usd-area');
  if (efArea) efArea.style.display = method === 'efectivo' ? 'flex' : 'none';
  if (efArea) efArea.style.flexDirection = 'column';
  if (efArea) efArea.style.gap = '6px';
  if (qaArea) qaArea.style.display = method === 'efectivo' ? 'grid' : 'none';
  if (codArea) codArea.style.display = method === 'contra_entrega' ? 'flex' : 'none';
  if (codArea) codArea.style.flexDirection = 'column';
  if (mixtoArea) mixtoArea.style.display = method === 'mixto' ? 'grid' : 'none';
  if (tarjetaArea) tarjetaArea.style.display = method === 'tarjeta' ? 'grid' : 'none';
  if (transferenciaArea) transferenciaArea.style.display = method === 'transferencia' ? 'grid' : 'none';
  if (creditoArea) creditoArea.style.display = method === 'credito' ? 'grid' : 'none';
  if (usdArea) usdArea.style.display = method === 'usd' ? 'flex' : 'none';
  if (usdArea) usdArea.style.flexDirection = 'column';
  if (usdArea) usdArea.style.gap = '6px';
  if (method !== 'efectivo') {
    document.querySelectorAll('.quick-amount-btn').forEach((button) => button.classList.remove('active'));
  }
  const amountInput = document.getElementById('monto-recibido');
  const amountInputUsd = document.getElementById('monto-recibido-usd');
  if (method === 'usd') {
    if (amountInputUsd) amountInputUsd.value = '';
  } else if (amountInput) {
    if (method === 'efectivo') {
      // Limpiar — el cajero pone el monto con botones rápidos o teclado
      amountInput.value = '';
    } else if (method === 'contra_entrega' || method === 'credito' || method === 'mixto') {
      amountInput.value = '';
    } else {
      // Tarjeta / Transferencia: pre-llenar con el total (cobro exacto)
      const modalBox = document.getElementById('modal-box');
      const billingTotalEl = (modalBox && modalBox.querySelector('#billing-total'))
        || document.getElementById('billing-total');
      const totalEl = billingTotalEl?.textContent || fmt(0);
      const total = parseFmt(totalEl);
      amountInput.value = total.toFixed(2);
    }
  }
  if (method === 'mixto') {
    const mixtoTarjeta = document.getElementById('mixto-tarjeta');
    const mixtoEfectivo = document.getElementById('mixto-efectivo');
    const mixtoTransferencia = document.getElementById('mixto-transferencia');
    if (mixtoTarjeta) mixtoTarjeta.value = String(billingModalState.mixedCardAmount || '');
    if (mixtoEfectivo) mixtoEfectivo.value = String(billingModalState.mixedCashAmount || '');
    if (mixtoTransferencia) mixtoTransferencia.value = String(billingModalState.mixedTransferAmount || '');
    calcMixto();
    mixtoTarjeta?.focus();
  } else if (method === 'usd') {
    calcCambioUsd();
    amountInputUsd?.focus();
  } else if (method === 'contra_entrega') {
    const codAmountInput = document.getElementById('monto-recibido-contra-entrega');
    if (codAmountInput) {
      codAmountInput.value = DB.saleDeliveryPayAmount ? String(DB.saleDeliveryPayAmount) : '';
    }
    calcCambioContraEntrega();
    codAmountInput?.focus();
  } else {
    calcCambio();
  }
  syncBillingModalFooter();
  syncBillingConfirmSummary();
  ensureBillingModalFitsContent();
}

function calcCambio() {
  // Leer el total desde el elemento dentro del modal (fuente autoritativa)
  // billing-total se inicializa con el total real al abrir el modal
  const modalBox = document.getElementById('modal-box');
  const billingTotalEl = (modalBox && modalBox.querySelector('#billing-total'))
    || document.getElementById('billing-total');
  const totalRaw = billingTotalEl?.textContent || document.getElementById('s-total')?.textContent || fmt(0);
  const total = parseFmt(totalRaw);

  const amountInput = document.getElementById('monto-recibido');
  const cambioVal = document.getElementById('cambio-val');
  const cambioCard = document.getElementById('billing-cambio-card');
  const faltanEl = document.getElementById('billing-cambio-faltan');
  if (!amountInput || !cambioVal) return;

  // Métodos sin cambio en efectivo — limpiar y salir
  if (DB.payMethod === 'contra_entrega' || DB.payMethod === 'credito' || DB.payMethod === 'mixto') {
    cambioVal.textContent = fmt(0);
    _setCambioCardState(cambioCard, faltanEl, 'neutral', '');
    return;
  }

  // Parsear recibido con validación estricta
  const rawVal = String(amountInput.value || '').trim();
  const recibido = rawVal === '' ? 0 : (parseFloat(rawVal) || 0);

  // Guardar para defensa: nunca mostrar NaN
  if (isNaN(recibido)) {
    cambioVal.textContent = fmt(0);
    _setCambioCardState(cambioCard, faltanEl, 'neutral', '');
    return;
  }

  // FÓRMULA: Devuelta = Recibido − Total  (NO Recibido + Total)
  const diferencia = recibido - total;

  if (recibido <= 0) {
    cambioVal.textContent = fmt(0);
    _setCambioCardState(cambioCard, faltanEl, 'neutral', '');
  } else if (diferencia > 0.004) {
    // Hay devuelta positiva
    cambioVal.textContent = fmt(diferencia);
    _setCambioCardState(cambioCard, faltanEl, 'ok', '');
  } else if (Math.abs(diferencia) <= 0.004) {
    // Pago exacto (tolerancia 0.4 centavos para flotantes)
    cambioVal.textContent = fmt(0);
    _setCambioCardState(cambioCard, faltanEl, 'exacto', '');
  } else {
    // Monto insuficiente — mostrar el faltante en el card amount (no cero)
    cambioVal.textContent = fmt(Math.abs(diferencia));
    _setCambioCardState(cambioCard, faltanEl, 'insuf', '');
  }

  syncBillingModalFooter();
  syncBillingConfirmSummary();
}

// Cambio que debe llevar el repartidor en pago contra entrega — el cliente
// le paga en efectivo al momento de la entrega, no en caja.
function calcCambioContraEntrega() {
  const modalBox = document.getElementById('modal-box');
  const billingTotalEl = (modalBox && modalBox.querySelector('#billing-total'))
    || document.getElementById('billing-total');
  const total = parseFmt(billingTotalEl?.textContent || document.getElementById('s-total')?.textContent || fmt(0));

  const cambioVal = document.getElementById('cambio-val-contra-entrega');
  const cambioCard = document.getElementById('billing-cambio-card-contra-entrega');
  const faltanEl = document.getElementById('billing-cambio-faltan-contra-entrega');
  if (!cambioVal) return;

  const montoCliente = Number(DB.saleDeliveryPayAmount || 0);
  const diferencia = montoCliente - total;
  const labelEl = cambioCard?.querySelector('.billing-cambio-card-label');

  cambioCard?.classList.remove('cambio-ok', 'cambio-exacto', 'cambio-insuf', 'cambio-neutral');
  if (montoCliente <= 0) {
    cambioVal.textContent = fmt(0);
    cambioCard?.classList.add('cambio-neutral');
    if (labelEl) labelEl.textContent = 'CAMBIO A LLEVAR POR EL REPARTIDOR';
    faltanEl?.classList.add('hidden');
  } else if (diferencia > 0.004) {
    cambioVal.textContent = fmt(diferencia);
    cambioCard?.classList.add('cambio-ok');
    if (labelEl) labelEl.textContent = 'CAMBIO A LLEVAR POR EL REPARTIDOR';
    faltanEl?.classList.add('hidden');
  } else if (Math.abs(diferencia) <= 0.004) {
    cambioVal.textContent = fmt(0);
    cambioCard?.classList.add('cambio-exacto');
    if (labelEl) labelEl.textContent = 'PAGO EXACTO — SIN CAMBIO';
    faltanEl?.classList.add('hidden');
  } else {
    cambioVal.textContent = fmt(Math.abs(diferencia));
    cambioCard?.classList.add('cambio-insuf');
    if (labelEl) labelEl.textContent = 'MONTO INSUFICIENTE';
    if (faltanEl) {
      faltanEl.textContent = `Falta ${fmt(Math.abs(diferencia))}`;
      faltanEl.classList.remove('hidden');
    }
  }

  syncBillingModalFooter();
  syncBillingConfirmSummary();
}

function setMontoRapidoContraEntrega(val, button = null) {
  const amountInput = document.getElementById('monto-recibido-contra-entrega');
  if (!amountInput) return;
  amountInput.value = Number(val).toFixed(2);
  DB.saleDeliveryPayAmount = Number(val) || 0;
  document.querySelectorAll('#contra-entrega-area .billing-v3-quick-btn').forEach((quickButton) => {
    quickButton.classList.remove('active');
  });
  if (button) button.classList.add('active');
  amountInput.focus();
  calcCambioContraEntrega();
}

function setMontoExactoContraEntrega(button = null) {
  const totalEl = document.getElementById('billing-total')?.textContent || fmt(0);
  const total = parseFmt(totalEl);
  const amountInput = document.getElementById('monto-recibido-contra-entrega');
  if (!amountInput) return;
  amountInput.value = total.toFixed(2);
  DB.saleDeliveryPayAmount = total;
  document.querySelectorAll('#contra-entrega-area .billing-v3-quick-btn').forEach((quickButton) => {
    quickButton.classList.toggle('active', quickButton === button);
  });
  calcCambioContraEntrega();
}

function calcCambioUsd() {
  const modalBox = document.getElementById('modal-box');
  const billingTotalEl = (modalBox && modalBox.querySelector('#billing-total'))
    || document.getElementById('billing-total');
  const total = parseFmt(billingTotalEl?.textContent || document.getElementById('s-total')?.textContent || fmt(0));

  const rate = Number(DB.caja?.activeSession?.exchangeRateUsdDop || 0);
  const equivEl = document.getElementById('billing-usd-equiv-val');
  const rateLabelEl = document.getElementById('billing-usd-rate-label');
  const amountInputUsd = document.getElementById('monto-recibido-usd');
  const cambioVal = document.getElementById('cambio-val-usd');
  const cambioCard = document.getElementById('billing-cambio-card-usd');
  const faltanEl = document.getElementById('billing-cambio-faltan-usd');

  if (!rate || rate <= 0) {
    if (equivEl) equivEl.textContent = 'US$ --';
    if (rateLabelEl) rateLabelEl.textContent = 'Sin tasa de cambio para este turno';
    if (cambioVal) cambioVal.textContent = fmt(0);
    _setCambioCardState(cambioCard, faltanEl, 'neutral', '');
    return;
  }

  const usdEquivalent = total / rate;
  if (equivEl) equivEl.textContent = 'US$ ' + usdEquivalent.toFixed(2);
  if (rateLabelEl) rateLabelEl.textContent = 'Tasa del turno: RD$ ' + rate.toFixed(4) + ' por US$1';
  if (!amountInputUsd || !cambioVal) return;

  const rawVal = String(amountInputUsd.value || '').trim();
  const usdRecibido = rawVal === '' ? 0 : (parseFloat(rawVal) || 0);

  if (isNaN(usdRecibido)) {
    cambioVal.textContent = fmt(0);
    _setCambioCardState(cambioCard, faltanEl, 'neutral', '');
    return;
  }

  const cambioDop = (usdRecibido * rate) - total;

  if (usdRecibido <= 0) {
    cambioVal.textContent = fmt(0);
    _setCambioCardState(cambioCard, faltanEl, 'neutral', '');
  } else if (cambioDop > 0.004) {
    cambioVal.textContent = fmt(cambioDop);
    _setCambioCardState(cambioCard, faltanEl, 'ok', '');
  } else if (Math.abs(cambioDop) <= 0.004) {
    cambioVal.textContent = fmt(0);
    _setCambioCardState(cambioCard, faltanEl, 'exacto', '');
  } else {
    cambioVal.textContent = fmt(Math.abs(cambioDop));
    _setCambioCardState(cambioCard, faltanEl, 'insuf', '');
  }

  syncBillingModalFooter();
  syncBillingConfirmSummary();
}

function _setCambioCardState(card, faltanEl, state, faltanText) {
  if (card) {
    card.classList.remove('cambio-ok', 'cambio-exacto', 'cambio-insuf', 'cambio-neutral');
    if (state) card.classList.add(`cambio-${state}`);

    // Actualizar ícono y etiqueta según el estado
    const iconEl  = card.querySelector('.billing-cambio-card-icon');
    const labelEl = card.querySelector('.billing-cambio-card-label');
    if (iconEl && labelEl) {
      switch (state) {
        case 'ok':
          iconEl.textContent  = '✅';
          labelEl.textContent = 'DEVUELTA AL CLIENTE';
          break;
        case 'exacto':
          iconEl.textContent  = '✓';
          labelEl.textContent = 'PAGO EXACTO';
          break;
        case 'insuf':
          iconEl.textContent  = '⚠️';
          labelEl.textContent = 'FALTAN';
          break;
        default:
          iconEl.textContent  = '💵';
          labelEl.textContent = 'DEVUELTA AL CLIENTE';
      }
    }
  }
  if (faltanEl) {
    if (faltanText) {
      faltanEl.textContent = faltanText;
      faltanEl.classList.remove('hidden');
    } else {
      faltanEl.classList.add('hidden');
    }
  }
}

function calcMixto() {
  const totalEl = document.getElementById('s-total')?.textContent || fmt(0);
  const total = parseFmt(totalEl);
  const tarjeta = parseFloat(document.getElementById('mixto-tarjeta')?.value) || 0;
  const efectivo = parseFloat(document.getElementById('mixto-efectivo')?.value) || 0;
  const transferencia = parseFloat(document.getElementById('mixto-transferencia')?.value) || 0;
  billingModalState.mixedCardAmount = tarjeta ? String(tarjeta) : '';
  billingModalState.mixedCashAmount = efectivo ? String(efectivo) : '';
  billingModalState.mixedTransferAmount = transferencia ? String(transferencia) : '';
  const suma = tarjeta + efectivo + transferencia;
  const pendiente = total - suma;
  const cambio = Math.max(0, suma - total);

  const pendienteEl = document.getElementById('mixto-pendiente');
  const statusEl = document.getElementById('mixto-status');
  const cambioRow = document.getElementById('mixto-cambio-row');
  const cambioVal = document.getElementById('mixto-cambio-val');

  if (pendienteEl) pendienteEl.textContent = fmt(Math.max(0, pendiente));
  if (statusEl) {
    if (pendiente <= 0) {
      statusEl.style.display = 'none';
    } else {
      statusEl.style.display = 'flex';
    }
  }
  if (cambioRow) cambioRow.style.display = cambio > 0 ? 'flex' : 'none';
  if (cambioVal) cambioVal.textContent = fmt(cambio);
  syncBillingModalFooter();
  syncBillingConfirmSummary();
}

function setMontoRapido(val, button = null) {
  const amountInput = document.getElementById('monto-recibido');
  if (!amountInput) return;
  // SET directo — Recibido = val (NO sumar al total)
  amountInput.value = Number(val).toFixed(2);
  document.querySelectorAll('.quick-amount-btn').forEach((quickButton) => {
    quickButton.classList.remove('active');
  });
  if (button) button.classList.add('active');
  amountInput.focus();
  calcCambio();
}

function setMontoExacto(button = null) {
  // Usar billing-total (sincronizado) en lugar de s-total para incluir descuento general
  const totalEl = document.getElementById('billing-total')?.textContent || fmt(0);
  const total = parseFmt(totalEl);
  const amountInput = document.getElementById('monto-recibido');
  if (!amountInput) return;
  amountInput.value = total.toFixed(2);
  document.querySelectorAll('.quick-amount-btn').forEach((quickButton) => {
    quickButton.classList.toggle('active', quickButton === button);
  });
  calcCambio();
}

function parseFmt(str) {
  // Formato es-DO: RD$ 2,300.00 (coma = miles, punto = decimal)
  const cleaned = (str || '0').replace(/[^0-9.,-]/g, '');
  // Remover separadores de miles (comas), mantener decimal (punto)
  const normalized = cleaned.replace(/,/g, '');
  return parseFloat(normalized) || 0;
}

function isElectronicReceipt(venta) {
  const documentType = String(venta?.tipoComprobante || '').trim().toLowerCase();
  const encf = String(venta?.encf || venta?.ncf || '').trim().toUpperCase();
  const tipoEcf = String(venta?.tipoEcf || '').trim().toUpperCase();
  return Boolean(
    venta?.esElectronica
    || documentType === 'factura-electronica'
    || tipoEcf.startsWith('E')
    || /^E\d{2}/.test(encf)
  );
}

function getElectronicReceiptNumber(venta) {
  return String(venta?.encf || venta?.ncf || getReceiptInvoiceId(venta) || '').trim();
}

function buildReceiptQrPayload(venta) {
  // La URL de verificación DGII SOLO puede construirse correctamente desde el
  // XML realmente firmado y enviado (RncEmisor, RncComprador, ENCF,
  // FechaEmision, MontoTotal, FechaFirma, CodigoSeguridad deben coincidir
  // exactamente con lo que DGII tiene registrado). El backend la calcula una
  // sola vez (server/.../ecf.repository.js attachSaleSummary, misma lógica
  // que modules/ecf/controllers/repr-impresa.js) y la guarda en venta.qrUrl.
  // Antes existía aquí un generador propio con nombres de parámetro
  // equivocados, ambiente hardcodeado y un "CodigoSeguridad" inventado — DGII
  // nunca podía encontrar esas facturas ("No fue encontrada la factura
  // (e-CF)"). Mejor no mostrar QR que mostrar uno que DGII nunca verificará.
  if (venta?.qrUrl) {
    return String(venta.qrUrl).trim();
  }
  return '';
}

async function ensureReceiptQrData(venta) {
  if (!venta || !isElectronicReceipt(venta)) return null;
  if (venta.qrDataUrl) return venta.qrDataUrl;

  const qrPayload = buildReceiptQrPayload(venta);
  if (!qrPayload) return null;
  const response = await api.generateQr(qrPayload);
  const dataUrl = response?.dataUrl || '';
  if (!dataUrl) throw new Error('QR vacío');
  venta.qrDataUrl = dataUrl;
  return dataUrl;
}

function sanitizePhoneForWhatsApp(phone) {
  let clean = String(phone || '').replace(/[^\d+]/g, '').replace(/\+/g, '');
  if (clean.length === 10) {
    clean = `1${clean}`;
  }
  return clean;
}

function getReceiptInvoiceId(venta) {
  // `documentoFiscal` (NCF real, ej. B0100000001) es lo que se debe MOSTRAR
  // cuando la venta tiene un comprobante fiscal tradicional — `venta.id` es
  // el contador interno FAC-/ECF- que además se usa como clave real de
  // búsqueda en el servidor (reimpresión, devoluciones, pdf-path), así que
  // ese campo no puede cambiar de formato; aquí solo se prioriza para
  // MOSTRAR el número correcto en el recibo/factura impresa.
  return venta.documentoFiscal || venta.id || venta.previewInvoiceNumber || getDocumentSequencePreview(venta.tipoComprobante || 'ticket');
}

function loadImageElement(src) {
  return new Promise((resolve) => {
    if (!src) {
      resolve(null);
      return;
    }
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

function getReceiptCaptureWidth(paperVariant) {
  if (paperVariant === 'a4') return 900;
  if (paperVariant === '58mm') return 300;
  return 420;
}

function getReceiptCaptureScale(paperVariant) {
  if (paperVariant === 'a4') return 2;
  if (paperVariant === '58mm') return 5;
  return 4;
}

async function waitForReceiptCaptureAssets(element) {
  if (!element) return;

  const images = Array.from(element.querySelectorAll('img'));
  await Promise.all(images.map((image) => {
    if (image.complete && image.naturalWidth > 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const finish = () => resolve();
      image.addEventListener('load', finish, { once: true });
      image.addEventListener('error', finish, { once: true });
    });
  }));

  if (document.fonts?.ready) {
    try {
      await document.fonts.ready;
    } catch (_error) {
      // continue even if font readiness fails
    }
  }

  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function generateReceiptHtmlImageDataUrl(venta) {
  await window.VendorLoader.load('html2canvas');
  if (typeof window.html2canvas !== 'function') {
    throw new Error('html2canvas no está disponible para capturar el comprobante.');
  }

  // La factura moderna siempre es A4 → capturar a tamaño A4 sin importar el
  // ajuste de papel del negocio.
  const paperVariant = 'a4';
  const captureWidth = getReceiptCaptureWidth(paperVariant);
  const captureScale = getReceiptCaptureScale(paperVariant);
  const mount = document.createElement('div');
  mount.setAttribute('aria-hidden', 'true');
  mount.style.position = 'fixed';
  mount.style.left = '-10000px';
  mount.style.top = '0';
  mount.style.width = `${captureWidth}px`;
  mount.style.padding = '24px';
  mount.style.background = '#eef2f7';
  mount.style.pointerEvents = 'none';
  mount.style.zIndex = '-1';

  const surface = document.createElement('div');
  surface.style.display = 'inline-block';
  surface.style.background = '#eef2f7';
  surface.innerHTML = buildReceiptSheetMarkup(venta);
  mount.appendChild(surface);
  document.body.appendChild(mount);

  try {
    await waitForReceiptCaptureAssets(surface);
    const target = surface.firstElementChild || surface;
    const canvas = await window.html2canvas(target, {
      backgroundColor: '#ffffff',
      scale: captureScale,
      useCORS: true,
      allowTaint: true,
      logging: false,
      imageTimeout: 0
    });
    const dataUrl = canvas.toDataURL('image/png');
    if (!String(dataUrl || '').startsWith('data:image/')) {
      throw new Error('No se pudo convertir el comprobante a imagen.');
    }
    return dataUrl;
  } finally {
    mount.remove();
  }
}

async function generateRenderedReceiptImageDataUrl() {
  await window.VendorLoader.load('html2canvas');
  if (typeof window.html2canvas !== 'function') {
    throw new Error('html2canvas no está disponible para capturar el comprobante.');
  }

  const overlay = document.getElementById('receipt-overlay');
  const content = document.getElementById('receipt-content');
  const target = content?.firstElementChild;
  if (!overlay || overlay.classList.contains('hidden') || !target) {
    throw new Error('El comprobante visible no está disponible para capturarse.');
  }

  await waitForReceiptCaptureAssets(target);
  const paperVariant = getReceiptPaperVariant();
  const captureScale = getReceiptCaptureScale(paperVariant);
  const canvas = await window.html2canvas(target, {
    backgroundColor: '#ffffff',
    scale: captureScale,
    useCORS: true,
    allowTaint: true,
    logging: false,
    imageTimeout: 0
  });
  const dataUrl = canvas.toDataURL('image/png');
  if (!String(dataUrl || '').startsWith('data:image/')) {
    throw new Error('No se pudo convertir el comprobante visible a imagen.');
  }
  return dataUrl;
}

function buildReceiptMirrorCacheKey(venta) {
  const paperVariant = getReceiptPaperVariant();
  const factura = getReceiptInvoiceId(venta);
  const total = Number(venta?.total || 0).toFixed(2);
  const itemCount = Array.isArray(venta?.items) ? venta.items.length : 0;
  return [paperVariant, factura, total, itemCount].join('|');
}

async function ensureReceiptMirrorImageDataUrl(venta, options = {}) {
  if (!venta) {
    throw new Error('No hay comprobante para preparar la impresión.');
  }

  const cacheKey = buildReceiptMirrorCacheKey(venta);
  if (!options.force && venta._receiptMirrorImageDataUrl && venta._receiptMirrorCacheKey === cacheKey) {
    return venta._receiptMirrorImageDataUrl;
  }

  const isCurrentReceipt = currentReceiptSale && getReceiptInvoiceId(currentReceiptSale) === getReceiptInvoiceId(venta);
  const dataUrl = isCurrentReceipt
    ? await generateRenderedReceiptImageDataUrl().catch(() => generateReceiptHtmlImageDataUrl(venta))
    : await generateReceiptHtmlImageDataUrl(venta);
  venta._receiptMirrorImageDataUrl = dataUrl;
  venta._receiptMirrorCacheKey = cacheKey;
  return dataUrl;
}

function warmReceiptMirrorImage(venta) {
  if (!venta || venta._receiptMirrorImagePromise) {
    return;
  }

  venta._receiptMirrorImagePromise = ensureReceiptMirrorImageDataUrl(venta)
    .catch((error) => {
      console.warn('No se pudo precalentar la imagen del comprobante.', error);
      return null;
    })
    .finally(() => {
      venta._receiptMirrorImagePromise = null;
    });
}

async function generateReceiptImageDataUrl(venta) {
  try {
    return await ensureReceiptMirrorImageDataUrl(venta);
  } catch (error) {
    console.warn('No se pudo capturar el comprobante HTML para WhatsApp. Usando imagen alternativa.', error);
  }

  return generateReceiptFallbackImageDataUrl(venta);
}

async function generateReceiptFallbackImageDataUrl(venta) {
  const cfg = DB.config || {};
  const items = Array.isArray(venta.items) ? venta.items : [];
  const width = 1240;
  const outer = 26;
  const contentLeft = outer + 34;
  const contentRight = width - outer - 34;
  const contentWidth = contentRight - contentLeft;
  const labelColWidth = 250;
  const valueColWidth = contentWidth - labelColWidth - 18;
  const qtyColWidth = 80;
  const priceColWidth = 190;
  const totalColWidth = 200;
  const descColWidth = contentWidth - qtyColWidth - priceColWidth - totalColWidth;
  const logoSize = 82;
  const factura = getReceiptInvoiceId(venta);
  const clientTaxId = String(venta?.clienteRncCedula || venta?.clientTaxId || '').trim();

  const ncfDisplay = venta.ncf || '';
  const ncfTypeLabel = venta.ncfType ? `${venta.ncfType} · ${NCF_LABELS_FE[venta.ncfType] || venta.ncfType}` : '';
  const rows = [
    ['FACTURA', factura],
    ncfDisplay ? ['NCF', ncfDisplay] : null,
    ncfDisplay && venta.ncfVencimiento ? ['NCF VENCE', formatReceiptDateForPaper(venta.ncfVencimiento, '58mm')] : null,
    ncfTypeLabel ? ['TIPO NCF', ncfTypeLabel] : null,
    venta.ncfReferencia ? ['NCF REF', venta.ncfReferencia] : null,
    ['TIPO', SALE_DOCUMENT_TYPES[venta.tipoComprobante] || 'Ticket / Factura'],
    ['PEDIDO', SALE_ORDER_TYPES[venta.tipoPedido] || venta.tipoPedido || 'Mostrador'],
    ['COCINA', venta.estadoCocina || 'Pendiente'],
    ['FECHA', venta.fecha || new Date().toLocaleString('es-DO')],
    ['CAJERO', venta.cajero || '-'],
    ['CLIENTE', venta.razonSocialCliente || venta.cliente || 'Consumidor Final'],
    ['TELEFONO', venta.clienteTelefono || '-'],
    ['TEL. DELIVERY', venta.telefonoDelivery || '-'],
    ['DIRECCION', venta.direccionDelivery || '-'],
    (venta.tipoPedido === 'delivery' && venta.metodo === 'contra_entrega' && Number(venta.montoClienteEntrega || 0) > 0)
      ? ['CLIENTE PAGA CON', fmt(Number(venta.montoClienteEntrega || 0))]
      : null,
    (venta.tipoPedido === 'delivery' && venta.metodo === 'contra_entrega' && Number(venta.montoClienteEntrega || 0) > 0)
      ? ['CAMBIO A LLEVAR', fmt(Number(venta.cambioRepartidor || 0))]
      : null,
    ['RNC / CEDULA', clientTaxId || '-']
  ].filter(Boolean);

  const measureCanvas = document.createElement('canvas');
  measureCanvas.width = width;
  measureCanvas.height = 10;
  const mctx = measureCanvas.getContext('2d');

  const wrapText = (context, text, maxWidth, font) => {
    const normalized = String(text ?? '').trim();
    if (!normalized) return ['-'];
    context.font = font;
    const words = normalized.split(/\s+/).filter(Boolean);
    if (!words.length) return ['-'];

    const lines = [];
    let line = '';
    words.forEach((word) => {
      const candidate = line ? `${line} ${word}` : word;
      if (context.measureText(candidate).width <= maxWidth) {
        line = candidate;
        return;
      }
      if (line) lines.push(line);
      if (context.measureText(word).width <= maxWidth) {
        line = word;
        return;
      }
      let chunk = '';
      word.split('').forEach((char) => {
        const nextChunk = `${chunk}${char}`;
        if (context.measureText(nextChunk).width > maxWidth && chunk) {
          lines.push(chunk);
          chunk = char;
        } else {
          chunk = nextChunk;
        }
      });
      line = chunk;
    });
    if (line) lines.push(line);
    return lines.length ? lines : ['-'];
  };

  const valueFont = '700 34px "Consolas", "Courier New", monospace';
  const labelFont = '700 24px "Consolas", "Courier New", monospace';
  const itemFont = '700 34px "Consolas", "Courier New", monospace';
  const itemMetaFont = '700 30px "Consolas", "Courier New", monospace';

  const measuredRows = rows.map(([label, value]) => {
    const lines = wrapText(mctx, value, valueColWidth, valueFont);
    const rowHeight = Math.max(48, lines.length * 42);
    return { label, lines, rowHeight };
  });
  const rowsHeight = measuredRows.reduce((sum, row) => sum + row.rowHeight, 0);

  const measuredItems = items.map((item) => {
    const nameLines = wrapText(mctx, item?.nombre || 'Producto', descColWidth - 12, itemFont);
    const rowHeight = Math.max(54, nameLines.length * 42 + 8);
    return { item, nameLines, rowHeight };
  });
  const itemsHeight = measuredItems.reduce((sum, row) => sum + row.rowHeight + 18, 0);

  const headerHeight = 320;
  const dataSectionHeight = 100 + rowsHeight;
  const itemsSectionHeight = 150 + itemsHeight;
  const totalsSectionHeight = 300;
  const footerHeight = 100;
  const height = outer * 2 + headerHeight + dataSectionHeight + itemsSectionHeight + totalsSectionHeight + footerHeight;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const drawSeparator = (y) => {
    ctx.save();
    ctx.strokeStyle = '#98a2b3';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 7]);
    ctx.beginPath();
    ctx.moveTo(contentLeft, y);
    ctx.lineTo(contentRight, y);
    ctx.stroke();
    ctx.restore();
  };

  ctx.fillStyle = '#f0f1f3';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(outer, outer, width - (outer * 2), height - (outer * 2));

  let y = outer + 34;
  const logo = await loadImageElement(cfg.logo || '');
  const logoX = (width - logoSize) / 2;
  const logoY = y + 2;
  if (logo) {
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(logoX + (logoSize / 2), logoY + (logoSize / 2), logoSize / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(logoX + (logoSize / 2), logoY + (logoSize / 2), (logoSize / 2) - 5, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(logo, logoX + 5, logoY + 5, logoSize - 10, logoSize - 10);
    ctx.restore();
  } else {
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(logoX + (logoSize / 2), logoY + (logoSize / 2), logoSize / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 28px "Consolas", "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('POS', logoX + (logoSize / 2), logoY + 52);
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = '#111827';
  ctx.font = '800 62px "Consolas", "Courier New", monospace';
  ctx.fillText(cfg.nombre || 'emi_pos', width / 2, logoY + logoSize + 54);
  ctx.fillStyle = '#6b7280';
  ctx.font = '700 20px "Consolas", "Courier New", monospace';
  ctx.fillText('COMPROBANTE DE VENTA', width / 2, logoY + logoSize + 92);

  const chipText = String(factura || 'SIN-NUMERO');
  ctx.font = '800 30px "Consolas", "Courier New", monospace';
  const chipWidth = Math.max(320, ctx.measureText(chipText).width + 80);
  const chipHeight = 56;
  const chipX = (width - chipWidth) / 2;
  const chipY = logoY + logoSize + 124;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 2.5;
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(chipX, chipY, chipWidth, chipHeight, 28);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.fillRect(chipX, chipY, chipWidth, chipHeight);
    ctx.strokeRect(chipX, chipY, chipWidth, chipHeight);
  }
  ctx.fillStyle = '#1f2937';
  ctx.textAlign = 'center';
  ctx.fillText(chipText, chipX + (chipWidth / 2), chipY + 38);

  y += headerHeight;
  drawSeparator(y);
  y += 56;

  ctx.textAlign = 'left';
  ctx.fillStyle = '#1f2937';
  ctx.font = '800 26px "Consolas", "Courier New", monospace';
  ctx.fillText('DATOS DEL COMPROBANTE', contentLeft, y);
  y += 48;

  measuredRows.forEach((row) => {
    const rowTop = y;
    ctx.fillStyle = '#667085';
    ctx.font = labelFont;
    ctx.fillText(row.label, contentLeft, rowTop);

    ctx.fillStyle = '#111827';
    ctx.font = valueFont;
    ctx.textAlign = 'right';
    row.lines.forEach((line, idx) => {
      ctx.fillText(line, contentRight, rowTop + (idx * 42));
    });
    ctx.textAlign = 'left';
    y += row.rowHeight;
  });

  y += 8;
  drawSeparator(y);
  y += 56;

  ctx.fillStyle = '#1f2937';
  ctx.font = '800 26px "Consolas", "Courier New", monospace';
  ctx.fillText('ARTICULOS', contentLeft, y);
  y += 44;

  ctx.fillStyle = '#667085';
  ctx.font = '800 22px "Consolas", "Courier New", monospace';
  ctx.fillText('CANT', contentLeft, y);
  ctx.fillText('DESCRIPCION', contentLeft + qtyColWidth + 12, y);
  ctx.textAlign = 'right';
  ctx.fillText('PRECIO', contentRight - totalColWidth - 12, y);
  ctx.fillText('TOTAL', contentRight, y);
  ctx.textAlign = 'left';
  y += 20;
  drawSeparator(y);
  y += 44;

  measuredItems.forEach((entry) => {
    const item = entry.item || {};
    const rowTop = y;

    ctx.fillStyle = '#111827';
    ctx.font = itemMetaFont;
    ctx.fillText(formatReceiptSaleItemQuantity(item), contentLeft, rowTop);

    ctx.font = itemFont;
    entry.nameLines.forEach((line, idx) => {
      ctx.fillText(line, contentLeft + qtyColWidth + 12, rowTop + (idx * 42));
    });

    ctx.textAlign = 'right';
    ctx.font = itemMetaFont;
    ctx.fillText(fmt(Number(item.precio || 0)), contentRight - totalColWidth - 12, rowTop);
    ctx.fillText(fmt(Number(item.total || 0)), contentRight, rowTop);
    ctx.textAlign = 'left';

    y += entry.rowHeight + 18;
    drawSeparator(y - 8);
    y += 16;
  });

  y += 10;
  const totals = buildReceiptSummaryRows(venta).map(([label, value]) => [
    String(label || '').toUpperCase(),
    String(value || '')
  ]);
  totals.push(['TOTAL', fmt(Number(venta.total || 0))]);
  totals.push(['PAGADO', fmt(Number(venta.recibido || 0))]);
  totals.push(['CAMBIO', fmt(Number(venta.cambio || 0))]);
  totals.push(['METODO', SALE_PAYMENT_TYPES[venta.metodo] || venta.metodo || 'Efectivo']);
  if (venta.paymentCurrency === 'USD') {
    totals.push(['RECIBIDO USD', 'US$ ' + Number(venta.usdAmountReceived || 0).toFixed(2)]);
    totals.push(['TASA USD', Number(venta.exchangeRateUsed || 0).toFixed(4)]);
  }

  totals.forEach(([label, value]) => {
    const isTotal = label === 'TOTAL';
    ctx.fillStyle = isTotal ? '#111827' : '#374151';
    ctx.font = isTotal
      ? '900 42px "Consolas", "Courier New", monospace'
      : '800 30px "Consolas", "Courier New", monospace';
    ctx.fillText(label, contentLeft, y);
    ctx.textAlign = 'right';
    ctx.fillText(String(value || '-'), contentRight, y);
    ctx.textAlign = 'left';
    y += isTotal ? 56 : 42;
  });

  y += 14;
  drawSeparator(y);
  y += 56;
  ctx.fillStyle = '#6b7280';
  ctx.font = '700 24px "Consolas", "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.fillText(cfg.mensaje || 'Gracias por su compra.', width / 2, y);
  ctx.textAlign = 'left';

  return canvas.toDataURL('image/png');
}

async function getLogoDataUrl(src) {
  const image = await loadImageElement(src);
  if (!image) return null;
  const sourceWidth = image.naturalWidth || image.width || 0;
  const sourceHeight = image.naturalHeight || image.height || 0;
  if (!sourceWidth || !sourceHeight) return null;

  const maxSide = 420;
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

async function generateReceiptPdf(venta, options = {}) {
  // Preferir el render HTML → PDF: mismo diseño de la factura A4 moderna que se
  // ve en pantalla y se imprime. Devuelve un objeto mínimo compatible con lo que
  // esperan los llamadores (doc.output('datauristring') / doc.save(nombre)).
  if (window.novaDesktop?.htmlToPdf) {
    try {
      const b64 = await window.novaDesktop.htmlToPdf(buildFormalInvoiceDocumentHtml(venta));
      if (b64) {
        const dataUri = `data:application/pdf;base64,${b64}`;
        const shim = {
          output: (kind) => (kind === 'datauristring' || kind === 'dataurlstring') ? dataUri : b64,
          save: (filename) => {
            try {
              const a = document.createElement('a');
              a.href = dataUri;
              a.download = filename || `factura-${getReceiptInvoiceId(venta)}.pdf`;
              document.body.appendChild(a);
              a.click();
              a.remove();
            } catch (_e) { /* noop */ }
          }
        };
        if (options.download !== false) shim.save(`factura-${getReceiptInvoiceId(venta)}.pdf`);
        return shim;
      }
    } catch (bridgeErr) {
      console.warn('htmlToPdf no disponible para la factura; usando layout jsPDF.', bridgeErr);
    }
  }
  if (typeof window._loadPdfLibs === 'function') await window._loadPdfLibs();
  const jsPdfApi = window.jspdf?.jsPDF;
  if (!jsPdfApi) {
    throw new Error('La librería PDF no está disponible.');
  }

  const cfg = DB.config || {};
  const items = Array.isArray(venta.items) ? venta.items : [];
  const paperVariant = getReceiptPaperVariant();
  const isA4Landscape = paperVariant === 'a4';
  const pageWidth = isA4Landscape ? 842 : 315;
  const pageHeight = isA4Landscape
    ? Math.max(595, 430 + (items.length * 24) + (venta.notasPedido ? 28 : 0) + (venta.direccionDelivery ? 24 : 0))
    : Math.max(560, 410 + (items.length * 42) + (venta.notasPedido ? 40 : 0) + (venta.direccionDelivery ? 34 : 0));
  const doc = new jsPdfApi({ unit: 'pt', format: [pageWidth, pageHeight] });
  const margin = isA4Landscape ? 34 : 22;
  let y = 28;

  const drawDivider = () => {
    doc.setDrawColor(170, 170, 170);
    doc.setLineDashPattern([2, 2], 0);
    doc.line(margin, y, pageWidth - margin, y);
    doc.setLineDashPattern([], 0);
    y += 14;
  };

  const drawKeyValue = (label, value, bold = false, topGap = 0) => {
    y += topGap;
    doc.setFont('helvetica', bold ? 'bold' : 'bold');
    doc.setFontSize(bold ? 11 : 10);
    doc.text(label, margin, y);
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    const lines = doc.splitTextToSize(String(value || ''), pageWidth - (isA4Landscape ? 210 : 120));
    doc.text(lines, pageWidth - margin, y, { align: 'right' });
    y += Math.max(16, lines.length * 12);
  };

  const invoiceId = getReceiptInvoiceId(venta);
  const logoDataUrl = await getLogoDataUrl(cfg.logo || '');

  if (logoDataUrl) {
    doc.addImage(logoDataUrl, 'PNG', margin, y - 6, 34, 34);
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text(cfg.nombre || 'Tecno Caja', logoDataUrl ? margin + 44 : margin, y + 10);
  y += 22;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(90, 90, 90);
  doc.text(cfg.direccion || '', pageWidth / 2, y, { align: 'center' });
  y += 14;
  doc.text(`Tel: ${cfg.telefono || ''}   |   RNC: ${cfg.rnc || ''}`, pageWidth / 2, y, { align: 'center' });
  doc.setTextColor(20, 20, 20);
  y += 18;

  drawDivider();
  drawKeyValue('Factura:', invoiceId);
  drawKeyValue('Tipo:', SALE_DOCUMENT_TYPES[venta.tipoComprobante] || 'Ticket / Factura');
  if (isElectronicReceipt(venta) && getElectronicReceiptNumber(venta)) {
    drawKeyValue('e-NCF:', getElectronicReceiptNumber(venta));
  }
  if (!isElectronicReceipt(venta) && venta.ncf) {
    drawKeyValue('NCF:', venta.ncf);
  }
  if (venta.ncfType) {
    drawKeyValue('Tipo NCF:', `${venta.ncfType} · ${NCF_LABELS_FE[venta.ncfType] || venta.ncfType}`);
  }
  if (!isElectronicReceipt(venta) && venta.ncf && venta.ncfVencimiento) {
    drawKeyValue('NCF vence:', formatReceiptDateForPaper(venta.ncfVencimiento, paperVariant));
  }
  drawKeyValue('Pedido:', SALE_ORDER_TYPES[venta.tipoPedido] || venta.tipoPedido || 'Mostrador');
  drawKeyValue('Cocina:', venta.estadoCocina || 'pendiente');
  drawKeyValue('Fecha:', venta.fecha);
  drawKeyValue('Cajero:', venta.cajero);
  drawKeyValue('Cliente:', venta.cliente);
  if (venta.clienteTelefono) drawKeyValue('Teléfono:', venta.clienteTelefono);
  if (venta.clienteRncCedula) drawKeyValue('RNC / Céd.:', venta.clienteRncCedula);
  if (venta.direccionDelivery) drawKeyValue('Dirección:', venta.direccionDelivery);
  if (venta.tipoPedido === 'delivery' && venta.metodo === 'contra_entrega' && Number(venta.montoClienteEntrega || 0) > 0) {
    drawKeyValue('Cliente paga con:', fmt(Number(venta.montoClienteEntrega || 0)));
    drawKeyValue('Cambio a llevar:', fmt(Number(venta.cambioRepartidor || 0)));
  }
  if (venta.notasPedido) drawKeyValue('Notas:', venta.notasPedido);

  drawDivider();
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('ARTÍCULOS', margin, y);
  y += 18;

  items.forEach((item) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    const itemName = doc.splitTextToSize(item.nombre, pageWidth - (margin * 2) - (isA4Landscape ? 120 : 0));
    doc.text(itemName, margin, y);
    y += itemName.length * 12;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(85, 85, 85);
    doc.text(`${formatReceiptSaleItemQuantity(item)} x ${fmt(item.precio)}`, margin, y);
    doc.text(fmt(item.total), pageWidth - margin, y, { align: 'right' });
    doc.setTextColor(20, 20, 20);
    y += 18;
  });

  drawDivider();
  buildReceiptSummaryRows(venta).forEach(([label, value]) => {
    drawKeyValue(`${label}:`, value, false);
  });
  y += 4;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('TOTAL:', margin, y);
  doc.text(fmt(venta.total), pageWidth - margin, y, { align: 'right' });
  y += 18;
  drawKeyValue('Pagado:', fmt(venta.recibido), false);
  drawKeyValue('Cambio:', fmt(venta.cambio), false);
  drawKeyValue('Método:', SALE_PAYMENT_TYPES[venta.metodo] || 'Efectivo', false);

  y += 4;
  drawDivider();
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(95, 95, 95);
  doc.text(cfg.mensaje || 'Gracias por su compra.', pageWidth / 2, y + 8, { align: 'center' });
  doc.setTextColor(20, 20, 20);

  if (options.download !== false) {
    doc.save(`factura-${invoiceId}.pdf`);
  }

  return doc;
}

async function renderReceiptQr(venta) {
  const qrBox = document.getElementById('receipt-qr');
  if (!qrBox) return;

  if (!isElectronicReceipt(venta)) {
    qrBox.classList.add('hidden');
    qrBox.innerHTML = '';
    return;
  }

  qrBox.classList.remove('hidden');
  qrBox.innerHTML = '<small>Generando código QR fiscal...</small>';

  try {
    const dataUrl = await ensureReceiptQrData(venta);
    qrBox.innerHTML = dataUrl
      ? `
        <img src="${dataUrl}" alt="Código QR de factura electrónica">
        <small>Escaneo de verificación DGII para ${getElectronicReceiptNumber(venta) || getReceiptInvoiceId(venta)}</small>
      `
      : '<small>DGII aún no ha confirmado este e-CF — el QR aparecerá cuando esté aceptado.</small>';
  } catch (_error) {
    qrBox.innerHTML = '<small>No se pudo generar el código QR fiscal.</small>';
  }
}

function buildSalePayload() {
  if (!DB.saleItems.length) { showToast('Agrega productos a la venta', 'warning'); return; }
  if (!(DB.config?.cajaAbierta || DB.caja?.abierta || cajaAbierta)) {
    _showCajaRequiredModal();
    return;
  }
  if (!validateSaleItemsBeforeCheckout()) return null;
  const generalDisc = getGeneralDiscountValue();
  const saleTotals = calcularTotales(DB.saleItems, {
    generalDiscountRate: generalDisc,
    config: DB.config
  });
  const total = saleTotals.total;
  if (!(total > 0)) {
    showToast('No existen productos válidos para cobrar.', 'error');
    return null;
  }
  let recibido = 0;
  let montoTarjeta = 0;
  let montoEfectivo = 0;
  let montoTransferencia = 0;
  let usdRecibido = 0;
  let usdRate = 0;
  if (DB.payMethod === 'mixto') {
    montoTarjeta = parseFloat(document.getElementById('mixto-tarjeta')?.value) || 0;
    montoEfectivo = parseFloat(document.getElementById('mixto-efectivo')?.value) || 0;
    montoTransferencia = parseFloat(document.getElementById('mixto-transferencia')?.value) || 0;
    recibido = montoTarjeta + montoEfectivo + montoTransferencia;
  } else if (DB.payMethod === 'contra_entrega' || DB.payMethod === 'credito') {
    recibido = 0;
  } else if (DB.payMethod === 'usd') {
    usdRate = Number(DB.caja?.activeSession?.exchangeRateUsdDop || 0);
    usdRecibido = parseFloat(document.getElementById('monto-recibido-usd')?.value) || 0;
    recibido = usdRecibido * usdRate;
  } else {
    recibido = parseFloat(document.getElementById('monto-recibido')?.value) || 0;
  }

  if (DB.payMethod === 'usd' && (!usdRate || usdRate <= 0)) {
    showToast('No hay un tipo de cambio válido para este turno. No se puede cobrar en dólares.', 'error');
    return null;
  }
  if ((DB.payMethod === 'efectivo' || DB.payMethod === 'usd') && recibido < total) {
    showToast(
      DB.payMethod === 'usd'
        ? 'Monto en dólares insuficiente. Faltan US$ ' + ((total - recibido) / usdRate).toFixed(2)
        : 'Monto recibido insuficiente',
      'error'
    );
    return null;
  }
  if (DB.payMethod === 'mixto') {
    if (montoTarjeta <= 0 && montoEfectivo <= 0) {
      showToast('Ingresa al menos un monto en tarjeta o efectivo', 'error'); return null;
    }
    if (recibido < total) {
      showToast(`Faltan RD$ ${fmt(total - recibido)} para completar el pago mixto`, 'error'); return null;
    }
  }
  if (DB.payMethod === 'contra_entrega' && (DB.saleOrderType || document.getElementById('sale-order-type')?.value) !== 'delivery') {
    showToast('Pago contra entrega solo aplica a pedidos delivery.', 'error'); return null;
  }
  if ((DB.saleOrderType || document.getElementById('sale-order-type')?.value) === 'delivery' && !DB.saleDeliveryUserId) {
    showToast('Debes asignar un delivery al pedido.', 'error'); return null;
  }
  if (DB.payMethod === 'contra_entrega') {
    if (!String(DB.saleDeliveryAddress || '').trim()) {
      showToast('La dirección es obligatoria para contra entrega.', 'error');
      return null;
    }
    if (!String(DB.saleDeliveryPhone || '').trim()) {
      showToast('El teléfono es obligatorio para contra entrega.', 'error');
      return null;
    }
    if (Number(DB.saleDeliveryPayAmount || 0) < total) {
      showToast('El monto con que pagará el cliente es menor al total. Corrígelo antes de cobrar.', 'error');
      return null;
    }
  }
  const client = getSelectedSaleClient();
  const tipoComprobante = DB.saleDocumentType || 'ticket';
  const ncfType = DB.saleNcfType || '';

  if (DB.payMethod === 'credito' && !client) {
    showToast('Selecciona un cliente para registrar una factura a crédito.', 'error');
    return null;
  }

  if (tipoComprobante === 'factura-electronica') {
    if (!DB.config.eInvoiceEnabled) {
      showToast('La factura electrónica está deshabilitada en configuración', 'error');
      return null;
    }
    const buyerRnc = (DB.saleRncCliente || '').trim() || (client?.rnc || '').trim();
    if (buyerRnc && ![9, 11].includes(buyerRnc.replace(/\D/g, '').length)) {
      showToast('El RNC del cliente para e-CF debe tener 9 u 11 dígitos.', 'error');
      return null;
    }
  }

  // Front-end NCF validations
  if (ncfType === 'B01') {
    // El servidor (POST /api/sales) solo exige un RNC válido, NO un cliente
    // registrado — B01 se puede facturar a un "cliente rápido" con solo su
    // RNC/cédula, sin haberlo agregado antes al sistema.
    const rnc = (DB.saleRncCliente || '').trim() || (client?.rnc || '').trim() || (client?.cedula || '').trim();
    if (!(rnc && [9, 11].includes(String(rnc).replace(/\D/g, '').length))) {
      showToast('B01 (Crédito Fiscal) requiere un RNC válido (9 u 11 dígitos).', 'error');
      return null;
    }
  }
  if (['B14', 'B15'].includes(ncfType) && !client) {
    showToast(`${ncfType} requiere un cliente registrado.`, 'error');
    return null;
  }
  if (['B03','B04'].includes(ncfType) && !DB.saleNcfReferencia) {
    showToast(`${ncfType} requiere seleccionar la factura original.`, 'error'); return null;
  }
  if (DB.payMethod === 'credito' && !billingModalState.creditDueDate) {
    showToast('Define una fecha de vencimiento para la factura a crédito.', 'error');
    return null;
  }

  return {
    fecha: new Date().toISOString(),  // ISO 8601 — parseable en servidor, BD y reportes
    id: getDocumentSequencePreview(tipoComprobante),
    previewInvoiceNumber: getDocumentSequencePreview(tipoComprobante),
    cajero: DB.currentUser.nombre,
    // Si no hay cliente registrado pero sí se escribió un RNC/cédula con
    // nombre (cliente rápido, sin crearlo en el sistema), ese nombre es el
    // que se muestra en el ticket/recibo en vez de "Consumidor Final".
    cliente: client?.nombre || DB.saleRazonSocial || 'Consumidor Final',
    clienteTelefono: client?.telefono || '',
    userId: DB.currentUser.id,
    clientId: client?.id || null,
    clientTaxId: client?.cedula || '',
    tipoComprobante,
    ncfType: ncfType || null,
    rncCliente: DB.saleRncCliente || client?.rnc || '',
    razonSocialCliente: DB.saleRazonSocial || client?.razon_social || '',
    ncfReferencia: DB.saleNcfReferencia || null,
    tipoPedido: DB.saleOrderType || document.getElementById('sale-order-type')?.value || 'mostrador',
    estadoCocina: DB.saleKitchenStatus || document.getElementById('sale-kitchen-status')?.value || 'pendiente',
    repartidorId: DB.saleDeliveryUserId || null,
    repartidor: getDeliveryUsers().find((user) => user.id === DB.saleDeliveryUserId)?.nombre || '',
    repartidorCorreo: getDeliveryUsers().find((user) => user.id === DB.saleDeliveryUserId)?.email || '',
    telefonoDelivery: DB.saleDeliveryPhone || '',
    direccionDelivery: DB.saleDeliveryAddress || '',
    referenciaDelivery: DB.saleDeliveryReference || '',
    linkUbicacionDelivery: DB.saleDeliveryLink || '',
    mesa: DB.saleTableLabel || '',
    notasPedido: DB.saleOrderNotes || '',
    metodo: DB.payMethod,
    montoTarjeta: DB.payMethod === 'mixto' ? montoTarjeta : 0,
    montoEfectivo: DB.payMethod === 'mixto' ? montoEfectivo : 0,
    montoTransferencia: DB.payMethod === 'mixto' ? montoTransferencia : 0,
    responsableVenta: billingModalState.responsibleType,
    paymentDetails: {
      cardBank: billingModalState.cardBank || '',
      cardReference: billingModalState.cardReference || '',
      cardType: billingModalState.cardType || '',
      transferBank: billingModalState.transferBank || '',
      transferReference: billingModalState.transferReference || '',
      transferCaptureName: billingModalState.transferCaptureName || '',
      creditDueDate: billingModalState.creditDueDate || '',
      creditNotes: billingModalState.creditNotes || ''
    },
    items: DB.saleItems.map((item) => {
      const normalizedItem = normalizeSaleItem(item);
      return {
        id: normalizedItem.id,
        codigo: normalizedItem.codigo || '',
        nombre: normalizedItem.nombre,
        qty: normalizedItem.qty,
        precio: normalizedItem.precio,
        descuento: normalizedItem.descuento,
        itbis: normalizedItem.itbis,
        itbisModo: normalizedItem.itbisModo || 'porcentaje',
        itbisMontoUnit: normalizedItem.itbisModo === 'monto' ? Number(normalizedItem.itbisMontoUnit || 0) : 0,
        total: normalizedItem.total,
        subtotal: calculateSaleItemNet(normalizedItem),
        impuestoMonto: calculateSaleItemTax(normalizedItem, { config: DB.config, generalDiscountRate: generalDisc }),
        saleMode: normalizedItem.saleMode,
        unitLabel: normalizedItem.unitLabel,
        weightUnit: normalizedItem.weightUnit,
        scaleWeight: normalizedItem.scaleWeight,
        scaleMeasuredValue: normalizedItem.scaleMeasuredValue,
        scaleMeasuredUnit: normalizedItem.scaleMeasuredUnit,
        scaleSource: normalizedItem.scaleSource,
        scaleRawReading: normalizedItem.scaleRawReading,
        quickSale: normalizedItem.quickSale === true
      };
    }),
    subtotal: saleTotals.subtotal,
    subtotalGravado: saleTotals.subtotalGravado,
    subtotalExento: saleTotals.subtotalExento,
    descuento: saleTotals.discount,
    itbis: saleTotals.itbis,
    total: saleTotals.total,
    recibido: recibido,
    cambio: (DB.payMethod === 'contra_entrega' || DB.payMethod === 'credito') ? 0 : Math.max(0, recibido - total),
    montoClienteEntrega: DB.payMethod === 'contra_entrega' ? Number(DB.saleDeliveryPayAmount || 0) : 0,
    cambioRepartidor: DB.payMethod === 'contra_entrega' ? Math.max(0, Number(DB.saleDeliveryPayAmount || 0) - total) : 0,
    paymentCurrency: DB.payMethod === 'usd' ? 'USD' : 'DOP',
    usdAmountReceived: DB.payMethod === 'usd' ? usdRecibido : 0,
    exchangeRateUsed: DB.payMethod === 'usd' ? usdRate : null,
    sourceQuotationId: activeRecoveredQuotationId || null,
    sourceQuotationName: activeRecoveredQuotationName || '',
    ...(typeof getBusinessStructurePayload === 'function' ? getBusinessStructurePayload() : {}),
    ...getActorPayload()
  };
}

async function processSale(action = 'print') {
  if (_billingSubmitting) return;
  const billingCaps = window.TecnoCajaBilling?.getEffectiveBillingCapabilities
    ? window.TecnoCajaBilling.getEffectiveBillingCapabilities()
    : { canCreateSales: true };
  if (!billingCaps.canCreateSales) {
    showToast(`Tu usuario está configurado como ${billingCaps.userTypeLabel || 'Cobro'} y no puede emitir ventas nuevas desde esta caja.`, 'warning');
    return;
  }
  if (buildBillingValidationBuckets().confirm.length) {
    showToast(buildBillingValidationBuckets().confirm[0], 'warning');
    return;
  }
  _billingSubmitting = true;
  syncBillingModalFooter();
  try {
    const venta = buildSalePayload();
    if (!venta) return;

    pendingSaleConfirmation = venta;
    closeAllModals(true, 'success');
    await finalizePendingSale(action);
  } finally {
    _billingSubmitting = false;
    syncBillingModalFooter();
  }
}

/**
 * Abre la gaveta registradora si está configurada y habilitada.
 * No lanza errores — falla silenciosamente para no interrumpir el cobro.
 */
function _tryOpenCashDrawer() {
  if (!window.novaDesktop?.openCashDrawer) return;

  const enabled = getReceiptConfigValue('cashDrawerEnabled');
  if (!enabled || enabled === 'false' || enabled === false) return;

  const receiptPrinterName = String(getReceiptConfigValue('receiptPrinterName') || '').trim();
  const drawerPrinterName = String(getReceiptConfigValue('cashDrawerPrinterName') || '').trim();
  const useReceiptPrinter = !drawerPrinterName
    || (/generic\s*\/?\s*text\s*only/i.test(drawerPrinterName) && receiptPrinterName && !/generic\s*\/?\s*text\s*only/i.test(receiptPrinterName));

  const cfg = {
    method:       getReceiptConfigValue('cashDrawerMethod')      || 'escpos',
    printerName:  useReceiptPrinter ? receiptPrinterName : drawerPrinterName,
    pin:          Number(getReceiptConfigValue('cashDrawerPin')  ?? 0),
    networkHost:  getReceiptConfigValue('cashDrawerNetworkHost') || '',
    networkPort:  Number(getReceiptConfigValue('cashDrawerNetworkPort') || 9100),
    serialPort:   getReceiptConfigValue('cashDrawerSerialPort')  || 'COM1',
  };

  window.novaDesktop.openCashDrawer(cfg).then(result => {
    if (!result?.ok) {
      console.warn('[gaveta] No se pudo abrir:', result?.error);
    }
  }).catch(err => {
    console.warn('[gaveta] Error:', err?.message);
  });
}

let _saleSubmitting = false;
async function finalizePendingSale(action = 'charge') {
  if (!pendingSaleConfirmation) {
    showToast('No hay una factura pendiente por confirmar.', 'warning');
    return;
  }
  if (_saleSubmitting) return;
  _saleSubmitting = true;

  // CRÍTICO: capturar y limpiar ANTES del await para evitar re-uso del payload
  // si el servidor tarda o hay un error de red y el cajero reintenta.
  const salePayload = pendingSaleConfirmation;
  pendingSaleConfirmation = null;

  const confirmBtns = document.querySelectorAll('.receipt-confirm-btn');
  confirmBtns.forEach(b => { b.disabled = true; b.style.opacity = '0.6'; });

  try {
    const sourceQuotationId = salePayload?.sourceQuotationId || null;
    const billingCaps = window.TecnoCajaBilling?.getEffectiveBillingCapabilities
      ? window.TecnoCajaBilling.getEffectiveBillingCapabilities()
      : { canCreateSales: true, forcePendingCharge: false };

    if (!billingCaps.canCreateSales) {
      showToast(`Tu usuario está configurado como ${billingCaps.userTypeLabel || 'Cobro'} y no puede emitir ventas nuevas desde esta caja.`, 'warning');
      return;
    }
    if (billingCaps.forcePendingCharge) {
      salePayload.pendienteCobro = true;
    }

    // Preparar impresora y logo mientras el servidor guarda la venta. Así,
    // al recibir el número de factura solo queda enviar los bytes.
    if (action === 'print') {
      warmReceiptPrintPipeline().catch(() => {});
    }
    const response = await api.createSale(salePayload);
    const savedVenta = {
      ...response.sale,
      clienteTelefono: response.sale?.clienteTelefono || salePayload?.clienteTelefono || ''
    };
    DB.config = { ...DB.config, ...(response.config || {}) };

    // Enviar el trabajo a la impresora en cuanto el servidor confirma la
    // venta. Antes se esperaba a refrescar productos, inventario, reportes,
    // auditoría y notificaciones; en equipos modestos eso agregaba varios
    // segundos aunque la impresora estuviera lista. La impresión continúa en
    // paralelo y nunca bloquea al cajero ni el cierre visual de la venta.
    let receiptPrintStarted = false;
    if (action === 'print') {
      receiptPrintStarted = true;
      printReceipt(savedVenta).catch((err) => {
        console.warn('[venta] Error imprimiendo recibo:', err);
        showToast('No se pudo imprimir el recibo. Revisa la impresora.', 'error');
      });
    }

    if (response.updatedClient?.id) {
      const clientIndex = DB.clientes.findIndex((client) => client.id === response.updatedClient.id);
      if (clientIndex >= 0) {
        DB.clientes[clientIndex] = { ...DB.clientes[clientIndex], ...response.updatedClient };
      }
      if (typeof loadClientesTable === 'function') {
        loadClientesTable(document.getElementById('clientes-search')?.value || '');
      }
    }

    // BUG 17 fix: solo descontar stock a productos que controlan inventario
    DB.saleItems.forEach(item => {
      const prod = DB.productos.find(p => p.id === item.id);
      if (prod && prod.tracksStock !== false) {
        prod.stock = Math.max(0, prod.stock - item.qty);
      }
    });

    const esPendienteCobro = String(savedVenta.estadoVenta || savedVenta.sale_status || '').trim() === 'pendiente_cobro';

    DB.ventas.unshift(savedVenta);
    if (sourceQuotationId) {
      try {
        await api.deleteQuotation(sourceQuotationId, getActorPayload());
        DB.cotizaciones = (DB.cotizaciones || []).filter((item) => item.id !== sourceQuotationId);
      } catch (quotationError) {
        const quotationMessage = String(quotationError?.message || '');
        if (/ya no existe/i.test(quotationMessage)) {
          DB.cotizaciones = (DB.cotizaciones || []).filter((item) => item.id !== sourceQuotationId);
        } else {
          showToast('La venta se guardó, pero no se pudo eliminar la cotización usada.', 'warning');
        }
      }
    }
    syncCajaState();

    if (esPendienteCobro) {
      cancelSale();
      loadProductsTable();
      loadInventoryTable();
      loadVentasHistory();
      updateReportes();
      updateInventoryStats();
      if (typeof syncConfigForm === 'function') syncConfigForm();
      syncSaleFiscalControls();
      refreshAuditLogs();
      updateNotifications();
      showToast(`Factura ${savedVenta.id} enviada a cola de cobro`, 'info');
      if (typeof loadColaCobro === 'function') loadColaCobro();
      return;
    }

    if (action === 'print') {
      // En impresión directa no detener al cajero en el modal mientras el
      // spooler de Windows tarda uno o dos segundos en mover el papel.
      // Conservamos el comprobante actual para el botón Reimprimir.
      currentReceiptSale = savedVenta;
      currentReceiptOptions = { pending: false };
      closeReceipt();
    } else {
      showReceipt(savedVenta, { pending: false });
    }

    // Pedido facturado por completo: si venía de una cotización del bot de
    // WhatsApp (con teléfono del cliente), enviarle la factura ya lista.
    console.log('[wa-bot] Venta finalizada, ¿venía de cotización?', { sourceQuotationId });
    if (sourceQuotationId) {
      sendReceiptToWhatsAppBotAuto(savedVenta);
    }

    cancelSale();
    loadProductsTable();
    loadInventoryTable();
    loadVentasHistory();
    updateReportes();
    updateInventoryStats();
    if (typeof syncConfigForm === 'function') syncConfigForm();
    syncSaleFiscalControls();
    refreshAuditLogs();
    updateNotifications();
    showToast('Venta procesada: ' + savedVenta.id, 'success');

    // ── Abrir gaveta automáticamente (no bloquea el flujo) ──
    _tryOpenCashDrawer();

    // ── Guardar PDF automáticamente en disco (no bloquea el flujo) ──
    _tryAutoSaveInvoicePdf(savedVenta);

    if (action === 'print' && !receiptPrintStarted) {
      // Fire-and-forget: la impresión corre en background para que el cajero
      // pueda seguir con la próxima venta sin esperar a la impresora.
      // printReceipt ya maneja errores internamente con toasts.
      printReceipt(savedVenta).catch((err) => {
        console.warn('[venta] Error imprimiendo recibo:', err);
        showToast('No se pudo imprimir el recibo. Revisa la impresora.', 'error');
      });
    } else if (action === 'whatsapp') {
      await sendReceiptToWhatsApp(savedVenta);
    }
  } catch (error) {
    if (error?.code === 'NO_ACTIVE_SESSION' || error?.statusCode === 409 || /no hay.*caja.*abierta/i.test(error?.message || '')) {
      showToast('Debes abrir la caja antes de registrar ventas. Ve al módulo de Caja y ábrela.', 'warning');
      // Refrescar el estado de la caja por si cambió desde otro terminal
      if (typeof refreshCajaFromServer === 'function') {
        refreshCajaFromServer().catch(() => {});
      }
    } else {
      showToast(error.message, 'error');
    }
  } finally {
    _saleSubmitting = false;
    document.querySelectorAll('.receipt-confirm-btn').forEach(b => { b.disabled = false; b.style.opacity = ''; });
  }
}

async function _tryAutoSaveInvoicePdf(venta) {
  // Only available in Electron desktop app
  if (!window.novaDesktop?.saveInvoicePdf) return;
  try {
    const doc = await generateReceiptPdf(venta, { download: false });
    if (!doc) return;
    const pdfBase64 = doc.output('datauristring');
    if (!pdfBase64) return;

    const cfg = DB.config || {};
    const result = await window.novaDesktop.saveInvoicePdf({
      invoiceNumber:  venta.id || venta.invoiceNumber || 'FACTURA',
      clientName:     venta.razonSocialCliente || venta.cliente || 'Consumidor-Final',
      date:           venta.fechaEmisionFiscal || venta.fecha || new Date().toISOString(),
      businessName:   cfg.nombre || 'Tecno Caja',
      branchName:     venta.branchName || venta.sucursal || 'Principal',
      pdfBase64
    });

    if (result?.ok && result.filePath) {
      // Store the path in the database asynchronously — fire and forget
      fetch(`/api/sales/${encodeURIComponent(venta.id)}/pdf-path`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken || ''}` },
        body: JSON.stringify({ pdfPath: result.filePath })
      }).catch(() => {});
    }
  } catch (_) {
    // Silent — PDF saving is a background task and must never block the POS
  }
}

function escapeReceiptHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeReceiptText(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatReceiptDateForPaper(value, paperVariant) {
  const normalized = normalizeReceiptText(value);
  if (!normalized) return '';

  if (/^\d{4}-\d{2}-\d{2}T/.test(normalized)) {
    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) {
      const yyyy = parsed.getFullYear();
      const mm = String(parsed.getMonth() + 1).padStart(2, '0');
      const dd = String(parsed.getDate()).padStart(2, '0');
      const hh = String(parsed.getHours()).padStart(2, '0');
      const min = String(parsed.getMinutes()).padStart(2, '0');
      return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
    }
  }

  // Fecha sin hora (columnas DATE tipo ncfVencimiento): "2027-12-31" → "31/12/2027".
  const dateOnlyMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const [, yyyy, mm, dd] = dateOnlyMatch;
    return `${dd}/${mm}/${yyyy}`;
  }

  return normalized
    .replace(/,\s*/g, ' ')
    .replace(/:(\d{2})(?=\s*(a\. m\.|p\. m\.|am|pm)?$)/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getReceiptDisplayNumber(venta) {
  return venta?.id || venta?.previewInvoiceNumber || 'Sin número';
}

function getReceiptConfigOverride() {
  return currentReceiptOptions?.configOverride || null;
}

function getReceiptConfigValue(field) {
  return getReceiptConfigOverride()?.[field] ?? getEffectiveConfig()[field] ?? '';
}

function buildReceiptWhatsAppMessage(venta) {
  return [
    `${getReceiptConfigValue('nombre') || 'Tecno Caja'}`,
    `Factura: ${getReceiptDisplayNumber(venta)}`,
    `Cliente: ${venta.cliente}`,
    `Total: ${fmt(venta.total)}`,
    venta.metodo === 'mixto'
      ? `Método: Mixto (Tarjeta RD$ ${fmt(venta.montoTarjeta || 0)} + Efectivo RD$ ${fmt(venta.montoEfectivo || 0)})`
      : `Método: ${SALE_PAYMENT_TYPES[venta.metodo] || venta.metodo}`,
    `Fecha: ${formatReceiptDateForPaper(venta.fecha, '80mm')}`,
    '',
    'Gracias por su compra.'
  ].join('\n');
}

function getReceiptWhatsAppPhone(venta) {
  return sanitizePhoneForWhatsApp(venta?.clienteTelefono || venta?.telefonoDelivery || '');
}

async function buildReceiptPdfForWhatsApp(venta) {
  // Misma factura A4 moderna, vía el puente Electron htmlToPdf.
  if (window.novaDesktop?.htmlToPdf) {
    try {
      const b64 = await window.novaDesktop.htmlToPdf(buildFormalInvoiceDocumentHtml(venta));
      if (b64) {
        return {
          dataUrl: `data:application/pdf;base64,${b64}`,
          fileName: `factura-${getReceiptInvoiceId(venta)}.pdf`
        };
      }
    } catch (bridgeErr) {
      console.warn('htmlToPdf no disponible para WhatsApp; usando PDF de texto.', bridgeErr);
    }
  }
  await window.VendorLoader.load('jspdf');
  const jsPdfApi = window.jspdf?.jsPDF;
  if (!jsPdfApi) {
    throw new Error('La librería PDF no está disponible para WhatsApp.');
  }

  const cfg = DB.config || {};
  const items = Array.isArray(venta?.items) ? venta.items : [];
  const doc = new jsPdfApi({ unit: 'pt', format: 'a4' });
  const margin = 40;
  const maxWidth = 515;
  let y = 46;

  const writeLine = (text, options = {}) => {
    const size = options.size || 11;
    const bold = Boolean(options.bold);
    const gap = options.gap ?? 16;
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    const lines = doc.splitTextToSize(String(text || ''), maxWidth);
    doc.text(lines, margin, y);
    y += Math.max(gap, lines.length * (size + 3));
  };

  const divider = () => {
    doc.setDrawColor(180, 180, 180);
    doc.setLineWidth(0.7);
    doc.line(margin, y, margin + maxWidth, y);
    y += 14;
  };

  writeLine(cfg.nombre || 'Tecno Caja', { size: 16, bold: true, gap: 20 });
  writeLine(`Factura: ${getReceiptInvoiceId(venta)}`, { bold: true });
  writeLine(`Fecha: ${formatReceiptDateForPaper(venta?.fecha, '80mm') || new Date().toLocaleString('es-DO')}`);
  writeLine(`Cliente: ${venta?.cliente || 'Consumidor Final'}`);
  if (venta?.clienteTelefono) writeLine(`Teléfono: ${venta.clienteTelefono}`);
  divider();

  writeLine('Detalle', { bold: true, size: 12, gap: 18 });
  for (const item of items) {
    writeLine(`${formatReceiptSaleItemQuantity(item)} x ${item.nombre || 'Producto'} - ${fmt(Number(item.total || 0))}`, { size: 10, gap: 14 });
    if (y > 760) {
      doc.addPage();
      y = 46;
    }
  }

  divider();
  writeLine(`Subtotal: ${fmt(Number(venta?.subtotal || 0))}`, { bold: true });
  if (Number(venta?.itbis || 0) > 0) writeLine(`ITBIS: ${fmt(Number(venta.itbis || 0))}`, { bold: true });
  if (Number(venta?.descuento || 0) > 0) {
    writeLine(`Descuento: -${fmt(Number(venta.descuento || 0))}`, { bold: true });
  }
  const pdfRedondeo = getReceiptSummaryBreakdown(venta).redondeo;
  if (Math.abs(pdfRedondeo) >= 0.01) {
    writeLine(`Redondeo: +${fmt(pdfRedondeo)}`, { bold: true });
  }
  writeLine(`Total: ${fmt(Number(venta?.total || 0))}`, { size: 13, bold: true, gap: 20 });
  writeLine(`Método: ${SALE_PAYMENT_TYPES[venta?.metodo] || venta?.metodo || 'Efectivo'}`, { bold: true });
  writeLine(cfg.mensaje || 'Gracias por su compra.', { size: 10, gap: 14 });

  const dataUri = String(doc.output('datauristring') || '');
  const base64 = dataUri.includes('base64,') ? dataUri.split('base64,')[1] : '';
  if (!base64) {
    throw new Error('No se pudo codificar la factura PDF para WhatsApp.');
  }
  return {
    dataUrl: `data:application/pdf;base64,${base64}`,
    fileName: `factura-${getReceiptInvoiceId(venta)}.pdf`
  };
}

async function buildReceiptImageForWhatsApp(venta) {
  if (isElectronicReceipt(venta)) {
    try {
      await ensureReceiptQrData(venta);
    } catch (_error) {
      // continue with image generation even if QR fails
    }
  }

  const dataUrl = await generateReceiptImageDataUrl(venta);
  if (!String(dataUrl || '').startsWith('data:image/')) {
    throw new Error('No se pudo generar la imagen de la factura para WhatsApp.');
  }

  return {
    dataUrl,
    fileName: `factura-${getReceiptInvoiceId(venta)}.png`
  };
}

async function copyReceiptImageForWhatsApp(venta) {
  if (!window.novaDesktop?.copyImageToClipboard) {
    return false;
  }

  try {
    if (isElectronicReceipt(venta)) {
      await ensureReceiptQrData(venta);
    }
    const imageDataUrl = await generateReceiptImageDataUrl(venta);
    const result = await window.novaDesktop.copyImageToClipboard(imageDataUrl);
    return Boolean(result?.ok);
  } catch (_error) {
    return false;
  }
}

async function sendReceiptToWhatsApp(venta) {
  const phone = getReceiptWhatsAppPhone(venta);
  if (!phone) {
    showToast('El cliente seleccionado no tiene un teléfono válido para WhatsApp.', 'warning');
    return;
  }

  const whatsappWebChatUrl = `https://web.whatsapp.com/send?phone=${phone}&type=phone_number&app_absent=0`;
  const waLink = `https://wa.me/${phone}`;
  let openedInElectron = false;
  let openedAnyWhatsApp = false;
  const copiedToClipboard = await copyReceiptImageForWhatsApp(venta);
  if (!copiedToClipboard) {
    showToast('No se pudo copiar la imagen de la factura para WhatsApp.', 'error');
    return;
  }

  if (window.novaDesktop?.openWhatsAppChat) {
    try {
      const result = await window.novaDesktop.openWhatsAppChat(phone, '', {
        showPasteGuide: Boolean(DB.config?.whatsappPasteGuideEnabled ?? true),
        customerName: venta?.cliente || ''
      });
      if (result?.ok) {
        openedInElectron = true;
        openedAnyWhatsApp = true;
      }
    } catch (error) {
      const details = String(error?.message || error || '');
      if (!details.includes("No handler registered for 'app:open-whatsapp-chat'")) {
        console.warn('No se pudo abrir el chat integrado de WhatsApp.', error);
      }
    }
  }

  if (!openedAnyWhatsApp && window.novaDesktop?.openWhatsAppWeb) {
    try {
      const result = await window.novaDesktop.openWhatsAppWeb(whatsappWebChatUrl);
      if (result?.ok) {
        openedInElectron = true;
        openedAnyWhatsApp = true;
      }
    } catch (error) {
      console.warn('No se pudo abrir WhatsApp Web integrado.', error);
    }
  }

  if (!openedAnyWhatsApp && window.novaDesktop?.openExternal) {
    try {
      const result = await window.novaDesktop.openExternal(waLink);
      openedAnyWhatsApp = Boolean(result?.ok);
    } catch (error) {
      console.warn('No se pudo abrir WhatsApp externo.', error);
    }
  }

  if (!openedAnyWhatsApp) {
    try {
      window.open(waLink, '_blank', 'noopener');
      openedAnyWhatsApp = true;
    } catch (_error) {
      // final fallback failed
    }
  }

  if (!openedAnyWhatsApp) {
    showToast('La factura quedó copiada, pero no se pudo abrir WhatsApp automáticamente.', 'warning');
    return;
  }

  showToast(
    openedInElectron
      ? ((DB.config?.whatsappPasteGuideEnabled ?? true)
          ? 'Chat del cliente abierto en WhatsApp de Electron. Sigue la guía en pantalla para pegar y enviar la factura.'
          : 'Chat del cliente abierto en WhatsApp de Electron. La factura ya está copiada: pega con Ctrl+V y envíala.')
      : 'Chat del cliente abierto. La factura ya está copiada: pega con Ctrl+V y envíala.',
    'success'
  );
}

// Envío automático: cuando se factura un pedido que llegó por el bot de
// WhatsApp (tiene sourceQuotationId + teléfono), le mandamos la factura ya
// lista sin que el cajero tenga que copiarla/pegarla a mano. Es "fire and
// forget" — si falla, solo se avisa en consola/toast, nunca bloquea la venta.
async function sendReceiptToWhatsAppBotAuto(venta) {
  const phone = getReceiptWhatsAppPhone(venta);
  console.log('[wa-bot] Auto-envío factura: iniciando', {
    factura: getReceiptInvoiceId(venta),
    clienteTelefono: venta?.clienteTelefono,
    telefonoDelivery: venta?.telefonoDelivery,
    phoneResuelto: phone
  });
  if (!phone) {
    console.warn('[wa-bot] Auto-envío factura: cancelado, no hay teléfono en la venta.');
    return;
  }

  // El bot puede estar reconectando justo cuando se cobra la venta (recién
  // arrancó, o el WhatsApp del celular perdió señal un momento) — unos
  // reintentos cortos evitan perder el envío por un hipo pasajero, sin
  // bloquear la venta (que ya quedó cobrada de todos modos).
  const RETRY_DELAYS_MS = [3000, 8000, 15000];
  let lastError = 'error desconocido';
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      console.log(`[wa-bot] Auto-envío factura: reintento ${attempt}/${RETRY_DELAYS_MS.length} en ${RETRY_DELAYS_MS[attempt - 1]}ms...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      const result = await _attemptSendReceiptToWhatsAppBot(venta, phone);
      if (result.ok) {
        showToast('Factura enviada al cliente por WhatsApp.', 'success');
        return;
      }
      lastError = result.error;
      if (!result.retryable) break;
    } catch (error) {
      lastError = error?.message || String(error);
    }
  }

  console.warn('[wa-bot] Auto-envío factura: agotados los reintentos.', lastError);
  showToast(
    `No se pudo enviar la factura por WhatsApp (${lastError}). Ábrela y usa "Copiar para WhatsApp" para reenviarla.`,
    'error',
    12000
  );
}

// Un solo intento de auto-envío — separado de sendReceiptToWhatsAppBotAuto()
// para poder reintentarlo con backoff sin duplicar toda la lógica. Distingue
// fallos pasajeros (bot reconectando, 5xx) de fallos permanentes (imagen no
// generable, número inválido) para no reintentar algo que nunca va a mejorar.
async function _attemptSendReceiptToWhatsAppBot(venta, phone) {
  const status = await fetch('/api/wa-bot/status').then((r) => r.json()).catch(() => null);
  if (status?.status !== 'ready') {
    return { ok: false, retryable: true, error: `bot no está listo (${status?.status || 'desconocido'})` };
  }

  if (isElectronicReceipt(venta)) {
    try { await ensureReceiptQrData(venta); } catch (_error) { /* seguir sin QR */ }
  }
  const imageDataUrl = await generateReceiptImageDataUrl(venta);
  if (!String(imageDataUrl || '').startsWith('data:image/')) {
    return { ok: false, retryable: false, error: 'no se pudo generar la imagen del recibo' };
  }

  const response = await fetch('/api/wa-bot/send-receipt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, imageDataUrl, caption: buildReceiptWhatsAppMessage(venta) })
  });
  const result = await response.json().catch(() => ({}));
  console.log('[wa-bot] Auto-envío factura: respuesta del backend', { httpStatus: response.status, result });
  if (result?.ok) return { ok: true };
  return { ok: false, retryable: response.status >= 500, error: result?.error || `HTTP ${response.status}` };
}

async function sendCurrentReceiptToWhatsApp() {
  if (!currentReceiptSale) {
    showToast('No hay un comprobante listo para enviar.', 'warning');
    return;
  }
  await sendReceiptToWhatsApp(currentReceiptSale);
}

async function downloadReceiptPdf(venta = currentReceiptSale) {
  if (!venta) {
    showToast('No hay un comprobante listo para exportar.', 'warning');
    return;
  }
  await generateReceiptPdf(venta, { download: true });
}

function buildPrintableReceiptImageHtml(imageDataUrl) {
  const paperVariant = getReceiptPaperVariant();
  const sheetWidth = paperVariant === '58mm'
    ? '48mm'
    : paperVariant === 'a4'
      ? '100%'
      : '72mm';
  return `
    <div class="ticket-print-image ticket-print-image--${paperVariant}">
      <img src="${imageDataUrl}" alt="Comprobante de venta">
    </div>
    <style>
      @page{margin:1mm;}
      .ticket-print-image{display:flex;justify-content:center;align-items:flex-start;background:#fff;padding:0;margin:0}
      .ticket-print-image img{display:block;width:${sheetWidth};max-width:100%;height:auto;object-fit:contain}
      .ticket-print-image--a4 img{width:100%;max-width:100%}
    </style>
  `;
}

function shouldUseReceiptMirrorPrint() {
  return false;
}

const receiptLogoMonoCache = new Map();

async function convertLogoToEscposMonochrome(logoDataUrl, maxWidthPx) {
  if (!logoDataUrl || !maxWidthPx) return null;
  const cacheKey = `${maxWidthPx}:${logoDataUrl}`;
  if (receiptLogoMonoCache.has(cacheKey)) {
    return receiptLogoMonoCache.get(cacheKey);
  }
  const conversion = convertLogoToEscposMonochromeUncached(logoDataUrl, maxWidthPx);
  receiptLogoMonoCache.set(cacheKey, conversion);
  const result = await conversion;
  receiptLogoMonoCache.set(cacheKey, Promise.resolve(result));
  return result;
}

async function convertLogoToEscposMonochromeUncached(logoDataUrl, maxWidthPx) {
  try {
    return await new Promise((resolve) => {
      const img = new Image();
      const timeout = setTimeout(() => resolve(null), 3000);
      img.onload = () => {
        clearTimeout(timeout);
        try {
          // Recortar el margen en blanco/transparente que trae el archivo del logo
          // (habitual en íconos de app, que reservan área de seguridad alrededor del
          // dibujo) — sin esto se imprime con mucho espacio vacío arriba/abajo.
          const probeCanvas = document.createElement('canvas');
          probeCanvas.width = img.width;
          probeCanvas.height = img.height;
          const probeCtx = probeCanvas.getContext('2d');
          probeCtx.drawImage(img, 0, 0);
          const probeData = probeCtx.getImageData(0, 0, img.width, img.height).data;
          let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
          for (let y = 0; y < img.height; y++) {
            for (let x = 0; x < img.width; x++) {
              const i = (y * img.width + x) * 4;
              if (probeData[i + 3] < 10) continue; // transparente
              if (probeData[i] > 250 && probeData[i + 1] > 250 && probeData[i + 2] > 250) continue; // casi blanco puro
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
          const hasContent = maxX >= minX && maxY >= minY;
          const cropX = hasContent ? minX : 0;
          const cropY = hasContent ? minY : 0;
          const cropW = hasContent ? (maxX - minX + 1) : img.width;
          const cropH = hasContent ? (maxY - minY + 1) : img.height;

          const scale = Math.min(1, maxWidthPx / cropW);
          const w = Math.round(cropW * scale);
          const h = Math.round(cropH * scale);
          const printW = Math.ceil(w / 8) * 8; // ancho múltiplo de 8 para ESC/POS
          const canvas = document.createElement('canvas');
          canvas.width = printW;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, printW, h);
          ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, w, h);
          const { data } = ctx.getImageData(0, 0, printW, h);
          const bytesPerLine = printW / 8;
          const monoBytes = [];
          for (let y = 0; y < h; y++) {
            for (let bx = 0; bx < bytesPerLine; bx++) {
              let byte = 0;
              for (let bit = 0; bit < 8; bit++) {
                const x = bx * 8 + bit;
                const i = (y * printW + x) * 4;
                const gray = 0.299 * (data[i] ?? 255) + 0.587 * (data[i + 1] ?? 255) + 0.114 * (data[i + 2] ?? 255);
                if (gray < 128) byte |= (1 << (7 - bit));
              }
              monoBytes.push(byte);
            }
          }
          resolve({ width: printW, height: h, bytesPerLine, data: monoBytes });
        } catch (_e) { resolve(null); }
      };
      img.onerror = () => { clearTimeout(timeout); resolve(null); };
      img.src = logoDataUrl;
    });
  } catch (_e) { return null; }
}

async function warmReceiptPrintPipeline() {
  const paperSize = String(getReceiptConfigValue('receiptPaperSize') || '80mm').toLowerCase();
  const configuredPrinterName = String(getReceiptConfigValue('receiptPrinterName') || '').trim();
  const logoDataUrl = getReceiptConfigValue('logo') || '';
  const maxLogoPx = paperSize === '58mm' ? 280 : 400;
  await Promise.all([
    configuredPrinterName
      ? Promise.resolve(configuredPrinterName)
      : resolveReceiptPrinterName(''),
    logoDataUrl
      ? convertLogoToEscposMonochrome(logoDataUrl, maxLogoPx)
      : Promise.resolve(null),
  ]);
}

async function buildEscposReceiptPayload(venta, paperSize = String(getReceiptConfigValue('receiptPaperSize') || '80mm').toLowerCase()) {
  const normalizedPaperSize = paperSize === '58mm' ? '58mm' : '80mm';
  const paymentLabel = SALE_PAYMENT_TYPES[venta?.metodo] || venta?.metodo || 'Efectivo';
  const receivedAmount = Number(venta?.recibido || 0);
  const payments = venta?.metodo === 'mixto'
    ? [
        { metodo: 'Tarjeta', monto: Number(venta?.montoTarjeta || 0) },
        { metodo: 'Efectivo', monto: Number(venta?.montoEfectivo || 0) }
      ].filter(p => p.monto > 0)
    : receivedAmount > 0
      ? [{ metodo: paymentLabel, monto: receivedAmount }]
      : [];
  const qrData = isElectronicReceipt(venta)
    ? buildReceiptQrPayload(venta)
    : '';

  const logoDataUrl = getReceiptConfigValue('logo') || '';
  const maxLogoPx = normalizedPaperSize === '58mm' ? 280 : 400;
  const logoMono = logoDataUrl ? await convertLogoToEscposMonochrome(logoDataUrl, maxLogoPx) : null;

  return {
    negocio: {
      nombre: normalizeReceiptText(getReceiptConfigValue('nombre') || 'Tecno Caja'),
      rnc: normalizeReceiptText(getReceiptConfigValue('rnc') || ''),
      direccion: normalizeReceiptText(getReceiptConfigValue('direccion') || ''),
      telefono: normalizeReceiptText(getReceiptConfigValue('telefono') || ''),
      logoMono
    },
    venta: {
      numeroFactura: isElectronicReceipt(venta)
        ? (getElectronicReceiptNumber(venta) || getReceiptDisplayNumber(venta))
        : getReceiptDisplayNumber(venta),
      fecha: String(venta?.fecha || new Date().toLocaleString('es-DO')),
      cajero: normalizeReceiptText(venta?.cajero || DB.currentUser?.nombre || DB.currentUser?.usuario || 'CAJERO'),
      cliente: normalizeReceiptText(venta?.cliente || 'Consumidor Final'),
      tipoComprobante: String(venta?.tipoComprobante || ''),
      estadoFiscal: normalizeReceiptText(venta?.estadoDgii || venta?.estadoFiscal || ''),
      metodo: normalizeReceiptText(SALE_PAYMENT_TYPES[venta?.metodo] || venta?.metodo || 'Efectivo'),
      ncf: normalizeReceiptText(venta?.encf || venta?.ncf || ''),
      ncfVencimiento: normalizeReceiptText(venta?.ncfVencimiento || ''),
      items: (venta?.items || []).map((item) => ({
        cantidad: Number(item?.qty || item?.cantidad || 1),
        cantidadTexto: formatReceiptSaleItemQuantity(item, { compactUnit: true }),
        descripcion: normalizeReceiptText(item?.nombre || item?.descripcion || ''),
        subtotal: Number(item?.subtotal ?? item?.total ?? ((Number(item?.precio || 0) * Number(item?.qty || item?.cantidad || 1)) || 0)),
        precio: Number(item?.precio || 0),
        variante: normalizeReceiptText(item?.variante || ''),
        notas: normalizeReceiptText(item?.notas || '')
      })),
      subtotal: Number(venta?.subtotal || 0),
      subtotalGravado: Number(venta?.subtotalGravado || 0),
      subtotalExento: Number(venta?.subtotalExento || 0),
      descuento: Number(venta?.descuento || 0),
      impuesto: Number(venta?.itbis || 0),
      total: Number(venta?.total || 0),
      pagos: payments,
      cambio: Number(venta?.cambio || 0),
      recibido: Number(venta?.recibido || 0),
      // Fase 3 multi-moneda: pago en efectivo USD
      paymentCurrency: String(venta?.paymentCurrency || 'DOP'),
      usdAmountReceived: Number(venta?.usdAmountReceived || 0),
      exchangeRateUsed: Number(venta?.exchangeRateUsed || 0),
      documentTitle: normalizeReceiptText(venta?.receiptDocumentTitle || ''),
      documentNumber: normalizeReceiptText(venta?.receiptDocumentNumber || ''),
      dataSectionTitle: normalizeReceiptText(venta?.receiptDataSectionTitle || ''),
      primaryLabel: normalizeReceiptText(venta?.receiptPrimaryLabel || ''),
      methodRowLabel: normalizeReceiptText(venta?.receiptMethodRowLabel || '')
    },
    config: {
      paperWidth: normalizedPaperSize,
      narrowCols: Boolean(getReceiptConfigValue('receiptNarrowCols')),
      cortarPapel: true,
      abrirGaveta: false,
      mostrarQR: Boolean(qrData),
      qrData,
      mensaje: normalizeReceiptText(venta?.receiptFooterMessageOverride || getReceiptConfigValue('mensaje') || 'Gracias por su compra.'),
      currency: getReceiptConfigValue('moneda') || 'RD$'
    }
  };
}

async function getCachedReceiptPrinters(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && receiptPrinterCache.expiresAt > now) {
    return receiptPrinterCache.printers;
  }
  if (!window.novaDesktop?.listPrinters) {
    receiptPrinterCache = { expiresAt: now + 5000, printers: [] };
    return [];
  }

  try {
    const result = await window.novaDesktop.listPrinters();
    const printers = Array.isArray(result?.printers) ? result.printers : [];
    receiptPrinterCache = {
      expiresAt: now + 15000,
      printers
    };
    return printers;
  } catch (_error) {
    receiptPrinterCache = { expiresAt: now + 5000, printers: [] };
    return [];
  }
}

async function resolveReceiptPrinterName(rawPrinterName = '') {
  const explicitPrinterName = String(rawPrinterName || '').trim();
  if (explicitPrinterName) return explicitPrinterName;

  const printers = await getCachedReceiptPrinters();
  const defaultPrinter = printers.find((printer) => printer?.isDefault && String(printer.name || '').trim());
  return String(defaultPrinter?.name || '').trim();
}

async function printReceipt(venta = currentReceiptSale) {
  if (!venta) {
    showToast('No hay un comprobante listo para imprimir.', 'warning');
    return false;
  }
  const successMessage = venta?.printSuccessMessage || 'Factura enviada a impresión.';
  const failureMessage = venta?.printFailureMessage || 'No se pudo imprimir la factura.';

  const paperSize = String(getReceiptConfigValue('receiptPaperSize') || '80mm').toLowerCase();
  const configuredPrinterName = String(getReceiptConfigValue('receiptPrinterName') || '').trim();
  const isThermalPaper = paperSize === '58mm' || paperSize === '80mm';
  const printerName = isThermalPaper
    ? await resolveReceiptPrinterName(configuredPrinterName)
    : configuredPrinterName;
  const canUseEscposPrint = Boolean(window.novaDesktop?.printReceiptEscpos && isThermalPaper && printerName);
  const canUseHtmlPrint = Boolean(window.novaDesktop?.printReceiptHtml);

  if (!canUseEscposPrint && !canUseHtmlPrint) {
    showToast('La impresión directa está disponible solo en la app de escritorio.', 'warning');
    return false;
  }

  if (canUseEscposPrint) {
    const escposResult = await window.novaDesktop.printReceiptEscpos(
      await buildEscposReceiptPayload(venta, paperSize),
      {
        printerName,
        paperWidth: paperSize
      }
    );

    if (escposResult?.ok) {
      showToast(successMessage, 'success');
      return true;
    }

    // Con papel térmico configurado para ESC/POS, el respaldo HTML enviaría
    // datos PDF/PCL a la impresora que los imprimiría como caracteres ilegibles.
    // En ese caso mostramos el error directamente en lugar de hacer fallback.
    console.warn('La impresión ESC/POS falló.', escposResult?.error);
    if (!canUseHtmlPrint || isThermalPaper) {
      showToast(escposResult?.error || failureMessage, 'error');
      return false;
    }
  }

  if (isElectronicReceipt(venta)) {
    try {
      await ensureReceiptQrData(venta);
    } catch (_error) {
      showToast('No se pudo preparar el QR fiscal para impresión.', 'warning');
    }
  }

  let printableHtml = buildPrintableReceiptHtml(venta);
  if (shouldUseReceiptMirrorPrint()) {
    try {
      const receiptImageDataUrl = venta._receiptMirrorImagePromise
        ? await venta._receiptMirrorImagePromise
        : await ensureReceiptMirrorImageDataUrl(venta);
      if (!String(receiptImageDataUrl || '').startsWith('data:image/')) {
        throw new Error('La imagen del comprobante no quedó lista para imprimir.');
      }
      printableHtml = buildPrintableReceiptImageHtml(receiptImageDataUrl);
    } catch (error) {
      console.warn('No se pudo preparar la impresión visual del comprobante.', error);
      showToast('No se pudo preparar la factura con el mismo diseño del recibo digital. Abre el comprobante y vuelve a intentar.', 'error');
      return false;
    }
  }

  const result = await window.novaDesktop.printReceiptHtml(printableHtml, {
    mode: getReceiptConfigValue('receiptPrintMode') || 'dialog',
    printerName,
    paperSize
  });

  if (!result?.ok) {
    showToast(result?.error || failureMessage, 'error');
    return false;
  }

  showToast(successMessage, 'success');
  return true;
}

function renderReceiptFooter(options = {}) {
  const footer = document.getElementById('receipt-footer');
  if (!footer) return;

  if (options.preview) {
    footer.innerHTML = `
      <button class="btn-secondary" onclick="closeReceipt()">Cerrar</button>
      <button class="btn-primary" onclick="printPreviewReceipt()">🖨️ Imprimir prueba</button>
    `;
    return;
  }

  if (options.pending) {
    const billingCaps = window.TecnoCajaBilling?.getEffectiveBillingCapabilities
      ? window.TecnoCajaBilling.getEffectiveBillingCapabilities()
      : { forcePendingCharge: false };
    const primaryActionLabel = billingCaps.forcePendingCharge ? '🧾 Emitir e imprimir' : '💰 Cobrar e imprimir';
    const secondaryActionLabel = billingCaps.forcePendingCharge ? '📋 Emitir y copiar' : '📋 Cobrar y copiar';
    footer.innerHTML = `
      <button class="btn-primary receipt-confirm-btn" onclick="finalizePendingSale('print')">${primaryActionLabel} <kbd>↵Enter</kbd></button>
      <button class="btn-secondary receipt-confirm-btn" onclick="finalizePendingSale('whatsapp')">${secondaryActionLabel}</button>
      <button class="btn-secondary" onclick="closeReceipt()">Cancelar</button>
    `;
    return;
  }

  const venta = currentReceiptSale;
  const deliveryBtn = venta && String(venta.tipoPedido || '') === 'delivery'
    ? `<button class="btn-secondary" onclick="toggleReceiptDeliveryPanel()">🛵 Estado de entrega</button>`
    : '';
  footer.innerHTML = `
    ${deliveryBtn}
    <button class="btn-secondary" onclick="sendCurrentReceiptToWhatsApp()">📋 Copiar para WhatsApp</button>
    <button class="btn-secondary" onclick="printReceipt()">🖨️ Imprimir factura</button>
    <button class="btn-primary" onclick="closeReceipt()">Cerrar</button>
  `;
  const panel = document.getElementById('receipt-delivery-panel');
  if (panel) panel.classList.add('hidden');
}

const RECEIPT_DELIVERY_STATUS_LABELS = {
  pendiente: 'Pendiente de salir',
  en_camino: 'En camino',
  entregado: 'Entregado',
  incidencia: 'Incidencia'
};

function toggleReceiptDeliveryPanel() {
  const panel = document.getElementById('receipt-delivery-panel');
  if (!panel) return;
  const willShow = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !willShow);
  if (willShow) renderReceiptDeliveryPanel();
}

function renderReceiptDeliveryPanel() {
  const panel = document.getElementById('receipt-delivery-panel');
  const venta = currentReceiptSale;
  if (!panel || !venta) return;
  const currentStatus = venta.estadoEntrega || 'pendiente';
  panel.innerHTML = `
    <div class="billing-step-grid billing-step-grid-tight">
      <div class="billing-step-field">
        <label>Repartidor</label>
        <select id="receipt-delivery-user" class="form-input billing-step-input">
          <option value="">Sin asignar</option>
          ${getDeliveryUsers().map((user) => `
            <option value="${user.id}" ${Number(venta.repartidorId) === user.id ? 'selected' : ''}>${user.nombre}${user.email ? ` · ${user.email}` : ''}</option>
          `).join('')}
        </select>
      </div>
      <div class="billing-step-field">
        <label>Estado</label>
        <select id="receipt-delivery-status" class="form-input billing-step-input">
          ${Object.entries(RECEIPT_DELIVERY_STATUS_LABELS).map(([value, label]) => `
            <option value="${value}" ${currentStatus === value ? 'selected' : ''}>${label}</option>
          `).join('')}
        </select>
      </div>
      <div class="billing-step-field billing-step-field-action">
        <button type="button" class="btn-primary" onclick="saveReceiptDeliveryStatus()">Guardar</button>
      </div>
    </div>
  `;
}

async function saveReceiptDeliveryStatus() {
  const venta = currentReceiptSale;
  const invoiceNumber = getReceiptInvoiceId(venta);
  if (!venta || !invoiceNumber) return;
  const repartidorId = document.getElementById('receipt-delivery-user')?.value || '';
  const estadoEntrega = document.getElementById('receipt-delivery-status')?.value || 'pendiente';
  try {
    const updated = await api.updateDeliveryStatus(invoiceNumber, {
      estadoEntrega,
      repartidorId: repartidorId ? Number(repartidorId) : null
    });
    currentReceiptSale = { ...venta, ...updated };
    const recibo = document.getElementById('receipt-content');
    if (recibo) recibo.innerHTML = getReceiptContentMarkup(currentReceiptSale);
    showToast('Estado de entrega actualizado.', 'success');
    toggleReceiptDeliveryPanel();
  } catch (e) {
    showToast(e.message || 'No se pudo actualizar el estado de entrega.', 'error');
  }
}

function getReceiptSummaryBreakdown(venta) {
  const items = Array.isArray(venta?.items) ? venta.items : [];
  let subtotalGravado = 0;
  let subtotalExento = 0;

  items.forEach((item) => {
    const lineSubtotal = roundSaleMoney(
      Number(item?.subtotal ?? item?.total ?? ((Number(item?.precio || 0) * Number(item?.qty || item?.cantidad || 1)) || 0))
    );
    const isMontoFijo = String(item?.itbisModo || 'porcentaje') === 'monto';
    const isTaxable = isMontoFijo
      ? Number(item?.itbisMontoUnit ?? item?.impuestoMonto ?? 0) > 0
      : Math.max(0, Number(item?.itbis || item?.taxRate || 0)) > 0;
    if (isTaxable) {
      subtotalGravado += lineSubtotal;
    } else {
      subtotalExento += lineSubtotal;
    }
  });

  const subtotal = roundSaleMoney(venta?.subtotal ?? (subtotalGravado + subtotalExento));
  const descuento = roundSaleMoney(venta?.descuento || 0);
  const itbis = roundSaleMoney(venta?.itbis || 0);
  const total = roundSaleMoney(venta?.total || 0);
  // El redondeo no se persiste en columna propia — se deriva de los totales ya
  // guardados (total incluye el ajuste de redondeo aplicado al cobrar).
  const redondeo = roundSaleMoney(total - (subtotal - descuento + itbis));

  return {
    subtotalGravado: roundSaleMoney(venta?.subtotalGravado ?? subtotalGravado),
    subtotalExento: roundSaleMoney(venta?.subtotalExento ?? subtotalExento),
    subtotal,
    descuento,
    itbis,
    redondeo,
    total,
    ahorroPromociones: roundSaleMoney(venta?.ahorroPromociones || 0)
  };
}

function buildReceiptSummaryRows(venta) {
  const taxBehavior = getSaleTaxConfig();
  const breakdown = getReceiptSummaryBreakdown(venta);
  const rows = [['Subtotal', fmt(breakdown.subtotal)]];

  if (taxBehavior.separateTaxableAndExempt) {
    rows.push(['Subtotal gravado', fmt(breakdown.subtotalGravado)]);
    rows.push(['Subtotal exento', fmt(breakdown.subtotalExento)]);
  }
  if (breakdown.descuento > 0) {
    rows.push(['Descuento', `-${fmt(breakdown.descuento)}`]);
  }
  if (taxBehavior.showBreakdownOnReceipts && breakdown.itbis > 0) {
    rows.push([`ITBIS (${taxBehavior.taxRate.toFixed(2).replace(/\.00$/, '')}%)`, fmt(breakdown.itbis)]);
  }
  if (Math.abs(breakdown.redondeo) >= 0.01) {
    rows.push(['Redondeo', `+${fmt(breakdown.redondeo)}`]);
  }
  if (breakdown.ahorroPromociones > 0) {
    rows.push(['★ USTED AHORRÓ', fmt(breakdown.ahorroPromociones)]);
  }

  return rows;
}

function getReceiptTemplateData(venta) {
  const cfg = {
    nombre: getReceiptConfigValue('nombre'),
    logo: getReceiptConfigValue('logo'),
    mensaje: getReceiptConfigValue('mensaje'),
    rnc: getReceiptConfigValue('rnc'),
    direccion: getReceiptConfigValue('direccion'),
    telefono: getReceiptConfigValue('telefono')
  };
  const factura = getReceiptDisplayNumber(venta);
  const electronicReceipt = isElectronicReceipt(venta);
  const electronicNumber = getElectronicReceiptNumber(venta);
  const dgiiStatus = normalizeReceiptText(venta.estadoDgii || '');
  const receiptSimpleMode = true;
  const paperVariant = getReceiptPaperVariant();
  const thermalLike = paperVariant !== 'a4';
  const usesTableItems = paperVariant !== 'a4';
  const fmtReceiptTableAmount = (value) => Number(value || 0).toLocaleString('es-DO', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const fmtReceiptValue = (value) => (thermalLike ? fmtReceiptTableAmount(value) : fmt(value));
  const fmtReceiptQty = (item) => formatReceiptSaleItemQuantity(item, { compactUnit: usesTableItems });
  const clipReceiptItemName = (name) => {
    const clean = normalizeReceiptText(name);
    const maxChars = paperVariant === '58mm' ? 16 : 24;
    if (clean.length <= maxChars) return clean;
    return `${clean.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
  };
  const metodoLabel = venta.receiptMethodLabelOverride || SALE_PAYMENT_TYPES[venta.metodo] || venta.metodo || 'Efectivo';
  const primaryDocumentLabel = venta.receiptPrimaryLabel || 'Factura';
  const methodRowLabel = venta.receiptMethodRowLabel || 'Método';
  const pendienteCredito = venta.metodo === 'credito'
    ? Math.max(0, Number((Number(venta.total || 0) - Number(venta.recibido || 0)).toFixed(2)))
    : 0;
  const isDeliveryOrder = String(venta.tipoPedido || '') === 'delivery';
  const detailRows = [
    [primaryDocumentLabel, factura],
    ...(electronicReceipt && electronicNumber ? [['e-NCF', electronicNumber]] : []),
    // NCF real de DGII (ej. B0100000012) — distinto del número de factura
    // interno de arriba. Solo aplica a comprobante fiscal tradicional serie B,
    // no a e-CF (ese ya muestra su propio "e-NCF" arriba).
    ...(!electronicReceipt && venta.ncf ? [['NCF', venta.ncf]] : []),
    ...(venta.ncfType ? [['Tipo NCF', `${venta.ncfType} · ${NCF_LABELS_FE[venta.ncfType] || venta.ncfType}`]] : []),
    ...(!electronicReceipt && venta.ncf && venta.ncfVencimiento ? [['NCF vence', formatReceiptDateForPaper(venta.ncfVencimiento, paperVariant)]] : []),
    ...(venta.tipoEcf ? [['Tipo e-CF', venta.tipoEcf]] : []),
    ['Fecha', formatReceiptDateForPaper(venta.fecha, paperVariant)],
    ['Cajero', normalizeReceiptText(venta.cajero || 'Sistema')],
    ['Cliente', normalizeReceiptText(venta.cliente || 'Consumidor Final')],
    ...(venta.clienteRncCedula ? [['RNC / Cédula', normalizeReceiptText(venta.clienteRncCedula)]] : []),
    ...(dgiiStatus ? [['Estado DGII', dgiiStatus]] : []),
    [methodRowLabel, metodoLabel],
    ...(pendienteCredito > 0 ? [['Pendiente', Number(pendienteCredito).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })]] : []),
    // Solo se muestran en pedidos de delivery — en mostrador/para llevar no aportan nada.
    ...(isDeliveryOrder ? [
      ['Repartidor', normalizeReceiptText(venta.repartidor || 'Sin asignar')],
      ['Tel. entrega', normalizeReceiptText(venta.telefonoDelivery || '')],
      ['Dirección', normalizeReceiptText(venta.direccionDelivery || '')],
      ['Referencia', normalizeReceiptText(venta.referenciaDelivery || '')],
    ] : []),
    ...(isDeliveryOrder && venta.metodo === 'contra_entrega' && Number(venta.montoClienteEntrega || 0) > 0 ? [
      ['Cliente paga con', fmt(Number(venta.montoClienteEntrega || 0))],
      ['Cambio a llevar', fmt(Number(venta.cambioRepartidor || 0))],
    ] : []),
  ].filter(([, value]) => Boolean(String(value || '').trim()));
  const normalizedItems = (venta.items || []).map((item) => {
    const normalizedItem = normalizeSaleItem(item);
    const qty = Number(normalizedItem.qty || 0);
    const precio = Number(item.precio || 0);
    const itbisRate = Number(item.itbis || 0);
    const subtotalItem = roundSaleMoney(item.subtotal ?? item.total ?? (qty * precio));
    const total = subtotalItem;
    return {
      ...normalizedItem,
      nombre: normalizeReceiptText(item.nombre),
      qty,
      precio,
      subtotal: subtotalItem,
      total,
      itbisRate,
      lineTax: roundSaleMoney(item.impuestoMonto ?? (subtotalItem * (itbisRate / 100)))
    };
  });

  const itemsHeaderMarkup = usesTableItems
    ? `
      <div class="receipt-items-head receipt-items-head--table">
        <span>Articulo</span>
        <span>Cant.</span>
        <span>Valor</span>
        <span>Total</span>
      </div>
    `
    : '';

  const itemsMarkup = normalizedItems.map((item) => {
    const itemName = clipReceiptItemName(item.nombre);
    if (usesTableItems) {
      return `
        <div class="receipt-item receipt-item--table">
          <div class="receipt-item-grid receipt-item-grid--table">
            <div class="receipt-item-name" title="${escapeReceiptHtml(item.nombre)}">${escapeReceiptHtml(itemName)}</div>
            <div class="receipt-item-qty">${escapeReceiptHtml(fmtReceiptQty(item))}</div>
            <div class="receipt-item-price">${escapeReceiptHtml(fmtReceiptTableAmount(item.subtotal))}</div>
            <div class="receipt-item-total">${escapeReceiptHtml(fmtReceiptTableAmount(item.total))}</div>
          </div>
        </div>
      `;
    }

    return `
      <div class="receipt-item">
        <div class="receipt-item-grid">
          <div class="receipt-item-main">
            <div class="receipt-item-name" title="${escapeReceiptHtml(item.nombre)}">${escapeReceiptHtml(fmtReceiptQty(item))} x ${escapeReceiptHtml(itemName)}</div>
            <div class="receipt-item-meta">
              ${item.promotionId
                ? `<s>${escapeReceiptHtml(fmtReceiptValue(item.originalPrice))}</s> ${escapeReceiptHtml(`Unit: ${fmtReceiptValue(item.precio)}`)} · 🏷 Promo`
                : escapeReceiptHtml(`Unit: ${fmtReceiptValue(item.precio)}`)}
              ${receiptSimpleMode ? '' : ` · ${escapeReceiptHtml(item.itbisModo === 'monto' ? `ITBIS RD$${Number(item.itbisMontoUnit || 0).toFixed(2)}/u` : `ITBIS ${item.itbisRate.toFixed(2)}%`)}`}
            </div>
          </div>
          <div class="receipt-item-total">${escapeReceiptHtml(fmt(item.total))}</div>
        </div>
      </div>
    `;
  }).join('');

  return { cfg, factura, detailRows, itemsHeaderMarkup, itemsMarkup, normalizedItems, receiptSimpleMode };
}

function getReceiptPaperVariant() {
  const normalized = String(getReceiptConfigValue('receiptPaperSize') || '80mm').toLowerCase();
  if (normalized === '58mm') return '58mm';
  if (normalized === 'a4') return 'a4';
  return '80mm';
}

function getThermalReceiptCharWidth(paperVariant = getReceiptPaperVariant()) {
  return paperVariant === '58mm' ? 32 : 42;
}

function clipThermalText(value, width) {
  const clean = normalizeReceiptText(value);
  const maxWidth = Math.max(0, Number(width) || 0);
  if (!maxWidth) return '';
  if (clean.length <= maxWidth) return clean;
  if (maxWidth <= 3) return clean.slice(0, maxWidth);
  return `${clean.slice(0, maxWidth - 3).trimEnd()}...`;
}

function padThermalRight(value, width) {
  return clipThermalText(value, width).padEnd(Math.max(0, Number(width) || 0), ' ');
}

function padThermalLeft(value, width) {
  return clipThermalText(value, width).padStart(Math.max(0, Number(width) || 0), ' ');
}

function wrapThermalText(value, width, maxLines = Infinity) {
  const clean = normalizeReceiptText(value);
  const maxWidth = Math.max(1, Number(width) || 1);
  const lines = [];

  if (!clean) return [''];

  const words = clean.split(' ');
  let current = '';

  const pushLine = (line) => {
    if (line) lines.push(line);
  };

  words.forEach((word) => {
    if (!word) return;
    if (word.length > maxWidth) {
      if (current) {
        pushLine(current);
        current = '';
      }
      for (let start = 0; start < word.length; start += maxWidth) {
        pushLine(word.slice(start, start + maxWidth));
      }
      return;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxWidth) {
      pushLine(current);
      current = word;
      return;
    }
    current = next;
  });

  if (current) pushLine(current);

  if (lines.length <= maxLines) return lines;

  const trimmed = lines.slice(0, maxLines);
  trimmed[maxLines - 1] = clipThermalText(trimmed[maxLines - 1], maxWidth);
  return trimmed;
}

function centerThermalLine(value, width) {
  const clean = clipThermalText(value, width);
  if (!clean) return '';
  const totalWidth = Math.max(clean.length, Number(width) || 0);
  const leftPad = Math.max(0, Math.floor((totalWidth - clean.length) / 2));
  return `${' '.repeat(leftPad)}${clean}`;
}

function buildThermalCenterLines(value, width, maxLines = 2) {
  return wrapThermalText(value, width, maxLines).map((line) => centerThermalLine(line, width));
}

function buildThermalMonoLine(left, right, width) {
  const cleanLeft = normalizeReceiptText(left);
  const cleanRight = normalizeReceiptText(right);
  const totalWidth = Math.max(1, Number(width) || 1);

  if (!cleanRight) {
    return padThermalRight(cleanLeft, totalWidth);
  }

  const availableLeft = Math.max(1, totalWidth - cleanRight.length - 1);
  const leftPart = clipThermalText(cleanLeft, availableLeft);
  const gap = Math.max(1, totalWidth - leftPart.length - cleanRight.length);
  return `${leftPart}${' '.repeat(gap)}${cleanRight}`;
}

function buildThermalKeyValueLines(label, value, width, labelWidth) {
  const safeLabel = padThermalRight(String(label || '').toUpperCase(), labelWidth);
  const valueWidth = Math.max(1, width - labelWidth - 1);
  const valueLines = wrapThermalText(value, valueWidth, 3);
  return valueLines.map((line, index) => {
    const labelPart = index === 0 ? safeLabel : ' '.repeat(labelWidth);
    return `${labelPart} ${padThermalLeft(line, valueWidth)}`;
  });
}

function buildThermalItemLines(items, width, paperVariant) {
  const hasAnyItbis = items.some((item) => (
    item.itbisModo === 'monto' ? Number(item.itbisMontoUnit || 0) > 0 : Number(item.itbisRate || 0) > 0
  ));
  const columns = paperVariant === '58mm'
    ? { name: hasAnyItbis ? 7 : 10, itbis: 4, qty: 2, price: 7, total: 7, qtyLabel: 'C', priceLabel: 'VALOR', totalLabel: 'TOTAL' }
    : { name: hasAnyItbis ? 12 : 17, itbis: 5, qty: 4, price: 8, total: hasAnyItbis ? 9 : 10, qtyLabel: 'CANT', priceLabel: 'VALOR', totalLabel: 'TOTAL' };
  const fmtAmount = (value) => Number(value || 0).toLocaleString('es-DO', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const fmtQty = (item) => formatReceiptSaleItemQuantity(item, { compactUnit: true });

  const itbisHeader = hasAnyItbis ? ` ${padThermalLeft('ITBIS', columns.itbis)}` : '';
  const lines = [
    `${padThermalRight('ARTICULO', columns.name)}${itbisHeader} ${padThermalLeft(columns.qtyLabel, columns.qty)} ${padThermalLeft(columns.priceLabel, columns.price)} ${padThermalLeft(columns.totalLabel, columns.total)}`
  ];

  items.forEach((item) => {
    const nameLines = wrapThermalText(item.nombre, columns.name, paperVariant === '58mm' ? 3 : 4);
    const itbisColText = item.itbisModo === 'monto'
      ? (Number(item.itbisMontoUnit || 0) > 0 ? Number(item.itbisMontoUnit).toFixed(2) : '')
      : (Number(item.itbisRate || 0) > 0 ? `${Number(item.itbisRate).toFixed(0)}%` : '');
    const itbisCol = hasAnyItbis ? ` ${padThermalLeft(itbisColText, columns.itbis)}` : '';
    const qty = padThermalLeft(fmtQty(item), columns.qty);
    const price = padThermalLeft(fmtAmount(item.precio), columns.price);
    const total = padThermalLeft(fmtAmount(item.total), columns.total);

    lines.push(`${padThermalRight(nameLines[0] || '', columns.name)}${itbisCol} ${qty} ${price} ${total}`);
    nameLines.slice(1).forEach((line) => {
      lines.push(line);
    });
  });

  return lines.map((line) => String(line || '').slice(0, Math.max(0, Number(width) || 0)));
}

function getA4ReceiptPalette(venta) {
  if (venta?.isQuotation) {
    return {
      modifier: 'consumo',
      accent: '#2563eb',
      accentSoft: '#dbeafe',
      accentStrong: '#1d4ed8',
      title: 'Cotización',
      docLabel: 'No.'
    };
  }

  if (isElectronicReceipt(venta)) {
    const isFiscal = String(venta?.ncfType || '').toUpperCase() === 'B01' || String(venta?.tipoEcf || '').toUpperCase() === 'E31';
    return {
      modifier: 'fiscal',
      accent: '#ff9800',
      accentSoft: '#fff3e0',
      accentStrong: '#ff6f00',
      title: isFiscal ? 'Factura de Credito Fiscal' : 'Factura Electronica de Consumo',
      docLabel: 'eNCF'
    };
  }

  return {
    modifier: 'consumo',
    accent: '#ff9800',
    accentSoft: '#fff3e0',
    accentStrong: '#ff6f00',
    title: 'Factura de Consumo',
    docLabel: 'NCF'
  };
}

function buildA4ReceiptSheetMarkup(venta, templateData, qrMarkup) {
  const { cfg, factura, normalizedItems } = templateData;
  const palette = getA4ReceiptPalette(venta);
  const issuerRows = [
    ['Negocio', cfg.nombre || 'Tecno Caja'],
    ['RNC Negocio', cfg.rnc || ''],
    ['Dirección', cfg.direccion || 'No configurada']
  ].filter(r => r[1]);
  const receiverRows = [
    ['Cliente', venta.razonSocialCliente || venta.cliente || 'Consumidor Final'],
    venta.razonSocialCliente && venta.cliente ? ['Contacto', venta.cliente] : null,
    venta.clienteRncCedula ? ['RNC / Cédula', venta.clienteRncCedula || ''] : null,
    isElectronicReceipt(venta) ? ['e-NCF', getElectronicReceiptNumber(venta)] : null,
    !isElectronicReceipt(venta) && venta.ncf ? ['NCF', venta.ncf] : null,
    !isElectronicReceipt(venta) && venta.ncf && venta.ncfVencimiento ? ['NCF Vence', formatReceiptDateForPaper(venta.ncfVencimiento, 'a4')] : null,
    venta.ncfType ? ['Tipo NCF', `${venta.ncfType} · ${NCF_LABELS_FE[venta.ncfType] || ''}`] : null,
    venta.tipoEcf ? ['Tipo e-CF', venta.tipoEcf] : null,
    venta.estadoDgii ? ['Estado DGII', venta.estadoDgii] : null,
    venta.ncfReferencia ? ['NCF Referencia', venta.ncfReferencia] : null
  ].filter(Boolean);
  const metaRows = [
    ['Fecha', formatReceiptDateForPaper(venta.fecha, 'a4')],
    ['Cajero', venta.cajero || '']
  ].filter(([, value]) => Boolean(String(value || '').trim()));
  const itemsRows = normalizedItems.map((item) => `
    <div class="receipt-a4-table-row">
      <div>${escapeReceiptHtml(formatReceiptSaleItemQuantity(item))}</div>
      <div>${escapeReceiptHtml(item.nombre)}</div>
      <div>${escapeReceiptHtml(item.itbisModo === 'monto' ? `RD$${Number(item.itbisMontoUnit || 0).toFixed(2)}` : (item.itbisRate > 0 ? `${item.itbisRate.toFixed(2)}%` : '0.00'))}</div>
      <div>${escapeReceiptHtml(fmt(item.total))}</div>
    </div>
  `).join('');
  const totalsRows = [
    ...buildReceiptSummaryRows(venta),
    venta.metodo === 'credito' && !isCreditFullyPaid(venta)
      ? ['A crédito', fmt(Math.max(0, Number(venta.total || 0) - Number(venta.recibido || 0)))]
      : Number(venta.recibido || 0) > 0 ? ['Pagado', fmt(venta.recibido)] : null,
    venta.metodo !== 'credito' && Number(venta.cambio || 0) > 0 ? ['Cambio', fmt(venta.cambio)] : null,
    ['Método de pago', SALE_PAYMENT_TYPES[venta.metodo] || venta.metodo || 'Efectivo']
  ].filter(Boolean);

  return `
    <div class="receipt-sheet receipt-sheet--a4 receipt-a4 receipt-a4--${palette.modifier}">
      <div class="receipt-a4-colorbar" style="--receipt-accent:${palette.accent}"></div>

      <div class="receipt-a4-head">
        <div class="receipt-a4-brandblock">
          <div class="receipt-a4-brandrow">
            <div class="receipt-brand-mark">
              ${cfg.logo ? `<img src="${cfg.logo}" alt="Logo" class="receipt-brand-image">` : '<span class="receipt-brand-icon">⚡</span>'}
            </div>
            <div class="receipt-brand-copy">
              <div class="receipt-brand-name">${escapeReceiptHtml(cfg.nombre)}</div>
              <div class="receipt-brand-doc">${escapeReceiptHtml(venta.receiptHeaderSubtitle || 'COMPROBANTE DE VENTA')}</div>
            </div>
          </div>
          <div class="receipt-a4-businessline">${escapeReceiptHtml(cfg.direccion || '')}</div>
          <div class="receipt-a4-businessline">${escapeReceiptHtml(cfg.telefono || '')}</div>
        </div>

        <div class="receipt-a4-docbox" style="--receipt-accent:${palette.accent};--receipt-accent-soft:${palette.accentSoft};--receipt-accent-strong:${palette.accentStrong}">
          <div class="receipt-a4-doclabel">${escapeReceiptHtml(palette.title)}</div>
          <div class="receipt-a4-docnumber">${escapeReceiptHtml(palette.docLabel)}: ${escapeReceiptHtml(isElectronicReceipt(venta) ? (getElectronicReceiptNumber(venta) || factura) : factura)}</div>
          ${(venta.estadoDgii || venta.estadoFiscal) ? `<div class="receipt-a4-docstatus">${escapeReceiptHtml(String(venta.estadoDgii || venta.estadoFiscal).toUpperCase())}</div>` : ''}
        </div>
      </div>

      <div class="receipt-a4-panels">
        <div class="receipt-a4-panel">
          <div class="receipt-a4-panel-title" style="--receipt-accent:${palette.accent}">Información del Emisor</div>
          ${issuerRows.map(([label, value]) => `
            <div class="receipt-a4-panel-row">
              <span>${escapeReceiptHtml(label)}</span>
              <strong>${escapeReceiptHtml(value)}</strong>
            </div>
          `).join('')}
        </div>

        <div class="receipt-a4-panel">
          <div class="receipt-a4-panel-title" style="--receipt-accent:${palette.accent}">Información del Receptor</div>
          ${receiverRows.map(([label, value]) => `
            <div class="receipt-a4-panel-row">
              <span>${escapeReceiptHtml(label)}</span>
              <strong>${escapeReceiptHtml(value)}</strong>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="receipt-a4-meta">
        ${metaRows.map(([label, value]) => `
          <div class="receipt-a4-meta-card">
            <span>${escapeReceiptHtml(label)}</span>
            <strong>${escapeReceiptHtml(value)}</strong>
          </div>
        `).join('')}
      </div>

      <div class="receipt-a4-table">
        <div class="receipt-a4-table-head" style="--receipt-accent:${palette.accent}">
          <div>Cant.</div>
          <div>Descripción</div>
          <div>ITBIS</div>
          <div>Valor</div>
        </div>
        ${itemsRows}
      </div>

      <div class="receipt-a4-bottom">
        <div class="receipt-a4-side">
          ${qrMarkup}
          <div class="receipt-a4-note${venta?.isQuotation ? ' receipt-a4-note--quotation' : ''}">${escapeReceiptHtml(venta.receiptFooterMessageOverride || cfg.mensaje || 'Gracias por su compra.')}</div>
        </div>

        <div class="receipt-a4-totals" style="--receipt-accent:${palette.accent}">
          ${totalsRows.map(([label, value]) => `
            <div class="receipt-a4-total-row${label === 'Descuento' ? ' receipt-a4-total-row--danger' : ''}">
              <span>${escapeReceiptHtml(label)}</span>
              <strong>${escapeReceiptHtml(value)}</strong>
            </div>
          `).join('')}
          <div class="receipt-a4-grandtotal">
            <span>Total</span>
            <strong>${escapeReceiptHtml(fmt(venta.total))}</strong>
          </div>
        </div>
      </div>
    </div>
  `;
}

function buildThermalReceiptSheetMarkup(venta, templateData, qrMarkup) {
  const { cfg, factura, detailRows, normalizedItems, receiptSimpleMode } = templateData;
  const fmtThermal = (value) => Number(value || 0).toLocaleString('es-DO', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const businessLines = [
    cfg.rnc ? `RNC: ${normalizeReceiptText(cfg.rnc)}` : '',
    normalizeReceiptText(cfg.direccion),
    cfg.telefono ? `Tel: ${normalizeReceiptText(cfg.telefono)}` : ''
  ].filter(Boolean);
  const documentTitle = normalizeReceiptText(
    venta.receiptDocumentTitle
    || (isElectronicReceipt(venta) ? 'FACTURA ELECTRONICA' : 'FACTURA DE VENTA')
  );
  const documentNumber = normalizeReceiptText(
    venta.receiptDocumentNumber
    || (isElectronicReceipt(venta) ? `eNCF ${getElectronicReceiptNumber(venta) || factura}` : `Factura ${factura}`)
  );
  const fiscalState = normalizeReceiptText(venta.estadoDgii || venta.estadoFiscal);
  const paperVariant = getReceiptPaperVariant();
  const totalWidth = getThermalReceiptCharWidth(paperVariant);
  const labelWidth = paperVariant === '58mm' ? 8 : 10;
  const divider = '-'.repeat(totalWidth);
  const strongDivider = '='.repeat(totalWidth);
  const monoLines = [];
  const pushMonoLine = (text, variant = 'body') => {
    monoLines.push({ text: String(text || ''), variant });
  };
  const pushMonoLines = (lines, variant = 'body') => {
    lines.forEach((line) => pushMonoLine(line, variant));
  };
  const pushSummaryLine = (label, value, variant = 'body') => {
    pushMonoLine(buildThermalMonoLine(label, value, totalWidth), variant);
  };

  pushMonoLines(buildThermalCenterLines(cfg.nombre || 'Tecno Caja', totalWidth, 2), 'brand');
  businessLines.forEach((line) => {
    pushMonoLines(buildThermalCenterLines(line, totalWidth, 2));
  });
  pushMonoLine(divider, 'divider');
  pushMonoLines(buildThermalCenterLines(documentTitle, totalWidth, 2), 'title');
  pushMonoLines(buildThermalCenterLines(documentNumber, totalWidth, 2), 'meta-strong');
  if (fiscalState) {
    pushMonoLines(buildThermalCenterLines(String(fiscalState).toUpperCase(), totalWidth, 1), 'meta-strong');
  }
  pushMonoLine(divider, 'divider');
  pushMonoLine(centerThermalLine(venta.receiptDataSectionTitle || 'DATOS DEL COMPROBANTE', totalWidth), 'section');
  detailRows.forEach(([label, value]) => {
    pushMonoLines(buildThermalKeyValueLines(label, value, totalWidth, labelWidth));
  });
  pushMonoLine(divider, 'divider');
  const itemLines = buildThermalItemLines(normalizedItems, totalWidth, paperVariant);
  if (itemLines.length) {
    pushMonoLine(itemLines[0], 'items-head');
    pushMonoLines(itemLines.slice(1));
  }
  pushMonoLine(divider, 'divider');
  buildReceiptSummaryRows(venta).forEach(([label, value]) => {
    pushSummaryLine(label, fmtThermal(parseFmt(String(value || 0))));
  });
  pushMonoLine(strongDivider, 'divider-strong');
  pushSummaryLine('TOTAL', fmtThermal(venta.total), 'total');
  if (venta.metodo === 'credito' && !isCreditFullyPaid(venta)) {
    const pendiente = Math.max(0, Number(venta.total || 0) - Number(venta.recibido || 0));
    const abonado = Number(venta.recibido || 0);
    if (abonado > 0) pushSummaryLine('Abonado', fmtThermal(abonado));
    pushSummaryLine('PENDIENTE', fmtThermal(pendiente), 'meta-strong');
    pushSummaryLine('Método', 'A CRÉDITO');
  } else if (venta.metodo === 'credito') {
    pushSummaryLine('Pagado', fmtThermal(venta.recibido));
    pushSummaryLine('Método', 'CRÉDITO — PAGADO');
  } else if (venta.metodo === 'mixto') {
    if (Number(venta.montoTarjeta || 0) > 0) {
      pushSummaryLine('Tarjeta', fmtThermal(venta.montoTarjeta));
    }
    if (Number(venta.montoEfectivo || 0) > 0) {
      pushSummaryLine('Efectivo', fmtThermal(venta.montoEfectivo));
    }
    if (Number(venta.cambio || 0) > 0) {
      pushSummaryLine('Cambio', fmtThermal(venta.cambio));
    }
    pushSummaryLine('Método', 'Mixto (Tarjeta + Efectivo)');
  } else if (venta.paymentCurrency === 'USD') {
    // Fase 3 multi-moneda: mostrar monto cobrado en US$ y su equivalente/vuelto en RD$
    const usdRecibidoAmt = Number(venta.usdAmountReceived || 0);
    const recibidoAmt = Number(venta.recibido || 0);
    const cambioAmt   = Number(venta.cambio   || 0);
    pushSummaryLine('Recibido US$', usdRecibidoAmt.toFixed(2));
    pushSummaryLine('Recibido RD$', fmtThermal(recibidoAmt));
    if (cambioAmt > 0) {
      pushSummaryLine('Devuelta RD$', fmtThermal(cambioAmt), 'total');
    }
  } else {
    // Mostrar recibido y devuelta cuando el cliente pagó más del total
    const recibidoAmt = Number(venta.recibido || 0);
    const cambioAmt   = Number(venta.cambio   || 0);
    if (cambioAmt > 0) {
      pushSummaryLine('Recibido', fmtThermal(recibidoAmt));
      pushSummaryLine('Devuelta', fmtThermal(cambioAmt), 'total');
    }
  }
  const footerMessage = venta.receiptFooterMessageOverride || cfg.mensaje;
  if (footerMessage) {
    pushMonoLine('', 'spacer');
    pushMonoLines(buildThermalCenterLines(footerMessage, totalWidth, 3), venta?.isQuotation ? 'quotation-message' : 'message');
  }
  const monoContent = monoLines.map(({ text, variant }) => {
    const variantClass = variant && variant !== 'body'
      ? ` receipt-mono-line--${variant}`
      : '';
    return `<span class="receipt-mono-line${variantClass}">${escapeReceiptHtml(text)}</span>`;
  }).join('');

  return `
    <div class="receipt-sheet receipt-sheet--${paperVariant} receipt-sheet--thermal-mono">
      <pre class="receipt-mono-block">${monoContent}</pre>
      ${qrMarkup}
    </div>
  `;
}

// ─── Factura A4 moderna ──────────────────────────────────────────────────────
// Mismo diseño formal del modo Empresa de Servicios (server/routes/servicios/
// renderDoc.js → renderFormalA4), portado al navegador y adaptado a la venta del
// POS. TODOS los selectores CSS cuelgan de .tcfac-root para poder inyectar el
// bloque por innerHTML en el modal sin filtrar estilos al resto del app.
// Decisión de Emilio (v1.3.29): toda venta usa esta factura, aunque el negocio
// tenga impresora térmica. El ticket 58/80 mm queda en el archivo sin usar.
const FAC_U = ['', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ',
  'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE'];
const FAC_D = ['', '', 'VEINTE', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
const FAC_C = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];

function facSeccion(n) {
  if (n === 0) return '';
  if (n < 20) return FAC_U[n];
  if (n < 100) {
    const d = Math.floor(n / 10); const u = n % 10;
    if (n === 20) return 'VEINTE';
    if (d === 2) return 'VEINTI' + FAC_U[u];
    return FAC_D[d] + (u ? ' Y ' + FAC_U[u] : '');
  }
  if (n === 100) return 'CIEN';
  const c = Math.floor(n / 100); const r = n % 100;
  return FAC_C[c] + (r ? ' ' + facSeccion(r) : '');
}

function facMontoEnLetras(valor) {
  const num = Math.floor(Math.abs(Number(valor) || 0));
  const cent = Math.round((Math.abs(Number(valor) || 0) - num) * 100);
  let palabras;
  if (num === 0) palabras = 'CERO';
  else {
    const mill = Math.floor(num / 1000000);
    const miles = Math.floor((num % 1000000) / 1000);
    const resto = num % 1000;
    const p = [];
    if (mill) p.push(mill === 1 ? 'UN MILLÓN' : facSeccion(mill) + ' MILLONES');
    if (miles) p.push(miles === 1 ? 'MIL' : facSeccion(miles) + ' MIL');
    if (resto) p.push(facSeccion(resto));
    palabras = p.join(' ').trim() || 'CERO';
  }
  return `${palabras} PESOS DOMINICANOS CON ${String(cent).padStart(2, '0')}/100`;
}

function facMoney(n) {
  return 'RD$ ' + (Number(n) || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const FORMAL_INVOICE_CSS = `
.tcfac-root{ display:block; background:#eef1f4; padding:14px; overflow:visible;
  font-family:"Segoe UI","Helvetica Neue",Arial,sans-serif; color:#1f2937; }
.tcfac-root *{ margin:0; padding:0; box-sizing:border-box; }
.tcfac-root .tcf-page{ position:relative; width:210mm; min-height:297mm; margin:0 auto;
  padding:16mm 18mm; background:#fff; overflow:hidden; font-size:10.5px; color:#1f2937;
  -webkit-print-color-adjust:exact; print-color-adjust:exact; box-shadow:0 1px 8px rgba(0,0,0,.14); }
.tcfac-root .tcf-wm{ position:absolute; top:45%; left:50%;
  transform:translate(-50%,-50%) rotate(-24deg); font-size:110px; font-weight:800;
  letter-spacing:6px; white-space:nowrap; color:rgba(220,38,38,.09); pointer-events:none; z-index:0; }
.tcfac-root .tcf-content{ position:relative; z-index:1; }
.tcfac-root .tcf-head{ display:flex; justify-content:space-between; align-items:flex-start; gap:14mm; padding-bottom:6mm; }
.tcfac-root .tcf-logo{ max-height:26mm; max-width:70mm; display:block; margin-bottom:3mm; }
.tcfac-root .tcf-brand-fallback{ font-size:20px; font-weight:800; color:#15803d; letter-spacing:.5px; margin-bottom:3mm; }
.tcfac-root .tcf-em{ font-size:9.5px; line-height:1.5; color:#4b5563; }
.tcfac-root .tcf-em strong{ color:#1f2937; }
.tcfac-root .tcf-doc{ text-align:right; min-width:62mm; }
.tcfac-root .tcf-title{ font-size:24px; font-weight:800; letter-spacing:4px; color:#15803d; line-height:1; }
.tcfac-root .tcf-chip{ display:inline-block; margin-top:3mm; padding:2mm 3mm; border:1.5px solid #15803d;
  border-radius:3px; font-size:12px; font-weight:800; letter-spacing:.5px; color:#111827; }
.tcfac-root .tcf-chip span{ color:#15803d; font-weight:700; letter-spacing:1px; margin-right:1.5mm; }
.tcfac-root .tcf-meta{ margin-top:4mm; font-size:10px; line-height:1.7; color:#374151; }
.tcfac-root .tcf-meta b{ color:#111827; }
.tcfac-root .tcf-stamp{ display:inline-block; margin-top:3mm; padding:3px 12px; border:2px solid;
  border-radius:3px; font-size:10px; font-weight:800; letter-spacing:1.5px; transform:rotate(-3deg); }
.tcfac-root .tcf-stamp.warn{ color:#b45309; border-color:#b45309; }
.tcfac-root .tcf-stamp.ok{ color:#15803d; border-color:#15803d; }
.tcfac-root .tcf-stamp.bad{ color:#b91c1c; border-color:#b91c1c; }
.tcfac-root .tcf-rule{ height:2.5px; background:#15803d; margin:0 0 6mm; }
.tcfac-root .tcf-parties{ display:grid; grid-template-columns:1fr 1fr; gap:12mm; margin-bottom:7mm; }
.tcfac-root .tcf-blabel{ font-size:8.5px; font-weight:700; letter-spacing:1.2px; text-transform:uppercase;
  color:#6b7280; padding-bottom:2mm; border-bottom:1px solid #e5e7eb; margin-bottom:2.5mm; }
.tcfac-root .tcf-pname{ font-size:12px; font-weight:700; color:#111827; margin-bottom:1mm; }
.tcfac-root .tcf-pline{ font-size:9.5px; line-height:1.6; color:#4b5563; }
.tcfac-root .tcf-pay{ display:flex; justify-content:space-between; font-size:9.5px; line-height:1.9; color:#4b5563; }
.tcfac-root .tcf-pay span:last-child{ color:#111827; font-weight:600; }
.tcfac-root .tcf-items{ width:100%; border-collapse:collapse; margin-bottom:4mm; }
.tcfac-root .tcf-items thead th{ background:#f4f7f5; color:#374151; font-size:8.5px; font-weight:700;
  letter-spacing:.6px; text-transform:uppercase; text-align:right; padding:3mm 2.5mm;
  border-top:1.5px solid #15803d; border-bottom:1.5px solid #15803d; }
.tcfac-root .tcf-items thead th.i{ text-align:center; width:9mm; }
.tcfac-root .tcf-items thead th.d{ text-align:left; }
.tcfac-root .tcf-items tbody td{ padding:2.6mm 2.5mm; font-size:10px; border-bottom:1px solid #edf0f2; vertical-align:top; }
.tcfac-root .tcf-items tbody tr:last-child td{ border-bottom:1px solid #d1d5db; }
.tcfac-root .tcf-ci{ text-align:center; color:#9ca3af; }
.tcfac-root .tcf-cd{ text-align:left; color:#1f2937; }
.tcfac-root .tcf-cn{ text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
.tcfac-root .tcf-tw{ display:flex; justify-content:flex-end; }
.tcfac-root .tcf-tot{ width:78mm; }
.tcfac-root .tcf-tot .r{ display:flex; justify-content:space-between; padding:1.6mm 0; font-size:10px; color:#4b5563; }
.tcfac-root .tcf-tot .r .v{ color:#111827; font-variant-numeric:tabular-nums; }
.tcfac-root .tcf-tot .grand{ border-top:2px solid #111827; margin-top:1mm; padding-top:2.5mm;
  font-size:14px; font-weight:800; color:#111827; }
.tcfac-root .tcf-tot .paid{ color:#15803d; }
.tcfac-root .tcf-tot .due{ font-weight:700; color:#b45309; }
.tcfac-root .tcf-words{ margin:5mm 0 0; padding:2.5mm 3mm; background:#f9fafb; border:1px solid #e5e7eb;
  border-radius:3px; font-size:9.5px; line-height:1.5; color:#374151; }
.tcfac-root .tcf-words b{ color:#111827; letter-spacing:.3px; }
.tcfac-root .tcf-note{ margin-top:6mm; font-size:9.5px; line-height:1.6; color:#4b5563; white-space:pre-wrap; }
.tcfac-root .tcf-qr{ margin-top:6mm; display:flex; align-items:center; gap:4mm; }
.tcfac-root .tcf-qr img{ width:30mm; height:30mm; }
.tcfac-root .tcf-qr small{ font-size:8.5px; color:#6b7280; line-height:1.5; }
.tcfac-root .tcf-foot{ margin-top:12mm; padding-top:5mm; border-top:1px solid #e5e7eb;
  font-size:8.5px; line-height:1.6; color:#6b7280; }
.tcfac-root .tcf-foot b{ display:block; color:#15803d; font-size:10px; margin-bottom:1mm; letter-spacing:.3px; }
@media print{
  .tcfac-root{ background:#fff; padding:0; overflow:visible; }
  .tcfac-root .tcf-page{ margin:0; box-shadow:none; width:auto; min-height:auto; }
}
@media screen and (max-width:820px){
  .tcfac-root .tcf-page{ transform:scale(.6); transform-origin:top left; }
}
`;

function ventaToFormalDoc(venta) {
  const td = getReceiptTemplateData(venta);
  const bd = getReceiptSummaryBreakdown(venta);
  const isCot = Boolean(venta.isQuotation);
  const elec = isElectronicReceipt(venta);
  const ncf = elec ? (getElectronicReceiptNumber(venta) || '') : (venta.ncf || '');
  const totalNum = Number(bd.total || venta.total || 0);
  const recibido = Number(venta.recibido || 0);
  const esCredito = venta.metodo === 'credito';
  const pagado = isCot ? 0
    : esCredito ? recibido
    : (recibido > 0 ? Math.min(recibido, totalNum) : totalNum);
  const balance = Math.max(0, Number((totalNum - pagado).toFixed(2)));
  const anulada = venta.anulada === true
    || /anul/i.test(String(venta.estadoDgii || venta.estadoFiscal || venta.estado || ''));

  let estadoLabel;
  if (isCot) estadoLabel = 'COTIZACIÓN';
  else if (anulada) estadoLabel = 'ANULADA';
  else if (balance <= 0.01) estadoLabel = 'PAGADA';
  else if (pagado > 0.01) estadoLabel = 'PAGO PARCIAL';
  else estadoLabel = 'PENDIENTE DE PAGO';

  // ITBIS por línea. Muchas ventas guardan la tasa por ítem en 0 y solo el
  // total de ITBIS a nivel de venta (precios con impuesto incluido, config
  // global, etc.). Si es así, repartir el ITBIS de la venta proporcional al
  // subtotal de cada línea para que la columna no quede vacía.
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const nItems = td.normalizedItems || [];
  const sumSub = nItems.reduce((a, it) => a + Number(it.subtotal || it.total || 0), 0);
  const saleItbis = Number(bd.itbis || 0);
  const necesitaRepartir = saleItbis > 0.01 && nItems.every((it) => !(Number(it.itbisRate || 0) > 0) && !(Number(it.lineTax || 0) > 0));
  let repartidoAcum = 0;
  const items = nItems.map((it, idx) => {
    const sub = Number(it.subtotal || it.total || 0);
    let rate = Number(it.itbisRate || 0);
    let monto = Number(it.lineTax || 0);
    if (necesitaRepartir && sumSub > 0) {
      monto = (idx === nItems.length - 1)
        ? r2(saleItbis - repartidoAcum)
        : r2(saleItbis * (sub / sumSub));
      repartidoAcum = r2(repartidoAcum + monto);
      if (rate <= 0 && sub > 0) rate = Math.round((monto / sub) * 100);
    } else if (rate > 0 && monto <= 0 && sub > 0) {
      monto = r2(sub * (rate / 100));
    }
    return {
      descripcion: it.nombre,
      cantidad: it.qty,
      precio: it.precio,
      itbisPct: rate,
      itbisMonto: monto,
      total: Number(it.total || 0)
    };
  });

  const ncfTipoLabel = venta.ncfType
    ? `${venta.ncfType} — ${venta.ncfLabel || NCF_LABELS_FE[venta.ncfType] || ''}`.replace(/ — $/, '')
    : (venta.tipoEcf ? `e-CF ${venta.tipoEcf}` : '');

  return {
    isCot, anulada, estadoLabel, pagado, balance,
    empresa: {
      nombre: getReceiptConfigValue('nombre') || 'Tecno Caja',
      rnc: getReceiptConfigValue('rnc') || '',
      direccion: getReceiptConfigValue('direccion') || '',
      telefono: getReceiptConfigValue('telefono') || '',
      logo: getReceiptConfigValue('logo') || ''
    },
    numero: getReceiptDisplayNumber(venta),
    ncf,
    fiscalMode: elec ? 'ecf' : 'ncf',
    ncfTipoLabel,
    ncfVencimiento: (venta.ncf || venta.encf) ? (venta.ncfVencimiento || '') : '',
    fecha: venta.fecha,
    fechaEmision: venta.fechaEmisionFiscal || venta.fiscalFechaIso || '',
    cajero: venta.cajero || '',
    metodoPago: venta.receiptMethodLabelOverride || SALE_PAYMENT_TYPES[venta.metodo] || venta.metodo || 'Efectivo',
    condicionPago: esCredito ? 'crédito' : 'contado',
    cliente: {
      nombre: venta.razonSocialCliente || venta.cliente || 'Consumidor Final',
      rnc: venta.clienteRncCedula || venta.rncCliente || '',
      tel: venta.clienteTelefono || venta.telefonoDelivery || '',
      dir: venta.direccionDelivery || ''
    },
    items,
    subtotal: bd.subtotal,
    descuento: bd.descuento,
    itbis: bd.itbis,
    redondeo: bd.redondeo,
    total: totalNum,
    mensaje: venta.receiptFooterMessageOverride || getReceiptConfigValue('mensaje') || '',
    qrDataUrl: (elec && venta.qrDataUrl) ? venta.qrDataUrl : ''
  };
}

function buildFormalInvoiceMarkup(venta) {
  const d = ventaToFormalDoc(venta);
  const esc = escapeReceiptHtml;
  const titulo = d.isCot ? 'COTIZACIÓN' : 'FACTURA';
  const stampClass = (d.isCot || d.balance <= 0.01) ? 'ok' : (d.anulada ? 'bad' : 'warn');
  const fecha = formatReceiptDateForPaper(d.fecha, 'a4') || '';
  const venc = d.ncfVencimiento ? (formatReceiptDateForPaper(d.ncfVencimiento, 'a4') || '') : '';

  const itbisCell = (it) => {
    if (Number(it.itbisMonto) > 0.005) return facMoney(it.itbisMonto);
    if (Number(it.itbisPct) > 0) return Number(it.itbisPct).toFixed(0) + '%';
    return 'Exento';
  };
  const rows = d.items.map((it, i) => `
      <tr>
        <td class="tcf-ci">${i + 1}</td>
        <td class="tcf-cd">${esc(it.descripcion)}</td>
        <td class="tcf-cn">${Number(it.cantidad || 0)}</td>
        <td class="tcf-cn">${facMoney(it.precio)}</td>
        <td class="tcf-cn">${esc(itbisCell(it))}</td>
        <td class="tcf-cn">${facMoney(it.total)}</td>
      </tr>`).join('');

  const logoHtml = d.empresa.logo
    ? `<img src="${esc(d.empresa.logo)}" class="tcf-logo" alt="logo">`
    : `<div class="tcf-brand-fallback">${esc(d.empresa.nombre)}</div>`;

  const footNote = d.isCot
    ? 'Cotización sin valor fiscal. Precios sujetos a cambio después de la fecha de validez. Documento generado electrónicamente.'
    : 'Documento generado electrónicamente por Tecno Caja POS. Válido sin firma ni sello. Gracias por su compra.';

  return `<div class="tcfac-root">
  <style>${FORMAL_INVOICE_CSS}</style>
  <div class="tcf-page">
    ${d.anulada ? '<div class="tcf-wm">ANULADA</div>' : ''}
    <div class="tcf-content">
      <div class="tcf-head">
        <div>
          ${logoHtml}
          ${d.empresa.rnc ? `<div class="tcf-em"><strong>RNC:</strong> ${esc(d.empresa.rnc)}</div>` : ''}
          ${d.empresa.direccion ? `<div class="tcf-em">${esc(d.empresa.direccion)}</div>` : ''}
          ${d.empresa.telefono ? `<div class="tcf-em"><strong>Tel:</strong> ${esc(d.empresa.telefono)}</div>` : ''}
        </div>
        <div class="tcf-doc">
          <div class="tcf-title">${titulo}</div>
          ${d.ncf ? `<div class="tcf-chip"><span>${d.fiscalMode === 'ecf' ? 'e-NCF' : 'NCF'}</span> ${esc(d.ncf)}</div>` : ''}
          <div class="tcf-meta">
            ${d.ncfTipoLabel ? `<div><b>Tipo de comprobante:</b> ${esc(d.ncfTipoLabel)}</div>` : ''}
            <div><b>No.:</b> ${esc(d.numero)}</div>
            <div><b>Fecha de emisión:</b> ${esc(fecha)}</div>
            ${venc ? `<div><b>NCF válido hasta:</b> ${esc(venc)}</div>` : ''}
          </div>
          <div class="tcf-stamp ${stampClass}">${esc(d.estadoLabel)}</div>
        </div>
      </div>
      <div class="tcf-rule"></div>
      <div class="tcf-parties">
        <div>
          <div class="tcf-blabel">${d.isCot ? 'Cliente' : 'Facturar a'}</div>
          <div class="tcf-pname">${esc(d.cliente.nombre)}</div>
          ${d.cliente.rnc ? `<div class="tcf-pline">RNC / Cédula: ${esc(d.cliente.rnc)}</div>` : ''}
          ${d.cliente.dir ? `<div class="tcf-pline">${esc(d.cliente.dir)}</div>` : ''}
          ${d.cliente.tel ? `<div class="tcf-pline">Tel: ${esc(d.cliente.tel)}</div>` : ''}
        </div>
        <div>
          <div class="tcf-blabel">Detalles de pago</div>
          <div class="tcf-pay"><span>Condición</span><span>${esc(d.condicionPago)}</span></div>
          <div class="tcf-pay"><span>Método de pago</span><span>${esc(d.metodoPago)}</span></div>
          <div class="tcf-pay"><span>Estado</span><span>${esc(d.estadoLabel)}</span></div>
          ${Number(d.pagado) ? `<div class="tcf-pay"><span>Pagado</span><span>${facMoney(d.pagado)}</span></div>` : ''}
          ${(Number(d.balance) > 0.01 && !d.isCot) ? `<div class="tcf-pay"><span>Saldo pendiente</span><span>${facMoney(d.balance)}</span></div>` : ''}
          ${d.cajero ? `<div class="tcf-pay"><span>Cajero</span><span>${esc(d.cajero)}</span></div>` : ''}
        </div>
      </div>
      <table class="tcf-items">
        <thead><tr>
          <th class="i">#</th><th class="d">Descripción</th>
          <th>Cant.</th><th>Precio unit.</th><th>ITBIS</th><th>Importe</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="tcf-tw"><div class="tcf-tot">
        <div class="r"><span>Subtotal</span><span class="v">${facMoney(d.subtotal)}</span></div>
        ${Number(d.descuento) ? `<div class="r"><span>Descuento</span><span class="v">- ${facMoney(d.descuento)}</span></div>` : ''}
        ${Number(d.itbis) ? `<div class="r"><span>ITBIS</span><span class="v">${facMoney(d.itbis)}</span></div>` : ''}
        ${Math.abs(Number(d.redondeo || 0)) >= 0.01 ? `<div class="r"><span>Redondeo</span><span class="v">${facMoney(d.redondeo)}</span></div>` : ''}
        <div class="r grand"><span>TOTAL</span><span class="v">${facMoney(d.total)}</span></div>
        ${Number(d.pagado) ? `<div class="r paid"><span>Pagado</span><span class="v">${facMoney(d.pagado)}</span></div>` : ''}
        ${(Number(d.balance) > 0.01 && !d.anulada && !d.isCot) ? `<div class="r due"><span>Saldo pendiente</span><span class="v">${facMoney(d.balance)}</span></div>` : ''}
      </div></div>
      <div class="tcf-words"><b>Son:</b> ${esc(facMontoEnLetras(d.total))}</div>
      ${d.qrDataUrl ? `<div class="tcf-qr"><img src="${esc(d.qrDataUrl)}" alt="QR"><small>Verificación DGII &middot; escanee el código para validar este comprobante fiscal electrónico.</small></div>` : ''}
      ${d.mensaje ? `<div class="tcf-note">${esc(d.mensaje)}</div>` : ''}
      <div class="tcf-foot"><b>${esc(d.empresa.nombre)}</b>${footNote}</div>
    </div>
  </div>
</div>`;
}

function buildFormalInvoiceDocumentHtml(venta) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">`
    + `<title>${escapeReceiptHtml(getReceiptDisplayNumber(venta))}</title></head>`
    + `<body style="margin:0">${buildFormalInvoiceMarkup(venta)}</body></html>`;
}

function buildReceiptSheetMarkup(venta) {
  // Siempre la factura A4 moderna. buildA4ReceiptSheetMarkup / buildThermal…
  // quedan definidas abajo sin usar: revertir es cambiar esta línea.
  return buildFormalInvoiceMarkup(venta);
}

function getReceiptContentMarkup(venta) {
  return buildReceiptSheetMarkup(venta);
}

function buildPrintableReceiptHtml(venta) {
  // La factura A4 moderna ya trae su CSS completo y su tamano A4 propio
  // (.tcf-page: 210mm x 297mm). Solo hace falta un @page limpio.
  return `${buildReceiptSheetMarkup(venta)}
<style>@page{size:A4;margin:0}html,body{margin:0;padding:0;background:#fff}</style>`;
}

function showReceipt(venta, options = {}) {
  const recibo = document.getElementById('receipt-content');
  const title = document.getElementById('receipt-title');
  currentReceiptSale = venta;
  currentReceiptOptions = options || {};
  if (title) {
    title.textContent = options.preview
      ? 'Vista Previa de Impresión'
      : options.pending
        ? 'Confirmar Comprobante'
        : options.title
          ? options.title
          : 'Comprobante de Venta';
  }
  recibo.innerHTML = getReceiptContentMarkup(venta);
  const overlay = document.getElementById('receipt-overlay');
  overlay.classList.remove('hidden');

  // Layout vertical cuando el modal está en modo "pending" (Confirmar Comprobante).
  const modalEl = overlay.querySelector('.receipt-modal');
  if (modalEl) {
    modalEl.classList.toggle('receipt-modal--pending', !!options.pending);
  }

  renderReceiptFooter(options);
  renderReceiptQr(venta);
  if (shouldUseReceiptMirrorPrint()) {
    warmReceiptMirrorImage(venta);
  }

  // Enter = Cobrar e imprimir cuando está pendiente. Sólo se registra una vez.
  if (options.pending) {
    attachReceiptPendingKeyHandler();
  } else {
    detachReceiptPendingKeyHandler();
  }
}

// Handler global para que Enter dispare "Cobrar e imprimir" cuando el modal
// está en estado "pending". Se registra sólo mientras el modal pendiente
// esté abierto y se remueve al cerrarlo.
let _receiptPendingKeyHandler = null;
function attachReceiptPendingKeyHandler() {
  if (_receiptPendingKeyHandler) return; // ya registrado
  _receiptPendingKeyHandler = function (e) {
    if (e.key !== 'Enter') return;
    // Ignorar si el modal no está visible o ya no está en pending
    const overlay = document.getElementById('receipt-overlay');
    if (!overlay || overlay.classList.contains('hidden')) return;
    if (!currentReceiptOptions || !currentReceiptOptions.pending) return;

    // No interferir si el usuario está escribiendo en un input/textarea/select editable.
    const tgt = e.target;
    if (tgt && (tgt.tagName === 'TEXTAREA'
      || (tgt.tagName === 'INPUT' && !['button','submit','checkbox','radio'].includes((tgt.type || '').toLowerCase()))
      || tgt.isContentEditable)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    try {
      if (typeof finalizePendingSale === 'function') {
        finalizePendingSale('print');
      }
    } catch (err) {
      console.warn('[receipt] Enter → finalizePendingSale falló:', err);
    }
  };
  document.addEventListener('keydown', _receiptPendingKeyHandler, true);
}

function detachReceiptPendingKeyHandler() {
  if (!_receiptPendingKeyHandler) return;
  document.removeEventListener('keydown', _receiptPendingKeyHandler, true);
  _receiptPendingKeyHandler = null;
}

function closeReceipt() {
  const overlay = document.getElementById('receipt-overlay');
  overlay.classList.add('hidden');
  const modalEl = overlay.querySelector('.receipt-modal');
  if (modalEl) modalEl.classList.remove('receipt-modal--pending');
  detachReceiptPendingKeyHandler();
  currentReceiptOptions = {};
  receiptPreviewContext = null;
  // Mientras el comprobante estaba abierto, tipear/escanear en el buscador
  // no agrega productos (ver guard en handleSearchKey), pero los caracteres
  // sí podían quedar acumulados en el campo. Limpiarlo aquí evita que un
  // escaneo posterior se concatene con esos restos.
  const searchInput = document.getElementById('product-search');
  if (searchInput) searchInput.value = '';
  document.getElementById('search-dropdown')?.classList.add('hidden');
  if (typeof searchResults !== 'undefined') searchResults = [];
  scheduleSalesSearchFocus({ force: true });
}

function buildPrintPreviewSale(configOverride = {}) {
  const now = new Date();
  const factura = `${configOverride.prefix || DB.config?.prefix || 'FAC-'}PREVIEW`;
  const items = [
    { nombre: 'Pizza 8 pedazos', qty: 1, precio: 450, total: 450, itbis: Number(configOverride.itbis || 0) },
    { nombre: 'Ingrediente adicional', qty: 1, precio: 75, total: 75, itbis: Number(configOverride.itbis || 0) }
  ];
  const totals = calcularTotales(items, {
    generalDiscountRate: 4.7619,
    config: { ...DB.config, ...configOverride }
  });

  return {
    id: factura,
    previewInvoiceNumber: factura,
    tipoComprobante: 'ticket',
    tipoPedido: 'mostrador',
    estadoCocina: 'lista',
    fecha: now.toLocaleString('es-DO'),
    cajero: (DB.currentUser?.nombre || DB.currentUser?.usuario || 'CAJERO').toUpperCase(),
    cliente: 'Cliente de prueba',
    clienteTelefono: '809-555-1234',
    clienteRncCedula: '001-0000000-1',
    repartidor: '',
    telefonoDelivery: '',
    direccionDelivery: '',
    referenciaDelivery: '',
    linkUbicacionDelivery: '',
    notasPedido: 'Vista previa de impresión desde Configuración.',
    metodo: 'efectivo',
    subtotal: totals.subtotal,
    subtotalGravado: totals.subtotalGravado,
    subtotalExento: totals.subtotalExento,
    descuento: totals.discount,
    itbis: totals.itbis,
    total: totals.total,
    recibido: totals.total,
    cambio: 0,
    items
  };
}

function printPreviewReceipt() {
  if (!receiptPreviewContext?.venta) {
    showToast('No hay una vista previa lista para imprimir.', 'warning');
    return;
  }
  printReceipt(receiptPreviewContext.venta);
}

function openPrintPreviewFromConfig() {
  const configOverride = typeof getConfigPreviewValues === 'function' ? getConfigPreviewValues() : { ...DB.config };
  const previewSale = buildPrintPreviewSale(configOverride);
  receiptPreviewContext = { venta: previewSale, configOverride };
  showReceipt(previewSale, { preview: true, configOverride });
}

function cancelSale() {
  clearRecoveredQuotationTracking();
  storeRememberedBillingClientId(DB.saleClientId);
  DB.saleItems = [];
  resetBillingCheckoutDraft({ preserveRememberedClient: false });
  document.getElementById('product-search').value = '';
  const amountInput = document.getElementById('monto-recibido');
  if (amountInput) amountInput.value = '';
  const generalDiscountInput = document.getElementById('desc-general');
  if (generalDiscountInput) generalDiscountInput.value = '';
  const mixedInputs = ['mixto-tarjeta', 'mixto-efectivo', 'mixto-transferencia'];
  mixedInputs.forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });
  ['sale-table-label', 'sale-delivery-phone', 'sale-delivery-address', 'sale-delivery-reference', 'sale-delivery-link', 'sale-order-notes'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const deliveryUser = document.getElementById('sale-delivery-user');
  if (deliveryUser) deliveryUser.value = '';
  const orderType = document.getElementById('sale-order-type');
  if (orderType) orderType.value = 'mostrador';
  const kitchenStatus = document.getElementById('sale-kitchen-status');
  if (kitchenStatus) kitchenStatus.value = 'pendiente';
  const saleClientSelect = document.getElementById('sale-client-select');
  if (saleClientSelect) saleClientSelect.value = '';
  const cambioVal = document.getElementById('cambio-val');
  if (cambioVal) cambioVal.textContent = fmt(0);
  const mixtoPendiente = document.getElementById('mixto-pendiente');
  if (mixtoPendiente) mixtoPendiente.textContent = fmt(0);
  const mixtoCambioVal = document.getElementById('mixto-cambio-val');
  if (mixtoCambioVal) mixtoCambioVal.textContent = fmt(0);
  document.querySelectorAll('.pay-method').forEach((button) => button.classList.remove('active'));
  const defaultMethod = document.querySelector('.pay-method');
  if (defaultMethod) setPayMethod('efectivo', defaultMethod);
  renderSaleTable();
  updateTotals();
  renderSalesCatalog();
  syncSaleFiscalControls();
  if (document.getElementById('ncf-type-grid')) setSaleNcfType('');
  syncBillingConfirmSummary();
  focusSalesSearchInput({ force: true });
}

function suspendSale() {
  if (!DB.saleItems.length) { showToast('No hay venta activa para suspender', 'warning'); return; }
  document.getElementById('modal-title').textContent = 'Suspender venta';
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-grid">
      <div class="form-group span-full">
        <label>Nombre para esta factura en pausa</label>
        <input type="text" id="suspend-sale-name" class="form-input" value="${escapeHtml(buildSuggestedSuspendedSaleName())}" placeholder="Ej: Mesa 4 · Juan · 12:30">
        <span class="helper-text">Así podrás guardar varias facturas suspendidas y recuperar exactamente la que quieras facturar.</span>
      </div>
    </div>
  `;
  document.getElementById('modal-footer').innerHTML = `
    <button class="btn-secondary" onclick="closeAllModals()">Cancelar</button>
    <button class="btn-primary" onclick="confirmSuspendSale()">Guardar suspendida</button>
  `;
  document.getElementById('modal-box').classList.remove('billing-modal');
  document.getElementById('modal-overlay').classList.remove('hidden');
  if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('modal-overlay'));
  setTimeout(() => document.getElementById('suspend-sale-name')?.select(), 0);
}

function openQuotationModal() {
  if (!DB.saleItems.length) { showToast('Agrega productos antes de guardar una cotización', 'warning'); return; }
  const selectedClient = getSelectedSaleClient();
  const suggestedClientName = selectedClient?.nombre || '';
  const suggestedQuoteName = buildSuggestedQuotationName(suggestedClientName);

  document.getElementById('modal-title').textContent = 'Guardar cotización';
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-grid">
      <div class="form-group span-full">
        <label>Cliente para esta cotización</label>
        <input type="text" id="quotation-client-name" class="form-input" value="${escapeHtml(suggestedClientName)}" placeholder="Ej: Juan Pérez">
        <span class="helper-text">La cotización quedará guardada con este nombre para recuperarla después.</span>
      </div>
      <div class="form-group span-full">
        <label>Nombre de la cotización</label>
        <input type="text" id="quotation-name" class="form-input" value="${escapeHtml(suggestedQuoteName)}" placeholder="Ej: Juan Pérez · 10/04/2026">
      </div>
    </div>
  `;
  document.getElementById('modal-footer').innerHTML = `
    <button class="btn-secondary" onclick="closeAllModals()">Cancelar</button>
    <button class="btn-secondary" onclick="confirmSaveQuotation({ printAfterSave: true })">Guardar e imprimir</button>
    <button class="btn-primary" onclick="confirmSaveQuotation()">Guardar cotización</button>
  `;
  document.getElementById('modal-box').classList.remove('billing-modal');
  document.getElementById('modal-overlay').classList.remove('hidden');
  if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('modal-overlay'));
  setTimeout(() => document.getElementById('quotation-client-name')?.focus(), 0);
}

function buildQuotationReceiptDocument(quotation) {
  const items = (Array.isArray(quotation?.items) ? quotation.items : []).map((item) => {
    const qty = Number(item?.qty || 0);
    const precio = Number(item?.precio || item?.price || 0);
    const total = roundSaleMoney(item?.total ?? (qty * precio ?? 0));
    const itbis = Number(item?.itbis || 0);
    return {
      ...item,
      qty,
      precio,
      total,
      subtotal: total,
      itbis
    };
  });
  const totals = calcularTotales(items, {
    generalDiscountRate: Number(quotation?.generalDiscount || 0),
    config: DB.config
  });
  const quoteId = String(quotation?.id || quotation?.nombre || 'COT').trim() || 'COT';

  return {
    id: quoteId,
    previewInvoiceNumber: quoteId,
    tipoComprobante: 'ticket',
    fecha: quotation?.hora || quotation?.fecha || new Date().toLocaleString('es-DO'),
    cajero: DB.currentUser?.nombre || DB.currentUser?.usuario || 'Sistema',
    cliente: quotation?.clientName || 'Consumidor Final',
    metodo: 'efectivo',
    subtotal: totals.subtotal,
    subtotalGravado: totals.subtotalGravado,
    subtotalExento: totals.subtotalExento,
    descuento: totals.discount,
    itbis: totals.itbis,
    total: totals.total,
    recibido: totals.total,
    cambio: 0,
    items,
    isQuotation: true,
    receiptHeaderSubtitle: 'COMPROBANTE DE COTIZACION',
    receiptDocumentTitle: 'COTIZACION',
    receiptDocumentNumber: `Cotizacion ${quoteId}`,
    receiptDataSectionTitle: 'DATOS DE LA COTIZACION',
    receiptFooterMessageOverride: 'ESTA ES UNA COTIZACION. NO ES UNA FACTURA. GRACIAS POR SU PREFERENCIA.',
    receiptPrimaryLabel: 'Cotización',
    receiptMethodRowLabel: 'Tipo',
    receiptMethodLabelOverride: 'Cotización',
    printSuccessMessage: 'Cotización enviada a impresión.',
    printFailureMessage: 'No se pudo imprimir la cotización.'
  };
}

function buildPrintableQuotationHtml(quotation) {
  return buildPrintableReceiptHtml(buildQuotationReceiptDocument(quotation));
}

async function printQuotationDocument(quotation) {
  if (!quotation?.items?.length) {
    showToast('No hay una cotización lista para imprimir.', 'warning');
    return false;
  }
  const quotationReceipt = buildQuotationReceiptDocument(quotation);
  return await printReceipt(quotationReceipt);
}

function recoverSale() {
  if (!DB.ventasPendientes.length && !DB.cotizaciones?.length) { showToast('No hay ventas ni cotizaciones guardadas', 'warning'); return; }
  renderRecoverSalesModalContent();
}

async function confirmSuspendSale() {
  if (!DB.saleItems.length) {
    showToast('No hay venta activa para suspender', 'warning');
    return;
  }

  const input = document.getElementById('suspend-sale-name');
  const draft = buildSuspendedSaleDraft(input?.value || '');

  try {
    const response = await api.saveSuspendedSale({
      ...draft,
      ...getActorPayload()
    });
    const saved = response?.suspendedSale || draft;
    DB.ventasPendientes = [
      saved,
      ...DB.ventasPendientes.filter((item) => item.id !== saved.id)
    ];
    closeAllModals();
    cancelSale();
    updateNotifications();
    showToast(`Venta suspendida como ${saved.nombre}.`, 'success');
  } catch (error) {
    showToast(error.message || 'No se pudo guardar la venta suspendida.', 'error');
  }
}

async function confirmSaveQuotation(options = {}) {
  if (!DB.saleItems.length) {
    showToast('No hay productos para cotizar', 'warning');
    return;
  }

  const clientInput = document.getElementById('quotation-client-name');
  const quoteNameInput = document.getElementById('quotation-name');
  const clientName = String(clientInput?.value || '').trim();
  if (!clientName) {
    showToast('Escribe el nombre del cliente para guardar la cotización', 'warning');
    clientInput?.focus();
    return;
  }

  const draft = buildQuotationDraft({
    name: quoteNameInput?.value || '',
    clientName
  });
  const printAfterSave = Boolean(options?.printAfterSave);

  try {
    const response = await api.saveQuotation({
      ...draft,
      ...getActorPayload()
    });
    const saved = response?.quotation || draft;
    DB.cotizaciones = [
      saved,
      ...(DB.cotizaciones || []).filter((item) => item.id !== saved.id)
    ];
    closeAllModals();
    updateNotifications();
    if (printAfterSave) {
      try {
        const printed = await printQuotationDocument(saved);
        if (!printed) {
          showToast('La cotización se guardó, pero no se pudo imprimir.', 'warning');
          return;
        }
        cancelSale();
        scheduleSalesSearchFocus({ force: true, delay: 40 });
        showToast(`Cotización guardada e impresa para ${saved.clientName}.`, 'success');
      } catch (printError) {
        showToast(printError.message || 'La cotización se guardó, pero no se pudo imprimir.', 'warning');
      }
      return;
    }
    showToast(`Cotización guardada para ${saved.clientName}.`, 'success');
  } catch (error) {
    showToast(error.message || 'No se pudo guardar la cotización.', 'error');
  }
}

async function recoverSuspendedSaleById(pendingId) {
  const pending = DB.ventasPendientes.find((item) => item.id === pendingId);
  if (!pending) {
    showToast('La venta suspendida ya no está disponible.', 'warning');
    return;
  }

  if (DB.saleItems.length && !await showDeleteConfirm('Hay una venta activa en pantalla. Si recuperas esta, la actual se reemplazará.', { confirmText: 'Recuperar' })) {
    return;
  }

  try {
    await api.deleteSuspendedSale(pendingId, getActorPayload());
    DB.ventasPendientes = DB.ventasPendientes.filter((item) => item.id !== pendingId);
    clearRecoveredQuotationTracking();
    closeAllModals();
    applyRecoveredSuspendedSale(pending);
    showToast(`Venta recuperada: ${pending.nombre}.`, 'success');
  } catch (error) {
    showToast(error.message || 'No se pudo recuperar la venta suspendida.', 'error');
  }
}

function applyRecoveredQuotation(quotation) {
  applyRecoveredSuspendedSale({
    ...quotation,
    clientId: quotation.clientId || findClientIdByName(quotation.clientName)
  });
  activeRecoveredQuotationId = quotation.id || null;
  activeRecoveredQuotationName = quotation.nombre || quotation.clientName || 'Cotización';
}

async function recoverQuotationById(quotationId) {
  const quotation = (DB.cotizaciones || []).find((item) => item.id === quotationId);
  if (!quotation) {
    showToast('La cotización ya no está disponible.', 'warning');
    return;
  }

  if (DB.saleItems.length && !await showDeleteConfirm('Hay una venta activa en pantalla. Si recuperas esta cotización, la actual se reemplazará.', { confirmText: 'Recuperar' })) {
    return;
  }

  closeAllModals();
  applyRecoveredQuotation(quotation);
  showToast(`Cotización cargada: ${quotation.clientName || quotation.nombre}.`, 'success');
}

async function deleteQuotationById(quotationId) {
  const quotation = (DB.cotizaciones || []).find((item) => item.id === quotationId);
  if (!quotation) {
    showToast('La cotización ya no está disponible.', 'warning');
    return;
  }

  const quotationLabel = quotation.nombre || quotation.clientName || quotationId;

  if (!await showDeleteConfirm(`Se eliminará la cotización <strong>${quotationLabel}</strong>. Esta acción no se puede deshacer.`)) {
    return;
  }

  try {
    await api.deleteQuotation(quotationId, getActorPayload());
    DB.cotizaciones = (DB.cotizaciones || []).filter((item) => item.id !== quotationId);
    if (activeRecoveredQuotationId === quotationId) {
      clearRecoveredQuotationTracking();
    }
    refreshRecoverSalesModalIfOpen();
    updateNotifications();
    showToast(`Cotización eliminada: ${quotation.clientName || quotation.nombre}.`, 'success');
  } catch (error) {
    showToast(error.message || 'No se pudo eliminar la cotización.', 'error');
  }
}

function reprintReceipt() {
  if (!DB.ventas.length) { showToast('No hay ventas registradas', 'warning'); return; }
  showReceipt(DB.ventas[0]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BÁSCULA TCP — integración tiempo real por Socket.IO
// ═══════════════════════════════════════════════════════════════════════════════

let _basculaSocket = null;
let _basculaLastWeight = null; // { kg, g, unit, ts }
let _basculaFloatTimer = null;

function initBasculaTcpListener() {
  if (_basculaSocket || typeof io === 'undefined') return;
  try {
    _basculaSocket = io();

    _basculaSocket.on('bascula:peso', (data) => {
      if (!data || !data.kg) return;
      _basculaLastWeight = { kg: data.kg, g: data.g || Math.round(data.kg * 1000), unit: data.unit || 'kg', ts: data.ts || Date.now() };
      _showBasculaFloat(data.kg);
    });

    _basculaSocket.on('bascula:status', (data) => {
      _updateBasculaStatusDot(data);
    });
  } catch (_) {}
}

function _showBasculaFloat(kg) {
  const el = document.getElementById('bascula-float');
  const val = document.getElementById('bascula-float-value');
  if (!el || !val) return;
  val.textContent = `${kg.toFixed(3)} kg (${Math.round(kg * 1000)} g)`;
  el.style.display = 'flex';
  clearTimeout(_basculaFloatTimer);
  // Ocultar si en 4s no llega otro dato (producto retirado de báscula)
  _basculaFloatTimer = setTimeout(() => {
    el.style.display = 'none';
    _basculaLastWeight = null;
  }, 4000);
}

// Cuando el usuario hace clic en un producto de peso → usar peso de la báscula TCP si está fresco
function addBasculaTcpWeightToProduct(prod) {
  if (!_basculaLastWeight) return false;
  const ageSec = (Date.now() - _basculaLastWeight.ts) / 1000;
  if (ageSec > 4) return false; // peso vencido
  if (!prod || !prod.id) return false;

  const utils = getSaleScaleUtils();
  const saleMode = getSaleItemSaleMode(prod, prod);
  if (saleMode !== 'peso') return false;

  const weightUnit = utils.normalizeWeightUnit(prod.weightUnit || prod.unidadPeso || DB.config?.scaleDefaultUnit, 'kg');
  const nextQty = weightUnit === 'g' ? _basculaLastWeight.g : _basculaLastWeight.kg;
  if (!nextQty || nextQty <= 0) return false;

  const lineExtra = {
    weightUnit,
    scaleWeight: _basculaLastWeight.kg,
    scaleMeasuredValue: _basculaLastWeight.g,
    scaleMeasuredUnit: 'g',
    scaleSource: 'tcp-network'
  };

  const existIdx = findMergeableSaleItemIndex(prod, saleMode);
  if (existIdx >= 0) {
    DB.saleItems[existIdx] = recalcSaleItemForQty(DB.saleItems[existIdx], nextQty);
  } else {
    DB.saleItems.push(buildSaleItem(prod, nextQty, lineExtra));
  }

  document.getElementById('product-search').value = '';
  document.getElementById('search-dropdown')?.classList.add('hidden');
  searchResults = [];
  renderSaleTable();
  updateTotals();
  focusSalesSearchInput({ force: true });
  showToast(`${prod.nombre} — ${nextQty.toFixed(3)} kg agregado`, 'success');
  return true;
}

// ─── Funciones del panel de configuración (módulo Configuración) ───────────────

function _updateBasculaStatusDot(data) {
  const dot = document.getElementById('cfg-bascula-dot');
  const txt = document.getElementById('cfg-bascula-text');
  const btnDisc = document.getElementById('cfg-bascula-btn-disconnect');
  if (!dot || !txt) return;
  if (data.connected) {
    dot.style.background = '#22c55e';
    txt.textContent = `Conectado — ${data.ip}:${data.port}`;
    if (btnDisc) btnDisc.style.display = '';
  } else {
    dot.style.background = '#ef4444';
    txt.textContent = data.ip ? `Desconectado — reintentando ${data.ip}:${data.port}…` : 'Sin configurar';
    if (btnDisc) btnDisc.style.display = 'none';
  }
}

async function loadBasculaConfig() {
  try {
    const res = await fetch('/api/config/bascula');
    if (!res.ok) return;
    const data = await res.json();
    if (data.saved?.ip) document.getElementById('cfg-bascula-ip').value = data.saved.ip;
    if (data.saved?.port) document.getElementById('cfg-bascula-port').value = data.saved.port;
    _updateBasculaStatusDot(data);
  } catch (_) {}
}

async function testBasculaConnection() {
  const ip = document.getElementById('cfg-bascula-ip')?.value?.trim();
  const port = document.getElementById('cfg-bascula-port')?.value?.trim();
  if (!ip || !port) { showToast('Ingresa IP y puerto primero', 'warning'); return; }
  const dot = document.getElementById('cfg-bascula-dot');
  const txt = document.getElementById('cfg-bascula-text');
  if (dot) dot.style.background = '#f59e0b';
  if (txt) txt.textContent = 'Probando conexión…';
  try {
    const res = await fetch('/api/config/bascula/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, port: Number(port) })
    });
    const data = await res.json();
    if (data.reachable) {
      if (dot) dot.style.background = '#22c55e';
      if (txt) txt.textContent = `Puerto ${ip}:${port} accesible. Guarda para conectar.`;
      showToast(`Báscula alcanzable en ${ip}:${port}`, 'success');
    } else {
      if (dot) dot.style.background = '#ef4444';
      if (txt) txt.textContent = `No se pudo alcanzar ${ip}:${port}. Verifica la IP y el puerto.`;
      showToast(`No se pudo conectar con ${ip}:${port}`, 'error');
    }
  } catch (_) {
    if (dot) dot.style.background = '#ef4444';
    if (txt) txt.textContent = 'Error al probar la conexión';
    showToast('Error al probar la conexión', 'error');
  }
}

async function saveBasculaConfig() {
  const ip = document.getElementById('cfg-bascula-ip')?.value?.trim();
  const port = document.getElementById('cfg-bascula-port')?.value?.trim();
  if (!ip || !port) { showToast('Ingresa IP y puerto', 'warning'); return; }
  try {
    const res = await fetch('/api/config/bascula', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, port: Number(port) })
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Báscula guardada. Conectando…', 'success');
      _updateBasculaStatusDot(data.status || { connected: false, ip, port });
    } else {
      showToast(data.error || 'Error al guardar', 'error');
    }
  } catch (_) {
    showToast('Error al guardar la báscula', 'error');
  }
}

async function disconnectBascula() {
  try {
    await fetch('/api/config/bascula', { method: 'DELETE' });
    document.getElementById('cfg-bascula-ip').value = '';
    document.getElementById('cfg-bascula-port').value = '';
    _updateBasculaStatusDot({ connected: false, ip: null, port: null });
    showToast('Báscula desconectada', 'info');
  } catch (_) {
    showToast('Error al desconectar', 'error');
  }
}

// Inicializar listener al cargar el módulo
if (typeof io !== 'undefined') {
  initBasculaTcpListener();
} else {
  window.addEventListener('load', initBasculaTcpListener);
}
