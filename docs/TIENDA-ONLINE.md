# Tienda Online de Tecno Caja

Módulo **opcional**: cada negocio puede tener su propia tienda en Internet con los
productos de Tecno Caja. Se activa en **Configuración → Mi Negocio → Tienda online**.

Regla de diseño: la tienda es **otro canal de pedidos**, no un sistema aparte.

```
TIENDA (nube) → PEDIDO → TECNO CAJA POS → revisión → cobro normal (POST /api/sales)
             → inventario → caja → NCF/e-CF → impresión → delivery → estado del pedido
```

No hay segundo inventario, ni segunda facturación, ni segundo catálogo, ni otro
sistema de clientes. La nube nunca factura ni toca la base del POS.

---

## 1. Arquitectura que ya existía (y que se reutiliza)

| Pieza | Dónde | Cómo la usa la tienda |
|---|---|---|
| Productos, categorías, precios, ITBIS (`aplica_itbis`, `itbis_modo`, `itbis_monto`), descuento %, existencia por sucursal (`inventory_by_branch`) | `products`, `inventory_by_branch` | Es la fuente del catálogo publicado. Solo se agregaron columnas `online_*`. |
| Motor de promociones | `server/services/promotion-engine.js` | La nube usa **la misma función** (`buildActiveMapFromRows` + `pickWinningPromotion`) para el precio del pedido. |
| Cálculo del carrito | `js/ventas.js` (`calculateSaleItem*`) | `server/tienda-online/calculo-pedido.js` usa las mismas fórmulas. |
| Venta, caja, inventario, NCF, e-CF, delivery, recibo | `POST /api/sales` | El pedido se cobra **con el flujo normal de Ventas**: se carga en el carrito y el cajero cobra. |
| Idempotencia de la venta | `clientRequestId` (`server/sales/sale-idempotency.js`) | Sin cambios; además el pedido se liga a la venta dentro de la misma transacción. |
| Lock de `config` + `withTransactionRetry` (multicaja) | `POST /api/sales` | La toma del pedido corre dentro de esa transacción: dos cajas no pueden cobrar el mismo pedido. |
| Clientes | `clients` | Al cobrar se busca el cliente por teléfono/correo o se crea (`sync_origin = 'tienda_online'`). |
| Delivery y app de repartidores | `sales.order_type = 'delivery'`, `pedidos_delivery` | Pedido con delivery → venta delivery normal (repartidor, contra entrega, mapa). El estado de entrega de la venta mueve el pedido a "en camino"/"entregado". |
| Firestore multinegocio por licencia | `businesses/{licencia}` | Todo lo de la tienda vive ahí (el formateo lo borra). Ver memoria *firestore-multinegocio*. |
| Patrón del Centro de Control | `server/sync/control-center/` | Mismo patrón: la PC principal publica en segundo plano, solo con Internet, solo lo que cambió. |
| Cloud Run en `reporte-sistema-pos` (us-east1) | `cloud/ecf-gateway/` | El servicio `cloud/tienda-online/` sigue el mismo esquema (vendor-sync, Dockerfile, store en memoria para pruebas). |
| Bot de WhatsApp | `server/integrations/whatsapp-bot.js` | Solo para **avisos** (al dueño y al cliente), nunca como entrada de pedidos. |
| Reportes avanzados | `/api/reports/advanced/*` | Filtro nuevo **Origen de venta: POS / Tienda online** (`sales.sync_origin`). |

## 2. Qué se agregó

### POS (`server/tienda-online/`)

| Archivo | Qué hace |
|---|---|
| `contrato.js` | Rutas de Firestore, estados, métodos de pago, mensajes al cliente. Compartido con la nube. |
| `calculo-pedido.js` | Totales del pedido (precio, promoción, descuento, ITBIS, delivery). Compartido con la nube. |
| `schema.js` | Tablas y columnas (dialecto SQLite; db.js lo traduce a MariaDB). |
| `settings.js` | Configuración de la tienda (validada y normalizada). |
| `catalog.js` | Arma el perfil, catálogo y existencia que se publican. |
| `nube.js` | Lecturas/escrituras en Firestore (transacciones de reserva). |
| `publisher.js` | Publica perfil, catálogo, imágenes (webp liviano) y existencia. |
| `orders.js` | Pedidos en el POS: recibir, estados, preparar el cobro, ligar a la venta. |
| `orders-sync.js` | Nube ⇄ POS: recibe pedidos y sube estados. |
| `notifier.js` | Avisos por canal (página de seguimiento, WhatsApp; correo/SMS listos para agregarse). |
| `index.js` | Factory con dependencias inyectadas; hooks para `server.js`. |

Rutas: `server/routes/tienda-online.routes.js` en `/api/tienda-online`.
Pantalla: `js/tienda-online.js` + `css/tienda-online.css`.

### Nube (`cloud/tienda-online/`)

Servicio Express para Cloud Run: la tienda que ve el cliente (`/t/{tienda}`),
el seguimiento (`/t/{tienda}/pedido/{id}?k=…`) y la API pública.

Página del cliente (`public/`, HTML/CSS/JS sin librerías; la CSP no deja
scripts en línea, por eso `tema.js` va aparte): encabezado fijo con búsqueda,
tema claro/oscuro, favoritos y carrito con contador; barra de filtros por
categoría, precio mín–máx y orden (menor/mayor precio, mejores ofertas, más
nuevos); grid de 3 columnas en todo tamaño dentro de una caja de 600 px con
scroll; al tocar una tarjeta se abre el **detalle** (modal: imagen grande,
precio, descripción, especificaciones sacadas de los datos del POS, selector de
cantidad 1–99 —o la existencia— y 3 productos similares de la misma categoría
que se pueden recorrer sin cerrar; el botón "atrás" del teléfono lo cierra);
carrito/favoritos/checkout en panel lateral que se desliza desde la derecha;
avisos de 3 s abajo a la derecha. El color principal es el que elige el negocio
(por defecto `#10b981`). El "-15%" sale de la oferta del POS (`precioAntes`) y
del descuento % del producto (`descuentoPct`, mismo cálculo que
`calculo-pedido.js`). No se muestran estrellas ni reseñas: el POS no tiene esos
datos y no se inventan. Carrito, favoritos y tema se guardan en el teléfono
(localStorage).

**Como app (v5):** grid de 4 columnas en computadora, 3 en tableta y 2 en
teléfono (en el teléfono la lista baja con la página, sin la caja de 600 px).
En el teléfono hay barra de abajo: Inicio · Favoritos · Carrito (botón central)
· Ofertas (solo productos con descuento) · Pedidos. "Mis pedidos" lista los
pedidos hechos desde ese equipo (`localStorage tc-pedidos-{slug}`) con su estado.
El carrito son tarjetas con foto, basura, cantidad y precio; a pantalla completa
en el teléfono. La página se sirve con el nombre de la tienda, favicon y
`manifest.webmanifest` por tienda (`/t/{slug}/manifest.webmanifest`,
`/t/{slug}/iconos/{32|64|180|192|512|512-m}.png`, hechos con `sharp` a partir
del logo publicado; sin logo, un carrito sobre el color de la tienda): el
cliente puede "Agregar a pantalla de inicio" y queda como app con el logo.

**Velocidad (caché):** el catálogo y los JSON grandes van comprimidos (gzip);
app.js/styles.css se comprimen una vez y, como index.html los pide con
`?v=N`, el navegador los guarda un año (subir N al cambiarlos). La página
guarda el último catálogo en el teléfono (`tc-catalogo-{slug}`): la segunda
visita muestra los productos al instante y luego se pone al día. Un service
worker (`/sw.js`) guarda la página, los archivos, los íconos y las fotos
(versionadas): abre rápido y, sin señal, muestra lo último ("Sin conexión:
viendo la última versión guardada"). Precios, existencia y pedidos siempre
se consultan al servidor (cotizar/pedir nunca usan datos guardados).

**Fotos (hasta 6 por producto):** la principal es la foto del producto en el
POS; en la ficha del producto → pestaña *Tienda online* se agregan hasta 5 más
(se achican en el equipo, el servidor las deja en webp 900 px y el publicador en
480 px). En el detalle se ven en un **carrusel** de 300 px: avanza solo cada
6 s, flechas (se ocultan en teléfonos), puntos, deslizar con el dedo o arrastrar
con el mouse; si el cliente lo toca se detiene y sigue 5 s después; con
"reducir movimiento" no avanza solo. Las fotos se muestran a su tamaño real
(se achican si no caben, nunca se estiran ni se recortan). Si una foto no carga
(aún no publicada) se usa el emoji o se quita del carrusel.

### Cambios en archivos existentes (mínimos)

- `server.js`
  - crea la instancia y monta `/api/tienda-online` (después del middleware de sesión);
  - `POST /api/sales`: si llega `onlineOrderId`, dentro de la transacción
    `claimForSaleInTx` liga el pedido (o falla con 409 `YA_CONVERTIDO` y se
    deshace todo) y `agreedPricesInTx` aplica el **precio del pedido**, leído de
    la base local (nunca del navegador);
  - anular factura: el pedido queda libre para cobrarse otra vez;
  - estado de entrega de la venta → estado del pedido;
  - ventas suspendidas guardan el pedido (al recuperarlas se vuelve a ligar);
  - `mapProductRow` trae `online`; el error JSON incluye `code`;
  - reportes avanzados: `appendSaleOriginFilter` (`?origen=pos|tienda_online`).
- `server/services/promotion-engine.js`: la parte pura se separó en
  `buildActiveMapFromRows` / `isActiveOnDate` (mismo resultado que antes).
- `js/ventas.js`: `activeOnlineOrder` (banner "Cobrando el pedido online #…",
  `onlineOrderId` en el cobro, precio pactado al cambiar cantidades, bloqueo en
  contingencia, aviso si otra caja ya lo cobró).
- `js/cobro.js`: `markResume()` para que el cobro conserve cliente, entrega,
  método y comprobante del pedido.
- `js/productos.js`: pestaña **Tienda online** en la ficha del producto.
- `js/app.js`, `js/shell.js`, `js/business-config.js`, `index.html`: menú
  **Pedidos online**, sección en Mi Negocio, filtro de origen en Reportes.
- `server/integrations/whatsapp-bot.js`: `sendTextMessage` y `notifyOwners`.
- `modules/firebase-admin.js`: el formateo también borra el nombre de la tienda (`tienda_slugs`).
- `firestore.rules`: reglas explícitas (los navegadores nunca tocan Firestore).

## 3. Tablas y campos

```
products.online_enabled       publicar en la tienda (☑ Publicar en tienda online)
products.online_description   descripción para la tienda
products.online_featured      destacado
products.online_order         orden
products.online_stock_mode    'inventario' | 'ilimitado'
products.online_images        JSON con hasta 5 fotos extra para la tienda (rutas locales)
sales.online_order_id         de qué pedido salió la venta (+ sales.sync_origin = 'tienda_online')
clients.sync_origin           'tienda_online' si el cliente se creó al cobrar un pedido

online_store_settings         1 fila: activa, dirección (slug), sucursal, configuración JSON, banner
online_orders                 el pedido tal como lo hizo el cliente (cloud_id ÚNICO, sale_id, estado,
                              bloqueo "en proceso", cola de envío a la nube con change_seq)
online_order_items            líneas con el PRECIO USADO en el pedido (no cambia si cambia el producto)
online_order_events           historial (estados, venta, notas)
online_order_notifications    avisos al cliente por canal (pendiente / enviado / fallido)
```

Firestore (todo bajo la licencia, salvo el nombre público):

```
tienda_slugs/{slug}                          { licenseId }
businesses/{lic}/tiendaOnline/perfil         datos públicos
businesses/{lic}/tiendaOnline/catalogo(_pN)  productos publicados (300 por página)
businesses/{lic}/tiendaOnline/stock          items.pID.s (existencia que publica el POS)
                                             items.pID.r (reservado por pedidos abiertos)
                                             contador (número de pedido)
businesses/{lic}/tiendaImagenes/{clave}      webp en base64 (no hace falta Firebase Storage);
                                             p{id} = foto principal, p{id}_1 … p{id}_5 = fotos extra
businesses/{lic}/pedidosOnline/{id}          pedidos
businesses/{lic}/pedidosOnlineClaves/{hash}  idempotencia del checkout
```

## 4. APIs

POS (`/api/tienda-online`, con sesión):

| Método | Ruta | Quién |
|---|---|---|
| GET | `/estado` | cualquiera |
| GET/PUT | `/config` · POST/DELETE/GET `/config/banner` · POST `/publicar` | administrador |
| GET | `/productos` · GET/PUT `/productos/:id` · POST `/productos/masivo` | administrador / catálogo |
| POST/DELETE | `/productos/:id/fotos` · `/productos/:id/fotos/:n` · POST `/productos/:id/fotos/:n/mover` (fotos extra, `server/tienda-online/fotos.js`) | administrador / catálogo |
| GET | `/pedidos` · `/pedidos/resumen` · `/pedidos/:id` | cualquiera (su sucursal) |
| POST | `/pedidos/:id/estado` · `/pedidos/:id/preparar-venta` · `/pedidos/:id/liberar` | cualquiera (su sucursal) |
| POST | `/sincronizar` · GET `/reportes` | cualquiera |

Nube (pública):

| Método | Ruta |
|---|---|
| GET | `/t/:slug`, `/t/:slug/pedido/:id` (páginas) |
| GET | `/api/tiendas/:slug` (catálogo público, sin costos) |
| GET | `/api/tiendas/:slug/img/:clave` |
| POST | `/api/tiendas/:slug/cotizar` (totales del carrito, sin guardar) |
| POST | `/api/tiendas/:slug/pedidos` (crea el pedido) |
| GET | `/api/tiendas/:slug/pedidos/:id?k=token` (seguimiento) |

## 5. Flujo y sincronización

1. **Publicar** (PC principal; solo lo que cambió; sin Internet no hace nada):
   - a los ~3 s de cualquier cambio hecho por las rutas del POS (productos,
     fotos, precios, existencia, compras, traspasos, ofertas, categorías,
     configuración/logo): `tienda.vigilarCambiosCatalogo()` en server.js →
     `publisher.notifyCatalogChange()` (varios cambios seguidos = una publicación);
   - cada 30 s la existencia y una huella liviana del catálogo
     (`catalogBuilder.buildStock().huella`): si otra caja cambió un producto o
     el logo, publica el catálogo completo en ese ciclo;
   - el catálogo completo, de todas formas, cada 5 min, al guardar la
     configuración o con "Publicar ahora".
   En la nube el catálogo se guarda 15 s por instancia; la página abierta se
   pone al día sola cada 45 s.
2. **Pedido** (nube): valida datos, recalcula todo con el catálogo publicado y,
   en **una transacción**, revisa `s − r` de cada producto, suma la reserva,
   toma el número de pedido y guarda el pedido y su clave de idempotencia.
3. **Recepción** (PC principal): escucha en tiempo real `pos.importado == false`
   y además revisa cada minuto. Guarda con `INSERT OR IGNORE` por `cloud_id` y
   después marca importado → una reconexión o reintento nunca duplica.
   Aviso en pantalla + sonido en todas las cajas (Socket.IO y, para cajas con su
   propio servidor, un vigilante de la base cada 8 s) y, si se activa, WhatsApp al dueño.
   Al llegar, el **cliente queda en Clientes** (`orders.vincularCliente`: se busca
   por WhatsApp/teléfono o correo y, si no está, se crea con `sync_origin =
   'tienda_online'`; evento `tienda-online:cliente` para las pantallas). Los
   pedidos que llegaron antes se ligan una vez al arrancar la PC principal.
4. **Revisión**: Aceptar / Rechazar / En preparación / Listo / En camino /
   Entregado / Cancelado (con reglas: "en camino" y "entregado" exigen la venta;
   cancelar con venta exige anular la factura).
5. **Convertir en venta**: el POS revisa productos, existencia, precio, cliente,
   pago y comprobante, crea o encuentra el cliente, marca el pedido "en proceso"
   y lo **carga en el carrito de Ventas**. El cajero cobra como siempre (ticket,
   B01/B02, e-CF, contra entrega, repartidor…). En `POST /api/sales` el pedido
   se liga a la venta en la misma transacción. Al terminar el cobro, Ventas
   **envía la factura (imagen) por WhatsApp** al número del pedido con el Bot de
   WhatsApp del POS (`sendReceiptToWhatsAppBotAuto`, mismo envío que las
   cotizaciones del bot; reintenta si el bot está reconectando y, si está
   apagado, avisa una vez por sesión). Las ventas a "cola de cobro" no se envían.
6. **De vuelta a la nube**: estado, historial, mensajes al cliente y factura. Al
   facturar (o cancelar) se libera la reserva y se sube la existencia nueva en
   la misma transacción, una sola vez aunque se reintente.

## 6. Riesgos cubiertos

| Riesgo | Protección |
|---|---|
| Precio/total manipulado en el navegador | La nube recalcula todo; el POS cobra con el precio del pedido leído de su base. |
| Dos clientes por la última unidad | Reserva dentro de una transacción de Firestore. |
| Doble clic / reintento en el checkout | Clave de idempotencia → mismo pedido. |
| Pedido duplicado al reconectar | `cloud_id` ÚNICO + marcar importado después de guardar. |
| Dos cajas cobran el mismo pedido | `UPDATE … WHERE sale_id IS NULL` dentro de la transacción de la venta (lock de fila; en MariaDB 12 además el 1020 se reintenta) → la segunda falla con 409 y se deshace completa. |
| Cobro en contingencia (principal caída) | Bloqueado en pantalla: la venta de contingencia no puede ligarse al pedido. |
| Venta suspendida de un pedido | El borrador guarda el pedido y al recuperarla se vuelve a ligar. |
| Ver pedidos de otro negocio | Todo bajo `businesses/{licencia}`; seguimiento con token; reglas de Firestore cerradas. |
| Bots / abuso | Límite por IP, campo trampa, tamaño máximo del cuerpo, CSP estricta. |
| Reserva que queda pegada | Se recalcula en cada publicación completa (`reconcileReservations`). |
| Internet caído | El POS vende normal; la tienda sigue mostrando la última publicación; todo se pone al día al volver. |

**Política de inventario:** el pedido recibido NO descuenta el inventario del
POS; se descuenta al cobrarlo (venta normal). La reserva solo protege a la
tienda (dos clientes en línea). Queda lista la opción
`settings.inventario.reservarAlRecibir` para que, más adelante, el mostrador
también respete lo reservado.

**Multisucursal:** la tienda despacha desde UNA sucursal (Configurar tienda →
Sucursal que despacha); su inventario es el que se publica. Si se cobra en otra
sucursal, el POS avisa y descuenta el inventario de la sucursal de la caja.
Una tienda por sucursal queda para una fase siguiente (el contrato ya guarda
`sucursalId` en el nombre público).

## 7. Activación y despliegue

1. En el POS: Configuración → Mi Negocio → **Tienda online** → Configurar
   tienda (dirección, pagos, entrega, horario) → Guardar y activar.
2. Marcar productos en **Pedidos online → Productos publicados** (o en la ficha
   del producto, pestaña Tienda online).
3. **Una sola vez**, publicar el servicio y las reglas (requiere `gcloud` y
   `firebase` con la cuenta de Emilio):

```bash
cd cloud/tienda-online
npm install
npm run vendor-sync
gcloud run deploy tecno-caja-tienda --source . --region us-east1 \
  --allow-unauthenticated \
  --update-env-vars FIRESTORE_PROJECT_ID=reporte-sistema-pos,TZ=America/Santo_Domingo
# reglas (desde la raíz del repo)
firebase deploy --only firestore:rules
```

La cuenta de servicio de Cloud Run necesita `roles/datastore.user` (la misma
que ya usa el gateway e-CF). La URL esperada es
`https://tecno-caja-tienda-1052855422372.us-east1.run.app`; si sale otra (o se
usa un dominio propio), ponerla en `TECNO_CAJA_TIENDA_URL` o cambiar
`DEFAULT_PUBLIC_BASE_URL` en `server/tienda-online/index.js`.

Interruptor de emergencia en un cliente: `TECNO_CAJA_TIENDA_ONLINE=0`.

## 8. Pruebas

Automáticas:

```bash
npx jest tests/tienda-online                     # POS + nube de punta a punta (sin red)
cd cloud/tienda-online && npm test               # servicio de la nube
```

Cubren: publicación (solo activos y marcados, sin costos), precio del servidor,
agotados, dos clientes por la última unidad, idempotencia del checkout,
recepción sin duplicados, reglas de estados, bloqueo "en proceso", precio del
pedido respetado, una sola venta con dos cajas a la vez, reserva liberada una
vez, anulación de factura, cancelación, recálculo de reservas, reportes,
tienda desactivada, horario de RD y cálculo de ITBIS/promociones.

Además se probó el **servidor completo** (copia aislada, SQLite, Firestore en
memoria): activar → publicar → pedido en la nube → recepción → aceptar →
cobro con `POST /api/sales` (precio del pedido 500 aunque el producto subió a
560) → segundo cobro rechazado `YA_CONVERTIDO` → reporte por origen → estado y
reserva en la nube; y la pantalla (Pedidos online, carga en Ventas, cobro real
desde la pantalla, Mi Negocio, ficha del producto, día/noche).

Checklist manual antes de publicar una versión:

- [ ] Venta normal sin tienda activada (nada cambia).
- [ ] Pedido online retiro → cobrar ticket y B02.
- [ ] Pedido con RNC → B01 / e-CF.
- [ ] Pedido delivery → repartidor + contra entrega → app de repartidores → entregado.
- [ ] Dos cajas abren el mismo pedido; solo una cobra.
- [ ] Sin Internet: vender normal; al volver, llegan los pedidos.
- [ ] Anular la factura de un pedido y volver a cobrarlo.
- [ ] `npm run test:e2e-lan` (multicaja con MariaDB real).

## 9. Pendiente / decisiones de Emilio

- Reglas de Firestore: **desplegadas el 2026-10-11** (ruleset `95b2e6d5…`; el anterior era `8fd7d6d4…`).
- Servicio `cloud/tienda-online`: **desplegado el 2026-10-11** en Cloud Run (`tecno-caja-tienda`, revisión 00002, Node 22 — firebase-admin 14.5 no instala Firestore con Node 20).
- Sacar una versión del POS con el módulo (los instalados ≤ 1.4.4 no lo tienen).
- Dominio propio (p. ej. `tienda.tecnocaja.com`) en lugar de la URL de Cloud Run.
- Correo y SMS: el canal está preparado en `notifier.js`; falta elegir proveedor.
- Una tienda por sucursal (multisucursal con catálogos distintos).
- "Reservar inventario al recibir el pedido" también para el mostrador.
- Pago en línea con tarjeta (pasarela): hoy el cliente solo elige el método; el cobro real es en el POS.
- El cliente aún no puede cancelar desde la página (debe llamar o escribir); se dejó así para no tener cambios en dos direcciones.
