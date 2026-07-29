'use strict';

const fs = require('fs');
const path = require('path');
const { parseEcfXmlForQr, buildQrVerificationUrl } = require('./qr-url.util');

function diagnosticDir() {
  const dir = path.join(process.cwd(), 'storage', 'ecf', 'qr-diagnostics');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Extrae SignatureValue completo (no solo los 6 caracteres de CodigoSeguridad) para dejar
// evidencia auditable de que CodigoSeguridad viene exactamente de ahí y no de DigestValue,
// TrackId, o cualquier otra fuente.
function extractSignatureValue(xml) {
  const m = String(xml || '').match(/<SignatureValue[^>]*>([^<]+)<\/SignatureValue>/i);
  return m ? m[1].trim() : null;
}

/**
 * Registra, para un e-CF puntual, la evidencia completa de que el QR se construyó a partir
 * del XML firmado real — no de datos reconstruidos, cacheados o de una firma anterior.
 * Escribe un JSON por documento en storage/ecf/qr-diagnostics/, con los mismos campos que
 * un caso de soporte a DGII necesitaría para auditar una discrepancia ConsultaResultado vs
 * ConsultaTimbre (ver memory/project_certificacion_dgii_ecf.md — patrón ya confirmado en vivo
 * de que ambos sistemas de DGII pueden no coincidir para el mismo eNCF, sin que el XML/QR
 * tengan ningún error).
 *
 * No lanza si algo falla — es un registro de diagnóstico, nunca debe bloquear la generación
 * real del QR/PDF.
 */
function recordQrDiagnostic({
  tipoEcf,
  signedXml,
  environment,
  trackId = null,
  estadoConsultaResultado = null,
  codigoConsultaResultado = null,
  xmlEnviadoPath = null,
  pdfGeneradoPath = null,
} = {}) {
  try {
    if (!signedXml) return null;
    const parsed = parseEcfXmlForQr(signedXml);
    const urlQRGenerada = buildQrVerificationUrl(signedXml, environment);
    const signatureValueCompleto = extractSignatureValue(signedXml);
    const codigoSeguridadEsperado = parsed.isRfce ? null : String(signatureValueCompleto || '').slice(0, 6);

    const comparacion = {
      rncEmisorCoincide: Boolean(parsed.rncEmisor),
      rncCompradorCoincide: parsed.isRfce ? null : Boolean(parsed.rncComprador),
      encfCoincide: Boolean(parsed.encf),
      fechaEmisionCoincide: parsed.isRfce ? null : Boolean(parsed.fechaEmision),
      montoTotalCoincide: Boolean(parsed.montoTotal),
      fechaFirmaCoincide: parsed.isRfce ? null : Boolean(parsed.fechaHoraFirma || parsed.fechaEmision),
      // El único campo con una regla externa verificable: CodigoSeguridad DEBE ser los
      // primeros 6 caracteres crudos de SignatureValue (para e-CF normales; RFCE usa
      // CodigoSeguridadeCF del propio XML, ver parseEcfXmlForQr).
      codigoSeguridadCoincide: parsed.isRfce
        ? Boolean(parsed.codigoSeguridad)
        : parsed.codigoSeguridad === codigoSeguridadEsperado,
    };

    const record = {
      tipoECF: tipoEcf || parsed.encf?.slice(0, 3) || null,
      eNCF: parsed.encf,
      trackId,
      fechaEnvio: new Date().toISOString(),
      estadoConsultaResultado,
      codigoConsultaResultado,
      rncEmisorXML: parsed.rncEmisor,
      rncCompradorXML: parsed.rncComprador || null,
      fechaEmisionXML: parsed.fechaEmision || null,
      montoTotalXML: parsed.montoTotal,
      fechaFirmaXML: parsed.fechaHoraFirma || null,
      signatureValueCompleto,
      codigoSeguridadGenerado: parsed.codigoSeguridad,
      urlQRGenerada,
      xmlEnviadoPath,
      pdfGeneradoPath,
      comparacion,
    };

    const safeEncf = String(parsed.encf || 'sin-encf').replace(/[^A-Za-z0-9_-]/g, '');
    const filePath = path.join(diagnosticDir(), `${safeEncf}-${Date.now()}.json`);
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8');
    return { ...record, diagnosticPath: filePath };
  } catch (err) {
    // Diagnóstico best-effort: nunca debe romper el flujo real de generación de QR/PDF.
    console.warn('[ECF] recordQrDiagnostic falló (no bloquea):', err.message);
    return null;
  }
}

module.exports = { recordQrDiagnostic, extractSignatureValue };
