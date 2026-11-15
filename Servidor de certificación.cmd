@echo off
chcp 65001 > nul
title Servidor de certificacion e-CF (Tecno Caja)
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
echo.
echo  Servidor de certificacion e-CF
echo  Panel: http://127.0.0.1:3600
echo  Para cerrarlo usa Ctrl+C en esta ventana (guarda los datos de cada empresa).
echo.
node tools\certificacion\servidor.js
pause
