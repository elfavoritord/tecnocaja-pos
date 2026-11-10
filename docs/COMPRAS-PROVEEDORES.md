# Compras de proveedores — Fase A (POS de escritorio)

Pedido: «PROMPT DEFINITIVO — Módulo Inteligente de Compras de Proveedores, e-CF y Portal de
Contadores» (Emilio, 2026-11-09). Se hace por fases; esta es la **A: compras sólidas en el POS**.
Decisiones de Emilio: OCR con IA con visión + OCR local de respaldo (fase B); Portal con la
arquitectura actual de colas en Firestore (fase C); sin precio al por mayor por ahora; la app
móvil no se toca.

## Qué hace

- **Subir factura de proveedor** (Compras → botón): XML e-CF del proveedor (E31, E32, E44, E45),
  Excel/CSV con la plantilla (un archivo puede traer muchas facturas: un borrador por factura,
  agrupadas por RNC + NCF), y foto o PDF (se guarda el documento y se completa a mano; la
  lectura automática es la fase B). Varios archivos a la vez con progreso y «Reintentar».
- **Registrar compra manualmente**: abre un borrador vacío.
- **Preparar compra** (pantalla completa): proveedor (existente o nuevo por RNC), comprobante,
  NCF/e-NCF, fecha, contado/crédito, datos del 606 y E41 (solo si el proveedor no da
  comprobante); líneas con su reconocimiento (Existente / Nuevo / Elegir / Servicio o gasto),
  cantidad, costo, descuento, ITBIS %, **precio de venta** (base + ITBIS, final con ITBIS
  incluido, exento con confirmación), **control de inventario Sí/No**, acciones masivas (modo de
  precio, inventario, margen, quitar), totales contra los de la factura. Guardar borrador,
  descartar, **Confirmar y registrar compra**.
- **Borradores**: lo subido o empezado sin registrar. Un borrador no toca inventario, cuentas
  por pagar, contabilidad ni DGII.
- **Recepciones**: con la modalidad «cuando el encargado confirma la mercancía», la compra y la
  deuda se registran igual y el inventario espera aquí (recepción total o parcial, cerrar con
  faltante, nota obligatoria si llega de más).
- **Configuración de compras** (por empresa): cuándo sube el inventario (al registrar /
  al confirmar), margen sugerido (sobre costo o venta) y si el precio se escribe con ITBIS.

## Reglas

- Una sola ruta para registrar: `server/services/compras/compras.service.js` (`registrar`). La
  usan el formulario clásico (`POST /api/purchases` con `items`), los borradores y, en la fase
  C, la cola del Portal de Contadores.
- **Idempotente** por `purchases.uuid` (índice único; el borrador usa su id): reintentos y clics
  dobles devuelven la misma compra. Probado con 5 registros simultáneos en SQLite y MariaDB.
- **Sin facturas duplicadas**: proveedor + NCF/e-NCF (también contra Gastos) y el mismo archivo
  (sha256) ya registrado. El proveedor se bloquea durante la transacción para que dos cajas
  no registren la misma factura a la vez.
- **Productos nuevos** se crean al registrar con `createProductInTransaction` (con el alcance
  multisucursal de siempre). Código: el de barras real si es válido (dígito de control), el de
  la factura si está libre, o `P000123`. **Nunca un código de barras inventado.** Sin precio
  válido → **Inactivo** (no se vende a costo cero).
- **Reconocimiento**: código de barras → código → equivalencia guardada con ese proveedor
  (`product_supplier_codes`, se aprende al registrar) → nombre idéntico normalizado. Lo demás
  son sugerencias que bloquean hasta elegir; medidas distintas («2 L» / «3 L») nunca se unen.
- **Precio**: el catálogo guarda la base sin ITBIS y la venta suma el ITBIS por línea
  (`js/compras-precios.js` reproduce ese redondeo). Con ITBIS incluido, si el final exacto no
  existe con 2 decimales (p. ej. RD$ 100 al 18 %), se propone el más cercano sin pasarse
  (99.99) y se avisa. La tasa sale de la configuración. **Exento** exige confirmar que la ley
  lo declara exento y queda en la auditoría.
- Cambiar precio, ITBIS o control de inventario de un producto **existente** exige el permiso
  **Productos**; registrar y crear productos nuevos, **Registrar compras**.
- **Inventario**: solo las líneas con control de inventario; servicios/gastos y productos sin
  control no suben existencias (antes la compra sumaba aunque `tracks_stock = 0`). Anular
  revierte solo lo recibido.
- **Costo**: sigue el último costo, ahora con historial (`product_cost_history`) y el cambio a la
  vista en la línea.
- **Totales**: si la factura trae totales (XML), una diferencia mayor de RD$ 1 bloquea; centavos
  de redondeo se registran con el total de la factura (`purchases.ajuste_redondeo`).
- **XML del proveedor**: se verifica la firma (si está alterada, bloquea) y que el comprador sea
  el RNC del negocio (aviso). **Una compra con e-CF del proveedor nunca emite E41** (ni B11).

## Comprobante de la compra (2026-11-09, pedido de Emilio)

- En «Preparar compra» se elige **quién da el comprobante**:
  - *El proveedor me dio comprobante*: se escribe su NCF o e-NCF y el **tipo sale del número**
    (E31, E32, E44, E45, B01, B02, B14, B15). Formato obligatorio: B + 10 dígitos o E + 12.
    Un tipo que no es de proveedor (p. ej. B11) se rechaza.
  - *El proveedor no da comprobante*: el negocio emite su **comprobante de compras**, y la lista
    muestra **solo los que tienen secuencia disponible** en Configuración → Comprobantes
    (`/api/fiscal-sequences/available`), **electrónicos primero**: E41 y luego B11. También
    «sin comprobante fiscal (solo registro interno)». E41 se firma y envía al registrar (como
    antes); **B11 toma el siguiente número de su secuencia dentro de la misma transacción**
    (`getNextNcfFromSequence`; si la compra falla, el número no se gasta). Ambos exigen RNC o
    cédula. Nunca los dos a la vez.
- **RNC o cédula** busca en el registro de la DGII del POS (`js/rnc-lookup.js`): por número
  (llena el nombre) o por nombre (lista para elegir). Si ese RNC ya es un suplidor del negocio,
  se usa ese suplidor.
- **Gastos** → «Emitir e-CF»: solo aparecen E41, E43 o E47 si tienen secuencia disponible.

## Errores corregidos de lo que había

1. El bootstrap ponía «Pagada» a las facturas de suplidor **anuladas** (volvían a sumar).
2. Las compras subían existencias de productos sin control de inventario.
3. `/api/suppliers` y `/api/supplier-invoices` no pedían sesión ni permiso.
4. El pago a suplidor desde la gaveta no quedaba en los pagos del suplidor.
5. El E41 desde compras no exigía RNC/cédula (y usaba una columna `cedula` que no existe).
6. Tras comprar no se refrescaba la caché de productos ni la app de reportes.

## Datos

Tablas nuevas (se crean solas; quedan en el respaldo integral V3, que descubre todas las
tablas): `purchase_drafts`, `purchase_documents` (archivo original en base64, máx. 5 MB, y su
extracción), `purchase_receipts`, `purchase_receipt_lines`, `product_supplier_codes`,
`product_cost_history`. Columnas nuevas en `purchases` (`uuid`, `estado_inventario`,
`documento_origen`, `encf_proveedor`, `codigo_seguridad`, `ajuste_redondeo`), `purchase_items`
(`tipo_linea`, `descripcion`, `unidad`, `codigo_proveedor`, `descuento`, `controla_inventario`,
`cantidad_recibida`, `producto_creado`; `product_id` pasa a opcional — en SQLite se rehace la
tabla dentro de una transacción comprobando el conteo) y `config` (`compras_*`).
`CORE_SCHEMA_VERSION` → `-19`. Permisos nuevos en el catálogo: `compras.recibir` y
`cuentas_por_pagar.pagar` (existía en el servidor, ahora se exige al abonar).

## Pruebas

- `npx jest tests/compras` (precios y reconocimiento, lectores XML/Excel/CSV, registro y
  recepción sobre SQLite real en memoria, migración de `purchase_items`).
- `node scripts/probar-compras.js` (SQLite), `--mariadb`, y `--ui` (Chrome con capturas).
- Al tocar compras, correr también `node scripts/probar-nueve-mejoras.js` y `npm run test:ecf-completo`
  (el E41 de compras pasa por aquí).

## Pendiente (fases siguientes)

- **B**: lectura de fotos/PDF (texto del PDF digital, IA con visión con clave del negocio, OCR
  local de respaldo) y lotes grandes en segundo plano.
- **C**: Portal de Contadores (cola `compras_pendientes` → `registrar`, permisos por empresa,
  modalidad directa / con aprobación).
- **D**: E41/E43/E47 con aprobación y estados, 606 TXT correcto en POS y Portal.
- **E**: costo promedio, presentaciones/conversiones, precio al por mayor si se pide.
- No se verifica todavía el estado del e-CF del proveedor en la DGII (se hará en la fase D).
