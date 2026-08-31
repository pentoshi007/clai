# Phase 1 seam ledger

Branch: `refactor/codebase`. Every row is an independently revertible rollback
boundary that was validated before it was pushed.

## Published seams

| # | Commit | Seam | New module |
|---:|---|---|---|
| 1 | `ac273ff` | ownership map | `refactor/evidence/phase-1/ownership-map.md` |
| 2 | `a6bd464` | facade/continuation characterization | tests only |
| 3 | `45dc780` | continuation overlap | `turn/continuation-overlap.ts` |
| 4 | `d6a8210` | turn output contracts | `turn/contracts.ts` |
| 5 | `1324b6d` | inserted-text helper | `turn/inserted-text.ts` |
| 6 | `07dfd55` | typed event emitter | `turn/event-emitter.ts` |
| 7 | `c313028` | tool-result recorder | `turn/tool-result-recorder.ts` |
| 8 | `c65afea` | compaction summarizer | `turn/compaction-summarizer.ts` |
| 9 | `e235bd8` | compaction request estimator | `turn/compaction-request-estimator.ts` |
| 10 | `b51ec94` | durable envelope assembly | `turn/compaction-durable-envelope.ts` |
| 11 | `48eb2d3` | cache-preserving replay selection | `turn/compaction-replay-selection.ts` |
| 12 | `81952c7` | automatic compaction execution | `turn/automatic-compaction-execution.ts` |
| 13 | `12e6fff` | candidate preparation | `turn/compaction-candidate.ts` |
| 14 | `ee86c08` | final-fit measurement | `turn/compaction-final-fit.ts` |
| 15 | `7704192` | compaction messages | `turn/compaction-messages.ts` |
| 16 | `4403f3a` | compaction admission | `turn/compaction-admission.ts` |
| 17 | `5fb5fb9` | responder claim ledger | `turn/responder-claims.ts` |
| 18 | `9515a92` | responder inbox coordination | `turn/responder-inbox.ts` |
| 19 | `4a21e59` | MCP agent tool execution | `turn/mcp-agent-tools.ts` |
| 20 | `ea832df` | prompt section assembly | `turn/prompt-sections.ts` |
| 21 | `c8bf4fc` | system section assembly | `turn/system-sections.ts` |
| 22 | `9d79840` | session state projection | `turn/session-state-projection.ts` |
| 23 | `8c1ac64` | task completion gate | `turn/task-gate.ts` |
| 24 | `1ed7bf3` | tool routing and prompt content | `turn/tool-routing.ts` |
| 25 | `346725e` | responder read and task update gates | `turn/responder-read-tool.ts`, `turn/task-update-gate.ts` |
| 26 | `a67ef9f` | responder read decomposition | `turn/responder-read-tool.ts` |
| 27 | `e31a49b` | tool execution watchdog | `turn/tool-watchdog.ts` |
| 28 | `d9baf89` | multi-task batch guard | `turn/task-batch-guard.ts` |
| 29 | `c8cee4d` | tool evidence signal reading | `turn/tool-evidence-signals.ts` |
| 30 | `f247938` | plan mode gather gate | `turn/plan-mode-gate.ts` |
| 31 | `ce01016` | plan task autostart | `turn/task-autostart.ts` |
| 32 | `0d0369f` | scaffold preflight decision | `turn/scaffold-preflight.ts` |
| 33 | `74c6d90` | automatic compaction coordinator | `turn/compaction-coordinator.ts` |
| 34 | `08628eb` | turn history writer | `turn/history-writer.ts` |
| 35 | `3db5a22` | responder job plan linkage | `turn/responder-job-linkage.ts` |
| 36 | `77684a1` | scaffold outcome reconciliation | `turn/scaffold-outcome.ts` |
| 37 | `3db5a22` | responder job plan linkage | `src/agent/turn/*` |
| 38 | `77684a1` | scaffold outcome reconciliation | `src/agent/turn/*` |
| 39 | `0a08e1c` | move responder dependency predicate | `src/agent/turn/*` |
| 40 | `2020300` | tool authorization stage | `src/agent/turn/*` |
| 41 | `37acef9` | tool dispatch and delegation stage | `src/agent/turn/*` |
| 42 | `8673b80` | stream failure recovery | `src/agent/turn/*` |
| 43 | `05e83fa` | request assembly | `src/agent/turn/*` |
| 44 | `35e076c` | provider stream session | `src/agent/turn/*` |
| 45 | `148fdc0` | turn workspace setup | `src/agent/turn/*` |
| 46 | `939306b` | tool execution guards | `src/agent/turn/*` |
| 47 | `7c7ee3d` | task work signal reading | `src/agent/turn/*` |
| 48 | `1a9e989` | tool execution supervision | `src/agent/turn/*` |
| 49 | `562d545` | native tool call card sync | `src/agent/turn/*` |
| 50 | `f02ac74` | missing tool call recovery | `src/agent/turn/*` |
| 51 | `aa2453f` | completion usage and interpretation | `src/agent/turn/*` |
| 52 | `739070a` | native truncated write salvage | `src/agent/turn/*` |
| 53 | `782f282` | output budget continuation | `src/agent/turn/*` |
| 54 | `3aa2656` | empty response retry policy | `src/agent/turn/*` |
| 55 | `fc166f2` | turn finalizer | `src/agent/turn/*` |
| 56 | `9c668e7` | plan persistence and session refresh | `src/agent/turn/*` |
| 57 | `b89088e` | tool call preparation helpers | `src/agent/turn/*` |
| 58 | `2e98ab0` | duplicate wire call replay | `src/agent/turn/*` |

## Measured effect

| Metric | Phase 1 entry | Current |
|---|---:|---:|
| `src/agent/runner.ts` physical lines | 6,769 | 3,271 |
| maximum cognitive complexity | 3,197 | 2,712 |
| maximum cyclomatic complexity | 456 | 392 |
| held legacy findings | 572 | 564 |
| ratchet regressions | 0 | 0 |

Resolved legacy findings so far: `trimExactContinuationOverlap` Halstead,
`maybeAutoCompact` cyclomatic and cognitive, `promptSections` cognitive, one
anonymous recorder callback's cognitive violation, and the `runToolWithForcedSettle`
findings removed with the watchdog extraction.

Two changed-code gate failures were fixed by restructuring, never by weakening a
gate: `decideResponderRead` was split into `findMatch`/`wakeIdentityMatches`/
`failureText` after measuring cyclomatic 28, and the watchdog was rebuilt from
nested closures into module-level helpers with a settle-tracked `Promise.race`
after measuring cognitive 57 plus a gated `unknown` parameter. One behavior
difference was caught during the evidence-signal extraction and corrected before
commit: a curl "soft success" probe must not reset `recovery.failedProbe`, so the
signal type distinguishes `success` from `softSuccess`.

A `prettier --write` run reformatted unrelated regions of `runner.ts` during the
watchdog seam. That diff was reverted and the wiring re-applied without
formatting, per the rule that a move may not carry a formatting sweep.

## Validation performed per seam

```sh
npm run typecheck
npx vitest run <focused suites> --reporter=dot
npx vitest run test/agent test/admission/turn-admissions.test.ts \
  test/admission/request-fingerprint.test.ts --reporter=dot
npm run test:arch -- --reporter=dot
npm run quality:contracts
npm run quality:changed
npm run quality:ratchet
npm run build
git diff --check
```

Every seam was additionally reviewed by an independent read-only auditor before
its commit, and each audit finding was applied (dead `modelContextWindow` import
removed; `unknown` parameter replaced with a narrowed failure input).

## Latest repository-wide evidence

| Command | Exit | Result |
|---|---:|---|
| `npm run typecheck` | 0 | clean |
| `npm run embed-prompts:check` | 0 | 2 prompts match their sources |
| `npm run test:deterministic -- --reporter=dot` | 0 | 5,998 passed, 12 skipped |
| `npm run test:arch -- --reporter=dot` | 0 | 1 file, 5 tests |
| `npm run quality:contracts` | 0 | public contracts unchanged |
| `npm run quality:changed` | 0 | 0 failures |
| `npm run quality:ratchet` | 0 | 564 held, 14 improvements, 0 regressions |
| `npm run build` | 0 | dist emitted |
| `git diff --check` | 0 | no whitespace errors |

Modules now under `src/agent/turn/`: 47 source files plus their tests.

Public contract changes: **none**. `test/architecture/legacy-baseline.json` is
unmodified; `src/agent/runner.ts` is still above the 1,000-line removal
threshold, so its entry legitimately remains.

## Remaining Phase 1 work

The exact remaining decomposition is enumerated as 23 numbered commits with
line-range estimates, port requirements, and gate pitfalls in
[completion-map.md](completion-map.md). Summary: turn setup (8 modules),
`executeSingleTool` (6 modules), and the iteration loop (9 modules), totalling
about 4,780 lines. Phase 1 cannot close until `runner.ts` is under 500 lines and
its `legacy-baseline.json` entry is removed.

Out of local scope on this Linux/Node 24 host: Node 22, Bun/OpenTUI, macOS,
Windows/ConPTY, and OS-keychain contracts. They are never claimed as passed.
