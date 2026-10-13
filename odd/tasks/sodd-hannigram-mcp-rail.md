---
topic_key: odd/sodd-hannigram-mcp-rail/tasks
status: active
base: 58d392051
---
# sODD, HanniGram, MCP, and project rail

Objective: Make HanniPI's HanniGram startup, sODD guidance, default Context7 MCP, and project rail behavior accurate and useful without turning every change into a task.

Why: HanniPI should stay aligned with HanniGram's daemon auto-start change; sODD should organically keep trivial work inline while helping the harness track substantial work; Context7 and live project state should be visible when available.

Scope: HanniGram client startup and status; sODD prompt/task lifecycle; Context7 default MCP configuration; Hanniorq right rail and focused tests. Out of scope: changing HanniGram itself, enabling receipt-driven development, broad ODD conversion, or remote writes.

Constraints: Keep sODD deliberately lighter than ODD. Inline trivial understood work; use a task sheet only when multi-step, multi-file, interruptible, or otherwise worth recovering. Never imply the harness launches a subagent unless the runtime actually exposes one. Context7 is opt-out/overridable. Rail state must be observational and read-only. TDD: off (explicit user choice); run focused tests and `npm run check`. RDD: off (global status). Local commits are explicitly authorized on this feature branch; no push or PR.

## Tasks

- [x] S1 Port HanniGram daemon auto-start behavior to HanniPI with safe runtime/path checks and tests. Route: direct. Evidence: focused Vitest unavailable (dependencies not installed); injected startup probe and Node syntax checks passed. Commit SHA will be recorded in the next tracker update.
- [ ] S2 Add Context7 as a default, overridable MCP server and expose truthful connected-server status to the Hanniorq rail. Route: delegated direct (MCP configuration/runtime and rail integration). Evidence: pending.
- [ ] S3 Make sODD classification guidance automatic in the assistant context, keep trivial requests inline, show TODOs and current modified files in its rail, and fix task-sheet directory creation. Route: delegated direct (multiple extension files and tests). Evidence: pending.

## Next

S2: Add the default Context7 entry without masking explicit MCP configuration, expose the MCP extension's live connection snapshot, and render that actual state in the Hanniorq rail.

## Verification

- Focused coding-agent tests for HanniGram, MCP defaults/status, and sODD rail/task behavior.
- `npm run check` after code changes.

## Notes

- HanniGram public GitHub has no published releases/tags at inspection time; latest visible upstream commit is `99968f0ce36549e34d2b1173030e4c2c872f1eed` and adds detached daemon auto-start in its Pi extension.
- The current HanniPI worktree had only an untracked `.atl/` before this feature; preserve it and do not include it in feature commits.
