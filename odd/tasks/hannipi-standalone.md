---
topic_key: hannipi/feat/standalone
status: active
base: 13f2c92e3
---
# hannipi-standalone
Objetivo: HanniPI deja de depender de pi (repo, identidad, config y namespace propios).
Por qué: el fork arrastra remoto upstream, workflows/bots heredados, config `.pi` y el scope `@earendil-works/*`.
Alcance: remoto upstream, workflows/.github, branding (share viewer), configDir + migración, namespace de paquetes, docs/skills. Fuera: repo nuevo y recorte de paquetes (F4, pendiente de decidir).
Verify: `npm run check` + vitest de coding-agent + `hanni --version`.

## Pasos
- [x] S1 Quitar el remoto `upstream` y fijar `gh` al fork (`.git/config`, sin commit).
- [x] S2 Quitar los workflows heredados de upstream y limpiar `.github` (dejar CI + Build Binaries). Evidence: eliminados 8 workflows (approve-contributor, issue-analysis, issue-gate, issue-triage-labels, npm-audit, pr-gate, publish-model-catalog, remove-inprogress-on-close) + `APPROVED_CONTRIBUTORS` + `ISSUE_TEMPLATE/`; quedan `ci.yml` y `build-binaries.yml`.
- [x] S3 Identidad: quitar el share viewer de pi.dev y ajustar docs/skills (`release.md`) al flujo real. Evidence: `getShareViewerUrl` usa `HANNI_SHARE_VIEWER_URL` (fallback `PI_SHARE_VIEWER_URL`) y cae al gist; `release.md`/`CONTRIBUTING.md`/`SECURITY.md`/README reescritos a standalone; `npm run check` exit 0.
- [ ] S4 Config propia: `configDir` `.hanni` + migración desde `.pi` (global y proyecto) + fallback `PI_*`.
- [ ] S5 Namespace `@earendil-works/*` → `@hannipi/*` + lockfiles/shrinkwrap/install-lock + reinstalar global.
- [ ] S6 Verificación global (check + tests + binario) y docs standalone.

## Siguiente
S4: config propia `.hanni` + migración desde `.pi` (global y proyecto) + fallback `PI_*`.

## Notas
- La sesión actual corre desde el symlink global `@earendil-works/pi-coding-agent` → repo; el renombrado de S5 exige reinstalar global al final.
- `piConfig.name` ya es `hanni` (APP_NAME) y el env ya es `HANNI_CODING_AGENT_DIR`; lo que sigue en `.pi` es `CONFIG_DIR_NAME`.
