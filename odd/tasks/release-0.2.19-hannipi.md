---
topic_key: odd/release-0.2.19-hannipi/tasks
status: done
base: 0796a4f9a
---
# Release v0.2.19-hannipi

Objetivo: publicar lo único pendiente desde la 0.2.18 — el fix de caché de prefijo (`55dad3a92`, el briefing de memoria se inyecta una sola vez por sesión) — para que llegue al binario instalado.

Alcance: bump lockstep, binario Windows x64 (bun 1.4.3), asset de HanniGram pinneado, notas y release. Sin cambios de código: el fix ya estaba en `main`.

Verify: `pi.exe --version` → `0.2.19-hannipi`; `releases/latest` → v0.2.19-hannipi con los 5 assets; `SHA256SUMS` remoto = local; digests de la API coinciden.

## Pasos

- [x] S1 Bump lockstep a 0.2.19-hannipi (`npm version --workspaces --no-workspaces-update`, ejemplos revertidos, `sync-versions.js`, shrinkwrap e install-lock regenerados) y `npm run check` en verde — `2f791b02e`.
- [x] S2 Binario windows-x64 con bun 1.4.3: `pi.exe --version` → `0.2.19-hannipi`; zip con `Compress-Archive` (54,678,249 B).
- [x] S3 Asset de HanniGram: `-Check` al día (v0.2.1, `26b6067e…`), checksum verificado contra su release y smoke test `/health` OK en `:8799`.
- [x] S4 Release publicada como latest con los 5 assets; `SHA256SUMS` remoto idéntico al local.
- [x] S5 Verificación de digests de la API: los 5 coinciden con el `sha256` local.

## Verificación funcional

- `gh api repos/AlPeFe/HanniPI/releases/latest -q .tag_name` → `v0.2.19-hannipi`.
- Assets: `pi-windows-x64.zip` 54,678,249 B (`7d0d400a…`), `hannigram-windows-x64.zip` 115,991,479 B (`26b6067e…`), `hanni-setup.ps1` 32,777 B, `HANNI.bat` 1,325 B, `SHA256SUMS` 177 B.
- `npm run check` limpio antes del build (biome, pinned-deps, runtime-deps, ts-imports, entry-graphs, shrinkwrap, install-lock, tsc, browser-smoke).

## Notas

- El changelog ya traía la entrada del fix en `### Fixed` desde `55dad3a92`; este release no añade cambios de código, solo el bump.
- El host sigue en 0.2.18 hasta que se ejecute `hanni update` / `hanni-setup.ps1 -Action update`; no se instaló en esta sesión.
- Contexto del porqué (benchmark de tokens, 89% del coste en misses de caché): memoria `hannipi/costes/tokens` y `hannipi/memoria/cache-prefijo`.
- HanniGram sigue pinneado en v0.2.1: el gate `-Check` dice que es la última.
