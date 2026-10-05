'use strict';

/**
 * Sesión para /api/offline/* (contingencia de una caja terminal).
 *
 * El router offline se monta ANTES del middleware global de sesión de
 * server.js, así que req.authUser nunca llegaba y save-sale / product-save
 * respondían siempre 401 "Sesión no válida": la caja no podía vender en
 * contingencia aunque el cajero ya hubiera entrado.
 *
 * Primero se usa el caché de sesiones en memoria (lo llena el middleware
 * global en cada petición con la base arriba, y /api/auth/offline-login):
 * no toca la base, que en contingencia está caída. Solo si el token no está
 * en caché se consulta la base (puede estar arriba aunque la pantalla crea
 * lo contrario); si falla, la petición sigue sin usuario y la ruta decide.
 */
function createOfflineSessionMiddleware({
  readAuthToken,
  sessionCache,
  getDbSession,
  getUserById,
  getSessionTtlMs,
  now = () => Date.now(),
}) {
  return async function offlineSession(req, _res, next) {
    try {
      if (req.authUser) return next();
      const token = readAuthToken(req);
      if (!token) return next();

      const cached = sessionCache.get(token);
      if (cached && cached.expiresAt > now()) {
        req.authToken = token;
        req.authUser = cached.user;
        return next();
      }

      const sessionRow = await getDbSession(token);
      if (sessionRow) {
        const user = await getUserById(sessionRow.user_id);
        if (user && String(user.estado || '').trim().toLowerCase() === 'activo') {
          sessionCache.set(token, { user, expiresAt: now() + getSessionTtlMs() });
          req.authToken = token;
          req.authUser = user;
        }
      }
    } catch (_) {
      // Base caída y token fuera del caché: sigue sin usuario (401 en la ruta).
    }
    return next();
  };
}

module.exports = { createOfflineSessionMiddleware };
