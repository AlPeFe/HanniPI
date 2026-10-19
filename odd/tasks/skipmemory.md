---
topic_key: hannipi/feat/skipmemory
status: done
base: 3a00156b6
---
# skipmemory
Objetivo: `/skipmemory` deja HanniGram fuera del juego por completo — ni briefing en el prompt, ni tools `mem_*`, ni daemon — y `/skipmemory off` lo devuelve.
Por qué: hacía falta poder trabajar sin memoria (repos ajenos, experimentos, privacidad) y "omitir" tenía que ser de verdad: no un aviso, sino que ninguna parte del harness toque la memoria.
Alcance: ajuste persistente (`settings-manager`), API de extensiones (`ExtensionUIContext`), extensión `hanniorq` (guardas + comando) y tests. Fuera: parar un daemon ya arrancado (es un servicio del host y otras sesiones pueden usarlo) y cortar el acceso directo por bash (`curl`/CLI `hannigram`): no hay cortafuegos.
Verify: `test/hanniorq-extension.e2e.test.ts` y `npm run check`.

## Pasos
- [x] S1 Ajuste `skipMemory` persistente (`get/setSkipMemory` en `settings-manager`) expuesto a extensiones como `getSkipMemory`/`setSkipMemory` (tipos, defaults del runner, TUI interactiva, RPC y harness de tests) — 9c2a10e36
- [x] S2 Guardas en `hanniorq`: `hannigram()` no hace ni una petición, `checkMemory()` marca "omitida", sin briefing ni guideline de memoria, el daemon no se arranca, las `mem_*` salen del conjunto activo y un handler de `tool_call` bloquea sus llamadas; el rail pinta `⏭ omitida · /skipmemory off` — 9c2a10e36
- [x] S3 Comando `/skipmemory [on|off]` (sin argumento alterna), aviso en `/helpme` y `/hanniorq help`, y guardas en los comandos que necesitan memoria (`/explore`, `/hannidump`, `/hannigram`, `/hanniorq close|resume`) — 9c2a10e36
- [x] S4 Test e2e (on/off, sin `fetch`, tools fuera, `tool_call` bloqueado, comandos avisando) y `npm run check` — 9c2a10e36

## Siguiente
Probarlo en la TUI real con `.\pi-test.ps1`: `/skipmemory`, comprobar el rail (`memoria ⏭ omitida · /skipmemory off`) y que un turno no dispara ninguna petición al daemon; después `/skipmemory off` y que vuelve el briefing. Decidir si entra en la próxima release (0.2.18).

## Verificación funcional
- `test/hanniorq-extension.e2e.test.ts` → 30/30 (incluye el caso de `/skipmemory` on/off); `settings-manager.test.ts` + `extensions-runner.test.ts` + `settings-manager-bug.test.ts` → 143/143.
- `npm run check` limpio (biome, locks, shrinkwrap, `tsc --noEmit`, entry graphs).
- Rasgo observable: con la memoria omitida, `fetch` no se llama ni una vez (ni siquiera `/health`).

## Notas
- El flag vive en los ajustes globales: una sesión nueva arranca omitida hasta `/skipmemory off` (es el "en ningún momento" pedido).
- Doble barrera en las tools: se quitan del conjunto activo (el modelo no las ve en el prompt) y se bloquea la llamada por si otra extensión las reactivara.
- Límite conocido: por bash se podría llamar al CLI `hannigram` o al daemon a mano; eso ya es saltarse la norma a propósito y no se filtra.
