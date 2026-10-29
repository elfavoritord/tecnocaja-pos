# Combos promocionales

Centro de Promociones → **Combos promocionales**. Un combo agrupa productos que ya existen en el inventario (por ejemplo 1 pollo, 2 refrescos y 1 papas) y se vende a un precio propio.

## Cómo está construido

| Pieza | Dónde |
|---|---|
| Reglas y cálculos (precio normal, costo, margen, disponibilidad, foto de la venta) | `server/services/combos.service.js` |
| API de administración (`/api/combos`) | `server/routes/combos.routes.js` (factory con dependencias) |
| Pantalla de administración | `js/combos.js` + panel `promo-panel-combos` en `index.html` + estilos en `css/modulos.css` |
| Venta, cobro pendiente, cancelación, devolución, app móvil | `server.js` (rutas existentes de ventas) |
| Ventas de cajas offline al sincronizar | `server/routes/offline.routes.js` (`_insertSaleToMain`) |
| Catálogo, carrito y tickets | `js/ventas.js`, `electron/thermal-printer.js` |

**El combo es un producto del catálogo.** Es una fila de `products` con `product_type = 'combo'`, `is_combo = 1` y `tracks_stock = 0`. Por eso aparece solo en el catálogo de Ventas, en la búsqueda, por código de barras, en el carrito, en la factura y en el e-CF. Su composición vive en `product_combo_items`.

### Tablas y columnas

- `product_combo_items`: `combo_product_id`, `component_product_id`, `quantity` (decimal, hasta 3 decimales), `sort_order`.
- `sale_items.combo_snapshot` (LONGTEXT): una foto en JSON del combo al momento de venderlo. Guarda el nombre, el código, el precio y los componentes con su cantidad, su costo y si controlaban existencia. La columna `item_name` guarda además el nombre del combo de ese día.
- `config.combo_invoice_display`: `agrupado` (por defecto) o `desglosado`.
- Esquema: `CORE_SCHEMA_VERSION` subió a `-14`. `ensureCombosExtensions()` corre al arrancar y antes de cada venta, y funciona igual en MariaDB y en SQLite.

## Venta e inventario

1. El cajero toca el combo y entra como **una línea**. Solo puede cambiar la cantidad; los componentes se ven, pero no se pueden modificar.
2. `POST /api/sales` carga la composición de los combos del carrito y, **dentro de la misma transacción** (después del lock de `config`), suma lo que pide **todo el carrito** por producto: combos más productos sueltos. Si algo no alcanza, responde 409 con la lista de lo que falta.
3. La línea del combo se guarda con su foto (`combo_snapshot`). Luego se descuenta cada componente por la cantidad de combos con `changeBranchInventoryStock(..., preventNegative: true)` y se registra un `registerInventoryMovement` de tipo `venta` con la nota "Salida por combo …". La fila del combo nunca se descuenta.
4. **Cancelar**, **devolver** y **cobrar un pedido pendiente** leen la foto de la venta, no la composición actual. Editar un combo no cambia ninguna venta anterior.
5. El reintento de la misma venta (`clientRequestId`) devuelve la venta ya registrada y no descuenta otra vez.
6. Un combo desactivado (`estado = 'Inactivo'`) ya no aparece en Ventas, y el servidor rechaza venderlo.

Lo que se corrigió en el camino: las devoluciones registraban el movimiento de inventario con columnas que no existen y fallaban en silencio. Ahora usan `registerInventoryMovement`.

**Protecciones:**
- No se puede borrar un producto que forma parte de un combo.
- Editar un combo desde Productos no le quita lo de combo.
- Un combo no puede llevar otro combo adentro.

## Facturas

- **Un solo artículo** (agrupado): una línea con el combo, la cantidad y el precio.
- **Desglosado**: debajo del combo van sus productos sin precio (por ejemplo "4 x Refresco" en una venta de 2 combos). Se ve en el ticket de pantalla, en el ticket térmico (ESC/POS) y en la factura A4 como nota de la línea ("Incluye: …"). El total no cambia.
- Se configura en la misma pestaña de Combos y aplica a las ventas nuevas. Un ticket viejo se reimprime con la composición que tenía el día de la venta.

### e-CF (DGII)

**El XML no se modificó.** El combo va como **una sola línea fiscal** con su nombre, cantidad, precio e ITBIS. Los componentes no son líneas facturables, así que ni el total ni el ITBIS se duplican (prueba en `tests/combos/combos-service.test.js`).

**Limitación:** si un combo mezcla productos gravados y exentos, una sola línea no puede representar los dos tratamientos. El formulario lo advierte y deja elegir el ITBIS del combo. Esto **no está validado con la DGII**; conviene confirmarlo con el contador del negocio.

## Imágenes

Usan el mismo almacenamiento que las fotos de productos: un archivo `.webp` en `uploads/productos` (`saveProductImageBuffer`), guardado en `products.image_local`. Nunca se guardan dentro de las ventas.

## Reportes

- **En Combos:** combos vendidos, ingresos, precio promedio, costo histórico (de la foto de cada venta), ganancia y margen, productos consumidos, última venta y cajeros. Las ventas canceladas no cuentan y las devoluciones se restan.
- **En los reportes de siempre:** el combo aparece como un producto más. Su ingreso se cuenta una sola vez y los componentes no reciben ingreso; su consumo se ve en los movimientos de inventario.

## Permisos

Administrar combos (crear, editar, cambiar precio o composición, activar, ver reportes) requiere el permiso `promociones` o ser administrador general, y se valida en el servidor. El cajero solo los vende. Cada cambio queda en `audit_logs`, módulo "Promociones".

## Respaldos

- El `.tcbak` incluye `product_combo_items`.
- Al restaurar productos se vacía la composición vieja, aunque el respaldo sea de antes de los combos. Así no queda apuntando a productos que ya no son.
- El reinicio de fábrica y la importación legacy también la limpian.

## Sincronización y límites conocidos

- **Multisucursal:** los combos quedan **locales a cada PC** (`alcance_empresa = 'local'`). La central de la Sync API todavía no transporta los componentes; un combo publicado llegaría vacío a la sucursal y se vendería sin descontar nada. Cada sucursal arma sus combos con sus productos. Para distribuirlos desde la principal hace falta:
  1. agregar los componentes (por `uuid`) a `datosProducto` en `sincronizacion-central.js`;
  2. publicarlos y aplicarlos en `server/multisucursal/sincronizacion.js`;
  3. volver a desplegar la Sync API.
- **Cajas offline:** sin conexión, la caja vende el combo con su caché local, que no descuenta los componentes de esa caché. Al sincronizar, la principal guarda la composición de ese momento y descuenta los componentes.
- **App móvil de reportes:** si vende un combo, al importar la venta se descuentan sus componentes.
- **Tienda online:** si se publica un combo, se cobra con `POST /api/sales`, que valida la existencia de los componentes.

## Pruebas

```bash
npx jest tests/combos tests/thermal-printer-receipt.test.js
npm run test:combos-e2e   # servidor real: MariaDB, SQLite y pantalla en Chrome
```
