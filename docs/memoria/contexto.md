# Descubrimientos, patrones y contexto

Hallazgos, patrones y notas que no son ni decisiones ni trabajo cerrado.

_AlPeFe/HanniPI · 2026-10-22 · 9 observaciones · volcado de la memoria del proyecto con `/dumpgram`, no editar a mano._

### Benchmark de tokens del harness: el overhead fijo no es la palanca, los misses de caché sí

discovery · `hannipi/costes/tokens` · 2026-10-20 · #73

Conclusión del benchmark (deepseek v4.1 flash, 1M contexto, $0.15/M input, $0.003/M cache read, $0.60/M output):

- Overhead fijo real: ~10.1k tok/request (5.1k system + ~5.0k tools). Cacheado cuesta ~$0.00003/request → NO es la palanca.
- Lo que pesa de verdad: (a) misses de caché de prefijo (hasta el 89% del coste medido), (b) salida del modelo, (c) tool results grandes, (d) reanudar a 200k+.
- Los 5 skills globales de ~/.agents (computer-use, find-skills, impeccable, orca-cli, orchestration) SÍ se usan en sesiones reales (3/1/3/2/1 activaciones contando lecturas de SKILL.md y /skill:<nombre>), así que recortarlos no compensa: ~0.92k/request cacheados y perdería capacidad.
- Decisión: no se recorta el overhead fijo. Se arregla la caché (55dad3a92, una inyección por sesión) y se deja el resto igual.

Medición de activaciones (útil si se replantea): en `~/.pi/agent/sessions` contar las sesiones que leen `<skill>/SKILL.md` o llevan `skill name="<skill>"`; buscar el nombre a secas cuenta todas las sesiones porque aparece en el system prompt y no dice nada.

**Qué:** Evaluar el coste de tokens del harness y decidir qué recortar

**Dónde:** packages/coding-agent (system prompt, rail), extensions/hanniorq, ~/.agents/skills

**Aprendido:** Antes de recortar prompt/tools, medir si el coste está en el overhead (cacheado, céntimos) o en los misses de caché (50× más caros). Recortar skills por «no se usan» exige contar activaciones reales, no menciones en el system prompt.

---

### Panel servicios del rail: puertos activos y de dónde salen

pattern · `hannipi/tui/rail-servicios` · 2026-10-19 · #67

El rail derecho de HanniPI tiene un panel `servicios (n)` (después de `memoria`) que lista lo que el harness tiene abierto en un puerto: `● <nombre> :<puerto> · <tipo>`. Se calcula en `railServices(cwd)` (extensions/hanniorq/index.ts) a partir de estado vivo, sin registro aparte: HanniGram si `memoryCache.up` (puerto explícito de `HANNIGRAM_BASE`, health en cada refresh) y servidores MCP por HTTP con estado `connected` (puerto explícito de `config.url` en `mcp.json`). Solo se pinta con algo activo; MCP stdio y URLs sin puerto explícito (p. ej. https://mcp.context7.com/mcp) no aparecen. Se refresca con los eventos que ya re-renderizan el rail (session_start, turn_end, tool_execution_end, /skipmemory) y con `subscribeMcpConnectionStatuses`.

**Qué:** Añadido panel `servicios` al rail derecho con HanniGram y MCP HTTP y sus puertos

**Por qué:** Saber de un vistazo qué hay corriendo en un puerto sin salir del harness

**Dónde:** packages/coding-agent/src/extensions/hanniorq/index.ts (railServices + railSections)

---

### node:sqlite: las filas no pueden cruzar a componentes de cliente sin aplanarlas

pattern · `nextjs/node-sqlite-filas-planas` · 2026-10-19 · #53

En proyectos Next.js (App Router) que usan `node:sqlite` (DatabaseSync), las filas que devuelven `stmt.all()` / `stmt.get()` son objetos con **prototipo nulo**. Al pasarlas desde un componente de servidor a un componente de cliente, Next falla en tiempo de ejecución con:

  Error: Only plain objects, and a few built-ins, can be passed to Client Components from Server Components. Classes or null prototypes are not supported.

El error aparece con el mensaje `digest` y la fila señalada, y la página devuelve 500 sin que TypeScript ni el build avisen (por eso se cuela: tsc y `next build` pasan).

Solución robusta (aplicada en tsnu-plataforma, `lib/db.ts`): devolver objetos planos desde los helpers de acceso a datos.

```ts
export function todos<T>(sql: string, ...params: unknown[]): T[] {
  const filas = db().prepare(sql).all(...(params as never[])) as T[];
  return filas.map((fila) => ({ ...fila }));
}
export function uno<T>(sql: string, ...params: unknown[]): T | undefined {
  const fila = db().prepare(sql).get(...(params as never[])) as T | undefined;
  return fila === undefined ? undefined : { ...fila };
}
```

Alternativa local: `filas.map((f) => ({ ...f }))` en la página que pasa datos al cliente (el spread sí produce un objeto plano).

Regla práctica: si un componente de cliente recibe datos de la base de datos, aplánalos en el borde (helper o página) y compruébalo en el navegador, no solo con tsc/build.

**Qué:** Documenté y resolví el fallo «Only plain objects… can be passed to Client Components» originado por las filas con prototipo nulo de node:sqlite.

**Dónde:** lib/db.ts (helpers todos/uno) en proyectos Next + node:sqlite

**Aprendido:** tsc y next build no detectan este error: solo se ve al abrir la página; hay que aplanar las filas de node:sqlite antes de pasarlas a un cliente.

---

### mem_save con el mismo topicKey sobrescribe la observación anterior

pattern · 2026-10-18 · #21

En HanniGram (herramienta mem_save), reutilizar el mismo topicKey NO crea una observación nueva: SOBRESCRIBE la anterior. Verificado en esta sesión: al guardar la evaluación de la idea del checklist con topicKey "sector/tsnu-herramientas-roi" (el mismo que usé para el calendario regulatorio), la observación #17 quedó reemplazada y el contenido del calendario se perdió (hubo que recrearlo a mano como #20 con otro topicKey).
Regla práctica: usar topicKey SOLO cuando el contenido nuevo es una actualización legítima del mismo tema; si es un tema distinto aunque sea del mismo proyecto, cambiar de topicKey. Y después de cada mem_save, comprobar si el retorno dice "Saved observation #N" (nuevo) o "Updated observation #N" (sobrescritura).

**Qué:** Guardar la evaluación de una idea nueva reutilizando un topicKey existente del proyecto.

**Por qué:** Perdí el contenido de una observación anterior sin aviso previo claro.

**Aprendido:** Cambia de topicKey cuando el tema es distinto, y revisa si el retorno dice Saved (nuevo) o Updated (sobrescritura).

---

### Panel de skills en el rail: en uso vs activado

pattern · `hannipi/tui/rail-skills` · 2026-10-17 · #19

Pedido: "en el lateral, cuando se use un skill, mostrar si el skill se ha activado o se está usando".

Implementado en la extensión `hanniorq` (que es la dueña del rail), commit 10b9401ac:
- Panel `skills (usados/disponibles)` justo debajo de `tareas` (va arriba a propósito: es "qué está haciendo ahora mismo"). Líneas: `▸ nombre · en uso` (warning) y `✓ nombre · activado` (muted), máx. 4 + `… +N`. Si no se ha usado ningún skill, no se pinta el panel.
- Semántica del estado: `en uso` = el run en curso lo está usando; `activado` = ya se cargó antes en la sesión. Un prompt nuevo (`before_agent_start`) y el final del run (`agent_settled`) cierran el ciclo `en uso → activado`; `session_start` limpia todo (el estado es por sesión).
- Cómo se detecta la activación: (a) el modelo lee el fichero del skill con la tool `read` — se compara la ruta contra `event.systemPromptOptions.skills` (catálogo del system prompt) y, como convención, contra cualquier `<dir>/SKILL.md`; (b) el usuario escribe `/skill:<nombre>`, que llega en `event.prompt` como un bloque `<skill name="…" location="…">`. Deliberadamente NO cuenta leer otros `.md` (una ficha `odd/tasks/x.md` no es un skill) ni `bash`.
- Se descartó mostrar el disparador (`comando` vs `lectura`) en la línea del rail: con 30 columnas de contenido el nombre del skill se recortaba demasiado.

Para verlo sin release: `.\pi-test.ps1` desde el repo (corre el harness desde fuente con node --import del source-resolver). El binario instalado necesita una release nueva (0.2.17).

**Qué:** Añadí a la extensión `hanniorq` el estado de skills por sesión y el panel `skills` del rail (en uso / activado), con detección por lectura del fichero del skill o por comando `/skill:<nombre>`, tests e2e y docs.

**Por qué:** Cuando el agente usaba un skill no se veía en ninguna parte; el usuario pidió verlo en el lateral con su estado.

**Dónde:** packages/coding-agent/src/extensions/hanniorq/index.ts, test/hanniorq-extension.e2e.test.ts, docs/how-pi-works.md, CHANGELOG.md

**Aprendido:** En este harness un skill se "activa" de dos formas observables desde una extensión: el modelo lee su fichero con `read` (ruta contra `event.systemPromptOptions.skills`) o el usuario lanza `/skill:<nombre>` (llega como `<skill name="...">` en `event.prompt` de `before_agent_start`).

---

### Receta para buscar/fetch normativa española desde bash (jina + DuckDuckGo html)

pattern · 2026-10-17 · #18

Contexto operativo reutilizable para investigar normativa española desde este entorno (Windows, sin buscador nativo fiable):
- Búsqueda web: usar `https://r.jina.ai/https://html.duckduckgo.com/html/?q=<query URL-encoded>` (funciona; lite.duckduckgo.com devuelve captcha). OJO: hay que URL-ENCODEAR la query con node (`node -p "encodeURIComponent(process.argv[1])" "$q"`); si se dejan acentos crudos, la respuesta sale VACÍA (0 bytes). Espaciar ~12-18 s entre llamadas o empieza a devolver vacío.
- Bing y Mojeek no son usables (bloqueados / markup no parseable). Las instancias públicas de SearxNG también bloquean.
- Páginas concretas: `https://r.jina.ai/<URL>` funciona bien (BOE incluido: https://www.boe.es/buscar/act.php?id=BOE-A-XXXX-YYYY devuelve el texto consolidado en markdown, ideal para grep).
- Scripts útiles guardados en /tmp/tsnu/: s.sh (búsqueda), f.sh (fetch de URL), x.sh (extrae títulos+snippets de los resultados), raw/*.md (corpus descargado).
- r.jina.ai limita el acceso anónimo por dominio (p.ej. www.bing.com bloqueado por abuso).

**Qué:** Descubrir una vía fiable de búsqueda y lectura de fuentes primarias (BOE) sin herramientas de red dedicadas.

**Por qué:** El buscador directo (DuckDuckGo lite, Bing, SearxNG) está bloqueado o es inestable; el proxy r.jina.ai sí funciona para páginas concretas y para el endpoint html de DuckDuckGo.

**Aprendido:** URL-encodea siempre las queries antes de pasarlas por el proxy; una query con acentos crudos devuelve 0 bytes y parece un fallo de red cuando en realidad es de codificación.

---

### El chat del harness no scrollea en el terminal de Orca (fuera de Orca sí): la ruta del harness está descartada

discovery · `hannipi/tui/wheel-orca` · 2026-10-17 · #16

Reporte del usuario: "no puedo scrollear en el chat del harness; al scrollear me recupera mensajes antiguos". Descartado el harness: `hanni` está en fullscreen (alt screen) y la ruta de la rueda funciona — hay test con la TUI real (TuiAltScreen + VirtualTerminal + evento SGR `\x1b[<64;x;yM`) que mueve el transcript, y además se reprodujo a mano: con `orca computer scroll --app Orca --x 800 --y 500 --direction up` (15 notches) sobre su ventana, el chat se desplazó y salió el chip "↓ Jump to latest message · Ctrl+End". El propio usuario confirmó después que fuera de Orca sí funciona.

Contexto del host: la sesión corre dentro del terminal de **Orca** (TERM_PROGRAM=Orca, TERM=xterm-256color, ORCA_IMAGE_PROTOCOL=kitty). En Orca la rueda fue *intermitente*: 3 notches en (1280,500) no movieron nada; 15 en (800,500) sí. Hipótesis pendiente de confirmar: el harness en fullscreen pide seguimiento de ratón "todo el movimiento" (`\x1b[?1003h`, ENABLE_ALL_MOTION_MOUSE) y el terminal de Orca (Electron/xterm.js) reenvía cada movimiento por el PTY; con carga puede perder/encolar el evento de rueda. El harness ya baja a `1002h` (solo con botón pulsado) cuando detecta tmux/zellij/STY por ese mismo motivo (`tui-alt-screen.ts`, `mouseSequence`).

Mitigaciones posibles: (a) añadir `TERM_PROGRAM=orca` a esa lista en `tui-alt-screen.ts` (requiere release para llegar al binario instalado); (b) mirar el lado de Orca, que es donde está la causa: en el buffer alternativo no hay scrollback que scrollear, así que si Orca intercepta la rueda el síntoma es "no pasa nada" o ver contenido viejo del terminal.

**Qué:** Descarté el harness como causa del scroll fallido del transcript: test funcional de la rueda con la TUI fullscreen real, reproducción con `orca computer scroll` sobre la ventana de Orca (el chat se movió y apareció el chip de "jump to latest"), y comprobación de que el binario de la sesión es el 0.2.15 (sin mis cambios).

**Por qué:** El usuario reportaba que no podía desplazar el chat del harness en su sesión.

**Dónde:** packages/coding-agent/test/interactive-tui.test.ts (ruta de la rueda), packages/tui/src/tui-alt-screen.ts (mouseSequence), terminal de Orca

**Aprendido:** Con `orca computer` se puede comprobar si un TUI recibe la rueda de verdad: scrollear sobre la ventana objetivo y buscar un marcador visual del app (en HanniPI, el chip "↓ Jump to latest message"). Si el app se mueve, el problema está en el terminal host, no en el harness.

---

### Auditoría de la memoria real de HanniGram en este host: qué aporta y qué la ensucia

discovery · `hannipi/memoria/calidad` · 2026-10-17 · #12

Revisión de la BD real de este host (C:\Users\alexp\.hannigram\hannigram.db, 2026-10-17): 11 observaciones, 3 sesiones, 38 proyectos.

QUÉ APORTA CALIDAD (ejemplos reales, guardados por sesiones anteriores):
- #1 "Pure Data 0.57: sintaxis .pd, verificación headless y trampas verificadas" (3339 chars, topic tools/pure-data-pd): dice cómo validar un patch sin GUI (`pd.com -nogui -noaudio -stderr`), que DSP sí corre headless, y la trampa real (inlets de señal vs mensaje). Un "learned" en una línea. Esto ahorra horas.
- #4 "theme-export.test.ts falla en el fork: PI_CODING_AGENT_DIR ya no es la env var": síntoma + por qué + arreglo, con los paths. Pequeñísima y accionable.
- #6 release manual del fork (bun, gh device login, Compress-Archive, 5 assets, verificar sha256): receta que funciona en esta máquina.
- #7 el bug de `hanni update` (mío, de esta sesión): síntoma, causa raíz, evidencia y la lección en una línea.
- #8/#9 TSNU España: cifras con fuente primaria y el hallazgo central (lock-in por ausencia de estándar en la orden de transporte). Formato: hechos verificados + de dónde salen.
- Sesiones #2/#3: resúmenes con goal/summary/nextSteps; los "next" son una lista de 5 puntos concretos. Es el mejor ejemplo de handoff: se retoma sin releer nada.
Patrón común de lo bueno: síntoma → causa → evidencia → regla reutilizable, con rutas y comandos exactos, y "learned" en una frase.

QUÉ NO APORTA (y por qué):
- 33 de 38 proyectos eran directorios temporales de tests (hanniorq-mcp-cwd-*, hanniorq-rail-*) y sin observaciones: los tests hablaban con el daemon real (127.0.0.1:8765) y registraban proyecto por cada cwd temporal. Un ADR de prueba por ejecución en hannigram-daemon.e2e.test.ts. Arreglado: vitest.config.ts apunta HANNIGRAM_URL(S) a un puerto muerto y el test que escribe de verdad queda opt-in (HANNIGRAM_E2E=1).
- 2 handoffs basura (#10, #11) generados por mi propio handoff rodante en esos tests: "objetivo: sin petición registrada" y "hecho: fatal: not a git repository". Arreglado: el handoff no escribe sin objetivo de sesión y no vuelca errores crudos de git. Archivados los dos.
- Atribución por cwd, no por repo: las 2 observaciones de TSNU viven en el proyecto `alexp` (la sesión corrió desde el home) y `AlPeFe/HanniPI` tiene rootPath = ...\HanniPI\packages\coding-agent (subdirectorio). La misma memoria se fragmenta según dónde arranque la sesión.
- Duplicación de sesiones: el mismo trabajo de TSNU quedó en dos resúmenes (#2, #3) con ids distintos y texto casi igual; no hay upsert por sesión ni dedupe.

LECCIONES PARA EL HARNESS: lo que se escribe vale cuando lleva el "por qué" y una regla reutilizable; el ruido lo generan los procesos (tests) que usan la BD real como si fuera de usar y tirar.

**Dónde:** C:\Users\alexp\.hannigram\hannigram.db; packages/coding-agent/vitest.config.ts; packages/coding-agent/src/extensions/hanniorq/index.ts

---

### PowerShell: -replace ignora mayusculas, usa -creplace

pattern · 2026-10-17 · #2

En PowerShell los operadores `-replace`, `-match` y `-split` son case-insensitive por defecto. Un patron como `'([a-z])([A-Z])'` (para insertar un espacio entre camelCase) NO funciona: al ignorar mayusculas acaba casando cualquier par de letras y "BoldItalic" se convierte en "B ol dI ta li c". Hay que usar `-creplace` / `-cmatch` / `-csplit`.

Regla practica (skill verify-untrusted): nunca aceptar el resultado de un `-replace` con clases de caracteres que dependan de mayusculas sin comprobarlo imprimiendo el valor; y si el resultado va a un registro o una ruta, mirarlo despues de escribir.

**Por qué:** Corrompio los nombres de registro de las fuentes instaladas (\"Rysana Mono B ol d\").

**Aprendido:** -replace/-match/-split son case-insensitive en PowerShell: usa -creplace/-cmatch/-csplit cuando el patron dependa de mayusculas (camelCase, iniciales).
