'use strict';

const { getDocumentType } = require('../config/document-types');

function hasTaxId(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 9 || digits.length === 11;
}

function validateEmitterForEcf(emitter = {}) {
  const errors = [];
  if (!String(emitter.rnc || '').trim()) {
    errors.push('El RNC del emisor no está configurado.');
  }
  if (!String(emitter.razon_social || emitter.razonSocial || '').trim()) {
    errors.push('La razón social del emisor no está configurada.');
  }
  return errors;
}

function validateCertificateForEcf(certificateStatus = {}) {
  const errors = [];
  if (!certificateStatus.hasCertificate) {
    errors.push('No hay certificado digital configurado.');
  } else if (certificateStatus.isExpired) {
    errors.push('El certificado digital está vencido.');
  } else if (certificateStatus.status === 'error') {
    errors.push(`El certificado digital no se pudo cargar (revisa el archivo .p12 y su contraseña): ${certificateStatus.error || 'error desconocido'}.`);
  }
  return errors;
}

function validateBuyerForEcf({ tipoEcf, buyerTaxId, buyerName, documentType } = {}) {
  const errors = [];
  const type = documentType || getDocumentType(tipoEcf);
  if (!type) return errors;

  if (type.buyerTaxIdRequired && !hasTaxId(buyerTaxId)) {
    errors.push(`El comprador debe tener RNC o Cédula válida para emitir un ${type.label} (${type.code}).`);
  }

  if (!type.allowsConsumerFinal) {
    const name = String(buyerName || '').trim();
    if (!name || name === 'Consumidor Final') {
      errors.push(`Debe indicar la razón social o nombre completo del comprador para emitir un ${type.label} (${type.code}).`);
    }
  }

  return errors;
}

/**
 * Validación previa al envío a DGII. Solo cubre lo que puede verificarse con
 * datos fiables (emisor, certificado, identificación del comprador) — no
 * recalcula totales de la venta porque eso ya lo hace ecf-generator.js con
 * los montos reales de la venta.
 */
function validateSaleForEcf({ emitter = {}, certificateStatus = {}, tipoEcf, buyerTaxId, buyerName, documentType } = {}) {
  const errors = [
    ...validateEmitterForEcf(emitter),
    ...validateCertificateForEcf(certificateStatus),
    ...validateBuyerForEcf({ tipoEcf, buyerTaxId, buyerName, documentType }),
  ];
  return { ok: errors.length === 0, errors };
}

module.exports = {
  hasTaxId,
  validateBuyerForEcf,
  validateCertificateForEcf,
  validateEmitterForEcf,
  validateSaleForEcf,
};
