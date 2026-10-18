---
topic_key: odd/release-0.2.17-hannipi/tasks
status: done
base: b0b73e334
---
# Release v0.2.17-hannipi

Objetivo: publicar lo único pendiente desde la 0.2.16 — el panel `skills` del rail derecho — y dejarlo instalado en este host.

Alcance: bump lockstep, binario Windows x64 (bun 1.4.3), asset de HanniGram pinneado, notas y release.

Verify: `pi.exe --version` → `0.2.17-hannipi`; `releases/latest` → v0.2.17-hannipi con los 5 assets; `SHA256SUMS` remoto = local; `hanni update` real en este host.

## Pasos

- [x] S1 Bump lockstep a 0.2.17-hannipi (ejemplos revertidos, shrinkwrap e install-lock regenerados) y `npm run check` en verde — `f663817f9`.
- [x] S2 Binario windows-x64 con bun 1.4.3 (`pi.exe --version` OK; el panel `skills` está en el exe). Zip con `Compress-Archive` (54,675,440 B, 226 entradas).
- [x] S3 Asset de HanniGram: `-Check` al día (v0.2.1, `26b6067e…`), checksum verificado contra su release y smoke test `/health` OK.
- [x] S4 Release publicada como latest (tag en `f663817f9`), 5 assets, `SHA256SUMS` remoto idéntico.
- [x] S5 `hanni update` real en el host: 0.2.16 → 0.2.17 sin cerrar sesiones; daemon reinstalado y `/health` ok.

## Verificación funcional

- `gh api repos/AlPeFe/HanniPI/releases/latest -q .tag_name` → `v0.2.17-hannipi`; assets: `pi-windows-x64.zip` (54,675,440 B), `hannigram-windows-x64.zip` (115,991,479 B), `hanni-setup.ps1` (32,777 B), `HANNI.bat`, `SHA256SUMS` (sha256 del zip: `868edc78…`).
- `hanni --version` → `0.2.17-hannipi`; `test/hanniorq-extension.e2e.test.ts` → 29/29; `npm run check` limpio.
- La suite de tests no escribe en la memoria real (vitest apunta a un puerto muerto).

## Notas

- Quedan dos restos de instalación anteriores (`HanniPI.old-20261017-210811`, `HanniPI.old-20261018-083144`, ~108 MB cada uno): los mantienen las sesiones abiertas que corren sobre ellos. El instalador avisa y los reintenta en la siguiente actualización; se limpian solos al cerrar esas sesiones y volver a actualizar.
- HanniGram sigue pinneado en v0.2.1: el gate `-Check` dice que es la última.
- Pendiente para la próxima: la mitigación de la rueda en el terminal de Orca (bajar a seguimiento de botón, `1002h`) — `odd/tasks/rail-*`/memoria `hannipi/tui/wheel-orca`.
