@echo off
setlocal

REM ============================================================
REM  fix-tecnocaja.bat
REM  Reconfigura usuario MySQL tecnocaja y override de app.env
REM  para que la sincronizacion Firebase funcione.
REM  Correr UNA sola vez. No requiere admin.
REM ============================================================

echo === Tecno Caja: arreglando MySQL + override env ===
echo.

REM --- 1) Crear/asegurar usuario MySQL tecnocaja ---
set MYSQL_EXE=C:\Program Files\MariaDB 12.2\bin\mysql.exe
if not exist "%MYSQL_EXE%" (
  echo No encontre mysql.exe en "%MYSQL_EXE%".
  echo Edita este .bat y ajusta MYSQL_EXE a la ruta correcta.
  pause
  exit /b 1
)

echo [1/3] Creando/reparando usuario MySQL tecnocaja...
"%MYSQL_EXE%" -u root -e "CREATE USER IF NOT EXISTS 'tecnocaja'@'127.0.0.1' IDENTIFIED BY 'Tecno Caja2024!'; CREATE USER IF NOT EXISTS 'tecnocaja'@'localhost' IDENTIFIED BY 'Tecno Caja2024!'; ALTER USER 'tecnocaja'@'127.0.0.1' IDENTIFIED BY 'Tecno Caja2024!'; ALTER USER 'tecnocaja'@'localhost' IDENTIFIED BY 'Tecno Caja2024!'; GRANT ALL PRIVILEGES ON tecnocaja.* TO 'tecnocaja'@'127.0.0.1'; GRANT ALL PRIVILEGES ON tecnocaja.* TO 'tecnocaja'@'localhost'; FLUSH PRIVILEGES;"
if errorlevel 1 (
  echo.
  echo ERROR: Fallo el comando MySQL. Posibles causas:
  echo   - root requiere password. Probar:  "%MYSQL_EXE%" -u root -p
  echo   - MariaDB no esta corriendo.
  pause
  exit /b 1
)
echo OK.

REM --- 2) Copiar app-env-override a %APPDATA%\Tecno Caja\config\app.env ---
echo.
echo [2/3] Copiando override a %APPDATA%\Tecno Caja\config\app.env ...
if not exist "%APPDATA%\Tecno Caja\config" mkdir "%APPDATA%\Tecno Caja\config"
copy /Y "%~dp0app-env-override.env" "%APPDATA%\Tecno Caja\config\app.env" >nul
if errorlevel 1 (
  echo ERROR: No se pudo copiar.
  pause
  exit /b 1
)
echo OK.

REM --- 3) Correr healthcheck ---
echo.
echo [3/3] Corriendo healthcheck...
echo.
cd /d "%~dp0"
node scripts\check-firebase-sync.js

echo.
echo === Termino ===
pause
endlocal
