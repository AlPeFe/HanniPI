<p align="center">
  <img alt="HanniPI banner — Hanni mascot with wordmark" src="docs/images/hannibanner.png" width="480">
</p>
<p align="center">
  <strong>HanniPI</strong> — tu harness de desarrollo de software, con memoria persistente y flujo de trabajo sODD.
</p>
<p align="center">
  <a href="https://github.com/AlPeFe/HanniPI"><img alt="GitHub" src="https://img.shields.io/badge/github-AlPeFe%2FHanniPI-181717?style=flat-square&logo=github&logoColor=white" /></a>
  <a href="https://github.com/AlPeFe/HanniGram"><img alt="HanniGram" src="https://img.shields.io/badge/memoria-HanniGram-ff69b4?style=flat-square" /></a>
</p>

# HanniPI — Harness de desarrollo con memoria

**HanniPI** es un harness de desarrollo de software en terminal, con **memoria persistente por proyecto** (HanniGram), un **flujo de trabajo atómico** (sODD) y **gestión de extensiones** integrada. Es un proyecto **standalone** (nace del harness [pi](https://github.com/earendil-works/pi) de earendil-works, del que ya no depende).

La mascota es **Hanni** — la compañera que te acompaña en cada sesión de desarrollo.

## ¿Por qué HanniPI?

HanniPI está pensado para el desarrollo cotidiano de software:

- **Memoria que sobrevive a los cortes de contexto.** Cada proyecto guarda observaciones (What/Why/Where/Learned) en una base SQLite local, consultable desde la propia TUI.
- **Tareas atómicas con evidencia.** El protocolo **sODD** (Small ODD) lleva una ficha por feature que sobrevive a compactaciones, con commits atómicos y evidencia por sha.
- **Extensiones bajo demanda.** Nada se inyecta en el prompt por defecto: solo las tools base (`read`, `bash`, `edit`, `write`). MCP, web y subagentes se instalan con `/packages` cuando los necesitas.
- **Gestión de plugins en la TUI.** Instala, actualiza y elimina extensiones sin salir del agente.

## Características

### 🧠 Memoria persistente (HanniGram)

HanniPI se integra con [HanniGram](https://github.com/AlPeFe/HanniGram), un motor de memoria .NET 10 (fork de engram) que guarda observaciones por proyecto en `~/.hannigram/hannigram.db` (SQLite + FTS5).

- **`/mem`** — explora la memoria desde la TUI: navega Proyectos → Observaciones → Detalle, alterna a Sesiones con `tab`, y busca con FTS5 (`/`).
- **Inyección automática** — cuando hay una tarea activa, las observaciones recientes del proyecto se inyectan al contexto para que el agente recuerde.

### 📋 sODD — Small ODD

Un protocolo minimalista de desarrollo (versión reducida de ODD) para agente único con turnos atómicos:

- Ficha de feature en `odd/tasks/<slug>.md` que sobrevive a cortes de contexto.
- Commits atómicos por paso con Conventional Commit y evidencia por sha.
- Promoción a ODD adulto cuando la tarea crece.
- Comandos `/task new|status|next|done|promote|diff|commit|verify`.
- Reinyección automática de la ficha activa al compactar.

### 🎯 hanniorq — Orquestador sODD

`hanniorq` es una capa de **coordinación** sobre `/task`. No duplica el almacenamiento: usa la misma ficha `odd/tasks/<slug>.md`. Su filosofía es la de **sODD**: orgánico pero pequeño.

**La diferencia clave con ODD adulto: no todo es investigación, no todo requiere resumen, no todo requiere tests, y la delegación es condicional (no por defecto).**

- Un cambio **pequeño y entendido** (1 paso, sin riesgo) se hace **inline**: sin ficha y sin resumen.
- Solo el trabajo **sustancial** (2+ pasos, varios archivos, riesgo) genera ficha y se trabaja por pasos.
- **No todo se testea.** Solo se verifica lo que tiene un check aplicable y un resultado esperado; si no, se hace verificación funcional proporcionada o se declara "sin check".
- El **resumen** (con la sección de memoria HanniGram) solo se genera en `/hanniorq close` y solo si hubo ficha.
- **Delegación CONDICIONAL, nunca por defecto:** solo si la tool `subagent` está activa (viene con el paquete `npm:pi-subagents`, que no se instala de serie) y la ficha activa es grande y **spliteable** (pasos independientes), cada parte se delega con esa tool pasándole la ficha recortada + el paso concreto como contexto. Un subagente no ve la conversación, así que el contexto debe ser autocontenido. Sin la tool, todo se ejecuta inline y el agente no finge delegar. **Opciones de forzado** (con la tool activa): escribe "delega" en tu petición para forzar delegación, o "no delegues" para prohibirla.
- **Widget de flota** (solo con la tool `subagent` activa): mientras hay subagentes trabajando, el widget `hanniorq-fleet` se muestra en la TUI con un spinner por worker y la tarea que está haciendo (adaptación del fleet widget de pi-subagents a sODD: la ficha `odd/tasks/` es la fuente de verdad).
- **Rail derecho:** la columna derecha muestra proyecto, memoria HanniGram, **contexto y compactación** (porcentaje usado, umbral al que se dispara sola y aviso cuando está cerca, ya pasó o está desactivada), sODD, **las tareas**, **MCP** (servidores configurados y su estado, o por qué no hay ninguno) y los cambios del worktree. Cada tarea lleva delante su **origen**: `≡` lista del turno (tool `todo`, vive en la sesión), `▤` pasos de la ficha `odd/tasks/<slug>.md` del proyecto y `⛁` espejo de esa ficha en HanniGram (cuando no hay ficha local, p. ej. otro worktree). Las tareas largas se envuelven en varias líneas y el ancho de la columna se ajusta con `ctrl+alt+→` / `ctrl+alt+←` o `/hanniorq rail <n>` (20-100 columnas, se recuerda en `settings.json`); `ctrl+alt+t` pliega/despliega las tareas.

**Comandos:**

```
/hanniorq on | off | status        # activa/desactiva el modo orquestador; status incluye goal y autonomía
/hanniorq goal "<objetivo>"        # fija el goal (y sus criterios/límites) en la ficha; no ejecuta
/hanniorq autonomy on | off | status  # ejecución desatendida de ESA ficha (autonomy: guarded | off)
/hanniorq auto [<n>]               # encadena hasta n pasos YA escritos, con verify y commit por paso
/hanniorq stop                     # corta la ejecución automática; la ficha queda abierta
/hanniorq rail [<n>]               # muestra/oculta el rail derecho, o fija su ancho en columnas
/hanniorq plan "<petición>"        # clasifica: trivial → inline; sustancial → ficha
/hanniorq run [Tn]                 # ejecuta la siguiente tarea; si es grande y spliteable y hay tool subagent, delega partes
/hanniorq watch                    # muestra en qué se trabaja: fichas del proyecto (▤) + solo en HanniGram (⛁) + subagentes en vuelo
/hanniorq close                    # genera el resumen final (plantilla fija + memoria HanniGram)
/hanniorq resume [<slug>]          # recupera contexto: mem_context → mem_search → ficha
/extract [--dir <ruta>] [--overwrite | --version]  # retrato del proyecto en .md por tipología, para otros harness
```

- **Línea de memoria al cerrar el turno:** si el turno usó HanniGram, la última línea del output lo resume — `hannigram → memory: +1 nuevo · ~2 update · -1 borrado · ≫3 leído` (solo lo que pasó; `nuevo` vs `update` sale del resultado de `mem_save`). Si el turno no tocó la memoria, no se pinta nada.

**El resumen de `/hanniorq close`** incluye una sección **Memoria (HanniGram)** que refleja cómo se ha trabajado la memoria en la sesión: observaciones leídas, espejo de la ficha (topic `odd/<slug>/tasks`) y resumen de sesión. Si el daemon de HanniGram no está disponible, se marca `PENDIENTE` en vez de inventar el guardado.

### 🤖 Autonomía acotada — `/hanniorq goal` + `auto`

HanniPI puede ejecutar **solo los pasos que ya están escritos en la ficha**, uno detrás de otro, con verificación y commit entre cada uno, y parar sola. No planifica, no añade trabajo y no se auto-evalúa.

```text
/hanniorq goal "cada tarea del rail muestra de dónde viene" \
  --done "≡ ▤ ⛁ visibles por fila" --verify "npm run check" --max-tokens 150000
# escribes los pasos en odd/tasks/<slug>.md
/hanniorq autonomy on
/hanniorq auto 3
```

El estado vive en el **frontmatter de la ficha** (`goal`, `done_when`, `verify`, `autonomy`, `max_iterations`, `max_idle`, `max_tokens`): una sola verdad, diffable y editable a mano. **Progreso = commit nuevo o un paso más marcado `[x]`**, no la opinión del modelo. El bucle para cuando:

| motivo | qué hacer |
|---|---|
| `plan terminado` | revisa `done_when`, verifica y `/hanniorq close` |
| techo de pasos de la invocación | relanza `/hanniorq auto` |
| `sin progreso` (n iteraciones) | arregla el paso o el verify y relanza |
| `presupuesto agotado` | sube `max_tokens` o parte la ficha |
| turno abortado (Esc), `/hanniorq stop` o escribes tú | retoma cuando quieras |

Mientras corre: panel `goal` en el rail (`auto 2/3 · 45k/200k tok · idle 0/1`) y `/hanniorq status`. La ficha nunca se borra ni se revierte: los commits son la red de seguridad.

Guía completa (campos, motivos de parada, ejemplos y cuándo **no** usarlo): [docs/autonomia.md](docs/autonomia.md).

### 🧾 `/extract` — retrato del proyecto para otros harness

`/extract` deja el proyecto descrito en Markdown legible por cualquier agente u otro harness, sin depender de esta conversación ni de HanniGram. Primero explora (solo lectura: docs, manifiestos, estructura, entry points, una muestra de UI/datos/tests/build) y después escribe cinco documentos en `docs/proyecto/`:

| fichero | qué contiene |
|---|---|
| `README.md` | índice: qué es, cómo se levanta y se verifica, y qué doc leer para qué |
| `architecture.md` | capas, módulos, entry points, flujos, datos y límites internos |
| `stack.md` | tecnologías y versiones, librerías, build/test/lint, plataformas |
| `design.md` | UI: pantallas, sistema visual (tokens), estados vacío/carga/error, atajos |
| `conventions.md` | patrones que se repiten: naming, estructura, errores/config/tests, reglas del repo |

Antes de gastar tokens, el comando lee del disco los hechos baratos (manifiestos, scripts, dependencias, estructura y conteo de ficheros por extensión) y se los pasa al modelo, así que la exploración se centra en lo que no se deduce de un `ls`.

**Si los documentos ya existen, `/extract` no toca nada**: avisa con qué hay y las salidas explícitas:

- `/extract --overwrite` — regenera encima (modificar).
- `/extract --version` — crea `README-v2.md`, `architecture-v2.md`, … con el primer número libre (versionado, lo viejo intacto).
- `/extract --dir <ruta>` — cambia el destino (por defecto `docs/proyecto`).
- Borrar: a mano; el comando no elimina ficheros del usuario.

### 🖥️ Interfaz

La TUI separa chrome, conversación y rail, en vez de mezclarlo todo en una columna:

- **Barra superior** (fija): `Hanni` con la versión, el directorio y la rama, el modelo (con la ruta del modelo virtual si lo hay), y a la derecha el medidor de contexto y los tokens.
- **Conversación**: cada bloque es un panel con el título en el borde — `tú`, `hanni` (con `generando…` mientras responde) y cada herramienta con `ejecutando` / `ok` / `error`.
- **Barra inferior** (fija): el modo actual (`lista`, `pensando`, `compactando`, `bash`, `cola`) y los atajos que aplican a ese modo.
- **Rail derecho** (opcional): un panel por concepto — proyecto, memoria, contexto, ficha sODD, tareas, MCP y cambios.

### 🔌 Gestión de extensiones

- **Sin paquetes por defecto.** `DEFAULT_PACKAGES` está vacío a propósito: subagentes, web y MCP no son tools fijos del prompt (inflaban ~12k tokens por turno sin usarse). Se re-habilitan con `packages` en `~/.pi/agent/settings.json`:

  ```json
  { "packages": ["npm:pi-subagents", "npm:pi-web-access", "npm:pi-mcp-adapter"] }
  ```

- **`/packages`** — lista los paquetes con su estado (ámbito, instalado, updates disponibles), instala/actualiza/elimina y **busca en el catálogo** (`c`): los paquetes nativos de Pi publicados en npm con el keyword `pi-package` (la misma galería que [pi.dev/packages](https://pi.dev/packages)). Elegir un resultado instala `npm:<nombre>`.

### 🔗 MCP

- Configuración en `~/.pi/agent/mcp.json` (global) y `.pi/mcp.json` (proyecto), con la forma `mcpServers`; también hay CLI: `hanni mcp add|remove|list`.
- El rail derecho muestra los servidores MCP configurados con su estado (`conectado`, `sin conectar`, `desactivado`, `login pendiente`, `caído`) y avisa si la extensión MCP está desactivada en `settings.json` (por ejemplo `"-builtin:mcp"`).

### ✍️ Tipografía

- La TUI y los exports HTML usan **Rysana Mono**, empaquetada en el repo (SIL OFL 1.1, subconjunto mono del paquete `rysana-type`).
- El instalador de Windows la instala para tu usuario y fija `Rysana Mono` como fuente por defecto de **Windows Terminal**; se omite con `-SkipFonts` y se repite con `hanni-setup.ps1 -Action fonts`.
- Los exports HTML (`hanni --export <sesión>.jsonl`, y `/export` en la TUI) embeben el subconjunto en WOFF2 como data URI, así que el transcript conserva la tipografía aunque quien lo abra no la tenga instalada.

## Instalación

**Windows** — un solo script instala **HanniPI + HanniGram** juntos (descarga el binario standalone de la última release, verifica SHA256, lo añade al PATH como `hanni` e instala el daemon y el CLI de HanniGram):

1. Descarga **`HANNI.bat`** de la [última release](https://github.com/AlPeFe/HanniPI/releases/latest) y haz doble clic. Te pregunta **instalar / actualizar / desinstalar**.

O, si lo prefieres por comando:

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/AlPeFe/HanniPI/main/install.ps1 | iex"
```

> Se instala como **`hanni`** (no `pi`) para no chocar con el pi de earendil-works si ya lo tienes instalado. Después de instalar, abre una terminal nueva y escribe `hanni`.
> **HanniGram es obligatorio**: cada release trae `hannigram-windows-x64.zip` (daemon + CLI self-contained, sin necesidad de .NET instalado, + la extensión `mem_*`) y el instalador aborta sin instalar nada si no lo encuentra, en vez de dejar un HanniPI sin memoria. El daemon se instala en `%LOCALAPPDATA%\HanniPI\hannigram`, la extensión `mem_*` en `~/.pi/agent/extensions/hannigram` y HanniPI descubre el daemon por `HANNIGRAM_DAEMON`. El asset lo publica el propio HanniGram y HanniPI lo copia **pinneado** (`hannigram-version.json`: tag + sha256); con `-HannigramSource latest` el instalador coge la última release de HanniGram en vez del pin.
> Al instalar, actualizar o desinstalar, el script **para el daemon de memoria y los procesos auxiliares** y **aparta la instalación anterior por renombrado** (Windows no deja borrar ni sobrescribir un `.exe` en marcha, pero sí renombrar la carpeta que lo contiene). Así una sesión de `hanni` abierta no bloquea la actualización, no se pierde el trabajo en curso y la versión nueva entra en vigor al reiniciar el harness; los restos de la versión anterior se borran en la siguiente ejecución.

**Desde el repo (desarrollo):**

```bash
git clone https://github.com/AlPeFe/HanniPI.git
cd HanniPI
npm install --ignore-scripts
npm run build
npm link          # deja `hanni` en tu PATH (punto de entrada a dist/bundle/cli.js)
```

> El binario standalone no necesita Node; el paquete npm (`pi` = `dist/bundle/cli.js`) sí requiere Node 22.19+.

## Uso rápido

```bash
hanni                   # arranca la TUI
/mem                    # explora la memoria del proyecto
/packages               # gestiona extensiones
/task new mi-feature    # inicia una tarea sODD
/task next              # siguiente paso de la tarea activa
/task commit "feat: ..."# commit atómico con evidencia
```

## Paquetes

| Paquete | Descripción |
|---------|-------------|
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Agente de código interactivo (la TUI) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Runtime de agente con tool calling y gestión de estado |
| **[@earendil-works/pi-ai](packages/ai)** | API LLM multi-proveedor unificada (OpenAI, Anthropic, Google, …) |
| **[@earendil-works/pi-tui](packages/tui)** | Librería de UI de terminal con render diferencial |
| **[@earendil-works/chord](packages/chord)** | Runtime de composición de aplicaciones (servicios, RPC, plugins) |
| **[@earendil-works/pi-durable](packages/durable)** | Runtime durable de conversación, tareas y documentos |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Contratos de telemetría vendor-neutral |

## Desarrollo

```bash
npm install --ignore-scripts  # instala dependencias sin lifecycle scripts
npm run build                 # compila todos los paquetes
npm run check                 # lint, formato y type check
./test.sh                     # tests (omite los que dependen de LLM sin API keys)
```

## Licencia

MIT

---

<p align="center">
  <img alt="Hanni mascot" src="docs/images/hanni-mascot.png" width="48">
  <br />
  Hecho con cariño por <a href="https://github.com/AlPeFe">AlPeFe</a> · basado en <a href="https://github.com/earendil-works/pi">pi</a> de earendil-works
</p>
