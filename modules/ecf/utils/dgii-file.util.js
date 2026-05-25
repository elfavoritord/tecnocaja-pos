'use strict';

const fs = require('fs');
const path = require('path');
const { EcfError, assertCondition } = require('./errors');

function extractTagValue(source, tagName) {
  const match = String(source || '').match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match?.[1] ? match[1].trim() : '';
}

function sanitizeRncForDgii(value) {
  return String(value || '').replace(/\D/g, '');
}

function sanitizeEncfForDgii(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

function generarNombreArchivoDGII(rnc, encf) {
  const safeRnc = sanitizeRncForDgii(rnc);
  const safeEncf = sanitizeEncfForDgii(encf);

  assertCondition(safeRnc, 'Error: nombre del archivo incompatible con DGII', { statusCode: 422 });
  assertCondition(safeEncf, 'Error: nombre del archivo incompatible con DGII', { statusCode: 422 });

  return `${safeRnc}${safeEncf}.xml`;
}

function validarNombreArchivoDGII(fileName, { rnc, encf } = {}) {
  const normalized = String(fileName || '').trim();
  const expected = generarNombreArchivoDGII(rnc, encf);

  const isValid = Boolean(normalized)
    && normalized === expected
    && /\.xml$/i.test(normalized)
    && !/\s/.test(normalized)
    && !/[^A-Za-z0-9.]/.test(normalized)
    && normalized.length === expected.length;

  if (!isValid) {
    throw new EcfError('Error: nombre del archivo incompatible con DGII', {
      statusCode: 422,
      details: {
        fileName: normalized,
        expected,
        rnc: sanitizeRncForDgii(rnc),
        encf: sanitizeEncfForDgii(encf),
      },
    });
  }

  return expected;
}

function extractDgiiIdentityFromXml(xmlContent) {
  const xml = String(xmlContent || '');
  const rncEmisor = sanitizeRncForDgii(extractTagValue(xml, 'RNCEmisor'));
  const encf = sanitizeEncfForDgii(extractTagValue(xml, 'eNCF') || extractTagValue(xml, 'encf'));

  assertCondition(rncEmisor, 'No se pudo extraer el RNCEmisor del XML para generar el nombre DGII.', {
    statusCode: 422,
  });
  assertCondition(encf, 'No se pudo extraer el eNCF del XML para generar el nombre DGII.', {
    statusCode: 422,
  });

  return { rncEmisor, encf };
}

function crearArchivoTemporalDGII({ xmlContent, dgiiFileName, baseDir = process.cwd() } = {}) {
  // Quitar BOM UTF-8 (EF BB BF) que DGII rechaza con código 1 "El formato del XML no es válido"
  const content = String(xmlContent || '').replace(/^﻿/, '');
  assertCondition(content.trim(), 'No hay XML para preparar el archivo temporal DGII.', { statusCode: 422 });

  const tempDir = path.join(path.resolve(baseDir), 'storage', 'ecf', 'tmp');
  fs.mkdirSync(tempDir, { recursive: true });

  const tempPath = path.join(tempDir, dgiiFileName);
  // Escribir con encoding 'utf8' sin BOM (Node.js 'utf8' nunca agrega BOM)
  fs.writeFileSync(tempPath, content, 'utf8');

  return {
    tempDir,
    tempPath,
    dgiiFileName,
  };
}

function eliminarArchivoTemporalDGII(tempPath) {
  if (!tempPath) return;
  try {
    fs.rmSync(tempPath, { force: true });
  } catch (_) {
    // No bloquear el flujo por limpieza.
  }
}

module.exports = {
  crearArchivoTemporalDGII,
  eliminarArchivoTemporalDGII,
  extractDgiiIdentityFromXml,
  generarNombreArchivoDGII,
  sanitizeEncfForDgii,
  sanitizeRncForDgii,
  validarNombreArchivoDGII,
};
