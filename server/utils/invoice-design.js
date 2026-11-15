'use strict';

/**
 * Diseño de la factura A4 que se guarda en config (invoice_template e
 * invoice_accent_color). Las plantillas se dibujan en el renderer
 * (js/factura-plantillas.js); esta lista debe coincidir con la de allá.
 * null = valor por defecto (plantilla clásica / color propio de la plantilla).
 */
const INVOICE_TEMPLATES = Object.freeze(['clasica', 'ejecutiva', 'recuadro', 'banner']);

function sanitizeInvoiceTemplate(value) {
  const clean = String(value || '').trim().toLowerCase();
  return INVOICE_TEMPLATES.includes(clean) ? clean : null;
}

function sanitizeInvoiceAccentColor(value) {
  const clean = String(value || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(clean) ? clean : null;
}

// Tamaño del logo en facturas y tickets (config.invoice_logo_scale): % del
// tamaño de siempre, de 30 a 100 (los mismos límites que js/factura-plantillas.js).
// null = 100.
const INVOICE_LOGO_SCALE_MIN = 30;
const INVOICE_LOGO_SCALE_MAX = 100;

function sanitizeInvoiceLogoScale(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(INVOICE_LOGO_SCALE_MAX, Math.max(INVOICE_LOGO_SCALE_MIN, n));
}

module.exports = {
  INVOICE_TEMPLATES,
  INVOICE_LOGO_SCALE_MIN,
  INVOICE_LOGO_SCALE_MAX,
  sanitizeInvoiceTemplate,
  sanitizeInvoiceAccentColor,
  sanitizeInvoiceLogoScale
};
