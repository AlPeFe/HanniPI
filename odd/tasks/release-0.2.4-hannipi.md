---
topic_key: odd/release-0.2.4-hannipi/tasks
status: active
base: c50fefa19
---
# Release HanniPI v0.2.4-hannipi

Objective: Publicar HanniPI v0.2.4-hannipi (bump lockstep + binario Windows x64 + GitHub release latest) con el cambio del rail (tareas del harness y memoria por estado).

Why: El usuario pidió la release tras el commit `c50fefa19` (rail con tool `todo`, memoria por estado, cambios compactos).

Scope: versionado lockstep de `packages/*`, lockfiles, verificación (`npm run check`), push de `main`, binario Windows x64, checksum y release. Fuera de alcance: cambios de código funcionales nuevos, otras plataformas.

Constraints: Seguir `.pi/skills/release.md`. `origin` = `AlPeFe/HanniPI`, `-R` explícito en `gh`. El tag lo crea `gh release create`. No tocar el root `package.json` ni los paquetes de ejemplo.

## Pasos

- [ ] S1 Bump lockstep a 0.2.4-hannipi y regenerar lockfiles (shrinkwrap + install-lock).
- [ ] S2 Hidratar datos de modelo y `npm run check` en verde.
- [ ] S3 Commit del bump y push de `main`.
- [ ] S4 Binario Windows x64 (bun compile) + `pi.exe --version`.
- [ ] S5 Empaquetar zip (python), SHA256SUMS.
- [ ] S6 `gh release create v0.2.4-hannipi --latest` y verificar `releases/latest`.

## Siguiente

S1: bump lockstep.

## Verification

- `npm run check` exit 0.
- `windows-x64/pi.exe --version` = `0.2.4-hannipi`.
- `gh api repos/AlPeFe/HanniPI/releases/latest -q .tag_name` = `v0.2.4-hannipi`.

## Notes

- Sin `zip` en el entorno: empaquetar con Python.
- `packages/ai/src/providers/data/` está gitignored; hidratar antes de `check`/build.
