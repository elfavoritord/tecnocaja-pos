@echo off
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo No se encontro Electron en este proyecto.
  echo Ejecuta npm install desde la carpeta del proyecto.
  pause
  exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
endlocal
