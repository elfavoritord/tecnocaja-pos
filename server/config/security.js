/**
 * server/config/security.js
 *
 * Middlewares de seguridad HTTP: helmet + rate limiting.
 *
 * `require` opcional: si helmet o express-rate-limit no están instalados,
 * exporta no-ops para que el arranque no falle. Esto permite que instalaciones
 * viejas sigan arrancando hasta que el usuario corra `npm install`.
 *
 * Uso:
 *   const { helmetMiddleware, loginLimiter, bindHost } = require('./server/config/security');
 *   if (helmetMiddleware) app.use(helmetMiddleware);
 *   app.post('/api/login', loginLimiter, loginHandler);
 *   httpServer.listen(port, bindHost, ...);
 */

'use strict';

// ----- Helmet -----
let helmet = null;
try {
  helmet = require('helmet');
} catch (_) {
  console.warn('[security] helmet no instalado — ejecuta: npm install');
}

const helmetMiddleware = helmet
  ? helmet({
      // Desactivar CSP estricta: la app local carga inline scripts en index.html.
      // Se reactivará cuando migremos a bundler (Fase 1+).
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' }
    })
  : null;

// ----- Rate limiter para login -----
let rateLimit = null;
try {
  rateLimit = require('express-rate-limit');
} catch (_) {
  // Advertencia ya emitida arriba si helmet también falta
}

const loginLimiter = rateLimit
  ? rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutos
      max: 10, // máximo 10 intentos por IP en esa ventana
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Demasiados intentos. Espera 15 minutos e intenta de nuevo.' }
    })
  : (_req, _res, next) => next();

// ----- Host de binding -----
// Por defecto solo localhost (seguro). Cambia POS_ALLOW_LAN=true o POS_BIND_HOST=0.0.0.0
// para exponer a la red local (mobile POS).
const bindHost = process.env.POS_BIND_HOST
  || (String(process.env.POS_ALLOW_LAN || '').toLowerCase() === 'true' ? '0.0.0.0' : '127.0.0.1');

module.exports = {
  helmetMiddleware,
  loginLimiter,
  bindHost
};
