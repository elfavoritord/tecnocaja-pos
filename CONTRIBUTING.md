# Contribuir a Tecno Caja

Guía rápida para desarrollar sobre el proyecto.

## Requisitos

- **Node.js** 20 LTS (revisa `.nvmrc`)
- **npm** 10+
- **Windows 10/11** (principal plataforma soportada)
- **MariaDB** para desarrollo opcional. En producción viene empaquetada.

## Primer setup

```bash
git clone <tu-repo>
cd "sistema pos completo"
cp .env.example .env
# Edita .env: agrega tu TECNO_CAJA_SECURITY_PASSWORD y credenciales Firebase si las usas
npm install
```

## Correr en modo desarrollo

**Con Electron (recomendado, usa MariaDB embebida):**
```bash
npm run desktop
```

**Standalone (sin Electron, útil para debug rápido del backend):**
```bash
# Opción A: con SQLite (no requiere MariaDB externo)
# En .env: DB_CLIENT=sqlite
npm start

# Opción B: con MariaDB externo
# Arranca MariaDB a mano o como servicio, luego:
npm start
```

## Comandos útiles

| Comando | Qué hace |
|---------|----------|
| `npm run desktop` | Lanza Electron + MariaDB embebida + BrowserWindow |
| `npm start` | Solo el backend Express en http://localhost:3000 |
| `npm run db:init` | Inicializa BD SQLite vacía |
| `npm run db:init:mysql` | Inicializa BD MariaDB vacía |
| `npm run db:migrate:mysql` | Migra datos de SQLite a MariaDB |
| `npm run lint` | ESLint sobre todo el código |
| `npm run lint:fix` | ESLint + autofix |
| `npm run format` | Prettier sobre todo |
| `npm test` | Jest (tests unitarios) |
| `npm run test:watch` | Jest en modo watch |
| `npm run test:coverage` | Jest con reporte de cobertura |
| `npm run build:desktop` | Genera instalador Windows (NSIS) |

## Estilo de código

- **Prettier** formatea; no discutas estilo.
- **ESLint** señala errores; corrige o ignora con comentario justificado.
- Strings: comillas simples `'...'`. Template literals para interpolación.
- Async/await preferido sobre callbacks y `.then()` encadenados.
- Nombres en español para dominio de negocio (`ventas`, `caja`, `ncf`).
- Nombres en inglés para código de plomería (`router`, `middleware`, `service`).

## Convención de commits

Formato: `tipo(scope): mensaje corto en español`.

Tipos: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `security`, `perf`, `style`.

Ejemplos:
```
feat(ventas): permitir anular venta con PIN supervisor
fix(caja): corregir cálculo de saldo cuando hay movimientos negativos
refactor(auth): extraer login a server/routes/auth.routes.js
security(cors): restringir allowlist a localhost por defecto
docs: actualizar ARCHITECTURE.md con sección de sync
```

## Branching

- `main`: producción. Solo merges desde PRs.
- `develop`: integración.
- `feature/<descripcion>`: nuevas features.
- `fix/<descripcion>`: bugs.
- `refactor/<descripcion>`: refactors grandes.
- `security/<descripcion>`: parches de seguridad.

## Antes de hacer PR

```bash
npm run lint
npm run format
npm test
```

Los tres deben pasar sin errores.

## Estructura de archivos al crear un nuevo dominio

Si vas a añadir un nuevo módulo de negocio (ej. "lealtad"):

```
server/
  routes/lealtad.routes.js      # Factory con deps inyectadas
  services/lealtad.service.js   # Lógica de negocio
  repositories/lealtad.repo.js  # Queries SQL

tests/
  services/lealtad.service.test.js
  routes/lealtad.routes.test.js

js/
  lealtad.js                    # Frontend
```

Registra las rutas en `server.js`:

```js
const createLealtadRoutes = require('./server/routes/lealtad.routes');
app.use('/api/lealtad', createLealtadRoutes({ query, withTransaction }));
```

## Reglas no negociables

1. **Nunca commits `.env` ni JSON de service accounts.**
2. **Nunca queries SQL con concatenación de strings.** Siempre placeholders `?`.
3. **Nunca console.log de tokens, passwords, o PII en producción.**
4. **Nunca cambios al esquema SQL sin migration incremental en `scripts/`.**
5. **Nunca `app.use('*', ...)` sin revisar que no abra agujeros de auth.**

## Reportar bugs / pedir features

Issues en GitHub con el template correspondiente. Incluye:
- Versión de Tecno Caja
- SO y versión (Windows 10/11)
- Pasos para reproducir
- Logs relevantes de `tecnocaja-electron-startup.log`
