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

module.exports = {
  INVOICE_TEMPLATES,
  sanitizeInvoiceTemplate,
  sanitizeInvoiceAccentColor
};
