---
topic_key: odd/tui-rediseno/tasks
status: active
base: bad1c4c01
---
# Rediseño visual de la TUI (paneles con título)

Objetivo: que la TUI deje de ser una lista de bloques con fondo y pase a un layout con **conceptos separados**: chrome fijo arriba y abajo, y cada grupo de contenido dentro de un panel con título en el borde (tú, hanni, cada herramienta, y cada sección del rail derecho).

Por qué: hoy todo compite en la misma columna — mensajes de usuario y tool results son slab con fondo, el footer mezcla cwd + tokens + modelo + atajos en dos líneas, y el rail derecho apila secciones sin separación clara. El estilo de referencia (TUI de Rysana) usa una barra superior con identidad y chips de estado, paneles con el título embebido en el borde superior, un caption en el borde inferior, y una barra inferior con chip de modo + atajos. Eso es lo que se implementa aquí.

Alcance: `packages/tui` (componente `Panel`) y `packages/coding-agent` (chrome, bloques del transcript, rail de `hanniorq`, footer). Fuera: cambiar la disposición de teclas, el sistema de temas (se reutilizan roles existentes), y las pantallas modales (selectores, diálogos).

Verify: la TUI arranca en 80/120/200 columnas sin desbordar ni corromper líneas (cada línea mide exactamente el ancho del viewport), los bloques de mensaje y herramienta llevan su panel con título, el rail derecho muestra un panel por concepto, y las barras superior/inferior muestran identidad, chips y atajos sin cortarse.

## Pasos

- [ ] S1 `pi-tui`: componente `Panel` (borde redondeado/light/heavy/double, título en el borde superior, estado a la derecha, caption en el borde inferior, padding interno y reenvío de ratón) — test de anchos con ANSI, CJK y títulos largos.
- [ ] S2 Mockup headless del rediseño para fijar el aspecto antes de tocar la app.
- [ ] S3 Barra superior fija (`components/top-bar.ts`): chip `hanni`, proyecto+rama, y chips de estado (modelo, memoria, sODD, medidor de contexto, tokens).
- [ ] S4 Barra inferior: chip de modo (`lista`/`pensando`/`bash`/`cola`) + atajos; el footer deja de duplicar tokens/cwd.
- [ ] S5 Bloques del transcript en paneles: `tú`, `hanni` (con spinner en el título al generar), `pensando`, y cada herramienta con su estado a la derecha.
- [ ] S6 Rail derecho: un panel por concepto (tareas, sODD, memoria, MCP, cambios).
- [ ] S7 Verificación en terminal real + `./test.sh`.
- [ ] S8 Docs, CHANGELOG y commits atómicos.

## Verificación

- Pendiente de ejecutar.

## Notas

- Los roles de tema existentes (`border`, `borderAccent`, `accent`, `muted`, `dim`, `selectedBg`, `userMessageBg`, `toolSuccessBg`/`toolErrorBg`/`toolPendingBg`) cubren el rediseño; no se añaden colores al schema.
