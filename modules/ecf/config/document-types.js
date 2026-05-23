'use strict';

const ECF_DOCUMENT_TYPES = [
  { code: 'E31', label: 'Factura de Crédito Fiscal', buyerTaxIdRequired: true, allowsConsumerFinal: false },
  { code: 'E32', label: 'Factura de Consumo', buyerTaxIdRequired: false, allowsConsumerFinal: true },
  { code: 'E33', label: 'Nota de Débito', buyerTaxIdRequired: true, allowsConsumerFinal: false },
  { code: 'E34', label: 'Nota de Crédito', buyerTaxIdRequired: true, allowsConsumerFinal: false },
  { code: 'E41', label: 'Compras', buyerTaxIdRequired: true, allowsConsumerFinal: false },
  { code: 'E43', label: 'Gastos Menores', buyerTaxIdRequired: false, allowsConsumerFinal: true },
  { code: 'E44', label: 'Regímenes Especiales', buyerTaxIdRequired: true, allowsConsumerFinal: false },
  { code: 'E45', label: 'Gubernamental', buyerTaxIdRequired: true, allowsConsumerFinal: false },
  { code: 'E46', label: 'Exportaciones', buyerTaxIdRequired: false, allowsConsumerFinal: false },
  { code: 'E47', label: 'Pagos al Exterior', buyerTaxIdRequired: false, allowsConsumerFinal: false },
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
