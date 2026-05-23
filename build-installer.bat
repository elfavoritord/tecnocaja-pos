@echo off
chcp 65001 > nul
title Tecno Caja - Compilar Instalador

echo ============================================
echo   Tecno Caja - Generador de Instalador
echo ============================================
echo.

:: Verificar que estamos en el directorio correcto
if not exist "package.json" (
    echo ERROR: Ejecuta este script desde la carpeta raiz del proyecto.
    pause
    exit /b 1
)

:: Verificar que Node.js está instalado
node --version > nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js no está instalado o no está en el PATH.
    echo Descarga Node.js desde https://nodejs.org
    pause
    exit /b 1
)

:: Verificar que las dependencias están instaladas
if not exist "node_modules" (
    echo Instalando dependencias npm...
    npm install
    if errorlevel 1 (
        echo ERROR: Fallo al instalar dependencias.
        pause
        exit /b 1
    )
)

:: Verificar si existe el icono (opcional pero recomendado)
if not exist "build\icon.ico" (
    echo AVISO: No se encontró build\icon.ico
    echo El instalador se compilará sin icono personalizado.
    echo Para agregar un icono: coloca un archivo icon.ico en la carpeta build\
    echo.

    :: Remover referencias al icono temporalmente para que no falle el build
    echo Continuando sin icono...
)

:: Verificar si existe la licencia
if not exist "build\license.txt" (
    echo AVISO: No se encontró build\license.txt
    echo Creando licencia básica...
    echo Tecno Caja - Sistema de Punto de Venta > build\license.txt
    echo Copyright ^(C^) 2025 Emilio. Todos los derechos reservados. >> build\license.txt
)

echo.
echo Preparando bundle local de MariaDB...
node scripts\prepare-mariadb-bundle.js
if errorlevel 1 (
    echo ERROR: No se pudo preparar MariaDB para incluirla en el instalador.
    pause
    exit /b 1
)

echo.
echo Compilando instalador de Tecno Caja para Windows x64...
echo Esto puede tardar varios minutos. Por favor espera...
echo.

:: Limpiar dist anterior (opcional)
if exist "dist\win-unpacked" (
    echo Limpiando build anterior...
    rmdir /s /q "dist\win-unpacked" 2>nul
)

:: Ejecutar electron-builder
npx electron-builder --win nsis --x64

if errorlevel 1 (
    echo.
    echo ============================================
    echo   ERROR: Fallo la compilacion del instalador
    echo ============================================
    echo.
    echo Revisa los mensajes de error de arriba.
    echo Causas comunes:
    echo   - Falta el archivo build\icon.ico
    echo   - Error en build\installer.nsh
    echo   - Dependencias faltantes
    pause
    exit /b 1
)

echo.
echo ============================================
echo   EXITO: Instalador generado correctamente
echo ============================================
echo.
echo El instalador está en la carpeta: dist\
echo.

:: Mostrar el archivo generado
dir "dist\*.exe" 2>nul

echo.
echo Presiona cualquier tecla para abrir la carpeta dist...
pause > nul
explorer "dist"
