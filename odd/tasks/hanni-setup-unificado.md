---
topic_key: odd/hanni-setup-unificado/tasks
status: done
base: fe167f0ee
---
# Instalador unificado HanniPI + HanniGram (release v0.2.5-hannipi)

Objective: Un solo script de Windows que pregunte Instalar / Actualizar / Desinstalar, pare todos los procesos/servicios bun y HanniGram activos, e instale o quite HanniPI **y** HanniGram juntos.

Why: En un PC Windows HanniGram no se instaló junto a HanniPI (el instalador antiguo solo ponía el binario de HanniPI). Además, al reinstalar/desinstalar, el `hanni.exe` en marcha bloquea los ficheros y falla; hay que parar los servicios bun relacionados con hanni primero.

Scope: scripts de instalación/desinstalación/actualización en Windows, empaquetado del daemon HanniGram como binario Windows x64, y release de HanniPI con esos assets. Fuera de alcance: macOS/Linux, cambios funcionales del harness.

Constraints: Un único punto de entrada (`.bat` de doble clic) que delega en un `.ps1`. No tocar el `pi` de earendil-works. Parar procesos antes de borrar/instalar. Mantener `install.ps1` por compatibilidad (URL histórica del README) apuntando al nuevo flujo.

## Pasos

- [x] S1 Publicar HanniGram (Server + Cli) self-contained win-x64 y empaquetarlo. Evidencia: `hannigram-windows-x64.zip` (81.6 MB), `97df6afd…`.
- [x] S2 Escribir el script unificado (`HANNI.bat` + `hanni-setup.ps1`). Evidencia: commit `747fef2f6`.
- [x] S3 Verificar sintaxis PowerShell y ejecucion controlada (menu + install a LOCALAPPDATA falso). Evidencia: parse OK, install exit 0, `hanni --version` = 0.2.5-hannipi.
- [x] S4 Bump a 0.2.5-hannipi + build del binario Windows x64 y assets. Evidencia: `d1f1258a4`, `pi-windows-x64.zip` (`86df4090…`).
- [x] S5 Commit + push main + release v0.2.5-hannipi con scripts y assets. Evidencia: tag `v0.2.5-hannipi`, 5 assets.
- [x] S6 Verificar release/asset/checksum y el flujo real `HANNI.bat` solo (descarga hanni-setup.ps1 y muestra menu). Evidencia: `releases/latest` = v0.2.5-hannipi; SHA256SUMS remoto = local.

## Siguiente

ninguno.

## Verification

- `hanni-setup.ps1` parsea sin errores; install a LOCALAPPDATA falso exit 0.
- Assets de la release: `pi-windows-x64.zip`, `hannigram-windows-x64.zip`, `SHA256SUMS`, `HANNI.bat`, `hanni-setup.ps1`.
- `releases/latest` = `v0.2.5-hannipi`; SHA256SUMS remoto = local.
- Flujo real: `HANNI.bat` suelto descarga `hanni-setup.ps1` y muestra el menu.

## Notes

- HanniGram vive en `C:\Users\alexlocal\projects\AlpeGram` (remote AlPeFe/HanniGram, limpio).
- El daemon de HanniGram se descubre por `HANNIGRAM_DAEMON`; el CLI `hannigram` por PATH.
- No hay `zip` en el entorno: empaquetar con Python.
