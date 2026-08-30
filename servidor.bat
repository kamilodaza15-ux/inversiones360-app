@echo off
title Servidor - Inversiones 360 CHAT
cd /d "%~dp0"

if exist "%~dp0node-portable\node.exe" (
  set "PATH=%~dp0node-portable;%PATH%"
)

if not exist "%~dp0node_modules" (
  echo ================================================
  echo   Primera vez configurando el asistente.
  echo   Esto puede tardar varios minutos, no cierres
  echo   esta ventana.
  echo ================================================
  call npm.cmd install
  call npm.cmd install-scripts approve puppeteer@24.38.0
  call npm.cmd rebuild puppeteer
  echo.
  echo Configuracion inicial terminada.
  echo.
)

npm.cmd start
