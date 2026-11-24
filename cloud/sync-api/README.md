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
| GET | `/v1/identidad` | `Authorization: Bearer <token>` → datos vigentes de la empresa y la sucursal, y `licenciaEmpresa` (plan, estado, fechas, servicios y bloqueos; nada del dueño): con eso una PC de sucursal **sin llave de Firebase** (instalador 1.6.36+) trabaja con la licencia de la empresa (`enlace.licenciaEmpresa()`) |
| POST | `/v1/latido` | `{ appVersion, modo, pendientes: { salida, errores, conflictos }, ultimaSincronizacion, ncf: [{ rangoUuid, siguiente }], perfil? }` → estado de la PC para los paneles. La principal manda `perfil` y queda en `licencias/{id}.perfilNegocio` (una sucursal nueva arranca igual) |
| POST | `/v1/eventos` | `{ eventos: [...] }` (máx. 200, 4 MB) → `{ resultados: [{ eventId, resultado: ok\|duplicado\|rechazado, code, motivo }] }`. Idempotente por `event_id`. Tipos: `venta`, `producto_sucursal`, `producto` y `usuario` (solo la principal), `comando_precio` (solo la principal), `ncf_rango` |
| GET | `/v1/cambios?tipo=catalogo\|usuarios\|comandos\|ncf&desde=<seq>&limite=<n>&contar=1` | Lo que cambió para esta sucursal desde el cursor, en páginas (`siguiente`, `hayMas`, `pendientes`) |
| GET | `/v1/sucursales` | Sucursales de la empresa (para elegir alcance en la principal) |

### Respaldos en la nube sin llaves en las PC (`lib/respaldos.js`, 2026-11-10)

La llave de Backblaze vive solo aquí. Cada PC pide un permiso y recibe enlaces firmados de 5 minutos para **su** carpeta `backups/<licencia>/`; el POS lo usa solo (`server/services/nube-intermediario.js`, desde `r2-storage.js`) cuando su `app.env` no tiene llave propia.

| Método | Ruta | Para qué |
|---|---|---|
| POST | `/v1/respaldos/sesion` | `{ licenseId, deviceId }` (la PC tiene que estar en `licencias/{id}.devices` y no liberada) → permiso de 1 h para su carpeta. O `{ idToken }` (cuenta del dueño, sesión de menos de 30 min) → permiso de 30 min para **leer** los respaldos de sus negocios (PC formateada o nueva) |
| POST | `/v1/respaldos/listar` · `/bajar` · `/verificar` | Bearer → lista, enlace de bajada, tamaño + huella |
| POST | `/v1/respaldos/subir` · `/borrar` | Bearer, solo la PC → enlace de subida (la huella va firmada como `x-amz-meta-sha256`) / borrar un respaldo viejo |
| POST | `/v1/respaldos/clave` | Bearer → clave con que se cifran los respaldos del negocio. La PC manda la suya (`propia`) y queda guardada; formateada, la recupera. El dueño solo la lee |

Firestore: `respaldos_claves/{licenseId}` (`actual` + `anteriores`, cifradas con AES-256-GCM y `RESPALDOS_SECRETO`). Ninguna regla la abre.

Variables (además de `FIRESTORE_PROJECT_ID`): `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT` (la llave del bucket) y `RESPALDOS_SECRETO` (copia en el `.env` del repo: **si se pierde o cambia, las claves guardadas ya no se abren**). Sin ellas las rutas responden 503. Pruebas: `npx jest test/respaldos` (en esta carpeta) y, contra Backblaze real, `node scripts/probar-nube-intermediario.js` desde la raíz (con `NODE_PATH=cloud/sync-api/node_modules`).

Respuestas 403 con `code`: `EQUIPO_REEMPLAZADO`, `EQUIPO_REVOCADO`, `SUCURSAL_INACTIVA`, `LICENCIA_INACTIVA`. El POS las muestra y deja de sincronizar; la venta local sigue igual. Máximo 120 peticiones por minuto por equipo.

Reglas de eventos y cambios: `vendor/multisucursal/sincronizacion-central.js`, copia de `server/multisucursal/central/sincronizacion-central.js`. Ver `docs/MULTISUCURSAL-FASES-4-8.md`.

## Datos de la PC sin la llave completa (2026-11-23, rev 00016)

Desde la 1.6.36 el instalador no trae la llave de administrador de Firebase. La PC principal ya vinculada (instalación firmada con su clave ed25519, ver `lib/pos-installations.js`) pide aquí lo que necesita para subir sus datos:

| Método | Ruta | Para qué |
|---|---|---|
| POST | `/v1/pos/credential` | Firmado por la PC vinculada y no liberada → cuenta de servicio `tecno-caja-pos-pc` (**solo Cloud Datastore User**, sin Firebase Auth). El POS la guarda cifrada en `config/pos-cloud/firestore-credencial.json` y la usa para Firestore (app de reportes, Centro de Control, catálogo, tienda); la licencia y la identidad siguen por esta API. 503 `CREDENCIAL_NO_CONFIGURADA` sin el secreto |
| POST | `/v1/pos/contador` | Firmado → guarda `contadorId`/`contadorNombre` en la licencia (verifica que el contador exista y no esté suspendido; sin `contadorId` lo quita) |
| GET | `/v1/contadores/buscar?q=` | **Pública** (el asistente corre antes de vincular la PC): nombre de la firma, responsable, RNC, teléfono, correo y logo `https`; sin suspendidos, máximo 20, 40 búsquedas por minuto por IP, lista en caché 60 s |

La llave sale de Secret Manager: `pos-firestore-credential` → variable `POS_FIRESTORE_CREDENTIAL` (`--update-secrets=POS_FIRESTORE_CREDENTIAL=pos-firestore-credential:latest`; la cuenta de Compute del servicio tiene `secretAccessor` sobre ese secreto). Para cambiar la llave: crear otra de `tecno-caja-pos-pc`, `gcloud secrets versions add pos-firestore-credential --data-file=…`, volver a desplegar y borrar la vieja; cada PC la vuelve a pedir al abrir. Ojo: Firestore no deja limitar una cuenta de servicio a un negocio, así que esa llave lee y escribe los datos de todos (sin cuentas de usuario, sin Storage). Pruebas: `npx jest test/pos-datos`.

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

`--update-env-vars` conserva las variables que ya tiene el servicio (las de respaldos se ponen una vez; ver arriba). Para ponerlas sin escribirlas en pantalla hay un script que las lee del `.env` del repo.

- `--allow-unauthenticated`: la autenticación es el token de cada equipo o la cuenta del dueño, no IAM (el POS no tiene cuenta de Google).
- La cuenta de servicio de Cloud Run (hoy la de Compute por defecto, con Editor) necesita **Cloud Datastore User** y poder leer usuarios de Firebase Auth (verificar la cuenta del dueño).
- Después del deploy, en cada PC principal de sucursal: `TECNO_CAJA_SYNC_URL=https://<url-del-servicio>` en `config/app.env`. En la siguiente versión del instalador se pone por defecto.
- Costo con mínimo 0 instancias: centavos al mes con pocas sucursales (un latido cada 5 min por PC y una lectura de identidad cada 30 min).
