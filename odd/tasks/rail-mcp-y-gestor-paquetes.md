---
topic_key: odd/rail-mcp-y-gestor-paquetes/tasks
status: active
base: e4eb55978
---
# MCP en el rail y gestor de paquetes con catálogo

Objetivo: que el rail derecho diga siempre algo útil sobre MCP (servidores configurados, estado y si el built-in está desactivado) y que `/packages` sea un gestor de verdad: listar/instalar/actualizar/eliminar **y buscar en el catálogo** de paquetes nativos de Pi (`pi.dev/packages`).

Por qué: el usuario tiene `"-builtin:mcp"` en `settings.json`, así que la extensión MCP no corre y el rail no mostraba nada (el código solo pinta lo que publican los estados vivos). Y `/packages` existe en el código pero no está anunciado (ni autocompletado ni `/help`) y solo instala escribiendo una fuente a mano: para "quiero probar un paquete de pi.dev" falta el catálogo.

Alcance: `extensions/hanniorq` (sección MCP del rail), `core/package-catalog.ts` (nuevo), `modes/interactive/components/package-manager-selector.ts`, wiring en `interactive-mode`, `core/slash-commands.ts`, `README.md`. Fuera: publicar paquetes, MCP en el rail con detalle por tool, y el `pi-mcp-adapter` de terceros.

Verify: rail con MCP desactivado/`sin servidores`/servidores configurados; `/packages` busca en el catálogo (`keywords:pi-package`), instala `npm:<name>` y marca updates; tests de catálogo, selector y rail.

## Pasos

- [ ] S1 `core/package-catalog.ts`: búsqueda en el registro npm (`keywords:pi-package [+ query]`), resumen tipado, offline (`PI_OFFLINE`) y errores claros.
- [ ] S2 `PackageManagerSelector`: modo catálogo (escribir → buscar con debounce, ↑↓, enter instala) y `updateAvailable` real vía `checkForAvailableUpdates`.
- [ ] S3 `interactive-mode`: cablear la búsqueda del catálogo y refrescar updates al abrir `/packages`.
- [ ] S4 Rail MCP: leer servidores configurados (`mcp.json` global/proyecto) + estado vivo, y avisar si `builtin:mcp` está excluido en ajustes o si no hay servidores.
- [ ] S5 `/packages` y `/mem` en `BUILTIN_SLASH_COMMANDS` (autocompletado y ayuda) + README.
- [ ] S6 Tests (catálogo, selector, rail), checks y commits atómicos.

## Siguiente

S1: crear el módulo de catálogo y usarlo desde el selector.

## Verificación funcional

- `npx vitest run test/package-catalog.test.ts test/package-manager-selector.test.ts test/hanniorq-extension.e2e.test.ts`.
- A mano: `/packages` → catálogo → buscar "mcp" → instalar; y el rail mostrando `MCP desactivado (-builtin:mcp)` hasta reactivarlo.

## Notas

- El catálogo de pi.dev sale del registro npm: paquetes con el keyword `pi-package` (`docs/packages.md`). `pi.dev/api/packages` responde `{"ok":false}` (reservado), así que se usa `registry.npmjs.org/-/v1/search`.
- El MCP config vive en `<agentDir>/mcp.json` y `<proyecto>/.pi/mcp.json`, con la forma `mcpServers`; se reutiliza `loadMcpConfig` de la extensión mcp en vez de parsearlo otra vez.
