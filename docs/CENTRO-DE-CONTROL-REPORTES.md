# Centro de Control — app de reportes (Tecno Reporte)

Auditoría de la app de reportes, arquitectura nueva y guía para ponerla en
producción. Fecha: 2026-10-05. Rama: `fase-2-seguridad`.

---

## 1. Resumen

La app de reportes (`reporte app/`, Flutter) pasa a ser un **Centro de Control**:
tablero para el teléfono con ventas de hoy/ayer/semana/mes comparadas con el mismo
tramo del período anterior, ganancia estimada (solo si hay costos), cuentas por
cobrar, inventario, cajas abiertas, e-CF/DGII, sincronización y alertas. Tiene
módulos de ventas, métodos de pago, inventario, clientes, cuentas por cobrar,
cajas (multicaja), sucursales, usuarios, fiscal, delivery y finanzas.

La idea central: **el POS calcula y la app solo muestra**. La PC principal arma
resúmenes con las mismas reglas de sus reportes (`/api/reports/advanced/*`) y los
publica en Firestore cuando hay Internet. El teléfono lee 1 documento por pantalla,
no miles de ventas.

**Actualización 2026-10-06 (pedido de Emilio):** se quitaron el tablero y los
reportes clásicos, el menú lateral (repetía todo), Notificaciones (vacía), Perfil
(sin uso) y Exportar PDF (leían colecciones viejas que, por el problema #1, están
vacías bajo la licencia). Respaldo: `backups/reporte-app-antes-limpieza-modulos-20261006_101354.zip`.
Se volvió a poner **crear y editar productos** (venía de la v1.1.23 que está en git,
`cb8905d6^`; la carpeta de trabajo era una copia más vieja que no lo tenía), ahora
sobre el catálogo que publica el POS (§3.4).

---

## 2. Auditoría: cómo estaba

### 2.1 Estructura

| Parte | Qué es |
|---|---|
| `reporte app/lib` | Flutter + Riverpod + go_router + Firebase Auth/Firestore. Proyecto Firebase `reporte-sistema-pos` (el mismo del POS). |
| Autenticación | Firebase Auth (correo/clave). El perfil vive en `users/{uid}` (`role`, `businessId`, `branchIds`, `allowedModules`), lo escribe el POS. |
| Datos | Casi todo leído directo de `businesses/{id}/{sales,products,customers,cashRegisters,cashClosings,receivables,expenses}` (escrito por `modules/firebase-reports-sync.js`). |
| HTTP al POS | Solo para Exportar PDF (`/api/reports/advanced/cuentas-pagar-cobrar`) y la sesión `/api/login/firebase-session`. `DashboardRepository` (HTTP) ya no se usaba. |

### 2.2 Funciones que existían

Tablero (ventas del período, ITBIS, ganancia, métodos fijos, tendencia, top 8),
Ventas, Ganancias, Inventario (lista completa en tiempo real), Caja, Cuentas por
pagar/cobrar, Gastos, Fiscal (ticket/fiscal), Clientes, Sucursales, Exportar PDF,
Configuración, Notificaciones (pantalla vacía).

### 2.3 Problemas encontrados

| # | Severidad | Problema | Qué se hizo |
|---|---|---|---|
| 1 | **Crítica** | El `businessId` de los datos y el de los usuarios no siempre coinciden. `firebase-reports-sync.getBusinessId` trata las licencias `pos_<hex>` como "legado" y escribe en `businesses/pos:tecno-caja-{nombre}`; `syncStaffToReportsApp` le pone al usuario el ID de licencia. Según cuál escribió último, la app lee un negocio vacío o uno compartido con negocios del mismo nombre. | Los datos viejos **sin tocar** (pendiente de tu visto bueno, ver memoria `firestore-multinegocio`). El Centro de Control, que es nuevo, se publica siempre bajo la **licencia** (`businesses/{licencia}`), el mismo ID que `syncStaffToReportsApp` pone a los usuarios: no se comparte con otros negocios y no depende de la sincronización vieja de ventas. Solo la lista de facturas y el historial de un cliente siguen leyendo `sales` (esas sí pueden estar en el otro ID). Propuesta en §8. |
| 2 | Alta | El tablero descargaba todas las ventas del mes con sus productos para sumar en el teléfono (miles de documentos en un negocio con movimiento). | Reemplazado por un documento ya sumado por el POS. |
| 3 | Alta | Métodos de pago: `normalizePaymentMethod` convertía en "efectivo" todo lo que no fuera efectivo/tarjeta/crédito/transferencia/mixto (USD, contra entrega, cualquiera nuevo). | El Centro de Control usa el código real del POS con el nombre de `payment_methods`. Las ventas sincronizadas llevan además `paymentMethodCode` (aditivo; las apps viejas lo ignoran). |
| 4 | Alta | Ganancia con costo 0 cuando el producto no tiene costo → ganancia inflada. | Ganancia solo sobre lo vendido con costo; se informa la cobertura y no se muestra si es < 50 %. |
| 5 | Media | `dailyReports` se arma con incrementos (se duplica si una venta se reenvía, no descuenta anulaciones) y las reglas no permiten leerlo. | No se usa. Nuevo `dailyStats` idempotente (se recalcula, no se incrementa). |
| 6 | Media | Fiscal solo distinguía ticket/fiscal: sin estados e-CF, NCF ni secuencias. | Módulo fiscal nuevo (solo lectura). |
| 7 | Media | `activeBusinessIdProvider` aceptaba cualquier negocio elegido. | Solo acepta los del perfil (las reglas ya lo exigían). |
| 8 | Media (POS) | `GET /api/reports/advanced/devoluciones` usaba la columna `sr.total_returned`, que no existe (es `returned_amount`): el reporte siempre fallaba. | Corregido. |
| 9 | Media (POS) | `POST /api/firebase-reports/bootstrap` dejaba pasar peticiones **sin sesión** (subida completa a Firestore). `GET /api/firebase-reports/status` devolvía el ID de licencia sin sesión. | Ambos piden sesión (bootstrap: administrador general). |
| 10 | Baja | Filtros de caja mostraban IDs; notificaciones vacías; textos de Configuración desactualizados. | Resueltos en la app nueva. |

### 2.4 Lo que el POS NO registra (y cómo se muestra sin inventar)

| Pedido | Realidad del POS | Cómo lo muestra la app |
|---|---|---|
| Vencimientos de cuentas por cobrar | No hay fecha de vencimiento en ventas a crédito. | Antigüedad desde la fecha de la factura (0-30, 31-60, 61-90, 90+). "Moroso" = deuda de más de 30 días. Se explica en pantalla. |
| Clientes nuevos | `clients` no tiene fecha de registro. | Clientes con su **primera compra** en el período. |
| Desglose de pago mixto | Se guarda solo el total de la venta mixta. | Una línea "Mixto" con nota. |
| Precio mayorista / ventas al por mayor | No existe en el POS de escritorio. | Se dice en Inventario. Si se agrega al POS, se suma al publicador. |
| Tarjeta Gubernamental / Subsidio | No existen; además `POST /api/sales` solo acepta `efectivo, tarjeta, transferencia, mixto, credito, contra_entrega, usd`, aunque `payment_methods` permite crear otros. | La app ya muestra cualquier código que llegue, con su nombre configurado. Para usarlos de verdad hay que abrir esa lista en el POS (decisión tuya). |

### 2.5 Datos del POS que la app no mostraba

Estados e-CF (aceptado, rechazado, pendiente, error), secuencias NCF por agotarse o
vencidas, devoluciones y anulaciones (y quién las hizo), cobros de crédito y
abonos, turno abierto de cada caja con efectivo esperado y movimientos, cierres con
diferencia, cajas abiertas desde ayer, delivery (estados, repartidores, cobros
contra entrega pendientes), señal de cada PC y ventas en contingencia, e-CF
firmados sin Internet, gastos del registro fiscal, ventas guardadas sin cobrar,
rotación e inventario por sucursal.

---

## 3. Arquitectura nueva

```
PC principal (MariaDB)                         Firestore (reporte-sistema-pos)
┌────────────────────────────────┐   Internet   businesses/{negocio}/
│ server/sync/control-center/    │ ───────────▶  controlCenter/summary[_bN]   tablero
│  queries.js   (solo SELECT)    │  solo si hay   controlCenter/sales[_bN]     ventas
│  facts.js     (días sumables)  │  conexión      controlCenter/inventory[_bN]
│  state.js     (inventario,     │                controlCenter/cash[_bN]
│               caja, CxC, e-CF) │                controlCenter/customers[_bN]
│  alerts.js                     │                controlCenter/fiscal[_bN]
│  publisher.js (cuándo/qué sube)│                controlCenter/delivery[_bN]
└────────────────────────────────┘                controlCenter/catalog[_bN]  índice + categorías
                                                  controlCenter/catalog_p{n}[_bN] productos (400 c/u)
                                                  dailyStats/{día}[_bN]     rangos libres
Cajas terminal ──── señal de vida ───────────▶   terminals/{serverId}
                                                        │
                                          app (teléfono) ◀┘ lee 1 documento por pantalla
```

`_bN` = documento de la sucursal N (solo si el negocio tiene más de una sucursal).

### 3.1 Cuándo publica el POS

- Arranca 45 s después de iniciar el servidor (solo en la PC principal; las cajas
  terminal solo mandan su señal de vida).
- Después de una venta, apertura/cierre de caja, gasto o compra: los mismos
  disparadores del Portal del Contador (`syncPosStatsToFirestore`). Espera 30 s y
  deja al menos 90 s entre publicaciones (una ráfaga de ventas = una publicación).
- Corrida "rápida": recalcula solo HOY y reutiliza los días anteriores. Corrida
  completa cada 15 min (y al cambiar el día): recalcula la ventana de 35 días.
- Solo escribe un documento si cambió (huella SHA-1). El resumen se reescribe al
  menos cada 10 min para que la app sepa que el POS está vivo.
- Sin Internet no intenta nada; publica en cuanto vuelve. **Nunca toca la venta.**
- Histórico: la primera vez sube `dailyStats` de 400 días (por bloques de un mes,
  con pausas, solo días con movimiento). Queda marcado en `controlCenter/meta`.
- Interruptor: `TECNO_CAJA_CONTROL_CENTER=0` en el `.env` lo apaga.

### 3.2 Reglas de negocio (iguales a los reportes del POS)

- Venta válida: `fiscal_status <> 'cancelada'` y `sale_status = 'pagada'`.
- Sucursal/caja/usuario: `billed_*` con respaldo en los campos viejos.
- Ganancia: `line_total − qty × precio_compra`, solo líneas con costo; el
  descuento de la factura se reparte en proporción. Se publica la cobertura.
- Gastos: registro de Gastos (`expenses`, no anulados) + egresos de caja tipo
  "Gasto". Pago a suplidor, retiros y devoluciones se muestran aparte (no son gasto).
- e-CF: `ecf_documents` sin los de certificación (`certification_case_key`).
- Inventario: por sucursal desde `inventory_by_branch` cuando el negocio tiene
  varias sucursales (no se mezclan existencias); si no, `products.stock`.
- Cajas y sucursales: siempre las que estén configuradas (nada fijo).

### 3.3 La app

- `lib/data/control_center/`: modelos con lectura defensiva y repositorio (solo lectura).
- `lib/features/control_center/providers/cc_providers.dart`: filtros globales
  (período, rango libre de hasta 92 días, sucursal, y un filtro secundario a la vez:
  caja, usuario, método de pago o categoría), acceso por rol y alertas.
- Pantallas: Inicio, Ventas, Inventario (con la lista completa de productos),
  Alertas, Más (barra inferior; no hay menú lateral) y los módulos Clientes,
  Cuentas por cobrar, Cajas, Sucursales, Usuarios y cajeros, Fiscal, Delivery,
  Finanzas, Sincronización. Métodos de pago se abre desde Ventas e Inicio.
- Sucursales: lista **todas** las del POS (también con una sola o sin ventas), con
  sus cajas e inventario; con varias, la comparación. Acceso también desde Inicio.
- Diseño: tokens y tipografía (Barlow) del rediseño del POS, tema noche/día,
  montos en peso 600 con cifras tabulares (ver memoria del punto decimal).
- Si el POS todavía no publica, Inicio lo dice ("Esperando los datos del POS").
  Supervisores y otros roles ven un aviso de que el Centro de Control es para el
  dueño y los administradores (ya no hay tablero clásico al que volver).

### 3.4 Productos: lista, crear y editar

- El POS publica el catálogo completo en `controlCenter/catalog` (cantidad, páginas,
  **categorías del POS** y unidades) y `catalog_p{n}` (400 productos por página,
  ordenados por ID: una venta solo reescribe la página del producto vendido). Va en
  cada publicación con la misma huella SHA-1. La foto solo viaja si es una URL corta
  (las guardadas en base64 no). Si la consulta de productos falla, no se publica
  (no se pisa el catálogo bueno con uno vacío).
- Existencia: la de la sucursal en `catalog_p{n}_bN`; en el general, la suma de
  sucursales y el detalle `stockByBranch`.
- La app escribe en `businesses/{licencia}/products/{doc}` con `origen: app_reporte`
  y `syncStatus: pending` (lo permiten las reglas a dueño y administradores):
  - Nuevo: `app-{código}-{hora}`, con existencia inicial.
  - Editar: `pos-{id}` con `posProductId`, **sin existencia** (se ajusta en el POS
    para que quede en el kardex) y conservando el código interno del POS.
- El POS (`syncPendingReportAppProducts`, cada minuto) ahora lee también lo
  pendiente de `businesses/{licencia}` (solo `app_reporte`; tras 3 errores deja de
  reintentar hasta que lo vuelvan a guardar). Busca primero por `posProductId`;
  si no viene existencia y el producto existe, no la toca; conserva el ID remoto
  que usan las ventas de la app móvil. Al recibir algo, avisa al Centro de Control
  para que la lista se actualice en ~1 minuto.
- Antes de guardar, la app revisa en el catálogo: código repetido (no deja guardar)
  y nombre parecido (pregunta). Solo deja elegir categorías que existen en el POS.
- Foto: Firebase Storage `businesses/{licencia}/products/{doc}.jpg` (reglas en
  `storage.rules`). Lector de código con la cámara (`mobile_scanner`).

---

## 4. Seguridad

- Firestore (`firestore.rules`): `controlCenter` y `dailyStats` solo los leen el
  dueño/administrador del negocio, o un administrador de sucursal si el documento
  solo contiene sus sucursales (campo `branchIds` del documento ⊆ `branchIds` del
  usuario). `terminals`: administradores. Nadie escribe desde la app (solo el Admin
  SDK del POS).
- La app solo pide el negocio del perfil y fija al administrador de sucursal en sus
  sucursales.
- Lo publicado no incluye contraseñas, logos ni datos de tarjeta; sí nombres de
  clientes con deuda y su teléfono (ya estaban en `customers`).

---

## 5. Rendimiento y costo

- App: Inicio = 1 documento (≈ 10-20 KB) en tiempo real. Rango libre = 1 lectura por
  día (máx. 92 + el período anterior para comparar).
- POS: consultas agrupadas con los índices de `created_at`; la corrida rápida solo
  lee el día de hoy. Probado con MariaDB 12 real.
- Escrituras: un negocio de una sucursal con ventas constantes escribe ~5-10
  documentos por publicación, máximo una cada 90 s en hora pico.

---

## 6. Puesta en producción (en este orden)

1. **Reglas e índices de Firestore** (proyecto `reporte-sistema-pos`):
   `firebase deploy --only firestore:rules,firestore:indexes`
   **Hecho el 2026-10-05.** Antes se comprobó que las reglas publicadas eran
   idénticas a las del repositorio (sin cambios hechos desde la consola).
2. **Versión del POS** con `server/sync/control-center` (la próxima, p. ej. 1.4.3).
   Al actualizar, la PC principal empieza a publicar sola.
3. **App de reportes 1.1.0** (`flutter build apk` / web). Dependencias nuevas:
   `flutter_localizations` (calendario en español), `image_picker` y
   `mobile_scanner` (productos); `intl` pasa a 0.20.2. Permiso de cámara en
   `AndroidManifest.xml` y textos de cámara/fotos en `ios/Runner/Info.plist`.
   Para la foto del producto hay que tener publicadas las reglas de `storage.rules`.
4. Respaldo de la app anterior: `backups/reporte-app-antes-centro-control-20261005_111843.zip`
   (la carpeta `reporte app/` no está en git).

---

## 7. Pruebas hechas

- `tests/sync/control-center.test.js` (29): consultas reales en SQLite con un
  negocio de 2 sucursales y 3 cajas, publicador con Firestore falso, sin Internet,
  caja terminal, negocio sin licencia, catálogo de productos (páginas, existencia
  por sucursal, base vieja sin columnas, consulta fallida que no pisa el catálogo).
- App (2026-10-06): 42 pruebas, incluidas lista de productos, buscador, pendientes,
  editar sin tocar existencia, código repetido, sucursales (una y varias) y "Más"
  sin módulos repetidos.
- Validación contra **MariaDB 12** del instalador (esquema real `db/schema.sql`),
  también con columnas/tablas viejas que faltan (se omite la sección, no falla).
- App: `flutter analyze` sin avisos; 30 pruebas (`test/control_center/`): contrato
  POS → app con los JSON que genera el propio POS
  (`node scripts/control-center/export-app-fixtures.js`) y pantallas principales.
- Reglas de Firestore en el emulador local: 23/23 casos (dueño, admin de
  sucursal, supervisor, otro negocio, sin sesión, escrituras)
  — `scripts/control-center/check-firestore-rules.js`.
- `npm test` completo (427) y `npm run test:e2e-lan` (41/41, multicaja con
  MariaDB real; el publicador arranca y se apaga solo sin Firebase).

---

## 8. Pendiente de decisión

1. **Identidad del negocio en Firestore** (problema #1). Propuesta: que
   `firebase-reports-sync.getBusinessId` use siempre la licencia (`pos_<hex>`) igual
   que los usuarios, y volver a subir los datos desde cada POS (bootstrap + histórico
   del Centro de Control, que se rehace solo). No conviene "migrar" lo que hay en
   `pos:tecno-caja-{nombre}` porque puede tener datos mezclados de negocios con el
   mismo nombre. Cambia el lugar de los datos de todos los clientes: hacerlo con una
   versión del POS y la app al mismo tiempo.
2. ¿Abrir `POST /api/sales` a los métodos de `payment_methods` (para Tarjeta de
   Subsidio, etc.)? Toca la venta y el cuadre de caja; requiere la prueba LAN.
3. ¿Guardar el desglose del pago mixto y una fecha de vencimiento en el crédito?
   Mejoraría Métodos de pago y Cuentas por cobrar.

---

## 9. Otras funciones del POS que podrían entrar después

- Cuentas por pagar a suplidores (`supplier_invoices`) en Finanzas.
- Compras del período y ITBIS a pagar (crédito fiscal), ya calculado en `/dgii`.
- Ventas en dólares y tipo de cambio del turno.
- Ahorro por promociones (`ahorro_promociones`) y promociones activas.
- Transferencias entre sucursales (`branch_transfers`).
- Empresas de servicios (`svc_*`): facturado, cobrado y cotizaciones abiertas
  (el Portal del Contador ya los calcula en `sync-pos-stats.js`).
- Notificaciones push (FCM) para alertas críticas (e-CF rechazado, diferencia de caja).
