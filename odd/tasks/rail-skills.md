---
topic_key: hannipi/feat/rail-skills
status: done
base: 270687f3f
---
# rail-skills
Objetivo: que el rail derecho diga qué skills está usando el agente y en qué estado: `en uso` mientras el run en curso los usa, `activado` cuando ya se cargaron en la sesión.
Por qué: un skill se activa cuando el modelo lee su fichero (o el usuario escribe `/skill:<nombre>`) y eso no se veía en ninguna parte del harness.
Alcance: extensión `hanniorq` (estado de sesión + panel del rail + eventos), docs y test. Fuera: activación por `bash` (`cat SKILL.md`), skills de subagentes y persistir el estado entre sesiones.
Verify: `test/hanniorq-extension.e2e.test.ts` y `npm run check`.

## Pasos
- [x] S1 Estado de skills por sesión (`using` / `activated`) y panel `skills` debajo de `tareas` (`skills (usados/disponibles)`) — 10b9401ac
- [x] S2 Eventos que mueven el estado: leer un fichero del catálogo del system prompt o un `<dir>/SKILL.md` marca en uso; un prompt con `<skill name="…">` (`/skill:<nombre>`) también; `before_agent_start` y `agent_settled` cierran el ciclo; `session_start` lo limpia — 10b9401ac
- [x] S3 Tests (en uso → activado; una ficha `odd/tasks/x.md` no cuenta como skill) y docs (CHANGELOG + `docs/how-pi-works.md`) — 10b9401ac

## Siguiente
Verlo en la TUI real: `.\pi-test.ps1` desde el repo y `/skill:sodd`; el panel sale debajo de `tareas`. Para que llegue al binario instalado hace falta una release (0.2.17).

## Verificación funcional
- `test/hanniorq-extension.e2e.test.ts` → 29/29 (con los dos casos nuevos: `skills (1/2)` + lectura, y comando `/skill:` + ficha que no cuenta).
- Render a 34 columnas: `╭─ skills (1/2) ───╮` / `│ ✓ release · activado │`.
- `npm run check` limpio.

## Notas
- Solo cuentan las rutas del catálogo (`event.systemPromptOptions.skills`) y la convención `<dir>/SKILL.md`; así leer `odd/tasks/x.md` no se confunde con un skill.
- "en uso" = el run en curso; se cierra con `agent_settled` y al empezar el prompt siguiente. "activado" = ya se cargó en esta sesión.
- Se descartó pintar el disparador (comando vs lectura) en la línea del rail por ancho: con 30 columnas de contenido el nombre se recortaba. Quién lo activó se ve en el transcript.
