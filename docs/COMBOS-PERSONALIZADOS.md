# Combos personalizados

En Ventas → **COMBOS**, el cajero escribe el **precio que acordó con el cliente**, que ya trae el ITBIS incluido, y elige **libremente** los productos del combo. El sistema no impone precios ni límites. En la factura, el combo sale como **un solo concepto** a ese precio, con la indicación "Impuesto incluido".

Es otra cosa que los **combos promocionales** (`docs/COMBOS-PROMOCIONALES.md`). Esos tienen composición fija y se cobran como una sola línea fiscal.

> Historia: la primera versión del 2026-11-04 exigía que la suma de los precios normales diera exacto un precio fijo de combo. Ese mismo día Emilio la cambió por esta: **precio libre** con ITBIS incluido, repartido entre los productos.

## La decisión que lo sostiene todo

**El combo no es un producto. En la venta es un grupo de líneas normales, y su precio se reparte entre ellas.**

Cada producto del combo entra como **su propia línea de `sale_items`**, con su cantidad real. El motor (`js/combos-personalizados-motor.js`) le asigna su parte del precio. Cada línea queda con su **base** y su **ITBIS** según la tasa del producto, y la suma de todas las líneas, ya con ITBIS, es el precio elegido.

| Tema | Resultado |
|---|---|
| ITBIS | El precio elegido **ya lo incluye**: nunca se agrega encima. Cada línea lleva el ITBIS de su tasa (18 %, 16 % o exento) y no se cobra dos veces. |
| e-CF / XML | **El generador no cambió.** Va una línea por producto con su parte del precio y su tasa. `MontoTotal` = precio del combo (+ lo demás de la venta) y `TotalITBIS` es la suma de las líneas. Probado contra el DGII falso y los XSD. |
| Trazabilidad fiscal | Cada línea guarda el producto, la cantidad, su parte del precio (`price`), el ITBIS (`tax_rate`, `tax_amount`) y el **precio de catálogo** del producto en `original_price`. La auditoría registra cada combo vendido con su precio y el valor normal de lo que llevó. |
| Inventario | Ruta de siempre por línea: `changeBranchInventoryStock(preventNegative)` + `registerInventoryMovement`, con la nota "· combo <nombre>". Sale la cantidad real de cada producto. |
| Cancelar, devolver, cobrar pendientes | Rutas de siempre. Si se devuelve un producto del combo, se reintegra ese producto y se devuelve **su parte** del precio. |
| Reportes de siempre (productos, impuestos, caja, cajero, sucursal) | Cuadran sin cambios: no hay una línea "combo" con ingreso propio. |

## Cómo se reparte el precio

`repartirCombo({ precio, seleccion, tasa })` lo usan la pantalla y el servidor, con el mismo código:

1. **Parte de cada producto:** proporcional a su precio normal con ITBIS (precio de catálogo × cantidad, como en el carrito). Se usa el método del mayor residuo, en centavos enteros, así que las partes suman el precio exacto.
2. **Base e ITBIS:** de su parte se saca la base para que `base + redondeo(base × tasa)` dé esa parte. Esa cuenta usa **los mismos pasos que el carrito** (`calcItemTotal`), `POST /api/sales` y el e-CF (`buildTotals`).
3. **Precio unitario de 2 decimales:** si la base no se divide exacto entre la cantidad, la línea se parte en **dos filas del mismo producto** (por ejemplo, 2 × 33.33 y 1 × 33.34). Así `cantidad × precio = monto de la línea`, como pide el e-CF, sin descuentos.
4. **Ajuste fino:** los centavos que sobran o faltan por el redondeo se corrigen moviendo centavos de base entre líneas. Si hace falta, también se usa otra forma de partir una línea.

**El único caso sin el centavo exacto:** **una sola unidad de un solo producto gravado.** Con ITBIS por línea, hay totales que no existen; por ejemplo, 84.74 + 18 % = 99.99 y 84.75 + 18 % = 100.01, así que 100.00 no sale. Ahí el cliente paga **1 centavo menos, nunca más**, y la pantalla lo avisa ("Queda en RD$99.99"). La prueba recorre 1,000 combos al azar y confirma que cualquier otro caso sale exacto.

**ITBIS de monto fijo:** dentro de un combo, un producto con ITBIS fijo (por ejemplo, RD$20 sobre RD$80) usa la **tasa de la DGII más cercana** (0/16/18 %). Es el mismo criterio que ya aplica el e-CF a esos productos (`server/services/tax-catalog.js`).

## Reglas

- **Precio:** libre, mayor que 0 y con ITBIS incluido. Puede estar por debajo o por encima del valor normal de lo elegido; el cajero ve ese valor solo como referencia.
- **Productos:** cualquier cantidad de los marcados "Disponible para combos", activos y vendidos **por unidad**. Los de peso o medida y los combos promocionales no se pueden marcar. Con "Permitir elegir cantidades" apagado, va una unidad de cada producto.
- **Combos sugeridos (opcionales):** en Promociones → Combos personalizados se crean atajos con nombre, un precio de partida opcional, color e imagen. En Ventas sirven para llenar el nombre y el precio, y el cajero los puede cambiar. Sin sugerido, el combo se llama "Combo personalizado".
- **Ofertas y descuentos:** dentro del combo no aplican las ofertas del producto ni el descuento de línea. El descuento general de la factura y el redondeo siguen funcionando como hoy, sobre toda la factura.
- **E44 y E46 (sin ITBIS):** se bloquean en pantalla y en el servidor, porque el precio del combo incluye ITBIS.

## Dónde está cada cosa

| Pieza | Archivo |
|---|---|
| Motor de reparto (navegador + servidor) | `js/combos-personalizados-motor.js` |
| Validación de la venta, reporte y combos sugeridos | `server/services/combos-personalizados.service.js` |
| API `/api/combos-personalizados` (factory con dependencias) | `server/routes/combos-personalizados.routes.js` |
| Pantallas: Apariencia, casilla del producto, Promociones y el selector de Ventas (precio → productos) | `js/combos-personalizados.js` + `index.html` + `css/modulos.css` y `css/ventas.css` |
| Carrito (encabezado del combo, líneas bloqueadas) e impresión agrupada | `js/ventas.js` (`isCustomComboSaleItem`, `buildCustomComboSaleItem`, `renderCustomComboHeaderRow`, `groupCustomComboReceiptItems`) |
| Validación y precio de cada línea dentro de la venta | `server.js` → `POST /api/sales` llama `combosPersonalizados.prepararVenta()` dentro de la transacción, después del lock de `config` |
| Venta de una caja offline al sincronizar | `server/routes/offline.routes.js` → `_insertSaleToMain` |

### Validación en el servidor (`prepararVenta`)

Si ninguna línea trae `comboPersonalizado`, devuelve `null` **sin hacer ninguna consulta**: la venta tradicional queda idéntica. Si trae combos:

- **Revisa:** que la función esté activa; precio válido e igual en todas las líneas del combo; producto habilitado, activo y vendido por unidad; cantidad entera; sin descuento propio.
- **Recalcula** el reparto con los **precios de catálogo de la base** y lo compara fila por fila con lo que mandó la pantalla (producto, cantidad, precio y tasa). Si no coincide, responde 409: el reparto pudo ser manipulado o cambió un precio de catálogo.
- **Usa sus propios números:** la línea se guarda con el precio del reparto del servidor, nunca con el del body, y con el ITBIS en %.
- **Deja rastro:** escribe en la auditoría "Combo personalizado vendido · <factura> · <nombre> · RD$ precio (valor normal RD$ …)".

## Base de datos

`CORE_SCHEMA_VERSION` está en `-15`. `ensureCustomCombosExtensions()` corre al arrancar y antes de una venta con combos, en SQL portable (MariaDB y SQLite).

- `config`: `custom_combos_enabled` (0), `custom_combos_show_images` (1) y `custom_combos_allow_qty` (1).
- `products.combo_personalizado`: 0 por defecto, y solo cambia por la API.
- `custom_combos`: los combos sugeridos (nombre, descripción, precio sugerido, estado, color, imagen y orden).
- `sale_items`: `custom_combo_key`, `custom_combo_id`, `custom_combo_name` y `custom_combo_price` (el precio elegido). La marca se escribe con un `UPDATE` aparte después del `INSERT` de siempre. `original_price` guarda el precio de catálogo; los reportes de promociones no lo cuentan porque filtran por `promotion_id`.
- Respaldos `.tcbak`: `custom_combos` se respalda y se restaura. El reinicio de fábrica la vacía.

## Factura impresa

`groupCustomComboReceiptItems()` cambia **solo las filas que se muestran** en el ticket en pantalla, la térmica ESC/POS, la hoja A4 y la factura A4 formal / representación del e-CF:

```
Combo especial        Incl.  1   500.00   500.00
  - Impuesto incluido                  76.27
  - 2 x Hamburguesa
  - 3 x Papas
```

En la A4 el concepto se llama "Combo especial · Impuesto incluido" y la nota dice "ITBIS incluido: RD$ 76.27 · Incluye: …". Los totales de abajo (subtotal, gravado, exento, ITBIS y total) siguen saliendo de las líneas reales.

`electron/thermal-printer.js` y `js/factura-plantillas.js` **no cambiaron**, así que no hace falta `vendor-sync` del portal.

## Multisucursal, LAN, offline y Firebase

- **Multicaja LAN:** todas las cajas usan la misma base y la misma validación.
- **Multisucursal:** la configuración, los sugeridos y la marca de producto quedan **locales a cada PC**, porque la Sync API no transporta `combo_personalizado`. No se desplegó nada.
- **Caja offline:** la pantalla guarda una copia del estado (`localStorage`). Al sincronizar, la principal guarda la marca del combo y el ITBIS de cada línea, sin rechazar nada porque la venta ya ocurrió.
- **Firebase y Centro de Control:** sin cambios; reciben productos normales.

## Fuera de alcance

- La app móvil y Android Pro no venden combos personalizados.
- La tienda online no los publica.
- La Empresa de Servicios no tiene pantalla de venta.

## Pruebas

```bash
npx jest tests/combos-personalizados      # motor (contra el carrito real, 1000 combos al azar) + rutas y prepararVenta en SQLite
npm run test:combos-personalizados-e2e    # servidor real MariaDB y SQLite + pantalla en Chrome
npm run test:ecf-completo                 # incluye un combo de RD$250 (gravado + exentos) en E32 y E31, validado contra el XSD
```

Al tocar la venta, el carrito, la impresión o el redondeo del ITBIS, corre también `npm run test:combos-e2e`, `test:e2e-lan` y `test:pantallas`.
