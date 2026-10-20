---
topic_key: hannipi/feat/arranque-modelo-y-servicios
status: done
base: 738776aec
---
# arranque sin modelo y servicios en el rail
Objetivo: al abrir HanniPI en la TUI no hay modelo seleccionado por defecto: el harness pide elegir uno antes del primer turno. Y el rail derecho muestra los puertos/servicios que el harness tiene activos (HanniGram, MCP HTTP conectados) con nombre y puerto.
Por qué: el modelo de la sesión no debería decidirse por un default silencioso (se acaba hablando con el modelo equivocado); y saber que hay algo escuchando en un puerto evita dudas al probar servidores locales.
Alcance: `core/sdk.ts` (opción para no resolver modelo inicial), `core/agent-session-services.ts`, `main.ts` (runtime inicial en modo interactivo), `modes/interactive/interactive-mode.ts` (selector obligatorio al arrancar), `components/top-bar.ts` y `extensions/hanniorq/index.ts` (sección `servicios` del rail). Fuera: sesiones reanudadas (`--continue`/`--resume` conservan su modelo) y modos print/rpc.
Verify: `npm run check` y `.\pi-test.ps1` en un terminal de Orca (arranque pide modelo; rail pinta `servicios` con HanniGram :8765).

## Pasos
- [x] S1 Arranque interactivo sin modelo: `createAgentSession` acepta `requireModelSelection` (no aplica default) y `main.ts` lo activa en el runtime inicial cuando no hay `--model`/`--provider` — 770b1df36
- [x] S2 TUI: si la sesión arranca sin modelo, el selector de modelo se abre antes del primer turno y no deja continuar sin elegir (primer Esc avisa, segundo sale) — 770b1df36
- [x] S3 Rail: panel `servicios` con nombre + puerto de lo que el harness tiene activo (daemon HanniGram y servidores MCP HTTP conectados) — 6dea9bdba
- [x] S4 `npm run check` y prueba funcional en la TUI — 6dea9bdba

## Siguiente
Publicado en [v0.2.18-hannipi](https://github.com/AlPeFe/HanniPI/releases/tag/v0.2.18-hannipi) (bump e64b1690b). Nada pendiente.

## Verificación funcional
- `npm run check` limpio (biome, locks, shrinkwrap, `tsc --noEmit`, entry graphs, browser-smoke) tras S1-S3.
- Tests: `test/hanniorq-context-rail.test.ts`, `test/hanniorq-memory-line.test.ts`, `test/model-resolver.test.ts` → 70/70.
- TUI real (terminal de Orca con `.\pi-test.ps1`): sin flags, la barra superior pinta `no-model` y el selector aparece solo; Enter elige el modelo y la barra pasa a `deepseek-v4.1-flash • low`; primer Esc reabre con el aviso "Sin modelo no se puede empezar…", segundo Esc sale a PowerShell; con `--model` no hay selector y el modelo está desde el arranque.
- Rail real: con el daemon arriba aparece `╭─ servicios (1) ╮ │ ● HanniGram :8765 · memoria │`; context7 (MCP sin puerto en la URL) no se pinta.

## Notas
- El modelo elegido es de sesión: no se guarda como default (Ctrl+S en el selector sí). `defaultProvider`/`defaultModel` quedan como preferencia que ordena el selector, no como modelo inicial; `_persistLastUsedModelAsDefault` sigue recordando el último modelo usado para ese orden.
- Sin ningún modelo disponible (sin auth) no se bloquea: se avisa con `formatNoModelsAvailableMessage()` y se deja entrar para poder `/login`.
- El placeholder `unknown` del Agent se trata como "sin modelo" en la barra superior y en la condición del arranque.
- `servicios` solo se pinta con algo activo; el puerto sale de `HANNIGRAM_URL` (health) y de la URL de los MCP HTTP conectados. Los MCP stdio no publican puerto.
