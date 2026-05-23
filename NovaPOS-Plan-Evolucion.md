# Tecno Caja — Diagnóstico y Plan de Evolución

**Autor:** Revisión técnica para Emilio
**Fecha:** 23 de abril, 2026
**Modelo objetivo:** Híbrido (on-premise + nube opcional)
**Equipo:** Solo tú, tiempo completo

---

## 1. Diagnóstico ejecutivo

Tecno Caja tiene una **base funcional sólida** y una **arquitectura razonable para un producto comercial** (Electron + Express + MariaDB empaquetada), pero arrastra **tres clases de problemas** que, si no se resuelven antes de vender licencias, te van a generar incidentes de seguridad, deuda técnica insostenible y fricción con los primeros clientes.

### Lo que está bien

- Stack correcto para el caso de uso: una app de escritorio que corre un servidor local es más ágil que una PWA y más compatible con hardware (impresoras, gavetas, lectores de código) que una SaaS pura.
- Esquema de BD amplio y con buena cobertura del dominio: NCF, multi-sucursal, multi-moneda, caja, suspendidas, cotizaciones, mobile sessions.
- Uso de `mysql2/promise` con prepared statements (bien hecho, sin SQL injection por concatenación).
- Compatibilidad dual SQLite/MySQL para modo demo/fallback es inteligente para onboarding.
- Ya hay integración parcial con Firebase, Socket.IO para real-time, y un proyecto Flutter complementario — el ecosistema está pensado desde el inicio.

### Lo que es crítico arreglar

| # | Problema | Impacto | Prioridad |
|---|----------|---------|-----------|
| 1 | `inversiones-martinez-14703-firebase-adminsdk-*.json` en el repo con `private_key` | Cualquiera que acceda al código tiene control total del proyecto Firebase | 🔴 Hoy |
| 2 | `.env` commiteado con ruta al JSON, UID de licencia y URL pública de Cloudflare | Mismo impacto que el anterior + identifica al cliente "Inversiones Martínez" | 🔴 Hoy |
| 3 | Password maestro `'Seguridad2026'` hardcodeado en `server.js` y `schema.sql` | Cualquier instalación de Tecno Caja tiene la misma clave maestra → bypass trivial | 🔴 Hoy |
| 4 | `app.use(cors())` abierto + Socket.IO `origin:'*'` + listen en `0.0.0.0` | La API queda expuesta a toda la LAN sin restricción de origen | 🔴 Hoy |
| 5 | Token de sesión en `localStorage` | Vulnerable a XSS en el renderer de Electron | 🟠 Esta semana |
| 6 | `server.js` ~10.000 líneas en un solo archivo | Imposible de mantener, testear y dividir entre desarrolladores | 🟠 Este mes |
| 7 | No hay tests, ni linter, ni CI | Cualquier cambio puede romper producción sin que te enteres | 🟠 Este mes |
| 8 | SQLite y MariaDB conviviendo sin política clara | Duplica queries, genera bugs sutiles de tipos (boolean, fechas) | 🟡 Próximo trimestre |

---

## 2. Recomendación de arquitectura objetivo (Híbrido)

Dado que decidiste el modelo **on-premise + nube opcional**, esta es la arquitectura hacia la que debes evolucionar:

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLOUD (opcional)                             │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐         │
│  │  Tecno Caja API │   │  Dashboard   │   │  App Flutter │         │
│  │    (Node)    │◄─►│   web admin  │◄─►│  (reportes)  │         │
│  └──────┬───────┘   └──────────────┘   └──────────────┘         │
│         │                                                       │
│  ┌──────▼───────┐   ┌──────────────┐   ┌──────────────┐         │
│  │  PostgreSQL  │   │  Firebase    │   │   S3/R2      │         │
│  │ (multi-tenant│   │  Auth + FCM  │   │  (respaldos) │         │
│  │   por schema)│   │              │   │              │         │
│  └──────────────┘   └──────────────┘   └──────────────┘         │
└──────────────▲──────────────────────────────────────────────────┘
               │ Sync incremental (colas + reconciliación)
               │ HTTPS + JWT firmado + device fingerprint
┌──────────────┴──────────────────────────────────────────────────┐
│                    ON-PREMISE (PC del cliente)                  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Electron (UI + Hardware)                                │   │
│  │  ├─ Impresora térmica (escpos)                           │   │
│  │  ├─ Gaveta de dinero                                     │   │
│  │  ├─ Lector de código de barras (HID)                     │   │
│  │  └─ Báscula (serial/USB)                                 │   │
│  └──────────────────┬───────────────────────────────────────┘   │
│                     │ IPC / HTTP loopback                       │
│  ┌──────────────────▼───────────────────────────────────────┐   │
│  │  Backend Node local (Express)                            │   │
│  │  ├─ /api/ventas   /api/productos   /api/caja             │   │
│  │  ├─ /api/clientes /api/reportes    /api/config           │   │
│  │  └─ Sync worker (BullMQ in-memory) ────────► Cloud       │   │
│  └──────────────────┬───────────────────────────────────────┘   │
│                     │                                           │
│  ┌──────────────────▼───────────────────────────────────────┐   │
│  │  MariaDB local (fuente de verdad del día a día)          │   │
│  │  + Outbox table para sync diferido                       │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

**Principios clave:**

1. **El POS funciona 100% offline.** La nube es un "extra", no una dependencia crítica.
2. **La PC del cliente es la fuente de verdad** del día operativo. La nube recibe sincronización, no al revés.
3. **Sync eventual consistency** con tabla `outbox`: cada cambio local genera un evento que se sube cuando haya conexión.
4. **Multi-tenant en la nube por schema PostgreSQL** (no por row-level), porque cada negocio querrá exportar sus datos completos.
5. **Autenticación en dos capas**: local (PIN/usuario) + nube (Firebase Auth o tu propio JWT firmado con rotación de claves).

### ¿Por qué PostgreSQL en la nube si localmente es MariaDB?

Porque PostgreSQL tiene `CREATE SCHEMA` barato y aislamiento por tenant limpio, JSONB nativo (útil para configs variables por cliente), y extensiones como `pg_partman` para partitioning de ventas por fecha. MariaDB en la PC local está bien — no lo cambies.

---

## 3. Roadmap en 6 fases

Cada fase termina con un **entregable concreto y verificable**. Están pensadas para que avances solo, tiempo completo, con progreso visible cada 2-3 semanas.

### Fase 0 — Higiene de seguridad crítica (3-5 días) ✅ APLICADO HOY

**Objetivo:** Parar el sangrado. Revocar credenciales expuestas y cerrar los huecos obvios.

- ✅ `.gitignore` robusto creado
- ✅ `.env.example` saneado (sin secretos reales)
- ✅ CORS con allowlist y bind por defecto en `127.0.0.1`
- ✅ Password maestro configurable por `TECNO_CAJA_SECURITY_PASSWORD` con warning si se usa el legado
- ✅ `helmet` + `express-rate-limit` en login (require opcional, no rompe si no instalas)

**Lo que debes hacer tú HOY (no puedo hacerlo por ti):**

1. **Consola Firebase** → revocar la service account del proyecto `inversiones-martinez-14703` y generar una nueva. El JSON viejo en tu repo queda inutilizable.
2. **Cerrar el túnel Cloudflare** `why-worked-directories-poems.trycloudflare.com` si aún está activo.
3. **Limpiar historial git**:
   ```bash
   pip install git-filter-repo
   git filter-repo --path inversiones-martinez-14703-firebase-adminsdk-fbsvc-05f009344d.json --invert-paths
   git filter-repo --path .env --invert-paths
   git push --force origin --all
   ```
4. **Instalar dependencias nuevas**:
   ```bash
   npm install
   ```
5. **Cambiar la contraseña maestra** de tu instalación actual desde el wizard (o setear `TECNO_CAJA_SECURITY_PASSWORD` en tu `.env` local).
6. **Copiar tu `.env` actual** a un lugar seguro (1Password, Bitwarden) y borrarlo del repo tras confirmar que la app arranca con las variables vía env.

### Fase 1 — Modularización del backend (3-4 semanas)

**Objetivo:** Partir `server.js` (10k líneas) en dominios navegables.

**Estructura propuesta:**
```
server/
  app.js                 (Express setup: middlewares, error handler, server listen)
  routes/
    auth.routes.js       (login, logout, google, offline)
    ventas.routes.js
    productos.routes.js
    clientes.routes.js
    caja.routes.js
    inventario.routes.js
    reportes.routes.js
    config.routes.js
    licencia.routes.js
    respaldos.routes.js
  services/              (lógica de negocio, sin Express)
    auth.service.js
    ventas.service.js
    ...
  repositories/          (acceso a DB, una sola capa que toca queries)
    ventas.repo.js
    productos.repo.js
    ...
  middlewares/
    auth.middleware.js
    roles.middleware.js
    rate-limit.middleware.js
  utils/
    dates.js
    money.js
    ncf.js
  security/
    backup-crypto.js     (encrypt/decrypt con rotación)
    session.js
```

**Estrategia**: ir por dominio, no por capa. Extrae primero `auth` completo (rutas + servicio + repo), valida que todo sigue funcionando, haz commit, y sigues. No intentes mover todo de una vez.

**Entregable:** `server.js` reducido a <500 líneas (solo bootstrap). Cada módulo de dominio <800 líneas.

### Fase 2 — Roles, permisos y multi-sucursal bien hecho (2-3 semanas)

**Objetivo:** Un sistema de permisos granular que te permita vender a negocios con 5+ cajeros.

**Modelo:**
- Roles base: `owner`, `admin`, `gerente_sucursal`, `cajero`, `inventarista`, `auditor`
- Permisos atómicos: `ventas.crear`, `ventas.anular`, `productos.editar`, `caja.cerrar`, `reportes.ver_ganancia`, `config.editar`, etc.
- Asignación: rol → conjunto de permisos, usuario → rol en cada sucursal (puede tener roles distintos en cada una)
- Middleware `requirePermission('ventas.anular')` en cada ruta sensible
- UI: checkboxes por permiso al editar un rol

**Entregable:** Auditoría completa de rutas sensibles. Un cajero no puede abrir reportes de ganancia; solo owner puede rotar password maestro; anular venta requiere PIN supervisor.

### Fase 3 — Capa de sincronización local ↔ nube (4-5 semanas)

**Objetivo:** Que cada PC Tecno Caja se sincronice a un backend central opcional.

**Componentes:**
1. **Tabla `outbox`** en MariaDB local: cada INSERT/UPDATE/DELETE a tablas sincronizables emite un evento (`entity`, `entity_id`, `action`, `payload_json`, `created_at`, `synced_at`).
2. **Worker Node**: corre cada 30s, toma eventos pendientes, los sube a `POST /api/sync/events` en el backend central.
3. **Backend central** (nuevo microservicio): Express + PostgreSQL, recibe eventos, aplica idempotencia por `(tenant_id, client_device_id, event_id)`.
4. **Pull inverso** (catálogo de productos, precios): cada cliente puede pedir `GET /api/sync/updates?since=...` y aplicar cambios.
5. **Conflict resolution**: last-write-wins con timestamp del servidor, salvo en inventario (donde se reconcilia por delta, no por estado absoluto).

**Entregable:** Un dashboard web donde el dueño de un negocio con 3 sucursales ve las ventas consolidadas del día en tiempo cuasi-real.

### Fase 4 — App móvil Flutter integrada (3-4 semanas)

**Objetivo:** La app `reporte app/` que ya tienes, conectada al backend central para que el dueño vea reportes desde el teléfono.

- Autenticación Firebase Auth (ya está en el stack)
- Pantallas: ventas del día, cierre de caja, alertas de stock bajo, top productos
- Notificaciones push vía FCM cuando se cierra caja o hay venta anulada
- Modo solo lectura al inicio, luego features de control remoto (pausar venta, enviar anuncio a la PC)

**Entregable:** APK + iOS build conectados al backend central.

### Fase 5 — Facturación electrónica DGII y DevOps (4 semanas)

**Objetivo:** Cumplimiento fiscal RD completo + pipelines que te permitan liberar sin miedo.

- Integración con API de DGII (e-CF, certificados digitales)
- Firma XML con certificado del contribuyente
- Buzón de comprobantes fiscales (emitidos/recibidos)
- **CI/CD**: GitHub Actions con `lint → test → build → electron-builder`. Release automática del instalador firmado (necesitas un certificado code-signing EV; $300-500 al año pero indispensable para que Windows no marque tu `.exe` como sospechoso).
- **Tests**: mínimo 60 tests Jest cubriendo `ventas.service`, `caja.service`, `reportes.service`.
- **Sentry** para tracking de errores en producción.

**Entregable:** Poder decir "soy Tecno Caja con certificación DGII" y tener un proceso de release reproducible.

### Fase 6 — Comercialización y SaaS opcional (ongoing)

**Objetivo:** Convertir Tecno Caja en un producto vendible.

Ver sección 5 abajo.

---

## 4. Stack tecnológico recomendado

| Capa | Actual | Recomendación | Justificación |
|------|--------|---------------|---------------|
| Desktop shell | Electron | **Mantener Electron** | Estable, bien soportado, hardware-friendly |
| Backend local | Express 5 | **Mantener Express 5** | Familiar, suficiente |
| DB local | MariaDB + SQLite | **Solo MariaDB** (SQLite como modo demo opcional) | Reducir superficie de bugs |
| Frontend | HTML/JS modular | **Migrar gradual a Vue 3 o Svelte** | JS vanilla es viable pero Vue acelera features complejas (reportes, tablas grandes) |
| Backend nube | — | **Node + Fastify + PostgreSQL** | Fastify > Express para APIs pesadas; PostgreSQL por multi-tenancy |
| Auth nube | Firebase parcial | **Firebase Auth (email/Google/phone) + JWT propio para API** | Firebase se encarga del 80% gratis hasta ~50k MAU |
| Sync layer | — | **BullMQ (Redis) o una cola postgresql nativa (pg_boss)** | pg_boss evita sumar Redis al stack si empiezas pequeño |
| Mobile | Flutter | **Mantener Flutter** | Ya invertiste, es la opción correcta |
| Respaldos cloud | — | **Cloudflare R2 o Backblaze B2** | 10x más barato que S3, API compatible |
| Monitoring | — | **Sentry + UptimeRobot** | Sentry gratis hasta 5k eventos/mes |
| Pagos SaaS (cuando vendas) | — | **Stripe o Lemon Squeezy (merchant of record)** | Lemon maneja IVA/impuestos por ti, clave si vendes internacionalmente |

---

## 5. Modelo de negocio y pricing

Dado tu contexto (RD, colmados/tiendas/farmacias, on-premise + nube), el modelo que más encaja:

### Opción A — Licencia on-premise + sync opcional (recomendada para empezar)

- **Tecno Caja Standalone**: USD $149 una vez. Instalación local, MariaDB, sin sync. Soporte por email 6 meses.
- **Tecno Caja Plus**: USD $19/mes (o $199/año). Lo anterior + sync a la nube, app móvil Flutter, respaldos automáticos, reportes consolidados multi-sucursal, actualizaciones prioritarias.
- **Tecno Caja Enterprise**: USD $99/mes. Plus + integración DGII e-CF, soporte telefónico, SLA 24h, setup asistido.

**Por qué funciona:** vendes la licencia upfront (cashflow inmediato), la suscripción Plus es opt-in y captura a los que realmente escalan.

### Opción B — Puro SaaS (solo si te conviertes en hosted-only)

- Tier Free: 1 caja, 50 productos, sin reportes avanzados.
- Tier Pro: USD $29/mes por caja. Todo.
- Tier Chain: USD $199/mes hasta 10 sucursales.

**Por qué NO lo recomiendo de entrada:** en RD hay desconfianza a pagar suscripciones recurrentes para software de negocio pequeño. Licencia one-time vende mejor en colmados y tiendas.

### Canales de venta sugeridos

1. **Instagram + TikTok** con videos de 30s del flujo de venta (es el canal que más vende software de POS a pymes en RD ahora mismo).
2. **Referidos de contadores**: el contador que ya atiende 20 colmados es tu mejor vendedor. Ofrécele 20% de comisión recurrente.
3. **Marketplace de `helpers.com.do` y grupos de Facebook** de emprendedores.
4. **Demos en vivo gratuitas** por WhatsApp (ya tienes WhatsApp Web integrado en la app — aprovéchalo).

---

## 6. Checklist de acciones inmediatas

**Hoy mismo (antes de dormir):**

- [ ] `npm install` para bajar `helmet` y `express-rate-limit` (ya están en `package.json`)
- [ ] Consola Firebase → revocar service account del proyecto actual, generar nueva
- [ ] Guardar el nuevo JSON de Firebase FUERA del directorio del proyecto (ej. `C:\Tecno Caja-Secrets\`)
- [ ] Actualizar `.env` local con la nueva `FIREBASE_SERVICE_ACCOUNT_PATH` apuntando al nuevo lugar
- [ ] Cerrar túnel Cloudflare si está activo
- [ ] Cambiar password maestro desde el wizard (o setear `TECNO_CAJA_SECURITY_PASSWORD` en `.env`)
- [ ] `git rm --cached .env inversiones-martinez-14703-firebase-adminsdk-*.json`
- [ ] `git commit -m "chore(security): sanear .env y excluir credenciales del repo"`
- [ ] `git filter-repo` para borrar del historial (ver comandos en Fase 0)
- [ ] Probar que la app arranca: `npm start` y `npm run electron`

**Esta semana:**

- [ ] Crear repositorio Git privado en GitHub/GitLab si no tienes
- [ ] Configurar branch protection en `main`
- [ ] Crear rama `refactor/modularizacion` para empezar Fase 1
- [ ] Extraer primer dominio (`auth`) de `server.js` como piloto
- [ ] Configurar ESLint + Prettier

**Este mes:**

- [ ] Completar Fase 1 (modularización)
- [ ] Escribir primeros 20 tests Jest
- [ ] Configurar GitHub Actions con lint + test básicos
- [ ] Decidir certificado code-signing y proveedor (DigiCert, Sectigo, Certum)

---

## 7. Riesgos identificados

| Riesgo | Mitigación |
|--------|------------|
| Romper una función al modularizar server.js | Extraer por dominio uno a la vez + smoke test manual entre cada extracción |
| Que el cambio de bind a 127.0.0.1 rompa el mobile POS | Ya está gated por `POS_ALLOW_LAN=true`; documentar claramente al usuario |
| Cliente actual con backups cifrados `Seguridad2026` | `decryptBackupPayload` ahora intenta password activo y cae al legado — transparente |
| Certificado code-signing costoso | Empezar sin él (Windows SmartScreen solo avisa, no bloquea) y comprarlo en Fase 5 |
| Migración SQLite → MariaDB en campo | Ya existe `scripts/migrate-sqlite-to-mysql.js`; hacer dry-run en staging de cada cliente antes de forzar |
| Integración DGII compleja | Contratar a un especialista DGII por 2-3 semanas cuando llegue la Fase 5. No lo hagas solo la primera vez |

---

## 8. Qué NO hacer

- **No migres a TypeScript ahora.** Le agrega 3-4 semanas al plan sin beneficio inmediato. Considera TS después de Fase 3.
- **No reescribas el frontend completo en React.** Migración gradual es la correcta: mantén lo que funciona, introduce Vue/Svelte en features nuevos.
- **No adoptes microservicios.** Para tu escala (hasta ~1.000 clientes), un monolito modular es mejor en todas las dimensiones.
- **No agregues Kubernetes.** Render/Fly.io/Railway te sirve hasta >10.000 clientes.
- **No pongas IA generativa todavía.** Primero estabiliza el core; la IA viene después como feature "Pro" (análisis de ventas, sugerencias de reorden).

---

## Apéndice — Archivos modificados en esta sesión

- `.gitignore` (creado) — excluye credenciales, builds, BD, uploads
- `.env.example` (reescrito) — plantilla segura, documentada
- `package.json` — añadidas `helmet` y `express-rate-limit`
- `server.js`:
  - Líneas ~38-48: password maestro configurable + warning
  - Líneas ~398-465: CORS con allowlist + helmet + rate limiter
  - Líneas ~3426-3461: `decryptBackupPayload` con fallback legado
  - Línea ~4174: `/api/login` protegido con rate limiter
  - Línea ~4231: `/api/login/google` protegido con rate limiter
  - Línea ~4934: `/api/auth/offline-login` protegido con rate limiter
  - Línea ~10000: bind por defecto `127.0.0.1` + warning si LAN

---

**Siguiente paso sugerido:** dame luz verde para empezar la **Fase 1 (modularización)**. Puedo extraer el primer dominio (`auth`) como piloto para que veas el patrón antes de que yo siga con el resto.
