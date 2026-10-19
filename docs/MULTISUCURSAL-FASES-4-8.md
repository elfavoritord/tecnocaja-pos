# Multisucursal — Fases 4 a 8: catálogo, sincronización, usuarios, NCF y pruebas integrales

Fecha: 2026-10-19 · Rama: `fase-2-seguridad` · Antes: [Fase 3](MULTISUCURSAL-FASE-3.md) · Diagnóstico: [Fase 1](MULTISUCURSAL-DIAGNOSTICO.md)

## Resumen

Cada sucursal tiene su propia base (SQLite o MariaDB multicaja) y su PC principal se sincroniza por HTTPS saliente con la **Sync API** (Cloud Run). No hace falta VPN, Tailscale ni IP pública.

**La venta nunca espera a la nube.** Los cambios se detectan después en la base local y se suben en segundo plano. Si la PC se cierra, quedan en la bandeja de salida y se mandan al volver.

| Qué | Cómo |
|---|---|
| Catálogo de la empresa | Lo publica **solo la sucursal principal**: un producto puede ser solo de esa sucursal, de toda la empresa o de las sucursales que se elijan. Llega a cada sucursal con el precio de la principal como **sugerido**. |
| Precio y existencia | Son **de cada sucursal**. La central los registra para reportes, pero nunca los cambia, salvo con la acción explícita "Cambiar un precio en varias sucursales". |
| Ventas | Suben las de los últimos 90 días al enlazar y después todas. Son **inmutables**: si una vuelve a llegar, solo puede cambiar su estado (anulada, devuelta). |
| Usuarios | La principal los crea y elige en qué sucursales entran. Viaja solo la **huella scrypt** de la clave, nunca la clave. Gana la central: si la principal desactiva a alguien, se desactiva en todas. |
| NCF | Emilio o el contador reparten la autorización de la DGII en **sub-rangos por sucursal** que no se cruzan. Cada sucursal los usa con su sistema de secuencias de siempre. |
| e-CF | **Sin cambios** (riesgo R7, pendiente de decidir con el contador). |

## Reglas de conflicto (prompt maestro §7)

| Entidad | Regla | Dónde |
|---|---|---|
| Producto maestro (nombre, código, categoría, impuesto, unidad) | Gana la central. En una sucursal que no es la principal, `PUT /api/products/:id` conserva los datos maestros y la pantalla los muestra bloqueados | `catalogo-local.js` (`protegerMaestroProducto`) |
| Precio local | Gana la sucursal. La central solo lo cambia con un comando explícito de la principal | `sincronizacion-central.js` (`efectoComandoPrecio`) |
| Inventario | Cada sucursal es dueña de su existencia (sus ventas y compras son locales). La central guarda la foto más reciente por sucursal; un reintento viejo no pisa uno nuevo | `efectoProductoSucursal` (`marcaTiempo`) |
| Ventas confirmadas | Inmutables: solo cambia el estado; el resumen del día se ajusta una sola vez | `efectoVenta` |
| Usuarios/permisos | Gana la central | `efectoUsuario` + `aplicarUsuario` |
| Disponibilidad (activo/inactivo) | La sucursal decide, salvo que la central cambie el estado (desactivar un producto de la empresa lo desactiva en todas) | `products.catalogo_estado` |
| Mismo código o usuario local con otra identidad | **No se une solo**: queda como conflicto y el administrador pulsa "Vincular" o "Ignorar" | `sync_conflictos` |
| NCF | Un número asignado nunca se reasigna, ni siquiera si el rango se anula. Si la sucursal ya emitió un número de un rango que le llega, lo rechaza y avisa | `asignarRangoNcf`, `ncf-central.js` |

## Piezas

### En el POS (`server/multisucursal/`)

| Archivo | Qué hace |
|---|---|
| `server/migrations/multisucursal/0004-catalogo-y-sincronizacion.js` | Agrega columnas a `products`, `users` y `sales`, y crea tres tablas. Solo agrega columnas y tablas nuevas. La reversión se bloquea si hay rangos NCF asignados. |
| `sincronizacion.js` | Motor de ciclos, cada minuto o con "Sincronizar ahora": detectar → subir → bajar por cursor → NCF. Detalle abajo. |
| `catalogo-local.js` | Reglas que usan las rutas de productos y usuarios de `server.js` (una línea cada una): alcance en la empresa, datos maestros protegidos, no borrar un producto de la empresa, usuarios de la empresa solo se editan en la principal. |
| `ncf-central.js` | Aplica cada rango de la central sobre el sistema de secuencias que use la PC (`ncf_authorized_sequences` o `ncf_sequences`). Detalle abajo. |
| `server/routes/multisucursal.routes.js` | Rutas de `/api/multisucursal`: `indicador`, `sincronizacion`, `bitacora`, `sucursales-empresa`, `conflictos`, `rechazados/reintentar`, `catalogo/publicar` y `precio-sucursales`. |

Lo que agrega la migración `0004`:

- **`products`:** `alcance_empresa`, `sucursales_empresa`, `origen_catalogo`, `catalogo_version`, `catalogo_hash`, `catalogo_estado` y `sucursal_marca`.
- **`users`:** `sucursales_empresa`, `origen_usuario`, `usuario_version` y `usuario_hash`.
- **`sales`:** `sync_marca`.
- **Tablas nuevas:** `sync_conflictos`, `sync_bitacora` y `ncf_rangos_central`.

Detalle de `sincronizacion.js`:

- **Detectar.** Cada registro tiene una marca de lo último enviado, y el evento se anota en la misma transacción que esa marca. **No toca la ruta de la venta.**
- **Reintentos.** Usan una espera creciente. En cuanto la central responde, lo que falló solo por falta de red sale en ese mismo ciclo.
- **Bitácora.** Cada ciclo queda en `sync_bitacora`.

Detalle de `ncf-central.js`:

- Usa un rango por tipo. Cuando se agota, pasa al siguiente.
- Al activar el primer rango de la central, suspende las demás secuencias de ese tipo en esa base.

### En la central (`server/multisucursal/central/sincronizacion-central.js`)

Es la fuente única, igual que `sucursales.js`. Se copia a la Sync API y al portal del contador con su `vendor-sync`. Toda escritura va en transacción de Firestore. El cursor es un `seq` por empresa, que se serializa en `sync/contador`: una lectura por cursor nunca salta un cambio.

| Función | Para |
|---|---|
| `procesarEventos(ctx, eventos)` | Sync API `POST /v1/eventos`: idempotente por `event_id` (`eventos_recibidos`), uno por uno y en orden |
| `cambios(ctx, stream, desde, limite)` | Sync API `GET /v1/cambios`: `catalogo`, `usuarios`, `comandos` y `ncf`, en páginas y con el total pendiente para la barra de progreso |
| `asignarRangoNcf` / `anularRangoNcf` / `listarRangosNcf` | Paneles: Emilio y el contador de la empresa |
| `resumenOperacion` | Paneles: ventas de hoy, de ayer y de los últimos 30 días por sucursal |

El contexto (empresa, sucursal y si es la principal) sale **siempre del token del equipo**, nunca del evento.

### Sync API (`cloud/sync-api/`, Cloud Run)

Endpoints nuevos:

- `POST /v1/eventos`: hasta 200 eventos y 4 MB por llamada.
- `GET /v1/cambios`.
- `GET /v1/sucursales`.

Además:

- El latido trae los conflictos y el uso de los rangos NCF.
- Hay un límite de 120 peticiones por minuto por equipo.
- Cada llamada marca `ultimaSincronizacion` en el equipo, que es lo que alimenta la alerta de "más de 4 h" del panel.

### Pantallas

- **POS, Configuración → "Sucursal conectada a Tecno Caja"** (`js/multisucursal-enlace.js`). Muestra:
  - estado de la sincronización con indicador 🟢🟡🟠🔴 y barra de progreso al descargar;
  - cambios por subir, conflictos (Vincular/Ignorar), rechazos (Reintentar);
  - rangos NCF y bitácora.

  Solo en la principal: "Publicar todo el catálogo activo" y "Cambiar un precio en varias sucursales".
- **POS, barra superior** (`js/sync-monitor.js`). El badge de conexión dice cómo va la sincronización con las sucursales cuando lo local está bien. Lo local manda: servidor caído, contingencia o sin Internet.
- **Formulario de producto** (`js/productos.js`):
  - En la principal, elegir si es "Solo esta sucursal", "Toda la empresa" o "Sucursales elegidas".
  - En las demás sucursales, los datos maestros de un producto de la empresa salen bloqueados.
- **Formulario de usuario** (`js/clientes.js`). En la principal, "Sucursales de la empresa" donde puede entrar. En las demás, aviso de que se administra en la principal.
- **Panel de Emilio y portal del contador** (`js/sucursales-central-ui.js`). Muestran:
  - alerta de PC sin sincronizar hace más de 4 h y conflictos por revisar;
  - ventas por sucursal;
  - rangos NCF: asignar, anular y ver cuántos quedan.

## Pruebas (resultados reales)

| Prueba | Comando | Resultado |
|---|---|---|
| Reglas centrales contra el emulador | `npm run test:multisucursal-central` | **47/47**, incluidos los 9 nuevos de sincronización y los 13 del POS de punta a punta (varias PC SQLite + Sync API) |
| **Integral con dos POS reales** (server.js en SQLite, API HTTP real, ventas reales) + pantallas en Chrome | `npm run test:multisucursal-integral` | **40/40** |
| Pantallas de los paneles en Chrome | `probar-pantalla-sucursales.js` | **24/24** |
| MariaDB real: migraciones + ciclo de sincronización con `CONCAT` | `npm run test:multisucursal-mariadb` | **23/23** |
| Arranque SQLite (actualizar una base vieja, interruptor apagado) | `npm run test:multisucursal-sqlite` | **13/13** |
| Enlace de una PC de punta a punta | `npm run test:multisucursal-enlace` | **19/19** |
| Multicaja LAN con MariaDB (ventas a la vez, sin Internet, contingencia) | `npm run test:e2e-lan` | **44/44** |
| Respaldo de una sucursal enlazada (ida y vuelta `.tcbak`) | `npx jest tests/services/backup-core-multisucursal.test.js` | **1/1** |
| Regresión | `npm test` | 93 suites, **668 OK** (las 4 del emulador se omiten sin emulador) |

## Matriz de aceptación (prompt maestro §21)

| # | Prueba | Estado | Evidencia |
|---|---|---|---|
| 1 | Empresa y dos sucursales | ✅ | integral; emulador |
| 2 | Usuario asignado a una sola sucursal | ✅ | integral: Ana entra en Norte con su clave; en Sur no existe (emulador) |
| 3 | PC nueva carga solo su sucursal | ✅ | integral: cada PC se activa con su código y adopta su identidad |
| 4 | Producto global llega a las sucursales | ✅ | integral + emulador |
| 5 | Precio de A no cambia el de B | ✅ | integral (3300 en Norte, 3500 en la principal) |
| 6 | Venta en A no cambia el inventario de B | ✅ | integral: venta real por `POST /api/sales` |
| 7 | B sin conexión recibe lo nuevo al volver | ✅ | integral + emulador |
| 8 | Repetir la sincronización no duplica | ✅ | integral + emulador (cursores borrados y eventos reenviados) |
| 9 | Reiniciar con cambios pendientes | ✅ | integral: servidor de Norte reiniciado sin la central; su cola sube al volver |
| 10 | Tercera sucursal carga el catálogo | ✅ | emulador |
| 11 | Desactivar un producto conserva ventas | ✅ | emulador; integral: no se deja borrar un producto de la empresa |
| 12 | Aislamiento entre empresas | ✅ | emulador: una PC de otra empresa no ve nada y no puede elegir sucursales ajenas |
| 13 | Dos cajas en la misma sucursal | ✅ | `test:e2e-lan` (20 ventas a la vez, inventario exacto) |
| 14 | Sin Internet la LAN sigue | ✅ | `test:e2e-lan`; integral: sin la central se vende y el indicador lo dice |
| 15 | Caída del servidor local y contingencia | ✅ | `test:e2e-lan` (principal caída → contingencia → recuperación); ver `docs/LAN-OFFLINE-FIRST.md` |
| 16 | Respaldos y restauración | ⚠️ Parcial | El `.tcbak` ahora incluye las columnas nuevas, la bandeja sin confirmar, los cursores, los conflictos y los rangos NCF de la central, y vuelven al restaurar (`tests/services/backup-core-multisucursal.test.js`, ida y vuelta cifrada). Si se restaura un respaldo viejo, la sucursal vuelve a bajar por cursor lo que le falte (sin duplicar) y no reutiliza un NCF ya emitido. **La Fase 0 (R4, contraseña de restauración) sigue pendiente** |
| 17 | Controles de NCF y estados de e-CF | ✅ NCF · ⏸ e-CF | NCF: rangos sin choques, venta B02 real con número del rango, rango usado rechazado, agotado detectado. e-CF sin cambios (R7) |
| 18 | Sin conexiones entrantes ni Tailscale | ✅ | El POS solo llama a la Sync API por HTTPS saliente |
| 19 | Licencias y límites | ✅ | integral + emulador (`maxSucursales`) |
| 20 | Funciones existentes siguen | ✅ | `npm test`, `test:e2e-lan`, arranque SQLite |

## Cómo probarlo antes de publicar versiones

### 1. Pruebas automáticas (10-15 minutos)

```powershell
npm test
npm run test:multisucursal-central
npm run test:multisucursal-integral
npm run test:multisucursal-mariadb
npm run test:multisucursal-sqlite
npm run test:e2e-lan
```

Todas deben terminar sin "FALLA".

### 2. Laboratorio a mano (sin tocar Firebase real ni tus datos)

```powershell
npm run lab:multisucursal
# variantes:  $env:LAB_TRES='1'; npm run lab:multisucursal     (tres sucursales)
#             $env:LAB_RAPIDO='1'; npm run lab:multisucursal   (sucursales ya creadas y PC ya enlazadas)
```

Abre `http://127.0.0.1:3500` en Chrome. Ahí están:

- tu panel y el portal del contador;
- dos POS reales en `:3501` y `:3502` (`admin` / `1234`), cada uno con su base;
- un botón para **apagar o encender la central** (simula que se va Internet);
- la guía paso a paso de lo que hay que probar.

Todo se borra al cerrar.

### 3. Instalador en una PC de prueba con datos reales

1. Construye el instalador **sin publicarlo**: `npx electron-builder --win nsis -c.directories.output=F:\builds\prueba`. Antes revisa `git status`: se empaqueta el árbol de trabajo.
2. Instálalo en una PC de prueba (o una máquina virtual), **no** en una de cliente.
3. Restaura ahí una copia de un respaldo real (por ejemplo, el de un cliente grande). Comprueba que:
   - al arrancar se crea el respaldo `PRE-MIGRACION`;
   - entra normal;
   - vende, cobra e imprime;
   - Configuración → "Sucursal conectada a Tecno Caja" aparece sin enlazar.
4. Prueba real contra la Sync API de producción:
   1. Haz el asistente inicial con un negocio de prueba, por ejemplo "Prueba Multisucursal".
   2. En tu panel (`tecno-caja-admin`, `npm start`), abre esa empresa → Sucursales: límite 2, crea las dos y genera los códigos.
   3. Enlaza la PC de prueba (y otra, si tienes).
   4. Al terminar, desactiva las sucursales de prueba.

### 4. Publicar escalonado

- **Pre-release primero.** Publica la versión como *pre-release* en GitHub. El actualizador de los clientes ignora las pre-releases, así que nadie la recibe sola.
- **Clientes piloto.** Instálala a mano en uno o dos clientes y déjala correr unos días.
- **Release normal.** Cuando estés conforme, márcala como release normal y el actualizador la reparte.

## Despliegue

1. **Sync API.** Hay que volver a desplegarla con los endpoints nuevos (pasos en `cloud/sync-api/README.md`). Como solo agrega rutas, las PC ya enlazadas siguen funcionando.
2. **Versión nueva del POS.** Al arrancar corre la migración `ms-0004`, con respaldo previo verificado (`PRE-MIGRACION`). La sincronización empieza sola en las PC enlazadas. A las que no están enlazadas no les cambia nada: sin token no se hace ninguna llamada.
3. **Portal del contador.** Necesita una versión nueva para tener la sección de sucursales, los rangos NCF y las ventas.
4. **Al enlazar un cliente que ya tenía varias sucursales** (por ejemplo, por Tailscale):
   1. En la principal, "Publicar todo el catálogo activo".
   2. En cada sucursal, resolver los conflictos de código con "Vincular todos". Así cada producto local toma la identidad de la empresa y conserva su precio y su existencia.

## Reversión

| Qué | Cómo |
|---|---|
| Sincronización | **Interruptor por PC:** `TECNO_CAJA_SYNC_URL=off` apaga la sincronización y la PC vende igual. |
| Todo lo multisucursal | `TECNO_CAJA_MULTISUCURSAL_DESACTIVAR=1`. |
| Esquema | `node scripts/multisucursal/revertir-migraciones.js --confirmar`. Se niega si hay eventos sin confirmar o rangos NCF asignados. |
| Sync API | Volver a la revisión anterior en Cloud Run. |

## Costo

Cloud Run con mínimo 0 instancias, más Firestore.

**Uso por sucursal activa:**

- un latido cada 5 min;
- un ciclo por minuto: 4 lecturas de cambios, que no cuestan si no hubo cambios gracias al cursor;
- una escritura por venta o por cambio de precio o existencia.

**Estimación:** con 10 sucursales vendiendo 300 tickets al día cada una, son unas 100 000 escrituras al mes. Eso da menos de US$1 de Firestore y centavos de Cloud Run.

## Pendiente

- Transferencias de inventario entre sucursales con bases separadas: hoy solo existen en el modo legado de base compartida.
- Bajar los últimos 3 meses de ventas a una PC reinstalada: hoy se suben, pero no se bajan.
- Imágenes de producto en el catálogo de la empresa: hoy no viajan.
- e-CF por sucursal: decisión R7 con el contador.
- Fase 0: R4 (restaurar), R5 (arranque en blanco) y R6 (claves en texto plano en `users.password`). Los usuarios que llegan de la central ya traen solo la huella.
- R1: la llave de administrador de Firebase en los instaladores del POS y del portal. La sincronización nueva no la usa.
