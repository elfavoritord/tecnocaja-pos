'use strict';

const crypto = require('crypto');

/**
 * Middleware Express para proteger las rutas públicas DGII/e-CF.
 *
 * Acepta el token en:
 *   - Authorization: Bearer <token>
 *   - x-internal-token: <token>
 *
 * Activación controlada por:
 *   - DGII_REQUIRE_INTERNAL_TOKEN=true  → activa la protección
 *   - DGII_INTERNAL_TOKEN=<token>       → token en texto plano
 *   - DGII_INTERNAL_TOKEN_HASH=<sha256> → alternativa con hash pre-calculado
 *
 * Si DGII_REQUIRE_INTERNAL_TOKEN no es "true", el middleware pasa sin validar.
 */

function sha256hex(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex');
}

function safeEqual(a, b) {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return (req.headers['x-internal-token'] || '').trim() || null;
}

function getExpectedHash() {
  const explicitHash = String(process.env.DGII_INTERNAL_TOKEN_HASH || '').trim().toLowerCase();
  if (explicitHash) return explicitHash;
  const plainToken = String(process.env.DGII_INTERNAL_TOKEN || '').trim();
  if (plainToken) return sha256hex(plainToken);
  return null;
}

function dgiiInternalAuth(req, res, next) {
  const requireToken = String(process.env.DGII_REQUIRE_INTERNAL_TOKEN || '').toLowerCase() === 'true';

  if (!requireToken) return next();

  const expectedHash = getExpectedHash();
  if (!expectedHash) {
    return res.status(503).json({
      error: 'Token DGII requerido pero no configurado en el servidor.',
      code: 'TC-DGII-CONFIG-ERROR',
      codigo: 'TC-DGII-CONFIG-ERROR'
    });
  }

  const provided = extractToken(req);
  if (!provided) {
    return res.status(401).json({
      error: 'Falta el token de autorización. Usa Authorization: Bearer <token> o x-internal-token: <token>.',
      code: 'TC-DGII-4001',
      codigo: 'TC-DGII-4001'
    });
  }

  const providedHash = sha256hex(provided);
  if (!safeEqual(providedHash, expectedHash)) {
    return res.status(401).json({
      error: 'Token de autorización inválido.',
      code: 'TC-DGII-4001',
      codigo: 'TC-DGII-4001'
    });
  }

  next();
}

module.exports = { dgiiInternalAuth };
