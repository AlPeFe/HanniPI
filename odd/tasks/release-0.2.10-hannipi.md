---
topic_key: odd/release-0.2.10-hannipi/tasks
status: done
base: a6bab91c2
---
# Release v0.2.10-hannipi

Objetivo: publicar la línea `hannigram → memory` de fin de turno y los 29 arreglos de upstream pi (tanda 1).

Alcance: bump lockstep, binario Windows x64 (bun 1.4.2), asset de HanniGram pinneado, notas y release.

Verify: `pi.exe --version` → `0.2.10-hannipi`; `releases/latest` → v0.2.10-hannipi con los 5 assets; `SHA256SUMS` remoto = local.

## Pasos

- [x] S1 Cherry-picks de la tanda 1 (27 + 1 recuperado a mano) + adaptación de tests a Windows — `192e0a2c2`.
- [x] S2 Bump lockstep a 0.2.10-hannipi + shrinkwrap/install-lock; checks de deps/imports/entry-graphs y biome en verde — `84eb25ce5`.
- [x] S3 Binario con bun 1.4.2 (`pi.exe --version` OK) y zip con Python.
- [x] S4 Release publicada como latest (tag en `84eb25ce5`, checksums verificados).

## Verificación funcional

- Suite completa con los mismos 115 fallos que `origin/main` (entorno), `tsc` sin errores nuevos, biome limpio.
- `SHA256SUMS` remoto idéntico; asset de HanniGram = pin `a6f2c28a…`; `pack-hannigram.ps1 -Check` al día.

## Notas

- Pendiente la tanda 2 de upstream (`odd/tasks/upstream-pi-picks.md`).
- El `hanni` instalado pasa a 0.2.10 con `hanni update` (o `HANNI.bat`).
