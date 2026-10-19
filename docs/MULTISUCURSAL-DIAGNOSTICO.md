# Multisucursal — Diagnóstico técnico (Fase 1)

Fecha: 2026-10-18 · Rama: `fase-2-seguridad` · Base: prompt maestro "Tecno Caja POS Multisucursal".
Todo lo de este documento se verificó leyendo el código. Todavía no se cambió nada.

---

## 1. Cómo funciona hoy

| Pieza | Realidad verificada |
|---|---|
| App | Electron arranca `mariadbd` (si aplica) → Express `server.js` en 127.0.0.1:3399 → ventana. `server.js` tiene 19.336 líneas y 175 rutas; hay 29 módulos más en `server/routes/` |
| Base local | `db.js` maneja dos motores. **SQLite** (sql.js en memoria, archivo cifrado con una llave de la PC) es el de una instalación monocaja nueva. **MariaDB 12** se usa en multicaja/multisucursal y exige migrar |
| Modos | `business_structure_mode`: `monocaja` / `multicaja` / `multisucursal` |
| Multisucursal actual | **Una sola base MariaDB central** para todas las sucursales. Las otras sucursales se conectan a ella como terminales (API :3399 o MariaDB :3306) por LAN o **Tailscale**: el firewall solo abre `LocalSubnet,100.64.0.0/10`. Fuera del local, depende de la VPN |
| Terminales | Principal · cliente liviano (sin la principal no vende) · terminal completa, con copia SQLite de contingencia (`offline_cache_*`, `pending_*`, `offline_sync_map`) que se sube al reconectar sin duplicar (`clientRequestId`) |
| Modelo | `businesses`, `branches(business_id)`, `cash_registers`, `users(branch_id, sucursal_id, caja_id, role_id)`, `roles(permisos JSON)`, `products` (un solo `precio_venta`; `branch_id` NULL = global, si no, exclusivo de esa sucursal), `inventory_by_branch`, `inventory_movements`, `branch_transfers`, `sales` (sucursal/caja de facturación y de cobro), `sale_items` (con `item_name` congelado), `ncf_authorized_sequences(branch_id)`. **Todas las llaves son enteros autoincrementales; no hay UUID** |
| Permisos | Ya se validan en el backend: catálogo global vs. admin de sucursal (`getProductCatalogBranchScope`), roles `administrador_general`, `administrador_sucursal`, `cajero`, `supervisor` |
| Firebase | Un solo proyecto (`reporte-sistema-pos`) para todos los clientes. El POS usa el **Admin SDK** con `firebase-key.json`, que va **dentro del instalador** (`extraResources`) |
| Subida a la nube | `firebase_sync_queue` (reintentos con `next_retry_at`) → `businesses/{bid}/branches/{idLocal}/sales/{idLocal}`, products, clients, cierres, inventario. Centro de Control (resúmenes). `licencias/{uid}/reportes` (se sobrescribe) |
| Bajada desde la nube | Solo puntual: `productos_pendientes` y `ncf_pendientes` (Portal Contadores), ventas de la app móvil y pedidos de la tienda online. **No hay distribución de catálogo hacia las sucursales** |
| NCF | Secuencias en la base local, consumidas bajo el lock de `config`. `ncf_authorized_sequences` **ya admite `branch_id`** (rango exclusivo por sucursal) |
| e-CF | Se firma **en la PC** con el `.p12` local (`CERT_PATH`). Sin Internet queda pendiente con su e-NCF y se envía después. La recepción la hace el Gateway en Cloud Run (multiempresa por RNC, certificado cifrado con KMS) |
| Respaldos | `.tcbak` (AES-GCM + gzip) en local y en Backblaze por licencia. Recuperación automática al arrancar |
| Migraciones | Funciones `ensure*Schema` que solo corren si sube `CORE_SCHEMA_VERSION` (`core-<versión>-13`). No hay migraciones numeradas ni scripts para revertirlas |

**Pruebas base:** `npm test` → 80 suites, 601 pruebas, todas OK (sección 8).

---

## 2. Qué se reutiliza (no se duplica)

- Sucursales, cajas, `inventory_by_branch`, `inventory_movements`, `branch_transfers` y los permisos por sucursal: el modelo ya es multisucursal.
- `products.branch_id`: producto global o exclusivo de una sucursal ya existe.
- Contingencia de la terminal completa: es el patrón de "guardar local y subir después sin duplicar" que hay que generalizar.
- `firebase_sync_queue` y el monitor de Internet: base para la cola de salida.
- `ncf_authorized_sequences.branch_id`: base para repartir rangos de NCF por sucursal.
- Cloud Run (Gateway e-CF y tienda online) y su modelo de token por empresa: base para un servicio central.
- `tecno-caja-admin` (panel de Emilio): base para administrar empresas y licencias.

---

## 3. Qué falta para el objetivo (Modo C: una base por sucursal)

| Objetivo | Hoy | Falta |
|---|---|---|
| Base independiente por sucursal | Una sola MariaDB compartida por VPN | Que cada sucursal tenga su base y una identidad propia (UUID) |
| Sin Tailscale | Multisucursal remoto depende de VPN | Sincronizar por HTTPS saliente |
| Catálogo maestro + distribución | El catálogo vive en la base compartida | Catálogo central con versión y bajada por cursor hacia cada sucursal |
| Precio por sucursal | Un solo `precio_venta` global | Con una base por sucursal, `products.precio_venta` local **ya es** el precio de esa sucursal. La sincronización del maestro nunca debe tocarlo. La vista central necesita una tabla de precios por sucursal |
| IDs estables | Enteros locales | `uuid` en empresa, sucursal, equipo, producto, venta y movimiento |
| Bandeja de salida transaccional | La venta se encola **después** del commit (`server.js` ~16739) | `sync_outbox` escrita dentro de la misma transacción, más `sync_inbox` para idempotencia |
| Reglas de conflicto | No hay | Por entidad: el maestro gana central, el precio gana local, el inventario se suma por movimientos y las ventas son inmutables |
| Panel de sincronización por sucursal | `/api/sync/status` de una PC | Estado, pendientes, errores y última sincronización de cada sucursal |
| NCF sin choques entre sucursales | Seguro en una base; con bases separadas chocarían | Repartir rangos por sucursal desde el central |

---

## 4. Riesgos que hay que resolver primero

| # | Riesgo | Por qué bloquea |
|---|---|---|
| R1 | **El instalador trae la llave de administrador de Firebase.** Es la misma para todos los clientes y salta todas las reglas | Cualquier PC puede leer y escribir los datos de todas las empresas. Es incompatible con el aislamiento que pide el prompt (§14). La sincronización nueva **no puede** usar esta llave |
| R2 | **El `businessId` en Firestore sale del nombre** (`pos:tecno-caja-{nombre}`). El propio código lo reconoce | Dos negocios con el mismo nombre comparten datos. Hace falta un `company_id` UUID |
| R3 | Los documentos de la nube usan los **ids locales** (`branches/1/sales/1259`) | Con bases separadas, todas las sucursales nacen con `branch_id = 1` y se pisarían. Ya pasó el 17-10 con A & F: restaurar un respaldo viejo pisa ventas en la nube |
| R4 | **Restaurar falla desde la v1.1.19**: el instalador ya no trae `TECNO_CAJA_SECURITY_PASSWORD` | La app cifra con `Seguridad2026` y no abre los respaldos viejos. El rollback que pide el §16 hoy no funciona en las PC actualizadas |
| R5 | **Si la base SQLite no se puede descifrar, la app arranca en blanco** sin avisar (`db.js`) | Pérdida silenciosa de datos (A & F, 17-10 7:39 pm). Choca con la prioridad n.º 1 |
| R6 | Contraseñas en texto plano en `users.password` | Viajan en respaldos y en la sincronización de usuarios |
| R7 | e-CF sin Internet | El prompt pide que el certificado no esté en la PC, pero hoy firmar sin conexión **necesita** el certificado local. Hay que decidirlo con el contador y la norma DGII. No lo voy a suponer |

---

## 5. Arquitectura propuesta (extensión, sin reescribir)

```
          ┌──────────── Nube (HTTPS saliente) ─────────────┐
          │  Tecno Caja Sync API (Cloud Run, Admin SDK)    │
          │  · activa equipos y entrega token por equipo   │
          │  · valida empresa/sucursal/equipo en cada pedido│
          │  · recibe eventos (idempotente por event_id)   │
          │  · entrega cambios por cursor/versión          │
          │  Firestore: companies/{uuid}/…                 │
          └──────────▲─────────────────────────▲───────────┘
                     │ push outbox / pull cursor│
   ┌─────────────────┴──────┐        ┌─────────┴──────────────┐
   │ Sucursal A (su base)   │        │ Sucursal B (su base)   │
   │ SQLite o MariaDB LAN   │        │ multicaja LAN igual    │
   │ sync_outbox / inbox    │        │ que hoy                │
   └────────────────────────┘        └────────────────────────┘
```

- El POS **no** lleva la llave de administrador. Solo tiene su token de equipo (como el Gateway e-CF).
- Dentro de una sucursal no cambia nada: la LAN multicaja sigue igual (Modo B). Lo nuevo es entre sucursales.
- El modo multisucursal actual (base compartida por VPN) se mantiene como **modo legado** mientras haya clientes usándolo.
- Costo estimado: Cloud Run con mínimo 0 instancias más lecturas y escrituras de Firestore. Menos de US$10/mes con pocas decenas de sucursales; se confirma con métricas en la Fase 5.

---

## 6. Plan por fases (ajustado al código real)

| Fase | Contenido | Riesgo para clientes actuales |
|---|---|---|
| **0. Arreglos previos** | R4 (restaurar), R5 (no arrancar en blanco: pantalla de recuperación), R6 (hash solamente), ids de la nube que no se pisen | Bajo; cada uno con pruebas |
| 1. Auditoría | Este documento | Ninguno |
| 2. Identidad y esquema ✅ | Hecha el 2026-10-19: ver [MULTISUCURSAL-FASE-2.md](MULTISUCURSAL-FASE-2.md). `branch_product_settings` se movió a la Fase 4, que es donde se usa | Bajo: solo agrega columnas y tablas |
| 3. Gestión central | Sync API mínima: activar equipo, empresas y sucursales, usuarios por sucursal. Pantallas en el POS y en `tecno-caja-admin` | Medio |
| 4. Catálogo global | Maestro con versión, alcance global/sucursales/exclusivo, bajada por cursor. Nunca toca precio ni stock local | Medio |
| 5. Sincronización | Bandeja de salida transaccional, reintentos con espera creciente, idempotencia, reglas de conflicto, panel e indicadores | Medio |
| 6. LAN | Se reutiliza lo actual (`test:e2e-lan`) y se le agrega el uplink de la sucursal | Bajo |
| 7. Fiscal | Rangos de NCF por sucursal asignados desde el central; e-CF según la decisión de R7 | **Alto**: se hace al final, con pruebas de regresión |
| 8. Pruebas integrales | Las 20 pruebas de aceptación del prompt | — |

---

## 7. Decisiones que necesito de Emilio

1. **Servicio central:** propongo una Sync API en Cloud Run con token por equipo. La alternativa es que el POS use el SDK cliente con reglas de Firestore (menos control y sin idempotencia en el servidor).
2. **¿Hay clientes usando hoy multisucursal por Tailscale?** Si los hay, se quedan en modo legado y se planea su paso al nuevo.
3. **e-CF sin Internet (R7):** firma local con el certificado en la sucursal, o solo firma central (sin Internet no sale e-CF y se usa el comprobante de contingencia que permita la norma).
4. **NCF:** que el dueño o el contador asignen desde el central un sub-rango exclusivo por sucursal (recomendado).
5. **¿Empezamos por la Fase 0?** R4 y R5 ya hicieron perder datos a un cliente real.

---

## 8. Pruebas base

`npm test` el 2026-10-18, sin ningún cambio: **80 suites, 601 pruebas, todas OK** (58 s). Es la línea base para comprobar que nada se rompe.
`npm run test:e2e-lan` (multicaja con MariaDB real) no se corrió en esta fase. Se corre en la Fase 6 y en cualquier cambio que toque la venta o el inventario.
