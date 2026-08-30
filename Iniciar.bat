@echo off
title Inversiones 360 CHAT
cd /d "%~dp0"
color 0A

echo ================================================
echo         INVERSIONES 360 CHAT
echo         Asistente de ventas con IA
echo.
echo         Desarrollado por Juan Camilo Ramirez
echo ================================================
echo.
echo Iniciando el servidor, espera un momento...
echo (si es la primera vez, puede tardar varios minutos configurando todo)
echo.

start /min "" "%~dp0servidor.bat"

echo Esperando a que el servidor este listo...

:esperar
powershell -Command "try { Invoke-WebRequest -Uri http://localhost:3000 -UseBasicParsing -TimeoutSec 1 | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  timeout /t 1 >nul
  goto esperar
)

echo.
echo Servidor listo, abriendo el navegador...
start "" http://localhost:3000

echo.
echo El servidor sigue corriendo minimizado en la barra de tareas.
echo (busca la ventana "Servidor - Inversiones 360 CHAT" si necesitas ver los logs)
echo NO cierres esa ventana minimizada mientras uses el asistente.
echo.
echo Puedes cerrar esta ventana cuando quieras, el asistente seguira funcionando.
pause
