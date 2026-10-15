---
topic_key: odd/hannigram-fuente-del-asset/tasks
status: active
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
- [ ] S4 Publicar la release de HanniGram (push `373cc7d` + tag `v0.1.0`) — pendiente de OK del usuario.
- [ ] S5 `hannigram-version.json` con el pin real (`pack-hannigram.ps1 -Tag v0.1.0 -WritePin`) — depende de S4.
- [x] S6 Docs (`release.md`, `README.md`, `AGENTS.md`) al flujo pinneado.

## Siguiente

S4: `git -C ../HanniGram push origin main && git tag v0.1.0 && git push origin v0.1.0`; el workflow publica el asset. Después S5 y S6.

## Verificación funcional

- Mirror local: `pack-hannigram.ps1 -Tag v0.1.0 -MirrorDir <HanniGram>/artifacts` → checksum OK, `VERSION.txt` parseado, daemon `/health` OK.
- `-Check` con pin desfasado → exit 1; con pin al día → exit 0.
- Tras S4: `hannigram-version.json` (`-WritePin`) e instalar de verdad con `hanni-setup.ps1 -Action update -HannigramSource pinned` → `/health` + tools `mem_*` en `~/.pi/agent/extensions/hannigram`.

## Notas

- `pi-extension` no necesita `node_modules`: el harness resuelve `typebox` y `@earendil-works/pi-coding-agent` como módulos virtuales.
- `<agentDir>/extensions/<dir>/package.json` con campo `pi.extensions` es una de las reglas de descubrimiento del harness (`loader.ts`).
- La env var correcta es `HANNI_CODING_AGENT_DIR` (APP_NAME=`hanni`); por defecto `~/.pi/agent`.
- HanniGram no tenía releases ni tags: el workflow solo publica al empujar un tag `v*`.
