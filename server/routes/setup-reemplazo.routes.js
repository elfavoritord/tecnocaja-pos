'use strict';

/**
 * setup-reemplazo.routes.js — Permiso para reemplazar el negocio desde la
 * pantalla de inicio ("Reinstalar una app existente").
 *
 *   POST /api/setup/autorizar-reemplazo
 *     { claveSeguridad }            → clave de seguridad de esta instalación, o
 *     { usuario, password }         → un administrador general de este negocio
 *   ← { ok, token, expiraEnMinutos }
 *
 * Es pública (en la pantalla de inicio no hay sesión) y pasa por el limitador
 * de intentos del login. El token que devuelve habilita, por 20 minutos, las
 * rutas de setup que reemplazan el negocio: restaurar un respaldo encima o
 * terminar el asistente de un negocio nuevo. Ver server/security/autorizacion-reemplazo.js.
 */

const { emitirAutorizacionReemplazo, DURACION_MS } = require('../security/autorizacion-reemplazo');

function createSetupReemplazoRouter({
  app,
  query,
  loginLimiter,
  getSecurityPassword,
  ensureUserExtensions,
  userPasswordMatches,
  isGlobalAdministratorUser,
  writeAuditLog
}) {
  const limitar = loginLimiter || ((_req, _res, next) => next());

  app.post('/api/setup/autorizar-reemplazo', limitar, async (req, res) => {
    try {
      const { claveSeguridad, usuario, password } = req.body || {};
      let autorizadoPor;

      if (claveSeguridad) {
        const guardada = await getSecurityPassword();
        if (String(claveSeguridad) !== String(guardada)) {
          return res.status(403).json({ ok: false, error: 'La clave de seguridad no es correcta.' });
        }
        autorizadoPor = { userName: 'Clave de seguridad', userRole: 'Sistema' };
      } else if (usuario && password) {
        await ensureUserExtensions();
        const rows = await query(
          `SELECT u.*, r.codigo AS role_code
           FROM users u
           LEFT JOIN roles r ON r.id = u.role_id
           WHERE u.usuario = ? AND u.estado = "Activo"
           LIMIT 1`,
          [String(usuario).trim()]
        );
        const user = rows[0];
        if (!user || !userPasswordMatches(user, password)) {
          return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos.' });
        }
        if (!isGlobalAdministratorUser(user)) {
          return res.status(403).json({ ok: false, error: 'Solo un administrador general puede reemplazar el negocio.' });
        }
        autorizadoPor = { userId: user.id, userName: user.nombre || user.usuario, userRole: 'Administrador general' };
      } else {
        return res.status(400).json({ ok: false, error: 'Escribe la clave de seguridad o el usuario y la contraseña de un administrador.' });
      }

      await writeAuditLog({
        ...autorizadoPor,
        moduleName: 'Respaldos',
        actionName: 'Autorización para reemplazar el negocio',
        detail: 'Desde la pantalla de inicio (Reinstalar una app existente).'
      }).catch(() => {});

      res.json({
        ok: true,
        token: emitirAutorizacionReemplazo(),
        expiraEnMinutos: Math.round(DURACION_MS / 60000)
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });
}

module.exports = createSetupReemplazoRouter;
