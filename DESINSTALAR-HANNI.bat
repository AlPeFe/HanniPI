@echo off
REM =============================================
REM  HanniPI - Desinstalador para Windows
REM  Doble clic y listo. Quita HanniPI del PATH
REM  y borra la instalacion.
REM =============================================
setlocal
echo.
echo  ============================
echo   HanniPI - Desinstalador
echo  ============================
echo.
echo  Se va a desinstalar HanniPI:
echo   - Se quitara la carpeta de instalacion del PATH
echo   - Se borrara la carpeta de instalacion
echo.
echo  (No se toca el pi normal de earendil-works si lo tienes)
echo.
pause
echo.

powershell -ExecutionPolicy Bypass -NoProfile -Command ^
  "$dir = Join-Path $env:LOCALAPPDATA 'HanniPI';" ^
  "$userPath = [Environment]::GetEnvironmentVariable('Path', 'User');" ^
  "$newPath = ($userPath -split ';' | Where-Object { $_ -and $_ -notlike '*HanniPI*' }) -join ';';" ^
  "[Environment]::SetEnvironmentVariable('Path', $newPath, 'User');" ^
  "if (Test-Path $dir) { Remove-Item $dir -Recurse -Force; Write-Host ('Borrada: ' + $dir) -ForegroundColor Green } else { Write-Host 'No habia instalacion en LOCALAPPDATA\HanniPI' -ForegroundColor Yellow };" ^
  "Write-Host 'PATH de usuario actualizado.' -ForegroundColor Green"

echo.
echo  ============================
echo   Desinstalacion completada.
echo   Cierra y reabre la terminal
echo   para que el PATH se actualice.
echo  ============================
echo.
pause
endlocal
