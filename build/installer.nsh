!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define VC_REDIST_URL "https://aka.ms/vs/17/release/vc_redist.x64.exe"
!define VC_REDIST_FILE "vc_redist.x64.exe"
!define MARIADB_HELPER_FILE "ensure-mariadb-service.ps1"
!define APP_NAME "NovaPOS"
!define APP_DATA_DIR "$APPDATA\NovaPOS"
!define APP_PROGRAMDATA_DIR "$PROGRAMDATA\NovaPOS"

!ifndef BUILD_UNINSTALLER

; -------------------------------------------------------
; Verifica si Visual C++ Redistributable está instalado
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
; Descarga VC++ Redistributable desde Microsoft
; -------------------------------------------------------
Function DownloadVCRedist
  DetailPrint "Descargando Microsoft Visual C++ Redistributable x64 desde Microsoft..."
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri ''${VC_REDIST_URL}'' -OutFile ''$PLUGINSDIR\${VC_REDIST_FILE}''; exit 0 } catch { exit 1 }"'
  Pop $2
FunctionEnd

; -------------------------------------------------------
; Asegura que VC++ esté instalado antes de continuar
; -------------------------------------------------------
Function EnsureVCRedistReady
  Call CheckVCRedistInstalled
  ${If} $0 = 1
    DetailPrint "Microsoft Visual C++ Redistributable x64 ya está instalado."
    Return
  ${EndIf}

  DetailPrint "Falta Microsoft Visual C++ Redistributable x64. Se instalará automáticamente como prerrequisito."

  ${If} ${FileExists} "$EXEDIR\${VC_REDIST_FILE}"
    DetailPrint "Usando prerrequisito local: $EXEDIR\${VC_REDIST_FILE}"
    CopyFiles /SILENT "$EXEDIR\${VC_REDIST_FILE}" "$PLUGINSDIR\${VC_REDIST_FILE}"
  ${Else}
    Call DownloadVCRedist
    ${If} $2 != 0
      MessageBox MB_ICONSTOP|MB_OK "${APP_NAME} no pudo descargar Microsoft Visual C++ Redistributable x64.$\r$\n$\r$\nConecta esta PC a Internet o coloca ${VC_REDIST_FILE} junto al instalador y vuelve a intentarlo."
      Abort
    ${EndIf}
  ${EndIf}

  ${IfNot} ${FileExists} "$PLUGINSDIR\${VC_REDIST_FILE}"
    MessageBox MB_ICONSTOP|MB_OK "No se encontró el instalador del prerrequisito ${VC_REDIST_FILE} después de la descarga o copia local."
    Abort
  ${EndIf}

  DetailPrint "Instalando Microsoft Visual C++ Redistributable x64..."
  ExecWait '"$PLUGINSDIR\${VC_REDIST_FILE}" /install /quiet /norestart /log "$PLUGINSDIR\vc_redist_install.log"' $2

  Sleep 1500
  Call CheckVCRedistInstalled
  ${If} $0 = 1
    DetailPrint "Microsoft Visual C++ Redistributable x64 instalado correctamente."
    Return
  ${EndIf}

  MessageBox MB_ICONSTOP|MB_OK "${APP_NAME} no pudo completar la instalación del prerrequisito.$\r$\n$\r$\nCódigo de salida: $2$\r$\n$\r$\nReinicia Windows e intenta de nuevo."
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
    DetailPrint "Regla de Firewall agregada correctamente (puerto 3399)."
  ${Else}
    DetailPrint "Advertencia: No se pudo agregar la regla de Firewall (se puede agregar manualmente)."
  ${EndIf}
FunctionEnd

; -------------------------------------------------------
; Registra e inicia MariaDB incluida en el instalador
; -------------------------------------------------------
Function EnsureMariaDbService
  DetailPrint "Configurando MariaDB incluida para ${APP_NAME}..."
  SetOutPath "$PLUGINSDIR"
  File "/oname=$PLUGINSDIR\${MARIADB_HELPER_FILE}" "${__FILEDIR__}\${MARIADB_HELPER_FILE}"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\${MARIADB_HELPER_FILE}" -InstallDir "$INSTDIR"'
  Pop $0

  ${If} $0 = 0
    DetailPrint "MariaDB configurada correctamente."
  ${ElseIf} $0 = 20
    DetailPrint "Advertencia: no se encontro el bundle de MariaDB en la instalacion."
    MessageBox MB_ICONEXCLAMATION|MB_OK "${APP_NAME} no encontro los archivos de MariaDB incluidos en la instalacion.$\r$\n$\r$\nLa app se instalara, pero la base local no quedara configurada automaticamente."
  ${Else}
    DetailPrint "Advertencia: MariaDB no pudo quedar configurada automaticamente (codigo $0)."
    MessageBox MB_ICONEXCLAMATION|MB_OK "${APP_NAME} no pudo dejar MariaDB lista automaticamente.$\r$\n$\r$\nPuedes terminar la instalacion, pero si usas MySQL/MariaDB local tendras que revisarla manualmente.$\r$\n$\r$\nLog de diagnostico: %TEMP%\novapos-mariadb-install.log"
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
; Hook de desinstalación: limpia regla de Firewall
; -------------------------------------------------------
!macro customUnInstall
  SetOutPath "$PLUGINSDIR"
  File "/oname=$PLUGINSDIR\${MARIADB_HELPER_FILE}" "${__FILEDIR__}\${MARIADB_HELPER_FILE}"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\${MARIADB_HELPER_FILE}" -Uninstall'
  MessageBox MB_ICONQUESTION|MB_YESNO "¿Deseas eliminar también los datos locales y la base de datos de ${APP_NAME}?$\r$\n$\r$\n(Ventas, productos, inventario y respaldos guardados en esta PC)$\r$\n$\r$\nNota: si también quieres borrar Firebase, primero hazlo desde Configuración > Zona de Peligro dentro de la app principal." IDYES removeData IDNO keepData
  removeData:
    RMDir /r "${APP_DATA_DIR}"
    RMDir /r "${APP_PROGRAMDATA_DIR}"
    DetailPrint "Datos de ${APP_NAME} eliminados."
    Goto doneData
  keepData:
    DetailPrint "Datos de ${APP_NAME} conservados en ${APP_DATA_DIR}."
  doneData:
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${APP_NAME} Server"'
  DetailPrint "Regla de Firewall eliminada."
!macroend

!endif
