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

**HanniPI** es un fork de [pi](https://github.com/earendil-works/pi) (el harness de agente de código de earendil-works) enfocado en **desarrollo de software**: un agente interactivo en terminal con **memoria persistente por proyecto** (HanniGram), un **flujo de trabajo atómico** (sODD) y **gestión de extensiones** integrada.

La mascota es **Hanni** — la compañera que te acompaña en cada sesión de desarrollo.

## ¿Por qué HanniPI?

Pi es un harness de agente de código potente y extensible. HanniPI lo adapta para el desarrollo cotidiano de software:

- **Memoria que sobrevive a los cortes de contexto.** Cada proyecto guarda observaciones (What/Why/Where/Learned) en una base SQLite local, consultable desde la propia TUI.
- **Tareas atómicas con evidencia.** El protocolo **sODD** (Small ODD) lleva una ficha por feature que sobrevive a compactaciones, con commits atómicos y evidencia por sha.
- **Extensiones por defecto.** MCP, subagentes y acceso web vienen activos de serie.
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

- Un cambio **pequeño y entendido** (1 paso, sin riesgo) se hace **inline**: sin ficha, sin subagentes, sin resumen.
- Solo el trabajo **sustancial** (2+ pasos, varios archivos, riesgo) genera ficha y se trabaja por pasos.
- **No todo se testea.** Solo se verifica lo que tiene un check aplicable y un resultado esperado; si no, se hace verificación funcional proporcionada o se declara "sin check".
- El **resumen** (con la sección de memoria HanniGram) solo se genera en `/hanniorq close` y solo si hubo ficha.
- **Delegación CONDICIONAL:** sODD decide: si la ficha activa es grande y **spliteable** (pasos independientes), cada parte se delega con la tool `subagent` (ficha recortada + paso como contexto). Un solo bloque se ejecuta inline. **Opciones de forzado**: escribe "delega" en tu petición para forzar delegación, o "no delegues" para prohibirla.
- **Widget de flota:** mientras hay subagentes trabajando, el widget `hanniorq-fleet` se muestra en la TUI con un spinner por worker y la tarea que está haciendo (adaptación del fleet widget de pi-subagents a sODD: la ficha `odd/tasks/` es la fuente de verdad).

**Comandos:**

```
/hanniorq on | off | status        # activa/desactiva el modo orquestador
/hanniorq plan "<petición>"        # clasifica: trivial → inline; sustancial → ficha
/hanniorq run [Tn]                 # ejecuta la siguiente tarea; si es grande y spliteable, delega partes con subagent
/hanniorq watch                    # muestra en qué se trabaja: fichas activas + subagentes en vuelo
/hanniorq close                    # genera el resumen final (plantilla fija + memoria HanniGram)
/hanniorq resume [<slug>]          # recupera contexto: mem_context → mem_search → ficha
```

**El resumen de `/hanniorq close`** incluye una sección **Memoria (HanniGram)** que refleja cómo se ha trabajado la memoria en la sesión: observaciones leídas, espejo de la ficha (topic `odd/<slug>/tasks`) y resumen de sesión. Si el daemon de HanniGram no está disponible, se marca `PENDIENTE` en vez de inventar el guardado.

### 🔌 Gestión de extensiones

- **Paquetes por defecto** (activos siempre): `pi-mcp-adapter`, `pi-subagents`, `pi-web-access`.
- **`/packages`** — lista los paquetes con su estado, instala, actualiza (uno o todos) y elimina desde la TUI.

## Instalación

**Windows** — un comando (descarga el binario standalone de la última release, verifica SHA256 y lo añade al PATH como `hanni`):

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/AlPeFe/HanniPI/main/install.ps1 | iex"
```

> Se instala como **`hanni`** (no `pi`) para no chocar con el pi de earendil-works si ya lo tienes instalado. Después de instalar, abre una terminal nueva y escribe `hanni`.

**Desde el repo (desarrollo):**

```bash
git clone https://github.com/AlPeFe/HanniPI.git
cd HanniPI
npm install --ignore-scripts
npm run build
npm link          # deja `pi` en tu PATH (punto de entrada a dist/bundle/cli.js)
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
