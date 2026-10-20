# Tecno Caja Sync API

Servicio en Cloud Run para multisucursal. Cada sucursal tiene su propia base y su PC principal se conecta aquí por HTTPS saliente: sin VPN ni Tailscale, y **sin la llave de administrador de Firebase en el POS**. El servicio usa la cuenta de servicio de Cloud Run y cada PC tiene su propio token.

Reglas de sucursales y equipos: `vendor/multisucursal/sucursales.js`, copia de `server/multisucursal/central/sucursales.js` del POS (`npm run vendor-sync`). Son las mismas reglas que usan el panel de Emilio y el portal del contador.

## Endpoints

| Método | Ruta | Para qué |
|---|---|---|
| GET | `/health` | Salud |
| POST | `/v1/acceso/dueno` | `{ idToken }` (Firebase Auth del **dueño del negocio**: su correo y contraseña de Tecno Caja, o su Google) → `{ empresas: [{ licenseId, nombre, perfil, sucursales: [{ ..., pc }] }] }`. Dueño = `correo` (lo escribe el POS), `ownerEmail` o `email` de la licencia. Solo empresas con sucursales creadas. El inicio de sesión debe tener menos de 30 min (`SESION_VIEJA`). Máximo 20 intentos cada 15 min por IP |
| POST | `/v1/equipos/activar-dueno` | `{ idToken, licenseId, branchUuid, equipo }` → 201 igual que `activar` más el `perfil` de la principal (tipo de negocio, moneda, ITBIS, RNC). **Así se conecta una PC normalmente, sin código** (asistente inicial y Configuración del POS) |
| POST | `/v1/equipos/activar` | `{ codigo, equipo }` → 201 `{ token, equipoId, empresa, sucursal }`. Respaldo para soporte: el código lo generan Emilio o el contador; sirve una vez y vence en 24 h. Máximo 10 intentos cada 15 min por IP |

En los dos caminos el token se entrega **una sola vez** (en Firestore solo queda su hash) y, si la sucursal ya tenía una PC, esa queda "reemplazada". También queda "reemplazado" el enlace anterior de la misma instalación (mismo `serverId`) si se configuró otra vez como otra sucursal. Cada PC conserva **su propio id de licencia** (para que las sincronizaciones viejas no escriban en la empresa), pero en el POS trabaja con el plan y el estado de la licencia de la empresa (`server/multisucursal/licencia-sucursal.js`). Se rechaza (`OTRA_EMPRESA`) una PC que ya tiene ventas de otro negocio.
| GET | `/v1/identidad` | `Authorization: Bearer <token>` → datos vigentes de la empresa y la sucursal |
| POST | `/v1/latido` | `{ appVersion, modo, pendientes: { salida, errores, conflictos }, ultimaSincronizacion, ncf: [{ rangoUuid, siguiente }], perfil? }` → estado de la PC para los paneles. La principal manda `perfil` y queda en `licencias/{id}.perfilNegocio` (una sucursal nueva arranca igual) |
| POST | `/v1/eventos` | `{ eventos: [...] }` (máx. 200, 4 MB) → `{ resultados: [{ eventId, resultado: ok\|duplicado\|rechazado, code, motivo }] }`. Idempotente por `event_id`. Tipos: `venta`, `producto_sucursal`, `producto` y `usuario` (solo la principal), `comando_precio` (solo la principal), `ncf_rango` |
| GET | `/v1/cambios?tipo=catalogo\|usuarios\|comandos\|ncf&desde=<seq>&limite=<n>&contar=1` | Lo que cambió para esta sucursal desde el cursor, en páginas (`siguiente`, `hayMas`, `pendientes`) |
| GET | `/v1/sucursales` | Sucursales de la empresa (para elegir alcance en la principal) |

Respuestas 403 con `code`: `EQUIPO_REEMPLAZADO`, `EQUIPO_REVOCADO`, `SUCURSAL_INACTIVA`, `LICENCIA_INACTIVA`. El POS las muestra y deja de sincronizar; la venta local sigue igual. Máximo 120 peticiones por minuto por equipo.

Reglas de eventos y cambios: `vendor/multisucursal/sincronizacion-central.js`, copia de `server/multisucursal/central/sincronizacion-central.js`. Ver `docs/MULTISUCURSAL-FASES-4-8.md`.

## Firestore

| Colección | Contenido |
|---|---|
| `licencias/{id}/sucursales/{branchUuid}` | Sucursales (las crean Emilio o el contador) |
| `activaciones_equipo/{sha256(código)}` | Códigos de un solo uso (respaldo para soporte) |
| `equipos_sync/{equipoId}` | PC de cada sucursal: hash del token, estado, último latido |

Ninguna regla de `firestore.rules` las abre: quedan cerradas a cualquier cliente y solo las toca el Admin SDK (esta API y los paneles).

## Pruebas

Desde la raíz del repo, con el emulador de Firestore (Java 17 → firebase-tools 13 por `npx`):

```bash
npm run test:multisucursal-central     # reglas + rutas de los paneles + esta API (59 pruebas)
npm run test:multisucursal-enlace      # API + POS en SQLite + Configuración en Chrome
npm run test:multisucursal-asistente   # PC nueva: asistente con la cuenta del dueño → entra el cajero y vende
```

En las pruebas Firebase Auth es falso (`createApp({ verificarIdToken })`); en Cloud Run lo verifica el Admin SDK (`lib/store.js`, revisa también si la sesión fue cerrada).

## Despliegue

Desplegada el 2026-10-19 como `tecno-caja-sync-api` (us-east1; revisión actual: `00006`). Emilio autorizó subirla; para cada cambio:

```powershell
cd cloud/sync-api
npm run vendor-sync
gcloud run deploy tecno-caja-sync-api --source . --region us-east1 --project reporte-sistema-pos `
  --allow-unauthenticated --min-instances 0 --max-instances 3 --memory 256Mi `
  "--update-env-vars=FIRESTORE_PROJECT_ID=reporte-sistema-pos"
```

- `--allow-unauthenticated`: la autenticación es el token de cada equipo o la cuenta del dueño, no IAM (el POS no tiene cuenta de Google).
- La cuenta de servicio de Cloud Run (hoy la de Compute por defecto, con Editor) necesita **Cloud Datastore User** y poder leer usuarios de Firebase Auth (verificar la cuenta del dueño).
- Después del deploy, en cada PC principal de sucursal: `TECNO_CAJA_SYNC_URL=https://<url-del-servicio>` en `config/app.env`. En la siguiente versión del instalador se pone por defecto.
- Costo con mínimo 0 instancias: centavos al mes con pocas sucursales (un latido cada 5 min por PC y una lectura de identidad cada 30 min).
