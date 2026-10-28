# Token budget

Every request starts with a **fixed prefix**: the system prompt plus the tool declarations. The
model pays for it on every turn, and prompt caching decides whether that cost is the full input
price or a cheaper cache read. This page records what the prefix costs, how to see it from inside
a session, and which providers cache it.

Spec: `SPEC-003` (token accounting) and `SPEC-004` (eval gate) in the CTO repo.

## What a turn pays

| component | what it is | how it changes |
|---|---|---|
| `systemPrompt` | preamble, rules, docs pointers, cwd | rewording the prompt, changing cwd |
| `activeTools` | the `<tools>` section: one line per active tool | activating or deactivating a tool |
| `toolSchemas` | the JSON declarations sent to the provider | any tool description or parameter change |
| `injectedContext` | addendum, `AGENTS.md`/project context, skills, extension sections | editing those files, installing an extension that injects prompt text |

`/tokens` shows all four per turn, the prefix hash, and the delta against the previous turn.

```
/tokens

Token Ledger
turn  system  tools  schemas  injected   total  delta  hash      flag
   1     563    113     1149         0    1825      -  3f2a9c1b
   2     563    113     1149         0    1825      0  3f2a9c1b
```

A hash that repeats means the provider can serve the prefix from cache. `PREFIX-CHANGED` means it
cannot: on that turn the whole prefix is re-read at input price.

## Measured reference (2026-10-28)

Same request, two ways of counting it:

| counting | prefix tokens | notes |
|---|---|---|
| provider `usage` (opencode-go gateway) | **2,996** | first turn of a session, all built-in tools, empty repo |
| cl100k (`bench/ts/token_budget.mjs`) | **1,875** | prompt 719 + tool schemas 1,156 |
| `/tokens` (this ledger) | **1,825** | estimate calibrated to cl100k, −2.7% |

Provider tokens per cl100k token on that prefix: **×1.6** (2,996 / 1,875). Earlier notes quoted
×1.7 from a 1,735 figure that left out the `promptGuidelines` bullets the harness does send; the
bench now includes them, so the two instruments agree within 5%.

With prompt caching on, only the first turn pays the prefix:

| turn | `input` | `cacheRead` |
|---|---|---|
| 1 | 2,996 | 0 |
| 2 | 64 | 2,944 |
| 3 | 76 | 2,944 |

Without caching, turns 2 and 3 would pay ~2,996 each. That is the whole reason the prefix has to
stay byte-identical: the cost of one bad edit is the entire prefix, every turn, at input price.

Reproduce:

```bash
# cl100k breakdown (needs gpt-tokenizer in the CTO bench)
node bench/ts/token_budget.mjs --out runs/<date>/token_budget.json
# provider truth, end to end against the gateway, isolated HOME
bash bench/e2e_token_eval.sh
```

## Provider cache support

HanniPI only emits cache markers for Anthropic-style APIs (`cacheControlFormat: "anthropic"`).
Everything else depends on the provider caching the prefix on its own. "Implicit" below means:
same prefix ⇒ cache read, no markers to send.

| provider | API in HanniPI | prefix cache | markers | extra needed | usage field |
|---|---|---|---|---|---|
| opencode-go (measured) | `openai-completions` | implicit, per prefix | no | `headers: {"x-opencode-session": "<id>"}` in `models.json`; without it the gateway answers `400 MissingSessionID` | `prompt_tokens_details.cached_tokens` |
| openai | `openai-responses`, `openai-completions` | implicit, prompts ≥1,024 tokens | no | `prompt_cache_key` is sent from the session id; GPT-5.6+ may take `prompt_cache_options` | `input_tokens_details.cached_tokens` |
| anthropic | `anthropic-messages` | explicit breakpoints | yes | none | `cache_read_input_tokens` |
| google (Gemini) | `google`, `google-vertex` | implicit | optional | none | `cachedContentTokenCount` |
| openrouter | `openai-completions`, `anthropic-messages` | implicit passthrough + sticky routing | accepts `cache_control` | `sessionAffinityFormat: "openrouter"` sends `x-session-id` | `prompt_tokens_details.cached_tokens` |
| deepseek | `openai-completions` | implicit | no | none | `prompt_cache_hit_tokens` |
| z.ai (GLM) | `openai-completions` | implicit, automatic | no | none | `prompt_tokens_details.cached_tokens` |
| kimi / moonshot | `openai-completions` | implicit, automatic (prefix above ~256 tokens, 5m TTL) | optional top-level `cache_control` | none | `prompt_tokens_details.cached_tokens` |
| deepinfra | `openai-completions` | implicit, automatic | no | `prompt_cache_key` optional | `prompt_tokens_details.cached_tokens` |
| vercel ai gateway | `openai-completions` | inherited from the provider behind it | only with `caching: "auto"` (Anthropic family) | `x-session-affinity` helps | `cached_tokens` |
| cloudflare ai gateway | `openai-completions` | no prefix cache documented; it caches whole identical responses | no | none | — |
| rest of the catalog (groq, cerebras, together, fireworks, nvidia, mistral, huggingface, minimax, xiaomi, baseten…) | several | **not verified** | ? | ? | ? |

Read the "no cache" rows as: the fixed prefix is paid in full on every turn, so its size is a
price, not just a context-window concern. That is why trimming tool schemas matters more than
trimming prose.

## The two constants

Both live in `packages/coding-agent/src/core/token-ledger.ts`:

- `MEASURED_FIXED_TOKENS = 1875` — measured, cl100k, default install.
- `FIXED_BUDGET_TOKENS = 1950` — declared ceiling, ~4% above the measurement.

Crossing the ceiling prints a warning at startup naming the sources whose tool schemas weigh the
most, so an extension that adds a fat schema shows up before the invoice does.

```text
Fixed prompt prefix is 2531 tokens (budget 1950, +581). Tool schemas by source: builtin 1156,
hanniorq 656. Largest schemas: mem_admin 254, edit 248, mem_save 178.
```

`packages/evals/evals/token-budget.eval.ts` gates the same number in CI: `npm run eval:host` fails
with the components, the exceeding delta, and the tools responsible. The gate is offline and free,
so it can run on every commit.

## Rules that keep the prefix cacheable

1. The system prompt and the tool declarations may only change at session start or on an explicit
   user action (`/model`, `/packages`, changing the active tools). `test/suite/token-ledger-prefix.test.ts`
   fails when the prefix moves between two turns without a configuration change.
2. Volatile memory goes **at the end** of the context — a user message or a tool result — never by
   rewriting the system prompt. `hanniorq` already injects its briefing once per session for this
   reason; re-injecting it throws away the provider's prefix cache.
3. Extension prompt text belongs in `appendSystemPrompt`/`sections`, not in a rewritten system
   prompt: same result, but the ledger can see it and the diff stays a diff.

## Calibration caveats

The ledger's counter is a heuristic (letters, digits, punctuation, whitespace), calibrated against
cl100k over this repo's prompt, schemas, README, CHANGELOG, TS sources, and Spanish docs. Error on
the fixed-cost parts is ~3%; English prose stays within ~8%; heavily accented Spanish prose
undershoots by ~15%, because cl100k splits accents into extra tokens. Use it to compare
scenarios and spot regressions, not to predict a bill — the provider's `usage` is the bill, and
`/tokens` prints the last request's `input`/`cacheRead`/`cacheWrite` next to the estimate.
