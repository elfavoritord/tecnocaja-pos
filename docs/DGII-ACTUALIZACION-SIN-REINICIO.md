# Continuar los pasos 4 y 5 después de actualizar

La actualización conserva el avance y los documentos existentes. No envía XML,
no crea lotes, no reserva e-NCF y no marca pasos como aprobados.

## Conservación antes de instalar

El hook `customCheckAppRunning` del instalador conserva la comprobación estándar
de cierre de Electron y, después, ejecuta `build/preserve-certification.ps1`.
Esto ocurre antes de `uninstallOldVersion`; `customInstall` sería demasiado tarde.

Se examinan la instalación seleccionada y las ubicaciones registradas de la
versión anterior. Los archivos de `storage/ecf`, `ecf` y el contador fiscal se
copian a la carpeta permanente del usuario. Se comprueba SHA-256. Los archivos
que ya existen allí no se reemplazan. También se conserva una copia por hash
en `certification-recovery`, incluidos los conflictos entre versiones.

Si falla la conservación, el instalador se detiene antes de retirar la versión
anterior. Los originales permanecen intactos. El directorio APPDATA se obtiene
del Windows del cliente durante la instalación.

## Avance del asistente

El estado principal es `storage/ecf/cert-wizard-state.json`, bajo userData.
El guardado usa un archivo temporal y renombrado; `.bak` conserva el estado
válido anterior. Si el principal falta o está dañado se intenta la copia y
la ubicación antigua. Recuperar no modifica el paso, lote ni TrackID.

Si el servidor no devuelve un avance, el navegador intenta su copia local
`ecf_cert_wz_v2` y la persiste en el servidor. Un estado válido del servidor,
incluido un reinicio explícito, siempre prevalece. No se importa una copia
local que identifique un RNC diferente al negocio configurado.

El respaldo integral incluye el estado, su copia y los XML. Los certificados
continúan excluidos del respaldo portátil de adjuntos. Durante una actualización
en la misma PC sí se conservan. Una referencia antigua al archivo activo puede
usar la copia permanente únicamente si coinciden el número de serie y emisor
registrados; siguen aplicándose la contraseña y la validación del certificado.

## Uso

- Paso 4: abrir Certificación DGII y continuar con el lote existente. Consultar
  sus estados antes de decidir si hay una incidencia real de envío.
- Paso 5: descargar nuevamente las representaciones impresas del lote existente.
  La corrección del encabezado no requiere regenerar los comprobantes.
- No usar «Reiniciar certificación», «Reiniciar Paso 4» ni «Regenerar» para
  aplicar una actualización del programa.

Si una actualización anterior ya eliminó los archivos, esta conservación no
los puede reconstruir: revisar las copias de seguridad y los datos restantes.
No se deben inventar aprobaciones ni simular comprobantes aceptados.

## Pruebas

`node node_modules/jest/bin/jest.js tests/ecf.certification-preservation.test.js tests/ecf-wizard-wiring.test.js tests/services/backup-integral.test.js tests/ecf.step5-emisor.test.js tests/ecf.sequence-high-watermark.test.js --runInBand`

La prueba de conservación ejecuta PowerShell en Windows sobre instalaciones
temporales y verifica avance, XML, certificado, conflictos e idempotencia.
Las pruebas no llaman a DGII ni modifican la base de datos del negocio.
