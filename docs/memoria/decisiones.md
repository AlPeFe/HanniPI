# Decisiones y convenciones

Lo que está decidido y hay que respetar al tocar el repo.

_AlPeFe/HanniPI · 2026-10-22 · 4 observaciones · volcado de la memoria del proyecto con `/dumpgram`, no editar a mano._

### Release v0.2.19-hannipi publicada (fix de caché de prefijo en el binario)

decision · `hannipi/release/estado` · 2026-10-20 · #15

Publicada `v0.2.19-hannipi` (latest; commits 2f791b02e bump + 0a8e34dcb docs, release sobre 2f791b02e, 5 assets, `SHA256SUMS` remoto = local y digests de la API coinciden). Contenido: solo el fix de caché de prefijo 55dad3a92 (el briefing de memoria se inyecta una vez por sesión) — la 0.2.18 salió antes del fix, así que no estaba en el binario. Sin cambios de código en la release; el changelog ya traía la entrada en `### Fixed`.

Datos: `pi-windows-x64.zip` 54,678,249 B (sha256 7d0d400a…), `hannigram-windows-x64.zip` 115,991,479 B (pin v0.2.1, sha256 26b6067e…), `hanni-setup.ps1` 32,777 B, `HANNI.bat` 1,325 B, `SHA256SUMS` 177 B. Gate `pack-hannigram.ps1 -Check` al día (v0.2.1 es la última de HanniGram).

Receta en este host (sin `zip` ni Python): `npm version <ver> --workspaces --no-workspaces-update --no-git-tag-version` + `git restore packages/coding-agent/examples` + `node scripts/sync-versions.js` + `npm install --package-lock-only --ignore-scripts` + `generate-coding-agent-shrinkwrap.mjs` + `generate-coding-agent-install-lock.mjs` + `npm run check` + push, `./scripts/build-binaries.sh --platform windows-x64 --skip-install --out ~/release-staging/hannipi-<ver>` (su paso zip falla), zip con `powershell Compress-Archive -Path '<out>\windows-x64\*' -DestinationPath '<out>\pi-windows-x64.zip' -Force`, `scripts/pack-hannigram.ps1`, `SHA256SUMS` con sha256sum (formato `<hash> *<fichero>`), `gh release create vX -R AlPeFe/HanniPI --latest --notes-file … <5 assets>`, verificación con `gh api …/releases/latest -q .tag_name`, `gh release download -p SHA256SUMS -O -` y `.digest` de cada asset.

Antes de esto se cerró el benchmark de tokens (obs. #73): el overhead fijo (~10.1k tok/request) NO es la palanca porque va cacheado; se midió que los 5 skills globales sí se usan (computer-use 3 sesiones, impeccable 3, orca-cli 2, find-skills 1, orchestration 1), así que no se recortan.

**Qué:** Cortar la release 0.2.19-hannipi con el fix de caché de prefijo

**Por qué:** El usuario pidió una release con todo lo pendiente (el panel de skills del rail) para poder usarlo desde el `hanni` instalado.

**Dónde:** AlPeFe/HanniPI releases, scripts/build-binaries.sh, scripts/pack-hannigram.ps1

**Aprendido:** Un fix de coste solo llega al usuario en una release; si sale después de un tag, la siguiente release corta solo-lleva-ese-fix es correcta y no necesita tocar código ni changelog.

---

### Caché de prefijo: no tocar el system prompt a mitad de sesión

adr · `hannipi/memoria/cache-prefijo` · 2026-10-20 · #72

Regla para HanniPI (bugfix 55dad3a92): **nunca reescribir el system prompt a mitad de sesión**. Cualquier sección dinámica (hoy el briefing `memoria` de hanniorq) mete un nuevo mensaje system al principio de la conversación y el proveedor tira la caché de prefijo: el turno siguiente paga TODO el contexto a precio de entrada (deepseek v4.1 flash: $0.15/M vs $0.003/M de cache read, 50×).
Medición real (sesiones en ~/.pi/agent/sessions): en una sesión de 99 turnos con 19 cambios del system prompt (el contador "N observaciones recientes" del briefing cambiaba en cada `mem_save`), el 89% del coste ($0.77 de $0.87) fueron misses de caché; cada reinyección a 200k de contexto cuesta ~$0.03 y suele provocar 2+ requests a precio completo. En sesiones sin cambios de prompt, los misses bajan al 30-45% (pausas largas, expiración de caché).
Diseño correcto: inyectar lo dinámico UNA vez por sesión (a la primera, al arrancar) y congelarlo; el rail y la BD se actualizan aparte, y el modelo tiene `mem_search`/`mem_context` para lo que cambie. `/skipmemory` y `session_start` sí resetean el flag (`briefingInjectedFor`) porque son cambios de sesión deliberados.

**Qué:** Congelado el briefing de memoria por sesión tras medir que las reinyecciones se comían el 89% del coste en sesiones con muchas escrituras

**Por qué:** Mantener sano el consumo de tokens del harness con deepseek v4.1 flash

**Dónde:** packages/coding-agent/src/extensions/hanniorq/index.ts (briefingInjectedFor + before_agent_start)

**Aprendido:** Un texto distinto de un solo carácter en el system prompt invalida toda la caché de prefijo del contexto; a 200k eso son ~$0.03 por evento en deepseek flash. Cualquier feature que actualice el prompt cada turno es un agujero de coste enorme aunque el texto sea "pequeño".

---

### La TUI arranca sin modelo y obliga a elegirlo

adr · `hannipi/tui/arranque-modelo` · 2026-10-19 · #66

Decisión HanniPI (2026-10-19, commits 770b1df36 + 6dea9bdba): una sesión interactiva nueva ya NO hereda `defaultProvider`/`defaultModel`/`enabledModels` ni el primer modelo disponible. `createAgentSession` acepta `requireModelSelection` (deja la sesión sin modelo, el Agent mantiene el placeholder `unknown`) y `main.ts` lo activa solo para el runtime inicial interactivo sin `--model`/`--provider`. La TUI abre el selector de modelo antes del primer turno: primer Esc avisa ("Sin modelo no se puede empezar…") y el segundo sale; sin modelos disponibles no bloquea (avisa y deja entrar para /login). `--model`/`--provider` mandan y las sesiones reanudadas conservan su modelo. `defaultModel` queda como preferencia que ordena el selector, no como modelo inicial; `_persistLastUsedModelAsDefault` sigue guardando el último usado solo para ese orden. La top bar pinta `no-model` mientras no hay selección. El contexto "no model" es el placeholder del Agent (`provider/id/api === "unknown"`), no `undefined`.
Además, el rail derecho tiene un panel `servicios` con lo que el harness tiene escuchando: daemon HanniGram (`:8765`, por health y su URL) y servidores MCP por HTTP conectados (puerto de su `url` en mcp.json). Solo se pinta con algo activo; los MCP stdio no publican puerto.

**Qué:** Implementado arranque sin modelo por defecto + panel servicios en el rail

**Por qué:** El modelo de la sesión no debe decidirse por un default silencioso; y hay que ver qué puertos tiene abiertos el harness

**Dónde:** packages/coding-agent/src/core/sdk.ts, agent-session-services.ts, main.ts, modes/interactive/interactive-mode.ts, components/top-bar.ts, extensions/hanniorq/index.ts

**Aprendido:** Con `requireModelSelection` el Agent no queda con model undefined sino con el placeholder unknown; cualquier comprobación de "sin modelo" debe usar `isUnknownModel`/provider+id unknown, no `!session.model`.

---

### Regla: /skipmemory deja HanniGram fuera del juego en todo el harness

adr · `hannipi/memoria/skipmemory` · 2026-10-19 · #50

Regla del repo: cuando el ajuste `skipMemory` está activo (`/skipmemory on`), **ninguna parte del harness puede tocar HanniGram**: ni el briefing del system prompt, ni las tools `mem_*`, ni el daemon (ni `/health`), ni el handoff rodante, ni el registro de sesión, ni los comandos que leen/escriben memoria. Cualquier integración nueva de memoria debe consultar el flag antes de actuar.

Cómo está implementado (commit 9c2a10e36):
- Ajuste persistente `skipMemory` en `settings-manager` (`getSkipMemory`/`setSkipMemory`, se guarda en los ajustes globales → una sesión nueva arranca omitida hasta `/skipmemory off`).
- Expuesto a extensiones en `ExtensionUIContext` (`getSkipMemory`/`setSkipMemory`): tipos, defaults del runner, TUI interactiva (`interactive-mode`), RPC y `test/suite/harness.ts`.
- En la extensión `hanniorq`: `memorySkipped()` lee los ajustes vivos y `hannigram()` (el único cliente HTTP del daemon) devuelve `undefined` sin hacer la petición; `checkMemory()` marca el estado `skipped` (el rail pinta `⏭ omitida · /skipmemory off`); `before_agent_start` no inyecta la sección `memoria` ni la guideline; `session_start` no arranca el daemon; las `mem_*` se quitan del conjunto activo (`pi.setActiveTools`) y un handler de `tool_call` las bloquea (`{ block: true, reason }`) por si otra extensión las reactivara.
- Comando `/skipmemory [on|off]` (sin argumento alterna) en `hanniorq`; `/explore`, `/hannidump`, `/hannigram` y `/hanniorq close|resume` avisan y no hacen nada si está activo.

Límite conocido y aceptado: por bash se podría llamar al CLI `hannigram` o al daemon a mano; no hay cortafuegos (y parar el daemon no es cosa de una sesión: es un servicio del host que pueden usar otras).

**Qué:** Añadí el ajuste persistente skipMemory, su API para extensiones, las guardas en la extensión hanniorq (cliente HTTP, briefing, daemon, handoff, rail, tool_call), el comando /skipmemory [on|off], guardas en los comandos que necesitan memoria, tests e2e y docs.

**Por qué:** El usuario pidió poder omitir la memoria por completo: con /skipmemory, HanniGram no se puede usar en ningún momento.

**Dónde:** packages/coding-agent: settings-manager.ts, core/extensions/{types,runner}.ts, extensions/hanniorq/index.ts, modes/interactive/interactive-mode.ts, modes/rpc/rpc-mode.ts, test/hanniorq-extension.e2e.test.ts, test/suite/harness.ts

**Aprendido:** Si `skipMemory` está activo, HanniGram no se toca en ningún punto: el único cliente HTTP (`hannigram()` en la extensión hanniorq) cortocircuita, las mem_* se desactivan y se bloquean, y el daemon no se arranca.
