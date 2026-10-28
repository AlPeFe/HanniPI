# Presupuesto de tokens (SPEC-003 / SPEC-004)

La página completa vive con la documentación que se publica y que el agente puede leer en
caliente: `packages/coding-agent/docs/token-budget.md`.

Cifras de referencia medidas el 2026-10-28 (prefijo por turno, harness por defecto con todas las
tools built-in, repo vacío):

| medido con | tokens | fuente |
|---|---|---|
| `usage` del proveedor (gateway opencode-go) | **2.996** | `bench/e2e_token_eval.sh` |
| cl100k (`bench/ts/token_budget.mjs`) | **1.875** | prompt 719 + esquemas 1.156 |
| `/tokens` del harness (estimador calibrado) | **1.825** | −2,7 % contra cl100k |

Factor cl100k → proveedor: **×1,6** (2.996 / 1.875). Los apuntes previos decían ×1,7 partiendo de
1.735: esa cifra no incluía las `promptGuidelines` que el harness sí envía. El banco ya las
incluye, y con eso los dos instrumentos coinciden dentro del ±5 %.

Caché de prefijo del gateway: turno 1 paga `input=2.996`; turnos 2 y 3 pagan `input=64/76` con
`cacheRead=2.944`. Sin caché, cada turno pagaría el prefijo entero a precio de entrada.

Comandos:

- `/tokens` en la TUI: cuatro componentes, hash del prefijo, delta por turno y `PREFIX-CHANGED`.
- `npm run eval:host -w packages/evals`: gate offline que falla si `fixed_tokens_per_turn` supera
  `FIXED_BUDGET_TOKENS` (1.950), nombrando las tools responsables.

La tabla proveedor → caché implícita, las cabeceras necesarias y las reglas que mantienen el
prefijo cacheable están en la página completa.
