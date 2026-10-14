---
topic_key: odd/release-0.2.6-hannipi/tasks
status: in_progress
base: 5baf07544
---
# Release HanniPI v0.2.6-hannipi

Objective: Publicar HanniPI v0.2.6-hannipi (bump lockstep + binario Windows x64 + GitHub release latest) con la identidad femenina de Hanni en el prompt del sistema y el uso de kaomoji.

Why: El usuario pidió definir a HanniPI como mujer en el código (el prompt ya dice "Hanni es mujer", formas femeninas y kaomoji) y crear la release.

Scope: versionado lockstep de `packages/*`, lockfiles, verificación (`npm run check`), push de `main`, binario Windows x64, checksum y release. Fuera de alcance: nuevas funcionalidades, otras plataformas.

Constraints: Seguir `.pi/skills/release.md`. `origin` = `AlPeFe/HanniPI`, `-R` explícito en `gh`. El tag lo crea `gh release create`. No tocar el root `package.json` ni los paquetes de ejemplo.

## Pasos

- [x] S1 Identidad femenina en el system prompt + kaomoji, help de arranque en femenino, test y changelog. Evidencia: commit `5baf07544`.
- [ ] S2 Bump lockstep a 0.2.6-hannipi y regenerar lockfiles (shrinkwrap + install-lock).
- [ ] S3 `npm run check` en verde.
- [ ] S4 Commit del bump y push de `main`.
- [ ] S5 Binario Windows x64 (bun compile) + `pi.exe --version`.
- [ ] S6 Empaquetar zip (python) + SHA256SUMS.
- [ ] S7 `gh release create v0.2.6-hannipi --latest` y verificar `releases/latest`.

## Siguiente

S2: bump lockstep.

## Verification

- `npm run check` exit 0.
- `windows-x64/pi.exe --version` = `0.2.6-hannipi`.
- `gh api repos/AlPeFe/HanniPI/releases/latest -q .tag_name` = `v0.2.6-hannipi`.

## Notes

- Sin `zip` en el entorno: empaquetar con Python.
- `packages/ai/src/providers/data/` está gitignored; hidratar antes de `check`/build.
