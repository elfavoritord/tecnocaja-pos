'use strict';

(function registerTecnoCajaScaleUtils(globalScope) {
  const DEFAULT_SCALE_PATTERN = '(-?\\d+(?:[\\.,]\\d+)?)\\s*(kg|g|lb)?';
  const DEFAULT_WEIGHT_UNIT = 'kg';
  const DEFAULT_DECIMALS = 2;

  const WEIGHT_UNIT_ALIASES = new Map([
    ['kg', 'kg'],
    ['kilo', 'kg'],
    ['kilos', 'kg'],
    ['kilogramo', 'kg'],
    ['kilogramos', 'kg'],
    ['kilogramo (kg)', 'kg'],
    ['kilogramos (kg)', 'kg'],
    ['g', 'g'],
    ['gramo', 'g'],
    ['gramos', 'g'],
    ['gramo (g)', 'g'],
    ['gramos (g)', 'g'],
    ['lb', 'lb'],
    ['lbs', 'lb'],
    ['libra', 'lb'],
    ['libras', 'lb'],
    ['libra (lb)', 'lb'],
    ['libras (lb)', 'lb']
  ]);

  const SALE_MODE_ALIASES = new Map([
    ['unidad', 'unidad'],
    ['unit', 'unidad'],
    ['medida', 'medida'],
    ['measure', 'medida'],
    ['peso', 'peso'],
    ['weight', 'peso']
  ]);

  function normalizeText(value) {
    return String(value || '').trim().toLowerCase();
  }

  function normalizeSaleMode(value) {
    return SALE_MODE_ALIASES.get(normalizeText(value)) || 'unidad';
  }

  function normalizeWeightUnit(value, fallback = '') {
    const normalized = WEIGHT_UNIT_ALIASES.get(normalizeText(value));
    if (normalized) return normalized;
    return fallback ? normalizeWeightUnit(fallback, '') : '';
  }

  function isWeightUnit(value) {
    return ['kg', 'g', 'lb'].includes(normalizeWeightUnit(value));
  }

  function getWeightUnitLabel(value) {
    const unit = normalizeWeightUnit(value, DEFAULT_WEIGHT_UNIT) || DEFAULT_WEIGHT_UNIT;
    if (unit === 'g') return 'Gramo (g)';
    if (unit === 'lb') return 'Libra (lb)';
    return 'Kilogramo (kg)';
  }

  function sanitizeDecimals(value, fallback = DEFAULT_DECIMALS) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(0, Math.min(2, Math.floor(numeric)));
  }

  function roundValue(value, decimals = DEFAULT_DECIMALS) {
    const numeric = Number(value || 0);
    const normalizedDecimals = sanitizeDecimals(decimals);
    if (!Number.isFinite(numeric)) return 0;
    return Number(numeric.toFixed(normalizedDecimals));
  }

  function formatValue(value, decimals = DEFAULT_DECIMALS) {
    const numeric = Number(value || 0);
    const normalizedDecimals = sanitizeDecimals(decimals);
    return numeric.toLocaleString('es-DO', {
      minimumFractionDigits: normalizedDecimals,
      maximumFractionDigits: normalizedDecimals
    });
  }

  function convertWeight(value, fromUnit, toUnit) {
    const numeric = Number(value || 0);
    const normalizedFrom = normalizeWeightUnit(fromUnit, DEFAULT_WEIGHT_UNIT) || DEFAULT_WEIGHT_UNIT;
    const normalizedTo = normalizeWeightUnit(toUnit, normalizedFrom) || normalizedFrom;
    if (!Number.isFinite(numeric)) return 0;
    if (normalizedFrom === normalizedTo) return numeric;

    let valueInKg = numeric;
    if (normalizedFrom === 'g') valueInKg = numeric / 1000;
    if (normalizedFrom === 'lb') valueInKg = numeric * 0.45359237;

    if (normalizedTo === 'g') return valueInKg * 1000;
    if (normalizedTo === 'lb') return valueInKg / 0.45359237;
    return valueInKg;
  }

  function parseScaleReading(rawValue, options = {}) {
    const raw = String(rawValue || '')
      .replace(/\u0000/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!raw) {
      return {
        ok: false,
        raw: '',
        reason: 'empty'
      };
    }

    const configuredPattern = String(options.pattern || DEFAULT_SCALE_PATTERN).trim() || DEFAULT_SCALE_PATTERN;
    let matcher = null;
    try {
      matcher = new RegExp(configuredPattern, 'i');
    } catch (_error) {
      matcher = new RegExp(DEFAULT_SCALE_PATTERN, 'i');
    }

    const match = raw.match(matcher);
    if (!match) {
      return {
        ok: false,
        raw,
        reason: 'pattern_mismatch'
      };
    }

    const numericSource = String(match[1] || '')
      .replace(/\s+/g, '')
      .replace(/,/g, '.');
    const numericValue = Number.parseFloat(numericSource);
    if (!Number.isFinite(numericValue)) {
      return {
        ok: false,
        raw,
        reason: 'invalid_number'
      };
    }

    const unit = normalizeWeightUnit(match[2], options.defaultUnit || DEFAULT_WEIGHT_UNIT) || DEFAULT_WEIGHT_UNIT;
    const decimals = sanitizeDecimals(options.decimals, DEFAULT_DECIMALS);
    const roundedValue = roundValue(numericValue, decimals);

    return {
      ok: true,
      raw,
      unit,
      decimals,
      value: roundedValue,
      valueRaw: numericValue
    };
  }

  function getProductSaleMode(product = {}) {
    return normalizeSaleMode(product.saleMode || product.sale_mode || product.ventaPor);
  }

  function getProductWeightUnit(product = {}, fallback = DEFAULT_WEIGHT_UNIT) {
    return normalizeWeightUnit(product.unidad || product.unit || product.scaleUnit, fallback) || fallback;
  }

  function isProductSoldByWeight(product = {}) {
    return getProductSaleMode(product) === 'peso';
  }

  function isProductSoldByMeasure(product = {}) {
    return getProductSaleMode(product) === 'medida';
  }

  function getQuantityStepForProduct(product = {}) {
    return getProductSaleMode(product) === 'unidad' ? '1' : '0.01';
  }

  function formatQuantityForProduct(value, product = {}, decimals = DEFAULT_DECIMALS) {
    if (getProductSaleMode(product) === 'unidad') {
      const numeric = Number(value || 0);
      return Number.isFinite(numeric) ? String(Math.max(0, Math.round(numeric))) : '0';
    }
    return formatValue(value, decimals);
  }

  globalScope.TecnoCajaScaleUtils = {
    DEFAULT_SCALE_PATTERN,
    DEFAULT_WEIGHT_UNIT,
    convertWeight,
    formatQuantityForProduct,
    formatValue,
    getProductSaleMode,
    getProductWeightUnit,
    getQuantityStepForProduct,
    getWeightUnitLabel,
    isProductSoldByMeasure,
    isProductSoldByWeight,
    isWeightUnit,
    normalizeSaleMode,
    normalizeWeightUnit,
    parseScaleReading,
    roundValue,
    sanitizeDecimals
  };
})(window);
