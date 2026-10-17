---
topic_key: odd/release-0.2.16-hannipi/tasks
status: done
base: 876f31bdc
---
# Release v0.2.16-hannipi

Objetivo: publicar el arreglo de `hanni update` en Windows y los 7 commits que la 0.2.15 dejó fuera (memoria al arrancar, rail, thinking, tests aislados).

Alcance: bump lockstep, binario Windows x64 (bun 1.4.3), asset de HanniGram pinneado, notas y release.

Verify: `pi.exe --version` → `0.2.16-hannipi`; `releases/latest` → v0.2.16-hannipi con los 5 assets; `SHA256SUMS` remoto = local; `hanni update` real en este host.

## Pasos

- [x] S1 Bump lockstep a 0.2.16-hannipi (ejemplos revertidos, shrinkwrap e install-lock regenerados) y `npm run check` en verde — `9efb61fbd`.
- [x] S2 Binario windows-x64 con bun 1.4.3 (`pi.exe --version` OK; `RailColumn` presente en el exe). El zip del script falla por falta de `zip`: empaquetado con `Compress-Archive` (mismo método que la 0.2.15, 226 entradas, 124,5 MB sin comprimir).
- [x] S3 Asset de HanniGram: pin al día (`-Check` en verde, v0.2.1, `26b6067e…`), checksum verificado contra su release y daemon del asset respondiendo `/health` en el smoke test.
- [x] S4 Release publicada como latest (tag en `9efb61fbd`), 5 assets, `SHA256SUMS` remoto idéntico.
- [x] S5 `hanni update` real desde el binario instalado 0.2.15 → 0.2.16, sin matarse a sí mismo.

## Verificación funcional

- `gh api repos/AlPeFe/HanniPI/releases/latest -q .tag_name` → `v0.2.16-hannipi`; assets: `pi-windows-x64.zip` (54,674,090 B), `hannigram-windows-x64.zip` (115,991,479 B), `hanni-setup.ps1` (32,777 B), `HANNI.bat`, `SHA256SUMS`.
- `hanni update` (0.2.15 → 0.2.16): checksums verificados, 2 `HanniGram.Server.exe` parados (nada de `hanni.exe`), instalación por renombrado, daemon reinstalado y `/health` ok, staging de `%TEMP%` limpio, y limpieza del resto `HanniPI.old-20261017-160713` del intento fallido anterior.
- `hanni --version` → `0.2.16-hannipi`; queda `HanniPI.old-20261017-210811` (en uso por la sesión abierta), se borra en la próxima actualización.
- `npm run check` limpio (biome, locks, shrinkwrap, `tsc --noEmit`, entry graphs).

## Notas

- La 0.2.15 ya delegaba en `hanni-setup.ps1` (descargado de main), así que el arreglo del instalador llega por sí solo: por eso la actualización funcionó desde el binario viejo.
- El script `build-binaries.sh` sigue sin poder crear el zip en Windows (no hay `zip`); `Compress-Archive` produce el mismo layout que las releases anteriores.
- HanniGram sigue pinneado en v0.2.1: `-Check` dice que es la última.
