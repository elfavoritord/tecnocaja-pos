!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define VC_REDIST_FILE    "vc_redist.x64.exe"
!define MARIADB_HELPER_FILE "ensure-mariadb-service.ps1"
!define APP_NAME          "Tecno Caja"

; ── Paths que usa el runtime ─────────────────────────────────────────────────
;
; REGLA: si cambias un path aquí, cambia el mismo en runtime-bootstrap.js
;         y en ensure-local-mysql.js (getManagedMariaDbRoot).
;
; userData principal → runtime-bootstrap.js: path.join(APPDATA, 'Tecno Caja')
!define APP_ROAMING_DIR         "$APPDATA\Tecno Caja"
; Electron puede usar LOCALAPPDATA en entorno portable o con setPath()
!define APP_LOCAL_DIR           "$LOCALAPPDATA\Tecno Caja"
; package.json "name"=pos-system → dev-builds y versiones antiguas usaban este path
!define APP_LEGACY_ROAMING_DIR  "$APPDATA\pos-system"
; ProgramData con espacio → ensure-local-mysql.js  getManagedMariaDbRoot()
!define APP_PROGRAMDATA_DIR     "$PROGRAMDATA\Tecno Caja"
; ProgramData sin espacio → ensure-mariadb-service.ps1  $programDataRoot
!define APP_PROGRAMDATA_NOSPACE "$PROGRAMDATA\TecnoCaja"
; Documentos → electron/main.js  path.join(documents, 'TecnoCaja', 'Backups')
!define APP_DOCS_DIR            "$DOCUMENTS\TecnoCaja"
; Log de instalación MariaDB (siempre limpiable)
!define MARIADB_INSTALL_LOG     "$TEMP\tecnocaja-mariadb-install.log"

!ifndef BUILD_UNINSTALLER

; ── Verifica si Visual C++ Redistributable ya está instalado ─────────────────
Function CheckVCRedistInstalled
  StrCpy $0 0
  SetRegView 64
  ClearErrors
  ReadRegDWORD $1 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ${If} ${Errors}
    ClearErrors
    ReadRegDWORD $1 HKLM "SOFTWARE\Microsoft\DevDiv\VC\Servicing\14.0\RuntimeMinimum" "Install"
  ${EndIf}
  ${If} $1 = 1
    StrCpy $0 1
  ${EndIf}
  SetRegView 32
FunctionEnd

; ── Instala VC++ Redistributable desde archivo local incluido ─────────────────
Function EnsureVCRedistReady
  Call CheckVCRedistInstalled
  ${If} $0 = 1
    DetailPrint "Microsoft Visual C++ Redistributable x64 ya está instalado. Omitiendo."
    Return
  ${EndIf}

  DetailPrint "Preparando Microsoft Visual C++ Redistributable x64..."

  ${If} ${FileExists} "$INSTDIR\resources\${VC_REDIST_FILE}"
    DetailPrint "Usando prerrequisito incluido en la instalación..."
    CopyFiles /SILENT "$INSTDIR\resources\${VC_REDIST_FILE}" "$PLUGINSDIR\${VC_REDIST_FILE}"
  ${ElseIf} ${FileExists} "$EXEDIR\${VC_REDIST_FILE}"
    DetailPrint "Usando prerrequisito local junto al instalador..."
    CopyFiles /SILENT "$EXEDIR\${VC_REDIST_FILE}" "$PLUGINSDIR\${VC_REDIST_FILE}"
  ${Else}
    MessageBox MB_ICONSTOP|MB_OK "No se encontró el archivo requerido: ${VC_REDIST_FILE}$\r$\n$\r$\nEste componente es necesario para instalar ${APP_NAME}.$\r$\n$\r$\nDescarga vc_redist.x64.exe de Microsoft y colócalo junto a este instalador."
    Abort
  ${EndIf}

  DetailPrint "Instalando Microsoft Visual C++ Redistributable x64 (puede tomar unos segundos)..."
  ExecWait '"$PLUGINSDIR\${VC_REDIST_FILE}" /install /quiet /norestart /log "$PLUGINSDIR\vc_redist_install.log"' $2

  Sleep 2000
  Call CheckVCRedistInstalled
  ${If} $0 = 1
    DetailPrint "Microsoft Visual C++ Redistributable x64 instalado correctamente."
    Return
  ${EndIf}

  MessageBox MB_ICONSTOP|MB_OK "${APP_NAME} no pudo completar la instalación de Microsoft Visual C++ Redistributable x64.$\r$\n$\r$\nCódigo de salida: $2$\r$\n$\r$\nReinicia Windows e intenta nuevamente."
  Abort
FunctionEnd

; ── Crea las carpetas de datos de la aplicación ───────────────────────────────
Function CreateAppDataFolders
  DetailPrint "Creando carpetas de datos de ${APP_NAME}..."
  CreateDirectory "${APP_ROAMING_DIR}"
  CreateDirectory "${APP_ROAMING_DIR}\data"
  CreateDirectory "${APP_ROAMING_DIR}\uploads"
  CreateDirectory "${APP_ROAMING_DIR}\logs"
  CreateDirectory "${APP_ROAMING_DIR}\backups"
  CreateDirectory "${APP_ROAMING_DIR}\secure-backups"
  CreateDirectory "${APP_ROAMING_DIR}\config"
  DetailPrint "Carpetas de datos creadas correctamente."
FunctionEnd

; ── Regla de Firewall para el servidor local ──────────────────────────────────
Function AddFirewallRule
  DetailPrint "Configurando regla de Firewall para ${APP_NAME}..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${APP_NAME} Server"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${APP_NAME} Server" dir=in action=allow protocol=TCP localport=3399 description="${APP_NAME} servidor local POS"'
  Pop $0
  ${If} $0 = 0
    DetailPrint "Regla de Firewall configurada correctamente (puerto 3399)."
  ${Else}
    DetailPrint "Advertencia: No se pudo agregar la regla de Firewall (puede configurarse manualmente)."
  ${EndIf}
FunctionEnd

; ── Configura y levanta MariaDB embebida ──────────────────────────────────────
Function EnsureMariaDbService
  DetailPrint "Verificando y configurando MariaDB para ${APP_NAME}..."
  SetOutPath "$PLUGINSDIR"
  File "/oname=$PLUGINSDIR\${MARIADB_HELPER_FILE}" "${__FILEDIR__}\${MARIADB_HELPER_FILE}"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\${MARIADB_HELPER_FILE}" -InstallDir "$INSTDIR"'
  Pop $0

  ${If} $0 = 0
    DetailPrint "MariaDB configurada y lista para ${APP_NAME}."
  ${ElseIf} $0 = 20
    DetailPrint "Advertencia: no se encontró el bundle de MariaDB en la instalación."
    MessageBox MB_ICONEXCLAMATION|MB_OK "${APP_NAME} no encontró los archivos de MariaDB incluidos.$\r$\n$\r$\nLa aplicación se instaló correctamente, pero la base de datos local requiere configuración manual.$\r$\n$\r$\nLog de diagnóstico: ${MARIADB_INSTALL_LOG}"
  ${Else}
    DetailPrint "Advertencia: MariaDB no pudo configurarse automáticamente (código $0)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "${APP_NAME} no pudo configurar MariaDB automáticamente.$\r$\n$\r$\nPuedes continuar la instalación. Si usas base de datos local, revísala manualmente.$\r$\n$\r$\nLog de diagnóstico: ${MARIADB_INSTALL_LOG}$\r$\n$\r$\nCódigo de error: $0"
  ${EndIf}
FunctionEnd

; ── Hook principal de instalación ─────────────────────────────────────────────
!macro customInstall
  ${ifNot} ${isUpdated}
    Call EnsureVCRedistReady
  ${endIf}
  Call CreateAppDataFolders
  Call EnsureMariaDbService
  Call AddFirewallRule
!macroend

; ── Hook de desinstalación ────────────────────────────────────────────────────
;
; Flujo:
;   1. Detiene y elimina el servicio MariaDB (siempre, sin preguntar)
;   2. Elimina la regla de Firewall (siempre)
;   3. Pregunta: ¿eliminar también TODOS los datos?
;        SÍ → borra todos los directorios de datos (lista exhaustiva abajo)
;        NO → conserva los datos (útil si reinstalarán y quieren migrar)
;
; Nota: en una ACTUALIZACIÓN (${isUpdated}), NSIS no llama customUnInstall,
; así que este hook NO se ejecuta durante updates → los datos se preservan.
;
!macro customUnInstall

  ; ── 1. Detener y eliminar servicio MariaDB (siempre) ──────────────────────
  DetailPrint "Deteniendo servicio MariaDB de ${APP_NAME}..."
  SetOutPath "$PLUGINSDIR"
  File "/oname=$PLUGINSDIR\${MARIADB_HELPER_FILE}" "${__FILEDIR__}\${MARIADB_HELPER_FILE}"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\${MARIADB_HELPER_FILE}" -Uninstall'
  DetailPrint "Servicio MariaDB detenido."

  ; ── 2. Eliminar regla de Firewall (siempre) ───────────────────────────────
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${APP_NAME} Server"'
  DetailPrint "Regla de Firewall de ${APP_NAME} eliminada."

  ; ── 3. Preguntar si eliminar datos ────────────────────────────────────────
  MessageBox MB_ICONQUESTION|MB_YESNO \
    "¿Deseas eliminar también TODOS los datos de ${APP_NAME}?$\r$\n$\r$\n\
⚠ Esto borrará PERMANENTEMENTE:$\r$\n\
• Base de datos (ventas, clientes, inventario)$\r$\n\
• Respaldos guardados en esta PC$\r$\n\
• Imágenes de productos$\r$\n\
• Configuración de la app$\r$\n\
• Datos de MariaDB$\r$\n$\r$\n\
Selecciona SÍ solo si deseas una desinstalación completa.$\r$\n\
Selecciona NO para conservar los datos (útil antes de reinstalar)." \
    IDYES removeAllData IDNO keepData

  removeAllData:
    DetailPrint "Eliminando todos los datos de ${APP_NAME}..."

    ; ── AppData\Roaming\Tecno Caja  (userData principal) ──────────────────
    RMDir /r "${APP_ROAMING_DIR}"
    DetailPrint "Eliminado: ${APP_ROAMING_DIR}"

    ; ── AppData\Local\Tecno Caja  (Electron userData alternativo) ─────────
    RMDir /r "${APP_LOCAL_DIR}"
    DetailPrint "Eliminado: ${APP_LOCAL_DIR}"

    ; ── AppData\Roaming\pos-system  (nombre legado, dev builds) ───────────
    RMDir /r "${APP_LEGACY_ROAMING_DIR}"
    DetailPrint "Eliminado: ${APP_LEGACY_ROAMING_DIR}"

    ; ── ProgramData\Tecno Caja  (con espacio – ensure-local-mysql.js) ─────
    RMDir /r "${APP_PROGRAMDATA_DIR}"
    DetailPrint "Eliminado: ${APP_PROGRAMDATA_DIR}"

    ; ── ProgramData\TecnoCaja  (sin espacio – ensure-mariadb-service.ps1) ─
    RMDir /r "${APP_PROGRAMDATA_NOSPACE}"
    DetailPrint "Eliminado: ${APP_PROGRAMDATA_NOSPACE}"

    ; ── Documentos\TecnoCaja  (carpeta de backups en Documentos) ──────────
    RMDir /r "${APP_DOCS_DIR}"
    DetailPrint "Eliminado: ${APP_DOCS_DIR}"

    ; ── Log temporal de instalación MariaDB ────────────────────────────────
    Delete "${MARIADB_INSTALL_LOG}"

    ; ── Claves de registro de la app (Electron/Squirrel puede escribir aquí) ──
    DeleteRegKey HKCU "Software\Tecno Caja"
    DeleteRegKey HKCU "Software\pos-system"
    DeleteRegKey HKLM "Software\Tecno Caja"

    DetailPrint "Todos los datos de ${APP_NAME} han sido eliminados."
    Goto doneData

  keepData:
    DetailPrint "Datos conservados. Puedes reinstalar ${APP_NAME} y recuperarlos."

  doneData:

!macroend

!endif
