---
topic_key: odd/sodd-hannigram-mcp-rail/tasks
status: active
base: 58d392051
---
# sODD, HanniGram, MCP, and project rail

Objective: Make HanniPI's HanniGram startup, sODD guidance, optional on-demand Context7 MCP, and project rail behavior accurate and useful without turning every change into a task.

Why: HanniPI should stay aligned with HanniGram's daemon auto-start change; sODD should organically keep trivial work inline while helping the harness track substantial work; Context7 and live project state should be visible when available.

Scope: HanniGram client startup and status; sODD prompt/task lifecycle; opt-in/deferred Context7 MCP configuration; Hanniorq right rail and focused tests. Out of scope: changing HanniGram itself, enabling receipt-driven development, broad ODD conversion, or remote writes.

Constraints: Keep sODD deliberately lighter than ODD. Inline trivial understood work; use a task sheet only when multi-step, multi-file, interruptible, or otherwise worth recovering. Never imply the harness launches a subagent unless the runtime actually exposes one. Context7 must not connect or enter prompt context by default; it is an optional MCP, enabled only when useful, with deferred tool exposure. Rail state must be observational and read-only. TDD: off (explicit user choice); run focused tests and `npm run check`. RDD: off (global status). Local commits are explicitly authorized on this feature branch; no push or PR.

## Tasks

- [x] S1 Port HanniGram daemon auto-start behavior to HanniPI with safe runtime/path checks and tests. Route: direct. Evidence: `804f55335` (`feat(coding-agent): auto-start HanniGram daemon`); injected startup probe and Node syntax checks passed; focused Vitest unavailable (dependencies absent).
- [ ] S2 Revise Context7 default to remain disconnected and absent from prompt context until explicitly enabled; use deferred exposure after opt-in and cover behavior in docs/tests. Reopened after user clarified it must not be mandatory or default prompt content. Route: direct. Prior evidence: `75e02e59b`; current changes pending.
- [x] S3 Make sODD classification guidance automatic in the assistant context, keep trivial requests inline, show TODOs and current modified files in its rail, and fix task-sheet directory creation. Route: direct. Evidence: Node syntax checks and injected HanniGram/MCP snapshot probes passed; Vitest blocked (missing node_modules/vitest); npm run check blocked (Biome absent).
- [x] S4 Show the active sheet's steps in the right rail even when the sheet does not use the `## Pasos` section: `todoSteps` falls back to any `- [ ]`/`- [x]` checkbox in the file (covers `## Tasks`, `## P0/P1` layouts). Route: direct. Evidence: focused Vitest (13/13) + `npm run check` exit 0.
- [x] S5 Add a rail-tasks toggle so the TODO list can be collapsed: `ctrl+alt+t` shortcut and `/hanniorq tasks` (whole rail still toggles with `/hanniorq rail`). Route: direct. Evidence: `hanniorq-extension.e2e.test.ts` covers the no-`## Pasos` fallback and the expand/collapse cycle.
- [x] S6 Release v0.2.3-hannipi: version bump (17 files, lockstep), Windows x64 binary, GitHub release marked latest. Route: direct. Evidence: tag `v0.2.3-hannipi` @ `2546dfed2`, assets `pi-windows-x64.zip` + `SHA256SUMS` (sha `fdd4c0548c10…`), `releases/latest` = v0.2.3-hannipi.

## Next

S2: Change the built-in Context7 entry to disabled + deferred; verify explicit `/mcp` enablement persists it and tools remain on-demand.

## Verification

- Focused coding-agent tests for HanniGram, MCP defaults/status, and sODD rail/task behavior.
- `npm run check` after code changes.

## Notes

- HanniGram public GitHub has no published releases/tags at inspection time; latest visible upstream commit is `99968f0ce36549e34d2b1173030e4c2c872f1eed` and adds detached daemon auto-start in its Pi extension.
- The current HanniPI worktree had only an untracked `.atl/` before this feature; preserve it and do not include it in feature commits.
