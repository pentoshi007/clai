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

## Measured effect

| Metric | Phase 1 entry | Current |
|---|---:|---:|
| `src/agent/runner.ts` physical lines | 6,769 | 5,995 |
| maximum cognitive complexity | 3,197 | 2,828 |
| maximum cyclomatic complexity | 456 | 408 |
| held legacy findings | 572 | 567 |
| ratchet regressions | 0 | 0 |

Resolved legacy findings so far: `trimExactContinuationOverlap` Halstead,
`maybeAutoCompact` cyclomatic and cognitive, `promptSections` cognitive, and one
anonymous recorder callback's cognitive violation.

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
| `npm run test:deterministic -- --reporter=dot` | 0 | 583 files, 5,863 passed, 12 skipped |
| `npm run test:arch -- --reporter=dot` | 0 | 1 file, 5 tests |
| `npm run quality:contracts` | 0 | public contracts unchanged |
| `npm run quality:changed` | 0 | 0 failures |
| `npm run quality:ratchet` | 0 | 567 held, 0 regressions |
| `npm run build` | 0 | dist emitted |
| `git diff --check` | 0 | no whitespace errors |

Public contract changes: **none**. `test/architecture/legacy-baseline.json` is
unmodified; `src/agent/runner.ts` is still above the 1,000-line removal
threshold, so its entry legitimately remains.

## Remaining Phase 1 work

1. Decompose `executeSingleTool` by orchestration stage (loop-guard prelude,
   safety/scope decision, confirmation handoff, dispatch, execution supervision,
   result recording).
2. Decompose the iteration loop (request assembly, stream handling, recovery,
   continuation, evidence gates).
3. Extract exactly-once finalization from `finishTurn`.
4. Reduce the facade below 500 lines and remove the runner's legacy baseline
   entry in that same structural commit.

Out of local scope on this Linux/Node 24 host: Node 22, Bun/OpenTUI, macOS,
Windows/ConPTY, and OS-keychain contracts. They are never claimed as passed.
