---
topic_key: odd/release-0.2.9-hannipi/tasks
status: done
base: e4eb55978
---
# Release v0.2.9-hannipi

Objetivo: publicar v0.2.9 con el rail de MCP + contexto/compactación y el catálogo de paquetes en `/packages`.

Por qué: el `hanni` instalado sigue en 0.2.7; las mejoras del rail y del gestor solo llegan con release.

Alcance: bump lockstep, binario Windows x64 (bun 1.4.2), asset de HanniGram pinneado, notas y release.

Verify: `pi.exe --version` → `0.2.9-hannipi`; `releases/latest` → v0.2.9-hannipi con los 5 assets; `SHA256SUMS` remoto = local.

## Pasos

- [x] S1 Bump lockstep a 0.2.9-hannipi (17 ficheros, ejemplos revertidos) + shrinkwrap/install-lock; checks de pinned/runtime-deps, ts-imports, entry-graphs, shrinkwrap, install-lock y biome en verde — `3982b4654`.
- [x] S2 Binario Windows x64 compilado con **bun 1.4.2** (el local 1.3.9 produce un binario que muere con `node:sqlite`); `pi.exe --version` OK; zip con Python.
- [x] S3 Assets: `pi-windows-x64.zip`, `hannigram-windows-x64.zip` (= pin `a6f2c28a…`), `hanni-setup.ps1`, `HANNI.bat`, `SHA256SUMS`.
- [x] S4 Release v0.2.9-hannipi publicada como latest (tag en `3982b4654`, checksums verificados contra el remoto).

## Verificación funcional

- `gh release view v0.2.9-hannipi --json assets` → 5 assets; `SHA256SUMS` remoto idéntico al local.
- Tests nuevos de la release: catálogo (5), selector de paquetes (5), rail MCP (3), rail contexto/compactación (5 y 1 integración).

## Notas

- Para compilar el binario localmente hace falta bun ≥ 1.4.x (`node:sqlite`); el workflow `Build Binaries` ya fija `1.4.2`.
- El `hanni` instalado pasa a 0.2.9 con `hanni update` (o `HANNI.bat`); el binario en uso está bloqueado mientras la sesión corre.
