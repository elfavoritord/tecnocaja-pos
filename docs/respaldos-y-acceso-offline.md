# Respaldos y acceso sin internet — revisión del 6 de noviembre de 2026

Estado: mejoras del respaldo lógico y diagnóstico offline implementadas. **No equivale todavía a la recuperación ante desastres completa del documento de referencia.** No se restauró sobre bases de producción ni se cambiaron sus contraseñas, licencias remotas, credenciales B2 o políticas de retención.

Actualización tras la petición de comprobar B2 real: se inventariaron 37 registros de licencias y se descargaron, descifraron y comprobaron 35 archivos anteriores; se generaron copias V3 de la empresa local, dejando 37 archivos comprobados. Se guardaron copias centrales cifradas en `Documents/TecnoCaja/Backups-Verificados`. Se probó subida/descarga/restauración sintética y también la recuperación del respaldo real local en una base temporal MariaDB independiente: 160 tablas, 2 usuarios y 2 adjuntos; después se eliminaron la base y archivos temporales. Se comprobó la conservación exacta de fechas de configuración/licencia y se configuró la lectura de fechas SQL como texto en los respaldos para evitar desplazamientos de zona horaria. No se sobrescribió ninguna base de producción ni se modificaron licencias remotas.

La auditoría detectó un ID anterior en `.env` del proyecto; se corrigió para coincidir con el único `license_id` de la base local y la empresa verificada en Firebase. No se cambió el plan ni el estado de la licencia. Las credenciales B2 actuales no permiten crear llaves (`writeKeys`), por lo que no se distribuyó una llave global a instalaciones de clientes. El informe privado por negocio está en `runtime-data/auditoria-respaldos/2026-11-07T03-50-10-225Z/INFORME.md`. Hay 6 registros con archivos bajo su ID actual y 31 sin archivos en ese prefijo (21 registros de negocios, 6 sucursales y 4 sin nombre comercial). Algunos tienen candidatos históricos que requieren comprobar identidad. Las copias locales en las PC de los clientes y su automatización siguen pendientes de acceso a esos equipos; una copia central no prueba una copia en el cliente.

## Hallazgos y cambios

| Hallazgo | Cambio |
|---|---|
| Cuentas creadas con Google pueden no tener contraseña local. Google necesita internet para autenticar. | Aviso al entrar y botón para crear la contraseña local desde Mi cuenta. El servidor exige la sesión del mismo usuario y guarda un hash scrypt. |
| Un equipo sin caché de licencia verificable aparecía como vencido. | Código `activation_required` y mensaje de validación del equipo. No se conceden activaciones ni se amplían vencimientos. |
| Una caja puede depender de la LAN y de la PC principal aunque no necesite internet. | Diagnóstico de contraseña, autorización local y dependencia LAN en Configuración. Una caja con MariaDB remota no puede restaurar la central desde su copia. |
| El catálogo de RNC intentaba actualizarse aun sin internet. | Usa el archivo local aunque sea de un día anterior. Si falta, responde para captura manual; no espera una descarga. |
| Exportación por lista fija y con límites de registros; omitía módulos. | V3 descubre las tablas existentes y captura todas sus filas en un catálogo con cantidades y SHA-256. Una lectura fallida cancela el respaldo. |
| Restauración podía omitir fallos SQL y dejar datos incompletos. | Prevalidación, transacción dedicada, comprobaciones de cantidades y relaciones, reversión ante errores. Se vacían las tablas antes de reinsertar para evitar efectos de cascada sobre filas recuperadas. |
| El prefijo de nube podía usar el ID local `1` o `default`. | Usa la licencia original o UUID persistente de empresa. Si falta identidad, conserva la posibilidad de respaldo local y rechaza subir a un prefijo ambiguo. |
| Una cola podía subir una copia diaria cuyo archivo ya había sido reemplazado. | Comprueba la huella registrada antes de enviar; marca el registro reemplazado. La versión vigente conserva su propio registro. |
| La respuesta de subida no comprobaba el objeto almacenado. | Confirma tamaño y metadato SHA-256 mediante HEAD. Un fallo conserva el envío pendiente. Esto no sustituye un ensayo de recuperación desde B2. |

Las causas de acceso anteriores están comprobadas en código y laboratorio. Para atribuir una causa a una empresa instalada concreta se debe ejecutar su diagnóstico; no se inspeccionaron remotamente todos los clientes.

## Componentes recuperables

- Todas las tablas ordinarias descubiertas: empresa, sucursales, cajas, ventas, inventario, clientes, compras, Servicios, MESAS, e-CF, colas y cursores de sincronización, auditoría y nuevos módulos con tablas propias.
- Archivos registrados en `backup-components.js`: productos, comprobantes de tesorería y fiscales, `Sistema_Data`, XML/PDF y medios en los directorios e-CF. Extensiones admitidas: imágenes, PDF, XML, documentos Office, CSV y TXT.
- Contadores históricos e-NCF de `ecf-sequence-high-watermarks.json`; al recuperarlos en la misma PC se conserva el máximo entre el archivo actual y el respaldado.
- Se mantienen los IDs del corte respaldado. Restaurar tres veces sustituye ese estado sin agregar filas duplicadas ni recalcular movimientos.
- No viajan autorizaciones de equipo (`license_cache`), sesiones activas ni tokens de acceso. Certificados y claves privadas requieren configuración separada; el manifiesto registra esa necesidad. Las contraseñas locales antiguas se convierten a hash en la exportación.

Un módulo nuevo con archivos fuera de esos directorios debe registrar su raíz y tipos en el catálogo de componentes. No se incluyen arbitrariamente archivos del disco, `.env`, ejecutables, claves privadas ni sesiones de WhatsApp.

## Consistencia y recuperación

MariaDB usa una conexión dedicada con instantánea REPEATABLE READ; rechaza tablas de motores distintos de InnoDB. SQLite captura una copia de la base en memoria. Esto garantiza el corte de la base, no una instantánea física coordinada de todo el disco. Cada adjunto se comprueba antes y después de leerlo para detectar cambios durante su captura.

La prevalidación muestra empresa, identidad, fecha del corte, tablas, archivos y elementos que necesitan reconfiguración. V3 rechaza empresas distintas, columnas incompatibles, hashes incorrectos y rutas inseguras. Los lectores antiguos reconocen un magic distinto y no deben intentar importar parcialmente V3. Se mantiene el importador de formatos anteriores con aviso de sus limitaciones.

Durante la recuperación se cierran nuevas operaciones HTTP y se espera a que terminen las anteriores. El mantenimiento de `db.js` bloquea también consultas externas de tareas de fondo y permite únicamente el trabajo de recuperación. Una empresa activa exige un respaldo previo legible. Las tablas se restauran dentro de una transacción y los adjuntos se preparan en archivos temporales, con reversión si falla el trabajo o la confirmación. Se invalidan sesiones en disco y en memoria.

**Límite:** la coordinación entre transacción SQL y archivos todavía no incluye un diario persistente de recuperación ante apagado en el instante del commit. No se debe describir como atomicidad frente a pérdida de energía.

## Punto de recuperación y fases pendientes

El punto recuperable es la fecha de la instantánea del último respaldo íntegro disponible, mostrada antes de confirmar. Los movimientos posteriores pueden perderse. Una copia pendiente en el único disco no protege frente a la destrucción de ese disco. No se promete pérdida cero ni un RTO sin medirlo con el tamaño de cada empresa.

Pendiente para cerrar el documento completo:

1. Respaldo físico MariaDB con `mariadb-backup`, preparación y recuperación por binlogs/PITR; ensayo de desastre con volumen representativo y medición RPO/RTO.
2. Diario persistente y ensayo de apagado durante el intercambio de archivos y la confirmación de la base; staging en una base temporal antes del corte.
3. Solicitud, aprobación/rechazo y auditoría de transferencia en el Admin de Emilio; revocación y nueva autorización atómicas, preservando plan, vencimiento y cupos. El respaldo no clona la activación. No se ha implementado este flujo nuevo ni se ha prometido revocación instantánea de una PC desconectada.
4. Completar el despliegue y ensayo en cada PC cliente con su llave limitada; el ensayo B2 en esta PC y la recuperación local aislada ya se ejecutaron según la actualización anterior. Los reintentos exponenciales y el diagnóstico local quedaron preparados para la próxima versión, según `respaldos-preparados-proxima-version.md`, sin publicar una actualización. Faltan las métricas de antigüedad publicadas en el Admin y la comprobación por instalación.
5. Conciliación fiscal después de recuperar un corte antiguo, incluyendo números emitidos después del respaldo. Conservar estados aceptados del corte no basta para reconstruir documentos posteriores que solo conozca DGII.

No se activó Object Lock ni se modificó la retención histórica: una copia automática vigente por día y conservación de los dos días disponibles, más el límite existente de copias manuales/previas.

## Validación reproducible

```powershell
npx jest --runInBand tests/services/backup-integral.test.js tests/services/backup-core-multisucursal.test.js tests/services/backup-core-restore-columnas.test.js tests/services/backup-cloud-verification.test.js tests/services/db-maintenance.test.js tests/services/offline-readiness.test.js tests/services/rnc-offline.test.js tests/routes/respaldo-diario.test.js tests/security/backup-crypto.test.js tests/licensing/license-service.test.js
node scripts/probar-offline-negocios.js
node scripts/probar-offline-negocios.js --mariadb
```

Los laboratorios crean directorios temporales únicos y no copian `.env` ni credenciales Firebase. Usan autorización de licencia de prueba en la copia aislada. Simulan la ausencia de internet mediante el monitor del sistema; no desconectan la red del usuario. Prueban login local, operación POS/Servicios, respaldo V3, prevalidación, restauración y nuevo login tras reiniciar. MariaDB temporal escucha solo en loopback. B2 se prueba con un SDK simulado; no se suben datos reales.

Resultado de esta revisión: 50 pruebas automáticas aprobadas entre las suites indicadas (incluidas licencias y RNC), y cuatro escenarios de laboratorio aprobados: POS y Servicios en SQLite y MariaDB. Evidencias de los laboratorios: `F:/WinTemp/tc-offline-negocios-kIwBkN/resultado.json` y `F:/WinTemp/tc-offline-negocios-jHqCHU/resultado.json`. Son rutas temporales; los scripts permiten reproducirlas. Los escenarios incluyen respaldo y recuperación sobre datos exclusivamente de prueba.

Referencias primarias para las fases de desastre: [respaldo físico y preparación MariaDB](https://mariadb.com/docs/server/server-usage/backup-and-restore/mariadb-backup/full-backup-and-restore-with-mariadb-backup), [PITR](https://mariadb.com/docs/server/server-usage/backup-and-restore/mariadb-backup/point-in-time-recovery-pitr-mariadb-backup), [API S3 de Backblaze](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api), [Object Lock](https://www.backblaze.com/docs/cloud-storage-object-lock).
