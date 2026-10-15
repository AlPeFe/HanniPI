---
topic_key: odd/hannigram-obligatorio-en-release/tasks
status: active
base: f81ddcdca
---
# hannigram obligatorio en la release

Objetivo: que cada release de HanniPI incluya `hannigram-windows-x64.zip` y que el instalador lo instale siempre, fallando claro si falta (hoy se salta el daemon en silencio y lo borra al actualizar).

Por qué: las releases v0.2.6/v0.2.7 salieron sin el asset del daemon, así que `hanni-setup.ps1` avisaba "me salto HanniGram" tras haber borrado `%LOCALAPPDATA%\HanniPI` (que contiene `hannigram\`). HanniPI sin HanniGram no vale nada.

Alcance: `scripts/pack-hannigram.ps1` (nuevo), `hanni-setup.ps1`, `.pi/skills/release.md`, `README.md`, asset + release. Fuera: otras plataformas (solo win-x64), cambios del motor HanniGram.

Verify: `powershell -File scripts/pack-hannigram.ps1` produce el asset con `HanniGram.Server.exe` + `hannigram.exe`; `hanni --version` y `/health` del daemon OK.

## Pasos

- [x] S1 `scripts/pack-hannigram.ps1`: clone/publish self-contained win-x64 de Server+CLI, staging, zip y sha256 — 4321efae0
- [x] S2 Asset construido y verificado: 78,9 MB, `sha256 f0adfed3…`, daemon `/health` OK (layout v0.2.5 igual).
- [x] S3 `hanni-setup.ps1`: valida PI+daemon antes de borrar, aborta si falta el asset, stage-then-swap y `/health` — c5edb2e4b
- [x] S4 Runbook `release.md` + `README.md` + `AGENTS.md` — af6544063, 1d4bc21ea
- [x] S5 Daemon reparado en esta máquina (`%LOCALAPPDATA%\HanniPI\hannigram`, `/health` ok con la BD real).
- [ ] S6 Publicar el asset en la release (o sacar v0.2.8) — pendiente de OK.

## Siguiente

S6: con OK del usuario, `gh release upload v0.2.7-hannipi -R AlPeFe/HanniPI hannigram-windows-x64.zip` + regenerar `SHA256SUMS` (incluye también `hanni-setup.ps1`/`HANNI.bat`); o bump a v0.2.8 y release completa con `pack-hannigram.ps1`.

## Verificación funcional

- Happy path (release falsa local + `LOCALAPPDATA` falso): instala `hanni.exe` + daemon, `/health` ok.
- Sin el asset del daemon: aborta con mensaje claro y deja intacta la instalación previa (antes la borraba).

## Notas

- Fuente del daemon: repo público `AlPeFe/HanniGram` (sin releases propias); el asset vive en la release de HanniPI.
- El smoke test usa `HANNIGRAM_URLS` (el daemon no lee `--urls`) y el CLI funciona standalone en el stage.
- `dotnet publish` fija `--source https://api.nuget.org/v3/index.json`: el feed privado de esta máquina tiene el certificado caducado.
