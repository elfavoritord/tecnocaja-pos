# Catálogo unificado de productos y servicios

Etapa 1 (auditoría) y propuesta de Etapa 2 (diseño), 2 de noviembre de 2026. Todavía no se ha cambiado código para este proyecto. Los conteos salen de una lectura de Firestore que no modificó nada: 27 licencias, 5 de ellas empresas de servicios, y 3 nombres de tienda reservados.

## 1. Cómo está hoy

### Hay dos catálogos separados

| | Modo POS | Modo Empresa de Servicios |
|---|---|---|
| **Catálogo** | `products` | `svc_services` y `svc_service_categories` |
| **Venta** | `POST /api/sales`, tablas `sales` y `sale_items` | `svc_invoices` y `svc_invoice_items` |
| **Cotización** | `/api/quotations` | `svc_quotations` |
| **Imagen** | Sí | **No tiene** |
| **Inventario** | `tracks_stock` | No aplica |
| **Pantalla de ventas** | Sí | Oculta: se decidió que ese modo no lleva punto de venta |
| **Tienda online** | Publica `products` con `online_enabled = 1` | `catalog.js` solo lee `products`: **sus servicios no pueden salir en la tienda** |

El portal del contador también escribe en `svc_services` (`server/sync/pending-servicios.js`).

### Lo que ya funciona y no hay que rehacer

- **Producto sin inventario:** `products.tracks_stock = 0`. La venta no valida existencia ni descuenta; lo cubren las pruebas de venta y multicaja.
- **Mezcla en una factura:** productos con y sin inventario, y combos, ya conviven en la misma venta.
- **Tipo de producto:** `products.product_type` existe y el formulario ya ofrece "Servicio".
- **Código de barras:** `products.barcode` es opcional; si falta, se usa el código. Un lector USB funciona como teclado.
- **Pantalla de ventas:** tarjetas con foto, nombre, precio y disponibilidad, buscador y categorías.
- **Fotos:** `products.image_local` (WEBP de hasta 900 px), con foto por defecto. Hasta 5 adicionales para la tienda (`online_images`).
- **Tienda:** una por negocio, sin límite por plan. `requirePlan` solo se usa en sucursales y cajas. Precios del servidor, pedidos sin duplicar y separación por licencia.
- **Publicación:** se elige producto por producto, y el pedido se cobra en el POS.
- **Cotizaciones y calendario:** los dos modos tienen cotizaciones. El modo servicios tiene calendario (`svc_scheduled_services`) y existe CRM con agenda.

### Lo que falta o está mal

| # | Hallazgo | Dónde | Efecto |
|---|---|---|---|
| 1 | **e-CF: un servicio vendido en el POS sale como bien.** La venta no pasa `isService`, así que `IndicadorBienoServicio` queda en 1. Solo las facturas del modo servicios mandan 2. | `ecf.repository.js`, `ecf-generator.js:119` | Dato fiscal equivocado, por ejemplo en un salón o una consulta. No sé si la DGII lo rechaza: hay que probarlo y confirmarlo con el contador. |
| 2 | Elegir tipo "Servicio" no apaga el inventario. Solo muestra el tiempo de atención. | `js/productos.js:591` | Puede salir "Agotado" y pedir existencia. |
| 3 | El código es obligatorio. | `server.js`, `js/productos.js:1821` | Contradice el registro rápido. |
| 4 | `sync` por sucursal no lleva foto, descripción ni datos de tienda. | `sincronizacion-central.js` | Las sucursales ven el producto sin foto. |
| 5 | Sin miniaturas: la pantalla de ventas carga la foto de hasta 900 px. | `server.js:3482` | Lento con catálogos grandes en PCs modestas. |
| 6 | La tienda solo recibe pedidos con carrito: no hay cotización, cita ni consulta de un servicio. | `cloud/tienda-online/lib/router.js` | Una empresa de servicios no tiene cómo recibir solicitudes. |
| 7 | No hay publicación automática ni modalidades de tienda. | `settings.js` | Faltan las opciones A, B y C. |
| 8 | Falta el filtro Todos, Productos y Servicios en ventas y en la tienda. | `js/ventas.js`, `app.js` de la tienda | |

## 2. Diseño propuesto

### Decisión central: `products` es el único catálogo

**Naturaleza:** `product_type = 'servicio'` es SERVICIO; cualquier otro valor es PRODUCTO. No se agrega otro campo, y `pizza`, `combo` o `recarga` siguen funcionando.

**`svc_services` no se borra.** Las cotizaciones, facturas y el portal del contador dependen de esa tabla. Se le agrega `product_id`:

1. Una migración crea un producto `servicio` por cada servicio, sin inventario, y guarda el enlace. No toca lo existente y se puede repetir sin duplicar.
2. Las rutas de `catalogo.routes.js` y `pending-servicios.js` actualizan el producto justo después de guardar el servicio (`server/routes/servicios/enlace-productos.js`). No es la misma transacción: si el enlace falla, el servicio queda guardado y la siguiente corrida lo arregla sin duplicar.
3. Foto, tienda y sucursales salen siempre de `products`.

Para volver atrás basta con ignorar `product_id`.

Alternativas descartadas:

- **Pasar todo a `products` y quitar `svc_services`:** obliga a tocar cotizaciones, facturas, contratos, órdenes y el portal a la vez.
- **Publicar las dos tablas por separado en la tienda:** deja dos catálogos, dos sistemas de fotos y dos sincronizaciones, que es lo que este proyecto quiere evitar.

### Reglas

| Tipo | Inventario | Compras y proveedor | Código de barras | Se vende en |
|---|---|---|---|---|
| Producto con inventario | Valida y descuenta | Sí | Opcional | Ventas |
| Producto sin inventario | No | Opcional | Opcional | Ventas |
| Servicio | **Siempre apagado en el servidor** | No aparece | Opcional | Ventas o factura de servicios, según el modo |

**Código interno opcional:** si viene vacío, el servidor genera uno único. La columna sigue siendo obligatoria porque la sincronización entre sucursales usa `codigo` como llave (`catalogo_codigos`).

### e-CF

El indicador sale del tipo actual del artículo (`p.product_type` al armar el e-CF, justo al vender). Solo decide entre 1 y 2. El ITBIS no se deduce del tipo: sigue la configuración de cada artículo. Un comprobante reenviado después de cambiarle el tipo al artículo saldría con el tipo nuevo; no se agregó una foto en `sale_items` para no tocar esa tabla.

### Fotos

Se conserva `image_local`, con una miniatura de 240 px (`-t.webp`) que se crea la primera vez que se pide (`server/services/miniaturas.js`), así que las fotos viejas también la tienen. La venta sigue guardando solo el `product_id`. **Fotos y descripciones entre sucursales no se hicieron:** cambian el formato central y hay que decidir dónde se guardan.

### Tienda: modalidades

Son ajustes dentro de `settings`, no módulos nuevos:

- `modalidad`: `productos`, `servicios` o `mixta`.
- `serviciosTienda.cotizacion`, `.cita`, `.whatsapp`, `.contratar`, `.mostrarPrecio`.
- `publicacionAutomatica`: apagada por defecto. Solo publica lo nuevo, una vez; lo que el dueño oculta no vuelve.

Una tienda ya publicada se lee como `mixta` con `contratar` activo, igual que hoy. Si el precio está oculto, el servicio no se puede pagar por carrito y la nube no entrega su precio. Una Empresa de Servicios siempre queda en `servicios` y sin carrito, porque no tiene caja ni pantalla de venta.

### Solicitudes

Son un flujo aparte del pedido; **nunca crean una factura solas**:

- **Nube:** `POST /api/tiendas/:slug/solicitudes`, con límite de intentos, clave contra duplicados y el mismo formato de datos del pedido. Se guarda en `businesses/{lic}/solicitudesOnline`.
- **POS:** tabla `online_requests` y una pestaña Solicitudes (`server/tienda-online/solicitudes.js`, `js/tienda-online.js`).
- **Empresa de Servicios:** "Crear cotización" hace una `svc_quotations`; "Agendar en el calendario" hace una `svc_scheduled_services`. Ninguna crea factura.
- **Negocio con caja:** "Cotizar en Ventas" pone el artículo en el carrito para usar el botón Cotizar; "Confirmar cita" cambia el estado. **El POS no tiene agenda de citas:** una cita se confirma por teléfono o WhatsApp, sin calendario.

## 3. Etapas

| Etapa | Qué se hace | Estado | Pruebas |
|---|---|---|---|
| 3. Catálogo | Naturaleza, código automático, servicio sin inventario, formulario corto, enlace con `svc_services` | Hecha | `tests/catalogo`, `probar-servicios-pos.js` |
| 4. Imágenes | Miniaturas y carga diferida | Hecha | `tests/catalogo`, pantallas |
| 5. Ventas | Filtro (en la vista de catálogo) y etiqueta de tipo | Hecha | `probar-servicios-pos.js`, `test:e2e-lan` |
| 6. Tienda | Publicar servicios, filtros y publicación automática | Hecha | `tests/tienda-online`, `probar-servicios-ui.js` |
| 7. Modalidades | Opciones A, B y C | Hecha | Las mismas |
| 8. Solicitudes | Nube, POS y paso a cotización o cita | Hecha | `solicitudes.e2e.test.js`, `probar-servicios-pos.js` |
| 9. Sincronización | Foto, descripción y tipo entre sucursales y app móvil | **No hecha:** cambia el formato central | Pendiente |
| 10. Fiscal | Indicador bien o servicio y regresión completa | Hecha | `test:ecf-completo`, XSD |

**Empresa de Servicios:** sigue sin pantalla de venta (decisión de Emilio). Se le activó la tienda: el módulo se llama "Tienda online" y muestra Solicitudes y Servicios publicados, sin Pedidos ni reportes de venta.

**App móvil:** ya tiene `es_servicio` en su base local, pero otra auditoría dejó allí cambios sin commit. No se tocó.

## 4. Las 15 pruebas pedidas

| # | Escenario | Resultado | Dónde se prueba |
|---|---|---|---|
| 1 | Solo servicios | Pasa | `probar-servicios-pos.js`, `solicitudes.e2e.test.js` |
| 2 | Solo productos | Pasa | `solicitudes.e2e.test.js`, regresión |
| 3 | Productos y servicios | Pasa | `probar-servicios-pos.js` (venta real juntos) |
| 4 | Sin código de barras | Pasa | `probar-servicios-pos.js` |
| 5 | Lector USB | **Sin probar con lector real.** La búsqueda por código no cambió | Regresión de ventas |
| 6 | Publica servicios | Pasa | `solicitudes.e2e.test.js` |
| 7 | Publica productos | Pasa | `tienda-online.e2e.test.js` |
| 8 | Tienda mixta | Pasa | `probar-servicios-ui.js` |
| 9 | Solicitudes de cotización | Pasa; no crean venta ni factura | `solicitudes.e2e.test.js`, `probar-servicios-pos.js` |
| 10 | Pedidos de productos | Pasa | `tienda-online.e2e.test.js` |
| 11 | Sin conexión y luego sincroniza | Pasa: la solicitud espera en la nube y entra una vez | `solicitudes.e2e.test.js` |
| 12 | Varias sucursales | Parcial: foto y descripción no viajan entre sucursales (Etapa 9) | `test:multisucursal-*` |
| 13 | e-CF de productos y servicios | Pasa con DGII falso y XSD; **sin probar en la DGII real** | `test:ecf-completo` |
| 14 | Cambio de precio e imagen | Pasa en la tienda; la foto no llega a sucursales (Etapa 9) | `tienda-online.e2e.test.js` |
| 15 | Desactivar lo publicado | Pasa | `solicitudes.e2e.test.js` |
