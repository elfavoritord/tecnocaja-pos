'use strict';

/**
 * Construcción de la URL de verificación DGII (QR), portada literal de
 * modules/ecf/utils/qr-url.util.js (Desktop, solo lectura de referencia).
 * Parsea el XML REALMENTE firmado y enviado, nunca datos reconstruidos
 * aparte -- así QR/XML/DGII siempre coinciden campo por campo.
 */

const { resolveEnvironmentConfig } = require('./config');

function xmlText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

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
    codigoSeguridad: isRfce ? codigoSeguridadRfce : sigVal.replace(/\s+/g, '').slice(0, 6),
  };
}

function buildQrVerificationUrl(signedXml, ambiente) {
  if (!signedXml) return '';
  const d = parseEcfXmlForQr(signedXml);
  if (!d.encf || !d.rncEmisor || !d.codigoSeguridad) return '';

  const { baseUrl, dgiiEnvKey } = resolveEnvironmentConfig(ambiente);
  const fechaFirma = d.fechaHoraFirma || d.fechaEmision || '';

  if (d.isRfce) {
    return `https://fc.dgii.gov.do/${dgiiEnvKey === 'ecf' ? 'eCF' : dgiiEnvKey === 'certecf' ? 'CerteCF' : 'TesteCF'}/ConsultaTimbreFC?` +
      `RncEmisor=${encodeURIComponent(d.rncEmisor)}` +
      `&ENCF=${encodeURIComponent(d.encf)}` +
      `&MontoTotal=${encodeURIComponent(d.montoTotal || '')}` +
      `&CodigoSeguridad=${encodeURIComponent(d.codigoSeguridad)}`;
  }

  const compradorParam = d.rncComprador
    ? `&RncComprador=${encodeURIComponent(d.rncComprador)}`
    : '';

  return `${baseUrl}/ConsultaTimbre?` +
    `RncEmisor=${encodeURIComponent(d.rncEmisor)}` +
    compradorParam +
    `&ENCF=${encodeURIComponent(d.encf)}` +
    `&FechaEmision=${encodeURIComponent(d.fechaEmision || '')}` +
    `&MontoTotal=${encodeURIComponent(d.montoTotal || '')}` +
    `&FechaFirma=${encodeURIComponent(fechaFirma)}` +
    `&CodigoSeguridad=${encodeURIComponent(d.codigoSeguridad)}`;
}

module.exports = { parseEcfXmlForQr, buildQrVerificationUrl };
