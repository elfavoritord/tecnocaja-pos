'use strict';

// Firma XMLDSig enveloped (C14N no exclusivo + RSA-SHA256) usando xml-crypto,
// una librería probada — la canonicalización propia que trae
// vendor/modules/ecf/signature/signature.service.js calcula un digest distinto
// al que produce un verificador estándar (confirmado con xml-crypto en local,
// coincide con el rechazo real de DGII: "La firma del XML no es válida").
//
// Reference URI="" (documento completo, sin atributo Id) porque así lo espera
// DGII — visto en los e-CF ya verificados por DGII (ecf/DGII_CARGAR_AHORA_4_XML_VERIFICADOS).

const { SignedXml } = require('xml-crypto');
const forge = require('node-forge');

function signXmlDocument(xml, certificateContext) {
  const { certificate, privateKey, certificatePem, certificateChainPem } = certificateContext;
  const privateKeyPem = forge.pki.privateKeyToPem(privateKey);
  // DGII rechazó el ARECF con "Error de Firma Digital" incluso con una firma
  // matemáticamente válida (verificado con xml-crypto Y con el validador
  // independiente de Java/JSR-105, ambos dan válido) — el .p12 trae la cadena
  // completa (hoja + intermedia VIAFIRMA + raíz) pero solo se firmaba con la
  // hoja, así que el KeyInfo del ARECF nunca traía la CA intermedia. Sin ella,
  // un verificador que no hace su propio AIA chasing no puede construir la
  // cadena de confianza y reporta la firma como inválida. xml-crypto emite un
  // <X509Certificate> por cada bloque PEM encontrado en `publicCert`, así que
  // basta con pasarle la cadena completa concatenada.
  const certPem = certificateChainPem || certificatePem || forge.pki.certificateToPem(certificate);

  const sig = new SignedXml({
    privateKey: privateKeyPem,
    publicCert: certPem,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  });
  sig.addReference({
    xpath: '/*',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature'],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    uri: '',
    isEmptyUri: true,
  });
  sig.computeSignature(String(xml).replace(/^﻿/, '').replace(/^\s*<\?xml[\s\S]*?\?>\s*/i, ''));
  return `<?xml version="1.0" encoding="UTF-8"?>\n${sig.getSignedXml()}`;
}

module.exports = { signXmlDocument };
