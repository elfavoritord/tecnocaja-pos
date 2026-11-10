# Nueve mejoras financieras — integración

Estado al 2026-11-08: implementadas en el POS de escritorio (no en Android Pro), probadas de punta a punta con la app real en SQLite y MariaDB de laboratorio. **Sin commit, sin instalador y sin publicar.**

Regla común: todo cálculo de dinero va en centavos enteros (`js/pos-money.js`), cada operación crítica es una transacción con su auditoría dentro, y la factura original nunca se borra ni se sobrescribe.

## Estado por mejora

| # | Mejora | Dónde vive | Estado |
|---|---|---|---|
| 1 | Propina legal 10 % | `js/propina-legal.js` (motor compartido), `js/propina-config.js`, `POST /api/sales`, `GET /api/reports/legal-tips`, `js/reportes-financieros.js` | Hecha. Solo consumo en el local (mesa, o mostrador marcado «Consumo en el local»); nunca delivery ni para llevar. Alcance configurable: «todo lo consumido» (por defecto) o «solo productos marcados» (`config.legal_tip_scope`). Después de descuentos, sobre la base sin ITBIS. Se ve en el resumen del carrito, Cobrar, ticket térmico, A4 y precuenta. e-CF: impuesto adicional `001` (E31 y RFCE). |
| 2 | Clientes: reporte general y estado de cuenta | `server/services/client-statement.js`, `server/routes/clientes-creditos.routes.js`, `js/clientes-estado-cuenta.js` | Hecha. Reporte general (límite, utilizado, disponible, pendiente, facturas pendientes y vencidas, estado; filtros y sucursal; PDF/A4/Excel). Estado de cuenta cronológico con saldo por movimiento, estado y días de atraso por factura, detalle de factura, PDF/Excel y compartir por WhatsApp solo con confirmación. |
| 3 | Crédito en el pago mixto | `server/services/payment-breakdown.js`, `js/ventas.js`, `js/cobro.js` | Hecha. Cuatro métodos o 100 % crédito; con crédito la suma debe ser exacta; cliente registrado obligatorio; límite validado en el servidor con bloqueo; saldo/límite/disponible en Cobrar. Una venta, una factura. |
| 4 | Cancelación y notas de crédito | `server/services/ajustes-venta.js`, `server/routes/ajustes-venta.routes.js`, `js/ajustes-venta.js` | Hecha. Reemplaza el botón "Devolución" (Caja → "Cancelar / Nota de crédito"; Movimientos → "Cancelar o emitir nota de crédito"). |
| 5 | Auditoría global | `server/services/audit-event.js`, `server/routes/auditoria.routes.js`, `js/auditoria.js` | Hecha. Movimientos → "Auditoría completa". |
| 6 | Teléfono obligatorio con formato | `js/cliente-telefono.js`, `insertClientRow` en `server.js` | Hecha. Sin verificación externa. |
| 7 | ITBIS separado | `server/services/itbis-separado.js`, `GET /api/reports/itbis-separado`, `js/itbis-separado.js` | Hecha. Reportes → DGII, debajo del resumen fiscal. |
| 8 | Cierre seguro con denominaciones | `server/services/caja-arqueo.js`, `server/routes/caja-segura.routes.js`, `js/caja-segura.js`, enganche en `POST /api/cash/close` | Hecha. |
| 9 | Aperturas de gaveta con motivo | `server/routes/caja-segura.routes.js` (`/api/caja/gaveta`), `js/caja-segura.js` | Hecha. |

## Reglas que conviene conocer

**Efectivo esperado del turno** (`caja-arqueo.resumenTurno`): fondo inicial + efectivo de las ventas del turno (componente exacto del pago mixto, ya sin la devuelta) + abonos de clientes en efectivo + entradas − gastos − pagos a suplidores − devoluciones/cancelaciones en efectivo − retiros. Tarjeta, transferencia y crédito van en sus propios bloques. Un mixto anterior a esta versión (sin desglose) no se suma al efectivo y se avisa. El cierre ya no usa `cash_sessions.current_amount`; ese campo se sigue actualizando para las pantallas viejas.

**Arqueo a ciegas**: «Cierre de caja seguro» se activa en Configuración → Ventas y Facturación → Facturación (solo el administrador; se guarda al instante con `PUT /api/caja/config`). Con la caja abierta:
- la pantalla de Caja oculta a **todos** el monto de la caja y el «Resumen del Día» (es la pantalla que mira el cajero aunque entre un administrador); los montos se tapan en el DOM, no con un difuminado;
- un conteo durante el turno (Abrir gaveta → Conteo de efectivo) no muestra el esperado: `POST /api/caja/arqueos` guarda esperado y diferencia pero solo devuelve lo contado (`ciego: true`), también al administrador. La barra de Caja ya no tiene «Corte de caja» (pedido de Emilio): solo queda «Cerrar Caja»; `openCashCorteModal` sigue existiendo y con cierre seguro abre el conteo a ciegas;
- Reportes no abre para quien no ve reportes de caja (`veTurnoAbierto` de `GET /api/caja/config`, que decide el servidor: el permiso local `ver_reportes_caja` da verdadero al cajero por el mapa de permisos viejos);
- al cerrar se cuenta por denominaciones y entonces sale el reporte completo (ventas por método, esperado, sobrante o faltante, arqueos del turno).

`GET /api/caja/turnos/:id/resumen` de un turno abierto solo responde a quien ve reportes de caja. No hay aprobaciones nuevas: la diferencia se muestra al cerrar y queda en la auditoría.

**Quitar propina y monto mínimo**: en Cobrar, junto a «Agregar productos» y «Aplicar descuento», aparece «Quitar propina» cuando la venta la lleva; quita la propina solo de esa venta (`sinPropina` en el cuerpo de la venta, `sales.legal_tip_waived` y `legal_tip_waived_amount`, auditoría con `propinaQuitada`). El reporte de propinas lista esas ventas aparte. La configuración tiene un monto mínimo opcional (`config.legal_tip_min_amount`, 0 = siempre) medido sobre el consumo sin ITBIS que lleva propina, ya con descuentos. La ley (art. 228 del Código de Trabajo) no fija un mínimo: es política del negocio.

**Propina y Mesas**: la cuenta de una mesa entra al carrito como pedido «Mesa» y lo conserva al abrir Cobrar (antes `resetBillingCheckoutDraft` la devolvía a mostrador y la propina se perdía). Cobrar muestra «Mesa» cuando la venta es de una mesa o el negocio ofrece ese tipo de pedido. Cliente y servidor calculan con el mismo alcance; si no coinciden, la venta se rechaza (409) en vez de guardar una propina distinta.

**Mesas sin cobrar**: no se cierra la caja si en la sucursal hay cuentas de Mesas con consumo guardado y sin cobrar (`mesasConDeuda` en `caja-segura.routes.js`). Se comprueba antes de pedir el conteo (`GET /api/caja/cierre/verificar`, la pantalla lista las mesas y lleva a Mesas) y otra vez dentro de la transacción del cierre (409). Una cuenta abierta vacía no bloquea. Excepción multicaja: si otra caja de la misma sucursal sigue abierta, el cierre se permite porque esas mesas se pueden cobrar allí.

**Comprobante tras una venta de mesa**: el plano de Mesas va por encima de toda la app (z-index 5000) y `Mesas.volverTrasVenta` lo abría con el comprobante de la venta a la vista, que quedaba tapado. Ahora `volver()` espera a que se cierre el comprobante (`#receipt-overlay`) antes de abrir el plano.

**Comprobantes en Cobrar**: a la vista Ticket, E32 (consumo) y E31 (crédito fiscal, pide RNC); en «Más», la serie B (B02, B01, B14, B15, B16, B03, B04) y E44/E45/E46. No hay botón «e-CF» genérico. Solo se elige lo que tiene secuencia: `GET /api/fiscal-sequences/available` devuelve la serie B con rango y los e-CF emitibles (`ecf.service.availableSaleTypes`: emisor activo, servicio permitido y rango usable, mismas reglas que `assertSaleHasSequence`); lo demás se ve apagado y avisa por qué. Si el comprobante preferido del negocio no tiene secuencia, la venta abre en Ticket con un aviso. Con e-CF activo el preferido B02/B01 se convierte en E32/E31. El servidor rechaza (422 `ECF_NO_ACTIVO`) una venta con e-CF si el emisor no está activo; antes se guardaba y el e-CF quedaba en error.

**Animación "analizando"**: cada paso se marca cuando termina de verdad (cálculo local, cierre en el servidor, validación de que los métodos suman el total, armado del reporte). No hay esperas artificiales ni IA externa.

**Gaveta**: `conteo` (arqueo sin cerrar), `cambio` (solo mueve saldo si entra y sale distinto), `retiro` (descuenta del esperado, pide destino, comprobante), `consumo` (descuenta inventario, no abre la gaveta ni toca dinero), `gasto` (descuenta del esperado), `otro` (descripción). Primero se registra el motivo y después se manda la orden física; el resultado (abierta, fallo, sin gaveta) queda en el evento. La apertura automática al cobrar queda como "con venta". Sin un sensor compatible no se detectan aperturas con llave: solo órdenes del software.

**Cancelar / nota de crédito** (`ajustes-venta.clasificar`):

| Documento | Cancelar | Nota de crédito |
|---|---|---|
| Ticket interno | Cancelación interna documentada | Interna `NCI-########` |
| Serie B (B01, B02…) | Anular el NCF (formato 608) o nota B04 por el total | B04 con referencia al NCF |
| e-CF aceptado | E34 código 1 | E34 código 3 (o 1 si es la primera y cubre todo) |
| e-CF pendiente | No (esperar respuesta DGII) | No |
| e-CF rechazado | Cancelación interna, sin E34 | No |

El importe de la nota incluye ITBIS y la propina proporcional; la última nota completa exactamente lo que queda. Se reparte entre lo que se cobró: el crédito pendiente se rebaja, el efectivo sale de la caja con su movimiento (o queda "sin reembolso"), tarjeta y transferencia se informan como reembolso fuera de la gaveta. Cada línea decide si regresa a inventario (dañados y servicios no). Pasados 30 días la nota no rebaja el ITBIS (`tax_affects = 0`; en la E34 `IndicadorNotaCredito = 1`). Una factura con notas parciales no se anula: se emite otra nota por el resto. Reintento: `POST /api/ventas/ajustes/:id/reintentar` reutiliza el mismo origen y no firma ni envía dos veces.

**ITBIS separado**: cada venta cuenta una vez por su documento (no existe conversión de ticket a comprobante). Vistas: no electrónico (tickets internos + serie B, por separado), e-CF (aceptados y pendientes; rechazados aparte y fuera de los totales; contingencia), consolidado. Notas y anulaciones del período restan como ajustes. Si el negocio tiene e-CF activo y hay tickets internos, el reporte lo dice: no sustituye la emisión ni la declaración.

**Auditoría**: cada evento tiene `event_id` (UUID) y guarda empresa, sucursal, caja, turno, equipo, usuario, rol, módulo, acción, resultado, motivo, referencia, monto, antes y después (sin contraseñas, tokens, PIN ni certificados: `audit-event.scrub`). Se guarda en UTC y se muestra en hora de RD. Desde la app es solo lectura (append-only); solo el reinicio de fábrica y la restauración reemplazan la tabla, como antes. Se registran los logins fallidos y los accesos denegados (sin el cuerpo de la petición). Alcance: administrador general (o permiso `auditoria_global`) todo; administrador de sucursal solo su sucursal.

**Teléfono**: obligatorio al crear o editar desde las pantallas; RD exige 809/829/849 y se guarda `+1XXXXXXXXXX`, se muestra `809-555-1234`; otro país exige `+` y 8–15 dígitos. Teléfono repetido = advertencia, no bloqueo. El bot de WhatsApp y los documentos de Empresa de Servicios crean clientes con `origen: 'sistema'`: se normaliza si es válido y, si no, se guarda como llegó.

## Base de datos

Aditiva, compatible con SQLite y MariaDB (`server/services/finance-migration.js`). `CORE_SCHEMA_VERSION` sube a `-17` (`ensureNuevasMejorasSchema`, en serie después del resto); las rutas también aseguran el esquema al usarse.

- Tablas nuevas: `cash_counts` (arqueos y conteo del cierre), `cash_drawer_events` (aperturas con motivo). También en `db/schema.sql`.
- `sales`: `legal_tip_amount`, `consumed_here`, `financial_version`, `cash_amount`, `card_amount`, `transfer_amount`, `credit_amount`, `credit_adjustment`, `credit_due_date`, `payment_details`, `card_status`, `transfer_status`, `transfer_confirmed_by/at`, `delivery_cash_session_id`, `cancel_refund_mode`, `cancel_cash_movement_id`.
- `sale_items`: `legal_tip_amount`, `general_discount_amount`. `products.legal_tip_eligible`. `clients.phone_country`. `config.legal_tip_enabled`, `config.secure_cash_close`.
- `sale_returns`: `cash_session_id`, `restock`, `tax_returned`, `legal_tip_returned`, `adjustment_kind`, `fiscal_document`, `request_id` (único), `refund_breakdown`, `tax_affects`, `credit_reduction`. `sale_return_items`: `restocked`, `net_amount`, `tax_rate`, `tax_amount`, `legal_tip_amount`.
- `cash_closings`: `denominations_json`, `report_json` (el reporte tal como se cerró), `secure_mode`, `card_terminal_total`.
- `audit_logs`: `event_id` (único), `business_id`, `cash_session_id`, `device_id`, `result`, `reason`, `before_json`, `after_json` y el contexto de sucursal/caja/cliente/documento.

El respaldo V3 copia todas las tablas que encuentra, así que las nuevas viajan y se restauran con sus IDs (verificado en la prueba).

## Rutas nuevas

`/api/caja`: `GET|PUT /config`, `GET /turnos/:id/resumen`, `POST /arqueos`, `POST /gaveta`, `PATCH /gaveta/:uuid/resultado`, `GET /gaveta`, `PATCH /pagos/:saleId` (confirmar/rechazar transferencia, reversar tarjeta).
`/api/ventas`: `GET /:factura/ajustes`, `GET /ajustes/:id`, `POST /ajustes/:id/reintentar`. `POST /api/sales/return` y `PATCH /api/sales/:factura/cancel` ahora viven en `ajustes-venta.routes.js` (los handlers viejos se quitaron de `server.js`).
`/api/auditoria`: `GET /` (filtros, páginas, críticos), `GET /:id`.
`GET /api/reports/itbis-separado`, `GET /api/clients/receivables-report` (ahora `{ clientes, totalPorCobrar, fechaCorte, … }`), `GET /api/clients/:id/statement/invoice/:saleId`.

## Pruebas

Resultado del 2026-11-08 (todo verde):

- `node scripts/probar-nueve-mejoras.js` (SQLite) y `--mariadb`: app real, 14 bloques (caja, gaveta, arqueo, cierre seguro, teléfono, propina, notas, cancelaciones, crédito y estado de cuenta, ITBIS, serie B con B04 y 608, auditoría y permisos, respaldo y restauración). Con `--ui` abre cada pantalla nueva en Chrome sin cabeza, cierra la caja por la interfaz y falla ante cualquier error de JavaScript (capturas en la carpeta del laboratorio).
- `npx jest` completo (incluye `tests/finanzas`, 27 pruebas nuevas) y `node --test tests/*.node-test.cjs` (45).
- `npm run test:ecf-completo`: POS y Servicios en MariaDB y SQLite, todos los XML contra los XSD. Se agregaron E31 y E32 con propina (impuesto adicional 001, total 128). Dos ajustes de la prueba: la venta de prueba ahora manda el subtotal como el carrito (con el descuento de línea ya aplicado) y la DGII falsa suma `MontoImpuestoAdicional` al total.
- `npm run test:e2e-lan` (multicaja real): 44/44.
- `node scripts/probar-finanzas-negocios.js` (la de la sesión anterior; actualizada al nuevo formato del reporte de clientes).
- Al tocar `js/factura-plantillas.js` o `electron/thermal-printer.js`: `node tecno-caja-contadores/scripts/vendor-sync.js` (las pruebas de copia lo exigen).

## Validar con el contador

1. Propina legal: en qué modalidades aplica (hoy: mesa, o mostrador marcado "consumo en el local"; delivery y para llevar nunca) y que se calcule después de descuentos sobre la base sin ITBIS.
2. Notas de crédito pasados 30 días: hoy rebajan el monto pero no el ITBIS (`IndicadorNotaCredito = 1` en la E34; mismo criterio para B04).
3. Anular un NCF serie B (608) frente a emitir B04: el sistema deja elegir; el criterio de cuándo usar cada uno es del contador.
4. e-CF rechazado: la venta se cancela sin nota y se emite un e-CF nuevo; la secuencia rechazada queda usada.
5. Tickets internos en un negocio obligado a e-CF: el reporte los señala; el procedimiento de emisión o regularización es del contribuyente.
6. e-CF con propina: va como impuesto adicional `001` (10 %) dentro de `MontoTotal`. Pasa los XSD y la DGII falsa; falta confirmarlo con la DGII real (ambiente de certificación) antes de usarlo en producción.

## Pendientes y límites conocidos

- La anulación de secuencias e-NCF no usadas (servicio ANECF de la DGII) no está implementada: un e-CF pendiente no se cancela hasta que la DGII responda.
- Las ventas que sincroniza una caja offline (`offline.routes.js`) llegan sin el desglose exacto del pago (`financial_version = 0`) y se tratan por su método, como antes.
- Multisucursal: las tablas nuevas son locales de cada PC; la Sync API central no transporta arqueos, aperturas ni notas.
- El portal del contador recibió la copia nueva de `factura-plantillas.js` y `thermal-printer.js` (`vendor-sync`); no necesita release para seguir igual.
- Falta la prueba manual con impresora térmica, gaveta física y la DGII real.
