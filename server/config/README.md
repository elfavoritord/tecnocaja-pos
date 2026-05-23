# `server/config/`

Configuración centralizada del backend.

- `cors.js` — Allowlist CORS (localhost + allowlist por env + LAN opcional).
- `security.js` — Helmet + rate limiter para login.

Cada módulo exporta objetos listos para usarse como middleware de Express.
