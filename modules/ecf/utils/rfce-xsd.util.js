'use strict';

const path = require('path');
const { EcfError } = require('./errors');
const { parseXml } = require('./xml.util');
const { detectXmlRoot } = require('./dgii-file.util');

const RFCE_XSD_PATH = path.resolve(__dirname, '..', 'schemas', 'RFCE 32 v.1.0.xsd');

function localName(node) {
  return String(node?.localName || node?.nodeName || '').replace(/^.*:/, '');
}

function childElements(node) {
  return Array.from(node?.childNodes || []).filter((child) => child.nodeType === 1);
}

function firstDirectChild(node, name) {
  return childElements(node).find((child) => localName(child) === name) || null;
}

function textOf(parent, name) {
  const node = firstDirectChild(parent, name);
  return String(node?.textContent || '').trim();
}

function hasAnyTag(xml, tagName) {
  return new RegExp(`<${tagName}\\b`, 'i').test(String(xml || ''));
}

function assertSequence(parent, expected, errors, label) {
  const actual = childElements(parent)
    .map(localName)
    .filter((name) => name !== 'Signature');
  let cursor = 0;
  for (const name of actual) {
    const next = expected.indexOf(name, cursor);
    if (next === -1) {
      errors.push(`${label}: elemento fuera de orden o no permitido: ${name}.`);
      continue;
    }
    cursor = next;
  }
}

function isMoney(value, { positive = false } = {}) {
  if (!/^[0-9]{1,16}\.[0-9]{2}$/.test(String(value || ''))) return false;
  return !positive || Number(value) > 0;
}

function validateRfceXml(xmlContent, { requireSignature = true } = {}) {
  const xml = String(xmlContent || '').replace(/^\uFEFF/, '').trim();
  const errors = [];

  if (!xml) errors.push('El XML RFCE está vacío.');
  if (detectXmlRoot(xml) !== 'RFCE') errors.push('La raíz del XML RFCE debe ser <RFCE>.');
  if (hasAnyTag(xml, 'ECF')) errors.push('Un RFCE no debe contener raíz/sección ECF.');
  if (hasAnyTag(xml, 'DetallesItems')) errors.push('Un RFCE no debe incluir DetallesItems.');
  if (hasAnyTag(xml, 'NombreComercial')) errors.push('Un RFCE no debe incluir NombreComercial.');
  if (hasAnyTag(xml, 'FechaHoraFirma')) errors.push('Un RFCE no debe incluir FechaHoraFirma; solo firma XMLDSig.');
  if (requireSignature && !hasAnyTag(xml, 'Signature')) errors.push('El RFCE debe estar firmado digitalmente.');

  let doc;
  try {
    doc = parseXml(xml);
  } catch (error) {
    errors.push(`XML RFCE inválido: ${error.message}`);
  }

  const root = doc?.documentElement || null;
  const encabezado = firstDirectChild(root, 'Encabezado');
  if (!encabezado) errors.push('RFCE requiere Encabezado.');

  if (encabezado) {
    assertSequence(encabezado, ['Version', 'IdDoc', 'Emisor', 'Comprador', 'Totales', 'CodigoSeguridadeCF'], errors, 'Encabezado');
    const version = textOf(encabezado, 'Version');
    if (version !== '1.0') errors.push('Version RFCE debe ser 1.0.');

    const idDoc = firstDirectChild(encabezado, 'IdDoc');
    if (!idDoc) {
      errors.push('RFCE requiere IdDoc.');
    } else {
      assertSequence(idDoc, ['TipoeCF', 'eNCF', 'TipoIngresos', 'TipoPago', 'TablaFormasPago'], errors, 'IdDoc');
      if (textOf(idDoc, 'TipoeCF') !== '32') errors.push('RFCE TipoeCF debe ser 32.');
      if (!/^[A-Za-z0-9]{13}$/.test(textOf(idDoc, 'eNCF'))) errors.push('RFCE eNCF debe tener 13 caracteres alfanuméricos.');
      if (!/^0[1-6]$/.test(textOf(idDoc, 'TipoIngresos'))) errors.push('RFCE TipoIngresos debe estar entre 01 y 06.');
      if (!/^[123]$/.test(textOf(idDoc, 'TipoPago'))) errors.push('RFCE TipoPago debe ser 1, 2 o 3.');
      const formas = childElements(firstDirectChild(idDoc, 'TablaFormasPago')).filter((node) => localName(node) === 'FormaDePago');
      if (formas.length > 7) errors.push('RFCE TablaFormasPago admite máximo 7 FormaDePago.');
      for (const forma of formas) {
        const formaPago = textOf(forma, 'FormaPago');
        const montoPago = textOf(forma, 'MontoPago');
        if (formaPago && !/^[1-8]$/.test(formaPago)) errors.push('RFCE FormaPago debe estar entre 1 y 8.');
        if (montoPago && !isMoney(montoPago)) errors.push('RFCE MontoPago debe tener formato 0.00.');
      }
    }

    const emisor = firstDirectChild(encabezado, 'Emisor');
    if (!emisor) {
      errors.push('RFCE requiere Emisor.');
    } else {
      assertSequence(emisor, ['RNCEmisor', 'RazonSocialEmisor', 'FechaEmision'], errors, 'Emisor');
      if (!/^([0-9]{9}|[0-9]{11})$/.test(textOf(emisor, 'RNCEmisor'))) errors.push('RFCE RNCEmisor debe tener 9 u 11 dígitos.');
      if (!textOf(emisor, 'RazonSocialEmisor')) errors.push('RFCE requiere RazonSocialEmisor.');
      if (!/^(3[01]|[12][0-9]|0?[1-9])-(1[012]|0?[1-9])-((?:19|20)\d{2})$/.test(textOf(emisor, 'FechaEmision'))) {
        errors.push('RFCE FechaEmision debe tener formato dd-MM-aaaa.');
      }
    }

    const comprador = firstDirectChild(encabezado, 'Comprador');
    if (comprador) {
      assertSequence(comprador, ['RNCComprador', 'IdentificadorExtranjero', 'RazonSocialComprador'], errors, 'Comprador');
      const rncComprador = textOf(comprador, 'RNCComprador');
      if (rncComprador && !/^([0-9]{9}|[0-9]{11})$/.test(rncComprador)) errors.push('RFCE RNCComprador debe tener 9 u 11 dígitos.');
    }

    const totales = firstDirectChild(encabezado, 'Totales');
    if (!totales) {
      errors.push('RFCE requiere Totales.');
    } else {
      assertSequence(totales, [
        'MontoGravadoTotal', 'MontoGravadoI1', 'MontoGravadoI2', 'MontoGravadoI3',
        'MontoExento', 'TotalITBIS', 'TotalITBIS1', 'TotalITBIS2', 'TotalITBIS3',
        'MontoImpuestoAdicional', 'ImpuestosAdicionales', 'MontoTotal', 'MontoNoFacturable', 'MontoPeriodo',
      ], errors, 'Totales');
      const moneyFields = ['MontoGravadoTotal', 'MontoGravadoI1', 'MontoGravadoI2', 'MontoGravadoI3', 'MontoExento', 'TotalITBIS', 'TotalITBIS1', 'TotalITBIS2', 'TotalITBIS3', 'MontoTotal'];
      for (const field of moneyFields) {
        const value = textOf(totales, field);
        if (value && !isMoney(value)) errors.push(`RFCE ${field} debe tener formato 0.00.`);
      }
      if (!textOf(totales, 'MontoTotal')) errors.push('RFCE requiere MontoTotal.');
    }

    const codigo = textOf(encabezado, 'CodigoSeguridadeCF');
    if (!/^.{6}$/.test(codigo)) errors.push('RFCE CodigoSeguridadeCF debe tener exactamente 6 caracteres.');
  }

  return {
    ok: errors.length === 0,
    errors,
    schemaPath: RFCE_XSD_PATH,
  };
}

function assertValidRfceXml(xmlContent, options = {}) {
  const result = validateRfceXml(xmlContent, options);
  if (!result.ok) {
    throw new EcfError(`RFCE no cumple la estructura XSD oficial: ${result.errors[0]}`, {
      statusCode: 422,
      details: result,
    });
  }
  return result;
}

module.exports = {
  RFCE_XSD_PATH,
  assertValidRfceXml,
  validateRfceXml,
};
