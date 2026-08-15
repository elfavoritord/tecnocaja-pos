# Tecno Caja POS Mobile - Paridad con POS Windows

Objetivo: la app movil no es solo companion. Debe ser otro Tecno Caja POS completo, capaz de operar:

- **Vinculado al POS Windows:** sincroniza catalogo, clientes, proveedores, ventas, caja, fiscal, delivery y auditoria con la instalacion principal.
- **Independiente:** crea su propia empresa, vende, controla caja/inventario, factura y sincroniza a cloud sin depender de una PC.

## Reglas de arquitectura

1. La fuente local de operacion en movil es SQLite. Toda venta/caja/inventario debe poder registrarse offline primero.
2. Si esta vinculado a Windows, el POS Windows sigue siendo autoridad para integraciones Node/Electron: WhatsApp Web, respaldo seguro local, impresoras especiales, MariaDB y e-CF ya certificado.
3. Si trabaja independiente, lo que no puede vivir en Flutter debe vivir en backend/cloud: e-CF firmado, bot WhatsApp, licencias, backups remotos y certificados.
4. Certificados DGII `.p12` no deben guardarse en texto plano ni manejarse desde UI movil. La firma y envio DGII deben ejecutarse en servidor seguro.
5. Cada tabla de negocio debe mantener `empresa_id`, `sucursal_id`, `caja_id`, `deviceId`, `version`, `sync_estado`, `remoto_id` y borrado logico.

## Modos de operacion

### Standalone

- Alta de empresa desde movil.
- SQLite local como fuente inmediata.
- Firebase/cloud como sincronizacion multi-dispositivo.
- e-CF mediante backend seguro, no desde el telefono.
- Bot WhatsApp mediante servicio cloud o puente Windows si existe.

### Vinculado a POS Windows

- Login/vinculacion contra POS Windows o cloud bootstrap.
- Pull inicial desde MariaDB/Firestore.
- Push de ventas, caja, compras, inventario, delivery y auditoria con idempotencia.
- Fiscal/e-CF delegado al modulo Windows `modules/ecf` cuando ese negocio ya esta certificado ahi.
- WhatsApp bot delegado a `/api/wa-bot/*`.

## Matriz de modulos

| Modulo POS Windows | Movil actual | Estado movil | Siguiente trabajo |
| --- | --- | --- | --- |
| Dashboard | Dashboard movil | Parcial | Igualar KPIs por caja/sucursal, alertas licencia/e-CF/stock |
| Ventas/POS | POS movil | Funcional base | Agregar tipo pedido, delivery/mesa, descuentos avanzados, promociones automaticas |
| Caja | Caja movil | Funcional base | Arqueos, retiros, gastos, cierres historicos, cuadre por metodo |
| Productos | Productos movil | Lotes/vencimiento funcional | Variantes, seriales/IMEI, imagenes, precios por sucursal |
| Inventario | Inventario movil | FEFO + alertas 90/60/30/7 | Transferencias, conteos, ajustes aprobados, kardex completo |
| Clientes/CxC | Clientes + CRM movil | Funcional base | Recordatorios avanzados, historial completo, automatizaciones |
| Proveedores/CxP | Proveedores + Compras movil | Funcional base | Gastos fiscales, items de compra, recepcion con inventario |
| Cotizaciones | Cotizaciones movil | Funcional base | PDF/WhatsApp, convertir parcial, origen bot |
| Promociones | Promociones movil | Admin base | Motor automatico aplicado al carrito |
| Delivery | Delivery movil | Base local | Integrar venta tipo delivery, repartidores, ubicacion, cobro contra entrega |
| Reportes | Reportes movil | Base + CSV 606/607 | Igualar reportes avanzados, ganancias, DGII formal, Excel/PDF |
| Fiscal NCF | Fiscal movil | NCF central con fallback local | Desplegar callables nuevos, auditoria fiscal |
| e-CF/DGII | Monitor movil | Delegado | Consumir backend e-CF certificado: firmar, enviar, consultar trackId, QR |
| Respaldos | Respaldo JSON movil | Exportacion base | Cifrado, restauracion segura, backups remotos/versionados |
| Auditoria | Auditoria movil | Funcional base | Auditoria global, filtros usuario/sucursal, exportacion |
| Usuarios/Permisos | Usuarios movil | Funcional base | Roles por sucursal, permisos granulares completos |
| WhatsApp bot | Panel movil conectado | Funcional vinculado | Crear servicio cloud en standalone |
| Cocina/Mesas | Mesas/Cocina movil | Base local | Integrar tipo pedido directo en POS, cocina por items |
| Tesoreria/Gastos | Gastos movil | Base local | Tesoreria completa, caja general, autorizaciones |
| RRHH | RRHH movil | Asistencia base | Empleados, horarios, nomina si aplica |
| Archivos/Etiquetas | Etiquetas base | Parcial | File manager, etiquetas masivas, codigos de barra |
| Licencias | Licencia movil | Funcional base | Planes por modulos, bloqueo offline, limites cloud |

## Orden recomendado de implementacion

1. Igualar flujo de venta: tipo pedido, delivery/mesa, promociones automaticas y cobro contra entrega.
2. Completar sincronizacion bidireccional con Windows/cloud para ventas, compras, delivery, promociones, auditoria y respaldos.
3. Llevar e-CF real al backend movil usando el modulo certificado del POS Windows como referencia.
4. Agregar panel WhatsApp bot movil: estado, start/stop, instrucciones, proveedor IA, envio de factura.
5. Completar reportes avanzados y exportaciones formales 606/607.
6. Completar modulos restaurante/cocina, tesoreria/gastos, CRM y RRHH.

## Criterio de terminado

Un modulo se considera terminado cuando:

- Funciona offline en SQLite.
- Sincroniza sin duplicar datos.
- Respeta roles/permisos.
- Tiene auditoria.
- Tiene flujo movil usable.
- Tiene equivalencia funcional con el modulo Windows o una decision documentada de delegacion a backend.
