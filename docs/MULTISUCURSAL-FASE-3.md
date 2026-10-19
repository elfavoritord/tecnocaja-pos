# Multisucursal — Fase 3: gestión central de sucursales

Fecha: 2026-10-19 · Rama: `fase-2-seguridad` · Antes: [Fase 2](MULTISUCURSAL-FASE-2.md).

## Decisión de Emilio (2026-10-19)

- **Solo Emilio (super administrador, `tecno-caja-admin`) y el contador (su portal) crean sucursales.** El dueño del negocio no las crea desde el POS.
- **Emilio controla cuántas sucursales puede tener cada empresa** (límite por empresa).
- **El contador solo crea y edita los datos** de las sucursales de SUS empresas, dentro del límite. No cambia el límite ni activa o desactiva sucursales.

## 3a — Hecho: sucursales centrales en los dos paneles

| Pieza | Archivo | Qué hace |
|---|---|---|
| Reglas (fuente única) | `server/multisucursal/central/sucursales.js` | Límite por empresa (1–200; sin fijar = 1), crear/editar/activar/desactivar, código de equipo. Todo en **transacción de Firestore**: dos personas creando a la vez no se pasan del límite. Permisos: primero se verifica el permiso y después los datos |
| Rutas (compartidas) | `server/multisucursal/central/sucursales.routes.js` | `/api/sucursales/:licenseId…`. Cada panel pone su inicio de sesión y dice quién es (`actorDe`). Un contador recibe 403 aunque llame a la ruta del límite |
| Pantalla (compartida) | `js/sucursales-central-ui.js` | Lista, crear, editar, código de equipo; límite y activar/desactivar solo si el panel lo permite. Colores del portal (día/noche) con respaldo oscuro para el panel de Emilio. Escapa todo lo que escribe el usuario |
| Panel de Emilio | `tecno-caja-admin/server.js`, `public/index.html`, `public/js/admin-app.js` | Sección "Sucursales" en la ficha del negocio, con límite y activar/desactivar. Cada cambio va a `audit_logs` |
| Portal del contador | `tecno-caja-contadores/server.js`, `public/index.html`, `public/js/contadores-app.js` | Sección "🏬 Sucursales" en el detalle de la empresa cliente, sin límite ni activar/desactivar |
| Copias al portal | `tecno-caja-contadores/scripts/vendor-sync.js` | Copia reglas, rutas y pantalla (el instalador del portal solo empaqueta su carpeta) |

### Datos en Firestore

| Ruta | Contenido |
|---|---|
| `licencias/{licenseId}` | `maxSucursales` (lo fija solo Emilio), `companyUuid` (se asigna con la primera sucursal) |
| `licencias/{licenseId}/sucursales/{branchUuid}` | nombre, código (único en la empresa), dirección, teléfono, encargado, estado `activa`/`inactiva`, `esPrincipal`, `version`, `creadaPor` |
| `licencias/{licenseId}/sucursales_historial/{auto}` | cada acción con quién la hizo (tipo, uid, nombre) y cuándo |
| `activaciones_equipo/{sha256(código)}` | código de equipo: **solo se guarda el hash**, un solo uso, vence en 24 h |

El **código de equipo** (`XXXX-XXXX`, sin letras que se confundan: I, L, O, 0, 1) se muestra una sola vez en el panel. Con él, la PC de la sucursal se autoriza solo para ESA sucursal (canje en la Fase 3b).

### Pruebas (resultados reales)

| Prueba | Resultado |
|---|---|
| Reglas contra el **emulador de Firestore** (`npm run test:multisucursal-central`) | **9/9**: límite por defecto, solo Emilio cambia el límite, **5 creaciones a la vez con límite 2 → exactamente 2**, aislamiento entre firmas, código único, activar/desactivar y cupo, código de un solo uso con hash y vencimiento, licencia suspendida, historial |
| Rutas HTTP de los dos paneles contra el emulador | **5/5**: sin sesión 401; Emilio fija y el contador crea hasta el límite (409 al pasarse); el contador recibe 403 en límite y estado; otra firma 403; editar y código desde el portal |
| **Pantalla en Chrome real** contra rutas y emulador (`scripts/multisucursal/probar-pantalla-sucursales.js`) | **11/11** en el panel de Emilio y en el portal del contador (noche y día). Encontró y se corrigió que ningún botón de acción respondía (un `<button>` sin `type` es *submit*) |
| Copias del portal al día + escape de HTML | 4/4 (en `npm test`) |
| `npm test` completo | 87 suites, **649 OK**. Las 2 suites del emulador se omiten sin emulador (14 pruebas) |

El emulador corre con `firebase-tools@13.35.1` (vía `npx`): la CLI instalada (15.x) pide Java 21 y la PC tiene Java 17. Puerto propio 8091 en `firebase.emulador.json`, sin tocar `firebase.json`.

## 3b — Hecho: Sync API (`cloud/sync-api/`, Cloud Run, sin desplegar)

Ver [cloud/sync-api/README.md](../cloud/sync-api/README.md).

- `POST /v1/equipos/activar`: canjea el código y entrega un **token por equipo** (`eq_<id>.<secreto>`; en Firestore solo su hash). Todo en una transacción (`activarEquipo` en las reglas centrales): consume el código, deja como **reemplazada** a la PC que tenía la sucursal (una sucursal = una PC que sincroniza, para que dos bases no se hagan pasar por la misma) y registra la nueva. Si la PC ya tiene la licencia de otra empresa, se rechaza sin gastar el código. Máximo 10 intentos cada 15 minutos por IP.
- `GET /v1/identidad` y `POST /v1/latido`, con token. Responden 403 con código claro si el equipo fue reemplazado o revocado, o si la sucursal o la licencia están inactivas.
- Reglas nuevas: `activarEquipo`, `listarEquipos` (sin el hash del token) y `revocarEquipo` (**solo Emilio**).
- El servicio usa la cuenta de servicio de Cloud Run: **el POS no necesita la llave de administrador de Firebase** para esto.

## 3c — Hecho: el POS se conecta como sucursal

| Pieza | Archivo |
|---|---|
| Enlace | `server/multisucursal/enlace.js`: activar con el código, guardar el token en `config/app.env`, **adoptar** `companyUuid`/`branchUuid` en `businesses`/`branches` y copiar nombre/código/dirección de la central, latido cada 5 min, identidad cada 30 min, detectar reemplazado/revocado/inactiva, desvincular. Nunca toca la venta |
| Rutas | `server/routes/multisucursal.routes.js`: `POST /activar`, `/sincronizar`, `/desvincular` (administrador general; activar y desvincular solo desde la PC principal) |
| Bloqueo | `POST /api/branches` devuelve 403 si la PC está enlazada: las sucursales las crean Tecno Caja o el contador |
| Pantalla | Configuración → "Sucursal conectada a Tecno Caja" (`js/multisucursal-enlace.js`): escribir el código (se formatea `XXXX-XXXX`), estado, sincronizar, desvincular, avisos de revocación |
| Configuración | `TECNO_CAJA_SYNC_URL` (URL de la Sync API) y `TECNO_CAJA_SYNC_TOKEN` (lo pone la activación) en `config/app.env`. Sin URL, la sección dice que el servicio aún no está disponible |

### Pruebas 3b/3c (resultados reales)

| Prueba | Resultado |
|---|---|
| Sync API contra el emulador (`cloud/sync-api/test`) | **10/10**: activar, código usado/inválido, otra empresa, identidad con/sin/falso token, datos vigentes, una PC por sucursal, revocar solo Emilio, sucursal/licencia inactiva, latido visible sin hash, límite de intentos |
| Enlace del POS con API simulada (`tests/multisucursal/enlace.sqlite.test.js`) | **13/13** |
| **Punta a punta** (`npm run test:multisucursal-enlace`): Sync API + servidor del POS real en SQLite + pantalla en Chrome | **19/19**: el contador crea la sucursal y su código → se escribe en el POS → adopta la identidad central y manda su latido → no deja crear sucursales locales → toma el nombre que cambió el contador → tras reiniciar sigue enlazada → Emilio revoca y el POS lo detecta (y sigue vendiendo local) → desvincular |
| Regresión | Jest 88 suites / **662 OK**; `test:e2e-lan` **44/44**; arranque SQLite **13/13** |

## 3e — Hecho: PC autorizadas en los dos paneles

En la sección de sucursales, debajo de la lista, aparece **"PC autorizadas"**: cada PC con su sucursal, versión, estado y pendientes.

- **En línea:** tuvo un latido en los últimos 12 min (manda uno cada 5).
- **Sin conexión:** su último latido es más viejo.
- **Reemplazada** o **Revocada:** quedan ocultas tras "Ver anteriores".

Cada fila de sucursal resume su PC ("PC: En línea · hace 2 min" o "Sin PC autorizada").

| Pieza | Archivo |
|---|---|
| Rutas | `GET /api/sucursales/:licenseId/equipos` (los dos paneles, nunca devuelve el hash del token) y `POST /api/sucursales/:licenseId/equipos/:equipoId/revocar` (**solo Emilio**; va a `audit_logs` como `sucursales.revocar_equipo`) |
| Pantalla | `js/sucursales-central-ui.js`: tabla de PC, botón **Revocar** solo con `permisos.revocar` (el panel de Emilio lo pasa; el portal no). Pide confirmación y avisa que la tienda sigue vendiendo. Si la lectura de PC falla, las sucursales se ven igual |

Pruebas:

| Prueba | Resultado |
|---|---|
| Rutas contra el emulador | Los dos paneles ven las PC sin el hash; otra firma recibe 403; el contador recibe 403 al revocar; Emilio revoca y queda auditado. Total `test:multisucursal-central`: **25/25** |
| Pantalla en Chrome (`probar-pantalla-sucursales.js`) | **19/19**: en línea con "3 por enviar", "Sin conexión · hace 2 h", reemplazada oculta hasta "Ver anteriores", el contador sin botón revocar, Emilio revoca y se registra quién lo hizo |
| Regresión | Jest 88 suites / **662 OK** |

## 3d — Hecho: Sync API desplegada

`tecno-caja-sync-api` en Cloud Run (us-east1), con mínimo 0 instancias. Su URL queda por defecto en el POS (`enlace.js`): `TECNO_CAJA_SYNC_URL` vacío usa el servicio y `off` lo apaga.

## Siguiente

Las fases 4 a 8 (catálogo, sincronización, usuarios por sucursal, NCF y pruebas integrales) están en [MULTISUCURSAL-FASES-4-8.md](MULTISUCURSAL-FASES-4-8.md).

## Pendiente de revisar

- El portal del contador lleva su propia `firebase-service-account.json` (llave de administrador) dentro del instalador, igual que el POS. Mismo riesgo R1 del diagnóstico.
- Las reglas de Firestore no cubren `licencias/*/sucursales` ni `activaciones_equipo` porque hoy todo se escribe con Admin SDK; `licencias` ya está cerrada a clientes (`allow read, write: if false`), así que las subcolecciones nuevas también.
