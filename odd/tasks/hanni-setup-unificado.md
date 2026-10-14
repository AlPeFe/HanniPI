---
topic_key: odd/hanni-setup-unificado/tasks
status: active
base: fe167f0ee
---
# Instalador unificado HanniPI + HanniGram (release v0.2.5-hannipi)

Objective: Un solo script de Windows que pregunte Instalar / Actualizar / Desinstalar, pare todos los procesos/servicios bun y HanniGram activos, e instale o quite HanniPI **y** HanniGram juntos.

Why: En un PC Windows HanniGram no se instaló junto a HanniPI (el instalador antiguo solo ponía el binario de HanniPI). Además, al reinstalar/desinstalar, el `hanni.exe` en marcha bloquea los ficheros y falla; hay que parar los servicios bun relacionados con hanni primero.

Scope: scripts de instalación/desinstalación/actualización en Windows, empaquetado del daemon HanniGram como binario Windows x64, y release de HanniPI con esos assets. Fuera de alcance: macOS/Linux, cambios funcionales del harness.

Constraints: Un único punto de entrada (`.bat` de doble clic) que delega en un `.ps1`. No tocar el `pi` de earendil-works. Parar procesos antes de borrar/instalar. Mantener `install.ps1` por compatibilidad (URL histórica del README) apuntando al nuevo flujo.

## Pasos

- [ ] S1 Publicar HanniGram (Server + Cli) self-contained win-x64 y empaquetarlo.
- [ ] S2 Escribir el script unificado (`HANNI.bat` + `hanni-setup.ps1`): menu instalar/actualizar/desinstalar, Stop-HanniProcesses, instalar/desinstalar HanniPI+HanniGram.
- [ ] S3 Verificar sintaxis PowerShell y una ejecucion controlada (menu + stop).
- [ ] S4 Bump a 0.2.5-hannipi + build del binario Windows x64 y assets (HanniPI + HanniGram).
- [ ] S5 Commit + push main + crear release v0.2.5-hannipi con scripts y assets.
- [ ] S6 Verificar release/asset/checksum.

## Siguiente

S1: publish self-contained de HanniGram.

## Verification

- `powershell -NoProfile -Command "& { ... }"` parsea sin errores.
- Assets de la release: `pi-windows-x64.zip`, `hannigram-windows-x64.zip`, `SHA256SUMS`, `HANNI.bat`, `hanni-setup.ps1`.
- `releases/latest` = `v0.2.5-hannipi`.

## Notes

- HanniGram vive en `C:\Users\alexlocal\projects\AlpeGram` (remote AlPeFe/HanniGram, limpio).
- El daemon de HanniGram se descubre por `HANNIGRAM_DAEMON`; el CLI `hannigram` por PATH.
- No hay `zip` en el entorno: empaquetar con Python.
