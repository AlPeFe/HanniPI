---
topic_key: odd/release-0.2.7-hannipi/tasks
status: in_progress
base: a19553e0f
---
# Release HanniPI v0.2.7-hannipi

Objective: Publicar HanniPI v0.2.7-hannipi (bump lockstep + binario Windows x64 + GitHub release latest) con el fix de `hanni update` en Windows standalone (delega en `hanni-setup.ps1`).

Why: El usuario pidió release con el fix para que `hanni update` funcione por sí solo en instalaciones bun-binary de Windows.

Scope: versionado lockstep de `packages/*`, lockfiles, verificación (`npm run check`), push de `main`, binario Windows x64, checksum y release. Fuera de alcance: nuevas funcionalidades, otras plataformas.

Constraints: Seguir `.pi/skills/release.md`. `origin` = `AlPeFe/HanniPI`, `-R` explícito en `gh`. El tag lo crea `gh release create`. No tocar el root `package.json` ni los paquetes de ejemplo.

## Pasos

- [ ] S1 Bump lockstep a 0.2.7-hannipi y regenerar lockfiles (shrinkwrap + install-lock).
- [ ] S2 `npm run check` en verde.
- [ ] S3 Commit del bump y push de `main`.
- [ ] S4 Binario Windows x64 (bun compile) + `pi.exe --version`.
- [ ] S5 Empaquetar zip (python) + SHA256SUMS.
- [ ] S6 `gh release create v0.2.7-hannipi --latest` y verificar `releases/latest`.

## Siguiente

S1: bump lockstep.

## Verification

- `npm run check` exit 0.
- `windows-x64/pi.exe --version` = `0.2.7-hannipi`.
- `gh api repos/AlPeFe/HanniPI/releases/latest -q .tag_name` = `v0.2.7-hannipi`.

## Notes

- Sin `zip` en el entorno: empaquetar con Python.
- La release v0.2.7 incluye el fix `a19553e0f` para `hanni update` en Windows.
