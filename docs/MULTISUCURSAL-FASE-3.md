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

## Siguiente

- **3b — Sync API (Cloud Run):** canjear el código de equipo (`canjearCodigo` ya está hecho y probado), entregar un token por equipo y la identidad (empresa y sucursal). El POS adopta `companyUuid`/`branchUuid` en sus filas `businesses`/`branches`. Sin la llave de administrador de Firebase en el POS.
- **3c — POS:** pantalla "Activar como sucursal" (escribir el código) y vista de solo lectura de las sucursales de la empresa. Conectar `user_branch_access` a los permisos.
- **3d — Despliegue** de la Sync API, solo con el visto bueno de Emilio.

## Pendiente de revisar

- El portal del contador lleva su propia `firebase-service-account.json` (llave de administrador) dentro del instalador, igual que el POS. Mismo riesgo R1 del diagnóstico.
- Las reglas de Firestore no cubren `licencias/*/sucursales` ni `activaciones_equipo` porque hoy todo se escribe con Admin SDK; `licencias` ya está cerrada a clientes (`allow read, write: if false`), así que las subcolecciones nuevas también.
