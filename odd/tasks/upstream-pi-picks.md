---
topic_key: odd/upstream-pi-picks/tasks
status: active
base: 85fc2fa96
---
# Incorporar arreglos de upstream pi (cherry-pick selectivo)

Objetivo: incorporar de `earendil-works/pi` los arreglos y mejoras que aplican a HanniPI sin tocar nuestro setup (standalone, HanniGram, sODD/hanniorq, rail, instalador, renombrado `pi`→`hanni`).

Por qué: el fork es del **1-oct-2026** (`7fbbd5f4a`) y upstream va a ~19 commits/día: **268 commits** upstream vs 89 nuestros. Es normal ir detrás, pero hay arreglos de Windows, binario standalone, TUI fullscreen, MCP (que acabamos de reactivar), compactación y proveedores que nos afectan directamente.

Alcance: cherry-picks de `upstream/main` sobre `main`, con verificación (tests + `npm run check` + binario) y release. Fuera: fusionar upstream entero, adoptar paquetes nuevos (`pi-env`), ni los cambios que rompen nuestro setup.

Verify: cada tanda aplica con `git cherry-pick -n`, el árbol compila (`tsc --noEmit` sin errores nuevos), la suite mantiene el mismo número de fallos que `origin/main` y el binario Windows arranca (`pi.exe --version`).

## Diagnóstico

- Fork point `7fbbd5f4a` (2026-10-01). Divergencia: 89 commits nuestros, 268 de upstream; upstream ya va por **1.2.0** (nosotros 0.2.9-hannipi).
- 932 ficheros cambiados upstream, 119 nuestros, **49 en ambos** (entre ellos `interactive-mode.ts`, `agent-session.ts`, `settings-manager.ts`, `package-manager.ts`, `extensions/types.ts`, `keybindings.ts`). Un merge completo no es viable: conflicto garantizado en el núcleo + upstream **eliminó** paquetes que nosotros publicamos (`client`, `protocol`, `server`) y la dependencia de `chord`.
- Sondas de cherry-pick (47 commits probados, resolviendo solo el ruido de `CHANGELOG.md`): **31 aplican limpios**, 16 necesitan mano (3 de ellos solo en ficheros de test).
- El ruido de `CHANGELOG.md` es sistemático: nuestros CHANGELOG divergen, así que en cada pick se resuelve con `git checkout --ours -- '**/CHANGELOG.md'` (no adoptamos sus notas de release).

## Método por tanda

1. `git switch -c picks/<tanda>` desde `main`.
2. Por commit: `git cherry-pick -n <hash>`; si el único conflicto es `CHANGELOG.md`, `git checkout --ours -- '**/CHANGELOG.md'`; si hay conflicto real, resolver a mano revisando el diff de upstream.
3. `git add -A && git commit` agrupando por área (windows/standalone, tui, mcp, ai, codemode).
4. Verificación: `npx vitest run <ficheros tocados>`, suite completa comparada con `origin/main`, `npx tsc --noEmit`, `npx biome check`, y build del binario con **bun 1.4.2**.
5. Release (patch) si la tanda es visible para el usuario.

## Tanda 1 (sondada limpia, alto valor) — pendiente de OK

Windows / standalone / automatización:
- `1ffb6bd62` **.env autoload off en el binario standalone** (bun carga el `.env` del cwd en `process.env`): 1 línea en `scripts/build-binaries.sh`.
- `e6fb2581d` reintento de `EPERM` en Windows al leer/escribir `auth.json`.
- `441f5767c` modo `-p`: respuesta truncada → aviso a stderr y exit 1.
- `6f2f164ab` al reanudar sesión se restauran las tools activas de esa sesión.
- `6a51a39d4` expansión de `~` en patrones de `extensions`/`skills`/`prompts`/`themes`.
- `f1b2e77f5` `AGENTS.md` simbólico en worktrees anidados.
- `910149912` normalización de etiquetas de rango en `read`.
- `9fe3f3716` argumentos vacíos entrecomillados en prompt templates.

TUI (vivimos en fullscreen con rail):
- `11f991145` la rueda del ratón vuelve a hacer scroll con un overlay enfocado.
- `edb2eb966` respuestas de color del terminal no se cuelan como teclado (abrían el editor externo).
- `83c9e2645` limpiar la selección al reconstruir el transcript.
- `dbc7ff87c` `colorFn` en `CompactionStatusIndicator` (lo usamos con editor propio).
- `6100fe5a8` Home/End del editor en fullscreen.
- `b9ab918c6` colores de sintaxis en tokens multilínea.
- `18336987a` `outputPad` en todos los bloques del transcript.

MCP (recién reactivado):
- `c5f5b3282` rechazar `iss` sin metadata del servidor de autorización.
- `147b50281` enviar `application_type` en el registro dinámico OAuth.
- `8c911797c` cerrar conexiones MCP que aún estaban conectando al apagar.

IA / proveedores:
- `4b994d5e5` reparar escapes `\u` inválidos en argumentos de tool calls.
- `7efebff18`, `8b5708dbb`, `3874b3e98`, `550f1f3ec` reintentos de errores transitorios de proveedor (gateway, server-busy, capacity, service unavailable).
- `27075fe07` estimar el contexto a 3.5 caracteres/token (afecta a la estimación de compactación del rail).
- `34a8bb38b` quitar imágenes de los tool results de error de Anthropic.
- `6b07b4e57` timeout de Mistral solo para cabeceras.
- `bde882c74` persistir tokens OAuth rotados si se cancela el refresh.
- `15e7bdc14` omitir thinking en los resúmenes de compactación (evita que el resumen no quepa).

Codemode:
- `b223082bb` sobrevivir a scripts que parchean built-ins.

## Tanda 2 (necesita mano, alto valor)

- `d7f7e0dfe` política única de selección de proveedor para `--model` (ambigüedad cuando varios proveedores ofrecen el modelo) — conflicto solo en un test.
- `195120a91` **OpenCode a endpoints de inferencia** (`/zen/go` no tiene ruta de Gemini → 404): es nuestro proveedor por defecto, portar a mano sobre nuestro `opencode-go.ts`.
- MCP: `67996ab75` `structuredContent` con cualquier JSON, `f4cca2dc2` no listar recursos al conectar, `2db5e359b` manager responsivo, `f10993bc7` cancelar sign-ins OAuth al cerrar, `04b97ef00` conservar tools MCP con `--tools` y añadir `--no-mcp`, `da0eadf04` no reintentar peticiones canceladas (conflicto solo en test).
- `c30840c2e` no filtrar tools ocultas al prompt (`system-prompt.ts`).
- `87f9a3641` reportar argumentos finales malformados (conflicto solo en test).
- `d4d53612b` fallback cuando Anthropic rechaza el set estricto de tools.
- `f11e50f72` y `4130bd5b3` codemode (join lineal del output, `node --watch`).
- `ddaa0a034` `+name`/`-name` en `--tools`.

## Tanda 3 (features opcionales)

- `3e477eab5` `PI_CLIPBOARD_OSC52=1` (copiar al portapapeles remoto).
- `f6127a1bf` modelos clasificadores de llama.cpp nativos (tenemos extensión `llama`).
- `ee409a85f` listar solo los modelos de OpenRouter que permite la key (conflicto real).
- `cea257439` `sessionShareDestination` para `/share`.

## No incorporar (rompe nuestro setup o no aplica)

- Eliminación de los paquetes `client`, `protocol`, `server` y de la dependencia `chord` (nosotros los publicamos y los usamos).
- `pi-env` (29 commits de ejecución remota por SSH): paquete nuevo, no lo necesitamos.
- Refactors grandes de `durable`/`codemode` (Cloudflare Workers, Durable Objects, sandbox remoto).
- Esquemas de configuración publicados en `pi.dev/schemas/*` (**breaking** para temas: validación más estricta).
- Cambio **breaking** de `before_agent_start` (unión por `messageType` + semántica de "busy"): lo usamos en la extensión MCP, exigiría portarlo.
- `581e7ba78` quitar el shrinkwrap npm: nuestro flujo de release depende de él.

## Siguiente

Esperar OK para la tanda 1 (≈28 commits, sondada limpia). Después: tests + `npm run check` + binario, y release patch.

## Notas

- `upstream` sigue configurado como remoto (AGENTS.md dice que no existe: desactualizado, corregir cuando se toque).
- Los `CHANGELOG.md` de upstream son la mejor fuente para priorizar: listan cada arreglo con su issue y separan "Breaking Changes" y "Removed".
