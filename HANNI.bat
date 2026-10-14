@echo off
REM ============================================================
REM  HanniPI + HanniGram - instalador / actualizador / desinstalador
REM  Un solo script: doble clic y elige instalar, actualizar o quitar.
REM  Instala HanniPI (como "hanni") y HanniGram (memoria) juntos.
REM ============================================================
setlocal
title HanniPI + HanniGram
set "REPO=AlPeFe/HanniPI"

set "PS1=%~dp0hanni-setup.ps1"
if not exist "%PS1%" (
    set "PS1=%TEMP%\hanni-setup.ps1"
    echo Descargando hanni-setup.ps1 ...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; $out=Join-Path $env:TEMP 'hanni-setup.ps1'; try { Invoke-WebRequest -Uri 'https://github.com/%REPO%/releases/latest/download/hanni-setup.ps1' -OutFile $out -UseBasicParsing } catch { Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/%REPO%/main/hanni-setup.ps1' -OutFile $out -UseBasicParsing }"
    if errorlevel 1 (
        echo.
        echo  No pude descargar hanni-setup.ps1. Comprueba tu conexion.
        pause
        exit /b 1
    )
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*

echo.
pause
endlocal
