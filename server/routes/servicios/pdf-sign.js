'use strict';

/**
 * pdf-sign.js — Firma digital (PAdES) de los PDF de cotización / factura del
 * modo Empresa de Servicios, usando el certificado .p12 del emisor.
 *
 * NO tiene nada que ver con DGII / e-CF: solo firma el PDF para que el cliente
 * lo reciba "Firmado digitalmente por <Razón social>".
 *
 * El bloque VISIBLE de "FIRMADO DIGITALMENTE" lo dibuja renderDoc.js dentro del
 * HTML (donde va "Firma y sello"); aquí solo se agrega la firma criptográfica.
 */

const { PDFDocument } = require('pdf-lib');
const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib');
const { P12Signer } = require('@signpdf/signer-p12');
const signpdf = require('@signpdf/signpdf').default;

// Bytes reservados para el contenedor CMS de la firma. 16 KB sobra para una
// cadena hoja + intermedia + raíz con SHA-256.
const SIGNATURE_LENGTH = 16384;

// Los campos de metadatos de la firma son strings PDF; limpia lo que podría
// romper el guardado (control chars, caracteres fuera de Latin-1).
function pdfStr(value, max = 120) {
  return String(value == null ? '' : value)
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '')
    .trim()
    .slice(0, max);
}

/**
 * @param {Buffer} pdfBuffer  PDF sin firmar (p. ej. salida de printToPDF)
 * @param {object} opts
 * @param {Buffer} opts.p12Buffer      contenido del .p12
 * @param {string} opts.passphrase     contraseña del .p12 (ya descifrada)
 * @param {string} opts.signerName     razón social del emisor (campo Name de la firma)
 * @param {string} [opts.signerRnc]    RNC del emisor (solo dígitos)
 * @param {string} [opts.reason]
 * @param {string} [opts.location]
 * @param {string} [opts.contactInfo]
 * @returns {Promise<Buffer>} PDF firmado
 */
async function signServiceDocumentPdf(pdfBuffer, opts = {}) {
  const {
    p12Buffer,
    passphrase = '',
    signerName = 'Emisor',
    signerRnc = '',
    reason,
    location = 'República Dominicana',
    contactInfo = '',
  } = opts;

  if (!Buffer.isBuffer(pdfBuffer) || !pdfBuffer.length) throw new Error('PDF vacío.');
  if (!Buffer.isBuffer(p12Buffer) || !p12Buffer.length) throw new Error('Certificado .p12 vacío.');

  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true, updateMetadata: false });

  // Campo de firma invisible + placeholder para el CMS. El bloque visible ya
  // viene en el HTML del documento.
  pdflibAddPlaceholder({
    pdfDoc,
    reason: pdfStr(reason || `Documento emitido por ${signerName}${signerRnc ? ' (RNC ' + signerRnc + ')' : ''}`),
    contactInfo: pdfStr(contactInfo),
    name: pdfStr(signerName),
    location: pdfStr(location),
    signatureLength: SIGNATURE_LENGTH,
  });

  const withPlaceholder = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
  const signer = new P12Signer(p12Buffer, { passphrase: String(passphrase || '') });
  return signpdf.sign(withPlaceholder, signer);
}

module.exports = { signServiceDocumentPdf, SIGNATURE_LENGTH };
