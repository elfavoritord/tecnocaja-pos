'use strict';

const http = require('http');
const https = require('https');

function fetchHtml(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error('Tiempo de espera agotado consultando DGII.')));
    req.on('error', reject);
  });
}

// Consulta en vivo el portal público ConsultaTimbre/ConsultaTimbreFC de DGII (HTML, sin
// autenticación) para saber si su índice PÚBLICO de verificación ya tiene indexado un e-CF —
// esto es distinto de si DGII lo aceptó en la recepción (eso ya se sabe por dgii_response_json).
// Verificado en sesión de certificación: DGII puede aceptar un documento en la recepción
// (estado_dgii='aceptado' con "Aceptado" real en su respuesta) y aun así tardar días — o nunca
// llegar — en indexarlo en este servicio público. Por eso, antes de elegir qué comprobante subir
// como representante en el Paso 5 (donde DGII revisa "la correcta conformación del QR"), conviene
// comprobar cuál de los aceptados YA resuelve aquí, en vez de tomar el primero por eNCF a ciegas.
async function checkQrResolves(qrUrl) {
  if (!qrUrl) return { indexed: false, estado: null };
  try {
    const html = await fetchHtml(qrUrl);
    if (/no fue encontrada la factura/i.test(html)) {
      return { indexed: false, estado: null };
    }
    const match = html.match(/<th>\s*Estado\s*<\/th>\s*<td>\s*([^<]+?)\s*<\/td>/i);
    const estado = match ? match[1].trim() : null;
    return { indexed: Boolean(estado), estado };
  } catch (err) {
    return { indexed: false, estado: null, error: err.message };
  }
}

module.exports = { checkQrResolves };
