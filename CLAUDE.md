# CLAUDE.md — Contexto para asistentes de código

Este archivo ayuda a asistentes de IA (Claude, Copilot, otros) a entender el proyecto rápido y no tomar decisiones que rompan el sistema.

## TL;DR

**Tecno Caja** es un sistema punto de venta estilo Eleventa, empaquetado como app de escritorio Windows (Electron + Express + MariaDB embebida). El dueño es **Emilio**. El modelo comercial es **híbrido on-premise + nube opcional**. Target: colmados, tiendas, farmacias en República Dominicana.

> Marca única: **Tecno Caja** — ya no existe ninguna referencia a "NovaPOS" en el código fuente. Todas las variables de entorno usan el prefijo `TECNO_CAJA_`.

## Cómo correr

```bash
npm install
npm run desktop   # ← esta es la forma correcta (Electron + MariaDB empaquetada)
```

`npm start` solo corre el backend, requiere MariaDB externo o `DB_CLIENT=sqlite` en `.env`.

**Demo para probar sin licencia:** `npm run demo` (http://127.0.0.1:3470, admin / 1234; `-- --nuevo` empieza de cero). Usa el código de esta carpeta, SQLite en `<unidad>:\TecnoCaja-Demo` (los datos se conservan) y `TECNO_CAJA_DEMO=1`: la licencia siempre deja entrar y no toca la nube (`server.js → LICENCIA_DEMO`, ignorado dentro de `app.asar`, así que un cliente no lo puede encender). Sin modo demo, un servidor de prueba sin Firebase queda bloqueado con "autorización local verificable" al rato de crearlo e intenta registrarse en la Sync API de producción.

## Arquitectura en una línea

Electron lanza `mariadbd.exe` empaquetado, luego arranca `server.js` (Express) en `127.0.0.1:3399`, luego abre un `BrowserWindow` apuntando ahí. UI en HTML/JS vanilla bajo `/js` y `/css`. Socket.IO para tiempo real.

Diagrama completo: `docs/ARCHITECTURE.md`.

## Estructura clave

- `server.js` — **Monolito de ~10k líneas en proceso de refactor**. No añadir más código aquí; extraer a `server/routes/<dominio>.routes.js`.
- `server/config/cors.js` — Política CORS (allowlist localhost + LAN opcional).
- `server/config/security.js` — Helmet + rate limiter + bind host.
- `server/security/backup-crypto.js` — AES-256-GCM para respaldos `.novaseguro` (extensión legacy, no renombrar).
- `server/middleware/dgii-auth.js` — **No activo** (solo existe en `backups/`/`backup_ecf_antiguo/`). No se reconecta a propósito: `/fe/*` lo llama DGII directamente y DGII no puede enviar un token secreto nuestro.
- `server/routes/dgiiRoutes.js` — Rutas públicas DGII (`/fe/recepcion`, `/fe/aprobacioncomercial`, `/fe/autenticacion`).
- `server/cache/products-cache.js` — Cache LRU de productos.
- `server/network/` — LAN-first: monitor de Internet, identidad (`serverId`) y descubrimiento de la principal, vigilante de IP. `GET /api/connectivity` da el modo (`normal`/`local`/`contingencia`/`sin_bd`). **Internet nunca bloquea la venta**: lo remoto va en cola o diferido. Ver `docs/LAN-OFFLINE-FIRST.md`.
- Multicaja: toda transacción de venta toma primero el lock de `config` (contador FAC) antes de leer stock/NCF. No quitarlo ni apagar `innodb_snapshot_isolation` (MariaDB 12): protegen el inventario entre cajas. Prueba real: `npm run test:e2e-lan`.
- `server/sync/control-center/` — Centro de Control de la app de reportes: la PC principal publica resúmenes ya sumados en Firestore (`businesses/{id}/controlCenter`, `dailyStats`, `terminals`), en segundo plano y solo con Internet. Si cambias su formato, regenera el contrato de la app con `node scripts/control-center/export-app-fixtures.js`. Ver `docs/CENTRO-DE-CONTROL-REPORTES.md`.
- `server/services/app-reportes/` + `server/services/compras/cola-app.js` — **Lo que pide la app de reportes**: facturas y estados de cuenta en PDF (`businesses/{id}/appSolicitudes`) y compras de proveedores (`businesses/{id}/appCompras`). Los atiende la PC principal en segundo plano, con los permisos del POS del usuario (`usuario-app.js`); la factura es la misma hoja de `js/factura-plantillas.js` (`factura-de-venta.js` copia `ventaToFormalDoc`: si cambias uno, revisa el otro) y la compra va por `registrar`. Ver `docs/CENTRO-DE-CONTROL-REPORTES.md` §8b; pruebas: `npx jest tests/app-reportes` y `npm run test:app-reportes`.
- `server/tienda-online/` + `cloud/tienda-online/` — **Tienda online** (módulo opcional, se activa en Configuración → Mi Negocio). La nube solo recibe pedidos; el POS los cobra con `POST /api/sales` (`onlineOrderId`, ligado en la misma transacción: una sola venta por pedido). `contrato.js` y `calculo-pedido.js` se comparten con la nube vía `npm run vendor-sync`. No crear catálogo, inventario ni facturación aparte. El aspecto de cada tienda (estilos, secciones, vitrinas) se valida en server/tienda-online/diseno.js, también compartido con la nube. Ver `docs/TIENDA-ONLINE.md`; pruebas: `npx jest tests/tienda-online`.
- `server/services/articulos.js` + `server/routes/servicios/enlace-productos.js` — **Tienda de la Empresa de Servicios**: cada `svc_services` se enlaza por `product_id` a un producto `product_type 'servicio'`, y eso es lo que publica. Esa empresa **no tiene pantalla de venta**: si activa "Vender productos" (`service_products_enabled`), los factura desde Facturación y descuentan inventario. Su tienda recibe solicitudes (`server/tienda-online/solicitudes.js`) que nunca crean factura. **Los negocios con POS no cambian:** todo va condicionado a `esEmpresaServicios()`. Ver `docs/CATALOGO-UNIFICADO.md`; pruebas: `npx jest tests/catalogo tests/tienda-online/solicitudes`, `cloud/tienda-online/test/ui/probar-servicios-ui.js` y `probar-servicios-pos.js`.
- `server/services/combos.service.js` + `server/routes/combos.routes.js` + `js/combos.js` — **Combos promocionales** (Promociones → Combos). El combo es un producto (`product_type 'combo'`, sin existencia propia) con componentes en `product_combo_items`; la venta descuenta los componentes y guarda una foto en `sale_items.combo_snapshot` que usan cancelación/devolución/cobro. No reenviar componentes como líneas del e-CF. Ver `docs/COMBOS-PROMOCIONALES.md`; pruebas: `npx jest tests/combos` y `npm run test:combos-e2e`.
- `js/combos-personalizados-motor.js` + `server/services/combos-personalizados.service.js` + `server/routes/combos-personalizados.routes.js` + `js/combos-personalizados.js` — **Combos personalizados** (se activan en Configuración → Apariencia). El cajero escribe el precio (libre, con ITBIS incluido) y elige los productos. El combo **no es un producto**: en la venta es un grupo de líneas normales marcadas con `sale_items.custom_combo_key`, y el precio se reparte entre ellas (`repartirCombo`: base + ITBIS por la tasa de cada producto; el precio de catálogo queda en `original_price`). El XML e-CF no cambia. `POST /api/sales` vuelve a hacer el reparto con los precios de la base (`prepararVenta`, sin consultas si la venta no trae combos). El motor reproduce el redondeo por línea del carrito; no cambiar uno sin el otro. Ver `docs/COMBOS-PERSONALIZADOS.md`; pruebas: `npx jest tests/combos-personalizados` y `npm run test:combos-personalizados-e2e`.
- `js/venta-por-monto.js` — **Total editado en productos por peso** (Configuración → Facturación → "Permitir modificar el total en productos por peso", `config.weight_total_edit_enabled`; **encendida por defecto desde 2026-11-17**, también en las PCs que ya existían — `peso_monto_activado_v1` la enciende una sola vez; apagada = la ventana "Venta por peso"). En el carrito se toca el Total de la línea por peso, se escribe el monto final (con ITBIS y después del descuento) y se calcula la cantidad con 2 decimales; el precio no cambia y se cobra exacto ese monto. Sin báscula, el producto entra con 1 unidad sin ventanas. La caja (`applyFinalAmountToSaleItem` y `startSaleLineTotalEdit` en `js/ventas.js`) y `POST /api/sales` usan el mismo cálculo; el servidor reemplaza la cantidad y rechaza el total editado si la opción está apagada o el producto no es por peso. `sale_items.line_total` guarda el importe exacto y `requested_amount` el monto; e-CF y devoluciones usan `line_total ÷ qty` como precio. Pruebas: `npx jest tests/venta-por-monto.test.js` y `npm run test:venta-por-monto`.
- **Cambiar el precio en la venta (F3 / botón "Precio")** — con la fila elegida del carrito (clic; si no, la última que entró) el Precio se vuelve un campo: Enter guarda, Escape no cambia nada. Decisiones de Emilio: **el precio queda en el producto** (desde 2026-11-23: `guardarPrecioDeVentaEnProducto` → `POST /api/products/venta/:id/precio`, `server/routes/venta-catalogo.routes.js`, auditoría "Precio cambiado desde la venta" con el de antes; sin conexión queda solo para esa venta), la cantidad no cambia, cualquier usuario que venda, también el cajero (queda en la auditoría "Precio cambiado en la venta") y **nunca en productos por peso**, combos, combos personalizados ni pedidos online. La línea lleva `precioManual` (en el sentido del precio del producto: con ITBIS incluido, el final), sin ofertas, y lo conserva al cambiar la cantidad. `POST /api/sales` lo valida con `server/sales/precio-manual.js` y guarda el precio de catálogo en `original_price`. Pruebas: `npx jest tests/precio-manual.test.js tests/venta-catalogo.test.js` y `npm run test:cambiar-precio`.
- **Paso 2 de la certificación ("Procesar y enviar")** — `certificationCenterProcess` manda primero los 4 RFCE (si uno se rechaza, para sin mandar los 21: `rfceFirstRejected`) y después los 21 e-CF. El asistente lo pide con `background=true`: responde al importar, el envío sigue en el servidor y el avance va en `processRun` del estado del centro (`_followStep2Run` en `js/ecf-cert-wizard.js`). Con la DGII real son minutos: no volver a cortar la espera de la pantalla. Un envío a la vez (`certificationProcessInFlight`, 409 `PASO2_EN_CURSO`). Mientras corre, `router.js` frena con 409 todo lo que toca el lote (reset-sent, rfce/submit, etc.) y el estado no consulta la DGII. **Al primer error se para**: si la DGII rechaza uno (también se pregunta por los ya enviados mientras salen los siguientes), el asistente pide descargar el set otra vez. Si se cortó la conexión, ofrece "Continuar envío" (`process-continue`), que no reenvía los RFCE ni lo que tiene TrackID. "Resetear y reintentar" ya no se ofrece. Pruebas: `npx jest tests/ecf.paso2-rfce-primero.test.js`, `node scripts/ecf/probar-paso2-rfce-primero.js <set.xlsx> [--demora=700 --con-asistente | --rechazar-rfce | --rechazar-ecf=3]` y `node scripts/ecf/probar-paso2-ui.js <set.xlsx> [--en-proceso | --rechazar-ecf=3]` (pantalla real con DGII falso lento).
- **Paso 3 (Aprobaciones Comerciales)** — `processAprobacionComercialTestSet`: el Excel lo arma la DGII con e-CF que ella aceptó en cualquier intento del Paso 2. Antes de decir que un e-NCF "no aparece aceptado en esta PC", consulta a la DGII los que esta PC tiene en proceso; si aun así falta alguno responde 409 `ACECF_FUERA_DE_LOTE` y el asistente pregunta; al confirmar envía con `confirmarFueraDeLote` (hasta la 1.6.32 el reintento nunca corría). Pruebas: `npx jest tests/ecf.paso3-excel-lote.test.js tests/ecf.paso3-enviar-confirmado.test.js`.
- **Cobrar: por qué E32/E31 salen apagados** — `explainSaleTypes` (`modules/ecf/services/ecf.service.js`, mismas reglas que `usableSequences`) + `GET /api/fiscal-sequences/available/explain`. Da el motivo: emisor apagado, e-CF detenido por la licencia, rango de otro ambiente (certificación vs producción), desactivado, de otra caja, vencido, agotado o E31 sin fecha. Sale debajo de los comprobantes (`#cobro-ecf-hint`, solo con el emisor activo) y en el aviso al tocar el botón (`_docUnavailableMessage` en `js/ventas.js`). Pruebas: `npx jest tests/ecf.explicar-tipos-venta.test.js` y `node scripts/ecf/probar-venta-sin-rango.js`.
- **Recepción DGII automática (Pasos 7–11)** — `cloud/ecf-gateway` (Cloud Run `tecno-caja-ecf-gateway`, una URL para todos; la empresa sale del RNC del XML). El POS conecta su empresa solo: `connectReception` (`modules/ecf/services/ecf.service.js`) usa el código escrito, luego el guardado y si no `POST /self-service/connect` del gateway con su .p12 (`gateway-connection.js`), que registra la empresa nueva o la misma con el mismo certificado y devuelve su código; con OTRO certificado responde 409 (no se puede tomar una empresa ya conectada). Se dispara al cargar el certificado y al abrir los Pasos 7–9. Sin la empresa en el gateway el ARECF sale sin firma y la DGII reinicia la prueba ("La firma del XML no es válida"). `alta-empresa.ps1` queda para soporte. Pruebas: `npx jest` en `cloud/ecf-gateway` y `npx jest tests/ecf.gateway-connection.test.js tests/ecf-step9-automatic.test.js`.
- **Bitácora de auditoría** (Movimientos y Auditoría) — `audit-event.append` guarda `created_at` en UTC; `mapAuditRow` lo convierte con `server/utils/fecha-auditoria.js` (con MariaDB mysql2 lo leía como hora local y salía 4 horas adelantada). Detalles: texto de corrido, no JSON (los viejos se formatean en `js/movimientos.js → formatMovementDetail`). Toda apertura de la gaveta se audita: manual, conteo/cierre, al cobrar (`motivo 'venta'`) y la prueba de Configuración (`'prueba'`). Cerrar sesión llama a `/api/logout` (deja "Cierre de sesión" y anula el token, también en el caché). Prueba: `npm run test:bitacora` (MariaDB y SQLite).
- **Producto nuevo desde la venta** (`suggestRegisterProduct` / `saveSaleQuickProduct` en `js/ventas.js`) — un código que no está en el sistema abre una ventana corta con el código puesto: Nombre → Enter → Precio → Enter, y el producto se crea y entra a la venta. El "+" (Agregar producto rápido, `addQuickSaleItem`) también lo guarda, con código `RAP-0001`… y la casilla de ITBIS; si ya hay uno con ese nombre entra ese con su precio, y sin conexión entra solo a la venta como antes. Los dos van por `POST /api/products/venta/rapido` (`server/routes/venta-catalogo.routes.js`), que también deja al cajero (Emilio, 2026-11-23). Queda en "General", por unidad, sin ITBIS (se cobra justo el precio escrito) y sin control de existencia (con 0 no se podría vender); "Ficha completa" lleva a Productos. Pruebas: `npx jest tests/venta-catalogo.test.js` y `npm run test:producto-nuevo`.
- **Buscador de productos de la venta** (`js/buscador-productos.js`, Emilio 2026-11-23) — lo usan el buscador (`_doSearchProduct`) y el catálogo de la pantalla dividida (`getSalesCatalogProducts`). Sin acentos ni signos, por palabras en cualquier orden, ordenado por parecido (código igual → nombre igual → nombre que empieza así → palabras → categoría/marca → pedazo del código) y con los mal escritos al final ("parecidos", solo palabras de letras de 4+: un código escaneado nunca se parece a otro). Muestra hasta 50 en cuadros como el catálogo (6 a 8 por fila, `search-grid` en `css/ventas.css`; ↓↑ cambian de fila con `searchGridColumns`, →← de cuadro solo con uno marcado). Si se escribió un nombre, el primero queda marcado y Enter lo agrega; con un código a medias no se marca nada y un código que no existe sigue ofreciendo "Producto nuevo". Cada tecla quita la marca (el Enter del lector nunca agrega lo de la búsqueda anterior). Pruebas: `npx jest tests/buscador-productos.test.js` y `npm run test:buscador`.
- **Ficha del producto en pestañas e información adicional en la factura** (2026-11-16) — la ficha (`openProductModal` en `js/productos.js`) tiene arriba imagen, código, nombre y categoría, y debajo las pestañas General · Precio e ITBIS · Inventario · Detalles · Opciones (se esconde si no hay nada) · Tienda (`switchProductTab` va por posición). En **Detalles** se escriben descripción, especificaciones, país de procedencia, observaciones y "Mostrar en la factura". Las reglas están en `js/producto-info-adicional.js`, compartido con el servidor. El producto lo guarda en `products.info_adicional` (JSON) y cada línea de venta guarda una copia de lo que salió en `sale_items.info_adicional` (`server/productos/info-adicional.js`). La reimpresión usa esa copia aunque el producto cambie. Se activa en Configuración → Facturación → "Descripciones adicionales en facturas" (`config.info_adicional_factura`); apagada, todo sale como siempre. Sale debajo del nombre en el ticket de 58/80 mm (`buildThermalItemLines` y `electron/thermal-printer.js`), en la A4/PDF (`detalle` en `js/factura-plantillas.js`) y en la factura de la app de reportes. Decisiones de Emilio: **no se edita en la venta** (solo desde Productos) y **el XML del e-CF no cambia** (no va en DescripcionItem). Viaja a multisucursal (`catalogo-local.js`, `sincronizacion-central.js`, `sincronizacion.js`; hay que volver a subir la Sync API) y por CSV (columnas Descripción Adicional, Especificaciones, Procedencia, Observaciones y Mostrar Info en Factura). Pruebas: `npx jest tests/producto-info-adicional.test.js tests/ticket-cantidad-peso.test.js` y `npm run test:info-adicional`.
- **ITBIS incluido en el precio (método 3)** — `products.itbis_incluido` (0 = como siempre). Los 3 métodos: se suma el % / monto fijo / ya incluido (ficha del producto → Aplicar ITBIS); `config.itbis_metodo_predeterminado` solo decide el que trae un producto nuevo o importado (los existentes no cambian). El precio guardado es el final: la línea lleva el precio sin ITBIS y el importe sale de `lineaItbisIncluido` (`js/venta-por-monto.js`, 118 → 100 + 18; nunca cobra más, a lo sumo 1 centavo menos). Caja (`getSaleLinePricing`/`calculateSaleItemBase` en `js/ventas.js`) y `POST /api/sales` usan el mismo cálculo; la línea queda con `sale_items.itbis_incluido = 1` y solo con esa marca (o `requested_amount`) el e-CF y las devoluciones usan `line_total ÷ qty` (las facturas de servicios guardan `line_total` CON ITBIS: no generalizar). Viaja en multisucursal (`catalogo-local.js`, `sincronizacion-central.js` → re-desplegar la Sync API) y a la tienda online (publica la base). Al cambiar un producto, las otras cajas refrescan la pantalla dividida por `catalogo:actualizado` (`server/realtime/catalogo-en-vivo.js`). Pruebas: `npx jest tests/venta-por-monto.test.js tests/catalogo-en-vivo.test.js tests/multisucursal/itbis-incluido-catalogo.test.js`, `npm run test:itbis-incluido` y `npm run test:ecf-completo`.
- **Cierre de caja y cuadre (Emilio, 2026-11-17)**:
  - **Cuadre corto.** `filasReporte` en `js/caja-segura.js` es el que se ve, se imprime (térmica, A4, PDF) y se guarda para los dos cierres (con monto y con arqueo). Lleva: Turno, Desglose del sistema (cada gasto o entrada con su descripción, sacada de `cash_movements.notes`), Desglose del cajero, Efectivo físico en caja, Diferencia sistema - cajero y la firma "Recibido por".
  - **Detalle completo.** El reporte largo quedó en `filasDetalle` ("Ver detalle completo").
  - **Gastos en el cuadre y gasto repetido (2026-11-23).** Un solo gasto o ingreso sale en una línea ("Gasto: compra de hielo"); varios, cada uno y el total al final. Un cuadre de cliente traía 14 gastos "platanos" iguales (el mismo gasto registrado de más, sobraban RD$ 19,735): un gasto igual a otro del mismo turno (monto + descripción) da 409 `GASTO_REPETIDO` en `/api/cash/expense` y `/api/caja/gaveta` hasta que se confirma (`confirmarRepetido`, `server/services/caja-gasto-repetido.js`); `saveCashExpense` no se envía dos veces, Enter sostenido no repite la acción del modal y la gaveta reusa su `eventUuid` al reenviar. Pruebas: `npx jest tests/caja-gasto-repetido.test.js tests/caja-cuadre-corto.test.js` y `node scripts/probar-nueve-mejoras.js --ui`.
  - **Transferencias en el arqueo.** Se declaran igual que el verifón: `transferenciaDeclarada` en `prepararCierre` (`server/routes/caja-segura.routes.js`).
  - **Antes de cerrar** (`openCashCierreModal` → `confirmarCierreDeCaja` en `js/app.js`) se avisa que termina el turno, que solo se podrá imprimir el cuadre y que la sesión se cerrará; con "Cancelar" no pasa nada.
  - **Después de "Sí, cerrar la caja" el cierre es obligatorio** (`window.CierreObligatorio`): el cierre y el arqueo no tienen "Cancelar" ni X, y Esc o un clic fuera no los cierran. `closeAllModals` en `js/ui.js` solo cierra con `source 'cierre-caja'`, que es el `cerrarModal` de `js/caja-segura.js`. Se termina en la pantalla final o si las mesas sin cobrar impiden cerrar. El arqueo es angosto y compacto (760 px).
  - **Al cerrar la caja** solo queda la pantalla final: "Imprimir cuadre", "Cerrar" (cierra la sesión) y, si está activa, la transferencia a Caja General.
  - **Reportes con cierre seguro (2026-11-19, publicado en la 1.6.39).** Con la caja abierta, el cajero sin `ver_reportes_caja` entra solo a Detallados → Facturas para ver y reimprimir. No ve montos, totales ni las otras pestañas (`aplicarSoloFacturas` en `js/reportes-v2.js` + `css/repv2.css`). Antes no podía entrar.
  - **Reportes → "Cierres de caja".** `GET /api/caja/cierres` (desde/hasta en hora de RD, sucursal, caja y cajero) lista los cuadres guardados (`cash_closings.report_json`). "Ver" abre el cuadre para revisarlo o imprimirlo.
  - Pruebas: `npx jest tests/caja-cuadre-corto.test.js` y `node scripts/probar-nueve-mejoras.js --ui`.
- **Cobrar sin serie B** — Configuración → Facturación → "Mostrar los comprobantes serie B en Cobrar" (`config.cobro_serie_b`, 1 = como siempre). Apagado, el grupo «Serie B» no sale en «Más» (`extraGroups` en `js/cobro.js`), un preferido B arranca como Ticket y `setSaleDocumentPreset` no acepta B. Solo cambia la pantalla: las secuencias no se tocan. Prueba: `node scripts/ventas/probar-salir-sin-cobrar.js`.
- **Nueve mejoras financieras** (propina legal, crédito en pago mixto, estados de cuenta, notas de crédito, auditoría, teléfono, ITBIS separado, cierre seguro, gaveta). El efectivo esperado del cierre lo calcula `server/services/caja-arqueo.js` desde ventas, abonos y movimientos (no `current_amount`); devolución y cancelación viven en `server/routes/ajustes-venta.routes.js` según el documento y su estado DGII real (un e-CF pendiente no se cancela; la factura original nunca se borra). Dinero en centavos con `js/pos-money.js`. Ver `docs/nueve-mejoras-integracion.md`; pruebas: `node scripts/probar-nueve-mejoras.js` (y `--mariadb`), `npx jest tests/finanzas`.
- `js/mesas-reservas.js` + `server/services/mesas-anticipos.js` — **Reservas de Mesas con anticipo** (opcional, consumible o no por reserva): el anticipo entra en la caja abierta (en efectivo, movimiento «Anticipo de reserva»; el cierre lo separa). Si es consumible, `POST /api/sales` lo descuenta de lo que paga el cliente (`paraCobro`: se recalcula de la base y debe coincidir con la pantalla); **la factura conserva su total** (ITBIS/e-CF no cambian) y los pagos cubren solo lo pagado ahora. Ver `docs/mesas-etapa-1.md`; pruebas: `npx jest tests/mesas-reservas.test.js tests/mesas-anticipos.test.js` y `node scripts/probar-nueve-mejoras.js --ui`.
- `server/services/compras/` + `js/compras-preparar.js` + `js/compras-precios.js` — **Compras de proveedores (fase A)**: subir XML e-CF/Excel/CSV/foto/PDF → borrador «Preparar compra» → `registrar` (única ruta: formulario clásico, borradores y las compras que el contador manda desde su Portal por `licencias/{id}/compras_pendientes`, que registra `server/services/compras/cola-portal.js`; los lectores se copian al Portal con su `vendor-sync`). Idempotente por `purchases.uuid`, sin facturas duplicadas, productos nuevos al registrar (sin códigos de barras inventados), inventario solo para lo que lo controla y según la modalidad (automática / con recepción). Un e-CF del proveedor nunca emite E41. Ver `docs/COMPRAS-PROVEEDORES.md`; pruebas: `npx jest tests/compras` y `node scripts/probar-compras.js` (`--mariadb`, `--ui`).
- **Licencia vencida o con errores (política de Emilio, 2026-11-17)** — `server/licensing/license-service.js`. Una licencia **pagada** (alguna vez activa, con modalidad/contrato, o `config.licencia_pagada = 1` en esa PC) **nunca deja sin entrar**: vencida, suspendida, equipo no autorizado, reloj atrasado, caché dañado o sin Internet → `canEnter: true`, `ecfBloqueado: true`, `ecfBloqueoMotivo` y `aviso`; `status` queda con el estado real. Solo la **prueba** vencida deja sin entrar (los datos no se tocan). Con `ecfBloqueado`, `ecfPermitido()` es falso: la venta no emite e-CF, Cobrar no ofrece tipos E, y `_protegerEnviosConLicencia` (`modules/ecf/services/ecf.service.js`) frena todo envío a la DGII en producción (la cola, reenvíos y RFCE incluidos; certificación no). `trialEndsAt` solo vence una prueba (en `fetchRemotePosLicenseState` y `normalizeRemoteLicense`) y el POS ya no sube las fechas de la prueba a una licencia activa: esa fecha vieja era el falso "licencia vencida". La misma PC con otro `deviceId` (otra MAC o versión de Windows) se reconoce por `pcId` (`machine-identity.getPcId`) o, en registros viejos, por el nombre del equipo. Un error al revisar la licencia nunca devuelve "vencida". El asistente de negocio nuevo pone `licencia_pagada = 0`. Pruebas: `npx jest tests/licensing` y `npm run test:licencia-pagada` (nube falsa, pantalla real).
- `js/permisos-catalogo.js` + `server/security/permisos-usuario.js` — **Permisos por usuario**: `users.permisos_usuario` (NULL = los del rol, como siempre). Con lista propia, `userRoleHasPermission` usa esa lista y los atajos por rol (`userCanOpenCash`, `ensureNotCashier(req, permiso)`…) deciden por ella; solo el administrador general personaliza. Un atajo por rol nuevo debe preguntar antes `userHasCustomPermissions(user)`. Ver `docs/PERMISOS-USUARIOS.md`; pruebas: `npx jest tests/permisos` y `npm run test:permisos`.
- `db/schema.sql` — Esquema MariaDB completo con seeds.
- `db.js` — Abstracción dual MariaDB/SQLite.
- `electron/main.js` — Main process.
- `js/` — Renderer vanilla (no React, no Vue aún).
- `modules/firebase-admin.js` — Firebase opcional.
- `reporte app/` — Subproyecto Flutter independiente. **NO tocar desde aquí.**
- `mcp-server/` — Servidor MCP (Model Context Protocol) **de solo lectura** para Claude/ChatGPT. Proceso aparte (ESM, puerto 3400), consulta el POS por HTTP reusando su auth; **no toca `server.js` ni la BD**. **OAuth 2.1 propio** (login usuario/clave del `.env`, DCR, PKCE) + token de máquina opcional. Ver `mcp-server/README.md`. Túnel con nombre fijo: `scripts/start-mcp-with-tunnel.ps1 -Tunnel <nombre>`.

## Convenciones que NO debes romper

1. **Nunca hardcodear secretos.** Todo va por env var. Ver `.env.example`.
2. **Nunca queries con concatenación de strings.** Usar placeholders `?` con `mysql2`.
3. **CORS por defecto solo localhost.** No añadir `origin: '*'` nunca.
4. **Bind default `127.0.0.1`.** Cambiar solo gated por `POS_ALLOW_LAN=true`.
5. **El password maestro legado `'Seguridad2026'` se mantiene SOLO como fallback de lectura** en `server/security/backup-crypto.js`. Nunca usar como default activo.
6. **Español** para dominio de negocio (`ventas`, `caja`, `ncf`). **Inglés** para plomería (`router`, `middleware`).
7. **Factory con inyección de dependencias** para nuevos módulos de rutas — ver patrón en `docs/ARCHITECTURE.md`.

## Fase actual: Fase 1 — Modularización

Extraídos hasta ahora del monolito:
- ✅ CORS → `server/config/cors.js`
- ✅ Helmet + rate limiter → `server/config/security.js`
- ✅ Backup crypto → `server/security/backup-crypto.js`

Pendientes de extraer (prioridad en este orden):
1. `auth` (login, logout, google, offline-login) → `server/routes/auth.routes.js`
2. `ventas` → `server/routes/ventas.routes.js`
3. `productos`
4. `clientes`
5. `caja`
6. `inventario`
7. `reportes`
8. `config`
9. `licencia`
10. `respaldos`

**Regla clave**: cuando extraigas, usa la **factory pattern con deps inyectadas**. No hagas imports circulares ni globals compartidos.

## Tests

```bash
npm test
```

Framework: Jest. Tests viven en `tests/`. Un test por módulo extraído.

e-CF de punta a punta, con la app real y un DGII falso (nada sale a la DGII real): `npm run test:ecf-completo` (POS y servicios, MariaDB y SQLite; valida cada XML contra los XSD). Recorrer todas las pantallas buscando errores: `npm run test:pantallas`. Al tocar `ecf-generator.js` o la venta, correr ambas.

## Lint y format

```bash
npm run lint
npm run format
```

ESLint + Prettier. Config en `.eslintrc.json` y `.prettierrc.json`.

## Lo que NO debes hacer

- **NO reescribas el frontend en React/Vue.** Se migrará gradual, no de golpe.
- **NO migres a TypeScript ahora.** Se evalúa después de Fase 3.
- **NO agregues microservicios.** Monolito modular es la decisión hasta >1000 clientes.
- **NO toques `reporte app/`**; es un subproyecto Flutter con su propio ciclo.
- **NO modifiques `dist/` ni `build/mariadb-runtime/`**; se regeneran con `build:desktop`.
- **NO hagas `npm audit fix --force`**; rompe electron/puppeteer.

## Contexto de negocio

- **Mercado**: RD primero, luego Centroamérica.
- **Precios**: los oficiales están en `server/licensing/precios.js` (Básico, MultiCaja, MultiSucursal; mensual, anual, implementación y pago único). Ver `docs/LICENCIAS.md`.
- **Cumplimiento fiscal**: NCF y eventualmente e-CF DGII.
- **Hardware típico**: impresora térmica ESC/POS, gaveta conectada a impresora, lector de código USB (HID).

## Cloudflare Tunnel (acceso DGII/e-CF)

El backend corre en `127.0.0.1:3399`. Para exponer las rutas `/fe/*` a internet sin abrir puertos:

```powershell
# Quick Tunnel (URL temporal para pruebas)
.\scripts\start-with-tunnel.ps1

# Túnel permanente (con nombre fijo)
.\scripts\start-with-tunnel.ps1 -Tunnel tecnocaja-pos
```

Variables clave en `.env`:
- `POS_BIND_HOST=127.0.0.1` — NO cambiar aunque uses el túnel.
- `DGII_REQUIRE_INTERNAL_TOKEN=false` — debe quedar en `false`. `/fe/*` es un webhook que llama DGII directamente; no hay forma de que DGII envíe un token secreto nuestro, así que activarlo bloquea el 100% del tráfico real de DGII.

## Documentos de referencia

- `NovaPOS-Plan-Evolucion.md` — Diagnóstico + roadmap 6 fases (nombre de archivo histórico, no renombrar).
- `docs/ARCHITECTURE.md` — Arquitectura detallada.
- `docs/LAN-OFFLINE-FIRST.md` — Auditoría LAN-first: qué funciona sin Internet, multicaja, contingencia, riesgos.
- `docs/CENTRO-DE-CONTROL-REPORTES.md` — Auditoría de la app de reportes, arquitectura del Centro de Control y pasos de despliegue.
- `docs/LICENCIAS.md` — Auditoría de licencias, precios, contratos, servicios separados y etapas pendientes (firma digital, llave de Firebase, migración de clientes).
- `docs/TIENDA-ONLINE.md` — Tienda online: arquitectura, tablas, APIs, sincronización, riesgos y despliegue.
- `docs/CATALOGO-UNIFICADO.md` — Tienda y solicitudes de la Empresa de Servicios; alcance y por qué los negocios con POS no cambian.
- `docs/MULTISUCURSAL-DIAGNOSTICO.md` — Fase 1 del proyecto multisucursal (una base por sucursal + sincronización HTTPS): cómo está hoy, brechas, riesgos que bloquean y decisiones pendientes.
- `docs/MULTISUCURSAL-FASE-2.md` — Fase 2: uuid, bandejas de sincronización, acceso por sucursal y migraciones numeradas (`server/migrations/`). Pruebas: `npm run test:multisucursal-mariadb` y `npm run test:multisucursal-sqlite`. Interruptor: `TECNO_CAJA_MULTISUCURSAL_DESACTIVAR=1`.
- `docs/MULTISUCURSAL-FASE-3.md` — Sucursales centrales: solo Emilio (`tecno-caja-admin`) y el contador (su portal) las crean; Emilio fija el límite por empresa. Reglas/rutas/pantalla únicas en `server/multisucursal/central/` y `js/sucursales-central-ui.js` (copiadas al portal con su `vendor-sync`). Pruebas con emulador: `npm run test:multisucursal-central`.
- `cloud/sync-api/` — Sync API (Cloud Run `tecno-caja-sync-api`, us-east1): la PC principal de cada sucursal se conecta con la **cuenta del dueño** (correo y contraseña de Tecno Caja, sin código; el código de equipo queda para soporte) y recibe su token (sin la llave de administrador de Firebase). Una PC de sucursal trabaja con la **licencia de la empresa** (plan/estado, `server/multisucursal/licencia-sucursal.js`) pero conserva **su propio id** (`TECNO_CAJA_LICENSE_UID`, doc con `sucursalDe`, oculto en la lista de negocios del panel): no hacer que adopte el id de la empresa (las sincronizaciones viejas atadas a ese id pisarían a la principal). PC nueva: asistente → multisucursal → "Conectar como sucursal" (`server/multisucursal/asistente-sucursal.js`). PC que ya trabaja: `server/multisucursal/enlace.js` + Configuración → "Sucursal conectada a Tecno Caja". `TECNO_CAJA_SYNC_URL` (vacío = el servicio desplegado; `off` lo apaga) / `TECNO_CAJA_SYNC_TOKEN` en `config/app.env`. Punta a punta: `npm run test:multisucursal-asistente` y `npm run test:multisucursal-enlace`.
- **Respaldos en la nube sin llaves en las PC** (`server/services/nube-intermediario.js` + `cloud/sync-api/lib/respaldos.js`): si el `app.env` no tiene llave de Backblaze, `r2-storage.js` sube, lista, baja y borra por la Sync API con enlaces firmados de 5 min para `backups/<licencia>/` (la PC prueba que es suya por su `deviceId` en `licencias/{id}.devices`). En una PC formateada, el dueño entra con su cuenta y ve y baja los respaldos de sus negocios. La clave que cifra los respaldos queda guardada en `respaldos_claves/{licencia}` (cifrada con `RESPALDOS_SECRETO` del servicio) y vuelve sola a una PC formateada. No cambiar `TECNO_CAJA_SECURITY_PASSWORD` de una PC sin clave propia: también define `config.security_password`. Pruebas: `npx jest test/respaldos` (en `cloud/sync-api`) y `node scripts/probar-nube-intermediario.js` (Backblaze real).
- `docs/MULTISUCURSAL-FASES-4-8.md` — Catálogo de la empresa (lo publica solo la principal), sincronización offline-first (`server/multisucursal/sincronizacion.js`: detectar por marcas → subir → bajar por cursor; nunca toca la ruta de la venta), usuarios por sucursal (solo viaja la huella de la clave), rangos NCF por sucursal (`ncf-central.js`), reglas de conflicto y matriz de aceptación. Reglas centrales en `server/multisucursal/central/sincronizacion-central.js` (copiada a la Sync API y al portal). Integral con dos POS reales: `npm run test:multisucursal-integral`. Al tocar la venta, el catálogo o NCF correr también `test:multisucursal-central`, `test:multisucursal-mariadb` y `test:e2e-lan`.
- `CONTRIBUTING.md` — Guía de desarrollo.
- `.env.example` — Todas las variables de entorno documentadas.

## Comunicación con Emilio

Emilio desarrolla **solo, tiempo completo**. Prefiere:
- Explicaciones claras en español.
- Acciones completas antes que muchas preguntas.
- Propuestas concretas con diffs, no abstracciones.
- Que se mantenga la app funcionando en cada paso — no hacer cambios grandes sin backup.
