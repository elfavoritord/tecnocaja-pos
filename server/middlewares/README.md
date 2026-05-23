# `server/middlewares/`

Middlewares de Express extraídos del monolito.

Pendiente de extraer desde `server.js` (Fase 1):
- Autenticación por token de sesión (`req.authUser`, `req.authToken`).
- `requireAuth(req, res, next)`.
- `requirePermission('permiso.atomico')` (pendiente para Fase 2).
- `requireRole(['owner', 'admin'])`.

Cada middleware debe ser export directo: `module.exports = function mwName(req, res, next) {...}`.
