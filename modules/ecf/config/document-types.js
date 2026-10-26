'use strict';

// Nombres como los muestra la DGII en la Oficina Virtual al solicitar
// secuencias e-NCF, para que el usuario reconozca cada tipo al copiar el rango.
const ECF_DOCUMENT_TYPES = [
  { code: 'E31', label: 'Factura de Crédito Fiscal Electrónica', group: 'facturas', buyerTaxIdRequired: true, allowsConsumerFinal: false },
  { code: 'E32', label: 'Factura de Consumo Electrónica', group: 'facturas', buyerTaxIdRequired: false, allowsConsumerFinal: true },
  { code: 'E33', label: 'Nota de Débito Electrónica', group: 'notas', buyerTaxIdRequired: true, allowsConsumerFinal: false },
  { code: 'E34', label: 'Nota de Crédito Electrónica', group: 'notas', buyerTaxIdRequired: true, allowsConsumerFinal: false },
  { code: 'E41', label: 'Compras Electrónico', group: 'especiales', buyerTaxIdRequired: true, allowsConsumerFinal: false },
  { code: 'E43', label: 'Gastos Menores Electrónico', group: 'especiales', buyerTaxIdRequired: false, allowsConsumerFinal: true },
  { code: 'E44', label: 'Regímenes Especiales Electrónico', group: 'especiales', buyerTaxIdRequired: true, allowsConsumerFinal: false },
  { code: 'E45', label: 'Gubernamental Electrónico', group: 'especiales', buyerTaxIdRequired: true, allowsConsumerFinal: false },
  { code: 'E46', label: 'Exportaciones Electrónico', group: 'especiales', buyerTaxIdRequired: false, allowsConsumerFinal: false },
  { code: 'E47', label: 'Pagos al Exterior Electrónico', group: 'especiales', buyerTaxIdRequired: false, allowsConsumerFinal: false },
];

const DOCUMENT_TYPE_MAP = new Map(ECF_DOCUMENT_TYPES.map((item) => [item.code, item]));

function getDocumentTypes() {
  return ECF_DOCUMENT_TYPES.map((item) => ({ ...item }));
}

function getDocumentType(code) {
  return DOCUMENT_TYPE_MAP.get(String(code || '').trim().toUpperCase()) || null;
}

function resolveElectronicDocumentType({ requestedType, clientRnc }) {
  const normalizedRequested = String(requestedType || '').trim().toUpperCase();
  if (getDocumentType(normalizedRequested)) {
    return normalizedRequested;
  }
  return String(clientRnc || '').trim() ? 'E31' : 'E32';
}

module.exports = {
  ECF_DOCUMENT_TYPES,
  getDocumentType,
  getDocumentTypes,
  resolveElectronicDocumentType,
};
