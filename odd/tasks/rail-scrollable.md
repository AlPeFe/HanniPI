---
topic_key: hannipi/feat/rail-scrollable
status: done
base: 7f6e6e07b
---
# rail-scrollable
Objetivo: poder desplazar el rail derecho (rueda o arrastrando su scrollbar) para leer todas sus secciones, no solo las de arriba.
Por qué: la extensión ya publicaba un `ScrollView` para el rail, pero el harness lo envolvía en un `Container` normal. El layout solo desciende por nodos de layout y un `Container` es opaco: el scroll node se perdía, el rail se renderizaba entero y lo que sobraba quedaba recortado por la terminal. El `CHANGELOG` ya daba el scroll por hecho.
Alcance: `packages/coding-agent` (chat-viewport, interactive-mode, docs, test). Fuera: teclas de scroll del rail (sigue siendo ratón) y el modo `regular`, que no enruta eventos de ratón.
Verify: `npm run check` + `test/interactive-tui.test.ts` (rueda sobre el rail).

## Pasos
- [x] S1 `RailColumn` (pila vertical que estira al hijo a toda la altura) y el contenedor del rail derecho lo usa, así el widget del rail es un nodo de scroll real. Test con la TUI fullscreen: la rueda sobre el rail lo desplaza y el transcript no se mueve; docs. — 9132db779

## Siguiente
Nada: el rail se desplaza. Si molesta que no haya teclado, el siguiente paso natural sería una tecla (p.ej. `app.rail.scroll`) que desplace el rail con foco, reutilizando `ScrollView.scrollBy`.

## Verificación funcional
- `node node_modules/vitest/dist/cli.js --run test/interactive-tui.test.ts test/chat-viewport.test.ts test/hanniorq-extension.e2e.test.ts test/hanniorq-context-rail.test.ts` → 56/56.
- Diagnóstico confirmado: con un `Container` en lugar de `RailColumn`, el test falla (`expected 0 to be greater than 0`).
- `npm run check` limpio (biome, shrinkwrap, tsc, entry graphs).

## Notas
- El rail va con `overscroll: "contain"`: cuando no puede desplazarse más, la rueda no pasa el gesto al transcript. Intencionado.
- El estado del scroll sobrevive a los refrescos del rail porque el `ScrollView` vive en un `WeakMap` por `ui` (ya existía; antes era inútil).
- Revisión de la release: `main` == `origin/main`, árbol limpio, sin stashes; el tag `v0.2.15-hannipi` (8ce80b818) es ancestro de `main` y está pusheado, pero hay 7 commits posteriores sin publicar (fix de `hanni update`, rail de tareas, briefing de memoria, handoff rodante, resumen de thinking, aislamiento de tests, docs). La release no está "sin commitear": está por detrás de main.
