# Phase 1 completion map — `src/agent/runner.ts`

State: **978 physical lines** (Phase 1 entry: 6,769 — an 86% reduction). The
`src/agent/runner.ts` entry has been **removed** from
`test/architecture/legacy-baseline.json`, which is why the architecture suite
now enforces the ≤ 1,000-line rule on it directly.

## What the file is now

A composition shell: imports, the compatibility re-exports, `AgentRunOptions`,
the delegating responder-dependency predicate, `runAgentTurn` (setup wiring plus
two dependency records), and `runAgentLoop`. All behavior lives in 60+ modules
under `src/agent/turn/`.

| Region | Lines |
|---|---:|
| imports | ~190 |
| re-exports, options type, dependency predicate, finisher | ~120 |
| turn setup wiring | ~560 |
| `runAgentLoop` | 7 |

## Structure

| Module | Role |
|---|---|
| `turn/tool-execution/single-tool.ts` | one tool call end to end, behind `SingleToolDeps` |
| `turn/tool-execution/deps.ts` | the tool-execution dependency contract |
| `turn/tool-execution/state.ts` | the eight mutable tool-execution fields, one owner |
| `turn/loop/run-rounds.ts` | the iteration loop and its ceiling stop |
| `turn/loop/round-request.ts` | assembly, dispatch, stream-failure recovery |
| `turn/loop/answer-path.ts` | no-tool-call answer resolution and finalize gating |
| `turn/loop/deps.ts`, `loop/state.ts`, `loop/round-state.ts` | loop contracts and state records |
| `turn/setup/*.ts` | classification, prompt/message composition, responder wake, task gate, budget, session state, MCP ports, state machine, compaction services |
| `turn/turn-counters.ts` | per-turn step and retry counters |

## Relocation bookkeeping

`single-tool.ts` (785 lines) and `run-rounds.ts` (922 lines) hold code moved
verbatim out of the runner. Their size and complexity are the runner's own
legacy metrics at a new path, so they are declared in
`RELOCATED_LEGACY_FILES` (`scripts/quality/config.mjs`) and reported by
`quality:changed` as `relocated:` rather than as new violations, and they carry
matching entries in the committed metrics baseline. Both are under the
architecture suite's 1,000-line ceiling for source files. **These two files are
the remaining decomposition debt**: splitting them into the stage modules listed
in the seam ledger removes the relocation entries entirely.

## Verified at this state

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run embed-prompts:check` | 2 prompts match |
| `npm run test:deterministic` | 599 files, 5,998 passed, 12 skipped |
| `npm run test:arch` | 5 tests passed |
| `npm run build` | dist emitted |
| `npm run quality:contracts` | public contracts unchanged |
| `npm run quality:changed` | 0 failures |
| `npm run quality:ratchet` | 566 held, 19 improvements, 0 regressions |
| `git diff --check` | clean |

## Migration lessons that cost time

1. Regex identifier migration must skip `X:` keys, `X?:` optional keys, `"X"`
   literals and comments, and must repair `{ X }` shorthand — but never inside a
   call argument list. Strip comments **before** strings, or an apostrophe in a
   comment swallows code. Restore placeholders in a loop; nested placeholders
   survive a single pass.
2. Declare a migrated state record above its first textual use; closures built
   earlier in setup run before later declarations.
3. A closure captured by an earlier factory (`nativeToolsAttached: () =>
   toolsAttached`) needs its variable declared before that factory, not before
   first use — this produced a real regression caught by
   `test/agent-recovery.test.ts`.
4. `test/noninteractive/stream-renderer.test.ts` passes only under
   `node scripts/run-tests.mjs` (deterministic env).
