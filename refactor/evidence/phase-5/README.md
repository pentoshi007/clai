# Phase 5 evidence — parsing, policy, safety, web, sessions

Branch `refactor/codebase`. Environment: Linux x64, Node 24, canonical locale/TZ.

## Entry

`test/security test/parser test/agent test/mcp test/web` green before movement:
138 files, 929 passed, exit 0.

## Result

| Module | Entry | Now |
|---|---:|---:|
| `src/agent/tool-call-parser.ts` | 2,235 | 636 |
| `src/agent/plan-tool.ts` | 1,682 | 231 |
| `src/tools/web/fetch-core.ts` | 1,620 | 274 |
| `src/agent/task-evidence.ts` | 1,153 | 568 |
| `src/tools/http.ts` | 1,086 | 16 |
| `src/safety/classifier.ts` | 902 | 245 |
| `src/agent/context-manager.ts` | 800 | 172 |
| `src/tools/web/search.ts` | 783 | 379 |

New families: `agent/parser/` (xml, vendor protocols, salvage, repetition,
arg formatting, bare recognition, parse entry), `agent/plan/` with
`plan/actions/` (`plan-create`, `plan-clear`, `task-move`, `task-add`),
`agent/evidence/`, `agent/context/`, `safety/shell-classification.ts` and
`safety/tool-classification.ts`, `tools/web/` (`request-loop`, `validate-args`,
`response-body`, `search-attempts`), `tools/http/` (`fetch`, `agents`,
`evidence-format`).

The plan tool's 1,078-line `handlePlanTool` was split along its existing
`call.name === "…"` branches into one module per action, each receiving the
values the original branch had in scope. The `!plan` guard that narrowed the
loaded plan stays in the entry function, so the extracted handlers take a
non-optional plan — the same invariant the original code relied on.

Legacy baseline entries removed this phase: `plan-tool.ts`, `task-evidence.ts`,
`tool-call-parser.ts`, `fetch-core.ts`, `tools/http.ts`. Six remain.

## Close matrix

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| security/parser/agent/web/tools/mcp | 988 passed |
| `npm run test:arch` | 5 passed |
| `npm run test:deterministic` | 599 files, 6,002 passed, 12 skipped |
| `npm run build` | dist emitted |
| `npm run quality:contracts` | unchanged |
| `npm run quality:changed` | 0 failures |
| `npm run quality:ratchet` | 0 regressions |

## Deferred, with reason

`src/agent/loop-guard.ts` (LoopGuard, 954 lines of one class) and
`src/interactive-session/manager.ts` (InteractiveSessionManager, 1,314 lines)
are single-class modules like `JobManager`. Splitting them requires per-method
dependency records rather than declaration moves, because their members are
private and widening them would change an exported class's public type. Recorded
for Phase 7 closure; both keep their legacy baseline entries meanwhile.
