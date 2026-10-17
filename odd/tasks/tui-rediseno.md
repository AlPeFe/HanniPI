---
topic_key: odd/tui-rediseno/tasks
status: done
base: bad1c4c01
---
# Rediseño visual de la TUI (paneles con título)

Objetivo: que la TUI deje de ser una lista de bloques con fondo y pase a un layout con **conceptos separados**: chrome fijo arriba y abajo, y cada grupo de contenido dentro de un panel con título en el borde (tú, hanni, cada herramienta, y cada sección del rail derecho).

Por qué: todo competía en la misma columna — mensajes de usuario y tool results eran slab con fondo, el footer mezclaba cwd + tokens + modelo + atajos en dos líneas, y el rail derecho apilaba secciones separadas por `─`. El estilo de referencia usa una barra superior con identidad y chips, paneles con el título embebido en el borde, y una barra inferior con chip de modo + atajos.

Alcance: `packages/tui` (componente `Panel`) y `packages/coding-agent` (chrome, bloques del transcript, rail de `hanniorq`, footer). Fuera: atajos, sistema de temas (se reutilizan roles existentes) y pantallas modales.

Verify: la TUI arranca y cada línea mide exactamente el ancho del viewport (sin desbordar ni corromper), los bloques del transcript llevan su panel con título, el rail muestra un panel por concepto, y las barras superior/inferior muestran identidad, chips y atajos sin cortarse.

## Pasos

- [x] S1 `pi-tui`: `Panel` (borde redondeado/light/heavy/double, título, estado a la derecha, caption en el borde inferior, padding interno, reenvío de ratón) — `f8cd6f887`, verificado con `packages/tui/test/panel.test.ts`.
- [x] S2 Mockup headless del rediseño (`.artifacts/preview-*.ts`) para fijar el aspecto antes de tocar la app.
- [x] S3 Barra superior fija: `TopBarComponent` (wordmark, versión, cwd, rama, sesión, modelo, estados de extensión, medidor de contexto, tokens) — `f8cd6f887`.
- [x] S4 Barra inferior: `StatusBarComponent` (chip de modo + atajos por modo); `footer.ts` se queda solo con los formateadores compartidos — `f8cd6f887`.
- [x] S5 Bloques del transcript en paneles: `tú`, `hanni` (con `generando…` al generar), y cada herramienta con su estado en el borde — `63d17f989`.
- [x] S6 Rail derecho: un panel por concepto (proyecto, memoria, contexto, sODD, tareas, MCP, cambios) — `40a88fed1`.
- [x] S7 Verificación en terminal real + suites.
- [x] S8 Docs (`how-pi-works.md`, README), CHANGELOG y commits atómicos.

## Verificación

- `node --test packages/tui/test/panel.test.ts` → 6/6.
- Subconjunto de 18 ficheros de test de `coding-agent` que tocan la TUI → 143 pasan; los 4 fallos son previos y ajenos (`/hannidump` con el daemon de HanniGram en marcha, `theme-export` por `PI_CODING_AGENT_DIR`).
- Suite completa de `coding-agent`: los 7 tests que dependían del aspecto anterior (assistant/user message, tool-execution, output-pad) se actualizaron al marco de paneles; el resto de fallos es el baseline de Windows (symlinks, sockets, watchers, datos de modelos).
- Visual en Windows Terminal con la TUI real: barra superior con modelo y medidor, rail con 5 paneles (líneas medidas a 34 columnas exactas en un volcado headless), barra inferior con `lista` y atajos, header de arranque sin atajos duplicados.

## Notas

- Los roles del tema existentes (`borderMuted`, `accent`, `success`, `warning`, `error`, `selectedBg`) cubren el rediseño: no se añadieron colores al schema.
- Los paneles van con `paddingX: 0` y el margen lo pone el contenido, para que `outputPad` siga significando lo mismo (0 = pegado al borde).
- `MAX_TODO_LINES` pasó de 3 a 4: el marco del panel quita ~4 columnas al contenido del rail.
