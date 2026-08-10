'use strict';

// Carga perezosa del certificado .p12 (montado como secret file por Cloud Run)
// usando la misma lógica que ya usa el POS local (vendor/modules/ecf/signature).
// Si no hay certificado configurado, el Gateway sigue funcionando pero responde
// el ARECF sin firmar (se loguea una sola advertencia) — no debe tumbar el servicio.

const { loadCertificate } = require('../vendor/modules/ecf/signature/signature.service');

let cached = null;
let warned = false;

function getCertificateContext() {
  if (cached) return cached;

  const certPath = String(process.env.CERT_PATH || '').trim();
  const certPassword = String(process.env.CERT_PASSWORD || '').trim();

  if (!certPath) {
    if (!warned) {
      console.warn('[GATEWAY] CERT_PATH no configurado — el ARECF se enviará SIN firmar.');
      warned = true;
    }
    return null;
  }

  try {
    cached = loadCertificate({ certPath, certPassword });
    console.log(`[GATEWAY] Certificado cargado: ${cached.subject} (vence ${cached.validTo})`);
    return cached;
  } catch (err) {
    if (!warned) {
      console.error(`[GATEWAY] No se pudo cargar el certificado: ${err.message}`);
      warned = true;
    }
    return null;
  }
}

module.exports = { getCertificateContext };
