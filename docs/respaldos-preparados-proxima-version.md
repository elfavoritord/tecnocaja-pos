# Correcciones preparadas para la próxima versión

El trabajo queda en el código. No se ha generado un instalador, incrementado la versión, publicado una release ni actualizado las PC de clientes.

Cuando se publique e instale la próxima versión:

- La PC principal creará una copia V3 íntegra del día, aunque la anterior fuese V2. La revisión inicial se ejecuta en segundo plano a los tres minutos del arranque; no bloquea el inicio de sesión.
- Cada empresa tendrá una subcarpeta propia bajo la ubicación de respaldos elegida. La rotación no borrará copias de otra empresa con el mismo nombre. Las copias anteriores permanecen en su ubicación original y siguen disponibles mediante el selector de archivo.
- La identidad del respaldo se contrasta con la licencia guardada y el UUID de la empresa. Un ID configurado que contradiga al caché bloquea la subida y muestra la revisión pendiente; no reasigna la empresa ni modifica la licencia.
- Los respaldos locales se conservan sin internet. Si B2 no está configurado, el estado muestra `pendiente_configuracion`; no presenta la operación como protección completa en nube.
- Los envíos se reintentan con estado persistente y espera exponencial desde un minuto hasta seis horas. La revisión de la cola se hace cada minuto. Antes de enviar se comprueban la huella, la identidad y que el archivo siga disponible.
- Las copias y los reintentos automáticos se serializan por servidor, para que un archivo diario no se reemplace durante su envío. Las cajas secundarias delegan estas tareas en la principal.
- La pantalla comprueba una copia local, su fecha de corte, la identidad y el objeto confirmado en B2 (tamaño y metadato SHA-256). Advierte sobre copias antiguas, errores, configuración faltante y envíos pendientes.
- Se guarda una referencia de ubicación e identidad fuera de la base para localizar las copias después de una corrupción. Si falta identidad suficiente, la recuperación automática se detiene y pide recuperación guiada. El formateo explícito elimina esa referencia.

Una actualización no crea por sí sola credenciales de Backblaze ni concede activaciones. Las instalaciones sin llave B2 propia necesitan configurarla. No se comparten llaves entre negocios ni se copian las del proyecto a las PC de clientes. El servicio de transferencia de licencias con aprobación del propietario, el respaldo físico/PITR y la coordinación persistente frente a apagado continúan siendo trabajos separados; no se declaran terminados por estas correcciones.

## Comprobaciones antes de publicar más adelante

```powershell
npm run test:respaldos-actualizacion
node scripts/probar-offline-negocios.js
node scripts/probar-offline-negocios.js --mariadb
```

El primer comando verifica sintaxis, archivos necesarios, ausencia de llaves B2 o identidad de empresa en la configuración común y pruebas de respaldo, recuperación y permisos. No ejecuta scripts de publicación. Los otros comandos usan negocios y servidores temporales aislados; no modifican instalaciones de clientes ni usan credenciales reales de B2/Firebase.

Los scripts de auditoría de la PC del propietario y las pruebas de laboratorio quedan excluidos del instalador. Los módulos de respaldo siguen incluidos por `server/**/*` y la interfaz por `js/**/*`.

Los indicadores del plano también incluyen cantidades de elementos disponibles, ocupados y sin venta. Se calculan usando los mismos estados que sus colores y se actualizan al renderizar el plano o editar elementos.

## Resultado de la preparación (7 de noviembre de 2026)

Pasaron 56 pruebas automáticas del conjunto de verificación. Tras endurecer la comprobación de identidad se repitieron las 20 pruebas afectadas, también aprobadas. Los cuatro escenarios POS/Servicios con SQLite/MariaDB aprobaron operación sin internet, copia V3 automática, diagnóstico explícito de B2 sin configurar, restauración y acceso después de reiniciar. Laboratorios: `F:/WinTemp/tc-offline-negocios-fo55uW` y `F:/WinTemp/tc-offline-negocios-Eu0fac`.

En navegador se comprobó que los contadores coinciden con las figuras reales (6/5/1 en la demo) y con un plano simulado de estados mixtos (2/1/1), sin guardar modificaciones del plano. Captura: `docs/capturas-rediseno/mesas-contadores.png`.
