# Multisucursal — Fase 2: identidad y esquema

Fecha: 2026-10-19 · Rama: `fase-2-seguridad` · Diagnóstico previo: [MULTISUCURSAL-DIAGNOSTICO.md](MULTISUCURSAL-DIAGNOSTICO.md).

Prepara la base de cada instalación para trabajar como sucursal independiente. **Todavía no envía ni recibe nada de la nube** (eso es la Fase 3, Sync API, y la Fase 5, motor de sincronización). Todo lo que se hizo es aditivo: el resto del POS no usa estas columnas ni tablas y funciona igual.

---

## 1. Qué se agregó

| Pieza | Archivo | Para qué |
|---|---|---|
| Migraciones numeradas | `server/migrations/runner.js` | Migraciones con clave propia en `schema_migrations` (la misma tabla del núcleo), reversibles, idempotentes y con verificación estructural. En MariaDB se serializan con `GET_LOCK` (principal + terminal a la vez). Respaldo antes de migrar |
| ms-0001 | `server/migrations/multisucursal/0001-uuid-entidades.js` | Columna `uuid` + índice único en empresas, sucursales, cajas, usuarios, categorías, productos, clientes, proveedores, ventas, movimientos de inventario, sesiones de caja y transferencias. Las filas existentes se rellenan en una sola sentencia por tabla |
| ms-0002 | `server/migrations/multisucursal/0002-tablas-sincronizacion.js` | `sync_outbox` (bandeja de salida), `sync_inbox` (entrada, idempotente por `event_id`), `sync_cursors` (descarga por cursor). Fechas ISO-8601 UTC |
| ms-0003 | `server/migrations/multisucursal/0003-acceso-sucursales.js` | **Reutiliza** `user_branch_access`, que ya existía y no se usaba: le agrega `estado`, `origen`, `updated_at` e índice único, y la llena con la sucursal actual de cada usuario |
| Identidad | `server/multisucursal/identidad.js` | Empresa, sucursal y nodo (`TECNO_CAJA_SERVER_ID`) con uuid. `asegurarUuid()` para filas nuevas, `rellenarUuidsFaltantes()` al arrancar |
| Bandejas | `server/multisucursal/bandejas.js` | `registrarSalida()` dentro de la transacción de la operación. Reintento con espera creciente (30 s → 1 h, ±20 %), confirmación explícita, rechazo sin reintento, entrada idempotente, cursores, resumen |
| Aislamiento | `server/multisucursal/aislamiento.js` | Valida cada evento contra la identidad del que recibe: nunca otra empresa, ventas/caja/inventario solo de la propia sucursal, la nube limita a las sucursales autorizadas del equipo |
| Acceso | `server/multisucursal/acceso-sucursales.js` | A qué sucursales entra un usuario (la principal + las asignadas). Revocación lógica |
| Diagnóstico | `server/routes/multisucursal.routes.js` | `GET /api/multisucursal/estado` (solo administrador general): identidad, migraciones y bandeja |
| Arranque | `server.js` (3 enganches) | `prepararAlArrancar()` después de las migraciones del núcleo y **antes** de la recuperación automática (un respaldo nuevo trae `uuid` y la base debe tenerlo). Las terminales secundarias no migran |
| Paso a multicaja | `scripts/lib/sqlite-to-mysql-migrator.js` | Aplica el esquema en la MySQL destino antes de copiar y toma los uuid del SQLite, incluida la sucursal 1 sembrada. Sin esto, la migración quedaba "incompleta" por las tablas nuevas o perdía los uuid |

**Por qué no se reutilizó `firebase_sync_queue`:** es una cola de "último estado" (su índice único colapsa varios cambios de la misma entidad), no tiene `event_id` ni versión, y se llena **después** del commit de la venta. Sigue igual para la app de reportes.

## 2. Errores que ya existían y se corrigieron (los encontraron estas pruebas)

| Error | Efecto | Arreglo |
|---|---|---|
| **`db.js` (SQLite): dos guardados a la vez usaban el mismo temporal** `<db>.tmp-<pid>` | La venta quedaba confirmada en memoria pero el cajero veía **error 500**, o se caía en la escritura directa **no atómica** (riesgo de base corrupta con un apagón) | Los guardados van en cola (`_writeChain`). Prueba: `tests/db-sqlite-guardado-concurrente.test.js` (fallaba antes, pasa ahora) |
| **Restaurar un respaldo con columnas que esta versión no tiene** | El INSERT de toda la tabla fallaba, `safeQ` lo tragaba y la tabla quedaba **vacía sin avisar** | `restorePayloadToDb` usa solo las columnas que existen y avisa cuáles omite. Prueba: `tests/services/backup-core-restore-columnas.test.js` |
| `seed-license.js` (e2e) en SQLite | `process.exit()` antes del guardado diferido: la licencia no quedaba en el archivo | `flushPendingSave()` antes de salir |

## 3. Pruebas (resultados reales)

| Prueba | Resultado |
|---|---|
| `npm test` (Jest) | **86 suites, 645 pruebas OK**. Antes 80/601; +6 suites y +44 pruebas, ninguna anterior rota |
| `npm run test:multisucursal-mariadb` (MariaDB 12.2.2 real, temporal) | **18/18**: aplicar con datos, uuid únicos, índice único, acceso, segunda corrida sin cambios, bandejas (transacción revertida, `INSERT IGNORE`, cursor, error con reintento), revertir y volver a aplicar, **dos servidores migrando a la vez** (uno migra y el otro espera), migrador SQLite→MySQL conservando uuid y bandeja |
| `npm run test:multisucursal-sqlite` (servidor real en SQLite) | **13/13**: versión anterior → actualización con **respaldo previo verificable** (con los datos de antes de migrar) → login, catálogo y venta igual → reinicio sin volver a migrar ni cambiar identidad → interruptor de soporte con la base migrada |
| `npm run test:e2e-lan` (principal + caja, MariaDB real) | **44/44** (42 de siempre + 2 nuevas): 20 ventas simultáneas, inventario exacto, contingencia, recuperación sin duplicados. La principal migra y la terminal no |
| `scripts/multisucursal/revertir-migraciones.js` sobre la base del sandbox | Simulacro sin cambios. Con `--confirmar`: respaldo `PRE-REVERSION`, revierte de la última hacia atrás y queda guardado en el archivo |

## 4. Despliegue

1. Va en el próximo instalador sin pasos manuales. Al primer arranque de la PC principal (o monocaja): respaldo `PRE-MIGRACION_<negocio>` en `Documentos\TecnoCaja\Backups` (solo si hay usuarios), luego las 3 migraciones, en milisegundos con bases normales.
2. Si el respaldo previo falla, **no se migra** en ese arranque y el POS sigue como antes.
3. Las terminales completas no migran: lo hace la principal.
4. Verificar: `GET /api/multisucursal/estado` con un administrador general.

## 5. Reversión

| Nivel | Cómo | Cuándo |
|---|---|---|
| 1. Apagar | `TECNO_CAJA_MULTISUCURSAL_DESACTIVAR=1` en `config\app.env` y reiniciar | Cualquier duda. El POS queda como antes de la Fase 2 (probado sobre una base ya migrada) |
| 2. Revertir el esquema | Con la app cerrada: `node scripts/multisucursal/revertir-migraciones.js --hasta ms-0001-uuid-entidades --confirmar` | Solo si las columnas nuevas estorban. Hace respaldo antes. No borra `user_branch_access` (no es de esta fase). No revierte una bandeja de salida con eventos sin confirmar |
| 3. Datos | Restaurar el `PRE-MIGRACION_…tcbak` | Solo si hubo daño en datos (no se espera: no se modifica ningún dato existente salvo poner uuid) |

## 6. Pendiente y riesgos

- **Las filas nuevas nacen sin uuid** hasta el siguiente arranque o hasta que se sincronicen (`asegurarUuid`). Es a propósito: no se tocaron los ~95 lugares que insertan. La Fase 5 lo asigna al registrar el evento.
- Los respaldos (`buildFullPayload`) todavía no incluyen `sync_outbox`. Se agrega en la Fase 5, cuando haya eventos reales.
- `user_branch_access` todavía no se usa en los permisos del POS. Se conecta en la Fase 3.
- Riesgos del diagnóstico que siguen abiertos: llave de administrador de Firebase en el instalador (se resuelve con la Sync API de la Fase 3), `businessId` sacado del nombre, restaurar respaldos viejos sin `TECNO_CAJA_SECURITY_PASSWORD`, base que arranca en blanco si no se puede descifrar, contraseñas en texto plano.
- Hallado y **no** tocado: `db/schema.sql` empieza con BOM + `CREATE DATABASE` + `USE tecnocaja`, así que `applySchema` del migrador falla siempre (se tolera porque el servidor ya creó el esquema antes de migrar). Si algún día el migrador corre sobre una base vacía, crearía las tablas en `tecnocaja` y no en `DB_NAME`.

## 7. Siguiente: Fase 3 — Gestión central

Sync API en Cloud Run (token por equipo, sin la llave de administrador en el POS), activar equipo y sucursal, empresas/sucursales/usuarios desde el panel, y conectar `user_branch_access` a los permisos.
