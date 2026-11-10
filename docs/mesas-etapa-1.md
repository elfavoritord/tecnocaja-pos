# MESAS: estado de implementación

## Correcciones del 2026-11-08 (pedido de Emilio)

- **Mesa ocupada sin productos**: antes, tocar una mesa creaba la cuenta en el servidor
  (vacía) y la mesa quedaba roja. Ahora la cuenta se crea al guardar el primer consumo
  (`guardarCuenta`: POST y luego PUT). Una cuenta sin productos no ocupa la mesa en el
  plano ni en la leyenda, y al volver sin consumo guardado se borra
  (`DELETE /api/mesas/cuentas/:id?version=N`: solo abierta, vacía y con la misma
  versión). Guardar el plano borra las cuentas vacías de elementos quitados y ya no
  bloquea por ellas.
- **Meseros/as**: usaba `window.prompt`, que no existe en la app de escritorio, así
  que el botón no hacía nada. Ahora abre una ventana propia del plano: lista, alta con
  teléfono opcional y «Quitar»/«Volver a activar» (`PATCH /api/mesas/meseros/:id`; no
  se borra porque las ventas lo nombran). La cuenta solo ofrece meseros activos.
  Elegir entre varias cuentas de una mesa también usa una ventana propia.
- **Guardar plano**: guarda, sale del editor al plano de mesas y avisa.
- **Avisos tapados**: el plano usa z-index 5000 y los avisos (`.toast`) también, así que
  los errores dentro de Mesas no se veían. `.toast` sube a 5200.
- **Comprobante tras cobrar una mesa**: el plano espera a que se cierre.

Prueba: `node scripts/probar-nueve-mejoras.js --ui` (y `--mariadb --ui`).

### Reservaciones (2026-11-09)

- Botón **Reservaciones** en el plano (para todos los usuarios de ventas): formulario (mesa,
  fecha, hora, nombre, teléfono, personas, nota) y lista de las pendientes por día con
  *Llegó* / *No vino* / *Cancelar*. Tabla `mesas_reservas` (se crea sola en el router).
- Reglas compartidas en `js/mesas-reservas.js` (servidor y plano): una mesa se ve
  **Reservada** (ámbar, en la leyenda) desde 2 horas antes de la hora hasta que la reserva
  se cierra; antes muestra la hora en borde. Misma mesa, mismo día, a menos de 2 horas:
  choque (409). No se reserva una hora pasada (15 min de margen) ni a más de un año.
  Fecha/hora en hora local (nunca `toISOString()`).
- Tocar una mesa reservada abre su ficha: *Llegó: abrir su cuenta* (la cuenta lleva el
  nombre de quien reservó), *Usar la mesa ahora (la reserva sigue)*, *No vino*, *Cancelar*.
- Una mesa con reserva pendiente no se puede quitar del plano ni dejar de vender.
- El plano se repinta cada minuto (sin interrumpir el editor ni una ventana abierta). Las
  ventanas del plano van fuera de él (`ventanaPlano`) para que repintar no las cierre.
- Pruebas: `npx jest tests/mesas-reservas.test.js`; flujo completo en
  `node scripts/probar-nueve-mejoras.js --ui` (y `--mariadb --ui`).

### Anticipo y constancia de la reserva (2026-11-09)

Pedido de Emilio: registrar con cuánto reservó el cliente, si ese dinero es consumible y
dar un recibo impreso. Si es consumible o no se elige **en cada reserva** (política del
negocio); el formulario recuerda la última elección en esa PC.

- **Datos** (todos opcionales): monto, forma de pago (efectivo, tarjeta, transferencia),
  referencia y «Consumible». Columnas `anticipo_*` en `mesas_reservas` (se agregan solas en
  el router). Reglas en `js/mesas-reservas.js` (`validarAnticipo`, `saldoAnticipo`,
  `anticipoAplicable`, `constancia`); dinero y caja en `server/services/mesas-anticipos.js`.
- **Caja**: el anticipo exige la caja abierta y entra en el turno de esta terminal. En
  efectivo crea el movimiento «Anticipo de reserva» (suma al efectivo esperado); con
  tarjeta o transferencia suma a lo cobrado por ese método. El cierre lo muestra aparte
  («Anticipos de reservas», `server/services/caja-arqueo.js` → `anticipos`).
- **Pantalla de Caja** (corrección del 2026-11-09: Emilio no lo veía como entrada de dinero):
  el movimiento sale en *Movimientos* como «Entrada»; *Resumen del Día* tiene la fila
  «Anticipos de reservas» (neto del turno, con el detalle por forma de pago) y el *Balance
  Final* lo suma; *Registro de Ingresos* lo incluye; el corte/cierre clásico lo cuenta en
  «Entradas» (`TIPOS_INGRESO_CAJA` en `js/app.js`). Los totales del turno vienen del servidor
  (`mesas-anticipos.totalesTurno` → `bootstrap.caja.activeSession.anticiposReserva`) y las
  rutas del anticipo devuelven `caja` (config, movimiento, anticipos) para refrescar al
  instante. El movimiento se guarda con la hora local (`nowRDString`), no `datetime('now')`
  (en SQLite sería UTC).
- **Consumible**: al llegar el cliente («Llegó») se abre **su propia** cuenta con
  `draft.reservaId`. Al cobrarla, Cobrar muestra «Anticipo de reserva −X» y «A pagar»; el
  cliente paga el total menos el anticipo. `POST /api/sales` recalcula el anticipo de la base
  (`paraCobro`) y rechaza el cobro si no coincide con el de la pantalla; los pagos
  (`payment-breakdown`) cubren solo lo que se paga ahora, así el efectivo no se cuenta dos
  veces. **La factura conserva su total** (ITBIS, NCF y e-CF no cambian); la venta guarda
  `reserva_id` y `reserva_anticipo`, y el recibo/factura muestran el anticipo y lo pagado
  ahora. Con anticipo no se vende a crédito ni contra entrega. Se usa una sola vez.
- **Lo que no se usa** (no consumible, no vino, cancelada o cuenta menor que el anticipo):
  el cajero elige *Devolver en efectivo* (sale de la gaveta con «Devolución anticipo de
  reserva»), *Devolver por tarjeta/transferencia* (fuera de la caja), *Se queda el negocio*
  o *Decidir después*. Lo pendiente aparece en Reservaciones → «Anticipos por resolver» (y
  en el botón del plano). Devolver exige permiso de devoluciones (o administrador).
- **Constancia**: al reservar se muestra la constancia (Nº, mesa, fecha y hora, personas,
  anticipo, consumible, estado y la nota de política) con *Imprimir*: térmica por ESC/POS
  (mismo formato por secciones que el cierre) o la hoja configurada. También desde la
  lista y la ficha de la mesa. Es informativa, no fiscal.
- **Cancelar o devolver la factura** de una cuenta con anticipo usa la lógica de siempre
  (`ajustes-venta`): el reembolso proporcional incluye la parte del anticipo y sale en
  efectivo; la reserva queda con su anticipo «descontado».
- Pruebas: `npx jest tests/mesas-reservas.test.js tests/mesas-anticipos.test.js
  tests/finanzas/caja-arqueo.test.js`; de punta a punta (caja, cobro, devolución y retención)
  en `node scripts/probar-nueve-mejoras.js` (`probarAnticiposReserva`) y con `--ui`.

### Biblioteca de figuras (2026-11-08)

`js/mesas-elementos.js` pasó de 24 a 73 figuras en 8 grupos: Mesas y asientos (mesas de 2 a
10, bistró, redonda de 6, mesa alta, reservado, mesa con sombrilla, barra con taburetes…), Bar y
cocina, Tienda y supermercado (góndola, nevera exhibidora, caja con banda, frutas, pallet,
perchero, probador…), Salud y belleza (sillón de barbería, lavacabezas, camilla…), Atención y
oficina, Estructura, Exterior y decoración (árbol, tarima, parqueo, extintor…) y Formas.

- Cada figura se dibuja en su tamaño por defecto (`viewBox` = ancho × alto), con sombra, brillo
  y contorno translúcido que sirve con cualquier color y en modo día o noche. La biblioteca usa
  `dibujo(tipo, color, { miniatura: true })` (se ve entera); en el plano llena su recuadro.
- Los 24 tipos anteriores se conservan (los planos guardados siguen valiendo); solo cambió su dibujo.
- Biblioteca en grupos plegables con contador; la búsqueda usa sinónimos (`palabras`: «refrigerador»
  encuentra la nevera). «Tipo de elemento» en Propiedades va por grupos y, si el elemento tenía el
  color de su figura, toma el de la nueva.
- Una figura nueva cae en un hueco libre de la parte visible (antes todas caían encima) y se llama
  «Mesa N» / «Barra N» / «Sillón N»… (es el nombre que sale en la cuenta y el recibo). Solo lo que
  vende, las zonas y los textos muestran el nombre al crearse.

## Actualización: flujo comercial de demostración

El editor incorpora una biblioteca vectorial 2D de 24 elementos para mesas,
asientos, comercio y atención: estanterías, vitrinas, mostradores, caja/recepción,
escritorios, puestos de servicio y estructura. Cada elemento conserva tipo, color,
capacidad y visibilidad del nombre en el JSON del plano; los planos anteriores
siguen conservando sus identificadores y geometría. Se añaden búsqueda de elementos
y zoom de 25% a 200% con Ajustar; el arrastre convierte píxeles a coordenadas del
plano según el zoom. No se cambian los datos del negocio ni su modo de facturación.

La rotación es configurable en grados, con botones para girar ±90° o restablecer
a 0°. Se guarda por elemento y sus etiquetas permanecen legibles.

El tamaño del nombre se configura por elemento (`textoEscala`) desde Propiedades.
El control «Icono completo» cambia proporcionalmente ancho, alto y texto del
seleccionado, manteniendo su centro cuando cabe en el lienzo. El antiguo ajuste
global de texto del navegador ya no se utiliza.

Selección del editor: Ctrl/Shift + clic añade o quita elementos; arrastrar sobre
el fondo selecciona con un recuadro y Ctrl+A selecciona todo. Ctrl+G agrupa,
Ctrl+Shift+G desagrupa, Ctrl+D duplica y Esc quita la selección. Las flechas mueven
una unidad (Shift: diez). El grupo persistente (`grupoId`) solo organiza el plano:
cada mesa mantiene su identidad y sus cuentas. El panel de selección múltiple
permite ampliar/reducir proporcionalmente todo el conjunto. Las operaciones
estructurales conservan los permisos y bloqueos de cuentas activas existentes.

Ctrl+Z deshace cambios del plano; Ctrl+Y o Ctrl+Shift+Z los rehace. Hay botones
visibles en el editor. El historial conserva hasta 80 cambios y limita su memoria;
un arrastre se registra como un paso completo. Se conserva al guardar durante
la sesión del plano, sin retroceder la versión de concurrencia del servidor.
Al escribir en un campo, Ctrl+Z conserva la edición de texto nativa del navegador.

La ventana de consumo centra los botones de acción. Atajos: G guarda,
P prepara precuenta y C abre cobro. Solo actúan con una cuenta activa,
fuera de campos de escritura y sin otro diálogo abierto; ignoran repetición por tecla sostenida y se retiran
al volver al plano.

Se añadieron cuentas generales persistentes por mesa, guardado con versión,
alta de meseros operativos y selección por cuenta. El catálogo visual existente
se mantiene activo durante el consumo. La precuenta usa la representación e
impresión existentes, lleva título pendiente de pago, mesero y aviso no fiscal.
No llama al endpoint de ventas ni reserva NCF.

El cobro envía referencia y versión de cuenta al endpoint de ventas existente.
En su misma transacción comprueba las líneas guardadas, reclama la cuenta y la
marca pagada al confirmar la venta. Un fallo revierte también ese cambio. Se
conserva la idempotencia de ventas, y una cuenta pagada rechaza un cobro nuevo.
El inventario se descuenta al facturar por el motor actual, no al guardar consumo.

La demo se ejecuta en puerto 3405 y usa una copia sin credenciales de nube y datos
SQLite propios. Su licencia es una fixture del entorno de pruebas existente;
no es una activación comercial. No se alteraron las licencias de la empresa real.

Pruebas: 8 casos de cuentas con node:test; integración HTTP con consumo, conflicto
de versión, cobro real, reintento y rechazo de segundo cobro; recorrido con navegador
de login, mesa, producto, precuenta y guardado. Las ventas de prueba permanecen
exclusivamente en la demo. No se ha verificado impresora física ni MariaDB/MultiCaja.

Pendientes: CRUD completo y asignación estable de meseros, grupos y cuentas
individuales en UI, auditoría por línea, reservas de inventario según políticas,
sincronización nube/LAN diferencial, reportes especializados y pruebas de carga.
El estado descrito a continuación corresponde a la entrega inicial del editor.

## Implementado

- Activación opcional desde Configuración → Apariencia, persistida en `config.mesas_enabled`.
- Botón MESAS a la izquierda de COMBOS.
- Editor en pantalla completa: crear figuras, mover con puntero, cambiar dimensiones,
  código y zona, duplicar, eliminar, previsualizar y guardar.
- API autenticada con edición restringida a administradores generales o de sucursal.
- Plano único por sucursal, identificadores persistentes y guardado transaccional
  condicionado a la versión. Un conflicto devuelve HTTP 409 sin sobrescribir.
- El editor no modifica el carrito de ventas.

## Pendiente: no es un módulo comercial terminado

No están implementados meseros, cuentas, consumos, precuenta, integración con cobro,
inventario ni sincronización nube. La pantalla lo indica expresamente.
También faltan fondo opcional, filtros operativos y actualización entre cajas.
La protección de elementos activos existe como validador, pero todavía no hay
cuentas persistidas que suministren esos identificadores al guardado del plano.
Debe conectarse antes de habilitar consumos.

## Migración

Al primer acceso autenticado a `/api/mesas`, el esquema se asegura con los mecanismos
existentes: agrega `config.mesas_enabled` si falta y crea `mesas_planos` si no existe.
No se ha ejecutado contra una base de producción durante este desarrollo.
Para retirar el acceso, desactivar el interruptor; conservar columna y tabla para
mantener los planos. No es necesario borrar datos para deshabilitar la función.

## Verificación

Comprobación sintáctica de servidor, rutas, aplicación e interfaz superada.
Ocho comprobaciones del validador ejecutadas con `node:assert/strict` superadas.
Jest: 8 pruebas aprobadas en `tests/mesas-plano.test.js`. Se corrigió la tabla
de parámetros de la prueba de eliminación antes de repetirla satisfactoriamente.
Faltan pruebas de API con base aislada SQLite/MariaDB, verificación visual,
concurrencia real y rendimiento con 100 mesas.

## Prueba manual del editor

Reiniciar el servidor con el código actualizado, iniciar sesión como administrador
y seleccionar una sucursal en la configuración actual del terminal. Activar el
interruptor en Apariencia. Abrir Ventas → MESAS → Crear mi plano, añadir figuras,
guardar y volver a abrir. Comprobar que el carrito normal se conserva.
Con un cajero, verificar que el editor no se ofrece y que PUT /api/mesas/plano
devuelve 403. Dos editores con la misma versión deben producir un único guardado
exitoso y un conflicto 409 en el segundo.
