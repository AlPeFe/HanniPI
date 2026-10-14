---
topic_key: odd/release-0.2.6-hannipi/tasks
status: done
base: 5baf07544
---
# Release HanniPI v0.2.6-hannipi

Objective: Publicar HanniPI v0.2.6-hannipi (bump lockstep + binario Windows x64 + GitHub release latest) con la identidad femenina de Hanni en el prompt del sistema y el uso de kaomoji.

Why: El usuario pidió definir a HanniPI como mujer en el código (el prompt ya dice "Hanni es mujer", formas femeninas y kaomoji) y crear la release.

Scope: versionado lockstep de `packages/*`, lockfiles, verificación (`npm run check`), push de `main`, binario Windows x64, checksum y release. Fuera de alcance: nuevas funcionalidades, otras plataformas.

Constraints: Seguir `.pi/skills/release.md`. `origin` = `AlPeFe/HanniPI`, `-R` explícito en `gh`. El tag lo crea `gh release create`. No tocar el root `package.json` ni los paquetes de ejemplo.

## Pasos

- [x] S1 Identidad femenina en el system prompt + kaomoji, help de arranque en femenino, test y changelog. Evidencia: commit `5baf07544`.
- [x] S2 Bump lockstep a 0.2.6-hannipi y regenerar lockfiles (shrinkwrap + install-lock). Evidencia: commit `d86007ab8`.
- [x] S3 `npm run check` en verde. Evidencia: exit 0.
- [x] S4 Commit del bump y push de `main`. Evidencia: `d6c5a661d..716845ac6`.
- [x] S5 Binario Windows x64 (bun compile) + `pi.exe --version`. Evidencia: `0.2.6-hannipi`.
- [x] S6 Empaquetar zip (python) + SHA256SUMS. Evidencia: `35c60c54…`, 47.76 MB.
- [x] S7 `gh release create v0.2.6-hannipi --latest` y verificar `releases/latest`. Evidencia: tag `v0.2.6-hannipi`, assets `pi-windows-x64.zip` + `SHA256SUMS`, checksum remoto = local.

## Siguiente

ninguno.

## Verification

- `npm run check` exit 0.
- `windows-x64/pi.exe --version` = `0.2.6-hannipi`.
- `gh api repos/AlPeFe/HanniPI/releases/latest -q .tag_name` = `v0.2.6-hannipi`.

## Notes

- Sin `zip` en el entorno: empaquetar con Python.
- `packages/ai/src/providers/data/` está gitignored; hidratar antes de `check`/build.
