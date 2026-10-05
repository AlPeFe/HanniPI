@echo off
REM =============================================
REM  HanniPI - Instalador para Windows
REM  Doble clic y listo. Descarga, verifica e instala.
REM =============================================
echo.
echo  ============================
echo   HanniPI - Instalador
echo  ============================
echo.
echo  Se va a descargar HanniPI desde GitHub,
echo  verificar la descarga e instalarlo.
echo  (No necesitas nada mas instalado)
echo.
pause
echo.
powershell -ExecutionPolicy Bypass -NoProfile -Command "irm https://raw.githubusercontent.com/AlPeFe/HanniPI/main/install.ps1 | iex"
echo.
echo  ============================
echo   Fin del instalador.
echo   Si ves "HanniPI installed" arriba, ya esta.
echo  ============================
echo.
pause
