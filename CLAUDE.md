# CLAUDE.md — Contexto para asistentes de código

Este archivo ayuda a asistentes de IA (Claude, Copilot, otros) a entender el proyecto rápido y no tomar decisiones que rompan el sistema.

## TL;DR

**Tecno Caja** es un sistema punto de venta estilo Eleventa, empaquetado como app de escritorio Windows (Electron + Express + MariaDB embebida). El dueño es **Emilio**. El modelo comercial es **híbrido on-premise + nube opcional**. Target: colmados, tiendas, farmacias en República Dominicana.

> Marca única: **Tecno Caja** — ya no existe ninguna referencia a "NovaPOS" en el código fuente. Todas las variables de entorno usan el prefijo `TECNO_CAJA_`.

## Cómo correr

```bash
npm install
npm run desktop   # ← esta es la forma correcta (Electron + MariaDB empaquetada)
```

`npm start` solo corre el backend, requiere MariaDB externo o `DB_CLIENT=sqlite` en `.env`.

## Arquitectura en una línea

Electron lanza `mariadbd.exe` empaquetado, luego arranca `server.js` (Express) en `127.0.0.1:3399`, luego abre un `BrowserWindow` apuntando ahí. UI en HTML/JS vanilla bajo `/js` y `/css`. Socket.IO para tiempo real.

Diagrama completo: `docs/ARCHITECTURE.md`.

## Estructura clave

- `server.js` — **Monolito de ~10k líneas en proceso de refactor**. No añadir más código aquí; extraer a `server/routes/<dominio>.routes.js`.
- `server/config/cors.js` — Política CORS (allowlist localhost + LAN opcional).
- `server/config/security.js` — Helmet + rate limiter + bind host.
- `server/security/backup-crypto.js` — AES-256-GCM para respaldos `.novaseguro` (extensión legacy, no renombrar).
- `server/middleware/dgii-auth.js` — Middleware de token interno para rutas DGII/e-CF (`DGII_REQUIRE_INTERNAL_TOKEN`).
- `server/routes/dgiiRoutes.js` — Rutas públicas DGII (`/fe/recepcion`, `/fe/aprobacioncomercial`, `/fe/autenticacion`).
- `server/cache/products-cache.js` — Cache LRU de productos.
- `db/schema.sql` — Esquema MariaDB completo con seeds.
- `db.js` — Abstracción dual MariaDB/SQLite.
- `electron/main.js` — Main process.
- `js/` — Renderer vanilla (no React, no Vue aún).
- `modules/firebase-admin.js` — Firebase opcional.
- `reporte app/` — Subproyecto Flutter independiente. **NO tocar desde aquí.**

## Convenciones que NO debes romper

1. **Nunca hardcodear secretos.** Todo va por env var. Ver `.env.example`.
2. **Nunca queries con concatenación de strings.** Usar placeholders `?` con `mysql2`.
3. **CORS por defecto solo localhost.** No añadir `origin: '*'` nunca.
4. **Bind default `127.0.0.1`.** Cambiar solo gated por `POS_ALLOW_LAN=true`.
5. **El password maestro legado `'Seguridad2026'` se mantiene SOLO como fallback de lectura** en `server/security/backup-crypto.js`. Nunca usar como default activo.
6. **Español** para dominio de negocio (`ventas`, `caja`, `ncf`). **Inglés** para plomería (`router`, `middleware`).
7. **Factory con inyección de dependencias** para nuevos módulos de rutas — ver patrón en `docs/ARCHITECTURE.md`.

## Fase actual: Fase 1 — Modularización

Extraídos hasta ahora del monolito:
- ✅ CORS → `server/config/cors.js`
- ✅ Helmet + rate limiter → `server/config/security.js`
- ✅ Backup crypto → `server/security/backup-crypto.js`

Pendientes de extraer (prioridad en este orden):
1. `auth` (login, logout, google, offline-login) → `server/routes/auth.routes.js`
2. `ventas` → `server/routes/ventas.routes.js`
3. `productos`
4. `clientes`
5. `caja`
6. `inventario`
7. `reportes`
8. `config`
9. `licencia`
10. `respaldos`

**Regla clave**: cuando extraigas, usa la **factory pattern con deps inyectadas**. No hagas imports circulares ni globals compartidos.

## Tests

```bash
npm test
```

Framework: Jest. Tests viven en `tests/`. Un test por módulo extraído.

## Lint y format

```bash
npm run lint
npm run format
```

ESLint + Prettier. Config en `.eslintrc.json` y `.prettierrc.json`.

## Lo que NO debes hacer

- **NO reescribas el frontend en React/Vue.** Se migrará gradual, no de golpe.
- **NO migres a TypeScript ahora.** Se evalúa después de Fase 3.
- **NO agregues microservicios.** Monolito modular es la decisión hasta >1000 clientes.
- **NO toques `reporte app/`**; es un subproyecto Flutter con su propio ciclo.
- **NO modifiques `dist/` ni `build/mariadb-runtime/`**; se regeneran con `build:desktop`.
- **NO hagas `npm audit fix --force`**; rompe electron/puppeteer.

## Contexto de negocio

- **Mercado**: RD primero, luego Centroamérica.
- **Precio objetivo (tentativo)**:
  - Standalone: USD $149 one-time
  - Plus (sync nube + app móvil): USD $19/mes
  - Enterprise (DGII e-CF + soporte telefónico): USD $99/mes
- **Cumplimiento fiscal**: NCF y eventualmente e-CF DGII.
- **Hardware típico**: impresora térmica ESC/POS, gaveta conectada a impresora, lector de código USB (HID).

## Cloudflare Tunnel (acceso DGII/e-CF)

El backend corre en `127.0.0.1:3399`. Para exponer las rutas `/fe/*` a internet sin abrir puertos:

```powershell
# Quick Tunnel (URL temporal para pruebas)
.\scripts\start-with-tunnel.ps1

# Túnel permanente (con nombre fijo)
.\scripts\start-with-tunnel.ps1 -Tunnel tecnocaja-pos
```

Variables clave en `.env`:
- `POS_BIND_HOST=127.0.0.1` — NO cambiar aunque uses el túnel.
- `DGII_REQUIRE_INTERNAL_TOKEN=true` — protege `/fe/*` con token.
- `DGII_INTERNAL_TOKEN=<token>` — token secreto, rotar si se filtra.

## Documentos de referencia

- `NovaPOS-Plan-Evolucion.md` — Diagnóstico + roadmap 6 fases (nombre de archivo histórico, no renombrar).
- `docs/ARCHITECTURE.md` — Arquitectura detallada.
- `CONTRIBUTING.md` — Guía de desarrollo.
- `.env.example` — Todas las variables de entorno documentadas.

## Comunicación con Emilio

Emilio desarrolla **solo, tiempo completo**. Prefiere:
- Explicaciones claras en español.
- Acciones completas antes que muchas preguntas.
- Propuestas concretas con diffs, no abstracciones.
- Que se mantenga la app funcionando en cada paso — no hacer cambios grandes sin backup.
