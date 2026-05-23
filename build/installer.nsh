!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define VC_REDIST_FILE "vc_redist.x64.exe"
!define MARIADB_HELPER_FILE "ensure-mariadb-service.ps1"
!define APP_NAME "Tecno Caja"
!define APP_DATA_DIR "$APPDATA\TecnoCaja"
!define APP_PROGRAMDATA_DIR "$PROGRAMDATA\TecnoCaja"
!define MARIADB_LOG "%TEMP%\tecnocaja-mariadb-install.log"

!ifndef BUILD_UNINSTALLER

; -------------------------------------------------------
; Verifica si Visual C++ Redistributable ya está instalado
; -------------------------------------------------------
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

; -------------------------------------------------------
; Instala VC++ Redistributable desde archivo local incluido
; Busca en $INSTDIR\resources\ (extraResources), luego junto al .exe
; NO depende de internet
; -------------------------------------------------------
Function EnsureVCRedistReady
  Call CheckVCRedistInstalled
  ${If} $0 = 1
    DetailPrint "Microsoft Visual C++ Redistributable x64 ya está instalado. Omitiendo."
    Return
  ${EndIf}

  DetailPrint "Preparando Microsoft Visual C++ Redistributable x64..."

  ; Buscar en este orden:
  ; 1. Incluido en los recursos del instalador ($INSTDIR\resources\)
  ; 2. Junto al archivo .exe del instalador ($EXEDIR)
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

; -------------------------------------------------------
; Crea las carpetas de datos de la aplicación
; -------------------------------------------------------
Function CreateAppDataFolders
  DetailPrint "Creando carpetas de datos de ${APP_NAME}..."
  CreateDirectory "${APP_DATA_DIR}"
  CreateDirectory "${APP_DATA_DIR}\data"
  CreateDirectory "${APP_DATA_DIR}\uploads"
  CreateDirectory "${APP_DATA_DIR}\logs"
  CreateDirectory "${APP_DATA_DIR}\backups"
  CreateDirectory "${APP_DATA_DIR}\secure-backups"
  DetailPrint "Carpetas de datos creadas correctamente."
FunctionEnd

; -------------------------------------------------------
; Agrega regla de Firewall para el servidor local
; -------------------------------------------------------
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

; -------------------------------------------------------
; Configura MariaDB incluida en el instalador
; Verifica si ya existe antes de reinstalar
; -------------------------------------------------------
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
    MessageBox MB_ICONEXCLAMATION|MB_OK "${APP_NAME} no encontró los archivos de MariaDB incluidos.$\r$\n$\r$\nLa aplicación se instaló correctamente, pero la base de datos local requiere configuración manual.$\r$\n$\r$\nLog de diagnóstico: ${MARIADB_LOG}"
  ${Else}
    DetailPrint "Advertencia: MariaDB no pudo configurarse automáticamente (código $0)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "${APP_NAME} no pudo configurar MariaDB automáticamente.$\r$\n$\r$\nPuedes continuar la instalación. Si usas base de datos local, revísala manualmente.$\r$\n$\r$\nLog de diagnóstico: ${MARIADB_LOG}$\r$\n$\r$\nCódigo de error: $0"
  ${EndIf}
FunctionEnd

; -------------------------------------------------------
; Hook principal de instalación
; -------------------------------------------------------
!macro customInstall
  ${ifNot} ${isUpdated}
    Call EnsureVCRedistReady
  ${endIf}
  Call CreateAppDataFolders
  Call EnsureMariaDbService
  Call AddFirewallRule
!macroend

; -------------------------------------------------------
; Hook de desinstalación: limpia servicios y regla de Firewall
; Pregunta antes de borrar datos para proteger información
; -------------------------------------------------------
!macro customUnInstall
  SetOutPath "$PLUGINSDIR"
  File "/oname=$PLUGINSDIR\${MARIADB_HELPER_FILE}" "${__FILEDIR__}\${MARIADB_HELPER_FILE}"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\${MARIADB_HELPER_FILE}" -Uninstall'

  MessageBox MB_ICONQUESTION|MB_YESNO "¿Deseas eliminar también los datos locales y la base de datos de ${APP_NAME}?$\r$\n$\r$\n⚠ Esto borrará permanentemente:$\r$\n• Ventas e inventario$\r$\n• Clientes y productos$\r$\n• Respaldos guardados en esta PC$\r$\n$\r$\nSelecciona NO para conservar los datos." IDYES removeData IDNO keepData

  removeData:
    RMDir /r "${APP_DATA_DIR}"
    RMDir /r "${APP_PROGRAMDATA_DIR}"
    DetailPrint "Datos de ${APP_NAME} eliminados."
    Goto doneData
  keepData:
    DetailPrint "Datos de ${APP_NAME} conservados en ${APP_DATA_DIR}."
  doneData:

  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${APP_NAME} Server"'
  DetailPrint "Regla de Firewall de ${APP_NAME} eliminada."
!macroend

!endif
