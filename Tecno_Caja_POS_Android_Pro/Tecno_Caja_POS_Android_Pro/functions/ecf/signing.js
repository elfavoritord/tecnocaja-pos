'use strict';

/**
 * Firma XMLDSig, portada literal de
 * modules/ecf/signature/signature.service.js:signXmlWithXmlCrypto (Desktop,
 * solo lectura de referencia) -- mismo algoritmo (rsa-sha256, canonicalización
 * xml-c14n-20010315, referencia enveloped sobre `/*`) para que DGII reciba
 * exactamente el mismo tipo de firma ya aceptado en Desktop.
 */

const { SignedXml } = require('xml-crypto');

function signXml(xmlContent, { certificatePem, privateKeyPem }) {
  if (!String(xmlContent || '').trim()) throw new Error('No hay XML para firmar.');
  if (!certificatePem || !privateKeyPem) {
    throw new Error('No hay certificado/clave privada disponible para firmar.');
  }

  let unsignedXml = String(xmlContent || '')
    .replace(/^\uFEFF/, '')
    .replace(/^\s*<\?xml[\s\S]*?\?>\s*/i, '');
  if (!/\bxsi:/i.test(unsignedXml)) {
    unsignedXml = unsignedXml.replace(
      /(<[A-Za-z_][\w:.-]*\b[^>]*?)\s+xmlns:xsi="http:\/\/www\.w3\.org\/2001\/XMLSchema-instance"/i,
      '$1'
    );
  }
  if (!/\bxsd:/i.test(unsignedXml)) {
    unsignedXml = unsignedXml.replace(
      /(<[A-Za-z_][\w:.-]*\b[^>]*?)\s+xmlns:xsd="http:\/\/www\.w3\.org\/2001\/XMLSchema"/i,
      '$1'
    );
  }

  const signer = new SignedXml({
    privateKey: privateKeyPem,
    publicCert: certificatePem,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  });
  signer.addReference({
    xpath: '/*',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature'],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    uri: '',
    isEmptyUri: true,
  });
  signer.computeSignature(unsignedXml);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${signer.getSignedXml()}`;
}

/** Primeros 6 caracteres de SignatureValue -- mismo cálculo que ecf.service.js (Desktop). */
function extractSecurityCode(signedXml) {
  const match = String(signedXml || '').match(/<SignatureValue[^>]*>([^<]+)<\/SignatureValue>/i);
  const value = (match ? match[1] : '').replace(/\s+/g, '');
  return value.slice(0, 6);
}

function verifySignature(signedXml) {
  const hasSignedInfo = /<SignedInfo[\s>]/.test(signedXml);
  const hasSignatureValue = /<SignatureValue[\s>]/.test(signedXml);
  const hasCertificate = /<X509Certificate[\s>]/.test(signedXml);
  const hasDigestValue = /<DigestValue[\s>]/.test(signedXml);
  let signatureValid = false;
  let validationError = null;

  if (hasSignedInfo && hasSignatureValue && hasCertificate) {
    try {
      const signatureXml = String(signedXml || '').match(/<Signature[\s\S]*<\/Signature>/)?.[0] || '';
      const certMatch = String(signedXml || '').match(/<X509Certificate[^>]*>([\s\S]*?)<\/X509Certificate>/i);
      const certificateB64 = (certMatch ? certMatch[1] : '').replace(/\s+/g, '');
      const publicCert = certificateB64
        ? `-----BEGIN CERTIFICATE-----\n${certificateB64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`
        : undefined;
      const verifier = new SignedXml({ publicCert });
      verifier.loadSignature(signatureXml);
      signatureValid = verifier.checkSignature(String(signedXml || '').replace(/^\uFEFF/, ''));
      if (!signatureValid) validationError = verifier.validationErrors || verifier.getValidationErrors?.() || null;
    } catch (error) {
      validationError = error.message;
    }
  }

  return {
    ok: hasSignedInfo && hasSignatureValue && hasCertificate && hasDigestValue && signatureValid,
    signatureValid,
    hasSignedInfo,
    hasSignatureValue,
    hasCertificate,
    hasDigestValue,
    validationError,
  };
}

module.exports = { signXml, extractSecurityCode, verifySignature };
