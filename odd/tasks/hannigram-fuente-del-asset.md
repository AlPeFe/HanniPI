---
topic_key: odd/hannigram-fuente-del-asset/tasks
status: done
base: 4dd21c769
---
# HanniGram es la fuente del asset (pinneado)

Objetivo: que HanniGram publique su propio asset canónico (`hannigram-windows-x64.zip` con daemon + CLI + `pi-extension/`) y que HanniPI lo copie a su release **pinneado** por tag + sha256, en vez de construir el daemon desde fuente en cada release. El instalador, además, deja instalada la extensión `mem_*`.

Por qué: construir el daemon dentro de la release de HanniPI duplica el build (dos repos, dos toolchains), ata HanniPI a un ref de HanniGram y hace que un cambio del motor obligue a release de HanniPI. Con el asset canónico, HanniPI publica una copia verificada del artefacto exacto que HanniGram ya probó.

Alcance: `scripts/pack-hannigram.ps1`, `hannigram-version.json`, `hanni-setup.ps1`, `.pi/skills/release.md`, `README.md`, `AGENTS.md`. Fuera: el motor HanniGram (repo aparte) más allá de su workflow de release.

Verify: mirror local de `HanniGram/artifacts` → el script resuelve el pin, verifica sha256, lee `VERSION.txt` y el daemon responde `/health`; `-Check` sale 1 si el pin está desfasado y 0 si está al día. **Hecho**: con `-MirrorDir` sobre `HanniGram/artifacts` el checksum cuadra, el daemon responde `/health` y `-Check` devuelve 1/0 en los casos desfasado/al día.

## Pasos

- [x] S1 `scripts/pack-hannigram.ps1`: modo pinneado (descarga el asset de la release de HanniGram, valida sha256 contra su `SHA256SUMS`), `-Check` de drift, `-WritePin` y `-Build` como fallback desde fuente. Verificado con `-MirrorDir` sobre `HanniGram/artifacts`.
- [x] S2 `hanni-setup.ps1`: `-HannigramSource pinned|latest` + instalación de la `pi-extension` en `<agentDir>/extensions/hannigram` (y limpieza al desinstalar).
- [x] S3 HanniGram: `scripts/pack-asset.ps1` + `.github/workflows/release.yml` (tag `v*` → release con asset + `SHA256SUMS` + `VERSION.txt`), commit `373cc7d` local.
- [x] S4 Publicar la release de HanniGram: `373cc7d` empujado + tag `v0.1.0` → workflow `Release HanniGram` OK (1m16s); release con `hannigram-windows-x64.zip` (81,7 MB) + `SHA256SUMS` + `VERSION.txt`.
- [x] S5 `hannigram-version.json` pinneado a `v0.1.0` (`sha256 a6f2c28a…`, commit `373cc7d`), verificado contra el `SHA256SUMS` de la release y con `/health` del daemon del asset.
- [x] S6 Docs (`release.md`, `README.md`, `AGENTS.md`) al flujo pinneado.
- [x] S7 Arreglado un fallo real del modo pinneado que el mirror no cubría: el scriptblock de `Get-HanniGramRelease` no conservaba las variables locales, así que contra GitHub no resolvía el asset (`fix` en `ab1273ffd`).
- [x] S8 Extensión `mem_*` instalada en `~/.pi/agent/extensions/hannigram` desde el asset pinneado; descubierta y cargada por el harness con las 9 tools (`mem_search`, `mem_context`, `mem_timeline`, …) y 0 errores.

## Siguiente

Nada pendiente en este frente: la release `v0.1.0` de HanniGram está publicada, el pin vive en `hannigram-version.json` y el instalador instala la extensión. El asset va dentro de la release de HanniPI v0.2.8 (`odd/tasks/release-0.2.8-hannipi.md`). Cuando HanniGram saque otra release, `-Check` avisará (exit 1) y se adopta con `-Tag <nueva> -WritePin`.

## Verificación funcional

- Mirror local (`gh release download v0.1.0 -D <tmp>`): checksum OK, `VERSION.txt` parseado, smoke test del daemon OK y `-Check` al día (exit 0).
- `-Check` contra GitHub con el pin puesto: exit 0; con la release desfasada: exit 1.
- El guard del pin detecta un asset que no cuadra (probado con los `artifacts/` locales, sha distinto).
- Extensión del asset instalada y cargada de verdad por el harness (9 tools `mem_*`, 0 errores) usando el agent dir real del usuario.

## Notas

- `pi-extension` no necesita `node_modules`: el harness resuelve `typebox` y `@earendil-works/pi-coding-agent` como módulos virtuales.
- `<agentDir>/extensions/<dir>/package.json` con campo `pi.extensions` es una de las reglas de descubrimiento del harness (`loader.ts`).
- La env var correcta es `HANNI_CODING_AGENT_DIR` (APP_NAME=`hanni`); por defecto `~/.pi/agent`.
- El daemon instalado en la máquina se compiló desde `99968f0`; el asset de `v0.1.0` sale de `373cc7d`, y `git diff 99968f0..373cc7d -- src pi-extension` está vacío: mismo código.
- En este checkout hacen falta los datos de modelos generados (`npm run hydrate-model-data` en `packages/ai`, `src/providers/data/` está en `.gitignore`) para que `tsc` y las extensiones carguen; sin ellos fallan ~88 tests por entorno, igual que en `origin/main`.
