# Phase 4 evidence — persistence and durable state

Branch `refactor/codebase`. Environment: Linux x64, Node 24, canonical locale/TZ.

## Result

| Module | Entry | Now |
|---|---:|---:|
| `src/store/history.ts` | 1,931 | 362 |
| `src/store/plan.ts` | 1,187 | 267 |
| `src/store/keys.ts` | 994 | 387 |
| `src/store/config.ts` | 687 | 153 |

New modules: `store/history/` (`jsonl-lock`, `recovery`, `sqlite-backend`,
`jsonl-backend`, `session-queries`, `lifecycle`), `store/plan/`
(`sqlite-backend`, `jsonl-backend`, `task-normalization`, `mutation`),
`store/keys/` (`secret-store`, `search-providers`), `store/config/`
(`endpoints`, `settings`). Every new module is under 400 lines.

`history.ts` and `plan.ts` were removed from the architecture legacy baseline;
11 oversized entries remain.

## Evidence

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| store/plan/history/security suites | 227 passed |
| `npm run test:arch` | 5 passed |
| `npm run test:deterministic` | 599 files, 6,002 passed, 12 skipped |
| `npm run build` | dist emitted |
| `npm run quality:contracts` | public contracts unchanged |
| `npm run quality:changed` | 0 failures |
| `npm run quality:ratchet` | 549 held, 108 improvements, 0 regressions |
| `git diff --check` | clean |

Storage formats, paths, schema versions, lock and retention behavior are untouched:
every declaration moved verbatim, and the JSONL/SQLite backends were separated
along the boundaries that already existed inside the modules.

## Single-owner state

Moving a mutable module-level binding out of a store would have produced two
copies of the value. The mover now generates an explicit setter in the new module
and rewrites the source's assignments through it, so `cachedSessionList`,
`keychainRuntimeUnavailable`, `cachedDb`, `sqliteUnavailable`, `atomicWriteCounter`
and similar values each keep exactly one owner. This was verified by typecheck
(assignment to an imported binding is an error) and by the durability suites.

## Pre-existing fragility found and fixed

`test/history-compaction-quit.test.ts` boots a full composition root inside the
default 5s Vitest timeout. Module import alone measures **4.1s at the phase-2
anchor** and 4.3s after decomposition, so the test had ~18% headroom before any
change. It fails in the **pristine worktree under CPU load**, which is recorded
evidence that the fragility is pre-existing rather than introduced. The test now
declares a 60s timeout; no assertion was changed. Commit:
`test(history): give the compaction-quit boot test a realistic timeout`.

Measured import cost: 4,091 ms (anchor) versus 4,312 ms (refactored), about 5%
for ~150 additional modules. Production startup is unaffected by module count in
the same way because the shipped artifact is built, not transform-loaded.
