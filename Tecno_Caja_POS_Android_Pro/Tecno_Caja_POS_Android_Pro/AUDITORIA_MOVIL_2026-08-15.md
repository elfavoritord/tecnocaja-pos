# Auditoría Tecno Caja POS Móvil - 2026-08-15

## Alcance ejecutado en esta fase

- Wizard inicial: navegación, validaciones, rubros, configuración automática y persistencia.
- Arquitectura de capacidades por tipo de negocio.
- Pantalla fiscal: permisos, modo local y acceso remoto seguro.
- Productos con lotes y vencimiento, incluyendo datos de medicamentos.
- Punto de venta: bloqueo de productos vencidos y consumo FEFO.
- Inventario: alertas de vencimiento y trazabilidad de lotes vendidos.
- Respaldos: inclusión de variantes, lotes, componentes y lotes consumidos.
- Navegación y visibilidad de módulos según rol/capacidad.

## Errores encontrados y corregidos

1. El selector de rubros del wizard no tenía altura máxima y cubría Atrás/Siguiente.
   Se limitó a 320 px, se hizo expandible y se agregó el catálogo completo.
2. El wizard validaba el formulario en el resumen, cuando los campos anteriores ya no estaban montados.
   Ahora valida cada paso y vuelve a validar todos los controladores antes de crear la empresa.
3. La pantalla fiscal leía y escribía directamente un documento de Firestore rechazado por reglas.
   Se reemplazó por funciones autenticadas y se añadió fallback a configuración local.
4. Un fallo remoto fiscal ocultaba todo el monitor local.
   Ahora carga el contenido local y muestra una advertencia no bloqueante.
5. Los rubros eran nombres sin comportamiento persistente.
   Ahora cada perfil activa capacidades y estas controlan módulos y formularios.
6. Los productos tenían una tabla de lotes incompleta y ninguna defensa de venta vencida.
   Se completó el esquema y se añadieron controles en selección, carrito, checkout y transacción.
7. Las anulaciones restauraban inventario general, pero no el lote consumido.
   Ahora restauran exactamente las asignaciones guardadas en `venta_item_lotes`.
8. El respaldo omitía variantes, lotes y componentes del catálogo.
   Las tablas fueron añadidas a la exportación.

## Rubros agregados

Se incorporaron 43 perfiles: colmado, supermercado, minimarket, farmacia,
restaurante, cafetería, pizzería, panadería, repostería, ferretería, boutique,
ropa, tienda general, tecnología, celulares, electrodomésticos, accesorios,
repuestos, taller, salón, barbería, spa, veterinaria, pet shop, librería,
papelería, licorería, joyería, mueblería, calzados, perfumería, distribuidora,
almacén, mayorista, carnicería, frutería, heladería, comida rápida, food truck,
servicios profesionales, centro de impresión, informática y negocio genérico.

## Capacidades implementadas

La configuración soporta vencimientos, lotes, medicamentos, FEFO, alertas,
mesas, cocina, modificadores, combos, delivery, modalidades de pedido,
seriales, IMEI, garantías, variantes, talla/color, unidades, venta fraccionada,
conversiones, PLU, peso, mayoristas, servicios, comisiones, citas, órdenes de
trabajo, activos del cliente, técnicos, presupuestos, mascotas y recetas.

En esta fase tienen comportamiento operativo completo las capacidades de
vencimiento, lotes, FEFO y alertas. Las demás ya cuentan con perfil y
persistencia, pero no se consideran terminadas hasta completar esquema, UI,
sincronización y pruebas de su flujo específico.

## Migraciones

- SQLite `v8`: `business_type` y `business_capabilities_json` en configuración.
- SQLite `v9`: control de vencimiento y campos farmacéuticos en productos;
  fabricación/proveedor en lotes; nueva tabla `venta_item_lotes` e índices.
- SQLite `v10`: metadatos de consulta DGII en clientes, normalización e índice
  de cédula/RNC para impedir registros duplicados.
- Todas las migraciones son aditivas y conservan los datos existentes.

## Backend agregado

- `updateBusinessCapabilities`: sincroniza rubro/capacidades con Firestore.
- `getFiscalSettings`: lectura fiscal autorizada por pertenencia a empresa.
- `updateFiscalSettings`: escritura fiscal limitada a dueño/administrador.
- `createMobileCompany`: persiste capacidades, estructura e impresión del wizard.

Estas funciones requieren despliegue de Firebase antes de probarlas contra el
proyecto remoto. El código móvil mantiene datos locales cuando la nube no está
disponible, pero no simula una sincronización exitosa.

## Pruebas realizadas

- `dart analyze lib`: aprobado, `No issues found`.
- `node --check functions/companies.js`: aprobado.
- `node --check functions/fiscal.js`: aprobado.
- `node --check functions/index.js`: aprobado.
- `git diff --check`: aprobado; solo avisos de normalización LF/CRLF.
- No se ejecutó `flutter run`, build ni compilación por solicitud del usuario.
- No se hicieron pruebas con impresora, escáner físico, caja de dinero ni
  dispositivo Android real.
- No se probó firma/envío e-CF con certificado ni servicios DGII reales.

## Pendientes del prompt maestro

- Variantes con inventario propio para ropa/calzado.
- Serial/IMEI por unidad y bloqueo de reutilización para tecnología.
- Conversión de unidades y venta fraccionada para ferretería.
- Modificadores, mitad y mitad, división/unión/transferencia de mesas.
- Servicios, comisiones y citas para salón/barbería/spa.
- Órdenes de trabajo para taller y ficha comercial de mascotas.
- Exigencia configurable de identificación del cliente antes de cobrar.
- Etiquetas: vista previa, tamaños, márgenes e impresión múltiple completa.
- Sincronización bidireccional de nuevas tablas con POS Windows/cloud.
- Restauración de respaldos, cifrado y versionado remoto.
- e-CF móvil completo mediante backend seguro y reportes DGII formales 606/607.
- Pruebas integrales en Chrome/Android, concurrencia, pérdida de red y hardware.
