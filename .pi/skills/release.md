---
name: release
description: Publicar una release de HanniPI (bump lockstep + binario Windows x64 + GitHub release). Úsalo al preparar, publicar o recuperar una release.
---

# Publicar una release de HanniPI

Repo **standalone**: `origin` = `AlPeFe/HanniPI` (no hay remoto `upstream`). Versionado propio
`0.x.y-hannipi` en lockstep para todos los paquetes de `packages/*` (el root `package.json` no se
toca, y los paquetes de ejemplo privados tampoco).

Cada release publica `pi-windows-x64.zip` + `SHA256SUMS` y se marca como **latest**: el instalador
`install.ps1` resuelve `releases/latest`.

## 1. Bump lockstep

```bash
npm version 0.2.4-hannipi --workspaces --no-workspaces-update --no-git-tag-version
node scripts/sync-versions.js
npm install --package-lock-only --ignore-scripts
node scripts/generate-coding-agent-shrinkwrap.mjs
node scripts/generate-coding-agent-install-lock.mjs
npm run check
git add package-lock.json packages/*/package.json packages/coding-agent/npm-shrinkwrap.json packages/coding-agent/install-lock
git commit -m "chore(hannipi): bump versión a 0.2.4-hannipi (monorepo)"
git push origin main
```

Ojo: `npm version --workspaces` también tocaría los paquetes de ejemplo (están en `1.0.0`). Si
aparecen en `git status`, revierte con `git restore packages/coding-agent/examples` y vuelve a
regenerar los lockfiles.

## 2. Binario Windows x64

```bash
./scripts/build-binaries.sh --platform windows-x64 --skip-install --out ~/release-staging/hannipi-<ver>
```

El script compila y deja `windows-x64/pi.exe` + assets. El paso `zip` falla si no hay binario `zip`
(habitual en Windows) → empaqueta con Python:

```python
import os, zipfile
src = r"C:\Users\<user>\release-staging\hannipi-<ver>\windows-x64"
out = r"C:\Users\<user>\release-staging\hannipi-<ver>\pi-windows-x64.zip"
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for root, _dirs, files in os.walk(src):
        for f in files:
            full = os.path.join(root, f)
            z.write(full, os.path.relpath(full, src))
```

Comprueba `windows-x64/pi.exe --version` → `0.x.y-hannipi`.

## 3. Checksum y release

```bash
cd ~/release-staging/hannipi-<ver>
sha256sum pi-windows-x64.zip > SHA256SUMS
gh release create v0.x.y-hannipi -R AlPeFe/HanniPI \
  --title "HanniPI v0.x.y — Hanni harness" \
  --notes-file ~/release-staging/hannipi-notes-0xy.md \
  --latest pi-windows-x64.zip SHA256SUMS
```

`-R AlPeFe/HanniPI` es obligatorio: `gh` puede tener otro repositorio por defecto.

## 4. Verificar

```bash
gh api repos/AlPeFe/HanniPI/releases/latest -q .tag_name   # debe devolver el tag nuevo
gh release download v0.x.y-hannipi -R AlPeFe/HanniPI -p SHA256SUMS -O -   # debe coincidir con el local
```

## Notas

- El tag lo crea `gh release create` (vía API), así que **no** dispara el workflow `Build Binaries`
  (solo corre con `git push` de tags `v*`). Por eso las releases del fork son manuales.
- Si un push de tag disparara `Build Binaries`, construiría todos los binarios y publicaría la
  release desde CI; hoy no es el flujo.
