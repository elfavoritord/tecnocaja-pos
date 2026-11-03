# Catálogo unificado de productos y servicios

El punto 1 es la auditoría del 2 de noviembre de 2026 y queda como referencia. Lo vigente está en el punto 2. Los conteos salen de una lectura de Firestore que no modificó nada: 27 licencias, 5 de ellas empresas de servicios, y 3 nombres de tienda reservados.

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

## 2. Cómo quedó (POS 1.6.12)

### Alcance: solo la Empresa de Servicios

**Decisión de Emilio:** este trabajo es solo para la Empresa de Servicios, y no lleva pantalla de venta. Los negocios con POS estaban bien y siguen como en la 1.6.10.

La 1.6.11 lo aplicó a todos por error. La 1.6.12 lo corrigió: quien tenga la 1.6.11 pudo perder el stock de un artículo tipo Servicio si lo editó.

**Única excepción:** el indicador `IndicadorBienoServicio` del e-CF también aplica a los negocios con POS, por decisión de Emilio. Sale de `p.product_type` al armar el e-CF y solo decide entre 1 y 2; el ITBIS sigue la configuración de cada artículo. Solo se probó con DGII falso y XSD.

Quién es Empresa de Servicios lo dice `esEmpresaServicios(config)` en `server/services/articulos.js`.

### Empresa de Servicios

- **Catálogo:** cada `svc_services` tiene su producto en `products` (`product_type 'servicio'`, sin inventario), enlazado por `product_id` (`server/routes/servicios/enlace-productos.js`). Cotizaciones, facturas y el portal siguen usando `svc_services`. El enlace no va en la misma transacción: si falla, el servicio queda guardado y la siguiente corrida lo arregla sin duplicar.
- **Activar la tienda:** Configuración → Mi Negocio → Tienda online. No pide entrega ni método de pago.
- **Módulo "Tienda online":** pestañas Solicitudes y Servicios publicados, sin pedidos ni reportes de venta.
- **Opciones (Configurar tienda → Solicitudes):** `serviciosTienda.cotizacion`, `.cita`, `.whatsapp`, `.mostrarPrecio` y `publicacionAutomatica` (apagada; publica lo nuevo una vez, y lo que se oculta no vuelve).
- **Tienda:** modalidad `servicios`: solo sus servicios y sin carrito. Con el precio oculto, la nube no lo entrega.
- **Solicitudes:** `POST /api/tiendas/:slug/solicitudes` guarda en `businesses/{lic}/solicitudesOnline`, y el POS las recibe en `online_requests` (`server/tienda-online/solicitudes.js`). Crear cotización hace una `svc_quotations`; agendar hace una `svc_scheduled_services`. **Nunca crean factura.**

### Negocio con POS

La nube y el POS tratan cualquier perfil sin `modalidad: 'servicios'` como siempre: todo lo publicado se vende por carrito, un artículo tipo Servicio se ve como uno más y no hay solicitudes (la nube responde 409). Lo que un negocio haya guardado con la 1.6.11 se ignora. La tabla `online_requests` existe pero queda vacía, y no consulta la nube.

### Empresa de Servicios que vende productos

**Decisión de Emilio:** puede tener sus productos, pero la venta es la de la Empresa de Servicios: se factura en Facturación, sin pantalla de venta ni caja.

- **Opcional y apagado:** Configuración → Empresa de Servicios → "Vender productos" (`config.service_products_enabled`). Activa Productos, Inventario, Compras y Proveedores.
- **Facturación y cotización:** un buscador del catálogo (`conectarBuscador` en `js/servicios/servicios.js`) busca por nombre o código sin importar acentos, filtra por Servicios o Productos y muestra precio, ITBIS y existencia. Un código exacto + Enter agrega directo, así que sirve el lector de código de barras. Repetir un artículo suma la cantidad, y un producto agotado no se agrega. La línea guarda `product_id` en `svc_invoice_items` y `svc_quotation_items`.
- **Inventario:** se descuenta al emitir la factura, con el mismo lock y reintento de la venta del POS (`createInvoice` en `facturacion.routes.js`). Sin existencia, se rechaza y no queda nada. Anular devuelve lo vendido. Cotizar no toca inventario.
- **e-CF:** en la venta espejo, un producto va con su `product_id` (indicador 1) y lo demás lleva `sale_items.is_service = 1` (indicador 2). Antes, toda línea de una factura de servicios salía con 1.
- **Productos:** esta lista y `DB.productos` no traen los productos enlazados a un servicio, que se manejan en el catálogo de servicios.
- **Tienda:** con `productosEnTienda`, muestra servicios y productos publicados, con filtro por tipo. Sigue sin carrito: un producto se solicita igual que un servicio. El precio oculto solo aplica a servicios.

## 3. Lo que no se hizo

- **Fotos y descripciones entre sucursales:** cambian el formato central de sincronización.
- **App móvil:** tiene cambios sin commit de otra sesión.
- **Multisucursal con productos en una Empresa de Servicios:** sin probar.

## 4. Pruebas

- `npx jest tests/catalogo tests/tienda-online/solicitudes`: enlace, modalidades y solicitudes para los dos tipos de negocio.
- `cloud/tienda-online/test/ui/probar-servicios-ui.js`: la página de la tienda en navegador real.
- `cloud/tienda-online/test/ui/probar-servicios-pos.js`: el POS real. Empresa de Servicios con clics, y un negocio con POS comparado contra la 1.6.10.
- `npm run test:ecf-completo`: indicador de bien o servicio en el XML, también en una factura con producto y servicio.
