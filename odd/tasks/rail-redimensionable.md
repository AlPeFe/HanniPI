---
topic_key: odd/rail-redimensionable/tasks
status: active
base: 4dd21c769
---
# Rail derecho redimensionable

Objetivo: poder leer las tareas del rail derecho enteras. El rail pasa a ser una columna de ancho configurable (por defecto 34) que el usuario cambia desde la TUI, y las tareas largas se envuelven en varias líneas en vez de recortarse con "…".

Por qué: el rail pintaba a ancho fijo (32) y cada tarea se cortaba a una línea (`clip`), así que las tareas definidas con la tool `todo` no se podían leer. Plegarlas (ctrl+alt+t) ayuda a que no molesten, pero no a leerlas.

Alcance: ancho y render del rail en `coding-agent` (settings, layout, teclas, comandos) y la extensión `hanniorq`. Fuera: hacer el rail scrollable o arrastrable con el ratón.

Verify: `settings.railWidth` se clampa y persiste; el layout acepta anchos nuevos sin reconstruir el árbol; las tareas largas se ven enteras al ensanchar; `/hanniorq rail <n>` fija el ancho y ctrl+alt+←/→ lo mueven.

## Pasos

- [x] S1 `settings-manager`: `railWidth` (default 34, clamp 20-100) con getter/setter que persiste — verificado con `settings-manager.test.ts`.
- [x] S2 `chat-viewport`: la columna del rail se redimensiona mutando el `basis` del HStack (`setRightRailWidth`), sin remontar el layout — verificado con `chat-viewport.test.ts`.
- [x] S3 Teclas `app.rail.wider` / `app.rail.narrower` (ctrl+alt+→ / ctrl+alt+←) + wiring en `interactive-mode` (settings → layout → invalidar el widget → repaint) y `/hotkeys`.
- [x] S4 `ExtensionUIContext.getRailWidth()/setRailWidth()` (runner, TUI interactiva, RPC) y `/hanniorq rail <n>`.
- [x] S5 `hanniorq`: `RailText` reconstruye el contenido al cambiar el ancho y las tareas se envuelven (máx. 3 líneas, "…" solo si aún no cabe).
- [x] S6 Docs (`README`), ficha y commits atómicos. Publicado en la release v0.2.8-hannipi.

## Siguiente

Prueba manual en una terminal real: abrir `hanni`, `/hanniorq rail 60`, comprobar que las tareas se ven enteras y que `ctrl+alt+←/→` ajustan el ancho (persistido en `settings.json`). Requiere `hanni update` a v0.2.8 (`odd/tasks/release-0.2.8-hannipi.md`): el binario instalado era 0.2.7.

## Verificación funcional

- `npx vitest run test/keybindings.test.ts test/chat-viewport.test.ts test/settings-manager.test.ts test/hanniorq-extension.e2e.test.ts` → 80/80.
- A mano: abrir `hanni`, `/hanniorq rail 60`, comprobar que las tareas se ven enteras y que ctrl+alt+←/→ ajustan el ancho (persistido en `settings.json`).

## Notas

- Los tests de `packages/ai` fallan en este entorno por los datos de modelos generados que están en `.gitignore` (`npm run generate:models`); es ajeno a este cambio.
- La extensión ya no necesita saber el ancho "de fuera": lo recibe en `render(width)` y el rail se invalida al redimensionar.
