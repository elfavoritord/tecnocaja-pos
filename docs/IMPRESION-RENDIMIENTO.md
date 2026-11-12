# Motor compartido de impresión

Las facturas, recibos, abonos, cortes y cierres que se envían por los canales
de escritorio aprovechan las mismas optimizaciones. Las etiquetas TSPL usan
el transporte RAW; las etiquetas HTML usan el motor de documentos.

## Transporte térmico y etiquetas RAW

`electron/raw-printer.js` mantiene un proceso PowerShell por impresora, en vez
de iniciar uno y escribir un archivo binario para cada recibo o pulso de gaveta.
Los bytes se envían por stdin en base64 y cada respuesta identifica su trabajo.
`raw-print-worker.ps1` confirma el trabajo después de `EndDocPrinter`.

Los trabajos de una impresora conservan su orden. Las impresoras distintas
pueden avanzar a la vez. La compilación inicial del helper C# usa un mutex y
publica la DLL al terminar, para no compartir un archivo a medio compilar.
Si cambia el código C# hay que cambiar el nombre versionado de la DLL y del
mutex. El script se extrae fuera de `app.asar` para que PowerShell pueda leerlo.

Un fallo o tiempo agotado se devuelve al usuario sin reenvío automático: el
trabajo podría haber llegado al spooler antes del fallo. El siguiente trabajo
puede iniciar otro proceso si el anterior terminó. La confirmación indica que
Windows recibió el trabajo; no mide la salida física del papel.

## Documentos HTML

`electron/print-window-pool.js` reutiliza ventanas ocultas por impresora para
`receipt:print-html` y `labels:print-html`. Cada documento vuelve a cargarse
completo, con su papel y opciones, antes de imprimir. No se reemplaza el
contenido hasta que finaliza el trabajo anterior. El archivo HTML temporal
se elimina al terminar.

Se esperan imágenes pendientes y fuentes; una imagen que ya terminó con error
no bloquea la impresión. No se esperan fotogramas de animación en ventanas
ocultas. El diálogo de Windows conserva la elección del usuario; la impresión
directa conserva la impresora, tamaño, resolución y formato configurados.
Un error no envía automáticamente otra copia a la impresora predeterminada.

Ambos motores conservan hasta tres recursos inactivos, los liberan después
de dos minutos y los cierran al salir. Las ventanas ocultas se liberan también
al cerrar la ventana principal. Exportar un PDF o imprimirlo desde un visor
externo sigue usando el flujo propio de ese visor.

## Verificación

`node node_modules/jest/bin/jest.js tests/raw-printer.test.js tests/print-window-pool.test.js tests/print-readiness.test.js tests/print-job.test.js tests/thermal-printer-receipt.test.js tests/ecf.qr-thermal-print.test.js --runInBand`

Las pruebas verifican reutilización, orden por impresora, impresoras simultáneas,
bytes intactos, QR, dimensiones, imágenes pendientes/fallidas, errores,
recuperación y liberación de recursos. Para medir la velocidad física hay que
probar con los modelos de impresora y drivers instalados en cada equipo.
