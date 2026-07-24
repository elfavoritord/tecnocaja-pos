'use strict';

const { resolveEnvironmentConfig } = require('../config/ecf.config');

function xmlText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

// Misma lógica que modules/ecf/controllers/repr-impresa.js (parseEcfXml) —
// solo los campos necesarios para construir la URL de verificación DGII.
// Si esta parte cambia, revisar también repr-impresa.js para no desincronizar
// la Representación Impresa y el QR del recibo de venta.
function parseEcfXmlForQr(xml) {
  const xmlSinDeclaracion = xml.trim().replace(/^<\?xml[^>]*\?>\s*/i, '');
  const isRfce = /^<RFCE[\s>]/i.test(xmlSinDeclaracion);
  const enc = (xml.match(/<Encabezado>([\s\S]*?)<\/Encabezado>/i) || [])[1] || '';
  const idDoc = (enc.match(/<IdDoc>([\s\S]*?)<\/IdDoc>/i) || [])[1] || '';
  const emisor = (enc.match(/<Emisor>([\s\S]*?)<\/Emisor>/i) || [])[1] || '';
  const comprador = (enc.match(/<Comprador>([\s\S]*?)<\/Comprador>/i) || [])[1] || '';
  const totales = (enc.match(/<Totales>([\s\S]*?)<\/Totales>/i) || [])[1] || '';

  const sigVal = ((xml.match(/<SignatureValue[^>]*>([^<]+)<\/SignatureValue>/i) || [])[1] || '').trim();
  const codigoSeguridadRfce = xmlText(enc, 'CodigoSeguridadeCF');

  return {
    isRfce,
    encf: xmlText(idDoc, 'eNCF'),
    fechaEmision: xmlText(emisor, 'FechaEmision'),
    fechaHoraFirma: xmlText(xml, 'FechaHoraFirma'),
    rncEmisor: xmlText(emisor, 'RNCEmisor'),
    rncComprador: xmlText(comprador, 'RNCComprador'),
    montoTotal: xmlText(totales, 'MontoTotal'),
    codigoSeguridad: isRfce ? codigoSeguridadRfce : sigVal.slice(0, 6),
  };
}

/**
 * Construye la URL pública de verificación (ConsultaTimbre / ConsultaTimbreFC)
 * a partir del XML REALMENTE firmado y enviado a DGII — nunca a partir de
 * datos reconstruidos aparte, para garantizar que QR/XML/DGII siempre
 * coincidan campo por campo (RncEmisor, RncComprador, ENCF, FechaEmision,
 * MontoTotal, FechaFirma, CodigoSeguridad).
 */
function buildQrVerificationUrl(signedXml, environment) {
  if (!signedXml) return '';
  const d = parseEcfXmlForQr(signedXml);
  if (!d.encf || !d.rncEmisor || !d.codigoSeguridad) return '';

  const { baseUrl } = resolveEnvironmentConfig(environment || 'certecf');
  const envSegment = baseUrl.split('/').pop();
  const fechaFirma = d.fechaHoraFirma || d.fechaEmision || '';

  if (d.isRfce) {
    return `https://fc.dgii.gov.do/${envSegment}/ConsultaTimbreFC?` +
      `RncEmisor=${encodeURIComponent(d.rncEmisor)}` +
      `&ENCF=${encodeURIComponent(d.encf)}` +
      `&MontoTotal=${encodeURIComponent(d.montoTotal || '')}` +
      `&CodigoSeguridad=${encodeURIComponent(d.codigoSeguridad)}`;
  }

  return `${baseUrl}/ConsultaTimbre?` +
    `RncEmisor=${encodeURIComponent(d.rncEmisor)}` +
    `&RncComprador=${encodeURIComponent(d.rncComprador || '')}` +
    `&ENCF=${encodeURIComponent(d.encf)}` +
    `&FechaEmision=${encodeURIComponent(d.fechaEmision || '')}` +
    `&MontoTotal=${encodeURIComponent(d.montoTotal || '')}` +
    `&FechaFirma=${fechaFirma.replace(/ /g, '+')}` +
    `&CodigoSeguridad=${encodeURIComponent(d.codigoSeguridad)}`;
}

module.exports = { parseEcfXmlForQr, buildQrVerificationUrl };
