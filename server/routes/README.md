# `server/routes/`

Rutas Express organizadas por dominio.

Patrón de extracción: **factory con dependencias inyectadas**.

```js
// server/routes/auth.routes.js (ejemplo)
const express = require('express');

module.exports = function createAuthRoutes(deps) {
  const { query, getDbSession, createAuthSession, loginLimiter } = deps;
  const router = express.Router();

  router.post('/login', loginLimiter, async (req, res) => {
    // ...
  });

  return router;
};
```

Y en `server.js`:
```js
const createAuthRoutes = require('./server/routes/auth.routes');
app.use('/api', createAuthRoutes({ query, getDbSession, ... }));
```

Esto evita dependencias circulares y permite mockear en tests.

Dominios planificados:
- `auth.routes.js` (login, logout, google, offline-login) — Fase 1
- `ventas.routes.js` — Fase 1
- `productos.routes.js` — Fase 1
- `clientes.routes.js` — Fase 1
- `caja.routes.js` — Fase 1
- `inventario.routes.js` — Fase 1
- `reportes.routes.js` — Fase 1
- `config.routes.js` — Fase 1
- `licencia.routes.js` — Fase 1
- `respaldos.routes.js` — Fase 1
- `sync.routes.js` — Fase 3
