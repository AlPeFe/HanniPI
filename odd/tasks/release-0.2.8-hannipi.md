---
topic_key: odd/release-0.2.8-hannipi/tasks
status: done
base: f81ddcdca
---
# Release v0.2.8-hannipi

Objetivo: publicar v0.2.8 con el rail redimensionable y con el asset de HanniGram pinneado (`v0.1.0`).

Por qué: el `hanni` instalado es 0.2.7, así que el rail nuevo y la extensión `mem_*` solo llegan con release.

Alcance: bump lockstep, binario Windows x64, asset de HanniGram pinneado, notas y release en GitHub.

Verify: `pi.exe --version` → `0.2.8-hannipi`; `releases/latest` → v0.2.8-hannipi con los 5 assets; `SHA256SUMS` remoto igual al local.

## Pasos

- [x] S1 Bump lockstep a 0.2.8-hannipi (17 ficheros, ejemplos privados revertidos) + shrinkwrap/install-lock regenerados; checks de deps/imports/entry-graphs y biome en verde — `486e965d0`.
- [x] S2 Binario Windows x64 con `build-binaries.sh --platform windows-x64` (tsc + bundle + `bun build --compile`) y `pi.exe --version` → `0.2.8-hannipi`; zip con Python (`zip` no existe en Windows).
- [x] S3 **Bloqueo resuelto**: `bun` 1.3.9 (local) compila un binario que muere con `No such built-in module: node:sqlite`; se compiló con bun **1.4.2** (el que usó la 0.2.7) y el workflow se actualizó a 1.4.2.
- [x] S4 Asset de HanniGram copiado desde el pin (sha `a6f2c28a…` = `hannigram-version.json`) + `hanni-setup.ps1` + `HANNI.bat` + `SHA256SUMS`.
- [x] S5 Release v0.2.8-hannipi publicada como latest con los 5 assets.

## Verificación funcional

- `gh release view v0.2.8-hannipi --json assets` → `pi-windows-x64.zip` (46,8 MB), `hannigram-windows-x64.zip` (81,7 MB), `hanni-setup.ps1`, `HANNI.bat`, `SHA256SUMS`; checksums remotos = locales.
- Tag `v0.2.8-hannipi` apunta al main publicado (incluye el bump).

## Notas

- El tag se crea con la API (`gh release create`), así que no dispara `Build Binaries` (y en este repo no hay runs de Actions: se publica en local).
- El `hanni` instalado en la máquina sigue siendo 0.2.7 hasta que el usuario ejecute `hanni update` (o `HANNI.bat`), porque el binario en uso está bloqueado.
