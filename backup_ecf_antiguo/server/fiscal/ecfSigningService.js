'use strict';

const certSvc = require('./fiscalCertificateService');
const xmlSvc = require('./ecfXmlService');

async function signXmlWithBusinessCertificate(queryFn, businessId, xmlString) {
  if (!xmlString) throw new Error('No hay XML para firmar.');
  const settingsRows = await queryFn(
    'SELECT certificate_mode, qscd_provider FROM dgii_company_settings WHERE business_id = ? LIMIT 1',
    [businessId]
  ).catch(() => []);
  const certificateMode = String(settingsRows[0]?.certificate_mode || 'p12').trim().toLowerCase();
  if (certificateMode && certificateMode !== 'p12') {
    const provider = String(settingsRows[0]?.qscd_provider || '').trim();
    throw new Error(
      `TODO profesional: la firma en modo ${certificateMode.toUpperCase()}${provider ? ` (${provider})` : ''} requiere integracion real con el proveedor QSCD/cloud del contribuyente.`
    );
  }
  const { cert, privateKey, info } = await certSvc.getCertificateForSigning(queryFn, businessId);
  const signedXml = xmlSvc.signXml(xmlString, cert, privateKey);
  const signatureValue = xmlSvc.extractSignatureValue(signedXml);
  const securityCode = xmlSvc.generateSecurityCodeFromSignedXml(signedXml);

  return {
    signedXml,
    signatureValue,
    securityCode,
    certificateInfo: info
  };
}

module.exports = {
  signXmlWithBusinessCertificate
};
