# Arquitectura de Tecno Caja

## Visión general

Tecno Caja es una aplicación de **escritorio** (Electron) con un **servidor HTTP local** (Express 5) que sirve la UI HTML y expone una API REST + Socket.IO para operaciones de negocio. La fuente de verdad es una **base de datos MariaDB embebida** que se empaqueta junto con el instalador.

```
┌────────────────────────────────────────────────────────────────┐
│  Electron (main process)                                       │
│  ├─ Lanza mariadbd.exe (runtime empaquetado)                   │
│  ├─ Arranca Node + Express (server.js) en 127.0.0.1:3399       │
│  └─ Abre BrowserWindow apuntando a http://127.0.0.1:3399       │
│                                                                │
│  BrowserWindow (renderer)                                      │
│  ├─ HTML/CSS/JS en /index.html, /js/*, /css/*                  │
│  ├─ Se comunica con el backend vía fetch + Socket.IO           │
│  └─ IPC al main process para hardware (impresora, gaveta)      │
└────────────────────────────────────────────────────────────────┘
```

## Estructura de carpetas

```
.
├── electron/               # Main process de Electron (ventana, IPC, hardware)
│   ├── main.js             # Entry point
│   ├── preload.js          # Puente contextBridge renderer↔main
│   ├── thermal-printer.js  # Impresión térmica ESC/POS
│   └── cash-drawer.js      # Apertura de gaveta de dinero
│
├── server/                 # Backend modularizado (en construcción — Fase 1)
│   ├── config/
│   │   ├── cors.js         # Allowlist CORS
│   │   └── security.js     # Helmet + rate limiter + bind host
│   ├── security/
│   │   └── backup-crypto.js  # AES-256-GCM para respaldos .novaseguro
│   ├── cache/
│   │   └── products-cache.js
│   ├── middlewares/        # [pendiente Fase 1]
│   ├── routes/             # [pendiente Fase 1]
│   ├── services/           # [pendiente Fase 1]
│   └── utils/              # [pendiente Fase 1]
│
├── modules/                # Integraciones externas
│   ├── firebase-admin.js   # Firebase Admin SDK (opcional)
│   ├── firebase-sync.js    # Sync de clientes a Firestore
│   ├── mobile-pos.js       # Sesiones móviles vía QR
│   └── plans.js            # Planes de licencia
│
├── js/                     # Frontend vanilla (renderer)
│   ├── app.js              # Orquestador principal
│   ├── api.js              # Cliente HTTP
│   ├── ventas.js           # Flujo punto de venta
│   ├── productos.js        # Gestión catálogo
│   ├── clientes.js         # CRM
│   ├── reportes.js         # Reportes básicos
│   ├── reportes-v2.js      # Reportes avanzados
│   ├── movimientos.js      # Caja / inventario
│   ├── proveedores.js      # Suplidores
│   ├── ncf-config.js       # Comprobantes fiscales DGII
│   └── ...
│
├── css/                    # Estilos
├── db/
│   └── schema.sql          # Esquema completo MariaDB + seeds
├── scripts/                # Inicialización, migraciones, build
├── config/
│   └── app.env             # Configuración local (creada en primer run)
├── build/                  # Recursos de empaquetado (icon, NSIS, MariaDB runtime)
├── tests/                  # Jest
├── docs/                   # Documentación técnica
│
├── server.js               # Monolito Express (~10k líneas, en refactor)
├── db.js                   # Abstracción BD (MariaDB o SQLite)
├── package.json
├── .env.example            # Plantilla de variables
└── .gitignore
```

## Flujo de arranque (Electron)

1. `electron/main.js` intenta `requestSingleInstanceLock()` para evitar duplicados.
2. Busca un puerto libre (default 3399, fallback 3000).
3. Lanza `mariadbd.exe` desde `build/mariadb-runtime/bin/` y espera que acepte conexiones.
4. `require('./server.js')` carga el backend y llama `startHttpServer(port, '127.0.0.1')`.
5. Abre `BrowserWindow` apuntando a `http://127.0.0.1:<puerto>`.
6. `preload.js` inyecta APIs seguras (hardware, ubicación de userData) al renderer vía `contextBridge`.

## Seguridad

### Principios
- **Localhost-first**: por defecto el server escucha solo en `127.0.0.1`.
- **LAN opt-in**: `POS_ALLOW_LAN=true` habilita bind `0.0.0.0` y CORS para rangos RFC1918.
- **Secretos fuera del repo**: `.env` y JSON de service accounts siempre en `.gitignore`.
- **Password maestro rotable**: `TECNO_CAJA_SECURITY_PASSWORD` env var o cambio desde el wizard.
- **Backups compatibles hacia atrás**: `decryptBackupPayload` intenta password activo y cae al legado.

### Variables de entorno críticas
Ver `.env.example` para la lista completa.

| Variable | Propósito | Default |
|----------|-----------|---------|
| `TECNO_CAJA_SECURITY_PASSWORD` | Password maestro para respaldos cifrados | (legado) |
| `POS_BIND_HOST` | Host donde escucha Express | `127.0.0.1` |
| `POS_ALLOW_LAN` | Si `true`, bind a `0.0.0.0` y permite LAN en CORS | `false` |
| `CORS_ALLOWED_ORIGINS` | Allowlist extra, separada por coma | (vacío) |
| `DB_CLIENT` | `mysql` (MariaDB) o `sqlite` | `mysql` |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Ruta absoluta al JSON (fuera del repo) | (vacío) |

## Base de datos

### Política
- **Producción**: MariaDB empaquetada (Electron bundle).
- **Desarrollo/demo**: SQLite vía `sql.js` cuando `DB_CLIENT=sqlite`.
- **Meta de Fase 5**: eliminar SQLite como fallback y quedarse solo con MariaDB.

### Esquema
Definido en `db/schema.sql`. Tablas principales:

| Tabla | Propósito |
|-------|-----------|
| `config` | Singleton con la configuración del negocio |
| `users` + `user_roles` | Autenticación y roles |
| `branches` | Sucursales |
| `cash_registers` + `cash_sessions` + `cash_movements` | Control de caja |
| `products` + `categories` + `product_variants` | Catálogo |
| `clients` + `suppliers` | CRM |
| `sales` + `sale_items` | Transacciones |
| `suspended_sales` + `quotations` | Ventas pendientes y cotizaciones |
| `inventory_movements` | Kardex |
| `audit_logs` | Auditoría |
| `ncf_configs` + `ncf_sequences` | Comprobantes fiscales DGII |
| `mobile_sessions` | POS móvil vía QR |
| `sesiones_activas` | Tokens de sesión (TTL 16h) |

## Comunicación real-time

Socket.IO expuesto por `server.js`. Eventos emitidos al renderer:
- `venta:creada`, `venta:anulada`
- `caja:abierta`, `caja:cerrada`
- `producto:stock-bajo`
- `licencia:cambio-estado`

El renderer se conecta en `http://127.0.0.1:<puerto>` con el mismo puerto que la API.

## Patrón de extracción (Fase 1 en curso)

Cuando saquemos dominios del monolito, usamos **factory con inyección de dependencias**:

```js
// server/routes/<dominio>.routes.js
module.exports = function createXxxRoutes(deps) {
  const { query, withTransaction, servicioX, loginLimiter } = deps;
  const router = require('express').Router();
  router.post('/', async (req, res) => { /* ... */ });
  return router;
};
```

En `server.js`:
```js
const createXxxRoutes = require('./server/routes/xxx.routes');
app.use('/api/xxx', createXxxRoutes({ query, withTransaction, ... }));
```

Esto evita imports circulares y facilita el testing con mocks.

## Testing

- **Unitarios**: Jest en `tests/`.
- **Integración** (planeado): `supertest` contra instancias de Express montadas en memoria.
- **E2E** (planeado Fase 5): Playwright contra la app Electron empaquetada.

## Roadmap resumido

Ver `Tecno Caja-Plan-Evolucion.md` en la raíz del proyecto.

- ✅ Fase 0 — Higiene de seguridad crítica
- 🔄 Fase 1 — Modularización del backend (en curso)
- ⏳ Fase 2 — Roles y permisos granulares
- ⏳ Fase 3 — Sync local ↔ nube
- ⏳ Fase 4 — App móvil Flutter integrada
- ⏳ Fase 5 — DGII e-CF + CI/CD
- ⏳ Fase 6 — Comercialización SaaS
