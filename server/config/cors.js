/**
 * server/config/cors.js
 *
 * Configuración de CORS para Tecno Caja.
 *
 * - Por defecto solo acepta peticiones desde localhost/127.0.0.1 (Electron).
 * - `CORS_ALLOWED_ORIGINS` (env): lista separada por coma para dominios extra.
 * - `POS_ALLOW_LAN=true` (env): permite orígenes de rangos RFC1918 (LAN privada).
 *
 * Uso:
 *   const { corsOptions } = require('./server/config/cors');
 *   app.use(cors(corsOptions));
 *   io = new Server(httpServer, { cors: corsOptions });
 */

'use strict';

const DEFAULT_LOCAL_ORIGINS = [
  'http://localhost',
  'http://127.0.0.1',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3399',
  'http://127.0.0.1:3399',
  
];

const EXTRA_ALLOWED_ORIGINS = String(process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = [...new Set([...DEFAULT_LOCAL_ORIGINS, ...EXTRA_ALLOWED_ORIGINS])];

const ALLOW_LAN = String(process.env.POS_ALLOW_LAN || '').toLowerCase() === 'true';

// Regex para detectar rangos LAN privados (RFC 1918).
const LAN_HOSTNAME_REGEX = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/;

function corsOriginCheck(origin, callback) {
  // Same-origin o clientes nativos (Electron/curl) no envían Origin.
  if (!origin) return callback(null, true);

  try {
    const url = new URL(origin);
    // Permitir cualquier localhost/127.0.0.1 con cualquier puerto.
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return callback(null, true);
    }
    // Permitir rangos LAN si está habilitado.
    if (ALLOW_LAN && LAN_HOSTNAME_REGEX.test(url.hostname)) {
      return callback(null, true);
    }
    // Allowlist explícita vía env.
    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
  } catch (_) {
    // fallthrough a rechazo
  }
  return callback(new Error(`Origin no permitido: ${origin}`));
}

const corsOptions = {
  origin: corsOriginCheck,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']
};

module.exports = {
  corsOptions,
  corsOriginCheck,
  ALLOWED_ORIGINS,
  ALLOW_LAN
};
